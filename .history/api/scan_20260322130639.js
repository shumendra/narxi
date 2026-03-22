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
      return ok(res, { ok: false, error: 'blocked_check_failed' });
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
      return ok(res, { ok: false, error: 'duplicate_check_failed' });
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

    if (!receiptData || !receiptData.items || receiptData.items.length === 0) {
      return ok(res, { ok: false, error: 'scrape_failed' });
    }

    const products = await fetchProductsIndex(supabase);
    const insertResults = await Promise.all(
      receiptData.items.map(item =>
        insertPendingPrice({
          supabase,
          item,
          receiptData,
          telegramId,
          city: selectedCity,
          receiptUrl: url,
          products,
        })
      )
    );

    const finalCity = insertResults[0]?.finalCity || normalizeCityName(receiptData.city || '') || selectedCity || 'Tashkent';

    if (selectedCity && normalizeCityName(selectedCity) !== normalizeCityName(finalCity)) {
      console.info('scan city mismatch', {
        selected_city: selectedCity,
        scraped_city: finalCity,
        receipt_url: url,
        telegram_id: telegramId,
      });
    }

    const { error: logError } = await supabase.from('receipts_log').insert({
      receipt_url: url,
      submitted_by: telegramId,
      item_count: receiptData.items.length,
    });

    if (logError) {
      console.error('scan receipts_log insert error:', logError);
      return ok(res, { ok: false, error: 'receipt_log_failed' });
    }

    return ok(res, {
      ok: true,
      store_name: receiptData.storeName,
      store_address: receiptData.storeAddress,
      city: finalCity,
      selected_city: selectedCity,
      scraped_city: normalizeCityName(receiptData.city || '') || finalCity,
      item_count: receiptData.items.length,
    });
  } catch (error) {
    console.error('scan handler error:', error);
    return ok(res, { ok: false, error: 'server_error' });
  }
}
