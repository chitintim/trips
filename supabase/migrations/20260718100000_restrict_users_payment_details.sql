-- Restrict SELECT on public.users (audit M-1): the table previously carried
-- an open `USING (true)` SELECT policy, which exposed payment_details
-- (bank / PayNow / Wise handles) to every authenticated session regardless
-- of whether the caller had any relationship to the row's owner.
--
-- The app's legitimate read paths are:
--   (a) self  -- ProfileModal, useCurrentUserRow, finalizeSignup read/update
--       the caller's own row;
--   (b) trip co-participants -- the participants join in useTrip.ts embeds
--       users(*) including payment_details, and SettleUpTab shows the
--       payee's payment rails to whoever owes them (both are always in the
--       same trip);
--   (c) admins -- AdminUsersTab (Dashboard) lists all users.
--
-- So the new policy is: self OR shares-a-trip OR admin. Both conditions
-- that would otherwise re-query RLS-protected tables go through
-- SECURITY DEFINER helpers with a pinned search_path, following the
-- is_trip_participant pattern -- a plain EXISTS in a users policy that
-- itself reads public.users (admin check) or trip_participants (whose own
-- policies read users) is exactly the recursion shape that has bitten this
-- schema before.
--
-- The base policies predate version control, so we do not assume policy
-- names: every existing SELECT policy on public.users is dropped by a
-- catalog-driven DO block before the replacement is created. UPDATE /
-- INSERT / DELETE policies are left untouched.

-- ---------------------------------------------------------------------------
-- 1. Helpers (SECURITY DEFINER so they bypass RLS and cannot recurse).
-- ---------------------------------------------------------------------------

-- True when the caller's own users row has role = 'admin'. SECURITY DEFINER
-- is what makes this safe to call from a policy ON public.users itself.
CREATE OR REPLACE FUNCTION public.is_admin(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = p_user_id AND role = 'admin'::public.user_role
  );
$$;

COMMENT ON FUNCTION public.is_admin(uuid) IS 'SECURITY DEFINER admin check, safe to use inside policies on public.users without RLS recursion.';

-- True when the caller (auth.uid()) shares at least one trip with
-- p_other_user. Used to let co-participants read each other''s profile row
-- (display fields + payment_details for settle-up).
CREATE OR REPLACE FUNCTION public.shares_trip_with(p_other_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.trip_participants mine
    JOIN public.trip_participants theirs
      ON theirs.trip_id = mine.trip_id
    WHERE mine.user_id = auth.uid()
      AND theirs.user_id = p_other_user
  );
$$;

COMMENT ON FUNCTION public.shares_trip_with(uuid) IS 'SECURITY DEFINER: does the current user share any trip with p_other_user? Backs the users SELECT policy (audit M-1).';

-- Policy helpers only; no reason for direct anon access.
REVOKE ALL ON FUNCTION public.is_admin(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.shares_trip_with(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.is_admin(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.shares_trip_with(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Drop every existing SELECT policy on public.users (names unknown --
--    the base schema predates version control), then install the scoped one.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'users' AND cmd = 'SELECT'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.users', pol.policyname);
  END LOOP;
END;
$$;

-- TO authenticated: anon sessions get no SELECT path at all (signup-time
-- code goes through SECURITY DEFINER RPCs / the handle_new_user trigger,
-- neither of which needs an anon policy).
CREATE POLICY "Users readable by self, trip co-participants, admins"
  ON public.users
  FOR SELECT
  TO authenticated
  USING (
    id = auth.uid()
    OR public.shares_trip_with(id)
    OR public.is_admin(auth.uid())
  );
