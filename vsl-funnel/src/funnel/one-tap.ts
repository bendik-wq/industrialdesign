import type { Runtime } from '../app';
import { APPLICATION } from '../config';
import { type CalEventType, calendlyConnected } from '../integrations/calendly';
import {
  MIN_LEAD_MS, type CalQuestion, activeBooking, bookLeadSlot, cachedOpenTimes, eventTypeForUrl, forgetOpenTimes, formAnswers, matchChoice, openTimes, partsIn, validTimezone,
} from '../integrations/calendly-book';
import { leadTimezone } from '../integrations/elevenlabs';
import { recordBookingMethod } from '../integrations/booking';
import { tzLabel } from '../integrations/calendly-tools';
import { overLimit } from '../lib/ratelimit';
import { type Settings, flag } from '../settings';
import type { Rep } from '../sales/reps';
import { calendarFor } from '../sales/reps';
import { identityFromLead, track } from '../tracking/track';
import { type Lead, cleanName, effectiveTier, getLead, normalisePhone, parseAnswers, updateLead, validateEmail } from './leads';
import { bookingRepFor } from './routing';

/**
 * One-tap booking on /book. A qualified applicant sees the next open times of their closer's Calendly event type (in
 * their own time zone), taps one, checks their details in a sheet and presses "Confirm my call": we book it through
 * Calendly's Scheduling API with their application data (the same shared booking path Sam's phone tools use,
 * ../integrations/calendly-book.ts), mark the lead booked exactly as the Calendly webhook does, and send them to the
 * booked page. Anything that stops it (Calendly down, a booking form we can't fill, the closer's calendar not being
 * an event type of the connected account) falls back to the Calendly embed with their details filled in.
 *
 *   POST /api/book/times    { tz?, more? }                         → { ok, tz, tzLabel, closer, days[] } | { fallback }
 *   POST /api/book/confirm  { slot, name?, email?, phone?, reschedule? } → { ok, next } | { result: 'slot_taken', days[] } | { fallback }
 *
 * Only the lead themselves: the browser must carry their linked visitor cookie (set by their own application, or by
 * the signed links in our emails and texts). Same-origin only (the /api guard), rate limited per connection and per lead.
 */

const DAY = 86_400_000;
const HOUR = 3600_000;

export const oneTapOn = (s: Pick<Settings, 'CALENDLY_API_TOKEN' | 'BOOK_ONE_TAP'>) => calendlyConnected(s as Settings) && flag(s.BOOK_ONE_TAP, true);

export const ONE_TAP_COPY = {
  slotTaken: 'Someone took that time a moment ago. Here are the times open now.',
  fallback: 'We couldn’t book that time from here. Pick a time in the calendar below. Your details are filled in.',
  busy: 'Your booking is already going through. Give it a few seconds.',
  alreadyBooked: 'You already have a call booked.',
  noTimes: 'There are no open times this week. Pick a time in the calendar below.',
  rateLimited: 'Too many tries in a short time. Pick a time in the calendar below instead.',
  badName: 'Please enter your name.',
  badEmail: 'Please enter a valid email address.',
  badPhone: 'Please enter a valid mobile number, including area code.',
} as const;

// ───────────── what the application says, for the booking form ─────────────

const optionLabel = (qid: string, v: unknown) => {
  const q = APPLICATION.find((x) => x.id === qid);
  if (!q || !('options' in q) || typeof v !== 'string') return typeof v === 'string' ? v : null;
  return q.options.find((o) => o.value === v)?.label ?? v;
};

/** Answers one booking-form question from the lead's application, or null when nothing there fits it. */
export function applicationAnswer(q: Pick<CalQuestion, 'name' | 'type'>, lead: Lead, phone: string | null): string | null {
  const a = parseAnswers(lead);
  const name = q.name.toLowerCase();
  const text = (k: string) => (typeof a[k] === 'string' && (a[k] as string).trim() ? (a[k] as string).trim() : null);
  if (q.type === 'phone_number' || /\b(phone|mobile|cell)\b/.test(name)) return phone;
  if (/revenue|turnover|annual sales|top.?line/.test(name)) return optionLabel('revenue', a.revenue) ?? lead.revenue_band;
  if (/profit|ebitda|earnings/.test(name)) return optionLabel('profit', a.profit);
  if (/industry|sector|niche|vertical/.test(name)) return lead.industry || text('business');
  if (/(what does|tell us about|describe).*(business|company)|business do|company do|your business|business name|company name/.test(name)) return text('business') ?? lead.industry;
  if (/why now|why is now/.test(name)) return text('why_now');
  if (/goal|achieve|hoping|looking to|outcome|want to (get|achieve)|interested in/.test(name)) return optionLabel('goal', a.goal);
  if (/timeline|timeframe|time frame|how soon/.test(name)) return optionLabel('timeline', a.timeline);
  if (/\brole\b|position|title/.test(name)) return optionLabel('role', a.role);
  return null;
}

const FILLER = (lead: Lead) => `In their application (ref ${lead.ref_code}).`;

/** The booking form answers for this lead. */
export const oneTapAnswers = (et: CalEventType, lead: Lead, phone: string | null) => formAnswers(et, (q) => applicationAnswer(q, lead, phone), FILLER(lead));

/** Why one-tap can't fill this event type's form for this lead (a required choice question with no matching answer), or null. */
export function oneTapBlocker(et: CalEventType, lead: Lead, phone: string | null = lead.phone): string | null {
  for (const q of et.custom_questions ?? []) {
    if (!q.enabled || !q.required) continue;
    if (/select/i.test(q.type)) {
      const a = applicationAnswer(q, lead, phone);
      if (!a || !matchChoice(q, a)) return `The Calendly booking form has a required choice question ("${q.name.slice(0, 80)}") the application can’t answer.`;
    }
    if (q.type === 'phone_number' && !phone) return 'The Calendly booking form needs a phone number and there is none on file.';
  }
  return null;
}

// ───────────── who and what to book ─────────────

interface Ctx { rep: Rep; url: string; et: CalEventType }

/** The closer and their event type, or why one-tap isn't possible for this lead (they get the embed). */
export async function oneTapContext(rt: Runtime, lead: Lead): Promise<Ctx | { why: string }> {
  if (!oneTapOn(rt.settings)) return { why: 'one-tap booking is off' };
  const tier = effectiveTier(lead);
  if (tier !== 'A' && tier !== 'B') return { why: 'not a qualified tier' };
  if (!lead.email) return { why: 'no email on file' };
  const rep = bookingRepFor(rt, lead.closer_id, tier);
  const url = rep ? calendarFor(rt.settings, rep) : '';
  if (!rep || !/^https:\/\/calendly\.com\//.test(url)) return { why: 'the closer’s calendar is not a Calendly link' };
  let et: CalEventType | null;
  try {
    et = await eventTypeForUrl(rt, url);
  } catch (e) {
    return { why: String(e instanceof Error ? e.message : e).slice(0, 300) };
  }
  if (!et) return { why: 'the closer’s calendar is not an event type of the connected Calendly account' };
  return { rep, url, et };
}

// ───────────── the times, as the page shows them ─────────────

export interface TimeView { id: string; label: string }
export interface DayView { date: string; label: string; short: string; weekend: boolean; times: TimeView[]; all: TimeView[] }

const timeLabel = (t: number, tz: string) => {
  const { hour, minute } = partsIn(t, tz);
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'am' : 'pm'}`;
};
const dayLabel = (t: number, tz: string) => new Intl.DateTimeFormat('en-AU', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(t).replace(',', '');
const dayShort = (t: number, tz: string) => new Intl.DateTimeFormat('en-AU', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(t).replace(',', '');

/** Up to `n` times spread across the day (first, last and evenly between). */
export function spread<T>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(xs[Math.round((i * (xs.length - 1)) / (n - 1))]);
  return [...new Set(out)];
}

/**
 * The open times by day in `tz`: every day in the week (`all`, up to 16 times each), and the first three working days
 * (Monday–Friday) flagged `primary` with up to four times each. Weekend days only show under "More times".
 */
export function dayViews(times: number[], tz: string): { primary: DayView[]; week: DayView[] } {
  const byDay = new Map<string, number[]>();
  for (const t of times) {
    const d = partsIn(t, tz).date;
    (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(t);
  }
  const week: DayView[] = [...byDay.entries()].map(([date, ts]) => {
    const wd = partsIn(ts[0], tz).weekday;
    const view = (t: number) => ({ id: new Date(t).toISOString(), label: timeLabel(t, tz) });
    return { date, label: dayLabel(ts[0], tz), short: dayShort(ts[0], tz), weekend: wd === 'Saturday' || wd === 'Sunday', times: spread(ts, 4).map(view), all: ts.slice(0, 16).map(view) };
  });
  const working = week.filter((d) => !d.weekend);
  return { primary: (working.length ? working : week).slice(0, 3), week };
}

/** "Thursday 13 November, 10:30 am Sydney time" */
export const confirmLabel = (t: number, tz: string) => `${dayLabel(t, tz)}, ${timeLabel(t, tz)} ${tzLabel(tz)}`;

const firstName = (rep: Rep) => rep.name.trim().split(/\s+/)[0] || 'the team';

function timesBody(times: number[], tz: string, rep: Rep) {
  const { primary, week } = dayViews(times, tz);
  return { tz, tzLabel: tzLabel(tz), closer: firstName(rep), days: primary, week };
}

/** The lead's time zone: their record, else what the browser said (saved on the lead when they had none). */
async function zoneFor(rt: Runtime, lead: Lead, browserTz: unknown) {
  const fromBrowser = validTimezone(browserTz);
  if (!lead.timezone && fromBrowser) {
    await updateLead(rt.env, lead.id, { timezone: fromBrowser });
    return fromBrowser;
  }
  return lead.timezone && validTimezone(lead.timezone) ? lead.timezone : fromBrowser ?? leadTimezone(lead, rt.settings.SALES_TIMEZONE);
}

export interface OneTapReply { status: number; body: Record<string, unknown> }
const ok = (body: Record<string, unknown>, status = 200): OneTapReply => ({ status, body });

async function fallback(rt: Runtime, lead: Lead, why: string, step: 'times' | 'book', message: string = ONE_TAP_COPY.fallback, extra: Record<string, unknown> = {}): Promise<OneTapReply> {
  await track(rt, await identityFromLead(rt.env, lead.id), { name: 'one_tap_fallback', source: 'server', path: '/book', props: { step, why: why.slice(0, 200) }, localOnly: true });
  return ok({ ok: false, fallback: true, message, ...extra });
}

/**
 * Calendly URL prefill for the embed fallback: the booking form's answers as a1, a2… (in the form's order) and, for a
 * phone-call location, the number. Name, email and the UTMs are added by book.js.
 */
export function embedPrefill(et: CalEventType, lead: Lead): Record<string, string> {
  const out: Record<string, string> = {};
  const qs = [...(et.custom_questions ?? [])].filter((q) => q.enabled).sort((a, b) => a.position - b.position);
  qs.forEach((q, i) => {
    let a = applicationAnswer(q, lead, lead.phone);
    if (a && /select/i.test(q.type)) a = matchChoice(q, a);
    if (a) out[`a${i + 1}`] = a.slice(0, 300);
  });
  if (et.locations?.[0]?.kind === 'outbound_call' && lead.phone) out.location = lead.phone;
  return out;
}

/** Who may use one-tap: an applicant in tier A or B, identified by their own linked browser. */
export async function oneTapLead(rt: Runtime, leadId: string | null | undefined): Promise<Lead | null> {
  const lead = leadId ? await getLead(rt.env, leadId) : null;
  if (!lead?.app_completed_at) return null;
  const tier = effectiveTier(lead);
  return tier === 'A' || tier === 'B' ? lead : null;
}

/** POST /api/book/times */
export async function oneTapTimes(rt: Runtime, lead: Lead, body: Record<string, unknown>, now = Date.now()): Promise<OneTapReply> {
  if (await overLimit(rt.env, `onetap:times:${lead.id}`, 30, HOUR, now)) return ok({ ok: false, fallback: true, message: ONE_TAP_COPY.rateLimited }, 429);
  const ctx = await oneTapContext(rt, lead);
  if ('why' in ctx) return fallback(rt, lead, ctx.why, 'times', '');
  const prefill = { prefill: embedPrefill(ctx.et, lead) };
  const blocker = oneTapBlocker(ctx.et, lead);
  if (blocker) return fallback(rt, lead, blocker, 'times', '', prefill);
  if (activeBooking(lead, now) === 'unknown') return fallback(rt, lead, 'current booking is not a Calendly event', 'times', '', prefill);
  const tz = await zoneFor(rt, lead, body.tz);
  let times: number[];
  try {
    times = await cachedOpenTimes(rt, ctx.et.uri, now);
  } catch (e) {
    return fallback(rt, lead, String(e instanceof Error ? e.message : e).slice(0, 300), 'times', '', prefill);
  }
  if (!times.length) return fallback(rt, lead, 'no open times in the next 7 days', 'times', ONE_TAP_COPY.noTimes, prefill);
  return ok({ ok: true, ...timesBody(times, tz, ctx.rep), ...prefill });
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/;

/** POST /api/book/confirm */
export async function oneTapConfirm(rt: Runtime, lead: Lead, body: Record<string, unknown>, now = Date.now()): Promise<OneTapReply> {
  if (await overLimit(rt.env, `onetap:book:${lead.id}`, 6, HOUR, now)) return ok({ ok: false, fallback: true, message: ONE_TAP_COPY.rateLimited }, 429);
  const raw = typeof body.slot === 'string' ? body.slot.trim() : '';
  const slot = ISO.test(raw) ? Date.parse(raw) : NaN;

  // Details for Calendly: their application's, unless they corrected them in the sheet (used for this booking only).
  const name = body.name === undefined ? [lead.first_name, lead.last_name].filter(Boolean).join(' ') : cleanName(body.name, 120) ?? '';
  if (!name.trim()) return ok({ ok: false, field: 'name', message: ONE_TAP_COPY.badName }, 400);
  const email = body.email === undefined ? lead.email : validateEmail(body.email)?.email ?? null;
  if (!email) return ok({ ok: false, field: 'email', message: ONE_TAP_COPY.badEmail }, 400);
  let phone = lead.phone;
  if (body.phone !== undefined) {
    const typed = typeof body.phone === 'string' ? body.phone.trim() : '';
    phone = typed ? normalisePhone(typed, lead.country) : null;
    if (typed && !phone) return ok({ ok: false, field: 'phone', message: ONE_TAP_COPY.badPhone }, 400);
  }

  // One active booking per lead: a booked lead only gets here from a reschedule link.
  const existing = activeBooking(lead, now);
  if (existing === 'unknown') return fallback(rt, lead, 'current booking is not a Calendly event', 'book');
  if (existing && body.reschedule !== true) return ok({ ok: false, result: 'already_booked', message: ONE_TAP_COPY.alreadyBooked, next: '/breakout' });
  if (existing && existing.at === slot) return ok({ ok: true, result: 'already_booked', next: '/breakout' });

  const ctx = await oneTapContext(rt, lead);
  if ('why' in ctx) return fallback(rt, lead, ctx.why, 'book');
  const tz = await zoneFor(rt, lead, body.tz);
  if (!Number.isFinite(slot) || slot < now + MIN_LEAD_MS || slot > now + 7 * DAY) {
    const times = await cachedOpenTimes(rt, ctx.et.uri, now).catch(() => [] as number[]);
    return ok({ ok: false, result: 'slot_taken', message: ONE_TAP_COPY.slotTaken, ...timesBody(times, tz, ctx.rep) });
  }

  const [first, ...rest] = name.trim().split(/\s+/);
  const out = await bookLeadSlot(rt, lead, {
    slot, tz, now, method: 'one_tap',
    eventType: async () => ctx.et,
    blocker: (et) => oneTapBlocker(et, lead, phone),
    answers: (et) => oneTapAnswers(et, lead, phone),
    invitee: { name: name.trim(), first_name: first, last_name: rest.join(' ') || null, email, phone },
    tracking: { utm_source: 'funnel', utm_medium: 'one_tap', utm_content: lead.ref_code },
    cancelReason: 'Moved to a new time on the booking page',
    fetchDetails: true,
    // Recorded the moment Calendly booked it, so a fast webhook for the same event can't count it as the embed.
    onCreated: (eventUri) => recordBookingMethod(rt, lead.id, eventUri, 'one_tap'),
  });
  if (out.kind === 'busy') return ok({ ok: false, result: 'busy', message: ONE_TAP_COPY.busy }, 409);
  const prefill = { prefill: embedPrefill(ctx.et, lead) };
  if (out.kind === 'unavailable') return fallback(rt, lead, out.why, 'book', ONE_TAP_COPY.fallback, prefill);
  if (out.kind === 'slot_taken') {
    if (out.etUri) await forgetOpenTimes(rt, out.etUri);
    await track(rt, await identityFromLead(rt.env, lead.id), { name: 'one_tap_slot_taken', source: 'server', path: '/book', props: { slot: raw }, localOnly: true });
    const times = openTimes(out.open, now).filter((t) => t !== slot);
    if (!times.length) return fallback(rt, lead, 'slot taken and nothing else open', 'book', ONE_TAP_COPY.noTimes, prefill);
    return ok({ ok: false, result: 'slot_taken', message: ONE_TAP_COPY.slotTaken, ...timesBody(times, tz, ctx.rep) });
  }
  await forgetOpenTimes(rt, out.etUri);
  if (out.existing && out.oldCancelled === false) {
    const { notifySlack } = await import('../integrations/notify');
    rt.waitUntil(notifySlack(rt, lead, '⚠️ Old booking not cancelled', [`They moved their call to ${confirmLabel(slot, tz)} on the booking page, but the old booking couldn’t be cancelled automatically. Cancel it in Calendly.`], 'booked'));
  }
  return ok({ ok: true, result: out.rescheduled ? 'rescheduled' : 'booked', when: confirmLabel(slot, tz), next: '/breakout' });
}

/**
 * Funnel HQ → Overview: one-tap against the embed. For each way /book was shown (one_tap or embed only, from the
 * page view's booking_mode), how many leads saw it and how many of them booked, by how they booked.
 */
export async function bookingMethodStats(env: { DB: D1Database }, from: number, to: number) {
  const { results: shown } = await env.DB.prepare(
    `WITH v AS (SELECT DISTINCT lead_id, COALESCE(json_extract(props, '$.booking_mode'), 'embed') AS mode FROM events
                 WHERE name = 'page_view' AND path = '/book' AND ts BETWEEN ?1 AND ?2 AND lead_id IS NOT NULL AND is_bot = 0)
     SELECT v.mode AS mode, COUNT(DISTINCT v.lead_id) AS viewers,
            COUNT(DISTINCT CASE WHEN bm.method = 'one_tap' THEN v.lead_id END) AS one_tap,
            COUNT(DISTINCT CASE WHEN bm.method = 'embed' THEN v.lead_id END) AS embed,
            COUNT(DISTINCT CASE WHEN bm.method = 'phone' THEN v.lead_id END) AS phone,
            COUNT(DISTINCT bm.lead_id) AS booked
       FROM v LEFT JOIN booking_methods bm ON bm.lead_id = v.lead_id AND bm.created_at BETWEEN ?1 AND ?3
      GROUP BY v.mode`,
  ).bind(from, to, to + 7 * DAY).all<{ mode: string; viewers: number; one_tap: number; embed: number; phone: number; booked: number }>();
  const { results: totals } = await env.DB.prepare('SELECT method, COUNT(*) AS n FROM booking_methods WHERE created_at BETWEEN ? AND ? GROUP BY method').bind(from, to).all<{ method: string; n: number }>();
  const pageModes = ['one_tap', 'embed'].map((mode) => {
    const r = shown.find((x) => x.mode === mode);
    const viewers = Number(r?.viewers ?? 0);
    const booked = Number(r?.booked ?? 0);
    return { mode, viewers, booked, rate: viewers ? booked / viewers : 0, by: { one_tap: Number(r?.one_tap ?? 0), embed: Number(r?.embed ?? 0), phone: Number(r?.phone ?? 0) } };
  });
  return { pages: pageModes, booked: Object.fromEntries(totals.map((t) => [t.method, Number(t.n)])) as Record<string, number> };
}

/** Sample times for the Funnel HQ preview of /book (nothing is looked up or bookable). */
export function sampleTimes(now: number, tz: string, closer: string) {
  const ts: number[] = [];
  for (let d = 1; d < 9; d++) {
    const base = now + d * DAY;
    const p = partsIn(base, tz);
    const midnight = base - (p.hour * 60 + p.minute) * 60_000;
    for (const h of [9, 10.5, 13, 15.5]) ts.push(Math.floor((midnight + h * HOUR) / 900_000) * 900_000);
  }
  return { ok: true, sample: true, ...timesBody(ts, tz, { name: closer } as Rep) };
}
