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

// Fetch all products to check quality
let allProducts = [];
let from = 0;
while (true) {
  const { data, error } = await supabase
    .from('products')
    .select('id, name_uz, name_ru, name_en, category, unit')
    .range(from, from + 999);
  if (error) throw error;
  allProducts = allProducts.concat(data || []);
  if (!data || data.length < 1000) break;
  from += 1000;
}

const unnormalized = allProducts.filter(p => p.name_uz === p.name_ru && p.name_ru === p.name_en);
const boshqaCategory = allProducts.filter(p => p.category === 'Boshqa');
const goodProducts = allProducts.filter(p => p.name_uz !== p.name_ru || p.name_en !== p.name_uz);

console.log(JSON.stringify({
  totalProducts: allProducts.length,
  unnormalized_same_all_langs: unnormalized.length,
  boshqa_category_count: boshqaCategory.length,
  properly_normalized: goodProducts.length,
  unnormalized_sample: unnormalized.slice(0, 5).map(p => ({ name_uz: p.name_uz, category: p.category })),
  good_sample: goodProducts.slice(0, 5).map(p => ({ name_uz: p.name_uz, name_ru: p.name_ru, name_en: p.name_en, category: p.category })),
}, null, 2));
