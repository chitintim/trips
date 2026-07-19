-- Realtime: add public.users to the supabase_realtime publication.
--
-- Bug: when a user updates their profile photo (ProfileModal.tsx ->
-- public.users.avatar_url), other logged-in users kept seeing the old
-- avatar because no postgres_changes event was ever fired for `users` --
-- it wasn't on the publication, so useTripRealtime's unfiltered
-- subscription (src/lib/queries/useTripRealtime.ts) never received the
-- UPDATE and never invalidated the cached queries that embed the user row
-- (trip_participants -> user, options -> user, settlements -> user,
-- expenses/claims -> user, trip_notes -> user).
--
-- RLS still applies to realtime changefeeds, so this doesn't broaden who
-- can see a user's row: the existing SELECT policy "Users readable by
-- self, trip co-participants, admins" (see
-- 20260718134301_restrict_users_payment_details.sql) already allows any
-- trip co-participant to read a user's row, which is exactly who needs to
-- see an updated avatar_url. Guarded so re-running (or running against a
-- project where the publication membership already exists) doesn't fail.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'users'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.users;
  END IF;
END;
$$;
