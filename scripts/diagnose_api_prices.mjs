/**
 * Diagnostic: call each store API and trace why prices may not link to DB products.
 * Outputs raw counts, sample items, matching outcomes, and root-cause analysis.
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import * as fuzzball from 'fuzzball';

config({ path: '.env', override: false });
config({ path: '.env.local', override: false });

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(url, key);

const MATCH_MIN = 70;

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

const YANDEX_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  'Accept': 'application/json',
  'Content-Type': 'application/json;charset=UTF-8',
  'Origin': 'https://eats.yandex.com',
  'Referer': 'https://eats.yandex.com/en-uz/',
  'x-platform': 'desktop_web',
  'x-app-version': '18.25.0',
  'x-ya-coordinates': 'latitude=41.311151,longitude=69.279737',
};

// ── Helpers ───────────────────────────────────────────────────────────────
function normalizeKey(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u02BC]/g, "'")
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fuzzyScore(rawName, product) {
  const candidates = [product.name_uz, product.name_ru, product.name_en, ...(product.aliases || [])].filter(Boolean);
  return Math.max(0, ...candidates.map(n =>
    fuzzball.ratio(rawName.toLowerCase(), n.toLowerCase())
  ));
}

function classifyMatch(rawName, productsByKey, enrichedProducts) {
  const key = normalizeKey(rawName);
  const exactIds = Array.from(productsByKey.get(key) || []);
  if (exactIds.length === 1) return { kind: 'exact', score: 100, productId: exactIds[0] };
  if (exactIds.length > 1) return { kind: 'ambiguous', score: 100, productId: null };

  let best = null, bestScore = 0;
  for (const p of enrichedProducts) {
    const s = fuzzyScore(rawName, p);
    if (s > bestScore) { bestScore = s; best = p; }
  }
  if (best && bestScore >= MATCH_MIN) return { kind: 'fuzzy', score: bestScore, productId: best.id };
  return { kind: 'none', score: bestScore, productId: null };
}

function printTable(rows) {
  rows.forEach((r, i) => {
    console.log(`  [${String(i + 1).padStart(3)}] price=${String(r.price).padEnd(10)} name="${r.name.slice(0,60)}"`);
  });
}

function summarizeMatches(items, productsByKey, enrichedProducts) {
  let exact = 0, fuzzyGood = 0, ambiguous = 0, noMatch = 0;
  const noMatchSamples = [];
  for (const item of items) {
    const m = classifyMatch(item.name, productsByKey, enrichedProducts);
    if (m.kind === 'exact') exact++;
    else if (m.kind === 'fuzzy') fuzzyGood++;
    else if (m.kind === 'ambiguous') ambiguous++;
    else {
      noMatch++;
      if (noMatchSamples.length < 15) noMatchSamples.push({ name: item.name, bestScore: m.score });
    }
  }
  return { exact, fuzzyGood, ambiguous, noMatch, noMatchSamples };
}

// ── Load DB state ─────────────────────────────────────────────────────────
async function loadDbProducts() {
  const { data: products } = await supabase.from('products')
    .select('id,name_uz,name_ru,name_en,search_text').limit(5000);
  const { data: aliases } = await supabase.from('product_aliases')
    .select('product_id,alias_text').limit(50000);

  const aliasMap = {};
  for (const a of aliases || []) {
    if (!aliasMap[a.product_id]) aliasMap[a.product_id] = [];
    aliasMap[a.product_id].push(a.alias_text);
  }

  const productsByKey = new Map();
  const register = (id, name) => {
    const k = normalizeKey(name);
    if (!k || !id) return;
    if (!productsByKey.has(k)) productsByKey.set(k, new Set());
    productsByKey.get(k).add(id);
  };

  const enriched = (products || []).map(p => {
    register(p.id, p.name_uz);
    register(p.id, p.name_ru);
    register(p.id, p.name_en);
    for (const a of aliasMap[p.id] || []) register(p.id, a);
    return { ...p, aliases: aliasMap[p.id] || [] };
  });

  return { enriched, productsByKey };
}

// ── Store scrapers ─────────────────────────────────────────────────────────
async function scrapeMakro() {
  console.log('\n════════════════════════════════════════════════');
  console.log('MAKRO API');
  console.log('════════════════════════════════════════════════');
  try {
    const catRes = await fetch('https://api.makromarket.uz/api/category-list/', { headers: MAKRO_HEADERS });
    if (!catRes.ok) { console.log(`  ✗ Category list failed: HTTP ${catRes.status}`); return []; }
    const categories = await catRes.json();
    console.log(`  Categories: ${categories.length}`);

    const allProducts = [];
    let catsFetched = 0, catsFailed = 0, catsEmpty = 0;
    for (const cat of categories) {
      try {
        const res = await fetch(
          `https://api.makromarket.uz/api/product-list/?category=${cat.id}&region=3&limit=500&p=true`,
          { headers: MAKRO_HEADERS }
        );
        if (!res.ok) { catsFailed++; continue; }
        const data = await res.json();
        if (!Array.isArray(data?.results)) { catsEmpty++; continue; }
        catsFetched++;
        for (const item of data.results) {
          const price = Math.round(item.newPrice || item.oldPrice || 0);
          if (price > 0 && item.title) {
            allProducts.push({ name: item.title, price, nameUz: null, code: item.code, source: 'makro' });
          }
        }
      } catch { catsFailed++; }
    }

    // Deduplicate
    const seen = new Set();
    const unique = allProducts.filter(p => { if (seen.has(p.code)) return false; seen.add(p.code); return true; });

    console.log(`  Categories fetched OK: ${catsFetched}, failed: ${catsFailed}, empty: ${catsEmpty}`);
    console.log(`  Raw products with price: ${allProducts.length} → deduplicated: ${unique.length}`);
    console.log(`  Price range: ${Math.min(...unique.map(p=>p.price))} – ${Math.max(...unique.map(p=>p.price))} UZS`);
    console.log(`  Sample (first 10):`);
    printTable(unique.slice(0, 10));

    const zeroPriced = allProducts.filter(p => p.price <= 0).length;
    console.log(`  Zero-price items skipped by scraper: ${zeroPriced}`);

    // Name language distribution
    const cyrillic = unique.filter(p => /[\u0400-\u04FF]/.test(p.name)).length;
    const latin = unique.length - cyrillic;
    console.log(`  Name language: Cyrillic (Russian): ${cyrillic}, Latin (Uzbek): ${latin}`);

    return unique;
  } catch (err) {
    console.log(`  ✗ Fatal error: ${err.message}`);
    return [];
  }
}

async function scrapeKorzinka() {
  console.log('\n════════════════════════════════════════════════');
  console.log('KORZINKA API');
  console.log('════════════════════════════════════════════════');
  try {
    const catRes = await fetch('https://catalog.korzinka.uz/api/catalogs/categories', { headers: KORZINKA_HEADERS });
    if (!catRes.ok) { console.log(`  ✗ Categories failed: HTTP ${catRes.status}`); return []; }
    const catData = await catRes.json();
    const categories = catData.data || [];
    console.log(`  Top-level categories: ${categories.length}`);

    const allProducts = [];
    // Embedded in category response
    for (const cat of categories) {
      for (const item of cat.products || []) {
        const price = parseInt(String(item.prices?.actual_price || '0').replace(/\s/g, ''), 10) || 0;
        if (price > 0) {
          allProducts.push({ name: item.title_ru || item.title || '', nameUz: item.title_uz || '', price, id: item.id });
        }
      }
    }
    console.log(`  Products embedded in categories response: ${allProducts.length}`);

    // Fetch via mobile endpoint for each category
    const categoryIds = [...new Set(categories.map(c => c.id).filter(Boolean))];
    console.log(`  Fetching mobile endpoint for ${categoryIds.length} categories...`);
    let mobileFetched = 0, mobileFailed = 0;
    for (const catId of categoryIds) {
      try {
        const res = await fetch('https://catalog.korzinka.uz/api/mobile/catalogs/category/products', {
          method: 'POST',
          headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/json', 'Origin': 'https://korzinka.uz', 'Referer': 'https://korzinka.uz/' },
          body: JSON.stringify({ get_products: catId }),
        });
        if (!res.ok) { mobileFailed++; continue; }
        const data = await res.json();
        if (!Array.isArray(data?.data)) { mobileFailed++; continue; }
        mobileFetched++;
        for (const item of data.data) {
          const price = parseInt(String(item.prices?.actual_price || '0').replace(/\s/g, ''), 10) || 0;
          if (price > 0) {
            allProducts.push({ name: item.title_ru || item.title || '', nameUz: item.title_uz || '', price, id: item.id });
          }
        }
      } catch { mobileFailed++; }
    }

    const seen = new Set();
    const unique = allProducts.filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; });
    console.log(`  Mobile endpoint: ${mobileFetched} OK, ${mobileFailed} failed`);
    console.log(`  Raw products (incl duplicates): ${allProducts.length} → deduplicated: ${unique.length}`);
    console.log(`  Price range: ${Math.min(...unique.map(p=>p.price))} – ${Math.max(...unique.map(p=>p.price))} UZS`);
    console.log(`  Sample (first 10, name_ru | name_uz):`);
    unique.slice(0, 10).forEach((r, i) =>
      console.log(`  [${String(i+1).padStart(3)}] price=${String(r.price).padEnd(10)} ru="${r.name.slice(0,35)}" | uz="${(r.nameUz||'').slice(0,35)}"`)
    );

    const withUzName = unique.filter(p => p.nameUz && p.nameUz !== p.name).length;
    console.log(`  Items with distinct Uzbek name: ${withUzName} / ${unique.length}`);

    return unique;
  } catch (err) {
    console.log(`  ✗ Fatal error: ${err.message}`);
    return [];
  }
}

async function scrapeBarakaYandex() {
  console.log('\n════════════════════════════════════════════════');
  console.log('BARAKA (via Yandex Eats API)');
  console.log('════════════════════════════════════════════════');
  const slug = 'baraka_market_m4krs';
  try {
    const catRes = await fetch('https://eats.yandex.com/api/v2/menu/goods?auto_translate=false', {
      method: 'POST', headers: YANDEX_HEADERS,
      body: JSON.stringify({ slug, maxDepth: 0 }),
    });
    if (!catRes.ok) { console.log(`  ✗ Categories failed: HTTP ${catRes.status} — ${await catRes.text().catch(()=>'')}`); return []; }
    const catData = await catRes.json();
    const topCategories = catData?.payload?.categories || [];
    console.log(`  Top-level categories: ${topCategories.length}`);

    const allProducts = [];
    let catsFetched = 0, catsFailed = 0;
    for (const cat of topCategories) {
      try {
        const res = await fetch('https://eats.yandex.com/api/v2/menu/goods?auto_translate=false', {
          method: 'POST', headers: YANDEX_HEADERS,
          body: JSON.stringify({ slug, category: cat.id, maxDepth: 100 }),
        });
        if (!res.ok) { catsFailed++; continue; }
        const data = await res.json();
        const cats = data?.payload?.categories || [];
        catsFetched++;
        const collect = (cs) => {
          for (const c of cs) {
            for (const item of c.items || []) {
              if (item.price > 0 && item.available !== false) {
                allProducts.push({ name: item.name || '', price: item.price, uid: item.uid || item.id, category: cat.name });
              }
            }
            if (c.categories) collect(c.categories);
          }
        };
        collect(cats);
      } catch { catsFailed++; }
    }

    const seen = new Set();
    const unique = allProducts.filter(p => { if (seen.has(p.uid)) return false; seen.add(p.uid); return true; });
    console.log(`  Categories OK: ${catsFetched}, failed: ${catsFailed}`);
    console.log(`  Products with price: ${allProducts.length} → deduplicated: ${unique.length}`);
    if (unique.length > 0) {
      console.log(`  Price range: ${Math.min(...unique.map(p=>p.price))} – ${Math.max(...unique.map(p=>p.price))} UZS`);
      console.log(`  Sample (first 10):`);
      printTable(unique.slice(0, 10));
      const cyrillic = unique.filter(p => /[\u0400-\u04FF]/.test(p.name)).length;
      const latin = unique.length - cyrillic;
      console.log(`  Name language: Cyrillic: ${cyrillic}, Latin: ${latin}`);
    }
    return unique;
  } catch (err) {
    console.log(`  ✗ Fatal error: ${err.message}`);
    return [];
  }
}

// ── Matching analysis ──────────────────────────────────────────────────────
function analyzeMatching(storeLabel, items, productsByKey, enrichedProducts) {
  console.log(`\n── Matching analysis: ${storeLabel} ──`);
  const { exact, fuzzyGood, ambiguous, noMatch, noMatchSamples } = summarizeMatches(items, productsByKey, enrichedProducts);
  const total = items.length;
  const pct = n => `${n} (${total ? Math.round(n * 100 / total) : 0}%)`;
  console.log(`  Total items:         ${total}`);
  console.log(`  Exact match:         ${pct(exact)}  ← price links to existing product ✓`);
  console.log(`  Fuzzy match (≥${MATCH_MIN}):  ${pct(fuzzyGood)}  ← price links to existing product ✓`);
  console.log(`  Ambiguous (multi):   ${pct(ambiguous)}  ← skipped (multiple products with same key)`);
  console.log(`  No match:            ${pct(noMatch)}  ← NEW auto-created product, price linked to it`);
  console.log(`  Auto-created products → priceless after normalization splits them into canonical products.`);
  if (noMatchSamples.length > 0) {
    console.log(`  No-match samples (up to 15, with best fuzzy score):`);
    for (const s of noMatchSamples) {
      console.log(`    score=${String(s.bestScore).padEnd(3)} "${s.name.slice(0, 70)}"`);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────
console.log('Loading DB products and aliases...');
const { enriched, productsByKey } = await loadDbProducts();
console.log(`DB: ${enriched.length} products, ${enriched.reduce((s,p) => s + p.aliases.length, 0)} aliases`);

// Check alias coverage for priceless canonical products
let coverageCheck = null;
try {
  const rpcResult = await supabase.rpc('exec_sql', { sql: `SELECT 1` });
  coverageCheck = rpcResult?.data ?? null;
} catch { coverageCheck = null; }

console.log('\n── Current DB state ──');
if (coverageCheck === null || coverageCheck === undefined) {
  // exec_sql returns null on success for DML — let's just show a summary
  console.log('  (exec_sql not returning SELECT results; using JS-side counts)');
  const productsWithPrices = new Set();
  let from = 0;
  while (true) {
    const { data } = await supabase.from('prices').select('product_id').not('product_id','is',null).order('id').range(from, from+999);
    if (!data || data.length === 0) break;
    for (const r of data) productsWithPrices.add(r.product_id);
    if (data.length < 1000) break;
    from += 1000;
  }
  const priceless = enriched.filter(p => !productsWithPrices.has(p.id));
  const pricelessWithAliases = priceless.filter(p => p.aliases.length > 0);
  console.log(`  Total products: ${enriched.length}`);
  console.log(`  Products with prices: ${productsWithPrices.size}`);
  console.log(`  Priceless products: ${priceless.length}`);
  console.log(`  Priceless products WITH aliases: ${pricelessWithAliases.length} ← these WILL be fixed by next normalization (relinkPricesSql)`);
  console.log(`  Priceless products WITHOUT aliases: ${priceless.length - pricelessWithAliases.length} ← need normalization run first`);
  const noAliassSamples = priceless.filter(p => p.aliases.length === 0).slice(0, 10);
  if (noAliassSamples.length > 0) {
    console.log(`  Priceless/no-alias samples (first 10):`);
    noAliassSamples.forEach(p => console.log(`    "${p.name_uz}" / "${p.name_ru}"`));
  }
}

const makroItems = await scrapeMakro();
const korzinkaItems = await scrapeKorzinka();
const barakaItems = await scrapeBarakaYandex();

analyzeMatching('Makro', makroItems, productsByKey, enriched);
analyzeMatching('Korzinka', korzinkaItems.map(p => ({ name: p.nameUz || p.name })), productsByKey, enriched);
analyzeMatching('Baraka (Yandex)', barakaItems, productsByKey, enriched);

console.log('\n════════════════════════════════════════════════');
console.log('ROOT CAUSE SUMMARY');
console.log('════════════════════════════════════════════════');
console.log('1. Makro API returns ONLY Russian product names.');
console.log('   Canonical DB products have Uzbek names (name_uz). fuzzy match (fuzzball.ratio)');
console.log('   comparing Cyrillic names to Latin Uzbek names scores < 70 → NO MATCH → auto-create.');
console.log('   Auto-created product gets the price. After normalization it becomes priceless.');
console.log('');
console.log('2. Baraka (Yandex) also returns Russian or transliterated names → same issue.');
console.log('');
console.log('3. Korzinka has both name_ru and name_uz but Uzbek names may differ from canonical.');
console.log('');
console.log('FIX APPLIED (api/moderation.js):');
console.log('  After each normalization run, relinkPricesSql now runs:');
console.log('  UPDATE prices SET product_id = pa.product_id FROM product_aliases pa');
console.log('  WHERE product_name_raw = alias_text AND product_id != pa.product_id');
console.log('');
console.log('STILL NEEDED:');
console.log('  Run normalization (admin /normalize command or cron) to create aliases for');
console.log('  the unmatched auto-created products, then relinkPricesSql will link their prices');
console.log('  to the canonical products.');
