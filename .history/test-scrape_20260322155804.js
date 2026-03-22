const axios = require('axios');
const url = 'https://ofd.soliq.uz/check?t=LG420250352474&r=134866&c=20250322172259&s=744671283400';

(async () => {
  try {
    const r = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,uz-UZ;q=0.8',
        'Referer': 'https://ofd.soliq.uz/',
        'Cache-Control': 'max-age=0',
      }
    });
    const html = r.data;
    console.log('STATUS:', r.status);
    console.log('LENGTH:', html.length);
    console.log('HAS products-tables:', html.includes('products-tables'));
    console.log('HAS products-row:', html.includes('products-row'));
    console.log('HAS Nomi:', html.includes('Nomi'));
    console.log('HAS shakllanmoqda:', html.includes('shakllanmoqda'));
    console.log('HAS alert-danger:', html.includes('alert-danger'));

    // Save full HTML for inspection
    require('fs').writeFileSync('debug-receipt.html', html, 'utf-8');
    console.log('Full HTML saved to debug-receipt.html');
  } catch(e) {
    console.error('ERROR:', e.message);
  }
})();
