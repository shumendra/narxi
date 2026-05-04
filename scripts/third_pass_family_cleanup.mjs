import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

const PAGE_SIZE = 1000;
const BATCH_SIZE = 200;
const SAMPLE_LIMIT = 40;

const APPLY_MODE = process.argv.includes('--apply');

const FAMILY_RULES = [
  { name: 'manchester', tokens: ['manchester', 'манчестер'] },
  { name: 'kabrita', tokens: ['kabrita', 'кабрита'] },
].map(rule => ({
  ...rule,
  tokenKeys: rule.tokens.map(token => normalizeProductNameKey(token)).filter(Boolean),
}));

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

function createReasonCounter() {
  return new Map();
}

function incrementReason(reasonMap, reason) {
  reasonMap.set(reason, (reasonMap.get(reason) || 0) + 1);
}

function reasonMapToObject(reasonMap) {
  const sorted = [...reasonMap.entries()].sort((a, b) => b[1] - a[1]);
  const out = {};
  for (const [key, value] of sorted) out[key] = value;
  return out;
}

function pushSample(samples, sample) {
  if (samples.length >= SAMPLE_LIMIT) return;
  samples.push(sample);
}

function getMatchedFamilies(rawKey) {
  if (!rawKey) return [];
  return FAMILY_RULES.filter(rule => rule.tokenKeys.some(token => rawKey.includes(token)));
}

function resolveUniqueCandidate(rawKey, keyToProductIds, allowedProductIds = null, currentProductId = null) {
  if (!rawKey) return null;

  const candidates = Array.from(keyToProductIds.get(rawKey) || [])
    .filter(candidateId => !currentProductId || candidateId !== currentProductId)
    .filter(candidateId => !allowedProductIds || allowedProductIds.has(candidateId));

  if (candidates.length === 1) return candidates[0];
  return null;
}

async function applyUpdates({ updatesByProduct, detachIds }) {
  let attempted = 0;
  let updated = 0;

  for (const [productId, ids] of updatesByProduct.entries()) {
    for (const chunk of chunkArray(ids, BATCH_SIZE)) {
      attempted += chunk.length;
      const { data, error } = await supabase
        .from('prices')
        .update({ product_id: productId })
        .in('id', chunk)
        .select('id');
      if (error) throw error;
      updated += Array.isArray(data) ? data.length : 0;
    }
  }

  for (const chunk of chunkArray(detachIds, BATCH_SIZE)) {
    attempted += chunk.length;
    const { data, error } = await supabase
      .from('prices')
      .update({ product_id: null })
      .in('id', chunk)
      .select('id');
    if (error) throw error;
    updated += Array.isArray(data) ? data.length : 0;
  }

  return { attempted, updated };
}

async function run() {
  console.log(`Third pass mode: ${APPLY_MODE ? 'APPLY' : 'DRY_RUN'}`);

  const [products, aliases, prices] = await Promise.all([
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
  ]);

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

  const familyProductIdsByName = new Map();
  const familyNamesByProductId = new Map();

  for (const rule of FAMILY_RULES) {
    familyProductIdsByName.set(rule.name, new Set());
  }

  for (const [productId, productKeys] of productKeysById.entries()) {
    for (const rule of FAMILY_RULES) {
      const isFamilyProduct = [...productKeys].some(key => (
        rule.tokenKeys.some(token => key.includes(token))
      ));
      if (!isFamilyProduct) continue;

      familyProductIdsByName.get(rule.name).add(productId);
      if (!familyNamesByProductId.has(productId)) {
        familyNamesByProductId.set(productId, new Set());
      }
      familyNamesByProductId.get(productId).add(rule.name);
    }
  }

  const updatesByProduct = new Map();
  const detachIds = [];
  const reasonCounts = createReasonCounter();
  const samples = [];

  let scannedRows = 0;

  for (const row of prices || []) {
    scannedRows += 1;

    const rowId = row?.id || null;
    const currentProductId = row?.product_id || null;
    const rawName = String(row?.product_name_raw || '').trim();
    const rawKey = normalizeProductNameKey(rawName);
    const currentFamilyNames = new Set(familyNamesByProductId.get(currentProductId) || []);
    const matchedFamilies = getMatchedFamilies(rawKey);
    const matchedFamilyNames = new Set(matchedFamilies.map(f => f.name));

    if (!rowId || !currentProductId) {
      incrementReason(reasonCounts, 'skip_no_product_id');
      continue;
    }

    let decision = { action: 'keep', reason: 'keep_default', nextProductId: currentProductId };

    if (currentFamilyNames.size > 0) {
      const violatesCurrentFamily = [...currentFamilyNames].some(familyName => !matchedFamilyNames.has(familyName));
      if (violatesCurrentFamily) {
        const uniqueGlobal = resolveUniqueCandidate(rawKey, keyToProductIds, null, currentProductId);
        if (uniqueGlobal) {
          decision = {
            action: 'reassign',
            reason: 'family_guard_reassign_unique_global',
            nextProductId: uniqueGlobal,
          };
        } else {
          decision = {
            action: 'detach',
            reason: 'family_guard_detach_nonmatching_raw',
            nextProductId: null,
          };
        }
      }
    }

    if (decision.action === 'keep' && matchedFamilies.length > 0) {
      const currentMatchesAnyRawFamily = [...currentFamilyNames].some(familyName => matchedFamilyNames.has(familyName));
      if (!currentMatchesAnyRawFamily) {
        const allowed = new Set();
        for (const family of matchedFamilies) {
          const familyIds = familyProductIdsByName.get(family.name) || new Set();
          for (const id of familyIds) allowed.add(id);
        }

        const uniqueFamilyCandidate = resolveUniqueCandidate(rawKey, keyToProductIds, allowed, currentProductId);
        if (uniqueFamilyCandidate) {
          decision = {
            action: 'reassign',
            reason: 'family_raw_reassign_unique_family_candidate',
            nextProductId: uniqueFamilyCandidate,
          };
        } else {
          decision = {
            action: 'detach',
            reason: 'family_raw_detach_unresolved_family_candidate',
            nextProductId: null,
          };
        }
      }
    }

    incrementReason(reasonCounts, decision.reason);

    if (decision.action === 'reassign' && decision.nextProductId && decision.nextProductId !== currentProductId) {
      const list = updatesByProduct.get(decision.nextProductId) || [];
      list.push(rowId);
      updatesByProduct.set(decision.nextProductId, list);
      pushSample(samples, {
        id: rowId,
        raw: rawName,
        from: currentProductId,
        to: decision.nextProductId,
        reason: decision.reason,
      });
      continue;
    }

    if (decision.action === 'detach') {
      detachIds.push(rowId);
      pushSample(samples, {
        id: rowId,
        raw: rawName,
        from: currentProductId,
        to: null,
        reason: decision.reason,
      });
    }
  }

  const plannedReassign = [...updatesByProduct.values()].reduce((sum, ids) => sum + ids.length, 0);

  const summary = {
    mode: APPLY_MODE ? 'apply' : 'dry_run',
    families: FAMILY_RULES.map(rule => rule.name),
    totals: {
      products: products.length,
      aliases: aliases.length,
      scannedPrices: scannedRows,
    },
    plannedChanges: {
      reassign: plannedReassign,
      detach: detachIds.length,
      total: plannedReassign + detachIds.length,
    },
    reasonBreakdown: reasonMapToObject(reasonCounts),
    samples,
  };

  if (!APPLY_MODE) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const applied = await applyUpdates({ updatesByProduct, detachIds });

  const appliedSummary = {
    ...summary,
    applied: {
      attempted: applied.attempted,
      updated: applied.updated,
    },
  };

  console.log(JSON.stringify(appliedSummary, null, 2));
}

run().catch((error) => {
  console.error('Third pass cleanup failed:', error?.message || error);
  process.exit(1);
});
