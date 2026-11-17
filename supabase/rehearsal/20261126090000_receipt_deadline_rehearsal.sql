-- RECEIPT DEADLINE + LINKS REHEARSAL (generated from supabase/rehearsal/rehearsal_phase2.template.sql + the migration by scripts/build-rehearsal.mjs; do not edit
-- this file by hand). ONE batch that applies migration 20261126090000 (phase 1, 20261124090000, is already live), exercises it on the private test trip, then ENDS WITH
-- AN ERROR so that EVERYTHING ROLLS BACK. The result is the final error message: "REHEARSAL PASS [...]" or "REHEARSAL FAIL [...]". See supabase/rehearsal/README.md.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TEMP TABLE _rehearsal (step text, ok boolean, detail text);
CREATE TEMP TABLE _rh_ctx (k text PRIMARY KEY, v text);
CREATE FUNCTION pg_temp.rh_rec(p_step text, p_ok boolean, p_detail text) RETURNS void LANGUAGE sql AS $f$
  INSERT INTO _rehearsal VALUES (p_step, coalesce(p_ok, false), left(p_detail, 400))
$f$;
CREATE FUNCTION pg_temp.rh_ctx(p_k text) RETURNS text LANGUAGE sql STABLE AS $f$
  SELECT v FROM _rh_ctx WHERE k = p_k
$f$;
-- Impersonation: what PostgREST does for a signed-in user (claims set transaction-locally); the caller then runs SET LOCAL ROLE authenticated.
CREATE FUNCTION pg_temp.rh_jwt(p_uid uuid) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
END
$f$;
-- The service key: no user, claims role service_role. NO `SET ROLE service_role` (never proven on live): the statements run as the session user; every function under test
-- is SECURITY DEFINER and checks auth.role() itself.
CREATE FUNCTION pg_temp.rh_svc() RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
END
$f$;

-- ===== 0a. BEFORE the migration: what is live is what 20261124090000 shipped (the migration replaces two of these functions) =====================
DO $rh$
DECLARE
  v_t text; v_c text; v_cols integer; v_notif integer; v_act integer; v_u text; v_bg text;
BEGIN
  BEGIN
    SELECT md5(prosrc) INTO v_t FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = '_receipt_tagged';
    SELECT md5(prosrc) INTO v_c FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = '_receipt_leftover_confirmed';
    SELECT count(*) INTO v_cols FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'expense_item_claims' AND column_name IN ('leftover_quantity', 'leftover_amount');
    SELECT count(*) INTO v_notif FROM public.notifications;
    SELECT count(*) INTO v_act FROM public.activity_feed;
    INSERT INTO _rh_ctx VALUES ('notif0', v_notif::text), ('act0', v_act::text);
    PERFORM pg_temp.rh_rec('pre.phase1_live', v_t = '3fb9669b56045306d97fae8ad1394f5b' AND v_c = 'a09c7c73162dbe9a106fd8485b29bd28' AND v_cols = 2,
      format('_receipt_tagged md5=%s (want 3fb9669b56045306d97fae8ad1394f5b) _receipt_leftover_confirmed md5=%s (want a09c7c73162dbe9a106fd8485b29bd28) leftover columns=%s', v_t, v_c, v_cols));
    SELECT md5(prosrc) INTO v_bg FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = '_receipt_begin';
    PERFORM pg_temp.rh_rec('pre.begin_live', v_bg = '71b9ad95120b15ad653bc59c2c15f587', format('live _receipt_begin md5=%s (shipped 71b9ad95120b15ad653bc59c2c15f587): the migration replaces it with a one-block superset', v_bg));
    SELECT md5(prosrc) INTO v_u FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'unfreeze_settlements';
    PERFORM pg_temp.rh_rec('pre.unfreeze_live', v_u = '1ec90283bba01dfbbb4b4a7bd26df64b', format('live unfreeze_settlements md5=%s (repo text 1ec90283bba01dfbbb4b4a7bd26df64b): if different STOP and read the live body before applying', v_u));
    PERFORM pg_temp.rh_rec('pre.names_free', NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'expenses' AND column_name IN ('claim_deadline', 'claims_sent_at', 'claims_closed_at'))
      AND to_regclass('public.expense_claim_responses') IS NULL AND to_regclass('public.receipt_claim_tokens') IS NULL AND to_regprocedure('public.send_receipt_to_table(uuid,timestamptz)') IS NULL AND to_regprocedure('public.reitemize_expense(uuid,jsonb,jsonb,boolean)') IS NULL AND to_regprocedure('public.reopen_receipt_claims(uuid,timestamptz)') IS NULL,
      'no phase-2 column, table or function exists yet');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.rh_rec('pre', false, 'ERROR ' || SQLSTATE || ' ' || SQLERRM);
  END;
END
$rh$;

-- ===== BEGIN MIGRATION (verbatim copy of supabase/migrations/20261126090000_receipt_deadline_tokens.sql) =====
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
-- ===== END MIGRATION =====

-- ===== 0. the test trip, the two people ==========================================================================================
DO $rh$
DECLARE
  v_trip constant uuid := 'be551bc4-a524-4b6a-a0c9-b74a7168ced4';
  v_a uuid; v_b uuid; v_name text; v_frozen boolean; v_a_in boolean; v_b_mgr boolean; v_n integer;
BEGIN
  BEGIN
    SELECT t.created_by, t.name, t.settlement_snapshot IS NOT NULL INTO v_a, v_name, v_frozen FROM public.trips t WHERE t.id = v_trip;
    IF NOT FOUND THEN
      PERFORM pg_temp.rh_rec('setup.trip', false, 'test trip be551bc4-... not found');
      RETURN;
    END IF;
    SELECT EXISTS (SELECT 1 FROM public.trip_participants tp WHERE tp.trip_id = v_trip AND tp.user_id = v_a) INTO v_a_in;
    SELECT tp.user_id INTO v_b FROM public.trip_participants tp
     WHERE tp.trip_id = v_trip AND tp.user_id <> v_a AND coalesce(tp.active, true)
     ORDER BY public._settlement_can_manage(v_trip, tp.user_id), tp.user_id LIMIT 1;
    SELECT count(*) INTO v_n FROM public.trip_participants tp WHERE tp.trip_id = v_trip;
    IF v_b IS NOT NULL THEN v_b_mgr := public._settlement_can_manage(v_trip, v_b); END IF;
    INSERT INTO _rh_ctx VALUES ('trip', v_trip::text), ('a', v_a::text), ('b_manager', coalesce(v_b_mgr, false)::text);
    IF v_b IS NOT NULL THEN INSERT INTO _rh_ctx VALUES ('b', v_b::text); END IF;
    IF v_frozen THEN
      UPDATE public.trips SET settlement_snapshot = NULL WHERE id = v_trip;   -- rolled back with everything else
    END IF;
    PERFORM pg_temp.rh_rec('setup.trip', v_a IS NOT NULL AND v_b IS NOT NULL AND v_a_in,
      format('name=%s organizer_in_trip=%s participants=%s B_can_manage=%s was_frozen=%s', v_name, v_a_in, v_n, v_b_mgr, v_frozen));
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.rh_rec('setup.trip', false, 'ERROR ' || SQLSTATE || ' ' || SQLERRM);
  END;
END
$rh$;

-- ===== 1. structure after apply ===================================================================================================
DO $rh$
DECLARE
  v_n integer; v_txt text; v_bad text := ''; r record;
BEGIN
  BEGIN
    SELECT string_agg(x.t || '.' || x.c, ',') INTO v_txt FROM (VALUES
      ('expenses', 'claim_deadline'), ('expenses', 'claims_sent_at'), ('expenses', 'claims_closed_at'), ('trips', 'receipt_notices_enabled')) x(t, c)
     WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns k WHERE k.table_schema = 'public' AND k.table_name = x.t AND k.column_name = x.c);
    PERFORM pg_temp.rh_rec('struct.columns', v_txt IS NULL
      AND (SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'trips' AND column_name = 'receipt_notices_enabled') = 'NO'
      AND NOT EXISTS (SELECT 1 FROM public.trips WHERE receipt_notices_enabled IS NOT TRUE)
      AND NOT EXISTS (SELECT 1 FROM public.expenses WHERE claim_deadline IS NOT NULL OR claims_sent_at IS NOT NULL OR claims_closed_at IS NOT NULL),
      coalesce('missing: ' || v_txt, '4 columns present; every trip has notices on; no expense has claim state yet'));

    SELECT string_agg(c.relname || ' rls=' || c.relrowsecurity || ' policies=' || (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname), '; ' ORDER BY c.relname)
      INTO v_txt FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('expense_claim_responses', 'receipt_claim_tokens', 'receipt_claim_rate_limits');
    PERFORM pg_temp.rh_rec('struct.tables', v_txt = 'expense_claim_responses rls=true policies=4; receipt_claim_rate_limits rls=true policies=0; receipt_claim_tokens rls=true policies=0', v_txt);

    SELECT string_agg(x.t || '.' || x.n, ',') INTO v_txt FROM (VALUES
      ('expenses', 'trg_guard_expense_claim_state'), ('expenses', 'trg_guard_expense_leftover_mode'), ('expense_claim_responses', 'trg_guard_claim_response'),
      ('expense_item_claims', 'trigger_auto_update_expense_status'), ('expense_item_claims', 'trg_clear_done_on_claim_change'), ('expense_item_claims', 'trg_guard_claim_closed'),
      ('expense_claim_responses', 'trg_after_claim_response'), ('expense_line_items', 'trg_guard_line_items_closed')) x(t, n)
     WHERE NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = ('public.' || x.t)::regclass AND g.tgname = x.n AND NOT g.tgisinternal AND g.tgenabled = 'O');
    PERFORM pg_temp.rh_rec('struct.triggers', v_txt IS NULL, coalesce('missing/disabled: ' || v_txt, 'new + live triggers enabled'));

    SELECT count(*) INTO v_n FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('freeze_settlements');
    PERFORM pg_temp.rh_rec('struct.freeze_untouched', v_n = 1 AND (SELECT md5(prosrc) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'freeze_settlements') = '7b507c2ec453c532fd598e533d2625c5',
      'freeze_settlements still the phase-1 body (md5 7b507c2e...)');

    FOR r IN SELECT * FROM (VALUES
      ('public._receipt_tagged(uuid)', false, false, null),
      ('public._receipt_leftover_confirmed(uuid)', false, false, null),
      ('public._receipt_claim_view(uuid,uuid)', false, false, null),
      ('public._receipt_can_toggle(uuid,uuid)', false, false, null),
      ('public._receipt_token_lookup(text)', false, false, null),
      ('public.guard_claim_response()', false, false, false),
      ('public.guard_expense_claim_state()', false, false, false),
      ('public._expense_trip_member(uuid,uuid)', false, false, null),
      ('public._receipt_response_state(uuid,uuid)', false, true, true),
      ('public.reopen_receipt_claims(uuid,timestamptz)', false, true, null),
      ('public._receipt_begin(uuid,boolean)', false, false, null),
      ('public._receipt_reshare_mode(uuid)', false, false, null),
      ('public._receipt_resplit_table_items(uuid)', false, false, null),
      ('public.after_claim_response()', false, false, false),
      ('public.clear_done_on_claim_change()', false, false, false),
      ('public.guard_claim_closed()', false, false, false),
      ('public.guard_line_items_closed()', false, false, false),
      ('public.respond_to_receipt(uuid,text)', false, true, null),
      ('public.send_receipt_to_table(uuid,timestamptz)', false, true, null),
      ('public.extend_receipt_deadline(uuid,timestamptz)', false, true, null),
      ('public.apply_receipt_deadline(uuid,boolean)', false, true, true),
      ('public.issue_receipt_claim_token(uuid,uuid,text)', false, false, true),
      ('public.receipt_claim_peek(text)', false, false, true),
      ('public.receipt_claim_act(text,text,jsonb)', false, false, true),
      ('public.receipt_claim_rate_hit(text,integer,integer)', false, false, true),
      ('public.reitemize_expense(uuid,jsonb,jsonb,boolean)', false, true, null),
      ('public.unfreeze_settlements(uuid)', false, true, null),
      ('public._reitemize_num(jsonb,text,integer,numeric)', false, false, null)
    ) AS x(f, want_anon, want_auth, want_service) LOOP
      IF has_function_privilege('anon', r.f, 'EXECUTE') IS DISTINCT FROM r.want_anon
         OR has_function_privilege('authenticated', r.f, 'EXECUTE') IS DISTINCT FROM r.want_auth
         OR (r.want_service IS NOT NULL AND has_function_privilege('service_role', r.f, 'EXECUTE') IS DISTINCT FROM r.want_service) THEN
        v_bad := v_bad || r.f || ' ';
      END IF;
    END LOOP;
    IF has_table_privilege('anon', 'public.expense_claim_responses', 'SELECT') OR has_table_privilege('authenticated', 'public.receipt_claim_tokens', 'SELECT')
       OR has_table_privilege('authenticated', 'public.receipt_claim_rate_limits', 'SELECT') OR NOT has_table_privilege('service_role', 'public.receipt_claim_tokens', 'INSERT') THEN
      v_bad := v_bad || 'table-privileges ';
    END IF;
    PERFORM pg_temp.rh_rec('struct.privileges', v_bad = '', CASE WHEN v_bad = '' THEN '30 functions + 3 tables: anon/authenticated/service_role as intended' ELSE 'wrong: ' || v_bad END);

    -- the impersonation the link functions rely on: auth.uid()/auth.role() follow the transaction-local settings
    PERFORM set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
    PERFORM set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM pg_temp.rh_rec('struct.auth_follows_settings', auth.uid() = '11111111-1111-1111-1111-111111111111'::uuid AND auth.role() = 'authenticated',
      'auth.uid()=' || coalesce(auth.uid()::text, 'null') || ' auth.role()=' || coalesce(auth.role(), 'null'));
    PERFORM pg_temp.rh_svc();
    PERFORM pg_temp.rh_rec('struct.auth_service_role', auth.uid() IS NULL AND auth.role() = 'service_role', 'uid=' || coalesce(auth.uid()::text, 'null') || ' role=' || coalesce(auth.role(), 'null'));
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.rh_rec('struct', false, 'ERROR ' || SQLSTATE || ' ' || SQLERRM);
  END;
END
$rh$;

-- ===== 2. the test receipt: A pays, A and B are on it. Pizza 12.00 to B, beers 12.00 (3 units) shared, dessert 6.00 left open ==========================
DO $rh$
DECLARE
  v_trip uuid := pg_temp.rh_ctx('trip')::uuid; v_a uuid := pg_temp.rh_ctx('a')::uuid; v_b uuid := pg_temp.rh_ctx('b')::uuid;
  v_e uuid; v_l1 uuid; v_l2 uuid; v_l3 uuid; v_r jsonb;
BEGIN
  IF v_a IS NULL OR v_b IS NULL THEN
    PERFORM pg_temp.rh_rec('setup.expense', false, 'no test trip / people');
    RETURN;
  END IF;
  BEGIN
    PERFORM pg_temp.rh_jwt(v_a);
    SET LOCAL ROLE authenticated;
    INSERT INTO public.expenses (trip_id, paid_by, amount, currency, description, status, ai_parsed, participant_ids)
    VALUES (v_trip, v_a, 30.00, 'GBP', 'REHEARSAL deadline receipt (rolled back)', 'unallocated', true, ARRAY[v_a, v_b])
    RETURNING id INTO v_e;
    INSERT INTO public.expense_line_items (expense_id, line_number, name_original, quantity, unit_price, subtotal, total_amount)
    VALUES (v_e, 1, 'Rehearsal pizza', 1, 12.00, 12.00, 12.00) RETURNING id INTO v_l1;
    INSERT INTO public.expense_line_items (expense_id, line_number, name_original, quantity, unit_price, subtotal, total_amount)
    VALUES (v_e, 2, 'Rehearsal beers x3', 3, 4.00, 12.00, 12.00) RETURNING id INTO v_l2;
    INSERT INTO public.expense_line_items (expense_id, line_number, name_original, quantity, unit_price, subtotal, total_amount)
    VALUES (v_e, 3, 'Rehearsal dessert', 1, 6.00, 6.00, 6.00) RETURNING id INTO v_l3;
    v_r := public.set_receipt_claims(v_e, jsonb_build_array(
      jsonb_build_object('line_item_id', v_l1, 'user_ids', jsonb_build_array(v_b)),
      jsonb_build_object('line_item_id', v_l2, 'user_ids', jsonb_build_array(v_a, v_b))));
    RESET ROLE;
    INSERT INTO _rh_ctx VALUES ('e', v_e::text), ('l1', v_l1::text), ('l2', v_l2::text), ('l3', v_l3::text);
    PERFORM pg_temp.rh_rec('setup.expense', (v_r ->> 'unclaimed_total')::numeric = 6.00,
      'GBP 30.00: pizza 12 -> B; beers 12 shared A+B; dessert 6 open. unclaimed_total=' || (v_r ->> 'unclaimed_total'));
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM pg_temp.rh_rec('setup.expense', false, 'ERROR ' || SQLSTATE || ' ' || SQLERRM);
  END;
END
$rh$;

-- ===== 3. A sends it to the table; clients cannot write the claim-state columns ====================================================================
DO $rh$
DECLARE
  v_a uuid := pg_temp.rh_ctx('a')::uuid; v_b uuid := pg_temp.rh_ctx('b')::uuid; v_e uuid := pg_temp.rh_ctx('e')::uuid;
  v_r jsonb; v_r2 jsonb; v_dl timestamptz; v_hint text; v_d2 timestamptz; v_n integer;
BEGIN
  IF v_e IS NULL THEN PERFORM pg_temp.rh_rec('send', false, 'no test expense'); RETURN; END IF;
  -- 3a. A (payer) sends, as the authenticated role
  BEGIN
    PERFORM pg_temp.rh_jwt(v_a);
    SET LOCAL ROLE authenticated;
    v_r := public.send_receipt_to_table(v_e);
    v_r2 := public.send_receipt_to_table(v_e);
    RESET ROLE;
    v_dl := (v_r ->> 'claim_deadline')::timestamptz;
    SELECT count(*) INTO v_n FROM public.activity_feed WHERE verb = 'receipt_sent_to_table' AND entity ->> 'id' = v_e::text;
    PERFORM pg_temp.rh_rec('send.first', (v_r ->> 'first_send')::boolean AND (v_r -> 'notify_user_ids') = jsonb_build_array(v_b)
      AND extract(hour FROM v_dl AT TIME ZONE 'UTC') = 18 AND extract(minute FROM v_dl AT TIME ZONE 'UTC') = 0 AND v_dl > now() + interval '2 days 17 hours' AND v_dl < now() + interval '3 days 19 hours',
      format('first_send=%s deadline=%s notify=%s', v_r ->> 'first_send', v_dl, v_r ->> 'notify_user_ids'));
    PERFORM pg_temp.rh_rec('send.idempotent', NOT (v_r2 ->> 'first_send')::boolean AND NOT (v_r2 ->> 'changed')::boolean AND v_r2 ->> 'claim_deadline' = v_r ->> 'claim_deadline' AND v_n = 1,
      format('second call first_send=%s changed=%s activity rows=%s', v_r2 ->> 'first_send', v_r2 ->> 'changed', v_n));
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM pg_temp.rh_rec('send.first', false, 'ERROR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- 3b. B (not payer, not a manager) cannot send or extend
  BEGIN
    PERFORM pg_temp.rh_jwt(v_b);
    SET LOCAL ROLE authenticated;
    PERFORM public.extend_receipt_deadline(v_e, now() + interval '5 days');
    RESET ROLE;
    PERFORM pg_temp.rh_rec('send.ordinary_person_refused', coalesce(pg_temp.rh_ctx('b_manager')::boolean, false), CASE WHEN pg_temp.rh_ctx('b_manager')::boolean THEN 'SKIPPED: B can manage this trip' ELSE 'NOT refused' END);
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    PERFORM pg_temp.rh_rec('send.ordinary_person_refused', SQLSTATE = '42501' AND v_hint = 'forbidden', SQLSTATE || ' hint=' || coalesce(v_hint, '') || ' ' || SQLERRM);
  END;

  -- 3c. B writes the deadline directly (participants may UPDATE trip expenses): the guard keeps the old values
  BEGIN
    SELECT claim_deadline INTO v_dl FROM public.expenses WHERE id = v_e;
    PERFORM pg_temp.rh_jwt(v_b);
    SET LOCAL ROLE authenticated;
    UPDATE public.expenses SET claim_deadline = now() + interval '40 days', claims_closed_at = now(), claims_sent_at = NULL WHERE id = v_e;
    RESET ROLE;
    SELECT claim_deadline INTO v_d2 FROM public.expenses WHERE id = v_e;
    PERFORM pg_temp.rh_rec('guard.expense_state_pinned', v_d2 = v_dl AND (SELECT claims_closed_at IS NULL AND claims_sent_at IS NOT NULL FROM public.expenses WHERE id = v_e),
      format('deadline unchanged=%s closed_at null and sent_at kept=%s (or the UPDATE was not allowed for B at all)', v_d2 = v_dl, (SELECT claims_closed_at IS NULL AND claims_sent_at IS NOT NULL FROM public.expenses WHERE id = v_e)));
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    SELECT claim_deadline INTO v_d2 FROM public.expenses WHERE id = v_e;
    PERFORM pg_temp.rh_rec('guard.expense_state_pinned', v_d2 = v_dl, 'UPDATE refused (' || SQLSTATE || '); deadline unchanged=' || (v_d2 = v_dl));
  END;
END
$rh$;

-- ===== 4. responses as signed-in clients (RLS + guard) ===============================================================================================
DO $rh$
DECLARE
  v_a uuid := pg_temp.rh_ctx('a')::uuid; v_b uuid := pg_temp.rh_ctx('b')::uuid; v_e uuid := pg_temp.rh_ctx('e')::uuid; v_trip uuid := pg_temp.rh_ctx('trip')::uuid;
  v_hint text; v_n integer; v_resp text; v_when timestamptz;
BEGIN
  IF v_e IS NULL THEN PERFORM pg_temp.rh_rec('responses', false, 'no test expense'); RETURN; END IF;
  -- 4a. B says "That's everything" (own row) and cannot answer for A
  BEGIN
    PERFORM pg_temp.rh_jwt(v_b);
    SET LOCAL ROLE authenticated;
    INSERT INTO public.expense_claim_responses (expense_id, user_id, response, responded_at) VALUES (v_e, v_b, 'done', '2001-01-01');
    RESET ROLE;
    SELECT response, responded_at INTO v_resp, v_when FROM public.expense_claim_responses WHERE expense_id = v_e AND user_id = v_b;
    PERFORM pg_temp.rh_rec('responses.own_done', v_resp = 'done' AND v_when > now() - interval '1 minute', format('response=%s responded_at fresh=%s', v_resp, v_when > now() - interval '1 minute'));
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM pg_temp.rh_rec('responses.own_done', false, 'ERROR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    PERFORM pg_temp.rh_jwt(v_b);
    SET LOCAL ROLE authenticated;
    INSERT INTO public.expense_claim_responses (expense_id, user_id, response) VALUES (v_e, v_a, 'done');
    RESET ROLE;
    PERFORM pg_temp.rh_rec('responses.cannot_answer_for_others', false, 'NOT refused');
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM pg_temp.rh_rec('responses.cannot_answer_for_others', SQLSTATE = '42501', SQLSTATE || ' ' || SQLERRM);
  END;
  -- 4b. A (payer) cannot be "not there"; B holds claims so cannot be either
  BEGIN
    PERFORM pg_temp.rh_jwt(v_a);
    SET LOCAL ROLE authenticated;
    INSERT INTO public.expense_claim_responses (expense_id, user_id, response) VALUES (v_e, v_a, 'not_there');
    RESET ROLE;
    PERFORM pg_temp.rh_rec('responses.payer_not_there_refused', false, 'NOT refused');
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    PERFORM pg_temp.rh_rec('responses.payer_not_there_refused', v_hint = 'payer_not_there', SQLSTATE || ' hint=' || coalesce(v_hint, '') || ' ' || SQLERRM);
  END;
  BEGIN
    PERFORM pg_temp.rh_jwt(v_b);
    SET LOCAL ROLE authenticated;
    UPDATE public.expense_claim_responses SET response = 'not_there' WHERE expense_id = v_e AND user_id = v_b;
    RESET ROLE;
    PERFORM pg_temp.rh_rec('responses.has_claims_refused', false, 'NOT refused');
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    PERFORM pg_temp.rh_rec('responses.has_claims_refused', v_hint = 'has_claims', SQLSTATE || ' hint=' || coalesce(v_hint, '') || ' ' || SQLERRM);
  END;
  -- 4c. A sees B's answer (trip members read all answers); the confirmed set is {B}
  BEGIN
    PERFORM pg_temp.rh_jwt(v_a);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_n FROM public.expense_claim_responses WHERE expense_id = v_e;
    RESET ROLE;
    PERFORM pg_temp.rh_rec('responses.members_can_read', v_n = 1 AND public._receipt_leftover_confirmed(v_e) @> ARRAY[v_b, v_a] AND cardinality(public._receipt_leftover_confirmed(v_e)) = 2, format('A sees %s answer(s); confirmed set = %s', v_n, public._receipt_leftover_confirmed(v_e)));
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM pg_temp.rh_rec('responses.members_can_read', false, 'ERROR ' || SQLSTATE || ' ' || SQLERRM);
  END;
END
$rh$;

-- ===== 5. personal links (service role): issue, peek, undo, toggle as the person, wrong/expired tokens =================================================
DO $rh$
DECLARE
  v_b uuid := pg_temp.rh_ctx('b')::uuid; v_e uuid := pg_temp.rh_ctx('e')::uuid; v_l2 uuid := pg_temp.rh_ctx('l2')::uuid; v_a uuid := pg_temp.rh_ctx('a')::uuid;
  v_hash text := encode(sha256(convert_to('rehearsal-token-' || gen_random_uuid()::text, 'UTF8')), 'hex');
  v_hash2 text := encode(sha256(convert_to('rehearsal-token-' || gen_random_uuid()::text, 'UTF8')), 'hex');
  v_r jsonb; v_r2 jsonb; v_r3 jsonb; v_r4 jsonb; v_n integer; v_uid uuid; v_role text; v_a_beer numeric; v_b_beer integer; v_hint text; v_by uuid; v_rl1 boolean; v_rl2 boolean; v_rl3 boolean;
BEGIN
  IF v_e IS NULL THEN PERFORM pg_temp.rh_rec('links', false, 'no test expense'); RETURN; END IF;
  -- 5a. a signed-in client cannot call the token functions at all
  BEGIN
    PERFORM pg_temp.rh_jwt(v_b);
    SET LOCAL ROLE authenticated;
    PERFORM public.receipt_claim_peek(v_hash);
    RESET ROLE;
    PERFORM pg_temp.rh_rec('links.client_refused', false, 'NOT refused');
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM pg_temp.rh_rec('links.client_refused', SQLSTATE IN ('42501'), SQLSTATE || ' ' || SQLERRM);
  END;
  -- 5b. issue + peek
  BEGIN
    PERFORM pg_temp.rh_svc();
    v_r := public.issue_receipt_claim_token(v_e, v_b, v_hash);
    PERFORM public.issue_receipt_claim_token(v_e, v_a, v_hash2);
    RESET ROLE;
    PERFORM pg_temp.rh_rec('links.issue', v_r ->> 'result' = 'issued' AND (SELECT token_hash FROM public.receipt_claim_tokens WHERE token_hash = v_hash) = v_hash
      AND abs(extract(epoch FROM (v_r ->> 'expires_at')::timestamptz - (SELECT claim_deadline FROM public.expenses WHERE id = v_e)) - 7 * 86400) < 2, v_r::text);
    PERFORM pg_temp.rh_svc();
    v_r := public.receipt_claim_peek(v_hash);
    v_r2 := public.receipt_claim_peek(encode(sha256('nope'::bytea), 'hex'));
    RESET ROLE;
    PERFORM pg_temp.rh_rec('links.peek', v_r ->> 'result' = 'ok' AND v_r #>> '{me,user_id}' = v_b::text AND (v_r ->> 'editable')::boolean AND v_r ->> 'response' = 'done'
      AND jsonb_array_length(v_r -> 'my_items') = 2 AND (v_r ->> 'my_total')::numeric = 18.00 AND (v_r ->> 'unclaimed_total')::numeric = 6.00,
      format('result=%s response=%s my_items=%s my_total=%s unclaimed=%s', v_r ->> 'result', v_r ->> 'response', jsonb_array_length(v_r -> 'my_items'), v_r ->> 'my_total', v_r ->> 'unclaimed_total'));
    PERFORM pg_temp.rh_rec('links.unknown_token', v_r2 ->> 'result' = 'not_found', 'not_found');
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM pg_temp.rh_rec('links.issue', false, 'ERROR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  -- 5c. B takes himself off the beers through the link (runs set_receipt_claims AS B), then back on; the settings are restored
  BEGIN
    PERFORM pg_temp.rh_svc();
    v_r := public.receipt_claim_act(v_hash, 'toggle', jsonb_build_object('line_item_id', v_l2, 'on', false));
    v_uid := auth.uid(); v_role := auth.role();
    RESET ROLE;
    SELECT sum(amount_owed) INTO v_a_beer FROM public.expense_item_claims WHERE line_item_id = v_l2 AND user_id = v_a;
    SELECT count(*) INTO v_b_beer FROM public.expense_item_claims WHERE line_item_id = v_l2 AND user_id = v_b;
    PERFORM pg_temp.rh_rec('links.toggle_off', v_r ->> 'result' = 'ok' AND (v_r ->> 'changed')::boolean AND v_a_beer = 12.00 AND v_b_beer = 0,
      format('result=%s A beers=%s B rows on beers=%s', v_r ->> 'result', v_a_beer, v_b_beer));
    PERFORM pg_temp.rh_rec('links.impersonation_restored', v_uid IS NULL AND v_role = 'service_role', 'after the call: uid=' || coalesce(v_uid::text, 'null') || ' role=' || coalesce(v_role, 'null'));
    PERFORM pg_temp.rh_svc();
    v_r := public.receipt_claim_act(v_hash, 'toggle', jsonb_build_object('line_item_id', v_l2, 'on', true));
    RESET ROLE;
    SELECT created_by INTO v_by FROM public.expense_item_claims WHERE line_item_id = v_l2 AND user_id = v_b;
    SELECT count(*) INTO v_n FROM public.expense_item_claims WHERE line_item_id = v_l2 AND amount_owed = 6.00 AND quantity_claimed = 1.50;
    PERFORM pg_temp.rh_rec('links.toggle_on', v_r ->> 'result' = 'ok' AND v_n = 2 AND v_by = v_b, format('result=%s halves=%s created_by_is_B=%s', v_r ->> 'result', v_n, v_by = v_b));
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM pg_temp.rh_rec('links.toggle_off', false, 'ERROR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  -- 5d. undo and redo "That's everything"; payer cannot say not_there; expired link is reported
  BEGIN
    PERFORM pg_temp.rh_svc();
    v_r := public.receipt_claim_act(v_hash, 'undo_done');
    v_n := (SELECT count(*) FROM public.expense_claim_responses WHERE expense_id = v_e AND user_id = v_b);
    v_r2 := public.receipt_claim_act(v_hash, 'done');
    v_r3 := public.receipt_claim_act(v_hash2, 'not_there');
    RESET ROLE;
    PERFORM pg_temp.rh_rec('links.undo_done', v_r ->> 'result' = 'ok' AND v_n = 0 AND (v_r #>> '{state,response}') IS NULL, format('result=%s rows left=%s', v_r ->> 'result', v_n));
    PERFORM pg_temp.rh_rec('links.done', v_r2 ->> 'result' = 'ok' AND (v_r2 ->> 'changed')::boolean AND v_r2 #>> '{state,response}' = 'done', v_r2 ->> 'result');
    PERFORM pg_temp.rh_rec('links.payer_not_there_refused', v_r3 ->> 'result' = 'refused' AND v_r3 ->> 'reason' = 'payer', v_r3 ->> 'reason');
    UPDATE public.receipt_claim_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = v_hash2;
    PERFORM pg_temp.rh_svc();
    v_r4 := public.receipt_claim_act(v_hash2, 'done');
    v_rl1 := public.receipt_claim_rate_hit('rehearsal', 2, 60);
    v_rl2 := public.receipt_claim_rate_hit('rehearsal', 2, 60);
    v_rl3 := public.receipt_claim_rate_hit('rehearsal', 2, 60);
    RESET ROLE;
    PERFORM pg_temp.rh_rec('links.expired', v_r4 ->> 'result' = 'expired', 'expired');
    PERFORM pg_temp.rh_rec('links.rate_limit', v_rl1 AND v_rl2 AND NOT v_rl3, format('%s %s %s (2 allowed, 3rd refused)', v_rl1, v_rl2, v_rl3));
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM pg_temp.rh_rec('links.undo_done', false, 'ERROR ' || SQLSTATE || ' ' || SQLERRM);
  END;
END
$rh$;

-- ===== 6. the leftover rule through the public path: the receipt is SENT, so the payer A counts as confirmed; B confirmed too -> everyone confirmed: the dessert (6.00) is split equally (3.00 each) ======================================================
DO $rh$
DECLARE
  v_a uuid := pg_temp.rh_ctx('a')::uuid; v_b uuid := pg_temp.rh_ctx('b')::uuid; v_e uuid := pg_temp.rh_ctx('e')::uuid;
  v_r jsonb; v_r2 jsonb; v_hint text; v_n integer; v_before text; v_after text; v_bh text;
BEGIN
  IF v_e IS NULL THEN PERFORM pg_temp.rh_rec('rule', false, 'no test expense'); RETURN; END IF;
  BEGIN
    SELECT string_agg(user_id::text || ':' || amount_owed || ':' || leftover_amount, ',' ORDER BY line_item_id, user_id) INTO v_before FROM public.expense_item_claims WHERE expense_id = v_e;
    PERFORM pg_temp.rh_jwt(v_a);
    SET LOCAL ROLE authenticated;
    v_r := public.share_receipt_leftovers(v_e, 'everyone', NULL, true);
    RESET ROLE;
    SELECT string_agg(user_id::text || ':' || amount_owed || ':' || leftover_amount, ',' ORDER BY line_item_id, user_id) INTO v_after FROM public.expense_item_claims WHERE expense_id = v_e;
    -- F = 15.00; A claimed 6.00 (room 9.00), B claimed 18.00 (above F) and confirmed: A is the only unconfirmed person and takes the whole 6.00
    PERFORM pg_temp.rh_rec('rule.preview', (v_r ->> 'preview')::boolean AND v_before = v_after AND jsonb_array_length(v_r -> 'people') = 2
      AND (SELECT bool_and((p ->> 'amount')::numeric = 3.00) FROM jsonb_array_elements(v_r -> 'people') p) AND jsonb_array_length(v_r -> 'confirmed_user_ids') = 2,
      format('people=%s confirmed=%s even_share=%s', v_r -> 'people', v_r -> 'confirmed_user_ids', v_r ->> 'even_share'));
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM pg_temp.rh_rec('rule.preview', false, 'ERROR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  -- the payer's confirm dialog for "Share the rest now": a preview of exactly what the real call will do, nothing written
  BEGIN
    SELECT md5(string_agg(c.id::text || c.amount_owed || c.leftover_amount, ',' ORDER BY c.id)) INTO v_before FROM public.expense_item_claims c WHERE c.expense_id = v_e;
    PERFORM pg_temp.rh_jwt(v_a);
    SET LOCAL ROLE authenticated;
    v_r := public.apply_receipt_deadline(v_e, true);
    RESET ROLE;
    SELECT md5(string_agg(c.id::text || c.amount_owed || c.leftover_amount, ',' ORDER BY c.id)) INTO v_after FROM public.expense_item_claims c WHERE c.expense_id = v_e;
    PERFORM pg_temp.rh_rec('rule.apply_preview', (v_r ->> 'preview')::boolean AND (v_r ->> 'applied')::boolean AND v_before = v_after
      AND (SELECT claims_closed_at IS NULL FROM public.expenses WHERE id = v_e) AND jsonb_array_length(v_r -> 'people') = 2 AND (SELECT bool_and((p ->> 'amount')::numeric = 3.00) FROM jsonb_array_elements(v_r -> 'people') p),
      format('preview=%s rows unchanged=%s people=%s', v_r ->> 'preview', v_before = v_after, v_r -> 'people'));
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM pg_temp.rh_rec('rule.apply_preview', false, 'ERROR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  -- extend (payer) then the deadline job
  BEGIN
    PERFORM pg_temp.rh_jwt(v_a);
    SET LOCAL ROLE authenticated;
    v_r := public.extend_receipt_deadline(v_e, now() + interval '6 days');
    RESET ROLE;
    PERFORM pg_temp.rh_rec('deadline.extend', (v_r ->> 'changed')::boolean AND (v_r -> 'waiting_user_ids') = '[]'::jsonb,
      format('changed=%s waiting=%s (B already answered and A is the caller: expect [])', v_r ->> 'changed', v_r ->> 'waiting_user_ids'));
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM pg_temp.rh_rec('deadline.extend', false, 'ERROR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    PERFORM pg_temp.rh_svc();
    v_r := public.apply_receipt_deadline(v_e);
    RESET ROLE;
    PERFORM pg_temp.rh_rec('deadline.service_not_due', NOT (v_r ->> 'applied')::boolean AND v_r ->> 'reason' = 'not_due', v_r::text);
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM pg_temp.rh_rec('deadline.service_not_due', false, 'ERROR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    UPDATE public.expenses SET claim_deadline = now() - interval '1 minute' WHERE id = v_e;     -- the deadline passes (rolled back with everything)
    SELECT token_hash INTO v_bh FROM public.receipt_claim_tokens WHERE expense_id = v_e AND user_id = v_b LIMIT 1;
    PERFORM pg_temp.rh_svc();
    v_r2 := public.receipt_claim_act(v_bh, 'undo_done');
    v_r := public.apply_receipt_deadline(v_e);
    RESET ROLE;
    PERFORM pg_temp.rh_rec('deadline.link_refused_after_deadline', v_r2 ->> 'result' = 'refused' AND v_r2 ->> 'reason' = 'deadline_passed', v_r2::text);
    PERFORM pg_temp.rh_rec('deadline.service_applies', (v_r ->> 'applied')::boolean AND v_r ->> 'mode' = 'everyone' AND NOT (v_r ->> 'early')::boolean
      AND jsonb_array_length(v_r -> 'people') = 2 AND (SELECT bool_and((p ->> 'amount')::numeric = 3.00) FROM jsonb_array_elements(v_r -> 'people') p)
      AND jsonb_array_length(v_r -> 'notify_user_ids') = 2, v_r::text);
    PERFORM pg_temp.rh_rec('deadline.exact', (SELECT sum(amount_owed) FROM public.expense_item_claims WHERE expense_id = v_e) = 30.00
      AND NOT EXISTS (SELECT 1 FROM public.expense_line_items li WHERE li.expense_id = v_e AND li.total_amount <> coalesce((SELECT sum(c.amount_owed) FROM public.expense_item_claims c WHERE c.line_item_id = li.id), 0))
      AND (SELECT claims_closed_at IS NOT NULL FROM public.expenses WHERE id = v_e),
      'receipt adds up to 30.00, every line exact, claims_closed_at set');
    SELECT string_agg(user_id::text || ':' || amount_owed || ':' || leftover_amount, ',' ORDER BY line_item_id, user_id) INTO v_before FROM public.expense_item_claims WHERE expense_id = v_e;
    PERFORM pg_temp.rh_svc();
    v_r := public.apply_receipt_deadline(v_e);
    RESET ROLE;
    SELECT string_agg(user_id::text || ':' || amount_owed || ':' || leftover_amount, ',' ORDER BY line_item_id, user_id) INTO v_after FROM public.expense_item_claims WHERE expense_id = v_e;
    SELECT count(*) INTO v_n FROM public.activity_feed WHERE verb = 'receipt_deadline_applied' AND entity ->> 'id' = v_e::text;
    PERFORM pg_temp.rh_rec('deadline.never_twice', NOT (v_r ->> 'applied')::boolean AND (v_r ->> 'already_applied')::boolean AND v_before = v_after AND v_n = 1,
      format('second call applied=%s already_applied=%s rows identical=%s activity rows=%s', v_r ->> 'applied', v_r ->> 'already_applied', v_before = v_after, v_n));
    PERFORM pg_temp.rh_svc();
    v_r := public.receipt_claim_act(v_bh, 'done');
    RESET ROLE;
    BEGIN
      PERFORM pg_temp.rh_jwt(v_a);
      SET LOCAL ROLE authenticated;
      PERFORM public.reitemize_expense(v_e, '{}'::jsonb, jsonb_build_array(jsonb_build_object('name_original', 'x', 'quantity', 1, 'unit_price', 1, 'subtotal', 1, 'total_amount', 1)));
      RESET ROLE;
      PERFORM pg_temp.rh_rec('deadline.reitemise_refused_after_apply', false, 'NOT refused');
    EXCEPTION WHEN OTHERS THEN
      RESET ROLE;
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      PERFORM pg_temp.rh_rec('deadline.reitemise_refused_after_apply', v_hint = 'claims_closed', SQLSTATE || ' hint=' || coalesce(v_hint, ''));
    END;
    PERFORM pg_temp.rh_rec('deadline.link_closed_after_apply', v_r ->> 'result' = 'refused' AND v_r ->> 'reason' = 'claims_closed', v_r::text);
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM pg_temp.rh_rec('deadline.service_applies', false, 'ERROR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  -- clients cannot write responses once the leftovers are shared
  BEGIN
    PERFORM pg_temp.rh_jwt(v_b);
    SET LOCAL ROLE authenticated;
    DELETE FROM public.expense_claim_responses WHERE expense_id = v_e AND user_id = v_b;
    RESET ROLE;
    PERFORM pg_temp.rh_rec('deadline.responses_closed', false, 'NOT refused');
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    PERFORM pg_temp.rh_rec('deadline.responses_closed', v_hint = 'claims_closed', SQLSTATE || ' hint=' || coalesce(v_hint, '') || ' ' || SQLERRM);
  END;
  -- a closed receipt is immutable for clients: the OLD client's convert (header UPDATE first, then line delete) writes nothing
  BEGIN
    PERFORM pg_temp.rh_jwt(v_a);
    SET LOCAL ROLE authenticated;
    UPDATE public.expenses SET amount = amount + 15, ai_parsed = true WHERE id = v_e;
    RESET ROLE;
    PERFORM pg_temp.rh_rec('closed.header_update_refused', false, 'NOT refused');
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    PERFORM pg_temp.rh_rec('closed.header_update_refused', v_hint = 'claims_closed', SQLSTATE || ' hint=' || coalesce(v_hint, ''));
  END;
  BEGIN
    PERFORM pg_temp.rh_jwt(v_a);
    SET LOCAL ROLE authenticated;
    DELETE FROM public.expense_line_items WHERE expense_id = v_e;
    RESET ROLE;
    PERFORM pg_temp.rh_rec('closed.line_delete_refused', false, 'NOT refused');
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    PERFORM pg_temp.rh_rec('closed.line_delete_refused', v_hint = 'claims_closed' AND (SELECT amount = 30.00 FROM public.expenses WHERE id = v_e) AND (SELECT count(*) FROM public.expense_line_items WHERE expense_id = v_e) = 3, SQLSTATE || ' hint=' || coalesce(v_hint, ''));
  END;
  -- a closed receipt is final for claim edits (in-app) until the payer REOPENS it; then Share now closes it again
  BEGIN
    PERFORM pg_temp.rh_jwt(v_b);
    SET LOCAL ROLE authenticated;
    DELETE FROM public.expense_item_claims WHERE expense_id = v_e AND user_id = v_b;
    RESET ROLE;
    PERFORM pg_temp.rh_rec('closed.old_client_delete_refused', false, 'NOT refused');
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    PERFORM pg_temp.rh_rec('closed.old_client_delete_refused', v_hint = 'claims_closed', SQLSTATE || ' hint=' || coalesce(v_hint, ''));
  END;
  BEGIN
    PERFORM pg_temp.rh_jwt(v_a);
    SET LOCAL ROLE authenticated;
    v_r := public.reopen_receipt_claims(v_e, now() + interval '3 days');
    RESET ROLE;
    SELECT token_hash INTO v_bh FROM public.receipt_claim_tokens WHERE expense_id = v_e AND user_id = v_b LIMIT 1;
    PERFORM pg_temp.rh_svc();
    v_r2 := public.receipt_claim_act(v_bh, 'undo_done');
    PERFORM pg_temp.rh_rec('reopen.ok', (v_r ->> 'reopened')::boolean AND (SELECT claims_closed_at IS NULL AND leftover_mode IS NULL FROM public.expenses WHERE id = v_e)
      AND NOT EXISTS (SELECT 1 FROM public.expense_item_claims WHERE expense_id = v_e AND (leftover_amount > 0 OR leftover_quantity > 0))
      AND jsonb_array_length(v_r -> 'was_charged') = 2 AND v_r2 ->> 'result' = 'ok',
      format('reopened=%s was_charged=%s link works again: %s', v_r ->> 'reopened', v_r -> 'was_charged', v_r2 ->> 'result'));
    PERFORM pg_temp.rh_jwt(v_a);
    SET LOCAL ROLE authenticated;
    v_r := public.apply_receipt_deadline(v_e);
    RESET ROLE;
    PERFORM pg_temp.rh_rec('reopen.share_now_closes_again', (v_r ->> 'applied')::boolean AND (SELECT claims_closed_at IS NOT NULL FROM public.expenses WHERE id = v_e) AND (v_r ->> 'early')::boolean, v_r ->> 'applied');
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM pg_temp.rh_rec('reopen.ok', false, 'ERROR ' || SQLSTATE || ' ' || SQLERRM);
  END;
END
$rh$;

-- ===== 6b. re-itemise (claims kept on unchanged lines), plain -> itemised, never-sent receipts, unfreeze ==================================================================
DO $rh$
DECLARE
  v_trip uuid := pg_temp.rh_ctx('trip')::uuid; v_a uuid := pg_temp.rh_ctx('a')::uuid; v_b uuid := pg_temp.rh_ctx('b')::uuid;
  v_e uuid; v_l1 uuid; v_l2 uuid; v_l3 uuid; v_p jsonb; v_r jsonb; v_hash_before text; v_hash_after text; v_n integer; v_amount numeric; v_pizza numeric; v_hint text;
  v_e4 uuid; v_e5 uuid; v_l4 uuid; v_susp integer; v_pay_before integer; v_pay_after integer; v_u jsonb; v_lines jsonb;
BEGIN
  IF v_a IS NULL OR v_b IS NULL THEN PERFORM pg_temp.rh_rec('reitemise', false, 'no test trip / people'); RETURN; END IF;
  INSERT INTO public.expenses (trip_id, paid_by, amount, currency, description, status, ai_parsed, participant_ids)
  VALUES (v_trip, v_a, 60.00, 'GBP', 'REHEARSAL reitemise (rolled back)', 'unallocated', true, ARRAY[v_a, v_b]) RETURNING id INTO v_e;
  INSERT INTO public.expense_line_items (expense_id, line_number, name_original, quantity, unit_price, subtotal, total_amount) VALUES (v_e, 1, 'pizza', 1, 30, 30, 30) RETURNING id INTO v_l1;
  INSERT INTO public.expense_line_items (expense_id, line_number, name_original, quantity, unit_price, subtotal, total_amount) VALUES (v_e, 2, 'beers', 2, 5, 10, 10) RETURNING id INTO v_l2;
  INSERT INTO public.expense_line_items (expense_id, line_number, name_original, quantity, unit_price, subtotal, total_amount) VALUES (v_e, 3, 'wine', 1, 20, 20, 20) RETURNING id INTO v_l3;
  BEGIN
    PERFORM pg_temp.rh_jwt(v_a);
    SET LOCAL ROLE authenticated;
    PERFORM public.set_receipt_claims(v_e, jsonb_build_array(jsonb_build_object('line_item_id', v_l1, 'user_ids', jsonb_build_array(v_a)),
                                                            jsonb_build_object('line_item_id', v_l2, 'user_ids', jsonb_build_array(v_b))));
    PERFORM public.send_receipt_to_table(v_e);
    RESET ROLE;
    INSERT INTO public.expense_claim_responses (expense_id, user_id, response) VALUES (v_e, v_b, 'done');
    SELECT md5(string_agg(c.id::text || c.amount_owed || c.quantity_claimed, ',' ORDER BY c.id)) INTO v_hash_before FROM public.expense_item_claims c WHERE c.expense_id = v_e;
    -- pizza: price re-shared (tax) = unchanged line, total 33; beers renamed = changed (B's claim cleared); wine unchanged; new dessert
    v_lines := jsonb_build_array(
      jsonb_build_object('id', v_l1, 'name_original', 'pizza', 'quantity', 1, 'unit_price', 30, 'subtotal', 30, 'tax_amount', 3, 'service_amount', 0, 'total_amount', 33),
      jsonb_build_object('id', v_l2, 'name_original', 'beers (craft)', 'quantity', 2, 'unit_price', 5, 'subtotal', 10, 'total_amount', 10),
      jsonb_build_object('id', v_l3, 'name_original', 'wine', 'quantity', 1, 'unit_price', 20, 'subtotal', 20, 'total_amount', 20),
      jsonb_build_object('name_original', 'dessert', 'quantity', 1, 'unit_price', 6, 'subtotal', 6, 'total_amount', 6));
    PERFORM pg_temp.rh_jwt(v_a);
    SET LOCAL ROLE authenticated;
    v_p := public.reitemize_expense(v_e, jsonb_build_object('description', 'REHEARSAL reitemised'), v_lines, true);
    RESET ROLE;
    SELECT md5(string_agg(c.id::text || c.amount_owed || c.quantity_claimed, ',' ORDER BY c.id)) INTO v_hash_after FROM public.expense_item_claims c WHERE c.expense_id = v_e;
    PERFORM pg_temp.rh_rec('reitemise.preview_writes_nothing', v_hash_before = v_hash_after AND (SELECT amount FROM public.expenses WHERE id = v_e) = 60.00
      AND (SELECT count(*) FROM public.expense_claim_responses WHERE expense_id = v_e) = 1 AND (SELECT count(*) FROM public.expense_line_items WHERE expense_id = v_e) = 3
      AND (v_p ->> 'preview')::boolean, v_p::text);
    PERFORM pg_temp.rh_jwt(v_a);
    SET LOCAL ROLE authenticated;
    v_r := public.reitemize_expense(v_e, jsonb_build_object('description', 'REHEARSAL reitemised'), v_lines);
    RESET ROLE;
    SELECT amount INTO v_amount FROM public.expenses WHERE id = v_e;
    SELECT amount_owed INTO v_pizza FROM public.expense_item_claims WHERE line_item_id = v_l1 AND user_id = v_a;
    PERFORM pg_temp.rh_rec('reitemise.real', (v_r - 'preview' - 'line_ids') = (v_p - 'preview' - 'line_ids') AND (v_r ->> 'kept_claims')::int = 1 AND (v_r ->> 'cleared_claims')::int = 1
      AND (v_r -> 'cleared_user_ids') = jsonb_build_array(v_b) AND v_amount = 69.00 AND v_pizza = 33.00
      AND NOT EXISTS (SELECT 1 FROM public.expense_claim_responses WHERE expense_id = v_e AND user_id = v_b)
      AND NOT EXISTS (SELECT 1 FROM public.expense_item_claims WHERE line_item_id = v_l2)
      AND (SELECT array_agg(line_number ORDER BY line_number) FROM public.expense_line_items WHERE expense_id = v_e) = ARRAY[1, 2, 3, 4],
      format('preview==real=%s kept=%s cleared=%s amount=%s pizza claim=%s B done removed=%s', (v_r - 'preview' - 'line_ids') = (v_p - 'preview' - 'line_ids'), v_r ->> 'kept_claims', v_r ->> 'cleared_claims', v_amount, v_pizza,
             NOT EXISTS (SELECT 1 FROM public.expense_claim_responses WHERE expense_id = v_e AND user_id = v_b)));
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM pg_temp.rh_rec('reitemise.real', false, 'ERROR ' || SQLSTATE || ' hint=' || coalesce((SELECT '' ), '') || SQLERRM);
  END;
  -- a client that is not payer or manager is refused
  BEGIN
    PERFORM pg_temp.rh_jwt(v_b);
    SET LOCAL ROLE authenticated;
    PERFORM public.reitemize_expense(v_e, '{}'::jsonb, jsonb_build_array(jsonb_build_object('name_original', 'x', 'quantity', 1, 'unit_price', 1, 'subtotal', 1, 'total_amount', 1)));
    RESET ROLE;
    PERFORM pg_temp.rh_rec('reitemise.ordinary_person_refused', coalesce(pg_temp.rh_ctx('b_manager')::boolean, false), CASE WHEN pg_temp.rh_ctx('b_manager')::boolean THEN 'SKIPPED: B can manage' ELSE 'NOT refused' END);
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    PERFORM pg_temp.rh_rec('reitemise.ordinary_person_refused', v_hint = 'forbidden', SQLSTATE || ' hint=' || coalesce(v_hint, ''));
  END;
  -- plain -> itemised (status 'confirmed' becomes 'unallocated')
  BEGIN
    INSERT INTO public.expenses (trip_id, paid_by, amount, currency, description, status, ai_parsed) VALUES (v_trip, v_a, 10.00, 'GBP', 'REHEARSAL plain (rolled back)', 'confirmed', false) RETURNING id INTO v_e5;
    PERFORM pg_temp.rh_jwt(v_a);
    SET LOCAL ROLE authenticated;
    v_r := public.reitemize_expense(v_e5, '{}'::jsonb, jsonb_build_array(jsonb_build_object('name_original', 'x', 'quantity', 1, 'unit_price', 12, 'subtotal', 12, 'total_amount', 12)));
    RESET ROLE;
    PERFORM pg_temp.rh_rec('reitemise.plain_to_itemised', (SELECT ai_parsed AND status::text = 'unallocated' AND amount = 12.00 FROM public.expenses WHERE id = v_e5)
      AND (SELECT count(*) FROM public.expense_line_items WHERE expense_id = v_e5) = 1, v_r::text);
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM pg_temp.rh_rec('reitemise.plain_to_itemised', false, 'ERROR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  -- a receipt that was NEVER sent to the table: nobody has confirmed, so 'everyone' is the plain equal split (phase-1 behaviour)
  BEGIN
    INSERT INTO public.expenses (trip_id, paid_by, amount, currency, description, status, ai_parsed, participant_ids)
    VALUES (v_trip, v_a, 20.00, 'GBP', 'REHEARSAL never sent (rolled back)', 'unallocated', true, ARRAY[v_a, v_b]) RETURNING id INTO v_e4;
    INSERT INTO public.expense_line_items (expense_id, line_number, name_original, quantity, unit_price, subtotal, total_amount) VALUES (v_e4, 1, 'a', 1, 10, 10, 10) RETURNING id INTO v_l4;
    INSERT INTO public.expense_line_items (expense_id, line_number, name_original, quantity, unit_price, subtotal, total_amount) VALUES (v_e4, 2, 'b', 1, 10, 10, 10);
    INSERT INTO public.expense_claim_responses (expense_id, user_id, response) VALUES (v_e4, v_b, 'done');   -- an answer on a receipt nobody was told about
    PERFORM pg_temp.rh_jwt(v_a);
    SET LOCAL ROLE authenticated;
    PERFORM public.set_receipt_claims(v_e4, jsonb_build_array(jsonb_build_object('line_item_id', v_l4, 'user_ids', jsonb_build_array(v_a))));
    v_r := public.share_receipt_leftovers(v_e4, 'everyone', NULL, true);
    RESET ROLE;
    -- A claimed 10, B nothing; 10.00 left. Plain equal split would be 5.00 each; water-filling (B alone unconfirmed) would give B all 10.00
    PERFORM pg_temp.rh_rec('rule.never_sent_equal_split', (SELECT jsonb_agg((p ->> 'amount')::numeric ORDER BY p ->> 'user_id') FROM jsonb_array_elements(v_r -> 'people') p) = jsonb_build_array(5.00, 5.00),
      'people=' || (v_r -> 'people')::text);
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM pg_temp.rh_rec('rule.never_sent_equal_split', false, 'ERROR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  -- unfreeze deletes stale suggestions and never real payments
  BEGIN
    SELECT count(*) INTO v_pay_before FROM public.settlements WHERE trip_id = v_trip AND status IN ('marked_paid', 'confirmed');
    PERFORM pg_temp.rh_jwt(v_a);
    SET LOCAL ROLE authenticated;
    INSERT INTO public.settlements (trip_id, from_user_id, to_user_id, amount, currency, status, created_by, settled_at) VALUES (v_trip, v_b, v_a, 1.00, 'GBP', 'suggested', v_a, now());
    RESET ROLE;
    UPDATE public.trips SET settlement_snapshot = jsonb_build_object('transactions', '[]'::jsonb) WHERE id = v_trip;
    PERFORM pg_temp.rh_jwt(v_a);
    SET LOCAL ROLE authenticated;
    v_u := public.unfreeze_settlements(v_trip);
    RESET ROLE;
    SELECT count(*) INTO v_pay_after FROM public.settlements WHERE trip_id = v_trip AND status IN ('marked_paid', 'confirmed');
    SELECT count(*) INTO v_susp FROM public.settlements s WHERE s.trip_id = v_trip AND s.status = 'suggested' AND s.receipt_disputed_at IS NULL;
    PERFORM pg_temp.rh_rec('unfreeze.drops_stale_suggestions', (v_u ->> 'unfrozen')::boolean AND (v_u ->> 'deleted_suggested')::int >= 1 AND v_susp = 0 AND v_pay_before = v_pay_after
      AND (SELECT settlement_snapshot IS NULL FROM public.trips WHERE id = v_trip), format('result=%s suggested left=%s real payments before/after=%s/%s', v_u, v_susp, v_pay_before, v_pay_after));
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM pg_temp.rh_rec('unfreeze.drops_stale_suggestions', false, 'ERROR ' || SQLSTATE || ' ' || SQLERRM);
  END;
END
$rh$;

-- ===== 6c. "I wasn't there" incl. a table item, link toggle after leftovers were shared, re-itemise with leftovers and a removed line, plain expense with splits =========
DO $rh$
DECLARE
  v_trip uuid := pg_temp.rh_ctx('trip')::uuid; v_a uuid := pg_temp.rh_ctx('a')::uuid; v_b uuid := pg_temp.rh_ctx('b')::uuid;
  v_e6 uuid; v_l6a uuid; v_l6b uuid; v_e7 uuid; v_l7a uuid; v_l7b uuid; v_e9 uuid; v_r jsonb; v_hash text := encode(sha256(convert_to('rh6c-' || gen_random_uuid()::text, 'UTF8')), 'hex');
  v_n integer; v_sum numeric; v_hint text; v_sp integer;
BEGIN
  IF v_a IS NULL OR v_b IS NULL THEN PERFORM pg_temp.rh_rec('notthere', false, 'no test trip / people'); RETURN; END IF;
  -- (a) a receipt with a TABLE item: B says "I wasn't there" as a client: allowed, his share of the table item moves to A; undo restores it
  BEGIN
    INSERT INTO public.expenses (trip_id, paid_by, amount, currency, description, status, ai_parsed, participant_ids)
    VALUES (v_trip, v_a, 30.00, 'GBP', 'REHEARSAL table item (rolled back)', 'unallocated', true, ARRAY[v_a, v_b]) RETURNING id INTO v_e6;
    INSERT INTO public.expense_line_items (expense_id, line_number, name_original, quantity, unit_price, subtotal, total_amount) VALUES (v_e6, 1, 'bread', 1, 9, 9, 9) RETURNING id INTO v_l6a;
    INSERT INTO public.expense_line_items (expense_id, line_number, name_original, quantity, unit_price, subtotal, total_amount) VALUES (v_e6, 2, 'main', 1, 21, 21, 21) RETURNING id INTO v_l6b;
    PERFORM pg_temp.rh_jwt(v_a);
    SET LOCAL ROLE authenticated;
    PERFORM public.set_receipt_claims(v_e6, jsonb_build_array(jsonb_build_object('line_item_id', v_l6a, 'shared_by_all', true), jsonb_build_object('line_item_id', v_l6b, 'user_ids', jsonb_build_array(v_a))));
    PERFORM public.send_receipt_to_table(v_e6);
    RESET ROLE;
    PERFORM pg_temp.rh_jwt(v_b);
    SET LOCAL ROLE authenticated;
    INSERT INTO public.expense_claim_responses (expense_id, user_id, response) VALUES (v_e6, v_b, 'not_there');
    RESET ROLE;
    SELECT sum(amount_owed), count(*) FILTER (WHERE user_id = v_b) INTO v_sum, v_n FROM public.expense_item_claims WHERE line_item_id = v_l6a;
    PERFORM pg_temp.rh_rec('notthere.table_item', v_sum = 9.00 AND v_n = 0 AND (SELECT count(*) FROM public.expense_item_claims WHERE line_item_id = v_l6a) = 1
      AND NOT (v_b = ANY (public._receipt_tagged(v_e6))), format('bread total %s, B rows %s', v_sum, v_n));
    PERFORM pg_temp.rh_jwt(v_b);
    SET LOCAL ROLE authenticated;
    DELETE FROM public.expense_claim_responses WHERE expense_id = v_e6 AND user_id = v_b;
    RESET ROLE;
    PERFORM pg_temp.rh_rec('notthere.undo_restores', (SELECT array_agg(amount_owed ORDER BY user_id) FROM public.expense_item_claims WHERE line_item_id = v_l6a) = ARRAY[4.50, 4.50]::numeric[], 'bread back to 4.50 / 4.50');
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM pg_temp.rh_rec('notthere.table_item', false, 'ERROR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  -- (b) leftovers shared by hand, then B's link toggles himself onto A's line: the leftovers are re-shared the same way, every line stays exact
  BEGIN
    INSERT INTO public.expenses (trip_id, paid_by, amount, currency, description, status, ai_parsed, participant_ids)
    VALUES (v_trip, v_a, 20.00, 'GBP', 'REHEARSAL toggle after share (rolled back)', 'unallocated', true, ARRAY[v_a, v_b]) RETURNING id INTO v_e7;
    INSERT INTO public.expense_line_items (expense_id, line_number, name_original, quantity, unit_price, subtotal, total_amount) VALUES (v_e7, 1, 'a', 1, 10, 10, 10) RETURNING id INTO v_l7a;
    INSERT INTO public.expense_line_items (expense_id, line_number, name_original, quantity, unit_price, subtotal, total_amount) VALUES (v_e7, 2, 'b', 1, 10, 10, 10) RETURNING id INTO v_l7b;
    PERFORM pg_temp.rh_jwt(v_a);
    SET LOCAL ROLE authenticated;
    PERFORM public.set_receipt_claims(v_e7, jsonb_build_array(jsonb_build_object('line_item_id', v_l7a, 'user_ids', jsonb_build_array(v_a))));
    PERFORM public.send_receipt_to_table(v_e7);
    PERFORM public.share_receipt_leftovers(v_e7, 'everyone');
    RESET ROLE;
    PERFORM pg_temp.rh_svc();
    v_r := public.issue_receipt_claim_token(v_e7, v_b, v_hash);
    v_r := public.receipt_claim_act(v_hash, 'toggle', jsonb_build_object('line_item_id', v_l7a, 'on', true));
    SELECT sum(amount_owed) INTO v_sum FROM public.expense_item_claims WHERE expense_id = v_e7;
    PERFORM pg_temp.rh_rec('toggle.after_share', v_r ->> 'result' = 'ok' AND v_sum = 20.00 AND (SELECT leftover_mode FROM public.expenses WHERE id = v_e7) = 'everyone'
      AND NOT EXISTS (SELECT 1 FROM public.expense_line_items li WHERE li.expense_id = v_e7 AND li.total_amount <> (SELECT coalesce(sum(c.amount_owed), 0) FROM public.expense_item_claims c WHERE c.line_item_id = li.id)),
      format('result=%s receipt total %s mode kept', v_r ->> 'result', v_sum));
    PERFORM pg_temp.rh_jwt(v_b);
    SET LOCAL ROLE authenticated;
    v_r := public.respond_to_receipt(v_e7, 'done');
    RESET ROLE;
    PERFORM pg_temp.rh_rec('respond.rpc', v_r ->> 'response' = 'done' AND (v_r ->> 'changed')::boolean, v_r::text);
    -- (c) re-itemise that receipt with leftovers present: line b removed, line a's total changes
    PERFORM pg_temp.rh_jwt(v_a);
    SET LOCAL ROLE authenticated;
    v_r := public.reitemize_expense(v_e7, '{}'::jsonb, jsonb_build_array(jsonb_build_object('id', v_l7a, 'name_original', 'a', 'quantity', 1, 'unit_price', 10, 'subtotal', 10, 'total_amount', 11)));
    RESET ROLE;
    SELECT sum(amount_owed) INTO v_sum FROM public.expense_item_claims WHERE expense_id = v_e7;
    PERFORM pg_temp.rh_rec('reitemise.with_leftovers_and_removed_line', (v_r ->> 'leftovers_cleared')::boolean AND (SELECT leftover_mode IS NULL FROM public.expenses WHERE id = v_e7)
      AND NOT EXISTS (SELECT 1 FROM public.expense_item_claims WHERE expense_id = v_e7 AND (leftover_amount > 0 OR leftover_quantity > 0))
      AND v_sum = 11.00 AND (SELECT count(*) FROM public.expense_line_items WHERE expense_id = v_e7) = 1 AND (SELECT amount FROM public.expenses WHERE id = v_e7) = 11.00
      AND jsonb_array_length(v_r -> 'reconfirm_user_ids') >= 0,
      format('leftovers_cleared=%s claims total=%s lines=%s', v_r ->> 'leftovers_cleared', v_sum, (SELECT count(*) FROM public.expense_line_items WHERE expense_id = v_e7)));
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM pg_temp.rh_rec('toggle.after_share', false, 'ERROR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  -- (d) a PLAIN expense with real split rows converted to itemised (the split row is copied from any existing row so unknown NOT NULL columns do not matter)
  BEGIN
    INSERT INTO public.expenses (trip_id, paid_by, amount, currency, description, status, ai_parsed) VALUES (v_trip, v_a, 10.00, 'GBP', 'REHEARSAL plain with splits (rolled back)', 'confirmed', false) RETURNING id INTO v_e9;
    BEGIN
      INSERT INTO public.expense_splits SELECT (jsonb_populate_record(NULL::public.expense_splits, to_jsonb(s) || jsonb_build_object('expense_id', v_e9, 'id', gen_random_uuid()))).* FROM (SELECT * FROM public.expense_splits LIMIT 1) s;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    SELECT count(*) INTO v_sp FROM public.expense_splits WHERE expense_id = v_e9;
    PERFORM pg_temp.rh_jwt(v_a);
    SET LOCAL ROLE authenticated;
    v_r := public.reitemize_expense(v_e9, '{}'::jsonb, jsonb_build_array(jsonb_build_object('name_original', 'x', 'quantity', 1, 'unit_price', 12, 'subtotal', 12, 'total_amount', 12)));
    RESET ROLE;
    PERFORM pg_temp.rh_rec('reitemise.plain_with_splits', (SELECT count(*) FROM public.expense_splits WHERE expense_id = v_e9) = 0 AND (SELECT ai_parsed AND status::text = 'unallocated' FROM public.expenses WHERE id = v_e9)
      AND (v_r ->> 'needs_link')::boolean, format('split rows before=%s (0 = no split row existed to copy: only the conversion was exercised) needs_link=%s', v_sp, v_r ->> 'needs_link'));
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM pg_temp.rh_rec('reitemise.plain_with_splits', false, 'ERROR ' || SQLSTATE || ' ' || SQLERRM);
  END;
END
$rh$;

-- ===== 7. frozen trip: send / apply / client answers are refused; then nothing was sent anywhere ============================================================
DO $rh$
DECLARE
  v_trip uuid := pg_temp.rh_ctx('trip')::uuid; v_a uuid := pg_temp.rh_ctx('a')::uuid; v_b uuid := pg_temp.rh_ctx('b')::uuid; v_e uuid := pg_temp.rh_ctx('e')::uuid;
  v_e2 uuid; v_hint text; v_n integer; v_na integer;
BEGIN
  IF v_e IS NULL THEN PERFORM pg_temp.rh_rec('frozen', false, 'no test expense'); RETURN; END IF;
  INSERT INTO public.expenses (trip_id, paid_by, amount, currency, description, status, ai_parsed, participant_ids)
  VALUES (v_trip, v_a, 10.00, 'GBP', 'REHEARSAL frozen receipt (rolled back)', 'unallocated', true, ARRAY[v_a, v_b]) RETURNING id INTO v_e2;
  INSERT INTO public.expense_line_items (expense_id, line_number, name_original, quantity, unit_price, subtotal, total_amount) VALUES (v_e2, 1, 'x', 1, 10, 10, 10);
  UPDATE public.trips SET settlement_snapshot = jsonb_build_object('transactions', '[]'::jsonb) WHERE id = v_trip;
  BEGIN
    PERFORM pg_temp.rh_jwt(v_a);
    SET LOCAL ROLE authenticated;
    PERFORM public.send_receipt_to_table(v_e2);
    RESET ROLE;
    PERFORM pg_temp.rh_rec('frozen.send_refused', false, 'NOT refused');
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    PERFORM pg_temp.rh_rec('frozen.send_refused', v_hint = 'frozen', SQLSTATE || ' hint=' || coalesce(v_hint, '') || ' ' || SQLERRM);
  END;
  BEGIN
    PERFORM pg_temp.rh_svc();
    PERFORM public.apply_receipt_deadline(v_e2);
    RESET ROLE;
    PERFORM pg_temp.rh_rec('frozen.apply_refused', false, 'NOT refused');
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    PERFORM pg_temp.rh_rec('frozen.apply_refused', v_hint = 'frozen', SQLSTATE || ' hint=' || coalesce(v_hint, '') || ' ' || SQLERRM);
  END;
  BEGIN
    PERFORM pg_temp.rh_jwt(v_b);
    SET LOCAL ROLE authenticated;
    INSERT INTO public.expense_claim_responses (expense_id, user_id, response) VALUES (v_e2, v_b, 'done');
    RESET ROLE;
    PERFORM pg_temp.rh_rec('frozen.response_refused', false, 'NOT refused');
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    PERFORM pg_temp.rh_rec('frozen.response_refused', v_hint = 'frozen', SQLSTATE || ' hint=' || coalesce(v_hint, '') || ' ' || SQLERRM);
  END;
  BEGIN
    PERFORM pg_temp.rh_jwt(v_a);
    SET LOCAL ROLE authenticated;
    PERFORM public.reitemize_expense(v_e2, '{}'::jsonb, jsonb_build_array(jsonb_build_object('name_original', 'x', 'quantity', 1, 'unit_price', 1, 'subtotal', 1, 'total_amount', 1)));
    RESET ROLE;
    PERFORM pg_temp.rh_rec('frozen.reitemise_refused', false, 'NOT refused');
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    PERFORM pg_temp.rh_rec('frozen.reitemise_refused', v_hint = 'frozen', SQLSTATE || ' hint=' || coalesce(v_hint, ''));
  END;
  SELECT count(*) INTO v_n FROM public.notifications;
  PERFORM pg_temp.rh_rec('side_effects.no_notifications', v_n = pg_temp.rh_ctx('notif0')::integer, format('notifications before=%s now=%s (the database never sends mail)', pg_temp.rh_ctx('notif0'), v_n));
  SELECT count(*) INTO v_na FROM public.activity_feed WHERE created_at >= now() - interval '1 hour' AND metadata ->> 'via' = 'email_link';
  PERFORM pg_temp.rh_rec('side_effects.activity', v_na >= 2, format('%s activity rows written via the link (done / undo / done)', v_na));
END
$rh$;

-- ===== FINAL: report through the error message (this also rolls everything back) ===============================================================================
DO $rh$
DECLARE
  v_all boolean; v_json text; v_failed integer; v_total integer;
BEGIN
  SELECT coalesce(bool_and(ok), false), count(*) FILTER (WHERE NOT ok), count(*) INTO v_all, v_failed, v_total FROM _rehearsal;
  SELECT coalesce(jsonb_agg(jsonb_build_object('step', step, 'ok', ok, 'detail', left(detail, 160)) ORDER BY ok, ctid), '[]'::jsonb)::text INTO v_json FROM _rehearsal;
  IF length(v_json) > 6000 THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('step', step, 'ok', ok, 'detail', left(detail, CASE WHEN ok THEN 0 ELSE 90 END)) ORDER BY ok, ctid), '[]'::jsonb)::text INTO v_json FROM _rehearsal;
  END IF;
  IF length(v_json) > 6000 THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('step', step, 'ok', ok, 'detail', left(detail, 90)) ORDER BY ok, ctid), '[]'::jsonb)::text INTO v_json FROM _rehearsal WHERE NOT ok;
    v_json := left(v_json, 5800) || ' (only failing steps shown)';
  END IF;
  RAISE EXCEPTION '%', 'REHEARSAL ' || CASE WHEN v_all THEN 'PASS' ELSE 'FAIL' END || ' (' || v_total || ' steps, ' || v_failed || ' failed) ' || v_json;
END
$rh$;
ROLLBACK;
