# Receipt Queue Worker (PC/Laptop)

This flow avoids server-side scraping limits by queueing QR receipt URLs and processing them from your own machine.

## 1) Create queue table
Run SQL from [docs/receipt-queue.sql](docs/receipt-queue.sql) in Supabase SQL editor.

## 2) Mini App behavior
`/api/scan` now only validates + inserts into `receipt_queue`.

- Scan URL
- Store in `receipt_queue` with `status='pending'`
- Show immediate success to user

## 3) Python worker setup
Create a local `.env` next to `scripts/process_receipts.py`:

```env
SUPABASE_URL=your_supabase_url
SUPABASE_KEY=your_supabase_service_role_key
```

Install dependencies:

```bash
pip install -r scripts/requirements-receipt-worker.txt
playwright install chromium
```

Run manually:

```bash
python scripts/process_receipts.py
```

## 4) Processing logic
Worker reads pending rows from `receipt_queue`, opens each URL in Playwright Chromium, parses receipt HTML, writes products to `pending_prices`, logs into `receipts_log`, and marks queue row:

- `status='processed'` on success
- `status='failed'` with `error_message` on failure

## 5) Automation later
Early stage: run manually 1-2 times/day.
Later: use Windows Task Scheduler or cron to run hourly.

