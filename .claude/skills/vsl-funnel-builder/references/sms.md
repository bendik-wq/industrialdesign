# SMS follow-up (Twilio) + drag-and-drop sequence builder

## Data
- `sms_messages`: one row per text (`direction` in/out, `sequence`, `step`, `template`, `to_phone`, `from_phone`, `body`, `link_target`, `send_at`, `status`, `attempts`, `sent_at`, `clicked_at`, `provider_id`, `error`). Unique `(lead_id, sequence, step) WHERE direction='out'` is the dedupe key.
- `leads.sms_opt_out_at` (STOP), `leads.sms_confirmed_at` (replied C), `leads.sms_consent_at` (texts-only consent, e.g. webinar sign-up).
- Sequences live in `kv_state['sms:sequences']` as JSON, merged over `DEFAULT_SMS_SEQUENCES` (`src/integrations/sms-defaults.ts`).

## Sequence model
`{ id: trigger, enabled, next, steps: [{ n, body, anchor: trigger|call|webinar, offsetMin, link, skip[] }] }`
- `n` is stable and never reused (`next` hands out new ones). Reset-to-default renumbers from `next`, so earlier sends never collide.
- Order on screen is cosmetic; send time comes from anchor + offset.
- Triggers: booked, no_show, abandoned, qualified, cancelled, showed, lost, won, webinar. `startSms(rt, lead, trigger)` / `stopSms(rt, leadId, triggers?)` wired at the same points as the email sequences.
- Links: none, join, reschedule, book, apply, breakout, webinar_room, webinar_replay. They become `/s/:id` short links (target stored server-side, click recorded). If a link is chosen and `{link}` is absent, it's appended.
- Skip: applied, booked, confirmed, attended, missed, clicked. They're checked at send time.
- Merge tags: `{first_name}` (via `safeFirstName`, falling back to "there"), `{call_time}`, `{closer}`, `{link}`, `{webinar_time}`, `{site_name}`.

## Rules (enforced in `smsBlock` / `processSmsQueue`)
- Text only with consent (`call_consent_at` or `sms_consent_at`), never after STOP, never imported/calendly-direct contacts, only countries in `ZONES`.
- 8am–8pm in **every** zone of the number's country; otherwise defer to the next window. Max 3 texts per lead per day.
- The first text a lead ever gets ends "Reply STOP to opt out."
- Curly quotes are converted to straight ones (they'd force UCS-2 and triple the segment count). The builder shows chars and segments live; defaults stay ≤ 3 segments (tested).

## Inbound
`POST /hooks/twilio/sms`: verify `X-Twilio-Signature` (HMAC-SHA1 of URL plus sorted params, constant time); fail closed (501) without an auth token. STOP/UNSUBSCRIBE etc. set opt-out and cancel pending; START clears it; C/YES/CONFIRM sets `sms_confirmed_at` and replies via TwiML; anything else pings Slack (through `plain()`).

## Admin
- SMS tab: a setup checklist (Twilio status, the webhook URL to paste, consent counts, test text), a sequence list, and an editor with draggable step cards. There's also a "＋ New text" chip you can drag into place, timing as number + unit + before/after, a link select, merge-tag chips, a live preview with a segment counter, skip checkboxes, duplicate/delete, "Send me this one", an on/off toggle, reset, and save.
- API: `GET/PUT /admin/api/sms/sequences` (PUT runs `cleanSequences`: known ids only, unique `n`, non-empty body ≤ 480, valid enums), `POST /admin/api/sms/test-step`, `POST /admin/api/sms/test`.
- Settings group SMS: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (secret), `SMS_FROM` (number, alphanumeric sender or `MG…` Messaging Service), `SMS_ENABLED`. Without keys texts are simulated.

## Gotchas
- An Australian alphanumeric sender can't receive replies (no STOP/C). Use a number or a Messaging Service with a number in the pool if you want two-way.
- US numbers need A2P 10DLC registration before carriers deliver.
- Playwright drag tests: the drop target must be inside the viewport.
