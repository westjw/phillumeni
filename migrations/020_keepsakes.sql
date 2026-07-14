-- Migration 020 — keepsake matchbooks. Run ONCE in the Supabase SQL editor.
--
-- A keepsake is a matchbook that isn't from a place — a wedding, a party, a
-- one-off. It's modeled as a venues row with kind='keepsake' and no real
-- location (lat/lng 0,0), so collecting/ranking works unchanged, but it must
-- NEVER surface on shared location features. The client hides keepsakes from
-- the map/nearby list; this migration (a) adds the kind column and (b) keeps
-- them out of the shared City/World leaderboards at the source.

alter table public.venues add column if not exists kind text not null default 'venue';
alter table public.venues drop constraint if exists venues_kind_check;
alter table public.venues add constraint venues_kind_check check (kind in ('venue','keepsake'));

-- City board: already city-scoped (keepsakes have city=null), kind filter for safety.
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
    and v.kind = 'venue'
    and v.city = target_city
  group by c.venue_id
  order by avg_score desc, rankers desc;
$$;
revoke execute on function public.city_rankings(text) from public, anon;
grant execute on function public.city_rankings(text) to authenticated;

-- World board: gains the venues join so personal keepsakes never chart globally.
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
  join public.venues v on v.id = c.venue_id
  where c.score is not null
    and v.kind = 'venue'
  group by c.venue_id
  order by avg_score desc, rankers desc
  limit 100;
$$;
revoke execute on function public.world_rankings() from public, anon;
grant execute on function public.world_rankings() to authenticated;
