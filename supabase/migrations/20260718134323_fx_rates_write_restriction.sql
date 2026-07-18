-- fx_rates write restriction (audit M-4 follow-up; 20260707110000 §5 only
-- bounded the values with a CHECK, leaving the write path open).
--
-- Chosen design: KEEP INSERT for authenticated, DROP UPDATE (and DELETE).
-- Rationale: the client is an active writer -- storeDbRate() in
-- src/lib/currency.ts upserts freshly fetched frankfurter rates as the
-- signed-in user (cache-fill), and src/lib/fx/fetchRate.ts's optional db
-- accessor does the same. Removing INSERT entirely would silently kill the
-- shared DB rate cache for all users. What actually matters for integrity
-- is that an authenticated user cannot CLOBBER an existing rate other
-- users rely on: with UPDATE dropped, a row, once written, is immutable to
-- clients; only the service role (refresh-fx-rates edge function, which
-- bypasses RLS) can correct or overwrite rates.
--
-- Client impact: storeDbRate() uses upsert(onConflict). When no row exists
-- the INSERT succeeds as before; when a row already exists the ON CONFLICT
-- DO UPDATE arm is now denied and the upsert errors -- storeDbRate already
-- swallows this (logs via console.error, fire-and-forget, never throws),
-- and the row it "failed" to write already exists, so behavior is
-- unchanged. No src change required.
--
-- Policy names predate version control -> catalog-driven drops, then
-- recreate the intended set by well-known names.

DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN
    SELECT policyname, cmd
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'fx_rates'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.fx_rates', pol.policyname);
  END LOOP;
END;
$$;

-- Reads: any signed-in user (rates are not sensitive; anon has no need).
CREATE POLICY "Authenticated users can read fx rates"
  ON public.fx_rates
  FOR SELECT
  TO authenticated
  USING (true);

-- Cache-fill: signed-in users may add NEW rate rows (bounded by the
-- fx_rates_rate_positive CHECK from 20260707110000). No UPDATE / DELETE
-- policy exists after this migration: existing rows are immutable to
-- clients; corrections go through the service role, which bypasses RLS.
CREATE POLICY "Authenticated users can insert fx rates"
  ON public.fx_rates
  FOR INSERT
  TO authenticated
  WITH CHECK (true);
