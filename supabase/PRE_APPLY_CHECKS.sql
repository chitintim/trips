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
  (table_name = 'expense_item_claims' AND column_name IN ('source', 'created_by'))
  OR (table_name = 'expense_line_items' AND column_name = 'shared_by_all'));
SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
  AND (p.proname IN ('set_receipt_claims', 'share_receipt_leftovers', '_trip_unclaimed_receipts', '_trip_overclaimed_receipts', 'refund_rate_limit',
                     'guard_claim_provenance', 'guard_claim_overclaim', 'guard_expense_leftover_mode') OR p.proname LIKE '\_receipt\_%');
SELECT conname FROM pg_constraint WHERE conname IN ('expense_item_claims_source_check', 'expenses_leftover_mode_check');
-- Also free: the two expenses columns and the three new trigger names. Safe: zero rows.
SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'expenses' AND column_name IN ('leftover_mode', 'leftover_user_id');
SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('trg_guard_claim_provenance', 'trg_guard_claim_overclaim', 'trg_guard_expense_leftover_mode');

-- 21b. Columns the migration relies on, with types. Safe: expense_item_claims.quantity_claimed numeric(10,2) (precision 10, scale 2),
--      amount_owed numeric; expense_line_items.quantity/total_amount numeric; expenses.amount numeric, currency text NOT NULL,
--      status expense_status (nullable), ai_parsed boolean, participant_ids uuid[] (_uuid), paid_by uuid NOT NULL, description text NOT NULL;
--      trips.settlement_snapshot jsonb. A different scale on quantity_claimed (e.g. 3) is harmless but note it.
SELECT table_name, column_name, data_type, udt_name, numeric_precision, numeric_scale, is_nullable
FROM information_schema.columns WHERE table_schema = 'public' AND (
  (table_name = 'expense_item_claims' AND column_name IN ('id', 'line_item_id', 'user_id', 'expense_id', 'quantity_claimed', 'amount_owed', 'confirmed', 'claimed_at', 'updated_at'))
  OR (table_name = 'expense_line_items' AND column_name IN ('id', 'expense_id', 'quantity', 'total_amount', 'line_number'))
  OR (table_name = 'expenses' AND column_name IN ('id', 'trip_id', 'paid_by', 'amount', 'currency', 'description', 'status', 'ai_parsed', 'participant_ids'))
  OR (table_name = 'trips' AND column_name = 'settlement_snapshot'))
ORDER BY table_name, column_name;

-- 21c. Constraints, indexes and triggers on the claims and line-item tables.
--      Safe: NO unique index/constraint other than the primary key on expense_item_claims (a person may hold a leftover row and an own row
--      on the same line; the migration's leftover insert fails with a clear message otherwise), no CHECK on quantity_claimed > 0
--      (a leftover row for a value-only remainder can carry 0.00), FKs to expenses/expense_line_items/users (cascade on delete).
SELECT conrelid::regclass AS tbl, conname, contype, pg_get_constraintdef(oid) AS def FROM pg_constraint
WHERE conrelid IN ('public.expense_item_claims'::regclass, 'public.expense_line_items'::regclass) ORDER BY 1, 2;
SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename IN ('expense_item_claims', 'expense_line_items') ORDER BY 1, 2;
-- Unique shape in one line. Safe: zero rows.
SELECT i.indexrelid::regclass FROM pg_index i WHERE i.indrelid = 'public.expense_item_claims'::regclass AND i.indisunique AND NOT i.indisprimary;
-- Triggers. Safe: none on expense_item_claims and expense_line_items (or only updated_at helpers); anything that rewrites amounts or blocks
-- inserts would change what set_receipt_claims writes.
SELECT tgrelid::regclass AS tbl, tgname, tgenabled, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t
WHERE NOT tgisinternal AND tgrelid IN ('public.expense_item_claims'::regclass, 'public.expense_line_items'::regclass, 'public.expenses'::regclass) ORDER BY 1, 2;

-- The foreign key the client now pins in its embeds (expense_item_claims_user_id_fkey). Safe: one row, FOREIGN KEY (user_id) REFERENCES users(id).
SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
WHERE conrelid = 'public.expense_item_claims'::regclass AND conname = 'expense_item_claims_user_id_fkey';
-- The live trigger function auto_update_expense_status: DUMP ITS BODY and read it. It is not defined in the repo. Safe: it is a trigger function
-- that either is not attached to expense_item_claims at all, or only recomputes expenses.status the same way as _receipt_refresh_status (allocated when
-- every line is claimed, else pending_allocation, never touching 'confirmed'). If it is attached to expense_item_claims it fires per row inside the RPCs;
-- the end state is the same as long as it does not use a stricter tolerance than 0.011 (then a legacy-thirds receipt would flip to pending_allocation:
-- cosmetic only, nothing in the ledger reads expenses.status for claims).
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
-- The expense_status enum values. Safe: unallocated, pending_allocation, allocated, confirmed.
SELECT enumlabel FROM pg_enum WHERE enumtypid = 'public.expense_status'::regtype ORDER BY enumsortorder;
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
--      tolerance 0.011, netted per receipt, missing FX in the receipt's own currency, unshared discount lines). Own-currency minor units.
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
         coalesce(sum(CASE WHEN tot < 0 AND nrows = 0 THEN -tot ELSE 0 END), 0) AS open_discount,
         count(*) FILTER (WHERE tot - cm > 0) AS lines_short,
         count(*) FILTER (WHERE cm > tot) AS lines_over,
         count(*) FILTER (WHERE tot < 0) AS negative_lines
  FROM l GROUP BY eid)
SELECT t.name AS trip, t.settlement_snapshot IS NOT NULL AS frozen, e.description, e.currency, e.fx_rate IS NULL AND e.currency <> e.base_currency AS missing_fx,
       r.raw_minor AS flagged_as_written_minor,
       (CASE WHEN least(CASE WHEN e.same_unit THEN r.real_minor ELSE round(r.real_minor / e.pw * e.rate * e.bpw) END,
                        round(e.amount * e.rate * e.bpw) - r.claimed_base) > 0 THEN r.real_minor ELSE 0 END + r.open_discount) AS flagged_with_rule_minor,
       r.open_discount AS open_discount_minor, r.lines_short, r.lines_over, r.negative_lines
FROM e JOIN r ON r.eid = e.id JOIN public.trips t ON t.id = e.trip_id
WHERE r.raw_minor > 0 OR r.lines_over > 0 OR r.negative_lines > 0
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
-- Receipts where a person already has more than one row on the same line (the table allows it; the client reads only the first).
-- Safe: zero rows today.
SELECT line_item_id, user_id, count(*) FROM public.expense_item_claims GROUP BY 1, 2 HAVING count(*) > 1;
-- Who is "tagged" today: itemised receipts with participant_ids NULL/empty fall back to the trip's ACTIVE participants.
SELECT (participant_ids IS NULL OR cardinality(participant_ids) = 0) AS tagged_from_trip_roster, count(*) FROM public.expenses
WHERE coalesce(ai_parsed, false) AND status IS NOT NULL GROUP BY 1;

-- 21h. No long-running transaction touching the claims tables (the migration sets lock_timeout = 5s and fails rather than queueing).
SELECT pid, state, now() - xact_start AS xact_age, left(query, 120) AS query FROM pg_stat_activity
WHERE state <> 'idle' AND pid <> pg_backend_pid() AND (query ILIKE '%expense_item_claims%' OR query ILIKE '%expense_line_items%');

-- 21n. SQL-2: more than one claim row per (line, user) today (the RPCs replace them all; the leftover insert needs no unique key). Safe: zero rows.
SELECT line_item_id, user_id, count(*) FROM public.expense_item_claims GROUP BY 1, 2 HAVING count(*) > 1;
-- 21o. SQL-3: negative or zero lines. Negative lines = discounts/vouchers (an unclaimed one is shared by everyone by share_receipt_leftovers and
--      blocks a freeze until then). Safe: zero rows, or only discount lines on test trips. A zero quantity line is never counted unclaimed.
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
-- 21i. Columns, defaults, constraint. Safe: source text NOT NULL default 'self'::text; created_by uuid nullable; shared_by_all boolean NOT NULL default false;
--      the source CHECK is validated.
SELECT table_name, column_name, data_type, column_default, is_nullable FROM information_schema.columns
WHERE table_schema = 'public' AND ((table_name = 'expense_item_claims' AND column_name IN ('source', 'created_by')) OR (table_name = 'expense_line_items' AND column_name = 'shared_by_all'))
ORDER BY 1, 2;
SELECT conname, convalidated, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'expense_item_claims_source_check';
SELECT source, count(*) FROM public.expense_item_claims GROUP BY 1;   -- Safe: every existing row is 'self'
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
-- 21m. PostgREST sees the new columns and functions (the migration ends with NOTIFY pgrst, 'reload schema').
NOTIFY pgrst, 'reload schema';
