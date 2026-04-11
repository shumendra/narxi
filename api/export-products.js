import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
const adminTelegramIds = (process.env.ADMIN_TELEGRAM_IDS || process.env.ADMIN_TELEGRAM_ID || '')
  .split(',').map(id => id.trim()).filter(Boolean);

const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

function send(res, status, body) {
  res.setHeader('Content-Type', 'application/json');
  res.status(status).send(JSON.stringify(body));
}

/**
 * GET /api/export-products?admin_id=<telegram_id>
 *
 * Returns all products with their existing aliases, grouped for AI categorisation.
 * Response shape:
 * {
 *   products: [
 *     { id, name_uz, name_ru, name_en, search_text, aliases: [ { alias_text, language, store_name } ] }
 *   ]
 * }
 */
export default async function handler(req, res) {
  if (!supabase) return send(res, 500, { ok: false, error: 'SUPABASE_NOT_CONFIGURED' });
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });

  const adminId = String(req.query.admin_id || '').trim();
  if (!adminId || !adminTelegramIds.includes(adminId)) {
    return send(res, 403, { ok: false, error: 'FORBIDDEN' });
  }

  const { data: products, error: pErr } = await supabase
    .from('products')
    .select('id, name_uz, name_ru, name_en, search_text')
    .order('name_uz');

  if (pErr) return send(res, 500, { ok: false, error: pErr.message });

  const { data: aliases, error: aErr } = await supabase
    .from('product_aliases')
    .select('product_id, alias_text, language, store_name');

  if (aErr) return send(res, 500, { ok: false, error: aErr.message });

  const aliasMap = {};
  for (const a of aliases || []) {
    if (!aliasMap[a.product_id]) aliasMap[a.product_id] = [];
    aliasMap[a.product_id].push({ alias_text: a.alias_text, language: a.language, store_name: a.store_name });
  }

  const result = (products || []).map(p => ({
    id: p.id,
    name_uz: p.name_uz,
    name_ru: p.name_ru,
    name_en: p.name_en,
    search_text: p.search_text,
    aliases: aliasMap[p.id] || [],
  }));

  return send(res, 200, { ok: true, count: result.length, products: result });
}
