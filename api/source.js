import axios from 'axios';
import { normalizeSoliqUrl, isSoliqUrl } from './utils/receipt.js';

function withCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function ok(res, payload) {
  withCors(res);
  return res.status(200).json(payload);
}

function buildCandidateUrls(inputUrl) {
  const candidates = [inputUrl];
  try {
    const parsed = new URL(inputUrl);
    const t = parsed.searchParams.get('t');
    if (!t) return [...new Set(candidates)];

    const r = parsed.searchParams.get('r');
    const c = parsed.searchParams.get('c');
    const s = parsed.searchParams.get('s');

    const check = new URL('https://ofd.soliq.uz/check');
    check.searchParams.set('t', t);
    if (r) check.searchParams.set('r', r);
    if (c) check.searchParams.set('c', c);
    if (s) check.searchParams.set('s', s);

    const epi = new URL('https://ofd.soliq.uz/epi');
    epi.searchParams.set('t', t);
    if (r) epi.searchParams.set('r', r);
    if (c) epi.searchParams.set('c', c);
    if (s) epi.searchParams.set('s', s);

    candidates.push(check.toString());
    candidates.push(epi.toString());
  } catch {
    return [...new Set(candidates)];
  }

  return [...new Set(candidates)];
}

async function fetchSource(url) {
  const candidates = buildCandidateUrls(url);

  for (const candidate of candidates) {
    try {
      const response = await axios.get(candidate, {
        timeout: 45000,
        maxRedirects: 5,
        validateStatus: status => status >= 200 && status < 400,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'uz,ru;q=0.9,en;q=0.8',
          Referer: 'https://ofd.soliq.uz/',
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
        },
      });

      const html = String(response.data || '').trim();
      if (html) {
        return html;
      }
    } catch {
      continue;
    }
  }

  return null;
}

export default async function handler(req, res) {
  withCors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return ok(res, { ok: false, error: 'method_not_allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const normalized = normalizeSoliqUrl(String(body.url || '').trim());

    if (!normalized || !isSoliqUrl(normalized)) {
      return ok(res, { ok: false, error: 'not_soliq_url' });
    }

    const source = await fetchSource(normalized);
    if (!source) {
      return ok(res, { ok: false, error: 'source_fetch_failed' });
    }

    return ok(res, { ok: true, source });
  } catch (error) {
    return ok(res, { ok: false, error: 'server_error', detail: error?.message || String(error) });
  }
}
