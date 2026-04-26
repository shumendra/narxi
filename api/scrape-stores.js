import { createClient } from '@supabase/supabase-js';
import { fuzzyMatchProduct } from './utils/receipt.js';

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabaseKey = serviceRoleKey || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
const adminTelegramIds = (process.env.ADMIN_TELEGRAM_IDS || process.env.ADMIN_TELEGRAM_ID || '7240925672')
  .split(',').map(id => id.trim()).filter(Boolean);

const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

function send(res, status, body) {
  res.setHeader('Content-Type', 'application/json');
  res.status(status).send(JSON.stringify(body));
}

// ─── Dynamic store location fetching ───────────────────────────────────────
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

const CHAIN_REPRESENTATIVE_STORES = {
  makro: {
    name: 'Makro',
    address: 'Tashkent',
    lat: 41.311151,
    lng: 69.279737,
    city: 'Tashkent',
  },
  korzinka: {
    name: 'Korzinka',
    address: 'Tashkent',
    lat: 41.311151,
    lng: 69.279737,
    city: 'Tashkent',
  },
};

const STORE_API_MATCH_MIN_SCORE = 70;

async function fetchMakroStores() {
  const stores = [];
  for (let region = 1; region <= 14; region++) {
    try {
      const res = await fetch(
        `https://api.makromarket.uz/api/location-list/?region=${region}`,
        { headers: MAKRO_HEADERS }
      );
      const data = await res.json();
      if (Array.isArray(data)) {
        for (const s of data) {
          stores.push({
            name: s.title || 'Makro',
            address: s.address || '',
            lat: parseFloat(s.latitude) || 0,
            lng: parseFloat(s.longitude) || 0,
            city: (s.address || '').split(',')[0].replace(/^г\.\s*/, '').trim() || 'Tashkent',
          });
        }
      }
    } catch { /* skip failed region */ }
  }
  return stores;
}

async function fetchKorzinkaStores() {
  const stores = [];
  try {
    const res = await fetch(
      'https://api.korzinka.uz/shop_search/?q=&category[]=66&category[]=64',
      { headers: KORZINKA_HEADERS }
    );
    const data = await res.json();
    const items = data?.data?.items?.ru || data?.data?.items?.uz || [];
    for (const s of items) {
      const loc = s.location || {};
      stores.push({
        name: s.name || 'Korzinka',
        address: s.address || '',
        lat: parseFloat(loc.lat) || 0,
        lng: parseFloat(loc.lon) || 0,
        city: (s.address || '').split(',')[0].replace(/^г\.\s*/, '').trim() || 'Tashkent',
      });
    }
  } catch { /* skip on failure */ }
  // Deduplicate by lat+lng (same store can appear in multiple categories)
  const seen = new Set();
  return stores.filter(s => {
    const key = `${s.lat.toFixed(5)},${s.lng.toFixed(5)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return s.lat !== 0 && s.lng !== 0;
  });
}

// ─── Yandex Eats config & scraper ──────────────────────────────────────────
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

// Yandex Eats store slugs — add more as discovered
const YANDEX_STORES = {
  baraka: {
    slug: 'baraka_market_m4krs',
    name: 'Baraka Market',
    // Representative location (Tashkent)
    lat: 41.311151,
    lng: 69.279737,
    address: 'Tashkent',
    city: 'Tashkent',
  },
};

async function scrapeYandexStore(storeKey) {
  const storeConfig = YANDEX_STORES[storeKey];
  if (!storeConfig) throw new Error(`Unknown Yandex store: ${storeKey}`);

  const { slug } = storeConfig;

  // Step 1: Get top-level categories
  const catRes = await fetch('https://eats.yandex.com/api/v2/menu/goods?auto_translate=false', {
    method: 'POST',
    headers: YANDEX_HEADERS,
    body: JSON.stringify({ slug, maxDepth: 0 }),
  });
  const catData = await catRes.json();
  const topCategories = catData?.payload?.categories || [];

  if (topCategories.length === 0) throw new Error('No categories returned from Yandex Eats');

  // Step 2: Fetch items per category (items only populate with specific category + maxDepth)
  const allProducts = [];
  for (const cat of topCategories) {
    try {
      const res = await fetch('https://eats.yandex.com/api/v2/menu/goods?auto_translate=false', {
        method: 'POST',
        headers: YANDEX_HEADERS,
        body: JSON.stringify({ slug, category: cat.id, maxDepth: 100 }),
      });
      const data = await res.json();
      const categories = data?.payload?.categories || [];

      // Recursively collect items from all nested categories
      const collectItems = (cats) => {
        for (const c of cats) {
          if (c.items && Array.isArray(c.items)) {
            for (const item of c.items) {
              if (item.price > 0 && item.available !== false) {
                allProducts.push({
                  name: item.name || '',
                  price: item.price, // already in UZS
                  promoPrice: item.promoPrice || null,
                  weight: item.weight || '',
                  uid: item.uid || item.id,
                  category: cat.name || '',
                });
              }
            }
          }
          if (c.categories) collectItems(c.categories);
        }
      };
      collectItems(categories);
    } catch { /* skip failed category */ }
  }

  // Deduplicate by uid
  const seen = new Set();
  return allProducts.filter(p => {
    if (seen.has(p.uid)) return false;
    seen.add(p.uid);
    return true;
  });
}

// ─── Makro scraper ─────────────────────────────────────────────────────────
async function scrapeMakro() {
  const allProducts = [];

  // Fetch categories first
  const catRes = await fetch('https://api.makromarket.uz/api/category-list/', {
    headers: MAKRO_HEADERS,
  });
  const categories = await catRes.json();

  // Fetch products from each category
  for (const cat of categories) {
    const url = `https://api.makromarket.uz/api/product-list/?category=${cat.id}&region=3&limit=500&p=true`;
    const res = await fetch(url, { headers: MAKRO_HEADERS });
    const data = await res.json();
    if (data.results) {
      for (const item of data.results) {
        allProducts.push({
          name: item.title,
          price: Math.round(item.newPrice), // current promo price
          oldPrice: Math.round(item.oldPrice),
          code: item.code,
          category: cat.title,
        });
      }
    }
  }

  // Deduplicate by code (same product may appear in multiple categories)
  const seen = new Set();
  return allProducts.filter(p => {
    if (seen.has(p.code)) return false;
    seen.add(p.code);
    return true;
  });
}

// ─── Korzinka scraper ──────────────────────────────────────────────────────
async function scrapeKorzinka() {
  // Get all categories
  const catRes = await fetch('https://catalog.korzinka.uz/api/catalogs/categories', {
    headers: KORZINKA_HEADERS,
  });
  const catData = await catRes.json();
  const categories = catData.data || [];

  const allProducts = [];

  // Collect products already embedded in categories response
  for (const cat of categories) {
    if (cat.products && Array.isArray(cat.products)) {
      for (const item of cat.products) {
        const priceStr = item.prices?.actual_price || '0';
        const price = parseInt(String(priceStr).replace(/\s/g, ''), 10) || 0;
        const oldPriceStr = item.prices?.old_price || '0';
        const oldPrice = parseInt(String(oldPriceStr).replace(/\s/g, ''), 10) || 0;
        allProducts.push({
          name: item.title_ru || item.title || '',
          nameUz: item.title_uz || '',
          price,
          oldPrice,
          id: item.id,
          categoryId: item.catalog_category_id,
          category: cat.title_ru || cat.title_uz || '',
          weight: item.weight_param || '',
        });
      }
    }
  }

  // Also fetch via mobile endpoint for each category that has products
  const categoryIds = [...new Set(categories.map(c => c.id).filter(Boolean))];
  for (const catId of categoryIds) {
    try {
      const res = await fetch('https://catalog.korzinka.uz/api/mobile/catalogs/category/products', {
        method: 'POST',
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Content-Type': 'application/json',
          'Origin': 'https://korzinka.uz',
          'Referer': 'https://korzinka.uz/',
        },
        body: JSON.stringify({ get_products: catId }),
      });
      const data = await res.json();
      if (data.data && Array.isArray(data.data)) {
        for (const item of data.data) {
          const priceStr = item.prices?.actual_price || '0';
          const price = parseInt(String(priceStr).replace(/\s/g, ''), 10) || 0;
          const oldPriceStr = item.prices?.old_price || '0';
          const oldPrice = parseInt(String(oldPriceStr).replace(/\s/g, ''), 10) || 0;
          allProducts.push({
            name: item.title_ru || item.title || '',
            nameUz: item.title_uz || '',
            price,
            oldPrice,
            id: item.id,
            categoryId: item.catalog_category_id,
            category: '',
            weight: item.weight_param || '',
          });
        }
      }
    } catch { /* skip failed category */ }
  }

  // Deduplicate by id
  const seen = new Set();
  return allProducts.filter(p => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return p.price > 0;
  });
}

// ─── Main handler ──────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' });
  if (!supabase) return send(res, 500, { ok: false, error: 'SUPABASE_NOT_CONFIGURED' });
  if (!serviceRoleKey) return send(res, 500, { ok: false, error: 'SUPABASE_SERVICE_ROLE_KEY required' });

  const { admin_id, store } = req.body || {};
  if (!admin_id || !adminTelegramIds.includes(String(admin_id))) {
    return send(res, 403, { ok: false, error: 'Unauthorized' });
  }

  const validStores = ['makro', 'korzinka', ...Object.keys(YANDEX_STORES).map(k => `yandex_${k}`)];
  if (!store || !validStores.includes(store)) {
    return send(res, 400, { ok: false, error: `Invalid store. Use one of: ${validStores.join(', ')}` });
  }

  try {
    // 1. Fetch our products for matching
    const { data: products } = await supabase.from('products').select('*');
    // Also get aliases for enriched matching
    const { data: aliases } = await supabase.from('product_aliases').select('product_id, alias_text');
    const aliasMap = {};
    for (const a of aliases || []) {
      if (!aliasMap[a.product_id]) aliasMap[a.product_id] = [];
      aliasMap[a.product_id].push(a.alias_text);
    }
    const enrichedProducts = (products || []).map(p => ({
      ...p,
      search_text: [p.search_text || '', ...(aliasMap[p.id] || [])].join(' '),
    }));

    // 2. Scrape store
    let storeProducts;
    let stores;
    const isYandex = store.startsWith('yandex_');
    if (store === 'makro') {
      storeProducts = await scrapeMakro();
      stores = [CHAIN_REPRESENTATIVE_STORES.makro];
    } else if (store === 'korzinka') {
      storeProducts = await scrapeKorzinka();
      stores = [CHAIN_REPRESENTATIVE_STORES.korzinka];
    } else if (isYandex) {
      const yandexKey = store.replace('yandex_', '');
      const storeConfig = YANDEX_STORES[yandexKey];
      storeProducts = await scrapeYandexStore(yandexKey);
      // Yandex prices are chain-wide; use the representative store location
      stores = [{
        name: storeConfig.name,
        address: storeConfig.address,
        lat: storeConfig.lat,
        lng: storeConfig.lng,
        city: storeConfig.city,
      }];
    }

    if (!stores || stores.length === 0) {
      return send(res, 200, { ok: true, inserted: 0, matched: 0, total: 0, message: 'Could not fetch store locations from API' });
    }

    if (!storeProducts || storeProducts.length === 0) {
      return send(res, 200, { ok: true, inserted: 0, matched: 0, total: 0, message: 'No products found from store API' });
    }

    // 3. Check which products already have receipt-based prices at this store chain
    // Only skip if a receipt price exists for the same product at the same store brand
    const storeBrand = store === 'makro' ? 'Makro' : store === 'korzinka' ? 'Korzinka' : YANDEX_STORES[store.replace('yandex_', '')]?.name || store;
    const { data: existingPrices } = await supabase
      .from('prices')
      .select('product_id, source, place_name')
      .or(`place_name.ilike.%${storeBrand}%`);
    const receiptProductIds = new Set(
      (existingPrices || [])
        .filter(p => !p.source || (!p.source.startsWith('store_api_') && !p.source.startsWith('history_store_api_')))
        .map(p => p.product_id)
    );

    // Avoid duplicate queue rows only for still-pending imports.
    // Approved imports must be allowed again on every re-run to refresh current prices.
    const sourceTag = `store_api_${store}`;
    const { data: existingApiPrices } = await supabase
      .from('pending_prices')
      .select('product_name_raw, price, place_address')
      .eq('source', sourceTag)
      .or('status.eq.pending,status.is.null');
    const existingApiSet = new Set(
      (existingApiPrices || []).map(p => `${p.product_name_raw}|${p.price}|${p.place_address || ''}`)
    );

    // 4. Match and insert into pending_prices — one entry per product per branch
    let inserted = 0;
    let matched = 0;
    let skipped = 0;
    let skippedReceipt = 0;
    let skippedDup = 0;
    const errors = [];
    const now = new Date().toISOString();

    for (const sp of storeProducts) {
      const rawName = sp.nameUz || sp.name || '';
      if (!rawName || sp.price <= 0) { skipped++; continue; }

      // Fuzzy match against our product catalog
      const { product: bestMatch, score } = fuzzyMatchProduct(rawName, enrichedProducts);

      // If match confidence is very low, also try the Russian name
      let finalMatch = bestMatch;
      let finalScore = score;
      if (score < 60 && sp.name && sp.name !== rawName) {
        const { product: ruMatch, score: ruScore } = fuzzyMatchProduct(sp.name, enrichedProducts);
        if (ruScore > finalScore) {
          finalMatch = ruMatch;
          finalScore = ruScore;
        }
      }

      const isConfidentMatch = Boolean(finalMatch) && finalScore >= STORE_API_MATCH_MIN_SCORE;
      const matchedProductId = isConfidentMatch ? finalMatch.id : null;

      // Skip if this product already has a receipt-based price (receipt > API)
      if (matchedProductId && receiptProductIds.has(matchedProductId)) {
        skippedReceipt++;
        continue;
      }

      // Insert for every branch — API prices are chain-wide
      let insertedThisProduct = false;
      for (const branch of stores) {
        const dedupKey = `${sp.name || rawName}|${sp.price}|${branch.address}`;
        if (existingApiSet.has(dedupKey)) {
          skippedDup++;
          continue;
        }

        const payload = {
          product_name_raw: sp.name || rawName,
          product_id: matchedProductId,
          match_confidence: finalScore,
          status: 'pending',
          price: sp.price,
          quantity: 1,
          unit_price: sp.price,
          city: branch.city || 'Tashkent',
          place_name: branch.name,
          place_address: branch.address,
          receipt_date: now,
          source: `store_api_${store}`,
          submitted_by: String(admin_id),
          latitude: branch.lat,
          longitude: branch.lng,
        };

        const { error } = await supabase.from('pending_prices').insert(payload);
        if (error) {
          errors.push({ name: rawName, branch: branch.address, error: error.message });
        } else {
          inserted++;
          existingApiSet.add(dedupKey);
          insertedThisProduct = true;
        }
      }
      if (insertedThisProduct && isConfidentMatch) matched++;
    }

    return send(res, 200, {
      ok: true,
      store,
      total: storeProducts.length,
      inserted,
      matched,
      skipped,
      skippedReceipt,
      skippedDup,
      errors: errors.length > 0 ? errors.slice(0, 10) : undefined,
      message: `Scraped ${storeProducts.length} products × ${stores.length} branches from ${store}: ${inserted} inserted (${matched} matched), ${skippedReceipt} skipped (receipt exists), ${skippedDup} skipped (already imported).`,
    });
  } catch (err) {
    console.error('scrape-stores error:', err);
    return send(res, 500, { ok: false, error: err.message || 'Internal error' });
  }
}
