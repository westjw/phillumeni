-- Migration 018 — City & World rankings (aggregate leaderboards).
-- Run ONCE in the Supabase SQL editor, AFTER 007 (needs collections.score).
--
-- Both aggregate collections.score across ALL collectors. collections is owner-
-- only SELECT, so these SECURITY DEFINER functions return per-venue averages +
-- a ranker count only — never a name, never a per-user row. Authenticated-only;
-- anon is revoked EXPLICITLY (Supabase grants EXECUTE to anon by default, so a
-- bare `revoke from public` does NOT block anon — the migration-013 lesson).
--
--   city_rankings(target_city): venues in one city, best avg first.
--   world_rankings():           every venue, globally, best avg first (cap 100).
--
-- PRIVACY NOTE: same single-ranker trade-off as friends_rankings — with exactly
-- one collector the average equals that person's score (still no name attached).
-- Add `having count(*) >= N` to either query to require k-anonymity once the
-- collector base is larger.

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
