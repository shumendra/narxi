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
  api: { bodyParser: { sizeLimit: '2mb' } },
  maxDuration: 30,
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

export default async function handler(req, res) {
  withCors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: false, error: 'POST required' });
  }

  const log = [];

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};

    // Mode 1: Client sends pre-fetched HTML → parse + match only
    // Mode 2: Client sends URL → we normalize it (no fetch from server)
    const rawUrl = String(body.url || '').trim();
    const html = String(body.html || '');
    const url = normalizeSoliqUrl(rawUrl) || rawUrl;

    log.push(`URL: ${url || '(none)'}`);
    log.push(`HTML length: ${html.length}`);

    if (!html) {
      // No HTML provided — just validate the URL and return
      if (!isSoliqUrl(url)) {
        return res.status(200).json({ ok: false, error: 'not_soliq_url', detail: 'Provide { html } (pre-fetched) or a valid ofd.soliq.uz URL', log });
      }
      return res.status(200).json({ ok: false, error: 'no_html', detail: 'Server cannot reach ofd.soliq.uz. Send the HTML from client-side fetch.', log });
    }

    // Parse the HTML
    log.push('[1] Parsing HTML...');
    const parsed = parseReceiptHtml(html);

    if (!parsed) {
      log.push('[2] parseReceiptHtml returned null');
      return res.status(200).json({ ok: false, error: 'parse_failed', detail: 'Could not parse receipt HTML', log });
    }

    log.push(`[2] Parsed: store="${parsed.store_name}", items=${(parsed.items || []).length}`);

    // Extract coordinates from HTML
    const coordMatch = html.match(/Placemark\s*\(\s*\[\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*\]/);
    const latitude = coordMatch ? parseFloat(coordMatch[1]) : null;
    const longitude = coordMatch ? parseFloat(coordMatch[2]) : null;

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
        log.push(`[3] Loaded ${products.length} products for matching`);

        matchedItems = matchedItems.map(item => {
          const { product, score } = fuzzyMatchProduct(item.name, products);
          return {
            ...item,
            matchedProduct: product ? { id: product.id, name_uz: product.name_uz, name_ru: product.name_ru } : null,
            matchScore: score,
          };
        });
      } catch (matchErr) {
        log.push(`[3] Product matching error: ${matchErr.message}`);
      }
    }

    log.push(`[4] Done: ${matchedItems.length} items`);

    return res.status(200).json({
      ok: true,
      receiptUrl: url || null,
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
