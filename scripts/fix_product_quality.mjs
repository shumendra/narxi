/**
 * fix_product_quality.mjs
 *
 * Sends all un-normalized products (where name_uz = name_ru = name_en) to Gemini
 * in batches and applies clean canonical names, proper translations, categories, and units.
 *
 * Usage:
 *   node scripts/fix_product_quality.mjs
 *   node scripts/fix_product_quality.mjs --dry-run   # print SQL only, no DB writes
 *   node scripts/fix_product_quality.mjs --batch-size 60
 *   node scripts/fix_product_quality.mjs --start-batch 3  # resume from batch index
 */

import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const BATCH_SIZE = (() => {
  const idx = args.indexOf('--batch-size');
  return idx >= 0 ? Number(args[idx + 1]) || 25 : 25;
})();
const START_BATCH = (() => {
  const idx = args.indexOf('--start-batch');
  return idx >= 0 ? Number(args[idx + 1]) || 0 : 0;
})();

const workspaceRoot = process.cwd();
for (const envPath of [path.join(workspaceRoot, '.env'), path.join(workspaceRoot, '.env.local')]) {
  if (fs.existsSync(envPath)) dotenv.config({ path: envPath, override: false });
}
if (!process.env.SUPABASE_URL && process.env.VITE_SUPABASE_URL)
  process.env.SUPABASE_URL = process.env.VITE_SUPABASE_URL;
if (!process.env.SUPABASE_ANON_KEY) {
  if (process.env.SUPABASE_KEY) process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_KEY;
  else if (process.env.VITE_SUPABASE_ANON_KEY) process.env.SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_KEY');
  process.exit(1);
}
if (!GEMINI_API_KEY) {
  console.error('Missing GEMINI_API_KEY');
  process.exit(1);
}

const CONFIGURED_GEMINI_MODEL = String(process.env.GEMINI_MODEL || '').trim();
const MODEL_CANDIDATES = Array.from(new Set([
  ...(CONFIGURED_GEMINI_MODEL ? [CONFIGURED_GEMINI_MODEL] : []),
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash-lite',
  'gemini-2.5-flash',
]));

const { createClient } = await import('@supabase/supabase-js');
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ────────────────────────────── helpers ──────────────────────────────

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildPrompt(products) {
  // Use short index numbers instead of UUIDs to avoid Gemini truncating them.
  // We remap via indexToId after parsing the response.
  const productLines = products.map((p, i) =>
    `${i}|${String(p.name_uz || '').trim()}`
  ).join('\n');

  return `You are cleaning up product data for an Uzbekistan grocery price comparison app called Narxi.

All products below were imported from store receipts. Their name_uz, name_ru, and name_en are all IDENTICAL and contain the raw receipt text (may be in Uzbek, Russian, or mixed). Your job is to produce clean, user-friendly canonical names.

PRODUCTS TO CLEAN (idx|raw_name):
${productLines}

CATEGORIES (use EXACTLY one of these):
Don mahsulotlari, Sut mahsulotlari, Gosht mahsulotlari, Sabzavotlar va mevalar, Ichimliklar, Choy va kofe, Shirinliklar va pechene, Moy va souslar, Non va xamirlar, Uy kimyosi, Shaxsiy gigiena, Boshqa

UNITS (use EXACTLY one of these):
kg, litre, dona, gramm

CLEANING RULES:
1. name_uz: Clean Uzbek name. If the raw name is already in Uzbek, clean it up. If it is in Russian (Cyrillic), translate/transliterate it to Uzbek script (Latin). Remove weight/size/grade suffixes UNLESS they are part of the product identity (e.g. brand variants). Keep brand names.
2. name_ru: Proper Russian name. If raw is already Russian, clean it. If raw is Uzbek/Latin, translate to Russian.
3. name_en: Proper English name. Translate accurately.
4. category: Assign the best matching category from the list above.
5. unit: Assign the best matching unit: kg (weight), litre (liquid), dona (piece/package), gramm (gram-sold items).
6. search_text: name_uz + ' ' + name_ru + ' ' + name_en (concatenated, lowercase is fine).
7. APOSTROPHE ESCAPING in SQL: Double every apostrophe in string values (go''sht, o''rik). Never use a bare single quote inside a SQL string.
8. Use the idx number from the input in the WHERE clause — do NOT invent or expand UUIDs.

OUTPUT ONLY valid PostgreSQL UPDATE statements. No markdown. No prose. One statement per product. Example shape:

UPDATE products SET
  name_uz = 'Sut 2.5%',
  name_ru = 'Молоко 2.5%',
  name_en = 'Milk 2.5%',
  category = 'Sut mahsulotlari',
  unit = 'litre',
  search_text = 'Sut 2.5% Молоко 2.5% Milk 2.5%'
WHERE idx = 3;
`;
}

async function callGemini(prompt) {
  let lastError = null;
  for (const model of MODEL_CANDIDATES) {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 32768 },
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
        if (isRateLimited) await sleep(5000);
        continue;
      }
      throw new Error(`Gemini request failed: ${response.status} ${bodyText.slice(0, 240)}`);
    }

    let payload;
    try { payload = JSON.parse(bodyText); } catch {
      throw new Error(`Gemini non-JSON response (${model}): ${String(bodyText).slice(0, 240)}`);
    }

    const rawText = String(
      payload?.candidates?.[0]?.content?.parts?.map(p => p?.text || '').join('\n') || ''
    ).trim();

    // Strip markdown code fences if present
    const sqlText = rawText
      .replace(/^```sql\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();

    return { sqlText, model };
  }
  throw lastError || new Error('Gemini: no usable models available');
}

async function applySqlStatements(sqlText, batch) {
  // Build idx→uuid map for this batch
  const idxToId = {};
  batch.forEach((p, i) => { idxToId[i] = p.id; });

  // Split on statement boundaries, parse idx from WHERE clause, remap to real UUID
  const rawStatements = sqlText
    .split(/;\s*(?:\n|$)/)
    .map(s => s.trim())
    .filter(s => s.length > 10 && /^UPDATE\s+products/i.test(s));

  let successCount = 0;
  let errorCount = 0;
  const errors = [];

  for (const stmt of rawStatements) {
    // Replace "WHERE idx = N;" with "WHERE id = 'real-uuid';"
    const idxMatch = stmt.match(/WHERE\s+idx\s*=\s*(\d+)\s*;?$/i);
    let finalStmt;
    if (idxMatch) {
      const idx = Number(idxMatch[1]);
      const realId = idxToId[idx];
      if (!realId) {
        errors.push({ stmt: stmt.slice(0, 120), error: `No product found for idx=${idx}` });
        errorCount++;
        continue;
      }
      finalStmt = stmt.replace(/WHERE\s+idx\s*=\s*\d+\s*;?$/i, `WHERE id = '${realId}';`);
    } else {
      // Fallback: statement already uses id= (from older batches already applied)
      finalStmt = stmt.endsWith(';') ? stmt : stmt + ';';
    }

    try {
      const { error } = await supabase.rpc('exec_sql', { sql: finalStmt });
      if (error) {
        errorCount++;
      errors.push({ stmt: finalStmt.slice(0, 120), error: error.message });
      } else {
        successCount++;
      }
    } catch (err) {
      errorCount++;
      errors.push({ stmt: (finalStmt || stmt).slice(0, 120), error: String(err?.message || err) });
    }
  }

  return { successCount, errorCount, errors, statementsParsed: rawStatements.length };
}

// ────────────────────────────── main ──────────────────────────────

console.log(`[fix_product_quality] dry_run=${DRY_RUN} batch_size=${BATCH_SIZE} start_batch=${START_BATCH}`);

// Load all un-normalized products
let allProducts = [];
let from = 0;
while (true) {
  const { data, error } = await supabase
    .from('products')
    .select('id, name_uz, name_ru, name_en, category')
    .range(from, from + 999);
  if (error) { console.error('Failed to load products:', error.message); process.exit(1); }
  allProducts = allProducts.concat(data || []);
  if (!data || data.length < 1000) break;
  from += 1000;
}

const unnormalized = allProducts.filter(p => p.name_uz === p.name_ru && p.name_ru === p.name_en);
console.log(`[fix_product_quality] total=${allProducts.length} unnormalized=${unnormalized.length}`);

if (unnormalized.length === 0) {
  console.log('[fix_product_quality] All products already properly normalized. Nothing to do.');
  process.exit(0);
}

const batches = chunkArray(unnormalized, BATCH_SIZE);
console.log(`[fix_product_quality] ${batches.length} batches of ${BATCH_SIZE}`);

let totalSuccess = 0;
let totalErrors = 0;
let totalStatements = 0;
const allSqlBlocks = [];

for (let batchIdx = START_BATCH; batchIdx < batches.length; batchIdx++) {
  const batch = batches[batchIdx];
  console.log(`\n[batch ${batchIdx + 1}/${batches.length}] Processing ${batch.length} products...`);

  let sqlText;
  let model;
  try {
    ({ sqlText, model } = await callGemini(buildPrompt(batch)));
    const stmtCount = (sqlText.match(/^UPDATE\s+products/gim) || []).length;
    console.log(`  model=${model} sql_length=${sqlText.length} statements=${stmtCount}/${batch.length}`);
  } catch (err) {
    console.error(`  Gemini error: ${err.message}`);
    console.error(`  Skipping batch ${batchIdx + 1}. Resume with --start-batch ${batchIdx}`);
    break;
  }

  allSqlBlocks.push(`-- batch ${batchIdx + 1}\n${sqlText}`);

  if (DRY_RUN) {
    console.log('  [DRY RUN] SQL preview:');
    console.log(sqlText.slice(0, 500) + (sqlText.length > 500 ? '\n  ...(truncated)' : ''));
    continue;
  }

  const { successCount, errorCount, errors, statementsParsed } = await applySqlStatements(sqlText, batch);
  totalSuccess += successCount;
  totalErrors += errorCount;
  totalStatements += statementsParsed;
  console.log(`  statements_parsed=${statementsParsed} success=${successCount} errors=${errorCount}`);
  if (errors.length > 0) {
    for (const e of errors.slice(0, 3)) {
      console.error(`  SQL error: ${e.error} → ${e.stmt}`);
    }
  }

  // Brief pause between Gemini calls to avoid rate limiting
  if (batchIdx < batches.length - 1) await sleep(1500);
}

if (DRY_RUN) {
  const sqlOutPath = path.join(workspaceRoot, 'scripts', 'fix_product_quality_output.sql');
  fs.writeFileSync(sqlOutPath, allSqlBlocks.join('\n\n'));
  console.log(`\n[fix_product_quality] DRY RUN complete. SQL written to ${sqlOutPath}`);
} else {
  console.log(`\n[fix_product_quality] Complete. total_success=${totalSuccess} total_errors=${totalErrors} total_statements=${totalStatements}`);
}
