import { sendBroadcast, sendWeeklyReports } from './notifications-core.js';

export const config = { maxDuration: 60 };

function isAuthorized(req) {
  if (req.headers['x-vercel-cron'] === '1') return true;
  const authHeader = req.headers.authorization || req.headers.Authorization;
  return authHeader === `Bearer ${process.env.NOTIFICATION_SECRET}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const { type, message, scheduled_id: scheduledId } = req.body || {};

  if (type === 'weekly_report') {
    const result = await sendWeeklyReports();
    return res.status(200).json({ ok: true, ...result });
  }

  if (type === 'broadcast' && message) {
    const result = await sendBroadcast(message, scheduledId || null);
    return res.status(200).json({ ok: true, ...result });
  }

  return res.status(400).json({ ok: false, error: 'INVALID_REQUEST' });
}
