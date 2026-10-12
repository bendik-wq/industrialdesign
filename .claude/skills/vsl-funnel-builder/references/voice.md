# AI voice (ElevenLabs Conversational AI + Twilio number)

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
