-- Narxi data foundation v1
-- Run in Supabase SQL editor.

create extension if not exists pg_trgm;

-- 1) Canonical product search text for multilingual search.
alter table if exists products
  add column if not exists search_text text;

update products
set search_text = trim(concat_ws(' ', coalesce(name_uz, ''), coalesce(name_ru, ''), coalesce(name_en, '')))
where coalesce(search_text, '') = '';

create index if not exists products_search_trgm_idx
  on products using gin (search_text gin_trgm_ops);

-- 2) Product aliases (generic + store-specific naming).
create table if not exists product_aliases (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  alias_text text not null,
  language text default 'unknown',
  store_name text,
  times_seen integer default 1,
  created_at timestamptz default now()
);

create index if not exists product_aliases_alias_text_idx
  on product_aliases (lower(alias_text));

create index if not exists product_aliases_alias_trgm_idx
  on product_aliases using gin (alias_text gin_trgm_ops);

create index if not exists product_aliases_product_id_idx
  on product_aliases (product_id);

-- 3) User profiles without explicit login (Telegram identity based).
create table if not exists user_profiles (
  telegram_id text primary key,
  username text,
  first_name text,
  language_code text,
  receipts_scanned integer default 0,
  prices_approved integer default 0,
  prices_rejected integer default 0,
  total_items_contributed integer default 0,
  streak_days integer default 0,
  last_streak_date date,
  badges text[] default array[]::text[],
  preferred_city text default 'Tashkent',
  preferred_language text default 'uz',
  first_seen timestamptz default now(),
  last_seen timestamptz default now()
);

-- 4) Rich receipt-level context.
create table if not exists receipts (
  id uuid primary key default gen_random_uuid(),
  receipt_url text unique,
  store_name text,
  store_address text,
  city text,
  latitude double precision,
  longitude double precision,
  receipt_date timestamptz,
  total_amount integer,
  payment_method text,
  item_count integer,
  submitted_by text,
  created_at timestamptz default now()
);

-- 4b) Contact form submissions for moderator inbox.
create table if not exists contact_messages (
  id uuid primary key default gen_random_uuid(),
  name text,
  contact text not null,
  message text not null,
  city text,
  language text,
  telegram_id text,
  telegram_username text,
  created_at timestamptz default now()
);

create index if not exists contact_messages_created_at_idx
  on contact_messages (created_at desc);

-- 5) Enrich prices table for analytics.
alter table if exists prices add column if not exists quantity numeric default 1;
alter table if exists prices add column if not exists unit_price integer;
alter table if exists prices add column if not exists unit text;
alter table if exists prices add column if not exists payment_method text;
alter table if exists prices add column if not exists receipt_total integer;
alter table if exists prices add column if not exists day_of_week integer;
alter table if exists prices add column if not exists hour_of_day integer;
alter table if exists prices add column if not exists week_of_year integer;
alter table if exists prices add column if not exists month integer;
alter table if exists prices add column if not exists year integer;
alter table if exists prices add column if not exists receipt_id uuid references receipts(id) on delete set null;

-- Backfill unit_price from existing price when missing.
update prices
set unit_price = price
where unit_price is null and price is not null;

-- 6) Engagement and notification features.
create extension if not exists "uuid-ossp";

alter table if exists user_profiles add column if not exists preferred_city text default 'toshkent';
alter table if exists user_profiles add column if not exists max_distance_km integer default 5;
alter table if exists user_profiles add column if not exists created_at timestamptz default now();
alter table if exists user_profiles add column if not exists last_seen timestamptz default now();
alter table if exists user_profiles add column if not exists pending_action jsonb default null;

create table if not exists user_stats (
  telegram_id text primary key references user_profiles(telegram_id) on delete cascade,
  total_receipts_scanned integer default 0,
  total_items_contributed integer default 0,
  total_people_helped integer default 0,
  current_streak_weeks integer default 0,
  last_streak_date date,
  last_receipt_date date,
  updated_at timestamptz default now()
);

create table if not exists shopping_lists (
  id uuid primary key default uuid_generate_v4(),
  telegram_id text references user_profiles(telegram_id) on delete cascade,
  items text[] not null,
  created_at timestamptz default now(),
  week_number integer,
  year integer
);

create table if not exists scheduled_notifications (
  id uuid primary key default uuid_generate_v4(),
  message text not null,
  scheduled_for timestamptz,
  target text default 'all',
  status text default 'pending',
  sent_count integer default 0,
  created_at timestamptz default now(),
  sent_at timestamptz
);

create table if not exists product_views (
  id uuid primary key default uuid_generate_v4(),
  product_id uuid references products(id) on delete set null,
  product_name text,
  telegram_id text,
  viewed_at timestamptz default now(),
  week_number integer,
  year integer
);

alter table if exists user_profiles enable row level security;
alter table if exists user_stats enable row level security;
alter table if exists shopping_lists enable row level security;
alter table if exists scheduled_notifications enable row level security;
alter table if exists product_views enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'user_profiles' and policyname = 'Public read user_profiles') then
    create policy "Public read user_profiles" on user_profiles for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'user_profiles' and policyname = 'Public insert user_profiles') then
    create policy "Public insert user_profiles" on user_profiles for insert with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'user_profiles' and policyname = 'Public update user_profiles') then
    create policy "Public update user_profiles" on user_profiles for update using (true);
  end if;

  if not exists (select 1 from pg_policies where tablename = 'user_stats' and policyname = 'Public read user_stats') then
    create policy "Public read user_stats" on user_stats for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'user_stats' and policyname = 'Public insert user_stats') then
    create policy "Public insert user_stats" on user_stats for insert with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'user_stats' and policyname = 'Public update user_stats') then
    create policy "Public update user_stats" on user_stats for update using (true);
  end if;

  if not exists (select 1 from pg_policies where tablename = 'shopping_lists' and policyname = 'Public insert shopping_lists') then
    create policy "Public insert shopping_lists" on shopping_lists for insert with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'shopping_lists' and policyname = 'Public read shopping_lists') then
    create policy "Public read shopping_lists" on shopping_lists for select using (true);
  end if;

  if not exists (select 1 from pg_policies where tablename = 'product_views' and policyname = 'Public insert product_views') then
    create policy "Public insert product_views" on product_views for insert with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'product_views' and policyname = 'Public read product_views') then
    create policy "Public read product_views" on product_views for select using (true);
  end if;

  if not exists (select 1 from pg_policies where tablename = 'scheduled_notifications' and policyname = 'Public read scheduled_notifications') then
    create policy "Public read scheduled_notifications" on scheduled_notifications for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'scheduled_notifications' and policyname = 'Public insert scheduled_notifications') then
    create policy "Public insert scheduled_notifications" on scheduled_notifications for insert with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'scheduled_notifications' and policyname = 'Public update scheduled_notifications') then
    create policy "Public update scheduled_notifications" on scheduled_notifications for update using (true);
  end if;
end
$$;
