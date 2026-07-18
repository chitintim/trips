-- invitation_attempts hardening (H-1 residue). Two parts:
--
--  1. Drop any direct INSERT policy on public.invitation_attempts. Since
--     20260710150000_log_invitation_attempt.sql all legitimate writes go
--     through the SECURITY DEFINER log_invitation_attempt() RPC (which
--     bypasses RLS as table owner), so a permissive table-level INSERT
--     policy is pure attack surface: anyone with the anon key could spam
--     the audit log directly, with arbitrary-length payloads. Policy names
--     predate version control, so drop is catalog-driven.
--
--  2. Harden log_invitation_attempt() itself:
--       - truncate p_code to 64 chars and p_user_agent to 512 chars
--         (truncate, not reject -- the caller treats this as
--         fire-and-forget and must never see a new failure mode);
--       - per-IP throttle: silently no-op once the same ip_address has
--         logged > 20 rows in the last hour. Silent (still returns true)
--         so the throttle is not an oracle a prober can observe.
--
-- IP caveat: ip_address is populated by the table's column default (the
-- RPC never sets it), and behind PostgREST/the pooler inet_client_addr()
-- may resolve to the pooler's address rather than the end client. If that
-- happens the throttle degrades to a coarse global cap of ~20 logged
-- attempts/hour, which is still an acceptable bound for a security audit
-- log (get_recent_failed_attempts alerts on > 2 attempts per code anyway).
-- NULL ip buckets together via IS NOT DISTINCT FROM.

-- ---------------------------------------------------------------------------
-- 1. No direct INSERT path (defense-in-depth mirror of client_errors).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'invitation_attempts'
      AND cmd = 'INSERT'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.invitation_attempts', pol.policyname);
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Length caps + per-IP throttle in the RPC.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.log_invitation_attempt(p_code text, p_success boolean, p_user_agent text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ip inet := inet_client_addr();
  v_recent bigint;
BEGIN
  -- Throttle: > 20 rows from this ip_address in the last hour -> silent
  -- no-op. Returning true keeps the response indistinguishable from a
  -- logged attempt (no oracle) and keeps the client fire-and-forget.
  SELECT count(*) INTO v_recent
  FROM public.invitation_attempts
  WHERE ip_address IS NOT DISTINCT FROM v_ip
    AND created_at > now() - interval '1 hour';

  IF v_recent > 20 THEN
    RETURN true;
  END IF;

  INSERT INTO public.invitation_attempts (code_attempted, success, user_agent)
  VALUES (left(p_code, 64), p_success, left(p_user_agent, 512));
  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.log_invitation_attempt(text, boolean, text) TO anon, authenticated;
