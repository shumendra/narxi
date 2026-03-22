import axios from 'axios';
import * as cheerio from 'cheerio';
import * as fuzzball from 'fuzzball';
import { extractCityFromAddress as extractCityFromAddressBase, normalizeCityName } from '../../src/constants/cities.js';

export function extractSoliqUrlFromText(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  const buildCheckFromParams = (paramsSource) => {
    const search = new URLSearchParams(paramsSource);
    const t = search.get('t');
    if (!t) return null;
    const r = search.get('r');
    const c = search.get('c');
    const s = search.get('s');

    const check = new URL('https://ofd.soliq.uz/check');
    check.searchParams.set('t', t);
    if (r) check.searchParams.set('r', r);
    if (c) check.searchParams.set('c', c);
    if (s) check.searchParams.set('s', s);
    return check.toString();
  };

  const directMatch = raw.match(/https?:\/\/[^\s"']+/i);
  if (directMatch && /soliq\.uz/i.test(directMatch[0])) {
    try {
      const parsed = new URL(directMatch[0]);
      const fromDirectParams = buildCheckFromParams(parsed.search);
      return fromDirectParams || parsed.toString();
    } catch {
      return directMatch[0];
    }
  }

  if (/^ofd\.soliq\.uz\//i.test(raw)) {
    try {
      const parsed = new URL(`https://${raw}`);
      const fromRawParams = buildCheckFromParams(parsed.search);
      return fromRawParams || parsed.toString();
    } catch {
      return `https://${raw}`;
    }
  }

  const fromLooseParams = buildCheckFromParams(raw);
  if (fromLooseParams) {
    return fromLooseParams;
  }

  return null;
}

export function normalizeSoliqUrl(input) {
  const extracted = extractSoliqUrlFromText(input);
  if (!extracted) return null;

  try {
    const parsed = new URL(extracted);
    if (!/soliq\.uz$/i.test(parsed.hostname) && !/\.soliq\.uz$/i.test(parsed.hostname)) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function buildReceiptUrlCandidates(rawUrl) {
  const normalized = normalizeSoliqUrl(rawUrl);
  if (!normalized) return [];

  const candidates = [normalized];
  try {
    const parsed = new URL(normalized);
    const ticket = parsed.searchParams.get('t');
    if (ticket) {
      const r = parsed.searchParams.get('r');
      const c = parsed.searchParams.get('c');
      const s = parsed.searchParams.get('s');

      const check = new URL('https://ofd.soliq.uz/check');
      check.searchParams.set('t', ticket);
      if (r) check.searchParams.set('r', r);
      if (c) check.searchParams.set('c', c);
      if (s) check.searchParams.set('s', s);

      const epi = new URL('https://ofd.soliq.uz/epi');
      epi.searchParams.set('t', ticket);
      if (r) epi.searchParams.set('r', r);
      if (c) epi.searchParams.set('c', c);
      if (s) epi.searchParams.set('s', s);

      candidates.push(check.toString());
      candidates.push(epi.toString());
    }
  } catch {
    return candidates;
  }

  return [...new Set(candidates)];
}

function extractReceiptDate($) {
  const datePatterns = [
    /\b(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}:\d{2}))?\b/,
    /\b(\d{2}\.\d{2}\.\d{4})(?:,?\s*(\d{2}:\d{2}(?::\d{2})?))?\b/,
  ];

  const labeled = $('*:contains("Sana"), *:contains("Vaqt"), *:contains("Дата"), *:contains("Время")');
  for (const el of labeled.toArray()) {
    const text = $(el).text();
    for (const pattern of datePatterns) {
      const match = text.match(pattern);
      if (match) {
        return match[1].includes('.') ? match[1].split('.').reverse().join('-') + (match[2] ? `T${match[2]}` : '') : match[0];
      }
    }
  }

  const pageText = $('body').text();
  for (const pattern of datePatterns) {
    const match = pageText.match(pattern);
    if (match) {
      return match[1].includes('.') ? match[1].split('.').reverse().join('-') + (match[2] ? `T${match[2]}` : '') : match[0];
    }
  }

  return null;
}

function findItemsTable($) {
  const nameKeys = ['nomi', 'товар', 'наимен', 'name', 'product'];
  const qtyKeys = ['soni', 'кол', 'qty', 'quantity', 'miqdor'];
  const priceKeys = ['narxi', 'сумма', 'цена', 'price', 'стоим'];

  const hasAny = (value, keys) => keys.some(key => value.includes(key));
  const normalizeHeader = (value) => String(value || '').trim().toLowerCase();

  const resolveIndexes = (headers) => {
    const normalized = headers.map(normalizeHeader);
    const nameIndex = normalized.findIndex(h => hasAny(h, nameKeys));
    const qtyIndex = normalized.findIndex(h => hasAny(h, qtyKeys));
    const priceIndex = normalized.findIndex(h => hasAny(h, priceKeys));
    if (nameIndex === -1 || qtyIndex === -1 || priceIndex === -1) return null;
    return { nameIndex, qtyIndex, priceIndex };
  };

  const soliqTable = $('table.products-tables');
  if (soliqTable.length > 0) {
    const headerCells = soliqTable.find('thead tr').first().find('th, td');
    const headers = headerCells.toArray().map(cell => $(cell).text().trim());
    const indexes = resolveIndexes(headers);

    if (indexes) {
      return { table: soliqTable, headers };
    }
  }

  const tables = $('table');
  for (const table of tables.toArray()) {
    const headerCells = $(table).find('tr').first().find('th, td');
    const headers = headerCells.toArray().map(cell => $(cell).text().trim());
    const indexes = resolveIndexes(headers);

    if (indexes) {
      return { table, headers };
    }
  }

  return null;
}

function parseNumericValue(input) {
  const raw = String(input || '').trim();
  if (!raw) return 0;

  let cleaned = raw.replace(/[^\d.,-]/g, '');
  if (!cleaned) return 0;

  const hasComma = cleaned.includes(',');
  const hasDot = cleaned.includes('.');

  if (hasComma && hasDot) {
    cleaned = cleaned.replace(/,/g, '');
  } else if (hasComma) {
    cleaned = cleaned.replace(/,/g, '.');
  }

  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : 0;
}

function extractReceiptTotal($) {
  const keys = ['jami to\'lov', 'jami to`lov', 'итого', 'total', 'к оплате', 'summa'];
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();

  for (const key of keys) {
    const pattern = new RegExp(`${key}[^\\d]{0,40}([\\d\\s.,]+)`, 'i');
    const match = bodyText.match(pattern);
    if (match?.[1]) {
      const value = parseNumericValue(match[1]);
      if (value > 0) return Math.round(value);
    }
  }

  return null;
}

function fallbackExtractItemsFromJsonScripts($) {
  const scripts = $('script[type*="json"], script')
    .toArray()
    .map(script => $(script).html() || '')
    .filter(Boolean);

  const items = [];
  const seen = new Set();

  const nameKeys = ['name', 'product', 'product_name', 'good_name', 'товар', 'наименование', 'nomi'];
  const qtyKeys = ['qty', 'quantity', 'count', 'soni', 'кол'];
  const priceKeys = ['price', 'sum', 'total', 'amount', 'narx', 'стоим', 'цена'];

  const getValueByKeys = (obj, keys) => {
    if (!obj || typeof obj !== 'object') return null;
    const entries = Object.entries(obj);
    for (const [key, value] of entries) {
      const normalized = String(key).toLowerCase();
      if (keys.some(k => normalized.includes(k))) {
        return value;
      }
    }
    return null;
  };

  const tryPush = (nameRaw, totalRaw, qtyRaw) => {
    const name = String(nameRaw || '').replace(/\s+/g, ' ').trim();
    const totalPrice = parseNumericValue(totalRaw);
    const quantity = Math.max(1, parseNumericValue(qtyRaw) || 1);
    if (!name || totalPrice <= 0) return;
    const unitPrice = quantity > 0 ? Math.round(totalPrice / quantity) : totalPrice;
    const key = `${name.toLowerCase()}|${quantity}|${totalPrice}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ name, quantity, totalPrice, unitPrice });
  };

  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry);
      return;
    }

    if (!node || typeof node !== 'object') return;

    const name = getValueByKeys(node, nameKeys);
    const total = getValueByKeys(node, priceKeys);
    const qty = getValueByKeys(node, qtyKeys);
    if (name && total) {
      tryPush(name, total, qty);
    }

    for (const value of Object.values(node)) {
      walk(value);
    }
  };

  for (const scriptText of scripts) {
    const trimmed = scriptText.trim();
    if (!trimmed) continue;

    try {
      const parsed = JSON.parse(trimmed);
      walk(parsed);
      continue;
    } catch {
      // ignore, try pattern extraction below
    }

    const objectPattern = /\{[\s\S]{10,600}\}/g;
    const blocks = trimmed.match(objectPattern) || [];
    for (const block of blocks) {
      try {
        const parsed = JSON.parse(block);
        walk(parsed);
      } catch {
        // ignore malformed blocks
      }
    }
  }

  return items;
}

function tryParseCoordinatePair(latRaw, lonRaw) {
  const latitude = Number(String(latRaw || '').replace(',', '.'));
  const longitude = Number(String(lonRaw || '').replace(',', '.'));
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude, longitude };
}

function extractCoordinatesFromHtml(html, $) {
  const candidates = [];

  const patterns = [
    /(?:latitude|lat)\s*[:=]\s*['"]?(-?\d{1,2}(?:[.,]\d+)?)['"]?[\s,;]+(?:longitude|lng|lon)\s*[:=]\s*['"]?(-?\d{1,3}(?:[.,]\d+)?)['"]?/gi,
    /(?:longitude|lng|lon)\s*[:=]\s*['"]?(-?\d{1,3}(?:[.,]\d+)?)['"]?[\s,;]+(?:latitude|lat)\s*[:=]\s*['"]?(-?\d{1,2}(?:[.,]\d+)?)['"]?/gi,
    /[?&](?:q|query|ll|center)=(-?\d{1,2}(?:[.,]\d+)?),(-?\d{1,3}(?:[.,]\d+)?)/gi,
    /(-?\d{1,2}(?:[.,]\d+)?)\s*,\s*(-?\d{1,3}(?:[.,]\d+)?)/g,
  ];

  for (const pattern of patterns) {
    let match = null;
    while ((match = pattern.exec(html)) !== null) {
      const pair = tryParseCoordinatePair(match[1], match[2]);
      if (pair) candidates.push(pair);
    }
  }

  const anchors = $('a[href*="maps"], a[href*="google"], a[href*="yandex"], a[href*="2gis"], a[href*="geo"], a[href*="q="]');
  anchors.each((_, el) => {
    const href = $(el).attr('href') || '';
    const match = href.match(/(-?\d{1,2}(?:[.,]\d+)?)\s*,\s*(-?\d{1,3}(?:[.,]\d+)?)/);
    if (!match) return;
    const pair = tryParseCoordinatePair(match[1], match[2]);
    if (pair) candidates.push(pair);
  });

  const uzbekBounds = { minLat: 36, maxLat: 46, minLon: 55, maxLon: 75 };
  const best = candidates.find(point => (
    point.latitude >= uzbekBounds.minLat
    && point.latitude <= uzbekBounds.maxLat
    && point.longitude >= uzbekBounds.minLon
    && point.longitude <= uzbekBounds.maxLon
  ));

  return best || null;
}

function fallbackExtractItems($) {
  const items = [];
  const rows = $('table tr').slice(1);

  rows.each((_, row) => {
    const cols = $(row).find('td');
    if (cols.length < 2) return;

    const values = cols.toArray().map(cell => $(cell).text().replace(/\s+/g, ' ').trim());
    const nameCandidate = values.find(value => /[a-zA-Zа-яА-ЯўқғҳҚҒҲЁё]/.test(value)) || '';
    const numericValues = values
      .map(value => parseNumericValue(value))
      .filter(value => Number.isFinite(value) && value > 0);

    if (!nameCandidate || numericValues.length === 0) return;

    const totalPrice = numericValues[numericValues.length - 1] || 0;
    const quantity = numericValues.length > 1 ? Math.max(1, numericValues[0]) : 1;
    const unitPrice = quantity > 0 ? Math.round(totalPrice / quantity) : totalPrice;

    if (totalPrice > 0) {
      items.push({ name: nameCandidate, quantity, totalPrice, unitPrice });
    }
  });

  return items;
}

function fallbackExtractItemsFromScripts($) {
  const items = [];
  const scripts = $('script')
    .toArray()
    .map(script => $(script).html() || '')
    .filter(Boolean);

  const pushItem = (name, priceRaw, qtyRaw) => {
    const productName = String(name || '').replace(/\s+/g, ' ').trim();
    const totalPrice = parseNumericValue(priceRaw);
    const quantity = Math.max(1, parseNumericValue(qtyRaw) || 1);
    const unitPrice = quantity > 0 ? Math.round(totalPrice / quantity) : totalPrice;
    if (!productName || totalPrice <= 0) return;

    const key = `${productName.toLowerCase()}|${totalPrice}|${quantity}`;
    if (items.some(item => `${item.name.toLowerCase()}|${item.totalPrice}|${item.quantity}` === key)) {
      return;
    }

    items.push({ name: productName, quantity, totalPrice, unitPrice });
  };

  for (const scriptText of scripts) {
    const jsonLikePattern = /"(?:name|product_name|good_name|товар|наименование)"\s*:\s*"([^"]{2,})"[\s\S]{0,220}?"(?:price|sum|total|amount|narx|стоим|цена)"\s*:\s*"?([0-9][0-9\s.,]*)"?[\s\S]{0,140}?(?:"(?:qty|quantity|count|soni|кол)"\s*:\s*"?([0-9][0-9\s.,]*)"?)?/gi;
    let match = null;
    while ((match = jsonLikePattern.exec(scriptText)) !== null) {
      pushItem(match[1], match[2], match[3]);
    }

    const arrayLikePattern = /\[\s*"([^"]{2,})"\s*,\s*"?([0-9][0-9\s.,]*)"?\s*,\s*"?([0-9][0-9\s.,]*)"?\s*\]/g;
    while ((match = arrayLikePattern.exec(scriptText)) !== null) {
      pushItem(match[1], match[3], match[2]);
    }

    const jsObjectPattern = /(?:name|product_name|good_name|товар|наименование)\s*:\s*['"]([^'"\\n]{2,})['"][\s\S]{0,220}?(?:price|sum|total|amount|narx|стоим|цена)\s*:\s*['"]?([0-9][0-9\s.,]*)['"]?[\s\S]{0,140}?(?:(?:qty|quantity|count|soni|кол)\s*:\s*['"]?([0-9][0-9\s.,]*)['"]?)?/gi;
    while ((match = jsObjectPattern.exec(scriptText)) !== null) {
      pushItem(match[1], match[2], match[3]);
    }
  }

  return items;
}

function fallbackExtractItemsFromProductBlocks($) {
  const items = [];
  const pushIfValid = (name, totalPrice, quantity) => {
    const cleanName = String(name || '').replace(/\s+/g, ' ').trim();
    const total = parseNumericValue(totalPrice);
    const qty = Math.max(1, parseNumericValue(quantity) || 1);
    if (!cleanName || total <= 0) return;
    const unitPrice = qty > 0 ? Math.round(total / qty) : total;
    const fingerprint = `${cleanName.toLowerCase()}|${total}|${qty}`;
    if (items.some(item => `${item.name.toLowerCase()}|${item.totalPrice}|${item.quantity}` === fingerprint)) {
      return;
    }
    items.push({ name: cleanName, quantity: qty, totalPrice: total, unitPrice });
  };

  const blockCandidates = $('[class*="product"], [class*="goods"], [class*="item"], [class*="товар"]');
  blockCandidates.each((_, block) => {
    const text = $(block).text().replace(/\s+/g, ' ').trim();
    if (!text) return;

    const name =
      $(block).find('[class*="name"], [class*="title"]').first().text().trim() ||
      text.split(/\s{2,}|\|/)[0] ||
      '';

    const numericParts = text.match(/[0-9][0-9\s.,]*/g) || [];
    if (numericParts.length === 0) return;
    const totalPrice = numericParts[numericParts.length - 1];
    const quantity = numericParts.length > 1 ? numericParts[0] : '1';
    pushIfValid(name, totalPrice, quantity);
  });

  return items;
}

function fallbackExtractItemsFromAnyThreeColumnRows($) {
  const items = [];
  const seen = new Set();

  $('table tr').each((_, row) => {
    const cols = $(row).find('td');
    if (cols.length < 3) return;

    const first = $(cols[0]).text().replace(/\s+/g, ' ').trim();
    const second = $(cols[1]).text().replace(/\s+/g, ' ').trim();
    const third = $(cols[2]).text().replace(/\s+/g, ' ').trim();

    if (!first || !second || !third) return;

    const quantity = Math.max(1, parseNumericValue(second) || 1);
    const totalPrice = parseNumericValue(third);
    if (totalPrice <= 0) return;

    const lowerName = first.toLowerCase();
    const blockedNameKeys = ['qqs', 'mxik', 'shtrix', 'chegirma', 'naqd pul', 'bank kartalari', 'jami to`lov', 'jami to\'lov'];
    if (blockedNameKeys.some(key => lowerName.includes(key))) return;

    const unitPrice = quantity > 0 ? Math.round(totalPrice / quantity) : totalPrice;
    const fingerprint = `${lowerName}|${quantity}|${totalPrice}`;
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);

    items.push({
      name: first,
      quantity,
      totalPrice,
      unitPrice,
    });
  });

  return items;
}

async function fetchWithRetry(url, attempts = 3) {
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await axios.get(url, {
        timeout: 10000,
        maxRedirects: 5,
        validateStatus: (status) => status >= 200 && status < 400,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'uz,ru;q=0.9,en;q=0.8',
          'Referer': 'https://ofd.soliq.uz/',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
        },
      });
    } catch (error) {
      lastError = error;
      if (i === attempts - 1) break;
      await new Promise(resolve => setTimeout(resolve, 500 * (i + 1)));
    }
  }
  throw lastError;
}

function parseReceiptFromHtml(html) {
  const $ = cheerio.load(html);

  const storeHeader = $('h3')
    .filter((_, el) => $(el).text().includes('"') || $(el).text().includes('MCHJ') || $(el).text().includes('JAMIYAT'))
    .first();

  const storeName =
    storeHeader.text().trim() || $('h1, .company-name, b').first().text().trim() || "Noma'lum do'kon";

  const storeBlock = storeHeader.closest('td');
  const storeAddress =
    storeBlock
      .clone()
      .find('h3')
      .remove()
      .end()
      .text()
      .replace(/\s+/g, ' ')
      .trim() || $('.address, .company-address').first().text().trim() || 'Toshkent sh.';

  const detectedCity = extractCityFromAddress(storeAddress);
  const totalAmount = extractReceiptTotal($);
  const receiptDateRaw = extractReceiptDate($);
  const parsedDate = receiptDateRaw ? new Date(receiptDateRaw) : null;
  const receiptDate = parsedDate && !Number.isNaN(parsedDate.getTime())
    ? parsedDate.toISOString()
    : new Date().toISOString();
  const coordinates = extractCoordinatesFromHtml(html, $);

  const items = [];
  let parseStage = null;
  const itemsTable = findItemsTable($);
  if (itemsTable) {
    const { table, headers } = itemsTable;
    const normalizedHeaders = headers.map(h => String(h || '').toLowerCase());
    const nameIndex = normalizedHeaders.findIndex(h => ['nomi', 'товар', 'наимен', 'name', 'product'].some(key => h.includes(key)));
    const qtyIndex = normalizedHeaders.findIndex(h => ['soni', 'кол', 'qty', 'quantity', 'miqdor'].some(key => h.includes(key)));
    const priceIndex = normalizedHeaders.findIndex(h => ['narxi', 'сумма', 'цена', 'price', 'стоим'].some(key => h.includes(key)));

    const rows = $(table).find('tbody tr.products-row');
    const targetRows = rows.length > 0 ? rows : $(table).find('tr').slice(1);

    targetRows.each((_, el) => {
      const cols = $(el).find('td');
      if (cols.length === 0) return;

      const name = $(cols[nameIndex]).text().trim();
      const quantity = parseNumericValue($(cols[qtyIndex]).text().trim()) || 1;
      const totalPrice = parseNumericValue($(cols[priceIndex]).text().trim()) || 0;
      const unitPrice = quantity > 0 ? Math.round(totalPrice / quantity) : totalPrice;

      if (name && totalPrice > 0) {
        items.push({ name, quantity, totalPrice, unitPrice });
      }
    });
    if (items.length > 0) {
      parseStage = 'table';
    }
  }

  if (items.length === 0) {
    items.push(...fallbackExtractItems($));
    if (items.length > 0) {
      parseStage = 'generic_table';
    }
  }

  if (items.length === 0) {
    items.push(...fallbackExtractItemsFromScripts($));
    if (items.length > 0) {
      parseStage = 'script_regex';
    }
  }

  if (items.length === 0) {
    items.push(...fallbackExtractItemsFromJsonScripts($));
    if (items.length > 0) {
      parseStage = 'script_json';
    }
  }

  if (items.length === 0) {
    items.push(...fallbackExtractItemsFromProductBlocks($));
    if (items.length > 0) {
      parseStage = 'product_blocks';
    }
  }

  if (items.length === 0) {
    items.push(...fallbackExtractItemsFromAnyThreeColumnRows($));
    if (items.length > 0) {
      parseStage = 'three_columns';
    }
  }

  if (!parseStage) {
    parseStage = 'metadata_only';
  }

  return {
    storeName,
    storeAddress,
    city: detectedCity,
    detectedCity,
    latitude: coordinates?.latitude ?? null,
    longitude: coordinates?.longitude ?? null,
    totalAmount,
    parseStage,
    receiptDate,
    items,
  };
}

async function scrapeCandidateUrl(candidateUrl) {
  try {
    const { data } = await fetchWithRetry(candidateUrl);
    return parseReceiptFromHtml(data);
  } catch (error) {
    return null;
  }
}

export function extractCityFromAddress(address) {
  return extractCityFromAddressBase(address || '');
}

export async function scrapesoliqReceipt(url) {
  const candidateUrls = buildReceiptUrlCandidates(url);
  if (candidateUrls.length === 0) {
    return null;
  }

  const results = await Promise.all(candidateUrls.map(candidateUrl => scrapeCandidateUrl(candidateUrl)));
  const success = results.find(result => result && Array.isArray(result.items) && result.items.length > 0);
  if (success) return success;

  const metadataOnly = results.find(result => result && (result.storeName || result.storeAddress || result.totalAmount));
  return metadataOnly || null;
}

export async function fetchProductsIndex(supabase) {
  const { data, error } = await supabase
    .from('products')
    .select('id, name_uz, name_ru, name_en');

  if (error) throw error;
  return data || [];
}

export function fuzzyMatchProduct(rawName, products) {
  let bestMatch = null;
  let highestScore = 0;

  for (const product of products || []) {
    const candidates = [product.name_uz, product.name_ru, product.name_en].filter(Boolean);
    const scores = candidates.map(name => fuzzball.ratio(String(rawName || '').toLowerCase(), String(name).toLowerCase()));
    const score = Math.max(...scores, 0);
    if (score > highestScore) {
      highestScore = score;
      bestMatch = product;
    }
  }

  return { product: bestMatch, score: highestScore };
}

export async function insertPendingPrice({
  supabase,
  item,
  receiptData,
  telegramId,
  city,
  receiptUrl,
  products,
  source = 'soliq_qr',
  latitude = null,
  longitude = null,
}) {
  const productPool = products || (await fetchProductsIndex(supabase));
  const { product: bestMatch, score: highestScore } = fuzzyMatchProduct(item.name, productPool);

  const selectedCity = normalizeCityName(city || '');
  const detectedCity = normalizeCityName(receiptData?.city || receiptData?.detectedCity || extractCityFromAddress(receiptData?.storeAddress || ''));
  const finalCity = detectedCity || selectedCity || 'Tashkent';

  const payload = {
    product_name_raw: item.name,
    product_id: bestMatch?.id || null,
    match_confidence: highestScore,
    status: 'pending',
    price: item.totalPrice,
    quantity: item.quantity,
    unit_price: item.unitPrice,
    city: finalCity,
    place_name: receiptData.storeName,
    place_address: receiptData.storeAddress,
    receipt_url: receiptUrl,
    receipt_date: receiptData.receiptDate,
    source,
    submitted_by: telegramId,
    latitude,
    longitude,
  };

  const { data, error } = await supabase
    .from('pending_prices')
    .insert(payload)
    .select('*')
    .maybeSingle();

  if (error) throw error;

  return {
    item: data,
    matchedProductId: bestMatch?.id || null,
    matchConfidence: highestScore,
    selectedCity,
    detectedCity,
    finalCity,
  };
}
