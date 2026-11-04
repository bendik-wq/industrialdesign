# Consent audit: calls, texts and WhatsApp

Rule: nobody gets an automated or AI call, a text or a WhatsApp message unless they gave consent for **that
channel**, for **the number on file now**, and haven't opted out. One gate enforces it
(`src/integrations/consent-gate.ts`); the send primitives refuse to run without its pass.

Markets: US (TCPA: prior express written consent for automated, AI or prerecorded marketing calls and texts;
consent can't be a condition of purchase; STOP honoured), Australia (Spam Act 2003: consent, sender
identified, working unsubscribe; Do Not Call Register Act and the Telemarketing and Research Calls Industry
Standard: calling hours, caller ID), and the UK, NZ, IE, SG and UAE numbers the app calls (`callingZones` in
`src/integrations/elevenlabs.ts`; any other country is blocked).

## 1. Opt-in surfaces (every form or route that creates or updates a lead with a phone)

| Surface | Route / code | What it asks now | Stored | Gaps found (before) | Fix |
|---|---|---|---|---|---|
| Application, step 1 | `/apply`, `public/assets/apply.js`, `saveContact` in `src/funnel/application.ts` | Mobile (required to apply) + two unticked boxes: calls, texts (c3 wording) | `consent_events` (call, sms, whatsapp) + `leads.call_consent_at/_text`, `sms_consent_at`, `wa_consent_at` | One box covered calls, texts and WhatsApp together; wording didn't name the sender, offers, "msg & data rates" or "not required to buy"; no IP, user agent, page or exact text stored | Two boxes; proof row per channel; unticking a box on a later visit withdraws that channel (`unticked` row) |
| Masterclass (auto webinar) registration | `public/webinar.html`, `public/assets/webinar.js`, `registerWebinar` in `src/webinar/webinar.ts` | Optional mobile + two unticked boxes (text filled by the server from `CONSENT_COPY`) | as above | Texts box and call box overlapped ("call or text"); a new lead's `sms_consent_at` was set with no proof | `captureConsent` after the duplicate check; wording from one constant |
| Masterclass thank-you "Get a text when it starts" | `public/webinar-registered.html`, `addPhone` in `src/webinar/room.ts` | Mobile + its own unticked texts box (required for this button only) | `consent_events` (sms, whatsapp), source `webinar-thanks` | Pressing the button set `sms_consent_at` AND `wa_consent_at`, and recorded consent even when the typed number differed from the lead's (the lead kept its old number, which then counted as consented) | Box required; different number refused; STOP sticks |
| Live webinar registration | `src/live/pages.ts`, `public/assets/live.js`, `registerLive` in `src/live/events.ts` | Optional mobile + two unticked boxes | `consent_events`, `live_webinar_regs.sms_ok` | Separate texts box said "Text me the room link and a reminder" only; consent set at insert with no proof | `captureConsent`; `sms_ok` set from the recorded consent |
| Live confirmation page "Remind me by text" | `src/live/lifecycle-pages.ts`, `public/assets/live-lifecycle.js`, `smsOptIn` in `src/live/lifecycle-db.ts` | Mobile (if none on file) + its own unticked texts box | `consent_events` (source `live-texts`), `lc_regs.sms_optin_at` | "By tapping, you agree" (button as consent, no box); number on file not shown | Box required; the last digits of the number on file are shown |
| Challenge registration | `src/challenge/pages.ts`, `public/assets/challenge.js`, `registerChallenge` in `src/challenge/payments.ts` | Optional mobile + two unticked boxes | `consent_events` | Texts box: "Text me a reminder before each session (optional)" with no STOP, no rates, no sender | Standard wording + proof |
| Room general admission join (live event rooms and other rooms) | `joinSheet` / `joinRoom` in `src/rooms/admission.ts` | Optional mobile + two unticked boxes | `consent_events` (source `room-join`) | For rooms that aren't a live event, the texts box was shown but never recorded; the call box reused the old wording | `captureConsent` for both boxes |
| Calendly direct bookings and history import | `importDirect` in `src/integrations/calendly.ts` | Nothing (Calendly's reminder number is stored as the phone) | `booking_source = 'calendly-direct'` | none (already never texted) | Gate blocks: "imported contact without consent" unless they later tick a box on one of our forms |
| Zapier / inbound hooks lead creation | `src/integrations/hooks-in.ts` | Phone from the third party | phone only | Third-party "consent" can't be proven | Never contacted: no consent rows, so the gate blocks |
| Inbound AI call (caller ID) | `src/integrations/voice.ts` `ensureLead`, `src/integrations/elevenlabs-inbound.ts` | Nothing: they called us | phone | none | Inbound is fine; no outbound unless they tick a box later |
| Funnel HQ lead edit | `PATCH /admin/api/leads/:id` | (no phone field) | – | – | Any phone change anywhere goes through `updateLead`, which voids consent for the old number |
| WhatsApp inbound chat | `handleInbound` in `src/integrations/whatsapp.ts` | They message us first | `whatsapp_connected_at`, `whatsapp_wa_id` | none | Counts as WhatsApp permission until they send STOP (they started the conversation) |
| STOP / START (SMS, WhatsApp, the AU opt-out link) | `handleReplyWords` in `src/integrations/sms.ts`, `/so/:p/:sig` | – | `sms_opt_out_at`, `do_not_call_at`, `unsubscribed_at` + `revoked` rows | No proof row of the withdrawal | `revoked` rows (stop-reply / stop-whatsapp); START records a texts-only `granted` row (source `start-reply`), calls stay off |
| "Don't call me" on an AI call | `optOut` in `src/integrations/voice.ts` | – | `do_not_call_at`, `sms_opt_out_at`, `unsubscribed_at` + `revoked` rows | No proof row | `revoked` rows (source `do-not-call:<via>`) |

## 2. Automated contact paths and the gate each one checks

Every path calls `canCall` / `canText` (consent for that channel and this number, no STOP, no do-not-call,
not an imported contact without consent, a country we contact). The primitives take the pass and send only
to the number on it (`passTo`), so a path can't skip the check or swap the number.

| Path | Code | Checked when queued | Checked when sent |
|---|---|---|---|
| AI calls: confirm, speed to lead, rebook | `queueCall`, `dialQueuedCall` → `dial` in `src/integrations/elevenlabs.ts` | `canCall(ai_call:<kind>)` | `canCall` again at dial time (row skipped with the reason) |
| Webinar, live and challenge AI calls (`w_*`) | `queueWebinarCall` in `src/integrations/webinar-calls.ts`, dialled by `dialQueuedCall` | `canCall(ai_call:w_<kind>)` | `canCall` at dial time |
| AI call retries | `retryOrFail` → new queued row | – | `canCall` at dial time |
| SMS / WhatsApp sequences (booked, no-show, abandoned, webinar, challenge, …) | `startSms`, `sendSmsRow` in `src/integrations/sms.ts` | `canText(sms:<trigger>)` (WhatsApp too when the sequence uses it) | `canText` again; SMS and WhatsApp each need their own consent |
| Live webinar reminder texts | `sendText` in `src/live/events.ts` | – | `canText(live_text:<k>)` |
| Team-approved follow-up texts (Sales → follow-ups) | `stillOk`, `sendText` in `src/sales/followups.ts` | draft time: `textBlock` | `canText(followup_text:<play>)` at send time |
| Link text after a webinar AI call | `sendLink` in `src/integrations/webinar-calls.ts` | – | `canText(call_link_text)` (a call consent alone no longer sends texts) |
| WhatsApp templates and free text | `sendWhatsAppText`, `sendWhatsAppTemplate` in `src/integrations/whatsapp.ts` | via the SMS sequences | WhatsApp pass from `canText(…, 'whatsapp')` |
| Owner test call (strategy agent) | `POST /admin/api/voice/elevenlabs/test-call` | – | `testPass`: logged; refused for a lead's number without call consent |
| Owner test call (webinar agent) | `POST /admin/api/webinar-calls/test` | – | `testPass`, same rule |
| Owner test text / WhatsApp | `POST /admin/api/sms/test`, `/admin/api/sms/test-step` | – | `testPass`, same rule (the old raw Twilio call in `/sms/test` is gone) |
| Replies to an inbound message (STOP confirmation, "C" confirmed) | `src/routes/hooks.ts` (Telnyx), `handleInbound` (WhatsApp) | – | `replyPass`: only these two files may use it |
| Instagram DMs | `src/dm/*` | – | Out of scope: not a phone channel, replies inside Meta's messaging window |

Calling and texting hours, per-number and daily caps, the 3-texts-a-day cap and the AU public-holiday rule
are unchanged and still apply after the gate.

## 3. Proof stored for each consent (`consent_events`, migration 0085)

`lead_id`, `channel` (call / sms / whatsapp), `action` (granted / revoked), `phone` (E.164, the number it
applies to), `source` (apply, webinar, webinar-thanks, live, live-texts, challenge, room-join, start-reply,
stop-reply, stop-whatsapp, do-not-call:…, phone-changed, unticked), `page_url`, `text_version`, `text` (the
exact wording shown), `ip_hash` (HMAC of the IP, never the IP), `user_agent`, `created_at`.
The `leads.*` consent timestamps stay in step so existing reports keep working. Nothing is backfilled.

Blocked attempts and the owner's test sends go to `contact_gate_log` (deduped per lead, channel, purpose
and reason per hour), shown in Funnel HQ → Errors & cron → Consent, and per lead in the lead drawer → Consent.

## 4. The rule (`consentBlock`)

1. No phone, or a country we don't contact: blocked.
2. Calls: `do_not_call_at` or `sms_opt_out_at` (STOP stops calls too): blocked.
3. Texts and WhatsApp: `sms_opt_out_at`: blocked.
4. WhatsApp: they messaged us after the last consent change: allowed.
5. Proof rows for that channel: the latest must be `granted` and for the lead's current number.
   A number change (any `updateLead` that sets a different phone) writes `revoked` rows (source
   `phone-changed`) and clears the `leads.*` timestamps first.
6. No proof rows (consents from before 0085): the `leads.*` timestamp counts, never for imported Calendly
   contacts, and only for what the old wording named: the application box (v1, v2) covered "my application
   and strategy call", so it never covers the webinar/live/challenge offer calls (`ai_call:w_*`) or offer
   follow-up texts; the old session text boxes covered that session's reminders only. The old call boxes
   said "call or text", so they still cover texts for the same purposes. The c3 call box covers calls only.

The sandbox (`src/admin/sandbox.ts`) runs the same `consentBlock` on the sample lead (`sandboxConsentRows`),
including the "number changed" case (`lead.numberChanged`).

## 5. Wording (c3-2026-11, `CONSENT_COPY`)

- Calls: "Calls: G&L M&A Advisory (Josh Li’s team) may call me at this number about my registration,
  application or strategy call and Josh’s offers, including automated and AI-voice calls, which are recorded.
  Consent isn’t required to register or buy. Say stop on any call to opt out."
- Texts: "Texts: G&L M&A Advisory (Josh Li’s team) may text me at this number by SMS or WhatsApp about my
  registration, application or strategy call and Josh’s offers, including automated texts. Consent isn’t
  required to register or buy. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out."
- Above the boxes: "Calls and texts (optional, tick either, both or neither)".

Both boxes are unticked by default and optional on every form. Consent is never a condition of registering,
applying or buying: TCPA forbids conditioning, and the Spam Act treats bundled consent as invalid.

## 6. Owner decisions

- **Mandatory consent: not done.** Making a box required to register, apply or buy would make the consent
  invalid where it matters most (TCPA: consent can't be a condition of purchase; Spam Act: bundled or forced
  consent isn't consent) and every call or text sent on it would be unconsented. The boxes are prominent,
  explained and placed under the mobile field instead. The only required boxes are on the two "text me"
  buttons whose sole purpose is texts.
- **Phone verification / double opt-in.** Anyone can type someone else's number. A one-time code (or a
  "reply YES" confirmation text) would prove the number's owner agreed. Not built; recommended before scaling
  paid traffic to the US.
- **Legacy consents.** Consents from before this change have a time and a wording version but no number
  binding, IP, user agent, page or exact text. They still count for what their wording named (section 4.6).
  To require full proof for everyone, set those leads' consent timestamps to null (they then need to tick a
  box again); measured on the local database: see the report.
- **National Do Not Call registers (US DNC, AU DNCR, UK TPS).** Express consent exempts the call, so the gate
  doesn't wash numbers against the registers. If calls ever go to people without consent, register washing is
  required first.
- **Wording for legal review**, like the guarantee text.
