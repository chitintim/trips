-- Site-admin visibility into invitation -> account outcomes, plus an audit
-- trail for admin-initiated account mutations (resend confirmation, email
-- correction, manual confirm, name fix). Motivated by a real support case:
-- a signup with a typo'd email (chrisceungsc123@gmail.com) never confirmed
-- and the admin had no way to see why from the Invitations page, or fix it
-- without disturbing the account's trip data (trip_participants,
-- trip_actions.assigned_to, votes, completions, avatar all key off the SAME
-- auth user id, so email corrections must never change that id).
--
-- auth.users is not exposed via PostgREST, so reads go through a
-- SECURITY DEFINER RPC (get_invitation_admin_details) that hard-checks
-- is_admin(auth.uid()) INSIDE the function body (RAISE EXCEPTION for
-- non-admins, not just a row filter) and returns only the columns the admin
-- panel needs -- never password hashes, tokens, or raw_user_meta_data.
--
-- Mutations need the Auth Admin API (service-role key), which only an edge
-- function can hold -- see supabase/functions/admin-invitation-account.
-- That function re-checks is_admin() server-side (via this same RPC) before
-- touching anything -- it never trusts a client-supplied admin flag -- and
-- logs every action to admin_audit_log below.

-- ---------------------------------------------------------------------------
-- 1. Audit trail: minimal, admin-only via RLS. Written exclusively by the
--    admin-invitation-account edge function's service-role client (which
--    bypasses RLS), so there is deliberately no INSERT policy for
--    authenticated/anon -- only SELECT, for admins to review the log.
-- ---------------------------------------------------------------------------
CREATE TABLE public.admin_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES public.users(id),
  action text NOT NULL,
  target_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  target_invitation_id uuid REFERENCES public.invitations(id) ON DELETE SET NULL,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX admin_audit_log_target_user_id_idx ON public.admin_audit_log (target_user_id);
CREATE INDEX admin_audit_log_created_at_idx ON public.admin_audit_log (created_at DESC);

ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view the audit log" ON public.admin_audit_log
  FOR SELECT
  TO authenticated
  USING (public.is_admin((select auth.uid())));

COMMENT ON TABLE public.admin_audit_log IS 'Minimal admin-action audit trail (who did what to whom, when). Written only by service-role edge functions (RLS has no INSERT policy for authenticated/anon); readable by admins only.';

-- ---------------------------------------------------------------------------
-- 2. Read RPC: invitation -> account outcome, admin-only.
--    auth.users/public.users/public.invitations are schema-qualified
--    throughout rather than relying on search_path to resolve them; SET
--    search_path still pins the function against search_path hijacking,
--    per the function-hygiene convention (20260718134417_function_hygiene.sql).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_invitation_admin_details()
RETURNS TABLE (
  invitation_id uuid,
  code text,
  trip_id uuid,
  status public.invitation_status,
  max_uses integer,
  current_uses integer,
  expires_at timestamptz,
  invitation_created_at timestamptz,
  used_at timestamptz,
  account_user_id uuid,
  account_full_name text,
  account_email text,
  account_created_at timestamptz,
  account_email_confirmed_at timestamptz,
  account_last_sign_in_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Only admins can view invitation account details';
  END IF;

  RETURN QUERY
  SELECT
    i.id,
    i.code,
    i.trip_id,
    i.status,
    i.max_uses,
    i.current_uses,
    i.expires_at,
    i.created_at,
    i.used_at,
    pu.id,
    pu.full_name,
    au.email,
    au.created_at,
    au.email_confirmed_at,
    au.last_sign_in_at
  FROM public.invitations i
  LEFT JOIN public.users pu ON pu.id = i.used_by
  LEFT JOIN auth.users au ON au.id = i.used_by
  ORDER BY i.created_at DESC;
END;
$$;

COMMENT ON FUNCTION public.get_invitation_admin_details() IS 'Admin-only (is_admin hard-checked inside, RAISEs for non-admins): invitation status joined to the auth.users/public.users account it produced, for the site-admin Invitations page. Never exposes password hashes, tokens or raw_user_meta_data.';

-- Functions get an implicit EXECUTE grant to PUBLIC on creation in Postgres
-- (unlike tables) -- REVOKE FROM PUBLIC is required to actually close it off,
-- not just REVOKE FROM anon (anon would otherwise still inherit EXECUTE via
-- the PUBLIC grant). The in-function is_admin() RAISE is the real gate;
-- this grant tightening is defense in depth.
REVOKE ALL ON FUNCTION public.get_invitation_admin_details() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_invitation_admin_details() TO authenticated;
