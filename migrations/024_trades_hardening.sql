-- Migration 024 — trades hardening. Run ONCE in the SQL editor (after 023). Idempotent.
--
-- The 023 review (30 agents, 24 confirmed findings) found one root cause with
-- many faces: the RPCs enforce every trade rule, but the TABLES were still
-- directly writable — so a party could PATCH trade_chats to forge a 'they_
-- ghosted' blame onto their counterparty or fake a completed trade, DELETE
-- their own listing to cascade-erase a blame record, or INSERT offers straight
-- past the block check. Same class as the is_admin hole 014 fixed: RLS gates
-- WHICH ROWS, not which columns or values. The fix is the same shape too —
-- revoke the grants and make the definer RPCs the only writers.

-- ─── A. The RPCs are the ONLY writers ────────────────────
-- Definer functions run as the table owner, so none of this touches them.
revoke insert, update, delete on public.trade_chats    from authenticated;
revoke insert, update, delete on public.trade_offers   from authenticated;
revoke update, delete         on public.trade_messages from authenticated; -- INSERT stays: the send path, policy-gated (sender + party + active + kind='user')
revoke insert, update, delete on public.trade_listings from authenticated;
-- The one client write that's legitimately direct: your own listing's photo.
grant update (photo_url) on public.trade_listings to authenticated;

-- ─── B. Listing lifecycle goes through an RPC ────────────
-- The client used to upsert {status:'active'} directly, which could flip an
-- in_trade listing back to active (two live trades on one matchbook), and let
-- you list a venue you never collected — or a keepsake.
create or replace function public.list_for_trade(p_venue_id integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing record;
  v_id integer;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if not exists (select 1 from public.collections c where c.user_id = auth.uid() and c.venue_id = p_venue_id) then
    raise exception 'you can only list matchbooks in your collection';
  end if;
  if not exists (select 1 from public.venues v where v.id = p_venue_id and v.kind = 'venue') then
    raise exception 'keepsakes cannot be listed for trade';
  end if;

  select * into existing from public.trade_listings
    where user_id = auth.uid() and venue_id = p_venue_id;
  if existing.id is not null then
    if existing.status = 'in_trade' then
      raise exception 'this matchbook is in an active trade';
    end if;
    update public.trade_listings set status = 'active' where id = existing.id;
    return existing.id;
  end if;
  insert into public.trade_listings (user_id, venue_id) values (auth.uid(), p_venue_id)
  returning id into v_id;
  return v_id;
end;
$$;
revoke execute on function public.list_for_trade(integer) from public, anon;
grant execute on function public.list_for_trade(integer) to authenticated;

-- ─── C. A matchbook commits to ONE trade at a time ───────
-- 023 locked only the offerer's LISTED matchbooks on accept; an unlisted one
-- could ride two accepted trades at once. Both ends now check active-chat
-- membership, and accept_offer takes a row lock to kill the two-owners-accept-
-- simultaneously race (TOCTOU found in review).
create or replace function public.venue_in_active_trade(p_user uuid, p_venue_ids integer[])
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.trade_offers o
    join public.trade_chats c on c.offer_id = o.id
    where c.status = 'active'
      and o.status = 'accepted'
      and o.offerer_id = p_user
      and o.offered_venue_ids && p_venue_ids
  ) or exists (
    select 1
    from public.trade_listings l
    where l.user_id = p_user and l.venue_id = any(p_venue_ids) and l.status = 'in_trade'
  );
$$;
revoke execute on function public.venue_in_active_trade(uuid, integer[]) from public, anon, authenticated;

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

  if exists (
    select 1 from unnest(p_venue_ids) as vid
    where not exists (select 1 from public.collections c where c.user_id = auth.uid() and c.venue_id = vid)
  ) then
    raise exception 'you can only offer matchbooks in your collection';
  end if;
  if public.venue_in_active_trade(auth.uid(), p_venue_ids) then
    raise exception 'one of those is already in an active trade';
  end if;

  insert into public.trade_offers (listing_id, offerer_id, offered_venue_ids, note)
  values (p_listing_id, auth.uid(), p_venue_ids, nullif(trim(coalesce(p_note, '')), ''))
  returning id into v_offer_id;
  return v_offer_id;
end;
$$;

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
  -- FOR UPDATE serializes concurrent accepts on the same listing: the second
  -- transaction blocks here, then sees status='in_trade' and fails cleanly.
  select * into l from public.trade_listings where id = o.listing_id for update;
  if l.user_id <> auth.uid() then raise exception 'only the listing owner can accept an offer'; end if;
  if o.status <> 'pending' then raise exception 'that offer is no longer pending'; end if;
  if l.status <> 'active' then raise exception 'this listing is already in a trade'; end if;
  -- The offerer's matchbooks may have entered another trade since they offered.
  if public.venue_in_active_trade(o.offerer_id, o.offered_venue_ids) then
    raise exception 'part of that offer is already in another active trade — decline it';
  end if;

  update public.trade_offers set status = 'accepted' where id = p_offer_id;
  update public.trade_offers set status = 'declined'
    where listing_id = o.listing_id and id <> p_offer_id and status = 'pending';
  update public.trade_listings set status = 'in_trade' where id = o.listing_id;
  update public.trade_listings set status = 'in_trade'
    where user_id = o.offerer_id and venue_id = any(o.offered_venue_ids) and status = 'active';

  insert into public.trade_chats (offer_id) values (p_offer_id) returning id into v_chat_id;
  return v_chat_id;
end;
$$;

-- ─── D. 'Mutual' takes two ───────────────────────────────
-- Review: a backer-outer could pick 'mutual' unilaterally and dodge all blame.
-- Now the blameless exit needs both parties — first call proposes (system
-- message), the other party's mutual call completes it. The unilateral exits
-- (i_backed_out, they_ghosted) still work alone because they carry blame.
alter table public.trade_chats add column if not exists mutual_requested_by uuid references auth.users(id);

drop function if exists public.cancel_trade(integer, text);
create function public.cancel_trade(p_chat_id integer, p_reason text)
returns text
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

  if p_reason = 'mutual' and (c.mutual_requested_by is null or c.mutual_requested_by = auth.uid()) then
    if c.mutual_requested_by is null then
      update public.trade_chats set mutual_requested_by = auth.uid() where id = p_chat_id;
      insert into public.trade_messages (chat_id, sender_id, content, kind)
      values (p_chat_id, auth.uid(),
              (select display_name from public.profiles where id = auth.uid()) || ' proposed cancelling by mutual agreement.',
              'system');
    end if;
    return 'proposed';
  end if;

  -- Ghost reports need the trade to have actually had time to be ghosted.
  if p_reason = 'they_ghosted' and c.created_at > now() - interval '48 hours' then
    raise exception 'give it at least 48 hours before reporting a no-show';
  end if;

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
  update public.trade_listings set status = 'active' where id = o.listing_id and status = 'in_trade';
  update public.trade_listings set status = 'active'
    where user_id = o.offerer_id and venue_id = any(o.offered_venue_ids) and status = 'in_trade';
  insert into public.trade_messages (chat_id, sender_id, content, kind)
  values (p_chat_id, auth.uid(), v_msg, 'system');
  return 'cancelled';
end;
$$;
revoke execute on function public.cancel_trade(integer, text) from public, anon;
grant execute on function public.cancel_trade(integer, text) to authenticated;

-- ─── E. Blocking ends the relationship, trades included ──
-- Review: blocking mid-trade left the chat open — the blocked person could keep
-- messaging you. A block now declines pending offers between the pair and hard-
-- cancels active chats (blameless: block ≠ trade fault), on top of 022's
-- follow-severing. Recreates 022's function body plus the trade teardown.
create or replace function public.block_user(target uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare ch record;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if target is null or target = auth.uid() then raise exception 'you cannot block yourself'; end if;

  insert into public.blocks (blocker_id, blocked_id)
  values (auth.uid(), target)
  on conflict do nothing;

  delete from public.follows
  where (follower_id = auth.uid() and following_id = target)
     or (follower_id = target and following_id = auth.uid());

  -- pending offers between the pair, both directions
  update public.trade_offers o set status = 'declined'
  from public.trade_listings l
  where o.listing_id = l.id and o.status = 'pending'
    and ((o.offerer_id = auth.uid() and l.user_id = target)
      or (o.offerer_id = target and l.user_id = auth.uid()));

  -- active chats between the pair: blameless cancel + everything off hold
  for ch in
    select c.id, o.listing_id, o.offerer_id, o.offered_venue_ids
    from public.trade_chats c
    join public.trade_offers o on o.id = c.offer_id
    join public.trade_listings l on l.id = o.listing_id
    where c.status = 'active'
      and ((o.offerer_id = auth.uid() and l.user_id = target)
        or (o.offerer_id = target and l.user_id = auth.uid()))
  loop
    update public.trade_chats
      set status = 'cancelled', cancel_reason = 'mutual', cancelled_at = now()
      where id = ch.id;
    update public.trade_listings set status = 'active' where id = ch.listing_id and status = 'in_trade';
    update public.trade_listings set status = 'active'
      where user_id = ch.offerer_id and venue_id = any(ch.offered_venue_ids) and status = 'in_trade';
    insert into public.trade_messages (chat_id, sender_id, content, kind)
    values (ch.id, auth.uid(), 'Trade cancelled.', 'system');
  end loop;
end;
$$;
revoke execute on function public.block_user(uuid) from public, anon;
grant execute on function public.block_user(uuid) to authenticated;

-- ─── F. Venue deletion cancels trades instead of vaporising them ──
-- Spec §7: "active chats get a system message: the venue was removed, the trade
-- has been cancelled." Without this trigger the FK cascade silently destroyed
-- the chats. Fires BEFORE the cascade, so the system message lands and then the
-- rows go. (Completed chats on a deleted venue still cascade away — accepted at
-- beta and noted; venue deletion is rare and admin/creator-only.)
create or replace function public.cancel_trades_for_deleted_venue()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare ch record;
begin
  for ch in
    select c.id, l.user_id as owner_id, o.offerer_id, o.offered_venue_ids, o.listing_id
    from public.trade_listings l
    join public.trade_offers o on o.listing_id = l.id
    join public.trade_chats c on c.offer_id = o.id
    where l.venue_id = old.id and c.status = 'active'
  loop
    update public.trade_chats
      set status = 'cancelled', cancel_reason = 'mutual', cancelled_at = now()
      where id = ch.id;
    -- free the offerer's other matchbooks (their listings on OTHER venues survive)
    update public.trade_listings set status = 'active'
      where user_id = ch.offerer_id and venue_id = any(ch.offered_venue_ids)
        and venue_id <> old.id and status = 'in_trade';
    insert into public.trade_messages (chat_id, sender_id, content, kind)
    values (ch.id, ch.owner_id, 'This venue was removed from phillumeni. The trade has been cancelled.', 'system');
  end loop;
  return old;
end;
$$;
drop trigger if exists on_venue_delete_cancel_trades on public.venues;
create trigger on_venue_delete_cancel_trades
  before delete on public.venues
  for each row execute function public.cancel_trades_for_deleted_venue();

-- ─── G. Richer reads the client now needs ────────────────
-- my_trades gains mutual_requested_by (to label the agree-to-cancel option) and
-- my_msgs (badge: an accepted offer = a chat you haven't spoken in yet).
drop function if exists public.my_trades();
create function public.my_trades()
returns table (
  chat_id integer, status text, other_id uuid, other_name text, other_avatar text, other_trades integer,
  listing_venue text, listing_emoji text, offered_names text[], is_mine boolean,
  completed_by uuid, mutual_requested_by uuid, my_msgs integer, last_at timestamptz
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
         c.completed_by, c.mutual_requested_by,
         (select count(*)::int from public.trade_messages m where m.chat_id = c.id and m.sender_id = auth.uid() and m.kind = 'user'),
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

-- listing_offers gains the offered matchbooks' trade photos, so the owner isn't
-- accepting condition-blind (spec §4.4 shows a photo badge per offered item).
drop function if exists public.listing_offers(integer);
create function public.listing_offers(p_listing_id integer)
returns table (
  offer_id integer, offerer_id uuid, offerer_name text, offerer_avatar text, offerer_trades integer,
  offered_venue_ids integer[], offered_names text[], offered_emojis text[], offered_photos text[],
  note text, created_at timestamptz
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
         (select array_agg(coalesce(tl.photo_url, '') order by v.name)
            from public.venues v
            left join public.trade_listings tl on tl.user_id = o.offerer_id and tl.venue_id = v.id
            where v.id = any(o.offered_venue_ids)),
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

-- ─── H. Account deletion must not destroy (or be blocked by) trade history ──
-- Two defects in 023's FK wiring:
--   1. cancelled_by/completed_by/mutual_requested_by reference auth.users with
--      NO on-delete action — so delete_my_account (an App Store REQUIREMENT)
--      hard-fails for any user who was ever blamed or tapped complete.
--   2. listings/offers/messages CASCADE — a departing user's trades vaporise,
--      silently rewriting their counterparties' public records.
-- Both become SET NULL: the departed user's side reads as "a departed
-- collector", the counterparty's history and counts survive intact.
do $$ begin
  alter table public.trade_listings alter column user_id drop not null;
  alter table public.trade_listings drop constraint if exists trade_listings_user_id_fkey;
  alter table public.trade_listings add constraint trade_listings_user_id_fkey
    foreign key (user_id) references auth.users(id) on delete set null;

  alter table public.trade_offers alter column offerer_id drop not null;
  alter table public.trade_offers drop constraint if exists trade_offers_offerer_id_fkey;
  alter table public.trade_offers add constraint trade_offers_offerer_id_fkey
    foreign key (offerer_id) references auth.users(id) on delete set null;

  alter table public.trade_messages alter column sender_id drop not null;
  alter table public.trade_messages drop constraint if exists trade_messages_sender_id_fkey;
  alter table public.trade_messages add constraint trade_messages_sender_id_fkey
    foreign key (sender_id) references auth.users(id) on delete set null;

  alter table public.trade_chats drop constraint if exists trade_chats_cancelled_by_fkey;
  alter table public.trade_chats add constraint trade_chats_cancelled_by_fkey
    foreign key (cancelled_by) references auth.users(id) on delete set null;
  alter table public.trade_chats drop constraint if exists trade_chats_completed_by_fkey;
  alter table public.trade_chats add constraint trade_chats_completed_by_fkey
    foreign key (completed_by) references auth.users(id) on delete set null;
  alter table public.trade_chats drop constraint if exists trade_chats_mutual_requested_by_fkey;
  alter table public.trade_chats add constraint trade_chats_mutual_requested_by_fkey
    foreign key (mutual_requested_by) references auth.users(id) on delete set null;
end $$;

-- ─── I. Declined offers are discoverable (spec §5, minus push) ──
-- The offerer had NO way to learn their offer was declined — it just silently
-- stopped appearing. offerer_seen_at is the read-receipt: unseen resolved
-- offers count toward the badge, and opening My trades marks them seen.
alter table public.trade_offers add column if not exists offerer_seen_at timestamptz;

create or replace function public.my_offers()
returns table (
  offer_id integer, status text, venue_name text, venue_emoji text,
  owner_name text, created_at timestamptz, seen boolean
)
language sql
security definer
stable
set search_path = ''
as $$
  select o.id, o.status, v.name, v.emoji,
         coalesce(p.display_name, 'a departed collector'),
         o.created_at, (o.offerer_seen_at is not null)
  from public.trade_offers o
  join public.trade_listings l on l.id = o.listing_id
  join public.venues v on v.id = l.venue_id
  left join public.profiles p on p.id = l.user_id
  where o.offerer_id = auth.uid()
  order by o.created_at desc
  limit 30;
$$;
revoke execute on function public.my_offers() from public, anon;
grant execute on function public.my_offers() to authenticated;

create or replace function public.mark_offers_seen()
returns void
language sql
security definer
set search_path = ''
as $$
  update public.trade_offers
    set offerer_seen_at = now()
    where offerer_id = auth.uid() and offerer_seen_at is null and status <> 'pending';
$$;
revoke execute on function public.mark_offers_seen() from public, anon;
grant execute on function public.mark_offers_seen() to authenticated;

-- ─── J. Completed-trade chips on the record (spec §4.9) ──
-- trade_record gains the green chips block: the venue of each completed trade,
-- newest first. Same drop/recreate dance as always for a return-shape change.
drop function if exists public.trade_record(uuid);
create function public.trade_record(p_user uuid)
returns table (completed integer, cancelled integer, entries jsonb, chips jsonb)
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
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(jsonb_build_object('emoji', v.emoji, 'name', v.name) order by c.completed_at desc)
      from public.trade_chats c
      join public.trade_offers o on o.id = c.offer_id
      join public.trade_listings l on l.id = o.listing_id
      join public.venues v on v.id = l.venue_id
      where c.status = 'completed'
        and (o.offerer_id = p_user or l.user_id = p_user)
    ), '[]'::jsonb);
$$;
revoke execute on function public.trade_record(uuid) from public, anon;
grant execute on function public.trade_record(uuid) to authenticated;

-- ─── K. Report a trade chat (spec §7) ────────────────────
-- Routes to human review like fake_reports, but its OWN table — fake_reports'
-- admin Accept action DELETES THE VENUE, which would be a catastrophic action
-- to wire to a conversation report. Names + excerpt are denormalised so the
-- report survives the chat being cancelled or cascaded away.
create table if not exists public.chat_reports (
  id serial primary key,
  reporter_id uuid references auth.users(id) on delete cascade not null,
  reported_id uuid references auth.users(id) on delete set null,
  reported_name text,
  chat_id integer references public.trade_chats(id) on delete set null,
  detail text,
  status text not null default 'pending' check (status in ('pending','resolved')),
  created_at timestamptz default now()
);
alter table public.chat_reports enable row level security;

drop policy if exists "Reporters see their own chat reports" on public.chat_reports;
create policy "Reporters see their own chat reports"
  on public.chat_reports for select using (auth.uid() = reporter_id or public.is_admin());
drop policy if exists "Parties can report their chats" on public.chat_reports;
create policy "Parties can report their chats"
  on public.chat_reports for insert
  with check (
    auth.uid() = reporter_id
    and auth.uid() in (select public.trade_parties(chat_id))
  );
drop policy if exists "Admins resolve chat reports" on public.chat_reports;
create policy "Admins resolve chat reports"
  on public.chat_reports for update using (public.is_admin()) with check (public.is_admin());
