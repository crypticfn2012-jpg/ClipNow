-- ClipNow notifications
-- Run this once in Supabase SQL Editor.
-- Creates notifications for follows, clip likes and comments.

create extension if not exists pgcrypto;

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  actor_id uuid not null references public.profiles(id) on delete cascade,
  type text not null check (type in ('follow', 'like', 'comment')),
  clip_id uuid references public.clips(id) on delete cascade,
  comment_id uuid references public.comments(id) on delete cascade,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index if not exists notifications_recipient_created_idx
  on public.notifications(recipient_id, created_at desc);

create index if not exists notifications_recipient_unread_idx
  on public.notifications(recipient_id, read_at)
  where read_at is null;

grant usage on schema public to anon, authenticated;
grant select, update on public.notifications to authenticated;

alter table public.notifications enable row level security;

drop policy if exists "Users can read their own notifications" on public.notifications;
create policy "Users can read their own notifications"
on public.notifications for select to authenticated
using (recipient_id = auth.uid());

drop policy if exists "Users can mark their own notifications read" on public.notifications;
create policy "Users can mark their own notifications read"
on public.notifications for update to authenticated
using (recipient_id = auth.uid())
with check (recipient_id = auth.uid());

-- Trigger functions use SECURITY DEFINER so users cannot forge notifications
-- or bypass the notification recipient/actor rules.
create or replace function public.create_follow_notification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.follower_id is not null
     and new.following_id is not null
     and new.follower_id <> new.following_id then
    insert into public.notifications (recipient_id, actor_id, type)
    values (new.following_id, new.follower_id, 'follow');
  end if;
  return new;
end;
$$;

drop trigger if exists follows_notification_trigger on public.follows;
create trigger follows_notification_trigger
after insert on public.follows
for each row execute function public.create_follow_notification();

create or replace function public.create_like_notification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  owner_id uuid;
begin
  select user_id into owner_id from public.clips where id = new.clip_id;

  if owner_id is not null and owner_id <> new.user_id then
    insert into public.notifications (recipient_id, actor_id, type, clip_id)
    values (owner_id, new.user_id, 'like', new.clip_id);
  end if;
  return new;
end;
$$;

drop trigger if exists clip_likes_notification_trigger on public.clip_likes;
create trigger clip_likes_notification_trigger
after insert on public.clip_likes
for each row execute function public.create_like_notification();

create or replace function public.create_comment_notification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  owner_id uuid;
begin
  select user_id into owner_id from public.clips where id = new.clip_id;

  if owner_id is not null and owner_id <> new.user_id then
    insert into public.notifications (recipient_id, actor_id, type, clip_id, comment_id)
    values (owner_id, new.user_id, 'comment', new.clip_id, new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists comments_notification_trigger on public.comments;
create trigger comments_notification_trigger
after insert on public.comments
for each row execute function public.create_comment_notification();
