/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState, useMemo } from 'react';
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
  receipt_date: string;
  submitted_by: string;
  source: string;
  city?: string | null;
}

// Map Updater Component
function ChangeView({ center, zoom }: { center: [number, number]; zoom: number }) {
  const map = useMap();
  map.setView(center, zoom);
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
  const [moderationLoading, setModerationLoading] = useState(false);
  const [moderationSavingId, setModerationSavingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [selectedCity, setSelectedCity] = useState(DEFAULT_CITY);
  const [nearbyEnabled, setNearbyEnabled] = useState(false);
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [geoError, setGeoError] = useState('');
  const priceFormatter = useMemo(() => new Intl.NumberFormat('en-US'), []);
  const telegramUserId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id?.toString() || '';
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
        searchPlaceholder: 'Mahsulot nomi (masalan: Shakar)',
        emptyTitle: 'Narxlarni qidirish',
        emptyHint: 'Tanlangan shaharda eng arzon narxlarni topish uchun mahsulot nomini kiriting',
        cheapestTitle: 'Eng arzon 5 ta joy',
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
        scanErrorNetwork: 'Tarmoq xatosi yuz berdi. Internetni tekshirib qayta urinib ko‘ring.',
        scanAgain: 'Yana skanerlash',
        goHome: 'Bosh sahifaga',
        retry: 'Qayta urinish',
        switchManual: "Qo'lda kiritish",
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
        searchPlaceholder: 'Название товара (например: Сахар)',
        emptyTitle: 'Поиск цен',
        emptyHint: 'Введите название товара, чтобы найти самые дешевые цены в выбранном городе',
        cheapestTitle: 'Топ 5 самых дешевых мест',
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
        scanAgain: 'Сканировать снова',
        goHome: 'На главную',
        retry: 'Повторить',
        switchManual: 'Ввести вручную',
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
        searchPlaceholder: 'Product name (e.g., Sugar)',
        emptyTitle: 'Find prices',
        emptyHint: 'Type a product name to find the cheapest prices in the selected city',
        cheapestTitle: 'Top 5 cheapest places',
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
        scanAgain: 'Scan again',
        goHome: 'Home',
        retry: 'Retry',
        switchManual: 'Manual entry',
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
  const [reportPhoto, setReportPhoto] = useState<File | null>(null);
  const [reportEntryStep, setReportEntryStep] = useState<'entry' | 'manual' | 'loading' | 'result'>('entry');
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [scanUrlInput, setScanUrlInput] = useState('');
  const [scanResult, setScanResult] = useState<{
    status: 'success' | 'duplicate' | 'error';
    storeName?: string;
    storeAddress?: string;
    city?: string;
    itemCount?: number;
    queuedWithoutParse?: boolean;
    errorCode?: string;
  } | null>(null);

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
    } catch {
      window.Telegram?.WebApp?.showAlert(t.moderationError);
    } finally {
      setModerationLoading(false);
    }
  };

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

  useEffect(() => {
    if (mode === 'moderate' && isAdminUser) {
      fetchModerationItems();
    }
  }, [mode, isAdminUser, selectedCity]);

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
      (p.name_en || '').toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [searchQuery, cityProducts]);

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
  };

  const sortedPrices = useMemo(() => {
    const withDistance = prices.map(price => ({
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
    if (nearbyEnabled && userLocation) {
      return [userLocation.lat, userLocation.lng];
    }
    return selectedCityOption.center;
  }, [nearbyEnabled, userLocation, selectedCityOption]);

  const findMapZoom = nearbyEnabled && userLocation ? 13 : selectedCityOption.zoom;

  const requestUserLocation = (onSuccess?: (coords: { lat: number; lng: number }) => void) => {
    if (!navigator.geolocation) {
      setGeoError(t.nearbyError);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setUserLocation(coords);
        setGeoError('');
        onSuccess?.(coords);
      },
      () => {
        setGeoError(t.nearbyError);
        setNearbyEnabled(false);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 }
    );
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

  const handleReportSubmit = async () => {
    if (!reportPrice || (!selectedProduct && !searchQuery.trim())) {
      window.Telegram?.WebApp?.showAlert(t.alertFill);
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
      source: 'manual',
      submitted_by: window.Telegram?.WebApp?.initDataUnsafe?.user?.id?.toString() || 'unknown',
      photo_url: null,
    });

    setSubmitting(false);
    if (!error) {
      window.Telegram?.WebApp?.showAlert(t.alertSuccess);
      setMode('find');
      setReportPrice('');
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

  const goToManualEntry = () => {
    setReportEntryStep('manual');
    setShowUrlInput(false);
    setScanResult(null);
  };

  const goToReportHome = () => {
    setMode('find');
    setReportEntryStep('entry');
    setShowUrlInput(false);
    setScanResult(null);
    setScanUrlInput('');
  };

  const extractSoliqUrlFromText = (input: string) => {
    const raw = String(input || '').trim();
    if (!raw) return null;

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
        return buildCheckFromParams(parsed.search) || parsed.toString();
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
    if (errorCode === 'parse_empty') {
      return t.scanErrorParseEmpty;
    }
    if (errorCode === 'network_error') {
      return t.scanErrorNetwork;
    }
    return t.scanErrorBody;
  };

  const handleSoliqUrl = async (url: string) => {
    const scannedUrl = extractSoliqUrlFromText(url);
    if (!scannedUrl) {
      setScanResult({ status: 'error', errorCode: 'not_soliq_url' });
      setReportEntryStep('result');
      return;
    }

    setShowUrlInput(false);
    setScanResult(null);
    setReportEntryStep('loading');

    try {
      const response = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: scannedUrl,
          telegram_id: window.Telegram?.WebApp?.initDataUnsafe?.user?.id?.toString() || 'anonymous',
          city: selectedCity,
        }),
      });

      const result = await response.json();

      if (result?.ok) {
        setScanResult({
          status: 'success',
          storeName: result.store_name,
          storeAddress: result.store_address,
          city: result.city,
          itemCount: result.item_count,
          queuedWithoutParse: Boolean(result.queued_without_parse),
        });
      } else if (result?.error === 'duplicate') {
        setScanResult({ status: 'duplicate', errorCode: 'duplicate' });
      } else {
        setScanResult({ status: 'error', errorCode: result?.error || 'scan_failed' });
      }
    } catch {
      setScanResult({ status: 'error', errorCode: 'network_error' });
    } finally {
      setReportEntryStep('result');
    }
  };

  const openNativeQrScanner = () => {
    const scanner = window.Telegram?.WebApp?.showScanQrPopup;
    if (typeof scanner === 'function') {
      scanner({ text: t.scanPopupText }, (scannedText: string) => {
        const value = extractSoliqUrlFromText(scannedText || '');
        if (value) {
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
        {(mode === 'find' || (mode === 'report' && reportEntryStep === 'manual')) && <div className="relative">
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
              <div className="mt-2 text-xs text-stone-500">{t.nearbyHint}</div>
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
                            <p className="text-xs text-stone-400 truncate">{p.city || selectedCityLabel}</p>
                            <p className="text-xs text-stone-400">
                              {formatDistanceToNow(new Date(p.receipt_date), { addSuffix: true, locale: reportLocale })}
                            </p>
                            {nearbyEnabled && userLocation && p.distanceKm !== null && p.distanceKm !== undefined && Number.isFinite(p.distanceKm) && (
                              <p className="text-xs font-medium text-emerald-700">
                                {t.nearbyDistance}: {p.distanceKm.toFixed(1)} km
                              </p>
                            )}
                          </div>
                          <div className="text-right">
                            <button title={t.mapTitle} className="p-2 text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors">
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
                      style={{ height: '100%', width: '100%' }}
                      zoomControl={false}
                    >
                      <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                      <ChangeView center={findMapCenter} zoom={findMapZoom} />
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
              <section className="rounded-2xl border border-stone-200 bg-white p-10 text-center">
                <div className="text-xl font-bold text-stone-900">{t.scanLoadingTitle}</div>
                <div className="mt-4 flex justify-center">
                  <Loader2 className="h-8 w-8 animate-spin text-emerald-600" />
                </div>
                <div className="mt-4 text-sm text-stone-600">{t.scanLoadingHint}</div>
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
              </section>
            )}

            {reportEntryStep === 'result' && scanResult?.status === 'duplicate' && (
              <section className="rounded-2xl border border-stone-200 bg-white p-6 space-y-4">
                <div className="text-xl font-bold text-stone-900">{t.scanDuplicateTitle}</div>
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={retryScan} className="rounded-xl bg-emerald-600 px-4 py-3 text-sm font-semibold text-white">{t.scanAgain}</button>
                  <button onClick={goToReportHome} className="rounded-xl border border-stone-300 bg-stone-50 px-4 py-3 text-sm font-semibold text-stone-700">{t.goHome}</button>
                </div>
              </section>
            )}

            {reportEntryStep === 'result' && scanResult?.status === 'error' && (
              <section className="rounded-2xl border border-rose-200 bg-rose-50 p-6 space-y-4">
                <div className="text-xl font-bold text-rose-900">{t.scanErrorTitle}</div>
                <div className="whitespace-pre-line text-sm text-rose-800">{getScanErrorBody(scanResult.errorCode)}</div>
                {scanResult.errorCode && (
                  <div className="text-xs text-rose-700/80">Code: {scanResult.errorCode}</div>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={retryScan} className="rounded-xl bg-rose-600 px-4 py-3 text-sm font-semibold text-white">{t.retry}</button>
                  <button onClick={goToManualEntry} className="rounded-xl border border-rose-300 bg-white px-4 py-3 text-sm font-semibold text-rose-700">{t.switchManual}</button>
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
                    <label className="block text-xs font-semibold text-stone-500 uppercase tracking-wider mb-2">{t.photoLabel}</label>
                    <input
                      type="file"
                      accept="image/*"
                      title={t.photoLabel}
                      onChange={(e) => setReportPhoto(e.target.files?.[0] || null)}
                      className="w-full text-sm text-stone-600 file:mr-3 file:rounded-lg file:border-0 file:bg-stone-100 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-stone-700 hover:file:bg-stone-200"
                    />
                    {reportPhoto && (
                      <div className="mt-2 text-xs text-stone-500">{reportPhoto.name}</div>
                    )}
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
              <h2 className="text-lg font-semibold">{t.moderationTitle}</h2>
              <button
                onClick={fetchModerationItems}
                className="rounded-xl border border-stone-200 bg-white px-4 py-2 text-sm font-medium text-stone-700"
              >
                {t.moderationRefresh}
              </button>
            </div>

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
                  {approvedItems.length === 0 ? (
                    <div className="rounded-2xl border border-stone-200 bg-white p-8 text-center text-stone-500">
                      {t.approvedEmpty}
                    </div>
                  ) : approvedItems.map(item => (
                    <div key={item.id} className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold text-stone-900">{item.product_name_raw}</div>
                          <div className="text-xs text-stone-500">{priceFormatter.format(item.price)} {t.sumLabel}</div>
                        </div>
                        <button
                          onClick={() => deleteApprovedItem(item)}
                          disabled={moderationSavingId === item.id}
                          className="rounded-xl bg-rose-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                        >
                          {t.moderationDeleteApproved}
                        </button>
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
          </div>
        )}
      </main>

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
        showScanQrPopup?: (params: { text?: string }, callback: (scannedText: string) => boolean) => void;
        closeScanQrPopup?: () => void;
        initData: string;
        initDataUnsafe: {
          user?: {
            id: number;
            first_name: string;
          };
        };
      };
    };
  }
}
