/**
 * Probe raw API responses to understand structure before fixing scrapers.
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

// ── Makro ─────────────────────────────────────────────────────────────────
console.log('\n════ MAKRO: category-list raw response ════');
const catRes = await fetch('https://api.makromarket.uz/api/category-list/', { headers: MAKRO_HEADERS });
console.log('Status:', catRes.status);
const cats = await catRes.json();
console.log('Total categories:', cats.length);
console.log('Category structure sample (first 3):');
for (const c of cats.slice(0, 3)) {
  console.log(JSON.stringify(c));
}

// Check if there are subcategories
console.log('\n── Does category-list support parent param? ──');
for (const c of cats.slice(0, 3)) {
  const subRes = await fetch(`https://api.makromarket.uz/api/category-list/?parent=${c.id}`, { headers: MAKRO_HEADERS });
  const subs = await subRes.json().catch(() => []);
  console.log(`Category id=${c.id} "${c.title || c.name}": subcategories=${Array.isArray(subs) ? subs.length : JSON.stringify(subs).slice(0,80)}`);
}

// Check product-list raw response for first category
console.log('\n── product-list raw for first category (first 3 items) ──');
const firstCat = cats[0];
const plRes = await fetch(`https://api.makromarket.uz/api/product-list/?category=${firstCat.id}&region=3&limit=10&p=true`, { headers: MAKRO_HEADERS });
const plData = await plRes.json();
console.log('Status:', plRes.status, '| count:', plData?.count, '| results len:', plData?.results?.length);
if (plData?.results?.length > 0) {
  console.log('First 3 items (all price fields):');
  for (const item of plData.results.slice(0, 3)) {
    const priceFields = Object.fromEntries(Object.entries(item).filter(([k]) => k.toLowerCase().includes('price') || k.toLowerCase().includes('sum') || k.toLowerCase().includes('cost')));
    console.log(`  "${item.title?.slice(0,50)}" →`, JSON.stringify(priceFields));
  }
}

// Try without category filter to see all products
console.log('\n── product-list WITHOUT category filter (region=3, limit=5) ──');
const allProdRes = await fetch(`https://api.makromarket.uz/api/product-list/?region=3&limit=5&p=true`, { headers: MAKRO_HEADERS });
const allProdData = await allProdRes.json();
console.log('Status:', allProdRes.status, '| count:', allProdData?.count, '| results:', allProdData?.results?.length);
if (allProdData?.results?.length > 0) {
  for (const item of allProdData.results.slice(0, 3)) {
    const priceFields = Object.fromEntries(Object.entries(item).filter(([k]) => k.toLowerCase().includes('price') || k.toLowerCase().includes('sum') || k.toLowerCase().includes('cost')));
    console.log(`  "${item.title?.slice(0,50)}" →`, JSON.stringify(priceFields));
  }
}

// Try search endpoint
console.log('\n── Makro search endpoint (q="молоко") ──');
const searchRes = await fetch(`https://api.makromarket.uz/api/search/?q=%D0%BC%D0%BE%D0%BB%D0%BE%D0%BA%D0%BE&region=3&limit=5`, { headers: MAKRO_HEADERS }).catch(() => null);
if (searchRes) {
  const searchData = await searchRes.json().catch(() => null);
  console.log('Status:', searchRes.status, '|', JSON.stringify(searchData)?.slice(0,200));
}

// Try product-list with page pagination
console.log('\n── product-list page 2 for first category ──');
const page2Res = await fetch(`https://api.makromarket.uz/api/product-list/?category=${firstCat.id}&region=3&limit=10&p=true&page=2`, { headers: MAKRO_HEADERS });
const page2Data = await page2Res.json();
console.log('Status:', page2Res.status, '| count:', page2Data?.count, '| results:', page2Data?.results?.length, '| next:', page2Data?.next?.slice(0,80));

// ── Korzinka ──────────────────────────────────────────────────────────────
console.log('\n════ KORZINKA: categories raw structure ════');
const kCatRes = await fetch('https://catalog.korzinka.uz/api/catalogs/categories', { headers: KORZINKA_HEADERS });
console.log('Status:', kCatRes.status);
const kCatData = await kCatRes.json();
const kCats = kCatData.data || [];
console.log('Total top-level cats:', kCats.length);
console.log('First category structure:');
const firstKCat = kCats[0];
if (firstKCat) {
  const { products, children, subcategories, ...rest } = firstKCat;
  console.log(JSON.stringify(rest));
  console.log('  products count:', (products || []).length);
  console.log('  has children/subcategories?', !!(children || subcategories));
  if (children?.length) console.log('  children count:', children.length, '| first child:', JSON.stringify(children[0])?.slice(0,150));
  if (subcategories?.length) console.log('  subcats count:', subcategories.length, '| first:', JSON.stringify(subcategories[0])?.slice(0,150));
}

// Try mobile endpoint with FIRST cat id and show exact error
console.log('\n── Korzinka mobile endpoint for each top-level cat ──');
for (const cat of kCats) {
  const mRes = await fetch('https://catalog.korzinka.uz/api/mobile/catalogs/category/products', {
    method: 'POST',
    headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/json', 'Origin': 'https://korzinka.uz', 'Referer': 'https://korzinka.uz/' },
    body: JSON.stringify({ get_products: cat.id }),
  });
  const mBody = await mRes.text();
  const count = mBody.includes('"data"') ? (JSON.parse(mBody)?.data?.length || 0) : 0;
  console.log(`  cat id=${cat.id} "${cat.title_ru?.slice(0,25) || cat.title_uz?.slice(0,25)}": HTTP ${mRes.status} | data len=${count} | body[:80]=${mBody.slice(0,80)}`);
}

// Try catalog/products endpoint
console.log('\n── Korzinka alternative endpoints ──');
for (const path of [
  '/api/catalogs/products?catalog_id=' + (firstKCat?.id || 1),
  '/api/mobile/catalogs/products',
  '/api/catalogs/category/' + (firstKCat?.id || 1) + '/products',
]) {
  const r = await fetch('https://catalog.korzinka.uz' + path, { headers: KORZINKA_HEADERS }).catch(() => null);
  if (r) {
    const body = await r.text().catch(() => '');
    console.log(`  ${path}: HTTP ${r.status} | ${body.slice(0, 100)}`);
  }
}
