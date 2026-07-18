-- Function hygiene from the Supabase security advisor:
--
--  1. Pin search_path (= public, pg_temp) on the flagged functions. Their
--     bodies live only on the remote DB (they predate version control), so
--     ALTER FUNCTION -- not CREATE OR REPLACE -- is the correct tool: it
--     changes only the proconfig, never the body. Signatures are likewise
--     unknown, so we resolve every overload of each name from pg_proc and
--     ALTER by regprocedure; missing names are skipped with a NOTICE.
--
--  2. REVOKE EXECUTE from anon on SECURITY DEFINER / privileged RPCs that
--     have no legitimate pre-auth caller. Verified against the frontend:
--     the only RPCs the signup flow calls BEFORE a session exists are
--     validate_invitation_code, get_invitation_preview and
--     log_invitation_attempt (Signup.tsx code-validation step + /join
--     teaser + reportError's log_client_error -- see below), so those keep
--     anon. mark_invitation_used / assign_user_to_trip run inside
--     finalizeAccount()/finalizeSignup.ts, which only executes "once we
--     have an authenticated user", so authenticated suffices.
--     handle_new_user-style auth triggers run as the table owner and need
--     no client grant at all.
--
--     log_client_error is listed by the advisor but KEPT for anon
--     deliberately: src/lib/reportError.ts must be able to report crashes
--     from the login/signup/join pages, which run pre-auth. Revoking anon
--     there would blind us to exactly the incident class (2026-07-10,
--     signup-flow failures) the telemetry was built for.

-- ---------------------------------------------------------------------------
-- 1. Pin search_path on all overloads of each flagged function name.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  fname text;
  fn record;
  found boolean;
BEGIN
  FOREACH fname IN ARRAY ARRAY[
    'check_all_items_claimed',
    'update_trip_participants_updated_at',
    'auto_update_expense_status',
    'get_confirmation_summary',
    'check_conditions_met',
    'get_confirmed_count',
    'enforce_capacity_limit',
    'notify_conditional_users',
    'clear_confirmed_timestamp',
    'create_trip_with_participant',
    'can_view_trip',
    'is_trip_participant',
    'is_trip_organizer',
    'guard_immutable_keys'
  ]
  LOOP
    found := false;
    FOR fn IN
      SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = fname
    LOOP
      EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', fn.sig);
      found := true;
    END LOOP;
    IF NOT found THEN
      RAISE NOTICE 'search_path pin: no function public.%() found, skipping', fname;
    END IF;
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Revoke anon EXECUTE where there is no pre-auth caller.
--    (Grants for authenticated are left exactly as they are.)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  fname text;
  fn record;
BEGIN
  FOREACH fname IN ARRAY ARRAY[
    'create_invitation',
    'create_trip_with_participant',
    'mark_invitation_used',
    'assign_user_to_trip',
    'consume_rate_limit',
    'get_confirmation_summary',
    'get_confirmed_count',
    'check_all_items_claimed',
    'cleanup_expired_invitations',
    'get_recent_failed_attempts'
    -- NOT log_client_error: pre-auth pages report errors through it.
    -- NOT validate_invitation_code / get_invitation_preview /
    --     log_invitation_attempt: the pre-auth signup/join path needs them.
  ]
  LOOP
    FOR fn IN
      SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = fname
    LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn.sig);
    END LOOP;
  END LOOP;
END;
$$;
