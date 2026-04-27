import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { extractCityFromAddress, normalizeCityName } from '../src/constants/cities.js';

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
const NORMALIZATION_MODEL_CANDIDATES = Array.from(new Set([
  ...(CONFIGURED_GEMINI_MODEL ? [CONFIGURED_GEMINI_MODEL] : []),
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash-lite',
]));
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

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
    if (isMissingRelationError(error)) return null;
    throw error;
  }

  return data?.finished_at || data?.started_at || data?.created_at || null;
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

    if (!response.ok) {
      const bodyText = await response.text();
      const isModelUnavailable = response.status === 404 && /no longer available|model|not found/i.test(bodyText);
      if (isModelUnavailable) {
        lastError = new Error(`Gemini model unavailable (${model}): ${bodyText.slice(0, 240)}`);
        continue;
      }

      const error = new Error(`Gemini request failed: ${response.status} ${bodyText.slice(0, 240)}`);
      error.statusCode = 502;
      throw error;
    }

    const payload = await response.json();
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

  const [lastNormalizedAt, productsResult, aliasesResult] = await Promise.all([
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

  const products = productsResult.data || [];
  const aliases = aliasesResult.data || [];
  const firstRun = !lastNormalizedAt;

  appendLog(`Loaded products: ${products.length}`);
  appendLog(`Loaded aliases: ${aliases.length}`);
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
      sqlSuccessCount: 0,
      sqlErrorCount: 0,
      rpcAvailable: true,
      manualSql: '',
    };
  }

  const batches = newRawNames.length > 150
    ? chunkArray(newRawNames, NORMALIZATION_BATCH_SIZE)
    : [newRawNames];

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
      new_raw_name_count: newRawNames.length,
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
      sqlSuccessCount: 0,
      sqlErrorCount: modelErrorCount || 1,
      rpcAvailable: true,
      manualSql: '',
    };
  }

  const mergedSql = generatedSqlBlocks.join('\n\n');
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

  const status = sqlErrorCount > 0 ? 'partial' : 'success';
  const finishedAt = new Date().toISOString();
  await recordNormalizationRun({
    trigger,
    started_at: startedAt,
    finished_at: finishedAt,
    status,
    raw_name_count: rawNames.length,
    new_raw_name_count: newRawNames.length,
    sql_success_count: sqlSuccessCount,
    sql_error_count: sqlErrorCount,
    notes: rpcAvailable ? null : 'exec_sql unavailable; manual SQL generated',
  });

  appendLog(`Normalization completed: ${sqlSuccessCount} SQL ok, ${sqlErrorCount} SQL errors`);

  return {
    logs,
    firstRun,
    lastNormalizedAt,
    rawNameCount: rawNames.length,
    newRawNameCount: newRawNames.length,
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
    .select('id,times_seen')
    .eq('product_id', productId)
    .ilike('alias_text', normalizedAlias)
    .is('store_name', normalizedStore)
    .maybeSingle();

  if (existingError) return;

  if (existing?.id) {
    await supabase
      .from('product_aliases')
      .update({ times_seen: (Number(existing.times_seen) || 1) + 1, language })
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

    const needsHeal = (
      safeName !== String(item?.product_name_raw || '')
      || safePrice !== Number(item?.price || 0)
      || safeQty !== Number(item?.quantity || 0)
      || safeUnit !== Number(item?.unit_price || 0)
    );

    if (needsHeal && item?.id) {
      const { error: healError } = await supabase
        .from('pending_prices')
        .update({
          product_name_raw: safeName,
          price: safePrice,
          quantity: safeQty,
          unit_price: safeUnit,
        })
        .eq('id', item.id);
      if (healError) throw healError;
    }

    healedItems.push({
      ...item,
      product_name_raw: safeName,
      price: safePrice,
      quantity: safeQty,
      unit_price: safeUnit,
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

async function listProducts() {
  const products = await fetchAllPages((from, to) => (
    supabase
      .from('products')
      .select('*')
      .order('name_uz', { ascending: true })
      .range(from, to)
  ));

  const productIds = (products || []).map(item => item.id);
  if (productIds.length === 0) return [];

  const idChunks = chunkArray(productIds, 120);
  const prices = [];
  const pending = [];

  for (const chunkIds of idChunks) {
    const [chunkPrices, chunkPending] = await Promise.all([
      fetchAllPages((from, to) => (
        supabase
          .from('prices')
          .select('id,product_id,product_name_raw,price,city,place_name,place_address,receipt_date,source')
          .not('source', 'like', 'history_%')
          .in('product_id', chunkIds)
          .order('receipt_date', { ascending: false })
          .range(from, to)
      )),
      fetchAllPages((from, to) => (
        supabase
          .from('pending_prices')
          .select('id,product_id,product_name_raw,status,city,created_at')
          .in('product_id', chunkIds)
          .or('status.eq.pending,status.is.null')
          .order('created_at', { ascending: false })
          .range(from, to)
      )),
    ]);

    prices.push(...chunkPrices);
    pending.push(...chunkPending);
  }

  const pricesByProduct = new Map();
  for (const row of prices || []) {
    const list = pricesByProduct.get(row.product_id) || [];
    list.push(row);
    pricesByProduct.set(row.product_id, list);
  }

  const pendingByProduct = new Map();
  for (const row of pending || []) {
    const list = pendingByProduct.get(row.product_id) || [];
    list.push(row);
    pendingByProduct.set(row.product_id, list);
  }

  return (products || []).map(product => {
    const productPrices = pricesByProduct.get(product.id) || [];
    const productPending = pendingByProduct.get(product.id) || [];
    return {
      ...product,
      prices: productPrices,
      pending: productPending,
      price_count: productPrices.length,
      pending_count: productPending.length,
      latest_price: productPrices[0] || null,
    };
  });
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
  await supabase.from('prices').delete().eq('product_id', id);
  await supabase.from('pending_prices').delete().eq('product_id', id);
  const { error } = await supabase.from('products').delete().eq('id', id);
  if (error) throw error;
}

async function deleteProductsMany(ids) {
  const targetIds = Array.isArray(ids) ? ids.filter(Boolean) : [];
  if (targetIds.length === 0) return { deletedCount: 0 };

  await supabase.from('prices').delete().in('product_id', targetIds);
  await supabase.from('pending_prices').delete().in('product_id', targetIds);
  const { error } = await supabase.from('products').delete().in('id', targetIds);
  if (error) throw error;
  return { deletedCount: targetIds.length };
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

  const source = String(pending.source || '');
  const isStoreApiSource = source.startsWith('store_api_');
  const matchConfidence = Number(pending.match_confidence || 0);
  const fallbackStoreName = isStoreApiSource
    ? source.replace('store_api_', '').replace(/_/g, ' ')
    : 'Unknown Store';
  const placeName = normalizeMaybeText(pending.place_name) || fallbackStoreName;
  const placeAddress = normalizeMaybeText(pending.place_address) || placeName;

  let productId = pending.product_id;
  const city = normalizeCityName(pending.city || '') || extractCityFromAddress(pending.place_address || '');

  if (isStoreApiSource && matchConfidence < STORE_API_MATCH_MIN_SCORE) {
    productId = null;
  }

  if (!productId) {
    const { data: existingProduct } = await supabase
      .from('products')
      .select('id')
      .eq('name_uz', pending.product_name_raw)
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
          available_cities: city ? [city] : [],
        })
        .select('id')
        .single();

      if (createError) throw createError;
      productId = created?.id || null;
    }
  }

  const unitPrice = pending.unit_price || pending.price;
  const pricePayload = {
    product_id: productId,
    product_name_raw: pending.product_name_raw,
    price: unitPrice,
    quantity: pending.quantity,
    city,
    place_name: placeName,
    place_address: placeAddress,
    latitude: pending.latitude,
    longitude: pending.longitude,
    receipt_date: pending.receipt_date,
    submitted_by: pending.submitted_by,
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
  } else {
    const { data: existingExactPrice, error: findExistingError } = await supabase
      .from('prices')
      .select('id')
      .eq('product_id', productId)
      .eq('city', city)
      .eq('place_name', placeName)
      .eq('place_address', placeAddress)
      .eq('price', unitPrice)
      .eq('receipt_date', pending.receipt_date || null)
      .limit(1)
      .maybeSingle();

    if (findExistingError) throw findExistingError;

    if (!existingExactPrice?.id) {
      const { error: insertError } = await supabase.from('prices').insert(pricePayload);
      if (insertError) throw insertError;
    }
  }

  if (!isStoreApiSource) {
    await syncProductAvailableCities(productId, city);
    await upsertProductAlias(productId, pending.product_name_raw, pending.place_name || null);
  }

  const { error: updateError } = await supabase
    .from('pending_prices')
    .update({ status: 'approved', product_id: productId, city })
    .eq('id', id);

  if (updateError) throw updateError;

  return { productId };
}

async function approveMany(ids) {
  const targetIds = Array.isArray(ids) ? ids.filter(Boolean) : [];
  let approvedCount = 0;
  const failedIds = [];

  const CONCURRENCY = 16;

  for (let i = 0; i < targetIds.length; i += CONCURRENCY) {
    const chunk = targetIds.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (id) => {
        try {
          await approvePending(id);
          return { ok: true, id };
        } catch {
          return { ok: false, id };
        }
      })
    );

    for (const result of results) {
      if (result.ok) approvedCount += 1;
      else failedIds.push(result.id);
    }
  }

  return { approvedCount, failedIds };
}

async function rejectPending(id) {
  const { error } = await supabase.from('pending_prices').update({ status: 'rejected' }).eq('id', id);
  if (error) throw error;
}

async function rejectMany(ids) {
  const targetIds = Array.isArray(ids) ? ids.filter(Boolean) : [];
  if (targetIds.length === 0) return { rejectedCount: 0 };

  const { error } = await supabase.from('pending_prices').update({ status: 'rejected' }).in('id', targetIds);
  if (error) throw error;
  return { rejectedCount: targetIds.length };
}

async function deleteApproved(id) {
  const { error } = await supabase.from('prices').delete().eq('id', id);
  if (error) throw error;
}

async function deleteApprovedMany(ids) {
  const targetIds = Array.isArray(ids) ? ids.filter(Boolean) : [];
  if (targetIds.length === 0) return { deletedCount: 0 };

  const { error } = await supabase.from('prices').delete().in('id', targetIds);
  if (error) throw error;
  return { deletedCount: targetIds.length };
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
        const trigger = body.trigger === 'auto' ? 'auto' : 'manual';
        const result = await runNormalization({ trigger });
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
      case 'createProduct': {
        const item = await createProduct(body.payload || {});
        return send(res, 200, { ok: true, item });
      }
      case 'updateProduct': {
        const item = await updateProduct(body.id, body.changes || {});
        return send(res, 200, { ok: true, item });
      }
      case 'deleteProduct': {
        await deleteProduct(body.id);
        return send(res, 200, { ok: true });
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
      default:
        return send(res, 400, { ok: false, error: 'UNKNOWN_ACTION' });
    }
  } catch (error) {
    return send(res, error?.statusCode || 500, { ok: false, error: error?.message || 'UNKNOWN_ERROR' });
  }
}
