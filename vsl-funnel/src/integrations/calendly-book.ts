import type { Runtime } from '../app';
import { type Lead, getLead } from '../funnel/leads';
import { hit } from '../lib/ratelimit';
import {
  type CalEventType, type CalSlot, type CreatedInvitee, CalendlyError, availableTimes, bookingFields, cancelScheduledEvent, createInvitee, eventWithInvitees, listEventTypes,
} from './calendly';

/**
 * Booking a lead into Calendly through the Scheduling API (POST /invitees), shared by the two places that book for
 * a person: Sam's phone tools (./calendly-tools.ts) and one-tap booking on /book (../funnel/one-tap.ts).
 *
 * One code path for: the open-times check right before booking, the invitee request (our record's name, email and
 * time zone, the event type's location kind, the booking form's answers, our lead id in salesforce_uuid so the
 * webhook matches by id), "slot taken" detection, one booking at a time per lead (a lock shared by both callers),
 * the reschedule (new time first, then the old event cancelled) and the record: the same idempotent markBooked the
 * Calendly webhook uses, so the webhook that follows finds the same booking and changes nothing twice.
 */

const HOUR = 3600_000;
const DAY = 86_400_000;
/** No time inside the next two hours is offered or booked. */
export const MIN_LEAD_MS = 2 * HOUR;
/** Calendly's availability window is at most 7 days. */
export const WINDOW_MS = 7 * DAY - 60_000;

export function partsIn(ms: number, tz: string) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }).formatToParts(ms);
  const get = (k: string) => p.find((x) => x.type === k)?.value ?? '';
  return { weekday: get('weekday'), date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')), minute: Number(get('minute')) };
}

/** A real IANA zone name (what a browser reports), or null. */
export function validTimezone(tz: unknown): string | null {
  if (typeof tz !== 'string' || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz) || tz.length > 60) return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return null; }
}

export const CAL_EVENT = /^https:\/\/api\.calendly\.com\/scheduled_events\/[\w-]+$/;

/** The lead's current, upcoming booking (a reschedule replaces it), or 'unknown' when it isn't a Calendly event we can move. */
export function activeBooking(lead: Lead, now: number): { uri: string; at: number } | 'unknown' | null {
  if (!lead.booked_at || lead.booking_cancelled_at || lead.status !== 'booked' || !lead.call_at || lead.call_at <= now) return null;
  return lead.booking_ref && CAL_EVENT.test(lead.booking_ref) ? { uri: lead.booking_ref, at: lead.call_at } : 'unknown';
}

/** The location the event type asks for. Google Meet (google_conference), Zoom and the like take only their kind. */
export function locationFor(et: CalEventType, phone: string | null): Record<string, string> | undefined {
  const loc = et.locations?.[0];
  if (!loc?.kind) return undefined;
  if (loc.kind === 'outbound_call') return phone ? { kind: loc.kind, location: phone } : { kind: loc.kind };
  if (loc.kind === 'ask_invitee') return { kind: loc.kind, location: 'Video call' };
  return loc.location ? { kind: loc.kind, location: loc.location } : { kind: loc.kind };
}

export type CalQuestion = NonNullable<CalEventType['custom_questions']>[number];
export interface QA { question: string; answer: string; position: number }

/**
 * Answers for the event type's booking form. `map` answers a question from what we know (null = can't);
 * a required question it can't answer gets `filler`. Optional questions are answered only when mapped.
 * A choice question's answer must be one of its choices, so an unmatched one is left out.
 */
export function formAnswers(et: CalEventType, map: (q: CalQuestion) => string | null, filler: string): QA[] {
  const out: QA[] = [];
  for (const q of et.custom_questions ?? []) {
    if (!q.enabled) continue;
    let a = map(q);
    if (a && /select/i.test(q.type)) a = matchChoice(q, a);
    if (!a && q.required && !/select/i.test(q.type)) a = filler;
    if (a) out.push({ question: q.name, answer: a.slice(0, 1000), position: q.position });
  }
  return out;
}

/** The choice that matches `answer` (exact, then one containing the other), or null. */
export function matchChoice(q: CalQuestion, answer: string): string | null {
  const choices = q.answer_choices ?? [];
  const n = (s: string) => s.toLowerCase().replace(/[^a-z0-9$]+/g, ' ').trim();
  const want = n(answer);
  if (!want) return null;
  return choices.find((c) => n(c) === want) ?? choices.find((c) => n(c).includes(want) || want.includes(n(c))) ?? null;
}

/** Calendly's answer when the time went between showing it and booking it. */
export const slotTakenError = (e: unknown) =>
  e instanceof CalendlyError && (e.status === 404 || e.status === 409 || (e.status === 400 && /unavailable|not available|no longer|already|taken|start_time/i.test(e.body)));

// ───────────── event types and open times, cached ─────────────

const norm = (u: string) => u.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();

/**
 * The active event type whose booking page is `url` (a closer's calendar), or null. Strict: no "first one" guess,
 * so a closer's lead is never booked into someone else's calendar.
 */
export async function eventTypeForUrl(rt: Runtime, url: string): Promise<CalEventType | null> {
  const want = norm(url);
  if (!/^https:\/\/calendly\.com\/[\w.-]+\/[\w.-]+$/.test(want)) return null;
  const list = await listEventTypes(rt);
  return list.find((e) => norm(e.scheduling_url ?? '') === want) ?? null;
}

const TIMES_TTL_MS = 60_000;
const timesKey = (etUri: string) => `calendly:times:${etUri.split('/').pop()}`;

/** Open times for an event type over the next 7 days, cached for 60 seconds (kv_state). */
export async function cachedOpenTimes(rt: Runtime, etUri: string, now = Date.now()): Promise<number[]> {
  const key = timesKey(etUri);
  const row = await rt.env.DB.prepare('SELECT value FROM kv_state WHERE key = ?').bind(key).first<{ value: string }>();
  if (row) {
    try {
      const v = JSON.parse(row.value) as { at: number; times: number[] };
      if (now - v.at < TIMES_TTL_MS && now >= v.at) return v.times.filter((t) => t >= now + MIN_LEAD_MS);
    } catch { /* refetch */ }
  }
  const times = openTimes(await availableTimes(rt.settings, etUri, now + MIN_LEAD_MS, now + WINDOW_MS), now);
  await rt.env.DB.prepare('INSERT INTO kv_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, JSON.stringify({ at: now, times })).run();
  return times;
}

/** Drops the cached times (after a booking, or when a time turned out to be taken). */
export const forgetOpenTimes = (rt: Runtime, etUri: string) => rt.env.DB.prepare('DELETE FROM kv_state WHERE key = ?').bind(timesKey(etUri)).run().then(() => undefined, () => undefined);

export const openTimes = (slots: CalSlot[], now: number) => slots
  .filter((s) => s.status === 'available')
  .map((s) => Date.parse(s.start_time))
  .filter((t) => Number.isFinite(t) && t >= now + MIN_LEAD_MS && t <= now + 7 * DAY)
  .sort((a, b) => a - b);

// ───────────── booking ─────────────

export type BookMethod = 'phone' | 'one_tap';

export interface BookSlotOpts {
  slot: number;
  tz: string;
  now: number;
  method: BookMethod;
  /** Resolves the event type to book (inside the lock). */
  eventType: () => Promise<CalEventType | null>;
  /** Why this event type can't be booked for this person (its form), or null. */
  blocker: (et: CalEventType) => string | null;
  answers: (et: CalEventType) => QA[];
  tracking: Record<string, string>;
  /** The details for Calendly; defaults to the lead's own record. */
  invitee?: { name: string; first_name?: string | null; last_name?: string | null; email: string; phone?: string | null };
  cancelReason: string;
  /** Pull the event and invitee back from Calendly after booking (meeting link, host, answers), as the webhook does. */
  fetchDetails?: boolean;
  /** Runs after Calendly booked it and before the lead is marked booked. */
  onCreated?: (eventUri: string, existing: { uri: string; at: number } | null) => Promise<void>;
  onCancelOld?: (result: 'cancelled' | 'cancel_failed', existing: { uri: string; at: number }, error?: string) => Promise<void>;
}

export type BookSlotOutcome =
  | { kind: 'booked'; rescheduled: boolean; eventUri: string; created: CreatedInvitee; existing: { uri: string; at: number } | null; oldCancelled: boolean | null; lead: Lead; etUri: string }
  | { kind: 'slot_taken'; open: CalSlot[]; detail: string; etUri: string | null }
  | { kind: 'busy' }
  | { kind: 'unavailable'; why: string };

export const lockKey = (leadId: string) => `caltool-lock:${leadId}`;

/** Books `slot` for the lead (or moves their current Calendly booking to it). One at a time per lead. */
export async function bookLeadSlot(rt: Runtime, lead: Lead, o: BookSlotOpts): Promise<BookSlotOutcome> {
  const existingRaw = activeBooking(lead, o.now);
  if (existingRaw === 'unknown') return { kind: 'unavailable', why: 'current booking is not a Calendly event' };
  const existing = existingRaw;
  const key = lockKey(lead.id);
  if ((await hit(rt.env, key, 60_000, o.now)) > 1) return { kind: 'busy' };
  try {
    let et: CalEventType | null;
    let open: CalSlot[];
    try {
      et = await o.eventType();
      if (!et) return { kind: 'unavailable', why: 'no active Calendly event type' };
      const blocker = o.blocker(et);
      if (blocker) return { kind: 'unavailable', why: blocker };
      open = (await availableTimes(rt.settings, et.uri, o.now + MIN_LEAD_MS, o.now + WINDOW_MS)).filter((s) => s.status === 'available');
    } catch (e) {
      return { kind: 'unavailable', why: String(e instanceof Error ? e.message : e).slice(0, 300) };
    }
    if (!open.some((s) => Date.parse(s.start_time) === o.slot)) return { kind: 'slot_taken', open, detail: 'not in the open times', etUri: et.uri };

    const who = o.invitee ?? {
      name: [lead.first_name, lead.last_name].filter(Boolean).join(' ').trim() || (lead.email ?? '').split('@')[0],
      first_name: lead.first_name, last_name: lead.last_name, email: lead.email ?? '', phone: lead.phone,
    };
    const location = locationFor(et, who.phone ?? lead.phone);
    const qa = o.answers(et);
    const req: Record<string, unknown> = {
      event_type: et.uri,
      start_time: new Date(o.slot).toISOString(),
      invitee: { name: who.name, ...(who.first_name ? { first_name: who.first_name } : {}), ...(who.last_name ? { last_name: who.last_name } : {}), email: who.email, timezone: o.tz },
      ...(location ? { location } : {}),
      ...(qa.length ? { questions_and_answers: qa } : {}),
      // Our lead id rides in salesforce_uuid (as with the embed), so the webhook matches this lead by id, not by email.
      tracking: { ...o.tracking, salesforce_uuid: lead.id },
    };
    let created: CreatedInvitee;
    try {
      created = await createInvitee(rt.settings, req);
    } catch (e) {
      if (slotTakenError(e)) return { kind: 'slot_taken', open: open.filter((s) => Date.parse(s.start_time) !== o.slot), detail: (e as CalendlyError).body.slice(0, 300), etUri: et.uri };
      return { kind: 'unavailable', why: String(e instanceof Error ? e.message : e).slice(0, 300) };
    }
    const eventUri = created.event;
    await o.onCreated?.(eventUri, existing);

    let callAt: number | null = o.slot;
    let fields: Partial<Record<keyof Lead, string | number | null>> = { booking_reschedule_url: created.reschedule_url ?? null, booking_cancel_url: created.cancel_url ?? null };
    if (o.fetchDetails) {
      // The same lead fields the webhook writes (meeting link, host, answers, closer), when Calendly answers.
      const details = await eventWithInvitees(rt.settings, eventUri).catch(() => null);
      const inv = details?.invitees.find((i) => i.uri === created.uri) ?? details?.invitees[0];
      if (details && inv) {
        const b = bookingFields(rt, details.event, inv);
        callAt = b.callAt ?? callAt;
        fields = { ...fields, ...b.fields };
      }
    }
    const { markBooked } = await import('./booking');
    await markBooked(rt, lead, { callAt, provider: 'calendly', ref: eventUri, verified: true, rescheduled: Boolean(existing), method: o.method, fields });

    let oldCancelled: boolean | null = null;
    if (existing) {
      try {
        await cancelScheduledEvent(rt.settings, existing.uri, o.cancelReason);
        oldCancelled = true;
        await o.onCancelOld?.('cancelled', existing);
      } catch (e) {
        oldCancelled = false;
        await o.onCancelOld?.('cancel_failed', existing, String(e instanceof Error ? e.message : e).slice(0, 300));
      }
    }
    return { kind: 'booked', rescheduled: Boolean(existing), eventUri, created, existing, oldCancelled, lead: (await getLead(rt.env, lead.id)) ?? lead, etUri: et.uri };
  } finally {
    await rt.env.DB.prepare('DELETE FROM kv_state WHERE key = ?').bind(key).run().catch(() => null);
  }
}

