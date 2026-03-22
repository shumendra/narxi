import { createClient } from '@supabase/supabase-js';
import { normalizeCityName } from '../src/constants/cities.js';
import { parseReceiptFromHtml, extractCityFromAddress, insertPendingPrice, fetchProductsIndex, normalizeSoliqUrl } from './utils/receipt.js';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '2mb',
    },
  },
  maxDuration: 30,
};

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

function withCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function ok(res, payload) {
  withCors(res);
  return res.status(200).json(payload);
}

export default async function handler(req, res) {
  withCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!supabase) {
    return ok(res, { ok: false, error: 'server_not_configured' });
  }

  if (req.method !== 'POST') {
    return ok(res, { ok: false, error: 'method_not_allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const html = String(body.html || '').trim();
    const rawUrl = String(body.url || '').trim();
    const url = normalizeSoliqUrl(rawUrl) || rawUrl;
    const telegramId = String(body.telegram_id || 'anonymous');
    const selectedCity = normalizeCityName(body.city || '') || null;

    if (!html || !url) {
      return ok(res, { ok: false, error: 'missing_data' });
    }

    if (!/soliq\.uz/i.test(url)) {
      return ok(res, { ok: false, error: 'not_soliq_url' });
    }

    // Check blocked user
    const { data: blocked, error: blockedError } = await supabase
      .from('blocked_users')
      .select('telegram_id')
      .eq('telegram_id', telegramId)
      .maybeSingle();

    if (blockedError) {
      console.error('scan blocked check error:', blockedError);
    }

    if (blocked) {
      return ok(res, { ok: false, error: 'blocked' });
    }

    // Check duplicate
    const { data: alreadyProcessed, error: duplicateError } = await supabase
      .from('receipts_log')
      .select('receipt_url')
      .eq('receipt_url', url)
      .maybeSingle();

    if (duplicateError) {
      console.error('scan duplicate check error:', duplicateError);
    }

    if (alreadyProcessed) {
      return ok(res, { ok: false, error: 'duplicate', message: 'Bu chek avval yuborilgan edi' });
    }

    // Parse the HTML that was sent from the browser
    const receiptData = parseReceiptFromHtml(html);

    if (!receiptData || !receiptData.items || receiptData.items.length === 0) {
      console.info('scan: no items parsed from browser HTML', { url, parseStage: receiptData?.parseStage, htmlLength: html.length });
      return ok(res, { ok: false, error: 'parse_empty' });
    }

    const receiptLatitude = Number.isFinite(Number(receiptData?.latitude)) ? Number(receiptData.latitude) : null;
    const receiptLongitude = Number.isFinite(Number(receiptData?.longitude)) ? Number(receiptData.longitude) : null;

    // Insert items into pending_prices
    let products = [];
    try {
      products = await fetchProductsIndex(supabase);
    } catch (productsError) {
      console.error('scan products fetch warning:', productsError);
    }

    const insertResults = [];
    for (const item of receiptData.items) {
      try {
        const inserted = await insertPendingPrice({
          supabase,
          item,
          receiptData,
          telegramId,
          city: selectedCity,
          receiptUrl: url,
          products,
          latitude: receiptLatitude,
          longitude: receiptLongitude,
          source: `soliq_qr_browser_${String(receiptData?.parseStage || 'unknown').replace(/[^a-z0-9_]+/gi, '_').toLowerCase()}`,
        });
        insertResults.push(inserted);
      } catch (insertError) {
        console.error('scan insert error:', insertError);
        // Insert without product matching as fallback
        const parseStageSuffix = String(receiptData?.parseStage || 'unknown').replace(/[^a-z0-9_]+/gi, '_').toLowerCase();
        const detectedCity = normalizeCityName(receiptData?.city || '') || selectedCity || 'Tashkent';
        const { error } = await supabase.from('pending_prices').insert({
          product_name_raw: item?.name || 'Unknown item',
          product_id: null,
          match_confidence: 0,
          status: 'pending',
          price: Number(item?.totalPrice) || 0,
          quantity: Number(item?.quantity) || 1,
          unit_price: Number(item?.unitPrice) || Number(item?.totalPrice) || 0,
          city: detectedCity,
          place_name: receiptData?.storeName || null,
          place_address: receiptData?.storeAddress || null,
          receipt_url: url,
          receipt_date: receiptData?.receiptDate || new Date().toISOString(),
          source: `soliq_qr_browser_${parseStageSuffix}`,
          submitted_by: telegramId,
          latitude: receiptLatitude,
          longitude: receiptLongitude,
        });
        if (error) console.error('scan fallback insert error:', error);
        insertResults.push({ finalCity: detectedCity });
      }
    }

    const finalCity = insertResults[0]?.finalCity || normalizeCityName(receiptData.city || '') || selectedCity || 'Tashkent';
    const itemCount = receiptData.items.length;

    // Log the receipt
    const { error: logError } = await supabase.from('receipts_log').insert({
      receipt_url: url,
      submitted_by: telegramId,
      item_count: itemCount,
    });

    if (logError) {
      console.error('scan receipts_log insert error:', logError);
    }

    return ok(res, {
      ok: true,
      store_name: receiptData.storeName,
      store_address: receiptData.storeAddress,
      city: finalCity,
      item_count: itemCount,
    });
  } catch (error) {
    console.error('scan handler error:', error);
    return ok(res, { ok: false, error: 'server_error' });
  }
}
