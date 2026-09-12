-- ClipNow profile links
-- Run once in the Supabase SQL Editor.

alter table public.profiles
  add column if not exists youtube_url text,
  add column if not exists x_url text,
  add column if not exists instagram_url text,
  add column if not exists tiktok_url text,
  add column if not exists twitch_url text,
  add column if not exists discord_url text,
  add column if not exists github_url text,
  add column if not exists kick_url text,
  add column if not exists custom_link_url text,
  add column if not exists custom_link_label text;
