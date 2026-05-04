import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

for (const envName of ['.env.local', '.env']) {
  const envPath = path.resolve(process.cwd(), envName);
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false });
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL
  || process.env.VITE_SUPABASE_URL
  || '';

const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
  || process.env.SUPABASE_KEY
  || process.env.SUPABASE_ANON_KEY
  || process.env.VITE_SUPABASE_ANON_KEY
  || '';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing Supabase credentials.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const PAGE_SIZE = 1000;
const queries = process.argv.slice(2);

const targets = queries.length > 0
  ? queries
  : ['Manchester', 'Kabrita', 'Brivais Vilnis'];

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

function toDisplayName(product) {
  const names = [product?.name_uz, product?.name_ru, product?.name_en]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  return names[0] || product?.id || 'UNKNOWN_PRODUCT';
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

function matchesTerm(text, term) {
  const lhs = normalizeAliasKey(text);
  const rhs = normalizeAliasKey(term);
  if (!lhs || !rhs) return false;
  return lhs.includes(rhs);
}

function classifyByName(rows, knownNameKeys) {
  let consistent = 0;
  let inconsistent = 0;
  const inconsistentSamples = [];

  for (const row of rows || []) {
    const rawKey = normalizeProductNameKey(row?.product_name_raw);
    if (knownNameKeys.has(rawKey)) {
      consistent += 1;
      continue;
    }

    inconsistent += 1;
    if (inconsistentSamples.length < 6) {
      inconsistentSamples.push({
        id: row?.id,
        product_name_raw: row?.product_name_raw,
        confidence: row?.match_confidence,
        source: row?.source,
      });
    }
  }

  return {
    total: (rows || []).length,
    consistent,
    inconsistent,
    inconsistentSamples,
  };
}

function summarizeRawTermMatches(rows, matchedProductIds) {
  const total = (rows || []).length;
  let linked = 0;
  let unlinked = 0;
  let linkedToMatchedProducts = 0;
  let linkedOutsideMatchedProducts = 0;

  for (const row of rows || []) {
    if (!row?.product_id) {
      unlinked += 1;
      continue;
    }

    linked += 1;
    if (matchedProductIds.has(row.product_id)) linkedToMatchedProducts += 1;
    else linkedOutsideMatchedProducts += 1;
  }

  return {
    total,
    linked,
    unlinked,
    linkedToMatchedProducts,
    linkedOutsideMatchedProducts,
  };
}

async function run() {
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
        .select('id,product_id,product_name_raw,source,city,place_name')
        .not('source', 'like', 'history_%')
        .range(from, to)
    )),
    fetchAllPages((from, to) => (
      supabase
        .from('pending_prices')
        .select('id,product_id,product_name_raw,match_confidence,status,source')
        .or('status.eq.pending,status.is.null')
        .range(from, to)
    )),
  ]);

  const aliasByProductId = new Map();
  for (const alias of aliases || []) {
    const list = aliasByProductId.get(alias.product_id) || [];
    list.push(String(alias.alias_text || ''));
    aliasByProductId.set(alias.product_id, list);
  }

  const pricesByProductId = new Map();
  for (const row of prices || []) {
    const list = pricesByProductId.get(row.product_id) || [];
    list.push(row);
    pricesByProductId.set(row.product_id, list);
  }

  const pendingByProductId = new Map();
  for (const row of pending || []) {
    const list = pendingByProductId.get(row.product_id) || [];
    list.push(row);
    pendingByProductId.set(row.product_id, list);
  }

  const checks = [];

  for (const term of targets) {
    const matchedProducts = (products || []).filter(product => {
      const haystack = [
        product?.name_uz,
        product?.name_ru,
        product?.name_en,
        ...(aliasByProductId.get(product.id) || []),
      ].join(' | ');
      return matchesTerm(haystack, term);
    });

    const matchedPricesByRaw = (prices || [])
      .filter(row => matchesTerm(row?.product_name_raw, term))
      .slice(0, 30);

    const matchedPendingByRaw = (pending || [])
      .filter(row => matchesTerm(row?.product_name_raw, term))
      .slice(0, 30);

    const allMatchedPricesByRaw = (prices || [])
      .filter(row => matchesTerm(row?.product_name_raw, term));

    const allMatchedPendingByRaw = (pending || [])
      .filter(row => matchesTerm(row?.product_name_raw, term));

    const matchedProductIds = new Set(matchedProducts.map(item => item.id));

    const productSummaries = matchedProducts.slice(0, 12).map(product => {
      const knownNameKeys = new Set([
        normalizeProductNameKey(product?.name_uz),
        normalizeProductNameKey(product?.name_ru),
        normalizeProductNameKey(product?.name_en),
        ...(aliasByProductId.get(product.id) || []).map(aliasText => normalizeProductNameKey(aliasText)),
      ].filter(Boolean));

      const priceRows = pricesByProductId.get(product.id) || [];
      const pendingRows = pendingByProductId.get(product.id) || [];

      return {
        id: product.id,
        name: toDisplayName(product),
        priceLinkState: classifyByName(priceRows, knownNameKeys),
        pendingLinkState: classifyByName(pendingRows, knownNameKeys),
      };
    });

    checks.push({
      term,
      matchedProductsCount: matchedProducts.length,
      productSummaries,
      rawNameMatches: {
        pricesCount: allMatchedPricesByRaw.length,
        pendingCount: allMatchedPendingByRaw.length,
        pricesLinkage: summarizeRawTermMatches(allMatchedPricesByRaw, matchedProductIds),
        pendingLinkage: summarizeRawTermMatches(allMatchedPendingByRaw, matchedProductIds),
        pricesSamples: matchedPricesByRaw.slice(0, 8),
        pendingSamples: matchedPendingByRaw.slice(0, 8),
      },
    });
  }

  const response = {
    generatedAt: new Date().toISOString(),
    totals: {
      products: products.length,
      aliases: aliases.length,
      prices: prices.length,
      pending: pending.length,
    },
    checks,
  };

  console.log(JSON.stringify(response, null, 2));
}

run().catch((error) => {
  console.error('Spot-check failed:', error?.message || error);
  process.exit(1);
});
