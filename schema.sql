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

-- Auto-create profile on signup
create or replace function handle_new_user()
returns trigger as $$
begin
  insert into profiles (id, username, display_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1))
  );
  return new;
end;
$$ language plpgsql security definer;

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
  verified boolean default false
);

alter table venues enable row level security;

create policy "Venues are viewable by everyone"
  on venues for select using (true);

create policy "Authenticated users can insert venues"
  on venues for insert with check (auth.role() = 'authenticated');

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
