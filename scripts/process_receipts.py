import asyncio
import json
import os
import re
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from bs4 import BeautifulSoup
from dotenv import load_dotenv
from playwright.async_api import async_playwright
from supabase import create_client
from thefuzz import fuzz

load_dotenv()

SUPABASE_URL = os.getenv('SUPABASE_URL', '')
SUPABASE_KEY = os.getenv('SUPABASE_KEY', '')

if not SUPABASE_URL or not SUPABASE_KEY:
    raise RuntimeError('Missing SUPABASE_URL or SUPABASE_KEY in environment')

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

CITY_MAP = {
    'Tashkent': ['toshkent', 'ташкент'],
    'Samarkand': ['samarqand', 'самарканд'],
    'Bukhara': ['buxoro', 'бухара'],
    'Namangan': ['namangan', 'наманган'],
    'Andijan': ['andijon', 'андижан'],
    'Fergana': ["farg'ona", 'fargona', 'фергана'],
    'Qarshi': ['qarshi', 'карши'],
    'Nukus': ['nukus', 'нукус'],
    'Termiz': ['termiz', 'термез'],
    'Jizzakh': ['jizzax', 'джизак'],
}

SKIP_KEYWORDS = [
    'jami', 'итого', 'qqs', 'ндс', 'chegirma', 'скидка',
    'naqd', 'наличн', 'bank', 'банк', 'shtrix', 'mxik', "o'lchov"
]

CITY_CENTERS = {
    'Tashkent': (41.2995, 69.2401),
    'Samarkand': (39.6542, 66.9597),
    'Bukhara': (39.7747, 64.4286),
    'Namangan': (41.0000, 71.6726),
    'Andijan': (40.7833, 72.3500),
    'Fergana': (40.3842, 71.7843),
    'Qarshi': (38.8606, 65.7891),
    'Nukus': (42.4600, 59.6200),
    'Termiz': (37.2242, 67.2783),
    'Jizzakh': (40.1158, 67.8422),
}

STORE_BRANDS = {
    'Korzinka': ['korzinka', 'korzинка'],
    'Makro': ['makro'],
    'Yaponamama': ['yaponamama', 'японамама'],
    'Havas': ['havas'],
    'Baraka Market': ['baraka'],
    'Carrefour': ['carrefour'],
}

_GEOCODE_CACHE: dict[str, tuple[float | None, float | None]] = {}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_receipt_date(raw_value: str | None) -> str:
    value = (raw_value or '').strip()
    if not value:
        return now_iso()

    datetime_match = re.fullmatch(r'(\d{2})\.(\d{2})\.(\d{4}),?\s*(\d{2}):(\d{2})', value)
    if datetime_match:
        day, month, year, hour, minute = datetime_match.groups()
        try:
            return datetime(
                int(year),
                int(month),
                int(day),
                int(hour),
                int(minute),
                tzinfo=timezone.utc,
            ).isoformat()
        except Exception:
            return now_iso()

    if re.fullmatch(r'\d{2}\.\d{2}\.\d{4}', value):
        day, month, year = value.split('.')
        try:
            return datetime(int(year), int(month), int(day), tzinfo=timezone.utc).isoformat()
        except Exception:
            return now_iso()

    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(timezone.utc).isoformat()
    except Exception:
        return now_iso()


def extract_city(address: str | None) -> str:
    if not address:
        return 'Tashkent'
    lower = address.lower()
    for city, variants in CITY_MAP.items():
        if any(v in lower for v in variants):
            return city
    return 'Tashkent'


def normalize_num(raw: str) -> float:
    cleaned = re.sub(r'[^\d.,]', '', (raw or '').replace(' ', '')).replace(',', '.')
    if cleaned.count('.') > 1:
        parts = cleaned.split('.')
        cleaned = ''.join(parts[:-1]) + '.' + parts[-1]
    try:
        return float(cleaned)
    except Exception:
        return 0.0


def geocode_address(address: str | None, city: str | None) -> tuple[float | None, float | None]:
    city_name = city or 'Tashkent'
    key = f"{address or ''}|{city_name}"
    if key in _GEOCODE_CACHE:
        return _GEOCODE_CACHE[key]

    query_parts = []
    if address:
        query_parts.append(address.strip())
    if city_name:
        query_parts.append(city_name)
    query_parts.append('Uzbekistan')
    query = ', '.join([part for part in query_parts if part])

    if not query.strip():
        _GEOCODE_CACHE[key] = (None, None)
        return _GEOCODE_CACHE[key]

    try:
        params = urllib.parse.urlencode({'q': query, 'format': 'json', 'limit': 1})
        request = urllib.request.Request(
            f"https://nominatim.openstreetmap.org/search?{params}",
            headers={
                'User-Agent': 'narxi-receipt-worker/1.0 (receipt geocoding)'
            },
        )
        with urllib.request.urlopen(request, timeout=15) as response:
            payload = json.loads(response.read().decode('utf-8'))
            if isinstance(payload, list) and len(payload) > 0:
                lat = float(payload[0].get('lat'))
                lon = float(payload[0].get('lon'))
                _GEOCODE_CACHE[key] = (lat, lon)
                return _GEOCODE_CACHE[key]
    except Exception:
        pass

    fallback = CITY_CENTERS.get(city_name, (None, None))
    _GEOCODE_CACHE[key] = fallback
    return fallback


def normalize_store_name(raw_name: str | None, raw_address: str | None) -> str:
    combined = f"{raw_name or ''} {raw_address or ''}".lower()
    for brand, keywords in STORE_BRANDS.items():
        if any(keyword in combined for keyword in keywords):
            return brand
    return (raw_name or "Noma'lum do'kon").strip() or "Noma'lum do'kon"


def parse_receipt_html(html_content: str) -> dict:
    soup = BeautifulSoup(html_content or '', 'html.parser')

    store_name = ''
    store_address = ''
    receipt_date = ''
    items = []

    for tag in soup.find_all(['b', 'strong']):
        text = tag.get_text(strip=True)
        if 5 < len(text) < 200:
            store_name = text
            break

    body_text = soup.get_text(separator='\n')
    for line in body_text.split('\n'):
        value = line.strip()
        if len(value) < 10:
            continue
        if any(kw in value.lower() for kw in ["ko'cha", 'тумани', 'улица', 'район', 'mfy', 'мфй', 'shahri']):
            store_address = value
            break

    date_match = re.search(r'(\d{2}\.\d{2}\.\d{4},\s*\d{2}:\d{2})', body_text)
    if not date_match:
        date_match = re.search(r'(\d{2}\.\d{2}\.\d{4})', body_text)
    if date_match:
        receipt_date = date_match.group(1)

    latitude = None
    longitude = None
    coord_match = re.search(r'Placemark\s*\(\s*\[\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*\]', html_content)
    if coord_match:
        try:
            latitude = float(coord_match.group(1))
            longitude = float(coord_match.group(2))
        except Exception:
            latitude = None
            longitude = None

    for table in soup.find_all('table'):
        first_row = table.find('tr')
        if not first_row:
            continue

        first_row_text = first_row.get_text().lower()
        if not any(kw in first_row_text for kw in ['nomi', 'narxi', 'наименование', 'цена']):
            continue

        header_cells = first_row.find_all(['th', 'td'])
        name_col, qty_col, price_col = 0, 1, 2

        for i, cell in enumerate(header_cells):
            text = cell.get_text().lower().strip()
            if 'nom' in text or 'наим' in text:
                name_col = i
            elif 'son' in text or 'кол' in text:
                qty_col = i
            elif 'narx' in text or 'цен' in text or 'сум' in text:
                price_col = i

        rows = table.find_all('tr')[1:]
        for row in rows:
            cells = row.find_all('td')
            if len(cells) < 2:
                continue

            def cell_text(idx: int) -> str:
                if idx < len(cells):
                    return cells[idx].get_text(strip=True)
                return ''

            raw_name = cell_text(name_col)
            raw_qty = cell_text(qty_col)
            raw_price = cell_text(price_col)

            if not raw_name or len(raw_name) < 2:
                continue
            if any(kw in raw_name.lower() for kw in SKIP_KEYWORDS):
                continue

            price = normalize_num(raw_price)
            qty = normalize_num(raw_qty)
            if qty <= 0:
                qty = 1.0

            if price <= 0:
                continue

            items.append({
                'name': raw_name,
                'price': round(price),
                'quantity': qty,
                'unit_price': round(price / qty) if qty > 0 else round(price),
            })

        if items:
            break

    return {
        'store_name': normalize_store_name(store_name, store_address),
        'store_address': store_address,
        'receipt_date': receipt_date,
        'latitude': latitude,
        'longitude': longitude,
        'items': items,
    }


def get_all_products() -> list[dict]:
    result = supabase.table('products').select('id, name_uz, name_ru, name_en, search_text').execute()
    return result.data or []


def get_all_aliases() -> list[dict]:
    result = supabase.table('product_aliases').select('product_id, alias_text, store_name').execute()
    return result.data or []


def alias_exact_match(raw_name: str, store_name: str | None, aliases: list[dict]) -> str | None:
    normalized_raw = (raw_name or '').strip().lower()
    normalized_store = (store_name or '').strip().lower()
    if not normalized_raw:
        return None

    # Prefer store-specific aliases first.
    for alias in aliases:
        if (alias.get('store_name') or '').strip().lower() != normalized_store:
            continue
        if (alias.get('alias_text') or '').strip().lower() == normalized_raw:
            return alias.get('product_id')

    # Fall back to global aliases.
    for alias in aliases:
        if alias.get('store_name'):
            continue
        if (alias.get('alias_text') or '').strip().lower() == normalized_raw:
            return alias.get('product_id')

    return None


def upsert_product_alias(product_id: str | None, alias_text: str, store_name: str | None = None):
    if not product_id or not alias_text.strip():
        return

    normalized_alias = alias_text.strip()
    normalized_store = (store_name or '').strip() or None

    existing = (
        supabase.table('product_aliases')
        .select('id,times_seen')
        .eq('product_id', product_id)
        .ilike('alias_text', normalized_alias)
        .is_('store_name', normalized_store)
        .limit(1)
        .execute()
    )

    rows = existing.data or []
    if rows:
        alias_id = rows[0].get('id')
        times_seen = int(rows[0].get('times_seen') or 1)
        supabase.table('product_aliases').update({'times_seen': times_seen + 1}).eq('id', alias_id).execute()
        return

    language = 'ru' if re.search(r'[\u0400-\u04FF]', normalized_alias) else 'uz'
    supabase.table('product_aliases').insert({
        'product_id': product_id,
        'alias_text': normalized_alias,
        'language': language,
        'store_name': normalized_store,
        'times_seen': 1,
    }).execute()


def fuzzy_match(raw_name: str, products: list[dict]) -> tuple[dict | None, int]:
    best_match = None
    best_score = 0
    lower_raw = (raw_name or '').lower()

    for product in products:
        for field in ['name_uz', 'name_ru', 'name_en']:
            target = (product.get(field) or '').lower()
            if not target:
                continue
            score = fuzz.partial_ratio(lower_raw, target)
            if score > best_score:
                best_score = score
                best_match = product

    return best_match, best_score


def mark_queue_status(queue_id: str, status: str, error_message: str | None = None):
    payload = {
        'status': status,
        'processed_at': now_iso(),
    }
    if error_message:
        payload['error_message'] = error_message[:500]

    supabase.table('receipt_queue').update(payload).eq('id', queue_id).execute()


def item_exists_already(payload: dict) -> bool:
    receipt_url = payload.get('receipt_url')
    product_name_raw = payload.get('product_name_raw')
    place_name = payload.get('place_name')
    place_address = payload.get('place_address')
    receipt_date = payload.get('receipt_date')
    unit_price = payload.get('unit_price')
    city = payload.get('city')

    pending_query = (
        supabase.table('pending_prices')
        .select('id')
        .eq('receipt_url', receipt_url)
        .eq('product_name_raw', product_name_raw)
        .eq('place_name', place_name)
        .eq('place_address', place_address)
        .eq('receipt_date', receipt_date)
        .eq('unit_price', unit_price)
        .eq('city', city)
        .limit(1)
        .execute()
    )
    if pending_query.data:
        return True

    approved_query = (
        supabase.table('prices')
        .select('id')
        .eq('product_name_raw', product_name_raw)
        .eq('place_name', place_name)
        .eq('place_address', place_address)
        .eq('receipt_date', receipt_date)
        .eq('price', unit_price)
        .eq('city', city)
        .limit(1)
        .execute()
    )
    return bool(approved_query.data)


async def process_single_receipt(context, queue_item: dict, products: list[dict], aliases: list[dict]) -> bool:
    url = queue_item.get('receipt_url')
    queue_id = queue_item.get('id')
    telegram_id = queue_item.get('telegram_id') or 'anonymous'
    fallback_city = queue_item.get('city') or 'Tashkent'

    print(f"→ Processing {url}")

    page = None
    try:
        page = await context.new_page()
        await page.goto(url, wait_until='networkidle', timeout=45000)
        await asyncio.sleep(1.5)

        html_content = await page.content()
        receipt = parse_receipt_html(html_content)

        items = receipt.get('items') or []
        if not items:
            mark_queue_status(queue_id, 'failed', 'No items parsed from page')
            print('  ✗ No items parsed')
            return False

        city = extract_city(receipt.get('store_address')) or fallback_city
        latitude = receipt.get('latitude')
        longitude = receipt.get('longitude')
        if latitude is None or longitude is None:
            latitude, longitude = geocode_address(receipt.get('store_address'), city)
        inserted = 0

        product_by_id = {p.get('id'): p for p in products}

        for item in items:
            matched_product = None
            confidence = 0

            alias_product_id = alias_exact_match(item['name'], receipt.get('store_name'), aliases)
            if alias_product_id and alias_product_id in product_by_id:
                matched_product = product_by_id[alias_product_id]
                confidence = 100
            else:
                matched_product, confidence = fuzzy_match(item['name'], products)

            payload = {
                'product_name_raw': item['name'],
                'product_id': matched_product['id'] if matched_product and confidence >= 60 else None,
                'match_confidence': confidence,
                'price': item['price'],
                'quantity': item['quantity'],
                'unit_price': item['unit_price'],
                'place_name': receipt.get('store_name') or "Noma'lum do'kon",
                'place_address': receipt.get('store_address') or '',
                'receipt_url': url,
                'receipt_date': normalize_receipt_date(receipt.get('receipt_date')),
                'source': 'soliq_qr',
                'submitted_by': telegram_id,
                'city': city,
                'latitude': latitude,
                'longitude': longitude,
                'status': 'pending',
            }

            if item_exists_already(payload):
                continue

            result = supabase.table('pending_prices').insert(payload).execute()
            if result.data:
                inserted += 1
                if payload.get('product_id'):
                    upsert_product_alias(payload.get('product_id'), item['name'], receipt.get('store_name'))

        supabase.table('receipt_queue').delete().eq('id', queue_id).execute()
        print(f"  ✓ Saved {inserted}/{len(items)} items")
        return True

    except Exception as error:
        mark_queue_status(queue_id, 'failed', str(error))
        print(f"  ✗ Error: {error}")
        return False
    finally:
        if page is not None:
            await page.close()


async def main():
    print('=' * 60)
    print('NARXI RECEIPT QUEUE WORKER')
    print('=' * 60)

    queue_result = (
        supabase.table('receipt_queue')
        .select('*')
        .in_('status', ['pending', 'failed'])
        .order('created_at')
        .limit(100)
        .execute()
    )

    queue_items = queue_result.data or []
    if not queue_items:
        print('✓ No pending queue items')
        return

    print(f"→ Found {len(queue_items)} pending receipts")
    products = get_all_products()
    aliases = get_all_aliases()
    print(f"→ Loaded {len(products)} products")
    print(f"→ Loaded {len(aliases)} product aliases")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False)
        context = await browser.new_context(
            user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport={'width': 1280, 'height': 800},
            locale='en-US',
        )

        success = 0
        failed = 0

        for queue_item in queue_items:
            try:
                is_ok = await asyncio.wait_for(
                    process_single_receipt(context, queue_item, products, aliases),
                    timeout=120,
                )
            except asyncio.TimeoutError:
                mark_queue_status(queue_item.get('id'), 'failed', 'Processing timeout (120s)')
                print(f"→ Processing {queue_item.get('receipt_url')}\n  ✗ Error: Processing timeout (120s)")
                is_ok = False

            if is_ok:
                success += 1
            else:
                failed += 1
            await asyncio.sleep(2)

        await browser.close()

    print('=' * 60)
    print(f'✓ Done: {success} processed, {failed} failed')
    print('=' * 60)


if __name__ == '__main__':
    asyncio.run(main())
