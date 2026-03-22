import { createClient } from '@supabase/supabase-js';
import { normalizeCityName } from '../src/constants/cities.js';
import {
  parseReceiptHtml,
  extractCityFromAddress,
  insertPendingPrice,
  fetchProductsIndex,
  normalizeSoliqUrl,
  isSoliqUrl,
} from './utils/receipt.js';

export const config = {
  api: {
    bodyParser: true,
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

async function fetchReceiptHtml(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,uz-UZ;q=0.8,uz;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        Connection: 'keep-alive',
        Referer: 'https://ofd.soliq.uz/',
        'Cache-Control': 'no-cache',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function insertPendingPriceWithoutMatch({
  supabaseClient,
  item,
  receiptData,
  telegramId,
  city,
  receiptUrl,
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
    source: 'soliq_qr_table',
    submitted_by: telegramId,
    latitude: null,
    longitude: null,
  };

  const { error } = await supabaseClient.from('pending_prices').insert(payload);
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
    const normalizedUrl = normalizeSoliqUrl(rawUrl);
    const url = normalizedUrl || rawUrl;
    const telegramId = String(body.telegram_id || 'anonymous');
    const selectedCity = normalizeCityName(body.city || '') || null;

    if (!isSoliqUrl(url)) {
      return ok(res, { ok: false, error: 'not_soliq_url' });
    }

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

    let html;
    try {
      html = await fetchReceiptHtml(url);
    } catch (error) {
      console.error('Fetch error:', error?.message || error);
      return ok(res, {
        ok: false,
        error: 'fetch_failed',
        detail: error?.message || 'fetch_error',
      });
    }

    if (!html.includes('Nomi') && !html.includes('Narxi') && !html.includes('Наименование')) {
      return ok(res, { ok: false, error: 'not_receipt_page' });
    }

    const parsed = parseReceiptHtml(html);

    if (!parsed || !Array.isArray(parsed.items) || parsed.items.length === 0) {
      console.log('Parse failed. HTML preview:', String(html).substring(0, 1000));
      return ok(res, { ok: false, error: 'parse_failed' });
    }

    const normalizedReceiptDate = parsed.receipt_date && /^\d{2}\.\d{2}\.\d{4}$/.test(parsed.receipt_date)
      ? `${parsed.receipt_date.split('.').reverse().join('-')}T00:00:00.000Z`
      : (parsed.receipt_date || new Date().toISOString());

    const detectedCity = normalizeCityName(extractCityFromAddress(parsed.store_address || '')) || null;
    const receiptData = {
      storeName: parsed.store_name,
      storeAddress: parsed.store_address,
      city: detectedCity,
      detectedCity,
      receiptDate: normalizedReceiptDate,
      parseStage: 'table',
      latitude: null,
      longitude: null,
      items: parsed.items.map(item => ({
        name: item.name,
        quantity: Number(item.quantity) || 1,
        totalPrice: Number(item.price) || 0,
        unitPrice: Number(item.unit_price) || Number(item.price) || 0,
      })),
    };

    const products = await fetchProductsIndex(supabase);
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
          latitude: null,
          longitude: null,
          source: 'soliq_qr_table',
        });
        insertResults.push(inserted);
      } catch (insertError) {
        console.error('scan insert with matching failed, retrying without match:', insertError);
        const inserted = await insertPendingPriceWithoutMatch({
          supabaseClient: supabase,
          item,
          receiptData,
          telegramId,
          city: selectedCity,
          receiptUrl: url,
        });
        insertResults.push(inserted);
      }
    }

    const finalCity = insertResults[0]?.finalCity || detectedCity || selectedCity || 'Tashkent';

    const { error: logError } = await supabase.from('receipts_log').insert({
      receipt_url: url,
      submitted_by: telegramId,
      item_count: receiptData.items.length,
    });

    if (logError) {
      console.error('scan receipts_log insert error:', logError);
    }

    return ok(res, {
      ok: true,
      store_name: receiptData.storeName,
      store_address: receiptData.storeAddress,
      city: finalCity,
      selected_city: selectedCity,
      scraped_city: detectedCity || finalCity,
      item_count: receiptData.items.length,
      queued_without_parse: false,
    });
  } catch (error) {
    console.error('scan handler error:', error);
    return ok(res, { ok: false, error: 'server_error' });
  }
}
