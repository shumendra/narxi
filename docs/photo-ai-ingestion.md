# Photo AI Ingestion to pending_prices

This script extracts receipt items from a photo and inserts them into `pending_prices` for moderator approval.

## 1) Install dependencies

```bash
pip install -r scripts/requirements-photo-ai.txt
```

## 2) Required environment variables

- `OPENAI_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (recommended) or `SUPABASE_ANON_KEY`

## 3) Dry-run (parse only)

```bash
python scripts/photo_to_pending_ai.py --image "C:/path/to/receipt.jpg" --dry-run
```

## 4) Insert into moderation queue

```bash
python scripts/photo_to_pending_ai.py --image "C:/path/to/receipt.jpg" --city Tashkent --telegram-id 7240925672
```

## Notes

- Rows are inserted with `status=pending`, `match_confidence=0`, and `source=photo_ai`.
- Product canonicalization still happens in your moderation and approval flow.
- If OCR quality is poor, use a higher quality image and rerun.
