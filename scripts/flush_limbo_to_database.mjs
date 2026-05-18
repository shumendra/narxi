/**
 * flush_limbo_to_database.mjs
 * Processes all approved_limbo pending_prices directly into products + prices.
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

// Fetch all approved_limbo items
const { data: limboItems, error: fetchErr } = await supabase
  .from('pending_prices')
  .select('*')
  .eq('status', 'approved_limbo');

if (fetchErr) { console.error('Fetch error:', fetchErr.message); process.exit(1); }
console.log(`Found ${limboItems.length} approved_limbo items to flush.\n`);

let flushed = 0, skipped = 0;
const errors = [];

for (const pending of limboItems) {
  const rawName = String(pending.product_name_raw || '').trim();
  if (!rawName) { skipped++; continue; }

  const city = String(pending.city || 'Tashkent').trim() || 'Tashkent';

  // Ensure product exists
  let productId = pending.product_id;
  if (!productId) {
    const { data: existing } = await supabase
      .from('products')
      .select('id')
      .eq('name_uz', rawName)
      .maybeSingle();

    if (existing?.id) {
      productId = existing.id;
    } else {
      const { data: created, error: createErr } = await supabase
        .from('products')
        .insert({
          name_uz: rawName,
          name_ru: rawName,
          name_en: rawName,
          search_text: rawName.toLowerCase(),
          category: 'Boshqa',
          unit: 'dona',
          available_cities: [city],
        })
        .select('id')
        .single();
      if (createErr) { errors.push(`${pending.id}: create product: ${createErr.message}`); continue; }
      productId = created.id;
    }
  }

  // Insert price row
  const unitPrice = Number(pending.unit_price) > 0
    ? Math.round(Number(pending.unit_price))
    : Math.round(Number(pending.price || 0));

  const { error: priceErr } = await supabase.from('prices').insert({
    product_id: productId,
    product_name_raw: rawName,
    price: unitPrice,
    quantity: Number(pending.quantity) > 0 ? Number(pending.quantity) : 1,
    city,
    place_name: pending.place_name || null,
    place_address: pending.place_address || pending.place_name || null,
    latitude: pending.latitude ?? null,
    longitude: pending.longitude ?? null,
    receipt_date: pending.receipt_date || new Date().toISOString(),
    submitted_by: pending.submitted_by || 'admin',
    source: pending.source || 'receipt',
  });

  if (priceErr) { errors.push(`${pending.id}: insert price: ${priceErr.message}`); continue; }

  // Mark as approved
  await supabase.from('pending_prices')
    .update({ status: 'approved', product_id: productId })
    .eq('id', pending.id);

  flushed++;
}

console.log('── Results ────────────────────────────────────');
console.log(`Flushed:  ${flushed}`);
console.log(`Skipped:  ${skipped}`);
if (errors.length) {
  console.log(`\nErrors (${errors.length}):`);
  errors.forEach(e => console.log(' ', e));
}
