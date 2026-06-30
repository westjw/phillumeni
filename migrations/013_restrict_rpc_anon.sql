-- Migration 013 — actually restrict the SECURITY DEFINER RPCs to authenticated.
-- Run ONCE in the Supabase SQL editor, AFTER 012.
--
-- WHY: Supabase's default privileges grant EXECUTE on every new public-schema
-- function DIRECTLY to the `anon` role (not via PUBLIC). So the `revoke execute
-- ... from public` in migrations 009-012 did NOT remove anon's access — verified
-- live: an anon key could still call venue_photos() and search_collectors().
-- This revokes the direct anon grant. `authenticated` keeps its own grant.
--
-- is_admin() is intentionally NOT revoked: it's evaluated inside RLS policies
-- (profiles/fake_reports/venues), so every querying role must be able to execute
-- it, and it safely returns false for anon.

revoke execute on function public.venue_photos(integer) from anon;
revoke execute on function public.my_referral_count() from anon;
revoke execute on function public.following_list() from anon;
revoke execute on function public.search_collectors(text) from anon;
revoke execute on function public.friends_rankings() from anon;
