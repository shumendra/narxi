import { createClient } from '@supabase/supabase-js';
import { normalizeCityName } from '../src/constants/cities.js';

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';

const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

function send(res, status, body) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(body));
}

export default async function contact(req, res) {
  if (!supabase) {
    return send(res, 500, { ok: false, error: 'SUPABASE_NOT_CONFIGURED' });
  }

  if (req.method !== 'POST') {
    return send(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

    const contactValue = String(body.contact || '').trim();
    const messageValue = String(body.message || '').trim();

    if (!contactValue || !messageValue) {
      return send(res, 400, { ok: false, error: 'CONTACT_AND_MESSAGE_REQUIRED' });
    }

    const payload = {
      name: String(body.name || '').trim() || null,
      contact: contactValue,
      message: messageValue,
      city: normalizeCityName(body.city || '') || null,
      language: body.language ? String(body.language) : null,
      telegram_id: body.telegram_id ? String(body.telegram_id) : null,
      telegram_username: body.telegram_username ? String(body.telegram_username) : null,
    };

    const { data, error } = await supabase
      .from('contact_messages')
      .insert(payload)
      .select('id,created_at')
      .single();

    if (error) {
      if (String(error.message || '').toLowerCase().includes('contact_messages')) {
        return send(res, 400, { ok: false, error: 'CONTACT_MESSAGES_TABLE_MISSING' });
      }
      throw error;
    }

    return send(res, 200, { ok: true, item: data });
  } catch (error) {
    return send(res, 500, { ok: false, error: error?.message || 'UNKNOWN_ERROR' });
  }
}
