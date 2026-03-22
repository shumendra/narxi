import axios from 'axios';
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';
import * as fuzzball from 'fuzzball';
import dotenv from 'dotenv';
import dns from 'node:dns';

dotenv.config();
dotenv.config({ path: '.env.local', override: true });

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabaseKey = supabaseServiceRoleKey || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
const supabase = (supabaseUrl && supabaseKey)
  ? createClient(supabaseUrl, supabaseKey)
  : null;
const isUsingServiceRole = Boolean(supabaseServiceRoleKey);

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const MINI_APP_URL = process.env.TELEGRAM_MINI_APP_URL || '';
const ADMIN_TELEGRAM_IDS = (process.env.ADMIN_TELEGRAM_IDS || process.env.ADMIN_TELEGRAM_ID || '7240925672')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean);
const PRIMARY_ADMIN_TELEGRAM_ID = ADMIN_TELEGRAM_IDS[0] || '7240925672';

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const DIAGNOSTIC_URL = 'https://ofd.soliq.uz/';

const rateLimitCounter = {};

const BOT_COPY = {
  uz: {
    chooseLang: "Tilni tanlang:",
    menuText: "Narxlarni bilish yoki yangi narx qo'shish uchun quyidagi tugmalardan foydalaning:\nChekni tekshirish uchun soliq.uz havolasini yuboring.",
    missingMiniApp: "Mini ilova havolasi sozlanmagan. Keyinroq urinib ko'ring.",
    missingReceipt: "Kechirasiz, chek havolasi topilmadi. ❌",
    processing: 'Chek tekshirilmoqda... ⏳',
    saved: (count, store) => `✅ ${count} ta mahsulot saqlandi!\n📍 Do'kon: ${store}`,
    unreadable: "Kechirasiz, chek ma'lumotlarini o'qib bo'lmadi. ❌",
    alreadyAdded: "Bu chek allaqachon qo'shilgan. ✅",
    serverError: "Server sozlamalarida xatolik. Keyinroq urinib ko'ring.",
    saveFailed: "Hozircha saqlab bo'lmadi. Keyinroq urinib ko'ring.",
    scrapeFailed: "Chekni o'qishda xatolik yuz berdi. Iltimos, havolani tekshirib qayta yuboring 🔄",
    noItems: "Chekda mahsulotlar topilmadi. Bu chek bo'sh yoki format qo'llab-quvvatlanmaydi.",
    rateLimited: "Juda ko'p ma'lumot yuborildi. Iltimos keyinroq urinib ko'ring 🕐",
    blocked: "Siz tizimdan bloklangansiz.",
    blockedAppeal: "Siz takliflar yuborishdan vaqtincha bloklangansiz.\n\nAgar bu xato deb hisoblasangiz, /appeal buyrug'i orqali murojaat yuboring.",
    appealNotBlocked: "Siz bloklangan emassiz.",
    appealNoText: "Iltimos, murojaatingizni yozing. Masalan: /appeal Men xato qildim",
    appealAccepted: "Murojaatingiz qabul qilindi. Ko'rib chiqilgandan so'ng javob beramiz.",
    appealDisabled: "Murojaat yuborish imkoni yo'q.",
    pendingEmpty: "Hech qanday taklif yo'q ✅",
    pendingMore: (count) => `Yana ${count} ta taklif bor. /pending buyrug'ini qayta yuboring.`,
    statsTitle: '📊 Narxi statistikasi:',
    blockedEmpty: "Bloklangan foydalanuvchilar yo'q",
    unblockOk: (id) => `✅ ${id} blokdan chiqarildi`,
    appealsEmpty: "Hech qanday murojaat yo'q ✅",
    approvedText: '✅ Tasdiqlandi',
    rejectedText: '❌ Rad etildi',
    blockedText: (id) => `🚫 ${id} bloklandi`,
    blockedNotice: "Foydalanuvchi bloklandi. /unblock [telegram_id] bilan qaytarish mumkin.",
    appealApprovedText: '✅ Blokdan chiqarildi',
    appealRejectedText: '❌ Rad etildi',
    btnFind: 'Narx topish 🔍',
    btnReport: "Narx kiritish ➕",
    btnAdminPending: 'Kutilayotganlar 📥',
    btnAdminStats: 'Statistika 📊',
    btnAdminAppeals: 'Murojaatlar 📨',
    btnAdminBlocked: 'Bloklar 🚫',
    btnAdminEdit: 'Tahrir yordami ✏️',
    btnApprove: '✅ Tasdiqlash',
    btnReject: '❌ Rad etish',
    btnBlock: '🚫 Bloklash',
    btnEditName: '✏️ Nom',
    btnEditPrice: '💰 Jami',
    btnEditQty: '📦 Miqdor',
    btnEditUnit: '🧮 Birlik',
    pendingCard: (item, matchedName, unitLabel) => {
      const unitPrice = item.unit_price || item.price || 0;
      const total = item.price || 0;
      const quantity = item.quantity || 1;
      const dateText = item.receipt_date || item.created_at;
      const sourceLabel = item.source === 'soliq_qr' ? 'Soliq QR' : "Qo'lda kiritilgan";
      const matchText = matchedName ? `${item.match_confidence || 0}% — ${matchedName}` : `${item.match_confidence || 0}% — Topilmadi`;
      return (
        `🆔 Pending ID: ${item.id}\n` +
        `📦 Mahsulot: ${item.product_name_raw}\n` +
        `💰 Narx: ${unitPrice} so'm/${unitLabel} (jami: ${total} so'm x ${quantity})\n` +
        `🏪 Do'kon: ${item.place_name || '-'}\n` +
        `📍 Manzil: ${item.place_address || '-'}\n` +
        `📅 Sana: ${dateText || '-'}\n` +
        `🔗 Manba: ${sourceLabel}\n` +
        `👤 Foydalanuvchi ID: ${item.submitted_by}\n` +
        `🎯 Moslik: ${matchText}`
      );
    },
    editNamePrompt: (id) => `✏️ Nomni tahrirlash\nNusxalab yuboring:\n/setname ${id} Yangi mahsulot nomi`,
    editPricePrompt: (id) => `💰 Jami narxni tahrirlash\nNusxalab yuboring:\n/setprice ${id} 25000`,
    editQtyPrompt: (id) => `📦 Miqdorni tahrirlash\nNusxalab yuboring:\n/setqty ${id} 1`,
    editUnitPrompt: (id) => `🧮 Birlik narxini tahrirlash\nNusxalab yuboring:\n/setunit ${id} 25000`,
  },
  ru: {
    chooseLang: "Выберите язык:",
    menuText: "Чтобы найти цены или добавить новую цену, используйте кнопки ниже:\nДля проверки чека отправьте ссылку soliq.uz.",
    missingMiniApp: "Ссылка на мини‑приложение не настроена. Попробуйте позже.",
    missingReceipt: "Не удалось найти ссылку на чек. ❌",
    processing: 'Проверяем чек... ⏳',
    saved: (count, store) => `✅ Сохранено товаров: ${count}\n📍 Магазин: ${store}`,
    unreadable: "Не удалось прочитать данные чека. ❌",
    alreadyAdded: "Этот чек уже был добавлен. ✅",
    serverError: "Ошибка настроек сервера. Попробуйте позже.",
    saveFailed: "Сейчас не удалось сохранить. Попробуйте позже.",
    scrapeFailed: "Не удалось прочитать чек. Проверьте ссылку и отправьте снова 🔄",
    noItems: "В чеке нет товаров. Возможно, чек пустой или формат не поддерживается.",
    rateLimited: "Слишком много данных. Попробуйте позже 🕐",
    blocked: "Вы заблокированы.",
    blockedAppeal: "Вы временно заблокированы от отправки.\n\nЕсли это ошибка, отправьте /appeal.",
    appealNotBlocked: "Вы не заблокированы.",
    appealNoText: "Пожалуйста, напишите обращение. Например: /appeal Я исправлюсь",
    appealAccepted: "Ваше обращение принято. Мы ответим после проверки.",
    appealDisabled: "Отправка обращений недоступна.",
    pendingEmpty: 'Нет предложений ✅',
    pendingMore: (count) => `Осталось ${count} предложений. Отправьте /pending снова.`,
    statsTitle: '📊 Статистика Narxi:',
    blockedEmpty: 'Нет заблокированных пользователей',
    unblockOk: (id) => `✅ ${id} разблокирован`,
    appealsEmpty: 'Нет обращений ✅',
    approvedText: '✅ Одобрено',
    rejectedText: '❌ Отклонено',
    blockedText: (id) => `🚫 ${id} заблокирован`,
    blockedNotice: 'Пользователь заблокирован. Можно вернуть через /unblock [telegram_id].',
    appealApprovedText: '✅ Разблокирован',
    appealRejectedText: '❌ Отклонено',
    btnFind: 'Найти цену 🔍',
    btnReport: 'Добавить цену ➕',
    btnAdminPending: 'Ожидающие 📥',
    btnAdminStats: 'Статистика 📊',
    btnAdminAppeals: 'Обращения 📨',
    btnAdminBlocked: 'Блокировки 🚫',
    btnAdminEdit: 'Помощь по правке ✏️',
    btnApprove: '✅ Одобрить',
    btnReject: '❌ Отклонить',
    btnBlock: '🚫 Блокировать',
    btnEditName: '✏️ Название',
    btnEditPrice: '💰 Сумма',
    btnEditQty: '📦 Кол-во',
    btnEditUnit: '🧮 За единицу',
    pendingCard: (item, matchedName, unitLabel) => {
      const unitPrice = item.unit_price || item.price || 0;
      const total = item.price || 0;
      const quantity = item.quantity || 1;
      const dateText = item.receipt_date || item.created_at;
      const sourceLabel = item.source === 'soliq_qr' ? 'Soliq QR' : 'Вручную';
      const matchText = matchedName ? `${item.match_confidence || 0}% — ${matchedName}` : `${item.match_confidence || 0}% — Не найдено`;
      return (
        `🆔 Pending ID: ${item.id}\n` +
        `📦 Товар: ${item.product_name_raw}\n` +
        `💰 Цена: ${unitPrice} сум/${unitLabel} (всего: ${total} сум x ${quantity})\n` +
        `🏪 Магазин: ${item.place_name || '-'}\n` +
        `📍 Адрес: ${item.place_address || '-'}\n` +
        `📅 Дата: ${dateText || '-'}\n` +
        `🔗 Источник: ${sourceLabel}\n` +
        `👤 ID пользователя: ${item.submitted_by}\n` +
        `🎯 Совпадение: ${matchText}`
      );
    },
    editNamePrompt: (id) => `✏️ Изменить название\nСкопируйте и отправьте:\n/setname ${id} Новое название товара`,
    editPricePrompt: (id) => `💰 Изменить общую цену\nСкопируйте и отправьте:\n/setprice ${id} 25000`,
    editQtyPrompt: (id) => `📦 Изменить количество\nСкопируйте и отправьте:\n/setqty ${id} 1`,
    editUnitPrompt: (id) => `🧮 Изменить цену за единицу\nСкопируйте и отправьте:\n/setunit ${id} 25000`,
  },
  en: {
    chooseLang: 'Choose a language:',
    menuText: 'To find prices or add a new price, use the buttons below:\nTo check a receipt, send a soliq.uz link.',
    missingMiniApp: 'Mini App URL is not configured. Please try again later.',
    missingReceipt: 'Receipt link not found. ❌',
    processing: 'Checking receipt... ⏳',
    saved: (count, store) => `✅ Items saved: ${count}\n📍 Store: ${store}`,
    unreadable: 'Could not read the receipt data. ❌',
    alreadyAdded: 'This receipt was already added. ✅',
    serverError: 'Server configuration error. Please try again later.',
    saveFailed: 'Could not save right now. Please try again later.',
    scrapeFailed: 'Could not read the receipt. Please check the link and resend 🔄',
    noItems: 'No items found on the receipt. It may be empty or unsupported.',
    rateLimited: 'Too much data sent. Please try again later 🕐',
    blocked: 'You are blocked from the system.',
    blockedAppeal: 'You are temporarily blocked from sending.\n\nIf this is a mistake, send /appeal.',
    appealNotBlocked: 'You are not blocked.',
    appealNoText: 'Please write your appeal. Example: /appeal I will do better',
    appealAccepted: 'Your appeal was received. We will respond after review.',
    appealDisabled: 'Appeals are not available.',
    pendingEmpty: 'No pending submissions ✅',
    pendingMore: (count) => `There are ${count} more submissions. Send /pending again.`,
    statsTitle: '📊 Narxi statistics:',
    blockedEmpty: 'No blocked users',
    unblockOk: (id) => `✅ ${id} unblocked`,
    appealsEmpty: 'No appeals ✅',
    approvedText: '✅ Approved',
    rejectedText: '❌ Rejected',
    blockedText: (id) => `🚫 ${id} blocked`,
    blockedNotice: 'User blocked. Restore with /unblock [telegram_id].',
    appealApprovedText: '✅ Unblocked',
    appealRejectedText: '❌ Rejected',
    btnFind: 'Find price 🔍',
    btnReport: 'Add price ➕',
    btnAdminPending: 'Pending 📥',
    btnAdminStats: 'Stats 📊',
    btnAdminAppeals: 'Appeals 📨',
    btnAdminBlocked: 'Blocked 🚫',
    btnAdminEdit: 'Edit help ✏️',
    btnApprove: '✅ Approve',
    btnReject: '❌ Reject',
    btnBlock: '🚫 Block',
    btnEditName: '✏️ Name',
    btnEditPrice: '💰 Total',
    btnEditQty: '📦 Qty',
    btnEditUnit: '🧮 Unit',
    pendingCard: (item, matchedName, unitLabel) => {
      const unitPrice = item.unit_price || item.price || 0;
      const total = item.price || 0;
      const quantity = item.quantity || 1;
      const dateText = item.receipt_date || item.created_at;
      const sourceLabel = item.source === 'soliq_qr' ? 'Soliq QR' : 'Manual';
      const matchText = matchedName ? `${item.match_confidence || 0}% — ${matchedName}` : `${item.match_confidence || 0}% — Not found`;
      return (
        `🆔 Pending ID: ${item.id}\n` +
        `📦 Product: ${item.product_name_raw}\n` +
        `💰 Price: ${unitPrice} so'm/${unitLabel} (total: ${total} so'm x ${quantity})\n` +
        `🏪 Store: ${item.place_name || '-'}\n` +
        `📍 Address: ${item.place_address || '-'}\n` +
        `📅 Date: ${dateText || '-'}\n` +
        `🔗 Source: ${sourceLabel}\n` +
        `👤 User ID: ${item.submitted_by}\n` +
        `🎯 Match: ${matchText}`
      );
    },
    editNamePrompt: (id) => `✏️ Edit name\nCopy and send:\n/setname ${id} New product name`,
    editPricePrompt: (id) => `💰 Edit total price\nCopy and send:\n/setprice ${id} 25000`,
    editQtyPrompt: (id) => `📦 Edit quantity\nCopy and send:\n/setqty ${id} 1`,
    editUnitPrompt: (id) => `🧮 Edit unit price\nCopy and send:\n/setunit ${id} 25000`,
  },
};

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
  const soliqTable = $('table.products-tables');
  if (soliqTable.length > 0) {
    const headerCells = soliqTable.find('thead tr').first().find('th, td');
    const headers = headerCells
      .toArray()
      .map(cell => $(cell).text().trim().toLowerCase());

    const hasName = headers.some(h => h.includes('nomi'));
    const hasQty = headers.some(h => h.includes('soni'));
    const hasPrice = headers.some(h => h.includes('narxi'));

    if (hasName && hasQty && hasPrice) {
      return { table: soliqTable, headers };
    }
  }

  const tables = $('table');
  for (const table of tables.toArray()) {
    const headerCells = $(table).find('tr').first().find('th, td');
    const headers = headerCells
      .toArray()
      .map(cell => $(cell).text().trim().toLowerCase());

    const hasName = headers.some(h => h.includes('nomi'));
    const hasQty = headers.some(h => h.includes('soni'));
    const hasPrice = headers.some(h => h.includes('narxi'));

    if (hasName && hasQty && hasPrice) {
      return { table, headers };
    }
  }
  return null;
}

async function fetchWithRetry(url, attempts = 2) {
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

async function scrapeSoliq(url) {
  try {
    const { data } = await fetchWithRetry(url);
    const $ = cheerio.load(data);

    const storeHeader = $('h3').filter((_, el) => $(el).text().includes('"') || $(el).text().includes('MCHJ') || $(el).text().includes('JAMIYAT')).first();
    const storeName = storeHeader.text().trim() || $('h1, .company-name, b').first().text().trim() || "Noma'lum do'kon";
    const storeBlock = storeHeader.closest('td');
    const storeAddress = storeBlock
      .clone()
      .find('h3')
      .remove()
      .end()
      .text()
      .replace(/\s+/g, ' ')
      .trim() || $('.address, .company-address').first().text().trim() || 'Toshkent sh.';
    const receiptDateRaw = extractReceiptDate($);
    const parsedDate = receiptDateRaw ? new Date(receiptDateRaw) : null;
    const receiptDate = parsedDate && !Number.isNaN(parsedDate.getTime())
      ? parsedDate.toISOString()
      : new Date().toISOString();

    const items = [];
    const itemsTable = findItemsTable($);
    if (itemsTable) {
      const { table, headers } = itemsTable;
      const nameIndex = headers.findIndex(h => h.includes('nomi'));
      const qtyIndex = headers.findIndex(h => h.includes('soni'));
      const priceIndex = headers.findIndex(h => h.includes('narxi'));

      const rows = $(table).find('tbody tr.products-row');
      const targetRows = rows.length > 0 ? rows : $(table).find('tr').slice(1);

      targetRows.each((_, el) => {
        const cols = $(el).find('td');
        if (cols.length === 0) return;

        const name = $(cols[nameIndex]).text().trim();
        const quantityStr = $(cols[qtyIndex]).text().trim().replace(',', '.');
        const priceStr = $(cols[priceIndex]).text().trim().replace(/\s/g, '').replace(',', '.');

        const quantity = Number.parseFloat(quantityStr) || 1;
        const totalPrice = Number.parseFloat(priceStr) || 0;
        const unitPrice = quantity > 0 ? Math.round(totalPrice / quantity) : totalPrice;

        if (name && totalPrice > 0) {
          items.push({ name, quantity, totalPrice, unitPrice });
        }
      });
    }

    return { storeName, storeAddress, items, receiptDate };
  } catch (error) {
    console.error('Scraping error:', error);
    return null;
  }
}

async function findProductMatch(rawName) {
  const { data: products } = await supabase.from('products').select('*');
  if (!products || products.length === 0) return null;

  let bestMatch = null;
  let highestScore = 0;

  for (const product of products) {
    const scoreUz = fuzzball.ratio(rawName.toLowerCase(), product.name_uz.toLowerCase());
    const scoreRu = fuzzball.ratio(rawName.toLowerCase(), product.name_ru.toLowerCase());
    const score = Math.max(scoreUz, scoreRu);

    if (score > highestScore) {
      highestScore = score;
      bestMatch = product;
    }
  }

  return highestScore >= 60 ? bestMatch : null;
}

async function sendTelegramMessage(chatId, payload) {
  if (!TELEGRAM_TOKEN) {
    console.error('Missing TELEGRAM_BOT_TOKEN');
    return;
  }
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    ...payload,
  });
}

async function sendTelegramPhoto(chatId, photoUrl, caption, replyMarkup) {
  if (!TELEGRAM_TOKEN) {
    console.error('Missing TELEGRAM_BOT_TOKEN');
    return;
  }
  await axios.post(`${TELEGRAM_API}/sendPhoto`, {
    chat_id: chatId,
    photo: photoUrl,
    caption,
    parse_mode: 'HTML',
    reply_markup: replyMarkup,
  });
}

function formatPendingItem(item, matchedName, unitLabel, lang) {
  return BOT_COPY[lang].pendingCard(item, matchedName, unitLabel);
}

function getAdminModerationKeyboard(item, lang) {
  return {
    inline_keyboard: [
      [
        { text: BOT_COPY[lang].btnApprove, callback_data: `approve_${item.id}` },
        { text: BOT_COPY[lang].btnReject, callback_data: `reject_${item.id}` },
        { text: BOT_COPY[lang].btnBlock, callback_data: `block_${item.submitted_by}_${item.id}` },
      ],
      [
        { text: BOT_COPY[lang].btnEditName, callback_data: `editname_${item.id}` },
        { text: BOT_COPY[lang].btnEditPrice, callback_data: `editprice_${item.id}` },
      ],
      [
        { text: BOT_COPY[lang].btnEditQty, callback_data: `editqty_${item.id}` },
        { text: BOT_COPY[lang].btnEditUnit, callback_data: `editunit_${item.id}` },
      ],
    ],
  };
}

async function sendMenu(chatId, lang, telegramId = null) {
  if (!MINI_APP_URL) {
    await sendTelegramMessage(chatId, { text: BOT_COPY[lang].missingMiniApp });
    return;
  }

  const miniAppUrl = MINI_APP_URL;
  const isAdminUser = telegramId ? await isAdmin(telegramId) : false;
  const inline_keyboard = [
    [
      { text: BOT_COPY[lang].btnFind, web_app: { url: `${miniAppUrl}?mode=find&lang=${lang}` } },
      { text: BOT_COPY[lang].btnReport, web_app: { url: `${miniAppUrl}?mode=report&lang=${lang}` } },
    ],
  ];

  if (isAdminUser) {
    inline_keyboard.push(
      [
        { text: BOT_COPY[lang].btnAdminPending, callback_data: 'menu:pending' },
        { text: BOT_COPY[lang].btnAdminStats, callback_data: 'menu:stats' },
      ],
      [
        { text: BOT_COPY[lang].btnAdminAppeals, callback_data: 'menu:appeals' },
        { text: BOT_COPY[lang].btnAdminBlocked, callback_data: 'menu:blocked' },
      ],
      [
        { text: BOT_COPY[lang].btnAdminEdit, callback_data: 'menu:edithelp' },
      ],
    );
  }

  await sendTelegramMessage(chatId, {
    text: BOT_COPY[lang].menuText,
    reply_markup: { inline_keyboard },
  });
}

async function sendLanguagePicker(chatId) {
  await sendTelegramMessage(chatId, {
    text: BOT_COPY.uz.chooseLang,
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'O‘zbekcha', callback_data: 'lang:uz' },
          { text: 'Русский', callback_data: 'lang:ru' },
          { text: 'English', callback_data: 'lang:en' },
        ],
      ],
    },
  });
}

async function answerCallbackQuery(callbackQueryId) {
  if (!TELEGRAM_TOKEN) return;
  await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
    callback_query_id: callbackQueryId,
  });
}

function getUserLang(sourceLang) {
  if (!sourceLang) return 'uz';
  if (sourceLang.startsWith('ru')) return 'ru';
  if (sourceLang.startsWith('en')) return 'en';
  return 'uz';
}

function extractSoliqUrl(message) {
  const text = message.text || '';
  const entities = message.entities || [];

  for (const entity of entities) {
    if (entity.type === 'text_link' && entity.url) {
      if (entity.url.includes('soliq.uz')) return entity.url;
    }
    if (entity.type === 'url') {
      const url = text.substring(entity.offset, entity.offset + entity.length);
      if (url.includes('soliq.uz')) return url;
    }
  }

  const match = text.match(/https?:\/\/(?:[a-z0-9-]+\.)*soliq\.uz[^\s]*/i);
  return match ? match[0] : null;
}

function getCommand(text) {
  const normalizedText = (text || '').trim().toLowerCase();
  const firstToken = normalizedText.split(' ')[0] || '';
  return firstToken.includes('@') ? firstToken.split('@')[0] : firstToken;
}

async function isAdmin(telegramId) {
  if (!telegramId) return false;
  return ADMIN_TELEGRAM_IDS.includes(String(telegramId));
}

async function getPendingItems(limit = 10) {
  const { data: pending, count, error } = await supabase
    .from('pending_prices')
    .select('*', { count: 'exact' })
    .or('status.eq.pending,status.is.null')
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) {
    throw error;
  }

  const productIds = [...new Set((pending || []).map(item => item.product_id).filter(Boolean))];
  let productsById = {};

  if (productIds.length > 0) {
    const { data: products, error: productsError } = await supabase
      .from('products')
      .select('id, name_uz, unit')
      .in('id', productIds);

    if (productsError) {
      throw productsError;
    }

    productsById = Object.fromEntries((products || []).map(product => [product.id, product]));
  }

  const enriched = (pending || []).map(item => ({
    ...item,
    products: item.product_id ? productsById[item.product_id] || null : null,
  }));

  return { pending: enriched, count: count || 0 };
}

async function sendAdminEditHelp(chatId) {
  await sendTelegramMessage(chatId, {
    text:
      'Admin edit commands:\n' +
      '/pending\n' +
      '/pendingdebug\n' +
      '/fixpendingstatus\n' +
      '/setname <pending_id> <new product name>\n' +
      '/setprice <pending_id> <total_price>\n' +
      '/setqty <pending_id> <quantity>\n' +
      '/setunit <pending_id> <unit_price>',
  });
}

async function sendPendingQueue(chatId, lang) {
  const { pending, count } = await getPendingItems(10);

  if (!pending || pending.length === 0) {
    await sendTelegramMessage(chatId, {
      text: isUsingServiceRole
        ? BOT_COPY[lang].pendingEmpty
        : `${BOT_COPY[lang].pendingEmpty}\n\nDebug hint: set SUPABASE_SERVICE_ROLE_KEY in Vercel for admin moderation reads.`,
    });
    return;
  }

  for (const item of pending) {
    const matchedName = item.products?.name_uz || null;
    const unitLabel = item.products?.unit || 'dona';
    const textBlock = formatPendingItem(item, matchedName, unitLabel, lang);
    const keyboard = getAdminModerationKeyboard(item, lang);

    if (item.photo_url) {
      await sendTelegramPhoto(chatId, item.photo_url, textBlock, keyboard);
    } else {
      await sendTelegramMessage(chatId, { text: textBlock, reply_markup: keyboard });
    }
  }

  const remaining = (count || 0) - pending.length;
  if (remaining > 0) {
    await sendTelegramMessage(chatId, { text: BOT_COPY[lang].pendingMore(remaining) });
  }
}

async function sendAdminStats(chatId, lang) {
  const [{ count: pricesCount }, { count: pendingCount }, { count: rejectedCount }, { count: productsCount }, { count: blockedCount }, { count: appealsCount }] = await Promise.all([
    supabase.from('prices').select('id', { count: 'exact', head: true }),
    supabase.from('pending_prices').select('id', { count: 'exact', head: true }).or('status.eq.pending,status.is.null'),
    supabase.from('pending_prices').select('id', { count: 'exact', head: true }).eq('status', 'rejected'),
    supabase.from('products').select('id', { count: 'exact', head: true }),
    supabase.from('blocked_users').select('telegram_id', { count: 'exact', head: true }),
    supabase.from('appeals').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
  ]);

  await sendTelegramMessage(chatId, {
    text:
      `${BOT_COPY[lang].statsTitle}\n\n` +
      `✅ Approved: ${pricesCount || 0}\n` +
      `⏳ Pending: ${pendingCount || 0}\n` +
      `❌ Rejected: ${rejectedCount || 0}\n` +
      `📦 Products: ${productsCount || 0}\n` +
      `🚫 Blocked: ${blockedCount || 0}\n` +
      `📨 Appeals: ${appealsCount || 0}`,
  });
}

async function sendBlockedUsers(chatId, lang) {
  const { data: blockedUsers } = await supabase
    .from('blocked_users')
    .select('telegram_id, blocked_at')
    .order('blocked_at', { ascending: false });

  if (!blockedUsers || blockedUsers.length === 0) {
    await sendTelegramMessage(chatId, { text: BOT_COPY[lang].blockedEmpty });
    return;
  }

  const lines = blockedUsers.map(user => `🚫 ${user.telegram_id} — ${user.blocked_at}`).join('\n');
  await sendTelegramMessage(chatId, { text: lines });
}

async function sendAppealsQueue(chatId, lang) {
  const { data: appeals } = await supabase
    .from('appeals')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true });

  if (!appeals || appeals.length === 0) {
    await sendTelegramMessage(chatId, { text: BOT_COPY[lang].appealsEmpty });
    return;
  }

  for (const appeal of appeals) {
    const textBlock =
      `📨 Appeal\n\n` +
      `👤 ID: ${appeal.telegram_id}\n` +
      `💬 Message: ${appeal.appeal_message}\n` +
      `📅 Date: ${appeal.created_at}\n`;

    await sendTelegramMessage(chatId, {
      text: textBlock,
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Unblock', callback_data: `appeal_approve_${appeal.telegram_id}_${appeal.id}` },
            { text: '❌ Reject', callback_data: `appeal_reject_${appeal.id}` },
          ],
        ],
      },
    });
  }
}

async function handleMessage(message) {
  const chatId = message?.chat?.id;
  const text = message?.text || '';
  const normalizedText = text.trim().toLowerCase();
  const command = getCommand(text);
  const telegramId = message?.from?.id?.toString();
  const lang = getUserLang(message?.from?.language_code);

  if (!chatId || !telegramId) {
    return;
  }

  if (command === '/start') {
    await sendLanguagePicker(chatId);
    return;
  }

  if (command === '/myid') {
    await sendTelegramMessage(chatId, {
      text: `Your Telegram ID: ${telegramId}\nAdmin match: ${await isAdmin(telegramId) ? 'yes' : 'no'}`,
    });
    return;
  }

  if (command === '/pending' && !(await isAdmin(telegramId))) {
    await sendTelegramMessage(chatId, {
      text: `You are not recognized as admin.\nYour Telegram ID: ${telegramId}`,
    });
    return;
  }

  if (normalizedText.startsWith('/appeal')) {
    const appealText = normalizedText.replace('/appeal', '').trim();
    const { data: blocked } = await supabase
      .from('blocked_users')
      .select('telegram_id, can_appeal')
      .eq('telegram_id', telegramId)
      .maybeSingle();

    if (!blocked) {
      await sendTelegramMessage(chatId, { text: BOT_COPY[lang].appealNotBlocked });
      return;
    }
    if (!blocked.can_appeal) {
      await sendTelegramMessage(chatId, { text: BOT_COPY[lang].appealDisabled });
      return;
    }
    if (!appealText) {
      await sendTelegramMessage(chatId, { text: BOT_COPY[lang].appealNoText });
      return;
    }

    await supabase.from('appeals').insert({
      telegram_id: telegramId,
      appeal_message: appealText,
      status: 'pending',
    });

    await sendTelegramMessage(chatId, { text: BOT_COPY[lang].appealAccepted });
    return;
  }

  if (await isAdmin(telegramId)) {
    if (command === '/setname') {
      const parts = text.trim().split(' ');
      const pendingId = parts[1];
      const newName = parts.slice(2).join(' ').trim();

      if (!pendingId || !newName) {
        await sendTelegramMessage(chatId, { text: 'Format: /setname <pending_id> <new product name>' });
        return;
      }

      await supabase
        .from('pending_prices')
        .update({ product_name_raw: newName, product_id: null, match_confidence: 0 })
        .eq('id', pendingId);

      await sendTelegramMessage(chatId, { text: `✅ Updated name for pending ${pendingId}` });
      return;
    }

    if (command === '/setprice') {
      const parts = text.trim().split(' ');
      const pendingId = parts[1];
      const priceValue = Number.parseFloat(parts[2]);

      if (!pendingId || Number.isNaN(priceValue) || priceValue <= 0) {
        await sendTelegramMessage(chatId, { text: 'Format: /setprice <pending_id> <total_price>' });
        return;
      }

      const { data: current } = await supabase
        .from('pending_prices')
        .select('quantity')
        .eq('id', pendingId)
        .maybeSingle();

      const quantity = current?.quantity && current.quantity > 0 ? current.quantity : 1;
      const unitPrice = Math.round(priceValue / quantity);

      await supabase
        .from('pending_prices')
        .update({ price: priceValue, unit_price: unitPrice })
        .eq('id', pendingId);

      await sendTelegramMessage(chatId, { text: `✅ Updated total price for pending ${pendingId}` });
      return;
    }

    if (command === '/setqty') {
      const parts = text.trim().split(' ');
      const pendingId = parts[1];
      const quantityValue = Number.parseFloat(parts[2]);

      if (!pendingId || Number.isNaN(quantityValue) || quantityValue <= 0) {
        await sendTelegramMessage(chatId, { text: 'Format: /setqty <pending_id> <quantity>' });
        return;
      }

      const { data: current } = await supabase
        .from('pending_prices')
        .select('price')
        .eq('id', pendingId)
        .maybeSingle();

      const price = current?.price && current.price > 0 ? current.price : 0;
      const unitPrice = price > 0 ? Math.round(price / quantityValue) : 0;

      await supabase
        .from('pending_prices')
        .update({ quantity: quantityValue, unit_price: unitPrice })
        .eq('id', pendingId);

      await sendTelegramMessage(chatId, { text: `✅ Updated quantity for pending ${pendingId}` });
      return;
    }

    if (command === '/setunit') {
      const parts = text.trim().split(' ');
      const pendingId = parts[1];
      const unitPriceValue = Number.parseFloat(parts[2]);

      if (!pendingId || Number.isNaN(unitPriceValue) || unitPriceValue <= 0) {
        await sendTelegramMessage(chatId, { text: 'Format: /setunit <pending_id> <unit_price>' });
        return;
      }

      const { data: current } = await supabase
        .from('pending_prices')
        .select('quantity')
        .eq('id', pendingId)
        .maybeSingle();

      const quantity = current?.quantity && current.quantity > 0 ? current.quantity : 1;
      const totalPrice = Math.round(unitPriceValue * quantity);

      await supabase
        .from('pending_prices')
        .update({ unit_price: unitPriceValue, price: totalPrice })
        .eq('id', pendingId);

      await sendTelegramMessage(chatId, { text: `✅ Updated unit price for pending ${pendingId}` });
      return;
    }

    if (command === '/edithelp') {
      await sendTelegramMessage(chatId, {
        text:
          'Admin edit commands:\n' +
          '/pending\n' +
          '/pendingdebug\n' +
          '/fixpendingstatus\n' +
          '/setname <pending_id> <new product name>\n' +
          '/setprice <pending_id> <total_price>\n' +
          '/setqty <pending_id> <quantity>\n' +
          '/setunit <pending_id> <unit_price>',
      });
      return;
    }

    if (command === '/pendingdebug') {
      const [{ count: allCount }, { count: pendingCount }, { count: nullCount }] = await Promise.all([
        supabase.from('pending_prices').select('id', { count: 'exact', head: true }),
        supabase.from('pending_prices').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
        supabase.from('pending_prices').select('id', { count: 'exact', head: true }).is('status', null),
      ]);

      await sendTelegramMessage(chatId, {
        text:
          `Supabase mode: ${isUsingServiceRole ? 'service_role' : 'anon'}\n` +
          `All rows visible: ${allCount || 0}\n` +
          `Pending rows visible: ${pendingCount || 0}\n` +
          `Null-status rows visible: ${nullCount || 0}`,
      });
      return;
    }

    if (command === '/fixpendingstatus') {
      const { data, error } = await supabase
        .from('pending_prices')
        .update({ status: 'pending' })
        .is('status', null)
        .select('id');

      if (error) {
        await sendTelegramMessage(chatId, { text: `❌ Failed to normalize pending statuses: ${error.message}` });
        return;
      }

      await sendTelegramMessage(chatId, {
        text: `✅ Normalized ${data?.length || 0} rows from null status to pending`,
      });
      return;
    }

    if (normalizedText.startsWith('/pending')) {
      const { pending, count } = await getPendingItems(10);

      if (!pending || pending.length === 0) {
        await sendTelegramMessage(chatId, {
          text: isUsingServiceRole
            ? BOT_COPY[lang].pendingEmpty
            : `${BOT_COPY[lang].pendingEmpty}\n\nDebug hint: set SUPABASE_SERVICE_ROLE_KEY in Vercel for admin moderation reads.`,
        });
        return;
      }

      for (const item of pending) {
        const matchedName = item.products?.name_uz || null;
        const unitLabel = item.products?.unit || 'dona';
        const textBlock = formatPendingItem(item, matchedName, unitLabel);
        const keyboard = {
          inline_keyboard: [
            [
              { text: '✅ Tasdiqlash', callback_data: `approve_${item.id}` },
              { text: '❌ Rad etish', callback_data: `reject_${item.id}` },
              { text: '🚫 Bloklash', callback_data: `block_${item.submitted_by}_${item.id}` },
            ],
            [
              { text: '✏️ Nom', callback_data: `editname_${item.id}` },
              { text: '💰 Jami', callback_data: `editprice_${item.id}` },
            ],
            [
              { text: '📦 Miqdor', callback_data: `editqty_${item.id}` },
              { text: '🧮 Birlik', callback_data: `editunit_${item.id}` },
            ],
          ],
        };

        if (item.photo_url) {
          await sendTelegramPhoto(chatId, item.photo_url, textBlock, keyboard);
        } else {
          await sendTelegramMessage(chatId, { text: textBlock, reply_markup: keyboard });
        }
      }

      const remaining = (count || 0) - pending.length;
      if (remaining > 0) {
        await sendTelegramMessage(chatId, { text: BOT_COPY[lang].pendingMore(remaining) });
      }
      return;
    }

    if (normalizedText.startsWith('/stats')) {
      const [{ count: pricesCount }, { count: pendingCount }, { count: rejectedCount }, { count: productsCount }, { count: blockedCount }, { count: appealsCount }] = await Promise.all([
        supabase.from('prices').select('id', { count: 'exact', head: true }),
        supabase.from('pending_prices').select('id', { count: 'exact', head: true }).or('status.eq.pending,status.is.null'),
        supabase.from('pending_prices').select('id', { count: 'exact', head: true }).eq('status', 'rejected'),
        supabase.from('products').select('id', { count: 'exact', head: true }),
        supabase.from('blocked_users').select('telegram_id', { count: 'exact', head: true }),
        supabase.from('appeals').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      ]);

      await sendTelegramMessage(chatId, {
        text:
          `${BOT_COPY[lang].statsTitle}\n\n` +
          `✅ Tasdiqlangan narxlar: ${pricesCount || 0}\n` +
          `⏳ Kutilayotgan: ${pendingCount || 0}\n` +
          `❌ Rad etilgan: ${rejectedCount || 0}\n` +
          `📦 Mahsulotlar: ${productsCount || 0}\n` +
          `🚫 Bloklangan: ${blockedCount || 0}\n` +
          `📨 Murojaatlar: ${appealsCount || 0}`,
      });
      return;
    }

    if (normalizedText.startsWith('/blocked')) {
      const { data: blockedUsers } = await supabase
        .from('blocked_users')
        .select('telegram_id, blocked_at')
        .order('blocked_at', { ascending: false });

      if (!blockedUsers || blockedUsers.length === 0) {
        await sendTelegramMessage(chatId, { text: BOT_COPY[lang].blockedEmpty });
        return;
      }

      const lines = blockedUsers.map(user => `🚫 ${user.telegram_id} — ${user.blocked_at}`).join('\n');
      await sendTelegramMessage(chatId, { text: lines });
      return;
    }

    if (normalizedText.startsWith('/unblock')) {
      const parts = normalizedText.split(' ');
      const targetId = parts[1];
      if (targetId) {
        await supabase.from('blocked_users').delete().eq('telegram_id', targetId);
        await sendTelegramMessage(chatId, { text: BOT_COPY[lang].unblockOk(targetId) });
      }
      return;
    }

    if (normalizedText.startsWith('/appeals')) {
      const { data: appeals } = await supabase
        .from('appeals')
        .select('*')
        .eq('status', 'pending')
        .order('created_at', { ascending: true });

      if (!appeals || appeals.length === 0) {
        await sendTelegramMessage(chatId, { text: BOT_COPY[lang].appealsEmpty });
        return;
      }

      for (const appeal of appeals) {
        const textBlock =
          `📨 Murojaat\n\n` +
          `👤 ID: ${appeal.telegram_id}\n` +
          `💬 Xabar: ${appeal.appeal_message}\n` +
          `📅 Sana: ${appeal.created_at}\n`;

        await sendTelegramMessage(chatId, {
          text: textBlock,
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Blokdan chiqarish', callback_data: `appeal_approve_${appeal.telegram_id}_${appeal.id}` },
                { text: '❌ Rad etish', callback_data: `appeal_reject_${appeal.id}` },
              ],
            ],
          },
        });
      }
      return;
    }
  }

  if (normalizedText.includes('soliq.uz')) {
    const receiptUrl = extractSoliqUrl(message);
    if (!receiptUrl) {
      await sendTelegramMessage(chatId, { text: BOT_COPY[lang].missingReceipt });
      return;
    }

    await sendTelegramMessage(chatId, { text: BOT_COPY[lang].processing });

    if (!supabaseUrl || !supabaseKey) {
      await sendTelegramMessage(chatId, { text: BOT_COPY[lang].serverError });
      return;
    }

    const { data: alreadyProcessed } = await supabase
      .from('receipts_log')
      .select('receipt_url')
      .eq('receipt_url', receiptUrl)
      .maybeSingle();

    if (alreadyProcessed) {
      await sendTelegramMessage(chatId, { text: BOT_COPY[lang].alreadyAdded });
      return;
    }

    const receiptData = await scrapeSoliq(receiptUrl);
    if (!receiptData) {
      await sendTelegramMessage(chatId, { text: BOT_COPY[lang].scrapeFailed });
      return;
    }

    if (receiptData && receiptData.items.length > 0) {
      try {
        const currentCount = rateLimitCounter[telegramId] || 0;
        if (currentCount + receiptData.items.length > 10) {
          await sendTelegramMessage(chatId, { text: BOT_COPY[lang].rateLimited });
          return;
        }
        rateLimitCounter[telegramId] = currentCount + receiptData.items.length;

        const products = await getProductsIndex();

        const inserts = receiptData.items.map(async item => {
          let bestMatch = null;
          let highestScore = 0;

          for (const product of products) {
            const candidates = [product.name_uz, product.name_ru, product.name_en].filter(Boolean);
            const scores = candidates.map(name => fuzzball.ratio(item.name.toLowerCase(), name.toLowerCase()));
            const score = Math.max(...scores, 0);
            if (score > highestScore) {
              highestScore = score;
              bestMatch = product;
            }
          }

          return supabase.from('pending_prices').insert({
            product_name_raw: item.name,
            product_id: bestMatch?.id || null,
            match_confidence: highestScore,
            status: 'pending',
            price: item.totalPrice,
            quantity: item.quantity,
            unit_price: item.unitPrice,
            place_name: receiptData.storeName,
            place_address: receiptData.storeAddress,
            receipt_url: receiptUrl,
            receipt_date: receiptData.receiptDate,
            source: 'soliq_qr',
            submitted_by: telegramId,
          });
        });

        await Promise.all(inserts);

        await supabase.from('receipts_log').insert({
          receipt_url: receiptUrl,
          submitted_by: telegramId,
          item_count: receiptData.items.length,
        });

        await sendTelegramMessage(chatId, {
          text:
            `✅ Chek qabul qilindi!\n\n` +
            `🏪 Do'kon: ${receiptData.storeName}\n` +
            `📍 Manzil: ${receiptData.storeAddress}\n` +
            `📦 Mahsulotlar: ${receiptData.items.length} ta\n` +
            `⏳ Ko'rib chiqilmoqda...\n\n` +
            `Rahmat! Siz Toshkent aholisiga narxlarni bilishga yordam berdingiz 🙌`,
        });
      } catch (error) {
        console.error('Supabase insert error:', error);
        await sendTelegramMessage(chatId, { text: BOT_COPY[lang].saveFailed });
      }
    } else {
      await sendTelegramMessage(chatId, { text: BOT_COPY[lang].noItems });
    }
    return;
  }

  await sendMenu(chatId, lang);
}

async function handleCallback(callbackQuery) {
  const chatId = callbackQuery?.message?.chat?.id;
  const telegramId = callbackQuery?.from?.id?.toString();
  if (!chatId) return;

  const data = callbackQuery.data || '';

  if (callbackQuery.id) {
    await answerCallbackQuery(callbackQuery.id);
  }

  if (data.startsWith('lang:')) {
    const lang = data.split(':')[1];
    if (lang === 'uz' || lang === 'ru' || lang === 'en') {
      await sendMenu(chatId, lang);
    }
    return;
  }

  if (!telegramId || !(await isAdmin(telegramId))) {
    return;
  }

  if (data.startsWith('editname_')) {
    const pendingId = data.replace('editname_', '');
    await sendTelegramMessage(chatId, {
      text: `✏️ Edit name\nCopy and send:\n/setname ${pendingId} Yangi mahsulot nomi`,
    });
    return;
  }

  if (data.startsWith('editprice_')) {
    const pendingId = data.replace('editprice_', '');
    await sendTelegramMessage(chatId, {
      text: `💰 Edit total price\nCopy and send:\n/setprice ${pendingId} 25000`,
    });
    return;
  }

  if (data.startsWith('editqty_')) {
    const pendingId = data.replace('editqty_', '');
    await sendTelegramMessage(chatId, {
      text: `📦 Edit quantity\nCopy and send:\n/setqty ${pendingId} 1`,
    });
    return;
  }

  if (data.startsWith('editunit_')) {
    const pendingId = data.replace('editunit_', '');
    await sendTelegramMessage(chatId, {
      text: `🧮 Edit unit price\nCopy and send:\n/setunit ${pendingId} 25000`,
    });
    return;
  }

  if (data.startsWith('approve_')) {
    const id = data.replace('approve_', '');
    const { data: pending } = await supabase
      .from('pending_prices')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (!pending) return;

    let productId = pending.product_id;
    if (!productId) {
      const { data: created } = await supabase
        .from('products')
        .insert({ name_uz: pending.product_name_raw, name_ru: '', name_en: '', category: 'Boshqa', unit: 'dona' })
        .select('id')
        .single();
      productId = created?.id || null;
    }

    await supabase.from('prices').insert({
      product_id: productId,
      product_name_raw: pending.product_name_raw,
      price: pending.price,
      quantity: pending.quantity,
      unit_price: pending.unit_price,
      place_name: pending.place_name,
      place_address: pending.place_address,
      latitude: pending.latitude,
      longitude: pending.longitude,
      receipt_date: pending.receipt_date,
      submitted_by: pending.submitted_by,
      source: pending.source,
      photo_url: pending.photo_url,
    });

    await supabase.from('pending_prices').update({ status: 'approved' }).eq('id', id);

    const adminLang = getUserLang(callbackQuery?.from?.language_code);
    await axios.post(`${TELEGRAM_API}/editMessageText`, {
      chat_id: chatId,
      message_id: callbackQuery?.message?.message_id,
      text: BOT_COPY[adminLang].approvedText,
    });
    return;
  }

  if (data.startsWith('reject_')) {
    const id = data.replace('reject_', '');
    await supabase.from('pending_prices').update({ status: 'rejected' }).eq('id', id);
    const adminLang = getUserLang(callbackQuery?.from?.language_code);
    await axios.post(`${TELEGRAM_API}/editMessageText`, {
      chat_id: chatId,
      message_id: callbackQuery?.message?.message_id,
      text: BOT_COPY[adminLang].rejectedText,
    });
    return;
  }

  if (data.startsWith('block_')) {
    const parts = data.replace('block_', '').split('_');
    const targetId = parts[0];
    const pendingId = parts[1];

    await supabase.from('blocked_users').upsert({
      telegram_id: targetId,
      blocked_by: PRIMARY_ADMIN_TELEGRAM_ID,
      reason: 'Admin tomonidan bloklandi',
      can_appeal: true,
    });

    await supabase.from('pending_prices').update({ status: 'rejected' }).eq('id', pendingId);

    const adminLang = getUserLang(callbackQuery?.from?.language_code);
    await axios.post(`${TELEGRAM_API}/editMessageText`, {
      chat_id: chatId,
      message_id: callbackQuery?.message?.message_id,
      text: BOT_COPY[adminLang].blockedText(targetId),
    });

    await sendTelegramMessage(chatId, {
      text: BOT_COPY[adminLang].blockedNotice,
    });
    return;
  }

  if (data.startsWith('appeal_approve_')) {
    const parts = data.replace('appeal_approve_', '').split('_');
    const targetId = parts[0];
    const appealId = parts[1];

    await supabase.from('blocked_users').delete().eq('telegram_id', targetId);
    await supabase.from('appeals').update({ status: 'approved' }).eq('id', appealId);

    await sendTelegramMessage(targetId, { text: "Murojaaatingiz ko'rib chiqildi. Siz tizimga qaytadingiz ✅" });
    const adminLang = getUserLang(callbackQuery?.from?.language_code);
    await axios.post(`${TELEGRAM_API}/editMessageText`, {
      chat_id: chatId,
      message_id: callbackQuery?.message?.message_id,
      text: BOT_COPY[adminLang].appealApprovedText,
    });
    return;
  }

  if (data.startsWith('appeal_reject_')) {
    const appealId = data.replace('appeal_reject_', '');
    await supabase.from('appeals').update({ status: 'rejected' }).eq('id', appealId);
    const adminLang = getUserLang(callbackQuery?.from?.language_code);
    await axios.post(`${TELEGRAM_API}/editMessageText`, {
      chat_id: chatId,
      message_id: callbackQuery?.message?.message_id,
      text: BOT_COPY[adminLang].appealRejectedText,
    });
  }
}

export const handler = async (event) => {
  if (event.httpMethod === 'GET' && event.queryStringParameters?.diag === '1') {
    const results = {
      ok: false,
      dns: null,
      tcp: null,
      http: null,
      error: null,
    };

    try {
      const dnsLookup = await new Promise((resolve, reject) => {
        dns.lookup('ofd.soliq.uz', (err, address) => {
          if (err) reject(err);
          else resolve(address);
        });
      });
      results.dns = dnsLookup;

      const start = Date.now();
      const response = await axios.get(DIAGNOSTIC_URL, {
        timeout: 8000,
        validateStatus: () => true,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        },
      });
      results.tcp = Date.now() - start;
      results.http = {
        status: response.status,
        headers: response.headers,
      };
      results.ok = true;
    } catch (error) {
      results.error = String(error.message || error);
    }

    return {
      statusCode: 200,
      body: JSON.stringify(results),
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  if (!event.body) {
    return { statusCode: 200, body: 'ok' };
  }

  let payload = null;
  try {
    payload = JSON.parse(event.body);
  } catch (error) {
    console.error('Invalid JSON payload', error);
    return { statusCode: 200, body: 'ok' };
  }

  const incomingText = payload?.message?.text || '';
  const incomingCommand = getCommand(incomingText);

  if (incomingCommand === '/start') {
    try {
      await handleMessage(payload.message);
    } catch (error) {
      console.error('Failed to handle /start', error);
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  const callbackData = payload?.callback_query?.data || '';
  if (callbackData.startsWith('lang:')) {
    try {
      await handleCallback(payload.callback_query);
    } catch (error) {
      console.error('Failed to handle language callback', error);
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  if (!supabase) {
    console.error('Supabase environment variables are missing.');
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'SUPABASE_ENV_MISSING' }) };
  }

  if (payload?.message) {
    try {
      await handleMessage(payload.message);
    } catch (error) {
      console.error('Failed to handle message', error);
    }
  }

  if (payload?.callback_query) {
    try {
      await handleCallback(payload.callback_query);
    } catch (error) {
      console.error('Failed to handle callback query', error);
    }
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
