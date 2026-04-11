import { sendWeeklyReports } from './notifications-core.js';

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

  const result = await sendWeeklyReports();
  return res.status(200).json({ ok: true, ...result });
}
