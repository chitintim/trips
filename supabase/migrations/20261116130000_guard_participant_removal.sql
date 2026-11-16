-- Server-side guard: a participant cannot be deactivated (trip_participants.active
-- true -> false) while money is still riding on them.
--
-- Why: the People tab blocks removal in the UI, but that is UI-only; anyone who
-- can UPDATE trip_participants (organizer RLS) could remove a creditor/debtor
-- through the API, and Settle Up historically computed balances over ACTIVE
-- people only, so their share vanished from everyone's totals.
--
-- Additive: no existing policy or trigger is replaced. The live RLS policies and
-- trigger set on trip_participants are not in this repo (baseline migrations are
-- stubs), so this only ADDs a BEFORE UPDATE OF active trigger.
--
-- Refuses the deactivation (SQLSTATE 23514) when, for that person in that trip:
--   1. they are a party to any settlement whose status is not 'confirmed'
--      (suggested / marked_paid -- a payment still in flight); or
--   2. their net balance is not ~0 (|net| > 1 minor unit of the trip base
--      currency), computed with the SAME rules as the client's computeBalances
--      (src/features/expenses/lib/balances.ts):
--        net = paid - owed + settlementsPaid - settlementsReceived
--        * expense converted to base minor units as round(amount * rate, exp),
--          rate = 1 when currency = base, else fx_rate; expenses with no rate
--          are excluded from the numbers (see 3);
--        * "paid" credits expenses.paid_by; "owed" is the user's expense_splits
--          amount, or -- for itemised expenses (ai_parsed AND status NOT NULL AND
--          at least one expense_line_items row) -- the user's expense_item_claims
--          amount_owed, each converted at the expense's rate and rounded per row;
--        * settlements count only when status is neither suggested nor
--          marked_paid; amount read in the settlement's own currency exponent
--          (base when currency is null), treated 1:1 like the client;
--        * settlement_carryovers in the base currency: the debtor (from) loses and
--          the creditor (to) gains the amount, exactly like carryoversToPseudoSettlements;
--   3. they paid or are split on an expense that cannot be converted (no fx rate):
--      the client leaves such expenses out of the balance, so the person's true
--      position is unknown -- conservative block ("add the rate first").
-- Differences from the client: rounding of exact .5 float edge cases (PG numeric
-- vs JS float) can differ by 1 minor unit, which the 1-unit tolerance absorbs.
-- Calls with no auth.uid() (service role, SQL editor, cron) are not blocked.

CREATE OR REPLACE FUNCTION public.currency_exponent(p_currency text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE upper(coalesce(p_currency, ''))
    WHEN 'BIF' THEN 0 WHEN 'CLP' THEN 0 WHEN 'DJF' THEN 0 WHEN 'GNF' THEN 0
    WHEN 'ISK' THEN 0 WHEN 'JPY' THEN 0 WHEN 'KMF' THEN 0 WHEN 'KRW' THEN 0
    WHEN 'PYG' THEN 0 WHEN 'RWF' THEN 0 WHEN 'UGX' THEN 0 WHEN 'UYI' THEN 0
    WHEN 'VND' THEN 0 WHEN 'VUV' THEN 0 WHEN 'XAF' THEN 0 WHEN 'XOF' THEN 0
    WHEN 'XPF' THEN 0
    WHEN 'BHD' THEN 3 WHEN 'IQD' THEN 3 WHEN 'JOD' THEN 3 WHEN 'KWD' THEN 3
    WHEN 'LYD' THEN 3 WHEN 'OMR' THEN 3 WHEN 'TND' THEN 3
    WHEN 'CLF' THEN 4 WHEN 'UYW' THEN 4
    ELSE 2
  END
$$;

-- Returns the person's trip balance in base-currency minor units (positive =
-- owed money) and whether any expense involving them has no usable fx rate.
-- Internal helper: not an API.
REVOKE ALL ON FUNCTION public.currency_exponent(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.trip_participant_balance_minor(p_trip_id uuid, p_user_id uuid)
RETURNS TABLE (net_minor numeric, unconvertible_expenses integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_base text;
  v_exp int;
  v_paid numeric := 0;
  v_owed numeric := 0;
  v_sp numeric := 0;
  v_sr numeric := 0;
  v_unconv int := 0;
BEGIN
  SELECT coalesce(t.base_currency, 'GBP') INTO v_base FROM public.trips t WHERE t.id = p_trip_id;
  IF v_base IS NULL THEN
    RETURN QUERY SELECT 0::numeric, 0;
    RETURN;
  END IF;
  v_exp := public.currency_exponent(v_base);

  WITH ex AS (
    SELECT e.id, e.paid_by, e.amount,
           CASE WHEN e.currency = v_base THEN 1::numeric ELSE e.fx_rate END AS rate,
           (coalesce(e.ai_parsed, false) AND e.status IS NOT NULL
             AND EXISTS (SELECT 1 FROM public.expense_line_items li WHERE li.expense_id = e.id)) AS itemised
    FROM public.expenses e
    WHERE e.trip_id = p_trip_id
  )
  SELECT
    coalesce(sum(CASE WHEN ex.rate IS NOT NULL AND ex.paid_by = p_user_id
                      THEN round(ex.amount * ex.rate * power(10::numeric, v_exp)) END), 0),
    coalesce(sum(CASE WHEN ex.rate IS NOT NULL THEN
        CASE WHEN ex.itemised THEN
          (SELECT coalesce(sum(round(c.amount_owed * ex.rate * power(10::numeric, v_exp))), 0)
             FROM public.expense_item_claims c WHERE c.expense_id = ex.id AND c.user_id = p_user_id)
        ELSE
          (SELECT coalesce(sum(round(s.amount * ex.rate * power(10::numeric, v_exp))), 0)
             FROM public.expense_splits s WHERE s.expense_id = ex.id AND s.user_id = p_user_id)
        END END), 0),
    count(*) FILTER (WHERE ex.rate IS NULL AND (
        ex.paid_by = p_user_id
        OR EXISTS (SELECT 1 FROM public.expense_splits s WHERE s.expense_id = ex.id AND s.user_id = p_user_id)
        OR EXISTS (SELECT 1 FROM public.expense_item_claims c WHERE c.expense_id = ex.id AND c.user_id = p_user_id)))
  INTO v_paid, v_owed, v_unconv
  FROM ex;

  SELECT
    coalesce(sum(CASE WHEN st.from_user_id = p_user_id
      THEN round(st.amount * power(10::numeric, public.currency_exponent(coalesce(st.currency, v_base)))) END), 0),
    coalesce(sum(CASE WHEN st.to_user_id = p_user_id
      THEN round(st.amount * power(10::numeric, public.currency_exponent(coalesce(st.currency, v_base)))) END), 0)
  INTO v_sp, v_sr
  FROM public.settlements st
  WHERE st.trip_id = p_trip_id
    AND coalesce(st.status, 'confirmed') NOT IN ('suggested', 'marked_paid');

  -- Carryovers behave like a settlement with from/to reversed (debtor loses).
  SELECT v_sp + coalesce(sum(CASE WHEN c.to_user_id = p_user_id
                                  THEN round(c.amount * power(10::numeric, v_exp)) END), 0),
         v_sr + coalesce(sum(CASE WHEN c.from_user_id = p_user_id
                                  THEN round(c.amount * power(10::numeric, v_exp)) END), 0)
  INTO v_sp, v_sr
  FROM public.settlement_carryovers c
  WHERE c.trip_id = p_trip_id AND c.currency = v_base;

  RETURN QUERY SELECT (v_paid - v_owed + v_sp - v_sr), v_unconv;
END;
$$;

-- Internal helper (SECURITY DEFINER, no membership check): it must not be
-- callable as an RPC, or any signed-in user could read anyone's balance. The
-- trigger below runs as the function owner and does not need a grant.
REVOKE ALL ON FUNCTION public.trip_participant_balance_minor(uuid, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.guard_participant_removal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_net numeric;
  v_unconv int;
BEGIN
  IF NOT (OLD.active IS TRUE AND NEW.active IS NOT TRUE) THEN
    RETURN NEW;
  END IF;
  -- System callers (service role, SQL editor, cron) are not blocked.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.settlements st
    WHERE st.trip_id = OLD.trip_id
      AND (st.from_user_id = OLD.user_id OR st.to_user_id = OLD.user_id)
      AND coalesce(st.status, 'confirmed') <> 'confirmed'
  ) THEN
    RAISE EXCEPTION 'Cannot remove this person: a payment involving them is still in progress (suggested or marked paid). Let it finish first, or, if it is only an out-of-date suggestion, ask an organizer to unfreeze balances on the Settle up tab (and freeze again) to refresh the suggestions.'
      USING ERRCODE = '23514';
  END IF;

  SELECT b.net_minor, b.unconvertible_expenses INTO v_net, v_unconv
  FROM public.trip_participant_balance_minor(OLD.trip_id, OLD.user_id) b;

  IF v_unconv > 0 THEN
    RAISE EXCEPTION 'Cannot remove this person: % expense(s) involving them have no exchange rate yet, so their balance is unknown.', v_unconv
      USING ERRCODE = '23514';
  END IF;

  IF abs(v_net) > 1 THEN
    RAISE EXCEPTION 'Cannot remove this person: they still have an open balance. Settle up first.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_participant_removal ON public.trip_participants;
CREATE TRIGGER guard_participant_removal
  BEFORE UPDATE OF active ON public.trip_participants
  FOR EACH ROW EXECUTE FUNCTION public.guard_participant_removal();

COMMENT ON FUNCTION public.guard_participant_removal() IS
  'Refuses active true->false while the person has an unconfirmed settlement, a non-zero balance (client computeBalances rules, 1 minor-unit tolerance) or unconvertible (no fx rate) expenses. Skipped when auth.uid() is null.';

-- Trigger function: must not be callable as an RPC.
REVOKE ALL ON FUNCTION public.guard_participant_removal() FROM PUBLIC, anon, authenticated;
