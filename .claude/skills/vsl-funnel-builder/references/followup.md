# Email engine and follow-up

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
