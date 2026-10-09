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
  group: 'Site' | 'Video' | 'Booking' | 'Email' | 'WhatsApp' | 'Voice' | 'Analytics' | 'Ads' | 'Alerts' | 'Security';
  secret?: boolean;
  placeholder?: string;
  help?: string;
}

export const SETTINGS = [
  { key: 'SITE_NAME', label: 'Brand name', group: 'Site', placeholder: 'G&L M&A Advisory' },
  { key: 'PUBLIC_URL', label: 'Public URL', group: 'Site', placeholder: 'https://apply.example.com', help: 'Used for links in emails and WhatsApp. Defaults to the request origin.' },

  { key: 'VSL_MAIN_SRC', label: 'Main VSL video (MP4 or HLS .m3u8)', group: 'Video', placeholder: 'https://customer-xxx.cloudflarestream.com/<uid>/manifest/video.m3u8', help: 'Cloudflare Stream HLS URLs work best.' },
  { key: 'VSL_MAIN_POSTER', label: 'Main VSL poster image', group: 'Video' },
  { key: 'VSL_BREAKOUT_SRC', label: 'Breakout VSL (part 2) video', group: 'Video' },
  { key: 'VSL_BREAKOUT_POSTER', label: 'Breakout VSL poster image', group: 'Video' },
  { key: 'VSL_PRECALL_SRC', label: 'Pre-call video (shown after booking)', group: 'Video', help: 'Falls back to the breakout video.' },

  { key: 'BOOKING_URL_A', label: 'A-tier calendar (closer)', group: 'Booking', placeholder: 'https://calendly.com/you/strategy-call' },
  { key: 'BOOKING_URL_B', label: 'B-tier calendar (setter)', group: 'Booking', placeholder: 'https://calendly.com/team/discovery-call' },
  { key: 'CALENDLY_SIGNING_KEY', label: 'Calendly webhook signing key', group: 'Booking', secret: true, help: 'Confirms bookings server-side via /hooks/calendly.' },
  { key: 'BOOKING_WEBHOOK_SECRET', label: 'Generic booking webhook secret', group: 'Booking', secret: true, help: 'For Cal.com / GHL / Zapier: POST to /hooks/booking?secret=…' },

  { key: 'RESEND_API_KEY', label: 'Resend API key', group: 'Email', secret: true, placeholder: 're_…', help: 'Create at resend.com → API Keys. Verify your sending domain first.' },
  { key: 'EMAIL_FROM', label: 'From address', group: 'Email', placeholder: 'Josh Li <josh@mail.example.com>' },
  { key: 'EMAIL_REPLY_TO', label: 'Reply-to address', group: 'Email' },
  { key: 'EMAIL_SIGNATURE', label: 'Email signature name', group: 'Email', placeholder: 'Josh' },
  { key: 'BUSINESS_ADDRESS', label: 'Business postal address', group: 'Email', help: 'Shown in the email footer (required by anti-spam law).' },

  { key: 'JOSH_WHATSAPP', label: "Josh's WhatsApp number", group: 'WhatsApp', placeholder: '61400000000', help: 'International format, digits only. Powers every "Message Josh" button.' },
  { key: 'WHATSAPP_TOKEN', label: 'WhatsApp Cloud API token', group: 'WhatsApp', secret: true, help: 'Optional: sends the resources template automatically and links inbound chats to leads.' },
  { key: 'WHATSAPP_PHONE_NUMBER_ID', label: 'WhatsApp phone number ID', group: 'WhatsApp' },
  { key: 'WHATSAPP_RESOURCES_TEMPLATE', label: 'Resources template name', group: 'WhatsApp', placeholder: 'free_resources' },
  { key: 'WHATSAPP_VERIFY_TOKEN', label: 'Webhook verify token', group: 'WhatsApp', secret: true },
  { key: 'WHATSAPP_APP_SECRET', label: 'Meta app secret (webhook signatures)', group: 'WhatsApp', secret: true },

  { key: 'VAPI_API_KEY', label: 'Vapi private API key', group: 'Voice', secret: true, help: 'vapi.ai → API Keys. Used to create/update the assistant from this dashboard.' },
  { key: 'VAPI_PUBLIC_KEY', label: 'Vapi public key', group: 'Voice', help: 'Lets applicants talk to the assistant in their browser. Restrict it to your domain in Vapi.' },
  { key: 'VAPI_ASSISTANT_ID', label: 'Vapi assistant ID', group: 'Voice', help: 'Filled in automatically when you press “Create / update assistant”.' },
  { key: 'VOICE_WEBHOOK_SECRET', label: 'Voice webhook secret', group: 'Voice', secret: true, help: 'Any long random string. Vapi sends it as x-vapi-secret on every webhook.' },
  { key: 'VOICE_PHONE_NUMBER', label: 'Inbound phone number', group: 'Voice', placeholder: '+61 2 0000 0000', help: 'Your Vapi number. Shown as “call us” on /book and /breakout. Point its Server URL at /hooks/voice.' },
  { key: 'VOICE_MODEL', label: 'Assistant LLM (provider:model)', group: 'Voice', placeholder: 'openai:gpt-4o' },
  { key: 'VOICE_VOICE', label: 'Assistant voice (provider:voiceId)', group: 'Voice', placeholder: 'vapi:Elliot' },
  { key: 'VOICE_WEB_ENABLED', label: 'Show “talk now” browser calls', group: 'Voice', placeholder: 'true' },

  { key: 'POSTHOG_KEY', label: 'PostHog project API key', group: 'Analytics', secret: true, placeholder: 'phc_…', help: 'Every event is mirrored to PostHog server-side.' },
  { key: 'POSTHOG_HOST', label: 'PostHog host', group: 'Analytics', placeholder: 'https://us.i.posthog.com' },
  { key: 'POSTHOG_SESSION_REPLAY', label: 'PostHog session replay', group: 'Analytics', placeholder: 'true', help: 'Loads posthog-js (via a first-party proxy) for recordings & heatmaps.' },
  { key: 'GA4_MEASUREMENT_ID', label: 'GA4 measurement ID', group: 'Analytics', placeholder: 'G-XXXXXXX' },
  { key: 'GA4_API_SECRET', label: 'GA4 Measurement Protocol secret', group: 'Analytics', secret: true },

  { key: 'META_PIXEL_ID', label: 'Meta Pixel ID', group: 'Ads' },
  { key: 'META_ACCESS_TOKEN', label: 'Meta Conversions API token', group: 'Ads', secret: true },
  { key: 'META_TEST_EVENT_CODE', label: 'Meta test event code', group: 'Ads', help: 'Only while testing in Events Manager. Clear it before going live.' },

  { key: 'SLACK_WEBHOOK_URL', label: 'Slack webhook (hot-lead alerts)', group: 'Alerts', secret: true },
  { key: 'LEAD_WEBHOOK_URL', label: 'CRM webhook (Zapier / Make / GHL)', group: 'Alerts', secret: true, help: 'Receives every lead lifecycle event as JSON.' },

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
  return v.length <= 8 ? '••••' : `${v.slice(0, 4)}••••${v.slice(-4)}`;
}

export const flag = (v: string | undefined, dflt = false) => (v ? /^(1|true|yes|on)$/i.test(v.trim()) : dflt);
