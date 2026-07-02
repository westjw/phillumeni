-- Migration 017 — name-only identity. Run ONCE in the Supabase SQL editor.
--
-- Product decision: drop usernames from the PRODUCT. A person's real name
-- (profiles.display_name) becomes the sole human identity; people are found by
-- name, not by an obscure handle.
--
-- NON-DESTRUCTIVE: the `username` column stays in the table as a hidden,
-- auto-generated, unique internal key (the signup trigger still fills it from
-- the email local part). Nothing structural depends on it — follows key on
-- user UUIDs, referrals on user.id, RLS on auth.uid(). We only (a) stop letting
-- users write it, and (b) rewrite the two RPCs that surfaced it to use
-- display_name instead. The signup trigger already stores display_name from
-- signup metadata (raw_user_meta_data->>'display_name'), so no trigger change.

-- ─── A. Stop users writing `username` (it's now an internal key) ─────────────
-- Extends the column-scoped grant from 014/015; is_admin + id + username excluded.
revoke update on public.profiles from authenticated;
grant update (display_name, bio, home_city, referred_by, avatar_url)
  on public.profiles to authenticated;

-- ─── B. search_collectors(q): match on NAME (substring), return display_name ──
-- Renaming a RETURNS TABLE column requires DROP + recreate (which clears grants,
-- so we re-apply the anon-revoke + authenticated-grant afterward).
-- The ILIKE pattern is wildcard-escaped (\ % _) so a query of "%" can't dump the
-- whole directory; backslash is Postgres's default LIKE escape char.
drop function if exists public.search_collectors(text);
create function public.search_collectors(q text)
returns table (id uuid, display_name text, avatar_url text, matchbooks integer, is_following boolean)
language sql
security definer
stable
set search_path = ''
as $$
  select p.id, p.display_name, p.avatar_url,
         (select count(*)::int from public.collections c where c.user_id = p.id),
         exists (select 1 from public.follows f where f.follower_id = auth.uid() and f.following_id = p.id)
  from public.profiles p
  where p.id <> auth.uid()
    and p.display_name is not null
    and length(trim(coalesce(q, ''))) >= 1
    and p.display_name ilike '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%'
  order by p.display_name
  limit 20;
$$;
revoke execute on function public.search_collectors(text) from public, anon;
grant execute on function public.search_collectors(text) to authenticated;

-- ─── C. following_list(): return display_name instead of username ─────────────
drop function if exists public.following_list();
create function public.following_list()
returns table (id uuid, display_name text, avatar_url text, matchbooks integer)
language sql
security definer
stable
set search_path = ''
as $$
  select p.id, p.display_name, p.avatar_url,
         (select count(*)::int from public.collections c where c.user_id = p.id)
  from public.follows f
  join public.profiles p on p.id = f.following_id
  where f.follower_id = auth.uid()
  order by p.display_name;
$$;
revoke execute on function public.following_list() from public, anon;
grant execute on function public.following_list() to authenticated;
