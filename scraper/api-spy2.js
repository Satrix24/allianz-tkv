const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const graphqlCalls = [];

  // Responses abfangen
  page.on('response', async res => {
    const url = res.url();
    if (url.includes('inno-prod.allianz.de') && url.includes('graphql')) {
      try {
        const req = res.request();
        const reqBody = req.postData();
        const resBody = await res.text();
        if (reqBody) {
          graphqlCalls.push({
            operation: JSON.parse(reqBody).operationName,
            variables: JSON.stringify(JSON.parse(reqBody).variables).substring(0, 200),
            response: resBody.substring(0, 600)
          });
        }
      } catch(e) {}
    }
  });

  await page.goto('https://www.allianz.de/recht-und-eigentum/privatschutz/rechner/#/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);

  // PLZ eingeben + Formular ausfüllen
  try {
    const plzInput = await page.$('input[id*="plz"], input[placeholder*="PLZ"], [data-testid*="plz"] input, input[type="text"]');
    if (plzInput) {
      await plzInput.fill('80331');
      await page.waitForTimeout(1000);
    }
    // Weiter-Button
    const btn = await page.$('button[type="submit"], button:has-text("Weiter"), button:has-text("Berechnen"), button:has-text("Angebot")');
    if (btn) { await btn.click(); await page.waitForTimeout(5000); }
  } catch(e) { console.log('Formular:', e.message); }

  console.log('\n=== GRAPHQL OPERATIONS ===');
  graphqlCalls.forEach(c => {
    console.log(`\n--- ${c.operation} ---`);
    console.log('Variables:', c.variables);
    console.log('Response:', c.response);
  });

  await browser.close();
})();
