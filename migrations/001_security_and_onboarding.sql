-- Migration 001 — security + onboarding hardening
-- Run ONCE in the Supabase dashboard: SQL Editor → New query → paste → Run.
-- Safe to re-run (idempotent). Fixes review findings #5, #18, #9, #21.

-- ─── #5: constrain venues INSERT ─────────────────────────
-- Old policy only checked auth.role()='authenticated', so any logged-in user
-- could forge created_by (impersonation) or self-set verified=true (fake trust
-- badge). Tie the row to the caller and forbid self-verifying on insert.
drop policy if exists "Authenticated users can insert venues" on public.venues;
create policy "Authenticated users can insert venues"
  on public.venues for insert
  with check (auth.uid() = created_by and verified is not true);

-- ─── #18: allow creators to clean up their own spam ──────
drop policy if exists "Users can delete their own unverified venues" on public.venues;
create policy "Users can delete their own unverified venues"
  on public.venues for delete
  using (auth.uid() = created_by and verified is not true);

-- ─── #9 + #21: signup trigger must never abort auth.users ─
-- A username UNIQUE collision previously raised inside the AFTER INSERT trigger
-- and rolled back the whole signup. Resolve collisions by suffixing; pin
-- search_path and qualify names (Supabase linter: function_search_path_mutable).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  base_username text;
  final_username text;
  n int := 0;
begin
  base_username := coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1));
  final_username := base_username;
  while exists (select 1 from public.profiles where username = final_username) loop
    n := n + 1;
    final_username := base_username || n::text;
  end loop;
  begin
    insert into public.profiles (id, username, display_name)
    values (new.id, final_username, coalesce(new.raw_user_meta_data->>'display_name', base_username));
  exception when unique_violation then
    insert into public.profiles (id, username, display_name)
    values (new.id, base_username || '_' || substr(new.id::text, 1, 8), base_username)
    on conflict (id) do nothing;
  end;
  return new;
end;
$$;

-- The existing trigger on_auth_user_created already calls handle_new_user(),
-- so replacing the function above is sufficient — no trigger change needed.
