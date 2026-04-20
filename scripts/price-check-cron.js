#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { calculateViaAPI } = require('../scraper/privatschutz-api');

const INPUT = {
  plz: '80331',
  wohnflaeche: 75,
  familienstand: 'Single',
  geburtsdatum: '01.01.1990'
};

const HISTORY_PATH = path.join(process.cwd(), 'data', 'price-history.json');
const ALERT_PATH = '/tmp/price-alert.json';
const MAX_ENTRIES = 30;
const ALERT_THRESHOLD_PERCENT = 5;

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

function readHistory() {
  try {
    if (!fs.existsSync(HISTORY_PATH)) return [];
    const raw = fs.readFileSync(HISTORY_PATH, 'utf8');
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function ensureDataDir() {
  const dir = path.dirname(HISTORY_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function pctChange(prev, curr) {
  if (!Number.isFinite(prev) || !Number.isFinite(curr) || prev === 0) return null;
  return round2(((curr - prev) / prev) * 100);
}

async function run() {
  const api = await calculateViaAPI(INPUT);

  const entry = {
    date: new Date().toISOString().slice(0, 10),
    Basis: round2(api?.Basis?.gesamt),
    Smart: round2(api?.Smart?.gesamt),
    Komfort: round2(api?.Komfort?.gesamt),
    input: INPUT
  };

  ensureDataDir();
  const history = readHistory();
  const last = history.length ? history[history.length - 1] : null;

  history.push(entry);
  const trimmed = history.slice(-MAX_ENTRIES);
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(trimmed, null, 2));

  let alert = null;

  if (last) {
    const changes = {
      Basis: pctChange(last.Basis, entry.Basis),
      Smart: pctChange(last.Smart, entry.Smart),
      Komfort: pctChange(last.Komfort, entry.Komfort)
    };

    const triggeredPlans = Object.entries(changes)
      .filter(([, pct]) => Number.isFinite(pct) && Math.abs(pct) > ALERT_THRESHOLD_PERCENT)
      .map(([plan, pct]) => ({ plan, percentChange: pct, previous: last[plan], current: entry[plan] }));

    if (triggeredPlans.length > 0) {
      alert = {
        createdAt: new Date().toISOString(),
        thresholdPercent: ALERT_THRESHOLD_PERCENT,
        input: INPUT,
        previous: last,
        current: entry,
        triggeredPlans
      };
      fs.writeFileSync(ALERT_PATH, JSON.stringify(alert, null, 2));
    }
  }

  console.log(JSON.stringify({
    ok: true,
    historyPath: HISTORY_PATH,
    entries: trimmed.length,
    latest: entry,
    alertWritten: Boolean(alert),
    alertPath: alert ? ALERT_PATH : null
  }, null, 2));
}

run().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message, details: err.details || null }, null, 2));
  process.exitCode = 1;
});
