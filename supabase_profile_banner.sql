-- ClipNow profile banners
-- Run this once in the Supabase SQL Editor.

alter table public.profiles
  add column if not exists banner_url text;

-- Profile banners are stored in the existing public `clips` bucket as:
--   <user-id>/banner.<extension>
-- These policies only allow the signed-in owner to manage their own banner files.

drop policy if exists "ClipNow users can upload profile banners" on storage.objects;
drop policy if exists "ClipNow users can update profile banners" on storage.objects;
drop policy if exists "ClipNow users can delete profile banners" on storage.objects;

create policy "ClipNow users can upload profile banners"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'clips'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
  and (storage.filename(name)) like 'banner.%'
);

create policy "ClipNow users can update profile banners"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'clips'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
  and (storage.filename(name)) like 'banner.%'
)
with check (
  bucket_id = 'clips'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
  and (storage.filename(name)) like 'banner.%'
);

create policy "ClipNow users can delete profile banners"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'clips'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
  and (storage.filename(name)) like 'banner.%'
);
