import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv, Runtime } from '../src/app';
import { auditCopy, auditFields } from '../src/content/copy-rules';
import { type PassRow, PassError, createCheckout, markPassPaid, passConfig, passCopy, passPaidEffects, paymentProvider, ticketFor } from '../src/webinar/pass';
import { createSprintCheckout, sprintSettings } from '../src/webinar/sprint';
import {
  CHECKOUT_UNAVAILABLE, WHOP_API_VERSION, WHOP_EVENTS, connectWhop, handleWhopEvent, isCheckoutLimitError, verifyWhopSignature, whopConfirm, whopHealth, whopMoney,
} from '../src/webinar/whop';
import {
  APPLICATION_FIELDS, cleanApplication, copyApplicationToIntake, saveApplication, sprintStartCopy, sprintStartGate, sprintStartSubmit, startFormHtml,
} from '../src/webinar/sprint-start';
import { DEAL_SPRINT_COPY, kickoffEmbedUrl, portalHtml, samplePortal } from '../src/webinar/deal-sprint';
import { hooks } from '../src/routes/hooks';
import type { Registration } from '../src/webinar/webinar';

// ───────────── A real SQLite database shaped like D1, with every migration applied (as in webinar-sprint.test.ts) ─────────────

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
  WEBINAR_PASS: 'required', WEBINAR_SEAT_PRICE: '100', WHOP_API_KEY: 'apik_test', WHOP_WEBHOOK_SECRET: 'ws_test_secret', SALES_TIMEZONE: 'Australia/Sydney',
  WEBINAR_DURATION_MIN: '60', WEBINAR_REPLAY_HOURS: '48', WEBINAR_PITCH_AT: '38', WEBINAR_PASS_PLAN: '2x1550',
};
const pending: Promise<unknown>[] = [];
const makeRt = (db: DatabaseSync, settings: Record<string, string> = WHOP) =>
  ({ env: { DB: d1(db) }, settings: { ...settings }, reps: [], origin: 'https://apply.test', waitUntil: (p: Promise<unknown>) => { pending.push(p); } }) as unknown as Runtime;

const MIN = 60_000, HOUR = 60 * MIN;
const TOKEN = 'tokentokentoken12345';
let START = 0;
function seed(db: DatabaseSync, o: { band?: string; startedAgoMin?: number } = {}) {
  const now = Date.now();
  START = now - (o.startedAgoMin ?? 45) * MIN;
  db.prepare("INSERT INTO leads (id, ref_code, created_at, updated_at, first_name, last_name, email, status, revenue_band, webinar_token) VALUES ('l1', 'R1', ?, ?, 'Dana', 'Lee', 'dana@example.com', 'partial', ?, ?)").run(now, now, o.band ?? '3m-10m', TOKEN);
  db.prepare("INSERT INTO webinar_sessions (id, starts_at, mode, status, auto, created_at) VALUES ('s1', ?, 'evergreen', 'scheduled', 1, ?)").run(START, now);
  db.prepare("INSERT INTO webinar_registrations (id, token, session_id, lead_id, created_at, revenue_band) VALUES ('r1', ?, 's1', 'l1', ?, ?)").run(TOKEN, now, o.band ?? '3m-10m');
}
const unlock = (db: DatabaseSync) => db.prepare("UPDATE webinar_registrations SET offer_unlocked_at = ? WHERE id = 'r1'").run(START + 38 * MIN);
const ticket = (db: DatabaseSync, id: string, amount = 10000) =>
  db.prepare("INSERT INTO webinar_passes (id, reg_id, lead_id, kind, status, amount, currency, paid_at, created_at, updated_at) VALUES (?, 'r1', 'l1', 'seat', 'paid', ?, 'usd', ?, ?, ?)").run(id, amount, Date.now(), Date.now(), Date.now());
const reg = (db: DatabaseSync) => db.prepare("SELECT * FROM webinar_registrations WHERE id = 'r1'").get() as Registration & { offer_unlocked_at: number | null };
const pass = (db: DatabaseSync, where = "kind = 'offer'") => db.prepare(`SELECT * FROM webinar_passes WHERE ${where} ORDER BY created_at DESC LIMIT 1`).get() as PassRow;
const kv = (db: DatabaseSync, key: string) => (db.prepare('SELECT value FROM kv_state WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;

/** Whop (and Slack) stub: records every call and answers like the API. */
interface Call { method: string; url: string; path: string; headers: Record<string, string>; body: Record<string, unknown> | null }
function stubWhop(o: { checkoutError?: { status: number; message: string }; payments?: Record<string, unknown>[]; payment?: Record<string, unknown>; webhookCreate?: 'ok' | 'forbidden' } = {}) {
  const calls: Call[] = [];
  let n = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const u = String(url);
    const path = u.replace('https://api.whop.com/api/v1/', '');
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ method: init.method ?? 'GET', url: u, path, headers: init.headers ?? {}, body });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (!u.startsWith('https://api.whop.com/')) return json(200, { ok: true }); // Slack and anything else
    if (path === 'accounts/me') return json(200, { id: 'biz_test', title: 'Test Co' });
    if (path === 'checkout_configurations') {
      if (o.checkoutError) return json(o.checkoutError.status, { error: { type: 'bad_request', message: o.checkoutError.message } });
      n += 1;
      return json(200, { id: `ch_${n}`, purchase_url: `https://whop.com/checkout/ch_${n}/` });
    }
    if (path.startsWith('payments?')) return json(200, { data: o.payments ?? [] });
    if (path.startsWith('payments/')) return json(200, o.payment ?? {});
    if (path.startsWith('webhooks?')) return json(200, { data: [] });
    if (path === 'webhooks') return o.webhookCreate === 'forbidden' ? json(403, { error: { message: 'missing developer:manage_webhook' } }) : json(200, { id: 'hook_1', webhook_secret: 'ws_new_secret' });
    return json(404, { error: { message: 'not stubbed' } });
  }));
  return calls;
}
afterEach(() => { vi.unstubAllGlobals(); pending.length = 0; });

async function sign(secret: string, id: string, ts: number, body: string) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${id}.${ts}.${body}`));
  return `v1,${btoa(String.fromCharCode(...new Uint8Array(mac)))}`;
}

// ───────────── Provider selection ─────────────

describe('payment provider', () => {
  it('Whop when its API key is set (even with Stripe too), else Stripe, else nothing', () => {
    expect(paymentProvider({})).toBeNull();
    expect(paymentProvider({ STRIPE_SECRET_KEY: 'sk' })).toBe('stripe');
    expect(paymentProvider({ WHOP_API_KEY: 'apik' })).toBe('whop');
    expect(paymentProvider({ WHOP_API_KEY: 'apik', STRIPE_SECRET_KEY: 'sk' })).toBe('whop');
    expect(paymentProvider({ WHOP_API_KEY: '  ' })).toBeNull();
  });

  it('either provider can sell; the webhook check follows the provider', () => {
    const c = passConfig({ WEBINAR_PASS: 'upsell', WHOP_API_KEY: 'apik', WHOP_WEBHOOK_SECRET: 'ws_x' });
    expect(c).toMatchObject({ mode: 'upsell', provider: 'whop', reason: null, webhookReady: true });
    expect(passConfig({ WEBINAR_PASS: 'upsell', WHOP_API_KEY: 'apik', STRIPE_WEBHOOK_SECRET: 'whsec' }).webhookReady).toBe(false);
    expect(passConfig({ WEBINAR_PASS: 'upsell', STRIPE_SECRET_KEY: 'sk' })).toMatchObject({ mode: 'upsell', provider: 'stripe' });
    expect(passCopy(c).secure).toBe('Secure checkout by Whop.');
    expect(passCopy(c).confirming).toMatch(/^Whop is still confirming/);
    expect(ticketFor({ ...WHOP })!.copy.privacy).toMatch(/secure checkout by Whop for the \$100 ticket/);
  });

  it('the Stripe payment plan is hidden when Whop takes the payments', () => {
    expect(sprintSettings({ settings: WHOP } as unknown as Runtime).plan).toBeNull();
    expect(sprintSettings({ settings: { ...WHOP, WHOP_API_KEY: '', STRIPE_SECRET_KEY: 'sk' } } as unknown as Runtime).plan).toMatchObject({ count: 2 });
  });

  it('new copy passes the house rules', () => {
    const c = passConfig({ WEBINAR_PASS: 'upsell', WHOP_API_KEY: 'apik' });
    expect(auditCopy(CHECKOUT_UNAVAILABLE)).toEqual([]);
    expect(auditFields({ pass: passCopy(c), start: sprintStartCopy({ offerName: 'First Deal Sprint', price: '$2,900', whop: true }), fields: APPLICATION_FIELDS.map((f) => ({ label: f.label, options: f.options })), portal: DEAL_SPRINT_COPY })).toEqual([]);
    expect(auditCopy(passConfig({ WEBINAR_PASS: 'upsell' }).reason ?? '')).toEqual([]);
    expect(CHECKOUT_UNAVAILABLE).not.toMatch(/—/);
  });
});

// ───────────── Webhook signature (Standard Webhooks, as Whop signs them) ─────────────

describe('Whop webhook signature', () => {
  const secret = 'ws_0123456789abcdef';
  const body = JSON.stringify({ id: 'msg_1', type: 'payment.succeeded', data: { id: 'pay_1' } });
  const now = 1_786_381_404_000, ts = now / 1000;

  it('accepts a valid signature keyed with the secret’s literal bytes', async () => {
    expect(await verifyWhopSignature(secret, body, { id: 'msg_1', timestamp: String(ts), signature: await sign(secret, 'msg_1', ts, body) }, now)).toBe(true);
  });

  it('rejects a changed body, another id, another secret, a missing header or a non-v1 scheme', async () => {
    const sig = await sign(secret, 'msg_1', ts, body);
    expect(await verifyWhopSignature(secret, body.replace('pay_1', 'pay_2'), { id: 'msg_1', timestamp: String(ts), signature: sig }, now)).toBe(false);
    expect(await verifyWhopSignature(secret, body, { id: 'msg_2', timestamp: String(ts), signature: sig }, now)).toBe(false);
    expect(await verifyWhopSignature('ws_other', body, { id: 'msg_1', timestamp: String(ts), signature: sig }, now)).toBe(false);
    expect(await verifyWhopSignature(secret, body, { id: 'msg_1', timestamp: String(ts), signature: null }, now)).toBe(false);
    expect(await verifyWhopSignature(secret, body, { id: null, timestamp: String(ts), signature: sig }, now)).toBe(false);
    expect(await verifyWhopSignature(secret, body, { id: 'msg_1', timestamp: String(ts), signature: sig.replace('v1,', 'v2,') }, now)).toBe(false);
    expect(await verifyWhopSignature('', body, { id: 'msg_1', timestamp: String(ts), signature: sig }, now)).toBe(false);
  });

  it('rejects a stale or future timestamp (5 minutes), accepts one just inside', async () => {
    const old = ts - 301, future = ts + 301, inside = ts - 299;
    expect(await verifyWhopSignature(secret, body, { id: 'msg_1', timestamp: String(old), signature: await sign(secret, 'msg_1', old, body) }, now)).toBe(false);
    expect(await verifyWhopSignature(secret, body, { id: 'msg_1', timestamp: String(future), signature: await sign(secret, 'msg_1', future, body) }, now)).toBe(false);
    expect(await verifyWhopSignature(secret, body, { id: 'msg_1', timestamp: String(inside), signature: await sign(secret, 'msg_1', inside, body) }, now)).toBe(true);
    expect(await verifyWhopSignature(secret, body, { id: 'msg_1', timestamp: 'soon', signature: await sign(secret, 'msg_1', ts, body) }, now)).toBe(false);
  });

  it('any one of several signatures may match (a rolled secret)', async () => {
    const good = await sign(secret, 'msg_1', ts, body);
    expect(await verifyWhopSignature(secret, body, { id: 'msg_1', timestamp: String(ts), signature: `v1,${btoa('x'.repeat(32))} ${good}` }, now)).toBe(true);
  });
});

describe('POST /hooks/whop', () => {
  const app = (settings: Record<string, string>) => {
    const a = new Hono<AppEnv>();
    a.use('*', async (c, next) => { c.set('settings', settings as never); await next(); });
    a.route('/hooks', hooks);
    return a;
  };
  const env = () => ({ DB: d1(freshDb()) });

  it('fails closed: no secret 501, unsigned 400, bad signature 401, valid 200', async () => {
    const body = JSON.stringify({ type: 'membership.activated', data: {} });
    const t = Math.floor(Date.now() / 1000);
    expect((await app({ ...WHOP, WHOP_WEBHOOK_SECRET: '' }).request('/hooks/whop', { method: 'POST', body }, env())).status).toBe(501);
    expect((await app(WHOP).request('/hooks/whop', { method: 'POST', body }, env())).status).toBe(400);
    const bad = await app(WHOP).request('/hooks/whop', { method: 'POST', body, headers: { 'webhook-id': 'msg_1', 'webhook-timestamp': String(t), 'webhook-signature': await sign('ws_wrong', 'msg_1', t, body) } }, env());
    expect(bad.status).toBe(401);
    const ok = await app(WHOP).request('/hooks/whop', { method: 'POST', body, headers: { 'webhook-id': 'msg_1', 'webhook-timestamp': String(t), 'webhook-signature': await sign(WHOP.WHOP_WEBHOOK_SECRET, 'msg_1', t, body) } }, env());
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ received: true, ignored: 'membership.activated' });
  });
});

// ───────────── Checkout through Whop ─────────────

describe('Whop checkout', () => {
  let db: DatabaseSync; let rt: Runtime;
  beforeEach(() => { db = freshDb(); seed(db); unlock(db); rt = makeRt(db); });

  it('the Sprint: inline one-time plan at the price after the ticket credit, our metadata, back to the Sprint page', async () => {
    ticket(db, 't1');
    const calls = stubWhop();
    const r = await createSprintCheckout(rt, reg(db), { from: 'start' });
    expect(r).toEqual({ url: 'https://whop.com/checkout/ch_1/' });
    // The company id comes from the API key (and is saved), then the checkout configuration.
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET accounts/me', 'POST checkout_configurations']);
    expect((db.prepare("SELECT value FROM settings WHERE key = 'WHOP_COMPANY_ID'").get() as { value: string }).value).toBe('biz_test');
    const c = calls[1];
    expect(c.headers['api-version-date']).toBe(WHOP_API_VERSION);
    expect(c.headers.authorization).toBe('Bearer apik_test');
    expect(c.body).toMatchObject({
      plan: { company_id: 'biz_test', currency: 'usd', initial_price: 2900, plan_type: 'one_time', visibility: 'hidden', title: 'First Deal Sprint', product: { external_identifier: 'vsl-funnel-first-deal-sprint', title: 'First Deal Sprint' } },
      metadata: { pass_id: pass(db).id, reg_id: 'r1', reg_token: TOKEN, lead_id: 'l1', kind: 'offer', fast_bonus: '1' },
      redirect_url: `https://apply.test/webinar/sprint/${TOKEN}?welcome=1`,
    });
    expect(pass(db)).toMatchObject({ provider: 'whop', stripe_session_id: 'ch_1', checkout_url: 'https://whop.com/checkout/ch_1/', amount: 290000, ticket_credit: 10000, list_amount: 300000, status: 'pending' });
    // The same registration clicks again within the checkout's life: reused, nothing new at Whop.
    expect(await createSprintCheckout(rt, reg(db), { from: 'room' })).toEqual({ url: 'https://whop.com/checkout/ch_1/' });
    expect(calls).toHaveLength(2);
  });

  it('no payment plan through Whop', async () => {
    stubWhop();
    await expect(createSprintCheckout(rt, reg(db), { plan: true })).rejects.toMatchObject({ status: 409 });
  });

  it('the ticket: $100, back to the thank-you page with ?pass=success; /ticket links reuse it', async () => {
    const calls = stubWhop();
    const r = await createCheckout(rt, reg(db), { kind: 'seat', from: 'ty' });
    expect(r).toEqual({ url: 'https://whop.com/checkout/ch_1/' });
    expect(calls[1].body).toMatchObject({
      plan: { initial_price: 100, plan_type: 'one_time', title: 'Masterclass ticket', product: { external_identifier: 'vsl-funnel-masterclass-ticket' } },
      metadata: { kind: 'seat', reg_id: 'r1', reg_token: TOKEN, lead_id: 'l1' },
      redirect_url: `https://apply.test/webinar/registered/${TOKEN}?pass=success`,
    });
    expect(pass(db, "kind = 'seat'")).toMatchObject({ provider: 'whop', amount: 10000, stripe_session_id: 'ch_1' });
    expect(await createCheckout(rt, reg(db), { kind: 'seat', from: 'ty' })).toEqual({ url: 'https://whop.com/checkout/ch_1/' });
    expect(calls.filter((c) => c.path === 'checkout_configurations')).toHaveLength(1);
  });

  it('a refused checkout (the $2,500 cap): polite message (try again or email the team), row closed, one Slack alert with the cause, a health note', async () => {
    rt = makeRt(db, { ...WHOP, SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x' });
    const calls = stubWhop({ checkoutError: { status: 422, message: 'Checkout links over $2,500 need approval' } });
    const err = await createSprintCheckout(rt, reg(db)).catch((e) => e);
    expect(err).toBeInstanceOf(PassError);
    expect(err).toMatchObject({ status: 503, message: CHECKOUT_UNAVAILABLE });
    expect(err.message).not.toMatch(/call/i);
    await Promise.all(pending);
    expect(pass(db).status).toBe('expired');
    expect(JSON.parse(kv(db, 'whop:checkout_error')!)).toMatchObject({ limit: true, kind: 'offer', amount: '$3,000' });
    const slack = calls.filter((c) => c.url.startsWith('https://hooks.slack.test'));
    expect(slack).toHaveLength(1);
    expect(JSON.stringify(slack[0].body)).toMatch(/Settings → Payments/);
    // A second refusal within the hour: the viewer gets the same message, the team isn't pinged again.
    await createSprintCheckout(rt, reg(db)).catch(() => null);
    await Promise.all(pending);
    expect(calls.filter((c) => c.url.startsWith('https://hooks.slack.test'))).toHaveLength(1);
    const h = await whopHealth(rt, passConfig(rt.settings));
    expect(h.notes[0]).toMatchObject({ level: 'warn' });
    expect(h.notes[0].text).toMatch(/caps checkout links at \$2,500.*Settings → Payments/);
  });

  it('decides the cause from the message, or a 4xx on a price over the cap', () => {
    expect(isCheckoutLimitError('Whop 400: price exceeds the maximum allowed', 400, 2900, 'usd')).toBe(true);
    expect(isCheckoutLimitError('Whop 422: invalid', 422, 2900, 'usd')).toBe(true);
    expect(isCheckoutLimitError('Whop 422: invalid', 422, 100, 'usd')).toBe(false);
    expect(isCheckoutLimitError('Whop 401: bad key', 401, 2900, 'usd')).toBe(false);
    expect(isCheckoutLimitError('Whop 500: oops', 500, 2900, 'usd')).toBe(false);
  });

  it('no cap note until Whop actually refuses a checkout; a checkout that works clears an old refusal', async () => {
    expect((await whopHealth(rt, passConfig(rt.settings))).notes.map((n) => n.text).join(' ')).not.toMatch(/\$2,500/);
    stubWhop({ checkoutError: { status: 422, message: 'Checkout links over $2,500 need approval' } });
    await createSprintCheckout(rt, reg(db)).catch(() => null);
    expect((await whopHealth(rt, passConfig(rt.settings))).notes.map((n) => n.text).join(' ')).toMatch(/caps checkout links at \$2,500/);
    stubWhop();
    await createSprintCheckout(rt, reg(db));
    expect((await whopHealth(rt, passConfig(rt.settings))).notes.map((n) => n.text).join(' ')).not.toMatch(/\$2,500/);
  });
});

// ───────────── Webhook events ─────────────

describe('Whop events', () => {
  let db: DatabaseSync; let rt: Runtime;
  const offerRow = (o: { session?: string | null } = {}) =>
    db.prepare("INSERT INTO webinar_passes (id, reg_id, lead_id, kind, product, status, amount, currency, ticket_credit, list_amount, stripe_session_id, provider, created_at, updated_at) VALUES ('wp1', 'r1', 'l1', 'offer', 'First Deal Sprint', 'pending', 290000, 'usd', 10000, 300000, ?, 'whop', ?, ?)")
      .run(o.session === undefined ? 'ch_1' : o.session, Date.now(), Date.now());
  const paid = (extra: Record<string, unknown> = {}) => ({ type: 'payment.succeeded', data: { id: 'pay_1', status: 'paid', total: 2900, currency: 'usd', checkout_configuration_id: 'ch_1', metadata: { pass_id: 'wp1', reg_id: 'r1', lead_id: 'l1', kind: 'offer' }, ...extra } });
  beforeEach(() => { db = freshDb(); seed(db); rt = makeRt(db); });

  it('payment.succeeded marks the purchase paid once (amount and currency from the payload)', async () => {
    offerRow();
    const effects = vi.fn(async () => {});
    expect(await handleWhopEvent(rt, paid(), effects)).toEqual({ paid: 'wp1', duplicate: false });
    expect(await handleWhopEvent(rt, paid(), effects)).toEqual({ paid: 'wp1', duplicate: true });
    expect(effects).toHaveBeenCalledTimes(1);
    expect(pass(db)).toMatchObject({ status: 'paid', amount: 290000, currency: 'usd', credit_amount: 300000, stripe_payment_intent: 'pay_1', stripe_session_id: 'ch_1' });
  });

  it('reads the newer money shape too, and finds the purchase by checkout id when metadata is missing', async () => {
    offerRow();
    expect(whopMoney({ amount: '2900.00', currency: 'usd' })).toEqual({ major: 2900, currency: 'usd' });
    const r = await handleWhopEvent(rt, paid({ total: { amount: '2900.00', currency: 'usd' }, metadata: null }), async () => {});
    expect(r).toEqual({ paid: 'wp1', duplicate: false });
    expect(pass(db).amount).toBe(290000);
  });

  it('a webhook that beats our own write still attaches to the purchase by its pass id', async () => {
    offerRow({ session: null });
    expect(await handleWhopEvent(rt, paid(), async () => {})).toEqual({ paid: 'wp1', duplicate: false });
    expect(pass(db)).toMatchObject({ status: 'paid', stripe_session_id: 'ch_1' });
  });

  it('ignores the company’s other sales and other events', async () => {
    offerRow();
    expect(await handleWhopEvent(rt, { type: 'payment.succeeded', data: { id: 'pay_9', status: 'paid', total: 99, metadata: null, checkout_configuration_id: null } })).toEqual({ ignored: 'not a masterclass checkout' });
    expect(await handleWhopEvent(rt, { type: 'payment.succeeded', data: { id: 'pay_9', status: 'paid', total: 99, metadata: { step_id: 'x' }, checkout_configuration_id: 'ch_other' } })).toEqual({ ignored: 'not a masterclass checkout' });
    expect(await handleWhopEvent(rt, { type: 'membership.activated', data: {} })).toEqual({ ignored: 'membership.activated' });
    expect(pass(db).status).toBe('pending');
  });

  it('a refund withdraws the purchase (once); a partial one is only recorded; a pending one waits', async () => {
    offerRow();
    await handleWhopEvent(rt, paid(), async () => {});
    stubWhop({ payment: { refunded_amount: 500 } });
    expect(await handleWhopEvent(rt, { type: 'refund.created', data: { id: 'rf_0', status: 'pending', amount: 2900, payment: { id: 'pay_1' } } })).toEqual({ ignored: 'refund pending' });
    expect(await handleWhopEvent(rt, { type: 'refund.created', data: { id: 'rf_1', status: 'succeeded', amount: 500, payment: { id: 'pay_1' } } })).toMatchObject({ refunded: true, partial: true });
    expect(pass(db)).toMatchObject({ status: 'paid', refunded_amount: 50000 });
    expect(await handleWhopEvent(rt, { type: 'refund.updated', data: { id: 'rf_2', status: 'succeeded', amount: 2900, payment: { id: 'pay_1', refunded_amount: 2900 } } })).toMatchObject({ refunded: true, duplicate: false });
    expect(pass(db)).toMatchObject({ status: 'refunded', credit_amount: 0, refunded_amount: 290000 });
    expect(await handleWhopEvent(rt, { type: 'refund.updated', data: { id: 'rf_2', status: 'succeeded', amount: 2900, payment: { id: 'pay_1', refunded_amount: 2900 } } })).toMatchObject({ duplicate: true });
    expect(await handleWhopEvent(rt, { type: 'refund.created', data: { id: 'rf_x', status: 'succeeded', amount: 10, payment: { id: 'pay_other' } } })).toEqual({ ignored: 'not a masterclass payment' });
  });

  it('back from Whop: the payment is looked up by our checkout configuration', async () => {
    offerRow();
    const calls = stubWhop({ payments: [{ id: 'pay_x', status: 'paid', total: 50, checkout_configuration_id: 'ch_other', metadata: null }] });
    expect(await whopConfirm(rt, pass(db), async () => {})).toBe('pending');
    expect(calls[calls.length - 1].path).toMatch(/^payments\?company_id=biz_test&first=10&checkout_configuration_ids=ch_1$/);
    stubWhop({ payments: [paid().data] });
    expect(await whopConfirm(rt, pass(db), async () => {})).toBe('paid');
    expect(pass(db).status).toBe('paid');
  });
});

// ───────────── Pay-first Sprint: the form, its gate, the intake ─────────────

describe('pay-first Sprint form', () => {
  let db: DatabaseSync; let rt: Runtime;
  beforeEach(() => { db = freshDb(); });

  it('is gated like checkout: locked before the pitch, open after it, closed after the replay, paid goes to the Sprint page', async () => {
    seed(db, { startedAgoMin: 20 }); rt = makeRt(db);
    const locked = await sprintStartGate(rt, TOKEN);
    expect(locked.ok).toBe(false);
    expect(!locked.ok && locked.html).toMatch(/opens at 38:00/);
    unlock(db);
    expect((await sprintStartGate(rt, TOKEN)).ok).toBe(true);
    const closed = await sprintStartGate(rt, TOKEN, START + 60 * MIN + 48 * HOUR + 1);
    expect(!closed.ok && closed.html).toMatch(/has closed/);
    db.prepare("INSERT INTO webinar_passes (id, reg_id, lead_id, kind, status, amount, currency, paid_at, created_at, updated_at) VALUES ('wpx', 'r1', 'l1', 'offer', 'paid', 290000, 'usd', 1, 1, 1)").run();
    expect(await sprintStartGate(rt, TOKEN)).toMatchObject({ ok: false, redirect: `https://apply.test/webinar/sprint/${TOKEN}` });
    expect((await sprintStartGate(rt, 'nope')).ok).toBe(false);
  });

  it('under $1M is turned away', async () => {
    seed(db, { band: '<1m' }); unlock(db); rt = makeRt(db);
    const g = await sprintStartGate(rt, TOKEN);
    expect(!g.ok && g.html).toMatch(/\$1M or more/);
  });

  it('cleans the answers: revenue, EBITDA and industry required, a known band and timeline, https statements only', () => {
    expect(cleanApplication({ revenue: '$3M–$10M', ebitda: '$600k', industry: 'HVAC' }).complete).toBe(true);
    expect(cleanApplication({ revenue: '$3M–$10M', industry: 'HVAC' }).complete).toBe(false);
    const a = cleanApplication({ revenue: 'lots', ebitda: '1', industry: 'x', timeline: 'tomorrow', financials_url: 'javascript:alert(1)' });
    expect(a.data).toMatchObject({ revenue: null, timeline: null, financials_url: null });
    expect(a.complete).toBe(false);
  });

  it('the form: revenue band prefilled, Whop payment methods only with Whop, plan carried only when asked', () => {
    const base = { offerName: 'First Deal Sprint', price: '$2,900', plan: false, values: { revenue: '$3M–$10M' }, note: null, offerUrl: '/offer/x' };
    const html = startFormHtml({ ...base, whop: true });
    expect(html).toContain('<option selected>$3M–$10M</option>');
    expect(html).toContain('aria-label="Klarna"'); // Whop's real checkout methods, as one quiet row
    expect(html).not.toMatch(/splitit|affirm/i);
    expect(html).toContain('method="post"');
    expect(html).not.toContain('name="plan"');
    expect(startFormHtml({ ...base, whop: false, plan: true })).toContain('name="plan" value="1"');
    expect(startFormHtml({ ...base, whop: false })).not.toContain('Klarna');
    const err = startFormHtml({ ...base, whop: true, note: { text: CHECKOUT_UNAVAILABLE, email: 'team@gl.test' }, values: { industry: '<b>x</b>' } });
    expect(err).toContain(`${CHECKOUT_UNAVAILABLE} <a href="mailto:team@gl.test">Email the team</a>`);
    expect(html).not.toMatch(/book a call|strategy call/i);
    expect(err).not.toContain('<b>x</b>');
  });

  it('the answers become the Sprint intake when it is paid, never over one the buyer already saved', async () => {
    seed(db); unlock(db); rt = makeRt(db);
    await saveApplication(rt, reg(db), { revenue: '$3M–$10M', ebitda: '$600k', industry: 'HVAC', locations: '2 sites', buy_what: 'A competitor', timeline: 'Within 6 months', financials_url: null });
    db.prepare("INSERT INTO webinar_passes (id, reg_id, lead_id, kind, product, status, amount, currency, stripe_session_id, provider, created_at, updated_at) VALUES ('wp1', 'r1', 'l1', 'offer', 'First Deal Sprint', 'pending', 290000, 'usd', 'ch_1', 'whop', 1, 1)").run();
    stubWhop();
    await markPassPaid(rt, { sessionId: 'ch_1', paymentIntent: 'pay_1', amount: 290000, currency: 'usd', regId: 'r1', provider: 'whop' }, passPaidEffects);
    expect(db.prepare("SELECT revenue, ebitda, industry, locations, buy_what, timeline FROM deal_sprint_intake WHERE pass_id = 'wp1'").get()).toEqual({ revenue: '$3M–$10M', ebitda: '$600k', industry: 'HVAC', locations: '2 sites', buy_what: 'A competitor', timeline: 'Within 6 months' });
    expect(db.prepare("SELECT pass_id FROM deal_sprints WHERE pass_id = 'wp1'").get()).toBeTruthy();
    expect(db.prepare("SELECT pass_id FROM deal_sprint_applications WHERE reg_id = 'r1'").get()).toEqual({ pass_id: 'wp1' });
    // Already has an intake: left alone.
    db.prepare("UPDATE deal_sprint_intake SET industry = 'Plumbing' WHERE pass_id = 'wp1'").run();
    expect(await copyApplicationToIntake(rt, pass(db))).toBe(false);
    expect((db.prepare("SELECT industry FROM deal_sprint_intake WHERE pass_id = 'wp1'").get() as { industry: string }).industry).toBe('Plumbing');
  });

  describe('POST /sprint-start/:token', () => {
    const app = (settings: Record<string, string>) => {
      const a = new Hono<AppEnv>();
      a.use('*', async (c, next) => { c.set('settings', settings as never); await next(); });
      a.post('/webinar/sprint-start/:token', sprintStartSubmit);
      return a;
    };
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} };
    const post = (a: Hono<AppEnv>, fields: Record<string, string>, headers: Record<string, string> = { origin: 'https://apply.test' }) =>
      a.request(`https://apply.test/webinar/sprint-start/${TOKEN}`, { method: 'POST', body: new URLSearchParams(fields), headers }, { DB: d1(db) }, ctx as never);

    beforeEach(() => { seed(db); unlock(db); ticket(db, 't1'); });

    it('saves the answers, then goes straight to the Whop checkout', async () => {
      stubWhop();
      const res = await post(app(WHOP), { revenue: '$3M–$10M', ebitda: '$600k', industry: 'HVAC', timeline: 'Within 6 months' });
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('https://whop.com/checkout/ch_1/');
      expect(db.prepare("SELECT revenue, ebitda, industry FROM deal_sprint_applications WHERE reg_id = 'r1'").get()).toEqual({ revenue: '$3M–$10M', ebitda: '$600k', industry: 'HVAC' });
      expect(pass(db)).toMatchObject({ provider: 'whop', amount: 290000 });
    });

    it('refuses cross-site posts and sends an incomplete form back', async () => {
      stubWhop();
      expect((await post(app(WHOP), { revenue: '$3M–$10M', ebitda: '1', industry: 'x' }, { origin: 'https://evil.test' })).status).toBe(403);
      expect((await post(app(WHOP), { revenue: '$3M–$10M', ebitda: '1', industry: 'x' }, {})).status).toBe(403);
      const res = await post(app(WHOP), { revenue: '$3M–$10M' });
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(`/webinar/sprint-start/${TOKEN}?missing=1`);
      expect(db.prepare('SELECT COUNT(*) AS n FROM deal_sprint_applications').get()).toEqual({ n: 0 });
    });
  });
});

// ───────────── The Sprint page after paying: kickoff booking first ─────────────

describe('Sprint page kickoff', () => {
  it('embeds a Calendly link with name and email filled in; anything else is a button', () => {
    const u = new URL(kickoffEmbedUrl('https://calendly.com/gl/kickoff', { name: 'Dana Lee', email: 'dana@example.com', host: 'live.test' })!);
    expect(u.searchParams.get('name')).toBe('Dana Lee');
    expect(u.searchParams.get('email')).toBe('dana@example.com');
    expect(u.searchParams.get('embed_type')).toBe('Inline');
    expect(u.searchParams.get('embed_domain')).toBe('live.test');
    expect(kickoffEmbedUrl('https://cal.com/gl/kickoff', { host: 'x' })).toBeNull();
    expect(kickoffEmbedUrl('http://calendly.com/gl', { host: 'x' })).toBeNull();
    expect(kickoffEmbedUrl('https://calendly.com.evil.test/gl', { host: 'x' })).toBeNull();
    expect(kickoffEmbedUrl(null, { host: 'x' })).toBeNull();
  });

  it('opens on the kickoff booking until it is booked, with the payment welcome', () => {
    const rt = makeRt(freshDb(), { ...WHOP, DEAL_SPRINT_KICKOFF_URL: 'https://calendly.com/gl/kickoff' });
    const v = { ...samplePortal(rt), preview: false, welcome: true, token: TOKEN, kickoff: { booked: false, held: false, url: 'https://calendly.com/gl/kickoff' }, kickoffEmbed: 'https://calendly.com/gl/kickoff?embed_type=Inline' };
    const html = portalHtml(v);
    expect(html).toContain(DEAL_SPRINT_COPY.welcomePaid);
    expect(html).toContain(`data-kickoff="${TOKEN}"`);
    expect(html).toContain('<iframe src="https://calendly.com/gl/kickoff?embed_type=Inline"');
    expect(html.indexOf('data-kickoff=')).toBeLessThan(html.indexOf('<ol class="ds-days">'));
    const button = portalHtml({ ...v, kickoffEmbed: null });
    expect(button).toContain('data-kickoff-link');
    expect(button).not.toContain('<iframe');
    const booked = portalHtml({ ...v, kickoff: { ...v.kickoff, booked: true } });
    expect(booked).not.toContain('data-kickoff=');
  });
});

// ───────────── Connect Whop (Funnel HQ) ─────────────

describe('Connect Whop', () => {
  it('saves the company and creates the webhook for the needed events, keeping its secret', async () => {
    const db = freshDb();
    const rt = makeRt(db, { ...WHOP, WHOP_WEBHOOK_SECRET: '', WHOP_COMPANY_ID: '' });
    const calls = stubWhop();
    const r = await connectWhop(rt);
    expect(r).toMatchObject({ company: { id: 'biz_test' }, webhookUrl: 'https://apply.test/hooks/whop', webhook: { created: true }, steps: [] });
    const create = calls.find((c) => c.method === 'POST' && c.path === 'webhooks')!;
    expect(create.body).toMatchObject({ url: 'https://apply.test/hooks/whop', events: [...WHOP_EVENTS], resource_id: 'biz_test' });
    const saved = Object.fromEntries((db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]).map((x) => [x.key, x.value]));
    expect(saved).toMatchObject({ WHOP_COMPANY_ID: 'biz_test', WHOP_WEBHOOK_SECRET: 'ws_new_secret' });
  });

  it('when the key may not create webhooks, it returns the steps to do it by hand', async () => {
    const rt = makeRt(freshDb(), { ...WHOP, WHOP_WEBHOOK_SECRET: '' });
    stubWhop({ webhookCreate: 'forbidden' });
    const r = await connectWhop(rt);
    expect(r.webhook.created).toBe(false);
    expect(r.steps.join(' ')).toMatch(/Developer.*https:\/\/apply\.test\/hooks\/whop.*payment\.succeeded, refund\.created, refund\.updated/);
  });
});
