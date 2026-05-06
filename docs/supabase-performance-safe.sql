-- Narxi safe performance pass for moderation-heavy workloads.
-- Non-breaking indexes only. Run in Supabase SQL editor.

CREATE INDEX IF NOT EXISTS prices_product_id_idx
  ON prices (product_id);

CREATE INDEX IF NOT EXISTS prices_product_id_receipt_date_idx
  ON prices (product_id, receipt_date DESC);

CREATE INDEX IF NOT EXISTS pending_prices_product_id_idx
  ON pending_prices (product_id);

CREATE INDEX IF NOT EXISTS pending_prices_product_id_created_at_idx
  ON pending_prices (product_id, created_at DESC);

CREATE INDEX IF NOT EXISTS pending_prices_status_idx
  ON pending_prices (status);

ANALYZE prices;
ANALYZE pending_prices;

DO $$
BEGIN
  IF to_regclass('public.product_views') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS product_views_product_id_idx ON product_views (product_id)';
    EXECUTE 'ANALYZE product_views';
  END IF;
END
$$;
