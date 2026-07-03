-- ════════════════════════════════════════════════════════════════
-- RUN ALL PENDING MIGRATIONS (006 → 016) + make yourself admin.
-- Paste this ENTIRE file into the Supabase SQL editor and click Run.
-- Safe on a fresh DB at migration 005. NOTE: 007 wipes seed venues.
-- ════════════════════════════════════════════════════════════════

-- ── 006_collection_photos.sql ──
-- Migration 006 — multiple photos per collected matchbook
-- Run ONCE in the Supabase SQL editor. Idempotent.
--
-- Adds a photos[] array to collections. photo_url is kept as the "cover" (first
-- photo) so existing grid/list/detail display keeps working unchanged.

alter table public.collections add column if not exists photos text[] not null default '{}';

-- ── 007_submit_and_ranking.sql ──
-- Migration 007 — adopt the Submit & Ranking spec (foundation)
-- Run ONCE in the Supabase SQL editor. Idempotent.

-- ─── §0/§1: ZERO SEED DATA — delete every seeded venue ──────────────────
-- Real submissions always have created_by set (RLS requires it); the 45 seeds
-- have created_by = null. on-delete-cascade removes any collections/reports
-- pointing at them. Virginia's (#46) and any future real submission survive.
delete from public.venues where created_by is null;

-- ─── §2: manual-entry marker ────────────────────────────────────────────
alter table public.venues add column if not exists added_manually boolean default false;

-- ─── §3: ranking — per-user Elo score on each collected venue ───────────
alter table public.collections add column if not exists score numeric(3,1);

-- Ranking (and the multi-photo re-collect path) write to a user's own rows,
-- which needs an UPDATE policy collections never had.
drop policy if exists "Users can update their own collections" on public.collections;
create policy "Users can update their own collections"
  on public.collections for update using (auth.uid() = user_id);

create table if not exists public.comparisons (
  id serial primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  winner_venue_id integer references public.venues(id) on delete cascade not null,
  loser_venue_id integer references public.venues(id) on delete cascade not null,
  created_at timestamptz default now()
);
alter table public.comparisons enable row level security;
drop policy if exists "Users can view their own comparisons" on public.comparisons;
create policy "Users can view their own comparisons"
  on public.comparisons for select using (auth.uid() = user_id);
drop policy if exists "Users can log their own comparisons" on public.comparisons;
create policy "Users can log their own comparisons"
  on public.comparisons for insert with check (auth.uid() = user_id);

-- ─── §5/Phase E: admin flag (gates the moderation screens) ──────────────
alter table public.profiles add column if not exists is_admin boolean default false;

-- ─── §4: fake-photo reports (fraud claims → human review) ───────────────
create table if not exists public.fake_reports (
  id serial primary key,
  reporter_id uuid references auth.users(id) on delete cascade not null,
  venue_id integer references public.venues(id) on delete cascade not null,
  reason text,
  status text not null default 'pending' check (status in ('pending','accepted','rejected')),
  resolved_by uuid references auth.users(id),
  resolved_at timestamptz,
  created_at timestamptz default now()
);
alter table public.fake_reports enable row level security;

-- NOTE: the spec says "viewable by everyone"; we deviate to match the lock-down
-- decision (#19) — reads are scoped to the reporter, plus admins (below).
drop policy if exists "Reporters can view their own fake reports" on public.fake_reports;
create policy "Reporters can view their own fake reports"
  on public.fake_reports for select using (auth.uid() = reporter_id);
drop policy if exists "Authenticated users can file a fake report" on public.fake_reports;
create policy "Authenticated users can file a fake report"
  on public.fake_reports for insert with check (auth.uid() = reporter_id);

-- Admins (profiles.is_admin) can read every report and resolve it.
drop policy if exists "Admins can view all fake reports" on public.fake_reports;
create policy "Admins can view all fake reports"
  on public.fake_reports for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));
drop policy if exists "Admins can resolve fake reports" on public.fake_reports;
create policy "Admins can resolve fake reports"
  on public.fake_reports for update
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

-- Admins can delete any venue (the "Accept — remove" moderation action).
drop policy if exists "Admins can delete any venue" on public.venues;
create policy "Admins can delete any venue"
  on public.venues for delete
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

-- ─── Make YOURSELF admin — run this with your real app-login email ──────
-- update public.profiles set is_admin = true
--   where id = (select id from auth.users where email = 'wyethwest@gmail.com');

-- ── 008_admin_profile_reads.sql ──
-- Migration 008 — let admins resolve usernames for the Reported-photos queue.
-- Run ONCE in the Supabase SQL editor, AFTER 007. Idempotent.
--
-- The admin moderation card shows "Submitted by @user" and "— @reporter".
-- Profiles are owner-only SELECT (privacy lock-down #19), so an admin can't read
-- other users' usernames. This grants a read-only, is_admin-gated exception.
--
-- IMPORTANT: the admin check goes through a SECURITY DEFINER function, NOT an
-- inline `exists (select ... from profiles ...)`. A profiles SELECT policy that
-- itself selects from profiles causes infinite RLS recursion (42P17). The
-- definer function runs with RLS disabled inside, so it can't recurse.

create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

drop policy if exists "Admins can view all profiles" on public.profiles;
create policy "Admins can view all profiles"
  on public.profiles for select
  using (public.is_admin());

-- ── 009_venue_photos.sql ──
-- Migration 009 — per-venue photo gallery for the venue detail page.
-- Run ONCE in the Supabase SQL editor, AFTER 006 (needs collections.photos).
--
-- Collections are owner-only SELECT (privacy lock-down #19), so one user can't
-- read another's rows. The venue page wants to show every matchbook photo
-- submitted for a place without showing WHO submitted it. This SECURITY DEFINER
-- function returns the flat list of photo URLs for a venue (newest first) with
-- no collector name and no user_id column.
--
-- CAVEAT (not full anonymity): photo storage paths are `<user_id>/<uuid>.<ext>`,
-- so the uploader's id is embedded in each URL. This hides the displayed
-- identity, not a determined inspector. For true anonymity, re-path uploads
-- (and the 002 storage write policy) to a non-identifying key later.
--
-- EXECUTE is restricted to authenticated users (Explore is auth-gated anyway),
-- so the anon key can't bulk-enumerate every venue's photos.

create or replace function public.venue_photos(p_venue_id integer)
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

revoke execute on function public.venue_photos(integer) from public;
grant execute on function public.venue_photos(integer) to authenticated;

-- ── 010_referrals.sql ──
-- Migration 010 — invite/referral attribution for the "Invite friends" link.
-- Run ONCE in the Supabase SQL editor. Idempotent.
--
-- The invite link is {origin}/?invite=<inviter user id>. When the referred
-- person first authenticates, the client sets profiles.referred_by = that id
-- (once, only while it's null). Keyed on the stable user id, NOT username —
-- usernames get suffixed on collision and can be reused after deletion.
-- NOTE: referred_by is client-written free text, so the count is an advisory
-- vanity metric — never gate rewards/leaderboards on it without server validation.

alter table public.profiles add column if not exists referred_by text;

-- How many people I referred. profiles are owner-only SELECT (lock-down #19), so
-- this needs a SECURITY DEFINER aggregate. Returns just a count — no identities.
create or replace function public.my_referral_count()
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

revoke execute on function public.my_referral_count() from public;
grant execute on function public.my_referral_count() to authenticated;

-- ── 011_follow_graph.sql ──
-- Migration 011 — follow graph helpers for the social layer.
-- Run ONCE in the Supabase SQL editor. Idempotent. The `follows` table and its
-- RLS already exist (base schema); this only adds the read-side RPCs.
--
-- follows: (follower_id, following_id). RLS already allows a user to insert their
-- own follows, delete their own, and select rows where they're either side. But
-- profiles/collections are owner-only SELECT, so to show a followed collector's
-- username + matchbook count we need SECURITY DEFINER reads. Both return only a
-- username + a public count (no email, no identity beyond the handle), and are
-- restricted to authenticated callers.

-- People I follow, with their collection size.
create or replace function public.following_list()
returns table (id uuid, username text, matchbooks integer)
language sql
security definer
stable
set search_path = ''
as $$
  select p.id, p.username,
         (select count(*)::int from public.collections c where c.user_id = p.id)
  from public.follows f
  join public.profiles p on p.id = f.following_id
  where f.follower_id = auth.uid()
  order by p.username;
$$;

revoke execute on function public.following_list() from public;
grant execute on function public.following_list() to authenticated;

-- Find collectors by username prefix (for the "Find collectors" search). Excludes
-- self, flags whether I already follow them, capped at 20.
create or replace function public.search_collectors(q text)
returns table (id uuid, username text, matchbooks integer, is_following boolean)
language sql
security definer
stable
set search_path = ''
as $$
  select p.id, p.username,
         (select count(*)::int from public.collections c where c.user_id = p.id),
         exists (select 1 from public.follows f where f.follower_id = auth.uid() and f.following_id = p.id)
  from public.profiles p
  where p.id <> auth.uid()
    and p.username is not null
    and length(trim(coalesce(q, ''))) >= 1                                    -- never an unfiltered directory page
    and p.username ilike replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%'  -- literal prefix, no wildcard injection
  order by p.username
  limit 20;
$$;

revoke execute on function public.search_collectors(text) from public;
grant execute on function public.search_collectors(text) to authenticated;

-- ── 012_friends_rankings.sql ──
-- Migration 012 — Friends rankings (spec §3 "Aggregating to Friends").
-- Run ONCE in the Supabase SQL editor, AFTER 007 (needs collections.score).
--
-- A venue's friends score = AVG(collections.score) across the people you follow
-- who have it ranked. collections is owner-only SELECT, so this SECURITY DEFINER
-- aggregate returns per-venue averages + a ranker count only — never a name and
-- never a per-user row. Authenticated-only.
--
-- PRIVACY NOTE: when exactly one followed user has ranked a venue, the average
-- equals that one person's exact score (still no name attached). That's an
-- intended trade-off for a follow-based "what my circle likes" view. To require
-- k-anonymity instead, add `having count(*) >= 2` to the query below — but that
-- hides any venue only one friend ranked, which is sparse for small follow sets.

create or replace function public.friends_rankings()
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

revoke execute on function public.friends_rankings() from public;
grant execute on function public.friends_rankings() to authenticated;

-- ── 013_restrict_rpc_anon.sql ──
-- Migration 013 — actually restrict the SECURITY DEFINER RPCs to authenticated.
-- Run ONCE in the Supabase SQL editor, AFTER 012.
--
-- WHY: Supabase's default privileges grant EXECUTE on every new public-schema
-- function DIRECTLY to the `anon` role (not via PUBLIC). So the `revoke execute
-- ... from public` in migrations 009-012 did NOT remove anon's access — verified
-- live: an anon key could still call venue_photos() and search_collectors().
-- This revokes the direct anon grant. `authenticated` keeps its own grant.
--
-- is_admin() is intentionally NOT revoked: it's evaluated inside RLS policies
-- (profiles/fake_reports/venues), so every querying role must be able to execute
-- it, and it safely returns false for anon.

revoke execute on function public.venue_photos(integer) from anon;
revoke execute on function public.my_referral_count() from anon;
revoke execute on function public.following_list() from anon;
revoke execute on function public.search_collectors(text) from anon;
revoke execute on function public.friends_rankings() from anon;

-- ── 014_lock_profile_columns.sql ──
-- Migration 014 — SECURITY: stop users writing privileged profile columns.
-- Run ONCE in the Supabase SQL editor (do this ASAP — it's a real escalation).
--
-- The "Users can update their own profile" RLS policy gates WHICH ROW you can
-- edit (your own) but not WHICH COLUMNS. profiles.is_admin is a real auth
-- boundary (RLS admin checks trust it), so any logged-in user could run
-- `update profiles set is_admin = true where id = auth.uid()` and take over
-- moderation (incl. deleting any venue, which cascades away everyone's data).
--
-- Fix: column-scoped UPDATE grant. RLS still restricts to the owner's row; the
-- grant restricts which columns that owner may change — is_admin and id are
-- excluded, so they can never be set from the client (only via SQL/service role).

revoke update on public.profiles from authenticated;
grant update (username, display_name, bio, home_city, referred_by)
  on public.profiles to authenticated;

-- ── 015_profile_avatars.sql ──
-- Migration 015 — profile pictures. Run ONCE in the Supabase SQL editor.
-- Avatars are stored in the existing `matchbooks` bucket under the user's own
-- folder (<user_id>/avatar-*.jpg), which the existing per-user write policy
-- already permits; the bucket is public-read so avatars show to everyone.

alter table public.profiles add column if not exists avatar_url text;

-- Let users set their own avatar (extends the column-scoped grant from 014 —
-- is_admin + id stay excluded).
revoke update on public.profiles from authenticated;
grant update (username, display_name, bio, home_city, referred_by, avatar_url)
  on public.profiles to authenticated;

-- Recreate the follow RPCs to also return avatar_url. Changing a function's
-- RETURNS TABLE shape requires DROP; the drop clears its grants (and resets the
-- default PUBLIC execute), so the revoke/grant must be re-applied after.
drop function if exists public.following_list();
create function public.following_list()
returns table (id uuid, username text, avatar_url text, matchbooks integer)
language sql
security definer
stable
set search_path = ''
as $$
  select p.id, p.username, p.avatar_url,
         (select count(*)::int from public.collections c where c.user_id = p.id)
  from public.follows f
  join public.profiles p on p.id = f.following_id
  where f.follower_id = auth.uid()
  order by p.username;
$$;
revoke execute on function public.following_list() from public, anon;
grant execute on function public.following_list() to authenticated;

drop function if exists public.search_collectors(text);
create function public.search_collectors(q text)
returns table (id uuid, username text, avatar_url text, matchbooks integer, is_following boolean)
language sql
security definer
stable
set search_path = ''
as $$
  select p.id, p.username, p.avatar_url,
         (select count(*)::int from public.collections c where c.user_id = p.id),
         exists (select 1 from public.follows f where f.follower_id = auth.uid() and f.following_id = p.id)
  from public.profiles p
  where p.id <> auth.uid()
    and p.username is not null
    and length(trim(coalesce(q, ''))) >= 1
    and p.username ilike replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%'
  order by p.username
  limit 20;
$$;
revoke execute on function public.search_collectors(text) from public, anon;
grant execute on function public.search_collectors(text) to authenticated;

-- ── 016_collector_profile.sql ──
-- Migration 016 — view another collector's profile. Run ONCE in the SQL editor.
--
-- Returns a collector's ranked collection (venue + their score + their photo),
-- but ONLY if the caller follows them (the exists() gate) — keeping collections
-- otherwise owner-only per the #19 lock-down. SECURITY DEFINER + authenticated-only.
-- Not following (or anon) → zero rows.

create or replace function public.collector_profile(target uuid)
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

revoke execute on function public.collector_profile(uuid) from public, anon;
grant execute on function public.collector_profile(uuid) to authenticated;

-- ── 017_name_only.sql ──
-- Migration 017 — name-only identity: real name (display_name) replaces the
-- username as the sole human identity. username stays as a hidden internal key.
revoke update on public.profiles from authenticated;
grant update (display_name, bio, home_city, referred_by, avatar_url)
  on public.profiles to authenticated;

drop function if exists public.search_collectors(text);
create function public.search_collectors(q text)
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
revoke execute on function public.search_collectors(text) from public, anon;
grant execute on function public.search_collectors(text) to authenticated;

drop function if exists public.following_list();
create function public.following_list()
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
revoke execute on function public.following_list() from public, anon;
grant execute on function public.following_list() to authenticated;

-- ── 018_city_world_rankings.sql ──
-- Migration 018 — City & World aggregate leaderboards (avg score across ALL
-- collectors, per venue). SECURITY DEFINER + authenticated-only (anon revoked
-- explicitly). Aggregate-only: no names, no per-user rows.
create or replace function public.city_rankings(target_city text)
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
revoke execute on function public.city_rankings(text) from public, anon;
grant execute on function public.city_rankings(text) to authenticated;

create or replace function public.world_rankings()
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
revoke execute on function public.world_rankings() from public, anon;
grant execute on function public.world_rankings() to authenticated;

update public.profiles set is_admin = true where id = (select id from auth.users where email = 'wyethwest@gmail.com');
