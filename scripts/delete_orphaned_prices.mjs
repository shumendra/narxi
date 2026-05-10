import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
config({ path: '.env', override: false });
config({ path: '.env.local', override: false });

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(url, key);

// Delete prices whose product_id points to a product that no longer exists
const sql = `
  DELETE FROM prices
  WHERE product_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM products WHERE id = prices.product_id)
`;

console.log('Deleting orphaned prices (product_id points to deleted products)...');
const { error } = await supabase.rpc('exec_sql', { sql });
if (error) {
  console.error('FAIL:', error.message);
  process.exit(1);
}
console.log('OK: orphaned prices deleted');
