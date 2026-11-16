-- Close a money-integrity hole on public.settlements: nothing guarded INSERT.
--
-- THE HOLE (verify first with supabase/PRE_APPLY_CHECKS.sql group 19; apply this migration ONLY if
-- the live policy and column default are as described):
--   * The live INSERT policy on settlements only asks "trip participant AND created_by = auth.uid()".
--   * The only triggers on settlements are BEFORE UPDATE (guard_immutable_keys,
--     guard_settlement_party_update). Nothing looks at an INSERT.
--   * settlements.status DEFAULTS to 'confirmed'.
--   So any participant of any trip could insert (trip_id, from_user_id = A, to_user_id = B,
--   amount, settled_at, created_by = self) for ANY two users A and B, with no status, and it would
--   land as a CONFIRMED payment that moves everybody's balances without either party agreeing.
--   They could equally insert a marked_paid row from themselves to anyone, and then, because a
--   creator is "privileged" on UPDATE for 24 hours (guard_settlement_party_update returns early),
--   confirm it themselves. Both halves are closed here.
--
-- WHAT THIS MIGRATION DOES (additive; re-runnable)
--   1. _settlement_can_manage(trip, uid): the non-raising twin of settlement_assert_can_manage
--      (site admin, ACTIVE organizer, or trip creator).
--   2. guard_settlement_insert() + BEFORE INSERT trigger. SECURITY DEFINER, pinned search_path,
--      EXECUTE revoked from everyone (a trigger function needs no grant to fire).
--        - EVERY insert (managers and service role included): amount must be above zero and
--          below 100,000,000. The test is written NOT (amount > 0 AND amount < 1e8) so numeric
--          'NaN' and 'Infinity' are refused too (a plain amount <= 0 test lets them through).
--        - auth.uid() IS NULL (service role / SQL editor / migrations): allowed.
--        - Someone who can manage the trip (organizer, trip creator, site admin): allowed
--          (the freeze RPC, its client fallback that writes 'suggested' rows, prepayments an
--          organizer records already confirmed).
--        - Anyone else: refused (42501), whatever the row says. Nothing in the app needs a
--          participant to create a payment row: payers MARK an existing suggested payment as
--          paid (UPDATE) and receivers CONFIRM it. Letting a participant insert even a
--          'marked_paid' row would let them invent "I paid B 5,000" which the next freeze
--          subtracts from balances and which would email B a confirm button.
--   3. guard_settlement_party_update(): the creator-for-24h shortcut now applies only to people
--      who can manage the trip. Everyone else, creator or not, is held to the payer / payee rules
--      (payer: suggested -> marked_paid only; payee: marked_paid -> confirmed only). Without this,
--      a participant could insert a marked_paid row from themselves and confirm it as its
--      "creator". The function is otherwise the live body (including the created_by / created_at
--      lock); it is made SECURITY DEFINER with a pinned search_path so it can call helper 1.
--
-- LEGITIMATE INSERT PATHS REVIEWED (none is broken):
--   * freeze_settlements (SECURITY DEFINER RPC, caller already passed settlement_assert_can_manage):
--     inserts 'suggested' rows -> manager branch.
--   * useFreezeSettlements client fallback (used only if the RPC is missing): inserts 'suggested'
--     rows as an organizer/creator/admin with finite amounts above zero -> manager branch.
--   * No other code inserts into settlements: "mark paid", "confirm received" and the on-behalf
--     actions UPDATE existing rows; nothing in the UI lets an ordinary participant create a row.
--
-- Also: settlements.status DEFAULT 'confirmed' -> 'suggested'. Every insert path sends status
-- explicitly (freeze_settlements and the client fallback both write 'suggested'; nothing else
-- inserts), so nothing relies on the default, and a future insert that forgets status can no
-- longer create a confirmed payment by accident. (Live history: 28 payers recorded their own
-- payment directly as confirmed; the current app has no such path, so none is changed.)
--
-- Not changed: RLS policies, the UPDATE guard's payer/payee rules.

CREATE OR REPLACE FUNCTION public._settlement_can_manage(p_trip_id uuid, p_uid uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p_uid IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_uid AND u.role = 'admin')
    OR EXISTS (
      SELECT 1 FROM public.trip_participants o
      WHERE o.trip_id = p_trip_id AND o.user_id = p_uid
        AND o.role = 'organizer'::public.participant_role AND o.active
    )
    OR EXISTS (SELECT 1 FROM public.trips t WHERE t.id = p_trip_id AND t.created_by = p_uid)
  )
$$;
REVOKE ALL ON FUNCTION public._settlement_can_manage(uuid, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.guard_settlement_insert()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF NEW.amount IS NULL OR NOT (NEW.amount > 0 AND NEW.amount < 100000000) THEN
    RAISE EXCEPTION 'A payment must have an amount above zero' USING ERRCODE = '22023';
  END IF;
  IF v_uid IS NULL OR public._settlement_can_manage(NEW.trip_id, v_uid) THEN
    RETURN NEW; -- service role / maintenance, or someone who can manage the trip
  END IF;
  RAISE EXCEPTION 'Only organizers can record a payment directly' USING ERRCODE = '42501';
END $$;
REVOKE ALL ON FUNCTION public.guard_settlement_insert() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trigger_guard_settlement_insert ON public.settlements;
CREATE TRIGGER trigger_guard_settlement_insert
  BEFORE INSERT ON public.settlements
  FOR EACH ROW EXECUTE FUNCTION public.guard_settlement_insert();

-- The UPDATE guard: same body as 20260914154536 (+ the created_by/created_at lock), except that the
-- creator-within-24h shortcut is limited to people who can manage the trip.
CREATE OR REPLACE FUNCTION public.guard_settlement_party_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE is_privileged boolean;
BEGIN
  is_privileged := (OLD.created_by = auth.uid() AND OLD.created_at > now() - interval '24 hours'
                      AND public._settlement_can_manage(OLD.trip_id, auth.uid()))
                    OR public.is_trip_organizer(OLD.trip_id, auth.uid());
  IF is_privileged THEN
    -- An organizer may edit a payment, but never into NaN / Infinity / zero / negative / absurd.
    IF NEW.amount IS DISTINCT FROM OLD.amount
       AND (NEW.amount IS NULL OR NOT (NEW.amount > 0 AND NEW.amount < 100000000)) THEN
      RAISE EXCEPTION 'A payment must have an amount above zero' USING ERRCODE = '22023';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'May not change who created this settlement or when';
  END IF;

  IF auth.uid() = OLD.from_user_id THEN
    IF OLD.status IS DISTINCT FROM 'suggested' OR NEW.status IS DISTINCT FROM 'marked_paid' THEN
      RAISE EXCEPTION 'Payer may only mark a suggested settlement as paid';
    END IF;
    IF NEW.amount IS DISTINCT FROM OLD.amount OR NEW.currency IS DISTINCT FROM OLD.currency THEN
      RAISE EXCEPTION 'Payer may not change the settlement amount or currency';
    END IF;
    RETURN NEW;
  ELSIF auth.uid() = OLD.to_user_id THEN
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

ALTER TABLE public.settlements ALTER COLUMN status SET DEFAULT 'suggested';
