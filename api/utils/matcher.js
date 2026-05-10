/**
 * Five-level product matching hierarchy.
 *
 * Level 1 — Exact source match        (store_products lookup by original_name + source)
 * Level 2 — Normalised exact match    (same store, minor punctuation/case differences)
 * Level 3 — Token-sorted match        (same words, different order)
 * Level 4 — Store-scoped fuzzy match  (fuzz against all known products for THIS source)
 * Level 5 — Cross-store fuzzy match   (fuzz against all canonical products)
 * Level 6 — No match                  (queued as unmatched in store_products)
 *
 * Pass `options.sourceProductsCache` and `options.canonicalProductsCache` to avoid
 * redundant DB round-trips when calling this function in a tight loop (e.g. scraping
 * 21k Korzinka products). Both caches are pre-fetched once by the caller and passed
 * through; the matcher falls back to live DB queries when they are not provided.
 */

import { normaliseName, tokenSortName, normaliseSource } from './normalise.js';

const FUZZY_HIGH_THRESHOLD = 85;
const FUZZY_LOW_THRESHOLD = 70;

// ── Internal upsert helper ────────────────────────────────────────────────
async function upsertStoreProduct(supabase, data) {
  const { data: result } = await supabase
    .from('store_products')
    .upsert(data, { onConflict: 'source,original_name' })
    .select('id')
    .single();
  return result?.id || null;
}

// ── Main entry point ──────────────────────────────────────────────────────
/**
 * @param {string} rawName         Original product name from source
 * @param {string} source          Store identifier ('korzinka', 'makro', 'yandex_baraka', ...)
 * @param {object} supabase        Supabase client
 * @param {object} fuzz            fuzzball module (fuzz.ratio)
 * @param {object} [options]
 * @param {Array}  [options.sourceProductsCache]    Pre-fetched store_products rows for source
 * @param {Array}  [options.canonicalProductsCache] Pre-fetched canonical products rows
 * @returns {Promise<{store_product_id, canonical_product_id, confidence, level, ...}>}
 */
export async function matchProduct(rawName, source, supabase, fuzz, options = {}) {
  const normSource = normaliseSource(source);
  const normed = normaliseName(rawName);
  const tokenSorted = tokenSortName(rawName);

  // ── LEVEL 1: Exact source match ─────────────────────────────────────────
  // Same exact string from same source seen before — instant DB lookup
  const { data: exactMatch } = await supabase
    .from('store_products')
    .select('id, canonical_product_id, match_confidence, times_seen')
    .eq('source', normSource)
    .eq('original_name', rawName)
    .maybeSingle();

  if (exactMatch?.canonical_product_id) {
    await supabase
      .from('store_products')
      .update({ times_seen: (Number(exactMatch.times_seen) || 1) + 1, last_seen: new Date().toISOString() })
      .eq('id', exactMatch.id);

    return {
      store_product_id: exactMatch.id,
      canonical_product_id: exactMatch.canonical_product_id,
      confidence: 'exact',
      level: 1,
    };
  }

  // ── LEVEL 2: Normalised exact match ─────────────────────────────────────
  // Same product, minor punctuation/capitalisation difference
  const { data: normedMatch } = await supabase
    .from('store_products')
    .select('id, canonical_product_id')
    .eq('source', normSource)
    .eq('normalised_name', normed)
    .not('canonical_product_id', 'is', null)
    .maybeSingle();

  if (normedMatch?.canonical_product_id) {
    await upsertStoreProduct(supabase, {
      original_name: rawName,
      normalised_name: normed,
      token_sorted_name: tokenSorted,
      source: normSource,
      canonical_product_id: normedMatch.canonical_product_id,
      match_confidence: 'normalised',
    });

    return {
      store_product_id: normedMatch.id,
      canonical_product_id: normedMatch.canonical_product_id,
      confidence: 'normalised',
      level: 2,
    };
  }

  // ── LEVEL 3: Token-sorted normalised match ───────────────────────────────
  // Same words, different order — "Heinz ketchup" vs "ketchup Heinz"
  const { data: tokenMatch } = await supabase
    .from('store_products')
    .select('id, canonical_product_id')
    .eq('source', normSource)
    .eq('token_sorted_name', tokenSorted)
    .not('canonical_product_id', 'is', null)
    .maybeSingle();

  if (tokenMatch?.canonical_product_id) {
    await upsertStoreProduct(supabase, {
      original_name: rawName,
      normalised_name: normed,
      token_sorted_name: tokenSorted,
      source: normSource,
      canonical_product_id: tokenMatch.canonical_product_id,
      match_confidence: 'normalised',
    });

    return {
      store_product_id: tokenMatch.id,
      canonical_product_id: tokenMatch.canonical_product_id,
      confidence: 'token_sorted',
      level: 3,
    };
  }

  // ── LEVEL 4: Store-scoped fuzzy match ────────────────────────────────────
  // Compare against all known products from THIS source only.
  // Uses caller-supplied cache when available to avoid N repeated DB fetches.
  const sourceProducts = options.sourceProductsCache
    || await (async () => {
      const { data } = await supabase
        .from('store_products')
        .select('id, original_name, normalised_name, token_sorted_name, canonical_product_id')
        .eq('source', normSource)
        .not('canonical_product_id', 'is', null);
      return data || [];
    })();

  if (sourceProducts.length > 0) {
    let bestScore = 0;
    let bestMatch = null;

    for (const sp of sourceProducts) {
      const score1 = fuzz.ratio(normed, sp.normalised_name);
      const score2 = fuzz.ratio(tokenSorted, sp.token_sorted_name);
      const score = Math.max(score1, score2);

      if (score > bestScore) {
        bestScore = score;
        bestMatch = sp;
      }
    }

    if (bestScore >= FUZZY_HIGH_THRESHOLD && bestMatch?.canonical_product_id) {
      const storeProductId = await upsertStoreProduct(supabase, {
        original_name: rawName,
        normalised_name: normed,
        token_sorted_name: tokenSorted,
        source: normSource,
        canonical_product_id: bestMatch.canonical_product_id,
        match_confidence: 'fuzzy_high',
      });

      return {
        store_product_id: storeProductId,
        canonical_product_id: bestMatch.canonical_product_id,
        confidence: 'fuzzy_high',
        score: bestScore,
        level: 4,
      };
    }

    if (bestScore >= FUZZY_LOW_THRESHOLD && bestMatch?.canonical_product_id) {
      const storeProductId = await upsertStoreProduct(supabase, {
        original_name: rawName,
        normalised_name: normed,
        token_sorted_name: tokenSorted,
        source: normSource,
        canonical_product_id: bestMatch.canonical_product_id,
        match_confidence: 'fuzzy_low',
      });

      return {
        store_product_id: storeProductId,
        canonical_product_id: bestMatch.canonical_product_id,
        confidence: 'fuzzy_low',
        score: bestScore,
        level: 4,
        needs_review: true,
      };
    }
  }

  // ── LEVEL 5: Cross-store canonical fuzzy match ───────────────────────────
  // Product not seen from this source before. Compare against full products table.
  // Uses caller-supplied cache when available.
  const canonicalProducts = options.canonicalProductsCache
    || await (async () => {
      const { data } = await supabase
        .from('products')
        .select('id, name_uz, name_ru, name_en, search_text');
      return data || [];
    })();

  if (canonicalProducts.length > 0) {
    let bestScore = 0;
    let bestCanonical = null;

    for (const cp of canonicalProducts) {
      const scores = [
        cp.name_uz ? fuzz.ratio(normed, normaliseName(cp.name_uz)) : 0,
        cp.name_ru ? fuzz.ratio(normed, normaliseName(cp.name_ru)) : 0,
        cp.name_en ? fuzz.ratio(normed, normaliseName(cp.name_en)) : 0,
        cp.name_uz ? fuzz.ratio(tokenSorted, tokenSortName(cp.name_uz)) : 0,
        cp.name_ru ? fuzz.ratio(tokenSorted, tokenSortName(cp.name_ru)) : 0,
      ];
      const score = Math.max(...scores);

      if (score > bestScore) {
        bestScore = score;
        bestCanonical = cp;
      }
    }

    if (bestScore >= FUZZY_HIGH_THRESHOLD && bestCanonical) {
      const storeProductId = await upsertStoreProduct(supabase, {
        original_name: rawName,
        normalised_name: normed,
        token_sorted_name: tokenSorted,
        source: normSource,
        canonical_product_id: bestCanonical.id,
        match_confidence: 'fuzzy_high',
      });

      return {
        store_product_id: storeProductId,
        canonical_product_id: bestCanonical.id,
        confidence: 'fuzzy_high',
        score: bestScore,
        level: 5,
      };
    }

    if (bestScore >= FUZZY_LOW_THRESHOLD && bestCanonical) {
      const storeProductId = await upsertStoreProduct(supabase, {
        original_name: rawName,
        normalised_name: normed,
        token_sorted_name: tokenSorted,
        source: normSource,
        canonical_product_id: bestCanonical.id,
        match_confidence: 'fuzzy_low',
      });

      return {
        store_product_id: storeProductId,
        canonical_product_id: bestCanonical.id,
        confidence: 'fuzzy_low',
        score: bestScore,
        level: 5,
        needs_review: true,
      };
    }
  }

  // ── LEVEL 6: No match — create unmatched store_product ──────────────────
  // Queued for manual normalisation. Admin downloads and processes via Claude.
  const storeProductId = await upsertStoreProduct(supabase, {
    original_name: rawName,
    normalised_name: normed,
    token_sorted_name: tokenSorted,
    source: normSource,
    canonical_product_id: null,
    match_confidence: 'unmatched',
  });

  return {
    store_product_id: storeProductId,
    canonical_product_id: null,
    confidence: 'unmatched',
    level: 6,
    needs_normalisation: true,
  };
}
