# Calendly (booking)

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
