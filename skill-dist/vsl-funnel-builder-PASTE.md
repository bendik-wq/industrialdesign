# VSL Funnel Builder: full build brief (paste into a new chat)

> Paste this whole file into a new Claude chat (Claude Code works best, because it can run and deploy the code). Then say what to build, for example: "Build this funnel for my offer: …". The sections below are the plan and the reference spec.

# VSL Funnel Builder

This skill rebuilds, end to end, a production funnel that was first built for an M&A advisory offer ("a signed LOI in 90 days on a no-money-down acquisition"). Everything runs in **one Cloudflare Worker** with a **D1** database. There are no servers and no client framework. Public pages load about 15 KB of JavaScript.

Build it in the phases below. **Each phase ends with something deployable and tested.** Don't jump ahead: later phases depend on the data model and tracking from earlier ones.

## 0. Intake (ask once, then build)

Collect these before writing any code. Fall back to sensible defaults, and ask only for what you can't infer.

- **Offer**: the promise, who it's for (the ICP and its minimum size), price range, guarantee, and delivery model. Example: "done with you, not done for you".
- **Brand**: business name, the founder/face, sender name, physical address (needed for email compliance), and colours (or use the paper/ink palette).
- **Copy rules**: words that are never allowed. Example from the original build: never call the strategy call "free". Also the claims that can't be made, and the disclaimer.
- **Qualification**: the application questions, which answers are hard disqualifiers, and the A/B/C thresholds.
- **Team**: closers and setters, which tiers each takes, and their booking links.
- **Markets**: target countries and time zones. These drive calling hours and consent rules.
- **Integrations available**: see the section on `integrations`. Every integration is optional, and the funnel runs and simulates without any of them.

**Secrets rule:** never ask the user to paste API keys into chat. Build the **Integrations** screen in Funnel HQ, where keys go into D1. Env vars override them and show as locked. If a user pastes a key anyway, use it once, never commit it, and recommend rotating it.

## Build phases

| # | Phase | Read first | Done when |
|---|---|---|---|
| 1 | Skeleton: Worker, D1, settings, admin auth, security headers, cron | the section on `architecture`, the section on `data-model` | `/health` returns OK; `/admin` is behind a password; cron runs |
| 2 | First-party tracking: identity cookies, sessions, attribution, events, VSL heartbeats, deep on-page tracking, forwarding to Meta/GA4/PostHog | the section on `tracking` | A simulated visitor shows a full journey in the event log |
| 3 | Pages: landing VSL + headline A/B test, apply, book, breakout, resources, privacy | the section on `pages-and-copy` | Every page renders server-side via HTMLRewriter; CTA unlocks at the pitch timestamp |
| 4 | Application, scoring, routing | the section on `application-scoring` | Contact details at step 1 create the lead; scoring + hard caps → tier → route; weighted round-robin closers |
| 5 | Booking: Calendly embed + signed webhook + API sync + history import + qualification from booking answers | the section on `calendly` | Booking, reschedule, cancel and no-show all reach the lead record |
| 6 | Email engine + all sequences + pre-call barrage | the section on `followup` | Queue, claim, send (or simulate) on cron; tracked links; unsubscribe; every sequence stops when its goal is met |
| 7 | Application reader (dossier) + application-specific follow-up | the section on `followup` §Dossier | Pre-call, no-show, post-call, cancelled, lost, won and nurture emails quote each lead's own answers |
| 8 | Behaviour profile, behaviour-triggered emails, Claude personalisation | the section on `personalisation` | Each email adds one fact earlier emails didn't use; nothing creepy is said back |
| 9 | AI voice: ElevenLabs outbound (confirm / speed-to-lead / rebook) + inbound callback agent | the section on `voice` | Consent-gated; calling hours in the lead's time zone; DNC honoured; webhooks signed |
| 10 | Sales team: reps, outcomes, deal markers, payments, Slack/Discord pings, daily digest | the section on `sales-and-hq` | Logging an outcome triggers the right sequences and pings; historical imports never email anyone |
| 11 | Industry landers (20 × 5) + Meta smart route + bandit | the section on `landers` | `/m?ind=` or the ad name routes to the right industry; the bandit shifts traffic after a 60-visitor floor |
| 12 | Funnel HQ dashboard: all tabs + the editable funnel map | the section on `sales-and-hq` | Every number traces back to events; the map supports drag, connect, add/edit/delete, saved for everyone |
| 13 | Domain, DNS and deliverability: custom domain, SPF/DKIM/DMARC, webhook URLs switched | the section on `deploy-and-domain` | Mail passes SPF and DKIM; webhooks point at the custom domain |
| 14 | Security and privacy pass, then an adversarial review: specialist reviewers (auth, webhooks/API, privacy, XSS), then skeptic agents that try to disprove each finding | the section on `security-checklist` | Every checklist item is in the code and has a regression test |

The build order matters. For example, tracking (2) has to exist before personalisation (8), and the email engine (6) before the dossier (7).

## Non-negotiables

1. **Server-side truth.** Write page views server-side before the HTML is sent. Write conversions from the server. Client scripts only add what only the browser knows.
2. **Never record what people type.** Field tracking records focus, time, corrections, paste and empty fields, but never values. Selected or copied text is capped and treated as a background signal, never quoted back to the lead.
3. **Consent before calls.** AI calls go only to leads who ticked an **unticked-by-default** consent box. Consent is per number, with its text and timestamp stored. Disclose the AI, the recording, "say stop" and a callback number up front. Call only during local calling hours across every time zone of the **phone number's** country, never on Sundays or public holidays, and only to verified bookings. Cap calls per number and per day. Check do-not-call before every dial, including retries. Never call imported or historical contacts.
4. **Every email** has one-click unsubscribe (RFC 8058) and a physical address. Unsubscribe stops every sequence.
5. **Historical imports are read-only.** Imported Calendly bookings and calls more than 14 days old must never trigger emails, pings, calls or ad-platform conversions (the `isHistorical` guard and `localOnly` tracking).
6. **Sequences are append-only.** The step index is the dedupe key `(lead_id, sequence, step)`. Append new steps; never reorder or insert in the middle.
7. **Copy honesty.** No fabricated testimonials, results, clients or case studies. Label illustrative numbers as illustrative. No false urgency. Respect the user's banned words.
8. **Treat every stranger-typed value as hostile.** Escape it and strip links from it before it reaches email HTML, `innerHTML`, Slack/Discord or a voice prompt. An email address is not proof of identity, and a browser booking report is not proof of a booking. Read the section on `security-checklist` before building phases 4–9.
9. **Webhooks fail closed.** If the signing secret isn't set, reject the request. Compare signatures in constant time, and use a replay window where the provider sends a timestamp.
10. **Test before deploy.** Run `npm run check` (typecheck plus vitest), drive the real endpoints locally (`wrangler dev`, plus Playwright for UI), then deploy.

## Working method

- Keep all marketer-editable content in `src/config.ts`: copy, questions, points, thresholds, closers and prompts. Email copy goes in template files; timing goes in `sequences.ts`.
- Settings resolve **env var → D1 `settings` row → unset**, with a ~15 s cache. The Integrations tab writes the D1 rows.
- Every cron job is wrapped so one failure can't stop the others. They include: email queue, retry forwards, upcoming-call pings, digest, call queue, inbound sync, Calendly sync (hourly) and triggers.
- Without provider keys everything **simulates**: emails are marked `simulated` and calls aren't placed. That lets the whole flow be tested end to end.
- After each phase: typecheck, unit tests, a local run, Playwright screenshots of any UI, then deploy and commit.
- Read the section on `gotchas` before starting. It lists every bug the original build hit.

## Reference implementation

The original source lives in the GitHub repo `bendik-wq/industrialdesign`, folder `vsl-funnel/`, branch `claude/ecstatic-hopper-yhy3mk`. If the current session can read that repo, copy and adapt it rather than rewriting from scratch. Swap out the offer, brand, copy, questions and team in `src/config.ts` and the templates. If it can't, the reference files here are enough to rebuild it.

---
# Reference spec


## Architecture

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



## Data model (D1 migrations, in order)

Add columns with new migrations; never edit an applied migration. Apply with `wrangler d1 migrations apply DB --local|--remote`.

**0001_init**
- `visitors`: id (= `_fv` cookie), first-touch attribution (ft_channel/source/medium/campaign/content/term/referrer/landing/click_id/click_type), geo, device, is_bot, counters, lead_id.
- `sessions`: id, visitor_id, landing_path/query, referrer, channel, utm_*, click_id/click_type, ad_id/adset_id/placement, full Cloudflare geo (country, region, city, postal, tz, lat/long, is_eu, asn, colo), ip / ip_hash, user_agent + parsed device/browser/os, accept_language, client_tz, screen/viewport/dpr/connection, is_bot + bot_reason, A/B variant, pageviews, event_count, engaged_ms, max_scroll.
- `events`: id, ts, name, visitor_id, session_id, lead_id, path, source (client/server/webhook/cron/admin), variant, is_bot, props JSON. Index on (name, ts), (lead_id), (visitor_id).
- `leads`: id, ref_code, contact fields, whatsapp_opt_in, answers JSON, step_reached, app_started/completed_at, score, score_breakdown, tier, tier_override, route, closer_id, status (partial|applied|booked|showed|no_show|won|lost|nurture|disqualified), booking fields (booked_at, call_at, provider, ref, cancelled_at), WhatsApp fields, unsubscribed_at, revenue, notes, last + first-touch attribution, landing_path, variant, geo, device, fbp, fbc.
- `vsl_views`: per visitor × video: duration, max_position, watched_seconds, buckets (100-bit watched bitmap), played, unmuted, completed, cta_revealed, cta_clicked.
- `emails`: queue + log. UNIQUE(lead_id, sequence, step). status pending|sending|sent|simulated|skipped|cancelled|failed; opens and clicks.
- `whatsapp_messages`, `settings` (key/value), `kv_state` (round-robin pointers, cron gates, `map:layout`, `map:custom`).

**0002_voice** `voice_calls` (transcript, recording_url, structured, summary, cost) + `leads.do_not_call_at`.
**0003_tracking** `forward_log` (per event × destination, with retries and backoff, match keys, payload) + `sessions.region_code`.
**0004_links** `tracked_links` (code, label, kind, video id/title/thumbnail, placement, dest_path, utm defaults, clicks).
**0005_sales** `reps` (role closer/setter, tiers, weight, calendar_url, commission_pct, monthly_target, slack/discord ids, active) + leads cash_collected, closed_at, showed_at, lost_reason, setter_id.
**0006_ai_calls** `outbound_calls` (kind confirm|speed_to_lead|rebook|test, status queued|dialing|done|failed|cancelled, run_at, attempts, conversation_id, call_sid, outcome) + leads call_consent_at, call_consent_text, timezone.
**0007_personalized_emails** emails.personalized (ai|rules|fallback|off), facts_used JSON, personalize_error.
**0008_calendly** leads booking_join_url, booking_reschedule_url, booking_cancel_url, booking_host_email, booking_answers JSON [{q,a}], booking_source (funnel|calendly-direct).
**0009_calendly_bookings** `calendly_bookings` keyed by invitee_uri: the full booking history, including people never in the funnel.
**0010_deal_markers** leads industry, revenue_band, budget_band, willing_to_invest, qual_source, qual_flags, temperature, objection, follow_up_at, decision_maker, fit_rating, offer, payment_plan, installments_total, next_payment_at, contract_signed_at, refunded_at, refund_amount, loi_signed_at, target_business + the `payments` ledger.
**0011_landers** sessions.lander, leads.lander, leads.ft_lander.



## Tracking (first-party, server-side first)

## Identity
- `_fv`: visitor id. A **server-set** HttpOnly, Secure, SameSite=Lax cookie with a 400-day life, so Safari's 7-day cap on JS cookies doesn't apply.
- `_fs`: session id. Times out after 30 minutes of inactivity, and a new ad click (new click id or UTMs) starts a new session.
- `withVisitor` middleware: resolves or creates the visitor and session, parses UA and bots, captures the Cloudflare geo/ASN/TLS, and writes the session row.
- **Page views are written server-side before the HTML is returned.** Skip prefetch/prerender (`Sec-Purpose`, `Purpose` headers).
- Identity stitching: contact details at application step 1 back-fill the anonymous history onto the lead. A tracked email link clicked on another device links that browser to the same lead.
- Webhooks and cron rebuild IP, UA, fbp and fbc from the lead's last session, so offline conversions still match in Meta.

## Attribution
- UTMs plus 11 ad click ids (gclid, gbraid, wbraid, fbclid, ttclid, msclkid, li_fat_id, twclid, ScCid, epik, rdt_cid). GA4-style channel grouping.
- First touch is stored on the visitor (`ft_*`). Last **non-direct** touch is stored on the lead at capture.
- `/l/:code` tracked links for YouTube descriptions, pinned comments and end screens. Each has a label, video, placement and default UTMs.
- Meta URL parameter template: `utm_source=facebook&utm_medium=paid&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&utm_term={{adset.name}}&ad_id={{ad.id}}&adset_id={{adset.id}}&placement={{placement}}`

## Event catalog (`src/tracking/catalog.ts`)
- Server/lifecycle: page_view, lead_captured, app_step, app_submitted, lead_qualified, booking_scheduled, booking_cancelled, lead_status_changed, email_sent/opened/clicked, whatsapp_click, ai_call_started/completed/unanswered.
- VSL: vsl_play, vsl_unmute, vsl_25/50/75/95/complete, vsl_cta_reveal, vsl_cta_click, vsl_rewatch, vsl_skip, vsl_pause, vsl_speed, vsl_volume, vsl_fullscreen.
- Deep on-page (client, **local only**, never forwarded): click, cta_hover, field_interaction (focus, time, corrections, paste, left empty: **never the value**), tab_return, text_select / text_copy (capped length, background only), section_dwell, section_revisit, page_exit, first_interaction, scroll, engaged time, rage clicks, exit intent, faq_open.
- `f.js` caps deep events at 150 per page. Sections are marked with `data-section="video|guarantee|testimonials|book_cta|…"` or `section[id]`.

## VSL heartbeat
The player posts every 10 s with a 100-bucket watched bitmap. The server ORs it into `vsl_views.buckets` and fires each milestone exactly once. A view counts only after the viewer unmutes. The pitch timestamp (`ctaRevealAt`) reveals the CTA, and returning visitors see it straight away.

## Forwarding (`src/tracking/forward.ts`)
- `track(rt, identity, { name, source, props, localOnly })` writes to D1, then fans out unless `localOnly` or in `MICRO_EVENTS`.
- **Meta CAPI**: SHA-256-hashed email, phone, name and country, plus fbp/fbc, IP and UA. `event_id` deduplicates with the Pixel. Use `META_TEST_EVENT_CODE` while testing. Optimise ads on `QualifiedLead` or `Schedule`, with value weighted by tier.
- **GA4** Measurement Protocol, **PostHog** server-side (distinct_id = visitor id; optional session replay through the first-party `/ph` proxy with inputs masked), and a **CRM webhook** with a lead snapshot.
- Retries go through `forward_log` with backoff, and the match keys are logged so the Tracking tab can show match quality.
- **EU consent:** with `CONSENT_REQUIRED_EU`, nothing is forwarded and no third-party script loads until the visitor consents. Optional `IP_ANONYMIZE` stores only an HMAC hash of the IP.



## Pages and copy

## Pages (static templates in `public/`, filled by HTMLRewriter in `src/funnel/pages.ts`)
- **`/` landing VSL**: server-chosen headline variant (sticky per visitor, `?v=b` previews, `?preview=1` isn't counted). Muted autoplay with a "click to listen" overlay that restarts with sound. No seek bar, and the progress bar runs fast at the start. Resumes where they left off. The CTA, application and rest of the page unlock at the pitch timestamp. Sticky mobile CTA. FAQ, guarantee, (real-only) testimonials, WhatsApp. Sections carry `data-section` attributes for tracking.
- **`/apply`**: one question per screen with keyboard shortcuts. Contact details (name, email, mobile) come first, plus the **unticked** AI-call consent checkbox with its full disclosure text. Every answer is saved server-side as they go. Ends with an "analysing" step, then routes.
- **`/book`**: closer's Calendly embed. The lead id is passed in Calendly's `salesforce_uuid` tracking param for exact matching. The browser postMessage reports the booking instantly, then the webhook confirms it.
- **`/breakout`**: VSL #2, objection FAQs, book CTA and WhatsApp. When the visitor is booked it switches to a pre-call version: call time, meeting link, prep checklist, pre-call video and FAQs.
- **`/resources`**: C-tier starter kit plus WhatsApp.
- **`/privacy`**: template. It must disclose tracking, profiling for personalised emails, AI calls, call recording, and processors and cross-border transfers (Cloudflare, Resend, Anthropic, ElevenLabs/Twilio, Calendly, Meta, Google, PostHog). Have a lawyer review it.
- **Landers** `/for/:industry[/:angle]` and `/m`: see landers.md.

## Copy rules (enforced in prompts, templates and tests)
- Plain, personal, letter-style writing from the founder: short sentences, no hype, no exclamation marks, no emojis in emails.
- Respect the user's banned words. Example: the original build never calls the strategy call "free", and a test asserts it.
- No fabricated testimonials, results, clients or case studies. The testimonials section stays hidden until real ones are added.
- Label illustrative numbers as "illustrative, not advice". No promises of outcomes, approvals or returns. No false urgency.
- State the offer the same way everywhere. In the original: a signed LOI in 90 days on an acquisition that can double or triple the business, no money down, over-financed (seller finance plus senior debt cover more than the price), deals tested at about 1.5x DSCR, done with you not for you, 7-day money-back guarantee.
- For VSL and email copy in the user's own style, use their copywriting skill if they have one.



## Application, scoring, routing

## Questions (config-driven: `APPLICATION` in `src/config.ts`)
Each question has `id`, `type` (contact | text | single | multi), title, help, options `{value, label, points, flags[]}`, and for text questions `minLength` and points by length. The original question set:
1. contact (first name, last name, email, mobile + call consent)
2. business (text: what you sell, who to, where)
3. role (owner 20 / co-owner 16 / exec 6 [flag not_owner] / no business 0 [no_business])
4. revenue (<$1M 0 [under_1m] / $1–3M 15 [small] / $3–10M 22 / $10M+ 25)
5. profit (loss 0 [unprofitable] / <$250k 8 / $250k–1M 16 / $1M+ 20)
6. goal (acquire 10 / group 10 / exit 8 / unsure 2)
7. timeline (0–6 mo 15 / 6–12 10 / 12+ 4 / exploring 0 [exploring])
8. blockers (multi: deal_flow, funding, valuation, integration, time, never_considered; these drive follow-up copy, not points)
9. readiness (yes 15 / with partner 9 [partner] / not now 0 [not_ready])
10. why_now (text; +5 at 160+ chars, +3 at 60+)

## Scoring (`src/funnel/scoring.ts`)
- Sum the points, then derive flags: excluded industry (whole-word match on the business text), personal email domain, out-of-market country, blocklist.
- `TIER_THRESHOLDS = { A: 70, B: 40 }`. **Hard caps (`TIER_RULES`)**: blocked, excluded industry, no business or under $1M → max C. Not owner, unprofitable, not ready, exploring, personal email + small, or out of market → max B.
- Store `score_breakdown` so the dashboard can explain every tier.

## Routing
- `TIER_ROUTES`: A → `/book` (closer calendar), B → `/breakout` (objections, then the setter or closer calendar), C → `/resources`.
- **Weighted round-robin** across active reps who take that tier, with the pointer in `kv_state`. Reps live in the `reps` table (Team tab), falling back to `CLOSERS` in config.
- On submit: cancel `abandoned`, start the tier sequence plus the 6-month `nurture`, queue the speed-to-lead AI call (A/B, consent only), send a Slack/Discord ping for A and B, and track `app_submitted` + `lead_qualified` with a value weighted by tier.

## Abandoned application
Contact at step 1 creates the lead (status `partial`) and starts `abandoned` (5 emails over 4 days), which is cancelled on submit. Re-submitting with the same email reopens the same lead.



## Calendly (booking)

## Without the API (minimum)
- Embed the event link (`BOOKING_URL_A` for closers, `BOOKING_URL_B` for setters, or per rep `calendar_url`) with `?salesforce_uuid=<lead id>` plus prefilled name and email.
- The browser listens for Calendly's `postMessage` `calendly.event_scheduled` and reports it via `/api` (unverified, gives an instant UI update).
- `/hooks/calendly` receives a **signed** webhook (`Calendly-Webhook-Signature: t=…,v1=hmac(t.body)`): constant-time compare, 5-minute replay window, and **reject if no signing key is configured**. The event can be `invitee.created` or `invitee.canceled` (with `rescheduled`).

## With a Personal Access Token (Integrations → Calendly → Connect)
- `connectCalendly`: reads `/users/me` (user and organization URIs), creates the webhook subscription (org or user scope) with a generated signing key, and stores ids and key in settings. If the subscription has to be recreated, delete the old one. Never touch subscriptions you didn't create (other tools, such as Kit, may have their own).
- `eventWithInvitees`: on each webhook, fetches the scheduled event plus invitees to get the exact start time, Zoom/Meet join URL, host email (the host becomes the closer), reschedule and cancel URLs, and `questions_and_answers` (stored as `booking_answers`).
- `syncCalendly` (hourly, gated in kv_state): pulls recent and upcoming events and catches anything the webhook missed, including cancellations and **no-show marks** (`invitee_no_show`).
- `importCalendlyHistory`: one-off pull of all past bookings into `calendly_bookings` (keyed by invitee_uri). It creates or links leads with `booking_source = 'calendly-direct'`. **Imported people never get emails, calls, pings or ad conversions** (the `isHistorical` guard).
- `qualifyCalendly`: maps booking-form answers (revenue, budget, willingness to invest, industry) to `revenue_band`, `budget_band`, flags and a tier (`qual_source = 'calendly'`), so direct bookers show up in the A/B/C insights. `requalifyCalendlyLeads` re-runs it after you change the rules.
- `linkOrphans`: matches bookings to funnel leads by email afterwards.

## markBooked / markCancelled (`src/integrations/booking.ts`)
- Idempotent per booking ref. A reschedule keeps `booked_at` and updates `call_at`.
- New booking: track `booking_scheduled`, cancel tier/abandoned/no-show/cancelled/nurture/lost sequences, cancel the speed-to-lead and rebook calls, queue the AI confirmation call, ping the team, then enqueue `booked` (reminders) and the **pre-call barrage**. When the call time changes, re-enqueue both.
- Cancel: stop reminders, the barrage and the confirmation call, track `booking_cancelled`, ping, and start the `cancelled` rebooking sequence.

## Lesson
Calendly usernames and event slugs change, and a changed slug silently 404s the booking link. Check the booking URL in the Integrations health check and fetch the current scheduling URL from the API.



## Email engine and follow-up

## Engine (`src/integrations/email.ts`)
- `enqueueSequence(rt, lead, id)` inserts one row per step: `send_at = anchor + offset`. The anchor is enqueue time, or `call_at` for reminders, and reminders whose time has passed are skipped. `ON CONFLICT(lead_id, sequence, step)` refreshes pending, cancelled and skipped rows, so re-enqueueing reschedules them.
- `cancelSequence` marks pending rows `cancelled`.
- `processEmailQueue` (cron) selects due pending rows and **claims each atomically** (`UPDATE … SET status='sending' WHERE status='pending'`). It re-checks against fresh lead data: unsubscribed, the sequence's `stopIf`, the step's `skipIf`. Then it builds, personalises and sends. It sends in parallel batches of 6, never the same lead twice in one batch. Failures retry 3 times with backoff.
- `buildEmail`: every link goes through `ctx.link()` and becomes a **signed redirect** `/r/:emailId/:sig?u=` (HMAC of emailId|target). Adds an open pixel `/o/:id.gif` and a signed one-click unsubscribe `/u/:leadId/:sig` with the `List-Unsubscribe` and `List-Unsubscribe-Post` headers. Adds the postal address. Renders HTML and text.
- Provider: **Resend**. Without `RESEND_API_KEY` and `EMAIL_FROM`, rows are marked `simulated`.
- Deliverability: send from a subdomain or the main domain with SPF, DKIM and DMARC configured (see deploy-and-domain.md). Plain letter-style HTML.

## Sequences (`src/integrations/sequences.ts`; append-only steps)
| id | trigger | steps | stop when |
|---|---|---|---|
| abandoned | contact at step 1 | 15m, 3h, 1d, 2d, 4d | application completed |
| tier_a | A submit | 2m, 1h, 4h, 20h, 2d, 3d, 5d, 7d | booked |
| tier_b | B submit | 2m, 3h, 1d, 2d, 3d, 5d, 7d, 10d | booked |
| tier_c | C submit | 1m, 2d, 5d, 9d, 14d, 21d | booked |
| nurture | any submit, not booked | 25d, 35d, 50d, 65d, 80d, 100d, 120d, 150d, 180d | booked, or status leaves applied/partial/nurture |
| booked | booking | confirm now; 48h, 24h, 3h, 1h, 10m before the call (with join + reschedule links) | cancelled / outcome logged |
| precall | booking | up to N/day (default 6) at local slots 7:30, 9:30, 12:00, 14:30, 17:00, 19:30, starting 90 min after booking, until 3h before the call, kept 45 min clear of the 48h/24h reminders | not booked / call within 2h |
| behaviour | trigger rules | one-off emails | won/lost/disqualified, or a calendly-direct import |
| no_show | outcome no_show | 15m, 1d, 3d, 5d, 7d, 10d, 14d (+ AI rebook call) | status leaves no_show |
| post_call | outcome showed | 2h, 1d (answers the logged objection), 2d, 3d, 5d, 7d, 9d, 12d, 21d | status leaves showed |
| cancelled | Calendly cancel | 30m, 1d, 3d, 6d | rebooked / won / lost |
| lost | outcome lost | 3d, 21d, 45d, 75d, 120d, 180d (angle chosen by lost_reason) | status changes / rebooked |
| won | outcome won | 10m, 1d, 3d, 7d, 14d, 30d onboarding | refunded / status changes |

## Pre-call barrage
- 24 general emails, each on one pain point: ceiling, own cash, bank, no time, partner, seller, founder story, brokers, DSCR, consolidation, guarantee, call agenda, multiple, in-not-on, cash trap, deal fell over, done-with, questions, lemon, hiring, two paths, next year, "if you could", cost of waiting.
- `precallPlan(lead)`: the lead-specific prep emails go first (two of them), then they alternate with the general ones. Even a call booked for tomorrow gets the personal emails.
- `precallTimes(now, callAt, tz, perDay, max)` is a pure, unit-tested function. Handle DST with `zonedTime()` (two-pass offset). The lead's time zone comes from the lead, then their session's client tz, then their country, then the sales tz.

## Dossier (application reader, `src/followup/dossier.ts`)
`buildDossier(lead)` parses `answers` and `booking_answers` and returns business, industry (from `lead.industry` or `inferIndustry()` over the business text and booking answers), revenue and profit values and labels, goal, timeline, blockers[], readiness, role, whyNow (trimmed to 280 chars), booking Q&A, objection, lost_reason, and an **illustrative** deal shape by profit band (target profit, price range, combined result, conservatively "around double").

Copy blocks keyed by answer:
- `BLOCKERS`: name, subject and body for each blocker.
- `GOALS`, `TIMELINES`.
- `OBJECTIONS`, keyed by the closer's logged objection: Price, Timing, Needs to think, Partner/spouse, Funding doubts, Trust/proof, Time to commit, Not a fit.
- `LOST_ANGLES`, keyed by lost reason.

## Application-specific templates (`src/followup/templates.ts`, merged into TEMPLATES)
- **Prep** (picked per lead by `prepTemplates(d)`, most specific first): pp_brief ("I read your application", their answers as bullets plus their why-now quoted), pp_blocker1, pp_booking (their Calendly answers), pp_numbers, pp_goal, pp_industry, pp_why_now, pp_partner (partner readiness or co-owner), pp_timeline, pp_blocker2, pp_homework (always).
- no_show adds ns_goal, ns_blocker, ns_numbers, ns_final. post_call adds fu_objection, fu_recap, fu_numbers, fu_industry, fu_goal, fu_final.
- cancelled: cx_1–4. lost: lo_1–6. won: won_1–6. nurture: nu_industry, nu_blocker, nu_numbers, nu_seller, nu_goal, nu_why, nu_dscr, nu_checkin, nu_last.
- **Every template must render with an empty application** (dashboard preview, imports). Use fallbacks, never `!`. Tests assert: no "undefined", "null" or "NaN" in output, subjects unique across all templates and under 80 characters, no "free call".
- **Escape lead-written text** (why_now, business, booking answers, names) before putting it into email HTML.
- When a template already quotes the application, tell the personaliser to skip the answer facts (`ANSWER_FACTS`) so it doesn't repeat them.



## Behaviour profile, triggers, Claude personalisation

## Profile (`src/personalize/profile.ts`)
`buildProfile(env, lead)` turns everything the lead did into **facts**: `{ key, text (for the model), weight, topics[], you? }`. The optional `you` field is a line that's safe to say to their face.

Sources: which lander and industry they came in on; visit count and return visits; VSL chapters watched (guarded by duration), rewatches, restarts, where they stopped; FAQ questions opened; section dwell and re-reads; copy and select (background only); exit section; CTA hesitation; tab switches; field struggle; application answers (`a_*` facts); the slowest question; going back to change answers; booking behaviour (picked a date but didn't confirm); email opens and clicks; AI call outcomes.

`TEMPLATE_TOPICS[template]` lists the topics each email covers, so facts that match its topic rank higher.

## Personalise (`src/personalize/personalize.ts`)
- Mode: `EMAIL_PERSONALIZE` = off | rules | ai. The default is ai if `ANTHROPIC_API_KEY` is set, otherwise rules.
- `pickFacts`: ranks facts by weight, plus 6 if the fact's topic matches the email, and skips facts that earlier emails to this lead already used (`emails.facts_used`).
- **Rules mode**: inserts one `you` line after the greeting. It only adds a bridge sentence ("So this one is about the money side.") when the fact's topic matches the email.
- **BACKGROUND set**: lander, tabs, cta_hesitate, selected, exit_section, field_struggle, copied, devices, engaged, speed, e_silent, exit, skip, pause, a_slowest, a_backs, resources. These help the model understand the lead but are **never said back**, because saying them would feel like surveillance.
- **AI mode** uses the Claude Messages API with the current most capable model (check the claude-api skill for the model id), medium effort, and a JSON-schema structured output: `{subject, preheader, paragraphs[], ps, facts_used[]}`. The system prompt covers voice, offer facts, banned words and the never-invent rule. **Links never go to the model**: they're placeholders swapped in afterwards. `validateAi` rejects outputs with URLs, banned words, unknown fact keys or a bad shape, and falls back to rules mode. Record `personalized`, `facts_used` and `personalize_error` per email.
- Lead-written text is untrusted input to the model. Fence it in the prompt, and validate the output so it contains no links or contact details that aren't in the draft.

## Behaviour-triggered emails (`src/personalize/triggers.ts`)
`RULES` (template, label, delay in minutes, `when(state, now)`), evaluated in batched queries every cron run:
- t_vsl_no_apply: watched 50%+ of the video, didn't finish applying (delay 30)
- t_stalled: stopped partway through the application, 30 min idle (45)
- t_finish_booking: picked a day on the calendar, didn't confirm (25)
- t_came_back: qualified, not booked, came back to the site (40)
- t_still_thinking: 3+ visits without booking (60)
- t_guarantee: read or re-read the guarantee, not booked (60)
- t_funding: looked into funding through the FAQ, a rewatch or a highlight (60)
- t_book_nudge: opened the booking page, didn't book (30)
- t_breakout_done: watched 70% of the breakout video, didn't book (30)
- t_watch_prep: booked more than 12h ago and hasn't watched the pre-call video (0)

Each rule fires **once per lead**, at most one trigger per lead per run, with a global `DAILY_CAP` of 8. The sends go into the `behaviour` sequence (step = rule index, append-only) and are re-checked at send time.



## AI voice (ElevenLabs Conversational AI + Twilio number)

## Setup (Funnel HQ → Voice tab, guided steps)
1. Paste the ElevenLabs API key in Integrations.
2. The user imports their Twilio number into ElevenLabs themselves, entering the Twilio SID and token in ElevenLabs, never in chat.
3. **Provision** (`POST /admin/api/voice/elevenlabs/provision`): `upsertAgent` creates or updates the outbound agent (prompt from `outboundSystemPrompt(FAQS)`, first message, voice, data-collection schema, max duration, webhook) and the inbound callback agent. It assigns the inbound agent to the phone number and sets the conversation-initiation webhook. **Re-run provision whenever a prompt changes.**
4. Pick the phone number, then use a test call (rings your own phone with sample data).

## Outbound calls (`src/integrations/elevenlabs.ts`)
- Kinds: `confirm` (about 2 min after booking), `speed_to_lead` (about 5 min after an A/B application with no booking), `rebook` (about 20 min after a no-show is logged). Each can be turned off with `AI_CALL_CONFIRM`, `AI_CALL_SPEED_TO_LEAD` or `AI_CALL_REBOOK` = false.
- `blockReason(lead, kind)`: no phone, do_not_call_at set, **no call_consent_at**, or a kind-specific state check (confirm: still booked and call more than 30 min away; speed_to_lead: not booked and tier A/B; rebook: status still no_show). Re-checked **before every dial and retry**.
- `queueCall`:
  - One live call per lead per kind.
  - Caps: 3 calls per phone number per week across all leads, plus an account-wide `AI_CALL_DAILY_CAP` (default 40).
  - Run time comes from `nextCallingTime(t, callingZones(phone))`. **Time zones come from the phone number's country code, never the browser's IP.** The call only goes out when every zone of that country is within hours: weekdays 9–20, Saturday 9–17, never Sunday, never on Australian national public holidays.
  - Countries outside the list are blocked.
  - Stale calls are dropped (a confirm call too close to the meeting; speed-to-lead or rebook calls more than 72h out).
  - At most 2 attempts, with a retry after 45 minutes.
- **Only queue calls for verified bookings** (a provider webhook or API). A browser report alone must never make you ring a number.
- Dynamic variables: first_name (only if it looks like a name, else "there"), opening, call_kind, call_time, closer_name, business (cleaned, 120 chars, dropped if it holds links or numbers), tier, email, lead_ref, callback_number (`AI_CALL_CALLBACK_NUMBER`), voicemail_reason (depends on the call kind).
- **The first message** discloses the AI and the recording, says "you can say stop at any time and we won't call again", and gives the callback number (TCPA rules for artificial-voice calls to US numbers).
- The prompt treats the name and business as untrusted data, and has a branch for people who object to recording.
- Webhook `/hooks/elevenlabs`: verify the HMAC signature, then store a `voice_calls` row (transcript, recording, summary, cost, structured data: wants_reschedule, wants_booking_link, do_not_call, reached_voicemail…). Act on the result: email the booking or reschedule link (`voice_link` template), set `do_not_call_at`, ping the team.
- Hard rules in the prompt: say it's an AI, honour "don't call me" immediately, a one-line voicemail only, no financial, legal or lending advice, never ask for payment details, under 4 minutes, no pressure.

## Inbound callback agent (`src/integrations/elevenlabs-inbound.ts`)
Anyone who rings the number back gets the callback agent. The conversation-initiation webhook (`/hooks/elevenlabs/init`, authenticated by an `x-funnel-secret` header) looks up caller ID and returns limited variables: first name, status and call time. **Caller ID can be spoofed**, so never pass the email, business or answers, and never read details back. The agent can confirm, request a rebook or log a callback request. A caller matched only by a spoken email gets linked for the team, but no action is taken on their request. `syncInbound` (cron) pulls inbound conversations into `voice_calls`.

## Consent (`CALL_CONSENT` in config)
An unticked checkbox at application step 1, with text naming the business, AI calls and recording and saying it isn't a condition of purchase. Store `call_consent_at` and `call_consent_text`. In the US, TCPA needs prior express written consent for artificial or prerecorded voice. In Australia, follow the Telemarketing Standard and check the Do Not Call Register where it applies.



## Sales team and Funnel HQ dashboard

## Reps (Team tab, `reps` table)
Each rep has: name, email, role (closer/setter), tiers taken, round-robin weight, calendar URL, commission %, monthly target, Slack and Discord user ids (for @mentions), and an active flag.

## Outcomes (`applyLeadUpdate` in `src/sales/outcomes.ts`)
- Statuses: booked → showed / no_show → won / lost (or disqualified, or nurture). The update stamps `showed_at` and `closed_at`, dated to the call when you log an old call.
- **Deal markers**: industry, revenue_band, budget_band, willing_to_invest, temperature (hot/warm/cold), objection (`OBJECTIONS`), follow_up_at, decision_maker, fit_rating 1–5, offer, payment_plan, installments_total, next_payment_at, contract_signed_at, refunded_at, refund_amount, loi_signed_at, target_business, lost_reason (`LOST_REASONS`).
- `payments` ledger: `recordPayment` and `deletePayment` keep `cash_collected` in sync.
- Side effects (skipped when `isHistorical(lead)`, i.e. a calendly-direct import or a call more than 14 days old):
  - no_show → `no_show` sequence + AI rebook call.
  - showed → `post_call`.
  - won → `won` onboarding.
  - lost → `lost` re-engagement.
  - won, lost or disqualified cancels every other sequence.
  - Team pings for each outcome.
  - Meta: CallShowed and Purchase with value.
- `pingUpcomingCalls` (cron): pings the assigned rep about 15 minutes before each call, with the lead summary and how much of the VSL they watched.
- Daily digest to Slack/Discord at a local time (`maybeSendDigest`).

## Notifications (`src/integrations/notify.ts`)
Slack incoming webhook and/or Discord webhook. Events: hot lead (A), qualified (B), booked, cancelled, call in 15 minutes, no-show, held, won 🎉, lost, AI call results, digest. **Escape Slack mrkdwn and Discord markdown** in lead-provided text, and keep PII to what the team needs.

## Funnel HQ tabs (`public/admin/index.html` + `public/assets/admin.js`)
Overview (KPIs + the full funnel to revenue + trends) · **Funnel map** · VSL (retention curve, pitch marker, drop-offs) · Links & videos · Traffic & ads (15 dimensions to revenue per visitor) · Landing pages & tests · On-page behaviour (clicks, form friction, exits, re-reads, highlights) · Application (step drop-off, answers, score histogram) · Sales team (calls, show rate, closes, cash by rep; call log to record outcomes; a needs-an-outcome list covering 30 days) · Insights (everyone who booked, split by tier; A-tier unpacked; Calendly monthly) · Team · Leads (CRM: search, filters, CSV, a drawer with the journey timeline, a Deal card, payments, behaviour facts with an email preview, Calendly bookings) · Emails (sequences, queue, behaviour triggers, deliverability) · Voice (ElevenLabs setup, call log, transcripts) · Tracking (forwarding and match quality) · Live (5-second stream) · Integrations (keys, test buttons, Calendly connect/sync/import/requalify).

A shared date-range + channel + campaign + variant + device filter bar sits at the top. Tabs that don't use it hide it (`noFilters`).

## Funnel map (`public/assets/funnel-map.js`)
- About 40 built-in nodes, each `{ id, kind (traffic|page|decision|auto|people|data), x, y, title, sub, tab, stat?, how }`. Edges are `[from, to, label | 'r:<rate>', style auto|data|dash]`. Nodes cover traffic → smart route → landers/main → VSL → application → score → A/B/C → booked → call → won/lost/no-show, plus the automations (AI calls, pre-call emails, pings, post-call, abandoned, speed-to-lead, get-booked, cancelled/rebook, onboarding, re-engagement, nurture) and the engine room (tracking, behaviour profile, triggers, Claude personalisation, application reader, callback agent, HQ).
- Rendering: 220×92 boxes positioned with transform, SVG bezier edges with arrowheads, rate labels computed from `/overview` (play→apply, applied, booked, show, close; hidden when over 100%). Live stat per node.
- Interactions:
  - Drag boxes (10 px snap); positions are saved (`PUT /admin/api/map-layout`, debounced) and shared by everyone.
  - Drag the background to pan; zoom −/+; Fit; Reset layout (confirms first; your own steps keep their positions).
  - Click a box to open a side panel: how it works, its stat, comes from / leads to (jump links), and "Open in Funnel HQ →".
  - **Editable**:
    - **+ Add step** creates your own box (title, subtitle, type, opens-tab, notes).
    - Drag the ● on a box's edge onto another box to draw an arrow, or use "Connect to…" with an optional label.
    - Your own boxes and arrows can be deleted.
    - Built-in boxes can have their title and subtitle edited and notes added, with a reset to default. They can't be deleted, because they describe the real system.
- Storage: `kv_state` `map:custom` = `{ nodes[], edges[], edits{} }`, validated server-side:
  - custom ids `u_[a-z0-9]{4,20}`;
  - limits of 200 nodes and 400 edges;
  - text length caps: title 60, subtitle 90, note 2000, label 30;
  - kind restricted to the allowed set.
- Everything rendered from it **must be escaped** in both HTML and attribute contexts.



## Industry landers, Meta smart route, bandit

## Catalog (`src/landers/catalog.ts`)
- `INDUSTRIES` (20): `{ id, label, owners ("clinic owners"), one ("clinic"), many ("clinics"), target ("the practice across town"), keywords[] }`. The original list: medical, dental, allied-health, veterinary, hvac, plumbing, electrical, roofing-solar, landscaping, cleaning, security, accounting, insurance, it-services, agencies, recruitment, hospitality, childcare, logistics, property.
- `ANGLES` (5): `{ id, label, pre(i), headline(i), sub(i) }`. The original angles: loi (signed LOI in 90 days), competitor (buy the competitor), retiring (retiring owners), ceiling (growth ceiling), overfinanced. That gives 20 × 5 = 100 landers.
- Every headline must be unique across all 100. A test checks this. One bug hit here: two industries both used "practice", so their headlines came out identical.
- `inferIndustry(...texts)`: an exact id match first, then keywords. **Keywords of 4 characters or fewer must match on a word boundary** (allowing a plural "s"). Without that, "pet" matched inside "competitor". Add plurals and synonyms (roof/roofer/roofing).

## Routes (`landerPage` in `src/funnel/pages.ts`)
- `/for/:industry` → the bandit picks the angle. `/for/:industry/:angle` → a fixed angle (for a specific ad). `/m` → **smart route**: reads the industry from `?ind=`, or from the utm_campaign, utm_term (ad set) or utm_content (ad) names, e.g. "Dental – LAL 2%". If there's no match, it falls back to the main page A/B test.
- The chosen lander is stored in a `_ld` cookie (sticky per visitor) and on the session (`sessions.lander`). Leads get `lander` and first-touch `ft_lander`.
- `?preview=1` renders the page without counting the visit.
- Lander visitors are **excluded** from the main-page A/B experiment stats. The experiment query requires a non-bot `page_view` on "/" and `ft_lander IS NULL`. Without this, lander traffic inflated the main page's numbers.

## Bandit (`src/landers/bandit.ts`)
- Thompson sampling per industry over its 5 angles. Each angle gets a `MIN_VISITORS` floor (60) before sampling starts.
- Reward = leads per visitor, switching to **qualified (A/B) applications** once the industry has 30 or more qualified applications.
- `trafficShare` shows the current split in the dashboard.

## Dashboard
The "Landing pages & tests" tab merges the main-page A/B test (significance via a z-test on applications per visitor) with the 100 landers. It shows visitors, plays, leads, qualified, A-tier, booked, won, revenue and cash, by industry and by angle. It also has preview links and copyable ad URLs for `/for/...` and `/m?ind=`.



## Integrations (all optional; connected in Funnel HQ → Integrations)

| Integration | Settings keys | Where the user gets it | Notes |
|---|---|---|---|
| Public URL | PUBLIC_URL | the custom domain | Email links depend on it |
| Email (Resend) | RESEND_API_KEY, EMAIL_FROM, EMAIL_REPLY_TO, BUSINESS_ADDRESS, EMAIL_SIGNATURE | resend.com → Domains (verify) → API keys | "Send test" button. Without it, emails are simulated |
| Calendly | CALENDLY_API_TOKEN (PAT), CALENDLY_SIGNING_KEY, BOOKING_URL_A/B; BOOKING_WEBHOOK_SECRET for Cal.com/GHL/Zapier | calendly.com → Integrations → API & webhooks | "Connect" creates the webhook; "Import history"; "Requalify" |
| ElevenLabs | ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, ELEVENLABS_INBOUND_AGENT_ID, ELEVENLABS_PHONE_NUMBER_ID, ELEVENLABS_VOICE_ID, ELEVENLABS_LLM, ELEVENLABS_WEBHOOK_SECRET, AI_CALL_CONFIRM / AI_CALL_SPEED_TO_LEAD / AI_CALL_REBOOK | elevenlabs.io → API keys; Twilio number imported in ElevenLabs | Provision from the Voice tab |
| Claude | ANTHROPIC_API_KEY, EMAIL_PERSONALIZE, EMAIL_AI_MODEL | console.anthropic.com | Rules mode without it |
| Slack / Discord | SLACK_WEBHOOK_URL, SLACK_WINS_WEBHOOK_URL, DISCORD_WEBHOOK_URL, DISCORD_WINS_WEBHOOK_URL, DIGEST_HOUR | incoming webhooks | Test button |
| Meta | META_PIXEL_ID, META_ACCESS_TOKEN, META_TEST_EVENT_CODE | Events Manager | Optimise on QualifiedLead/Schedule |
| GA4 | GA4_MEASUREMENT_ID, GA4_API_SECRET | Admin → Data streams | |
| PostHog | POSTHOG_KEY, POSTHOG_HOST, POSTHOG_SESSION_REPLAY | project settings | First-party /ph proxy |
| WhatsApp | JOSH_WHATSAPP (the founder's number) + optional WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_RESOURCES_TEMPLATE, WHATSAPP_VERIFY_TOKEN, WHATSAPP_APP_SECRET | Meta Business | The number alone turns on the buttons |
| Turnstile | TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY | Cloudflare → Turnstile | Invisible check on the contact step |
| CRM | LEAD_WEBHOOK_URL | any | Lifecycle events with a lead snapshot |
| Site & video | SITE_NAME, SITE_PALETTE, VSL_MAIN_SRC/POSTER, VSL_BREAKOUT_SRC/POSTER, VSL_PRECALL_SRC | Cloudflare Stream HLS or MP4 | |
| Inbound web/phone assistant (optional, Vapi) | VAPI_API_KEY, VAPI_PUBLIC_KEY, VAPI_ASSISTANT_ID, VOICE_WEBHOOK_SECRET, VOICE_PHONE_NUMBER, VOICE_WEB_ENABLED | vapi.ai | |
| Privacy & abuse | CONSENT_REQUIRED_EU, IP_ANONYMIZE, BLOCKLIST, CLARITY_ID | — | |
| Pre-call pacing | PRECALL_EMAILS_PER_DAY (default 6, 0 = off), SALES_TIMEZONE | — | |

Rules:
- Env var beats D1, and env-set keys show as locked.
- Secrets are never echoed back to the browser.
- Each integration card shows its connected state and a test action.
- Users should never paste secrets into chat. Point them to this screen instead.



## Deploy, custom domain, DNS, deliverability

## Deploy
```bash
npm install
npx wrangler d1 create <name>            # put database_id in wrangler.jsonc (binding DB)
npx wrangler d1 migrations apply DB --remote
npx wrangler secret put ADMIN_PASSWORD   # long random value
npx wrangler secret put SESSION_SECRET
npm run check && npm run deploy          # CI or a scoped API token: CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
```
`wrangler.jsonc` needs: `main`, `compatibility_date`, the assets binding to `public/`, the D1 binding `DB`, and the cron trigger `*/5 * * * *`.

Local: put `ADMIN_PASSWORD` and `SESSION_SECRET` in `.dev.vars` (gitignored). Run `npx wrangler d1 migrations apply DB --local`, then `npx wrangler dev --test-scheduled`. Trigger the cron with `curl localhost:8787/__scheduled?cron=*/5+*+*+*+*` (or `/cdn-cgi/handler/scheduled`). Use `npm run simulate -- 150` to push synthetic traffic through the real endpoints.

## Custom domain (domain at a registrar such as Porkbun → Cloudflare)
1. Add the zone in Cloudflare, then **copy the exact two nameservers Cloudflare assigns** into the registrar. Every zone gets a different pair, and users often paste the wrong ones.
2. Cloudflare's automatic DNS import can come back empty. Before switching nameservers, snapshot the existing public DNS (A, MX, TXT, CNAME, DKIM) and recreate every record. Otherwise email breaks.
3. Attach `apply.<domain>` to the Worker as a Custom Domain (Workers → Settings → Domains & Routes). It survives deploys.
4. Update `PUBLIC_URL` and point every webhook at the new domain: Calendly (create the new subscription, delete the old one), the ElevenLabs post-call and init webhooks, WhatsApp. Keep the old workers.dev URL working during the cutover.
5. Protect `/admin*` with Cloudflare Access.

## Email authentication
- **SPF**: one TXT record at the apex, merging every sender, e.g. `v=spf1 include:_spf.google.com include:<other senders> -all`. Never publish two SPF records.
- **DKIM**: add the provider's key (Google Workspace `google._domainkey`, Resend's records, etc.). For Google, the user then has to click "Start authentication" in the Admin console.
- **DMARC**: start with `p=none; rua=mailto:…`, then tighten to quarantine or reject once reports are clean.
- In a sandbox, DNS lookups can be intercepted. Verify with the Cloudflare API, RDAP or zone status rather than `dig`.



## Security and privacy checklist

The original build went through an adversarial review: four specialist reviewers, then skeptic agents trying to disprove each finding. The confirmed findings below show what goes wrong in this kind of funnel. Build every item in from the start. Each has a regression test in `test/security.test.ts`.

## Anything a stranger can type is hostile
Strangers control: application answers, names, email, phone, UTMs, referrer, Calendly booking answers, page beacons (FAQ text, selected text), and what callers say. Email addresses are **never verified**, so an attacker can use someone else's.

- [ ] **Escape lead text before it reaches email HTML.** Do it once, at the source (`buildDossier` → `escHtml`), so no template can forget. Decode entities only in the plain-text part.
- [ ] **Defang quoted text** (`defang()` in `lib/text.ts`): replace URLs, bare domains, emails and phone numbers with `[…]`. Otherwise anyone can make your domain send "pay at evil-site.com, call +1 555…" to any inbox.
- [ ] **Never trust beacon text as content.** For example, only use FAQ questions that are actually in `FAQS`.
- [ ] **AI output validation** (`validateAi`) rejects links, HTML, bare domains, emails, phone numbers, requests for payment or credentials, banned words, outcome promises and exclamation marks. On rejection, fall back to rules mode. In the prompt, frame lead text as **data, not instructions**.
- [ ] **Validate email addresses strictly** (RFC atext only): no `<>"()[]`. `"<svg onload=…>"@x.co` is a valid RFC address.
- [ ] **Escape every display sink**: admin `innerHTML` (an `esc()` helper on every interpolation, attributes double-quoted), the unsubscribe page, and Slack/Discord. For chat, strip `< > [ ] | \``, break up `://` and `www.`, and set `allowed_mentions`.
- [ ] **Voice agents**: only pass a first name that looks like a name and a cleaned short business description. Tell the agent the fields are data. Never put free text in the system prompt unfiltered.

## Identity: an email address isn't proof
- [ ] **Never update, re-subscribe or link a browser to an existing lead because someone typed its email.** Send a "continue your application" link to that inbox instead. Only the signed email-link redirect links a browser to a lead.
- [ ] **Never clear `unsubscribed_at` from a public endpoint.**
- [ ] **Ref codes aren't secret**, so don't link browsers by `?l=<ref>`.
- [ ] **A spoken email on an inbound call** is not identity: link the call for the team, but take no actions on it. Caller ID can be spoofed, so the inbound agent says nothing beyond first name and call time.
- [ ] **Calendly email-only matches** are weaker than `salesforce_uuid` matches. Treat them as unverified for anything risky.

## Bookings: browser reports are claims
- [ ] When the provider can confirm a booking (a signed webhook or the Calendly API), a **browser report only updates the page**. Emails, AI calls, team pings and ad conversions wait for the provider's confirmation, and that confirmation fires them exactly once.
- [ ] Only queue the AI confirmation call for **verified** bookings.

## AI phone calls: toll fraud and harassment
- [ ] **Calling hours come from the phone number's country, across all of its time zones**, never from the browser that filled in the form (which can be a VPN). AU (6 zones) and US+CA (11 zones) narrow to the window that's OK everywhere. Hawaii and Alaska area codes are special-cased.
- [ ] **Only call countries you serve.** Everything else is blocked, including premium and international revenue-share numbers.
- [ ] **Caps**: at most 3 calls per number per week across all leads, and an account-wide daily cap (`AI_CALL_DAILY_CAP`). Also set geo permissions and spend limits in Twilio and ElevenLabs.
- [ ] **No Sundays; Saturdays 9–17; weekdays 9–20; Australian national public holidays** (Easter computed).
- [ ] **Disclosure at the start of every call**: that it's an AI, that it's recorded, "say stop at any time", and a callback number (TCPA 47 CFR 64.1200(b) for US numbers). The voicemail wording depends on the call type, and there's a branch for people who object to recording.
- [ ] **Consent is per number**: changing the phone resets the consent timestamp. The checkbox is unticked by default, and the consent text version is stored.
- [ ] **`blockReason` is re-checked at queue time and at dial time**, including retries.

## Admin
- [ ] Put **Cloudflare Access** in front of `/admin*` (SSO), on top of the password.
- [ ] **Login lockout**: 10 failures per IP per 15 minutes, logged.
- [ ] **Session token** = `admin.<exp>.<password fingerprint>.<epoch>`, HMAC-signed, HttpOnly, Secure, SameSite=Strict, 3 days. Changing the password or logging out revokes every session.
- [ ] **Same-origin writes**: reject any non-GET whose `Sec-Fetch-Site` or `Origin` isn't same-origin. `c.req.json()` happily parses `text/plain`, so SameSite alone isn't enough against sibling subdomains.
- [ ] `cache-control: no-store` on every admin response.
- [ ] **CSP on `/admin`**: `default-src 'self'; script-src 'self'; … frame-ancestors 'none'`. No inline scripts in the dashboard.
- [ ] **Email previews** are served with `CSP: sandbox`, and shown in `<iframe sandbox>` (without `allow-scripts`) using `srcdoc`.
- [ ] **Secrets are never returned to the browser.** Show only "set" or the last 4 characters (16+ character secrets only).
- [ ] **Webhooks fail closed** (501) when no secret is configured. Use HMAC over the raw body, constant-time comparison and a replay window. Prefer headers over `?secret=` in the URL.
- [ ] **Tracked-link destinations** must be same-origin paths: `^\/(?!\/)`. `//1249767370` is an open redirect.
- [ ] The **first-party PostHog proxy** allowlists methods, paths and the PostHog host, forwards only the headers it needs, and strips `set-cookie`.
- [ ] **HSTS**, `nosniff`, `referrer-policy`, and `X-Frame-Options` (SAMEORIGIN on pages, DENY on admin).

## Privacy (Australia, NZ, US, Canada, UK, EU)
- [ ] **Consent countries** = EU + UK + NO + IS + LI + CH (Cloudflare's `isEUCountry` covers the EU only). Until consent is given there are no advertising cookies (`_fbp`/`_fbc`), no Pixel, no session replay and no forwarding. Provide a "Cookie settings" button so people can withdraw consent, and link the privacy policy from the banner.
- [ ] **Never capture typed text**: field tracking records timing and counters only, and selection/copy tracking ignores form fields and anything that looks like PII.
- [ ] **No plaintext PII to analytics.** PostHog gets the lead id, tier and status, not email, name, phone or free text. Meta and GA4 get SHA-256-hashed match keys only.
- [ ] **Team pings** include the name, ref and a dashboard link only, not email, phone or transcripts.
- [ ] **Imported contacts** (calendly-direct, older history) never get marketing, calls, pings or ad conversions, on any path, including webhooks.
- [ ] **Retention**: delete raw events after 13 months, and strip IP, user agent and precise location from old sessions. Offer erasure on request.
- [ ] **Email**: every message has a physical postal address in both the HTML and text parts, one-click unsubscribe (RFC 8058), and the unsubscribe stops every sequence.
- [ ] **The privacy policy must match the code**: list every processor and its country (Cloudflare, Resend, Calendly, Anthropic, ElevenLabs/Twilio, Vapi, PostHog, Meta, Google, Slack/Discord), the AI calls, AI-written emails, profiling, retention, rights and the complaints route. Have a lawyer review it.

## Known residual items (decide per business)
- No phone OTP before AI calls. Consent plus caps plus country limits reduce the risk, and SMS OTP would remove wrong-number risk.
- Email bombing via new sign-ups: every new address gets the abandoned sequence. Enforce Turnstile (`TURNSTILE_SECRET_KEY`) and consider per-IP caps or double opt-in.
- Shared admin password with no audit log: use Cloudflare Access with SSO for named users.
- No opt-out list for unknown numbers that ask the inbound agent not to call again.



## Gotchas (each one was hit in the original build)

- **Historical imports almost emailed real people.** Importing past Calendly bookings created leads, and logging their old outcomes would have fired no-show, post-call and won emails, team pings and Meta Purchase events. Fix: `isHistorical(lead)` (calendly-direct, or a call more than 14 days old) skips every side effect, and tracking uses `localOnly`.
- **The Calendly link 404'd** after the username changed. Validate the booking URL and refresh it from the API.
- **Reconnecting the Calendly webhook** left a stale subscription. Delete the old one, and never delete subscriptions you didn't create.
- **Main-page A/B stats were inflated by lander visitors.** Exclude `ft_lander` and require a `page_view` on "/".
- **Industry keyword false positives**: "pet" matched inside "competitor". Use word boundaries for short keywords and add plurals and synonyms. Duplicate headlines appeared when two industries shared the word "practice".
- **Variable shadowing in `f.js`**: a second `var sent` broke scroll tracking. Wrap features in IIFEs and use unique names.
- **Creepy personalisation**: "You copied this text…" read like surveillance. Only say back facts that have an explicit `you` line, and keep background facts in the `BACKGROUND` set. Bridge sentences only appear when the topic matches.
- **The personaliser repeated application answers** inside emails that already quoted them. Add `ANSWER_FACTS` to `used` for dossier templates.
- **Template crashes on empty applications** (non-null assertions). Every template needs fallbacks, and a test renders every template against an empty lead.
- **Subject collisions across sequences** (a test asserts subjects are unique). Check when adding templates.
- **Rates over 100%** (more leads than plays, because imports never watched): hide impossible rates.
- **Killing `wrangler dev` with pkill inside a compound shell command** returns exit 144. Run the kill as a separate command.
- **Cloudflare's DNS import came back empty**: recreate the records from a public-DNS snapshot.
- **Users enter the wrong Cloudflare nameservers**: give the exact pair.
- Auto-mode safety classifiers may block DNS, domain and certificate changes. Ask the user to do those steps, or have them approve.
- When a voice prompt changes, the live ElevenLabs agent doesn't update until you re-run provision.

## From the security review
- **Lead text became HTML in emails.** The new follow-up templates quoted why-now and booking answers raw, which let anyone send phishing links from your domain to any inbox (email addresses aren't verified). Escape and defang at the source.
- **Email-match takeover**: re-entering a known email overwrote the phone number, cleared the unsubscribe and linked the attacker's browser to the lead.
- **Fake bookings**: `/api/booking/client` (a browser report) triggered the confirmation AI call, emails and the Meta Schedule event. Combined with an unverified phone number, that made Sam a free robocaller to any number.
- **Calling hours came from the browser's IP time zone**, so a VPN made us ring someone at night.
- **Rules-mode personalisation quoted the FAQ question from the beacon verbatim**, which a script can set to anything.
- **Cloudflare `isEUCountry` excludes the UK.**
- **`getSelection()` returns text typed in a textarea**, so "selected text" tracking captured form input.
- **The privacy policy said "we never make AI calls"** after AI calls were added. Keep the policy in step with the code.
- Agents running security work can be stopped by model safeguards partway through. Frame tasks as defensive review of the owner's own code, and keep the evidence you already have.

