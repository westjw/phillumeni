-- Migration 003 — venue dedup (mapbox_id) + closure lifecycle
-- Run ONCE in the Supabase SQL editor (after 001 & 002). Idempotent.

-- ─── A. Dedup: one venue per Mapbox POI ──────────────────
-- mapbox_id is the stable Search Box POI id. Unique so two submissions of the
-- same place link to one venue. NULLs stay distinct, so the hand-seeded rows
-- (which have no mapbox_id) are unaffected.
alter table public.venues add column if not exists mapbox_id text;
create unique index if not exists venues_mapbox_id_key on public.venues (mapbox_id);

-- ─── B. Closure lifecycle ────────────────────────────────
-- status is distinct from is_open (which is "open right now / hours").
alter table public.venues add column if not exists status text not null default 'active';
alter table public.venues add column if not exists closed_at timestamptz;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'venues_status_chk') then
    alter table public.venues add constraint venues_status_chk check (status in ('active','closed'));
  end if;
end $$;

-- Auto-close a venue once enough DISTINCT users report it unavailable.
-- reports has unique(user_id, venue_id), so count(*) = distinct reporters.
-- SECURITY DEFINER lets it update venues with no client-facing UPDATE policy.
-- THRESHOLD is deliberately low for a small beta — raise it as users grow
-- (it gates how easily a few accounts can retire a venue).
create or replace function public.close_venue_if_reported()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  reporter_count int;
  threshold constant int := 3;
begin
  select count(*) into reporter_count from public.reports where venue_id = new.venue_id;
  if reporter_count >= threshold then
    update public.venues
      set status = 'closed', closed_at = coalesce(closed_at, now())
      where id = new.venue_id and status <> 'closed';
  end if;
  return new;
end;
$$;

drop trigger if exists on_report_close_check on public.reports;
create trigger on_report_close_check
  after insert on public.reports
  for each row execute function public.close_venue_if_reported();
