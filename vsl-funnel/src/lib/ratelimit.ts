import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from '../env';

/**
 * Fixed-window per-key rate limits backed by kv_state (D1). Used on every public endpoint that writes, sends
 * email/SMS/Slack, starts a checkout or a charge, or spends AI/TURN minutes, so a script can't flood a victim's
 * inbox, test stolen cards or run up a bill from our accounts.
 *
 * One atomic upsert per hit (no read-then-write race: parallel requests from one connection can't all slip in under
 * the limit). Stored as {"n": hits, "t": window start}, the same shape the older counters used.
 */

const DAY = 86_400_000;
/** The longest window any limit uses: counters older than this are swept by purgeRateLimits. */
export const MAX_WINDOW_MS = DAY;

/** Counts one hit on `key` (kv_state key, used as given) and returns the hits in the current window, this one included. */
export async function hit(env: Pick<Env, 'DB'>, key: string, windowMs: number, now = Date.now()): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO kv_state (key, value) VALUES (?1, json_object('n', 1, 't', ?2))
     ON CONFLICT(key) DO UPDATE SET value = CASE
       WHEN json_valid(kv_state.value) AND json_type(kv_state.value, '$.t') IN ('integer', 'real') AND ?2 - json_extract(kv_state.value, '$.t') < ?3
       THEN json_object('n', COALESCE(json_extract(kv_state.value, '$.n'), 0) + 1, 't', json_extract(kv_state.value, '$.t'))
       ELSE json_object('n', 1, 't', ?2) END
     RETURNING value`,
  ).bind(key, now, windowMs).first<{ value: string }>();
  try { return Number((JSON.parse(row?.value ?? '{}') as { n?: number }).n ?? 1); } catch { return 1; }
}

/**
 * True when the caller is over `max` hits in the window (this hit counted). Fails open on a database error: a D1
 * hiccup must not lock real leads out of a form (the forms behind it have their own validation and Turnstile).
 */
export async function overLimit(env: Pick<Env, 'DB'>, key: string, max: number, windowMs = 3_600_000, now = Date.now()): Promise<boolean> {
  try {
    return (await hit(env, `rl:${key}`, windowMs, now)) > max;
  } catch (e) {
    console.error('rate limit check failed', String(e).slice(0, 200));
    return false;
  }
}

/** The connection's IP as Cloudflare saw it ('unknown' off Cloudflare, e.g. in tests). */
export const clientIp = (c: Context) => c.req.header('cf-connecting-ip') ?? 'unknown';

/** What a person sees when they hit a limit (checked by auditCopy in test/security.test.ts). */
export const RATE_LIMIT_COPY = 'Too many requests from this connection. Wait a few minutes, then try again.';
export const RATE_LIMIT_COPY_CHARGE = 'Too many payment attempts from this connection. Wait an hour, then try again, or contact us and we will help.';

export interface PublicLimit {
  method: 'GET' | 'POST' | 'PUT';
  /** The route pattern as mounted on the app (Hono syntax). */
  path: string;
  /** Counter name: limits that share a scope share one counter per connection. */
  scope: string;
  max: number;
  windowMs: number;
  /** Why it is limited (shown in the audit). */
  why: string;
  /** Requests this limit doesn't count (e.g. the net test's tiny pings). */
  skip?: (c: Context) => boolean;
  /** The copy on a 429 (defaults to RATE_LIMIT_COPY). */
  copy?: string;
}

const MIN = 60_000;
const HOUR = 3_600_000;
const checkoutWhy = 'starts a checkout with the payment provider (an API call per hit)';
const chargeWhy = 'charges a card or a saved card (card testing)';

/**
 * Route-level limits added by the security round (per connection IP). Each runs before the route's own checks.
 * Endpoints with a limit in their handler already are listed in HANDLER_LIMITS (docs and the audit test only).
 * Generous on purpose: many attendees can share one IP (offices, mobile carriers), and a real person never comes close.
 */
export const PUBLIC_RATE_LIMITS: PublicLimit[] = [
  // Application
  { method: 'POST', path: '/api/apply/contact', scope: 'apply-contact', max: 30, windowMs: HOUR, why: 'creates or updates a lead; an existing email gets a notice email (the 10-per-hour new-contact limit skipped browsers that already had a lead)' },
  { method: 'POST', path: '/api/apply/answer', scope: 'apply-answer', max: 300, windowMs: HOUR, why: 'writes an answer and an event per hit' },
  { method: 'POST', path: '/api/apply/submit', scope: 'apply-submit', max: 20, windowMs: HOUR, why: 'scores the lead, queues emails, sends server-side conversions' },
  { method: 'POST', path: '/api/apply/transcribe', scope: 'stt', max: 60, windowMs: HOUR, why: 'Workers AI speech-to-text (the 40-per-hour limit was per lead only)' },
  { method: 'POST', path: '/api/booking/client', scope: 'booking-client', max: 20, windowMs: HOUR, why: 'marks a lead booked and can queue the pre-call emails' },
  { method: 'POST', path: '/api/voice/start', scope: 'voice-web', max: 10, windowMs: HOUR, why: 'starts an ElevenLabs browser call (the daily limit was per lead only)' },
  { method: 'POST', path: '/api/webinar/phone', scope: 'webinar-phone', max: 10, windowMs: HOUR, why: 'adds a phone number that SMS and AI calls can use' },
  // Checkouts (an API call to Whop or Stripe per hit)
  { method: 'POST', path: '/api/webinar/checkout', scope: 'checkout', max: 30, windowMs: HOUR, why: checkoutWhy },
  { method: 'POST', path: '/api/webinar/sprint/checkout', scope: 'checkout', max: 30, windowMs: HOUR, why: checkoutWhy },
  { method: 'POST', path: '/api/webinar/sprint/pay', scope: 'checkout', max: 30, windowMs: HOUR, why: checkoutWhy },
  { method: 'POST', path: '/api/live/deposit', scope: 'checkout', max: 30, windowMs: HOUR, why: checkoutWhy },
  { method: 'POST', path: '/api/challenge/deposit', scope: 'checkout', max: 30, windowMs: HOUR, why: checkoutWhy },
  { method: 'POST', path: '/api/rooms/:id/sprint', scope: 'checkout', max: 30, windowMs: HOUR, why: checkoutWhy },
  { method: 'POST', path: '/api/webinar/sprint/one-click/quote', scope: 'checkout', max: 30, windowMs: HOUR, why: 'prices the one-click Sprint against the saved card (provider API call)' },
  // Charges (card testing)
  { method: 'POST', path: '/api/webinar/ticket/pay', scope: 'charge', max: 10, windowMs: HOUR, why: chargeWhy, copy: RATE_LIMIT_COPY_CHARGE },
  { method: 'POST', path: '/api/webinar/sprint/one-click', scope: 'charge', max: 10, windowMs: HOUR, why: chargeWhy, copy: RATE_LIMIT_COPY_CHARGE },
  { method: 'POST', path: '/api/pay', scope: 'charge', max: 10, windowMs: HOUR, why: chargeWhy, copy: RATE_LIMIT_COPY_CHARGE },
  { method: 'POST', path: '/api/challenge/pay', scope: 'charge', max: 10, windowMs: HOUR, why: chargeWhy, copy: RATE_LIMIT_COPY_CHARGE },
  { method: 'POST', path: '/api/challenge/vip', scope: 'charge', max: 10, windowMs: HOUR, why: chargeWhy, copy: RATE_LIMIT_COPY_CHARGE },
  // Rooms
  { method: 'POST', path: '/api/rooms/:id/ice', scope: 'room-ice', max: 60, windowMs: HOUR, why: 'mints Cloudflare TURN credentials (billed relay minutes)' },
  { method: 'GET', path: '/api/rooms/:id/net/:kind', scope: 'room-net', max: 120, windowMs: 10 * MIN, why: 'streams random bytes for the download test (CPU)', skip: (c) => c.req.param('kind') === 'ping' },
  { method: 'POST', path: '/api/rooms/:id/net/:kind', scope: 'room-net', max: 120, windowMs: 10 * MIN, why: 'reads an upload for the upload test', skip: (c) => c.req.param('kind') === 'ping' },
  { method: 'POST', path: '/api/rooms/:id/captions', scope: 'room-captions', max: 400, windowMs: 10 * MIN, why: 'Workers AI speech-to-text per audio piece (host and co-hosts only)' },
  { method: 'POST', path: '/api/rooms/:id/app', scope: 'room-app', max: 10, windowMs: HOUR, why: 'files an application from the room (scoring, team pings)' },
  { method: 'POST', path: '/api/webinar/app', scope: 'room-app', max: 10, windowMs: HOUR, why: 'files an application from the masterclass room (scoring, team pings)' },
  // Token forms on the webinar pages
  ...['', '/webinar'].flatMap((p): PublicLimit[] => [
    { method: 'POST', path: `${p}/pack/:token`, scope: 'token-form', max: 30, windowMs: HOUR, why: 'saves a form and can email the team' },
    { method: 'POST', path: `${p}/sprint/:token`, scope: 'token-form', max: 30, windowMs: HOUR, why: 'saves a form and can email the team' },
    { method: 'POST', path: `${p}/sprint-start/:token`, scope: 'token-form', max: 30, windowMs: HOUR, why: 'saves a form, then starts a checkout' },
  ]),
  // Browser reports
  { method: 'POST', path: '/csp-report', scope: 'csp-report', max: 60, windowMs: 10 * MIN, why: 'writes to the error log' },
];

/** Limits enforced inside the handler (kept as they were; listed so the audit covers every public write). */
export const HANDLER_LIMITS: { method: string; path: string; limit: string; where: string }[] = [
  { method: 'POST', path: '/api/apply/contact', limit: '10 new contacts per IP per hour (plus Turnstile)', where: 'src/funnel/application.ts saveContact' },
  { method: 'POST', path: '/api/apply/transcribe', limit: '40 per lead per hour', where: 'src/routes/api.ts' },
  { method: 'POST', path: '/api/voice/start', limit: 'VOICE_AGENT.webCallsPerDay per lead per day', where: 'src/routes/api.ts' },
  { method: 'POST', path: '/api/webinar/register', limit: '8 sign-ups per IP per hour', where: 'src/webinar/webinar.ts register' },
  { method: 'POST', path: '/api/live/register', limit: '8 sign-ups per IP per hour', where: 'src/live/events.ts registerLive' },
  { method: 'POST', path: '/api/challenge/register', limit: '8 sign-ups per IP per hour', where: 'src/challenge/payments.ts registerChallenge' },
  { method: 'POST', path: '/rooms/:id/join/:slug', limit: 'JOINS_PER_IP_HOUR joins per IP per hour', where: 'src/rooms/admission.ts' },
  { method: 'POST', path: '/api/camera-test', limit: '20 per IP per hour, body 60 KB', where: 'src/rooms/camera-test.ts' },
  { method: 'POST', path: '/sign/:token', limit: '20 per IP per hour', where: 'src/routes/sign.ts' },
  { method: 'POST', path: '/hooks/support-email', limit: '300 per IP per hour (shared secret first)', where: 'src/integrations/hooks-in.ts' },
  { method: 'POST', path: '/hooks/zapier/:action', limit: '600 per IP per hour (shared secret first)', where: 'src/integrations/hooks-in.ts' },
  { method: 'POST', path: '/hooks/elevenlabs/tools/:action', limit: 'per lead: 12 availability look-ups and 4 booking attempts an hour, 2 bookings a day, one at a time (secret header and signed lead token first)', where: 'src/integrations/calendly-tools.ts' },
  { method: 'POST', path: '/mcp', limit: '3000 per hour in all (bearer token first)', where: 'src/mcp/server.ts' },
  { method: 'GET', path: '/l/:code', limit: 'a click counts at most 5 times per IP per link per hour (the redirect always works)', where: 'src/routes/links.ts' },
  { method: 'POST', path: '/admin/login', limit: '10 attempts per IP per 15 minutes, 300 failed attempts per hour in all', where: 'src/admin/auth.ts login' },
  { method: 'WS', path: '/api/rooms/:id/ws (chat, questions, AI co-host)', limit: 'chat 1 line per second per person (slow mode on top), AI co-host drafts capped at 80 per room, chat sweep once per 30 s', where: 'src/rooms/state.ts, src/rooms/audience-do.ts' },
];

/** Hono middleware for one PublicLimit: 429 with plain copy (JSON for API calls, text for page forms). */
export function rateLimit(l: PublicLimit): MiddlewareHandler {
  return async (c, next) => {
    if (l.skip?.(c)) return next();
    if (await overLimit(c.env as Env, `${l.scope}:${clientIp(c)}`, l.max, l.windowMs)) {
      const copy = l.copy ?? RATE_LIMIT_COPY;
      c.header('retry-after', String(Math.ceil(l.windowMs / 1000)));
      c.header('cache-control', 'no-store');
      return c.req.path.startsWith('/api/') || /json/.test(c.req.header('accept') ?? '') ? c.json({ ok: false, error: copy }, 429) : c.text(copy, 429);
    }
    return next();
  };
}

/** Removes rate-limit counters whose window is long over (they'd otherwise pile up in kv_state, one per IP). */
export async function purgeRateLimits(env: Pick<Env, 'DB'>, now = Date.now()) {
  const r = await env.DB.prepare(
    "DELETE FROM kv_state WHERE key LIKE 'rl:%' AND (NOT json_valid(value) OR COALESCE(json_extract(value, '$.t'), 0) < ?)",
  ).bind(now - MAX_WINDOW_MS).run();
  return { removed: r.meta?.changes ?? 0 };
}
