import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
config({ path: '.env', override: false });
config({ path: '.env.local', override: false });

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(url, key);

// Paginate all unique product_ids from prices
const uniquePriceProductIds = new Set();
let from = 0;
while (true) {
  const { data, error } = await supabase
    .from('prices')
    .select('product_id')
    .not('product_id', 'is', null)
    .order('id')
    .range(from, from + 999);
  if (error || !data || data.length === 0) break;
  for (const r of data) uniquePriceProductIds.add(r.product_id);
  if (data.length < 1000) break;
  from += 1000;
}

// Load all products
const { data: allProds } = await supabase.from('products').select('id,name_uz,name_ru,name_en').order('id').limit(2000);
const products = allProds || [];
const prodIdSet = new Set(products.map(p => p.id));

const withPrices = products.filter(p => uniquePriceProductIds.has(p.id)).length;
const withoutPrices = products.filter(p => !uniquePriceProductIds.has(p.id)).length;
const orphaned = [...uniquePriceProductIds].filter(id => !prodIdSet.has(id)).length;

console.log(`Products with prices:    ${withPrices}`);
console.log(`Products without prices: ${withoutPrices}`);
console.log(`Orphaned product_ids:    ${orphaned}`);
