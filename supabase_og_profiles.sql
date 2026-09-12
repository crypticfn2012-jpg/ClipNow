-- ClipNow OG profile system
-- Run this once in Supabase SQL Editor.
-- Then grant OG status to users manually with the UPDATE shown at the bottom.

alter table public.profiles
  add column if not exists og_member boolean not null default false;

create index if not exists profiles_og_member_idx
  on public.profiles (og_member)
  where og_member = true;

-- Grant OG status to one user:
-- update public.profiles
-- set og_member = true
-- where username = 'THE_USERNAME';

-- Remove OG status:
-- update public.profiles
-- set og_member = false
-- where username = 'THE_USERNAME';
