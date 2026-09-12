-- ClipNow moderation: database-side backstop for usernames, bios, clip text and comments.
-- Run once in the Supabase SQL Editor.
-- Ordinary swearing is intentionally allowed in comments; hard/abusive terms are blocked.

create or replace function public.clipnow_normalize_text(input text)
returns text
language sql
immutable
as $$
  select trim(regexp_replace(
    regexp_replace(
      lower(
        translate(coalesce(input, ''),
          '0134578@$!|',
          'oieastbaaaai')
      ),
      '[^a-z0-9]+', ' ', 'g'
    ),
    '\\s+', ' ', 'g'
  ));
$$;

create or replace function public.clipnow_compact_text(input text)
returns text
language sql
immutable
as $$
  select regexp_replace(public.clipnow_normalize_text(input), '[^a-z0-9]', '', 'g');
$$;

create or replace function public.clipnow_bad_text(input text, strict_username boolean default false)
returns boolean
language plpgsql
immutable
as $$
declare
  normalized text := public.clipnow_normalize_text(input);
  compacted text := public.clipnow_compact_text(input);
  words text[] := array[
    'fuck','fucker','fucking','motherfucker','motherfuck','fck',
    'shithead','bullshit','bitch','bastard','cunt','twat','whore',
    'slut','skank','dickhead','cockhead','pussy','jackass',
    'nigger','nigga','coon','spic','chink','kike','gook','wetback',
    'retard','retarded','tranny','dyke','fag','faggot',
    'porn','porno','pornography','xxx','hentai','blowjob','handjob',
    'cumshot','cum','semen','dildo','vibrator','masturbate','masturbation',
    'orgasm','erection','anal','penetration','sexslave','prostitute',
    'rape','rapist','molest','molester','pedophile','pedo','childporn',
    'gore','guro','dismember','dismembered','beheading','decapitation',
    'snuff','murder','killyourself','kys'
  ];
  word text;
begin
  foreach word in array words loop
    if (' ' || normalized || ' ') like '% ' || word || ' %' then
      return true;
    end if;
    if length(word) >= 5 and compacted like '%' || word || '%' then
      return true;
    end if;
  end loop;

  if strict_username then
    foreach word in array['damn','hell','crap','shit','ass'] loop
      if (' ' || normalized || ' ') like '% ' || word || ' %' then
        return true;
      end if;
    end loop;
  end if;

  return false;
end;
$$;

create or replace function public.clipnow_moderation_trigger()
returns trigger
language plpgsql
as $$
declare
  value text;
begin
  if tg_table_name = 'profiles' then
    value := coalesce(to_jsonb(new)->>'username', '');
    if public.clipnow_bad_text(value, true) then
      raise exception 'This username or handle is not allowed.' using errcode = 'check_violation';
    end if;

    value := coalesce(to_jsonb(new)->>'display_name', '');
    if public.clipnow_bad_text(value, true) then
      raise exception 'This display name is not allowed.' using errcode = 'check_violation';
    end if;

    value := coalesce(to_jsonb(new)->>'bio', '');
    if public.clipnow_bad_text(value, false) then
      raise exception 'This bio contains language that is not allowed.' using errcode = 'check_violation';
    end if;

  elsif tg_table_name = 'clips' then
    value := coalesce(to_jsonb(new)->>'title', '');
    if public.clipnow_bad_text(value, false) then
      raise exception 'This clip title contains language that is not allowed.' using errcode = 'check_violation';
    end if;

    value := coalesce(to_jsonb(new)->>'description', '');
    if public.clipnow_bad_text(value, false) then
      raise exception 'This clip description contains language that is not allowed.' using errcode = 'check_violation';
    end if;

  elsif tg_table_name = 'comments' then
    value := coalesce(to_jsonb(new)->>'content', '');
    if public.clipnow_bad_text(value, false) then
      raise exception 'That comment contains language that is not allowed.' using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists clipnow_profiles_moderation on public.profiles;
create trigger clipnow_profiles_moderation
before insert or update of username, display_name, bio on public.profiles
for each row execute function public.clipnow_moderation_trigger();

drop trigger if exists clipnow_clips_moderation on public.clips;
create trigger clipnow_clips_moderation
before insert or update of title, description on public.clips
for each row execute function public.clipnow_moderation_trigger();

drop trigger if exists clipnow_comments_moderation on public.comments;
create trigger clipnow_comments_moderation
before insert or update of content on public.comments
for each row execute function public.clipnow_moderation_trigger();
