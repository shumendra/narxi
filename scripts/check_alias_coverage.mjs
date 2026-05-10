import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

const workspaceRoot = process.cwd();
for (const envFile of ['.env', '.env.local']) {
  const envPath = path.join(workspaceRoot, envFile);
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false });
  }
}

if (!process.env.SUPABASE_URL && process.env.VITE_SUPABASE_URL) {
  process.env.SUPABASE_URL = process.env.VITE_SUPABASE_URL;
}
if (!process.env.SUPABASE_SERVICE_ROLE_KEY && !process.env.SUPABASE_ANON_KEY) {
  if (process.env.SUPABASE_KEY) process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_KEY;
  else if (process.env.VITE_SUPABASE_ANON_KEY) process.env.SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
}

const url = process.env.SUPABASE_URL || '';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
if (!url || !key) {
  console.error('missing supabase env');
  process.exit(1);
}

const supabase = createClient(url, key);

const PAGE_SIZE = 1000;
async function fetchAllPages(queryFactory) {
  const rows = [];
  let from = 0;
  while (true) {
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await queryFactory(from, to);
    if (error) throw error;
    const page = data || [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return rows;
}

function normalizeKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u02BC]/g, "'")
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const [products, aliases, prices] = await Promise.all([
  fetchAllPages((from, to) => supabase.from('products').select('id,name_uz,name_ru,name_en').range(from, to)),
  fetchAllPages((from, to) => supabase.from('product_aliases').select('product_id,alias_text').range(from, to)),
  fetchAllPages((from, to) => supabase.from('prices').select('product_name_raw,source').neq('source', 'website_scrape').range(from, to)),
]);

const known = new Set();
for (const p of products) {
  known.add(normalizeKey(p.name_uz));
  known.add(normalizeKey(p.name_ru));
  known.add(normalizeKey(p.name_en));
}
for (const a of aliases) known.add(normalizeKey(a.alias_text));

const rawSet = new Set(prices.map(p => normalizeKey(p.product_name_raw)).filter(Boolean));
const unmatched = [...rawSet].filter(k => !known.has(k));

console.log(JSON.stringify({
  knownKeys: known.size,
  uniqueRawNames: rawSet.size,
  unmatchedCount: unmatched.length,
  unmatchedSample: unmatched.slice(0, 20),
}, null, 2));
