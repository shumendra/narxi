-- One-time cleanup for historical receipt URL storage.
-- Run this in Supabase SQL editor when you are ready.
-- This keeps only active queue rows and clears past URL history logs.

begin;

-- Optional: inspect counts before cleanup.
-- select status, count(*) from receipt_queue group by status order by status;
-- select count(*) from receipts_log;

-- Remove already-processed queue rows (their URLs are no longer needed).
delete from receipt_queue
where status in ('processed', 'done', 'approved', 'completed');

-- Remove failed queue rows older than 7 days.
delete from receipt_queue
where status = 'failed'
  and coalesce(updated_at, created_at) < now() - interval '7 days';

-- Clear historical URL log table completely.
delete from receipts_log;

commit;

-- Optional post-checks.
-- select status, count(*) from receipt_queue group by status order by status;
-- select count(*) from receipts_log;
