-- Migration 021 — matchbook availability, separate from the venue's lifecycle
-- Run ONCE in the Supabase SQL editor (after 020). Idempotent.
--
-- WHY: "Not available here" used to mean one thing and do another. Its own UI
-- said "this spot ran out or stopped having them" (a MATCHBOOK-stock statement)
-- but 3 of them retired the VENUE as closed — so a thriving bar that was merely
-- out of matches got marked shut. This splits the two axes:
--
--   venues.status  = the BUSINESS:  active | closed | discontinued
--                    ('discontinued' = open for business, but no more matchbooks)
--   reports.reason = WHY it's unavailable, and it now decides the outcome.
--
-- Only 'closed_down' can mark a venue closed. Only 'discontinued' can mark it
-- discontinued. 'out_temporarily' and 'unknown' never retire anything — they're
-- advisory, and a later collection supersedes them (see repost_venue).

-- ─── A. Report reasons ───────────────────────────────────
-- Nullable: legacy rows predate the dropdown and are semantically ambiguous
-- (they were filed under the old "ran out OR stopped having them" wording), so
-- they are deliberately INERT below — they count toward nothing.
alter table public.reports add column if not exists reason text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'reports_reason_chk') then
    alter table public.reports add constraint reports_reason_chk
      check (reason is null or reason in ('out_temporarily','discontinued','closed_down','unknown'));
  end if;
end $$;

-- Set when a venue is reposted: the place demonstrably has matchbooks again, so
-- prior unavailable-reports are stale. Kept (not deleted) so the admin queue
-- retains the history, and so the trigger can't re-retire on the next report.
alter table public.reports add column if not exists superseded_at timestamptz;

-- ─── B. 'discontinued' venue status ──────────────────────
-- Open for business, no matchbooks. Behaves like closed (grey pin, not
-- collectable, lives on in collections) but must NOT be labelled "Closed" —
-- the bar is still there.
-- Drop BOTH spellings. 003 added an explicitly-named `venues_status_chk`, but
-- schema.sql declares the check INLINE on the column, which Postgres auto-names
-- `venues_status_check`. A DB built from schema.sql carries the auto-named one,
-- and dropping only the 003 name leaves ('active','closed') silently enforced —
-- every 'discontinued' retirement would then abort the report insert that
-- triggered it. (schema.sql now allows 'discontinued' too, for fresh setups.)
do $$ begin
  alter table public.venues drop constraint if exists venues_status_chk;
  alter table public.venues drop constraint if exists venues_status_check;
  alter table public.venues add constraint venues_status_chk
    check (status in ('active','closed','discontinued'));
end $$;

-- ─── C. Reason-driven retirement ─────────────────────────
-- THRESHOLD drops 3 → 2: with a small beta, 3 distinct reporters was
-- effectively unreachable, so genuinely-dead spots lingered forever. Raise it
-- as the userbase grows (it gates how easily a few accounts retire a venue).
create or replace function public.close_venue_if_reported()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  closed_count int;
  discontinued_count int;
  threshold constant int := 2;
begin
  select
    count(*) filter (where reason = 'closed_down'),
    count(*) filter (where reason = 'discontinued')
  into closed_count, discontinued_count
  from public.reports
  where venue_id = new.venue_id and superseded_at is null;

  -- 'closed' wins over 'discontinued': a shut-down business trumps "no matches".
  if closed_count >= threshold then
    update public.venues
      set status = 'closed', closed_at = coalesce(closed_at, now())
      where id = new.venue_id and status <> 'closed';
  elsif discontinued_count >= threshold then
    update public.venues
      set status = 'discontinued', closed_at = coalesce(closed_at, now())
      where id = new.venue_id and status = 'active';
  end if;
  return new;
end;
$$;

-- Re-evaluate on UPDATE too, not just INSERT: changing your mind (upsert of a
-- new reason on the same user+venue row) resolves as an UPDATE, and an
-- insert-only trigger would silently never re-check it.
drop trigger if exists on_report_close_check on public.reports;
create trigger on_report_close_check
  after insert or update on public.reports
  for each row execute function public.close_venue_if_reported();

-- ─── D. Repost: a fresh matchbook proves the spot is alive ───
-- Called when someone submits a matchbook from a retired venue AND says they
-- got it recently. Supersedes the stale reports (else the very next report
-- would re-retire it instantly on the old count) and reopens the venue.
-- GUARD: you must actually have this matchbook in your collection — otherwise
-- any authenticated user could un-retire every venue by calling the RPC.
create or replace function public.repost_venue(p_venue_id integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  if not exists (
    select 1 from public.collections
    where user_id = auth.uid() and venue_id = p_venue_id
  ) then
    raise exception 'you can only repost a spot whose matchbook you have';
  end if;

  update public.reports
    set superseded_at = now()
    where venue_id = p_venue_id and superseded_at is null;

  update public.venues
    set status = 'active', closed_at = null
    where id = p_venue_id and status <> 'active';
end;
$$;

-- ─── E. Last collected (the "does it still have them?" signal) ───
-- collections is owner-only under RLS (005), so the client cannot read anyone
-- else's collected_at. Returns a bare timestamp — no identity, no count.
-- CAVEAT: with a single collector this is that person's exact collect time
-- (same single-ranker caveat as friends_rankings). No name is exposed.
-- kind='venue' filter is NOT optional: this is SECURITY DEFINER over an
-- owner-only table with a caller-supplied id, so without it anyone could pass a
-- keepsake's id and read exactly when that person collected their wedding
-- matchbook. The client already hides keepsakes here, but the client isn't the
-- boundary. Same hole 020 closed for city/world rankings.
create or replace function public.venue_last_collected(p_venue_id integer)
returns timestamptz
language sql
security definer
stable
set search_path = ''
as $$
  select max(c.collected_at)
  from public.collections c
  join public.venues v on v.id = c.venue_id
  where c.venue_id = p_venue_id and v.kind = 'venue';
$$;

-- ─── E2. Let a collector correct their own report ────────
-- The reason dropdown is only honest if you can change your answer: report
-- "they're out", come back a month later, report "closed down". That upsert
-- resolves as an UPDATE, and `reports` had NO update policy for anyone — so the
-- correction died with 42501 while the first report sailed through. Scoped to
-- your own row, so nobody can rewrite someone else's vote; retiring still needs
-- two DISTINCT users, which one account can't fake by editing itself.
drop policy if exists "Users can update their own reports" on public.reports;
create policy "Users can update their own reports"
  on public.reports for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ─── F. Admin review of closure reports ──────────────────
-- 005 locked reports to owner-only reads with NO admin exception, so closures
-- auto-fired with no human able to even see them. fake_reports already had this
-- pair (007); reports never did.
drop policy if exists "Admins can view all reports" on public.reports;
create policy "Admins can view all reports"
  on public.reports for select using (public.is_admin());

-- Lets an admin dismiss a bad report by superseding it (reports had no UPDATE
-- policy at all before this).
drop policy if exists "Admins can supersede reports" on public.reports;
create policy "Admins can supersede reports"
  on public.reports for update using (public.is_admin()) with check (public.is_admin());

-- Admin override from the review queue. venues has no UPDATE policy for anyone
-- (not even admins), so reopening a wrongly-retired spot was a SQL-console job.
-- p_reopen=false just clears the reports (spot stays as-is).
create or replace function public.admin_resolve_reports(p_venue_id integer, p_reopen boolean default false)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'admin only';
  end if;

  update public.reports
    set superseded_at = now()
    where venue_id = p_venue_id and superseded_at is null;

  if p_reopen then
    update public.venues
      set status = 'active', closed_at = null
      where id = p_venue_id and status <> 'active';
  end if;
end;
$$;

-- ─── G. Grants ───────────────────────────────────────────
-- Supabase grants EXECUTE on every new public function DIRECTLY to anon, so a
-- revoke from public alone does NOT block anon (learned the hard way, 013).
revoke execute on function public.venue_last_collected(integer) from public, anon;
grant execute on function public.venue_last_collected(integer) to authenticated;
revoke execute on function public.repost_venue(integer) from public, anon;
grant execute on function public.repost_venue(integer) to authenticated;
revoke execute on function public.admin_resolve_reports(integer, boolean) from public, anon;
grant execute on function public.admin_resolve_reports(integer, boolean) to authenticated;
