# Dealflow: Texas HVAC acquisition targets

Finds HVAC contractors in Texas, scores each one on **size** and **succession likelihood** (how likely the owner
is to sell in the next 1–5 years), and runs outreach from a password-protected dashboard on Cloudflare.

Live: https://dealflow.bendik-50e.workers.dev

## Data sources (all public, free)

| Source | What it gives |
|---|---|
| TDLR A/C contractor licenses (`ltairref.csv`) | Every licensed HVAC contractor: owner, business, county, class, endorsements, expiry. License number ≈ issue order |
| Comptroller franchise taxpayers (`9cir-efmm`) | Legal name, entity type, Secretary of State charter date, address |
| Comptroller sales tax permits, NAICS 238220 (`jrea-zgmq`) | Locations (outlets), first sale date, address |
| Google Places API (optional, `enrich-places.mjs`) | Website, phone, rating, **review count** (best public size proxy), closed status |
| Company websites (optional, `enrich-web.mjs`) | "Since 19xx", stale copyright, retirement mentions, truck/tech counts, emails |

TDLR leaves addresses and phone numbers out of its public data, so addresses come from the Comptroller match. About 85% of Mid/Large companies match.

## Scoring

**Succession (0–100):** estimated years licensed (from license number, calibrated against business start dates),
business age, owner-named business, single licensed owner, license lapsed, stale website, retirement mentions;
minus points when a younger family member holds a license or the site says "second generation".

**Size (0–100):** number of licensed contractors, locations, Class A license, both endorsements, entity type,
years established, Google reviews, trucks/technicians stated on the website.

**Fit** = 55% succession + 45% size. Excluded automatically: schools, cities, hospitals, manufacturers,
national service brands, property managers, out-of-state.

## Run it

```sh
node ingest/fetch.mjs                 # download sources into data/raw
node ingest/build.mjs                 # join, score → data/companies.json + data/seed.sql

# optional enrichment (cached in data/enrichment.json), then re-run build.mjs
GOOGLE_PLACES_API_KEY=... node ingest/enrich-places.mjs --limit 500 --min-fit 40
node ingest/enrich-web.mjs --limit 500

cd app && npm install
npm run db:seed                       # load data/seed.sql into D1 (pipeline notes are kept)
npm run deploy
```

First-time setup: `wrangler d1 create dealflow` (put the id in `app/wrangler.jsonc`), `npm run db:schema`,
`wrangler secret put DASHBOARD_PASSWORD`.

## Dashboard

- Filter by metro, size tier, succession score, entity vs sole proprietor, lapsed licenses, pipeline status
- Sort by fit, size, succession, oldest license, oldest business, number of licensed contractors
- Company drawer: score breakdown, licensees, Comptroller facts, research links, pipeline status and notes
- Outreach drafts per company (letter, 3-step email, call script) filled in from **Outreach settings**
- Exports: full CSV, Lob/PostGrid mailing list, Instantly/Smartlead leads (rows with an email)

## Outreach compliance

- Email: send from separate warmed-up domains, include a physical address and opt-out (CAN-SPAM).
- Phone: humans dial; no robocalls or AI voice without consent (TCPA); scrub against Do Not Call lists.
- LinkedIn: manual only; automation tools violate LinkedIn's terms.
