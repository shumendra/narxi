import asyncio
import os
import re
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


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


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

    date_match = re.search(r'(\d{2}\.\d{2}\.\d{4})', body_text)
    if date_match:
        receipt_date = date_match.group(1)

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
        'store_name': store_name or "Noma'lum do'kon",
        'store_address': store_address,
        'receipt_date': receipt_date,
        'items': items,
    }


def get_all_products() -> list[dict]:
    result = supabase.table('products').select('id, name_uz, name_ru, name_en').execute()
    return result.data or []


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


async def process_single_receipt(page, queue_item: dict, products: list[dict]) -> bool:
    url = queue_item.get('receipt_url')
    queue_id = queue_item.get('id')
    telegram_id = queue_item.get('telegram_id') or 'anonymous'
    fallback_city = queue_item.get('city') or 'Tashkent'

    print(f"→ Processing {url}")

    try:
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
        inserted = 0

        for item in items:
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
                'receipt_date': receipt.get('receipt_date') or now_iso(),
                'source': 'soliq_qr',
                'submitted_by': telegram_id,
                'city': city,
                'status': 'pending',
            }

            result = supabase.table('pending_prices').insert(payload).execute()
            if result.data:
                inserted += 1

        supabase.table('receipts_log').insert({
            'receipt_url': url,
            'submitted_by': telegram_id,
            'item_count': len(items),
        }).execute()

        mark_queue_status(queue_id, 'processed')
        print(f"  ✓ Saved {inserted}/{len(items)} items")
        return True

    except Exception as error:
        mark_queue_status(queue_id, 'failed', str(error))
        print(f"  ✗ Error: {error}")
        return False


async def main():
    print('=' * 60)
    print('NARXI RECEIPT QUEUE WORKER')
    print('=' * 60)

    queue_result = (
        supabase.table('receipt_queue')
        .select('*')
        .eq('status', 'pending')
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
    print(f"→ Loaded {len(products)} products")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False)
        context = await browser.new_context(
            user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport={'width': 1280, 'height': 800},
            locale='en-US',
        )

        page = await context.new_page()
        success = 0
        failed = 0

        for queue_item in queue_items:
            is_ok = await process_single_receipt(page, queue_item, products)
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
