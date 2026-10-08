# Owners Academy VSL funnel

A complete high-ticket VSL funnel on **Cloudflare Workers + D1**: landing VSL → multi-step application → lead scoring and routing → booking or breakout VSL + FAQs → email and WhatsApp follow-up. It includes first-party server-side tracking for every step and an analytics/CRM dashboard.

Everything runs in one Worker with no servers to manage. There is no client framework, and the funnel pages load about 15 KB of JavaScript.

> Strategy, benchmarks and VSL script outlines: **[docs/FUNNEL_STRATEGY.md](docs/FUNNEL_STRATEGY.md)**

```
 Ad click ─▶ /  (VSL #1, headline A/B test, CTA unlocks at the pitch)
              │
              ▼
           /apply  (8 steps; lead captured at step 1, every answer saved)
              │  score 0–100 + hard rules ─▶ tier
     ┌────────┼──────────────────┐
     ▼ A      ▼ B                ▼ C
   /book    /breakout          /resources
 (closer   (VSL #2 + FAQs +    (starter kit +
  calendar) WhatsApp + book)    WhatsApp)
     │
     ▼ booked
   /breakout  (pre-call video, call time, prep, FAQs, "Add Josh on WhatsApp")
```

## What's in it

| Area | What it does |
|---|---|
| **Landing VSL** | Server-rendered headline A/B test (sticky per visitor, `?v=b` to preview). Muted autoplay with a "click to listen" overlay that restarts the video with sound. No seek bar, and the progress bar runs fast at the start. Resume-where-you-left-off. The CTA and the rest of the page unlock at the pitch timestamp, and returning visitors see them straight away. Sticky mobile CTA. |
| **Application** | One question per screen, with keyboard shortcuts. Contact details come first, so abandoned applications become leads. Every answer is saved server-side. Invisible Turnstile is optional. Shows an "analysing" step and then routes the visitor. |
| **Scoring & routing** | Points per answer plus hard caps: "not ready" can't reach A, students go to C, and so on. A → closer calendar, B → breakout VSL with a setter calendar, C → resources. Weighted round-robin across closers, with state kept in D1. |
| **Breakout page** | VSL #2 + FAQs + WhatsApp. It changes to a "you're booked" pre-call version (call time, prep checklist, pre-call video) once a call is booked. |
| **Booking** | Calendly is embedded as an iframe. The browser reports the booking instantly, then the **signed Calendly webhook** confirms it with the call time. Cal.com, GoHighLevel and Zapier use a generic signed webhook. |
| **Email** | Resend API. Five sequences: abandoned application, A (get booked), B (nurture → book), C (resources), booked (confirmation + 24h / 1h reminders). The cron sends every 5 minutes. Each email gets tracked links (which also link a second device to the same lead), an open pixel, and one-click unsubscribe (RFC 8058). Without an API key, emails are **simulated** so you can test the flows. |
| **WhatsApp** | "Message Josh" buttons open `wa.me` with a pre-filled message that includes the lead's **ref code**. Clicks are tracked server-side. Optional Cloud API: sends a resources template to leads who opted in, and inbound messages are matched back to leads by ref code or phone. |
| **Tracking** | Server-side page views (counted even when the visitor blocks scripts), first-party HttpOnly cookies (400-day visitor, 30-min session), UTMs + 11 ad click IDs, GA4-style channel grouping, first and last non-direct touch, Cloudflare geo/ASN/TLS, UA + in-app browser parsing, bot filtering, scroll, engaged time, rage clicks, exit intent, FAQ opens, VSL heartbeats (1% watch bitmap). |
| **Forwarding** | PostHog (server-side, plus optional session replay through a first-party `/ph` proxy). Meta Conversions API with hashed PII, fbp/fbc, and event IDs that **deduplicate with the Pixel**. Quality-weighted `QualifiedLead` values for ad optimisation. GA4 Measurement Protocol. CRM webhook. Slack hot-lead alerts. EU consent gating. |
| **Dashboard** `/admin` | Overview (KPIs, the full funnel through to revenue, daily trends), VSL retention curve with the pitch marker and the biggest drop-off moments, traffic/ads attribution by 15 dimensions through to revenue per visitor, application drop-off, answer distributions and score histogram, A/B test with significance, a leads CRM (search, filters, CSV export, full journey timeline, status/revenue/notes/tier override), email performance + queue, a live activity stream, and **Integrations**, where keys can be connected without a redeploy. |

## Run it locally

```bash
cd vsl-funnel
npm install
printf 'ADMIN_PASSWORD=devpass\nSESSION_SECRET=dev-secret\n' > .dev.vars
npm run db:migrate:local
npm run dev                         # http://127.0.0.1:8787  ·  dashboard: /admin
npm run simulate -- 150             # optional: drive 150 synthetic visitors through the real endpoints
curl "http://127.0.0.1:8787/__scheduled?cron=*/5+*+*+*+*"   # run the email cron once
npm run check                       # typecheck + unit tests
```

## Deploy to Cloudflare

```bash
npx wrangler login                              # or export CLOUDFLARE_API_TOKEN=…
npx wrangler d1 create owners-vsl-funnel        # copy the database_id into wrangler.jsonc
npm run db:migrate:remote
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET          # any long random string
npm run deploy
```

Then:

1. **Custom domain**: in Workers & Pages → `owners-vsl-funnel` → Settings → Domains & Routes, add something like `apply.yourdomain.com`. Set `PUBLIC_URL` to it in the dashboard's Integrations tab, because email links depend on it.
2. **Protect `/admin`** with Cloudflare Access (Zero Trust → Access → Applications → self-hosted → path `/admin*`). This sits on top of the password.
3. **Connect integrations** at `/admin#integrations`. You paste keys there and they take effect within about 15 seconds. Anything you set as a Worker var/secret overrides the dashboard value and shows as locked.

### Integration checklist

| Integration | Where to get it | Notes |
|---|---|---|
| **VSL video** | Cloudflare Stream → video → HLS manifest URL (`…/manifest/video.m3u8`) | Any MP4 works too. Set `ctaRevealAt` (the pitch timestamp, in seconds) in `src/config.ts`. |
| **Resend (email)** | resend.com → Domains (verify the sending domain) → API Keys | Fill in `RESEND_API_KEY`, `EMAIL_FROM` (`Josh Li <josh@mail.yourdomain.com>`) and `BUSINESS_ADDRESS`. Use **Send test** to check it. |
| **WhatsApp** | Josh's number in international format | That alone turns on every "Message Josh" button. For the Cloud API, use Meta Business → WhatsApp → API setup: token, phone number ID, an approved `resources` template with body params `{{1}}` = first name and `{{2}}` = link, then webhook `https://<domain>/hooks/whatsapp` with your verify token and app secret. |
| **Calendly** | Event links for `BOOKING_URL_A` (closer) and `BOOKING_URL_B` (setter) | Create a webhook subscription (API: `POST /webhook_subscriptions`, events `invitee.created` + `invitee.canceled`, `signing_key` = your `CALENDLY_SIGNING_KEY`, url `https://<domain>/hooks/calendly`). The lead ID is passed in `salesforce_uuid`, so matching is exact. |
| **Cal.com / GHL / Zapier** | — | POST to `/hooks/booking?secret=…` (Cal.com can sign with `X-Cal-Signature-256` instead). Simple shape: `{ email, start_time, status, lead_id }`. |
| **PostHog** | Project settings → API key | Every event is mirrored server-side with `distinct_id` = the visitor ID. Set `POSTHOG_SESSION_REPLAY=true` for recordings and heatmaps. |
| **Meta** | Events Manager → Pixel ID + Conversions API token | Use `META_TEST_EVENT_CODE` while you check events in Test Events, then clear it. Optimise campaigns on `QualifiedLead` or `Schedule`, not `Lead`. |
| **GA4** | Admin → Data streams → Measurement Protocol secret | Optional. |
| **Slack** | Incoming webhook URL | Sends A-tier and booking alerts with a dashboard link. |
| **CRM** | Any webhook URL | Receives the lifecycle events (`lead_captured`, `app_submitted`, `lead_qualified`, `booking_scheduled`, …) with a lead snapshot. |
| **Turnstile** | Cloudflare → Turnstile → site + secret key | Runs as an invisible bot check on the application's contact step. |

### Ad URL template

Meta **URL parameters**:

```
utm_source=facebook&utm_medium=paid&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&utm_term={{adset.name}}&ad_id={{ad.id}}&adset_id={{adset.id}}&placement={{placement}}
```

The Traffic tab then shows qualified leads, bookings and revenue **per ad**, not just clicks.

## Editing the funnel

Everything a marketer changes lives in **`src/config.ts`**: headline variants and their weights, landing copy, the CTA reveal time, the breakout copy, FAQs, application questions and points, tier thresholds and hard rules, the closer roster, and target countries. Email copy is in `src/integrations/templates.ts` (preview any template at `/admin/api/email-preview/<template>`), and sequence timing is in `src/integrations/sequences.ts`.

Testimonials are deliberately left empty. Add only real, verifiable results, because the section stays hidden until you do.

## Architecture

```
src/
  index.ts                 routes, security headers, cron entry
  config.ts                ← copy, A/B test, application, scoring, routing, closers
  settings.ts              integration keys: env vars > dashboard (D1) > unset
  lib/                     identity (cookies/sessions/geo), attribution, UA/bots, crypto, ids
  tracking/                track() → D1 + fan-out (PostHog, Meta CAPI, GA4, CRM); VSL heartbeats; client beacon
  funnel/                  pages (HTMLRewriter rendering), application, scoring, routing, leads
  integrations/            email engine + sequences + templates, WhatsApp, booking webhooks, Slack
  routes/                  public API, tracked links (/r /o /u /go/wa), webhooks, admin API
  admin/                   auth, stats queries
public/                    page templates, site.css, f.js (tracker), vsl.js, apply.js, book.js, admin UI
migrations/0001_init.sql   visitors, sessions, events, leads, vsl_views, emails, whatsapp_messages, settings
scripts/simulate-traffic.mjs
```

**How tracking works**

- **Visitor identity**: the first request sets `_fv`, an HttpOnly first-party cookie that lasts 400 days. Because it's set by the server, it isn't affected by Safari's 7-day cap on cookies that JavaScript sets.
- **Sessions**: a session ends after 30 minutes of inactivity, or when the visitor arrives from a new ad click.
- **Page views**: every page view is written server-side before the HTML is sent. Prefetch and prerender requests are skipped.
- **The client script** (`f.js`) adds only what the browser knows: screen size, time zone, scroll depth, engaged time and clicks.
- **VSL tracking**: the player sends a heartbeat every 10 seconds with a 100-bucket "watched" bitmap. The server merges the bitmaps with OR and fires each milestone event exactly once (`vsl_25/50/75/95/complete/cta_reveal`). A view only counts once the viewer turns the sound on, so muted autoplay doesn't inflate the numbers.
- **Linking to leads**: when someone gives their contact details, their anonymous history is back-filled onto the lead. Clicking an email link on another device links that browser to the same lead.
- **Webhooks and cron jobs** rebuild the lead's IP, user agent, fbp and fbc from their last session, so offline conversions (bookings, show-ups) still match in Meta.

**Scale notes:** D1 comfortably handles tens of thousands of visitors a month with these indexes. At high volume, move the raw `events` stream to Analytics Engine or Queues + R2, and keep D1 for leads, sessions and aggregates.

## Privacy & compliance

- There is a consent banner for EU visitors (`CONSENT_REQUIRED_EU`). Until a visitor consents, nothing is forwarded to PostHog, Meta or GA4.
- IP addresses are stored in full unless `IP_ANONYMIZE=true`. In that case only an HMAC hash is kept.
- `public/privacy.html` is a **template**, so have it reviewed. Every email has a postal address and one-click unsubscribe.
- The WhatsApp template only goes to leads who ticked the opt-in.
- The page disclaimer is in `src/config.ts` (`DISCLAIMER`). Keep claims in the copy and the VSL substantiated.
