-- Site-wide one-time announcement popups, super-admin controlled.
--
-- site_announcements: an announcement is visible to every authenticated
-- user while now() is inside [starts_at, ends_at].
-- announcement_dismissals: one row per (announcement, user) the moment the
-- user closes the popup -- stored in the DB (not localStorage) so "seen
-- once" holds across devices and sessions.
--
-- RLS: reads of active announcements are open to any authenticated user;
-- writes are restricted to system admins (users.role = 'admin') via the
-- SECURITY DEFINER public.is_admin helper from
-- 20260718134301_restrict_users_payment_details.sql. Admins can also read
-- outside the active window (the admin panel lists scheduled/expired
-- announcements) and read all dismissal rows (dismissal counts). auth.uid()
-- is wrapped in a select subquery per the Supabase performance advisor,
-- matching the existing policies.

CREATE TABLE public.site_announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (char_length(title) <= 200),
  body_md text NOT NULL CHECK (char_length(body_md) <= 5000),
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz NOT NULL,
  created_by uuid NOT NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT site_announcements_window CHECK (ends_at > starts_at)
);

CREATE TABLE public.announcement_dismissals (
  announcement_id uuid NOT NULL REFERENCES public.site_announcements(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  dismissed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (announcement_id, user_id)
);
CREATE INDEX announcement_dismissals_user_id_idx ON public.announcement_dismissals (user_id);

ALTER TABLE public.site_announcements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view live announcements" ON public.site_announcements
  FOR SELECT USING (
    (select auth.uid()) IS NOT NULL
    AND (
      (now() >= starts_at AND now() <= ends_at)
      OR public.is_admin((select auth.uid()))
    )
  );

CREATE POLICY "Admins can create announcements" ON public.site_announcements
  FOR INSERT WITH CHECK (
    public.is_admin((select auth.uid()))
    AND (select auth.uid()) = created_by
  );

CREATE POLICY "Admins can update announcements" ON public.site_announcements
  FOR UPDATE USING (public.is_admin((select auth.uid())))
  WITH CHECK (public.is_admin((select auth.uid())));

CREATE POLICY "Admins can delete announcements" ON public.site_announcements
  FOR DELETE USING (public.is_admin((select auth.uid())));

ALTER TABLE public.announcement_dismissals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own dismissals, admins all" ON public.announcement_dismissals
  FOR SELECT USING (
    (select auth.uid()) = user_id
    OR public.is_admin((select auth.uid()))
  );

CREATE POLICY "Users can record their own dismissal" ON public.announcement_dismissals
  FOR INSERT WITH CHECK ((select auth.uid()) = user_id);
