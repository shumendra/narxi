/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState, useMemo, useRef } from 'react';
import { createClient } from '@supabase/supabase-js';
import { Search, MapPin, Plus, ChevronRight, Navigation, Camera, Check, QrCode, PencilLine, Loader2, ShoppingCart, Download, Upload, X, Crosshair, Copy, ChevronDown } from 'lucide-react';
import { MapContainer, TileLayer, CircleMarker, Popup, Polyline, useMap, useMapEvents } from 'react-leaflet';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { formatDistanceToNow } from 'date-fns';
import { enUS, ru, uz } from 'date-fns/locale';
import { CITY_OPTIONS, DEFAULT_CITY, getCityLabel, getCityOption } from './constants/cities.js';
import { haversineDistanceKm } from './utils/haversine.js';
import { TASHKENT_DISTRICTS, DISTRICT_LIST, findDistrict } from './constants/districts.js';

// Utility for Tailwind classes
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

function normalizeProductNameKey(value: string | null | undefined) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u02BC]/g, "'")
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Supabase Client
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
const adminTelegramIds = (import.meta.env.VITE_ADMIN_TELEGRAM_IDS || import.meta.env.VITE_ADMIN_TELEGRAM_ID || '7240925672')
  .split(',')
  .map((id: string) => id.trim())
  .filter(Boolean);
const supabase = createClient(supabaseUrl, supabaseKey);

// Known store locations for display name resolution — fetched dynamically
let _knownStoresCache: Array<{ name: string; lat: number; lng: number }> | null = null;

async function fetchKnownStores(): Promise<Array<{ name: string; lat: number; lng: number }>> {
  if (_knownStoresCache) return _knownStoresCache;
  const stores: Array<{ name: string; lat: number; lng: number }> = [];
  try {
    // Makro: regions 1-14
    const makroFetches = Array.from({ length: 14 }, (_, i) =>
      fetch(`https://api.makromarket.uz/api/location-list/?region=${i + 1}`, {
        headers: { 'Accept': 'application/json', 'Origin': 'https://makromarket.uz' },
      }).then(r => r.json()).catch(() => [])
    );
    const makroRegions = await Promise.all(makroFetches);
    for (const region of makroRegions) {
      if (Array.isArray(region)) {
        for (const s of region) {
          const lat = parseFloat(s.latitude);
          const lng = parseFloat(s.longitude);
          if (lat && lng) stores.push({ name: s.title || 'Makro', lat, lng });
        }
      }
    }
    // Korzinka
    const kRes = await fetch('https://api.korzinka.uz/shop_search/?q=&category[]=66&category[]=64', {
      headers: { 'Accept': 'application/json', 'Origin': 'https://korzinka.uz' },
    });
    const kData = await kRes.json();
    const kItems = kData?.data?.items?.ru || kData?.data?.items?.uz || [];
    for (const s of kItems) {
      const lat = parseFloat(s.location?.lat);
      const lng = parseFloat(s.location?.lon);
      if (lat && lng) stores.push({ name: s.name || 'Korzinka', lat, lng });
    }

    // Baraka Market branches
    const bRes = await fetch('https://backend.barakamarket.uz/shop/', {
      headers: { 'Accept': 'application/json', 'Origin': 'https://barakamarket.uz' },
    });
    const bData = await bRes.json();
    const bItems = Array.isArray(bData) ? bData : (Array.isArray(bData?.results) ? bData.results : []);
    for (const s of bItems) {
      let lat = parseFloat(String(s.latitude ?? s.lat ?? '0'));
      let lng = parseFloat(String(s.longitude ?? s.lng ?? s.lon ?? '0'));
      if (Math.abs(lat) > 55 && Math.abs(lng) < 55) {
        const tmp = lat;
        lat = lng;
        lng = tmp;
      }
      if (lat && lng) stores.push({ name: `Baraka Market ${s.title || ''}`.trim(), lat, lng });
    }
  } catch { /* use whatever we got */ }
  // Deduplicate by coordinates
  const seen = new Set<string>();
  _knownStoresCache = stores.filter(s => {
    const key = `${s.lat.toFixed(4)},${s.lng.toFixed(4)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return _knownStoresCache;
}

// Fallback for sync usage (before fetch completes)
const KNOWN_STORES_FALLBACK: Array<{ name: string; lat: number; lng: number }> = [
  { name: 'Makro', lat: 41.313097, lng: 69.332279 },
  { name: 'Makro', lat: 41.304013, lng: 69.322374 },
  { name: 'Korzinka', lat: 41.300976, lng: 69.263439 },
  { name: 'Korzinka', lat: 41.327718, lng: 69.343438 },
];

function identifyStoreByCoords(lat: number, lng: number, knownStores?: Array<{ name: string; lat: number; lng: number }>): string | null {
  const stores = knownStores || _knownStoresCache || KNOWN_STORES_FALLBACK;
  for (const s of stores) {
    const dlat = (s.lat - lat) * 111320;
    const dlng = (s.lng - lng) * 111320 * Math.cos(lat * Math.PI / 180);
    if (Math.sqrt(dlat * dlat + dlng * dlng) < 500) return s.name; // within 500m
  }
  return null;
}

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
  source?: string | null;
  price_scope?: 'chain' | 'location' | null;
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
  latitude?: number | null;
  longitude?: number | null;
  receipt_url?: string | null;
  photo_url?: string | null;
  price_scope?: 'chain' | 'location' | null;
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
  details_loaded?: boolean;
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

interface ReceiptLinkItem {
  id: string;
  receipt_url: string;
  telegram_id?: string | null;
  city?: string | null;
  status?: string | null;
  error_message?: string | null;
  created_at?: string | null;
  processed_at?: string | null;
  pipeline_status: 'scanned' | 'failed' | 'unscanned';
}

interface StoreRecord {
  id: string | null;
  name: string;
  name_ru?: string | null;
  chain?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  address?: string | null;
  city?: string | null;
  times_submitted?: number;
  verified?: boolean;
  isNew?: boolean;
  distance?: number | null;
}

interface ReportItem {
  id: string;
  product: Product | null;
  productQuery: string;
  price: string;
  showDropdown: boolean;
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

function StorePinPicker({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMapEvents({ click(e) { onPick(e.latlng.lat, e.latlng.lng); } });
  return null;
}

interface StoreSelectorT {
  storeSelectLabel: string;
  storeSearchPlaceholder: string;
  storeVerifiedGroup: string;
  storeOtherGroup: string;
  storeAddNew: string;
  storeAddNewHint: string;
  storeNewTitle: string;
  storeNewName: string;
  storeNewNamePlaceholder: string;
  storePinHint: string;
  storePinMissing: string;
  storeConfirm: string;
  storeBack: string;
  storeSearching: string;
  storeTypeToSearch: string;
}

function StoreSelector({
  city, userLat, userLng, onStoreSelected, selectedStore, t,
}: {
  city: string;
  userLat: number | null;
  userLng: number | null;
  onStoreSelected: (store: StoreRecord | null) => void;
  selectedStore: StoreRecord | null;
  t: StoreSelectorT;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<StoreRecord[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newStoreName, setNewStoreName] = useState('');
  const [pinLat, setPinLat] = useState<number | null>(userLat);
  const [pinLng, setPinLng] = useState<number | null>(userLng);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!showDropdown) return;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let q: any = supabase.from('stores').select('*').eq('city', city);
        if (query.length >= 2) {
          q = q.or(`name.ilike.%${query}%,address.ilike.%${query}%`);
        } else if (userLat && userLng) {
          q = q.eq('verified', true).limit(20);
        } else {
          setResults([]);
          setSearching(false);
          return;
        }
        const { data } = await q
          .order('verified', { ascending: false })
          .order('times_submitted', { ascending: false })
          .limit(12);
        let stores = (data || []) as StoreRecord[];
        if (userLat && userLng) {
          stores = stores
            .map(s => ({
              ...s,
              distance: s.latitude != null && s.longitude != null
                ? Math.round(haversineDistanceKm({ lat: userLat, lng: userLng }, { lat: s.latitude as number, lng: s.longitude as number }) * 1000)
                : null,
            }))
            .sort((a, b) => {
              if ((a.verified ? 1 : 0) !== (b.verified ? 1 : 0)) return (b.verified ? 1 : 0) - (a.verified ? 1 : 0);
              if (a.distance != null && b.distance != null) return a.distance - b.distance;
              return 0;
            });
        }
        setResults(stores);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, showDropdown, city, userLat, userLng]);

  const fmtDist = (m: number | null | undefined) => {
    if (m == null) return '';
    return m < 1000 ? `${m}m` : `${(m / 1000).toFixed(1)}km`;
  };

  if (showNewForm) {
    return (
      <div>
        <div className="flex items-center gap-2 mb-3">
          <button type="button" onClick={() => { setShowNewForm(false); setQuery(''); }} className="text-sm text-emerald-600 font-medium">← {t.storeBack}</button>
          <span className="font-bold text-stone-900 text-sm">{t.storeNewTitle}</span>
        </div>
        <label className="block text-xs font-semibold text-stone-500 uppercase tracking-wider mb-1">{t.storeNewName}</label>
        <input
          autoFocus type="text" value={newStoreName}
          onChange={e => setNewStoreName(e.target.value)}
          placeholder={t.storeNewNamePlaceholder}
          className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm mb-3 outline-none focus:ring-2 focus:ring-emerald-500"
        />
        <label className="block text-xs font-semibold text-stone-500 uppercase tracking-wider mb-1">{t.storePinHint}</label>
        <div className="rounded-xl overflow-hidden border border-stone-200 mb-2" style={{ height: 180 }}>
          <MapContainer center={[pinLat ?? 41.2995, pinLng ?? 69.2401]} zoom={14} style={{ height: '100%', width: '100%' }} zoomControl={false}>
            <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            <StorePinPicker onPick={(la, ln) => { setPinLat(la); setPinLng(ln); }} />
            {pinLat != null && pinLng != null && (
              <CircleMarker center={[pinLat, pinLng]} radius={10} fillColor="#16a34a" color="white" weight={2} fillOpacity={0.9} />
            )}
          </MapContainer>
        </div>
        {pinLat != null ? (
          <p className="text-xs text-emerald-600 mb-3">✅ {pinLat.toFixed(4)}, {(pinLng as number).toFixed(4)}</p>
        ) : (
          <p className="text-xs text-amber-600 mb-3">⚠️ {t.storePinMissing}</p>
        )}
        <button
          type="button" disabled={!newStoreName.trim()}
          onClick={() => {
            onStoreSelected({ id: null, name: newStoreName.trim(), latitude: pinLat, longitude: pinLng, city, isNew: true });
            setShowNewForm(false);
            setQuery(newStoreName.trim());
          }}
          className="w-full rounded-xl bg-emerald-600 py-3 text-sm font-semibold text-white disabled:opacity-50"
        >
          ✅ {t.storeConfirm}
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <div className="relative">
        <input
          type="text"
          value={selectedStore && !showDropdown ? selectedStore.name : query}
          placeholder={t.storeSearchPlaceholder}
          className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-500"
          onChange={e => { setQuery(e.target.value); if (selectedStore) onStoreSelected(null); }}
          onFocus={() => setShowDropdown(true)}
        />
        {selectedStore && !showDropdown && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-base">{selectedStore.verified ? '✅' : '📍'}</span>
        )}
      </div>
      {showDropdown && (
        <>
          <div className="absolute left-0 right-0 top-full mt-1 z-20 max-h-72 overflow-y-auto rounded-xl border border-stone-200 bg-white shadow-xl">
            {searching && <div className="px-4 py-3 text-sm text-stone-400 text-center">{t.storeSearching}</div>}
            {!searching && results.filter(s => s.verified).length > 0 && (
              <>
                <div className="px-4 pt-2 pb-1 text-[10px] font-bold text-stone-400 uppercase tracking-wider">{t.storeVerifiedGroup}</div>
                {results.filter(s => s.verified).map(s => (
                  <button key={s.id} type="button" className="w-full text-left px-4 py-3 hover:bg-emerald-50 border-b border-stone-100 last:border-0"
                    onClick={() => { onStoreSelected(s); setShowDropdown(false); setQuery(''); }}>
                    <div className="font-medium text-stone-900 text-sm">{s.name}</div>
                    {(s.address || s.distance != null) && (
                      <div className="flex gap-2 mt-0.5 text-xs">
                        {s.address && <span className="text-stone-500 flex-1 truncate">{s.address}</span>}
                        {s.distance != null && <span className="text-emerald-600 shrink-0">📍 {fmtDist(s.distance)}</span>}
                      </div>
                    )}
                  </button>
                ))}
              </>
            )}
            {!searching && results.filter(s => !s.verified).length > 0 && (
              <>
                <div className="px-4 pt-2 pb-1 text-[10px] font-bold text-stone-400 uppercase tracking-wider">{t.storeOtherGroup}</div>
                {results.filter(s => !s.verified).map(s => (
                  <button key={s.id} type="button" className="w-full text-left px-4 py-3 hover:bg-stone-50 border-b border-stone-100 last:border-0"
                    onClick={() => { onStoreSelected(s); setShowDropdown(false); setQuery(''); }}>
                    <div className="font-medium text-stone-900 text-sm">{s.name}</div>
                    {(s.address || s.distance != null) && (
                      <div className="flex gap-2 mt-0.5 text-xs">
                        {s.address && <span className="text-stone-500 flex-1 truncate">{s.address}</span>}
                        {s.distance != null && <span className="text-emerald-600 shrink-0">📍 {fmtDist(s.distance)}</span>}
                      </div>
                    )}
                  </button>
                ))}
              </>
            )}
            {query.length >= 2 && (
              <button type="button" className="w-full text-left px-4 py-3 flex items-center gap-3 bg-emerald-50 hover:bg-emerald-100"
                onClick={() => { setNewStoreName(query); setShowNewForm(true); setShowDropdown(false); }}>
                <span className="text-lg">➕</span>
                <div>
                  <div className="text-sm font-medium text-emerald-700">"{query}" — {t.storeAddNew}</div>
                  <div className="text-xs text-stone-500">{t.storeAddNewHint}</div>
                </div>
              </button>
            )}
            {!searching && results.length === 0 && query.length < 2 && (
              <div className="px-4 py-3 text-sm text-stone-400 text-center">{t.storeTypeToSearch}</div>
            )}
          </div>
          <div className="fixed inset-0 z-10" onClick={() => setShowDropdown(false)} />
        </>
      )}
    </div>
  );
}

function ReportMapPicker({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onPick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

type ScrapeStoreKey = 'makro' | 'korzinka' | 'yandex_baraka';
const SCRAPE_STORES: ScrapeStoreKey[] = ['makro', 'korzinka', 'yandex_baraka'];
const PRODUCTS_CACHE_TTL_MS = 30000;

export default function App() {
  const SHOW_SHOPPING_PLAN_MENU = false;
  const [mode, setMode] = useState<'find' | 'report' | 'plan' | 'moderate'>('find');
  const [lang, setLang] = useState<'uz' | 'ru' | 'en'>('uz');
  const [searchQuery, setSearchQuery] = useState('');
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [prices, setPrices] = useState<PriceRecord[]>([]);
  const [moderationItems, setModerationItems] = useState<PendingModerationItem[]>([]);
  const [approvedItems, setApprovedItems] = useState<ApprovedModerationItem[]>([]);
  const [productAdminItems, setProductAdminItems] = useState<ProductAdminItem[]>([]);
  const [moderationSection, setModerationSection] = useState<'prices' | 'products' | 'links' | 'messages' | 'stores'>('prices');
  const [activeProductId, setActiveProductId] = useState<string | null>(null);
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [productTablePage, setProductTablePage] = useState(0);
  const [aliasImporting, setAliasImporting] = useState(false);
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
  const [productDetailLoadingId, setProductDetailLoadingId] = useState<string | null>(null);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [contactMessages, setContactMessages] = useState<ContactMessageItem[]>([]);
  const [linksLoading, setLinksLoading] = useState(false);
  const [receiptLinks, setReceiptLinks] = useState<ReceiptLinkItem[]>([]);
  const [selectedReceiptLinkIds, setSelectedReceiptLinkIds] = useState<string[]>([]);
  const [receiptLinkStatusFilter, setReceiptLinkStatusFilter] = useState<'all' | 'scanned' | 'failed' | 'unscanned'>('all');
  const [receiptLinkSearch, setReceiptLinkSearch] = useState('');
  const [selectedModerationIds, setSelectedModerationIds] = useState<string[]>([]);
  const [selectedApprovedIds, setSelectedApprovedIds] = useState<string[]>([]);
  const [scrapeLoadingStores, setScrapeLoadingStores] = useState<ScrapeStoreKey[]>([]);
  const [scrapeResult, setScrapeResult] = useState<string | null>(null);
  const [queueSyncing, setQueueSyncing] = useState(false);
  const [queueStatus, setQueueStatus] = useState<string | null>(null);
  const [flushingLimbo, setFlushingLimbo] = useState(false);
  const [matchingStats, setMatchingStats] = useState<Record<string, number> | null>(null);
  const [matchingStatsLoading, setMatchingStatsLoading] = useState(false);
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
  const [planLoading, setPlanLoading] = useState(false);
  const [planLocationInput, setPlanLocationInput] = useState('');
  const [planLocatingGps, setPlanLocatingGps] = useState(false);
  // Shopping list
  const [shoppingList, setShoppingList] = useState<Product[]>([]);
  const [planSearchQuery, setPlanSearchQuery] = useState('');
  const [planShowDropdown, setPlanShowDropdown] = useState(false);
  const [planStep, setPlanStep] = useState<'list' | 'results'>('list');
  const [planDistanceMode, setPlanDistanceMode] = useState<'near' | 'medium' | 'far'>('medium');
  const [planDistrictQuery, setPlanDistrictQuery] = useState('');
  const [planDistrictDropdown, setPlanDistrictDropdown] = useState(false);
  const [planLoadingMsgIdx, setPlanLoadingMsgIdx] = useState(0);
  const [expandedStoreIdx, setExpandedStoreIdx] = useState<number | null>(null);
  const [planResult, setPlanResult] = useState<{
    bestPlan: {
      stores: Array<{ name: string; address: string; latitude: number; longitude: number; distance: number }>;
      itemAssignments: Record<string, Array<{ item: Product; price: number; isCheapest?: boolean; dataAge?: number }>>;
      missingItems: Product[];
      totalItemCost: number;
      totalTravelPenalty: number;
      totalScore: number;
      storeCount: number;
      coveragePercent: number;
    };
    singleStorePlans: Array<{
      name: string; address: string; distance: number;
      latitude: number; longitude: number;
      totalCost: number; missingItems: string[];
      usedEstimate?: boolean;
      items: Record<string, number>;
    }>;
    savings: number;
    cheapestSingleStore: { name: string; totalCost: number } | null;
    hasSparseData: boolean;
    hasStaleData: boolean;
  } | null>(null);
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
        modePlan: 'Reja',
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
        invalidPrice: "Narx 0 dan katta bo'lishi kerak",
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
        moderationPlace: "Do'kon nomi",
        moderationAddress: 'Manzil',
        moderationLat: 'Kenglik (lat)',
        moderationLng: 'Uzunlik (lng)',
        moderationReceipt: "Chekni ko'rish",
        moderationScopeLabel: 'Qamrov',
        moderationScopeChain: 'Barcha filiallar',
        moderationScopeLocation: 'Faqat shu manzil',
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
        moderationApproveSelected: 'Tasdiqlash',
        moderationRejectSelected: 'Rad etish',
        moderationSelectAll: 'Barchasini tanlash',
        moderationClearSelection: 'Tanlovni tozalash',
        productsTab: 'Mahsulotlar',
        pricesTab: 'Narxlar',
        messagesTab: 'Xabarlar',
        linksTab: 'Havolalar',
        scrapeImport: 'Import qilish',
        scrapeMakro: 'Makro narxlari',
        scrapeKorzinka: 'Korzinka narxlari',
        scrapeYandexBaraka: 'Baraka (Yandex)',
        scrapeAll: 'Barcha API narxlari',
        scrapeAllRunning: 'Barcha APIlar yuklanmoqda...',
        scrapeLoading: 'Yuklanmoqda...',
        normalizeProducts: 'Mahsulotlarni normallashtirish',
        normalizeRunning: 'Normallashtirilmoqda...',
        normalizeStatusTitle: 'Normallashtirish logi',
        normalizeStatusEmpty: 'Hozircha log yo\'q',
        normalizeManualSqlTitle: 'exec_sql topilmadi. Quyidagi SQLni Supabase SQL Editor\'da ishga tushiring:',
        normalizeCompleted: (successCount: number, errorCount: number) => `Normallashtirish tugadi: ${successCount} SQL, ${errorCount} xato`,
        approvedThenNormalize: (approvedCount: number) => `✅ ${approvedCount} ta narx ma'lumotlar bazasiga qo'shildi`,
        queueDownload: 'Navbatni yuklab olish (JSON)',
        queueDownloadNonNormalized: 'Normallanmaganlarni yuklab olish',
        queueUpload: 'Normallashtirilgan faylni yuklash',
        queueUploading: 'Yuklanmoqda...',
        approvedToQueue: (approvedCount: number) => `✅ ${approvedCount} ta narx ma'lumotlar bazasiga qo'shildi`,
        queueImportDone: (importedCount: number, remainingCount: number) => `Import yakunlandi: ${importedCount} ta narx bazaga qo\'shildi, navbatda ${remainingCount} qoldi`,
        messagesTitle: 'Foydalanuvchi xabarlari',
        messagesEmpty: 'Xabarlar yo‘q',
        linksTitle: 'Chek havolalari navbati',
        linksEmpty: 'Havolalar topilmadi',
        linksFilterSearch: 'Havola yoki Telegram ID bo‘yicha qidirish',
        linksFilterStatus: 'Status filtri',
        linksStatusScanned: 'Scanned',
        linksStatusFailed: 'Failed',
        linksStatusUnscanned: 'Unscanned',
        linksSetScanned: 'Scanned qilib belgilash',
        linksSetFailed: 'Failed qilib belgilash',
        linksSetUnscanned: 'Pipeline ga qaytarish',
        linksDeleteSelected: 'Tanlangan havolalarni o‘chirish',
        linksUpdated: 'Havola statuslari yangilandi ✅',
        linksDeleted: 'Tanlangan havolalar o‘chirildi ✅',
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
        productDownload: 'Yuklab olish (JSON)',
        productUpload: 'Yuklash (JSON)',
        productUploading: 'Yuklanmoqda...',
        downloadUnmatched: 'Nomoslashtirilmaganlarni yuklab olish',
        uploadUnmatched: 'Yuklab olinganlarni yuklash',
        uploadNormSql: 'Normalizatsiya SQL yuklash',
        normSqlPlaceholder: 'INSERT INTO ... normalizatsiya SQL ni bu yerga joylashtiring',
        applyNormSql: 'SQL qollash',
        applyingNormSql: 'Qollanmoqda...',
        matchingStats: 'Moslashuv statistikasi',
        matchingStatsExact: 'Aniq (Level 1)',
        matchingStatsNormalised: 'Normallashtirilgan (Level 2-3)',
        matchingStatsFuzzyHigh: 'Yuqori fuzzy (Level 4-5)',
        matchingStatsFuzzyLow: 'Past fuzzy (tekshirish kerak)',
        matchingStatsConfirmed: 'Admin tasdiqlagan',
        matchingStatsUnmatched: 'Moslashmagan (normalizatsiya kerak)',
        matchingStatsLoad: 'Statistikani yuklash',
        productTableId: 'ID',
        productTableNameUz: 'Nomi (UZ)',
        productTableNameRu: 'Nomi (RU)',
        productTableNameEn: 'Nomi (EN)',
        productTableCategory: 'Kategoriya',
        productTableAliases: 'Taxalluslar',
        productTablePrices: 'Narxlar',
        productTablePage: 'Sahifa',
        productTableOf: '/',
        productTablePrev: '←',
        productTableNext: '→',
        productTableTotal: 'Jami',
        productTableShowing: 'ko\'rsatilmoqda',
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
        storeSelectLabel: 'Qayerdan?',
        storeSearchPlaceholder: 'Do\'kon yoki bozor nomi...',
        storeVerifiedGroup: '✅ Tasdiqlangan do\'konlar',
        storeOtherGroup: '📍 Boshqa joylar',
        storeAddNew: '— yangi joy sifatida qo\'shish',
        storeAddNewHint: 'Xaritada joylashuvini belgilaysiz',
        storeNewTitle: 'Yangi joy qo\'shish',
        storeNewName: 'Joy nomi',
        storeNewNamePlaceholder: 'Masalan: Chilonzor bozori',
        storePinHint: 'Xaritada belgilang (ixtiyoriy)',
        storePinMissing: 'Xaritaga bosib joyni belgilang',
        storeConfirm: 'Tasdiqlash',
        storeBack: 'Orqaga',
        storeSearching: 'Qidirilmoqda...',
        storeTypeToSearch: 'Nom yozing...',
        addItemBtn: '+ Mahsulot qo\'shish',
        itemsListLabel: 'Mahsulotlar va narxlar',
        submitAllBtn: 'Yuborish',
        storesTab: 'Do\'konlar',
        storeVerify: 'Tasdiqlash',
        storeMerge: 'Birlashtirish',
        storeDelete: 'O\'chirish',
        storeNoUnverified: 'Tasdiqlash kutayotgan do\'konlar yo\'q',
        storeMergeSearchPlaceholder: 'Qaysi do\'konga birlashtirish?',
        storeMergeConfirm: 'Birlashtirish',
        storeMergeCancel: 'Bekor qilish',
        storeTimesSubmitted: 'marta yuborilgan',
        tagline: 'Narxni bil, pulni teja',
        planTitle: '🛒 Xarid rejasi',
        planAddItem: 'Mahsulot qo\'shing',
        planAddPlaceholder: 'Qidirish: shakar, tuxum, sut...',
        planClearAll: 'Barchasini tozalash',
        planEmptyList: 'Xarid ro\'yxatingizga mahsulot qo\'shing',
        planEmptyArrow: '↑ Yuqoridagi qidiruvdan mahsulot tanlang',
        planItemCount: (n: number) => `${n} ta mahsulot`,
        planSetLocation: '📍 Joylashuvimni aniqlash',
        planOrDistrict: 'yoki tumanni kiriting',
        planDistNear: '🚶 Yaqin',
        planDistNearRange: '1-2 km',
        planDistNearHint: 'tez va qulay',
        planDistMedium: '🚌 O\'rtacha',
        planDistMediumRange: '2-5 km',
        planDistMediumHint: 'tavsiya etiladi',
        planDistFar: '🚗 Uzoqroq',
        planDistFarRange: '5-10 km',
        planDistFarHint: 'maksimal tejash',
        planCalculate: 'Eng yaxshi rejani hisoblash 🧮',
        planLoadingMsgs: [
          'Do\'konlar tekshirilmoqda...',
          'Narxlar solishtirilmoqda...',
          'Eng arzon yo\'l hisoblanmoqda...',
          'Deyarli tayyor...',
        ],
        planBestTitle: '🛒 Eng yaxshi reja',
        planStoreCount: (n: number) => `${n} ta do\'kon`,
        planTotal: '💰 Jami',
        planSavings: '✅ Tejash',
        planSavingsVs: 'yagona do\'konga nisbatan',
        planHourlyWage: (h: string) => `Bu ${h} soatlik ish haqiga teng`,
        planAnnualSave: (s: string) => `📅 Yiliga: ${s} so'm tejash`,
        planCheapestBadge: '↓ eng arzon',
        planDataAge: (d: number) => d === 0 ? 'Bugun' : `${d} kun oldin`,
        planDataStale: '⚠️',
        planMissing: 'Topilmadi',
        planMissingHint: '👉 Ushbu mahsulotlarni do\'konda narxini tekshiring',
        planMissingNearby: 'yaqin atrofda narx yo\'q',
        planSingleStoreTitle: '📊 Bir joydan olsangiz qancha to\'laysiz?',
        planSingleStoreHint: 'Barcha mahsulotlar bir do\'kondan olingan holda',
        planCheapestStore: '🟢 Eng arzon',
        planMoreExpensive: (s: string) => `Optimaldan ${s} so'm qimmat`,
        planEstimateUsed: (n: number) => `⚠️ ${n} ta mahsulot yo'q (taxminiy narx ishlatildi)`,
        planMapTitle: '🗺️ Marshrut',
        planOpenMap: '🗺️ Yandex Maps',
        planCopyPlan: '📋 Rejani nusxalash',
        planCopied: 'Nusxalandi ✅',
        planSingleStoreOnly: 'Yaqin atrofda faqat 1 ta do\'kon ma\'lumoti mavjud',
        planStaleWarning: '⚠️ Ba\'zi narxlar eskirgan bo\'lishi mumkin. Xarid paytida narxni tekshiring.',
        planSimilarPrices: 'Bu atrofda narxlar bir-biriga yaqin',
        planNoData: 'Tanlangan masofada narx ma\'lumoti topilmadi',
        planNoDataHint: 'Masofani oshirib ko\'ring 👆',
        planNeedLocation: 'Joylashuvni kiriting yoki GPS ruxsat bering',
        planRetryGps: 'GPS qayta so\'rash',
        planSumLabel: 'so\'m',
        planNewSearch: 'Yangi qidiruv',
        planDistanceAway: (km: string) => `📍 ${km} km uzoqlikda`,
        planDataInfo: (d: string) => `⏱ Ma'lumot: ${d}`,
        planStoreTotal: 'Jami',
        planMyLocation: 'Mening joylashuvim',
        planGpsButton: 'GPS orqali aniqlash',
        planGpsLocating: 'Aniqlanmoqda...',
        planGpsSet: '📍 Joylashuv aniqlandi',
        planLocationClear: 'Tozalash',
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
        modePlan: 'План',
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
        invalidPrice: 'Цена должна быть больше 0',
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
        moderationPlace: 'Название магазина',
        moderationAddress: 'Адрес',
        moderationLat: 'Широта (lat)',
        moderationLng: 'Долгота (lng)',
        moderationReceipt: 'Открыть чек',
        moderationScopeLabel: 'Охват',
        moderationScopeChain: 'Все филиалы',
        moderationScopeLocation: 'Только этот адрес',
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
        moderationApproveSelected: 'Одобрить',
        moderationRejectSelected: 'Отклонить',
        moderationSelectAll: 'Выбрать все',
        moderationClearSelection: 'Очистить выбор',
        productsTab: 'Товары',
        pricesTab: 'Цены',
        messagesTab: 'Сообщения',
        linksTab: 'Ссылки',
        scrapeImport: 'Импорт',
        scrapeMakro: 'Цены Makro',
        scrapeKorzinka: 'Цены Korzinka',
        scrapeYandexBaraka: 'Baraka (Yandex)',
        scrapeAll: 'Цены всех API',
        scrapeAllRunning: 'Загрузка всех API...',
        scrapeLoading: 'Загрузка...',
        normalizeProducts: 'Нормализовать товары',
        normalizeRunning: 'Нормализация...',
        normalizeStatusTitle: 'Лог нормализации',
        normalizeStatusEmpty: 'Пока нет логов',
        normalizeManualSqlTitle: 'exec_sql недоступен. Выполните SQL ниже в Supabase SQL Editor:',
        normalizeCompleted: (successCount: number, errorCount: number) => `Нормализация завершена: ${successCount} SQL, ошибок: ${errorCount}`,
        approvedThenNormalize: (approvedCount: number) => `✅ ${approvedCount} цен добавлено в базу данных`,
        queueDownload: 'Скачать очередь (JSON)',
        queueDownloadNonNormalized: 'Скачать ненормализованные',
        queueUpload: 'Загрузить нормализованный файл',
        queueUploading: 'Загрузка...',
        approvedToQueue: (approvedCount: number) => `✅ ${approvedCount} цен добавлено в базу данных`,
        queueImportDone: (importedCount: number, remainingCount: number) => `Импорт завершен: ${importedCount} цен добавлено в базу, в очереди осталось ${remainingCount}`,
        messagesTitle: 'Сообщения от пользователей',
        messagesEmpty: 'Сообщений пока нет',
        linksTitle: 'Очередь ссылок чеков',
        linksEmpty: 'Ссылки не найдены',
        linksFilterSearch: 'Поиск по ссылке или Telegram ID',
        linksFilterStatus: 'Фильтр статуса',
        linksStatusScanned: 'Scanned',
        linksStatusFailed: 'Failed',
        linksStatusUnscanned: 'Unscanned',
        linksSetScanned: 'Пометить как scanned',
        linksSetFailed: 'Пометить как failed',
        linksSetUnscanned: 'Вернуть в pipeline',
        linksDeleteSelected: 'Удалить выбранные ссылки',
        linksUpdated: 'Статусы ссылок обновлены ✅',
        linksDeleted: 'Выбранные ссылки удалены ✅',
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
        productDownload: 'Скачать (JSON)',
        productUpload: 'Загрузить (JSON)',
        productUploading: 'Загрузка...',
        downloadUnmatched: 'Скачать несопоставленные',
        uploadUnmatched: 'Загрузить несопоставленные',
        uploadNormSql: 'Загрузить SQL нормализации',
        normSqlPlaceholder: 'Вставьте SQL нормализации (INSERT INTO ...) сюда',
        applyNormSql: 'Применить SQL',
        applyingNormSql: 'Применяется...',
        matchingStats: 'Статистика соответствий',
        matchingStatsExact: 'Точные (Level 1)',
        matchingStatsNormalised: 'Нормализованные (Level 2-3)',
        matchingStatsFuzzyHigh: 'Высокий fuzzy (Level 4-5)',
        matchingStatsFuzzyLow: 'Низкий fuzzy (требует проверки)',
        matchingStatsConfirmed: 'Подтверждено администратором',
        matchingStatsUnmatched: 'Несопоставленные (нужна нормализация)',
        matchingStatsLoad: 'Загрузить статистику',
        productTableId: 'ID',
        productTableNameUz: 'Название (UZ)',
        productTableNameRu: 'Название (RU)',
        productTableNameEn: 'Название (EN)',
        productTableCategory: 'Категория',
        productTableAliases: 'Алиасы',
        productTablePrices: 'Цены',
        productTablePage: 'Стр.',
        productTableOf: '/',
        productTablePrev: '←',
        productTableNext: '→',
        productTableTotal: 'Всего',
        productTableShowing: 'показано',
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
        storeSelectLabel: 'Откуда?',
        storeSearchPlaceholder: 'Магазин или рынок...',
        storeVerifiedGroup: '✅ Проверенные магазины',
        storeOtherGroup: '📍 Другие места',
        storeAddNew: '— добавить как новое место',
        storeAddNewHint: 'Отметите на карте',
        storeNewTitle: 'Добавить новое место',
        storeNewName: 'Название',
        storeNewNamePlaceholder: 'Например: Чиланзарский рынок',
        storePinHint: 'Отметьте на карте (необязательно)',
        storePinMissing: 'Нажмите на карту чтобы отметить',
        storeConfirm: 'Подтвердить',
        storeBack: 'Назад',
        storeSearching: 'Поиск...',
        storeTypeToSearch: 'Начните вводить...',
        addItemBtn: '+ Добавить товар',
        itemsListLabel: 'Товары и цены',
        submitAllBtn: 'Отправить',
        storesTab: 'Магазины',
        storeVerify: 'Подтвердить',
        storeMerge: 'Объединить',
        storeDelete: 'Удалить',
        storeNoUnverified: 'Нет магазинов для проверки',
        storeMergeSearchPlaceholder: 'В какой магазин объединить?',
        storeMergeConfirm: 'Объединить',
        storeMergeCancel: 'Отмена',
        storeTimesSubmitted: 'раз отправлено',
        tagline: 'Знай цену, экономь деньги',
        planTitle: '🛒 План покупок',
        planAddItem: 'Добавьте товар',
        planAddPlaceholder: 'Поиск: сахар, яйца, молоко...',
        planClearAll: 'Очистить всё',
        planEmptyList: 'Добавьте товары в список покупок',
        planEmptyArrow: '↑ Выберите товар из поиска выше',
        planItemCount: (n: number) => `${n} товар(ов)`,
        planSetLocation: '📍 Определить местоположение',
        planOrDistrict: 'или введите район',
        planDistNear: '🚶 Рядом',
        planDistNearRange: '1-2 км',
        planDistNearHint: 'быстро и удобно',
        planDistMedium: '🚌 Средне',
        planDistMediumRange: '2-5 км',
        planDistMediumHint: 'рекомендуется',
        planDistFar: '🚗 Далеко',
        planDistFarRange: '5-10 км',
        planDistFarHint: 'максимальная экономия',
        planCalculate: 'Рассчитать лучший план 🧮',
        planLoadingMsgs: [
          'Проверяем магазины...',
          'Сравниваем цены...',
          'Считаем самый дешёвый путь...',
          'Почти готово...',
        ],
        planBestTitle: '🛒 Лучший план',
        planStoreCount: (n: number) => `${n} магазин(ов)`,
        planTotal: '💰 Итого',
        planSavings: '✅ Экономия',
        planSavingsVs: 'по сравнению с одним магазином',
        planHourlyWage: (h: string) => `Это ${h} час(ов) работы`,
        planAnnualSave: (s: string) => `📅 В год: ${s} сум экономии`,
        planCheapestBadge: '↓ дешевле всех',
        planDataAge: (d: number) => d === 0 ? 'Сегодня' : `${d} дн. назад`,
        planDataStale: '⚠️',
        planMissing: 'Не найдено',
        planMissingHint: '👉 Уточните цены в магазине',
        planMissingNearby: 'нет данных поблизости',
        planSingleStoreTitle: '📊 Сколько стоит купить всё в одном месте?',
        planSingleStoreHint: 'Все товары из одного магазина',
        planCheapestStore: '🟢 Самый дешёвый',
        planMoreExpensive: (s: string) => `На ${s} сум дороже оптимала`,
        planEstimateUsed: (n: number) => `⚠️ ${n} товар(ов) нет (оценочная цена)`,
        planMapTitle: '🗺️ Маршрут',
        planOpenMap: '🗺️ Yandex Maps',
        planCopyPlan: '📋 Скопировать план',
        planCopied: 'Скопировано ✅',
        planSingleStoreOnly: 'Поблизости данные только из 1 магазина',
        planStaleWarning: '⚠️ Некоторые цены могут быть устаревшими. Проверьте при покупке.',
        planSimilarPrices: 'Цены поблизости примерно одинаковы',
        planNoData: 'Нет данных о ценах в выбранном радиусе',
        planNoDataHint: 'Попробуйте увеличить расстояние 👆',
        planNeedLocation: 'Укажите местоположение или разрешите GPS',
        planRetryGps: 'Повторить GPS',
        planSumLabel: 'сум',
        planNewSearch: 'Новый поиск',
        planDistanceAway: (km: string) => `📍 ${km} км`,
        planDataInfo: (d: string) => `⏱ Данные: ${d}`,
        planStoreTotal: 'Итого',
        planMyLocation: 'Моё местоположение',
        planGpsButton: 'Определить по GPS',
        planGpsLocating: 'Определяем...',
        planGpsSet: '📍 Местоположение задано',
        planLocationClear: 'Сбросить',
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
        modePlan: 'Plan',
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
        invalidPrice: 'Price must be greater than 0',
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
        moderationPlace: 'Store name',
        moderationAddress: 'Address',
        moderationLat: 'Latitude',
        moderationLng: 'Longitude',
        moderationReceipt: 'View receipt',
        moderationScopeLabel: 'Price scope',
        moderationScopeChain: 'All branches',
        moderationScopeLocation: 'This location only',
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
        moderationApproveSelected: 'Approve',
        moderationRejectSelected: 'Reject',
        moderationSelectAll: 'Select all',
        moderationClearSelection: 'Clear selection',
        productsTab: 'Products',
        pricesTab: 'Prices',
        messagesTab: 'Messages',
        linksTab: 'Links',
        scrapeImport: 'Import',
        scrapeMakro: 'Makro prices',
        scrapeKorzinka: 'Korzinka prices',
        scrapeYandexBaraka: 'Baraka (Yandex)',
        scrapeAll: 'Fetch all APIs',
        scrapeAllRunning: 'Fetching all APIs...',
        scrapeLoading: 'Loading...',
        normalizeProducts: 'Normalize products',
        normalizeRunning: 'Normalizing...',
        normalizeStatusTitle: 'Normalization log',
        normalizeStatusEmpty: 'No logs yet',
        normalizeManualSqlTitle: 'exec_sql is unavailable. Run the SQL below in Supabase SQL Editor:',
        normalizeCompleted: (successCount: number, errorCount: number) => `Normalization finished: ${successCount} SQL, errors: ${errorCount}`,
        approvedThenNormalize: (approvedCount: number) => `✅ ${approvedCount} prices added to database`,
        queueDownload: 'Download queue (JSON)',
        queueDownloadNonNormalized: 'Download non-normalized',
        queueUpload: 'Upload normalized file',
        queueUploading: 'Uploading...',
        approvedToQueue: (approvedCount: number) => `✅ ${approvedCount} prices added to database`,
        queueImportDone: (importedCount: number, remainingCount: number) => `Import complete: ${importedCount} prices added to database, ${remainingCount} still in queue`,
        messagesTitle: 'User messages',
        messagesEmpty: 'No messages yet',
        linksTitle: 'Receipt links queue',
        linksEmpty: 'No links found',
        linksFilterSearch: 'Search by URL or Telegram ID',
        linksFilterStatus: 'Status filter',
        linksStatusScanned: 'Scanned',
        linksStatusFailed: 'Failed',
        linksStatusUnscanned: 'Unscanned',
        linksSetScanned: 'Set scanned',
        linksSetFailed: 'Set failed',
        linksSetUnscanned: 'Requeue to pipeline',
        linksDeleteSelected: 'Delete selected links',
        linksUpdated: 'Link statuses updated ✅',
        linksDeleted: 'Selected links deleted ✅',
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
        productDownload: 'Download (JSON)',
        productUpload: 'Upload (JSON)',
        productUploading: 'Uploading...',
        downloadUnmatched: 'Download Unmatched',
        uploadUnmatched: 'Upload Unmatched',
        uploadNormSql: 'Upload Normalisation SQL',
        normSqlPlaceholder: 'Paste normalisation SQL (INSERT INTO ...) here',
        applyNormSql: 'Apply SQL',
        applyingNormSql: 'Applying...',
        matchingStats: 'Matching Stats',
        matchingStatsExact: 'Exact (Level 1)',
        matchingStatsNormalised: 'Normalised (Level 2-3)',
        matchingStatsFuzzyHigh: 'Fuzzy high (Level 4-5)',
        matchingStatsFuzzyLow: 'Fuzzy low (needs review)',
        matchingStatsConfirmed: 'Admin confirmed',
        matchingStatsUnmatched: 'Unmatched (needs normalisation)',
        matchingStatsLoad: 'Load Stats',
        productTableId: 'ID',
        productTableNameUz: 'Name (UZ)',
        productTableNameRu: 'Name (RU)',
        productTableNameEn: 'Name (EN)',
        productTableCategory: 'Category',
        productTableAliases: 'Aliases',
        productTablePrices: 'Prices',
        productTablePage: 'Page',
        productTableOf: '/',
        productTablePrev: '←',
        productTableNext: '→',
        productTableTotal: 'Total',
        productTableShowing: 'showing',
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
        storeSelectLabel: 'Where from?',
        storeSearchPlaceholder: 'Store or market...',
        storeVerifiedGroup: '✅ Verified stores',
        storeOtherGroup: '📍 Other places',
        storeAddNew: '— add as new place',
        storeAddNewHint: 'You\'ll pin it on the map',
        storeNewTitle: 'Add new place',
        storeNewName: 'Place name',
        storeNewNamePlaceholder: 'Example: Chilanzar market',
        storePinHint: 'Pin on map (optional)',
        storePinMissing: 'Tap map to set location',
        storeConfirm: 'Confirm',
        storeBack: 'Back',
        storeSearching: 'Searching...',
        storeTypeToSearch: 'Start typing...',
        addItemBtn: '+ Add item',
        itemsListLabel: 'Items and prices',
        submitAllBtn: 'Submit',
        storesTab: 'Stores',
        storeVerify: 'Verify',
        storeMerge: 'Merge',
        storeDelete: 'Delete',
        storeNoUnverified: 'No stores pending verification',
        storeMergeSearchPlaceholder: 'Merge into which store?',
        storeMergeConfirm: 'Merge',
        storeMergeCancel: 'Cancel',
        storeTimesSubmitted: 'times submitted',
        tagline: 'Know the price, save the money',
        planTitle: '🛒 Shopping plan',
        planAddItem: 'Add a product',
        planAddPlaceholder: 'Search: sugar, eggs, milk...',
        planClearAll: 'Clear all',
        planEmptyList: 'Add products to your shopping list',
        planEmptyArrow: '↑ Select a product from search above',
        planItemCount: (n: number) => `${n} item(s)`,
        planSetLocation: '📍 Detect my location',
        planOrDistrict: 'or enter a district',
        planDistNear: '🚶 Near',
        planDistNearRange: '1-2 km',
        planDistNearHint: 'quick and easy',
        planDistMedium: '🚌 Medium',
        planDistMediumRange: '2-5 km',
        planDistMediumHint: 'recommended',
        planDistFar: '🚗 Far',
        planDistFarRange: '5-10 km',
        planDistFarHint: 'maximum savings',
        planCalculate: 'Calculate best plan 🧮',
        planLoadingMsgs: [
          'Checking stores...',
          'Comparing prices...',
          'Calculating cheapest route...',
          'Almost ready...',
        ],
        planBestTitle: '🛒 Best plan',
        planStoreCount: (n: number) => `${n} store(s)`,
        planTotal: '💰 Total',
        planSavings: '✅ Savings',
        planSavingsVs: 'vs. buying from one store',
        planHourlyWage: (h: string) => `Equivalent to ${h} hour(s) of work`,
        planAnnualSave: (s: string) => `📅 Annual: ${s} sum saved`,
        planCheapestBadge: '↓ cheapest',
        planDataAge: (d: number) => d === 0 ? 'Today' : `${d} day(s) ago`,
        planDataStale: '⚠️',
        planMissing: 'Not found',
        planMissingHint: '👉 Check prices at the store',
        planMissingNearby: 'no price data nearby',
        planSingleStoreTitle: '📊 How much at a single store?',
        planSingleStoreHint: 'If you buy everything from one place',
        planCheapestStore: '🟢 Cheapest',
        planMoreExpensive: (s: string) => `${s} sum more expensive than optimal`,
        planEstimateUsed: (n: number) => `⚠️ ${n} item(s) missing (estimated price used)`,
        planMapTitle: '🗺️ Route',
        planOpenMap: '🗺️ Yandex Maps',
        planCopyPlan: '📋 Copy plan',
        planCopied: 'Copied ✅',
        planSingleStoreOnly: 'Only 1 store has data nearby',
        planStaleWarning: '⚠️ Some prices may be outdated. Verify when shopping.',
        planSimilarPrices: 'Prices nearby are similar',
        planNoData: 'No price data within selected range',
        planNoDataHint: 'Try increasing the distance 👆',
        planNeedLocation: 'Set your location or allow GPS',
        planRetryGps: 'Retry GPS',
        planSumLabel: 'sum',
        planNewSearch: 'New search',
        planDistanceAway: (km: string) => `📍 ${km} km away`,
        planDataInfo: (d: string) => `⏱ Data: ${d}`,
        planStoreTotal: 'Total',
        planMyLocation: 'My location',
        planGpsButton: 'Use GPS',
        planGpsLocating: 'Locating...',
        planGpsSet: '📍 Location set',
        planLocationClear: 'Clear',
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
  const [selectedStore, setSelectedStore] = useState<StoreRecord | null>(null);
  const [reportItems, setReportItems] = useState<ReportItem[]>([{ id: crypto.randomUUID(), product: null, productQuery: '', price: '', showDropdown: false }]);
  const [adminStores, setAdminStores] = useState<StoreRecord[]>([]);
  const [adminStoresLoading, setAdminStoresLoading] = useState(false);
  const [storeMergeSourceId, setStoreMergeSourceId] = useState<string | null>(null);
  const [storeMergeQuery, setStoreMergeQuery] = useState('');
  const [storeMergeResults, setStoreMergeResults] = useState<StoreRecord[]>([]);
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
  const findSearchInputRef = useRef<HTMLInputElement | null>(null);
  const findMapSectionRef = useRef<HTMLElement | null>(null);
  const productsCacheRef = useRef<{ timestamp: number; data: Product[] } | null>(null);
  const productsFetchPromiseRef = useRef<Promise<Product[]> | null>(null);
  const [productsLoading, setProductsLoading] = useState(false);
  const [knownStores, setKnownStores] = useState<Array<{ name: string; lat: number; lng: number }>>(KNOWN_STORES_FALLBACK);


  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const initialMode = params.get('mode') as 'find' | 'report' | 'plan' | 'moderate';
    const initialLang = params.get('lang') as 'uz' | 'ru' | 'en';
    const initialCity = params.get('city');
    const isAllowedMode = initialMode
      && (initialMode !== 'moderate' || isAdminUser)
      && (SHOW_SHOPPING_PLAN_MENU || initialMode !== 'plan');
    if (isAllowedMode) setMode(initialMode);
    if (initialLang) setLang(initialLang);
    if (initialCity) {
      const normalizedCity = CITY_OPTIONS.find(city => city.value === initialCity)?.value;
      if (normalizedCity) setSelectedCity(normalizedCity);
    }

    fetchProducts({ force: true });
    // Pre-fetch known store locations for coordinate-based store identification
    fetchKnownStores().then(stores => setKnownStores(stores)).catch(() => {});
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

  const fetchProducts = async (options: { force?: boolean } = {}) => {
    const force = Boolean(options.force);
    const now = Date.now();

    if (!force && productsCacheRef.current && (now - productsCacheRef.current.timestamp) < PRODUCTS_CACHE_TTL_MS) {
      setProducts(productsCacheRef.current.data);
      return productsCacheRef.current.data;
    }

    if (productsFetchPromiseRef.current) {
      return productsFetchPromiseRef.current;
    }

    const FIRST_PAGE = 200;

    const buildEnriched = (data: Product[], aliases: { product_id: string; alias_text: string }[]) => {
      const aliasMap: Record<string, string[]> = {};
      for (const a of aliases || []) {
        if (!aliasMap[a.product_id]) aliasMap[a.product_id] = [];
        aliasMap[a.product_id].push(a.alias_text);
      }
      return data.map(p => ({
        ...p,
        search_text: [p.search_text || '', ...(aliasMap[p.id] || [])].join(' '),
      })) as Product[];
    };

    const requestPromise = (async () => {
      setProductsLoading(true);
      // --- First page: show immediately ---
      const [firstPage, aliasesRes] = await Promise.all([
        supabase.from('products').select('*').order('name_uz').range(0, FIRST_PAGE - 1),
        supabase.from('product_aliases').select('product_id, alias_text'),
      ]);

      const aliases = aliasesRes.data || [];
      if (firstPage.data && firstPage.data.length > 0) {
        setProducts(buildEnriched(firstPage.data, aliases));
      }

      // --- Rest in background ---
      let allData = firstPage.data || [];
      if ((firstPage.data?.length ?? 0) === FIRST_PAGE) {
        let offset = FIRST_PAGE;
        while (true) {
          const { data: page } = await supabase
            .from('products')
            .select('*')
            .order('name_uz')
            .range(offset, offset + FIRST_PAGE - 1);
          if (!page || page.length === 0) break;
          allData = [...allData, ...page];
          setProducts(buildEnriched(allData, aliases));
          if (page.length < FIRST_PAGE) break;
          offset += FIRST_PAGE;
        }
      }

      const enriched = buildEnriched(allData, aliases);
      productsCacheRef.current = { timestamp: Date.now(), data: enriched };
      setProducts(enriched);
      setProductsLoading(false);
      return enriched;
    })().finally(() => {
      productsFetchPromiseRef.current = null;
    });

    productsFetchPromiseRef.current = requestPromise;
    return requestPromise;
  };

  const loadPricesForProduct = async (productId: string) => {
    setLoading(true);
    const [pricesResult, aliasesResult] = await Promise.all([
      supabase
        .from('prices')
        .select('*')
        .eq('product_id', productId)
        .eq('city', selectedCity)
        .not('source', 'like', 'history_%')
        .order('price', { ascending: true })
        .limit(200),
      supabase
        .from('product_aliases')
        .select('alias_text')
        .eq('product_id', productId),
    ]);

    const product = products.find(item => item.id === productId) || null;
    const knownNameKeys = new Set([
      normalizeProductNameKey(product?.name_uz),
      normalizeProductNameKey(product?.name_ru),
      normalizeProductNameKey(product?.name_en || ''),
      ...((aliasesResult.data || []).map(alias => normalizeProductNameKey(alias.alias_text))),
    ].filter(Boolean));

    const filtered = (pricesResult.data || []).filter(row => {
      const rawName = normalizeProductNameKey(row?.product_name_raw || '');
      return knownNameKeys.has(rawName);
    });

    setPrices(filtered as PriceRecord[]);
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
    details_loaded: Boolean(item.details_loaded),
  });

  const normalizeReceiptLinkItem = (item: any): ReceiptLinkItem => {
    const normalizedStatus = String(item?.pipeline_status || '').trim().toLowerCase();
    const pipelineStatus = normalizedStatus === 'scanned'
      ? 'scanned'
      : (normalizedStatus === 'failed' ? 'failed' : 'unscanned');

    return {
      ...item,
      receipt_url: String(item?.receipt_url || '').trim(),
      pipeline_status: pipelineStatus,
    };
  };

  const callModerationApi = async (action: string, payload: Record<string, unknown> = {}) => {
    const response = await fetch('/api/moderation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, initData: telegramInitData, ...payload }),
    });

    const rawText = await response.text();
    let json: any = null;
    try {
      json = rawText ? JSON.parse(rawText) : null;
    } catch {
      throw new Error(`Moderation API non-JSON response (${response.status}): ${String(rawText || '').slice(0, 220)}`);
    }

    if (!json || !response.ok || !json.ok) {
      throw new Error((json && json.error) || 'Moderation request failed');
    }

    return json;
  };

  const downloadNormalizationQueueJson = async () => {
    if (!isAdminUser || queueSyncing) return;
    setQueueSyncing(true);
    setQueueStatus(null);
    try {
      const result = await callModerationApi('downloadNormalizationQueue');
      const payload = { products: Array.isArray(result?.products) ? result.products : [] };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `narxi-normalization-queue-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);

      const queueItems = Number(result?.limboItemCount) || 0;
      const groupedProducts = Number(result?.groupedProductCount) || 0;
      const normalizedInDbCount = Number(result?.normalizedInDbCount) || 0;
      const nonNormalizedCount = Number(result?.nonNormalizedCount) || 0;
      const exportedProductCount = Number(result?.exportedProductCount) || groupedProducts;
      setQueueStatus(`${queueItems} queue items checked · exported ${exportedProductCount}/${groupedProducts} groups (${nonNormalizedCount} non-normalized, ${normalizedInDbCount} already normalized)`);
    } catch {
      window.Telegram?.WebApp?.showAlert(t.moderationError);
    } finally {
      setQueueSyncing(false);
    }
  };

  const downloadNonNormalizedQueueJson = async () => {
    if (!isAdminUser || queueSyncing) return;
    setQueueSyncing(true);
    setQueueStatus(null);
    try {
      const result = await callModerationApi('downloadNormalizationQueue', { onlyNonNormalized: true });
      const payload = { products: Array.isArray(result?.products) ? result.products : [] };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `narxi-normalization-non-normalized-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);

      const groupedProducts = Number(result?.groupedProductCount) || 0;
      const exportedProductCount = Number(result?.exportedProductCount) || 0;
      setQueueStatus(`Non-normalized export: ${exportedProductCount} of ${groupedProducts} groups`);
    } catch {
      window.Telegram?.WebApp?.showAlert(t.moderationError);
    } finally {
      setQueueSyncing(false);
    }
  };

  const uploadNormalizationQueueJson = async (file: File) => {
    if (!isAdminUser || queueSyncing) return;
    setQueueSyncing(true);
    setQueueStatus(null);

    try {
      const text = await file.text();
      const payload = JSON.parse(text || '{}');
      const products = Array.isArray(payload)
        ? payload
        : (Array.isArray(payload?.products) ? payload.products : []);

      if (products.length === 0) {
        window.Telegram?.WebApp?.showAlert('Invalid format: expected JSON with products array');
        return;
      }

      const result = await callModerationApi('importNormalizationQueue', { products });
      await fetchModerationItems();
      await fetchProducts({ force: true });
      if (moderationSection === 'products') await fetchModerationProducts();

      const importedCount = Number(result?.importedCount) || 0;
      const remainingCount = Number(result?.remainingLimboCount) || 0;
      const unmatchedCount = Number(result?.unmatchedCount) || 0;
      const failedCount = Number(result?.failedCount) || 0;
      const ambiguousAliasCount = Number(result?.ambiguousAliasCount) || 0;
      const storeProductsLinked = Number(result?.storeProductsLinked) || 0;
      const pricesBackfilled = Number(result?.pricesBackfilled) || 0;

      const summary = t.queueImportDone(importedCount, remainingCount);
      setQueueStatus(summary);

      const details: string[] = [];
      if (storeProductsLinked > 0) details.push(`Store products linked: ${storeProductsLinked} (${pricesBackfilled} prices backfilled)`);
      if (unmatchedCount > 0) details.push(`Unmatched: ${unmatchedCount}`);
      if (failedCount > 0) details.push(`Failed: ${failedCount}`);
      if (ambiguousAliasCount > 0) details.push(`Ambiguous aliases: ${ambiguousAliasCount}`);

      window.Telegram?.WebApp?.showAlert(details.length > 0 ? `${summary}\n${details.join(' · ')}` : summary);
    } catch (error: any) {
      window.Telegram?.WebApp?.showAlert(`Import error: ${error?.message || 'unknown'}`);
    } finally {
      setQueueSyncing(false);
    }
  };

  const formatScrapeSummary = (store: ScrapeStoreKey, data: any) => {
    const parts = [`${store}: +${Number(data?.inserted) || 0}`, `${Number(data?.matched) || 0} matched`, `${Number(data?.total) || 0} total`];
    if (Number(data?.unmatched) > 0) parts.push(`${Number(data.unmatched)} unmatched`);
    if (Number(data?.autoCreatedProducts) > 0) parts.push(`${Number(data.autoCreatedProducts)} auto-created`);
    if (Number(data?.skippedDup) > 0) parts.push(`${Number(data.skippedDup)} unchanged`);
    if (Number(data?.archived) > 0) parts.push(`${Number(data.archived)} archived`);
    if (Array.isArray(data?.errors) && data.errors.length > 0) parts.push(`${data.errors.length} errors`);
    if (Number(data?.durationMs) > 0) parts.push(`${Math.round(Number(data.durationMs) / 1000)}s`);
    return parts.join(' · ');
  };

  const runScrapeStoreRequest = async (store: ScrapeStoreKey) => {
    const res = await fetch('/api/scrape-stores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ admin_id: telegramUserId, store }),
    });
    const data = await res.json();
    if (!res.ok || !data?.ok) {
      throw new Error(String(data?.error || `Request failed for ${store}`));
    }
    return data;
  };

  const handleScrapeStore = async (store: ScrapeStoreKey) => {
    if (!isAdminUser || scrapeLoadingStores.length > 0) return;
    setScrapeLoadingStores([store]);
    setScrapeResult(null);
    try {
      const data = await runScrapeStoreRequest(store);
      setScrapeResult(formatScrapeSummary(store, data));
      await fetchModerationItems();
    } catch (err: any) {
      setScrapeResult(`${store}: Error: ${err?.message || 'Network error'}`);
    } finally {
      setScrapeLoadingStores([]);
    }
  };

  const handleScrapeAllStores = async () => {
    if (!isAdminUser || scrapeLoadingStores.length > 0) return;
    setScrapeLoadingStores([SCRAPE_STORES[0]]);
    setScrapeResult(null);

    try {
      const settled: Array<
        { store: ScrapeStoreKey; ok: true; data: any }
        | { store: ScrapeStoreKey; ok: false; error: string }
      > = [];

      for (const store of SCRAPE_STORES) {
        setScrapeLoadingStores([store]);
        try {
          const data = await runScrapeStoreRequest(store);
          settled.push({ store, ok: true, data });
        } catch (error: any) {
          settled.push({ store, ok: false, error: error?.message || 'unknown' });
        }
      }

      const summaryParts: string[] = [];
      let okCount = 0;

      for (const result of settled) {
        if (result.ok === true) {
          okCount += 1;
          summaryParts.push(formatScrapeSummary(result.store, result.data));
        } else {
          summaryParts.push(`${result.store}: Error: ${result.error}`);
        }
      }

      setScrapeResult(summaryParts.join(' || '));
      if (okCount > 0) {
        await fetchModerationItems();
      }
    } catch (err: any) {
      setScrapeResult(`Error: ${err?.message || 'Network error'}`);
    } finally {
      setScrapeLoadingStores([]);
    }
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
    setProductDetailLoadingId(null);
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

  const fetchProductLinkedData = async (productId: string) => {
    const normalizedProductId = String(productId || '').trim();
    if (!normalizedProductId || !isAdminUser || !telegramInitData) return;

    setProductDetailLoadingId(normalizedProductId);
    try {
      const result = await callModerationApi('getProductLinkedData', { id: normalizedProductId });
      const prices = Array.isArray(result?.prices) ? result.prices : [];
      const pending = Array.isArray(result?.pending) ? result.pending : [];

      setProductAdminItems(items => items.map(item => (
        item.id === normalizedProductId
          ? {
              ...item,
              prices,
              pending,
              price_count: Number(result?.price_count) || prices.length,
              pending_count: Number(result?.pending_count) || pending.length,
              latest_price: result?.latest_price || prices[0] || null,
              details_loaded: true,
            }
          : item
      )));
    } catch {
      window.Telegram?.WebApp?.showAlert(t.moderationError);
    } finally {
      setProductDetailLoadingId(prev => (prev === normalizedProductId ? null : prev));
    }
  };

  const downloadProductsJson = async (idsFilter?: string[]) => {
    const useSelection = Array.isArray(idsFilter) && idsFilter.length > 0;
    try {
      let prodsQuery = supabase.from('products').select('id, name_uz, name_ru, name_en, search_text, category, unit, available_cities').order('name_uz');
      if (useSelection) prodsQuery = prodsQuery.in('id', idsFilter);

      const [{ data: prods }, { data: aliases }] = await Promise.all([
        prodsQuery,
        supabase.from('product_aliases').select('product_id, alias_text, language, store_name'),
      ]);
      const aliasMap: Record<string, Array<{ alias_text: string; language: string; store_name: string | null }>> = {};
      for (const a of aliases || []) {
        if (!aliasMap[a.product_id]) aliasMap[a.product_id] = [];
        aliasMap[a.product_id].push({ alias_text: a.alias_text, language: a.language, store_name: a.store_name });
      }
      const dbProducts = (prods || []).map(p => ({
        product_id: p.id,
        canonical: { name_uz: p.name_uz, name_ru: p.name_ru, name_en: p.name_en },
        category: p.category,
        unit: p.unit,
        names: aliasMap[p.id] || [],
      }));

      let queueProducts: any[] = [];
      if (isAdminUser && !useSelection) {
        try {
          const queueResult = await callModerationApi('downloadNormalizationQueue');
          queueProducts = Array.isArray(queueResult?.products) ? queueResult.products : [];
          if (queueProducts.length > 0) {
            setQueueStatus(`${queueProducts.length} queued product groups were appended to export`);
          }
        } catch {
          queueProducts = [];
        }
      }

      const payload = [...dbProducts, ...queueProducts];
      const suffix = useSelection ? `-selected${idsFilter.length}` : '';
      const blob = new Blob([JSON.stringify({ products: payload }, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `narxi-products${suffix}-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      window.Telegram?.WebApp?.showAlert(t.moderationError);
    }
  };

  const downloadUnmatched = async () => {
    try {
      const { data: unmatched } = await supabase
        .from('store_products')
        .select('id, original_name, normalised_name, source, store_name, times_seen, first_seen')
        .is('canonical_product_id', null)
        .order('times_seen', { ascending: false });

      const grouped: Record<string, typeof unmatched> = {};
      for (const item of unmatched || []) {
        if (!grouped[item.source]) grouped[item.source] = [];
        grouped[item.source]!.push(item);
      }

      const blob = new Blob([JSON.stringify({ unmatched: grouped }, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `narxi-unmatched-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      window.Telegram?.WebApp?.showAlert(t.moderationError);
    }
  };

  const uploadStoreProductsBatch = async (file: File) => {
    try {
      const text = await file.text();
      const payload = JSON.parse(text || '{}');
      // Accept both { products: [...] } and flat array formats.
      const products = Array.isArray(payload)
        ? payload
        : (Array.isArray(payload?.products) ? payload.products : []);
      if (products.length === 0) {
        window.Telegram?.WebApp?.showAlert('No products found in file');
        return;
      }
      const result = await callModerationApi('importStoreProductsBatch', { products });
      await fetchModerationProducts();
      const msg = `Created: ${result.created || 0} · Linked: ${result.linked || 0} · Prices backfilled: ${result.pricesBackfilled || 0}` +
        (result.errors?.length ? `\n${result.errors.length} errors` : '');
      window.Telegram?.WebApp?.showAlert(msg);
    } catch (err: any) {
      window.Telegram?.WebApp?.showAlert(`Error: ${err?.message || 'unknown'}`);
    }
  };

  const flushLimboToDatabase = async () => {
    setFlushingLimbo(true);
    try {
      const result = await callModerationApi('flushLimboToDatabase');
      await fetchModerationItems();
      window.Telegram?.WebApp?.showAlert(
        `✅ Flushed ${result.flushed || 0} / ${result.total || 0} to database` +
        (result.errors?.length ? `\n${result.errors.length} errors` : '')
      );
    } catch (err: any) {
      window.Telegram?.WebApp?.showAlert(`Error: ${err?.message || 'Unknown'}`);
    } finally {
      setFlushingLimbo(false);
    }
  };

  const fetchMatchingStats = async () => {
    setMatchingStatsLoading(true);
    try {
      const result = await callModerationApi('getMatchingStats');
      setMatchingStats(result.stats || {});
    } catch {
      setMatchingStats(null);
    } finally {
      setMatchingStatsLoading(false);
    }
  };

  const uploadAliasesJson = async (file: File) => {
    setAliasImporting(true);
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      const products = payload.aliases || payload.products || payload;
      if (!Array.isArray(products)) {
        window.Telegram?.WebApp?.showAlert('Invalid format: expected an array');
        return;
      }

      const response = await fetch('/api/import-aliases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          admin_id: telegramUserId,
          products,
          deleted_product_ids: payload.deleted_product_ids,
        }),
      });

      const result = await response.json();
      if (!response.ok || !result.ok) {
        const errMsg = result.error || 'Import failed';
        const details = result.errors?.length ? `\n${result.errors.map((e: { error: string }) => e.error).join(', ')}` : '';
        window.Telegram?.WebApp?.showAlert(`${errMsg}${details}`);
        return;
      }

      let queueImported = 0;
      let queueRemaining = 0;
      let queueAmbiguousAliases = 0;
      try {
        const queueResult = await callModerationApi('importNormalizationQueue', { products });
        queueImported = Number(queueResult?.importedCount) || 0;
        queueRemaining = Number(queueResult?.remainingLimboCount) || 0;
        queueAmbiguousAliases = Number(queueResult?.ambiguousAliasCount) || 0;
        setQueueStatus(t.queueImportDone(queueImported, queueRemaining));
      } catch {
        // Keep product import successful even if queue import fails.
      }

      window.Telegram?.WebApp?.showAlert(
        `Done: ${result.canonical_updated || 0} updated, ${result.aliases_inserted || 0} aliases, ${result.products_deleted || 0} deleted${result.errors?.length ? ` (${result.errors.length} errors)` : ''}${queueImported > 0 || queueRemaining > 0 || queueAmbiguousAliases > 0 ? `\nQueue import: ${queueImported} added, ${queueRemaining} still queued${queueAmbiguousAliases > 0 ? `, ambiguous aliases: ${queueAmbiguousAliases}` : ''}` : ''}`
      );
      await fetchProducts({ force: true });
      await fetchModerationItems();
      if (moderationSection === 'products') await fetchModerationProducts();
    } catch (e) {
      window.Telegram?.WebApp?.showAlert(`Import error: ${e instanceof Error ? e.message : 'unknown'}`);
    } finally {
      setAliasImporting(false);
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

  const fetchAdminStores = async () => {
    if (!isAdminUser || !telegramInitData) return;
    setAdminStoresLoading(true);
    try {
      const result = await callModerationApi('listUnverifiedStores');
      setAdminStores((result.items || []) as StoreRecord[]);
    } catch {
      window.Telegram?.WebApp?.showAlert(t.moderationError);
    } finally {
      setAdminStoresLoading(false);
    }
  };

  const handleVerifyStore = async (id: string) => {
    await callModerationApi('verifyStore', { id });
    setAdminStores(prev => prev.filter(s => s.id !== id));
  };

  const handleDeleteStore = async (id: string) => {
    if (!window.Telegram?.WebApp?.showConfirm) {
      await callModerationApi('deleteStore', { id });
      setAdminStores(prev => prev.filter(s => s.id !== id));
      return;
    }
    window.Telegram.WebApp.showConfirm('Delete this store?', async (ok: boolean) => {
      if (!ok) return;
      await callModerationApi('deleteStore', { id });
      setAdminStores(prev => prev.filter(s => s.id !== id));
    });
  };

  const searchMergeTargets = async (query: string) => {
    setStoreMergeQuery(query);
    if (query.length < 2) { setStoreMergeResults([]); return; }
    const result = await callModerationApi('searchStoresAdmin', { query });
    setStoreMergeResults((result.items || []) as StoreRecord[]);
  };

  const handleMergeStore = async (sourceId: string, targetId: string) => {
    await callModerationApi('mergeStores', { sourceId, targetId });
    setAdminStores(prev => prev.filter(s => s.id !== sourceId));
    setStoreMergeSourceId(null);
    setStoreMergeQuery('');
    setStoreMergeResults([]);
  };

  const fetchReceiptLinks = async () => {
    if (!isAdminUser || !telegramInitData) return;
    setLinksLoading(true);
    try {
      const result = await callModerationApi('listReceiptLinks');
      const normalized = (result.items || []).map(normalizeReceiptLinkItem);
      setReceiptLinks(normalized);
      setSelectedReceiptLinkIds(prev => prev.filter(id => normalized.some(item => item.id === id)));
    } catch {
      window.Telegram?.WebApp?.showAlert(t.moderationError);
    } finally {
      setLinksLoading(false);
    }
  };

  const filteredReceiptLinks = useMemo(() => {
    const query = receiptLinkSearch.trim().toLowerCase();
    return receiptLinks.filter(item => {
      const byStatus = receiptLinkStatusFilter === 'all' || item.pipeline_status === receiptLinkStatusFilter;
      const byQuery = !query
        || String(item.receipt_url || '').toLowerCase().includes(query)
        || String(item.telegram_id || '').toLowerCase().includes(query)
        || String(item.city || '').toLowerCase().includes(query);
      return byStatus && byQuery;
    });
  }, [receiptLinks, receiptLinkSearch, receiptLinkStatusFilter]);

  const toggleReceiptLinkSelection = (id: string) => {
    setSelectedReceiptLinkIds(prev => (prev.includes(id) ? prev.filter(itemId => itemId !== id) : [...prev, id]));
  };

  const selectAllFilteredReceiptLinks = () => {
    setSelectedReceiptLinkIds(filteredReceiptLinks.map(item => item.id));
  };

  const clearReceiptLinkSelection = () => {
    setSelectedReceiptLinkIds([]);
  };

  const updateSelectedReceiptLinksStatus = async (status: 'scanned' | 'failed' | 'unscanned') => {
    if (selectedReceiptLinkIds.length === 0) return;
    setModerationSavingId(`links-status-${status}`);
    try {
      await callModerationApi('updateReceiptLinksStatus', { ids: selectedReceiptLinkIds, status });
      await fetchReceiptLinks();
      setSelectedReceiptLinkIds([]);
      window.Telegram?.WebApp?.showAlert(t.linksUpdated);
    } catch {
      window.Telegram?.WebApp?.showAlert(t.moderationError);
    } finally {
      setModerationSavingId(null);
    }
  };

  const deleteSelectedReceiptLinks = async () => {
    if (selectedReceiptLinkIds.length === 0) return;
    setModerationSavingId('links-delete');
    try {
      await callModerationApi('deleteReceiptLinks', { ids: selectedReceiptLinkIds });
      await fetchReceiptLinks();
      setSelectedReceiptLinkIds([]);
      window.Telegram?.WebApp?.showAlert(t.linksDeleted);
    } catch {
      window.Telegram?.WebApp?.showAlert(t.moderationError);
    } finally {
      setModerationSavingId(null);
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
      if (field === 'price' || field === 'quantity' || field === 'unit_price' || field === 'latitude' || field === 'longitude') {
        const numericValue = parseFloat(value);
        return { ...item, [field]: value === '' ? null : (Number.isFinite(numericValue) ? numericValue : item[field]) };
      }
      if (field === 'price_scope' && (value === 'chain' || value === 'location')) {
        return { ...item, price_scope: value };
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
          place_name: item.place_name ?? '',
          place_address: item.place_address ?? '',
          city: item.city ?? '',
          latitude: typeof item.latitude === 'number' ? item.latitude : undefined,
          longitude: typeof item.longitude === 'number' ? item.longitude : undefined,
          price_scope: item.price_scope ?? 'location',
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
      await callModerationApi('update', {
        id: item.id,
        changes: {
          product_name_raw: item.product_name_raw,
          price: item.price,
          quantity: item.quantity,
          unit_price: item.unit_price,
          place_name: item.place_name ?? '',
          place_address: item.place_address ?? '',
          city: item.city ?? '',
          latitude: typeof item.latitude === 'number' ? item.latitude : undefined,
          longitude: typeof item.longitude === 'number' ? item.longitude : undefined,
          price_scope: item.price_scope ?? 'location',
        },
      });
      const result = await callModerationApi('approve', { id: item.id });
      await fetchModerationItems();
      const movedToQueue = Number(result?.approvedCount) || 0;
      window.Telegram?.WebApp?.showAlert(
        movedToQueue > 0 ? t.approvedToQueue(movedToQueue) : t.moderationApproved
      );
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
      const CHUNK_SIZE = 50;
      const PARALLEL_REQUESTS = 3;
      const ids = [...selectedModerationIds];
      let approvedCount = 0;
      const failedSet = new Set<string>();

      for (let i = 0; i < ids.length; i += CHUNK_SIZE * PARALLEL_REQUESTS) {
        const batchEnd = Math.min(i + CHUNK_SIZE * PARALLEL_REQUESTS, ids.length);
        const chunks: string[][] = [];
        for (let j = i; j < batchEnd; j += CHUNK_SIZE) {
          chunks.push(ids.slice(j, j + CHUNK_SIZE));
        }

        const results = await Promise.all(
          chunks.map(chunkIds => callModerationApi('approveMany', { ids: chunkIds }))
        );

        for (const result of results) {
          approvedCount += Number(result?.approvedCount) || 0;
          for (const failedId of (result?.failedIds || [])) failedSet.add(String(failedId));
        }
      }

      await fetchModerationItems();
      setSelectedModerationIds([]);
      const failedCount = failedSet.size;
      if (approvedCount > 0) {
        const approvedMessage = t.approvedToQueue(approvedCount);
        window.Telegram?.WebApp?.showAlert(
          failedCount > 0 ? `${approvedMessage}\nFailed to approve: ${failedCount}` : approvedMessage
        );
      } else if (failedCount > 0) {
        window.Telegram?.WebApp?.showAlert(t.moderationError);
      } else {
        window.Telegram?.WebApp?.showAlert(t.moderationApproved);
      }
    } catch {
      window.Telegram?.WebApp?.showAlert(t.moderationError);
    } finally {
      setModerationSavingId(null);
    }
  };

  const rejectSelectedModerationItems = async () => {
    if (selectedModerationIds.length === 0) return;
    setModerationSavingId('bulk-reject');
    try {
      await callModerationApi('rejectMany', { ids: selectedModerationIds });
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

  const selectAllApprovedItems = () => {
    setSelectedApprovedIds(approvedItems.map(item => item.id));
  };

  const selectApprovedBySource = (source: string) => {
    setSelectedApprovedIds(approvedItems.filter(item => item.source === source).map(item => item.id));
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
      await fetchProducts({ force: true });
      window.Telegram?.WebApp?.showAlert(t.moderationSaved);
    } catch {
      window.Telegram?.WebApp?.showAlert(t.moderationError);
    } finally {
      setModerationSavingId(null);
    }
  };

  const deleteProductItem = async (item: ProductAdminItem) => {
    const productId = String(item?.id || '').trim();
    if (!productId) {
      window.Telegram?.WebApp?.showAlert(t.moderationError);
      return;
    }

    setModerationSavingId(item.id);
    try {
      const result = await callModerationApi('deleteProduct', { id: productId });
      if ((Number(result?.deletedCount) || 0) < 1) {
        throw new Error('PRODUCT_DELETE_NOOP');
      }

      // Keep UI responsive by removing deleted product immediately.
      setProductAdminItems(items => items.filter(existing => existing.id !== productId));
      setSelectedProductIds(prev => prev.filter(id => id !== productId));
      setActiveProductId(prev => (prev === productId ? null : prev));

      await Promise.all([
        fetchModerationProducts(),
        fetchProducts({ force: true }),
      ]);
      window.Telegram?.WebApp?.showAlert(t.productDeleted);
    } catch (error) {
      console.error('deleteProduct failed', error);
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
    const idsToDelete = Array.from(new Set(selectedProductIds.map(id => String(id || '').trim()).filter(Boolean)));
    if (idsToDelete.length === 0) return;
    if (!window.confirm(t.confirmDeleteSelectedProducts)) return;

    setModerationSavingId('bulk-delete-products');
    try {
      const result = await callModerationApi('deleteProductsMany', { ids: idsToDelete });
      if ((Number(result?.deletedCount) || 0) < 1) {
        throw new Error('PRODUCT_BULK_DELETE_NOOP');
      }

      setProductAdminItems(items => items.filter(item => !idsToDelete.includes(item.id)));
      setSelectedProductIds([]);
      setActiveProductId(prev => (prev && idsToDelete.includes(prev) ? null : prev));

      await Promise.all([
        fetchModerationProducts(),
        fetchProducts({ force: true }),
      ]);
      window.Telegram?.WebApp?.showAlert(t.productDeleted);
    } catch (error) {
      console.error('deleteProductsMany failed', error);
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
      await fetchProducts({ force: true });
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
      await fetchProducts({ force: true });
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
    if (mode === 'moderate' && isAdminUser && moderationSection === 'stores') {
      fetchAdminStores();
    }
  }, [mode, isAdminUser, moderationSection]);

  useEffect(() => {
    if (mode !== 'moderate' || !isAdminUser || moderationSection !== 'products') return;
    if (!activeProductId) return;

    const activeItem = productAdminItems.find(item => item.id === activeProductId);
    if (!activeItem || activeItem.details_loaded || productDetailLoadingId === activeProductId) return;

    fetchProductLinkedData(activeProductId);
  }, [
    mode,
    isAdminUser,
    moderationSection,
    activeProductId,
    productAdminItems,
    productDetailLoadingId,
  ]);

  useEffect(() => {
    if (mode === 'moderate' && isAdminUser && moderationSection === 'messages') {
      fetchModerationMessages();
    }
  }, [mode, isAdminUser, moderationSection]);

  useEffect(() => {
    if (mode === 'moderate' && isAdminUser && moderationSection === 'links') {
      fetchReceiptLinks();
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

  const planFilteredProducts = useMemo(() => {
    if (!planSearchQuery || planSearchQuery.length < 2) return [];
    const q = planSearchQuery.toLowerCase();
    return cityProducts
      .filter(p =>
        !shoppingList.some(s => s.id === p.id) && (
          p.name_uz.toLowerCase().includes(q) ||
          p.name_ru.toLowerCase().includes(q) ||
          (p.name_en || '').toLowerCase().includes(q) ||
          (p.search_text || '').toLowerCase().includes(q)
        )
      )
      .slice(0, 8);
  }, [planSearchQuery, cityProducts, shoppingList]);

  useEffect(() => {
    if (!planLoading) return;
    const interval = setInterval(() => {
      setPlanLoadingMsgIdx(i => i + 1);
    }, 2000);
    return () => clearInterval(interval);
  }, [planLoading]);

  const copyPlanToClipboard = () => {
    if (!planResult || !planResult.bestPlan) return;
    const lines: string[] = [];
    lines.push(t.planBestTitle);
    for (const store of planResult.bestPlan.stores) {
      lines.push('');
      lines.push(`📍 ${store.name}${store.address ? ` — ${store.address}` : ''}`);
      const items = planResult.bestPlan.itemAssignments[store.name];
      if (items) {
        for (const it of items) {
          lines.push(`  • ${getProductName(it.item, lang)}: ${priceFormatter.format(it.price)} ${t.planSumLabel}`);
        }
      }
    }
    lines.push('');
    lines.push(`${t.planTotal}: ${priceFormatter.format(planResult.bestPlan.totalItemCost)} ${t.planSumLabel}`);
    if (planResult.savings > 0) {
      lines.push(`${t.planSavings}: ${priceFormatter.format(planResult.savings)} ${t.planSumLabel}`);
    }
    navigator.clipboard.writeText(lines.join('\n'));
  };

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

  const clearSearchInput = () => {
    setSearchQuery('');
    setShowDropdown(false);
    setSelectedProduct(null);
    setPrices([]);
    setFindMapFocus(null);
    setSelectedProductWeeklyViews(0);
    findSearchInputRef.current?.focus();
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
    // Priority: receipt (source='receipt') > location-specific (price_scope='location') > chain-wide (price_scope='chain')
    const pricePriority = (p: PriceRecord) => {
      if (p.source === 'receipt') return 3;
      if ((p.price_scope ?? 'location') === 'location') return 2;
      return 1;
    };

    // Separate chain-wide (no lat/lng, scope='chain') from everything else
    const chainPrices = prices.filter(p => p.price_scope === 'chain' && p.latitude == null && p.longitude == null);
    const locationPrices = prices.filter(p => !(p.price_scope === 'chain' && p.latitude == null && p.longitude == null));

    // Dedup location prices by rounded lat/lng cluster or place key, keeping highest priority
    const priceByKey = new Map<string, PriceRecord>();
    for (const price of locationPrices) {
      const latR = price.latitude != null ? Math.round(price.latitude * 1000) / 1000 : null;
      const lngR = price.longitude != null ? Math.round(price.longitude * 1000) / 1000 : null;
      const key = latR != null
        ? `${latR},${lngR}|${price.product_id}`
        : `${(price.place_name || '').trim().toLowerCase()}|${(price.place_address || '').trim().toLowerCase()}|${(price.city || '').trim().toLowerCase()}|${price.product_id}`;

      const existing = priceByKey.get(key);
      if (!existing) { priceByKey.set(key, price); continue; }
      const ep = pricePriority(existing), np = pricePriority(price);
      if (np > ep) { priceByKey.set(key, price); continue; }
      if (np === ep) {
        const existingTs = new Date(existing.receipt_date || 0).getTime();
        const nextTs = new Date(price.receipt_date || 0).getTime();
        if (nextTs >= existingTs) priceByKey.set(key, price);
      }
    }

    // Expand chain-wide prices to all known branches of that chain,
    // but only where no location-specific price already exists
    for (const chainPrice of chainPrices) {
      const chainName = (chainPrice.place_name || '').toLowerCase().trim();
      const matchingBranches = knownStores.filter(s =>
        s.name.toLowerCase().includes(chainName) || chainName.includes(s.name.toLowerCase())
      );

      if (matchingBranches.length === 0) {
        // No known branches — show as a plain entry without coordinates
        const fallbackKey = `chain_${chainName}|${chainPrice.product_id}`;
        if (!priceByKey.has(fallbackKey)) priceByKey.set(fallbackKey, chainPrice);
        continue;
      }

      for (const branch of matchingBranches) {
        const latR = Math.round(branch.lat * 1000) / 1000;
        const lngR = Math.round(branch.lng * 1000) / 1000;
        const locKey = `${latR},${lngR}|${chainPrice.product_id}`;
        // Only use chain price here if no receipt/location-specific price is already set
        if (!priceByKey.has(locKey)) {
          priceByKey.set(locKey, { ...chainPrice, latitude: branch.lat, longitude: branch.lng });
        }
      }
    }

    const dedupedByStore = Array.from(priceByKey.values());

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
  }, [prices, nearbyEnabled, userLocation, knownStores]);

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
    let targetLat = price.latitude;
    let targetLng = price.longitude;

    if (targetLat === null || targetLng === null) {
      if (mapPrices.length === 0) return;

      const nearest = userLocation
        ? [...mapPrices].sort((left, right) => {
            const leftDistance = haversineDistanceKm(userLocation, { lat: left.latitude!, lng: left.longitude! });
            const rightDistance = haversineDistanceKm(userLocation, { lat: right.latitude!, lng: right.longitude! });
            return leftDistance - rightDistance;
          })[0]
        : mapPrices[0];

      targetLat = nearest.latitude;
      targetLng = nearest.longitude;
    }

    if (targetLat === null || targetLng === null) return;

    setFindMapFocus({
      lat: targetLat,
      lng: targetLng,
      zoom: 16,
      trigger: Date.now(),
    });

    window.requestAnimationFrame(() => {
      findMapSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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

  const runShoppingPlan = async () => {
    if (shoppingList.length === 0) return;
    setPlanLoading(true);
    setPlanResult(null);
    setPlanStep('results');
    setPlanLoadingMsgIdx(0);

    const distanceRadiusKm = planDistanceMode === 'near' ? 2 : planDistanceMode === 'medium' ? 5 : 10;
    const TRANSPORT_COST_PER_KM = 2000;

    const origin = userLocation || (() => {
      const city = getCityOption(selectedCity);
      return city ? { lat: city.center[0], lng: city.center[1] } : null;
    })();

    const productIds = shoppingList.map(p => p.id);

    // Phase 1: Fetch all prices for products in city
    let allPrices: Array<{
      product_id: string; product_name_raw: string; price: number;
      place_name: string; place_address: string;
      latitude: number | null; longitude: number | null;
      receipt_date: string | null;
    }> = [];
    const batchSize = 50;
    for (let i = 0; i < productIds.length; i += batchSize) {
      const batch = productIds.slice(i, i + batchSize);
      const { data } = await supabase
        .from('prices')
        .select('product_id, product_name_raw, price, place_name, place_address, latitude, longitude, receipt_date')
        .eq('city', selectedCity)
        .not('source', 'like', 'history_%')
        .in('product_id', batch);
      if (data) allPrices = [...allPrices, ...data];
    }

    // Phase 2: Build store inventory with distances
    // Key stores by rounded coordinates (~100m precision) to merge receipts from same physical store
    type StoreKey = string;
    type StoreEntry = {
      productId: string; productName: string; price: number;
      storeName: string; storeAddress: string;
      lat: number; lng: number; dataAge: number;
    };
    const storeInventory = new Map<StoreKey, Map<string, StoreEntry>>();

    const now = Date.now();
    for (const row of allPrices) {
      // Skip rows without coordinates — can't place on map or compute distance
      if (row.latitude == null || row.longitude == null) continue;

      // Round to ~100m grid to merge nearby receipts into one store
      const latRound = Math.round(row.latitude * 1000) / 1000;
      const lngRound = Math.round(row.longitude * 1000) / 1000;
      const storeKey = `${latRound},${lngRound}`;

      if (!storeInventory.has(storeKey)) storeInventory.set(storeKey, new Map());
      const inv = storeInventory.get(storeKey)!;
      const existing = inv.get(row.product_id);
      if (!existing || row.price < existing.price) {
        // Determine best display name: prefer address, skip receipt codes, fall back to known store
        const rawName = (row.place_name || '').trim();
        const rawAddr = (row.place_address || '').trim();
        const looksLikeCode = rawName.length > 0 && !/\s/.test(rawName) && /^[A-Z0-9]+$/i.test(rawName);
        const displayName = rawAddr || (looksLikeCode ? '' : rawName) || identifyStoreByCoords(row.latitude, row.longitude) || '';
        const displayAddress = looksLikeCode ? '' : rawAddr;
        const dataAge = row.receipt_date ? Math.floor((now - new Date(row.receipt_date).getTime()) / 86400000) : 999;
        inv.set(row.product_id, {
          productId: row.product_id,
          productName: row.product_name_raw || '',
          price: Number(row.price) || 0,
          storeName: displayName,
          storeAddress: displayAddress,
          lat: row.latitude,
          lng: row.longitude,
          dataAge,
        });
      } else if (existing) {
        // Even if price not cheaper, update display name if current entry has a better name
        const rawAddr = (row.place_address || '').trim();
        if (rawAddr && !existing.storeName) {
          existing.storeName = rawAddr;
        }
      }
    }

    // Compute distances and filter by radius
    const storeDistances = new Map<StoreKey, number>();
    for (const [storeKey, inv] of storeInventory) {
      const first = [...inv.values()][0];
      if (origin) {
        const dist = haversineDistanceKm(origin, { lat: first.lat, lng: first.lng });
        storeDistances.set(storeKey, dist);
        if (dist > distanceRadiusKm) {
          storeInventory.delete(storeKey);
        }
      }
    }

    if (storeInventory.size === 0) {
      setPlanResult({
        bestPlan: {
          stores: [], itemAssignments: {}, missingItems: [...shoppingList],
          totalItemCost: 0, totalTravelPenalty: 0, totalScore: 0, storeCount: 0, coveragePercent: 0,
        },
        singleStorePlans: [], savings: 0, cheapestSingleStore: null,
        hasSparseData: true, hasStaleData: false,
      });
      setPlanLoading(false);
      return;
    }

    // Phase 3: Build single-store plans
    const singleStorePlans: Array<{
      name: string; address: string; distance: number;
      latitude: number; longitude: number;
      totalCost: number; missingItems: string[];
      usedEstimate?: boolean;
      items: Record<string, number>;
    }> = [];

    // Compute median prices for estimates
    const productMedians = new Map<string, number>();
    for (const pid of productIds) {
      const prices: number[] = [];
      for (const [, inv] of storeInventory) {
        const entry = inv.get(pid);
        if (entry) prices.push(entry.price);
      }
      if (prices.length > 0) {
        prices.sort((a, b) => a - b);
        productMedians.set(pid, prices[Math.floor(prices.length / 2)]);
      }
    }

    for (const [storeKey, inv] of storeInventory) {
      const first = [...inv.values()][0];
      let totalCost = 0;
      const missing: string[] = [];
      const items: Record<string, number> = {};
      let usedEstimate = false;
      for (const p of shoppingList) {
        const entry = inv.get(p.id);
        if (entry) {
          totalCost += entry.price;
          items[p.id] = entry.price;
        } else {
          const median = productMedians.get(p.id);
          if (median) {
            totalCost += median;
            items[p.id] = median;
            usedEstimate = true;
          }
          missing.push(getProductName(p, lang));
        }
      }
      singleStorePlans.push({
        name: (() => { let best = ''; for (const e of inv.values()) { if (e.storeName.length > best.length) best = e.storeName; } return best || first.storeAddress || '?'; })(),
        address: (() => { let best = ''; for (const e of inv.values()) { if (e.storeAddress.length > best.length) best = e.storeAddress; } return best; })(),
        distance: storeDistances.get(storeKey) || 0,
        latitude: first.lat,
        longitude: first.lng,
        totalCost,
        missingItems: missing,
        usedEstimate,
        items,
      });
    }
    singleStorePlans.sort((a, b) => a.totalCost - b.totalCost);

    // Phase 4: Greedy set-cover for optimal multi-store plan
    const itemStoreOptions: Array<{
      product: Product;
      options: Map<StoreKey, { productName: string; price: number; dataAge: number }>;
    }> = [];
    const missingItems: Product[] = [];

    for (const p of shoppingList) {
      const options = new Map<StoreKey, { productName: string; price: number; dataAge: number }>();
      for (const [storeKey, inv] of storeInventory) {
        const entry = inv.get(p.id);
        if (entry) options.set(storeKey, { productName: entry.productName, price: entry.price, dataAge: entry.dataAge });
      }
      if (options.size === 0) missingItems.push(p);
      else itemStoreOptions.push({ product: p, options });
    }

    if (itemStoreOptions.length === 0) {
      setPlanResult({
        bestPlan: {
          stores: [], itemAssignments: {}, missingItems,
          totalItemCost: 0, totalTravelPenalty: 0, totalScore: 0, storeCount: 0, coveragePercent: 0,
        },
        singleStorePlans: singleStorePlans.slice(0, 10),
        savings: 0, cheapestSingleStore: null,
        hasSparseData: true, hasStaleData: false,
      });
      setPlanLoading(false);
      return;
    }

    const MAX_STORES = 5;
    const selectedStores = new Map<StoreKey, Array<{ item: Product; price: number; isCheapest?: boolean; dataAge?: number }>>();
    const coveredItems = new Set<number>();

    // Find cheapest price per item globally for "cheapest" badge
    const cheapestPricePerItem = new Map<string, number>();
    for (const { product, options } of itemStoreOptions) {
      let min = Infinity;
      for (const [, opt] of options) if (opt.price < min) min = opt.price;
      cheapestPricePerItem.set(product.id, min);
    }

    while (coveredItems.size < itemStoreOptions.length && selectedStores.size < MAX_STORES) {
      let bestStore: StoreKey | null = null;
      let bestScore = -Infinity;
      let bestItems: Array<{ idx: number; item: Product; price: number; dataAge: number }> = [];

      for (const [storeKey] of storeInventory) {
        if (selectedStores.has(storeKey)) continue;
        const items: Array<{ idx: number; item: Product; price: number; dataAge: number }> = [];
        let totalPrice = 0;
        for (let i = 0; i < itemStoreOptions.length; i++) {
          if (coveredItems.has(i)) continue;
          const opt = itemStoreOptions[i].options.get(storeKey);
          if (opt) {
            items.push({ idx: i, item: itemStoreOptions[i].product, price: opt.price, dataAge: opt.dataAge });
            totalPrice += opt.price;
          }
        }
        if (items.length === 0) continue;
        const distKm = storeDistances.get(storeKey) || 0;
        const score = items.length * 1_000_000 - totalPrice - distKm * TRANSPORT_COST_PER_KM;
        if (score > bestScore) { bestScore = score; bestStore = storeKey; bestItems = items; }
      }

      if (!bestStore) break;
      selectedStores.set(bestStore, bestItems.map(({ item, price, dataAge }) => ({
        item,
        price,
        isCheapest: cheapestPricePerItem.get(item.id) === price,
        dataAge,
      })));
      for (const it of bestItems) coveredItems.add(it.idx);
    }

    // Mark uncovered items
    for (let i = 0; i < itemStoreOptions.length; i++) {
      if (!coveredItems.has(i)) missingItems.push(itemStoreOptions[i].product);
    }

    // Helper: best display name for a store (picks longest non-code name from all entries)
    const getStoreDisplayName = (storeKey: StoreKey): { name: string; address: string } => {
      const inv = storeInventory.get(storeKey);
      if (!inv) return { name: storeKey, address: '' };
      let bestName = '';
      let bestAddr = '';
      for (const entry of inv.values()) {
        if (entry.storeName.length > bestName.length) bestName = entry.storeName;
        if (entry.storeAddress.length > bestAddr.length) bestAddr = entry.storeAddress;
      }
      // If no human-readable name found, try known store lookup by coordinates
      if (!bestName && !bestAddr) {
        const first = [...inv.values()][0];
        const knownName = identifyStoreByCoords(first.lat, first.lng);
        bestName = knownName || `📍 ${first.lat.toFixed(4)}, ${first.lng.toFixed(4)}`;
      }
      return { name: bestName || bestAddr || storeKey, address: bestAddr !== bestName ? bestAddr : '' };
    };

    // Build stores array
    const bestStores = [...selectedStores.entries()].map(([storeKey]) => {
      const first = [...(storeInventory.get(storeKey)?.values() || [])][0];
      const display = getStoreDisplayName(storeKey);
      return {
        name: display.name,
        address: display.address,
        latitude: first?.lat || 0,
        longitude: first?.lng || 0,
        distance: storeDistances.get(storeKey) ?? 0,
      };
    }).sort((a, b) => a.distance - b.distance);

    // Build item assignments keyed by store name (use storeKey to avoid name collisions)
    const itemAssignments: Record<string, Array<{ item: Product; price: number; isCheapest?: boolean; dataAge?: number }>> = {};
    for (const [storeKey, items] of selectedStores) {
      const display = getStoreDisplayName(storeKey);
      itemAssignments[display.name] = items;
    }

    const totalItemCost = [...selectedStores.values()].flat().reduce((s, i) => s + i.price, 0);
    const totalTravelPenalty = bestStores.reduce((s, st) => s + st.distance * TRANSPORT_COST_PER_KM, 0);
    const totalScore = totalItemCost + totalTravelPenalty;
    const coveragePercent = shoppingList.length > 0 ? Math.round(((shoppingList.length - missingItems.length) / shoppingList.length) * 100) : 0;

    const cheapestSingle = singleStorePlans.length > 0 ? singleStorePlans[0] : null;
    const savings = cheapestSingle ? Math.max(cheapestSingle.totalCost - totalItemCost, 0) : 0;

    let hasStaleData = false;
    for (const items of selectedStores.values()) {
      for (const it of items) {
        if ((it.dataAge ?? 999) > 7) { hasStaleData = true; break; }
      }
      if (hasStaleData) break;
    }

    setPlanResult({
      bestPlan: {
        stores: bestStores,
        itemAssignments,
        missingItems,
        totalItemCost,
        totalTravelPenalty,
        totalScore,
        storeCount: bestStores.length,
        coveragePercent,
      },
      singleStorePlans: singleStorePlans.slice(0, 10),
      savings,
      cheapestSingleStore: cheapestSingle ? { name: cheapestSingle.name, totalCost: cheapestSingle.totalCost } : null,
      hasSparseData: storeInventory.size < 3,
      hasStaleData,
    });
    setPlanLoading(false);
  };

  useEffect(() => {
    setFindMapFocus(null);
  }, [selectedCity, selectedProduct?.id, nearbyEnabled]);

  const handleReportSubmit = async () => {
    const validItems = reportItems.filter(it => it.price.trim() && (it.product || it.productQuery.trim()));
    if (!selectedStore) {
      window.Telegram?.WebApp?.showAlert(t.alertFill);
      return;
    }
    if (validItems.length === 0) {
      window.Telegram?.WebApp?.showAlert(t.alertFill);
      return;
    }
    for (const it of validItems) {
      const p = parseInt(it.price);
      if (!p || p <= 0) {
        window.Telegram?.WebApp?.showAlert(t.invalidPrice);
        return;
      }
    }

    setSubmitting(true);
    try {
      // Helper: detect Supabase "table/column does not exist" errors so we can
      // degrade gracefully when the stores migration hasn't been run yet.
      const isMissingSchema = (err: unknown): boolean => {
        const msg = String((err as any)?.message || '').toLowerCase();
        return msg.includes('does not exist') || msg.includes('relation') || msg.includes('schema cache');
      };

      // Create new store if needed
      let storeId: string | null = selectedStore.id;
      if (selectedStore.isNew) {
        const { data: newStore, error: storeErr } = await supabase.from('stores').insert({
          name: selectedStore.name,
          latitude: selectedStore.latitude ?? null,
          longitude: selectedStore.longitude ?? null,
          city: selectedCity,
          source: 'user_manual',
          verified: false,
          times_submitted: 1,
        }).select('id').single();
        if (storeErr) {
          if (isMissingSchema(storeErr)) {
            // stores table not yet created — proceed without store_id
            storeId = null;
          } else {
            throw storeErr;
          }
        } else {
          storeId = newStore.id;
        }
      } else if (storeId) {
        const { error: updateErr } = await supabase.from('stores').update({ times_submitted: (selectedStore.times_submitted ?? 0) + validItems.length }).eq('id', storeId);
        if (updateErr && !isMissingSchema(updateErr)) throw updateErr;
      }

      const submittedBy = window.Telegram?.WebApp?.initDataUnsafe?.user?.id?.toString() || 'unknown';
      const rows = validItems.map(it => ({
        product_id: it.product?.id || null,
        product_name_raw: it.product ? getProductName(it.product, lang) : it.productQuery.trim(),
        match_confidence: it.product ? 100 : 0,
        status: 'pending',
        price: parseInt(it.price),
        quantity: 1,
        unit_price: parseInt(it.price),
        latitude: selectedStore.latitude ?? null,
        longitude: selectedStore.longitude ?? null,
        place_name: selectedStore.name,
        city: selectedCity,
        receipt_date: new Date().toISOString(),
        source: 'manual',
        submitted_by: submittedBy,
        // Only include store_id if the stores migration has been run (storeId is a real UUID)
        ...(storeId != null ? { store_id: storeId } : {}),
      }));

      const { error } = await supabase.from('pending_prices').insert(rows);
      if (error) throw error;

      window.Telegram?.WebApp?.showAlert(t.alertSuccess);
      setMode('find');
      setSelectedStore(null);
      setReportItems([{ id: crypto.randomUUID(), product: null, productQuery: '', price: '', showDropdown: false }]);
    } catch {
      window.Telegram?.WebApp?.showAlert(t.alertError);
    } finally {
      setSubmitting(false);
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
    setSelectedStore(null);
    setReportItems([{ id: crypto.randomUUID(), product: null, productQuery: '', price: '', showDropdown: false }]);
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
              {SHOW_SHOPPING_PLAN_MENU && (
                <button 
                  onClick={() => setMode('plan')}
                  className={cn(
                    "px-4 py-1.5 rounded-md text-sm font-medium transition-all",
                    mode === 'plan' ? "bg-white shadow-sm text-emerald-600" : "text-stone-500"
                  )}
                >
                  {t.modePlan}
                </button>
              )}
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

        {mode !== 'find' && <div className="mb-4">
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
        </div>}

        {/* Search Bar */}
        {mode === 'find' && <div className="relative rounded-2xl border-2 border-emerald-200 bg-emerald-50 p-3">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-emerald-700">{t.emptyTitle}</div>
          <div className="relative">
            <button
              title={t.searchPlaceholder}
              onClick={() => {
                setShowDropdown(true);
                findSearchInputRef.current?.focus();
              }}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-emerald-600"
            >
              <Search className="w-5 h-5" />
            </button>
            <input 
              ref={findSearchInputRef}
              type="text"
              placeholder={t.searchPlaceholder}
              className="w-full bg-white border border-emerald-200 rounded-xl py-3.5 pl-11 pr-11 text-base font-medium focus:ring-2 focus:ring-emerald-500 transition-all"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setShowDropdown(true);
              }}
              onFocus={() => setShowDropdown(true)}
            />
            {searchQuery.trim().length > 0 && (
              <button
                title="Clear"
                onClick={clearSearchInput}
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-stone-100 p-1 text-stone-500 hover:bg-stone-200"
              >
                <X className="w-4 h-4" />
              </button>
            )}
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
              {productsLoading && (
                <div className="px-4 py-2 text-xs text-center text-stone-400 italic">Loading more products...</div>
              )}
            </div>
          )}
        </div>}
      </header>

      <main className="p-4">
        {mode === 'find' ? (
          <div className="space-y-6">
            <section className="rounded-xl border border-stone-200 bg-white p-3 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-[180px]">
                  <div className="text-xs font-semibold uppercase tracking-wider text-stone-500">{t.cityLabel}</div>
                  <select
                    value={selectedCity}
                    onChange={(e) => setSelectedCity(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-stone-200 bg-stone-50 px-2 py-1.5 text-sm font-medium text-stone-700"
                  >
                    {CITY_OPTIONS.map(city => (
                      <option key={city.value} value={city.value}>{city.labels[lang]}</option>
                    ))}
                  </select>
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
              {geoError && <div className="mt-2 text-xs font-medium text-rose-600">{geoError}</div>}
            </section>

            {!selectedProduct ? (
              <div className="rounded-2xl border border-dashed border-emerald-300 bg-white px-5 py-10 text-center">
                <h2 className="text-lg font-semibold text-stone-900 mb-2">{t.emptyTitle}</h2>
                <p className="text-stone-500 text-sm px-2">
                  {t.emptyHint}
                </p>
                <button
                  onClick={() => {
                    setShowDropdown(true);
                    findSearchInputRef.current?.focus();
                  }}
                  className="mt-4 inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white"
                >
                  <Search className="h-4 w-4" />
                  {t.emptyTitle}
                </button>
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
                            <p className="text-sm text-stone-600 truncate">{p.place_name || (p.latitude != null && p.longitude != null ? identifyStoreByCoords(p.latitude, p.longitude) : null) || t.unknownStore}</p>
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
                              className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-emerald-700 transition-colors hover:bg-emerald-100"
                            >
                              <Navigation className="w-4 h-4" />
                              <span className="text-[11px] font-semibold">{t.mapTitle}</span>
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
                <section ref={findMapSectionRef}>
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
                              <div className="text-sm text-stone-600">{p.place_name || (p.latitude != null && p.longitude != null ? identifyStoreByCoords(p.latitude, p.longitude) : null) || t.unknownStore}</div>
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
        ) : mode === 'plan' ? (
          <div className="space-y-4">
            {planStep === 'list' ? (
              <>
                {/* Section 1: Product search & shopping list */}
                <section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
                  <h2 className="text-lg font-bold text-stone-900 mb-1">{t.planTitle}</h2>

                  {/* Search input */}
                  <div className="relative mb-3">
                    <input
                      type="text"
                      value={planSearchQuery}
                      onChange={(e) => { setPlanSearchQuery(e.target.value); setPlanShowDropdown(true); }}
                      onFocus={() => setPlanShowDropdown(true)}
                      placeholder={t.planAddPlaceholder}
                      className="w-full rounded-lg border border-stone-200 bg-stone-50 px-3 py-2.5 text-sm pr-8"
                    />
                    {planSearchQuery && (
                      <button onClick={() => { setPlanSearchQuery(''); setPlanShowDropdown(false); }} className="absolute right-2 top-1/2 -translate-y-1/2 text-stone-400">
                        <X className="h-4 w-4" />
                      </button>
                    )}

                    {/* Dropdown */}
                    {planShowDropdown && planFilteredProducts.length > 0 && (
                      <div className="absolute left-0 right-0 top-full mt-1 bg-white border border-stone-200 rounded-lg shadow-lg z-30 max-h-48 overflow-y-auto">
                        {planFilteredProducts.map(p => (
                          <button
                            key={p.id}
                            onClick={() => {
                              setShoppingList(prev => [...prev, p]);
                              setPlanSearchQuery('');
                              setPlanShowDropdown(false);
                            }}
                            className="w-full text-left px-3 py-2 text-sm hover:bg-stone-50 border-b border-stone-50 last:border-0"
                          >
                            <div className="font-medium text-stone-900">{getProductName(p, lang)}</div>
                            <div className="text-xs text-stone-400">{getProductSecondary(p, lang)}{p.unit ? ` · ${p.unit}` : ''}</div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Shopping list chips */}
                  {shoppingList.length > 0 ? (
                    <div className="space-y-2">
                      <div className="flex flex-wrap gap-2">
                        {shoppingList.map(p => (
                          <span key={p.id} className="inline-flex items-center gap-1 rounded-full bg-emerald-50 border border-emerald-200 px-3 py-1.5 text-sm font-medium text-emerald-800">
                            {getProductName(p, lang)}
                            <button onClick={() => setShoppingList(prev => prev.filter(s => s.id !== p.id))} className="ml-0.5 text-emerald-400 hover:text-emerald-700">
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </span>
                        ))}
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-stone-400">{t.planItemCount(shoppingList.length)}</span>
                        <button onClick={() => setShoppingList([])} className="text-xs text-stone-400 hover:text-red-500 underline">{t.planClearAll}</button>
                      </div>
                    </div>
                  ) : (
                    <div className="text-center py-6">
                      <ShoppingCart className="h-8 w-8 text-stone-200 mx-auto mb-2" />
                      <p className="text-sm text-stone-400">{t.planEmptyList}</p>
                      <p className="text-xs text-stone-300 mt-1">{t.planEmptyArrow}</p>
                    </div>
                  )}
                </section>

                {/* Section 2: Location */}
                <section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
                  <label className="text-xs font-semibold text-stone-500 uppercase tracking-wide block mb-2">{t.planMyLocation}</label>
                  <div className="flex gap-2 items-center mb-2">
                    <button
                      onClick={() => {
                        setPlanLocatingGps(true);
                        requestUserLocation((coords) => {
                          setPlanLocationInput(`${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`);
                          setPlanLocatingGps(false);
                        });
                        setTimeout(() => setPlanLocatingGps(false), 25000);
                      }}
                      disabled={planLocatingGps}
                      className="flex-1 flex items-center justify-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm font-medium text-emerald-700 disabled:opacity-50"
                    >
                      {planLocatingGps ? <Loader2 className="h-4 w-4 animate-spin" /> : <Crosshair className="h-4 w-4" />}
                      {planLocatingGps ? t.planGpsLocating : userLocation ? t.planGpsSet : t.planSetLocation}
                    </button>
                    {(userLocation || planLocationInput) && (
                      <button onClick={() => { setUserLocation(null); setPlanLocationInput(''); }} className="text-xs text-stone-400 hover:text-stone-600 underline px-2">
                        {t.planLocationClear}
                      </button>
                    )}
                  </div>

                  {/* District fallback */}
                  <div className="relative">
                    <p className="text-xs text-stone-400 mb-1">{t.planOrDistrict}</p>
                    <input
                      type="text"
                      value={planDistrictQuery}
                      onChange={(e) => { setPlanDistrictQuery(e.target.value); setPlanDistrictDropdown(true); }}
                      onFocus={() => setPlanDistrictDropdown(true)}
                      placeholder="Mirzo Ulugbek, Yunusabad..."
                      className="w-full rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm"
                    />
                    {planDistrictDropdown && planDistrictQuery.length > 0 && (
                      <div className="absolute left-0 right-0 top-full mt-1 bg-white border border-stone-200 rounded-lg shadow-lg z-30 max-h-36 overflow-y-auto">
                        {DISTRICT_LIST.filter((d: { name: string }) => d.name.toLowerCase().includes(planDistrictQuery.toLowerCase())).map((d: { name: string; lat: number; lng: number }) => (
                          <button
                            key={d.name}
                            onClick={() => {
                              setUserLocation({ lat: d.lat, lng: d.lng });
                              setPlanDistrictQuery(d.name);
                              setPlanDistrictDropdown(false);
                              setPlanLocationInput(`${d.lat}, ${d.lng}`);
                            }}
                            className="w-full text-left px-3 py-2 text-sm hover:bg-stone-50 border-b border-stone-50 last:border-0"
                          >
                            {d.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </section>

                {/* Section 3: Distance preference cards */}
                <section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
                  <div className="grid grid-cols-3 gap-2">
                    {([
                      { key: 'near' as const, emoji: t.planDistNear, range: t.planDistNearRange, hint: t.planDistNearHint },
                      { key: 'medium' as const, emoji: t.planDistMedium, range: t.planDistMediumRange, hint: t.planDistMediumHint },
                      { key: 'far' as const, emoji: t.planDistFar, range: t.planDistFarRange, hint: t.planDistFarHint },
                    ]).map(d => (
                      <button
                        key={d.key}
                        onClick={() => setPlanDistanceMode(d.key)}
                        className={`rounded-xl border-2 p-3 text-center transition-all ${
                          planDistanceMode === d.key
                            ? 'border-emerald-500 bg-emerald-50 shadow-sm'
                            : 'border-stone-200 bg-white'
                        }`}
                      >
                        <div className="text-lg mb-0.5">{d.emoji}</div>
                        <div className="text-xs font-bold text-stone-700">{d.range}</div>
                        <div className="text-[10px] text-stone-400">{d.hint}</div>
                      </button>
                    ))}
                  </div>
                </section>

                {/* Calculate button */}
                <button
                  onClick={runShoppingPlan}
                  disabled={planLoading || shoppingList.length === 0}
                  className="w-full rounded-2xl bg-emerald-600 px-4 py-4 text-base font-bold text-white disabled:opacity-40 shadow-lg shadow-emerald-200 flex items-center justify-center gap-2"
                >
                  {planLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : null}
                  {t.planCalculate}
                </button>
              </>
            ) : (
              /* ===== RESULTS VIEW ===== */
              <>
                {/* Loading */}
                {planLoading && (
                  <div className="text-center py-16">
                    <Loader2 className="h-10 w-10 animate-spin text-emerald-500 mx-auto mb-4" />
                    <p className="text-sm text-stone-500 animate-pulse">{t.planLoadingMsgs[planLoadingMsgIdx % t.planLoadingMsgs.length]}</p>
                  </div>
                )}

                {/* No data */}
                {!planLoading && planResult && planResult.bestPlan.stores.length === 0 && (
                  <div className="text-center py-12">
                    <ShoppingCart className="h-10 w-10 text-stone-300 mx-auto mb-3" />
                    <p className="text-sm font-medium text-stone-600 mb-1">{t.planNoData}</p>
                    <p className="text-xs text-stone-400">{t.planNoDataHint}</p>
                    <button onClick={() => setPlanStep('list')} className="mt-4 rounded-lg border border-stone-200 px-4 py-2 text-sm text-stone-600">{t.planNewSearch}</button>
                  </div>
                )}

                {/* Results */}
                {!planLoading && planResult && planResult.bestPlan.stores.length > 0 && (
                  <div className="space-y-4">
                    {/* Section A: Best plan */}
                    <section className="rounded-2xl border-2 border-emerald-200 bg-gradient-to-b from-emerald-50 to-white p-4 shadow-sm">
                      <div className="flex items-center justify-between mb-3">
                        <h3 className="text-lg font-bold text-emerald-900">{t.planBestTitle}</h3>
                        <span className="text-xs bg-emerald-100 text-emerald-700 rounded-full px-2.5 py-1 font-semibold">
                          {t.planStoreCount(planResult.bestPlan.storeCount)}
                        </span>
                      </div>

                      {/* Store cards */}
                      {planResult.bestPlan.stores.map((store, idx) => {
                        const storeItems = planResult.bestPlan.itemAssignments[store.name] || [];
                        const storeTotal = storeItems.reduce((s, i) => s + i.price, 0);
                        const isExpanded = expandedStoreIdx === idx;
                        return (
                          <div key={idx} className="mb-3 last:mb-0">
                            <button
                              onClick={() => setExpandedStoreIdx(isExpanded ? null : idx)}
                              className="w-full text-left rounded-xl border border-stone-200 bg-white p-3 shadow-sm"
                            >
                              <div className="flex items-center gap-3">
                                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-100 text-sm font-bold text-emerald-700 shrink-0">
                                  {idx + 1}
                                </span>
                                <div className="flex-1 min-w-0">
                                  <div className="font-semibold text-stone-900 truncate">{store.name}</div>
                                  {store.address && <div className="text-xs text-stone-400 truncate">{store.address}</div>}
                                  <div className="flex items-center gap-2 mt-0.5">
                                    {store.distance > 0 && (
                                      <span className="text-xs text-blue-500">{t.planDistanceAway(store.distance.toFixed(1))}</span>
                                    )}
                                    <span className="text-xs font-medium text-stone-600">{storeItems.length} item(s) · {priceFormatter.format(storeTotal)} {t.planSumLabel}</span>
                                  </div>
                                </div>
                                <ChevronDown className={`h-4 w-4 text-stone-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                              </div>
                            </button>
                            {isExpanded && (
                              <div className="mt-1 ml-11 space-y-1">
                                {storeItems.map((it, j) => (
                                  <div key={j} className="flex justify-between text-sm py-1.5 px-2 rounded-lg bg-stone-50">
                                    <span className="text-stone-700 flex items-center gap-1">
                                      {getProductName(it.item, lang)}
                                      {it.isCheapest && <span className="text-[10px] text-emerald-600 font-semibold">{t.planCheapestBadge}</span>}
                                    </span>
                                    <div className="text-right">
                                      <span className="font-medium text-stone-900">{priceFormatter.format(it.price)} {t.planSumLabel}</span>
                                      {it.dataAge != null && it.dataAge <= 30 && (
                                        <div className="text-[10px] text-stone-400">
                                          {it.dataAge > 7 && t.planDataStale}{t.planDataAge(it.dataAge)}
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}

                      {/* Missing items */}
                      {planResult.bestPlan.missingItems.length > 0 && (
                        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3">
                          <div className="text-xs font-semibold text-amber-700 mb-1">{t.planMissing}</div>
                          <div className="text-sm text-amber-600">
                            {planResult.bestPlan.missingItems.map(p => getProductName(p, lang)).join(', ')}
                          </div>
                          <div className="text-xs text-amber-500 mt-1">{t.planMissingHint}</div>
                        </div>
                      )}

                      {/* Totals */}
                      <div className="mt-4 pt-3 border-t border-emerald-200 space-y-1">
                        <div className="flex justify-between text-base font-bold text-emerald-900">
                          <span>{t.planTotal}</span>
                          <span>{priceFormatter.format(planResult.bestPlan.totalItemCost)} {t.planSumLabel}</span>
                        </div>
                        {planResult.savings > 0 && (
                          <div>
                            <div className="flex justify-between text-sm text-emerald-700">
                              <span>{t.planSavings}</span>
                              <span>~{priceFormatter.format(planResult.savings)} {t.planSumLabel}</span>
                            </div>
                            <div className="text-xs text-emerald-500 mt-0.5">{t.planSavingsVs}</div>
                          </div>
                        )}
                      </div>

                      {/* Stale warning */}
                      {planResult.hasStaleData && (
                        <div className="mt-2 text-xs text-amber-600 bg-amber-50 rounded-lg px-3 py-2">{t.planStaleWarning}</div>
                      )}
                    </section>

                    {/* Section B: Single-store comparison */}
                    {planResult.singleStorePlans.length > 0 && (
                      <section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
                        <h3 className="text-sm font-bold text-stone-700 mb-1">{t.planSingleStoreTitle}</h3>
                        <p className="text-xs text-stone-400 mb-3">{t.planSingleStoreHint}</p>
                        <div className="space-y-2">
                          {planResult.singleStorePlans.slice(0, 5).map((sp, idx) => {
                            const diff = sp.totalCost - planResult.bestPlan.totalItemCost;
                            return (
                              <div key={idx} className="flex items-center justify-between rounded-lg border border-stone-100 bg-stone-50 px-3 py-2.5">
                                <div className="flex-1 min-w-0">
                                  <div className="text-sm font-medium text-stone-800 truncate flex items-center gap-1.5">
                                    {sp.name}
                                    {idx === 0 && <span className="text-[10px] bg-emerald-100 text-emerald-700 rounded-full px-1.5 py-0.5 font-semibold">{t.planCheapestStore}</span>}
                                  </div>
                                  {sp.distance > 0 && <div className="text-xs text-blue-500">{t.planDistanceAway(sp.distance.toFixed(1))}</div>}
                                  {diff > 0 && idx > 0 && <div className="text-xs text-stone-400">{t.planMoreExpensive(priceFormatter.format(diff))}</div>}
                                  {sp.usedEstimate && sp.missingItems.length > 0 && (
                                    <div className="text-[10px] text-amber-500">{t.planEstimateUsed(sp.missingItems.length)}</div>
                                  )}
                                </div>
                                <div className="text-sm font-bold text-stone-800 ml-3">{priceFormatter.format(sp.totalCost)} {t.planSumLabel}</div>
                              </div>
                            );
                          })}
                        </div>
                      </section>
                    )}

                    {/* Section C: Map & actions */}
                    <section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm space-y-3">
                      <h3 className="text-sm font-bold text-stone-700">{t.planMapTitle}</h3>
                      {planResult.bestPlan.stores.some(s => s.latitude && s.longitude) && (
                        <div className="rounded-xl overflow-hidden border border-stone-200" style={{ height: 200 }}>
                          <MapContainer
                            center={[
                              planResult.bestPlan.stores[0]?.latitude || 41.311,
                              planResult.bestPlan.stores[0]?.longitude || 69.279,
                            ]}
                            zoom={13}
                            style={{ height: '100%', width: '100%' }}
                            zoomControl={false}
                            attributionControl={false}
                          >
                            <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                            {userLocation && (
                              <CircleMarker center={[userLocation.lat, userLocation.lng]} radius={8} pathOptions={{ color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 0.5 }}>
                                <Popup>{t.planMyLocation}</Popup>
                              </CircleMarker>
                            )}
                            {planResult.bestPlan.stores.filter(s => s.latitude && s.longitude).map((s, i) => (
                              <CircleMarker key={i} center={[s.latitude, s.longitude]} radius={8} pathOptions={{ color: '#10b981', fillColor: '#10b981', fillOpacity: 0.7 }}>
                                <Popup>{`${i + 1}. ${s.name}`}</Popup>
                              </CircleMarker>
                            ))}
                            {(() => {
                              const points: Array<[number, number]> = [];
                              if (userLocation) points.push([userLocation.lat, userLocation.lng]);
                              for (const s of planResult.bestPlan.stores) {
                                if (s.latitude && s.longitude) points.push([s.latitude, s.longitude]);
                              }
                              return points.length >= 2 ? <Polyline positions={points} pathOptions={{ color: '#10b981', weight: 2, dashArray: '6 4' }} /> : null;
                            })()}
                          </MapContainer>
                        </div>
                      )}

                      {/* Yandex Maps link */}
                      {(() => {
                        const stores = planResult.bestPlan.stores.filter(s => s.latitude && s.longitude);
                        if (stores.length === 0) return null;
                        const originPoint = userLocation ? `${userLocation.lat},${userLocation.lng}` : '';
                        const storePoints = stores.map(s => `${s.latitude},${s.longitude}`).join('~');
                        const waypoints = originPoint ? `${originPoint}~${storePoints}` : storePoints;
                        const mapsUrl = `https://yandex.uz/maps/?rtext=${waypoints}&rtt=auto`;
                        return (
                          <a href={mapsUrl} target="_blank" rel="noopener noreferrer" className="flex items-center justify-center gap-2 w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white">
                            {t.planOpenMap}
                          </a>
                        );
                      })()}

                      {/* Copy plan button */}
                      <button
                        onClick={() => { copyPlanToClipboard(); }}
                        className="flex items-center justify-center gap-2 w-full rounded-xl border border-stone-200 bg-white px-4 py-3 text-sm font-semibold text-stone-600"
                      >
                        <Copy className="h-4 w-4" />
                        {t.planCopyPlan}
                      </button>
                    </section>

                    {/* New search button */}
                    <button
                      onClick={() => { setPlanResult(null); setPlanStep('list'); setExpandedStoreIdx(null); }}
                      className="w-full rounded-xl border border-stone-200 bg-white px-4 py-3 text-center text-sm font-semibold text-stone-600"
                    >
                      {t.planNewSearch}
                    </button>
                  </div>
                )}
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
                <section className="bg-white p-6 rounded-2xl border border-stone-200 shadow-sm space-y-5">
                  {/* City */}
                  <div className="rounded-2xl border border-emerald-100 bg-emerald-50 p-3">
                    <div className="text-xs font-semibold uppercase tracking-wider text-emerald-700">{t.cityLabel}</div>
                    <div className="mt-0.5 text-base font-bold text-emerald-900">{selectedCityLabel}</div>
                  </div>

                  {/* Store selector */}
                  <div>
                    <label className="block text-xs font-semibold text-stone-500 uppercase tracking-wider mb-2">{t.storeSelectLabel}</label>
                    <StoreSelector
                      city={selectedCity}
                      userLat={userLocation?.lat ?? null}
                      userLng={userLocation?.lng ?? null}
                      onStoreSelected={setSelectedStore}
                      selectedStore={selectedStore}
                      t={t}
                    />
                  </div>

                  {/* Items list */}
                  <div>
                    <label className="block text-xs font-semibold text-stone-500 uppercase tracking-wider mb-2">{t.itemsListLabel}</label>
                    <div className="space-y-3">
                      {reportItems.map((item) => (
                        <div key={item.id} className="flex gap-2 items-start">
                          {/* Product selector */}
                          <div className="flex-1 relative">
                            <input
                              type="text"
                              value={item.product ? getProductName(item.product, lang) : item.productQuery}
                              placeholder={t.reportProductNamePlaceholder}
                              className="w-full rounded-xl border border-stone-200 bg-stone-50 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-emerald-500"
                              onChange={e => {
                                const q = e.target.value;
                                setReportItems(items => items.map(it => it.id === item.id ? { ...it, productQuery: q, product: null, showDropdown: true } : it));
                              }}
                              onFocus={() => setReportItems(items => items.map(it => it.id === item.id ? { ...it, showDropdown: true } : it))}
                              onBlur={() => setTimeout(() => setReportItems(items => items.map(it => it.id === item.id ? { ...it, showDropdown: false } : it)), 150)}
                            />
                            {item.showDropdown && item.productQuery.trim() && (() => {
                              const q = normalizeProductNameKey(item.productQuery);
                              const hits = products.filter(p => normalizeProductNameKey([p.name_uz, p.name_ru, p.name_en, p.search_text].join(' ')).includes(q)).slice(0, 8);
                              return hits.length > 0 ? (
                                <div className="absolute left-0 right-0 top-full mt-1 z-50 max-h-48 overflow-y-auto rounded-xl border border-stone-200 bg-white shadow-xl">
                                  {hits.map(p => (
                                    <button key={p.id} type="button"
                                      className="w-full text-left px-3 py-2.5 hover:bg-stone-50 border-b border-stone-100 last:border-0"
                                      onMouseDown={e => { e.preventDefault(); setReportItems(items => items.map(it => it.id === item.id ? { ...it, product: p, productQuery: getProductName(p, lang), showDropdown: false } : it)); }}>
                                      <div className="text-sm font-medium text-stone-900">{getProductName(p, lang)}</div>
                                      <div className="text-xs text-stone-400">{getProductSecondary(p, lang)}</div>
                                    </button>
                                  ))}
                                </div>
                              ) : null;
                            })()}
                          </div>
                          {/* Price */}
                          <input
                            type="number"
                            value={item.price}
                            placeholder={t.pricePlaceholder}
                            className="w-24 rounded-xl border border-stone-200 bg-stone-50 px-3 py-2.5 text-sm font-bold outline-none focus:ring-2 focus:ring-emerald-500"
                            onChange={e => setReportItems(items => items.map(it => it.id === item.id ? { ...it, price: e.target.value } : it))}
                          />
                          {/* Remove button */}
                          {reportItems.length > 1 && (
                            <button type="button" className="py-2.5 px-1.5 text-stone-300 hover:text-rose-500"
                              onClick={() => setReportItems(items => items.filter(it => it.id !== item.id))}>
                              <X className="h-4 w-4" />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                    <button type="button"
                      onClick={() => setReportItems(items => [...items, { id: crypto.randomUUID(), product: null, productQuery: '', price: '', showDropdown: false }])}
                      className="mt-3 flex items-center gap-1.5 text-sm font-semibold text-emerald-600 hover:text-emerald-700">
                      <Plus className="h-4 w-4" /> {t.addItemBtn}
                    </button>
                  </div>

                  <button
                    disabled={submitting || !selectedStore || reportItems.every(it => !it.price || (!it.product && !it.productQuery.trim()))}
                    onClick={handleReportSubmit}
                    className="w-full bg-emerald-600 text-white py-4 rounded-xl font-bold text-lg shadow-lg shadow-emerald-200 active:scale-95 transition-all disabled:opacity-50 disabled:shadow-none"
                  >
                    {submitting ? t.submitting : `${t.submitAllBtn} (${reportItems.filter(it => it.price && (it.product || it.productQuery.trim())).length})`}
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
            {/* Row 1: Title + section tabs */}
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-lg font-semibold whitespace-nowrap">
                {
                  moderationSection === 'prices'
                    ? t.moderationTitle
                    : moderationSection === 'products'
                      ? t.productsTitle
                      : moderationSection === 'links'
                        ? t.linksTitle
                        : moderationSection === 'stores'
                          ? t.storesTab
                          : t.messagesTitle
                }
              </h2>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setModerationSection('prices')}
                  className={cn(
                    'rounded-lg px-3 py-1.5 text-xs font-semibold',
                    moderationSection === 'prices' ? 'bg-emerald-600 text-white' : 'border border-stone-200 bg-white text-stone-600'
                  )}
                >
                  {t.pricesTab}
                </button>
                <button
                  onClick={() => setModerationSection('products')}
                  className={cn(
                    'rounded-lg px-3 py-1.5 text-xs font-semibold',
                    moderationSection === 'products' ? 'bg-emerald-600 text-white' : 'border border-stone-200 bg-white text-stone-600'
                  )}
                >
                  {t.productsTab}
                </button>
                <button
                  onClick={() => setModerationSection('links')}
                  className={cn(
                    'rounded-lg px-3 py-1.5 text-xs font-semibold',
                    moderationSection === 'links' ? 'bg-emerald-600 text-white' : 'border border-stone-200 bg-white text-stone-600'
                  )}
                >
                  {t.linksTab}
                </button>
                <button
                  onClick={() => setModerationSection('messages')}
                  className={cn(
                    'rounded-lg px-3 py-1.5 text-xs font-semibold',
                    moderationSection === 'messages' ? 'bg-emerald-600 text-white' : 'border border-stone-200 bg-white text-stone-600'
                  )}
                >
                  {t.messagesTab}
                </button>
                <button
                  onClick={() => setModerationSection('stores')}
                  className={cn(
                    'rounded-lg px-3 py-1.5 text-xs font-semibold',
                    moderationSection === 'stores' ? 'bg-emerald-600 text-white' : 'border border-stone-200 bg-white text-stone-600'
                  )}
                >
                  {t.storesTab}
                </button>
                <button
                  onClick={
                    moderationSection === 'prices'
                      ? fetchModerationItems
                      : moderationSection === 'products'
                        ? fetchModerationProducts
                        : moderationSection === 'links'
                          ? fetchReceiptLinks
                          : moderationSection === 'stores'
                            ? fetchAdminStores
                            : fetchModerationMessages
                  }
                  className="rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-stone-600"
                >
                  ↻
                </button>
              </div>
            </div>

            {/* Row 2: Bulk actions (prices only) */}
            {moderationSection === 'prices' && selectedModerationIds.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-medium text-stone-500">{selectedModerationIds.length} selected:</span>
                <button
                  onClick={approveSelectedModerationItems}
                  disabled={moderationSavingId === 'bulk-approve'}
                  className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                >
                  ✓ {t.moderationApproveSelected}
                </button>
                <button
                  onClick={rejectSelectedModerationItems}
                  disabled={moderationSavingId === 'bulk-reject'}
                  className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                >
                  ✕ {t.moderationRejectSelected}
                </button>
              </div>
            )}

            {/* Row 3: Tools (prices only) */}
            {moderationSection === 'prices' && (
              <div className="space-y-2">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <button
                    onClick={handleScrapeAllStores}
                    disabled={scrapeLoadingStores.length > 0}
                    className="rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                  >
                    {scrapeLoadingStores.length === SCRAPE_STORES.length ? t.scrapeAllRunning : t.scrapeAll}
                  </button>
                  <button
                    onClick={() => handleScrapeStore('makro')}
                    disabled={scrapeLoadingStores.length > 0}
                    className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                  >
                    {scrapeLoadingStores.includes('makro') ? t.scrapeLoading : t.scrapeMakro}
                  </button>
                  <button
                    onClick={() => handleScrapeStore('korzinka')}
                    disabled={scrapeLoadingStores.length > 0}
                    className="rounded-lg bg-orange-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                  >
                    {scrapeLoadingStores.includes('korzinka') ? t.scrapeLoading : t.scrapeKorzinka}
                  </button>
                  <button
                    onClick={() => handleScrapeStore('yandex_baraka')}
                    disabled={scrapeLoadingStores.length > 0}
                    className="rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                  >
                    {scrapeLoadingStores.includes('yandex_baraka') ? t.scrapeLoading : t.scrapeYandexBaraka}
                  </button>
                  <button
                    onClick={downloadNormalizationQueueJson}
                    disabled={queueSyncing}
                    className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 disabled:opacity-50"
                  >
                    <span className="inline-flex items-center gap-1"><Download className="h-3.5 w-3.5" /> {t.queueDownload}</span>
                  </button>
                  <button
                    onClick={downloadNonNormalizedQueueJson}
                    disabled={queueSyncing}
                    className="rounded-lg border border-cyan-200 bg-cyan-50 px-3 py-1.5 text-xs font-semibold text-cyan-700 disabled:opacity-50"
                  >
                    <span className="inline-flex items-center gap-1"><Download className="h-3.5 w-3.5" /> {t.queueDownloadNonNormalized}</span>
                  </button>
                  <label className={cn("rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-700 cursor-pointer", queueSyncing && "opacity-50 pointer-events-none")}>
                    <span className="inline-flex items-center gap-1"><Upload className="h-3.5 w-3.5" /> {queueSyncing ? t.queueUploading : t.queueUpload}</span>
                    <input
                      type="file"
                      accept=".json"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) uploadNormalizationQueueJson(file);
                        e.target.value = '';
                      }}
                    />
                  </label>
                  <button
                    onClick={flushLimboToDatabase}
                    disabled={flushingLimbo}
                    className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                  >
                    {flushingLimbo ? '⏳ Flushing...' : '⚡ Flush Queue → DB'}
                  </button>
                  {scrapeResult && (
                    <span className="text-xs text-stone-500 bg-stone-100 rounded-lg px-2 py-1">
                      {scrapeResult}
                    </span>
                  )}
                  {queueStatus && (
                    <span className="text-xs text-blue-700 bg-blue-100 rounded-lg px-2 py-1">
                      {queueStatus}
                    </span>
                  )}
                </div>
              </div>
            )}

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
                        {(item.receipt_url || item.photo_url) && (
                          <a
                            href={item.receipt_url || item.photo_url || ''}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-1 inline-flex items-center gap-1 rounded-lg bg-blue-50 px-2 py-0.5 text-blue-700 underline"
                          >
                            🧾 {t.moderationReceipt}
                          </a>
                        )}
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
                      <div>
                        <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-stone-500">{t.cityLabel}</label>
                        <input
                          value={item.city ?? ''}
                          title={t.cityLabel}
                          onChange={(e) => updateModerationField(item.id, 'city', e.target.value)}
                          className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-stone-500">{t.moderationPlace}</label>
                        <input
                          value={item.place_name ?? ''}
                          title={t.moderationPlace}
                          onChange={(e) => updateModerationField(item.id, 'place_name', e.target.value)}
                          className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
                        />
                      </div>

                      {/* Scope toggle — full width */}
                      <div className="md:col-span-2">
                        <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-stone-500">{t.moderationScopeLabel}</label>
                        <div className="flex rounded-xl border border-stone-200 overflow-hidden text-sm font-semibold">
                          <button
                            type="button"
                            onClick={() => updateModerationField(item.id, 'price_scope', 'chain')}
                            className={cn(
                              'flex-1 py-2.5 transition-colors',
                              (item.price_scope ?? 'location') === 'chain'
                                ? 'bg-blue-600 text-white'
                                : 'bg-stone-50 text-stone-600 hover:bg-stone-100'
                            )}
                          >
                            🌐 {t.moderationScopeChain}
                          </button>
                          <button
                            type="button"
                            onClick={() => updateModerationField(item.id, 'price_scope', 'location')}
                            className={cn(
                              'flex-1 py-2.5 transition-colors',
                              (item.price_scope ?? 'location') === 'location'
                                ? 'bg-emerald-600 text-white'
                                : 'bg-stone-50 text-stone-600 hover:bg-stone-100'
                            )}
                          >
                            📍 {t.moderationScopeLocation}
                          </button>
                        </div>
                      </div>

                      <div className="md:col-span-2">
                        <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-stone-500">{t.moderationAddress}</label>
                        <input
                          value={item.place_address ?? ''}
                          title={t.moderationAddress}
                          onChange={(e) => updateModerationField(item.id, 'place_address', e.target.value)}
                          className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
                        />
                      </div>

                      {/* Lat/lng only needed for location scope */}
                      <div className={cn((item.price_scope ?? 'location') === 'chain' && 'opacity-40 pointer-events-none')}>
                        <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-stone-500">{t.moderationLat}</label>
                        <input
                          type="number"
                          step="0.000001"
                          value={item.latitude ?? ''}
                          title={t.moderationLat}
                          onChange={(e) => updateModerationField(item.id, 'latitude', e.target.value)}
                          className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm"
                        />
                      </div>
                      <div className={cn((item.price_scope ?? 'location') === 'chain' && 'opacity-40 pointer-events-none')}>
                        <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-stone-500">{t.moderationLng}</label>
                        <input
                          type="number"
                          step="0.000001"
                          value={item.longitude ?? ''}
                          title={t.moderationLng}
                          onChange={(e) => updateModerationField(item.id, 'longitude', e.target.value)}
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
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        onClick={selectAllApprovedItems}
                        className="rounded-xl border border-stone-200 bg-white px-3 py-2 text-xs font-medium text-stone-700"
                      >
                        {t.moderationSelectAll}
                      </button>
                      {approvedItems.some(i => i.source === 'store_api_makro') && (
                        <button
                          onClick={() => selectApprovedBySource('store_api_makro')}
                          className="rounded-xl border border-blue-300 bg-blue-50 px-3 py-2 text-xs font-medium text-blue-700"
                        >
                          Makro ({approvedItems.filter(i => i.source === 'store_api_makro').length})
                        </button>
                      )}
                      {approvedItems.some(i => i.source === 'store_api_korzinka') && (
                        <button
                          onClick={() => selectApprovedBySource('store_api_korzinka')}
                          className="rounded-xl border border-orange-300 bg-orange-50 px-3 py-2 text-xs font-medium text-orange-700"
                        >
                          Korzinka ({approvedItems.filter(i => i.source === 'store_api_korzinka').length})
                        </button>
                      )}
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
              <div className="space-y-3">
                {/* Create product form */}
                <section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm space-y-3">
                  <div className="grid gap-3 md:grid-cols-3">
                    <input value={newProductItem.name_uz} onChange={(e) => setNewProductItem(prev => ({ ...prev, name_uz: e.target.value }))} placeholder={t.productNameUz} className="w-full rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-sm" />
                    <input value={newProductItem.name_ru} onChange={(e) => setNewProductItem(prev => ({ ...prev, name_ru: e.target.value }))} placeholder={t.productNameRu} className="w-full rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-sm" />
                    <input value={newProductItem.name_en} onChange={(e) => setNewProductItem(prev => ({ ...prev, name_en: e.target.value }))} placeholder={t.productNameEn} className="w-full rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-sm" />
                    <input value={newProductItem.category} onChange={(e) => setNewProductItem(prev => ({ ...prev, category: e.target.value }))} placeholder={t.productCategory} className="w-full rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-sm" />
                    <input value={newProductItem.unit} onChange={(e) => setNewProductItem(prev => ({ ...prev, unit: e.target.value }))} placeholder={t.productUnit} className="w-full rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-sm" />
                    <input value={newProductItem.available_cities} onChange={(e) => setNewProductItem(prev => ({ ...prev, available_cities: e.target.value }))} placeholder={t.productCities} className="w-full rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-sm" />
                  </div>
                  <button onClick={createProductItem} disabled={moderationSavingId === 'create-product'} className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{t.productCreate}</button>
                </section>

                {/* Filters */}
                <section className="rounded-2xl border border-stone-200 bg-white p-3 shadow-sm space-y-2">
                  <div className="grid gap-2 md:grid-cols-3">
                    <input value={productFilterQuery} onChange={(e) => setProductFilterQuery(e.target.value)} placeholder={t.productFilterSearch} className="w-full rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-sm" />
                    <select value={productFilterCategory} onChange={(e) => setProductFilterCategory(e.target.value)} className="w-full rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-sm">
                      <option value="all">{t.productFilterCategory}: {t.allLabel}</option>
                      {productCategoryOptions.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                    <select value={productFilterCity} onChange={(e) => setProductFilterCity(e.target.value)} className="w-full rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-sm">
                      <option value="all">{t.productFilterCity}: {t.allLabel}</option>
                      {productCityOptions.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                    <select value={productFilterHasPrices} onChange={(e) => setProductFilterHasPrices(e.target.value as 'all' | 'yes' | 'no')} className="w-full rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-sm">
                      <option value="all">{t.productFilterHasPrices}: {t.allLabel}</option>
                      <option value="yes">{t.productFilterHasPrices}: {t.yesState}</option>
                      <option value="no">{t.productFilterHasPrices}: {t.noState}</option>
                    </select>
                    <select value={productFilterHasPending} onChange={(e) => setProductFilterHasPending(e.target.value as 'all' | 'yes' | 'no')} className="w-full rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-sm">
                      <option value="all">{t.productFilterHasPending}: {t.allLabel}</option>
                      <option value="yes">{t.productFilterHasPending}: {t.yesState}</option>
                      <option value="no">{t.productFilterHasPending}: {t.noState}</option>
                    </select>
                    <div className="grid grid-cols-2 gap-2">
                      <select value={productSortBy} onChange={(e) => setProductSortBy(e.target.value as 'name' | 'category' | 'price_count' | 'pending_count' | 'latest_receipt')} className="w-full rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-sm">
                        <option value="name">{t.sortName}</option>
                        <option value="category">{t.sortCategory}</option>
                        <option value="price_count">{t.sortPriceCount}</option>
                        <option value="pending_count">{t.sortPendingCount}</option>
                        <option value="latest_receipt">{t.sortLatestReceipt}</option>
                      </select>
                      <select value={productSortDir} onChange={(e) => setProductSortDir(e.target.value as 'asc' | 'desc')} className="w-full rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-sm">
                        <option value="asc">{t.productSortAsc}</option>
                        <option value="desc">{t.productSortDesc}</option>
                      </select>
                    </div>
                  </div>

                  {/* Action buttons */}
                  <div className="flex flex-wrap items-center gap-2">
                    <button onClick={selectAllFilteredProducts} className="rounded-lg border border-stone-200 bg-white px-2 py-1.5 text-xs font-medium text-stone-700">{t.productSelectAll}</button>
                    <button onClick={clearProductSelection} className="rounded-lg border border-stone-200 bg-white px-2 py-1.5 text-xs font-medium text-stone-700">{t.productClearSelection}</button>
                    <button onClick={deleteSelectedProducts} disabled={selectedProductIds.length === 0 || moderationSavingId === 'bulk-delete-products'} className="rounded-lg bg-rose-600 px-2 py-1.5 text-xs font-semibold text-white disabled:opacity-50">{t.productDeleteSelected} ({selectedProductIds.length})</button>
                    <button onClick={purgeAllProductsData} disabled={moderationSavingId === 'purge-all-products'} className="rounded-lg bg-rose-700 px-2 py-1.5 text-xs font-semibold text-white disabled:opacity-50">{t.productPurgeAll}</button>
                    <button onClick={() => downloadProductsJson(selectedProductIds.length > 0 ? selectedProductIds : undefined)} className="rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-xs font-semibold text-emerald-700 flex items-center gap-1"><Download className="w-3.5 h-3.5" /> {selectedProductIds.length > 0 ? `${t.productDownload} (${selectedProductIds.length})` : t.productDownload}</button>
                    <button onClick={downloadUnmatched} className="rounded-lg border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs font-semibold text-amber-700 flex items-center gap-1"><Download className="w-3.5 h-3.5" /> {t.downloadUnmatched}</button>
                    <label className="rounded-lg border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs font-semibold text-amber-700 flex items-center gap-1 cursor-pointer">
                      <Upload className="w-3.5 h-3.5" /> {t.uploadUnmatched}
                      <input type="file" accept=".json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadStoreProductsBatch(f); e.target.value = ''; }} />
                    </label>
                    <label className={cn("rounded-lg border border-blue-200 bg-blue-50 px-2 py-1.5 text-xs font-semibold text-blue-700 flex items-center gap-1 cursor-pointer", aliasImporting && "opacity-50 pointer-events-none")}>
                      <Upload className="w-3.5 h-3.5" /> {aliasImporting ? t.productUploading : t.productUpload}
                      <input type="file" accept=".json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadAliasesJson(f); e.target.value = ''; }} />
                    </label>
                  </div>
                </section>

                {/* Matching stats */}
                <section className="rounded-2xl border border-stone-200 bg-white p-3 shadow-sm space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-stone-700">{t.matchingStats}</span>
                    <button onClick={fetchMatchingStats} disabled={matchingStatsLoading} className="rounded border border-stone-200 bg-stone-50 px-2 py-0.5 text-xs text-stone-600 disabled:opacity-50">{matchingStatsLoading ? '...' : t.matchingStatsLoad}</button>
                  </div>
                  {matchingStats && (
                    <div className="grid grid-cols-2 gap-1 text-xs">
                      <div className="rounded-lg bg-emerald-50 px-2 py-1 flex justify-between"><span className="text-stone-600">{t.matchingStatsExact}</span><span className="font-semibold text-emerald-700">{matchingStats['exact'] || 0}</span></div>
                      <div className="rounded-lg bg-blue-50 px-2 py-1 flex justify-between"><span className="text-stone-600">{t.matchingStatsNormalised}</span><span className="font-semibold text-blue-700">{(matchingStats['normalised'] || 0)}</span></div>
                      <div className="rounded-lg bg-sky-50 px-2 py-1 flex justify-between"><span className="text-stone-600">{t.matchingStatsFuzzyHigh}</span><span className="font-semibold text-sky-700">{matchingStats['fuzzy_high'] || 0}</span></div>
                      <div className="rounded-lg bg-yellow-50 px-2 py-1 flex justify-between"><span className="text-stone-600">{t.matchingStatsFuzzyLow}</span><span className="font-semibold text-yellow-700">{matchingStats['fuzzy_low'] || 0}</span></div>
                      <div className="rounded-lg bg-stone-100 px-2 py-1 flex justify-between"><span className="text-stone-600">{t.matchingStatsConfirmed}</span><span className="font-semibold text-stone-700">{matchingStats['admin_confirmed'] || 0}</span></div>
                      <div className="rounded-lg bg-rose-50 px-2 py-1 flex justify-between"><span className="text-stone-600">{t.matchingStatsUnmatched}</span><span className="font-semibold text-rose-700">{matchingStats['unmatched'] || 0}</span></div>
                    </div>
                  )}
                </section>

                {/* Products table */}
                {productAdminLoading ? (
                  <div className="animate-pulse space-y-2">
                    {[1, 2, 3, 4].map(i => <div key={i} className="h-8 bg-stone-200 rounded" />)}
                  </div>
                ) : filteredSortedProductAdminItems.length === 0 ? (
                  <div className="rounded-2xl border border-stone-200 bg-white p-8 text-center text-stone-500">{t.productsEmpty}</div>
                ) : (() => {
                  const PAGE_SIZE = 50;
                  const totalPages = Math.ceil(filteredSortedProductAdminItems.length / PAGE_SIZE);
                  const safePage = Math.min(productTablePage, totalPages - 1);
                  const pageItems = filteredSortedProductAdminItems.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
                  return (
                    <div className="space-y-2">
                      {/* Pagination top */}
                      <div className="flex items-center justify-between text-xs text-stone-500">
                        <span>{t.productTableTotal}: {filteredSortedProductAdminItems.length} &middot; {t.productTableShowing} {safePage * PAGE_SIZE + 1}–{Math.min((safePage + 1) * PAGE_SIZE, filteredSortedProductAdminItems.length)}</span>
                        <div className="flex items-center gap-1">
                          <button disabled={safePage === 0} onClick={() => setProductTablePage(safePage - 1)} className="rounded border border-stone-200 px-2 py-1 disabled:opacity-30">{t.productTablePrev}</button>
                          <span>{t.productTablePage} {safePage + 1}{t.productTableOf}{totalPages}</span>
                          <button disabled={safePage >= totalPages - 1} onClick={() => setProductTablePage(safePage + 1)} className="rounded border border-stone-200 px-2 py-1 disabled:opacity-30">{t.productTableNext}</button>
                        </div>
                      </div>

                      <div className="rounded-xl border border-stone-200 bg-white shadow-sm overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-stone-200 bg-stone-50 text-left text-stone-600">
                              <th className="px-2 py-2 w-8"><input type="checkbox" checked={pageItems.every(i => selectedProductIds.includes(i.id))} onChange={() => { const allSelected = pageItems.every(i => selectedProductIds.includes(i.id)); setSelectedProductIds(prev => allSelected ? prev.filter(id => !pageItems.some(i => i.id === id)) : [...new Set([...prev, ...pageItems.map(i => i.id)])]); }} /></th>
                              <th className="px-2 py-2 font-semibold">{t.productTableNameUz}</th>
                              <th className="px-2 py-2 font-semibold">{t.productTableNameRu}</th>
                              <th className="px-2 py-2 font-semibold">{t.productTableNameEn}</th>
                              <th className="px-2 py-2 font-semibold">{t.productTableCategory}</th>
                              <th className="px-2 py-2 font-semibold text-center">{t.productTablePrices}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {pageItems.map(item => (
                              <tr
                                key={item.id}
                                onClick={() => setActiveProductId(item.id)}
                                className={cn('border-b border-stone-100 cursor-pointer transition-colors', activeProductId === item.id ? 'bg-emerald-50' : 'hover:bg-stone-50')}
                              >
                                <td className="px-2 py-1.5"><input type="checkbox" checked={selectedProductIds.includes(item.id)} onChange={(e) => { e.stopPropagation(); toggleProductSelection(item.id); }} onClick={(e) => e.stopPropagation()} /></td>
                                <td className="px-2 py-1.5 font-medium text-stone-900 max-w-[140px] truncate">{item.name_uz}</td>
                                <td className="px-2 py-1.5 text-stone-700 max-w-[140px] truncate">{item.name_ru}</td>
                                <td className="px-2 py-1.5 text-stone-700 max-w-[120px] truncate">{item.name_en || '-'}</td>
                                <td className="px-2 py-1.5 text-stone-600">{item.category || '-'}</td>
                                <td className="px-2 py-1.5 text-center text-stone-600">{item.price_count || 0}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      {/* Pagination bottom */}
                      <div className="flex items-center justify-end text-xs text-stone-500 gap-1">
                        <button disabled={safePage === 0} onClick={() => setProductTablePage(safePage - 1)} className="rounded border border-stone-200 px-2 py-1 disabled:opacity-30">{t.productTablePrev}</button>
                        <span>{safePage + 1}{t.productTableOf}{totalPages}</span>
                        <button disabled={safePage >= totalPages - 1} onClick={() => setProductTablePage(safePage + 1)} className="rounded border border-stone-200 px-2 py-1 disabled:opacity-30">{t.productTableNext}</button>
                      </div>
                    </div>
                  );
                })()}

                {/* Active product detail panel */}
                {activeProductItem && (
                  <section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm space-y-4">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-semibold text-stone-800">{activeProductItem.name_uz}</div>
                      <div className="flex items-center gap-2">
                        <button onClick={() => saveProductItem(activeProductItem)} disabled={moderationSavingId === activeProductItem.id} className="rounded-xl border border-stone-200 bg-stone-100 px-4 py-2 text-sm font-semibold text-stone-700 disabled:opacity-50">{t.productSave}</button>
                        <button onClick={() => deleteProductItem(activeProductItem)} disabled={moderationSavingId === activeProductItem.id} className="rounded-xl bg-rose-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{t.productDelete}</button>
                      </div>
                    </div>

                    {productDetailLoadingId === activeProductItem.id && !activeProductItem.details_loaded && (
                      <div className="rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-xs text-stone-600">
                        {t.scrapeLoading}
                      </div>
                    )}

                    <div className="grid gap-3 md:grid-cols-2">
                      <input value={activeProductItem.name_uz || ''} onChange={(e) => updateProductField(activeProductItem.id, 'name_uz', e.target.value)} placeholder={t.productNameUz} className="w-full rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-sm" />
                      <input value={activeProductItem.name_ru || ''} onChange={(e) => updateProductField(activeProductItem.id, 'name_ru', e.target.value)} placeholder={t.productNameRu} className="w-full rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-sm" />
                      <input value={activeProductItem.name_en || ''} onChange={(e) => updateProductField(activeProductItem.id, 'name_en', e.target.value)} placeholder={t.productNameEn} className="w-full rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-sm" />
                      <input value={activeProductItem.category || ''} onChange={(e) => updateProductField(activeProductItem.id, 'category', e.target.value)} placeholder={t.productCategory} className="w-full rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-sm" />
                      <input value={activeProductItem.unit || ''} onChange={(e) => updateProductField(activeProductItem.id, 'unit', e.target.value)} placeholder={t.productUnit} className="w-full rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-sm" />
                      <input value={(activeProductItem.available_cities || []).join(', ')} onChange={(e) => updateProductField(activeProductItem.id, 'available_cities', e.target.value)} placeholder={t.productCities} className="w-full rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-sm" />
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
                              <div>{price.city || '-'} &middot; {price.place_name || '-'}</div>
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
                              <div>{pendingItem.city || '-'} &middot; {pendingItem.status || 'pending'}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </section>
                )}
              </div>
            ) : moderationSection === 'links' ? (
              <div className="space-y-3">
                <section className="rounded-2xl border border-stone-200 bg-white p-3 shadow-sm space-y-3">
                  <div className="grid gap-2 md:grid-cols-3">
                    <input
                      value={receiptLinkSearch}
                      onChange={(e) => setReceiptLinkSearch(e.target.value)}
                      title={t.linksFilterSearch}
                      placeholder={t.linksFilterSearch}
                      className="w-full rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-sm"
                    />
                    <select
                      value={receiptLinkStatusFilter}
                      onChange={(e) => setReceiptLinkStatusFilter(e.target.value as 'all' | 'scanned' | 'failed' | 'unscanned')}
                      title={t.linksFilterStatus}
                      className="w-full rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-sm"
                    >
                      <option value="all">{t.linksFilterStatus}: {t.allLabel}</option>
                      <option value="unscanned">{t.linksStatusUnscanned}</option>
                      <option value="failed">{t.linksStatusFailed}</option>
                      <option value="scanned">{t.linksStatusScanned}</option>
                    </select>
                    <div className="flex items-center justify-between rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-xs text-stone-600">
                      <span>{t.productTableTotal}</span>
                      <span>{filteredReceiptLinks.length}</span>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button onClick={selectAllFilteredReceiptLinks} className="rounded-lg border border-stone-200 bg-white px-2 py-1.5 text-xs font-medium text-stone-700">{t.moderationSelectAll}</button>
                    <button onClick={clearReceiptLinkSelection} className="rounded-lg border border-stone-200 bg-white px-2 py-1.5 text-xs font-medium text-stone-700">{t.moderationClearSelection}</button>
                    <button onClick={() => updateSelectedReceiptLinksStatus('unscanned')} disabled={selectedReceiptLinkIds.length === 0 || String(moderationSavingId || '').startsWith('links-status-')} className="rounded-lg bg-amber-500 px-2 py-1.5 text-xs font-semibold text-white disabled:opacity-50">{t.linksSetUnscanned} ({selectedReceiptLinkIds.length})</button>
                    <button onClick={() => updateSelectedReceiptLinksStatus('failed')} disabled={selectedReceiptLinkIds.length === 0 || String(moderationSavingId || '').startsWith('links-status-')} className="rounded-lg bg-rose-600 px-2 py-1.5 text-xs font-semibold text-white disabled:opacity-50">{t.linksSetFailed}</button>
                    <button onClick={() => updateSelectedReceiptLinksStatus('scanned')} disabled={selectedReceiptLinkIds.length === 0 || String(moderationSavingId || '').startsWith('links-status-')} className="rounded-lg bg-emerald-600 px-2 py-1.5 text-xs font-semibold text-white disabled:opacity-50">{t.linksSetScanned}</button>
                    <button onClick={deleteSelectedReceiptLinks} disabled={selectedReceiptLinkIds.length === 0 || moderationSavingId === 'links-delete'} className="rounded-lg bg-stone-800 px-2 py-1.5 text-xs font-semibold text-white disabled:opacity-50">{t.linksDeleteSelected}</button>
                  </div>
                </section>

                {linksLoading ? (
                  <div className="animate-pulse space-y-2">
                    {[1, 2, 3, 4].map(i => <div key={i} className="h-10 bg-stone-200 rounded" />)}
                  </div>
                ) : filteredReceiptLinks.length === 0 ? (
                  <div className="rounded-2xl border border-stone-200 bg-white p-8 text-center text-stone-500">{t.linksEmpty}</div>
                ) : (
                  <div className="rounded-xl border border-stone-200 bg-white shadow-sm overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-stone-200 bg-stone-50 text-left text-stone-600">
                          <th className="px-2 py-2 w-8">
                            <input
                              type="checkbox"
                              title={t.moderationSelectAll}
                              checked={filteredReceiptLinks.length > 0 && filteredReceiptLinks.every(item => selectedReceiptLinkIds.includes(item.id))}
                              onChange={() => {
                                const allSelected = filteredReceiptLinks.length > 0 && filteredReceiptLinks.every(item => selectedReceiptLinkIds.includes(item.id));
                                setSelectedReceiptLinkIds(prev => allSelected
                                  ? prev.filter(id => !filteredReceiptLinks.some(item => item.id === id))
                                  : [...new Set([...prev, ...filteredReceiptLinks.map(item => item.id)])]
                                );
                              }}
                            />
                          </th>
                          <th className="px-2 py-2 font-semibold">URL</th>
                          <th className="px-2 py-2 font-semibold">Status</th>
                          <th className="px-2 py-2 font-semibold">Telegram</th>
                          <th className="px-2 py-2 font-semibold">{t.cityLabel}</th>
                          <th className="px-2 py-2 font-semibold">Created</th>
                          <th className="px-2 py-2 font-semibold">Error</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredReceiptLinks.map((item) => (
                          <tr key={item.id} className="border-b border-stone-100 align-top">
                            <td className="px-2 py-2">
                              <input
                                type="checkbox"
                                title={t.moderationSelectAll}
                                checked={selectedReceiptLinkIds.includes(item.id)}
                                onChange={() => toggleReceiptLinkSelection(item.id)}
                              />
                            </td>
                            <td className="px-2 py-2 max-w-70 break-all text-stone-700">{item.receipt_url || '-'}</td>
                            <td className="px-2 py-2">
                              <span className={cn(
                                'inline-flex rounded-full px-2 py-0.5 font-semibold',
                                item.pipeline_status === 'scanned'
                                  ? 'bg-emerald-100 text-emerald-700'
                                  : item.pipeline_status === 'failed'
                                    ? 'bg-rose-100 text-rose-700'
                                    : 'bg-amber-100 text-amber-800'
                              )}>
                                {item.pipeline_status === 'scanned'
                                  ? t.linksStatusScanned
                                  : item.pipeline_status === 'failed'
                                    ? t.linksStatusFailed
                                    : t.linksStatusUnscanned}
                              </span>
                            </td>
                            <td className="px-2 py-2 text-stone-600">{item.telegram_id || '-'}</td>
                            <td className="px-2 py-2 text-stone-600">{item.city || '-'}</td>
                            <td className="px-2 py-2 text-stone-600">{item.created_at ? formatDistanceToNow(new Date(item.created_at), { addSuffix: true, locale: reportLocale }) : '-'}</td>
                            <td className="px-2 py-2 max-w-55 wrap-break-word text-rose-700">{item.error_message || '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ) : moderationSection === 'stores' ? (
              <div className="space-y-3">
                {adminStoresLoading ? (
                  <div className="animate-pulse space-y-3">
                    {[1, 2, 3].map(i => <div key={i} className="h-24 bg-stone-200 rounded-xl" />)}
                  </div>
                ) : adminStores.length === 0 ? (
                  <div className="rounded-2xl border border-stone-200 bg-white p-8 text-center text-stone-500">
                    {t.storeNoUnverified}
                  </div>
                ) : (
                  adminStores.map(store => (
                    <div key={store.id} className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-semibold text-stone-900 text-sm truncate">{store.name}</div>
                          {store.address && <div className="text-xs text-stone-500 truncate">{store.address}</div>}
                          <div className="flex gap-2 mt-1 text-xs text-stone-400">
                            {store.city && <span>{store.city}</span>}
                            {store.times_submitted != null && <span>· {store.times_submitted} {t.storeTimesSubmitted}</span>}
                            {store.latitude != null && <span>· 📍 {(store.latitude as number).toFixed(4)}, {(store.longitude as number).toFixed(4)}</span>}
                          </div>
                        </div>
                        <div className="flex gap-1 shrink-0">
                          <button onClick={() => handleVerifyStore(store.id as string)}
                            className="rounded-lg bg-emerald-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700">
                            ✅ {t.storeVerify}
                          </button>
                          <button onClick={() => { setStoreMergeSourceId(storeMergeSourceId === store.id ? null : store.id as string); setStoreMergeQuery(''); setStoreMergeResults([]); }}
                            className="rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-stone-700 hover:bg-stone-50">
                            🔀 {t.storeMerge}
                          </button>
                          <button onClick={() => handleDeleteStore(store.id as string)}
                            className="rounded-lg border border-rose-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-rose-600 hover:bg-rose-50">
                            🗑 {t.storeDelete}
                          </button>
                        </div>
                      </div>
                      {storeMergeSourceId === store.id && (
                        <div className="mt-3 border-t border-stone-100 pt-3">
                          <input type="text" value={storeMergeQuery}
                            placeholder={t.storeMergeSearchPlaceholder}
                            className="w-full rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500"
                            onChange={e => searchMergeTargets(e.target.value)}
                          />
                          {storeMergeResults.filter(r => r.id !== store.id).length > 0 && (
                            <div className="mt-2 space-y-1">
                              {storeMergeResults.filter(r => r.id !== store.id).map(target => (
                                <div key={target.id} className="flex items-center justify-between gap-2 rounded-xl border border-stone-200 bg-stone-50 px-3 py-2">
                                  <div className="text-sm text-stone-900">{target.name} {target.verified && '✅'}</div>
                                  <button onClick={() => handleMergeStore(store.id as string, target.id as string)}
                                    className="rounded-lg bg-amber-500 px-2.5 py-1 text-xs font-semibold text-white">
                                    {t.storeMergeConfirm}
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))
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
        {SHOW_SHOPPING_PLAN_MENU && (
          <button 
            onClick={() => { setMode('plan'); setPlanStep('list'); }}
            className={cn("flex flex-col items-center gap-1 relative", mode === 'plan' ? "text-emerald-600" : "text-stone-400")}
          >
            <ShoppingCart className="w-6 h-6" />
            {shoppingList.length > 0 && (
              <span className="absolute -top-1 -right-1 bg-emerald-600 text-white text-[9px] font-bold rounded-full h-4 min-w-[16px] flex items-center justify-center px-1">
                {shoppingList.length}
              </span>
            )}
            <span className="text-[10px] font-bold uppercase tracking-widest">{t.modePlan}</span>
          </button>
        )}
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
        showConfirm?: (message: string, callback: (ok: boolean) => void) => void;
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
