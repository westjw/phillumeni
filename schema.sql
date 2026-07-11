-- phillumeni database schema
-- Paste this entire file into Supabase SQL Editor and click Run
--
-- ZERO-SEED BY DESIGN (spec §0): do NOT run seed.sql. Every venue must enter
-- through the real Submit flow. A fresh, empty map is the correct day-one state.

-- ─── PROFILES ───────────────────────────────────────────
create table profiles (
  id uuid references auth.users(id) on delete cascade primary key,
  username text unique,
  display_name text,
  bio text,
  home_city text default 'NYC',
  is_admin boolean default false,        -- gates the moderation screens
  referred_by text,                      -- user id whose invite link they joined through
  avatar_url text,                       -- profile picture (matchbooks bucket, public)
  created_at timestamptz default now()
);

alter table profiles enable row level security;

create policy "Users can view their own profile"
  on profiles for select using (auth.uid() = id);

create policy "Users can update their own profile"
  on profiles for update using (auth.uid() = id);

-- SECURITY: the policy restricts the ROW (your own); this column-scoped grant
-- restricts the COLUMNS. is_admin + id are deliberately excluded so a user can
-- never self-promote to admin from the client. username is excluded too (017):
-- it's now a hidden internal key, not user-writable — identity is display_name.
revoke update on profiles from authenticated;
grant update (display_name, bio, home_city, referred_by, avatar_url)
  on profiles to authenticated;

create policy "Users can insert their own profile"
  on profiles for insert with check (auth.uid() = id);

-- Admins can read every profile (resolves usernames in the moderation queue).
-- Uses a SECURITY DEFINER function so the policy can't recurse on profiles.
create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

create policy "Admins can view all profiles"
  on profiles for select using (public.is_admin());

-- Auto-create profile on signup.
-- Must NEVER abort the auth.users insert: a username collision is resolved by
-- suffixing rather than raising. search_path is pinned and names are qualified
-- (Supabase linter: function_search_path_mutable).
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  base_username text;
  final_username text;
  n int := 0;
begin
  base_username := coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1));
  final_username := base_username;
  while exists (select 1 from public.profiles where username = final_username) loop
    n := n + 1;
    final_username := base_username || n::text;
  end loop;
  begin
    insert into public.profiles (id, username, display_name)
    values (new.id, final_username, coalesce(new.raw_user_meta_data->>'display_name', base_username));
  exception when unique_violation then
    -- last-resort uniqueness; never block account creation on a race
    insert into public.profiles (id, username, display_name)
    values (new.id, base_username || '_' || substr(new.id::text, 1, 8), base_username)
    on conflict (id) do nothing;
  end;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ─── VENUES ─────────────────────────────────────────────
create table venues (
  id serial primary key,
  name text not null,
  address text not null,
  neighborhood text,
  city text not null default 'NYC',
  type text,
  emoji text default '🔥',
  bg_color text default '#1A1A1A',
  sources text[] default '{}',
  note text,
  is_open boolean default true,
  hours_text text,
  lat decimal(10,8) not null,
  lng decimal(11,8) not null,
  created_at timestamptz default now(),
  created_by uuid references auth.users(id),
  verified boolean default false,
  mapbox_id text unique,                 -- stable Search Box POI id (dedup key)
  status text not null default 'active' check (status in ('active','closed')),
  closed_at timestamptz,
  added_manually boolean default false   -- via the "can't find it" manual entry
);

alter table venues enable row level security;

create policy "Venues are viewable by everyone"
  on venues for select using (true);

-- Insert is constrained: created_by must be the caller (no impersonation) and
-- verified cannot be self-set true (no forged trust badge).
create policy "Authenticated users can insert venues"
  on venues for insert with check (auth.uid() = created_by and verified is not true);

-- Creators may delete their own not-yet-verified venues (spam/typo cleanup).
create policy "Users can delete their own unverified venues"
  on venues for delete using (auth.uid() = created_by and verified is not true);

-- ─── COLLECTIONS ────────────────────────────────────────
create table collections (
  id serial primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  venue_id integer references venues(id) on delete cascade not null,
  photo_url text,                         -- cover photo (= photos[0])
  photos text[] not null default '{}',    -- all matchbook photos
  score numeric(3,1),                     -- per-user Elo ranking (0.0–10.0)
  collected_at timestamptz default now(),
  unique(user_id, venue_id)
);

alter table collections enable row level security;

create policy "Users can view their own collections"
  on collections for select using (auth.uid() = user_id);

create policy "Users can manage their own collections"
  on collections for insert with check (auth.uid() = user_id);

-- Ranking (Elo score) and the multi-photo re-collect path both UPDATE the
-- user's own collection rows — without this policy those writes silently no-op.
create policy "Users can update their own collections"
  on collections for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "Users can delete their own collections"
  on collections for delete using (auth.uid() = user_id);

-- ─── REPORTS (not available) ─────────────────────────────
create table reports (
  id serial primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  venue_id integer references venues(id) on delete cascade not null,
  created_at timestamptz default now(),
  unique(user_id, venue_id)
);

alter table reports enable row level security;

create policy "Users can view their own reports"
  on reports for select using (auth.uid() = user_id);

create policy "Authenticated users can report"
  on reports for insert with check (auth.uid() = user_id);

-- Auto-close a venue once enough DISTINCT users report it unavailable.
-- reports has unique(user_id, venue_id), so count(*) = distinct reporters.
-- SECURITY DEFINER updates venues with no client-facing UPDATE policy.
create or replace function close_venue_if_reported()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  reporter_count int;
  threshold constant int := 3;
begin
  select count(*) into reporter_count from public.reports where venue_id = new.venue_id;
  if reporter_count >= threshold then
    update public.venues
      set status = 'closed', closed_at = coalesce(closed_at, now())
      where id = new.venue_id and status <> 'closed';
  end if;
  return new;
end;
$$;

create trigger on_report_close_check
  after insert on reports
  for each row execute function close_venue_if_reported();

-- ─── FOLLOWS ────────────────────────────────────────────
create table follows (
  follower_id uuid references auth.users(id) on delete cascade,
  following_id uuid references auth.users(id) on delete cascade,
  created_at timestamptz default now(),
  primary key (follower_id, following_id)
);

alter table follows enable row level security;

create policy "Users can view their own follows"
  on follows for select using (auth.uid() = follower_id or auth.uid() = following_id);

create policy "Users manage their own follows"
  on follows for insert with check (auth.uid() = follower_id);

create policy "Users can unfollow"
  on follows for delete using (auth.uid() = follower_id);

-- ─── COMPARISONS (ranking audit log) ─────────────────────
create table comparisons (
  id serial primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  winner_venue_id integer references venues(id) on delete cascade not null,
  loser_venue_id integer references venues(id) on delete cascade not null,
  created_at timestamptz default now()
);
alter table comparisons enable row level security;
create policy "Users can view their own comparisons"
  on comparisons for select using (auth.uid() = user_id);
create policy "Users can log their own comparisons"
  on comparisons for insert with check (auth.uid() = user_id);

-- ─── FAKE REPORTS (fraud claims → human review) ──────────
create table fake_reports (
  id serial primary key,
  reporter_id uuid references auth.users(id) on delete cascade not null,
  venue_id integer references venues(id) on delete cascade not null,
  reason text,
  status text not null default 'pending' check (status in ('pending','accepted','rejected')),
  resolved_by uuid references auth.users(id),
  resolved_at timestamptz,
  created_at timestamptz default now()
);
alter table fake_reports enable row level security;
create policy "Reporters can view their own fake reports"
  on fake_reports for select using (auth.uid() = reporter_id);
create policy "Authenticated users can file a fake report"
  on fake_reports for insert with check (auth.uid() = reporter_id);
create policy "Admins can view all fake reports"
  on fake_reports for select
  using (exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin));
create policy "Admins can resolve fake reports"
  on fake_reports for update
  using (exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin));

-- Admins can delete any venue (moderation "Accept — remove").
create policy "Admins can delete any venue"
  on venues for delete
  using (exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin));

-- ─── VENUE PHOTO GALLERY ─────────────────────────────────
-- Returns every matchbook photo submitted for a venue (newest first) with no
-- collector name and no user_id column — collections stay owner-only, this is
-- the per-venue gallery on the venue detail page. Restricted to authenticated.
-- Caveat: photo URLs embed the uploader's storage path id; re-path uploads for
-- true anonymity (see migration 009).
create or replace function venue_photos(p_venue_id integer)
returns text[]
language sql
security definer
stable
set search_path = ''
as $$
  select coalesce(array_agg(p order by ord desc), '{}')
  from (
    select
      c.collected_at as ord,
      unnest(
        case
          when array_length(c.photos, 1) > 0 then c.photos
          when c.photo_url is not null then array[c.photo_url]
          else array[]::text[]
        end
      ) as p
    from public.collections c
    where c.venue_id = p_venue_id
  ) q
  where p is not null and p <> '';
$$;

revoke execute on function venue_photos(integer) from public, anon;
grant execute on function venue_photos(integer) to authenticated;

-- ─── REFERRALS ───────────────────────────────────────────
-- How many people I referred via my invite link. profiles are owner-only, so a
-- SECURITY DEFINER aggregate returns just the count (no identities).
create or replace function my_referral_count()
returns integer
language sql
security definer
stable
set search_path = ''
as $$
  select count(*)::int
  from public.profiles
  where referred_by = auth.uid()::text
    and id <> auth.uid();
$$;

revoke execute on function my_referral_count() from public, anon;
grant execute on function my_referral_count() to authenticated;

-- ─── FOLLOW GRAPH ────────────────────────────────────────
-- profiles/collections are owner-only, so showing a followed collector's name
-- + count needs SECURITY DEFINER reads. Authenticated-only; return just a
-- display_name + public count (identity is the real name, not a handle — 017).
create or replace function following_list()
returns table (id uuid, display_name text, avatar_url text, matchbooks integer)
language sql
security definer
stable
set search_path = ''
as $$
  select p.id, p.display_name, p.avatar_url,
         (select count(*)::int from public.collections c where c.user_id = p.id)
  from public.follows f
  join public.profiles p on p.id = f.following_id
  where f.follower_id = auth.uid()
  order by p.display_name;
$$;

revoke execute on function following_list() from public, anon;
grant execute on function following_list() to authenticated;

-- Search collectors by real NAME (substring, wildcard-escaped so "%" can't dump
-- the directory). Returns display_name; authenticated-only (017).
create or replace function search_collectors(q text)
returns table (id uuid, display_name text, avatar_url text, matchbooks integer, is_following boolean)
language sql
security definer
stable
set search_path = ''
as $$
  select p.id, p.display_name, p.avatar_url,
         (select count(*)::int from public.collections c where c.user_id = p.id),
         exists (select 1 from public.follows f where f.follower_id = auth.uid() and f.following_id = p.id)
  from public.profiles p
  where p.id <> auth.uid()
    and p.display_name is not null
    and length(trim(coalesce(q, ''))) >= 1
    and p.display_name ilike '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%'
  order by p.display_name
  limit 20;
$$;

revoke execute on function search_collectors(text) from public, anon;
grant execute on function search_collectors(text) to authenticated;

-- View a collector's ranked collection — only if you follow them (spec #19 kept
-- otherwise). Aggregate/rows are gated by the exists() follow check.
create or replace function collector_profile(target uuid)
returns table (venue_id integer, name text, neighborhood text, city text, bg_color text, score numeric, photo text)
language sql
security definer
stable
set search_path = ''
as $$
  select c.venue_id, v.name, v.neighborhood, v.city, v.bg_color, c.score,
         coalesce(nullif(c.photo_url, ''), (case when array_length(c.photos, 1) > 0 then c.photos[1] else null end))
  from public.collections c
  join public.venues v on v.id = c.venue_id
  where c.user_id = target
    and c.score is not null
    and exists (
      select 1 from public.follows f
      where f.follower_id = auth.uid() and f.following_id = target
    )
  order by c.score desc;
$$;

revoke execute on function collector_profile(uuid) from public, anon;
grant execute on function collector_profile(uuid) to authenticated;

-- Friends rankings: per-venue AVG(score) across the people I follow (spec §3).
-- Aggregate + ranker count only, never a name. Authenticated-only. NOTE: with a
-- single ranker the average equals that person's score (no name); add
-- `having count(*) >= 2` for k-anonymity if that matters.
create or replace function friends_rankings()
returns table (venue_id integer, avg_score numeric, rankers integer)
language sql
security definer
stable
set search_path = ''
as $$
  select c.venue_id,
         round(avg(c.score), 1) as avg_score,
         count(*)::int as rankers
  from public.collections c
  where c.user_id in (select following_id from public.follows where follower_id = auth.uid())
    and c.score is not null
  group by c.venue_id
  order by avg_score desc, rankers desc;
$$;

revoke execute on function friends_rankings() from public, anon;
grant execute on function friends_rankings() to authenticated;

-- City & World aggregate leaderboards (migration 018): per-venue avg score across
-- ALL collectors — city-scoped and global. SECURITY DEFINER + authenticated-only
-- (anon revoked explicitly). Aggregate-only: no names, no per-user rows.
create or replace function city_rankings(target_city text)
returns table (venue_id integer, avg_score numeric, rankers integer)
language sql
security definer
stable
set search_path = ''
as $$
  select c.venue_id,
         round(avg(c.score), 1) as avg_score,
         count(*)::int as rankers
  from public.collections c
  join public.venues v on v.id = c.venue_id
  where c.score is not null
    and v.city = target_city
  group by c.venue_id
  order by avg_score desc, rankers desc;
$$;
revoke execute on function city_rankings(text) from public, anon;
grant execute on function city_rankings(text) to authenticated;

create or replace function world_rankings()
returns table (venue_id integer, avg_score numeric, rankers integer)
language sql
security definer
stable
set search_path = ''
as $$
  select c.venue_id,
         round(avg(c.score), 1) as avg_score,
         count(*)::int as rankers
  from public.collections c
  where c.score is not null
  group by c.venue_id
  order by avg_score desc, rankers desc
  limit 100;
$$;
revoke execute on function world_rankings() from public, anon;
grant execute on function world_rankings() to authenticated;

-- Self-service account deletion (migration 019): a signed-in user erases their
-- OWN account + data. Nulls the non-cascade FKs (venues.created_by,
-- fake_reports.resolved_by) so the delete isn't blocked + shared venues survive,
-- removes their storage files, then deletes auth.users (cascades everything else).
-- Let users delete files in their OWN folder of the matchbooks bucket.
drop policy if exists "Users can delete own matchbook files" on storage.objects;
create policy "Users can delete own matchbook files"
  on storage.objects for delete
  using (bucket_id = 'matchbooks' and (storage.foldername(name))[1] = auth.uid()::text);

create or replace function delete_my_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  update public.venues set created_by = null where created_by = uid;
  update public.fake_reports set resolved_by = null where resolved_by = uid;
  delete from auth.users where id = uid;
end;
$$;
revoke execute on function delete_my_account() from public, anon;
grant execute on function delete_my_account() to authenticated;
