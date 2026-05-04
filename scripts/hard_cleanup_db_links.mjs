import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

const PAGE_SIZE = 1000;
const BATCH_SIZE = 200;
const PENDING_LOW_CONFIDENCE_THRESHOLD = 70;
const SAMPLE_LIMIT = 30;

const APPLY_MODE = process.argv.includes('--apply');
const CLEAN_PENDING = process.argv.includes('--include-pending');

for (const envName of ['.env.local', '.env']) {
  const envPath = path.resolve(process.cwd(), envName);
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false });
  }
}

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  || process.env.SUPABASE_KEY
  || process.env.SUPABASE_ANON_KEY
  || process.env.VITE_SUPABASE_ANON_KEY
  || '';

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials. Expected SUPABASE_URL and a key.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

function normalizeAliasKey(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeProductNameKey(value) {
  return normalizeAliasKey(value)
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u02BC]/g, "'")
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function chunkArray(values, size) {
  const result = [];
  for (let i = 0; i < values.length; i += size) {
    result.push(values.slice(i, i + size));
  }
  return result;
}

async function fetchAllPages(buildQuery) {
  const rows = [];
  let from = 0;

  while (true) {
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await buildQuery(from, to);
    if (error) throw error;

    const page = data || [];
    rows.push(...page);

    if (page.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return rows;
}

function addProductKeyMaps(productKeysById, keyToProductIds, productId, rawValue) {
  const key = normalizeProductNameKey(rawValue);
  if (!key || !productId) return;

  if (!productKeysById.has(productId)) {
    productKeysById.set(productId, new Set());
  }
  productKeysById.get(productId).add(key);

  if (!keyToProductIds.has(key)) {
    keyToProductIds.set(key, new Set());
  }
  keyToProductIds.get(key).add(productId);
}

function evaluateLinkCandidate({
  tableName,
  row,
  productIds,
  productKeysById,
  keyToProductIds,
}) {
  const rowId = row?.id || null;
  const currentProductId = row?.product_id || null;
  const rawName = String(row?.product_name_raw || '').trim();
  const rawKey = normalizeProductNameKey(rawName);
  const candidateProductIds = rawKey ? Array.from(keyToProductIds.get(rawKey) || []) : [];
  const uniqueCandidate = candidateProductIds.length === 1 ? candidateProductIds[0] : null;
  const currentProductExists = currentProductId ? productIds.has(currentProductId) : false;
  const currentKnownKeys = currentProductId ? productKeysById.get(currentProductId) : null;
  const currentHasRawKey = Boolean(currentKnownKeys?.has(rawKey));
  const lowConfidencePending = tableName === 'pending_prices'
    && Number(row?.match_confidence || 0) < PENDING_LOW_CONFIDENCE_THRESHOLD;

  if (!rowId) {
    return { action: 'keep', reason: 'missing_row_id', nextProductId: currentProductId };
  }

  if (!currentProductId) {
    return { action: 'keep', reason: 'already_unlinked', nextProductId: null };
  }

  if (!currentProductExists) {
    if (uniqueCandidate) {
      return {
        action: 'reassign',
        reason: 'orphan_product_id_reassigned_to_unique_match',
        nextProductId: uniqueCandidate,
      };
    }
    return {
      action: 'detach',
      reason: candidateProductIds.length > 1
        ? 'orphan_product_id_ambiguous_match'
        : 'orphan_product_id_no_match',
      nextProductId: null,
    };
  }

  if (!rawKey) {
    if (lowConfidencePending) {
      return { action: 'detach', reason: 'pending_low_confidence_missing_name_key', nextProductId: null };
    }
    return { action: 'keep', reason: 'missing_name_key', nextProductId: currentProductId };
  }

  if (currentHasRawKey) {
    return { action: 'keep', reason: 'current_mapping_matches_known_key', nextProductId: currentProductId };
  }

  if (uniqueCandidate) {
    return {
      action: 'reassign',
      reason: 'unique_name_key_match_other_product',
      nextProductId: uniqueCandidate,
    };
  }

  if (candidateProductIds.length > 1 && !candidateProductIds.includes(currentProductId)) {
    return { action: 'detach', reason: 'ambiguous_name_key_excludes_current_product', nextProductId: null };
  }

  if (lowConfidencePending) {
    return { action: 'detach', reason: 'pending_low_confidence_unknown_name_key', nextProductId: null };
  }

  return { action: 'keep', reason: 'unknown_name_key_conservative_keep', nextProductId: currentProductId };
}

async function applyGroupedUpdates({ tableName, updatesByProduct, detachIds }) {
  let updatedRows = 0;
  let attemptedRows = 0;

  for (const [productId, ids] of updatesByProduct.entries()) {
    for (const chunk of chunkArray(ids, BATCH_SIZE)) {
      attemptedRows += chunk.length;
      const { data, error } = await supabase
        .from(tableName)
        .update({ product_id: productId })
        .in('id', chunk)
        .select('id');
      if (error) throw error;
      updatedRows += Array.isArray(data) ? data.length : 0;
    }
  }

  for (const chunk of chunkArray(detachIds, BATCH_SIZE)) {
    attemptedRows += chunk.length;
    const { data, error } = await supabase
      .from(tableName)
      .update({ product_id: null })
      .in('id', chunk)
      .select('id');
    if (error) throw error;
    updatedRows += Array.isArray(data) ? data.length : 0;
  }

  return { updatedRows, attemptedRows };
}

function makeReasonCounter() {
  return new Map();
}

function incrementReason(reasonMap, reason) {
  reasonMap.set(reason, (reasonMap.get(reason) || 0) + 1);
}

function pushSample(samples, payload) {
  if (samples.length >= SAMPLE_LIMIT) return;
  samples.push(payload);
}

function reasonMapToObject(reasonMap) {
  const sorted = [...reasonMap.entries()].sort((a, b) => b[1] - a[1]);
  const obj = {};
  for (const [key, value] of sorted) obj[key] = value;
  return obj;
}

async function run() {
  console.log(`Hard cleanup mode: ${APPLY_MODE ? 'APPLY' : 'DRY_RUN'}`);

  const [products, aliases, prices, pending] = await Promise.all([
    fetchAllPages((from, to) => (
      supabase
        .from('products')
        .select('id,name_uz,name_ru,name_en')
        .order('name_uz', { ascending: true })
        .range(from, to)
    )),
    fetchAllPages((from, to) => (
      supabase
        .from('product_aliases')
        .select('product_id,alias_text')
        .range(from, to)
    )),
    fetchAllPages((from, to) => (
      supabase
        .from('prices')
        .select('id,product_id,product_name_raw,source')
        .not('source', 'like', 'history_%')
        .range(from, to)
    )),
    CLEAN_PENDING
      ? fetchAllPages((from, to) => (
          supabase
            .from('pending_prices')
            .select('id,product_id,product_name_raw,match_confidence,status')
            .or('status.eq.pending,status.is.null')
            .range(from, to)
        ))
      : Promise.resolve([]),
  ]);

  const productIds = new Set((products || []).map(item => item.id).filter(Boolean));
  const productKeysById = new Map();
  const keyToProductIds = new Map();

  for (const product of products || []) {
    addProductKeyMaps(productKeysById, keyToProductIds, product.id, product.name_uz);
    addProductKeyMaps(productKeysById, keyToProductIds, product.id, product.name_ru);
    addProductKeyMaps(productKeysById, keyToProductIds, product.id, product.name_en);
  }

  for (const alias of aliases || []) {
    addProductKeyMaps(productKeysById, keyToProductIds, alias.product_id, alias.alias_text);
  }

  const priceUpdatesByProduct = new Map();
  const priceDetachIds = [];
  const pendingUpdatesByProduct = new Map();
  const pendingDetachIds = [];

  const priceReasonCounts = makeReasonCounter();
  const pendingReasonCounts = makeReasonCounter();

  const priceSamples = [];
  const pendingSamples = [];

  let scannedPrices = 0;
  let scannedPending = 0;
  let skippedPendingByStatus = 0;

  for (const row of prices || []) {
    scannedPrices += 1;

    const decision = evaluateLinkCandidate({
      tableName: 'prices',
      row,
      productIds,
      productKeysById,
      keyToProductIds,
    });

    incrementReason(priceReasonCounts, decision.reason);

    if (decision.action === 'reassign' && decision.nextProductId && decision.nextProductId !== row.product_id) {
      const list = priceUpdatesByProduct.get(decision.nextProductId) || [];
      list.push(row.id);
      priceUpdatesByProduct.set(decision.nextProductId, list);
      pushSample(priceSamples, {
        id: row.id,
        raw: row.product_name_raw,
        from: row.product_id,
        to: decision.nextProductId,
        reason: decision.reason,
      });
    } else if (decision.action === 'detach' && row.product_id) {
      priceDetachIds.push(row.id);
      pushSample(priceSamples, {
        id: row.id,
        raw: row.product_name_raw,
        from: row.product_id,
        to: null,
        reason: decision.reason,
      });
    }
  }

  for (const row of pending || []) {
    const normalizedStatus = normalizeAliasKey(row?.status || 'pending');
    if (normalizedStatus === 'approved_limbo') {
      skippedPendingByStatus += 1;
      continue;
    }

    scannedPending += 1;

    const decision = evaluateLinkCandidate({
      tableName: 'pending_prices',
      row,
      productIds,
      productKeysById,
      keyToProductIds,
    });

    incrementReason(pendingReasonCounts, decision.reason);

    if (decision.action === 'reassign' && decision.nextProductId && decision.nextProductId !== row.product_id) {
      const list = pendingUpdatesByProduct.get(decision.nextProductId) || [];
      list.push(row.id);
      pendingUpdatesByProduct.set(decision.nextProductId, list);
      pushSample(pendingSamples, {
        id: row.id,
        raw: row.product_name_raw,
        from: row.product_id,
        to: decision.nextProductId,
        confidence: Number(row?.match_confidence || 0),
        reason: decision.reason,
      });
    } else if (decision.action === 'detach' && row.product_id) {
      pendingDetachIds.push(row.id);
      pushSample(pendingSamples, {
        id: row.id,
        raw: row.product_name_raw,
        from: row.product_id,
        to: null,
        confidence: Number(row?.match_confidence || 0),
        reason: decision.reason,
      });
    }
  }

  const plannedPriceReassignCount = [...priceUpdatesByProduct.values()].reduce((sum, list) => sum + list.length, 0);
  const plannedPendingReassignCount = [...pendingUpdatesByProduct.values()].reduce((sum, list) => sum + list.length, 0);

  const summary = {
    mode: APPLY_MODE ? 'apply' : 'dry_run',
    pendingScope: CLEAN_PENDING ? 'active_pending' : 'disabled',
    totals: {
      products: products.length,
      aliases: aliases.length,
      scannedPrices,
      scannedPending,
      skippedPendingApprovedLimbo: skippedPendingByStatus,
    },
    plannedChanges: {
      prices: {
        reassign: plannedPriceReassignCount,
        detach: priceDetachIds.length,
      },
      pending_prices: {
        reassign: plannedPendingReassignCount,
        detach: pendingDetachIds.length,
      },
    },
    reasonBreakdown: {
      prices: reasonMapToObject(priceReasonCounts),
      pending_prices: reasonMapToObject(pendingReasonCounts),
    },
    samples: {
      prices: priceSamples,
      pending_prices: pendingSamples,
    },
  };

  if (!APPLY_MODE) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const appliedPriceResult = await applyGroupedUpdates({
    tableName: 'prices',
    updatesByProduct: priceUpdatesByProduct,
    detachIds: priceDetachIds,
  });

  const appliedPendingResult = await applyGroupedUpdates({
    tableName: 'pending_prices',
    updatesByProduct: pendingUpdatesByProduct,
    detachIds: pendingDetachIds,
  });

  const appliedSummary = {
    ...summary,
    appliedChanges: {
      prices: {
        updated: appliedPriceResult.updatedRows,
        attempted: appliedPriceResult.attemptedRows,
      },
      pending_prices: {
        updated: appliedPendingResult.updatedRows,
        attempted: appliedPendingResult.attemptedRows,
      },
      totalUpdated: appliedPriceResult.updatedRows + appliedPendingResult.updatedRows,
      totalAttempted: appliedPriceResult.attemptedRows + appliedPendingResult.attemptedRows,
    },
  };

  console.log(JSON.stringify(appliedSummary, null, 2));
}

run().catch((error) => {
  console.error('Hard cleanup failed:', error?.message || error);
  process.exit(1);
});
