const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const { calculateOffer, normalizeInput } = require('./scraper/allianz-scraper');
const { calculatePrivatschutzOffer, normalizeInput: normalizePrivatschutzInput } = require('./scraper/privatschutz-scraper');
const { calculateViaAPI } = require('./scraper/privatschutz-api');
const { generateOfferCode } = require('./utils/code');
const { normalizePrivatschutzWebhook } = require('./utils/validation');

const app = express();
const PORT = Number(process.env.PORT || 3001);
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const DATA_DIR = path.join(__dirname, 'data');
const PRIVATSCHUTZ_STORE = path.join(DATA_DIR, 'privatschutz-offers.json');
const TKV_STORE = path.join(DATA_DIR, 'tkv-offers.json');
const CHECKOUTS_STORE = path.join(DATA_DIR, 'checkouts.json');
const META_VERIFY_TOKEN = 'allianz-privatschutz-2026-xK9m';
const FALLBACK_PUBLIC_BASE_URL = 'https://eating-boxes-sen-intl.trycloudflare.com';

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/downloads', express.static(DOWNLOADS_DIR));
app.use(express.static(path.join(__dirname, 'public')));

function ensureDataStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PRIVATSCHUTZ_STORE)) fs.writeFileSync(PRIVATSCHUTZ_STORE, JSON.stringify({}, null, 2));
  if (!fs.existsSync(TKV_STORE)) fs.writeFileSync(TKV_STORE, JSON.stringify({}, null, 2));
  if (!fs.existsSync(CHECKOUTS_STORE)) fs.writeFileSync(CHECKOUTS_STORE, JSON.stringify([], null, 2));
}

function readPrivatschutzOffers() {
  ensureDataStore();
  try {
    return JSON.parse(fs.readFileSync(PRIVATSCHUTZ_STORE, 'utf-8'));
  } catch (_) {
    return {};
  }
}

function savePrivatschutzOffer(code, payload) {
  const all = readPrivatschutzOffers();
  all[code] = {
    ...payload,
    code,
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(PRIVATSCHUTZ_STORE, JSON.stringify(all, null, 2));
  return all[code];
}

function getPrivatschutzOffer(code) {
  const all = readPrivatschutzOffers();
  return all[code] || null;
}

function readTKVOffers() {
  ensureDataStore();
  try {
    return JSON.parse(fs.readFileSync(TKV_STORE, 'utf-8'));
  } catch (_) {
    return {};
  }
}

function saveTKVOffer(code, payload) {
  const all = readTKVOffers();
  all[code] = {
    ...payload,
    code,
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(TKV_STORE, JSON.stringify(all, null, 2));
  return all[code];
}

function getTKVOffer(code) {
  const all = readTKVOffers();
  return all[code] || null;
}

function readCheckouts() {
  ensureDataStore();
  try {
    const raw = JSON.parse(fs.readFileSync(CHECKOUTS_STORE, 'utf-8'));
    return Array.isArray(raw) ? raw : [];
  } catch (_) {
    return [];
  }
}

function appendCheckout(entry) {
  const all = readCheckouts();
  all.push(entry);
  fs.writeFileSync(CHECKOUTS_STORE, JSON.stringify(all, null, 2));
  return entry;
}

function mapMetaPayloadToCalculateInput(payload = {}) {
  const data = payload.data || payload.form_data || payload.lead || payload;

  const pick = (...keys) => {
    for (const key of keys) {
      if (data[key] !== undefined && data[key] !== null && String(data[key]).trim() !== '') {
        return String(data[key]).trim();
      }
    }
    return '';
  };

  return {
    plz: pick('plz', 'postal_code', 'zip', 'postleitzahl'),
    geburtsdatum_halter: pick('geburtsdatum_halter', 'owner_birthdate', 'halter_geburtsdatum', 'dob_owner'),
    tierart: pick('tierart', 'pet_type', 'animal_type'),
    geschlecht: pick('geschlecht', 'pet_gender', 'gender'),
    tiername: pick('tiername', 'pet_name', 'name_pet'),
    geburtsdatum_tier: pick('geburtsdatum_tier', 'pet_birthdate', 'dob_pet', 'tier_geburtsdatum'),
    groesse: pick('groesse', 'gewicht', 'size', 'weight'),
    tarifPraferenz: pick('tarifPraferenz', 'tarif_praferenz', 'tarifpraeferenz', 'tarif_preference')
  };
}

function mapPrivatschutzPayload(payload = {}) {
  const data = payload.data || payload.form_data || payload.lead || payload;
  return normalizePrivatschutzWebhook(data);
}

function normalizeMetaFieldName(name = '') {
  return String(name)
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s\-]+/g, '_');
}

function mapMetaLeadFieldData(fieldData = []) {
  const aliasMap = {
    plz: ['plz', 'postal_code', 'postleitzahl'],
    wohnflaeche: ['wohnflaeche', 'wohnflache', 'wohnflaeche', 'living_space', 'qm'],
    familienstand: ['familienstand', 'family_status', 'haushalt'],
    geburtsdatum: ['geburtsdatum', 'birthdate', 'dob'],
    name: ['full_name', 'name'],
    telefon: ['phone_number', 'telefon'],
    email: ['email']
  };

  const normalizedAliases = Object.entries(aliasMap).reduce((acc, [targetKey, aliases]) => {
    acc[targetKey] = new Set(aliases.map(normalizeMetaFieldName));
    return acc;
  }, {});

  const mapped = {
    name: '',
    telefon: '',
    email: '',
    plz: '',
    wohnflaeche: '',
    familienstand: '',
    geburtsdatum: ''
  };

  for (const field of fieldData) {
    if (!field || !field.name) continue;

    const normalizedName = normalizeMetaFieldName(field.name);
    const values = Array.isArray(field.values) ? field.values : [];
    const value = values.length > 0 ? values[0] : field.value;
    const stringValue = value !== undefined && value !== null ? String(value).trim() : '';

    if (!stringValue) continue;

    for (const [targetKey, aliasSet] of Object.entries(normalizedAliases)) {
      if (aliasSet.has(normalizedName)) {
        mapped[targetKey] = stringValue;
        break;
      }
    }
  }

  return mapped;
}

async function callPrivatschutzCalculateEndpoint(input = {}) {
  const response = await fetch(`http://127.0.0.1:${PORT}/api/privatschutz/calculate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input)
  });

  const raw = await response.text();
  let json;

  try {
    json = raw ? JSON.parse(raw) : {};
  } catch (_) {
    json = { raw };
  }

  if (!response.ok) {
    const message = json?.message || json?.error || `calculate failed with status ${response.status}`;
    const err = new Error(message);
    err.status = response.status;
    err.details = json;
    throw err;
  }

  const code = json?.code || null;
  const publicBase = process.env.PUBLIC_BASE_URL || FALLBACK_PUBLIC_BASE_URL;
  const offerUrl = code ? `${publicBase}/privatschutz?code=${encodeURIComponent(code)}` : null;

  return {
    ok: true,
    code,
    offerUrl,
    result: json
  };
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'allianz-tkv', port: PORT });
});

// Scraping proxy — fetches external URLs and returns cleaned text
// Used by salesaipilot edge function to bypass cloud IP blocks
app.post('/api/scrape', async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ ok: false, error: 'url required' });
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    let response;
    try {
      response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
          'Cache-Control': 'no-cache',
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      return res.json({ ok: false, error: `HTTP ${response.status}` });
    }
    const html = await response.text();
    const content = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim()
      .slice(0, 15000);
    res.json({ ok: true, content });
  } catch (err) {
    res.json({ ok: false, error: String(err) });
  }
});

app.get('/api/test', async (_req, res) => {
  try {
    const testInput = normalizeInput({
      plz: '87435',
      geburtsdatum_halter: '01.01.1990',
      tierart: 'Hund',
      geschlecht: 'männlich',
      tiername: 'Max',
      geburtsdatum_tier: '15.06.2022',
      groesse: '21 - 30 kg',
      tarifPraferenz: 'OP-Schutz'
    });

    const result = await calculateOffer(testInput, {
      downloadsDir: DOWNLOADS_DIR,
      headless: process.env.PLAYWRIGHT_HEADLESS !== 'false'
    });

    res.json({
      source: 'api-test',
      input: testInput,
      result
    });
  } catch (error) {
    res.status(500).json({
      error: 'Test-Berechnung fehlgeschlagen',
      message: error.message,
      details: error.details || null
    });
  }
});

app.post('/api/calculate', async (req, res) => {
  try {
    const input = normalizeInput(req.body || {});
    const result = await calculateOffer(input, {
      downloadsDir: DOWNLOADS_DIR,
      headless: process.env.PLAYWRIGHT_HEADLESS !== 'false'
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: 'Berechnung fehlgeschlagen',
      message: error.message,
      details: error.details || null
    });
  }
});

app.post('/api/tkv/calculate', async (req, res) => {
  try {
    const normalized = normalizeInput(req.body || {});
    const result = await calculateOffer(normalized, {
      downloadsDir: DOWNLOADS_DIR,
      headless: process.env.PLAYWRIGHT_HEADLESS !== 'false'
    });

    const code = generateOfferCode();
    const saved = saveTKVOffer(code, {
      input: normalized,
      tarife: result.tarife,
      pdfPath: result.pdfPath || null,
      pdfUrl: result.pdfUrl || null
    });

    res.json({
      code,
      tarife: saved.tarife,
      input: saved.input,
      pdfUrl: saved.pdfUrl || null
    });
  } catch (error) {
    res.status(500).json({
      error: 'TKV-Berechnung fehlgeschlagen',
      message: error.message,
      details: error.details || null
    });
  }
});

// DEBUG: Gibt den Seiteninhalt nach Berechnung zurück (für Parsing-Diagnose)
app.post('/api/tkv/debug', async (req, res) => {
  const { chromium } = require('playwright');
  const Steel = require('steel-sdk').default;
  const STEEL_API_KEY = process.env.STEEL_API_KEY || 'ste-pIxkqYixVZlLJ9sV5TdyhrgdDHzNyYd8xIVULwn0WHvRLalLWWoURQAquc9PZYC8DQh5YwD2hhDhQwTPKin1YRCcTs5znwC9lqN';
  let browser, steelClient, steelSession;
  try {
    steelClient = new Steel({ steelAPIKey: STEEL_API_KEY });
    steelSession = await steelClient.sessions.create({ useProxy: true, solveCaptchas: true });
    const wsEndpoint = `wss://connect.steel.dev?apiKey=${STEEL_API_KEY}&sessionId=${steelSession.id}`;
    browser = await chromium.connectOverCDP(wsEndpoint);
    const contexts = browser.contexts();
    const context = contexts[0] || await browser.newContext();
    const page = await context.newPage();
    await page.goto('https://www.allianz.de/tier/tierkrankenversicherung/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);
    const title = await page.title();
    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 3000));
    const html = await page.evaluate(() => document.body.innerHTML.substring(0, 5000));
    await browser.close();
    await steelClient.sessions.release(steelSession.id);
    res.json({ title, bodyText, html });
  } catch (e) {
    try { if (steelClient && steelSession) await steelClient.sessions.release(steelSession.id); } catch {}
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/tkv/offer/:code', (req, res) => {
  const offer = getTKVOffer(req.params.code);
  if (!offer) {
    return res.status(404).json({ error: 'Angebot nicht gefunden' });
  }
  return res.json(offer);
});

app.get('/api/webhook/meta', (req, res) => {
  const mode = req.query['hub.mode'];
  const verifyToken = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && verifyToken === META_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.status(403).json({ ok: false, error: 'Webhook verification failed' });
});

app.post('/api/webhook/meta', async (req, res) => {
  try {
    const payload = req.body || {};
    const accessToken = process.env.META_PAGE_ACCESS_TOKEN;

    if (!accessToken) {
      console.warn('[meta-webhook] META_PAGE_ACCESS_TOKEN fehlt. Lead kann nicht via Graph API geladen werden.');
      return res.status(200).json({
        ok: true,
        ignored: true,
        reason: 'META_PAGE_ACCESS_TOKEN not set'
      });
    }

    const changes = Array.isArray(payload.entry)
      ? payload.entry.flatMap((entry) => Array.isArray(entry.changes) ? entry.changes : [])
      : [];

    const leadChanges = changes.filter((change) => change?.field === 'leadgen' && change?.value?.leadgen_id);

    if (leadChanges.length === 0) {
      return res.status(200).json({ ok: true, ignored: true, reason: 'No leadgen change found' });
    }

    const processed = [];

    for (const change of leadChanges) {
      const leadgenId = change.value.leadgen_id;
      const graphUrl = `https://graph.facebook.com/v19.0/${encodeURIComponent(leadgenId)}?access_token=${encodeURIComponent(accessToken)}`;

      const graphResponse = await fetch(graphUrl);
      const graphBody = await graphResponse.json().catch(() => ({}));

      if (!graphResponse.ok) {
        processed.push({
          ok: false,
          leadgenId,
          error: graphBody?.error?.message || `Graph API Fehler (${graphResponse.status})`
        });
        continue;
      }

      const mapped = mapMetaLeadFieldData(graphBody.field_data || []);

      try {
        const calc = await callPrivatschutzCalculateEndpoint(mapped);
        processed.push({
          ok: true,
          leadgenId,
          mapped,
          code: calc.code,
          offerUrl: calc.offerUrl
        });
      } catch (calcError) {
        processed.push({
          ok: false,
          leadgenId,
          mapped,
          error: calcError.message,
          details: calcError.details || null
        });
      }
    }

    return res.status(200).json({ ok: true, processed });
  } catch (error) {
    return res.status(500).json({
      error: 'Webhook Verarbeitung fehlgeschlagen',
      message: error.message,
      details: error.details || null
    });
  }
});

app.post('/api/webhook/meta/test', async (req, res) => {
  try {
    const mapped = mapPrivatschutzPayload(req.body || {});
    const calc = await callPrivatschutzCalculateEndpoint(mapped);

    return res.json({
      ok: true,
      code: calc.code,
      offerUrl: calc.offerUrl
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'Meta Test-Webhook Verarbeitung fehlgeschlagen',
      message: error.message,
      details: error.details || null
    });
  }
});

app.post('/api/privatschutz/calculate', async (req, res) => {
  try {
    const normalized = normalizePrivatschutzInput(req.body || {});

    // Erst direkte GraphQL API versuchen (schnell, ~2s)
    let result;
    try {
      const apiResult = await calculateViaAPI(normalized);
      result = { input: normalized, tarife: apiResult, addons: apiResult.addons, meta: apiResult._meta };
      console.log('[calculate] GraphQL API erfolgreich:', apiResult._meta?.city);
    } catch (apiErr) {
      console.warn('[calculate] GraphQL API fehlgeschlagen, Fallback auf Playwright:', apiErr.message);
      result = await calculatePrivatschutzOffer(normalized, {
        downloadsDir: DOWNLOADS_DIR,
        headless: process.env.PLAYWRIGHT_HEADLESS !== 'false'
      });
    }

    const code = generateOfferCode();
    const saved = savePrivatschutzOffer(code, {
      input: result.input,
      tarife: result.tarife,
      addons: result.addons,
      meta: result.meta || null,
      debug: result.debug || null
    });

    res.json({
      code,
      tarife: saved.tarife,
      addons: saved.addons,
      input: saved.input
    });
  } catch (error) {
    res.status(500).json({
      error: 'Privatschutz-Berechnung fehlgeschlagen',
      message: error.message,
      details: error.details || null
    });
  }
});

app.get('/api/privatschutz/offer/:code', (req, res) => {
  const offer = getPrivatschutzOffer(req.params.code);
  if (!offer) {
    return res.status(404).json({ error: 'Angebot nicht gefunden' });
  }
  return res.json(offer);
});

app.post('/api/checkout/submit', async (req, res) => {
  try {
    const body = req.body || {};

    const checkoutEntry = {
      id: `CO-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      timestamp: new Date().toISOString(),
      code: body.code || null,
      plan: body.plan || null,
      kunde: body.kunde || {},
      zusatzbausteine: body.zusatzbausteine || {}
    };

    appendCheckout(checkoutEntry);

    return res.json({
      ok: true,
      message: 'Vielen Dank! Wir melden uns bei Ihnen.',
      id: checkoutEntry.id
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'Checkout konnte nicht gespeichert werden',
      message: error.message,
      details: error.details || null
    });
  }
});

app.post('/api/webhook/privatschutz', async (req, res) => {
  try {
    const mapped = mapPrivatschutzPayload(req.body || {});
    const normalized = normalizePrivatschutzInput(mapped);

    const result = await calculatePrivatschutzOffer(normalized, {
      downloadsDir: DOWNLOADS_DIR,
      headless: process.env.PLAYWRIGHT_HEADLESS !== 'false'
    });

    const code = generateOfferCode();
    savePrivatschutzOffer(code, {
      input: result.input,
      tarife: result.tarife,
      addons: result.addons,
      meta: result.meta || null,
      debug: result.debug || null,
      source: 'webhook-privatschutz'
    });

    const offerUrl = `http://localhost:${PORT}/privatschutz?code=${encodeURIComponent(code)}`;

    res.json({ offerUrl, code });
  } catch (error) {
    res.status(500).json({
      error: 'Privatschutz-Webhook Verarbeitung fehlgeschlagen',
      message: error.message,
      details: error.details || null
    });
  }
});

app.get('/privatschutz', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/checkout', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'checkout.html'));
});

app.get('/calculator', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'calculator.html'));
});

app.get('/tkv', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tkv-offer.html'));
});

app.get('/tkv-calculator', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tkv-calculator.html'));
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Allianz Privatschutz Server läuft auf http://localhost:${PORT}`);
  });
}

module.exports = {
  app,
  mapPrivatschutzPayload,
  mapMetaPayloadToCalculateInput,
  mapMetaLeadFieldData,
  normalizeMetaFieldName
};
