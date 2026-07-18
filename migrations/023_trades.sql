-- Migration 023 — Trades. Run ONCE in the Supabase SQL editor (after 022). Idempotent.
--
-- Peer-to-peer matchbook exchange, per docs/trades-spec.md. phillumeni never
-- touches addresses, logistics or money — it facilitates trust and gets out of
-- the way. Trust is the public trade record; enforcement doesn't exist.
--
-- Reconciled against the app as built:
--   * identity is display_name (017 removed usernames), so no @handles anywhere
--   * blocked collectors never see each other's listings, offers or chats (022)
--   * keepsakes are not tradeable (kind='venue' only), like every shared surface
--
-- Four bugs in the spec's own SQL are fixed here; each is flagged inline.

-- ─── A. Listings ─────────────────────────────────────────
-- SPEC BUG (c): the spec has unique(user_id, venue_id) AND a 'removed' status,
-- so re-listing a matchbook you'd once removed would collide forever. The row is
-- therefore PERMANENT and the status toggles — re-listing is an upsert back to
-- 'active'. Nothing is ever deleted, so history survives.
create table if not exists public.trade_listings (
  id serial primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  venue_id integer references public.venues(id) on delete cascade not null,
  photo_url text,
  status text not null default 'active' check (status in ('active','in_trade','removed')),
  created_at timestamptz default now(),
  unique (user_id, venue_id)
);
alter table public.trade_listings enable row level security;

drop policy if exists "Trade listings are public" on public.trade_listings;
create policy "Trade listings are public"
  on public.trade_listings for select using (true);
drop policy if exists "Users create their own listings" on public.trade_listings;
create policy "Users create their own listings"
  on public.trade_listings for insert with check (auth.uid() = user_id);
drop policy if exists "Users update their own listings" on public.trade_listings;
create policy "Users update their own listings"
  on public.trade_listings for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "Users delete their own listings" on public.trade_listings;
create policy "Users delete their own listings"
  on public.trade_listings for delete using (auth.uid() = user_id);

-- ─── B. Offers ───────────────────────────────────────────
create table if not exists public.trade_offers (
  id serial primary key,
  listing_id integer references public.trade_listings(id) on delete cascade not null,
  offerer_id uuid references auth.users(id) on delete cascade not null,
  offered_venue_ids integer[] not null check (array_length(offered_venue_ids, 1) > 0),
  note text,
  status text not null default 'pending' check (status in ('pending','accepted','declined','withdrawn')),
  created_at timestamptz default now()
);
alter table public.trade_offers enable row level security;

-- SPEC BUG (d): "cannot submit more than one pending offer on the same listing"
-- was client-side only. A partial unique index makes it true.
create unique index if not exists trade_offers_one_pending
  on public.trade_offers (listing_id, offerer_id) where status = 'pending';

drop policy if exists "Offers visible to offerer and listing owner" on public.trade_offers;
create policy "Offers visible to offerer and listing owner"
  on public.trade_offers for select
  using (
    auth.uid() = offerer_id
    or auth.uid() = (select l.user_id from public.trade_listings l where l.id = listing_id)
  );
-- Writes go through make_offer/accept_offer/decline_offer, which enforce the
-- rules the spec lists (own listing, in_trade, blocked, ownership). Direct
-- INSERT is still allowed for the offerer so the RPC has nothing to work around.
drop policy if exists "Users submit their own offers" on public.trade_offers;
create policy "Users submit their own offers"
  on public.trade_offers for insert with check (auth.uid() = offerer_id);
drop policy if exists "Offerer and owner can update an offer" on public.trade_offers;
create policy "Offerer and owner can update an offer"
  on public.trade_offers for update
  using (
    auth.uid() = offerer_id
    or auth.uid() = (select l.user_id from public.trade_listings l where l.id = listing_id)
  );

-- ─── C. Chats ────────────────────────────────────────────
create table if not exists public.trade_chats (
  id serial primary key,
  offer_id integer references public.trade_offers(id) on delete cascade not null unique,
  status text not null default 'active' check (status in ('active','completed','cancelled')),
  cancel_reason text check (cancel_reason in ('mutual','they_ghosted','i_backed_out') or cancel_reason is null),
  cancelled_by uuid references auth.users(id),
  -- SPEC BUG (b): §4.7's two-tap confirm referenced completed_by_user_id, which
  -- the spec's schema never defined. First tap stamps it; second tap completes.
  completed_by uuid references auth.users(id),
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz default now()
);
alter table public.trade_chats enable row level security;

-- ─── D. Messages ─────────────────────────────────────────
create table if not exists public.trade_messages (
  id serial primary key,
  chat_id integer references public.trade_chats(id) on delete cascade not null,
  sender_id uuid references auth.users(id) on delete cascade not null,
  content text not null check (length(trim(content)) > 0),
  kind text not null default 'user' check (kind in ('user','system')),
  created_at timestamptz default now()
);
alter table public.trade_messages enable row level security;

-- ─── E. Who is in a trade? ───────────────────────────────
-- SPEC BUG (a) — the big one. The spec gates messages on
--   auth.uid() = (select coalesce((select offerer_id ...), (select owner ...)))
-- but coalesce returns the FIRST NON-NULL, and offerer_id is NOT NULL — so it
-- always returns the offerer and the owner branch is dead code. The listing
-- owner could only ever read their OWN messages: a chat that looks fine until
-- someone replies. Both parties come back as a set instead.
create or replace function public.trade_parties(p_chat_id integer)
returns setof uuid
language sql
security definer
stable
set search_path = ''
as $$
  select o.offerer_id
  from public.trade_chats c
  join public.trade_offers o on o.id = c.offer_id
  where c.id = p_chat_id
  union
  select l.user_id
  from public.trade_chats c
  join public.trade_offers o on o.id = c.offer_id
  join public.trade_listings l on l.id = o.listing_id
  where c.id = p_chat_id;
$$;
-- Callable by authenticated because RLS policies below evaluate it AS the
-- querying user (same reason is_admin() must stay executable — see 013). It
-- only ever reveals who is in a trade you can already reach.
revoke execute on function public.trade_parties(integer) from public, anon;
grant execute on function public.trade_parties(integer) to authenticated;

drop policy if exists "Trade chat visible to both parties" on public.trade_chats;
create policy "Trade chat visible to both parties"
  on public.trade_chats for select
  using (auth.uid() in (select public.trade_parties(id)));
drop policy if exists "Trade chat updatable by both parties" on public.trade_chats;
create policy "Trade chat updatable by both parties"
  on public.trade_chats for update
  using (auth.uid() in (select public.trade_parties(id)));

drop policy if exists "Trade messages visible to both parties" on public.trade_messages;
create policy "Trade messages visible to both parties"
  on public.trade_messages for select
  using (auth.uid() in (select public.trade_parties(chat_id)));
drop policy if exists "Both parties can send messages" on public.trade_messages;
create policy "Both parties can send messages"
  on public.trade_messages for insert
  with check (
    auth.uid() = sender_id
    and kind = 'user'                                   -- system messages are the server's to write
    and auth.uid() in (select public.trade_parties(chat_id))
    and (select status from public.trade_chats where id = chat_id) = 'active'  -- closed chats are read-only
  );

-- ─── F0. Public trade record: completed count ────────────
-- Defined BEFORE browse_trades/my_trades because both call it and Postgres
-- validates sql-language bodies at CREATE time (the first run of this file
-- failed on exactly that).
-- SPEC BUG (partly): the spec says "compute on the fly from trade_chats when
-- displaying a profile", but trade_chats RLS is both-parties-only — a third
-- party can't count them at all. Accountability only works if it's visible to
-- the person deciding whether to trade with you, so it goes through a definer.
create or replace function public.completed_trade_count(p_user uuid)
returns integer
language sql
security definer
stable
set search_path = ''
as $$
  select count(*)::int
  from public.trade_chats c
  join public.trade_offers o on o.id = c.offer_id
  join public.trade_listings l on l.id = o.listing_id
  where c.status = 'completed'
    and (o.offerer_id = p_user or l.user_id = p_user);
$$;
revoke execute on function public.completed_trade_count(uuid) from public, anon;
grant execute on function public.completed_trade_count(uuid) to authenticated;

-- ─── F. Browse ───────────────────────────────────────────
-- A definer RPC, not a raw select: it has to hide blocked collectors, and the
-- block check can't live in an RLS policy (a client-callable "are we blocked?"
-- would tell you who blocked you — see 022).
create or replace function public.browse_trades(p_city text default null)
returns table (
  listing_id integer, venue_id integer, venue_name text, city text, neighborhood text,
  emoji text, bg_color text, photo_url text,
  owner_id uuid, owner_name text, owner_avatar text, owner_trades integer, offer_count integer, my_offer_id integer
)
language sql
security definer
stable
set search_path = ''
as $$
  select l.id, v.id, v.name, v.city, v.neighborhood, v.emoji, v.bg_color, l.photo_url,
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
    and v.kind = 'venue'                                  -- keepsakes are not inventory
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

-- ─── G. Public trade record: the full breakdown ──────────
-- Cancellations ATTRIBUTED to this user: they backed out, or someone reported
-- they ghosted. Mutual cancels are listed but blame nobody (spec §4.8).
create or replace function public.trade_record(p_user uuid)
returns table (completed integer, cancelled integer, entries jsonb)
language sql
security definer
stable
set search_path = ''
as $$
  select
    public.completed_trade_count(p_user),
    (select count(*)::int
       from public.trade_chats c
       where c.status = 'cancelled'
         and c.cancel_reason in ('they_ghosted','i_backed_out')
         and c.cancelled_by = p_user),
    coalesce((
      select jsonb_agg(e order by e->>'at' desc)
      from (
        select jsonb_build_object(
                 'reason', c.cancel_reason,
                 'at', c.cancelled_at,
                 'by', (select pr.display_name from public.profiles pr
                          where pr.id = case when c.cancel_reason = 'they_ghosted'
                                             then (case when o.offerer_id = p_user then l.user_id else o.offerer_id end)
                                        end)
               ) as e
        from public.trade_chats c
        join public.trade_offers o on o.id = c.offer_id
        join public.trade_listings l on l.id = o.listing_id
        where c.status = 'cancelled'
          and (o.offerer_id = p_user or l.user_id = p_user)
          and (c.cancel_reason = 'mutual' or c.cancelled_by = p_user)
      ) q
    ), '[]'::jsonb);
$$;
revoke execute on function public.trade_record(uuid) from public, anon;
grant execute on function public.trade_record(uuid) to authenticated;

-- ─── H. Make an offer ────────────────────────────────────
-- Every constraint in spec §4.4 / §7 enforced server-side.
create or replace function public.make_offer(p_listing_id integer, p_venue_ids integer[], p_note text default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  l record;
  v_offer_id integer;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if p_venue_ids is null or array_length(p_venue_ids, 1) is null then
    raise exception 'pick at least one matchbook to offer';
  end if;

  select * into l from public.trade_listings where id = p_listing_id;
  if l is null then raise exception 'that listing is gone'; end if;
  if l.user_id = auth.uid() then raise exception 'you cannot offer on your own listing'; end if;
  if l.status <> 'active' then raise exception 'that listing is no longer open to offers'; end if;

  if exists (
    select 1 from public.blocks b
    where (b.blocker_id = auth.uid() and b.blocked_id = l.user_id)
       or (b.blocker_id = l.user_id and b.blocked_id = auth.uid())
  ) then
    raise exception 'that listing is gone';  -- deliberately indistinguishable from a deleted listing
  end if;

  -- You can only offer matchbooks you actually have...
  if exists (
    select 1 from unnest(p_venue_ids) as vid
    where not exists (select 1 from public.collections c where c.user_id = auth.uid() and c.venue_id = vid)
  ) then
    raise exception 'you can only offer matchbooks in your collection';
  end if;
  -- ...and not ones already committed to another trade.
  if exists (
    select 1 from public.trade_listings tl
    where tl.user_id = auth.uid() and tl.venue_id = any(p_venue_ids) and tl.status = 'in_trade'
  ) then
    raise exception 'one of those is already in an active trade';
  end if;

  insert into public.trade_offers (listing_id, offerer_id, offered_venue_ids, note)
  values (p_listing_id, auth.uid(), p_venue_ids, nullif(trim(coalesce(p_note, '')), ''))
  returning id into v_offer_id;
  return v_offer_id;
end;
$$;
revoke execute on function public.make_offer(integer, integer[], text) from public, anon;
grant execute on function public.make_offer(integer, integer[], text) to authenticated;

-- ─── I. Accept / decline ─────────────────────────────────
-- One transaction: accept this one, auto-decline the rest, lock the listing,
-- open the chat (spec §4.5).
create or replace function public.accept_offer(p_offer_id integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  o record;
  l record;
  v_chat_id integer;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  select * into o from public.trade_offers where id = p_offer_id;
  if o is null then raise exception 'that offer is gone'; end if;
  select * into l from public.trade_listings where id = o.listing_id;
  if l.user_id <> auth.uid() then raise exception 'only the listing owner can accept an offer'; end if;
  if o.status <> 'pending' then raise exception 'that offer is no longer pending'; end if;
  if l.status <> 'active' then raise exception 'this listing is already in a trade'; end if;

  update public.trade_offers set status = 'accepted' where id = p_offer_id;
  update public.trade_offers set status = 'declined'
    where listing_id = o.listing_id and id <> p_offer_id and status = 'pending';
  update public.trade_listings set status = 'in_trade' where id = o.listing_id;
  -- The offered matchbooks are committed too, so they can't be offered elsewhere.
  update public.trade_listings set status = 'in_trade'
    where user_id = o.offerer_id and venue_id = any(o.offered_venue_ids) and status = 'active';

  insert into public.trade_chats (offer_id) values (p_offer_id) returning id into v_chat_id;
  return v_chat_id;
end;
$$;
revoke execute on function public.accept_offer(integer) from public, anon;
grant execute on function public.accept_offer(integer) to authenticated;

create or replace function public.decline_offer(p_offer_id integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare o record; l record;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  select * into o from public.trade_offers where id = p_offer_id;
  if o is null then return; end if;
  select * into l from public.trade_listings where id = o.listing_id;
  -- the owner declines; the offerer withdraws
  if l.user_id = auth.uid() then
    update public.trade_offers set status = 'declined' where id = p_offer_id and status = 'pending';
  elsif o.offerer_id = auth.uid() then
    update public.trade_offers set status = 'withdrawn' where id = p_offer_id and status = 'pending';
  else
    raise exception 'not your offer';
  end if;
end;
$$;
revoke execute on function public.decline_offer(integer) from public, anon;
grant execute on function public.decline_offer(integer) to authenticated;

-- Removing a listing that has pending offers declines them all (spec §4.2 B).
create or replace function public.remove_listing(p_listing_id integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare l record;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  select * into l from public.trade_listings where id = p_listing_id;
  if l is null then return; end if;
  if l.user_id <> auth.uid() then raise exception 'not your listing'; end if;
  if l.status = 'in_trade' then
    raise exception 'this matchbook is in an active trade. Complete or cancel the trade first.';
  end if;
  update public.trade_offers set status = 'declined' where listing_id = p_listing_id and status = 'pending';
  update public.trade_listings set status = 'removed' where id = p_listing_id;
end;
$$;
revoke execute on function public.remove_listing(integer) from public, anon;
grant execute on function public.remove_listing(integer) to authenticated;

-- ─── J. Complete (two taps) ──────────────────────────────
create or replace function public.complete_trade(p_chat_id integer)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare c record; o record;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if auth.uid() not in (select public.trade_parties(p_chat_id)) then raise exception 'not your trade'; end if;
  select * into c from public.trade_chats where id = p_chat_id;
  if c.status <> 'active' then raise exception 'this trade is already closed'; end if;

  if c.completed_by is null then
    update public.trade_chats set completed_by = auth.uid() where id = p_chat_id;
    return 'waiting';
  end if;
  if c.completed_by = auth.uid() then return 'waiting'; end if;  -- your own second tap doesn't count

  update public.trade_chats set status = 'completed', completed_at = now() where id = p_chat_id;
  -- Both sides' matchbooks come off the market; the physical swap happened, and
  -- collections stay manual (spec §4.7).
  select * into o from public.trade_offers where id = c.offer_id;
  update public.trade_listings set status = 'removed' where id = o.listing_id;
  update public.trade_listings set status = 'removed'
    where user_id = o.offerer_id and venue_id = any(o.offered_venue_ids) and status = 'in_trade';
  return 'completed';
end;
$$;
revoke execute on function public.complete_trade(integer) from public, anon;
grant execute on function public.complete_trade(integer) to authenticated;

-- ─── K. Cancel ───────────────────────────────────────────
-- 'mutual' blames nobody. 'i_backed_out' is logged against the caller.
-- 'they_ghosted' is logged against the OTHER party — so cancelled_by is derived
-- here, never taken from the client, or anyone could smear anyone.
create or replace function public.cancel_trade(p_chat_id integer, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare c record; o record; l record; v_other uuid; v_blame uuid; v_msg text;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if auth.uid() not in (select public.trade_parties(p_chat_id)) then raise exception 'not your trade'; end if;
  if p_reason not in ('mutual','they_ghosted','i_backed_out') then raise exception 'unknown reason'; end if;
  select * into c from public.trade_chats where id = p_chat_id;
  if c.status <> 'active' then raise exception 'this trade is already closed'; end if;

  select * into o from public.trade_offers where id = c.offer_id;
  select * into l from public.trade_listings where id = o.listing_id;
  v_other := case when o.offerer_id = auth.uid() then l.user_id else o.offerer_id end;

  v_blame := case p_reason
               when 'mutual' then null
               when 'i_backed_out' then auth.uid()
               when 'they_ghosted' then v_other
             end;
  v_msg := case p_reason
             when 'mutual' then 'Trade cancelled by mutual agreement.'
             when 'i_backed_out' then 'Trade cancelled — the other collector backed out.'
             when 'they_ghosted' then 'Trade cancelled — reported as not followed through.'
           end;

  update public.trade_chats
    set status = 'cancelled', cancel_reason = p_reason, cancelled_by = v_blame, cancelled_at = now()
    where id = p_chat_id;

  -- Everything goes back on the market (spec §4.8).
  update public.trade_listings set status = 'active' where id = o.listing_id and status = 'in_trade';
  update public.trade_listings set status = 'active'
    where user_id = o.offerer_id and venue_id = any(o.offered_venue_ids) and status = 'in_trade';

  insert into public.trade_messages (chat_id, sender_id, content, kind)
  values (p_chat_id, auth.uid(), v_msg, 'system');
end;
$$;
revoke execute on function public.cancel_trade(integer, text) from public, anon;
grant execute on function public.cancel_trade(integer, text) to authenticated;

-- ─── L. My trades (chat list + badge) ────────────────────
create or replace function public.my_trades()
returns table (
  chat_id integer, status text, other_id uuid, other_name text, other_avatar text, other_trades integer,
  listing_venue text, listing_emoji text, offered_names text[], is_mine boolean,
  completed_by uuid, last_at timestamptz
)
language sql
security definer
stable
set search_path = ''
as $$
  select c.id, c.status,
         case when o.offerer_id = auth.uid() then l.user_id else o.offerer_id end,
         (select pr.display_name from public.profiles pr where pr.id = case when o.offerer_id = auth.uid() then l.user_id else o.offerer_id end),
         (select pr.avatar_url  from public.profiles pr where pr.id = case when o.offerer_id = auth.uid() then l.user_id else o.offerer_id end),
         public.completed_trade_count(case when o.offerer_id = auth.uid() then l.user_id else o.offerer_id end),
         lv.name, lv.emoji,
         (select array_agg(ov.name) from public.venues ov where ov.id = any(o.offered_venue_ids)),
         (l.user_id = auth.uid()),
         c.completed_by,
         coalesce((select max(m.created_at) from public.trade_messages m where m.chat_id = c.id), c.created_at)
  from public.trade_chats c
  join public.trade_offers o on o.id = c.offer_id
  join public.trade_listings l on l.id = o.listing_id
  join public.venues lv on lv.id = l.venue_id
  where auth.uid() in (o.offerer_id, l.user_id)
  order by coalesce((select max(m.created_at) from public.trade_messages m where m.chat_id = c.id), c.created_at) desc;
$$;
revoke execute on function public.my_trades() from public, anon;
grant execute on function public.my_trades() to authenticated;

-- Offers sitting on MY listings — the bid inbox, and the badge count.
create or replace function public.listing_offers(p_listing_id integer)
returns table (
  offer_id integer, offerer_id uuid, offerer_name text, offerer_avatar text, offerer_trades integer,
  offered_venue_ids integer[], offered_names text[], offered_emojis text[], note text, created_at timestamptz
)
language sql
security definer
stable
set search_path = ''
as $$
  select o.id, o.offerer_id, p.display_name, p.avatar_url, public.completed_trade_count(o.offerer_id),
         o.offered_venue_ids,
         (select array_agg(v.name  order by v.name) from public.venues v where v.id = any(o.offered_venue_ids)),
         (select array_agg(v.emoji order by v.name) from public.venues v where v.id = any(o.offered_venue_ids)),
         o.note, o.created_at
  from public.trade_offers o
  join public.trade_listings l on l.id = o.listing_id
  join public.profiles p on p.id = o.offerer_id
  where o.listing_id = p_listing_id
    and l.user_id = auth.uid()
    and o.status = 'pending'
  order by o.created_at asc;
$$;
revoke execute on function public.listing_offers(integer) from public, anon;
grant execute on function public.listing_offers(integer) to authenticated;

-- Pending-offer counts across all my listings, for the For Trade badges.
create or replace function public.my_listing_offer_counts()
returns table (listing_id integer, pending integer)
language sql
security definer
stable
set search_path = ''
as $$
  select l.id, (select count(*)::int from public.trade_offers o where o.listing_id = l.id and o.status = 'pending')
  from public.trade_listings l
  where l.user_id = auth.uid() and l.status <> 'removed';
$$;
revoke execute on function public.my_listing_offer_counts() from public, anon;
grant execute on function public.my_listing_offer_counts() to authenticated;
