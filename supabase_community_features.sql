-- ClipNow community expansion schema
-- Run once in Supabase SQL Editor.

alter table public.profiles add column if not exists verified boolean not null default false;
alter table public.profiles add column if not exists banner_url text;
alter table public.clips add column if not exists tags text[] default '{}'::text[];

alter table public.comments add column if not exists parent_id uuid;

create index if not exists comments_clip_parent_created_idx
on public.comments(clip_id, parent_id, created_at desc);

create table if not exists public.clip_reactions (
  id uuid primary key default gen_random_uuid(),
  clip_id uuid not null references public.clips(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  reaction text not null check (reaction in ('fire','w','lol')),
  created_at timestamptz not null default now(),
  unique (clip_id, user_id)
);
alter table public.clip_reactions enable row level security;
grant select, insert, update, delete on public.clip_reactions to authenticated;
drop policy if exists "Public can read reactions" on public.clip_reactions;
create policy "Public can read reactions" on public.clip_reactions for select to authenticated using (true);
drop policy if exists "Users manage own reactions" on public.clip_reactions;
create policy "Users manage own reactions" on public.clip_reactions for all to authenticated
using (user_id = auth.uid()) with check (user_id = auth.uid());

create table if not exists public.clipnow_events (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  banner_url text,
  start_at timestamptz not null,
  end_at timestamptz not null,
  active boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.clipnow_events enable row level security;
grant select on public.clipnow_events to anon, authenticated;
drop policy if exists "Anyone can view public events" on public.clipnow_events;
create policy "Anyone can view public events" on public.clipnow_events for select using (active = true and now() between start_at and end_at);

-- Add reply notifications alongside the existing notification system.
create or replace function public.create_comment_notification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  owner_id uuid;
  parent_owner_id uuid;
begin
  if new.parent_id is not null then
    select user_id into parent_owner_id from public.comments where id = new.parent_id;
    if parent_owner_id is not null and parent_owner_id <> new.user_id then
      insert into public.notifications (user_id, recipient_id, actor_id, type, clip_id, comment_id)
      values (parent_owner_id, parent_owner_id, new.user_id, 'reply', new.clip_id, new.id);
    end if;
    return new;
  end if;

  select user_id into owner_id from public.clips where id = new.clip_id;
  if owner_id is not null and owner_id <> new.user_id then
    insert into public.notifications (user_id, recipient_id, actor_id, type, clip_id, comment_id)
    values (owner_id, owner_id, new.user_id, 'comment', new.clip_id, new.id);
  end if;
  return new;
end;
$$;
drop trigger if exists comments_notification_trigger on public.comments;
create trigger comments_notification_trigger
after insert on public.comments
for each row execute function public.create_comment_notification();

-- Banner files live in clips/<user-id>/banner.*
drop policy if exists "Authenticated users can upload profile banners" on storage.objects;
create policy "Authenticated users can upload profile banners"
on storage.objects for insert to authenticated
with check (bucket_id='clips' and (storage.foldername(name))[2]='banner' and (storage.foldername(name))[1]=(select auth.uid()::text));
drop policy if exists "Authenticated users can update profile banners" on storage.objects;
create policy "Authenticated users can update profile banners"
on storage.objects for update to authenticated
using (bucket_id='clips' and (storage.foldername(name))[2]='banner' and (storage.foldername(name))[1]=(select auth.uid()::text))
with check (bucket_id='clips' and (storage.foldername(name))[2]='banner' and (storage.foldername(name))[1]=(select auth.uid()::text));
