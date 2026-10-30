import type { Env } from './env';

/**
 * Every integration key/URL the funnel reads. A value set as a Worker var or
 * secret always wins; otherwise the value connected from the dashboard's
 * Integrations tab (stored in D1 `settings`) is used. This is what lets a
 * non-technical operator paste a Resend key or WhatsApp number into the
 * dashboard and have the flows start working without a redeploy.
 */
export interface SettingDef {
  key: string;
  label: string;
  group: 'Site' | 'Video' | 'Booking' | 'Email' | 'WhatsApp' | 'Voice' | 'Analytics' | 'Ads' | 'Alerts' | 'Security' | 'Webinar' | 'SMS' | 'Data' | 'Content' | 'Search' | 'Contracts';
  secret?: boolean;
  placeholder?: string;
  help?: string;
}

export const SETTINGS = [
  { key: 'SITE_NAME', label: 'Brand name', group: 'Site', placeholder: 'G&L M&A Advisory' },
  { key: 'SITE_PALETTE', label: 'Colour palette', group: 'Site', placeholder: 'paper', help: 'paper (white, default) or ink (dark navy). Preview any page with ?palette=ink.' },
  { key: 'PUBLIC_URL', label: 'Public URL', group: 'Site', placeholder: 'https://apply.example.com', help: 'Used for links in emails and WhatsApp. Defaults to the request origin.' },

  { key: 'VSL_MAIN_SRC', label: 'Main VSL video (MP4 or HLS .m3u8)', group: 'Video', placeholder: 'https://customer-xxx.cloudflarestream.com/<uid>/manifest/video.m3u8', help: 'Cloudflare Stream HLS URLs work best.' },
  { key: 'VSL_MAIN_POSTER', label: 'Main VSL poster image', group: 'Video' },
  { key: 'VSL_BREAKOUT_SRC', label: 'Breakout VSL (part 2) video', group: 'Video' },
  { key: 'VSL_BREAKOUT_POSTER', label: 'Breakout VSL poster image', group: 'Video' },
  { key: 'VSL_PRECALL_SRC', label: 'Pre-call video (shown after booking)', group: 'Video', help: 'Falls back to the breakout video.' },

  { key: 'BOOKING_URL_A', label: 'A-tier calendar (closer)', group: 'Booking', placeholder: 'https://calendly.com/you/strategy-call' },
  { key: 'BOOKING_URL_B', label: 'B-tier calendar (setter)', group: 'Booking', placeholder: 'https://calendly.com/team/discovery-call' },
  { key: 'CALENDLY_API_TOKEN', label: 'Calendly personal access token', group: 'Booking', secret: true, help: 'calendly.com → Integrations → API & webhooks. Gives exact call times, meeting links and answers, and sets up the webhook for you.' },
  { key: 'CALENDLY_SIGNING_KEY', label: 'Calendly webhook signing key', group: 'Booking', secret: true, help: 'Confirms bookings server-side via /hooks/calendly.' },
  { key: 'BOOKING_WEBHOOK_SECRET', label: 'Generic booking webhook secret', group: 'Booking', secret: true, help: 'For Cal.com / GHL / Zapier: POST to /hooks/booking?secret=…' },

  { key: 'RESEND_API_KEY', label: 'Resend API key', group: 'Email', secret: true, placeholder: 're_…', help: 'Create at resend.com → API Keys. Verify your sending domain first.' },
  { key: 'EMAIL_FROM', label: 'From address', group: 'Email', placeholder: 'Josh Li <josh@mail.example.com>' },
  { key: 'RESEND_WEBHOOK_SECRET', label: 'Resend webhook signing secret', group: 'Email', secret: true, placeholder: 'whsec_…', help: 'Filled in by “Connect bounce blocking” on this page. Hard bounces and spam complaints then stop all email to that address.' },
  { key: 'EMAIL_REPLY_TO', label: 'Reply-to address', group: 'Email' },
  { key: 'EMAIL_SIGNATURE', label: 'Email signature name', group: 'Email', placeholder: 'Josh' },
  { key: 'PRECALL_EMAILS_PER_DAY', label: 'Pre-call emails: most in one day', group: 'Email', placeholder: '14', help: 'Booked leads get a run of pre-call emails, spread over 7am–9pm their time until 3 hours before the call, at least 45 minutes apart. This caps any one day. 0 turns the run off.' },
  { key: 'PRECALL_EMAILS_MIN', label: 'Pre-call emails: at least', group: 'Email', placeholder: '15', help: 'Even a call booked for tomorrow gets this many (when the time allows).' },
  { key: 'PRECALL_EMAILS_MAX', label: 'Pre-call emails: at most', group: 'Email', placeholder: '45', help: 'Calls booked further out get up to this many, spread thinner.' },
  { key: 'LONG_FLOW_EMAILS', label: 'Six-month flows: emails per person', group: 'Email', placeholder: '1000', help: 'Every follow-up flow (abandoned, tier A/B/C, no-show, cancelled, post-call, lost, nurture, reactivation) runs on for six months: about 10 a day in month 1, 6 a day in months 2–3, 3–4 a day after, 8am–8pm their time. A person is only ever in one. 0 turns the six-month part off (the original short flows still run).' },
  { key: 'LONG_FLOW_DAYS', label: 'Six-month flows: length in days', group: 'Email', placeholder: '182', help: 'How long the long flows run.' },
  { key: 'PREWEBINAR_EMAILS_PER_DAY', label: 'Pre-webinar emails: per day', group: 'Email', placeholder: '15', help: 'Webinar registrants get a run of emails until 3½ hours before their session (up to 14 days), spread evenly over 7am–9pm their time. Registering closer to the session means fewer, the most important first. 0 turns the run off.' },
  { key: 'EMAIL_PERSONALIZE', label: 'Personalise every email', group: 'Email', placeholder: 'ai', help: 'ai = Claude rewrites each email around what that person did on the site (needs the Anthropic key). rules = a personal opening line, no AI. off = templates as written.' },
  { key: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', group: 'Email', secret: true, placeholder: 'sk-ant-…', help: 'console.anthropic.com → API keys. Used only to personalise emails.' },
  { key: 'EMAIL_AI_MODEL', label: 'Email personalisation model', group: 'Email', placeholder: 'claude-opus-5-5', help: 'Leave blank for Claude Opus 5.5.' },
  { key: 'CONTRACT_COMPANY', label: 'Company (legal name)', group: 'Contracts', placeholder: 'G&L M&A Advisory LLC', help: 'The company that signs. Leave blank for “G&L M&A Advisory LLC”.' },
  { key: 'CONTRACT_ENTITY', label: 'Company type', group: 'Contracts', placeholder: 'a Wyoming limited liability company' },
  { key: 'CONTRACT_ADDRESS', label: 'Company address', group: 'Contracts', help: 'Shown under the company name. Defaults to the business postal address.' },
  { key: 'CONTRACT_SIGNER', label: 'Signs for the company', group: 'Contracts', placeholder: 'Josh Li, Co-Founder' },
  { key: 'CONTRACT_FROM', label: 'Contracts are sent from', group: 'Contracts', placeholder: 'Josh Li <josh@grosfjeld-li.com>', help: 'Defaults to the email From address. Must be on your verified sending domain.' },
  { key: 'CONTRACT_CURRENCY', label: 'Default currency', group: 'Contracts', placeholder: 'USD' },
  { key: 'CONTRACT_LAW', label: 'Governing law (state)', group: 'Contracts', placeholder: 'Wyoming' },
  { key: 'CONTRACT_VENUE', label: 'Courts', group: 'Contracts', placeholder: 'Sheridan County, Wyoming' },
  { key: 'CONTRACT_PAY_BANK', label: 'Payment: bank name', group: 'Contracts', placeholder: 'Mercury / Chase / …', help: 'Shown on the agreement under “How to pay”, after signing and in the signed-copy email. Leave the bank fields blank to leave payment details off.' },
  { key: 'CONTRACT_PAY_ACCOUNT_NAME', label: 'Payment: account name', group: 'Contracts', placeholder: 'G&L M&A Advisory LLC' },
  { key: 'CONTRACT_PAY_ROUTING', label: 'Payment: ACH / wire routing number', group: 'Contracts' },
  { key: 'CONTRACT_PAY_ACCOUNT', label: 'Payment: account number', group: 'Contracts' },
  { key: 'CONTRACT_PAY_SWIFT', label: 'Payment: SWIFT / BIC (international wires)', group: 'Contracts' },
  { key: 'CONTRACT_PAY_LINK', label: 'Payment: card / online payment link', group: 'Contracts', placeholder: 'https://buy.stripe.com/…', help: 'Optional. Shows a “Pay now” button after signing.' },
  { key: 'CONTRACT_EXTRA_TERMS', label: 'Extra terms (added to every agreement)', group: 'Contracts', help: 'Plain text. Each blank line starts a new paragraph. Have your attorney review the agreement before you send the first one.' },
  { key: 'CONTRACT_NOTIFY_EMAIL', label: 'Send signed copies to', group: 'Contracts', placeholder: 'josh@grosfjeld-li.com', help: 'Defaults to the reply-to address.' },
  { key: 'BUSINESS_ADDRESS', label: 'Business postal address', group: 'Email', help: 'Shown in the email footer (required by anti-spam law).' },

  { key: 'JOSH_WHATSAPP', label: "Josh's WhatsApp number", group: 'WhatsApp', placeholder: '61400000000', help: 'International format, digits only. Powers every "Message Josh" button.' },
  { key: 'WHATSAPP_TOKEN', label: 'WhatsApp Cloud API token', group: 'WhatsApp', secret: true, help: 'Optional: sends the resources template automatically and links inbound chats to leads.' },
  { key: 'WHATSAPP_PHONE_NUMBER_ID', label: 'WhatsApp phone number ID', group: 'WhatsApp' },
  { key: 'WHATSAPP_RESOURCES_TEMPLATE', label: 'Resources template name', group: 'WhatsApp', placeholder: 'free_resources' },
  { key: 'WHATSAPP_VERIFY_TOKEN', label: 'Webhook verify token', group: 'WhatsApp', secret: true },
  { key: 'WHATSAPP_TEMPLATE_LANG', label: 'Template language code', group: 'WhatsApp', placeholder: 'en', help: 'The language your follow-up templates were approved in (en, en_US, en_GB…).' },
  { key: 'WHATSAPP_APP_SECRET', label: 'Meta app secret (webhook signatures)', group: 'WhatsApp', secret: true },

  { key: 'VAPI_API_KEY', label: 'Vapi private API key', group: 'Voice', secret: true, help: 'vapi.ai → API Keys. Used to create/update the assistant from this dashboard.' },
  { key: 'VAPI_PUBLIC_KEY', label: 'Vapi public key', group: 'Voice', help: 'Lets applicants talk to the assistant in their browser. Restrict it to your domain in Vapi.' },
  { key: 'VAPI_ASSISTANT_ID', label: 'Vapi assistant ID', group: 'Voice', help: 'Filled in automatically when you press “Create / update assistant”.' },
  { key: 'VOICE_WEBHOOK_SECRET', label: 'Voice webhook secret', group: 'Voice', secret: true, help: 'Any long random string. Vapi sends it as x-vapi-secret on every webhook.' },
  { key: 'VOICE_PHONE_NUMBER', label: 'Inbound phone number', group: 'Voice', placeholder: '+61 2 0000 0000', help: 'Your Vapi number. Shown as “call us” on /book and /breakout. Point its Server URL at /hooks/voice.' },
  { key: 'VOICE_MODEL', label: 'Assistant LLM (provider:model)', group: 'Voice', placeholder: 'openai:gpt-4o' },
  { key: 'VOICE_VOICE', label: 'Assistant voice (provider:voiceId)', group: 'Voice', placeholder: 'vapi:Elliot' },
  { key: 'VOICE_WEB_ENABLED', label: 'Show “talk now” browser calls', group: 'Voice', placeholder: 'true' },

  { key: 'ELEVENLABS_API_KEY', label: 'ElevenLabs API key', group: 'Voice', secret: true, placeholder: 'sk_…', help: 'elevenlabs.io → Developers → API keys. Needs ElevenAgents (Conversational AI) write access. Powers the outbound confirmation calls.' },
  { key: 'ELEVENLABS_AGENT_ID', label: 'ElevenLabs agent ID', group: 'Voice', help: 'Filled in automatically when you press “Create / update agent in ElevenLabs” on the Voice tab.' },
  { key: 'ELEVENLABS_INBOUND_AGENT_ID', label: 'ElevenLabs callback agent ID', group: 'Voice', help: 'Answers people who ring the number back. Filled in automatically by “Create / update agents”.' },
  { key: 'ELEVENLABS_PHONE_NUMBER_ID', label: 'ElevenLabs phone number ID', group: 'Voice', help: 'The Twilio/SIP number you imported in ElevenLabs → Phone numbers. Picked automatically if you only have one.' },
  { key: 'ELEVENLABS_VOICE_ID', label: 'ElevenLabs voice ID', group: 'Voice', help: 'Optional. Leave blank for the default voice.' },
  { key: 'ELEVENLABS_LLM', label: 'ElevenLabs agent LLM', group: 'Voice', help: 'Optional, e.g. claude-sonnet-4 or gpt-4o. Leave blank for the ElevenLabs default.' },
  { key: 'ELEVENLABS_WEBHOOK_SECRET', label: 'ElevenLabs post-call webhook secret', group: 'Voice', secret: true, help: 'Optional (results are also fetched automatically). ElevenLabs → Agents settings → Post-call webhook → URL /hooks/elevenlabs.' },
  { key: 'AI_CALL_CONFIRM', label: 'AI call to confirm new bookings', group: 'Voice', placeholder: 'true', help: 'Calls consenting leads ~2 minutes after they book. Set to false to turn off.' },
  { key: 'AI_CALL_SPEED_TO_LEAD', label: 'AI call qualified leads who haven’t booked', group: 'Voice', placeholder: 'true', help: 'Calls consenting A/B leads ~5 minutes after applying if they haven’t booked, and emails the booking link. Set to false to turn off.' },
  { key: 'AI_CALL_REBOOK', label: 'AI call no-shows to rebook', group: 'Voice', placeholder: 'true', help: 'Calls consenting leads ~20 minutes after a no-show is logged and emails a link to pick a new time. Set to false to turn off.' },
  { key: 'TWILIO_ACCOUNT_SID', label: 'Twilio Account SID', group: 'SMS', placeholder: 'AC…', help: 'console.twilio.com → Account info. Text messages go out through Twilio.' },
  { key: 'TWILIO_AUTH_TOKEN', label: 'Twilio Auth Token', group: 'SMS', secret: true, help: 'console.twilio.com → Account info. Also used to check that replies really come from Twilio.' },
  { key: 'SMS_FROM', label: 'Send texts from', group: 'SMS', placeholder: '+12294046271 or MG… (Messaging Service SID)', help: 'A Twilio number, or a Messaging Service SID (best: lets Twilio pick an Australian sender for AU numbers). US numbers need A2P 10DLC registration in Twilio.' },
  { key: 'SMS_ENABLED', label: 'Send SMS follow-up', group: 'SMS', placeholder: 'true', help: 'Texts only go to people who ticked “call or text me”, 8am–8pm their time, max 3 a day. Set to false to pause.' },
  { key: 'WEBINAR_URL', label: 'Webinar address', group: 'Webinar', placeholder: 'https://live.grosfjeld-li.com', help: 'The domain the webinar pages live on. Links in webinar emails use it.' },
  { key: 'WEBINAR_JIT_EVERY', label: 'Just-in-time showings every (minutes)', group: 'Webinar', placeholder: '15', help: 'A showing starts every this many minutes, so nobody waits more than that. 0 turns it off (scheduled sessions only).' },
  { key: 'WEBINAR_JIT_HOURS', label: 'Just-in-time hours (viewer’s local time)', group: 'Webinar', placeholder: '7-22', help: 'Showings are offered between these hours in the viewer’s own time zone, e.g. 7-22.' },
  { key: 'WEBINAR_AI_MODEL', label: 'Masterclass Q&A model', group: 'Webinar', placeholder: 'claude-haiku-5-5', help: 'The AI assistant that answers questions typed in the room (needs the Anthropic API key under Email). Blank uses a fast model.' },
  { key: 'WEBINAR_SELF_SERVE', label: 'Self-serve agreement in the room', group: 'Webinar', placeholder: 'off', help: 'on = $1M+ viewers can start straight from the masterclass: the agreement is quoted from their revenue, signed for the company in Josh’s name, e-signed by them, then card payment (needs the payment link under Contracts). off = book a call only.' },
  { key: 'WEBINAR_CHAPTERS', label: 'Masterclass chapters', group: 'Webinar', placeholder: '0 Why buy; 7 Where the deals are; …', help: 'Minute and title per chapter, separated by semicolons. Shown as the agenda in the room. Blank uses the built-in outline.' },
  { key: 'WEBINAR_BONUS_AT', label: 'Worksheet unlocks at (minute)', group: 'Webinar', placeholder: '63', help: 'Minute of the masterclass when the attendee-only Deal Structure Worksheet appears.' },
  { key: 'WEBINAR_HEADLINE_TEST', label: 'Webinar headline test', group: 'Webinar', placeholder: 'auto', help: 'auto = traffic shifts to the headline that brings the most $1M+ sign-ups; even = equal split; or a headline id to show it to everyone. Set from Funnel HQ → Webinar.' },
  { key: 'WEBINAR_TITLE', label: 'Webinar title', group: 'Webinar', placeholder: 'The Acquisition Masterclass', help: 'Shown on the registration page, the room and the emails.' },
  { key: 'WEBINAR_SCHEDULE', label: 'Weekly sessions', group: 'Webinar', placeholder: 'Tue 19:00, Thu 12:00', help: 'Recurring session times in the sales time zone (days: Mon–Sun, 24h clock). Sessions are created two weeks ahead. Add one-off or live sessions on the Webinar tab.' },
  { key: 'WEBINAR_VIDEO_SRC', label: 'Webinar recording (MP4 / HLS URL)', group: 'Webinar', placeholder: 'https://…/webinar.mp4', help: 'Played in sync in the webinar room for scheduled (recorded) sessions, and as the replay. Until it’s set, the main VSL is used as a placeholder.' },
  { key: 'WEBINAR_STREAM_HLS', label: 'Live stream playback URL (Cloudflare Stream)', group: 'Webinar', placeholder: 'https://customer-xxxx.cloudflarestream.com/<live input id>/manifest/video.m3u8', help: 'For “Live in our room” sessions. Cloudflare dashboard → Stream → Live inputs → your input → HLS playback URL. Stream into it from OBS, StreamYard or Zoom (Live on custom streaming service) using the RTMPS URL + key shown there.' },
  { key: 'WEBINAR_EDITION', label: 'Which masterclass plays', group: 'Webinar', placeholder: 'recorded', help: 'recorded = Josh’s own recording (script v3, 66 minutes, the Sprint unlocks at 38:00; set the recording link below). ai = the AI edition, presented in an AI version of Josh’s voice (disclosed at the start and on every slide), about 25 minutes, pitching the First Deal Sprint from the first minute. Its chapters, polls, key points, calculator, buy-in and unlock are timed from its own audio. The length, offer and worksheet minutes below override it when set.' },
  { key: 'WEBINAR_DURATION_MIN', label: 'Webinar length (minutes)', group: 'Webinar', placeholder: '66', help: 'When the session counts as finished and the replay opens.' },
  { key: 'WEBINAR_PITCH_AT', label: 'Offer appears at (minutes in)', group: 'Webinar', placeholder: '38', help: 'The pitch minute: the First Deal Sprint unlocks in the room at this point of the recording (live and replay alike), and checkout only works for viewers who reached it.' },
  { key: 'WEBINAR_REPLAY_HOURS', label: 'Replay available for (hours)', group: 'Webinar', placeholder: '48', help: 'After this the replay link shows the next session instead. The emails say the same number.' },
  { key: 'WEBINAR_CHAT', label: 'Showing chat in the room', group: 'Webinar', placeholder: 'on', help: 'on = viewers in the same showing can chat with each other (real people only; links, emails and phone numbers are removed). off = no chat. The team can reply, pin and delete from the host console on the Webinar tab.' },
  { key: 'WEBINAR_HOST_NAMES', label: 'Team names for the room', group: 'Webinar', placeholder: 'G&L team, Josh', help: 'Names the team can post under in the showing chat and announcements, comma separated (up to 5). The first is the default. Only post as Josh when Josh is typing.' },
  { key: 'WEBINAR_PASS', label: 'Paid offer in the masterclass', group: 'Webinar', placeholder: 'off', help: 'off = nothing to buy. upsell = the masterclass is open to everyone; the offer (First Deal Sprint by default) unlocks in the room at the pitch minute for $1M+ viewers, one click next to the strategy call, until their replay closes. required + a ticket price below = a paid ticket to watch at all: the landing page sells a “Masterclass ticket” at that price (with the 7-day ticket guarantee and the credit toward the First Deal Sprint), registration goes straight to Stripe Checkout, and the room, the confirmation, the reminders, the pre-webinar emails and texts only start once the ticket is paid (unpaid registrants get three short “finish your ticket” emails instead). The Sprint then unlocks in the room the same way. Needs the Stripe secret key; without it nothing is sold and registration stays open.' },
  { key: 'WEBINAR_OFFER_NAME', label: 'Offer name', group: 'Webinar', placeholder: 'First Deal Sprint', help: 'The front-end product sold in the masterclass. It unlocks in the room at the pitch minute and is shown there, on its offer page, on Stripe, in the closing emails and in Funnel HQ.' },
  { key: 'WEBINAR_PASS_PRICE', label: 'Offer price', group: 'Webinar', placeholder: '3000', help: 'In the currency below. The full fee is credited against the advisory engagement if they continue.' },
  { key: 'WEBINAR_PASS_CURRENCY', label: 'Offer currency', group: 'Webinar', placeholder: 'USD' },
  { key: 'WEBINAR_OFFER_PERKS', label: 'What the offer includes', group: 'Webinar', help: 'One per line, “Title: one-sentence detail”, optionally led by the day (“Day 3: Your buy box: the business to buy first”). {price} and {replay_days} are filled in. Blank = the built-in 7-day Sprint (kickoff and numbers, acquisition capacity, buy box, a first shortlist, deal-structure memo, outreach script, Day 7 Deal Plan session, fee credited, guarantee). Only list what you deliver, and never promise results.' },
  { key: 'WEBINAR_OFFER_SESSION_URL', label: 'Deal Plan session booking link', group: 'Webinar', placeholder: 'https://calendly.com/team/deal-plan', help: 'Where buyers book their 60-minute Deal Plan session. Blank = the confirmation says Josh’s team will email them to book it.' },
  { key: 'WEBINAR_PASS_REPLAY_DAYS', label: 'Offer: replay kept for (days)', group: 'Webinar', placeholder: '30', help: 'Buyers keep the replay this long instead of the usual replay hours.' },
  { key: 'WEBINAR_PASS_REFUND', label: 'Offer: guarantee', group: 'Webinar', placeholder: 'Do the Sprint. If at the end of your Deal Plan session you don’t think it was worth far more than you paid, tell us that day and we refund the full fee.', help: 'Shown with the price, on the offer page and in the closing emails. A promise about the refund, never about results. Honour it: refund in Stripe and the purchase is withdrawn automatically (a payment plan stops too).' },
  { key: 'WEBINAR_PASS_PLAN', label: 'Offer: payment plan (optional)', group: 'Webinar', placeholder: '2x1550', help: 'Payments x amount, monthly, e.g. 2x1550 = “2 payments of $1,550”. Blank = one payment only. Runs as a Stripe subscription that stops itself after the last payment (needs the invoice.paid webhook event). The ticket credit comes off the first payment.' },
  { key: 'WEBINAR_FAST_BONUS', label: 'Offer: fast-action bonus', group: 'Webinar', placeholder: 'Josh reviews your Deal Plan personally: before your Day 7 session, Josh reads your deal-structure memo and adds his notes', help: '“Title: detail”. Offered for 24 hours after the Sprint unlocks for that viewer (or until their replay closes, if sooner), with a real countdown. Buyers inside the window are marked on their purchase. Blank = the default above; “off” = no bonus. Only offer what you will deliver.' },
  { key: 'WEBINAR_PASS_WEEKLY_CAP', label: 'Offer: most sold per week (optional)', group: 'Webinar', placeholder: '10', help: 'Blank = no cap. When set, no more than this many are sold per week (Monday to Sunday, sales time zone) and pages show the true number left. Nothing is ever shown as sold out unless this cap is genuinely reached.' },
  { key: 'WEBINAR_SEAT_PRICE', label: 'Ticket price (required mode only)', group: 'Webinar', placeholder: '100', help: 'The Masterclass ticket. Blank = watching is free. With the paid offer setting on “required”, this is the price of a ticket to watch at all (for example 100): registrants pay it at Stripe Checkout right after signing up, and the room opens once it is paid. A full refund in Stripe closes the room again. Each paid ticket is credited toward the First Deal Sprint. Same currency as the offer.' },
  { key: 'STRIPE_SECRET_KEY', label: 'Stripe secret key', group: 'Webinar', secret: true, placeholder: 'sk_live_… or rk_live_…', help: 'dashboard.stripe.com → Developers → API keys. A restricted key with write access to Checkout Sessions and read access to Charges is enough.' },
  { key: 'STRIPE_WEBHOOK_SECRET', label: 'Stripe webhook signing secret', group: 'Webinar', secret: true, placeholder: 'whsec_…', help: 'Stripe → Developers → Webhooks → Add endpoint: <your apply domain>/hooks/stripe, events checkout.session.completed, checkout.session.async_payment_succeeded, checkout.session.expired, charge.refunded, invoice.paid (payment plans). Paste the endpoint’s signing secret here.' },
  { key: 'DEAL_SPRINT_KICKOFF_URL', label: 'First Deal Sprint: kickoff call booking link', group: 'Webinar', placeholder: 'https://calendly.com/team/sprint-kickoff', help: 'Where Sprint buyers book their Day 1 kickoff call (on their Sprint page and in the welcome email). Blank = they are told Josh’s team emails them to set it.' },
  { key: 'DEAL_SPRINT_PLAN_URL', label: 'First Deal Sprint: Deal Plan session booking link', group: 'Webinar', placeholder: 'https://calendly.com/team/deal-plan', help: 'Where Sprint buyers book the 60-minute Deal Plan session on Day 7. Blank = the assessment session booking link above is used; if that is blank too, Josh’s team emails them.' },
  { key: 'AI_CALL_DAILY_CAP', label: 'Max AI calls per day (all leads)', group: 'Voice', placeholder: '40', help: 'A ceiling on outbound AI calls queued in any 24 hours, so a flood of fake sign-ups can’t run up a phone bill. Each number is also limited to 3 calls a week.' },
  { key: 'AI_CALL_CALLBACK_NUMBER', label: 'Callback number said on AI calls', group: 'Voice', placeholder: '+1 229 404 6271', help: 'Read out on every AI call and voicemail so people can call back (required for AI-voice calls to US numbers).' },

  { key: 'POSTHOG_KEY', label: 'PostHog project API key', group: 'Analytics', secret: true, placeholder: 'phc_…', help: 'Every event is mirrored to PostHog server-side.' },
  { key: 'POSTHOG_HOST', label: 'PostHog host', group: 'Analytics', placeholder: 'https://us.i.posthog.com' },
  { key: 'POSTHOG_SESSION_REPLAY', label: 'PostHog session replay', group: 'Analytics', placeholder: 'true', help: 'Loads posthog-js (via a first-party proxy) for recordings & heatmaps.' },
  { key: 'GA4_MEASUREMENT_ID', label: 'GA4 measurement ID', group: 'Analytics', placeholder: 'G-XXXXXXX' },
  { key: 'GA4_API_SECRET', label: 'GA4 Measurement Protocol secret', group: 'Analytics', secret: true },

  { key: 'META_PIXEL_ID', label: 'Meta Pixel ID', group: 'Ads' },
  { key: 'META_ACCESS_TOKEN', label: 'Meta Conversions API token', group: 'Ads', secret: true },
  { key: 'META_ADS_TOKEN', label: 'Meta ads token (ads_read)', group: 'Ads', secret: true, help: 'Lets Funnel HQ read ad spend per campaign. A system-user token with the ads_read permission. Leave blank to try the Conversions API token.' },
  { key: 'META_AD_ACCOUNT_ID', label: 'Meta ad account ID', group: 'Ads', placeholder: '1234567890', help: 'Pick it with “Connect ad account” on Traffic & ads.' },
  { key: 'META_TEST_EVENT_CODE', label: 'Meta test event code', group: 'Ads', help: 'Only while testing in Events Manager. Clear it before going live.' },

  { key: 'SLACK_WEBHOOK_URL', label: 'Slack webhook — team alerts', group: 'Alerts', secret: true, help: 'Hot leads, bookings, call-starting pings, no-shows, daily digest. Slack → Apps → Incoming Webhooks.' },
  { key: 'SLACK_WINS_WEBHOOK_URL', label: 'Slack webhook — closed deals', group: 'Alerts', secret: true, help: 'Optional separate #wins channel. Falls back to the alerts channel.' },
  { key: 'DISCORD_WEBHOOK_URL', label: 'Discord webhook — team alerts', group: 'Alerts', secret: true, help: 'Channel settings → Integrations → Webhooks → New webhook → Copy URL.' },
  { key: 'DISCORD_WINS_WEBHOOK_URL', label: 'Discord webhook — closed deals', group: 'Alerts', secret: true, help: 'Optional separate #wins channel. Falls back to the alerts channel.' },
  { key: 'SALES_TIMEZONE', label: 'Sales team time zone', group: 'Alerts', placeholder: 'Australia/Sydney', help: 'Used for the daily digest and call times in alerts.' },
  { key: 'DIGEST_HOUR', label: 'Daily digest hour (0–23)', group: 'Alerts', placeholder: '8', help: 'When the daily sales summary is posted. Leave blank for 8am.' },
  { key: 'LEAD_WEBHOOK_URL', label: 'CRM webhook (Zapier / Make / GHL)', group: 'Alerts', secret: true, help: 'Receives every lead lifecycle event as JSON.' },


  { key: 'CONTENT_YOUTUBE_CHANNEL', label: 'YouTube channel', group: 'Content', placeholder: '@officialjoshli', help: 'The handle (@name) or channel ID to track in Funnel HQ → Content.' },
  { key: 'YOUTUBE_API_KEY', label: 'YouTube Data API key', group: 'Content', secret: true, help: 'Free: console.cloud.google.com → APIs → enable “YouTube Data API v3” → Credentials → API key. Without it only the latest 15 videos are read (public feed).' },
  { key: 'GOOGLE_CLIENT_ID', label: 'Google OAuth client ID', group: 'Content', help: 'Lets Funnel HQ create Google Docs in your Drive (one click per video). console.cloud.google.com → new project → APIs & Services → enable “Google Drive API” → OAuth consent screen (External; add your Google account as a test user) → Credentials → Create OAuth client ID → Web application → Authorised redirect URI: https://<your apply domain>/oauth/google/callback. Paste the ID and secret here, save, then press “Connect Google Drive” in YouTube ideas.' },
  { key: 'GOOGLE_CLIENT_SECRET', label: 'Google OAuth client secret', group: 'Content', secret: true, help: 'From the same OAuth client.' },
  { key: 'GOOGLE_REFRESH_TOKEN', label: 'Google Drive connection', group: 'Content', secret: true, help: 'Filled in for you when you press “Connect Google Drive”. Clear it to disconnect.' },
  { key: 'GOOGLE_DRIVE_FOLDER_ID', label: 'Google Drive folder for docs (optional)', group: 'Content', help: 'The ID at the end of the folder’s URL. Leave blank to save docs in My Drive.' },
  { key: 'MIRO_ACCESS_TOKEN', label: 'Miro access token', group: 'Content', secret: true, help: 'Lets Funnel HQ build a laid-out Miro board for each YouTube sprint. miro.com → avatar → Settings → Your apps → Create new app → tick boards:write → Install app and get OAuth token → paste it here.' },
  { key: 'YT_BRAND_STORY', label: 'YouTube ideas: who Josh is (backstory)', group: 'Content', help: 'A few lines: background, deals done, why he does this. Only true facts: the generator uses it to pick credibility topics.' },
  { key: 'YT_PROOF', label: 'YouTube ideas: proof you can show', group: 'Content', help: 'Real results and testimonials you have permission to use, one per line. Leave blank and the generator won’t suggest proof videos.' },
  { key: 'YT_COMPETITORS', label: 'YouTube ideas: channels in your niche', group: 'Content', placeholder: '@codiesanchezct, @walkerdeibel', help: 'Comma-separated handles. Used to find what’s winning (needs the YouTube key).' },
  { key: 'YT_ADJACENT', label: 'YouTube ideas: adjacent niches', group: 'Content', placeholder: 'buying a business (ETA), private equity, real estate creative finance, agency scaling', help: 'Comma-separated. Formats are borrowed from these.' },
  { key: 'YT_NOTES', label: 'YouTube ideas: rules for every sprint', group: 'Content', help: 'Anything that overrides everything else, e.g. “no faceless videos”, “Josh can’t film in December”.' },
  { key: 'INSTAGRAM_USER_ID', label: 'Instagram account ID', group: 'Content', help: 'The Instagram Business/Creator account ID (Graph API Explorer → me/accounts → instagram_business_account).' },
  { key: 'INSTAGRAM_ACCESS_TOKEN', label: 'Instagram access token', group: 'Content', secret: true, help: 'A long-lived token with instagram_basic and instagram_manage_insights (Meta app → Instagram Graph API).' },

  { key: 'SEO_INDEXING', label: 'Show pages in Google & AI search', group: 'Search', placeholder: 'on', help: 'The landing pages, industry pages and guides are open to Google, Bing and AI assistants (ChatGPT, Claude, Perplexity, Gemini, Grok). The application, booking and personal pages never are. Type off to hide everything from search.' },
  { key: 'GOOGLE_SITE_VERIFICATION', label: 'Google Search Console code', group: 'Search', placeholder: 'abc123…', help: 'search.google.com/search-console → Add property → URL prefix → HTML tag: paste only the content="…" value. Then submit /sitemap.xml there.' },
  { key: 'BING_SITE_VERIFICATION', label: 'Bing Webmaster code', group: 'Search', placeholder: 'ABC123…', help: 'bing.com/webmasters → Add site → HTML meta tag: paste the content="…" value. Bing powers ChatGPT search and Copilot, so this matters for AI traffic.' },
  { key: 'SEO_SAME_AS', label: 'Josh’s profiles (for AI to recognise him)', group: 'Search', placeholder: 'https://www.instagram.com/officialjoshli/, https://www.youtube.com/channel/UCaJNq5_e7ognPLRqS6n-gCA', help: 'Comma-separated links to Josh’s official profiles (LinkedIn, X, YouTube, Instagram). Search engines and AI use them to connect the site to him.' },
  { key: 'X_HANDLE', label: 'X (Twitter) handle', group: 'Search', placeholder: '@officialjoshli', help: 'Shown on link previews when pages are shared on X.' },

  { key: 'VOICE_INPUT', label: 'Talk instead of type (application)', group: 'Site', placeholder: 'on', help: 'A microphone button on the application. Uses the browser’s own speech recognition; in Facebook/Instagram in-app browsers it records a short clip that Cloudflare’s own speech-to-text (Workers AI) turns into text. Audio is never stored. Type off to hide it.' },

  { key: 'BLOCKLIST', label: 'Lead blocklist', group: 'Security', placeholder: 'tyrekicker@example.com, +61400000000, @competitor.com', help: 'Emails, phone numbers or @domains that always go to the free resources page instead of a call.' },
  { key: 'CLARITY_ID', label: 'Microsoft Clarity project ID', group: 'Analytics', help: 'Free session recordings and heatmaps.' },
  { key: 'TURNSTILE_SITE_KEY', label: 'Turnstile site key', group: 'Security', help: 'Invisible bot check on the application.' },
  { key: 'TURNSTILE_SECRET_KEY', label: 'Turnstile secret key', group: 'Security', secret: true },
  { key: 'CONSENT_REQUIRED_EU', label: 'Cookie consent for EU visitors', group: 'Security', placeholder: 'true' },
  { key: 'IP_ANONYMIZE', label: 'Store hashed IPs only', group: 'Security', placeholder: 'false' },
] as const;

export type SettingKey = (typeof SETTINGS)[number]['key'];
export type Settings = Record<SettingKey, string>;

const KEYS = new Set<string>(SETTINGS.map((s) => s.key));
export const isSettingKey = (k: string): k is SettingKey => KEYS.has(k);

let cache: { at: number; db: Record<string, string> } | null = null;
const TTL_MS = 15_000;

async function dbSettings(env: Env): Promise<Record<string, string>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.db;
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  const db = Object.fromEntries(results.map((r) => [r.key, r.value]));
  cache = { at: Date.now(), db };
  return db;
}

export async function loadSettings(env: Env): Promise<Settings> {
  const db = await dbSettings(env);
  const out = {} as Settings;
  for (const { key } of SETTINGS) {
    const fromEnv = (env as unknown as Record<string, string | undefined>)[key];
    out[key] = (fromEnv && fromEnv.trim()) || db[key] || '';
  }
  return out;
}

/** Where each setting's value currently comes from, for the dashboard. */
export async function describeSettings(env: Env) {
  const db = await dbSettings(env);
  return SETTINGS.map((def) => {
    const fromEnv = (env as unknown as Record<string, string | undefined>)[def.key]?.trim();
    const value = fromEnv || db[def.key] || '';
    const secret = 'secret' in def && def.secret;
    return {
      ...def,
      source: fromEnv ? 'env' : db[def.key] ? 'dashboard' : 'unset',
      value: secret ? mask(value) : value,
    };
  });
}

export async function saveSettings(env: Env, values: Record<string, string>) {
  const now = Date.now();
  const stmts = Object.entries(values)
    .filter(([k]) => isSettingKey(k))
    .map(([k, v]) =>
      v.trim()
        ? env.DB.prepare(
            'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
          ).bind(k, v.trim(), now)
        : env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(k),
    );
  if (stmts.length) await env.DB.batch(stmts);
  cache = null;
}

function mask(v: string) {
  if (!v) return '';
  return v.length < 16 ? '•••• (set)' : `••••${v.slice(-4)}`;
}

export const flag = (v: string | undefined, dflt = false) => (v ? /^(1|true|yes|on)$/i.test(v.trim()) : dflt);
