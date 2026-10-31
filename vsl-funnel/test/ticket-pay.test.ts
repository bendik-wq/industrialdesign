import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv, Runtime } from '../src/app';
import { auditFields } from '../src/content/copy-rules';
import { confirmOnReturn } from '../src/webinar/pass';
import { WHOP_NATIVE_VERSION, handleWhopEvent } from '../src/webinar/whop';
import { oneClickInfo, oneClickSprint } from '../src/webinar/one-click';
import { embeddedTicketOn, payTicket, ticketPayConfig, ticketPayCopy, ticketPayHtml } from '../src/webinar/ticket-pay';
import { api } from '../src/routes/api';
import { SETTINGS } from '../src/settings';
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
  ({ env: { DB: d1(db) }, settings: { ...Object.fromEntries(SETTINGS.map((d) => [d.key, ''])), ...settings }, reps: [], origin: 'https://apply.test', waitUntil: (p: Promise<unknown>) => { pending.push(p); } }) as unknown as Runtime;

const MIN = 60_000;
const TOKEN = 'tokentokentoken12345';
const THANKS = `https://apply.test/webinar/registered/${TOKEN}?pass=success`;
const SETTLE = `https://apply.test/webinar/ticket/${TOKEN}?return=1`;
let START = 0;
function seed(db: DatabaseSync) {
  const now = Date.now();
  START = now - 45 * MIN;
  db.prepare("INSERT INTO leads (id, ref_code, created_at, updated_at, first_name, last_name, email, status, revenue_band, webinar_token) VALUES ('l1', 'R1', ?, ?, 'Dana', 'Lee', 'dana@example.com', 'partial', '3m-10m', ?)").run(now, now, TOKEN);
  db.prepare("INSERT INTO webinar_sessions (id, starts_at, mode, status, auto, created_at) VALUES ('s1', ?, 'evergreen', 'scheduled', 1, ?)").run(START, now);
  db.prepare("INSERT INTO webinar_registrations (id, token, session_id, lead_id, created_at, revenue_band, pass_required, offer_unlocked_at) VALUES ('r1', ?, 's1', 'l1', ?, '3m-10m', 1, ?)").run(TOKEN, now, START + 38 * MIN);
}
const reg = (db: DatabaseSync) => db.prepare("SELECT * FROM webinar_registrations WHERE id = 'r1'").get() as Registration;
const seat = (db: DatabaseSync) => db.prepare("SELECT * FROM webinar_passes WHERE kind = 'seat' ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as Record<string, unknown>;
const seats = (db: DatabaseSync) => db.prepare("SELECT * FROM webinar_passes WHERE kind = 'seat'").all() as Record<string, unknown>[];

/** The pinned Retrieve payment: nested member and payment method, as the webhook sends them. */
const SAVED = { member: { id: 'mber_t' }, payment_method: { id: 'payt_t', card: { brand: 'visa', last4: '4242' } } };

interface Call { method: string; url: string; path: string; headers: Record<string, string>; body: Record<string, unknown> | null }
function stubWhop(o: { creates?: (Record<string, unknown> | { error: { status: number; message: string } })[]; statuses?: Record<string, unknown>[]; payment?: Record<string, unknown> } = {}) {
  const calls: Call[] = [];
  let c = 0, s = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const u = String(url);
    const path = u.replace('https://api.whop.com/api/v1/', '');
    calls.push({ method: init.method ?? 'GET', url: u, path, headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (!u.startsWith('https://api.whop.com/')) return json(200, { ok: true });
    if (path === 'payments' && init.method === 'POST') {
      const list = o.creates ?? [{ id: 'pay_tk', status: 'paid', client_secret: 'sec_tk' }];
      const r = list[Math.min(c++, list.length - 1)];
      return 'error' in r ? json((r.error as { status: number }).status, { error: { message: (r.error as { message: string }).message } }) : json(201, r);
    }
    if (/^payments\/[^/]+\/status$/.test(path)) { const l = o.statuses ?? [{ status: 'succeeded' }]; return json(200, l[Math.min(s++, l.length - 1)]); }
    if (path.startsWith('payments/')) return json(200, o.payment ?? SAVED);
    return json(404, { error: { message: 'not stubbed' } });
  }));
  return calls;
}
afterEach(() => { vi.unstubAllGlobals(); pending.length = 0; });

describe('ticket on our own page: copy and switches', () => {
  it('tells the buyer, right above the pay button, that Whop saves the card for a one-click Sprint; the copy passes the house rules', () => {
    const t = ticketPayCopy('$100');
    expect(auditFields(t)).toEqual([]);
    expect(t.saveNote).toBe('Whop saves your card securely, so you can add the First Deal Sprint in one click later. Today you pay $100 for your ticket.');
    const html = ticketPayHtml({ copy: t, note: null, hostedUrl: '/ticket/x?hosted=1' });
    expect(html).toMatch(/data-save-note>[^<]+<\/p>\s*<button[^>]*data-ticket-pay-btn/);
    expect(html).toContain('Pay $100');
    expect(html).toContain('href="/ticket/x?hosted=1"');
  });

  it('runs when Whop takes payments, unless switched off', () => {
    expect(embeddedTicketOn(WHOP)).toBe(true);
    expect(embeddedTicketOn({ ...WHOP, WHOP_TICKET_FORM: 'off' })).toBe(false);
    expect(embeddedTicketOn({ ...WHOP, WHOP_API_KEY: '', STRIPE_SECRET_KEY: 'sk' })).toBe(false);
  });

  it('gives the browser the elements setup: account, $100 in cents, the buyer’s email, the return page', async () => {
    const db = freshDb(); seed(db);
    expect(await ticketPayConfig(makeRt(db), reg(db))).toMatchObject({ accountId: 'biz_test', amount: 10000, currency: 'usd', email: 'dana@example.com', name: 'Dana Lee', returnUrl: SETTLE, src: 'https://cdn.whop.com/elements/amber/elements.js' });
  });
});

describe('ticket payment from a confirmation token', () => {
  let db: DatabaseSync; let rt: Runtime;
  beforeEach(() => { db = freshDb(); seed(db); rt = makeRt(db); });

  it('token → payment with setup_future_usage → paid, card stored → the Sprint is one click on that card', async () => {
    const calls = stubWhop({ creates: [{ id: 'pay_tk', status: 'paid', client_secret: 'sec_tk' }, { id: 'pay_oc', status: 'open' }] });
    const effects = vi.fn(async () => {});
    expect(await payTicket(rt, reg(db), { confirmationToken: 'ctok_abc123', effects })).toEqual({ ok: true, next: THANKS });
    const create = calls.find((c) => c.method === 'POST' && c.path === 'payments')!;
    expect(create.headers['api-version-date']).toBe(WHOP_NATIVE_VERSION);
    expect(create.headers['idempotency-key']).toBe(`ticket_${seat(db).id}`);
    expect(create.body).toMatchObject({
      account_id: 'biz_test', confirmation_token: 'ctok_abc123', setup_future_usage: 'off_session', return_url: SETTLE,
      variant: { currency: 'usd', billing_type: 'one_time', initial_price: 100, title: 'Masterclass ticket', product: { external_identifier: 'vsl-funnel-masterclass-ticket' } },
      metadata: { pass_id: seat(db).id, reg_id: 'r1', reg_token: TOKEN, lead_id: 'l1', kind: 'seat', embedded: '1' },
    });
    expect(seat(db)).toMatchObject({ status: 'paid', embedded: 1, provider: 'whop', amount: 10000, stripe_payment_intent: 'pay_tk', whop_member_id: 'mber_t', whop_payment_method_id: 'payt_t', card_brand: 'visa', card_last4: '4242' });
    expect(effects).toHaveBeenCalledTimes(1);
    // The webhook for the same payment changes nothing.
    expect(await handleWhopEvent(rt, { type: 'payment.succeeded', data: { id: 'pay_tk', status: 'paid', total: 100, currency: 'usd', metadata: { pass_id: seat(db).id, kind: 'seat' }, ...SAVED } }, effects)).toMatchObject({ duplicate: true });
    expect(effects).toHaveBeenCalledTimes(1);
    // Later, in the room: one click on the saved card.
    expect(await oneClickInfo(rt, { lead_id: 'l1' })).toMatchObject({ card: 'Visa ending 4242' });
    const r = await oneClickSprint(rt, reg(db), { effects: async () => {}, sleep: async () => {} });
    expect(r).toMatchObject({ ok: true, outcome: 'paid' });
    const sprint = calls.filter((c) => c.method === 'POST' && c.path === 'payments')[1];
    expect(sprint.body).toMatchObject({ member_id: 'mber_t', payment_method_id: 'payt_t', off_session: false, variant: { initial_price: 2900 } });
  });

  it('3D Secure: the browser finishes the step; the webhook (or the return page) marks it paid and stores the card', async () => {
    stubWhop({ creates: [{ id: 'pay_tk', status: 'open', client_secret: 'pi_secret_x' }] });
    expect(await payTicket(rt, reg(db), { confirmationToken: 'ctok_abc123', effects: async () => {} })).toEqual({ ok: true, payment: 'pay_tk', client_secret: 'pi_secret_x', settle: SETTLE });
    expect(seat(db).status).toBe('pending');
    await handleWhopEvent(rt, { type: 'payment.succeeded', data: { id: 'pay_tk', status: 'paid', total: 100, currency: 'usd', metadata: { pass_id: seat(db).id, kind: 'seat', reg_id: 'r1' }, ...SAVED } }, async () => {});
    expect(seat(db)).toMatchObject({ status: 'paid', whop_payment_method_id: 'payt_t' });
  });

  it('back from an off-site step before the webhook: Whop’s status settles it on the return page', async () => {
    stubWhop({ creates: [{ id: 'pay_tk', status: 'open', client_secret: 'pi_secret_x' }], statuses: [{ status: 'succeeded' }] });
    await payTicket(rt, reg(db), { confirmationToken: 'ctok_abc123', effects: async () => {} });
    expect(await confirmOnReturn(rt, reg(db))).toBe('paid');
    expect(seat(db)).toMatchObject({ status: 'paid', whop_member_id: 'mber_t', whop_payment_method_id: 'payt_t' });
  });

  it('a declined card: not charged, the reason shown, and another card can be tried', async () => {
    const calls = stubWhop({ creates: [{ error: { status: 402, message: 'Your card was declined' } }, { id: 'pay_tk2', status: 'paid' }] });
    const r = await payTicket(rt, reg(db), { confirmationToken: 'ctok_abc123', effects: async () => {} });
    expect(r).toEqual({ ok: false, error: ticketPayCopy('$100').declined, hosted: `https://apply.test/webinar/ticket/${TOKEN}?hosted=1` });
    expect(seat(db).status).toBe('expired');
    await Promise.all(pending);
    expect(calls.filter((c) => c.url.startsWith('https://hooks.slack.test'))).toHaveLength(0);
    expect(await payTicket(rt, reg(db), { confirmationToken: 'ctok_second', effects: async () => {} })).toEqual({ ok: true, next: THANKS });
    expect(seats(db).map((p) => p.status).sort()).toEqual(['expired', 'paid']);
  });

  it('3D Secure failed on the return page: the attempt closes, nothing is paid', async () => {
    stubWhop({ creates: [{ id: 'pay_tk', status: 'open', client_secret: 'x' }], statuses: [{ status: 'requires_confirmation', last_payment_error: { code: 'authentication_required' } }] });
    await payTicket(rt, reg(db), { confirmationToken: 'ctok_abc123', effects: async () => {} });
    expect(await confirmOnReturn(rt, reg(db))).not.toBe('paid');
    expect(seat(db).status).toBe('expired');
  });

  it('a second press while the first is in flight never creates a second payment', async () => {
    const calls = stubWhop({ creates: [{ id: 'pay_tk', status: 'open', client_secret: 'x' }], statuses: [{ status: 'requires_action', next_action: { type: 'redirect', data: { url: 'https://psp.test' } } }] });
    await payTicket(rt, reg(db), { confirmationToken: 'ctok_abc123', effects: async () => {} });
    expect(await payTicket(rt, reg(db), { confirmationToken: 'ctok_again', effects: async () => {} })).toEqual({ ok: true, next: SETTLE });
    expect(calls.filter((c) => c.method === 'POST' && c.path === 'payments')).toHaveLength(1);
  });

  it('refuses a malformed token, and skips the charge when the ticket is already paid', async () => {
    const calls = stubWhop();
    await expect(payTicket(rt, reg(db), { confirmationToken: 'tok<script>' })).rejects.toMatchObject({ status: 400 });
    db.prepare("INSERT INTO webinar_passes (id, reg_id, lead_id, kind, status, amount, currency, paid_at, created_at, updated_at) VALUES ('tx', 'r1', 'l1', 'seat', 'paid', 10000, 'usd', 1, 1, 1)").run();
    expect(await payTicket(rt, reg(db), { confirmationToken: 'ctok_abc123' })).toEqual({ ok: true, next: THANKS });
    expect(calls.filter((c) => c.path === 'payments')).toHaveLength(0);
  });

  it('a refund of the embedded ticket withdraws it (found by its payment id)', async () => {
    stubWhop();
    await payTicket(rt, reg(db), { confirmationToken: 'ctok_abc123', effects: async () => {} });
    stubWhop({ payment: { refunded_amount: 100 } });
    expect(await handleWhopEvent(rt, { type: 'refund.created', data: { id: 'rf_1', status: 'succeeded', amount: 100, payment: { id: 'pay_tk' } } })).toMatchObject({ refunded: true });
    expect(seat(db).status).toBe('refunded');
    expect(await oneClickInfo(rt, { lead_id: 'l1' })).toBeNull();
  });

  it('the endpoint refuses cross-site posts', async () => {
    const a = new Hono<AppEnv>();
    a.use('*', async (c, next) => { c.set('settings', WHOP as never); await next(); });
    a.route('/api', api);
    const res = await a.request('https://apply.test/api/webinar/ticket/pay', { method: 'POST', body: JSON.stringify({ token: TOKEN, confirmation_token: 'ctok_abc123' }), headers: { origin: 'https://evil.test', 'content-type': 'application/json' } }, { DB: d1(db) });
    expect(res.status).toBe(403);
  });
});
