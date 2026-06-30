-- phillumeni database schema
-- Paste this entire file into Supabase SQL Editor and click Run

-- ─── PROFILES ───────────────────────────────────────────
create table profiles (
  id uuid references auth.users(id) on delete cascade primary key,
  username text unique,
  display_name text,
  bio text,
  home_city text default 'NYC',
  created_at timestamptz default now()
);

alter table profiles enable row level security;

create policy "Profiles are viewable by everyone"
  on profiles for select using (true);

create policy "Users can update their own profile"
  on profiles for update using (auth.uid() = id);

create policy "Users can insert their own profile"
  on profiles for insert with check (auth.uid() = id);

-- Auto-create profile on signup.
-- Must NEVER abort the auth.users insert: a username collision is resolved by
-- suffixing rather than raising. search_path is pinned and names are qualified
-- (Supabase linter: function_search_path_mutable).
create or replace function handle_new_user()
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
    -- last-resort uniqueness; never block account creation on a race
    insert into public.profiles (id, username, display_name)
    values (new.id, base_username || '_' || substr(new.id::text, 1, 8), base_username)
    on conflict (id) do nothing;
  end;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ─── VENUES ─────────────────────────────────────────────
create table venues (
  id serial primary key,
  name text not null,
  address text not null,
  neighborhood text,
  city text not null default 'NYC',
  type text,
  emoji text default '🔥',
  bg_color text default '#1A1A1A',
  sources text[] default '{}',
  note text,
  is_open boolean default true,
  hours_text text,
  lat decimal(10,8) not null,
  lng decimal(11,8) not null,
  created_at timestamptz default now(),
  created_by uuid references auth.users(id),
  verified boolean default false,
  mapbox_id text unique,                 -- stable Search Box POI id (dedup key)
  status text not null default 'active' check (status in ('active','closed')),
  closed_at timestamptz
);

alter table venues enable row level security;

create policy "Venues are viewable by everyone"
  on venues for select using (true);

-- Insert is constrained: created_by must be the caller (no impersonation) and
-- verified cannot be self-set true (no forged trust badge).
create policy "Authenticated users can insert venues"
  on venues for insert with check (auth.uid() = created_by and verified is not true);

-- Creators may delete their own not-yet-verified venues (spam/typo cleanup).
create policy "Users can delete their own unverified venues"
  on venues for delete using (auth.uid() = created_by and verified is not true);

-- ─── COLLECTIONS ────────────────────────────────────────
create table collections (
  id serial primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  venue_id integer references venues(id) on delete cascade not null,
  photo_url text,
  collected_at timestamptz default now(),
  unique(user_id, venue_id)
);

alter table collections enable row level security;

create policy "Users can view all collections"
  on collections for select using (true);

create policy "Users can manage their own collections"
  on collections for insert with check (auth.uid() = user_id);

create policy "Users can delete their own collections"
  on collections for delete using (auth.uid() = user_id);

-- ─── REPORTS (not available) ─────────────────────────────
create table reports (
  id serial primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  venue_id integer references venues(id) on delete cascade not null,
  created_at timestamptz default now(),
  unique(user_id, venue_id)
);

alter table reports enable row level security;

create policy "Reports viewable by everyone"
  on reports for select using (true);

create policy "Authenticated users can report"
  on reports for insert with check (auth.uid() = user_id);

-- Auto-close a venue once enough DISTINCT users report it unavailable.
-- reports has unique(user_id, venue_id), so count(*) = distinct reporters.
-- SECURITY DEFINER updates venues with no client-facing UPDATE policy.
create or replace function close_venue_if_reported()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  reporter_count int;
  threshold constant int := 3;
begin
  select count(*) into reporter_count from public.reports where venue_id = new.venue_id;
  if reporter_count >= threshold then
    update public.venues
      set status = 'closed', closed_at = coalesce(closed_at, now())
      where id = new.venue_id and status <> 'closed';
  end if;
  return new;
end;
$$;

create trigger on_report_close_check
  after insert on reports
  for each row execute function close_venue_if_reported();

-- ─── FOLLOWS ────────────────────────────────────────────
create table follows (
  follower_id uuid references auth.users(id) on delete cascade,
  following_id uuid references auth.users(id) on delete cascade,
  created_at timestamptz default now(),
  primary key (follower_id, following_id)
);

alter table follows enable row level security;

create policy "Follows viewable by everyone"
  on follows for select using (true);

create policy "Users manage their own follows"
  on follows for insert with check (auth.uid() = follower_id);

create policy "Users can unfollow"
  on follows for delete using (auth.uid() = follower_id);
