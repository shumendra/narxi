-- ============================================================
-- price_scope migration
-- Adds chain-vs-location scope to prices and pending_prices.
--
-- price_scope values:
--   'location' — price is for one specific branch (has lat/lng or place_address)
--   'chain'    — price applies to ALL branches of that chain (place_name = chain name)
--
-- Priority when displaying (highest first):
--   receipt price at a specific location  (source = 'receipt')
--   location-specific price               (price_scope = 'location')
--   chain-wide fallback                   (price_scope = 'chain')
-- ============================================================

-- 1. Add column to prices
ALTER TABLE prices
  ADD COLUMN IF NOT EXISTS price_scope TEXT NOT NULL DEFAULT 'location'
  CHECK (price_scope IN ('chain', 'location'));

-- 2. Add column to pending_prices
ALTER TABLE pending_prices
  ADD COLUMN IF NOT EXISTS price_scope TEXT NOT NULL DEFAULT 'location'
  CHECK (price_scope IN ('chain', 'location'));

-- 3. Backfill prices:
--    • Rows from store APIs that have no lat/lng → 'chain'
--    • All others → 'location' (already the default)
UPDATE prices
SET price_scope = 'chain'
WHERE source LIKE 'store_api_%'
  AND (latitude IS NULL OR longitude IS NULL);

-- 4. Index for filtering by scope
CREATE INDEX IF NOT EXISTS prices_price_scope_idx ON prices (price_scope);
CREATE INDEX IF NOT EXISTS pending_prices_price_scope_idx ON pending_prices (price_scope);
