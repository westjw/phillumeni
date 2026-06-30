-- Migration 007 — adopt the Submit & Ranking spec (foundation)
-- Run ONCE in the Supabase SQL editor. Idempotent.

-- ─── §0/§1: ZERO SEED DATA — delete every seeded venue ──────────────────
-- Real submissions always have created_by set (RLS requires it); the 45 seeds
-- have created_by = null. on-delete-cascade removes any collections/reports
-- pointing at them. Virginia's (#46) and any future real submission survive.
delete from public.venues where created_by is null;

-- ─── §2: manual-entry marker ────────────────────────────────────────────
alter table public.venues add column if not exists added_manually boolean default false;

-- ─── §3: ranking — per-user Elo score on each collected venue ───────────
alter table public.collections add column if not exists score numeric(3,1);

-- Ranking (and the multi-photo re-collect path) write to a user's own rows,
-- which needs an UPDATE policy collections never had.
drop policy if exists "Users can update their own collections" on public.collections;
create policy "Users can update their own collections"
  on public.collections for update using (auth.uid() = user_id);

create table if not exists public.comparisons (
  id serial primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  winner_venue_id integer references public.venues(id) on delete cascade not null,
  loser_venue_id integer references public.venues(id) on delete cascade not null,
  created_at timestamptz default now()
);
alter table public.comparisons enable row level security;
drop policy if exists "Users can view their own comparisons" on public.comparisons;
create policy "Users can view their own comparisons"
  on public.comparisons for select using (auth.uid() = user_id);
drop policy if exists "Users can log their own comparisons" on public.comparisons;
create policy "Users can log their own comparisons"
  on public.comparisons for insert with check (auth.uid() = user_id);

-- ─── §5/Phase E: admin flag (gates the moderation screens) ──────────────
alter table public.profiles add column if not exists is_admin boolean default false;

-- ─── §4: fake-photo reports (fraud claims → human review) ───────────────
create table if not exists public.fake_reports (
  id serial primary key,
  reporter_id uuid references auth.users(id) on delete cascade not null,
  venue_id integer references public.venues(id) on delete cascade not null,
  reason text,
  status text not null default 'pending' check (status in ('pending','accepted','rejected')),
  resolved_by uuid references auth.users(id),
  resolved_at timestamptz,
  created_at timestamptz default now()
);
alter table public.fake_reports enable row level security;

-- NOTE: the spec says "viewable by everyone"; we deviate to match the lock-down
-- decision (#19) — reads are scoped to the reporter, plus admins (below).
drop policy if exists "Reporters can view their own fake reports" on public.fake_reports;
create policy "Reporters can view their own fake reports"
  on public.fake_reports for select using (auth.uid() = reporter_id);
drop policy if exists "Authenticated users can file a fake report" on public.fake_reports;
create policy "Authenticated users can file a fake report"
  on public.fake_reports for insert with check (auth.uid() = reporter_id);

-- Admins (profiles.is_admin) can read every report and resolve it.
drop policy if exists "Admins can view all fake reports" on public.fake_reports;
create policy "Admins can view all fake reports"
  on public.fake_reports for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));
drop policy if exists "Admins can resolve fake reports" on public.fake_reports;
create policy "Admins can resolve fake reports"
  on public.fake_reports for update
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

-- Admins can delete any venue (the "Accept — remove" moderation action).
drop policy if exists "Admins can delete any venue" on public.venues;
create policy "Admins can delete any venue"
  on public.venues for delete
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

-- ─── Make YOURSELF admin — run this with your real app-login email ──────
-- update public.profiles set is_admin = true
--   where id = (select id from auth.users where email = 'wyethwest@gmail.com');
