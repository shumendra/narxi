/**
 * Shared normalisation utilities for product name matching.
 * Import from both scrape-stores.js and matcher.js.
 */

export function normaliseName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()'"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenSortName(name) {
  return normaliseName(name)
    .split(' ')
    .filter(w => w.length > 0)
    .sort()
    .join(' ');
}

/**
 * Standardise source names to a canonical form used in store_products.source.
 * The existing prices.source uses 'store_api_korzinka' format — those stay unchanged.
 * store_products.source uses the short canonical form: 'korzinka_api', 'makro_api', etc.
 */
export function normaliseSource(storeIdentifier) {
  const id = String(storeIdentifier || '').toLowerCase();
  const map = {
    'korzinka': 'korzinka_api',
    'korzinka_api': 'korzinka_api',
    'makro': 'makro_api',
    'makro_api': 'makro_api',
    'baraka': 'baraka_api',
    'yandex_baraka': 'baraka_api',
    'baraka_api': 'baraka_api',
    'receipt': 'receipt',
    'soliq_qr': 'receipt',
    'manual': 'manual',
    'website_scrape': 'scrape',
  };
  // Fall back: strip yandex_ prefix and append _api
  if (map[id]) return map[id];
  if (id.startsWith('yandex_')) return `${id.replace(/^yandex_/, '')}_api`;
  return id;
}
