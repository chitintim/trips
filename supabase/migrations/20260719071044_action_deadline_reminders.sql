-- Action-deadline reminders (staged ladder) + auto-chase cron registration.
--
-- 1. trip_action_reminders: once-per-stage sent-state for the reminder
--    ladder in the auto-chase edge function (section 1b). Each open
--    trip_action earns a user at most three reminder emails -- 'd7' (~7
--    days before the effective due date), 'd1' (~1 day before) and
--    'overdue' (once the due day has elapsed) -- and this table's primary
--    key is what makes "at most once per (action, user, stage)" true even
--    across concurrent/duplicate runs. Rows are written exclusively by the
--    service role AFTER a successful email send (skipped/failed digests
--    retry the next day). Participants may read them (the UI can show
--    "reminded on ..."), nobody but the service role writes.
--
-- 2. app_secrets: tiny service-role-only key/value store, created for the
--    auto-chase cron credential. The pg_cron job cannot present the
--    service-role key (storing it in the job body was ruled out in
--    20260718150500_cron_fx_rates_auth_header.sql, and this repo is
--    public), so instead: the job sends the anon key as its bearer (which
--    satisfies the platform's verify_jwt gate, same as the FX job) plus an
--    x-cron-secret header it reads from this table at fire time. The
--    edge function compares that header against the same row via its
--    service-role client. The secret value is generated INSIDE this
--    migration (two gen_random_uuid()s, strong RNG), so it exists only in
--    the database -- it never appears in the repo or the migration file.
--    RLS is enabled with no policies and anon/authenticated are revoked:
--    only the postgres/cron side and the service role can read it.
--
-- 3. Cron: 'auto-chase-daily' fires the auto-chase edge function once a
--    day at 09:00 UTC (morning across Europe; one digest per user per day
--    is enforced function-side). Note the FX job precedent
--    ('refresh-fx-rates-daily') predated migrations tracking; this one is
--    created here so the schedule IS reproducible from the repo.

-- ---- 1. trip_action_reminders ----

CREATE TABLE IF NOT EXISTS public.trip_action_reminders (
  action_id uuid NOT NULL REFERENCES public.trip_actions(id) ON DELETE CASCADE,
  trip_id uuid NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  stage text NOT NULL CHECK (stage IN ('d7', 'd1', 'overdue')),
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (action_id, user_id, stage)
);
CREATE INDEX IF NOT EXISTS trip_action_reminders_trip_id_idx
  ON public.trip_action_reminders (trip_id);

COMMENT ON TABLE public.trip_action_reminders IS
  'Sent-state for staged action-deadline reminder emails (d7/d1/overdue). Written only by the auto-chase edge function (service role) after a successful send; the PK enforces once per (action, user, stage).';

ALTER TABLE public.trip_action_reminders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Participants can view trip action reminders" ON public.trip_action_reminders
  FOR SELECT USING (public.can_view_trip(trip_id, (select auth.uid())));
-- No INSERT/UPDATE/DELETE policies: service role only.

-- ---- 2. app_secrets + the cron secret ----

CREATE TABLE IF NOT EXISTS public.app_secrets (
  name text PRIMARY KEY,
  value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.app_secrets IS
  'Service-role-only key/value store for internal shared secrets (currently the auto-chase cron credential). RLS on, zero policies, anon/authenticated revoked -- reachable only by the service role and by pg_cron running as the table owner.';

ALTER TABLE public.app_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_secrets FROM anon, authenticated;

-- Generate the secret server-side so it never leaves the database.
INSERT INTO public.app_secrets (name, value)
VALUES (
  'auto_chase_cron_secret',
  replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
)
ON CONFLICT (name) DO NOTHING;

-- ---- 3. Daily cron job ----
-- Bearer = the project's anon key (public by design -- it already appears in
-- 20260718150500_cron_fx_rates_auth_header.sql and in every client bundle);
-- it exists solely to satisfy verify_jwt. Authorization proper is the
-- x-cron-secret header, resolved from app_secrets at fire time.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'auto-chase-daily') THEN
    PERFORM cron.unschedule('auto-chase-daily');
  END IF;
END;
$$;

SELECT cron.schedule(
  'auto-chase-daily',
  '0 9 * * *',
  $cmd$
  SELECT net.http_post(
    url := 'https://vrmhwfrpdaiovulornli.supabase.co/functions/v1/auto-chase',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZybWh3ZnJwZGFpb3Z1bG9ybmxpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjE5MjUyOTAsImV4cCI6MjA3NzUwMTI5MH0.dFHnMcvA6OTCAePm7Zja6pl0Cj1p_C6B6NmP85F2jMo',
      'x-cron-secret', (SELECT value FROM public.app_secrets WHERE name = 'auto_chase_cron_secret')
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $cmd$
);
