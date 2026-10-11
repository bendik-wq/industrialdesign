import type { Runtime } from '../app';
import { hmacHex, safeEqual } from '../lib/crypto';
import { type Lead, getLead, getLeadByEmail, updateLead } from '../funnel/leads';
import { identityFromLead, track } from '../tracking/track';
import { cancelSequence, enqueueSequence, formatCallTime } from './email';
import { notifySlack } from './notify';

export interface BookingInfo {
  callAt: number | null;
  provider: string;
  ref: string | null;
  /** True when confirmed by the provider's webhook rather than reported by the browser. */
  verified: boolean;
}

/**
 * Marks a lead as booked. Idempotent per booking reference: the browser
 * (Calendly postMessage) usually reports first, then the signed webhook
 * arrives with the actual call time and upgrades the record.
 */
export async function markBooked(rt: Runtime, lead: Lead, info: BookingInfo) {
  const sameBooking = lead.booked_at && !lead.booking_cancelled_at && (!info.ref || !lead.booking_ref || lead.booking_ref === info.ref);
  const callChanged = info.callAt && info.callAt !== lead.call_at;

  await updateLead(rt.env, lead.id, {
    status: ['won', 'lost', 'showed'].includes(lead.status) ? lead.status : 'booked',
    booked_at: lead.booked_at && sameBooking ? lead.booked_at : Date.now(),
    call_at: info.callAt ?? lead.call_at,
    booking_provider: info.verified || !lead.booking_provider ? info.provider : lead.booking_provider,
    booking_ref: info.ref ?? lead.booking_ref,
    booking_cancelled_at: null,
  });
  const fresh = (await getLead(rt.env, lead.id))!;

  if (!sameBooking) {
    await track(rt, await identityFromLead(rt.env, lead.id), {
      name: 'booking_scheduled',
      source: info.verified ? 'webhook' : 'client',
      props: { provider: info.provider, call_at: info.callAt, booking_ref: info.ref },
    });
    await Promise.all(['tier_a', 'tier_b', 'tier_c', 'abandoned', 'no_show'].map((sq) => cancelSequence(rt, lead.id, sq as 'tier_a')));
    rt.waitUntil(notifySlack(rt, fresh, '📅 Call booked', fresh.call_at ? [`Call: ${formatCallTime(fresh.call_at, rt.settings.SALES_TIMEZONE || 'Australia/Sydney')}`] : [], 'booked'));
  }
  // (Re)schedule the confirmation + reminders whenever we learn a new call time.
  if (!sameBooking || callChanged) await enqueueSequence(rt, fresh, 'booked');
  return fresh;
}

export async function markCancelled(rt: Runtime, lead: Lead, provider: string) {
  if (lead.booking_cancelled_at) return;
  await updateLead(rt.env, lead.id, { booking_cancelled_at: Date.now(), status: lead.status === 'booked' ? 'applied' : lead.status });
  await cancelSequence(rt, lead.id, 'booked');
  await track(rt, await identityFromLead(rt.env, lead.id), { name: 'booking_cancelled', source: 'webhook', props: { provider } });
  rt.waitUntil(notifySlack(rt, lead, '🚫 Call cancelled', [], 'cancelled'));
  // Put them back into the "get booked" follow-up for their tier.
  const tier = lead.tier_override ?? lead.tier;
  if (tier === 'A' || tier === 'B') await enqueueSequence(rt, lead, tier === 'A' ? 'tier_a' : 'tier_b');
}

/** Calendly: `Calendly-Webhook-Signature: t=<ts>,v1=<hmac(t.body)>`. */
export async function verifyCalendly(signingKey: string, rawBody: string, header: string | null) {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]));
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 5 * 60) return false; // replay protection
  return safeEqual(await hmacHex(signingKey, `${parts.t}.${rawBody}`), parts.v1);
}

interface CalendlyPayload {
  event: 'invitee.created' | 'invitee.canceled' | string;
  payload: {
    email?: string;
    uri?: string;
    rescheduled?: boolean;
    scheduled_event?: { start_time?: string; uri?: string };
    tracking?: { salesforce_uuid?: string | null; utm_term?: string | null };
  };
}

/** Finds the lead: our lead id passed through Calendly's tracking param first, then the invitee's email. */
async function findLead(rt: Runtime, leadId: string | null | undefined, email: string | null | undefined) {
  if (leadId) {
    const byId = await getLead(rt.env, leadId);
    if (byId) return byId;
  }
  return email ? getLeadByEmail(rt.env, email) : null;
}

export async function handleCalendly(rt: Runtime, body: CalendlyPayload) {
  const p = body.payload ?? {};
  const lead = await findLead(rt, p.tracking?.salesforce_uuid, p.email);
  if (!lead) return { matched: false };
  if (body.event === 'invitee.created') {
    const start = p.scheduled_event?.start_time ? Date.parse(p.scheduled_event.start_time) : null;
    await markBooked(rt, lead, { callAt: start, provider: 'calendly', ref: p.scheduled_event?.uri ?? p.uri ?? null, verified: true });
  } else if (body.event === 'invitee.canceled' && !p.rescheduled) {
    await markCancelled(rt, lead, 'calendly');
  }
  return { matched: true, leadId: lead.id };
}

/**
 * Generic booking webhook: understands Cal.com payloads natively, and a simple
 * shape for GoHighLevel / Zapier / Make: { email, start_time, status, lead_id }.
 */
export async function handleGenericBooking(rt: Runtime, body: Record<string, any>) {
  let email: string | undefined;
  let start: string | undefined;
  let ref: string | undefined;
  let cancelled = false;
  let leadId: string | undefined;
  let provider = 'webhook';

  if (body.triggerEvent && body.payload) {
    provider = 'cal.com';
    const p = body.payload;
    email = p.attendees?.[0]?.email ?? p.responses?.email?.value;
    start = p.startTime;
    ref = p.uid;
    leadId = p.metadata?.lead_id;
    cancelled = body.triggerEvent === 'BOOKING_CANCELLED';
  } else {
    email = body.email;
    start = body.start_time ?? body.startTime;
    ref = body.booking_id ?? body.id;
    leadId = body.lead_id;
    cancelled = /cancel/i.test(String(body.status ?? ''));
    provider = String(body.provider ?? 'webhook');
  }

  const lead = await findLead(rt, leadId, email);
  if (!lead) return { matched: false };
  if (cancelled) await markCancelled(rt, lead, provider);
  else await markBooked(rt, lead, { callAt: start ? Date.parse(start) || null : null, provider, ref: ref ?? null, verified: true });
  return { matched: true, leadId: lead.id };
}
