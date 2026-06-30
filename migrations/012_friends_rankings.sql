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
