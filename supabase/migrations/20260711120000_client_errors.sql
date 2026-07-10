-- Client-side error telemetry (P0 follow-up, 2026-07-10 incident review):
-- every production bug that night failed SILENTLY -- errors died in users'
-- browser consoles with zero visibility to us. This adds a minimal,
-- self-hosted (no third-party account) error-reporting sink: a
-- write-only-from-the-client table plus a SECURITY DEFINER RPC to insert
-- into it, so the app has an interface (`reportError()` in
-- src/lib/reportError.ts) that could later be pointed at a real APM
-- provider (e.g. Sentry) without changing call sites.
--
-- Pattern mirrors log_invitation_attempt (20260710150000): that migration's
-- comment documents the exact footgun this table would otherwise walk into
-- -- an anon/authenticated INSERT policy with WITH CHECK(true) is fine for
-- a bare `.insert(...)` (supabase-js sends `Prefer: return=minimal` by
-- default when you don't chain `.select()`), but the moment any caller adds
-- `.select()` (return=representation), PostgREST needs a SELECT policy to
-- satisfy the RETURNING check and the insert fails with "new row violates
-- row-level security policy" even though the WITH CHECK on the INSERT
-- itself passed. Routing inserts through a narrow SECURITY DEFINER
-- function sidesteps that interaction entirely: the function runs as the
-- table owner (bypasses RLS), the client only ever calls the RPC (never
-- INSERTs the table directly), and reportError.ts is written to never
-- request the row back anyway. No direct INSERT policy is created for
-- anon/authenticated as a result -- RLS on the table denies all direct
-- writes, which is intentional defense-in-depth.
--
-- ADDITIVE ONLY.
-- ---------------------------------------------------------------------------

CREATE TABLE public.client_errors (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  message text NOT NULL,
  stack text,
  -- Which choke point reported it: 'error-boundary' | 'query-cache' |
  -- 'preload-error' | 'rpc:<fn>' | ... . Free text (not an enum) since new
  -- choke points get added over time and this is a diagnostic log, not a
  -- structural constraint.
  context text,
  -- The SPA route only (e.g. '/trips/abc123'), never the full URL with
  -- query string -- query strings can carry invitation codes / tokens.
  -- reportError.ts strips everything after '?' before sending; `left()`
  -- below is just a size guard, it does not re-derive this from the raw URL.
  url text,
  user_id uuid,
  user_agent text,
  -- No versioning system exists in the app build today (per brief: don't
  -- build one for this) -- left null until/unless a trivial build-time
  -- constant shows up.
  app_version text
);

COMMENT ON TABLE public.client_errors IS 'Self-hosted client-side error telemetry (2026-07-10 incident follow-up). Write-only via public.log_client_error(); readable by admins only.';

ALTER TABLE public.client_errors ENABLE ROW LEVEL SECURITY;

-- No INSERT/UPDATE/DELETE policies for anon/authenticated: all writes go
-- through the SECURITY DEFINER function below, which bypasses RLS as the
-- table owner. Admins get read access, mirroring how invitation_attempts
-- restricts SELECT to `users.role = 'admin'`.
CREATE POLICY "Admins can view client errors"
  ON public.client_errors
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'admin'::public.user_role
    )
  );

-- ---------------------------------------------------------------------------
-- log_client_error: the only write path into client_errors. Truncates
-- message/stack server-side (belt-and-braces alongside client-side caps in
-- reportError.ts) so a pathological error (huge stack, stringified DOM
-- node, etc.) can't bloat the table. Strips any query string from the URL
-- server-side too, in case a future caller bypasses reportError.ts's own
-- stripping.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.log_client_error(
  p_message text,
  p_stack text DEFAULT NULL,
  p_context text DEFAULT NULL,
  p_url text DEFAULT NULL,
  p_user_agent text DEFAULT NULL,
  p_app_version text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.client_errors (
    message, stack, context, url, user_id, user_agent, app_version
  )
  VALUES (
    left(coalesce(p_message, ''), 4000),
    left(p_stack, 4000),
    left(p_context, 200),
    left(split_part(p_url, '?', 1), 500),
    auth.uid(),
    left(p_user_agent, 500),
    left(p_app_version, 100)
  );
EXCEPTION WHEN OTHERS THEN
  -- An error reporter that itself raises is worse than one that silently
  -- no-ops -- reportError.ts already never throws on the client side, and
  -- this mirrors that guarantee at the DB layer so a schema hiccup here
  -- can never surface as a new failure mode for callers.
  NULL;
END;
$$;

COMMENT ON FUNCTION public.log_client_error(text, text, text, text, text, text) IS 'Write-only insert path for client_errors. SECURITY DEFINER so anon/authenticated can log without needing direct table INSERT/SELECT policies (see table comment for why: the RETURNING/RLS interaction that bit log_invitation_attempt).';

GRANT EXECUTE ON FUNCTION public.log_client_error(text, text, text, text, text, text) TO anon, authenticated;
