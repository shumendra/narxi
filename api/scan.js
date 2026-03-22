import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
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

function pushTrace(trace, stage, detail = null) {
  trace.push({
    ts: new Date().toISOString(),
    stage,
    detail,
  });
}

function canonicalReceiptUrl(input) {
  const normalized = normalizeSoliqUrl(input);
  if (!normalized) return null;

  try {
    const parsed = new URL(normalized);
    const ticket = parsed.searchParams.get('t');
    if (!ticket) return normalized;

    const canonical = new URL('https://ofd.soliq.uz/check');
    canonical.searchParams.set('t', ticket);

    const r = parsed.searchParams.get('r');
    const c = parsed.searchParams.get('c');
    const s = parsed.searchParams.get('s');
    if (r) canonical.searchParams.set('r', r);
    if (c) canonical.searchParams.set('c', c);
    if (s) canonical.searchParams.set('s', s);

    return canonical.toString();
  } catch {
    return normalized;
  }
}

async function fetchReceiptHtml(url, trace) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ru-RU,ru;q=0.9,uz-UZ;q=0.8,uz;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    Connection: 'keep-alive',
    Referer: 'https://ofd.soliq.uz/',
    'Cache-Control': 'no-cache',
  };

  const attempts = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    pushTrace(trace, 'fetch_attempt', { attempt, transport: 'fetch', url });

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers,
      });
      pushTrace(trace, 'fetch_response', { attempt, transport: 'fetch', status: response.status });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const html = await response.text();
      if (html && html.length > 0) {
        pushTrace(trace, 'fetch_success', { attempt, transport: 'fetch', htmlLength: html.length });
        return html;
      }

      throw new Error('EMPTY_HTML');
    } catch (error) {
      lastError = error;
      pushTrace(trace, 'fetch_error', {
        attempt,
        transport: 'fetch',
        name: error?.name || 'Error',
        message: error?.message || String(error),
      });
      try {
        pushTrace(trace, 'fetch_attempt', { attempt, transport: 'axios', url });
        const response = await axios.get(url, {
          timeout: 30000,
          maxRedirects: 5,
          validateStatus: (status) => status >= 200 && status < 400,
          headers,
        });
        const html = String(response.data || '');
        if (html) {
          pushTrace(trace, 'fetch_success', { attempt, transport: 'axios', status: response.status, htmlLength: html.length });
          return html;
        }
        pushTrace(trace, 'fetch_error', { attempt, transport: 'axios', message: 'EMPTY_HTML' });
      } catch (axiosError) {
        lastError = axiosError;
        pushTrace(trace, 'fetch_error', {
          attempt,
          transport: 'axios',
          name: axiosError?.name || 'Error',
          message: axiosError?.message || String(axiosError),
        });
      }

      if (attempt < attempts) {
        pushTrace(trace, 'fetch_retry_wait', { attempt, waitMs: attempt * 1500 });
        await new Promise(resolve => setTimeout(resolve, attempt * 1500));
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error('FETCH_FAILED');
}

function isOFDUnreachableError(error) {
  const message = String(error?.message || '').toLowerCase();
  const code = String(error?.code || '').toLowerCase();
  return (
    message.includes('etimedout')
    || message.includes('econnreset')
    || message.includes('fetch failed')
    || message.includes('network')
    || code === 'etimedout'
    || code === 'econnreset'
  );
}

async function queueUnreachableReceipt({
  supabaseClient,
  telegramId,
  city,
  receiptUrl,
}) {
  const fallbackCity = normalizeCityName(city || '') || 'Tashkent';
  const now = new Date().toISOString();

  const payload = {
    product_name_raw: 'RECEIPT_FETCH_UNREACHABLE',
    product_id: null,
    match_confidence: 0,
    status: 'pending',
    price: 1,
    quantity: 1,
    unit_price: 1,
    city: fallbackCity,
    place_name: 'Soliq receipt (network unreachable)',
    place_address: null,
    receipt_url: receiptUrl,
    receipt_date: now,
    source: 'soliq_qr_unreachable',
    submitted_by: telegramId,
    latitude: null,
    longitude: null,
  };

  const { error } = await supabaseClient.from('pending_prices').insert(payload);
  if (error) throw error;

  return {
    store_name: 'Soliq receipt (network unreachable)',
    store_address: '-',
    city: fallbackCity,
    item_count: 1,
    queued_without_parse: true,
  };
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
  const trace = [];
  const respond = (payload) => ok(res, { ...payload, trace });

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  pushTrace(trace, 'request_received', { method: req.method });

  if (!supabase) {
    pushTrace(trace, 'config_error', { error: 'server_not_configured' });
    return respond({ ok: false, error: 'server_not_configured' });
  }

  if (req.method !== 'POST') {
    pushTrace(trace, 'method_not_allowed', { method: req.method });
    return respond({ ok: false, error: 'method_not_allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const rawUrl = String(body.url || '').trim();
    const url = canonicalReceiptUrl(rawUrl) || rawUrl;
    const telegramId = String(body.telegram_id || 'anonymous');
    const selectedCity = normalizeCityName(body.city || '') || null;
    pushTrace(trace, 'request_parsed', {
      telegramId,
      selectedCity,
      rawUrl,
      canonicalUrl: url,
    });

    if (!isSoliqUrl(url)) {
      pushTrace(trace, 'validation_failed', { error: 'not_soliq_url' });
      return respond({ ok: false, error: 'not_soliq_url' });
    }
    pushTrace(trace, 'validation_ok', { isSoliqUrl: true });

    const { data: blocked, error: blockedError } = await supabase
      .from('blocked_users')
      .select('telegram_id')
      .eq('telegram_id', telegramId)
      .maybeSingle();

    if (blockedError) {
      console.error('scan blocked check error:', blockedError);
      pushTrace(trace, 'blocked_check_error', { message: blockedError.message });
    }

    if (blocked) {
      pushTrace(trace, 'blocked', { telegramId });
      return respond({ ok: false, error: 'blocked' });
    }
    pushTrace(trace, 'blocked_check_ok');

    const { data: alreadyProcessed, error: duplicateError } = await supabase
      .from('receipts_log')
      .select('receipt_url')
      .eq('receipt_url', url)
      .maybeSingle();

    if (duplicateError) {
      console.error('scan duplicate check error:', duplicateError);
      pushTrace(trace, 'duplicate_check_error', { message: duplicateError.message });
    }

    if (alreadyProcessed) {
      pushTrace(trace, 'duplicate_found', { receiptUrl: url });
      return respond({ ok: false, error: 'duplicate', message: 'Bu chek avval yuborilgan edi' });
    }
    pushTrace(trace, 'duplicate_check_ok');

    let html;
    try {
      html = await fetchReceiptHtml(url, trace);
    } catch (error) {
      console.error('Fetch error:', error?.message || error);
      if (isOFDUnreachableError(error)) {
        pushTrace(trace, 'ofd_unreachable_detected', { message: error?.message || 'network_error' });
        try {
          const queued = await queueUnreachableReceipt({
            supabaseClient: supabase,
            telegramId,
            city: selectedCity,
            receiptUrl: url,
          });
          pushTrace(trace, 'queued_unreachable_receipt', { city: queued.city });
          return respond({
            ok: true,
            ...queued,
            fallback_reason: 'ofd_unreachable',
            fetch_error_detail: error?.message || 'network_error',
          });
        } catch (queueError) {
          pushTrace(trace, 'queue_unreachable_failed', { message: queueError?.message || String(queueError) });
        }
      }
      pushTrace(trace, 'fetch_failed', { message: error?.message || 'fetch_error' });
      return respond({
        ok: false,
        error: 'fetch_failed',
        detail: error?.message || 'fetch_error',
      });
    }
    pushTrace(trace, 'html_received', { htmlLength: String(html || '').length });

    if (!html.includes('Nomi') && !html.includes('Narxi') && !html.includes('Наименование')) {
      pushTrace(trace, 'receipt_markers_missing', { error: 'not_receipt_page' });
      return respond({ ok: false, error: 'not_receipt_page' });
    }
    pushTrace(trace, 'receipt_markers_found');

    const parsed = parseReceiptHtml(html);
    pushTrace(trace, 'parse_completed', {
      hasParsed: Boolean(parsed),
      itemCount: parsed?.items?.length || 0,
      storeName: parsed?.store_name || null,
    });

    if (!parsed || !Array.isArray(parsed.items) || parsed.items.length === 0) {
      console.log('Parse failed. HTML preview:', String(html).substring(0, 1000));
      pushTrace(trace, 'parse_failed', { error: 'parse_failed' });
      return respond({ ok: false, error: 'parse_failed' });
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
    pushTrace(trace, 'products_loaded', { count: products.length });
    const insertResults = [];

    for (const item of receiptData.items) {
      try {
        pushTrace(trace, 'insert_attempt_match', { name: item.name, totalPrice: item.totalPrice });
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
        pushTrace(trace, 'insert_success_match', { name: item.name });
      } catch (insertError) {
        console.error('scan insert with matching failed, retrying without match:', insertError);
        pushTrace(trace, 'insert_match_failed', {
          name: item.name,
          message: insertError?.message || String(insertError),
        });
        const inserted = await insertPendingPriceWithoutMatch({
          supabaseClient: supabase,
          item,
          receiptData,
          telegramId,
          city: selectedCity,
          receiptUrl: url,
        });
        insertResults.push(inserted);
        pushTrace(trace, 'insert_success_no_match', { name: item.name });
      }
    }

    const finalCity = insertResults[0]?.finalCity || detectedCity || selectedCity || 'Tashkent';
    pushTrace(trace, 'insert_all_done', { finalCity, itemCount: receiptData.items.length });

    const { error: logError } = await supabase.from('receipts_log').insert({
      receipt_url: url,
      submitted_by: telegramId,
      item_count: receiptData.items.length,
    });

    if (logError) {
      console.error('scan receipts_log insert error:', logError);
      pushTrace(trace, 'receipt_log_error', { message: logError.message });
    } else {
      pushTrace(trace, 'receipt_log_saved');
    }

    return respond({
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
    pushTrace(trace, 'handler_exception', {
      name: error?.name || 'Error',
      message: error?.message || String(error),
    });
    return respond({ ok: false, error: 'server_error' });
  }
}
