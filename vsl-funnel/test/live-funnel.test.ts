import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/app';
import type { VisitorCtx } from '../src/lib/identity';
import { auditEmail, auditFields } from '../src/content/copy-rules';
import {
  LIVE_STEP, type LiveMessage, POLL_PRESETS, ROOM_COPY, TAKE_QUESTIONS_PIN, dueLiveMessages, eventEnd, getLiveReg, hostAction, liveEmail, liveFeed, liveStage, liveText, offerWindow,
  processLiveMessages, pushPoll, registerLive, roomDeposit, saveEvent, ticketGate, vote,
} from '../src/live/events';
import { LANDING_COPY, WELCOME_COPY } from '../src/live/pages';
import { depositConfig, depositCopy, depositWelcomeEmail, guaranteeHtml, startDeposit } from '../src/sales/deposit';
import { GUARANTEE_BODY, GUARANTEE_CONDITIONS, GUARANTEE_HEADLINE, guarantee } from '../src/sales/guarantee';
import { payCopy } from '../src/sales/pay-page';
import { handleWhopEvent } from '../src/webinar/whop';
import { passCreditFor } from '../src/webinar/pass';
import { sprintCredit, termsHtml } from '../src/sales/contracts';

// ───────────── A real SQLite database shaped like D1, with every migration applied ─────────────

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
  // D1 batch: SELECTs return rows, writes return meta.
  return { prepare, batch: async (stmts: { sql: string; run: () => Promise<unknown>; all: () => Promise<unknown> }[]) => { const out = []; for (const s of stmts) out.push(/^\s*select/i.test(s.sql) ? await s.all() : await s.run()); return out; } };
}
function freshDb() {
  const db = new DatabaseSync(':memory:');
  const dir = `${node.cwd()}/migrations`;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(`${dir}/${f}`, 'utf8'));
  return db;
}
const pending: Promise<unknown>[] = [];
const SETTINGS: Record<string, string> = { WHOP_API_KEY: 'apik_test', WHOP_COMPANY_ID: 'biz_test', SALES_TIMEZONE: 'America/New_York', SITE_NAME: 'G&L' };
const makeRt = (db: DatabaseSync, s: Record<string, string> = SETTINGS) =>
  ({ env: { DB: d1(db) }, settings: { ...s }, reps: [], origin: 'https://apply.test', waitUntil: (p: Promise<unknown>) => { pending.push(p.catch(() => null)); } }) as unknown as Runtime;
const flush = async () => { while (pending.length) await Promise.all(pending.splice(0)); };

const MIN = 60_000, HOUR = 60 * MIN;
const visitor = (o: Partial<VisitorCtx> = {}): VisitorCtx => ({
  visitorId: 'v1', sessionId: 's1', leadId: null, isNewVisitor: true, isNewSession: true, isBot: false, botReason: null, variant: 'a',
  ua: { device: 'desktop', browser: 'x', os: 'y' } as never, userAgent: 'test', geo: { country: 'US', city: null, timezone: 'America/New_York' } as never, ip: '1.2.3.4', touch: null, fbp: null, fbc: null, marketingConsent: false, consentRequired: false, ...o,
});

interface Call { method: string; path: string; body: Record<string, unknown> | null }
function stubWhop(o: { create?: { status: number; message: string }; status?: string } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { method?: string; body?: string } = {}) => {
    const u = String(url);
    const path = u.replace('https://api.whop.com/api/v1/', '');
    calls.push({ method: init.method ?? 'GET', path, body: init.body ? JSON.parse(init.body) : null });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (!u.startsWith('https://api.whop.com/')) return json(200, { ok: true });
    if (path === 'payments' && init.method === 'POST') return o.create ? json(o.create.status, { error: { message: o.create.message } }) : json(201, { id: 'pay_dep1', status: 'open' });
    if (/^payments\/[^/]+\/status$/.test(path)) return json(200, { status: o.status ?? 'succeeded', next_action: null, last_payment_error: o.status === 'canceled' ? { code: 'card_declined' } : null });
    if (path.startsWith('payments/')) return json(200, {});
    return json(404, { error: { message: 'not stubbed' } });
  }));
  return calls;
}
afterEach(() => { vi.unstubAllGlobals(); pending.length = 0; });

async function seedEvent(_db: DatabaseSync, rt: Runtime, startsIn = -20 * MIN) {
  const r = await saveEvent(rt, { title: 'Buy your first competitor', starts_at: Date.now() + startsIn, tz: 'America/New_York', duration_min: 120, join_url: 'https://zoom.us/j/123' });
  if (!r.ok) throw new Error(r.error);
  return r.id;
}
async function seedReg(_db: DatabaseSync, rt: Runtime, eventId: string, o: { revenue?: string; email?: string } = {}) {
  const { reg } = await registerLive(rt, visitor(), { first_name: 'Dana', email: o.email ?? 'dana@example.com', revenue: o.revenue ?? '3_10m', event_id: eventId });
  await flush();
  return reg;
}

// ───────────── copy ─────────────

describe('the deposit offer, the guarantee and every live string', () => {
  const rt = { settings: {}, origin: 'https://apply.test' } as unknown as Runtime;
  it('the deposit config defaults to $5,000 USD with no cap, and reads its settings', () => {
    expect(depositConfig(rt)).toMatchObject({ amount: 5000, currency: 'USD', label: '$5,000', cap: null });
    expect(depositConfig({ ...rt, settings: { ENGAGEMENT_DEPOSIT: '7500', ENGAGEMENT_INTAKE_CAP: '6' } } as never)).toMatchObject({ amount: 7500, cap: 6, label: '$7,500' });
    expect(depositConfig(rt).guarantee).toEqual({ headline: GUARANTEE_HEADLINE, body: GUARANTEE_BODY, conditions: GUARANTEE_CONDITIONS, url: 'https://apply.test/guarantee' });
  });
  it('the guarantee is worded exactly as approved, with every condition and the link', () => {
    expect(GUARANTEE_HEADLINE).toBe('Signed LOI in 90 days, or we keep working free');
    expect(GUARANTEE_BODY).toBe('If you don’t have a signed letter of intent within 90 days, Josh’s team keeps working with you at no extra cost until you do. Or, if you prefer, take a full refund of everything you paid.');
    const h = guaranteeHtml(rt);
    for (const c of GUARANTEE_CONDITIONS) expect(h).toContain(c.replace(/’/g, '’'));
    expect(h).toContain('href="https://apply.test/guarantee"');
    expect(h).toContain('non-binding LOI');
    expect(h).not.toMatch(/legal review/i); // marked in Funnel HQ only
    expect(guarantee({ ...rt, settings: { GUARANTEE_CONDITIONS: 'One\nTwo' } } as never).conditions).toEqual(['One', 'Two']);
  });
  it('every visible string passes the house copy rules (no free call, no hedges, no exclamation marks or em dashes)', () => {
    const cfg = depositConfig(rt);
    const dc = depositCopy({ ...cfg, cap: 6 }, { left: 2 });
    const strings = {
      landing: { ...LANDING_COPY, ticketButton: LANDING_COPY.ticketButton('$100'), ticketLine: LANDING_COPY.ticketLine('$100') }, room: ROOM_COPY,
      welcome: { ...WELCOME_COPY, heading: WELCOME_COPY.heading('Dana'), receipt: WELCOME_COPY.receipt('$5,000', '$5,000') },
      deposit: { ...dc, oneClickCharged: dc.oneClickCharged('Visa ending 4242'), oneClickConfirm: dc.oneClickConfirm('$5,000') },
      pay: [payCopy('deposit', '$4,900', '$5,000 less your $100 ticket'), payCopy('live_ticket', '$100')], guarantee: guarantee(rt), take: TAKE_QUESTIONS_PIN,
    };
    expect(auditFields(strings)).toEqual([]);
    const all = JSON.stringify(strings);
    expect(all).not.toMatch(/[!—]/);
    expect(dc.capLine).toBe('2 of 6 places left in this week’s intake.');
    expect(depositCopy(cfg).capLine).toBeNull(); // no cap set: no count shown
    expect(all).toContain('seller rollover'); // funding is named with seller rollover
  });
  it('every live email and text passes the email rules and points at the room, never the bare Zoom link', () => {
    const kinds: LiveMessage[] = ['confirm', 'ticket', 'r24h', 'r1h', 'r10m', 'live', 'replay', 'replay_last'];
    for (const attended of [true, false]) for (const k of kinds) {
      const m = liveEmail(k, { name: 'Dana', title: 'Buy your first competitor', when: 'Monday 2 November at 7:00 pm EST', room: 'https://live.test/live/room/tok', ticket: 'https://live.test/live/ticket/tok', ticketLabel: '$100', attended, offerOpened: !attended, closes: 'Wednesday 4 November at 9:00 pm EST', replay: attended, deposit: '$5,000' });
      expect(auditEmail({ subject: m.subject, preheader: m.preheader, body: m.paras }), `${k}`).toEqual([]);
      expect(JSON.stringify(m)).not.toMatch(/[!—]|zoom\.us/);
      expect(m.button.href).toMatch(/live\.test\/live\/(room|ticket)/);
    }
    for (const k of kinds) { const t = liveText(k, { title: 'X', when: 'Monday', site: 'G&L' }); if (t) expect(t).not.toMatch(/[!—]/); }
    const w = depositWelcomeEmail({ name: 'Dana', amount: '$5,000', onboardingUrl: 'https://calendly.com/x', welcomeUrl: 'https://live.test/w', guaranteeUrl: 'https://apply.test/guarantee', headline: GUARANTEE_HEADLINE });
    expect(auditEmail({ subject: w.subject, preheader: w.preheader, body: w.paras })).toEqual([]);
  });
  it('the engagement agreement carries the guarantee and its conditions', () => {
    const html = termsHtml(rt, { title: 'Advisory Engagement Agreement', client_name: 'Dana', client_email: null, client_company: null, fee: 50_000, currency: 'USD', payment_terms: null, success_fee: null, scope: null, term_text: '90 days', credit_amount: 5000, credit_label: 'Engagement deposit credit' });
    expect(html).toContain('Guarantee: Signed LOI in 90 days');
    expect(html).toContain('Engagement deposit credit: <strong>−$5,000 USD</strong>');
  });
});

// ───────────── the offer window ─────────────

describe('the host-opened offer and its real deadline', () => {
  const ev = { starts_at: 1_000_000_000_000, duration_min: 120, ended_at: null, offer_opened_at: null as number | null, offer_closed_at: null as number | null, offer_hours: null as number | null, status: 'scheduled' as const };
  it('is not open until the host opens it, then closes 48 hours after the end (the replay with it)', () => {
    const t = ev.starts_at + 60 * MIN;
    expect(offerWindow(ev, t).open).toBe(false);
    const opened = { ...ev, offer_opened_at: t, offer_hours: 48 };
    const w = offerWindow(opened, t);
    expect(w.open).toBe(true);
    expect(w.closesAt).toBe(eventEnd(ev) + 48 * HOUR);
    expect(offerWindow(opened, w.closesAt - 1).open).toBe(true);
    expect(offerWindow(opened, w.closesAt).open).toBe(false);
    expect(liveStage(opened, w.closesAt - 1)).toBe('replay');
    expect(liveStage(opened, w.closesAt)).toBe('closed');
  });
  it('Close offer closes it at once; ending early moves the deadline earlier', () => {
    const t = ev.starts_at + 60 * MIN;
    expect(offerWindow({ ...ev, offer_opened_at: t, offer_closed_at: t + MIN, offer_hours: 48 }, t + 2 * MIN).open).toBe(false);
    expect(offerWindow({ ...ev, offer_opened_at: t, ended_at: t + 30 * MIN, offer_hours: 48 }, t).closesAt).toBe(t + 30 * MIN + 48 * HOUR);
  });

  let db: DatabaseSync; let rt: Runtime;
  beforeEach(() => { db = freshDb(); rt = makeRt(db); });
  it('open and close reach every room (late joiners included), a closed offer stays closed, and the server refuses a deposit outside the window', async () => {
    stubWhop();
    const id = await seedEvent(db, rt);
    const reg = await seedReg(db, rt, id);
    const before = await liveFeed(rt, reg, { presence: true });
    expect((before as { offer: { open: boolean } }).offer.open).toBe(false);
    expect((await roomDeposit(rt, reg, {})).error).toBe('This offer has closed.');
    expect((await hostAction(rt, id, { action: 'open_offer' })).ok).toBe(true);
    const late = await seedReg(db, rt, id, { email: 'late@example.com' });
    const f = await liveFeed(rt, late, {}) as { offer: { open: boolean; closesAt: number } };
    expect(f.offer.open).toBe(true);
    expect(f.offer.closesAt).toBeGreaterThan(Date.now() + 47 * HOUR);
    await hostAction(rt, id, { action: 'timer_on' });
    await hostAction(rt, id, { action: 'pin', text: 'Go back to the room tab: the button is there now.' });
    const f2 = await liveFeed(rt, reg, {}) as { timer: unknown; pinned: string };
    expect(f2.timer).toBeTruthy();
    expect(f2.pinned).toContain('Go back to the room tab');
    expect((await hostAction(rt, id, { action: 'close_offer' })).ok).toBe(true);
    expect(((await liveFeed(rt, reg, {})) as { offer: { open: boolean } }).offer.open).toBe(false);
    expect((await roomDeposit(rt, reg, {})).error).toBe('This offer has closed.');
    const again = await hostAction(rt, id, { action: 'open_offer' });
    expect(again.ok).toBe(false);
  });
  it('under-$1M viewers get the worksheet path, not the deposit', async () => {
    const id = await seedEvent(db, rt);
    const reg = await seedReg(db, rt, id, { revenue: 'lt1m', email: 'small@example.com' });
    await hostAction(rt, id, { action: 'open_offer' });
    expect((await roomDeposit(rt, reg, {})).error).toContain('$1M or more');
    expect(((await liveFeed(rt, reg, {})) as { qualified: boolean }).qualified).toBe(false);
  });
  it('the script polls push to every room; the buy-in sentence is saved', async () => {
    const id = await seedEvent(db, rt);
    const reg = await seedReg(db, rt, id);
    expect(POLL_PRESETS).toEqual(['target_type', 'timeline', 'blocker', 'own_cash', 'buy_in']);
    const p = await pushPoll(rt, id, { preset: 'timeline' });
    const f = await liveFeed(rt, reg, {}) as { poll: { id: string; question: string; options: string[] } };
    expect(f.poll.question).toBe('When would you want your first deal closed?');
    expect(f.poll.options).toContain('Just learning');
    const v = await vote(rt, reg, { poll: p.ok ? p.id : '', choice: 0 });
    expect(v).toMatchObject({ ok: true, results: { counts: [1, 0, 0, 0], total: 1 } });
    const b = await pushPoll(rt, id, { preset: 'buy_in' });
    const fb = await liveFeed(rt, reg, {}) as { poll: { buyin: boolean } };
    expect(fb.poll.buyin).toBe(true);
    expect(await vote(rt, reg, { poll: b.ok ? b.id : '', text: 'A business that runs without me' })).toMatchObject({ ok: true });
  });
});

// ───────────── registration, reminders and room auth ─────────────

describe('registration and reminders', () => {
  let db: DatabaseSync; let rt: Runtime;
  beforeEach(() => { db = freshDb(); rt = makeRt(db); });
  it('registers once per event, sends the confirmation at once, and the 24h / 1h / 10 min / live reminders at their moments', async () => {
    const id = await seedEvent(db, rt, 2 * 24 * HOUR);
    const reg = await seedReg(db, rt, id);
    const emails = () => db.prepare("SELECT step, template, status FROM emails WHERE sequence = 'live' ORDER BY step").all() as { step: number; template: string; status: string }[];
    expect(emails()).toEqual([{ step: LIVE_STEP.confirm, template: 'live_confirm', status: 'simulated' }]);
    await expect(registerLive(rt, visitor({ leadId: null, visitorId: 'v2' }), { first_name: 'X', email: 'dana@example.com', revenue: '3_10m', event_id: id })).rejects.toThrow(/already registered/);
    const ev = db.prepare('SELECT * FROM live_webinars WHERE id = ?').get(id) as { starts_at: number };
    const start = ev.starts_at;
    const evRow = { starts_at: start, duration_min: 120, ended_at: null, offer_opened_at: null, offer_closed_at: null, offer_hours: null, status: 'scheduled' as const };
    const r = { created_at: reg.created_at, joined_at: null, seq: 0 };
    const at = (t: number) => dueLiveMessages(evRow, r, { now: t, ticketUnpaid: false, deposit: false });
    expect(at(start - 24 * HOUR + MIN)).toContain('r24h');
    expect(at(start - HOUR + MIN)).toContain('r1h');
    expect(at(start - 10 * MIN + 1000)).toContain('r10m');
    expect(at(start + MIN)).toContain('live');
    expect(dueLiveMessages(evRow, { ...r, joined_at: start }, { now: start + MIN, ticketUnpaid: false, deposit: false })).not.toContain('live');
    expect(at(start + 150 * MIN)).toContain('replay');
    // Registered 30 minutes before: no 24-hour or 1-hour reminder.
    expect(dueLiveMessages(evRow, { ...r, created_at: start - 30 * MIN }, { now: start - HOUR + MIN, ticketUnpaid: false, deposit: false })).not.toContain('r1h');
    // A deposit buyer gets no replay push; an unpaid ticket only the finish-your-ticket email.
    expect(dueLiveMessages(evRow, r, { now: start + 150 * MIN, ticketUnpaid: false, deposit: true })).not.toContain('replay');
    expect(dueLiveMessages(evRow, r, { now: start - 23 * HOUR, ticketUnpaid: true, deposit: false })).toEqual(['ticket']);
    // The cron sends each once.
    vi.useFakeTimers({ now: start - 24 * HOUR + MIN, toFake: ['Date'] });
    await processLiveMessages(rt, Date.now());
    await processLiveMessages(rt, Date.now());
    vi.useRealTimers();
    expect(emails().map((e) => e.template)).toEqual(['live_confirm', 'live_r24h']);
  });
  it('the room link is the only key: unknown tokens find nothing, and a required ticket gates the room', async () => {
    expect(await getLiveReg(rt, 'not-a-token')).toBeNull();
    expect(await getLiveReg(rt, 'abcdefghijklmnopqrstu')).toBeNull();
    const paid = makeRt(db, { ...SETTINGS, LIVE_TICKET_PRICE: '100' });
    const id = await seedEvent(db, paid, 2 * HOUR);
    const reg = await seedReg(db, paid, id);
    expect(reg.ticket_required).toBe(1);
    expect(await ticketGate(paid, reg)).toBe(true);
    db.prepare("INSERT INTO webinar_passes (id, reg_id, lead_id, kind, status, amount, currency, source, ref_id, created_at, updated_at) VALUES ('t1', ?, ?, 'live_ticket', 'paid', 10000, 'usd', 'live', ?, 1, 1)").run(reg.id, reg.lead_id, id);
    expect(await ticketGate(paid, reg)).toBe(false);
  });
});

// ───────────── startDeposit, the webhook and the credit ─────────────

describe('startDeposit', () => {
  let db: DatabaseSync; let rt: Runtime;
  beforeEach(() => { db = freshDb(); rt = makeRt(db); });
  const lead = (db: DatabaseSync) => db.prepare("INSERT INTO leads (id, ref_code, created_at, updated_at, first_name, email, status, revenue_band) VALUES ('l1', 'R1', 1, 1, 'Dana', 'dana@example.com', 'partial', '3m-10m')").run();
  const card = (db: DatabaseSync) => db.prepare("INSERT INTO webinar_passes (id, reg_id, lead_id, kind, status, amount, currency, paid_at, provider, whop_member_id, whop_payment_method_id, card_brand, card_last4, source, ref_id, created_at, updated_at) VALUES ('tk', 'r', 'l1', 'live_ticket', 'paid', 10000, 'usd', 1, 'whop', 'mber_1', 'payt_1', 'visa', '4242', 'live', 'le1', 1, 1)").run();
  const dep = (db: DatabaseSync) => db.prepare("SELECT * FROM webinar_passes WHERE kind = 'deposit' ORDER BY created_at DESC LIMIT 1").get() as Record<string, unknown>;
  const base = { leadId: 'l1', source: 'live' as const, refId: 'le1', regToken: 'tok', returnUrl: 'https://live.test/live/welcome/tok' };

  it('one click charges the saved ticket card (minus the ticket), marks it paid, credits the full deposit and drafts the agreement', async () => {
    lead(db); card(db);
    const calls = stubWhop();
    const r = await startDeposit(rt, { ...base, oneClick: true }, { sleep: async () => {} });
    await flush();
    expect(r).toEqual({ paid: true, url: base.returnUrl });
    const create = calls.find((c) => c.method === 'POST' && c.path === 'payments')!;
    expect(create.body).toMatchObject({ member_id: 'mber_1', payment_method_id: 'payt_1', off_session: false, metadata: { kind: 'deposit', source: 'live', ref_id: 'le1' } });
    expect((create.body!.variant as { initial_price: number }).initial_price).toBe(4900);
    expect(dep(db)).toMatchObject({ status: 'paid', amount: 490000, ticket_credit: 10000, credit_amount: 500000, one_click: 1, source: 'live' });
    const credit = await passCreditFor(rt, 'l1');
    expect(credit).toMatchObject({ amount: 500000, product: 'Engagement deposit' });
    const k = db.prepare("SELECT * FROM contracts WHERE lead_id = 'l1'").get() as Record<string, unknown>;
    expect(k).toMatchObject({ status: 'draft', fee: 50_000, credit_amount: 5000, credit_label: 'Engagement deposit credit', term_text: '90 days from the date both parties sign' });
    expect(db.prepare("SELECT template FROM emails WHERE sequence = 'deposit'").all()).toEqual([{ template: 'deposit_welcome' }]);
    // Already paid: no second charge.
    expect(await startDeposit(rt, { ...base, oneClick: true })).toEqual({ paid: true, url: base.returnUrl });
  });
  it('without a saved card (or when the card is declined) it opens our Whop payment page', async () => {
    lead(db);
    stubWhop();
    const r = await startDeposit(rt, { ...base, oneClick: true });
    expect(r.url).toMatch(/^https:\/\/apply\.test\/pay\/wp[0-9a-z]+\.[0-9a-f]{24}$/);
    expect(dep(db)).toMatchObject({ status: 'pending', amount: 500000, embedded: 1, return_url: base.returnUrl });
    card(db);
    stubWhop({ status: 'canceled' });
    const d = await startDeposit(rt, { ...base, oneClick: true }, { sleep: async () => {} });
    expect(d.url).toMatch(/\/pay\//);
  });
  it('errors without charging: no payment provider, or the weekly intake is full', async () => {
    lead(db);
    expect((await startDeposit(makeRt(db, {}), base)).error).toMatch(/Payments aren’t connected/);
    const capped = makeRt(db, { ...SETTINGS, ENGAGEMENT_INTAKE_CAP: '1' });
    db.prepare("INSERT INTO leads (id, ref_code, created_at, updated_at, email, status) VALUES ('l2', 'R2', 1, 1, 'x@example.com', 'partial')").run();
    db.prepare("INSERT INTO webinar_passes (id, reg_id, lead_id, kind, status, amount, currency, paid_at, created_at, updated_at) VALUES ('d2', 'r2', 'l2', 'deposit', 'paid', 500000, 'usd', ?, 1, 1)").run(Date.now());
    expect((await startDeposit(capped, base)).error).toMatch(/intake is full/);
  });
  it('the Whop webhook marks a page payment paid once, and a refund removes the credit', async () => {
    lead(db);
    stubWhop();
    await startDeposit(rt, base);
    const row = dep(db);
    const ev = { type: 'payment.succeeded', data: { id: 'pay_web1', status: 'paid', total: 5000, currency: 'usd', metadata: { pass_id: row.id, kind: 'deposit' } } };
    expect(await handleWhopEvent(rt, ev)).toMatchObject({ paid: row.id, duplicate: false });
    expect(await handleWhopEvent(rt, ev)).toMatchObject({ duplicate: true });
    await flush();
    expect(dep(db)).toMatchObject({ status: 'paid', credit_amount: 500000 });
    expect(await sprintCredit(rt, 'l1', 'USD')).toMatchObject({ amount: 5000 });
    await handleWhopEvent(rt, { type: 'refund.created', data: { status: 'succeeded', amount: 5000, payment: { id: 'pay_web1', refunded_amount: 5000 } } });
    await flush();
    expect(dep(db)).toMatchObject({ status: 'refunded', credit_amount: 0 });
    expect(await passCreditFor(rt, 'l1')).toBeNull();
  });
});
