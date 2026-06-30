-- ════════════════════════════════════════════════════════════════
-- RUN ALL PENDING MIGRATIONS (006 → 011) + make yourself admin.
-- Paste this ENTIRE file into the Supabase SQL editor and click Run.
-- Safe to run once on a DB currently at migration 005. Idempotent.
-- NOTE: 007 wipes the 8 leftover seed venues (zero-seed by design).
-- ════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────
-- 006_collection_photos.sql
-- ─────────────────────────────────────────────────────────────
-- Migration 006 — multiple photos per collected matchbook
-- Run ONCE in the Supabase SQL editor. Idempotent.
--
-- Adds a photos[] array to collections. photo_url is kept as the "cover" (first
-- photo) so existing grid/list/detail display keeps working unchanged.

alter table public.collections add column if not exists photos text[] not null default '{}';

-- ─────────────────────────────────────────────────────────────
-- 007_submit_and_ranking.sql
-- ─────────────────────────────────────────────────────────────
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

-- ─────────────────────────────────────────────────────────────
-- 008_admin_profile_reads.sql
-- ─────────────────────────────────────────────────────────────
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

-- ─────────────────────────────────────────────────────────────
-- 009_venue_photos.sql
-- ─────────────────────────────────────────────────────────────
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

-- ─────────────────────────────────────────────────────────────
-- 010_referrals.sql
-- ─────────────────────────────────────────────────────────────
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

-- ─────────────────────────────────────────────────────────────
-- 011_follow_graph.sql
-- ─────────────────────────────────────────────────────────────
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

-- ─────────────────────────────────────────────────────────────
-- Make yourself admin (your app-login email)
-- ─────────────────────────────────────────────────────────────
update public.profiles set is_admin = true
  where id = (select id from auth.users where email = 'wyethwest@gmail.com');
