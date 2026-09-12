-- ClipNow notifications
-- Run this once in the Supabase SQL Editor.
-- This migration is safe to run even if an older notifications table already exists.

create extension if not exists pgcrypto;

-- Create the table if it does not exist.
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid,
  actor_id uuid,
  type text,
  clip_id uuid,
  comment_id uuid,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

-- Repair older/incomplete notifications tables by adding the columns the current app needs.
alter table public.notifications add column if not exists recipient_id uuid;
alter table public.notifications add column if not exists actor_id uuid;
alter table public.notifications add column if not exists type text;
alter table public.notifications add column if not exists clip_id uuid;
alter table public.notifications add column if not exists comment_id uuid;
alter table public.notifications add column if not exists created_at timestamptz;
alter table public.notifications add column if not exists read_at timestamptz;

-- Give existing rows a timestamp if an old table had a nullable/missing created_at value.
update public.notifications
set created_at = now()
where created_at is null;

alter table public.notifications alter column created_at set default now();

-- Add foreign keys only when the table does not already have an equivalent constraint.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.notifications'::regclass
      and contype = 'f'
      and pg_get_constraintdef(oid) ilike '%(recipient_id)%'
  ) then
    alter table public.notifications
      add constraint notifications_recipient_id_fkey
      foreign key (recipient_id) references public.profiles(id) on delete cascade;
  end if;
exception when duplicate_object then null;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.notifications'::regclass
      and contype = 'f'
      and pg_get_constraintdef(oid) ilike '%(actor_id)%'
  ) then
    alter table public.notifications
      add constraint notifications_actor_id_fkey
      foreign key (actor_id) references public.profiles(id) on delete cascade;
  end if;
exception when duplicate_object then null;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.notifications'::regclass
      and contype = 'f'
      and pg_get_constraintdef(oid) ilike '%(clip_id)%'
  ) then
    alter table public.notifications
      add constraint notifications_clip_id_fkey
      foreign key (clip_id) references public.clips(id) on delete cascade;
  end if;
exception when duplicate_object then null;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.notifications'::regclass
      and contype = 'f'
      and pg_get_constraintdef(oid) ilike '%(comment_id)%'
  ) then
    alter table public.notifications
      add constraint notifications_comment_id_fkey
      foreign key (comment_id) references public.comments(id) on delete cascade;
  end if;
exception when duplicate_object then null;
end $$;

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

-- Trigger functions use SECURITY DEFINER so users cannot forge notifications.
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
