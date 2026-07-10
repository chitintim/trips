-- ---------------------------------------------------------------------------
-- Invitation attempt logging via SECURITY DEFINER RPC (P0 follow-up,
-- 2026-07-08 signup incident). Additive only.
--
-- Pattern mirrors validate_invitation_code (20260707110000_security_hardening
-- §3): invitation_attempts is a write-only audit log, and RLS on direct
-- table access has proven fragile (an anon INSERT that also requests
-- return=representation fails with "new row violates row-level security
-- policy" because there is no anon SELECT policy for the RETURNING check,
-- even though the WITH CHECK(true) INSERT policy itself is permissive).
-- Signup.tsx never requested return=representation so this specific gap
-- wasn't silently dropping rows, but routing the insert through a narrow
-- SECURITY DEFINER function removes the RLS/RETURNING interaction as a
-- footgun entirely and gives the client a real success/failure signal to
-- log instead of an unchecked fire-and-forget insert.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.log_invitation_attempt(p_code text, p_success boolean, p_user_agent text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.invitation_attempts (code_attempted, success, user_agent)
  VALUES (p_code, p_success, p_user_agent);
  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.log_invitation_attempt(text, boolean, text) TO anon, authenticated;
