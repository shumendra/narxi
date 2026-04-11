import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import {
  scrapesoliqReceipt,
  insertPendingPrice,
  fetchProductsIndex,
  isSoliqUrl,
  normalizeSoliqUrl,
} from '../../api/utils/receipt.js';
import { normalizeCityName } from '../../src/constants/cities.js';

dotenv.config();
dotenv.config({ path: '.env.local', override: true });

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  '';
const supabase =
  supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function respond(statusCode, payload) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(payload),
  };
}

export async function handler(event) {
  /* ---- preflight ---- */
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return respond(405, { ok: false, error: 'method_not_allowed' });
  }

  if (!supabase) {
    return respond(500, { ok: false, error: 'server_not_configured' });
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const rawUrl = String(body.url || '').trim();
    const url = normalizeSoliqUrl(rawUrl) || rawUrl;
    const telegramId = String(body.telegram_id || 'anonymous');
    const selectedCity = normalizeCityName(body.city || '') || null;

    /* ---- validate ---- */
    if (!isSoliqUrl(url)) {
      return respond(200, { ok: false, error: 'not_soliq_url' });
    }

    /* ---- blocked check ---- */
    const { data: blocked } = await supabase
      .from('blocked_users')
      .select('telegram_id')
      .eq('telegram_id', telegramId)
      .maybeSingle();

    if (blocked) {
      return respond(200, { ok: false, error: 'blocked' });
    }

    /* ---- duplicate check ---- */
    const { data: alreadyProcessed } = await supabase
      .from('receipts_log')
      .select('receipt_url')
      .eq('receipt_url', url)
      .maybeSingle();

    if (alreadyProcessed) {
      return respond(200, {
        ok: false,
        error: 'duplicate',
        message: 'Bu chek avval yuborilgan edi',
      });
    }

    /* ---- scrape receipt from OFD ---- */
    const receiptData = await scrapesoliqReceipt(url);

    if (!receiptData || !Array.isArray(receiptData.items) || receiptData.items.length === 0) {
      if (receiptData && receiptData._generating) {
        return respond(200, { ok: false, error: 'receipt_generating' });
      }
      return respond(200, { ok: false, error: 'scrape_failed' });
    }

    /* ---- insert items into pending_prices ---- */
    const products = await fetchProductsIndex(supabase);

    for (const item of receiptData.items) {
      await insertPendingPrice({
        supabase,
        item,
        receiptData,
        telegramId,
        city: selectedCity || receiptData.city,
        receiptUrl: url,
        products,
        source: 'soliq_qr',
      });
    }

    /* ---- log receipt ---- */
    await supabase.from('receipts_log').insert({
      receipt_url: url,
      submitted_by: telegramId,
      item_count: receiptData.items.length,
    });

    const finalCity =
      normalizeCityName(receiptData.city) || selectedCity || 'Tashkent';

    return respond(200, {
      ok: true,
      store_name: receiptData.storeName,
      store_address: receiptData.storeAddress,
      city: finalCity,
      item_count: receiptData.items.length,
    });
  } catch (error) {
    console.error('scan-receipt error:', error);
    return respond(200, {
      ok: false,
      error: 'server_error',
      detail: error?.message || String(error),
    });
  }
}
