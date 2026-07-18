-- Realtime DELETE fix for trip-scoped subscriptions.
--
-- src/lib/queries/useTripRealtime.ts subscribes each table in
-- DIRECT_TRIP_TABLES with a `trip_id=eq.${tripId}` postgres_changes
-- filter. Realtime evaluates that filter against the event payload, and
-- for DELETE events the payload only contains the table's REPLICA
-- IDENTITY columns -- by default just the primary key. trip_id is
-- therefore absent, the filter never matches, and deletes silently never
-- reach clients: a deleted expense/settlement/etc. stays on every other
-- participant's screen until a manual refetch.
--
-- Fix: REPLICA IDENTITY FULL on exactly the DIRECT_TRIP_TABLES list, so
-- DELETE payloads carry the whole old row (including trip_id) and the
-- filter matches. (INDIRECT_TABLES in the same file subscribe unfiltered,
-- so they are unaffected and are deliberately NOT changed here.)
--
-- Tradeoff, acknowledged: REPLICA IDENTITY FULL writes the entire old row
-- to WAL on every UPDATE/DELETE instead of just the PK (write
-- amplification). These are small, low-churn, per-trip tables (tens to
-- low hundreds of rows each), so the overhead is negligible and worth
-- correct realtime deletes.
--
-- Defensive: table list mirrors the frontend constant at time of writing;
-- each is guarded so a renamed/dropped table doesn't fail the migration.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    -- keep in sync with DIRECT_TRIP_TABLES in src/lib/queries/useTripRealtime.ts
    'trips',
    'trip_participants',
    'planning_sections',
    'expenses',
    'settlements',
    'settlement_carryovers',
    'trip_timeline_events',
    'trip_notes',
    'bookings',
    'places',
    'activity_feed',
    'ai_proposals',
    'trip_checklists',
    'notifications',
    'trip_chat_messages',
    'reactions'
  ]
  LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I REPLICA IDENTITY FULL', t);
    ELSE
      RAISE NOTICE 'replica identity: table public.% not found, skipping', t;
    END IF;
  END LOOP;
END;
$$;
