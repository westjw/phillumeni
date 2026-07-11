-- Migration 019 (v2) — self-service account deletion (App Store req 5.1.1(v)).
-- Run ONCE in the Supabase SQL editor. Re-runnable.
--
-- delete_my_account() lets a signed-in user erase THEIR OWN account and data.
-- SECURITY DEFINER (owned by postgres) so it can reach auth.users; it only ever
-- touches auth.uid()'s rows, so one user can't delete another. Authenticated-
-- only; anon revoked explicitly (a bare revoke-from-public does NOT block anon
-- on Supabase — the migration-013 lesson).
--
-- v2: the user's STORAGE FILES are deleted by the CLIENT via the Storage API
-- *before* calling this function — Supabase blocks SQL DML on storage.objects
-- (42501 "Direct deletion from storage tables is not allowed"), which aborted
-- the v1 function entirely (caught in end-to-end testing). That client-side
-- delete needs an RLS DELETE policy on the user's own folder (below).
--
-- Order inside the function still matters: venues.created_by and
-- fake_reports.resolved_by are NOT ON DELETE CASCADE — if left pointing at the
-- user, the auth.users delete would be FK-blocked. Null them first (venues are
-- shared/public and must survive), then delete the user; profiles, collections,
-- reports, follows, comparisons, fake_reports(reporter) all cascade.

-- Let users delete files in their OWN folder of the matchbooks bucket
-- (uploads are already scoped this way; deletion needs its own policy).
drop policy if exists "Users can delete own matchbook files" on storage.objects;
create policy "Users can delete own matchbook files"
  on storage.objects for delete
  using (bucket_id = 'matchbooks' and (storage.foldername(name))[1] = auth.uid()::text);

create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  -- Detach shared content (non-cascade FKs) so the auth delete isn't blocked and
  -- venues other people collected aren't destroyed along with the account.
  update public.venues set created_by = null where created_by = uid;
  update public.fake_reports set resolved_by = null where resolved_by = uid;

  -- Delete the auth user. Cascades profiles, collections, reports, follows,
  -- comparisons, fake_reports (reporter_id), plus auth-internal sessions/identities.
  delete from auth.users where id = uid;
end;
$$;

revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
