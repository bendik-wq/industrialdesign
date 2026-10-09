import type { Runtime } from '../app';
import { ECONOMICS, HEADLINE_EXPERIMENT } from '../config';
import { hashPII } from '../lib/crypto';
import { GA4_EVENTS, META_EVENTS } from './catalog';
import type { TrackIdentity } from './track';

export const META_API_VERSION = 'v24.0';

interface ForwardedEvent {
  id: string;
  ts: number;
  name: string;
  props: Record<string, unknown>;
  path: string | null;
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
  utm_source: string | null;
  utm_campaign: string | null;
  channel: string | null;
}

/** Events that change a lead's lifecycle — mirrored to the CRM webhook with a lead snapshot. */
const LIFECYCLE = new Set(['lead_captured', 'app_submitted', 'lead_qualified', 'lead_routed', 'booking_scheduled', 'booking_cancelled', 'whatsapp_connected', 'lead_status_changed', 'unsubscribe']);

/** Estimated pipeline value per conversion, so Meta can optimise for lead quality, not volume. */
function conversionValue(name: string, lead: LeadSnapshot | null): number | undefined {
  if (name === 'lead_qualified') return lead?.tier === 'A' ? ECONOMICS.programPrice * 0.1 : lead?.tier === 'B' ? ECONOMICS.programPrice * 0.03 : 0;
  if (name === 'booking_scheduled') return ECONOMICS.programPrice * 0.15;
  return undefined;
}

export async function forwardEvent(rt: Runtime, who: TrackIdentity, ev: ForwardedEvent) {
  const { settings } = rt;
  const needsLead = Boolean(who.leadId) && (LIFECYCLE.has(ev.name) || META_EVENTS[ev.name] || settings.POSTHOG_KEY);
  const lead = needsLead
    ? await rt.env.DB.prepare(
        'SELECT id, ref_code, email, phone, first_name, last_name, country, city, tier, score, status, closer_id, utm_source, utm_campaign, channel FROM leads WHERE id = ?',
      )
        .bind(who.leadId)
        .first<LeadSnapshot>()
    : null;

  const jobs: Promise<unknown>[] = [];
  const consent = who.marketingConsent !== false;
  if (consent && settings.POSTHOG_KEY && who.visitorId) jobs.push(toPostHog(rt, who, ev, lead));
  if (consent && settings.META_PIXEL_ID && settings.META_ACCESS_TOKEN && META_EVENTS[ev.name]) jobs.push(toMeta(rt, who, ev, lead));
  if (consent && settings.GA4_MEASUREMENT_ID && settings.GA4_API_SECRET && GA4_EVENTS[ev.name] && who.visitorId) jobs.push(toGA4(rt, who, ev, lead));
  if (settings.LEAD_WEBHOOK_URL && lead && LIFECYCLE.has(ev.name)) jobs.push(toWebhook(rt, ev, lead));

  const results = await Promise.allSettled(jobs);
  for (const r of results) if (r.status === 'rejected') console.error(`forward ${ev.name} failed:`, r.reason);
}

async function post(url: string, body: unknown, label: string) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${label} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

function pageUrl(rt: Runtime, who: TrackIdentity, ev: ForwardedEvent) {
  return who.pageUrl ?? (ev.path ? `${rt.origin}${ev.path}` : rt.origin);
}

async function toPostHog(rt: Runtime, who: TrackIdentity, ev: ForwardedEvent, lead: LeadSnapshot | null) {
  const host = (rt.settings.POSTHOG_HOST || 'https://us.i.posthog.com').replace(/\/+$/, '');
  const properties: Record<string, unknown> = {
    ...ev.props,
    $current_url: pageUrl(rt, who, ev),
    $pathname: ev.path,
    $ip: who.ip ?? undefined,
    $raw_user_agent: who.userAgent ?? undefined,
    $insert_id: ev.id,
    session_id: who.sessionId,
    variant: who.variant,
    $lib: 'owners-funnel-server',
    [`$feature/${HEADLINE_EXPERIMENT.id}`]: who.variant,
  };
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
  await post(`${host}/batch/`, {
    api_key: rt.settings.POSTHOG_KEY,
    batch: [{ event: ev.name === 'page_view' ? '$pageview' : ev.name, distinct_id: who.visitorId, properties, timestamp: new Date(ev.ts).toISOString() }],
  }, 'posthog');
}

async function toMeta(rt: Runtime, who: TrackIdentity, ev: ForwardedEvent, lead: LeadSnapshot | null) {
  const s = rt.settings;
  const user_data: Record<string, unknown> = {
    client_ip_address: who.ip ?? undefined,
    client_user_agent: who.userAgent ?? undefined,
    fbp: who.fbp ?? undefined,
    fbc: who.fbc ?? undefined,
    external_id: who.visitorId ? [await hashPII(who.visitorId)] : undefined,
  };
  if (lead) {
    const [em, ph, fn, ln, ct, country] = await Promise.all([
      hashPII(lead.email, 'email'), hashPII(lead.phone, 'phone'), hashPII(lead.first_name, 'name'),
      hashPII(lead.last_name, 'name'), hashPII(lead.city, 'name'), hashPII(lead.country),
    ]);
    Object.assign(user_data, { em: em && [em], ph: ph && [ph], fn: fn && [fn], ln: ln && [ln], ct: ct && [ct], country: country && [country] });
  }
  const value = conversionValue(ev.name, lead);
  const body: Record<string, unknown> = {
    data: [{
      event_name: META_EVENTS[ev.name],
      event_time: Math.floor(ev.ts / 1000),
      event_id: ev.id,
      action_source: 'website',
      event_source_url: pageUrl(rt, who, ev),
      user_data,
      custom_data: {
        ...(value !== undefined ? { value, currency: ECONOMICS.currency } : {}),
        ...(lead?.tier ? { lead_tier: lead.tier, lead_score: lead.score } : {}),
        variant: who.variant ?? undefined,
      },
    }],
  };
  if (s.META_TEST_EVENT_CODE) body.test_event_code = s.META_TEST_EVENT_CODE;
  await post(`https://graph.facebook.com/${META_API_VERSION}/${s.META_PIXEL_ID}/events?access_token=${encodeURIComponent(s.META_ACCESS_TOKEN)}`, body, 'meta-capi');
}

async function toGA4(rt: Runtime, who: TrackIdentity, ev: ForwardedEvent, lead: LeadSnapshot | null) {
  const s = rt.settings;
  const value = conversionValue(ev.name, lead);
  const params: Record<string, unknown> = {
    ...Object.fromEntries(Object.entries(ev.props).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))),
    page_location: pageUrl(rt, who, ev),
    session_id: who.sessionId,
    engagement_time_msec: 1,
    variant: who.variant,
    ...(value !== undefined ? { value, currency: ECONOMICS.currency } : {}),
    ...(ev.name === 'vsl_50' ? { video_percent: 50 } : {}),
  };
  const url = `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(s.GA4_MEASUREMENT_ID)}&api_secret=${encodeURIComponent(s.GA4_API_SECRET)}`;
  await post(url, {
    client_id: who.visitorId,
    user_id: lead?.id,
    timestamp_micros: ev.ts * 1000,
    events: [{ name: GA4_EVENTS[ev.name], params }],
  }, 'ga4');
}

async function toWebhook(rt: Runtime, ev: ForwardedEvent, lead: LeadSnapshot) {
  await post(rt.settings.LEAD_WEBHOOK_URL, {
    event: ev.name,
    event_id: ev.id,
    at: new Date(ev.ts).toISOString(),
    props: ev.props,
    lead,
    dashboard_url: `${rt.origin}/admin#lead=${lead.id}`,
  }, 'lead-webhook');
}
