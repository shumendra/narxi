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

async function sendMenu(chatId) {
  if (!MINI_APP_URL) {
    await sendTelegramMessage(chatId, { text: "Mini ilova havolasi sozlanmagan. Keyinroq urinib ko'ring." });
    return;
  }

  const miniAppUrl = MINI_APP_URL;
  await sendTelegramMessage(chatId, {
    text: "Narxlarni bilish yoki yangi narx qo'shish uchun quyidagi tugmalardan foydalaning:",
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Narx topish 🔍', web_app: { url: `${miniAppUrl}?mode=find&lang=uz` } },
          { text: "Narx kiritish ➕", web_app: { url: `${miniAppUrl}?mode=report&lang=uz` } },
        ],
      ],
    },
  });
}

async function handleMessage(message) {
  const text = message.text || '';
  const chatId = message.chat?.id;

  if (!chatId) return;

  const normalizedText = text.trim();

  if (normalizedText.startsWith('/start')) {
    await sendMenu(chatId);
    return;
  }

  if (normalizedText.includes('soliq.uz')) {
    const urlMatch = text.match(/https?:\/\/soliq\.uz[^\s]+/);
    if (!urlMatch) {
      await sendTelegramMessage(chatId, { text: "Kechirasiz, chek havolasi topilmadi. ❌" });
      return;
    }

    await sendTelegramMessage(chatId, { text: 'Chek tekshirilmoqda... ⏳' });

    if (!supabaseUrl || !supabaseKey) {
      await sendTelegramMessage(chatId, { text: "Server sozlamalarida xatolik. Keyinroq urinib ko'ring." });
      return;
    }

    const receiptData = await scrapeSoliq(urlMatch[0]);
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
          await sendTelegramMessage(chatId, { text: "Bu chek allaqachon qo'shilgan. ✅" });
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
          text: `✅ ${savedCount} ta mahsulot saqlandi!\n📍 Do'kon: ${receiptData.storeName}`,
        });
      } catch (error) {
        console.error('Supabase insert error:', error);
        await sendTelegramMessage(chatId, { text: "Hozircha saqlab bo'lmadi. Keyinroq urinib ko'ring." });
      }
    } else {
      await sendTelegramMessage(chatId, { text: "Kechirasiz, chek ma'lumotlarini o'qib bo'lmadi. ❌" });
    }
    return;
  }

  await sendMenu(chatId);
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
    void handleMessage(payload.message);
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
