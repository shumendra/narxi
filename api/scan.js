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

/**
 * Vercel API endpoint (fallback).
 * Accepts { url, telegram_id, city, html? }.
 * If html is provided (client-side pre-fetched), skips server-side fetch.
 */
export default async function handler(req, res) {
  withCors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!supabase) return ok(res, { ok: false, error: 'server_not_configured' });
  if (req.method !== 'POST') return ok(res, { ok: false, error: 'method_not_allowed' });

  try {
    const body =
      typeof req.body === 'string'
        ? JSON.parse(req.body || '{}')
        : req.body || {};
    const rawUrl = String(body.url || '').trim();
    const url = normalizeSoliqUrl(rawUrl) || rawUrl;
    const telegramId = String(body.telegram_id || 'anonymous');
    const selectedCity = normalizeCityName(body.city || '') || null;
    const clientHtml = body.html ? String(body.html) : null;

    if (!isSoliqUrl(url)) {
      return ok(res, { ok: false, error: 'not_soliq_url' });
    }

    /* blocked check */
    const { data: blocked } = await supabase
      .from('blocked_users')
      .select('telegram_id')
      .eq('telegram_id', telegramId)
      .maybeSingle();
    if (blocked) return ok(res, { ok: false, error: 'blocked' });

    /* duplicate check */
    const { data: alreadyProcessed } = await supabase
      .from('receipts_log')
      .select('receipt_url')
      .eq('receipt_url', url)
      .maybeSingle();
    if (alreadyProcessed) {
      return ok(res, { ok: false, error: 'duplicate', message: 'Bu chek avval yuborilgan edi' });
    }

    /* get HTML: prefer client-provided, otherwise try server fetch */
    let html = clientHtml;
    if (!html) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const response = await fetch(url, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
            Accept: 'text/html',
          },
        });
        clearTimeout(timeout);
        if (response.ok) html = await response.text();
      } catch (error) {
        console.error('Server-side fetch failed:', error?.message);
      }
    }

    if (!html) return ok(res, { ok: false, error: 'fetch_failed' });

    /* parse */
    const parsed = parseReceiptHtml(html);
    if (!parsed || !Array.isArray(parsed.items) || parsed.items.length === 0) {
      return ok(res, { ok: false, error: 'parse_failed' });
    }

    const normalizedReceiptDate =
      parsed.receipt_date && /^\d{2}\.\d{2}\.\d{4}$/.test(parsed.receipt_date)
        ? `${parsed.receipt_date.split('.').reverse().join('-')}T00:00:00.000Z`
        : parsed.receipt_date || new Date().toISOString();

    const detectedCity =
      normalizeCityName(extractCityFromAddress(parsed.store_address || '')) || null;

    const receiptData = {
      storeName: parsed.store_name,
      storeAddress: parsed.store_address,
      city: detectedCity,
      detectedCity,
      receiptDate: normalizedReceiptDate,
      latitude: null,
      longitude: null,
      items: parsed.items.map((item) => ({
        name: item.name,
        quantity: Number(item.quantity) || 1,
        totalPrice: Number(item.price) || 0,
        unitPrice: Number(item.unit_price) || Number(item.price) || 0,
      })),
    };

    /* insert items */
    const products = await fetchProductsIndex(supabase);
    for (const item of receiptData.items) {
      await insertPendingPrice({
        supabase, item, receiptData, telegramId,
        city: selectedCity, receiptUrl: url, products,
        source: 'soliq_qr',
      });
    }

    /* log receipt */
    await supabase.from('receipts_log').insert({
      receipt_url: url,
      submitted_by: telegramId,
      item_count: receiptData.items.length,
    });

    return ok(res, {
      ok: true,
      store_name: receiptData.storeName,
      store_address: receiptData.storeAddress,
      city: detectedCity || selectedCity || 'Tashkent',
      item_count: receiptData.items.length,
    });
  } catch (error) {
    console.error('scan handler error:', error);
    return ok(res, { ok: false, error: 'server_error' });
  }
}
