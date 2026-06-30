-- Migration 014 — SECURITY: stop users writing privileged profile columns.
-- Run ONCE in the Supabase SQL editor (do this ASAP — it's a real escalation).
--
-- The "Users can update their own profile" RLS policy gates WHICH ROW you can
-- edit (your own) but not WHICH COLUMNS. profiles.is_admin is a real auth
-- boundary (RLS admin checks trust it), so any logged-in user could run
-- `update profiles set is_admin = true where id = auth.uid()` and take over
-- moderation (incl. deleting any venue, which cascades away everyone's data).
--
-- Fix: column-scoped UPDATE grant. RLS still restricts to the owner's row; the
-- grant restricts which columns that owner may change — is_admin and id are
-- excluded, so they can never be set from the client (only via SQL/service role).

revoke update on public.profiles from authenticated;
grant update (username, display_name, bio, home_city, referred_by)
  on public.profiles to authenticated;
