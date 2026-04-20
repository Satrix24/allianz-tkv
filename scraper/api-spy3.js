const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const all = [];

  page.on('response', async res => {
    const url = res.url();
    if (url.includes('inno-prod.allianz.de')) {
      try {
        const req = res.request();
        const reqBody = req.postData();
        const resBody = await res.text();
        all.push({
          op: reqBody ? JSON.parse(reqBody).operationName : 'GET',
          vars: reqBody ? JSON.stringify(JSON.parse(reqBody).variables) : '',
          res: resBody.substring(0, 1000)
        });
      } catch(e) {}
    }
  });

  await page.goto('https://www.allianz.de/recht-und-eigentum/privatschutz/rechner/#/', { 
    waitUntil: 'domcontentloaded', timeout: 60000 
  });
  await page.waitForTimeout(6000);

  // Warte auf Formular und fülle es aus
  try {
    // Cloudflare-Challenge abwarten
    await page.waitForSelector('input, select, [role="combobox"]', { timeout: 15000 });
    await page.waitForTimeout(2000);
    
    // Screenshot für Debugging
    await page.screenshot({ path: '/tmp/allianz-form.png' });
    
    // Alle Inputs finden
    const inputs = await page.$$eval('input, select', els => els.map(el => ({
      tag: el.tagName, type: el.type, id: el.id, name: el.name, 
      placeholder: el.placeholder, class: el.className.substring(0,50)
    })));
    console.log('INPUTS:', JSON.stringify(inputs.slice(0,10)));

    // PLZ eingeben (verschiedene Selektoren versuchen)
    for (const sel of ['[name="plz"]', '[id*="plz"]', '[placeholder*="PLZ"]', '[placeholder*="Postleitzahl"]', 'input[maxlength="5"]']) {
      try { await page.fill(sel, '80331', {timeout: 3000}); console.log('PLZ eingegeben via', sel); break; } catch(e) {}
    }
    await page.waitForTimeout(1000);

    // Weiter klicken
    for (const sel of ['button[type="submit"]', 'button:has-text("Weiter")', 'button:has-text("Berechnen")', 'button:has-text("Jetzt")', '[data-testid*="next"]', '[data-testid*="submit"]']) {
      try { await page.click(sel, {timeout: 3000}); console.log('Weiter via', sel); break; } catch(e) {}
    }
    await page.waitForTimeout(5000);
    await page.screenshot({ path: '/tmp/allianz-form2.png' });

  } catch(e) { console.log('Form error:', e.message.substring(0,100)); }

  console.log('\n=== ALL GRAPHQL OPS ===');
  all.forEach(c => {
    console.log(`\n[${c.op}]`);
    if (c.vars && c.vars !== '{}') console.log('vars:', c.vars.substring(0,200));
    console.log('res:', c.res.substring(0,500));
  });

  await browser.close();
})();
