import { createClient } from '@supabase/supabase-js';
import { fuzzyMatchProduct } from './utils/receipt.js';
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

const STORE_API_MATCH_MIN_SCORE = 70;
const HTTP_CONCURRENCY = 8;
const DB_CHUNK_SIZE = 250;

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

  const stores = regionStores.flat().filter(Boolean);
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

    return data.results.map((item) => ({
      name: item.title,
      price: Math.round(item.newPrice), // current promo price
      oldPrice: Math.round(item.oldPrice),
      code: item.code,
      category: cat.title,
    }));
  });

  const allProducts = categoryRows.flat().filter(Boolean);

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
  const mobileRows = await runWithConcurrency(categoryIds, HTTP_CONCURRENCY, async (catId) => {
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
    if (!Array.isArray(data?.data)) return [];

    return data.data.map((item) => {
      const priceStr = item.prices?.actual_price || '0';
      const price = parseInt(String(priceStr).replace(/\s/g, ''), 10) || 0;
      const oldPriceStr = item.prices?.old_price || '0';
      const oldPrice = parseInt(String(oldPriceStr).replace(/\s/g, ''), 10) || 0;
      return {
        name: item.title_ru || item.title || '',
        nameUz: item.title_uz || '',
        price,
        oldPrice,
        id: item.id,
        categoryId: item.catalog_category_id,
        category: '',
        weight: item.weight_param || '',
      };
    });
  });
  allProducts.push(...mobileRows.flat().filter(Boolean));

  // Deduplicate by id
  const seen = new Set();
  return allProducts.filter(p => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return p.price > 0;
  });
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

async function insertPriceRows(rows, errors) {
  const payload = Array.isArray(rows) ? rows : [];
  if (payload.length === 0) {
    return { inserted: 0, successfulProductIds: new Set() };
  }

  let inserted = 0;
  const successfulProductIds = new Set();

  for (const chunk of chunkArray(payload, DB_CHUNK_SIZE)) {
    const { error } = await supabase.from('prices').insert(chunk);
    if (!error) {
      inserted += chunk.length;
      for (const row of chunk) {
        if (row?.product_id) successfulProductIds.add(row.product_id);
      }
      continue;
    }

    for (const row of chunk) {
      const { error: rowError } = await supabase.from('prices').insert(row);
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

  const { admin_id, store } = req.body || {};
  if (!admin_id || !adminTelegramIds.includes(String(admin_id))) {
    return send(res, 403, { ok: false, error: 'Unauthorized' });
  }

  const validStores = ['makro', 'korzinka', ...Object.keys(YANDEX_STORES).map(k => `yandex_${k}`)];
  if (!store || !validStores.includes(store)) {
    return send(res, 400, { ok: false, error: `Invalid store. Use one of: ${validStores.join(', ')}` });
  }

  try {
    const startedAt = Date.now();

    // 1. Fetch our products for matching
    const { data: products } = await supabase
      .from('products')
      .select('id,name_uz,name_ru,name_en,search_text');

    // Also get aliases for enriched matching
    const { data: aliases } = await supabase.from('product_aliases').select('product_id, alias_text');
    const aliasMap = {};
    for (const a of aliases || []) {
      if (!aliasMap[a.product_id]) aliasMap[a.product_id] = [];
      aliasMap[a.product_id].push(a.alias_text);
    }

    const productIdsByNameKey = new Map();
    const registerProductNameKey = (productId, rawName) => {
      const key = normalizeProductNameKey(rawName);
      if (!productId || !key) return;

      if (!productIdsByNameKey.has(key)) {
        productIdsByNameKey.set(key, new Set());
      }
      productIdsByNameKey.get(key).add(productId);
    };

    for (const product of products || []) {
      registerProductNameKey(product.id, product.name_uz);
      registerProductNameKey(product.id, product.name_ru);
      registerProductNameKey(product.id, product.name_en);
    }
    for (const alias of aliases || []) {
      registerProductNameKey(alias.product_id, alias.alias_text);
    }

    const enrichedProducts = (products || []).map(p => ({
      ...p,
      search_text: [p.search_text || '', ...(aliasMap[p.id] || [])].join(' '),
    }));

    const createdProductIdByNameKey = new Map();
    let autoCreatedProducts = 0;

    const resolveOrCreateProductForApiName = async (rawName, cityHint = 'Tashkent') => {
      const normalizedName = String(rawName || '').trim();
      const rawKey = normalizeProductNameKey(normalizedName);
      if (!normalizedName || !rawKey) return null;

      const knownIds = Array.from(productIdsByNameKey.get(rawKey) || []);
      if (knownIds.length === 1) return knownIds[0];
      if (knownIds.length > 1) return null;

      if (createdProductIdByNameKey.has(rawKey)) {
        return createdProductIdByNameKey.get(rawKey);
      }

      const { data: existingByName } = await supabase
        .from('products')
        .select('id,name_uz,name_ru,name_en,search_text')
        .ilike('name_uz', normalizedName)
        .limit(1)
        .maybeSingle();

      if (existingByName?.id) {
        registerProductNameKey(existingByName.id, existingByName.name_uz);
        registerProductNameKey(existingByName.id, existingByName.name_ru);
        registerProductNameKey(existingByName.id, existingByName.name_en);
        registerProductNameKey(existingByName.id, normalizedName);
        createdProductIdByNameKey.set(rawKey, existingByName.id);
        enrichedProducts.push({
          id: existingByName.id,
          name_uz: existingByName.name_uz,
          name_ru: existingByName.name_ru,
          name_en: existingByName.name_en,
          search_text: existingByName.search_text || `${existingByName.name_uz || ''} ${existingByName.name_ru || ''} ${existingByName.name_en || ''}`.trim(),
        });
        return existingByName.id;
      }

      const cityValue = normalizeCityName(cityHint || '') || 'Tashkent';
      const createPayload = {
        name_uz: normalizedName,
        name_ru: normalizedName,
        name_en: normalizedName,
        search_text: normalizedName,
        category: 'Boshqa',
        unit: 'dona',
        available_cities: cityValue ? [cityValue] : [],
      };

      const { data: created, error: createError } = await supabase
        .from('products')
        .insert(createPayload)
        .select('id,name_uz,name_ru,name_en,search_text')
        .single();

      if (createError || !created?.id) {
        const { data: fallback } = await supabase
          .from('products')
          .select('id,name_uz,name_ru,name_en,search_text')
          .ilike('name_uz', normalizedName)
          .limit(1)
          .maybeSingle();

        if (!fallback?.id) return null;

        registerProductNameKey(fallback.id, fallback.name_uz);
        registerProductNameKey(fallback.id, fallback.name_ru);
        registerProductNameKey(fallback.id, fallback.name_en);
        registerProductNameKey(fallback.id, normalizedName);
        createdProductIdByNameKey.set(rawKey, fallback.id);
        enrichedProducts.push({
          id: fallback.id,
          name_uz: fallback.name_uz,
          name_ru: fallback.name_ru,
          name_en: fallback.name_en,
          search_text: fallback.search_text || `${fallback.name_uz || ''} ${fallback.name_ru || ''} ${fallback.name_en || ''}`.trim(),
        });
        return fallback.id;
      }

      autoCreatedProducts += 1;
      registerProductNameKey(created.id, created.name_uz);
      registerProductNameKey(created.id, created.name_ru);
      registerProductNameKey(created.id, created.name_en);
      registerProductNameKey(created.id, normalizedName);
      createdProductIdByNameKey.set(rawKey, created.id);
      enrichedProducts.push({
        id: created.id,
        name_uz: created.name_uz,
        name_ru: created.name_ru,
        name_en: created.name_en,
        search_text: created.search_text || normalizedName,
      });
      return created.id;
    };

    // 2. Scrape store
    let storeProducts;
    let stores;
    const isYandex = store.startsWith('yandex_');
    if (store === 'makro') {
      storeProducts = await scrapeMakro();
      const makroStores = await fetchMakroStores();
      stores = makroStores.length > 0 ? makroStores : [CHAIN_REPRESENTATIVE_STORES.makro];
    } else if (store === 'korzinka') {
      storeProducts = await scrapeKorzinka();
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

    // Preload current store_api rows for this source so we can refresh branch rows atomically.
    const sourceTag = `store_api_${store}`;
    const { data: currentApiRows } = await supabase
      .from('prices')
      .select('id,product_id,price,city,place_name,place_address')
      .eq('source', sourceTag);

    const currentExactSet = new Set();
    const currentByBranchKey = new Map();
    for (const row of currentApiRows || []) {
      const exactKey = buildStoreExactKey({
        productId: row.product_id,
        price: row.price,
        city: row.city,
        placeName: row.place_name,
        placeAddress: row.place_address,
      });
      currentExactSet.add(exactKey);

      const branchKey = buildStoreBranchKey({
        productId: row.product_id,
        city: row.city,
        placeName: row.place_name,
        placeAddress: row.place_address,
      });
      const list = currentByBranchKey.get(branchKey) || [];
      list.push(row.id);
      currentByBranchKey.set(branchKey, list);
    }

    const defaultCity = normalizeStoreCity(stores?.[0]?.city, stores?.[0]?.address);

    // 4. Match in-memory first and batch DB writes later.
    let matched = 0;
    let unmatched = 0;
    let skipped = 0;
    let skippedDup = 0;
    const errors = [];
    const now = new Date().toISOString();
    const processedBranchKeys = new Set();
    const archiveIds = new Set();
    const rowsToInsert = [];
    const aliasRowsByKey = new Map();

    for (const sp of storeProducts) {
      const rawName = sp.nameUz || sp.name || '';
      if (!rawName || sp.price <= 0) { skipped++; continue; }

      const rawNameKey = normalizeProductNameKey(rawName);
      const exactIds = rawNameKey ? Array.from(productIdsByNameKey.get(rawNameKey) || []) : [];
      let matchedProductId = exactIds.length === 1 ? exactIds[0] : null;

      if (!matchedProductId && enrichedProducts.length > 0) {
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
        matchedProductId = isConfidentMatch ? finalMatch.id : null;
      }

      if (!matchedProductId) {
        matchedProductId = await resolveOrCreateProductForApiName(rawName, defaultCity);
        if (!matchedProductId) {
          unmatched += 1;
          continue;
        }
      }

      // Queue inserts for every branch — API prices are chain-wide.
      let queuedThisProduct = false;
      for (const branch of stores) {
        const placeName = normalizeMaybeText(branch.name) || storeBrand;
        const placeAddress = normalizeMaybeText(branch.address) || placeName;
        const city = normalizeStoreCity(branch.city, placeAddress || '');

        const branchKey = buildStoreBranchKey({
          productId: matchedProductId,
          city,
          placeName,
          placeAddress,
        });
        if (processedBranchKeys.has(branchKey)) {
          skippedDup++;
          continue;
        }
        processedBranchKeys.add(branchKey);

        const exactKey = buildStoreExactKey({
          productId: matchedProductId,
          price: sp.price,
          city,
          placeName,
          placeAddress,
        });
        if (currentExactSet.has(exactKey)) {
          skippedDup++;
          continue;
        }

        const rowsForBranch = currentByBranchKey.get(branchKey) || [];
        for (const rowId of rowsForBranch) archiveIds.add(rowId);
        currentByBranchKey.set(branchKey, []);

        rowsToInsert.push({
          product_name_raw: rawName,
          product_id: matchedProductId,
          price: sp.price,
          quantity: 1,
          unit_price: sp.price,
          city,
          place_name: placeName,
          place_address: placeAddress,
          receipt_date: now,
          source: sourceTag,
          submitted_by: String(admin_id),
          latitude: Number.isFinite(Number(branch.lat)) ? Number(branch.lat) : null,
          longitude: Number.isFinite(Number(branch.lng)) ? Number(branch.lng) : null,
        });

        currentExactSet.add(exactKey);
        queuedThisProduct = true;
      }

      if (queuedThisProduct) {
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

    return send(res, 200, {
      ok: true,
      store,
      total: storeProducts.length,
      inserted,
      matched,
      unmatched,
      skipped,
      skippedDup,
      archived,
      queued: rowsToInsert.length,
      autoCreatedProducts,
      durationMs,
      errors: errors.length > 0 ? errors.slice(0, 10) : undefined,
      message: `Scraped ${storeProducts.length} products × ${stores.length} branches from ${store}: ${inserted} prices written (${matched} matched products, ${unmatched} unmatched, ${autoCreatedProducts} auto-created), ${skippedDup} unchanged duplicates skipped in ${Math.round(durationMs / 1000)}s.`,
    });
  } catch (err) {
    console.error('scrape-stores error:', err);
    return send(res, 500, { ok: false, error: err.message || 'Internal error' });
  }
}
