-- Migration 022 — block a collector. Run ONCE in the Supabase SQL editor (after 021). Idempotent.
--
-- WHY NOW: App Store Guideline 1.2 requires a way to block abusive users in any
-- app with user-generated content. phillumeni has report + an admin queue but no
-- block, and it's already flagged as a review risk in docs/app-store-listing.md.
-- Trades adds stranger-to-stranger DMs, which turns "Apple may ask" into "Apple
-- will ask" — so this lands FIRST, and the trade chat rests on it.
--
-- Blocking is one-directional to declare and two-directional in effect: I block
-- you, and neither of us can reach the other. The blocked party is never told.

create table if not exists public.blocks (
  blocker_id uuid references auth.users(id) on delete cascade not null,
  blocked_id uuid references auth.users(id) on delete cascade not null,
  created_at timestamptz default now(),
  primary key (blocker_id, blocked_id),
  constraint blocks_no_self check (blocker_id <> blocked_id)
);

alter table public.blocks enable row level security;

-- SELECT is blocker-only ON PURPOSE: you can see who you blocked, never who
-- blocked you. Surfacing that is both a privacy leak and an invitation to
-- retaliate. The RPCs below enforce the other direction without exposing it.
drop policy if exists "Users see their own blocks" on public.blocks;
create policy "Users see their own blocks"
  on public.blocks for select using (auth.uid() = blocker_id);

drop policy if exists "Users create their own blocks" on public.blocks;
create policy "Users create their own blocks"
  on public.blocks for insert with check (auth.uid() = blocker_id);

drop policy if exists "Users remove their own blocks" on public.blocks;
create policy "Users remove their own blocks"
  on public.blocks for delete using (auth.uid() = blocker_id);

-- ─── Internal helper ─────────────────────────────────────
-- Checks BOTH directions. Deliberately NOT granted to anyone: it answers "did
-- this person block me?", which no client may ask. It's only ever called from
-- inside the definer RPCs below, which execute as the owner and so can reach it.
create or replace function public.is_blocked_pair(a uuid, b uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.blocks
    where (blocker_id = a and blocked_id = b)
       or (blocker_id = b and blocked_id = a)
  );
$$;
revoke execute on function public.is_blocked_pair(uuid, uuid) from public, anon, authenticated;

-- ─── block_user ──────────────────────────────────────────
-- Must be an RPC: `Users can unfollow` is `using (auth.uid() = follower_id)`, so
-- a client can drop its OWN follow but never THEIR follow of you. Leaving that
-- row would keep them inside your follower graph after a block.
create or replace function public.block_user(target uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if target is null or target = auth.uid() then raise exception 'you cannot block yourself'; end if;

  insert into public.blocks (blocker_id, blocked_id)
  values (auth.uid(), target)
  on conflict do nothing;

  -- A block severs the follow graph BOTH ways.
  delete from public.follows
  where (follower_id = auth.uid() and following_id = target)
     or (follower_id = target and following_id = auth.uid());
end;
$$;
revoke execute on function public.block_user(uuid) from public, anon;
grant execute on function public.block_user(uuid) to authenticated;

-- ─── blocked_list ────────────────────────────────────────
-- Your own block list, with names — profiles are owner-only (005/014), so even
-- reading the names of people you blocked needs a definer.
create or replace function public.blocked_list()
returns table (id uuid, display_name text, avatar_url text)
language sql
security definer
stable
set search_path = ''
as $$
  select p.id, p.display_name, p.avatar_url
  from public.blocks b
  join public.profiles p on p.id = b.blocked_id
  where b.blocker_id = auth.uid()
  order by p.display_name;
$$;
revoke execute on function public.blocked_list() from public, anon;
grant execute on function public.blocked_list() to authenticated;

-- ─── Make every user-to-user surface block-aware ─────────
-- These four RPCs are the ONLY ways one collector reaches another today. A block
-- that didn't cover all of them would be decorative — and Apple tests it.

-- 1. Search: a blocked collector is not findable, in either direction.
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
    and not public.is_blocked_pair(auth.uid(), p.id)
  order by p.display_name
  limit 20;
$$;
revoke execute on function public.search_collectors(text) from public, anon;
grant execute on function public.search_collectors(text) to authenticated;

-- 2. Following list: block_user already deletes the follow rows, so this is
--    belt-and-braces against any follow created before/around a block.
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
    and not public.is_blocked_pair(auth.uid(), p.id)
  order by p.display_name;
$$;
revoke execute on function public.following_list() from public, anon;
grant execute on function public.following_list() to authenticated;

-- 3. Collector profile: the actual payload — someone's collection. The follow
--    gate alone isn't enough; a stale follow must not outlive a block.
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
    and not public.is_blocked_pair(auth.uid(), target)
    and exists (
      select 1 from public.follows f
      where f.follower_id = auth.uid() and f.following_id = target
    )
  order by c.score desc;
$$;
revoke execute on function public.collector_profile(uuid) from public, anon;
grant execute on function public.collector_profile(uuid) to authenticated;

-- 4. Friends rankings: aggregate, but a blocked person's taste shouldn't shape
--    your board — and with a small follow list their score is near-identifiable.
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
  join public.venues v on v.id = c.venue_id
  where c.user_id in (select following_id from public.follows where follower_id = auth.uid())
    and c.score is not null
    and v.kind = 'venue'
    and not public.is_blocked_pair(auth.uid(), c.user_id)
  group by c.venue_id
  order by avg_score desc, rankers desc;
$$;
revoke execute on function public.friends_rankings() from public, anon;
grant execute on function public.friends_rankings() to authenticated;
