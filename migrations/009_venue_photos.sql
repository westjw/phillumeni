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
