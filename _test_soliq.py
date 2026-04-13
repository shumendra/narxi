import sys
sys.path.insert(0, 'scripts')

import requests
from process_receipts import parse_receipt_html

url = 'https://ofd.soliq.uz/check'
params = {'t': 'LG420230642268', 'r': '84474', 'c': '20260320212103', 's': '301650603100'}
headers = {'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html', 'Accept-Language': 'ru'}

session = requests.Session()
session.get('https://ofd.soliq.uz', headers=headers)
response = session.get(url, params=params, headers=headers)

result = parse_receipt_html(response.text)
print(f"Store: {result['store_name']}")
print(f"Address: {result['store_address']}")
print(f"Date: {result['receipt_date']}")
print(f"Lat: {result['latitude']}, Lng: {result['longitude']}")
print(f"Items: {len(result['items'])}")
print()
for item in result['items'][:10]:
    print(f"  {item['name']}: {item['price']} x{item['quantity']} = {item['unit_price']}")
