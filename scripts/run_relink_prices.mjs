import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
config({ path: '.env', override: false });
config({ path: '.env.local', override: false });

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(url, key);

// Relink prices where product_name_raw matches a product_alias but product_id differs
const relinkSql = `
  UPDATE prices pr
  SET product_id = pa.product_id
  FROM product_aliases pa
  WHERE lower(trim(pr.product_name_raw)) = lower(trim(pa.alias_text))
    AND pr.product_id IS DISTINCT FROM pa.product_id
`;

console.log('Running alias-based price relink...');
const { error } = await supabase.rpc('exec_sql', { sql: relinkSql });
if (error) {
  console.error('FAIL:', error.message);
  process.exit(1);
} else {
  console.log('OK: prices relinked via alias match');
}
