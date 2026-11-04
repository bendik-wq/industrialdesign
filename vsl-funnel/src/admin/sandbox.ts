/**
 * Funnel HQ → Sandbox: a sample lead walked through the real automation on a simulated clock. Nothing is sent and
 * nothing is written: the simulation calls the same decision functions the cron and the queues call (the live
 * reminder windows, quiet hours, cadence and post-event paths; texting hours, consent, the 3-a-day cap and the
 * sequences' own stop and skip rules; AI call consent, calling hours, the webinar calls' "still wanted" rules,
 * per-person caps and retries), in the order the cron runs them, against a stand-in lead held in memory.
 *
 * Previews use the real builders (liveEmail / postEmail / the deposit welcome through renderMail, buildEmail for
 * the sequences, renderSms, the call variables) on a read-only runtime: any database write throws.
 *
 * Where a rule lives inside a database query (the webinar call planner's SQL, the per-number call counts), it is
 * mirrored here with the real thresholds imported from its module; test/sandbox.test.ts pins those mirrors.
 */
import { Hono } from 'hono';
import { type AppEnv, type Runtime, runtimeFrom } from '../app';
import { AI_CALLER } from '../config';
import type { Lead } from '../funnel/leads';
import { scoreApplication } from '../funnel/scoring';
import { type CallKind, blockReason, callingZones, enabled, inCallingHours, nextCallingTime, variables, elevenConfigured } from '../integrations/elevenlabs';
import { SEQUENCES, precallPlan } from '../integrations/sequences';
import { precallLimits, precallTimes, zonedTime } from '../integrations/email';
import { CONSENT_COPY, type ConsentRow, consentBlock } from '../integrations/consent-gate';
import { SMS_GOAL, SMS_SKIP, inTextingHours, nextTextingTime, renderSms, sendsAsName, smsBlock, smsOk, smsSegments, staleBeforeAnchor, textingZones, withOptOutLink } from '../integrations/sms';
import { DEFAULT_SMS_SEQUENCES, type SmsStepDef, type SmsTrigger } from '../integrations/sms-defaults';
import {
  PER_DAY_PER_PERSON, STEP_META, W_FIRST_MESSAGE, type WCtx, type WKind, type WMeta, callVariables, cleanConfig, flowEnabled, flowOf, leftWaitMin, personBlock, stillWanted, webinarAgentReady, weeklyCap,
} from '../integrations/webinar-calls';
import { type LiveMessage, dueLiveMessages, eventEnd, liveEmail, liveRoomUrl, liveSettings, liveText, offerWindow } from '../live/events';
import { CHANNEL_GAP_MIN, DEFAULT_CADENCE, type PostKind, REMINDER_KINDS, type ReminderKind, callSlot, duePost, inQuiet, postEmail, reminderTimes, textAllowed } from '../live/lifecycle';
import { lcSettings } from '../live/lifecycle-db';
import { type Mail, renderMail } from '../live/mail';
import { depositConfig, depositWelcomeEmail, onboardingUrl } from '../sales/deposit';
import { guarantee } from '../sales/guarantee';
import { APP_REVENUE_BAND, REVENUE_LABEL, isMillionPlus } from '../sales/qualify';
import { type CallContext, NEXT_ACTIONS, PAIN_POINTS, type Pain, RESOURCES } from '../integrations/sales-playbook';
import { formatCallTime } from '../integrations/email';
import { bookingToolsOn, sampleSlots, tzLabel } from '../integrations/calendly-tools';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** The cron's rhythm: every decision below is taken on these ticks, like the 5-minute cron. */
export const TICK = 5 * MIN;
/** The live sample: two hours long, the host opens the deposit offer at minute 75. */
export const SAMPLE_DURATION_MIN = 120;
export const SAMPLE_OFFER_MIN = 75;
/** Mirrors of thresholds that live inside the webinar call planner's SQL (webinarCandidates); pinned in the tests. */
export const PLAN = { welcomeAfterMin: 5, dayBeforeMinLeadH: 30, startBeforeMin: 10, nobuyAfterEndMin: 60, missedAfterEndMin: 90, boughtAfterMin: 30, leftEndGuardMin: 5 };

// ───────────── input ─────────────

export type Journey = 'live' | 'strategy';
export const COUNTRIES = {
  AU: { label: 'Australia', phone: '+61412345678', zones: ['Australia/Brisbane', 'Australia/Sydney', 'Australia/Melbourne', 'Australia/Perth', 'Australia/Adelaide'] },
  US: { label: 'United States', phone: '+15125550142', zones: ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'] },
  GB: { label: 'United Kingdom', phone: '+447700900123', zones: ['Europe/London'] },
  NZ: { label: 'New Zealand', phone: '+64211234567', zones: ['Pacific/Auckland'] },
  NO: { label: 'Norway', phone: '+4741234567', zones: ['Europe/Oslo'] },
} as const;
export type Country = keyof typeof COUNTRIES;
export const REVENUES = ['lt1m', '1_3m', '3_10m', '10_25m'] as const;
export type Revenue = (typeof REVENUES)[number];
export const APPLY_TIMES = { weekday_morning: 'A weekday, 10:30 am', weekday_night: 'A weekday, 10:30 pm', saturday: 'Saturday, 4:00 pm', sunday: 'Sunday, 11:00 am' } as const;
export type ApplyTime = keyof typeof APPLY_TIMES;

export interface SbLead { name: string; country: Country; tz: string; callOk: boolean; textOk: boolean; revenue: Revenue; /** They gave consent for a number, then the number on file changed (the gate voids that consent). */ numberChanged?: boolean }
export interface SbChoices {
  /** Live: minutes before the start that they register. */
  registerBefore: number;
  /** Live: the start hour in the event's time zone. */
  startHour: number;
  joins: boolean;
  /** Minutes after the start they join (0 = on time). */
  joinMin: number;
  /** The minute they leave (null = stay to the end). */
  leaveMin: number | null;
  buys: 'no' | 'live' | 'after';
  /** Strategy call path. */
  appliesAt: ApplyTime;
  /** Minutes after applying that they book (null = never). */
  booksAfter: number | null;
  callInDays: number;
  noShow: boolean;
  rebooks: boolean;
  /** Both: picks up the AI calls, and how they opt out (none, STOP to the first text, "stop calling" on the first call). */
  answers: boolean;
  optOut: 'none' | 'text' | 'call';
  /** Both: the main challenge they name on a call (the guide Sam offers; shown in the call sheet). */
  pain: Pain | 'none';
}
export interface SbInput { journey: Journey; lead: SbLead; choices: SbChoices; anchor: number }

export const DEFAULT_LEAD: SbLead = { name: 'Dana', country: 'AU', tz: 'Australia/Brisbane', callOk: true, textOk: true, revenue: '3_10m' };
export const DEFAULT_CHOICES: SbChoices = {
  registerBefore: 3 * 24 * 60, startHour: 19, joins: true, joinMin: 0, leaveMin: null, buys: 'no',
  appliesAt: 'weekday_morning', booksAfter: 120, callInDays: 2, noShow: false, rebooks: false,
  answers: true, optOut: 'none', pain: 'finding_deals',
};

const validTz = (tz: unknown) => { try { if (typeof tz !== 'string' || !tz || tz.length > 40) return null; new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return null; } };
const num = (v: unknown, lo: number, hi: number, d: number) => { const n = Math.round(Number(v)); return v === '' || v == null || !Number.isFinite(n) ? d : Math.min(hi, Math.max(lo, n)); };
const pick = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);

/** Cleans what the page sends (everything clamped; unknown values fall back to the sample's). */
export function cleanInput(raw: unknown, now = Date.now()): SbInput {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const l = (r.lead && typeof r.lead === 'object' ? r.lead : {}) as Record<string, unknown>;
  const c = (r.choices && typeof r.choices === 'object' ? r.choices : {}) as Record<string, unknown>;
  const country = pick(l.country, Object.keys(COUNTRIES) as Country[], DEFAULT_LEAD.country);
  const name = typeof l.name === 'string' && /^[\p{L}][\p{L}' .-]{0,29}$/u.test(l.name.trim()) ? l.name.trim() : DEFAULT_LEAD.name;
  const anchor = Number(r.anchor);
  return {
    journey: pick(r.journey, ['live', 'strategy'] as const, 'live'),
    lead: { name, country, tz: validTz(l.tz) ?? COUNTRIES[country].zones[0], callOk: l.callOk !== false, textOk: l.textOk !== false, revenue: pick(l.revenue, REVENUES, DEFAULT_LEAD.revenue), numberChanged: l.numberChanged === true },
    choices: {
      registerBefore: num(c.registerBefore, 10, 14 * 24 * 60, DEFAULT_CHOICES.registerBefore),
      startHour: num(c.startHour, 6, 22, DEFAULT_CHOICES.startHour),
      joins: c.joins !== false,
      joinMin: num(c.joinMin, -15, 100, 0),
      leaveMin: c.leaveMin == null || c.leaveMin === '' ? null : num(c.leaveMin, 1, SAMPLE_DURATION_MIN, 40),
      buys: pick(c.buys, ['no', 'live', 'after'] as const, 'no'),
      appliesAt: pick(c.appliesAt, Object.keys(APPLY_TIMES) as ApplyTime[], 'weekday_morning'),
      booksAfter: !('booksAfter' in c) ? DEFAULT_CHOICES.booksAfter : c.booksAfter === null || c.booksAfter === '' ? null : num(c.booksAfter, 1, 7 * 24 * 60, 120),
      callInDays: num(c.callInDays, 1, 7, 2),
      noShow: c.noShow === true,
      rebooks: c.rebooks === true,
      answers: c.answers !== false,
      optOut: pick(c.optOut, ['none', 'text', 'call'] as const, 'none'),
      pain: pick(c.pain, [...PAIN_POINTS, 'none'] as const, DEFAULT_CHOICES.pain),
    },
    // The simulated clock is anchored near today so dates read naturally (within a month either way).
    anchor: Number.isFinite(anchor) && Math.abs(anchor - now) < 31 * DAY ? Math.floor(anchor / MIN) * MIN : Math.floor(now / HOUR) * HOUR,
  };
}

// ───────────── output ─────────────

export type Channel = 'email' | 'sms' | 'call' | 'session' | 'purchase' | 'step';
export type Status = 'sent' | 'skipped' | 'cancelled' | 'done' | 'note';
export interface SimEvent {
  id: string;
  at: number;
  ch: Channel;
  status: Status;
  title: string;
  /** One line under the title (the subject, the text, who answered). */
  sub?: string;
  /** Why it didn't go, in the system's own words. */
  reason?: string;
  phase: string;
  /** Rows that belong together (the pre-call emails) fold into one. */
  group?: string;
  /** What the detail sheet renders. */
  ref: { kind: 'live' | 'post' | 'deposit' | 'seq' | 'sms' | 'wcall' | 'call' | 'info'; key: string; attempt?: number; trigger?: SmsTrigger; step?: number; sequence?: string; firstText?: boolean };
  /** For a text: the exact body and how it is sent. */
  text?: { body: string; from: string; segments: number; firstText: boolean; auVariant: { from: string; body: string; segments: number } | null };
  /** Plain words: what changes for the lead (sessions, purchases, steps). */
  lines?: string[];
}
export interface SimResult {
  journey: Journey;
  start: number;
  end: number;
  anchor: number;
  tz: string;
  eventTz: string | null;
  phone: string;
  tier: string | null;
  markers: { at: number; label: string }[];
  events: SimEvent[];
  account: { email: boolean; sms: boolean; calls: boolean; webinarCalls: boolean; notes: string[] };
  assumptions: string[];
}

// ───────────── the sample lead ─────────────

const SAMPLE_EMAIL = 'dana.sample@example.com';
export function sampleAnswers(revenue: Revenue) {
  return {
    business: 'Commercial HVAC services company, 25 staff (sample)', role: 'owner', revenue, profit: revenue === 'lt1m' ? 'lt250k' : '250k_1m',
    goal: 'acquire', timeline: '0_6', blockers: ['funding'], readiness: 'yes', why_now: 'We have plateaued and I want to buy a competitor in the next year so the group runs without me (sample answer).',
  };
}
function baseLead(inp: SbInput, t: number): Lead {
  const c = COUNTRIES[inp.lead.country];
  return {
    id: 'sandbox', ref_code: 'SAMPLE', created_at: t, updated_at: t, visitor_id: null, session_id: null, first_name: inp.lead.name, last_name: 'Sample', email: SAMPLE_EMAIL, phone: c.phone,
    whatsapp_opt_in: 0, answers: JSON.stringify(sampleAnswers(inp.lead.revenue)), step_reached: 0, app_started_at: null, app_completed_at: null, score: null, score_breakdown: null,
    tier: null, tier_override: null, route: null, closer_id: null, status: 'partial', booked_at: null, call_at: null, booking_provider: null, booking_ref: null, booking_cancelled_at: null,
    whatsapp_clicked_at: null, whatsapp_connected_at: null, whatsapp_wa_id: null, unsubscribed_at: null, do_not_call_at: null, revenue: 0, cash_collected: 0, closed_at: null, showed_at: null,
    lost_reason: null, setter_id: null, call_consent_at: inp.lead.callOk ? t : null, call_consent_text: inp.lead.callOk ? CONSENT_COPY.version : null, timezone: inp.lead.tz, booking_join_url: null,
    booking_reschedule_url: null, booking_cancel_url: null, booking_host_email: null, booking_answers: null, booking_source: 'funnel', webinar_at: null, webinar_registered_at: null,
    webinar_attended_at: null, webinar_watch_pct: null, webinar_cta_at: null, webinar_replay_at: null, webinar_token: null, sms_opt_out_at: null, sms_confirmed_at: null,
    sms_consent_at: inp.lead.textOk ? t : null, wa_consent_at: null, industry: 'Commercial HVAC services (sample)', revenue_band: APP_REVENUE_BAND[inp.lead.revenue] ?? null, budget_band: null,
    willing_to_invest: null, qual_source: null, qual_flags: null, temperature: null, country: inp.lead.country,
  } as unknown as Lead;
}
/**
 * The sample's consent proof, as the forms record it (consent_events): one row per ticked box, for the number it was
 * typed with. With numberChanged the boxes were ticked for an earlier number, so the real gate blocks every channel.
 */
export function sandboxConsentRows(inp: SbInput, t: number): ConsentRow[] {
  const phone = COUNTRIES[inp.lead.country].phone;
  const given = inp.lead.numberChanged ? `${phone.slice(0, -1)}${(Number(phone.slice(-1)) + 1) % 10}` : phone;
  const row = (channel: ConsentRow['channel']): ConsentRow => ({ channel, action: 'granted', phone: given, source: 'sandbox', page_url: null, text_version: CONSENT_COPY.version, created_at: t });
  return [...(inp.lead.callOk ? [row('call')] : []), ...(inp.lead.textOk ? [row('sms'), row('whatsapp')] : [])];
}
/** The contact gate (consent-gate.ts consentBlock) on the sample: the same rule the live system runs before every call and text. */
const gateOn = (inp: SbInput, lead: Lead, channel: 'call' | 'sms') => consentBlock(lead, channel, sandboxConsentRows(inp, lead.created_at));

/**
 * Two real checks compare the call time with Date.now() (blockReason's "call is too soon", the pre-call stop rule).
 * They are asked about simulated time `t` by shifting the call time by the same distance.
 */
const asOf = (lead: Lead, t: number): Lead => {
  const d = Date.now() - t;
  return { ...lead, call_at: lead.call_at != null ? lead.call_at + d : null, webinar_at: lead.webinar_at != null ? lead.webinar_at + d : null };
};

/** The first moment of `hour` local time on the day `t` falls on, in `tz`. */
function dayAt(t: number, hour: number, tz: string) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(t);
  const g = (k: string) => Number(p.find((x) => x.type === k)!.value);
  return zonedTime(g('year'), g('month'), g('day'), hour, tz);
}
const weekday = (t: number, tz: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(t);

function accountState(rt: Runtime) {
  const s = rt.settings as unknown as Partial<Record<string, string>>;
  const email = Boolean(s.RESEND_API_KEY && s.EMAIL_FROM);
  const sms = Boolean((s.TWILIO_ACCOUNT_SID && s.TWILIO_AUTH_TOKEN) || s.TELNYX_API_KEY) && Boolean(s.SMS_FROM);
  const calls = elevenConfigured(rt.settings);
  const webinarCalls = webinarAgentReady(s);
  const notes: string[] = [];
  if (!email) notes.push('Email isn’t connected in this account, so real emails are recorded as simulated.');
  if (!sms) notes.push('No text provider is connected, so real texts are recorded as simulated.');
  if (!calls) notes.push('ElevenLabs isn’t connected, so real leads get no AI calls yet.');
  else if (!webinarCalls) notes.push('The webinar call agent isn’t created yet, so live session calls don’t go to real leads yet.');
  return { email, sms, calls, webinarCalls, notes };
}

// ───────────── shared: texts ─────────────

const SITE = (rt: Runtime) => rt.settings.SITE_NAME || 'G&L';
/** The opt-out link a sender-name text carries (a sample address here: the real one is signed per number). */
const sampleOptOut = (rt: Runtime, phone: string) => `${rt.origin}/so/${phone.replace(/\D/g, '')}/sample`;
function textPayload(rt: Runtime, body: string, phone: string, firstText: boolean): NonNullable<SimEvent['text']> {
  const alpha = sendsAsName(rt, phone);
  const v = alpha ? withOptOutLink(body, sampleOptOut(rt, phone)) : null;
  return { body, from: rt.settings.SMS_FROM || 'your text number', segments: smsSegments(body), firstText, auVariant: alpha && v ? { from: alpha, body: v, segments: smsSegments(v) } : null };
}

// ───────────── the live webinar ─────────────

export const LIVE_LABEL: Record<LiveMessage, string> = {
  confirm: 'You’re registered', ticket: 'Finish your ticket', r24h: '24 hours before', r3h: '3 hours before', r1h: '1 hour before', r10m: 'Starting in 10 minutes',
  live: 'We’re live now', missing: 'You’re missing it', replay: 'The replay', replay_last: 'The offer’s last hours',
};
export const POST_LABEL: Record<PostKind, string> = { buyer_docs: 'Documents to gather before kickoff', nobuy_questions: 'The three questions owners ask', noshow_highlights: 'What you missed, and the replay' };
const PH_BEFORE = 'Before the session', PH_DURING = 'The session', PH_AFTER = 'After the session';

interface LiveCall { id: string; kind: WKind; runAt: number; exact: boolean; meta: WMeta; until: number; attempt: number; status: 'queued' | 'done' | 'no_answer' | 'skipped' | 'cancelled'; dialedAt: number | null }

export interface LiveTimes { regAt: number; start: number; end: number; openAt: number; joinAt: number | null; leftAt: number | null; buyAt: number | null; buyBlocked: string | null }
export function liveTimes(rt: Runtime, inp: SbInput): LiveTimes {
  const evTz = liveSettings(rt).tz;
  const c = inp.choices;
  const start = dayAt(inp.anchor + 7 * DAY, c.startHour, evTz);
  const end = start + SAMPLE_DURATION_MIN * MIN;
  const openAt = start + SAMPLE_OFFER_MIN * MIN;
  const joinAt = c.joins ? start + c.joinMin * MIN : null;
  const leftAt = joinAt != null && c.leaveMin != null && start + c.leaveMin * MIN > joinAt && c.leaveMin < SAMPLE_DURATION_MIN ? start + c.leaveMin * MIN : null;
  const million = isMillionPlus(APP_REVENUE_BAND[inp.lead.revenue] ?? null);
  let buyAt: number | null = null, buyBlocked: string | null = null;
  if (c.buys !== 'no') {
    if (!million) buyBlocked = 'The deposit is for owners doing $1M or more a year: under $1M the room shows the worksheet instead, and the server refuses the deposit.';
    else if (c.buys === 'live') {
      const at = openAt + 12 * MIN;
      if (joinAt == null || joinAt > at || (leftAt != null && leftAt <= at)) buyBlocked = 'They weren’t in the room when the offer opened, so this sample has them buy the next day instead.';
      buyAt = buyBlocked ? end + 20 * HOUR : at;
    } else buyAt = end + 20 * HOUR;
  }
  return { regAt: start - c.registerBefore * MIN, start, end, openAt, joinAt, leftAt, buyAt, buyBlocked };
}

function simulateLive(rt: Runtime, inp: SbInput): SimResult {
  const ls = liveSettings(rt);
  const S = rt.settings as unknown as Partial<Record<string, string>>;
  const quiet = lcSettings(rt).quiet;
  const cadence = DEFAULT_CADENCE;
  const T = liveTimes(rt, inp);
  const { regAt, start, end, openAt, joinAt, leftAt, buyAt } = T;
  const tz = inp.lead.tz; // their browser's zone on the confirmation page (lc_regs.tz)
  const title = ls.defaultTitle;
  const lead0 = { ...baseLead(inp, regAt), status: 'partial' as const, webinar_at: null };
  const events: SimEvent[] = [];
  const add = (e: SimEvent) => { events.push(e); return e; };
  const phaseOf = (t: number) => (t < start ? PH_BEFORE : t < end ? PH_DURING : PH_AFTER);
  const million = isMillionPlus(APP_REVENUE_BAND[inp.lead.revenue] ?? null);
  const room = liveRoomUrl(rt, 'sample');
  // Opt-outs happen in the simulation (STOP to the first text, "stop calling" on the first answered call).
  let smsOutAt: number | null = null, dncAt: number | null = null;
  const leadAt = (t: number): Lead => ({
    ...lead0,
    sms_opt_out_at: (smsOutAt != null && smsOutAt <= t) || (dncAt != null && dncAt <= t) ? (smsOutAt ?? dncAt) : null,
    // STOP to a text and "stop calling" on a call both stop everything: texts, AI calls and marketing emails.
    do_not_call_at: (dncAt != null && dncAt <= t) || (smsOutAt != null && smsOutAt <= t) ? (dncAt ?? smsOutAt) : null,
    unsubscribed_at: (dncAt != null && dncAt <= t) || (smsOutAt != null && smsOutAt <= t) ? (dncAt ?? smsOutAt) : null,
  });
  const evAt = (t: number) => ({ starts_at: start, duration_min: SAMPLE_DURATION_MIN, ended_at: null, offer_opened_at: t >= openAt ? openAt : null, offer_closed_at: null, offer_hours: ls.offerHours, status: 'scheduled' as const });
  const joinedBy = (t: number) => (joinAt != null && joinAt <= t ? joinAt : null);
  const boughtBy = (t: number) => (buyAt != null && buyAt <= t ? buyAt : null);
  const seenAt = (t: number) => (joinAt == null || t < joinAt ? null : leftAt != null && t >= leftAt ? leftAt : Math.min(t, end));
  const ctxAt = (t: number): WCtx => {
    const w = offerWindow(evAt(t), t, ls.offerHours);
    return {
      funnel: 'live', regId: 'sandbox', leadId: 'sandbox', token: 'sample', day: null, title, startsAt: start, endsAt: end, cancelled: false, regCreatedAt: regAt, ticketPending: false,
      joinedAt: joinedBy(t), lastSeenAt: seenAt(t), replayWatchedAt: null, replayClosesAt: w.replayClosesAt,
      offer: { name: 'engagement deposit', relevant: true, opened: w.opened, open: w.open, closesAt: w.opened ? w.closesAt : null, openedAt: t >= openAt ? openAt : null },
      bought: { sprint: false, deposit: boughtBy(t) != null, vip: false }, links: { join: room, replay: room, offer: room }, host: new URL(room).host,
      prep: 'a computer with sound, Zoom installed, and last year’s revenue and profit figures for their business.',
    };
  };
  const purchase = buyAt != null ? { kind: 'deposit' as const, id: 'sample', paidAt: buyAt, refunded: false, amount: 0, currency: 'usd' } : null;

  // ── the session's own moments ──
  add({ id: 'x:register', at: regAt, ch: 'step', status: 'done', title: 'Registers for the live session', sub: `${REVENUE_LABEL[APP_REVENUE_BAND[inp.lead.revenue] ?? ''] ?? ''} revenue · ${inp.lead.callOk ? 'call me ticked' : 'call me not ticked'} · ${inp.lead.textOk ? 'text me ticked' : 'text me not ticked'}`, phase: PH_BEFORE, ref: { kind: 'info', key: 'register' },
    lines: ['A registration row and their personal room link are created.', `Their reminders follow their own time zone (${tz}).`, inp.lead.textOk ? 'They ticked the text box for this session, so the reminder texts can go.' : 'They didn’t tick the text box, so reminders go by email only.'] });
  if (joinAt != null) add({ id: 'x:join', at: joinAt, ch: 'session', status: 'done', title: inp.choices.joinMin > 0 ? `Joins ${inp.choices.joinMin} minutes late` : 'Joins the live session', phase: joinAt < start ? PH_BEFORE : PH_DURING, ref: { kind: 'info', key: 'join' },
    lines: ['Their room shows the live stream, the chat, the polls and their Deal Plan.', 'Being in the room earns Deal momentum points (questions, polls, the worksheet), shown live in the room.', 'The "we’re live" and "you’re missing it" reminders stop for them.'] });
  else add({ id: 'x:nojoin', at: start, ch: 'session', status: 'note', title: 'Doesn’t join live', phase: PH_DURING, ref: { kind: 'info', key: 'nojoin' }, lines: ['After the session they are on the missed path: the replay and the highlights.'] });
  add({ id: 'x:offer', at: openAt, ch: 'session', status: 'note', title: `Host opens the ${depositConfig(rt).label} deposit offer`, sub: `Minute ${SAMPLE_OFFER_MIN} in this sample`, phase: PH_DURING, ref: { kind: 'info', key: 'offer' },
    lines: million
      ? ['The offer card appears in their room with the guarantee and its conditions.', `It stays open until ${ls.offerHours} hours after the session ends, on the server’s clock, and the replay closes at the same moment.`]
      : ['They are under $1M revenue, so their room shows the deal structure worksheet instead of the deposit card.'] });
  if (leftAt != null) add({ id: 'x:left', at: leftAt, ch: 'session', status: 'note', title: `Leaves at minute ${inp.choices.leaveMin}`, phase: PH_DURING, ref: { kind: 'info', key: 'left' }, lines: [`If they don’t come back within ${leftWaitMin(S)} minutes, the "dropped off" call is planned.`] });
  add({ id: 'x:end', at: end, ch: 'session', status: 'note', title: 'The session ends', phase: PH_AFTER, ref: { kind: 'info', key: 'end' }, lines: ['The replay is in their room until the offer closes.'] });
  if (buyAt != null) add({ id: 'x:buy', at: buyAt, ch: 'purchase', status: 'done', title: `Pays the ${depositConfig(rt).label} engagement deposit`, sub: buyAt < end ? 'In the room, during the session' : 'From the replay page, the day after', phase: phaseOf(buyAt), ref: { kind: 'info', key: 'buy' },
    lines: ['Their place in this intake of the advisory engagement is held.', 'The deposit is credited in full against the engagement fee; the balance is due on signing after a short onboarding call (not a sales call).', 'The replay and offer reminders stop. The thank-you call and the documents email follow.'] });
  if (T.buyBlocked) add({ id: 'x:nobuy', at: buyAt ?? openAt + 12 * MIN, ch: 'purchase', status: buyAt == null ? 'skipped' : 'note', title: buyAt == null ? 'Can’t pay the deposit' : 'Buys the day after instead', reason: T.buyBlocked, phase: phaseOf(buyAt ?? openAt), ref: { kind: 'info', key: 'nobuy' } });
  if (buyAt != null) add({ id: 'e:deposit_welcome', at: buyAt, ch: 'email', status: 'sent', title: 'Your place is secured', sub: 'Deposit welcome, the moment they pay', phase: phaseOf(buyAt), ref: { kind: 'deposit', key: 'deposit_welcome' } });

  // ── the cron, tick by tick ──
  const fired = new Set<string>();
  const textsSent: number[] = [];
  const calls: LiveCall[] = [];
  const planned = new Set<WKind>();
  const S2 = cleanConfig(null).steps; // the call steps (Funnel HQ edits are read in the detail view)
  const stateAt = (t: number) => ({ tz, quiet, cadence, ticketUnpaid: false, deposit: boughtBy(t) != null });
  const firstTick = regAt;
  const w0 = offerWindow(evAt(end), end, ls.offerHours);
  const horizon = Math.max(w0.replayClosesAt, buyAt != null ? buyAt + 9 * DAY : 0) + TICK;
  const dials = (since: number) => calls.filter((c) => c.dialedAt != null && c.dialedAt > since).length;

  const planCall = (kind: WKind, runAt0: number, t: number, o: { exact?: boolean; meta?: WMeta; attempt?: number } = {}) => {
    const attempt = o.attempt ?? 1;
    const id = `c:${kind}:${attempt}`;
    const skip = (why: string, at = runAt0) => { add({ id, at, ch: 'call', status: 'skipped', title: STEP_META[kind].label, reason: why, phase: phaseOf(at), ref: { kind: 'wcall', key: kind, attempt } }); };
    if (!flowEnabled(S, flowOf(kind).id)) return skip('This call flow is turned off in Funnel HQ → AI calls.');
    const lead = leadAt(t);
    const pb = personBlock(lead) ?? gateOn(inp, lead, 'call');
    if (pb) return skip(why(pb));
    const want = stillWanted(kind, ctxAt(t), purchase, o.meta ?? {}, t);
    if (want.why) return skip(why(want.why));
    const zones = callingZones(lead.phone) ?? [];
    let runAt = Math.max(t, runAt0);
    if (o.exact) {
      if (!inCallingHours(runAt, zones)) return skip('Outside calling hours in every zone of their number, and a "starting now" call is never moved.', runAt);
    } else {
      const next = nextCallingTime(runAt, zones);
      if (!next) return skip('No calling hours in the next five days.');
      runAt = next;
    }
    const slot = callSlot(runAt, textsSent, Boolean(o.exact));
    if (slot.skip) return skip(`A reminder text went within ${CHANNEL_GAP_MIN} minutes: one moment, two channels at most.`, runAt);
    if (slot.runAt !== runAt) { const next = nextCallingTime(slot.runAt, zones); if (!next) return skip('No calling hours after the text.'); runAt = next; }
    if (runAt > want.until) return skip('By the next calling hour it is too late to be useful.', runAt);
    calls.push({ id, kind, runAt, exact: Boolean(o.exact), meta: o.meta ?? {}, until: want.until, attempt, status: 'queued', dialedAt: null });
  };
  const dial = (c: LiveCall, t: number) => {
    const lead = leadAt(t);
    const skip = (w: string) => { c.status = 'skipped'; add({ id: c.id, at: t, ch: 'call', status: 'skipped', title: STEP_META[c.kind].label, reason: w, phase: phaseOf(t), ref: { kind: 'wcall', key: c.kind, attempt: c.attempt } }); };
    const pb = personBlock(lead) ?? gateOn(inp, lead, 'call');
    if (pb) return skip(why(pb));
    const want = stillWanted(c.kind, ctxAt(t), purchase, c.meta, t);
    if (want.why) return skip(why(want.why));
    if (t > want.until) return skip('Too late to be useful.');
    const zones = callingZones(lead.phone) ?? [];
    if (!inCallingHours(t, zones)) { const next = nextCallingTime(t, zones); if (next && next <= want.until) { c.runAt = next; return; } return skip('Outside calling hours.'); }
    if (dials(t - DAY) >= PER_DAY_PER_PERSON) { const next = nextCallingTime(t + DAY, zones); if (next && next <= want.until) { c.runAt = next; return; } return skip(`Two calls in the last 24 hours (the most per person).`); }
    if (dials(t - 30 * MIN) > 0) { if (t + 30 * MIN <= want.until) { c.runAt = t + 30 * MIN; return; } return skip('Called in the last 30 minutes.'); }
    if (dials(t - 7 * DAY) >= weeklyCap(S)) return skip(`Weekly limit of ${weeklyCap(S)} calls reached.`);
    c.dialedAt = t;
    if (inp.choices.answers) {
      c.status = 'done';
      const stop = inp.choices.optOut === 'call' && dncAt == null;
      if (stop) dncAt = t;
      add({ id: c.id, at: t, ch: 'call', status: 'sent', title: STEP_META[c.kind].label, sub: stop ? 'Answered and asked not to be called again' : c.attempt > 1 ? `Answered on attempt ${c.attempt}` : 'Answered', phase: phaseOf(t), ref: { kind: 'wcall', key: c.kind, attempt: c.attempt },
        lines: stop ? ['Sam confirms and ends the call.', 'Every call, email and text to them stops (do not call, unsubscribed, texts off).'] : undefined });
      // Answered: the step is done; a queued retry for it is dropped.
      for (const o of calls) if (o !== c && o.kind === c.kind && o.status === 'queued') o.status = 'cancelled';
    } else {
      c.status = 'no_answer';
      const step = S2[c.kind];
      const want2 = stillWanted(c.kind, ctxAt(t), purchase, c.meta, t);
      const next = c.attempt < step.attempts && !want2.why ? nextCallingTime(t + step.spacingMin * MIN, zones) : null;
      add({ id: c.id, at: t, ch: 'call', status: 'sent', title: STEP_META[c.kind].label, sub: next && next <= want2.until ? `No answer · tries again (${c.attempt + 1} of ${step.attempts})` : `No answer · attempt ${c.attempt} of ${step.attempts}`, phase: phaseOf(t), ref: { kind: 'wcall', key: c.kind, attempt: c.attempt } });
      if (next && next <= want2.until && !personBlock(lead)) calls.push({ ...c, id: `c:${c.kind}:${c.attempt + 1}`, attempt: c.attempt + 1, runAt: next, status: 'queued', dialedAt: null });
    }
  };

  for (let t = firstTick; t <= horizon; t = t === firstTick ? Math.ceil((firstTick + 1) / TICK) * TICK : t + TICK) {
    // 1. AI calls due (the cron dials before it sends the live messages).
    for (const c of calls) if (c.status === 'queued' && c.runAt <= t) dial(c, t);
    // 2. Live messages: the same windows sendDueMessages uses.
    const st = stateAt(t);
    const reg = { created_at: regAt, joined_at: joinedBy(t), seq: 0 };
    const due = dueLiveMessages(evAt(t), reg, { now: t, ticketUnpaid: false, deposit: st.deposit, offerHours: ls.offerHours, tz, quiet, cadence });
    const lead = leadAt(t);
    for (const k of due) {
      if (fired.has(k)) continue;
      fired.add(k);
      const marketing = k === 'replay' || k === 'replay_last';
      const timed = (REMINDER_KINDS as string[]).includes(k) || k === 'confirm' ? (k as ReminderKind) : null;
      const wantEmail = !timed || cadence.email[timed];
      const wantText = timed ? cadence.sms[timed] : false;
      if (wantEmail) {
        if (lead.unsubscribed_at && (marketing || k !== 'confirm')) add({ id: `e:${k}`, at: t, ch: 'email', status: 'skipped', title: LIVE_LABEL[k], reason: 'Unsubscribed.', phase: phaseOf(t), ref: { kind: 'live', key: k } });
        else add({ id: `e:${k}`, at: t, ch: 'email', status: 'sent', title: LIVE_LABEL[k], phase: phaseOf(t), ref: { kind: 'live', key: k } });
      }
      if (wantText) liveTextAt(k, t);
    }
    // Post-event emails (lifecycle-db sendPost).
    const w = offerWindow(evAt(t), t, ls.offerHours);
    for (const k of duePost({ now: t, end: w.end, attended: Boolean(joinedBy(t)), boughtAt: boughtBy(t), offerOpened: w.opened, offerOpen: w.open, closesAt: w.closesAt, replayClosesAt: w.replayClosesAt })) {
      if (fired.has(`post:${k}`)) continue;
      fired.add(`post:${k}`);
      if (k !== 'buyer_docs' && lead.unsubscribed_at) add({ id: `e:post:${k}`, at: t, ch: 'email', status: 'skipped', title: POST_LABEL[k], reason: 'Unsubscribed.', phase: PH_AFTER, ref: { kind: 'post', key: k } });
      else add({ id: `e:post:${k}`, at: t, ch: 'email', status: 'sent', title: POST_LABEL[k], phase: PH_AFTER, ref: { kind: 'post', key: k } });
    }
    // 3. The webinar call planner: each candidate when the cron first sees it (webinarCandidates' windows).
    const cand = (kind: WKind, seeAt: number, runAt: number, o: { exact?: boolean; meta?: WMeta } = {}) => {
      if (planned.has(kind) || t < seeAt) return;
      planned.add(kind);
      planCall(kind, runAt, t, o);
    };
    if (inp.lead.callOk) {
      cand('w_pre_welcome', regAt, regAt + PLAN.welcomeAfterMin * MIN);
      if (regAt < start - PLAN.dayBeforeMinLeadH * HOUR) cand('w_pre_day', start - 25 * HOUR, start - DAY);
      cand('w_pre_start', start - 20 * MIN, start - PLAN.startBeforeMin * MIN, { exact: true });
      if (leftAt != null && leftAt < end - PLAN.leftEndGuardMin * MIN) cand('w_left', leftAt + leftWaitMin(S) * MIN, leftAt + leftWaitMin(S) * MIN, { meta: { leftAt, minute: Math.max(1, Math.floor((leftAt - start) / MIN)), offerUnlocked: openAt <= leftAt } });
      if (joinAt != null && joinAt <= end) cand('w_post_nobuy', end + PLAN.nobuyAfterEndMin * MIN, end + PLAN.nobuyAfterEndMin * MIN);
      else cand('w_post_missed', end + PLAN.missedAfterEndMin * MIN, end + PLAN.missedAfterEndMin * MIN);
      if (buyAt != null) cand('w_post_bought', buyAt, buyAt + PLAN.boughtAfterMin * MIN);
    }
  }

  function liveTextAt(k: LiveMessage, t: number) {
    const lead = leadAt(t);
    const id = `s:${k}`;
    const skip = (r: string) => add({ id, at: t, ch: 'sms', status: 'skipped', title: `Text: ${LIVE_LABEL[k]}`, reason: r, phase: phaseOf(t), ref: { kind: 'live', key: k } });
    const body0 = liveText(k, { title, when: formatCallTime(start, tz), site: SITE(rt), inRoom: true });
    if (!body0) return;
    if (!inp.lead.textOk) return skip('They didn’t tick the text box, so this reminder goes by email only.');
    const block = smsBlock(lead) ?? gateOn(inp, lead, 'sms');
    if (block) return skip(why(block));
    if (!lead.sms_consent_at) return skip('No consent to text.');
    const zones = textingZones(lead);
    if (!zones || !inTextingHours(t, zones)) return skip('Outside texting hours (8 am to 8 pm their time), and a live reminder is only right at its moment.');
    const clear = textAllowed(t, calls.filter((c) => c.status !== 'skipped' && c.status !== 'cancelled').map((c) => ({ run_at: c.runAt, status: c.status, kind: c.kind, wc_dialed_at: c.dialedAt })));
    if (!clear.ok) return skip(`An AI call to them is within ${CHANNEL_GAP_MIN} minutes: one moment, two channels at most.`);
    if (textsSent.filter((x) => x > t - DAY).length >= 3) return skip('Three texts in the last 24 hours (the daily cap).');
    const first = textsSent.length === 0;
    const body = `${body0} ${rt.origin}/s/sample${first ? ' Reply STOP to opt out.' : ''}`;
    textsSent.push(t);
    add({ id, at: t, ch: 'sms', status: 'sent', title: `Text: ${LIVE_LABEL[k]}`, sub: body, phase: phaseOf(t), ref: { kind: 'live', key: k, firstText: first }, text: textPayload(rt, body, lead.phone!, first) });
    if (first && inp.choices.optOut === 'text' && smsOutAt == null) {
      smsOutAt = t + 2 * MIN;
      add({ id: 'x:stop', at: t + 2 * MIN, ch: 'step', status: 'done', title: 'Replies STOP', phase: phaseOf(t), ref: { kind: 'info', key: 'stop' },
        lines: ['Everything to them stops: texts, every AI call and the reminder and marketing emails.', 'A later START reply turns texts back on only.'] });
    }
  }

  // ── reminders that never went: the reason, from the same rules ──
  const Tm = reminderTimes(start);
  const nominal: Partial<Record<LiveMessage, number>> = { ...Tm };
  for (const k of ['r24h', 'r3h', 'r1h', 'r10m', 'live', 'missing'] as ReminderKind[]) {
    if (fired.has(k) || !(cadence.email[k] || cadence.sms[k])) continue;
    const at = nominal[k]!;
    let reason: string;
    if (regAt >= at) reason = 'They registered after this moment.';
    else if ((k === 'live' || k === 'missing') && joinAt != null && joinAt <= at + (k === 'live' ? 10 : 20) * MIN) reason = 'Already in the room.';
    else if ((k === 'r24h' || k === 'r3h') && inQuiet(at, tz, quiet)) reason = `Inside their quiet hours (${quiet ? `${quiet.from}:00 to ${quiet.to}:00` : 'none set'}, their time) for the whole window.`;
    else if (k === 'live' && joinAt == null) reason = 'The "you’re missing it" email goes instead when both are due at once.';
    else reason = 'Not due in its window.';
    add({ id: `e:${k}`, at, ch: 'email', status: 'skipped', title: LIVE_LABEL[k], reason, phase: phaseOf(at), ref: { kind: 'live', key: k } });
  }
  if (!fired.has('replay') && buyAt != null && buyAt < end + 30 * MIN) add({ id: 'e:replay', at: end + 30 * MIN, ch: 'email', status: 'skipped', title: LIVE_LABEL.replay, reason: 'Already bought.', phase: PH_AFTER, ref: { kind: 'live', key: 'replay' } });
  if (!fired.has('replay_last')) add({ id: 'e:replay_last', at: w0.replayClosesAt - 6 * HOUR, ch: 'email', status: 'skipped', title: LIVE_LABEL.replay_last, reason: buyAt != null && buyAt < w0.replayClosesAt - 6 * HOUR ? 'Already bought.' : dncAt != null ? 'Unsubscribed.' : 'Not due.', phase: PH_AFTER, ref: { kind: 'live', key: 'replay_last' } });
  if (joinAt != null && buyAt == null && !fired.has('post:nobuy_questions')) add({ id: 'e:post:nobuy_questions', at: end + 20 * HOUR, ch: 'email', status: 'skipped', title: POST_LABEL.nobuy_questions, reason: dncAt != null ? 'Unsubscribed.' : 'Less than six hours of the offer left.', phase: PH_AFTER, ref: { kind: 'post', key: 'nobuy_questions' } });
  if (joinAt != null && buyAt != null && buyAt >= end) {
    // Bought the day after: the questions email would have gone only if still unbought.
    if (!fired.has('post:nobuy_questions')) add({ id: 'e:post:nobuy_questions', at: end + 20 * HOUR, ch: 'email', status: 'skipped', title: POST_LABEL.nobuy_questions, reason: 'Already bought.', phase: PH_AFTER, ref: { kind: 'post', key: 'nobuy_questions' } });
  }
  if (!inp.lead.callOk) add({ id: 'c:none', at: regAt + PLAN.welcomeAfterMin * MIN, ch: 'call', status: 'skipped', title: 'AI calls', reason: 'They didn’t tick the call box, so Sam never calls them.', phase: PH_BEFORE, ref: { kind: 'info', key: 'nocall' } });

  const S3 = accountState(rt);
  return {
    journey: 'live', start: regAt, end: horizon - TICK, anchor: inp.anchor, tz, eventTz: ls.tz, phone: COUNTRIES[inp.lead.country].phone, tier: null,
    markers: [{ at: start, label: 'Session starts' }, { at: end, label: 'Session ends' }, { at: w0.replayClosesAt, label: 'Offer and replay close' }],
    events: sortEvents(events), account: S3,
    assumptions: [
      `A sample session, "${title}", ${SAMPLE_DURATION_MIN} minutes long in our own room, with the host opening the deposit offer at minute ${SAMPLE_OFFER_MIN} and a replay recorded.`,
      'Free registration (no ticket), the default reminder cadence, and no lead-in emails (those are switched on per session).',
      'Every decision is taken on the cron’s 5-minute ticks, the way the live cron does.',
    ],
  };
}

/** The system's reasons, in the page's words. */
function why(r: string) {
  const map: Record<string, string> = {
    'no phone number': 'No phone number.', 'number outside the countries we call': 'Their number is in a country we don’t call or text.', 'number outside the countries we text': 'Their number is in a country we don’t call or text.',
    'asked not to be called': 'They asked not to be called.', 'no call consent': 'They didn’t tick the call box.', 'no consent to text': 'They didn’t agree to texts.', 'replied STOP': 'They replied STOP.',
    'no consent to call': 'They didn’t tick the call box.', 'consent was for a different number': 'Their consent was given for a different number, so it doesn’t count for this one.',
    'number changed since consent': 'Their number changed after they agreed, so the old consent doesn’t count.', 'consent withdrawn': 'They withdrew their consent.',
    'imported contact without consent': 'An imported contact who never agreed to calls or texts.', 'number outside the countries we contact': 'Their number is in a country we don’t call or text.',
    'replied STOP to texts': 'They replied STOP, which stops the webinar calls too.', 'unsubscribed from emails': 'Unsubscribed.', 'already in the room': 'Already in the room.', rejoined: 'They came back to the session.',
    bought: 'Already bought.', 'did not attend': 'Didn’t attend.', attended: 'Attended.', 'offer closed': 'The offer has closed.', 'no offer for this session': 'No offer was opened.', 'no replay': 'No replay.',
    'watched the replay': 'Watched the replay.', 'no longer booked': 'No longer booked.', 'call is too soon': 'The call is less than 30 minutes away.', 'already booked': 'Already booked.', 'not qualified': 'Not an A or B application.',
    'no longer a no-show': 'No longer a no-show.', 'sequence goal reached': 'The sequence has done its job.', 'imported contact': 'Imported contact.', 'ticket not paid': 'Ticket not paid.',
  };
  return map[r] ?? (r.charAt(0).toUpperCase() + r.slice(1) + (/[.]$/.test(r) ? '' : '.'));
}

const CH_ORDER: Record<Channel, number> = { step: 0, session: 1, purchase: 2, email: 3, sms: 4, call: 5 };
const sortEvents = (e: SimEvent[]) => {
  const seen = new Set<string>();
  return e.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true))).sort((a, b) => a.at - b.at || CH_ORDER[a.ch] - CH_ORDER[b.ch]);
};

// ───────────── application → strategy call ─────────────

const PH_APP = 'Application', PH_BOOK = 'Booked: the run-up to the call', PH_CALL = 'The strategy call', PH_NOSHOW = 'After a missed call';
const SEQ_LABEL: Record<string, string> = { tier_a: 'Approved (A)', tier_b: 'Mid-fit (B)', tier_c: 'Not ready yet (C)', booked: 'Booked', precall: 'Pre-call', no_show: 'Missed call', post_call: 'After the call' };
const CALL_LABEL: Record<string, string> = { speed_to_lead: 'Speed to lead', confirm: 'Booking confirmation', rebook: 'Missed call, rebook' };
const SMS_LABEL: Partial<Record<SmsTrigger, string>> = { qualified: 'Qualified, not booked', booked: 'Booked', no_show: 'Missed call', showed: 'After the call' };

type Item =
  | { at: number; type: 'email'; seq: string; step: number; template: string; id: string; group?: string }
  | { at: number; type: 'sms'; trigger: SmsTrigger; step: SmsStepDef; id: string }
  | { at: number; type: 'call'; kind: 'speed_to_lead' | 'confirm' | 'rebook'; attempt: number; id: string }
  | { at: number; type: 'action'; act: 'book' | 'outcome' | 'rebook' };

export interface StrategyTimes { applyAt: number; bookAt: number | null; callAt: number | null; outcomeAt: number | null; rebookAt: number | null; secondCallAt: number | null }
export function strategyTimes(inp: SbInput): StrategyTimes {
  const tz = inp.lead.tz;
  const c = inp.choices;
  // The next matching day from a week after the anchor.
  let day = inp.anchor + 7 * DAY;
  const want = c.appliesAt === 'saturday' ? 'Sat' : c.appliesAt === 'sunday' ? 'Sun' : null;
  for (let i = 0; i < 8; i++, day += DAY) { const w = weekday(day, tz); if (want ? w === want : !['Sat', 'Sun'].includes(w)) break; }
  const hour = c.appliesAt === 'weekday_morning' ? 10.5 : c.appliesAt === 'weekday_night' ? 22.5 : c.appliesAt === 'saturday' ? 16 : 11;
  const applyAt = dayAt(day, hour, tz);
  const bookAt = c.booksAfter == null ? null : applyAt + c.booksAfter * MIN;
  const callAt = bookAt == null ? null : dayAt(bookAt + c.callInDays * DAY, 10, tz);
  const outcomeAt = callAt == null ? null : callAt + 45 * MIN;
  const rebookAt = c.noShow && c.rebooks && outcomeAt != null ? outcomeAt + DAY : null;
  const secondCallAt = rebookAt == null ? null : dayAt(rebookAt + 2 * DAY, 10, tz);
  return { applyAt, bookAt, callAt, outcomeAt, rebookAt, secondCallAt };
}

function simulateStrategy(rt: Runtime, inp: SbInput): SimResult {
  const S = rt.settings;
  const tz = inp.lead.tz;
  const T = strategyTimes(inp);
  const events: SimEvent[] = [];
  const add = (e: SimEvent) => { events.push(e); return e; };
  const score = scoreApplication(sampleAnswers(inp.lead.revenue) as never, { country: inp.lead.country, email: SAMPLE_EMAIL, phone: COUNTRIES[inp.lead.country].phone });
  const tier = score.tier;
  let lead: Lead = { ...baseLead(inp, T.applyAt), app_completed_at: T.applyAt, tier, score: score.score, status: tier === 'C' ? 'nurture' : 'applied', step_reached: 9 } as Lead;
  const queue: Item[] = [];
  const push = (i: Item) => queue.push(i);
  const textsSent: number[] = [];
  const callsDone = new Set<string>();
  const callFlow = (k: CallKind) => (k === 'confirm' ? S.AI_CALL_CONFIRM : k === 'speed_to_lead' ? S.AI_CALL_SPEED_TO_LEAD : S.AI_CALL_REBOOK);
  const cancelled = new Set<string>();
  const pending = (pred: (i: Item) => boolean, why: string, at: number) => {
    for (const i of queue) if (i.type !== 'action' && pred(i) && !cancelled.has(i.id)) {
      cancelled.add(i.id);
      add({ id: i.id, at: i.at, ch: i.type === 'email' ? 'email' : i.type === 'sms' ? 'sms' : 'call', status: 'cancelled', title: titleOf(i), reason: why, phase: phaseFor(i.at), group: `cancelled:${at}`,
        ref: i.type === 'email' ? { kind: 'seq', key: i.template, sequence: i.seq, step: i.step } : i.type === 'sms' ? { kind: 'sms', key: `${i.trigger}:${i.step.n}`, trigger: i.trigger, step: i.step.n } : { kind: 'call', key: i.kind, attempt: i.attempt } });
    }
  };
  const phaseFor = (t: number) => (T.callAt && t >= T.callAt + 30 * MIN ? (inp.choices.noShow ? PH_NOSHOW : PH_CALL) : T.bookAt && t >= T.bookAt ? PH_BOOK : PH_APP);
  const titleOf = (i: Item) => (i.type === 'email' ? `${SEQ_LABEL[i.seq] ?? i.seq} email ${i.step + 1}` : i.type === 'sms' ? `Text: ${SMS_LABEL[i.trigger] ?? i.trigger} ${i.step.n}` : i.type === 'call' ? CALL_LABEL[i.kind] : '');

  const enqueueSeq = (seq: keyof typeof SEQUENCES, now: number) => {
    if (!lead.email || lead.unsubscribed_at) return;
    SEQUENCES[seq].steps.forEach((st, j) => {
      const kind = 'anchor' in st ? st.anchor : 'start';
      const anchor = kind === 'call_at' ? lead.call_at : kind === 'webinar_at' ? lead.webinar_at : now;
      if (anchor == null) return;
      const at = anchor + st.offsetMs;
      if (kind !== 'start' && at < now - 5 * MIN) return;
      push({ at, type: 'email', seq, step: j, template: st.template, id: `m:${seq}:${j}:${now}` });
    });
  };
  const enqueuePre = (now: number) => {
    if (!lead.email || lead.unsubscribed_at) return;
    const { perDay, min, max } = precallLimits(rt);
    if (perDay <= 0 || max <= 0) return;
    const times = precallTimes(now, lead.call_at, tz, perDay, Math.min(max, precallPlan(lead).length), min);
    const plan = precallPlan(lead, times.length);
    times.forEach((at, i) => push({ at, type: 'email', seq: 'precall', step: i, template: plan[i], id: `m:precall:${i}:${now}`, group: `precall:${now}` }));
  };
  const startSmsSeq = (trigger: SmsTrigger, now: number) => {
    if (S.SMS_ENABLED?.trim().toLowerCase() === 'false') return;
    if (smsBlock(lead) || !smsOk(lead) || gateOn(inp, lead, 'sms')) return;
    const seq = DEFAULT_SMS_SEQUENCES.find((s) => s.id === trigger);
    if (!seq?.enabled) return;
    for (const step of seq.steps) {
      const anchor = step.anchor === 'call' ? lead.call_at : step.anchor === 'webinar' ? lead.webinar_at : now;
      if (anchor == null) continue;
      const at = anchor + step.offsetMin * MIN;
      if (step.anchor !== 'trigger' && at < now - 5 * MIN) continue;
      push({ at, type: 'sms', trigger, step, id: `t:${trigger}:${step.n}:${now}` });
    }
  };
  const queueCall = (kind: 'speed_to_lead' | 'confirm' | 'rebook', delayMin: number, now: number) => {
    const id = `k:${kind}:${now}`;
    const skip = (r: string, at = now + delayMin * MIN) => add({ id, at, ch: 'call', status: 'skipped', title: CALL_LABEL[kind], reason: r, phase: phaseFor(at), ref: { kind: 'call', key: kind, attempt: 1 } });
    if (!enabled(callFlow(kind) ?? '')) return skip('This call is turned off in settings.');
    const b = blockReason(asOf(lead, now), kind) ?? gateOn(inp, lead, 'call');
    if (b) return skip(why(b));
    if (callsDone.has(kind)) return skip('One call of this kind per lead.');
    const runAt = nextCallingTime(now + delayMin * MIN, callingZones(lead.phone) ?? []);
    if (!runAt) return skip('No calling hours in the next five days.');
    if (kind === 'confirm' && lead.call_at && runAt > lead.call_at - 2 * HOUR) return skip('The next calling hour is within two hours of the call: the email reminders cover it.', runAt);
    if (kind !== 'confirm' && runAt > now + 72 * HOUR) return skip('Stale by the next calling hour (more than 72 hours away).', runAt);
    callsDone.add(kind);
    push({ at: runAt, type: 'call', kind, attempt: 1, id: `k:${kind}:1:${now}` });
  };

  // ── apply (application.ts) ──
  add({ id: 'x:apply', at: T.applyAt, ch: 'step', status: 'done', title: 'Sends the application', sub: `Scored ${score.score}: tier ${tier} · ${weekday(T.applyAt, tz)} ${new Intl.DateTimeFormat('en-AU', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(T.applyAt)} their time`, phase: PH_APP, ref: { kind: 'info', key: 'apply' },
    lines: [`The real scoring gives this sample ${score.score} points, tier ${tier}.`, tier === 'C' ? 'Tier C: the "not ready yet" emails, no call.' : `Tier ${tier}: the ${SEQ_LABEL[`tier_${tier.toLowerCase()}`]} emails, the qualified texts and a speed-to-lead call.`, inp.lead.callOk ? 'They ticked "call or text me", so calls and texts can go.' : 'They didn’t tick "call or text me", so no calls or texts.'] });
  enqueueSeq(`tier_${tier.toLowerCase()}` as 'tier_a', T.applyAt);
  startSmsSeq('qualified', T.applyAt);
  if (tier !== 'C') queueCall('speed_to_lead', AI_CALLER.speedToLeadDelayMinutes, T.applyAt);
  if (T.bookAt != null) push({ at: T.bookAt, type: 'action', act: 'book' });
  if (T.outcomeAt != null) push({ at: T.outcomeAt, type: 'action', act: 'outcome' });
  if (T.rebookAt != null) push({ at: T.rebookAt, type: 'action', act: 'rebook' });
  if (!inp.lead.callOk && !inp.lead.textOk) add({ id: 'c:none', at: T.applyAt + 5 * MIN, ch: 'call', status: 'skipped', title: 'Calls and texts', reason: 'They didn’t tick "call or text me".', phase: PH_APP, ref: { kind: 'info', key: 'nocall' } });

  const book = (t: number, callAt: number, second: boolean) => {
    lead = { ...lead, status: 'booked', booked_at: t, call_at: callAt, booking_cancelled_at: null };
    add({ id: second ? 'x:rebook' : 'x:book', at: t, ch: 'step', status: 'done', title: second ? 'Books a new time' : 'Books a strategy call', sub: `For ${formatCallTime(callAt, tz)}`, phase: second ? PH_NOSHOW : PH_BOOK, ref: { kind: 'info', key: 'book' },
      lines: ['Calendly confirms the booking by webhook.', 'The approval emails, the qualified texts and any queued speed-to-lead call stop.', 'The confirmation, the reminders, the pre-call emails and a confirmation call start.'] });
    pending((i) => i.type === 'email' && ['tier_a', 'tier_b', 'tier_c', 'no_show'].includes(i.seq) && i.at > t, 'Booked a call: this sequence is cancelled.', t);
    pending((i) => i.type === 'call' && (i.kind === 'speed_to_lead' || i.kind === 'rebook') && i.at > t, 'Booked before the call: cancelled.', t);
    pending((i) => i.type === 'sms' && ['qualified', 'no_show'].includes(i.trigger) && i.at > t, 'Booked: these texts stop.', t);
    callsDone.delete('confirm');
    queueCall('confirm', AI_CALLER.confirmDelayMinutes, t);
    enqueueSeq('booked', t);
    startSmsSeq('booked', t);
    enqueuePre(t);
  };

  const dialCall = (i: Extract<Item, { type: 'call' }>, t: number) => {
    const b = blockReason(asOf(lead, t), i.kind) ?? gateOn(inp, lead, 'call');
    const base = { id: i.id, at: t, ch: 'call' as const, title: CALL_LABEL[i.kind], phase: phaseFor(t), ref: { kind: 'call' as const, key: i.kind, attempt: i.attempt } };
    if (b) return add({ ...base, status: 'skipped', reason: why(b) });
    const zones = callingZones(lead.phone) ?? [];
    if (!inCallingHours(t, zones)) { const next = nextCallingTime(t, zones); if (next) { push({ ...i, at: next }); return; } return add({ ...base, status: 'skipped', reason: 'Outside calling hours.' }); }
    if (inp.choices.answers) {
      const stop = inp.choices.optOut === 'call' && !lead.do_not_call_at;
      add({ ...base, status: 'sent', sub: stop ? 'Answered and asked not to be called again' : i.attempt > 1 ? `Answered on attempt ${i.attempt}` : 'Answered', lines: stop ? ['Sam confirms and ends the call.', 'Every call, email and text to them stops (do not call, unsubscribed, texts off).'] : undefined });
      if (stop) {
        lead = { ...lead, do_not_call_at: t, unsubscribed_at: t, sms_opt_out_at: t };
        pending((x) => x.at > t && x.type !== 'action', 'They asked not to be contacted: cancelled.', t);
      }
      return;
    }
    const next = i.attempt < AI_CALLER.maxAttempts ? nextCallingTime(t + AI_CALLER.retryAfterMinutes * MIN, zones) : null;
    const again = next && !blockReason(asOf(lead, next), i.kind) && !(i.kind === 'confirm' && lead.call_at && next > lead.call_at - 2 * HOUR);
    add({ ...base, status: 'sent', sub: again ? `No answer · tries again (${i.attempt + 1} of ${AI_CALLER.maxAttempts})` : `No answer · attempt ${i.attempt} of ${AI_CALLER.maxAttempts}` });
    if (again) push({ ...i, at: next!, attempt: i.attempt + 1, id: `k:${i.kind}:${i.attempt + 1}:${i.id}` });
  };

  const sendEmail = (i: Extract<Item, { type: 'email' }>, t: number) => {
    const seq = SEQUENCES[i.seq as keyof typeof SEQUENCES];
    const st = seq.steps.find((x) => x.template === i.template) ?? seq.steps[i.step];
    const base = { id: i.id, at: t, ch: 'email' as const, title: `${SEQ_LABEL[i.seq] ?? i.seq} email ${i.step + 1}`, phase: phaseFor(t), group: i.group, ref: { kind: 'seq' as const, key: i.template, sequence: i.seq, step: i.step } };
    const L = asOf(lead, t);
    if (lead.unsubscribed_at) return add({ ...base, status: 'skipped', reason: 'Unsubscribed.' });
    if ('stopIf' in seq && seq.stopIf?.(L)) return add({ ...base, status: 'skipped', reason: i.seq === 'precall' && lead.call_at && t > lead.call_at - 2 * HOUR ? 'Within two hours of the call: the pre-call emails stop.' : 'The sequence has done its job.' });
    if (st && 'skipIf' in st && typeof st.skipIf === 'function' && st.skipIf(L)) return add({ ...base, status: 'skipped', reason: 'This email’s own condition says skip.' });
    return add({ ...base, status: 'sent' });
  };

  const sendText = (i: Extract<Item, { type: 'sms' }>, t: number) => {
    const base = { id: i.id, at: t, ch: 'sms' as const, title: `Text: ${SMS_LABEL[i.trigger] ?? i.trigger} ${i.step.n}`, phase: phaseFor(t), ref: { kind: 'sms' as const, key: `${i.trigger}:${i.step.n}`, trigger: i.trigger, step: i.step.n } };
    const skipKey = i.step.skip.find((k) => SMS_SKIP[k](lead, false));
    const w = smsBlock(lead) ?? gateOn(inp, lead, 'sms') ?? (SMS_GOAL[i.trigger]?.(lead) ? 'sequence goal reached' : null) ?? (skipKey ? `skip: ${skipKey}` : null);
    if (w) return add({ ...base, status: 'skipped', reason: w === 'skip: booked' && lead.status === 'no_show' ? 'Skip rule "booked": the missed booking still counts as booked, so this text doesn’t go after a no-show.' : w.startsWith('skip: ') ? `Skip rule: ${w.slice(6)}.` : why(w) });
    const zones = textingZones(lead)!;
    if (!inTextingHours(t, zones)) {
      const next = nextTextingTime(t, zones);
      const anchor = i.step.anchor === 'call' ? lead.call_at : null;
      if (staleBeforeAnchor(next, anchor, i.step.offsetMin)) return add({ ...base, status: 'skipped', reason: 'Outside texting hours (8 am to 8 pm their time), and by then it would be too close to the call to help.' });
      push({ ...i, at: next! });
      return;
    }
    if (textsSent.filter((x) => x > t - DAY).length >= 3) return add({ ...base, status: 'skipped', reason: 'Three texts in the last 24 hours (the daily cap).' });
    const first = textsSent.length === 0;
    const { body } = renderSms(rt, asOf(lead, t), i.step, 'sample', first);
    textsSent.push(t);
    add({ ...base, status: 'sent', sub: body, ref: { ...base.ref, firstText: first }, text: textPayload(rt, body, lead.phone!, first) });
    if (first && inp.choices.optOut === 'text' && !lead.sms_opt_out_at) {
      lead = { ...lead, sms_opt_out_at: t + 2 * MIN, do_not_call_at: lead.do_not_call_at ?? t + 2 * MIN, unsubscribed_at: lead.unsubscribed_at ?? t + 2 * MIN };
      add({ id: 'x:stop', at: t + 2 * MIN, ch: 'step', status: 'done', title: 'Replies STOP', phase: phaseFor(t), ref: { kind: 'info', key: 'stop' },
        lines: ['Everything to them stops: every pending text, AI call and email is cancelled.', 'A later START reply turns texts back on only.'] });
      pending((x) => x.at > t && (x.type === 'sms' || x.type === 'email' || x.type === 'call'), 'They replied STOP.', t);
    }
  };

  const horizon = (T.secondCallAt ?? T.outcomeAt ?? T.applyAt) + (T.outcomeAt && inp.choices.noShow && !T.rebookAt ? 8 * DAY : T.bookAt ? 2 * DAY : 8 * DAY);
  for (let guard = 0; guard < 5000; guard++) {
    queue.sort((a, b) => a.at - b.at);
    const i = queue.shift();
    if (!i || i.at > horizon) break;
    if (i.type !== 'action' && cancelled.has(i.id)) continue;
    const t = i.at;
    if (i.type === 'action') {
      if (i.act === 'book' && T.callAt) book(t, T.callAt, false);
      if (i.act === 'rebook' && T.secondCallAt) book(t, T.secondCallAt, true);
      if (i.act === 'outcome') {
        if (inp.choices.noShow) {
          lead = { ...lead, status: 'no_show' };
          add({ id: 'x:noshow', at: T.callAt!, ch: 'session', status: 'note', title: 'Doesn’t show up for the call', sub: 'The closer logs the no-show', phase: PH_NOSHOW, ref: { kind: 'info', key: 'noshow' },
            lines: ['The booked reminders and the pre-call emails stop.', 'The missed call emails and texts start, with a call from Sam to find a new time.'] });
          pending((x) => x.type === 'email' && (x.seq === 'booked' || x.seq === 'precall') && x.at > t, 'Logged as a no-show: cancelled.', t);
          pending((x) => x.type === 'sms' && x.trigger === 'booked' && x.at > t, 'Logged as a no-show: cancelled.', t);
          enqueueSeq('no_show', t);
          startSmsSeq('no_show', t);
          callsDone.delete('rebook');
          queueCall('rebook', AI_CALLER.rebookDelayMinutes, t);
        } else {
          lead = { ...lead, status: 'showed', showed_at: T.callAt };
          add({ id: 'x:showed', at: T.callAt!, ch: 'session', status: 'done', title: 'Holds the strategy call', sub: 'With Josh’s team', phase: PH_CALL, ref: { kind: 'info', key: 'showed' },
            lines: ['The closer logs the outcome in Funnel HQ → Calls & deals.', 'Showed, no decision yet: the after-the-call emails and texts follow until they decide.'] });
          enqueueSeq('post_call', t);
          startSmsSeq('showed', t);
        }
      }
      continue;
    }
    if (i.type === 'call') dialCall(i, t);
    else if (i.type === 'email') sendEmail(i, t);
    else sendText(i, t);
  }
  if (T.secondCallAt) add({ id: 'x:showed2', at: T.secondCallAt, ch: 'session', status: 'done', title: 'Holds the rebooked call', phase: PH_NOSHOW, ref: { kind: 'info', key: 'showed' }, lines: ['From here it runs like any held call.'] });
  if (T.bookAt == null) add({ id: 'x:nobook', at: T.applyAt + 7 * DAY, ch: 'step', status: 'note', title: 'Never books', phase: PH_APP, ref: { kind: 'info', key: 'nobook' }, lines: ['The approval emails run to their end, then the six-month nurture takes over (not shown here).'] });

  return {
    journey: 'strategy', start: T.applyAt, end: Math.max(horizon, ...events.map((e) => e.at)), anchor: inp.anchor, tz, eventTz: null, phone: COUNTRIES[inp.lead.country].phone, tier,
    markers: [{ at: T.applyAt, label: 'Applies' }, ...(T.bookAt ? [{ at: T.bookAt, label: 'Books' }] : []), ...(T.callAt ? [{ at: T.callAt, label: 'Strategy call' }] : []), ...(T.secondCallAt ? [{ at: T.secondCallAt, label: 'Rebooked call' }] : [])],
    events: sortEvents(events), account: accountState(rt),
    assumptions: [
      'The booking comes through Calendly with a confirmed webhook, and the closer logs the outcome 45 minutes after the call starts.',
      'The default text sequences (your edits in Funnel HQ → Texts are not applied here). The long six-month flows that also start are not shown.',
      'Every email, text and call is checked at its send time against the lead as it is then, like the queues do.',
    ],
  };
}

export function simulate(rt: Runtime, inp: SbInput): SimResult {
  return inp.journey === 'live' ? simulateLive(rt, inp) : simulateStrategy(rt, inp);
}

// ───────────── read-only runtime for previews ─────────────

/** Preview links are signed with this throwaway value, so no real secret is read (or created) and the links never verify. */
let previewSigning = '';
const PREVIEW_SIGNING = () => (previewSigning ||= ['sandbox', 'preview', crypto.randomUUID()].join(':'));

/** The runtime the previews use: reads pass through; any write throws; links are signed with a throwaway secret. */
export function readOnlyRuntime(rt: Runtime): Runtime {
  const db = rt.env.DB;
  const deny = () => { throw new Error('Sandbox: database writes are blocked.'); };
  const guard = (sql: string) => {
    const q = sql.trim();
    if (!/^(SELECT|WITH)\b/i.test(q) || /\)\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(q) || /;\s*\S/.test(q)) deny();
  };
  const ro = { prepare: (sql: string) => { guard(sql); return db.prepare(sql); }, batch: deny, exec: deny, dump: deny, withSession: deny } as unknown as typeof db;
  return { ...rt, env: { ...rt.env, DB: ro, SESSION_SECRET: PREVIEW_SIGNING() } as typeof rt.env, waitUntil: () => undefined };
}

// ───────────── the detail sheet ─────────────

export interface Detail {
  id: string;
  kind: 'email' | 'sms' | 'call' | 'info';
  title: string;
  status: Status;
  reason?: string;
  at: number;
  email?: { subject: string; preheader: string; html: string; from: string };
  text?: SimEvent['text'];
  call?: { agent: string; firstMessage: string; vars: Record<string, string>; talk: { kind: string; label: string } | null; live: boolean; sales: CallSales; booking?: CallBooking };
  lines?: string[];
}

function liveMailFor(rt: Runtime, inp: SbInput, ev: SimEvent): Mail | null {
  const ls = liveSettings(rt);
  const T = liveTimes(rt, inp);
  const t = ev.at;
  const tz = inp.lead.tz;
  const w = offerWindow({ starts_at: T.start, duration_min: SAMPLE_DURATION_MIN, ended_at: null, offer_opened_at: t >= T.openAt ? T.openAt : null, offer_closed_at: null, offer_hours: ls.offerHours, status: 'scheduled' }, t, ls.offerHours);
  const room = liveRoomUrl(rt, 'sample');
  if (ev.ref.kind === 'live') {
    return liveEmail(ev.ref.key as LiveMessage, {
      name: inp.lead.name, title: ls.defaultTitle, when: formatCallTime(T.start, tz), room: `${room}?via=e-${ev.ref.key}`, ticket: null, ticketLabel: null, attended: Boolean(T.joinAt != null && T.joinAt <= t),
      offerOpened: w.opened, closes: formatCallTime(w.replayClosesAt, tz), replay: true, deposit: depositConfig(rt).label, inRoom: true, rescheduled: false,
      calendar: { google: `${room}/cal/google`, outlook: `${room}/cal/outlook`, apple: `${room}/cal/apple.ics` },
    });
  }
  if (ev.ref.kind === 'post') {
    return postEmail(ev.ref.key as PostKind, {
      name: inp.lead.name, title: ls.defaultTitle, room: `${room}?via=e-${ev.ref.key}`, closes: w.open ? formatCallTime(w.closesAt, tz) : null, deposit: depositConfig(rt).label, onboarding: onboardingUrl(rt),
      highlights: ['Where the businesses are, and why the owners sell', 'How the purchase gets funded: commercial debt, seller finance and seller rollover', 'The 1.5x test every deal has to pass'],
      replayCloses: t < w.replayClosesAt ? formatCallTime(w.replayClosesAt, tz) : null, pay: w.open ? `${room}?pay=deposit` : null,
    });
  }
  if (ev.ref.kind === 'deposit') {
    const g = guarantee(rt);
    return depositWelcomeEmail({ name: inp.lead.name, amount: depositConfig(rt).label, onboardingUrl: onboardingUrl(rt), welcomeUrl: `${rt.origin}/live/welcome/sample`, guaranteeUrl: g.url, headline: g.headline });
  }
  return null;
}

/** The lead as the strategy simulation had them at `t` (for the email and call previews). */
function strategyLeadAt(inp: SbInput, t: number): Lead {
  const T = strategyTimes(inp);
  const score = scoreApplication(sampleAnswers(inp.lead.revenue) as never, { country: inp.lead.country, email: SAMPLE_EMAIL, phone: COUNTRIES[inp.lead.country].phone });
  let l: Lead = { ...baseLead(inp, T.applyAt), app_completed_at: T.applyAt, tier: score.tier, score: score.score, status: score.tier === 'C' ? 'nurture' : 'applied' } as Lead;
  if (T.bookAt != null && t >= T.bookAt) l = { ...l, status: 'booked', booked_at: T.bookAt, call_at: T.callAt };
  if (T.outcomeAt != null && t >= T.outcomeAt) l = { ...l, status: inp.choices.noShow ? 'no_show' : 'showed' };
  if (T.rebookAt != null && t >= T.rebookAt) l = { ...l, status: 'booked', booked_at: T.rebookAt, call_at: T.secondCallAt };
  return l;
}

export async function detail(rt0: Runtime, inp: SbInput, id: string): Promise<Detail | null> {
  const rt = readOnlyRuntime(rt0);
  const sim = simulate(rt, inp);
  const ev = sim.events.find((e) => e.id === id);
  if (!ev) return null;
  const out: Detail = { id, kind: ev.ch === 'email' ? 'email' : ev.ch === 'sms' ? 'sms' : ev.ch === 'call' && ev.ref.kind !== 'info' ? 'call' : 'info', title: ev.title, status: ev.status, reason: ev.reason, at: ev.at, lines: ev.lines };
  if (out.kind === 'email') {
    const co = (await import('../sales/contracts')).company(rt);
    if (ev.ref.kind === 'seq') {
      const lead = { ...strategyLeadAt(inp, ev.at) };
      const { buildEmail } = await import('../integrations/email');
      const m = await buildEmail(rt, lead, `sandbox-${ev.ref.key}`, ev.ref.key, 'sandbox');
      out.email = { subject: m.subject, preheader: '', html: m.html, from: rt.settings.EMAIL_FROM || 'your sending address' };
    } else {
      const mail = liveMailFor(rt, inp, ev);
      if (mail) out.email = { subject: mail.subject, preheader: mail.preheader, html: renderMail(rt, mail).html, from: co.signer };
    }
  }
  if (out.kind === 'sms') {
    if (ev.text) out.text = ev.text;
    else if (ev.ref.kind === 'sms' && ev.ref.trigger) {
      // A text that didn't go: what it would have said.
      const step = DEFAULT_SMS_SEQUENCES.find((s) => s.id === ev.ref.trigger)?.steps.find((s) => s.n === ev.ref.step);
      if (step) { const { body } = renderSms(rt, strategyLeadAt(inp, ev.at), step, 'sample', false); out.text = textPayload(rt, body, COUNTRIES[inp.lead.country].phone, false); }
    } else if (ev.ref.kind === 'live') {
      const T = liveTimes(rt, inp);
      const b = liveText(ev.ref.key as LiveMessage, { title: liveSettings(rt).defaultTitle, when: formatCallTime(T.start, inp.lead.tz), site: SITE(rt), inRoom: true });
      if (b) out.text = textPayload(rt, `${b} ${rt.origin}/s/sample`, COUNTRIES[inp.lead.country].phone, false);
    }
  }
  if (out.kind === 'call') out.call = await callDetail(rt, inp, ev);
  return out;
}

/** The call sheet's sales view: this call's one objective, and the guide Sam offers for the sample's challenge. */
export interface CallSales {
  label: string; objective: string; success: string; examples: string[];
  pain: { id: Pain; label: string; says: string; title: string; why: string; url: string } | null;
  email: string;
}
export function callSales(rt: Pick<Runtime, 'origin'> & { settings?: Runtime['settings'] }, inp: SbInput, context: CallContext): CallSales {
  const base = NEXT_ACTIONS[context];
  // With live booking on, the strategy calls carry the objective with real times (what variables() sends).
  const a = rt.settings && bookingToolsOn(rt.settings) && base.live ? { ...base, ...base.live } : base;
  const p = inp.choices.pain === 'none' ? null : inp.choices.pain;
  const r = p ? RESOURCES[p] : null;
  const stopped = inp.choices.optOut !== 'none';
  return {
    label: a.label, objective: a.objective, success: a.success, examples: a.examples,
    pain: p && r ? { id: p, label: r.pain, says: r.cues.split(', ')[0].replace(/^"|"$/g, ''), title: r.title, why: r.why, url: `${rt.origin}${r.path}` } : null,
    email: !p ? 'They name no challenge, so Sam offers no guide.'
      : stopped ? 'This sample opts out, so no guide is emailed: nothing goes to anyone who unsubscribed, replied STOP or asked not to be called.'
      : !inp.lead.callOk ? 'They didn’t tick “call me”, so there is no call and no guide.'
      : 'If they say yes, one short email with the guide goes out after the call: once per guide per lead, never to anyone who unsubscribed, replied STOP or asked not to be called.',
  };
}

/** What Sam is told for this call: built by the real builders from the simulated moment. */
export async function callDetail(rt: Runtime, inp: SbInput, ev: SimEvent): Promise<NonNullable<Detail['call']>> {
  const fill = (tpl: string, v: Record<string, string>) => tpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => v[k] ?? '');
  if (ev.ref.kind === 'wcall') {
    const kind = ev.ref.key as WKind;
    const vars = await webinarCallVars(rt, inp, kind, ev.at, ev.ref.attempt ?? 1);
    return { agent: 'Webinar calls agent', firstMessage: fill(W_FIRST_MESSAGE, vars), vars, talk: { kind, label: STEP_META[kind].label }, live: webinarAgentReady(rt.settings as unknown as Partial<Record<string, string>>), sales: callSales(rt, inp, kind) };
  }
  const kind = ev.ref.key as 'speed_to_lead' | 'confirm' | 'rebook';
  const vars = strategyCallVars(rt, inp, kind, ev.at);
  return { agent: 'Outbound calls agent', firstMessage: fill(AI_CALLER.firstMessage, vars), vars, talk: { kind, label: CALL_LABEL[kind] }, live: elevenConfigured(rt.settings), sales: callSales(rt, inp, kind), booking: callBooking(rt, inp, kind, ev.at) };
}

export interface CallBooking { on: boolean; title: string; lines: string[]; sample: string[]; sampleNote: string }

/** Sam's live calendar tools on this call (src/integrations/calendly-tools.ts), with sample times (nothing is looked up). */
export function callBooking(rt: Runtime, inp: SbInput, kind: 'speed_to_lead' | 'confirm' | 'rebook', t: number): CallBooking {
  const on = bookingToolsOn(rt.settings);
  const tz = inp.lead.tz || rt.settings.SALES_TIMEZONE || 'Australia/Sydney';
  const what = kind === 'confirm' ? 'If the booked time no longer works, Sam moves it on the call: the new time is booked first, then the old one is cancelled.'
    : kind === 'speed_to_lead' ? 'When they want the strategy call, Sam books it on the call.'
    : 'When they want a new time, Sam books it on the call.';
  return {
    on,
    title: on ? 'Sam can book and move the call live' : 'Live booking is off',
    lines: on
      ? [what, 'Sam offers two or three real open times from Calendly (not within two hours, next 7 days) in their own time zone, books the one they pick and confirms it in one sentence. Calendly emails the invite.', 'If the time is taken, Sam offers others. If booking fails, the booking link is emailed instead, once.']
      : [rt.settings.CALENDLY_API_TOKEN ? 'AI_CALL_BOOKING_TOOLS is set to false, so Sam emails the link to pick a time instead.' : 'Add the Calendly token (Integrations → Booking) to let Sam book and move calls live. Until then the link to pick a time is emailed.'],
    sample: on ? sampleSlots(t, tz).map((x) => `${x}, ${tzLabel(tz)}`) : [],
    sampleNote: 'Sample times for illustration. On a real call they come from Calendly.',
  };
}

export function strategyCallVars(rt: Runtime, inp: SbInput, kind: 'speed_to_lead' | 'confirm' | 'rebook', t: number) {
  return { ...variables(rt, strategyLeadAt(inp, t), kind), lead_ref: 'DEMO', email: SAMPLE_EMAIL };
}

/** The live session context at `t`, as the simulation has it (the same object the call builder reads from our tables). */
export async function webinarCallVars(rt: Runtime, inp: SbInput, kind: WKind, t: number, attempt: number) {
  const ls = liveSettings(rt);
  const T = liveTimes(rt, inp);
  const ev = { starts_at: T.start, duration_min: SAMPLE_DURATION_MIN, ended_at: null, offer_opened_at: t >= T.openAt ? T.openAt : null, offer_closed_at: null, offer_hours: ls.offerHours, status: 'scheduled' as const };
  const w = offerWindow(ev, t, ls.offerHours);
  const room = liveRoomUrl(rt, 'sample');
  const ctx: WCtx = {
    funnel: 'live', regId: 'sandbox', leadId: 'sandbox', token: 'sample', day: null, title: ls.defaultTitle, startsAt: T.start, endsAt: eventEnd(ev), cancelled: false, regCreatedAt: T.regAt, ticketPending: false,
    joinedAt: T.joinAt != null && T.joinAt <= t ? T.joinAt : null, lastSeenAt: T.leftAt ?? null, replayWatchedAt: null, replayClosesAt: w.replayClosesAt,
    offer: { name: 'engagement deposit', relevant: true, opened: w.opened, open: w.open, closesAt: w.opened ? w.closesAt : null, openedAt: ev.offer_opened_at },
    bought: { sprint: false, deposit: T.buyAt != null && T.buyAt <= t, vip: false }, links: { join: room, replay: room, offer: room }, host: new URL(room).host,
    prep: 'a computer with sound, Zoom installed, and last year’s revenue and profit figures for their business.',
  };
  const purchase = kind === 'w_post_bought' && T.buyAt != null ? { kind: 'deposit' as const, id: 'sample', paidAt: T.buyAt, refunded: false, amount: 0, currency: 'usd' } : null;
  const meta: WMeta = kind === 'w_left' && T.leftAt != null ? { leftAt: T.leftAt, minute: Math.max(1, Math.floor((T.leftAt - T.start) / MIN)), offerUnlocked: T.openAt <= T.leftAt } : {};
  const lead = { ...baseLead(inp, T.regAt), id: 'sandbox' } as Lead;
  return callVariables(rt, kind, lead, ctx, purchase, meta, attempt, t);
}

/** "Talk to Sam now": the variables for one call of the simulation (server side; the browser never builds them). */
export async function sandboxCallSession(rt0: Runtime, inp: SbInput, id: string): Promise<{ agent: 'outbound' | 'webinar'; vars: Record<string, string>; label: string } | null> {
  const rt = readOnlyRuntime(rt0);
  const ev = simulate(rt, inp).events.find((e) => e.id === id);
  if (!ev || ev.ch !== 'call' || (ev.ref.kind !== 'wcall' && ev.ref.kind !== 'call')) return null;
  if (ev.ref.kind === 'wcall') return { agent: 'webinar', vars: { ...(await webinarCallVars(rt, inp, ev.ref.key as WKind, ev.at, ev.ref.attempt ?? 1)), demo: 'yes' }, label: STEP_META[ev.ref.key as WKind].label };
  // A sample lead can't be booked in the real calendar: the demo call runs with live booking off.
  return { agent: 'outbound', vars: { ...strategyCallVars(rt, inp, ev.ref.key as 'confirm', ev.at), live_booking: 'no', lead_token: '', demo: 'yes' }, label: CALL_LABEL[ev.ref.key] };
}

/** Subjects for the timeline rows (each email's real subject line). */
async function withSubjects(rt: Runtime, inp: SbInput, sim: SimResult) {
  const { buildEmail } = await import('../integrations/email');
  const cache = new Map<string, string>();
  for (const e of sim.events) {
    if (e.ch !== 'email') continue;
    try {
      if (e.ref.kind === 'seq') {
        const k = `${e.ref.key}:${e.at >= (strategyTimes(inp).bookAt ?? Infinity) ? 'b' : 'a'}`;
        if (!cache.has(k)) cache.set(k, (await buildEmail(rt, strategyLeadAt(inp, e.at), 'sandbox', e.ref.key, 'sandbox')).subject);
        e.sub = cache.get(k);
      } else {
        const m = liveMailFor(rt, inp, e);
        if (m) e.sub = m.subject;
      }
    } catch { /* keep the title */ }
  }
  return sim;
}

// ───────────── API (admin only, read-only: GET, so even the HQ cache generation is untouched) ─────────────

const parseQ = (q: string | undefined) => { try { return JSON.parse(q ?? '{}') as unknown; } catch { return {}; } };

export const sandboxApi = new Hono<AppEnv>();
sandboxApi.get('/options', (c) => c.json({
  countries: Object.entries(COUNTRIES).map(([id, v]) => ({ id, label: v.label, phone: v.phone, zones: v.zones, called: Boolean(callingZones(v.phone)) })),
  revenues: REVENUES.map((r) => ({ id: r, label: REVENUE_LABEL[APP_REVENUE_BAND[r] ?? ''] ?? r })),
  applyTimes: Object.entries(APPLY_TIMES).map(([id, label]) => ({ id, label })),
  pains: PAIN_POINTS.map((id) => ({ id, label: RESOURCES[id].pain })),
  defaults: { lead: DEFAULT_LEAD, choices: DEFAULT_CHOICES },
}));
sandboxApi.get('/run', async (c) => {
  const rt = readOnlyRuntime(runtimeFrom(c));
  const inp = cleanInput(parseQ(c.req.query('q')));
  const sim = await withSubjects(rt, inp, simulate(rt, inp));
  c.header('cache-control', 'no-store');
  return c.json({ ok: true, input: inp, sim });
});
sandboxApi.get('/detail', async (c) => {
  const inp = cleanInput(parseQ(c.req.query('q')));
  const d = await detail(runtimeFrom(c), inp, String(c.req.query('id') ?? '').slice(0, 80));
  c.header('cache-control', 'no-store');
  return d ? c.json({ ok: true, detail: d }) : c.json({ ok: false, error: 'That step isn’t in this simulation any more. Run it again.' }, 404);
});

// ───────────── the page ─────────────

/** Its own CSP: our script and styles only; email previews are sandboxed srcdoc frames (no scripts, no navigation). */
export const SANDBOX_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; frame-src 'self' about:; child-src 'self' about:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function sandboxPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Sandbox · Funnel HQ</title><meta name="robots" content="noindex"><meta name="color-scheme" content="light">
<link rel="stylesheet" href="/assets/glass.css"><link rel="stylesheet" href="/assets/sandbox.css"></head>
<body class="sb"><div class="sb-app" data-app>
<header class="sb-top">
  <a class="sb-back" href="/admin">Funnel HQ</a>
  <p class="sb-badge" role="note"><span class="sb-dot" aria-hidden="true"></span>Simulation: nothing is sent</p>
</header>
<main class="sb-main" data-main><p class="sb-loading">Loading the sandbox…</p></main>
</div><div class="sb-sheet-scrim" data-scrim hidden></div><aside class="sb-sheet" data-sheet hidden aria-modal="true" role="dialog" aria-labelledby="sb-sheet-h"></aside>
<script src="/assets/sandbox.js"></script></body></html>`;
}
