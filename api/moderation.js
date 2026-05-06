import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { extractCityFromAddress, normalizeCityName } from '../src/constants/cities.js';
import { normalizeSoliqUrl, scrapesoliqReceipt } from './utils/receipt.js';

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
const telegramToken = process.env.TELEGRAM_BOT_TOKEN || '';
const adminTelegramIds = (process.env.ADMIN_TELEGRAM_IDS || process.env.ADMIN_TELEGRAM_ID || '7240925672')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean);

const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;
const PAGE_SIZE = 1000;
const STORE_API_MATCH_MIN_SCORE = 70;
const NORMALIZATION_BATCH_SIZE = 100;
const CONFIGURED_GEMINI_MODEL = String(process.env.GEMINI_MODEL || '').trim();
// Models ordered by RPM limit (high → low): 2.5-flash-lite & 2.0-flash-lite = 4K RPM;
// gemini-2.5-flash = 1 RPM (kept as last-resort fallback for quality).
const NORMALIZATION_MODEL_CANDIDATES = Array.from(new Set([
  ...(CONFIGURED_GEMINI_MODEL ? [CONFIGURED_GEMINI_MODEL] : []),
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash-lite',
  'gemini-2.5-flash',
]));
const parsedNormalizationMaxNames = Number.parseInt(process.env.NORMALIZATION_MAX_NAMES_PER_RUN || '120', 10);
const NORMALIZATION_MAX_NAMES_PER_RUN = Number.isFinite(parsedNormalizationMaxNames) && parsedNormalizationMaxNames > 0
  ? parsedNormalizationMaxNames
  : 120;
const BULK_DB_CHUNK_SIZE = 240;
const BULK_DB_CONCURRENCY = 4;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const LIMBO_APPROVED_STATUS = 'approved_limbo';
const LIMBO_IMPORTED_STATUS = 'imported';
const LIMBO_EXPORT_PREFIX = 'limbo:';
const RECEIPT_PIPELINE_STATUS_SCANNED = 'scanned';
const RECEIPT_PIPELINE_STATUS_FAILED = 'failed';
const RECEIPT_PIPELINE_STATUS_UNSCANNED = 'unscanned';
const SAFE_PERFORMANCE_INDEX_SQL = [
  'CREATE INDEX IF NOT EXISTS prices_product_id_idx ON prices (product_id);',
  'CREATE INDEX IF NOT EXISTS prices_product_id_receipt_date_idx ON prices (product_id, receipt_date DESC);',
  'CREATE INDEX IF NOT EXISTS pending_prices_product_id_idx ON pending_prices (product_id);',
  'CREATE INDEX IF NOT EXISTS pending_prices_product_id_created_at_idx ON pending_prices (product_id, created_at DESC);',
  'CREATE INDEX IF NOT EXISTS pending_prices_status_idx ON pending_prices (status);',
  'CREATE INDEX IF NOT EXISTS product_views_product_id_idx ON product_views (product_id);',
];

let performanceIndexesChecked = false;
let ensurePerformanceIndexesPromise = null;

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

function detectAliasLanguage(text) {
  const value = String(text || '');
  if (/\p{Script=Cyrillic}/u.test(value)) return 'ru';
  if (/[A-Za-zʻ’'`]/.test(value)) return 'uz';
  return 'unknown';
}

function normalizeMaybeText(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function toTitleCaseWords(value) {
  return String(value || '')
    .split(/\s+/)
    .map(part => part ? `${part[0].toUpperCase()}${part.slice(1).toLowerCase()}` : '')
    .join(' ')
    .trim();
}

function inferStoreNameFromSource(sourceValue) {
  const source = String(sourceValue || '');
  if (!source.startsWith('store_api_')) return null;
  const raw = source.replace('store_api_', '').replace(/_/g, ' ').trim();
  return raw ? toTitleCaseWords(raw) : null;
}

function buildLimboProductId(rawName) {
  const hash = crypto.createHash('sha1').update(String(rawName || '').toLowerCase()).digest('hex').slice(0, 16);
  return `${LIMBO_EXPORT_PREFIX}${hash}`;
}

async function fetchReceiptMetadata(receiptUrl, receiptCache) {
  const normalized = normalizeSoliqUrl(receiptUrl || '') || String(receiptUrl || '').trim();
  if (!normalized) return null;

  if (receiptCache?.has(normalized)) {
    return receiptCache.get(normalized);
  }

  let parsed = null;
  try {
    parsed = await scrapesoliqReceipt(normalized);
  } catch {
    parsed = null;
  }

  const data = (parsed && !parsed._generating) ? parsed : null;
  if (receiptCache) receiptCache.set(normalized, data);
  return data;
}

async function resolvePendingStoreContext(pending, receiptCache = null) {
  const source = String(pending?.source || '');
  const isStoreApiSource = source.startsWith('store_api_');
  const sourceStoreName = inferStoreNameFromSource(source);

  let placeName = normalizeMaybeText(pending?.place_name);
  let placeAddress = normalizeMaybeText(pending?.place_address);
  let city = normalizeCityName(pending?.city || '') || normalizeCityName(extractCityFromAddress(placeAddress || ''));
  let latitude = Number.isFinite(Number(pending?.latitude)) ? Number(pending.latitude) : null;
  let longitude = Number.isFinite(Number(pending?.longitude)) ? Number(pending.longitude) : null;
  let receiptDate = normalizeMaybeText(pending?.receipt_date) || null;

  const receiptUrl = normalizeMaybeText(pending?.receipt_url);
  const needsReceiptLookup = Boolean(receiptUrl) && (
    !placeName
    || !placeAddress
    || !city
    || latitude == null
    || longitude == null
    || !receiptDate
  );

  if (needsReceiptLookup) {
    const receiptData = await fetchReceiptMetadata(receiptUrl, receiptCache);
    if (receiptData) {
      placeName = placeName || normalizeMaybeText(receiptData.storeName);
      placeAddress = placeAddress || normalizeMaybeText(receiptData.storeAddress);

      const receiptCity = normalizeCityName(
        receiptData.city
        || receiptData.detectedCity
        || extractCityFromAddress(receiptData.storeAddress || '')
      );
      city = city || receiptCity;

      if (latitude == null && Number.isFinite(Number(receiptData.latitude))) {
        latitude = Number(receiptData.latitude);
      }
      if (longitude == null && Number.isFinite(Number(receiptData.longitude))) {
        longitude = Number(receiptData.longitude);
      }

      receiptDate = receiptDate || normalizeMaybeText(receiptData.receiptDate) || null;
    }
  }

  if (!placeName) {
    placeName = sourceStoreName || 'Unknown Store';
  }
  if (!placeAddress) {
    placeAddress = sourceStoreName || placeName;
  }

  city = city
    || normalizeCityName(extractCityFromAddress(placeAddress || ''))
    || 'Tashkent';

  if (isStoreApiSource && !placeName) {
    placeName = sourceStoreName || 'Unknown Store';
  }

  if (isStoreApiSource && !placeAddress) {
    placeAddress = sourceStoreName || placeName || 'Unknown Store';
  }

  return {
    source,
    isStoreApiSource,
    placeName,
    placeAddress,
    city,
    latitude,
    longitude,
    receiptDate,
  };
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

function chunkArray(values, size) {
  const result = [];
  for (let i = 0; i < values.length; i += size) {
    result.push(values.slice(i, i + size));
  }
  return result;
}

async function ensurePerformanceIndexes() {
  if (performanceIndexesChecked) return;
  if (ensurePerformanceIndexesPromise) {
    await ensurePerformanceIndexesPromise;
    return;
  }

  ensurePerformanceIndexesPromise = (async () => {
    try {
      const rpcAvailable = await isExecSqlAvailable();
      if (!rpcAvailable) return;

      for (const sql of SAFE_PERFORMANCE_INDEX_SQL) {
        const { error } = await supabase.rpc('exec_sql', { sql });
        if (!error) continue;

        // If exec_sql cannot run here, keep moderation flow alive.
        if (isExecSqlUnavailableError(error)) return;
        if (String(error?.message || '').toLowerCase().includes('permission')) return;
      }
    } catch {
      // Ignore one-time index bootstrap errors.
    } finally {
      performanceIndexesChecked = true;
    }
  })();

  await ensurePerformanceIndexesPromise;
  ensurePerformanceIndexesPromise = null;
}

function normalizeRequiredProductId(id) {
  const normalized = String(id || '').trim();
  if (!normalized) {
    const invalid = new Error('product id is required');
    invalid.statusCode = 400;
    throw invalid;
  }
  return normalized;
}

function isMissingRelationError(errorLike) {
  const message = String(errorLike?.message || '').toLowerCase();
  return message.includes('does not exist') || message.includes('relation') || message.includes('schema cache');
}

function isExecSqlUnavailableError(errorLike) {
  const message = String(errorLike?.message || '').toLowerCase();
  return message.includes('exec_sql')
    && (
      message.includes('does not exist')
      || message.includes('not found')
      || message.includes('permission')
      || message.includes('schema cache')
    );
}

function cleanSqlResponse(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text
    .replace(/^```sql\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();
}

function containsSqlDml(sql) {
  return /\b(insert|update|delete)\b/i.test(String(sql || ''));
}

/**
 * Normalize Unicode apostrophe variants and escape any unescaped single-quotes
 * inside SQL string literals. Uzbek words like go'sht, o'rik, qo'zi contain
 * the apostrophe character which breaks string literals unless doubled ('').
 */
function sanitizeSqlApostrophes(sql) {
  // Step 1: normalize curly/Unicode apostrophe variants to plain ASCII '
  const s = String(sql || '')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u02BC]/g, "'");

  let result = '';
  let i = 0;

  while (i < s.length) {
    // SQL line comment: copy to end-of-line unchanged
    if (s[i] === '-' && s[i + 1] === '-') {
      const eol = s.indexOf('\n', i);
      if (eol === -1) { result += s.slice(i); break; }
      result += s.slice(i, eol + 1);
      i = eol + 1;
      continue;
    }

    // Start of a string literal
    if (s[i] === "'") {
      result += "'";
      i++;
      while (i < s.length) {
        if (s[i] === "'") {
          if (i + 1 < s.length && s[i + 1] === "'") {
            // Already-escaped pair: keep as-is
            result += "''";
            i += 2;
          } else {
            // Lookahead: if the next meaningful character is a SQL delimiter,
            // this quote closes the string; otherwise it's an unescaped
            // apostrophe inside the value (e.g. go'sht) that must be doubled.
            let j = i + 1;
            while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
            const next = j < s.length ? s[j] : '';
            const isDelimiter = next === '' || next === ',' || next === ')' ||
              next === ';' || next === '\n' || next === '\r';
            if (isDelimiter) {
              result += "'";
              i++;
              break; // close string literal
            } else {
              result += "''";
              i++;
            }
          }
        } else {
          result += s[i];
          i++;
        }
      }
    } else {
      result += s[i];
      i++;
    }
  }

  return result;
}

function splitSqlStatements(sqlText) {
  const statements = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  const sql = String(sqlText || '');
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const prev = i > 0 ? sql[i - 1] : '';

    if (char === "'" && !inDouble && prev !== '\\') {
      inSingle = !inSingle;
      current += char;
      continue;
    }

    if (char === '"' && !inSingle && prev !== '\\') {
      inDouble = !inDouble;
      current += char;
      continue;
    }

    if (char === ';' && !inSingle && !inDouble) {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = '';
      continue;
    }

    current += char;
  }

  const trailing = current.trim();
  if (trailing) statements.push(trailing);

  return statements;
}

async function getLastNormalizationTimestamp() {
  const { data, error } = await supabase
    .from('normalization_runs')
    .select('finished_at,started_at,created_at,status')
    .eq('status', 'success')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    if (isMissingRelationError(error)) return { timestamp: null, tableExists: false };
    throw error;
  }

  const timestamp = data?.finished_at || data?.started_at || data?.created_at || null;
  return { timestamp, tableExists: true };
}

async function recordNormalizationRun(payload) {
  const { error } = await supabase.from('normalization_runs').insert(payload);
  if (error && !isMissingRelationError(error)) {
    throw error;
  }
}

async function isExecSqlAvailable() {
  const { error } = await supabase.rpc('exec_sql', { sql: 'SELECT 1;' });
  if (!error) return true;
  if (isExecSqlUnavailableError(error)) return false;
  throw error;
}

function buildNormalizationPrompt({ products, aliases, rawNames, firstRun }) {
  const productsContext = (products || []).length > 0
    ? products.map(p => [
      p.id,
      String(p.name_uz || '').trim(),
      String(p.name_ru || '').trim(),
      String(p.name_en || '').trim(),
      String(p.category || '').trim(),
      String(p.unit || '').trim(),
      String(p.search_text || '').trim(),
    ].join('|')).join('\n')
    : '(empty)';

  const aliasesContext = (aliases || []).length > 0
    ? aliases.map(a => `${a.product_id}|${String(a.alias_text || '').trim()}`).join('\n')
    : '(empty)';

  const rawNamesContext = (rawNames || []).join('\n');

  return `You are normalizing grocery product data for an Uzbekistan price comparison app called Narxi.

EXISTING CANONICAL PRODUCTS (id|name_uz|name_ru|name_en|category|unit|search_text):
${productsContext}

EXISTING ALIASES (product_id|alias_text):
${aliasesContext}

NEW RAW PRODUCT NAMES TO PROCESS:
${rawNamesContext}

FIRST RUN FLAG:
${firstRun ? 'YES' : 'NO'}

CATEGORIES (use exactly): Don mahsulotlari, Sut mahsulotlari, Gosht mahsulotlari, Sabzavotlar va mevalar, Ichimliklar, Choy va kofe, Shirinliklar va pechene, Moy va souslar, Non va xamirlar, Uy kimyosi, Shaxsiy gigiena, Boshqa

UNITS (use exactly): kg, litre, dona, gramm

RULES:
1. For each raw name decide: MATCH to existing product, or CREATE new product.
2. MATCH if raw name clearly maps to an existing canonical product despite language, spelling variant, size suffix, or brand qualifier.
3. CREATE only if genuinely different from canonical list.
4. Remove weight/size/grade suffixes from canonical names unless it changes the product identity.
5. Keep brand names for branded products.
6. Translate all three languages accurately.
7. Never duplicate an existing canonical product.
8. search_text must be: name_uz + space + name_ru + space + name_en.
9. Only create aliases for raw names, not canonical names themselves.
10. Output ONLY valid PostgreSQL SQL. No markdown. No prose.
11. CRITICAL: The alias frequency column is named exactly "times_seen" (never "times"). Every ON CONFLICT clause must use times_seen = product_aliases.times_seen + 1.
12. CRITICAL APOSTROPHE ESCAPING: Product names in Uzbek often contain apostrophes (go'sht, o'rik, qo'zi, ko'k, etc.). In SQL string literals you MUST escape every apostrophe by doubling it: go''sht, o''rik. Never emit a bare single-quote inside a string value.

OUTPUT SQL SHAPE:
-- ALIASES FOR MATCHED PRODUCTS
INSERT INTO product_aliases (product_id, alias_text, language, times_seen)
VALUES ('[existing_product_id]', '[raw_name]', 'unknown', 1)
ON CONFLICT (product_id, alias_text) DO UPDATE SET times_seen = product_aliases.times_seen + 1;

-- NEW CANONICAL PRODUCTS
INSERT INTO products (name_uz, name_ru, name_en, category, unit, search_text)
VALUES ('[name_uz]', '[name_ru]', '[name_en]', '[category]', '[unit]', '[search_text]')
ON CONFLICT DO NOTHING;

-- ALIASES FOR NEW PRODUCTS
INSERT INTO product_aliases (product_id, alias_text, language, times_seen)
SELECT id, '[raw_name]', 'unknown', 1
FROM products WHERE name_uz = '[name_uz]'
ON CONFLICT (product_id, alias_text) DO UPDATE SET times_seen = product_aliases.times_seen + 1;

-- UPDATE MISSING TRANSLATIONS
UPDATE products SET
  name_ru = '[name_ru]',
  name_en = '[name_en]',
  search_text = '[search_text]'
WHERE id = '[id]'
AND (name_ru IS NULL OR name_ru = '' OR name_ru = name_uz OR name_en IS NULL OR name_en = '' OR name_en = name_uz);`;
}

async function runGeminiNormalizationBatch({ products, aliases, rawNames, firstRun }) {
  if (!GEMINI_API_KEY) {
    const missing = new Error('GEMINI_API_KEY is not configured');
    missing.statusCode = 500;
    throw missing;
  }

  const prompt = buildNormalizationPrompt({ products, aliases, rawNames, firstRun });
  let lastError = null;

  for (const model of NORMALIZATION_MODEL_CANDIDATES) {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 8192,
          },
        }),
      }
    );

    const bodyText = await response.text();

    if (!response.ok) {
      const isModelUnavailable = response.status === 404 && /no longer available|model|not found/i.test(bodyText);
      const isRateLimited = response.status === 429;
      if (isModelUnavailable || isRateLimited) {
        const reason = isRateLimited ? 'rate-limited' : 'unavailable';
        lastError = new Error(`Gemini model ${reason} (${model}): ${bodyText.slice(0, 240)}`);
        continue;
      }

      const error = new Error(`Gemini request failed: ${response.status} ${bodyText.slice(0, 240)}`);
      error.statusCode = 502;
      throw error;
    }

    let payload;
    try {
      payload = JSON.parse(bodyText || '{}');
    } catch {
      const error = new Error(`Gemini returned non-JSON response (${model}): ${String(bodyText || '').slice(0, 240)}`);
      error.statusCode = 502;
      throw error;
    }

    const rawText = String(
      payload?.candidates?.[0]?.content?.parts?.map(part => part?.text || '').join('\n')
      || ''
    ).trim();
    const sqlText = cleanSqlResponse(rawText);

    return { sqlText, rawText, model };
  }

  const fallbackError = lastError || new Error('Gemini request failed: no usable models were available');
  fallbackError.statusCode = 502;
  throw fallbackError;
}

async function runNormalization({ trigger = 'manual' } = {}) {
  const logs = [];
  const appendLog = (message) => {
    logs.push({ ts: new Date().toISOString(), message: String(message || '') });
  };

  const startedAt = new Date().toISOString();
  appendLog("Data loading started");

  const [normTimestampResult, productsResult, aliasesResult] = await Promise.all([
    getLastNormalizationTimestamp(),
    supabase
      .from('products')
      .select('id, name_uz, name_ru, name_en, category, unit, search_text')
      .order('name_uz', { ascending: true }),
    supabase
      .from('product_aliases')
      .select('alias_text, product_id'),
  ]);

  if (productsResult.error) throw productsResult.error;
  if (aliasesResult.error) throw aliasesResult.error;

  const { timestamp: lastNormalizedAt, tableExists: normRunsTableExists } = normTimestampResult;
  const products = productsResult.data || [];
  const aliases = aliasesResult.data || [];
  const firstRun = !lastNormalizedAt;

  appendLog(`Loaded products: ${products.length}`);
  appendLog(`Loaded aliases: ${aliases.length}`);
  if (!normRunsTableExists) {
    appendLog('SETUP NEEDED: normalization_runs table is missing. Run docs/supabase-normalization.sql in Supabase SQL Editor to enable run history and incremental mode.');
  }
  appendLog(firstRun ? 'First normalization run detected' : `Using prices approved since ${lastNormalizedAt}`);

  const approvedRows = await fetchAllPages((from, to) => {
    let query = supabase
      .from('prices')
      .select('product_name_raw, place_name, created_at')
      .neq('source', 'website_scrape')
      .not('product_name_raw', 'is', null)
      .order('created_at', { ascending: false })
      .range(from, to);

    if (!firstRun && lastNormalizedAt) {
      query = query.gte('created_at', lastNormalizedAt);
    }

    return query;
  });

  const rawNames = [];
  const rawNameSet = new Set();
  for (const row of approvedRows || []) {
    const normalized = String(row?.product_name_raw || '').trim();
    if (normalized.length < 2) continue;
    const key = normalized.toLowerCase();
    if (rawNameSet.has(key)) continue;
    rawNameSet.add(key);
    rawNames.push(normalized);
  }

  const aliasSet = new Set(
    (aliases || [])
      .map(item => String(item?.alias_text || '').trim().toLowerCase())
      .filter(Boolean)
  );

  const newRawNames = rawNames.filter(name => !aliasSet.has(name.toLowerCase()));
  appendLog(`Raw names found: ${rawNames.length}`);
  appendLog(`Raw names after alias filter: ${newRawNames.length}`);

  if (newRawNames.length === 0) {
    await recordNormalizationRun({
      trigger,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      status: 'success',
      raw_name_count: rawNames.length,
      new_raw_name_count: 0,
      sql_success_count: 0,
      sql_error_count: 0,
      notes: 'No new raw names after alias filtering',
    });

    appendLog('No new names to normalize');
    return {
      logs,
      firstRun,
      lastNormalizedAt,
      rawNameCount: rawNames.length,
      newRawNameCount: 0,
      processedRawNameCount: 0,
      remainingRawNameCount: 0,
      hasMore: false,
      sqlSuccessCount: 0,
      sqlErrorCount: 0,
      rpcAvailable: true,
      manualSql: '',
    };
  }

  const namesForThisRun = newRawNames.slice(0, NORMALIZATION_MAX_NAMES_PER_RUN);
  const remainingRawNameCount = Math.max(0, newRawNames.length - namesForThisRun.length);

  if (remainingRawNameCount > 0) {
    appendLog(`Large queue detected. Processing ${namesForThisRun.length} names now, ${remainingRawNameCount} left for next pass.`);
  }

  const batches = namesForThisRun.length > 150
    ? chunkArray(namesForThisRun, NORMALIZATION_BATCH_SIZE)
    : [namesForThisRun];

  const generatedSqlBlocks = [];
  let modelErrorCount = 0;
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    appendLog(`Sending batch ${index + 1}/${batches.length} to Gemini (${batch.length} names)`);
    const { sqlText, rawText, model } = await runGeminiNormalizationBatch({
      products,
      aliases,
      rawNames: batch,
      firstRun,
    });
    appendLog(`Gemini model used: ${model}`);

    if (!containsSqlDml(sqlText)) {
      modelErrorCount += 1;
      appendLog(`Gemini returned non-SQL content for batch ${index + 1}`);
      appendLog(`Gemini raw response: ${rawText.slice(0, 1200)}`);
      continue;
    }

    generatedSqlBlocks.push(sqlText);
  }

  if (generatedSqlBlocks.length === 0) {
    const finishedAt = new Date().toISOString();
    await recordNormalizationRun({
      trigger,
      started_at: startedAt,
      finished_at: finishedAt,
      status: 'partial',
      raw_name_count: rawNames.length,
      new_raw_name_count: namesForThisRun.length,
      sql_success_count: 0,
      sql_error_count: modelErrorCount || 1,
      notes: 'Gemini did not produce executable SQL',
    });

    appendLog('Normalization stopped: no executable SQL returned');
    return {
      logs,
      firstRun,
      lastNormalizedAt,
      rawNameCount: rawNames.length,
      newRawNameCount: newRawNames.length,
      processedRawNameCount: namesForThisRun.length,
      remainingRawNameCount,
      hasMore: remainingRawNameCount > 0,
      sqlSuccessCount: 0,
      sqlErrorCount: modelErrorCount || 1,
      rpcAvailable: true,
      manualSql: '',
    };
  }

  const mergedSql = sanitizeSqlApostrophes(generatedSqlBlocks.join('\n\n'));
  const refreshSearchSql = "UPDATE products SET search_text = TRIM(CONCAT(COALESCE(name_uz,''), ' ', COALESCE(name_ru,''), ' ', COALESCE(name_en,''))) WHERE search_text IS NULL OR search_text = '' OR search_text != TRIM(CONCAT(COALESCE(name_uz,''), ' ', COALESCE(name_ru,''), ' ', COALESCE(name_en,'')));";

  let rpcAvailable = true;
  let sqlSuccessCount = 0;
  let sqlErrorCount = modelErrorCount;
  let manualSql = '';

  appendLog('Executing generated SQL');

  rpcAvailable = await isExecSqlAvailable();
  if (!rpcAvailable) {
    manualSql = `${mergedSql}\n\n${refreshSearchSql}`;
    appendLog('exec_sql RPC is unavailable; SQL returned for manual execution');
  } else {
    const statements = splitSqlStatements(mergedSql);
    for (const statement of statements) {
      const sql = statement.endsWith(';') ? statement : `${statement};`;
      const { error } = await supabase.rpc('exec_sql', { sql });
      if (error) {
        sqlErrorCount += 1;
        appendLog(`SQL error: ${String(error.message || '').slice(0, 160)}`);
      } else {
        sqlSuccessCount += 1;
      }
    }

    const { error: refreshError } = await supabase.rpc('exec_sql', { sql: refreshSearchSql });
    if (refreshError) {
      sqlErrorCount += 1;
      appendLog(`search_text refresh failed: ${String(refreshError.message || '').slice(0, 160)}`);
    } else {
      sqlSuccessCount += 1;
      appendLog('search_text refreshed');
    }
  }

  const hasMore = remainingRawNameCount > 0;
  const status = (sqlErrorCount > 0 || hasMore) ? 'partial' : 'success';
  const finishedAt = new Date().toISOString();
  const notes = !rpcAvailable
    ? 'exec_sql unavailable; manual SQL generated'
    : (hasMore ? `Continuation required; ${remainingRawNameCount} names left` : null);
  await recordNormalizationRun({
    trigger,
    started_at: startedAt,
    finished_at: finishedAt,
    status,
    raw_name_count: rawNames.length,
    new_raw_name_count: namesForThisRun.length,
    sql_success_count: sqlSuccessCount,
    sql_error_count: sqlErrorCount,
    notes,
  });

  appendLog(`Normalization completed: ${sqlSuccessCount} SQL ok, ${sqlErrorCount} SQL errors`);
  if (hasMore) {
    appendLog(`Continuation needed: ${remainingRawNameCount} names are still pending normalization`);
  }

  return {
    logs,
    firstRun,
    lastNormalizedAt,
    rawNameCount: rawNames.length,
    newRawNameCount: newRawNames.length,
    processedRawNameCount: namesForThisRun.length,
    remainingRawNameCount,
    hasMore,
    sqlSuccessCount,
    sqlErrorCount,
    rpcAvailable,
    manualSql,
  };
}

function buildProductSearchText(productLike) {
  return [productLike?.name_uz, productLike?.name_ru, productLike?.name_en]
    .filter(Boolean)
    .join(' ')
    .trim();
}

async function syncProductSearchText(productId) {
  if (!productId) return;

  const { data: product, error: productError } = await supabase
    .from('products')
    .select('name_uz,name_ru,name_en')
    .eq('id', productId)
    .maybeSingle();

  if (productError || !product) return;

  const searchText = buildProductSearchText(product);
  await supabase.from('products').update({ search_text: searchText }).eq('id', productId);
}

async function upsertProductAlias(productId, aliasText, storeName = null) {
  const normalizedAlias = String(aliasText || '').trim();
  if (!productId || !normalizedAlias) return;

  const language = detectAliasLanguage(normalizedAlias);
  const normalizedStore = storeName ? String(storeName).trim() : null;

  const { data: existing, error: existingError } = await supabase
    .from('product_aliases')
    .select('id,times_seen,store_name')
    .eq('product_id', productId)
    .ilike('alias_text', normalizedAlias)
    .limit(1)
    .maybeSingle();

  if (existingError) return;

  if (existing?.id) {
    const nextPayload = {
      times_seen: (Number(existing.times_seen) || 1) + 1,
      language,
    };

    if (!normalizeMaybeText(existing.store_name) && normalizedStore) {
      nextPayload.store_name = normalizedStore;
    }

    await supabase
      .from('product_aliases')
      .update(nextPayload)
      .eq('id', existing.id);
    return;
  }

  await supabase.from('product_aliases').insert({
    product_id: productId,
    alias_text: normalizedAlias,
    language,
    store_name: normalizedStore,
    times_seen: 1,
  });
}

async function syncProductAvailableCities(productId, city) {
  const normalizedCity = normalizeCityName(city || '');
  if (!productId || !normalizedCity) return;

  const { data: product, error: fetchError } = await supabase
    .from('products')
    .select('available_cities')
    .eq('id', productId)
    .maybeSingle();

  if (fetchError) throw fetchError;

  const availableCities = Array.isArray(product?.available_cities)
    ? product.available_cities.filter(Boolean)
    : [];

  if (availableCities.includes(normalizedCity)) return;

  const { error: updateError } = await supabase
    .from('products')
    .update({ available_cities: [...availableCities, normalizedCity] })
    .eq('id', productId);

  if (updateError) throw updateError;
}

async function ensureProductForName(rawName, city) {
  const normalizedName = String(rawName || '').trim();
  if (!normalizedName) return null;

  const { data: existingProduct } = await supabase
    .from('products')
    .select('id')
    .eq('name_uz', normalizedName)
    .maybeSingle();

  if (existingProduct?.id) {
    await syncProductAvailableCities(existingProduct.id, city);
    return existingProduct.id;
  }

  const { data: created, error: createError } = await supabase
    .from('products')
    .insert({
      name_uz: normalizedName,
      name_ru: normalizedName,
      name_en: normalizedName,
      search_text: normalizedName,
      category: 'Boshqa',
      unit: 'dona',
      available_cities: city ? [city] : [],
    })
    .select('id')
    .single();

  if (createError) throw createError;
  return created?.id || null;
}

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

function registerProductNameKey(map, productId, rawName) {
  const key = normalizeProductNameKey(rawName);
  if (!productId || !key) return;

  if (!map.has(key)) {
    map.set(key, new Set());
  }
  map.get(key).add(productId);
}

async function buildProductNameIndex() {
  const [products, aliases] = await Promise.all([
    fetchAllPages((from, to) => (
      supabase
        .from('products')
        .select('id,name_uz,name_ru,name_en,category,unit')
        .order('name_uz', { ascending: true })
        .range(from, to)
    )),
    fetchAllPages((from, to) => (
      supabase
        .from('product_aliases')
        .select('product_id,alias_text')
        .range(from, to)
    )),
  ]);

  const keyToProductIds = new Map();
  const productById = new Map();

  for (const product of products || []) {
    if (!product?.id) continue;
    productById.set(product.id, product);
    registerProductNameKey(keyToProductIds, product.id, product.name_uz);
    registerProductNameKey(keyToProductIds, product.id, product.name_ru);
    registerProductNameKey(keyToProductIds, product.id, product.name_en);
  }

  for (const alias of aliases || []) {
    registerProductNameKey(keyToProductIds, alias?.product_id, alias?.alias_text);
  }

  return { keyToProductIds, productById };
}

function getNormalizationEntryNameKeys(entry) {
  const keys = new Set();
  const push = (value) => {
    const key = normalizeProductNameKey(value);
    if (key) keys.add(key);
  };

  const canonical = entry?.canonical && typeof entry.canonical === 'object'
    ? entry.canonical
    : {};

  push(canonical?.name_uz);
  push(canonical?.name_ru);
  push(canonical?.name_en);

  const names = Array.isArray(entry?.names) ? entry.names : [];
  for (const alias of names) {
    push(alias?.alias_text);
  }

  const originalNames = Array.isArray(entry?.original_names) ? entry.original_names : [];
  for (const originalName of originalNames) {
    push(originalName);
  }

  return [...keys];
}

function resolveEntryProductIdFromIndex(entry, keyToProductIds) {
  const matchingProductIds = new Set();
  const keys = getNormalizationEntryNameKeys(entry);

  for (const key of keys) {
    const productIds = keyToProductIds.get(key) || new Set();
    for (const productId of productIds) {
      matchingProductIds.add(productId);
    }
  }

  if (matchingProductIds.size === 1) {
    return [...matchingProductIds][0];
  }

  return null;
}

function buildNormalizationQueueProducts(items, options = {}) {
  const keyToProductIds = options?.keyToProductIds instanceof Map ? options.keyToProductIds : new Map();
  const productById = options?.productById instanceof Map ? options.productById : new Map();
  const grouped = new Map();

  for (const item of items || []) {
    const rawName = String(item?.product_name_raw || '').trim();
    if (!rawName) continue;

    const key = normalizeProductNameKey(rawName);
    if (!key) continue;

    if (!grouped.has(key)) {
      const matchedProductIds = Array.from(keyToProductIds.get(key) || []);
      const uniqueMatchedProductId = matchedProductIds.length === 1 ? matchedProductIds[0] : null;
      const matchedProduct = uniqueMatchedProductId ? productById.get(uniqueMatchedProductId) : null;
      const normalizationState = uniqueMatchedProductId
        ? 'normalized'
        : (matchedProductIds.length > 1 ? 'ambiguous' : 'none');

      grouped.set(key, {
        product_id: uniqueMatchedProductId || buildLimboProductId(rawName),
        canonical: {
          name_uz: normalizeMaybeText(matchedProduct?.name_uz) || rawName,
          name_ru: normalizeMaybeText(matchedProduct?.name_ru) || rawName,
          name_en: normalizeMaybeText(matchedProduct?.name_en) || rawName,
        },
        category: normalizeMaybeText(matchedProduct?.category) || 'Boshqa',
        unit: normalizeMaybeText(matchedProduct?.unit) || 'dona',
        names: [],
        original_names: [],
        normalized_in_db: normalizationState === 'normalized',
        normalization_state: normalizationState,
        matched_product_id: uniqueMatchedProductId,
        matched_product_name: normalizeMaybeText(matchedProduct?.name_uz),
      });
    }

    const row = grouped.get(key);

    if (!row.original_names.some(name => normalizeAliasKey(name) === normalizeAliasKey(rawName))) {
      row.original_names.push(rawName);
    }

    const storeName = normalizeMaybeText(item?.place_name);
    const aliasExists = row.names.some(alias => (
      normalizeProductNameKey(alias.alias_text) === key
      && normalizeAliasKey(alias.store_name || '') === normalizeAliasKey(storeName || '')
    ));

    if (!aliasExists) {
      row.names.push({
        alias_text: rawName,
        language: detectAliasLanguage(rawName),
        store_name: storeName,
      });
    }
  }

  return [...grouped.values()].sort((left, right) => String(left?.canonical?.name_uz || '').localeCompare(String(right?.canonical?.name_uz || '')));
}

async function resolveNormalizedEntryProduct(entry, preferredProductId = null) {
  const canonical = entry?.canonical && typeof entry.canonical === 'object'
    ? entry.canonical
    : {};

  const firstAlias = Array.isArray(entry?.names)
    ? entry.names.find(alias => String(alias?.alias_text || '').trim())
    : null;

  const nameUz = normalizeMaybeText(canonical.name_uz)
    || normalizeMaybeText(canonical.name_ru)
    || normalizeMaybeText(canonical.name_en)
    || normalizeMaybeText(firstAlias?.alias_text)
    || 'UNKNOWN_PRODUCT';
  const nameRu = normalizeMaybeText(canonical.name_ru) || nameUz;
  const nameEn = normalizeMaybeText(canonical.name_en) || nameUz;
  const category = normalizeMaybeText(entry?.category) || 'Boshqa';
  const unit = normalizeMaybeText(entry?.unit) || 'dona';
  const searchText = `${nameUz} ${nameRu} ${nameEn}`.trim();

  const updates = {
    name_uz: nameUz,
    name_ru: nameRu,
    name_en: nameEn,
    category,
    unit,
    search_text: searchText,
  };

  const preferredId = String(preferredProductId || '').trim();
  if (preferredId && !preferredId.startsWith(LIMBO_EXPORT_PREFIX)) {
    const { data: preferredExisting, error: preferredExistingError } = await supabase
      .from('products')
      .select('id')
      .eq('id', preferredId)
      .maybeSingle();

    if (preferredExistingError) throw preferredExistingError;

    if (preferredExisting?.id) {
      const { error: updateError } = await supabase
        .from('products')
        .update(updates)
        .eq('id', preferredExisting.id);
      if (updateError) throw updateError;
      return { productId: preferredExisting.id, created: false, updated: true, canonical: updates };
    }
  }

  const requestedProductId = String(entry?.product_id || '').trim();

  if (requestedProductId && !requestedProductId.startsWith(LIMBO_EXPORT_PREFIX)) {
    const { data: existingById, error: existingByIdError } = await supabase
      .from('products')
      .select('id')
      .eq('id', requestedProductId)
      .maybeSingle();

    if (existingByIdError) throw existingByIdError;

    if (existingById?.id) {
      const { error: updateError } = await supabase
        .from('products')
        .update(updates)
        .eq('id', existingById.id);
      if (updateError) throw updateError;
      return { productId: existingById.id, created: false, updated: true, canonical: updates };
    }
  }

  const { data: existingByName, error: existingByNameError } = await supabase
    .from('products')
    .select('id')
    .ilike('name_uz', nameUz)
    .limit(1)
    .maybeSingle();
  if (existingByNameError) throw existingByNameError;

  if (existingByName?.id) {
    const { error: updateError } = await supabase
      .from('products')
      .update(updates)
      .eq('id', existingByName.id);
    if (updateError) throw updateError;
    return { productId: existingByName.id, created: false, updated: true, canonical: updates };
  }

  const { data: created, error: createError } = await supabase
    .from('products')
    .insert({
      ...updates,
      available_cities: [],
    })
    .select('id')
    .single();
  if (createError) throw createError;

  return { productId: created?.id || null, created: true, updated: false, canonical: updates };
}

async function insertApprovedPriceRow({ pending, productId, context }) {
  const source = String(context?.source || pending?.source || '');
  const isStoreApiSource = Boolean(context?.isStoreApiSource) || source.startsWith('store_api_');
  const unitPrice = Number(pending?.unit_price) > 0
    ? Math.round(Number(pending.unit_price))
    : Math.round(Number(pending?.price || 0));
  const quantity = Number(pending?.quantity) > 0 ? Number(pending.quantity) : 1;

  const placeName = normalizeMaybeText(context?.placeName);
  const placeAddress = normalizeMaybeText(context?.placeAddress) || placeName;
  const city = normalizeCityName(context?.city || '') || 'Tashkent';

  const pricePayload = {
    product_id: productId,
    product_name_raw: pending?.product_name_raw,
    price: unitPrice,
    quantity,
    city,
    place_name: placeName,
    place_address: placeAddress,
    latitude: context?.latitude ?? null,
    longitude: context?.longitude ?? null,
    receipt_date: context?.receiptDate || pending?.receipt_date || new Date().toISOString(),
    submitted_by: pending?.submitted_by || 'admin',
    source,
  };

  if (isStoreApiSource) {
    const normalizedPlaceName = normalizeMaybeText(placeName);
    const normalizedPlaceAddress = normalizeMaybeText(placeAddress);

    const { data: currentStoreRows, error: currentStoreRowsError } = await supabase
      .from('prices')
      .select('id,place_name,place_address')
      .eq('product_id', productId)
      .eq('city', city)
      .eq('source', source);
    if (currentStoreRowsError) throw currentStoreRowsError;

    const rowsToArchive = (currentStoreRows || [])
      .filter(row => (
        normalizeMaybeText(row.place_name) === normalizedPlaceName
        && normalizeMaybeText(row.place_address) === normalizedPlaceAddress
      ))
      .map(row => row.id);

    if (rowsToArchive.length > 0) {
      const { error: archiveError } = await supabase
        .from('prices')
        .update({ source: `history_${source}` })
        .in('id', rowsToArchive);
      if (archiveError) throw archiveError;
    }

    const { error: insertError } = await supabase.from('prices').insert(pricePayload);
    if (insertError) throw insertError;
    return;
  }

  const { data: existingExactPrice, error: findExistingError } = await supabase
    .from('prices')
    .select('id')
    .eq('product_id', productId)
    .eq('city', city)
    .eq('place_name', placeName)
    .eq('place_address', placeAddress)
    .eq('price', unitPrice)
    .eq('receipt_date', pending?.receipt_date || null)
    .limit(1)
    .maybeSingle();

  if (findExistingError) throw findExistingError;

  if (!existingExactPrice?.id) {
    const { error: insertError } = await supabase.from('prices').insert(pricePayload);
    if (insertError) throw insertError;
  }

  await syncProductAvailableCities(productId, city);
  await upsertProductAlias(productId, pending?.product_name_raw, placeName || null);
}

async function exportNormalizationQueue({ onlyNonNormalized = false } = {}) {
  const limboItems = await fetchAllPages((from, to) => (
    supabase
      .from('pending_prices')
      .select('id,product_name_raw,place_name,status,created_at')
      .eq('status', LIMBO_APPROVED_STATUS)
      .order('created_at', { ascending: true })
      .range(from, to)
  ));

  const { keyToProductIds, productById } = await buildProductNameIndex();
  const products = buildNormalizationQueueProducts(limboItems, { keyToProductIds, productById });
  const normalizedInDbCount = products.filter(item => item?.normalized_in_db === true).length;
  const nonNormalizedCount = products.length - normalizedInDbCount;
  const ambiguousCount = products.filter(item => item?.normalization_state === 'ambiguous').length;
  const exportedProducts = onlyNonNormalized
    ? products.filter(item => item?.normalized_in_db !== true)
    : products;

  return {
    products: exportedProducts,
    limboItemCount: limboItems.length,
    groupedProductCount: products.length,
    exportedProductCount: exportedProducts.length,
    normalizedInDbCount,
    nonNormalizedCount,
    ambiguousCount,
  };
}

async function importNormalizationQueue(productsInput) {
  const normalizedProducts = Array.isArray(productsInput) ? productsInput : [];
  if (normalizedProducts.length === 0) {
    const invalid = new Error('products array is required');
    invalid.statusCode = 400;
    throw invalid;
  }

  const limboItems = await fetchAllPages((from, to) => (
    supabase
      .from('pending_prices')
      .select('*')
      .eq('status', LIMBO_APPROVED_STATUS)
      .order('created_at', { ascending: true })
      .range(from, to)
  ));

  if (limboItems.length === 0) {
    return {
      importedCount: 0,
      remainingLimboCount: 0,
      createdProducts: 0,
      updatedProducts: 0,
      aliasesProcessed: 0,
      unmatchedCount: 0,
      failedCount: 0,
      unmatchedSamples: [],
      failedSamples: [],
    };
  }

  const { keyToProductIds } = await buildProductNameIndex();
  const registerKnownProductName = (productId, rawName) => {
    registerProductNameKey(keyToProductIds, productId, rawName);
  };

  const aliasToProductId = new Map();
  const ambiguousAliasKeys = new Set();

  for (const [key, productIdsSet] of keyToProductIds.entries()) {
    const productIds = Array.from(productIdsSet || []);
    if (productIds.length === 1) {
      aliasToProductId.set(key, productIds[0]);
    } else if (productIds.length > 1) {
      ambiguousAliasKeys.add(key);
    }
  }

  const assignAliasToProduct = (rawKey, productId) => {
    const key = normalizeProductNameKey(rawKey);
    if (!key || !productId || ambiguousAliasKeys.has(key)) return;

    const existing = aliasToProductId.get(key);
    if (!existing) {
      aliasToProductId.set(key, productId);
      return;
    }

    if (existing !== productId) {
      aliasToProductId.delete(key);
      ambiguousAliasKeys.add(key);
    }
  };
  let createdProducts = 0;
  let updatedProducts = 0;
  let aliasesProcessed = 0;

  for (const entry of normalizedProducts) {
    const preferredProductId = resolveEntryProductIdFromIndex(entry, keyToProductIds);
    const resolved = await resolveNormalizedEntryProduct(entry, preferredProductId);
    if (!resolved?.productId) continue;

    if (resolved.created) createdProducts += 1;
    if (resolved.updated) updatedProducts += 1;

    const canonicalCandidates = [
      resolved.canonical?.name_uz,
      resolved.canonical?.name_ru,
      resolved.canonical?.name_en,
    ];

    for (const canonicalName of canonicalCandidates) {
      assignAliasToProduct(canonicalName, resolved.productId);
      registerKnownProductName(resolved.productId, canonicalName);
    }

    const names = [
      ...(Array.isArray(entry?.names) ? entry.names : []),
      ...((Array.isArray(entry?.original_names) ? entry.original_names : []).map((aliasText) => ({
        alias_text: aliasText,
        language: detectAliasLanguage(aliasText),
        store_name: null,
      }))),
    ];
    const seenAliasRows = new Set();

    for (const alias of names) {
      const aliasText = String(alias?.alias_text || '').trim();
      if (!aliasText) continue;
      const storeName = normalizeMaybeText(alias?.store_name);
      const dedupeKey = normalizeProductNameKey(aliasText);
      if (seenAliasRows.has(dedupeKey)) continue;
      seenAliasRows.add(dedupeKey);

      await upsertProductAlias(resolved.productId, aliasText, storeName);
      aliasesProcessed += 1;

      assignAliasToProduct(aliasText, resolved.productId);
      registerKnownProductName(resolved.productId, aliasText);
    }
  }

  const receiptCache = new Map();
  const unmatchedSamples = [];
  const failedSamples = [];
  let unmatchedCount = 0;
  let failedCount = 0;
  let importedCount = 0;

  for (const pending of limboItems) {
    const rawNameKey = normalizeProductNameKey(pending?.product_name_raw);
    const productId = aliasToProductId.get(rawNameKey);

    if (!productId) {
      unmatchedCount += 1;
      if (unmatchedSamples.length < 20) {
        unmatchedSamples.push(String(pending?.product_name_raw || pending?.id || 'UNKNOWN'));
      }
      continue;
    }

    try {
      const context = await resolvePendingStoreContext(pending, receiptCache);
      await insertApprovedPriceRow({ pending, productId, context });

      const { error: updateError } = await supabase
        .from('pending_prices')
        .update({
          status: LIMBO_IMPORTED_STATUS,
          product_id: productId,
          city: context.city,
          place_name: context.placeName,
          place_address: context.placeAddress,
          latitude: context.latitude,
          longitude: context.longitude,
          receipt_date: context.receiptDate || pending?.receipt_date || null,
        })
        .eq('id', pending.id);

      if (updateError) throw updateError;
      importedCount += 1;
    } catch (error) {
      failedCount += 1;
      if (failedSamples.length < 20) {
        failedSamples.push({
          id: pending?.id,
          error: String(error?.message || 'UNKNOWN_IMPORT_ERROR').slice(0, 160),
        });
      }
    }
  }

  return {
    importedCount,
    remainingLimboCount: limboItems.length - importedCount,
    createdProducts,
    updatedProducts,
    aliasesProcessed,
    ambiguousAliasCount: ambiguousAliasKeys.size,
    unmatchedCount,
    failedCount,
    unmatchedSamples,
    failedSamples,
  };
}

async function listPending(city) {
  const normalizedCity = normalizeCityName(city || '');
  const items = await fetchAllPages((from, to) => {
    let query = supabase
      .from('pending_prices')
      .select('*')
      .or('status.eq.pending,status.is.null')
      .order('created_at', { ascending: true })
      .range(from, to);

    if (normalizedCity) {
      query = query.eq('city', normalizedCity);
    }
    return query;
  });

  const healedItems = [];

  for (const item of items) {
    const isUnparsed = String(item?.source || '').startsWith('soliq_qr_unparsed');
    const safeName = String(item?.product_name_raw || '').trim() || (isUnparsed ? 'RECEIPT_PARSE_REVIEW' : 'UNKNOWN_PRODUCT');
    const safePrice = Number(item?.price) > 0 ? Math.round(Number(item.price)) : (isUnparsed ? 1 : 0);
    const safeQty = Number(item?.quantity) > 0 ? Number(item.quantity) : 1;
    const safeUnit = Number(item?.unit_price) > 0 ? Math.round(Number(item.unit_price)) : (safePrice > 0 ? safePrice : Math.round(safePrice / safeQty));
    const confidence = Number(item?.match_confidence || 0);
    const shouldDetachLowConfidence = Boolean(item?.product_id) && confidence < STORE_API_MATCH_MIN_SCORE;

    const needsHeal = (
      safeName !== String(item?.product_name_raw || '')
      || safePrice !== Number(item?.price || 0)
      || safeQty !== Number(item?.quantity || 0)
      || safeUnit !== Number(item?.unit_price || 0)
      || shouldDetachLowConfidence
    );

    if (needsHeal && item?.id) {
      const patch = {
        product_name_raw: safeName,
        price: safePrice,
        quantity: safeQty,
        unit_price: safeUnit,
      };
      if (shouldDetachLowConfidence) {
        patch.product_id = null;
      }

      const { error: healError } = await supabase
        .from('pending_prices')
        .update(patch)
        .eq('id', item.id);
      if (healError) throw healError;
    }

    healedItems.push({
      ...item,
      product_name_raw: safeName,
      price: safePrice,
      quantity: safeQty,
      unit_price: safeUnit,
      product_id: shouldDetachLowConfidence ? null : item?.product_id,
    });
  }

  return healedItems;
}

async function listApproved(city) {
  const normalizedCity = normalizeCityName(city || '');
  const items = await fetchAllPages((from, to) => {
    let query = supabase
      .from('prices')
      .select('*')
      .not('source', 'like', 'history_%')
      .order('receipt_date', { ascending: false })
      .range(from, to);

    if (normalizedCity) {
      query = query.eq('city', normalizedCity);
    }
    return query;
  });

  return items;
}

async function createApproved(payload) {
  const city = normalizeCityName(payload.city || '') || extractCityFromAddress(payload.place_address || '') || 'Tashkent';
  const price = Number(payload.price);
  const quantity = Number(payload.quantity);
  const unitPrice = Number(payload.unit_price) || (price > 0 && quantity > 0 ? Math.round(price / quantity) : price);

  if (!payload.product_name_raw || !Number.isFinite(price) || price <= 0) {
    const invalid = new Error('Invalid payload for createApproved');
    invalid.statusCode = 400;
    throw invalid;
  }

  const productId = payload.product_id || await ensureProductForName(payload.product_name_raw, city);

  const insertPayload = {
    product_id: productId,
    product_name_raw: String(payload.product_name_raw).trim(),
    price: Math.round(unitPrice),
    quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
    city,
    place_name: payload.place_name || null,
    place_address: payload.place_address || null,
    latitude: payload.latitude ?? null,
    longitude: payload.longitude ?? null,
    receipt_date: payload.receipt_date || new Date().toISOString(),
    submitted_by: payload.submitted_by || 'admin',
    source: payload.source || 'admin_manual',
  };

  const { data, error } = await supabase.from('prices').insert(insertPayload).select('*').single();
  if (error) throw error;
  await syncProductAvailableCities(productId, city);
  await upsertProductAlias(productId, insertPayload.product_name_raw, insertPayload.place_name);
  return data;
}

async function updateApproved(id, changes) {
  const { data: currentApproved, error: currentApprovedError } = await supabase
    .from('prices')
    .select('product_id, city, product_name_raw')
    .eq('id', id)
    .maybeSingle();

  if (currentApprovedError) throw currentApprovedError;

  const payload = {};

  if (typeof changes.product_name_raw === 'string' && changes.product_name_raw.trim()) {
    payload.product_name_raw = changes.product_name_raw.trim();
  }
  if (typeof changes.place_name === 'string') payload.place_name = changes.place_name;
  if (typeof changes.place_address === 'string') payload.place_address = changes.place_address;
  if (typeof changes.city === 'string') payload.city = normalizeCityName(changes.city) || changes.city;
  if (typeof changes.source === 'string') payload.source = changes.source;
  if (typeof changes.submitted_by === 'string') payload.submitted_by = changes.submitted_by;
  if (typeof changes.receipt_date === 'string' && changes.receipt_date.trim()) payload.receipt_date = changes.receipt_date;

  if (typeof changes.latitude === 'number' || changes.latitude === null) payload.latitude = changes.latitude;
  if (typeof changes.longitude === 'number' || changes.longitude === null) payload.longitude = changes.longitude;

  if (typeof changes.price === 'number' && Number.isFinite(changes.price) && changes.price > 0) {
    payload.price = Math.round(changes.price);
  }
  if (typeof changes.quantity === 'number' && Number.isFinite(changes.quantity) && changes.quantity > 0) {
    payload.quantity = changes.quantity;
  }

  const nextCity = payload.city || currentApproved?.city || 'Tashkent';
  const nextProductName = payload.product_name_raw || currentApproved?.product_name_raw;
  const resolvedProductId = currentApproved?.product_id || await ensureProductForName(nextProductName, nextCity);
  if (resolvedProductId) {
    payload.product_id = resolvedProductId;
  }

  const { data, error } = await supabase
    .from('prices')
    .update(payload)
    .eq('id', id)
    .select('*')
    .single();

  if (error) throw error;
  if (resolvedProductId) {
    await syncProductAvailableCities(resolvedProductId, nextCity);
    await upsertProductAlias(resolvedProductId, data?.product_name_raw || nextProductName, data?.place_name || null);
  }
  return data;
}

function buildKnownNameKeySet(product, aliases = []) {
  return new Set([
    normalizeProductNameKey(product?.name_uz),
    normalizeProductNameKey(product?.name_ru),
    normalizeProductNameKey(product?.name_en),
    ...(aliases || []).map(alias => normalizeProductNameKey(alias)),
  ].filter(Boolean));
}

async function listProducts() {
  await ensurePerformanceIndexes();

  const products = await fetchAllPages((from, to) => (
    supabase
      .from('products')
      .select('id,name_uz,name_ru,name_en,category,unit,available_cities')
      .order('name_uz', { ascending: true })
      .range(from, to)
  ));

  const productIds = (products || []).map(item => item.id);
  if (productIds.length === 0) return [];

  const idChunks = chunkArray(productIds, 120);
  const aliases = [];

  for (let i = 0; i < idChunks.length; i += BULK_DB_CONCURRENCY) {
    const batch = idChunks.slice(i, i + BULK_DB_CONCURRENCY);
    const batchAliases = await Promise.all(batch.map((chunkIds) => fetchAllPages((from, to) => (
      supabase
        .from('product_aliases')
        .select('product_id,alias_text')
        .in('product_id', chunkIds)
        .range(from, to)
    ))));

    for (const rows of batchAliases) {
      aliases.push(...rows);
    }
  }

  const aliasTextsByProduct = new Map();
  for (const row of aliases || []) {
    const list = aliasTextsByProduct.get(row.product_id) || [];
    list.push(row.alias_text);
    aliasTextsByProduct.set(row.product_id, list);
  }

  const knownNameKeysByProduct = new Map();
  const summaryByProduct = new Map();

  for (const product of products || []) {
    knownNameKeysByProduct.set(
      product.id,
      buildKnownNameKeySet(product, aliasTextsByProduct.get(product.id) || [])
    );

    summaryByProduct.set(product.id, {
      price_count: 0,
      pending_count: 0,
      latest_price: null,
    });
  }

  for (let i = 0; i < idChunks.length; i += BULK_DB_CONCURRENCY) {
    const batch = idChunks.slice(i, i + BULK_DB_CONCURRENCY);
    const batchRows = await Promise.all(batch.map(async (chunkIds) => {
      const [chunkPrices, chunkPending] = await Promise.all([
        fetchAllPages((from, to) => (
          supabase
            .from('prices')
            .select('product_id,product_name_raw,receipt_date')
            .not('source', 'like', 'history_%')
            .in('product_id', chunkIds)
            .order('receipt_date', { ascending: false })
            .range(from, to)
        )),
        fetchAllPages((from, to) => (
          supabase
            .from('pending_prices')
            .select('product_id,product_name_raw,match_confidence')
            .in('product_id', chunkIds)
            .or('status.eq.pending,status.is.null')
            .order('created_at', { ascending: false })
            .range(from, to)
        )),
      ]);

      return { chunkPrices, chunkPending };
    }));

    for (const { chunkPrices, chunkPending } of batchRows) {
      for (const row of chunkPrices || []) {
        const productId = row?.product_id;
        if (!productId || !summaryByProduct.has(productId)) continue;

        const knownNameKeys = knownNameKeysByProduct.get(productId) || new Set();
        if (!knownNameKeys.has(normalizeProductNameKey(row?.product_name_raw))) continue;

        const summary = summaryByProduct.get(productId);
        summary.price_count += 1;

        const currentLatest = summary.latest_price;
        if (!currentLatest || String(row?.receipt_date || '') > String(currentLatest?.receipt_date || '')) {
          summary.latest_price = row;
        }
      }

      for (const row of chunkPending || []) {
        const productId = row?.product_id;
        if (!productId || !summaryByProduct.has(productId)) continue;

        const knownNameKeys = knownNameKeysByProduct.get(productId) || new Set();
        const normalizedRaw = normalizeProductNameKey(row?.product_name_raw);
        if (!knownNameKeys.has(normalizedRaw) && Number(row?.match_confidence || 0) < STORE_API_MATCH_MIN_SCORE) {
          continue;
        }

        const summary = summaryByProduct.get(productId);
        summary.pending_count += 1;
      }
    }
  }

  return (products || []).map(product => {
    const summary = summaryByProduct.get(product.id) || {
      price_count: 0,
      pending_count: 0,
      latest_price: null,
    };

    return {
      ...product,
      prices: [],
      pending: [],
      price_count: Number(summary.price_count) || 0,
      pending_count: Number(summary.pending_count) || 0,
      latest_price: summary.latest_price || null,
      details_loaded: false,
    };
  });
}

async function getProductLinkedData(productId) {
  await ensurePerformanceIndexes();
  const normalizedProductId = normalizeRequiredProductId(productId);

  const { data: product, error: productError } = await supabase
    .from('products')
    .select('id,name_uz,name_ru,name_en')
    .eq('id', normalizedProductId)
    .maybeSingle();
  if (productError) throw productError;

  if (!product?.id) {
    return {
      prices: [],
      pending: [],
      price_count: 0,
      pending_count: 0,
      latest_price: null,
      details_loaded: true,
    };
  }

  const [aliases, pricesRows, pendingRows] = await Promise.all([
    fetchAllPages((from, to) => (
      supabase
        .from('product_aliases')
        .select('alias_text')
        .eq('product_id', normalizedProductId)
        .range(from, to)
    )),
    fetchAllPages((from, to) => (
      supabase
        .from('prices')
        .select('id,product_id,product_name_raw,price,city,place_name,place_address,receipt_date,source')
        .eq('product_id', normalizedProductId)
        .not('source', 'like', 'history_%')
        .order('receipt_date', { ascending: false })
        .range(from, to)
    )),
    fetchAllPages((from, to) => (
      supabase
        .from('pending_prices')
        .select('id,product_id,product_name_raw,status,city,created_at,match_confidence')
        .eq('product_id', normalizedProductId)
        .or('status.eq.pending,status.is.null')
        .order('created_at', { ascending: false })
        .range(from, to)
    )),
  ]);

  const aliasTexts = (aliases || []).map(row => row?.alias_text).filter(Boolean);
  const knownNameKeys = buildKnownNameKeySet(product, aliasTexts);

  const prices = (pricesRows || []).filter(row => (
    knownNameKeys.has(normalizeProductNameKey(row?.product_name_raw))
  ));

  const pending = (pendingRows || []).filter(row => {
    const normalizedRaw = normalizeProductNameKey(row?.product_name_raw);
    if (knownNameKeys.has(normalizedRaw)) return true;
    return Number(row?.match_confidence || 0) >= STORE_API_MATCH_MIN_SCORE;
  });

  return {
    prices,
    pending,
    price_count: prices.length,
    pending_count: pending.length,
    latest_price: prices[0] || null,
    details_loaded: true,
  };
}

async function createProduct(payload) {
  const nameUz = String(payload.name_uz || '').trim();
  if (!nameUz) {
    const invalid = new Error('name_uz is required');
    invalid.statusCode = 400;
    throw invalid;
  }

  const availableCities = Array.isArray(payload.available_cities)
    ? payload.available_cities.map(city => normalizeCityName(city || '')).filter(Boolean)
    : [];

  const { data, error } = await supabase
    .from('products')
    .insert({
      name_uz: nameUz,
      name_ru: String(payload.name_ru || nameUz).trim(),
      name_en: String(payload.name_en || nameUz).trim(),
      search_text: [nameUz, String(payload.name_ru || nameUz).trim(), String(payload.name_en || nameUz).trim()].join(' ').trim(),
      category: String(payload.category || 'Boshqa').trim(),
      unit: String(payload.unit || 'dona').trim(),
      available_cities: availableCities,
    })
    .select('*')
    .single();

  if (error) throw error;
  await syncProductSearchText(data?.id);
  return data;
}

async function listContactMessages() {
  try {
    const { data, error } = await supabase
      .from('contact_messages')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) throw error;
    return data || [];
  } catch (error) {
    // Backward compatibility if migration has not been applied yet.
    if (String(error?.message || '').toLowerCase().includes('contact_messages')) {
      return [];
    }
    throw error;
  }
}

function normalizeReceiptPipelineFilter(value) {
  const normalized = normalizeAliasKey(value || 'all');
  if (normalized === RECEIPT_PIPELINE_STATUS_SCANNED) return RECEIPT_PIPELINE_STATUS_SCANNED;
  if (normalized === RECEIPT_PIPELINE_STATUS_FAILED) return RECEIPT_PIPELINE_STATUS_FAILED;
  if (normalized === RECEIPT_PIPELINE_STATUS_UNSCANNED) return RECEIPT_PIPELINE_STATUS_UNSCANNED;
  return 'all';
}

function mapReceiptQueueStatusToPipeline(queueStatus, errorMessage = null) {
  const normalized = normalizeAliasKey(queueStatus || '');
  const hasError = Boolean(normalizeMaybeText(errorMessage));

  if (normalized === 'processed' || normalized === 'done' || normalized === 'completed' || normalized === 'scanned') {
    return RECEIPT_PIPELINE_STATUS_SCANNED;
  }

  if (normalized === 'failed' || normalized === 'error' || hasError) {
    return RECEIPT_PIPELINE_STATUS_FAILED;
  }

  return RECEIPT_PIPELINE_STATUS_UNSCANNED;
}

function mapPipelineStatusToReceiptQueueStatus(pipelineStatus) {
  const normalized = normalizeReceiptPipelineFilter(pipelineStatus);
  if (normalized === RECEIPT_PIPELINE_STATUS_SCANNED) return 'processed';
  if (normalized === RECEIPT_PIPELINE_STATUS_FAILED) return 'failed';
  return 'pending';
}

async function listReceiptLinks(statusFilter = 'all') {
  const rows = await fetchAllPages((from, to) => (
    supabase
      .from('receipt_queue')
      .select('id,receipt_url,telegram_id,city,status,error_message,created_at,processed_at')
      .order('created_at', { ascending: false })
      .range(from, to)
  ));

  const normalizedFilter = normalizeReceiptPipelineFilter(statusFilter);

  return (rows || [])
    .map((row) => {
      const pipelineStatus = mapReceiptQueueStatusToPipeline(row?.status, row?.error_message);
      return {
        ...row,
        pipeline_status: pipelineStatus,
      };
    })
    .filter((row) => normalizedFilter === 'all' || row.pipeline_status === normalizedFilter);
}

async function updateReceiptLinksStatus(ids, status) {
  const targetIds = Array.isArray(ids) ? ids.map(id => String(id || '').trim()).filter(Boolean) : [];
  if (targetIds.length === 0) return { updatedCount: 0 };

  const normalizedStatus = normalizeReceiptPipelineFilter(status);
  if (normalizedStatus === 'all') {
    const invalid = new Error('status must be one of: scanned, failed, unscanned');
    invalid.statusCode = 400;
    throw invalid;
  }

  const dbStatus = mapPipelineStatusToReceiptQueueStatus(normalizedStatus);
  const payload = {
    status: dbStatus,
  };

  if (normalizedStatus === RECEIPT_PIPELINE_STATUS_UNSCANNED) {
    payload.error_message = null;
    payload.processed_at = null;
  } else if (normalizedStatus === RECEIPT_PIPELINE_STATUS_SCANNED) {
    payload.processed_at = new Date().toISOString();
  } else {
    payload.processed_at = null;
  }

  const { data, error } = await supabase
    .from('receipt_queue')
    .update(payload)
    .in('id', targetIds)
    .select('id');

  if (error) throw error;

  return {
    updatedCount: Array.isArray(data) ? data.length : 0,
    status: normalizedStatus,
  };
}

async function deleteReceiptLinks(ids) {
  const targetIds = Array.isArray(ids) ? ids.map(id => String(id || '').trim()).filter(Boolean) : [];
  if (targetIds.length === 0) return { deletedCount: 0 };

  const { data, error } = await supabase
    .from('receipt_queue')
    .delete()
    .in('id', targetIds)
    .select('id');

  if (error) throw error;

  return {
    deletedCount: Array.isArray(data) ? data.length : 0,
  };
}

async function updateProduct(id, changes) {
  const payload = {};
  if (typeof changes.name_uz === 'string' && changes.name_uz.trim()) payload.name_uz = changes.name_uz.trim();
  if (typeof changes.name_ru === 'string' && changes.name_ru.trim()) payload.name_ru = changes.name_ru.trim();
  if (typeof changes.name_en === 'string' && changes.name_en.trim()) payload.name_en = changes.name_en.trim();
  if (typeof changes.category === 'string' && changes.category.trim()) payload.category = changes.category.trim();
  if (typeof changes.unit === 'string' && changes.unit.trim()) payload.unit = changes.unit.trim();
  if (Array.isArray(changes.available_cities)) {
    payload.available_cities = changes.available_cities
      .map(city => normalizeCityName(city || ''))
      .filter(Boolean);
  }

  const { data, error } = await supabase
    .from('products')
    .update(payload)
    .eq('id', id)
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

async function deleteProduct(id) {
  await ensurePerformanceIndexes();
  const normalizedProductId = normalizeRequiredProductId(id);

  const [pricesDelete, pendingDelete, aliasesDelete] = await Promise.all([
    supabase.from('prices').delete().eq('product_id', normalizedProductId),
    supabase.from('pending_prices').delete().eq('product_id', normalizedProductId),
    supabase.from('product_aliases').delete().eq('product_id', normalizedProductId),
  ]);

  if (pricesDelete.error) throw pricesDelete.error;
  if (pendingDelete.error) throw pendingDelete.error;
  if (aliasesDelete.error) throw aliasesDelete.error;

  // Keep historical views but detach product FK eagerly to avoid expensive FK checks.
  const { error: detachViewsError } = await supabase
    .from('product_views')
    .update({ product_id: null })
    .eq('product_id', normalizedProductId);
  if (detachViewsError && !isMissingRelationError(detachViewsError)) throw detachViewsError;

  const { data, error } = await supabase
    .from('products')
    .delete()
    .eq('id', normalizedProductId)
    .select('id');
  if (error) throw error;

  const deletedCount = Array.isArray(data) ? data.length : 0;
  if (deletedCount === 0) {
    const missing = new Error('PRODUCT_NOT_FOUND');
    missing.statusCode = 404;
    throw missing;
  }

  return { deletedCount };
}

async function deleteProductsMany(ids) {
  await ensurePerformanceIndexes();

  const targetIds = Array.from(new Set(
    Array.isArray(ids)
      ? ids.map(value => String(value || '').trim()).filter(Boolean)
      : []
  ));
  if (targetIds.length === 0) return { deletedCount: 0 };

  let deletedCount = 0;
  const chunks = chunkArray(targetIds, BULK_DB_CHUNK_SIZE);

  for (let i = 0; i < chunks.length; i += BULK_DB_CONCURRENCY) {
    const batch = chunks.slice(i, i + BULK_DB_CONCURRENCY);
    const batchDeleted = await Promise.all(batch.map(async (chunkIds) => {
      const [pricesDelete, pendingDelete, aliasesDelete, detachViews] = await Promise.all([
        supabase.from('prices').delete().in('product_id', chunkIds),
        supabase.from('pending_prices').delete().in('product_id', chunkIds),
        supabase.from('product_aliases').delete().in('product_id', chunkIds),
        supabase.from('product_views').update({ product_id: null }).in('product_id', chunkIds),
      ]);

      if (pricesDelete.error) throw pricesDelete.error;
      if (pendingDelete.error) throw pendingDelete.error;
      if (aliasesDelete.error) throw aliasesDelete.error;
      if (detachViews.error && !isMissingRelationError(detachViews.error)) throw detachViews.error;

      const { data, error } = await supabase
        .from('products')
        .delete()
        .in('id', chunkIds)
        .select('id');
      if (error) throw error;
      return Array.isArray(data) ? data.length : 0;
    }));

    deletedCount += batchDeleted.reduce((sum, value) => sum + Number(value || 0), 0);
  }

  return { deletedCount };
}

async function purgeAllProductsData() {
  await supabase.from('prices').delete().neq('id', '');
  await supabase.from('pending_prices').delete().neq('id', '');
  await supabase.from('products').delete().neq('id', '');
  return { ok: true };
}

async function updatePending(id, changes) {
  const payload = {};

  if (typeof changes.product_name_raw === 'string') {
    const normalizedName = changes.product_name_raw.trim();
    if (!normalizedName) {
      const invalidNameError = new Error('Product name cannot be empty');
      invalidNameError.statusCode = 400;
      throw invalidNameError;
    }
    payload.product_name_raw = normalizedName;
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

  const pendingStatus = normalizeAliasKey(pending.status || 'pending');
  if (pendingStatus && pendingStatus !== 'pending') {
    return { approvedCount: 0, receiptScope: 0 };
  }

  const receiptUrl = normalizeMaybeText(pending.receipt_url);
  let targets = [pending];

  if (receiptUrl) {
    const { data: receiptPendingRows, error: receiptPendingRowsError } = await supabase
      .from('pending_prices')
      .select('*')
      .eq('receipt_url', receiptUrl)
      .or('status.eq.pending,status.is.null');

    if (receiptPendingRowsError) throw receiptPendingRowsError;
    if ((receiptPendingRows || []).length > 0) {
      targets = receiptPendingRows;
    }
  }

  const receiptCache = new Map();
  let approvedCount = 0;

  for (const target of targets) {
    const status = normalizeAliasKey(target?.status || 'pending');
    if (status && status !== 'pending') continue;

    const context = await resolvePendingStoreContext(target, receiptCache);
    const { error: updateError } = await supabase
      .from('pending_prices')
      .update({
        status: LIMBO_APPROVED_STATUS,
        product_id: null,
        city: context.city,
        place_name: context.placeName,
        place_address: context.placeAddress,
        latitude: context.latitude,
        longitude: context.longitude,
        receipt_date: context.receiptDate || target?.receipt_date || null,
      })
      .eq('id', target.id);

    if (updateError) throw updateError;
    approvedCount += 1;
  }

  return {
    approvedCount,
    receiptScope: targets.length,
    movedToLimbo: approvedCount,
  };
}

async function approveMany(ids) {
  const targetIds = Array.from(new Set(Array.isArray(ids) ? ids.filter(Boolean) : []));
  if (targetIds.length === 0) return { approvedCount: 0, failedIds: [] };

  const { data: targetRows, error: targetRowsError } = await supabase
    .from('pending_prices')
    .select('id,receipt_url,status')
    .in('id', targetIds);
  if (targetRowsError) throw targetRowsError;

  const foundIds = new Set((targetRows || []).map(row => row?.id).filter(Boolean));
  const failedIds = targetIds.filter(id => !foundIds.has(id));

  const receiptUrlToPrimaryId = new Map();
  const primaryIdToIds = new Map();

  for (const row of targetRows || []) {
    const normalizedStatus = normalizeAliasKey(row?.status || 'pending');
    if (normalizedStatus && normalizedStatus !== 'pending') continue;

    const rowId = String(row?.id || '').trim();
    if (!rowId) continue;

    const receiptUrl = normalizeMaybeText(row?.receipt_url);
    if (!receiptUrl) {
      primaryIdToIds.set(rowId, [rowId]);
      continue;
    }

    if (!receiptUrlToPrimaryId.has(receiptUrl)) {
      receiptUrlToPrimaryId.set(receiptUrl, rowId);
      primaryIdToIds.set(rowId, []);
    }

    const primaryId = receiptUrlToPrimaryId.get(receiptUrl);
    const list = primaryIdToIds.get(primaryId) || [];
    list.push(rowId);
    primaryIdToIds.set(primaryId, list);
  }

  const primaryIds = [...primaryIdToIds.keys()];
  if (primaryIds.length === 0) return { approvedCount: 0, failedIds };

  let approvedCount = 0;
  const CONCURRENCY = 24;

  for (let i = 0; i < primaryIds.length; i += CONCURRENCY) {
    const chunk = primaryIds.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (primaryId) => {
        try {
          const result = await approvePending(primaryId);
          return { ok: true, primaryId, approvedCount: Number(result?.approvedCount) || 0 };
        } catch {
          return { ok: false, primaryId };
        }
      })
    );

    for (const result of results) {
      if (result.ok) {
        approvedCount += Number(result.approvedCount) || 0;
      } else {
        failedIds.push(...(primaryIdToIds.get(result.primaryId) || [result.primaryId]));
      }
    }
  }

  return { approvedCount, failedIds: [...new Set(failedIds)] };
}

async function rejectPending(id) {
  const { error } = await supabase.from('pending_prices').update({ status: 'rejected' }).eq('id', id);
  if (error) throw error;
}

async function rejectMany(ids) {
  const targetIds = Array.from(new Set(Array.isArray(ids) ? ids.filter(Boolean) : []));
  if (targetIds.length === 0) return { rejectedCount: 0 };

  let rejectedCount = 0;
  const chunks = chunkArray(targetIds, BULK_DB_CHUNK_SIZE);

  for (let i = 0; i < chunks.length; i += BULK_DB_CONCURRENCY) {
    const batch = chunks.slice(i, i + BULK_DB_CONCURRENCY);
    const batchRejected = await Promise.all(batch.map(async (chunkIds) => {
      const { data, error } = await supabase
        .from('pending_prices')
        .update({ status: 'rejected' })
        .in('id', chunkIds)
        .select('id');
      if (error) throw error;
      return Array.isArray(data) ? data.length : 0;
    }));

    rejectedCount += batchRejected.reduce((sum, value) => sum + Number(value || 0), 0);
  }

  return { rejectedCount };
}

async function deleteApproved(id) {
  const { error } = await supabase.from('prices').delete().eq('id', id);
  if (error) throw error;
}

async function deleteApprovedMany(ids) {
  const targetIds = Array.from(new Set(Array.isArray(ids) ? ids.filter(Boolean) : []));
  if (targetIds.length === 0) return { deletedCount: 0 };

  let deletedCount = 0;
  const chunks = chunkArray(targetIds, BULK_DB_CHUNK_SIZE);

  for (let i = 0; i < chunks.length; i += BULK_DB_CONCURRENCY) {
    const batch = chunks.slice(i, i + BULK_DB_CONCURRENCY);
    const batchDeleted = await Promise.all(batch.map(async (chunkIds) => {
      const { data, error } = await supabase
        .from('prices')
        .delete()
        .in('id', chunkIds)
        .select('id');
      if (error) throw error;
      return Array.isArray(data) ? data.length : 0;
    }));

    deletedCount += batchDeleted.reduce((sum, value) => sum + Number(value || 0), 0);
  }

  return { deletedCount };
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
        const items = await listPending(body.city);
        return send(res, 200, { ok: true, items });
      }
      case 'listApproved': {
        const items = await listApproved(body.city);
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
      case 'approveMany': {
        const result = await approveMany(body.ids);
        return send(res, 200, { ok: true, ...result });
      }
      case 'normalizeProducts': {
        return send(res, 400, {
          ok: false,
          error: 'NORMALIZATION_DISABLED_USE_EXPORT_IMPORT',
        });
      }
      case 'downloadNormalizationQueue': {
        const result = await exportNormalizationQueue({
          onlyNonNormalized: Boolean(body.onlyNonNormalized),
        });
        return send(res, 200, { ok: true, ...result });
      }
      case 'downloadNonNormalizedQueue': {
        const result = await exportNormalizationQueue({ onlyNonNormalized: true });
        return send(res, 200, { ok: true, ...result });
      }
      case 'importNormalizationQueue': {
        const products = Array.isArray(body.products)
          ? body.products
          : (Array.isArray(body?.payload?.products) ? body.payload.products : []);
        const result = await importNormalizationQueue(products);
        return send(res, 200, { ok: true, ...result });
      }
      case 'reject': {
        await rejectPending(body.id);
        return send(res, 200, { ok: true });
      }
      case 'rejectMany': {
        const result = await rejectMany(body.ids);
        return send(res, 200, { ok: true, ...result });
      }
      case 'deleteApproved': {
        await deleteApproved(body.id);
        return send(res, 200, { ok: true });
      }
      case 'updateApproved': {
        const item = await updateApproved(body.id, body.changes || {});
        return send(res, 200, { ok: true, item });
      }
      case 'createApproved': {
        const item = await createApproved(body.payload || {});
        return send(res, 200, { ok: true, item });
      }
      case 'deleteApprovedMany': {
        const result = await deleteApprovedMany(body.ids || []);
        return send(res, 200, { ok: true, ...result });
      }
      case 'listProducts': {
        const items = await listProducts();
        return send(res, 200, { ok: true, items });
      }
      case 'getProductLinkedData': {
        const result = await getProductLinkedData(body.id);
        return send(res, 200, { ok: true, ...result });
      }
      case 'createProduct': {
        const item = await createProduct(body.payload || {});
        return send(res, 200, { ok: true, item });
      }
      case 'updateProduct': {
        const item = await updateProduct(body.id, body.changes || {});
        return send(res, 200, { ok: true, item });
      }
      case 'deleteProduct': {
        const result = await deleteProduct(body.id);
        return send(res, 200, { ok: true, ...result });
      }
      case 'deleteProductsMany': {
        const result = await deleteProductsMany(body.ids || []);
        return send(res, 200, { ok: true, ...result });
      }
      case 'purgeAllProductsData': {
        const result = await purgeAllProductsData();
        return send(res, 200, { ok: true, ...result });
      }
      case 'listContactMessages': {
        const items = await listContactMessages();
        return send(res, 200, { ok: true, items });
      }
      case 'listReceiptLinks': {
        const items = await listReceiptLinks(body.status);
        return send(res, 200, { ok: true, items });
      }
      case 'updateReceiptLinksStatus': {
        const result = await updateReceiptLinksStatus(body.ids || [], body.status);
        return send(res, 200, { ok: true, ...result });
      }
      case 'deleteReceiptLinks': {
        const result = await deleteReceiptLinks(body.ids || []);
        return send(res, 200, { ok: true, ...result });
      }
      default:
        return send(res, 400, { ok: false, error: 'UNKNOWN_ACTION' });
    }
  } catch (error) {
    return send(res, error?.statusCode || 500, { ok: false, error: error?.message || 'UNKNOWN_ERROR' });
  }
}
