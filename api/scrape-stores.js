import { createClient } from '@supabase/supabase-js';
import * as fuzzball from 'fuzzball';
import { matchProduct } from './utils/matcher.js';
import { extractCityFromAddress, normalizeCityName } from '../src/constants/cities.js';

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

function normalizeMaybeText(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function normalizeAliasKey(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeProductNameKey(value) {
  return normalizeAliasKey(value)
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u02BC]/g, "'")
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeStoreCity(cityRaw, addressRaw) {
  return normalizeCityName(cityRaw || '')
    || normalizeCityName(extractCityFromAddress(addressRaw || ''))
    || 'Tashkent';
}

function buildStoreExactKey({ productId, price, city, placeName, placeAddress }) {
  return [
    String(productId || ''),
    Number(price) || 0,
    String(city || '').trim().toLowerCase(),
    String(placeName || '').trim().toLowerCase(),
    String(placeAddress || '').trim().toLowerCase(),
  ].join('|');
}

function buildStoreBranchKey({ productId, city, placeName, placeAddress }) {
  return [
    String(productId || ''),
    String(city || '').trim().toLowerCase(),
    String(placeName || '').trim().toLowerCase(),
    String(placeAddress || '').trim().toLowerCase(),
  ].join('|');
}

function detectAliasLanguage(text) {
  const value = String(text || '');
  if (/\p{Script=Cyrillic}/u.test(value)) return 'ru';
  if (/[A-Za-zʻ’'`]/.test(value)) return 'uz';
  return 'unknown';
}

async function upsertProductAlias(productId, aliasText, storeName = null) {
  const normalizedAlias = String(aliasText || '').trim();
  if (!productId || !normalizedAlias) return;

  const normalizedStore = normalizeMaybeText(storeName);
  const language = detectAliasLanguage(normalizedAlias);

  const { data: existing, error: existingError } = await supabase
    .from('product_aliases')
    .select('id,times_seen,store_name')
    .eq('product_id', productId)
    .ilike('alias_text', normalizedAlias)
    .limit(1)
    .maybeSingle();

  if (existingError) return;

  if (existing?.id) {
    const nextPayload = {
      times_seen: (Number(existing.times_seen) || 1) + 1,
      language,
    };

    if (!normalizeMaybeText(existing.store_name) && normalizedStore) {
      nextPayload.store_name = normalizedStore;
    }

    await supabase
      .from('product_aliases')
      .update(nextPayload)
      .eq('id', existing.id);
    return;
  }

  await supabase.from('product_aliases').insert({
    product_id: productId,
    alias_text: normalizedAlias,
    language,
    store_name: normalizedStore,
    times_seen: 1,
  });
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

const BARAKA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Origin': 'https://barakamarket.uz',
  'Referer': 'https://barakamarket.uz/',
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

// Thresholds are now in api/utils/matcher.js
// HTTP_CONCURRENCY drives Makro/Yandex catalog fetches. These public APIs
// tolerated 15+ parallel requests cleanly in testing, so 16 is safe and faster.
const HTTP_CONCURRENCY = 16;
// Korzinka scans ~660 category IDs. Testing showed its server is the bottleneck:
// raising concurrency 15→30 did NOT reduce the ~16s fetch, so 20 is a safe ceiling
// (more just hammers their API for no gain). The real fix for the ~23k-row scrape
// is to run it from the local/cron worker, not a time-limited serverless function.
const KORZINKA_CONCURRENCY = 20;
const DB_CHUNK_SIZE = 250;

// Korzinka scans this category-id range. Exposed so the handler can split it into
// batches (the full ~660-id scan + ~23k-row ingest can exceed the function limit).
const KORZINKA_SCAN_START = 750;
const KORZINKA_SCAN_END = 1410;

function chunkArray(values, size) {
  const chunks = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
}

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
      try {
        results[index] = await worker(list[index], index);
      } catch {
        results[index] = null;
      }
    }
  };

  await Promise.all(Array.from({ length: limit }, () => runWorker()));
  return results;
}

async function fetchMakroStores() {
  const regions = Array.from({ length: 14 }, (_, idx) => idx + 1);
  const regionStores = await runWithConcurrency(regions, 6, async (region) => {
    const res = await fetch(
      `https://api.makromarket.uz/api/location-list/?region=${region}`,
      { headers: MAKRO_HEADERS }
    );
    const data = await res.json();
    if (!Array.isArray(data)) return [];

    return data.map((s) => {
      const address = String(s.address || '').trim();
      const cityGuess = (address || '').split(',')[0].replace(/^г\.\s*/, '').trim();
      return {
        name: s.title || 'Makro',
        address,
        lat: parseFloat(s.latitude) || 0,
        lng: parseFloat(s.longitude) || 0,
        city: normalizeStoreCity(cityGuess, address),
      };
    });
  });

  // Deduplicate across regions — the same physical store appears in multiple region responses.
  const seen = new Set();
  const stores = regionStores.flat().filter(Boolean).filter(s => {
    if (!s.lat || !s.lng) return false;
    const key = `${s.lat.toFixed(4)},${s.lng.toFixed(4)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
      const address = String(s.address || '').trim();
      const cityGuess = (address || '').split(',')[0].replace(/^г\.\s*/, '').trim();
      stores.push({
        name: s.name || 'Korzinka',
        address,
        lat: parseFloat(loc.lat) || 0,
        lng: parseFloat(loc.lon) || 0,
        city: normalizeStoreCity(cityGuess, address),
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

function normalizeCoordinates(rawLatitude, rawLongitude) {
  let latitude = Number(rawLatitude);
  let longitude = Number(rawLongitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { latitude: 0, longitude: 0 };
  }

  // Baraka API may return latitude/longitude fields swapped for some rows.
  if (Math.abs(latitude) > 55 && Math.abs(longitude) < 55) {
    const tmp = latitude;
    latitude = longitude;
    longitude = tmp;
  }

  return { latitude, longitude };
}

async function fetchBarakaStores() {
  const response = await fetch('https://backend.barakamarket.uz/shop/', {
    headers: BARAKA_HEADERS,
  });

  if (!response.ok) {
    throw new Error(`Baraka locations request failed: ${response.status}`);
  }

  const payload = await response.json();
  const rows = Array.isArray(payload)
    ? payload
    : (Array.isArray(payload?.results) ? payload.results : []);

  const dedupe = new Set();
  const stores = [];

  for (const row of rows) {
    const title = String(row?.title || row?.name || row?.title_uz || '').trim();
    const address = String(row?.address || row?.address_uz || '').trim();
    const { latitude, longitude } = normalizeCoordinates(
      row?.latitude ?? row?.lat,
      row?.longitude ?? row?.lng ?? row?.lon
    );

    if (!latitude || !longitude) continue;

    const branchName = title ? `Baraka Market ${title}` : 'Baraka Market';
    const branchAddress = address || 'Tashkent';
    const key = `${latitude.toFixed(5)}|${longitude.toFixed(5)}|${branchAddress.toLowerCase()}`;
    if (dedupe.has(key)) continue;
    dedupe.add(key);

    stores.push({
      name: branchName,
      address: branchAddress,
      lat: latitude,
      lng: longitude,
      city: normalizeStoreCity('Tashkent', branchAddress),
    });
  }

  return stores;
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
  const categoryRows = await runWithConcurrency(topCategories, HTTP_CONCURRENCY, async (cat) => {
    const allProducts = [];

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
    return allProducts;
  });

  const allProducts = categoryRows.flat().filter(Boolean);

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
  // Fetch categories first
  const catRes = await fetch('https://api.makromarket.uz/api/category-list/', {
    headers: MAKRO_HEADERS,
  });
  const categories = await catRes.json();

  const categoryRows = await runWithConcurrency(categories || [], HTTP_CONCURRENCY, async (cat) => {
    const url = `https://api.makromarket.uz/api/product-list/?category=${cat.id}&region=3&limit=500&p=true`;
    const res = await fetch(url, { headers: MAKRO_HEADERS });
    const data = await res.json();
    if (!Array.isArray(data?.results)) return [];

    return (data.results || []).map((item) => ({
      name: String(item.title || '').trim(),
      price: Math.round(parseFloat(item.newPrice) || parseFloat(item.oldPrice) || 0),
      oldPrice: Math.round(parseFloat(item.oldPrice) || 0),
      code: item.code,
      category: cat.title,
    })).filter(p => p.price > 0 && p.name);
  });

  const allProducts = categoryRows.flat().filter(Boolean);

  // Deduplicate by code (same product may appear in multiple categories)
  const seenMakro = new Set();
  return allProducts.filter(p => {
    if (seenMakro.has(p.code)) return false;
    seenMakro.add(p.code);
    return true;
  });
}

// ─── Korzinka scraper ──────────────────────────────────────────────────────
// The Korzinka catalog is accessible via the mobile endpoint with catalog_category_id values.
// These IDs cluster from ~800 to ~1410. Scanning this range yields ~21k unique products.
// The top-level /api/catalogs/categories response only has 8 promotional categories (~260 embedded).
async function scrapeKorzinka(range) {
  const start = Number.isFinite(range?.start) ? Math.max(KORZINKA_SCAN_START, range.start) : KORZINKA_SCAN_START;
  const end = Number.isFinite(range?.end) ? Math.min(KORZINKA_SCAN_END, range.end) : KORZINKA_SCAN_END;
  const ids = start > end
    ? []
    : Array.from({ length: end - start + 1 }, (_, i) => start + i);

  const categoryRows = await runWithConcurrency(ids, KORZINKA_CONCURRENCY, async (ccid) => {
    const res = await fetch('https://catalog.korzinka.uz/api/mobile/catalogs/category/products', {
      method: 'POST',
      headers: { ...KORZINKA_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ get_products: ccid }),
    }).catch(() => null);
    if (!res || !res.ok) return [];
    const data = await res.json().catch(() => null);
    if (!data || !Array.isArray(data.data) || data.data.length === 0) return [];

    return data.data.map((item) => {
      const priceStr = item.prices?.actual_price || '0';
      const price = parseInt(String(priceStr).replace(/\s/g, ''), 10) || 0;
      const oldPriceStr = item.prices?.old_price || '0';
      const oldPrice = parseInt(String(oldPriceStr).replace(/\s/g, ''), 10) || 0;
      const titleRu = String(item.title_ru || item.title || '').trim();
      const titleUz = item.title_uz && item.title_uz !== 'null' ? String(item.title_uz).trim() : null;
      return {
        name: titleRu,         // Russian name — primary for DB matching and creation
        nameUz: titleUz,       // Uzbek name from API (null when API has none)
        price,
        oldPrice,
        id: item.id,
        vendorCode: String(item.vendor_code || '').trim(),
        weight: item.weight_param || '',
      };
    }).filter(p => p.price > 0 && p.name);
  });

  // Deduplicate: prefer vendor_code, fall back to product id
  const seenVc = new Set();
  const seenId = new Set();
  const allProducts = [];
  for (const item of categoryRows.flat().filter(Boolean)) {
    const vc = item.vendorCode;
    if (vc && seenVc.has(vc)) continue;
    if (seenId.has(item.id)) continue;
    if (vc) seenVc.add(vc);
    seenId.add(item.id);
    allProducts.push(item);
  }
  return allProducts;
}

async function archiveStoreRows(sourceTag, rowIds, errors) {
  const ids = Array.from(rowIds || []).filter(Boolean);
  if (ids.length === 0) return 0;

  let archived = 0;
  for (const chunk of chunkArray(ids, DB_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from('prices')
      .update({ source: `history_${sourceTag}` })
      .in('id', chunk)
      .select('id');

    if (error) {
      errors.push({
        phase: 'archive',
        source: sourceTag,
        error: error.message,
      });
      continue;
    }
    archived += Array.isArray(data) ? data.length : 0;
  }

  return archived;
}

// Optional price columns that may not exist yet in an unmigrated database.
// If an insert fails because one of these columns is missing from the schema,
// we strip it from every row and retry so ingestion still succeeds.
const OPTIONAL_PRICE_COLUMNS = ['price_scope'];

function isMissingColumnError(error, column) {
  const msg = String(error?.message || '');
  return msg.includes(column) && /(schema cache|could not find|column)/i.test(msg);
}

function stripColumns(row, columns) {
  const copy = { ...row };
  for (const col of columns) delete copy[col];
  return copy;
}

async function insertPriceRows(rows, errors) {
  const payload = Array.isArray(rows) ? rows : [];
  if (payload.length === 0) {
    return { inserted: 0, successfulProductIds: new Set() };
  }

  let inserted = 0;
  const successfulProductIds = new Set();
  // Columns confirmed missing from this DB; dropped from all subsequent inserts.
  const droppedColumns = new Set();

  const prepare = (row) => (droppedColumns.size > 0 ? stripColumns(row, droppedColumns) : row);

  for (const chunk of chunkArray(payload, DB_CHUNK_SIZE)) {
    let preparedChunk = chunk.map(prepare);
    let { error } = await supabase.from('prices').insert(preparedChunk);

    // If the chunk failed because an optional column is missing, learn it, strip
    // it from this (and every future) chunk, and retry once.
    if (error) {
      for (const col of OPTIONAL_PRICE_COLUMNS) {
        if (!droppedColumns.has(col) && isMissingColumnError(error, col)) {
          droppedColumns.add(col);
        }
      }
      if (droppedColumns.size > 0) {
        preparedChunk = chunk.map(prepare);
        ({ error } = await supabase.from('prices').insert(preparedChunk));
      }
    }

    if (!error) {
      inserted += preparedChunk.length;
      for (const row of preparedChunk) {
        if (row?.product_id) successfulProductIds.add(row.product_id);
      }
      continue;
    }

    // Fall back to per-row inserts so one bad row can't sink the whole chunk.
    for (const row of chunk) {
      const { error: rowError } = await supabase.from('prices').insert(prepare(row));
      if (rowError) {
        errors.push({
          phase: 'insert',
          raw: row?.product_name_raw,
          branch: row?.place_address,
          error: rowError.message,
        });
      } else {
        inserted += 1;
        if (row?.product_id) successfulProductIds.add(row.product_id);
      }
    }
  }

  return { inserted, successfulProductIds };
}

// ─── Main handler ──────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' });
  if (!supabase) return send(res, 500, { ok: false, error: 'SUPABASE_NOT_CONFIGURED' });
  if (!serviceRoleKey) return send(res, 500, { ok: false, error: 'SUPABASE_SERVICE_ROLE_KEY required' });

  const { admin_id, store } = req.body || {};  if (!admin_id || !adminTelegramIds.includes(String(admin_id))) {
    return send(res, 403, { ok: false, error: 'Unauthorized' });
  }

  const validStores = ['makro', 'korzinka', ...Object.keys(YANDEX_STORES).map(k => `yandex_${k}`)];
  if (!store || !validStores.includes(store)) {
    return send(res, 400, { ok: false, error: `Invalid store. Use one of: ${validStores.join(', ')}` });
  }

  // Optional batching (korzinka only): split the category-id scan into N batches so
  // the large ~23k-row ingest fits inside the function time limit. `batches` is the
  // total number of slices; `batch` is the 1-based slice to run now (default: whole).
  const totalBatches = Math.max(1, Math.min(Number(req.body?.batches) || 1, 50));
  const batchIndex = Math.max(1, Math.min(Number(req.body?.batch) || 1, totalBatches));
  const isPartialRun = store === 'korzinka' && totalBatches > 1;
  let korzinkaRange = null;
  if (store === 'korzinka' && totalBatches > 1) {
    const span = KORZINKA_SCAN_END - KORZINKA_SCAN_START + 1;
    const per = Math.ceil(span / totalBatches);
    const start = KORZINKA_SCAN_START + (batchIndex - 1) * per;
    const end = Math.min(KORZINKA_SCAN_END, start + per - 1);
    korzinkaRange = { start, end };
  }

  try {
    const startedAt = Date.now();

    // 1. Pre-fetch data needed for the matcher caches (avoids N repeated DB calls in the loop).
    //    sourceProductsCache  — all store_products already seen from this source (Level 4)
    //    canonicalProductsCache — all canonical products (Level 5)
    //    Both are loaded after we know the store name; populated below after step 2.

    // Caches populated after we know the store; passed to matchProduct to avoid N DB round-trips.
    let sourceProductsCache = [];
    let canonicalProductsCache = [];

    // 2. Scrape store
    let storeProducts;
    let stores;
    const isYandex = store.startsWith('yandex_');
    if (store === 'makro') {
      storeProducts = await scrapeMakro();
      const makroStores = await fetchMakroStores();
      stores = makroStores.length > 0 ? makroStores : [CHAIN_REPRESENTATIVE_STORES.makro];
    } else if (store === 'korzinka') {
      storeProducts = await scrapeKorzinka(korzinkaRange);
      const korzinkaStores = await fetchKorzinkaStores();
      stores = korzinkaStores.length > 0 ? korzinkaStores : [CHAIN_REPRESENTATIVE_STORES.korzinka];
    } else if (isYandex) {
      const yandexKey = store.replace('yandex_', '');
      const storeConfig = YANDEX_STORES[yandexKey];
      storeProducts = await scrapeYandexStore(yandexKey);

      if (yandexKey === 'baraka') {
        const barakaBranches = await fetchBarakaStores();
        stores = barakaBranches.length > 0
          ? barakaBranches
          : [{
              name: storeConfig.name,
              address: storeConfig.address,
              lat: storeConfig.lat,
              lng: storeConfig.lng,
              city: storeConfig.city,
            }];
      } else {
        // Yandex prices are chain-wide; use the representative store location
        stores = [{
          name: storeConfig.name,
          address: storeConfig.address,
          lat: storeConfig.lat,
          lng: storeConfig.lng,
          city: normalizeStoreCity(storeConfig.city, storeConfig.address),
        }];
      }
    }

    if (!stores || stores.length === 0) {
      return send(res, 200, { ok: true, inserted: 0, matched: 0, total: 0, message: 'Could not fetch store locations from API' });
    }

    if (!storeProducts || storeProducts.length === 0) {
      return send(res, 200, { ok: true, inserted: 0, matched: 0, total: 0, message: 'No products found from store API' });
    }

    const storeBrand = store === 'makro' ? 'Makro' : store === 'korzinka' ? 'Korzinka' : YANDEX_STORES[store.replace('yandex_', '')]?.name || store;

    // Preload current store_api rows for this source to diff against the new scrape.
    const sourceTag = `store_api_${store}`;
    // Chain model: an API product is stored as ONE chain-wide row per (product × city)
    // with price_scope='chain' and no coordinates — NOT duplicated across every branch.
    // The Mini App expands each chain row to the brand's branches at search time.
    //
    // Price-history diff: instead of archiving and re-inserting everything on each run
    // (which churns the table and creates duplicates), we compare each scraped
    // (product × city) against the current row:
    //   • same price  → keep the existing row untouched (no duplicate, no history entry)
    //   • new price    → archive the old row to history_* (preserving the prior price for
    //                    trend analysis) and insert the new current row
    //   • disappeared  → archive the stale row to history_*
    const { data: currentApiRows } = await supabase
      .from('prices')
      .select('id, product_id, product_name_raw, city, price')
      .eq('source', sourceTag);

    const currentByKey = new Map(); // `${keyId}|${city}` -> [{ id, price }]
    const allCurrentIds = [];
    for (const row of currentApiRows || []) {
      allCurrentIds.push(row.id);
      const keyId = row.product_id || `raw:${normalizeProductNameKey(row.product_name_raw)}`;
      const key = `${keyId}|${String(row.city || '').trim().toLowerCase()}`;
      const list = currentByKey.get(key) || [];
      list.push({ id: row.id, price: Number(row.price) });
      currentByKey.set(key, list);
    }
    // Ids of current rows to retain as-is (unchanged price). Everything else is archived.
    const keepIds = new Set();

    const defaultCity = normalizeStoreCity(stores?.[0]?.city, stores?.[0]?.address);

    // Distinct cities the brand operates in. Collapses dozens of branches into a
    // handful of city-scoped chain rows; falls back to the representative city.
    const branchCities = [];
    const seenCities = new Set();
    for (const branch of stores) {
      const c = normalizeStoreCity(branch.city, branch.address || '') || defaultCity;
      const key = String(c || '').trim().toLowerCase();
      if (key && !seenCities.has(key)) { seenCities.add(key); branchCities.push(c); }
    }
    if (branchCities.length === 0 && defaultCity) branchCities.push(defaultCity);

    // 3b. Pre-fetch matcher caches once (avoids repeated DB queries inside the per-product loop).
    //     sourceProductsCache — all store_products already matched for this source (Level 4 in matcher)
    //     canonicalProductsCache — full canonical products table (Level 5 in matcher)
    const normSource = store === 'makro' ? 'makro_api'
      : store === 'korzinka' ? 'korzinka_api'
      : store.startsWith('yandex_') ? `${store.replace(/^yandex_/, '')}_api`
      : store;

    const [{ data: spRows }, { data: cpRows }] = await Promise.all([
      supabase.from('store_products')
        .select('id, original_name, normalised_name, token_sorted_name, canonical_product_id')
        .eq('source', normSource),
      supabase.from('products')
        .select('id, name_uz, name_ru, name_en, search_text'),
    ]);
    const allSourceProducts = spRows || [];
    sourceProductsCache = allSourceProducts.filter((r) => r.canonical_product_id);
    canonicalProductsCache = cpRows || [];

    // In-memory indexes so the matcher resolves Levels 1-3 with zero per-product
    // DB reads. byOriginal covers every row; the normalised/token maps only hold
    // rows that already carry a canonical match (Levels 2-3 require one).
    const sourceAllCache = { byOriginal: new Map(), byNormalised: new Map(), byTokenSorted: new Map() };
    for (const r of allSourceProducts) {
      if (r.original_name != null && !sourceAllCache.byOriginal.has(r.original_name)) {
        sourceAllCache.byOriginal.set(r.original_name, r);
      }
      if (r.canonical_product_id) {
        if (r.normalised_name != null && !sourceAllCache.byNormalised.has(r.normalised_name)) {
          sourceAllCache.byNormalised.set(r.normalised_name, r);
        }
        if (r.token_sorted_name != null && !sourceAllCache.byTokenSorted.has(r.token_sorted_name)) {
          sourceAllCache.byTokenSorted.set(r.token_sorted_name, r);
        }
      }
    }
    // Deferred store_products writes — flushed once after the loop in a single batch.
    const storeProductUpsertQueue = [];

    // 4. Match via store_products layer and batch DB writes.
    let matched = 0;
    let unmatched = 0;
    let skipped = 0;
    let skippedDup = 0;
    let unchanged = 0;
    const errors = [];
    const now = new Date().toISOString();
    const processedBranchKeys = new Set();
    const rowsToInsert = [];
    const touchedKeys = new Set();
    const aliasRowsByKey = new Map();

    for (const sp of storeProducts) {
      const rawName = sp.nameUz || sp.name || '';
      if (!rawName || !(sp.price > 0)) { skipped++; continue; } // !(x > 0) correctly rejects NaN

      // Five-level matching: exact → normalised → token-sorted → store-scoped fuzzy → cross-store fuzzy → unmatched
      const matchResult = await matchProduct(rawName, store, supabase, fuzzball, {
        sourceProductsCache,
        canonicalProductsCache,
        sourceAllCache,
        upsertQueue: storeProductUpsertQueue,
      });

      // Approach A: even when a product has no canonical match, still write the price
      // row (product_id = null) so it becomes findable. Unmatched rows are deduped by
      // raw name instead of product id.
      const matchedProductId = matchResult.canonical_product_id || null;
      const storeProductId = matchResult.store_product_id;
      if (!matchedProductId) unmatched += 1;
      const dedupId = matchedProductId || `raw:${normalizeProductNameKey(rawName)}`;

      // Chain model: one chain-wide row per city the brand operates in. No
      // per-branch coordinates — the Mini App resolves the nearest branch at
      // search time from the live store directory.
      let queuedThisProduct = false;
      for (const city of branchCities) {
        const placeName = storeBrand;
        const placeAddress = storeBrand;

        const branchKey = buildStoreBranchKey({
          productId: dedupId,
          city,
          placeName,
          placeAddress,
        });
        if (processedBranchKeys.has(branchKey)) {
          skippedDup++;
          continue;
        }
        processedBranchKeys.add(branchKey);

        // Diff against the current row for this (product × city).
        const diffKey = `${dedupId}|${String(city || '').trim().toLowerCase()}`;
        touchedKeys.add(diffKey);
        const existingRows = currentByKey.get(diffKey);
        const samePriceRow = existingRows && existingRows.find((e) => e.price === Number(sp.price));
        if (samePriceRow) {
          // Unchanged price — retain the existing row, write no duplicate, log no history.
          keepIds.add(samePriceRow.id);
          unchanged++;
          queuedThisProduct = true; // keep alias upkeep for matched products
          continue;
        }
        // New product OR changed price: the old row(s) for this key get archived to
        // history below (price preserved), and we insert the fresh current row.
        rowsToInsert.push({
          product_name_raw: rawName,
          product_id: matchedProductId,
          store_product_id: storeProductId,
          price: sp.price,
          quantity: 1,
          unit_price: sp.price,
          city,
          place_name: placeName,
          place_address: placeAddress,
          receipt_date: now,
          source: sourceTag,
          status: 'approved',
          price_scope: 'chain',
          submitted_by: String(admin_id),
          latitude: null,
          longitude: null,
        });

        queuedThisProduct = true;
      }

      if (queuedThisProduct && matchedProductId) {
        const aliasKey = `${matchedProductId}|${normalizeAliasKey(rawName)}|${normalizeAliasKey(storeBrand)}`;
        if (!aliasRowsByKey.has(aliasKey)) {
          aliasRowsByKey.set(aliasKey, {
            productId: matchedProductId,
            aliasText: rawName,
            storeName: storeBrand,
          });
        }
      }
    }

    // Flush all deferred store_products writes in one batched upsert, then backfill
    // store_product_id onto the price rows for any brand-new entries.
    if (storeProductUpsertQueue.length > 0) {
      const dedupSp = new Map();
      for (const sp of storeProductUpsertQueue) dedupSp.set(sp.original_name, sp);
      const spPayload = Array.from(dedupSp.values());
      const spIdByName = new Map();
      for (let i = 0; i < spPayload.length; i += 500) {
        const chunk = spPayload.slice(i, i + 500);
        const { data: upserted, error: spErr } = await supabase
          .from('store_products')
          .upsert(chunk, { onConflict: 'source,original_name' })
          .select('id, original_name');
        if (spErr) { errors.push(`store_products upsert: ${spErr.message}`); continue; }
        for (const r of (upserted || [])) spIdByName.set(r.original_name, r.id);
      }
      for (const row of rowsToInsert) {
        if (!row.store_product_id) row.store_product_id = spIdByName.get(row.product_name_raw) || null;
      }
    }

    // Archive every current row we did NOT retain: price changes (old value kept as
    // history), delisted products, and any duplicate extras for the same key.
    //
    // On a PARTIAL (batched) run we only scraped a subset of the catalog, so a row we
    // didn't see is NOT necessarily delisted — it may just belong to another batch.
    // We therefore archive only rows for keys this batch actually touched (price
    // changes/dupes), never treating un-scraped keys as delisted.
    let archiveIds;
    if (isPartialRun) {
      archiveIds = new Set();
      for (const key of touchedKeys) {
        for (const entry of currentByKey.get(key) || []) {
          if (!keepIds.has(entry.id)) archiveIds.add(entry.id);
        }
      }
    } else {
      archiveIds = new Set(allCurrentIds.filter((id) => !keepIds.has(id)));
    }
    const archived = await archiveStoreRows(sourceTag, archiveIds, errors);
    const insertResult = await insertPriceRows(rowsToInsert, errors);
    const inserted = insertResult.inserted;
    matched = insertResult.successfulProductIds.size;

    const aliasRows = Array.from(aliasRowsByKey.values())
      .filter(row => insertResult.successfulProductIds.has(row.productId));
    await runWithConcurrency(aliasRows, 10, async (row) => {
      await upsertProductAlias(row.productId, row.aliasText, row.storeName);
      return true;
    });

    const durationMs = Date.now() - startedAt;

    const hasMore = isPartialRun && batchIndex < totalBatches;
    return send(res, 200, {
      ok: true,
      store,
      total: storeProducts.length,
      inserted,
      matched,
      unmatched,
      skipped,
      skippedDup,
      unchanged,
      archived,
      queued: rowsToInsert.length,
      batch: isPartialRun ? batchIndex : undefined,
      batches: isPartialRun ? totalBatches : undefined,
      hasMore: isPartialRun ? hasMore : undefined,
      nextBatch: hasMore ? batchIndex + 1 : undefined,
      durationMs,
      errors: errors.length > 0 ? errors.slice(0, 10) : undefined,
      message: `Scraped ${storeProducts.length} products from ${store}${isPartialRun ? ` (batch ${batchIndex}/${totalBatches})` : ''} across ${stores.length} branches (${branchCities.length} ${branchCities.length === 1 ? 'city' : 'cities'}): ${inserted} new/changed prices written, ${unchanged} unchanged kept, ${archived} prior prices archived to history (${matched} matched to canonical, ${unmatched} unmatched) in ${Math.round(durationMs / 1000)}s.${hasMore ? ` Run batch ${batchIndex + 1}/${totalBatches} next.` : ''}`,
    });
  } catch (err) {
    console.error('scrape-stores error:', err);
    return send(res, 500, { ok: false, error: err.message || 'Internal error' });
  }
}
