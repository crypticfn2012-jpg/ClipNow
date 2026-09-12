-- ClipNow upload limit
-- Run once in Supabase SQL Editor.
-- Supabase Free projects have a 50 MB global file-size limit.
-- Keep the clips bucket at the same 50 MiB maximum.

update storage.buckets
set file_size_limit = 52428800
where id = 'clips';
