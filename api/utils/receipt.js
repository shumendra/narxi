import axios from 'axios';
import * as cheerio from 'cheerio';
import * as fuzzball from 'fuzzball';
import { extractCityFromAddress as extractCityFromAddressBase, normalizeCityName } from '../../src/constants/cities.js';

export function extractSoliqUrlFromText(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  const directMatch = raw.match(/https?:\/\/[^\s"']+/i);
  if (directMatch && /soliq\.uz/i.test(directMatch[0])) {
    return directMatch[0];
  }

  if (/^ofd\.soliq\.uz\//i.test(raw)) {
    return `https://${raw}`;
  }

  const tParamMatch = raw.match(/(?:^|[?&])t=([^&\s]+)/i);
  if (tParamMatch?.[1]) {
    return `https://ofd.soliq.uz/epi?t=${encodeURIComponent(tParamMatch[1])}`;
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
      candidates.push(`https://ofd.soliq.uz/epi?t=${encodeURIComponent(ticket)}`);
      candidates.push(`https://ofd.soliq.uz/check?t=${encodeURIComponent(ticket)}`);
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

async function fetchWithRetry(url, attempts = 1) {
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await axios.get(url, {
        timeout: 10000,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept-Language': 'uz,ru;q=0.8,en;q=0.6',
        },
      });
    } catch (error) {
      lastError = error;
      if (i === attempts - 1) break;
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
  const receiptDateRaw = extractReceiptDate($);
  const parsedDate = receiptDateRaw ? new Date(receiptDateRaw) : null;
  const receiptDate = parsedDate && !Number.isNaN(parsedDate.getTime())
    ? parsedDate.toISOString()
    : new Date().toISOString();

  const items = [];
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
  }

  if (items.length === 0) {
    items.push(...fallbackExtractItems($));
  }

  return {
    storeName,
    storeAddress,
    city: detectedCity,
    detectedCity,
    receiptDate,
    items,
  };
}

async function scrapeCandidateUrl(candidateUrl) {
  try {
    const { data } = await fetchWithRetry(candidateUrl);
    const parsed = parseReceiptFromHtml(data);
    if (parsed.items.length === 0) {
      return null;
    }
    return parsed;
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
  return success || null;
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
    source: 'soliq_qr',
    submitted_by: telegramId,
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
