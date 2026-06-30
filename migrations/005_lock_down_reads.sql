-- Migration 005 — lock down world-readable tables (review #19)
-- Run ONCE in the Supabase SQL editor. Idempotent.
--
-- Flips the `using (true)` SELECT policies on per-user tables to owner-only, so
-- the publishable/anon key can no longer enumerate who collected what or read
-- other users' profiles. venues stays public (it's the shared map).
-- No app change needed: the client already reads only its own rows.
-- The close_venue_if_reported() trigger counts reports via SECURITY DEFINER,
-- which bypasses RLS, so auto-close is unaffected.

-- ─── collections: own only ───────────────────────────────
drop policy if exists "Users can view all collections" on public.collections;
drop policy if exists "Users can view their own collections" on public.collections;
create policy "Users can view their own collections"
  on public.collections for select using (auth.uid() = user_id);

-- ─── reports: own only ───────────────────────────────────
drop policy if exists "Reports viewable by everyone" on public.reports;
drop policy if exists "Users can view their own reports" on public.reports;
create policy "Users can view their own reports"
  on public.reports for select using (auth.uid() = user_id);

-- ─── profiles: own only ──────────────────────────────────
drop policy if exists "Profiles are viewable by everyone" on public.profiles;
drop policy if exists "Users can view their own profile" on public.profiles;
create policy "Users can view their own profile"
  on public.profiles for select using (auth.uid() = id);

-- ─── follows: only rows involving you ────────────────────
drop policy if exists "Follows viewable by everyone" on public.follows;
drop policy if exists "Users can view their own follows" on public.follows;
create policy "Users can view their own follows"
  on public.follows for select using (auth.uid() = follower_id or auth.uid() = following_id);
