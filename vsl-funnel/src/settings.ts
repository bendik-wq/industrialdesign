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
  group: 'Site' | 'Video' | 'Booking' | 'Email' | 'WhatsApp' | 'Voice' | 'Analytics' | 'Ads' | 'Alerts' | 'Security' | 'Webinar' | 'SMS' | 'Data' | 'Content' | 'Search' | 'Contracts' | 'Live' | 'Live funnel' | 'Command' | 'Research' | 'Instagram DMs' | 'Clients & support' | 'AI & search' | 'Studio' | 'Radar';
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
  { key: 'AI_CALL_BOOKING_TOOLS', label: 'AI calls book and move strategy calls live', group: 'Voice', placeholder: 'true', help: 'On when the Calendly token is set: on confirmation, speed-to-lead, rebook and callback calls, Sam offers real open times from Calendly and books (or moves) the call the person picks. Calendly sends the invite. If it fails, the booking link is emailed instead. Set to false to turn off, then press “Create / update agent” on the Voice tab. If your Calendly booking form has required choice questions, Sam can’t answer them for the person, so the link is emailed instead.' },
  { key: 'AI_CALL_W_PRE', label: 'Webinar AI calls: before the session', group: 'Voice', placeholder: 'true', help: 'Automated webinar, live Zoom webinar and challenge: a welcome call shortly after registering, a day-before reminder and a "starting in 10 minutes" call, only to people who ticked the call box. Set to false to turn off.' },
  { key: 'AI_CALL_W_LEFT', label: 'Webinar AI calls: left mid-session', group: 'Voice', placeholder: 'true', help: 'Calls someone who left the room before the end (no presence for the wait below) and offers a link that picks up where they left. Never if they rejoin. Set to false to turn off.' },
  { key: 'AI_CALL_W_NOBUY', label: 'Webinar AI calls: after the session, no purchase', group: 'Voice', placeholder: 'true', help: 'Attended without buying: a call inside the real offer window to answer questions. Registered but missed it: a replay call. Set to false to turn off.' },
  { key: 'AI_CALL_W_BOUGHT', label: 'Webinar AI calls: after a purchase', group: 'Voice', placeholder: 'true', help: 'A thank-you and next-steps call after a Sprint, deposit or VIP purchase. Never pitches what they bought. Set to false to turn off.' },
  { key: 'AI_CALL_W_LEFT_WAIT_MIN', label: 'Webinar AI calls: minutes away before a "left" call', group: 'Voice', placeholder: '8', help: 'How long someone must be out of the room (no presence) before the left-mid-session call. 3 to 60 minutes.' },
  { key: 'AI_CALL_WEEKLY_CAP', label: 'Max AI calls per person per week', group: 'Voice', placeholder: '4', help: 'Across every AI call flow, counted by phone number. Also never more than 2 calls a person a day.' },
  { key: 'AI_CALL_OWNER_NUMBER', label: 'Your mobile for test calls', group: 'Voice', placeholder: '+61412345678', help: 'The "Call me" test buttons ring this number. International format.' },
  { key: 'ELEVENLABS_WEBINAR_AGENT_ID', label: 'ElevenLabs webinar call agent ID', group: 'Voice', help: 'Filled in automatically by "Create / update webinar call agent" on the AI calls tab.' },
  { key: 'TWILIO_ACCOUNT_SID', label: 'Twilio Account SID', group: 'SMS', placeholder: 'AC…', help: 'console.twilio.com → Account info. Text messages go out through Twilio.' },
  { key: 'TWILIO_AUTH_TOKEN', label: 'Twilio Auth Token', group: 'SMS', secret: true, help: 'console.twilio.com → Account info. Also used to check that replies really come from Twilio.' },
  { key: 'TELNYX_API_KEY', label: 'Telnyx API key', group: 'SMS', secret: true, help: 'portal.telnyx.com → Keys & Credentials → API Keys. Texts go out through Telnyx when Twilio isn’t connected (or SMS provider is telnyx). Replies come in at /hooks/telnyx/sms (set it as the messaging profile’s webhook); the signature is checked with your account’s public key, fetched automatically.' },
  { key: 'TELNYX_MESSAGING_PROFILE_ID', label: 'Telnyx messaging profile ID', group: 'SMS', placeholder: '4001a1a0-…', help: 'Optional. portal.telnyx.com → Messaging → your profile. The sending number must be on this profile.' },
  { key: 'SMS_SENDER_AU', label: 'Sender name for Australian mobiles', group: 'SMS', placeholder: 'GL Advisory', help: 'Telnyx only. Texts to +61 numbers show this name instead of a number (up to 11 letters, numbers or spaces; no &). People can’t reply to a name, so those texts carry an opt-out link instead of “Reply STOP”. Blank = send from the number.' },
  { key: 'SMS_PROVIDER', label: 'SMS provider', group: 'SMS', placeholder: 'auto', help: 'Blank = Twilio if its keys are in, else Telnyx. Or set twilio / telnyx.' },
  { key: 'SMS_FROM', label: 'Send texts from', group: 'SMS', placeholder: '+12294046271 or MG… (Messaging Service SID)', help: 'A Twilio number, or a Messaging Service SID (best: lets Twilio pick an Australian sender for AU numbers). US numbers need A2P 10DLC registration in Twilio.' },
  { key: 'SMS_ENABLED', label: 'Send SMS follow-up', group: 'SMS', placeholder: 'true', help: 'Texts only go to people who ticked “call or text me”, 8am–8pm their time, max 3 a day. Set to false to pause.' },
  { key: 'WEBINAR_URL', label: 'Webinar address', group: 'Webinar', placeholder: 'https://live.grosfjeld-li.com', help: 'The domain the webinar pages live on. Links in webinar emails use it.' },
  { key: 'WEBINAR_JIT_EVERY', label: 'Just-in-time showings every (minutes)', group: 'Webinar', placeholder: '15', help: 'A showing starts every this many minutes, so nobody waits more than that. 0 turns it off (scheduled sessions only).' },
  { key: 'WEBINAR_JIT_HOURS', label: 'Just-in-time hours (viewer’s local time)', group: 'Webinar', placeholder: '7-22', help: 'Showings are offered between these hours in the viewer’s own time zone, e.g. 7-22.' },
  { key: 'WEBINAR_AI_MODEL', label: 'Masterclass Q&A model', group: 'Webinar', placeholder: 'claude-haiku-5-5', help: 'The AI assistant that answers questions typed in the room (needs the Anthropic API key under Email). Blank uses a fast model.' },
  { key: 'WEBINAR_SELF_SERVE', label: 'Self-serve agreement in the room', group: 'Webinar', placeholder: 'off', help: 'on = $1M+ viewers can start straight from the masterclass: the agreement is quoted from their revenue, signed for the company in Josh’s name, e-signed by them, then card payment (needs the payment link under Contracts). off = book a call only.' },
  { key: 'WEBINAR_CHAPTERS', label: 'Masterclass chapters', group: 'Webinar', placeholder: '0 Why buy; 7 Where the deals are; …', help: 'Minute and title per chapter, separated by semicolons. Shown as the agenda in the room. Blank uses the built-in outline.' },
  { key: 'WEBINAR_BONUS_AT', label: 'Worksheet unlocks at (minute)', group: 'Webinar', placeholder: '63', help: 'Minute of the masterclass when the attendee-only Deal Structure Worksheet appears.' },
  { key: 'QUIZ_TARGET', label: 'Quiz: where “Save my seat” registers', group: 'Webinar', placeholder: 'webinar', help: 'The acquisition readiness quiz at /quiz ends with one click to a seat. webinar (default) = the automated masterclass, at the showing they pick; live = the next live event.' },
  { key: 'WEBINAR_HEADLINE_TEST', label: 'Webinar headline test', group: 'Webinar', placeholder: 'auto', help: 'auto = traffic shifts to the headline that brings the most $1M+ sign-ups; even = equal split; or a headline id to show it to everyone. Set from Funnel HQ → Webinar.' },
  { key: 'WEBINAR_TITLE', label: 'Webinar title', group: 'Webinar', placeholder: 'The Acquisition Masterclass', help: 'Shown on the registration page, the room and the emails.' },
  { key: 'WEBINAR_SCHEDULE', label: 'Weekly sessions', group: 'Webinar', placeholder: 'Tue 19:00, Thu 12:00', help: 'Recurring session times in the sales time zone (days: Mon–Sun, 24h clock). Sessions are created two weeks ahead. Add one-off or live sessions on the Webinar tab.' },
  { key: 'WEBINAR_VIDEO_SRC', label: 'Webinar recording (MP4 / HLS URL)', group: 'Webinar', placeholder: 'https://…/webinar.mp4', help: 'Played in sync in the webinar room for scheduled (recorded) sessions, and as the replay. Until it’s set, the main VSL is used as a placeholder.' },
  { key: 'WEBINAR_STREAM_HLS', label: 'Live stream playback URL (Cloudflare Stream)', group: 'Webinar', placeholder: 'https://customer-xxxx.cloudflarestream.com/<live input id>/manifest/video.m3u8', help: 'For “Live in our room” sessions. Cloudflare dashboard → Stream → Live inputs → your input → HLS playback URL. Stream into it from OBS, StreamYard or Zoom (Live on custom streaming service) using the RTMPS URL + key shown there.' },
  { key: 'ZOOM_ACCOUNT_ID', label: 'Zoom account ID', group: 'Live', help: 'Optional: lets Funnel HQ create the Zoom meeting for each live event. Without it, paste a Zoom link per event in the host console. marketplace.zoom.us → Develop → Build app → Server-to-Server OAuth app → App credentials.' },
  { key: 'ZOOM_CLIENT_ID', label: 'Zoom client ID', group: 'Live', help: 'From the same Server-to-Server OAuth app.' },
  { key: 'ZOOM_CLIENT_SECRET', label: 'Zoom client secret', group: 'Live', secret: true, help: 'From the same app. Scopes to add: meeting:write:meeting:admin and meeting:read:meeting:admin (plus webinar:write:webinar:admin, webinar:read:webinar:admin and webinar:read:list_webinars:admin if the account has Zoom Webinars).' },
  { key: 'ZOOM_HOST_USER', label: 'Zoom host (email)', group: 'Live', placeholder: 'me', help: 'Whose Zoom account hosts the events. Blank = the user who created the app.' },
  { key: 'REALTIME_APP_ID', label: 'Rooms: Cloudflare Realtime app ID', group: 'Live', help: 'Our own video rooms (webinars, challenge days, client meetings) run on Cloudflare Realtime. dash.cloudflare.com → Realtime → SFU → your app → App ID.' },
  { key: 'REALTIME_APP_SECRET', label: 'Rooms: Realtime app secret', group: 'Live', secret: true, help: 'From the same SFU app (App Secret / API token). Stays on the server: the Worker makes every SFU call.' },
  { key: 'REALTIME_TURN_KEY_ID', label: 'Rooms: TURN key ID', group: 'Live', help: 'dash.cloudflare.com → Realtime → TURN Server → your key → Key ID. Lets people on strict networks connect over TLS on port 443.' },
  { key: 'REALTIME_TURN_TOKEN', label: 'Rooms: TURN key API token', group: 'Live', secret: true, help: 'From the same TURN key. Each participant gets short-lived credentials minted from it.' },
  { key: 'MOQ_PUBLISH_TOKEN', label: 'Rooms: MoQ publish token', group: 'Live', secret: true, help: 'Big webinars: the stage is relayed to viewers over Cloudflare MoQ (Media over QUIC). dash.cloudflare.com → Media → Realtime → MoQ Relay → your relay → the publish and subscribe token. Only the host’s signed-in browser receives it, to publish the stage.' },
  { key: 'MOQ_SUBSCRIBE_TOKEN', label: 'Rooms: MoQ subscribe token', group: 'Live', secret: true, help: 'The subscribe-only token of the same relay. A viewer’s browser receives it only while they hold a valid room ticket and the stage is live.' },
  { key: 'MOQ_RELAY_URL', label: 'Rooms: MoQ relay URL', group: 'Live', placeholder: 'https://draft-16.cloudflare.mediaoverquic.com', help: 'Blank uses Cloudflare’s draft-16 relay. The token is added to the path.' },
  { key: 'ROOM_BROADCAST', label: 'Rooms: how webinar viewers watch', group: 'Live', placeholder: 'auto', help: 'auto = viewers watch over the SFU until the audience reaches the size below, then over MoQ (and stay on MoQ for the rest of the session). moq = MoQ for every webinar viewer. sfu = never MoQ. Viewers whose browser or network can’t use MoQ always fall back to the SFU on their own. Each room can override this in Funnel HQ → Rooms.' },
  { key: 'ROOM_MOQ_AUDIENCE', label: 'Rooms: audience size that switches to MoQ', group: 'Live', placeholder: '25', help: 'For auto: once this many viewers are connected at once, the room moves its audience to MoQ.' },
  { key: 'ENGAGE_POINTS', label: 'Rooms: Deal momentum points', group: 'Live', placeholder: 'question:5x3, poll:3x10', help: 'Points per real action in a webinar room, and the most times each counts (points x cap). Actions: on_time, present_10 (each ten minutes in the room), chapter, poll, question (15 characters or more), quiz, quiz_correct, plan_step, application, stayed_end. Blank = the defaults (on_time:10, present_10:5x12, chapter:5x12, poll:3x10, question:5x3, quiz:5x10, quiz_correct:5x10, plan_step:10x4, application:30, stayed_end:20). Chat earns nothing. Set an action to 0 to turn it off.' },
  { key: 'ENGAGE_UNLOCKS', label: 'Rooms: unlocks at point thresholds', group: 'Live', placeholder: 'calculator:25, scripts:60, buybox:100, checklist:end', help: 'Which files an attendee unlocks, and when: a number of points, or end (granted only to people still in the room when the host ends a live session). Files: calculator (the 1.5x deal calculator spreadsheet), scripts (owner outreach scripts), buybox (buy box template), checklist (first-deal checklist). Blank = the defaults shown. off = no unlocks.' },
  // ── Rooms: call quality and reliability (area A "media", src/rooms/media.ts) ──
  { key: 'ROOM_FX', label: 'Rooms: background blur and G&L backdrop', group: 'Live', placeholder: 'on', help: 'on (default) = people on camera can blur their background or use the G&L backdrop. It runs on their own device (MediaPipe selfie segmentation, a pinned build loaded from jsDelivr only when someone switches it on) and turns itself off on devices too slow for it. off = no background effects.' },
  { key: 'ROOM_NOISE_WASM', label: 'Rooms: strong noise reduction', group: 'Live', placeholder: 'on', help: 'on (default) = besides the browser’s own noise reduction, people can pick Strong (RNNoise, a pinned build loaded from jsDelivr only when picked), for noisy rooms. off = the browser’s noise reduction only.' },
  { key: 'ROOM_APP_FOLLOWUPS', label: 'Rooms: follow-ups after an application in the room', group: 'Live', placeholder: 'off', help: 'off (default) = an application sent inside a live room is scored, tiered and alerted the same way, without the /apply page’s tier emails, texts and speed-to-lead call (they invite a booked call, which the live funnels don’t use as a sales path). on = also start those follow-ups.' },
  { key: 'ROOM_AUTO_PUSH', label: 'Rooms: automatic pushes (default schedule)', group: 'Live', placeholder: '35 application\\n45 sprint', help: 'Cards a webinar room pushes on its own, in minutes after Go live, one per line: "35 application", "45 sprint", "40 deposit" (sent once the offer is open), "20 resource scripts". Each room can set its own schedule in Funnel HQ → Rooms. off = no automatic pushes. The host can skip one or send it early from the Push tab.' },
  // ── Rooms: the production studio (builder B, src/rooms/studio.ts) ──
  { key: 'ROOM_STUDIO', label: 'Rooms: production studio', group: 'Live', placeholder: 'on', help: 'on (default) = webinar rooms have the studio: scenes (intro, main, slides, break, Q&A, offer, outro), slides, overlays, the green room, producers and the run of show. Attendees, the MoQ broadcast and the recording all show the scene. off = the plain stage. Each room’s branding, intro music and defaults are in Funnel HQ → Rooms → Studio.' },
  // ── Area C (audience): reactions, live captions, the AI co-host, purchase announcements, the checkout nudge ──
  { key: 'ROOM_REACTIONS', label: 'Rooms: reactions', group: 'Live', placeholder: 'on', help: 'on (default) = attendees can tap to react while live. The room sends everyone one total a second, and each person is limited to a few reactions every five seconds. off = no reaction bar.' },
  { key: 'ROOM_CAPTIONS', label: 'Rooms: live captions', group: 'Live', placeholder: 'on', help: 'on (default) = hosts and co-hosts can start live captions in the room: their microphone is transcribed by Workers AI Whisper in short pieces, shown to everyone with a notice that captions are machine-generated, and kept as the session transcript (room_captions). off = no captions.' },
  { key: 'ROOM_CAPTION_LANGS', label: 'Rooms: caption translation languages', group: 'Live', placeholder: 'es, fr, de, it, pt, zh, ja, ko, hi, ar, vi', help: 'Languages attendees can pick for machine-translated captions (two-letter codes). Each line is translated once per language and cached.' },
  { key: 'ROOM_PROOF', label: 'Rooms: purchase announcements (default for new rooms)', group: 'Live', placeholder: 'off', help: 'on = rooms start with purchase and application announcements on. Only buyers who ticked the box on the room’s payment or application card are announced, by first name and city, once each. The host can switch it per room in the Co-host tab.' },
  { key: 'ROOM_PROOF_GAP_SEC', label: 'Rooms: seconds between announcements', group: 'Live', placeholder: '90', help: 'At most one announcement this often. Announcements that would wait more than five minutes are dropped, so "just" stays true.' },
  // Engage2: the engagement score, the host's hot list and its follow-up proposal (src/rooms/engage2*.ts).
  { key: 'ROOM_SCORE_WEIGHTS', label: 'Rooms: engagement score weights', group: 'Live', placeholder: 'checkout:12, minutes:20/60', help: 'The 0 to 100 engagement score per attendee. Each signal gives up to its weight, earned in full at the amount after the slash: minutes:20/60 (minutes in the room), on_time:5, answers:12/4 (polls and knowledge checks), questions:8/2, plan:12/4 (Deal Plan steps), reactions:3/10, opened:9/3 (cards or the offer opened), application:12, checkout:12, focus:7 (share of live time the room was in view). Blank = these defaults. Signals with no data are left out of the total.' },
  { key: 'ROOM_HOT_MIN', label: 'Rooms: hot list score line', group: 'Live', placeholder: '50', help: 'Attendees at or above this engagement score join the host’s hot list even without a buying signal (a checkout started, the offer opened twice, a price question always qualifies). Buyers are left out.' },
  { key: 'ROOM_HOT_FOLLOWUP', label: 'Rooms: hot list follow-up proposal after the session', group: 'Live', placeholder: 'on', help: 'on (default) = after a webinar room ends, Command gets one proposal listing the hottest attendees who didn’t buy. Approving it only adds a note on each lead for the team’s personal follow-up: nothing is sent. off = no proposal.' },
  { key: 'ROOM_HOT_FOLLOWUP_N', label: 'Rooms: people in the follow-up proposal', group: 'Live', placeholder: '12', help: 'How many of the hottest attendees who didn’t buy the proposal lists (1 to 50).' },
  { key: 'ROOM_CHECKOUT_NUDGE_MIN', label: 'Rooms: abandoned-checkout nudge after (minutes)', group: 'Live', placeholder: '10', help: 'Someone who started paying in the room and hasn’t paid after this many minutes gets one quiet reminder in the room (only once, only while they are still there, checked against real payments). off = no nudge.' },
  { key: 'ROOM_COHOST_MODEL', label: 'Rooms: AI co-host model', group: 'Live', placeholder: 'claude-sonnet-5-5', help: 'Drafts answers to the room’s questions from our knowledge base and reads chat for buying intent (needs the Anthropic API key under Email). Blank uses the support model. Without a key the co-host runs on keyword rules and knowledge-base passages.' },
  { key: 'ROOM_COHOST_AUTO', label: 'Rooms: automatic answers', group: 'Live', placeholder: 'off', help: 'off (default) = a person on the team sends every answer. on = drafts the model is confident about, on plain questions (never price, payment, refunds, the guarantee or contracts), go to the room automatically, labelled as an automatic answer from the team’s assistant (AI).' },
  // ── Rooms intel (area D): transcripts, the debrief, replays, simulive showings, highlight clips ──
  { key: 'INTEL_TRANSCRIBE', label: 'Rooms: transcribe recordings', group: 'Live', placeholder: 'on', help: 'on (default) = after a session, its recording is transcribed with Workers AI Whisper in chunks (the cron runs it every 5 minutes; Funnel HQ → Rooms → Debrief runs it while open). The room shows attendees that the session is recorded and transcribed. off = no transcription; the live captions are used where there are any.' },
  { key: 'INTEL_CHUNK_MB', label: 'Rooms: transcription chunk size (MB)', group: 'Live', placeholder: '8', help: 'How much of the recording goes to Whisper at a time (1 to 20). Smaller chunks are slower overall but each step is lighter.' },
  { key: 'INTEL_MODEL', label: 'Rooms: debrief model', group: 'Live', placeholder: 'claude-sonnet-5-5', help: 'Writes the debrief’s summary, chapter titles and script changes (needs the Anthropic API key under Email). Every number it states is checked against the room’s data; a sentence with any other number is left out. Blank uses Claude Sonnet. Without a key the debrief is built from the numbers alone.' },
  { key: 'INTEL_AUTO_DEBRIEF', label: 'Rooms: write the debrief on its own', group: 'Live', placeholder: 'on', help: 'on (default) = the cron writes each webinar room’s debrief once its transcript is done (or 6 hours after the end). off = only from Funnel HQ.' },
  { key: 'INTEL_POST_COMMAND', label: 'Rooms: post each debrief to Command', group: 'Live', placeholder: 'off', help: 'on = every new debrief is also saved as a Command document. off (default) = post it from the Debrief panel when you want.' },
  { key: 'INTEL_REPLAY_POINTS', label: 'Rooms: points for watching the replay', group: 'Live', placeholder: '5x6', help: 'Points for every ten distinct minutes of a replay watched, and the most times it counts (points x cap). off = none.' },
  // ── Reliability (overnight loop): room Durable Object clean-up ──
  { key: 'ROOM_DO_KEEP_DAYS', label: 'Rooms: keep a room’s live state after it ends (days)', group: 'Live', placeholder: '30', help: 'After a room ends (or is cancelled) and nobody has been in it for this many days, its live state (chat and Q&A as the room showed them, connection reports) is cleared from the room server. Everything Funnel HQ reports on (attendance, chat timeline, recordings, debrief) is kept in the database and is not touched. 7 to 365.' },
  { key: 'WEBINAR_ROOM_EDITION', label: 'Masterclass: recorded live session (simulive)', group: 'Webinar', help: 'Set from Funnel HQ → Rooms → Debrief → Use for showings. With Which masterclass plays = room, the automated webinar plays this recorded live session in sync for everyone in a showing, labelled as a recorded session, with its chapters and the cards shared live at their moments.' },
  { key: 'WEBINAR_EDITION', label: 'Which masterclass plays', group: 'Webinar', placeholder: 'recorded', help: 'recorded = Josh’s own recording (script v3, 66 minutes, the Sprint unlocks at 38:00; set the recording link below). ai = the AI edition, narrated by an AI voice presenting Josh’s method (disclosed at the start and on every slide), about 22 minutes, pitching the First Deal Sprint from the first minute. Its chapters, polls, key points, calculator, buy-in and unlock are timed from its own audio. The length, offer and worksheet minutes below override it when set. room = a recorded live session from our own room (set from Funnel HQ → Rooms → Debrief → Use for showings), labelled as a recorded session in every showing.' },
  { key: 'WEBINAR_DURATION_MIN', label: 'Webinar length (minutes)', group: 'Webinar', placeholder: '66', help: 'When the session counts as finished and the replay opens.' },
  { key: 'WEBINAR_PITCH_AT', label: 'Offer appears at (minutes in)', group: 'Webinar', placeholder: '38', help: 'The pitch minute: the First Deal Sprint unlocks in the room at this point of the recording (live and replay alike), and checkout only works for viewers who reached it.' },
  { key: 'WEBINAR_REPLAY_HOURS', label: 'Replay available for (hours)', group: 'Webinar', placeholder: '48', help: 'After this the replay link shows the next session instead. The emails say the same number.' },
  { key: 'WEBINAR_CHAT', label: 'Showing chat in the room', group: 'Webinar', placeholder: 'on', help: 'on = viewers in the same showing can chat with each other (real people only; links, emails and phone numbers are removed). off = no chat. The team can reply, pin and delete from the host console on the Webinar tab.' },
  { key: 'WEBINAR_HOST_NAMES', label: 'Team names for the room', group: 'Webinar', placeholder: 'G&L team, Josh', help: 'Names the team can post under in the showing chat and announcements, comma separated (up to 5). The first is the default. Only post as Josh when Josh is typing.' },
  { key: 'WEBINAR_PASS', label: 'Paid offer in the masterclass', group: 'Webinar', placeholder: 'off', help: 'off = nothing to buy. upsell = the masterclass is open to everyone; the offer (First Deal Sprint by default) unlocks in the room at the pitch minute for $1M+ viewers, one click next to the strategy call, until their replay closes. required + a ticket price below = a paid ticket to watch at all: the landing page sells a “Masterclass ticket” at that price (with the 7-day ticket guarantee and the credit toward the First Deal Sprint), registration goes straight to checkout (Whop, or Stripe), and the room, the confirmation, the reminders, the pre-webinar emails and texts only start once the ticket is paid (unpaid registrants get three short “finish your ticket” emails instead). The Sprint then unlocks in the room the same way. Needs the Whop API key (or the Stripe secret key); without one nothing is sold and registration stays open.' },
  { key: 'WEBINAR_OFFER_NAME', label: 'Offer name', group: 'Webinar', placeholder: 'First Deal Sprint', help: 'The front-end product sold in the masterclass. It unlocks in the room at the pitch minute and is shown there, on its offer page, on Stripe, in the closing emails and in Funnel HQ.' },
  { key: 'WEBINAR_PASS_PRICE', label: 'Offer price', group: 'Webinar', placeholder: '3000', help: 'In the currency below. The full fee is credited against the advisory engagement if they continue.' },
  { key: 'WEBINAR_PASS_CURRENCY', label: 'Offer currency', group: 'Webinar', placeholder: 'USD' },
  { key: 'WEBINAR_OFFER_PERKS', label: 'What the offer includes', group: 'Webinar', help: 'One per line, “Title: one-sentence detail”, optionally led by the day (“Day 3: Your buy box: the business to buy first”). {price} and {replay_days} are filled in. Blank = the built-in 7-day Sprint (kickoff and numbers, acquisition capacity, buy box, a first shortlist, deal-structure memo, outreach script, Day 7 Deal Plan session, fee credited, guarantee). Only list what you deliver, and never promise results.' },
  { key: 'WEBINAR_OFFER_SESSION_URL', label: 'Deal Plan session booking link', group: 'Webinar', placeholder: 'https://calendly.com/team/deal-plan', help: 'Where buyers book their 60-minute Deal Plan session. Blank = the confirmation says Josh’s team will email them to book it.' },
  { key: 'WEBINAR_PASS_REPLAY_DAYS', label: 'Offer: replay kept for (days)', group: 'Webinar', placeholder: '30', help: 'Buyers keep the replay this long instead of the usual replay hours.' },
  { key: 'WEBINAR_PASS_REFUND', label: 'Offer: guarantee', group: 'Webinar', placeholder: 'Do the Sprint. If at the end of your Deal Plan session you don’t think it was worth far more than you paid, tell us that day and we refund the full fee.', help: 'Shown with the price, on the offer page and in the closing emails. A promise about the refund, never about results. Honour it: refund in Whop (or Stripe) and the purchase is withdrawn automatically (a payment plan stops too).' },
  { key: 'WEBINAR_PASS_PLAN', label: 'Offer: payment plan (optional)', group: 'Webinar', placeholder: '2x1550', help: 'Payments x amount, monthly, e.g. 2x1550 = “2 payments of $1,550”. Blank = one payment only. Runs as a Stripe subscription that stops itself after the last payment (needs the invoice.paid webhook event). The ticket credit comes off the first payment. Hidden when Whop takes the payments: Whop shows its own pay-later options at checkout.' },
  { key: 'WEBINAR_FAST_BONUS', label: 'Offer: fast-action bonus', group: 'Webinar', placeholder: 'Josh reviews your Deal Plan personally: before your Day 7 session, Josh reads your deal-structure memo and adds his notes', help: '“Title: detail”. Offered for 24 hours after the Sprint unlocks for that viewer (or until their replay closes, if sooner), with a real countdown. Buyers inside the window are marked on their purchase. Blank = the default above; “off” = no bonus. Only offer what you will deliver.' },
  { key: 'WEBINAR_PASS_WEEKLY_CAP', label: 'Offer: most sold per week (optional)', group: 'Webinar', placeholder: '10', help: 'Blank = no cap. When set, no more than this many are sold per week (Monday to Sunday, sales time zone) and pages show the true number left. Nothing is ever shown as sold out unless this cap is genuinely reached.' },
  { key: 'WEBINAR_SEAT_PRICE', label: 'Ticket price (required mode only)', group: 'Webinar', placeholder: '100', help: 'The Masterclass ticket. Blank = watching is free. With the paid offer setting on “required”, this is the price of a ticket to watch at all (for example 100): registrants pay it at checkout (Whop, or Stripe) right after signing up, and the room opens once it is paid. A full refund closes the room again. Each paid ticket is credited toward the First Deal Sprint. Same currency as the offer.' },
  // ── Ticket add-on (overnight loop round 2, ticket economics: src/webinar/ticket-addon.ts). Off unless a name and a price are set. ──
  { key: 'TICKET_ADDON', label: 'Ticket add-on: name (optional)', group: 'Webinar', placeholder: 'Deal maths workbook', help: 'Blank = off (the default). A name here plus a price below = an optional add-on offered once on the Masterclass ticket thank-you page, charged with one click to the card saved with the ticket (Whop only). Nothing is pre-ticked: the buyer presses a button that states the product, the total and the card. Refunds work like the ticket (refund in Whop and it leaves the revenue). Only offer what you deliver.' },
  { key: 'TICKET_ADDON_PRICE', label: 'Ticket add-on: price', group: 'Webinar', placeholder: '27', help: 'Between 1 and 500, same currency as the ticket. Blank = off. Whop’s buyer service fee is added and shown on the button.' },
  { key: 'TICKET_ADDON_DESCRIPTION', label: 'Ticket add-on: what it is', group: 'Webinar', placeholder: 'The spreadsheet behind the 1.5x test, with the worked example from the masterclass.', help: 'One or two plain sentences shown under the name. No promised results.' },
  { key: 'TICKET_ADDON_URL', label: 'Ticket add-on: delivery link (optional)', group: 'Webinar', placeholder: 'https://…', help: 'Where buyers open it once paid (shown on their thank-you page). Blank = they are told the team emails it within one business day, and Slack reminds you to send it.' },
  { key: 'WHOP_API_KEY', label: 'Whop API key', group: 'Webinar', secret: true, placeholder: 'apik_…', help: 'whop.com → Dashboard → Developer → API keys (a company key). When set, Whop takes every payment (the Masterclass ticket and the First Deal Sprint) instead of Stripe. Then press “Connect Whop” on the Integrations tab: it fills in the company ID and creates the webhook. Whop caps checkout links at $2,500 until you apply for higher ones (Whop → Settings → Payments), and the Sprint is above that.' },
  { key: 'WHOP_WEBHOOK_SECRET', label: 'Whop webhook secret', group: 'Webinar', secret: true, placeholder: 'ws_…', help: 'Filled in by “Connect Whop”. To set it up by hand: Whop → Dashboard → Developer → Create webhook, URL <your apply domain>/hooks/whop, events payment.succeeded, refund.created, refund.updated, then paste the webhook’s secret here.' },
  { key: 'WHOP_BUYER_FEE_PERCENT', label: 'Whop buyer service fee (%)', group: 'Webinar', placeholder: '5', help: 'Shown on the one-click Sprint confirm step so the buyer sees the true total. Blank = 5 (this account’s Whop setting); 0 = no fee line. One click charges the card a viewer used for their Whop ticket and needs the payment:charge permission on the Whop API key.' },
  { key: 'WHOP_TICKET_FORM', label: 'Whop: ticket paid on our own page', group: 'Webinar', placeholder: 'on', help: 'on (default) = the Masterclass ticket is paid on the ticket page with Whop’s payment fields, and Whop saves the card so the First Deal Sprint is one click later (the page says so above the pay button). off = Whop’s hosted checkout, which does not save the card, so the Sprint goes through the form and checkout. For Apple Pay and Google Pay in the form, add your apply and webinar domains as payment method domains in Whop.' },
  { key: 'WHOP_COMPANY_ID', label: 'Whop company ID', group: 'Webinar', placeholder: 'biz_…', help: 'Filled in from the API key when blank.' },

  // The First Deal Challenge (cohorts are set up in Funnel HQ → Challenge).
  { key: 'CHALLENGE_PRICE', label: 'Challenge: ticket price', group: 'Live', placeholder: '100', help: 'The First Deal Challenge ticket, paid on our page with Whop’s card form (the card is saved for the VIP bump and the deposit). Blank = 100. 0 = no ticket price (registration confirms straight away). Credited against the engagement deposit.' },
  { key: 'CHALLENGE_VIP_PRICE', label: 'Challenge: VIP upgrade price', group: 'Live', placeholder: '300', help: 'Offered once, right after the ticket, as a one-click charge on the saved card: daily hot seats, recordings kept, worksheet feedback. Blank = 300. off = no VIP.' },
  { key: 'CHALLENGE_CURRENCY', label: 'Challenge: currency', group: 'Live', placeholder: 'USD' },
  { key: 'CHALLENGE_OFFER_HOURS', label: 'Challenge: offer stays open (hours after Day 5)', group: 'Live', placeholder: '48', help: 'The deposit offer opened on Days 4 and 5 closes this many hours after Day 5 ends, and replays close with it for everyone but VIP members. Every countdown on the pages and in the emails is to this deadline, and the server refuses deposits after it.' },
  { key: 'CHALLENGE_DURATION_MIN', label: 'Challenge: default session length (minutes)', group: 'Live', placeholder: '90' },
  { key: 'CHALLENGE_TIMEZONE', label: 'Challenge: default time zone for new cohorts', group: 'Live', placeholder: 'America/New_York' },
  { key: 'STRIPE_SECRET_KEY', label: 'Stripe secret key', group: 'Webinar', secret: true, placeholder: 'sk_live_… or rk_live_…', help: 'dashboard.stripe.com → Developers → API keys. A restricted key with write access to Checkout Sessions and read access to Charges is enough.' },
  { key: 'STRIPE_WEBHOOK_SECRET', label: 'Stripe webhook signing secret', group: 'Webinar', secret: true, placeholder: 'whsec_…', help: 'Stripe → Developers → Webhooks → Add endpoint: <your apply domain>/hooks/stripe, events checkout.session.completed, checkout.session.async_payment_succeeded, checkout.session.expired, charge.refunded, invoice.paid (payment plans). Paste the endpoint’s signing secret here.' },
  { key: 'DEAL_SPRINT_KICKOFF_URL', label: 'First Deal Sprint: kickoff call booking link', group: 'Webinar', placeholder: 'https://calendly.com/team/sprint-kickoff', help: 'Where Sprint buyers book their Day 1 kickoff call (on their Sprint page and in the welcome email). Blank = they are told Josh’s team emails them to set it.' },
  { key: 'DEAL_SPRINT_PLAN_URL', label: 'First Deal Sprint: Deal Plan session booking link', group: 'Webinar', placeholder: 'https://calendly.com/team/deal-plan', help: 'Where Sprint buyers book the 60-minute Deal Plan session on Day 7. Blank = the assessment session booking link above is used; if that is blank too, Josh’s team emails them.' },
  // ── Live webinar funnel and the engagement deposit (src/live/*, src/sales/deposit.ts) ──
  { key: 'ENGAGEMENT_DEPOSIT', label: 'Engagement deposit amount', group: 'Live funnel', placeholder: '5000', help: 'The live funnels’ offer: a deposit that holds the buyer’s place in this intake of the 90-day advisory engagement, credited in full against the engagement fee (the balance is due on signing after the onboarding call). Blank = 5000. Paid through Whop: one click on the card saved with their ticket, else our own Whop payment page.' },
  { key: 'ENGAGEMENT_DEPOSIT_CURRENCY', label: 'Engagement deposit currency', group: 'Live funnel', placeholder: 'USD', help: 'Three-letter code. Blank = USD. The live ticket uses the same currency.' },
  { key: 'ENGAGEMENT_INTAKE_CAP', label: 'Weekly intake cap (deposits)', group: 'Live funnel', placeholder: '', help: 'Optional. The most deposits taken per week (Monday to Sunday in the sales time zone): paid deposits plus checkouts still open. Shown in the offer as “N of M places left” only when set, and enforced: when it is reached the button is refused. Blank = no cap and no count shown.' },
  { key: 'ENGAGEMENT_ONBOARDING_URL', label: 'Onboarding call booking link', group: 'Live funnel', placeholder: 'https://calendly.com/team/onboarding', help: 'Where deposit buyers book their onboarding call (first on the welcome page and in the welcome email). Blank = they are told Josh’s team emails them within one business day.' },
  // Round 4 "journey": the optional one-click add-on after the deposit (src/sales/deposit-addon.ts). Off unless a name and a price are set.
  { key: 'DEPOSIT_ADDON', label: 'Deposit add-on: name (optional)', group: 'Live funnel', placeholder: 'Lender-ready financial pack', help: 'Blank = off (the default). A name here plus a price below = an optional add-on offered once on the deposit welcome page, charged with one click to the card the buyer just used for the deposit (Whop only). Nothing is pre-ticked: the buyer presses a button that states the product, the total and the card, or presses No thanks and never sees it again. It earns no credit against the engagement fee. Refunds work like the deposit (refund in Whop and it leaves the revenue). Only offer what you deliver.' },
  { key: 'DEPOSIT_ADDON_PRICE', label: 'Deposit add-on: price', group: 'Live funnel', placeholder: '750', help: 'Between 1 and 10000, same currency as the deposit. Blank = off. Whop’s buyer service fee is added and shown on the button.' },
  { key: 'DEPOSIT_ADDON_DESCRIPTION', label: 'Deposit add-on: what it is', group: 'Live funnel', placeholder: 'Josh’s team prepares your last two years of financials into the pack lenders ask for.', help: 'One or two plain sentences shown under the name. No promised results.' },
  { key: 'DEPOSIT_ADDON_URL', label: 'Deposit add-on: delivery link (optional)', group: 'Live funnel', placeholder: 'https://…', help: 'Where buyers open it once paid (shown on their welcome page). Blank = they are told the team emails it within one business day, and Slack reminds you to deliver it.' },
  { key: 'DEPOSIT_ADDON_REFUND', label: 'Deposit add-on: refund terms', group: 'Live funnel', placeholder: 'Ask the team within 14 days and it is refunded in full to the same card.', help: 'Shown under the button. Blank = the placeholder wording.' },
  { key: 'LIVE_TICKET_PRICE', label: 'Live webinar ticket price', group: 'Live funnel', placeholder: '', help: 'Blank = registration for live webinars costs nothing. A number (for example 100) = a paid ticket: registrants pay on our Whop page right after signing up (card saved for a one-click deposit), and the room and the reminders start once it is paid. A paid ticket comes off the deposit price.' },
  { key: 'LIVE_OFFER_HOURS', label: 'Live offer deadline (hours after the event)', group: 'Live funnel', placeholder: '48', help: 'The deposit offer the host opens in a live webinar closes this many hours after the event ends (or earlier, when the host presses Close offer). The replay closes at the same moment. Blank = 48.' },
  { key: 'ENGAGEMENT_GUARANTEE', label: 'Guarantee in engagement agreements', group: 'Live funnel', placeholder: 'on', help: 'on (default) = every new engagement agreement includes the “Signed LOI in 90 days” guarantee with its conditions. off = left out. The wording is awaiting legal review.' },
  { key: 'GUARANTEE_HEADLINE', label: 'Guarantee headline (override)', group: 'Live funnel', placeholder: 'Signed LOI in 90 days, or we keep working free', help: 'Blank = the approved wording.' },
  { key: 'GUARANTEE_BODY', label: 'Guarantee wording (override)', group: 'Live funnel', placeholder: '', help: 'Blank = the approved wording: “If you don’t have a signed letter of intent within 90 days, Josh’s team keeps working with you at no extra cost until you do. Or, if you prefer, take a full refund of everything you paid.”' },
  { key: 'MONEY_BACK_BODY', label: '7-day money-back wording (override)', group: 'Live funnel', placeholder: '', help: 'Blank = the approved wording: a full refund within 7 days of signing the engagement, with no conditions. Shown next to the LOI guarantee.' },
  // ── Lifecycle (builder E: src/live/lifecycle*.ts): reminders, quiet hours, referrals ──
  { key: 'LC_QUIET_HOURS', label: 'Live reminders: quiet hours (person’s own time)', group: 'Live funnel', placeholder: '22-7', help: 'The 24 hour and 3 hour reminder emails wait until these hours end in each person’s own time zone (the 1 hour, 10 minute and live reminders always go: the session is about to start). Texts always stay inside 8am to 8pm. "off" = no quiet hours.' },
  { key: 'LC_REFERRALS', label: 'Live: “bring a business owner” referral links', group: 'Live funnel', placeholder: 'on', help: 'on (default) = every registrant gets a personal referral link on their confirmation page. off = no referral panel and no counting.' },
  { key: 'LC_REFERRAL_CAP', label: 'Live: referrals counted per person per event', group: 'Live funnel', placeholder: '10', help: 'Registrations through one person’s link beyond this still register but don’t count or earn anything. The same person, browser or connection never counts.' },
  { key: 'LC_REFERRAL_UNLOCK', label: 'Live: unlock for a referral who attends', group: 'Live funnel', placeholder: 'scripts', help: 'The asset someone unlocks when an owner they brought attends (events in our room): calculator, scripts, buybox or checklist. off = points only (ENGAGE_POINTS referral:25x5 by default).' },
  { key: 'GUARANTEE_CONDITIONS', label: 'Guarantee conditions (override, one per line)', group: 'Live funnel', placeholder: '', help: 'Blank = the approved five conditions (kickoff and financials within 7 days, weekly sessions, weekly owner outreach, replies within 2 business days, the buy box and the 1.5x test). Shown in full wherever the guarantee appears and written into the agreement.' },
  { key: 'AI_CALL_DAILY_CAP', label: 'Max AI calls per day (all leads)', group: 'Voice', placeholder: '40', help: 'A ceiling on outbound AI calls queued in any 24 hours, so a flood of fake sign-ups can’t run up a phone bill. Each number is also limited to 3 calls a week.' },
  { key: 'AI_CALL_CALLBACK_NUMBER', label: 'Callback number said on AI calls', group: 'Voice', placeholder: '+1 229 404 6271', help: 'Read out on every AI call and voicemail so people can call back (required for AI-voice calls to US numbers).' },

  // ── Funnel HQ → Command: the Chief of Staff, approvals, routines, alerts and briefs (src/ops/*) ──
  { key: 'OPS_MODEL', label: 'Command: chat model', group: 'Command', placeholder: 'claude-sonnet-5-5', help: 'The model that answers in the Command chat, runs routines and writes documents (needs the Anthropic API key under Email). Blank uses Claude Sonnet 5.5.' },
  { key: 'OPS_AUTO_KINDS', label: 'Command: actions that run without approval', group: 'Command', placeholder: 'ops.document, ops.slack_message', help: 'Comma-separated action kinds (as shown in the Approvals queue) that run straight away instead of waiting for you. Blank = every proposed action waits for Approve. Anything that spends money, sends to leads in bulk, changes ads or contacts a client should stay off this list unless you mean it.' },
  { key: 'OPS_TIMEZONE', label: 'Command: your time zone', group: 'Command', placeholder: 'Australia/Sydney', help: 'Routines, the morning brief and “yesterday” use this time zone. Blank = the sales team time zone.' },
  { key: 'OPS_BRIEF_TIME', label: 'Command: morning brief time', group: 'Command', placeholder: '07:30', help: 'HH:MM in your time zone. Posted to Slack and the Command tab every day; on Mondays it is the weekend summary. off = no brief.' },
  { key: 'OPS_MONITORS', label: 'Command: hourly alerts', group: 'Command', placeholder: 'on', help: 'on = every hour the last 24 hours and 7 days are compared with the period before for visitors, sign-ups, tickets, bookings, show rate, deals, Sprint and deposit sales and cost per lead and per booked call by campaign. off = no alerts.' },
  { key: 'OPS_ALERT_DROP_PCT', label: 'Command: alert on a drop of (%)', group: 'Command', placeholder: '30', help: 'A metric that falls by at least this much against the period before raises an alert.' },
  { key: 'OPS_ALERT_SPIKE_PCT', label: 'Command: alert on a rise of (%)', group: 'Command', placeholder: '50', help: 'A metric that rises by at least this much raises an alert (for costs, a rise is bad news).' },
  { key: 'OPS_ALERT_MIN_COUNT', label: 'Command: smallest count worth an alert', group: 'Command', placeholder: '5', help: 'Changes on fewer than this many (in either period) are ignored, so one booking more or less never pages you.' },
  { key: 'OPS_SLACK_WEBHOOK_URL', label: 'Command: Slack webhook for briefs and alerts', group: 'Command', secret: true, help: 'Optional separate channel for the brief, alerts, routine results and approvals. Blank = the team alerts webhook.' },

  { key: 'POSTHOG_KEY', label: 'PostHog project API key', group: 'Analytics', secret: true, placeholder: 'phc_…', help: 'Every event is mirrored to PostHog server-side.' },
  { key: 'POSTHOG_HOST', label: 'PostHog host', group: 'Analytics', placeholder: 'https://us.i.posthog.com' },
  { key: 'POSTHOG_SESSION_REPLAY', label: 'PostHog session replay', group: 'Analytics', placeholder: 'true', help: 'Loads posthog-js (via a first-party proxy) for recordings & heatmaps.' },
  { key: 'GA4_MEASUREMENT_ID', label: 'GA4 measurement ID', group: 'Analytics', placeholder: 'G-XXXXXXX' },
  { key: 'GA4_API_SECRET', label: 'GA4 Measurement Protocol secret', group: 'Analytics', secret: true },

  { key: 'META_PIXEL_ID', label: 'Meta Pixel ID', group: 'Ads' },
  { key: 'META_ACCESS_TOKEN', label: 'Meta Conversions API token', group: 'Ads', secret: true },
  { key: 'META_ADS_TOKEN', label: 'Meta ads token (ads_read)', group: 'Ads', secret: true, help: 'Lets Funnel HQ read ad spend per campaign. A system-user token with the ads_read permission. Leave blank to try the Conversions API token.' },
  { key: 'META_AD_ACCOUNT_ID', label: 'Meta ad account ID', group: 'Ads', placeholder: '1234567890', help: 'Pick it with “Connect ad account” on Traffic & ads.' },
  // Ads autopilot (src/marketing/autopilot.ts): every change is a proposal in Funnel HQ → Ads autopilot unless its kind is set to auto.
  { key: 'META_ADS_WRITE_TOKEN', label: 'Meta ads write token (ads_management)', group: 'Ads', secret: true, help: 'Lets approved autopilot changes reach Meta: pause an ad, move budget between ad sets, duplicate a winner, create paused ads from an angle. A system-user token with ads_management on the ad account. Without it every proposal comes with apply-manually steps.' },
  { key: 'ADS_AUTOPILOT', label: 'Ads autopilot', group: 'Ads', placeholder: 'on', help: 'on (default): read ads hourly and propose changes. off: read only, no proposals.' },
  { key: 'ADS_TARGET_CPL', label: 'Target cost per lead', group: 'Ads', placeholder: '60', help: 'In the ad account currency. Blank: not used.' },
  { key: 'ADS_TARGET_CPA_TICKET', label: 'Target cost per paid ticket', group: 'Ads', placeholder: '150', help: 'Masterclass, live webinar and challenge tickets attributed to the ad.' },
  { key: 'ADS_TARGET_CPA_DEPOSIT', label: 'Target cost per engagement deposit', group: 'Ads', placeholder: '1500' },
  { key: 'ADS_TARGET_CPA_BOOKING', label: 'Target cost per booked call', group: 'Ads', placeholder: '250', help: 'Blank: not used.' },
  { key: 'ADS_LOSER_SPEND', label: 'Spend before judging an ad', group: 'Ads', placeholder: '300', help: 'An ad that spent this much with no qualified results ($1M+ revenue band, ticket, booking or deposit) is proposed for pausing. Blank: twice the ticket target, or 300.' },
  { key: 'ADS_MAX_DAILY_SHIFT_PCT', label: 'Most budget moved per ad set per day (%)', group: 'Ads', placeholder: '20', help: 'Bounds every budget shift: no ad set gains or loses more than this share of its daily budget in one day.' },
  { key: 'ADS_MAX_DAILY_BUDGET', label: 'Highest daily budget per ad set', group: 'Ads', placeholder: '500', help: 'A shift never takes an ad set above this. Blank: no cap beyond the daily percentage.' },
  { key: 'ADS_FATIGUE_FREQUENCY', label: 'Fatigue: frequency above', group: 'Ads', placeholder: '2.5' },
  { key: 'ADS_FATIGUE_CTR_DROP_PCT', label: 'Fatigue: link CTR down by (%)', group: 'Ads', placeholder: '30', help: 'Compared with the ad’s first three days with spend.' },
  { key: 'ADS_WINNER_MIN_RESULTS', label: 'Winner: results needed', group: 'Ads', placeholder: '3', help: 'Tickets, deposits or bookings before an ad counts as a winner.' },
  { key: 'ADS_MER_FLOOR', label: 'Blended MER floor', group: 'Ads', placeholder: '1.5', help: 'Total revenue net of refunds ÷ total ad spend over the last 7 days. Under this, the autopilot does not propose duplicating winners or moving budget toward them, and says why. Blank: off.' },
  // ads2: hook rate and hold rate per video ad (weak hook, good body → hook-only variants, proposed for approval)
  { key: 'ADS_HOOK_RATE_FLOOR', label: 'Video: weak hook under (%)', group: 'Ads', placeholder: '25', help: 'Hook rate = 3-second video views ÷ impressions. Under this with a good hold rate, the autopilot proposes hook-only variants of the ad.' },
  { key: 'ADS_HOLD_RATE_GOOD', label: 'Video: good hold from (%)', group: 'Ads', placeholder: '30', help: 'Hold rate = ThruPlays ÷ 3-second views. At or above this the body is doing its job.' },
  { key: 'ADS_HOOK_MIN_IMPRESSIONS', label: 'Video: impressions before judging the hook', group: 'Ads', placeholder: '2000' },
  { key: 'ADS_PAGE_ID', label: 'Facebook Page ID for new ads', group: 'Ads', help: 'Needed to create ads from an angle with the write token.' },
  { key: 'ADS_LANDING_URL', label: 'Landing page for new ads', group: 'Ads', placeholder: 'https://live.example.com/live', help: 'Where ads made from an angle send people. Blank: the public URL.' },
  { key: 'ADS_AI_MODEL', label: 'Ad copy model', group: 'Ads', placeholder: 'claude-sonnet-5-5', help: 'Writes ad drafts from research angles (needs the Anthropic API key under Email). Blank uses a planning model.' },
  // Sales follow-up actions (src/sales/followups.ts).
  { key: 'SALES_QUIET_DAYS', label: 'Lead counts as quiet after (days)', group: 'Booking', placeholder: '5', help: 'Sales follow-up: no reply, click or page visit in this many days.' },
  { key: 'META_STAGE_EVENTS', label: 'Send webinar stage events to Meta', group: 'Ads', placeholder: 'true', help: 'Lead on each webinar, live webinar and challenge registration, plus the custom events WebinarAttended and WebinarOfferSeen (once per registration). Set to false to stop them. Consent rules still apply.' },
  // Meta audiences (src/audiences): created in Meta only after approval in Command, with the write token above.
  { key: 'META_SCHEDULE_VALUE', label: 'Send a predicted value with booked calls', group: 'Ads', placeholder: 'off', help: 'on: each Schedule event carries the expected value of a booked call for its tier (fee × show rate × close rate, from your own outcomes or the financial model), so Meta can bid on value. It is an estimate, shown in Meta audiences. Default off.' },
  // Deep-funnel signals (src/tracking/signals.ts, overnight loop round 2).
  { key: 'META_SIGNALS', label: 'Send deep-funnel signals to Meta', group: 'Ads', placeholder: 'on', help: 'on (default): custom events Watched30Min, StayedForPitch, OfferCardOpened, OfferCheckoutStarted, RoomApplicationSubmitted and EngagementSigned (offline, value = the contract fee), once per person per session, for the live rooms, the automated webinar and the challenge. Consent rules apply. off: none are sent.' },
  { key: 'META_SIGNAL_VALUES', label: 'Send estimated values with deep-funnel signals', group: 'Ads', placeholder: 'off', help: 'on: each room signal carries an estimate of what it is worth (average paid revenue that followed it in your own data once there are 50 people and 3 buyers, else the financial model), flagged predicted_value. Default off: no value. The signed contract always carries its real fee.' },
  { key: 'META_AUDIENCE_RETENTION_DAYS', label: 'Website audience retention (days)', group: 'Ads', placeholder: '180', help: 'How long someone stays in a Pixel-based audience after the event, 1 to 180.' },
  { key: 'META_AUDIENCE_SYNC', label: 'Daily customer-list resync', group: 'Ads', placeholder: 'on', help: 'on (default): once a day each customer-list audience is replaced with who is in it now, so unsubscribes, suppressions and deletions leave Meta too. off: no uploads after creation.' },
  { key: 'META_LOOKALIKE_COUNTRIES', label: 'Lookalike countries', group: 'Ads', placeholder: 'AU, US', help: 'Two-letter country codes, comma separated. Each buyer list gets a 1% and a 3% lookalike per country when you propose them.' },
  { key: 'META_AUDIENCE_EXCLUDE', label: 'Never upload to Meta', group: 'Ads', placeholder: 'friend@example.com, @yourcompany.com', help: 'Emails, phone numbers or @domains left out of every customer-list audience (team, friends, partners).' },
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

  // ── Instagram DM sales inbox (src/dm/*): Meta's official Instagram API only, never scraping ──
  { key: 'IG_APP_ID', label: 'Meta app ID', group: 'Instagram DMs', help: 'developers.facebook.com → My Apps → your app → App settings → Basic. The app needs the Instagram product with the messaging and comments permissions.' },
  { key: 'IG_APP_SECRET', label: 'Meta app secret', group: 'Instagram DMs', secret: true, help: 'Same page as the app ID. Checks that every webhook really comes from Meta (X-Hub-Signature-256).' },
  { key: 'IG_ACCESS_TOKEN', label: 'Instagram access token (long-lived)', group: 'Instagram DMs', secret: true, help: 'An Instagram User token (Instagram Login, starts with IG) or a Page / system user token (Facebook Login) with instagram_business_manage_messages or instagram_manage_messages, plus the comments permission. Long-lived Instagram User tokens last 60 days: Check renews one when it is more than a day old.' },
  { key: 'IG_ACCOUNT_ID', label: 'Instagram professional account ID', group: 'Instagram DMs', help: 'Filled in by Check when blank.' },
  { key: 'IG_WEBHOOK_VERIFY_TOKEN', label: 'Webhook verify token', group: 'Instagram DMs', secret: true, help: 'Any long random string. Paste the same value in the Meta app under Webhooks, with the callback URL <your domain>/hooks/instagram.' },
  { key: 'DM_MODEL', label: 'DM inbox AI model', group: 'Instagram DMs', placeholder: 'claude-haiku-5-5', help: 'Drafts replies, flags junk and leads about to close, writes pre-call summaries. Needs the Anthropic API key (under Email). Without it the inbox runs on rules only.' },
  { key: 'DM_AUTO_REPLY', label: 'Automated FAQ assistant', group: 'Instagram DMs', placeholder: 'off', help: 'off (default) = a setter sends every reply. on = an automated assistant answers questions covered by your FAQ scripts, inside the 24-hour window, and says it is an automated assistant in every message. Anything else waits for a setter.' },
  { key: 'DM_HUMAN_AGENT', label: 'Human agent tag (7-day replies)', group: 'Instagram DMs', placeholder: 'off', help: 'on = setters can reply up to 7 days after the person’s last message, sent with Meta’s HUMAN_AGENT tag. Switch it on only after Meta has approved the Human Agent permission for your app. Automated messages never use it.' },
  { key: 'DM_HOT_ALERT_MIN', label: 'Alert when a hot lead waits (minutes)', group: 'Instagram DMs', placeholder: '15', help: 'Slack / Discord alert when a hot lead has waited this long for a reply. 0 turns it off.' },
  { key: 'DM_DIGEST', label: 'Daily digest per setter', group: 'Instagram DMs', placeholder: 'on', help: 'At the daily digest hour: each setter gets yesterday’s results and today’s tasks in Slack (mentioned by their Slack user ID) and by email when they have one. off turns it off.' },

  { key: 'SEO_INDEXING', label: 'Show pages in Google & AI search', group: 'Search', placeholder: 'on', help: 'The landing pages, industry pages and guides are open to Google, Bing and AI assistants (ChatGPT, Claude, Perplexity, Gemini, Grok). The application, booking and personal pages never are. Type off to hide everything from search.' },
  { key: 'GOOGLE_SITE_VERIFICATION', label: 'Google Search Console code', group: 'Search', placeholder: 'abc123…', help: 'search.google.com/search-console → Add property → URL prefix → HTML tag: paste only the content="…" value. Then submit /sitemap.xml there.' },
  { key: 'BING_SITE_VERIFICATION', label: 'Bing Webmaster code', group: 'Search', placeholder: 'ABC123…', help: 'bing.com/webmasters → Add site → HTML meta tag: paste the content="…" value. Bing powers ChatGPT search and Copilot, so this matters for AI traffic.' },
  { key: 'SEO_SAME_AS', label: 'Josh’s profiles (for AI to recognise him)', group: 'Search', placeholder: 'https://www.instagram.com/officialjoshli/, https://www.youtube.com/channel/UCaJNq5_e7ognPLRqS6n-gCA', help: 'Comma-separated links to Josh’s official profiles (LinkedIn, X, YouTube, Instagram). Search engines and AI use them to connect the site to him.' },
  { key: 'X_HANDLE', label: 'X (Twitter) handle', group: 'Search', placeholder: '@officialjoshli', help: 'Shown on link previews when pages are shared on X.' },

  { key: 'VOICE_INPUT', label: 'Talk instead of type (application)', group: 'Site', placeholder: 'on', help: 'A microphone button on the application. Uses the browser’s own speech recognition; in Facebook/Instagram in-app browsers it records a short clip that Cloudflare’s own speech-to-text (Workers AI) turns into text. Audio is never stored. Type off to hide it.' },

  { key: 'BLOCKLIST', label: 'Lead blocklist', group: 'Security', placeholder: 'tyrekicker@example.com, +61400000000, @competitor.com', help: 'Emails, phone numbers or @domains that always go to the free resources page instead of a call.' },
  { key: 'CLARITY_ID', label: 'Microsoft Clarity project ID', group: 'Analytics', help: 'Free session recordings and heatmaps.' },
  { key: 'TURNSTILE_SITE_KEY', label: 'Turnstile site key', group: 'Security', help: 'Invisible bot check on the public forms (application, masterclass, live and challenge registration, room join link). Works only with Bot protection mode set to log or enforce.' },
  { key: 'TURNSTILE_SECRET_KEY', label: 'Turnstile secret key', group: 'Security', secret: true },
  { key: 'CONSENT_REQUIRED_EU', label: 'Cookie consent for EU visitors', group: 'Security', placeholder: 'true' },
  { key: 'IP_ANONYMIZE', label: 'Store hashed IPs only', group: 'Security', placeholder: 'false' },

  { key: 'RESEARCH_ENABLED', label: 'Research: daily collection', group: 'Research', placeholder: 'on', help: 'on (default) = once a day Funnel HQ reads Reddit, the Meta Ad Library, YouTube and your own leads’ answers in small slices, then finds themes and drafts angles. off = only when you press Collect now in Research.' },
  { key: 'RESEARCH_MODEL', label: 'Research: analysis model', group: 'Research', placeholder: 'claude-sonnet-5-5', help: 'Clusters complaints and desires, reads competitor offers and drafts angles (needs the Anthropic API key under Email). Without the key the raw data is still collected and grouped by rules.' },
  { key: 'RESEARCH_HOUR', label: 'Research: collection starts at (hour, sales time zone)', group: 'Research', placeholder: '2' },
  { key: 'RESEARCH_BRIEF_DAY', label: 'Research: weekly brief day', group: 'Research', placeholder: 'Mon', help: 'The research brief goes to Slack / Discord and the action log on this day. off = no brief.' },
  { key: 'RESEARCH_BRIEF_HOUR', label: 'Research: weekly brief hour (0 to 23)', group: 'Research', placeholder: '9' },
  { key: 'RESEARCH_SUBREDDITS', label: 'Research: subreddits', group: 'Research', placeholder: 'smallbusiness, Entrepreneur, sweatystartup, fatFIRE, acquisitions, smallbusinessowner, consulting, HVAC, Plumbing, dentistry, msp, Accounting', help: 'Comma separated, without r/. Blank = the list shown. Add the subreddits of the industries you sell to.' },
  { key: 'RESEARCH_KEYWORDS', label: 'Research: Reddit searches', group: 'Research', placeholder: 'buy a business, acquisition, SBA loan, seller financing, succession, exit', help: 'Comma separated. Blank = the list shown.' },
  { key: 'REDDIT_CLIENT_ID', label: 'Reddit app client ID', group: 'Research', help: 'Optional. reddit.com/prefs/apps → create app (type “script” or “web app”). With it, Funnel HQ reads through Reddit’s OAuth API. Without it, the public .json pages are read slowly with a descriptive User-Agent.' },
  { key: 'REDDIT_CLIENT_SECRET', label: 'Reddit app secret', group: 'Research', secret: true },
  { key: 'REDDIT_USERNAME', label: 'Reddit username (for the User-Agent)', group: 'Research', placeholder: 'your_reddit_name', help: 'Reddit asks every API client to name a contact in its User-Agent.' },
  { key: 'META_AD_LIBRARY_TOKEN', label: 'Meta Ad Library token', group: 'Research', secret: true, help: 'A token from an app with Ad Library API access (facebook.com/ads/library/api → confirm your identity). Blank = the Meta ads token above is tried.' },
  { key: 'RESEARCH_COMPETITORS', label: 'Research: competitor advertisers', group: 'Research', placeholder: 'Brand name|123456789012345, Another brand', help: 'Comma separated. Each is a Facebook page name, or name|page ID for an exact match (the page ID is in the page’s About → Page transparency).' },
  { key: 'RESEARCH_AD_KEYWORDS', label: 'Research: Ad Library searches', group: 'Research', placeholder: 'buy a business, business acquisition, seller financing, acquire a company', help: 'Comma separated. Blank = the list shown.' },
  { key: 'RESEARCH_AD_COUNTRIES', label: 'Research: ad countries', group: 'Research', placeholder: 'US, GB, AU, IE', help: 'Two-letter codes. Meta’s Ad Library API returns commercial ads only where they reached the UK or the EU, so keep GB or an EU country in the list.' },
  { key: 'RESEARCH_YT_QUERIES', label: 'Research: YouTube searches', group: 'Research', placeholder: 'buy a business, business acquisition, ETA search fund, seller financing, SBA 7a loan', help: 'Comma separated. Needs the YouTube Data API key under Content.' },
  // ── Clients & support, Claude (MCP) and Zapier (builder E: src/clients, src/support, src/mcp, src/integrations/webhooks-out.ts) ──
  { key: 'CS_AI_MODEL', label: 'Client check-in model', group: 'Clients & support', placeholder: 'claude-sonnet-5-5', help: 'Drafts client check-ins in the team’s voice (needs the Anthropic API key under Email). Blank uses Claude Sonnet. Without a key, check-ins use the built-in template.' },
  { key: 'CS_DAILY_HOUR', label: 'Daily client health run (hour)', group: 'Clients & support', placeholder: '7', help: 'Local hour (sales team time zone) when health scores are rebuilt and due check-ins are drafted for approval.' },
  { key: 'SUPPORT_AI_MODEL', label: 'Support answer model', group: 'Clients & support', placeholder: 'claude-sonnet-5-5', help: 'Drafts answers to support emails and room questions from our own guides, materials, the guarantee, the FAQ and the offer terms, with citations. Blank uses Claude Sonnet.' },
  { key: 'SUPPORT_MIN_CONFIDENCE', label: 'Support: confidence needed to skip escalation', group: 'Clients & support', placeholder: '0.7', help: 'Drafts below this confidence (0 to 1) go to a person. Anything about money, refunds, payments or legal always goes to a person.' },
  { key: 'SUPPORT_FROM', label: 'Support: reply From address', group: 'Clients & support', placeholder: 'G&L Support <support@mail.example.com>', help: 'Blank uses the From address under Email.' },
  { key: 'SUPPORT_INBOUND_SECRET', label: 'Support: forwarding secret', group: 'Clients & support', secret: true, help: 'Shared secret for POST /hooks/support-email (a forwarder such as Zapier, Make or a Cloudflare Email Worker sends it in the X-Support-Secret header).' },
  { key: 'SUPPORT_RESEND_WEBHOOK_SECRET', label: 'Support: Resend inbound webhook secret', group: 'Clients & support', secret: true, placeholder: 'whsec_…', help: 'Filled in by “Connect support inbox” (Funnel HQ → Support). Resend → Webhooks, endpoint <your domain>/hooks/resend-inbound, event email.received.' },
  { key: 'MCP_TOKEN', label: 'Claude connector (MCP) token', group: 'Clients & support', secret: true, help: 'Bearer token for the MCP server at /mcp. Use “Generate new token” under Integrations → Claude (MCP); generating a new one stops the old one at once.' },
  { key: 'MCP_ALLOWED_ORIGINS', label: 'MCP: extra allowed browser origins', group: 'Clients & support', placeholder: 'https://claude.ai', help: 'Requests that carry an Origin header must come from this site, claude.ai or claude.com, or one listed here (comma separated). Requests without an Origin (Claude Code, Claude Desktop, claude.ai connectors) only need the token.' },
  { key: 'ZAPIER_INBOUND_SECRET', label: 'Zapier: inbound action secret', group: 'Clients & support', secret: true, help: 'Shared secret for POST /hooks/zapier/create-lead and /hooks/zapier/add-note (header X-Zapier-Secret).' },
  // ───────────── infra (overnight round 1): the internal error log ─────────────
  { key: 'ERRORS_SLACK', label: 'Errors: ping Slack on a new kind of error', group: 'Alerts', placeholder: 'off', help: 'on = the first time a new error shows up (Funnel HQ → Errors & cron) the Command Slack channel gets one message, at most 5 an hour. Blank or off = no pings; errors are still logged.' },
  // ───────────── Cloudflare platform round, builder B: Turnstile (src/infra/turnstile.ts) and Analytics Engine (src/infra/analytics-engine.ts) ─────────────
  { key: 'TURNSTILE_MODE', label: 'Bot protection mode (Turnstile)', group: 'Security', placeholder: 'off', help: 'off (default) = nothing loads. log = the invisible check runs on the public forms and results are counted (Errors & cron → Bot protection), nothing is refused. enforce = a failed check is refused with a calm message and the form keeps what was typed. If Cloudflare can’t be reached, forms always go through. Needs both Turnstile keys.' },
  { key: 'ANALYTICS_ENGINE', label: 'Analytics Engine: copy events', group: 'Analytics', placeholder: 'off', help: 'on = every first-party tracking event and room quality report is also written to Cloudflare Analytics Engine (dataset gl_events), next to the database. off (default) = database only.' },
  { key: 'CF_ACCOUNT_ID', label: 'Cloudflare account ID', group: 'Analytics', placeholder: '0123456789abcdef0123456789abcdef', help: 'For reading Analytics Engine back into Funnel HQ (Errors & cron → Events) and for the AI Gateway (blank = the account this funnel runs in). dash.cloudflare.com → your account → the ID on the right of the overview.' },
  { key: 'CF_ANALYTICS_TOKEN', label: 'Cloudflare API token (Analytics read)', group: 'Analytics', secret: true, help: 'A token with Account → Account Analytics → Read. Used only to read the Analytics Engine events back.' },
  // ───────────── Cloudflare round, builder C: Vectorize (AI search) and AI Gateway ─────────────
  { key: 'VECTOR_SEARCH', label: 'AI search (Vectorize)', group: 'AI & search', placeholder: 'off', help: 'on = every few minutes, in small batches, lead answers, room questions and objections, call notes and Josh’s approved material are turned into embeddings (Workers AI) and kept in the Vectorize index gl-knowledge. Turns on “Similar leads” in the lead drawer, “Leads like my buyers” and the search box on Leads. Off (default) = nothing is indexed and those panels say so.' },
  { key: 'ROOM_AI_HELPER', label: 'Room Q&A: AI draft button for staff', group: 'AI & search', placeholder: 'off', help: 'on = hosts and co-hosts see “AI draft” on each question in a room’s Q&A. It drafts an answer from Josh’s approved material only (scripts, guides, the guarantee, offer terms), labelled as AI-drafted. Nothing is posted until a person edits it and presses Send. Needs the Anthropic API key (Email).' },
  { key: 'AI_GATEWAY_ID', label: 'Cloudflare AI Gateway id', group: 'AI & search', placeholder: 'default', help: 'Blank = Claude is called directly, as before. Set (e.g. default) = every Claude call goes through your Cloudflare AI Gateway, tagged by feature, so cost, speed and errors per feature show in the Cloudflare dashboard. If the gateway fails, the call goes direct.' },
  // ───────────── Cloudflare platform round, builder A: Queues and Workflows (both off by default) ─────────────
  { key: 'SEND_VIA_QUEUE', label: 'Send queue: send emails, texts, AI calls and tracking through Cloudflare Queues', group: 'Alerts', placeholder: 'off', help: 'on = the cron and the pages hand due emails, texts, AI call dials and Meta/GA4/PostHog forwards to the gl-send queue, which sends each one with retries and backoff; messages that keep failing land in the dead-letter queue and show in Funnel HQ → Errors & cron with a Retry button. The same rules decide who gets what and when. Blank or off = everything sends inline, as before.' },
  { key: 'LIVE_REMINDERS_VIA_WORKFLOW', label: 'Live reminders: drive each registration with a durable workflow', group: 'Alerts', placeholder: 'off', help: 'on = each new live webinar registration starts a Cloudflare Workflow that sends its reminders (24h, 3h, 1h, 10 min, live, missed, replay) at their moments, with the same quiet hours, cadence, caps, consent and stop rules; the 5-minute cron skips registrations whose workflow is running and picks them up again if one stops. Blank or off = the cron sends them, as before.' },
  // ── Cloudflare round, builder D: Workers KV settings cache, Browser Rendering (PDFs, funnel watchdog), Stream ──
  { key: 'KV_CACHE', label: 'Settings cache in Workers KV', group: 'Site', placeholder: 'off', help: 'on = every request reads these settings from Workers KV (binding CACHE, kept 60 seconds) instead of the database; every save here clears it at once. off (default) = read from the database as before.' },
  { key: 'PDF_RENDER', label: 'Download PDF (Deal Plan and signed agreements)', group: 'Contracts', placeholder: 'off', help: 'on = the Deal Plan page and the signed agreement get a Download PDF link, rendered by Cloudflare Browser Rendering and kept in R2 under pdf/. off (default) = the page’s own print / save as PDF stays the only way.' },
  { key: 'WATCHDOG', label: 'Funnel watchdog (hourly browser check)', group: 'Alerts', placeholder: 'off', help: 'on = once an hour a real browser opens the home page, the application, the live landing page, the masterclass and a room’s join page, and checks each renders with no page errors and its main button. Results show in Funnel HQ → Errors & cron; failures go to the error log, and to the Command Slack channel when one is connected. Needs the Public URL under Site. off (default) = no checks.' },
  { key: 'STREAM_ACCOUNT_TOKEN', label: 'Cloudflare Stream API token', group: 'Video', secret: true, help: 'A Cloudflare API token with Stream: Edit. With it, Funnel HQ → Rooms can send a finished recording to Stream, and that replay then plays through Stream (adaptive quality, better on phones). Blank = off: replays play the recording file as before.' },
  { key: 'STREAM_ACCOUNT_ID', label: 'Cloudflare account ID (for Stream)', group: 'Video', placeholder: '50e9fc42a7947d3f932cd1ed0bf95c03', help: 'Blank uses the account shown.' },
  { key: 'STREAM_CUSTOMER_CODE', label: 'Stream customer subdomain code', group: 'Video', placeholder: 'abc123xyz', help: 'Optional: the code in customer-<code>.cloudflarestream.com (Stream → any video → Embed). Used when a video setting holds only a Stream video ID. Blank = videodelivery.net links.' },
  // ── Studio, builder C: Scripts (src/studio/scripts.ts, src/studio/copy-brain.ts) ──
  { key: 'STUDIO_SCRIPT_CTA', label: 'Scripts: the call to action', group: 'Studio', placeholder: 'Apply through the link below. If it’s a fit, the team books a strategy call to look at your numbers.', help: 'The last line of every generated face-cam script. Blank = the line shown (webinar teasers ask to register for the live session). Never call the call “free”.' },
  { key: 'STUDIO_SCRIPT_NOTES', label: 'Scripts: standing notes for the writer', group: 'Studio', help: 'Anything every script should follow, in plain words (a phrase you always use, a topic to avoid). Only true facts: the writer may use nothing as proof beyond the facts it already has.' },
  // ───────────── G&L Studio (src/studio): screen recordings, the Drive folder, the 6-hour loop and the automatic editor ─────────────
  { key: 'STUDIO_DRIVE_FOLDER_ID', label: 'Studio: Google Drive folder', group: 'Studio', placeholder: '1b7U_deRnqGYy-suFJJDcmNANmnG8Xf4p', help: 'The folder recordings go to and are picked up from (the id at the end of the folder link). Blank = the YOUFUCK folder. Needs Google connected with full Drive access (press Connect Google Drive again after this update).' },
  { key: 'STUDIO_AUTO_EDIT', label: 'Studio: edit new recordings automatically', group: 'Studio', placeholder: 'on', help: 'on (default) = every new recording, and every new video found in the Drive folder, is transcribed, planned, rendered at the source resolution and put back in the folder. off = they wait in Studio until you press Edit.' },
  { key: 'STUDIO_SCAN_HOURS', label: 'Studio: check the Drive folder every (hours)', group: 'Studio', placeholder: '6', help: 'How often the folder is checked for videos added by hand. 1 to 48. Check now is on the Studio page.' },
  { key: 'STUDIO_CAPTIONS', label: 'Studio: burned-in captions', group: 'Studio', placeholder: 'on', help: 'on (default) = the edit carries captions from the transcript (white with a navy edge). off = no captions.' },
  { key: 'STUDIO_SHORTS', label: 'Studio: vertical shorts', group: 'Studio', placeholder: 'on', help: 'on (default) = up to 3 vertical clips (9:16, up to 1080x1920) are cut from each edit, highlight markers first, and saved next to it.' },
  { key: 'STUDIO_PRESET', label: 'Studio: encoder speed', group: 'Studio', placeholder: 'medium', help: 'x264 preset for the edit: veryfast, faster, fast, medium (default) or slow. Faster presets finish 4K sooner with bigger files; quality is held by CRF 18 either way.' },
  { key: 'STUDIO_AI_MODEL', label: 'Studio: edit planner model', group: 'Studio', placeholder: 'blank = default', help: 'The Claude model that plans each edit (needs the Anthropic API key). Blank = Claude Sonnet. Without a key the plan comes from Workers AI.' },
  // ───────────── Radar (src/radar): top performing videos and Meta ads through Monid, analysed for G&L ─────────────
  { key: 'MONID_API_KEY', label: 'Radar: Monid API key', group: 'Radar', secret: true, placeholder: 'monid_…', help: 'monid.ai → API keys. Radar uses Monid to search YouTube, TikTok, Instagram, X, LinkedIn, Reddit, Substack and the Meta Ad Library and to fetch transcripts. Every run is paid from the Monid account, so the monthly budget below is a hard stop.' },
  { key: 'RADAR_BUDGET_USD_MONTH', label: 'Radar: monthly budget (USD)', group: 'Radar', placeholder: '60', help: 'Radar stops starting runs once this month’s Monid spend (billed, plus the estimate of runs still going) reaches this. Blank = 60. A full sweep of every radar costs about $1 to $2 at the listed prices (Sources and sweeps shows the estimate before it runs), so a daily sweep stays near $45 a month.' },
  { key: 'RADAR_MAX_ITEMS', label: 'Radar: results per search', group: 'Radar', placeholder: '15', help: 'How many videos or ads each search asks for. Most tools charge per result. 1 to 100, blank = 15.' },
  { key: 'RADAR_INSTAGRAM', label: 'Radar: Instagram', group: 'Radar', placeholder: 'on', help: 'on (default). Owner-approved on 2026-11-05 for research on public reels only: keyword search and transcripts of public reels through Monid, with no logins and no DMs. off = no Instagram source and no Instagram run starts.' },
  { key: 'RADAR_SCHEDULE_HOURS', label: 'Radar: run every (hours)', group: 'Radar', placeholder: '24', help: 'Hours between the automatic runs of each radar, subreddit and publication. 0 = only when you press Run or Full sweep. Blank = 24.' },
  { key: 'RADAR_PAGES', label: 'Radar: pages per search', group: 'Radar', placeholder: '2', help: 'How many result pages each search reads (the next page is fetched only when the first one found something). 1 to 10, blank = 2. Each page is billed like the first.' },
  { key: 'RADAR_AUTO_TRANSCRIBE', label: 'Radar: videos transcribed after each sweep', group: 'Radar', placeholder: '30', help: 'After a sweep, the best new videos by score are transcribed automatically, taking turns across YouTube, TikTok and Instagram, within the budget. 0 = off. Blank = 30. Text posts need no transcript: their full text is kept.' },
  { key: 'RADAR_EXTRACT_PER_SWEEP', label: 'Radar: formats read per analysis run', group: 'Radar', placeholder: '60', help: 'How many top performers without a format the analysis reads in one run (best scores first). Each is one model call. 0 to 400, blank = 60.' },
  { key: 'RADAR_ADAPT_TOP', label: 'Radar: formats adapted per run', group: 'Radar', placeholder: '5', help: 'How many of the top viral formats each analysis run adapts for G&L (beat by beat, hooks and a Studio script, checked by a blind judge). 0 to 12, blank = 5.' },
  { key: 'RADAR_PIPELINE_HOURS', label: 'Radar: run the analysis every (hours)', group: 'Radar', placeholder: '24', help: 'The cron starts the analysis (transcripts, formats, clusters, adaptations) after a sweep has finished, with at least this many hours between runs. 0 = only when you press Run analysis. Blank = 24.' },
] as const;

export type SettingKey = (typeof SETTINGS)[number]['key'];
export type Settings = Record<SettingKey, string>;

const KEYS = new Set<string>(SETTINGS.map((s) => s.key));
export const isSettingKey = (k: string): k is SettingKey => KEYS.has(k);

let cache: { at: number; db: Record<string, string> } | null = null;
const TTL_MS = 15_000;

/**
 * Workers KV tier (setting KV_CACHE, off by default; binding CACHE). Behind this isolate's 15-second memory cache,
 * the dashboard settings are read from one KV key (kept KV_SETTINGS_TTL_S) instead of D1. Every saveSettings deletes
 * the key, so a change shows on the next request in this location and everywhere within the TTL.
 * KV is only touched once this isolate has seen the setting on (from D1, KV or a Worker var): with it off or the
 * binding missing, reads are exactly what they were. Only SETTINGS keys are cached; values are never logged.
 */
export const KV_SETTINGS_KEY = 'settings:v1';
export const KV_SETTINGS_TTL_S = 60;
let kvKnownOn = false;
const kvFlag = (env: Env, db: Record<string, string> | null) => {
  const fromEnv = (env as unknown as Record<string, string | undefined>).KV_CACHE?.trim();
  return flag(fromEnv || db?.KV_CACHE);
};
type KvBlob = { on: true; at: number; db: Record<string, string> };

async function dbSettings(env: Env): Promise<Record<string, string>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.db;
  const kv = env.CACHE;
  if (kv && (kvKnownOn || kvFlag(env, null))) {
    const hit = await kv.get<KvBlob>(KV_SETTINGS_KEY, 'json').catch(() => null);
    if (hit && hit.on === true && hit.db && typeof hit.db === 'object') {
      cache = { at: Date.now(), db: hit.db };
      return hit.db;
    }
  }
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  const db = Object.fromEntries(results.map((r) => [r.key, r.value]));
  cache = { at: Date.now(), db };
  kvKnownOn = kvFlag(env, db);
  if (kv && kvKnownOn) {
    const only = Object.fromEntries(Object.entries(db).filter(([k]) => KEYS.has(k)));
    await kv.put(KV_SETTINGS_KEY, JSON.stringify({ on: true, at: Date.now(), db: only } satisfies KvBlob), { expirationTtl: KV_SETTINGS_TTL_S }).catch((e) => console.error('settings KV write failed', e instanceof Error ? e.name : 'error'));
  }
  return db;
}

/** Drops this isolate's copy and the KV copy (every location sees the delete within the TTL). */
export async function invalidateSettingsCache(env: Pick<Env, 'CACHE'>) {
  cache = null;
  if (env.CACHE) await env.CACHE.delete(KV_SETTINGS_KEY).catch((e) => console.error('settings KV delete failed', e instanceof Error ? e.name : 'error'));
}
/** Tests only. */
export function resetSettingsCache() { cache = null; kvKnownOn = false; }

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
  await invalidateSettingsCache(env);
}

function mask(v: string) {
  if (!v) return '';
  return v.length < 16 ? '•••• (set)' : `••••${v.slice(-4)}`;
}

export const flag = (v: string | undefined, dflt = false) => (v ? /^(1|true|yes|on)$/i.test(v.trim()) : dflt);
