/**
 * Comprehensive Korzinka catalog_category_id scanner
 * Scan from 800 to 1600 to find all valid product categories
 */
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  'Accept': 'application/json',
  'Origin': 'https://korzinka.uz',
  'Referer': 'https://korzinka.uz/',
  'Content-Type': 'application/json',
};

const ENDPOINT = 'https://catalog.korzinka.uz/api/mobile/catalogs/category/products';
const START = 800;
const END = 1600;
const CONCURRENCY = 15;

async function fetchCcid(ccid) {
  const r = await fetch(ENDPOINT, {
    method: 'POST', headers: HEADERS, body: JSON.stringify({ get_products: ccid }),
  });
  const d = await r.json().catch(() => null);
  if (!d || !Array.isArray(d.data) || d.data.length === 0) return null;
  return { ccid, products: d.data };
}

// Run with concurrency
async function runBatch(ids) {
  const results = [];
  const chunks = [];
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    chunks.push(ids.slice(i, i + CONCURRENCY));
  }
  for (const chunk of chunks) {
    const chunkResults = await Promise.all(chunk.map(fetchCcid));
    results.push(...chunkResults.filter(Boolean));
    process.stdout.write('.');
  }
  return results;
}

const ids = Array.from({ length: END - START + 1 }, (_, i) => START + i);
console.log(`Scanning catalog_category_ids ${START}–${END} (${ids.length} total) at concurrency=${CONCURRENCY}...`);
const validCats = await runBatch(ids);
console.log(`\n\nFound ${validCats.length} valid catalog_category_ids:`);

// Deduplicate products by vendor_code
const seen = new Set();
const allProducts = [];
for (const { ccid, products } of validCats) {
  const newOnes = products.filter(p => {
    const key = p.vendor_code || p.id || p.title_ru;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  allProducts.push(...newOnes);
  console.log(`  ccid=${ccid}: ${products.length} products (${newOnes.length} unique new)`);
}

console.log(`\nTotal unique products: ${allProducts.length}`);
if (allProducts.length > 0) {
  const sample = allProducts[0];
  console.log(`Sample: title_ru="${sample.title_ru}", title_uz="${sample.title_uz}", actual_price="${sample.prices?.actual_price}", old_price="${sample.prices?.old_price}", vendor_code="${sample.vendor_code}"`);
}

// Show price parsing example
console.log('\nPrice parsing test (strip spaces from "11 990" → 11990):');
const testPrice = '11 990';
console.log(`  parseInt("${testPrice}".replace(/\\s/g,'')) = ${parseInt(testPrice.replace(/\s/g,''))}`);
