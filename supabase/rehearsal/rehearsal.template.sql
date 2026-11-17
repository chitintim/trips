-- RECEIPT CLAIMS V2 REHEARSAL (generated from supabase/rehearsal/rehearsal.template.sql + the migration by scripts/build-rehearsal.mjs; do not edit
-- this file by hand). ONE batch that applies the migration, exercises it on the private test trip, then ENDS WITH AN ERROR so that
-- EVERYTHING ROLLS BACK. The result is the final error message: "REHEARSAL PASS [...]" or "REHEARSAL FAIL [...]". See supabase/rehearsal/README.md.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ===== BEGIN MIGRATION (verbatim copy of supabase/migrations/20261124090000_receipt_claims_v2.sql) =====
@@MIGRATION@@
-- ===== END MIGRATION =====

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
    -- B = another ACTIVE participant, preferring one who cannot manage the trip (so the "ordinary person" checks mean something)
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
  v_n integer; v_txt text; v_md5 text; v_len integer; v_bad text := '';
  r record;
BEGIN
  BEGIN
    SELECT count(*), string_agg(c.table_name || '.' || c.column_name || ' default=' || coalesce(c.column_default, 'null') || ' null=' || c.is_nullable, '; ' ORDER BY c.table_name, c.column_name)
      INTO v_n, v_txt
    FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND (c.table_name, c.column_name) IN (
      ('expense_item_claims', 'source'), ('expense_item_claims', 'created_by'), ('expense_item_claims', 'leftover_quantity'),
      ('expense_item_claims', 'leftover_amount'), ('expense_line_items', 'shared_by_all'), ('expenses', 'leftover_mode'), ('expenses', 'leftover_user_id'));
    PERFORM pg_temp.rh_rec('struct.columns', v_n = 7
      AND (SELECT count(*) FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = 'expense_item_claims'
             AND ((c.column_name = 'source' AND c.column_default LIKE '''self''%' AND c.is_nullable = 'NO')
               OR (c.column_name IN ('leftover_quantity', 'leftover_amount') AND c.column_default LIKE '0%' AND c.is_nullable = 'NO')
               OR (c.column_name = 'created_by' AND c.is_nullable = 'YES'))) = 4
      AND (SELECT count(*) FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = 'expense_line_items'
             AND c.column_name = 'shared_by_all' AND c.column_default = 'false' AND c.is_nullable = 'NO') = 1,
      v_n || ' of 7: ' || coalesce(v_txt, ''));

    SELECT string_agg(x.n, ',') INTO v_txt FROM (VALUES ('expense_item_claims_source_check'), ('expense_item_claims_leftover_parts_check'), ('expenses_leftover_mode_check')) x(n)
     WHERE NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conname = x.n AND c.contype = 'c' AND c.convalidated);
    PERFORM pg_temp.rh_rec('struct.constraints', v_txt IS NULL, coalesce('missing/unvalidated: ' || v_txt, 'all 3 CHECKs present and validated'));

    SELECT string_agg(x.t || '.' || x.n, ',') INTO v_txt FROM (VALUES
      ('expense_item_claims', 'trg_guard_claim_provenance'), ('expense_item_claims', 'trg_guard_claim_overclaim'),
      ('expense_item_claims', 'trigger_auto_update_expense_status'), ('expenses', 'trg_guard_expense_leftover_mode')) x(t, n)
     WHERE NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = ('public.' || x.t)::regclass AND g.tgname = x.n AND NOT g.tgisinternal AND g.tgenabled = 'O');
    PERFORM pg_temp.rh_rec('struct.triggers', v_txt IS NULL, coalesce('missing/disabled: ' || v_txt, '3 new triggers + the live status trigger enabled'));

    SELECT count(*), max(md5(p.prosrc)), max(length(p.prosrc)) INTO v_n, v_md5, v_len
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'freeze_settlements';
    PERFORM pg_temp.rh_rec('struct.freeze_overload', v_n = 1 AND v_md5 = '@@FREEZE_MD5@@',
      format('overloads=%s md5=%s len=%s expected=%s', v_n, v_md5, v_len, '@@FREEZE_MD5@@'));

    -- privileges: helpers and trigger functions private; RPCs for signed-in users only; refund_rate_limit service role only
    FOR r IN SELECT * FROM (VALUES
      ('public._receipt_even_split(bigint,integer)', false, false, null),
      ('public._receipt_tagged(uuid)', false, false, null),
      ('public._receipt_lines(uuid,boolean)', false, false, null),
      ('public._trip_unclaimed_receipts(uuid)', false, false, null),
      ('public._trip_overclaimed_receipts(uuid)', false, false, null),
      ('public._receipt_leftover_confirmed(uuid)', false, false, null),
      ('public._receipt_begin(uuid,boolean)', false, false, null),
      ('public._receipt_refresh_status(uuid)', false, false, null),
      ('public._receipt_leftover_plan(uuid,uuid[])', false, false, null),
      ('public._receipt_leftover_distribute(uuid,uuid[],bigint[])', false, false, null),
      ('public._receipt_leftover_place(uuid,jsonb)', false, false, null),
      ('public._receipt_strip_leftovers(uuid)', false, false, null),
      ('public.guard_claim_provenance()', false, false, null),
      ('public.guard_claim_overclaim()', false, false, null),
      ('public.guard_expense_leftover_mode()', false, false, null),
      ('public.refund_rate_limit(uuid,text,integer)', false, false, true),
      ('public.set_receipt_claims(uuid,jsonb)', false, true, null),
      ('public.share_receipt_leftovers(uuid,text,uuid,boolean)', false, true, true),
      ('public.freeze_settlements(uuid,jsonb,jsonb,uuid[])', false, true, null)
    ) AS x(f, want_anon, want_auth, want_service) LOOP
      IF has_function_privilege('anon', r.f, 'EXECUTE') IS DISTINCT FROM r.want_anon
         OR has_function_privilege('authenticated', r.f, 'EXECUTE') IS DISTINCT FROM r.want_auth
         OR (r.want_service IS NOT NULL AND has_function_privilege('service_role', r.f, 'EXECUTE') IS DISTINCT FROM r.want_service) THEN
        v_bad := v_bad || r.f || ' ';
      END IF;
    END LOOP;
    PERFORM pg_temp.rh_rec('struct.privileges', v_bad = '', CASE WHEN v_bad = '' THEN '19 functions: anon/authenticated/service_role EXECUTE as intended' ELSE 'wrong: ' || v_bad END);
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.rh_rec('struct', false, 'ERROR ' || SQLSTATE || ' ' || SQLERRM);
  END;
END
$rh$;

-- ===== 2. the freeze guard helpers on EVERY trip (read-only) ======================================================================
DO $rh$
DECLARE
  v_total integer; v_txt text; v_bad text;
BEGIN
  BEGIN
    SELECT count(*) INTO v_total FROM public.trips;
    SELECT string_agg(s.nm || ' unclaimed=' || s.u || ' over=' || s.o, '; ' ORDER BY s.nm),
           string_agg(s.nm, ', ' ORDER BY s.nm) FILTER (WHERE s.nm NOT ILIKE '%test%')
      INTO v_txt, v_bad
    FROM (
      SELECT t.name AS nm, c.u, c.o
      FROM public.trips t
      CROSS JOIN LATERAL (SELECT (SELECT count(*) FROM public._trip_unclaimed_receipts(t.id)) AS u,
                                 (SELECT count(*) FROM public._trip_overclaimed_receipts(t.id)) AS o) c
      WHERE c.u > 0 OR c.o > 0
    ) s;
    PERFORM pg_temp.rh_rec('guard.all_trips', v_bad IS NULL,
      format('%s trips checked; with flags: %s%s', v_total, coalesce(v_txt, 'none'), CASE WHEN v_bad IS NULL THEN '' ELSE ' | NON-TEST TRIPS FLAGGED: ' || v_bad END));
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.rh_rec('guard.all_trips', false, 'ERROR ' || SQLSTATE || ' ' || SQLERRM);
  END;
END
$rh$;

-- ===== 3. the test expense, written as the owner (A) would ========================================================================
DO $rh$
DECLARE
  v_trip uuid := pg_temp.rh_ctx('trip')::uuid; v_a uuid := pg_temp.rh_ctx('a')::uuid; v_b uuid := pg_temp.rh_ctx('b')::uuid;
  v_e uuid; v_l1 uuid; v_l2 uuid; v_l3 uuid;
BEGIN
  IF v_a IS NULL OR v_b IS NULL THEN
    PERFORM pg_temp.rh_rec('setup.expense', false, 'no test trip / people');
    RETURN;
  END IF;
  BEGIN
    PERFORM pg_temp.rh_jwt(v_a);
    SET LOCAL ROLE authenticated;
    INSERT INTO public.expenses (trip_id, paid_by, amount, currency, description, status, ai_parsed, participant_ids)
    VALUES (v_trip, v_a, 22.02, 'GBP', 'REHEARSAL receipt (rolled back)', 'unallocated', true, ARRAY[v_a, v_b])
    RETURNING id INTO v_e;
    INSERT INTO public.expense_line_items (expense_id, line_number, name_original, quantity, unit_price, subtotal, total_amount)
    VALUES (v_e, 1, 'Rehearsal pizza', 1, 12.01, 12.01, 12.01) RETURNING id INTO v_l1;
    INSERT INTO public.expense_line_items (expense_id, line_number, name_original, quantity, unit_price, subtotal, total_amount)
    VALUES (v_e, 2, 'Rehearsal beers x3', 3, 3.33, 10.00, 10.00) RETURNING id INTO v_l2;
    INSERT INTO public.expense_line_items (expense_id, line_number, name_original, quantity, unit_price, subtotal, total_amount)
    VALUES (v_e, 3, 'Rehearsal one penny', 1, 0.01, 0.01, 0.01) RETURNING id INTO v_l3;
    RESET ROLE;
    INSERT INTO _rh_ctx VALUES ('e', v_e::text), ('l1', v_l1::text), ('l2', v_l2::text), ('l3', v_l3::text);
    PERFORM pg_temp.rh_rec('setup.expense', true, 'GBP 22.02: 12.01 + 10.00 (3 units) + 0.01; tagged A and B; payer A');
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM pg_temp.rh_rec('setup.expense', false, 'ERROR ' || SQLSTATE || ' ' || SQLERRM);
  END;
END
$rh$;

-- ===== 4. A (payer): set_receipt_claims -> line 1 to B, line 2 shared A+B, line 3 left open =======================================
DO $rh$
DECLARE
  v_a uuid := pg_temp.rh_ctx('a')::uuid; v_b uuid := pg_temp.rh_ctx('b')::uuid; v_e uuid := pg_temp.rh_ctx('e')::uuid;
  v_l1 uuid := pg_temp.rh_ctx('l1')::uuid; v_l2 uuid := pg_temp.rh_ctx('l2')::uuid; v_l3 uuid := pg_temp.rh_ctx('l3')::uuid;
  v_r jsonb; v_q1 numeric; v_m1 numeric; v_s1 text; v_cb1 uuid; v_n2 integer; v_q2 numeric; v_m2 numeric; v_n3 integer; v_status text; v_bs text;
BEGIN
  IF v_e IS NULL THEN PERFORM pg_temp.rh_rec('rpc.assign', false, 'no test expense'); RETURN; END IF;
  BEGIN
    PERFORM pg_temp.rh_jwt(v_a);
    SET LOCAL ROLE authenticated;
    v_r := public.set_receipt_claims(v_e, jsonb_build_array(
      jsonb_build_object('line_item_id', v_l1, 'user_ids', jsonb_build_array(v_b)),
      jsonb_build_object('line_item_id', v_l2, 'user_ids', jsonb_build_array(v_a, v_b))));
    RESET ROLE;
    SELECT quantity_claimed, amount_owed, source, created_by INTO v_q1, v_m1, v_s1, v_cb1 FROM public.expense_item_claims WHERE line_item_id = v_l1 AND user_id = v_b;
    SELECT count(*), sum(quantity_claimed), sum(amount_owed) INTO v_n2, v_q2, v_m2 FROM public.expense_item_claims WHERE line_item_id = v_l2;
    SELECT count(*) INTO v_n3 FROM public.expense_item_claims WHERE line_item_id = v_l3;
    SELECT source INTO v_bs FROM public.expense_item_claims WHERE line_item_id = v_l2 AND user_id = v_b;
    SELECT status::text INTO v_status FROM public.expenses WHERE id = v_e;
    PERFORM pg_temp.rh_rec('rpc.assign',
      v_q1 = 1 AND v_m1 = 12.01 AND v_s1 = 'on_behalf' AND v_cb1 = v_a AND v_n2 = 2 AND v_q2 = 3 AND v_m2 = 10 AND v_n3 = 0 AND v_bs = 'shared'
      AND (v_r ->> 'unclaimed_total')::numeric = 0.01 AND jsonb_array_length(v_r -> 'unclaimed_lines') = 1,
      format('line1 B qty %s amt %s %s by_payer=%s | line2 rows=%s qty=%s amt=%s | line3 rows=%s | unclaimed_total=%s', v_q1, v_m1, v_s1, v_cb1 = v_a, v_n2, v_q2, v_m2, v_n3, v_r ->> 'unclaimed_total'));
    PERFORM pg_temp.rh_rec('status.after_claims (live trigger + tolerant refresh)', v_status = 'pending_allocation', 'expenses.status = ' || coalesce(v_status, 'null'));
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM pg_temp.rh_rec('rpc.assign', false, 'ERROR ' || SQLSTATE || ' ' || SQLERRM);
  END;
END
$rh$;

-- ===== 5. B (ordinary person): self-toggle, cannot toggle others, direct writes pinned, over-claim refused ===========================
DO $rh$
DECLARE
  v_a uuid := pg_temp.rh_ctx('a')::uuid; v_b uuid := pg_temp.rh_ctx('b')::uuid; v_e uuid := pg_temp.rh_ctx('e')::uuid;
  v_l2 uuid := pg_temp.rh_ctx('l2')::uuid; v_l3 uuid := pg_temp.rh_ctx('l3')::uuid; v_mgr boolean := pg_temp.rh_ctx('b_manager')::boolean;
  v_n integer; v_src text; v_cb uuid; v_lq numeric; v_la numeric; v_q numeric; v_st text; v_hint text; v_msg text; v_rows integer;
BEGIN
  IF v_e IS NULL THEN PERFORM pg_temp.rh_rec('client', false, 'no test expense'); RETURN; END IF;

  -- 5a. B adds themself to line 3, then takes themself off again
  BEGIN
    PERFORM pg_temp.rh_jwt(v_b);
    SET LOCAL ROLE authenticated;
    PERFORM public.set_receipt_claims(v_e, jsonb_build_array(jsonb_build_object('line_item_id', v_l3, 'user_ids', jsonb_build_array(v_b))));
    RESET ROLE;
    SELECT count(*) INTO v_n FROM public.expense_item_claims WHERE line_item_id = v_l3 AND user_id = v_b AND quantity_claimed = 1 AND amount_owed = 0.01;
    PERFORM pg_temp.rh_jwt(v_b);
    SET LOCAL ROLE authenticated;
    PERFORM public.set_receipt_claims(v_e, jsonb_build_array(jsonb_build_object('line_item_id', v_l3, 'user_ids', '[]'::jsonb)));
    RESET ROLE;
    PERFORM pg_temp.rh_rec('client.self_toggle', v_n = 1 AND NOT EXISTS (SELECT 1 FROM public.expense_item_claims WHERE line_item_id = v_l3),
      format('B added themself (rows with 1 / 0.01: %s), then took themself off (line 3 empty again)', v_n));
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM pg_temp.rh_rec('client.self_toggle', false, 'ERROR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- 5b. B puts somebody else on a line: refused (skipped when B can manage the trip)
  BEGIN
    PERFORM pg_temp.rh_jwt(v_b);
    SET LOCAL ROLE authenticated;
    PERFORM public.set_receipt_claims(v_e, jsonb_build_array(jsonb_build_object('line_item_id', v_l3, 'user_ids', jsonb_build_array(v_a))));
    RESET ROLE;
    DELETE FROM public.expense_item_claims WHERE line_item_id = v_l3;   -- only reachable when B can manage: undo
    PERFORM pg_temp.rh_rec('client.toggle_other_refused', coalesce(v_mgr, false), CASE WHEN v_mgr THEN 'SKIPPED: B can manage this trip, so B may do this' ELSE 'NOT refused' END);
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    PERFORM pg_temp.rh_rec('client.toggle_other_refused', SQLSTATE = '42501' AND v_hint = 'forbidden', SQLSTATE || ' hint=' || coalesce(v_hint, '') || ' ' || SQLERRM);
  END;

  -- 5c. B's DIRECT insert with forged provenance and leftover parts: stored as self / B / 0 / 0
  BEGIN
    PERFORM pg_temp.rh_jwt(v_b);
    SET LOCAL ROLE authenticated;
    INSERT INTO public.expense_item_claims (line_item_id, user_id, expense_id, quantity_claimed, amount_owed, source, created_by, leftover_quantity, leftover_amount)
    VALUES (v_l3, v_b, v_e, 0.5, 0.01, 'leftover', v_a, 0.25, 0.01);
    RESET ROLE;
    SELECT source, created_by, leftover_quantity, leftover_amount INTO v_src, v_cb, v_lq, v_la FROM public.expense_item_claims WHERE line_item_id = v_l3 AND user_id = v_b;
    PERFORM pg_temp.rh_rec('client.forged_insert_pinned', v_src = 'self' AND v_cb = v_b AND v_lq = 0 AND v_la = 0,
      format('stored source=%s created_by_is_B=%s leftover_qty=%s leftover_amt=%s', v_src, v_cb = v_b, v_lq, v_la));
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM pg_temp.rh_rec('client.forged_insert_pinned', false, 'ERROR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- 5d. B updates their own claim; a forged source / leftover part on UPDATE is ignored
  BEGIN
    PERFORM pg_temp.rh_jwt(v_b);
    SET LOCAL ROLE authenticated;
    UPDATE public.expense_item_claims SET quantity_claimed = 0.4, source = 'on_behalf', leftover_quantity = 0.3
     WHERE line_item_id = v_l3 AND user_id = v_b;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RESET ROLE;
    SELECT quantity_claimed, source, leftover_quantity INTO v_q, v_src, v_lq FROM public.expense_item_claims WHERE line_item_id = v_l3 AND user_id = v_b;
    PERFORM pg_temp.rh_rec('client.update_own', v_rows = 1 AND v_q = 0.4 AND v_src = 'self' AND v_lq = 0,
      format('rows=%s qty=%s source=%s leftover_qty=%s', v_rows, v_q, v_src, v_lq));
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM pg_temp.rh_rec('client.update_own', false, 'ERROR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- 5e. B's direct write that would over-claim line 3 (1 unit): refused with P0001 / overclaimed
  BEGIN
    PERFORM pg_temp.rh_jwt(v_b);
    SET LOCAL ROLE authenticated;
    UPDATE public.expense_item_claims SET quantity_claimed = 2 WHERE line_item_id = v_l3 AND user_id = v_b;
    RESET ROLE;
    PERFORM pg_temp.rh_rec('client.overclaim_refused', false, 'NOT refused');
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    PERFORM pg_temp.rh_rec('client.overclaim_refused', SQLSTATE = 'P0001' AND v_hint = 'overclaimed', SQLSTATE || ' hint=' || coalesce(v_hint, '') || ' ' || SQLERRM);
  END;

  -- 5f. B's direct write with an expense_id that is not the line's expense: refused (hardening)
  BEGIN
    PERFORM pg_temp.rh_jwt(v_b);
    SET LOCAL ROLE authenticated;
    INSERT INTO public.expense_item_claims (line_item_id, user_id, expense_id, quantity_claimed, amount_owed)
    VALUES (v_l2, v_b, gen_random_uuid(), 0.01, 0.01);
    RESET ROLE;
    PERFORM pg_temp.rh_rec('client.wrong_expense_refused', false, 'NOT refused');
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    PERFORM pg_temp.rh_rec('client.wrong_expense_refused', SQLSTATE = 'P0001' AND v_hint = 'bad_expense', SQLSTATE || ' hint=' || coalesce(v_hint, '') || ' ' || SQLERRM);
  END;

  -- 5g. B removes their own claim (leaves line 3 open again for the freeze test)
  BEGIN
    PERFORM pg_temp.rh_jwt(v_b);
    SET LOCAL ROLE authenticated;
    DELETE FROM public.expense_item_claims WHERE line_item_id = v_l3 AND user_id = v_b;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RESET ROLE;
    PERFORM pg_temp.rh_rec('client.delete_own', v_rows = 1 AND NOT EXISTS (SELECT 1 FROM public.expense_item_claims WHERE line_item_id = v_l3), 'deleted rows=' || v_rows);
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM pg_temp.rh_rec('client.delete_own', false, 'ERROR ' || SQLSTATE || ' ' || SQLERRM);
  END;
END
$rh$;

-- ===== 6. freeze is refused while line 3 is open (same argument shapes as src/lib/queries/useSettlements.ts) ==============================
DO $rh$
DECLARE
  v_trip uuid := pg_temp.rh_ctx('trip')::uuid; v_a uuid := pg_temp.rh_ctx('a')::uuid; v_b uuid := pg_temp.rh_ctx('b')::uuid; v_e uuid := pg_temp.rh_ctx('e')::uuid;
  v_hint text; v_detail text; v_known uuid[];
BEGIN
  IF v_e IS NULL THEN PERFORM pg_temp.rh_rec('freeze.refused_while_open', false, 'no test expense'); RETURN; END IF;
  SELECT coalesce(array_agg(s.id), ARRAY[]::uuid[]) INTO v_known FROM public.settlements s WHERE s.trip_id = v_trip AND s.status NOT IN ('suggested', 'confirmed');
  BEGIN
    PERFORM pg_temp.rh_jwt(v_a);
    SET LOCAL ROLE authenticated;
    PERFORM public.freeze_settlements(v_trip,
      jsonb_build_object('transactions', jsonb_build_array(jsonb_build_object('from', v_b, 'to', v_a, 'amount', 1, 'currency', 'GBP')), 'balances', '[]'::jsonb),
      jsonb_build_array(jsonb_build_object('from', v_b, 'to', v_a, 'amount', 1, 'currency', 'GBP')), v_known);
    RESET ROLE;
    PERFORM pg_temp.rh_rec('freeze.refused_while_open', false, 'NOT refused (the trip is now frozen)');
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_detail = PG_EXCEPTION_DETAIL;
    PERFORM pg_temp.rh_rec('freeze.refused_while_open', v_hint = 'unclaimed_receipts' AND position(v_e::text in coalesce(v_detail, '')) > 0,
      SQLSTATE || ' hint=' || coalesce(v_hint, '') || ' ' || SQLERRM || ' detail=' || coalesce(left(v_detail, 150), ''));
  END;
END
$rh$;

-- ===== 7. A shares the leftovers: preview writes nothing; 'everyone' is exact; 'same' repeats identically ===============================
DO $rh$
DECLARE
  v_a uuid := pg_temp.rh_ctx('a')::uuid; v_e uuid := pg_temp.rh_ctx('e')::uuid;
  v_before text; v_after text; v_mode_before text; v_mode_after text; v_r jsonb; v_bad integer; v_sumexp numeric; v_amt numeric; v_dups integer;
  v_zero integer; v_lo numeric; v_status text; v_mode text; v_res text;
  v_dump text := $q$ SELECT coalesce(string_agg(c.line_item_id::text || ':' || c.user_id::text || ':' || c.quantity_claimed || ':' || c.amount_owed || ':' || c.source || ':' || c.leftover_quantity || ':' || c.leftover_amount, ',' ORDER BY c.line_item_id, c.user_id), '') FROM public.expense_item_claims c WHERE c.expense_id = $1 $q$;
BEGIN
  IF v_e IS NULL THEN PERFORM pg_temp.rh_rec('share', false, 'no test expense'); RETURN; END IF;

  -- 7a. preview
  BEGIN
    EXECUTE v_dump INTO v_before USING v_e;
    SELECT leftover_mode INTO v_mode_before FROM public.expenses WHERE id = v_e;
    PERFORM pg_temp.rh_jwt(v_a);
    SET LOCAL ROLE authenticated;
    v_r := public.share_receipt_leftovers(v_e, 'everyone', NULL, true);
    RESET ROLE;
    EXECUTE v_dump INTO v_after USING v_e;
    SELECT leftover_mode INTO v_mode_after FROM public.expenses WHERE id = v_e;
    PERFORM pg_temp.rh_rec('share.preview_writes_nothing',
      v_before = v_after AND v_mode_before IS NOT DISTINCT FROM v_mode_after AND (v_r ->> 'preview')::boolean AND (v_r ->> 'unclaimed_total')::numeric = 0.01,
      format('claims unchanged=%s leftover_mode unchanged=%s unclaimed_total=%s allocated_total=%s', v_before = v_after, v_mode_before IS NOT DISTINCT FROM v_mode_after, v_r ->> 'unclaimed_total', v_r ->> 'allocated_total'));
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM pg_temp.rh_rec('share.preview_writes_nothing', false, 'ERROR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- 7b. share between everyone
  BEGIN
    PERFORM pg_temp.rh_jwt(v_a);
    SET LOCAL ROLE authenticated;
    v_r := public.share_receipt_leftovers(v_e, 'everyone');
    RESET ROLE;
    SELECT count(*) INTO v_bad FROM public.expense_line_items li
     WHERE li.expense_id = v_e AND li.total_amount <> coalesce((SELECT sum(c.amount_owed) FROM public.expense_item_claims c WHERE c.line_item_id = li.id), 0);
    SELECT sum(c.amount_owed) INTO v_amt FROM public.expense_item_claims c WHERE c.expense_id = v_e;
    SELECT amount INTO v_sumexp FROM public.expenses WHERE id = v_e;
    SELECT count(*) INTO v_dups FROM (SELECT line_item_id, user_id FROM public.expense_item_claims WHERE expense_id = v_e GROUP BY 1, 2 HAVING count(*) > 1) d;
    SELECT count(*) INTO v_zero FROM public.expense_item_claims WHERE expense_id = v_e AND quantity_claimed <= 0;
    SELECT count(*) INTO v_lo FROM public.expense_line_items li
     WHERE li.expense_id = v_e AND abs(coalesce((SELECT sum(c.quantity_claimed) FROM public.expense_item_claims c WHERE c.line_item_id = li.id), 0) - li.quantity) > 0.011;
    SELECT status::text, leftover_mode INTO v_status, v_mode FROM public.expenses WHERE id = v_e;
    PERFORM pg_temp.rh_rec('share.everyone_exact', v_bad = 0 AND v_amt = v_sumexp AND v_dups = 0 AND v_zero = 0 AND v_lo = 0,
      format('lines whose claims <> total: %s | receipt claimed %s of %s | duplicate (line,person): %s | zero-quantity rows: %s | lines off by > 0.011 qty: %s | allocated_total=%s',
             v_bad, v_amt, v_sumexp, v_dups, v_zero, v_lo, v_r ->> 'allocated_total'));
    PERFORM pg_temp.rh_rec('status.after_share (live trigger + tolerant refresh)', v_status = 'allocated' AND v_mode = 'everyone',
      format('expenses.status=%s leftover_mode=%s', v_status, v_mode));
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM pg_temp.rh_rec('share.everyone_exact', false, 'ERROR ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- 7c. 'same' re-run is identical
  BEGIN
    EXECUTE v_dump INTO v_before USING v_e;
    PERFORM pg_temp.rh_jwt(v_a);
    SET LOCAL ROLE authenticated;
    v_r := public.share_receipt_leftovers(v_e, 'same');
    RESET ROLE;
    EXECUTE v_dump INTO v_after USING v_e;
    SELECT count(*) INTO v_bad FROM public.expense_line_items li
     WHERE li.expense_id = v_e AND li.total_amount <> coalesce((SELECT sum(c.amount_owed) FROM public.expense_item_claims c WHERE c.line_item_id = li.id), 0);
    PERFORM pg_temp.rh_rec('share.same_identical', v_before = v_after AND v_bad = 0 AND v_r ->> 'mode' = 'everyone',
      format('rows identical=%s lines off=%s mode=%s', v_before = v_after, v_bad, v_r ->> 'mode'));
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM pg_temp.rh_rec('share.same_identical', false, 'ERROR ' || SQLSTATE || ' ' || SQLERRM);
  END;
END
$rh$;

-- ===== 8. freeze now succeeds (or is refused only for OTHER receipts on the test trip); then claims are locked ===========================
DO $rh$
DECLARE
  v_trip uuid := pg_temp.rh_ctx('trip')::uuid; v_a uuid := pg_temp.rh_ctx('a')::uuid; v_b uuid := pg_temp.rh_ctx('b')::uuid; v_e uuid := pg_temp.rh_ctx('e')::uuid;
  v_l2 uuid := pg_temp.rh_ctx('l2')::uuid; v_l3 uuid := pg_temp.rh_ctx('l3')::uuid;
  v_hint text; v_detail text; v_known uuid[]; v_r jsonb; v_frozen boolean; v_status text;
BEGIN
  IF v_e IS NULL THEN PERFORM pg_temp.rh_rec('freeze.ok', false, 'no test expense'); RETURN; END IF;
  SELECT coalesce(array_agg(s.id), ARRAY[]::uuid[]) INTO v_known FROM public.settlements s WHERE s.trip_id = v_trip AND s.status NOT IN ('suggested', 'confirmed');
  BEGIN
    PERFORM pg_temp.rh_jwt(v_a);
    SET LOCAL ROLE authenticated;
    v_r := public.freeze_settlements(v_trip,
      jsonb_build_object('transactions', jsonb_build_array(jsonb_build_object('from', v_b, 'to', v_a, 'amount', 1, 'currency', 'GBP')), 'balances', '[]'::jsonb),
      jsonb_build_array(jsonb_build_object('from', v_b, 'to', v_a, 'amount', 1, 'currency', 'GBP')), v_known);
    RESET ROLE;
    SELECT settlement_snapshot IS NOT NULL INTO v_frozen FROM public.trips WHERE id = v_trip;
    PERFORM pg_temp.rh_rec('freeze.ok_after_sharing', v_frozen, 'frozen=' || v_frozen || ' result=' || v_r::text);
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_detail = PG_EXCEPTION_DETAIL;
    -- other itemised receipts on the test trip may legitimately still block; that is fine as long as THIS receipt is not named
    PERFORM pg_temp.rh_rec('freeze.ok_after_sharing', v_hint IN ('unclaimed_receipts', 'overclaimed_receipts') AND position(v_e::text in coalesce(v_detail, '')) = 0,
      'refused: ' || SQLSTATE || ' hint=' || coalesce(v_hint, '') || ' ' || SQLERRM || ' detail=' || coalesce(left(v_detail, 150), '') || ' (OK only if it names other receipts)');
    UPDATE public.trips SET settlement_snapshot = jsonb_build_object('transactions', '[]'::jsonb) WHERE id = v_trip AND settlement_snapshot IS NULL;  -- so the locked-claims checks can run
  END;

  -- claims are locked while frozen: RPCs (hint frozen) and direct client writes
  BEGIN
    PERFORM pg_temp.rh_jwt(v_a);
    SET LOCAL ROLE authenticated;
    PERFORM public.set_receipt_claims(v_e, jsonb_build_array(jsonb_build_object('line_item_id', v_l3, 'user_ids', jsonb_build_array(v_a))));
    RESET ROLE;
    PERFORM pg_temp.rh_rec('frozen.set_receipt_claims_refused', false, 'NOT refused');
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    PERFORM pg_temp.rh_rec('frozen.set_receipt_claims_refused', SQLSTATE = 'P0001' AND v_hint = 'frozen', SQLSTATE || ' hint=' || coalesce(v_hint, '') || ' ' || SQLERRM);
  END;
  BEGIN
    PERFORM pg_temp.rh_jwt(v_a);
    SET LOCAL ROLE authenticated;
    PERFORM public.share_receipt_leftovers(v_e, 'same');
    RESET ROLE;
    PERFORM pg_temp.rh_rec('frozen.share_refused', false, 'NOT refused');
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    PERFORM pg_temp.rh_rec('frozen.share_refused', SQLSTATE = 'P0001' AND v_hint = 'frozen', SQLSTATE || ' hint=' || coalesce(v_hint, '') || ' ' || SQLERRM);
  END;
  BEGIN
    PERFORM pg_temp.rh_jwt(v_b);
    SET LOCAL ROLE authenticated;
    INSERT INTO public.expense_item_claims (line_item_id, user_id, expense_id, quantity_claimed, amount_owed) VALUES (v_l3, v_b, v_e, 0.01, 0.01);
    RESET ROLE;
    PERFORM pg_temp.rh_rec('frozen.direct_insert_refused', false, 'NOT refused');
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    PERFORM pg_temp.rh_rec('frozen.direct_insert_refused', SQLSTATE = 'P0001' AND v_hint = 'frozen', SQLSTATE || ' hint=' || coalesce(v_hint, '') || ' ' || SQLERRM);
  END;
  SELECT status::text INTO v_status FROM public.expenses WHERE id = v_e;
  PERFORM pg_temp.rh_rec('status.final', v_status = 'allocated', 'expenses.status = ' || coalesce(v_status, 'null'));
END
$rh$;

-- ===== FINAL: report through the error message (this also rolls everything back) ===============================================
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
