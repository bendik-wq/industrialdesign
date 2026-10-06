# Dealflow

Finds acquisition targets in official company registries and scores each company on **how likely the owner
is to sell** and **how much business there is to buy**.

Live: https://dealflow.bendik-50e.workers.dev (password login; scripts use `Authorization: Bearer <API_TOKEN>`)

## Coverage

| Country | Source | Owner age | Size | Founded | Revenue | Key |
|---|---|---|---|---|---|---|
| 🇫🇷 France | recherche-entreprises.api.gouv.fr (INSEE Sirene + RNE) | director birth year | headcount band, sites | ✅ | when filed publicly | none |
| 🇳🇴 Norway | Brønnøysund Enhetsregisteret + roles + Regnskapsregisteret | exact birth date | exact headcount | ✅ | filed accounts | none |
| 🇬🇧 UK | Companies House | director birth month/year | size class from filed accounts | ✅ | – | `COMPANIES_HOUSE_API_KEY` (free) |
| 🇺🇸 US | Google Places (any city) + Texas TDLR license data | Texas: license tenure | reviews, Texas licensees | Texas | – | `GOOGLE_PLACES_API_KEY` |

21 industries are mapped to each country's official activity codes in `app/src/data/industries.js`
(NAF rév. 2, SN2025, SIC 2007).

## Scoring (`app/src/scoring.js`)

- **Succession (55%)**: owner age (60+ scores high), company age, a single person on record, owner's name on
  the company, Texas license tenure; minus points when a younger family member is already in management.
- **Size (45%)**: headcount, sites, revenue, Google review volume, Texas licensed contractors.
- **Verdict**: Strong target (65+), Worth a call (50+), Watch list (35+), Long shot. 250+ staff is flagged as too
  big for most buyers.

## How a search runs

`POST /api/searches` stores the search and starts a Cloudflare Workflow (`app/src/workflow.js`). It fetches the
registry page by page, scores each company and upserts it into D1. Each batch is a durable, retried step,
with a short sleep between batches so every batch gets a fresh subrequest budget. Failed searches resume from
the last saved page (`POST /api/searches/:id/retry`).

## API

`GET /api` lists every endpoint. Main ones:

```
GET  /api/sources                          countries, regions, industries
POST /api/searches                         {"country":"fr","industry":"hvac","region":"69","minStaff":6}
GET  /api/companies?search=2&minOwnerAge=60&sort=fit
GET  /api/companies/:id                    people, signals, pipeline
PUT  /api/companies/:id/pipeline           {"status":"Contacted","notes":"…"}
GET  /api/export.csv?search=2&format=mail  full | mail | email
```

## Deploy

```sh
cd app && npm install
npx wrangler d1 execute dealflow --remote --file schema.sql      # first time only: drops and recreates tables
npx wrangler deploy
npx wrangler secret put DASHBOARD_PASSWORD
npx wrangler secret put API_TOKEN
npx wrangler secret put COMPANIES_HOUSE_API_KEY                   # optional: enables UK
npx wrangler secret put GOOGLE_PLACES_API_KEY                     # optional: enables US
```

Texas license data (optional, US only): `node ingest/fetch.mjs && node ingest/build.mjs && node ingest/export-v2.mjs`,
then `npx wrangler d1 execute dealflow --remote --file ../data/seed-tx.sql` from `app/`.

## Outreach

Every company has a letter, a 3-step email sequence and a call script, filled in from "Outreach settings".
Email needs separate warmed-up sending domains, a postal address and an opt-out. Phone calls are made by people,
not robocalls or AI voices, and numbers are checked against national do-not-call lists. French and Norwegian
owners respond far better in their own language.
