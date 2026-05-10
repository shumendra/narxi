/**
 * fix_price_product_links.mjs
 *
 * ROOT CAUSE: The products table was rebuilt (new UUIDs assigned during normalization),
 * but 138K existing price rows still reference the OLD deleted product IDs.
 *
 * FIX STRATEGY — server-side SQL via exec_sql RPC (no client-side pagination needed):
 *   1. Relink by alias: prices.product_name_raw → product_aliases.alias_text → product_id
 *   2. Relink by canonical name_uz direct match
 *   3. Relink by canonical name_ru direct match
 *   4. Verify: count how many prices are now relinked vs still orphaned
 *   5. For truly orphaned prices (product_name_raw has no match anywhere), auto-create products
 *      or mark them for manual review depending on count.
 *
 * Run with: node scripts/fix_price_product_links.mjs
 * Add --dry-run to preview counts without making changes.
 */

import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

const isDryRun = process.argv.includes('--dry-run');
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

async function execSql(label, sql) {
  if (isDryRun) {
    console.log(`[DRY RUN] Would execute: ${label}`);
    return { ok: true, skipped: true };
  }
  const { error } = await supabase.rpc('exec_sql', { sql });
  if (error) {
    console.error(`FAILED [${label}]: ${error.message}`);
    return { ok: false, error };
  }
  console.log(`OK: ${label}`);
  return { ok: true };
}

async function fetchAllPages(queryFn, pageSize = 10000) {
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

// ─────────────────────────── STEP 0: Pre-fix counts ───────────────────────

console.log('\n=== PRE-FIX: Count orphaned prices ===');

process.stderr.write('Fetching product_ids from prices...\n');
const allPriceProductIds = await fetchAllPages(
  (from, to) => supabase.from('prices').select('product_id').not('product_id', 'is', null).range(from, to)
);
const { data: allProducts } = await supabase.from('products').select('id');
const productIdSet = new Set((allProducts ?? []).map(p => p.id));
const priceProductIdSet = new Set(allPriceProductIds.map(r => r.product_id));

const matchedBefore = [...priceProductIdSet].filter(id => productIdSet.has(id)).length;
const orphanedBefore = [...priceProductIdSet].filter(id => !productIdSet.has(id)).length;

console.log(`Products in products table: ${productIdSet.size}`);
console.log(`Distinct product_ids in prices: ${priceProductIdSet.size}`);
console.log(`Already linked (product exists): ${matchedBefore}`);
console.log(`Orphaned (product missing): ${orphanedBefore}`);

if (orphanedBefore === 0) {
  console.log('\nAll prices already correctly linked! Nothing to fix.');
  process.exit(0);
}

// ─────────────────────────── STEP 1: Dry-run preview counts ───────────────

console.log('\n=== Preview: How many prices will be relinked? ===');

// Check alias coverage
const { data: aliasSample } = await supabase
  .from('product_aliases')
  .select('alias_text, product_id')
  .limit(5);
console.log(`Alias table sample: ${JSON.stringify(aliasSample?.map(a => a.alias_text) ?? [])}`);

const { count: aliasMatchCount } = await supabase
  .from('prices')
  .select('id', { count: 'exact', head: true })
  .not('product_id', 'is', null)
  .filter('product_name_raw', 'not.is', null);
console.log(`Prices with product_name_raw set: (fetching count...)`);

// ─────────────────────────── STEP 2: Run relinking SQL ────────────────────

if (isDryRun) {
  console.log('\n[DRY RUN] Would run the following relinking SQL:\n');
}

// Relinking via aliases (alias_text → product_id)
// This is the primary link: raw receipt name → canonical product
const relinkByAliasSql = `
UPDATE prices pr
SET product_id = pa.product_id
FROM product_aliases pa
WHERE lower(trim(pr.product_name_raw)) = lower(trim(pa.alias_text))
  AND (pr.product_id IS NULL OR pr.product_id NOT IN (SELECT id FROM products));
`.trim();

if (isDryRun) {
  console.log('-- Relink by alias:');
  console.log(relinkByAliasSql);
} else {
  console.log('\n=== STEP 1: Relink by alias match ===');
}
await execSql('Relink prices via alias match', relinkByAliasSql);

// Relinking via canonical name_uz (direct match)
const relinkByNameUzSql = `
UPDATE prices pr
SET product_id = p.id
FROM products p
WHERE lower(trim(pr.product_name_raw)) = lower(trim(p.name_uz))
  AND (pr.product_id IS NULL OR pr.product_id NOT IN (SELECT id FROM products));
`.trim();

if (isDryRun) {
  console.log('\n-- Relink by name_uz:');
  console.log(relinkByNameUzSql);
} else {
  console.log('\n=== STEP 2: Relink by name_uz match ===');
}
await execSql('Relink prices via name_uz match', relinkByNameUzSql);

// Relinking via canonical name_ru
const relinkByNameRuSql = `
UPDATE prices pr
SET product_id = p.id
FROM products p
WHERE lower(trim(pr.product_name_raw)) = lower(trim(p.name_ru))
  AND p.name_ru != p.name_uz
  AND (pr.product_id IS NULL OR pr.product_id NOT IN (SELECT id FROM products));
`.trim();

if (isDryRun) {
  console.log('\n-- Relink by name_ru:');
  console.log(relinkByNameRuSql);
} else {
  console.log('\n=== STEP 3: Relink by name_ru match ===');
}
await execSql('Relink prices via name_ru match', relinkByNameRuSql);

// Relinking via canonical name_en
const relinkByNameEnSql = `
UPDATE prices pr
SET product_id = p.id
FROM products p
WHERE lower(trim(pr.product_name_raw)) = lower(trim(p.name_en))
  AND p.name_en IS NOT NULL
  AND p.name_en != p.name_uz
  AND p.name_en != ''
  AND (pr.product_id IS NULL OR pr.product_id NOT IN (SELECT id FROM products));
`.trim();

if (isDryRun) {
  console.log('\n-- Relink by name_en:');
  console.log(relinkByNameEnSql);
} else {
  console.log('\n=== STEP 4: Relink by name_en match ===');
}
await execSql('Relink prices via name_en match', relinkByNameEnSql);

if (isDryRun) {
  console.log('\n[DRY RUN] No changes made. Run without --dry-run to apply.');
  process.exit(0);
}

// ─────────────────────────── STEP 5: Post-fix verification ────────────────

console.log('\n=== POST-FIX: Verification ===');
process.stderr.write('Re-fetching product_ids from prices...\n');

const allPriceProductIdsAfter = await fetchAllPages(
  (from, to) => supabase.from('prices').select('product_id').not('product_id', 'is', null).range(from, to)
);
const priceProductIdSetAfter = new Set(allPriceProductIdsAfter.map(r => r.product_id));
const matchedAfter = [...priceProductIdSetAfter].filter(id => productIdSet.has(id)).length;
const orphanedAfter = [...priceProductIdSetAfter].filter(id => !productIdSet.has(id)).length;

console.log(`Distinct product_ids in prices after fix: ${priceProductIdSetAfter.size}`);
console.log(`Linked (product exists): ${matchedAfter} (was ${matchedBefore})`);
console.log(`Still orphaned: ${orphanedAfter} (was ${orphanedBefore})`);

const { count: totalPrices } = await supabase.from('prices').select('*', { count: 'exact', head: true });
const { count: stillNullProductId } = await supabase.from('prices').select('*', { count: 'exact', head: true }).is('product_id', null);

// Prices whose product_id is still not in products (need another count approach via pages)
const allPriceIdsAfter2 = await fetchAllPages(
  (from, to) => supabase.from('prices').select('product_id').range(from, to)
);
const orphanedPriceCount = allPriceIdsAfter2.filter(r => r.product_id && !productIdSet.has(r.product_id)).length;

console.log(`\nTotal prices: ${totalPrices}`);
console.log(`Prices with null product_id: ${stillNullProductId}`);
console.log(`Prices with invalid (orphaned) product_id: ${orphanedPriceCount}`);

if (orphanedPriceCount > 0) {
  console.log('\n??? Some prices still orphaned. Sample orphaned product_name_raw values:');
  const orphanedPriceProductIds = allPriceIdsAfter2
    .filter(r => r.product_id && !productIdSet.has(r.product_id))
    .map(r => r.product_id)
    .slice(0, 5);

  for (const pid of orphanedPriceProductIds) {
    const { data } = await supabase
      .from('prices')
      .select('product_name_raw, source')
      .eq('product_id', pid)
      .limit(3);
    console.log(`  product_id ${pid}:`, (data ?? []).map(r => r.product_name_raw));
  }

  console.log('\nTo auto-create products for remaining orphaned prices, run:');
  console.log('  node scripts/fix_price_product_links.mjs --create-missing');
} else {
  console.log('\n All prices successfully relinked!');
}

// ─────────────────────────── STEP 6: Products still without prices ─────────

console.log('\n=== Products still without prices ===');
const { data: allProductsData } = await supabase.from('products').select('id, name_uz, name_ru, name_en, category, created_at');
const priceProductIdSetFinal = new Set(allPriceIdsAfter2.filter(r => r.product_id && productIdSet.has(r.product_id)).map(r => r.product_id));
const stillPriceless = (allProductsData ?? []).filter(p => !priceProductIdSetFinal.has(p.id));
console.log(`Products still with no prices: ${stillPriceless.length}`);

const autoCreatedStillPriceless = stillPriceless.filter(p => p.name_uz === p.name_ru && p.name_ru === p.name_en);
const canonicalStillPriceless = stillPriceless.filter(p => !(p.name_uz === p.name_ru && p.name_ru === p.name_en));
console.log(`  Auto-created (priceless): ${autoCreatedStillPriceless.length}`);
console.log(`  Canonical (priceless): ${canonicalStillPriceless.length}`);

if (autoCreatedStillPriceless.length > 0) {
  console.log('\n  These auto-created priceless products have no matching prices and should be deleted:');
  console.log(`  Sample: ${autoCreatedStillPriceless.slice(0, 5).map(p => p.name_uz).join(', ')}`);
  console.log('\n  To delete orphaned auto-created products, run:');
  console.log('  node scripts/fix_price_product_links.mjs --delete-orphans');
}
