import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/app';
import type { VisitorCtx } from '../src/lib/identity';
import { auditCopy, auditEmail, auditFields } from '../src/content/copy-rules';
import {
  DAY, HOUR, LC2_PAGE, MIN, type Lc2Ctx, dueMissed, gate, impact, inSendingHours, leadinEmail, leadinPlan, missedEmail, nextSendable, watchBucket, watchedPct,
} from '../src/live/lifecycle2';
import { dailyCap, lc2Cron, lc2Report, lc2Toggles, leadinBlock, saveLc2 } from '../src/live/lifecycle2-db';
import { lcReg, saveQuestion, saveWorksheet, sendPost, touch } from '../src/live/lifecycle-db';
import { type LiveReg, getEvent, hostAction, registerLive, saveEvent } from '../src/live/events';
import { getLead } from '../src/funnel/leads';

// ───────────── a real SQLite database shaped like D1, with every migration applied (the lifecycle.test.ts harness) ─────────────

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

/** The session: Tuesday 10 November 2026, 15:00 in New York (20:00 UTC), two hours long. */
const START = Date.parse('2026-11-10T20:00:00Z');
const END = START + 2 * HOUR;
const NY = 'America/New_York';
const pending: Promise<unknown>[] = [];
const flush = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
let db: DatabaseSync;
let rt: Runtime;
const SETTINGS: Record<string, string> = { SALES_TIMEZONE: NY, SITE_NAME: 'G&L', SESSION_SECRET: 'x' };
const makeRt = (s: Record<string, string> = SETTINGS) => ({ env: { DB: d1(db), SESSION_SECRET: 'test-session-secret' }, settings: { ...s }, reps: [], origin: 'https://apply.test', waitUntil: (p: Promise<unknown>) => { pending.push(p.catch(() => null)); } }) as unknown as Runtime;
const q = <T = Record<string, unknown>>(sql: string, ...a: unknown[]) => db.prepare(sql).all(...(a as (string | number | null)[])) as T[];
const x = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...(a as (string | number | null)[]));
const visitor = (): VisitorCtx => ({
  visitorId: 'v1', sessionId: 's1', leadId: null, isNewVisitor: true, isNewSession: true, isBot: false, botReason: null, variant: 'a',
  ua: { device: 'mobile', browser: 'x', os: 'y' } as never, userAgent: 'test', geo: { country: 'US', city: null, timezone: NY } as never, ip: '1.1.1.1', touch: null, fbp: null, fbc: null, marketingConsent: false, consentRequired: false,
});
const at = (t: number) => vi.setSystemTime(t);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at(START - 6 * DAY);
  db = freshDb();
  rt = makeRt();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); pending.length = 0; });

async function newEvent(o: { platform?: 'zoom' | 'room' } = {}) {
  const r = await saveEvent(rt, { title: 'Buy your first competitor', starts_at: START, tz: NY, duration_min: 120, join_url: 'https://zoom.us/j/123', platform: o.platform ?? 'zoom' });
  if (!r.ok) throw new Error(r.error);
  return r.id;
}
async function register(eventId: string, email = 'dana@example.com') {
  const r = await registerLive(rt, visitor(), { first_name: 'Dana', email, revenue: '3_10m', event_id: eventId, tz: NY });
  await flush();
  return r.reg;
}
const regRow = (id: string) => rt.env.DB.prepare('SELECT * FROM live_webinar_regs WHERE id = ?').bind(id).first<LiveReg>() as Promise<LiveReg>;
const lc2Emails = (eventId: string) => q<{ template: string; status: string; error: string | null }>('SELECT template, status, error FROM emails WHERE sequence = ? ORDER BY step', `lc2:${eventId}`);

// ───────────── pure rules ─────────────

describe('the plan by sign-up date', () => {
  const on = { leadin: true, adaptive: false };
  it('is off unless switched on', () => {
    expect(leadinPlan(START, START - 6 * DAY, { leadin: false, adaptive: false }, NY)).toEqual({ mode: 'off', items: [] });
  });
  it('early sign-ups get three parts a day apart, inside their sending hours, before the 24-hour reminder', () => {
    const p = leadinPlan(START, START - 6 * DAY, on, NY);
    expect(p.mode).toBe('full');
    expect(p.items.map((i) => [i.step, new Date(i.at).toISOString()])).toEqual([
      ['welcome', '2026-11-06T20:00:00.000Z'], ['question', '2026-11-07T20:00:00.000Z'], ['prework', '2026-11-08T20:00:00.000Z'],
    ]);
    expect(p.items.every((i) => i.at < i.until && i.until <= START - 30 * HOUR)).toBe(true);
    // In Sydney the same moments are at night: each part moves to 8:00 their time, still inside its window.
    const syd = leadinPlan(START, START - 6 * DAY, on, 'Australia/Sydney');
    expect(syd.items.every((i) => inSendingHours(i.at, 'Australia/Sydney') && i.at < i.until)).toBe(true);
  });
  it('a later sign-up gets the parts that still fit; a late one gets one essentials email with the adaptive switch, or nothing extra', () => {
    expect(leadinPlan(START, START - 80 * HOUR, on, NY)).toMatchObject({ mode: 'partial', items: [{ step: 'question' }, { step: 'prework' }] });
    expect(leadinPlan(START, START - 60 * HOUR, on, NY)).toMatchObject({ mode: 'partial', items: [{ step: 'prework' }] });
    const late = leadinPlan(START, START - 60 * HOUR, { leadin: true, adaptive: true }, NY);
    expect(late.mode).toBe('compressed');
    expect(late.items).toEqual([{ step: 'essentials', at: START - 54 * HOUR, until: START - 4 * HOUR }]);
    // Adaptive alone: early sign-ups get nothing extra, late ones the essentials.
    expect(leadinPlan(START, START - 6 * DAY, { leadin: false, adaptive: true }, NY).mode).toBe('none');
    expect(leadinPlan(START, START - 30 * HOUR, { leadin: false, adaptive: true }, NY).mode).toBe('compressed');
    // Too close to the start even for that: the reminders cover it.
    expect(leadinPlan(START, START - 9 * HOUR, { leadin: true, adaptive: true }, NY)).toEqual({ mode: 'none', items: [] });
    // Signed up at night: the essentials wait for the morning.
    const night = Date.parse('2026-11-09T03:00:00Z'); // 22:00 in New York
    expect(new Date(leadinPlan(START, night, { leadin: false, adaptive: true }, NY).items[0].at).toISOString()).toBe('2026-11-09T13:00:00.000Z');
    expect(nextSendable(Date.parse('2026-11-09T13:30:00Z'), NY)).toBe(Date.parse('2026-11-09T13:30:00Z'));
  });
});

describe('the contact limits', () => {
  const g = { now: Date.parse('2026-11-07T20:00:00Z'), tz: NY, unsubscribed: false, lastEmailAt: null, lastLc2At: null, callsAt: [], sent24h: 0, cap: 15 };
  it('waits for sending hours, the six-hour email gap, the AI call gap, one a day and the daily cap; stops for unsubscribe and a zero cap', () => {
    expect(gate(g)).toEqual({ ok: true });
    expect(gate({ ...g, now: Date.parse('2026-11-08T03:00:00Z') })).toMatchObject({ ok: false, final: false, why: 'Outside their sending hours' });
    expect(gate({ ...g, lastEmailAt: g.now - 5 * HOUR })).toMatchObject({ ok: false, why: 'Another email went in the last six hours' });
    expect(gate({ ...g, lastEmailAt: g.now - 6 * HOUR })).toEqual({ ok: true });
    expect(gate({ ...g, lastLc2At: g.now - 10 * HOUR, lastEmailAt: g.now - 10 * HOUR })).toMatchObject({ ok: false, why: 'One of these a day at most' });
    expect(gate({ ...g, callsAt: [g.now + 90 * MIN] })).toMatchObject({ ok: false, why: 'An AI call to them is close' });
    expect(gate({ ...g, callsAt: [g.now + 3 * HOUR] })).toEqual({ ok: true });
    expect(gate({ ...g, sent24h: 15 })).toMatchObject({ ok: false, why: 'Daily email cap reached' });
    expect(gate({ ...g, unsubscribed: true })).toMatchObject({ ok: false, final: true });
    expect(gate({ ...g, cap: 0 })).toMatchObject({ ok: false, final: true });
  });
  it('the daily cap is the existing pre-session setting', () => {
    expect(dailyCap(makeRt())).toBe(15);
    expect(dailyCap(makeRt({ ...SETTINGS, PREWEBINAR_EMAILS_PER_DAY: '0' }))).toBe(0);
    expect(dailyCap(makeRt({ ...SETTINGS, PREWEBINAR_EMAILS_PER_DAY: '3' }))).toBe(3);
  });
});

describe('the missed-live path (pure)', () => {
  const base = { end: END, joined: false, bought: false, offerOpen: true, closesAt: END + 48 * HOUR, bucket: 'none' as const, sent1: null, sent2: false };
  it('first email 18 hours after the end, keyed to what they watched; a second only after they watch more; never once the offer is nearly closed', () => {
    expect(dueMissed({ ...base, now: END + 17 * HOUR })).toBeNull();
    expect(dueMissed({ ...base, now: END + 18 * HOUR })).toEqual({ step: 'missed1', bucket: 'none' });
    expect(dueMissed({ ...base, now: END + 18 * HOUR, joined: true })).toBeNull();
    expect(dueMissed({ ...base, now: END + 18 * HOUR, bought: true })).toBeNull();
    expect(dueMissed({ ...base, now: END + 18 * HOUR, offerOpen: false })).toBeNull();
    expect(dueMissed({ ...base, now: END + 18 * HOUR, closesAt: END + 23 * HOUR })).toBeNull();
    expect(dueMissed({ ...base, now: END + 31 * HOUR, sent1: 'none' })).toBeNull();
    expect(dueMissed({ ...base, now: END + 31 * HOUR, sent1: 'none', bucket: 'started' })).toEqual({ step: 'missed2', bucket: 'started' });
    expect(dueMissed({ ...base, now: END + 41 * HOUR, sent1: 'none', bucket: 'most' })).toBeNull(); // under eight hours left
    expect(dueMissed({ ...base, now: END + 31 * HOUR, sent1: 'started', bucket: 'most', sent2: true })).toBeNull();
  });
  it('buckets the replay watched', () => {
    expect(watchedPct('1100000000')).toBe(0.2);
    expect(watchedPct('')).toBeNull();
    expect(watchBucket({ started: false, pct: null })).toBe('none');
    expect(watchBucket({ started: true, pct: null })).toBe('started');
    expect(watchBucket({ started: true, pct: 0.2 })).toBe('started');
    expect(watchBucket({ started: true, pct: 0.5 })).toBe('most');
  });
  it('impact counts only delivered emails, with the skip reasons', () => {
    const r = (o: Partial<Parameters<typeof impact>[0]['rows'][number]>) => ({ status: 'simulated', opened_at: null, sent_at: 1, why: null, clicked: false, joined: false, replayAfter: false, boughtAfter: false, ...o });
    const i = impact({ step: 'welcome', rows: [r({ opened_at: 2, clicked: true, joined: true }), r({}), r({ status: 'skipped', why: 'Unsubscribed' })] });
    expect(i).toMatchObject({ sent: 2, opened: 1, clicked: 1, outcome: 1, openRate: 0.5, outcomeLabel: 'Joined live', skipped: [{ why: 'Unsubscribed', n: 1 }] });
    expect(impact({ step: 'missed1', rows: [r({ replayAfter: true, boughtAfter: true })] })).toMatchObject({ outcome: 1, bought: 1, outcomeLabel: 'Watched the replay after it' });
  });
});

// ───────────── sending, end to end on the real schema ─────────────

describe('the lead-in by email', () => {
  it('sends nothing while the switches are off (the default)', async () => {
    const id = await newEvent();
    await register(id);
    expect(await lc2Toggles(rt, id, true)).toEqual({ leadin: false, adaptive: false, missed: false });
    for (const t of [START - 96 * HOUR + 5 * MIN, START - 72 * HOUR + 5 * MIN, START - 48 * HOUR + 5 * MIN]) { at(t); await lc2Cron(rt, t); }
    expect(lc2Emails(id)).toEqual([]);
  });

  it('sends each part once on its date, skips the question part once they sent one on the page, and links to their own page', async () => {
    const id = await newEvent();
    const reg = await register(id);
    expect((await saveLc2(rt, id, { leadin: true })).ok).toBe(true);
    at(START - 96 * HOUR + 5 * MIN);
    expect(await lc2Cron(rt, Date.now())).toBe(1);
    expect(await lc2Cron(rt, Date.now())).toBe(0);
    const w = q<{ subject: string; status: string }>("SELECT subject, status FROM emails WHERE template = 'lc2_welcome'")[0];
    expect(w).toEqual({ subject: 'Part 1 of 3 before Buy your first competitor', status: 'simulated' });
    // The question arrives on the page first: that part is not emailed.
    expect((await saveQuestion(rt, reg, 'How does seller finance work when the seller wants cash at closing?')).ok).toBe(true);
    at(START - 72 * HOUR + 5 * MIN);
    expect(await lc2Cron(rt, Date.now())).toBe(0);
    at(START - 48 * HOUR + 5 * MIN);
    expect(await lc2Cron(rt, Date.now())).toBe(1);
    expect(lc2Emails(id)).toEqual([
      { template: 'lc2_welcome', status: 'simulated', error: null },
      { template: 'lc2_question', status: 'skipped', error: 'Already sent their question' },
      { template: 'lc2_prework', status: 'simulated', error: null },
    ]);
    // Re-running later never sends again.
    at(START - 31 * HOUR);
    expect(await lc2Cron(rt, Date.now())).toBe(0);
    // The page shows the parts with their real dates and states.
    const html = await leadinBlock(rt, (await getEvent(rt, id))!, await regRow(reg.id), await lcReg(rt, reg.id), NY);
    expect(html).toContain('Welcome, and why it runs live');
    expect(html).toMatch(/data-lc2-step="question"[^]*data-lc2-state="done"/);
    expect(html).toContain('data-lc2-state="sent"');
  });

  it('waits for an AI call and another recent email, and never emails someone who unsubscribed', async () => {
    const id = await newEvent();
    const reg = await register(id);
    await saveLc2(rt, id, { leadin: true });
    const t = START - 96 * HOUR + 5 * MIN;
    at(t);
    x("INSERT INTO outbound_calls (id, lead_id, kind, status, run_at, attempts, created_at, updated_at, wc_ref) VALUES ('oc1', ?, 'w_pre_start', 'queued', ?, 0, ?, ?, ?)", reg.lead_id, t + HOUR, t, t, `live:${reg.id}`);
    expect(await lc2Cron(rt, t)).toBe(0);
    x("UPDATE outbound_calls SET status = 'cancelled'");
    x("INSERT INTO emails (id, lead_id, sequence, step, template, to_email, send_at, sent_at, status, created_at) VALUES ('m9', ?, 'other', 1, 'x', 'dana@example.com', ?, ?, 'sent', ?)", reg.lead_id, t - HOUR, t - HOUR, t - HOUR);
    expect(await lc2Cron(rt, t)).toBe(0);
    expect(lc2Emails(id)).toEqual([]); // waits, nothing recorded
    at(t + 5 * HOUR + 5 * MIN);
    x('UPDATE leads SET unsubscribed_at = ? WHERE id = ?', Date.now(), reg.lead_id);
    expect(await lc2Cron(rt, Date.now())).toBe(0);
    expect(lc2Emails(id)).toEqual([{ template: 'lc2_welcome', status: 'skipped', error: 'Unsubscribed' }]);
  });

  it('a late sign-up gets one essentials email with the calendar links, six hours after signing up', async () => {
    const id = await newEvent();
    await saveLc2(rt, id, { leadin: true, adaptive: true });
    at(START - 30 * HOUR); // Monday 9:00 in New York
    const reg = await register(id);
    at(START - 26 * HOUR);
    expect(await lc2Cron(rt, Date.now())).toBe(0);
    at(START - 24 * HOUR + 5 * MIN);
    expect(await lc2Cron(rt, Date.now())).toBe(1);
    expect(lc2Emails(id)).toEqual([{ template: 'lc2_essentials', status: 'simulated', error: null }]);
    expect(q<{ subject: string }>("SELECT subject FROM emails WHERE template = 'lc2_essentials'")[0].subject).toBe('Before Buy your first competitor: the essentials');
    // The worksheet saved on the page marks the essentials part done there.
    await saveWorksheet(rt, reg, { industry: 'HVAC' });
    const html = await leadinBlock(rt, (await getEvent(rt, id))!, await regRow(reg.id), await lcReg(rt, reg.id), NY);
    expect(html).toContain('The essentials');
    expect(html).toContain('data-lc2-state="done"');
    expect(html).not.toContain('Welcome, and why it runs live');
  });
});

describe('the missed-live path by email', () => {
  async function eventWithOffer() {
    const id = await newEvent();
    x("UPDATE live_webinars SET replay_url = 'https://example.com/replay' WHERE id = ?", id);
    return id;
  }
  it('no-shows get the short path keyed to the replay, only while the offer is open; it replaces the highlights email', async () => {
    const id = await eventWithOffer();
    const dana = await register(id);
    const came = await register(id, 'ann@example.com');
    await saveLc2(rt, id, { missed: true });
    at(START + 30 * MIN);
    await hostAction(rt, id, { action: 'open_offer' });
    x('UPDATE live_webinar_regs SET joined_at = ? WHERE id = ?', START + MIN, came.id);
    at(END + 18 * HOUR + 5 * MIN);
    expect(await lc2Cron(rt, Date.now())).toBe(1);
    const lead = (await getLead(rt.env, dana.lead_id))!;
    const ev = (await getEvent(rt, id))!;
    expect(await sendPost(rt, ev, await regRow(dana.id), lead)).toBe(0); // no highlights email: the missed path replaced it
    expect(q('SELECT template FROM emails WHERE sequence = ?', `lc:${id}`)).toEqual([]);
    const m1 = q<{ template: string; subject: string; to_email: string }>("SELECT template, subject, to_email FROM emails WHERE sequence = ?", `lc2:${id}`);
    expect(m1).toEqual([{ template: 'lc2_missed1_none', subject: 'You missed Buy your first competitor live', to_email: 'dana@example.com' }]);
    // They open the replay: the second email is the "started" version, once, inside their sending hours.
    x('UPDATE live_webinar_regs SET replay_at = ? WHERE id = ?', Date.now(), dana.id);
    at(END + 30 * HOUR + 5 * MIN); // 23:05 in New York
    expect(await lc2Cron(rt, Date.now())).toBe(0);
    at(END + 39 * HOUR + 5 * MIN); // 8:05 in New York, nine hours before the close
    expect(await lc2Cron(rt, Date.now())).toBe(1);
    expect(await lc2Cron(rt, Date.now())).toBe(0);
    expect(lc2Emails(id).map((r) => r.template)).toEqual(['lc2_missed1_none', 'lc2_missed2_started']);
    // A tracked click from the email counts in Funnel HQ.
    expect(await touch(rt, await regRow(dana.id), 'e-m1')).toBe(true);
    x("UPDATE emails SET opened_at = ? WHERE template = 'lc2_missed1_none'", Date.now());
    const rep = (await lc2Report(rt, id))!;
    expect(rep.toggles).toEqual({ leadin: false, adaptive: false, missed: true });
    expect(rep.steps.find((s) => s.step === 'missed1')).toMatchObject({ sent: 1, opened: 1, clicked: 1, outcome: 1, bought: 0 });
    expect(rep.steps.find((s) => s.step === 'missed2')).toMatchObject({ sent: 1, outcome: 0 });
  });
  it('sends nothing once the offer is closed, or when the event has no replay', async () => {
    const id = await eventWithOffer();
    await register(id);
    await saveLc2(rt, id, { missed: true });
    const id2 = await newEvent();
    await register(id2, 'lee@example.com');
    await saveLc2(rt, id2, { missed: true });
    at(START + 30 * MIN);
    await hostAction(rt, id, { action: 'open_offer' });
    await hostAction(rt, id, { action: 'close_offer' });
    at(END + 18 * HOUR + 5 * MIN);
    expect(await lc2Cron(rt, Date.now())).toBe(0);
    expect(lc2Emails(id)).toEqual([]);
    x('UPDATE live_webinars SET offer_opened_at = ? WHERE id = ?', START + 30 * MIN, id2);
    expect(await lc2Cron(rt, Date.now())).toBe(0);
    expect(lc2Emails(id2)).toEqual([]);
  });
});

describe('Funnel HQ', () => {
  it('reports the plans and the comparison with real counts, and saves each switch on its own', async () => {
    const id = await newEvent();
    await register(id);
    at(START - 30 * HOUR);
    await register(id, 'late@example.com');
    expect((await saveLc2(rt, id, { leadin: true })).toggles).toEqual({ leadin: true, adaptive: false, missed: false });
    expect((await saveLc2(rt, id, { adaptive: true })).toggles).toEqual({ leadin: true, adaptive: true, missed: false });
    expect((await saveLc2(rt, 'nope', { leadin: true })).ok).toBe(false);
    const rep = (await lc2Report(rt, id))!;
    expect(rep.plans).toEqual({ full: 1, compressed: 1 });
    expect(rep.compare).toEqual({ got: { n: 0, joined: 0, rate: null }, didNot: { n: 2, joined: 0, rate: 0 } });
    expect(rep.steps.every((s) => s.sent === 0)).toBe(true);
    expect((await saveLc2(rt, id, { leadin: false, adaptive: false })).toggles).toEqual({ leadin: false, adaptive: false, missed: false });
  });
});

// ───────────── copy ─────────────

describe('copy audit', () => {
  const ctx: Lc2Ctx = { name: 'Dana', title: 'Buy your first competitor', when: 'Tuesday 10 November at 3:00 pm EST', room: 'https://live.test/live/room/tok', deposit: '$5,000', closes: 'Thursday 12 November at 5:00 pm EST', calendar: { google: 'https://g', outlook: 'https://o', apple: 'https://a' }, unsubscribe: 'https://apply.test/u/l1/sig', video: true };
  it('every lead-in and missed-live email passes the email rules, with the unsubscribe line and real deadlines only', () => {
    const all = [
      ...(['welcome', 'question', 'prework', 'essentials'] as const).flatMap((k) => [leadinEmail(k, ctx), leadinEmail(k, { ...ctx, video: false, unsubscribe: null })]),
      ...(['missed1', 'missed2'] as const).flatMap((s) => (['none', 'started', 'most'] as const).flatMap((b) => [missedEmail(s, b, ctx), missedEmail(s, b, { ...ctx, closes: null })])),
    ];
    for (const m of all) {
      expect(auditEmail({ subject: m.subject, preheader: m.preheader, body: [...m.paras, ...m.after] })).toEqual([]);
      expect(JSON.stringify(m)).not.toMatch(/[!—]/);
      expect(m.button.href).toBe(ctx.room);
    }
    expect(leadinEmail('welcome', ctx).after).toEqual(['To stop emails like this one: https://apply.test/u/l1/sig']);
    expect(missedEmail('missed1', 'none', { ...ctx, closes: null }).paras.join(' ')).not.toMatch(/close/);
    expect(missedEmail('missed1', 'none', ctx).paras.join(' ')).toContain('both close Thursday 12 November at 5:00 pm EST');
    expect(leadinEmail('essentials', ctx).calendar).toEqual(ctx.calendar);
    expect(JSON.stringify(all)).not.toMatch(/\bfree\b/i);
  });
  it('the page strings pass the house rules', () => {
    const sample = Object.fromEntries(Object.entries(LC2_PAGE).map(([k, v]) => [k, typeof v === 'function' ? (v as (a: unknown) => string)(2) : v]));
    expect(auditFields(sample)).toEqual([]);
    expect(auditCopy(LC2_PAGE.inbox('Friday 6 November'))).toEqual([]);
    expect(JSON.stringify(LC2_PAGE)).not.toMatch(/[!—]/);
  });
});
