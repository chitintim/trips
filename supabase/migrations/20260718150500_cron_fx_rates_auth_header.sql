-- Fix: pg_cron job "refresh-fx-rates-daily" was invoking the refresh-fx-rates
-- edge function with no Authorization header at all. PR #3 (20260718134417
-- function_hygiene / verify_jwt hardening) set verify_jwt = true on this
-- function, which made every cron-triggered POST 401 (confirmed in
-- edge-function logs: "POST | 401 | .../refresh-fx-rates").
--
-- This job predates migrations tracking (it was created directly against the
-- live project, not via a migration file), so there was nothing here to
-- amend -- this migration both documents and re-asserts the fix.
--
-- Fix: send the anon key as a Bearer token. verify_jwt only checks that the
-- Authorization header carries a JWT signed with the project's JWT secret;
-- it does not require service_role specifically, and the anon key is such a
-- JWT. This avoids storing the more sensitive service_role key in a cron
-- job body. The function itself only reads market FX rates and writes to
-- fx_rates using the service role client internally, so anon-level request
-- auth is sufficient here.
select cron.alter_job(
  (select jobid from cron.job where jobname = 'refresh-fx-rates-daily'),
  command := $$
  SELECT net.http_post(
    url := 'https://vrmhwfrpdaiovulornli.supabase.co/functions/v1/refresh-fx-rates',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZybWh3ZnJwZGFpb3Z1bG9ybmxpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjE5MjUyOTAsImV4cCI6MjA3NzUwMTI5MH0.dFHnMcvA6OTCAePm7Zja6pl0Cj1p_C6B6NmP85F2jMo"}'::jsonb,
    body := '{}'::jsonb
  ) AS request_id;
  $$
);
