import { createClient } from '@supabase/supabase-js';
import { normalizeCityName } from '../src/constants/cities.js';
import { scrapesoliqReceipt, insertPendingPrice, fetchProductsIndex, normalizeSoliqUrl } from './utils/receipt.js';

export const config = {
  api: {
    bodyParser: true,
  },
  maxDuration: 30,
};

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

async function withTimeout(promise, timeoutMs) {
  let timeoutHandle;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      const timeoutError = new Error('SCAN_TIMEOUT');
      timeoutError.code = 'SCAN_TIMEOUT';
      reject(timeoutError);
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function withCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function ok(res, payload) {
  withCors(res);
  return res.status(200).json(payload);
}

function buildQueuedSuccessPayload(city, receiptUrl, persisted = true) {
  const finalCity = normalizeCityName(city || '') || 'Tashkent';
  return {
    store_name: 'Soliq receipt (parse pending)',
    store_address: '-',
    city: finalCity,
    item_count: 1,
    queued_without_parse: true,
    queued_persisted: persisted,
    receipt_url: receiptUrl || null,
  };
}

function sanitizeCoordinate(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function insertFallbackPendingReceipt({ supabase, telegramId, city, receiptUrl, latitude = null, longitude = null }) {
  const now = new Date().toISOString();
  const fallbackCity = normalizeCityName(city || '') || 'Tashkent';

  const payload = {
    product_name_raw: 'CHEK_AUTO_PARSE_PENDING',
    product_id: null,
    match_confidence: 0,
    status: 'pending',
    price: 1,
    quantity: 1,
    unit_price: 1,
    city: fallbackCity,
    place_name: 'Soliq receipt (parse pending)',
    place_address: null,
    receipt_url: receiptUrl,
    receipt_date: now,
    source: 'soliq_qr_unparsed',
    submitted_by: telegramId,
    latitude,
    longitude,
  };

  const { error } = await supabase.from('pending_prices').insert(payload);
  if (error) {
    throw error;
  }

  return buildQueuedSuccessPayload(fallbackCity, receiptUrl, true);
}

async function tryQueueWithoutParse({ supabase, telegramId, city, receiptUrl, latitude = null, longitude = null }) {
  if (!supabase || !receiptUrl) {
    return buildQueuedSuccessPayload(city, receiptUrl, false);
  }

  try {
    return await insertFallbackPendingReceipt({
      supabase,
      telegramId,
      city,
      receiptUrl,
      latitude,
      longitude,
    });
  } catch (fallbackError) {
    console.error('scan emergency fallback insert error:', fallbackError);
    return buildQueuedSuccessPayload(city, receiptUrl, false);
  }
}

async function insertPendingPriceWithoutMatch({
  supabase,
  item,
  receiptData,
  telegramId,
  city,
  receiptUrl,
  latitude = null,
  longitude = null,
}) {
  const selectedCity = normalizeCityName(city || '');
  const parsedCity = normalizeCityName(receiptData?.city || '');
  const finalCity = parsedCity || selectedCity || 'Tashkent';

  const payload = {
    product_name_raw: item?.name || 'Unknown item',
    product_id: null,
    match_confidence: 0,
    status: 'pending',
    price: Number(item?.totalPrice) || 0,
    quantity: Number(item?.quantity) || 1,
    unit_price: Number(item?.unitPrice) || Number(item?.totalPrice) || 0,
    city: finalCity,
    place_name: receiptData?.storeName || null,
    place_address: receiptData?.storeAddress || null,
    receipt_url: receiptUrl,
    receipt_date: receiptData?.receiptDate || new Date().toISOString(),
    source: 'soliq_qr',
    submitted_by: telegramId,
    latitude,
    longitude,
  };

  const { error } = await supabase.from('pending_prices').insert(payload);
  if (error) throw error;

  return { finalCity };
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
    const rawUrl = String(body.url || '').trim();
    const url = normalizeSoliqUrl(rawUrl);
    const telegramId = String(body.telegram_id || 'anonymous');
    const selectedCity = normalizeCityName(body.city || '') || null;
    const latitude = sanitizeCoordinate(body.latitude);
    const longitude = sanitizeCoordinate(body.longitude);

    if (!url) {
      return ok(res, { ok: false, error: 'not_soliq_url' });
    }

    const { data: blocked, error: blockedError } = await supabase
      .from('blocked_users')
      .select('telegram_id')
      .eq('telegram_id', telegramId)
      .maybeSingle();

    if (blockedError) {
      console.error('scan blocked check error:', blockedError);
      console.info('scan proceeding despite blocked check query error', { telegram_id: telegramId, receipt_url: url });
    }

    if (blocked) {
      return ok(res, { ok: false, error: 'blocked' });
    }

    const { data: alreadyProcessed, error: duplicateError } = await supabase
      .from('receipts_log')
      .select('receipt_url')
      .eq('receipt_url', url)
      .maybeSingle();

    if (duplicateError) {
      console.error('scan duplicate check error:', duplicateError);
      console.info('scan proceeding despite duplicate check query error', { telegram_id: telegramId, receipt_url: url });
    }

    if (alreadyProcessed) {
      return ok(res, { ok: false, error: 'duplicate', message: 'Bu chek avval yuborilgan edi' });
    }

    let receiptData = null;
    try {
      receiptData = await withTimeout(scrapesoliqReceipt(url), 28000);
    } catch (error) {
      if (error?.code === 'SCAN_TIMEOUT') {
        return ok(res, { ok: false, error: 'scan_timeout' });
      }
      throw error;
    }

    let fallbackQueued = null;
    if (!receiptData || !receiptData.items || receiptData.items.length === 0) {
      try {
        fallbackQueued = await insertFallbackPendingReceipt({
          supabase,
          telegramId,
          city: selectedCity,
          receiptUrl: url,
          latitude,
          longitude,
        });
      } catch (fallbackError) {
        console.error('scan fallback insert error:', fallbackError);
        fallbackQueued = buildQueuedSuccessPayload(selectedCity, url, false);
      }
    }

    let finalCity = selectedCity || 'Tashkent';
    let itemCount = fallbackQueued?.item_count || 0;

    if (!fallbackQueued) {
      let products = [];
      try {
        products = await fetchProductsIndex(supabase);
      } catch (productsError) {
        console.error('scan products fetch warning:', productsError);
        products = [];
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
            latitude,
            longitude,
          });
          insertResults.push(inserted);
        } catch (insertError) {
          console.error('scan insert with matching failed, retrying without match:', insertError);
          const inserted = await insertPendingPriceWithoutMatch({
            supabase,
            item,
            receiptData,
            telegramId,
            city: selectedCity,
            receiptUrl: url,
            latitude,
            longitude,
          });
          insertResults.push(inserted);
        }
      }

      finalCity = insertResults[0]?.finalCity || normalizeCityName(receiptData.city || '') || selectedCity || 'Tashkent';
      itemCount = receiptData.items.length;

      if (selectedCity && normalizeCityName(selectedCity) !== normalizeCityName(finalCity)) {
        console.info('scan city mismatch', {
          selected_city: selectedCity,
          scraped_city: finalCity,
          receipt_url: url,
          telegram_id: telegramId,
        });
      }
    }

    const { error: logError } = await supabase.from('receipts_log').insert({
      receipt_url: url,
      submitted_by: telegramId,
      item_count: receiptData.items.length,
    });

    if (logError) {
      console.error('scan receipts_log insert error:', logError);
      return ok(res, {
        ok: true,
        store_name: fallbackQueued?.store_name || receiptData.storeName,
        store_address: fallbackQueued?.store_address || receiptData.storeAddress,
        city: finalCity,
        selected_city: selectedCity,
        scraped_city: fallbackQueued ? null : (normalizeCityName(receiptData.city || '') || finalCity),
        item_count: itemCount,
        queued_without_parse: Boolean(fallbackQueued),
        fallback_reason: 'receipt_log_failed',
      });
    }

    return ok(res, {
      ok: true,
      store_name: fallbackQueued?.store_name || receiptData.storeName,
      store_address: fallbackQueued?.store_address || receiptData.storeAddress,
      city: finalCity,
      selected_city: selectedCity,
      scraped_city: fallbackQueued ? null : (normalizeCityName(receiptData.city || '') || finalCity),
      item_count: itemCount,
      queued_without_parse: Boolean(fallbackQueued),
    });
  } catch (error) {
    console.error('scan handler error:', error);
    const safeBody = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const rawUrl = String(safeBody.url || '').trim();
    const url = normalizeSoliqUrl(rawUrl);
    const telegramId = String(safeBody.telegram_id || 'anonymous');
    const selectedCity = normalizeCityName(safeBody.city || '') || null;
    const latitude = sanitizeCoordinate(safeBody.latitude);
    const longitude = sanitizeCoordinate(safeBody.longitude);

    if (!url) {
      return ok(res, { ok: false, error: 'not_soliq_url' });
    }

    const queued = await tryQueueWithoutParse({
      supabase,
      telegramId,
      city: selectedCity,
      receiptUrl: url,
      latitude,
      longitude,
    });

    return ok(res, { ok: true, ...queued, fallback_reason: 'unhandled_exception' });
  }
}
