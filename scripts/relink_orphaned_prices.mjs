/**
 * relink_orphaned_prices.mjs
 *
 * Fixes prices that have product_ids pointing to deleted products.
 * Relinks them to the correct canonical product via alias and name matching.
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

async function execSql(label, sql) {
  const { error } = await supabase.rpc('exec_sql', { sql });
  if (error) {
    console.error(`FAIL [${label}]: ${error.message}`);
    return false;
  }
  console.log(`OK: ${label}`);
  return true;
}

async function countOrphaned() {
  const allPriceIds = new Set();
  let from = 0;
  while (true) {
    const { data } = await supabase
      .from('prices')
      .select('product_id')
      .not('product_id', 'is', null)
      .order('id')
      .range(from, from + 999);
    if (!data || data.length === 0) break;
    for (const r of data) allPriceIds.add(r.product_id);
    if (data.length < 1000) break;
    from += 1000;
  }
  const { data: prodRows } = await supabase.from('products').select('id').limit(2000);
  const prodSet = new Set((prodRows ?? []).map(p => p.id));
  const orphaned = [...allPriceIds].filter(id => !prodSet.has(id)).length;
  const linked = [...allPriceIds].filter(id => prodSet.has(id)).length;
  return { orphaned, linked, uniqueIds: allPriceIds.size };
}

// Pre-fix count
process.stderr.write('Counting orphaned prices before fix...\n');
const before = await countOrphaned();
console.log(`Before: ${before.orphaned} orphaned, ${before.linked} linked (${before.uniqueIds} unique ids total)`);

if (before.orphaned === 0) {
  console.log('No orphaned prices found — nothing to fix.');
  process.exit(0);
}

// Step 1: Relink via product_aliases (alias_text → product_id)
await execSql(
  'Relink orphaned prices via alias match',
  `UPDATE prices pr
   SET product_id = pa.product_id
   FROM product_aliases pa
   WHERE lower(trim(pr.product_name_raw)) = lower(trim(pa.alias_text))
     AND NOT EXISTS (SELECT 1 FROM products WHERE id = pr.product_id)`
);

// Step 2: Relink via canonical name_uz direct match
await execSql(
  'Relink orphaned prices via name_uz',
  `UPDATE prices pr
   SET product_id = p.id
   FROM products p
   WHERE lower(trim(pr.product_name_raw)) = lower(trim(p.name_uz))
     AND NOT EXISTS (SELECT 1 FROM products WHERE id = pr.product_id)`
);

// Step 3: Relink via canonical name_ru (skip when name_ru = name_uz auto-created)
await execSql(
  'Relink orphaned prices via name_ru',
  `UPDATE prices pr
   SET product_id = p.id
   FROM products p
   WHERE lower(trim(pr.product_name_raw)) = lower(trim(p.name_ru))
     AND p.name_ru != p.name_uz
     AND NOT EXISTS (SELECT 1 FROM products WHERE id = pr.product_id)`
);

// Post-fix count
process.stderr.write('Counting orphaned prices after fix...\n');
const after = await countOrphaned();
console.log(`After:  ${after.orphaned} orphaned, ${after.linked} linked (${after.uniqueIds} unique ids total)`);
console.log(`Fixed:  ${before.orphaned - after.orphaned} orphaned product_ids relinked`);

if (after.orphaned > 0) {
  console.log(`\n${after.orphaned} product_ids still orphaned. Sample unmatched product_name_raws:`);
  // Get all orphaned product_ids
  const allPriceIdsAfter = new Set();
  let from = 0;
  while (true) {
    const { data } = await supabase.from('prices').select('product_id').not('product_id', 'is', null).order('id').range(from, from + 999);
    if (!data || data.length === 0) break;
    for (const r of data) allPriceIdsAfter.add(r.product_id);
    if (data.length < 1000) break;
    from += 1000;
  }
  const { data: prodRows } = await supabase.from('products').select('id').limit(2000);
  const prodSet = new Set((prodRows ?? []).map(p => p.id));
  const remainingOrphaned = [...allPriceIdsAfter].filter(id => !prodSet.has(id));

  for (const oid of remainingOrphaned.slice(0, 5)) {
    const { data: sample } = await supabase.from('prices').select('product_name_raw').eq('product_id', oid).limit(2);
    console.log(`  ${oid}: ${(sample ?? []).map(r => r.product_name_raw).join(', ')}`);
  }
}
