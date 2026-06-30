-- Migration 008 — let admins resolve usernames for the Reported-photos queue.
-- Run ONCE in the Supabase SQL editor, AFTER 007. Idempotent.
--
-- The admin moderation card shows "Submitted by @user" and "— @reporter".
-- Profiles are owner-only SELECT (privacy lock-down #19), so an admin can't read
-- other users' usernames. This grants a read-only, is_admin-gated exception.
--
-- IMPORTANT: the admin check goes through a SECURITY DEFINER function, NOT an
-- inline `exists (select ... from profiles ...)`. A profiles SELECT policy that
-- itself selects from profiles causes infinite RLS recursion (42P17). The
-- definer function runs with RLS disabled inside, so it can't recurse.

create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

drop policy if exists "Admins can view all profiles" on public.profiles;
create policy "Admins can view all profiles"
  on public.profiles for select
  using (public.is_admin());
