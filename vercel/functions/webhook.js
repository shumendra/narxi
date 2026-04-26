import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import dns from 'node:dns';
import { extractCityFromAddress, getCityLabel, normalizeCityName, getCityOption } from '../../src/constants/cities.js';
import { isSoliqUrl } from '../../api/utils/receipt.js';
import { sendBroadcast, sendWeeklyReports } from '../../api/notifications-core.js';

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
const TAGLINE_BY_LANG = {
  uz: 'Narxni bil, pulni teja',
  ru: 'Знай цену, экономь деньги',
  en: 'Know the price, save the money',
};
const pendingShoppingUsers = new Set();
const pendingDistanceUsers = new Set();
const adminNotifyDrafts = new Map();

async function getPendingAction(telegramId) {
  if (!telegramId) return null;
  const { data } = await supabase
    .from('user_profiles')
    .select('pending_action')
    .eq('telegram_id', telegramId)
    .maybeSingle();
  return data?.pending_action || null;
}

async function setPendingAction(telegramId, action) {
  if (!telegramId) return;
  await supabase
    .from('user_profiles')
    .update({ pending_action: action })
    .eq('telegram_id', telegramId);
}

const BOT_COPY = {
  uz: {
    chooseLang: "Tilni tanlang:",
    menuText: "Narxlarni bilish yoki yangi narx qo'shish uchun quyidagi tugmalardan foydalaning:\nChekni tekshirish uchun soliq.uz havolasini yuboring.",
    missingMiniApp: "Mini ilova havolasi sozlanmagan. Keyinroq urinib ko'ring.",
    missingReceipt: "Kechirasiz, chek havolasi topilmadi. ❌",
    processing: 'Chek tekshirilmoqda... ⏳',
    saved: (count, store) => `✅ ${count} ta mahsulot saqlandi!\n📍 Do'kon: ${store}`,
    receiptAccepted: (store, address, city, count) =>
      `✅ Chek qabul qilindi!\n\n🏪 Do'kon: ${store}\n📍 Manzil: ${address}\n🏙️ Shahar: ${city}\n📦 Mahsulotlar: ${count} ta\n⏳ Ko'rib chiqilmoqda...\n\nRahmat! Siz narxlarni yangilashga yordam berdingiz 🙌`,
    unreadable: "Kechirasiz, chek ma'lumotlarini o'qib bo'lmadi. ❌",
    alreadyAdded: "Bu chek allaqachon qo'shilgan. ✅",
    serverError: "Server sozlamalarida xatolik. Keyinroq urinib ko'ring.",
    saveFailed: "Hozircha saqlab bo'lmadi. Keyinroq urinib ko'ring.",
    scrapeFailed: "Chekni o'qishda xatolik yuz berdi. Iltimos, havolani tekshirib qayta yuboring 🔄",
    queueAccepted: "Chek navbatga qo'shildi. Tez orada qayta ishlanadi.",
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
    statsCities: '🏙️ Shaharlar:',
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
    btnModerate: 'Tasdiqlash ✅',
    btnApprove: '✅ Tasdiqlash',
    btnReject: '❌ Rad etish',
    btnBlock: '🚫 Bloklash',
    btnEditName: '✏️ Nom',
    btnEditPrice: '💰 Jami',
    btnEditQty: '📦 Miqdor',
    btnEditUnit: '🧮 Birlik',
    btnOpenReader: 'Readerni ochish 🌐',
    btnMyStats: '📊 Statistikam',
    btnShopping: '🛒 Savdo reja',
    btnDistance: '📏 Masofa',
    btnNotifyMenu: '📢 Xabar',
    btnScheduledMenu: '📅 Reja',
    mapsView: '🗺️ Xaritada ko\'rish',
    mystatsTitle: '📊 Sizning statistikangiz',
    mystatsReceipts: (n) => `🧾 Skanerlangan cheklar: ${n} ta`,
    mystatsItems: (n) => `📦 Qo\'shilgan mahsulotlar: ${n} ta`,
    mystatsStreak: (n) => `🔥 Ketma-ket hafta: ${n} hafta`,
    mystatsHelped: (n) => `👥 Yordam berilgan odamlar: ${n} ta`,
    shoppingAsk: 'Bu hafta nima sotib olmoqchisiz?',
    shoppingAskHint: 'Mahsulotlarni yozing (vergul bilan ajrating):\nMasalan: shakar, guruch, tuxum, sut, non',
    distanceAsk: 'Qancha masofaga borishga tayyorsiz? (km da yozing, masalan: 3)',
    distanceInvalid: 'Iltimos, km ni to\'g\'ri kiriting. Masalan: 3',
    distanceSaved: (km) => `✅ Saqlandi. Maksimal masofa: ${km} km`,
    notifyStart: '📢 Xabar yuborish\n\nQuyidagilardan birini tanlang:',
    notifyWeeklyOption: '📊 Haftalik hisobot',
    notifyBroadcastOption: '✍️ Oddiy xabar',
    notifyAskMessage: 'Xabar matnini yozing:',
    notifyAskWhen: 'Qachon yuborish?',
    notifyNow: '⚡ Hozir',
    notifySchedule: '📅 Rejalashtirish',
    notifyNeedMessage: 'Avval xabar matnini kiriting: /notify',
    notifyAskDate: 'Sana va vaqtni kiriting (masalan: 2026-04-15 09:00):',
    notifyInvalidDate: 'Sana va vaqt formati noto\'g\'ri. Masalan: 2026-04-15 09:00',
    notifyScheduled: (ts) => `✅ Rejalashtirildi: ${ts}`,
    notifySent: (n) => `✅ Xabar yuborildi: ${n} ta foydalanuvchi`,
    notifyWeeklySent: (n) => `✅ Hisobotlar yuborildi: ${n} ta foydalanuvchi`,
    scheduledEmpty: '📅 Rejalashtirilgan xabarlar yo\'q',
    scheduledTitle: '📅 Rejalashtirilgan xabarlar:',
    scheduledCancel: '❌ Bekor qilish',
    scheduledCancelled: '✅ Rejalashtirilgan xabar bekor qilindi',
    routeNoData: 'Topilmadi: bu mahsulotlar uchun tanlangan shaharda narxlar yetarli emas.',
    routeTitle: '🛒 Sizning xarid rejangiz',
    routeOptimal: '📍 Optimal marshrut:',
    routeStoreTotal: (n) => `   Jami: ${n.toLocaleString('en-US')} so'm`,
    routeGrandTotal: (n) => `💰 Umumiy: ${n.toLocaleString('en-US')} so'm`,
    routeSavings: (n) => `✅ Tejash: ~${n.toLocaleString('en-US')} so'm (barchasi bir joydan olsangiz)`,
    routeMaxDistance: (km) => `📏 Maksimal masofa: ${km} km`,
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
        `🏙️ Shahar: ${getCityLabel(item.city || 'Tashkent', 'uz')}\n` +
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
    receiptAccepted: (store, address, city, count) =>
      `✅ Чек принят!\n\n🏪 Магазин: ${store}\n📍 Адрес: ${address}\n🏙️ Город: ${city}\n📦 Товаров: ${count}\n⏳ Идет модерация...\n\nСпасибо! Вы помогаете обновлять цены 🙌`,
    unreadable: "Не удалось прочитать данные чека. ❌",
    alreadyAdded: "Этот чек уже был добавлен. ✅",
    serverError: "Ошибка настроек сервера. Попробуйте позже.",
    saveFailed: "Сейчас не удалось сохранить. Попробуйте позже.",
    scrapeFailed: "Не удалось прочитать чек. Проверьте ссылку и отправьте снова 🔄",
    queueAccepted: 'Чек добавлен в очередь. Скоро будет обработан.',
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
    statsCities: '🏙️ Города:',
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
    btnModerate: 'Модерация ✅',
    btnApprove: '✅ Одобрить',
    btnReject: '❌ Отклонить',
    btnBlock: '🚫 Блокировать',
    btnEditName: '✏️ Название',
    btnEditPrice: '💰 Сумма',
    btnEditQty: '📦 Кол-во',
    btnEditUnit: '🧮 За единицу',
    btnOpenReader: 'Открыть Reader 🌐',
    btnMyStats: '📊 Моя статистика',
    btnShopping: '🛒 План покупок',
    btnDistance: '📏 Дистанция',
    btnNotifyMenu: '📢 Рассылка',
    btnScheduledMenu: '📅 Заплан.',
    mapsView: '🗺️ Открыть на карте',
    mystatsTitle: '📊 Ваша статистика',
    mystatsReceipts: (n) => `🧾 Сканировано чеков: ${n}`,
    mystatsItems: (n) => `📦 Добавлено товаров: ${n}`,
    mystatsStreak: (n) => `🔥 Серия недель: ${n}`,
    mystatsHelped: (n) => `👥 Помогли людям: ${n}`,
    shoppingAsk: 'Что вы хотите купить на этой неделе?',
    shoppingAskHint: 'Напишите товары через запятую:\nНапример: сахар, рис, яйца, молоко, хлеб',
    distanceAsk: 'На какую максимальную дистанцию вы готовы ехать? (в км, например: 3)',
    distanceInvalid: 'Пожалуйста, введите корректное число км. Например: 3',
    distanceSaved: (km) => `✅ Сохранено. Максимальная дистанция: ${km} км`,
    notifyStart: '📢 Отправка сообщения\n\nВыберите один из вариантов:',
    notifyWeeklyOption: '📊 Недельный отчет',
    notifyBroadcastOption: '✍️ Обычное сообщение',
    notifyAskMessage: 'Введите текст сообщения:',
    notifyAskWhen: 'Когда отправить?',
    notifyNow: '⚡ Сейчас',
    notifySchedule: '📅 Запланировать',
    notifyNeedMessage: 'Сначала введите текст сообщения: /notify',
    notifyAskDate: 'Введите дату и время (например: 2026-04-15 09:00):',
    notifyInvalidDate: 'Неверный формат даты и времени. Пример: 2026-04-15 09:00',
    notifyScheduled: (ts) => `✅ Запланировано: ${ts}`,
    notifySent: (n) => `✅ Сообщение отправлено: ${n} пользователям`,
    notifyWeeklySent: (n) => `✅ Отчеты отправлены: ${n} пользователям`,
    scheduledEmpty: '📅 Нет запланированных сообщений',
    scheduledTitle: '📅 Запланированные сообщения:',
    scheduledCancel: '❌ Отменить',
    scheduledCancelled: '✅ Запланированное сообщение отменено',
    routeNoData: 'Недостаточно цен для этих товаров в выбранном городе.',
    routeTitle: '🛒 Ваш план покупок',
    routeOptimal: '📍 Оптимальный маршрут:',
    routeStoreTotal: (n) => `   Итого: ${n.toLocaleString('en-US')} сум`,
    routeGrandTotal: (n) => `💰 Общая сумма: ${n.toLocaleString('en-US')} сум`,
    routeSavings: (n) => `✅ Экономия: ~${n.toLocaleString('en-US')} сум`,
    routeMaxDistance: (km) => `📏 Максимальная дистанция: ${km} км`,
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
        `🏙️ Город: ${getCityLabel(item.city || 'Tashkent', 'ru')}\n` +
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
    receiptAccepted: (store, address, city, count) =>
      `✅ Receipt accepted!\n\n🏪 Store: ${store}\n📍 Address: ${address}\n🏙️ City: ${city}\n📦 Items: ${count}\n⏳ Waiting for moderation...\n\nThank you for helping keep prices current 🙌`,
    unreadable: 'Could not read the receipt data. ❌',
    alreadyAdded: 'This receipt was already added. ✅',
    serverError: 'Server configuration error. Please try again later.',
    saveFailed: 'Could not save right now. Please try again later.',
    scrapeFailed: 'Could not read the receipt. Please check the link and resend 🔄',
    queueAccepted: 'Receipt was queued and will be processed soon.',
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
    statsCities: '🏙️ Cities:',
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
    btnModerate: 'Moderate ✅',
    btnApprove: '✅ Approve',
    btnReject: '❌ Reject',
    btnBlock: '🚫 Block',
    btnEditName: '✏️ Name',
    btnEditPrice: '💰 Total',
    btnEditQty: '📦 Qty',
    btnEditUnit: '🧮 Unit',
    btnOpenReader: 'Open Reader 🌐',
    btnMyStats: '📊 My stats',
    btnShopping: '🛒 Shopping plan',
    btnDistance: '📏 Distance',
    btnNotifyMenu: '📢 Notify',
    btnScheduledMenu: '📅 Scheduled',
    mapsView: '🗺️ View on map',
    mystatsTitle: '📊 Your statistics',
    mystatsReceipts: (n) => `🧾 Receipts scanned: ${n}`,
    mystatsItems: (n) => `📦 Items contributed: ${n}`,
    mystatsStreak: (n) => `🔥 Weekly streak: ${n}`,
    mystatsHelped: (n) => `👥 People helped: ${n}`,
    shoppingAsk: 'What do you want to buy this week?',
    shoppingAskHint: 'Write products separated by commas:\nExample: sugar, rice, eggs, milk, bread',
    distanceAsk: 'What maximum distance are you willing to travel? (km, for example: 3)',
    distanceInvalid: 'Please enter a valid km value. Example: 3',
    distanceSaved: (km) => `✅ Saved. Maximum distance: ${km} km`,
    notifyStart: '📢 Send notification\n\nChoose one option:',
    notifyWeeklyOption: '📊 Weekly report',
    notifyBroadcastOption: '✍️ Broadcast message',
    notifyAskMessage: 'Type the message text:',
    notifyAskWhen: 'When should it be sent?',
    notifyNow: '⚡ Now',
    notifySchedule: '📅 Schedule',
    notifyNeedMessage: 'Please enter message text first: /notify',
    notifyAskDate: 'Enter date and time (for example: 2026-04-15 09:00):',
    notifyInvalidDate: 'Invalid date/time format. Example: 2026-04-15 09:00',
    notifyScheduled: (ts) => `✅ Scheduled: ${ts}`,
    notifySent: (n) => `✅ Message sent to ${n} users`,
    notifyWeeklySent: (n) => `✅ Weekly reports sent to ${n} users`,
    scheduledEmpty: '📅 No scheduled notifications',
    scheduledTitle: '📅 Scheduled notifications:',
    scheduledCancel: '❌ Cancel',
    scheduledCancelled: '✅ Scheduled notification cancelled',
    routeNoData: 'Not enough prices found in the selected city for these items.',
    routeTitle: '🛒 Your shopping plan',
    routeOptimal: '📍 Optimal route:',
    routeStoreTotal: (n) => `   Total: ${n.toLocaleString('en-US')} sum`,
    routeGrandTotal: (n) => `💰 Grand total: ${n.toLocaleString('en-US')} sum`,
    routeSavings: (n) => `✅ Estimated savings: ~${n.toLocaleString('en-US')} sum`,
    routeMaxDistance: (km) => `📏 Max distance: ${km} km`,
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
        `🏙️ City: ${getCityLabel(item.city || 'Tashkent', 'en')}\n` +
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


async function syncProductAvailableCities(productId, city) {
  const normalizedCity = normalizeCityName(city || '');
  if (!productId || !normalizedCity) return;

  const { data: product, error: fetchError } = await supabase
    .from('products')
    .select('available_cities')
    .eq('id', productId)
    .maybeSingle();

  if (fetchError) {
    throw fetchError;
  }

  const availableCities = Array.isArray(product?.available_cities)
    ? product.available_cities.filter(Boolean)
    : [];

  if (availableCities.includes(normalizedCity)) {
    return;
  }

  const { error: updateError } = await supabase
    .from('products')
    .update({ available_cities: [...availableCities, normalizedCity] })
    .eq('id', productId);

  if (updateError) {
    throw updateError;
  }
}

function formatCityBreakdown(rows, lang) {
  const counts = new Map();

  for (const row of rows || []) {
    const city = normalizeCityName(row?.city || '') || 'Tashkent';
    counts.set(city, (counts.get(city) || 0) + 1);
  }

  if (counts.size === 0) {
    return '-';
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8)
    .map(([city, count]) => `${getCityLabel(city, lang)} — ${count}`)
    .join('\n');
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
    [
      { text: BOT_COPY[lang].btnMyStats, callback_data: 'menu_mystats' },
    ],
  ];

  if (isAdminUser) {
    inline_keyboard.push([
      { text: BOT_COPY[lang].btnModerate, web_app: { url: `${miniAppUrl}?mode=moderate&lang=${lang}` } },
    ]);
    inline_keyboard.push([
      { text: BOT_COPY[lang].btnNotifyMenu, callback_data: 'menu_notify' },
      { text: BOT_COPY[lang].btnScheduledMenu, callback_data: 'menu_scheduled' },
    ]);
  }

  await sendTelegramMessage(chatId, {
    text: BOT_COPY[lang].menuText,
    reply_markup: { inline_keyboard },
  });
}

async function sendLanguagePicker(chatId) {
  await sendTelegramMessage(chatId, {
    text:
      `${BOT_COPY.uz.chooseLang}\n\n` +
      `${TAGLINE_BY_LANG.uz}\n` +
      `${TAGLINE_BY_LANG.ru}\n` +
      `${TAGLINE_BY_LANG.en}`,
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
      if (isSoliqUrl(entity.url)) return entity.url;
    }
    if (entity.type === 'url') {
      const url = text.substring(entity.offset, entity.offset + entity.length);
      if (isSoliqUrl(url)) return url;
    }
  }

  const match = text.match(/https?:\/\/[^\s"']+/i);
  if (match && isSoliqUrl(match[0])) {
    return match[0];
  }
  return null;
}

function getCommand(text) {
  const normalizedText = (text || '').trim().toLowerCase();
  const firstToken = normalizedText.split(' ')[0] || '';
  return firstToken.includes('@') ? firstToken.split('@')[0] : firstToken;
}

function parseDateTimeInput(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const withSeconds = normalized.length === 16 ? `${normalized}:00` : normalized;
  const date = new Date(withSeconds);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function applyTagline(text, lang) {
  const tagline = TAGLINE_BY_LANG[lang] || TAGLINE_BY_LANG.uz;
  return `${text}\n\n${tagline} 💚`;
}

async function upsertUserProfile(telegramId, userData, preferredCity = null) {
  if (!telegramId) return;

  const nowIso = new Date().toISOString();
  await supabase.from('user_profiles').upsert({
    telegram_id: telegramId,
    username: userData?.username || null,
    first_name: userData?.first_name || null,
    language_code: userData?.language_code || 'uz',
    preferred_city: normalizeCityName(preferredCity || '') || preferredCity || 'Tashkent',
    last_seen: nowIso,
  }, { onConflict: 'telegram_id' });

  const { data: existing } = await supabase
    .from('user_stats')
    .select('telegram_id')
    .eq('telegram_id', telegramId)
    .maybeSingle();

  if (!existing) {
    await supabase.from('user_stats').insert({
      telegram_id: telegramId,
      total_receipts_scanned: 0,
      total_items_contributed: 0,
      total_people_helped: 0,
      current_streak_weeks: 0,
      updated_at: nowIso,
    });
  }
}

async function incrementReceiptStats(telegramId, itemCount) {
  if (!telegramId) return;

  const { data: stats } = await supabase
    .from('user_stats')
    .select('*')
    .eq('telegram_id', telegramId)
    .maybeSingle();

  const today = new Date();
  const todayText = today.toISOString().split('T')[0];
  const currentWeek = getWeekNumber(today);
  const currentYear = today.getFullYear();

  let newStreak = stats?.current_streak_weeks || 0;
  const lastDate = stats?.last_receipt_date;

  if (lastDate) {
    const parsedLast = new Date(lastDate);
    const lastWeek = getWeekNumber(parsedLast);
    const lastYear = parsedLast.getFullYear();

    if (currentWeek === lastWeek && currentYear === lastYear) {
      // no-op in same week
    } else if (
      (currentWeek === lastWeek + 1 && currentYear === lastYear) ||
      (currentWeek === 1 && lastWeek >= 52 && currentYear === lastYear + 1)
    ) {
      newStreak += 1;
    } else {
      newStreak = 1;
    }
  } else {
    newStreak = 1;
  }

  const nextPayload = {
    total_receipts_scanned: (stats?.total_receipts_scanned || 0) + 1,
    total_items_contributed: (stats?.total_items_contributed || 0) + (Number(itemCount) || 0),
    current_streak_weeks: newStreak,
    last_streak_date: todayText,
    last_receipt_date: todayText,
    updated_at: new Date().toISOString(),
  };

  await supabase.from('user_stats').upsert({ telegram_id: telegramId, ...nextPayload }, { onConflict: 'telegram_id' });
}

async function saveShoppingList(telegramId, itemsText) {
  const items = String(itemsText || '').split(',').map(i => i.trim()).filter(Boolean);
  const now = new Date();
  const weekNumber = getWeekNumber(now);
  const year = now.getFullYear();

  const { data: existing } = await supabase
    .from('shopping_lists')
    .select('id')
    .eq('telegram_id', telegramId)
    .eq('week_number', weekNumber)
    .eq('year', year)
    .maybeSingle();

  if (existing?.id) {
    await supabase.from('shopping_lists').update({ items, created_at: now.toISOString() }).eq('id', existing.id);
  } else {
    await supabase.from('shopping_lists').insert({
      telegram_id: telegramId,
      items,
      week_number: weekNumber,
      year,
      created_at: now.toISOString(),
    });
  }

  return items;
}

async function calculateOptimalRoute(items, userCity, maxDistanceKm) {
  const cityOption = getCityOption(userCity);
  const cityCenter = cityOption ? { lat: cityOption.center[0], lng: cityOption.center[1] } : null;

  const itemPrices = [];
  for (const item of items) {
    const { data: prices } = await supabase
      .from('prices')
      .select('product_name_raw, price, place_name, place_address, latitude, longitude, receipt_date, city')
      .eq('city', userCity)
      .ilike('product_name_raw', `%${item}%`)
      .order('price', { ascending: true })
      .limit(20);

    if (prices && prices.length > 0) {
      const filtered = cityCenter && maxDistanceKm
        ? prices.filter(p => {
            if (p.latitude == null || p.longitude == null) return true;
            const d = haversineKm(cityCenter.lat, cityCenter.lng, p.latitude, p.longitude);
            return d <= maxDistanceKm;
          })
        : prices;
      const best = filtered.length > 0 ? filtered : prices;
      itemPrices.push({ item, cheapest: best[0], allPrices: best.slice(0, 5) });
    }
  }

  const storeGroups = {};
  for (const itemData of itemPrices) {
    const storeName = itemData.cheapest.place_name || "Noma'lum do'kon";
    if (!storeGroups[storeName]) {
      storeGroups[storeName] = {
        store: storeName,
        address: itemData.cheapest.place_address,
        latitude: itemData.cheapest.latitude,
        longitude: itemData.cheapest.longitude,
        items: [],
      };
    }
    storeGroups[storeName].items.push({ name: itemData.item, price: itemData.cheapest.price });
  }

  return { itemPrices, storeGroups };
}

function formatRouteMessage(routeData, maxDistanceKm, lang) {
  const tr = BOT_COPY[lang] || BOT_COPY.uz;
  const stores = Object.values(routeData.storeGroups || {});
  if (stores.length === 0) {
    return applyTagline(tr.routeNoData, lang);
  }

  let total = 0;
  let lines = [tr.routeTitle, '', tr.routeOptimal, ''];
  stores.forEach((store, index) => {
    const storeTotal = store.items.reduce((sum, item) => sum + (Number(item.price) || 0), 0);
    total += storeTotal;
    lines.push(`${index + 1}️⃣ ${store.store}`);
    for (const item of store.items) {
      lines.push(`   • ${item.name} — ${Number(item.price || 0).toLocaleString('en-US')} so'm`);
    }
    lines.push(tr.routeStoreTotal(storeTotal));
    lines.push('');
  });

  const estimatedSingleStore = Math.round(total * 1.25);
  const savings = Math.max(estimatedSingleStore - total, 0);
  lines.push(tr.routeGrandTotal(total));
  lines.push(tr.routeSavings(savings));
  lines.push('');
  lines.push(tr.routeMaxDistance(maxDistanceKm));

  return applyTagline(lines.join('\n'), lang);
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
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - (weekStart.getDay() || 7) + 1);
  weekStart.setHours(0, 0, 0, 0);

  const [{ count: pricesCount }, { count: pendingCount }, { count: rejectedCount }, { count: productsCount }, { count: blockedCount }, { count: appealsCount }, { data: approvedCities }, { data: pendingCities }, { count: totalUsers }, { count: activeThisWeek }, { data: sentRows }] = await Promise.all([
    supabase.from('prices').select('id', { count: 'exact', head: true }),
    supabase.from('pending_prices').select('id', { count: 'exact', head: true }).or('status.eq.pending,status.is.null'),
    supabase.from('pending_prices').select('id', { count: 'exact', head: true }).eq('status', 'rejected'),
    supabase.from('products').select('id', { count: 'exact', head: true }),
    supabase.from('blocked_users').select('telegram_id', { count: 'exact', head: true }),
    supabase.from('appeals').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('prices').select('city').limit(5000),
    supabase.from('pending_prices').select('city').or('status.eq.pending,status.is.null').limit(5000),
    supabase.from('user_profiles').select('telegram_id', { count: 'exact', head: true }),
    supabase.from('user_profiles').select('telegram_id', { count: 'exact', head: true }).gte('last_seen', weekStart.toISOString()),
    supabase.from('scheduled_notifications').select('sent_count, sent_at').gte('sent_at', weekStart.toISOString()),
  ]);

  const sentThisWeek = (sentRows || []).reduce((sum, row) => sum + (Number(row.sent_count) || 0), 0);

  const approvedCitySummary = formatCityBreakdown(approvedCities, lang);
  const pendingCitySummary = formatCityBreakdown(pendingCities, lang);

  await sendTelegramMessage(chatId, {
    text:
      `${BOT_COPY[lang].statsTitle}\n\n` +
      `✅ Approved: ${pricesCount || 0}\n` +
      `⏳ Pending: ${pendingCount || 0}\n` +
      `❌ Rejected: ${rejectedCount || 0}\n` +
      `📦 Products: ${productsCount || 0}\n` +
      `🚫 Blocked: ${blockedCount || 0}\n` +
      `📨 Appeals: ${appealsCount || 0}\n\n` +
      `📨 Xabarlar: ${sentThisWeek} (bu hafta)\n` +
      `👥 Jami foydalanuvchilar: ${totalUsers || 0}\n` +
      `🔥 Faol bu hafta: ${activeThisWeek || 0}\n\n` +
      `${BOT_COPY[lang].statsCities}\n` +
      `✅ Approved\n${approvedCitySummary}\n\n` +
      `⏳ Pending\n${pendingCitySummary}`,
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
  const tr = BOT_COPY[lang] || BOT_COPY.uz;

  if (!chatId || !telegramId) {
    return;
  }

  const { data: blocked } = await supabase
    .from('blocked_users')
    .select('telegram_id, can_appeal')
    .eq('telegram_id', telegramId)
    .maybeSingle();

  if (blocked && !normalizedText.startsWith('/appeal')) {
    await sendTelegramMessage(chatId, { text: BOT_COPY[lang].blockedAppeal });
    return;
  }

  await upsertUserProfile(telegramId, message?.from, 'Tashkent');

  const pendingAction = !command ? await getPendingAction(telegramId) : null;

  if (!command && pendingAction?.action === 'shopping') {
    const items = await saveShoppingList(telegramId, text);
    await setPendingAction(telegramId, null);

    const { data: profile } = await supabase
      .from('user_profiles')
      .select('preferred_city, max_distance_km')
      .eq('telegram_id', telegramId)
      .maybeSingle();
    const city = normalizeCityName(profile?.preferred_city || '') || 'Tashkent';
    const maxDistanceKm = Number(profile?.max_distance_km) || 5;
    const routeData = await calculateOptimalRoute(items, city, maxDistanceKm);
    const messageText = formatRouteMessage(routeData, maxDistanceKm, lang);
    await sendTelegramMessage(chatId, { text: messageText });

    const stores = Object.values(routeData.storeGroups || {}).filter(s => s.latitude && s.longitude);
    if (stores.length > 0) {
      const waypoints = stores.map(s => `${s.latitude},${s.longitude}`).join('~');
      const mapsUrl = `https://yandex.uz/maps/?rtext=${waypoints}&rtt=auto`;
      await sendTelegramMessage(chatId, {
        text: tr.mapsView,
        reply_markup: {
          inline_keyboard: [[{ text: tr.mapsView, url: mapsUrl }]],
        },
      });
    }
    return;
  }

  if (!command && pendingAction?.action === 'distance') {
    const km = Number.parseInt(normalizedText, 10);
    if (!Number.isFinite(km) || km <= 0 || km > 100) {
      await sendTelegramMessage(chatId, { text: tr.distanceInvalid });
      return;
    }
    await setPendingAction(telegramId, null);
    await supabase.from('user_profiles').update({ max_distance_km: km, last_seen: new Date().toISOString() }).eq('telegram_id', telegramId);
    await sendTelegramMessage(chatId, { text: tr.distanceSaved(km) });
    return;
  }

  if (!command && pendingAction?.action === 'notify_message') {
    await setPendingAction(telegramId, { action: 'notify_schedule_choice', message: text.trim() });
    await sendTelegramMessage(chatId, {
      text: tr.notifyAskWhen,
      reply_markup: {
        inline_keyboard: [[
          { text: tr.notifyNow, callback_data: 'notify_send_now' },
          { text: tr.notifySchedule, callback_data: 'notify_schedule' },
        ]],
      },
    });
    return;
  }

  if (!command && pendingAction?.action === 'notify_schedule_time') {
    const parsed = parseDateTimeInput(text);
    if (!parsed) {
      await sendTelegramMessage(chatId, { text: tr.notifyInvalidDate });
      return;
    }

    await supabase.from('scheduled_notifications').insert({
      message: pendingAction.message,
      scheduled_for: parsed.toISOString(),
      target: 'all',
      status: 'pending',
    });

    await setPendingAction(telegramId, null);
    await sendTelegramMessage(chatId, { text: tr.notifyScheduled(parsed.toISOString()) });
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

  if (command === '/mystats') {
    const { data: stats } = await supabase
      .from('user_stats')
      .select('*')
      .eq('telegram_id', telegramId)
      .maybeSingle();

    const messageText =
      `${tr.mystatsTitle}\n\n` +
      `${tr.mystatsReceipts(stats?.total_receipts_scanned || 0)}\n` +
      `${tr.mystatsItems(stats?.total_items_contributed || 0)}\n` +
      `${tr.mystatsStreak(stats?.current_streak_weeks || 0)}\n` +
      `${tr.mystatsHelped(stats?.total_people_helped || 0)}`;

    await sendTelegramMessage(chatId, { text: applyTagline(messageText, lang) });
    return;
  }

  if (command === '/savdo') {
    const itemsText = text.replace(/^\/savdo(@\w+)?/i, '').trim();
    if (!itemsText) {
      await setPendingAction(telegramId, { action: 'shopping' });
      await sendTelegramMessage(chatId, {
        text: `${tr.shoppingAsk}\n\n${tr.shoppingAskHint}`,
      });
      return;
    }

    const items = await saveShoppingList(telegramId, itemsText);
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('preferred_city, max_distance_km')
      .eq('telegram_id', telegramId)
      .maybeSingle();
    const city = normalizeCityName(profile?.preferred_city || '') || 'Tashkent';
    const maxDistanceKm = Number(profile?.max_distance_km) || 5;
    const routeData = await calculateOptimalRoute(items, city, maxDistanceKm);
    await sendTelegramMessage(chatId, { text: formatRouteMessage(routeData, maxDistanceKm, lang) });

    const stores = Object.values(routeData.storeGroups || {}).filter(s => s.latitude && s.longitude);
    if (stores.length > 0) {
      const waypoints = stores.map(s => `${s.latitude},${s.longitude}`).join('~');
      const mapsUrl = `https://yandex.uz/maps/?rtext=${waypoints}&rtt=auto`;
      await sendTelegramMessage(chatId, {
        text: tr.mapsView,
        reply_markup: {
          inline_keyboard: [[{ text: tr.mapsView, url: mapsUrl }]],
        },
      });
    }
    return;
  }

  if (command === '/masofa') {
    await setPendingAction(telegramId, { action: 'distance' });
    await sendTelegramMessage(chatId, { text: tr.distanceAsk });
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
    if (command === '/notify') {
      await setPendingAction(telegramId, null);
      await sendTelegramMessage(chatId, {
        text: tr.notifyStart,
        reply_markup: {
          inline_keyboard: [[
            { text: tr.notifyWeeklyOption, callback_data: 'notify_weekly' },
            { text: tr.notifyBroadcastOption, callback_data: 'notify_broadcast' },
          ]],
        },
      });
      return;
    }

    if (command === '/scheduled') {
      const { data: rows } = await supabase
        .from('scheduled_notifications')
        .select('id, message, scheduled_for, status')
        .eq('status', 'pending')
        .order('scheduled_for', { ascending: true })
        .limit(20);

      if (!rows || rows.length === 0) {
        await sendTelegramMessage(chatId, { text: tr.scheduledEmpty });
        return;
      }

      await sendTelegramMessage(chatId, { text: tr.scheduledTitle });
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const preview = String(row.message || '').slice(0, 120);
        await sendTelegramMessage(chatId, {
          text: `${index + 1}. ${row.scheduled_for}\n"${preview}"`,
          reply_markup: {
            inline_keyboard: [[{ text: tr.scheduledCancel, callback_data: `cancel_sched_${row.id}` }]],
          },
        });
      }
      return;
    }

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
      await sendAdminEditHelp(chatId);
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
      await sendPendingQueue(chatId, lang);
      return;
    }

    if (normalizedText.startsWith('/stats')) {
      await sendAdminStats(chatId, lang);
      return;
    }

    if (normalizedText.startsWith('/blocked')) {
      await sendBlockedUsers(chatId, lang);
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
      await sendAppealsQueue(chatId, lang);
      return;
    }
  }

  if (isSoliqUrl(normalizedText)) {
    const receiptUrl = extractSoliqUrl(message);
    if (!receiptUrl) {
      await sendTelegramMessage(chatId, { text: BOT_COPY[lang].missingReceipt });
      return;
    }

    if (!supabaseUrl || !supabaseKey) {
      await sendTelegramMessage(chatId, { text: BOT_COPY[lang].serverError });
      return;
    }

    const { data: blocked } = await supabase
      .from('blocked_users')
      .select('telegram_id')
      .eq('telegram_id', telegramId)
      .maybeSingle();
    if (blocked) {
      await sendTelegramMessage(chatId, { text: BOT_COPY[lang].blocked });
      return;
    }

    const { data: existingQueue } = await supabase
      .from('receipt_queue')
      .select('id')
      .eq('receipt_url', receiptUrl)
      .maybeSingle();
    if (existingQueue) {
      const { error: requeueError } = await supabase
        .from('receipt_queue')
        .update({
          telegram_id: telegramId || 'anonymous',
          city: 'Tashkent',
          status: 'pending',
          error_message: null,
          processed_at: null,
        })
        .eq('id', existingQueue.id);

      if (requeueError) {
        console.error('Bot queue requeue error:', requeueError);
        await sendTelegramMessage(chatId, { text: BOT_COPY[lang].saveFailed });
        return;
      }

      await sendTelegramMessage(chatId, { text: BOT_COPY[lang].queueAccepted });
      await incrementReceiptStats(telegramId, 0);
      return;
    }

    const city = 'Tashkent';
    const { error: queueError } = await supabase.from('receipt_queue').insert({
      receipt_url: receiptUrl,
      telegram_id: telegramId || 'anonymous',
      city,
      status: 'pending',
    });

    if (queueError) {
      console.error('Bot queue insert error:', queueError);
      await sendTelegramMessage(chatId, { text: BOT_COPY[lang].saveFailed });
      return;
    }

    await sendTelegramMessage(chatId, { text: BOT_COPY[lang].queueAccepted });
    await incrementReceiptStats(telegramId, 0);
    return;
  }

  await sendMenu(chatId, lang, telegramId);
}

async function handleCallback(callbackQuery) {
  const chatId = callbackQuery?.message?.chat?.id;
  const telegramId = callbackQuery?.from?.id?.toString();
  if (!chatId) return;

  const data = callbackQuery.data || '';

  if (callbackQuery.id) {
    await answerCallbackQuery(callbackQuery.id);
  }

  if (telegramId) {
    await upsertUserProfile(telegramId, callbackQuery?.from, 'Tashkent');
  }

  const lang = getUserLang(callbackQuery?.from?.language_code);
  const tr = BOT_COPY[lang] || BOT_COPY.uz;

  if (data.startsWith('lang:')) {
    const lang = data.split(':')[1];
    if (lang === 'uz' || lang === 'ru' || lang === 'en') {
      await sendMenu(chatId, lang, telegramId);
    }
    return;
  }

  if (data === 'menu_mystats') {
    const { data: stats } = await supabase
      .from('user_stats')
      .select('*')
      .eq('telegram_id', telegramId)
      .maybeSingle();

    const messageText =
      `${tr.mystatsTitle}\n\n` +
      `${tr.mystatsReceipts(stats?.total_receipts_scanned || 0)}\n` +
      `${tr.mystatsItems(stats?.total_items_contributed || 0)}\n` +
      `${tr.mystatsStreak(stats?.current_streak_weeks || 0)}\n` +
      `${tr.mystatsHelped(stats?.total_people_helped || 0)}`;
    await sendTelegramMessage(chatId, { text: applyTagline(messageText, lang) });
    return;
  }

  if (!telegramId || !(await isAdmin(telegramId))) {
    return;
  }

  const adminLang = lang;
  const adminTr = BOT_COPY[adminLang] || BOT_COPY.uz;

  if (data === 'menu_notify') {
    await setPendingAction(telegramId, null);
    await sendTelegramMessage(chatId, {
      text: adminTr.notifyStart,
      reply_markup: {
        inline_keyboard: [[
          { text: adminTr.notifyWeeklyOption, callback_data: 'notify_weekly' },
          { text: adminTr.notifyBroadcastOption, callback_data: 'notify_broadcast' },
        ]],
      },
    });
    return;
  }

  if (data === 'menu_scheduled') {
    const { data: rows } = await supabase
      .from('scheduled_notifications')
      .select('id, message, scheduled_for, status')
      .eq('status', 'pending')
      .order('scheduled_for', { ascending: true })
      .limit(20);

    if (!rows || rows.length === 0) {
      await sendTelegramMessage(chatId, { text: adminTr.scheduledEmpty });
      return;
    }

    await sendTelegramMessage(chatId, { text: adminTr.scheduledTitle });
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const preview = String(row.message || '').slice(0, 120);
      await sendTelegramMessage(chatId, {
        text: `${index + 1}. ${row.scheduled_for}\n"${preview}"`,
        reply_markup: {
          inline_keyboard: [[{ text: adminTr.scheduledCancel, callback_data: `cancel_sched_${row.id}` }]],
        },
      });
    }
    return;
  }

  if (data === 'notify_weekly') {
    const result = await sendWeeklyReports();
    await sendTelegramMessage(chatId, { text: adminTr.notifyWeeklySent(result.sentCount || 0) });
    return;
  }

  if (data === 'notify_broadcast') {
    await setPendingAction(telegramId, { action: 'notify_message' });
    await sendTelegramMessage(chatId, { text: adminTr.notifyAskMessage });
    return;
  }

  if (data === 'notify_send_now') {
    const pa = await getPendingAction(telegramId);
    if (!pa?.message) {
      await sendTelegramMessage(chatId, { text: adminTr.notifyNeedMessage });
      return;
    }
    const result = await sendBroadcast(pa.message);
    await setPendingAction(telegramId, null);
    await sendTelegramMessage(chatId, { text: adminTr.notifySent(result.sentCount || 0) });
    return;
  }

  if (data === 'notify_schedule') {
    const pa = await getPendingAction(telegramId);
    if (!pa?.message) {
      await sendTelegramMessage(chatId, { text: adminTr.notifyNeedMessage });
      return;
    }
    await setPendingAction(telegramId, { action: 'notify_schedule_time', message: pa.message });
    await sendTelegramMessage(chatId, { text: adminTr.notifyAskDate });
    return;
  }

  if (data.startsWith('cancel_sched_')) {
    const id = data.replace('cancel_sched_', '');
    await supabase.from('scheduled_notifications').update({ status: 'cancelled' }).eq('id', id);
    await sendTelegramMessage(chatId, { text: adminTr.scheduledCancelled });
    return;
  }

  if (data.startsWith('editname_')) {
    const pendingId = data.replace('editname_', '');
    await sendTelegramMessage(chatId, {
      text: BOT_COPY[adminLang].editNamePrompt(pendingId),
    });
    return;
  }

  if (data.startsWith('editprice_')) {
    const pendingId = data.replace('editprice_', '');
    await sendTelegramMessage(chatId, {
      text: BOT_COPY[adminLang].editPricePrompt(pendingId),
    });
    return;
  }

  if (data.startsWith('editqty_')) {
    const pendingId = data.replace('editqty_', '');
    await sendTelegramMessage(chatId, {
      text: BOT_COPY[adminLang].editQtyPrompt(pendingId),
    });
    return;
  }

  if (data.startsWith('editunit_')) {
    const pendingId = data.replace('editunit_', '');
    await sendTelegramMessage(chatId, {
      text: BOT_COPY[adminLang].editUnitPrompt(pendingId),
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
    const city = normalizeCityName(pending.city || '') || extractCityFromAddress(pending.place_address || '');
    const source = String(pending.source || '');
    const isStoreApiSource = source.startsWith('store_api_');
    const fallbackStoreName = isStoreApiSource
      ? source.replace('store_api_', '').replace(/_/g, ' ')
      : 'Unknown Store';
    const placeName = String(pending.place_name || '').trim() || fallbackStoreName;
    const placeAddress = String(pending.place_address || '').trim() || placeName;

    if (!productId) {
      const { data: created } = await supabase
        .from('products')
        .insert({
          name_uz: pending.product_name_raw,
          name_ru: '',
          name_en: '',
          category: 'Boshqa',
          unit: 'dona',
          available_cities: city ? [city] : [],
        })
        .select('id')
        .single();
      productId = created?.id || null;
    }

    const unitPrice = pending.unit_price || pending.price;
    if (isStoreApiSource) {
      const normalizeMaybeText = (value) => {
        const normalized = String(value || '').trim();
        return normalized || null;
      };
      const normalizedPlaceName = normalizeMaybeText(placeName);
      const normalizedPlaceAddress = normalizeMaybeText(placeAddress);

      const { data: currentStoreRows } = await supabase
        .from('prices')
        .select('id,place_name,place_address')
        .eq('product_id', productId)
        .eq('city', city)
        .eq('source', source);

      const rowsToArchive = (currentStoreRows || [])
        .filter(row => (
          normalizeMaybeText(row.place_name) === normalizedPlaceName
          && normalizeMaybeText(row.place_address) === normalizedPlaceAddress
        ))
        .map(row => row.id);

      if (rowsToArchive.length > 0) {
        await supabase
          .from('prices')
          .update({ source: `history_${source}` })
          .in('id', rowsToArchive);
      }

      await supabase.from('prices').insert({
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
      });
    } else {
      const { data: existingExactPrice } = await supabase
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

      if (!existingExactPrice?.id) {
        await supabase.from('prices').insert({
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
        });
      }
    }

    await syncProductAvailableCities(productId, city);

    await supabase.from('pending_prices').update({ status: 'approved', product_id: productId, city }).eq('id', id);

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
