export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;

  // Plain vars (wrangler.jsonc) — every one of these can also be connected from
  // the dashboard's Integrations tab; see SETTINGS in settings.ts.
  SITE_NAME?: string;
  SITE_PALETTE?: string;
  PUBLIC_URL?: string;
  EMAIL_FROM?: string;
  EMAIL_REPLY_TO?: string;
  EMAIL_SIGNATURE?: string;
  BUSINESS_ADDRESS?: string;
  JOSH_WHATSAPP?: string;
  BOOKING_URL_A?: string;
  BOOKING_URL_B?: string;
  VSL_MAIN_SRC?: string;
  VSL_MAIN_POSTER?: string;
  VSL_BREAKOUT_SRC?: string;
  VSL_BREAKOUT_POSTER?: string;
  VSL_PRECALL_SRC?: string;
  POSTHOG_HOST?: string;
  CONSENT_REQUIRED_EU?: string;
  IP_ANONYMIZE?: string;

  // Secrets (`wrangler secret put NAME`)
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;
  RESEND_API_KEY?: string;
  POSTHOG_KEY?: string;
  POSTHOG_SESSION_REPLAY?: string;
  META_PIXEL_ID?: string;
  META_ACCESS_TOKEN?: string;
  META_TEST_EVENT_CODE?: string;
  GA4_MEASUREMENT_ID?: string;
  GA4_API_SECRET?: string;
  WHATSAPP_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_VERIFY_TOKEN?: string;
  WHATSAPP_APP_SECRET?: string;
  WHATSAPP_RESOURCES_TEMPLATE?: string;
  CALENDLY_SIGNING_KEY?: string;
  BOOKING_WEBHOOK_SECRET?: string;
  SLACK_WEBHOOK_URL?: string;
  SLACK_WINS_WEBHOOK_URL?: string;
  DISCORD_WEBHOOK_URL?: string;
  DISCORD_WINS_WEBHOOK_URL?: string;
  SALES_TIMEZONE?: string;
  DIGEST_HOUR?: string;
  LEAD_WEBHOOK_URL?: string;
  BLOCKLIST?: string;
  CLARITY_ID?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  VAPI_API_KEY?: string;
  VAPI_PUBLIC_KEY?: string;
  VAPI_ASSISTANT_ID?: string;
  VOICE_WEBHOOK_SECRET?: string;
  VOICE_PHONE_NUMBER?: string;
  VOICE_MODEL?: string;
  VOICE_VOICE?: string;
  VOICE_WEB_ENABLED?: string;
}
