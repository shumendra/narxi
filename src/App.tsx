/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState, useMemo, useRef } from 'react';
import { createClient } from '@supabase/supabase-js';
import { Search, MapPin, Plus, ChevronRight, Navigation, Camera, Check, QrCode, PencilLine, Loader2 } from 'lucide-react';
import { MapContainer, TileLayer, CircleMarker, Popup, useMap, useMapEvents } from 'react-leaflet';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { formatDistanceToNow } from 'date-fns';
import { enUS, ru, uz } from 'date-fns/locale';
import { CITY_OPTIONS, DEFAULT_CITY, getCityLabel, getCityOption } from './constants/cities.js';
import { haversineDistanceKm } from './utils/haversine.js';

// Utility for Tailwind classes
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Supabase Client
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
const adminTelegramIds = (import.meta.env.VITE_ADMIN_TELEGRAM_IDS || import.meta.env.VITE_ADMIN_TELEGRAM_ID || '7240925672')
  .split(',')
  .map((id: string) => id.trim())
  .filter(Boolean);
const supabase = createClient(supabaseUrl, supabaseKey);

// Types
interface Product {
  id: string;
  name_uz: string;
  name_ru: string;
  name_en?: string | null;
  search_text?: string | null;
  category: string;
  unit?: string | null;
  available_cities?: string[] | null;
}

interface PriceRecord {
  id: string;
  price: number;
  place_name: string;
  place_address: string;
  latitude: number | null;
  longitude: number | null;
  receipt_date: string;
  product_id: string;
  city?: string | null;
}

interface PendingModerationItem {
  id: string;
  product_name_raw: string;
  product_id: string | null;
  price: number;
  quantity: number;
  unit_price: number;
  submitted_by: string;
  source: string;
  status?: string | null;
  created_at: string;
  place_name: string | null;
  place_address: string | null;
  city?: string | null;
}

interface ApprovedModerationItem {
  id: string;
  product_id: string;
  product_name_raw: string;
  price: number;
  quantity: number;
  place_name: string | null;
  place_address: string | null;
  latitude?: number | null;
  longitude?: number | null;
  receipt_date: string;
  submitted_by: string;
  source: string;
  city?: string | null;
}

interface ProductAdminItem {
  id: string;
  name_uz: string;
  name_ru: string;
  name_en?: string | null;
  category: string;
  unit?: string | null;
  available_cities?: string[] | null;
  price_count?: number;
  pending_count?: number;
  latest_price?: {
    price: number;
    city?: string | null;
    receipt_date?: string;
  } | null;
  prices?: Array<{
    id: string;
    product_name_raw: string;
    price: number;
    city?: string | null;
    place_name?: string | null;
    receipt_date?: string;
  }>;
  pending?: Array<{
    id: string;
    product_name_raw: string;
    status?: string | null;
    city?: string | null;
    created_at?: string;
  }>;
}

interface ContactMessageItem {
  id: string;
  name?: string | null;
  contact: string;
  message: string;
  city?: string | null;
  language?: string | null;
  telegram_id?: string | null;
  telegram_username?: string | null;
  created_at: string;
}

function getWeekNumber(date: Date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

// Map Updater Component
function ChangeView({ center, zoom }: { center: [number, number]; zoom: number }) {
  const map = useMap();
  map.setView(center, zoom);
  return null;
}

function FlyToView({ center, zoom, trigger }: { center: [number, number]; zoom: number; trigger: number }) {
  const map = useMap();
  useEffect(() => {
    map.flyTo(center, zoom, { duration: 0.8 });
  }, [map, center[0], center[1], zoom, trigger]);
  return null;
}

function ReportMapPicker({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onPick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

export default function App() {
  const [mode, setMode] = useState<'find' | 'report' | 'moderate'>('find');
  const [lang, setLang] = useState<'uz' | 'ru' | 'en'>('uz');
  const [searchQuery, setSearchQuery] = useState('');
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [prices, setPrices] = useState<PriceRecord[]>([]);
  const [moderationItems, setModerationItems] = useState<PendingModerationItem[]>([]);
  const [approvedItems, setApprovedItems] = useState<ApprovedModerationItem[]>([]);
  const [productAdminItems, setProductAdminItems] = useState<ProductAdminItem[]>([]);
  const [moderationSection, setModerationSection] = useState<'prices' | 'products' | 'messages'>('prices');
  const [activeProductId, setActiveProductId] = useState<string | null>(null);
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [productFilterQuery, setProductFilterQuery] = useState('');
  const [productFilterCategory, setProductFilterCategory] = useState('all');
  const [productFilterCity, setProductFilterCity] = useState('all');
  const [productFilterHasPrices, setProductFilterHasPrices] = useState<'all' | 'yes' | 'no'>('all');
  const [productFilterHasPending, setProductFilterHasPending] = useState<'all' | 'yes' | 'no'>('all');
  const [productSortBy, setProductSortBy] = useState<'name' | 'category' | 'price_count' | 'pending_count' | 'latest_receipt'>('name');
  const [productSortDir, setProductSortDir] = useState<'asc' | 'desc'>('asc');
  const [moderationLoading, setModerationLoading] = useState(false);
  const [moderationSavingId, setModerationSavingId] = useState<string | null>(null);
  const [productAdminLoading, setProductAdminLoading] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [contactMessages, setContactMessages] = useState<ContactMessageItem[]>([]);
  const [selectedModerationIds, setSelectedModerationIds] = useState<string[]>([]);
  const [selectedApprovedIds, setSelectedApprovedIds] = useState<string[]>([]);
  const [newApprovedItem, setNewApprovedItem] = useState({
    product_name_raw: '',
    price: '',
    quantity: '1',
    place_name: '',
    place_address: '',
    city: DEFAULT_CITY,
  });
  const [newProductItem, setNewProductItem] = useState({
    name_uz: '',
    name_ru: '',
    name_en: '',
    category: 'Boshqa',
    unit: 'dona',
    available_cities: DEFAULT_CITY,
  });
  const [loading, setLoading] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [selectedCity, setSelectedCity] = useState(DEFAULT_CITY);
  const [nearbyEnabled, setNearbyEnabled] = useState(false);
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [findMapFocus, setFindMapFocus] = useState<{ lat: number; lng: number; zoom: number; trigger: number } | null>(null);
  const [geoError, setGeoError] = useState('');
  const [maxDistanceKm, setMaxDistanceKm] = useState(5);
  const priceFormatter = useMemo(() => new Intl.NumberFormat('en-US'), []);
  const telegramUserId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id?.toString() || '';
  const telegramUser = window.Telegram?.WebApp?.initDataUnsafe?.user;
  const telegramInitData = window.Telegram?.WebApp?.initData || '';
  const isAdminUser = adminTelegramIds.includes(telegramUserId);
  const selectedCityOption = useMemo(() => getCityOption(selectedCity), [selectedCity]);

  const copy = useMemo(
    () => ({
      uz: {
        appName: 'Narxi',
        modeFind: 'Topish',
        modeReport: "Qo'shish",
        modeModerate: 'Tasdiqlash',
        cityTitle: 'Shahar',
        nearbyToggle: 'Yaqin joylar',
        nearbyHint: 'Avval yaqin do‘konlar ko‘rsatiladi',
        nearbyDistance: 'masofa',
        nearbyError: 'Joylashuvni olishga ruxsat berilmadi',
        nearbyRetry: 'Joylashuvni qayta so‘rash',
        searchPlaceholder: 'Mahsulot nomi (masalan: Shakar)',
        emptyTitle: 'Narxlarni qidirish',
        emptyHint: 'Tanlangan shaharda eng yaxshi narxlarni topish uchun mahsulot nomini kiriting',
        cheapestTitle: 'Eng yaxshi 5 ta narx',
        mapTitle: 'Xarita',
        noData: "Hali narx kiritilmagan",
        noMapData: "Xaritada joylashuvlar yo'q",
        unknownStore: "Noma'lum do'kon",
        priceLabel: "Narx (so'mda)",
        pricePlaceholder: 'Masalan: 12500',
        locationLabel: 'Joylashuv',
        mapPick: 'Xaritadan',
        submit: 'Narxni yuborish',
        submitting: 'Yuborilmoqda...',
        tipTitle: 'Maslahat',
        tipBody: "Chekni skanerlash orqali narxlarni avtomatik qo'shishingiz mumkin. Buning uchun chekdagi QR kodni botga yuboring.",
        qrCardTitle: '📷 QR kod skanerlash',
        qrCardBody: 'Chekdagi QR kodni skaner qiling',
        qrCardHint: 'Tez va oson',
        manualCardTitle: "✏️ Qo'lda kiritish",
        manualCardBody: "Narxni o'zingiz kiriting",
        scanPopupText: 'Chekdagi QR kodni skaner qiling',
        scanLoadingTitle: "⏳ Chek o'qilmoqda...",
        scanLoadingHint: 'Iltimos kuting',
        scanLogTitle: 'Scan log',
        scanLogClient: 'Client',
        scanLogServer: 'Server',
        scanLogEmpty: 'Loglar hali yo‘q',
        scanSuccessTitle: '✅ Chek qabul qilindi!',
        scanSuccessQueued: 'Chek qabul qilindi va moderatsiyaga yuborildi. Mahsulotlar administrator tomonidan qo‘lda tekshiriladi.',
        scanItemsSubmitted: "ta mahsulot yuborildi",
        scanThanks: 'Rahmat! 🙌',
        scanDuplicateTitle: 'ℹ️ Bu chek avval yuborilgan',
        scanErrorTitle: "❌ Chekni o'qishda xatolik",
        scanErrorBody: 'QR kod soliq.uz ga tegishli emas\nyoki server xatosi yuz berdi.',
        scanErrorNotSoliq: 'QR kod soliq.uz havolasiga mos kelmadi.',
        scanErrorBlocked: 'Siz vaqtincha bloklangansiz.',
        scanErrorScrape: "Chek topildi, lekin server uni hozir o'qiy olmadi.\nIltimos qayta urinib ko'ring yoki havolani botga yuboring.",
        scanErrorParseEmpty: "Chek ochildi, lekin mahsulotlar ro'yxati topilmadi.\nIltimos qayta urinib ko'ring yoki havolani botga yuboring.",
        scanErrorTimeout: "Serverdan javob kutish vaqti tugadi.\nIltimos yana urinib ko'ring.",
        scanErrorGenerating: "Chek hali tayyorlanmoqda.\n1-2 daqiqadan so'ng qayta urinib ko'ring.",
        scanErrorNetwork: 'Tarmoq xatosi yuz berdi. Internetni tekshirib qayta urinib ko‘ring.',
        scanManualTitle: '📥 Navbatga yuborish',
        scanManualBody: 'QR skanerdan so‘ng chek havolasi navbatga tushadi. Narxlar administrator tomonidan keyinroq chiqariladi.',
        scanManualPasteAction: 'Page source kiritish',
        scanManualExtract: 'Source dan ajratish',
        scanManualExtracting: 'Source ajratilmoqda...',
        scanManualSourcePlaceholder: 'View Page Source dan olingan HTML ni shu yerga joylang',
        miniWindowTitle: 'Mini oynada ko‘rish',
        miniWindowOpenReceipt: 'Chekni mini oynada ochish',
        miniWindowOpenSource: 'Page Source ni mini oynada ochish',
        miniWindowCopySource: 'To‘liq source ni nusxalash',
        miniWindowCopyContent: 'Sahifadagi kontentni nusxalash',
        miniWindowLoadingSource: 'Source yuklanmoqda...',
        miniWindowCopySuccess: 'Source nusxalandi',
        miniWindowCopyError: 'Source nusxalanmadi',
        miniWindowContentCopySuccess: 'Sahifa kontenti nusxalandi',
        miniWindowContentCopyError: 'Sahifa kontentini nusxalab bo‘lmadi',
        miniWindowSourceFetchError: 'Page source ni olishda xatolik',
        miniWindowEmpty: 'Mini oyna hali ochilmagan',
        browserJsCopy: 'Browser JS ni nusxalash',
        browserJsCopied: 'Browser JS nusxalandi',
        browserJsonPlaceholder: 'JS natijasidagi JSON ni shu yerga joylang',
        browserJsonSubmit: 'JSON dan yuborish',
        browserJsonSubmitting: 'JSON yuborilmoqda...',
        browserJsonError: 'JSON format xato',
        readerSubmitHint: 'Reader sahifasida bitta tugma bilan yuboring',
        scanAgain: 'Yana skanerlash',
        goHome: 'Bosh sahifaga',
        retry: 'Qayta urinish',
        switchManual: "Qo'lda kiritish",
        openReceiptLink: 'Chek havolasini ochish',
        submitForAuth: 'Tasdiqlash uchun yuborish',
        urlFallbackPlaceholder: 'soliq.uz havolasini kiriting',
        urlFallbackSubmit: 'Yuborish',
        scannerInvalidAlert: "QR kod soliq.uz havolasi bo'lishi kerak",
        alertFill: "Iltimos, barcha maydonlarni to'ldiring",
        alertSuccess: "Narxingiz yuborildi va ko'rib chiqilgandan so'ng qo'shiladi ✅",
        alertError: "Xatolik yuz berdi. Qayta urinib ko'ring.",
        locationHint: "Joylashuv tanlanmagan",
        reportCityConfirm: 'Hisobot aynan shu shahar uchun yuboriladi.',
        scrapeLinkHint: 'Soliq.uz chek havolasini botga yuborsangiz, ma’lumot avtomatik o‘qiladi.',
        photoLabel: "Chek rasmi (ixtiyoriy)",
        sumLabel: "so'm",
        cityLabel: 'Shahar',
        moderationTitle: 'Kutilayotgan narxlar',
        moderationEmpty: 'Kutilayotgan narxlar yo‘q',
        moderationRefresh: 'Yangilash',
        moderationSave: 'Saqlash',
        moderationApprove: 'Tasdiqlash',
        moderationReject: 'Rad etish',
        moderationName: 'Mahsulot nomi',
        moderationPrice: 'Jami narx',
        moderationQty: 'Miqdor',
        moderationUnitPrice: 'Birlik narxi',
        moderationSource: 'Manba',
        moderationUser: 'Foydalanuvchi',
        moderationDate: 'Sana',
        moderationSaved: 'O‘zgarishlar saqlandi ✅',
        moderationApproved: 'Tasdiqlandi ✅',
        moderationRejected: 'Rad etildi ✅',
        moderationError: 'Moderatsiya amalida xatolik yuz berdi',
        approvedTitle: 'Tasdiqlangan narxlar',
        approvedEmpty: 'Tasdiqlangan narxlar yo‘q',
        moderationDeleteApproved: 'Tasdiqlanganni o‘chirish',
        moderationDeleted: 'O‘chirildi ✅',
        approvedSave: 'Saqlash',
        approvedCreate: "Yangi narx qo'shish",
        approvedDeleteSelected: "Tanlanganlarni o'chirish",
        approvedBulkDeleted: "Tanlangan narxlar o'chirildi ✅",
        moderationApproveSelected: 'Tanlanganlarni tasdiqlash',
        moderationSelectAll: 'Barchasini tanlash',
        moderationClearSelection: 'Tanlovni tozalash',
        productsTab: 'Mahsulotlar',
        pricesTab: 'Narxlar',
        messagesTab: 'Xabarlar',
        messagesTitle: 'Foydalanuvchi xabarlari',
        messagesEmpty: 'Xabarlar yo‘q',
        contactReceivedAt: 'Qabul qilingan',
        contactNameLabel: 'Ism',
        contactChannelLabel: 'Aloqa',
        contactMessageLabel: 'Xabar',
        contactUserLabel: 'Foydalanuvchi',
        contactLanguageLabel: 'Til',
        contactCityLabel: 'Shahar',
        productsTitle: 'Mahsulotlar va bog\'liq ma\'lumotlar',
        productsEmpty: 'Mahsulotlar topilmadi',
        productCreate: 'Yangi mahsulot qo\'shish',
        productSave: 'Mahsulotni saqlash',
        productDelete: 'Mahsulotni o\'chirish',
        productDeleted: 'Mahsulot o\'chirildi ✅',
        productNameUz: 'Nomi (UZ)',
        productNameRu: 'Nomi (RU)',
        productNameEn: 'Nomi (EN)',
        productCategory: 'Kategoriya',
        productUnit: 'O\'lchov birligi',
        productCities: 'Shaharlar (vergul bilan)',
        productPriceCount: 'Narxlar soni',
        productPendingCount: 'Kutilayotganlar soni',
        productLinkedPrices: 'Bog\'liq narxlar',
        productLinkedPending: 'Bog\'liq kutilayotganlar',
        productDeleteSelected: 'Tanlanganlarni o\'chirish',
        productSelectAll: 'Hammasini tanlash',
        productClearSelection: 'Tanlovni tozalash',
        productFilterSearch: 'Qidiruv',
        productFilterCategory: 'Kategoriya filtri',
        productFilterCity: 'Shahar filtri',
        productFilterHasPrices: 'Narxlar borligi',
        productFilterHasPending: 'Kutilayotganlar borligi',
        productSortBy: 'Saralash',
        productSortDir: 'Tartib',
        productSortAsc: 'Oshish bo\'yicha',
        productSortDesc: 'Kamayish bo\'yicha',
        productPurgeAll: 'Barcha mahsulot ma\'lumotlarini o\'chirish',
        productPurgeDone: 'Barcha mahsulot ma\'lumotlari o\'chirildi ✅',
        confirmDeleteSelectedProducts: 'Tanlangan mahsulotlarni va bog\'liq barcha narx ma\'lumotlarini o\'chirasizmi?',
        confirmPurgeAllProducts: 'Barcha mahsulotlar, narxlar va kutilayotgan yozuvlar to\'liq o\'chiriladi. Davom etasizmi?',
        yesLabel: 'Ha',
        noLabel: 'Yo\'q',
        allLabel: 'Barchasi',
        yesState: 'Bor',
        noState: 'Yo\'q',
        sortName: 'Nom',
        sortCategory: 'Kategoriya',
        sortPriceCount: 'Narxlar soni',
        sortPendingCount: 'Kutilayotganlar soni',
        sortLatestReceipt: 'Oxirgi sana',
        contactFormTitle: 'Biz bilan bog‘lanish',
        contactJump: 'Biz bilan bog‘lanish',
        contactFormHint: 'Qisqa xabar qoldiring, biz siz bilan qayta bog‘lanamiz.',
        reportProductNameLabel: 'Mahsulot nomi',
        reportProductNamePlaceholder: 'Masalan: Shakar',
        tagline: 'Narxni bil, pulni teja',
        viewedThisWeek: (count: number, product: string) => `👁 ${count} kishi bu hafta ${product} narxini tekshirdi`,
        proofLabel: 'Isbot (chek yoki foto havolasi)',
        proofPlaceholder: 'Chek URL yoki foto URL kiriting',
        proofRequired: 'Iltimos, isbot uchun chek yoki foto havolasini kiriting',
        uploadedAt: 'Chek sanasi',
        contactNamePlaceholder: 'Ismingiz (ixtiyoriy)',
        contactValuePlaceholder: 'Aloqa: Telegram @username yoki telefon',
        contactMessagePlaceholder: 'Xabaringiz',
        contactSend: 'Yuborish',
        contactSending: 'Yuborilmoqda...',
        contactSuccess: 'Xabaringiz yuborildi ✅',
        contactError: 'Xabar yuborilmadi. Qayta urinib ko‘ring.',
      },
      ru: {
        appName: 'Narxi',
        modeFind: 'Поиск',
        modeReport: 'Добавить',
        modeModerate: 'Модерация',
        cityTitle: 'Город',
        nearbyToggle: 'Рядом',
        nearbyHint: 'Сначала показывать ближайшие магазины',
        nearbyDistance: 'расстояние',
        nearbyError: 'Не удалось получить геолокацию',
        nearbyRetry: 'Запросить геолокацию снова',
        maxDistanceLabel: 'Макс. расстояние',
        maxDistanceKmUnit: 'км',
        searchPlaceholder: 'Название товара (например: Сахар)',
        emptyTitle: 'Поиск цен',
        emptyHint: 'Введите название товара, чтобы найти лучшие цены в выбранном городе',
        cheapestTitle: 'Топ 5 лучших цен',
        mapTitle: 'Карта',
        noData: 'Цен пока нет',
        noMapData: 'На карте нет локаций',
        unknownStore: 'Неизвестный магазин',
        priceLabel: 'Цена (в сумах)',
        pricePlaceholder: 'Например: 12500',
        locationLabel: 'Локация',
        mapPick: 'На карте',
        submit: 'Отправить цену',
        submitting: 'Отправка...',
        tipTitle: 'Совет',
        tipBody: 'Можно автоматически добавлять цены через чек. Отправьте QR-код чека боту.',
        qrCardTitle: '📷 Сканировать QR код',
        qrCardBody: 'Отсканируйте QR код на чеке',
        qrCardHint: 'Быстро и удобно',
        manualCardTitle: '✏️ Ввести вручную',
        manualCardBody: 'Введите цену самостоятельно',
        scanPopupText: 'Отсканируйте QR код на чеке',
        scanLoadingTitle: '⏳ Чтение чека...',
        scanLoadingHint: 'Пожалуйста, подождите',
        scanLogTitle: 'Лог сканирования',
        scanLogClient: 'Клиент',
        scanLogServer: 'Сервер',
        scanLogEmpty: 'Логи пока пустые',
        scanSuccessTitle: '✅ Чек принят!',
        scanSuccessQueued: 'Чек принят и отправлен на модерацию. Товары будут проверены администратором вручную.',
        scanItemsSubmitted: 'товаров отправлено',
        scanThanks: 'Спасибо! 🙌',
        scanDuplicateTitle: 'ℹ️ Этот чек уже отправляли',
        scanErrorTitle: '❌ Ошибка чтения чека',
        scanErrorBody: 'QR код не относится к soliq.uz\nили произошла ошибка сервера.',
        scanErrorNotSoliq: 'QR код не содержит корректную ссылку soliq.uz.',
        scanErrorBlocked: 'Вы временно заблокированы.',
        scanErrorScrape: 'Чек найден, но сервер пока не смог его прочитать.\nПовторите попытку или отправьте ссылку боту.',
        scanErrorParseEmpty: 'Чек открыт, но список товаров не найден.\nПовторите попытку или отправьте ссылку боту.',
        scanErrorTimeout: 'Истекло время ожидания ответа сервера.\nПопробуйте снова.',
        scanErrorGenerating: 'Чек ещё формируется.\nПовторите через 1-2 минуты.',
        scanErrorNetwork: 'Сетевая ошибка. Проверьте интернет и повторите попытку.',
        scanManualTitle: '📥 Отправка в очередь',
        scanManualBody: 'После сканирования ссылка чека отправляется в очередь. Цены будут извлечены позже администратором.',
        scanManualPasteAction: 'Вставить page source',
        scanManualExtract: 'Извлечь из source',
        scanManualExtracting: 'Извлечение из source...',
        scanManualSourcePlaceholder: 'Вставьте HTML из View Page Source сюда',
        miniWindowTitle: 'Просмотр в мини-окне',
        miniWindowOpenReceipt: 'Открыть чек в мини-окне',
        miniWindowOpenSource: 'Открыть page source в мини-окне',
        miniWindowCopySource: 'Скопировать весь source',
        miniWindowCopyContent: 'Скопировать контент страницы',
        miniWindowLoadingSource: 'Загрузка source...',
        miniWindowCopySuccess: 'Source скопирован',
        miniWindowCopyError: 'Не удалось скопировать source',
        miniWindowContentCopySuccess: 'Контент страницы скопирован',
        miniWindowContentCopyError: 'Не удалось скопировать контент страницы',
        miniWindowSourceFetchError: 'Ошибка получения page source',
        miniWindowEmpty: 'Мини-окно пока не открыто',
        browserJsCopy: 'Скопировать Browser JS',
        browserJsCopied: 'Browser JS скопирован',
        browserJsonPlaceholder: 'Вставьте JSON из результата JS сюда',
        browserJsonSubmit: 'Отправить из JSON',
        browserJsonSubmitting: 'Отправка JSON...',
        browserJsonError: 'Неверный формат JSON',
        readerSubmitHint: 'На reader-странице отправьте одним нажатием',
        scanAgain: 'Сканировать снова',
        goHome: 'На главную',
        retry: 'Повторить',
        switchManual: 'Ввести вручную',
        openReceiptLink: 'Открыть ссылку чека',
        submitForAuth: 'Отправить на подтверждение',
        urlFallbackPlaceholder: 'введите ссылку soliq.uz',
        urlFallbackSubmit: 'Отправить',
        scannerInvalidAlert: 'QR код должен содержать ссылку soliq.uz',
        alertFill: 'Пожалуйста, заполните все поля',
        alertSuccess: 'Цена отправлена и будет добавлена после проверки ✅',
        alertError: 'Произошла ошибка. Попробуйте еще раз.',
        locationHint: 'Локация не выбрана',
        reportCityConfirm: 'Отчет будет отправлен именно для этого города.',
        scrapeLinkHint: 'Если отправить боту ссылку на чек soliq.uz, данные заполнятся автоматически.',
        photoLabel: 'Фото чека (необязательно)',
        sumLabel: 'сум',
        cityLabel: 'Город',
        moderationTitle: 'Ожидающие цены',
        moderationEmpty: 'Нет ожидающих цен',
        moderationRefresh: 'Обновить',
        moderationSave: 'Сохранить',
        moderationApprove: 'Одобрить',
        moderationReject: 'Отклонить',
        moderationName: 'Название товара',
        moderationPrice: 'Общая цена',
        moderationQty: 'Количество',
        moderationUnitPrice: 'Цена за единицу',
        moderationSource: 'Источник',
        moderationUser: 'Пользователь',
        moderationDate: 'Дата',
        moderationSaved: 'Изменения сохранены ✅',
        moderationApproved: 'Одобрено ✅',
        moderationRejected: 'Отклонено ✅',
        moderationError: 'Ошибка во время модерации',
        approvedTitle: 'Одобренные цены',
        approvedEmpty: 'Нет одобренных цен',
        moderationDeleteApproved: 'Удалить одобренное',
        moderationDeleted: 'Удалено ✅',
        approvedSave: 'Сохранить',
        approvedCreate: 'Добавить новую цену',
        approvedDeleteSelected: 'Удалить выбранные',
        approvedBulkDeleted: 'Выбранные цены удалены ✅',
        moderationApproveSelected: 'Одобрить выбранные',
        moderationSelectAll: 'Выбрать все',
        moderationClearSelection: 'Очистить выбор',
        productsTab: 'Товары',
        pricesTab: 'Цены',
        messagesTab: 'Сообщения',
        messagesTitle: 'Сообщения от пользователей',
        messagesEmpty: 'Сообщений пока нет',
        contactReceivedAt: 'Получено',
        contactNameLabel: 'Имя',
        contactChannelLabel: 'Контакт',
        contactMessageLabel: 'Сообщение',
        contactUserLabel: 'Пользователь',
        contactLanguageLabel: 'Язык',
        contactCityLabel: 'Город',
        productsTitle: 'Товары и связанные данные',
        productsEmpty: 'Товары не найдены',
        productCreate: 'Добавить товар',
        productSave: 'Сохранить товар',
        productDelete: 'Удалить товар',
        productDeleted: 'Товар удален ✅',
        productNameUz: 'Название (UZ)',
        productNameRu: 'Название (RU)',
        productNameEn: 'Название (EN)',
        productCategory: 'Категория',
        productUnit: 'Единица',
        productCities: 'Города (через запятую)',
        productPriceCount: 'Кол-во цен',
        productPendingCount: 'Кол-во ожиданий',
        productLinkedPrices: 'Связанные цены',
        productLinkedPending: 'Связанные ожидания',
        productDeleteSelected: 'Удалить выбранные',
        productSelectAll: 'Выбрать все',
        productClearSelection: 'Снять выбор',
        productFilterSearch: 'Поиск',
        productFilterCategory: 'Фильтр категории',
        productFilterCity: 'Фильтр города',
        productFilterHasPrices: 'Есть цены',
        productFilterHasPending: 'Есть ожидания',
        productSortBy: 'Сортировка',
        productSortDir: 'Порядок',
        productSortAsc: 'По возрастанию',
        productSortDesc: 'По убыванию',
        productPurgeAll: 'Удалить все данные товаров',
        productPurgeDone: 'Все данные товаров удалены ✅',
        confirmDeleteSelectedProducts: 'Удалить выбранные товары и все связанные цены?',
        confirmPurgeAllProducts: 'Будут удалены все товары, цены и ожидающие записи. Продолжить?',
        yesLabel: 'Да',
        noLabel: 'Нет',
        allLabel: 'Все',
        yesState: 'Да',
        noState: 'Нет',
        sortName: 'Название',
        sortCategory: 'Категория',
        sortPriceCount: 'Кол-во цен',
        sortPendingCount: 'Кол-во ожиданий',
        sortLatestReceipt: 'Последняя дата',
        contactFormTitle: 'Связаться с нами',
        contactJump: 'Связаться с нами',
        contactFormHint: 'Оставьте короткое сообщение, и мы свяжемся с вами.',
        reportProductNameLabel: 'Название товара',
        reportProductNamePlaceholder: 'Например: Сахар',
        tagline: 'Знай цену, экономь деньги',
        viewedThisWeek: (count: number, product: string) => `👁 ${count} человек проверили цену ${product} на этой неделе`,
        proofLabel: 'Подтверждение (ссылка на чек или фото)',
        proofPlaceholder: 'Введите URL чека или фото',
        proofRequired: 'Пожалуйста, добавьте ссылку на чек или фото как подтверждение',
        uploadedAt: 'Дата чека',
        contactNamePlaceholder: 'Ваше имя (необязательно)',
        contactValuePlaceholder: 'Контакт: Telegram @username или телефон',
        contactMessagePlaceholder: 'Ваше сообщение',
        contactSend: 'Отправить',
        contactSending: 'Отправка...',
        contactSuccess: 'Сообщение отправлено ✅',
        contactError: 'Не удалось отправить сообщение. Попробуйте снова.',
      },
      en: {
        appName: 'Narxi',
        modeFind: 'Find',
        modeReport: 'Add',
        modeModerate: 'Moderate',
        cityTitle: 'City',
        nearbyToggle: 'Nearby',
        nearbyHint: 'Show the closest stores first',
        nearbyDistance: 'distance',
        nearbyError: 'Location access was not granted',
        nearbyRetry: 'Request location again',
        maxDistanceLabel: 'Max distance',
        maxDistanceKmUnit: 'km',
        searchPlaceholder: 'Product name (e.g., Sugar)',
        emptyTitle: 'Find prices',
        emptyHint: 'Type a product name to find the best prices in the selected city',
        cheapestTitle: 'Top 5 best prices',
        mapTitle: 'Map',
        noData: 'No prices yet',
        noMapData: 'No locations on the map',
        unknownStore: 'Unknown store',
        priceLabel: 'Price (in sums)',
        pricePlaceholder: 'Example: 12500',
        locationLabel: 'Location',
        mapPick: 'On map',
        submit: 'Submit price',
        submitting: 'Submitting...',
        tipTitle: 'Tip',
        tipBody: 'You can auto-add prices by scanning receipts. Send the QR code to the bot.',
        qrCardTitle: '📷 Scan QR code',
        qrCardBody: 'Scan the QR code on the receipt',
        qrCardHint: 'Fast and easy',
        manualCardTitle: '✏️ Manual entry',
        manualCardBody: 'Enter the price yourself',
        scanPopupText: 'Scan the QR code on the receipt',
        scanLoadingTitle: '⏳ Reading receipt...',
        scanLoadingHint: 'Please wait',
        scanLogTitle: 'Scan log',
        scanLogClient: 'Client',
        scanLogServer: 'Server',
        scanLogEmpty: 'No logs yet',
        scanSuccessTitle: '✅ Receipt accepted!',
        scanSuccessQueued: 'Receipt accepted and queued for moderation. Products will be verified manually by an admin.',
        scanItemsSubmitted: 'products submitted',
        scanThanks: 'Thanks! 🙌',
        scanDuplicateTitle: 'ℹ️ This receipt was already submitted',
        scanErrorTitle: '❌ Receipt read error',
        scanErrorBody: 'QR code is not a soliq.uz link\nor a server error occurred.',
        scanErrorNotSoliq: 'QR code does not contain a valid soliq.uz URL.',
        scanErrorBlocked: 'You are temporarily blocked.',
        scanErrorScrape: 'Receipt was detected, but the server could not read it right now.\nTry again or send the link to the bot.',
        scanErrorParseEmpty: 'Receipt opened, but no product list was found.\nTry again or send the link to the bot.',
        scanErrorTimeout: 'Server response timed out.\nPlease try again.',
        scanErrorGenerating: 'Receipt is still being generated.\nPlease try again in 1-2 minutes.',
        scanErrorNetwork: 'Network error. Check internet connection and try again.',
        scanManualTitle: '📥 Queue submission',
        scanManualBody: 'After scan, the receipt URL is queued. Prices will be extracted later by admin processing.',
        scanManualPasteAction: 'Paste page source',
        scanManualExtract: 'Extract from source',
        scanManualExtracting: 'Extracting from source...',
        scanManualSourcePlaceholder: 'Paste HTML from View Page Source here',
        miniWindowTitle: 'Mini window preview',
        miniWindowOpenReceipt: 'Open receipt in mini window',
        miniWindowOpenSource: 'Open page source in mini window',
        miniWindowCopySource: 'Copy full source text',
        miniWindowCopyContent: 'Copy page content text',
        miniWindowLoadingSource: 'Loading source...',
        miniWindowCopySuccess: 'Source copied',
        miniWindowCopyError: 'Failed to copy source',
        miniWindowContentCopySuccess: 'Page content copied',
        miniWindowContentCopyError: 'Failed to copy page content',
        miniWindowSourceFetchError: 'Failed to fetch page source',
        miniWindowEmpty: 'Mini window is not opened yet',
        browserJsCopy: 'Copy browser JS extractor',
        browserJsCopied: 'Browser JS copied',
        browserJsonPlaceholder: 'Paste JSON output from extractor script here',
        browserJsonSubmit: 'Submit from JSON',
        browserJsonSubmitting: 'Submitting JSON...',
        browserJsonError: 'Invalid JSON format',
        readerSubmitHint: 'On the reader page, submit with one tap',
        scanAgain: 'Scan again',
        goHome: 'Home',
        retry: 'Retry',
        switchManual: 'Manual entry',
        openReceiptLink: 'Open receipt link',
        submitForAuth: 'Submit for authorization',
        urlFallbackPlaceholder: 'enter soliq.uz link',
        urlFallbackSubmit: 'Submit',
        scannerInvalidAlert: 'QR code must contain a soliq.uz URL',
        alertFill: 'Please fill in all fields',
        alertSuccess: 'Your price was submitted and will be added after review ✅',
        alertError: 'Something went wrong. Please try again.',
        locationHint: 'Location not selected',
        reportCityConfirm: 'The submission will be saved for this city.',
        scrapeLinkHint: 'Send the bot a soliq.uz receipt link to scrape the data automatically.',
        photoLabel: 'Receipt photo (optional)',
        sumLabel: 'sum',
        cityLabel: 'City',
        moderationTitle: 'Pending prices',
        moderationEmpty: 'No pending prices',
        moderationRefresh: 'Refresh',
        moderationSave: 'Save',
        moderationApprove: 'Approve',
        moderationReject: 'Reject',
        moderationName: 'Product name',
        moderationPrice: 'Total price',
        moderationQty: 'Quantity',
        moderationUnitPrice: 'Unit price',
        moderationSource: 'Source',
        moderationUser: 'User',
        moderationDate: 'Date',
        moderationSaved: 'Changes saved ✅',
        moderationApproved: 'Approved ✅',
        moderationRejected: 'Rejected ✅',
        moderationError: 'Moderation action failed',
        approvedTitle: 'Approved prices',
        approvedEmpty: 'No approved prices',
        moderationDeleteApproved: 'Delete approved',
        moderationDeleted: 'Deleted ✅',
        approvedSave: 'Save',
        approvedCreate: 'Add new price',
        approvedDeleteSelected: 'Delete selected',
        approvedBulkDeleted: 'Selected prices deleted ✅',
        moderationApproveSelected: 'Approve selected',
        moderationSelectAll: 'Select all',
        moderationClearSelection: 'Clear selection',
        productsTab: 'Products',
        pricesTab: 'Prices',
        messagesTab: 'Messages',
        messagesTitle: 'User messages',
        messagesEmpty: 'No messages yet',
        contactReceivedAt: 'Received',
        contactNameLabel: 'Name',
        contactChannelLabel: 'Contact',
        contactMessageLabel: 'Message',
        contactUserLabel: 'User',
        contactLanguageLabel: 'Language',
        contactCityLabel: 'City',
        productsTitle: 'Products and linked data',
        productsEmpty: 'No products found',
        productCreate: 'Create product',
        productSave: 'Save product',
        productDelete: 'Delete product',
        productDeleted: 'Product deleted ✅',
        productNameUz: 'Name (UZ)',
        productNameRu: 'Name (RU)',
        productNameEn: 'Name (EN)',
        productCategory: 'Category',
        productUnit: 'Unit',
        productCities: 'Cities (comma-separated)',
        productPriceCount: 'Price count',
        productPendingCount: 'Pending count',
        productLinkedPrices: 'Linked prices',
        productLinkedPending: 'Linked pending',
        productDeleteSelected: 'Delete selected',
        productSelectAll: 'Select all',
        productClearSelection: 'Clear selection',
        productFilterSearch: 'Search',
        productFilterCategory: 'Category filter',
        productFilterCity: 'City filter',
        productFilterHasPrices: 'Has prices',
        productFilterHasPending: 'Has pending',
        productSortBy: 'Sort by',
        productSortDir: 'Order',
        productSortAsc: 'Ascending',
        productSortDesc: 'Descending',
        productPurgeAll: 'Delete all product data',
        productPurgeDone: 'All product data deleted ✅',
        confirmDeleteSelectedProducts: 'Delete selected products and all related pricing data?',
        confirmPurgeAllProducts: 'This will permanently remove all products, prices, and pending rows. Continue?',
        yesLabel: 'Yes',
        noLabel: 'No',
        allLabel: 'All',
        yesState: 'Yes',
        noState: 'No',
        sortName: 'Name',
        sortCategory: 'Category',
        sortPriceCount: 'Price count',
        sortPendingCount: 'Pending count',
        sortLatestReceipt: 'Latest receipt',
        contactFormTitle: 'Contact us',
        contactJump: 'Contact us',
        contactFormHint: 'Leave a short message and we will contact you back.',
        reportProductNameLabel: 'Product name',
        reportProductNamePlaceholder: 'Example: Sugar',
        tagline: 'Know the price, save the money',
        viewedThisWeek: (count: number, product: string) => `👁 ${count} people checked ${product} price this week`,
        proofLabel: 'Proof (receipt or photo URL)',
        proofPlaceholder: 'Enter receipt URL or photo URL',
        proofRequired: 'Please add a receipt or photo URL as proof',
        uploadedAt: 'Receipt date',
        contactNamePlaceholder: 'Your name (optional)',
        contactValuePlaceholder: 'Contact: Telegram @username or phone',
        contactMessagePlaceholder: 'Your message',
        contactSend: 'Send',
        contactSending: 'Sending...',
        contactSuccess: 'Message sent ✅',
        contactError: 'Failed to send message. Please try again.',
      },
    }),
    []
  );

  const t = copy[lang];
  const selectedCityLabel = getCityLabel(selectedCity, lang);

  // Report Form State
  const [reportPrice, setReportPrice] = useState('');
  const [reportLocation, setReportLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [reportProofUrl, setReportProofUrl] = useState('');
  const [reportEntryStep, setReportEntryStep] = useState<'entry' | 'manual' | 'loading' | 'result'>('entry');
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [scanUrlInput, setScanUrlInput] = useState('');
  const [scanResult, setScanResult] = useState<{
    status: 'success' | 'duplicate' | 'error' | 'manual';
    storeName?: string;
    storeAddress?: string;
    city?: string;
    itemCount?: number;
    queuedWithoutParse?: boolean;
    errorCode?: string;
    errorDetail?: string;
  } | null>(null);
  const [scanLogs, setScanLogs] = useState<Array<{ ts: string; source: 'client' | 'server'; message: string }>>([]);
  const [scanApiResponse, setScanApiResponse] = useState<unknown>(null);
  const [lastScannedReceiptUrl, setLastScannedReceiptUrl] = useState('');
  const [queuingForAuth, setQueuingForAuth] = useState(false);
  const [pageSourceHtml, setPageSourceHtml] = useState('');
  const [extractingFromSource, setExtractingFromSource] = useState(false);
  const [miniWindowMode, setMiniWindowMode] = useState<'none' | 'receipt' | 'source'>('none');
  const [miniWindowReceiptUrl, setMiniWindowReceiptUrl] = useState('');
  const [miniWindowSourceHtml, setMiniWindowSourceHtml] = useState('');
  const [loadingMiniWindowSource, setLoadingMiniWindowSource] = useState(false);
  const [browserExtractedJson, setBrowserExtractedJson] = useState('');
  const [submittingExtractedJson, setSubmittingExtractedJson] = useState(false);
  const [contactName, setContactName] = useState('');
  const [contactValue, setContactValue] = useState('');
  const [contactMessage, setContactMessage] = useState('');
  const [sendingContact, setSendingContact] = useState(false);
  const [selectedProductWeeklyViews, setSelectedProductWeeklyViews] = useState<number>(0);
  const miniWindowIframeRef = useRef<HTMLIFrameElement | null>(null);
  const contactFormRef = useRef<HTMLElement | null>(null);


  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const initialMode = params.get('mode') as 'find' | 'report' | 'moderate';
    const initialLang = params.get('lang') as 'uz' | 'ru' | 'en';
    const initialCity = params.get('city');
    if (initialMode && (initialMode !== 'moderate' || isAdminUser)) setMode(initialMode);
    if (initialLang) setLang(initialLang);
    if (initialCity) {
      const normalizedCity = CITY_OPTIONS.find(city => city.value === initialCity)?.value;
      if (normalizedCity) setSelectedCity(normalizedCity);
    }

    fetchProducts();
  }, [isAdminUser]);

  useEffect(() => {
    const upsertMiniAppUser = async () => {
      if (!telegramUserId) return;

      const nowIso = new Date().toISOString();
      const { error: profileError } = await supabase.from('user_profiles').upsert({
        telegram_id: telegramUserId,
        username: telegramUser?.username || null,
        first_name: telegramUser?.first_name || null,
        language_code: telegramUser?.language_code || lang,
        preferred_city: selectedCity,
        last_seen: nowIso,
      }, { onConflict: 'telegram_id' });

      if (profileError) return;

      const { data: profile } = await supabase
        .from('user_profiles')
        .select('max_distance_km')
        .eq('telegram_id', telegramUserId)
        .maybeSingle();

      if (profile?.max_distance_km) {
        setMaxDistanceKm(Number(profile.max_distance_km));
      }

      const { data: existingStats } = await supabase
        .from('user_stats')
        .select('telegram_id')
        .eq('telegram_id', telegramUserId)
        .maybeSingle();

      if (!existingStats) {
        await supabase.from('user_stats').insert({
          telegram_id: telegramUserId,
          total_receipts_scanned: 0,
          total_items_contributed: 0,
          total_people_helped: 0,
          current_streak_weeks: 0,
          updated_at: nowIso,
        });
      }
    };

    upsertMiniAppUser();
  }, [telegramUserId, telegramUser?.username, telegramUser?.first_name, telegramUser?.language_code, lang, selectedCity]);

  const fetchProducts = async () => {
    const { data } = await supabase.from('products').select('*').order('name_uz');
    if (data) {
      setProducts(data);
      return data as Product[];
    }
    return [] as Product[];
  };

  const loadPricesForProduct = async (productId: string) => {
    setLoading(true);
    const { data } = await supabase
      .from('prices')
      .select('*')
      .eq('product_id', productId)
      .eq('city', selectedCity)
      .order('price', { ascending: true })
      .limit(100);

    setPrices((data || []) as PriceRecord[]);
    setLoading(false);
  };

  const normalizePendingItem = (item: any): PendingModerationItem => ({
    ...item,
    product_name_raw:
      String(item.product_name_raw || '').trim() ||
      (String(item.source || '').startsWith('soliq_qr_unparsed') ? 'RECEIPT_PARSE_REVIEW' : 'UNKNOWN_PRODUCT'),
    price: Number(item.price) || (String(item.source || '').startsWith('soliq_qr_unparsed') ? 1 : 0),
    quantity: Number(item.quantity) || 1,
    unit_price:
      Number(item.unit_price) ||
      Number(item.price) ||
      (String(item.source || '').startsWith('soliq_qr_unparsed') ? 1 : 0),
  });

  const normalizeApprovedItem = (item: any): ApprovedModerationItem => ({
    ...item,
    price: Number(item.price) || 0,
    quantity: Number(item.quantity) || 1,
  });

  const normalizeProductAdminItem = (item: any): ProductAdminItem => ({
    ...item,
    available_cities: Array.isArray(item.available_cities) ? item.available_cities : [],
    prices: Array.isArray(item.prices) ? item.prices : [],
    pending: Array.isArray(item.pending) ? item.pending : [],
    price_count: Number(item.price_count) || 0,
    pending_count: Number(item.pending_count) || 0,
  });

  const callModerationApi = async (action: string, payload: Record<string, unknown> = {}) => {
    const response = await fetch('/api/moderation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, initData: telegramInitData, ...payload }),
    });

    const json = await response.json();
    if (!response.ok || !json.ok) {
      throw new Error(json.error || 'Moderation request failed');
    }

    return json;
  };

  const fetchModerationItems = async () => {
    if (!isAdminUser || !telegramInitData) return;
    setModerationLoading(true);
    try {
      const [pendingResult, approvedResult] = await Promise.all([
        callModerationApi('list', { city: selectedCity }),
        callModerationApi('listApproved', { city: selectedCity }),
      ]);
      setModerationItems((pendingResult.items || []).map(normalizePendingItem));
      setApprovedItems((approvedResult.items || []).map(normalizeApprovedItem));
      setSelectedModerationIds([]);
      setSelectedApprovedIds([]);
    } catch {
      window.Telegram?.WebApp?.showAlert(t.moderationError);
    } finally {
      setModerationLoading(false);
    }
  };

  const fetchModerationProducts = async () => {
    if (!isAdminUser || !telegramInitData) return;
    setProductAdminLoading(true);
    try {
      const result = await callModerationApi('listProducts');
      const normalized = (result.items || []).map(normalizeProductAdminItem);
      setProductAdminItems(normalized);
      setSelectedProductIds(prev => prev.filter(id => normalized.some(item => item.id === id)));
      setActiveProductId(prev => (prev && normalized.some(item => item.id === prev) ? prev : (normalized[0]?.id || null)));
    } catch {
      window.Telegram?.WebApp?.showAlert(t.moderationError);
    } finally {
      setProductAdminLoading(false);
    }
  };

  const fetchModerationMessages = async () => {
    if (!isAdminUser || !telegramInitData) return;
    setMessagesLoading(true);
    try {
      const result = await callModerationApi('listContactMessages');
      setContactMessages((result.items || []) as ContactMessageItem[]);
    } catch {
      window.Telegram?.WebApp?.showAlert(t.moderationError);
    } finally {
      setMessagesLoading(false);
    }
  };

  const productCategoryOptions = useMemo(() => {
    return (Array.from(new Set(productAdminItems.map(item => String(item.category || '').trim()).filter(Boolean))) as string[])
      .sort((a, b) => a.localeCompare(b));
  }, [productAdminItems]);

  const productCityOptions = useMemo(() => {
    return (Array.from(new Set(productAdminItems.flatMap(item => item.available_cities || []).map(city => String(city || '').trim()).filter(Boolean))) as string[])
      .sort((a, b) => a.localeCompare(b));
  }, [productAdminItems]);

  const filteredSortedProductAdminItems = useMemo(() => {
    const query = productFilterQuery.trim().toLowerCase();
    const rows = productAdminItems.filter(item => {
      const byQuery = !query || [item.name_uz, item.name_ru, item.name_en, item.category, item.unit, item.id]
        .filter(Boolean)
        .some(value => String(value).toLowerCase().includes(query));

      const byCategory = productFilterCategory === 'all' || String(item.category || '') === productFilterCategory;
      const byCity = productFilterCity === 'all' || (item.available_cities || []).includes(productFilterCity);
      const byHasPrices = productFilterHasPrices === 'all'
        || (productFilterHasPrices === 'yes' && (Number(item.price_count) || 0) > 0)
        || (productFilterHasPrices === 'no' && (Number(item.price_count) || 0) === 0);
      const byHasPending = productFilterHasPending === 'all'
        || (productFilterHasPending === 'yes' && (Number(item.pending_count) || 0) > 0)
        || (productFilterHasPending === 'no' && (Number(item.pending_count) || 0) === 0);

      return byQuery && byCategory && byCity && byHasPrices && byHasPending;
    });

    const sorted = [...rows].sort((left, right) => {
      let compare = 0;
      if (productSortBy === 'name') compare = String(left.name_uz || '').localeCompare(String(right.name_uz || ''));
      if (productSortBy === 'category') compare = String(left.category || '').localeCompare(String(right.category || ''));
      if (productSortBy === 'price_count') compare = (Number(left.price_count) || 0) - (Number(right.price_count) || 0);
      if (productSortBy === 'pending_count') compare = (Number(left.pending_count) || 0) - (Number(right.pending_count) || 0);
      if (productSortBy === 'latest_receipt') {
        const leftTime = left.latest_price?.receipt_date ? new Date(left.latest_price.receipt_date).getTime() : 0;
        const rightTime = right.latest_price?.receipt_date ? new Date(right.latest_price.receipt_date).getTime() : 0;
        compare = leftTime - rightTime;
      }
      return productSortDir === 'asc' ? compare : -compare;
    });

    return sorted;
  }, [productAdminItems, productFilterQuery, productFilterCategory, productFilterCity, productFilterHasPrices, productFilterHasPending, productSortBy, productSortDir]);

  const activeProductItem = useMemo(() => {
    return filteredSortedProductAdminItems.find(item => item.id === activeProductId)
      || productAdminItems.find(item => item.id === activeProductId)
      || null;
  }, [filteredSortedProductAdminItems, productAdminItems, activeProductId]);

  const updateModerationField = (id: string, field: keyof PendingModerationItem, value: string) => {
    setModerationItems(items => items.map(item => {
      if (item.id !== id) return item;
      if (field === 'price' || field === 'quantity' || field === 'unit_price') {
        const numericValue = Number(value);
        return { ...item, [field]: Number.isFinite(numericValue) ? numericValue : 0 };
      }
      return { ...item, [field]: value };
    }));
  };

  const saveModerationItem = async (item: PendingModerationItem) => {
    setModerationSavingId(item.id);
    try {
      await callModerationApi('update', {
        id: item.id,
        changes: {
          product_name_raw: item.product_name_raw,
          price: item.price,
          quantity: item.quantity,
          unit_price: item.unit_price,
        },
      });
      await fetchModerationItems();
      window.Telegram?.WebApp?.showAlert(t.moderationSaved);
    } catch {
      window.Telegram?.WebApp?.showAlert(t.moderationError);
    } finally {
      setModerationSavingId(null);
    }
  };

  const approveModerationItem = async (item: PendingModerationItem) => {
    setModerationSavingId(item.id);
    try {
      const updated = await callModerationApi('update', {
        id: item.id,
        changes: {
          product_name_raw: item.product_name_raw,
          price: item.price,
          quantity: item.quantity,
          unit_price: item.unit_price,
        },
      });
      const result = await callModerationApi('approve', { id: item.id });
      const refreshedProducts = await fetchProducts();
      await fetchModerationItems();

      const approvedProduct = refreshedProducts.find(product => product.id === result.productId);
      if (approvedProduct) {
        setMode('find');
        setSelectedProduct(approvedProduct);
        setSearchQuery(getProductName(approvedProduct, lang));
        setShowDropdown(false);
        await loadPricesForProduct(approvedProduct.id);
      } else if (selectedProduct) {
        await loadPricesForProduct(selectedProduct.id);
      }

      if (updated?.item?.product_name_raw) {
        setSearchQuery(updated.item.product_name_raw);
      }

      window.Telegram?.WebApp?.showAlert(t.moderationApproved);
    } catch {
      window.Telegram?.WebApp?.showAlert(t.moderationError);
    } finally {
      setModerationSavingId(null);
    }
  };

  const rejectModerationItem = async (item: PendingModerationItem) => {
    setModerationSavingId(item.id);
    try {
      await callModerationApi('reject', { id: item.id });
      await fetchModerationItems();
      window.Telegram?.WebApp?.showAlert(t.moderationRejected);
    } catch {
      window.Telegram?.WebApp?.showAlert(t.moderationError);
    } finally {
      setModerationSavingId(null);
    }
  };

  const toggleModerationSelection = (id: string) => {
    setSelectedModerationIds(prev => (
      prev.includes(id)
        ? prev.filter(itemId => itemId !== id)
        : [...prev, id]
    ));
  };

  const selectAllModerationItems = () => {
    setSelectedModerationIds(moderationItems.map(item => item.id));
  };

  const clearModerationSelection = () => {
    setSelectedModerationIds([]);
  };

  const approveSelectedModerationItems = async () => {
    if (selectedModerationIds.length === 0) return;
    setModerationSavingId('bulk-approve');
    try {
      await callModerationApi('approveMany', { ids: selectedModerationIds });
      await fetchModerationItems();
      window.Telegram?.WebApp?.showAlert(t.moderationApproved);
    } catch {
      window.Telegram?.WebApp?.showAlert(t.moderationError);
    } finally {
      setModerationSavingId(null);
    }
  };

  const deleteApprovedItem = async (item: ApprovedModerationItem) => {
    setModerationSavingId(item.id);
    try {
      await callModerationApi('deleteApproved', { id: item.id });
      await fetchModerationItems();
      if (selectedProduct?.id === item.product_id) {
        await loadPricesForProduct(item.product_id);
      }
      window.Telegram?.WebApp?.showAlert(t.moderationDeleted);
    } catch {
      window.Telegram?.WebApp?.showAlert(t.moderationError);
    } finally {
      setModerationSavingId(null);
    }
  };

  const toggleApprovedSelection = (id: string) => {
    setSelectedApprovedIds(prev => (
      prev.includes(id)
        ? prev.filter(itemId => itemId !== id)
        : [...prev, id]
    ));
  };

  const clearApprovedSelection = () => {
    setSelectedApprovedIds([]);
  };

  const deleteSelectedApprovedItems = async () => {
    if (selectedApprovedIds.length === 0) return;
    setModerationSavingId('bulk-delete-approved');
    try {
      await callModerationApi('deleteApprovedMany', { ids: selectedApprovedIds });
      await fetchModerationItems();
      setSelectedApprovedIds([]);
      window.Telegram?.WebApp?.showAlert(t.approvedBulkDeleted);
    } catch {
      window.Telegram?.WebApp?.showAlert(t.moderationError);
    } finally {
      setModerationSavingId(null);
    }
  };

  const updateApprovedField = (id: string, field: keyof ApprovedModerationItem, value: string) => {
    setApprovedItems(items => items.map(item => {
      if (item.id !== id) return item;
      if (field === 'price' || field === 'quantity') {
        const numericValue = Number(value);
        return { ...item, [field]: Number.isFinite(numericValue) ? numericValue : 0 };
      }
      if (field === 'latitude' || field === 'longitude') {
        const numericValue = Number(value);
        return { ...item, [field]: Number.isFinite(numericValue) ? numericValue : null };
      }
      return { ...item, [field]: value };
    }));
  };

  const saveApprovedItem = async (item: ApprovedModerationItem) => {
    setModerationSavingId(item.id);
    try {
      await callModerationApi('updateApproved', {
        id: item.id,
        changes: {
          product_name_raw: item.product_name_raw,
          price: item.price,
          quantity: item.quantity,
          place_name: item.place_name,
          place_address: item.place_address,
          city: item.city,
          receipt_date: item.receipt_date,
          latitude: item.latitude,
          longitude: item.longitude,
          submitted_by: item.submitted_by,
          source: item.source,
        },
      });
      await fetchModerationItems();
      window.Telegram?.WebApp?.showAlert(t.moderationSaved);
    } catch {
      window.Telegram?.WebApp?.showAlert(t.moderationError);
    } finally {
      setModerationSavingId(null);
    }
  };

  const createApprovedItem = async () => {
    const price = Number(newApprovedItem.price);
    const quantity = Number(newApprovedItem.quantity);
    if (!newApprovedItem.product_name_raw.trim() || !Number.isFinite(price) || price <= 0) {
      window.Telegram?.WebApp?.showAlert(t.alertFill);
      return;
    }

    setModerationSavingId('create-approved');
    try {
      await callModerationApi('createApproved', {
        payload: {
          product_name_raw: newApprovedItem.product_name_raw.trim(),
          price,
          quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
          place_name: newApprovedItem.place_name.trim() || null,
          place_address: newApprovedItem.place_address.trim() || null,
          city: newApprovedItem.city || selectedCity,
          source: 'admin_manual',
          submitted_by: telegramUserId || 'admin',
        },
      });
      setNewApprovedItem({
        product_name_raw: '',
        price: '',
        quantity: '1',
        place_name: '',
        place_address: '',
        city: selectedCity,
      });
      await fetchModerationItems();
      window.Telegram?.WebApp?.showAlert(t.moderationSaved);
    } catch {
      window.Telegram?.WebApp?.showAlert(t.moderationError);
    } finally {
      setModerationSavingId(null);
    }
  };

  const updateProductField = (id: string, field: keyof ProductAdminItem, value: string) => {
    setProductAdminItems(items => items.map(item => {
      if (item.id !== id) return item;
      if (field === 'available_cities') {
        return {
          ...item,
          available_cities: value.split(',').map(city => city.trim()).filter(Boolean),
        };
      }
      return { ...item, [field]: value };
    }));
  };

  const saveProductItem = async (item: ProductAdminItem) => {
    setModerationSavingId(item.id);
    try {
      await callModerationApi('updateProduct', {
        id: item.id,
        changes: {
          name_uz: item.name_uz,
          name_ru: item.name_ru,
          name_en: item.name_en,
          category: item.category,
          unit: item.unit,
          available_cities: item.available_cities || [],
        },
      });
      await fetchModerationProducts();
      await fetchProducts();
      window.Telegram?.WebApp?.showAlert(t.moderationSaved);
    } catch {
      window.Telegram?.WebApp?.showAlert(t.moderationError);
    } finally {
      setModerationSavingId(null);
    }
  };

  const deleteProductItem = async (item: ProductAdminItem) => {
    setModerationSavingId(item.id);
    try {
      await callModerationApi('deleteProduct', { id: item.id });
      await fetchModerationProducts();
      await fetchProducts();
      window.Telegram?.WebApp?.showAlert(t.productDeleted);
    } catch {
      window.Telegram?.WebApp?.showAlert(t.moderationError);
    } finally {
      setModerationSavingId(null);
    }
  };

  const toggleProductSelection = (id: string) => {
    setSelectedProductIds(prev => (prev.includes(id) ? prev.filter(itemId => itemId !== id) : [...prev, id]));
  };

  const selectAllFilteredProducts = () => {
    setSelectedProductIds(filteredSortedProductAdminItems.map(item => item.id));
  };

  const clearProductSelection = () => {
    setSelectedProductIds([]);
  };

  const deleteSelectedProducts = async () => {
    if (selectedProductIds.length === 0) return;
    if (!window.confirm(t.confirmDeleteSelectedProducts)) return;

    setModerationSavingId('bulk-delete-products');
    try {
      await callModerationApi('deleteProductsMany', { ids: selectedProductIds });
      await fetchModerationProducts();
      await fetchProducts();
      setSelectedProductIds([]);
      setActiveProductId(null);
      window.Telegram?.WebApp?.showAlert(t.productDeleted);
    } catch {
      window.Telegram?.WebApp?.showAlert(t.moderationError);
    } finally {
      setModerationSavingId(null);
    }
  };

  const purgeAllProductsData = async () => {
    if (!window.confirm(t.confirmPurgeAllProducts)) return;

    setModerationSavingId('purge-all-products');
    try {
      await callModerationApi('purgeAllProductsData');
      await fetchModerationProducts();
      await fetchProducts();
      setSelectedProductIds([]);
      setActiveProductId(null);
      window.Telegram?.WebApp?.showAlert(t.productPurgeDone);
    } catch {
      window.Telegram?.WebApp?.showAlert(t.moderationError);
    } finally {
      setModerationSavingId(null);
    }
  };

  const createProductItem = async () => {
    if (!newProductItem.name_uz.trim()) {
      window.Telegram?.WebApp?.showAlert(t.alertFill);
      return;
    }

    setModerationSavingId('create-product');
    try {
      await callModerationApi('createProduct', {
        payload: {
          name_uz: newProductItem.name_uz.trim(),
          name_ru: newProductItem.name_ru.trim() || newProductItem.name_uz.trim(),
          name_en: newProductItem.name_en.trim() || newProductItem.name_uz.trim(),
          category: newProductItem.category.trim() || 'Boshqa',
          unit: newProductItem.unit.trim() || 'dona',
          available_cities: newProductItem.available_cities.split(',').map(city => city.trim()).filter(Boolean),
        },
      });
      setNewProductItem({
        name_uz: '',
        name_ru: '',
        name_en: '',
        category: 'Boshqa',
        unit: 'dona',
        available_cities: selectedCity,
      });
      await fetchModerationProducts();
      await fetchProducts();
      window.Telegram?.WebApp?.showAlert(t.moderationSaved);
    } catch {
      window.Telegram?.WebApp?.showAlert(t.moderationError);
    } finally {
      setModerationSavingId(null);
    }
  };

  useEffect(() => {
    if (mode === 'moderate' && isAdminUser) {
      fetchModerationItems();
    }
  }, [mode, isAdminUser, selectedCity]);

  useEffect(() => {
    if (mode === 'moderate' && isAdminUser && moderationSection === 'products') {
      fetchModerationProducts();
    }
  }, [mode, isAdminUser, moderationSection]);

  useEffect(() => {
    if (mode === 'moderate' && isAdminUser && moderationSection === 'messages') {
      fetchModerationMessages();
    }
  }, [mode, isAdminUser, moderationSection]);

  useEffect(() => {
    setNewApprovedItem(prev => ({ ...prev, city: selectedCity }));
  }, [selectedCity]);

  useEffect(() => {
    setNewProductItem(prev => ({ ...prev, available_cities: selectedCity }));
  }, [selectedCity]);

  useEffect(() => {
    if (mode === 'find' && selectedProduct) {
      loadPricesForProduct(selectedProduct.id);
    }
  }, [mode, selectedProduct, selectedCity]);

  useEffect(() => {
    if (mode !== 'report') {
      setReportEntryStep('entry');
      setShowUrlInput(false);
      setScanUrlInput('');
      setScanResult(null);
    }
  }, [mode]);

  useEffect(() => {
    if (mode !== 'find') return;

    const refreshFindData = () => {
      fetchProducts();
      if (selectedProduct?.id) {
        loadPricesForProduct(selectedProduct.id);
      }
    };

    const onVisibilityChange = () => {
      if (!document.hidden) {
        refreshFindData();
      }
    };

    const intervalId = window.setInterval(refreshFindData, 10000);
    window.addEventListener('focus', refreshFindData);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', refreshFindData);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [mode, selectedCity, selectedProduct?.id]);

  const cityProducts = useMemo(() => {
    return products.filter(product => {
      const availableCities = Array.isArray(product.available_cities)
        ? product.available_cities.filter(Boolean)
        : [];
      return availableCities.length === 0 || availableCities.includes(selectedCity);
    });
  }, [products, selectedCity]);

  const filteredProducts = useMemo(() => {
    if (!searchQuery) return [];
    return cityProducts.filter(p => 
      p.name_uz.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.name_ru.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (p.name_en || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
      (p.search_text || '').toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [searchQuery, cityProducts]);

  useEffect(() => {
    if (mode !== 'find') return;
    const q = searchQuery.trim();
    if (q.length < 2) return;
    if (filteredProducts.length > 0) return;

    const timeoutId = window.setTimeout(() => {
      fetchProducts();
    }, 500);

    return () => window.clearTimeout(timeoutId);
  }, [mode, searchQuery, selectedCity, filteredProducts.length]);

  const getProductName = (product: Product, selectedLang: 'uz' | 'ru' | 'en') => {
    if (selectedLang === 'ru') return product.name_ru;
    if (selectedLang === 'en') return product.name_en || product.name_uz;
    return product.name_uz;
  };

  const getProductSecondary = (product: Product, selectedLang: 'uz' | 'ru' | 'en') => {
    if (selectedLang === 'ru') return product.name_uz;
    if (selectedLang === 'en') return product.name_uz;
    return product.name_ru;
  };

  const handleProductSelect = async (product: Product) => {
    setSelectedProduct(product);
    setSearchQuery(getProductName(product, lang));
    setShowDropdown(false);

    const now = new Date();
    const weekNumber = getWeekNumber(now);
    const year = now.getFullYear();

    if (telegramUserId) {
      await supabase.from('product_views').insert({
        product_id: product.id,
        product_name: getProductName(product, lang),
        telegram_id: telegramUserId,
        viewed_at: now.toISOString(),
        week_number: weekNumber,
        year,
      });
    }

    const { count } = await supabase
      .from('product_views')
      .select('id', { count: 'exact', head: true })
      .eq('product_id', product.id)
      .eq('week_number', weekNumber)
      .eq('year', year);

    setSelectedProductWeeklyViews(Number(count || 0));
  };

  const sortedPrices = useMemo(() => {
    const priceByStore = new Map<string, PriceRecord>();
    for (const price of prices) {
      const storeKey = [
        (price.place_name || '').trim().toLowerCase(),
        (price.place_address || '').trim().toLowerCase(),
        (price.city || '').trim().toLowerCase(),
        price.product_id,
      ].join('|');

      const existing = priceByStore.get(storeKey);
      if (!existing) {
        priceByStore.set(storeKey, price);
        continue;
      }

      const existingTs = new Date(existing.receipt_date || 0).getTime();
      const nextTs = new Date(price.receipt_date || 0).getTime();
      if (nextTs >= existingTs) {
        priceByStore.set(storeKey, price);
      }
    }

    const dedupedByStore = Array.from(priceByStore.values());

    const withDistance = dedupedByStore.map(price => ({
      ...price,
      distanceKm:
        nearbyEnabled && userLocation && price.latitude !== null && price.longitude !== null
          ? haversineDistanceKm(userLocation, { lat: price.latitude, lng: price.longitude })
          : null,
    }));

    if (nearbyEnabled && userLocation) {
      return withDistance.sort((left, right) => {
        const leftDistance = left.distanceKm ?? Number.POSITIVE_INFINITY;
        const rightDistance = right.distanceKm ?? Number.POSITIVE_INFINITY;
        if (leftDistance !== rightDistance) {
          return leftDistance - rightDistance;
        }
        return left.price - right.price;
      });
    }

    return withDistance.sort((left, right) => left.price - right.price);
  }, [prices, nearbyEnabled, userLocation]);

  const mapPrices = useMemo(
    () => sortedPrices.filter(p => p.latitude !== null && p.longitude !== null),
    [sortedPrices]
  );

  const minMapPrice = useMemo(
    () => (mapPrices.length > 0 ? Math.min(...mapPrices.map(p => p.price)) : 0),
    [mapPrices]
  );
  const maxMapPrice = useMemo(
    () => (mapPrices.length > 0 ? Math.max(...mapPrices.map(p => p.price)) : 0),
    [mapPrices]
  );

  const interpolateColor = (start: number[], end: number[], ratio: number) => {
    const clamp = Math.min(Math.max(ratio, 0), 1);
    const channel = (index: number) => Math.round(start[index] + (end[index] - start[index]) * clamp);
    const toHex = (value: number) => value.toString(16).padStart(2, '0');
    return `#${toHex(channel(0))}${toHex(channel(1))}${toHex(channel(2))}`;
  };

  const getColor = (price: number, min: number, max: number) => {
    if (min === max) return '#22c55e';
    const ratio = (price - min) / (max - min);
    const green = [34, 197, 94];
    const yellow = [234, 179, 8];
    const red = [239, 68, 68];
    if (ratio <= 0.5) {
      return interpolateColor(green, yellow, ratio / 0.5);
    }
    return interpolateColor(yellow, red, (ratio - 0.5) / 0.5);
  };

  const findMapCenter = useMemo<[number, number]>(() => {
    if (findMapFocus) {
      return [findMapFocus.lat, findMapFocus.lng];
    }
    if (nearbyEnabled && userLocation) {
      return [userLocation.lat, userLocation.lng];
    }
    return selectedCityOption.center;
  }, [findMapFocus, nearbyEnabled, userLocation, selectedCityOption]);

  const findMapZoom = findMapFocus?.zoom ?? (nearbyEnabled && userLocation ? 13 : selectedCityOption.zoom);

  const focusPriceOnMap = (price: PriceRecord) => {
    if (price.latitude === null || price.longitude === null) return;
    setFindMapFocus({
      lat: price.latitude,
      lng: price.longitude,
      zoom: 16,
      trigger: Date.now(),
    });
  };

  const requestUserLocation = (onSuccess?: (coords: { lat: number; lng: number }) => void) => {
    if (!navigator.geolocation) {
      setGeoError(t.nearbyError);
      return;
    }

    const onGeoSuccess = (pos: GeolocationPosition) => {
      const coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      setUserLocation(coords);
      setGeoError('');
      onSuccess?.(coords);
    };

    const requestWithFallback = () => {
      navigator.geolocation.getCurrentPosition(
        onGeoSuccess,
        () => {
          navigator.geolocation.getCurrentPosition(
            onGeoSuccess,
            () => setGeoError(t.nearbyError),
            { enableHighAccuracy: false, timeout: 20000, maximumAge: 0 }
          );
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      );
    };

    requestWithFallback();
  };

  const toggleNearby = () => {
    if (nearbyEnabled) {
      setNearbyEnabled(false);
      setGeoError('');
      return;
    }

    if (userLocation) {
      setNearbyEnabled(true);
      setGeoError('');
      return;
    }

    requestUserLocation(() => setNearbyEnabled(true));
  };

  const updateMaxDistance = async (km: number) => {
    const clamped = Math.min(Math.max(km, 1), 100);
    setMaxDistanceKm(clamped);
    if (telegramUserId) {
      await supabase.from('user_profiles').update({ max_distance_km: clamped }).eq('telegram_id', telegramUserId);
    }
  };

  useEffect(() => {
    setFindMapFocus(null);
  }, [selectedCity, selectedProduct?.id, nearbyEnabled]);

  const handleReportSubmit = async () => {
    if (!reportPrice || (!selectedProduct && !searchQuery.trim())) {
      window.Telegram?.WebApp?.showAlert(t.alertFill);
      return;
    }

    if (!reportProofUrl.trim()) {
      window.Telegram?.WebApp?.showAlert(t.proofRequired);
      return;
    }

    setSubmitting(true);
    const manualName = selectedProduct ? getProductName(selectedProduct, lang) : searchQuery.trim();
    const { error } = await supabase.from('pending_prices').insert({
      product_id: selectedProduct?.id || null,
      product_name_raw: manualName || searchQuery.trim(),
      match_confidence: selectedProduct ? 100 : 0,
      status: 'pending',
      price: parseInt(reportPrice),
      quantity: 1,
      unit_price: parseInt(reportPrice),
      latitude: reportLocation?.lat ?? null,
      longitude: reportLocation?.lng ?? null,
      city: selectedCity,
      receipt_date: new Date().toISOString(),
      receipt_url: reportProofUrl.trim(),
      source: 'manual',
      submitted_by: window.Telegram?.WebApp?.initDataUnsafe?.user?.id?.toString() || 'unknown',
      photo_url: reportProofUrl.trim(),
    });

    setSubmitting(false);
    if (!error) {
      window.Telegram?.WebApp?.showAlert(t.alertSuccess);
      setMode('find');
      setReportPrice('');
      setReportProofUrl('');
      setSelectedProduct(null);
      setSearchQuery('');
    } else {
      window.Telegram?.WebApp?.showAlert(t.alertError);
    }
  };

  const getCurrentLocation = () => {
    requestUserLocation((coords) => {
      setReportLocation(coords);
    });
  };

  const submitContactForm = async () => {
    if (!contactValue.trim() || !contactMessage.trim()) {
      window.Telegram?.WebApp?.showAlert(t.alertFill);
      return;
    }

    setSendingContact(true);
    try {
      const response = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: contactName.trim() || null,
          contact: contactValue.trim(),
          message: contactMessage.trim(),
          city: selectedCity,
          language: lang,
          telegram_id: telegramUserId || null,
          telegram_username: telegramUser?.username || null,
        }),
      });

      const result = await response.json();
      if (!response.ok || !result.ok) {
        throw new Error(result.error || 'CONTACT_SUBMIT_FAILED');
      }

      setContactName('');
      setContactValue('');
      setContactMessage('');
      window.Telegram?.WebApp?.showAlert(t.contactSuccess);
    } catch {
      window.Telegram?.WebApp?.showAlert(t.contactError);
    } finally {
      setSendingContact(false);
    }
  };

  const scrollToContactForm = () => {
    contactFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const goToManualEntry = () => {
    setReportEntryStep('manual');
    setShowUrlInput(false);
    setPageSourceHtml('');
    setMiniWindowMode('none');
    setMiniWindowReceiptUrl('');
    setMiniWindowSourceHtml('');
    setBrowserExtractedJson('');
    setScanResult(null);
    setScanLogs([]);
    setScanApiResponse(null);
  };

  const goToReportHome = () => {
    setMode('find');
    setReportEntryStep('entry');
    setShowUrlInput(false);
    setScanResult(null);
    setScanUrlInput('');
    setScanLogs([]);
    setScanApiResponse(null);
    setLastScannedReceiptUrl('');
    setPageSourceHtml('');
    setMiniWindowMode('none');
    setMiniWindowReceiptUrl('');
    setMiniWindowSourceHtml('');
    setBrowserExtractedJson('');
  };

  const openExternalLink = (url: string) => {
    const tgOpenLink = window.Telegram?.WebApp && 'openLink' in window.Telegram.WebApp
      ? (window.Telegram.WebApp as unknown as { openLink?: (href: string) => void }).openLink
      : undefined;

    if (typeof tgOpenLink === 'function') {
      tgOpenLink(url);
      return;
    }

    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const buildReaderUrl = (receiptUrl: string) => {
    const readerUrl = new URL('/reader.html', window.location.origin);
    readerUrl.searchParams.set('url', receiptUrl);
    readerUrl.searchParams.set('tid', telegramUserId || 'anonymous');
    readerUrl.searchParams.set('city', selectedCity);
    readerUrl.searchParams.set('lang', lang);
    return readerUrl.toString();
  };

  const openReaderPage = () => {
    const url = String(lastScannedReceiptUrl || '').trim();
    if (!url) return;
    openExternalLink(buildReaderUrl(url));
  };

  const openReceiptLink = () => {
    const url = String(lastScannedReceiptUrl || '').trim();
    if (!url) return;
    openExternalLink(url);
  };

  const submitForAuthorization = async () => {
    const url = String(lastScannedReceiptUrl || '').trim();
    if (!url || queuingForAuth) return;

    setQueuingForAuth(true);
    pushClientLog('Force queue requested');
    try {
      const response = await fetch(scanApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          force_queue: true,
          telegram_id: window.Telegram?.WebApp?.initDataUnsafe?.user?.id?.toString() || 'anonymous',
          telegram_username: telegramUser?.username || null,
          telegram_first_name: telegramUser?.first_name || null,
          telegram_language_code: telegramUser?.language_code || lang,
          city: selectedCity,
        }),
      });

      const result = await response.json();
      setScanApiResponse(result);
      pushServerTrace(result?.trace);

      if (result?.ok) {
        pushClientLog('Force queue success');
        setScanResult({
          status: 'success',
          storeName: result.store_name,
          storeAddress: result.store_address,
          city: result.city,
          itemCount: result.item_count,
          queuedWithoutParse: true,
        });
      } else {
        pushClientLog(`Force queue failed (${result?.error || 'queue_failed'})`);
        setScanResult({
          status: 'error',
          errorCode: result?.error || 'queue_failed',
          errorDetail: result?.detail || '',
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'network_error';
      pushClientLog(`Force queue request failed: ${message}`);
      setScanResult({ status: 'error', errorCode: 'network_error', errorDetail: message });
    } finally {
      setQueuingForAuth(false);
    }
  };

  const extractFromPageSource = async () => {
    const url = String(lastScannedReceiptUrl || '').trim();
    const rawHtml = String(pageSourceHtml || '').trim();
    if (!url || !rawHtml || extractingFromSource) return;

    setExtractingFromSource(true);
    pushClientLog('Source extraction requested');
    try {
      const response = await fetch(scanApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          raw_html: rawHtml,
          telegram_id: window.Telegram?.WebApp?.initDataUnsafe?.user?.id?.toString() || 'anonymous',
          telegram_username: telegramUser?.username || null,
          telegram_first_name: telegramUser?.first_name || null,
          telegram_language_code: telegramUser?.language_code || lang,
          city: selectedCity,
        }),
      });

      const result = await response.json();
      setScanApiResponse(result);
      pushServerTrace(result?.trace);

      if (result?.ok) {
        pushClientLog('Source extraction success');
        setScanResult({
          status: 'success',
          storeName: result.store_name,
          storeAddress: result.store_address,
          city: result.city,
          itemCount: result.item_count,
          queuedWithoutParse: false,
        });
      } else if (result?.error === 'duplicate') {
        pushClientLog('Source extraction duplicate');
        setScanResult({ status: 'duplicate', errorCode: 'duplicate', errorDetail: result?.detail || result?.message || '' });
      } else {
        pushClientLog(`Source extraction failed (${result?.error || 'scan_failed'})`);
        setScanResult({
          status: 'error',
          errorCode: result?.error || 'scan_failed',
          errorDetail: result?.detail || '',
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'network_error';
      pushClientLog(`Source extraction network error: ${message}`);
      setScanResult({ status: 'error', errorCode: 'network_error', errorDetail: message });
      setScanApiResponse({ ok: false, error: 'network_error', detail: message });
    } finally {
      setExtractingFromSource(false);
    }
  };

  const escapeHtmlForPreview = (html: string) =>
    html
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');

  const openReceiptInMiniWindow = () => {
    const url = String(lastScannedReceiptUrl || '').trim();
    if (!url) return;
    setMiniWindowReceiptUrl(url);
    setMiniWindowMode('receipt');
  };

  const openSourceInMiniWindow = async () => {
    const url = String(lastScannedReceiptUrl || '').trim();
    if (!url || loadingMiniWindowSource) return;

    setLoadingMiniWindowSource(true);
    pushClientLog('Mini window source fetch requested');
    try {
      const response = await fetch('/api/source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const result = await response.json();

      if (!response.ok || !result?.ok || typeof result?.source !== 'string') {
        if (result?.detail) {
          pushClientLog(`Mini window source detail: ${JSON.stringify(result.detail)}`);
        }
        throw new Error(result?.error || 'source_fetch_failed');
      }

      setMiniWindowSourceHtml(result.source);
      setMiniWindowMode('source');
      pushClientLog(`Mini window source loaded (${result.source.length} chars)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'source_fetch_failed';
      pushClientLog(`Mini window source fetch failed: ${message}`);
      window.Telegram?.WebApp?.showAlert(t.miniWindowSourceFetchError);
    } finally {
      setLoadingMiniWindowSource(false);
    }
  };

  const copyMiniWindowSource = async () => {
    if (!miniWindowSourceHtml) return;
    try {
      await navigator.clipboard.writeText(miniWindowSourceHtml);
      window.Telegram?.WebApp?.showAlert(t.miniWindowCopySuccess);
    } catch {
      window.Telegram?.WebApp?.showAlert(t.miniWindowCopyError);
    }
  };

  const copyMiniWindowPageContent = async () => {
    try {
      const iframeDoc = miniWindowIframeRef.current?.contentDocument;
      const iframeText = iframeDoc?.body?.innerText?.trim();
      if (iframeText) {
        await navigator.clipboard.writeText(iframeText);
        window.Telegram?.WebApp?.showAlert(t.miniWindowContentCopySuccess);
        return;
      }
    } catch {
      // cross-origin expected for many external pages
    }

    try {
      const url = String(lastScannedReceiptUrl || '').trim();
      if (!url) throw new Error('missing_url');

      const response = await fetch('/api/source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, mode: 'content' }),
      });
      const result = await response.json();

      if (!response.ok || !result?.ok || typeof result?.content !== 'string') {
        if (result?.detail) {
          pushClientLog(`Content copy detail: ${JSON.stringify(result.detail)}`);
        }
        throw new Error(result?.error || 'content_extract_failed');
      }

      await navigator.clipboard.writeText(result.content);
      window.Telegram?.WebApp?.showAlert(t.miniWindowContentCopySuccess);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'content_copy_failed';
      pushClientLog(`Content copy failed: ${message}`);
      window.Telegram?.WebApp?.showAlert(`${t.miniWindowContentCopyError} (${message})`);
    }
  };

  const copyBrowserExtractorScript = async () => {
    const script = `(() => {
  const normalize = (raw) => {
    const cleaned = String(raw || '').replace(/[^\\d.,-]/g, '');
    if (!cleaned) return 0;
    const normalized = cleaned.includes(',') && cleaned.includes('.') ? cleaned.replace(/,/g, '') : cleaned.replace(/,/g, '.');
    const value = parseFloat(normalized);
    return Number.isFinite(value) ? value : 0;
  };

  const table = document.querySelector('.products-tables');
  if (!table) {
    alert('products-tables not found');
    return;
  }

  const rows = Array.from(table.querySelectorAll('.products-row, tbody tr'));
  const extracted = rows.map((row) => {
    const cells = Array.from(row.querySelectorAll('td'));
    if (cells.length < 2) return null;
    const name = (cells[0]?.innerText || '').trim();
    const quantityRaw = (cells[1]?.innerText || '').trim();
    const priceRaw = (cells[2]?.innerText || cells[cells.length - 1]?.innerText || '').trim();
    const quantity = Math.max(1, normalize(quantityRaw));
    const total = normalize(priceRaw);
    if (!name || total <= 0) return null;
    return {
      name,
      quantity,
      total_price: total,
      unit_price: quantity > 0 ? total / quantity : total,
    };
  }).filter(Boolean);

  const payload = JSON.stringify(extracted, null, 2);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(payload).then(() => alert('JSON copied')).catch(() => prompt('Copy JSON', payload));
  } else {
    prompt('Copy JSON', payload);
  }
})();`;

    try {
      await navigator.clipboard.writeText(script);
      window.Telegram?.WebApp?.showAlert(t.browserJsCopied);
      pushClientLog('Browser extractor JS copied');
    } catch {
      window.Telegram?.WebApp?.showAlert(t.miniWindowCopyError);
    }
  };

  const submitExtractedJson = async () => {
    const url = String(lastScannedReceiptUrl || '').trim();
    const raw = String(browserExtractedJson || '').trim();
    if (!url || !raw || submittingExtractedJson) return;

    let extractedItems: Array<{ name?: string; quantity?: number; total_price?: number; unit_price?: number }> = [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        window.Telegram?.WebApp?.showAlert(t.browserJsonError);
        return;
      }
      extractedItems = parsed;
    } catch {
      window.Telegram?.WebApp?.showAlert(t.browserJsonError);
      return;
    }

    setSubmittingExtractedJson(true);
    pushClientLog('Extracted JSON submit requested');
    try {
      const response = await fetch(scanApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          extracted_items: extractedItems,
          telegram_id: window.Telegram?.WebApp?.initDataUnsafe?.user?.id?.toString() || 'anonymous',
          telegram_username: telegramUser?.username || null,
          telegram_first_name: telegramUser?.first_name || null,
          telegram_language_code: telegramUser?.language_code || lang,
          city: selectedCity,
        }),
      });

      const result = await response.json();
      setScanApiResponse(result);
      pushServerTrace(result?.trace);

      if (result?.ok) {
        pushClientLog('Extracted JSON submit success');
        setScanResult({
          status: 'success',
          storeName: result.store_name,
          storeAddress: result.store_address,
          city: result.city,
          itemCount: result.item_count,
          queuedWithoutParse: false,
        });
      } else {
        pushClientLog(`Extracted JSON submit failed (${result?.error || 'scan_failed'})`);
        setScanResult({
          status: 'error',
          errorCode: result?.error || 'scan_failed',
          errorDetail: result?.detail || '',
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'network_error';
      pushClientLog(`Extracted JSON submit network error: ${message}`);
      setScanResult({ status: 'error', errorCode: 'network_error', errorDetail: message });
    } finally {
      setSubmittingExtractedJson(false);
    }
  };

  const pushClientLog = (message: string) => {
    setScanLogs(prev => [
      ...prev,
      { ts: new Date().toISOString(), source: 'client', message },
    ]);
  };

  const pushServerTrace = (trace: Array<{ ts?: string; stage?: string; detail?: unknown }> | undefined) => {
    if (!Array.isArray(trace) || trace.length === 0) return;
    setScanLogs(prev => [
      ...prev,
      ...trace.map(entry => ({
        ts: entry?.ts || new Date().toISOString(),
        source: 'server' as const,
        message: `${entry?.stage || 'unknown'}${entry?.detail ? `: ${JSON.stringify(entry.detail)}` : ''}`,
      })),
    ]);
  };

  const extractSoliqUrlFromText = (input: string) => {
    const raw = String(input || '').trim();
    if (!raw) return null;

    const canonicalizeParsedUrl = (parsed: URL) => {
      const canonical = new URL('https://ofd.soliq.uz/check');
      const t = parsed.searchParams.get('t');
      const r = parsed.searchParams.get('r');
      const c = parsed.searchParams.get('c');
      const s = parsed.searchParams.get('s');

      if (t) canonical.searchParams.set('t', t);
      if (r) canonical.searchParams.set('r', r);
      if (c) canonical.searchParams.set('c', c);
      if (s) canonical.searchParams.set('s', s);
      return canonical.toString();
    };

    const buildCheckFromParams = (paramsSource: string) => {
      const params = new URLSearchParams(paramsSource);
      const t = params.get('t');
      if (!t) return null;
      const r = params.get('r');
      const c = params.get('c');
      const s = params.get('s');

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
        return buildCheckFromParams(parsed.search) || canonicalizeParsedUrl(parsed);
      } catch {
        return directMatch[0];
      }
    }

    if (/^ofd\.soliq\.uz\//i.test(raw)) {
      try {
        const parsed = new URL(`https://${raw}`);
        return buildCheckFromParams(parsed.search) || parsed.toString();
      } catch {
        return `https://${raw}`;
      }
    }

    const fromLooseParams = buildCheckFromParams(raw);
    if (fromLooseParams) {
      return fromLooseParams;
    }

    return null;
  };

  const isSoliqUrl = (url: string) => {
    try {
      const parsed = new URL(String(url || ''));
      return parsed.hostname.toLowerCase() === 'ofd.soliq.uz' && parsed.pathname.toLowerCase() === '/check';
    } catch {
      return false;
    }
  };

  const getScanErrorBody = (errorCode?: string) => {
    if (errorCode === 'not_soliq_url') {
      return t.scanErrorNotSoliq;
    }
    if (errorCode === 'blocked') {
      return t.scanErrorBlocked;
    }
    if (errorCode === 'scan_timeout') {
      return t.scanErrorTimeout;
    }
    if (errorCode === 'receipt_generating') {
      return t.scanErrorGenerating;
    }
    if (errorCode === 'scrape_failed') {
      return t.scanErrorScrape;
    }
    if (errorCode === 'fetch_failed') {
      return t.scanErrorNetwork;
    }
    if (errorCode === 'parse_empty') {
      return t.scanErrorParseEmpty;
    }
    if (errorCode === 'parse_failed' || errorCode === 'not_receipt_page') {
      return t.scanErrorParseEmpty;
    }
    if (errorCode === 'network_error') {
      return t.scanErrorNetwork;
    }
    return t.scanErrorBody;
  };

  const scanApiUrl = import.meta.env.VITE_SCAN_API_URL || '/api/scan';

  const handleSoliqUrl = async (url: string) => {
    setScanLogs([]);
    setScanApiResponse(null);
    pushClientLog('QR scanned');
    const scannedUrl = extractSoliqUrlFromText(url) || String(url || '').trim();
    setLastScannedReceiptUrl(scannedUrl || '');
    setPageSourceHtml('');
    setMiniWindowMode('none');
    setMiniWindowReceiptUrl('');
    setMiniWindowSourceHtml('');
    setBrowserExtractedJson('');
    pushClientLog(`URL extracted: ${scannedUrl || 'empty'}`);
    if (!isSoliqUrl(scannedUrl)) {
      pushClientLog('Validation failed: not_soliq_url');
      setScanResult({ status: 'error', errorCode: 'not_soliq_url', errorDetail: 'URL does not match soliq receipt domain' });
      setReportEntryStep('result');
      return;
    }
    pushClientLog('Validation passed');

    setShowUrlInput(false);
    setReportEntryStep('loading');
    pushClientLog('Queue request started');

    try {
      const response = await fetch(scanApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: scannedUrl,
          telegram_id: window.Telegram?.WebApp?.initDataUnsafe?.user?.id?.toString() || 'anonymous',
          telegram_username: telegramUser?.username || null,
          telegram_first_name: telegramUser?.first_name || null,
          telegram_language_code: telegramUser?.language_code || lang,
          city: selectedCity,
        }),
      });

      const result = await response.json();
      setScanApiResponse(result);

      if (result?.ok) {
        pushClientLog('Queue request success');
        setScanResult({
          status: 'success',
          storeName: '-',
          storeAddress: '-',
          city: result?.city || selectedCity,
          itemCount: 0,
          queuedWithoutParse: true,
        });
      } else if (result?.error === 'duplicate') {
        pushClientLog('Queue request duplicate');
        setScanResult({ status: 'duplicate', errorCode: 'duplicate', errorDetail: result?.message || '' });
      } else {
        pushClientLog(`Queue request failed (${result?.error || 'queue_failed'})`);
        setScanResult({
          status: 'error',
          errorCode: result?.error || 'queue_failed',
          errorDetail: result?.detail || result?.message || '',
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'network_error';
      pushClientLog(`Queue request network error: ${message}`);
      setScanResult({ status: 'error', errorCode: 'network_error', errorDetail: message });
    } finally {
      setReportEntryStep('result');
    }
  };

  const openNativeQrScanner = () => {
    const scanner = window.Telegram?.WebApp?.showScanQrPopup;
    if (typeof scanner === 'function') {
      scanner({ text: t.scanPopupText }, (scannedText: string) => {
        const value = extractSoliqUrlFromText(scannedText || '') || String(scannedText || '').trim();
        if (isSoliqUrl(value)) {
          window.Telegram?.WebApp?.closeScanQrPopup?.();
          handleSoliqUrl(value);
          return true;
        }
        window.Telegram?.WebApp?.showAlert(t.scannerInvalidAlert);
        return false;
      });
      return;
    }

    setShowUrlInput(true);
  };

  const retryScan = () => {
    setScanResult(null);
    setPageSourceHtml('');
    setMiniWindowMode('none');
    setMiniWindowReceiptUrl('');
    setMiniWindowSourceHtml('');
    setBrowserExtractedJson('');
    setReportEntryStep('entry');
    openNativeQrScanner();
  };

  const reportLocale = useMemo(() => {
    if (lang === 'ru') return ru;
    if (lang === 'en') return enUS;
    return uz;
  }, [lang]);

  return (
    <div className="min-h-screen bg-stone-50 font-sans text-stone-900 pb-20">
      {/* Header */}
      <header className="bg-white border-b border-stone-200 p-4 sticky top-0 z-50">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-bold tracking-tight text-emerald-600">Narxi</h1>
          <div className="flex items-center gap-2">
            <div className="flex bg-stone-100 p-1 rounded-lg">
              {(['uz', 'ru', 'en'] as const).map(option => (
                <button
                  key={option}
                  onClick={() => setLang(option)}
                  className={cn(
                    'px-2 py-1 rounded-md text-xs font-semibold transition-all uppercase',
                    lang === option ? 'bg-white shadow-sm text-emerald-600' : 'text-stone-500'
                  )}
                >
                  {option}
                </button>
              ))}
            </div>
            <div className="flex bg-stone-100 p-1 rounded-lg">
              <button 
                onClick={() => setMode('find')}
                className={cn(
                  "px-4 py-1.5 rounded-md text-sm font-medium transition-all",
                  mode === 'find' ? "bg-white shadow-sm text-emerald-600" : "text-stone-500"
                )}
              >
                {t.modeFind}
              </button>
              <button 
                onClick={() => setMode('report')}
                className={cn(
                  "px-4 py-1.5 rounded-md text-sm font-medium transition-all",
                  mode === 'report' ? "bg-white shadow-sm text-emerald-600" : "text-stone-500"
                )}
              >
                {t.modeReport}
              </button>
              {isAdminUser && (
                <button 
                  onClick={() => setMode('moderate')}
                  className={cn(
                    "px-4 py-1.5 rounded-md text-sm font-medium transition-all",
                    mode === 'moderate' ? "bg-white shadow-sm text-emerald-600" : "text-stone-500"
                  )}
                >
                  {t.modeModerate}
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="mb-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-stone-500">{t.cityTitle}</div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {CITY_OPTIONS.map(city => (
              <button
                key={city.value}
                onClick={() => setSelectedCity(city.value)}
                className={cn(
                  'whitespace-nowrap rounded-full border px-3 py-2 text-sm font-medium transition-all',
                  selectedCity === city.value
                    ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
                    : 'border-stone-200 bg-stone-50 text-stone-600'
                )}
              >
                {city.labels[lang]}
              </button>
            ))}
          </div>
        </div>

        {/* Search Bar */}
        {mode === 'find' && <div className="relative">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-400 w-4 h-4" />
            <input 
              type="text"
              placeholder={t.searchPlaceholder}
              className="w-full bg-stone-100 border-none rounded-xl py-3 pl-10 pr-4 text-sm focus:ring-2 focus:ring-emerald-500 transition-all"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setShowDropdown(true);
              }}
              onFocus={() => setShowDropdown(true)}
            />
          </div>

          {/* Dropdown */}
          {showDropdown && filteredProducts.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-2 bg-white border border-stone-200 rounded-xl shadow-xl max-h-60 overflow-y-auto z-50">
              {filteredProducts.map(p => (
                <button
                  key={p.id}
                  onClick={() => handleProductSelect(p)}
                  className="w-full text-left px-4 py-3 hover:bg-stone-50 border-b border-stone-100 last:border-none flex items-center justify-between"
                >
                  <div>
                    <div className="text-sm font-medium">{getProductName(p, lang)}</div>
                    <div className="text-xs text-stone-400">{getProductSecondary(p, lang)}</div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-stone-300" />
                </button>
              ))}
            </div>
          )}
        </div>}
      </header>

      <main className="p-4">
        {mode === 'find' ? (
          <div className="space-y-6">
            <section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wider text-stone-500">{t.cityLabel}</div>
                  <div className="text-base font-semibold text-stone-900">{selectedCityLabel}</div>
                </div>
                <button
                  onClick={toggleNearby}
                  className={cn(
                    'inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition-all',
                    nearbyEnabled
                      ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
                      : 'border-stone-200 bg-stone-50 text-stone-600'
                  )}
                >
                  <Navigation className="h-4 w-4" />
                  {t.nearbyToggle}
                </button>
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs text-stone-500">{t.nearbyHint}</div>
                <div className="flex items-center gap-2">
                  <label className="text-xs font-medium text-stone-500">{t.maxDistanceLabel}:</label>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={maxDistanceKm}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (v >= 1 && v <= 100) updateMaxDistance(v);
                    }}
                    className="w-14 rounded-md border border-stone-200 bg-stone-50 px-2 py-1 text-xs text-center text-stone-700"
                  />
                  <span className="text-xs text-stone-400">{t.maxDistanceKmUnit}</span>
                </div>
              </div>
              <div className="mt-2 flex justify-end">
                <button
                  onClick={scrollToContactForm}
                  className="inline-flex items-center gap-1 rounded-full border border-stone-200 bg-stone-50 px-3 py-1.5 text-xs font-semibold text-stone-700"
                >
                  {t.contactJump}
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
              {geoError && <div className="mt-2 text-xs font-medium text-rose-600">{geoError}</div>}
            </section>

            {!selectedProduct ? (
              <div className="text-center py-20">
                <div className="bg-emerald-50 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
                  <Search className="text-emerald-500 w-8 h-8" />
                </div>
                <h2 className="text-lg font-semibold mb-2">{t.emptyTitle}</h2>
                <p className="text-stone-500 text-sm px-10">
                  {t.emptyHint}
                </p>
              </div>
            ) : (
              <>
                {/* Results List */}
                <section>
                  <div className="mb-2 text-sm font-semibold text-stone-700">{getProductName(selectedProduct, lang)}</div>
                  {selectedProductWeeklyViews >= 5 && (
                    <div className="mb-3 text-xs text-emerald-700">
                      {t.viewedThisWeek(selectedProductWeeklyViews, getProductName(selectedProduct, lang))}
                    </div>
                  )}
                  <h3 className="text-sm font-semibold text-stone-500 uppercase tracking-wider mb-3">{t.cheapestTitle}</h3>
                  <div className="space-y-3">
                    {loading ? (
                      <div className="animate-pulse space-y-3">
                        {[1, 2, 3].map(i => <div key={i} className="h-20 bg-stone-200 rounded-xl" />)}
                      </div>
                    ) : sortedPrices.length > 0 ? (
                      sortedPrices.slice(0, 5).map((p, i) => (
                        <div key={p.id} className="bg-white p-4 rounded-xl border border-stone-200 shadow-sm flex items-center justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1">
                              <span className={cn(
                                "w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold",
                                i === 0 ? "bg-emerald-100 text-emerald-700" : "bg-stone-100 text-stone-600"
                              )}>
                                {i + 1}
                              </span>
                              <h4 className="font-bold text-stone-900">{priceFormatter.format(p.price)} {t.sumLabel}</h4>
                            </div>
                            <p className="text-sm text-stone-600 truncate">{p.place_name || t.unknownStore}</p>
                            <p className="text-xs text-stone-500 truncate">{p.place_address || '-'}</p>
                            <p className="text-xs text-stone-400 truncate">{p.city || selectedCityLabel}</p>
                            <p className="text-xs text-stone-400">
                              {formatDistanceToNow(new Date(p.receipt_date), { addSuffix: true, locale: reportLocale })}
                            </p>
                            <p className="text-xs text-stone-400">
                              {t.uploadedAt}: {new Date(p.receipt_date).toLocaleString()}
                            </p>
                            {nearbyEnabled && userLocation && p.distanceKm !== null && p.distanceKm !== undefined && Number.isFinite(p.distanceKm) && (
                              <p className="text-xs font-medium text-emerald-700">
                                {t.nearbyDistance}: {p.distanceKm.toFixed(1)} km
                              </p>
                            )}
                          </div>
                          <div className="text-right">
                            <button
                              title={t.mapTitle}
                              onClick={() => focusPriceOnMap(p)}
                              disabled={p.latitude === null || p.longitude === null}
                              className="p-2 text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors disabled:opacity-40"
                            >
                              <Navigation className="w-5 h-5" />
                            </button>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="text-center py-10 text-stone-400 italic">{t.noData}</div>
                    )}
                  </div>
                </section>

                {/* Map */}
                <section>
                  <h3 className="text-sm font-semibold text-stone-500 uppercase tracking-wider mb-3">{t.mapTitle}</h3>
                  <div className="h-75 rounded-2xl overflow-hidden border border-stone-200 shadow-inner relative z-0">
                    <MapContainer 
                      center={findMapCenter}
                      zoom={findMapZoom}
                      dragging={true}
                      scrollWheelZoom={true}
                      doubleClickZoom={true}
                      touchZoom={true}
                      style={{ height: '100%', width: '100%' }}
                      zoomControl={true}
                    >
                      <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                      <FlyToView center={findMapCenter} zoom={findMapZoom} trigger={findMapFocus?.trigger || 0} />
                      {mapPrices.map(p => (
                        <CircleMarker
                          key={p.id}
                          center={[p.latitude!, p.longitude!]}
                          radius={10}
                          fillColor={getColor(p.price, minMapPrice, maxMapPrice)}
                          color="white"
                          weight={2}
                          fillOpacity={0.8}
                        >
                          <Popup>
                            <div className="p-1">
                              <div className="font-bold text-lg">{priceFormatter.format(p.price)} {t.sumLabel}</div>
                              <div className="text-sm text-stone-600">{p.place_name || t.unknownStore}</div>
                              <div className="text-xs text-stone-500">{p.place_address || '-'}</div>
                              <div className="text-xs text-stone-500">{p.city || selectedCityLabel}</div>
                            </div>
                          </Popup>
                        </CircleMarker>
                      ))}
                      {nearbyEnabled && userLocation && (
                        <CircleMarker
                          center={[userLocation.lat, userLocation.lng]}
                          radius={11}
                          fillColor="#0f766e"
                          color="white"
                          weight={2}
                          fillOpacity={0.9}
                        />
                      )}
                    </MapContainer>
                    {mapPrices.length === 0 && (
                      <div className="absolute inset-0 flex items-center justify-center text-sm text-stone-500 bg-white/70">
                        {t.noMapData}
                      </div>
                    )}
                  </div>
                </section>

              </>
            )}

            <section ref={contactFormRef} className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm space-y-3">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-stone-500">{t.contactFormTitle}</h3>
              <p className="text-xs text-stone-500">{t.contactFormHint}</p>
              <input
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
                placeholder={t.contactNamePlaceholder}
                className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
              />
              <input
                value={contactValue}
                onChange={(e) => setContactValue(e.target.value)}
                placeholder={t.contactValuePlaceholder}
                className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
              />
              <textarea
                value={contactMessage}
                onChange={(e) => setContactMessage(e.target.value)}
                placeholder={t.contactMessagePlaceholder}
                rows={3}
                className="w-full resize-none rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
              />
              <button
                onClick={submitContactForm}
                disabled={sendingContact || !contactValue.trim() || !contactMessage.trim()}
                className="w-full rounded-xl bg-emerald-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
              >
                {sendingContact ? t.contactSending : t.contactSend}
              </button>
            </section>
          </div>
        ) : mode === 'report' ? (
          <div className="space-y-6">
            {reportEntryStep === 'entry' && (
              <section className="space-y-4">
                <button
                  onClick={openNativeQrScanner}
                  className="w-full rounded-2xl border-2 border-emerald-300 bg-emerald-50 p-6 text-left transition-all hover:border-emerald-400"
                >
                  <div className="flex items-start gap-4">
                    <div className="rounded-xl bg-emerald-100 p-3 text-emerald-700">
                      <QrCode className="h-6 w-6" />
                    </div>
                    <div>
                      <div className="text-lg font-bold text-emerald-900">{t.qrCardTitle}</div>
                      <div className="mt-1 text-sm text-emerald-800">{t.qrCardBody}</div>
                      <div className="mt-2 text-xs font-semibold text-emerald-700">[{t.qrCardHint}]</div>
                    </div>
                  </div>
                </button>

                <button
                  onClick={goToManualEntry}
                  className="w-full rounded-2xl border-2 border-stone-200 bg-white p-6 text-left transition-all hover:border-stone-300"
                >
                  <div className="flex items-start gap-4">
                    <div className="rounded-xl bg-stone-100 p-3 text-stone-700">
                      <PencilLine className="h-6 w-6" />
                    </div>
                    <div>
                      <div className="text-lg font-bold text-stone-900">{t.manualCardTitle}</div>
                      <div className="mt-1 text-sm text-stone-700">{t.manualCardBody}</div>
                    </div>
                  </div>
                </button>

                {showUrlInput && (
                  <div className="rounded-2xl border border-stone-200 bg-white p-4 space-y-3">
                    <input
                      type="text"
                      placeholder={t.urlFallbackPlaceholder}
                      value={scanUrlInput}
                      onChange={(e) => setScanUrlInput(e.target.value)}
                      className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
                    />
                    <button
                      onClick={() => handleSoliqUrl(scanUrlInput)}
                      disabled={!scanUrlInput.trim()}
                      className="w-full rounded-xl bg-emerald-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
                    >
                      {t.urlFallbackSubmit}
                    </button>
                  </div>
                )}
              </section>
            )}

            {reportEntryStep === 'loading' && (
              <section className="space-y-4">
                <div className="rounded-2xl border border-stone-200 bg-white p-10 text-center">
                  <div className="text-xl font-bold text-stone-900">{t.scanLoadingTitle}</div>
                  <div className="mt-4 flex justify-center">
                    <Loader2 className="h-8 w-8 animate-spin text-emerald-600" />
                  </div>
                  <div className="mt-4 text-sm text-stone-600">{t.scanLoadingHint}</div>
                </div>
              </section>
            )}

            {reportEntryStep === 'result' && scanResult?.status === 'success' && (
              <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6 space-y-4">
                <div className="text-xl font-bold text-emerald-900">{t.scanSuccessTitle}</div>
                <div className="space-y-1 text-sm text-emerald-900">
                  <div>🏪 {scanResult.storeName || '-'}</div>
                  <div>📍 {scanResult.storeAddress || '-'}</div>
                  <div>🌆 {scanResult.city || selectedCityLabel}</div>
                  <div>📦 {scanResult.itemCount || 0} {t.scanItemsSubmitted}</div>
                </div>
                {scanResult.queuedWithoutParse && (
                  <div className="rounded-xl border border-emerald-200 bg-white/70 px-3 py-2 text-sm text-emerald-800">
                    {t.scanSuccessQueued}
                  </div>
                )}
                <div className="text-sm text-emerald-800">{t.scanThanks}</div>
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={retryScan} className="rounded-xl bg-emerald-600 px-4 py-3 text-sm font-semibold text-white">{t.scanAgain}</button>
                  <button onClick={goToReportHome} className="rounded-xl border border-emerald-300 bg-white px-4 py-3 text-sm font-semibold text-emerald-700">{t.goHome}</button>
                </div>
                {lastScannedReceiptUrl && (
                  <button onClick={openReceiptLink} className="w-full rounded-xl border border-emerald-300 bg-white px-4 py-3 text-sm font-semibold text-emerald-700">{t.openReceiptLink}</button>
                )}
              </section>
            )}

            {reportEntryStep === 'result' && scanResult?.status === 'duplicate' && (
              <section className="rounded-2xl border border-stone-200 bg-white p-6 space-y-4">
                <div className="text-xl font-bold text-stone-900">{t.scanDuplicateTitle}</div>
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={retryScan} className="rounded-xl bg-emerald-600 px-4 py-3 text-sm font-semibold text-white">{t.scanAgain}</button>
                  <button onClick={goToReportHome} className="rounded-xl border border-stone-300 bg-stone-50 px-4 py-3 text-sm font-semibold text-stone-700">{t.goHome}</button>
                </div>
                {lastScannedReceiptUrl && (
                  <button onClick={openReceiptLink} className="w-full rounded-xl border border-stone-300 bg-stone-50 px-4 py-3 text-sm font-semibold text-stone-700">{t.openReceiptLink}</button>
                )}
              </section>
            )}

            {reportEntryStep === 'result' && scanResult?.status === 'error' && (
              <section className="rounded-2xl border border-rose-200 bg-rose-50 p-6 space-y-4">
                <div className="text-xl font-bold text-rose-900">{t.scanErrorTitle}</div>
                <div className="whitespace-pre-line text-sm text-rose-800">{getScanErrorBody(scanResult.errorCode)}</div>
                {scanResult.errorCode && (
                  <div className="text-xs text-rose-700/80">Code: {scanResult.errorCode}</div>
                )}
                {scanResult.errorDetail && (
                  <div className="rounded-xl border border-rose-200 bg-white/60 p-3 text-xs text-rose-800 break-all">Detail: {scanResult.errorDetail}</div>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={retryScan} className="rounded-xl bg-rose-600 px-4 py-3 text-sm font-semibold text-white">{t.retry}</button>
                  <button onClick={goToManualEntry} className="rounded-xl border border-rose-300 bg-white px-4 py-3 text-sm font-semibold text-rose-700">{t.switchManual}</button>
                </div>
                {lastScannedReceiptUrl && (
                  <button
                    onClick={submitForAuthorization}
                    disabled={queuingForAuth}
                    className="w-full rounded-xl bg-emerald-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
                  >
                    {queuingForAuth ? `${t.submitting}...` : t.submitForAuth}
                  </button>
                )}
                {lastScannedReceiptUrl && (
                  <button onClick={openReceiptLink} className="w-full rounded-xl border border-rose-300 bg-white px-4 py-3 text-sm font-semibold text-rose-700">{t.openReceiptLink}</button>
                )}
              </section>
            )}

            {reportEntryStep === 'result' && scanResult?.status === 'manual' && (
              <section className="rounded-2xl border border-amber-200 bg-amber-50 p-6 space-y-4">
                <div className="text-xl font-bold text-amber-900">{t.scanManualTitle}</div>
                <div className="text-sm text-amber-800">{t.scanManualBody}</div>
                <div className="rounded-xl border border-amber-200 bg-white p-4 text-sm text-amber-900">
                  <div>1) {t.openReceiptLink}</div>
                  <div className="mt-1">2) {t.readerSubmitHint}</div>
                </div>

                <button onClick={openReaderPage} className="w-full rounded-xl bg-amber-600 px-4 py-3 text-sm font-semibold text-white">1) {t.openReceiptLink}</button>

                <div className="grid grid-cols-2 gap-2">
                  <button onClick={retryScan} className="rounded-xl bg-amber-600 px-4 py-3 text-sm font-semibold text-white">{t.scanAgain}</button>
                  <button onClick={goToManualEntry} className="rounded-xl border border-amber-300 bg-white px-4 py-3 text-sm font-semibold text-amber-800">{t.switchManual}</button>
                </div>
              </section>
            )}

            {reportEntryStep === 'manual' && (
              <>
                <section className="bg-white p-6 rounded-2xl border border-stone-200 shadow-sm space-y-4">
                  <div className="rounded-2xl border border-emerald-100 bg-emerald-50 p-4">
                    <div className="text-xs font-semibold uppercase tracking-wider text-emerald-700">{t.cityLabel}</div>
                    <div className="mt-1 text-lg font-bold text-emerald-900">{selectedCityLabel}</div>
                    <div className="mt-1 text-xs text-emerald-700">{t.reportCityConfirm}</div>

                    <div className="mt-4 relative">
                      <label className="block text-xs font-semibold text-emerald-700 uppercase tracking-wider mb-2">{t.reportProductNameLabel}</label>
                      <input
                        type="text"
                        placeholder={t.reportProductNamePlaceholder}
                        className="w-full rounded-xl border border-emerald-200 bg-white px-4 py-3 text-sm text-stone-900 outline-none focus:ring-2 focus:ring-emerald-500"
                        value={searchQuery}
                        onChange={(e) => {
                          setSearchQuery(e.target.value);
                          setSelectedProduct(null);
                          setShowDropdown(true);
                        }}
                        onFocus={() => setShowDropdown(true)}
                      />

                      {showDropdown && filteredProducts.length > 0 && (
                        <div className="absolute top-full left-0 right-0 mt-2 max-h-56 overflow-y-auto rounded-xl border border-stone-200 bg-white shadow-xl z-50">
                          {filteredProducts.map((p) => (
                            <button
                              key={p.id}
                              onClick={() => handleProductSelect(p)}
                              className="w-full border-b border-stone-100 px-4 py-3 text-left last:border-none hover:bg-stone-50"
                            >
                              <div className="text-sm font-medium text-stone-900">{getProductName(p, lang)}</div>
                              <div className="text-xs text-stone-500">{getProductSecondary(p, lang)}</div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-stone-500 uppercase tracking-wider mb-2">{t.priceLabel}</label>
                    <input
                      type="number"
                      placeholder={t.pricePlaceholder}
                      className="w-full bg-stone-50 border border-stone-200 rounded-xl py-3 px-4 text-lg font-bold focus:ring-2 focus:ring-emerald-500 outline-none"
                      value={reportPrice}
                      onChange={(e) => setReportPrice(e.target.value)}
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-stone-500 uppercase tracking-wider mb-2">{t.locationLabel}</label>
                    <div className="flex gap-2">
                      <button
                        onClick={getCurrentLocation}
                        className={cn(
                          "flex-1 flex items-center justify-center gap-2 py-3 rounded-xl border transition-all",
                          reportLocation ? "bg-emerald-50 border-emerald-200 text-emerald-700" : "bg-stone-50 border-stone-200 text-stone-600"
                        )}
                      >
                        {reportLocation ? <Check className="w-4 h-4" /> : <Navigation className="w-4 h-4" />}
                        GPS
                      </button>
                      <button className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl border border-stone-200 bg-stone-50 text-stone-600">
                        <MapPin className="w-4 h-4" />
                        {t.mapPick}
                      </button>
                    </div>
                    {geoError && (
                      <div className="mt-2 text-xs font-medium text-rose-600">{geoError}</div>
                    )}
                    <div className="mt-3 h-50 rounded-xl overflow-hidden border border-stone-200 relative">
                      <MapContainer
                        center={reportLocation ? [reportLocation.lat, reportLocation.lng] : selectedCityOption.center}
                        zoom={reportLocation ? 15 : selectedCityOption.zoom}
                        style={{ height: '100%', width: '100%' }}
                        zoomControl={false}
                      >
                        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                        <ChangeView center={reportLocation ? [reportLocation.lat, reportLocation.lng] : selectedCityOption.center} zoom={reportLocation ? 15 : selectedCityOption.zoom} />
                        <ReportMapPicker
                          onPick={(lat, lng) => {
                            setReportLocation({ lat, lng });
                          }}
                        />
                        {reportLocation && (
                          <CircleMarker
                            center={[reportLocation.lat, reportLocation.lng]}
                            radius={10}
                            fillColor="#22c55e"
                            color="white"
                            weight={2}
                            fillOpacity={0.9}
                          />
                        )}
                      </MapContainer>
                      {!reportLocation && (
                        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-stone-500 bg-white/70">
                          {t.locationHint}
                        </div>
                      )}
                    </div>
                    {reportLocation && (
                      <div className="mt-2 text-xs text-stone-500">
                        {reportLocation.lat.toFixed(5)}, {reportLocation.lng.toFixed(5)}
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-stone-500 uppercase tracking-wider mb-2">{t.proofLabel}</label>
                    <input
                      type="url"
                      placeholder={t.proofPlaceholder}
                      value={reportProofUrl}
                      onChange={(e) => setReportProofUrl(e.target.value)}
                      className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-emerald-500"
                    />
                  </div>

                  <button
                    disabled={submitting || !reportPrice || (!selectedProduct && !searchQuery.trim())}
                    onClick={handleReportSubmit}
                    className="w-full bg-emerald-600 text-white py-4 rounded-xl font-bold text-lg shadow-lg shadow-emerald-200 active:scale-95 transition-all disabled:opacity-50 disabled:shadow-none"
                  >
                    {submitting ? t.submitting : t.submit}
                  </button>
                </section>

                <section className="bg-emerald-50 p-4 rounded-2xl border border-emerald-100 flex items-start gap-3">
                  <Camera className="text-emerald-600 w-5 h-5 mt-0.5" />
                  <div>
                    <h4 className="text-sm font-bold text-emerald-800">{t.tipTitle}</h4>
                    <p className="text-xs text-emerald-700 leading-relaxed">
                      {t.tipBody}
                    </p>
                    <p className="mt-2 text-xs text-emerald-700 leading-relaxed">
                      {t.scrapeLinkHint}
                    </p>
                  </div>
                </section>
              </>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">
                {moderationSection === 'prices' ? t.moderationTitle : moderationSection === 'products' ? t.productsTitle : t.messagesTitle}
              </h2>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setModerationSection('prices')}
                  className={cn(
                    'rounded-xl px-3 py-2 text-sm font-semibold',
                    moderationSection === 'prices' ? 'bg-emerald-600 text-white' : 'border border-stone-200 bg-white text-stone-700'
                  )}
                >
                  {t.pricesTab}
                </button>
                <button
                  onClick={() => setModerationSection('products')}
                  className={cn(
                    'rounded-xl px-3 py-2 text-sm font-semibold',
                    moderationSection === 'products' ? 'bg-emerald-600 text-white' : 'border border-stone-200 bg-white text-stone-700'
                  )}
                >
                  {t.productsTab}
                </button>
                <button
                  onClick={() => setModerationSection('messages')}
                  className={cn(
                    'rounded-xl px-3 py-2 text-sm font-semibold',
                    moderationSection === 'messages' ? 'bg-emerald-600 text-white' : 'border border-stone-200 bg-white text-stone-700'
                  )}
                >
                  {t.messagesTab}
                </button>
                <button
                  onClick={
                    moderationSection === 'prices'
                      ? fetchModerationItems
                      : moderationSection === 'products'
                        ? fetchModerationProducts
                        : fetchModerationMessages
                  }
                  className="rounded-xl border border-stone-200 bg-white px-4 py-2 text-sm font-medium text-stone-700"
                >
                  {t.moderationRefresh}
                </button>
                {moderationSection === 'prices' && (
                  <button
                    onClick={approveSelectedModerationItems}
                    disabled={selectedModerationIds.length === 0 || moderationSavingId === 'bulk-approve'}
                    className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                  >
                    {t.moderationApproveSelected} ({selectedModerationIds.length})
                  </button>
                )}
              </div>
            </div>

            {moderationSection === 'prices' ? (
              <>
                {moderationItems.length > 0 && (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={selectAllModerationItems}
                      className="rounded-xl border border-stone-200 bg-white px-3 py-2 text-xs font-medium text-stone-700"
                    >
                      {t.moderationSelectAll}
                    </button>
                    <button
                      onClick={clearModerationSelection}
                      className="rounded-xl border border-stone-200 bg-white px-3 py-2 text-xs font-medium text-stone-700"
                    >
                      {t.moderationClearSelection}
                    </button>
                  </div>
                )}

                {moderationLoading ? (
                  <div className="animate-pulse space-y-3">
                    {[1, 2, 3].map(i => <div key={i} className="h-44 bg-stone-200 rounded-xl" />)}
                  </div>
                ) : moderationItems.length === 0 ? (
                  <div className="rounded-2xl border border-stone-200 bg-white p-8 text-center text-stone-500">
                    {t.moderationEmpty}
                  </div>
                ) : (
                  <div className="space-y-6">
                <section className="space-y-4">
                  {moderationItems.map(item => (
                    <div key={item.id} className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm space-y-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <label className="mb-2 flex items-center gap-2 text-xs text-stone-500">
                          <input
                            type="checkbox"
                            checked={selectedModerationIds.includes(item.id)}
                            onChange={() => toggleModerationSelection(item.id)}
                          />
                          {item.id}
                        </label>
                        <div className="text-xs font-semibold uppercase tracking-wider text-stone-400">ID</div>
                        <div className="text-sm font-medium text-stone-700">{item.id}</div>
                        <div className="mt-1 text-xs text-stone-500">{t.cityLabel}: {item.city || selectedCityLabel}</div>
                      </div>
                      <div className="text-right text-xs text-stone-500">
                        <div>{t.moderationUser}: {item.submitted_by}</div>
                        <div>{t.moderationDate}: {formatDistanceToNow(new Date(item.created_at), { addSuffix: true, locale: reportLocale })}</div>
                        <div>{t.moderationSource}: {item.source}</div>
                      </div>
                    </div>

                    <div className="grid gap-3 md:grid-cols-2">
                      <div>
                        <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-stone-500">{t.moderationName}</label>
                        <input
                          value={item.product_name_raw}
                          title={t.moderationName}
                          onChange={(e) => updateModerationField(item.id, 'product_name_raw', e.target.value)}
                          className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-stone-500">{t.moderationPrice}</label>
                        <input
                          type="number"
                          value={item.price}
                          title={t.moderationPrice}
                          onChange={(e) => updateModerationField(item.id, 'price', e.target.value)}
                          className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-stone-500">{t.moderationQty}</label>
                        <input
                          type="number"
                          value={item.quantity}
                          title={t.moderationQty}
                          onChange={(e) => updateModerationField(item.id, 'quantity', e.target.value)}
                          className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-stone-500">{t.moderationUnitPrice}</label>
                        <input
                          type="number"
                          value={item.unit_price}
                          title={t.moderationUnitPrice}
                          onChange={(e) => updateModerationField(item.id, 'unit_price', e.target.value)}
                          className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-2">
                      <button
                        onClick={() => saveModerationItem(item)}
                        disabled={moderationSavingId === item.id}
                        className="rounded-xl border border-stone-200 bg-stone-100 px-4 py-3 text-sm font-semibold text-stone-700 disabled:opacity-50"
                      >
                        {t.moderationSave}
                      </button>
                      <button
                        onClick={() => approveModerationItem(item)}
                        disabled={moderationSavingId === item.id}
                        className="rounded-xl bg-emerald-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
                      >
                        {t.moderationApprove}
                      </button>
                      <button
                        onClick={() => rejectModerationItem(item)}
                        disabled={moderationSavingId === item.id}
                        className="rounded-xl bg-rose-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
                      >
                        {t.moderationReject}
                      </button>
                    </div>
                    </div>
                  ))}
                </section>

                <section className="space-y-4">
                  <h3 className="text-sm font-semibold uppercase tracking-wider text-stone-500">{t.approvedTitle}</h3>
                  <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm space-y-3">
                    <div className="grid gap-3 md:grid-cols-2">
                      <input
                        value={newApprovedItem.product_name_raw}
                        onChange={(e) => setNewApprovedItem(prev => ({ ...prev, product_name_raw: e.target.value }))}
                        placeholder={t.moderationName}
                        className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
                      />
                      <input
                        type="number"
                        value={newApprovedItem.price}
                        onChange={(e) => setNewApprovedItem(prev => ({ ...prev, price: e.target.value }))}
                        placeholder={t.moderationPrice}
                        className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
                      />
                      <input
                        type="number"
                        value={newApprovedItem.quantity}
                        onChange={(e) => setNewApprovedItem(prev => ({ ...prev, quantity: e.target.value }))}
                        placeholder={t.moderationQty}
                        className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
                      />
                      <input
                        value={newApprovedItem.place_name}
                        onChange={(e) => setNewApprovedItem(prev => ({ ...prev, place_name: e.target.value }))}
                        placeholder={t.unknownStore}
                        className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
                      />
                      <input
                        value={newApprovedItem.place_address}
                        onChange={(e) => setNewApprovedItem(prev => ({ ...prev, place_address: e.target.value }))}
                        placeholder={t.locationLabel}
                        className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm md:col-span-2"
                      />
                    </div>
                    <button
                      onClick={createApprovedItem}
                      disabled={moderationSavingId === 'create-approved'}
                      className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                    >
                      {t.approvedCreate}
                    </button>
                  </div>

                  {approvedItems.length > 0 && (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={clearApprovedSelection}
                        className="rounded-xl border border-stone-200 bg-white px-3 py-2 text-xs font-medium text-stone-700"
                      >
                        {t.moderationClearSelection}
                      </button>
                      <button
                        onClick={deleteSelectedApprovedItems}
                        disabled={selectedApprovedIds.length === 0 || moderationSavingId === 'bulk-delete-approved'}
                        className="rounded-xl bg-rose-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
                      >
                        {t.approvedDeleteSelected} ({selectedApprovedIds.length})
                      </button>
                    </div>
                  )}

                  {approvedItems.length === 0 ? (
                    <div className="rounded-2xl border border-stone-200 bg-white p-8 text-center text-stone-500">
                      {t.approvedEmpty}
                    </div>
                  ) : approvedItems.map(item => (
                    <div key={item.id} className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <label className="mb-2 flex items-center gap-2 text-xs text-stone-500">
                            <input
                              type="checkbox"
                              checked={selectedApprovedIds.includes(item.id)}
                              onChange={() => toggleApprovedSelection(item.id)}
                            />
                            {item.id}
                          </label>
                          <div className="text-sm font-semibold text-stone-900">{item.product_name_raw}</div>
                          <div className="text-xs text-stone-500">{priceFormatter.format(item.price)} {t.sumLabel}</div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => saveApprovedItem(item)}
                            disabled={moderationSavingId === item.id}
                            className="rounded-xl border border-stone-200 bg-stone-100 px-4 py-2 text-sm font-semibold text-stone-700 disabled:opacity-50"
                          >
                            {t.approvedSave}
                          </button>
                          <button
                            onClick={() => deleteApprovedItem(item)}
                            disabled={moderationSavingId === item.id}
                            className="rounded-xl bg-rose-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                          >
                            {t.moderationDeleteApproved}
                          </button>
                        </div>
                      </div>
                      <div className="grid gap-3 md:grid-cols-2">
                        <input
                          value={item.product_name_raw}
                          onChange={(e) => updateApprovedField(item.id, 'product_name_raw', e.target.value)}
                          className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
                        />
                        <input
                          type="number"
                          value={item.price}
                          onChange={(e) => updateApprovedField(item.id, 'price', e.target.value)}
                          className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
                        />
                        <input
                          type="number"
                          value={item.quantity}
                          onChange={(e) => updateApprovedField(item.id, 'quantity', e.target.value)}
                          className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
                        />
                        <input
                          value={item.city || ''}
                          onChange={(e) => updateApprovedField(item.id, 'city', e.target.value)}
                          className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
                        />
                        <input
                          value={item.place_name || ''}
                          onChange={(e) => updateApprovedField(item.id, 'place_name', e.target.value)}
                          className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
                        />
                        <input
                          value={item.place_address || ''}
                          onChange={(e) => updateApprovedField(item.id, 'place_address', e.target.value)}
                          className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
                        />
                      </div>
                      <div className="text-xs text-stone-500">
                        <div>{t.moderationUser}: {item.submitted_by}</div>
                        <div>{t.moderationDate}: {formatDistanceToNow(new Date(item.receipt_date), { addSuffix: true, locale: reportLocale })}</div>
                        <div>{t.moderationSource}: {item.source}</div>
                        <div>{t.cityLabel}: {item.city || selectedCityLabel}</div>
                        <div>{item.place_name || t.unknownStore}</div>
                      </div>
                    </div>
                  ))}
                </section>
                  </div>
                )}
              </>
            ) : moderationSection === 'products' ? (
              <div className="space-y-4">
                <section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm space-y-3">
                  <div className="grid gap-3 md:grid-cols-2">
                    <input
                      value={newProductItem.name_uz}
                      onChange={(e) => setNewProductItem(prev => ({ ...prev, name_uz: e.target.value }))}
                      placeholder={t.productNameUz}
                      className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
                    />
                    <input
                      value={newProductItem.name_ru}
                      onChange={(e) => setNewProductItem(prev => ({ ...prev, name_ru: e.target.value }))}
                      placeholder={t.productNameRu}
                      className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
                    />
                    <input
                      value={newProductItem.name_en}
                      onChange={(e) => setNewProductItem(prev => ({ ...prev, name_en: e.target.value }))}
                      placeholder={t.productNameEn}
                      className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
                    />
                    <input
                      value={newProductItem.category}
                      onChange={(e) => setNewProductItem(prev => ({ ...prev, category: e.target.value }))}
                      placeholder={t.productCategory}
                      className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
                    />
                    <input
                      value={newProductItem.unit}
                      onChange={(e) => setNewProductItem(prev => ({ ...prev, unit: e.target.value }))}
                      placeholder={t.productUnit}
                      className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
                    />
                    <input
                      value={newProductItem.available_cities}
                      onChange={(e) => setNewProductItem(prev => ({ ...prev, available_cities: e.target.value }))}
                      placeholder={t.productCities}
                      className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
                    />
                  </div>
                  <button
                    onClick={createProductItem}
                    disabled={moderationSavingId === 'create-product'}
                    className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                  >
                    {t.productCreate}
                  </button>
                </section>

                <section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm space-y-3">
                  <div className="grid gap-3 md:grid-cols-3">
                    <input
                      value={productFilterQuery}
                      onChange={(e) => setProductFilterQuery(e.target.value)}
                      placeholder={t.productFilterSearch}
                      className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
                    />
                    <select
                      value={productFilterCategory}
                      onChange={(e) => setProductFilterCategory(e.target.value)}
                      className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
                    >
                      <option value="all">{t.productFilterCategory}: {t.allLabel}</option>
                      {productCategoryOptions.map(category => <option key={category} value={category}>{category}</option>)}
                    </select>
                    <select
                      value={productFilterCity}
                      onChange={(e) => setProductFilterCity(e.target.value)}
                      className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
                    >
                      <option value="all">{t.productFilterCity}: {t.allLabel}</option>
                      {productCityOptions.map(city => <option key={city} value={city}>{city}</option>)}
                    </select>
                    <select
                      value={productFilterHasPrices}
                      onChange={(e) => setProductFilterHasPrices(e.target.value as 'all' | 'yes' | 'no')}
                      className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
                    >
                      <option value="all">{t.productFilterHasPrices}: {t.allLabel}</option>
                      <option value="yes">{t.productFilterHasPrices}: {t.yesState}</option>
                      <option value="no">{t.productFilterHasPrices}: {t.noState}</option>
                    </select>
                    <select
                      value={productFilterHasPending}
                      onChange={(e) => setProductFilterHasPending(e.target.value as 'all' | 'yes' | 'no')}
                      className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
                    >
                      <option value="all">{t.productFilterHasPending}: {t.allLabel}</option>
                      <option value="yes">{t.productFilterHasPending}: {t.yesState}</option>
                      <option value="no">{t.productFilterHasPending}: {t.noState}</option>
                    </select>
                    <div className="grid grid-cols-2 gap-2">
                      <select
                        value={productSortBy}
                        onChange={(e) => setProductSortBy(e.target.value as 'name' | 'category' | 'price_count' | 'pending_count' | 'latest_receipt')}
                        className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
                      >
                        <option value="name">{t.sortName}</option>
                        <option value="category">{t.sortCategory}</option>
                        <option value="price_count">{t.sortPriceCount}</option>
                        <option value="pending_count">{t.sortPendingCount}</option>
                        <option value="latest_receipt">{t.sortLatestReceipt}</option>
                      </select>
                      <select
                        value={productSortDir}
                        onChange={(e) => setProductSortDir(e.target.value as 'asc' | 'desc')}
                        className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
                      >
                        <option value="asc">{t.productSortAsc}</option>
                        <option value="desc">{t.productSortDesc}</option>
                      </select>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={selectAllFilteredProducts}
                      className="rounded-xl border border-stone-200 bg-white px-3 py-2 text-xs font-medium text-stone-700"
                    >
                      {t.productSelectAll}
                    </button>
                    <button
                      onClick={clearProductSelection}
                      className="rounded-xl border border-stone-200 bg-white px-3 py-2 text-xs font-medium text-stone-700"
                    >
                      {t.productClearSelection}
                    </button>
                    <button
                      onClick={deleteSelectedProducts}
                      disabled={selectedProductIds.length === 0 || moderationSavingId === 'bulk-delete-products'}
                      className="rounded-xl bg-rose-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
                    >
                      {t.productDeleteSelected} ({selectedProductIds.length})
                    </button>
                    <button
                      onClick={purgeAllProductsData}
                      disabled={moderationSavingId === 'purge-all-products'}
                      className="rounded-xl bg-rose-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
                    >
                      {t.productPurgeAll}
                    </button>
                  </div>
                </section>

                {productAdminLoading ? (
                  <div className="animate-pulse space-y-3">
                    {[1, 2, 3].map(i => <div key={i} className="h-20 bg-stone-200 rounded-xl" />)}
                  </div>
                ) : filteredSortedProductAdminItems.length === 0 ? (
                  <div className="rounded-2xl border border-stone-200 bg-white p-8 text-center text-stone-500">
                    {t.productsEmpty}
                  </div>
                ) : (
                  <div className="rounded-2xl border border-stone-200 bg-white shadow-sm overflow-hidden">
                    {filteredSortedProductAdminItems.map(item => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setActiveProductId(item.id)}
                        className={cn(
                          'w-full border-b border-stone-100 px-4 py-3 text-left transition-colors last:border-b-0',
                          activeProductId === item.id ? 'bg-emerald-50' : 'bg-white hover:bg-stone-50'
                        )}
                      >
                        <div className="grid items-center gap-2 md:grid-cols-[24px,1.5fr,1fr,0.8fr,0.8fr,1.2fr]">
                          <input
                            type="checkbox"
                            checked={selectedProductIds.includes(item.id)}
                            onChange={(e) => {
                              e.stopPropagation();
                              toggleProductSelection(item.id);
                            }}
                            onClick={(e) => e.stopPropagation()}
                          />
                          <div>
                            <div className="text-sm font-semibold text-stone-900">{item.name_uz}</div>
                            <div className="text-xs text-stone-500">{item.id}</div>
                          </div>
                          <div className="text-xs text-stone-600">{item.category || '-'}</div>
                          <div className="text-xs text-stone-600">{t.productPriceCount}: {item.price_count || 0}</div>
                          <div className="text-xs text-stone-600">{t.productPendingCount}: {item.pending_count || 0}</div>
                          <div className="text-xs text-stone-600 truncate">{(item.available_cities || []).join(', ') || '-'}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}

                {activeProductItem && (
                  <section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm space-y-4">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-semibold text-stone-800">{activeProductItem.name_uz}</div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => saveProductItem(activeProductItem)}
                          disabled={moderationSavingId === activeProductItem.id}
                          className="rounded-xl border border-stone-200 bg-stone-100 px-4 py-2 text-sm font-semibold text-stone-700 disabled:opacity-50"
                        >
                          {t.productSave}
                        </button>
                        <button
                          onClick={() => deleteProductItem(activeProductItem)}
                          disabled={moderationSavingId === activeProductItem.id}
                          className="rounded-xl bg-rose-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                        >
                          {t.productDelete}
                        </button>
                      </div>
                    </div>

                    <div className="grid gap-3 md:grid-cols-2">
                      <input
                        value={activeProductItem.name_uz || ''}
                        onChange={(e) => updateProductField(activeProductItem.id, 'name_uz', e.target.value)}
                        placeholder={t.productNameUz}
                        className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
                      />
                      <input
                        value={activeProductItem.name_ru || ''}
                        onChange={(e) => updateProductField(activeProductItem.id, 'name_ru', e.target.value)}
                        placeholder={t.productNameRu}
                        className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
                      />
                      <input
                        value={activeProductItem.name_en || ''}
                        onChange={(e) => updateProductField(activeProductItem.id, 'name_en', e.target.value)}
                        placeholder={t.productNameEn}
                        className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
                      />
                      <input
                        value={activeProductItem.category || ''}
                        onChange={(e) => updateProductField(activeProductItem.id, 'category', e.target.value)}
                        placeholder={t.productCategory}
                        className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
                      />
                      <input
                        value={activeProductItem.unit || ''}
                        onChange={(e) => updateProductField(activeProductItem.id, 'unit', e.target.value)}
                        placeholder={t.productUnit}
                        className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
                      />
                      <input
                        value={(activeProductItem.available_cities || []).join(', ')}
                        onChange={(e) => updateProductField(activeProductItem.id, 'available_cities', e.target.value)}
                        placeholder={t.productCities}
                        className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
                      />
                    </div>

                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="rounded-xl border border-stone-200 bg-stone-50 p-3">
                        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-stone-500">{t.productLinkedPrices}</div>
                        <div className="max-h-40 space-y-2 overflow-auto text-xs text-stone-600">
                          {(activeProductItem.prices || []).length === 0 ? (
                            <div className="text-stone-400">{t.noData}</div>
                          ) : (activeProductItem.prices || []).slice(0, 20).map(price => (
                            <div key={price.id} className="rounded-lg bg-white p-2">
                              <div className="font-medium">{price.product_name_raw}</div>
                              <div>{priceFormatter.format(Number(price.price) || 0)} {t.sumLabel}</div>
                              <div>{price.city || '-'}</div>
                              <div>{price.place_name || '-'}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="rounded-xl border border-stone-200 bg-stone-50 p-3">
                        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-stone-500">{t.productLinkedPending}</div>
                        <div className="max-h-40 space-y-2 overflow-auto text-xs text-stone-600">
                          {(activeProductItem.pending || []).length === 0 ? (
                            <div className="text-stone-400">{t.noData}</div>
                          ) : (activeProductItem.pending || []).slice(0, 20).map(pendingItem => (
                            <div key={pendingItem.id} className="rounded-lg bg-white p-2">
                              <div className="font-medium">{pendingItem.product_name_raw}</div>
                              <div>{pendingItem.city || '-'}</div>
                              <div>{pendingItem.status || 'pending'}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </section>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                {messagesLoading ? (
                  <div className="animate-pulse space-y-3">
                    {[1, 2, 3].map(i => <div key={i} className="h-24 bg-stone-200 rounded-xl" />)}
                  </div>
                ) : contactMessages.length === 0 ? (
                  <div className="rounded-2xl border border-stone-200 bg-white p-8 text-center text-stone-500">
                    {t.messagesEmpty}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {contactMessages.map((item) => (
                      <div key={item.id} className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm space-y-2">
                        <div className="text-xs text-stone-500">{t.contactReceivedAt}: {formatDistanceToNow(new Date(item.created_at), { addSuffix: true, locale: reportLocale })}</div>
                        <div className="text-sm"><span className="font-semibold">{t.contactNameLabel}:</span> {item.name || '-'}</div>
                        <div className="text-sm"><span className="font-semibold">{t.contactChannelLabel}:</span> {item.contact || '-'}</div>
                        <div className="text-sm"><span className="font-semibold">{t.contactMessageLabel}:</span> {item.message || '-'}</div>
                        <div className="text-xs text-stone-500">{t.contactUserLabel}: {item.telegram_username ? `@${item.telegram_username}` : (item.telegram_id || '-')}</div>
                        <div className="text-xs text-stone-500">{t.contactLanguageLabel}: {item.language || '-'}</div>
                        <div className="text-xs text-stone-500">{t.contactCityLabel}: {item.city || '-'}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </main>

      <div className="pb-20 px-4 text-center text-xs font-semibold text-emerald-700">
        {t.tagline}
      </div>

      {/* Bottom Nav */}
      <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-stone-200 px-6 py-3 flex justify-around items-center z-50">
        <button 
          onClick={() => setMode('find')}
          className={cn("flex flex-col items-center gap-1", mode === 'find' ? "text-emerald-600" : "text-stone-400")}
        >
          <Search className="w-6 h-6" />
          <span className="text-[10px] font-bold uppercase tracking-widest">{t.modeFind}</span>
        </button>
        <button 
          onClick={() => setMode('report')}
          className={cn("flex flex-col items-center gap-1", mode === 'report' ? "text-emerald-600" : "text-stone-400")}
        >
          <Plus className="w-6 h-6" />
          <span className="text-[10px] font-bold uppercase tracking-widest">{t.modeReport}</span>
        </button>
        {isAdminUser && (
          <button 
            onClick={() => setMode('moderate')}
            className={cn("flex flex-col items-center gap-1", mode === 'moderate' ? "text-emerald-600" : "text-stone-400")}
          >
            <Check className="w-6 h-6" />
            <span className="text-[10px] font-bold uppercase tracking-widest">{t.modeModerate}</span>
          </button>
        )}
      </nav>
    </div>
  );
}

// Extend Window interface for Telegram
declare global {
  interface Window {
    Telegram?: {
      WebApp: {
        ready: () => void;
        expand: () => void;
        showAlert: (message: string) => void;
        openLink?: (url: string) => void;
        showScanQrPopup?: (params: { text?: string }, callback: (scannedText: string) => boolean) => void;
        closeScanQrPopup?: () => void;
        initData: string;
        initDataUnsafe: {
          user?: {
            id: number;
            first_name: string;
            username?: string;
            language_code?: string;
          };
        };
      };
    };
  }
}
