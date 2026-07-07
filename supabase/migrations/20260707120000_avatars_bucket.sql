-- Avatar system v2 (UX_REDESIGN.md "Avatar system v2"): public-read `avatars`
-- storage bucket for user-uploaded profile photos. Additive only -- existing
-- `users.avatar_url` / `users.avatar_data` columns are untouched, and no
-- existing data is migrated. Modeled on the (pre-existing, not
-- migration-tracked) private `receipts` bucket's per-user-folder convention,
-- but public-read since avatars are shown throughout the UI to other trip
-- members without needing signed URLs.

-- ---------------------------------------------------------------------------
-- 1. Bucket: public read, small size cap (client compresses to <=200KB
--    before upload, but cap generously above that to tolerate future
--    changes without a migration), images only.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars',
  'avatars',
  true,
  2097152, -- 2MB
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. RLS on storage.objects for this bucket: every object must live under
--    `{uid}/...` -- authenticated users may only write/update/delete within
--    their own folder (matched via storage.foldername, which splits the
--    object path on `/`; the first segment must equal their own auth.uid()).
--    Public/anon read is bucket-wide (avatars are meant to be visible to
--    other trip members and unauthenticated shared-link viewers alike).
-- ---------------------------------------------------------------------------

drop policy if exists "Avatar images are publicly readable" on storage.objects;
create policy "Avatar images are publicly readable"
on storage.objects for select
to public
using (bucket_id = 'avatars');

drop policy if exists "Users can upload their own avatar" on storage.objects;
create policy "Users can upload their own avatar"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Users can update their own avatar" on storage.objects;
create policy "Users can update their own avatar"
on storage.objects for update
to authenticated
using (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Users can delete their own avatar" on storage.objects;
create policy "Users can delete their own avatar"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);
