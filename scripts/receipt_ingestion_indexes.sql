-- =============================================================
-- Receipt ingestion indexes
-- Run once in Supabase SQL Editor after deploying the new
-- direct-to-prices receipt ingestion system.
-- =============================================================

-- Fast lookup for raw-name search (Layer 2 of find-mode search)
CREATE INDEX IF NOT EXISTS prices_product_name_raw_idx
  ON prices (product_name_raw, city, status);

-- Fast deduplication check during receipt ingestion
-- (product_name_raw + place_name + city used in receipt_item_exists)
CREATE INDEX IF NOT EXISTS prices_raw_source_idx
  ON prices (product_name_raw, place_name, city);

-- =============================================================
-- Cleanup SQL — understand current data state
-- =============================================================

-- How many prices have null product_id (receipt-sourced, no canonical match)
SELECT
  COUNT(*)                       AS receipt_prices,
  COUNT(DISTINCT product_name_raw) AS unique_raw_products
FROM prices
WHERE product_id IS NULL
  AND status = 'approved';

-- Most common raw product names (these are your real products)
SELECT
  product_name_raw,
  COUNT(*)                  AS price_count,
  COUNT(DISTINCT place_name) AS store_count
FROM prices
WHERE product_id IS NULL
  AND status = 'approved'
GROUP BY product_name_raw
ORDER BY price_count DESC
LIMIT 50;

-- Products with zero prices (created by old ensureProductForName logic)
SELECT p.id, p.name_uz, p.name_ru
FROM products p
LEFT JOIN prices pr ON pr.product_id = p.id
WHERE pr.id IS NULL;

-- =============================================================
-- DELETE products that have no prices, no pending_prices,
-- and no aliases — these are orphans from the old approval flow.
-- REVIEW the SELECT above first before running this.
-- =============================================================

DELETE FROM products
WHERE id NOT IN (
  SELECT DISTINCT product_id FROM prices WHERE product_id IS NOT NULL
)
AND id NOT IN (
  SELECT DISTINCT product_id FROM pending_prices WHERE product_id IS NOT NULL
)
AND id NOT IN (
  SELECT DISTINCT product_id FROM product_aliases WHERE product_id IS NOT NULL
);
