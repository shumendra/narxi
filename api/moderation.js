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
  let query = supabase
    .from('pending_prices')
    .select('*')
    .or('status.eq.pending,status.is.null')
    .order('created_at', { ascending: true })
    .limit(100);

  const normalizedCity = normalizeCityName(city || '');
  if (normalizedCity) {
    query = query.eq('city', normalizedCity);
  }

  const { data, error } = await query;

  if (error) throw error;

  const items = data || [];
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
  let query = supabase
    .from('prices')
    .select('*')
    .order('receipt_date', { ascending: false })
    .limit(1000);

  const normalizedCity = normalizeCityName(city || '');
  if (normalizedCity) {
    query = query.eq('city', normalizedCity);
  }

  const { data, error } = await query;

  if (error) throw error;
  return data || [];
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
  const { data: products, error: productsError } = await supabase
    .from('products')
    .select('*')
    .order('name_uz', { ascending: true })
    .limit(1000);

  if (productsError) throw productsError;

  const productIds = (products || []).map(item => item.id);
  if (productIds.length === 0) return [];

  const [{ data: prices, error: pricesError }, { data: pending, error: pendingError }] = await Promise.all([
    supabase
      .from('prices')
      .select('id,product_id,product_name_raw,price,city,place_name,place_address,receipt_date,source')
      .in('product_id', productIds)
      .order('receipt_date', { ascending: false })
      .limit(5000),
    supabase
      .from('pending_prices')
      .select('id,product_id,product_name_raw,status,city,created_at')
      .in('product_id', productIds)
      .or('status.eq.pending,status.is.null')
      .order('created_at', { ascending: false })
      .limit(3000),
  ]);

  if (pricesError) throw pricesError;
  if (pendingError) throw pendingError;

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

  let productId = pending.product_id;
  const city = normalizeCityName(pending.city || '') || extractCityFromAddress(pending.place_address || '');

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
    place_name: pending.place_name,
    place_address: pending.place_address,
    latitude: pending.latitude,
    longitude: pending.longitude,
    receipt_date: pending.receipt_date,
    submitted_by: pending.submitted_by,
    source: pending.source,
  };

  const { data: existingExactPrice, error: findExistingError } = await supabase
    .from('prices')
    .select('id')
    .eq('product_id', productId)
    .eq('city', city)
    .eq('place_name', pending.place_name || null)
    .eq('place_address', pending.place_address || null)
    .eq('price', unitPrice)
    .eq('receipt_date', pending.receipt_date || null)
    .limit(1)
    .maybeSingle();

  if (findExistingError) throw findExistingError;

  if (!existingExactPrice?.id) {
    const { error: insertError } = await supabase.from('prices').insert(pricePayload);
    if (insertError) throw insertError;
  }

  await syncProductAvailableCities(productId, city);
  await upsertProductAlias(productId, pending.product_name_raw, pending.place_name || null);

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

  for (const id of targetIds) {
    try {
      await approvePending(id);
      approvedCount += 1;
    } catch {
      failedIds.push(id);
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
