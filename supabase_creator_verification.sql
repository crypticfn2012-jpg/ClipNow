-- ClipNow creator verification
-- Run this once in the Supabase SQL Editor.

alter table public.profiles
  add column if not exists verified boolean not null default false;

create index if not exists profiles_verified_idx
  on public.profiles (verified)
  where verified = true;

-- Grant verification manually as the site owner:
-- update public.profiles set verified = true where username = 'USERNAME';

-- Remove verification:
-- update public.profiles set verified = false where username = 'USERNAME';
