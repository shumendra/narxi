import { createClient } from '@supabase/supabase-js';
import { normalizeCityName } from '../src/constants/cities.js';
import { isSoliqUrl, normalizeSoliqUrl } from './utils/receipt.js';

export const config = {
  api: { bodyParser: true },
  maxDuration: 10,
};

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  '';
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

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!supabase) return ok(res, { ok: false, error: 'server_not_configured' });
  if (req.method !== 'POST') return ok(res, { ok: false, error: 'method_not_allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};

    const rawUrl = String(body.url || '').trim();
    const url = normalizeSoliqUrl(rawUrl) || rawUrl;
    const telegramId = String(body.telegram_id || 'anonymous');
    const city = normalizeCityName(body.city || '') || 'Tashkent';

    if (!isSoliqUrl(url)) {
      return ok(res, { ok: false, error: 'not_soliq_url' });
    }

    const { data: blocked } = await supabase
      .from('blocked_users')
      .select('telegram_id')
      .eq('telegram_id', telegramId)
      .maybeSingle();

    if (blocked) {
      return ok(res, { ok: false, error: 'blocked' });
    }

    const { data: alreadyLogged } = await supabase
      .from('receipts_log')
      .select('receipt_url')
      .eq('receipt_url', url)
      .maybeSingle();

    if (alreadyLogged) {
      return ok(res, {
        ok: false,
        error: 'duplicate',
        message: 'Bu chek allaqachon qayta ishlangan',
      });
    }

    const { data: existingQueue } = await supabase
      .from('receipt_queue')
      .select('id, status')
      .eq('receipt_url', url)
      .maybeSingle();

    if (existingQueue) {
      return ok(res, {
        ok: false,
        error: 'duplicate',
        message: 'Bu chek allaqachon navbatda',
      });
    }

    const { error: queueError } = await supabase
      .from('receipt_queue')
      .insert({
        receipt_url: url,
        telegram_id: telegramId,
        city,
        status: 'pending',
      });

    if (queueError) {
      console.error('receipt_queue insert error:', queueError);
      return ok(res, { ok: false, error: 'db_error', detail: queueError.message || 'queue_insert_failed' });
    }

    return ok(res, {
      ok: true,
      queued: true,
      city,
      message: "Chek navbatga qo'shildi. Tez orada qayta ishlanadi.",
    });
  } catch (error) {
    console.error('scan queue handler error:', error);
    return ok(res, {
      ok: false,
      error: 'server_error',
      detail: error?.message || String(error),
    });
  }
}
