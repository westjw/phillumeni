-- Migration 002 — matchbook photo storage
-- Run ONCE in the Supabase dashboard: SQL Editor → New query → paste → Run.
-- Safe to re-run (idempotent). Required for the Submit photo-upload feature.
--
-- Creates a public-read bucket where each user can only write under their own
-- folder (path = "<auth.uid>/<file>"). The app stores the resulting public URL
-- in collections.photo_url (column already exists in schema.sql).

-- ─── Bucket ──────────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('matchbooks', 'matchbooks', true)
on conflict (id) do nothing;

-- ─── Policies on storage.objects ─────────────────────────
-- Public read (bucket is public; this also allows API listing/getPublicUrl).
drop policy if exists "Matchbook photos are publicly readable" on storage.objects;
create policy "Matchbook photos are publicly readable"
  on storage.objects for select
  using (bucket_id = 'matchbooks');

-- Authenticated users may upload only into their own "<uid>/..." folder.
drop policy if exists "Users upload their own matchbook photos" on storage.objects;
create policy "Users upload their own matchbook photos"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'matchbooks'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Authenticated users may delete only their own photos.
drop policy if exists "Users delete their own matchbook photos" on storage.objects;
create policy "Users delete their own matchbook photos"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'matchbooks'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
