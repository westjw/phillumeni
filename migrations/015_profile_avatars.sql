-- Migration 015 — profile pictures. Run ONCE in the Supabase SQL editor.
-- Avatars are stored in the existing `matchbooks` bucket under the user's own
-- folder (<user_id>/avatar-*.jpg), which the existing per-user write policy
-- already permits; the bucket is public-read so avatars show to everyone.

alter table public.profiles add column if not exists avatar_url text;

-- Let users set their own avatar (extends the column-scoped grant from 014 —
-- is_admin + id stay excluded).
revoke update on public.profiles from authenticated;
grant update (username, display_name, bio, home_city, referred_by, avatar_url)
  on public.profiles to authenticated;

-- Recreate the follow RPCs to also return avatar_url. Changing a function's
-- RETURNS TABLE shape requires DROP; the drop clears its grants (and resets the
-- default PUBLIC execute), so the revoke/grant must be re-applied after.
drop function if exists public.following_list();
create function public.following_list()
returns table (id uuid, username text, avatar_url text, matchbooks integer)
language sql
security definer
stable
set search_path = ''
as $$
  select p.id, p.username, p.avatar_url,
         (select count(*)::int from public.collections c where c.user_id = p.id)
  from public.follows f
  join public.profiles p on p.id = f.following_id
  where f.follower_id = auth.uid()
  order by p.username;
$$;
revoke execute on function public.following_list() from public, anon;
grant execute on function public.following_list() to authenticated;

drop function if exists public.search_collectors(text);
create function public.search_collectors(q text)
returns table (id uuid, username text, avatar_url text, matchbooks integer, is_following boolean)
language sql
security definer
stable
set search_path = ''
as $$
  select p.id, p.username, p.avatar_url,
         (select count(*)::int from public.collections c where c.user_id = p.id),
         exists (select 1 from public.follows f where f.follower_id = auth.uid() and f.following_id = p.id)
  from public.profiles p
  where p.id <> auth.uid()
    and p.username is not null
    and length(trim(coalesce(q, ''))) >= 1
    and p.username ilike replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%'
  order by p.username
  limit 20;
$$;
revoke execute on function public.search_collectors(text) from public, anon;
grant execute on function public.search_collectors(text) to authenticated;
