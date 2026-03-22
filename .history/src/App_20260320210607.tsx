/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState, useMemo } from 'react';
import { createClient } from '@supabase/supabase-js';
import { Search, MapPin, Plus, ChevronRight, Navigation, Camera, Check } from 'lucide-react';
import { MapContainer, TileLayer, CircleMarker, Popup, useMap, useMapEvents } from 'react-leaflet';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { formatDistanceToNow } from 'date-fns';
import { enUS, ru, uz } from 'date-fns/locale';

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
  const [moderationLoading, setModerationLoading] = useState(false);
  const [moderationSavingId, setModerationSavingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const priceFormatter = useMemo(() => new Intl.NumberFormat('en-US'), []);
  const telegramUserId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id?.toString() || '';
  const telegramInitData = window.Telegram?.WebApp?.initData || '';
  const isAdminUser = adminTelegramIds.includes(telegramUserId);

  const copy = useMemo(
    () => ({
      uz: {
        appName: 'Narxi',
        modeFind: 'Topish',
        modeReport: "Qo'shish",
        modeModerate: 'Tasdiqlash',
        searchPlaceholder: 'Mahsulot nomi (masalan: Shakar)',
        emptyTitle: 'Narxlarni qidirish',
        emptyHint: "Toshkent bo'ylab eng arzon narxlarni topish uchun mahsulot nomini kiriting",
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
        alertFill: "Iltimos, barcha maydonlarni to'ldiring",
        alertSuccess: "Narxingiz yuborildi va ko'rib chiqilgandan so'ng qo'shiladi ✅",
        alertError: "Xatolik yuz berdi. Qayta urinib ko'ring.",
        locationHint: "Joylashuv tanlanmagan",
        photoLabel: "Chek rasmi (ixtiyoriy)",
        sumLabel: "so'm",
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
      },
      ru: {
        appName: 'Narxi',
        modeFind: 'Поиск',
        modeReport: 'Добавить',
        modeModerate: 'Модерация',
        searchPlaceholder: 'Название товара (например: Сахар)',
        emptyTitle: 'Поиск цен',
        emptyHint: 'Введите название товара, чтобы найти самые дешевые цены по Ташкенту',
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
        alertFill: 'Пожалуйста, заполните все поля',
        alertSuccess: 'Цена отправлена и будет добавлена после проверки ✅',
        alertError: 'Произошла ошибка. Попробуйте еще раз.',
        locationHint: 'Локация не выбрана',
        photoLabel: 'Фото чека (необязательно)',
        sumLabel: 'сум',
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
      },
      en: {
        appName: 'Narxi',
        modeFind: 'Find',
        modeReport: 'Add',
        modeModerate: 'Moderate',
        searchPlaceholder: 'Product name (e.g., Sugar)',
        emptyTitle: 'Find prices',
        emptyHint: 'Type a product name to find the cheapest prices across Tashkent',
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
        alertFill: 'Please fill in all fields',
        alertSuccess: 'Your price was submitted and will be added after review ✅',
        alertError: 'Something went wrong. Please try again.',
        locationHint: 'Location not selected',
        photoLabel: 'Receipt photo (optional)',
        sumLabel: 'sum',
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
      },
    }),
    []
  );

  const t = copy[lang];

  // Report Form State
  const [reportPrice, setReportPrice] = useState('');
  const [reportLocation, setReportLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [reportPhoto, setReportPhoto] = useState<File | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const initialMode = params.get('mode') as 'find' | 'report' | 'moderate';
    const initialLang = params.get('lang') as 'uz' | 'ru' | 'en';
    if (initialMode && (initialMode !== 'moderate' || isAdminUser)) setMode(initialMode);
    if (initialLang) setLang(initialLang);

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
      .order('price', { ascending: true })
      .limit(20);

    if (data) setPrices(data);
    setLoading(false);
  };

  const normalizePendingItem = (item: any): PendingModerationItem => ({
    ...item,
    price: Number(item.price) || 0,
    quantity: Number(item.quantity) || 1,
    unit_price: Number(item.unit_price) || Number(item.price) || 0,
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
      const result = await callModerationApi('list');
      setModerationItems((result.items || []).map(normalizePendingItem));
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

  useEffect(() => {
    if (mode === 'moderate' && isAdminUser) {
      fetchModerationItems();
    }
  }, [mode, isAdminUser]);

  const filteredProducts = useMemo(() => {
    if (!searchQuery) return [];
    return products.filter(p => 
      p.name_uz.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.name_ru.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (p.name_en || '').toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [searchQuery, products]);

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

    if (mode === 'find') {
      await loadPricesForProduct(product.id);
    }
  };

  const mapPrices = useMemo(
    () => prices.filter(p => p.latitude !== null && p.longitude !== null),
    [prices]
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
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition((pos) => {
        setReportLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      });
    }
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

        {/* Search Bar */}
        {mode !== 'moderate' && <div className="relative">
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
                    ) : prices.length > 0 ? (
                      prices.slice(0, 5).map((p, i) => (
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
                            <p className="text-xs text-stone-400">
                              {formatDistanceToNow(new Date(p.receipt_date), { addSuffix: true, locale: reportLocale })}
                            </p>
                          </div>
                          <div className="text-right">
                            <button className="p-2 text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors">
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
                  <div className="h-[300px] rounded-2xl overflow-hidden border border-stone-200 shadow-inner relative z-0">
                    <MapContainer 
                      center={[41.2995, 69.2401]} 
                      zoom={12} 
                      style={{ height: '100%', width: '100%' }}
                      zoomControl={false}
                    >
                      <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
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
                            </div>
                          </Popup>
                        </CircleMarker>
                      ))}
                      {mapPrices.length > 0 && (
                        <ChangeView center={[mapPrices[0].latitude!, mapPrices[0].longitude!]} zoom={13} />
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
            <section className="bg-white p-6 rounded-2xl border border-stone-200 shadow-sm space-y-4">
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
                <div className="mt-3 h-[200px] rounded-xl overflow-hidden border border-stone-200 relative">
                  <MapContainer
                    center={reportLocation ? [reportLocation.lat, reportLocation.lng] : [41.2995, 69.2401]}
                    zoom={reportLocation ? 15 : 12}
                    style={{ height: '100%', width: '100%' }}
                    zoomControl={false}
                  >
                    <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
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
              </div>
            </section>
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
              <div className="space-y-4">
                {moderationItems.map(item => (
                  <div key={item.id} className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm space-y-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-xs font-semibold uppercase tracking-wider text-stone-400">ID</div>
                        <div className="text-sm font-medium text-stone-700">{item.id}</div>
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
                          onChange={(e) => updateModerationField(item.id, 'product_name_raw', e.target.value)}
                          className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-stone-500">{t.moderationPrice}</label>
                        <input
                          type="number"
                          value={item.price}
                          onChange={(e) => updateModerationField(item.id, 'price', e.target.value)}
                          className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-stone-500">{t.moderationQty}</label>
                        <input
                          type="number"
                          value={item.quantity}
                          onChange={(e) => updateModerationField(item.id, 'quantity', e.target.value)}
                          className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-stone-500">{t.moderationUnitPrice}</label>
                        <input
                          type="number"
                          value={item.unit_price}
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
