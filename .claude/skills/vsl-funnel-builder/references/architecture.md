# Architecture

## Stack
- **Cloudflare Workers** (TypeScript) + **Hono** router + **D1** (SQLite) + static assets (`public/`) served by the Worker's asset binding.
- **No client framework.** Pages are static HTML templates filled in server-side with **HTMLRewriter** (`src/funnel/pages.ts`). Client JS is plain ES5-ish: `f.js` tracker, `vsl.js` player, `apply.js` application, `book.js`, `admin.js` dashboard and `funnel-map.js`.
- **Cron** `*/5 * * * *`, with the `scheduled` handler in `src/index.ts`.
- Packages: `hono`, `@anthropic-ai/sdk` (email personalisation only); dev: `wrangler`, `typescript`, `vitest`, `@cloudflare/workers-types`.
- `npm run check` = `tsc --noEmit && vitest run`.

## Layout
```
src/
  index.ts            routes, security headers, admin login, /ph PostHog proxy, cron entry
  app.ts              Runtime { env, settings, origin, reps, waitUntil }
  config.ts           ALL marketer-editable content: brand, videos, headline A/B, landing/breakout copy, FAQs,
                      application questions + points + flags, tier thresholds + hard rules, routes, closers,
                      voice prompts (inbound assistant, outbound caller, callback agent), CALL_CONSENT, AI_CALLER hours
  settings.ts         integration keys/flags: env var > D1 settings > default; 15 s cache; list drives the Integrations UI
  lib/                identity (cookies, sessions, geo, bots), attribution (channel grouping, click ids), crypto (HMAC,
                      safeEqual), ids, secret (derived signing secret)
  tracking/           catalog (event → Meta/GA4 names), track() (D1 + fan-out), forward (Meta CAPI, GA4 MP, PostHog,
                      CRM webhook, retries via forward_log), vsl (heartbeat merge + milestones)
  funnel/             pages, application (saveContact, saveAnswers, submit), scoring, routing (weighted round-robin),
                      leads (Lead type, get/update, parseAnswers), tracked-links
  landers/            catalog (20 industries × 5 angles, inferIndustry), bandit (Thompson sampling)
  integrations/       email (queue/send/build), sequences, templates, booking (markBooked/markCancelled/handleCalendly),
                      calendly (PAT API: connect, sync, import history, qualify), elevenlabs (outbound), elevenlabs-inbound
                      (callback agent), voice (Vapi inbound assistant, optional), whatsapp, notify (Slack/Discord)
  followup/           dossier (application reader), templates (application-specific follow-up emails)
  personalize/        profile (behaviour facts), personalize (rules + Claude), triggers (behaviour rules)
  sales/              reps, outcomes (applyLeadUpdate, payments, isHistorical), qualify (Calendly answers → tier), digest
  admin/              stats, sales, insights, landers, behaviour (report queries)
  routes/             api (public beacons + application), links (/l /r /o /u /go/wa), hooks (webhooks), admin (admin API)
public/               index.html, apply.html, book.html, breakout.html, resources.html, privacy.html, admin/index.html,
                      assets/*.js|css, media
migrations/           0001..0011 (see data-model.md)
test/                 vitest unit tests per module
```

## Routes (public)
`/` (landing VSL), `/for/:industry`, `/for/:industry/:angle`, `/m` (smart route), `/apply`, `/book`, `/breakout`, `/resources`, `/privacy`, `/api/*` (beacons, application steps, VSL heartbeat), `/hooks/*` (calendly, booking, whatsapp, elevenlabs, elevenlabs/init, vapi), `/l/:code` (tracked links), `/r/:emailId/:sig?u=` (signed email click redirect), `/o/:emailId.gif` (open pixel), `/u/:leadId/:sig` (unsubscribe), `/go/wa` (WhatsApp click), `/ph/*` (first-party PostHog proxy), `/health`, `/robots.txt` (Disallow all).

## Admin
`/admin/login` (POST password → HMAC-signed HttpOnly cookie), `/admin` (requireAdmin), `/admin/api/*`, all behind requireAdmin. Recommend adding Cloudflare Access on `/admin*` as well.

## Cron (every 5 min; each wrapped in `quiet()` so one failure doesn't stop the rest)
`processEmailQueue` → `retryForwards` → `pingUpcomingCalls` → `maybeSendDigest` → `processCallQueue` → `syncInbound` → `syncCalendly` (hourly, gated by kv_state) → `processTriggers`.

## Settings precedence
`env var (wrangler secret/var)` > `D1 settings row (Integrations tab)` > default. Env-set keys show as locked in the UI. Never return secret values to the browser; show only "connected" plus the last 4 characters.

## Security headers
On every response: `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Robots-Tag: noindex, nofollow`, and HSTS (on https).
- Funnel pages: `X-Frame-Options: SAMEORIGIN`.
- `/admin*` and `/u/*`: `X-Frame-Options: DENY` plus a strict CSP (`default-src 'self'; script-src 'self'; … frame-ancestors 'none'`).
- Admin API: `cache-control: no-store`.
See security-checklist.md.
