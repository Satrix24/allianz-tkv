# Allianz TKV Rechner (Backend + Frontend)

Vollständiges Projekt für Allianz Tierkrankenversicherung:

- **Backend**: Express API mit Playwright-Scraping (inkl. Retry und Error-Artefakten)
- **Frontend**: Angebotsrechner (HTML/CSS/JS) im Allianz-Style
- **Webhook**: `/api/webhook/meta` für zukünftige Make.com / Meta Instant Form Integration

## Projektstruktur

```text
allianz-tkv/
├── package.json
├── server.js
├── scraper/
│   └── allianz-scraper.js
├── public/
│   ├── index.html
│   ├── style.css
│   └── app.js
├── downloads/
│   └── errors/
└── README.md
```

## API

### `POST /api/calculate`

Input:

```json
{
  "plz": "87435",
  "geburtsdatum_halter": "12.12.2002",
  "tierart": "Hund",
  "geschlecht": "männlich",
  "tiername": "Max",
  "geburtsdatum_tier": "12.12.2022",
  "groesse": "- 120 cm"
}
```

Output (Beispiel):

```json
{
  "tarife": [
    {
      "name": "OP-Schutz",
      "preis": "29,99 €",
      "leistungen": ["..."]
    }
  ],
  "angebot_code": "ANG-1710000000000",
  "pdf_url": null
}
```

### `POST /api/webhook/meta`

- Nimmt flexible JSON-Payloads entgegen
- mapped Feldnamen auf den `calculate`-Input
- liefert direkt Ergebnis zurück

## Start

```bash
cd /Users/openclaw/.openclaw/workspace/allianz-tkv
npm install
node server.js
```

Server läuft auf `http://localhost:3001`.

## Hinweise

- Anti-Bot: `playwright-extra` + `puppeteer-extra-plugin-stealth`
- Fallback-Anti-Detection via Chromium-Launch-Args + random User-Agent
- Max. 3 Retries
- Bei Fehlern werden Screenshots + HTML in `downloads/errors/` gespeichert
- Für lokale Tests kann `PLAYWRIGHT_HEADLESS=false` gesetzt werden

## Test-Healthcheck

```bash
curl http://localhost:3001/api/health
```
