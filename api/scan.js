import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import { normalizeCityName } from '../src/constants/cities.js';
import {
  scrapesoliqReceipt,
  parseReceiptHtml,
  insertPendingPrice,
  fetchProductsIndex,
  normalizeSoliqUrl,
  isSoliqUrl,
} from './utils/receipt.js';

export const config = {
  api: { bodyParser: true },
  maxDuration: 30,
};

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  '';
const supabase =
  supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

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

function buildFallbackCandidateUrls(inputUrl) {
  const candidates = [inputUrl];
  try {
    const parsed = new URL(inputUrl);
    const t = parsed.searchParams.get('t');
    if (!t) return [...new Set(candidates)];

    const r = parsed.searchParams.get('r');
    const c = parsed.searchParams.get('c');
    const s = parsed.searchParams.get('s');

    const check = new URL('https://ofd.soliq.uz/check');
    check.searchParams.set('t', t);
    if (r) check.searchParams.set('r', r);
    if (c) check.searchParams.set('c', c);
    if (s) check.searchParams.set('s', s);

    const epi = new URL('https://ofd.soliq.uz/epi');
    epi.searchParams.set('t', t);
    if (r) epi.searchParams.set('r', r);
    if (c) epi.searchParams.set('c', c);
    if (s) epi.searchParams.set('s', s);

    candidates.push(check.toString());
    candidates.push(epi.toString());
  } catch {
    return [...new Set(candidates)];
  }

  return [...new Set(candidates)];
}

async function fallbackScrapeReceipt(url, trace) {
  const candidateUrls = buildFallbackCandidateUrls(url);
  pushTrace(trace, 'fallback_scrape_start', { candidateCount: candidateUrls.length });

  for (const candidateUrl of candidateUrls) {
    pushTrace(trace, 'fallback_candidate_start', { candidateUrl });
    try {
      const response = await axios.get(candidateUrl, {
        timeout: 45000,
        maxRedirects: 5,
        validateStatus: (status) => status >= 200 && status < 400,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'uz,ru;q=0.9,en;q=0.8',
          Referer: 'https://ofd.soliq.uz/',
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
        },
      });

      const html = String(response.data || '');
      pushTrace(trace, 'fallback_candidate_response', {
        candidateUrl,
        status: response.status,
        htmlLength: html.length,
      });

      if (!html) continue;

      const parsed = parseReceiptHtml(html);
      if (!parsed || !Array.isArray(parsed.items) || parsed.items.length === 0) {
        pushTrace(trace, 'fallback_candidate_parse_empty', { candidateUrl });
        continue;
      }

      const normalizedReceiptDate =
        parsed.receipt_date && /^\d{2}\.\d{2}\.\d{4}$/.test(parsed.receipt_date)
          ? `${parsed.receipt_date.split('.').reverse().join('-')}T00:00:00.000Z`
          : parsed.receipt_date || new Date().toISOString();

      return {
        storeName: parsed.store_name,
        storeAddress: parsed.store_address,
        city: null,
        detectedCity: null,
        latitude: null,
        longitude: null,
        receiptDate: normalizedReceiptDate,
        parseStage: 'fallback_table',
        items: parsed.items.map(item => ({
          name: item.name,
          quantity: Number(item.quantity) || 1,
          totalPrice: Number(item.price) || 0,
          unitPrice: Number(item.unit_price) || Number(item.price) || 0,
        })),
      };
    } catch (error) {
      pushTrace(trace, 'fallback_candidate_error', {
        candidateUrl,
        message: error?.message || String(error),
      });
    }
  }

  return null;
}

/**
 * Vercel API endpoint (fallback).
 * Accepts { url, telegram_id, city, html? }.
 * If html is provided (client-side pre-fetched), skips server-side fetch.
 */
export default async function handler(req, res) {
  withCors(res);
  const trace = [];
  const respond = (payload) => ok(res, { ...payload, trace });

  pushTrace(trace, 'request_received', { method: req.method });

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!supabase) return respond({ ok: false, error: 'server_not_configured' });
  if (req.method !== 'POST') return respond({ ok: false, error: 'method_not_allowed' });

  try {
    const body =
      typeof req.body === 'string'
        ? JSON.parse(req.body || '{}')
        : req.body || {};
    const rawUrl = String(body.url || '').trim();
    const url = normalizeSoliqUrl(rawUrl) || rawUrl;
    const telegramId = String(body.telegram_id || 'anonymous');
    const selectedCity = normalizeCityName(body.city || '') || null;
    pushTrace(trace, 'request_parsed', {
      telegramId,
      selectedCity,
      url,
    });

    if (!isSoliqUrl(url)) {
      pushTrace(trace, 'validation_failed', { error: 'not_soliq_url' });
      return respond({ ok: false, error: 'not_soliq_url' });
    }
    pushTrace(trace, 'validation_ok');

    /* blocked check */
    const { data: blocked } = await supabase
      .from('blocked_users')
      .select('telegram_id')
      .eq('telegram_id', telegramId)
      .maybeSingle();
    if (blocked) {
      pushTrace(trace, 'blocked_user', { telegramId });
      return respond({ ok: false, error: 'blocked' });
    }
    pushTrace(trace, 'blocked_check_ok');

    /* duplicate check */
    const { data: alreadyProcessed } = await supabase
      .from('receipts_log')
      .select('receipt_url')
      .eq('receipt_url', url)
      .maybeSingle();
    if (alreadyProcessed) {
      pushTrace(trace, 'duplicate_found', { receiptUrl: url });
      return respond({ ok: false, error: 'duplicate', message: 'Bu chek avval yuborilgan edi' });
    }
    pushTrace(trace, 'duplicate_check_ok');

    pushTrace(trace, 'scrape_start', { url });
    let receiptData = await scrapesoliqReceipt(url);

    if (!receiptData) {
      pushTrace(trace, 'scrape_primary_failed', { error: 'no_receipt_data' });
      receiptData = await fallbackScrapeReceipt(url, trace);
      if (!receiptData) {
        pushTrace(trace, 'scrape_failed', { error: 'no_receipt_data_after_fallback' });
        return respond({ ok: false, error: 'scrape_failed' });
      }
      pushTrace(trace, 'fallback_scrape_success', {
        itemCount: receiptData.items?.length || 0,
        parseStage: receiptData.parseStage || null,
      });
    }

    if (receiptData._generating) {
      pushTrace(trace, 'receipt_generating', { parseStage: receiptData.parseStage || null });
      return respond({ ok: false, error: 'receipt_generating' });
    }

    if (!Array.isArray(receiptData.items) || receiptData.items.length === 0) {
      pushTrace(trace, 'parse_failed', { error: 'no_items' });
      return respond({ ok: false, error: 'parse_failed' });
    }
    pushTrace(trace, 'parse_success', { itemCount: receiptData.items.length, storeName: receiptData.storeName || null });

    /* insert items */
    const products = await fetchProductsIndex(supabase);
    pushTrace(trace, 'products_loaded', { count: products.length });
    for (const item of receiptData.items || []) {
      await insertPendingPrice({
        supabase,
        item,
        receiptData,
        telegramId,
        city: selectedCity, receiptUrl: url, products,
        source: 'soliq_qr',
      });
    }
    pushTrace(trace, 'pending_prices_inserted', { itemCount: receiptData.items?.length || 0 });

    /* log receipt */
    await supabase.from('receipts_log').insert({
      receipt_url: url,
      submitted_by: telegramId,
      item_count: receiptData.items?.length || 0,
    });
    pushTrace(trace, 'receipt_logged');

    return respond({
      ok: true,
      store_name: receiptData.storeName || null,
      store_address: receiptData.storeAddress || null,
      city: normalizeCityName(receiptData.city || '') || selectedCity || 'Tashkent',
      item_count: receiptData.items?.length || 0,
    });
  } catch (error) {
    console.error('scan handler error:', error);
    pushTrace(trace, 'server_error', { message: error?.message || String(error) });
    return respond({ ok: false, error: 'server_error', detail: error?.message || String(error) });
  }
}
