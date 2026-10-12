# Build prompt: High-ticket VSL funnel + "Funnel HQ" (frontend + backend)

> **How to use:** paste everything below the line into a new Claude Code session, ideally an empty repo or folder. Fill in the `[[…]]` blanks first, or leave them and Claude will ask once. For the full reference spec, also give it the skill (`vsl-funnel-builder.skill`) or `vsl-funnel-builder-PASTE.md`.

---

You are building a complete, production-grade **high-ticket sales funnel plus a CRM/analytics dashboard ("Funnel HQ")**. It runs as **one Cloudflare Worker** with a **D1** database and no other servers. Build the backend (TypeScript, Hono, D1, cron) and the frontend: server-rendered funnel pages with tiny vanilla-JS scripts, and a vanilla-JS admin single-page app. Work in phases. After every phase:

1. Run typecheck and unit tests.
2. Run it locally with `wrangler dev` and drive the real endpoints.
3. Take Playwright screenshots of any UI you built and look at them.
4. Fix what's wrong.
5. Commit.

Deploy when I give you Cloudflare credentials.

## 0. My offer (fill in)

- **Business / brand:** [[e.g. G&L M&A Advisory]]. **Founder / face:** [[e.g. Josh Li]]. **Sender:** [[Name <name@domain>]]. **Postal address:** [[…]]
- **Promise:** [[e.g. a signed LOI in 90 days on a no-money-down acquisition that doubles or triples your business, over-financed, deals tested at ~1.5x DSCR]]
- **ICP:** [[e.g. owners of profitable businesses doing $1M+ revenue]]. **Markets:** [[AU, NZ, US, CA, GB, IE, SG, AE]]. **Sales time zone:** [[Australia/Sydney]]
- **Guarantee:** [[7-day money-back]]. **Delivery:** [[done WITH you, not done for you]]. **Price range:** [[…]], discussed on the call only.
- **Banned words and claims:** [[e.g. never call the strategy call "free"; no outcome promises; no fake testimonials]]
- **Team:** [[closers/setters, which tiers each takes, booking links]]
- **Domain:** [[apply.yourdomain.com]]

Rules for you:

- **Secrets:** never ask me to paste API keys into chat. Build the Integrations screen and I'll enter keys there. Everything must work in **simulation mode** with no keys: emails are marked "simulated", no calls are placed and nothing is forwarded.
- **Copy:** write all copy in the founder's voice: plain, short sentences, no hype, no exclamation marks, no emojis in emails. Respect the banned list. Never fabricate testimonials, results, clients or case studies. Label illustrative numbers "illustrative, not advice".

## 1. Stack and layout

- `wrangler` + TypeScript + `hono` + D1 (binding `DB`) + an assets binding for `public/` + cron `*/5 * * * *`. Add `@anthropic-ai/sdk` for email personalisation. Dev dependencies: `vitest`, `@cloudflare/workers-types`.
- Scripts: `dev`, `deploy`, `db:migrate:local`, `db:migrate:remote`, `typecheck`, `test`, `check` (typecheck + test), `simulate` (pushes N synthetic visitors through the real endpoints).
- **No client framework.** Pages are static HTML templates in `public/`, filled in server-side with **HTMLRewriter**. Funnel pages ship ~15 KB of JS in total.

```
src/
  index.ts         routes, security headers, admin login/logout, /ph PostHog proxy, scheduled()
  app.ts           Runtime { env, settings, origin, reps, waitUntil }
  config.ts        ALL editable content: brand, videos (+ ctaRevealAt), headline A/B variants, landing/breakout copy,
                   FAQS, APPLICATION questions/points/flags, TIER_THRESHOLDS, TIER_RULES, TIER_ROUTES, CLOSERS,
                   EXCLUDED_INDUSTRIES, TARGET_COUNTRIES, CALL_CONSENT, AI_CALLER (hours, delays), voice prompts, ECONOMICS
  settings.ts      integration keys: env var > D1 settings row > default; 15 s cache; this list drives the Integrations UI
  lib/             identity (cookies, sessions, geo, bots), attribution, ua, crypto (hmacHex, safeEqual, sign/verifyToken),
                   ids, secret, text (defang/hasContactBait), retention
  tracking/        catalog, track, collect, forward (Meta CAPI, GA4 MP, PostHog, CRM webhook + retries), vsl (heartbeats)
  funnel/          pages, application, scoring, routing, leads, tracked-links
  landers/         catalog (20 industries × 5 angles), bandit
  integrations/    email, sequences, templates, booking, calendly, elevenlabs, elevenlabs-inbound, voice (Vapi, optional),
                   whatsapp, notify (Slack/Discord)
  followup/        dossier (application reader), templates (application-specific follow-up)
  personalize/     profile (behaviour facts), personalize (rules + Claude), triggers (behaviour rules)
  sales/           reps, outcomes, qualify, digest
  admin/           auth, stats, sales, insights, landers, behaviour
  routes/          api (public), links (/l /r /o /u /go/wa), hooks (webhooks), admin (admin API)
public/            index.html, apply.html, book.html, breakout.html, resources.html, privacy.html,
                   admin/index.html, admin/login.html,
                   assets/{site.css, f.js, vsl.js, apply.js, book.js, admin.css, admin.js, funnel-map.js}
migrations/        0001..0011
test/              vitest per module + security.test.ts
```

## 2. Database (D1 migrations; add new migrations, never edit applied ones)

1. **0001**
   - `visitors`: first-touch attribution, geo, device, bot flag, counters, lead_id.
   - `sessions`: landing, referrer, channel, utm_*, 11 click-id types, ad_id/adset_id/placement, full Cloudflare geo incl. is_eu, ip or ip_hash, UA parse, client tz/screen/viewport, bot reason, A/B variant, pageviews, engaged_ms, max_scroll.
   - `events`: id, ts, name, visitor_id, session_id, lead_id, path, source, variant, is_bot, props JSON. Indexes on (name, ts), lead_id, visitor_id.
   - `leads`: contact, `answers` JSON, step_reached, app started/completed, score, score_breakdown, tier, tier_override, route, closer_id, status (`partial|applied|booked|showed|no_show|won|lost|nurture|disqualified`), booked_at, call_at, booking_provider/ref/cancelled_at, WhatsApp fields, unsubscribed_at, revenue, notes, last + first-touch attribution, geo, fbp, fbc. UNIQUE on email.
   - `vsl_views`: 100-bucket watched bitmap, played, unmuted, completed, cta_revealed, cta_clicked.
   - `emails`: queue + log, UNIQUE(lead_id, sequence, step). Status `pending|sending|sent|simulated|skipped|cancelled|failed`. Tracks opens and clicks.
   - `whatsapp_messages`, `settings`, `kv_state`.
2. **0002** `voice_calls` (transcript, recording_url, summary, structured, cost) and `leads.do_not_call_at`.
3. **0003** `forward_log` (per event × destination: status, attempts, backoff, match keys, payload).
4. **0004** `tracked_links`.
5. **0005** `reps` (role, tiers, weight, calendar_url, commission_pct, monthly_target, slack/discord user ids, active) and leads `cash_collected`, `closed_at`, `showed_at`, `lost_reason`, `setter_id`.
6. **0006** `outbound_calls` (kind `confirm|speed_to_lead|rebook|test`, status, run_at, attempts, conversation_id, call_sid, outcome) and leads `call_consent_at`, `call_consent_text`, `timezone`.
7. **0007** emails `personalized`, `facts_used`, `personalize_error`.
8. **0008** leads `booking_join_url`, `booking_reschedule_url`, `booking_cancel_url`, `booking_host_email`, `booking_answers` JSON, `booking_source` (`funnel|calendly-direct`).
9. **0009** `calendly_bookings`, keyed by invitee_uri.
10. **0010** deal markers on leads (industry, revenue_band, budget_band, willing_to_invest, qual_source, qual_flags, temperature, objection, follow_up_at, decision_maker, fit_rating, offer, payment_plan, installments_total, next_payment_at, contract_signed_at, refunded_at, refund_amount, loi_signed_at, target_business) and a `payments` ledger.
11. **0011** `sessions.lander`, `leads.lander`, `leads.ft_lander`.

## 3. Backend: build in this order

### Phase 1: Skeleton

- Hono app.
- `settings.ts` resolution: env, then D1, then default, with a 15 s cache. Never return secret values to the browser: show "set", or the last 4 characters for secrets of 16+ characters.
- `/health`, and `/robots.txt` disallowing everything.
- Security headers on every response:
  - nosniff, a strict referrer policy, `x-robots-tag: noindex`, HSTS on https.
  - `X-Frame-Options: SAMEORIGIN` on pages and DENY on `/admin*` and `/u/*`.
  - A strict CSP on `/admin` and `/u/*`: `default-src 'self'; script-src 'self'; … frame-ancestors 'none'`.
- **Admin auth:**
  - POST `/admin/login` with a password (the `ADMIN_PASSWORD` secret).
  - Per-IP lockout: 10 failures per 15 minutes, stored in kv_state.
  - Cookie `_fa` = HMAC-signed `admin.<exp>.<sha256(password)[:16]>.<epoch>`. HttpOnly, Secure, SameSite=Strict, 3-day lifetime.
  - Logout bumps the epoch, which revokes every session.
  - `requireAdmin` on `/admin` and `/admin/api/*`. It rejects any non-GET whose `Sec-Fetch-Site` or `Origin` is not same-origin, and sets `cache-control: no-store`.
- `scheduled()` runs each job wrapped so one failure can't stop the others:
  - processEmailQueue
  - retryForwards
  - pingUpcomingCalls
  - maybeSendDigest
  - processCallQueue
  - syncInbound
  - syncCalendly (hourly gate)
  - processTriggers
  - purgeOld (daily: delete raw events older than 13 months; strip IP, UA and precise location from old sessions)

### Phase 2: First-party tracking

- **`withVisitor` middleware:**
  - `_fv` visitor cookie: server-set, HttpOnly, 400 days.
  - `_fs` session: 30 minutes idle; a new ad click starts a new session.
  - Captures Cloudflare geo, ASN and TLS; UA parse plus bot detection; UTMs plus click ids (gclid, gbraid, wbraid, fbclid, ttclid, msclkid, li_fat_id, twclid, ScCid, epik, rdt_cid); GA4-style channel grouping.
  - **Writes the page_view server-side before returning HTML.** Skips prefetch and prerender.
- **Consent:**
  - Consent is required for the EU plus GB, NO, IS, LI and CH.
  - Until the visitor consents: no `_fbp`/`_fbc`, no Pixel, no session replay, no forwarding.
  - `/api/consent` sets `_fc`. Declining deletes the ad cookies.
- **`track(rt, identity, {name, source, props, localOnly})`** writes to D1, then forwards (via waitUntil) to:
  - **Meta CAPI**: SHA-256 hashed em/ph/fn/ln/country plus fbp, fbc, IP and UA. `event_id` dedupes with the Pixel. QualifiedLead and Schedule carry tier-weighted values.
  - **GA4** Measurement Protocol.
  - **PostHog**: distinct_id = visitor id; `$set` only lead_id, tier and status — **no email, name, phone or free text**.
  - A **CRM webhook**.
  - Retries go through `forward_log`. MICRO_EVENTS (click, field_interaction, cta_hover, section_dwell, tab_return, text_select, text_copy, section_revisit, page_exit, vsl_volume/pause/skip…) are stored but never forwarded.
- **`/api/e` beacon:**
  - Only same-origin; 32 KB cap.
  - Event whitelist from `catalog.ts`, max 25 per request, props flattened to 20 keys and 300 chars.
- **`/api/v` VSL heartbeat:** every 10 s with a 100-bit watched bitmap. The server ORs it into `vsl_views`, fires vsl_25/50/75/95/complete/cta_reveal exactly once, and only counts a view after unmute.
- **Identity stitching:**
  - Contact at application step 1 back-fills the visitor's history onto the lead.
  - **Only signed email-link clicks** (`/r/:emailId/:sig?u=`) link another browser to an existing lead.
  - Webhooks and cron rebuild IP, UA, fbp and fbc from the lead's last session.

### Phase 3: Application, scoring and routing

**Application steps.** Questions are config-driven; build these:

1. **Contact:** first name, last name, email, mobile, plus an **unticked** AI-call consent checkbox with full disclosure text (store a version string).
2. **Business:** text.
3. **Role:**

   | Option | Points | Flag |
   |---|---|---|
   | owner | 20 | |
   | co-owner | 16 | |
   | exec | 6 | not_owner |
   | none | 0 | no_business |

4. **Revenue:**

   | Option | Points | Flag |
   |---|---|---|
   | <$1M | 0 | under_1m |
   | $1–3M | 15 | small |
   | $3–10M | 22 | |
   | $10M+ | 25 | |

5. **Profit:**

   | Option | Points | Flag |
   |---|---|---|
   | loss | 0 | unprofitable |
   | <250k | 8 | |
   | 250k–1M | 16 | |
   | 1M+ | 20 | |

6. **Goal:**

   | Option | Points |
   |---|---|
   | acquire | 10 |
   | group | 10 |
   | exit | 8 |
   | unsure | 2 |

7. **Timeline:**

   | Option | Points | Flag |
   |---|---|---|
   | 0–6 months | 15 | |
   | 6–12 months | 10 | |
   | 12+ months | 4 | |
   | exploring | 0 | exploring |

8. **Blockers:** multi-select of deal_flow, funding, valuation, integration, time, never_considered.
9. **Readiness:**

   | Option | Points | Flag |
   |---|---|---|
   | yes | 15 | |
   | with partner | 9 | partner |
   | not now | 0 | not_ready |

10. **Why now:** text; +5 points at 160+ characters, +3 at 60+.

**Contact step behaviour.**

- `saveContact` creates the lead (status `partial`) and starts the `abandoned` sequence.
- Validation: strict email (RFC atext only; reject `<>"()[]`); disposable domains rejected; phone normalised to E.164; optional Turnstile.
- **If the email already belongs to a lead this browser isn't linked to:** change nothing, send that inbox a rate-limited "continue your application" link, and return 409. Never clear `unsubscribed_at` from a public endpoint. A changed phone number resets call consent.

**Scoring.**

- Sum the points.
- Flags also cover excluded industries (whole-word match), personal email domains, out-of-market countries and a blocklist.
- `TIER_THRESHOLDS {A:70, B:40}`, then hard caps:
  - max C: blocked, excluded industry, no business, under $1M.
  - max B: not owner, unprofitable, not ready, exploring, personal email + small, out of market.
- Store `score_breakdown`.

**Routing.**

- A → `/book` (closer calendar); B → `/breakout`; C → `/resources`.
- Weighted round-robin across active reps for that tier, with the pointer stored in kv_state.

**On submit:**

- cancel `abandoned`;
- start the tier sequence and the 6-month `nurture`;
- queue the speed-to-lead AI call (A/B, consent only);
- ping Slack/Discord;
- track app_submitted and lead_qualified.

### Phase 4: Booking (Calendly)

- **Embed** with `salesforce_uuid=<lead id>` and the prefill. The browser's postMessage goes to `/api/booking/client`, and that report is **only a claim**: when a signed webhook or the Calendly API can confirm the booking, a client report only updates the page. Emails, AI calls, pings and conversions wait for verification and then fire exactly once.
- **`/hooks/calendly`:** HMAC over `t.rawBody` (`Calendly-Webhook-Signature`), 5-minute replay window, constant-time compare. **Return 501 if no key is configured.**
- **Personal access token (Integrations → Calendly):**
  - **Connect:** `/users/me`, create the webhook subscription with a generated signing key, delete only the stale ones you created.
  - `eventWithInvitees`: start time, join URL, host (the host becomes the closer), reschedule and cancel URLs, and `questions_and_answers` → `booking_answers`.
  - Hourly `syncCalendly` (picks up cancellations and no-show marks).
  - `importCalendlyHistory` → `calendly_bookings` plus leads with `booking_source='calendly-direct'`.
  - `qualifyCalendly`: booking answers → revenue band, budget, tier.
  - `requalifyCalendlyLeads`, `linkOrphans`.
- **`markBooked`:** idempotent per ref. A reschedule updates `call_at`. On a new verified booking: cancel the tier/abandoned/no-show/cancelled/nurture/lost sequences, queue the confirm AI call, ping the team, then enqueue `booked` reminders plus the pre-call barrage.
- **`markCancelled`:** stop the booked sequence, the barrage and the confirm call, then start the `cancelled` sequence.
- **calendly-direct leads only ever get field updates:** no emails, calls, pings or ad events.
- **Generic `/hooks/booking`** (Cal.com HMAC header, or a header secret for GHL/Zapier).

### Phase 5: Email engine and sequences

- **Resend.** `enqueueSequence` upserts rows (re-enqueueing reschedules them).
- `processEmailQueue` claims rows atomically (pending → sending), then re-checks against fresh lead data: unsubscribed, the sequence's `stopIf`, the step's `skipIf`. It builds, personalises and sends in batches of 6, never the same lead twice in a batch. 3 retries.
- **Every link is a signed redirect** `/r/:id/:sig`. Add an open pixel `/o/:id.gif` and signed one-click unsubscribe `/u/:lead/:sig`: GET shows a confirm page, POST unsubscribes and cancels everything; send the RFC 8058 headers. The postal address goes in both the HTML and text parts.
- **Sequences.** Steps are **append-only** because the step index is the dedupe key.

  | Sequence | Trigger | Timing | Stops when |
  |---|---|---|---|
  | abandoned | contact saved | 15m, 3h, 1d, 2d, 4d | — |
  | tier_a | A submit | 2m, 1h, 4h, 20h, 2d, 3d, 5d, 7d | booked |
  | tier_b | B submit | 2m, 3h, 1d, 2d, 3d, 5d, 7d, 10d | booked |
  | tier_c | C submit | 1m, 2d, 5d, 9d, 14d, 21d | — |
  | nurture | any submit | 25d, 35d, 50d, 65d, 80d, 100d, 120d, 150d, 180d | booked |
  | booked | booking | now; 48h, 24h, 3h, 1h, 10m before (with join/reschedule links) | — |
  | precall | booking | see below | — |
  | no_show | no-show logged | 15m, 1d, 3d, 5d, 7d, 10d, 14d (plus an AI rebook call) | — |
  | post_call | call held, no decision | 2h, 1d, 2d, 3d, 5d, 7d, 9d, 12d, 21d (one email answers the objection logged on the call) | — |
  | cancelled | Calendly cancel | 30m, 1d, 3d, 6d | — |
  | lost | lost logged | 3d, 21d, 45d, 75d, 120d, 180d (angle chosen by lost reason) | — |
  | won | won logged | 10m, 1d, 3d, 7d, 14d, 30d onboarding | refund |
  | behaviour | trigger rules | one-off emails | — |

- **Pre-call barrage:**
  - Up to N a day (setting; default 6) at local slots 7:30, 9:30, 12:00, 14:30, 17:00 and 19:30.
  - Runs from 90 minutes after booking until 3 hours before the call, kept 45 minutes clear of the 48h/24h reminders.
  - Use a pure, unit-tested `precallTimes()` and a DST-safe `zonedTime()`.
  - `precallPlan(lead)` sends 2 lead-specific prep emails first, then alternates prep emails with 24 one-pain-point emails.

### Phase 6: Application reader and application-specific follow-up

- **`buildDossier(lead)`** takes the answers and Calendly answers and returns:
  - business, industry (from the industry catalog), revenue/profit labels, goal, timeline, blockers[], readiness, role, whyNow, booking Q&A, objection, lost reason;
  - an illustrative first-deal shape by profit band.
- **Everything a lead typed is escaped and defanged here, once.** URLs, domains, emails and phone numbers become `[…]`.
- Copy blocks keyed by answer: `BLOCKERS`, `GOALS`, `TIMELINES`, `OBJECTIONS`, `LOST_ANGLES`.
- **Templates:**
  - **Prep:** brief ("I read your application"), blocker 1 and 2, booking answers, numbers, goal, industry, why-now, partner, timeline, homework.
  - **Extensions:** no-show, post-call, cancelled, lost, won onboarding, nurture.
- **Every template must render with an empty application.**
- **Tests** check every template for: no "undefined", "null" or "NaN"; subjects unique and under 80 characters; no "free call".

### Phase 7: Behaviour profile, triggers and Claude personalisation

- **`buildProfile`** turns behaviour into facts `{key, text, weight, topics, you?}` from: VSL chapters, rewatches, FAQ opens (only questions that really exist in FAQS), section dwell, re-reads, highlights and copies (background only), CTA hesitation, field struggle, answers, booking behaviour, email opens/clicks and AI calls.
  - The **BACKGROUND** set is never said back to the lead.
  - `TEMPLATE_TOPICS` matches facts to emails.
- **Personalisation:**
  - **Rules mode:** inserts one `you` line, adding a bridge sentence only when the fact's topic matches the email.
  - **AI mode:** the Claude Messages API, current most capable model, structured JSON output `{subject, preheader, paragraphs[], ps, facts_used[]}`.
    - The system prompt covers voice, offer facts and banned words.
    - Lead text is framed as **data, not instructions**, and links never go to the model.
    - `validateAi` rejects: links, HTML, bare domains, emails, phone numbers, requests for payment or credentials, banned words, outcome promises and exclamation marks. A rejected output falls back to rules mode.
  - Skip facts used by earlier emails.
  - Template-quoted application answers aren't repeated.
- **Behaviour triggers:** 10 rules, each fires once per lead, max 1 per run, daily cap 8:
  - watched 50% but didn't apply
  - stalled mid-application
  - picked a date but didn't confirm
  - qualified + came back
  - 3+ visits
  - read the guarantee
  - funding interest
  - opened the booking page
  - finished the breakout video
  - booked but hasn't watched the prep video

### Phase 8: AI voice (ElevenLabs + Twilio number imported in ElevenLabs)

**Provisioning.** Voice tab steps: API key → provision (upsert the outbound agent and the inbound callback agent, set webhooks, assign the inbound agent to the number) → pick the number → test call to my phone.

**Outbound call kinds:**

| Kind | When |
|---|---|
| confirm | ~2 min after a **verified** booking |
| speed_to_lead | ~5 min after an A/B application with no booking |
| rebook | ~20 min after a no-show is logged |

**Safety rules:**

- Calling hours use the **time zones of the phone number's country**, never the browser's IP. A call only goes out when every zone of that country is within hours: weekdays 9–20, Saturday 9–17, never Sunday, never on Australian national public holidays. Hawaii and Alaska area codes are special-cased.
- Only call the countries in my markets list.
- Caps: 3 calls per number per week; daily cap via setting (default 40).
- Consent is required; do-not-call is checked when queueing and again at every dial or retry; max 2 attempts.

**Agent behaviour:**

- First message: "I'm an AI, this call is recorded, say stop any time, reach us on {callback_number}".
- Voicemail wording depends on the call kind.
- Branch for people who object to recording.
- The name and business variables are sanitised and treated as data.
- Post-call webhook: HMAC over the raw body with a replay window, stored in `voice_calls`. Acting on results:
  - email the booking or rebook link;
  - set do-not-call;
  - ping the team.

**Inbound callback agent:**

- The initiation webhook (`x-funnel-secret`) identifies the caller by caller ID and passes **only first name, status and call time**, because caller ID can be spoofed.
- If the caller is matched only by an email they spoke, the call is linked for the team but no action is taken.

### Phase 9: Sales team and notifications

- Reps CRUD.
- **`applyLeadUpdate`:**
  - Validates the status, deal markers, the `OBJECTIONS` and `LOST_REASONS` lists, and the payments ledger (`cash_collected` stays in sync).
  - Stamps `showed_at`/`closed_at`, dated to the call when logging an old call.
  - Starts and stops sequences, queues the rebook call, pings the team, and sends Meta CallShowed and Purchase.
- **`isHistorical(lead)`** (a calendly-direct import, or a call more than 14 days ago) means **no side effects at all**.
- `pingUpcomingCalls` runs 15 minutes before each call.
- A daily digest.
- Slack/Discord pings carry only the name, ref and a dashboard link. Strip `< > [ ] | \``, break up `://`, and set `allowed_mentions`.

### Phase 10: Industry landers and Meta smart route

- **Catalog:**
  - 20 industries `{id, label, owners, one, many, target, keywords}` × 5 angles `{id, label, pre(), headline(), sub()}` = 100 landers.
  - All 100 headlines must be unique.
  - Keywords of 4 characters or fewer match on a word boundary only.
- **Routes:**
  - `/for/:industry`: the bandit picks the angle.
  - `/for/:industry/:angle`: fixed angle.
  - `/m`: the smart route. Reads `?ind=`, or the campaign/adset/ad name, falling back to the main A/B test.
  - Sticky `_ld` cookie; `sessions.lander`, `leads.lander`/`ft_lander`; `?preview=1` isn't counted.
- **Bandit:** Thompson sampling per industry with a 60-visitor floor per angle. The reward switches to qualified applications once the industry has 30 or more.
- **Main A/B test:** excludes lander visitors and runs a z-test on applications per visitor.

## 4. Frontend: funnel pages (`public/`, server-filled)

Design: a calm editorial look ("paper" palette: off-white, ink, one accent), system fonts or one Google font, mobile-first, fast. Use `data-slot` attributes for server-filled text and `data-section` on the main blocks (video, guarantee, testimonials, faq, book_cta, whatsapp) for tracking.

**`/` landing VSL:**
- server-chosen headline variant;
- a muted autoplay player (`vsl.js`) with a "click to listen" overlay that restarts with sound;
- no seek bar, and a progress bar that runs fast early;
- resumes where they left off;
- the CTA, application block and rest of the page unlock at `ctaRevealAt` (returning visitors see them immediately);
- a sticky mobile CTA;
- FAQ;
- guarantee;
- testimonials hidden until real ones exist;
- WhatsApp button;
- legal footer.

**`/apply`** (`apply.js`):
- one question per screen, keyboard shortcuts, progress bar;
- contact first with the unticked AI-call consent box and its disclosure;
- saves each answer server-side as they go;
- inline errors (a 409 shows the "we emailed you a link" message);
- an "analysing…" step, then redirect to the tier route.

**`/book`** (`book.js`):
- Calendly iframe with prefill and `salesforce_uuid`;
- postMessage accepted only from `(^|.)calendly.com`;
- `hide_gdpr_banner` only when consent isn't required;
- on scheduled → POST `/api/booking/client`, then go to `/breakout`.

**`/breakout`:**
- VSL #2, objection FAQs, book CTA, WhatsApp;
- when booked, it switches to the pre-call version: call time, join link, prep checklist, pre-call video.

**`/resources`:** the C-tier starter kit.

**`/privacy`:**
- accurate: lists every processor and its country (Cloudflare, Resend, Calendly, Anthropic, ElevenLabs/Twilio, Vapi, PostHog, Meta, Google, Slack/Discord);
- covers AI calls, AI-written emails, profiling, retention (13 months for usage data), rights and the complaints route;
- mark it for lawyer review.

**`f.js` tracker:**
- scroll, engaged time, clicks (never field values), CTA hover;
- field focus/time/corrections/paste/left-empty — **never values**;
- tab return, section dwell and re-visits, exit section, rage clicks, exit intent, FAQ opens;
- text select/copy **ignoring form fields and PII-like text**, capped at 120 characters;
- at most 150 events per page;
- consent banner with a privacy link, plus a persistent "Cookie settings" button.

## 5. Frontend: Funnel HQ (`/admin`, vanilla JS SPA: `admin.js` + `admin.css`, plus `funnel-map.js`)

**Layout:**
- left nav; title + subtitle per tab;
- a shared filter bar (date range Today/7d/30d/90d/All, channel, campaign, variant, device) that tabs can hide (`noFilters`);
- hash routing (`#leads`, `#lead=<id>`);
- light/dark theme tokens and an accessible chart palette;
- line/area charts with a crosshair tooltip, bar lists, KPI tiles.
- **Escape every interpolation** (`esc()`; attributes double-quoted). Email previews go in `<iframe sandbox>` with `srcdoc`.

**Tabs:**

1. **Overview:** KPI tiles (visitors, play rate, applications, booked, opt-in, pitch reached, revenue, WhatsApp), the full funnel from landing to won with step conversion, daily trends.
2. **Funnel map:**
   - **Canvas:** about 40 built-in boxes covering traffic → smart route → landers/main → VSL → application → score → A/B/C → booked → call → won/lost/no-show, plus every automation and the engine room. Each box is colour-coded by kind (traffic, page, decision, auto, people, data), shows a live stat, and is connected by SVG bezier arrows with rate labels (labels hidden above 100%).
   - **Navigation:** drag with 10 px snap (positions saved for everyone), pan, zoom, Fit, Reset layout.
   - **Side panel:** click a box to see how it works, its stat, comes-from / leads-to jump links, and "Open in Funnel HQ →".
   - **Editable:**
     - "+ Add step" creates your own box with title, subtitle, type, opens-tab and notes.
     - Drag the ● port onto another box to draw an arrow, or use "Connect to…" with a label.
     - Your own boxes and arrows can be deleted.
     - Built-in boxes can have their text edited and notes added, with a reset to default.
   - **Storage:** kv_state `map:layout` and `map:custom`, validated server-side (id patterns, size caps, length caps, kind allowlist).
3. **VSL:** retention curve with the pitch marker and the biggest drop-offs.
4. **Links & videos:** tracked links, click → booked → revenue.
5. **Traffic & ads:** 15 dimensions to revenue per visitor.
6. **Landing pages & tests:** the main A/B test with significance, plus 100 landers by industry and angle, preview links and ad URLs.
7. **On-page behaviour:** clicks, form friction, exits, re-reads, highlights.
8. **Application:** step drop-off, answer distributions, score histogram.
9. **Sales team:** calls, show rate, closes and cash by rep; a call log to record outcomes inline; a 30-day needs-an-outcome list.
10. **Insights:** everyone who booked, split by tier, with the A-tier unpacked; Calendly monthly.
11. **Team:** reps CRUD and the Slack/Discord test.
12. **Leads:** search, filters and CSV export (formula-injection safe). The drawer shows:
    - journey timeline;
    - a Pipeline card (status, tier override, closer, setter, deal value, cash, lost reason, notes);
    - a Deal card with every marker;
    - the payments ledger;
    - behaviour facts with a per-template email preview;
    - Calendly bookings;
    - AI call transcripts and recordings (served through an admin-only proxy).
13. **Emails:** sequences and steps, queue, behaviour triggers, deliverability, preview any template.
14. **Voice:** ElevenLabs guided setup, toggles (confirm, speed-to-lead, rebook), the call log.
15. **Tracking:** forwarding status and match quality.
16. **Live:** a 5-second activity stream.
17. **Integrations:** a card per integration with its keys (masked), connected state and test actions (send test email, Slack test, Calendly connect/sync/import/requalify).

## 6. Security and privacy (non-negotiable; add a `test/security.test.ts` regression test for each)

- Anything a stranger types (answers, names, UTMs, booking answers, beacon text, what callers say) is hostile. Escape it and defang it before it reaches email HTML, `innerHTML`, Slack/Discord or a voice prompt.
- An email address is not identity; a browser booking report is not a booking; caller ID is not identity.
- Webhooks fail closed: constant-time HMAC compare, replay windows, secrets in headers rather than query strings.
- Tracked-link destinations must match `^\/(?!\/)`.
- The PostHog `/ph` proxy allowlists methods, paths and the PostHog host, and strips `set-cookie`.
- **AI calls:** phone-country hours, country allowlist, caps, consent per number, disclosure plus opt-out plus callback number.
- **Admin:** lockout, same-origin writes, revocable sessions, no-store, CSP. Recommend Cloudflare Access with SSO on `/admin*`.
- **Privacy:**
  - consent countries;
  - no typed-text capture;
  - no plaintext PII to analytics or chat;
  - imported contacts never marketed;
  - retention purge;
  - postal address in emails;
  - a privacy policy that matches the code.

When you're done, run an **adversarial review**:

1. Spawn four reviewers: auth/secrets; webhooks/public API; privacy/compliance; XSS/injection.
2. Then spawn skeptic agents that try to disprove each finding and break the "verified OK" claims.
3. Fix only what survives, with tests.

## 7. Deploy and go live

- `wrangler d1 create` → database_id into `wrangler.jsonc`; apply migrations remotely; `wrangler secret put ADMIN_PASSWORD` and `SESSION_SECRET`; `npm run check && npm run deploy`.
- **Custom domain:**
  1. Add the zone to Cloudflare. Give me the **exact two nameservers** to set at my registrar.
  2. **Snapshot the existing DNS first and recreate every record**, because the import can come back empty.
  3. Attach `apply.<domain>` as a Worker Custom Domain.
- Set `PUBLIC_URL`, then point the Calendly, ElevenLabs and WhatsApp webhooks at the domain.
- **Email:**
  - one merged SPF record;
  - DKIM for each sender (Google: also click "Start authentication");
  - DMARC `p=none`, then tighten.
- **Smoke test live:** every page returns 200; admin works; a cross-site write returns 403; a full simulated journey from visit to won shows correctly in every tab.

**Definition of done:**
- `npm run check` is green, with tests for scoring, precall timing, sequences, templates (full and empty applications), landers, the bandit, Calendly qualification, voice rules and security.
- Playwright screenshots of every page and every admin tab, with no console errors.
- The live domain serves the funnel, and Funnel HQ shows real data.
