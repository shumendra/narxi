CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS receipt_queue (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  receipt_url TEXT NOT NULL UNIQUE,
  telegram_id TEXT NOT NULL,
  city TEXT DEFAULT 'Tashkent',
  status TEXT DEFAULT 'pending',
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  processed_at TIMESTAMP WITH TIME ZONE
);

ALTER TABLE receipt_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public Insert Queue" ON receipt_queue;
DROP POLICY IF EXISTS "Public Read Queue" ON receipt_queue;

CREATE POLICY "Public Insert Queue"
ON receipt_queue
FOR INSERT
WITH CHECK (true);

CREATE POLICY "Public Read Queue"
ON receipt_queue
FOR SELECT
USING (true);
