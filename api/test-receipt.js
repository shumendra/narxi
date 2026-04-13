import { createClient } from '@supabase/supabase-js';
import {
  isSoliqUrl,
  normalizeSoliqUrl,
  scrapesoliqReceipt,
  fetchProductsIndex,
  fuzzyMatchProduct,
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

export default async function handler(req, res) {
  withCors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: false, error: 'POST required' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const rawUrl = String(body.url || '').trim();
    const url = normalizeSoliqUrl(rawUrl) || rawUrl;

    if (!isSoliqUrl(url)) {
      return res.status(200).json({ ok: false, error: 'not_soliq_url', detail: 'URL must be an ofd.soliq.uz/check link' });
    }

    // Scrape receipt directly
    const receipt = await scrapesoliqReceipt(url);

    if (!receipt) {
      return res.status(200).json({ ok: false, error: 'fetch_failed', detail: 'Could not fetch receipt from ofd.soliq.uz' });
    }

    if (receipt._generating) {
      return res.status(200).json({ ok: false, error: 'generating', detail: 'Receipt is still being generated. Try again in a few seconds.' });
    }

    // Fuzzy match items against product catalog
    let matchedItems = (receipt.items || []).map(item => ({
      name: item.name,
      quantity: item.quantity,
      totalPrice: item.totalPrice,
      unitPrice: item.unitPrice,
      matchedProduct: null,
      matchScore: 0,
    }));

    if (supabaseUrl && supabaseKey) {
      try {
        const supabase = createClient(supabaseUrl, supabaseKey);
        const products = await fetchProductsIndex(supabase);

        matchedItems = matchedItems.map(item => {
          const { product, score } = fuzzyMatchProduct(item.name, products);
          return {
            ...item,
            matchedProduct: product ? { id: product.id, name_uz: product.name_uz, name_ru: product.name_ru } : null,
            matchScore: score,
          };
        });
      } catch (matchErr) {
        console.error('Product matching error (non-fatal):', matchErr.message);
      }
    }

    return res.status(200).json({
      ok: true,
      receiptUrl: url,
      storeName: receipt.storeName || null,
      storeAddress: receipt.storeAddress || null,
      city: receipt.city || receipt.detectedCity || null,
      receiptDate: receipt.receiptDate || null,
      latitude: receipt.latitude || null,
      longitude: receipt.longitude || null,
      totalAmount: receipt.totalAmount || null,
      parseStage: receipt.parseStage || null,
      itemCount: matchedItems.length,
      items: matchedItems,
    });
  } catch (err) {
    console.error('test-receipt error:', err);
    return res.status(200).json({ ok: false, error: 'internal_error', detail: err.message || 'Unknown error' });
  }
}
