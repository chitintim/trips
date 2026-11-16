-- "I haven't received it" becomes a real state with next steps, instead of limbo.
--
-- Before: a receiver who said "not received" (email page) left the payment marked_paid with only an
-- activity row; neither side had a next step. Now settlements.receipt_disputed_at records it, and the
-- payer can ask again or take the payment back (retract).
--
-- ADDITIVE AND RE-RUNNABLE: ADD COLUMN IF NOT EXISTS, CHECK added only if missing, CREATE OR REPLACE
-- for the three functions, idempotent REVOKE/GRANT. No table, policy or trigger is dropped. Existing rows
-- get NULL. The front end and edge functions fail soft if the column does not exist yet, so this can be
-- applied before or after them.
--
-- MEANING: receipt_disputed_at IS NOT NULL  <=>  the receiver said it hasn't arrived and the payer has not
-- responded yet. Only possible while status = 'marked_paid' (CHECK below + guard auto-clear).
--
-- Objects:
--   settlements.receipt_disputed_at timestamptz NULL
--   settlements.last_retracted_at   timestamptz NULL  (stamped ONLY by the guard; the server-side "retracted" boundary)
--   settlements_receipt_disputed_only_when_marked_paid  CHECK (flag IS NULL OR status = 'marked_paid')
--   guard_settlement_party_update()      CREATE OR REPLACE, starting from the body in 20261120100000
--   dispute_payment_by_token(text)       CREATE OR REPLACE: also stamps the flag (logs only when it changed)
--   clear_receipt_dispute(uuid, text)    NEW, service_role only: clears the flag and (given a token hash) issues the fresh link, atomically
--   restore_receipt_dispute(uuid)        NEW, service_role only: puts the flag back when the re-ask email could not be sent
--
-- EXACT BEHAVIOUR DIFF OF guard_settlement_party_update vs the LIVE body (everything not listed is unchanged):
--   1. EVERY update (all roles, organizers included): when NEW.status is not 'marked_paid' the flag is forced to NULL, so
--      confirming, retracting or an organizer reverting always clears it and the CHECK can never trip on an UPDATE.
--   2. EVERY update: last_retracted_at is reset to its OLD value (nobody sets it), then STAMPED with now() when OLD.status =
--      'marked_paid' AND NEW.status = 'suggested' (any actor). Direct inserts by a manager can still carry a value (inserts are
--      managers only and this column only gates emails).
--   3. RECEIVER (to_user_id), not privileged, NEW: on a marked_paid row, set the flag from NULL to now() and change NOTHING else.
--      Cannot clear it, retract or edit anything.
--   4. PAYER (from_user_id), not privileged, NEW:
--      (a) RETRACT marked_paid -> suggested: amount, currency, parties, trip, creator, created_at locked; the guard then forces
--          payment_method = NULL, notes = NULL, settled_at = COALESCE(OLD.created_at, now()), flag = NULL. Allowed on ANY marked_paid
--          row of theirs, flagged or not ("I marked it paid by mistake"); the receiver is told by email. Safe: the payer can only
--          move their own payment BACK to where it was before they marked it, and it is recorded in last_retracted_at.
--      (b) CLEAR the flag (marked_paid -> marked_paid, flag non-NULL -> NULL, nothing else changing): ONLY when auth.role() =
--          'service_role', i.e. through clear_receipt_dispute() after payment-notice's own checks and caps. A direct client update
--          (role 'authenticated') is refused, so the payer cannot erase the receiver's "no" or restart the receiver's reminders.
--      suggested -> marked_paid additionally forces the flag to NULL.
--   5. PRIVILEGED (organizer, or a trip manager who created the row < 24 h ago): full access as before, plus: moving
--      marked_paid -> suggested resets payment_method / notes / settled_at ONLY for fields whose NEW value equals the OLD value
--      (values they set in the same update are kept).
--   6. Nobody else (third parties, a creator who cannot manage the trip, the service role with auth.uid() NULL) gains anything:
--      the final fail-closed RAISE is unchanged.
--
-- HOW SECURITY DEFINER FUNCTIONS PASS THE GUARD (auth.uid() is NULL in a service-role call): like confirm_payment_by_token, the
-- functions here set request.jwt.claim.sub / .role and request.jwt.claims transaction-locally for their one UPDATE, then restore
-- all three: dispute_payment_by_token as the RECEIVER (role authenticated), restore_receipt_dispute as the RECEIVER, and
-- clear_receipt_dispute as the PAYER with role 'service_role' (auth.uid() = payer, auth.role() = 'service_role'). Only these
-- service_role-only functions do this; PostgREST sets the settings from the verified JWT, so a client cannot.
--
-- TOKENS: the AFTER UPDATE trigger from 20261120090000 (OLD marked_paid, NEW not) retires unused tokens on a retract exactly as
-- for a confirm or an organizer revert. Unchanged.

-- Applied inside the apply procedure's BEGIN/COMMIT: never queue behind a long transaction on settlements.
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.settlements ADD COLUMN IF NOT EXISTS receipt_disputed_at timestamptz;
-- When this payment last went marked_paid -> suggested (by anyone). Written ONLY by the guard below; it is the
-- server-side boundary after which a fresh "X paid you" email may be sent. NULL = never retracted.
ALTER TABLE public.settlements ADD COLUMN IF NOT EXISTS last_retracted_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.settlements'::regclass AND conname = 'settlements_receipt_disputed_only_when_marked_paid'
  ) THEN
    ALTER TABLE public.settlements
      ADD CONSTRAINT settlements_receipt_disputed_only_when_marked_paid
      CHECK (receipt_disputed_at IS NULL OR status = 'marked_paid');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.guard_settlement_party_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  is_privileged boolean;
  v_uid uuid := auth.uid();
  v_rest_same boolean;
BEGIN
  is_privileged := (OLD.created_by = v_uid AND OLD.created_at > now() - interval '24 hours'
                      AND public._settlement_can_manage(OLD.trip_id, v_uid))
                    OR public.is_trip_organizer(OLD.trip_id, v_uid);

  -- Nobody sets last_retracted_at directly: whatever the client sent is discarded, then the guard itself stamps it
  -- when (and only when) the payment goes back from marked_paid to suggested.
  NEW.last_retracted_at := OLD.last_retracted_at;
  IF OLD.status = 'marked_paid' AND NEW.status = 'suggested' THEN
    NEW.last_retracted_at := now();
  END IF;

  -- The flag only exists while the payment is marked paid.
  IF NEW.status IS DISTINCT FROM 'marked_paid' THEN
    NEW.receipt_disputed_at := NULL;
  END IF;

  IF is_privileged THEN
    -- An organizer may edit a payment, but never into NaN / Infinity / zero / negative / absurd.
    IF NEW.amount IS DISTINCT FROM OLD.amount
       AND (NEW.amount IS NULL OR NOT (NEW.amount > 0 AND NEW.amount < 100000000)) THEN
      RAISE EXCEPTION 'A payment must have an amount above zero' USING ERRCODE = '22023';
    END IF;
    IF OLD.status = 'marked_paid' AND NEW.status = 'suggested' THEN
      -- Taking a payment back: the mark-paid details no longer apply. Only fields the organizer did NOT
      -- explicitly change in this same update are reset (a value they set on purpose is kept).
      IF NEW.payment_method IS NOT DISTINCT FROM OLD.payment_method THEN NEW.payment_method := NULL; END IF;
      IF NEW.notes IS NOT DISTINCT FROM OLD.notes THEN NEW.notes := NULL; END IF;
      IF NEW.settled_at IS NOT DISTINCT FROM OLD.settled_at THEN NEW.settled_at := COALESCE(OLD.created_at, now()); END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'May not change who created this settlement or when';
  END IF;

  IF v_uid = OLD.from_user_id THEN
    IF OLD.status = 'suggested' AND NEW.status = 'marked_paid' THEN
      IF NEW.amount IS DISTINCT FROM OLD.amount OR NEW.currency IS DISTINCT FROM OLD.currency THEN
        RAISE EXCEPTION 'Payer may not change the settlement amount or currency';
      END IF;
      NEW.receipt_disputed_at := NULL;
      RETURN NEW;
    ELSIF OLD.status = 'marked_paid' AND NEW.status = 'marked_paid' THEN
      -- "I've sent it - ask again": clear the receiver's "not received", nothing else. SERVER ONLY: a payer must not
      -- be able to erase the receiver's "no" with a direct client update. clear_receipt_dispute() (service role only,
      -- after payment-notice's own checks and caps) sets auth.role() = 'service_role' with auth.uid() = the payer.
      IF auth.role() IS DISTINCT FROM 'service_role' THEN
        RAISE EXCEPTION 'A not-received flag can only be cleared by asking the receiver again from the app';
      END IF;
      v_rest_same := (to_jsonb(NEW) - 'receipt_disputed_at' - 'updated_at') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'receipt_disputed_at' - 'updated_at');
      IF OLD.receipt_disputed_at IS NULL OR NEW.receipt_disputed_at IS NOT NULL OR NOT v_rest_same THEN
        RAISE EXCEPTION 'Payer may only mark a suggested settlement as paid, clear a not-received flag, or take a payment back';
      END IF;
      RETURN NEW;
    ELSIF OLD.status = 'marked_paid' AND NEW.status = 'suggested' THEN
      -- "I haven't paid yet": retract. Only the mark-paid details, the flag and the guard-stamped boundary may differ.
      v_rest_same := (to_jsonb(NEW) - 'status' - 'payment_method' - 'notes' - 'settled_at' - 'receipt_disputed_at' - 'last_retracted_at' - 'updated_at')
                     IS NOT DISTINCT FROM (to_jsonb(OLD) - 'status' - 'payment_method' - 'notes' - 'settled_at' - 'receipt_disputed_at' - 'last_retracted_at' - 'updated_at');
      IF NOT v_rest_same THEN
        RAISE EXCEPTION 'Taking a payment back may not change the amount, currency or people';
      END IF;
      NEW.payment_method := NULL;
      NEW.notes := NULL;
      NEW.settled_at := COALESCE(OLD.created_at, now());
      NEW.receipt_disputed_at := NULL;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Payer may only mark a suggested settlement as paid, clear a not-received flag, or take a payment back';
  ELSIF v_uid = OLD.to_user_id THEN
    IF OLD.status = 'marked_paid' AND NEW.status = 'marked_paid' THEN
      -- "It hasn't arrived": set the flag, nothing else.
      v_rest_same := (to_jsonb(NEW) - 'receipt_disputed_at' - 'updated_at') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'receipt_disputed_at' - 'updated_at');
      IF OLD.receipt_disputed_at IS NOT NULL OR NEW.receipt_disputed_at IS NULL OR NOT v_rest_same THEN
        RAISE EXCEPTION 'Payee may only confirm a settlement already marked paid, or say it has not arrived';
      END IF;
      NEW.receipt_disputed_at := now();
      RETURN NEW;
    END IF;
    IF OLD.status IS DISTINCT FROM 'marked_paid' OR NEW.status IS DISTINCT FROM 'confirmed' THEN
      RAISE EXCEPTION 'Payee may only confirm a settlement already marked paid';
    END IF;
    IF NEW.amount IS DISTINCT FROM OLD.amount OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.payment_method IS DISTINCT FROM OLD.payment_method OR NEW.notes IS DISTINCT FROM OLD.notes
       OR NEW.settled_at IS DISTINCT FROM OLD.settled_at THEN
      RAISE EXCEPTION 'Confirming may not change the payer''s recorded payment details';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Not permitted to update this settlement'; -- fail closed
END;
$$;
REVOKE ALL ON FUNCTION public.guard_settlement_party_update() FROM PUBLIC, anon, authenticated;

-- Token "I haven't received it": marks the token used AND stamps the flag (the receiver's own update, as far as
-- the guard can tell). Idempotent when the flag is already set (for example the receiver said so in the app).
CREATE OR REPLACE FUNCTION public.dispute_payment_by_token(p_token_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  tok public.payment_confirm_tokens;
  s public.settlements;
  res text;
  v_old_sub text;
  v_old_claims text;
  v_old_role text;
  v_rows integer;
  v_label text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role only' USING ERRCODE = '42501';
  END IF;
  res := public._payment_token_check(p_token_hash);
  SELECT * INTO tok FROM public.payment_confirm_tokens WHERE token_hash = p_token_hash;
  SELECT * INTO s FROM public.settlements WHERE id = tok.settlement_id;
  IF res = 'not_found' THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  IF res IS DISTINCT FROM 'ok' THEN
    IF tok.id IS NULL THEN RETURN jsonb_build_object('result', res); END IF;
    IF res = 'already_confirmed' THEN
      UPDATE public.payment_confirm_tokens SET used_at = now(), used_action = 'superseded' WHERE id = tok.id AND used_at IS NULL;
    END IF;
    RETURN public._payment_token_summary(tok, s, res);
  END IF;

  v_old_sub := current_setting('request.jwt.claim.sub', true);
  v_old_claims := current_setting('request.jwt.claims', true);
  v_old_role := current_setting('request.jwt.claim.role', true);
  PERFORM set_config('request.jwt.claim.sub', tok.receiver_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', tok.receiver_id::text, 'role', 'authenticated')::text, true);
  UPDATE public.settlements SET receipt_disputed_at = now()
   WHERE id = s.id AND status = 'marked_paid' AND receipt_disputed_at IS NULL
     AND to_user_id = tok.receiver_id AND amount = tok.amount;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM set_config('request.jwt.claim.sub', COALESCE(v_old_sub, ''), true);
  PERFORM set_config('request.jwt.claim.role', COALESCE(v_old_role, ''), true);
  PERFORM set_config('request.jwt.claims', COALESCE(v_old_claims, ''), true);

  UPDATE public.payment_confirm_tokens SET used_at = now(), used_action = 'disputed' WHERE id = tok.id
  RETURNING * INTO tok;
  -- Log only when THIS call changed the flag (the receiver may already have said so in the app).
  IF v_rows = 1 THEN
    v_label := public._payment_token_name(s.from_user_id) || ' → ' || public._payment_token_name(s.to_user_id);
    INSERT INTO public.activity_feed (trip_id, actor, verb, entity, metadata)
    VALUES (s.trip_id, tok.receiver_id, 'settlement_receipt_disputed',
      jsonb_build_object('type', 'settlement', 'id', s.id, 'label', v_label),
      jsonb_build_object('payer_id', s.from_user_id, 'receiver_id', tok.receiver_id, 'amount', tok.amount, 'currency', tok.currency, 'via', 'email'));
  END IF;
  RETURN public._payment_token_summary(tok, s, 'disputed');
END $$;

-- "I've sent it - ask again" (called by payment-notice after its own checks and caps): clear the flag as the payer and,
-- in the SAME transaction, issue the receiver's fresh link when p_token_hash is given. Atomic: either the flag is cleared
-- AND the new token exists, or nothing changed. The caller then sends the email; a late clear can therefore never wipe
-- an answer the receiver gives on the fresh link. This is the ONLY way a payer's flag clear is accepted: it sets
-- auth.role() = 'service_role' (with auth.uid() = the payer) for its one UPDATE, which the guard requires.
CREATE OR REPLACE FUNCTION public.clear_receipt_dispute(p_settlement_id uuid, p_token_hash text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s public.settlements%ROWTYPE;
  v_old_sub text;
  v_old_claims text;
  v_old_role text;
  v_rows integer;
  v_issued jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role only' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO s FROM public.settlements WHERE id = p_settlement_id FOR UPDATE;
  IF NOT FOUND OR s.status IS DISTINCT FROM 'marked_paid' THEN
    RETURN jsonb_build_object('result', 'not_marked_paid');
  END IF;
  IF s.receipt_disputed_at IS NULL THEN
    RETURN jsonb_build_object('result', 'not_disputed');
  END IF;
  IF p_token_hash IS NOT NULL THEN
    v_issued := public.issue_payment_confirm_token(s.id, p_token_hash);
    IF v_issued ->> 'result' IS DISTINCT FROM 'issued' THEN
      RETURN jsonb_build_object('result', 'token_failed');
    END IF;
  END IF;
  v_old_sub := current_setting('request.jwt.claim.sub', true);
  v_old_claims := current_setting('request.jwt.claims', true);
  v_old_role := current_setting('request.jwt.claim.role', true);
  PERFORM set_config('request.jwt.claim.sub', s.from_user_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', s.from_user_id::text, 'role', 'service_role')::text, true);
  UPDATE public.settlements SET receipt_disputed_at = NULL
   WHERE id = s.id AND status = 'marked_paid' AND receipt_disputed_at IS NOT NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM set_config('request.jwt.claim.sub', COALESCE(v_old_sub, ''), true);
  PERFORM set_config('request.jwt.claim.role', COALESCE(v_old_role, ''), true);
  PERFORM set_config('request.jwt.claims', COALESCE(v_old_claims, ''), true);
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'could not clear the not-received flag'; -- rolls back the token issued above
  END IF;
  RETURN jsonb_build_object('result', 'cleared', 'token_issued', p_token_hash IS NOT NULL);
END $$;

-- The email of a re-ask could not be sent: put the receiver's "not received" back (as the receiver, exactly the update
-- they could make themselves) and retire the fresh link nobody received. Service role only.
CREATE OR REPLACE FUNCTION public.restore_receipt_dispute(p_settlement_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s public.settlements%ROWTYPE;
  v_old_sub text;
  v_old_claims text;
  v_old_role text;
  v_rows integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role only' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO s FROM public.settlements WHERE id = p_settlement_id FOR UPDATE;
  IF NOT FOUND OR s.status IS DISTINCT FROM 'marked_paid' THEN
    RETURN jsonb_build_object('result', 'not_marked_paid');
  END IF;
  IF s.receipt_disputed_at IS NOT NULL THEN
    RETURN jsonb_build_object('result', 'already_disputed');
  END IF;
  v_old_sub := current_setting('request.jwt.claim.sub', true);
  v_old_claims := current_setting('request.jwt.claims', true);
  v_old_role := current_setting('request.jwt.claim.role', true);
  PERFORM set_config('request.jwt.claim.sub', s.to_user_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', s.to_user_id::text, 'role', 'authenticated')::text, true);
  UPDATE public.settlements SET receipt_disputed_at = now()
   WHERE id = s.id AND status = 'marked_paid' AND receipt_disputed_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM set_config('request.jwt.claim.sub', COALESCE(v_old_sub, ''), true);
  PERFORM set_config('request.jwt.claim.role', COALESCE(v_old_role, ''), true);
  PERFORM set_config('request.jwt.claims', COALESCE(v_old_claims, ''), true);
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'could not restore the not-received flag';
  END IF;
  UPDATE public.payment_confirm_tokens SET used_at = now(), used_action = 'superseded' WHERE settlement_id = s.id AND used_at IS NULL;
  RETURN jsonb_build_object('result', 'restored');
END $$;

REVOKE ALL ON FUNCTION public.dispute_payment_by_token(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.clear_receipt_dispute(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.restore_receipt_dispute(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispute_payment_by_token(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.clear_receipt_dispute(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.restore_receipt_dispute(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
