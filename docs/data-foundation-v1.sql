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
