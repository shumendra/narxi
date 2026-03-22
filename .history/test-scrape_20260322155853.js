import axios from 'axios';
import fs from 'fs';

async function testUrl(label, url) {
  try {
    const r = await axios.get(url, {
      timeout: 30000,
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'uz,ru;q=0.9,en;q=0.8',
        'Referer': 'https://ofd.soliq.uz/',
      }
    });
    const html = r.data;
    console.log(`\n=== ${label} ===`);
    console.log('STATUS:', r.status);
    console.log('LENGTH:', html.length);
    console.log('HAS products-tables:', html.includes('products-tables'));
    console.log('HAS products-row:', html.includes('products-row'));
    console.log('HAS Nomi:', html.includes('Nomi'));
    console.log('HAS shakllanmoqda:', html.includes('shakllanmoqda'));
    console.log('HAS alert-danger:', html.includes('alert-danger'));
    fs.writeFileSync(`debug-${label}.html`, html, 'utf-8');
    console.log(`Saved to debug-${label}.html`);
  } catch(e) {
    console.log(`\n=== ${label} ===`);
    console.error('ERROR:', e.message, e.code);
  }
}

(async () => {
  // Known-good old receipt
  await testUrl('old-good', 'https://ofd.soliq.uz/check?t=LG420230642268&r=84474&c=20260320212103&s=301650603100');
  // User's recent receipt
  await testUrl('user-new', 'https://ofd.soliq.uz/check?t=LG420250352474&r=134866&c=20250322172259&s=744671283400');
  // Also try /epi variant
  await testUrl('user-epi', 'https://ofd.soliq.uz/epi?t=LG420250352474&r=134866&c=20250322172259&s=744671283400');
})();
