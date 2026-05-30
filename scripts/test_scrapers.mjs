// =============================================================
// test_scrapers.mjs — READ-ONLY scraper pipeline diagnostic
// Mirrors api/scrape-stores.js fetch logic exactly (same endpoints,
// headers, concurrency) but performs NO database writes.
// Reports: store-location counts, product counts, sample rows, timing.
//
// Run:  node scripts/test_scrapers.mjs            (all stores)
//       node scripts/test_scrapers.mjs makro      (one store)
//       node scripts/test_scrapers.mjs korzinka
//       node scripts/test_scrapers.mjs baraka
// =============================================================

const ONLY = (process.argv[2] || '').toLowerCase();

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
const BARAKA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Origin': 'https://barakamarket.uz',
  'Referer': 'https://barakamarket.uz/',
};
const YANDEX_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Content-Type': 'application/json;charset=UTF-8',
  'Origin': 'https://eats.yandex.com',
  'Referer': 'https://eats.yandex.com/en-uz/',
  'x-platform': 'desktop_web',
  'x-app-version': '18.25.0',
  'x-ya-coordinates': 'latitude=41.311151,longitude=69.279737',
};

const HTTP_CONCURRENCY = 8;

async function runWithConcurrency(values, concurrency, worker) {
  const list = Array.isArray(values) ? values : [];
  if (list.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency || 1, list.length));
  const results = new Array(list.length);
  let nextIndex = 0;
  const runWorker = async () => {
    while (true) {
      const index = nextIndex;
      if (index >= list.length) break;
      nextIndex += 1;
      try { results[index] = await worker(list[index], index); }
      catch { results[index] = null; }
    }
  };
  await Promise.all(Array.from({ length: limit }, () => runWorker()));
  return results;
}

function ms(start) { return `${((Date.now() - start) / 1000).toFixed(1)}s`; }
function hr(title) { console.log('\n' + '='.repeat(60) + '\n' + title + '\n' + '='.repeat(60)); }

// ─── Makro ───────────────────────────────────────────────────
async function testMakro() {
  hr('MAKRO');
  const t0 = Date.now();

  // Locations
  let storeCount = 0;
  try {
    const regions = Array.from({ length: 14 }, (_, i) => i + 1);
    const regionStores = await runWithConcurrency(regions, 6, async (region) => {
      const res = await fetch(`https://api.makromarket.uz/api/location-list/?region=${region}`, { headers: MAKRO_HEADERS });
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    });
    const seen = new Set();
    for (const s of regionStores.flat()) {
      const lat = parseFloat(s.latitude), lng = parseFloat(s.longitude);
      if (!lat || !lng) continue;
      const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
      if (!seen.has(key)) { seen.add(key); storeCount++; }
    }
  } catch (e) { console.log('  ! locations error:', e.message); }
  console.log(`  Store locations: ${storeCount}`);

  // Products
  const tCat = Date.now();
  const catRes = await fetch('https://api.makromarket.uz/api/category-list/', { headers: MAKRO_HEADERS });
  const categories = await catRes.json();
  console.log(`  Categories: ${Array.isArray(categories) ? categories.length : 0} (${ms(tCat)})`);

  const tProd = Date.now();
  const categoryRows = await runWithConcurrency(categories || [], HTTP_CONCURRENCY, async (cat) => {
    const url = `https://api.makromarket.uz/api/product-list/?category=${cat.id}&region=3&limit=500&p=true`;
    const res = await fetch(url, { headers: MAKRO_HEADERS });
    const data = await res.json();
    if (!Array.isArray(data?.results)) return [];
    return data.results.map((item) => ({
      name: String(item.title || '').trim(),
      price: Math.round(parseFloat(item.newPrice) || parseFloat(item.oldPrice) || 0),
      code: item.code,
    })).filter(p => p.price > 0 && p.name);
  });
  const all = categoryRows.flat().filter(Boolean);
  const seen = new Set();
  const unique = all.filter(p => { if (seen.has(p.code)) return false; seen.add(p.code); return true; });
  console.log(`  Products (raw): ${all.length}, unique by code: ${unique.length} (fetch ${ms(tProd)})`);
  console.log('  Sample:', unique.slice(0, 3).map(p => `${p.name} = ${p.price}`));
  console.log(`  TOTAL Makro: ${ms(t0)}`);
  return unique.length;
}

// ─── Korzinka ────────────────────────────────────────────────
async function testKorzinka() {
  hr('KORZINKA');
  const t0 = Date.now();

  // Locations
  let storeCount = 0;
  try {
    const res = await fetch('https://api.korzinka.uz/shop_search/?q=&category[]=66&category[]=64', { headers: KORZINKA_HEADERS });
    const data = await res.json();
    const items = data?.data?.items?.ru || data?.data?.items?.uz || [];
    storeCount = items.length;
  } catch (e) { console.log('  ! locations error:', e.message); }
  console.log(`  Store locations: ${storeCount}`);

  // Products — scan category id range 750..1410
  const START = 750, END = 1410;
  const ids = Array.from({ length: END - START + 1 }, (_, i) => START + i);
  console.log(`  Scanning ${ids.length} category IDs (${START}..${END}) @ concurrency 30 ...`);
  const tProd = Date.now();
  let hitCategories = 0;
  const categoryRows = await runWithConcurrency(ids, 30, async (ccid) => {
    const res = await fetch('https://catalog.korzinka.uz/api/mobile/catalogs/category/products', {
      method: 'POST',
      headers: { ...KORZINKA_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ get_products: ccid }),
    }).catch(() => null);
    if (!res || !res.ok) return [];
    const data = await res.json().catch(() => null);
    if (!data || !Array.isArray(data.data) || data.data.length === 0) return [];
    hitCategories++;
    return data.data.map((item) => ({
      name: String(item.title_ru || item.title || '').trim(),
      price: parseInt(String(item.prices?.actual_price || '0').replace(/\s/g, ''), 10) || 0,
      id: item.id,
      vendorCode: String(item.vendor_code || '').trim(),
    })).filter(p => p.price > 0 && p.name);
  });
  const all = categoryRows.flat().filter(Boolean);
  const seenVc = new Set(), seenId = new Set();
  let unique = 0;
  for (const it of all) {
    if (it.vendorCode && seenVc.has(it.vendorCode)) continue;
    if (seenId.has(it.id)) continue;
    if (it.vendorCode) seenVc.add(it.vendorCode);
    seenId.add(it.id);
    unique++;
  }
  console.log(`  Categories with products: ${hitCategories}/${ids.length}`);
  console.log(`  Products (raw): ${all.length}, unique: ${unique} (fetch ${ms(tProd)})`);
  console.log('  Sample:', all.slice(0, 3).map(p => `${p.name} = ${p.price}`));
  console.log(`  TOTAL Korzinka: ${ms(t0)}`);
  return unique;
}

// ─── Baraka (locations + Yandex Eats catalog) ────────────────
async function testBaraka() {
  hr('BARAKA');
  const t0 = Date.now();

  // Locations (direct Baraka API)
  let storeCount = 0;
  try {
    const res = await fetch('https://backend.barakamarket.uz/shop/', { headers: BARAKA_HEADERS });
    const payload = await res.json();
    const rows = Array.isArray(payload) ? payload : (Array.isArray(payload?.results) ? payload.results : []);
    storeCount = rows.length;
  } catch (e) { console.log('  ! locations error:', e.message); }
  console.log(`  Store locations (barakamarket.uz): ${storeCount}`);

  // Products via Yandex Eats
  const slug = 'baraka_market_m4krs';
  const tProd = Date.now();
  let topCount = 0, all = [];
  try {
    const catRes = await fetch('https://eats.yandex.com/api/v2/menu/goods?auto_translate=false', {
      method: 'POST', headers: YANDEX_HEADERS, body: JSON.stringify({ slug, maxDepth: 0 }),
    });
    const catData = await catRes.json();
    const topCategories = catData?.payload?.categories || [];
    topCount = topCategories.length;

    const categoryRows = await runWithConcurrency(topCategories, HTTP_CONCURRENCY, async (cat) => {
      const res = await fetch('https://eats.yandex.com/api/v2/menu/goods?auto_translate=false', {
        method: 'POST', headers: YANDEX_HEADERS, body: JSON.stringify({ slug, category: cat.id, maxDepth: 100 }),
      });
      const data = await res.json();
      const out = [];
      const collect = (cats) => {
        for (const c of cats || []) {
          for (const item of (c.items || [])) {
            if (item.price > 0 && item.available !== false) out.push({ name: item.name || '', price: item.price, uid: item.uid || item.id });
          }
          if (c.categories) collect(c.categories);
        }
      };
      collect(data?.payload?.categories || []);
      return out;
    });
    const flat = categoryRows.flat().filter(Boolean);
    const seen = new Set();
    all = flat.filter(p => { if (seen.has(p.uid)) return false; seen.add(p.uid); return true; });
  } catch (e) { console.log('  ! Yandex Eats error:', e.message); }
  console.log(`  Yandex Eats top categories: ${topCount}`);
  console.log(`  Products unique: ${all.length} (fetch ${ms(tProd)})`);
  console.log('  Sample:', all.slice(0, 3).map(p => `${p.name} = ${p.price}`));
  console.log(`  TOTAL Baraka: ${ms(t0)}`);
  return all.length;
}

const tests = { makro: testMakro, korzinka: testKorzinka, baraka: testBaraka };
const grand = Date.now();
const toRun = ONLY && tests[ONLY] ? [ONLY] : ['makro', 'korzinka', 'baraka'];
for (const key of toRun) {
  try { await tests[key](); }
  catch (e) { console.log(`\n${key.toUpperCase()} FAILED:`, e.message); }
}
hr(`ALL DONE in ${ms(grand)}`);
