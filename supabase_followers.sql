-- ClipNow public followers / following
-- Run this once in the Supabase SQL Editor for the ClipNow project.

create table if not exists public.follows (
  follower_id uuid not null references auth.users(id) on delete cascade,
  following_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, following_id),
  constraint follows_no_self_follow check (follower_id <> following_id)
);

create index if not exists follows_following_id_idx on public.follows(following_id);
create index if not exists follows_follower_id_idx on public.follows(follower_id);

alter table public.follows enable row level security;

drop policy if exists "Public can view follows" on public.follows;
create policy "Public can view follows"
on public.follows for select
using (true);

drop policy if exists "Users can follow" on public.follows;
create policy "Users can follow"
on public.follows for insert
to authenticated
with check (auth.uid() = follower_id and follower_id <> following_id);

drop policy if exists "Users can unfollow" on public.follows;
create policy "Users can unfollow"
on public.follows for delete
to authenticated
using (auth.uid() = follower_id);

-- Optional but useful for fast counts on larger sites.
create index if not exists follows_created_at_idx on public.follows(created_at desc);
