import type { Runtime } from '../app';
import { ECONOMICS, HEADLINE_EXPERIMENT } from '../config';
import { sha256 } from '../lib/crypto';
import type { EventSource } from './catalog';
import { GA4_EVENTS, META_EVENTS } from './catalog';
import { hashedMatchKeys } from './match';
import type { TrackIdentity } from './track';

export const META_API_VERSION = 'v24.0';

interface ForwardedEvent {
  id: string;
  ts: number;
  name: string;
  props: Record<string, unknown>;
  path: string | null;
  source?: EventSource;
}

interface LeadSnapshot {
  id: string;
  ref_code: string;
  email: string | null;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  country: string | null;
  city: string | null;
  tier: string | null;
  score: number | null;
  status: string;
  closer_id: string | null;
  revenue: number;
  utm_source: string | null;
  utm_campaign: string | null;
  channel: string | null;
}

type Dest = 'meta' | 'ga4' | 'posthog' | 'webhook';

/** Events that change a lead's lifecycle — mirrored to the CRM webhook with a lead snapshot. */
const LIFECYCLE = new Set(['lead_captured', 'app_submitted', 'lead_qualified', 'lead_routed', 'booking_scheduled', 'booking_cancelled', 'whatsapp_connected', 'lead_status_changed', 'unsubscribe']);

/** Meta drops events older than 7 days; we stop retrying a little before that. */
const META_MAX_AGE_MS = 6.5 * 86_400_000;
const MAX_ATTEMPTS = 6;

/**
 * Meta event for a funnel event. Pipeline outcomes recorded by the team (call
 * showed, deal won) are sent back too, so Meta optimises for buyers, not form fills.
 */
export function metaEventName(name: string, props: Record<string, unknown>): string | undefined {
  if (name === 'lead_status_changed') {
    if (props.to === 'showed') return 'CallShowed';
    if (props.to === 'won') return 'Purchase';
    return undefined;
  }
  return META_EVENTS[name];
}

function ga4EventName(name: string, props: Record<string, unknown>): string | undefined {
  if (name === 'lead_status_changed') return props.to === 'won' ? 'purchase' : props.to === 'showed' ? 'call_showed' : undefined;
  return GA4_EVENTS[name];
}

/** Estimated pipeline value per conversion, so ad platforms optimise for lead quality, not volume. */
export function conversionValue(name: string, props: Record<string, unknown>, lead: Pick<LeadSnapshot, 'tier' | 'revenue'> | null): number | undefined {
  if (name === 'lead_qualified') return lead?.tier === 'A' ? ECONOMICS.programPrice * 0.1 : lead?.tier === 'B' ? ECONOMICS.programPrice * 0.03 : 0;
  if (name === 'booking_scheduled') return ECONOMICS.programPrice * 0.15;
  if (name === 'lead_status_changed' && props.to === 'showed') return ECONOMICS.programPrice * 0.3;
  if (name === 'lead_status_changed' && props.to === 'won') {
    const revenue = Number(props.revenue ?? lead?.revenue ?? 0);
    return revenue > 0 ? revenue : ECONOMICS.programPrice;
  }
  return undefined;
}

export async function forwardEvent(rt: Runtime, who: TrackIdentity, ev: ForwardedEvent) {
  const { settings } = rt;
  const metaName = metaEventName(ev.name, ev.props);
  const needsLead = Boolean(who.leadId) && (LIFECYCLE.has(ev.name) || metaName || settings.POSTHOG_KEY || settings.GA4_MEASUREMENT_ID);
  const lead = needsLead
    ? await rt.env.DB.prepare(
        'SELECT id, ref_code, email, phone, first_name, last_name, country, city, tier, score, status, closer_id, revenue, utm_source, utm_campaign, channel FROM leads WHERE id = ?',
      )
        .bind(who.leadId)
        .first<LeadSnapshot>()
    : null;

  const jobs: Promise<unknown>[] = [];
  const consent = who.marketingConsent !== false;
  if (consent && settings.POSTHOG_KEY && who.visitorId) jobs.push(toPostHog(rt, who, ev, lead));
  if (consent && settings.META_PIXEL_ID && settings.META_ACCESS_TOKEN && metaName) jobs.push(toMeta(rt, who, ev, lead, metaName));
  const ga4Name = ga4EventName(ev.name, ev.props);
  if (consent && settings.GA4_MEASUREMENT_ID && settings.GA4_API_SECRET && ga4Name && who.visitorId) jobs.push(toGA4(rt, who, ev, lead, ga4Name));
  if (settings.LEAD_WEBHOOK_URL && lead && LIFECYCLE.has(ev.name)) jobs.push(toWebhook(rt, ev, lead));

  const results = await Promise.allSettled(jobs);
  for (const r of results) if (r.status === 'rejected') console.error(`forward ${ev.name} failed:`, r.reason);
}

// ───────────────────────────── Delivery + log + retry ─────────────────────────────

function endpoint(rt: Runtime, dest: Dest): string | null {
  const s = rt.settings;
  if (dest === 'meta') return s.META_PIXEL_ID && s.META_ACCESS_TOKEN ? `https://graph.facebook.com/${META_API_VERSION}/${s.META_PIXEL_ID}/events?access_token=${encodeURIComponent(s.META_ACCESS_TOKEN)}` : null;
  if (dest === 'ga4') return s.GA4_MEASUREMENT_ID && s.GA4_API_SECRET ? `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(s.GA4_MEASUREMENT_ID)}&api_secret=${encodeURIComponent(s.GA4_API_SECRET)}` : null;
  if (dest === 'posthog') return s.POSTHOG_KEY ? `${(s.POSTHOG_HOST || 'https://us.i.posthog.com').replace(/\/+$/, '')}/batch/` : null;
  return s.LEAD_WEBHOOK_URL || null;
}

const backoff = (attempt: number) => Math.min(6 * 3600_000, 60_000 * 4 ** (attempt - 1)); // 1m, 4m, 16m, ~1h, 4h, 6h

/**
 * Sends one payload and records the outcome. Successful Meta/GA4 sends are
 * logged (for the dashboard's delivery + match-quality view); failures keep
 * their payload so the cron can retry them with back-off.
 */
async function deliver(rt: Runtime, dest: Dest, ev: { id: string; name: string; ts: number }, body: unknown, opts: { matchKeys?: string[]; attempt?: number } = {}) {
  const url = endpoint(rt, dest);
  if (!url) return;
  const attempt = opts.attempt ?? 1;
  let ok = false;
  let status: number | null = null;
  let text = '';
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    status = res.status;
    text = (await res.text()).slice(0, 1000);
    ok = res.ok;
  } catch (err) {
    text = String(err instanceof Error ? err.message : err).slice(0, 500);
  }

  let response: string | null = null;
  if (dest === 'meta' && ok) {
    try {
      const j = JSON.parse(text) as { events_received?: number; fbtrace_id?: string; messages?: string[] };
      response = JSON.stringify({ events_received: j.events_received, fbtrace_id: j.fbtrace_id, messages: j.messages?.length ? j.messages : undefined });
    } catch {
      response = text.slice(0, 300);
    }
  }
  // Meta returns 4xx with an error object for bad payloads; retrying those won't help, so give up on non-retryable codes.
  const retryable = !ok && (status === null || status === 429 || status >= 500);
  const tooOld = dest === 'meta' && Date.now() - ev.ts > META_MAX_AGE_MS;
  const giveUp = !ok && (!retryable || attempt >= MAX_ATTEMPTS || tooOld);
  const state = ok ? 'sent' : giveUp ? 'failed' : 'retrying';

  if (ok && dest === 'posthog' && attempt === 1) return; // high volume; only failures and retries are logged
  await rt.env.DB.prepare(
    `INSERT INTO forward_log (event_id, dest, event_name, ts, status, attempts, http_status, error, response, match_keys, payload, next_try_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(event_id, dest) DO UPDATE SET status = excluded.status, attempts = excluded.attempts, http_status = excluded.http_status,
       error = excluded.error, response = COALESCE(excluded.response, forward_log.response), payload = excluded.payload,
       next_try_at = excluded.next_try_at, updated_at = excluded.updated_at`,
  )
    .bind(
      ev.id, dest, ev.name, ev.ts, state, attempt, status, ok ? null : text.slice(0, 500), response, opts.matchKeys?.join(',') ?? null,
      state === 'retrying' ? JSON.stringify(body) : null, state === 'retrying' ? Date.now() + backoff(attempt) : null, Date.now(),
    )
    .run()
    .catch((e) => console.error('forward_log write failed', e));
  if (!ok) throw new Error(`${dest} ${status ?? 'network'}: ${text.slice(0, 200)}`);
}

/** Cron: re-sends failed deliveries that are due. Payloads are replayed as-is (same event_id, so platforms still deduplicate). */
export async function retryForwards(rt: Runtime, limit = 50) {
  const { results } = await rt.env.DB.prepare(
    "SELECT event_id, dest, event_name, ts, attempts, payload FROM forward_log WHERE status = 'retrying' AND next_try_at <= ? ORDER BY next_try_at LIMIT ?",
  )
    .bind(Date.now(), limit)
    .all<{ event_id: string; dest: Dest; event_name: string; ts: number; attempts: number; payload: string | null }>();
  let delivered = 0;
  for (const row of results) {
    if (!row.payload) continue;
    try {
      await deliver(rt, row.dest, { id: row.event_id, name: row.event_name, ts: row.ts }, JSON.parse(row.payload), { attempt: row.attempts + 1 });
      delivered++;
    } catch {
      /* logged by deliver */
    }
  }
  // Keep the log small: drop delivered rows after 30 days, failures after 90.
  await rt.env.DB.prepare("DELETE FROM forward_log WHERE (status = 'sent' AND updated_at < ?) OR updated_at < ?")
    .bind(Date.now() - 30 * 86_400_000, Date.now() - 90 * 86_400_000)
    .run();
  return { due: results.length, delivered };
}

function pageUrl(rt: Runtime, who: TrackIdentity, ev: ForwardedEvent) {
  return who.pageUrl ?? (ev.path ? `${rt.origin}${ev.path}` : rt.origin);
}

/** Events the team records in the dashboard (or cron) didn't happen on the website. */
const actionSource = (ev: ForwardedEvent) => (ev.source === 'admin' || ev.source === 'cron' ? 'system_generated' : 'website');

// ───────────────────────────── Destinations ─────────────────────────────

async function toPostHog(rt: Runtime, who: TrackIdentity, ev: ForwardedEvent, lead: LeadSnapshot | null) {
  const properties: Record<string, unknown> = {
    ...ev.props,
    $current_url: pageUrl(rt, who, ev),
    $pathname: ev.path,
    $ip: who.ip ?? undefined,
    $raw_user_agent: who.userAgent ?? undefined,
    $insert_id: ev.id,
    session_id: who.sessionId,
    variant: who.variant,
    source: ev.source,
    $lib: 'owners-funnel-server',
    [`$feature/${HEADLINE_EXPERIMENT.id}`]: who.variant,
  };
  const value = conversionValue(ev.name, ev.props, lead);
  if (value !== undefined) Object.assign(properties, { value, currency: ECONOMICS.currency });
  if (lead) {
    properties.$set = {
      email: lead.email,
      name: [lead.first_name, lead.last_name].filter(Boolean).join(' ') || undefined,
      phone: lead.phone,
      lead_id: lead.id,
      ref_code: lead.ref_code,
      tier: lead.tier,
      score: lead.score,
      status: lead.status,
      closer: lead.closer_id,
    };
    properties.$set_once = { first_utm_source: lead.utm_source, first_utm_campaign: lead.utm_campaign, first_channel: lead.channel };
  }
  await deliver(rt, 'posthog', ev, {
    api_key: rt.settings.POSTHOG_KEY,
    batch: [{ event: ev.name === 'page_view' ? '$pageview' : ev.name, distinct_id: who.visitorId, properties, timestamp: new Date(ev.ts).toISOString() }],
  });
}

/** Meta user_data: hashed customer info + the raw browser signals Meta needs for matching. Shared with tests. */
export async function metaUserData(who: TrackIdentity, lead: Pick<LeadSnapshot, 'id' | 'email' | 'phone' | 'first_name' | 'last_name' | 'country' | 'city'> | null) {
  const hashed = await hashedMatchKeys(
    lead ? { email: lead.email, phone: lead.phone, firstName: lead.first_name, lastName: lead.last_name, country: lead.country, city: lead.city } : null,
    who.geo ?? null,
    // The visitor id first: it's what the browser Pixel sends as external_id, so the two sides line up.
    [who.visitorId, lead?.id],
  );
  const user_data: Record<string, unknown> = { ...hashed };
  for (const k of ['em', 'ph', 'fn', 'ln', 'ct', 'st', 'zp', 'country'] as const) if (typeof user_data[k] === 'string') user_data[k] = [user_data[k]];
  if (who.ip) user_data.client_ip_address = who.ip;
  if (who.userAgent) user_data.client_user_agent = who.userAgent;
  if (who.fbp) user_data.fbp = who.fbp;
  if (who.fbc) user_data.fbc = who.fbc;
  return user_data;
}

async function toMeta(rt: Runtime, who: TrackIdentity, ev: ForwardedEvent, lead: LeadSnapshot | null, eventName: string) {
  const user_data = await metaUserData(who, lead);
  const value = conversionValue(ev.name, ev.props, lead);
  const custom_data: Record<string, unknown> = {};
  if (value !== undefined) Object.assign(custom_data, { value, currency: ECONOMICS.currency });
  if (lead?.tier) Object.assign(custom_data, { lead_tier: lead.tier, lead_score: lead.score });
  if (who.variant) custom_data.variant = who.variant;
  if (eventName === 'Purchase') Object.assign(custom_data, { order_id: lead?.id ?? ev.id, content_name: 'M&A advisory program' });

  const event: Record<string, unknown> = {
    event_name: eventName,
    event_time: Math.floor(ev.ts / 1000),
    event_id: ev.id,
    action_source: actionSource(ev),
    user_data,
    custom_data,
  };
  if (event.action_source === 'website') event.event_source_url = pageUrl(rt, who, ev);
  const body: Record<string, unknown> = { data: [event] };
  if (rt.settings.META_TEST_EVENT_CODE) body.test_event_code = rt.settings.META_TEST_EVENT_CODE;
  await deliver(rt, 'meta', ev, body, { matchKeys: Object.keys(user_data) });
}

async function toGA4(rt: Runtime, who: TrackIdentity, ev: ForwardedEvent, lead: LeadSnapshot | null, eventName: string) {
  const value = conversionValue(ev.name, ev.props, lead);
  const params: Record<string, unknown> = {
    ...Object.fromEntries(Object.entries(ev.props).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))),
    page_location: pageUrl(rt, who, ev),
    session_id: who.sessionId,
    engagement_time_msec: 1,
    variant: who.variant,
    ...(value !== undefined ? { value, currency: ECONOMICS.currency } : {}),
    ...(ev.name === 'vsl_50' ? { video_percent: 50 } : {}),
    ...(eventName === 'purchase' ? { transaction_id: lead?.id ?? ev.id } : {}),
  };
  const body: Record<string, unknown> = {
    client_id: who.visitorId,
    user_id: lead?.id,
    timestamp_micros: ev.ts * 1000,
    events: [{ name: eventName, params }],
  };
  // User-provided data (enhanced conversions): Google wants lowercase email and E.164 phone, SHA-256 hex.
  if (lead?.email || lead?.phone) {
    const [em, ph] = await Promise.all([lead.email ? sha256(lead.email.trim().toLowerCase()) : null, lead.phone ? sha256(`+${lead.phone.replace(/\D/g, '')}`) : null]);
    body.user_data = { ...(em ? { sha256_email_address: [em] } : {}), ...(ph ? { sha256_phone_number: [ph] } : {}) };
  }
  await deliver(rt, 'ga4', ev, body);
}

async function toWebhook(rt: Runtime, ev: ForwardedEvent, lead: LeadSnapshot) {
  await deliver(rt, 'webhook', ev, {
    event: ev.name,
    event_id: ev.id,
    at: new Date(ev.ts).toISOString(),
    props: ev.props,
    lead,
    dashboard_url: `${rt.origin}/admin#lead=${lead.id}`,
  });
}
