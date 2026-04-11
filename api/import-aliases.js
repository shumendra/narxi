import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabaseKey = serviceRoleKey || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
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
 *   products: [
 *     {
 *       product_id: "<uuid>",
 *       canonical: { name_uz?: string, name_ru?: string, name_en?: string },
 *       category?: string,
 *       unit?: string,
 *       names: [
 *         { alias_text: string, language: "uz"|"ru"|"en"|"unknown", store_name?: string }
 *       ]
 *     }
 *   ],
 *   deleted_product_ids?: ["<uuid>", ...]
 * }
 */
export default async function handler(req, res) {
  if (!supabase) return send(res, 500, { ok: false, error: 'SUPABASE_NOT_CONFIGURED' });
  if (!serviceRoleKey) return send(res, 500, { ok: false, error: 'SUPABASE_SERVICE_ROLE_KEY not set – import requires service role access' });
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

  const adminId = String(body.admin_id || '').trim();
  if (!adminId || !adminTelegramIds.includes(adminId)) {
    return send(res, 403, { ok: false, error: 'FORBIDDEN' });
  }

  const aliasEntries = body.products || body.aliases || [];
  if (!Array.isArray(aliasEntries)) {
    return send(res, 400, { ok: false, error: 'PRODUCTS_ARRAY_REQUIRED' });
  }

  let aliasesInserted = 0;
  let canonicalUpdated = 0;
  let deletedCount = 0;
  const errors = [];

  // Delete products if deleted_product_ids provided
  const deletedIds = Array.isArray(body.deleted_product_ids) ? body.deleted_product_ids.map(id => String(id).trim()).filter(Boolean) : [];
  if (deletedIds.length > 0) {
    await supabase.from('product_aliases').delete().in('product_id', deletedIds);
    await supabase.from('prices').delete().in('product_id', deletedIds);
    await supabase.from('pending_prices').delete().in('product_id', deletedIds);
    const { error: delErr } = await supabase.from('products').delete().in('id', deletedIds);
    if (delErr) {
      errors.push({ error: delErr.message, phase: 'delete_products' });
    } else {
      deletedCount = deletedIds.length;
    }
  }

  for (const entry of aliasEntries) {
    const productId = String(entry.product_id || '').trim();
    if (!productId) {
      errors.push({ error: 'MISSING_PRODUCT_ID', entry });
      continue;
    }

    // Update canonical names, category, unit if provided
    const updates = {};
    if (entry.canonical && typeof entry.canonical === 'object') {
      if (entry.canonical.name_uz) updates.name_uz = String(entry.canonical.name_uz).trim();
      if (entry.canonical.name_ru) updates.name_ru = String(entry.canonical.name_ru).trim();
      if (entry.canonical.name_en) updates.name_en = String(entry.canonical.name_en).trim();
    }
    if (entry.category) updates.category = String(entry.category).trim();
    if (entry.unit) updates.unit = String(entry.unit).trim();

    if (Object.keys(updates).length > 0) {
      // Build search_text from canonical names in the update
      const searchParts = [updates.name_uz, updates.name_ru, updates.name_en].filter(Boolean);
      if (searchParts.length > 0) {
        updates.search_text = searchParts.join(' ');
      }

      const { error: uErr, count } = await supabase
        .from('products')
        .update(updates)
        .eq('id', productId)
        .select('id', { count: 'exact', head: true });

      if (uErr) {
        errors.push({ product_id: productId, error: uErr.message, phase: 'canonical' });
      } else if (count === 0) {
        errors.push({ product_id: productId, error: 'Product not found in DB', phase: 'canonical' });
      } else {
        canonicalUpdated++;
      }
    }

    // Full replace aliases: delete old, insert new
    const names = Array.isArray(entry.names) ? entry.names : [];
    if (names.length > 0) {
      // Delete all existing aliases for this product
      await supabase.from('product_aliases').delete().eq('product_id', productId);

      // Insert new aliases
      const rows = names
        .map(alias => {
          const aliasText = String(alias.alias_text || '').trim();
          if (!aliasText) return null;
          return {
            product_id: productId,
            alias_text: aliasText,
            language: String(alias.language || 'unknown').trim(),
            store_name: alias.store_name ? String(alias.store_name).trim() : null,
            times_seen: 1,
          };
        })
        .filter(Boolean);

      if (rows.length > 0) {
        const { error: iErr } = await supabase.from('product_aliases').insert(rows);
        if (iErr) {
          errors.push({ product_id: productId, error: iErr.message, phase: 'aliases' });
        } else {
          aliasesInserted += rows.length;
        }
      }
    }
  }

  return send(res, 200, {
    ok: true,
    canonical_updated: canonicalUpdated,
    aliases_inserted: aliasesInserted,
    products_deleted: deletedCount,
    errors: errors.length > 0 ? errors : undefined,
  });
}
