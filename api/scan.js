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

async function upsertUserProfile(profile) {
  const telegramId = String(profile.telegram_id || '').trim();
  if (!telegramId || telegramId === 'anonymous') return;

  const nowIso = new Date().toISOString();
  const payload = {
    telegram_id: telegramId,
    username: profile.username || null,
    first_name: profile.first_name || null,
    language_code: profile.language_code || null,
    preferred_city: profile.city || 'Tashkent',
    preferred_language: profile.language_code || 'uz',
    last_seen: nowIso,
  };

  await supabase.from('user_profiles').upsert(payload, { onConflict: 'telegram_id' });

  const { data: existingStats } = await supabase
    .from('user_stats')
    .select('telegram_id')
    .eq('telegram_id', telegramId)
    .maybeSingle();

  if (!existingStats) {
    await supabase.from('user_stats').insert({
      telegram_id: telegramId,
      total_receipts_scanned: 0,
      total_items_contributed: 0,
      total_people_helped: 0,
      current_streak_weeks: 0,
      updated_at: nowIso,
    });
  }

  await supabase
    .from('user_profiles')
    .update({ last_seen: nowIso })
    .eq('telegram_id', telegramId);
}

function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

async function incrementReceiptStats(telegramId, itemCount) {
  if (!telegramId || telegramId === 'anonymous') return;

  const { data: stats } = await supabase
    .from('user_stats')
    .select('*')
    .eq('telegram_id', telegramId)
    .maybeSingle();

  const today = new Date();
  const todayText = today.toISOString().split('T')[0];
  const currentWeek = getWeekNumber(today);
  const currentYear = today.getFullYear();
  let newStreak = stats?.current_streak_weeks || 0;
  const lastDate = stats?.last_receipt_date;

  if (lastDate) {
    const parsedLast = new Date(lastDate);
    const lastWeek = getWeekNumber(parsedLast);
    const lastYear = parsedLast.getFullYear();
    if (!((currentWeek === lastWeek && currentYear === lastYear))) {
      if (
        (currentWeek === lastWeek + 1 && currentYear === lastYear) ||
        (currentWeek === 1 && lastWeek >= 52 && currentYear === lastYear + 1)
      ) {
        newStreak += 1;
      } else {
        newStreak = 1;
      }
    }
  } else {
    newStreak = 1;
  }

  await supabase.from('user_stats').upsert({
    telegram_id: telegramId,
    total_receipts_scanned: (stats?.total_receipts_scanned || 0) + 1,
    total_items_contributed: (stats?.total_items_contributed || 0) + (Number(itemCount) || 0),
    current_streak_weeks: newStreak,
    last_streak_date: todayText,
    last_receipt_date: todayText,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'telegram_id' });
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
    const telegramUsername = body.telegram_username ? String(body.telegram_username) : null;
    const telegramFirstName = body.telegram_first_name ? String(body.telegram_first_name) : null;
    const telegramLanguageCode = body.telegram_language_code ? String(body.telegram_language_code) : null;
    const city = normalizeCityName(body.city || '') || 'Tashkent';

    await upsertUserProfile({
      telegram_id: telegramId,
      username: telegramUsername,
      first_name: telegramFirstName,
      language_code: telegramLanguageCode,
      city,
    });

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

    const { data: existingQueue } = await supabase
      .from('receipt_queue')
      .select('id, status')
      .eq('receipt_url', url)
      .maybeSingle();

    if (existingQueue) {
      const { error: requeueError } = await supabase
        .from('receipt_queue')
        .update({
          telegram_id: telegramId,
          city,
          status: 'pending',
          error_message: null,
          processed_at: null,
        })
        .eq('id', existingQueue.id);

      if (requeueError) {
        console.error('receipt_queue requeue error:', requeueError);
        return ok(res, { ok: false, error: 'db_error', detail: requeueError.message || 'queue_requeue_failed' });
      }

      await incrementReceiptStats(telegramId, 0);

      return ok(res, {
        ok: true,
        queued: true,
        requeued: true,
        city,
        message: "Chek qayta navbatga qo'shildi.",
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

    await incrementReceiptStats(telegramId, 0);

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
