-- ClipNow thumbnail storage policy
-- Run this once in the Supabase SQL Editor.
-- This only fixes thumbnail uploads. It does not change clip uploads.

create policy "Authenticated users can upload clip thumbnails"
on storage.objects
for insert to authenticated
with check (
  bucket_id = 'clips'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
  and (storage.foldername(name))[2] = 'thumbs'
);

create policy "Authenticated users can update clip thumbnails"
on storage.objects
for update to authenticated
using (
  bucket_id = 'clips'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
  and (storage.foldername(name))[2] = 'thumbs'
)
with check (
  bucket_id = 'clips'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
  and (storage.foldername(name))[2] = 'thumbs'
);
