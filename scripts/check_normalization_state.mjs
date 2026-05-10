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

// 1. Product count
const { count: productCount } = await supabase.from('products').select('*', { count: 'exact', head: true });

// 2. Alias count
const { count: aliasCount } = await supabase.from('product_aliases').select('*', { count: 'exact', head: true });

// 3. Prices total
const { count: totalPrices } = await supabase.from('prices').select('*', { count: 'exact', head: true });

// 4. Prices with NULL product_id
const { count: nullProductId } = await supabase
  .from('prices')
  .select('*', { count: 'exact', head: true })
  .is('product_id', null)
  .neq('source', 'website_scrape');

// 5. Sample products to check name quality
const { data: sampleProducts } = await supabase
  .from('products')
  .select('id, name_uz, name_ru, name_en, category, unit')
  .order('name_uz', { ascending: true })
  .limit(10);

// 6. Products missing translations (name_ru = name_uz OR name_en = name_uz or null)
const { count: missingRu } = await supabase
  .from('products')
  .select('*', { count: 'exact', head: true })
  .or('name_ru.is.null,name_ru.eq.,name_en.is.null,name_en.eq.');

// 7. How many unique raw names are in prices that do NOT have a product_id
const { data: unlinkedSample } = await supabase
  .from('prices')
  .select('product_name_raw')
  .is('product_id', null)
  .not('product_name_raw', 'is', null)
  .neq('source', 'website_scrape')
  .limit(20);

const unlinkedUniqueNames = [...new Set((unlinkedSample || []).map(r => r.product_name_raw))];

console.log(JSON.stringify({
  productCount,
  aliasCount,
  totalPrices,
  nullProductIdPrices: nullProductId,
  productsWithMissingTranslations: missingRu,
  sampleProducts: sampleProducts || [],
  unlinkedRawNameSample: unlinkedUniqueNames,
}, null, 2));
