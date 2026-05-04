import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

for (const envName of ['.env.local', '.env']) {
  const envPath = path.resolve(process.cwd(), envName);
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false });
  }
}

const supabaseUrl = process.env.SUPABASE_URL
  || process.env.VITE_SUPABASE_URL
  || '';

const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  || process.env.SUPABASE_KEY
  || process.env.SUPABASE_ANON_KEY
  || process.env.VITE_SUPABASE_ANON_KEY
  || '';

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
const tables = ['product_aliases', 'prices', 'pending_prices', 'products'];

async function countRows(table) {
  const { count, error } = await supabase
    .from(table)
    .select('id', { count: 'exact', head: true });

  if (error) {
    throw new Error(`${table} count failed: ${error.message}`);
  }

  return Number(count || 0);
}

async function purgeTable(table) {
  const { error } = await supabase
    .from(table)
    .delete()
    .neq('id', '00000000-0000-0000-0000-000000000000');

  if (error) {
    throw new Error(`${table} delete failed: ${error.message}`);
  }
}

async function run() {
  const before = {};
  for (const table of tables) {
    before[table] = await countRows(table);
  }

  // Delete children first, then products.
  for (const table of tables) {
    await purgeTable(table);
  }

  const after = {};
  for (const table of tables) {
    after[table] = await countRows(table);
  }

  console.log(JSON.stringify({
    keySource: process.env.SUPABASE_SERVICE_ROLE_KEY
      ? 'SUPABASE_SERVICE_ROLE_KEY'
      : (process.env.SUPABASE_KEY ? 'SUPABASE_KEY' : 'ANON_FALLBACK'),
    tables,
    before,
    after,
  }, null, 2));
}

run().catch((error) => {
  console.error('Purge failed:', error?.message || error);
  process.exit(1);
});
