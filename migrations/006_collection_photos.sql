-- Migration 006 — multiple photos per collected matchbook
-- Run ONCE in the Supabase SQL editor. Idempotent.
--
-- Adds a photos[] array to collections. photo_url is kept as the "cover" (first
-- photo) so existing grid/list/detail display keeps working unchanged.

alter table public.collections add column if not exists photos text[] not null default '{}';
