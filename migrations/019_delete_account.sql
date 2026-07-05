-- Migration 019 — self-service account deletion (App Store requirement 5.1.1(v)).
-- Run ONCE in the Supabase SQL editor.
--
-- delete_my_account() lets a signed-in user erase THEIR OWN account and data.
-- SECURITY DEFINER (owned by postgres) so it can reach auth.users + storage;
-- it only ever touches auth.uid()'s rows, so one user can't delete another.
-- Authenticated-only; anon revoked explicitly (a bare revoke-from-public does
-- NOT block anon on Supabase — the migration-013 lesson).
--
-- Order matters: profiles/collections/reports/follows/comparisons/fake_reports
-- all FK auth.users(id) ON DELETE CASCADE, so deleting the auth user wipes them.
-- BUT venues.created_by and fake_reports.resolved_by are NOT cascade — if left
-- pointing at the user, the auth.users delete would be FK-blocked. So we first
-- null those out (venues are shared/public and must survive; other collectors
-- may have them), then remove the user's uploaded files, then delete the user.

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

  -- Remove the user's uploaded files — avatars + matchbook photos live under a
  -- top-level folder named for their user id (<uid>/...).
  delete from storage.objects
  where bucket_id = 'matchbooks'
    and (storage.foldername(name))[1] = uid::text;

  -- Delete the auth user. Cascades profiles, collections, reports, follows,
  -- comparisons, fake_reports (reporter_id), plus auth-internal sessions/identities.
  delete from auth.users where id = uid;
end;
$$;

revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
