// Server-side proxy that returns branch coordinates for the supported chains.
// The chain APIs (Korzinka in particular) restrict CORS to their own origin, so
// the Mini App cannot fetch them directly from the browser. This endpoint runs
// the same requests server-side (no CORS) and returns a flat, deduplicated list
// of { name, lat, lng } that the client uses to map chain-wide prices to branches.

const MAKRO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  'Accept': 'application/json',
  'Accept-Language': 'ru',
  'Origin': 'https://makromarket.uz',
  'Referer': 'https://makromarket.uz/',
};

const KORZINKA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  'Accept': 'application/json',
  'Origin': 'https://korzinka.uz',
  'Referer': 'https://korzinka.uz/',
};

const BARAKA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Origin': 'https://barakamarket.uz',
  'Referer': 'https://barakamarket.uz/',
};

function send(res, status, body) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json');
  // Cache at the edge for a day — branch coordinates change very rarely.
  res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400');
  res.send(JSON.stringify(body));
}

async function fetchMakroStores() {
  const stores = [];
  const regions = Array.from({ length: 14 }, (_, idx) => idx + 1);
  const results = await Promise.all(regions.map((region) =>
    fetch(`https://api.makromarket.uz/api/location-list/?region=${region}`, { headers: MAKRO_HEADERS })
      .then((r) => r.json())
      .catch(() => [])
  ));
  for (const data of results) {
    if (!Array.isArray(data)) continue;
    for (const s of data) {
      const lat = parseFloat(s.latitude);
      const lng = parseFloat(s.longitude);
      if (lat && lng) stores.push({ chain: 'makro', name: s.title || 'Makro', lat, lng });
    }
  }
  return stores;
}

async function fetchKorzinkaStores() {
  const stores = [];
  try {
    const res = await fetch(
      'https://api.korzinka.uz/shop_search/?q=&category[]=66&category[]=64',
      { headers: KORZINKA_HEADERS }
    );
    const data = await res.json();
    const items = data?.data?.items?.ru || data?.data?.items?.uz || [];
    for (const s of items) {
      const loc = s.location || {};
      const lat = parseFloat(loc.lat);
      const lng = parseFloat(loc.lon);
      if (lat && lng) stores.push({ chain: 'korzinka', name: s.name || 'Korzinka', lat, lng });
    }
  } catch { /* skip on failure */ }
  return stores;
}

async function fetchBarakaStores() {
  const stores = [];
  try {
    const res = await fetch('https://backend.barakamarket.uz/shop/', { headers: BARAKA_HEADERS });
    const payload = await res.json();
    const rows = Array.isArray(payload)
      ? payload
      : (Array.isArray(payload?.results) ? payload.results : []);
    for (const row of rows) {
      let lat = parseFloat(String(row?.latitude ?? row?.lat ?? '0'));
      let lng = parseFloat(String(row?.longitude ?? row?.lng ?? row?.lon ?? '0'));
      // Baraka may return latitude/longitude swapped for some rows.
      if (Math.abs(lat) > 55 && Math.abs(lng) < 55) {
        const tmp = lat;
        lat = lng;
        lng = tmp;
      }
      if (lat && lng) {
        const title = String(row?.title || row?.name || '').trim();
        stores.push({ chain: 'baraka', name: title ? `Baraka Market ${title}` : 'Baraka Market', lat, lng });
      }
    }
  } catch { /* skip on failure */ }
  return stores;
}

export default async function stores(_req, res) {
  try {
    const [makro, korzinka, baraka] = await Promise.all([
      fetchMakroStores().catch(() => []),
      fetchKorzinkaStores().catch(() => []),
      fetchBarakaStores().catch(() => []),
    ]);

    const all = [...makro, ...korzinka, ...baraka];

    // Deduplicate by rounded coordinates.
    const seen = new Set();
    const deduped = all.filter((s) => {
      if (!s.lat || !s.lng) return false;
      const key = `${s.lat.toFixed(4)},${s.lng.toFixed(4)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return send(res, 200, { ok: true, stores: deduped });
  } catch (error) {
    return send(res, 200, { ok: false, error: String(error?.message || error), stores: [] });
  }
}
