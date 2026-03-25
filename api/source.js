import axios from 'axios';
import { normalizeSoliqUrl, isSoliqUrl } from './utils/receipt.js';
import * as cheerio from 'cheerio';

export const config = {
  api: { bodyParser: true },
  maxDuration: 30,
};

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

function extractVisibleContentFromHtml(html) {
  const $ = cheerio.load(String(html || ''));
  $('script, style, noscript').remove();
  return $('body').text().replace(/\s+/g, ' ').trim();
}

async function fetchSource(url) {
  const candidates = buildCandidateUrls(url);
  const attempts = [];

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
        attempts.push({ candidate, status: response.status, htmlLength: html.length, ok: true });
        return { html, attempts };
      }
      attempts.push({ candidate, status: response.status, htmlLength: 0, ok: false, error: 'empty_html' });
    } catch (error) {
      attempts.push({
        candidate,
        ok: false,
        error: 'request_failed',
        code: error?.code || null,
        message: error?.message || String(error),
        status: error?.response?.status || null,
      });
      continue;
    }
  }

  return { html: null, attempts };
}

export default async function handler(req, res) {
  withCors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return ok(res, { ok: false, error: 'method_not_allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const normalized = normalizeSoliqUrl(String(body.url || '').trim());
    const mode = String(body.mode || 'source').toLowerCase();

    if (!normalized || !isSoliqUrl(normalized)) {
      return ok(res, { ok: false, error: 'not_soliq_url' });
    }

    const { html, attempts } = await fetchSource(normalized);
    if (!html) {
      return ok(res, { ok: false, error: 'source_fetch_failed', detail: { attempts } });
    }

    if (mode === 'content') {
      const content = extractVisibleContentFromHtml(html);
      if (!content) {
        return ok(res, { ok: false, error: 'content_extract_failed', detail: { attempts } });
      }
      return ok(res, { ok: true, content, detail: { attempts } });
    }

    return ok(res, { ok: true, source: html, detail: { attempts } });
  } catch (error) {
    return ok(res, { ok: false, error: 'server_error', detail: error?.message || String(error) });
  }
}
