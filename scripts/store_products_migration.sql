-- ============================================================
-- store_products migration
-- Run this in Supabase SQL Editor before deploying the new
-- scrape-stores / matcher code.
-- ============================================================

-- 1. New store_products table
CREATE TABLE IF NOT EXISTS store_products (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Original name exactly as received from source, never modified
  original_name TEXT NOT NULL,

  -- Normalised versions for matching
  normalised_name TEXT NOT NULL,      -- lowercase, stripped punctuation
  token_sorted_name TEXT NOT NULL,    -- words sorted alphabetically after normalising

  -- Source identification
  source TEXT NOT NULL,               -- 'korzinka_api', 'makro_api', 'baraka_api', 'receipt', 'scrape'
  store_name TEXT,                    -- human readable store name

  -- Canonical product this maps to
  canonical_product_id UUID REFERENCES products(id) ON DELETE SET NULL,

  -- Match metadata
  match_confidence TEXT DEFAULT 'unmatched',
  -- values: 'exact', 'normalised', 'fuzzy_high', 'fuzzy_low', 'admin_confirmed', 'unmatched'

  -- Usage stats
  times_seen INTEGER DEFAULT 1,
  last_seen TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  first_seen TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Critical indexes for fast lookups
CREATE UNIQUE INDEX IF NOT EXISTS store_products_source_original_idx
  ON store_products(source, original_name);

CREATE INDEX IF NOT EXISTS store_products_source_normalised_idx
  ON store_products(source, normalised_name);

CREATE INDEX IF NOT EXISTS store_products_source_token_sorted_idx
  ON store_products(source, token_sorted_name);

CREATE INDEX IF NOT EXISTS store_products_canonical_product_id_idx
  ON store_products(canonical_product_id);

-- 3. Add store_product_id reference to prices table
ALTER TABLE prices ADD COLUMN IF NOT EXISTS store_product_id UUID REFERENCES store_products(id);

-- 4. Add token_sorted_text to existing product_aliases for better matching
ALTER TABLE product_aliases ADD COLUMN IF NOT EXISTS token_sorted_text TEXT;

-- 5. Enable RLS
ALTER TABLE store_products ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read store_products" ON store_products
  FOR SELECT USING (true);

CREATE POLICY "Public insert store_products" ON store_products
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Public update store_products" ON store_products
  FOR UPDATE USING (true);

-- ============================================================
-- BACKFILL: populate store_products from existing prices data
-- Run AFTER creating the table above.
-- ============================================================
INSERT INTO store_products (
  original_name,
  normalised_name,
  token_sorted_name,
  source,
  store_name,
  canonical_product_id,
  match_confidence,
  times_seen,
  first_seen,
  last_seen
)
SELECT DISTINCT ON (source, product_name_raw)
  product_name_raw,
  LOWER(REGEXP_REPLACE(product_name_raw, '[^\w\s]', ' ', 'g')),
  LOWER(REGEXP_REPLACE(product_name_raw, '[^\w\s]', ' ', 'g')),
  COALESCE(source, 'unknown'),
  place_name,
  product_id,
  CASE
    WHEN product_id IS NOT NULL THEN 'admin_confirmed'
    ELSE 'unmatched'
  END,
  COUNT(*) OVER (PARTITION BY source, product_name_raw),
  MIN(created_at) OVER (PARTITION BY source, product_name_raw),
  MAX(created_at) OVER (PARTITION BY source, product_name_raw)
FROM prices
WHERE product_name_raw IS NOT NULL
  AND product_name_raw != ''
ON CONFLICT (source, original_name) DO NOTHING;

-- ============================================================
-- BACKFILL prices.store_product_id for existing rows
-- Run after backfill above.
-- ============================================================
UPDATE prices p
SET store_product_id = sp.id
FROM store_products sp
WHERE p.store_product_id IS NULL
  AND p.product_name_raw IS NOT NULL
  AND sp.original_name = p.product_name_raw
  AND sp.source = COALESCE(p.source, 'unknown');

-- ============================================================
-- POST-NORMALISATION BACKFILL
-- Run this after applying normalisation SQL to fix prices that
-- were inserted while store_product was unmatched.
-- ============================================================
-- UPDATE prices p
-- SET product_id = sp.canonical_product_id
-- FROM store_products sp
-- WHERE p.store_product_id = sp.id
--   AND p.product_id IS NULL
--   AND sp.canonical_product_id IS NOT NULL;

-- ============================================================
-- FIX FK CONSTRAINT (run this if you already created the table
-- without ON DELETE SET NULL — fixes delete-blocked-by-FK bug)
-- ============================================================
ALTER TABLE store_products
  DROP CONSTRAINT IF EXISTS store_products_canonical_product_id_fkey;

ALTER TABLE store_products
  ADD CONSTRAINT store_products_canonical_product_id_fkey
  FOREIGN KEY (canonical_product_id) REFERENCES products(id) ON DELETE SET NULL;
