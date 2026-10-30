import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv, Runtime } from '../src/app';
import { auditFields } from '../src/content/copy-rules';
import { type PassRow, confirmOnReturn } from '../src/webinar/pass';
import { WHOP_NATIVE_VERSION, handleWhopEvent, whopHealth } from '../src/webinar/whop';
import { buyerFeePercent, cardLabel, oneClickCopy, oneClickInfo, oneClickQuote, oneClickSprint, recentFailedOneClick } from '../src/webinar/one-click';
import { portalHtml, samplePortal } from '../src/webinar/deal-sprint';
import { passConfig } from '../src/webinar/pass';
import { api } from '../src/routes/api';
import type { Registration } from '../src/webinar/webinar';

// ───────────── A real SQLite database shaped like D1, with every migration applied (as in whop.test.ts) ─────────────

interface Stmt { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): { changes: number | bigint } }
interface DatabaseSync { prepare(sql: string): Stmt; exec(sql: string): void }
const node = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown; cwd(): string } }).process;
const { DatabaseSync } = node.getBuiltinModule('node:sqlite') as { DatabaseSync: new (path: string) => DatabaseSync };
const fs = node.getBuiltinModule('node:fs') as { readdirSync(p: string): string[]; readFileSync(p: string, enc: string): string };

function d1(db: DatabaseSync) {
  const prepare = (sql: string) => {
    let args: unknown[] = [];
    const norm = () => args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? Number(a) : a)) as (string | number | null)[];
    const st = {
      bind: (...a: unknown[]) => { args = a; return st; },
      first: async <T>() => (db.prepare(sql).get(...norm()) as T | undefined) ?? null,
      all: async <T>() => ({ results: db.prepare(sql).all(...norm()) as T[] }),
      run: async () => { const r = db.prepare(sql).run(...norm()); return { meta: { changes: Number(r.changes) } }; },
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

const WHOP = {
  WEBINAR_PASS: 'required', WEBINAR_SEAT_PRICE: '100', WHOP_API_KEY: 'apik_test', WHOP_WEBHOOK_SECRET: 'ws_test', WHOP_COMPANY_ID: 'biz_test', SALES_TIMEZONE: 'Australia/Sydney',
  WEBINAR_DURATION_MIN: '60', WEBINAR_REPLAY_HOURS: '48', WEBINAR_PITCH_AT: '38', SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x',
};
const pending: Promise<unknown>[] = [];
const makeRt = (db: DatabaseSync, settings: Record<string, string> = WHOP) =>
  ({ env: { DB: d1(db) }, settings: { ...settings }, reps: [], origin: 'https://apply.test', waitUntil: (p: Promise<unknown>) => { pending.push(p); } }) as unknown as Runtime;

const MIN = 60_000, HOUR = 60 * MIN;
const TOKEN = 'tokentokentoken12345';
const WELCOME = `https://apply.test/webinar/sprint/${TOKEN}?welcome=1`;
const START_URL = `https://apply.test/webinar/sprint-start/${TOKEN}`;
let START = 0;
function seed(db: DatabaseSync, o: { band?: string; startedAgoMin?: number; unlocked?: boolean; ticket?: 'saved' | 'plain' | 'none' | 'refunded' } = {}) {
  const now = Date.now();
  START = now - (o.startedAgoMin ?? 45) * MIN;
  db.prepare("INSERT INTO leads (id, ref_code, created_at, updated_at, first_name, last_name, email, status, revenue_band, webinar_token) VALUES ('l1', 'R1', ?, ?, 'Dana', 'Lee', 'dana@example.com', 'partial', ?, ?)").run(now, now, o.band ?? '3m-10m', TOKEN);
  db.prepare("INSERT INTO webinar_sessions (id, starts_at, mode, status, auto, created_at) VALUES ('s1', ?, 'evergreen', 'scheduled', 1, ?)").run(START, now);
  db.prepare("INSERT INTO webinar_registrations (id, token, session_id, lead_id, created_at, revenue_band) VALUES ('r1', ?, 's1', 'l1', ?, ?)").run(TOKEN, now, o.band ?? '3m-10m');
  if (o.unlocked !== false) db.prepare("UPDATE webinar_registrations SET offer_unlocked_at = ? WHERE id = 'r1'").run(START + 38 * MIN);
  const t = o.ticket ?? 'saved';
  if (t !== 'none') {
    db.prepare(`INSERT INTO webinar_passes (id, reg_id, lead_id, kind, product, status, amount, currency, paid_at, provider, stripe_session_id, stripe_payment_intent, whop_member_id, whop_payment_method_id, card_brand, card_last4, created_at, updated_at)
      VALUES ('t1', 'r1', 'l1', 'seat', 'Masterclass ticket', ?, 10000, 'usd', ?, 'whop', 'ch_t', 'pay_t', ?, ?, 'visa', '4242', ?, ?)`)
      .run(t === 'refunded' ? 'refunded' : 'paid', now - HOUR, t === 'plain' ? null : 'mber_1', t === 'plain' ? null : 'payt_1', now - HOUR, now - HOUR);
  }
}
const reg = (db: DatabaseSync) => db.prepare("SELECT * FROM webinar_registrations WHERE id = 'r1'").get() as Registration & { offer_unlocked_at: number | null };
const offer = (db: DatabaseSync) => db.prepare("SELECT * FROM webinar_passes WHERE kind = 'offer' ORDER BY created_at DESC LIMIT 1").get() as PassRow & Record<string, unknown>;
const offers = (db: DatabaseSync) => db.prepare("SELECT * FROM webinar_passes WHERE kind = 'offer'").all() as (PassRow & Record<string, unknown>)[];

interface Call { method: string; url: string; path: string; headers: Record<string, string>; body: Record<string, unknown> | null }
function stubWhop(o: { create?: { status: number; message: string }; statuses?: Record<string, unknown>[]; payment?: Record<string, unknown>; quoteTax?: number; createDelay?: number } = {}) {
  const calls: Call[] = [];
  let s = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const u = String(url);
    const path = u.replace('https://api.whop.com/api/v1/', '');
    calls.push({ method: init.method ?? 'GET', url: u, path, headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (!u.startsWith('https://api.whop.com/')) return json(200, { ok: true });
    if (path === 'accounts/me') return json(200, { id: 'biz_test' });
    if (path === 'payments' && init.method === 'POST') {
      if (o.createDelay) await new Promise((r) => setTimeout(r, o.createDelay));
      return o.create ? json(o.create.status, { error: { message: o.create.message } }) : json(201, { id: 'pay_oc1', status: 'open' });
    }
    if (/^payments\/[^/]+\/status$/.test(path)) {
      const list = o.statuses ?? [{ status: 'succeeded', next_action: null, last_payment_error: null }];
      return json(200, list[Math.min(s++, list.length - 1)]);
    }
    if (path.startsWith('payments/')) return json(200, o.payment ?? {});
    if (path === 'payment_quotes') return json(200, { id: 'pq_1', tax_amount: { amount: String(o.quoteTax ?? 0), currency: 'usd' }, tax_behavior: o.quoteTax ? 'exclusive' : null });
    return json(404, { error: { message: 'not stubbed' } });
  }));
  return calls;
}
const noSleep = async () => {};
afterEach(() => { vi.unstubAllGlobals(); pending.length = 0; });

// ───────────── The ticket payment leaves a saved method ─────────────

describe('stored payment method from the ticket', () => {
  let db: DatabaseSync; let rt: Runtime;
  beforeEach(() => {
    db = freshDb(); seed(db, { ticket: 'none' }); rt = makeRt(db);
    db.prepare("INSERT INTO webinar_passes (id, reg_id, lead_id, kind, status, amount, currency, stripe_session_id, provider, created_at, updated_at) VALUES ('t2', 'r1', 'l1', 'seat', 'pending', 10000, 'usd', 'ch_t2', 'whop', 1, 1)").run();
  });

  it('from the webhook payload (member, payment method and card, as the pinned API sends them)', async () => {
    stubWhop();
    await handleWhopEvent(rt, { type: 'payment.succeeded', data: { id: 'pay_t2', status: 'paid', total: 100, currency: 'usd', checkout_configuration_id: 'ch_t2', metadata: { pass_id: 't2', kind: 'seat', reg_id: 'r1' }, member: { id: 'mber_9' }, payment_method: { id: 'payt_9', card: { brand: 'visa', last4: '4242' } } } }, async () => {});
    expect(db.prepare("SELECT status, whop_member_id, whop_payment_method_id, card_brand, card_last4 FROM webinar_passes WHERE id = 't2'").get()).toEqual({ status: 'paid', whop_member_id: 'mber_9', whop_payment_method_id: 'payt_9', card_brand: 'visa', card_last4: '4242' });
    expect(await oneClickInfo(rt, { lead_id: 'l1' })).toMatchObject({ card: 'Visa ending 4242' });
  });

  it('falls back to Retrieve payment when the event leaves them out', async () => {
    const calls = stubWhop({ payment: { id: 'pay_t2', member_id: 'mber_8', payment_method_id: 'payt_8', payment_instrument: { card: { brand: 'mastercard', last4: '4066' } } } });
    await handleWhopEvent(rt, { type: 'payment.succeeded', data: { id: 'pay_t2', status: 'paid', total: 100, currency: 'usd', checkout_configuration_id: 'ch_t2', metadata: { pass_id: 't2', kind: 'seat' } } }, async () => {});
    expect(calls.some((c) => c.path === 'payments/pay_t2')).toBe(true);
    expect(db.prepare("SELECT whop_member_id, whop_payment_method_id, card_brand, card_last4 FROM webinar_passes WHERE id = 't2'").get()).toEqual({ whop_member_id: 'mber_8', whop_payment_method_id: 'payt_8', card_brand: 'mastercard', card_last4: '4066' });
  });

  it('no one click without a saved method, after a refund, or with Stripe', async () => {
    expect(await oneClickInfo(rt, { lead_id: 'l1' })).toBeNull();
    const db2 = freshDb(); seed(db2, { ticket: 'refunded' });
    expect(await oneClickInfo(makeRt(db2), { lead_id: 'l1' })).toBeNull();
    const db3 = freshDb(); seed(db3);
    expect(await oneClickInfo(makeRt(db3), { lead_id: 'l1' })).toMatchObject({ card: 'Visa ending 4242' });
    expect(await oneClickInfo(makeRt(db3, { ...WHOP, WHOP_API_KEY: '', STRIPE_SECRET_KEY: 'sk' }), { lead_id: 'l1' })).toBeNull();
  });

  it('names cards plainly', () => {
    expect(cardLabel('visa', '4242')).toBe('Visa ending 4242');
    expect(cardLabel('amex', '0005')).toBe('American Express ending 0005');
    expect(cardLabel(null, null)).toBeNull();
    expect(oneClickCopy({ card: null }).charged).toBe('Charged to the payment method you used for your ticket.');
  });
});

// ───────────── The confirm step ─────────────

describe('one-click confirm step', () => {
  it('shows the price after the ticket credit, Whop’s service fee and the true total, on the ticket’s card', async () => {
    const db = freshDb(); seed(db);
    stubWhop();
    const q = await oneClickQuote(makeRt(db), reg(db), { ip: '203.0.113.9' });
    expect(q).toMatchObject({ paid: false, card: 'Visa ending 4242', total: '$3,045' });
    if (q.paid || !('lines' in q)) throw new Error('expected lines');
    expect(q.lines).toEqual([{ label: 'First Deal Sprint ($3,000 less your $100 ticket)', amount: '$2,900' }, { label: 'Whop service fee (5%)', amount: '$145' }]);
    expect(q.copy!.confirmButton).toBe('Confirm and pay $3,045');
    expect(q.copy!.charged).toBe('Charged to the Visa ending 4242 you used for your ticket.');
    const none = await oneClickQuote(makeRt(db, { ...WHOP, WHOP_BUYER_FEE_PERCENT: '0' }), reg(db));
    expect(none).toMatchObject({ total: '$2,900' });
    expect(buyerFeePercent({})).toBe(5);
  });

  it('adds tax when a payment quote finds some', async () => {
    const db = freshDb(); seed(db);
    const calls = stubWhop({ quoteTax: 232 });
    const q = await oneClickQuote(makeRt(db), reg(db), { ip: '203.0.113.9' });
    expect(q).toMatchObject({ total: '$3,288.60' });
    expect(calls.find((c) => c.path === 'payment_quotes')!.headers['api-version-date']).toBe(WHOP_NATIVE_VERSION);
  });

  it('copy passes the house rules', () => {
    expect(auditFields(oneClickCopy({ card: 'Visa ending 4242', total: '$3,045' }))).toEqual([]);
  });
});

// ───────────── The charge ─────────────

describe('one-click charge', () => {
  let db: DatabaseSync; let rt: Runtime;
  beforeEach(() => { db = freshDb(); seed(db); rt = makeRt(db); });

  it('charges the ticket’s card for the Sprint, marks it paid, and goes to the Sprint page; the webhook is a duplicate', async () => {
    const calls = stubWhop();
    const effects = vi.fn(async () => {});
    const r = await oneClickSprint(rt, reg(db), { effects, sleep: noSleep });
    expect(r).toEqual({ ok: true, next: WELCOME, outcome: 'paid' });
    const create = calls.find((c) => c.method === 'POST' && c.path === 'payments')!;
    expect(create.headers['api-version-date']).toBe(WHOP_NATIVE_VERSION);
    expect(create.headers['idempotency-key']).toBe(`sprint_one_click_${offer(db).id}`);
    expect(create.body).toMatchObject({
      account_id: 'biz_test', member_id: 'mber_1', payment_method_id: 'payt_1', off_session: false, return_url: `${WELCOME}&one_click=1`,
      variant: { currency: 'usd', billing_type: 'one_time', initial_price: 2900, title: 'First Deal Sprint', visibility: 'hidden', product: { external_identifier: 'vsl-funnel-first-deal-sprint' } },
      metadata: { pass_id: offer(db).id, reg_id: 'r1', reg_token: TOKEN, lead_id: 'l1', kind: 'offer', one_click: '1', fast_bonus: '1' },
    });
    expect(offer(db)).toMatchObject({ status: 'paid', one_click: 1, amount: 290000, ticket_credit: 10000, credit_amount: 300000, stripe_payment_intent: 'pay_oc1', stripe_session_id: 'whop_pay_oc1' });
    expect(effects).toHaveBeenCalledTimes(1);
    const tracked = (db.prepare("SELECT props FROM events WHERE name = 'webinar_offer_one_click'").all() as { props: string }[]).map((e) => JSON.parse(e.props).outcome);
    expect(tracked).toEqual(['started', 'paid']);
    expect(await handleWhopEvent(rt, { type: 'payment.succeeded', data: { id: 'pay_oc1', status: 'paid', total: 2900, currency: 'usd', metadata: { pass_id: offer(db).id, kind: 'offer' } } }, effects)).toMatchObject({ duplicate: true });
    expect(effects).toHaveBeenCalledTimes(1);
  });

  it('a double click never charges twice', async () => {
    const calls = stubWhop({ statuses: [{ status: 'processing' }], createDelay: 20 });
    const [a, b] = await Promise.all([oneClickSprint(rt, reg(db), { sleep: noSleep, tries: 1 }), oneClickSprint(rt, reg(db), { sleep: noSleep, tries: 1 })]);
    expect([a.outcome, b.outcome].sort()).toEqual(['in_flight', 'pending']);
    expect(calls.filter((c) => c.method === 'POST' && c.path === 'payments')).toHaveLength(1);
    expect(offers(db)).toHaveLength(1);
    // A third click while it settles: still nothing new at Whop.
    expect(await oneClickSprint(rt, reg(db), { sleep: noSleep, tries: 1 })).toEqual({ ok: true, next: WELCOME, outcome: 'in_flight' });
    expect(calls.filter((c) => c.method === 'POST' && c.path === 'payments')).toHaveLength(1);
  });

  it('3D Secure: the buyer goes to Whop’s page and, back on the Sprint page, Whop’s status marks it paid', async () => {
    stubWhop({ statuses: [{ status: 'requires_action', next_action: { type: 'redirect', data: { url: 'https://psp.test/3ds/abc', frame_max_width: null } } }] });
    const r = await oneClickSprint(rt, reg(db), { sleep: noSleep });
    expect(r).toEqual({ ok: true, next: 'https://psp.test/3ds/abc', outcome: 'action' });
    expect(offer(db).status).toBe('pending');
    stubWhop({ statuses: [{ status: 'succeeded' }] });
    expect(await confirmOnReturn(rt, reg(db))).toBe('paid');
    expect(offer(db).status).toBe('paid');
  });

  it('3D Secure not passed: the attempt closes and the Sprint page sends them to the form', async () => {
    stubWhop({ statuses: [{ status: 'requires_action', next_action: { type: 'redirect', data: { url: 'https://psp.test/3ds/abc' } } }] });
    await oneClickSprint(rt, reg(db), { sleep: noSleep });
    stubWhop({ statuses: [{ status: 'requires_confirmation', last_payment_error: { code: 'authentication_required' } }] });
    expect(await confirmOnReturn(rt, reg(db))).not.toBe('paid');
    expect(offer(db).status).toBe('expired');
    expect(await recentFailedOneClick(rt, 'r1')).toBeTruthy();
  });

  it('declined card: nothing paid, back to the form and checkout with a note', async () => {
    stubWhop({ statuses: [{ status: 'requires_confirmation', last_payment_error: { code: 'insufficient_funds', message: 'declined' } }] });
    expect(await oneClickSprint(rt, reg(db), { sleep: noSleep })).toEqual({ ok: false, fallback: `${START_URL}?one_click=declined`, outcome: 'declined' });
    expect(offer(db).status).toBe('expired');
    stubWhop({ create: { status: 402, message: 'Your card was declined' } });
    expect(await oneClickSprint(rt, reg(db), { sleep: noSleep })).toMatchObject({ ok: false, outcome: 'declined' });
  });

  it('no payment:charge on the key: the normal flow, one Slack alert, and a Funnel HQ note', async () => {
    const calls = stubWhop({ create: { status: 403, message: 'Actor is missing all required permissions: payment:charge' } });
    expect(await oneClickSprint(rt, reg(db), { sleep: noSleep })).toEqual({ ok: false, fallback: `${START_URL}?one_click=unavailable`, outcome: 'unavailable' });
    await oneClickSprint(rt, reg(db), { sleep: noSleep });
    await Promise.all(pending);
    const slack = calls.filter((c) => c.url.startsWith('https://hooks.slack.test'));
    expect(slack).toHaveLength(1);
    expect(JSON.stringify(slack[0].body)).toMatch(/payment:charge/);
    const h = await whopHealth(rt, passConfig(rt.settings));
    expect(h.notes.map((n) => n.text).join(' ')).toMatch(/payment:charge/);
    expect(offers(db).every((p) => p.status === 'expired')).toBe(true);
  });

  it('is gated like checkout', async () => {
    stubWhop();
    const early = freshDb(); seed(early, { startedAgoMin: 20, unlocked: false });
    await expect(oneClickSprint(makeRt(early), reg(early), { sleep: noSleep })).rejects.toMatchObject({ status: 403 });
    await expect(oneClickSprint(rt, reg(db), { sleep: noSleep, now: START + 60 * MIN + 48 * HOUR + 1 })).rejects.toMatchObject({ status: 410 });
    const small = freshDb(); seed(small, { band: '<1m' });
    await expect(oneClickSprint(makeRt(small), reg(small), { sleep: noSleep })).rejects.toMatchObject({ status: 403 });
    db.prepare("INSERT INTO webinar_passes (id, reg_id, lead_id, kind, status, amount, currency, paid_at, created_at, updated_at) VALUES ('wpx', 'r1', 'l1', 'offer', 'paid', 290000, 'usd', 1, 1, 1)").run();
    const calls = stubWhop();
    expect(await oneClickSprint(rt, reg(db), { sleep: noSleep })).toEqual({ ok: true, next: WELCOME, outcome: 'paid' });
    expect(calls.filter((c) => c.path === 'payments')).toHaveLength(0);
  });

  it('no saved method: the normal flow, nothing charged', async () => {
    const plain = freshDb(); seed(plain, { ticket: 'plain' });
    const calls = stubWhop();
    expect(await oneClickSprint(makeRt(plain), reg(plain), { sleep: noSleep })).toEqual({ ok: false, fallback: START_URL, outcome: 'no_method' });
    expect(calls.filter((c) => c.path === 'payments')).toHaveLength(0);
    expect(offers(plain)).toHaveLength(0);
  });

  it('the endpoint refuses cross-site posts', async () => {
    const a = new Hono<AppEnv>();
    a.use('*', async (c, next) => { c.set('settings', WHOP as never); await next(); });
    a.route('/api', api);
    const res = await a.request('https://apply.test/api/webinar/sprint/one-click', { method: 'POST', body: JSON.stringify({ token: TOKEN }), headers: { origin: 'https://evil.test', 'content-type': 'application/json' } }, { DB: d1(db) });
    expect(res.status).toBe(403);
    expect(offers(db)).toHaveLength(0);
  });
});

// ───────────── After one click: the intake waits under the kickoff booking ─────────────

describe('Sprint page after one click', () => {
  it('shows the intake questions right under the kickoff booking until they are answered', () => {
    const rt = makeRt(freshDb());
    const v = { ...samplePortal(rt), preview: false, welcome: true, token: TOKEN, intake: null, kickoff: { booked: false, held: false, url: 'https://calendly.com/gl/kickoff' }, kickoffEmbed: 'https://calendly.com/gl/kickoff?embed_type=Inline' };
    const html = portalHtml(v);
    expect(html.indexOf('data-kickoff=')).toBeLessThan(html.indexOf('id="intake"'));
    expect(html.indexOf('id="intake"')).toBeLessThan(html.indexOf('<ol class="ds-days">'));
    const done = portalHtml({ ...v, intake: { revenue: '$3M–$10M', industry: 'HVAC' } as never });
    expect(done.indexOf('id="intake"')).toBeGreaterThan(done.indexOf('<ol class="ds-days">'));
  });
});
