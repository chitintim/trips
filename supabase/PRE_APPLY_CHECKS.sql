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
