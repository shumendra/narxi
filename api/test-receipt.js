import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import {
  isSoliqUrl,
  normalizeSoliqUrl,
  parseReceiptHtml,
  fetchProductsIndex,
  fuzzyMatchProduct,
  extractCityFromAddress,
} from './utils/receipt.js';

export const config = {
  api: { bodyParser: true },
  maxDuration: 60,
};

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  '';

function withCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

/**
 * Session-based fetch: ofd.soliq.uz requires visiting the homepage first
 * to get session cookies, then using those cookies on the check URL.
 */
async function fetchReceiptWithSession(checkUrl, log) {
  log.push(`[1] Starting session fetch for: ${checkUrl}`);

  // Step 1: Visit homepage to get session cookies
  let sessionCookies = '';
  try {
    const homeResp = await axios.get('https://ofd.soliq.uz', {
      timeout: 15000,
      maxRedirects: 5,
      validateStatus: () => true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru,uz;q=0.9,en;q=0.8',
      },
    });

    log.push(`[2] Homepage response: status=${homeResp.status}, headers=${Object.keys(homeResp.headers).join(',')}`);

    // Extract Set-Cookie headers
    const setCookieHeaders = homeResp.headers['set-cookie'];
    if (setCookieHeaders) {
      const cookies = (Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders]);
      sessionCookies = cookies.map(c => c.split(';')[0]).join('; ');
      log.push(`[3] Got cookies: ${sessionCookies.substring(0, 120)}...`);
    } else {
      log.push('[3] No Set-Cookie headers from homepage');
    }
  } catch (err) {
    log.push(`[2] Homepage error: ${err.message}`);
  }

  // Step 2: Fetch the actual check URL with session cookies
  const fetchHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ru,uz;q=0.9,en;q=0.8',
    'Referer': 'https://ofd.soliq.uz/',
    'Cache-Control': 'no-cache',
  };
  if (sessionCookies) {
    fetchHeaders['Cookie'] = sessionCookies;
  }

  let html = '';
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      log.push(`[4] Fetching check URL (attempt ${attempt + 1}/3)...`);

      const resp = await axios.get(checkUrl, {
        timeout: 30000,
        maxRedirects: 5,
        validateStatus: () => true,
        headers: fetchHeaders,
      });

      log.push(`[5] Check response: status=${resp.status}, length=${String(resp.data || '').length}`);

      html = String(resp.data || '');

      // Check if receipt is still generating
      const lower = html.toLowerCase();
      if (lower.includes('shakllanmoqda') || (lower.includes('alert-danger') && !lower.includes('products-tables') && !lower.includes('nomi'))) {
        log.push('[6] Receipt still generating, will retry...');
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 4000));
          continue;
        }
        return { html: '', generating: true, log };
      }

      // Check if we got actual receipt data
      const hasTable = html.includes('products-tables') || html.includes('Nomi') || html.includes('nomi') || html.includes('Наименование');
      log.push(`[6] Has receipt table: ${hasTable}, HTML snippet: ${html.substring(0, 300).replace(/\s+/g, ' ')}`);

      if (!hasTable && attempt < 2) {
        log.push('[6] No receipt table found, retrying...');
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      break;
    } catch (err) {
      lastError = err;
      log.push(`[5] Fetch error (attempt ${attempt + 1}): ${err.message}`);
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  if (!html && lastError) {
    return { html: '', error: lastError.message, log };
  }

  return { html, log };
}

export default async function handler(req, res) {
  withCors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: false, error: 'POST required' });
  }

  const log = [];

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const rawUrl = String(body.url || '').trim();
    const url = normalizeSoliqUrl(rawUrl) || rawUrl;

    log.push(`Input URL: ${rawUrl}`);
    log.push(`Normalized URL: ${url}`);

    if (!isSoliqUrl(url)) {
      return res.status(200).json({ ok: false, error: 'not_soliq_url', detail: 'URL must be an ofd.soliq.uz/check link', log });
    }

    // Fetch with session
    const result = await fetchReceiptWithSession(url, log);

    if (result.generating) {
      return res.status(200).json({ ok: false, error: 'generating', detail: 'Receipt is still being generated. Try again in a few seconds.', log: result.log });
    }

    if (result.error || !result.html) {
      return res.status(200).json({ ok: false, error: 'fetch_failed', detail: result.error || 'Empty HTML response', log: result.log });
    }

    // Parse the HTML
    log.push(`[7] Parsing HTML (${result.html.length} chars)...`);
    const parsed = parseReceiptHtml(result.html);

    if (!parsed) {
      log.push('[8] parseReceiptHtml returned null');
      return res.status(200).json({ ok: false, error: 'parse_failed', detail: 'Could not parse receipt HTML', log });
    }

    log.push(`[8] Parsed: store="${parsed.store_name}", address="${parsed.store_address}", date="${parsed.receipt_date}", items=${(parsed.items || []).length}`);

    // Extract coordinates from HTML
    const coordMatch = result.html.match(/Placemark\s*\(\s*\[\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*\]/);
    const latitude = coordMatch ? parseFloat(coordMatch[1]) : null;
    const longitude = coordMatch ? parseFloat(coordMatch[2]) : null;
    if (coordMatch) {
      log.push(`[9] Coordinates: ${latitude}, ${longitude}`);
    }

    const city = extractCityFromAddress(parsed.store_address) || 'Tashkent';

    // Fuzzy match items against product catalog
    let matchedItems = (parsed.items || []).map(item => ({
      name: item.name,
      quantity: item.quantity,
      totalPrice: item.price,
      unitPrice: item.unit_price,
      matchedProduct: null,
      matchScore: 0,
    }));

    if (supabaseUrl && supabaseKey && matchedItems.length > 0) {
      try {
        const supabase = createClient(supabaseUrl, supabaseKey);
        const products = await fetchProductsIndex(supabase);
        log.push(`[10] Loaded ${products.length} products for matching`);

        matchedItems = matchedItems.map(item => {
          const { product, score } = fuzzyMatchProduct(item.name, products);
          return {
            ...item,
            matchedProduct: product ? { id: product.id, name_uz: product.name_uz, name_ru: product.name_ru } : null,
            matchScore: score,
          };
        });
      } catch (matchErr) {
        log.push(`[10] Product matching error: ${matchErr.message}`);
      }
    }

    log.push(`[11] Done: ${matchedItems.length} items matched`);

    return res.status(200).json({
      ok: true,
      receiptUrl: url,
      storeName: parsed.store_name || null,
      storeAddress: parsed.store_address || null,
      city,
      receiptDate: parsed.receipt_date || null,
      latitude,
      longitude,
      totalAmount: parsed.items?.reduce((s, i) => s + (i.price || 0), 0) || null,
      parseStage: matchedItems.length > 0 ? 'table' : 'metadata_only',
      itemCount: matchedItems.length,
      items: matchedItems,
      log,
    });
  } catch (err) {
    log.push(`FATAL: ${err.message}`);
    return res.status(200).json({ ok: false, error: 'internal_error', detail: err.message, log });
  }
}
