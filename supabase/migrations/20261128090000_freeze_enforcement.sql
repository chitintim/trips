SET LOCAL lock_timeout = '5s';

-- Phase 4, M1: a FROZEN trip (trips.settlement_snapshot IS NOT NULL) is enforced by the database, not only by the screens.
-- Until now "balances are frozen" was a UI rule plus a few guards (claims INSERT/UPDATE, the receipt RPCs). A stale page, an old cached client or a direct API call could
-- still add / change / delete expenses, splits and line items, delete a person's claims (the old claim page deletes first and inserts second, so a refused insert LOST the
-- claims) and write the freeze snapshot itself.
--
-- ADDITIVE AND RE-RUNNABLE: CREATE OR REPLACE for the new functions, DROP TRIGGER IF EXISTS + CREATE TRIGGER for the new triggers, DROP POLICY IF EXISTS, idempotent REVOKE/GRANT.
-- No existing function body is changed (guard_claim_overclaim stays byte-identical). The front end needs nothing from this: every refusal is a plain P0001 with a hint.
--
-- WHO IS A "CLIENT": current_user IN ('authenticated', 'anon') (the test every existing guard uses). NOT clients, therefore never blocked here: SECURITY DEFINER functions (they run
-- as the owner: freeze_settlements, unfreeze_settlements, remove_duplicate_settlement, the receipt RPCs, reitemize_expense ...), the service role (jobs, edge functions, payment
-- tokens) and foreign-key cascades (deleting a trip / expense / user cascades as the table owner).
--
-- WHAT A CLIENT CANNOT DO WHILE FROZEN (hint frozen, P0001):
--   expenses            INSERT, DELETE; UPDATE of anything outside the cosmetic whitelist W below
--   expense_splits      INSERT, UPDATE, DELETE
--   expense_line_items  INSERT, UPDATE, DELETE
--   expense_item_claims DELETE (INSERT / UPDATE were already refused by guard_claim_overclaim)
-- and, frozen or not (hint use_rpc, P0001): write trips.settlement_snapshot / settlement_snapshot_at / settlement_snapshot_by (freeze_settlements / unfreeze_settlements are the
-- only writers; on INSERT the three columns are forced NULL).
-- COSMETIC WHITELIST W (changes to these never move money and stay allowed on a frozen trip): description, category, vendor_name, location, receipt_url, receipt_date,
-- payment_date, place_id, option_id, booking_id, ai_parsed_data, parsing_error, updated_at (updated_at because set_updated_at fires first). A WHITELIST: any money column added later
-- is refused by default. Compared as to_jsonb(NEW) - W IS DISTINCT FROM to_jsonb(OLD) - W.
-- Settlements get NO new refusal (status updates, payment links and tokens are the point of freezing).
--
-- RESPONSES: direct client writes to expense_claim_responses are no longer possible (the three write policies are dropped and INSERT/UPDATE/DELETE are revoked from authenticated):
-- answers go through respond_to_receipt (20261126090000), which takes the locks in the standard order. The live client (HEAD 43c4b33) only SELECTs this table.
--
-- LOCK ORDER (unchanged, documented in 20261126090000): (1) 'settlement_freeze:<trip>' advisory lock, (2) 'receipt_claims:<expense>' advisory lock, (3) rows. THE ROW TRIGGERS BELOW
-- TAKE NO ADVISORY LOCK: they run after the statement already holds its row lock, and an advisory lock taken now would invert the order against the definer RPCs (which hold the
-- advisory locks and then UPDATE expenses): a deadlock. Instead they read the trips row with FOR SHARE (_trip_frozen_for_write): freeze_settlements / unfreeze_settlements hold the
-- advisory lock and then the trips row lock and never take an expense-family row lock afterwards, so a client write that waits on the trips row simply waits for the freeze to commit,
-- re-reads and is refused. A client write that got there first delays a freeze by milliseconds. KNOWN, ACCEPTED: deleting a whole trip (holds the trips row, cascades into
-- expenses) at the same instant as a client expense write can be aborted by the deadlock detector on one side (40P01); the CI concurrency test records it.
--
-- OLD CACHED CLIENTS (what they see): add / edit / delete expense -> "Balances are frozen ..." as the failure text, nothing written; the old claim page's save now stops at its first
-- request (the DELETE), so nothing is lost; booking "log expense" leaves a booking without an expense (harmless, the new client hides it while frozen).

-- ---------------------------------------------------------------------------------------------------------------------
-- Helper: is this trip frozen? (reads the trips row FOR SHARE; definer because participants cannot lock trips rows under RLS)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._trip_frozen_for_write(p_trip_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_frozen boolean;
BEGIN
  SELECT t.settlement_snapshot IS NOT NULL INTO v_frozen FROM public.trips t WHERE t.id = p_trip_id FOR SHARE;
  RETURN coalesce(v_frozen, false);
END
$$;

-- Same, from an EXPENSE id: the lookup of expenses.trip_id runs as the owner, so an expense the client cannot see (RLS) can never make the guard skip the check.
CREATE OR REPLACE FUNCTION public._expense_frozen_for_write(p_expense_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_trip uuid;
BEGIN
  SELECT e.trip_id INTO v_trip FROM public.expenses e WHERE e.id = p_expense_id;
  IF v_trip IS NULL THEN
    RETURN false;
  END IF;
  RETURN public._trip_frozen_for_write(v_trip);
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- expenses
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_frozen_expense()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_trip uuid;
  -- cosmetic whitelist (see the header)
  w text[] := ARRAY['description', 'category', 'vendor_name', 'location', 'receipt_url', 'receipt_date', 'payment_date', 'place_id', 'option_id',
                    'booking_id', 'ai_parsed_data', 'parsing_error', 'updated_at'];
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  v_trip := CASE WHEN TG_OP = 'INSERT' THEN NEW.trip_id ELSE OLD.trip_id END;
  IF NOT public._trip_frozen_for_write(v_trip) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - w) IS NOT DISTINCT FROM (to_jsonb(OLD) - w) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Balances are frozen while people settle up, so expenses can''t be added or changed. An organizer can unfreeze them in Settle up.'
    USING ERRCODE = 'P0001', HINT = 'frozen';
END
$$;
DROP TRIGGER IF EXISTS trg_guard_frozen_expense ON public.expenses;
CREATE TRIGGER trg_guard_frozen_expense BEFORE INSERT OR UPDATE OR DELETE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.guard_frozen_expense();

-- ---------------------------------------------------------------------------------------------------------------------
-- children of an expense: splits (all writes), line items (all writes), claims (DELETE)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_frozen_expense_child()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  -- both sides of an UPDATE that moves a row to another expense
  FOREACH v_id IN ARRAY ARRAY[CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.expense_id END, CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.expense_id END] LOOP
    IF v_id IS NOT NULL THEN
      IF public._expense_frozen_for_write(v_id) THEN
        RAISE EXCEPTION 'Balances are frozen while people settle up, so expenses can''t be added or changed. An organizer can unfreeze them in Settle up.'
          USING ERRCODE = 'P0001', HINT = 'frozen';
      END IF;
    END IF;
  END LOOP;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
DROP TRIGGER IF EXISTS trg_guard_frozen_split ON public.expense_splits;
CREATE TRIGGER trg_guard_frozen_split BEFORE INSERT OR UPDATE OR DELETE ON public.expense_splits
  FOR EACH ROW EXECUTE FUNCTION public.guard_frozen_expense_child();
DROP TRIGGER IF EXISTS trg_guard_frozen_line ON public.expense_line_items;
CREATE TRIGGER trg_guard_frozen_line BEFORE INSERT OR UPDATE OR DELETE ON public.expense_line_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_frozen_expense_child();
DROP TRIGGER IF EXISTS trg_guard_frozen_claim_delete ON public.expense_item_claims;
CREATE TRIGGER trg_guard_frozen_claim_delete BEFORE DELETE ON public.expense_item_claims
  FOR EACH ROW EXECUTE FUNCTION public.guard_frozen_expense_child();

-- ---------------------------------------------------------------------------------------------------------------------
-- trips: the freeze snapshot is written only by freeze_settlements / unfreeze_settlements
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_trip_settlement_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' THEN
      NEW.settlement_snapshot := NULL;
      NEW.settlement_snapshot_at := NULL;
      NEW.settlement_snapshot_by := NULL;
    ELSIF NEW.settlement_snapshot IS DISTINCT FROM OLD.settlement_snapshot
          OR NEW.settlement_snapshot_at IS DISTINCT FROM OLD.settlement_snapshot_at
          OR NEW.settlement_snapshot_by IS DISTINCT FROM OLD.settlement_snapshot_by THEN
      RAISE EXCEPTION 'Freeze and unfreeze through Settle up (reload the app if this keeps happening).' USING ERRCODE = 'P0001', HINT = 'use_rpc';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS trg_guard_trip_settlement_columns ON public.trips;
CREATE TRIGGER trg_guard_trip_settlement_columns BEFORE INSERT OR UPDATE ON public.trips
  FOR EACH ROW EXECUTE FUNCTION public.guard_trip_settlement_columns();

-- ---------------------------------------------------------------------------------------------------------------------
-- expense_claim_responses: writes only through respond_to_receipt (and the other definer functions)
-- ---------------------------------------------------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can add their own claim response" ON public.expense_claim_responses;
DROP POLICY IF EXISTS "Users can change their own claim response" ON public.expense_claim_responses;
DROP POLICY IF EXISTS "Users can delete their own claim response" ON public.expense_claim_responses;
REVOKE INSERT, UPDATE, DELETE ON public.expense_claim_responses FROM authenticated, anon;

-- ---------------------------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public._trip_frozen_for_write(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._trip_frozen_for_write(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public._expense_frozen_for_write(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._expense_frozen_for_write(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_frozen_expense() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_frozen_expense_child() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_trip_settlement_columns() FROM PUBLIC, anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
