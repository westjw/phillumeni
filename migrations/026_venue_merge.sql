-- Migration 026 — admin venue merge. Run ONCE in the SQL editor. Idempotent.
--
-- When a duplicate venue slips past the dedup nets (name variants, big geocode
-- drift, a seeding mistake), fixing it was a hand-written SQL session. Now it's
-- a tap: admin opens the dupe's venue sheet → "Merge duplicate…" → picks the
-- keeper. Everything real moves; the dupe row dies.

-- The worker. Deliberately granted to NOBODY — only the gated wrapper below
-- reaches it (definers run as owner). Split from the wrapper so the logic is
-- testable from the SQL editor, where auth.uid() is null and is_admin() would
-- refuse everything.
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

  -- Collectors move unless they already have the keeper (then their dupe row
  -- just dies with the venue — they don't lose the keeper copy).
  update public.collections c set venue_id = p_keep
    where c.venue_id = p_dupe
      and not exists (select 1 from public.collections c2
                      where c2.user_id = c.user_id and c2.venue_id = p_keep);

  -- Availability reports: same move-unless-conflict (unique user+venue).
  update public.reports r set venue_id = p_keep
    where r.venue_id = p_dupe
      and not exists (select 1 from public.reports r2
                      where r2.user_id = r.user_id and r2.venue_id = p_keep);

  -- Trade listings: moving one carries its offers and any live chat with it —
  -- an active trade SURVIVES the merge, now pointing at the keeper.
  update public.trade_listings t set venue_id = p_keep
    where t.venue_id = p_dupe
      and not exists (select 1 from public.trade_listings t2
                      where t2.user_id = t.user_id and t2.venue_id = p_keep);
  -- If someone listed BOTH copies and the dupe's is mid-trade, deleting the
  -- dupe would cascade that chat away. Refuse; a human closes the trade first.
  if exists (select 1 from public.trade_listings
             where venue_id = p_dupe and status = 'in_trade') then
    raise exception 'the duplicate has an active trade that could not be moved — complete or cancel it first';
  end if;

  -- Offer bundles that name the dupe now name the keeper (deduped).
  update public.trade_offers o
    set offered_venue_ids = (select array_agg(distinct x) from unnest(
          (select array_replace(o.offered_venue_ids, p_dupe, p_keep))) x)
    where p_dupe = any(o.offered_venue_ids);

  -- The keeper inherits anything it's missing. mapbox_id is unique, so free
  -- the dupe's first; future search submits then dedup straight onto the keeper.
  if keep_row.mapbox_id is null and dupe_row.mapbox_id is not null then
    update public.venues set mapbox_id = null where id = p_dupe;
    update public.venues set mapbox_id = dupe_row.mapbox_id where id = p_keep;
  end if;
  update public.venues set
    cover_photo_url = coalesce(cover_photo_url, dupe_row.cover_photo_url),
    neighborhood    = coalesce(neighborhood, dupe_row.neighborhood)
    where id = p_keep;

  -- Cascades eat the leftovers: conflicting collections/reports/listings rows.
  delete from public.venues where id = p_dupe;
end;
$$;
revoke execute on function public.merge_venues_impl(integer, integer) from public, anon, authenticated;

create or replace function public.admin_merge_venues(p_keep integer, p_dupe integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  perform public.merge_venues_impl(p_keep, p_dupe);
end;
$$;
revoke execute on function public.admin_merge_venues(integer, integer) from public, anon;
grant execute on function public.admin_merge_venues(integer, integer) to authenticated;
