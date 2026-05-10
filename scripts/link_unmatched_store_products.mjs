/**
 * link_unmatched_store_products.mjs
 *
 * Finds all store_products rows where canonical_product_id IS NULL,
 * creates canonical products from original_name, links them, and
 * backfills prices.product_id where it was left NULL.
 *
 * Usage: node scripts/link_unmatched_store_products.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

const workspaceRoot = process.cwd();
for (const envPath of [path.join(workspaceRoot, '.env'), path.join(workspaceRoot, '.env.local')]) {
  if (fs.existsSync(envPath)) dotenv.config({ path: envPath, override: false });
}
if (!process.env.SUPABASE_URL && process.env.VITE_SUPABASE_URL)
  process.env.SUPABASE_URL = process.env.VITE_SUPABASE_URL;
if (!process.env.SUPABASE_ANON_KEY) {
  if (process.env.SUPABASE_KEY) process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_KEY;
  else if (process.env.VITE_SUPABASE_ANON_KEY) process.env.SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
}

const { createClient } = await import('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// ── helpers ──────────────────────────────────────────────────────────────────

async function fetchAllPages(queryFn, pageSize = 1000) {
  const results = [];
  let from = 0;
  while (true) {
    const { data, error } = await queryFn(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    results.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return results;
}

async function upsertProductAlias(productId, originalName, storeName) {
  const aliasName = String(originalName || '').trim().toLowerCase();
  if (!aliasName) return;
  await supabase.from('product_aliases').upsert(
    { product_id: productId, alias: aliasName, source: storeName || null },
    { onConflict: 'alias,source', ignoreDuplicates: true }
  );
}

// ── main ─────────────────────────────────────────────────────────────────────

console.log('Fetching unmatched store_products...');

const unmatched = await fetchAllPages((from, to) =>
  supabase
    .from('store_products')
    .select('id, original_name, source, store_name')
    .is('canonical_product_id', null)
    .range(from, to)
);

console.log(`Found ${unmatched.length} unmatched store_products rows.\n`);

if (unmatched.length === 0) {
  console.log('Nothing to do.');
  process.exit(0);
}

let created = 0, linked = 0, pricesBackfilled = 0, skipped = 0;
const errors = [];

for (let i = 0; i < unmatched.length; i++) {
  const sp = unmatched[i];
  const originalName = String(sp.original_name || '').trim();

  if (!originalName) {
    skipped++;
    continue;
  }

  // Build a search_text for the product
  const searchText = originalName.toLowerCase();

  // Create canonical product — use original_name for all name fields
  const { data: newProduct, error: insertErr } = await supabase
    .from('products')
    .insert({
      name_uz: originalName,
      name_ru: originalName,
      name_en: originalName,
      search_text: searchText,
    })
    .select('id')
    .single();

  if (insertErr) {
    errors.push(`Row ${sp.id} (${originalName}): ${insertErr.message}`);
    continue;
  }

  const canonicalProductId = newProduct.id;
  created++;

  // Register alias
  await upsertProductAlias(canonicalProductId, originalName, sp.store_name || sp.source);

  // Link store_products row
  const { error: linkErr } = await supabase
    .from('store_products')
    .update({ canonical_product_id: canonicalProductId, match_confidence: 'admin_confirmed' })
    .eq('id', sp.id)
    .is('canonical_product_id', null);

  if (linkErr) {
    errors.push(`Link ${sp.id}: ${linkErr.message}`);
  } else {
    linked++;
  }

  // Backfill prices where product_id is still NULL for this store_product
  const { data: backfilled, error: backfillErr } = await supabase
    .from('prices')
    .update({ product_id: canonicalProductId })
    .eq('store_product_id', sp.id)
    .is('product_id', null)
    .select('id');

  if (!backfillErr) {
    pricesBackfilled += backfilled?.length ?? 0;
  }

  if ((i + 1) % 50 === 0) {
    console.log(`  Progress: ${i + 1}/${unmatched.length} — created ${created}, linked ${linked}, prices backfilled ${pricesBackfilled}`);
  }
}

console.log('\n── Results ─────────────────────────────────────────────');
console.log(`Products created:   ${created}`);
console.log(`Store products linked: ${linked}`);
console.log(`Prices backfilled:  ${pricesBackfilled}`);
console.log(`Skipped (no name):  ${skipped}`);
if (errors.length) {
  console.log(`\nErrors (${errors.length}):`);
  errors.slice(0, 20).forEach(e => console.log(' ', e));
  if (errors.length > 20) console.log(`  ...and ${errors.length - 20} more`);
}
