# Receipt Queue Worker (PC/Laptop)

This flow avoids server-side scraping limits by queueing QR receipt URLs and processing them from your own machine.

## 1) One-time setup

1. Run SQL from [docs/receipt-queue.sql](docs/receipt-queue.sql) in Supabase SQL editor.
2. Ensure project root has `.env` with:

```env
SUPABASE_URL=your_supabase_url
SUPABASE_KEY=your_supabase_service_role_key
```

3. Double-click [scripts/worker_setup_windows.bat](scripts/worker_setup_windows.bat).
	- This installs Python packages and Playwright Chromium.

## 2) Daily use (click-only)

1. User scans QR in Mini App.
2. App stores URL in `receipt_queue` with `status='pending'`.
3. On your PC, double-click [scripts/worker_run_windows.bat](scripts/worker_run_windows.bat).
4. Worker opens Chromium, parses queued receipts, inserts items to `pending_prices`, and updates queue status.

## 3) Optional automation (hourly)

Double-click [scripts/worker_enable_hourly_windows.bat](scripts/worker_enable_hourly_windows.bat).

- Creates scheduled task: `NarxiReceiptWorkerHourly`
- Runs worker every hour

## 4) What “success” means

After running worker:

- `receipt_queue.status` becomes `processed` (or `failed` with `error_message`)
- New rows appear in `pending_prices`
- New rows appear in `receipts_log`

## 5) Troubleshooting

- If setup fails: rerun [scripts/worker_setup_windows.bat](scripts/worker_setup_windows.bat).
- If scheduled task fails: run [scripts/worker_enable_hourly_windows.bat](scripts/worker_enable_hourly_windows.bat) as Administrator.
- If no rows process: confirm users actually scanned and rows exist in `receipt_queue` with `pending` status.

