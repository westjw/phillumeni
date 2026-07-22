-- Migration 027 — merge + cover fixes from the covers/dedup/merge review. Run ONCE. Idempotent.
--
-- Three confirmed defects:
--  (3) merging when a user collected BOTH venues silently cascade-deleted their
--      dupe row — photos, ranking score, collect date gone, and the keeper's
--      inherited cover could point at a photo no collections row carries.
--  (5) a leftover ACTIVE dupe listing (owner listed both copies) cascade-died
--      with its pending offers, with no notice to the offerers.
--  (4) account deletion removes the user's storage files but venue covers kept
--      pointing at them — a permanent broken image as a venue's public face.

-- ─── merge v2: fold conflicts instead of losing them ─────
create or replace function public.merge_venues_impl(p_keep integer, p_dupe integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  keep_row public.venues%rowtype;
  dupe_row public.venues%rowtype;
begin
  if p_keep = p_dupe then raise exception 'pick two different venues'; end if;
  select * into keep_row from public.venues where id = p_keep;
  select * into dupe_row from public.venues where id = p_dupe;
  if keep_row.id is null or dupe_row.id is null then raise exception 'venue not found'; end if;
  if keep_row.kind <> 'venue' or dupe_row.kind <> 'venue' then
    raise exception 'keepsakes cannot be merged';
  end if;

  -- A collector who has BOTH rows keeps ONE that carries everything: photos
  -- appended, cover kept, the ranking score and the EARLIER collect date
  -- preserved. Their dupe row still dies with the venue, but empty-handed.
  update public.collections k set
    photos = (select coalesce(array_agg(distinct p), '{}')
              from unnest(coalesce(k.photos, '{}') || coalesce(d.photos, '{}')) p
              where p is not null and p <> ''),
    photo_url = coalesce(k.photo_url, d.photo_url),
    score = coalesce(k.score, d.score),
    collected_at = least(k.collected_at, d.collected_at)
  from public.collections d
  where k.user_id = d.user_id and k.venue_id = p_keep and d.venue_id = p_dupe;

  -- Everyone else moves wholesale.
  update public.collections c set venue_id = p_keep
    where c.venue_id = p_dupe
      and not exists (select 1 from public.collections c2
                      where c2.user_id = c.user_id and c2.venue_id = p_keep);

  update public.reports r set venue_id = p_keep
    where r.venue_id = p_dupe
      and not exists (select 1 from public.reports r2
                      where r2.user_id = r.user_id and r2.venue_id = p_keep);

  update public.trade_listings t set venue_id = p_keep
    where t.venue_id = p_dupe
      and not exists (select 1 from public.trade_listings t2
                      where t2.user_id = t.user_id and t2.venue_id = p_keep);
  if exists (select 1 from public.trade_listings
             where venue_id = p_dupe and status = 'in_trade') then
    raise exception 'the duplicate has an active trade that could not be moved — complete or cancel it first';
  end if;
  -- Leftover unmovable listings die with the venue — but their pending offers
  -- get DECLINED first (visible to the offerer) instead of vanishing.
  update public.trade_offers o set status = 'declined'
    from public.trade_listings l
    where o.listing_id = l.id and l.venue_id = p_dupe and o.status = 'pending';

  update public.trade_offers o
    set offered_venue_ids = (select array_agg(distinct x) from unnest(
          (select array_replace(o.offered_venue_ids, p_dupe, p_keep))) x)
    where p_dupe = any(o.offered_venue_ids);

  if keep_row.mapbox_id is null and dupe_row.mapbox_id is not null then
    update public.venues set mapbox_id = null where id = p_dupe;
    update public.venues set mapbox_id = dupe_row.mapbox_id where id = p_keep;
  end if;
  update public.venues set
    cover_photo_url = coalesce(cover_photo_url, dupe_row.cover_photo_url),
    neighborhood    = coalesce(neighborhood, dupe_row.neighborhood)
    where id = p_keep;
  -- The folded/moved collections rows now carry every photo, so the inherited
  -- cover always has a backing row and set_venue_cover can re-validate it.

  delete from public.venues where id = p_dupe;
end;
$$;
revoke execute on function public.merge_venues_impl(integer, integer) from public, anon, authenticated;

-- ─── covers must not outlive their storage files ─────────
-- Called by the client right before account deletion (which deletes the user's
-- storage folder): any venue wearing one of their photos goes back to the
-- emoji, and the auto-fill trigger re-covers it from the next photo added.
create or replace function public.clear_my_covers()
returns void
language sql
security definer
set search_path = ''
as $$
  update public.venues
    set cover_photo_url = null
    where cover_photo_url like '%/matchbooks/' || (select auth.uid())::text || '/%';
$$;
revoke execute on function public.clear_my_covers() from public, anon;
grant execute on function public.clear_my_covers() to authenticated;
