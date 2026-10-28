import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/app';
import { auditCopy, auditFields } from '../src/content/copy-rules';
import { type Session, phase, replayEndsAt } from '../src/webinar/webinar';
import {
  applyPassReplay, capacity, checkoutForm, dealMaths, defaultPerks, handleStripeEvent, markPassPaid, parsePerks, passConfig, passCopy, passGate,
  seatRequired, verifyStripeSignature, weekStart, weekUsage,
} from '../src/webinar/pass';
import { hmacHex } from '../src/lib/crypto';

// ───────────── A real SQLite database shaped like D1, with every migration applied ─────────────
// Node's built-in SQLite (the project has no @types/node, so the few calls used are typed here).

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

const STRIPE_SETTINGS = { WEBINAR_PASS: 'upsell', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test', SALES_TIMEZONE: 'Australia/Sydney', WEBINAR_DURATION_MIN: '60', WEBINAR_REPLAY_HOURS: '48' };

function makeRt(db: DatabaseSync, settings: Record<string, string> = STRIPE_SETTINGS) {
  return { env: { DB: d1(db) }, settings, reps: [], origin: 'https://apply.test', waitUntil: () => {} } as unknown as Runtime;
}

const START = Date.parse('2026-10-27T08:00:00Z');
function seed(db: DatabaseSync) {
  const now = Date.now();
  db.prepare("INSERT INTO leads (id, ref_code, created_at, updated_at, first_name, email, status, revenue_band) VALUES ('l1', 'R1', ?, ?, 'Dana', 'dana@example.com', 'partial', '3m-10m')").run(now, now);
  db.prepare("INSERT INTO webinar_sessions (id, starts_at, mode, status, auto, created_at) VALUES ('s1', ?, 'evergreen', 'scheduled', 1, ?)").run(START, now);
  db.prepare("INSERT INTO webinar_registrations (id, token, session_id, lead_id, created_at) VALUES ('r1', 'tokentokentoken12345', 's1', 'l1', ?)").run(now);
}
const pending = (db: DatabaseSync, id: string, o: { session?: string; kind?: string; created?: number; expires?: number; status?: string; paid?: number | null } = {}) =>
  db.prepare('INSERT INTO webinar_passes (id, reg_id, lead_id, kind, status, amount, currency, stripe_session_id, expires_at, paid_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'r1', 'l1', o.kind ?? 'offer', o.status ?? 'pending', 300000, 'usd', o.session ?? null, o.expires ?? Date.now() + 30 * 60_000, o.paid ?? null, o.created ?? Date.now(), Date.now());

async function stripeHeader(secret: string, payload: string, t = Math.floor(Date.now() / 1000), extra: string[] = []) {
  return [`t=${t}`, ...extra, `v1=${await hmacHex(secret, `${t}.${payload}`)}`].join(',');
}

// ───────────── Stripe signatures ─────────────

describe('Stripe webhook signature', () => {
  const secret = 'whsec_abc123';
  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });

  it('accepts a valid, fresh signature', async () => {
    expect(await verifyStripeSignature(secret, body, await stripeHeader(secret, body))).toBe(true);
  });
  it('rejects a tampered payload, a wrong secret and a missing header', async () => {
    const h = await stripeHeader(secret, body);
    expect(await verifyStripeSignature(secret, body.replace('evt_1', 'evt_2'), h)).toBe(false);
    expect(await verifyStripeSignature('whsec_other', body, h)).toBe(false);
    expect(await verifyStripeSignature(secret, body, null)).toBe(false);
    expect(await verifyStripeSignature(secret, body, 'v1=abc')).toBe(false); // no timestamp
  });
  it('rejects a timestamp outside the 5-minute tolerance, either way', async () => {
    const now = Date.now();
    const old = Math.floor(now / 1000) - 301;
    expect(await verifyStripeSignature(secret, body, await stripeHeader(secret, body, old), now)).toBe(false);
    expect(await verifyStripeSignature(secret, body, await stripeHeader(secret, body, Math.floor(now / 1000) + 400), now)).toBe(false);
    expect(await verifyStripeSignature(secret, body, await stripeHeader(secret, body, Math.floor(now / 1000) - 299), now)).toBe(true);
  });
  it('accepts when any of several v1 signatures matches (secret roll), and ignores v0', async () => {
    const h = await stripeHeader(secret, body, undefined, ['v1=' + 'f'.repeat(64), 'v0=deadbeef']);
    expect(await verifyStripeSignature(secret, body, h)).toBe(true);
    const t = Math.floor(Date.now() / 1000);
    expect(await verifyStripeSignature(secret, body, `t=${t},v1=${'0'.repeat(64)},v1=${'1'.repeat(64)}`)).toBe(false);
  });
});

// ───────────── Paid / refunded, idempotent ─────────────

describe('payments', () => {
  let db: DatabaseSync;
  let rt: Runtime;
  beforeEach(() => { db = freshDb(); seed(db); rt = makeRt(db); });

  const completed = (session: string, extra: Record<string, unknown> = {}) => ({
    id: 'evt_' + session, type: 'checkout.session.completed',
    data: { object: { id: session, payment_status: 'paid', payment_intent: 'pi_' + session, amount_total: 300000, currency: 'usd', client_reference_id: 'r1', metadata: { pass_id: 'wp1', reg_id: 'r1', kind: 'offer' }, ...extra } },
  });

  it('marks a checkout paid once, however many times Stripe (or the return page) reports it', async () => {
    pending(db, 'wp1', { session: 'cs_1' });
    const effects = vi.fn(async () => {});
    const a = await handleStripeEvent(rt, completed('cs_1'), effects);
    const b = await handleStripeEvent(rt, completed('cs_1'), effects);
    const c = await markPassPaid(rt, { sessionId: 'cs_1', paymentIntent: 'pi_cs_1', amount: 300000, currency: 'usd', regId: 'r1' }, effects);
    expect(a).toMatchObject({ paid: 'wp1', duplicate: false });
    expect(b).toMatchObject({ duplicate: true });
    expect(c).toMatchObject({ duplicate: true });
    expect(effects).toHaveBeenCalledTimes(1);
    const row = db.prepare("SELECT * FROM webinar_passes WHERE id = 'wp1'").get() as Record<string, unknown>;
    expect(row).toMatchObject({ status: 'paid', stripe_payment_intent: 'pi_cs_1', credit_amount: 300000 });
  });

  it('attaches a webhook that beat our own write to the pending row by pass id', async () => {
    pending(db, 'wp1'); // no session id saved yet
    const effects = vi.fn(async () => {});
    expect(await handleStripeEvent(rt, completed('cs_late'), effects)).toMatchObject({ paid: 'wp1' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM webinar_passes').get()).toEqual({ n: 1 });
  });

  it('ignores unpaid sessions and checkouts that are not ours', async () => {
    pending(db, 'wp1', { session: 'cs_1' });
    const effects = vi.fn(async () => {});
    expect(await handleStripeEvent(rt, completed('cs_1', { payment_status: 'unpaid' }), effects)).toMatchObject({ ignored: 'payment unpaid' });
    expect(await handleStripeEvent(rt, completed('cs_x', { metadata: {} }), effects)).toMatchObject({ ignored: 'not a masterclass checkout' });
    expect(effects).not.toHaveBeenCalled();
  });

  it('a paid seat carries no credit', async () => {
    pending(db, 'wp1', { session: 'cs_seat', kind: 'seat' });
    await handleStripeEvent(rt, completed('cs_seat', { metadata: { pass_id: 'wp1', reg_id: 'r1', kind: 'seat' }, amount_total: 4900 }), async () => {});
    expect(db.prepare("SELECT status, credit_amount, amount FROM webinar_passes WHERE id = 'wp1'").get()).toEqual({ status: 'paid', credit_amount: 0, amount: 4900 });
  });

  it('a full refund withdraws the offer (credit and long replay); a partial one is only recorded; repeats are no-ops', async () => {
    pending(db, 'wp1', { session: 'cs_1' });
    await handleStripeEvent(rt, completed('cs_1'), async (r, p) => { await applyPassReplay(r, p.lead_id, true); });
    expect((db.prepare("SELECT replay_until FROM webinar_registrations WHERE id = 'r1'").get() as { replay_until: number }).replay_until).toBe(START + 60 * 60_000 + 30 * 86_400_000);
    const refund = (refunded: boolean, amt: number) => ({ type: 'charge.refunded', data: { object: { payment_intent: 'pi_cs_1', refunded, amount_refunded: amt, metadata: { pass_id: 'wp1' } } } });
    expect(await handleStripeEvent(rt, refund(false, 10000))).toMatchObject({ refunded: true, partial: true });
    expect(db.prepare("SELECT status, refunded_amount FROM webinar_passes WHERE id = 'wp1'").get()).toEqual({ status: 'paid', refunded_amount: 10000 });
    expect(await handleStripeEvent(rt, refund(true, 300000))).toMatchObject({ refunded: true, duplicate: false });
    expect(await handleStripeEvent(rt, refund(true, 300000))).toMatchObject({ duplicate: true });
    expect(db.prepare("SELECT status, credit_amount FROM webinar_passes WHERE id = 'wp1'").get()).toEqual({ status: 'refunded', credit_amount: 0 });
    expect(db.prepare("SELECT replay_until FROM webinar_registrations WHERE id = 'r1'").get()).toEqual({ replay_until: null });
  });

  it('expired checkouts stop holding a place', async () => {
    pending(db, 'wp1', { session: 'cs_1' });
    await handleStripeEvent(rt, { type: 'checkout.session.expired', data: { object: { id: 'cs_1' } } });
    expect(db.prepare("SELECT status FROM webinar_passes WHERE id = 'wp1'").get()).toEqual({ status: 'expired' });
  });
});

// ───────────── Modes, fallbacks, the seat gate ─────────────

describe('modes and fallbacks', () => {
  it('without a Stripe key nothing is sold and HQ is told why', () => {
    const up = passConfig({ WEBINAR_PASS: 'upsell' });
    expect(up.mode).toBe('off');
    expect(up.reason).toMatch(/Stripe secret key is missing/);
    const req = passConfig({ WEBINAR_PASS: 'required', WEBINAR_SEAT_PRICE: '49' });
    expect(req.mode).toBe('off');
    expect(req.reason).toMatch(/seats stay free/);
    expect(passConfig({}).mode).toBe('off');
    expect(passConfig({}).reason).toBeNull();
    expect(passConfig({ WEBINAR_PASS: 'nonsense', STRIPE_SECRET_KEY: 'sk' }).mode).toBe('off');
  });

  it('defaults: Acquisition Assessment, $3,000 USD, 30-day replay, 7-day guarantee', () => {
    const c = passConfig({ WEBINAR_PASS: 'upsell', STRIPE_SECRET_KEY: 'sk' });
    expect(c).toMatchObject({ mode: 'upsell', offerName: 'Acquisition Assessment', offerNoun: 'assessment', price: 3000, currency: 'USD', amount: 300000, priceLabel: '$3,000', replayDays: 30, seat: null, weeklyCap: null });
    expect(c.perks.map((p) => p.title)).toEqual([
      'A review of your business and acquisition capacity', 'A target profile', 'A deal-structure memo', 'A 60-minute assessment session with Josh’s team',
      'Your deal pack, ready straight away', 'The masterclass replay for 30 days', 'The full $3,000 credited if you continue', '7-day money-back guarantee',
    ]);
    expect(passConfig({ WEBINAR_PASS_CURRENCY: 'jpy', WEBINAR_PASS_PRICE: '50000' }).amount).toBe(50000); // zero-decimal currency
  });

  it('the seat price only applies in required mode, and blank means free', () => {
    expect(passConfig({ WEBINAR_PASS: 'upsell', STRIPE_SECRET_KEY: 'sk', WEBINAR_SEAT_PRICE: '49' }).seat).toBeNull();
    expect(passConfig({ WEBINAR_PASS: 'required', STRIPE_SECRET_KEY: 'sk' }).seat).toBeNull();
    expect(passConfig({ WEBINAR_PASS: 'required', STRIPE_SECRET_KEY: 'sk', WEBINAR_SEAT_PRICE: '49' }).seat).toEqual({ price: 49, amount: 4900, label: '$49' });
    const rt = (s: Record<string, string>) => ({ settings: s }) as unknown as Runtime;
    expect(seatRequired(rt({ WEBINAR_PASS: 'required', STRIPE_SECRET_KEY: 'sk', WEBINAR_SEAT_PRICE: '49' }))).toBe(true);
    expect(seatRequired(rt({ WEBINAR_PASS: 'required', WEBINAR_SEAT_PRICE: '49' }))).toBe(false); // no key: registration stays free
    expect(seatRequired(rt({ WEBINAR_PASS: 'required', STRIPE_SECRET_KEY: 'sk' }))).toBe(false);
  });

  it('the room gate opens on a paid seat or a paid offer, and when the requirement is lifted', async () => {
    const db = freshDb(); seed(db);
    const settings = { ...STRIPE_SETTINGS, WEBINAR_PASS: 'required', WEBINAR_SEAT_PRICE: '49' };
    const reg = { lead_id: 'l1', pass_required: 1 };
    expect(await passGate(makeRt(db, settings), reg)).toBe(true);
    expect(await passGate(makeRt(db, settings), { ...reg, pass_required: 0 })).toBe(false); // signed up while free
    expect(await passGate(makeRt(db, { ...settings, STRIPE_SECRET_KEY: '' }), reg)).toBe(false); // keys removed: open
    expect(await passGate(makeRt(db, { ...settings, WEBINAR_SEAT_PRICE: '' }), reg)).toBe(false);
    pending(db, 'wp1', { kind: 'seat', status: 'paid', paid: Date.now() });
    expect(await passGate(makeRt(db, settings), reg)).toBe(false);
  });

  it('custom perk lists are parsed, with placeholders filled', () => {
    expect(parsePerks('Capacity review: what you can carry\nTarget profile\nReplay for {replay_days} days — all of it', { replay_days: '30' })).toEqual([
      { title: 'Capacity review', body: 'what you can carry' }, { title: 'Target profile', body: '' }, { title: 'Replay for 30 days', body: 'all of it' },
    ]);
  });
});

// ───────────── Capacity: real numbers only ─────────────

describe('weekly capacity', () => {
  it('maths', () => {
    expect(capacity(null, 50)).toMatchObject({ capped: false, full: false, label: null, left: null });
    expect(capacity(10, 7)).toMatchObject({ capped: true, left: 3, full: false, label: '3 of 10 Acquisition Assessment places left this week' });
    expect(capacity(10, 10)).toMatchObject({ left: 0, full: true, label: null });
    expect(capacity(10, 12)).toMatchObject({ left: 0, full: true });
    expect(capacity(1, 0).label).toBe('1 of 1 Acquisition Assessment places left this week');
  });

  it('the week starts on Monday at midnight in the sales time zone', () => {
    const wed = Date.parse('2026-10-28T03:00:00Z'); // Wed 14:00 in Sydney
    const mon = weekStart(wed, 'Australia/Sydney');
    expect(new Date(mon).toISOString()).toBe('2026-10-25T13:00:00.000Z'); // Mon 26 Oct 00:00 AEDT
    expect(weekStart(mon, 'Australia/Sydney')).toBe(mon);
    expect(weekStart(mon - 1, 'Australia/Sydney')).toBe(mon - 7 * 86_400_000);
  });

  it('counts this week’s paid offers and open checkouts only', async () => {
    const db = freshDb(); seed(db);
    const rt = makeRt(db, { ...STRIPE_SETTINGS, WEBINAR_PASS_WEEKLY_CAP: '5' });
    const cfg = passConfig(rt.settings);
    const now = Date.now();
    const lastWeek = weekStart(now, cfg.tz) - 3600_000;
    pending(db, 'a', { status: 'paid', paid: now - 1000 }); // counts
    pending(db, 'b'); // open checkout: counts
    pending(db, 'c', { expires: now - 1000 }); // lapsed: no
    pending(db, 'd', { status: 'refunded', paid: now - 1000 }); // refunded: no
    pending(db, 'e', { status: 'paid', paid: lastWeek, created: lastWeek }); // last week: no
    pending(db, 'f', { kind: 'seat', status: 'paid', paid: now - 1000 }); // a seat, not the offer: no
    expect(await weekUsage(rt, cfg, now)).toBe(2);
  });
});

// ───────────── Replay window override ─────────────

describe('replay override', () => {
  const rt = { settings: { WEBINAR_DURATION_MIN: '60', WEBINAR_REPLAY_HOURS: '48' } } as unknown as Runtime;
  const s = { id: 's', starts_at: START, status: 'scheduled', mode: 'evergreen' } as Session;
  const end = START + 3_600_000;
  it('keeps the global window without an override', () => {
    expect(replayEndsAt(rt, s)).toBe(end + 48 * 3_600_000);
    expect(phase(rt, s, end + 49 * 3_600_000)).toBe('expired');
  });
  it('a buyer’s registration keeps the replay for 30 days', () => {
    const until = end + 30 * 86_400_000;
    expect(phase(rt, s, end + 49 * 3_600_000, until)).toBe('replay');
    expect(phase(rt, s, until - 1, until)).toBe('replay');
    expect(phase(rt, s, until + 1, until)).toBe('expired');
    expect(replayEndsAt(rt, s, until)).toBe(until);
  });
  it('an override shorter than the global window never cuts it short', () => {
    expect(replayEndsAt(rt, s, end + 1)).toBe(end + 48 * 3_600_000);
    expect(phase(rt, s, START + 10 * 60_000, end + 30 * 86_400_000)).toBe('running');
  });
});

// ───────────── Checkout body, maths, copy ─────────────

describe('checkout and copy', () => {
  it('builds a one-click Checkout Session with the email prefilled and the registration attached', () => {
    const cfg = passConfig({ WEBINAR_PASS: 'upsell', STRIPE_SECRET_KEY: 'sk' });
    const f = checkoutForm(cfg, { kind: 'offer', passId: 'wp1', reg: { id: 'r1', token: 'tok', lead_id: 'l1' }, email: 'dana@example.com', back: 'https://live.test/room/tok', expiresAt: 1_800_000_000_000 });
    expect(f).toMatchObject({
      mode: 'payment', customer_email: 'dana@example.com', client_reference_id: 'r1',
      'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': '300000', 'line_items[0][price_data][product_data][name]': 'Acquisition Assessment',
      'metadata[pass_id]': 'wp1', 'metadata[lead_id]': 'l1', 'metadata[reg_token]': 'tok', 'payment_intent_data[metadata][pass_id]': 'wp1',
      success_url: 'https://live.test/room/tok?pass=success&cs={CHECKOUT_SESSION_ID}', cancel_url: 'https://live.test/room/tok?pass=cancel', expires_at: '1800000000',
    });
  });

  it('the deal maths: the max price clears exactly 1.5x', () => {
    const m = dealMaths(500_000, 1_500_000);
    expect(m.base.debt + m.base.note + m.base.rollover).toBeCloseTo(1_500_000);
    expect(dealMaths(500_000, m.maxPrice).base.dscr).toBeCloseTo(1.5, 6);
    expect(m.longerNote.dscr).toBeGreaterThan(m.base.dscr);
    expect(m.moreRollover.dscr).toBeGreaterThan(m.base.dscr);
  });

  it('every customer-facing string passes the house copy rules', () => {
    const cfg = passConfig({ WEBINAR_PASS: 'upsell', STRIPE_SECRET_KEY: 'sk', WEBINAR_OFFER_SESSION_URL: 'https://calendly.com/x' });
    const strings = { copy: passCopy(cfg), perks: cfg.perks, noLink: defaultPerks({ priceLabel: '$3,000', replayDays: 30, replayHours: 48, guarantee: '7-day money-back guarantee', sessionUrl: null }), capacity: capacity(10, 3).label };
    expect(auditFields(strings)).toEqual([]);
    const all = JSON.stringify(strings);
    expect(all).not.toMatch(/!/);
    expect(all.toLowerCase()).not.toMatch(/\bfree\b/);
    expect(all.toLowerCase()).not.toMatch(/guarantee[sd]? (you|your|results?|returns?|approval|funding|a deal)/);
    expect(auditCopy(passConfig({ WEBINAR_PASS: 'required', STRIPE_SECRET_KEY: 'sk', WEBINAR_SEAT_PRICE: '49' }).reason ?? '')).toEqual([]);
  });
});
