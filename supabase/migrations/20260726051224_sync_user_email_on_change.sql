-- Self-service email change (ProfileModal): supabase.auth.updateUser({email})
-- sends a verification link and does NOT touch auth.users.email until the
-- user confirms (secure email change may require confirming from BOTH the
-- old and new address, depending on project auth settings). public.users.email
-- must catch up once auth.users.email actually changes -- otherwise we
-- recreate the exact split-brain (public.users shows the new address, login
-- silently still uses the old one) diagnosed in
-- 20260726042921_admin_invitation_account_management.sql's motivating case.
--
-- The existing on_user_email_confirmed trigger does NOT cover this: its WHEN
-- clause (NEW.email_confirmed_at IS NOT NULL AND OLD.email_confirmed_at IS
-- NULL) only fires on the transition out of an unconfirmed account, i.e. once
-- ever, at signup. A later email change on an already-confirmed account never
-- re-nulls email_confirmed_at, so that trigger cannot fire again -- confirmed
-- by inspecting its definition and auth.users' trigger list live.
--
-- Fix: a second, independent trigger keyed on auth.users.email itself
-- changing (not on email_confirmed_at), so it fires exactly once, at the
-- moment GoTrue finally writes the new address after confirmation -- whether
-- that change came from the self-service flow above OR the admin Auth Admin
-- API email-correction path (both perform a real UPDATE on auth.users, so
-- both are covered by the same mechanism; self-healing for all users, not
-- just the ones who happen to reload the app at the right time). Idempotent:
-- the WHERE guard makes a duplicate/replayed fire a no-op, and public.users.
-- updated_at is bumped by the table's existing set_updated_at trigger, not
-- here.
CREATE OR REPLACE FUNCTION public.handle_user_email_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    UPDATE public.users
    SET email = NEW.email
    WHERE id = NEW.id
      AND email IS DISTINCT FROM NEW.email;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.handle_user_email_changed() IS 'Keeps public.users.email in sync whenever auth.users.email actually changes (post-confirmation email changes, or admin corrections) -- never at request time, only once GoTrue has committed the new address. Idempotent.';

DROP TRIGGER IF EXISTS on_user_email_changed ON auth.users;
CREATE TRIGGER on_user_email_changed
  AFTER UPDATE ON auth.users
  FOR EACH ROW
  WHEN (NEW.email IS DISTINCT FROM OLD.email)
  EXECUTE FUNCTION public.handle_user_email_changed();
