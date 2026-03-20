import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
const telegramToken = process.env.TELEGRAM_BOT_TOKEN || '';
const adminTelegramIds = (process.env.ADMIN_TELEGRAM_IDS || process.env.ADMIN_TELEGRAM_ID || '7240925672')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean);

const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

function send(res, status, body) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(body));
}

function getVerifiedTelegramUserId(initDataRaw) {
  if (!initDataRaw || !telegramToken) return null;

  const params = new URLSearchParams(initDataRaw);
  const hash = params.get('hash');
  if (!hash) return null;

  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(telegramToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const hashBuffer = Buffer.from(hash, 'hex');
  const computedBuffer = Buffer.from(computedHash, 'hex');
  if (hashBuffer.length !== computedBuffer.length) return null;
  if (!crypto.timingSafeEqual(hashBuffer, computedBuffer)) return null;

  const userRaw = params.get('user');
  if (!userRaw) return null;

  try {
    const user = JSON.parse(userRaw);
    return user?.id ? String(user.id) : null;
  } catch {
    return null;
  }
}

function isAdminUser(telegramId) {
  return Boolean(telegramId) && adminTelegramIds.includes(String(telegramId));
}

async function listPending() {
  const { data, error } = await supabase
    .from('pending_prices')
    .select('*')
    .or('status.eq.pending,status.is.null')
    .order('created_at', { ascending: true })
    .limit(100);

  if (error) throw error;
  return data || [];
}

async function listApproved() {
  const { data, error } = await supabase
    .from('prices')
    .select('*')
    .order('receipt_date', { ascending: false })
    .limit(100);

  if (error) throw error;
  return data || [];
}

async function updatePending(id, changes) {
  const payload = {};

  if (typeof changes.product_name_raw === 'string') {
    payload.product_name_raw = changes.product_name_raw.trim();
    payload.product_id = null;
    payload.match_confidence = 0;
  }
  if (typeof changes.price === 'number' && Number.isFinite(changes.price) && changes.price > 0) {
    payload.price = Math.round(changes.price);
  }
  if (typeof changes.quantity === 'number' && Number.isFinite(changes.quantity) && changes.quantity > 0) {
    payload.quantity = changes.quantity;
  }
  if (typeof changes.unit_price === 'number' && Number.isFinite(changes.unit_price) && changes.unit_price > 0) {
    payload.unit_price = Math.round(changes.unit_price);
  }

  if (payload.price && payload.quantity && !payload.unit_price) {
    payload.unit_price = Math.round(payload.price / payload.quantity);
  }
  if (payload.unit_price && payload.quantity && !payload.price) {
    payload.price = Math.round(payload.unit_price * payload.quantity);
  }
  if (payload.price && !payload.quantity) {
    const { data: current } = await supabase.from('pending_prices').select('quantity').eq('id', id).maybeSingle();
    const quantity = current?.quantity && Number(current.quantity) > 0 ? Number(current.quantity) : 1;
    payload.unit_price = Math.round(payload.price / quantity);
  }
  if (payload.unit_price && !payload.quantity) {
    const { data: current } = await supabase.from('pending_prices').select('quantity').eq('id', id).maybeSingle();
    const quantity = current?.quantity && Number(current.quantity) > 0 ? Number(current.quantity) : 1;
    payload.price = Math.round(payload.unit_price * quantity);
  }

  const { data, error } = await supabase
    .from('pending_prices')
    .update(payload)
    .eq('id', id)
    .select('*')
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function approvePending(id) {
  const { data: pending, error } = await supabase.from('pending_prices').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!pending) {
    const notFound = new Error('Pending item not found');
    notFound.statusCode = 404;
    throw notFound;
  }

  let productId = pending.product_id;
  const quantity = Number(pending.quantity) > 0 ? Number(pending.quantity) : 1;
  const unitPrice = Number(pending.unit_price) > 0
    ? Math.round(Number(pending.unit_price))
    : Number(pending.price) > 0
      ? Math.round(Number(pending.price) / quantity)
      : 0;

  if (!unitPrice) {
    const invalid = new Error('Invalid pending price');
    invalid.statusCode = 400;
    throw invalid;
  }

  if (!productId) {
    const { data: existingProduct } = await supabase
      .from('products')
      .select('id')
      .eq('name_uz', pending.product_name_raw)
      .limit(1)
      .maybeSingle();

    if (existingProduct?.id) {
      productId = existingProduct.id;
    } else {
      const { data: created, error: createError } = await supabase
        .from('products')
        .insert({
          name_uz: pending.product_name_raw,
          name_ru: pending.product_name_raw,
          name_en: pending.product_name_raw,
          category: 'Boshqa',
          unit: 'dona',
        })
        .select('id')
        .single();

      if (createError) throw createError;
      productId = created?.id || null;
    }
  }

  const { error: insertError } = await supabase.from('prices').insert({
    product_id: productId,
    product_name_raw: pending.product_name_raw,
    price: unitPrice,
    quantity,
    place_name: pending.place_name || 'Unknown store',
    place_address: pending.place_address || '',
    latitude: pending.latitude ?? null,
    longitude: pending.longitude ?? null,
    receipt_date: pending.receipt_date || new Date().toISOString(),
    submitted_by: pending.submitted_by || 'unknown',
    source: pending.source || 'manual',
  });

  if (insertError) throw insertError;

  const { error: updateError } = await supabase
    .from('pending_prices')
    .update({ status: 'approved', product_id: productId })
    .eq('id', id);

  if (updateError) throw updateError;

  return { productId };
}

async function rejectPending(id) {
  const { error } = await supabase.from('pending_prices').update({ status: 'rejected' }).eq('id', id);
  if (error) throw error;
}

async function deletePending(id) {
  const { error } = await supabase.from('pending_prices').delete().eq('id', id);
  if (error) throw error;
}

async function deleteApproved(id) {
  const { error } = await supabase.from('prices').delete().eq('id', id);
  if (error) throw error;
}

export default async function moderation(req, res) {
  if (!supabase) {
    return send(res, 500, { ok: false, error: 'SUPABASE_NOT_CONFIGURED' });
  }

  if (req.method !== 'POST') {
    return send(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const telegramId = getVerifiedTelegramUserId(body.initData || '');

  if (!isAdminUser(telegramId)) {
    return send(res, 403, { ok: false, error: 'FORBIDDEN' });
  }

  try {
    switch (body.action) {
      case 'list': {
        const items = await listPending();
        return send(res, 200, { ok: true, items });
      }
      case 'listApproved': {
        const items = await listApproved();
        return send(res, 200, { ok: true, items });
      }
      case 'update': {
        const item = await updatePending(body.id, body.changes || {});
        return send(res, 200, { ok: true, item });
      }
      case 'approve': {
        const result = await approvePending(body.id);
        return send(res, 200, { ok: true, ...result });
      }
      case 'reject': {
        await rejectPending(body.id);
        return send(res, 200, { ok: true });
      }
      case 'deletePending': {
        await deletePending(body.id);
        return send(res, 200, { ok: true });
      }
      case 'deleteApproved': {
        await deleteApproved(body.id);
        return send(res, 200, { ok: true });
      }
      default:
        return send(res, 400, { ok: false, error: 'UNKNOWN_ACTION' });
    }
  } catch (error) {
    return send(res, error?.statusCode || 500, { ok: false, error: error?.message || 'UNKNOWN_ERROR' });
  }
}
