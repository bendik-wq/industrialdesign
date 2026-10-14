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
  group: 'Site' | 'Video' | 'Booking' | 'Email' | 'WhatsApp' | 'Voice' | 'Analytics' | 'Ads' | 'Alerts' | 'Security' | 'Webinar' | 'SMS' | 'Data';
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
  { key: 'EMAIL_REPLY_TO', label: 'Reply-to address', group: 'Email' },
  { key: 'EMAIL_SIGNATURE', label: 'Email signature name', group: 'Email', placeholder: 'Josh' },
  { key: 'PRECALL_EMAILS_PER_DAY', label: 'Pre-call emails: most in one day', group: 'Email', placeholder: '12', help: 'Booked leads get a run of pre-call emails, spread over 7am–9pm their time until 3 hours before the call, at least 45 minutes apart. This caps any one day. 0 turns the run off.' },
  { key: 'PRECALL_EMAILS_MIN', label: 'Pre-call emails: at least', group: 'Email', placeholder: '10', help: 'Even a call booked for tomorrow gets this many (when the time allows).' },
  { key: 'PRECALL_EMAILS_MAX', label: 'Pre-call emails: at most', group: 'Email', placeholder: '20', help: 'Calls booked further out get up to this many, spread thinner.' },
  { key: 'EMAIL_PERSONALIZE', label: 'Personalise every email', group: 'Email', placeholder: 'ai', help: 'ai = Claude rewrites each email around what that person did on the site (needs the Anthropic key). rules = a personal opening line, no AI. off = templates as written.' },
  { key: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', group: 'Email', secret: true, placeholder: 'sk-ant-…', help: 'console.anthropic.com → API keys. Used only to personalise emails.' },
  { key: 'EMAIL_AI_MODEL', label: 'Email personalisation model', group: 'Email', placeholder: 'claude-opus-5-5', help: 'Leave blank for Claude Opus 5.5.' },
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
  { key: 'WEBINAR_TITLE', label: 'Webinar title', group: 'Webinar', placeholder: 'The No-Money-Down Acquisition Masterclass', help: 'Shown on the registration page, the room and the emails.' },
  { key: 'WEBINAR_SCHEDULE', label: 'Weekly sessions', group: 'Webinar', placeholder: 'Tue 19:00, Thu 12:00', help: 'Recurring session times in the sales time zone (days: Mon–Sun, 24h clock). Sessions are created two weeks ahead. Add one-off or live sessions on the Webinar tab.' },
  { key: 'WEBINAR_VIDEO_SRC', label: 'Webinar recording (MP4 / HLS URL)', group: 'Webinar', placeholder: 'https://…/webinar.mp4', help: 'Played in sync in the webinar room for scheduled (recorded) sessions, and as the replay. Until it’s set, the main VSL is used as a placeholder.' },
  { key: 'WEBINAR_STREAM_HLS', label: 'Live stream playback URL (Cloudflare Stream)', group: 'Webinar', placeholder: 'https://customer-xxxx.cloudflarestream.com/<live input id>/manifest/video.m3u8', help: 'For “Live in our room” sessions. Cloudflare dashboard → Stream → Live inputs → your input → HLS playback URL. Stream into it from OBS, StreamYard or Zoom (Live on custom streaming service) using the RTMPS URL + key shown there.' },
  { key: 'WEBINAR_DURATION_MIN', label: 'Webinar length (minutes)', group: 'Webinar', placeholder: '60', help: 'When the session counts as finished and the replay opens.' },
  { key: 'WEBINAR_PITCH_AT', label: 'Offer appears at (minutes in)', group: 'Webinar', placeholder: '45', help: 'When the “See if you qualify” button appears in the room.' },
  { key: 'WEBINAR_REPLAY_HOURS', label: 'Replay available for (hours)', group: 'Webinar', placeholder: '48', help: 'After this the replay link shows the next session instead. The emails say the same number.' },
  { key: 'AI_CALL_DAILY_CAP', label: 'Max AI calls per day (all leads)', group: 'Voice', placeholder: '40', help: 'A ceiling on outbound AI calls queued in any 24 hours, so a flood of fake sign-ups can’t run up a phone bill. Each number is also limited to 3 calls a week.' },
  { key: 'AI_CALL_CALLBACK_NUMBER', label: 'Callback number said on AI calls', group: 'Voice', placeholder: '+1 229 404 6271', help: 'Read out on every AI call and voicemail so people can call back (required for AI-voice calls to US numbers).' },

  { key: 'POSTHOG_KEY', label: 'PostHog project API key', group: 'Analytics', secret: true, placeholder: 'phc_…', help: 'Every event is mirrored to PostHog server-side.' },
  { key: 'POSTHOG_HOST', label: 'PostHog host', group: 'Analytics', placeholder: 'https://us.i.posthog.com' },
  { key: 'POSTHOG_SESSION_REPLAY', label: 'PostHog session replay', group: 'Analytics', placeholder: 'true', help: 'Loads posthog-js (via a first-party proxy) for recordings & heatmaps.' },
  { key: 'GA4_MEASUREMENT_ID', label: 'GA4 measurement ID', group: 'Analytics', placeholder: 'G-XXXXXXX' },
  { key: 'GA4_API_SECRET', label: 'GA4 Measurement Protocol secret', group: 'Analytics', secret: true },

  { key: 'META_PIXEL_ID', label: 'Meta Pixel ID', group: 'Ads' },
  { key: 'META_ACCESS_TOKEN', label: 'Meta Conversions API token', group: 'Ads', secret: true },
  { key: 'META_TEST_EVENT_CODE', label: 'Meta test event code', group: 'Ads', help: 'Only while testing in Events Manager. Clear it before going live.' },

  { key: 'SLACK_WEBHOOK_URL', label: 'Slack webhook — team alerts', group: 'Alerts', secret: true, help: 'Hot leads, bookings, call-starting pings, no-shows, daily digest. Slack → Apps → Incoming Webhooks.' },
  { key: 'SLACK_WINS_WEBHOOK_URL', label: 'Slack webhook — closed deals', group: 'Alerts', secret: true, help: 'Optional separate #wins channel. Falls back to the alerts channel.' },
  { key: 'DISCORD_WEBHOOK_URL', label: 'Discord webhook — team alerts', group: 'Alerts', secret: true, help: 'Channel settings → Integrations → Webhooks → New webhook → Copy URL.' },
  { key: 'DISCORD_WINS_WEBHOOK_URL', label: 'Discord webhook — closed deals', group: 'Alerts', secret: true, help: 'Optional separate #wins channel. Falls back to the alerts channel.' },
  { key: 'SALES_TIMEZONE', label: 'Sales team time zone', group: 'Alerts', placeholder: 'Australia/Sydney', help: 'Used for the daily digest and call times in alerts.' },
  { key: 'DIGEST_HOUR', label: 'Daily digest hour (0–23)', group: 'Alerts', placeholder: '8', help: 'When the daily sales summary is posted. Leave blank for 8am.' },
  { key: 'LEAD_WEBHOOK_URL', label: 'CRM webhook (Zapier / Make / GHL)', group: 'Alerts', secret: true, help: 'Receives every lead lifecycle event as JSON.' },

  { key: 'DATA_URL', label: 'Data page address', group: 'Data', placeholder: 'https://data.grosfjeld-li.com', help: 'Where the data-buyer page lives. Blank: /data on this domain.' },
  { key: 'DATA_REFERRAL_URL', label: 'Partner referral link', group: 'Data', placeholder: 'https://…', help: 'Where people go after claiming their valuation. Blank: we keep their details and you follow up by hand.' },
  { key: 'DATA_PARTNER', label: 'Partner name', group: 'Data', placeholder: 'micro1', help: 'Shown on the page. Only use a partner name you have permission to use.' },
  { key: 'DATA_FUND_LINE', label: 'Committed budget', group: 'Data', placeholder: '$1 billion', help: 'As in “recently had $1 billion committed to buying data”. Must be accurate.' },
  { key: 'DATA_HEADLINE_TEST', label: 'Headline test', group: 'Data', placeholder: 'auto', help: 'auto = traffic shifts to the headlines that get claims; even = equal split; or a headline id (e.g. debt) to show it to everyone. Set from Funnel HQ → Data page.' },
  { key: 'DATA_VIDEO_SRC', label: 'Data page video', group: 'Data', placeholder: 'YouTube / Vimeo / Loom link, or an .mp4 / .m3u8 URL' },

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
