import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/app';
import { auditCopy } from '../src/content/copy-rules';
import { getLead } from '../src/funnel/leads';
import { ONE_TAP_COPY, applicationAnswer, bookingMethodStats, dayViews, embedPrefill, oneTapConfirm, oneTapOn, oneTapTimes, sampleTimes, spread } from '../src/funnel/one-tap';
import { bookingMethodOf, handleCalendly } from '../src/integrations/booking';
import { SETTINGS as SETTING_DEFS } from '../src/settings';

// One-tap booking on /book (src/funnel/one-tap.ts) against a fake Calendly, on a real SQLite database shaped like D1
// with every migration applied.

interface Stmt { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } }
interface DatabaseSync { prepare(sql: string): Stmt; exec(sql: string): void }
const node = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown; cwd(): string } }).process;
const { DatabaseSync } = node.getBuiltinModule('node:sqlite') as { DatabaseSync: new (path: string) => DatabaseSync };
const fs = node.getBuiltinModule('node:fs') as { readdirSync(p: string): string[]; readFileSync(p: string, enc: string): string };

function d1(db: DatabaseSync) {
  const prepare = (sql: string) => {
    let args: unknown[] = [];
    const norm = () => args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? Number(a) : a)) as (string | number | null)[];
    const st = {
      sql,
      bind: (...a: unknown[]) => { args = a; return st; },
      first: async <T>() => (db.prepare(sql).get(...norm()) as T | undefined) ?? null,
      all: async <T>() => ({ results: db.prepare(sql).all(...norm()) as T[] }),
      run: async () => { const r = db.prepare(sql).run(...norm()); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
    };
    return st;
  };
  return { prepare, batch: async (stmts: { sql: string; run: () => Promise<unknown>; all: () => Promise<unknown> }[]) => { const out = []; for (const s of stmts) out.push(/^\s*select|\breturning\b/i.test(s.sql) ? await s.all() : await s.run()); return out; } };
}
function freshDb() {
  const db = new DatabaseSync(':memory:');
  const dir = `${node.cwd()}/migrations`;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(`${dir}/${f}`, 'utf8'));
  return db;
}

// Tuesday 3 November 2026, 1 pm in Sydney.
const T0 = Date.parse('2026-11-03T02:00:00Z');
const CAL_URL = 'https://calendly.com/acquisitions-advisory-joshli/m-a-private-advisory';
const SETTINGS: Record<string, string> = {
  CALENDLY_API_TOKEN: 'cal_test_token_123456', SALES_TIMEZONE: 'Australia/Sydney', BOOKING_URL_A: CAL_URL, SITE_NAME: 'G&L', EMAIL_SIGNATURE: 'Josh', BUSINESS_ADDRESS: 'Sydney',
};
const REP = { id: 'josh', name: 'Josh Li', email: 'josh@x.com', role: 'closer', tiers: 'A,B', weight: 1, calendar_url: null, booking_setting: 'BOOKING_URL_A', commission_pct: 0, monthly_target: 0, slack_user_id: null, discord_user_id: null, active: 1, created_at: 0 };
let db: DatabaseSync;
let rt: Runtime;
const makeRt = (extra: Record<string, string> = {}) =>
  ({ env: { DB: d1(db), SESSION_SECRET: 'x'.repeat(32) }, settings: { ...Object.fromEntries(SETTING_DEFS.map((d) => [d.key, ''])), ...SETTINGS, ...extra }, reps: [REP], origin: 'https://apply.test', waitUntil: (p: Promise<unknown>) => { void p.catch(() => null); } }) as unknown as Runtime;
const q = <T = Record<string, unknown>>(sql: string, ...a: unknown[]) => db.prepare(sql).all(...(a as (string | number | null)[])) as T[];
const x = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...(a as (string | number | null)[]));

const ANSWERS = { business: 'Commercial HVAC services, 25 staff', role: 'owner', revenue: '3_10m', profit: '250k_1m', goal: 'acquire', timeline: '0_6', why_now: 'A competitor is retiring' };
function seedLead(o: { id?: string; tz?: string | null; tier?: string; booked?: { ref: string; at: number } | null; app?: boolean } = {}) {
  const id = o.id ?? 'l_dana';
  x(`INSERT INTO leads (id, ref_code, created_at, updated_at, first_name, last_name, email, phone, status, tier, app_completed_at, timezone, country, industry, revenue_band, answers, closer_id,
       booked_at, call_at, booking_ref, booking_provider)
     VALUES (?, ?, ?, ?, 'Dana', 'Reid', ?, '+61412345678', ?, ?, ?, ?, 'AU', 'HVAC', '3_10m', ?, 'josh', ?, ?, ?, ?)`,
    id, `R${id.slice(-4).toUpperCase()}`, T0 - 86_400_000, T0, id === 'l_dana' ? 'dana@acme.com' : `${id}@acme.com`, o.booked ? 'booked' : 'applied', o.tier ?? 'A', o.app === false ? null : T0 - 3600_000,
    o.tz === undefined ? 'Australia/Sydney' : o.tz, JSON.stringify(ANSWERS), o.booked ? T0 - 3600_000 : null, o.booked?.at ?? null, o.booked?.ref ?? null, o.booked ? 'calendly' : null);
  return id;
}
const lead = async (id = 'l_dana') => (await getLead(rt.env, id))!;

// ───────────── Calendly, faked ─────────────

const ET = 'https://api.calendly.com/event_types/ET1';
const OLD_EVENT = 'https://api.calendly.com/scheduled_events/OLD1';
const NEW_EVENT = 'https://api.calendly.com/scheduled_events/NEW1';
const NEW_INVITEE = `${NEW_EVENT}/invitees/I1`;
interface Seen { method: string; url: string; body: Record<string, unknown> | null }
let seen: Seen[];
let slots: string[];
let eventType: Record<string, unknown>;
let inviteeStatus: number;
let availStatus: number;
let bookedStart: string;

function calendly() {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    seen.push({ method, url, body });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/users/me')) return json({ resource: { uri: 'https://api.calendly.com/users/U1', name: 'Josh Li', email: 'josh@x.com', current_organization: 'https://api.calendly.com/organizations/O1', scheduling_url: 'https://calendly.com/acquisitions-advisory-joshli', timezone: 'Australia/Sydney' } });
    if (url.includes('/event_types?')) return json({ collection: [eventType] });
    if (url.includes('/event_type_available_times?')) return availStatus === 200 ? json({ collection: slots.map((s) => ({ start_time: s, status: 'available', invitees_remaining: 1 })) }) : json({ message: 'boom' }, availStatus);
    if (url.endsWith('/invitees') && method === 'POST') {
      if (inviteeStatus !== 201) return json({ title: 'Invalid Argument', message: inviteeStatus === 400 ? 'The selected start_time is no longer available.' : 'Server error' }, inviteeStatus);
      bookedStart = String(body.start_time);
      return json({ resource: { uri: NEW_INVITEE, event: NEW_EVENT, cancel_url: 'https://calendly.com/cancellations/I1', reschedule_url: 'https://calendly.com/reschedulings/I1', status: 'active' } }, 201);
    }
    if (url === NEW_EVENT) return json({ resource: { uri: NEW_EVENT, name: 'M&A Private Advisory - Grøsfjeld & Li', status: 'active', start_time: bookedStart, end_time: bookedStart, location: { type: 'google_conference', join_url: 'https://meet.google.com/abc-defg-hij' }, event_memberships: [{ user_email: 'josh@x.com' }] } });
    if (url.startsWith(`${NEW_EVENT}/invitees`)) return json({ collection: [{ uri: NEW_INVITEE, email: 'dana@acme.com', name: 'Dana Reid', status: 'active', cancel_url: 'https://calendly.com/cancellations/I1', reschedule_url: 'https://calendly.com/reschedulings/I1', tracking: { salesforce_uuid: 'l_dana', utm_source: 'funnel', utm_medium: 'one_tap' }, questions_and_answers: [] }] });
    if (url.includes('/cancellation') && method === 'POST') return json({ resource: { canceled_by: 'Josh Li', reason: body?.reason } }, 201);
    return json({ message: `unexpected ${method} ${url}` }, 500);
  });
}
const calendlyCalls = () => seen.filter((s) => s.url.startsWith('https://api.calendly.com'));
const posts = () => seen.filter((s) => s.method === 'POST' && s.url.endsWith('/invitees'));

// Open times (UTC). In Sydney (UTC+11): Tue 3 Nov 2 pm (inside two hours), Wed 4 Nov 9, 9:30, 10, 11 am, 1 pm, 3:30 pm,
// Thu 5 Nov 10:30 am, Fri 6 Nov 9 am and 2 pm, Sat 7 Nov 10 am, Mon 9 Nov 4 pm.
const OPEN = [
  '2026-11-03T03:00:00Z',
  '2026-11-03T22:00:00Z', '2026-11-03T22:30:00Z', '2026-11-03T23:00:00Z', '2026-11-04T00:00:00Z', '2026-11-04T02:00:00Z', '2026-11-04T04:30:00Z',
  '2026-11-04T23:30:00Z',
  '2026-11-05T22:00:00Z', '2026-11-06T03:00:00Z',
  '2026-11-06T23:00:00Z',
  '2026-11-09T05:00:00Z',
];
const THU_1030 = '2026-11-04T23:30:00.000Z';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  db = freshDb();
  rt = makeRt();
  seen = [];
  slots = [...OPEN];
  eventType = { uri: ET, name: 'M&A Private Advisory - Grøsfjeld & Li', active: true, kind: 'solo', duration: 30, scheduling_url: CAL_URL, locations: [{ kind: 'google_conference' }], custom_questions: [] };
  inviteeStatus = 201;
  availStatus = 200;
  bookedStart = THU_1030;
  vi.stubGlobal('fetch', calendly());
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

type Day = { date: string; label: string; weekend: boolean; times: { id: string; label: string }[]; all: { id: string; label: string }[] };

// ───────────── the times ─────────────

describe('open times on /book', () => {
  it('the next three working days, up to four times each, in the lead’s own time zone, with the closer’s first name', async () => {
    seedLead();
    const r = await oneTapTimes(rt, await lead(), {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, tz: 'Australia/Sydney', tzLabel: 'Sydney time', closer: 'Josh' });
    const days = r.body.days as Day[];
    expect(days.map((d) => d.label)).toEqual(['Wednesday 4 November', 'Thursday 5 November', 'Friday 6 November']);
    expect(days[0].times.map((t) => t.label)).toEqual(['9:00 am', '10:00 am', '11:00 am', '3:30 pm']); // spread across the day
    expect(days[1].times).toEqual([{ id: THU_1030, label: '10:30 am' }]);
    // Nothing inside two hours; the weekend and Monday only under "More times".
    const week = r.body.week as Day[];
    expect(week.map((d) => d.date)).toEqual(['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-09']);
    expect(week[3].weekend).toBe(true);
    expect(week[0].all).toHaveLength(6);
    expect(JSON.stringify(r.body)).not.toContain('2026-11-03T03:00');
    // One availability call, for this event type, over the next 7 days.
    const avail = calendlyCalls().filter((c) => c.url.includes('/event_type_available_times?'));
    expect(avail).toHaveLength(1);
    expect(new URL(avail[0].url).searchParams.get('event_type')).toBe(ET);
  });

  it('a lead in New York sees New York times', async () => {
    seedLead({ tz: 'America/New_York' });
    const r = await oneTapTimes(rt, await lead(), { tz: 'Australia/Sydney' }); // the record wins over the browser
    expect(r.body.tzLabel).toBe('New York time');
    const days = r.body.days as Day[];
    expect(days[0].label).toBe('Tuesday 3 November');
    expect(days[0].times[0].label).toBe('5:00 pm'); // 22:00 UTC = 5 pm EST
  });

  it('no time zone on file: the browser’s is used and saved on the lead', async () => {
    seedLead({ tz: null });
    const r = await oneTapTimes(rt, await lead(), { tz: 'Europe/London' });
    expect(r.body.tzLabel).toBe('London time');
    expect((await lead()).timezone).toBe('Europe/London');
    const bad = await oneTapTimes(rt, { ...(await lead()), timezone: null }, { tz: 'Not/A_Zone<script>' });
    expect(bad.body.ok).toBe(true);
  });

  it('cached for 60 seconds per event type', async () => {
    seedLead();
    await oneTapTimes(rt, await lead(), {});
    await oneTapTimes(rt, await lead(), {});
    expect(calendlyCalls().filter((c) => c.url.includes('available_times'))).toHaveLength(1);
    vi.setSystemTime(T0 + 61_000);
    await oneTapTimes(rt, await lead(), {});
    expect(calendlyCalls().filter((c) => c.url.includes('available_times'))).toHaveLength(2);
  });

  it('a Calendly error, or a calendar that isn’t an event type of the connected account → the embed, prefilled', async () => {
    seedLead();
    availStatus = 500;
    const r = await oneTapTimes(rt, await lead(), {});
    expect(r.body).toMatchObject({ ok: false, fallback: true, message: '', prefill: {} }); // the calendar just takes over, no alarm
    eventType = { ...eventType, scheduling_url: 'https://calendly.com/someone-else/intro' };
    x("DELETE FROM kv_state WHERE key = 'calendly:event_types'");
    const r2 = await oneTapTimes(rt, await lead(), {});
    expect(r2.body.fallback).toBe(true);
    expect(q("SELECT json_extract(props, '$.why') AS why FROM events WHERE name = 'one_tap_fallback'").map((e) => e.why)).toEqual([expect.stringMatching(/Calendly 500/), expect.stringMatching(/not an event type/)]);
  });

  it('off with BOOK_ONE_TAP=false, or without the Calendly token', () => {
    expect(oneTapOn({ CALENDLY_API_TOKEN: 'x', BOOK_ONE_TAP: '' })).toBe(true);
    expect(oneTapOn({ CALENDLY_API_TOKEN: 'x', BOOK_ONE_TAP: 'false' })).toBe(false);
    expect(oneTapOn({ CALENDLY_API_TOKEN: '', BOOK_ONE_TAP: 'true' })).toBe(false);
  });

  it('spreads and groups', () => {
    expect(spread([1, 2, 3, 4, 5, 6, 7], 4)).toEqual([1, 3, 5, 7]);
    expect(spread([1, 2], 4)).toEqual([1, 2]);
    expect(dayViews([], 'UTC')).toEqual({ primary: [], week: [] });
    expect((sampleTimes(T0, 'Australia/Sydney', 'Josh Li').days as Day[])).toHaveLength(3);
  });
});

// ───────────── booking ─────────────

describe('one tap → booked', () => {
  it('books the invitee with the application’s details and Google Meet, then marks the lead booked like the webhook does', async () => {
    seedLead();
    const r = await oneTapConfirm(rt, await lead(), { slot: THU_1030 });
    expect(r.body).toMatchObject({ ok: true, result: 'booked', next: '/breakout', when: 'Thursday 5 November, 10:30 am Sydney time' });
    expect(posts()).toHaveLength(1);
    expect(posts()[0].body).toMatchObject({
      event_type: ET,
      start_time: THU_1030,
      invitee: { name: 'Dana Reid', first_name: 'Dana', last_name: 'Reid', email: 'dana@acme.com', timezone: 'Australia/Sydney' },
      location: { kind: 'google_conference' }, // the real event type's location, as the Scheduling API requires
      tracking: { utm_source: 'funnel', utm_medium: 'one_tap', salesforce_uuid: 'l_dana' },
    });
    expect(posts()[0].body).not.toHaveProperty('questions_and_answers'); // the real event type has no custom questions
    const l = await lead();
    expect(l).toMatchObject({ status: 'booked', call_at: Date.parse(THU_1030), booking_ref: NEW_EVENT, booking_provider: 'calendly', booking_join_url: 'https://meet.google.com/abc-defg-hij', booking_host_email: 'josh@x.com' });
    expect(await bookingMethodOf(rt, l)).toBe('one_tap');
    // The same tracking event as every booking (Meta Schedule), once.
    expect(q("SELECT json_extract(props, '$.method') AS m FROM events WHERE name = 'booking_scheduled'")).toEqual([{ m: 'one_tap' }]);
    // The pre-call run and the booked texts start, as with any booking.
    expect(q("SELECT COUNT(*) AS n FROM emails WHERE lead_id = 'l_dana' AND sequence IN ('booked', 'precall')")[0].n).toBeGreaterThan(0);
    // The cache is dropped so the next visitor doesn't see the time just taken.
    expect(q("SELECT key FROM kv_state WHERE key LIKE 'calendly:times:%'")).toEqual([]);
  });

  it('the Calendly webhook that follows is idempotent with it: no second booking event, no second email run, still one tap', async () => {
    seedLead();
    await oneTapConfirm(rt, await lead(), { slot: THU_1030 });
    const before = { emails: q('SELECT COUNT(*) AS n FROM emails')[0].n, sms: q('SELECT COUNT(*) AS n FROM sms_messages')[0].n };
    const res = await handleCalendly(rt, { event: 'invitee.created', payload: { email: 'dana@acme.com', uri: NEW_INVITEE, scheduled_event: { uri: NEW_EVENT, start_time: THU_1030 }, tracking: { salesforce_uuid: 'l_dana' } } });
    expect(res).toMatchObject({ matched: true, leadId: 'l_dana' });
    expect(q("SELECT COUNT(*) AS n FROM events WHERE name = 'booking_scheduled'")[0].n).toBe(1);
    expect(q('SELECT COUNT(*) AS n FROM emails')[0].n).toBe(before.emails);
    expect(q('SELECT COUNT(*) AS n FROM sms_messages')[0].n).toBe(before.sms);
    expect(await bookingMethodOf(rt, await lead())).toBe('one_tap');
    expect(q('SELECT method FROM booking_methods')).toEqual([{ method: 'one_tap' }]);
  });

  it('answers the booking form from the application where questions map (revenue, industry, goal, phone)', async () => {
    seedLead();
    eventType = {
      ...eventType,
      custom_questions: [
        { name: 'What industry are you in?', type: 'string', position: 0, enabled: true, required: true },
        { name: 'Annual revenue', type: 'single_select', position: 1, enabled: true, required: true, answer_choices: ['Under $1M', '$1M – $3M', '$3M – $10M', '$10M+'] },
        { name: 'What is your main goal for the call?', type: 'text', position: 2, enabled: true, required: false },
        { name: 'Phone number', type: 'phone_number', position: 3, enabled: true, required: true },
        { name: 'Anything else we should know?', type: 'text', position: 4, enabled: true, required: true },
      ],
    };
    const r = await oneTapConfirm(rt, await lead(), { slot: THU_1030 });
    expect(r.body.ok).toBe(true);
    expect(posts()[0].body!.questions_and_answers).toEqual([
      { question: 'What industry are you in?', answer: 'HVAC', position: 0 },
      { question: 'Annual revenue', answer: '$3M – $10M', position: 1 },
      { question: 'What is your main goal for the call?', answer: 'Grow by acquiring competitors or add-ons', position: 2 },
      { question: 'Phone number', answer: '+61412345678', position: 3 },
      { question: 'Anything else we should know?', answer: 'In their application (ref RDANA).', position: 4 },
    ]);
    // The embed fallback gets the same answers as a1…a5.
    expect(embedPrefill(eventType as never, await lead())).toMatchObject({ a1: 'HVAC', a2: '$3M – $10M', a4: '+61412345678' });
    expect(applicationAnswer({ name: 'Where are you based?', type: 'string' }, await lead(), null)).toBeNull();
  });

  it('details corrected in the sheet go to Calendly; bad ones are refused field by field', async () => {
    seedLead();
    expect((await oneTapConfirm(rt, await lead(), { slot: THU_1030, email: 'not-an-email' })).body).toMatchObject({ ok: false, field: 'email' });
    expect((await oneTapConfirm(rt, await lead(), { slot: THU_1030, name: '  ' })).body).toMatchObject({ ok: false, field: 'name' });
    expect((await oneTapConfirm(rt, await lead(), { slot: THU_1030, phone: '12' })).body).toMatchObject({ ok: false, field: 'phone' });
    expect(posts()).toHaveLength(0);
    const r = await oneTapConfirm(rt, await lead(), { slot: THU_1030, name: 'Dana Reid-Smith', email: 'Dana@NewCo.com', phone: '0498 765 432' });
    expect(r.body.ok).toBe(true);
    expect(posts()[0].body!.invitee).toMatchObject({ name: 'Dana Reid-Smith', first_name: 'Dana', last_name: 'Reid-Smith', email: 'dana@newco.com' });
    expect(posts()[0].body!.tracking).toMatchObject({ salesforce_uuid: 'l_dana' }); // still matched to this lead by id
  });
});

describe('races and failures', () => {
  it('slot taken between view and tap (no longer open): fresh times and a plain message, nothing booked', async () => {
    seedLead();
    await oneTapTimes(rt, await lead(), {});
    slots = OPEN.filter((s) => !s.startsWith('2026-11-04T23:30'));
    const r = await oneTapConfirm(rt, await lead(), { slot: THU_1030 });
    expect(r.body).toMatchObject({ ok: false, result: 'slot_taken', message: ONE_TAP_COPY.slotTaken });
    expect(JSON.stringify(r.body.week)).not.toContain(THU_1030);
    expect((r.body.days as Day[]).map((d) => d.label)).toEqual(['Wednesday 4 November', 'Friday 6 November', 'Monday 9 November']);
    expect(posts()).toHaveLength(0);
    expect((await lead()).booked_at).toBeNull();
  });

  it('slot taken at the last moment (Calendly refuses the booking): fresh times without it', async () => {
    seedLead();
    inviteeStatus = 400;
    const r = await oneTapConfirm(rt, await lead(), { slot: THU_1030 });
    expect(r.body.result).toBe('slot_taken');
    expect(JSON.stringify(r.body.week)).not.toContain(THU_1030);
    expect((await lead()).booked_at).toBeNull();
  });

  it('a Calendly API error falls back to the prefilled embed, and nothing is marked booked', async () => {
    seedLead();
    inviteeStatus = 500;
    const r = await oneTapConfirm(rt, await lead(), { slot: THU_1030 });
    expect(r.body).toMatchObject({ ok: false, fallback: true, message: ONE_TAP_COPY.fallback });
    expect((await lead()).booked_at).toBeNull();
    expect(q('SELECT COUNT(*) AS n FROM booking_methods')[0].n).toBe(0);
  });

  it('a form-blocked event type (a required choice the application can’t answer) → the embed, no booking attempted', async () => {
    seedLead();
    eventType = { ...eventType, custom_questions: [{ name: 'How did you hear about us?', type: 'single_select', position: 0, enabled: true, required: true, answer_choices: ['Podcast', 'YouTube', 'A friend'] }] };
    const t = await oneTapTimes(rt, await lead(), {});
    expect(t.body).toMatchObject({ fallback: true });
    const r = await oneTapConfirm(rt, await lead(), { slot: THU_1030 });
    expect(r.body).toMatchObject({ fallback: true });
    expect(posts()).toHaveLength(0);
  });

  it('never double-books: an active booking is kept unless they came to reschedule; one booking at a time', async () => {
    seedLead({ booked: { ref: OLD_EVENT, at: T0 + 3 * 86_400_000 } });
    const r = await oneTapConfirm(rt, await lead(), { slot: THU_1030 });
    expect(r.body).toMatchObject({ ok: false, result: 'already_booked', next: '/breakout' });
    expect(posts()).toHaveLength(0);
    // A booking already going through (the shared lock with Sam's phone tools).
    x("INSERT INTO kv_state (key, value) VALUES ('caltool-lock:l_dana', json_object('n', 1, 't', ?))", T0);
    expect((await oneTapConfirm(rt, await lead(), { slot: THU_1030, reschedule: true })).status).toBe(409);
    expect(posts()).toHaveLength(0);
    x("DELETE FROM kv_state WHERE key = 'caltool-lock:l_dana'");
    // Reschedule: the new time first, then the old event cancelled.
    const moved = await oneTapConfirm(rt, await lead(), { slot: THU_1030, reschedule: true });
    expect(moved.body).toMatchObject({ ok: true, result: 'rescheduled' });
    expect(seen.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual(['https://api.calendly.com/invitees', 'https://api.calendly.com/scheduled_events/OLD1/cancellation']);
    expect((await lead()).booking_ref).toBe(NEW_EVENT);
  });

  it('rate-limited per lead (6 booking attempts an hour, 30 look-ups)', async () => {
    seedLead();
    for (let i = 0; i < 6; i++) expect((await oneTapConfirm(rt, await lead(), { slot: 'nope' })).status).toBe(200);
    const r = await oneTapConfirm(rt, await lead(), { slot: THU_1030 });
    expect(r.status).toBe(429);
    expect(r.body.fallback).toBe(true);
    expect(posts()).toHaveLength(0);
  });

  it('every message passes the copy rules and never calls the call free', () => {
    for (const m of Object.values(ONE_TAP_COPY)) {
      expect(auditCopy(m)).toEqual([]);
      expect(m).not.toMatch(/\bfree\b/i);
    }
    const page = fs.readFileSync(`${node.cwd()}/public/book.html`, 'utf8').replace(/<[^>]+>/g, ' ');
    expect(page).not.toMatch(/\bfree\b/i);
  });
});

describe('email and text links land on the one-tap page', () => {
  it('“pick a time” in reactivation emails: qualified applicants → /book, imported contacts → the calendar', async () => {
    const { TEMPLATES } = await import('../src/integrations/templates');
    const ctx = (l: Record<string, unknown>) => ({ lead: l as never, name: 'Dana', siteName: 'G&L', link: (p: string) => `[${p}]`, bookingUrl: CAL_URL, whatsappUrl: null, callTime: null });
    expect(TEMPLATES.re_2(ctx({ app_completed_at: T0, tier: 'A' })).cta!.href).toBe('[/book]');
    expect(TEMPLATES.re_2(ctx({ app_completed_at: T0, tier: 'C', tier_override: 'B' })).cta!.href).toBe('[/book]');
    expect(TEMPLATES.re_2(ctx({ app_completed_at: null, tier: 'A', booking_source: 'calendly-direct' })).cta!.href).toBe(`[${CAL_URL}]`);
    // The booking-link emails and texts for applied-not-booked leads already point at /book (signed /r/ and /s/ links link the browser).
    expect(TEMPLATES.t_still_thinking(ctx({ app_completed_at: T0, tier: 'A' })).cta!.href).toBe('[/book]');
  });
});

describe('Funnel HQ: one tap against the embed', () => {
  it('counts /book viewers by what they saw, and bookings by how they were made', async () => {
    seedLead();
    seedLead({ id: 'l_two' });
    x("INSERT INTO events (id, ts, name, lead_id, path, source, is_bot, props) VALUES ('e1', ?, 'page_view', 'l_dana', '/book', 'server', 0, '{\"booking_mode\":\"one_tap\"}')", T0);
    x("INSERT INTO events (id, ts, name, lead_id, path, source, is_bot, props) VALUES ('e2', ?, 'page_view', 'l_two', '/book', 'server', 0, '{\"booking_mode\":\"embed\"}')", T0);
    await oneTapConfirm(rt, await lead(), { slot: THU_1030 });
    const s = await bookingMethodStats(rt.env, T0 - 86_400_000, T0 + 86_400_000);
    expect(s.pages).toEqual([
      { mode: 'one_tap', viewers: 1, booked: 1, rate: 1, by: { one_tap: 1, embed: 0, phone: 0 } },
      { mode: 'embed', viewers: 1, booked: 0, rate: 0, by: { one_tap: 0, embed: 0, phone: 0 } },
    ]);
    expect(s.booked).toEqual({ one_tap: 1 });
  });
});

// ───────────── over HTTP: who may book ─────────────

describe('the endpoints: only the lead themselves', () => {
  type App = { fetch: (r: Request, e: unknown, c: unknown) => Promise<Response> };
  let app: App;
  const ORIGIN = 'https://apply.test';
  const BOOK_HTML = '<!doctype html><html><head><title>Book</title></head><body><div data-calendar></div></body></html>';
  beforeAll(async () => {
    vi.stubGlobal('HTMLRewriter', class { on() { return this; } transform(r: Response) { return r; } });
    app = (await import('../src/index')).default as unknown as App;
  }, 60_000);
  beforeEach(async () => {
    vi.stubGlobal('HTMLRewriter', class { on() { return this; } transform(r: Response) { return r; } });
    (await import('../src/settings')).resetSettingsCache();
    (await import('../src/sales/reps')).clearRepCache();
  });
  const env = (extra: Record<string, string> = {}) => ({
    DB: d1(db), SESSION_SECRET: 'x'.repeat(32), ADMIN_PASSWORD: 'devpass-owner-only', ...SETTINGS, ...extra,
    ASSETS: { fetch: async () => new Response(BOOK_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } }) },
  });
  const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const call = (path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown; ip?: string; env?: Record<string, string> } = {}) =>
    app.fetch(new Request(`${ORIGIN}${path}`, {
      method: init.method ?? 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': UA, 'accept-language': 'en-AU', 'cf-connecting-ip': init.ip ?? '203.0.113.9', ...init.headers },
      body: init.method === 'GET' ? undefined : JSON.stringify(init.body ?? {}),
    }), env(init.env), { waitUntil: () => {}, passThroughOnException: () => {} });
  const same = { origin: ORIGIN, 'sec-fetch-site': 'same-origin' };
  const linkBrowser = (leadId: string, vid = 'v0123456789abcdef') => {
    x('INSERT INTO visitors (id, created_at, last_seen_at, lead_id) VALUES (?, ?, ?, ?)', vid, T0, T0, leadId);
    return `_fv=${vid}`;
  };

  it('no linked lead, a C-tier lead, an unfinished application or a cross-site request → refused, Calendly untouched', async () => {
    seedLead();
    seedLead({ id: 'l_ctier', tier: 'C' });
    seedLead({ id: 'l_partial', app: false });
    expect((await call('/api/book/times', { headers: same })).status).toBe(403);
    expect((await call('/api/book/confirm', { headers: same, body: { slot: THU_1030 } })).status).toBe(403);
    expect((await call('/api/book/confirm', { headers: { ...same, cookie: linkBrowser('l_ctier', 'v0000000000ctier') }, body: { slot: THU_1030 } })).status).toBe(403);
    expect((await call('/api/book/confirm', { headers: { ...same, cookie: linkBrowser('l_partial', 'v00000000partial') }, body: { slot: THU_1030 } })).status).toBe(403);
    const dana = linkBrowser('l_dana');
    expect((await call('/api/book/confirm', { headers: { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site', cookie: dana }, body: { slot: THU_1030 } })).status).toBe(403);
    expect((await call('/api/book/confirm', { headers: { cookie: dana }, body: { slot: THU_1030 } })).status).toBe(403); // neither Origin nor Sec-Fetch-Site
    expect(calendlyCalls()).toEqual([]);
    expect((await getLead(rt.env, 'l_dana'))!.booked_at).toBeNull();
  });

  it('the lead’s own browser books end to end; the lead id in the body is ignored', async () => {
    seedLead();
    seedLead({ id: 'l_other' });
    const dana = linkBrowser('l_dana');
    const t = await call('/api/book/times', { headers: { ...same, cookie: dana }, body: { tz: 'Australia/Sydney' } });
    expect(t.status).toBe(200);
    expect(((await t.json()) as { days: Day[] }).days).toHaveLength(3);
    const r = await call('/api/book/confirm', { headers: { ...same, cookie: dana }, body: { slot: THU_1030, lead_id: 'l_other' } });
    expect(await r.json()).toMatchObject({ ok: true, next: '/breakout' });
    expect((await getLead(rt.env, 'l_dana'))!.status).toBe('booked');
    expect((await getLead(rt.env, 'l_other'))!.booked_at).toBeNull();
  });

  it('rate-limited per connection', async () => {
    seedLead();
    const dana = linkBrowser('l_dana');
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await call('/api/book/confirm', { headers: { ...same, cookie: dana }, body: { slot: 'x' }, ip: '198.51.100.77' })).status;
    expect(last).toBe(429);
  });

  it('/book records which version it showed (for the comparison), and BOOK_ONE_TAP=false shows only the embed', async () => {
    seedLead();
    const dana = linkBrowser('l_dana');
    expect((await call('/book', { method: 'GET', headers: { cookie: dana } })).status).toBe(200);
    expect((await call('/book', { method: 'GET', headers: { cookie: dana }, env: { BOOK_ONE_TAP: 'false' } })).status).toBe(200);
    expect(q("SELECT json_extract(props, '$.booking_mode') AS m FROM events WHERE name = 'page_view' AND path = '/book' ORDER BY ts, rowid").map((r) => r.m)).toEqual(['one_tap', 'embed']);
    // Off: the endpoints fall back too.
    const r = await call('/api/book/times', { headers: { ...same, cookie: dana }, env: { BOOK_ONE_TAP: 'false' } });
    expect(await r.json()).toMatchObject({ fallback: true });
  });

  it('Funnel HQ: a guest can read the comparison but can’t turn one-tap off', async () => {
    const form = await app.fetch(new Request(`${ORIGIN}/admin/login`, { method: 'POST', headers: { ...same, 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': '198.51.100.1' }, body: 'password=devpass-owner-only' }), env(), { waitUntil: () => {}, passThroughOnException: () => {} });
    const owner = (form.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).find((c) => c.startsWith('_fa=') && c.length > 4)!;
    expect(owner).toBeTruthy();
    const inv = await call('/admin/api/guest-access', { headers: { ...same, cookie: owner }, body: { label: 'Accountant', days: 7 } });
    const { url } = (await inv.json()) as { url: string };
    const open = await call(new URL(url).pathname, { method: 'GET', headers: { 'sec-fetch-site': 'cross-site' } });
    const guest = (open.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).find((c) => c.startsWith('_fg=') && c.length > 4)!;
    expect(guest).toBeTruthy();
    const ov = await call('/admin/api/overview', { method: 'GET', headers: { ...same, cookie: guest } });
    expect(ov.status).toBe(200);
    expect(await ov.json()).toHaveProperty('booking_methods');
    const put = await app.fetch(new Request(`${ORIGIN}/admin/api/integrations`, { method: 'PUT', headers: { ...same, 'content-type': 'application/json', cookie: guest, 'cf-connecting-ip': '203.0.113.9' }, body: JSON.stringify({ BOOK_ONE_TAP: 'false' }) }), env(), { waitUntil: () => {}, passThroughOnException: () => {} });
    expect(put.status).toBe(403);
    expect(q("SELECT value FROM settings WHERE key = 'BOOK_ONE_TAP'")).toEqual([]);
  });
});
