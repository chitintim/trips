-- Settle up: atomic freeze / unfreeze, and a provable-duplicate removal.
--
-- Why: SettleUpTab.handleFreeze used to be three separate client writes
-- (trips.settlement_snapshot, delete stale 'suggested' rows, insert new
-- 'suggested' rows). A failure part-way left a frozen trip with missing rows,
-- and two organisers freezing at once could interleave (double inserts).
-- Separately, the live settlements DELETE policy lets an organiser delete only
-- 'suggested' rows (creator <24h and site admins can delete others), so an
-- organiser who is not an admin could not remove a payment recorded twice.
--
-- This migration is purely additive: three new functions + one private helper.
-- No table, policy, trigger or existing function is changed. The balance maths
-- stays in TypeScript: freeze_settlements is the atomic WRITER of suggestions
-- the client computed (src/features/expenses/lib/balances.ts is untouched).
--
-- Functions (all SECURITY DEFINER, search_path pinned, auth.uid() required,
-- EXECUTE for authenticated only):
--   freeze_settlements(p_trip_id, p_snapshot jsonb, p_suggestions jsonb, p_known_paid_ids uuid[]) -> jsonb
--   unfreeze_settlements(p_trip_id) -> jsonb
--   remove_duplicate_settlement(p_settlement_id) -> jsonb
--
-- WHO MAY CALL: an ACTIVE organiser of the trip, the trip creator, or a site
-- admin (users.role = 'admin') -- the app's canManageTrip, which is what the UI
-- offers Freeze / Remove duplicate to, and the same rule as
-- reset_trip_confirmations. This is deliberately a superset of the existing
-- policies for these writes (settlements UPDATE and carryover INSERT use
-- is_trip_organizer only; DELETE additionally allows admin). The inline check
-- adds the "active" filter that is_trip_organizer() lacks, so a removed
-- organiser is not let back in.
--
-- ASSUMPTIONS (verify with supabase/PRE_APPLY_CHECKS.sql group 15):
--   * settlements.status is text constrained to suggested|marked_paid|confirmed;
--     settlements.currency is nullable text (NULL means the trip's base currency);
--   * trips.settlement_snapshot / _at / _by exist, snapshot is
--     {transactions:[{from,to,fromName,toName,amount,settled}], balances:[...],
--      created_at} (this function stores whatever object the client sends, but
--      requires an object with a "transactions" array);
--   * activity_feed has no verb CHECK constraint (live: only FKs).
--
-- TRIGGERS / POLICIES: SECURITY DEFINER runs as the function owner, which
-- bypasses RLS on settlements, trips and activity_feed. The only settlements
-- triggers (guard_immutable_keys, guard_settlement_party_update) are BEFORE
-- UPDATE and these functions never UPDATE settlements (INSERT and DELETE only),
-- so neither fires. On trips the function runs an UPDATE of the snapshot
-- columns, which fires set_updated_at (fine) and guard_immutable_keys (only
-- guards created_by; untouched). The settlements status CHECK is satisfied
-- because only 'suggested' is ever inserted.
--
-- CONCURRENCY: both write paths take pg_advisory_xact_lock on the trip first,
-- so two organisers freezing (or a freeze racing a duplicate removal) run one
-- after the other; the second sees the first's rows.

-- Private helper: the single who-may-manage rule for the three functions.
CREATE OR REPLACE FUNCTION public.settlement_assert_can_manage(p_trip_id uuid, p_uid uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT (
    EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_uid AND u.role = 'admin')
    OR EXISTS (
      SELECT 1 FROM public.trip_participants o
      WHERE o.trip_id = p_trip_id AND o.user_id = p_uid
        AND o.role = 'organizer'::public.participant_role AND o.active
    )
    OR EXISTS (SELECT 1 FROM public.trips t WHERE t.id = p_trip_id AND t.created_by = p_uid)
  ) THEN
    RAISE EXCEPTION 'Only trip organizers, the trip creator and admins can manage settlements'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.freeze_settlements(
  p_trip_id uuid,
  p_snapshot jsonb,
  p_suggestions jsonb,
  p_known_paid_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_base text;
  v_item jsonb;
  v_from uuid;
  v_to uuid;
  v_amount numeric;
  v_currency text;
  v_deleted integer;
  v_inserted integer := 0;
  v_skipped integer := 0;
  v_seen text[] := ARRAY[]::text[];
  v_key text;
  v_dup integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_trip_id IS NULL THEN
    RAISE EXCEPTION 'Trip is required' USING ERRCODE = '22023';
  END IF;

  SELECT t.base_currency INTO v_base FROM public.trips t WHERE t.id = p_trip_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trip not found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM public.settlement_assert_can_manage(p_trip_id, v_uid);

  IF p_snapshot IS NULL OR jsonb_typeof(p_snapshot) <> 'object'
     OR jsonb_typeof(p_snapshot -> 'transactions') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'The frozen snapshot must be an object with a transactions list' USING ERRCODE = '22023';
  END IF;
  IF p_suggestions IS NULL OR jsonb_typeof(p_suggestions) <> 'array' THEN
    RAISE EXCEPTION 'Suggested payments must be a list' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_suggestions) > 500 THEN
    RAISE EXCEPTION 'Too many suggested payments' USING ERRCODE = '22023';
  END IF;

  -- One freeze/removal per trip at a time (released at commit/rollback).
  PERFORM pg_advisory_xact_lock(hashtextextended('settlement_freeze:' || p_trip_id::text, 0));

  -- 0a. Never freeze over a payment that looks recorded twice: the amounts the
  --     client computed would rest on a payment that may not be real. Same rule
  --     as the app: two non-suggested rows, same pair / amount / currency, made
  --     within 24h of each other, at least one of them still marked_paid.
  SELECT count(*) INTO v_dup
  FROM public.settlements a
  JOIN public.settlements b
    ON b.trip_id = a.trip_id AND b.id > a.id
   AND b.from_user_id = a.from_user_id AND b.to_user_id = a.to_user_id
   AND b.amount = a.amount
   AND COALESCE(b.currency, v_base) = COALESCE(a.currency, v_base)
   AND abs(extract(epoch FROM (b.created_at - a.created_at))) < 86400
  WHERE a.trip_id = p_trip_id
    AND a.status <> 'suggested' AND b.status <> 'suggested'
    AND (a.status = 'marked_paid' OR b.status = 'marked_paid');
  IF v_dup > 0 THEN
    RAISE EXCEPTION 'Some payments look recorded twice. Sort those out first (see the notice on Settle up), then freeze.'
      USING ERRCODE = 'P0001', HINT = 'duplicate_payments';
  END IF;

  -- 0b. Optimistic check: the client subtracted the marked-paid rows it saw. If
  --     any other unconfirmed payment exists now, the suggestions are stale.
  IF EXISTS (
    SELECT 1 FROM public.settlements s
     WHERE s.trip_id = p_trip_id AND s.status NOT IN ('suggested', 'confirmed')
       AND s.id <> ALL (COALESCE(p_known_paid_ids, ARRAY[]::uuid[]))
  ) THEN
    RAISE EXCEPTION 'Payments changed while you were freezing — try again'
      USING ERRCODE = 'P0001', HINT = 'stale';
  END IF;

  -- 1. Validate every suggestion BEFORE writing anything.
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_suggestions) LOOP
    IF jsonb_typeof(v_item) <> 'object'
       OR NOT (v_item ? 'from' AND v_item ? 'to' AND v_item ? 'amount') THEN
      RAISE EXCEPTION 'Each suggested payment needs from, to, amount and currency' USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_from := (v_item ->> 'from')::uuid;
      v_to := (v_item ->> 'to')::uuid;
      v_amount := (v_item ->> 'amount')::numeric;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'A suggested payment has an invalid person or amount' USING ERRCODE = '22023';
    END;
    v_currency := NULLIF(btrim(v_item ->> 'currency'), '');
    IF v_currency IS NULL THEN
      RAISE EXCEPTION 'A suggested payment is missing its currency' USING ERRCODE = '22023';
    END IF;
    IF v_amount IS NULL OR v_amount = 'NaN'::numeric OR v_amount IN ('Infinity'::numeric, '-Infinity'::numeric)
       OR v_amount <= 0 OR v_amount >= 1e9 OR round(v_amount, 2) <= 0 THEN
      RAISE EXCEPTION 'A suggested payment must have an amount above zero' USING ERRCODE = '22023';
    END IF;
    IF v_from = v_to THEN
      RAISE EXCEPTION 'A suggested payment cannot be from and to the same person' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.trip_participants p WHERE p.trip_id = p_trip_id AND p.user_id = v_from)
       OR NOT EXISTS (SELECT 1 FROM public.trip_participants p WHERE p.trip_id = p_trip_id AND p.user_id = v_to) THEN
      RAISE EXCEPTION 'A suggested payment involves someone who is not on this trip' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  -- 2. Snapshot: same columns the client wrote directly before.
  UPDATE public.trips
  SET settlement_snapshot = p_snapshot,
      settlement_snapshot_at = now(),
      settlement_snapshot_by = v_uid
  WHERE id = p_trip_id;

  -- 3. Replace stale proposals. ONLY 'suggested': marked_paid / confirmed rows
  --    are real payment history and are never touched.
  DELETE FROM public.settlements WHERE trip_id = p_trip_id AND status = 'suggested';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  -- 4. Insert the new proposals, skipping only repeats WITHIN the list. An
  --    existing marked_paid row is NOT a reason to skip: the client has already
  --    subtracted it, so skipping would subtract it twice and drop a real
  --    remaining payment (stale cases are caught by p_known_paid_ids above).
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_suggestions) LOOP
    v_from := (v_item ->> 'from')::uuid;
    v_to := (v_item ->> 'to')::uuid;
    v_amount := round((v_item ->> 'amount')::numeric, 2);
    v_currency := btrim(v_item ->> 'currency');
    v_key := v_from::text || ':' || v_to::text || ':' || v_amount::text || ':' || v_currency;

    IF v_key = ANY (v_seen) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;
    v_seen := v_seen || v_key;

    INSERT INTO public.settlements
      (trip_id, from_user_id, to_user_id, amount, currency, status, created_by, settled_at)
    VALUES
      (p_trip_id, v_from, v_to, v_amount, v_currency, 'suggested', v_uid, now());
    v_inserted := v_inserted + 1;
  END LOOP;

  INSERT INTO public.activity_feed (trip_id, actor, verb, entity, metadata)
  VALUES (
    p_trip_id, v_uid, 'froze_settlement',
    jsonb_build_object('trip_id', p_trip_id),
    jsonb_build_object('transaction_count', jsonb_array_length(p_snapshot -> 'transactions'))
  );

  RETURN jsonb_build_object(
    'deleted_suggested', v_deleted,
    'inserted', v_inserted,
    'skipped_duplicates', v_skipped
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.unfreeze_settlements(p_trip_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.trips t WHERE t.id = p_trip_id) THEN
    RAISE EXCEPTION 'Trip not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.settlement_assert_can_manage(p_trip_id, v_uid);

  PERFORM pg_advisory_xact_lock(hashtextextended('settlement_freeze:' || p_trip_id::text, 0));

  -- Same as the client did: clear the snapshot, stamp who/when. Suggested rows
  -- are left in place (a later freeze replaces them), exactly as before.
  UPDATE public.trips
  SET settlement_snapshot = NULL,
      settlement_snapshot_at = now(),
      settlement_snapshot_by = v_uid
  WHERE id = p_trip_id;

  INSERT INTO public.activity_feed (trip_id, actor, verb, entity, metadata)
  VALUES (p_trip_id, v_uid, 'unfroze_settlement', jsonb_build_object('trip_id', p_trip_id), NULL);

  RETURN jsonb_build_object('unfrozen', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_duplicate_settlement(p_settlement_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.settlements%ROWTYPE;
  v_base text;
  v_currency text;
  v_other public.settlements%ROWTYPE;
  v_from_name text;
  v_to_name text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row FROM public.settlements WHERE id = p_settlement_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This payment no longer exists' USING ERRCODE = 'P0002';
  END IF;

  PERFORM public.settlement_assert_can_manage(v_row.trip_id, v_uid);

  -- Serialise with freezes and other removals on this trip, then re-read the
  -- row: another removal may have won while we waited.
  PERFORM pg_advisory_xact_lock(hashtextextended('settlement_freeze:' || v_row.trip_id::text, 0));
  SELECT * INTO v_row FROM public.settlements WHERE id = p_settlement_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This payment no longer exists' USING ERRCODE = 'P0002';
  END IF;

  IF v_row.status = 'confirmed' THEN
    RAISE EXCEPTION 'A confirmed payment cannot be removed this way' USING ERRCODE = '42501';
  END IF;

  SELECT t.base_currency INTO v_base FROM public.trips t WHERE t.id = v_row.trip_id;
  v_currency := COALESCE(v_row.currency, v_base);

  -- Proof of duplication: another NON-suggested payment, same pair, same
  -- amount and currency, created within 24 hours of this one (two payments
  -- days apart are separate instalments). The caller chooses WHICH of the two
  -- to remove by passing its id; the app defaults to the earlier. Both rows are
  -- locked so a concurrent edit cannot change what is being proved.
  SELECT * INTO v_other
  FROM public.settlements s
  WHERE s.trip_id = v_row.trip_id
    AND s.id <> v_row.id
    AND s.status <> 'suggested'
    AND s.from_user_id = v_row.from_user_id AND s.to_user_id = v_row.to_user_id
    AND s.amount = v_row.amount
    AND COALESCE(s.currency, v_base) = v_currency
    AND abs(extract(epoch FROM (s.created_at - v_row.created_at))) < 86400
  ORDER BY abs(extract(epoch FROM (s.created_at - v_row.created_at))), s.id
  LIMIT 1
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This payment has no duplicate recorded within 24 hours of it' USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.settlements WHERE id = v_row.id;

  SELECT COALESCE(u.full_name, u.first_name, 'Someone') INTO v_from_name FROM public.users u WHERE u.id = v_row.from_user_id;
  SELECT COALESCE(u.full_name, u.first_name, 'Someone') INTO v_to_name FROM public.users u WHERE u.id = v_row.to_user_id;

  INSERT INTO public.activity_feed (trip_id, actor, verb, entity, metadata)
  VALUES (
    v_row.trip_id, v_uid, 'settlement_duplicate_removed',
    jsonb_build_object(
      'type', 'settlement',
      'id', v_row.id,
      'label', COALESCE(v_from_name, 'Someone') || ' to ' || COALESCE(v_to_name, 'Someone') || ', ' || v_row.amount::text || ' ' || COALESCE(v_currency, '')
    ),
    jsonb_build_object(
      'amount', v_row.amount,
      'currency', v_currency,
      'from_user_id', v_row.from_user_id,
      'to_user_id', v_row.to_user_id,
      'removed_id', v_row.id,
      'removed_status', v_row.status,
      'removed_created_at', v_row.created_at,
      'removed_row', to_jsonb(v_row),
      'kept_row', to_jsonb(v_other),
      'kept_id', v_other.id,
      'kept_status', v_other.status,
      'kept_created_at', v_other.created_at
    )
  );

  RETURN jsonb_build_object(
    'removed_id', v_row.id,
    'removed_status', v_row.status,
    'removed_created_at', v_row.created_at,
    'kept_id', v_other.id,
    'kept_status', v_other.status,
    'amount', v_row.amount,
    'currency', v_currency,
    'from_user_id', v_row.from_user_id,
    'to_user_id', v_row.to_user_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.settlement_assert_can_manage(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.freeze_settlements(uuid, jsonb, jsonb, uuid[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.unfreeze_settlements(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.remove_duplicate_settlement(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.freeze_settlements(uuid, jsonb, jsonb, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unfreeze_settlements(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_duplicate_settlement(uuid) TO authenticated;
