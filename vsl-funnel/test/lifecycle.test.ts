import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/app';
import type { VisitorCtx } from '../src/lib/identity';
import { auditCopy, auditEmail, auditFields } from '../src/content/copy-rules';
import { buildIcs, fold, googleUrl, icsProblems, localStamp, outlookUrl, transitions, tzOffsetMin, vtimezone } from '../src/live/calendar';
import {
  DEFAULT_CADENCE, DEFAULT_SLIDES, LC_COPY, LC_ROOM_COPY, REMINDER_COPY, SUBJECT_B, callSlot, cameBackVia, dueReminders, duePost, inQuiet, parseCadence, parseQuiet, parseSlides,
  postEmail, postPath, referralVerdict, showUpFunnel, textAllowed,
} from '../src/live/lifecycle';
import { calendarFor, lcEvent, lifecycleReport, preShowContext, rewardReferrals, saveLcEvent, saveQuestion, saveWorksheet, sendPost, smsOptIn, touch } from '../src/live/lifecycle-db';
import { type LiveEvent, type LiveReg, getEvent, liveEmail, liveText, processLiveMessages, registerLive, saveEvent, sendDueMessages } from '../src/live/events';
import { cleanPlace, inEarlyWindow, lcApply } from '../src/rooms/lifecycle';
import { type Identity, apply, join, newRoomState } from '../src/rooms/state';
import { DEFAULT_RULES } from '../src/rooms/engage';
import { memberId } from '../src/rooms/rooms';
import { getLead } from '../src/funnel/leads';

// ───────────── a real SQLite database shaped like D1, with every migration applied ─────────────

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
  return { prepare, batch: async (stmts: { sql: string; run: () => Promise<unknown>; all: () => Promise<unknown> }[]) => { const out = []; for (const s of stmts) out.push(/^\s*select/i.test(s.sql) ? await s.all() : await s.run()); return out; } };
}
function freshDb() {
  const db = new DatabaseSync(':memory:');
  const dir = `${node.cwd()}/migrations`;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(`${dir}/${f}`, 'utf8'));
  return db;
}

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
/** The session: Tuesday 10 November 2026, 15:00 in New York (20:00 UTC). */
const START = Date.parse('2026-11-10T20:00:00Z');
const pending: Promise<unknown>[] = [];
const flush = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
let db: DatabaseSync;
let rt: Runtime;
const SETTINGS: Record<string, string> = { SALES_TIMEZONE: 'America/New_York', SITE_NAME: 'G&L', SESSION_SECRET: 'x' };
const makeRt = (s: Record<string, string> = SETTINGS) => ({ env: { DB: d1(db), SESSION_SECRET: 'test-session-secret' }, settings: { ...s }, reps: [], origin: 'https://apply.test', waitUntil: (p: Promise<unknown>) => { pending.push(p.catch(() => null)); } }) as unknown as Runtime;
const q = <T = Record<string, unknown>>(sql: string, ...a: unknown[]) => db.prepare(sql).all(...(a as (string | number | null)[])) as T[];
const x = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...(a as (string | number | null)[]));
const visitor = (o: Partial<VisitorCtx> = {}): VisitorCtx => ({
  visitorId: 'v1', sessionId: 's1', leadId: null, isNewVisitor: true, isNewSession: true, isBot: false, botReason: null, variant: 'a',
  ua: { device: 'mobile', browser: 'x', os: 'y' } as never, userAgent: 'test', geo: { country: 'US', city: null, timezone: 'America/Los_Angeles' } as never, ip: '1.1.1.1', touch: null, fbp: null, fbc: null, marketingConsent: false, consentRequired: false, ...o,
});
const at = (t: number) => vi.setSystemTime(t);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at(START - 3 * DAY);
  db = freshDb();
  rt = makeRt();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); pending.length = 0; });

async function newEvent(o: { platform?: 'zoom' | 'room'; tz?: string } = {}) {
  const r = await saveEvent(rt, { title: 'Buy your first competitor', starts_at: START, tz: o.tz ?? 'America/New_York', duration_min: 120, join_url: 'https://zoom.us/j/123', platform: o.platform ?? 'zoom' });
  if (!r.ok) throw new Error(r.error);
  return r.id;
}
async function register(eventId: string, o: { email?: string; v?: Partial<VisitorCtx>; body?: Record<string, unknown> } = {}) {
  const r = await registerLive(rt, visitor(o.v), { first_name: 'Dana', email: o.email ?? 'dana@example.com', revenue: '3_10m', event_id: eventId, ...o.body });
  await flush();
  return r.reg;
}
const ev = async (id: string) => (await getEvent(rt, id))!;

// ───────────── calendar files ─────────────

describe('calendar (.ics)', () => {
  it('writes a VTIMEZONE with the real daylight-saving changes and local DTSTART/DTEND in the event zone', () => {
    const ny = transitions('America/New_York', Date.UTC(2026, 0, 1), Date.UTC(2026, 11, 31));
    expect(ny.map((t) => [new Date(t.at).toISOString(), t.from, t.to])).toEqual([['2026-03-08T07:00:00.000Z', -300, -240], ['2026-11-01T06:00:00.000Z', -240, -300]]);
    const tz = vtimezone('America/New_York', START, START).join('\n');
    expect(tz).toContain('BEGIN:DAYLIGHT\nDTSTART:20260308T020000\nTZOFFSETFROM:-0500\nTZOFFSETTO:-0400');
    expect(tz).toContain('BEGIN:STANDARD\nDTSTART:20261101T020000\nTZOFFSETFROM:-0400\nTZOFFSETTO:-0500');
    // Sydney: the southern hemisphere's changes (April back, October forward).
    const syd = vtimezone('Australia/Sydney', START, START).join('\n');
    expect(syd).toContain('BEGIN:STANDARD\nDTSTART:20260405T030000\nTZOFFSETFROM:+1100\nTZOFFSETTO:+1000');
    expect(syd).toContain('BEGIN:DAYLIGHT\nDTSTART:20261004T020000\nTZOFFSETFROM:+1000\nTZOFFSETTO:+1100');
    // No daylight saving: one STANDARD block with the half-hour offset.
    const ind = vtimezone('Asia/Kolkata', START, START).join('\n');
    expect(ind.match(/BEGIN:(STANDARD|DAYLIGHT)/g)).toEqual(['BEGIN:STANDARD']);
    expect(ind).toContain('TZOFFSETTO:+0530');
    expect(tzOffsetMin('Asia/Kolkata', START)).toBe(330);
    const ics = buildIcs([{ uid: 'lr1@live.test', seq: 0, start: START, end: START + 2 * HOUR, tz: 'America/New_York', title: 'Buy your first competitor, with commas; and semicolons', description: `Your personal room link: https://live.test/live/room/${'t'.repeat(40)}?via=cal\nSecond line`, url: 'https://live.test/live/room/tok?via=cal', stamp: START - DAY }]);
    expect(icsProblems(ics)).toEqual([]);
    const un = ics.replace(/\r\n /g, '');
    expect(un).toContain('DTSTART;TZID=America/New_York:20261110T150000');
    expect(un).toContain('DTEND;TZID=America/New_York:20261110T170000');
    expect(un).toContain('SUMMARY:Buy your first competitor\\, with commas\\; and semicolons');
    expect(un).toContain('DESCRIPTION:Your personal room link: https://live.test/live/room/');
    expect(un).toContain('\\nSecond line');
    expect(un).toContain('SEQUENCE:0');
    expect(un).toContain('METHOD:PUBLISH');
    expect(un).toContain('BEGIN:VALARM');
    expect(ics.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    // Folding never splits a character.
    expect(fold('X'.repeat(74) + '’’’').split('\r\n ')[0]).toBe('X'.repeat(74));
    expect(localStamp('Australia/Sydney', Date.parse('2026-11-12T08:00:00Z'))).toBe('20261112T190000');
  });

  it('Google and Outlook links carry the UTC times and the personal link', () => {
    const e = { start: START, end: START + 2 * HOUR, tz: 'America/New_York', title: 'Live', description: 'Room', url: 'https://live.test/live/room/tok?via=cal' };
    const g = new URL(googleUrl(e));
    expect(g.searchParams.get('dates')).toBe('20261110T200000Z/20261110T220000Z');
    expect(g.searchParams.get('ctz')).toBe('America/New_York');
    expect(g.searchParams.get('location')).toBe(e.url);
    const o = new URL(outlookUrl(e));
    expect(o.searchParams.get('startdt')).toBe('2026-11-10T20:00:00Z');
    expect(o.searchParams.get('rru')).toBe('addevent');
  });

  it('a reschedule bumps SEQUENCE, keeps the UID, sends the new time under a new reminder version; a cancel sends METHOD:CANCEL', async () => {
    const id = await newEvent();
    const reg = await register(id);
    const ics0 = (await calendarFor(rt, await ev(id), reg, 'ics'))!;
    const uid = /UID:(.+)/.exec((ics0 as { ics: string }).ics)![1];
    expect((ics0 as { ics: string }).ics).toContain('SEQUENCE:0');
    expect(q("SELECT cal_kind FROM lc_regs WHERE reg_id = ?", reg.id)[0]).toEqual({ cal_kind: 'ics' });
    // Move it a day later.
    const moved = await saveEvent(rt, { starts_at: '2026-11-11T15:00' }, id);
    expect(moved.ok).toBe(true);
    await flush();
    const lc = await lcEvent(rt, id, true);
    expect([lc.ics_seq, lc.rv]).toEqual([1, 1]);
    const ics1 = ((await calendarFor(rt, await ev(id), reg, 'apple')) as { ics: string; inline: boolean });
    expect(ics1.inline).toBe(true);
    expect(ics1.ics).toContain(`UID:${uid}`);
    expect(ics1.ics).toContain('SEQUENCE:1');
    expect(ics1.ics).toContain('DTSTART;TZID=America/New_York:20261111T150000');
    const mails = q<{ sequence: string; template: string; subject: string }>("SELECT sequence, template, subject FROM emails WHERE lead_id = ? ORDER BY created_at", reg.lead_id);
    expect(mails.map((m) => [m.sequence, m.template])).toEqual([['live', 'live_confirm'], ['live.v1', 'live_confirm']]);
    expect(mails[1].subject).toBe('New time: Buy your first competitor');
    // A title change bumps the calendar version only (no reminder re-run).
    await saveEvent(rt, { title: 'Buy your first competitor, live' }, id);
    expect([(await lcEvent(rt, id, true)).ics_seq, (await lcEvent(rt, id, true)).rv]).toEqual([2, 1]);
    // Cancel.
    await saveEvent(rt, { status: 'cancelled' }, id);
    await flush();
    const ics3 = (await calendarFor(rt, await ev(id), reg, 'ics')) as { ics: string };
    expect(ics3.ics).toContain('METHOD:CANCEL');
    expect(ics3.ics).toContain('STATUS:CANCELLED');
    expect(ics3.ics).toContain('SEQUENCE:3');
    expect(ics3.ics).not.toContain('VALARM');
    expect(q("SELECT template FROM emails WHERE sequence = ?", `lc:${id}`)).toEqual([{ template: 'lc_cancelled' }]);
    // The Google link records the calendar add and redirects.
    const id2 = await newEvent();
    const reg2 = await register(id2, { email: 'sam@example.com', v: { visitorId: 'v9', ip: '9.9.9.9' } });
    const g = await calendarFor(rt, await ev(id2), reg2, 'google') as { redirect: string };
    expect(g.redirect).toMatch(/^https:\/\/calendar\.google\.com\//);
    expect(decodeURIComponent(g.redirect)).toContain(`/live/room/${reg2.token}?via=cal`);
  });
});

// ───────────── the reminder schedule ─────────────

describe('reminder schedule per time zone and quiet hours', () => {
  const reg = { created_at: START - 3 * DAY, joined_at: null };
  const quiet = parseQuiet('');
  it('quiet hours parse and apply in the person’s own zone', () => {
    expect(quiet).toEqual({ from: 22, to: 7 });
    expect(parseQuiet('off')).toBeNull();
    expect(parseQuiet('21-8')).toEqual({ from: 21, to: 8 });
    // 20:00 UTC is 15:00 in New York and 07:00 next day in Sydney (summer time).
    expect(inQuiet(START, 'America/New_York', quiet)).toBe(false);
    expect(inQuiet(START - 15 * HOUR, 'America/New_York', quiet)).toBe(true); // 00:00 New York
    expect(inQuiet(START - HOUR, 'Australia/Sydney', quiet)).toBe(true); // 06:00 Sydney
  });
  it('sends each reminder in its window, and waits out quiet hours only for the 24h and 3h emails', () => {
    const due = (t: number, tz = 'America/New_York') => dueReminders(START, reg, { now: t, tz, quiet });
    expect(due(START - DAY + MIN)).toEqual(['r24h']);
    expect(due(START - 3 * HOUR + MIN)).toEqual(['r3h']);
    expect(due(START - HOUR + MIN)).toEqual(['r1h']);
    expect(due(START - 10 * MIN + MIN)).toEqual(['r10m']);
    expect(due(START + MIN)).toEqual(['r10m', 'live']);
    expect(due(START + 6 * MIN)).toEqual(['missing']); // "we're live" gives way: never both on one run
    expect(dueReminders(START, { ...reg, joined_at: START + MIN }, { now: START + 6 * MIN, tz: 'UTC', quiet })).toEqual([]);
    // In Sydney the 24-hour moment is 07:00: fine. For someone in Kolkata (01:30) it waits until 07:00 there.
    expect(due(START - DAY + MIN, 'Australia/Sydney')).toEqual(['r24h']);
    expect(due(START - DAY + MIN, 'Asia/Kolkata')).toEqual([]);
    expect(due(START - DAY + 6 * HOUR, 'Asia/Kolkata')).toEqual(['r24h']); // 07:30 Kolkata, still before the 3-hour mark
    // The 3-hour reminder at 01:30 Kolkata waits, and is dropped once the 1-hour window starts.
    expect(due(START - 3 * HOUR + MIN, 'Asia/Kolkata')).toEqual([]);
    expect(due(START - HOUR + MIN, 'Asia/Kolkata')).toEqual(['r1h']);
    // Registered after a reminder's moment: no catch-up reminder.
    expect(dueReminders(START, { ...reg, created_at: START - 2 * HOUR }, { now: START - HOUR + MIN, tz: 'UTC', quiet })).toEqual(['r1h']);
    expect(dueReminders(START, { ...reg, created_at: START - 2 * HOUR }, { now: START - 2 * HOUR + MIN, tz: 'UTC', quiet })).toEqual([]);
  });
  it('the cadence turns kinds off per channel (the confirmation always goes)', () => {
    const c = parseCadence(JSON.stringify({ email: { r3h: false, confirm: false }, sms: { r3h: false, r24h: true } }));
    expect(c.email.confirm).toBe(true);
    expect(c.email.r3h).toBe(false);
    expect(c.sms.r24h).toBe(true);
    expect(dueReminders(START, reg, { now: START - 3 * HOUR + MIN, tz: 'UTC', quiet: null, cadence: c })).toEqual([]);
    expect(parseCadence('not json')).toEqual(DEFAULT_CADENCE);
  });
  it('the cron sends the 3-hour reminder with calendar links, then "you’re missing it" to people not in the room', async () => {
    const id = await newEvent();
    const reg = await register(id, { body: { tz: 'America/New_York' } });
    at(START - 3 * HOUR + 2 * MIN);
    await processLiveMessages(rt, Date.now());
    at(START + 6 * MIN);
    await processLiveMessages(rt, Date.now());
    await processLiveMessages(rt, Date.now());
    const t = q<{ template: string }>("SELECT template FROM emails WHERE lead_id = ? AND sequence = 'live' ORDER BY step", reg.lead_id).map((r) => r.template);
    expect(t).toEqual(['live_confirm', 'live_r3h', 'live_missing']);
  });
});

// ───────────── one person, one moment, two channels at most ─────────────

describe('cross-channel dedupe with the AI calls', () => {
  it('holds a text back when an AI call is queued within 15 minutes, and the call side skips or moves around a sent text', () => {
    const call = (dt: number, status = 'queued') => ({ run_at: START - 10 * MIN + dt, status, kind: 'w_pre_start' });
    expect(textAllowed(START - 10 * MIN, [call(0)]).ok).toBe(false);
    expect(textAllowed(START - 10 * MIN, [call(14 * MIN)]).ok).toBe(false);
    expect(textAllowed(START - 10 * MIN, [call(20 * MIN)]).ok).toBe(true);
    expect(textAllowed(START - 10 * MIN, [call(0, 'cancelled'), call(0, 'skipped')]).ok).toBe(true);
    expect(textAllowed(START - 10 * MIN, [{ ...call(0), kind: 'test' }]).ok).toBe(true);
    expect(callSlot(START - 10 * MIN, [START - 9 * MIN], true)).toEqual({ runAt: START - 10 * MIN, skip: true });
    expect(callSlot(START - DAY, [START - DAY + 5 * MIN], false)).toEqual({ runAt: START - DAY + 21 * MIN, skip: false });
    expect(callSlot(START - DAY, [START - 2 * DAY], false)).toEqual({ runAt: START - DAY, skip: false });
  });
  it('at ten minutes before: the email goes, the text is held for the queued AI call (recorded as skipped, never retried)', async () => {
    const id = await newEvent();
    const reg = await register(id, { body: { phone: '+12125550100', sms_consent: true, call_consent: true } });
    expect(reg.sms_ok).toBe(1);
    x("INSERT INTO outbound_calls (id, lead_id, kind, status, run_at, attempts, created_at, updated_at, wc_ref) VALUES ('oc1', ?, 'w_pre_start', 'queued', ?, 0, ?, ?, ?)", reg.lead_id, START - 10 * MIN, Date.now(), Date.now(), `live:${reg.id}`);
    at(START - 9 * MIN);
    const lead = (await getLead(rt.env, reg.lead_id))!;
    const e = await ev(id);
    const r = (await rt.env.DB.prepare('SELECT * FROM live_webinar_regs WHERE id = ?').bind(reg.id).first<LiveReg>())!;
    await sendDueMessages(rt, e, r, lead, Date.now());
    await sendDueMessages(rt, e, r, lead, Date.now());
    expect(q("SELECT template, status FROM emails WHERE lead_id = ? AND template = 'live_r10m'", reg.lead_id)).toEqual([{ template: 'live_r10m', status: 'simulated' }]);
    expect(q("SELECT template, status, error FROM sms_messages WHERE lead_id = ? AND template = 'live:r10m'", reg.lead_id)).toEqual([{ template: 'live:r10m', status: 'skipped', error: 'AI call w_pre_start at the same time' }]);
    // Without the call, the text goes (simulated: no provider configured), with the tracked room link.
    x("UPDATE outbound_calls SET status = 'cancelled'");
    at(START + 6 * MIN);
    await sendDueMessages(rt, e, r, lead, Date.now());
    const s = q<{ status: string; link_target: string }>("SELECT status, link_target FROM sms_messages WHERE lead_id = ? AND template = 'live:missing'", reg.lead_id);
    expect(s).toEqual([{ status: 'simulated', link_target: `https://apply.test/live/room/${reg.token}?via=s-missing` }]);
  });
});

// ───────────── the waiting room ─────────────

describe('waiting room timing and "say where you’re from"', () => {
  const host: Identity = { id: 'hadmin', name: 'Josh', role: 'host' };
  const ann: Identity = { id: 'rann', name: 'Ann B.', role: 'attendee', leadId: 'l1', regId: 'r1' };
  const room = () => { const st = newRoomState({ id: 'rmtest12345', mode: 'webinar', title: 'Live', startsAt: START, offerAvailable: false }); join(st, host, START - HOUR); join(st, ann, START - HOUR); return st; };
  it('opens 15 minutes before; early points only inside that window, before Go live, never for staff', () => {
    const st = room();
    expect(inEarlyWindow(st, START - 16 * MIN)).toBe(false);
    expect(inEarlyWindow(st, START - 15 * MIN)).toBe(true);
    expect(apply(st, 'rann', { t: 'lc_early' }, START - 20 * MIN).effects).toEqual([]);
    expect(apply(st, 'rann', { t: 'lc_early' }, START - 5 * MIN).effects).toEqual([{ type: 'award', awards: [{ memberId: 'rann', action: 'early', key: '1' }] }]);
    expect(apply(st, 'hadmin', { t: 'lc_early' }, START - 5 * MIN).effects).toEqual([]);
    expect(apply(st, 'rann', { t: 'lc_early' }, START + MIN).effects).toEqual([]);
    st.status = 'live';
    expect(apply(st, 'rann', { t: 'lc_early' }, START - MIN).effects).toEqual([]);
    expect(DEFAULT_RULES.early).toMatchObject({ points: 10, cap: 1 });
  });
  it('lists real attendees only (first name, one place each, rate limited), and staff can’t post', () => {
    const st = room();
    expect(cleanPlace('Austin, Texas <script>')).toBe('Austin, Texas script');
    expect(cleanPlace('12345')).toBe('');
    const r = apply(st, 'rann', { t: 'lc_from', place: 'Austin, Texas' }, START - 5 * MIN);
    expect(r.ok).toBe(true);
    expect(r.out).toEqual([{ to: 'all', msg: { t: 'lc_from', list: [{ name: 'Ann', place: 'Austin, Texas' }], n: 1 } }]);
    expect(apply(st, 'rann', { t: 'lc_from', place: 'Dallas' }, START - 5 * MIN + 1000).error).toBe('lc_wait');
    apply(st, 'rann', { t: 'lc_from', place: 'Dallas' }, START - 4 * MIN);
    expect(st.lc!.from.map((f) => f.place)).toEqual(['Dallas']);
    expect(apply(st, 'hadmin', { t: 'lc_from', place: 'Sydney' }, START).error).toBe('forbidden');
    expect(apply(st, 'rann', { t: 'lc_from', place: '1' }, START).error).toBe('lc_place');
    st.members.rann.connected = 0;
    expect(apply(st, 'rann', { t: 'lc_from', place: 'Austin' }, START).error).toBe('not_in_room');
    expect(apply(st, 'hadmin', { t: 'lc_from_get' }, START).out[0].msg).toMatchObject({ t: 'lc_from', n: 1 });
    expect(lcApply({ ...st, mode: 'meeting' }, st.members.rann, { t: 'lc_from' }, START).error).toBe('not_applicable');
  });
  it('the host brings a pre-session question into the Q&A once', () => {
    const st = room();
    expect(apply(st, 'rann', { t: 'lc_preq', key: 'lr1', name: 'Dana', text: 'How does seller finance work?' }, START).error).toBe('forbidden');
    expect(apply(st, 'hadmin', { t: 'lc_preq', key: 'lr1', name: 'Dana', text: 'How does seller finance work?' }, START).changed).toBe(true);
    apply(st, 'hadmin', { t: 'lc_preq', key: 'lr1', name: 'Dana', text: 'How does seller finance work?' }, START);
    expect(st.qa.map((x2) => [x2.name, x2.text])).toEqual([['Dana (asked before the session)', 'How does seller finance work?']]);
  });
});

// ───────────── referrals ─────────────

describe('referrals and fraud limits', () => {
  const side = (o: Partial<{ lead_id: string; event_id: string; ip_hash: string | null; visitor_id: string | null; email: string | null }> = {}) => ({ lead_id: 'lA', event_id: 'e1', ip_hash: 'ipA', visitor_id: 'vA', email: 'a@x.com', ...o });
  it('rejects self, same browser, same connection, another event, and over the cap', () => {
    expect(referralVerdict(side(), side({ email: 'b@x.com' }), 0)).toEqual({ status: 'rejected', reason: 'self' });
    expect(referralVerdict(side(), side({ lead_id: 'lB', email: 'A@X.com', ip_hash: 'z', visitor_id: 'z' }), 0)).toEqual({ status: 'rejected', reason: 'self' });
    expect(referralVerdict(side(), side({ lead_id: 'lB', email: 'b@x.com', ip_hash: 'z' }), 0)).toEqual({ status: 'rejected', reason: 'same_browser' });
    expect(referralVerdict(side(), side({ lead_id: 'lB', email: 'b@x.com', visitor_id: 'z' }), 0)).toEqual({ status: 'rejected', reason: 'same_ip' });
    expect(referralVerdict(side(), side({ lead_id: 'lB', email: 'b@x.com', visitor_id: 'z', ip_hash: 'z', event_id: 'e2' }), 0)).toEqual({ status: 'rejected', reason: 'other_event' });
    expect(referralVerdict(side(), side({ lead_id: 'lB', email: 'b@x.com', visitor_id: 'z', ip_hash: 'z' }), 10)).toEqual({ status: 'rejected', reason: 'over_cap' });
    expect(referralVerdict(side(), side({ lead_id: 'lB', email: 'b@x.com', visitor_id: 'z', ip_hash: 'z' }), 9)).toEqual({ status: 'counted' });
  });
  it('counts real referrals, rewards the referrer when the person they brought attends (points and the unlock), once', async () => {
    rt = makeRt({ ...SETTINGS, LC_REFERRAL_CAP: '1' });
    const id = await newEvent({ platform: 'room' });
    const a = await register(id, { email: 'ann@example.com', v: { visitorId: 'vA', ip: '1.1.1.1' } });
    const code = q<{ ref_code: string }>('SELECT ref_code FROM lc_regs WHERE reg_id = ?', a.id)[0].ref_code;
    expect(code).toMatch(/^[a-z2-9]{8}$/);
    const b = await register(id, { email: 'bob@example.com', v: { visitorId: 'vA', ip: '5.5.5.5' }, body: { ref: code } });
    const c = await register(id, { email: 'cat@example.com', v: { visitorId: 'vC', ip: '1.1.1.1' }, body: { ref: code } });
    const d = await register(id, { email: 'dan@example.com', v: { visitorId: 'vD', ip: '2.2.2.2' }, body: { ref: code } });
    const e = await register(id, { email: 'eve@example.com', v: { visitorId: 'vE', ip: '3.3.3.3' }, body: { ref: code } });
    const verdicts = Object.fromEntries(q<{ referred_reg_id: string; status: string; reason: string | null }>('SELECT * FROM lc_referrals').map((r) => [r.referred_reg_id, [r.status, r.reason]]));
    expect(verdicts).toEqual({ [b.id]: ['rejected', 'same_browser'], [c.id]: ['rejected', 'same_ip'], [d.id]: ['counted', null], [e.id]: ['rejected', 'over_cap'] });
    // Nothing until the referred person really attends.
    expect(await rewardReferrals(rt)).toBe(0);
    x('UPDATE live_webinar_regs SET joined_at = ? WHERE id IN (?, ?)', START, d.id, c.id);
    expect(await rewardReferrals(rt)).toBe(1);
    expect(await rewardReferrals(rt)).toBe(0);
    const who = memberId('reg', a.id);
    expect(q("SELECT action, key, points FROM room_points WHERE who = ?", who)).toEqual([{ action: 'referral', key: d.id, points: 25 }]);
    expect(q("SELECT asset FROM room_unlocks WHERE who = ?", who)).toEqual([{ asset: 'scripts' }]);
    const rep = (await lifecycleReport(rt, id))!;
    expect(rep.referrals).toMatchObject({ counted: 1, attended: 1 });
    expect(rep.referrals.rejected.map((r) => r.reason).sort()).toEqual(['over_cap', 'same_browser', 'same_ip']);
  });
});

// ───────────── after the event ─────────────

describe('post-event branching', () => {
  const base = { end: START + 2 * HOUR, offerOpened: true, offerOpen: true, closesAt: START + 50 * HOUR, replayClosesAt: START + 50 * HOUR };
  it('buyer, came-no-buy and no-show each get their own path, and deadline emails stop six hours before the real close', () => {
    expect(postPath({ attended: true, bought: true })).toBe('buyer');
    expect(postPath({ attended: true, bought: false })).toBe('attended_nobuy');
    expect(postPath({ attended: false, bought: false })).toBe('noshow');
    expect(duePost({ ...base, now: START + HOUR, attended: true, boughtAt: null })).toEqual([]);
    expect(duePost({ ...base, now: base.end + 20 * HOUR, attended: true, boughtAt: null })).toEqual(['nobuy_questions']);
    expect(duePost({ ...base, now: base.end + 18 * HOUR, attended: false, boughtAt: null })).toEqual(['noshow_highlights']);
    expect(duePost({ ...base, now: base.end + 18 * HOUR, attended: false, boughtAt: START + HOUR })).toEqual([]);
    expect(duePost({ ...base, now: START + HOUR + 2 * DAY, attended: true, boughtAt: START + HOUR })).toEqual(['buyer_docs']);
    // Closing in less than six hours: no deadline email.
    expect(duePost({ ...base, closesAt: base.end + 24 * HOUR, replayClosesAt: base.end + 24 * HOUR, now: base.end + 20 * HOUR, attended: true, boughtAt: null })).toEqual([]);
    // The offer never opened: no "came, didn't buy" deadline email.
    expect(duePost({ ...base, offerOpened: false, offerOpen: false, now: base.end + 20 * HOUR, attended: true, boughtAt: null })).toEqual([]);
  });
  it('sends the no-show highlights with the real close, once', async () => {
    const id = await newEvent();
    const reg = await register(id);
    at(START + 30 * MIN);
    await (await import('../src/live/events')).hostAction(rt, id, { action: 'open_offer' });
    at(START + 2 * HOUR + 18 * HOUR + 5 * MIN);
    const lead = (await getLead(rt.env, reg.lead_id))!;
    const e = await ev(id);
    const r = (await rt.env.DB.prepare('SELECT * FROM live_webinar_regs WHERE id = ?').bind(reg.id).first<LiveReg>())!;
    expect(await sendPost(rt, e, r, lead)).toBe(1);
    expect(await sendPost(rt, e, r, lead)).toBe(0);
    const m = q<{ template: string; subject: string }>('SELECT template, subject FROM emails WHERE sequence = ?', `lc:${id}`);
    expect(m).toEqual([{ template: 'lc_noshow_highlights', subject: 'What you missed: Buy your first competitor' }]);
  });
});

// ───────────── the confirmation page saves, the funnel and the AI co-host context ─────────────

describe('pre-show saves and the show-up funnel', () => {
  it('saves the question and worksheet (seeding the Deal Plan in the room), the one-tap text opt-in, tracked returns, and reports the funnel', async () => {
    const id = await newEvent({ platform: 'room' });
    const reg = await register(id, { body: { phone: '+12125550100' } });
    expect(reg.sms_ok).toBe(0);
    expect((await saveQuestion(rt, reg, 'hi')).ok).toBe(false);
    expect((await saveQuestion(rt, reg, 'See https://spam.example')).ok).toBe(false);
    expect((await saveQuestion(rt, reg, 'How does seller finance work when the seller wants cash at closing?')).ok).toBe(true);
    expect((await saveWorksheet(rt, reg, { industry: 'HVAC', size: '$3M revenue', geography: 'Texas', owners_per_week: '25', action_1: 'List ten owners' })).ok).toBe(true);
    const plan = q<{ data: string; steps: string }>('SELECT data, steps FROM room_plans WHERE who = ?', memberId('reg', reg.id))[0];
    expect(JSON.parse(plan.data)).toMatchObject({ industry: 'HVAC', owners_per_week: '25', action_1: 'List ten owners' });
    expect(plan.steps).toBe('[]'); // the steps (and their points) count in the room
    expect(await smsOptIn(rt, reg, {}, 'US')).toEqual({ ok: true });
    expect(q('SELECT sms_ok FROM live_webinar_regs WHERE id = ?', reg.id)).toEqual([{ sms_ok: 1 }]);
    x("UPDATE leads SET sms_opt_out_at = 1 WHERE id = ?", reg.lead_id);
    expect(await smsOptIn(rt, reg, {}, 'US')).toEqual({ ok: false, error: 'stopped' });
    expect(await preShowContext(rt, id)).toContain('Dana asked: How does seller finance work');
    // Tracked return from the 10-minute email, then joined.
    at(START - 9 * MIN);
    expect(await touch(rt, reg, 'e-r10m')).toBe(true);
    expect(await touch(rt, reg, 'e-r10m')).toBe(false); // the same click twice in ten minutes counts once
    expect(await touch(rt, reg, '<bad>')).toBe(false);
    x('UPDATE live_webinar_regs SET joined_at = ? WHERE id = ?', START + MIN, reg.id);
    x("INSERT INTO lc_regs (reg_id, event_id, lead_id, created_at) VALUES ('x', 'y', 'z', 1)");
    const rep = (await lifecycleReport(rt, id))!;
    expect(rep.funnel.map((s) => [s.key, s.n])).toEqual([['registered', 1], ['cal', 0], ['reminded', 0], ['joined', 1], ['stayed', 0], ['bought', 0]]);
    expect(rep.cameBack).toEqual([{ via: 'e-r10m', label: 'Email: 10 minutes', n: 1 }]);
    expect(rep.questions).toHaveLength(1);
    expect(rep.worksheets).toBe(1);
    expect(cameBackVia(START, [{ via: 'cal', at: START - 7 * HOUR }])).toBe('direct');
    expect(showUpFunnel([])[0]).toMatchObject({ n: 0, ofRegistered: null });
    // Funnel HQ settings.
    expect((await saveLcEvent(rt, id, { video_url: 'javascript:alert(1)' })).ok).toBe(false);
    expect((await saveLcEvent(rt, id, { video_url: '/video/preshow.mp4', slides: 'Tonight | The 1.5x test\nBring | Your numbers', subject_ab: true })).ok).toBe(true);
    const s = (await lifecycleReport(rt, id))!.settings;
    expect(s).toMatchObject({ video: '/video/preshow.mp4', subjectAb: true, slidesCustom: true });
    expect(s.slides).toEqual([{ title: 'Tonight', body: 'The 1.5x test' }, { title: 'Bring', body: 'Your numbers' }]);
  });
  it('splits reminder subjects A/B by a sticky hash when the test is on', async () => {
    const id = await newEvent();
    await saveLcEvent(rt, id, { subject_ab: true });
    for (let i = 0; i < 12; i++) await register(id, { email: `p${i}@example.com`, v: { visitorId: `v${i}`, ip: `10.0.0.${i}` } });
    at(START - HOUR + MIN);
    await processLiveMessages(rt, Date.now());
    const t = q<{ template: string; subject: string }>("SELECT template, subject FROM emails WHERE template LIKE 'live_r1h%'");
    expect(t).toHaveLength(12);
    const b = t.filter((r) => r.template === 'live_r1h~b');
    expect(b.length).toBeGreaterThan(0);
    expect(b.length).toBeLessThan(12);
    expect(new Set(b.map((r) => r.subject))).toEqual(new Set([SUBJECT_B.r1h!({ title: '', when: '' })]));
    const rep = (await lifecycleReport(rt, id))!;
    const r1h = rep.ab.rows.find((r) => r.kind === 'r1h')!;
    expect(r1h.a.sent + r1h.b.sent).toBe(12);
  });
});

// ───────────── copy ─────────────

describe('copy audit', () => {
  it('every lifecycle string passes the house copy rules', () => {
    const sample = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'function' ? (v as (...a: unknown[]) => string)(3, 1) : v]));
    const strings = { lc: sample(LC_COPY), room: sample(LC_ROOM_COPY), slides: DEFAULT_SLIDES, b: Object.values(SUBJECT_B).map((f) => f!({ title: 'Buy your first competitor', when: 'Tuesday 10 November, 3:00 pm EST' })) };
    expect(auditFields(strings)).toEqual([]);
    expect(LC_COPY.heading('Dana')).toBe('You’re in, Dana.');
    expect(auditCopy(LC_COPY.shareText('Buy your first competitor'))).toEqual([]);
    expect(JSON.stringify(strings)).not.toMatch(/[!—]/);
  });
  it('every reminder and post-event email passes the email rules, with real deadlines only', () => {
    const ctx = { name: 'Dana', title: 'Buy your first competitor', when: 'Tuesday 10 November at 3:00 pm EST', room: 'https://live.test/live/room/tok', ticket: null, ticketLabel: null, attended: false, offerOpened: true, closes: 'Thursday 12 November at 5:00 pm EST', replay: true, deposit: '$5,000', calendar: { google: 'https://g', outlook: 'https://o', apple: 'https://a' } };
    for (const k of ['r3h', 'missing'] as const) {
      const m = liveEmail(k, ctx);
      expect(auditEmail({ subject: m.subject, preheader: m.preheader, body: m.paras })).toEqual([]);
      expect(liveText(k, { title: 'X', when: 'Tuesday', site: 'G&L' })).not.toMatch(/[!—]/);
    }
    expect(liveEmail('r3h', ctx)).toMatchObject({ calendar: ctx.calendar });
    const re = liveEmail('confirm', { ...ctx, rescheduled: true });
    expect(re.subject).toBe('New time: Buy your first competitor');
    expect(auditEmail({ subject: re.subject, preheader: re.preheader, body: re.paras })).toEqual([]);
    const pc = { name: 'Dana', title: 'Buy your first competitor', room: 'https://live.test/r', closes: 'Thursday 12 November at 5:00 pm EST', deposit: '$5,000', onboarding: null, highlights: ['Owners with no successor, off market', 'The 1.5x test'], replayCloses: 'Thursday 12 November at 5:00 pm EST' };
    for (const k of ['buyer_docs', 'nobuy_questions', 'noshow_highlights'] as const) {
      const m = postEmail(k, pc);
      expect(auditEmail({ subject: m.subject, preheader: m.preheader, body: m.paras })).toEqual([]);
      expect(JSON.stringify(m)).not.toMatch(/[!—]/);
    }
    // No open offer: no deadline sentence at all.
    expect(postEmail('nobuy_questions', { ...pc, closes: null }).paras.join(' ')).not.toMatch(/closes/);
    expect(REMINDER_COPY.cancelled({ title: 'X' })).not.toMatch(/[!—]/);
    expect(parseSlides('[{"title":"<b>x</b>","body":"y"}]')).toEqual([{ title: 'bx/b', body: 'y' }]);
  });
});

void inQuiet; void (null as unknown as LiveEvent);
