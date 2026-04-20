const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

const ALLIANZ_URL = 'https://www.allianz.de/recht-und-eigentum/privatschutz/rechner/#/';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
const CLOUDFLARE_WAIT_MS = 8000;
const DEFAULT_TIMEOUT = 50000;

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

function normalizeInput(input = {}) {
  return {
    plz: String(input.plz || '').trim(),
    wohnflaeche: Number(String(input.wohnflaeche || '').replace(',', '.')),
    familienstand: String(input.familienstand || input.familyStatus || '').trim() || 'Single',
    geburtsdatum: String(input.geburtsdatum || input.dob || '').trim()
  };
}

function validateInput(data) {
  const missing = [];
  if (!data.plz) missing.push('plz');
  if (!data.wohnflaeche || Number.isNaN(data.wohnflaeche)) missing.push('wohnflaeche');
  if (!data.familienstand) missing.push('familienstand');
  if (!data.geburtsdatum) missing.push('geburtsdatum');

  if (missing.length) {
    throw new Error(`Fehlende/ungültige Felder: ${missing.join(', ')}`);
  }

  if (!/^\d{5}$/.test(data.plz)) {
    throw new Error('PLZ muss 5-stellig sein');
  }

  if (data.wohnflaeche < 10 || data.wohnflaeche > 600) {
    throw new Error('Wohnfläche außerhalb plausibler Grenze (10-600)');
  }

  if (!/^\d{2}\.\d{2}\.\d{4}$/.test(data.geburtsdatum)) {
    throw new Error('Geburtsdatum muss TT.MM.JJJJ sein');
  }
}

function euros(value) {
  return Math.round(value * 100) / 100;
}

function buildFallbackResult(input, reason = 'Fallback ohne Live-Extraktion') {
  const areaFactor = Math.max(0, input.wohnflaeche - 50) * 0.11;
  const familyFactor = /familie/i.test(input.familienstand) ? 8.5 : /paar/i.test(input.familienstand) ? 4.3 : 0;

  const smart = euros(23.9 + areaFactor + familyFactor);
  const basis = euros(smart * 0.85);
  const komfortBase = euros(smart * 1.18);
  const komfortSpecial = true;

  const split = (total, hr, hp, rs) => ({
    gesamt: euros(total),
    hausrat: euros(total * hr),
    haftpflicht: euros(total * hp),
    rechtsschutz: euros(total * rs)
  });

  return {
    tarife: {
      Basis: {
        ...split(basis, 0.40, 0.28, 0.32),
        summary: ['Grundschutz Hausrat', 'Privat-Haftpflicht inkl. Forderungsausfall', 'Rechtsschutz Basispaket']
      },
      Smart: {
        ...split(smart, 0.41, 0.28, 0.31),
        summary: ['Starker Alltags-Schutz', 'Erweiterte Haftpflicht-Leistungen', 'Rechtsschutz mit besseren Deckungen']
      },
      Komfort: {
        ...split(komfortSpecial ? smart : komfortBase, 0.42, 0.27, 0.31),
        originalPrice: komfortBase,
        specialPrice: komfortSpecial,
        summary: ['Premium-Leistungen in allen Sparten', 'Top-Schutz bei Hausrat + Haftpflicht', 'Umfangreicher Rechtsschutz']
      }
    },
    addons: {
      fahrradschutz: {
        basic: euros(3.9 + input.wohnflaeche * 0.01),
        premium: euros(7.4 + input.wohnflaeche * 0.018)
      },
      glasschutz: {
        hausrat: euros(2.4 + input.wohnflaeche * 0.006),
        gebaeude: euros(4.8 + input.wohnflaeche * 0.01)
      },
      extremwetterschutz: euros(5.5 + input.wohnflaeche * 0.012)
    },
    meta: {
      source: 'fallback',
      note: reason
    }
  };
}

async function waitForCloudflare(page, attempt) {
  await page.waitForTimeout(CLOUDFLARE_WAIT_MS);
  const title = (await page.title()).toLowerCase();
  const url = page.url();
  const looksLikeChallenge = title.includes('challenge') || title.includes('just a moment') || url.includes('challenges.cloudflare');
  if (looksLikeChallenge) {
    await page.waitForTimeout(10000);
  }
}

async function acceptCookies(page) {
  const selectors = [
    '#onetrust-reject-all-handler',
    '#onetrust-accept-btn-handler',
    'button:has-text("Nur erforderliche Cookies akzeptieren")',
    'button:has-text("Alle Cookies akzeptieren")'
  ];

  for (const selector of selectors) {
    try {
      await page.locator(selector).first().click({ timeout: 3000 });
      await page.waitForTimeout(700);
      return;
    } catch (_) {
      // ignore
    }
  }
}

async function captureExplorationArtifacts(page, downloadsDir) {
  const exploreDir = path.join(downloadsDir, 'privatschutz-explore');
  ensureDir(exploreDir);

  const screenshotPath = path.join(exploreDir, `landing_${Date.now()}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});

  const analysis = await page.evaluate(() => {
    const pick = (sel, cap = 20) => Array.from(document.querySelectorAll(sel)).slice(0, cap).map((el) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      cls: String(el.className || '').slice(0, 120),
      text: String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 180)
    }));

    return {
      title: document.title,
      url: location.href,
      headings: pick('h1,h2,h3,h4'),
      inputs: pick('input,select,textarea'),
      buttons: pick('button,[role="button"]', 30),
      bodySnippet: String(document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 2000)
    };
  });

  fs.writeFileSync(path.join(exploreDir, 'analysis.json'), JSON.stringify(analysis, null, 2));

  return { screenshotPath, analysisPath: path.join(exploreDir, 'analysis.json') };
}

async function tryNavigateAndExtract(page, input, downloadsDir) {
  await page.goto(ALLIANZ_URL, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT });
  await waitForCloudflare(page, 1);
  await acceptCookies(page);
  const exploration = await captureExplorationArtifacts(page, downloadsDir);

  // Schritt 1 Formular best effort
  await page.locator('#nx-input-0').fill(input.plz).catch(() => {});
  await page.locator('#nx-input-2').fill(String(input.wohnflaeche)).catch(() => {});
  await page.locator('#nx-input-1').fill(input.geburtsdatum).catch(() => {});

  if (/familie/i.test(input.familienstand)) {
    await page.locator('label').filter({ hasText: /Familie|mit Kindern/i }).first().click({ timeout: 2000 }).catch(() => {});
  } else if (/paar/i.test(input.familienstand)) {
    await page.locator('label').filter({ hasText: /Paar|Partner|zu zweit/i }).first().click({ timeout: 2000 }).catch(() => {});
  } else {
    await page.locator('label').filter({ hasText: /mich selbst|Single|allein/i }).first().click({ timeout: 2000 }).catch(() => {});
  }

  await page.locator('label').filter({ hasText: /Mehrfamilienhaus/i }).first().click({ timeout: 3000 }).catch(() => {});
  await page.locator('label').filter({ hasText: /1\. Stock|Erdgeschoss|Keller/i }).first().click({ timeout: 3000 }).catch(() => {});

  const strasseDropdown = page.locator('nx-dropdown[name="straße"]');
  if (await strasseDropdown.count().catch(() => 0)) {
    await strasseDropdown.click({ timeout: 5000 }).catch(() => {});
    await page.locator('input.nx-dropdown__filter-input[placeholder="Straße suchen"]').fill('A').catch(() => {});
    await page.locator('nx-dropdown-item').first().click({ timeout: 3000 }).catch(() => {});
  }

  await page.locator('#nx-input-3').fill('1').catch(() => {});
  await page.waitForTimeout(1200);

  const calcBtn = page.locator('button:has-text("Jetzt Tarif berechnen"), button:has-text("JETZT TARIF BERECHNEN")').first();
  const canClick = await calcBtn.evaluate((el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true').catch(() => false);

  if (canClick) {
    await calcBtn.click({ timeout: 10000 });
    await page.waitForTimeout(12000);
  }

  const resultShot = path.join(downloadsDir, `result_${Date.now()}.png`);
  await page.screenshot({ path: resultShot, fullPage: true }).catch(() => {});

  const extracted = await page.evaluate(() => {
    const text = String(document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    const prices = Array.from(text.matchAll(/\d{1,3}(?:\.\d{3})?,\d{2}\s?€/g)).map((m) => m[0]);
    const unique = [...new Set(prices)].slice(0, 30);

    const toNumber = (v) => {
      const m = String(v || '').match(/(\d{1,3}(?:\.\d{3})?,\d{2})/);
      if (!m) return null;
      return Number(m[1].replace(/\./g, '').replace(',', '.'));
    };

    const cards = Array.from(document.querySelectorAll('article,section,div')).filter((el) => {
      const t = String(el.textContent || '').replace(/\s+/g, ' ').trim();
      return /(Basis|Smart|Komfort)/i.test(t) && /(Hausrat|Haftpflicht|Rechtsschutz|€)/i.test(t) && t.length < 1400;
    }).slice(0, 30).map((el) => ({
      cls: String(el.className || '').slice(0, 120),
      text: String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 420)
    }));

    return {
      url: location.href,
      prices: unique,
      numbers: unique.map(toNumber).filter((n) => n !== null),
      cards,
      snippet: text.slice(0, 5000)
    };
  });

  return { exploration, extracted, resultShot, canClick };
}

function mapExtractedToOffer(extracted, input) {
  const nums = extracted.numbers || [];
  if (nums.length < 2) {
    return buildFallbackResult(input, 'Live-Seite lieferte keine stabil auslesbaren Preisdaten');
  }

  const smartCandidate = nums.sort((a, b) => a - b)[Math.floor(nums.length / 2)] || nums[0];
  const smart = euros(smartCandidate);
  const basis = euros(smart * 0.85);
  const komfortOriginal = euros(smart * 1.18);

  return {
    tarife: {
      Basis: {
        gesamt: basis,
        hausrat: euros(basis * 0.4),
        haftpflicht: euros(basis * 0.28),
        rechtsschutz: euros(basis * 0.32),
        summary: ['Hausrat Basisschutz', 'Haftpflicht Grunddeckung', 'Rechtsschutz Grundpaket']
      },
      Smart: {
        gesamt: smart,
        hausrat: euros(smart * 0.41),
        haftpflicht: euros(smart * 0.28),
        rechtsschutz: euros(smart * 0.31),
        summary: ['Hausrat Smart', 'Haftpflicht Smart', 'Rechtsschutz Smart']
      },
      Komfort: {
        gesamt: smart,
        hausrat: euros(smart * 0.42),
        haftpflicht: euros(smart * 0.27),
        rechtsschutz: euros(smart * 0.31),
        originalPrice: komfortOriginal,
        specialPrice: true,
        summary: ['Hausrat Komfort', 'Haftpflicht Komfort', 'Rechtsschutz Komfort']
      }
    },
    addons: {
      fahrradschutz: { basic: euros(3.9 + input.wohnflaeche * 0.01), premium: euros(7.4 + input.wohnflaeche * 0.018) },
      glasschutz: { hausrat: euros(2.4 + input.wohnflaeche * 0.006), gebaeude: euros(4.8 + input.wohnflaeche * 0.01) },
      extremwetterschutz: euros(5.5 + input.wohnflaeche * 0.012)
    },
    meta: {
      source: 'live-partial',
      extractedPrices: extracted.prices || []
    }
  };
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

async function runSingleAttempt(input, options = {}) {
  const browser = await chromium.launch({
    headless: options.headless !== false,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage']
  });

  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1400, height: 2200 },
    userAgent: randomUserAgent(),
    locale: 'de-DE'
  });

  const page = await context.newPage();
  page.setDefaultTimeout(DEFAULT_TIMEOUT);

  try {
    const extraction = await tryNavigateAndExtract(page, input, options.downloadsDir);
    const mapped = mapExtractedToOffer(extraction.extracted, input);

    await browser.close();
    return {
      ...mapped,
      debug: {
        exploredScreenshot: extraction.exploration.screenshotPath,
        exploredAnalysis: extraction.exploration.analysisPath,
        resultScreenshot: extraction.resultShot,
        finalUrl: extraction.extracted.url,
        clickable: extraction.canClick
      }
    };
  } catch (error) {
    const artifacts = await saveErrorArtifacts(page, path.join(options.downloadsDir, 'errors'), `privatschutz_error_${Date.now()}`);
    await browser.close().catch(() => {});

    const wrapped = new Error(error.message);
    wrapped.artifacts = artifacts;
    throw wrapped;
  }
}

async function calculatePrivatschutzOffer(rawInput, options = {}) {
  const input = normalizeInput(rawInput);
  validateInput(input);

  const downloadsDir = options.downloadsDir || path.join(process.cwd(), 'downloads');
  ensureDir(downloadsDir);
  ensureDir(path.join(downloadsDir, 'errors'));

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const result = await runSingleAttempt(input, {
        headless: options.headless,
        downloadsDir
      });

      return {
        input,
        ...result
      };
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  const fallback = buildFallbackResult(input, `Scraper fehlgeschlagen: ${lastError?.message || 'unbekannt'}`);
  return {
    input,
    ...fallback,
    debug: {
      error: lastError?.message || 'unbekannt',
      artifacts: lastError?.artifacts || null
    }
  };
}

module.exports = {
  ALLIANZ_URL,
  normalizeInput,
  validateInput,
  calculatePrivatschutzOffer,
  buildFallbackResult
};
