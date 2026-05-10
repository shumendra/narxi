/**
 * Phase 3 probe: Korzinka deeper discovery of all catalog_category_ids
 */
const KORZINKA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  'Accept': 'application/json',
  'Origin': 'https://korzinka.uz',
  'Referer': 'https://korzinka.uz/',
  'Content-Type': 'application/json',
};

// Test the remaining catalog_category_ids from phase 2
const remaining = [1314, 1316, 1362];
console.log('── Remaining catalog_category_ids ──');
for (const ccid of remaining) {
  const r = await fetch('https://catalog.korzinka.uz/api/mobile/catalogs/category/products', {
    method: 'POST', headers: KORZINKA_HEADERS, body: JSON.stringify({ get_products: ccid }),
  });
  const d = await r.json().catch(() => {});
  const items = Array.isArray(d?.data) ? d.data : [];
  console.log(`  catalog_category_id=${ccid}: len=${items.length} | msg=${d?.message || d?.code || ''}`);
  if (items.length > 0) {
    const s = items[0];
    console.log(`    sample: title_ru="${s.title_ru}", actual_price="${s.prices?.actual_price}", old_price="${s.prices?.old_price}"`);
  }
}

// Try alternate endpoints to discover more catalog_category_ids
console.log('\n── Korzinka: alternate category discovery ──');
const altEndpoints = [
  'https://catalog.korzinka.uz/api/mobile/catalogs/categories',
  'https://catalog.korzinka.uz/api/mobile/catalogs',
  'https://catalog.korzinka.uz/api/catalogs',
  'https://catalog.korzinka.uz/api/catalogs/categories?type=full',
  'https://catalog.korzinka.uz/api/catalogs/categories?depth=2',
  'https://catalog.korzinka.uz/api/item-catalog/categories',
  'https://catalog.korzinka.uz/api/mobile/item-catalog/categories',
  'https://catalog.korzinka.uz/api/catalog-items/categories',
];
for (const url of altEndpoints) {
  const r = await fetch(url, { headers: KORZINKA_HEADERS }).catch(() => null);
  if (!r) { console.log(`  ${url.split('/api/')[1]}: FETCH ERROR`); continue; }
  const text = await r.text().catch(() => '');
  const snip = text.slice(0, 150).replace(/\n/g, '');
  console.log(`  ${url.split('/api/')[1]}: HTTP ${r.status} | ${snip}`);
}

// Try POST to get_categories
console.log('\n── Korzinka: POST category discovery ──');
const postAttempts = [
  { url: 'https://catalog.korzinka.uz/api/mobile/catalogs/categories', body: {} },
  { url: 'https://catalog.korzinka.uz/api/mobile/catalogs/category/products', body: { get_products: 1 } },
  { url: 'https://catalog.korzinka.uz/api/mobile/catalogs/category/products', body: { get_products: 100 } },
  { url: 'https://catalog.korzinka.uz/api/mobile/catalogs/category/products', body: { get_products: 1000 } },
  { url: 'https://catalog.korzinka.uz/api/mobile/catalogs/category/products', body: { get_products: 1005 } },
  { url: 'https://catalog.korzinka.uz/api/mobile/catalogs/category/products', body: { get_products: 1010 } },
  { url: 'https://catalog.korzinka.uz/api/mobile/catalogs/category/products', body: { get_products: 1050 } },
  { url: 'https://catalog.korzinka.uz/api/mobile/catalogs/category/products', body: { get_products: 1100 } },
  { url: 'https://catalog.korzinka.uz/api/mobile/catalogs/category/products', body: { get_products: 1200 } },
  { url: 'https://catalog.korzinka.uz/api/mobile/catalogs/category/products', body: { get_products: 1250 } },
  { url: 'https://catalog.korzinka.uz/api/mobile/catalogs/category/products', body: { get_products: 1300 } },
  { url: 'https://catalog.korzinka.uz/api/mobile/catalogs/category/products', body: { get_products: 1315 } },
  { url: 'https://catalog.korzinka.uz/api/mobile/catalogs/category/products', body: { get_products: 1317 } },
  { url: 'https://catalog.korzinka.uz/api/mobile/catalogs/category/products', body: { get_products: 1318 } },
  { url: 'https://catalog.korzinka.uz/api/mobile/catalogs/category/products', body: { get_products: 1319 } },
  { url: 'https://catalog.korzinka.uz/api/mobile/catalogs/category/products', body: { get_products: 1321 } },
  { url: 'https://catalog.korzinka.uz/api/mobile/catalogs/category/products', body: { get_products: 1361 } },
  { url: 'https://catalog.korzinka.uz/api/mobile/catalogs/category/products', body: { get_products: 1363 } },
  { url: 'https://catalog.korzinka.uz/api/mobile/catalogs/category/products', body: { get_products: 1400 } },
  { url: 'https://catalog.korzinka.uz/api/mobile/catalogs/category/products', body: { get_products: 1500 } },
];
for (const a of postAttempts) {
  const r = await fetch(a.url, { method: 'POST', headers: KORZINKA_HEADERS, body: JSON.stringify(a.body) }).catch(() => null);
  if (!r) { console.log(`  ${JSON.stringify(a.body)}: FETCH ERROR`); continue; }
  const d = await r.json().catch(() => {});
  const len = Array.isArray(d?.data) ? d.data.length : (d?.data ?? 'non-array');
  console.log(`  get_products=${JSON.stringify(a.body.get_products)}: HTTP ${r.status} | len=${len} | msg="${d?.message || ''}"`);
}

// Try Korzinka website API (nuxt.js fetch calls)
console.log('\n── Korzinka: website API endpoints ──');
const siteEndpoints = [
  'https://korzinka.uz/api/catalog',
  'https://korzinka.uz/api/catalog/categories',
  'https://korzinka.uz/_nuxt/static/catalog.json',
  'https://korzinka.uz/catalog',
];
for (const url of siteEndpoints) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }).catch(() => null);
  if (!r) { console.log(`  ${url}: FETCH ERROR`); continue; }
  const text = await r.text().catch(() => '');
  console.log(`  ${url}: HTTP ${r.status} | ${text.slice(0, 100).replace(/\n/g, '')}`);
}

// Summary of what we found
console.log('\n════ SUMMARY ════');
console.log('Known working catalog_category_ids: 1034, 1320, 1311, 1312, 1313, 1314, 1316, 1362');
const allCcids = [1034, 1320, 1311, 1312, 1313, 1314, 1316, 1362];
let grandTotal = 0;
for (const ccid of allCcids) {
  const r = await fetch('https://catalog.korzinka.uz/api/mobile/catalogs/category/products', {
    method: 'POST', headers: KORZINKA_HEADERS, body: JSON.stringify({ get_products: ccid }),
  });
  const d = await r.json().catch(() => {});
  const count = Array.isArray(d?.data) ? d.data.length : 0;
  grandTotal += count;
  console.log(`  catalog_category_id=${ccid}: ${count} products`);
}
console.log(`\nTotal: ${grandTotal} products across all 8 known catalog_category_ids`);
