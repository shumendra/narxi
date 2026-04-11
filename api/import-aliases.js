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
 * POST /api/import-aliases
 *
 * Accepts AI-generated alias mappings and upserts them into product_aliases.
 *
 * Body:
 * {
 *   admin_id: "<telegram_id>",
 *   aliases: [
 *     {
 *       product_id: "<uuid>",
 *       canonical: { name_uz?: string, name_ru?: string, name_en?: string },
 *       names: [
 *         { alias_text: string, language: "uz"|"ru"|"en"|"unknown", store_name?: string }
 *       ]
 *     }
 *   ]
 * }
 *
 * - canonical: if provided, updates products.name_uz/ru/en and rebuilds search_text.
 * - names: each entry is upserted into product_aliases (increment times_seen if exists).
 */
export default async function handler(req, res) {
  if (!supabase) return send(res, 500, { ok: false, error: 'SUPABASE_NOT_CONFIGURED' });
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

  const adminId = String(body.admin_id || '').trim();
  if (!adminId || !adminTelegramIds.includes(adminId)) {
    return send(res, 403, { ok: false, error: 'FORBIDDEN' });
  }

  const aliasEntries = body.aliases;
  if (!Array.isArray(aliasEntries) || aliasEntries.length === 0) {
    return send(res, 400, { ok: false, error: 'ALIASES_ARRAY_REQUIRED' });
  }

  let updated = 0;
  let inserted = 0;
  let canonicalUpdated = 0;
  const errors = [];

  for (const entry of aliasEntries) {
    const productId = String(entry.product_id || '').trim();
    if (!productId) {
      errors.push({ error: 'MISSING_PRODUCT_ID', entry });
      continue;
    }

    // Update canonical names if provided
    if (entry.canonical && typeof entry.canonical === 'object') {
      const updates = {};
      if (entry.canonical.name_uz) updates.name_uz = String(entry.canonical.name_uz).trim();
      if (entry.canonical.name_ru) updates.name_ru = String(entry.canonical.name_ru).trim();
      if (entry.canonical.name_en) updates.name_en = String(entry.canonical.name_en).trim();

      if (Object.keys(updates).length > 0) {
        // Rebuild search_text from canonical names
        const allNames = [updates.name_uz, updates.name_ru, updates.name_en].filter(Boolean);

        // Also fetch existing names to fill in gaps
        const { data: existing } = await supabase
          .from('products')
          .select('name_uz, name_ru, name_en')
          .eq('id', productId)
          .maybeSingle();

        if (existing) {
          const merged = {
            name_uz: updates.name_uz || existing.name_uz || '',
            name_ru: updates.name_ru || existing.name_ru || '',
            name_en: updates.name_en || existing.name_en || '',
          };
          updates.search_text = [merged.name_uz, merged.name_ru, merged.name_en].filter(Boolean).join(' ');
        }

        const { error: uErr } = await supabase
          .from('products')
          .update(updates)
          .eq('id', productId);

        if (uErr) {
          errors.push({ product_id: productId, error: uErr.message, phase: 'canonical' });
        } else {
          canonicalUpdated++;
        }
      }
    }

    // Upsert aliases
    const names = Array.isArray(entry.names) ? entry.names : [];
    for (const alias of names) {
      const aliasText = String(alias.alias_text || '').trim();
      if (!aliasText) continue;

      const language = String(alias.language || 'unknown').trim();
      const storeName = alias.store_name ? String(alias.store_name).trim() : null;

      // Check if alias already exists for this product
      let query = supabase
        .from('product_aliases')
        .select('id, times_seen')
        .eq('product_id', productId)
        .ilike('alias_text', aliasText);

      if (storeName) {
        query = query.eq('store_name', storeName);
      } else {
        query = query.is('store_name', null);
      }

      const { data: existing } = await query.maybeSingle();

      if (existing) {
        await supabase
          .from('product_aliases')
          .update({ times_seen: (existing.times_seen || 1) + 1, language })
          .eq('id', existing.id);
        updated++;
      } else {
        const { error: iErr } = await supabase
          .from('product_aliases')
          .insert({
            product_id: productId,
            alias_text: aliasText,
            language,
            store_name: storeName,
            times_seen: 1,
          });
        if (iErr) {
          errors.push({ product_id: productId, alias_text: aliasText, error: iErr.message });
        } else {
          inserted++;
        }
      }
    }
  }

  return send(res, 200, {
    ok: true,
    canonical_updated: canonicalUpdated,
    aliases_inserted: inserted,
    aliases_updated: updated,
    errors: errors.length > 0 ? errors : undefined,
  });
}
