# React Native WebView Receipt Extractor (TypeScript)

This project is a web app, but if you build a React Native wrapper, use this pattern.

It gives you exactly the 3 required parts:

1. `WebView` loads receipt URL
2. `onMessage` receives extracted products
3. `injectedJavaScript` reads `.products-tables` and posts data back

---

## 1) Install dependency

```bash
npm install react-native-webview
```

---

## 2) Minimal working component

```tsx
import React, { useMemo } from 'react';
import { Alert, View } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';

type ScrapedProduct = {
  name: string;
  quantity: string;
  price: string;
};

type Props = {
  receiptUrl: string;
  apiBaseUrl: string; // e.g. https://your-app.vercel.app
  telegramId: string;
  city: string; // e.g. Tashkent
};

const normalizeNumber = (raw: string): number => {
  const cleaned = String(raw || '').replace(/[^\d.,-]/g, '');
  if (!cleaned) return 0;
  const normalized = cleaned.includes(',') && cleaned.includes('.')
    ? cleaned.replace(/,/g, '')
    : cleaned.replace(/,/g, '.');
  const value = Number.parseFloat(normalized);
  return Number.isFinite(value) ? value : 0;
};

export default function ReceiptWebViewExtractor({
  receiptUrl,
  apiBaseUrl,
  telegramId,
  city,
}: Props) {
  const injectedJavaScript = useMemo(
    () => `
      (function() {
        function send(payload) {
          if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
            window.ReactNativeWebView.postMessage(JSON.stringify(payload));
          }
        }

        function extractRows() {
          const tableBody = document.querySelector('.products-tables tbody');
          if (!tableBody) {
            return null;
          }

          const rows = Array.from(tableBody.querySelectorAll('.products-row'));
          const products = rows.map((row) => {
            const cells = row.querySelectorAll('td');
            return {
              name: (cells[0]?.innerText || '').trim(),
              quantity: (cells[1]?.innerText || '').trim(),
              price: (cells[2]?.innerText || '').trim(),
            };
          }).filter((item) => item.name && item.price);

          return products;
        }

        function waitForTable() {
          const products = extractRows();
          if (!products) {
            setTimeout(waitForTable, 120);
            return;
          }

          send({ type: 'products', products });
        }

        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', waitForTable);
        } else {
          waitForTable();
        }
      })();
      true;
    `,
    []
  );

  const submitToApi = async (items: ScrapedProduct[]) => {
    const extractedItems = items
      .map((item) => {
        const quantity = Math.max(1, normalizeNumber(item.quantity));
        const totalPrice = normalizeNumber(item.price);
        const unitPrice = quantity > 0 ? totalPrice / quantity : totalPrice;

        return {
          name: item.name,
          quantity,
          total_price: totalPrice,
          unit_price: unitPrice,
        };
      })
      .filter((item) => item.name && item.total_price > 0);

    if (extractedItems.length === 0) {
      Alert.alert('No products', 'Could not parse product rows from receipt table.');
      return;
    }

    const response = await fetch(`${apiBaseUrl}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: receiptUrl,
        telegram_id: telegramId,
        city,
        store_name: 'Soliq receipt (react-native-webview)',
        store_address: '-',
        extracted_items: extractedItems,
      }),
    });

    const json = await response.json();
    if (!response.ok || !json?.ok) {
      throw new Error(json?.error || 'scan_submit_failed');
    }

    Alert.alert('Success', `Submitted ${json.item_count || extractedItems.length} products.`);
  };

  const onMessage = async (event: WebViewMessageEvent) => {
    try {
      const payload = JSON.parse(event.nativeEvent.data || '{}') as {
        type?: string;
        products?: ScrapedProduct[];
      };

      if (payload.type !== 'products' || !Array.isArray(payload.products)) {
        return;
      }

      await submitToApi(payload.products);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown_error';
      Alert.alert('Extraction error', message);
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <WebView
        originWhitelist={['*']}
        source={{ uri: receiptUrl }}
        javaScriptEnabled
        domStorageEnabled
        injectedJavaScript={injectedJavaScript}
        onMessage={onMessage}
      />
    </View>
  );
}
```

---

## 3) What this does

- `injectedJavaScript` waits until `.products-tables tbody` appears.
- It loops `.products-row` and extracts `name`, `quantity`, `price`.
- It sends rows via `window.ReactNativeWebView.postMessage(...)`.
- `onMessage` parses rows and posts to your backend `/api/scan` using `extracted_items`.

This matches your backend path already added in `api/scan.js` (`client_extracted`).

---

## 4) Why plain WebView alone is not enough

If you only do:

```tsx
<WebView source={{ uri: receiptUrl }} />
```

you only render the page, but never extract or return data.

You must include both:

- `injectedJavaScript`
- `onMessage`

---

## 5) Practical note

Receipt templates can vary. If one receipt format does not use `.products-row`, update selectors inside `injectedJavaScript` (for example fallback to `tbody tr`).
