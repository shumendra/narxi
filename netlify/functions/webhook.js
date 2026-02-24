const axios = require('axios');
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');
const fuzzball = require('fuzzball');
const dotenv = require('dotenv');

dotenv.config();
dotenv.config({ path: '.env.local', override: true });

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const MINI_APP_URL = process.env.TELEGRAM_MINI_APP_URL || '';

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

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
    btnFind: 'Narx topish 🔍',
    btnReport: "Narx kiritish ➕",
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
    btnFind: 'Найти цену 🔍',
    btnReport: 'Добавить цену ➕',
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
    btnFind: 'Find price 🔍',
    btnReport: 'Add price ➕',
  },
};

function extractReceiptDate($) {
  const datePatterns = [
    /\b(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}:\d{2}))?\b/,
    /\b(\d{2}\.\d{2}\.\d{4})(?:\s+(\d{2}:\d{2}:\d{2}))?\b/,
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

async function scrapeSoliq(url) {
  try {
    const { data } = await axios.get(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      },
    });
    const $ = cheerio.load(data);

    const storeName = $('h1, .company-name, b').first().text().trim() || "Noma'lum do'kon";
    const storeAddress = $('.address, .company-address').first().text().trim() || 'Toshkent sh.';
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

      $(table)
        .find('tr')
        .slice(1)
        .each((_, el) => {
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

async function sendMenu(chatId, lang) {
  if (!MINI_APP_URL) {
    await sendTelegramMessage(chatId, { text: BOT_COPY[lang].missingMiniApp });
    return;
  }

  const miniAppUrl = MINI_APP_URL;
  await sendTelegramMessage(chatId, {
    text: BOT_COPY[lang].menuText,
    reply_markup: {
      inline_keyboard: [
        [
          { text: BOT_COPY[lang].btnFind, web_app: { url: `${miniAppUrl}?mode=find&lang=${lang}` } },
          { text: BOT_COPY[lang].btnReport, web_app: { url: `${miniAppUrl}?mode=report&lang=${lang}` } },
        ],
      ],
    },
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

async function handleMessage(message) {
  const text = message.text || '';
  const chatId = message.chat?.id;
  const lang = getUserLang(message.from?.language_code);

  if (!chatId) return;

  const normalizedText = text.trim();

  if (normalizedText.startsWith('/start')) {
    await sendLanguagePicker(chatId);
    return;
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

    const receiptData = await scrapeSoliq(receiptUrl);
    if (receiptData && receiptData.items.length > 0) {
      try {
        const { data: existing } = await supabase
          .from('prices')
          .select('id')
          .eq('place_name', receiptData.storeName)
          .eq('receipt_date', receiptData.receiptDate)
          .eq('submitted_by', String(message.from?.id || chatId))
          .eq('source', 'soliq_qr')
          .limit(1);

        if (existing && existing.length > 0) {
          await sendTelegramMessage(chatId, { text: BOT_COPY[lang].alreadyAdded });
          return;
        }

        let savedCount = 0;
        for (const item of receiptData.items) {
          const productMatch = await findProductMatch(item.name);
          await supabase.from('prices').insert({
            product_name_raw: item.name,
            product_id: productMatch?.id || null,
            price: item.unitPrice,
            quantity: item.quantity,
            place_name: receiptData.storeName,
            place_address: receiptData.storeAddress,
            receipt_date: receiptData.receiptDate,
            submitted_by: String(message.from?.id || chatId),
            source: 'soliq_qr',
          });
          savedCount++;
        }

        await sendTelegramMessage(chatId, {
          text: BOT_COPY[lang].saved(savedCount, receiptData.storeName),
        });
      } catch (error) {
        console.error('Supabase insert error:', error);
        await sendTelegramMessage(chatId, { text: BOT_COPY[lang].saveFailed });
      }
    } else {
      await sendTelegramMessage(chatId, { text: BOT_COPY[lang].unreadable });
    }
    return;
  }

  await sendMenu(chatId, lang);
}

async function handleCallback(callbackQuery) {
  const chatId = callbackQuery?.message?.chat?.id;
  if (!chatId) return;

  if (callbackQuery.id) {
    await answerCallbackQuery(callbackQuery.id);
  }

  const data = callbackQuery.data || '';
  if (data.startsWith('lang:')) {
    const lang = data.split(':')[1];
    if (lang === 'uz' || lang === 'ru' || lang === 'en') {
      await sendMenu(chatId, lang);
    }
  }
}

exports.handler = async (event) => {
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

  if (payload?.message) {
    await handleMessage(payload.message);
  }

  if (payload?.callback_query) {
    await handleCallback(payload.callback_query);
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
