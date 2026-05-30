-- stores_table_migration.sql
-- Run this in Supabase SQL Editor before deploying the store management feature

-- 1. Create the stores table
CREATE TABLE IF NOT EXISTS stores (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  name_ru         TEXT,
  name_variants   TEXT[] DEFAULT ARRAY[]::TEXT[],
  chain           TEXT,
  chain_branch_id TEXT,
  latitude        DOUBLE PRECISION,
  longitude       DOUBLE PRECISION,
  address         TEXT,
  city            TEXT DEFAULT 'toshkent',
  district        TEXT,
  times_submitted INTEGER DEFAULT 1,
  verified        BOOLEAN DEFAULT false,
  source          TEXT DEFAULT 'user_manual',
  created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Add store_id FK columns to prices and pending_prices
ALTER TABLE prices
  ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES stores(id) ON DELETE SET NULL;

ALTER TABLE pending_prices
  ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES stores(id) ON DELETE SET NULL;

-- 3. Enable trigram extension for fast ILIKE searches
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 4. Indexes
CREATE INDEX IF NOT EXISTS stores_city_idx            ON stores (city);
CREATE INDEX IF NOT EXISTS stores_chain_idx           ON stores (chain);
CREATE INDEX IF NOT EXISTS stores_verified_idx        ON stores (verified);
CREATE INDEX IF NOT EXISTS stores_times_submitted_idx ON stores (times_submitted DESC);
CREATE INDEX IF NOT EXISTS stores_name_trgm_idx       ON stores USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS stores_address_trgm_idx    ON stores USING gin (address gin_trgm_ops);
CREATE INDEX IF NOT EXISTS prices_store_id_idx        ON prices (store_id);
CREATE INDEX IF NOT EXISTS pending_prices_store_id_idx ON pending_prices (store_id);

-- 5. Row Level Security
ALTER TABLE stores ENABLE ROW LEVEL SECURITY;

-- Allow anyone to read verified stores (and all stores for authenticated requests)
CREATE POLICY stores_select_policy ON stores
  FOR SELECT USING (true);

-- Allow insert from anon (submissions go through server validation anyway)
CREATE POLICY stores_insert_policy ON stores
  FOR INSERT WITH CHECK (true);

-- Only allow update/delete via service_role (admin moderation API uses service key)
CREATE POLICY stores_update_policy ON stores
  FOR UPDATE USING (auth.role() = 'service_role');

CREATE POLICY stores_delete_policy ON stores
  FOR DELETE USING (auth.role() = 'service_role');

-- 6. updated_at trigger
CREATE OR REPLACE FUNCTION update_stores_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS stores_updated_at_trigger ON stores;
CREATE TRIGGER stores_updated_at_trigger
  BEFORE UPDATE ON stores
  FOR EACH ROW EXECUTE FUNCTION update_stores_updated_at();

-- 7. Seed known chains from existing prices data (Korzinka, Makro, etc.)
-- Creates one "chain-level" verified store per unique chain from prices
INSERT INTO stores (name, chain, city, latitude, longitude, verified, source, times_submitted)
SELECT DISTINCT ON (LOWER(place_name), city)
  place_name                          AS name,
  LOWER(REGEXP_REPLACE(place_name, '[^a-zA-ZА-Яа-яёЁ\u0400-\u04FF ]', '', 'g')) AS chain,
  COALESCE(city, 'toshkent')          AS city,
  latitude,
  longitude,
  true                                AS verified,
  'prices_migration'                  AS source,
  COUNT(*) OVER (PARTITION BY LOWER(place_name), city)::INTEGER AS times_submitted
FROM prices
WHERE place_name IS NOT NULL AND TRIM(place_name) <> ''
ORDER BY LOWER(place_name), city, latitude NULLS LAST
ON CONFLICT DO NOTHING;
