# Integrations (all optional; connected in Funnel HQ → Integrations)

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
