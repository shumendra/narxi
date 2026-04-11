import { supabase, sendBroadcast } from './notifications-core.js';

export const config = { maxDuration: 60 };

function isAuthorized(req) {
  if (req.headers['x-vercel-cron'] === '1') return true;
  const authHeader = req.headers.authorization || req.headers.Authorization;
  return authHeader === `Bearer ${process.env.NOTIFICATION_SECRET}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (!supabase) {
    return res.status(500).json({ ok: false, error: 'SUPABASE_NOT_CONFIGURED' });
  }

  const now = new Date().toISOString();
  const { data: pending, error } = await supabase
    .from('scheduled_notifications')
    .select('*')
    .eq('status', 'pending')
    .lte('scheduled_for', now)
    .order('scheduled_for', { ascending: true })
    .limit(25);

  if (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }

  if (!pending || pending.length === 0) {
    return res.status(200).json({ ok: true, message: 'No pending notifications' });
  }

  for (const notification of pending) {
    await sendBroadcast(notification.message, notification.id);
  }

  return res.status(200).json({ ok: true, processed: pending.length });
}
