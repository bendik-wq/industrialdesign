export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Cloudflare Workers AI (speech-to-text for the application's microphone fallback). */
  AI?: Ai;
  /** One Durable Object per video room (src/rooms/do.ts). */
  ROOMS?: DurableObjectNamespace;
  /** Optional R2 bucket for room recordings (the replay). Without it the host downloads the recording. */
  RECORDINGS?: R2Bucket;
  /** Cloudflare platform round, builder B: Analytics Engine dataset gl_events (src/infra/analytics-engine.ts). Optional; used only when ANALYTICS_ENGINE is on. */
  EVENTS?: AnalyticsEngineDataset;
  /** Cloudflare round, builder C: the Vectorize index gl-knowledge (768 dims, cosine). Missing in tests and `wrangler dev --local`; every caller copes. */
  VECTORS?: Vectorize;
  /** Platform round A: the send queue `gl-send` (src/infra/queue.ts). Used only with SEND_VIA_QUEUE on; without it everything sends inline. */
  SEND_QUEUE?: Queue<unknown>;
  /** Platform round A: the LiveReminderWorkflow (src/live/reminder-flow.ts). Used only with LIVE_REMINDERS_VIA_WORKFLOW on. */
  LIVE_REMINDER_FLOW?: Workflow<{ regId: string }>;
  /** Cloudflare round, builder D. Workers KV: the settings cache (setting KV_CACHE, src/settings.ts). Optional. */
  CACHE?: KVNamespace;
  /** Cloudflare round, builder D. Browser Rendering (@cloudflare/puppeteer): PDFs and the funnel watchdog. Not available in local dev. */
  BROWSER?: Fetcher;
  /** G&L Studio (src/studio): R2 bucket gl-studio for raw recordings, edits, shorts, transcripts. Optional; without it Studio says "not available here". */
  STUDIO?: R2Bucket;
  /** G&L Studio: the editor container's Durable Object namespace (class StudioEditor, Cloudflare Containers). Optional. */
  STUDIO_EDITOR?: DurableObjectNamespace;
  /** G&L Studio: the pipeline Workflow gl-studio-pipeline (one instance per video run). Optional; the 5-minute cron advances videos without it. */
  STUDIO_FLOW?: Workflow<{ id: string }>;
  /** Radar v2: the analysis pipeline Workflow gl-radar-pipeline (src/radar/pipeline-flow.ts). Without it the pipeline runs inline and the cron resumes it. */
  RADAR_FLOW?: Workflow<{ runId: string }>;

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
  RESEND_WEBHOOK_SECRET?: string;
  META_ADS_TOKEN?: string;
  META_AD_ACCOUNT_ID?: string;
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
  /** The deployed Worker version (wrangler.jsonc version_metadata): a fallback build id for versioned asset URLs (src/infra/build.ts). */
  CF_VERSION_METADATA?: { id?: string; tag?: string; timestamp?: string };
}
