-- Migration 011 — follow graph helpers for the social layer.
-- Run ONCE in the Supabase SQL editor. Idempotent. The `follows` table and its
-- RLS already exist (base schema); this only adds the read-side RPCs.
--
-- follows: (follower_id, following_id). RLS already allows a user to insert their
-- own follows, delete their own, and select rows where they're either side. But
-- profiles/collections are owner-only SELECT, so to show a followed collector's
-- username + matchbook count we need SECURITY DEFINER reads. Both return only a
-- username + a public count (no email, no identity beyond the handle), and are
-- restricted to authenticated callers.

-- People I follow, with their collection size.
create or replace function public.following_list()
returns table (id uuid, username text, matchbooks integer)
language sql
security definer
stable
set search_path = ''
as $$
  select p.id, p.username,
         (select count(*)::int from public.collections c where c.user_id = p.id)
  from public.follows f
  join public.profiles p on p.id = f.following_id
  where f.follower_id = auth.uid()
  order by p.username;
$$;

revoke execute on function public.following_list() from public;
grant execute on function public.following_list() to authenticated;

-- Find collectors by username prefix (for the "Find collectors" search). Excludes
-- self, flags whether I already follow them, capped at 20.
create or replace function public.search_collectors(q text)
returns table (id uuid, username text, matchbooks integer, is_following boolean)
language sql
security definer
stable
set search_path = ''
as $$
  select p.id, p.username,
         (select count(*)::int from public.collections c where c.user_id = p.id),
         exists (select 1 from public.follows f where f.follower_id = auth.uid() and f.following_id = p.id)
  from public.profiles p
  where p.id <> auth.uid()
    and p.username is not null
    and length(trim(coalesce(q, ''))) >= 1                                    -- never an unfiltered directory page
    and p.username ilike replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%'  -- literal prefix, no wildcard injection
  order by p.username
  limit 20;
$$;

revoke execute on function public.search_collectors(text) from public;
grant execute on function public.search_collectors(text) to authenticated;
