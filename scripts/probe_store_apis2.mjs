/**
 * Phase 2 probe: Makro subcategories + Korzinka full catalog endpoints
 */
const MAKRO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  'Accept': 'application/json',
  'Accept-Language': 'ru',
  'Origin': 'https://makromarket.uz',
  'Referer': 'https://makromarket.uz/',
};
const KORZINKA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  'Accept': 'application/json',
  'Origin': 'https://korzinka.uz',
  'Referer': 'https://korzinka.uz/',
};

// ── Makro: drill subcategories ─────────────────────────────────────────────
console.log('════ MAKRO: subcategory structure ════');
const catRes = await fetch('https://api.makromarket.uz/api/category-list/', { headers: MAKRO_HEADERS });
const topCats = await catRes.json();
console.log('Top-level categories:', topCats.length);

let totalProducts = 0;
for (const cat of topCats) {
  const subRes = await fetch(`https://api.makromarket.uz/api/category-list/?parent=${cat.id}`, { headers: MAKRO_HEADERS });
  const subs = await subRes.json();
  console.log(`\n  [${cat.id}] "${cat.title}" → ${subs.length} subcategories:`);
  for (const sub of subs) {
    // Fetch products for this subcategory (first page only, to see count)
    const plRes = await fetch(`https://api.makromarket.uz/api/product-list/?category=${sub.id}&region=3&limit=500&p=true`, { headers: MAKRO_HEADERS });
    const plData = await plRes.json();
    const count = plData?.count || 0;
    const results = plData?.results?.length || 0;
    const nonZero = (plData?.results || []).filter(r => (r.newPrice || r.oldPrice) > 0).length;
    totalProducts += nonZero;
    console.log(`    [${sub.id}] "${sub.title}": count=${count}, results=${results}, nonZero=${nonZero}`);
    if (plData?.results?.length > 0) {
      const sample = plData.results[0];
      const priceFields = Object.fromEntries(Object.entries(sample).filter(([k]) => k.toLowerCase().includes('price') || k.toLowerCase().includes('sum') || k.toLowerCase().includes('cost') || k === 'regularPrice'));
      console.log(`      Sample prices: ${JSON.stringify(priceFields)}`);
    }
  }
}
console.log(`\n  Total non-zero-price products across all subcategories: ${totalProducts}`);

// Also try: does product-list support pagination across ALL products?
console.log('\n── Makro: product-list ALL (no category, paginated) ──');
let allTotal = 0, page = 1;
while (true) {
  const r = await fetch(`https://api.makromarket.uz/api/product-list/?region=3&limit=100&p=true&page=${page}`, { headers: MAKRO_HEADERS });
  const d = await r.json();
  const results = d?.results || [];
  if (results.length === 0) break;
  allTotal += results.length;
  if (page === 1) console.log(`  Page 1: count=${d?.count}, results=${results.length}, next=${!!d?.next}`);
  if (!d?.next) { console.log(`  Last page=${page}, total fetched=${allTotal}`); break; }
  page++;
  if (page > 50) { console.log(`  Hit 50 page limit, total so far=${allTotal}`); break; }
}

// ── Korzinka: find the full product catalog API ────────────────────────────
console.log('\n════ KORZINKA: probing full catalog endpoints ════');
const korzinkaEndpoints = [
  { method: 'GET', url: 'https://catalog.korzinka.uz/api/products?page=1&limit=5' },
  { method: 'GET', url: 'https://catalog.korzinka.uz/api/products?limit=5' },
  { method: 'GET', url: 'https://catalog.korzinka.uz/api/catalog/products?limit=5' },
  { method: 'GET', url: 'https://catalog.korzinka.uz/api/mobile/products?limit=5' },
  { method: 'GET', url: 'https://catalog.korzinka.uz/api/products/search?q=молоко&limit=5' },
  { method: 'GET', url: 'https://catalog.korzinka.uz/api/search?q=молоко&limit=5' },
  { method: 'GET', url: 'https://korzinka.uz/api/products?limit=5' },
  { method: 'GET', url: 'https://catalog.korzinka.uz/api/catalogs?limit=5' },
  { method: 'GET', url: 'https://catalog.korzinka.uz/api/catalog-products?limit=5' },
  { method: 'POST', url: 'https://catalog.korzinka.uz/api/products', body: JSON.stringify({ limit: 5 }) },
];
for (const ep of korzinkaEndpoints) {
  const opts = { method: ep.method, headers: { ...KORZINKA_HEADERS, ...(ep.body ? { 'Content-Type': 'application/json' } : {}) } };
  if (ep.body) opts.body = ep.body;
  const r = await fetch(ep.url, opts).catch(() => null);
  if (!r) { console.log(`  ${ep.method} ${ep.url.replace('https://catalog.korzinka.uz','')} → FETCH ERROR`); continue; }
  const text = await r.text().catch(() => '');
  console.log(`  ${ep.method} ${ep.url.replace('https://catalog.korzinka.uz','').replace('https://korzinka.uz','KZ')}: HTTP ${r.status} | ${text.slice(0,120)}`);
}

// Try Korzinka with category IDs that worked (id=79) and look for subcategory structure
console.log('\n── Korzinka: mobile endpoint with product items ──');
const workingCatRes = await fetch('https://catalog.korzinka.uz/api/mobile/catalogs/category/products', {
  method: 'POST',
  headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/json', 'Origin': 'https://korzinka.uz', 'Referer': 'https://korzinka.uz/' },
  body: JSON.stringify({ get_products: 79 }),
});
const workingData = await workingCatRes.json();
const workingItems = workingData?.data || [];
if (workingItems.length > 0) {
  console.log(`  Sample item keys: ${Object.keys(workingItems[0]).join(', ')}`);
  console.log(`  Price fields: ${JSON.stringify(Object.fromEntries(Object.entries(workingItems[0]).filter(([k]) => k.toLowerCase().includes('price') || k.toLowerCase().includes('sum'))))}`);
}

// Check if Korzinka has a subcategory structure
console.log('\n── Korzinka: checking catalog_category_id values ──');
const kCatRes2 = await fetch('https://catalog.korzinka.uz/api/catalogs/categories', { headers: KORZINKA_HEADERS });
const kCatData2 = await kCatRes2.json();
const kCats2 = kCatData2.data || [];
// Get unique catalog_category_ids from embedded products
const catIds = new Set();
for (const cat of kCats2) {
  for (const prod of cat.products || []) {
    if (prod.catalog_category_id) catIds.add(prod.catalog_category_id);
  }
}
console.log('  Unique catalog_category_ids from products:', [...catIds].slice(0, 20).join(', '));

// Try mobile endpoint with catalog_category_ids from products
console.log('\n── Korzinka: mobile endpoint with catalog_category_id values ──');
for (const ccid of [...catIds].slice(0, 5)) {
  const r = await fetch('https://catalog.korzinka.uz/api/mobile/catalogs/category/products', {
    method: 'POST',
    headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/json', 'Origin': 'https://korzinka.uz', 'Referer': 'https://korzinka.uz/' },
    body: JSON.stringify({ get_products: ccid }),
  });
  const d = await r.json().catch(() => {});
  console.log(`  catalog_category_id=${ccid}: HTTP ${r.status} | data len=${Array.isArray(d?.data) ? d.data.length : d?.data} | msg=${d?.message || ''}`);
}
