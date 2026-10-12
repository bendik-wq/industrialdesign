---
name: vsl-funnel-builder
description: Build a complete high-ticket VSL sales funnel + "Funnel HQ" CRM/analytics dashboard on Cloudflare Workers + D1 — landing VSL with A/B headlines, 100 industry landers with a Thompson-sampling bandit and Meta smart route, multi-step application with lead scoring and A/B/C routing, Calendly booking (webhook + API sync + history import), email sequences (abandoned, tier, pre-call barrage, no-show, post-call, cancelled, lost, won onboarding, 6-month nurture) written from each lead's application answers and on-page behaviour (optionally rewritten by Claude), behaviour-triggered emails, ElevenLabs AI phone calls (confirm, speed-to-lead, no-show rebook, inbound callback) with consent and calling hours, first-party server-side tracking forwarded to Meta CAPI/GA4/PostHog, sales team and deal tracking, Slack/Discord pings, and a drag-and-drop editable funnel map. Use when someone wants to build, rebuild, clone or extend a VSL / application / book-a-call funnel, a Funnel HQ dashboard, or any of those parts for a coaching, consulting, advisory or other high-ticket offer.
---

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
- **Integrations available**: see `references/integrations.md`. Every integration is optional, and the funnel runs and simulates without any of them.

**Secrets rule:** never ask the user to paste API keys into chat. Build the **Integrations** screen in Funnel HQ, where keys go into D1. Env vars override them and show as locked. If a user pastes a key anyway, use it once, never commit it, and recommend rotating it.

## Build phases

| # | Phase | Read first | Done when |
|---|---|---|---|
| 1 | Skeleton: Worker, D1, settings, admin auth, security headers, cron | `references/architecture.md`, `references/data-model.md` | `/health` returns OK; `/admin` is behind a password; cron runs |
| 2 | First-party tracking: identity cookies, sessions, attribution, events, VSL heartbeats, deep on-page tracking, forwarding to Meta/GA4/PostHog | `references/tracking.md` | A simulated visitor shows a full journey in the event log |
| 3 | Pages: landing VSL + headline A/B test, apply, book, breakout, resources, privacy | `references/pages-and-copy.md` | Every page renders server-side via HTMLRewriter; CTA unlocks at the pitch timestamp |
| 4 | Application, scoring, routing | `references/application-scoring.md` | Contact details at step 1 create the lead; scoring + hard caps → tier → route; weighted round-robin closers |
| 5 | Booking: Calendly embed + signed webhook + API sync + history import + qualification from booking answers | `references/calendly.md` | Booking, reschedule, cancel and no-show all reach the lead record |
| 6 | Email engine + all sequences + pre-call barrage | `references/followup.md` | Queue, claim, send (or simulate) on cron; tracked links; unsubscribe; every sequence stops when its goal is met |
| 7 | Application reader (dossier) + application-specific follow-up | `references/followup.md` §Dossier | Pre-call, no-show, post-call, cancelled, lost, won and nurture emails quote each lead's own answers |
| 8 | Behaviour profile, behaviour-triggered emails, Claude personalisation | `references/personalisation.md` | Each email adds one fact earlier emails didn't use; nothing creepy is said back |
| 9 | AI voice: ElevenLabs outbound (confirm / speed-to-lead / rebook) + inbound callback agent | `references/voice.md` | Consent-gated; calling hours in the lead's time zone; DNC honoured; webhooks signed |
| 10 | Sales team: reps, outcomes, deal markers, payments, Slack/Discord pings, daily digest | `references/sales-and-hq.md` | Logging an outcome triggers the right sequences and pings; historical imports never email anyone |
| 11 | Industry landers (20 × 5) + Meta smart route + bandit | `references/landers.md` | `/m?ind=` or the ad name routes to the right industry; the bandit shifts traffic after a 60-visitor floor |
| 12 | Funnel HQ dashboard: all tabs + the editable funnel map | `references/sales-and-hq.md` | Every number traces back to events; the map supports drag, connect, add/edit/delete, saved for everyone |
| 13 | Domain, DNS and deliverability: custom domain, SPF/DKIM/DMARC, webhook URLs switched | `references/deploy-and-domain.md` | Mail passes SPF and DKIM; webhooks point at the custom domain |
| 14 | Security and privacy pass, then an adversarial review: specialist reviewers (auth, webhooks/API, privacy, XSS), then skeptic agents that try to disprove each finding | `references/security-checklist.md` | Every checklist item is in the code and has a regression test |

The build order matters. For example, tracking (2) has to exist before personalisation (8), and the email engine (6) before the dossier (7).

## Non-negotiables

1. **Server-side truth.** Write page views server-side before the HTML is sent. Write conversions from the server. Client scripts only add what only the browser knows.
2. **Never record what people type.** Field tracking records focus, time, corrections, paste and empty fields, but never values. Selected or copied text is capped and treated as a background signal, never quoted back to the lead.
3. **Consent before calls.** AI calls go only to leads who ticked an **unticked-by-default** consent box. Consent is per number, with its text and timestamp stored. Disclose the AI, the recording, "say stop" and a callback number up front. Call only during local calling hours across every time zone of the **phone number's** country, never on Sundays or public holidays, and only to verified bookings. Cap calls per number and per day. Check do-not-call before every dial, including retries. Never call imported or historical contacts.
4. **Every email** has one-click unsubscribe (RFC 8058) and a physical address. Unsubscribe stops every sequence.
5. **Historical imports are read-only.** Imported Calendly bookings and calls more than 14 days old must never trigger emails, pings, calls or ad-platform conversions (the `isHistorical` guard and `localOnly` tracking).
6. **Sequences are append-only.** The step index is the dedupe key `(lead_id, sequence, step)`. Append new steps; never reorder or insert in the middle.
7. **Copy honesty.** No fabricated testimonials, results, clients or case studies. Label illustrative numbers as illustrative. No false urgency. Respect the user's banned words.
8. **Treat every stranger-typed value as hostile.** Escape it and strip links from it before it reaches email HTML, `innerHTML`, Slack/Discord or a voice prompt. An email address is not proof of identity, and a browser booking report is not proof of a booking. Read `references/security-checklist.md` before building phases 4–9.
9. **Webhooks fail closed.** If the signing secret isn't set, reject the request. Compare signatures in constant time, and use a replay window where the provider sends a timestamp.
10. **Test before deploy.** Run `npm run check` (typecheck plus vitest), drive the real endpoints locally (`wrangler dev`, plus Playwright for UI), then deploy.

## Working method

- Keep all marketer-editable content in `src/config.ts`: copy, questions, points, thresholds, closers and prompts. Email copy goes in template files; timing goes in `sequences.ts`.
- Settings resolve **env var → D1 `settings` row → unset**, with a ~15 s cache. The Integrations tab writes the D1 rows.
- Every cron job is wrapped so one failure can't stop the others. They include: email queue, retry forwards, upcoming-call pings, digest, call queue, inbound sync, Calendly sync (hourly) and triggers.
- Without provider keys everything **simulates**: emails are marked `simulated` and calls aren't placed. That lets the whole flow be tested end to end.
- After each phase: typecheck, unit tests, a local run, Playwright screenshots of any UI, then deploy and commit.
- Read `references/gotchas.md` before starting. It lists every bug the original build hit.

## Reference implementation

The original source lives in the GitHub repo `bendik-wq/industrialdesign`, folder `vsl-funnel/`, branch `claude/ecstatic-hopper-yhy3mk`. If the current session can read that repo, copy and adapt it rather than rewriting from scratch. Swap out the offer, brand, copy, questions and team in `src/config.ts` and the templates. If it can't, the reference files here are enough to rebuild it.
