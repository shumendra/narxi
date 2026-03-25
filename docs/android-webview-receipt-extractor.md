# Android WebView Receipt Extractor (works with current `/api/scan`)

This is a minimal **native Android** approach (no Flutter required) that:

1. Opens `https://ofd.soliq.uz/check?...` in a `WebView`
2. Injects JavaScript after page load
3. Extracts products from `.products-tables`
4. Sends JSON to your existing backend `POST /api/scan` using `extracted_items`

Your backend already supports this (`client_extracted` path in `api/scan.js`).

---

## 1) Android permissions

In `AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.INTERNET" />
```

---

## 2) Activity layout

`res/layout/activity_receipt_webview.xml`

```xml
<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:orientation="vertical">

    <Button
        android:id="@+id/btnExtract"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:text="Extract & Submit" />

    <WebView
        android:id="@+id/webView"
        android:layout_width="match_parent"
        android:layout_height="0dp"
        android:layout_weight="1" />

</LinearLayout>
```

---

## 3) Kotlin Activity

`ReceiptWebViewActivity.kt`

```kotlin
package com.example.receiptextractor

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class ReceiptWebViewActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var btnExtract: Button

    // Replace with your deployed API base (Vercel domain)
    private val apiBase = "https://YOUR-VERCEL-DOMAIN.vercel.app"

    // Replace with actual values from your app session
    private val telegramId = "123456789"
    private val selectedCity = "Tashkent"

    private val client = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_receipt_webview)

        webView = findViewById(R.id.webView)
        btnExtract = findViewById(R.id.btnExtract)

        val receiptUrl = intent.getStringExtra("receipt_url")
            ?: "https://ofd.soliq.uz/check?t=...&r=...&c=...&s=..."

        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.userAgentString = webView.settings.userAgentString + " NarxiNative/1.0"
        webView.webChromeClient = WebChromeClient()
        webView.webViewClient = object : WebViewClient() {}

        webView.addJavascriptInterface(NativeBridge(), "AndroidBridge")
        webView.loadUrl(receiptUrl)

        btnExtract.setOnClickListener {
            injectExtractionScript()
        }
    }

    private fun injectExtractionScript() {
        val js = """
            (function() {
              try {
                function num(raw) {
                  if (!raw) return 0;
                  var s = String(raw).replace(/[^\d.,-]/g, '');
                  if (s.indexOf(',') >= 0 && s.indexOf('.') >= 0) s = s.replace(/,/g, '');
                  else s = s.replace(/,/g, '.');
                  var v = parseFloat(s);
                  return isNaN(v) ? 0 : v;
                }

                var table = document.querySelector('.products-tables') || document.querySelector('table');
                if (!table) {
                  AndroidBridge.onExtracted(JSON.stringify({ ok:false, error:'table_not_found' }));
                  return;
                }

                var rows = Array.from(table.querySelectorAll('tbody tr'));
                if (!rows.length) {
                  rows = Array.from(table.querySelectorAll('tr')).slice(1);
                }

                var items = [];
                rows.forEach(function(row) {
                  var cells = Array.from(row.querySelectorAll('td,th')).map(function(c){ return c.innerText.trim(); });
                  if (cells.length < 2) return;

                  var name = cells[0] || '';
                  var qty = num(cells[1]);
                  var price = num(cells[cells.length - 1]);

                  if (name && price > 0) {
                    items.push({
                      name: name,
                      quantity: qty > 0 ? qty : 1,
                      total_price: price,
                      unit_price: qty > 0 ? (price / qty) : price
                    });
                  }
                });

                var storeName = '';
                var storeEl = document.querySelector('.company-name, .store-name, h1, h2');
                if (storeEl) storeName = (storeEl.innerText || '').trim();

                AndroidBridge.onExtracted(JSON.stringify({
                  ok: true,
                  store_name: storeName || 'Soliq receipt (webview)',
                  store_address: '-',
                  receipt_date: '',
                  extracted_items: items
                }));
              } catch (e) {
                AndroidBridge.onExtracted(JSON.stringify({ ok:false, error:'js_exception', detail:String(e) }));
              }
            })();
        """.trimIndent()

        webView.evaluateJavascript(js, null)
    }

    inner class NativeBridge {
        @JavascriptInterface
        fun onExtracted(payload: String) {
            try {
                val json = JSONObject(payload)
                val ok = json.optBoolean("ok", false)
                if (!ok) {
                    runOnUiThread {
                        Toast.makeText(this@ReceiptWebViewActivity, "Extract failed: ${json.optString("error")}", Toast.LENGTH_LONG).show()
                    }
                    return
                }

                val body = JSONObject().apply {
                    put("url", webView.url ?: "")
                    put("telegram_id", telegramId)
                    put("city", selectedCity)
                    put("store_name", json.optString("store_name", "Soliq receipt (webview)"))
                    put("store_address", json.optString("store_address", "-"))
                    put("receipt_date", json.optString("receipt_date", ""))
                    put("extracted_items", json.optJSONArray("extracted_items") ?: JSONArray())
                }

                submitToApi(body)
            } catch (e: Exception) {
                runOnUiThread {
                    Toast.makeText(this@ReceiptWebViewActivity, "Bridge error: ${e.message}", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    private fun submitToApi(body: JSONObject) {
        Thread {
            try {
                val mediaType = "application/json; charset=utf-8".toMediaType()
                val request = Request.Builder()
                    .url("$apiBase/api/scan")
                    .post(body.toString().toRequestBody(mediaType))
                    .build()

                val response = client.newCall(request).execute()
                val responseText = response.body?.string().orEmpty()

                runOnUiThread {
                    Toast.makeText(
                        this,
                        if (response.isSuccessful) "Submitted: $responseText" else "API error: $responseText",
                        Toast.LENGTH_LONG
                    ).show()
                }
            } catch (e: Exception) {
                runOnUiThread {
                    Toast.makeText(this, "Submit failed: ${e.message}", Toast.LENGTH_LONG).show()
                }
            }
        }.start()
    }
}
```

---

## 4) Required dependency

In `app/build.gradle`:

```gradle
dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
```

---

## 5) Launch this screen

From your current app flow, pass scanned URL:

```kotlin
val intent = Intent(this, ReceiptWebViewActivity::class.java)
intent.putExtra("receipt_url", scannedUrl)
startActivity(intent)
```

---

## 6) Payload sent to your backend

```json
{
  "url": "https://ofd.soliq.uz/check?t=...&r=...&c=...&s=...",
  "telegram_id": "123456789",
  "city": "Tashkent",
  "store_name": "...",
  "store_address": "...",
  "receipt_date": "...",
  "extracted_items": [
    {
      "name": "...",
      "quantity": 1,
      "total_price": 15000,
      "unit_price": 15000
    }
  ]
}
```

This is already accepted by current `api/scan.js` (`client_extracted` path).

---

## Notes

- This works because extraction runs in a **real mobile browser engine context**.
- Selector differences may occur across receipt templates; update query selectors in JS if needed.
- If OFD blocks debug tools or changes markup, keep the fallback of manually sending `raw_html` (already supported).
