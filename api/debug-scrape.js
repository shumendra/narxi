import axios from 'axios';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const url = String(req.query.url || '').trim();
  if (!url || !/soliq\.uz/i.test(url)) {
    return res.status(400).json({ error: 'Provide a ?url= pointing to soliq.uz' });
  }

  try {
    const response = await axios.get(url, {
      timeout: 15000,
      maxRedirects: 5,
      validateStatus: (s) => s >= 200 && s < 400,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,uz-UZ;q=0.8,uz;q=0.7,en-US;q=0.6,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control': 'max-age=0',
        'Referer': 'https://ofd.soliq.uz/',
      },
    });

    const html = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);

    return res.status(200).json({
      status: response.status,
      html_length: html.length,
      first_2000_chars: html.substring(0, 2000),
      last_2000_chars: html.substring(Math.max(0, html.length - 2000)),
      contains_products_tables: html.includes('products-tables'),
      contains_products_row: html.includes('products-row'),
      contains_nomi: html.includes('Nomi'),
      contains_narxi: html.includes('Narxi'),
      contains_soni: html.includes('Soni'),
      contains_table: html.includes('<table'),
      contains_h3: html.includes('<h3'),
      contains_shakllanmoqda: html.includes('shakllanmoqda'),
      contains_alert_danger: html.includes('alert-danger'),
      contains_generating_ru: html.includes('генерируется') || html.includes('формируется'),
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message,
      code: error.code,
      status: error.response?.status,
    });
  }
}
