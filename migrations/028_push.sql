-- Migration 028 — push notifications (build 8). Run ONCE in the SQL editor. Idempotent.
--
-- Architecture (outbox pattern):
--   1. Each device registers its APNs token via register_device_token (client).
--   2. Trade events fire SQL triggers that INSERT a fully-formed message into
--      push_outbox (recipient + title + body + deep-link data) — the triggers
--      have all the join context, so the sender stays dumb and unspoofable.
--   3. A Supabase Database Webhook on push_outbox INSERT calls the `push` Edge
--      Function, which looks up the recipient's tokens and delivers via APNs.
--
-- Push is ENCOURAGED, never required (App Store 4.5.4): the in-app trade badge
-- remains the guaranteed path; this just makes it timely.

-- ─── A. Device tokens ────────────────────────────────────
create table if not exists public.device_tokens (
  token text primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  platform text not null default 'ios',
  environment text not null default 'production'  -- 'production' (TestFlight/App Store) | 'sandbox' (dev build)
    check (environment in ('production','sandbox')),
  updated_at timestamptz default now()
);
alter table public.device_tokens enable row level security;

-- Owner-only: you can see and remove your own device registrations, nothing else.
drop policy if exists "Users see their own device tokens" on public.device_tokens;
create policy "Users see their own device tokens"
  on public.device_tokens for select using (auth.uid() = user_id);
drop policy if exists "Users remove their own device tokens" on public.device_tokens;
create policy "Users remove their own device tokens"
  on public.device_tokens for delete using (auth.uid() = user_id);

-- Register / refresh this device's token (a token can migrate between users on a
-- shared device, so on conflict we reassign it to the current user).
create or replace function public.register_device_token(p_token text, p_environment text default 'production')
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if p_token is null or length(trim(p_token)) = 0 then raise exception 'empty token'; end if;
  insert into public.device_tokens (token, user_id, environment, updated_at)
  values (p_token, auth.uid(), coalesce(nullif(p_environment,''), 'production'), now())
  on conflict (token) do update
    set user_id = auth.uid(), environment = excluded.environment, updated_at = now();
end;
$$;
revoke execute on function public.register_device_token(text, text) from public, anon;
grant execute on function public.register_device_token(text, text) to authenticated;

create or replace function public.unregister_device_token(p_token text)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.device_tokens where token = p_token and user_id = auth.uid();
$$;
revoke execute on function public.unregister_device_token(text) from public, anon;
grant execute on function public.unregister_device_token(text) to authenticated;

-- ─── B. Outbox ───────────────────────────────────────────
-- No client access at all — SQL triggers write it, the Edge Function (service
-- role) reads and marks it. That's why a client can't forge a notification.
create table if not exists public.push_outbox (
  id bigserial primary key,
  recipient_id uuid references auth.users(id) on delete cascade not null,
  title text not null,
  body text not null,
  data jsonb not null default '{}',
  created_at timestamptz default now(),
  sent_at timestamptz,
  error text
);
alter table public.push_outbox enable row level security;
-- (no policies → only service_role, which bypasses RLS, can touch it)

-- ─── C. Trade-event triggers → outbox ────────────────────
-- New offer on your listing → notify the listing owner.
create or replace function public.push_on_new_offer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare v_owner uuid; v_venue text; v_from text;
begin
  if new.status <> 'pending' then return new; end if;
  select l.user_id, v.name into v_owner, v_venue
  from public.trade_listings l join public.venues v on v.id = l.venue_id
  where l.id = new.listing_id;
  select coalesce(display_name, 'A collector') into v_from from public.profiles where id = new.offerer_id;
  if v_owner is null or v_owner = new.offerer_id then return new; end if;
  insert into public.push_outbox (recipient_id, title, body, data)
  values (v_owner, 'New trade offer',
          v_from || ' offered a trade on ' || coalesce(v_venue, 'your matchbook'),
          jsonb_build_object('type','offer','listing_id',new.listing_id));
  return new;
end;
$$;
drop trigger if exists on_offer_push on public.trade_offers;
create trigger on_offer_push after insert on public.trade_offers
  for each row execute function public.push_on_new_offer();

-- Offer accepted (a chat is born) → notify the offerer.
create or replace function public.push_on_accept()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare o record; v_owner_name text; v_venue text;
begin
  select * into o from public.trade_offers where id = new.offer_id;
  select p.display_name, v.name into v_owner_name, v_venue
  from public.trade_listings l join public.venues v on v.id = l.venue_id
  join public.profiles p on p.id = l.user_id
  where l.id = o.listing_id;
  insert into public.push_outbox (recipient_id, title, body, data)
  values (o.offerer_id, 'Offer accepted 🔥',
          coalesce(v_owner_name,'The owner') || ' accepted your offer on ' || coalesce(v_venue,'a matchbook') || ' — chat''s open.',
          jsonb_build_object('type','accept','chat_id',new.id));
  return new;
end;
$$;
drop trigger if exists on_accept_push on public.trade_chats;
create trigger on_accept_push after insert on public.trade_chats
  for each row execute function public.push_on_accept();

-- Trade completed / cancelled → notify the OTHER party (the one who didn't
-- trigger it). completed_by / cancelled_by tells us who acted.
create or replace function public.push_on_chat_close()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare o record; l record; v_actor uuid; v_other uuid; v_venue text;
begin
  if new.status = old.status then return new; end if;
  if new.status not in ('completed','cancelled') then return new; end if;
  select * into o from public.trade_offers where id = new.offer_id;
  select * into l from public.trade_listings where id = o.listing_id;
  select v.name into v_venue from public.venues v where v.id = l.venue_id;
  v_actor := coalesce(new.completed_by, new.cancelled_by);
  v_other := case when v_actor = o.offerer_id then l.user_id else o.offerer_id end;
  if v_other is null then return new; end if;
  if new.status = 'completed' then
    insert into public.push_outbox (recipient_id, title, body, data)
    values (v_other, 'Trade complete 🤝',
            'Your trade for ' || coalesce(v_venue,'a matchbook') || ' is done.',
            jsonb_build_object('type','complete','chat_id',new.id));
  else
    insert into public.push_outbox (recipient_id, title, body, data)
    values (v_other, 'Trade cancelled',
            'Your trade for ' || coalesce(v_venue,'a matchbook') || ' was cancelled.',
            jsonb_build_object('type','cancel','chat_id',new.id));
  end if;
  return new;
end;
$$;
drop trigger if exists on_chat_close_push on public.trade_chats;
create trigger on_chat_close_push after update on public.trade_chats
  for each row execute function public.push_on_chat_close();

-- ─── D. Sender's view of the outbox ──────────────────────
-- The Edge Function runs as service_role (bypasses RLS) so it reads push_outbox
-- and device_tokens directly. Nothing here is client-callable.
