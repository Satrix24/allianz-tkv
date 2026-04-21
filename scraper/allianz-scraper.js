const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

const ALLIANZ_URL = 'https://www.allianz.de/gesundheit/tierkrankenversicherung/rechner/?page=angaben';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
const DEFAULT_TIMEOUT = 45000;

chromium.use(StealthPlugin());

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
];

function randomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function normalizeInput(input) {
  return {
    plz: (input.plz || '').trim(),
    geburtsdatumHalter: (input.geburtsdatum_halter || input.geburtsdatumHalter || '').trim(),
    tierart: (input.tierart || 'Hund').trim(),
    geschlecht: (input.geschlecht || 'männlich').trim(),
    tiername: (input.tiername || '').trim(),
    geburtsdatumTier: (input.geburtsdatum_tier || input.geburtsdatumTier || '').trim(),
    groesse: (input.groesse || '').trim(),
    rasseWert: (input.rasse_wert || input.rasseWert || 'MISCHLING').trim(),
    rasseText: (input.rasse_text || input.rasseText || '').trim(),
    hasIllnesses: input.has_illnesses === true || input.hasIllnesses === true || false,
    tarifPriority: (input.tarif_priority || input.tarifPriority || 'Bestes Preis-Leistungs-Verhältnis').trim(),
    tarifPraferenz: (input.tarifPraferenz || input.coverage_type || input.tarif_praferenz || input.tarifpraeferenz || 'OP-Schutz').trim()
  };
}

function validateInput(data) {
  const required = ['plz', 'geburtsdatumHalter', 'tiername', 'geburtsdatumTier'];
  const missing = required.filter((key) => !data[key]);
  if (missing.length) {
    throw new Error(`Fehlende Felder: ${missing.join(', ')}`);
  }
}

// Angular-aware fill: type + dispatch events so ngModel picks up the value
async function angularFill(page, selector, value, timeoutMs = 8000) {
  const input = page.locator(selector).first();
  await input.click({ timeout: timeoutMs });
  await input.fill('');
  await input.type(value, { delay: 60 });
  await input.evaluate((el) => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  });
  await page.waitForTimeout(200);
}

// Robust PLZ fill with fallback selector chain
async function fillPlz(page, plz) {
  const selectors = [
    '[name="plz"]',
    '[formcontrolname="plz"]',
    'input[formcontrolname="plz"]',
    'input[type="text"][formcontrolname="plz"]',
    '[placeholder*="PLZ"]',
    '[placeholder*="Postleitzahl"]',
    'input[aria-label*="PLZ"]',
    'input[aria-label*="Postleitzahl"]',
    '.plz input',
    'app-plz input',
    'nx-formfield[label*="PLZ"] input',
    'nx-formfield[label*="Postleitzahl"] input',
  ];

  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      await el.waitFor({ state: 'visible', timeout: 8000 });
      await el.click();
      await el.fill('');
      await el.type(plz, { delay: 50 });
      await el.evaluate((node) => {
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
        node.dispatchEvent(new Event('blur', { bubbles: true }));
      });
      console.log(`[PLZ] Filled with selector: ${sel}`);
      return;
    } catch (_) {
      console.log(`[PLZ] Selector failed: ${sel}`);
    }
  }
  throw new Error('PLZ-Feld nicht gefunden — alle Selektoren fehlgeschlagen');
}

// Robust Geburtsdatum-Halter fill with fallback selector chain
async function fillGeburtsdatumHalter(page, datum) {
  const selectors = [
    '[name="geburtsdatum"]',
    '[formcontrolname="geburtsdatum"]',
    'input[formcontrolname="birthdate"]',
    '[name="birthdate"]',
    '[placeholder*="Geburtsdatum"]',
    '[placeholder*="TT.MM.JJJJ"]',
    'input[aria-label*="Geburtsdatum"]',
    'nx-formfield[label*="Geburtsdatum"] input',
  ];

  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      await el.waitFor({ state: 'visible', timeout: 8000 });
      await el.click();
      await el.fill('');
      await el.type(datum, { delay: 50 });
      await el.evaluate((node) => {
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
        node.dispatchEvent(new Event('blur', { bubbles: true }));
      });
      console.log(`[GebDatum Halter] Filled with selector: ${sel}`);
      return;
    } catch (_) {
      console.log(`[GebDatum Halter] Selector failed: ${sel}`);
    }
  }
  // Final fallback: angularFill with original selector (let it throw with proper message)
  throw new Error('Geburtsdatum-Halter-Feld nicht gefunden — alle Selektoren fehlgeschlagen');
}

// Generic robust fill: tries a list of selectors in order
async function angularFillRobust(page, fieldLabel, selectors, value) {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      await el.waitFor({ state: 'visible', timeout: 6000 });
      await el.click();
      await el.fill('');
      await el.type(value, { delay: 50 });
      await el.evaluate((node) => {
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
        node.dispatchEvent(new Event('blur', { bubbles: true }));
      });
      console.log(`[${fieldLabel}] Filled with selector: ${sel}`);
      return;
    } catch (_) {
      console.log(`[${fieldLabel}] Selector failed: ${sel}`);
    }
  }
  throw new Error(`${fieldLabel}-Feld nicht gefunden — alle Selektoren fehlgeschlagen`);
}

// Click nx-dropdown and select an option by text
async function selectNxDropdown(page, name, optionText) {
  // Try nx-dropdown first, then standard select fallback
  const nxDropdown = page.locator(`nx-dropdown[name="${name}"]`);
  const nxExists = await nxDropdown.count().catch(() => 0);
  if (nxExists > 0) {
    await nxDropdown.evaluate((el) => el.click());
  } else {
    // Fallback: try select element or div[role="combobox"]
    const fallbacks = [
      `select[name="${name}"]`,
      `[formcontrolname="${name}"]`,
      `[ng-reflect-name="${name}"]`,
    ];
    let opened = false;
    for (const fb of fallbacks) {
      try {
        const el = page.locator(fb).first();
        const cnt = await el.count().catch(() => 0);
        if (cnt > 0) {
          await el.click({ timeout: 3000 });
          opened = true;
          break;
        }
      } catch (_) {}
    }
    if (!opened) {
      console.warn(`[Dropdown] nx-dropdown[name="${name}"] not found, attempting direct click`);
      await nxDropdown.evaluate((el) => el.click());
    }
  }
  await page.waitForTimeout(800);
  await page.locator('[role="option"]').filter({ hasText: optionText }).first().click({ timeout: 5000 });
  await page.waitForTimeout(400);
}

// Click a radio button by its label text (using label[for=id] pattern Angular uses)
async function clickRadioByLabel(page, name, labelPattern) {
  const id = await page.evaluate((args) => {
    const inputs = [...document.querySelectorAll(`input[type="radio"][name="${args.name}"]`)];
    for (const inp of inputs) {
      const lbl = document.querySelector(`label[for="${inp.id}"]`)?.textContent?.trim() || '';
      if (new RegExp(args.pattern, 'i').test(lbl)) return inp.id;
    }
    return null;
  }, { name, pattern: labelPattern });

  if (!id) throw new Error(`Radio nicht gefunden: name=${name} pattern=${labelPattern}`);
  await page.locator(`label[for="${id}"]`).click({ timeout: 5000 });
  await page.waitForTimeout(300);
}

function mapTierartOption(tierart) {
  const t = tierart.toLowerCase();
  if (t.includes('katze')) return 'Meine Katze';
  if (t.includes('pferd')) return 'Mein Pferd';
  return 'Mein Hund';
}

function mapGeschlechtOption(geschlecht) {
  const g = geschlecht.toLowerCase();
  if (g.startsWith('w')) return 'weiblich';
  return 'männlich';
}

function mapTarifOption(pref) {
  const p = pref.toLowerCase();
  if (p.includes('voll')) return 'Vollschutz';
  return 'OP-Schutz';
}

function mapGroessePattern(groesse) {
  if (!groesse) return null;
  const g = groesse.toLowerCase();
  if (g.includes('45') || g.includes('groß') || g.includes('gross') || g.includes('large')) return '45';
  return '0'; // default: klein
}

async function acceptCookies(page) {
  try {
    await page.getByRole('button', { name: /Nur erforderliche Cookies/i }).click({ timeout: 10000 });
    await page.waitForTimeout(1500);
  } catch (_) {
    // Fallback: DOM-Remove
    await page.evaluate(() => document.getElementById('onetrust-consent-sdk')?.remove());
    await page.waitForTimeout(800);
  }
}

async function fillForm(page, data) {
  // 1. PLZ + Halter-Geburtsdatum (using robust fallback-chain selectors)
  await fillPlz(page, data.plz);
  await fillGeburtsdatumHalter(page, data.geburtsdatumHalter);

  // 2. Tierart + Geschlecht Dropdowns
  await selectNxDropdown(page, 'animalType', mapTierartOption(data.tierart));
  await selectNxDropdown(page, 'animalGender', mapGeschlechtOption(data.geschlecht));

  // 3. Tiername + Tiergeburtsdatum (with robust fallback)
  await angularFillRobust(page, 'tiername', [
    '[name="animalName"]',
    '[formcontrolname="animalName"]',
    'input[aria-label*="Name"]',
  ], data.tiername);
  await angularFillRobust(page, 'tiergeburtsdatum', [
    '[name="animalBirthdate"]',
    '[formcontrolname="animalBirthdate"]',
    '[formcontrolname="birthdate"][name!="geburtsdatum"]',
    '[placeholder*="Geburtsdatum"][name!="geburtsdatum"]',
  ], data.geburtsdatumTier);

  // 4. Rasse wählen
  const isMischling = !data.rasseWert || data.rasseWert === 'MISCHLING';
  if (isMischling) {
    // Mischling via Radio
    await clickRadioByLabel(page, 'breedSelectionType', 'Mischling');
    await page.waitForTimeout(800);
    // Mutter-Rasse: unbekannt
    try {
      await page.locator('label').filter({ hasText: /Die Rasse ist unbekannt/i }).first().click({ timeout: 5000 });
      await page.waitForTimeout(400);
    } catch (_) {}
  } else {
    // Konkrete Rasse via Dropdown (dogBreedId / catBreedId / horseBreedId)
    await clickRadioByLabel(page, 'breedSelectionType', 'Rasse auswählen');
    await page.waitForTimeout(500);
    // Dropdown öffnen (Name variiert je nach Tierart)
    const breedDropdownName = data.tierart.toLowerCase().includes('katze') ? 'catBreedId'
      : data.tierart.toLowerCase().includes('pferd') ? 'horseBreedId' : 'dogBreedId';
    await page.locator(`nx-dropdown[name="${breedDropdownName}"]`).evaluate(el => el.click());
    await page.waitForTimeout(1000);
    // Rasse-Text suchen und klicken
    const rasseText = data.rasseText || data.rasseWert;
    try {
      await page.locator('[role="option"]').filter({ hasText: rasseText }).first().click({ timeout: 5000 });
    } catch (_) {
      // Fallback: Mischling nehmen
      await page.keyboard.press('Escape');
      await clickRadioByLabel(page, 'breedSelectionType', 'Mischling');
      await page.waitForTimeout(800);
      try { await page.locator('label').filter({ hasText: /Die Rasse ist unbekannt/i }).first().click({ timeout: 3000 }); } catch(_) {}
    }
    await page.waitForTimeout(400);
  }

  // 6. Größe (erscheint nach Mischling-Auswahl): klein=0-44cm, groß=45-120cm
  // Nutze clickRadioByLabel mit name="dogSize"
  try {
    const groessePat = data.groesse && /45|gro/i.test(data.groesse) ? '45' : '0 - 44';
    await clickRadioByLabel(page, 'dogSize', groessePat.replace('.', '\\.'));
    await page.waitForTimeout(300);
  } catch (_) {
    // dogSize vielleicht nicht vorhanden (z.B. Katze)
  }

  // 7. Vorerkrankungen: Ja oder Nein
  await clickRadioByLabel(page, 'hasIllnesses', data.hasIllnesses ? 'Ja' : 'Nein');

  // 8. Tarif (OP-Schutz / Vollschutz) — erscheint vor der Tarifpräferenz-Frage
  await clickRadioByLabel(page, 'coverageType', mapTarifOption(data.tarifPraferenz));
  await page.waitForTimeout(600); // Warten bis Tarifpräferenz-Feld erscheint

  // 9. Tarifpräferenz (was ist am wichtigsten) — erscheint NACH coverageType
  // Mögliche radio-Namen: tarifPraeferenz, tarifwahl, prioritaet etc.
  // Fallback: per Label-Text suchen
  try {
    // Erst schauen welche neuen Radios erschienen sind
    const newRadioName = await page.evaluate(() => {
      const known = new Set(['breedSelectionType','motherBreedSelectionType','dogSize','hasIllnesses','coverageType']);
      return [...document.querySelectorAll('input[type="radio"]')]
        .find(inp => !known.has(inp.name))?.name || null;
    });
    if (newRadioName) {
      await clickRadioByLabel(page, newRadioName, data.tarifPriority || 'Bestes Preis');
    } else {
      const pat = new RegExp(data.tarifPriority?.substring(0, 12) || 'Bestes Preis', 'i');
      await page.locator('label').filter({ hasText: pat }).first().click({ timeout: 3000 });
    }
    await page.waitForTimeout(300);
  } catch (_) {
    // Feld vielleicht optional oder noch nicht erschienen
  }
}

async function goToResults(page) {
  await page.getByRole('button', { name: /Tarif berechnen/i }).first().click({ timeout: 10000 });
  await page.waitForTimeout(15000);
}

async function waitForResultArea(page) {
  try {
    await page.waitForSelector(
      '[class*="tarif"], [class*="produkt"], [class*="preis"], [class*="product"], [class*="price"], nx-card, nx-tile, [class*="result"]',
      { timeout: 25000 }
    );
  } catch {
    // Selector not found — just wait and let parseTarife handle it
    await page.waitForTimeout(5000);
  }
}

async function saveResultScreenshot(page, downloadsDir) {
  ensureDir(downloadsDir);
  const screenshotPath = path.join(downloadsDir, `result_${Date.now()}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  return screenshotPath;
}

async function parseTarife(page) {
  // Strategie 0: Debug-Log — Page state + structure
  try {
    const debugInfo = await page.evaluate(() => {
      return {
        title: document.title,
        bodyText: document.body.innerText.substring(0, 500),
        nxCards: document.querySelectorAll('nx-card').length,
        nxTiles: document.querySelectorAll('nx-tile').length,
        nxPrices: document.querySelectorAll('nx-price').length,
        allText: document.body.innerText.substring(0, 2000),
      };
    });
    console.log('[parseTarife] Debug page state:', JSON.stringify(debugInfo));
  } catch (e) {
    console.warn('[parseTarife] Debug-Info konnte nicht ausgelesen werden:', e.message);
  }

  // Strategie 1: nx-card / nx-tile DOM-Struktur (Angular nx-Komponenten)
  const parsed1 = await page.evaluate(() => {
    const tarifNamen = ['Basis', 'Smart', 'Komfort', 'Premium', 'OP-Schutz', 'Vollschutz', 'Optimal', 'Best'];
    const results = [];

    // Selektoren für Tarif-Cards in Allianz nx-Angular-Komponenten
    const cardSelectors = [
      'nx-card', 'nx-tile', '[class*="tarif-card"]', '[class*="product-card"]',
      '[class*="TarifCard"]', '[class*="ProductCard"]', '[class*="offer-card"]',
      '[data-testid*="tarif"]', '[data-testid*="product"]',
      '.tarif', '.produkt', '.product', '.plan-card', '.rate-card'
    ];

    // Price extraction helper: tries with € suffix first, then bare decimal in 5-500 range
    function extractPrice(text) {
      const withEuro = text.match(/(\d{1,3}[.,]\d{2})\s*[€]/);
      if (withEuro) return withEuro[1];
      const euroAfterSpace = text.match(/(\d{1,3}[.,]\d{2})\s*€/);
      if (euroAfterSpace) return euroAfterSpace[1];
      // Bare decimal fallback — only accept price-range values (5–500)
      const bare = [...text.matchAll(/\b(\d{1,3}[.,]\d{2})\b/g)]
        .map(m => m[1])
        .find(p => { const v = parseFloat(p.replace(',', '.')); return v >= 5 && v <= 500; });
      return bare || null;
    }

    for (const sel of cardSelectors) {
      const cards = [...document.querySelectorAll(sel)];
      if (cards.length === 0) continue;

      for (const card of cards) {
        const text = card.innerText || '';
        if (!text.trim()) continue;

        // Preis aus dieser Card extrahieren (robust: mit oder ohne direktes € nach Zahl)
        const extractedPrice = extractPrice(text);
        if (!extractedPrice) continue;
        // Keep preisMatch-compatible variable for the push below
        const preisMatch = [null, extractedPrice];

        // Tarif-Name aus dieser Card
        let tarifName = '';
        const nameEl = card.querySelector(
          'h1,h2,h3,h4,[class*="title"],[class*="name"],[class*="heading"],[class*="tarif-name"],[class*="product-name"]'
        );
        if (nameEl) {
          tarifName = nameEl.innerText.trim();
        } else {
          // Fallback: ersten Tarif-Namen im Text finden
          const found = tarifNamen.find(n => text.includes(n));
          tarifName = found || '';
        }

        if (!tarifName) continue;

        // Leistungen aus dieser Card
        const leistungen = [];
        const listItems = card.querySelectorAll('li, [class*="benefit"], [class*="feature"], [class*="leistung"]');
        for (const li of listItems) {
          const t = li.innerText.trim();
          if (t && t.length > 3 && t.length < 150) leistungen.push(t);
          if (leistungen.length >= 5) break;
        }

        results.push({
          name: tarifName,
          preis: preisMatch[1].replace(',', '.') + ' €/Monat',
          leistungen: leistungen.slice(0, 5)
        });
        // (preisMatch[1] is set from extractedPrice above)
      }

      if (results.length > 0) break;
    }

    return results;
  });

  if (parsed1.length > 0) {
    console.log('[parseTarife] Strategie 1 (nx-cards) erfolgreich:', parsed1.length, 'Tarife');
    return parsed1;
  }

  // Strategie 2: Allianz TKV Ergebnisseite — Tarif-Namen gefolgt von Preisen im innerText
  const parsed2 = await page.evaluate(() => {
    const results = [];
    const allText = document.body.innerText || '';
    const tarifNamen = ['Basis', 'Smart', 'Komfort', 'Premium', 'OP-Schutz', 'Vollschutz', 'Optimal', 'Best'];

    const lines = allText.split('\n').map(l => l.trim()).filter(Boolean);
    let currentTarif = null;
    let lastTarifIdx = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Tarif-Name gefunden?
      const isName = tarifNamen.find(n =>
        line === n || line.startsWith(n + ' ') || line.startsWith(n + '-')
      );
      if (isName) { currentTarif = isName; lastTarifIdx = i; continue; }

      // Preis-Zeile gefunden? (flexibler: erlaubt auch "ab X,XX €" oder mitten in Zeile)
      // Match price with € directly after, OR a bare decimal in 5–500 range
      let preisMatch = line.match(/(\d{1,3}[.,]\d{2})\s*€/);
      if (!preisMatch) {
        // Check next line for € sign (price split across lines)
        const nextLine = lines[i + 1] || '';
        if (nextLine.trim() === '€' || nextLine.trim().startsWith('€')) {
          preisMatch = line.match(/(\d{1,3}[.,]\d{2})/);
        }
      }
      if (!preisMatch) {
        // Bare decimal fallback — only in price range
        const bareM = line.match(/^(\d{1,3}[.,]\d{2})$/);
        if (bareM) {
          const v = parseFloat(bareM[1].replace(',', '.'));
          if (v >= 5 && v <= 500) preisMatch = bareM;
        }
      }
      if (preisMatch && currentTarif) {
        const leistungen = [];
        for (let j = i + 1; j < Math.min(i + 15, lines.length); j++) {
          if (tarifNamen.find(n => lines[j] === n || lines[j].startsWith(n + ' '))) break;
          if (lines[j].length > 5 && lines[j].length < 150 &&
              !lines[j].match(/^\d{1,3}[.,]\d{2}\s*[€EUR]/)) {
            leistungen.push(lines[j]);
          }
        }
        results.push({
          name: currentTarif,
          preis: preisMatch[1].replace(',', '.') + ' €/Monat',
          leistungen: leistungen.slice(0, 5)
        });
        currentTarif = null;
      }
    }

    return results;
  });

  if (parsed2.length > 0) {
    console.log('[parseTarife] Strategie 2 (text-lines) erfolgreich:', parsed2.length, 'Tarife');
    return parsed2;
  }

  // Strategie 3: Alle Preis-Treffer aus Seitentext + nx-price-Elemente
  const parsed3 = await page.evaluate(() => {
    const results = [];
    const namen = ['Basis', 'Smart', 'Komfort', 'Premium'];

    // nx-price Elemente direkt auslesen
    const priceEls = [
      ...document.querySelectorAll(
        'nx-price, [class*="price"], [class*="preis"], [class*="amount"], [class*="betrag"]'
      )
    ];

    const seenPrices = new Set();
    for (const el of priceEls) {
      // Include parent text too (price may be split across child elements)
      const t = (el.innerText || '').trim();
      const m = t.match(/(\d{1,3}[.,]\d{2})/);
      if (m) {
        const v = parseFloat(m[1].replace(',', '.'));
        if (v >= 5 && v <= 500 && !seenPrices.has(m[1])) {
          seenPrices.add(m[1]);
          results.push(m[1]);
        }
      }
      if (results.length >= 4) break;
    }

    // Fallback: body-Text regex — try with € first, then bare decimals in range
    if (results.length === 0) {
      const bodyText = document.body.innerText || '';
      // Try with € suffix
      const matchesWithEuro = [...bodyText.matchAll(/(\d{1,3}[.,]\d{2})\s*€/g)];
      const uniqueWithEuro = [...new Set(matchesWithEuro.map(m => m[1]))];
      if (uniqueWithEuro.length > 0) {
        results.push(...uniqueWithEuro.slice(0, 4));
      } else {
        // Bare decimals in price range as last resort
        const allDecimals = [...bodyText.matchAll(/\b(\d{1,3}[.,]\d{2})\b/g)]
          .map(m => m[1])
          .filter(p => { const v = parseFloat(p.replace(',', '.')); return v >= 5 && v <= 500; });
        const uniqueDecimals = [...new Set(allDecimals)];
        results.push(...uniqueDecimals.slice(0, 4));
      }
    }

    return results.map((preis, idx) => ({
      name: namen[idx] || `Tarif ${idx + 1}`,
      preis: preis.replace(',', '.') + ' €/Monat',
      leistungen: []
    }));
  });

  if (parsed3.length > 0) {
    console.log('[parseTarife] Strategie 3 (price-elements) erfolgreich:', parsed3.length, 'Tarife');
    return parsed3;
  }

  // Strategie 4: Warte noch 5s, dann nochmal Strategie 2 probieren (langsame Seite)
  await page.waitForTimeout(5000);
  const bodyText2 = await page.evaluate(() => document.body.innerText || '');
  // Try with € suffix first
  let allMatches = [...bodyText2.matchAll(/(\d{1,3}[.,]\d{2})\s*€/g)];
  let uniquePreise2 = [...new Set(allMatches.map(m => m[1]))];
  // Fallback: bare decimals in price range (5–500)
  if (uniquePreise2.length === 0) {
    const priceRangeMatches = [...bodyText2.matchAll(/\b(\d{1,3}[.,]\d{2})\b/g)]
      .map(m => m[1])
      .filter(p => { const val = parseFloat(p.replace(',', '.')); return val >= 5 && val <= 500; });
    uniquePreise2 = [...new Set(priceRangeMatches)];
  }

  if (uniquePreise2.length > 0) {
    console.log('[parseTarife] Strategie 4 (delayed bodyText) erfolgreich:', uniquePreise2.length, 'Preise');
    const namen2 = ['Basis', 'Smart', 'Komfort', 'Premium'];
    return uniquePreise2.slice(0, 4).map((preis, idx) => ({
      name: namen2[idx] || `Tarif ${idx + 1}`,
      preis: preis.replace(',', '.') + ' €/Monat',
      leistungen: []
    }));
  }

  console.warn('[parseTarife] Alle Strategien fehlgeschlagen — Screenshot gespeichert');
  return [{
    name: 'Tarif',
    preis: 'Preis nicht auslesbar',
    leistungen: ['Screenshot gespeichert — bitte manuell prüfen']
  }];
}

/**
 * Klickt "Speichern" auf der Ergebnisseite, wartet auf den
 * "Als PDF herunterladen"-Button und fängt den Browser-Download ab.
 * Gibt den lokalen Dateipfad zurück, oder null bei Fehler (nicht fatal).
 */
async function downloadPDF(page, downloadsDir) {
  try {
    ensureDir(downloadsDir);

    // "Speichern"-Button — erscheint auf der Ergebnisseite
    const speichernBtn = page.getByRole('button', { name: /Speichern/i });
    await speichernBtn.waitFor({ state: 'visible', timeout: 12000 });
    await speichernBtn.click();
    await page.waitForTimeout(3000);

    // "Als PDF herunterladen"-Button
    const pdfBtn = page.getByRole('button', { name: /Als PDF herunterladen/i });
    await pdfBtn.waitFor({ state: 'visible', timeout: 15000 });

    // Download-Event und Button-Klick gleichzeitig
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 25000 }),
      pdfBtn.click()
    ]);

    const fileName = `allianz_tkv_${Date.now()}.pdf`;
    const filePath = path.join(downloadsDir, fileName);
    await download.saveAs(filePath);

    if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
      throw new Error('PDF-Datei leer oder nicht gespeichert');
    }

    return filePath;
  } catch (err) {
    // PDF-Download ist nicht fatal — Scraper gibt Tarife + Screenshot zurück
    console.warn('[allianz-scraper] PDF-Download fehlgeschlagen:', err.message);
    return null;
  }
}

async function saveErrorArtifacts(page, downloadsDir, tag) {
  ensureDir(downloadsDir);
  const png = path.join(downloadsDir, `${tag}.png`);
  const html = path.join(downloadsDir, `${tag}.html`);
  await page.screenshot({ path: png, fullPage: true }).catch(() => {});
  const content = await page.content().catch(() => null);
  if (content) fs.writeFileSync(html, content);
  return { screenshot: png, html };
}

async function runSingleAttempt(input, config) {
  const userAgent = randomUserAgent();
  const launchHeadless = config.headless !== false;

  const browser = await chromium.launch({
    headless: launchHeadless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage'
    ]
  });

  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1366, height: 900 },
    userAgent,
    locale: 'de-DE'
  });

  const page = await context.newPage();
  page.setDefaultTimeout(DEFAULT_TIMEOUT);

  try {
    await page.goto(ALLIANZ_URL, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT });

    // Warten bis Angular-App gebootstrappt ist (kann auf langsamen Servern 5-8 Sek. dauern)
    await page.waitForTimeout(2000);
    await page.waitForFunction(
      () => document.querySelector('nx-formfield, [formcontrolname], app-root') !== null,
      { timeout: 20000 }
    ).catch(() => {});
    await page.waitForTimeout(2000);

    // Cloudflare-Challenge prüfen
    const title = (await page.title()).toLowerCase();
    if (title.includes('challenge') || title.includes('just a moment')) {
      await page.waitForTimeout(10000);
      const finalTitle = (await page.title()).toLowerCase();
      if (finalTitle.includes('challenge')) {
        throw new Error(`Cloudflare-Blockade (Versuch ${config.attempt})`);
      }
    }

    // Cookie-Consent akzeptieren — mehrere mögliche Banner-Selektoren
    try {
      await page.locator(
        '[data-testid="uc-accept-all-button"], #onetrust-accept-btn-handler, button:has-text("Alle akzeptieren"), button:has-text("Akzeptieren")'
      ).first().click({ timeout: 5000 });
      await page.waitForTimeout(1000);
      console.log('[cookies] Additional consent banner accepted');
    } catch (_) {
      // No extra banner — continue
    }

    await acceptCookies(page);
    await fillForm(page, input);
    await goToResults(page);

    try {
      await waitForResultArea(page);
    } catch (_) {
      // Weiter — parseTarife hat eigene Fallback-Strategie
    }

    const screenshotPath = await saveResultScreenshot(page, config.downloadsDir);
    const tarife = await parseTarife(page);
    const pdfPath = await downloadPDF(page, config.downloadsDir);

    await browser.close();

    return {
      tarife,
      screenshot: screenshotPath ? `/downloads/${path.basename(screenshotPath)}` : null,
      pdfPath: pdfPath || null,
      pdfUrl: pdfPath ? `/downloads/${path.basename(pdfPath)}` : null
    };
  } catch (error) {
    const tag = `error_attempt_${config.attempt}_${Date.now()}`;
    const artifacts = await saveErrorArtifacts(page, config.errorDir, tag);
    await browser.close().catch(() => {});
    const wrapped = new Error(error.message);
    wrapped.artifacts = artifacts;
    throw wrapped;
  }
}

async function calculateOffer(rawInput, options = {}) {
  const input = normalizeInput(rawInput);
  validateInput(input);

  const downloadsDir = options.downloadsDir || path.join(process.cwd(), 'downloads');
  const errorDir = path.join(downloadsDir, 'errors');
  ensureDir(downloadsDir);
  ensureDir(errorDir);

  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return await runSingleAttempt(input, {
        attempt,
        errorDir,
        downloadsDir,
        headless: options.headless
      });
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  const msg = lastError?.message || 'Unbekannter Scraping-Fehler';
  const err = new Error(`Allianz TKV Scraping fehlgeschlagen nach ${MAX_RETRIES} Versuchen: ${msg}`);
  err.details = { artifacts: lastError?.artifacts || null };
  throw err;
}

module.exports = {
  calculateOffer,
  normalizeInput,
  validateInput,
  ALLIANZ_URL
};
