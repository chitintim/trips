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
