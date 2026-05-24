-- =============================================================
-- prices table — full column backfill
-- Run this in the Supabase SQL Editor after a DB reset/recreation
-- to restore every column the app relies on.
-- Safe to run on an already-complete schema (all are IF NOT EXISTS).
-- =============================================================

-- Core moderation/status field (used by receipt worker & frontend)
ALTER TABLE prices ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'approved';

-- Raw receipt product name (receipt-sourced rows, product_id is null)
ALTER TABLE prices ADD COLUMN IF NOT EXISTS product_name_raw TEXT;

-- Receipt link
ALTER TABLE prices ADD COLUMN IF NOT EXISTS receipt_url TEXT;

-- Quantity / unit price breakdown (added in data-foundation-v1)
ALTER TABLE prices ADD COLUMN IF NOT EXISTS quantity NUMERIC DEFAULT 1;
ALTER TABLE prices ADD COLUMN IF NOT EXISTS unit_price INTEGER;
ALTER TABLE prices ADD COLUMN IF NOT EXISTS unit TEXT;

-- Chain vs location scope (added in price_scope_migration)
ALTER TABLE prices ADD COLUMN IF NOT EXISTS price_scope TEXT NOT NULL DEFAULT 'location'
  CHECK (price_scope IN ('chain', 'location'));

-- Store FK (added in stores_table_migration)
ALTER TABLE prices ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES stores(id) ON DELETE SET NULL;

-- Store product FK (added in store_products_migration)
ALTER TABLE prices ADD COLUMN IF NOT EXISTS store_product_id UUID REFERENCES store_products(id) ON DELETE SET NULL;

-- Analytics fields
ALTER TABLE prices ADD COLUMN IF NOT EXISTS payment_method TEXT;
ALTER TABLE prices ADD COLUMN IF NOT EXISTS receipt_total INTEGER;

-- =============================================================
-- Backfill: set unit_price from price where missing
-- =============================================================
UPDATE prices
SET unit_price = price
WHERE unit_price IS NULL AND price IS NOT NULL;

-- =============================================================
-- Indexes for receipt ingestion architecture
-- =============================================================

-- Layer 2 search: raw product names
CREATE INDEX IF NOT EXISTS prices_product_name_raw_idx
  ON prices (product_name_raw, city, status);

-- Receipt ingestion dedup check
CREATE INDEX IF NOT EXISTS prices_raw_source_idx
  ON prices (product_name_raw, place_name, city);

-- Price scope filter
CREATE INDEX IF NOT EXISTS prices_price_scope_idx
  ON prices (price_scope);

-- Store FK index
CREATE INDEX IF NOT EXISTS prices_store_id_idx
  ON prices (store_id);

-- =============================================================
-- Reload PostgREST schema cache so columns are visible immediately
-- =============================================================
NOTIFY pgrst, 'reload schema';
