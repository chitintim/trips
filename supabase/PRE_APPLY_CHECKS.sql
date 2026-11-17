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

-- 12f. Name collisions for the update guard: the function and both triggers must be free.
--      Safe: zero rows before applying (this also lists any existing non-internal triggers on
--      the two tables; they will run alongside the new guard, check they do not clash).
--      Gates: update guard.
SELECT 'function' AS kind, p.oid::regprocedure::text AS name
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'guard_todo_update'
UNION ALL
SELECT 'trigger', c.relname || '.' || t.tgname
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
WHERE c.oid IN ('public.trip_actions'::regclass, 'public.trip_checklists'::regclass)
  AND NOT t.tgisinternal
  AND t.tgname IN ('trip_actions_guard_update', 'trip_checklists_guard_update');

-- 12g. All existing non-internal triggers on the two tables (informational).
SELECT c.relname AS tbl, t.tgname, pg_get_triggerdef(t.oid) AS definition
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
WHERE c.oid IN ('public.trip_actions'::regclass, 'public.trip_checklists'::regclass) AND NOT t.tgisinternal
ORDER BY 1, 2;

-- 12h. FORCE ROW LEVEL SECURITY must be off on these tables (the SECURITY DEFINER functions
--      rely on the owner bypassing RLS).
--      Safe: relforcerowsecurity = false on every row.
SELECT relname, relrowsecurity, relforcerowsecurity
FROM pg_class
WHERE oid IN ('public.activity_feed'::regclass, 'public.trip_actions'::regclass,
              'public.trip_checklists'::regclass, 'public.selections'::regclass)
ORDER BY 1;

-- 12i. AFTER applying: guard_todo_update is a trigger function only, not callable by clients.
--      Safe: one row, anon_can_execute = false, authenticated_can_execute = false, prosecdef = true;
--      plus two trigger rows (trip_actions_guard_update, trip_checklists_guard_update).
SELECT p.oid::regprocedure AS fn,
       p.prosecdef,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'guard_todo_update';
SELECT c.relname, t.tgname, t.tgenabled
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
WHERE t.tgname IN ('trip_actions_guard_update', 'trip_checklists_guard_update') AND NOT t.tgisinternal;

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

-- ============================================================================
-- 14. 20261118090000_decide_and_book.sql  (decide_question, auto_decide_question, mark_booked, unmark_booked)
-- ============================================================================

-- 14a. Name clashes: none of the six new functions exists yet.
--      Safe: zero rows.
--      Gates: name clash (CREATE OR REPLACE would silently replace an unrelated function).
SELECT proname, oidvectortypes(proargtypes) AS args FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND proname IN ('decide_question', 'auto_decide_question', 'mark_booked', 'unmark_booked',
                  'question_vote_tally', 'assert_can_manage_trip');

-- 14b. Columns and enum values the functions write or read.
--      Safe: every column below is listed; section_status has completed/in_progress;
--      option_status has booked/available/cancelled; timeline_event_category has
--      accommodation/flight/transport/activity/other; trips.chase_settings is jsonb.
--      Gates: any missing column / enum label = a runtime error on first use.
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND (
  (table_name = 'planning_sections' AND column_name IN ('status', 'metadata', 'voting_method', 'vote_deadline', 'quorum', 'section_type', 'title', 'trip_id'))
  OR (table_name = 'trip_participants' AND column_name IN ('trip_id', 'user_id', 'active', 'confirmation_status', 'role'))
  OR (table_name = 'options' AND column_name IN ('status', 'title', 'description', 'place_id', 'currency', 'metadata', 'section_id'))
  OR (table_name = 'option_votes' AND column_name IN ('option_id', 'user_id', 'rank'))
  OR (table_name = 'trip_timeline_events' AND column_name IN ('trip_id', 'event_date', 'start_time', 'end_time', 'all_day', 'title', 'description', 'category', 'place_id', 'source_option_id', 'created_by'))
  OR (table_name = 'trip_actions' AND column_name IN ('trip_id', 'title', 'notes', 'created_by', 'assigned_to', 'deadline_kind', 'due_date', 'completed_at', 'completed_by', 'section_id'))
  OR (table_name = 'trip_action_completions' AND column_name IN ('action_id', 'user_id', 'trip_id'))
  OR (table_name = 'bookings' AND column_name IN ('trip_id', 'option_id', 'title', 'vendor', 'confirmation_ref', 'booked_by', 'amount', 'currency', 'booking_date', 'cancellation_deadline', 'refundable', 'status', 'document_url', 'expense_id', 'timeline_event_id', 'place_id', 'notes', 'updated_at'))
  OR (table_name = 'activity_feed' AND column_name IN ('trip_id', 'actor', 'verb', 'entity', 'metadata'))
  OR (table_name = 'trips' AND column_name IN ('chase_settings', 'status', 'base_currency', 'created_by'))
)
ORDER BY table_name, column_name;
SELECT t.typname, e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
WHERE t.typname IN ('section_status', 'option_status', 'timeline_event_category', 'section_type', 'participant_role', 'trip_status')
ORDER BY t.typname, e.enumsortorder;

-- 14c. Triggers on every table the functions write (a BEFORE/AFTER trigger could veto or
--      rewrite a row). Expect: set_updated_at on options / planning_sections, the due-date
--      reminder reset on trip_actions, guard_todo_update on trip_actions if 12 is applied,
--      and nothing on trip_timeline_events / bookings / activity_feed.
--      Safe: only triggers you recognise.
--      Gates: an unknown trigger on trip_timeline_events, trip_actions, bookings, options or planning_sections.
SELECT c.relname AS table_name, t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) AS def
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
WHERE NOT t.tgisinternal
  AND c.oid IN ('public.trip_timeline_events'::regclass, 'public.trip_actions'::regclass, 'public.bookings'::regclass,
                'public.options'::regclass, 'public.planning_sections'::regclass, 'public.activity_feed'::regclass,
                'public.trip_action_completions'::regclass)
ORDER BY 1, 2;

-- 14d. CHECK constraints on trip_actions and bookings (decide_question writes a title <= 120
--      chars and notes <= 400 chars; with trip_actions_due_when_fixed still present a
--      "Book it" to-do with no due date is stored as before_trip, otherwise fixed + NULL).
--      Safe: title/notes limits are >= 120 / 400 characters (or absent).
--      Gates: the Book-it to-do insert.
SELECT conrelid::regclass AS tbl, conname, pg_get_constraintdef(oid) AS def
FROM pg_constraint
WHERE contype IN ('c', 'u') AND conrelid IN ('public.trip_actions'::regclass, 'public.bookings'::regclass,
  'public.trip_timeline_events'::regclass, 'public.options'::regclass, 'public.planning_sections'::regclass,
  'public.activity_feed'::regclass, 'public.trip_action_completions'::regclass)
ORDER BY 1, 2;
-- Expect: bookings_title_length <= 200, trip_actions title <= 300 (we write <= 120), no trip_actions_due_when_fixed if
-- 2E is applied. Any CHECK on trip_timeline_events.title / description shorter than 200 / the option's own limit
-- gates decide_question's "put it on the plan" (titles are cut to 200).

-- 14e. chase_settings.auto_decide: which trips already carry the key, and its value. Expect
--      none (absent = ON). Any 'false' here switches auto-decide off for that trip.
--      Safe: informational.
SELECT id, name, chase_settings -> 'auto_decide' AS auto_decide, chase_settings ->> 'enabled' AS chasing
FROM public.trips WHERE chase_settings ? 'auto_decide';

-- 14f. PREVIEW of what the FIRST auto-decide run would do (the job only looks at trips with chasing on,
--      but this shows every trip so you can see the effect of switching it on). One row per open question
--      whose deadline has passed. 'answered' counts only people still in scope (active, not declined/cancelled)
--      who voted on a live option; 'needed' is the question's quorum, else ceil(in_scope / 2).
--      would_decide = enough answers AND one unique top option; the Ideas list, Own-choice questions, date
--      polls and questions with a booked option are never decided.
--      Safe: informational. Review every 'would_decide = true' row by hand before deploying auto-chase.
WITH q AS (
  SELECT t.id AS trip_id, t.name AS trip, t.status AS trip_status, t.chase_settings, ps.id AS section_id, ps.title, ps.vote_deadline,
         ps.voting_method, ps.quorum, ps.metadata,
         (SELECT count(*) FROM public.trip_participants tp WHERE tp.trip_id = t.id AND tp.active
            AND COALESCE(tp.confirmation_status::text, '') NOT IN ('declined', 'cancelled')) AS in_scope,
         (SELECT count(DISTINCT v.user_id) FROM public.option_votes v JOIN public.options o ON o.id = v.option_id
            JOIN public.trip_participants tp ON tp.user_id = v.user_id AND tp.trip_id = t.id
           WHERE o.section_id = ps.id AND o.status <> 'cancelled' AND tp.active
             AND COALESCE(tp.confirmation_status::text, '') NOT IN ('declined', 'cancelled')) AS answered,
         (SELECT count(DISTINCT v.user_id) FROM public.option_votes v JOIN public.options o ON o.id = v.option_id
           WHERE o.section_id = ps.id) AS voters_all,
         EXISTS (SELECT 1 FROM public.options o WHERE o.section_id = ps.id AND o.status = 'booked') AS has_booked
  FROM public.planning_sections ps JOIN public.trips t ON t.id = ps.trip_id
  WHERE ps.status <> 'completed' AND ps.vote_deadline IS NOT NULL AND ps.vote_deadline <= now()
)
SELECT trip, trip_status, title, vote_deadline, voting_method, quorum, in_scope, answered, voters_all,
       CASE WHEN COALESCE(quorum, 0) > 0 THEN quorum ELSE GREATEST(1, ceil(in_scope / 2.0)::int) END AS needed,
       has_booked, COALESCE(metadata ->> 'ideas_bucket', 'false') AS ideas_bucket, COALESCE(metadata ->> 'decision_shape', '') AS shape,
       COALESCE(chase_settings ->> 'enabled', 'false') AS chasing_on,
       (trip_status <> 'trip_completed' AND NOT has_booked AND COALESCE(metadata ->> 'ideas_bucket', '') <> 'true'
         AND COALESCE(metadata ->> 'decision_shape', '') <> 'personal' AND lower(btrim(title)) <> 'trip dates'
         AND answered >= CASE WHEN COALESCE(quorum, 0) > 0 THEN quorum ELSE GREATEST(1, ceil(in_scope / 2.0)::int) END
         AND COALESCE(chase_settings ->> 'enabled', 'false') = 'true') AS would_attempt
FROM q ORDER BY vote_deadline;

-- 14f2. Open questions that already have a booked option (the engine treats them as decided for a Group choice
--       only; an Own-choice question's booked option does NOT close it).
SELECT t.name AS trip, ps.title, ps.status, COALESCE(ps.metadata ->> 'decision_shape', '(group)') AS shape,
       count(*) FILTER (WHERE o.status = 'booked') AS booked_options
FROM public.planning_sections ps JOIN public.trips t ON t.id = ps.trip_id JOIN public.options o ON o.section_id = ps.id
WHERE ps.status <> 'completed'
GROUP BY 1, 2, 3, 4 HAVING count(*) FILTER (WHERE o.status = 'booked') > 0;

-- 14f3. Trips with chasing switched ON (auto-decide and announcements only run for these) and the Ideas lists.
SELECT name, status, chase_settings FROM public.trips WHERE chase_settings IS NOT NULL;
SELECT t.name, ps.title, ps.status, ps.vote_deadline FROM public.planning_sections ps JOIN public.trips t ON t.id = ps.trip_id
WHERE ps.metadata ->> 'ideas_bucket' = 'true';

-- 14f4. Stage-sync preview (auto-chase moves a stored status FORWARD from its dates, unless a human changed
--       the status after the boundary: start 00:00 UTC for ongoing, end_date + 1 day 00:00 UTC for completed).
--       Expect Japan 2026 and Sailing Sicily to move to trip_completed on the first run.
SELECT t.name, t.status, t.start_date, t.end_date,
       CASE WHEN now() >= (t.end_date + 1)::timestamptz AND t.status <> 'trip_completed' THEN 'trip_completed'
            WHEN now() >= t.start_date::timestamptz AND t.status NOT IN ('trip_completed', 'trip_ongoing') THEN 'trip_ongoing' END AS would_move_to,
       (SELECT max(a.created_at) FROM public.activity_feed a WHERE a.trip_id = t.id AND a.verb = 'status_changed'
          AND COALESCE(a.metadata ->> 'auto', 'false') <> 'true') AS last_human_status_change
FROM public.trips t WHERE t.status <> 'trip_completed' AND now() >= t.start_date::timestamptz;

-- 14f5. Option titles longer than 200 characters (event and booking titles are cut to 200; the Book: to-do to 120).
SELECT count(*) AS long_option_titles FROM public.options WHERE char_length(title) > 200;

-- 14f6. Does the function owner bypass RLS? The functions insert activity_feed rows with a NULL actor
--       (auto-decide) and run as the owner. Expect rolbypassrls = true (or the owner owning the table with
--       no FORCE ROW LEVEL SECURITY). Gates: false here = the auto-decide activity row would be rejected.
SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user;
SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.activity_feed'::regclass;
SELECT polname, polcmd, pg_get_expr(polqual, polrelid) AS using_expr, pg_get_expr(polwithcheck, polrelid) AS check_expr
FROM pg_policy WHERE polrelid = 'public.activity_feed'::regclass;   -- can the audit row be deleted by participants?

-- 14f7. Other overloads of question_vote_tally (the migration replaces the one-argument form's role with
--       question_vote_tally(uuid, boolean)); expect 0 rows before applying.
SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'question_vote_tally';

-- 14g. AFTER applying: privileges (execute rights for anon / authenticated / service_role on EVERY new function). decide_question / mark_booked / unmark_booked callable by
--      signed-in users only; auto_decide_question by the service role ONLY; the helpers by nobody.
--      Safe: exactly the booleans in the comments.
SELECT f.fn,
       has_function_privilege('anon', f.sig, 'EXECUTE') AS anon_can,
       has_function_privilege('authenticated', f.sig, 'EXECUTE') AS authenticated_can,
       has_function_privilege('service_role', f.sig, 'EXECUTE') AS service_role_can
FROM (VALUES
  ('decide_question', 'public.decide_question(uuid,uuid,jsonb,jsonb)'),        -- f, t, t
  ('mark_booked', 'public.mark_booked(uuid,jsonb)'),                            -- f, t, t
  ('unmark_booked', 'public.unmark_booked(uuid,boolean,boolean)'),              -- f, t, t
  ('auto_decide_question', 'public.auto_decide_question(uuid)'),                -- f, f, t
  ('question_vote_tally', 'public.question_vote_tally(uuid,boolean)'),          -- f, f, t (service role keeps its default grant; harmless)
  ('assert_can_manage_trip', 'public.assert_can_manage_trip(uuid,uuid)')        -- f, f, t (service role keeps its default grant; harmless)
) AS f(fn, sig);
-- Also confirm owner / security mode / pinned search_path:
SELECT p.proname, p.prosecdef, p.proconfig, p.proowner::regrole FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('decide_question', 'auto_decide_question', 'mark_booked', 'unmark_booked', 'question_vote_tally', 'assert_can_manage_trip');
-- LAST STEP after applying BOTH migrations (14 and 15): make PostgREST see the new signatures. Without it a
-- signature mismatch is reported as PGRST202 and the app silently uses its slower non-atomic fallback:
NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- 15. 20261118100000_settlement_freeze.sql  (freeze_settlements, unfreeze_settlements,
--     remove_duplicate_settlement, settlement_assert_can_manage)
-- All read-only.
-- ============================================================================

-- 15a. Function names are free. Expect: 0 rows.
--      Gates: any row (an existing function would be replaced by CREATE OR REPLACE).
SELECT p.oid::regprocedure AS existing
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('freeze_settlements', 'unfreeze_settlements', 'remove_duplicate_settlement', 'settlement_assert_can_manage');

-- 15b. settlements columns the functions read/write. Expect: id uuid, trip_id uuid, from_user_id uuid,
--      to_user_id uuid, amount numeric, settled_at timestamptz NOT NULL, created_at timestamptz,
--      created_by uuid NOT NULL, status text NOT NULL, currency text NULLABLE (no other NOT NULL column without a default).
--      Gates: a missing column, or an extra NOT NULL column without a default (the insert would fail).
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'settlements'
ORDER BY ordinal_position;

-- 15c. Status values in use and the status CHECK. Expect: only suggested / marked_paid / confirmed and a
--      CHECK (status IN ('suggested','marked_paid','confirmed')). (This is the settlements status CHECK.)
--      Gates: any other status value, or no CHECK (the functions only ever write 'suggested').
SELECT status, count(*) FROM public.settlements GROUP BY 1 ORDER BY 1;
SELECT conname, pg_get_constraintdef(oid) AS def
FROM pg_constraint WHERE conrelid = 'public.settlements'::regclass AND contype = 'c';

-- 15d. Triggers on settlements, settlement_carryovers, trips and activity_feed. Expect on settlements:
--      trigger_guard_immutable_keys + trigger_guard_settlement_party_update, both BEFORE UPDATE only
--      (the new functions only INSERT/DELETE settlements, so neither fires). trips: set_updated_at and
--      trigger_guard_immutable_keys (BEFORE UPDATE; the functions update only the three snapshot columns).
--      Gates: an INSERT or DELETE trigger on settlements, or a trips trigger that touches settlement_snapshot*.
SELECT c.relname AS table_name, t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) AS def
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
WHERE NOT t.tgisinternal
  AND c.oid IN ('public.settlements'::regclass, 'public.settlement_carryovers'::regclass,
                'public.trips'::regclass, 'public.activity_feed'::regclass)
ORDER BY 1, 2;

-- 15e. Policies on settlements and settlement_carryovers. Expect settlements: UPDATE (creator<24h / organizer /
--      payer / payee), DELETE ("Creator, organizer or admin can delete settlement": organizer only for
--      'suggested'), INSERT (participant + created_by = uid), SELECT; carryovers: INSERT by organizer.
--      The new RPCs bypass these on purpose (SECURITY DEFINER) after their own manager check.
--      Safe: matches the description.
SELECT tablename, policyname, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename IN ('settlements', 'settlement_carryovers')
ORDER BY 1, 3, 2;

-- 15f. Shape of trips.settlement_snapshot where one exists. Expect: object with keys balances, created_at,
--      transactions; transactions is an array of {from,to,fromName,toName,amount,settled}.
--      Safe: key lists as expected (older rows may lack some keys; the RPC does not read them back).
SELECT id, name, jsonb_typeof(settlement_snapshot) AS snapshot_type,
       (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(settlement_snapshot) = 'object' THEN settlement_snapshot ELSE '{}'::jsonb END) k) AS keys,
       jsonb_typeof(settlement_snapshot -> 'transactions') AS transactions_type,
       settlement_snapshot_at, settlement_snapshot_by
FROM public.trips WHERE settlement_snapshot IS NOT NULL;

-- 15g. activity_feed accepts the new verbs: no CHECK constraint on verb. Expect: 0 rows.
--      Gates: any CHECK listing verbs that lacks settlement_duplicate_removed / froze_settlement / unfroze_settlement.
SELECT conname, pg_get_constraintdef(oid) AS def
FROM pg_constraint WHERE conrelid = 'public.activity_feed'::regclass AND contype = 'c';

-- 15h. Existing duplicate groups (non-suggested rows with the same trip, from, to, amount and currency).
--      Expect ONLY the 4 Sailing Sicily pairs (marked_paid + marked_paid, created ~10h apart). While an
--      unresolved group exists the app disables Freeze and freeze_settlements() raises. Clear them with
--      Remove duplicate (rows must be created within 24 hours of each other) BEFORE anyone refreezes.
SELECT trip_id, from_user_id, to_user_id, amount, COALESCE(currency, '(base)') AS currency,
       count(*) AS rows, array_agg(status || ' @ ' || created_at ORDER BY created_at) AS statuses,
       max(created_at) - min(created_at) AS spread
FROM public.settlements WHERE status <> 'suggested'
GROUP BY 1, 2, 3, 4, 5 HAVING count(*) > 1;

-- 15h2. Pairs with BOTH a marked_paid row and a suggested row (a partly paid debt). The old server rule skipped
--      the remaining suggestion; the new rule keeps it. Informational.
SELECT s.trip_id, s.from_user_id, s.to_user_id, array_agg(s.status || ':' || s.amount ORDER BY s.status) AS rows
FROM public.settlements s WHERE s.status IN ('marked_paid', 'suggested')
GROUP BY 1, 2, 3 HAVING count(DISTINCT s.status) = 2;

-- 15h3. Can the duplicate-removal audit row (settlement_duplicate_removed, stores the whole deleted row) be
--       deleted by participants? See the activity_feed policies in 14f6.

-- 15i. AFTER applying: privileges (anon / authenticated; service_role keeps its default grant). Expect: the three
--      RPCs anon=f, authenticated=t; the helper anon=f, authenticated=f. Then run NOTIFY pgrst, 'reload schema'
--      (see the end of 14g) so PostgREST sees the 4-argument freeze_settlements.
SELECT f.fn,
       has_function_privilege('anon', f.sig, 'EXECUTE') AS anon_can,
       has_function_privilege('authenticated', f.sig, 'EXECUTE') AS authenticated_can
FROM (VALUES
  ('freeze_settlements', 'public.freeze_settlements(uuid,jsonb,jsonb,uuid[])'),
  ('unfreeze_settlements', 'public.unfreeze_settlements(uuid)'),
  ('remove_duplicate_settlement', 'public.remove_duplicate_settlement(uuid)'),
  ('settlement_assert_can_manage', 'public.settlement_assert_can_manage(uuid,uuid)')
) AS f(fn, sig);
SELECT p.proname, has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_can, p.prosecdef, p.proconfig
FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('freeze_settlements', 'unfreeze_settlements', 'remove_duplicate_settlement', 'settlement_assert_can_manage');
NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- 16. 20261119090000_suggest_option.sql  (suggest_option, withdraw_suggestion)
--     All read-only. Additive migration: two functions, no table/policy/trigger change.
-- ============================================================================

-- 16a. Name clash: neither function exists yet. Safe: zero rows.
--      Gates: a clash (CREATE OR REPLACE would replace an unrelated function).
SELECT proname, oidvectortypes(proargtypes) AS args FROM pg_proc
WHERE pronamespace = 'public'::regnamespace AND proname IN ('suggest_option', 'withdraw_suggestion');

-- 16b. Columns the functions read/write, and their defaults.
--      Safe: options.status default 'available', locked default false, price_type default per_person_fixed,
--      metadata default '{}' (currency default 'EUR' is overridden with NULL on purpose);
--      planning_sections has all 12 insert columns; trips.status exists.
--      Gates: a missing column or a changed default (the "safe defaults" promise).
SELECT table_name, column_name, data_type, column_default, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND (
  (table_name = 'options' AND column_name IN ('section_id', 'title', 'description', 'price', 'currency', 'order_index', 'metadata', 'status', 'locked', 'price_type'))
  OR (table_name = 'planning_sections' AND column_name IN ('trip_id', 'title', 'description', 'metadata', 'section_type', 'status', 'allow_multiple_selections', 'order_index', 'voting_method', 'hide_votes_until_close', 'vote_deadline', 'quorum', 'created_at'))
  OR (table_name = 'trip_participants' AND column_name IN ('trip_id', 'user_id', 'active', 'confirmation_status'))
  OR (table_name = 'trips' AND column_name = 'status')
  OR (table_name = 'activity_feed' AND column_name IN ('trip_id', 'actor', 'verb', 'entity', 'metadata'))
)
ORDER BY table_name, column_name;

-- 16c. Triggers on options (expect only set_updated_at BEFORE UPDATE) and any INSERT/DELETE guard.
--      Gates: an INSERT or DELETE trigger on options that would reject a definer-inserted/deleted row.
SELECT tgname, pg_get_triggerdef(oid) AS def FROM pg_trigger
WHERE tgrelid = 'public.options'::regclass AND NOT tgisinternal;

-- 16d. Policies on options today (expect the organizer create/update/delete policy + the view policy).
--      Informational: the migration adds NO policy, so participants still cannot write options directly.
SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = 'options';

-- 16e. The function owner bypasses RLS (the definer functions insert into options / activity_feed / planning_sections).
--      Expect: rolbypassrls = true (or rolsuper) for the owner of an existing definer RPC.
SELECT p.proname, r.rolname AS owner, r.rolbypassrls, r.rolsuper
FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('decide_question', 'delete_question');

-- 16f. Existing Ideas buckets: at most one OPEN bucket per trip (the RPC reuses the oldest open one).
--      Safe: zero rows. Informational otherwise (extra open buckets are left alone).
SELECT trip_id, count(*) AS open_buckets FROM public.planning_sections
WHERE jsonb_typeof(metadata) = 'object' AND metadata -> 'ideas_bucket' = 'true'::jsonb AND status <> 'completed'
GROUP BY 1 HAVING count(*) > 1;

-- 16g. Existing options that already carry metadata.suggested_by (should be none; the limits count this key).
SELECT count(*) AS options_with_suggested_by FROM public.options WHERE jsonb_typeof(metadata) = 'object' AND metadata ? 'suggested_by';

-- 16h. Trips whose status label for "finished" is 'trip_completed' (the RPC's finished test).
SELECT e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid WHERE t.typname = 'trip_status' ORDER BY e.enumsortorder;

-- 16i. AFTER applying: privileges. Expect anon=f, authenticated=t for both. Then NOTIFY pgrst, 'reload schema'.
SELECT f.fn,
       has_function_privilege('anon', f.sig, 'EXECUTE') AS anon_can,
       has_function_privilege('authenticated', f.sig, 'EXECUTE') AS authenticated_can
FROM (VALUES
  ('suggest_option', 'public.suggest_option(uuid,text,text,text,boolean,uuid)'),
  ('withdraw_suggestion', 'public.withdraw_suggestion(uuid)')
) AS f(fn, sig);

-- 17. 20261119090000_suggest_option.sql: extra read-only checks from the phase 5 review
--     (run alongside group 16; 16e needs 20261118 applied because it looks up decide_question).

-- 17a. No INSERT/DELETE triggers on the tables the RPCs write.
--      Gates: any row other than set_updated_at-style BEFORE UPDATE triggers.
SELECT c.relname, t.tgname, pg_get_triggerdef(t.oid) AS def
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
WHERE NOT t.tgisinternal AND c.relname IN ('options', 'planning_sections', 'activity_feed') AND c.relnamespace = 'public'::regnamespace;

-- 17b. CHECK constraints the inserts must satisfy.
--      Safe: title <= 200, description <= 10000, currency <= 10 on options; title <= 200 on sections; none on activity_feed.
SELECT conrelid::regclass AS tbl, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
WHERE contype = 'c' AND conrelid IN ('public.options'::regclass, 'public.planning_sections'::regclass, 'public.activity_feed'::regclass);

-- 17c. What deleting an option cascades to / nulls (withdraw_suggestion).
--      Informational: confdeltype 'c' = CASCADE (comments, reactions), 'n' = SET NULL (bookings, expenses, timeline events).
SELECT conrelid::regclass AS tbl, conname, confdeltype FROM pg_constraint WHERE contype = 'f' AND confrelid = 'public.options'::regclass;

-- 17d. Enum labels the functions use.
--      Safe: option_status has available; section_status has completed; section_type has activities;
--      confirmation_status has declined and cancelled.
SELECT t.typname, e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
WHERE t.typname IN ('option_status', 'section_status', 'section_type', 'confirmation_status', 'price_type') ORDER BY 1, e.enumsortorder;

-- 17e. Default privileges that would re-grant to anon on CREATE (informational; the migration's REVOKE handles it).
SELECT defaclrole::regrole AS role, defaclobjtype, defaclacl FROM pg_default_acl WHERE defaclnamespace = 'public'::regnamespace;

-- 17f. Options already linked to bookings/expenses/timeline events while still 'available'
--      (the scope of the option_in_use guard in withdraw_suggestion). Informational; those links would otherwise be nulled.
SELECT count(*) AS linked_available_options FROM public.options o WHERE o.status = 'available' AND (
  EXISTS (SELECT 1 FROM public.bookings b WHERE b.option_id = o.id)
  OR EXISTS (SELECT 1 FROM public.expenses e WHERE e.option_id = o.id)
  OR EXISTS (SELECT 1 FROM public.trip_timeline_events t WHERE t.source_option_id = o.id));

-- 17g. Existing live options in a question whose titles collide case-insensitively
--      (the duplicate rule would refuse a new one with that title). Informational.
SELECT section_id, lower(btrim(title)) AS title_key, count(*) FROM public.options WHERE status <> 'cancelled' GROUP BY 1, 2 HAVING count(*) > 1;

-- 18. 20261120090000_payment_confirm_tokens.sql (confirm a payment from the email button). All read-only.

-- 18a. Names are free: none of these objects may exist yet (re-running the migration is fine, but a
--      same-named table or function from something else is not).
--      Safe: zero rows.
SELECT 'table' AS kind, c.relname AS name FROM pg_class c
WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('payment_confirm_tokens', 'payment_confirm_rate_limits')
UNION ALL
SELECT 'function', p.proname FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('issue_payment_confirm_token', 'confirm_payment_by_token', 'dispute_payment_by_token',
                    'payment_confirm_rate_hit', '_payment_token_check', '_payment_token_summary', '_payment_token_name');

-- 18b. Columns and types the functions assume on settlements, notifications, activity_feed and users.
--      Safe: settlements has id uuid, trip_id uuid, from_user_id uuid, to_user_id uuid, amount numeric,
--      currency text (nullable), status text; activity_feed has trip_id uuid, actor uuid, verb text,
--      entity jsonb, metadata jsonb; users has id uuid, first_name text, full_name text,
--      email_notifications_enabled boolean; notifications has trip_id uuid, user_id uuid, kind text,
--      entity_type text, entity_id uuid, channel text, dedupe_key text (the edge function writes
--      'notice:paid:<settlement>:<receiver>:1' and 'notice:confirmed:<settlement>:<payer>:1').
SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
WHERE table_schema = 'public'
  AND ((table_name = 'settlements' AND column_name IN ('id', 'trip_id', 'from_user_id', 'to_user_id', 'amount', 'currency', 'status'))
    OR (table_name = 'activity_feed' AND column_name IN ('trip_id', 'actor', 'verb', 'entity', 'metadata'))
    OR (table_name = 'users' AND column_name IN ('id', 'first_name', 'full_name', 'email_notifications_enabled'))
    OR (table_name = 'trips' AND column_name = 'base_currency')
    OR (table_name = 'notifications' AND column_name IN ('trip_id', 'user_id', 'kind', 'entity_type', 'entity_id', 'channel', 'dedupe_key')))
ORDER BY table_name, column_name;

-- 18c. Triggers and policies on settlements (the migration changes neither).
--      Safe: triggers trigger_guard_immutable_keys and trigger_guard_settlement_party_update (BEFORE UPDATE);
--      the UPDATE policy admits creator <24h / is_trip_organizer / from / to.
SELECT t.tgname, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t
WHERE NOT t.tgisinternal AND t.tgrelid = 'public.settlements'::regclass;
SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = 'settlements';

-- 18d. The guard still has the NULL-uid behaviour the token flow relies on (it sets auth.uid() to the receiver
--      for its single UPDATE). Safe: has_party_branches = true (it distinguishes payer and payee by auth.uid()
--      and ends with the fail-closed "Not permitted" exception, so a plain service-role update with a NULL uid is refused).
SELECT p.prosecdef AS security_definer,
       pg_get_functiondef(p.oid) LIKE '%auth.uid() = OLD.to_user_id%' AS has_party_branches,
       pg_get_functiondef(p.oid) LIKE '%Not permitted to update this settlement%' AS fails_closed_for_null_uid
FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'guard_settlement_party_update';

-- 18e. auth.uid() reads request.jwt.claim.sub or request.jwt.claims->>'sub' (the migration sets both for the receiver).
--      Safe: the body mentions request.jwt.claim.sub or request.jwt.claims; auth.role() the same for 'role'.
SELECT p.proname, pg_get_functiondef(p.oid) AS def FROM pg_proc p
WHERE p.pronamespace = 'auth'::regnamespace AND p.proname IN ('uid', 'role');

-- 18f. notifications accepts the new kind/dedupe key format: no CHECK on kind or dedupe_key, and dedupe_key is UNIQUE.
--      Safe: no CHECK constraint mentions kind/channel/dedupe_key; one unique constraint/index on dedupe_key.
SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'public.notifications'::regclass;
SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'notifications';
-- How the existing keys look (the new kinds are payment_paid_notice and payment_confirmed_notice).
SELECT kind, count(*) FROM public.notifications GROUP BY 1 ORDER BY 2 DESC;

-- 18g. activity_feed has no verb CHECK (the migration writes settlement_confirmed_by_email and
--      settlement_receipt_disputed). Safe: zero rows.
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.activity_feed'::regclass AND contype = 'c';

-- 18h. Payments the new flow will touch: current marked_paid rows, and any with a null currency
--      (the token captures trips.base_currency in that case). Informational.
SELECT count(*) FILTER (WHERE status = 'marked_paid') AS marked_paid,
       count(*) FILTER (WHERE status = 'marked_paid' AND currency IS NULL) AS marked_paid_null_currency
FROM public.settlements;

-- 18i. After applying: the functions are service-role only. Safe: anon_exec and authenticated_exec are false, service_exec true,
--      and the tables show relrowsecurity = true with zero policies.
SELECT f.sig, has_function_privilege('anon', f.sig, 'EXECUTE') AS anon_exec,
       has_function_privilege('authenticated', f.sig, 'EXECUTE') AS authenticated_exec,
       has_function_privilege('service_role', f.sig, 'EXECUTE') AS service_exec
FROM (VALUES ('public.issue_payment_confirm_token(uuid,text)'), ('public.confirm_payment_by_token(text)'),
             ('public.dispute_payment_by_token(text)'), ('public.payment_confirm_rate_hit(text,integer,integer)')) AS f(sig);
SELECT c.relname, c.relrowsecurity, (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.relname AND p.schemaname = 'public') AS policies
FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('payment_confirm_tokens', 'payment_confirm_rate_limits');

-- =====================================================================================
-- 19. Migration 20261120100000_settlement_insert_guard.sql (the settlements INSERT hole).
--     Apply it ONLY if 19a/19b show the hole. All read-only.
-- =====================================================================================

-- 19a. The exact INSERT / UPDATE / DELETE policies on settlements.
--      Hole confirmed if: the INSERT with_check is only "participant AND created_by = auth.uid()"
--      (no mention of status or from_user_id). Expected UPDATE: creator <24h / organizer / from / to;
--      DELETE: creator <24h / organizer + suggested / admin.
SELECT policyname, cmd, roles, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = 'settlements' ORDER BY cmd, policyname;

-- 19b. status default and constraint. Hole confirmed if the default is 'confirmed'::text.
SELECT column_name, column_default, is_nullable FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'settlements' AND column_name IN ('status', 'created_by', 'currency');
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.settlements'::regclass AND contype = 'c';

-- 19c. Existing triggers. Safe: exactly trigger_guard_immutable_keys and trigger_guard_settlement_party_update
--      (both BEFORE UPDATE), nothing on INSERT. The migration adds trigger_guard_settlement_insert (BEFORE INSERT)
--      and trigger_supersede_payment_tokens (AFTER UPDATE, from the tokens migration).
SELECT t.tgname, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t
WHERE NOT t.tgisinternal AND t.tgrelid = 'public.settlements'::regclass;

-- 19d. The live UPDATE guard is the body the migration re-declares (it has the created_by lock) and is
--      currently NOT security definer. Safe: has_created_by_lock = true.
SELECT p.prosecdef AS security_definer, p.proconfig,
       pg_get_functiondef(p.oid) LIKE '%May not change who created this settlement%' AS has_created_by_lock,
       pg_get_functiondef(p.oid) LIKE '%interval ''24 hours''%' AS has_creator_24h_branch
FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'guard_settlement_party_update';

-- 19e. Name clashes with objects ONLY the 100000 migration creates (supersede_payment_tokens_on_status_change
--      belongs to group 18's migration and exists by then). Safe: zero rows.
SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace
  AND proname IN ('guard_settlement_insert', '_settlement_can_manage');
SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.settlements'::regclass AND tgname = 'trigger_guard_settlement_insert';

-- 19h. Existing NaN / Infinity amounts would slip past a plain amount > 0 test. Safe: 0.
SELECT count(*) FROM settlements WHERE amount = 'NaN' OR amount = 'Infinity';

-- 19i. Owners of the SECURITY DEFINER functions must bypass RLS. Safe: postgres / true on both rows.
SELECT p.proname, pg_get_userbyid(p.proowner), r.rolbypassrls FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
WHERE p.proname IN ('guard_settlement_party_update','is_trip_organizer');

-- 19j. RLS is on for settlements. Safe: true.
SELECT relrowsecurity FROM pg_class WHERE oid = 'public.settlements'::regclass;

-- 19f. INFORMATIONAL: existing rows the new rule would not have allowed an ordinary participant to create,
--      by trip. "Ordinary" = created_by cannot manage the trip (not an admin, an ACTIVE organizer, or the trip
--      creator; note this uses today's roles, not the roles at creation time). Status is the CURRENT status
--      (a legitimately suggested row may have moved on), so only not_payer / not_participants are violations
--      by themselves; confirmed_by_ordinary is the interesting one to eyeball. Expect all zero on a healthy db.
WITH s AS (
  SELECT s.*,
         (EXISTS (SELECT 1 FROM public.users u WHERE u.id = s.created_by AND u.role = 'admin')
          OR EXISTS (SELECT 1 FROM public.trip_participants o WHERE o.trip_id = s.trip_id AND o.user_id = s.created_by AND o.role = 'organizer' AND o.active)
          OR EXISTS (SELECT 1 FROM public.trips t WHERE t.id = s.trip_id AND t.created_by = s.created_by)) AS creator_can_manage
  FROM public.settlements s
)
SELECT trip_id,
       count(*) FILTER (WHERE NOT creator_can_manage) AS by_ordinary_creator,
       count(*) FILTER (WHERE NOT creator_can_manage AND from_user_id <> created_by) AS not_payer,
       count(*) FILTER (WHERE NOT creator_can_manage AND status = 'confirmed') AS confirmed_by_ordinary,
       count(*) FILTER (WHERE NOT creator_can_manage AND (
         NOT EXISTS (SELECT 1 FROM public.trip_participants p WHERE p.trip_id = s.trip_id AND p.user_id = s.from_user_id)
         OR NOT EXISTS (SELECT 1 FROM public.trip_participants p WHERE p.trip_id = s.trip_id AND p.user_id = s.to_user_id))) AS not_participants,
       count(*) FILTER (WHERE amount <= 0 OR from_user_id = to_user_id) AS bad_amount_or_same_person
FROM s
GROUP BY trip_id
HAVING count(*) FILTER (WHERE NOT creator_can_manage) > 0 OR count(*) FILTER (WHERE amount <= 0 OR from_user_id = to_user_id) > 0
ORDER BY 2 DESC;

-- 19g. After applying: the helpers and trigger functions are not callable by clients. Safe: all false.
SELECT f, has_function_privilege('anon', f, 'EXECUTE') AS anon_exec, has_function_privilege('authenticated', f, 'EXECUTE') AS authenticated_exec
FROM unnest(array['public.guard_settlement_insert()', 'public._settlement_can_manage(uuid,uuid)',
                  'public.supersede_payment_tokens_on_status_change()']) f;

-- 19k. AFTER BOTH migrations (090000 then 100000): exactly these four non-internal triggers on settlements:
--      trigger_guard_immutable_keys (BEFORE UPDATE), trigger_guard_settlement_party_update (BEFORE UPDATE),
--      trigger_guard_settlement_insert (BEFORE INSERT), trigger_supersede_payment_tokens (AFTER UPDATE OF status).
--      Safe: count = 4 and those four names.
SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = 'public.settlements'::regclass;
SELECT t.tgname, pg_get_triggerdef(t.oid) FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid = 'public.settlements'::regclass ORDER BY 1;

-- 19l. AFTER 100000: the update guard is SECURITY DEFINER with a pinned search_path. Safe: true, {search_path=public, pg_temp}.
SELECT prosecdef, proconfig FROM pg_proc WHERE proname = 'guard_settlement_party_update';

-- 19m. AFTER 100000: settlements.status defaults to 'suggested'. Safe: 'suggested'::text.
SELECT column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'settlements' AND column_name = 'status';

-- 19n. AFTER BOTH: clients cannot execute the trigger/helper functions, and the four token RPCs are service_role only.
--      Safe: anon_exec and authenticated_exec false on every row; service_exec true on the four RPCs.
SELECT f, has_function_privilege('anon', f, 'EXECUTE') AS anon_exec, has_function_privilege('authenticated', f, 'EXECUTE') AS authenticated_exec,
       has_function_privilege('service_role', f, 'EXECUTE') AS service_exec
FROM unnest(array[
  'public.guard_settlement_party_update()', 'public.guard_settlement_insert()', 'public._settlement_can_manage(uuid,uuid)',
  'public.supersede_payment_tokens_on_status_change()', 'public._payment_token_name(uuid)', 'public._payment_token_check(text)',
  'public._payment_token_summary(public.payment_confirm_tokens,public.settlements,text)',
  'public.issue_payment_confirm_token(uuid,text)', 'public.confirm_payment_by_token(text)',
  'public.dispute_payment_by_token(text)', 'public.payment_confirm_rate_hit(text,integer,integer)']) f;

-- =====================================================================================
-- 20. Migration 20261121090000_payment_receipt_dispute.sql ("I haven't received it" becomes a state).
--     Run AFTER 20261120090000 and 20261120100000 are applied. All read-only.
-- =====================================================================================

-- 20a. The column name is free. Safe: zero rows (if one row, the migration's ADD COLUMN IF NOT EXISTS is a no-op;
--      check its type is timestamptz).
SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'settlements' AND column_name IN ('receipt_disputed_at', 'last_retracted_at');
-- The two new function names are free (clear_receipt_dispute and restore_receipt_dispute). Safe: zero rows.
SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('clear_receipt_dispute', 'restore_receipt_dispute');
SELECT conname FROM pg_constraint WHERE conrelid = 'public.settlements'::regclass AND conname = 'settlements_receipt_disputed_only_when_marked_paid';

-- 20b. The live guard is exactly the body shipped in 20261120100000 (so CREATE OR REPLACE changes nothing we do not know of).
--      md5 of the function source (the text between the $$ markers). Safe: b3df6de584d7bb77eb2e04a3fda1ff22
--      (the value recorded live after applying 20261120100000). Anything else: someone edited it by hand; diff before applying.
SELECT md5(prosrc) AS guard_md5, md5(prosrc) = 'b3df6de584d7bb77eb2e04a3fda1ff22' AS matches_shipped, prosecdef, proconfig
FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'guard_settlement_party_update';

-- 20c. Exactly the four expected triggers on settlements (the migration adds none).
--      Safe: count = 4; trigger_guard_immutable_keys, trigger_guard_settlement_insert,
--      trigger_guard_settlement_party_update, trigger_supersede_payment_tokens.
SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = 'public.settlements'::regclass;
SELECT t.tgname, pg_get_triggerdef(t.oid) FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid = 'public.settlements'::regclass ORDER BY 1;

-- 20d. Nothing else depends on the guard function (replacing it must not surprise anything).
--      Safe: only the trigger trigger_guard_settlement_party_update, and no other function whose body mentions it.
SELECT t.tgname, t.tgrelid::regclass FROM pg_trigger t WHERE t.tgfoid = 'public.guard_settlement_party_update()'::regprocedure;
SELECT p.proname FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname <> 'guard_settlement_party_update' AND p.prosrc LIKE '%guard_settlement_party_update%';
SELECT d.classid::regclass, d.objid, d.deptype FROM pg_depend d
WHERE d.refobjid = 'public.guard_settlement_party_update()'::regprocedure AND d.deptype = 'n';

-- 20e. Nothing else in the database writes settlements.status or the new column behind the guard's back
--      (views / rules on settlements). Safe: zero rows.
SELECT r.rulename FROM pg_rewrite r WHERE r.ev_class = 'public.settlements'::regclass AND r.rulename <> '_RETURN';

-- 20f. The CHECK cannot fail on existing data (the column is new, so every row is NULL). Safe: 0 after applying.
SELECT count(*) FROM public.settlements WHERE receipt_disputed_at IS NOT NULL AND status <> 'marked_paid';

-- 20g. AFTER applying: the guard and the three RPCs are service_role only / not callable by clients.
--      Safe: anon_exec and authenticated_exec false everywhere; service_exec true for the three RPCs.
SELECT f, has_function_privilege('anon', f, 'EXECUTE') AS anon_exec, has_function_privilege('authenticated', f, 'EXECUTE') AS authenticated_exec,
       has_function_privilege('service_role', f, 'EXECUTE') AS service_exec
FROM unnest(array['public.guard_settlement_party_update()', 'public.dispute_payment_by_token(text)',
                  'public.clear_receipt_dispute(uuid,text)', 'public.restore_receipt_dispute(uuid)']) f;

-- 20h. AFTER applying: the guard is still SECURITY DEFINER with the pinned search_path. Safe: true, {search_path=public, pg_temp}.
SELECT prosecdef, proconfig FROM pg_proc WHERE proname = 'guard_settlement_party_update';

-- 20i. The live dispute_payment_by_token is exactly the body shipped in 20261120090000 (the migration replaces it).
--      The expected md5 was computed by applying that file to a scratch Postgres (prosrc is stored verbatim).
--      Safe: matches_shipped = true (md5 37c9f162e90e3905bc44b819d290350a, length 1691). If not, diff before applying.
SELECT md5(prosrc) AS body_md5, length(prosrc) AS body_len, md5(prosrc) = '37c9f162e90e3905bc44b819d290350a' AS matches_shipped,
       prosrc LIKE '%settlement_receipt_disputed%' AS has_activity_insert, prosrc LIKE '%set_config(''request.jwt.claim.sub''%' AS impersonates
FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'dispute_payment_by_token';

-- 20j. The full settlements column list: no updated_at, no generated or identity columns (the guard compares whole rows with
--      to_jsonb(NEW) - to_jsonb(OLD); a trigger-maintained timestamp would make every payer/receiver update fail closed).
--      Safe: no updated_at; is_generated = 'NEVER' everywhere; the new columns are absent BEFORE applying.
SELECT column_name, data_type, is_nullable, column_default, is_generated, is_identity
FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'settlements' ORDER BY ordinal_position;

-- 20k. What is in the table now. Safe: mostly confirmed; marked_paid about 0-1 (a test row). Each marked_paid row is a live link in flight.
SELECT status, count(*) FROM public.settlements GROUP BY 1 ORDER BY 1;
SELECT count(*) AS unused_tokens FROM public.payment_confirm_tokens WHERE used_at IS NULL;

-- 20l. The new column is covered by the existing grant: authenticated has TABLE-level UPDATE on settlements (so the guard, not a
--      column grant, is what stops a client writing last_retracted_at / receipt_disputed_at). Safe: table_update = true.
SELECT has_table_privilege('authenticated', 'public.settlements', 'UPDATE') AS table_update,
       (SELECT count(*) FROM information_schema.column_privileges WHERE table_schema = 'public' AND table_name = 'settlements'
          AND grantee = 'authenticated' AND privilege_type = 'UPDATE') AS column_update_grants;

-- 20m. Informational: does is_trip_organizer() require an ACTIVE roster row? (decides whether an organizer who left is still
--      "privileged" in the guard). The migration does not change this.
SELECT pg_get_functiondef('public.is_trip_organizer(uuid,uuid)'::regprocedure) ~ 'active' AS checks_active;

-- 20n. No long-running transaction touching settlements before the ALTER (the migration sets lock_timeout = 5s and would fail rather than queue).
--      Safe: no rows older than a few seconds.
SELECT pid, state, now() - xact_start AS xact_age, left(query, 120) AS query FROM pg_stat_activity
WHERE state <> 'idle' AND pid <> pg_backend_pid() AND query ILIKE '%settlements%';

-- 20o. Assumptions about activity_feed and notifications: clients can insert activity rows (the feed lines the functions use are
--      for display and caps only), and cannot insert notifications at all (the dedupe/cap rows are unforgeable).
--      Safe: notifications has SELECT policies only (no INSERT/UPDATE/DELETE policy); activity_feed insert policy requires actor = self.
SELECT tablename, policyname, cmd, roles, qual, with_check FROM pg_policies
WHERE schemaname = 'public' AND tablename IN ('activity_feed', 'notifications') ORDER BY tablename, cmd, policyname;

-- ---------------------------------------------------------------------------------------------------------------------
-- 20 POST-APPLY (run after the migration; compare with the pre-apply output)
-- ---------------------------------------------------------------------------------------------------------------------
-- 20p. Record the new guard md5 (put it in the deploy log), and confirm the shape. Safe: prosecdef true, search_path pinned.
SELECT md5(prosrc) AS new_guard_md5, length(prosrc) AS len, prosecdef, proconfig,
       prosrc LIKE '%last_retracted_at%' AS stamps_boundary, prosrc LIKE '%service_role%' AS payer_clear_is_server_only
FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'guard_settlement_party_update';
-- 20q. The constraint exists and is validated. Safe: convalidated = true.
SELECT conname, convalidated FROM pg_constraint WHERE conname = 'settlements_receipt_disputed_only_when_marked_paid';
-- 20r. Still exactly four non-internal triggers on settlements. Safe: 4.
SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = 'public.settlements'::regclass;
-- 20s. Both columns exist, nullable, timestamptz, no default. Safe: two rows.
SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'settlements' AND column_name IN ('receipt_disputed_at', 'last_retracted_at');
-- 20t. Privileges: run 20g again (anon/authenticated false, service_role true on the three RPCs), and
SELECT p.oid::regprocedure, p.prosecdef, p.proconfig FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('clear_receipt_dispute', 'restore_receipt_dispute', 'dispute_payment_by_token');
-- 20u. PostgREST has the new columns (the migration ends with NOTIFY pgrst, 'reload schema'). Safe: both columns visible to the API.
NOTIFY pgrst, 'reload schema';

-- =====================================================================================
-- 21. Migration 20261124090000_receipt_claims_v2.sql (who had what: set_receipt_claims, share_receipt_leftovers, freeze guard).
--     Run AFTER 20261118100000, 20261120100000 and 20261116130000 are applied. All read-only.
-- =====================================================================================

-- 21a. Names are free. Safe: zero rows from all three (if a column exists, the ADD COLUMN IF NOT EXISTS is a no-op: check its type).
SELECT table_name, column_name, data_type, column_default, is_nullable FROM information_schema.columns
WHERE table_schema = 'public' AND (
  (table_name = 'expense_item_claims' AND column_name IN ('source', 'created_by', 'leftover_quantity', 'leftover_amount'))
  OR (table_name = 'expense_line_items' AND column_name = 'shared_by_all'));
SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
  AND (p.proname IN ('set_receipt_claims', 'share_receipt_leftovers', '_trip_unclaimed_receipts', '_trip_overclaimed_receipts', 'refund_rate_limit',
                     'guard_claim_provenance', 'guard_claim_overclaim', 'guard_expense_leftover_mode') OR p.proname LIKE '\_receipt\_%');
SELECT conname FROM pg_constraint WHERE conname IN ('expense_item_claims_source_check', 'expense_item_claims_leftover_parts_check', 'expenses_leftover_mode_check');
-- Also free: the two expenses columns and the three new trigger names. Safe: zero rows.
SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'expenses' AND column_name IN ('leftover_mode', 'leftover_user_id');
SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('trg_guard_claim_provenance', 'trg_guard_claim_overclaim', 'trg_guard_expense_leftover_mode');

-- 21b. Columns the migration relies on, with types. Safe (live, 2026-11-17): expense_item_claims.quantity_claimed and amount_owed numeric(10,2)
--      (precision 10, scale 2, NOT NULL); expense_line_items.quantity numeric(10,2), total_amount numeric(10,2); expenses.amount numeric(10,2),
--      currency text NOT NULL, status expense_status (nullable, default 'confirmed'), ai_parsed boolean, participant_ids uuid[] (_uuid),
--      paid_by uuid NOT NULL, description text NOT NULL; trips.settlement_snapshot jsonb. The leftover parts are numeric(10,2) too, so a currency with
--      3 decimals cannot be split exactly: the RPCs refuse it (live receipts are GBP, USD, EUR, JPY, HKD).
SELECT table_name, column_name, data_type, udt_name, numeric_precision, numeric_scale, is_nullable
FROM information_schema.columns WHERE table_schema = 'public' AND (
  (table_name = 'expense_item_claims' AND column_name IN ('id', 'line_item_id', 'user_id', 'expense_id', 'quantity_claimed', 'amount_owed', 'confirmed', 'claimed_at', 'updated_at'))
  OR (table_name = 'expense_line_items' AND column_name IN ('id', 'expense_id', 'quantity', 'total_amount', 'line_number'))
  OR (table_name = 'expenses' AND column_name IN ('id', 'trip_id', 'paid_by', 'amount', 'currency', 'description', 'status', 'ai_parsed', 'participant_ids'))
  OR (table_name = 'trips' AND column_name = 'settlement_snapshot'))
ORDER BY table_name, column_name;

-- 21c. Constraints, indexes and triggers on the claims and line-item tables.
--      Safe (live, 2026-11-17): expense_item_claims has UNIQUE unique_user_claim_per_item (line_item_id, user_id) (the migration KEEPS it: one row per
--      line and person, leftovers are a part of that row), CHECK quantity_claimed > 0, CHECK amount_owed >= 0, FKs to expenses / expense_line_items
--      (CASCADE) and users; expense_line_items has CHECK quantity > 0 and total_amount >= 0 (no negative discount lines can exist).
SELECT conrelid::regclass AS tbl, conname, contype, pg_get_constraintdef(oid) AS def FROM pg_constraint
WHERE conrelid IN ('public.expense_item_claims'::regclass, 'public.expense_line_items'::regclass) ORDER BY 1, 2;
SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename IN ('expense_item_claims', 'expense_line_items') ORDER BY 1, 2;
-- ASSERTION: the assumptions the migration is written for. Safe: every column is true.
SELECT
  EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.expense_item_claims'::regclass AND conname = 'unique_user_claim_per_item' AND contype = 'u'
          AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.expense_item_claims'::regclass AND attname = 'line_item_id'),
                             (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.expense_item_claims'::regclass AND attname = 'user_id')]) AS claims_unique_line_user,
  EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.expense_item_claims'::regclass AND contype = 'c'
          AND pg_get_constraintdef(oid) ~ 'quantity_claimed > ') AS claims_quantity_positive_check,
  EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.expense_item_claims'::regclass AND contype = 'c'
          AND pg_get_constraintdef(oid) ~ 'amount_owed >= ') AS claims_amount_nonnegative_check,
  EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.expense_line_items'::regclass AND contype = 'c'
          AND pg_get_constraintdef(oid) ~ 'quantity > ') AS lines_quantity_positive_check,
  EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.expense_line_items'::regclass AND contype = 'c'
          AND pg_get_constraintdef(oid) ~ 'total_amount >= ') AS lines_total_nonnegative_check;
-- Column types the leftover parts must match. Safe: quantity_claimed and amount_owed both numeric(10,2) (numeric_precision 10, numeric_scale 2).
SELECT column_name, numeric_precision, numeric_scale FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'expense_item_claims' AND column_name IN ('quantity_claimed', 'amount_owed') ORDER BY 1;
-- Unique shape in one line. Safe: exactly ONE row, unique_user_claim_per_item.
SELECT i.indexrelid::regclass FROM pg_index i WHERE i.indrelid = 'public.expense_item_claims'::regclass AND i.indisunique AND NOT i.indisprimary;
-- Triggers. Safe (live): on expense_item_claims only trigger_auto_update_expense_status (AFTER INSERT OR UPDATE, FOR EACH ROW, calls
-- auto_update_expense_status()); on expenses set_updated_at and trigger_guard_immutable_keys (BEFORE UPDATE); on expense_line_items none.
SELECT tgrelid::regclass AS tbl, tgname, tgenabled, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t
WHERE NOT tgisinternal AND tgrelid IN ('public.expense_item_claims'::regclass, 'public.expense_line_items'::regclass, 'public.expenses'::regclass) ORDER BY 1, 2;
-- ASSERTION: the live status trigger is there as recorded, and its two functions are the ones that were inspected (the migration does NOT replace
-- them; their bodies could not be printed, so the md5 is the tripwire: if either differs, read the bodies before applying).
-- Safe: trigger_present true; auto_update_expense_status md5 bc28b37aaee626a396740a259df151bd len 460 (security definer);
-- check_all_items_claimed(uuid) md5 bf9e725353d764d312825d0adf1081b7 len 520.
SELECT EXISTS (SELECT 1 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid = 'public.expense_item_claims'::regclass
               AND t.tgname = 'trigger_auto_update_expense_status' AND pg_get_triggerdef(t.oid) ~ 'AFTER INSERT OR UPDATE ON') AS trigger_present,
       (SELECT md5(prosrc) = 'bc28b37aaee626a396740a259df151bd' AND length(prosrc) = 460 FROM pg_proc
         WHERE pronamespace = 'public'::regnamespace AND proname = 'auto_update_expense_status') AS auto_update_expense_status_unchanged,
       (SELECT md5(prosrc) = 'bf9e725353d764d312825d0adf1081b7' AND length(prosrc) = 520 FROM pg_proc
         WHERE pronamespace = 'public'::regnamespace AND proname = 'check_all_items_claimed') AS check_all_items_claimed_unchanged;

-- The foreign key the client now pins in its embeds (expense_item_claims_user_id_fkey). Safe: one row, FOREIGN KEY (user_id) REFERENCES users(id).
SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
WHERE conrelid = 'public.expense_item_claims'::regclass AND conname = 'expense_item_claims_user_id_fkey';
-- The live trigger function auto_update_expense_status: it is not defined in the repo. If your tool prints bodies, read it. It fires per row inside the
-- RPCs and compares quantities EXACTLY; the RPCs end with _receipt_refresh_status (tolerant 0.011), so the stored status after an RPC is the tolerant one.
-- After an OLD client's direct write it may set pending_allocation on a legacy-thirds receipt: cosmetic, nothing in the ledger reads expenses.status.
SELECT p.oid::regprocedure AS fn, p.prosecdef, pg_get_functiondef(p.oid) AS body
FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('auto_update_expense_status', 'check_all_items_claimed', 'guard_immutable_keys');
-- Which triggers call it (or the other two). Safe: read the list; nothing here is changed by the migration.
SELECT t.tgrelid::regclass AS tbl, t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) AS def
FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
WHERE NOT t.tgisinternal AND p.proname IN ('auto_update_expense_status', 'check_all_items_claimed', 'guard_immutable_keys');
-- rate_limits: the table refund_rate_limit updates. Safe: id uuid, user_id uuid, feature text, tokens numeric, last_refill timestamptz (unique user_id + feature).
SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'rate_limits' ORDER BY ordinal_position;

-- 21d. Policies on the claims and line-item tables (unchanged by this migration; the RPCs are SECURITY DEFINER and bypass them).
--      Safe: claims INSERT/UPDATE with uid = user_id, DELETE own or payer/admin, SELECT participants; line items INSERT participants,
--      DELETE payer/admin. Record the output; compare after applying (must be identical).
SELECT tablename, policyname, cmd, roles, qual, with_check FROM pg_policies
WHERE schemaname = 'public' AND tablename IN ('expense_item_claims', 'expense_line_items') ORDER BY tablename, cmd, policyname;

-- 21e. Helpers exist with the expected signatures and behaviour. Safe: _settlement_can_manage(uuid, uuid) -> boolean secdef;
--      currency_exponent: JPY 0, GBP 2, KWD 3, XYZ 2.
SELECT p.oid::regprocedure, p.prosecdef, p.proconfig FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('_settlement_can_manage', 'currency_exponent', 'settlement_assert_can_manage', 'is_admin', 'is_trip_organizer', 'is_trip_participant');
SELECT public.currency_exponent('JPY') AS jpy, public.currency_exponent('GBP') AS gbp, public.currency_exponent('KWD') AS kwd, public.currency_exponent('XYZ') AS other;
-- The expense_status enum values. Safe: unallocated, pending_allocation, allocated, confirmed (in that order); expenses.status is nullable, default 'confirmed'.
SELECT enumlabel FROM pg_enum WHERE enumtypid = 'public.expense_status'::regtype ORDER BY enumsortorder;
SELECT (SELECT array_agg(enumlabel::text ORDER BY enumsortorder) FROM pg_enum WHERE enumtypid = 'public.expense_status'::regtype)
         = ARRAY['unallocated', 'pending_allocation', 'allocated', 'confirmed'] AS enum_labels_as_assumed,
       (SELECT udt_name = 'expense_status' AND is_nullable = 'YES' AND column_default ~ 'confirmed' FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'expenses' AND column_name = 'status') AS status_column_as_assumed;
-- activity_feed has no verb CHECK. Safe: no CHECK constraints (only FKs).
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.activity_feed'::regclass AND contype = 'c';

-- 21f. freeze_settlements: the live function is exactly the body shipped in 20261118100000 (the only migration that defines it; the
--      p_known_paid_ids argument is part of that file). Expected values were computed by applying that file to a scratch Postgres and
--      hashing prosrc (the text between the $$ markers, UTF-8), and checked equal to the md5 of the file text itself.
--      Safe: matches_shipped = true (md5 e06a0e7d53c764d6ff435cbf19431505, length 6676). Anything else: someone edited it by hand;
--      diff before applying, because the migration CREATE OR REPLACEs it (the guard is the only intended difference).
SELECT md5(prosrc) AS body_md5, length(prosrc) AS body_len, md5(prosrc) = 'e06a0e7d53c764d6ff435cbf19431505' AS matches_shipped,
       prosecdef, proconfig, pg_get_function_identity_arguments(oid) AS args
FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'freeze_settlements';
-- If matches_shipped is false, these distinctive substrings still tell you whether the live body has the pieces the guard sits between.
SELECT prosrc LIKE '%settlement_assert_can_manage(p_trip_id, v_uid)%' AS has_permission_check,
       prosrc LIKE '%pg_advisory_xact_lock(hashtextextended(''settlement_freeze:'' || p_trip_id::text, 0))%' AS has_trip_lock,
       prosrc LIKE '%duplicate_payments%' AS has_duplicate_guard, prosrc LIKE '%stale%' AS has_stale_check,
       prosrc LIKE '%unclaimed_receipts%' AS already_has_receipt_guard
FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'freeze_settlements';
-- Only one overload. Safe: exactly one row, args = p_trip_id uuid, p_snapshot jsonb, p_suggestions jsonb, p_known_paid_ids uuid[].
SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'freeze_settlements';

-- 21g. DATA PREVIEW = SQL-1 (informational). Every itemised receipt the freeze guard would flag, AS THE FIRST DRAFT WROTE IT (raw remainders:
--      flagged_as_written_minor) and WITH THE RULE THE MIGRATION SHIPS (flagged_with_rule_minor, identical to _trip_unclaimed_receipts: dust
--      tolerance 0.011, netted per receipt, missing FX in the receipt's own currency). Own-currency minor units.
--      Safe: flagged_with_rule_minor = 0 for EVERY row on the real trips (Meribel, La Tania, JaPOW; legacy 0.33 x 26 / 0.3 x 30 rows are dust).
--      Test trips (test4, Test3) may show real value. Any non-zero flagged_with_rule_minor on a real trip is genuinely unclaimed money: look at it
--      before applying; the front end offers "Share leftovers" for it.
WITH e AS (
  SELECT e.trip_id, e.id, e.description, e.currency, e.amount, e.fx_rate, t.base_currency,
         power(10::numeric, public.currency_exponent(e.currency)) AS pw,
         CASE WHEN e.currency = t.base_currency OR e.fx_rate IS NULL THEN 1::numeric ELSE e.fx_rate END AS rate,
         power(10::numeric, public.currency_exponent(CASE WHEN e.currency = t.base_currency OR e.fx_rate IS NULL THEN e.currency ELSE t.base_currency END)) AS bpw,
         (e.currency = t.base_currency OR e.fx_rate IS NULL) AS same_unit
  FROM public.expenses e JOIN public.trips t ON t.id = e.trip_id
  WHERE coalesce(e.ai_parsed, false) AND e.status IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.expense_line_items li WHERE li.expense_id = e.id)),
l AS (
  SELECT e.id AS eid, li.quantity, round(li.total_amount * e.pw)::bigint AS tot,
         coalesce(sum(round(c.amount_owed * e.pw)), 0)::bigint AS cm,
         coalesce(sum(round(c.amount_owed * e.rate * e.bpw)), 0)::bigint AS cb,
         coalesce(sum(c.quantity_claimed), 0) AS cq, count(c.id) AS nrows
  FROM e JOIN public.expense_line_items li ON li.expense_id = e.id
  LEFT JOIN public.expense_item_claims c ON c.line_item_id = li.id
  GROUP BY e.id, li.id, li.quantity, li.total_amount, e.pw, e.rate, e.bpw),
r AS (
  SELECT eid,
         sum(greatest(0, tot - cm)) AS raw_minor,
         coalesce(sum(CASE WHEN tot - cm > 0 AND quantity > 0 AND (quantity - cq > 0.011
                   OR tot - cm > greatest(1, nrows) + ceil(abs(tot) * 0.011 / quantity)) THEN tot - cm ELSE 0 END), 0) AS real_minor,
         sum(cb) AS claimed_base,
         sum(cm) AS claimed_own,
         count(*) FILTER (WHERE tot - cm > 0) AS lines_short,
         count(*) FILTER (WHERE cm > tot) AS lines_over
  FROM l GROUP BY eid)
SELECT t.name AS trip, t.settlement_snapshot IS NOT NULL AS frozen, e.description, e.currency, e.fx_rate IS NULL AND e.currency <> e.base_currency AS missing_fx,
       r.raw_minor AS flagged_as_written_minor,
       (CASE WHEN least(CASE WHEN e.same_unit THEN r.real_minor
                             ELSE round(greatest(0, least(r.real_minor, round(e.amount * e.pw) - r.claimed_own)) / e.pw * e.rate * e.bpw) END,
                        round(e.amount * e.rate * e.bpw) - r.claimed_base) > 0 THEN r.real_minor ELSE 0 END) AS flagged_with_rule_minor,
       r.lines_short, r.lines_over
FROM e JOIN r ON r.eid = e.id JOIN public.trips t ON t.id = e.trip_id
WHERE r.raw_minor > 0 OR r.lines_over > 0
ORDER BY t.name, flagged_as_written_minor DESC;
-- Lines whose claims exceed the line value (over-claimed by rounding or by hand). Informational: counted as zero unclaimed, never negative.
SELECT e.description, l.line_number, l.total_amount, sum(c.amount_owed) AS claimed, sum(c.quantity_claimed) AS qty_claimed, l.quantity
FROM public.expense_line_items l JOIN public.expenses e ON e.id = l.expense_id
JOIN public.expense_item_claims c ON c.line_item_id = l.id
GROUP BY e.description, l.id, l.line_number, l.total_amount, l.quantity
HAVING sum(c.amount_owed) > l.total_amount OR sum(c.quantity_claimed) > l.quantity ORDER BY 1, 2;
-- Distinct quantity fractions in use (legacy shares). Informational: 0.5, 0.2, 0.1, 0.17, 0.25, 0.3, 0.33 expected; these rows are never
-- rewritten unless a manager reassigns that line.
SELECT quantity_claimed, count(*) FROM public.expense_item_claims WHERE quantity_claimed <> trunc(quantity_claimed) GROUP BY 1 ORDER BY 2 DESC;
-- Receipts where a person has more than one row on the same line (the unique key forbids it). Safe: zero rows.
SELECT line_item_id, user_id, count(*) FROM public.expense_item_claims GROUP BY 1, 2 HAVING count(*) > 1;
-- Who is "tagged" today: itemised receipts with participant_ids NULL/empty fall back to the trip's ACTIVE participants.
SELECT (participant_ids IS NULL OR cardinality(participant_ids) = 0) AS tagged_from_trip_roster, count(*) FROM public.expenses
WHERE coalesce(ai_parsed, false) AND status IS NOT NULL GROUP BY 1;

-- 21h. No long-running transaction touching the claims tables (the migration sets lock_timeout = 5s and fails rather than queueing).
SELECT pid, state, now() - xact_start AS xact_age, left(query, 120) AS query FROM pg_stat_activity
WHERE state <> 'idle' AND pid <> pg_backend_pid() AND (query ILIKE '%expense_item_claims%' OR query ILIKE '%expense_line_items%');

-- 21n. SQL-2: more than one claim row per (line, user) today (impossible under unique_user_claim_per_item). Safe: zero rows.
SELECT line_item_id, user_id, count(*) FROM public.expense_item_claims GROUP BY 1, 2 HAVING count(*) > 1;
-- 21o. SQL-3: zero lines. Safe (live): no negative total and no zero quantity (the CHECKs forbid both); ZERO-TOTAL lines exist (9 on 2026-11-17, 3 with
--      claims): they carry no money, are never counted unclaimed, and their quantity can still be claimed.
SELECT e.description, li.line_number, li.total_amount, li.quantity FROM public.expense_line_items li JOIN public.expenses e ON e.id = li.expense_id
WHERE li.total_amount <= 0 OR li.quantity <= 0;
-- 21p. SQL-4: who is on the trip but NOT in scope (the receipts have participant_ids NULL, so "tagged" = in-scope people: active, and with
--      confirmation tracking on not declined/cancelled and only the confirmed once anyone is). Informational: these people are NOT charged leftovers.
SELECT t.name, t.confirmation_enabled, tp.confirmation_status, tp.active, count(*) FROM public.trip_participants tp JOIN public.trips t ON t.id = tp.trip_id
WHERE NOT coalesce(tp.active, true) OR tp.confirmation_status::text IN ('declined', 'cancelled', 'waitlist', 'interested') GROUP BY 1, 2, 3, 4 ORDER BY 1;
-- 21q. SQL-5: triggers on the three tables and the status function: see the dump under 21c (pg_get_functiondef of auto_update_expense_status).
SELECT tgrelid::regclass, tgname, pg_get_triggerdef(oid) FROM pg_trigger
WHERE NOT tgisinternal AND tgrelid IN ('public.expense_item_claims'::regclass, 'public.expense_line_items'::regclass, 'public.expenses'::regclass);
-- 21r. SQL-6: the verbs this feature writes are unused so far. Safe: 0. (mode 'same' no longer reads activity_feed at all.)
SELECT count(*) FROM public.activity_feed WHERE verb IN ('receipt_leftovers_shared', 'receipt_claims_set');
-- 21s. Over-claimed lines the freeze guard would refuse with hint overclaimed_receipts (quantity AND money above the line by more than the dust allowance).
--      Safe: zero rows. A row here is a legacy over-claim: fix the claims (or Share leftovers again) before the first freeze.
SELECT e.description, li.line_number, li.quantity, sum(c.quantity_claimed) AS qty_claimed, li.total_amount, sum(c.amount_owed) AS owed
FROM public.expense_line_items li JOIN public.expenses e ON e.id = li.expense_id JOIN public.expense_item_claims c ON c.line_item_id = li.id
WHERE coalesce(e.ai_parsed, false) AND e.status IS NOT NULL
GROUP BY e.description, li.id, li.line_number, li.quantity, li.total_amount
HAVING sum(c.quantity_claimed) - li.quantity > 0.011 AND sum(round(c.amount_owed * power(10, 2))) - round(li.total_amount * 100) > 3 + ceil(abs(li.total_amount) * 100 * 0.011 / greatest(li.quantity, 0.01));
-- 21t. Existing guards on expenses and the claims table that the new triggers sit beside. Safe: guard_immutable_keys is BEFORE UPDATE (trip_id only);
--      the new triggers are separate and the definer RPCs are unaffected (current_user = function owner inside a SECURITY DEFINER function).
SELECT tgrelid::regclass, tgname, tgtype FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN ('public.expenses'::regclass, 'public.expense_item_claims'::regclass) ORDER BY 1, 2;

-- ---------------------------------------------------------------------------------------------------------------------
-- 21 POST-APPLY (run after the migration; compare with the pre-apply output)
-- ---------------------------------------------------------------------------------------------------------------------
-- 21i. Columns, defaults, constraints. Safe: source text NOT NULL default 'self'::text; created_by uuid nullable; leftover_quantity and leftover_amount
--      numeric(10,2) NOT NULL default 0; shared_by_all boolean NOT NULL default false; the source and leftover-parts CHECKs are validated; the live
--      unique key and CHECKs are still there.
SELECT table_name, column_name, data_type, numeric_precision, numeric_scale, column_default, is_nullable FROM information_schema.columns
WHERE table_schema = 'public' AND ((table_name = 'expense_item_claims' AND column_name IN ('source', 'created_by', 'leftover_quantity', 'leftover_amount')) OR (table_name = 'expense_line_items' AND column_name = 'shared_by_all'))
ORDER BY 1, 2;
SELECT conname, convalidated, pg_get_constraintdef(oid) FROM pg_constraint
WHERE conname IN ('expense_item_claims_source_check', 'expense_item_claims_leftover_parts_check', 'unique_user_claim_per_item');
SELECT source, count(*) FROM public.expense_item_claims GROUP BY 1;   -- Safe: every existing row is 'self'
SELECT count(*) AS rows_with_leftover_parts FROM public.expense_item_claims WHERE leftover_quantity <> 0 OR leftover_amount <> 0;   -- Safe: 0 until leftovers are shared
-- 21j. Privileges. Safe: the two RPCs and freeze_settlements: anon false, authenticated true; every _receipt_* / _trip_* helper: anon and authenticated false.
SELECT p.oid::regprocedure AS fn, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec,
       p.prosecdef, p.proconfig
FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
  AND (p.proname IN ('set_receipt_claims', 'share_receipt_leftovers', 'freeze_settlements', '_trip_unclaimed_receipts', '_trip_overclaimed_receipts', 'refund_rate_limit',
                     'guard_claim_provenance', 'guard_claim_overclaim', 'guard_expense_leftover_mode') OR p.proname LIKE '\_receipt\_%') ORDER BY 1;
-- Safe: refund_rate_limit: service_role true, authenticated false, anon false. The three guard_* trigger functions: false for anon, authenticated and service_role.
SELECT 'refund_rate_limit' AS fn, has_function_privilege('service_role', 'public.refund_rate_limit(uuid,text,integer)', 'EXECUTE') AS service_role,
       has_function_privilege('authenticated', 'public.refund_rate_limit(uuid,text,integer)', 'EXECUTE') AS authenticated,
       has_function_privilege('anon', 'public.refund_rate_limit(uuid,text,integer)', 'EXECUTE') AS anon;
-- 21k. freeze_settlements is unchanged except for the guard. Safe: new_md5 = 7b507c2ec453c532fd598e533d2625c5 (length 9076) and
--      md5_without_guard = e06a0e7d53c764d6ff435cbf19431505 (the pre-apply value), same signature, security definer, search_path pinned.
SELECT md5(prosrc) AS new_md5, length(prosrc) AS len,
       md5(prosrc) = '7b507c2ec453c532fd598e533d2625c5' AS matches_expected,
       md5(regexp_replace(prosrc, E'\n  -- >>> unclaimed_receipts guard.*?-- <<< unclaimed_receipts guard\n', '', 's')) AS md5_without_guard,
       md5(regexp_replace(prosrc, E'\n  -- >>> unclaimed_receipts guard.*?-- <<< unclaimed_receipts guard\n', '', 's')) = 'e06a0e7d53c764d6ff435cbf19431505' AS rest_is_unchanged,
       prosecdef, proconfig, pg_get_function_identity_arguments(oid) AS args
FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'freeze_settlements';
-- 21l. Policies on the claims tables are exactly as recorded in 21d (the migration changes none), and the triggers are those of 21c PLUS the three new
--      ones (trg_guard_claim_provenance, trg_guard_claim_overclaim on expense_item_claims; trg_guard_expense_leftover_mode on expenses). Re-run and diff.
-- 21l2. Post-apply: SQL-1 (21g) now shows flagged_with_rule_minor = 0 for the real trips, and the real guard agrees. Safe: zero rows for real trips.
SELECT t.name, count(*) AS receipts_flagged FROM public.trips t, LATERAL public._trip_unclaimed_receipts(t.id) u GROUP BY t.name ORDER BY 1;
SELECT t.name, count(*) AS receipts_overclaimed FROM public.trips t, LATERAL public._trip_overclaimed_receipts(t.id) o GROUP BY t.name ORDER BY 1;
-- 21n. Over-claim trigger gate and hardening checks.
-- 21n-1. Lines whose claimed quantity ALREADY exceeds quantity + 0.011 (legacy rounding, e.g. 0.17 x 6 = 1.02, 0.34 x 3). Informational: the new trigger
--        allows any write on a line that is already over its limit (quantity + 0.011 + 0.01 per other claim row) and only refuses a write that itself
--        takes a line over, so an old cached client's "delete my rows, then insert them again" re-save is never refused after its delete committed.
--        Expected: a handful of legacy lines. Safe reading: rows listed here are tolerated, never refused; whether they block a freeze is decided by
--        _trip_overclaimed_receipts (21l2), which uses the stricter money test.
SELECT t.name, e.description, li.line_number, li.quantity, sum(c.quantity_claimed) AS claimed_qty, count(*) AS claim_rows,
       sum(c.quantity_claimed) - li.quantity AS over_by,
       sum(c.quantity_claimed) > li.quantity + 0.011 + 0.01 * (count(*) - 1) AS over_even_with_row_allowance,
       t.settlement_snapshot IS NOT NULL AS trip_frozen
FROM public.expense_item_claims c
JOIN public.expense_line_items li ON li.id = c.line_item_id
JOIN public.expenses e ON e.id = li.expense_id
JOIN public.trips t ON t.id = e.trip_id
GROUP BY t.id, t.name, t.settlement_snapshot, e.id, e.description, li.id, li.line_number, li.quantity
HAVING sum(c.quantity_claimed) > li.quantity + 0.011
ORDER BY 1, 2, 3;
-- 21n-2. POST-APPLY, after leftovers have been shared: per receipt, the rows that carry a leftover part. Safe: leftover_amount <= amount_owed and
--        leftover_quantity <= quantity_claimed on every row (the CHECK), and no row of source 'leftover' has an own part (quantity = leftover_quantity).
SELECT e.description, count(*) FILTER (WHERE c.leftover_amount > 0 OR c.leftover_quantity > 0) AS rows_with_leftover_part,
       count(*) FILTER (WHERE c.source = 'leftover' AND c.quantity_claimed <> c.leftover_quantity) AS pure_rows_with_own_part
FROM public.expense_item_claims c JOIN public.expenses e ON e.id = c.expense_id
GROUP BY e.id, e.description HAVING count(*) FILTER (WHERE c.leftover_amount > 0 OR c.leftover_quantity > 0) > 0 ORDER BY 1;
-- 21n-3. The over-claim trigger is SECURITY INVOKER (it runs as the calling client), so the client roles need EXECUTE on the two functions it calls.
--        Safe: both true (they are granted to PUBLIC by default).
SELECT has_function_privilege('authenticated', 'pg_advisory_xact_lock(bigint)', 'EXECUTE') AS advisory_lock_ok,
       has_function_privilege('authenticated', 'hashtextextended(text,bigint)', 'EXECUTE') AS hashtextextended_ok,
       has_function_privilege('anon', 'pg_advisory_xact_lock(bigint)', 'EXECUTE') AS anon_advisory_lock_ok,
       has_function_privilege('anon', 'hashtextextended(text,bigint)', 'EXECUTE') AS anon_hashtextextended_ok;
-- 21n-4. auth users without a public.users row. Safe: 0 (a claim row references public.users).
SELECT count(*) AS auth_users_without_public_row FROM auth.users u WHERE NOT EXISTS (SELECT 1 FROM public.users p WHERE p.id = u.id);
-- 21n-5. POST-APPLY: claimants (with a trip_participants row, with a claim of their own, not only a leftover part) who are not in _receipt_tagged(expense_id). Safe: zero rows.
SELECT c.expense_id, c.user_id FROM public.expense_item_claims c
JOIN public.expenses e ON e.id = c.expense_id
JOIN public.trip_participants tp ON tp.trip_id = e.trip_id AND tp.user_id = c.user_id
WHERE c.quantity_claimed - c.leftover_quantity > 0 AND NOT (c.user_id = ANY (public._receipt_tagged(c.expense_id)))
GROUP BY 1, 2;
-- 21m. PostgREST sees the new columns and functions (the migration ends with NOTIFY pgrst, 'reload schema').
NOTIFY pgrst, 'reload schema';

-- =====================================================================================
-- 22. Migration 20261126090000_receipt_deadline_tokens.sql (claim deadline, "That's everything" / "I wasn't there", personal links, the deadline job).
--     Run AFTER 20261124090000_receipt_claims_v2.sql is applied (it is, since 2026-11-17). All read-only except the closing NOTIFY.
--     Items marked POST-APPLY are for after the migration ran.
-- =====================================================================================

-- 22a. Names are free. Safe: zero rows from every statement (a column that already exists would make ADD COLUMN IF NOT EXISTS a no-op: check its type).
SELECT table_name, column_name, data_type, column_default, is_nullable FROM information_schema.columns
WHERE table_schema = 'public' AND (
  (table_name = 'expenses' AND column_name IN ('claim_deadline', 'claims_sent_at', 'claims_closed_at'))
  OR (table_name = 'trips' AND column_name = 'receipt_notices_enabled'));
SELECT c.relname FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('expense_claim_responses', 'receipt_claim_tokens', 'receipt_claim_rate_limits');
SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (
  'send_receipt_to_table', 'extend_receipt_deadline', 'apply_receipt_deadline', 'issue_receipt_claim_token', 'receipt_claim_peek', 'receipt_claim_act',
  'receipt_claim_rate_hit', 'reitemize_expense', '_reitemize_num', 'reopen_receipt_claims', '_receipt_reshare_mode', '_receipt_sync_token_expiry',
  '_receipt_resplit_table_items', '_receipt_after_tagged_change', 'after_claim_response', 'clear_done_on_claim_change', 'guard_claim_closed', 'guard_line_items_closed', 'respond_to_receipt', 'guard_claim_response', 'guard_expense_claim_state', '_expense_trip_member', '_receipt_response_state', '_receipt_can_toggle',
  '_receipt_claim_view', '_receipt_token_lookup', '_receipt_token_name', '_receipt_default_deadline');
SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('trg_guard_claim_response', 'trg_guard_expense_claim_state', 'trg_after_claim_response', 'trg_clear_done_on_claim_change', 'trg_guard_claim_closed', 'trg_guard_line_items_closed');
-- apply_receipt_deadline changes signature to (uuid, boolean): the migration DROPs the one-argument form if it exists (it never existed live). Safe: zero rows.
SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'apply_receipt_deadline';
SELECT policyname FROM pg_policies WHERE policyname IN ('Trip members can view claim responses', 'Users can add their own claim response',
  'Users can change their own claim response', 'Users can delete their own claim response');

-- 22b. Columns the migration relies on. Safe: expenses.id/trip_id/paid_by uuid, description text, currency text, ai_parsed boolean, status expense_status,
--      leftover_mode text (phase 1); users.first_name and full_name text; trips.name text and settlement_snapshot jsonb;
--      notifications(trip_id, user_id, dedupe_key text UNIQUE); activity_feed(trip_id, actor, verb, entity, metadata); expense_line_items.name_original / name_english text.
SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND (
  (table_name = 'expenses' AND column_name IN ('id', 'trip_id', 'paid_by', 'description', 'currency', 'ai_parsed', 'status', 'leftover_mode', 'participant_ids', 'amount'))
  OR (table_name = 'users' AND column_name IN ('id', 'first_name', 'full_name', 'email_notifications_enabled'))
  OR (table_name = 'trips' AND column_name IN ('id', 'name', 'settlement_snapshot', 'chase_settings'))
  OR (table_name = 'notifications' AND column_name IN ('trip_id', 'user_id', 'kind', 'dedupe_key', 'entity_type', 'entity_id'))
  OR (table_name = 'activity_feed' AND column_name IN ('trip_id', 'actor', 'verb', 'entity', 'metadata'))
  OR (table_name = 'expense_line_items' AND column_name IN ('name_original', 'name_english', 'shared_by_all', 'quantity', 'total_amount')))
ORDER BY 1, 2;
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.notifications'::regclass AND contype = 'u';   -- Safe: UNIQUE (dedupe_key)

-- 22c. The THREE functions the migration REPLACES (_receipt_tagged, _receipt_leftover_confirmed and _receipt_begin, which only gains a closed-receipt refusal) are exactly the bodies shipped in 20261124090000 (so nothing unknown is overwritten), and the phase-1
--      functions it calls (but does not change) are unchanged. Safe: every matches_shipped is true. (Computed from the file text; pglite agrees.)
SELECT p.proname, md5(p.prosrc) AS md5, length(p.prosrc) AS len,
       md5(p.prosrc) = CASE p.proname
         WHEN '_receipt_tagged' THEN '3fb9669b56045306d97fae8ad1394f5b'
         WHEN '_receipt_leftover_confirmed' THEN 'a09c7c73162dbe9a106fd8485b29bd28'
         WHEN '_receipt_leftover_plan' THEN '78d56ee682298fc639463112cd4bdf3e'
         WHEN '_receipt_begin' THEN '71b9ad95120b15ad653bc59c2c15f587'
         WHEN '_receipt_lines' THEN '38cec07fd2f82d6c9a4e31e8c41b8c14'
         WHEN '_receipt_even_split' THEN 'bafa1641b301fce2022de718d2d68d68'
         WHEN 'set_receipt_claims' THEN '6e7e9da9f8581b4929a2558475330282'
         WHEN 'share_receipt_leftovers' THEN '52a35443baae3f7f5df46a9a0ae171bf' END AS matches_shipped
FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('_receipt_tagged', '_receipt_leftover_confirmed', '_receipt_leftover_plan', '_receipt_begin', '_receipt_lines', '_receipt_even_split',
                    'set_receipt_claims', 'share_receipt_leftovers')
ORDER BY 1;
-- Expected lengths: _receipt_tagged 2027, _receipt_leftover_confirmed 47, _receipt_leftover_plan 3438, _receipt_begin 2941, _receipt_lines 958,
--   _receipt_even_split 400, set_receipt_claims 11048, share_receipt_leftovers 9408. POST-APPLY only _receipt_tagged, _receipt_leftover_confirmed and _receipt_begin differ.

-- 22d. Triggers next to the new ones (POST-APPLY: expense_item_claims also gains trg_clear_done_on_claim_change and trg_guard_claim_closed; expense_line_items gains trg_guard_line_items_closed; expense_claim_responses has
--      trg_guard_claim_response and trg_after_claim_response). Safe BEFORE: expenses = set_updated_at, trigger_guard_immutable_keys, trg_guard_expense_leftover_mode;
--      expense_item_claims = trg_guard_claim_overclaim, trg_guard_claim_provenance, trigger_auto_update_expense_status.
--      POST-APPLY: expenses gains trg_guard_expense_claim_state (4 in all); expense_item_claims unchanged; expense_claim_responses = trg_guard_claim_response.
SELECT tgrelid::regclass AS tbl, tgname, tgenabled FROM pg_trigger
WHERE NOT tgisinternal AND tgrelid IN ('public.expenses'::regclass, 'public.expense_item_claims'::regclass) ORDER BY 1, 2;

-- 22e. Helpers and policies the migration relies on. Safe: _settlement_can_manage, currency_exponent, _receipt_* helpers exist; auth.role() and auth.uid()
--      exist; expenses has the participant UPDATE policies (which is why the new guard trigger stops clients writing the deadline columns).
SELECT p.oid::regprocedure FROM pg_proc p WHERE (p.pronamespace = 'public'::regnamespace AND p.proname IN ('_settlement_can_manage', 'currency_exponent', '_receipt_begin', 'set_receipt_claims', 'share_receipt_leftovers'))
   OR (p.pronamespace = 'auth'::regnamespace AND p.proname IN ('uid', 'role')) ORDER BY 1;
SELECT policyname, cmd, qual FROM pg_policies WHERE schemaname = 'public' AND tablename = 'expenses' AND cmd IN ('UPDATE', 'INSERT') ORDER BY 1;
-- auth.uid() / auth.role() must read request.jwt.claim.sub / request.jwt.claims (the link functions impersonate the person with set_config). Safe: all four true.
SELECT position('request.jwt.claim.sub' IN pg_get_functiondef('auth.uid()'::regprocedure)) > 0 AS uid_reads_claim_sub,
       position('request.jwt.claims' IN pg_get_functiondef('auth.uid()'::regprocedure)) > 0 AS uid_reads_claims,
       position('request.jwt.claims' IN pg_get_functiondef('auth.role()'::regprocedure)) > 0 AS role_reads_claims,
       position('claim.role' IN pg_get_functiondef('auth.role()'::regprocedure)) > 0 AS role_reads_claim_role;

-- 22f. Phase-1 shares that already exist. Informational. Every receipt listed here was shared with the PHASE-1 rule (a plain equal split). Re-running 'same'
--      (or the deadline job) uses the new rule, so its amounts can change. Safe: only test trips, or none.
SELECT t.name, e.description, e.leftover_mode, count(*) FILTER (WHERE c.leftover_amount > 0) AS rows_with_leftover_part
FROM public.expenses e JOIN public.trips t ON t.id = e.trip_id LEFT JOIN public.expense_item_claims c ON c.expense_id = e.id
WHERE e.leftover_mode IS NOT NULL GROUP BY t.name, e.id, e.description, e.leftover_mode ORDER BY 1, 2;

-- 22g. No long-running transaction touching expenses / trips (the migration sets lock_timeout = 5s and fails rather than queueing). Safe: no rows.
SELECT pid, state, now() - xact_start AS open_for, left(query, 100) AS query FROM pg_stat_activity
WHERE state <> 'idle' AND xact_start < now() - interval '30 seconds' AND pid <> pg_backend_pid() AND query ILIKE ANY (ARRAY['%expenses%', '%trips%']);

-- 22h. Notification precedent for the dedupe keys the edge functions will use ('notice:receipt:<expense>:<user>:<kind>'). Informational: the existing keys, and
--      zero receipt keys before the first send. Safe: second query zero rows.
SELECT split_part(dedupe_key, ':', 1) || ':' || split_part(dedupe_key, ':', 2) AS key_family, kind, count(*) FROM public.notifications GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 20;
SELECT count(*) AS receipt_notice_rows FROM public.notifications WHERE dedupe_key LIKE 'notice:receipt:%';

-- 22i. POST-APPLY structure. Safe: expenses gains the three nullable timestamptz columns (NULL on every row); trips.receipt_notices_enabled boolean NOT NULL
--      default true (true on every trip); RLS on for all three new tables; exactly four policies, all on expense_claim_responses.
SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND (
  (table_name = 'expenses' AND column_name IN ('claim_deadline', 'claims_sent_at', 'claims_closed_at')) OR (table_name = 'trips' AND column_name = 'receipt_notices_enabled'))
ORDER BY 1, 2;
SELECT (SELECT count(*) FROM public.expenses WHERE claim_deadline IS NOT NULL OR claims_sent_at IS NOT NULL OR claims_closed_at IS NOT NULL) AS expenses_with_claim_state,
       (SELECT count(*) FROM public.trips WHERE receipt_notices_enabled IS NOT TRUE) AS trips_with_notices_off;
SELECT c.relname, c.relrowsecurity AS rls, (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies
FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('expense_claim_responses', 'receipt_claim_tokens', 'receipt_claim_rate_limits') ORDER BY 1;

-- 22j. POST-APPLY privileges. Safe (anon / authenticated / service_role EXECUTE):
--        send_receipt_to_table, extend_receipt_deadline:        f / t / (t by default ACL)
--        apply_receipt_deadline:                                 f / t / t
--        issue_receipt_claim_token, receipt_claim_peek, receipt_claim_act, receipt_claim_rate_hit:  f / f / t
--        _receipt_response_state:                                f / t / t   (the response guard runs as the client; booleans only)
--        _expense_trip_member and every other helper:            f / f / (t)  (internal only: NOT executable by clients; the policies use is_trip_participant)
--        reopen_receipt_claims, respond_to_receipt:              f / t / (t by default ACL)
--        every other _receipt_* helper and the two guard_* trigger functions: f / f / (t for helpers, f for guard_*)
SELECT p.oid::regprocedure AS fn, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_exec, p.prosecdef AS secdef, p.proconfig
FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND (p.proname IN (
  'send_receipt_to_table', 'extend_receipt_deadline', 'apply_receipt_deadline', 'issue_receipt_claim_token', 'receipt_claim_peek', 'receipt_claim_act',
  'receipt_claim_rate_hit', 'reopen_receipt_claims', 'respond_to_receipt', 'guard_claim_response', 'guard_expense_claim_state', 'after_claim_response', 'clear_done_on_claim_change',
  'guard_claim_closed', 'guard_line_items_closed', '_expense_trip_member') OR p.proname LIKE '\_receipt\_%') ORDER BY 1;
SELECT c.relname, has_table_privilege('anon', c.oid, 'SELECT') AS anon_select, has_table_privilege('authenticated', c.oid, 'SELECT') AS authenticated_select,
       has_table_privilege('authenticated', c.oid, 'INSERT') AS authenticated_insert, has_table_privilege('service_role', c.oid, 'INSERT') AS service_insert
FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('expense_claim_responses', 'receipt_claim_tokens', 'receipt_claim_rate_limits') ORDER BY 1;
-- Safe: expense_claim_responses: anon false, authenticated true / true; the two token tables: anon false, authenticated FALSE / FALSE; service role true.

-- 22k. POST-APPLY: the two replaced functions now differ from the shipped text (expected) and record the new md5s for the deploy log.
SELECT proname, md5(prosrc) AS new_md5, length(prosrc) AS len FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('_receipt_tagged', '_receipt_leftover_confirmed') ORDER BY 1;

-- 22l. POST-APPLY data guards. Safe: zero rows from each.
--      (1) the payer answered 'not_there'; (2) a not_there person who holds a claim of their own; (3) a response row for a person who is not on the trip.
SELECT r.expense_id, r.user_id FROM public.expense_claim_responses r JOIN public.expenses e ON e.id = r.expense_id WHERE r.response = 'not_there' AND e.paid_by = r.user_id;
SELECT r.expense_id, r.user_id FROM public.expense_claim_responses r WHERE r.response = 'not_there'
  AND EXISTS (SELECT 1 FROM public.expense_item_claims c WHERE c.expense_id = r.expense_id AND c.user_id = r.user_id AND c.quantity_claimed - c.leftover_quantity > 0);
SELECT r.expense_id, r.user_id FROM public.expense_claim_responses r JOIN public.expenses e ON e.id = r.expense_id
WHERE NOT EXISTS (SELECT 1 FROM public.trip_participants tp WHERE tp.trip_id = e.trip_id AND tp.user_id = r.user_id);

-- 22m. Default privileges (informational: why the migration revokes explicitly). Expect the default ACL of the owner role in schema public to grant the API roles
--      EXECUTE on functions and ALL on tables.
SELECT pg_get_userbyid(d.defaclrole) AS owner, d.defaclobjtype, d.defaclacl FROM pg_default_acl d WHERE d.defaclnamespace = 'public'::regnamespace OR d.defaclnamespace = 0;

-- 22n. Edge-function secrets are not in the database; the functions need RESEND_API_KEY, RESEND_FROM and APP_BASE_URL (names only, already set per live-checks-paid-email).

-- 22p. reitemize_expense (re-itemise keeping claims; also plain -> itemised). Columns and tables it writes. Safe: every row present.
--      expenses: description, vendor_name, category (enum expense_category), payment_date, paid_by, participant_ids, receipt_url, currency, fx_rate, fx_rate_date,
--      rate_source, amount, base_currency_amount, ai_parsed, status, leftover_mode, leftover_user_id; expense_line_items: name_original, name_english, quantity,
--      unit_price, subtotal, tax_amount, service_amount, line_discount_amount, total_amount, line_number, shared_by_all; expense_splits(expense_id).
SELECT table_name, column_name, udt_name FROM information_schema.columns WHERE table_schema = 'public' AND (
  (table_name = 'expenses' AND column_name IN ('description', 'vendor_name', 'category', 'payment_date', 'paid_by', 'participant_ids', 'receipt_url', 'currency', 'fx_rate',
     'fx_rate_date', 'rate_source', 'amount', 'base_currency_amount', 'ai_parsed', 'status', 'leftover_mode', 'leftover_user_id'))
  OR (table_name = 'expense_line_items' AND column_name IN ('name_original', 'name_english', 'quantity', 'unit_price', 'subtotal', 'tax_amount', 'service_amount',
     'line_discount_amount', 'total_amount', 'line_number', 'shared_by_all'))
  OR (table_name = 'expense_splits' AND column_name = 'expense_id')) ORDER BY 1, 2;
-- The line_number uniqueness the +100000 shuffle works around must be a NON-deferrable UNIQUE (expense_id, line_number); no other CHECK may bound line_number. Safe: one row, condeferrable f.
SELECT conname, condeferrable, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.expense_line_items'::regclass AND contype IN ('u', 'c') ORDER BY 1;
-- Nothing may hang off expense_splits or expense_line_items that a DELETE/UPDATE here could trip (triggers). Safe: only guard_immutable_keys on expense_splits (BEFORE UPDATE).
SELECT tgrelid::regclass AS tbl, tgname, pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN ('public.expense_splits'::regclass, 'public.expense_line_items'::regclass) ORDER BY 1, 2;

-- 22q. unfreeze_settlements is REPLACED (a strict superset: also deletes the trip's stale 'suggested' payments except rows with receipt_disputed_at or an unused, unexpired
--      payment_confirm_tokens row). RECORD the live md5 at pre-flight time; do not assume one. repo_text_md5 is the body shipped in 20261118100000; if live differs, STOP and
--      read the live body (pg_get_functiondef) before applying. Also confirms the two columns the new body reads exist and no later function rewrote it.
SELECT md5(prosrc) AS live_md5, length(prosrc) AS len, md5(prosrc) = '1ec90283bba01dfbbb4b4a7bd26df64b' AS equals_repo_text,
       pg_get_function_identity_arguments(oid) AS args, prosecdef, proconfig,
       has_function_privilege('anon', oid, 'EXECUTE') AS anon_exec, has_function_privilege('authenticated', oid, 'EXECUTE') AS authenticated_exec
FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'unfreeze_settlements';   -- one row; secdef true; search_path public, pg_temp; anon false; authenticated true
SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'settlements' AND column_name = 'receipt_disputed_at';   -- one row
SELECT to_regclass('public.payment_confirm_tokens') IS NOT NULL AS tokens_table_exists, to_regprocedure('public.settlement_assert_can_manage(uuid,uuid)') IS NOT NULL AS assert_can_manage_exists;
--      Informational: what the new unfreeze would delete right now on each currently-FROZEN trip (suggested rows without a dispute or live link). POST-APPLY this is 0 after an unfreeze.
SELECT t.name, count(*) FILTER (WHERE s.status = 'suggested') AS suggested, count(*) FILTER (WHERE s.status = 'suggested' AND s.receipt_disputed_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM public.payment_confirm_tokens k WHERE k.settlement_id = s.id AND k.used_at IS NULL AND k.expires_at > now())) AS would_delete,
       count(*) FILTER (WHERE s.status IN ('marked_paid', 'confirmed')) AS real_payments_untouched
FROM public.trips t LEFT JOIN public.settlements s ON s.trip_id = t.id WHERE t.settlement_snapshot IS NOT NULL GROUP BY t.name ORDER BY 1;
-- POST-APPLY: record the new md5 for the deploy log.
SELECT md5(prosrc) AS new_unfreeze_md5, length(prosrc) AS len FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'unfreeze_settlements';
-- 22r. freeze_settlements must still be the phase-1 body (this migration does not touch it). Safe: matches_phase1 = true (md5 7b507c2ec453c532fd598e533d2625c5).
SELECT md5(prosrc) = '7b507c2ec453c532fd598e533d2625c5' AS matches_phase1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'freeze_settlements';

-- 22s. READ-ONLY LIVE CHECKS still required before applying (from the independent review; the pglite harness could not answer these). Record each result.
SELECT pg_has_role('postgres', 'service_role', 'member') AS postgres_can_set_role_service_role, version();   -- the rehearsal no longer relies on SET ROLE service_role
SELECT conrelid::regclass AS tbl, conname, confdeltype FROM pg_constraint WHERE contype = 'f'
  AND confrelid IN ('public.settlements'::regclass, 'public.expense_line_items'::regclass, 'public.expense_splits'::regclass, 'public.expenses'::regclass) ORDER BY 1, 2;
    -- expect: only payment_confirm_tokens -> settlements (c); expense_item_claims / expense_claim_responses(after apply) -> line items / expenses (c); no other NO ACTION / RESTRICT FK into those tables
SELECT conrelid::regclass AS tbl, conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid IN ('public.expenses'::regclass, 'public.expense_line_items'::regclass) AND contype = 'c' ORDER BY 1, 2;
    -- amount > 0? char_length limits on name_original / name_english? (reitemize maps check_violation to bad_line; validate lengths client side to the real limits)
SELECT tgrelid::regclass AS tbl, tgname, pg_get_triggerdef(oid) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN ('public.settlements'::regclass, 'public.trips'::regclass, 'public.trip_participants'::regclass) ORDER BY 1, 2;   -- no DELETE trigger on settlements
SELECT enum_range(NULL::public.expense_category) AS category_labels;
SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'expenses' AND column_name IN ('payment_date', 'vendor_name', 'receipt_url', 'rate_source', 'fx_rate_date', 'category');
SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'expense_allocation_links' ORDER BY ordinal_position;   -- code, expense_id, trip_id, created_by (the client creates the row)
SELECT p.oid::regprocedure, p.prosecdef FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('is_trip_participant', 'is_trip_organizer');   -- (uuid, uuid); the response policies now use is_trip_participant
SELECT policyname, cmd, roles FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('trips', 'trip_participants', 'users', 'expense_splits', 'expense_allocation_links') ORDER BY tablename, policyname;   -- the harness leaves these tables open: record the real ones
SELECT count(*) AS person_mode_receipts FROM public.expenses WHERE leftover_mode = 'person';       -- B1 exposure today
SELECT count(*) AS table_item_lines FROM public.expense_line_items WHERE shared_by_all;           -- B3 exposure today
SELECT pubname, tablename FROM pg_publication_tables WHERE tablename IN ('expense_item_claims', 'expenses', 'expense_claim_responses');   -- realtime: add expense_claim_responses if "Waiting on" should update live (not done by the migration)
-- POST-APPLY: person-mode receipts whose chosen person is no longer on the receipt (the reshare mode falls back to everyone; the next apply fixes them). Safe: zero rows.
SELECT e.id, e.description FROM public.expenses e WHERE e.leftover_mode = 'person' AND NOT (e.leftover_user_id = ANY (public._receipt_tagged(e.id)));
-- POST-APPLY: closed receipts that still have unclaimed value (the closed-receipt guards stop new ones). Safe: zero rows.
SELECT e.id, e.description FROM public.expenses e WHERE e.claims_closed_at IS NOT NULL AND EXISTS (SELECT 1 FROM public._receipt_lines(e.id, true) l WHERE l.remaining_minor > 0);

-- 22o. PostgREST sees the new columns, table and functions (the migration ends with NOTIFY pgrst, 'reload schema').
NOTIFY pgrst, 'reload schema';

-- =====================================================================================
-- 23. Migration 20261128090000_freeze_enforcement.sql (a frozen trip is enforced by the database). Run AFTER 20261126090000 (live). All read-only.
-- =====================================================================================

-- 23a. Names are free. Safe: zero rows from every statement.
SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('_trip_frozen_for_write', '_expense_frozen_for_write', 'guard_frozen_expense', 'guard_frozen_expense_child', 'guard_trip_settlement_columns');
SELECT tgname, tgrelid::regclass FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('trg_guard_frozen_expense', 'trg_guard_frozen_split', 'trg_guard_frozen_line', 'trg_guard_frozen_claim_delete', 'trg_guard_trip_settlement_columns');

-- 23b. The function the new claim-DELETE guard sits beside is exactly the shipped phase-1 text (the migration does not change it). Safe: matches_shipped = true (md5 57312c8bff6c4ee090181819a3889626, length 2413).
SELECT md5(prosrc) AS md5, length(prosrc) AS len, md5(prosrc) = '57312c8bff6c4ee090181819a3889626' AS matches_shipped FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'guard_claim_overclaim';

-- 23c. The trigger lists the new triggers join. Safe BEFORE: expenses = set_updated_at, trg_guard_expense_claim_state, trg_guard_expense_leftover_mode, trigger_guard_immutable_keys;
--      expense_splits = trigger_guard_immutable_keys only; expense_line_items = trg_guard_line_items_closed; expense_item_claims = trg_clear_done_on_claim_change, trg_guard_claim_closed,
--      trg_guard_claim_overclaim, trg_guard_claim_provenance, trigger_auto_update_expense_status; trips = set_updated_at, trg_reset_action_reminders_on_trip_start_change, trigger_guard_immutable_keys.
--      Trigger names fire alphabetically: the new trg_guard_frozen_expense runs after set_updated_at and the other trg_guard_expense_* triggers (so the claim-state columns are already restored
--      to OLD when it compares) and before trigger_guard_immutable_keys.
SELECT tgrelid::regclass AS tbl, tgname, tgenabled FROM pg_trigger WHERE NOT tgisinternal
  AND tgrelid IN ('public.expenses'::regclass, 'public.expense_splits'::regclass, 'public.expense_line_items'::regclass, 'public.expense_item_claims'::regclass, 'public.trips'::regclass) ORDER BY 1, 2;

-- 23d. Policies the migration relies on. Safe: expense_claim_responses has exactly the four phase-2 policies (the three write ones are dropped); the trips and expense write policies are recorded
--      so a later change is noticed. Record the list.
SELECT tablename, policyname, cmd FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('expense_claim_responses', 'expenses', 'expense_splits', 'expense_line_items', 'trips') ORDER BY 1, 3, 2;

-- 23e. Frozen trips today (the migration changes what clients may write there). Informational: Sailing Sicily only (the TEST trip is NOT frozen; the rehearsal freezes it inside its transaction).
SELECT t.id, t.name, t.settlement_snapshot_at FROM public.trips t WHERE t.settlement_snapshot IS NOT NULL ORDER BY 2;

-- 23f. The expenses columns that are NOT cosmetic stay refused; the whitelist columns must exist (a missing name would simply never match). Safe: all 13 present except any that were never added.
SELECT c.column_name FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = 'expenses'
  AND c.column_name IN ('description', 'category', 'vendor_name', 'location', 'receipt_url', 'receipt_date', 'payment_date', 'place_id', 'option_id', 'booking_id', 'ai_parsed_data', 'parsing_error', 'updated_at') ORDER BY 1;
-- Every OTHER expenses column (these are refused while frozen): record them.
SELECT c.column_name FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = 'expenses'
  AND c.column_name NOT IN ('description', 'category', 'vendor_name', 'location', 'receipt_url', 'receipt_date', 'payment_date', 'place_id', 'option_id', 'booking_id', 'ai_parsed_data', 'parsing_error', 'updated_at') ORDER BY 1;

-- 23g. The client at HEAD never writes expense_claim_responses directly (src has only a SELECT of it); old clients never wrote it. Nothing to query: confirm with
--      `git grep -n "expense_claim_responses" -- src` (only .select).
-- 23h. Does any SECURITY INVOKER function WRITE the guarded tables (it would run as the client and meet the new guards)? EXACT expected list (pglite, 2026-11-17): ONE row,
--      _receipt_strip_leftovers(uuid): it is revoked from every client role and only called from definer RPCs. ANY other row on live: read its body before applying.
SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND NOT p.prosecdef
  AND p.prosrc ~* '(insert[[:space:]]+into|update|delete[[:space:]]+from)[[:space:]]+(public\.)?(expenses|expense_splits|expense_line_items|expense_item_claims)([^a-z_]|$)' ORDER BY 1;
-- 23i. pg_has_role / long transactions (as 22s / 22g). Safe: no long transaction touching trips / expenses.
SELECT pid, now() - xact_start AS open_for, left(query, 100) AS query FROM pg_stat_activity
WHERE state <> 'idle' AND xact_start < now() - interval '30 seconds' AND pid <> pg_backend_pid() AND query ILIKE ANY (ARRAY['%expenses%', '%trips%']);
-- 23j. POST-APPLY. Safe: the 5 new triggers on the 5 tables; the response policies = 1 (SELECT); anon / authenticated EXECUTE: _trip_frozen_for_write f / t, the guard functions f / f.
SELECT p.oid::regprocedure AS fn, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec, p.prosecdef
FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('_trip_frozen_for_write', '_expense_frozen_for_write', 'guard_frozen_expense', 'guard_frozen_expense_child', 'guard_trip_settlement_columns') ORDER BY 1;
SELECT count(*) AS response_policies FROM pg_policies WHERE tablename = 'expense_claim_responses';   -- 1
SELECT has_table_privilege('authenticated', 'public.expense_claim_responses', 'INSERT') AS can_insert;   -- false

-- =====================================================================================
-- 24. Migration 20261128100000_own_claims_rpc.sql (set_my_receipt_claims, the direct-write counter, table-share activity). Run AFTER 23 / M1. All read-only.
-- =====================================================================================

-- 24a. Names are free. Safe: zero rows.
SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('set_my_receipt_claims', '_log_client_direct_write', 'count_client_direct_write');
SELECT to_regclass('public.client_direct_writes') AS counter_table;   -- NULL
SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('trg_count_direct_claims', 'trg_count_direct_lines', 'trg_count_direct_splits');

-- 24b. The ONE existing function M2 replaces is exactly the phase-2 text, and the functions it calls are unchanged. RECORD the md5s for the deploy log; POST-APPLY _receipt_resplit_table_items
--      becomes md5 5214a384cd672de9ccbab97ac034fbc2 (length 3644). Safe: matches_shipped = true for all.
SELECT p.proname, md5(p.prosrc) AS md5, length(p.prosrc) AS len,
       md5(p.prosrc) = CASE p.proname WHEN '_receipt_resplit_table_items' THEN 'ede35228aa5739454e3051eeaa24412e' WHEN '_receipt_begin' THEN '1e73f23e07e7a4e219f026ac0add8565' END AS matches_shipped
FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('_receipt_resplit_table_items', '_receipt_begin') ORDER BY 1;

-- 24c. The request header the counter reads. In the SQL editor this is NULL (no API request): expected. The counter fails open, so a missing header only logs build NULL.
SELECT current_setting('request.headers', true) AS request_headers_in_editor;
-- 24d. Columns / constraints set_my_receipt_claims writes (as the existing RPCs): quantity_claimed / amount_owed numeric(10,2), UNIQUE (line_item_id, user_id), CHECK quantity_claimed > 0.
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.expense_item_claims'::regclass AND contype IN ('u', 'c') ORDER BY 1;
-- 24e. POST-APPLY. Safe: the counter table exists with RLS on and no client access; set_my_receipt_claims executable by authenticated only; 3 statement triggers.
SELECT c.relname, c.relrowsecurity AS rls, has_table_privilege('authenticated', c.oid, 'SELECT') AS authenticated_select FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'client_direct_writes';
SELECT p.oid::regprocedure AS fn, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec
FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('set_my_receipt_claims', '_log_client_direct_write', 'count_client_direct_write') ORDER BY 1;
-- 24f. THE READOUT (after the new front end is out): who still writes claims directly, by build.
SELECT build, tbl, op, count(*) AS statements, max(at) AS last_seen FROM public.client_direct_writes WHERE at > now() - interval '7 days' GROUP BY 1, 2, 3 ORDER BY 4 DESC;
-- 24g. Table-share activity so far (POST-APPLY). Informational.
SELECT created_at, metadata ->> 'line' AS line, metadata ->> 'from' AS from_amount, metadata ->> 'to' AS to_amount FROM public.activity_feed WHERE verb = 'receipt_table_share_changed' ORDER BY created_at DESC LIMIT 20;
NOTIFY pgrst, 'reload schema';

-- =====================================================================================
-- 25. Trip chat A1: 20261129090000_chat_actions.sql, 20261129100000_chat_private_threads.sql, 20261129110000_admin_ai_usage.sql. All read-only except the closing NOTIFY.
--     The LIVE policies of trip_chat_messages are not in the repo: the private-threads migration adds only RESTRICTIVE policies and fails loudly if the table is not as expected.
--     RUN 25b FIRST and read it: it is the evidence the migration's pre-flight assumes.
-- =====================================================================================

-- 25a. Names are free. Safe: zero rows from every statement.
SELECT c.relname FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('chat_actions', 'trip_chat_threads');
SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'trip_chat_messages' AND column_name IN ('thread_user_id', 'turn_id');
SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('begin_chat_action', 'finish_chat_action', 'dismiss_chat_action', 'mark_chat_action_edited',
  'chat_actions_expire_stale', 'mark_chat_action_undone', '_chat_action_json', '_chat_action_own', 'guard_chat_action_update', 'new_chat', 'mark_chat_seen', 'admin_ai_usage_summary');
SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND (policyname LIKE 'Private chat threads:%' OR policyname IN ('Users can view their own chat actions', 'Users can view their own chat thread state'));
SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname IN ('trip_chat_messages_thread_idx', 'trip_chat_messages_turn_uidx', 'chat_actions_user_turn_idx', 'chat_actions_turn_dedupe_uidx');

-- 25b. THE LIVE STATE OF trip_chat_messages (record all of it). Expected (schema.txt): columns id uuid, trip_id uuid NOT NULL, user_id uuid, role chat_message_role NOT NULL (user|assistant|system),
--      content text NOT NULL, actions_executed jsonb, had_write_actions bool, metadata jsonb, created_at timestamptz; RLS ON; at least ONE permissive SELECT policy (the migration refuses otherwise).
SELECT column_name, data_type, udt_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'trip_chat_messages' ORDER BY ordinal_position;
SELECT c.relrowsecurity AS rls_on, c.relforcerowsecurity AS rls_forced, c.relreplident AS replica_identity FROM pg_class c WHERE c.oid = 'public.trip_chat_messages'::regclass;
SELECT policyname, cmd, permissive, roles, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = 'trip_chat_messages' ORDER BY cmd, policyname;
SELECT tgname, tgenabled, pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid = 'public.trip_chat_messages'::regclass AND NOT tgisinternal;
SELECT conname, contype, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.trip_chat_messages'::regclass ORDER BY 1;
SELECT conrelid::regclass AS referencing, conname FROM pg_constraint WHERE confrelid = 'public.trip_chat_messages'::regclass;   -- chat_actions.message_id will be the first FK into it
SELECT pubname FROM pg_publication_tables WHERE schemaname = 'public' AND tablename = 'trip_chat_messages';   -- realtime: the restrictive SELECT policy filters what subscribers receive
SELECT has_table_privilege('authenticated', 'public.trip_chat_messages', 'INSERT') AS auth_insert, has_table_privilege('authenticated', 'public.trip_chat_messages', 'UPDATE') AS auth_update,
       has_table_privilege('authenticated', 'public.trip_chat_messages', 'DELETE') AS auth_delete;
SELECT count(*) AS rows, count(*) FILTER (WHERE user_id IS NULL) AS assistant_or_null_user, min(created_at), max(created_at) FROM public.trip_chat_messages;   -- the existing rows become the READ-ONLY legacy history (thread_user_id NULL)
SELECT enum_range(NULL::public.chat_message_role) AS roles;

-- 25c. ai_usage (admin summary) and users.role. Expected: ai_usage columns function_name, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, estimated_cost_usd, created_at; users.role has 'admin'.
SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_usage' ORDER BY ordinal_position;
SELECT policyname, cmd, qual FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ai_usage';
SELECT count(*) AS ai_usage_rows, min(created_at), max(created_at) FROM public.ai_usage;
SELECT enum_range(NULL::public.user_role) AS user_roles;
SELECT count(*) AS site_admins FROM public.users WHERE role::text = 'admin';
-- 25d. Helpers the migrations call. Safe: is_trip_participant(uuid, uuid) exists (SECURITY DEFINER); auth.role() exists.
SELECT p.oid::regprocedure, p.prosecdef FROM pg_proc p WHERE p.proname IN ('is_trip_participant', 'role') AND p.pronamespace IN ('public'::regnamespace, 'auth'::regnamespace);
-- 25e. The chat message bucket today (the daily action cap is NOT a rate_limits bucket: it is counted in begin_chat_action).
SELECT feature, count(*) FROM public.rate_limits GROUP BY 1 ORDER BY 1;
-- 25f. No long-running transaction on the chat tables (the migrations set lock_timeout = 5s).
SELECT pid, now() - xact_start AS open_for, left(query, 100) AS query FROM pg_stat_activity WHERE state <> 'idle' AND xact_start < now() - interval '30 seconds' AND pid <> pg_backend_pid() AND query ILIKE '%trip_chat%';
-- 25g. POST-APPLY. Safe: the four RESTRICTIVE policies on trip_chat_messages (SELECT, INSERT, UPDATE, DELETE) next to the live permissive ones; every existing row has thread_user_id NULL;
--      chat_actions and trip_chat_threads have RLS on with ONE select policy each; authenticated has only SELECT on both; the RPCs are executable by authenticated, expire_stale by service_role only.
SELECT policyname, cmd, permissive FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('trip_chat_messages', 'chat_actions', 'trip_chat_threads') ORDER BY tablename, cmd, policyname;
SELECT count(*) FILTER (WHERE thread_user_id IS NULL) AS legacy_rows, count(*) FILTER (WHERE thread_user_id IS NOT NULL) AS private_rows FROM public.trip_chat_messages;
SELECT c.relname, c.relrowsecurity, has_table_privilege('authenticated', c.oid, 'SELECT') AS auth_select, has_table_privilege('authenticated', c.oid, 'INSERT') AS auth_insert, has_table_privilege('authenticated', c.oid, 'UPDATE') AS auth_update
FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('chat_actions', 'trip_chat_threads') ORDER BY 1;
SELECT p.oid::regprocedure AS fn, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec, has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_exec
FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('begin_chat_action', 'finish_chat_action', 'dismiss_chat_action', 'mark_chat_action_edited', 'chat_actions_expire_stale', 'new_chat', 'mark_chat_seen', 'admin_ai_usage_summary') ORDER BY 1;
NOTIFY pgrst, 'reload schema';
