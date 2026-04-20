#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { calculateViaAPI } = require('../scraper/privatschutz-api');
const { calculatePrivatschutzOffer } = require('../scraper/privatschutz-scraper');

const TEST_CASES = [
  { name: 'München', plz: '80331', wohnflaeche: 75, familienstand: 'Single', geburtsdatum: '01.01.1990' },
  { name: 'Berlin', plz: '10115', wohnflaeche: 60, familienstand: 'Paar', geburtsdatum: '15.03.1985' },
  { name: 'Hamburg', plz: '20095', wohnflaeche: 100, familienstand: 'Familie', geburtsdatum: '20.07.1978' }
];

const PLANS = ['Basis', 'Smart', 'Komfort'];

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

function pctDiff(apiValue, scraperValue) {
  if (!Number.isFinite(apiValue) || !Number.isFinite(scraperValue)) return null;
  if (scraperValue === 0) return null;
  return round2(((apiValue - scraperValue) / scraperValue) * 100);
}

function getGesamtFromApiResult(result, plan) {
  if (!result) return null;

  // calculateViaAPI direkt
  if (result[plan] && Number.isFinite(Number(result[plan].gesamt))) {
    return Number(result[plan].gesamt);
  }

  // Falls doch server-wrap genutzt wird
  if (result.tarife?.[plan] && Number.isFinite(Number(result.tarife[plan].gesamt))) {
    return Number(result.tarife[plan].gesamt);
  }

  return null;
}

function getGesamtFromScraperResult(result, plan) {
  if (!result) return null;
  if (result.tarife?.[plan] && Number.isFinite(Number(result.tarife[plan].gesamt))) {
    return Number(result.tarife[plan].gesamt);
  }
  if (result[plan] && Number.isFinite(Number(result[plan].gesamt))) {
    return Number(result[plan].gesamt);
  }
  return null;
}

async function run() {
  const startedAt = new Date();
  const rows = [];
  const detailed = [];

  for (const tc of TEST_CASES) {
    console.log(`\n🔎 Prüfe ${tc.name} (${tc.plz}, ${tc.wohnflaeche}m², ${tc.familienstand}, ${tc.geburtsdatum})`);

    let apiResult;
    let scraperResult;

    try {
      apiResult = await calculateViaAPI(tc);
    } catch (err) {
      console.error(`❌ API Fehler bei ${tc.name}: ${err.message}`);
      detailed.push({
        testCase: tc,
        error: { source: 'api', message: err.message, details: err.details || null }
      });
      continue;
    }

    try {
      scraperResult = await calculatePrivatschutzOffer(tc, {
        headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
        downloadsDir: path.join(process.cwd(), 'downloads')
      });
    } catch (err) {
      console.error(`❌ Scraper Fehler bei ${tc.name}: ${err.message}`);
      detailed.push({
        testCase: tc,
        api: apiResult,
        error: { source: 'scraper', message: err.message, details: err.details || null }
      });
      continue;
    }

    const perPlan = {};

    for (const plan of PLANS) {
      const apiGesamt = getGesamtFromApiResult(apiResult, plan);
      const scraperGesamt = getGesamtFromScraperResult(scraperResult, plan);
      const diffPercent = pctDiff(apiGesamt, scraperGesamt);
      const absDiff = Number.isFinite(apiGesamt) && Number.isFinite(scraperGesamt)
        ? round2(apiGesamt - scraperGesamt)
        : null;
      const isWarning = Number.isFinite(diffPercent) ? Math.abs(diffPercent) > 3 : true;
      const status = isWarning ? '⚠️ WARNUNG' : '✅ OK';

      rows.push({
        Testfall: tc.name,
        Tarif: plan,
        API: apiGesamt,
        Scraper: scraperGesamt,
        'Diff €': absDiff,
        'Diff %': diffPercent,
        Status: status
      });

      perPlan[plan] = {
        api: apiGesamt,
        scraper: scraperGesamt,
        diffEuro: absDiff,
        diffPercent,
        status
      };
    }

    detailed.push({
      testCase: tc,
      source: {
        api: apiResult?._meta?.source || 'graphql-api',
        scraper: scraperResult?.meta?.source || scraperResult?.debug?.error ? 'fallback-or-error' : 'playwright'
      },
      comparison: perPlan,
      apiMeta: apiResult?._meta || null,
      scraperMeta: scraperResult?.meta || null,
      scraperDebug: scraperResult?.debug || null
    });
  }

  console.log('\n📊 Vergleichstabelle');
  console.table(rows);

  const now = new Date();
  const dateStamp = now.toISOString().slice(0, 10);
  const timeStamp = now.toISOString().replace(/[:]/g, '-').replace(/\..+$/, '');
  const outPath = `/tmp/price-validation-${timeStamp}.json`;

  const payload = {
    startedAt: startedAt.toISOString(),
    finishedAt: now.toISOString(),
    testCases: TEST_CASES,
    rows,
    detailed
  };

  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`✅ Ergebnis gespeichert: ${outPath}`);
  console.log(`ℹ️ Tagesstempel: ${dateStamp}`);
}

run().catch((err) => {
  console.error('❌ validate-prices failed:', err);
  process.exitCode = 1;
});
