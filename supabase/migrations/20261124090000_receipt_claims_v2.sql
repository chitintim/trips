SET LOCAL lock_timeout = '5s';

-- Receipt claims v2, phase 1 (database): the payer and organisers record who had what on a receipt, shared lines
-- add up to the penny, and unclaimed value gets an owner before balances can be frozen.
--
-- ADDITIVE AND RE-RUNNABLE: ADD COLUMN IF NOT EXISTS, CHECKs added only if missing, CREATE OR REPLACE for every function,
-- DROP TRIGGER IF EXISTS + CREATE TRIGGER for the three NEW triggers, idempotent REVOKE/GRANT. No existing table, policy or trigger is
-- dropped or changed. Existing rows keep their meaning (source 'self'). Claims RLS is NOT changed: people still insert/delete their own
-- claim rows directly (the new triggers pin what a client can write, below); the two RPCs are the only path for acting on other people's
-- behalf. The front end fails soft until this is applied.
--
-- WHAT IT ADDS
--   expense_item_claims.source      text NOT NULL DEFAULT 'self'  CHECK in (self, on_behalf, shared, leftover)
--   expense_item_claims.created_by  uuid NULL -> users            who recorded the row
--   expense_line_items.shared_by_all boolean NOT NULL DEFAULT false   "table item": shared by everyone tagged
--   expenses.leftover_mode text NULL CHECK in (everyone, person, payer), expenses.leftover_user_id uuid NULL -> users:
--                                   how the leftovers were last shared (written only by share_receipt_leftovers; read by mode 'same')
--   set_receipt_claims(p_expense_id uuid, p_claims jsonb) -> jsonb
--   share_receipt_leftovers(p_expense_id uuid, p_mode text, p_user_id uuid DEFAULT NULL, p_preview boolean DEFAULT false) -> jsonb
--   freeze_settlements(...)         CREATE OR REPLACE, identical signature and body EXCEPT one added block (marked
--                                   ">>> unclaimed_receipts guard" ... "<<< unclaimed_receipts guard") that refuses while any
--                                   itemised receipt on the trip has unclaimed value (hint unclaimed_receipts) or an over-claimed line
--                                   (hint overclaimed_receipts). DETAIL is a JSON array [{id, description, unclaimed_minor|overclaimed_minor}].
--   triggers on expense_item_claims: trg_guard_claim_provenance (clients cannot choose source / created_by),
--                                    trg_guard_claim_overclaim (clients cannot take a line above its quantity + 0.011, under the RPCs' lock);
--   trigger on expenses: trg_guard_expense_leftover_mode (clients cannot write leftover_mode / leftover_user_id).
--                                   "Client" = current_user in (authenticated, anon). SECURITY DEFINER functions run as their owner
--                                   (current_user is the owner inside them), the service role is neither: both are unaffected.
--   refund_rate_limit(p_user_id uuid, p_feature text, p_capacity integer) -> boolean   service_role only (parse-receipt, unbilled failures)
--   private helpers (_receipt_*, _trip_unclaimed_receipts, _trip_overclaimed_receipts): EXECUTE revoked from everyone but the owner/service role.
--
-- THE ONE DUST TOLERANCE, 0.011 (client: LINE_QUANTITY_TOLERANCE in balances.ts; shared cases in
-- src/features/expenses/lib/unclaimedParityCases.json run against both): a line is unclaimed when its quantity left is above 0.011, or the
-- money left is above greatest(1, number of claim rows) + ceil(|line total| * 0.011 / quantity) minor units. So 0.33 x 3 of a line (0.01 left,
-- a few pence) is NOT unclaimed. _receipt_refresh_status, the freeze guard and the over-claim trigger all use it.
--
-- CLAIM REPRESENTATION (matches what the client maths expects; see src/features/expenses/claims/claimMath.ts and
-- src/features/expenses/lib/balances.ts):
--   * one row per (line, person); quantity_claimed in units of the line (hundredths), amount_owed in the EXPENSE currency;
--   * tax, tip, service and discounts are already inside expense_line_items.total_amount (the editor pro-rates them into the
--     line), and balances.ts sums claim.amount_owed as-is, so a person's share of a line IS their share of those adjustments.
--     Nothing is stored per claim and nothing is derived at read time; this migration does not invent a second convention;
--   * a line shared by k people is split by largest remainder TWICE: quantity in hundredths (column is numeric(10,2)) and
--     amount in the currency's minor units (JPY 0, GBP/EUR 2, KWD 3 decimals via currency_exponent()). Both sum EXACTLY to the
--     line's quantity and total_amount. Ties go to the lower user_id, so results are deterministic;
--   * legacy fractional rows (0.5, 0.33, ...; per-claim rounded amounts) are never rewritten unless a manager reassigns that line.
--
-- WHO MAY CALL
--   share_receipt_leftovers: the expense's payer, or anyone who can manage the trip (site admin, ACTIVE organiser, trip creator:
--   _settlement_can_manage from 20261120100000), or the SERVICE ROLE (future deadline job: no user, auth.role() = 'service_role'; the
--   activity row has a NULL actor). Anyone else is refused.
--   set_receipt_claims: the payer / managers with full power (any tagged people, shared_by_all, unassign). A TAGGED person who is neither
--   may only TOGGLE THEMSELVES on a line: new people = old sharers + me, or old sharers - me. Never anyone else; never a shared_by_all line;
--   never set shared_by_all; never a line where somebody else holds rows that are not an exact equal split of the line (a direct "2 of 3
--   beers", a legacy 0.33 share), because re-splitting would rewrite their amount. Rows of people who stay on the line keep their created_by.
--   Nobody else. Both refuse while the trip's balances are frozen (trips.settlement_snapshot IS NOT NULL).
--   "Tagged on the receipt" = expenses.participant_ids when non-empty, otherwise the people IN SCOPE for the trip (see _receipt_tagged:
--   active, and when trips.confirmation_enabled also not declined/cancelled and only the confirmed ones once anyone is confirmed;
--   src/features/people/lib/inScopePeople.ts). participant_ids is NULL on every real itemised receipt today.
--
-- CONCURRENCY: both RPCs take the trip's freeze advisory lock (the one freeze_settlements takes) and then a per-expense lock,
-- so a freeze and a claim edit cannot interleave: the guard in freeze_settlements sees every committed claim. The over-claim trigger takes
-- the same per-expense lock for direct client inserts.
--
-- LEFTOVER RULE (proposal section 2d), as implemented in _receipt_leftover_plan:
--   T = tagged people, n = |T|; Total = expense amount in minor units; even share F = floor(Total / n);
--   L = sum over lines of max(0, line total - claimed amount_owed on that line)  (existing leftover rows are ignored: they are
--   derived and rebuilt); U = T minus the "confirmed" set; room_u = max(0, F - claimed_u).
--   1. split L across U equally, nobody above room_u (water-filling: whoever is capped keeps their cap, the excess is split
--      between the rest of U, repeat);  2. whatever is still left (U empty, or everyone in U capped) is split equally across T;
--   3. integer pennies by largest remainder, ties by user_id; then each person's total is spread over the unclaimed lines in
--      proportion to each line's remainder, again exactly (every line sums to its remainder, every person to their total).
--   PHASE 1 has no "That's everything" confirmation, so _receipt_leftover_confirmed returns EVERYONE TAGGED: U is empty and "Share between
--   everyone" is a PLAIN EQUAL SPLIT of the unclaimed value between everyone tagged (nobody is singled out). Phase 2 replaces that one
--   function with the real confirmed set; the plan function already handles it (both proposal examples are tested with an explicit set).
--   DISCOUNTS: a line with a NEGATIVE total and no claim rows is shared equally between everyone tagged (largest remainder) by
--   share_receipt_leftovers in every mode, and blocks the freeze until then (nobody can claim a voucher).
--
-- ASSUMPTIONS (verify with supabase/PRE_APPLY_CHECKS.sql group 21):
--   * expense_item_claims has NO unique constraint on (line_item_id, user_id) (a person can hold a leftover row and an own row on
--     the same line), no CHECK forcing quantity_claimed > 0 (a leftover row for a value-only remainder may carry 0.00), and
--     quantity_claimed is numeric(10,2) (hundredths) and amount_owed numeric;
--   * expenses.status is the enum expense_status (unallocated|pending_allocation|allocated|confirmed); 'confirmed' is never changed;
--   * activity_feed accepts a NULL actor and has no verb CHECK (live: only FKs);
--   * currency_exponent(text) (20261116130000) and _settlement_can_manage(uuid, uuid) (20261120100000) exist;
--   * rate_limits(user_id, feature, tokens, last_refill) exists; auth.role() exists (Supabase).
-- Unchanged: realtime publication, the claim page's own-user policies, guard_immutable_keys.

ALTER TABLE public.expense_item_claims ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'self';
ALTER TABLE public.expense_item_claims ADD COLUMN IF NOT EXISTS created_by uuid NULL REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.expense_line_items ADD COLUMN IF NOT EXISTS shared_by_all boolean NOT NULL DEFAULT false;
-- How the leftovers on this receipt were last shared (set only by share_receipt_leftovers; read by mode 'same'). Never trusted from
-- activity_feed, which any participant can write. Clients cannot write these (trg_guard_expense_leftover_mode below).
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS leftover_mode text NULL;
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS leftover_user_id uuid NULL REFERENCES public.users(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.expense_item_claims'::regclass AND conname = 'expense_item_claims_source_check'
  ) THEN
    ALTER TABLE public.expense_item_claims
      ADD CONSTRAINT expense_item_claims_source_check
      CHECK (source IN ('self', 'on_behalf', 'shared', 'leftover'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.expenses'::regclass AND conname = 'expenses_leftover_mode_check'
  ) THEN
    ALTER TABLE public.expenses
      ADD CONSTRAINT expenses_leftover_mode_check
      CHECK (leftover_mode IS NULL OR leftover_mode IN ('everyone', 'person', 'payer'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Private helpers
-- ---------------------------------------------------------------------------------------------------------------------

-- Equal split of an integer into n parts by largest remainder: the first (total mod n) parts get one extra unit.
CREATE OR REPLACE FUNCTION public._receipt_even_split(p_total bigint, p_n integer)
RETURNS bigint[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_base bigint;
  v_rem integer;
  v_out bigint[] := ARRAY[]::bigint[];
  i integer;
BEGIN
  IF p_n IS NULL OR p_n <= 0 THEN
    RETURN ARRAY[]::bigint[];
  END IF;
  v_base := floor(p_total::numeric / p_n)::bigint;
  v_rem := (p_total - v_base * p_n)::integer;
  FOR i IN 1..p_n LOOP
    v_out := v_out || (v_base + CASE WHEN i <= v_rem THEN 1 ELSE 0 END);
  END LOOP;
  RETURN v_out;
END
$$;

-- People on the receipt, sorted by user_id (the stable order every tie is broken in).
--   * expenses.participant_ids non-empty: exactly those people (who are on the trip).
--   * NULL / empty (every real itemised receipt today): the people IN SCOPE for the trip, the same rule as
--     src/features/people/lib/inScopePeople.ts: ACTIVE participants (active is not false); when trips.confirmation_enabled is true,
--     additionally drop declined and cancelled people, and if at least one of the remaining people is 'confirmed' keep ONLY the
--     confirmed ones. (Waitlist / interested people stay in scope exactly as in the client: it only drops declined and cancelled.)
--   * In BOTH cases also: anyone with a non-leftover claim on the receipt who has a trip_participants row (active or not, replied or not),
--     and, when there is no explicit list, the payer. Mirrored in src/features/expenses/claims/claimPeople.ts (peopleOnReceipt).
CREATE OR REPLACE FUNCTION public._receipt_tagged(p_expense_id uuid)
RETURNS uuid[]
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(array_agg(s.uid ORDER BY s.uid), ARRAY[]::uuid[])
  FROM (
    SELECT x AS uid
    FROM public.expenses e, unnest(e.participant_ids) AS x
    WHERE e.id = p_expense_id AND coalesce(cardinality(e.participant_ids), 0) > 0
      AND EXISTS (SELECT 1 FROM public.trip_participants tp WHERE tp.trip_id = e.trip_id AND tp.user_id = x)
    UNION
    SELECT tp.user_id AS uid
    FROM public.expenses e
    JOIN public.trips t ON t.id = e.trip_id
    JOIN public.trip_participants tp ON tp.trip_id = e.trip_id AND coalesce(tp.active, true)
    WHERE e.id = p_expense_id AND coalesce(cardinality(e.participant_ids), 0) = 0
      AND (
        NOT coalesce(t.confirmation_enabled, false)
        OR (
          coalesce(tp.confirmation_status::text, '') NOT IN ('declined', 'cancelled')
          AND (
            tp.confirmation_status::text = 'confirmed'
            OR NOT EXISTS (
              SELECT 1 FROM public.trip_participants o
              WHERE o.trip_id = e.trip_id AND coalesce(o.active, true) AND o.confirmation_status::text = 'confirmed')
          )
        )
      )
    UNION
    -- Anyone who holds a (non-derived) claim on the receipt and has a trip_participants row is ALWAYS tagged, whether or not the receipt has an
    -- explicit list: a "No reply yet" person or someone who has since left must not be locked out of (or silently dropped from) their own claim.
    SELECT cl.user_id AS uid
    FROM public.expense_item_claims cl
    JOIN public.expenses e ON e.id = cl.expense_id
    JOIN public.trip_participants tp ON tp.trip_id = e.trip_id AND tp.user_id = cl.user_id
    WHERE cl.expense_id = p_expense_id AND cl.source <> 'leftover'
    UNION
    -- The payer is always on a receipt that has no explicit list (with an explicit list, the list is exactly who the payer chose).
    SELECT e.paid_by AS uid
    FROM public.expenses e
    WHERE e.id = p_expense_id AND coalesce(cardinality(e.participant_ids), 0) = 0
  ) s
$$;

-- Per line: value and quantity in integer units (minor units / hundredths), claimed, and what is left.
-- remaining_* are floored at zero (a legacy line whose rounded claims exceed it is not negative-unclaimed).
-- p_include_leftover = false ignores derived leftover rows (used when computing/rebuilding them).
CREATE OR REPLACE FUNCTION public._receipt_lines(p_expense_id uuid, p_include_leftover boolean)
RETURNS TABLE (
  line_item_id uuid, line_number integer, total_minor bigint, qty_h bigint,
  claimed_minor bigint, claimed_qh bigint, remaining_minor bigint, remaining_qh bigint
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT li.id, li.line_number, t.total_minor, t.qty_h,
         coalesce(c.m, 0)::bigint, coalesce(c.q, 0)::bigint,
         greatest(0, t.total_minor - coalesce(c.m, 0))::bigint,
         greatest(0, t.qty_h - coalesce(c.q, 0))::bigint
  FROM public.expenses e
  JOIN public.expense_line_items li ON li.expense_id = e.id
  CROSS JOIN LATERAL (SELECT power(10::numeric, public.currency_exponent(e.currency)) AS pw) p
  CROSS JOIN LATERAL (
    SELECT round(li.total_amount * p.pw)::bigint AS total_minor, round(li.quantity * 100)::bigint AS qty_h
  ) t
  LEFT JOIN LATERAL (
    SELECT sum(round(cl.amount_owed * p.pw)) AS m, sum(round(cl.quantity_claimed * 100)) AS q
    FROM public.expense_item_claims cl
    WHERE cl.line_item_id = li.id AND (p_include_leftover OR cl.source <> 'leftover')
  ) c ON true
  WHERE e.id = p_expense_id
$$;

-- Itemised receipts on a trip that still have unclaimed value (same "itemised" test as balances.ts: ai_parsed, status set, has lines).
-- MIRRORS the client exactly (src/features/expenses/lib/balances.ts: analyseReceiptClaims + isLineReallyUnclaimed), one shared tolerance 0.011:
--   per line (own currency, minor units; every claim row counts, leftover rows included, each rounded on its own):
--     left = total - claimed;  the line is unclaimed when left > 0 AND quantity > 0 AND
--       ( quantity - claimed_quantity > 0.011   OR   left > greatest(1, number of claim rows on the line) + ceil(|total| * 0.011 / quantity) )
--     i.e. legacy rounding dust on a line whose quantity is complete (0.33 x 3 of a line) is NOT unclaimed;
--   per receipt: real = sum of the unclaimed lines' left; the receipt is netted against its payer's pending bucket exactly like the client:
--     unclaimed = min(real converted to the base currency, round(amount * rate) - sum of each claim converted and rounded) and > 0 blocks.
--   Foreign-currency receipt with fx_rate NULL: the client lists it in its OWN currency (rate 1, no conversion), so does this.
--   DISCOUNTS: a line with a NEGATIVE total and no claim rows at all is "open" (nobody can claim a voucher): it blocks the freeze until
--   share_receipt_leftovers shares it equally between everyone tagged (it does that in every mode). Reported on top of the amount above.
-- unclaimed_minor is in the RECEIPT currency.
CREATE OR REPLACE FUNCTION public._trip_unclaimed_receipts(p_trip_id uuid)
RETURNS TABLE (expense_id uuid, description text, unclaimed_minor bigint)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH e AS (
    SELECT e.id, e.description, e.amount,
           power(10::numeric, public.currency_exponent(e.currency)) AS pw,
           CASE WHEN e.currency = t.base_currency OR e.fx_rate IS NULL THEN 1::numeric ELSE e.fx_rate END AS rate,
           power(10::numeric, public.currency_exponent(
             CASE WHEN e.currency = t.base_currency OR e.fx_rate IS NULL THEN e.currency ELSE t.base_currency END)) AS bpw,
           (e.currency = t.base_currency OR e.fx_rate IS NULL) AS same_unit
    FROM public.expenses e
    JOIN public.trips t ON t.id = e.trip_id
    WHERE e.trip_id = p_trip_id AND coalesce(e.ai_parsed, false) AND e.status IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.expense_line_items li WHERE li.expense_id = e.id)),
  l AS (
    SELECT e.id AS eid, li.quantity,
           round(li.total_amount * e.pw)::bigint AS tot,
           coalesce(sum(round(c.amount_owed * e.pw)), 0)::bigint AS cm,
           coalesce(sum(round(c.amount_owed * e.rate * e.bpw)), 0)::bigint AS cb,
           coalesce(sum(c.quantity_claimed), 0) AS cq,
           count(c.id) AS nrows
    FROM e JOIN public.expense_line_items li ON li.expense_id = e.id
    LEFT JOIN public.expense_item_claims c ON c.line_item_id = li.id
    GROUP BY e.id, li.id, li.quantity, li.total_amount, e.pw, e.rate, e.bpw),
  r AS (
    SELECT eid,
           coalesce(sum(CASE WHEN tot - cm > 0 AND quantity > 0
                              AND (quantity - cq > 0.011
                                   OR tot - cm > greatest(1, nrows) + ceil(abs(tot) * 0.011 / nullif(quantity, 0)))
                             THEN tot - cm ELSE 0 END), 0)::bigint AS real_minor,
           coalesce(sum(cb), 0)::bigint AS claimed_base,
           coalesce(sum(CASE WHEN tot < 0 AND nrows = 0 THEN -tot ELSE 0 END), 0)::bigint AS open_discount
    FROM l GROUP BY eid),
  n AS (
    SELECT e.id, e.description, r.real_minor, r.open_discount,
           least(CASE WHEN e.same_unit THEN r.real_minor
                      ELSE round(r.real_minor / e.pw * e.rate * e.bpw)::bigint END,
                 round(e.amount * e.rate * e.bpw)::bigint - r.claimed_base) AS net_base
    FROM e JOIN r ON r.eid = e.id)
  SELECT n.id, n.description,
         (CASE WHEN n.net_base > 0 THEN n.real_minor ELSE 0 END + n.open_discount)::bigint
  FROM n
  WHERE n.net_base > 0 OR n.open_discount > 0
$$;

-- Over-claimed itemised receipts: a line whose claimed quantity is above its quantity by more than the shared 0.011 tolerance AND whose
-- claimed money is above the line total by more than the same dust allowance. The claims maths floors those lines at zero, so the claimers
-- overpay and the payer's pending goes negative: freezing over that is refused (hint overclaimed_receipts). Direct client writes cannot
-- create these any more (trg_guard_claim_overclaim); this catches legacy rows and edited line totals.
CREATE OR REPLACE FUNCTION public._trip_overclaimed_receipts(p_trip_id uuid)
RETURNS TABLE (expense_id uuid, description text, overclaimed_minor bigint)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH l AS (
    SELECT e.id AS eid, e.description, li.quantity,
           round(li.total_amount * power(10::numeric, public.currency_exponent(e.currency)))::bigint AS tot,
           coalesce(sum(round(c.amount_owed * power(10::numeric, public.currency_exponent(e.currency)))), 0)::bigint AS cm,
           coalesce(sum(c.quantity_claimed), 0) AS cq,
           count(c.id) AS nrows
    FROM public.expenses e
    JOIN public.expense_line_items li ON li.expense_id = e.id
    LEFT JOIN public.expense_item_claims c ON c.line_item_id = li.id
    WHERE e.trip_id = p_trip_id AND coalesce(e.ai_parsed, false) AND e.status IS NOT NULL
    GROUP BY e.id, e.description, e.currency, li.id, li.quantity, li.total_amount)
  SELECT l.eid, l.description, sum(l.cm - l.tot)::bigint
  FROM l
  WHERE l.quantity > 0 AND l.tot > 0 AND l.cq - l.quantity > 0.011
    AND l.cm - l.tot > greatest(1, l.nrows) + ceil(abs(l.tot) * 0.011 / nullif(l.quantity, 0))
  GROUP BY l.eid, l.description
$$;

-- PHASE 2 HOOK: people who have said "That's everything" on this receipt. PHASE 1 returns EVERYONE TAGGED, so the unclaimed value is a plain
-- equal split between everyone on the receipt (nobody is singled out before the "That's everything" confirmation exists). Phase 2 replaces
-- this one function with the real set.
CREATE OR REPLACE FUNCTION public._receipt_leftover_confirmed(p_expense_id uuid)
RETURNS uuid[]
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT public._receipt_tagged(p_expense_id)
$$;

-- Common start for both RPCs: auth, existence, who-may-act, locks, frozen, itemised. Returns the (re-read) expense row.
CREATE OR REPLACE FUNCTION public._receipt_begin(p_expense_id uuid, p_manager_only boolean)
RETURNS public.expenses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_exp public.expenses;
  v_frozen boolean;
  v_service boolean := false;
BEGIN
  -- The future deadline job runs as the service role (no user): only for the manager-only RPC (share_receipt_leftovers).
  IF v_uid IS NULL AND p_manager_only AND coalesce(auth.role(), '') = 'service_role' THEN
    v_service := true;
  END IF;
  IF v_uid IS NULL AND NOT v_service THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501', HINT = 'auth';
  END IF;
  IF p_expense_id IS NULL THEN
    RAISE EXCEPTION 'Expense not found' USING ERRCODE = 'P0002', HINT = 'not_found';
  END IF;

  SELECT * INTO v_exp FROM public.expenses WHERE id = p_expense_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found' USING ERRCODE = 'P0002', HINT = 'not_found';
  END IF;
  IF NOT v_service AND NOT (v_exp.paid_by = v_uid OR public._settlement_can_manage(v_exp.trip_id, v_uid)) THEN
    -- Not the payer or a manager: only set_receipt_claims lets a tagged person in (p_manager_only = false), and it
    -- then restricts what they may do (see there).
    IF p_manager_only OR NOT (v_uid = ANY (public._receipt_tagged(p_expense_id))) THEN
      RAISE EXCEPTION 'Only the person who paid, or a trip organizer, can do this; people on the receipt can share their own items'
        USING ERRCODE = '42501', HINT = 'forbidden';
    END IF;
  END IF;

  -- Same lock freeze_settlements takes, then a per-expense lock (released at commit/rollback).
  PERFORM pg_advisory_xact_lock(hashtextextended('settlement_freeze:' || v_exp.trip_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('receipt_claims:' || p_expense_id::text, 0));

  -- Re-read after the locks: another session may have changed the row, or frozen the trip, while we waited.
  SELECT * INTO v_exp FROM public.expenses WHERE id = p_expense_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found' USING ERRCODE = 'P0002', HINT = 'not_found';
  END IF;
  SELECT t.settlement_snapshot IS NOT NULL INTO v_frozen FROM public.trips t WHERE t.id = v_exp.trip_id;
  IF coalesce(v_frozen, false) THEN
    RAISE EXCEPTION 'Balances are frozen for this trip. Ask an organizer to unfreeze before changing who had what.'
      USING ERRCODE = 'P0001', HINT = 'frozen';
  END IF;
  IF NOT (coalesce(v_exp.ai_parsed, false) AND v_exp.status IS NOT NULL
          AND EXISTS (SELECT 1 FROM public.expense_line_items li WHERE li.expense_id = p_expense_id)) THEN
    RAISE EXCEPTION 'This expense isn''t itemised' USING ERRCODE = '22023', HINT = 'not_itemised';
  END IF;
  RETURN v_exp;
END
$$;

-- Mirror of the client (isLineReallyUnclaimed): allocated when no line has more than 0.011 of a unit unclaimed (the one shared dust
-- tolerance; 0.33 x 3 of a line leaves 0.01 and counts as fully claimed). Was 0.001, which flipped legacy-thirds receipts to pending.
-- 'confirmed' (and anything unknown) is never touched.
CREATE OR REPLACE FUNCTION public._receipt_refresh_status(p_expense_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_all boolean;
  v_new public.expense_status;
  v_cur public.expense_status;
BEGIN
  SELECT e.status INTO v_cur FROM public.expenses e WHERE e.id = p_expense_id;
  IF v_cur IS NULL OR v_cur::text NOT IN ('unallocated', 'pending_allocation', 'allocated') THEN
    RETURN v_cur::text;
  END IF;
  SELECT NOT EXISTS (
    SELECT 1 FROM public.expense_line_items li
    WHERE li.expense_id = p_expense_id
      AND li.quantity - coalesce((SELECT sum(cl.quantity_claimed) FROM public.expense_item_claims cl WHERE cl.line_item_id = li.id), 0) > 0.011
  ) INTO v_all;
  v_new := CASE WHEN v_all THEN 'allocated' ELSE 'pending_allocation' END;
  IF v_new IS DISTINCT FROM v_cur THEN
    UPDATE public.expenses SET status = v_new WHERE id = p_expense_id;
  END IF;
  RETURN v_new::text;
END
$$;

-- Step 1-2 of the leftover rule: how much of the unclaimed value each person takes (minor units), pennies by largest
-- remainder. p_confirmed is the set of people who have confirmed (empty in phase 1; phase 2 passes the real set).
CREATE OR REPLACE FUNCTION public._receipt_leftover_plan(p_expense_id uuid, p_confirmed uuid[])
RETURNS TABLE (user_id uuid, amount_minor bigint, claimed_minor bigint)
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_exp public.expenses;
  v_tagged uuid[];
  n integer;
  v_pw numeric;
  v_total bigint;
  v_even bigint;
  v_left bigint;
  v_claimed bigint[];
  v_room bigint[];
  v_alloc bigint[];
  v_active boolean[];
  v_cnt integer;
  v_changed boolean;
  v_share bigint[];
  v_snapR bigint;
  v_snapC integer;
  v_tmp bigint;
  v_sat boolean[];
  i integer;
  k integer;
BEGIN
  SELECT * INTO v_exp FROM public.expenses WHERE id = p_expense_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found' USING ERRCODE = 'P0002', HINT = 'not_found';
  END IF;
  v_tagged := public._receipt_tagged(p_expense_id);
  n := coalesce(cardinality(v_tagged), 0);
  IF n = 0 THEN
    RAISE EXCEPTION 'Nobody is tagged on this receipt' USING ERRCODE = '22023', HINT = 'not_tagged';
  END IF;
  v_pw := power(10::numeric, public.currency_exponent(v_exp.currency));
  v_total := round(v_exp.amount * v_pw)::bigint;
  v_even := greatest(0, floor(v_total::numeric / n))::bigint;
  SELECT coalesce(sum(l.remaining_minor), 0) INTO v_left FROM public._receipt_lines(p_expense_id, false) l;

  v_claimed := array_fill(0::bigint, ARRAY[n]);
  v_room := array_fill(0::bigint, ARRAY[n]);
  v_alloc := array_fill(0::bigint, ARRAY[n]);
  v_active := array_fill(false, ARRAY[n]);
  v_cnt := 0;
  FOR i IN 1..n LOOP
    SELECT coalesce(sum(round(cl.amount_owed * v_pw)), 0)::bigint INTO v_tmp
    FROM public.expense_item_claims cl
    WHERE cl.expense_id = p_expense_id AND cl.user_id = v_tagged[i] AND cl.source <> 'leftover';
    v_claimed[i] := v_tmp;
    v_room[i] := greatest(0, v_even - v_claimed[i]);
    IF NOT (v_tagged[i] = ANY (coalesce(p_confirmed, ARRAY[]::uuid[]))) THEN
      v_active[i] := true;
      v_cnt := v_cnt + 1;
    END IF;
  END LOOP;

  -- Step 1: water-filling over U (the people who have not confirmed). Anyone whose room is at most the current
  -- equal share keeps exactly their room; the excess moves to the rest; repeat until nobody is capped.
  WHILE v_left > 0 AND v_cnt > 0 LOOP
    v_changed := false;
    v_snapR := v_left;
    v_snapC := v_cnt;
    v_sat := array_fill(false, ARRAY[n]);
    FOR i IN 1..n LOOP
      IF v_active[i] AND v_room[i]::numeric * v_snapC <= v_snapR THEN
        v_sat[i] := true;
      END IF;
    END LOOP;
    FOR i IN 1..n LOOP
      IF v_sat[i] THEN
        v_alloc[i] := v_alloc[i] + v_room[i];
        v_left := v_left - v_room[i];
        v_active[i] := false;
        v_cnt := v_cnt - 1;
        v_changed := true;
      END IF;
    END LOOP;
    IF NOT v_changed THEN
      -- nobody is capped: the rest of U splits what is left equally (largest remainder, lowest user_id first)
      v_share := public._receipt_even_split(v_left, v_cnt);
      k := 0;
      FOR i IN 1..n LOOP
        IF v_active[i] THEN
          k := k + 1;
          v_alloc[i] := v_alloc[i] + v_share[k];
        END IF;
      END LOOP;
      v_left := 0;
    END IF;
  END LOOP;

  -- Step 2: whatever is still left (U empty, or everyone in U was capped) is shared by everyone on the receipt.
  IF v_left > 0 THEN
    v_share := public._receipt_even_split(v_left, n);
    FOR i IN 1..n LOOP
      v_alloc[i] := v_alloc[i] + v_share[i];
    END LOOP;
    v_left := 0;
  END IF;

  FOR i IN 1..n LOOP
    IF v_alloc[i] > 0 THEN
      user_id := v_tagged[i];
      amount_minor := v_alloc[i];
      claimed_minor := v_claimed[i];
      RETURN NEXT;
    END IF;
  END LOOP;
END
$$;

-- Step 3: spread each person's total over the unclaimed lines so that every line sums EXACTLY to its remainder and every
-- person EXACTLY to their total (proportional, pennies to whoever is furthest below their total). Quantity (hundredths) follows
-- each line's amounts the same way. p_people/p_amounts must add up to the total unclaimed value.
CREATE OR REPLACE FUNCTION public._receipt_leftover_distribute(p_expense_id uuid, p_people uuid[], p_amounts bigint[])
RETURNS TABLE (line_item_id uuid, user_id uuid, amount_minor bigint, qty_h bigint)
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_k integer := coalesce(cardinality(p_people), 0);
  v_line record;
  v_n integer;
  v_j integer := 0;
  v_total bigint;
  v_cum bigint[];
  v_a bigint[];
  v_q bigint[];
  v_fr numeric[];
  v_picked boolean[];
  v_pen bigint;
  v_pq bigint;
  v_sum bigint;
  v_best integer;
  v_bestd bigint;
  v_bestfr numeric;
  u integer;
BEGIN
  IF v_k = 0 THEN
    RETURN;
  END IF;
  SELECT coalesce(sum(l.remaining_minor), 0), count(*) INTO v_total, v_n
  FROM public._receipt_lines(p_expense_id, false) l WHERE l.remaining_minor > 0;
  IF v_n = 0 THEN
    RETURN;
  END IF;
  IF (SELECT coalesce(sum(x), 0) FROM unnest(p_amounts) x) IS DISTINCT FROM v_total THEN
    RAISE EXCEPTION 'Leftover amounts do not add up to the unclaimed value' USING ERRCODE = 'XX000';
  END IF;
  v_cum := array_fill(0::bigint, ARRAY[v_k]);

  FOR v_line IN
    SELECT l.line_item_id AS lid, l.remaining_minor AS r, l.remaining_qh AS rq
    FROM public._receipt_lines(p_expense_id, false) l
    WHERE l.remaining_minor > 0
    ORDER BY l.line_number, l.line_item_id
  LOOP
    v_j := v_j + 1;
    v_a := array_fill(0::bigint, ARRAY[v_k]);
    IF v_j = v_n THEN
      FOR u IN 1..v_k LOOP
        v_a[u] := p_amounts[u] - v_cum[u];
      END LOOP;
    ELSE
      v_sum := 0;
      FOR u IN 1..v_k LOOP
        v_a[u] := floor(v_line.r::numeric * p_amounts[u] / v_total)::bigint;
        v_sum := v_sum + v_a[u];
      END LOOP;
      v_pen := v_line.r - v_sum;
      WHILE v_pen > 0 LOOP
        v_best := 0;
        v_bestd := 0;
        FOR u IN 1..v_k LOOP
          IF p_amounts[u] - v_cum[u] - v_a[u] > v_bestd THEN
            v_best := u;
            v_bestd := p_amounts[u] - v_cum[u] - v_a[u];
          END IF;
        END LOOP;
        IF v_best = 0 THEN
          RAISE EXCEPTION 'Could not place a leftover penny' USING ERRCODE = 'XX000';
        END IF;
        v_a[v_best] := v_a[v_best] + 1;
        v_pen := v_pen - 1;
      END LOOP;
    END IF;

    -- quantity (hundredths) in proportion to the line's amounts
    v_q := array_fill(0::bigint, ARRAY[v_k]);
    v_fr := array_fill(0::numeric, ARRAY[v_k]);
    v_picked := array_fill(false, ARRAY[v_k]);
    v_sum := 0;
    FOR u IN 1..v_k LOOP
      IF v_a[u] > 0 THEN
        v_q[u] := floor(v_line.rq::numeric * v_a[u] / v_line.r)::bigint;
        v_fr[u] := v_line.rq::numeric * v_a[u] - v_q[u] * v_line.r;
        v_sum := v_sum + v_q[u];
      END IF;
    END LOOP;
    v_pq := v_line.rq - v_sum;
    WHILE v_pq > 0 LOOP
      v_best := 0;
      v_bestfr := -1;
      FOR u IN 1..v_k LOOP
        IF v_a[u] > 0 AND NOT v_picked[u] AND v_fr[u] > v_bestfr THEN
          v_best := u;
          v_bestfr := v_fr[u];
        END IF;
      END LOOP;
      EXIT WHEN v_best = 0;
      v_q[v_best] := v_q[v_best] + 1;
      v_picked[v_best] := true;
      v_pq := v_pq - 1;
    END LOOP;

    FOR u IN 1..v_k LOOP
      v_cum[u] := v_cum[u] + v_a[u];
      IF v_a[u] > 0 THEN
        line_item_id := v_line.lid;
        user_id := p_people[u];
        amount_minor := v_a[u];
        qty_h := v_q[u];
        RETURN NEXT;
      END IF;
    END LOOP;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- set_receipt_claims
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_receipt_claims(p_expense_id uuid, p_claims jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_exp public.expenses;
  v_tagged uuid[];
  v_item jsonb;
  v_line uuid;
  v_seen uuid[] := ARRAY[]::uuid[];
  v_users uuid[];
  v_all boolean;
  v_bad integer;
  v_li public.expense_line_items;
  v_pw numeric;
  v_exp_digits integer;
  v_qs bigint[];
  v_as bigint[];
  v_k integer;
  i integer;
  v_rows integer := 0;
  v_assigned integer := 0;
  v_unassigned integer := 0;
  v_status text;
  v_lines jsonb;
  v_unclaimed_lines jsonb;
  v_unclaimed numeric;
  v_unclaimed_minor bigint;
  v_is_manager boolean;
  v_existing uuid[];
  v_equal boolean;
  v_prev_cb jsonb;
BEGIN
  v_exp := public._receipt_begin(p_expense_id, false);
  v_is_manager := v_exp.paid_by = v_uid OR public._settlement_can_manage(v_exp.trip_id, v_uid);
  v_tagged := public._receipt_tagged(p_expense_id);
  v_pw := power(10::numeric, public.currency_exponent(v_exp.currency));
  v_exp_digits := public.currency_exponent(v_exp.currency);

  IF p_claims IS NULL OR jsonb_typeof(p_claims) <> 'array' THEN
    RAISE EXCEPTION 'Claims must be a list' USING ERRCODE = '22023', HINT = 'bad_input';
  END IF;
  IF jsonb_array_length(p_claims) > 500 THEN
    RAISE EXCEPTION 'Too many lines in one request' USING ERRCODE = '22023', HINT = 'bad_input';
  END IF;

  FOR v_item IN SELECT e.value FROM jsonb_array_elements(p_claims) AS e(value) LOOP
    IF jsonb_typeof(v_item) <> 'object' OR NOT (v_item ? 'line_item_id') THEN
      RAISE EXCEPTION 'Each entry needs a line_item_id' USING ERRCODE = '22023', HINT = 'bad_input';
    END IF;
    BEGIN
      v_line := (v_item ->> 'line_item_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'A line id is not valid' USING ERRCODE = '22023', HINT = 'bad_input';
    END;
    IF v_line IS NULL OR v_line = ANY (v_seen) THEN
      RAISE EXCEPTION 'A line is listed twice or missing' USING ERRCODE = '22023', HINT = 'bad_input';
    END IF;
    v_seen := v_seen || v_line;

    SELECT li.* INTO v_li FROM public.expense_line_items li
    WHERE li.id = v_line AND li.expense_id = p_expense_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'A line doesn''t belong to this expense' USING ERRCODE = '22023', HINT = 'bad_line';
    END IF;

    IF v_item -> 'shared_by_all' IS NOT NULL AND jsonb_typeof(v_item -> 'shared_by_all') NOT IN ('boolean', 'null') THEN
      RAISE EXCEPTION 'shared_by_all must be true or false' USING ERRCODE = '22023', HINT = 'bad_input';
    END IF;
    v_all := coalesce((v_item -> 'shared_by_all') = 'true'::jsonb, false);

    IF v_all AND NOT v_is_manager THEN
      RAISE EXCEPTION 'Only the person who paid, or a trip organizer, can share a line between everyone'
        USING ERRCODE = '42501', HINT = 'forbidden';
    END IF;

    IF v_all THEN
      v_users := v_tagged;
      IF coalesce(cardinality(v_users), 0) = 0 THEN
        RAISE EXCEPTION 'Nobody is tagged on this receipt' USING ERRCODE = '22023', HINT = 'not_tagged';
      END IF;
    ELSIF jsonb_typeof(v_item -> 'user_ids') = 'array' THEN
      BEGIN
        SELECT coalesce(array_agg(DISTINCT x::uuid ORDER BY x::uuid), ARRAY[]::uuid[]) INTO v_users
        FROM jsonb_array_elements_text(v_item -> 'user_ids') AS t(x);
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'A person id is not valid' USING ERRCODE = '22023', HINT = 'bad_input';
      END;
      SELECT count(*) INTO v_bad FROM unnest(v_users) AS u(id) WHERE NOT (u.id = ANY (v_tagged));
      IF v_bad > 0 THEN
        RAISE EXCEPTION '% % on this receipt', v_bad, CASE WHEN v_bad = 1 THEN 'person isn''t' ELSE 'people aren''t' END
          USING ERRCODE = '22023', HINT = 'not_tagged';
      END IF;
    ELSE
      RAISE EXCEPTION 'Each entry needs user_ids (a list) or shared_by_all' USING ERRCODE = '22023', HINT = 'bad_input';
    END IF;

    IF NOT v_is_manager THEN
      -- A tagged person who is neither the payer nor a manager may only TOGGLE THEMSELVES on a line:
      --   add myself:        new people = old sharers + me (or unchanged when I am already on it);
      --   take myself off:   new people = old sharers - me (I must be on it; empty only when I was the sole claimer).
      -- Never anyone else, never shared_by_all, never a line where someone else holds a row that is not an exact equal split of the
      -- line (a direct "2 of 3 beers" or a legacy 0.33 share): re-splitting would rewrite their amount.
      IF v_li.shared_by_all THEN
        RAISE EXCEPTION 'This item is shared by everyone; only the person who paid or an organizer can change it'
          USING ERRCODE = '42501', HINT = 'forbidden';
      END IF;
      SELECT coalesce(array_agg(DISTINCT cl.user_id ORDER BY cl.user_id), ARRAY[]::uuid[]) INTO v_existing
      FROM public.expense_item_claims cl WHERE cl.line_item_id = v_line AND cl.source <> 'leftover';
      IF NOT (
        (v_users <@ (v_existing || v_uid) AND (v_existing || v_uid) <@ v_users)
        OR (v_uid = ANY (v_existing) AND NOT (v_uid = ANY (v_users))
            AND v_users <@ v_existing AND ARRAY(SELECT x FROM unnest(v_existing) AS x WHERE x <> v_uid) <@ v_users)
      ) THEN
        RAISE EXCEPTION 'You can add yourself to an item or take yourself off it; only the person who paid or an organizer can change who else is on it'
          USING ERRCODE = '42501', HINT = 'forbidden';
      END IF;
      IF EXISTS (SELECT 1 FROM unnest(v_existing) AS x WHERE x <> v_uid) THEN
        v_k := cardinality(v_existing);
        SELECT count(*) = v_k
               AND coalesce(array_agg(round(cl.quantity_claimed * 100)::bigint ORDER BY cl.user_id), ARRAY[]::bigint[])
                   = public._receipt_even_split(round(v_li.quantity * 100)::bigint, v_k)
               AND coalesce(array_agg(round(cl.amount_owed * v_pw)::bigint ORDER BY cl.user_id), ARRAY[]::bigint[])
                   = public._receipt_even_split(round(v_li.total_amount * v_pw)::bigint, v_k)
          INTO v_equal
        FROM public.expense_item_claims cl WHERE cl.line_item_id = v_line AND cl.source <> 'leftover';
        IF NOT coalesce(v_equal, false) THEN
          RAISE EXCEPTION 'Someone has claimed part of this item on their own (for example 2 of 3). Ask the person who paid or an organizer to change it'
            USING ERRCODE = '42501', HINT = 'forbidden';
        END IF;
      END IF;
    END IF;

    -- Who recorded each person's current row (kept for people who stay on the line, so re-splitting never turns somebody's own
    -- claim into "put down by <someone else>"; a legacy row without a recorder counts as the person's own).
    SELECT coalesce(jsonb_object_agg(x.user_id::text, to_jsonb(coalesce(x.cb, x.user_id))), '{}'::jsonb) INTO v_prev_cb
    FROM (SELECT DISTINCT ON (cl.user_id) cl.user_id, cl.created_by AS cb
          FROM public.expense_item_claims cl WHERE cl.line_item_id = v_line AND cl.source <> 'leftover'
          ORDER BY cl.user_id, cl.claimed_at, cl.id) x;

    -- Replace every claim on this line (any source: own, direct multi-unit rows, leftovers), then write the new split.
    DELETE FROM public.expense_item_claims WHERE line_item_id = v_line;
    IF v_is_manager AND v_li.shared_by_all IS DISTINCT FROM v_all THEN
      UPDATE public.expense_line_items SET shared_by_all = v_all WHERE id = v_line;
    END IF;

    v_k := coalesce(cardinality(v_users), 0);
    IF v_k = 0 THEN
      v_unassigned := v_unassigned + 1;
      CONTINUE;
    END IF;
    v_assigned := v_assigned + 1;
    v_qs := public._receipt_even_split(round(v_li.quantity * 100)::bigint, v_k);
    v_as := public._receipt_even_split(round(v_li.total_amount * v_pw)::bigint, v_k);
    FOR i IN 1..v_k LOOP
      INSERT INTO public.expense_item_claims
        (line_item_id, user_id, expense_id, quantity_claimed, amount_owed, source, created_by)
      VALUES (
        v_line, v_users[i], p_expense_id,
        v_qs[i]::numeric / 100,
        v_as[i]::numeric / v_pw,
        CASE WHEN v_users[i] = v_uid THEN (CASE WHEN v_is_manager OR v_k = 1 THEN 'self' ELSE 'shared' END)
             WHEN v_k = 1 THEN 'on_behalf' ELSE 'shared' END,
        CASE WHEN v_prev_cb ? v_users[i]::text THEN (v_prev_cb ->> v_users[i]::text)::uuid ELSE v_uid END
      );
      v_rows := v_rows + 1;
    END LOOP;
  END LOOP;

  v_status := public._receipt_refresh_status(p_expense_id);

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'line_item_id', l.line_item_id,
           'shared_by_all', li.shared_by_all,
           'total', round(l.total_minor::numeric / v_pw, v_exp_digits),
           'quantity', li.quantity,
           'claimed_total', round(l.claimed_minor::numeric / v_pw, v_exp_digits),
           'unclaimed', round(l.remaining_minor::numeric / v_pw, v_exp_digits),
           'people', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                         'user_id', cl.user_id, 'quantity', cl.quantity_claimed,
                         'amount', cl.amount_owed, 'source', cl.source) ORDER BY cl.user_id), '[]'::jsonb)
                      FROM public.expense_item_claims cl WHERE cl.line_item_id = l.line_item_id)
         ) ORDER BY l.line_number, l.line_item_id), '[]'::jsonb)
    INTO v_lines
  FROM public._receipt_lines(p_expense_id, true) l
  JOIN public.expense_line_items li ON li.id = l.line_item_id
  WHERE l.line_item_id = ANY (v_seen);

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'line_item_id', l.line_item_id,
           'unclaimed', round(l.remaining_minor::numeric / v_pw, v_exp_digits)
         ) ORDER BY l.line_number, l.line_item_id), '[]'::jsonb),
         coalesce(sum(l.remaining_minor), 0)
    INTO v_unclaimed_lines, v_unclaimed_minor
  FROM public._receipt_lines(p_expense_id, true) l
  WHERE l.remaining_minor > 0;
  v_unclaimed := round(v_unclaimed_minor::numeric / v_pw, v_exp_digits);

  INSERT INTO public.activity_feed (trip_id, actor, verb, entity, metadata)
  VALUES (
    v_exp.trip_id, v_uid, 'receipt_claims_set',
    jsonb_build_object('type', 'expense', 'id', p_expense_id, 'label', v_exp.description),
    jsonb_build_object('lines_assigned', v_assigned, 'lines_unassigned', v_unassigned, 'rows', v_rows)
  );

  RETURN jsonb_build_object(
    'expense_id', p_expense_id,
    'currency', v_exp.currency,
    'status', v_status,
    'lines', v_lines,
    'unclaimed_total', v_unclaimed,
    'unclaimed_lines', v_unclaimed_lines,
    'rows_written', v_rows
  );
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- share_receipt_leftovers
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.share_receipt_leftovers(
  p_expense_id uuid,
  p_mode text,
  p_user_id uuid DEFAULT NULL,
  p_preview boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_exp public.expenses;
  v_mode text := lower(btrim(coalesce(p_mode, '')));
  v_target uuid := p_user_id;
  v_tagged uuid[];
  v_conf uuid[] := ARRAY[]::uuid[];
  v_pw numeric;
  v_digits integer;
  v_left bigint;
  v_people uuid[] := ARRAY[]::uuid[];
  v_amts bigint[] := ARRAY[]::bigint[];
  v_dist jsonb := '[]'::jsonb;
  v_rows integer := 0;
  v_stale integer := 0;
  v_status text;
  v_lines jsonb;
  v_people_json jsonb;
  v_even bigint;
  v_preview boolean := coalesce(p_preview, false);
  v_disc jsonb := '[]'::jsonb;
  v_dl record;
  v_ds bigint[];
  v_dq bigint[];
  v_n integer;
  v_has_rows boolean;
  i integer;
BEGIN
  v_exp := public._receipt_begin(p_expense_id, true);
  v_tagged := public._receipt_tagged(p_expense_id);
  v_pw := power(10::numeric, public.currency_exponent(v_exp.currency));
  v_digits := public.currency_exponent(v_exp.currency);

  IF v_mode = 'same' THEN
    -- The mode is stored on the expense by this function (expenses.leftover_mode / leftover_user_id; clients cannot write them).
    -- activity_feed is NOT trusted: any participant can insert rows there.
    IF v_exp.leftover_mode IS NULL THEN
      RAISE EXCEPTION 'Nothing to repeat: leftovers were never shared on this receipt' USING ERRCODE = '22023', HINT = 'no_history';
    END IF;
    v_mode := v_exp.leftover_mode;
    v_target := v_exp.leftover_user_id;
  END IF;
  IF v_mode = 'default' THEN
    v_mode := 'everyone';
  END IF;
  IF v_mode NOT IN ('everyone', 'person', 'payer') THEN
    RAISE EXCEPTION 'Unknown mode: use everyone, person, payer or same' USING ERRCODE = '22023', HINT = 'bad_input';
  END IF;
  IF v_mode = 'person' THEN
    IF v_target IS NULL THEN
      RAISE EXCEPTION 'Choose who covers the leftovers' USING ERRCODE = '22023', HINT = 'bad_input';
    END IF;
    IF NOT (v_target = ANY (v_tagged)) THEN
      RAISE EXCEPTION 'That person isn''t on this receipt' USING ERRCODE = '22023', HINT = 'not_tagged';
    END IF;
  END IF;

  SELECT coalesce(sum(l.remaining_minor), 0) INTO v_left FROM public._receipt_lines(p_expense_id, false) l;
  v_even := CASE WHEN coalesce(cardinality(v_tagged), 0) > 0
                 THEN greatest(0, floor(round(v_exp.amount * v_pw) / cardinality(v_tagged)))::bigint ELSE 0 END;

  -- Open discount lines (negative total, nobody holds a row): shared equally between everyone tagged, in every mode.
  v_n := coalesce(cardinality(v_tagged), 0);
  IF v_n > 0 THEN
    FOR v_dl IN
      SELECT li.id AS lid, round(li.total_amount * v_pw)::bigint AS tot, round(li.quantity * 100)::bigint AS qh
      FROM public.expense_line_items li
      WHERE li.expense_id = p_expense_id AND round(li.total_amount * v_pw) < 0
        AND NOT EXISTS (SELECT 1 FROM public.expense_item_claims cl WHERE cl.line_item_id = li.id AND cl.source <> 'leftover')
      ORDER BY li.line_number, li.id
    LOOP
      v_ds := public._receipt_even_split(v_dl.tot, v_n);
      v_dq := public._receipt_even_split(greatest(v_dl.qh, 0), v_n);
      FOR i IN 1..v_n LOOP
        IF v_ds[i] <> 0 OR v_dq[i] > 0 THEN
          v_disc := v_disc || jsonb_build_object('line_item_id', v_dl.lid, 'user_id', v_tagged[i], 'amount_minor', v_ds[i], 'qty_h', v_dq[i]);
        END IF;
      END LOOP;
    END LOOP;
  END IF;

  IF v_left > 0 THEN
    IF v_mode = 'everyone' THEN
      v_conf := public._receipt_leftover_confirmed(p_expense_id);
      SELECT array_agg(p.user_id ORDER BY p.user_id), array_agg(p.amount_minor ORDER BY p.user_id)
        INTO v_people, v_amts
      FROM public._receipt_leftover_plan(p_expense_id, v_conf) p;
    ELSIF v_mode = 'person' THEN
      v_people := ARRAY[v_target];
      v_amts := ARRAY[v_left];
    ELSE
      v_people := ARRAY[v_exp.paid_by];
      v_amts := ARRAY[v_left];
    END IF;
    SELECT coalesce(jsonb_agg(to_jsonb(d)), '[]'::jsonb) INTO v_dist
    FROM public._receipt_leftover_distribute(p_expense_id, v_people, v_amts) d;
  END IF;
  v_dist := v_dist || v_disc;

  IF NOT v_preview THEN
    -- Leftover rows are derived: always rebuild from scratch.
    DELETE FROM public.expense_item_claims WHERE expense_id = p_expense_id AND source = 'leftover';
    GET DIAGNOSTICS v_stale = ROW_COUNT;
    IF jsonb_array_length(v_dist) > 0 THEN
      BEGIN
        INSERT INTO public.expense_item_claims
          (line_item_id, user_id, expense_id, quantity_claimed, amount_owed, source, created_by)
        SELECT x.line_item_id, x.user_id, p_expense_id, x.qty_h::numeric / 100, x.amount_minor::numeric / v_pw, 'leftover', v_uid
        FROM jsonb_to_recordset(v_dist) AS x(line_item_id uuid, user_id uuid, amount_minor bigint, qty_h bigint);
        GET DIAGNOSTICS v_rows = ROW_COUNT;
      EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'The claims table does not allow two rows for one person on one line; see PRE_APPLY_CHECKS group 21'
          USING ERRCODE = 'XX000';
      END;
    END IF;
    v_status := public._receipt_refresh_status(p_expense_id);
    -- Remember how the leftovers were shared (read by mode 'same'); cleared when no leftover row remains on the receipt.
    SELECT EXISTS (SELECT 1 FROM public.expense_item_claims WHERE expense_id = p_expense_id AND source = 'leftover') INTO v_has_rows;
    UPDATE public.expenses
       SET leftover_mode = CASE WHEN v_has_rows THEN v_mode ELSE NULL END,
           leftover_user_id = CASE WHEN v_has_rows AND v_mode = 'person' THEN v_target ELSE NULL END
     WHERE id = p_expense_id
       AND (leftover_mode IS DISTINCT FROM CASE WHEN v_has_rows THEN v_mode ELSE NULL END
            OR leftover_user_id IS DISTINCT FROM CASE WHEN v_has_rows AND v_mode = 'person' THEN v_target ELSE NULL END);
  ELSE
    v_status := v_exp.status::text;
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'user_id', q.uid,
           'amount', round(q.amt::numeric / v_pw, v_digits),
           'already_claimed', round(coalesce(c.m, 0) / v_pw, v_digits),
           'total_after', round((coalesce(c.m, 0) + q.amt) / v_pw, v_digits)
         ) ORDER BY q.uid), '[]'::jsonb)
    INTO v_people_json
  FROM (
    SELECT x.user_id AS uid, sum(x.amount_minor) AS amt
    FROM jsonb_to_recordset(v_dist) AS x(line_item_id uuid, user_id uuid, amount_minor bigint, qty_h bigint)
    GROUP BY x.user_id
  ) q
  LEFT JOIN LATERAL (
    SELECT sum(round(cl.amount_owed * v_pw)) AS m FROM public.expense_item_claims cl
    WHERE cl.expense_id = p_expense_id AND cl.user_id = q.uid AND cl.source <> 'leftover'
  ) c ON true;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'line_item_id', l.line_item_id,
           'unclaimed', round(l.remaining_minor::numeric / v_pw, v_digits),
           'allocations', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                             'user_id', x.user_id, 'amount', round(x.amount_minor::numeric / v_pw, v_digits),
                             'quantity', x.qty_h::numeric / 100) ORDER BY x.user_id), '[]'::jsonb)
                           FROM jsonb_to_recordset(v_dist) AS x(line_item_id uuid, user_id uuid, amount_minor bigint, qty_h bigint)
                           WHERE x.line_item_id = l.line_item_id)
         ) ORDER BY l.line_number, l.line_item_id), '[]'::jsonb)
    INTO v_lines
  FROM public._receipt_lines(p_expense_id, false) l
  WHERE l.remaining_minor > 0;

  IF NOT v_preview AND (v_left > 0 OR v_stale > 0 OR jsonb_array_length(v_disc) > 0) THEN
    INSERT INTO public.activity_feed (trip_id, actor, verb, entity, metadata)
    VALUES (
      v_exp.trip_id, v_uid, 'receipt_leftovers_shared',
      jsonb_build_object('type', 'expense', 'id', p_expense_id, 'label', v_exp.description),
      jsonb_build_object(
        'mode', v_mode,
        'user_id', CASE WHEN v_mode = 'person' THEN v_target ELSE NULL END,
        'total', round(v_left::numeric / v_pw, v_digits),
        'people', v_people_json
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'expense_id', p_expense_id,
    'mode', v_mode,
    'preview', v_preview,
    'currency', v_exp.currency,
    'unclaimed_total', round(v_left::numeric / v_pw, v_digits),
    'allocated_total', round(coalesce((SELECT sum(x.amount_minor) FROM jsonb_to_recordset(v_dist)
                              AS x(line_item_id uuid, user_id uuid, amount_minor bigint, qty_h bigint)), 0)::numeric / v_pw, v_digits),
    'discount_total', round(coalesce((SELECT sum(x.amount_minor) FROM jsonb_to_recordset(v_disc)
                              AS x(line_item_id uuid, user_id uuid, amount_minor bigint, qty_h bigint)), 0)::numeric / v_pw, v_digits),
    'even_share', round(v_even::numeric / v_pw, v_digits),
    'confirmed_user_ids', to_jsonb(v_conf),
    'people', v_people_json,
    'lines', v_lines,
    'rows_written', v_rows,
    'status', v_status
  );
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- freeze_settlements: identical to 20261118100000 except for the one guard block (see markers).
-- ---------------------------------------------------------------------------------------------------------------------
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

  -- >>> unclaimed_receipts guard (receipt_claims_v2): never freeze over unclaimed value, or over-claimed lines, on an itemised receipt.
  --     DETAIL is a JSON array of {id, description, unclaimed_minor | overclaimed_minor} (up to 20) so the client can open its dialog from it.
  DECLARE
    v_unclaimed_receipts integer;
    v_overclaimed_receipts integer;
    v_receipt_detail text;
  BEGIN
    SELECT count(*) INTO v_unclaimed_receipts FROM public._trip_unclaimed_receipts(p_trip_id);
    IF v_unclaimed_receipts > 0 THEN
      SELECT coalesce(jsonb_agg(jsonb_build_object('id', r.expense_id, 'description', r.description, 'unclaimed_minor', r.unclaimed_minor)
                                ORDER BY r.unclaimed_minor DESC, r.description, r.expense_id), '[]'::jsonb)::text
        INTO v_receipt_detail
      FROM (SELECT u.* FROM public._trip_unclaimed_receipts(p_trip_id) u ORDER BY u.unclaimed_minor DESC, u.description, u.expense_id LIMIT 20) r;
      RAISE EXCEPTION '% % still % unclaimed items. Share or assign the leftovers first, then freeze.',
        v_unclaimed_receipts,
        CASE WHEN v_unclaimed_receipts = 1 THEN 'receipt' ELSE 'receipts' END,
        CASE WHEN v_unclaimed_receipts = 1 THEN 'has' ELSE 'have' END
        USING ERRCODE = 'P0001', HINT = 'unclaimed_receipts', DETAIL = v_receipt_detail;
    END IF;
    SELECT count(*) INTO v_overclaimed_receipts FROM public._trip_overclaimed_receipts(p_trip_id);
    IF v_overclaimed_receipts > 0 THEN
      SELECT coalesce(jsonb_agg(jsonb_build_object('id', r.expense_id, 'description', r.description, 'overclaimed_minor', r.overclaimed_minor)
                                ORDER BY r.overclaimed_minor DESC, r.description, r.expense_id), '[]'::jsonb)::text
        INTO v_receipt_detail
      FROM (SELECT o.* FROM public._trip_overclaimed_receipts(p_trip_id) o ORDER BY o.overclaimed_minor DESC, o.description, o.expense_id LIMIT 20) r;
      RAISE EXCEPTION '% % more claimed on an item than it is worth. Share the leftovers again or fix who had what on % first, then freeze.',
        v_overclaimed_receipts,
        CASE WHEN v_overclaimed_receipts = 1 THEN 'receipt has' ELSE 'receipts have' END,
        CASE WHEN v_overclaimed_receipts = 1 THEN 'it' ELSE 'them' END
        USING ERRCODE = 'P0001', HINT = 'overclaimed_receipts', DETAIL = v_receipt_detail;
    END IF;
  END;
  -- <<< unclaimed_receipts guard

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

-- ---------------------------------------------------------------------------------------------------------------------
-- Client-write protection
-- ---------------------------------------------------------------------------------------------------------------------
-- "Ordinary client" = the PostgREST roles authenticated / anon. The SECURITY DEFINER RPCs run as the function OWNER (current_user is the
-- owner inside a definer function, not the caller's role), and the service role is neither, so none of them are affected.

-- A client cannot choose the provenance of a claim row: source is forced to 'self' and created_by to the caller on INSERT, and both are
-- frozen on UPDATE. (Otherwise a person could mark their own claim 'leftover' to have it dumped on the table, or pose as "put down by <payer>".)
CREATE OR REPLACE FUNCTION public.guard_claim_provenance()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' THEN
      NEW.source := 'self';
      NEW.created_by := auth.uid();
    ELSE
      NEW.source := OLD.source;
      NEW.created_by := OLD.created_by;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS trg_guard_claim_provenance ON public.expense_item_claims;
CREATE TRIGGER trg_guard_claim_provenance BEFORE INSERT OR UPDATE ON public.expense_item_claims
  FOR EACH ROW EXECUTE FUNCTION public.guard_claim_provenance();

-- A client write is refused only when THE WRITE ITSELF takes a line's claimed quantity over its limit. The limit is quantity + 0.011 (the
-- shared dust tolerance) + 0.01 per OTHER claim row on the line (each row is rounded to hundredths, so legacy lines such as 0.17 x 6 = 1.02 or
-- 0.34 x 3 of a quantity-1 line legitimately exceed it by a few hundredths). If the line is ALREADY over that limit without this write
-- (legacy data), the write is allowed: an old cached client that deleted its rows and re-inserts them must never be refused after its delete
-- committed (that would lose the person's claims); the freeze guard's overclaimed_receipts report catches such lines. Lines with
-- quantity <= 0 (discount / zero lines) skip the check. Takes the same per-expense advisory lock the RPCs take, so a direct insert cannot
-- race set_receipt_claims. Derived 'leftover' rows count (they are real money on the line); re-run "Share leftovers" to rebuild them.
-- SECURITY INVOKER (default): it runs as the client, so authenticated needs EXECUTE on pg_advisory_xact_lock(bigint) and hashtextextended
-- (both are granted to PUBLIC by default; checked in PRE_APPLY_CHECKS 21n). The table reads it does are allowed by the claims policies.
CREATE OR REPLACE FUNCTION public.guard_claim_overclaim()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_qty numeric;
  v_expense uuid;
  v_sum numeric;
  v_rows bigint;
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF TG_OP = 'UPDATE' AND NEW.quantity_claimed IS NOT DISTINCT FROM OLD.quantity_claimed AND NEW.line_item_id = OLD.line_item_id THEN
      RETURN NEW;
    END IF;
    SELECT li.quantity, li.expense_id INTO v_qty, v_expense FROM public.expense_line_items li WHERE li.id = NEW.line_item_id;
    IF FOUND AND v_qty > 0 THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('receipt_claims:' || v_expense::text, 0));
      SELECT coalesce(sum(c.quantity_claimed), 0), count(*) INTO v_sum, v_rows
      FROM public.expense_item_claims c WHERE c.line_item_id = NEW.line_item_id AND c.id <> NEW.id;
      -- refuse only when the line was within its limit before this write and this write takes it over
      IF v_sum <= v_qty + 0.011 + 0.01 * v_rows
         AND v_sum + NEW.quantity_claimed > v_qty + 0.011 + 0.01 * v_rows THEN
        RAISE EXCEPTION 'There is not that much of this item left to claim' USING ERRCODE = 'P0001', HINT = 'overclaimed';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS trg_guard_claim_overclaim ON public.expense_item_claims;
CREATE TRIGGER trg_guard_claim_overclaim BEFORE INSERT OR UPDATE ON public.expense_item_claims
  FOR EACH ROW EXECUTE FUNCTION public.guard_claim_overclaim();

-- A client cannot write expenses.leftover_mode / leftover_user_id (only share_receipt_leftovers does): forced NULL on INSERT, frozen on
-- UPDATE. The existing guard_immutable_keys trigger (trip_id only) is left exactly as it is.
CREATE OR REPLACE FUNCTION public.guard_expense_leftover_mode()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' THEN
      NEW.leftover_mode := NULL;
      NEW.leftover_user_id := NULL;
    ELSE
      NEW.leftover_mode := OLD.leftover_mode;
      NEW.leftover_user_id := OLD.leftover_user_id;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS trg_guard_expense_leftover_mode ON public.expenses;
CREATE TRIGGER trg_guard_expense_leftover_mode BEFORE INSERT OR UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.guard_expense_leftover_mode();

-- ---------------------------------------------------------------------------------------------------------------------
-- refund_rate_limit: give back ONE token of an AI rate-limit bucket (parse-receipt, only when the model was never billed).
-- Service role only; capacity is passed by the (trusted) edge function.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refund_rate_limit(p_user_id uuid, p_feature text, p_capacity integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_user_id IS NULL OR p_feature IS NULL OR p_capacity IS NULL OR p_capacity < 1 THEN
    RETURN false;
  END IF;
  UPDATE public.rate_limits
     SET tokens = LEAST(p_capacity, tokens + 1)
   WHERE user_id = p_user_id AND feature = p_feature;
  RETURN FOUND;
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Privileges: helpers private; the two RPCs callable by signed-in users (they do their own permission checks).
-- ---------------------------------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public._receipt_even_split(bigint, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._receipt_tagged(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._receipt_lines(uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._trip_unclaimed_receipts(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._receipt_leftover_confirmed(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._receipt_begin(uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._receipt_refresh_status(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._receipt_leftover_plan(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._receipt_leftover_distribute(uuid, uuid[], bigint[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._trip_overclaimed_receipts(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_claim_provenance() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_claim_overclaim() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_expense_leftover_mode() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.refund_rate_limit(uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_rate_limit(uuid, text, integer) TO service_role;
REVOKE ALL ON FUNCTION public.set_receipt_claims(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.share_receipt_leftovers(uuid, text, uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.freeze_settlements(uuid, jsonb, jsonb, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_receipt_claims(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.share_receipt_leftovers(uuid, text, uuid, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.freeze_settlements(uuid, jsonb, jsonb, uuid[]) TO authenticated;

NOTIFY pgrst, 'reload schema';
