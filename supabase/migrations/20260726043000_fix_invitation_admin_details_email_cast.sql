-- Fix: auth.users.email is character varying(255), not text, so the
-- previous get_invitation_admin_details() body failed with "structure of
-- query does not match function result type" at call time (caught by the
-- empirical admin-vs-non-admin security test run immediately after
-- 20260726042921_admin_invitation_account_management.sql landed -- the
-- non-admin RAISE path worked correctly, but the admin path itself was
-- broken). Cast explicitly to text to match the declared RETURNS TABLE column.
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
    au.email::text,
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

REVOKE ALL ON FUNCTION public.get_invitation_admin_details() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_invitation_admin_details() TO authenticated;
