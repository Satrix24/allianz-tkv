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
async function angularFill(page, selector, value) {
  const input = page.locator(selector).first();
  await input.click({ timeout: 8000 });
  await input.fill('');
  await input.type(value, { delay: 60 });
  await input.evaluate((el) => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  });
  await page.waitForTimeout(200);
}

// Click nx-dropdown and select an option by text
async function selectNxDropdown(page, name, optionText) {
  await page.locator(`nx-dropdown[name="${name}"]`).evaluate((el) => el.click());
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
    await page.getByRole('button', { name: /Nur erforderliche Cookies/i }).click({ timeout: 6000 });
    await page.waitForTimeout(800);
  } catch (_) {
    // Fallback: DOM-Remove
    await page.evaluate(() => document.getElementById('onetrust-consent-sdk')?.remove());
    await page.waitForTimeout(400);
  }
}

async function fillForm(page, data) {
  // 1. PLZ + Halter-Geburtsdatum
  await angularFill(page, '[name="plz"]', data.plz);
  await angularFill(page, '[name="geburtsdatum"]', data.geburtsdatumHalter);

  // 2. Tierart + Geschlecht Dropdowns
  await selectNxDropdown(page, 'animalType', mapTierartOption(data.tierart));
  await selectNxDropdown(page, 'animalGender', mapGeschlechtOption(data.geschlecht));

  // 3. Tiername + Tiergeburtsdatum
  await angularFill(page, '[name="animalName"]', data.tiername);
  await angularFill(page, '[name="animalBirthdate"]', data.geburtsdatumTier);

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
  await page.waitForTimeout(8000);
}

async function waitForResultArea(page) {
  await page.waitForSelector(
    '[class*="tarif"], [class*="produkt"], [class*="preis"], [class*="product"], [class*="price"]',
    { timeout: 20000 }
  );
}

async function saveResultScreenshot(page, downloadsDir) {
  ensureDir(downloadsDir);
  const screenshotPath = path.join(downloadsDir, `result_${Date.now()}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  return screenshotPath;
}

async function parseTarife(page) {
  // Strategie 1: Allianz TKV Ergebnisseite — Tarif-Cards direkt aus DOM
  const parsed = await page.evaluate(() => {
    const results = [];

    // Alle Preis-Matches aus dem Seitentext sammeln mit Kontext
    const allText = document.body.innerText || '';

    // Tarif-Namen die Allianz für TKV nutzt
    const tarifNamen = ['Basis', 'Smart', 'Komfort', 'Premium', 'OP-Schutz', 'Vollschutz'];

    // Preise + vorhergehenden Tarif-Namen extrahieren
    const lines = allText.split('\n').map(l => l.trim()).filter(Boolean);
    let currentTarif = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Tarif-Name gefunden?
      const isName = tarifNamen.find(n => line === n || line.startsWith(n + ' '));
      if (isName) { currentTarif = isName; continue; }

      // Preis-Zeile gefunden?
      const preisMatch = line.match(/^(\d{1,3}[.,]\d{2})\s*€/);
      if (preisMatch && currentTarif) {
        // Leistungen: nächste Zeilen bis zum nächsten Tarif-Namen
        const leistungen = [];
        for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
          if (tarifNamen.find(n => lines[j] === n || lines[j].startsWith(n + ' '))) break;
          if (lines[j].length > 5 && lines[j].length < 120) leistungen.push(lines[j]);
        }
        results.push({ name: currentTarif, preis: preisMatch[1] + ' €/Monat', leistungen: leistungen.slice(0, 5) });
        currentTarif = null;
      }
    }

    return results;
  });

  if (parsed.length > 0) return parsed;

  // Strategie 2: Alle Preise aus Seitentext
  const bodyText = await page.evaluate(() => document.body.innerText);
  const preisMatches = [...(bodyText || '').matchAll(/(\d{1,3}[.,]\d{2})\s*€\s*(?:monat(?:lich)?|\/\s*Monat)?/gi)];
  const uniquePreise = [...new Set(preisMatches.map(m => m[0].trim()))];

  if (uniquePreise.length > 0) {
    const namen = ['Basis', 'Smart', 'Komfort', 'Premium'];
    return uniquePreise.slice(0, 4).map((preis, idx) => ({
      name: namen[idx] || `Tarif ${idx + 1}`,
      preis,
      leistungen: []
    }));
  }

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

    // Warten bis JS-App geladen ist (Angular bootstrapping)
    await page.waitForTimeout(3000);

    // Cloudflare-Challenge prüfen
    const title = (await page.title()).toLowerCase();
    if (title.includes('challenge') || title.includes('just a moment')) {
      await page.waitForTimeout(10000);
      const finalTitle = (await page.title()).toLowerCase();
      if (finalTitle.includes('challenge')) {
        throw new Error(`Cloudflare-Blockade (Versuch ${config.attempt})`);
      }
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
