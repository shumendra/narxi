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

// Paginate a Supabase query and collect all results efficiently
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

// 1. Basic counts (fast — head-only queries, no data transfer)
const [
  { count: totalProducts },
  { count: totalPrices },
  { count: pricesWithNullProductId },
  { count: totalPending },
  { count: pendingWithNullProductId },
] = await Promise.all([
  supabase.from('products').select('*', { count: 'exact', head: true }),
  supabase.from('prices').select('*', { count: 'exact', head: true }),
  supabase.from('prices').select('*', { count: 'exact', head: true }).is('product_id', null),
  supabase.from('pending_prices').select('*', { count: 'exact', head: true }),
  supabase.from('pending_prices').select('*', { count: 'exact', head: true }).is('product_id', null),
]);

// 2. Fetch all products (1253 rows max — fast)
const { data: allProducts } = await supabase
  .from('products')
  .select('id, name_uz, name_ru, name_en, category, created_at')
  .order('created_at', { ascending: false });

// 3. Fetch all product_ids from prices — paginated (only UUID column, ~36 bytes each)
//    At 10K rows/page = ~14 pages for 138K rows, very fast
process.stderr.write('Fetching product_ids from prices (paginated)...\n');
const priceProductIds = await fetchAllPages(
  (from, to) => supabase.from('prices').select('product_id').not('product_id', 'is', null).range(from, to),
  10000
);
const productIdsWithPrices = new Set(priceProductIds.map(r => r.product_id));

const productsWithPriceCount = productIdsWithPrices.size;
const productsWithoutPriceCount = (totalProducts ?? 0) - productsWithPriceCount;

console.log('=== Price Coverage ===');
console.log(JSON.stringify({
  totalProducts,
  productsWithPrices: productsWithPriceCount,
  productsWithoutPrices: productsWithoutPriceCount,
  totalPrices,
  pricesWithNullProductId,
  totalPending,
  pendingWithNullProductId,
}, null, 2));

// 4. List priceless products sorted by newest first
const pricelessProducts = (allProducts ?? []).filter(p => !productIdsWithPrices.has(p.id));

console.log('\n=== Products Without Prices (newest 20) ===');
console.log(JSON.stringify(pricelessProducts.slice(0, 20), null, 2));
console.log(`\nTotal priceless products: ${pricelessProducts.length}`);

// 5. Auto-created vs canonical breakdown
const autoCreatedWithPrices = (allProducts ?? []).filter(
  p => p.name_uz === p.name_ru && p.name_ru === p.name_en && productIdsWithPrices.has(p.id)
);
const autoCreatedWithoutPrices = (allProducts ?? []).filter(
  p => p.name_uz === p.name_ru && p.name_ru === p.name_en && !productIdsWithPrices.has(p.id)
);
const canonicalWithPrices = (allProducts ?? []).filter(
  p => !(p.name_uz === p.name_ru && p.name_ru === p.name_en) && productIdsWithPrices.has(p.id)
);
const canonicalWithoutPrices = (allProducts ?? []).filter(
  p => !(p.name_uz === p.name_ru && p.name_ru === p.name_en) && !productIdsWithPrices.has(p.id)
);

console.log('\n=== Product Type Breakdown ===');
console.log(JSON.stringify({
  autoCreatedWithPrices: autoCreatedWithPrices.length,
  autoCreatedWithoutPrices: autoCreatedWithoutPrices.length,
  canonicalWithPrices: canonicalWithPrices.length,
  canonicalWithoutPrices: canonicalWithoutPrices.length,
}, null, 2));

// 6. Check priceless->relinkable via alias matching
if (pricelessProducts.length > 0) {
  const { data: allAliases } = await supabase.from('product_aliases').select('product_id, alias_text');
  const aliasesByProductId = new Map();
  for (const a of allAliases ?? []) {
    if (!aliasesByProductId.has(a.product_id)) aliasesByProductId.set(a.product_id, []);
    aliasesByProductId.get(a.product_id).push(a.alias_text.toLowerCase().trim());
  }

  // Map name_uz → product_id for all products (to find matching auto-created products)
  const nameToProductId = new Map();
  for (const p of allProducts ?? []) {
    nameToProductId.set(p.name_uz.toLowerCase().trim(), p.id);
  }

  const relinkable = [];
  for (const p of pricelessProducts) {
    const aliases = aliasesByProductId.get(p.id) ?? [];
    for (const alias of aliases) {
      const matchedProductId = nameToProductId.get(alias);
      if (matchedProductId && matchedProductId !== p.id && productIdsWithPrices.has(matchedProductId)) {
        const matched = allProducts.find(x => x.id === matchedProductId);
        relinkable.push({
          canonical_id: p.id,
          canonical_name: p.name_uz,
          alias,
          old_product_id: matchedProductId,
          old_name_uz: matched?.name_uz ?? alias,
        });
        break;
      }
    }
  }

  console.log('\n=== Priceless Products Relinkable via Aliases (top 20) ===');
  console.log(JSON.stringify(relinkable.slice(0, 20), null, 2));
  console.log(`Total relinkable: ${relinkable.length} of ${pricelessProducts.length} priceless products`);

  console.log('\n=== Priceless Products WITHOUT Relinkable Aliases (top 10) ===');
  const relinkableIds = new Set(relinkable.map(r => r.canonical_id));
  const notRelinkable = pricelessProducts.filter(p => !relinkableIds.has(p.id));
  console.log(JSON.stringify(notRelinkable.slice(0, 10), null, 2));
  console.log(`Total not relinkable: ${notRelinkable.length}`);
}
