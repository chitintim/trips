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
    PERFORM pg_temp.rh_rec('pre.phase1_live', v_t = '@@TAGGED_MD5@@' AND v_c = '@@CONFIRMED_MD5@@' AND v_cols = 2,
      format('_receipt_tagged md5=%s (want @@TAGGED_MD5@@) _receipt_leftover_confirmed md5=%s (want @@CONFIRMED_MD5@@) leftover columns=%s', v_t, v_c, v_cols));
    SELECT md5(prosrc) INTO v_bg FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = '_receipt_begin';
    PERFORM pg_temp.rh_rec('pre.begin_live', v_bg = '@@BEGIN_MD5@@', format('live _receipt_begin md5=%s (shipped @@BEGIN_MD5@@): the migration replaces it with a one-block superset', v_bg));
    SELECT md5(prosrc) INTO v_u FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'unfreeze_settlements';
    PERFORM pg_temp.rh_rec('pre.unfreeze_live', v_u = '@@UNFREEZE_MD5@@', format('live unfreeze_settlements md5=%s (repo text @@UNFREEZE_MD5@@): if different STOP and read the live body before applying', v_u));
    PERFORM pg_temp.rh_rec('pre.names_free', NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'expenses' AND column_name IN ('claim_deadline', 'claims_sent_at', 'claims_closed_at'))
      AND to_regclass('public.expense_claim_responses') IS NULL AND to_regclass('public.receipt_claim_tokens') IS NULL AND to_regprocedure('public.send_receipt_to_table(uuid,timestamptz)') IS NULL AND to_regprocedure('public.reitemize_expense(uuid,jsonb,jsonb,boolean)') IS NULL AND to_regprocedure('public.reopen_receipt_claims(uuid,timestamptz)') IS NULL,
      'no phase-2 column, table or function exists yet');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.rh_rec('pre', false, 'ERROR ' || SQLSTATE || ' ' || SQLERRM);
  END;
END
$rh$;

-- ===== BEGIN MIGRATION (verbatim copy of supabase/migrations/20261126090000_receipt_deadline_tokens.sql) =====
@@MIGRATION@@
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
