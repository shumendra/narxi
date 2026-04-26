-- Run this in Supabase SQL Editor (once) for AI normalization support.

-- 1) Allow privileged SQL execution from server-side moderation API.
CREATE OR REPLACE FUNCTION public.exec_sql(sql text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  EXECUTE sql;
END;
$$;

REVOKE ALL ON FUNCTION public.exec_sql(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.exec_sql(text) TO service_role;

-- 2) Ensure alias upsert conflict target exists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'product_aliases_product_id_alias_text_key'
  ) THEN
    ALTER TABLE public.product_aliases
      ADD CONSTRAINT product_aliases_product_id_alias_text_key
      UNIQUE (product_id, alias_text);
  END IF;
END $$;

-- 3) Track normalization run history (used to fetch only new approved names on next run).
CREATE TABLE IF NOT EXISTS public.normalization_runs (
  id bigserial PRIMARY KEY,
  trigger text NOT NULL DEFAULT 'manual',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running',
  raw_name_count integer NOT NULL DEFAULT 0,
  new_raw_name_count integer NOT NULL DEFAULT 0,
  sql_success_count integer NOT NULL DEFAULT 0,
  sql_error_count integer NOT NULL DEFAULT 0,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS normalization_runs_created_at_idx
  ON public.normalization_runs (created_at DESC);
