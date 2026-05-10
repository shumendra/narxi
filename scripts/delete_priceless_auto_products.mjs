import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
config({ path: '.env', override: false });
config({ path: '.env.local', override: false });

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(url, key);

// Delete priceless auto-created products (name_uz = name_ru = name_en means never normalized)
const sql = `
  DELETE FROM products
  WHERE name_uz = name_ru
    AND name_ru = name_en
    AND id NOT IN (SELECT DISTINCT product_id FROM prices WHERE product_id IS NOT NULL)
`;

console.log('Deleting priceless auto-created products...');
const { error } = await supabase.rpc('exec_sql', { sql });
if (error) {
  console.error('FAIL:', error.message);
  process.exit(1);
}
console.log('OK: priceless auto-created products deleted');
