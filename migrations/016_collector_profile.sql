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
