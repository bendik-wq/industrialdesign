import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/app';
import { auditEmail, auditFields } from '../src/content/copy-rules';
import { SETTINGS } from '../src/settings';
import type { VisitorCtx } from '../src/lib/identity';
import { CHECKOUT, DAYS, DAY_PAGE, HUB, LANDING, OFFER } from '../src/challenge/content';
import { challengeConfig, createCohort, getDays, getReg, loadCohort, nextCohort, updateCohort, updateDay } from '../src/challenge/cohorts';
import { CH_CYCLE, CH_STEPS, CHALLENGE_TEMPLATES, challengeSkip, planChallengeEmails, retimeCohort } from '../src/challenge/emails';
import { cohortOffer, offerForKey, offerStatus, setOffer, startChallengeDeposit } from '../src/challenge/offer';
import { challengePaymentPaid, challengeRefund, nextStep, oneClickVip, payCopy, payOrder, registerChallenge, savedChallengeMethod } from '../src/challenge/payments';
import { answerPoll, askHotSeat, dayFeed, joinDay, postDayChat, replayDay, submitHomework, participantView } from '../src/challenge/room';
import { cohortStats } from '../src/challenge/admin';
import { HOUR, MIN, dayPhase, focusDay, localParts, offerCloseAt, replayAccess, scheduleDays, summarise } from '../src/challenge/schedule';
import { barHtml, challengeIcs, landingHtml, offerBlockHtml, payHtml, progressHtml, timelineHtml, vipHtml } from '../src/challenge/pages';
import { handleWhopEvent } from '../src/webinar/whop';
import { savedTicketMethod } from '../src/webinar/one-click';
import type { TemplateCtx } from '../src/integrations/templates';
import { SEQUENCES } from '../src/integrations/sequences';
import { DEFAULT_SMS_SEQUENCES } from '../src/integrations/sms-defaults';

// ───────────── A real SQLite database shaped like D1 (batch returns rows), every migration applied ─────────────
interface Stmt { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } }
interface DatabaseSync { prepare(sql: string): Stmt; exec(sql: string): void }
const node = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown; cwd(): string } }).process;
const { DatabaseSync } = node.getBuiltinModule('node:sqlite') as { DatabaseSync: new (path: string) => DatabaseSync };
const fs = node.getBuiltinModule('node:fs') as { readdirSync(p: string): string[]; readFileSync(p: string, enc: string): string };

function d1(db: DatabaseSync) {
  const prepare = (sql: string) => {
    let args: unknown[] = [];
    const norm = () => args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? Number(a) : a)) as (string | number | null)[];
    const isRead = /^\s*(SELECT|WITH)\b/i.test(sql);
    const st = {
      bind: (...a: unknown[]) => { args = a; return st; },
      first: async <T>() => (db.prepare(sql).get(...norm()) as T | undefined) ?? null,
      all: async <T>() => ({ results: db.prepare(sql).all(...norm()) as T[] }),
      run: async () => {
        if (isRead) return { results: db.prepare(sql).all(...norm()), meta: { changes: 0 } };
        const r = db.prepare(sql).run(...norm());
        return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
      },
    };
    return st;
  };
  return { prepare, batch: async (stmts: { run: () => Promise<unknown> }[]) => { const out = []; for (const s of stmts) out.push(await s.run()); return out; } };
}
function freshDb() {
  const db = new DatabaseSync(':memory:');
  const dir = `${node.cwd()}/migrations`;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(`${dir}/${f}`, 'utf8'));
  return db;
}
const BASE = { WHOP_API_KEY: 'apik_test', WHOP_WEBHOOK_SECRET: 'ws_test', WHOP_COMPANY_ID: 'biz_test', SALES_TIMEZONE: 'America/New_York', WHOP_BUYER_FEE_PERCENT: '0' };
const pending: Promise<unknown>[] = [];
const makeRt = (db: DatabaseSync, settings: Record<string, string> = BASE) =>
  ({ env: { DB: d1(db) }, settings: { ...Object.fromEntries(SETTINGS.map((d) => [d.key, ''])), ...settings }, reps: [], origin: 'https://apply.test', waitUntil: (p: Promise<unknown>) => { pending.push(p); } }) as unknown as Runtime;
const visitor = (o: Partial<VisitorCtx> = {}) => ({
  visitorId: 'v1', sessionId: 's1', leadId: null, isNewVisitor: true, isNewSession: true, isBot: false, botReason: null, variant: 'a', ua: { device: 'desktop' }, userAgent: 'test',
  geo: { country: 'US', city: 'Austin', timezone: 'America/Chicago' }, ip: '203.0.113.9', touch: null, fbp: null, fbc: null, marketingConsent: false, consentRequired: false, ...o,
}) as unknown as VisitorCtx;

interface Call { method: string; path: string; body: Record<string, unknown> | null }
function stubWhop(o: { creates?: Record<string, unknown>[]; statuses?: Record<string, unknown>[] } = {}) {
  const calls: Call[] = [];
  let c = 0, s = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { method?: string; body?: string }) => {
    const u = String(url);
    const path = u.replace('https://api.whop.com/api/v1/', '');
    calls.push({ method: init.method ?? 'GET', path, body: init.body ? JSON.parse(init.body) : null });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (!u.startsWith('https://api.whop.com/')) return json(200, { ok: true });
    if (path === 'payments' && init.method === 'POST') { const l = o.creates ?? [{ id: 'pay_1', status: 'paid' }]; return json(201, l[Math.min(c++, l.length - 1)]); }
    if (/^payments\/[^/]+\/status$/.test(path)) { const l = o.statuses ?? [{ status: 'succeeded' }]; return json(200, l[Math.min(s++, l.length - 1)]); }
    if (path.startsWith('payments/')) return json(200, { member: { id: 'mber_1' }, payment_method: { id: 'payt_1', card: { brand: 'visa', last4: '4242' } } });
    return json(404, { error: { message: 'not stubbed' } });
  }));
  return calls;
}
afterEach(() => { vi.unstubAllGlobals(); pending.length = 0; });

const DAY = 24 * HOUR;
/** A cohort whose Day 1 starts `inMs` from now (NY time zone, starts on the hour) and its paid registration. */
async function setup(o: { inMs?: number; settings?: Record<string, string>; vip?: boolean } = {}) {
  const db = freshDb();
  const rt = makeRt(db, o.settings);
  const start = Date.now() + (o.inMs ?? 2 * DAY);
  const p = localParts(start, 'America/New_York');
  const id = await createCohort(rt, { name: 'Test cohort', start_date: p.date, start_time: p.time, timezone: 'America/New_York', duration_min: 90, join_url: 'https://zoom.us/j/123' }, Math.min(Date.now(), start - HOUR));
  return { db, rt, id };
}
async function paidReg(db: DatabaseSync, rt: Runtime, cohortId: string, o: { vip?: boolean; email?: string } = {}) {
  const now = Date.now();
  const lead = `l_${Math.random().toString(36).slice(2, 8)}`;
  const reg = `cr_${Math.random().toString(36).slice(2, 8)}`;
  const token = `tok${Math.random().toString(36).slice(2, 12)}abcdefghij`;
  db.prepare("INSERT INTO leads (id, ref_code, created_at, updated_at, first_name, last_name, email, status, revenue_band) VALUES (?, ?, ?, ?, 'Dana', 'Lee', ?, 'partial', '3m-10m')").run(lead, lead.slice(-6).toUpperCase(), now, now, o.email ?? `${lead}@example.com`);
  db.prepare("INSERT INTO challenge_registrations (id, token, cohort_id, lead_id, seq, revenue_band, status, vip, created_at, paid_at) VALUES (?, ?, ?, ?, 0, '3m-10m', 'paid', ?, ?, ?)").run(reg, token, cohortId, lead, o.vip ? 1 : 0, now, now);
  db.prepare("INSERT INTO challenge_orders (id, reg_id, lead_id, kind, status, amount, currency, provider, created_at, updated_at, paid_at) VALUES (?, ?, ?, 'ticket', 'paid', 10000, 'usd', 'whop', ?, ?, ?)").run(`co_${reg}`, reg, lead, now, now, now);
  return (await getReg(rt, token))!;
}

// ───────────── scheduling and time zones ─────────────
describe('cohort scheduling', () => {
  it('puts the five days on consecutive calendar days at the same local time, across a DST change', () => {
    // US clocks go back on Sunday 1 November 2026: Day 1 Thursday 29 Oct 7 pm EDT, Day 5 Monday 2 Nov 7 pm EST.
    const t = scheduleDays('2026-10-29', '19:00', 'America/New_York');
    expect(t).toHaveLength(5);
    expect(t.map((x) => localParts(x, 'America/New_York'))).toEqual(['29', '30', '31', '01', '02'].map((d, i) => ({ date: `2026-${i < 3 ? '10' : '11'}-${d}`, time: '19:00' })));
    expect(new Date(t[0]).toISOString()).toBe('2026-10-29T23:00:00.000Z');
    expect(new Date(t[4]).toISOString()).toBe('2026-11-03T00:00:00.000Z');
    // Sydney: the same rule in its own zone.
    expect(localParts(scheduleDays('2026-12-01', '12:30', 'Australia/Sydney')[0], 'Australia/Sydney')).toEqual({ date: '2026-12-01', time: '12:30' });
  });

  it('creates a cohort with five days, registers them with the live engine, and re-times on edit (hand-edited days keep their time)', async () => {
    const { db, rt, id } = await setup();
    let days = await getDays(rt, id);
    expect(days.map((d) => d.day)).toEqual([1, 2, 3, 4, 5]);
    expect(days.every((d) => d.join_url === 'https://zoom.us/j/123')).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM live_events WHERE key LIKE ?").get(`challenge:${id}:%`)).toEqual({ n: 0 }); // synced by the admin route
    const { syncLiveEvents } = await import('../src/challenge/cohorts');
    await syncLiveEvents(rt, id);
    expect((db.prepare("SELECT COUNT(*) AS n FROM live_events WHERE key LIKE ?").get(`challenge:${id}:%`) as { n: number }).n).toBe(5);
    // Day 3 by hand: a different time; then move the whole cohort an hour later.
    const d3 = localParts(days[2].starts_at, 'America/New_York');
    await updateDay(rt, id, 3, { date: d3.date, time: '08:15' });
    const c = (await loadCohort(rt, id))!.cohort;
    const later = `${String((Number(c.start_time.slice(0, 2)) + 1) % 24).padStart(2, '0')}${c.start_time.slice(2)}`;
    expect(await updateCohort(rt, id, { start_time: later })).toBe(true);
    days = await getDays(rt, id);
    expect(localParts(days[2].starts_at, 'America/New_York').time).toBe('08:15');
    expect(localParts(days[0].starts_at, 'America/New_York').time).toBe(later);
    // The live engine's link wins over the day's own link once the host console sets one.
    db.prepare("UPDATE live_events SET join_url = 'https://zoom.us/j/999' WHERE key = ?").run(`challenge:${id}:2`);
    expect((await getDays(rt, id))[1].join_url).toBe('https://zoom.us/j/999');
  });

  it('rejects bad input and a Day 1 in the past', async () => {
    const db = freshDb(); const rt = makeRt(db);
    await expect(createCohort(rt, { name: 'x', start_date: '2026-02-30', start_time: '19:00', timezone: 'America/New_York' })).rejects.toThrow(/start date/);
    await expect(createCohort(rt, { name: 'x', start_date: '2027-01-05', start_time: '25:00', timezone: 'America/New_York' })).rejects.toThrow(/start time/);
    await expect(createCohort(rt, { name: 'x', start_date: '2027-01-05', start_time: '19:00', timezone: 'Mars/Olympus' })).rejects.toThrow(/time zone/);
    await expect(createCohort(rt, { name: 'x', start_date: '2020-01-05', start_time: '19:00', timezone: 'UTC' })).rejects.toThrow(/past/);
  });

  it('day phases, focus day, offer deadline and replay rules', () => {
    const d = { day: 1, starts_at: 1_000_000_000_000, duration_min: 90 };
    expect(dayPhase(d, d.starts_at - 31 * MIN)).toBe('upcoming');
    expect(dayPhase(d, d.starts_at - 10 * MIN)).toBe('soon');
    expect(dayPhase(d, d.starts_at + MIN)).toBe('live');
    expect(dayPhase(d, d.starts_at + 90 * MIN)).toBe('ended');
    const days = [1, 2, 3, 4, 5].map((n) => ({ day: n, starts_at: d.starts_at + (n - 1) * DAY, duration_min: 90 }));
    expect(focusDay(days, d.starts_at + DAY + 10 * MIN)!.day).toBe(2);
    expect(focusDay(days, d.starts_at + 2 * HOUR)!.day).toBe(1); // replay card stays on top until 12h after
    expect(focusDay(days, d.starts_at + 20 * HOUR)!.day).toBe(2);
    const close = offerCloseAt(days, 48)!;
    expect(close).toBe(days[4].starts_at + 90 * MIN + 48 * HOUR);
    expect(replayAccess({ vip: false, replayUrl: null, closeAt: close, now: 0 })).toBe('none');
    expect(replayAccess({ vip: false, replayUrl: 'https://x', closeAt: close, now: close - 1 })).toBe('open');
    expect(replayAccess({ vip: false, replayUrl: 'https://x', closeAt: close, now: close })).toBe('closed');
    expect(replayAccess({ vip: true, replayUrl: 'https://x', closeAt: close, now: close + 30 * DAY })).toBe('open');
  });
});

// ───────────── registration and payments ─────────────
describe('ticket and VIP purchase paths', () => {
  it('registers, pays the ticket on the embedded form (card saved), then VIP in one click on that card', async () => {
    const { db, rt, id } = await setup();
    const { reg } = await registerChallenge(rt, visitor(), { first_name: 'Dana', email: 'dana@example.com', revenue: '3_10m', cohort_id: id });
    expect(reg.status).toBe('pending');
    expect(nextStep(rt, reg)).toBe(`https://apply.test/challenge/pay/${reg.token}`);
    const calls = stubWhop({ creates: [{ id: 'pay_t', status: 'paid' }, { id: 'pay_v', status: 'pending' }] });
    const r = await payOrder(rt, reg, 'ticket', 'ctok_abcdef');
    expect(r).toEqual({ ok: true, next: `https://apply.test/challenge/vip/${reg.token}` });
    const create = calls.find((c) => c.path === 'payments' && c.method === 'POST')!;
    expect(create.body).toMatchObject({ setup_future_usage: 'off_session', confirmation_token: 'ctok_abcdef', metadata: { kind: 'challenge_ticket' } });
    expect((create.body!.variant as { initial_price: number }).initial_price).toBe(100);
    const fresh = (await getReg(rt, reg.token))!;
    expect(fresh.status).toBe('paid');
    expect(await savedChallengeMethod(rt, reg.lead_id)).toMatchObject({ member_id: 'mber_1', payment_method_id: 'payt_1', card_last4: '4242' });
    // The deposit's one click (builder B) finds the challenge card too.
    expect(await savedTicketMethod(rt, reg.lead_id)).toMatchObject({ payment_method_id: 'payt_1' });
    // Confirmation email and the daily emails are queued.
    const emails = db.prepare("SELECT template FROM emails WHERE lead_id = ? AND sequence = 'challenge' AND status = 'pending'").all(reg.lead_id) as { template: string }[];
    expect(emails.map((e) => e.template)).toContain('ch_confirm');
    expect(emails.map((e) => e.template)).toContain('ch_d1_live');
    // VIP: one click on the saved card, customer-initiated.
    const v = await oneClickVip(rt, fresh, { sleep: async () => null, tries: 1 });
    expect(v).toEqual({ ok: true, next: `https://apply.test/challenge/welcome/${reg.token}`, outcome: 'paid' });
    const vipCall = calls.filter((c) => c.path === 'payments' && c.method === 'POST')[1];
    expect(vipCall.body).toMatchObject({ member_id: 'mber_1', payment_method_id: 'payt_1', off_session: false });
    expect((vipCall.body!.variant as { initial_price: number }).initial_price).toBe(300);
    expect((await getReg(rt, reg.token))!.vip).toBe(1);
    // A second press never charges twice.
    expect(await oneClickVip(rt, (await getReg(rt, reg.token))!)).toMatchObject({ ok: true, outcome: 'paid' });
    expect(calls.filter((c) => c.path === 'payments' && c.method === 'POST')).toHaveLength(2);
  });

  it('a declined VIP charge falls back to the card form; a hosted payment is settled by the webhook; a full refund ends the registration', async () => {
    const { db, rt, id } = await setup();
    const { reg } = await registerChallenge(rt, visitor(), { first_name: 'Sam', email: 'sam@example.com', revenue: '1_3m', cohort_id: id });
    stubWhop({ creates: [{ id: 'pay_t2', status: 'paid' }, { id: 'pay_v2' }], statuses: [{ status: 'canceled' }] });
    await payOrder(rt, reg, 'ticket', 'ctok_zzzzzz');
    const v = await oneClickVip(rt, (await getReg(rt, reg.token))!, { sleep: async () => null, tries: 1 });
    expect(v).toMatchObject({ ok: false, outcome: 'declined' });
    expect((v as { fallback: string }).fallback).toContain('/challenge/pay/');
    // Webhook for a VIP paid on the form later.
    db.prepare("INSERT INTO challenge_orders (id, reg_id, lead_id, kind, status, amount, currency, provider, method, created_at, updated_at) VALUES ('co_web', ?, ?, 'vip', 'pending', 30000, 'usd', 'whop', 'form', 1, 1)").run(reg.id, reg.lead_id);
    expect(await handleWhopEvent(rt, { type: 'payment.succeeded', data: { id: 'pay_web', status: 'paid', metadata: { challenge_order_id: 'co_web' } } })).toMatchObject({ paid: 'co_web' });
    expect((await getReg(rt, reg.token))!.vip).toBe(1);
    expect(await challengePaymentPaid(rt, { id: 'pay_web', status: 'paid', metadata: { challenge_order_id: 'co_web' } })).toMatchObject({ duplicate: true });
    // Full ticket refund: registration refunded, its pending emails cancelled.
    const out = await challengeRefund(rt, { status: 'succeeded', amount: 100, payment: { id: 'pay_t2', refunded_amount: 100 } });
    expect(out).toMatchObject({ fully: true });
    expect((await getReg(rt, reg.token))!.status).toBe('refunded');
    expect((db.prepare("SELECT COUNT(*) AS n FROM emails WHERE lead_id = ? AND sequence = 'challenge' AND status = 'pending'").get(reg.lead_id) as { n: number }).n).toBe(0);
    // A masterclass refund is not taken by the challenge handler.
    expect(await challengeRefund(rt, { status: 'succeeded', payment: { id: 'pay_other' } })).toBeNull();
  });

  it('a free cohort confirms at once; registration closes when Day 1 ends; under-$1M still welcome', async () => {
    const { rt, id } = await setup({ settings: { ...BASE, CHALLENGE_PRICE: '0' } });
    const { reg } = await registerChallenge(rt, visitor(), { first_name: 'Ana', email: 'ana@example.com', revenue: 'lt1m', cohort_id: id });
    expect(reg.status).toBe('paid');
    expect(challengeConfig(rt.settings)).toMatchObject({ free: true, vipLabel: '$300' });
    const late = await setup({ inMs: -2 * HOUR });
    await expect(registerChallenge(late.rt, visitor({ ip: '198.51.100.1' }), { first_name: 'Bo', email: 'bo@example.com', revenue: '3_10m', cohort_id: late.id })).rejects.toThrow(/closed/);
    expect(await nextCohort(late.rt)).toBeNull();
  });
});

// ───────────── progress, homework, replays, chat ─────────────
describe('progress tracking and the day page', () => {
  it('counts Join on Zoom only inside the live window, and the companion page after 5 minutes open while live', async () => {
    const { db, rt, id } = await setup({ inMs: 10 * MIN });
    const reg = await paidReg(db, rt, id);
    const L = (await loadCohort(rt, id))!;
    const d1 = L.days[0];
    expect(await joinDay(rt, reg, 2)).toBe('https://zoom.us/j/123'); // Day 2 is tomorrow: link works, no attendance
    expect(await joinDay(rt, reg, 1)).toBe('https://zoom.us/j/123');
    let v = (await participantView(rt, reg))!;
    expect(v.progress.days[0].live).toBe(true);
    expect(v.progress.days[1].live).toBe(false);
    // Presence: two pings 6 minutes apart during Day 1.
    const reg2 = await paidReg(db, rt, id);
    await dayFeed(rt, reg2, 1, { presence: true }, d1.starts_at - 2 * MIN);
    await dayFeed(rt, reg2, 1, { presence: true }, d1.starts_at + 4 * MIN);
    v = (await participantView(rt, reg2))!;
    expect(v.progress.days[0].live).toBe(true);
    expect(summarise([{ day: 1, joined_at: 1, present_at: null, replay_at: null, homework_at: 1 }]).attended).toBe(1);
  });

  it('stores the worksheet (editable, visible to the team), polls with real counts, VIP-only hot seat', async () => {
    const { db, rt, id } = await setup({ inMs: 10 * MIN });
    const reg = await paidReg(db, rt, id);
    expect(await submitHomework(rt, reg, 1, { revenue: '', why: '  ' })).toMatchObject({ ok: false });
    expect(await submitHomework(rt, reg, 1, { revenue: '$4.2M', ebitda: '$700k', evil: '<script>' })).toMatchObject({ ok: true });
    expect(await submitHomework(rt, reg, 3, { sources: 'x' })).toMatchObject({ ok: false, error: DAY_PAGE.locked }); // Day 3 isn't open yet
    const row = db.prepare('SELECT answers FROM challenge_homework WHERE reg_id = ? AND day = 1').get(reg.id) as { answers: string };
    expect(JSON.parse(row.answers)).toEqual({ revenue: '$4.2M', ebitda: '$700k' });
    expect((await participantView(rt, reg))!.progress.days[0].homework).toBe(true);
    const p = await answerPoll(rt, reg, 1, 'none');
    expect(p).toMatchObject({ ok: true, results: { total: 1 } });
    expect(await answerPoll(rt, reg, 1, 'maybe')).toMatchObject({ ok: false });
    expect(await askHotSeat(rt, reg, 1, 'How do I structure a 70/20/10?')).toMatchObject({ ok: false });
    const vip = await paidReg(db, rt, id, { vip: true });
    expect(await askHotSeat(rt, vip, 1, 'How do I structure a 70/20/10?')).toMatchObject({ ok: true });
  });

  it('replays: none until posted, open for everyone until the offer closes, then VIP only', async () => {
    const { db, rt, id } = await setup({ inMs: -5 * DAY });
    const reg = await paidReg(db, rt, id);
    const vip = await paidReg(db, rt, id, { vip: true });
    expect(await replayDay(rt, reg, 1)).toMatchObject({ url: null, access: 'none' });
    await updateDay(rt, id, 1, { replay_url: 'https://zoom.us/rec/share/abc' });
    const L = (await loadCohort(rt, id))!;
    const before = L.closeAt! - HOUR;
    expect(await replayDay(rt, reg, 1, before)).toMatchObject({ url: 'https://zoom.us/rec/share/abc' });
    expect(await replayDay(rt, reg, 1, L.closeAt! + 1)).toMatchObject({ url: null, access: 'closed' });
    expect(await replayDay(rt, vip, 1, L.closeAt! + 10 * DAY)).toMatchObject({ access: 'open' });
  });

  it('chat: open from 30 minutes before to 30 after, sanitised, rate limited; presence never fakes a count', async () => {
    const { db, rt, id } = await setup({ inMs: 10 * MIN });
    const reg = await paidReg(db, rt, id);
    const sent = await postDayChat(rt, reg, 1, { text: 'Hi all, call me on 0412 345 678 or see www.spam.com' });
    expect(sent).toMatchObject({ ok: true });
    expect((sent as { message: { html: string } }).message.html).not.toMatch(/0412|spam/);
    expect(await postDayChat(rt, reg, 1, { text: 'again' })).toMatchObject({ ok: false });
    expect(await postDayChat(rt, reg, 2, { text: 'too early' })).toMatchObject({ ok: false, error: DAY_PAGE.chatClosed });
    const f = await dayFeed(rt, reg, 1, { presence: true });
    expect(f).toMatchObject({ ok: true, presence: { line: null } });
  });
});

// ───────────── the offer ─────────────
describe('challenge-offer: open, close and the real deadline', () => {
  it('opens only on Days 4 and 5, closes by hand, and refuses after the deadline', async () => {
    const { db, rt, id } = await setup({ inMs: -3 * DAY - HOUR });
    expect(await setOffer(rt, `challenge:${id}:2`, true)).toMatchObject({ ok: false });
    expect((await cohortOffer(rt, id)).open).toBe(false);
    expect(await setOffer(rt, `challenge:${id}:4`, true)).toMatchObject({ ok: true, state: { open: true, day: 4 } });
    expect(await offerForKey(rt, `challenge:${id}:4`)).toMatchObject({ open: true, soft: true });
    await setOffer(rt, `challenge:${id}:5`, true);
    expect((await cohortOffer(rt, id)).day).toBe(5);
    await setOffer(rt, `challenge:${id}:4`, false);
    await setOffer(rt, `challenge:${id}:5`, false);
    expect((await cohortOffer(rt, id)).open).toBe(false);
    await setOffer(rt, `challenge:${id}:5`, true);
    const L = (await loadCohort(rt, id))!;
    const s = await cohortOffer(rt, id, L.closeAt! + 1);
    expect(s).toMatchObject({ open: false, expired: true });
    expect(await setOffer(rt, `challenge:${id}:5`, true, L.closeAt! + 1)).toMatchObject({ ok: false });
    // The deposit: refused before the offer opens or after it closes; the stub deposit module reports its error.
    const reg = await paidReg(db, rt, id);
    expect(await startChallengeDeposit(rt, reg, {}, L.closeAt! + 1)).toMatchObject({ ok: false, error: 'This offer has closed.' });
    // With the real deposit module merged, an open offer starts a deposit (a checkout link, or an error when payments aren't set up).
    const r = await startChallengeDeposit(rt, reg, {});
    expect(r.ok ? Boolean(r.next) : Boolean(r.error)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM challenge_deposits WHERE reg_id = ?').get(reg.id)).toEqual({ n: 1 });
    expect(offerStatus([], 10, 5)).toMatchObject({ open: false, everOpened: false });
  });
});

// ───────────── emails and texts ─────────────
describe('emails timing', () => {
  const tz = 'America/New_York';
  const starts = scheduleDays('2027-03-01', '19:00', tz);
  const days = starts.map((t, i) => ({ day: i + 1, starts_at: t, duration_min: 90 }));
  it('morning of, 1 hour before, live, replay nudge, VIP note; offer emails up to the real deadline', () => {
    const plan = planChallengeEmails({ days, tz, hours: 48, now: starts[0] - 3 * DAY });
    expect(localParts(plan.get('ch_d1_morning')!, tz)).toEqual({ date: '2027-03-01', time: '07:30' });
    expect(plan.get('ch_d1_hour')).toBe(starts[0] - HOUR);
    expect(plan.get('ch_d1_live')).toBe(starts[0]);
    expect(plan.get('ch_d1_after')).toBe(starts[0] + 90 * MIN + 90 * MIN);
    expect(plan.get('ch_d3_vip')).toBe(starts[2] - 2 * HOUR);
    const close = starts[4] + 90 * MIN + 48 * HOUR;
    expect(plan.get('ch_offer_1')).toBe(starts[4] + 110 * MIN);
    expect(plan.get('ch_offer_4')).toBe(close - HOUR);
    expect(Math.max(...[...plan.values()].filter((x): x is number => x != null))).toBeLessThan(close);
    // An early session gets its morning email the evening before.
    const early = scheduleDays('2027-03-01', '08:00', tz).map((t, i) => ({ day: i + 1, starts_at: t, duration_min: 60 }));
    expect(localParts(planChallengeEmails({ days: early, tz, hours: 48, now: early[0].starts_at - 3 * DAY }).get('ch_d2_morning')!, tz)).toEqual({ date: '2027-03-01', time: '19:00' });
    // A late joiner gets nothing whose moment has passed, but always the confirmation.
    const late = planChallengeEmails({ days, tz, hours: 48, now: starts[1] + HOUR });
    expect(late.get('ch_d1_live')).toBeNull();
    expect(late.get('ch_confirm')).toBe(starts[1] + HOUR);
    expect(late.get('ch_d3_live')).toBe(starts[2]);
  });

  it('runs on the existing sequence machinery; skip rules for VIP notes, homework nudges and offer emails; re-timed on edit', async () => {
    expect(SEQUENCES.challenge.steps.map((s) => s.template)).toEqual(CH_STEPS);
    expect(CH_STEPS.length).toBeLessThanOrEqual(CH_CYCLE);
    const { db, rt, id } = await setup({ inMs: 2 * DAY });
    const reg = await paidReg(db, rt, id);
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(reg.lead_id) as never;
    expect(await challengeSkip('ch_d1_vip')(rt, lead)).toBe(true);
    expect(await challengeSkip('ch_d1_morning')(rt, lead)).toBe(false);
    expect(await challengeSkip('ch_offer_1')(rt, lead)).toBe(true); // offer never opened
    db.prepare("INSERT INTO challenge_progress (reg_id, day, joined_at, homework_at) VALUES (?, 1, 1, 1)").run(reg.id);
    expect(await challengeSkip('ch_d1_after')(rt, lead)).toBe(true);
    const { startChallengeMessages } = await import('../src/challenge/emails');
    await startChallengeMessages(rt, reg.id);
    const before = (db.prepare("SELECT send_at FROM emails WHERE lead_id = ? AND template = 'ch_d2_live'").get(reg.lead_id) as { send_at: number }).send_at;
    const L = (await loadCohort(rt, id))!;
    const d2 = localParts(L.days[1].starts_at, 'America/New_York');
    const t = `${String((Number(d2.time.slice(0, 2)) + 2) % 24).padStart(2, '0')}${d2.time.slice(2)}`;
    await updateDay(rt, id, 2, { date: d2.date, time: t });
    await retimeCohort(rt, id);
    const after = (db.prepare("SELECT send_at FROM emails WHERE lead_id = ? AND template = 'ch_d2_live'").get(reg.lead_id) as { send_at: number }).send_at;
    expect(after).not.toBe(before);
    expect(db.prepare("SELECT COUNT(*) AS n FROM emails WHERE lead_id = ? AND template = 'ch_confirm'").get(reg.lead_id)).toEqual({ n: 1 });
  });

  it('texts: an hour before and at the start of each day, linking to their day page', () => {
    const s = DEFAULT_SMS_SEQUENCES.find((x) => x.id === 'challenge')!;
    expect(s.steps).toHaveLength(10);
    expect(s.steps.every((x) => x.link === 'challenge_today' && /^day[1-5]$/.test(x.anchor))).toBe(true);
    expect(auditFields(s.steps.map((x) => x.body))).toEqual([]);
  });
});

// ───────────── gating ─────────────
describe('gating', () => {
  it('nothing on the hub or day pages for an unpaid registration; deposit needs a paid ticket; the report counts paid only', async () => {
    const { db, rt, id } = await setup({ inMs: 10 * MIN });
    const { reg } = await registerChallenge(rt, visitor(), { first_name: 'Pat', email: 'pat@example.com', revenue: '3_10m', cohort_id: id });
    expect(await joinDay(rt, reg, 1)).toBeNull();
    expect(await submitHomework(rt, reg, 1, { revenue: '1' })).toMatchObject({ ok: false });
    expect(await dayFeed(rt, reg, 1, {})).toMatchObject({ ok: false });
    expect(await startChallengeDeposit(rt, reg, {})).toMatchObject({ ok: false });
    await paidReg(db, rt, id, { vip: true });
    const s = cohortStats({
      regs: [{ id: 'a', status: 'paid', vip: 1 }, { id: 'b', status: 'paid', vip: 0 }, { id: 'c', status: 'pending', vip: 0 }],
      progress: [{ reg_id: 'a', day: 1, joined_at: 1, present_at: null, replay_at: null, homework_at: 1 }, { reg_id: 'b', day: 1, joined_at: null, present_at: null, replay_at: 2, homework_at: null }],
      orders: [{ reg_id: 'a', kind: 'ticket', status: 'paid', amount: 10000, refunded_amount: 0, currency: 'usd' }, { reg_id: 'a', kind: 'vip', status: 'paid', amount: 30000, refunded_amount: 0, currency: 'usd' }, { reg_id: 'b', kind: 'ticket', status: 'paid', amount: 10000, refunded_amount: 0, currency: 'usd' }],
      deposits: [{ reg_id: 'a', paid_at: 5, amount: 500000, currency: 'usd' }],
    });
    expect(s).toMatchObject({ registered: 2, pending: 1, vip: 1, vipRate: 0.5, deposits: 1, revenue: 5500, perRegistrant: 2750 });
    expect(s.days[0]).toMatchObject({ live: 1, replay: 1, homework: 1, liveRate: 0.5 });
  });
});

// ───────────── copy ─────────────
describe('copy passes the house rules', () => {
  const noDash = (s: string) => expect(s).not.toMatch(/—/);
  it('every visible string: landing, checkout, hub, day page, offer, worksheets and polls', () => {
    const fields = { LANDING, HUB, DAY_PAGE, OFFER: { ...OFFER, deposit: OFFER.deposit('$5,000'), ticketCredit: OFFER.ticketCredit('$100'), button: OFFER.button('$5,000') }, DAYS,
      CHECKOUT: { ...CHECKOUT, ticketLede: CHECKOUT.ticketLede('$100', 'Monday 9 November'), ticketSave: CHECKOUT.ticketSave('$100'), ticketButton: CHECKOUT.ticketButton('$100'), vipCharged: CHECKOUT.vipCharged('Visa ending 4242'), vipButton: CHECKOUT.vipButton('$300'), vipForm: CHECKOUT.vipForm('$300'), vipFormSave: CHECKOUT.vipFormSave('$300') },
      pay: payCopy('ticket', '$100', 'Monday'), vipPay: payCopy('vip', '$300', 'Monday') };
    expect(auditFields(fields)).toEqual([]);
    noDash(JSON.stringify(fields));
  });

  it('every challenge email renders and passes the email audit', () => {
    const link = (p: string) => `https://apply.test${p}`;
    const ctx = { lead: {}, name: 'Dana', siteName: 'G&L', link, bookingUrl: null, whatsappUrl: null, callTime: null } as unknown as TemplateCtx;
    for (const k of CH_STEPS) {
      const e = CHALLENGE_TEMPLATES[k](ctx);
      expect(e.subject, k).toBeTruthy();
      expect(auditEmail(e), k).toEqual([]);
      noDash(JSON.stringify(e));
      expect(JSON.stringify(e)).not.toMatch(/zoom\.us/); // emails link to the day page, never the bare Zoom link
    }
  });

  it('pages render the real dates, countdown and one dominant action', () => {
    const start = Date.now() + 2 * DAY;
    const days = scheduleDays(localParts(start, 'UTC').date, '19:00', 'UTC').map((t, i) => ({ cohort_id: 'cc1', day: i + 1, starts_at: t, duration_min: 90, join_url: null, replay_url: null, hot_seat_url: null }));
    const next = { cohort: { id: 'cc1', name: 'Nov', start_date: '', start_time: '19:00', timezone: 'UTC', duration_min: 90, status: 'scheduled', created_at: 0, updated_at: 0 }, days, closeAt: null };
    const html = landingHtml({ next, now: Date.now(), ticketLabel: '$100', vipLabel: '$300', vipOn: true, turnstile: null, free: false });
    expect(html).toContain('Five days. One deal mapped out, live with Josh.');
    expect(html).toContain(`data-countdown="${days[0].starts_at}"`);
    expect(html.match(/class="chx-buy/g)).toHaveLength(2); // the hero link and the form button: the same single action
    expect(landingHtml({ next: null, now: 0, ticketLabel: '$100', vipLabel: '$300', vipOn: true, turnstile: null, free: false })).toContain(LANDING.noCohort);
    expect(timelineHtml(null, null).match(/chx-tl-i/g)).toHaveLength(5);
    const ics = challengeIcs({ origin: 'https://apply.test' } as Runtime, { id: 'r1', token: 'tok' }, days);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(5);
    expect(ics).toContain('https://apply.test/challenge/day/tok/3');
    const pv = { view: { deposit: '$5,000', cap: null, guarantee: { headline: 'Signed LOI in 90 days, or we keep working free', body: '', conditions: [], url: '/guarantee' }, credit: '$100', paid: false } };
    const offer = offerBlockHtml({ ...pv, closeAt: start, now: Date.now(), soft: false, guarantee: '', open: true, token: 't', day: 5 });
    expect(offer).toContain('Your $100 challenge ticket is credited.');
    expect(offer).toContain(`data-countdown="${start}"`);
    expect(barHtml({ closeAt: start, now: 0, open: false, deposit: '$5,000' })).toContain('hidden');
    expect(vipHtml({ label: '$300', total: null, fee: 0, card: 'Visa ending 4242', oneClick: true, token: 't', skipUrl: '/s', formUrl: '/f' })).toContain('Charged to the Visa ending 4242 you just used.');
    expect(payHtml({ copy: payCopy('ticket', '$100', 'Monday'), note: null, hostedUrl: '/h', summary: 'x', price: '$100', kind: 'ticket' })).toMatch(/data-save-note>[^<]+<\/p>\s*<button[^>]*data-ticket-pay-btn/);
    const pg = progressHtml({ days: [1, 2, 3, 4, 5].map((n) => ({ day: n, phase: 'ended', progress: { day: n, live: n < 3, replay: false, homework: n === 1 } })) as never, progress: { days: [], attended: 2, live: 2, homework: 1 } });
    expect(pg).toContain('2 of 5 sessions · 1 of 5 worksheets');
  });
});
