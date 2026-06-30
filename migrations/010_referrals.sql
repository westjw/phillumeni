-- Migration 010 — invite/referral attribution for the "Invite friends" link.
-- Run ONCE in the Supabase SQL editor. Idempotent.
--
-- The invite link is {origin}/?invite=<inviter user id>. When the referred
-- person first authenticates, the client sets profiles.referred_by = that id
-- (once, only while it's null). Keyed on the stable user id, NOT username —
-- usernames get suffixed on collision and can be reused after deletion.
-- NOTE: referred_by is client-written free text, so the count is an advisory
-- vanity metric — never gate rewards/leaderboards on it without server validation.

alter table public.profiles add column if not exists referred_by text;

-- How many people I referred. profiles are owner-only SELECT (lock-down #19), so
-- this needs a SECURITY DEFINER aggregate. Returns just a count — no identities.
create or replace function public.my_referral_count()
returns integer
language sql
security definer
stable
set search_path = ''
as $$
  select count(*)::int
  from public.profiles
  where referred_by = auth.uid()::text
    and id <> auth.uid();
$$;

revoke execute on function public.my_referral_count() from public;
grant execute on function public.my_referral_count() to authenticated;
