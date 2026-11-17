SET LOCAL lock_timeout = '5s';

-- Receipt claims v2, phase 2 (database): send a receipt "to the table" with a deadline, "That's everything" / "I wasn't there"
-- answers, the real leftover rule, personal no-login links, and the job that shares the leftovers at the deadline.
-- Builds on 20261124090000_receipt_claims_v2.sql (LIVE): set_receipt_claims, share_receipt_leftovers, _receipt_tagged,
-- _receipt_leftover_confirmed, _receipt_leftover_plan, the freeze guard and the provenance / over-claim triggers.
--
-- ADDITIVE AND RE-RUNNABLE: ADD COLUMN IF NOT EXISTS, CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE for every function, DROP POLICY /
-- DROP TRIGGER IF EXISTS + CREATE for the NEW policies and triggers, idempotent REVOKE/GRANT. No existing table, policy or trigger is
-- dropped or changed. Two EXISTING functions are replaced: _receipt_tagged and _receipt_leftover_confirmed (see "THE RULE"). The front
-- end and edge functions fail soft until this is applied.
--
-- WHAT IT ADDS
--   expenses.claim_deadline   timestamptz NULL   when claiming closes; set by send_receipt_to_table (default below)
--   expenses.claims_sent_at   timestamptz NULL   when the payer sent the receipt "to the table" (the claim to-do appears from here)
--   expenses.claims_closed_at timestamptz NULL   when the deadline was applied (leftovers shared); the receipt is then read-only for links
--   trips.receipt_notices_enabled boolean NOT NULL DEFAULT true   per-trip opt-out for receipt emails (separate from chase_settings)
--   expense_claim_responses(expense_id, user_id, response 'done'|'not_there', responded_at)  PK (expense_id, user_id), RLS on
--   receipt_claim_tokens, receipt_claim_rate_limits  (RLS on, NO policies; service role only)
--   send_receipt_to_table(uuid, timestamptz default null) -> jsonb      payer / manager (authenticated)
--   extend_receipt_deadline(uuid, timestamptz)            -> jsonb      payer / manager (authenticated)
--   apply_receipt_deadline(uuid)                          -> jsonb      payer / manager early ("Share now"), or the SERVICE ROLE (daily job)
--   issue_receipt_claim_token(uuid, uuid, text)           -> jsonb      service role only
--   receipt_claim_peek(text)                              -> jsonb      service role only (read-only)
--   receipt_claim_act(text, text, jsonb)                  -> jsonb      service role only
--   receipt_claim_rate_hit(text, integer, integer)        -> boolean    service role only
--   reitemize_expense(uuid, jsonb, jsonb, boolean) -> jsonb   payer / manager (authenticated); see its own comment block
--   unfreeze_settlements(uuid)                             CREATE OR REPLACE, strict superset of 20261118100000: also deletes the trip's stale 'suggested' payments
--   respond_to_receipt(uuid, text)                        -> jsonb      'done' | 'not_there' | 'undo' through the standard lock order (use instead of direct table writes)
--   reopen_receipt_claims(uuid, timestamptz)              -> jsonb      payer / manager: the way back from a closed receipt (closed receipts are final for claim edits otherwise)
--   apply_receipt_deadline(uuid, boolean default false): the boolean is a PREVIEW (rolled-back sub-transaction)
--   _receipt_begin(uuid, boolean)                         CREATE OR REPLACE: the phase-1 body plus ONE block (set_receipt_claims refuses a closed receipt, hint claims_closed)
--   triggers: trg_after_claim_response (re-split table items / re-share leftovers when "I wasn't there" changes), trg_clear_done_on_claim_change (someone else changed your items:
--             your "done" goes), trg_guard_claim_closed (old clients cannot touch a closed receipt's claims)
--   triggers: trg_guard_claim_response on expense_claim_responses, trg_guard_expense_claim_state on expenses
--   private helpers: _expense_trip_member, _receipt_response_state, _receipt_can_toggle, _receipt_claim_view, _receipt_token_lookup,
--                    _receipt_token_name, _receipt_default_deadline
--
-- THE RULE (proposal 2d), now with the real "confirmed" set:
--   T = people on the receipt (_receipt_tagged) MINUS anyone who answered "I wasn't there" (unless they are the payer or hold a claim of
--   their own: see below); n = |T|; even share F = floor(Total / n); U = the people in T who have NOT answered "That's everything"
--   (response 'done'); the plan is _receipt_leftover_plan, unchanged from phase 1:
--     1. split L equally across U, nobody above room_u = max(0, F - own claimed_u) (water-filling);  2. whatever is left (U empty, or
--     everyone in U at their cap) is split equally across all of T;  3. pennies by largest remainder, ties by user_id.
--   _receipt_leftover_confirmed now returns the 'done' people who are in T (and EVERYONE in T when the receipt was never sent to the table: see there). Consequences worth knowing:
--     * nobody answered      -> U = T: water-filling over everyone (people who claimed less than the even share take the leftovers up to it).
--                               With equal claims that IS an equal split of the leftovers; with unequal claims it is NOT (this is the rule
--                               the proposal states; "equal split among everyone" happens only when everyone confirmed).
--     * everybody confirmed  -> U empty: the whole leftover is split equally across T (step 2).
--     * every unconfirmed person already at or above the even share -> they receive nothing; step 2 shares it across T.
--   Phase-1 'everyone' shares that already exist keep their rows until someone re-runs 'same' (or the deadline job applies); the next run
--   uses this rule.
--
-- "I WASN'T THERE" ('not_there'):
--   * the payer can never be 'not_there' (hint payer_not_there);
--   * a person who holds a claim of their OWN on the receipt (quantity beyond the derived leftover part) cannot answer 'not_there'
--     (hint has_claims): they must take themselves off their items first. This is REJECTED, not cleared, so nobody's claims disappear
--     because of a stray tap;
--   * a 'not_there' person is NOT tagged (_receipt_tagged): they receive no leftovers, cannot be put on lines by the payer and do not
--     count in n. If they later DO hold an own claim anyway (a stale row), they ARE tagged again and the stale response is ignored by
--     the rule. Changing their mind: answering 'done' (or deleting the response) puts them back; the link's 'toggle' action clears a
--     'not_there' response by itself before adding them to a line.
--
-- LINKS (receipt_claim_tokens), on the payment-confirm pattern: only the SHA-256 hex of the token is stored; a link is for ONE receipt and
--   ONE person; it can be used many times (view + adjust) until the deadline passes, the leftovers are applied (claims_closed_at) or the
--   trip is frozen; after that it still shows the current truth, read-only, until it expires (deadline + 7 days; moved whenever the deadline is
--   extended, shortened or the receipt is reopened).
--   It can: say "That's everything", say "I wasn't there", undo the answer, add/remove THE PERSON THEMSELVES on a line (never anyone
--   else, never a table item, never a line where somebody holds a part that is not an exact equal split: _receipt_can_toggle, applied
--   even if the person is a manager). It cannot: see other people's amounts (only first names of co-claimers), change the deadline,
--   share leftovers, or touch any other receipt. Token problems are RETURNED as {result: ...}, never raised.
--
-- GROUND TRUTH THIS RELIES ON (live-checks-receipts.md, live-apply-receipts.md, live-checks-paid-email.md; PRE_APPLY group 22):
--   * expense_item_claims UNIQUE (line_item_id, user_id), CHECK quantity_claimed > 0; leftover_quantity / leftover_amount exist (phase 1);
--   * auth.uid() / auth.role() read request.jwt.claim.sub / request.jwt.claims (the impersonation below works only because they do);
--   * activity_feed accepts a NULL actor, a participant can only write themselves as actor (these functions are SECURITY DEFINER);
--   * notifications(trip_id, user_id, kind, dedupe_key UNIQUE, ...): written by the EDGE FUNCTIONS, never by this file;
--   * the trip has NO timezone column: the default deadline is 18:00 UTC, 3 days out (that is 18:00 Europe/London in winter, 19:00 BST).
--
-- LOCK ORDER everywhere (same as phase 1): the trip's freeze advisory lock, then the per-expense advisory lock, then rows.

ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS claim_deadline timestamptz NULL;
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS claims_sent_at timestamptz NULL;
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS claims_closed_at timestamptz NULL;
ALTER TABLE public.trips ADD COLUMN IF NOT EXISTS receipt_notices_enabled boolean NOT NULL DEFAULT true;

-- ---------------------------------------------------------------------------------------------------------------------
-- Responses: "That's everything I had" (done) / "I wasn't there" (not_there)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.expense_claim_responses (
  expense_id uuid NOT NULL REFERENCES public.expenses(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  response text NOT NULL CHECK (response IN ('done', 'not_there')),
  responded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (expense_id, user_id)
);
CREATE INDEX IF NOT EXISTS expense_claim_responses_user_idx ON public.expense_claim_responses (user_id);
ALTER TABLE public.expense_claim_responses ENABLE ROW LEVEL SECURITY;

-- Is this person on the trip the expense belongs to? INTERNAL ONLY (not executable by clients: it would be a membership oracle). The policies below use the live
-- is_trip_participant(trip_id, uid) helper that the existing expense policies already use.
CREATE OR REPLACE FUNCTION public._expense_trip_member(p_expense_id uuid, p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p_uid IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.expenses e
    JOIN public.trip_participants tp ON tp.trip_id = e.trip_id AND tp.user_id = p_uid
    WHERE e.id = p_expense_id)
$$;

DROP POLICY IF EXISTS "Trip members can view claim responses" ON public.expense_claim_responses;
CREATE POLICY "Trip members can view claim responses" ON public.expense_claim_responses
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.expenses e WHERE e.id = expense_id AND public.is_trip_participant(e.trip_id, auth.uid())));
DROP POLICY IF EXISTS "Users can add their own claim response" ON public.expense_claim_responses;
CREATE POLICY "Users can add their own claim response" ON public.expense_claim_responses
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND EXISTS (SELECT 1 FROM public.expenses e WHERE e.id = expense_id AND public.is_trip_participant(e.trip_id, auth.uid())));
DROP POLICY IF EXISTS "Users can change their own claim response" ON public.expense_claim_responses;
CREATE POLICY "Users can change their own claim response" ON public.expense_claim_responses
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid() AND EXISTS (SELECT 1 FROM public.expenses e WHERE e.id = expense_id AND public.is_trip_participant(e.trip_id, auth.uid())));
DROP POLICY IF EXISTS "Users can delete their own claim response" ON public.expense_claim_responses;
CREATE POLICY "Users can delete their own claim response" ON public.expense_claim_responses
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

REVOKE ALL ON public.expense_claim_responses FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.expense_claim_responses TO authenticated;
GRANT ALL ON public.expense_claim_responses TO service_role;

-- State the response guard needs (SECURITY DEFINER: the client may not be able to read everything it looks at). Booleans only.
-- NULL for a caller who is not on the trip, or when the expense is gone.
--   has_own_claims: a claim of their OWN on an ordinary line. Claims on TABLE items (shared_by_all) do not count: they are derived from who is on the
--   receipt and are re-split when the person says "I wasn't there" (trigger below).
--   holds_chosen_leftover: the payer explicitly gave ALL the leftovers to this person ('person' mode) and they hold leftover parts.
CREATE OR REPLACE FUNCTION public._receipt_response_state(p_expense_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_exp public.expenses;
  v_frozen boolean;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public._expense_trip_member(p_expense_id, auth.uid()) THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_exp FROM public.expenses WHERE id = p_expense_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT t.settlement_snapshot IS NOT NULL INTO v_frozen FROM public.trips t WHERE t.id = v_exp.trip_id;
  RETURN jsonb_build_object(
    'frozen', coalesce(v_frozen, false),
    'closed', v_exp.claims_closed_at IS NOT NULL,
    'deadline_passed', v_exp.claims_closed_at IS NULL AND v_exp.claims_sent_at IS NOT NULL AND v_exp.claim_deadline IS NOT NULL AND v_exp.claim_deadline <= now(),
    'is_payer', v_exp.paid_by = p_user_id,
    'has_own_claims', EXISTS (SELECT 1 FROM public.expense_item_claims cl JOIN public.expense_line_items li ON li.id = cl.line_item_id AND NOT li.shared_by_all
                              WHERE cl.expense_id = p_expense_id AND cl.user_id = p_user_id AND cl.quantity_claimed - cl.leftover_quantity > 0),
    'holds_chosen_leftover', v_exp.leftover_mode = 'person' AND v_exp.leftover_user_id = p_user_id
                             AND EXISTS (SELECT 1 FROM public.expense_item_claims cl WHERE cl.expense_id = p_expense_id AND cl.user_id = p_user_id
                                         AND (cl.leftover_quantity > 0 OR cl.leftover_amount > 0)));
END
$$;

-- Guard on responses. SECURITY INVOKER (like the phase-1 guards): "client" = current_user in (authenticated, anon).
--   everyone (clients, the link functions, the service role): the payer cannot be 'not_there' (payer_not_there); a person with a claim of their own on an
--   ordinary line cannot (has_claims); the person the payer explicitly gave the leftovers to cannot while they hold them (has_leftovers); the key columns
--   never change.
--   clients only: they first take the SAME locks everything else takes, in the SAME ORDER: (1) the trip's freeze advisory lock, (2) the per-expense lock
--   'receipt_claims:<expense>', (3) rows. So an in-app answer serialises with apply_receipt_deadline / receipt_claim_act / reitemize_expense and can never be accepted
--   and then ignored. Then: no write while balances are frozen (frozen), after the leftovers were applied (claims_closed) or after the deadline (deadline_passed:
--   the same refusal the links give); responded_at is always the server's now(). Locks are taken only for clients: the definer functions that write
--   responses already hold them.
CREATE OR REPLACE FUNCTION public.guard_claim_response()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.expense_claim_responses;
  v_state jsonb;
  v_trip uuid;
  v_client boolean := current_user IN ('authenticated', 'anon');
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.expense_id IS DISTINCT FROM OLD.expense_id OR NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
    RAISE EXCEPTION 'A response cannot be moved to another receipt or person' USING ERRCODE = 'P0001', HINT = 'bad_response';
  END IF;
  v_row := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  IF v_client THEN
    SELECT e.trip_id INTO v_trip FROM public.expenses e WHERE e.id = v_row.expense_id;
    IF v_trip IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('settlement_freeze:' || v_trip::text, 0));
      PERFORM pg_advisory_xact_lock(hashtextextended('receipt_claims:' || v_row.expense_id::text, 0));
    END IF;
  END IF;
  v_state := public._receipt_response_state(v_row.expense_id, v_row.user_id);
  IF TG_OP <> 'DELETE' THEN
    IF NEW.response = 'not_there' THEN
      IF coalesce((v_state ->> 'is_payer')::boolean, false) THEN
        RAISE EXCEPTION 'The person who paid is always on the receipt' USING ERRCODE = 'P0001', HINT = 'payer_not_there';
      END IF;
      IF coalesce((v_state ->> 'has_own_claims')::boolean, false) THEN
        RAISE EXCEPTION 'Take yourself off your items first, then say you weren''t there' USING ERRCODE = 'P0001', HINT = 'has_claims';
      END IF;
      IF coalesce((v_state ->> 'holds_chosen_leftover')::boolean, false) THEN
        RAISE EXCEPTION 'The person who paid gave the rest of this receipt to you; ask them to change that first' USING ERRCODE = 'P0001', HINT = 'has_leftovers';
      END IF;
    END IF;
  END IF;
  IF v_client THEN
    IF coalesce((v_state ->> 'frozen')::boolean, false) THEN
      RAISE EXCEPTION 'Balances are frozen for this trip. Ask an organizer to unfreeze before changing who had what.'
        USING ERRCODE = 'P0001', HINT = 'frozen';
    END IF;
    IF coalesce((v_state ->> 'closed')::boolean, false) THEN
      RAISE EXCEPTION 'The leftovers on this receipt have already been shared' USING ERRCODE = 'P0001', HINT = 'claims_closed';
    END IF;
    IF coalesce((v_state ->> 'deadline_passed')::boolean, false) THEN
      RAISE EXCEPTION 'The deadline for this receipt has passed' USING ERRCODE = 'P0001', HINT = 'deadline_passed';
    END IF;
    IF TG_OP <> 'DELETE' THEN
      NEW.responded_at := now();
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
DROP TRIGGER IF EXISTS trg_guard_claim_response ON public.expense_claim_responses;
CREATE TRIGGER trg_guard_claim_response BEFORE INSERT OR UPDATE OR DELETE ON public.expense_claim_responses
  FOR EACH ROW EXECUTE FUNCTION public.guard_claim_response();

-- A client cannot write the claim-state columns of an expense (only the functions below do): NULL on INSERT, frozen on UPDATE. Any
-- trip participant can update trip expenses under the live policies, so without this anybody could stretch or clear the deadline.
CREATE OR REPLACE FUNCTION public.guard_expense_claim_state()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    -- A CLOSED receipt (the leftovers were applied) is immutable for clients: what the ledger is built from cannot move behind the claims. Only reopen_receipt_claims
    -- (then the normal edit paths) lifts this. Description, category, receipt_url, vendor, date etc. stay editable; the definer functions are not clients.
    IF TG_OP = 'UPDATE' AND OLD.claims_closed_at IS NOT NULL
       AND (NEW.amount IS DISTINCT FROM OLD.amount OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.paid_by IS DISTINCT FROM OLD.paid_by
            OR NEW.participant_ids IS DISTINCT FROM OLD.participant_ids OR NEW.fx_rate IS DISTINCT FROM OLD.fx_rate
            OR NEW.base_currency_amount IS DISTINCT FROM OLD.base_currency_amount
            OR (coalesce(OLD.ai_parsed, false) AND NOT coalesce(NEW.ai_parsed, false))) THEN
      RAISE EXCEPTION 'The leftovers on this receipt have already been shared; ask the person who paid to reopen it' USING ERRCODE = 'P0001', HINT = 'claims_closed';
    END IF;
    IF TG_OP = 'INSERT' THEN
      NEW.claim_deadline := NULL;
      NEW.claims_sent_at := NULL;
      NEW.claims_closed_at := NULL;
    ELSE
      NEW.claim_deadline := OLD.claim_deadline;
      NEW.claims_sent_at := OLD.claims_sent_at;
      NEW.claims_closed_at := OLD.claims_closed_at;
    END IF;
  END IF;
  -- A sent receipt that is converted back to a PLAIN expense (ai_parsed true -> false) is no longer claimable: the claim state goes with it, for every writer.
  IF TG_OP = 'UPDATE' AND coalesce(OLD.ai_parsed, false) AND NOT coalesce(NEW.ai_parsed, false) THEN
    NEW.claim_deadline := NULL;
    NEW.claims_sent_at := NULL;
    NEW.claims_closed_at := NULL;
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS trg_guard_expense_claim_state ON public.expenses;
CREATE TRIGGER trg_guard_expense_claim_state BEFORE INSERT OR UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.guard_expense_claim_state();

-- ---------------------------------------------------------------------------------------------------------------------
-- Links: tokens and a rate-limit counter (RLS on, NO policies, service role only; the payment-confirm pattern)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.receipt_claim_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id uuid NOT NULL REFERENCES public.expenses(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '14 days'),
  used_at timestamptz   -- NOT "used once": set when the link is retired (superseded beyond the 5 newest per person and receipt)
);
ALTER TABLE public.receipt_claim_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.receipt_claim_tokens FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.receipt_claim_tokens TO service_role;
CREATE INDEX IF NOT EXISTS receipt_claim_tokens_expense_user_idx ON public.receipt_claim_tokens (expense_id, user_id);
CREATE INDEX IF NOT EXISTS receipt_claim_tokens_user_idx ON public.receipt_claim_tokens (user_id);

CREATE TABLE IF NOT EXISTS public.receipt_claim_rate_limits (
  key text PRIMARY KEY,
  window_start timestamptz NOT NULL DEFAULT now(),
  hits integer NOT NULL DEFAULT 0
);
ALTER TABLE public.receipt_claim_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.receipt_claim_rate_limits FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.receipt_claim_rate_limits TO service_role;

-- ---------------------------------------------------------------------------------------------------------------------
-- The rule: _receipt_tagged (minus 'not_there') and _receipt_leftover_confirmed (the 'done' people)
-- ---------------------------------------------------------------------------------------------------------------------
-- Identical to the phase-1 body except for the final WHERE: a person who answered 'not_there' is dropped unless they are the payer or hold a
-- claim of their own on an ORDINARY line (table items are derived and do not count for that). THE EXACT RULE (the app's people count must match it): a person is on the receipt iff
--   (explicit list) they are in the list and have a trip_participants row (declined / inactive people on an explicit list ARE on it: the list is only stored when the payer
--     changed the selection by hand), OR they hold an own claim on an ORDINARY line (+ trip_participants row);
--   (no list) they are an active in-scope participant (confirmation rules), OR hold ANY own claim incl. a table-item share (+ trip_participants row), OR are the payer;
--   minus 'not_there' responders, unless payer or holding an own claim on an ORDINARY line.
-- Table-item shares therefore move only on an explicit "I wasn't there", a list change by the payer (reitemize / header edit) or re-itemising; never because someone did not reply. (Phase-1 text: PRE_APPLY group 22 records its md5 so a changed live body is noticed.)
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
      -- Anyone who holds a claim of their OWN (quantity beyond the derived leftover part) on the receipt and has a trip_participants row is ALWAYS tagged, whether or not the receipt has an
      -- explicit list: a "No reply yet" person or someone who has since left must not be locked out of (or silently dropped from) their own claim.
      SELECT cl.user_id AS uid
      FROM public.expense_item_claims cl
      JOIN public.expense_line_items cli ON cli.id = cl.line_item_id
      JOIN public.expenses e ON e.id = cl.expense_id
      JOIN public.trip_participants tp ON tp.trip_id = e.trip_id AND tp.user_id = cl.user_id
      WHERE cl.expense_id = p_expense_id AND cl.quantity_claimed - cl.leftover_quantity > 0
        -- PHASE 2: a TABLE-item share (derived) keeps a person on the receipt only when the receipt has NO explicit list; with an explicit list, the list decides
        -- (the payer removing someone from the list is the explicit act that moves their table share). Not replying never changes anything.
        AND (NOT cli.shared_by_all OR coalesce(cardinality(e.participant_ids), 0) = 0)
      UNION
      -- The payer is always on a receipt that has no explicit list (with an explicit list, the list is exactly who the payer chose).
      SELECT e.paid_by AS uid
      FROM public.expenses e
      WHERE e.id = p_expense_id AND coalesce(cardinality(e.participant_ids), 0) = 0
  ) s
  WHERE NOT EXISTS (
    SELECT 1 FROM public.expense_claim_responses r
    WHERE r.expense_id = p_expense_id AND r.user_id = s.uid AND r.response = 'not_there'
      AND s.uid IS DISTINCT FROM (SELECT e2.paid_by FROM public.expenses e2 WHERE e2.id = p_expense_id)
      AND NOT EXISTS (SELECT 1 FROM public.expense_item_claims c2 JOIN public.expense_line_items l2 ON l2.id = c2.line_item_id AND NOT l2.shared_by_all
                      WHERE c2.expense_id = p_expense_id AND c2.user_id = s.uid AND c2.quantity_claimed - c2.leftover_quantity > 0))
$$;

-- People who said "That's everything" and are on the receipt, plus (once the receipt is sent) the payer. When nobody else did, everyone else is "not confirmed" and the plan
-- water-fills over them. A receipt that was NEVER SENT TO THE TABLE (claims_sent_at IS NULL) gave nobody the chance to answer, so there
-- NOBODY counts as confirmed in the sense of phase 1: the confirmed set is everyone on the receipt, which makes 'everyone' a plain equal split of
-- the leftovers across everyone tagged (exactly the phase-1 behaviour; parity-tested against the phase-1 definition).
CREATE OR REPLACE FUNCTION public._receipt_leftover_confirmed(p_expense_id uuid)
RETURNS uuid[]
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN (SELECT e.claims_sent_at IS NULL FROM public.expenses e WHERE e.id = p_expense_id) THEN public._receipt_tagged(p_expense_id)
    -- SENT: the people who said "That's everything" PLUS THE PAYER (they assigned their own items when sending; unclaimed items must stop landing on them). So leftovers
    -- go to the people who have not replied; if everyone incl. the payer is confirmed the plan's step 2 splits equally across everyone. An explicit choice of the payer
    -- (share mode 'payer', or 'person' = the payer) does not use this function and still wins.
    ELSE coalesce((SELECT array_agg(s.uid ORDER BY s.uid)
                   FROM (SELECT r.user_id AS uid FROM public.expense_claim_responses r WHERE r.expense_id = p_expense_id AND r.response = 'done'
                         UNION
                         SELECT e.paid_by FROM public.expenses e WHERE e.id = p_expense_id) s
                   WHERE s.uid = ANY (public._receipt_tagged(p_expense_id))), ARRAY[]::uuid[])
  END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Small helpers
-- ---------------------------------------------------------------------------------------------------------------------
-- Display name the way the app does it: first name, else the first word of the full name.
CREATE OR REPLACE FUNCTION public._receipt_token_name(p_user uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(nullif(btrim(u.first_name), ''), nullif(split_part(btrim(coalesce(u.full_name, '')), ' ', 1), ''), 'Someone')
  FROM public.users u WHERE u.id = p_user
$$;

-- Default deadline: 3 days out at 18:00 UTC (the trip has no timezone column; 18:00 UTC is 18:00 London in winter, 19:00 in summer).
CREATE OR REPLACE FUNCTION public._receipt_default_deadline()
RETURNS timestamptz
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT (date_trunc('day', now() AT TIME ZONE 'UTC') + interval '3 days' + interval '18 hours') AT TIME ZONE 'UTC'
$$;

-- May this person TOGGLE THEMSELVES on this line (add themselves if absent, take themselves off if present)? The same test set_receipt_claims
-- applies to an ordinary tagged person: not a table item, and nobody else on the line holds a part that is not an exact equal split of the line
-- (a direct "2 of 3 beers" or a legacy 0.33 share would be rewritten by re-splitting). The link functions apply it to EVERYONE, managers included.
CREATE OR REPLACE FUNCTION public._receipt_can_toggle(p_line_item_id uuid, p_uid uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_li public.expense_line_items;
  v_pw numeric;
  v_existing uuid[];
  v_k integer;
  v_equal boolean;
BEGIN
  SELECT * INTO v_li FROM public.expense_line_items WHERE id = p_line_item_id;
  IF NOT FOUND OR v_li.shared_by_all THEN
    RETURN false;
  END IF;
  SELECT power(10::numeric, public.currency_exponent(e.currency)) INTO v_pw FROM public.expenses e WHERE e.id = v_li.expense_id;
  SELECT coalesce(array_agg(DISTINCT cl.user_id ORDER BY cl.user_id), ARRAY[]::uuid[]) INTO v_existing
  FROM public.expense_item_claims cl WHERE cl.line_item_id = p_line_item_id AND cl.quantity_claimed - cl.leftover_quantity > 0;
  IF NOT EXISTS (SELECT 1 FROM unnest(v_existing) AS x WHERE x <> p_uid) THEN
    RETURN true;
  END IF;
  v_k := cardinality(v_existing);
  SELECT count(*) = v_k
         AND coalesce(array_agg(round((cl.quantity_claimed - cl.leftover_quantity) * 100)::bigint ORDER BY cl.user_id), ARRAY[]::bigint[])
             = public._receipt_even_split(round(v_li.quantity * 100)::bigint, v_k)
         AND coalesce(array_agg(round((cl.amount_owed - cl.leftover_amount) * v_pw)::bigint ORDER BY cl.user_id), ARRAY[]::bigint[])
             = public._receipt_even_split(round(v_li.total_amount * v_pw)::bigint, v_k)
    INTO v_equal
  FROM public.expense_item_claims cl WHERE cl.line_item_id = p_line_item_id AND cl.quantity_claimed - cl.leftover_quantity > 0;
  RETURN coalesce(v_equal, false);
END
$$;

-- What the personal page shows (also returned after every action). Read-only. NULL when the expense is gone.
CREATE OR REPLACE FUNCTION public._receipt_claim_view(p_expense_id uuid, p_uid uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_exp public.expenses;
  v_trip_name text;
  v_frozen boolean;
  v_notices boolean;
  v_pw numeric;
  v_digits integer;
  v_tagged uuid[];
  v_resp text;
  v_reason text;
  v_mine jsonb;
  v_avail jsonb;
  v_my_total numeric;
  v_my_left numeric;
  v_unclaimed_minor bigint;
BEGIN
  SELECT * INTO v_exp FROM public.expenses WHERE id = p_expense_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT t.name, t.settlement_snapshot IS NOT NULL, t.receipt_notices_enabled INTO v_trip_name, v_frozen, v_notices FROM public.trips t WHERE t.id = v_exp.trip_id;
  v_pw := power(10::numeric, public.currency_exponent(v_exp.currency));
  v_digits := public.currency_exponent(v_exp.currency);
  v_tagged := public._receipt_tagged(p_expense_id);
  SELECT r.response INTO v_resp FROM public.expense_claim_responses r WHERE r.expense_id = p_expense_id AND r.user_id = p_uid;
  v_reason := CASE
    WHEN NOT (coalesce(v_exp.ai_parsed, false) AND v_exp.status IS NOT NULL
              AND EXISTS (SELECT 1 FROM public.expense_line_items li WHERE li.expense_id = p_expense_id)) THEN 'not_itemised'
    WHEN coalesce(v_frozen, false) THEN 'frozen'
    WHEN v_exp.claims_closed_at IS NOT NULL THEN 'claims_closed'
    WHEN v_exp.claims_sent_at IS NULL THEN 'not_open'
    WHEN v_exp.claim_deadline IS NOT NULL AND v_exp.claim_deadline <= now() THEN 'deadline_passed'
    ELSE NULL END;

  SELECT coalesce(jsonb_agg(x.j ORDER BY x.ln, x.id), '[]'::jsonb) INTO v_mine
  FROM (
    SELECT li.line_number AS ln, li.id,
           jsonb_build_object(
             'line_item_id', li.id, 'line_number', li.line_number, 'name', li.name_original, 'name_english', li.name_english,
             'quantity', li.quantity, 'total', li.total_amount, 'shared_by_all', li.shared_by_all,
             'my_quantity', cl.quantity_claimed - cl.leftover_quantity, 'my_amount', cl.amount_owed - cl.leftover_amount,
             'leftover_amount', cl.leftover_amount,
             'others', CASE WHEN li.shared_by_all THEN '[]'::jsonb ELSE
                         (SELECT coalesce(jsonb_agg(public._receipt_token_name(o.user_id) ORDER BY o.user_id), '[]'::jsonb)
                          FROM public.expense_item_claims o
                          WHERE o.line_item_id = li.id AND o.user_id <> p_uid AND o.quantity_claimed - o.leftover_quantity > 0) END,
             'can_toggle', public._receipt_can_toggle(li.id, p_uid)) AS j
    FROM public.expense_line_items li
    JOIN public.expense_item_claims cl ON cl.line_item_id = li.id AND cl.user_id = p_uid
    WHERE li.expense_id = p_expense_id AND (cl.quantity_claimed - cl.leftover_quantity > 0 OR cl.leftover_amount > 0)
  ) x;

  SELECT coalesce(jsonb_agg(x.j ORDER BY x.ln, x.id), '[]'::jsonb) INTO v_avail
  FROM (
    SELECT li.line_number AS ln, li.id,
           jsonb_build_object(
             'line_item_id', li.id, 'line_number', li.line_number, 'name', li.name_original, 'name_english', li.name_english,
             'quantity', li.quantity, 'total', li.total_amount,
             'others', (SELECT coalesce(jsonb_agg(public._receipt_token_name(o.user_id) ORDER BY o.user_id), '[]'::jsonb)
                        FROM public.expense_item_claims o
                        WHERE o.line_item_id = li.id AND o.user_id <> p_uid AND o.quantity_claimed - o.leftover_quantity > 0)) AS j
    FROM public.expense_line_items li
    WHERE li.expense_id = p_expense_id AND li.total_amount > 0 AND NOT li.shared_by_all
      AND NOT EXISTS (SELECT 1 FROM public.expense_item_claims m
                      WHERE m.line_item_id = li.id AND m.user_id = p_uid AND m.quantity_claimed - m.leftover_quantity > 0)
      AND public._receipt_can_toggle(li.id, p_uid)
  ) x;

  SELECT coalesce(sum(cl.amount_owed), 0), coalesce(sum(cl.leftover_amount), 0) INTO v_my_total, v_my_left
  FROM public.expense_item_claims cl WHERE cl.expense_id = p_expense_id AND cl.user_id = p_uid;
  SELECT coalesce(sum(l.remaining_minor), 0) INTO v_unclaimed_minor FROM public._receipt_lines(p_expense_id, true) l;

  RETURN jsonb_build_object(
    'result', 'ok',
    'expense', jsonb_build_object(
      'id', v_exp.id, 'title', v_exp.description, 'currency', v_exp.currency, 'amount', v_exp.amount,
      'payer_id', v_exp.paid_by, 'payer_first_name', public._receipt_token_name(v_exp.paid_by),
      'trip_id', v_exp.trip_id, 'trip_name', v_trip_name),
    'me', jsonb_build_object('user_id', p_uid, 'first_name', public._receipt_token_name(p_uid), 'is_payer', v_exp.paid_by = p_uid),
    'on_receipt', p_uid = ANY (v_tagged),
    'response', v_resp,
    'deadline', v_exp.claim_deadline,
    'sent_at', v_exp.claims_sent_at,
    'closed_at', v_exp.claims_closed_at,
    'frozen', coalesce(v_frozen, false),
    'editable', v_reason IS NULL,
    'closed_reason', v_reason,
    'my_items', v_mine,
    'available_items', v_avail,
    'my_total', round(v_my_total, v_digits),
    'my_leftover_total', round(v_my_left, v_digits),
    'unclaimed_total', round(v_unclaimed_minor::numeric / v_pw, v_digits),
    'notices_enabled', coalesce(v_notices, true));
END
$$;

-- Token lookup shared by peek and act. Returns {result, expense_id, user_id}; result is ok | not_found | revoked | expired. A link also stops working ('revoked') when the
-- person has no trip_participants row, or is inactive / declined / cancelled AND not named in an explicit participant list (the list wins).
CREATE OR REPLACE FUNCTION public._receipt_token_lookup(p_hash text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  tok public.receipt_claim_tokens;
BEGIN
  IF p_hash IS NULL OR p_hash = '' THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;
  SELECT * INTO tok FROM public.receipt_claim_tokens t WHERE t.token_hash = p_hash;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;
  RETURN jsonb_build_object(
    'result', CASE WHEN tok.used_at IS NOT NULL THEN 'revoked'
                   WHEN NOT EXISTS (SELECT 1 FROM public.expenses e JOIN public.trip_participants tp ON tp.trip_id = e.trip_id AND tp.user_id = tok.user_id
                                    WHERE e.id = tok.expense_id
                                      AND ((coalesce(tp.active, true) AND coalesce(tp.confirmation_status::text, '') NOT IN ('declined', 'cancelled'))
                                           OR tok.user_id = ANY (coalesce(e.participant_ids, ARRAY[]::uuid[])))) THEN 'revoked'   -- an explicit list wins
                   WHEN tok.expires_at <= now() THEN 'expired' ELSE 'ok' END,
    'expense_id', tok.expense_id, 'user_id', tok.user_id);
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- send_receipt_to_table: the payer (or a manager) sends the receipt "to the table"
-- ---------------------------------------------------------------------------------------------------------------------
-- Signed-in users only (the service role has no business sending on someone's behalf). Sets claims_sent_at (once) and claim_deadline, and tells the caller WHO SHOULD BE NOTIFIED. It does NOT send email: the edge function
-- does, after this returns. Idempotent: a repeat call changes nothing (no new activity row) unless p_deadline is given and differs; it then
-- only moves the deadline. A repeat with no p_deadline after the deadline has passed is refused (hint deadline_passed): pick a new one.
-- DEDUPE: this function returns the whole eligible list (notify_user_ids) AND already_notified_user_ids (people with a 'table' notice for
-- this receipt in `notifications`, dedupe_key = 'notice:receipt:<expense>:<user>:table'); the edge function sends to the difference and
-- still writes the dedupe row BEFORE sending (the UNIQUE dedupe_key is the atomic guard), exactly like the payment notices.
-- notify_user_ids = everyone on the receipt (_receipt_tagged: the payer and the people in scope, minus 'I wasn't there') except the
-- caller and people who already said "That's everything". Empty when the trip switched receipt emails off.
CREATE OR REPLACE FUNCTION public.send_receipt_to_table(p_expense_id uuid, p_deadline timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_exp public.expenses;
  v_first boolean;
  v_old timestamptz;
  v_deadline timestamptz;
  v_changed boolean;
  v_tagged uuid[];
  v_notify uuid[];
  v_already uuid[];
  v_notices boolean;
  v_people jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501', HINT = 'auth';
  END IF;
  v_exp := public._receipt_begin(p_expense_id, true);
  IF v_exp.claims_closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'The leftovers on this receipt have already been shared' USING ERRCODE = 'P0001', HINT = 'claims_closed';
  END IF;
  IF p_deadline IS NOT NULL AND (p_deadline <= now() OR p_deadline > now() + interval '90 days') THEN
    RAISE EXCEPTION 'The deadline must be in the future, within 90 days' USING ERRCODE = '22023', HINT = 'bad_deadline';
  END IF;
  v_first := v_exp.claims_sent_at IS NULL;
  v_old := v_exp.claim_deadline;
  IF v_first THEN
    v_deadline := coalesce(p_deadline, public._receipt_default_deadline());
  ELSIF p_deadline IS NOT NULL THEN
    v_deadline := p_deadline;
  ELSE
    v_deadline := v_old;
    IF v_deadline IS NOT NULL AND v_deadline <= now() THEN
      RAISE EXCEPTION 'The deadline has passed; choose a new one' USING ERRCODE = 'P0001', HINT = 'deadline_passed';
    END IF;
  END IF;
  v_changed := v_first OR v_deadline IS DISTINCT FROM v_old;
  IF v_changed THEN
    UPDATE public.expenses SET claims_sent_at = coalesce(claims_sent_at, now()), claim_deadline = v_deadline WHERE id = p_expense_id
    RETURNING * INTO v_exp;
    PERFORM public._receipt_sync_token_expiry(p_expense_id);
    INSERT INTO public.activity_feed (trip_id, actor, verb, entity, metadata)
    VALUES (v_exp.trip_id, v_uid, CASE WHEN v_first THEN 'receipt_sent_to_table' ELSE 'receipt_deadline_set' END,
            jsonb_build_object('type', 'expense', 'id', p_expense_id, 'label', v_exp.description),
            jsonb_build_object('claim_deadline', v_deadline, 'previous_deadline', v_old, 'first_send', v_first));
  END IF;

  SELECT coalesce(t.receipt_notices_enabled, true) INTO v_notices FROM public.trips t WHERE t.id = v_exp.trip_id;
  v_tagged := public._receipt_tagged(p_expense_id);
  SELECT coalesce(array_agg(x ORDER BY x), ARRAY[]::uuid[]) INTO v_notify
  FROM unnest(v_tagged) AS x
  WHERE x IS DISTINCT FROM v_uid
    AND NOT EXISTS (SELECT 1 FROM public.expense_claim_responses r WHERE r.expense_id = p_expense_id AND r.user_id = x AND r.response = 'done');
  IF NOT v_notices THEN
    v_notify := ARRAY[]::uuid[];
  END IF;
  SELECT coalesce(array_agg(n.user_id ORDER BY n.user_id), ARRAY[]::uuid[]) INTO v_already
  FROM public.notifications n
  WHERE n.dedupe_key IN (SELECT 'notice:receipt:' || p_expense_id::text || ':' || x::text || ':table' FROM unnest(v_tagged) AS x);
  SELECT coalesce(jsonb_agg(jsonb_build_object('user_id', u.uid, 'claimed', coalesce(c.m, 0), 'assigned_by_other', coalesce(c.ab, false)) ORDER BY u.uid), '[]'::jsonb)
    INTO v_people
  FROM unnest(v_notify) AS u(uid)
  LEFT JOIN LATERAL (
    SELECT sum(cl.amount_owed - cl.leftover_amount) AS m, bool_or(cl.created_by IS NOT NULL AND cl.created_by <> u.uid) AS ab
    FROM public.expense_item_claims cl
    WHERE cl.expense_id = p_expense_id AND cl.user_id = u.uid AND cl.quantity_claimed - cl.leftover_quantity > 0) c ON true;

  RETURN jsonb_build_object(
    'expense_id', p_expense_id,
    'trip_id', v_exp.trip_id,
    'title', v_exp.description,
    'currency', v_exp.currency,
    'amount', v_exp.amount,
    'payer_id', v_exp.paid_by,
    'first_send', v_first,
    'changed', v_changed,
    'claims_sent_at', v_exp.claims_sent_at,
    'claim_deadline', v_exp.claim_deadline,
    'notices_enabled', v_notices,
    'notify_user_ids', to_jsonb(v_notify),
    'already_notified_user_ids', to_jsonb(v_already),
    'people', v_people);
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- extend_receipt_deadline: move the deadline (later or earlier) before the leftovers are applied
-- ---------------------------------------------------------------------------------------------------------------------
-- Payer or manager (signed in; not the service role). The receipt must have been sent (hint not_sent) and not be closed (hint closed). Returns the people who have not answered
-- yet (the edge function tells them, if notices are enabled): everyone on the receipt minus the caller minus anyone who answered.
CREATE OR REPLACE FUNCTION public.extend_receipt_deadline(p_expense_id uuid, p_deadline timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_exp public.expenses;
  v_old timestamptz;
  v_changed boolean;
  v_waiting uuid[];
  v_notices boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501', HINT = 'auth';
  END IF;
  v_exp := public._receipt_begin(p_expense_id, true);
  IF v_exp.claims_closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'The leftovers on this receipt have already been shared' USING ERRCODE = 'P0001', HINT = 'claims_closed';
  END IF;
  IF v_exp.claims_sent_at IS NULL THEN
    RAISE EXCEPTION 'This receipt has not been sent to the table yet' USING ERRCODE = 'P0001', HINT = 'not_sent';
  END IF;
  IF p_deadline IS NULL OR p_deadline <= now() OR p_deadline > now() + interval '90 days' THEN
    RAISE EXCEPTION 'The deadline must be in the future, within 90 days' USING ERRCODE = '22023', HINT = 'bad_deadline';
  END IF;
  v_old := v_exp.claim_deadline;
  v_changed := v_old IS DISTINCT FROM p_deadline;
  IF v_changed THEN
    UPDATE public.expenses SET claim_deadline = p_deadline WHERE id = p_expense_id RETURNING * INTO v_exp;
    PERFORM public._receipt_sync_token_expiry(p_expense_id);
    INSERT INTO public.activity_feed (trip_id, actor, verb, entity, metadata)
    VALUES (v_exp.trip_id, v_uid,
            CASE WHEN v_old IS NULL OR p_deadline > v_old THEN 'receipt_deadline_extended' ELSE 'receipt_deadline_shortened' END,
            jsonb_build_object('type', 'expense', 'id', p_expense_id, 'label', v_exp.description),
            jsonb_build_object('claim_deadline', p_deadline, 'previous_deadline', v_old));
  END IF;
  SELECT coalesce(t.receipt_notices_enabled, true) INTO v_notices FROM public.trips t WHERE t.id = v_exp.trip_id;
  SELECT coalesce(array_agg(x ORDER BY x), ARRAY[]::uuid[]) INTO v_waiting
  FROM unnest(public._receipt_tagged(p_expense_id)) AS x
  WHERE x IS DISTINCT FROM v_uid
    AND NOT EXISTS (SELECT 1 FROM public.expense_claim_responses r WHERE r.expense_id = p_expense_id AND r.user_id = x);
  RETURN jsonb_build_object(
    'expense_id', p_expense_id,
    'trip_id', v_exp.trip_id,
    'title', v_exp.description,
    'changed', v_changed,
    'claim_deadline', v_exp.claim_deadline,
    'previous_deadline', v_old,
    'notices_enabled', v_notices,
    'waiting_user_ids', CASE WHEN v_notices THEN to_jsonb(v_waiting) ELSE '[]'::jsonb END);
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- apply_receipt_deadline: share the leftovers by the rule and close the receipt
-- ---------------------------------------------------------------------------------------------------------------------
-- Callers: the payer or a manager ("Share now", at any time), or the SERVICE ROLE (the daily job: refused softly with {applied:false,
-- reason:'not_sent'|'not_due'} when the receipt was never sent or its deadline is still ahead). Refuses (RAISE, hint frozen) while the trip's
-- balances are frozen, like every claims write. A receipt that is no longer itemised returns {applied:false, skipped:'not_itemised'} quietly (the daily job
-- must not error every day on a receipt that was converted back to a plain expense). NEVER APPLIES TWICE: a second call returns
-- {applied:false, already_applied:true,...} with the per-person leftover amounts read back from the claims.
-- Before sharing it re-splits TABLE items over the people who are still on the receipt (so "I wasn't there" answers are honoured at the latest here), then shares in
-- the mode already used on this receipt ('same': a manual share by the payer), else 'everyone'; if the person the payer chose is no longer on the receipt it falls back
-- to 'everyone' (_receipt_reshare_mode). Then it stamps claims_closed_at.
-- p_preview = true runs the REAL path inside a sub-transaction that is rolled back: the answer is exactly who would get what ("Share the rest now" confirm),
-- nothing is written. people = [{user_id, amount, already_claimed, total_after}] as planned by share_receipt_leftovers; notify_user_ids = people charged
-- something, minus the caller, empty when the trip switched receipt emails off.
DROP FUNCTION IF EXISTS public.apply_receipt_deadline(uuid);
CREATE OR REPLACE FUNCTION public.apply_receipt_deadline(p_expense_id uuid, p_preview boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_service boolean := (auth.uid() IS NULL AND coalesce(auth.role(), '') = 'service_role');
  v_exp public.expenses;
  v_res jsonb;
  v_mode text;
  v_closed timestamptz;
  v_early boolean;
  v_notices boolean;
  v_notify jsonb;
  v_hint text;
  v_out jsonb;
  v_old_skip text;
BEGIN
  BEGIN
    v_exp := public._receipt_begin(p_expense_id, true);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    IF v_hint = 'not_itemised' THEN
      RETURN jsonb_build_object('applied', false, 'already_applied', false, 'skipped', 'not_itemised', 'expense_id', p_expense_id, 'preview', coalesce(p_preview, false));
    END IF;
    RAISE;
  END;
  SELECT coalesce(t.receipt_notices_enabled, true) INTO v_notices FROM public.trips t WHERE t.id = v_exp.trip_id;
  IF v_exp.claims_closed_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'applied', false, 'already_applied', true, 'expense_id', p_expense_id, 'trip_id', v_exp.trip_id, 'title', v_exp.description,
      'currency', v_exp.currency, 'closed_at', v_exp.claims_closed_at, 'notify_user_ids', '[]'::jsonb, 'notices_enabled', v_notices,
      'preview', coalesce(p_preview, false),
      'people', (SELECT coalesce(jsonb_agg(jsonb_build_object('user_id', x.uid, 'amount', x.amt) ORDER BY x.uid), '[]'::jsonb)
                 FROM (SELECT cl.user_id AS uid, sum(cl.leftover_amount) AS amt FROM public.expense_item_claims cl
                       WHERE cl.expense_id = p_expense_id GROUP BY cl.user_id HAVING sum(cl.leftover_amount) > 0) x));
  END IF;
  v_early := v_exp.claim_deadline IS NULL OR v_exp.claim_deadline > now();
  IF v_service AND (v_exp.claims_sent_at IS NULL OR v_early) THEN
    RETURN jsonb_build_object('applied', false, 'already_applied', false, 'expense_id', p_expense_id,
                              'reason', CASE WHEN v_exp.claims_sent_at IS NULL THEN 'not_sent' ELSE 'not_due' END,
                              'claim_deadline', v_exp.claim_deadline, 'preview', coalesce(p_preview, false));
  END IF;

  v_mode := public._receipt_reshare_mode(p_expense_id);
  BEGIN
    v_old_skip := current_setting('receipt.skip_done_clear', true);
    PERFORM set_config('receipt.skip_done_clear', 'on', true);
    PERFORM public._receipt_resplit_table_items(p_expense_id);
    v_res := public.share_receipt_leftovers(p_expense_id, v_mode);
    UPDATE public.expenses SET claims_closed_at = now() WHERE id = p_expense_id RETURNING claims_closed_at INTO v_closed;
    PERFORM set_config('receipt.skip_done_clear', coalesce(v_old_skip, ''), true);

    SELECT coalesce(jsonb_agg(p.value -> 'user_id'), '[]'::jsonb) INTO v_notify
    FROM jsonb_array_elements(coalesce(v_res -> 'people', '[]'::jsonb)) AS p(value)
    WHERE (p.value ->> 'amount')::numeric > 0 AND (p.value ->> 'user_id')::uuid IS DISTINCT FROM v_uid;

    INSERT INTO public.activity_feed (trip_id, actor, verb, entity, metadata)
    VALUES (v_exp.trip_id, v_uid, 'receipt_deadline_applied',
            jsonb_build_object('type', 'expense', 'id', p_expense_id, 'label', v_exp.description),
            jsonb_build_object('mode', v_res ->> 'mode', 'early', v_early, 'unclaimed_total', v_res -> 'unclaimed_total',
                               'people', v_res -> 'people', 'confirmed_user_ids', v_res -> 'confirmed_user_ids'));

    v_out := jsonb_build_object(
      'applied', true, 'already_applied', false, 'expense_id', p_expense_id, 'trip_id', v_exp.trip_id, 'title', v_exp.description,
      'currency', v_exp.currency, 'mode', v_res ->> 'mode', 'early', v_early, 'closed_at', v_closed, 'preview', coalesce(p_preview, false),
      'unclaimed_total', v_res -> 'unclaimed_total', 'kept_by_payer', v_res -> 'kept_by_payer', 'even_share', v_res -> 'even_share',
      'confirmed_user_ids', v_res -> 'confirmed_user_ids', 'people', v_res -> 'people',
      'leftover_user_id', (SELECT e.leftover_user_id FROM public.expenses e WHERE e.id = p_expense_id),
      'notices_enabled', v_notices, 'notify_user_ids', CASE WHEN v_notices THEN v_notify ELSE '[]'::jsonb END);
    IF coalesce(p_preview, false) THEN
      RAISE EXCEPTION 'preview rollback' USING ERRCODE = 'RB001';
    END IF;
  EXCEPTION WHEN SQLSTATE 'RB001' THEN
    NULL;   -- preview: everything above is rolled back (incl. the table-item re-split); v_out already holds the answer
  END;
  RETURN v_out;
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Links: issue / peek / act (service role only; the edge functions call these)
-- ---------------------------------------------------------------------------------------------------------------------
-- p_token_hash is the lowercase SHA-256 hex of the raw token (64 chars). A person keeps at most their 5 newest links per receipt (older ones
-- are retired with used_at, so a reminder email does not kill the first email's link until 5 have been sent).
CREATE OR REPLACE FUNCTION public.issue_receipt_claim_token(p_expense_id uuid, p_user_id uuid, p_token_hash text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_exp public.expenses;
  v_frozen boolean;
  v_exp_at timestamptz;
  v_id uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role only' USING ERRCODE = '42501';
  END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('result', 'bad_hash');
  END IF;
  SELECT * INTO v_exp FROM public.expenses WHERE id = p_expense_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;
  IF v_exp.claims_sent_at IS NULL THEN
    RETURN jsonb_build_object('result', 'not_sent');
  END IF;
  IF v_exp.claims_closed_at IS NOT NULL THEN
    RETURN jsonb_build_object('result', 'claims_closed');
  END IF;
  SELECT t.settlement_snapshot IS NOT NULL INTO v_frozen FROM public.trips t WHERE t.id = v_exp.trip_id;
  IF coalesce(v_frozen, false) THEN
    RETURN jsonb_build_object('result', 'frozen');
  END IF;
  IF NOT (p_user_id = ANY (public._receipt_tagged(p_expense_id)))
     AND NOT EXISTS (SELECT 1 FROM public.expense_claim_responses r WHERE r.expense_id = p_expense_id AND r.user_id = p_user_id) THEN
    RETURN jsonb_build_object('result', 'not_on_receipt');
  END IF;
  v_exp_at := greatest(now() + interval '1 hour', coalesce(v_exp.claim_deadline, now()) + interval '7 days');
  INSERT INTO public.receipt_claim_tokens (expense_id, user_id, token_hash, expires_at)
  VALUES (p_expense_id, p_user_id, p_token_hash, v_exp_at)
  RETURNING id INTO v_id;
  UPDATE public.receipt_claim_tokens t SET used_at = now()
   WHERE t.expense_id = p_expense_id AND t.user_id = p_user_id AND t.used_at IS NULL
     AND t.id NOT IN (SELECT t2.id FROM public.receipt_claim_tokens t2
                      WHERE t2.expense_id = p_expense_id AND t2.user_id = p_user_id AND t2.used_at IS NULL
                      ORDER BY t2.created_at DESC, t2.id DESC LIMIT 5);
  RETURN jsonb_build_object('result', 'issued', 'token_id', v_id, 'expires_at', v_exp_at, 'claim_deadline', v_exp.claim_deadline);
END
$$;

-- Read-only. {result: ok|not_found|revoked|expired} plus, for ok, the page payload built by _receipt_claim_view (see the interface note).
CREATE OR REPLACE FUNCTION public.receipt_claim_peek(p_token_hash text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_t jsonb;
  v_view jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role only' USING ERRCODE = '42501';
  END IF;
  v_t := public._receipt_token_lookup(p_token_hash);
  IF v_t ->> 'result' <> 'ok' THEN
    RETURN jsonb_build_object('result', v_t ->> 'result');
  END IF;
  v_view := public._receipt_claim_view((v_t ->> 'expense_id')::uuid, (v_t ->> 'user_id')::uuid);
  IF v_view IS NULL THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;
  RETURN v_view;
END
$$;

-- Actions: 'done' | 'not_there' | 'undo_done' | 'toggle' ({line_item_id, on?: boolean}). Returns
--   {result:'ok', action, changed, state:<peek payload>}  or  {result:'refused', reason, message, state}  or  {result: not_found|revoked|expired}.
-- reason: frozen | claims_closed | deadline_passed | not_open | not_itemised | not_on_receipt | payer | has_claims | has_leftovers | forbidden | too_many_sharers |
--   bad_action | bad_payload | bad_line | error.
-- Refused (not raised) once the deadline passed / the leftovers were applied / the trip is frozen. 'toggle' runs set_receipt_claims AS THE
-- LINK'S PERSON (impersonation, below) after _receipt_can_toggle; the whole action is one sub-transaction, so a refusal leaves nothing behind.
CREATE OR REPLACE FUNCTION public.receipt_claim_act(p_token_hash text, p_action text, p_payload jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_t jsonb;
  v_eid uuid;
  v_uid uuid;
  v_exp public.expenses;
  v_trip uuid;
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_reason text;
  v_cur text;
  v_changed boolean := false;
  v_line uuid;
  v_on boolean;
  v_existing uuid[];
  v_users uuid[];
  v_old_sub text;
  v_old_claims text;
  v_old_role text;
  v_hint text;
  v_msg text;
  v_state text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role only' USING ERRCODE = '42501';
  END IF;
  v_t := public._receipt_token_lookup(p_token_hash);
  IF v_t ->> 'result' <> 'ok' THEN
    RETURN jsonb_build_object('result', v_t ->> 'result');
  END IF;
  v_eid := (v_t ->> 'expense_id')::uuid;
  v_uid := (v_t ->> 'user_id')::uuid;
  IF v_action NOT IN ('done', 'not_there', 'undo_done', 'toggle') THEN
    RETURN jsonb_build_object('result', 'refused', 'reason', 'bad_action', 'message', 'Unknown action', 'state', public._receipt_claim_view(v_eid, v_uid));
  END IF;

  -- same lock order as the other writers: the trip's freeze lock, the expense lock, then rows
  SELECT e.trip_id INTO v_trip FROM public.expenses e WHERE e.id = v_eid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('settlement_freeze:' || v_trip::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('receipt_claims:' || v_eid::text, 0));
  SELECT * INTO v_exp FROM public.expenses WHERE id = v_eid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;

  v_reason := public._receipt_claim_view(v_eid, v_uid) ->> 'closed_reason';
  IF v_reason IS NOT NULL THEN
    RETURN jsonb_build_object('result', 'refused', 'reason', v_reason,
      'message', CASE v_reason
        WHEN 'frozen' THEN 'Balances are frozen for this trip'
        WHEN 'claims_closed' THEN 'The leftovers on this receipt have already been shared'
        WHEN 'deadline_passed' THEN 'The deadline for this receipt has passed'
        WHEN 'not_itemised' THEN 'This expense isn''t itemised'
        ELSE 'This receipt isn''t open for claims' END,
      'state', public._receipt_claim_view(v_eid, v_uid));
  END IF;

  SELECT r.response INTO v_cur FROM public.expense_claim_responses r WHERE r.expense_id = v_eid AND r.user_id = v_uid;

  IF v_action = 'done' THEN
    IF NOT (v_uid = ANY (public._receipt_tagged(v_eid))) AND v_cur IS DISTINCT FROM 'not_there' THEN
      RETURN jsonb_build_object('result', 'refused', 'reason', 'not_on_receipt', 'message', 'You are not on this receipt', 'state', public._receipt_claim_view(v_eid, v_uid));
    END IF;
    IF v_cur IS DISTINCT FROM 'done' THEN
      INSERT INTO public.expense_claim_responses (expense_id, user_id, response) VALUES (v_eid, v_uid, 'done')
      ON CONFLICT (expense_id, user_id) DO UPDATE SET response = 'done', responded_at = now();
      v_changed := true;
    END IF;

  ELSIF v_action = 'not_there' THEN
    IF v_exp.paid_by = v_uid THEN
      RETURN jsonb_build_object('result', 'refused', 'reason', 'payer', 'message', 'The person who paid is always on the receipt', 'state', public._receipt_claim_view(v_eid, v_uid));
    END IF;
    IF coalesce((public._receipt_response_state(v_eid, v_uid) ->> 'holds_chosen_leftover')::boolean, false) THEN
      RETURN jsonb_build_object('result', 'refused', 'reason', 'has_leftovers', 'message', 'The person who paid gave the rest of this receipt to you; ask them to change that first', 'state', public._receipt_claim_view(v_eid, v_uid));
    END IF;
    IF EXISTS (SELECT 1 FROM public.expense_item_claims cl JOIN public.expense_line_items li ON li.id = cl.line_item_id AND NOT li.shared_by_all
               WHERE cl.expense_id = v_eid AND cl.user_id = v_uid AND cl.quantity_claimed - cl.leftover_quantity > 0) THEN
      RETURN jsonb_build_object('result', 'refused', 'reason', 'has_claims', 'message', 'Take yourself off your items first, then say you weren''t there', 'state', public._receipt_claim_view(v_eid, v_uid));
    END IF;
    IF NOT (v_uid = ANY (public._receipt_tagged(v_eid))) AND v_cur IS NULL THEN
      RETURN jsonb_build_object('result', 'refused', 'reason', 'not_on_receipt', 'message', 'You are not on this receipt', 'state', public._receipt_claim_view(v_eid, v_uid));
    END IF;
    IF v_cur IS DISTINCT FROM 'not_there' THEN
      INSERT INTO public.expense_claim_responses (expense_id, user_id, response) VALUES (v_eid, v_uid, 'not_there')
      ON CONFLICT (expense_id, user_id) DO UPDATE SET response = 'not_there', responded_at = now();
      v_changed := true;
    END IF;

  ELSIF v_action = 'undo_done' THEN
    IF v_cur IS NOT NULL THEN
      DELETE FROM public.expense_claim_responses WHERE expense_id = v_eid AND user_id = v_uid;
      v_changed := true;
    END IF;

  ELSE  -- toggle
    IF jsonb_typeof(v_payload) <> 'object' OR NOT (v_payload ? 'line_item_id') THEN
      RETURN jsonb_build_object('result', 'refused', 'reason', 'bad_payload', 'message', 'line_item_id is required', 'state', public._receipt_claim_view(v_eid, v_uid));
    END IF;
    BEGIN
      v_line := (v_payload ->> 'line_item_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RETURN jsonb_build_object('result', 'refused', 'reason', 'bad_payload', 'message', 'line_item_id is not valid', 'state', public._receipt_claim_view(v_eid, v_uid));
    END;
    IF jsonb_typeof(v_payload -> 'on') IS NOT NULL AND jsonb_typeof(v_payload -> 'on') NOT IN ('boolean', 'null') THEN
      RETURN jsonb_build_object('result', 'refused', 'reason', 'bad_payload', 'message', 'on must be true or false', 'state', public._receipt_claim_view(v_eid, v_uid));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.expense_line_items li WHERE li.id = v_line AND li.expense_id = v_eid) THEN
      RETURN jsonb_build_object('result', 'refused', 'reason', 'bad_line', 'message', 'That item isn''t on this receipt', 'state', public._receipt_claim_view(v_eid, v_uid));
    END IF;
    IF NOT public._receipt_can_toggle(v_line, v_uid) THEN
      RETURN jsonb_build_object('result', 'refused', 'reason', 'forbidden',
        'message', 'You can''t change this item yourself. Ask the person who paid.', 'state', public._receipt_claim_view(v_eid, v_uid));
    END IF;
    IF NOT (v_uid = ANY (public._receipt_tagged(v_eid))) AND v_cur IS DISTINCT FROM 'not_there' THEN
      RETURN jsonb_build_object('result', 'refused', 'reason', 'not_on_receipt', 'message', 'You are not on this receipt', 'state', public._receipt_claim_view(v_eid, v_uid));
    END IF;
    SELECT coalesce(array_agg(DISTINCT cl.user_id ORDER BY cl.user_id), ARRAY[]::uuid[]) INTO v_existing
    FROM public.expense_item_claims cl WHERE cl.line_item_id = v_line AND cl.quantity_claimed - cl.leftover_quantity > 0;
    v_on := coalesce((v_payload ->> 'on')::boolean, NOT (v_uid = ANY (v_existing)));
    IF v_on = (v_uid = ANY (v_existing)) THEN
      NULL;   -- already in the requested state: nothing to do
    ELSE
      IF v_on THEN
        v_users := v_existing || v_uid;
      ELSE
        v_users := ARRAY(SELECT x FROM unnest(v_existing) AS x WHERE x <> v_uid);
      END IF;
      v_old_sub := current_setting('request.jwt.claim.sub', true);
      v_old_claims := current_setting('request.jwt.claims', true);
      v_old_role := current_setting('request.jwt.claim.role', true);
      BEGIN
        IF v_cur = 'not_there' AND v_on THEN
          DELETE FROM public.expense_claim_responses WHERE expense_id = v_eid AND user_id = v_uid;
        END IF;
        -- Run set_receipt_claims AS THE LINK'S PERSON (exactly how confirm_payment_by_token acts as the receiver): its own rules for an ordinary
        -- tagged person then apply. Only this service_role-only function sets these settings; PostgREST sets them from the verified JWT, so a
        -- client cannot. They are transaction-local and restored below (and rolled back with the sub-transaction on any error).
        PERFORM set_config('request.jwt.claim.sub', v_uid::text, true);
        PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
        PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
        PERFORM public.set_receipt_claims(v_eid, jsonb_build_array(jsonb_build_object('line_item_id', v_line, 'user_ids', to_jsonb(v_users))));
        PERFORM set_config('request.jwt.claim.sub', coalesce(v_old_sub, ''), true);
        PERFORM set_config('request.jwt.claims', coalesce(v_old_claims, ''), true);
        PERFORM set_config('request.jwt.claim.role', coalesce(v_old_role, ''), true);
        -- If the payer already shared the leftovers by hand, the line just re-split lost its leftover parts: share again the same way.
        IF v_exp.leftover_mode IS NOT NULL THEN
          PERFORM public.share_receipt_leftovers(v_eid, public._receipt_reshare_mode(v_eid));
        END IF;
        v_changed := true;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
        PERFORM set_config('request.jwt.claim.sub', coalesce(v_old_sub, ''), true);
        PERFORM set_config('request.jwt.claims', coalesce(v_old_claims, ''), true);
        PERFORM set_config('request.jwt.claim.role', coalesce(v_old_role, ''), true);
        RETURN jsonb_build_object('result', 'refused',
          'reason', CASE WHEN v_hint IN ('frozen', 'forbidden', 'too_many_sharers', 'not_tagged', 'overclaimed') THEN v_hint ELSE 'error' END,
          'message', v_msg, 'state', public._receipt_claim_view(v_eid, v_uid));
      END;
    END IF;
  END IF;

  IF v_changed AND v_action <> 'toggle' THEN
    INSERT INTO public.activity_feed (trip_id, actor, verb, entity, metadata)
    VALUES (v_trip, v_uid,
            CASE v_action WHEN 'done' THEN 'receipt_claims_done' WHEN 'not_there' THEN 'receipt_claims_not_there' ELSE 'receipt_claims_undone' END,
            jsonb_build_object('type', 'expense', 'id', v_eid, 'label', v_exp.description),
            jsonb_build_object('via', 'email_link'));
  END IF;
  RETURN jsonb_build_object('result', 'ok', 'action', v_action, 'changed', v_changed, 'state', public._receipt_claim_view(v_eid, v_uid));
END
$$;

-- Rate limit helper (the payment_confirm_rate_hit pattern, its own table): true while the key is within p_limit hits per window.
CREATE OR REPLACE FUNCTION public.receipt_claim_rate_hit(p_key text, p_limit integer, p_window_seconds integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_hits integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role only' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.receipt_claim_rate_limits WHERE window_start < now() - interval '1 day';
  INSERT INTO public.receipt_claim_rate_limits AS r (key, window_start, hits) VALUES (p_key, now(), 1)
  ON CONFLICT (key) DO UPDATE
    SET hits = CASE WHEN r.window_start < now() - make_interval(secs => p_window_seconds) THEN 1 ELSE r.hits + 1 END,
        window_start = CASE WHEN r.window_start < now() - make_interval(secs => p_window_seconds) THEN now() ELSE r.window_start END
  RETURNING hits INTO v_hits;
  RETURN v_hits <= p_limit;
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- reitemize_expense: re-itemise (or convert a plain expense into an itemised one) in ONE transaction, keeping claims on unchanged lines
-- ---------------------------------------------------------------------------------------------------------------------
-- Spec: scratchpad/phase3-expense-review.md "reitemize_expense RPC specification". Payer or manager (signed in; not the service role).
-- Deliberately NOT _receipt_begin (its not_itemised refusal would block converting a plain expense) but the same locks: the trip's freeze lock,
-- then receipt_claims:<expense>, then a re-read.
--   Refusals (hint): auth, not_found, forbidden, frozen, claims_closed (claims_closed_at set: the leftovers were applied. There is NO reopen function in this
--   design: extend_receipt_deadline refuses a closed receipt too. To re-itemise after closing, a reopen step would have to be added; it is not built),
--   currency_unsupported, bad_header, bad_line, bad_input.
--   p_header (allowed keys only, others ignored): description, vendor_name, category, payment_date, paid_by (a trip participant), participant_ids (uuid[] or null,
--   each a trip participant), receipt_url, currency, fx_rate, fx_rate_date, rate_source. Sets amount = sum of the new line totals, base_currency_amount =
--   round(amount * fx_rate, 2) (NULL without a rate), ai_parsed = true, status 'unallocated' for a previously PLAIN expense (a plain expense is 'confirmed' and the
--   status refresh never touches 'confirmed'), else the existing status. Never touches trip_id. Deletes the expense's expense_splits.
--   p_lines: ordered [{id|null, name_original, name_english|null, quantity, unit_price, subtotal, tax_amount, service_amount, line_discount_amount|null, total_amount}].
--   "Unchanged" (claims survive): id given and found, btrim(name_original) equal, round(quantity*100) equal, round(subtotal*10^exp) equal, currency unchanged. total_amount MAY
--   differ: the claims' money then follows the new total (penny rule below). Everything else with an id is "changed": the row is reused in place, ALL its claims are
--   deleted, shared_by_all is reset to false (DEVIATION from "kept": a table item with no claims could never be toggled). Lines not listed are deleted.
--   Write order (all inside the one transaction): 1 strip leftover parts (only when leftovers exist and anything changes) and clear leftover_mode; 2 delete claims on changed
--   lines and the removed lines; 3 shift kept line_numbers by +100000 (UNIQUE(expense_id, line_number) is not deferrable); 4 update kept rows and set final line_numbers;
--   5 insert new rows; 6 header; 7 recompute claim money on unchanged lines whose total changed; 8 _receipt_refresh_status LAST. Then, for people whose claims were
--   cleared: their 'done' response is deleted (they must look again). Returned in cleared_user_ids so the client can re-send the table notice.
--   Penny rule (7): per line T = round(total*10^exp), Q = round(quantity*100), q_i = round(quantity_claimed*100); target = T when sum(q_i) >= Q-1 (fully claimed within
--   the shared 0.011 tolerance), else round_half_away(T*sum(q)/Q); split by largest remainder on weights q_i (ties: lower user_id). Lines whose total did not change are
--   not touched at all (legacy 0.33 rows stay byte-identical).
--   PREVIEW: p_preview = true runs the REAL write path inside a sub-transaction and rolls it back, so the result is exactly what the real call would return
--   (including status) and nothing is written (no activity row, no response removal). Errors surface in preview too.
--   Returns {expense_id, kept_claims, cleared_claims, cleared_user_ids, leftovers_cleared, line_ids (in p_lines order), status, amount, preview, reconfirm_user_ids, needs_link}.
--   reconfirm_user_ids: whenever a line is added, changed or removed or a total changes, EVERY existing "That's everything" is deleted and returned here (cleared_user_ids keeps its
--   meaning: people whose claims were deleted). needs_link: the expense has no expense_allocation_links row (a plain expense converted to itemised); the CLIENT creates it (the
--   code is client-generated). A change of paid_by or participant_ids counts as a change (leftovers stripped and leftover_mode cleared, table items re-split; a new payer's stale
--   "I wasn't there" is removed). A currency change needs fx_rate (hint bad_header) unless the new currency is the trip's base currency; the old rate/date/source are dropped.
--   Check violations of the live tables surface as bad_line, numeric overflow as bad_input. kept_claims /
--   cleared_claims count people's OWN claim rows (leftover parts are derived and always rebuilt).
CREATE OR REPLACE FUNCTION public._reitemize_num(p_el jsonb, p_key text, p_scale integer, p_default numeric)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_raw jsonb := p_el -> p_key;
  x numeric;
BEGIN
  IF v_raw IS NULL OR jsonb_typeof(v_raw) = 'null' THEN
    IF p_default IS NULL THEN
      RAISE EXCEPTION 'Each line needs %', p_key USING ERRCODE = '22023', HINT = 'bad_line';
    END IF;
    RETURN p_default;
  END IF;
  IF jsonb_typeof(v_raw) NOT IN ('number', 'string') THEN
    RAISE EXCEPTION '% must be a number', p_key USING ERRCODE = '22023', HINT = 'bad_line';
  END IF;
  x := (p_el ->> p_key)::numeric;
  IF x < 0 OR x >= 100000000 OR round(x, p_scale) <> x THEN
    RAISE EXCEPTION '% is not a valid amount for this currency', p_key USING ERRCODE = '22023', HINT = 'bad_line';
  END IF;
  RETURN x;
END
$$;

CREATE OR REPLACE FUNCTION public.reitemize_expense(p_expense_id uuid, p_header jsonb, p_lines jsonb, p_preview boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_exp public.expenses;
  v_hdr jsonb := CASE WHEN p_header IS NULL OR jsonb_typeof(p_header) = 'null' THEN '{}'::jsonb ELSE p_header END;
  v_frozen boolean;
  v_was_itemised boolean;
  v_cur text;
  v_digits integer;
  v_pw numeric;
  v_n integer;
  i integer;
  v_el jsonb;
  v_id uuid;
  v_old public.expense_line_items;
  v_name text;
  v_qty numeric; v_up numeric; v_sub numeric; v_tax numeric; v_svc numeric; v_disc numeric; v_tot numeric;
  v_seen uuid[] := ARRAY[]::uuid[];
  v_pos_id uuid[] := ARRAY[]::uuid[];
  v_pos_changed boolean[] := ARRAY[]::boolean[];
  v_pos_totchg boolean[] := ARRAY[]::boolean[];
  v_line_ids uuid[] := ARRAY[]::uuid[];
  v_amount numeric := 0;
  v_description text; v_vendor text; v_category public.expense_category; v_pdate date; v_paid_by uuid; v_pids uuid[]; v_receipt text;
  v_fx numeric; v_fxdate date; v_rsrc text;
  v_x uuid;
  v_removed uuid[];
  v_changed_ids uuid[] := ARRAY[]::uuid[];
  v_kept_unch uuid[] := ARRAY[]::uuid[];
  v_any_change boolean := false;
  v_line_change boolean := false;
  v_who_changed boolean := false;
  v_base text;
  v_reconfirm uuid[];
  v_needs_link boolean;
  v_old_skip text;
  v_has_leftover boolean;
  v_leftovers_cleared boolean := false;
  v_kept_claims integer;
  v_cleared_claims integer;
  v_cleared_users uuid[];
  v_status text;
  v_result jsonb;
  v_ids uuid[]; v_qs bigint[]; v_sumq bigint; v_bigq bigint; v_bigt bigint; v_target bigint; v_floor bigint[]; v_rem numeric[]; v_left bigint; v_best integer; v_bestrem numeric; k integer;
  v_picked boolean[];
  r record;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501', HINT = 'auth';
  END IF;
  IF p_expense_id IS NULL THEN
    RAISE EXCEPTION 'Expense not found' USING ERRCODE = 'P0002', HINT = 'not_found';
  END IF;
  SELECT * INTO v_exp FROM public.expenses WHERE id = p_expense_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found' USING ERRCODE = 'P0002', HINT = 'not_found';
  END IF;
  IF NOT (v_exp.paid_by = v_uid OR public._settlement_can_manage(v_exp.trip_id, v_uid)) THEN
    RAISE EXCEPTION 'Only the person who paid, or a trip organizer, can do this' USING ERRCODE = '42501', HINT = 'forbidden';
  END IF;
  IF jsonb_typeof(v_hdr) <> 'object' OR p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' THEN
    RAISE EXCEPTION 'Header must be an object and lines a list' USING ERRCODE = '22023', HINT = 'bad_input';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('settlement_freeze:' || v_exp.trip_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('receipt_claims:' || p_expense_id::text, 0));
  SELECT * INTO v_exp FROM public.expenses WHERE id = p_expense_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found' USING ERRCODE = 'P0002', HINT = 'not_found';
  END IF;
  SELECT t.settlement_snapshot IS NOT NULL INTO v_frozen FROM public.trips t WHERE t.id = v_exp.trip_id;
  IF coalesce(v_frozen, false) THEN
    RAISE EXCEPTION 'Balances are frozen for this trip. Ask an organizer to unfreeze before changing who had what.' USING ERRCODE = 'P0001', HINT = 'frozen';
  END IF;
  IF v_exp.claims_closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'The leftovers on this receipt have already been shared; it can no longer be re-itemised' USING ERRCODE = 'P0001', HINT = 'claims_closed';
  END IF;
  v_was_itemised := coalesce(v_exp.ai_parsed, false) AND EXISTS (SELECT 1 FROM public.expense_line_items li WHERE li.expense_id = p_expense_id);

  -- ---- header validation -------------------------------------------------------------------------------------------------------------
  BEGIN
    v_cur := CASE WHEN v_hdr ? 'currency' AND jsonb_typeof(v_hdr -> 'currency') = 'string' THEN upper(btrim(v_hdr ->> 'currency')) ELSE v_exp.currency END;
    IF v_cur !~ '^[A-Z]{3}$' THEN
      RAISE EXCEPTION 'currency must be a 3-letter code' USING ERRCODE = '22023', HINT = 'bad_header';
    END IF;
    IF public.currency_exponent(v_cur) > 2 THEN
      RAISE EXCEPTION 'Receipts in % can''t be split between people here yet', v_cur USING ERRCODE = '22023', HINT = 'currency_unsupported';
    END IF;
    v_description := CASE WHEN v_hdr ? 'description' THEN btrim(coalesce(v_hdr ->> 'description', '')) ELSE v_exp.description END;
    IF v_description = '' THEN
      RAISE EXCEPTION 'description is required' USING ERRCODE = '22023', HINT = 'bad_header';
    END IF;
    v_vendor := CASE WHEN v_hdr ? 'vendor_name' THEN nullif(btrim(coalesce(v_hdr ->> 'vendor_name', '')), '') ELSE v_exp.vendor_name END;
    v_category := CASE WHEN v_hdr ? 'category' AND jsonb_typeof(v_hdr -> 'category') = 'string' THEN (v_hdr ->> 'category')::public.expense_category ELSE v_exp.category END;
    v_pdate := CASE WHEN v_hdr ? 'payment_date' AND jsonb_typeof(v_hdr -> 'payment_date') = 'string' THEN (v_hdr ->> 'payment_date')::date ELSE v_exp.payment_date END;
    v_paid_by := CASE WHEN v_hdr ? 'paid_by' AND jsonb_typeof(v_hdr -> 'paid_by') = 'string' THEN (v_hdr ->> 'paid_by')::uuid ELSE v_exp.paid_by END;
    IF NOT EXISTS (SELECT 1 FROM public.trip_participants tp WHERE tp.trip_id = v_exp.trip_id AND tp.user_id = v_paid_by) THEN
      RAISE EXCEPTION 'The payer must be on this trip' USING ERRCODE = '22023', HINT = 'bad_header';
    END IF;
    IF v_hdr ? 'participant_ids' THEN
      IF jsonb_typeof(v_hdr -> 'participant_ids') = 'null' THEN
        v_pids := NULL;
      ELSIF jsonb_typeof(v_hdr -> 'participant_ids') = 'array' THEN
        SELECT coalesce(array_agg(DISTINCT x::uuid), ARRAY[]::uuid[]) INTO v_pids FROM jsonb_array_elements_text(v_hdr -> 'participant_ids') AS t(x);
        IF cardinality(v_pids) = 0 THEN
          v_pids := NULL;
        END IF;
        FOREACH v_x IN ARRAY coalesce(v_pids, ARRAY[]::uuid[]) LOOP
          IF NOT EXISTS (SELECT 1 FROM public.trip_participants tp WHERE tp.trip_id = v_exp.trip_id AND tp.user_id = v_x) THEN
            RAISE EXCEPTION 'Everyone on the receipt must be on this trip' USING ERRCODE = '22023', HINT = 'bad_header';
          END IF;
        END LOOP;
      ELSE
        RAISE EXCEPTION 'participant_ids must be a list or null' USING ERRCODE = '22023', HINT = 'bad_header';
      END IF;
    ELSE
      v_pids := v_exp.participant_ids;
    END IF;
    v_receipt := CASE WHEN v_hdr ? 'receipt_url' THEN nullif(btrim(coalesce(v_hdr ->> 'receipt_url', '')), '') ELSE v_exp.receipt_url END;
    v_rsrc := CASE WHEN v_hdr ? 'rate_source' THEN nullif(btrim(coalesce(v_hdr ->> 'rate_source', '')), '') ELSE v_exp.rate_source END;
    v_fxdate := CASE WHEN v_hdr ? 'fx_rate_date' THEN (v_hdr ->> 'fx_rate_date')::date ELSE v_exp.fx_rate_date END;
    IF v_hdr ? 'fx_rate' THEN
      v_fx := round((v_hdr ->> 'fx_rate')::numeric, 6);
      IF v_fx IS NOT NULL AND (v_fx <= 0 OR v_fx >= 10000) THEN
        RAISE EXCEPTION 'fx_rate must be above zero' USING ERRCODE = '22023', HINT = 'bad_header';
      END IF;
    ELSE
      v_fx := v_exp.fx_rate;
    END IF;
    -- A currency change must not keep the OLD rate: the new currency needs its own rate (none needed when it is the trip's base currency).
    IF v_cur <> v_exp.currency THEN
      SELECT t.base_currency INTO v_base FROM public.trips t WHERE t.id = v_exp.trip_id;
      IF NOT (v_hdr ? 'fx_rate') OR v_fx IS NULL THEN
        IF v_cur = coalesce(v_base, v_cur) THEN
          v_fx := NULL;
        ELSE
          RAISE EXCEPTION 'A new currency needs an exchange rate' USING ERRCODE = '22023', HINT = 'bad_header';
        END IF;
      END IF;
      IF NOT (v_hdr ? 'fx_rate_date') THEN v_fxdate := NULL; END IF;
      IF NOT (v_hdr ? 'rate_source') THEN v_rsrc := NULL; END IF;
    END IF;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'A header value is not valid' USING ERRCODE = '22023', HINT = 'bad_header';
  END;
  v_digits := public.currency_exponent(v_cur);
  IF v_digits > 2 THEN
    RAISE EXCEPTION 'Receipts in % can''t be split between people here yet', v_cur USING ERRCODE = '22023', HINT = 'currency_unsupported';
  END IF;
  v_pw := power(10::numeric, v_digits);

  -- ---- lines validation + classification ---------------------------------------------------------------------------------------------
  v_n := jsonb_array_length(p_lines);
  IF v_n = 0 OR v_n > 500 THEN
    RAISE EXCEPTION 'A receipt needs between 1 and 500 lines' USING ERRCODE = '22023', HINT = 'bad_line';
  END IF;
  FOR i IN 1..v_n LOOP
    v_el := p_lines -> (i - 1);
    IF jsonb_typeof(v_el) <> 'object' THEN
      RAISE EXCEPTION 'Each line must be an object' USING ERRCODE = '22023', HINT = 'bad_line';
    END IF;
    BEGIN
      v_id := CASE WHEN jsonb_typeof(v_el -> 'id') = 'string' THEN (v_el ->> 'id')::uuid ELSE NULL END;
      v_name := btrim(coalesce(v_el ->> 'name_original', ''));
      IF v_name = '' THEN
        RAISE EXCEPTION 'Each line needs a name' USING ERRCODE = '22023', HINT = 'bad_line';
      END IF;
      IF jsonb_typeof(v_el -> 'quantity') NOT IN ('number', 'string') THEN
        RAISE EXCEPTION 'Each line needs a quantity' USING ERRCODE = '22023', HINT = 'bad_line';
      END IF;
      v_qty := round((v_el ->> 'quantity')::numeric, 2);
      IF v_qty <= 0 OR v_qty >= 100000000 THEN
        RAISE EXCEPTION 'A quantity must be above zero' USING ERRCODE = '22023', HINT = 'bad_line';
      END IF;
      v_up := public._reitemize_num(v_el, 'unit_price', 2, NULL);
      v_sub := public._reitemize_num(v_el, 'subtotal', v_digits, NULL);
      v_tax := public._reitemize_num(v_el, 'tax_amount', v_digits, 0);
      v_svc := public._reitemize_num(v_el, 'service_amount', v_digits, 0);
      v_disc := public._reitemize_num(v_el, 'line_discount_amount', v_digits, 0);
      v_tot := public._reitemize_num(v_el, 'total_amount', v_digits, NULL);
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'A line value is not valid' USING ERRCODE = '22023', HINT = 'bad_line';
    END;
    v_amount := v_amount + v_tot;
    IF v_id IS NOT NULL THEN
      IF v_id = ANY (v_seen) THEN
        RAISE EXCEPTION 'A line is listed twice' USING ERRCODE = '22023', HINT = 'bad_line';
      END IF;
      v_seen := v_seen || v_id;
      SELECT * INTO v_old FROM public.expense_line_items li WHERE li.id = v_id AND li.expense_id = p_expense_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'A line doesn''t belong to this expense' USING ERRCODE = '22023', HINT = 'bad_line';
      END IF;
      v_pos_id := v_pos_id || v_id;
      v_pos_changed := v_pos_changed || (NOT (v_cur = v_exp.currency AND btrim(v_old.name_original) = v_name
                                              AND round(v_old.quantity * 100) = round(v_qty * 100)
                                              AND round(v_old.subtotal * v_pw) = round(v_sub * v_pw)));
      v_pos_totchg := v_pos_totchg || (round(v_old.total_amount * v_pw) <> round(v_tot * v_pw));
    ELSE
      v_pos_id := v_pos_id || NULL::uuid;
      v_pos_changed := v_pos_changed || true;
      v_pos_totchg := v_pos_totchg || true;
    END IF;
  END LOOP;
  IF v_amount >= 100000000 THEN
    RAISE EXCEPTION 'The total is too large' USING ERRCODE = '22023', HINT = 'bad_line';
  END IF;

  SELECT coalesce(array_agg(li.id), ARRAY[]::uuid[]) INTO v_removed FROM public.expense_line_items li WHERE li.expense_id = p_expense_id AND NOT (li.id = ANY (v_seen));
  FOR i IN 1..v_n LOOP
    IF v_pos_id[i] IS NOT NULL THEN
      IF v_pos_changed[i] THEN
        v_changed_ids := v_changed_ids || v_pos_id[i];
      ELSE
        v_kept_unch := v_kept_unch || v_pos_id[i];
      END IF;
    END IF;
    IF v_pos_changed[i] OR v_pos_totchg[i] THEN
      v_any_change := true;
    END IF;
  END LOOP;
  IF cardinality(v_removed) > 0 THEN
    v_any_change := true;
  END IF;
  -- adding, changing, removing a line or changing any total: everyone's "That's everything" no longer stands
  v_line_change := v_any_change;
  -- who is on the receipt changed (payer or explicit list): leftovers and table-item splits were computed over the OLD set
  v_who_changed := v_paid_by <> v_exp.paid_by
    OR (CASE WHEN v_pids IS NULL THEN NULL ELSE ARRAY(SELECT x FROM unnest(v_pids) AS x ORDER BY x) END)
       IS DISTINCT FROM (CASE WHEN v_exp.participant_ids IS NULL THEN NULL ELSE ARRAY(SELECT x FROM unnest(v_exp.participant_ids) AS x ORDER BY x) END);
  IF v_who_changed THEN
    v_any_change := true;
  END IF;

  -- counts and people BEFORE writing (the same code answers preview and real; they count OWN claim rows only)
  SELECT count(*) FILTER (WHERE cl.line_item_id = ANY (v_kept_unch)),
         count(*) FILTER (WHERE cl.line_item_id = ANY (v_changed_ids) OR cl.line_item_id = ANY (v_removed)),
         coalesce(array_agg(DISTINCT cl.user_id) FILTER (WHERE cl.line_item_id = ANY (v_changed_ids) OR cl.line_item_id = ANY (v_removed)), ARRAY[]::uuid[])
    INTO v_kept_claims, v_cleared_claims, v_cleared_users
  FROM public.expense_item_claims cl WHERE cl.expense_id = p_expense_id AND cl.quantity_claimed - cl.leftover_quantity > 0;
  SELECT coalesce(array_agg(x ORDER BY x), ARRAY[]::uuid[]) INTO v_cleared_users FROM unnest(v_cleared_users) AS x;
  SELECT EXISTS (SELECT 1 FROM public.expense_item_claims cl WHERE cl.expense_id = p_expense_id AND (cl.leftover_quantity > 0 OR cl.leftover_amount > 0)) INTO v_has_leftover;
  v_leftovers_cleared := v_has_leftover AND v_any_change;

  -- ---- the writes (a preview runs them for real inside a sub-transaction that is rolled back) ----------------------------------------------
  BEGIN
    v_old_skip := current_setting('receipt.skip_done_clear', true);
    PERFORM set_config('receipt.skip_done_clear', 'on', true);   -- the answers are handled explicitly below
    -- 1. leftover parts are derived: take them out when anything changes
    IF v_leftovers_cleared THEN
      PERFORM public._receipt_strip_leftovers(p_expense_id);
      UPDATE public.expenses SET leftover_mode = NULL, leftover_user_id = NULL WHERE id = p_expense_id;
    END IF;
    -- 2. claims on changed lines, then the removed lines
    DELETE FROM public.expense_item_claims WHERE expense_id = p_expense_id AND (line_item_id = ANY (v_changed_ids) OR line_item_id = ANY (v_removed));
    DELETE FROM public.expense_line_items WHERE expense_id = p_expense_id AND id = ANY (v_removed);
    -- 3. get the kept rows out of the way of the final numbering
    UPDATE public.expense_line_items SET line_number = line_number + 100000 WHERE expense_id = p_expense_id;
    -- 4 + 5. kept rows in place, new rows inserted, in p_lines order
    FOR i IN 1..v_n LOOP
      v_el := p_lines -> (i - 1);
      v_name := btrim(v_el ->> 'name_original');
      v_qty := round((v_el ->> 'quantity')::numeric, 2);
      v_up := coalesce((v_el ->> 'unit_price')::numeric, 0);
      v_sub := (v_el ->> 'subtotal')::numeric;
      v_tax := coalesce((v_el ->> 'tax_amount')::numeric, 0);
      v_svc := coalesce((v_el ->> 'service_amount')::numeric, 0);
      v_disc := coalesce((v_el ->> 'line_discount_amount')::numeric, 0);
      v_tot := (v_el ->> 'total_amount')::numeric;
      IF v_pos_id[i] IS NOT NULL THEN
        UPDATE public.expense_line_items
           SET name_original = v_name, name_english = nullif(btrim(coalesce(v_el ->> 'name_english', '')), ''), quantity = v_qty, unit_price = v_up, subtotal = v_sub,
               tax_amount = v_tax, service_amount = v_svc, line_discount_amount = v_disc, total_amount = v_tot, line_number = i,
               line_discount_percent = CASE WHEN v_pos_changed[i] THEN 0 ELSE line_discount_percent END,
               shared_by_all = CASE WHEN v_pos_changed[i] THEN false ELSE shared_by_all END
         WHERE id = v_pos_id[i];
        v_line_ids := v_line_ids || v_pos_id[i];
      ELSE
        INSERT INTO public.expense_line_items (expense_id, line_number, name_original, name_english, quantity, unit_price, subtotal, tax_amount, service_amount, line_discount_amount, total_amount)
        VALUES (p_expense_id, i, v_name, nullif(btrim(coalesce(v_el ->> 'name_english', '')), ''), v_qty, v_up, v_sub, v_tax, v_svc, v_disc, v_tot)
        RETURNING id INTO v_id;
        v_line_ids := v_line_ids || v_id;
      END IF;
    END LOOP;
    -- 6. header (an itemised expense owns its split through lines and claims, not expense_splits)
    DELETE FROM public.expense_splits WHERE expense_id = p_expense_id;
    UPDATE public.expenses
       SET description = v_description, vendor_name = v_vendor, category = v_category, payment_date = v_pdate, paid_by = v_paid_by, participant_ids = v_pids,
           receipt_url = v_receipt, currency = v_cur, fx_rate = v_fx, fx_rate_date = v_fxdate, rate_source = v_rsrc,
           amount = v_amount, base_currency_amount = CASE WHEN v_fx IS NULL THEN NULL ELSE round(v_amount * v_fx, 2) END,
           ai_parsed = true, status = CASE WHEN v_was_itemised THEN coalesce(status, 'unallocated'::public.expense_status) ELSE 'unallocated'::public.expense_status END
     WHERE id = p_expense_id;
    -- 7. money on unchanged lines whose total changed follows the new total (penny rule)
    FOR r IN
      SELECT li.id AS lid, li.quantity AS lq, round(li.total_amount * v_pw)::bigint AS t
      FROM public.expense_line_items li
      WHERE li.id = ANY (v_kept_unch) AND li.id = ANY (SELECT v_pos_id[g] FROM generate_subscripts(v_pos_id, 1) AS g WHERE v_pos_totchg[g])
      ORDER BY li.line_number
    LOOP
      SELECT array_agg(c.id ORDER BY c.user_id), array_agg(round(c.quantity_claimed * 100)::bigint ORDER BY c.user_id)
        INTO v_ids, v_qs FROM public.expense_item_claims c WHERE c.line_item_id = r.lid;
      CONTINUE WHEN v_ids IS NULL;
      SELECT sum(q) INTO v_sumq FROM unnest(v_qs) AS q;
      v_bigq := round(r.lq * 100)::bigint;
      v_bigt := r.t;
      v_target := CASE WHEN v_sumq >= v_bigq - 1 THEN v_bigt ELSE round(v_bigt::numeric * v_sumq / v_bigq)::bigint END;
      v_floor := ARRAY[]::bigint[];
      v_rem := ARRAY[]::numeric[];
      v_left := v_target;
      FOR k IN 1..cardinality(v_ids) LOOP
        v_floor := v_floor || floor(v_target::numeric * v_qs[k] / v_sumq)::bigint;
        v_rem := v_rem || (v_target::numeric * v_qs[k] - floor(v_target::numeric * v_qs[k] / v_sumq) * v_sumq);
        v_left := v_left - v_floor[k];
      END LOOP;
      v_picked := array_fill(false, ARRAY[cardinality(v_ids)]);
      WHILE v_left > 0 LOOP
        v_best := 0;
        v_bestrem := -1;
        FOR k IN 1..cardinality(v_ids) LOOP
          IF NOT v_picked[k] AND v_rem[k] > v_bestrem THEN
            v_best := k;
            v_bestrem := v_rem[k];
          END IF;
        END LOOP;
        EXIT WHEN v_best = 0;
        v_floor[v_best] := v_floor[v_best] + 1;
        v_picked[v_best] := true;
        v_left := v_left - 1;
      END LOOP;
      FOR k IN 1..cardinality(v_ids) LOOP
        UPDATE public.expense_item_claims SET amount_owed = v_floor[k]::numeric / v_pw WHERE id = v_ids[k];
      END LOOP;
    END LOOP;
    -- table items kept as they were are re-split over whoever is on the receipt NOW (a changed payer or list, or a changed total)
    IF v_any_change THEN
      PERFORM public._receipt_resplit_table_items(p_expense_id);
    END IF;
    -- answers: any line change means everybody must look again (their "That's everything" is deleted and they are returned in reconfirm_user_ids);
    -- a header-only change that moved the payer clears a stale "I wasn't there" of the new payer
    v_reconfirm := ARRAY[]::uuid[];
    IF v_line_change THEN
      SELECT coalesce(array_agg(rs.user_id ORDER BY rs.user_id), ARRAY[]::uuid[]) INTO v_reconfirm
      FROM public.expense_claim_responses rs WHERE rs.expense_id = p_expense_id AND rs.response = 'done';
      DELETE FROM public.expense_claim_responses WHERE ctid IN (SELECT rsp.ctid FROM public.expense_claim_responses rsp
        WHERE rsp.expense_id = p_expense_id AND rsp.response = 'done' FOR UPDATE SKIP LOCKED);   -- never wait on a row somebody is answering right now (deadlock)
    END IF;
    DELETE FROM public.expense_claim_responses WHERE expense_id = p_expense_id AND response = 'not_there' AND user_id = v_paid_by;
    PERFORM set_config('receipt.skip_done_clear', coalesce(v_old_skip, ''), true);
    v_needs_link := NOT EXISTS (SELECT 1 FROM public.expense_allocation_links l WHERE l.expense_id = p_expense_id);
    -- 8. LAST: the dust-tolerant status, after the live AFTER trigger fired for every claim write above
    v_status := public._receipt_refresh_status(p_expense_id);
    v_result := jsonb_build_object(
      'expense_id', p_expense_id, 'kept_claims', v_kept_claims, 'cleared_claims', v_cleared_claims, 'cleared_user_ids', to_jsonb(v_cleared_users),
      'leftovers_cleared', v_leftovers_cleared, 'line_ids', to_jsonb(v_line_ids), 'status', v_status, 'amount', v_amount, 'preview', coalesce(p_preview, false),
      'reconfirm_user_ids', to_jsonb(v_reconfirm), 'needs_link', v_needs_link);
    IF coalesce(p_preview, false) THEN
      RAISE EXCEPTION 'preview rollback' USING ERRCODE = 'RB001';
    END IF;
    INSERT INTO public.activity_feed (trip_id, actor, verb, entity, metadata)
    VALUES (v_exp.trip_id, v_uid, 'expense_reitemised',
            jsonb_build_object('type', 'expense', 'id', p_expense_id, 'label', v_description),
            jsonb_build_object('kept_claims', v_kept_claims, 'cleared_claims', v_cleared_claims, 'cleared_user_ids', to_jsonb(v_cleared_users),
                               'leftovers_cleared', v_leftovers_cleared, 'lines', v_n, 'was_itemised', v_was_itemised));
  EXCEPTION
    WHEN SQLSTATE 'RB001' THEN
      NULL;   -- preview: everything above is rolled back; v_result already holds the answer
    WHEN check_violation THEN
      RAISE EXCEPTION 'A line value breaks a rule of the receipt table (too long, or out of range)' USING ERRCODE = '22023', HINT = 'bad_line';
    WHEN numeric_value_out_of_range THEN
      RAISE EXCEPTION 'An amount is too large' USING ERRCODE = '22023', HINT = 'bad_input';
  END;
  RETURN v_result;
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- unfreeze_settlements: also drop the trip's stale 'suggested' payments (only when the trip WAS frozen)
-- ---------------------------------------------------------------------------------------------------------------------
-- SUPERSET of the body shipped in 20261118100000 (same signature, SECURITY DEFINER, search_path, same checks, same snapshot clearing, same activity row verb,
-- same 'unfrozen' key). New: when the trip was actually frozen, it deletes the trip's 'suggested' settlements. EVERY suggested row goes, including ones the payer
-- retracted (marked_paid -> suggested, last_retracted_at set): the proposals are recomputed by the next freeze, exactly as freeze_settlements already replaces them.
-- There is nothing to exempt: a suggested row cannot carry receipt_disputed_at (CHECK: only while marked_paid) and its email links are retired the moment it leaves
-- marked_paid (trigger_supersede_payment_tokens). marked_paid / confirmed rows are never touched. On a trip that is NOT frozen the call is the old no-op (it only
-- re-stamps who/when, as before). The delete runs under the same freeze advisory lock, so it cannot interleave with a freeze. Adds 'deleted_suggested' to the
-- result and to the activity metadata.
CREATE OR REPLACE FUNCTION public.unfreeze_settlements(p_trip_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_deleted integer := 0;
  v_was_frozen boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.trips t WHERE t.id = p_trip_id) THEN
    RAISE EXCEPTION 'Trip not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.settlement_assert_can_manage(p_trip_id, v_uid);

  PERFORM pg_advisory_xact_lock(hashtextextended('settlement_freeze:' || p_trip_id::text, 0));

  SELECT t.settlement_snapshot IS NOT NULL INTO v_was_frozen FROM public.trips t WHERE t.id = p_trip_id;

  -- Same as the client did: clear the snapshot, stamp who/when.
  UPDATE public.trips
  SET settlement_snapshot = NULL,
      settlement_snapshot_at = now(),
      settlement_snapshot_by = v_uid
  WHERE id = p_trip_id;

  -- NEW: the proposals of the frozen state are stale now. Never a payment someone acted on.
  IF coalesce(v_was_frozen, false) THEN
    DELETE FROM public.settlements s WHERE s.trip_id = p_trip_id AND s.status = 'suggested';
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
  END IF;

  INSERT INTO public.activity_feed (trip_id, actor, verb, entity, metadata)
  VALUES (p_trip_id, v_uid, 'unfroze_settlement', jsonb_build_object('trip_id', p_trip_id), jsonb_build_object('deleted_suggested', v_deleted));

  RETURN jsonb_build_object('unfrozen', true, 'deleted_suggested', v_deleted);
END;
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Closed receipts are final; reopening; re-splitting table items; answers that change who is on the receipt
-- ---------------------------------------------------------------------------------------------------------------------
-- LOCK ORDER (every writer, in this order): (1) the trip's freeze advisory lock 'settlement_freeze:<trip>', (2) the per-expense advisory lock
-- 'receipt_claims:<expense>', (3) rows (a response row, a claim row). Where a writer must delete somebody ELSE's answer while holding (1)+(2) it uses FOR UPDATE SKIP LOCKED, so it
-- can never wait on a row that a concurrent answer holds (the answering side waits for (1)/(2) behind us: that would be a cycle). In-app answers should go through
-- respond_to_receipt, which takes (1), (2) BEFORE the row. Definer functions take both at the start (_receipt_begin / reitemize_expense / receipt_claim_act); the response guard takes both for CLIENT
-- writes; triggers that run inside those never take locks themselves.

-- phase-1 _receipt_begin + the closed-receipt refusal above (md5 pinned in PRE_APPLY group 22: live must equal the shipped phase-1 text before this replaces it)
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
  -- PHASE 2 (the only change to this phase-1 body): a CLOSED receipt (the leftovers were applied) is final for claim edits. set_receipt_claims (p_manager_only = false)
  -- refuses for everyone, managers included; a manager reopens it first (reopen_receipt_claims). The manager-only callers (share, send, extend, apply, reopen) are unaffected.
  IF NOT p_manager_only AND v_exp.claims_closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'The leftovers on this receipt have already been shared; ask the person who paid to reopen it' USING ERRCODE = 'P0001', HINT = 'claims_closed';
  END IF;
  IF NOT (coalesce(v_exp.ai_parsed, false) AND v_exp.status IS NOT NULL
          AND EXISTS (SELECT 1 FROM public.expense_line_items li WHERE li.expense_id = p_expense_id)) THEN
    RAISE EXCEPTION 'This expense isn''t itemised' USING ERRCODE = '22023', HINT = 'not_itemised';
  END IF;
  -- amount_owed is numeric(10,2): a currency with 3 decimals (KWD, BHD ...) could not be split exactly, so it is refused rather than rounded.
  IF public.currency_exponent(v_exp.currency) > 2 THEN
    RAISE EXCEPTION 'Receipts in % can''t be split between people here yet', v_exp.currency USING ERRCODE = '22023', HINT = 'currency_unsupported';
  END IF;
  RETURN v_exp;
END
$$;

-- Which mode a re-share uses: the one already used on this receipt ('same'), but 'everyone' when nothing was shared yet or the person the payer chose is no longer on the receipt.
CREATE OR REPLACE FUNCTION public._receipt_reshare_mode(p_expense_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN e.leftover_mode IS NULL THEN 'everyone'
              WHEN e.leftover_mode = 'person' AND NOT coalesce(e.leftover_user_id = ANY (public._receipt_tagged(e.id)), false) THEN 'everyone'
              ELSE 'same' END
  FROM public.expenses e WHERE e.id = p_expense_id
$$;

-- Keep every link's expiry at deadline + 7 days (at least an hour from now) when the deadline moves.
CREATE OR REPLACE FUNCTION public._receipt_sync_token_expiry(p_expense_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.receipt_claim_tokens t
     SET expires_at = greatest(now() + interval '1 hour', coalesce((SELECT e.claim_deadline FROM public.expenses e WHERE e.id = p_expense_id), now()) + interval '7 days')
   WHERE t.expense_id = p_expense_id AND t.used_at IS NULL
$$;

-- TABLE ITEMS (shared_by_all): re-split every such line over the people on the receipt NOW (_receipt_tagged, sorted by user_id): quantity in hundredths and amount in
-- minor units by largest remainder, ties to the lower user_id (the set_receipt_claims convention); rows of people who are no longer on the receipt disappear, people who
-- came back get a row again (created_by = the old row's, else the payer). Leftover parts are stripped first (the caller re-shares). A line with more people than hundredths
-- is left alone. Idempotent: lines that are already exact are not rewritten. Returns the number of lines rewritten.
CREATE OR REPLACE FUNCTION public._receipt_resplit_table_items(p_expense_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_exp public.expenses;
  v_tagged uuid[];
  v_k integer;
  v_pw numeric;
  v_li public.expense_line_items;
  v_qs bigint[];
  v_as bigint[];
  v_prev jsonb;
  v_n integer := 0;
  v_old_skip text;
  v_exact boolean;
  i integer;
BEGIN
  SELECT * INTO v_exp FROM public.expenses WHERE id = p_expense_id;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.expense_line_items l WHERE l.expense_id = p_expense_id AND l.shared_by_all) THEN
    RETURN 0;
  END IF;
  v_tagged := public._receipt_tagged(p_expense_id);
  v_k := coalesce(cardinality(v_tagged), 0);
  IF v_k = 0 THEN
    RETURN 0;
  END IF;
  v_pw := power(10::numeric, public.currency_exponent(v_exp.currency));
  v_old_skip := current_setting('receipt.skip_done_clear', true);
  PERFORM set_config('receipt.skip_done_clear', 'on', true);
  FOR v_li IN SELECT * FROM public.expense_line_items l WHERE l.expense_id = p_expense_id AND l.shared_by_all ORDER BY l.line_number LOOP
    IF v_k > round(v_li.quantity * 100) THEN
      CONTINUE;
    END IF;
    v_qs := public._receipt_even_split(round(v_li.quantity * 100)::bigint, v_k);
    v_as := public._receipt_even_split(round(v_li.total_amount * v_pw)::bigint, v_k);
    SELECT (SELECT count(*) FROM public.expense_item_claims c WHERE c.line_item_id = v_li.id) = v_k
           AND NOT EXISTS (SELECT 1 FROM unnest(v_tagged) WITH ORDINALITY AS u(uid, ord)
                           LEFT JOIN public.expense_item_claims c ON c.line_item_id = v_li.id AND c.user_id = u.uid
                           WHERE c.id IS NULL OR round(c.quantity_claimed * 100) <> v_qs[u.ord] OR round(c.amount_owed * v_pw) <> v_as[u.ord]
                              OR c.leftover_quantity <> 0 OR c.leftover_amount <> 0)
      INTO v_exact;
    IF v_exact THEN
      CONTINUE;
    END IF;
    SELECT coalesce(jsonb_object_agg(c.user_id::text, to_jsonb(coalesce(c.created_by, c.user_id))), '{}'::jsonb) INTO v_prev
    FROM public.expense_item_claims c WHERE c.line_item_id = v_li.id AND c.quantity_claimed - c.leftover_quantity > 0;
    DELETE FROM public.expense_item_claims WHERE line_item_id = v_li.id;
    FOR i IN 1..v_k LOOP
      INSERT INTO public.expense_item_claims (line_item_id, user_id, expense_id, quantity_claimed, amount_owed, source, created_by)
      VALUES (v_li.id, v_tagged[i], p_expense_id, v_qs[i]::numeric / 100, v_as[i]::numeric / v_pw, 'shared',
              CASE WHEN v_prev ? v_tagged[i]::text THEN (v_prev ->> v_tagged[i]::text)::uuid ELSE v_exp.paid_by END);
    END LOOP;
    v_n := v_n + 1;
  END LOOP;
  PERFORM set_config('receipt.skip_done_clear', coalesce(v_old_skip, ''), true);
  RETURN v_n;
END
$$;

-- After "I wasn't there" is said, changed, undone or deleted: the people on the receipt changed. Table items are re-split; if the leftovers were already shared by hand they
-- are re-shared (the 'same' mode, or 'everyone' when the person the payer chose is gone) so nobody who was not there stays charged. Runs inside the writer's locks.
CREATE OR REPLACE FUNCTION public._receipt_after_tagged_change(p_expense_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_exp public.expenses;
  v_old_sub text;
  v_old_claims text;
  v_old_role text;
  v_old_skip text;
BEGIN
  SELECT * INTO v_exp FROM public.expenses WHERE id = p_expense_id;
  IF NOT FOUND OR v_exp.claims_closed_at IS NOT NULL THEN
    RETURN;
  END IF;
  v_old_skip := current_setting('receipt.skip_done_clear', true);
  PERFORM set_config('receipt.skip_done_clear', 'on', true);
  PERFORM public._receipt_resplit_table_items(p_expense_id);
  IF v_exp.leftover_mode IS NOT NULL THEN
    -- share_receipt_leftovers needs a payer, a manager or the service role: act as the service role for this one call (the same transaction-local technique as the links)
    v_old_sub := current_setting('request.jwt.claim.sub', true);
    v_old_claims := current_setting('request.jwt.claims', true);
    v_old_role := current_setting('request.jwt.claim.role', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    PERFORM public.share_receipt_leftovers(p_expense_id, public._receipt_reshare_mode(p_expense_id));
    PERFORM set_config('request.jwt.claim.sub', coalesce(v_old_sub, ''), true);
    PERFORM set_config('request.jwt.claims', coalesce(v_old_claims, ''), true);
    PERFORM set_config('request.jwt.claim.role', coalesce(v_old_role, ''), true);
  END IF;
  PERFORM public._receipt_refresh_status(p_expense_id);
  PERFORM set_config('receipt.skip_done_clear', coalesce(v_old_skip, ''), true);
END
$$;

CREATE OR REPLACE FUNCTION public.after_claim_response()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- inside another trigger (an FK cascade from a deleted expense or user, the done-clearing trigger): nothing to do
  IF pg_trigger_depth() > 1 THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.response = OLD.response THEN
    RETURN NULL;
  END IF;
  IF (TG_OP <> 'DELETE' AND NEW.response = 'not_there') OR (TG_OP <> 'INSERT' AND OLD.response = 'not_there') THEN
    PERFORM public._receipt_after_tagged_change(CASE WHEN TG_OP = 'DELETE' THEN OLD.expense_id ELSE NEW.expense_id END);
  END IF;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS trg_after_claim_response ON public.expense_claim_responses;
CREATE TRIGGER trg_after_claim_response AFTER INSERT OR UPDATE OR DELETE ON public.expense_claim_responses
  FOR EACH ROW EXECUTE FUNCTION public.after_claim_response();

-- When SOMEONE ELSE changes a person's own items (the payer or a manager through set_receipt_claims, a co-claimer joining the line), that person's "That's everything" is
-- cleared: they must look again. Their own edits keep it. Derived changes (leftover parts, table-item re-splits, re-itemising) set receipt.skip_done_clear and are handled by
-- their own code; service-role writes (no auth.uid()) never clear.
CREATE OR REPLACE FUNCTION public.clear_done_on_claim_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.expense_item_claims;
  v_changed boolean;
BEGIN
  IF pg_trigger_depth() > 1 OR v_uid IS NULL OR coalesce(current_setting('receipt.skip_done_clear', true), '') = 'on' THEN
    RETURN NULL;
  END IF;
  v_row := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  IF v_row.user_id = v_uid THEN
    RETURN NULL;
  END IF;
  v_changed := CASE TG_OP
    WHEN 'INSERT' THEN NEW.quantity_claimed - NEW.leftover_quantity > 0
    WHEN 'DELETE' THEN OLD.quantity_claimed - OLD.leftover_quantity > 0
    ELSE (NEW.quantity_claimed - NEW.leftover_quantity) IS DISTINCT FROM (OLD.quantity_claimed - OLD.leftover_quantity)
         OR (NEW.amount_owed - NEW.leftover_amount) IS DISTINCT FROM (OLD.amount_owed - OLD.leftover_amount) END;
  IF v_changed THEN
    -- SKIP LOCKED: if that person is answering right now (their row is locked) we must not wait for it while holding the receipt locks (deadlock); their own
    -- concurrent answer wins
    DELETE FROM public.expense_claim_responses WHERE ctid IN (SELECT r.ctid FROM public.expense_claim_responses r
      WHERE r.expense_id = v_row.expense_id AND r.user_id = v_row.user_id AND r.response = 'done' FOR UPDATE SKIP LOCKED);
  END IF;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS trg_clear_done_on_claim_change ON public.expense_item_claims;
CREATE TRIGGER trg_clear_done_on_claim_change AFTER INSERT OR UPDATE OR DELETE ON public.expense_item_claims
  FOR EACH ROW EXECUTE FUNCTION public.clear_done_on_claim_change();

-- A closed receipt does not become unclaimed again behind the payer's back: an OLD client's direct claim INSERT / UPDATE / DELETE is refused once the leftovers were applied
-- (the new client reopens first). Clients only (cascades and the definer functions are not clients).
CREATE OR REPLACE FUNCTION public.guard_claim_closed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_closed timestamptz;
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    SELECT e.claims_closed_at INTO v_closed FROM public.expenses e WHERE e.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.expense_id ELSE NEW.expense_id END;
    IF v_closed IS NOT NULL THEN
      RAISE EXCEPTION 'The leftovers on this receipt have already been shared; ask the person who paid to reopen it' USING ERRCODE = 'P0001', HINT = 'claims_closed';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
DROP TRIGGER IF EXISTS trg_guard_claim_closed ON public.expense_item_claims;
CREATE TRIGGER trg_guard_claim_closed BEFORE INSERT OR UPDATE OR DELETE ON public.expense_item_claims
  FOR EACH ROW EXECUTE FUNCTION public.guard_claim_closed();

-- Line items of a CLOSED receipt cannot be inserted, changed or deleted by a client (a line DELETE cascades to the claims as the table owner, which would bypass
-- guard_claim_closed). Cascades from deleting the whole expense run as the owner and are unaffected; so are the definer functions.
CREATE OR REPLACE FUNCTION public.guard_line_items_closed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_closed timestamptz;
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    SELECT e.claims_closed_at INTO v_closed FROM public.expenses e WHERE e.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.expense_id ELSE NEW.expense_id END;
    IF v_closed IS NOT NULL THEN
      RAISE EXCEPTION 'The leftovers on this receipt have already been shared; ask the person who paid to reopen it' USING ERRCODE = 'P0001', HINT = 'claims_closed';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
DROP TRIGGER IF EXISTS trg_guard_line_items_closed ON public.expense_line_items;
CREATE TRIGGER trg_guard_line_items_closed BEFORE INSERT OR UPDATE OR DELETE ON public.expense_line_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_line_items_closed();

-- respond_to_receipt: answer / undo through the SAME lock order as every other writer (freeze lock, expense lock, THEN the response row). A direct PostgREST write to
-- expense_claim_responses still works (its guard takes the locks too) but its row lock is taken BEFORE the guard can take them; the app uses this RPC so that cannot
-- deadlock with a payer's edit. p_response: 'done' | 'not_there' | 'undo' (deletes the caller's answer). Same refusals as the table guard for a client:
-- frozen, claims_closed, deadline_passed, payer_not_there, has_claims, has_leftovers; forbidden when the caller is not on the trip.
CREATE OR REPLACE FUNCTION public.respond_to_receipt(p_expense_id uuid, p_response text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_trip uuid;
  v_state jsonb;
  v_resp text := lower(btrim(coalesce(p_response, '')));
  v_cur text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501', HINT = 'auth';
  END IF;
  IF v_resp NOT IN ('done', 'not_there', 'undo') THEN
    RAISE EXCEPTION 'Unknown answer' USING ERRCODE = '22023', HINT = 'bad_input';
  END IF;
  SELECT e.trip_id INTO v_trip FROM public.expenses e WHERE e.id = p_expense_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found' USING ERRCODE = 'P0002', HINT = 'not_found';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('settlement_freeze:' || v_trip::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('receipt_claims:' || p_expense_id::text, 0));
  v_state := public._receipt_response_state(p_expense_id, v_uid);
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'You are not on this trip' USING ERRCODE = '42501', HINT = 'forbidden';
  END IF;
  IF coalesce((v_state ->> 'frozen')::boolean, false) THEN
    RAISE EXCEPTION 'Balances are frozen for this trip. Ask an organizer to unfreeze before changing who had what.' USING ERRCODE = 'P0001', HINT = 'frozen';
  END IF;
  IF coalesce((v_state ->> 'closed')::boolean, false) THEN
    RAISE EXCEPTION 'The leftovers on this receipt have already been shared' USING ERRCODE = 'P0001', HINT = 'claims_closed';
  END IF;
  IF coalesce((v_state ->> 'deadline_passed')::boolean, false) THEN
    RAISE EXCEPTION 'The deadline for this receipt has passed' USING ERRCODE = 'P0001', HINT = 'deadline_passed';
  END IF;
  SELECT r.response INTO v_cur FROM public.expense_claim_responses r WHERE r.expense_id = p_expense_id AND r.user_id = v_uid;
  IF v_resp = 'undo' THEN
    DELETE FROM public.expense_claim_responses WHERE expense_id = p_expense_id AND user_id = v_uid;
  ELSE
    INSERT INTO public.expense_claim_responses (expense_id, user_id, response) VALUES (p_expense_id, v_uid, v_resp)
    ON CONFLICT (expense_id, user_id) DO UPDATE SET response = excluded.response, responded_at = now();
  END IF;
  RETURN jsonb_build_object('expense_id', p_expense_id, 'response', CASE WHEN v_resp = 'undo' THEN NULL ELSE v_resp END, 'previous', v_cur, 'changed', v_cur IS DISTINCT FROM CASE WHEN v_resp = 'undo' THEN NULL ELSE v_resp END);
END
$$;

-- reopen_receipt_claims: the way back from a closed receipt (payer or manager; not on a frozen trip). Takes the leftover parts out (they are rebuilt at the next share),
-- clears leftover_mode, claims_closed_at, sets a new deadline (default: the standard one), keeps every answer, moves the links' expiry. After this, claims can change again
-- (in-app and links) and reitemize_expense works; the daily job applies at the new deadline. Returns who had been charged (the client may tell them it is open again).
CREATE OR REPLACE FUNCTION public.reopen_receipt_claims(p_expense_id uuid, p_deadline timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_exp public.expenses;
  v_deadline timestamptz;
  v_people jsonb;
  v_waiting uuid[];
  v_notices boolean;
  v_status text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501', HINT = 'auth';
  END IF;
  v_exp := public._receipt_begin(p_expense_id, true);
  IF v_exp.claims_closed_at IS NULL THEN
    RAISE EXCEPTION 'This receipt is not closed' USING ERRCODE = 'P0001', HINT = 'not_closed';
  END IF;
  IF p_deadline IS NOT NULL AND (p_deadline <= now() OR p_deadline > now() + interval '90 days') THEN
    RAISE EXCEPTION 'The deadline must be in the future, within 90 days' USING ERRCODE = '22023', HINT = 'bad_deadline';
  END IF;
  v_deadline := coalesce(p_deadline, public._receipt_default_deadline());
  SELECT coalesce(jsonb_agg(jsonb_build_object('user_id', x.uid, 'amount', x.amt) ORDER BY x.uid), '[]'::jsonb) INTO v_people
  FROM (SELECT cl.user_id AS uid, sum(cl.leftover_amount) AS amt FROM public.expense_item_claims cl
        WHERE cl.expense_id = p_expense_id GROUP BY cl.user_id HAVING sum(cl.leftover_amount) > 0) x;
  PERFORM public._receipt_strip_leftovers(p_expense_id);
  UPDATE public.expenses SET leftover_mode = NULL, leftover_user_id = NULL, claims_closed_at = NULL, claim_deadline = v_deadline WHERE id = p_expense_id;
  PERFORM public._receipt_sync_token_expiry(p_expense_id);
  v_status := public._receipt_refresh_status(p_expense_id);
  SELECT coalesce(t.receipt_notices_enabled, true) INTO v_notices FROM public.trips t WHERE t.id = v_exp.trip_id;
  SELECT coalesce(array_agg(x ORDER BY x), ARRAY[]::uuid[]) INTO v_waiting
  FROM unnest(public._receipt_tagged(p_expense_id)) AS x
  WHERE x IS DISTINCT FROM v_uid AND NOT EXISTS (SELECT 1 FROM public.expense_claim_responses r WHERE r.expense_id = p_expense_id AND r.user_id = x);
  INSERT INTO public.activity_feed (trip_id, actor, verb, entity, metadata)
  VALUES (v_exp.trip_id, v_uid, 'receipt_reopened', jsonb_build_object('type', 'expense', 'id', p_expense_id, 'label', v_exp.description),
          jsonb_build_object('claim_deadline', v_deadline, 'was_charged', v_people));
  RETURN jsonb_build_object('expense_id', p_expense_id, 'trip_id', v_exp.trip_id, 'title', v_exp.description, 'reopened', true, 'claim_deadline', v_deadline,
                            'was_charged', v_people, 'status', v_status, 'notices_enabled', v_notices,
                            'waiting_user_ids', CASE WHEN v_notices THEN to_jsonb(v_waiting) ELSE '[]'::jsonb END);
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public._receipt_tagged(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._receipt_leftover_confirmed(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._receipt_token_name(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._receipt_default_deadline() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._receipt_can_toggle(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._receipt_claim_view(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._receipt_token_lookup(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_claim_response() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_expense_claim_state() FROM PUBLIC, anon, authenticated, service_role;
-- the response guard runs as the CLIENT, so the client roles need EXECUTE on _receipt_response_state (booleans only; NULL for non-members). The policies use the live is_trip_participant helper.
REVOKE ALL ON FUNCTION public._expense_trip_member(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._receipt_response_state(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._receipt_response_state(uuid, uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.send_receipt_to_table(uuid, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.extend_receipt_deadline(uuid, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.apply_receipt_deadline(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_receipt_to_table(uuid, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.extend_receipt_deadline(uuid, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_receipt_deadline(uuid, boolean) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.respond_to_receipt(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.respond_to_receipt(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.reopen_receipt_claims(uuid, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reopen_receipt_claims(uuid, timestamptz) TO authenticated;
REVOKE ALL ON FUNCTION public._receipt_begin(uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._receipt_reshare_mode(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._receipt_sync_token_expiry(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._receipt_resplit_table_items(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._receipt_after_tagged_change(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.after_claim_response() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.clear_done_on_claim_change() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_claim_closed() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_line_items_closed() FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.reitemize_expense(uuid, jsonb, jsonb, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reitemize_expense(uuid, jsonb, jsonb, boolean) TO authenticated;
REVOKE ALL ON FUNCTION public._reitemize_num(jsonb, text, integer, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.unfreeze_settlements(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unfreeze_settlements(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.issue_receipt_claim_token(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.receipt_claim_peek(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.receipt_claim_act(text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.receipt_claim_rate_hit(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.issue_receipt_claim_token(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.receipt_claim_peek(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.receipt_claim_act(text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.receipt_claim_rate_hit(text, integer, integer) TO service_role;

NOTIFY pgrst, 'reload schema';
