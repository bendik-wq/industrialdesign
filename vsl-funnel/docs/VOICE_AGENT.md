# Voice agent: inbound only

"Sam" is an AI voice assistant built on [Vapi](https://vapi.ai). It **answers** calls. It never places them.

| Where | How it starts |
|---|---|
| Phone | Someone dials your Vapi number. Vapi asks `/hooks/voice` which assistant to use; we look the caller up by number and personalise the call (name, tier, application answers). |
| Browser | An applicant on `/book` or `/breakout` presses **Start the call** next to the AI + recording disclosure. `/api/voice/start` checks they're an applicant, isn't opted out, and hasn't hit the daily limit, then returns signed per-lead overrides. |

What it does on a call: answers questions from the FAQ and offer, fills in missing application answers, emails the booking link (`send_booking_link`) and records opt-outs (`do_not_contact`).

After every call, `end-of-call-report` stores the transcript, recording, summary and structured answers in `voice_calls`. It also links them to the lead, or creates one for a new caller, and fills empty application answers. Then it fires `voice_call_completed` to PostHog and the CRM webhook, and posts a Slack alert.

Everything is visible in the dashboard: the **Voice** tab, and **AI calls** in the lead drawer.

## Setup (about 15 minutes)
1. Create a Vapi account. Copy the **private key** and **public key**. Restrict the public key to your domain.
2. Go to Dashboard → **Integrations** → Voice:
   1. Paste both keys.
   2. Set a long random **voice webhook secret**.
   3. Optionally set the model (`openai:gpt-4o` by default) and voice (`vapi:Elliot` by default).
3. Press **Create / update assistant**. This saves `VAPI_ASSISTANT_ID`. Press it again whenever you change the FAQs or the prompt in `src/config.ts`.
4. In Vapi, buy or import a phone number:
   1. Set its **Server URL** to `https://<your-domain>/hooks/voice`.
   2. Leave its assistant **empty**, so every call goes through our personalisation.
5. Put the number in **Inbound phone number**, and set **Show "talk now" browser calls** to `true`.
6. Run `npm run db:migrate:remote` to apply `0002_voice.sql`.

## Compliance (what's built in, and what's on you)
**Built in**
- **AI disclosure first.** The first sentence of every call says it's an AI and that the call is recorded. The prompt also makes it admit it's an AI whenever asked.
- **Recording consent.** The opening line asks "Is that okay with you?". If the caller declines, the assistant offers to email them instead and ends the call. Browser calls also show the written disclosure, and the click is logged as `voice_web_start` with the exact text and its version (`VOICE_AGENT.disclosureVersion`).
- **Opt-out.** Saying "don't contact me" sets `do_not_call_at` and `unsubscribed_at`, cancels queued emails and switches off browser calls for that lead.
- **No advice.** It gives no financial, legal, tax or lending advice, makes no promises about specific outcomes, and never asks for card, bank or ID details.
- **No outbound.** There is no code path that dials anyone.
- **Abuse limits.** Browser calls are applicants-only, capped at 3 a day, with a 15-minute maximum per call.

**On you**
- Have your privacy policy reviewed. It includes an "AI calls" section to start from.
- Check recording-consent rules wherever your callers are. Some Australian states and US states require all-party consent; the opening line is designed to get it.
- **Outbound AI calls would be a different project.**
  - In the US, the FCC treats AI voices as "artificial voice" under the TCPA, so you need prior express *written* consent.
  - In Australia, you need Do Not Call Register washing and the Telemarketing Industry Standard calling hours.
  - Also needed: per-number consent records, time-zone-aware calling windows and an instant opt-out.
  - Don't add outbound without legal sign-off.
- Retention: decide how long to keep recordings, and set it in Vapi.
