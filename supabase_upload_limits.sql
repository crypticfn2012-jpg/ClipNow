-- ClipNow upload limit
-- Run once in Supabase SQL Editor.
-- Sets the clips storage bucket to 200 MiB per file.
-- 200 MiB = 209715200 bytes.

update storage.buckets
set file_size_limit = 209715200
where id = 'clips';
