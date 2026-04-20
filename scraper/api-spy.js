const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const apiCalls = [];

  page.on('request', req => {
    const url = req.url();
    const method = req.method();
    if (!url.includes('.png') && !url.includes('.jpg') && !url.includes('.css') && !url.includes('.woff') && !url.includes('google') && !url.includes('analytics') && !url.includes('akamai') && !url.includes('tag')) {
      if (url.includes('api') || url.includes('calc') || url.includes('preis') || url.includes('tarif') || method === 'POST') {
        apiCalls.push({ method, url: url.substring(0, 150), post: req.postData()?.substring(0, 400) });
      }
    }
  });

  console.log('Lade Allianz Rechner...');
  // domcontentloaded statt networkidle — schneller
  await page.goto('https://www.allianz.de/recht-und-eigentum/privatschutz/rechner/#/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(8000); // JS-App laden lassen

  console.log('Title:', await page.title());
  console.log('URL:', page.url());

  console.log('\n=== API CALLS ===');
  if (apiCalls.length === 0) console.log('Keine API Calls gefunden');
  apiCalls.forEach(c => {
    console.log(`${c.method} ${c.url}`);
    if (c.post) console.log('  BODY:', c.post);
  });

  await browser.close();
})();
