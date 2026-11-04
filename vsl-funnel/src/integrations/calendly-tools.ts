import type { Runtime } from '../app';
import { type Lead, getLead } from '../funnel/leads';
import { hmacHex, safeEqual } from '../lib/crypto';
import { newId } from '../lib/ids';
import { getSecret } from '../lib/secret';
import { hit, overLimit } from '../lib/ratelimit';
import type { Settings } from '../settings';
import { type CalEventType, type CalSlot, CalendlyError, availableTimes, bookingEventType, calendlyConnected, cancelScheduledEvent, createInvitee } from './calendly';
import { leadTimezone } from './elevenlabs';

/**
 * Live calendar tools for the ElevenLabs phone agents (Sam): during a confirmation, speed-to-lead, rebook or
 * callback call, Sam looks up real open times in Calendly and books (or moves) the strategy call the person picks.
 *
 * ElevenLabs calls two webhook ("server") tools on our side:
 *   POST /hooks/elevenlabs/tools/availability   { lead_token, conversation_id, preferred_day?, part_of_day? }
 *   POST /hooks/elevenlabs/tools/book           { lead_token, conversation_id, slot_id }
 *
 * Security, in this order:
 *  1. x-funnel-tool-secret: a secret derived from the app secret (like the initiation webhook's), set on the tool
 *     in ElevenLabs by "Create / update agent". Missing or wrong → 401.
 *  2. lead_token: an HMAC of the lead id, an expiry and a scope, minted by us when the call starts (outbound: outboundVars in elevenlabs.ts;
 *     callbacks: the initiation webhook, known callers only) and passed as a dynamic variable. The tool body takes it
 *     from the variable (dynamic_variable binding), never from the model. Forged, expired or for a deleted lead → 403.
 *     The model never supplies a lead id, a name or an email: the booking uses the lead's own record.
 *  3. Per-lead limits: 12 look-ups and 4 booking attempts an hour, at most 2 bookings a day, one booking at a time.
 *
 * Nothing here calls or texts anyone. Calendly sends the invite and the cancellation itself. The fallback (booking
 * failed or isn't possible) is the existing "email the booking link" path, once per conversation, never to an
 * unsubscribed lead. Every tool call is logged in ai_booking_actions and shown on the lead in Funnel HQ.
 *
 * A booking made here also fires the Calendly webhook. The tool applies it through the same idempotent markBooked the
 * webhook uses (so a reschedule's "old event cancelled" webhook can't race ahead of the new booking), and the webhook
 * that follows finds the same booking and changes nothing twice.
 */

export const TOOL_HEADER = 'x-funnel-tool-secret';
export const TOOL_NAMES = { availability: 'check_availability', book: 'book_strategy_call' } as const;
export const RESCHEDULE_REASON = 'Rescheduled by phone with Sam (AI assistant)';
const HOUR = 3600_000;
const DAY = 86_400_000;
/** No time inside the next two hours is offered or booked. */
export const MIN_LEAD_MS = 2 * HOUR;
const WINDOW_MS = 7 * DAY - 60_000;
const TOKEN_TTL_MS = 3 * HOUR;

export const bookingToolsOn = (s: Pick<Settings, 'CALENDLY_API_TOKEN' | 'AI_CALL_BOOKING_TOOLS'>) =>
  calendlyConnected(s as Settings) && (s.AI_CALL_BOOKING_TOOLS ?? '').trim().toLowerCase() !== 'false';

/** Header value ElevenLabs sends on every tool call. */
export const toolSecret = async (rt: Runtime) => (await hmacHex(await getSecret(rt.env), 'elevenlabs-tools')).slice(0, 40);

// ───────────── the lead token ─────────────

export type TokenScope = 'out' | 'in';

/** `<lead id>.<expiry, base36 seconds>.<scope>.<hmac>`: binds a conversation's tool calls to one lead. */
export async function leadToken(rt: Runtime, leadId: string, scope: TokenScope, now = Date.now()) {
  const body = `${leadId}.${Math.floor((now + TOKEN_TTL_MS) / 1000).toString(36)}.${scope}`;
  return `${body}.${(await hmacHex(await getSecret(rt.env), `lead-token:${body}`)).slice(0, 32)}`;
}

export async function verifyLeadToken(rt: Runtime, token: unknown, now = Date.now()): Promise<{ leadId: string; scope: TokenScope } | null> {
  if (typeof token !== 'string' || token.length > 200) return null;
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [leadId, exp, scope, sig] = parts;
  if (!/^[\w-]{1,64}$/.test(leadId) || !/^[0-9a-z]{1,10}$/.test(exp) || (scope !== 'out' && scope !== 'in')) return null;
  const want = (await hmacHex(await getSecret(rt.env), `lead-token:${leadId}.${exp}.${scope}`)).slice(0, 32);
  if (!safeEqual(sig, want)) return null;
  if (parseInt(exp, 36) * 1000 < now) return null;
  return { leadId, scope };
}

// ───────────── speaking times ─────────────

/** "Australia/Sydney" → "Sydney time". */
export function tzLabel(tz: string) {
  if (!tz || tz === 'UTC') return 'UTC';
  return `${tz.split('/').pop()!.replace(/_/g, ' ')} time`;
}

function partsIn(ms: number, tz: string) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }).formatToParts(ms);
  const get = (k: string) => p.find((x) => x.type === k)?.value ?? '';
  return { weekday: get('weekday'), date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')), minute: Number(get('minute')) };
}

/** "Thursday 12 November at 10 am" / "at 10:30 am", in `tz`. */
export function spokenTime(ms: number, tz: string) {
  const day = new Intl.DateTimeFormat('en-AU', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(ms).replace(',', '');
  const { hour, minute } = partsIn(ms, tz);
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const time = hour === 12 && minute === 0 ? 'midday' : `${h12}${minute ? `:${String(minute).padStart(2, '0')}` : ''} ${hour < 12 ? 'am' : 'pm'}`;
  return `${day} at ${time}`;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
export type PartOfDay = 'morning' | 'afternoon' | 'evening' | 'any';

/** Up to `max` open times: the person's preferred day and part of day when given, spread across days. */
export function pickSlots(slots: CalSlot[], tz: string, now: number, prefs: { day?: string; part?: string } = {}, max = 4) {
  const open = slots
    .filter((s) => s.status === 'available')
    .map((s) => Date.parse(s.start_time))
    .filter((t) => Number.isFinite(t) && t >= now + MIN_LEAD_MS && t <= now + 7 * DAY)
    .sort((a, b) => a - b);
  const day = (prefs.day ?? '').trim().toLowerCase();
  const today = partsIn(now, tz).date;
  const tomorrow = partsIn(now + DAY, tz).date;
  const dayOk = (t: number) => {
    if (!day || day === 'any') return true;
    const p = partsIn(t, tz);
    if (day === 'today') return p.date === today;
    if (day === 'tomorrow') return p.date === tomorrow;
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) return p.date === day;
    const wd = WEEKDAYS.find((w) => day.startsWith(w.slice(0, 3)));
    return wd ? p.weekday.toLowerCase() === wd : true;
  };
  const part = (prefs.part ?? 'any').toLowerCase();
  const partOk = (t: number) => {
    const h = partsIn(t, tz).hour;
    return part === 'morning' ? h < 12 : part === 'afternoon' ? h >= 12 && h < 17 : part === 'evening' ? h >= 17 : true;
  };
  const matching = open.filter((t) => dayOk(t) && partOk(t));
  const pool = matching.length ? matching : open;
  // Spread: the first time on each day, then fill in order.
  const picked: number[] = [];
  const seenDays = new Set<string>();
  for (const t of pool) {
    const d = partsIn(t, tz).date;
    if (seenDays.has(d)) continue;
    seenDays.add(d);
    picked.push(t);
    if (picked.length >= max) break;
  }
  for (const t of pool) {
    if (picked.length >= max) break;
    if (!picked.includes(t)) picked.push(t);
  }
  picked.sort((a, b) => a - b);
  return { times: picked, matchedPreference: matching.length > 0 || (!day && part === 'any') };
}

const slotsOut = (times: number[], tz: string) => times.map((t) => ({ slot_id: new Date(t).toISOString(), spoken: spokenTime(t, tz) }));

// ───────────── the log ─────────────

type Action = 'availability' | 'book' | 'reschedule' | 'cancel_old';
async function logAction(rt: Runtime, row: { leadId: string; conv: string | null; action: Action; result: string; slotAt?: number | null; eventUri?: string | null; detail?: unknown }) {
  await rt.env.DB.prepare(`INSERT INTO ai_booking_actions (id, lead_id, conversation_id, action, result, slot_at, event_uri, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(newId('ba'), row.leadId, row.conv, row.action, row.result, row.slotAt ?? null, row.eventUri ?? null, row.detail === undefined ? null : JSON.stringify(row.detail).slice(0, 4000), Date.now())
    .run();
}

/** What the booking tools did on one conversation: finishCall/finishInbound use it so no second link email goes out. */
export async function toolOutcome(rt: Runtime, conversationId: string | null | undefined) {
  if (!conversationId) return { booked: false, linkEmailed: false };
  const { results } = await rt.env.DB.prepare(`SELECT result FROM ai_booking_actions WHERE conversation_id = ?`).bind(conversationId).all<{ result: string }>();
  return { booked: results.some((r) => r.result === 'booked' || r.result === 'rescheduled'), linkEmailed: results.some((r) => r.result === 'fallback_link') };
}

/** True when Sam booked or moved this lead's call by phone in the last 30 minutes (so no confirmation call rings them right after). */
export async function bookedByPhoneRecently(rt: Runtime, leadId: string, now = Date.now()) {
  const row = await rt.env.DB.prepare(`SELECT 1 AS x FROM ai_booking_actions WHERE lead_id = ? AND result IN ('booked', 'rescheduled') AND created_at > ? LIMIT 1`).bind(leadId, now - 30 * 60_000).first();
  return Boolean(row);
}

/** The lead's actions for Funnel HQ. */
export async function leadBookingActions(rt: Pick<Runtime, 'env'>, leadId: string) {
  const { results } = await rt.env.DB.prepare(`SELECT id, conversation_id, action, result, slot_at, event_uri, detail, created_at FROM ai_booking_actions WHERE lead_id = ? ORDER BY created_at DESC LIMIT 50`).bind(leadId).all();
  return results;
}

// ───────────── what can be booked ─────────────

/** Why this event type can't be booked by phone (a required choice question we can't answer for the person), or null. */
export function formBlocker(et: CalEventType): string | null {
  const q = (et.custom_questions ?? []).find((x) => x.enabled && x.required && /select/i.test(x.type));
  return q ? `The Calendly booking form has a required choice question ("${q.name.slice(0, 80)}") that can’t be answered for the person.` : null;
}

function answersFor(et: CalEventType, lead: Lead) {
  const out: { question: string; answer: string; position: number }[] = [];
  for (const q of et.custom_questions ?? []) {
    if (!q.enabled || !q.required) continue;
    if (q.type === 'phone_number') { if (lead.phone) out.push({ question: q.name, answer: lead.phone, position: q.position }); continue; }
    out.push({ question: q.name, answer: 'Booked by phone with Sam (AI assistant). Their answers are in their application.', position: q.position });
  }
  return out;
}

function locationFor(et: CalEventType, lead: Lead): Record<string, string> | undefined {
  const loc = et.locations?.[0];
  if (!loc?.kind) return undefined;
  if (loc.kind === 'outbound_call') return lead.phone ? { kind: loc.kind, location: lead.phone } : { kind: loc.kind };
  if (loc.kind === 'ask_invitee') return { kind: loc.kind, location: 'Video call' };
  return loc.location ? { kind: loc.kind, location: loc.location } : { kind: loc.kind };
}

const CAL_EVENT = /^https:\/\/api\.calendly\.com\/scheduled_events\/[\w-]+$/;

/** The lead's current, upcoming booking (a reschedule replaces it), or 'unknown' when it isn't a Calendly event we can move. */
function activeBooking(lead: Lead, now: number): { uri: string; at: number } | 'unknown' | null {
  if (!lead.booked_at || lead.booking_cancelled_at || lead.status !== 'booked' || !lead.call_at || lead.call_at <= now) return null;
  return lead.booking_ref && CAL_EVENT.test(lead.booking_ref) ? { uri: lead.booking_ref, at: lead.call_at } : 'unknown';
}

// ───────────── the tools ─────────────

export interface ToolResult { status: number; body: Record<string, unknown> }
const reply = (body: Record<string, unknown>, status = 200): ToolResult => ({ status, body });

const SAY_LINK = 'Booking by phone didn’t work this time. Say you’ll email them a link to pick a time instead, and that it will be in their inbox shortly. Do not say any time is booked.';
const SAY_TEAM = 'Booking by phone isn’t possible for this person. Say Josh’s team will be in touch by email to find a time. Do not say any time is booked, and do not offer times.';

/** The fallback: the existing booking-link email (once per conversation, never to an unsubscribed lead). */
async function fallback(rt: Runtime, lead: Lead, conv: string | null, action: Action, why: string, extra: Record<string, unknown> = {}): Promise<ToolResult> {
  const done = await toolOutcome(rt, conv);
  if (!lead.email || lead.unsubscribed_at) {
    await logAction(rt, { leadId: lead.id, conv, action, result: 'not_available', detail: { why } });
    return reply({ ok: false, result: 'not_available', message: SAY_TEAM, ...extra });
  }
  if (!done.linkEmailed) {
    const { sendLinkEmail } = await import('./voice');
    await sendLinkEmail(rt, lead);
  }
  await logAction(rt, { leadId: lead.id, conv, action, result: 'fallback_link', detail: { why } });
  return reply({ ok: false, result: 'link_emailed', message: SAY_LINK, ...extra });
}

const cleanConv = (v: unknown) => (typeof v === 'string' && /^[\w-]{1,100}$/.test(v) ? v : null);

/** Checks the secret header and the lead token, then runs one tool. */
export async function handleBookingTool(rt: Runtime, action: string, header: string | undefined, body: Record<string, unknown>, now = Date.now()): Promise<ToolResult> {
  if (!header || !safeEqual(header, await toolSecret(rt))) return reply({ error: 'unauthorised' }, 401);
  if (action !== 'availability' && action !== 'book') return reply({ error: 'unknown tool' }, 404);
  const tok = await verifyLeadToken(rt, body.lead_token, now);
  if (!tok) return reply({ error: 'forbidden' }, 403);
  const lead = await getLead(rt.env, tok.leadId);
  if (!lead) return reply({ error: 'forbidden' }, 403);
  const conv = cleanConv(body.conversation_id);
  if (!bookingToolsOn(rt.settings)) {
    await logAction(rt, { leadId: lead.id, conv, action: action === 'book' ? 'book' : 'availability', result: 'not_available', detail: { why: 'booking tools off' } });
    return reply({ ok: false, result: 'not_available', message: 'Live booking is off. Do not offer times: the link to pick a time is emailed after the call.' });
  }
  if (lead.do_not_call_at) return reply({ ok: false, result: 'not_available', message: SAY_TEAM });
  if (await overLimit(rt.env, `caltool:${action}:${lead.id}`, action === 'book' ? 4 : 12, HOUR, now)) {
    await logAction(rt, { leadId: lead.id, conv, action: action === 'book' ? 'book' : 'availability', result: 'rate_limited' });
    return action === 'book' ? fallback(rt, lead, conv, 'book', 'rate limited') : reply({ ok: false, result: 'rate_limited', message: 'Too many look-ups. Offer the times you already have, or say you’ll email a link to pick a time.' });
  }
  return action === 'availability' ? availability(rt, lead, conv, body, now) : book(rt, lead, conv, body, now);
}

async function availability(rt: Runtime, lead: Lead, conv: string | null, body: Record<string, unknown>, now: number): Promise<ToolResult> {
  const tz = leadTimezone(lead, rt.settings.SALES_TIMEZONE);
  const prefs = { day: typeof body.preferred_day === 'string' ? body.preferred_day.slice(0, 40) : '', part: typeof body.part_of_day === 'string' ? body.part_of_day.slice(0, 20) : 'any' };
  if (!lead.email) return fallback(rt, lead, conv, 'availability', 'no email on file');
  if (activeBooking(lead, now) === 'unknown') return fallback(rt, lead, conv, 'availability', 'current booking is not a Calendly event');
  let et: CalEventType | null;
  let slots: CalSlot[];
  try {
    et = await bookingEventType(rt);
    if (!et) return fallback(rt, lead, conv, 'availability', 'no active Calendly event type');
    const blocker = formBlocker(et);
    if (blocker) return fallback(rt, lead, conv, 'availability', blocker);
    slots = await availableTimes(rt.settings, et.uri, now + MIN_LEAD_MS, now + WINDOW_MS);
  } catch (e) {
    return fallback(rt, lead, conv, 'availability', String(e instanceof Error ? e.message : e).slice(0, 300));
  }
  const { times, matchedPreference } = pickSlots(slots, tz, now, prefs);
  if (!times.length) {
    await logAction(rt, { leadId: lead.id, conv, action: 'availability', result: 'none_open', detail: { prefs } });
    return fallback(rt, lead, conv, 'availability', 'no open times in the next 7 days', { result: 'none_open' });
  }
  await logAction(rt, { leadId: lead.id, conv, action: 'availability', result: 'offered', detail: { prefs, times: times.map((t) => new Date(t).toISOString()), tz } });
  return reply({
    ok: true,
    result: 'offered',
    timezone: tzLabel(tz),
    slots: slotsOut(times, tz),
    message: `${matchedPreference ? '' : 'Nothing is open at the time they asked for; these are the nearest open times. '}Offer two or three of these times exactly as written, saying they are in ${tzLabel(tz)}, and ask which works best. When they pick one, call ${TOOL_NAMES.book} with its slot_id. Never offer a time that is not in this list.`,
  });
}

async function book(rt: Runtime, lead: Lead, conv: string | null, body: Record<string, unknown>, now: number): Promise<ToolResult> {
  const tz = leadTimezone(lead, rt.settings.SALES_TIMEZONE);
  const raw = typeof body.slot_id === 'string' ? body.slot_id.trim() : '';
  const slot = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/.test(raw) ? Date.parse(raw) : NaN;
  if (!Number.isFinite(slot) || slot < now + MIN_LEAD_MS || slot > now + 7 * DAY) {
    await logAction(rt, { leadId: lead.id, conv, action: 'book', result: 'invalid', detail: { slot_id: raw.slice(0, 40) } });
    return reply({ ok: false, result: 'invalid_slot', message: `That slot_id isn’t one of the open times. Call ${TOOL_NAMES.availability} and offer times from its list.` });
  }
  if (!lead.email) return fallback(rt, lead, conv, 'book', 'no email on file');
  const existing = activeBooking(lead, now);
  if (existing === 'unknown') return fallback(rt, lead, conv, 'book', 'current booking is not a Calendly event');
  if (existing && existing.at === slot) return reply({ ok: true, result: 'already_booked', message: `They are already booked for ${spokenTime(slot, tz)}, ${tzLabel(tz)}. Say so in one sentence.` });
  const action: Action = existing ? 'reschedule' : 'book';
  const { results: recent } = await rt.env.DB.prepare(`SELECT COUNT(*) AS n FROM ai_booking_actions WHERE lead_id = ? AND result IN ('booked', 'rescheduled') AND created_at > ?`).bind(lead.id, now - DAY).all<{ n: number }>();
  if ((recent[0]?.n ?? 0) >= 2) return fallback(rt, lead, conv, action, 'already booked twice by phone today');

  // One booking at a time per lead (the model can fire a tool twice).
  const lockKey = `caltool-lock:${lead.id}`;
  if ((await hit(rt.env, lockKey, 60_000, now)) > 1) return reply({ ok: false, result: 'busy', message: 'A booking for this person is already going through. Wait a moment, then tell them what the first booking result said.' });
  try {
    let et: CalEventType | null;
    let open: CalSlot[];
    try {
      et = await bookingEventType(rt);
      if (!et) return await fallback(rt, lead, conv, action, 'no active Calendly event type');
      const blocker = formBlocker(et);
      if (blocker) return await fallback(rt, lead, conv, action, blocker);
      open = (await availableTimes(rt.settings, et.uri, now + MIN_LEAD_MS, now + WINDOW_MS)).filter((s) => s.status === 'available');
    } catch (e) {
      return await fallback(rt, lead, conv, action, String(e instanceof Error ? e.message : e).slice(0, 300));
    }
    const slotTaken = async (detail: unknown) => {
      const alt = pickSlots(open.filter((s) => Date.parse(s.start_time) !== slot), tz, now, { day: partsIn(slot, tz).date });
      await logAction(rt, { leadId: lead.id, conv, action, result: 'slot_taken', slotAt: slot, detail: { detail, offered: alt.times.map((t) => new Date(t).toISOString()) } });
      if (!alt.times.length) return fallback(rt, lead, conv, action, 'slot taken and nothing else open', { result: 'slot_taken' });
      return reply({ ok: false, result: 'slot_taken', timezone: tzLabel(tz), slots: slotsOut(alt.times, tz), message: `That time was just taken. Say so briefly and offer two or three of these instead, in ${tzLabel(tz)}. Nothing is booked yet.` });
    };
    if (!open.some((s) => Date.parse(s.start_time) === slot)) return await slotTaken('not in the open times');

    const name = [lead.first_name, lead.last_name].filter(Boolean).join(' ').trim() || lead.email.split('@')[0];
    const location = locationFor(et, lead);
    const qa = answersFor(et, lead);
    const req: Record<string, unknown> = {
      event_type: et.uri,
      start_time: new Date(slot).toISOString(),
      invitee: { name, ...(lead.first_name ? { first_name: lead.first_name } : {}), ...(lead.last_name ? { last_name: lead.last_name } : {}), email: lead.email, timezone: tz },
      ...(location ? { location } : {}),
      ...(qa.length ? { questions_and_answers: qa } : {}),
      // Our lead id rides in salesforce_uuid (as with the embed), so the webhook matches this lead by id, not by email.
      tracking: { utm_source: 'ai_call', utm_medium: 'phone', salesforce_uuid: lead.id },
    };
    let created;
    try {
      created = await createInvitee(rt.settings, req);
    } catch (e) {
      if (e instanceof CalendlyError && (e.status === 404 || e.status === 409 || (e.status === 400 && /unavailable|not available|no longer|already|taken|start_time/i.test(e.body)))) return await slotTaken(e.body.slice(0, 300));
      return await fallback(rt, lead, conv, action, String(e instanceof Error ? e.message : e).slice(0, 300));
    }
    const eventUri = created.event;
    // Logged before the lead is updated: markBooked's confirmation call checks it (no "confirm" call right after Sam booked it).
    await logAction(rt, { leadId: lead.id, conv, action, result: existing ? 'rescheduled' : 'booked', slotAt: slot, eventUri, detail: existing ? { old_event: existing.uri, old_at: existing.at } : undefined });
    const { markBooked } = await import('./booking');
    await markBooked(rt, lead, {
      callAt: slot, provider: 'calendly', ref: eventUri, verified: true, rescheduled: Boolean(existing),
      fields: { booking_reschedule_url: created.reschedule_url ?? null, booking_cancel_url: created.cancel_url ?? null },
    });
    const when = `${spokenTime(slot, tz)}, ${tzLabel(tz)}`;
    const { notifySlack } = await import('./notify');
    let oldNote = '';
    if (existing) {
      try {
        await cancelScheduledEvent(rt.settings, existing.uri, RESCHEDULE_REASON);
        await logAction(rt, { leadId: lead.id, conv, action: 'cancel_old', result: 'cancelled', slotAt: existing.at, eventUri: existing.uri });
        oldNote = ` Their old time, ${spokenTime(existing.at, tz)}, is cancelled.`;
      } catch (e) {
        await logAction(rt, { leadId: lead.id, conv, action: 'cancel_old', result: 'cancel_failed', slotAt: existing.at, eventUri: existing.uri, detail: { error: String(e instanceof Error ? e.message : e).slice(0, 300) } });
        rt.waitUntil(notifySlack(rt, lead, '⚠️ Old booking not cancelled', [`Sam moved the call to ${when}, but the old booking couldn’t be cancelled automatically. Cancel it in Calendly.`], 'booked'));
        oldNote = ' The team will remove their old booking.';
      }
    }
    rt.waitUntil(notifySlack(rt, lead, existing ? '📅 Call moved by phone (Sam)' : '📅 Call booked by phone (Sam)', [`New time: ${when}`], 'booked'));
    return reply({
      ok: true,
      result: existing ? 'rescheduled' : 'booked',
      booked_for: when,
      message: `Booked for ${when}.${oldNote} Confirm it in one sentence, for example: "Done, you’re booked for ${when}, and the calendar invite comes from Calendly by email." Then carry on with the call.`,
    });
  } finally {
    await rt.env.DB.prepare('DELETE FROM kv_state WHERE key = ?').bind(lockKey).run().catch(() => null);
  }
}

// ───────────── the ElevenLabs tool definitions ─────────────

/** The two webhook tools as ElevenLabs tool configs (POST /v1/convai/tools { tool_config }). */
export async function toolConfigs(rt: Runtime) {
  const headers = { [TOOL_HEADER]: await toolSecret(rt) };
  const bound = {
    lead_token: { type: 'string', dynamic_variable: 'lead_token' },
    conversation_id: { type: 'string', dynamic_variable: 'system__conversation_id' },
  };
  return [
    {
      type: 'webhook',
      name: TOOL_NAMES.availability,
      description: 'Looks up real open times for the strategy call with Josh’s team in the next 7 days, in the person’s own time zone. Call it before offering any time; never offer a time it did not return.',
      response_timeout_secs: 20,
      api_schema: {
        url: `${rt.origin}/hooks/elevenlabs/tools/availability`,
        method: 'POST',
        request_headers: headers,
        request_body_schema: {
          type: 'object',
          required: ['lead_token', 'conversation_id'],
          properties: {
            ...bound,
            preferred_day: { type: 'string', description: 'The day the person asked for, as one word or date: today, tomorrow, a weekday such as thursday, or YYYY-MM-DD. Empty if they have no preference.' },
            part_of_day: { type: 'string', enum: ['morning', 'afternoon', 'evening', 'any'], description: 'The part of the day the person prefers: morning, afternoon, evening, or any.' },
          },
        },
      },
    },
    {
      type: 'webhook',
      name: TOOL_NAMES.book,
      description: 'Books the strategy call at the time the person picked (or moves their existing booking to it). Use only a slot_id returned by check_availability. Calendly emails the calendar invite.',
      response_timeout_secs: 30,
      api_schema: {
        url: `${rt.origin}/hooks/elevenlabs/tools/book`,
        method: 'POST',
        request_headers: headers,
        request_body_schema: {
          type: 'object',
          required: ['lead_token', 'conversation_id', 'slot_id'],
          properties: {
            ...bound,
            slot_id: { type: 'string', description: 'The slot_id of the time the person picked, copied exactly from the check_availability result.' },
          },
        },
      },
    },
  ];
}

/**
 * Creates or updates the two tools in the ElevenLabs workspace (ids kept in kv_state) and returns their ids, for
 * the agents' prompt.tool_ids. Returns null when the tools API isn't available, so the caller can inline them.
 */
export async function ensureElevenTools(rt: Runtime): Promise<string[] | null> {
  const { el } = await import('./elevenlabs');
  const configs = await toolConfigs(rt);
  const row = await rt.env.DB.prepare("SELECT value FROM kv_state WHERE key = 'elevenlabs:booking_tools'").first<{ value: string }>();
  let saved: Record<string, string> = {};
  try { saved = row ? JSON.parse(row.value) : {}; } catch { saved = {}; }
  const ids: string[] = [];
  try {
    for (const cfg of configs) {
      const id = saved[cfg.name];
      let got: string | null = null;
      if (id) got = await el(rt.settings, `/v1/convai/tools/${encodeURIComponent(id)}`, { method: 'PATCH', body: { tool_config: cfg } }).then(() => id).catch(() => null);
      if (!got) got = (await el<{ id: string }>(rt.settings, '/v1/convai/tools', { method: 'POST', body: { tool_config: cfg } })).id;
      saved[cfg.name] = got;
      ids.push(got);
    }
  } catch (e) {
    console.error('elevenlabs tools', String(e).slice(0, 300));
    return null;
  }
  await rt.env.DB.prepare("INSERT INTO kv_state (key, value) VALUES ('elevenlabs:booking_tools', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(saved)).run();
  return ids;
}

/** What buildAgent / buildInboundAgent put on the prompt: tool ids when the workspace has them, else the inline configs. */
export type AgentTools = { ids: string[] } | { inline: Awaited<ReturnType<typeof toolConfigs>> } | null;

export async function agentTools(rt: Runtime): Promise<AgentTools> {
  if (!bookingToolsOn(rt.settings)) return null;
  const ids = await ensureElevenTools(rt);
  return ids ? { ids } : { inline: await toolConfigs(rt) };
}

/** Sample times for Funnel HQ → Sandbox (labelled sample there; nothing is looked up). */
export function sampleSlots(from: number, tz: string) {
  const out: string[] = [];
  for (let d = 1; out.length < 3 && d < 10; d++) {
    const base = from + d * DAY;
    const p = partsIn(base, tz);
    if (p.weekday === 'Saturday' || p.weekday === 'Sunday') continue;
    const hour = out.length === 1 ? 14 : 10;
    const t = base - ((p.hour * 60 + p.minute) * 60_000) + hour * HOUR; // that day at `hour` local (DST shifts aside)
    out.push(spokenTime(Math.floor(t / 900_000) * 900_000, tz));
  }
  return out;
}
