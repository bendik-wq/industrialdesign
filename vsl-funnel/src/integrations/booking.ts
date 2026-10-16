import type { Runtime } from '../app';
import { hmacHex, safeEqual } from '../lib/crypto';
import { type Lead, getLead, getLeadByEmail, updateLead } from '../funnel/leads';
import { identityFromLead, track } from '../tracking/track';
import { cancelSequence, enqueuePrecall, enqueueSequence, formatCallTime } from './email';
import { AI_CALLER } from '../config';
import { cancelCalls, queueCall } from './elevenlabs';
import { notifySlack } from './notify';
import { bookingFields, calendlyConnected, eventWithInvitees, syncCalendly } from './calendly';
import { applyLeadUpdate } from '../sales/outcomes';
import { startSms, stopSms } from './sms';

export interface BookingInfo {
  callAt: number | null;
  provider: string;
  ref: string | null;
  /** True when confirmed by the provider's webhook rather than reported by the browser. */
  verified: boolean;
  /** Same booking moved to a new time (Calendly reschedules create a new event). */
  rescheduled?: boolean;
  /** Extra lead fields from the provider (meeting link, host, answers…). */
  fields?: Partial<Record<keyof Lead, string | number | null>>;
}

/**
 * Marks a lead as booked. Idempotent per booking reference: the browser
 * (Calendly postMessage) usually reports first, then the signed webhook
 * arrives with the actual call time and upgrades the record.
 */
export async function markBooked(rt: Runtime, lead: Lead, info: BookingInfo) {
  // People imported straight from Calendly never went through the funnel: keep their record current, nothing else.
  if (lead.booking_source === 'calendly-direct') {
    await updateLead(rt.env, lead.id, { booked_at: lead.booked_at ?? Date.now(), call_at: info.callAt ?? lead.call_at, booking_ref: info.ref ?? lead.booking_ref, booking_cancelled_at: null, ...(info.fields ?? {}) });
    return (await getLead(rt.env, lead.id))!;
  }
  // A browser report is only a claim. When the provider can confirm it (signed webhook / API), show the
  // booked page now but hold every side effect — emails, AI call, pings, ad conversions — until it does.
  if (!info.verified && verificationAvailable(rt, info.provider)) {
    if (!lead.booked_at || lead.booking_cancelled_at) {
      await updateLead(rt.env, lead.id, {
        status: ['won', 'lost', 'showed'].includes(lead.status) ? lead.status : 'booked',
        booked_at: Date.now(), booking_provider: info.provider, booking_ref: info.ref ?? lead.booking_ref, booking_cancelled_at: null,
        booking_source: lead.booking_source ?? 'funnel',
      });
      await track(rt, await identityFromLead(rt.env, lead.id), { name: 'booking_reported_client', source: 'client', props: { provider: info.provider }, localOnly: true });
    }
    return (await getLead(rt.env, lead.id))!;
  }
  // The provider's confirmation of a booking the browser already reported counts as the new booking.
  const confirmsClaim = info.verified && Boolean(lead.booking_provider?.endsWith('-client'));
  const sameBooking = lead.booked_at && !lead.booking_cancelled_at && !confirmsClaim && (info.rescheduled || !info.ref || !lead.booking_ref || lead.booking_ref === info.ref);
  const callChanged = info.callAt && info.callAt !== lead.call_at;

  await updateLead(rt.env, lead.id, {
    status: ['won', 'lost', 'showed'].includes(lead.status) ? lead.status : 'booked',
    booked_at: lead.booked_at && sameBooking ? lead.booked_at : Date.now(),
    call_at: info.callAt ?? lead.call_at,
    booking_provider: info.verified || !lead.booking_provider ? info.provider : lead.booking_provider,
    booking_ref: info.ref ?? lead.booking_ref,
    booking_cancelled_at: null,
    booking_source: lead.booking_source ?? 'funnel',
    ...(info.fields ?? {}),
  });
  const fresh = (await getLead(rt.env, lead.id))!;

  if (!sameBooking) {
    await track(rt, await identityFromLead(rt.env, lead.id), {
      name: 'booking_scheduled',
      source: info.verified ? 'webhook' : 'client',
      props: { provider: info.provider, call_at: info.callAt, booking_ref: info.ref },
    });
    await Promise.all(['tier_a', 'tier_b', 'tier_c', 'abandoned', 'no_show', 'cancelled', 'nurture', 'lost'].map((sq) => cancelSequence(rt, lead.id, sq as 'tier_a')));
    await cancelCalls(rt, lead.id, ['speed_to_lead', 'rebook']);
    // Only call a number for a booking the provider confirmed: a browser claim alone can't make us ring anyone.
    if (info.verified) await queueCall(rt, fresh, 'confirm', AI_CALLER.confirmDelayMinutes);
    rt.waitUntil(notifySlack(rt, fresh, '📅 Call booked', fresh.call_at ? [`Call: ${formatCallTime(fresh.call_at, rt.settings.SALES_TIMEZONE || 'Australia/Sydney')}`] : [], 'booked'));
  }
  // (Re)schedule the confirmation + reminders whenever we learn a new call time.
  if (!sameBooking || callChanged) {
    await enqueueSequence(rt, fresh, 'booked');
    await stopSms(rt, lead.id, ['qualified', 'abandoned', 'no_show', 'cancelled']);
    await startSms(rt, fresh, 'booked');
    await enqueuePrecall(rt, fresh);
    await cancelSequence(rt, lead.id, 'prewebinar'); // the pre-call run takes over
  }
  return fresh;
}

/**
 * Cron: a booking the browser reported but the provider never confirmed (webhook lost, wrong account…) would
 * otherwise sit there with no reminders. After 30 minutes, tell the team once so a person can check it.
 */
export async function alertUnconfirmedBookings(rt: Runtime) {
  const now = Date.now();
  const { results } = await rt.env.DB.prepare(
    `SELECT * FROM leads WHERE status = 'booked' AND booking_cancelled_at IS NULL AND booking_provider LIKE '%-client'
       AND booked_at BETWEEN ? AND ? AND id NOT IN (SELECT substr(key, 13) FROM kv_state WHERE key LIKE 'unconfirmed:%') LIMIT 20`,
  ).bind(now - 3 * 86_400_000, now - 30 * 60_000).all<Lead>();
  for (const lead of results) {
    await rt.env.DB.prepare("INSERT OR IGNORE INTO kv_state (key, value) VALUES (?, ?)").bind(`unconfirmed:${lead.id}`, String(now)).run();
    rt.waitUntil(notifySlack(rt, lead, '⚠️ Booking not confirmed by the calendar', ['The page reported a booking 30+ minutes ago but Calendly hasn’t confirmed it, so no reminders are going out. Check the calendar and the Calendly webhook.'], 'booked'));
  }
  return results.length;
}

/** Can this provider's bookings be confirmed server-side (so a browser report can wait for it)? */
function verificationAvailable(rt: Runtime, provider: string) {
  if (provider.startsWith('calendly')) return calendlyConnected(rt.settings) || Boolean(rt.settings.CALENDLY_SIGNING_KEY);
  return Boolean(rt.settings.BOOKING_WEBHOOK_SECRET);
}

export async function markCancelled(rt: Runtime, lead: Lead, provider: string, ref?: string | null) {
  if (lead.booking_cancelled_at) return;
  // Only the lead's own current booking can be cancelled: a cancellation for some other booking made with
  // their email (anyone can type it on a public booking page) must not touch theirs.
  if (ref && lead.booking_ref && ref !== lead.booking_ref) return;
  if (lead.booking_source === 'calendly-direct') {
    await updateLead(rt.env, lead.id, { booking_cancelled_at: Date.now() });
    return;
  }
  await updateLead(rt.env, lead.id, { booking_cancelled_at: Date.now(), status: lead.status === 'booked' ? 'applied' : lead.status });
  await cancelSequence(rt, lead.id, 'booked');
  await cancelSequence(rt, lead.id, 'precall');
  await stopSms(rt, lead.id, ['booked']);
  const after = await getLead(rt.env, lead.id);
  if (after) await startSms(rt, after, 'cancelled');
  await cancelCalls(rt, lead.id, ['confirm']);
  await track(rt, await identityFromLead(rt.env, lead.id), { name: 'booking_cancelled', source: 'webhook', props: { provider } });
  rt.waitUntil(notifySlack(rt, lead, '🚫 Call cancelled', [], 'cancelled'));
  // Rebooking follow-up written from their application.
  await enqueueSequence(rt, lead, 'cancelled');
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
    old_invitee?: string | null;
    tracking?: { salesforce_uuid?: string | null; utm_term?: string | null };
  };
}

/** Finds the lead: our lead id passed through the booking tool first, then the booker's email. */
async function findLead(rt: Runtime, leadId: string | null | undefined, email: string | null | undefined) {
  if (leadId) {
    const byId = await getLead(rt.env, leadId);
    if (byId) return { lead: byId, byEmail: false };
  }
  const byEmail = email ? await getLeadByEmail(rt.env, email) : null;
  return { lead: byEmail, byEmail: true };
}

/**
 * A booking matched only by email (public booking pages don't verify it) may not replace the lead's active
 * booking, unless it's a reschedule of that very booking. Returns true when it's such a conflict; the team
 * is told and nothing on the lead changes.
 */
function emailOnlyConflict(rt: Runtime, lead: Lead, byEmail: boolean, ref: string | null, rescheduleOf: (bookingRef: string) => boolean) {
  if (!byEmail || !lead.booked_at || lead.booking_cancelled_at || !lead.booking_ref || !ref || ref === lead.booking_ref) return false;
  if (lead.booking_provider?.endsWith('-client')) return false; // the browser's claim being confirmed
  if (rescheduleOf(lead.booking_ref)) return false;
  rt.waitUntil(notifySlack(rt, lead, '⚠️ Second booking with this lead’s email', ['Someone booked another time using this lead’s email address. Their existing booking was left as it is; check in the booking tool before changing anything.'], 'booked'));
  return true;
}

export async function handleCalendly(rt: Runtime, body: CalendlyPayload) {
  const p = body.payload ?? {};
  const found = await findLead(rt, p.tracking?.salesforce_uuid, p.email);
  let lead = found.lead;
  const eventUri = p.scheduled_event?.uri ?? null;
  // With the API connected, pull the meeting link, host, answers and self-serve links too.
  const details = calendlyConnected(rt.settings) && eventUri && body.event === 'invitee.created'
    ? await eventWithInvitees(rt.settings, eventUri).catch(() => null)
    : null;
  const inv = details?.invitees.find((i) => i.uri === p.uri) ?? details?.invitees[0];
  if (!lead && body.event === 'invitee.created' && details && inv && calendlyConnected(rt.settings)) {
    // Booked straight from the Calendly link: keep it for the sales numbers via the sync (no emails).
    await syncCalendly(rt, { force: true, daysBack: 1 }).catch(() => null);
    return { matched: false, imported: true };
  }
  if (!lead) return { matched: false };
  if (body.event === 'invitee.created') {
    // Invitee URIs live under their event (…/scheduled_events/<event>/invitees/<id>), so a genuine reschedule
    // of the lead's booking names an old invitee of that event.
    if (emailOnlyConflict(rt, lead, found.byEmail, eventUri ?? p.uri ?? null, (ref) => Boolean(p.old_invitee && p.old_invitee.startsWith(`${ref}/invitees/`)))) return { matched: true, leadId: lead.id, conflict: true };
    const start = p.scheduled_event?.start_time ? Date.parse(p.scheduled_event.start_time) : null;
    const extra = details && inv ? bookingFields(rt, details.event, inv) : null;
    await markBooked(rt, lead, { callAt: extra?.callAt ?? start, provider: 'calendly', ref: eventUri ?? p.uri ?? null, verified: true, rescheduled: Boolean(p.old_invitee), fields: extra?.fields });
  } else if (body.event === 'invitee.canceled' && !p.rescheduled) {
    await markCancelled(rt, lead, 'calendly', eventUri ?? p.uri ?? null);
  } else if (body.event === 'invitee_no_show.created') {
    lead = (await getLead(rt.env, lead.id))!;
    if (lead.status === 'booked') await applyLeadUpdate(rt, lead, { status: 'no_show' });
  }
  return { matched: true, leadId: lead.id };
}

/** The browser saw a Calendly booking: confirm it through the API right away (exact time, host, links). */
export async function confirmClientBooking(rt: Runtime, lead: Lead, eventUri: string | null) {
  if (calendlyConnected(rt.settings) && eventUri && /^https:\/\/api\.calendly\.com\/scheduled_events\/[\w-]+$/.test(eventUri)) {
    const details = await eventWithInvitees(rt.settings, eventUri).catch(() => null);
    const inv = details?.invitees.find((i) => i.tracking?.salesforce_uuid === lead.id || (lead.email && i.email.toLowerCase() === lead.email));
    if (details && inv && details.event.status === 'active') {
      const { callAt, fields } = bookingFields(rt, details.event, inv);
      return markBooked(rt, lead, { callAt, provider: 'calendly', ref: eventUri, verified: true, fields });
    }
  }
  return markBooked(rt, lead, { callAt: null, provider: 'calendly-client', ref: eventUri, verified: false });
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
  let rescheduleUid: string | undefined;
  let provider = 'webhook';

  if (body.triggerEvent && body.payload) {
    provider = 'cal.com';
    const p = body.payload;
    email = p.attendees?.[0]?.email ?? p.responses?.email?.value;
    start = p.startTime;
    ref = p.uid;
    rescheduleUid = typeof p.rescheduleUid === 'string' ? p.rescheduleUid : typeof p.fromReschedule === 'string' ? p.fromReschedule : undefined;
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

  const { lead, byEmail } = await findLead(rt, leadId, email);
  if (!lead) return { matched: false };
  if (cancelled) await markCancelled(rt, lead, provider, ref ?? null);
  else if (emailOnlyConflict(rt, lead, byEmail, ref ?? null, (r) => rescheduleUid === r)) return { matched: true, leadId: lead.id, conflict: true };
  else await markBooked(rt, lead, { callAt: start ? Date.parse(start) || null : null, provider, ref: ref ?? null, verified: true });
  return { matched: true, leadId: lead.id };
}
