-- Migration 025 — venue cover photos + Bar Snack repair. Run ONCE in the SQL editor. Idempotent.
--
-- User feedback (2026-07-18): "the logo shouldn't be a flame, it should be a
-- picture of the matchbook. Everyone should be able to see the submitted
-- photos. Can I select the photos as an admin?"
--
-- A venue's face is now a real matchbook photo: auto-filled from the first
-- collector's upload, admin-overridable from the community gallery.

-- ─── A. The column ───────────────────────────────────────
alter table public.venues add column if not exists cover_photo_url text;

-- ─── B. Auto-fill: the first photo a collector adds becomes the cover ──
-- Only fills EMPTY covers — an admin's explicit choice is never overwritten.
-- Definer because venues has no user UPDATE policy (deliberately, since 003).
create or replace function public.set_cover_if_missing()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare v_photo text;
begin
  v_photo := coalesce(new.photo_url, new.photos[1]);
  if v_photo is not null then
    update public.venues
      set cover_photo_url = v_photo
      where id = new.venue_id and kind = 'venue' and cover_photo_url is null;
  end if;
  return new;
end;
$$;
drop trigger if exists on_collection_set_cover on public.collections;
create trigger on_collection_set_cover
  after insert or update of photo_url, photos on public.collections
  for each row execute function public.set_cover_if_missing();

-- ─── C. Admin picks the cover ────────────────────────────
-- p_url must actually be one of this venue's community photos (no arbitrary
-- URLs, even from an admin — keeps the cover provably a submitted matchbook).
-- null clears it back to the emoji.
create or replace function public.set_venue_cover(p_venue_id integer, p_url text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  if p_url is not null and not exists (
    select 1 from public.collections c
    where c.venue_id = p_venue_id
      and (c.photo_url = p_url or p_url = any(c.photos))
  ) then
    raise exception 'that photo was not submitted for this venue';
  end if;
  update public.venues set cover_photo_url = p_url where id = p_venue_id;
end;
$$;
revoke execute on function public.set_venue_cover(integer, text) from public, anon;
grant execute on function public.set_venue_cover(integer, text) to authenticated;

-- ─── D. Backfill every venue that already has photos ─────
update public.venues v
set cover_photo_url = q.p
from (
  select distinct on (c.venue_id) c.venue_id, coalesce(c.photo_url, c.photos[1]) as p
  from public.collections c
  where coalesce(c.photo_url, c.photos[1]) is not null
  order by c.venue_id, c.collected_at desc
) q
where q.venue_id = v.id and v.cover_photo_url is null and v.kind = 'venue';

-- ─── E. Browse shows the cover when a listing has no photo of its own ──
-- Return-shape change → drop + recreate (re-applies grants).
drop function if exists public.browse_trades(text);
create function public.browse_trades(p_city text default null)
returns table (
  listing_id integer, venue_id integer, venue_name text, city text, neighborhood text,
  emoji text, bg_color text, photo_url text, cover_photo_url text,
  owner_id uuid, owner_name text, owner_avatar text, owner_trades integer, offer_count integer, my_offer_id integer
)
language sql
security definer
stable
set search_path = ''
as $$
  select l.id, v.id, v.name, v.city, v.neighborhood, v.emoji, v.bg_color, l.photo_url, v.cover_photo_url,
         p.id, p.display_name, p.avatar_url,
         public.completed_trade_count(p.id),
         (select count(*)::int from public.trade_offers o where o.listing_id = l.id and o.status = 'pending'),
         (select o.id from public.trade_offers o
           where o.listing_id = l.id and o.offerer_id = auth.uid() and o.status = 'pending' limit 1)
  from public.trade_listings l
  join public.venues v on v.id = l.venue_id
  join public.profiles p on p.id = l.user_id
  where l.status = 'active'
    and l.user_id <> auth.uid()
    and v.kind = 'venue'
    and (p_city is null or p_city = '' or v.city = p_city)
    and not exists (
      select 1 from public.blocks b
      where (b.blocker_id = auth.uid() and b.blocked_id = l.user_id)
         or (b.blocker_id = l.user_id and b.blocked_id = auth.uid())
    )
  order by l.created_at desc
  limit 200;
$$;
revoke execute on function public.browse_trades(text) from public, anon;
grant execute on function public.browse_trades(text) to authenticated;

-- ─── F. One-off repair: the two Bar Snacks ───────────────
-- Rounds 1 and 2 of the seeder geocoded "92 2nd Ave" and "92 2nd Ave." (note
-- the period) ~700m apart — past its 400m dedup radius — so the same bar
-- landed twice (ids 292 East Village = correct, 534 "Gramercy" = mislocated).
-- Move 534's collectors onto 292 (unless they already have it), then delete
-- the dupe. Guarded so this whole block no-ops on any future re-run.
do $$
begin
  if exists (select 1 from public.venues where id = 534 and name = 'Bar Snack')
     and exists (select 1 from public.venues where id = 292 and name = 'Bar Snack') then
    update public.collections c set venue_id = 292
      where c.venue_id = 534
        and not exists (select 1 from public.collections c2
                        where c2.user_id = c.user_id and c2.venue_id = 292);
    update public.trade_listings t set venue_id = 292
      where t.venue_id = 534
        and not exists (select 1 from public.trade_listings t2
                        where t2.user_id = t.user_id and t2.venue_id = 292);
    delete from public.venues where id = 534; -- cascades the leftovers
  end if;
end $$;
