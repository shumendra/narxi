import { createClient } from '@supabase/supabase-js';
import { fuzzyMatchProduct } from './utils/receipt.js';

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabaseKey = serviceRoleKey || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
const adminTelegramIds = (process.env.ADMIN_TELEGRAM_IDS || process.env.ADMIN_TELEGRAM_ID || '')
  .split(',').map(id => id.trim()).filter(Boolean);

const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

function send(res, status, body) {
  res.setHeader('Content-Type', 'application/json');
  res.status(status).send(JSON.stringify(body));
}

// ─── Store configs ─────────────────────────────────────────────────────────
// Makro: known Tashkent branches with coordinates
const MAKRO_STORES = [
  { name: 'Makro', address: 'Tashkent, Makro Qorasaroy', lat: 41.3111, lng: 69.2796, region: 3 },
];

// Korzinka store info (generic — no branch-level pricing from catalog API)
const KORZINKA_STORE = { name: 'Korzinka', address: 'Tashkent, Korzinka', lat: 41.3111, lng: 69.2796 };

// ─── Makro scraper ─────────────────────────────────────────────────────────
async function scrapeMakro() {
  const allProducts = [];

  // Fetch categories first
  const catRes = await fetch('https://api.makromarket.uz/api/category-list/', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Accept': 'application/json',
      'Origin': 'https://makromarket.uz',
      'Referer': 'https://makromarket.uz/',
    },
  });
  const categories = await catRes.json();

  // Fetch products from each category
  for (const cat of categories) {
    const url = `https://api.makromarket.uz/api/product-list/?category=${cat.id}&region=3&limit=500&p=true`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'application/json',
        'Origin': 'https://makromarket.uz',
        'Referer': 'https://makromarket.uz/',
      },
    });
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
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Accept': 'application/json',
      'Origin': 'https://korzinka.uz',
      'Referer': 'https://korzinka.uz/',
    },
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

  if (!store || !['makro', 'korzinka'].includes(store)) {
    return send(res, 400, { ok: false, error: 'Invalid store. Use "makro" or "korzinka".' });
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
    let storeInfo;
    if (store === 'makro') {
      storeProducts = await scrapeMakro();
      storeInfo = MAKRO_STORES[0];
    } else {
      storeProducts = await scrapeKorzinka();
      storeInfo = KORZINKA_STORE;
    }

    if (!storeProducts || storeProducts.length === 0) {
      return send(res, 200, { ok: true, inserted: 0, matched: 0, total: 0, message: 'No products found from store API' });
    }

    // 3. Match and insert into pending_prices
    let inserted = 0;
    let matched = 0;
    let skipped = 0;
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

      const payload = {
        product_name_raw: sp.name || rawName,
        product_id: finalMatch?.id || null,
        match_confidence: finalScore,
        status: 'pending',
        price: sp.price,
        quantity: 1,
        unit_price: sp.price,
        city: 'Tashkent',
        place_name: storeInfo.name,
        place_address: storeInfo.address,
        receipt_date: now,
        source: `store_api_${store}`,
        submitted_by: String(admin_id),
        latitude: storeInfo.lat,
        longitude: storeInfo.lng,
      };

      const { error } = await supabase.from('pending_prices').insert(payload);
      if (error) {
        errors.push({ name: rawName, error: error.message });
      } else {
        inserted++;
        if (finalScore >= 60) matched++;
      }
    }

    return send(res, 200, {
      ok: true,
      store,
      total: storeProducts.length,
      inserted,
      matched,
      skipped,
      errors: errors.length > 0 ? errors.slice(0, 10) : undefined,
      message: `Scraped ${storeProducts.length} products from ${store}, inserted ${inserted} into pending_prices (${matched} matched to catalog).`,
    });
  } catch (err) {
    console.error('scrape-stores error:', err);
    return send(res, 500, { ok: false, error: err.message || 'Internal error' });
  }
}
