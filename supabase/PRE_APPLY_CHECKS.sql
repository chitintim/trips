-- PRE_APPLY_CHECKS.sql
-- Read-only checks to run against the LIVE database BEFORE applying the migrations
--   20261116090000_reset_trip_confirmations.sql          (A)
--   20261116100000_block_votes_on_closed_questions.sql   (B)
--   20261116120000_reset_action_reminders_on_date_change.sql (C)
--   20261116130000_guard_participant_removal.sql         (D)
-- Every statement is a SELECT. Nothing here writes. Run in the SQL editor and
-- read each result against the "safe result" comment above it.
-- Extra safety: dry-run each migration as `BEGIN; <file>; ROLLBACK;` on a
-- Supabase branch (DDL is transactional).

-- 1. Triggers on the affected tables.
--    Safe: no trigger on trip_participants (other than enforce_capacity_limit /
--    notify_conditional_users) reacts to a change AWAY from 'confirmed', and
--    nothing unexpected fires on UPDATE of confirmation_status or active.
--    Gates: A (bulk status reset), D (BEFORE UPDATE OF active), B and C (name clashes).
SELECT tgrelid::regclass AS tbl, tgname, tgenabled, pg_get_triggerdef(t.oid) AS def
FROM pg_trigger t
WHERE NOT tgisinternal
  AND tgrelid IN (
    'public.trip_participants'::regclass, 'public.option_votes'::regclass,
    'public.trips'::regclass, 'public.trip_actions'::regclass,
    'public.settlements'::regclass, 'public.notifications'::regclass,
    'public.activity_feed'::regclass
  )
ORDER BY 1, 2;

-- 2. Bodies of live-only helpers and triggers.
--    Safe: enforce_capacity_limit and notify_conditional_users act only on a
--    transition TO 'confirmed' (not FROM it): no waitlist promotion, email or
--    pg_net call when people are reset to 'pending'.
--    Gates: A.
SELECT proname, pg_get_functiondef(oid) AS def
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND proname IN (
    'enforce_capacity_limit', 'notify_conditional_users', 'check_conditions_met',
    'is_trip_organizer', 'is_trip_participant', 'can_view_trip',
    'update_trip_participants_updated_at'
  )
ORDER BY 1;

-- 3. RLS policies on the touched tables.
--    Safe: the trip_participants SELECT policy does NOT filter on the row's own
--    `active` column (so UPDATE ... RETURNING after active=false still passes).
--    If it does filter on active, the client must use the count form (it does
--    for deactivation and self-RSVP) and nothing else may add .select() there.
--    Gates: D (participant removal), A.
SELECT tablename, policyname, cmd, roles, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'trip_participants', 'planning_sections', 'option_votes', 'bookings', 'trips',
    'expenses', 'trip_timeline_events', 'notifications', 'activity_feed'
  )
ORDER BY tablename, policyname;

-- 4. Name collisions with objects the migrations create or replace.
--    Safe: either no rows, or rows whose result type matches what the migration
--    declares (currency_exponent -> integer; trip_participant_balance_minor ->
--    TABLE(net_minor numeric, unconvertible_expenses integer)). A different
--    result type makes CREATE OR REPLACE fail.
--    Gates: A, B, C, D.
SELECT proname, pg_get_function_identity_arguments(oid) AS args, pg_get_function_result(oid) AS result
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND proname IN (
    'currency_exponent', 'trip_participant_balance_minor', 'guard_participant_removal',
    'guard_option_votes_closed_question', 'reset_trip_confirmations',
    'reset_action_reminders_on_action_due_change', 'reset_action_reminders_on_trip_start_change'
  )
ORDER BY 1;

-- 5. Foreign-key delete actions.
--    Safe: option_votes -> options/sections 'c' (cascade); bookings.expense_id
--    and bookings.timeline_event_id 'n' (set null: the client now relies on this
--    when cancelling a booking's follow-ups).
--    Gates: B (cascade carve-out), D, and the client's useCancelBookingFollowUps.
SELECT conrelid::regclass AS tbl, conname, confdeltype, pg_get_constraintdef(oid) AS def
FROM pg_constraint
WHERE contype = 'f'
  AND conrelid IN (
    'public.option_votes'::regclass, 'public.bookings'::regclass,
    'public.trip_action_reminders'::regclass, 'public.trip_participants'::regclass
  )
ORDER BY 1, 2;

-- 6. CHECK / UNIQUE constraints that A's writes could hit.
--    Safe: nothing forbids confirmation_status='pending' with conditional_type
--    'none' and NULL conditional_*, or the activity_feed row A inserts
--    (verb 'confirmations_reset', entity/metadata jsonb).
--    Gates: A.
SELECT conrelid::regclass AS tbl, conname, pg_get_constraintdef(oid) AS def
FROM pg_constraint
WHERE contype IN ('c', 'u')
  AND conrelid IN (
    'public.activity_feed'::regclass, 'public.notifications'::regclass,
    'public.trip_participants'::regclass
  )
ORDER BY 1, 2;

-- 7. Anything that sends HTTP / email from SQL.
--    Safe: no function (or only ones that cannot fire on trip_participants /
--    notifications changes made by A) mentions net.http.
--    Gates: A.
SELECT proname
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND prosrc ILIKE '%net.http%'
ORDER BY 1;

-- 8a. Settlement status distribution.
--     Safe: only the known statuses (suggested, marked_paid, confirmed, ...).
--     Many 'suggested'/'marked_paid' rows mean D will block those people's removal.
--     Gates: D.
SELECT status, count(*) FROM public.settlements GROUP BY 1 ORDER BY 1;

-- 8b. Trips with foreign-currency expenses that have no fx_rate.
--     Safe: no rows. Any row means D refuses removal of people on those expenses
--     until a rate is added.
--     Gates: D.
SELECT e.trip_id, count(*) AS expenses_without_rate
FROM public.expenses e
JOIN public.trips t ON t.id = e.trip_id
WHERE e.currency <> t.base_currency AND e.fx_rate IS NULL
GROUP BY 1;

-- 8c. Settlements in a currency other than the trip's base currency.
--     Safe: 0. D (and the client) treat settlement amounts 1:1; a non-zero
--     count means balances for those trips may be off.
--     Gates: D.
SELECT count(*) AS foreign_currency_settlements
FROM public.settlements s
JOIN public.trips t ON t.id = s.trip_id
WHERE s.currency IS NOT NULL AND s.currency <> t.base_currency;

-- 8d. Notification kinds in use.
--     Safe: pending_rsvp / conditional_date_arrived / waitlist_offer are present
--     only as expected. These are the rows A's reset deletes (except today's).
--     Gates: A.
SELECT kind, count(*) FROM public.notifications GROUP BY 1 ORDER BY 1;

-- 8e. Finished trips that still have unsettled settlements.
--     Safe: informational. These are the trips whose settle-up reminders the
--     auto-chase fix keeps sending after the trip ends.
--     Gates: auto-chase deploy.
SELECT t.id, t.status, t.end_date, count(*) AS open_settlements
FROM public.trips t
JOIN public.settlements s ON s.trip_id = t.id
WHERE s.status IN ('suggested', 'marked_paid')
  AND (t.end_date < current_date OR t.status = 'trip_completed')
GROUP BY 1, 2, 3
ORDER BY 3;

-- 9. Is the settlements two-party guard the fixed version?
--    Safe: has_fix = true and proconfig contains a search_path. If has_fix is
--    false (or no row), the live guard_settlement_party_update lacks the
--    created_by/created_at escalation block: ship that fix as its own migration
--    (with SET search_path = public, pg_temp) BEFORE relying on D.
--    Gates: D (related settlements lifecycle).
SELECT prosrc LIKE '%May not change who created%' AS has_fix, proconfig
FROM pg_proc
WHERE proname = 'guard_settlement_party_update';

-- 10. Function privileges. Run this AFTER applying; it is the only post-apply check.
--     Safe: reset_trip_confirmations -> anon false, authenticated true;
--     trip_participant_balance_minor, guard_participant_removal,
--     guard_option_votes_closed_question, currency_exponent and the two
--     reset_action_reminders_* functions -> both false.
--     Gates: confirms A, B, C, D grants.
SELECT proname,
       has_function_privilege('anon', oid, 'execute') AS anon,
       has_function_privilege('authenticated', oid, 'execute') AS authd
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND proname IN (
    'reset_trip_confirmations', 'trip_participant_balance_minor',
    'guard_participant_removal', 'guard_option_votes_closed_question',
    'currency_exponent', 'reset_action_reminders_on_action_due_change',
    'reset_action_reminders_on_trip_start_change'
  )
ORDER BY 1;

-- ===========================================================================
-- Migration 20261117090000_question_passes.sql (Phase 2 slice 2A). All read-only.
-- ===========================================================================

-- 11a. Name collisions.
--      Safe: no rows from either query.
--      Gates: question_passes.
SELECT to_regclass('public.question_passes') AS existing_table;
SELECT proname, pg_get_function_identity_arguments(oid) AS args
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND proname IN ('question_pass_trip_id', 'guard_question_passes_closed_question');

-- 11b. The helper signatures the policies call.
--      Safe: is_admin(uuid), is_trip_organizer(uuid, uuid), is_trip_participant(uuid, uuid),
--      all returning boolean, prosecdef true. The argument ORDER is (trip_id, user_id);
--      confirm from the body if unsure.
--      Gates: question_passes policies.
SELECT proname, pg_get_function_identity_arguments(oid) AS args,
       pg_get_function_result(oid) AS result, prosecdef
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND proname IN ('is_admin', 'is_trip_organizer', 'is_trip_participant')
ORDER BY 1;

-- 11c. Parent columns and the section status type.
--      Safe: planning_sections.id uuid, trip_id uuid, status = section_status;
--      users.id uuid.
--      Gates: question_passes FKs, guard trigger.
SELECT table_name, column_name, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND ((table_name = 'planning_sections' AND column_name IN ('id', 'trip_id', 'status'))
    OR (table_name = 'users' AND column_name = 'id'))
ORDER BY 1, 2;

-- 11d. The Phase 1 closed-question guard is applied (same message and carve-outs).
--      Safe: one row whose prosrc contains 'Voting is closed for this question'.
--      If missing, apply 20261116100000 first (the pass guard is meant to match it).
--      Gates: question_passes guard.
SELECT proname, prosrc LIKE '%Voting is closed for this question%' AS same_message
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace AND proname = 'guard_option_votes_closed_question';

-- 11e. Which answer tables are in the realtime publication.
--      Safe: informational. The migration adds question_passes only if
--      option_votes is listed here. If it is not, realtime for votes is not
--      published either, and passes simply refresh on the user's own actions
--      and on window focus.
--      Gates: question_passes realtime.
SELECT tablename FROM pg_publication_tables
WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
  AND tablename IN ('option_votes', 'selections', 'planning_sections', 'question_passes')
ORDER BY 1;

-- 11f. Default privileges on new public tables (what the REVOKE/GRANT overrides).
--      Safe: informational.
--      Gates: question_passes grants.
SELECT defaclrole::regrole AS owner, defaclobjtype, defaclacl
FROM pg_default_acl
WHERE defaclnamespace = 'public'::regnamespace;

-- 11g. AFTER applying: table privileges and policies.
--      Safe: anon has none; authenticated has exactly DELETE, INSERT, SELECT;
--      three policies (select, insert_own, delete_own) exist; RLS is on.
SELECT grantee, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name = 'question_passes'
GROUP BY 1 ORDER BY 1;
SELECT policyname, cmd, roles, qual, with_check
FROM pg_policies WHERE schemaname = 'public' AND tablename = 'question_passes' ORDER BY 1;
SELECT relrowsecurity FROM pg_class WHERE oid = 'public.question_passes'::regclass;

-- ============================================================================
-- 12. 20261117100000_todo_who_mode.sql  (To-dos "Who" modes, slice 2E)
-- ============================================================================

-- 12a. The column does not exist yet (the migration adds it).
--      Safe: zero rows before applying, one row after.
--      Gates: who_mode column.
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'trip_actions' AND column_name = 'who_mode';

-- 12b. The constraint the migration drops (a "fixed" to-do must have a due date).
--      Safe: EXACTLY ONE row now (trip_actions_due_when_fixed); zero rows after applying.
--      The migration fails loudly (RAISE EXCEPTION) if this row is missing on a first apply.
--      If it is not exactly one row, STOP and find the live name before applying.
--      Gates: optional due date.
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.trip_actions'::regclass AND conname = 'trip_actions_due_when_fixed';

-- 12c. Everything that can already touch these two tables: ALL policies (every command),
--      ALL triggers (non-internal) and ALL constraints. The migration changes no policy; it
--      only drops four claim policies that should not exist yet (a no-op here).
--      Safe: informational. Expect NO policy whose name contains 'up-for-grabs', and the
--      creator/assignee/organizer UPDATE policy on each table.
--      Gates: claim / give back.
SELECT 'policy' AS kind, tablename AS tbl, policyname AS name, cmd AS detail, coalesce(qual, '') || ' || ' || coalesce(with_check, '') AS definition
FROM pg_policies
WHERE schemaname = 'public' AND tablename IN ('trip_actions', 'trip_checklists')
UNION ALL
SELECT 'trigger', c.relname, t.tgname, '', pg_get_triggerdef(t.oid)
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
WHERE c.oid IN ('public.trip_actions'::regclass, 'public.trip_checklists'::regclass) AND NOT t.tgisinternal
UNION ALL
SELECT 'constraint', c.relname, k.conname, k.contype::text, pg_get_constraintdef(k.oid)
FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
WHERE k.conrelid IN ('public.trip_actions'::regclass, 'public.trip_checklists'::regclass)
ORDER BY 1, 2, 3;

-- 12c-2. claim_todo must not exist yet (the migration creates it).
--      Safe: zero rows before applying.
SELECT p.oid::regprocedure AS existing_function
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'claim_todo';

-- 12d. Existing rows keep their meaning: who_mode is added NULL, so every action with no
--      assignee is still "Everyone" and every checklist item with none is still "Anyone".
--      Safe: informational counts (live at schema time: 17 actions, 9 checklist items).
SELECT 'trip_actions: everyone (no assignee)' AS bucket, count(*) FROM public.trip_actions WHERE assigned_to IS NULL
UNION ALL SELECT 'trip_actions: named person', count(*) FROM public.trip_actions WHERE assigned_to IS NOT NULL
UNION ALL SELECT 'trip_checklists: anyone (no assignee)', count(*) FROM public.trip_checklists WHERE assigned_to IS NULL
UNION ALL SELECT 'trip_checklists: named person', count(*) FROM public.trip_checklists WHERE assigned_to IS NOT NULL;

-- 12e. AFTER applying: all existing rows still have who_mode NULL, no claim policy exists,
--      and claim_todo is SECURITY DEFINER with a fixed search_path, callable by signed-in users only.
--      Safe: 0 non-null rows; zero 'up-for-grabs' policies; one claim_todo row with
--      prosecdef = true, has_search_path = true, anon_can_execute = false, authenticated_can_execute = true.
SELECT count(*) FILTER (WHERE who_mode IS NOT NULL) AS non_null_who_mode, count(*) AS total FROM public.trip_actions;
SELECT tablename, policyname FROM pg_policies
WHERE schemaname = 'public' AND tablename IN ('trip_actions', 'trip_checklists') AND policyname ILIKE '%up-for-grabs%'
ORDER BY 1, 2;
SELECT p.oid::regprocedure AS fn,
       p.prosecdef,
       coalesce(p.proconfig::text ILIKE '%search_path%', false) AS has_search_path,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'claim_todo';

-- ============================================================================
-- 13. 20261117110000_delete_question.sql  (delete a question atomically + selections guard)
-- ============================================================================

-- 13a. Name clashes: nothing called delete_question / guard_selections_closed_question
--      exists yet, and there is no trigger named selections_guard_closed_question.
--      Safe: zero rows from all three.
--      Gates: name clash.
SELECT proname, oidvectortypes(proargtypes) AS args FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND proname IN ('delete_question', 'guard_selections_closed_question');
SELECT tgname FROM pg_trigger
WHERE tgrelid = 'public.selections'::regclass AND tgname = 'selections_guard_closed_question';

-- 13b. Delete actions of every FK that references planning_sections or options
--      (confdeltype: a = NO ACTION, r = RESTRICT, c = CASCADE, n = SET NULL, d = SET DEFAULT).
--      The function does not rely on any of them (it NULLs out / deletes explicitly), so this
--      is informational. Confirmed live earlier: option_votes.option_id c, bookings.option_id n,
--      trip_actions.section_id n. Check question_passes.section_id is c (if that table exists).
--      Safe: informational.
--      Gates: nothing; documents what the explicit steps replace.
SELECT conrelid::regclass AS referrer, conname, confrelid::regclass AS referenced,
       confdeltype AS on_delete, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE contype = 'f'
  AND confrelid IN ('public.planning_sections'::regclass, 'public.options'::regclass)
ORDER BY 3, 1, 2;

-- 13c. Existing triggers on selections (the migration adds selections_guard_closed_question).
--      Safe: informational; expect none (or only ones you recognise).
--      Gates: an unexpected trigger that interacts with the new BEFORE trigger.
SELECT tgname, tgenabled, pg_get_triggerdef(t.oid) AS def
FROM pg_trigger t
WHERE NOT tgisinternal AND tgrelid = 'public.selections'::regclass
ORDER BY 1;

-- 13d. LEGACY-DATA RISK: completed sections that have selections. After applying, signed-in
--      users can no longer add, change or remove selections on these (service role still can).
--      "own_choice" = decision_shape 'personal' (order forms, opt-in lists), where people may
--      have kept editing after the section was marked completed. Reopen any section that
--      should stay editable BEFORE applying.
--      Safe: you recognise every row as genuinely finished (live had 18 completed sections,
--      6 trips with status trip_completed).
--      Gates: the selections guard.
SELECT t.id AS trip_id, t.name, t.status AS trip_status, ps.id AS section_id, ps.title,
       COALESCE(ps.metadata ->> 'decision_shape', '(none: vote)') AS decision_shape,
       count(sel.id) AS selections, max(sel.selected_at) AS last_selection_at
FROM public.planning_sections ps
JOIN public.trips t ON t.id = ps.trip_id
JOIN public.options o ON o.section_id = ps.id
JOIN public.selections sel ON sel.option_id = o.id
WHERE ps.status = 'completed'
GROUP BY t.id, t.name, t.status, ps.id, ps.title, ps.metadata
ORDER BY (t.status = 'trip_completed'), t.name, ps.title;

-- 13e. AFTER applying: the function is callable by signed-in users only, the trigger
--      function by nobody, and the trigger exists.
--      Safe: delete_question anon_can = false, authenticated_can = true;
--      guard_selections_closed_question both false; one row from the trigger query.
SELECT 'delete_question' AS fn,
       has_function_privilege('anon', 'public.delete_question(uuid)', 'EXECUTE') AS anon_can,
       has_function_privilege('authenticated', 'public.delete_question(uuid)', 'EXECUTE') AS authenticated_can
UNION ALL
SELECT 'guard_selections_closed_question',
       has_function_privilege('anon', 'public.guard_selections_closed_question()', 'EXECUTE'),
       has_function_privilege('authenticated', 'public.guard_selections_closed_question()', 'EXECUTE');
SELECT tgname, tgenabled, pg_get_triggerdef(oid) AS def FROM pg_trigger
WHERE tgrelid = 'public.selections'::regclass AND tgname = 'selections_guard_closed_question';
