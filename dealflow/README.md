# Dealflow

Finds acquisition targets in official company registries and scores each company on **how likely the owner
is to sell** and **how much business there is to buy**.

Live: https://dealflow.bendik-50e.workers.dev (email login, invite-only; scripts and MCP use a personal API token from the Team page)

## Coverage

| Country | Source | Owner age | Size | Founded | Revenue | Key |
|---|---|---|---|---|---|---|
| 🇫🇷 France | recherche-entreprises.api.gouv.fr (INSEE Sirene + RNE) | director birth year | headcount band, sites | ✅ | when filed publicly | none |
| 🇳🇴 Norway | Brønnøysund Enhetsregisteret + roles + Regnskapsregisteret | exact birth date | exact headcount | ✅ | filed accounts | none |
| 🇬🇧 UK | Companies House | director birth month/year | size class from filed accounts | ✅ | – | `COMPANIES_HOUSE_API_KEY` (free) |
| 🇺🇸 US | Google Places (any city) + Texas TDLR license data | Texas: license tenure | reviews, Texas licensees | Texas | – | `GOOGLE_PLACES_API_KEY` |

21 industries are mapped to each country's official activity codes in `app/src/data/industries.js`
(NAF rév. 2, SN2025, SIC 2007).

## What makes it different

- **Deal engine** (`app/public/deal.js`, shared by browser, API and MCP): values each company from its own filed
  accounts (Norway: operating profit, cash, debt; France: net income or revenue), then tests three seller-finance
  structures year by year against a 1.5× debt-service-coverage bar. It shows fair value *and* the highest price the
  company's own cash flow can fund, and prints a non-binding indicative offer.
- **AI brief and owner letter** (`app/src/ai.js`): one-page acquisition brief and a personal letter in the owner's
  own language (French, Norwegian, English). Uses Claude when `ANTHROPIC_API_KEY` is set, otherwise Cloudflare
  Workers AI with no key. Cached per company.
- **Seller valuation page** (`/value`, public): an owner types their company number, sees an instant valuation
  from their filings, and can ask to talk to a buyer. They land in the pipeline as an inbound seller.
- **MCP server** (`/mcp`, `app/src/mcp.js`): the buyer's own Claude can search registries, value deals, write
  briefs and update the pipeline. Add it as a remote MCP server with header `Authorization: Bearer <your API token>`; it only sees your account.
- **Print batch** (`/print.html`): print-ready letters, one per page, for the top targets of any search.
- **Agents** (`app/src/agents.js`, `app/src/agentflow.js`): describe a goal in plain English, typed or spoken
  ("every week find HVAC owners over 60 around Lyon worth €1–5M, letters in the JL voice"). It becomes an explicit,
  editable plan (source → shortlist → value → brief → letter → pipeline → report) that runs as a durable Cloudflare
  Workflow, logs every step, never re-works the same company, and repeats daily or weekly via an hourly cron.
  The model only fills a small schema; a deterministic parser and real region lookups (geo.api.gouv.fr, Kartverket)
  validate everything it returns.
- **Voice**: dictate goals or call notes (Workers AI Whisper). Call notes are turned into structured pipeline data:
  intent, timeline, asking price, numbers, concerns, next step and stage. Briefs can be read aloud (Deepgram Aura).
- **Writing voices**: "Warm & respectful" or "JL: direct operator", the Owners Academy copy style toned for a
  first letter to a seller (specific, contrast with brokers and lowballers, a P.S. on the cost of waiting).

## Accounts and exclusive territories (`app/src/auth.js`, `app/src/tenancy.js`)

- **Accounts** are buyer companies. Each has owners and members (email + password, PBKDF2), joined by one-time invite
  links. Everyone in an account shares its searches, pipeline, AI drafts and agents; nothing crosses accounts.
- **Territories** are one industry in one area (a French département, a Norwegian county, a UK/US city, or a whole
  country). A territory is held by exactly one account. A whole-country claim blocks every region in it, and the
  other way round. Plans set how many an account may hold: Operator 1 ($1,000/mo), Roll-up 3 ($2,500/mo), Platform 10.
- **Enforced everywhere**: searches and agents only run inside your territories; adding a company by number is refused
  when it sits in another buyer's territory; inbound sellers from `/value` go to whoever holds their territory
  (the platform account when nobody does); members are never told who holds a territory.
- **API tokens** are per user, shown once, stored hashed. The `API_TOKEN` secret acts as platform admin.
- **Admin** (`#/admin`, platform admins only): create buyer accounts (returns the owner's invite link), change plans and
  limits, pause accounts, assign or remove territories, see MRR.
- **First run**: open `/login`; while no users exist it asks for the setup key (`DASHBOARD_PASSWORD`) and creates the
  platform admin in account 1, which keeps every pre-v5 search and pipeline entry.

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
npx wrangler d1 execute dealflow --remote --file migrations.sql  # upgrading a v2 database instead
npx wrangler d1 execute dealflow --remote --file migrations-4.sql # upgrading a v3 database (agents)
npx wrangler d1 execute dealflow --remote --file migrations-5.sql # upgrading a v4 database (accounts, territories)
npx wrangler deploy
npx wrangler secret put DASHBOARD_PASSWORD
npx wrangler secret put API_TOKEN
npx wrangler secret put COMPANIES_HOUSE_API_KEY                   # optional: enables UK
npx wrangler secret put GOOGLE_PLACES_API_KEY                     # optional: enables US
npx wrangler secret put ANTHROPIC_API_KEY                         # optional: Claude for briefs and letters
```

Texas license data (optional, US only): `node ingest/fetch.mjs && node ingest/build.mjs && node ingest/export-v2.mjs`,
then `npx wrangler d1 execute dealflow --remote --file ../data/seed-tx.sql` from `app/`.

## Outreach

Every company has a letter, a 3-step email sequence and a call script, filled in from "Outreach settings".
Email needs separate warmed-up sending domains, a postal address and an opt-out. Phone calls are made by people,
not robocalls or AI voices, and numbers are checked against national do-not-call lists. French and Norwegian
owners respond far better in their own language.

## Limits on the Workers Free plan

D1 allows 100,000 row writes per day on the free plan. A full Texas reseed is about 140,000 writes, so it doesn't
fit in one day. The Workers Paid plan ($5/month) includes 50 million writes a month.
