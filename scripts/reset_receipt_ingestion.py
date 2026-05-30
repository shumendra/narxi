"""
Reset receipt ingestion: delete all soliq_qr price rows (which may have
stale/incorrect store names) and re-queue every receipt for reprocessing
with the fixed parser.

Run once, then run:  python process_receipts.py
"""
import os

from dotenv import load_dotenv
from supabase import create_client

load_dotenv()

supabase = create_client(os.getenv('SUPABASE_URL', ''), os.getenv('SUPABASE_KEY', ''))


def main():
    # 1. Delete all receipt-sourced price rows (product_id IS NULL, source soliq_qr).
    before = supabase.table('prices').select('id', count='exact').eq('source', 'soliq_qr').execute()
    print(f"soliq_qr price rows before: {before.count}")

    supabase.table('prices').delete().eq('source', 'soliq_qr').execute()

    after = supabase.table('prices').select('id', count='exact').eq('source', 'soliq_qr').execute()
    print(f"soliq_qr price rows after:  {after.count}")

    # 2. Re-queue every receipt so the worker reprocesses them.
    queue = supabase.table('receipt_queue').select('id').execute()
    queue_ids = [row['id'] for row in (queue.data or [])]
    print(f"receipt_queue rows to reset: {len(queue_ids)}")

    for qid in queue_ids:
        supabase.table('receipt_queue').update({
            'status': 'pending',
            'processed_at': None,
            'error_message': None,
        }).eq('id', qid).execute()

    print("Done. Now run:  python process_receipts.py")


if __name__ == '__main__':
    main()
