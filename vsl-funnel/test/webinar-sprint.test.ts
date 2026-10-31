import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/app';
import type { Lead } from '../src/funnel/leads';
import { auditEmail, auditFields } from '../src/content/copy-rules';
import { SEQUENCES } from '../src/integrations/sequences';
import { TEMPLATES, type TemplateCtx, renderEmail } from '../src/integrations/templates';
import { STRIPE_EVENTS, type PassRow, handleStripeEvent, markPassPaid, parsePerks, passConfig, registeredPassBlock } from '../src/webinar/pass';
import {
  DEFAULT_FAST_BONUS, closingTimes, createSprintCheckout, fastBonus, scheduleClosingEmails, skipClosingEmail, sprintCopy, sprintFaq, sprintPlan, sprintPlanForm, sprintPrice,
  sprintRoomConfig, sprintWindow, ticketCredit, unlockSprint,
} from '../src/webinar/sprint';
import { type Registration, type Session, WEBINAR_CYCLE } from '../src/webinar/webinar';

// ───────────── A real SQLite database shaped like D1, with every migration applied (as in webinar-pass.test.ts) ─────────────

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

const SETTINGS = {
  WEBINAR_PASS: 'required', WEBINAR_SEAT_PRICE: '100', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test', SALES_TIMEZONE: 'Australia/Sydney',
  WEBINAR_DURATION_MIN: '60', WEBINAR_REPLAY_HOURS: '48', WEBINAR_PITCH_AT: '38', WEBINAR_PASS_PLAN: '2x1550',
};
const makeRt = (db: DatabaseSync, settings: Record<string, string> = SETTINGS) =>
  ({ env: { DB: d1(db) }, settings, reps: [], origin: 'https://apply.test', waitUntil: () => {} }) as unknown as Runtime;

const MIN = 60_000, HOUR = 60 * MIN;
let START = 0;
function seed(db: DatabaseSync, o: { band?: string; startedAgoMin?: number } = {}) {
  const now = Date.now();
  START = now - (o.startedAgoMin ?? 40) * MIN;
  db.prepare("INSERT INTO leads (id, ref_code, created_at, updated_at, first_name, email, status, revenue_band, webinar_token) VALUES ('l1', 'R1', ?, ?, 'Dana', 'dana@example.com', 'partial', ?, 'tokentokentoken12345')").run(now, now, o.band ?? '3m-10m');
  db.prepare("INSERT INTO webinar_sessions (id, starts_at, mode, status, auto, created_at) VALUES ('s1', ?, 'evergreen', 'scheduled', 1, ?)").run(START, now);
  db.prepare("INSERT INTO webinar_registrations (id, token, session_id, lead_id, created_at, revenue_band) VALUES ('r1', 'tokentokentoken12345', 's1', 'l1', ?, ?)").run(now, o.band ?? '3m-10m');
}
const ticket = (db: DatabaseSync, id: string, o: { amount?: number; status?: string; refunded?: number; currency?: string } = {}) =>
  db.prepare("INSERT INTO webinar_passes (id, reg_id, lead_id, kind, status, amount, currency, refunded_amount, paid_at, created_at, updated_at) VALUES (?, 'r1', 'l1', 'seat', ?, ?, ?, ?, ?, ?, ?)")
    .run(id, o.status ?? 'paid', o.amount ?? 10000, o.currency ?? 'usd', o.refunded ?? 0, Date.now(), Date.now(), Date.now());
const reg = (db: DatabaseSync) => db.prepare("SELECT * FROM webinar_registrations WHERE id = 'r1'").get() as Registration & { offer_unlocked_at: number | null };
const session = (db: DatabaseSync) => db.prepare("SELECT * FROM webinar_sessions WHERE id = 's1'").get() as Session;
const pass = (db: DatabaseSync, where = "kind = 'offer'") => db.prepare(`SELECT * FROM webinar_passes WHERE ${where} ORDER BY created_at DESC LIMIT 1`).get() as PassRow;

/** Stripe stub: records every call and answers like the API. */
function stubStripe() {
  const calls: { method: string; path: string; form: URLSearchParams }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { method: string; body?: string }) => {
    const path = String(url).replace('https://api.stripe.com/v1/', '');
    calls.push({ method: init.method, path, form: new URLSearchParams(init.body ?? '') });
    const body = path === 'coupons' ? { id: 'co_1' } : path === 'checkout/sessions' ? { id: `cs_${calls.length}`, url: `https://checkout.stripe.test/${calls.length}` } : { id: path };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}
afterEach(() => { vi.unstubAllGlobals(); });

// ───────────── Settings parsing ─────────────

describe('Sprint settings', () => {
  it('the payment plan: "2x1550", anything else is off', () => {
    expect(sprintPlan('2x1550', 'USD')).toMatchObject({ count: 2, each: 1550, eachAmount: 155000, totalAmount: 310000, label: '2 payments of $1,550' });
    expect(sprintPlan('3 × $1,100', 'USD')).toMatchObject({ count: 3, eachAmount: 110000 });
    for (const bad of ['', 'off', '1x3000', '2x', 'x1550', '20x10']) expect(sprintPlan(bad, 'USD'), bad).toBeNull();
  });
  it('the fast-action bonus: default, custom, off', () => {
    expect(fastBonus('')).toEqual(parsePerks(DEFAULT_FAST_BONUS, {})[0]);
    expect(fastBonus('')!.title).toBe('Josh reviews your Deal Plan personally');
    expect(fastBonus('Extra call: thirty minutes with Josh')).toEqual({ title: 'Extra call', body: 'thirty minutes with Josh' });
    expect(fastBonus('off')).toBeNull();
  });
  it('custom perks can carry their day', () => {
    expect(parsePerks('Day 3: Your buy box: the business to buy first\nDays 2 to 3 | Capacity\nThe fee credited: all of it', {})).toEqual([
      { day: 'Day 3', title: 'Your buy box', body: 'the business to buy first' }, { day: 'Days 2 to 3', title: 'Capacity', body: '' }, { title: 'The fee credited', body: 'all of it' },
    ]);
  });
});

// ───────────── Price after the ticket credit ─────────────

describe('price after the ticket credit', () => {
  const cfg = passConfig(SETTINGS);
  it('reads "$3,000 − $100 ticket credit = $2,900 today", and never goes below zero', () => {
    const p = sprintPrice(cfg, null, 10000);
    expect(p).toMatchObject({ list: 300000, credit: 10000, today: 290000, line: '$3,000 − $100 ticket credit = $2,900 today' });
    expect(sprintPrice(cfg, null, 0).line).toBe('$3,000 today');
    expect(sprintPrice(cfg, null, 999999)).toMatchObject({ today: 0, credit: 300000 });
  });
  it('the plan takes the credit off the first payment', () => {
    const p = sprintPrice(cfg, sprintPlan('2x1550', 'USD'), 10000);
    expect(p.plan).toMatchObject({ first: 145000, each: 155000, total: 310000, credit: 10000, line: 'Or 2 payments of $1,550, the first one $1,450 after your ticket credit' });
  });
  it('sums paid, unrefunded ticket rows only', async () => {
    const db = freshDb(); seed(db);
    ticket(db, 't1');
    ticket(db, 't2', { amount: 10000, refunded: 4000 }); // partly refunded: 60 counts
    ticket(db, 't3', { status: 'refunded' });
    ticket(db, 't4', { status: 'pending' });
    ticket(db, 't5', { currency: 'aud' });
    expect(await ticketCredit(makeRt(db), 'l1', 'USD')).toBe(16000);
  });
});

// ───────────── Unlock and gating ─────────────

describe('unlock at the pitch, enforced by the server', () => {
  let db: DatabaseSync; let rt: Runtime;
  beforeEach(() => { db = freshDb(); });

  it('live: refused before the pitch minute; opens once at it; reloading never resets it', async () => {
    seed(db, { startedAgoMin: 30 }); rt = makeRt(db);
    const early = await unlockSprint(rt, reg(db), session(db), { pos: 2280 });
    expect(early).toMatchObject({ ok: false, reason: 'not yet' }); // the claimed position doesn't beat the live clock
    const at = START + 38 * MIN + 1000;
    const a = await unlockSprint(rt, reg(db), session(db), { pos: 2281 }, at);
    expect(a).toMatchObject({ ok: true, unlocked: true, unlockedAt: at, bonusEndsAt: at + 24 * HOUR });
    const b = await unlockSprint(rt, reg(db), session(db), {}, at + 10 * MIN);
    expect(b).toMatchObject({ ok: true, unlockedAt: at });
    expect(reg(db).offer_unlocked_at).toBe(at);
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE name = 'webinar_offer_unlocked'").get()).toEqual({ n: 1 });
  });

  it('replay: unlocks at the same position of the recording', async () => {
    seed(db, { startedAgoMin: 5 * 60 }); rt = makeRt(db);
    expect(await unlockSprint(rt, reg(db), session(db), { pos: 600, replay: true })).toMatchObject({ ok: false });
    expect(await unlockSprint(rt, reg(db), session(db), { pos: 2290, replay: true })).toMatchObject({ ok: true });
    expect(reg(db).max_position).toBe(2290);
  });

  it('under $1M and offer off: never unlocks', async () => {
    seed(db, { band: '<1m' });
    expect(await unlockSprint(makeRt(db), reg(db), session(db), {}, START + 50 * MIN)).toMatchObject({ ok: false, reason: 'off' });
    expect(await unlockSprint(makeRt(db, { ...SETTINGS, STRIPE_SECRET_KEY: '' }), reg(db), session(db), {}, START + 50 * MIN)).toMatchObject({ ok: false, reason: 'off' });
  });

  it('checkout is refused before the pitch and after the replay closes', async () => {
    seed(db, { startedAgoMin: 20 }); rt = makeRt(db); stubStripe();
    await expect(createSprintCheckout(rt, reg(db))).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/opens at 38:00/) });
    db.prepare("UPDATE webinar_registrations SET offer_unlocked_at = ? WHERE id = 'r1'").run(START + 38 * MIN);
    const closed = START + 60 * MIN + 48 * HOUR + 1;
    await expect(createSprintCheckout(rt, reg(db), {}, closed)).rejects.toMatchObject({ status: 410, message: 'The First Deal Sprint offer from your masterclass has closed.' });
  });

  it('a registration that reached the pitch (saved position) can check out even if the room never reported the unlock', async () => {
    seed(db, { startedAgoMin: 45 }); rt = makeRt(db); stubStripe();
    db.prepare("UPDATE webinar_registrations SET joined_at = ?, max_position = 2300 WHERE id = 'r1'").run(START);
    expect(await createSprintCheckout(rt, reg(db))).toMatchObject({ url: expect.stringContaining('checkout.stripe.test') });
    expect(reg(db).offer_unlocked_at).toBeGreaterThan(0);
  });
});

// ───────────── Checkout: ticket credit, fast-action bonus, credit toward the engagement ─────────────

describe('Sprint checkout', () => {
  let db: DatabaseSync; let rt: Runtime;
  beforeEach(() => { db = freshDb(); seed(db, { startedAgoMin: 45 }); rt = makeRt(db); db.prepare("UPDATE webinar_registrations SET offer_unlocked_at = ? WHERE id = 'r1'").run(START + 38 * MIN); });

  it('charges the price less the ticket, marks the fast-action bonus, and credits the full price once paid', async () => {
    ticket(db, 't1');
    const calls = stubStripe();
    const r = await createSprintCheckout(rt, reg(db), { from: 'room' });
    expect(r).toMatchObject({ url: 'https://checkout.stripe.test/1' });
    const form = calls[0].form;
    expect(form.get('mode')).toBe('payment');
    expect(form.get('line_items[0][price_data][unit_amount]')).toBe('290000');
    expect(form.get('line_items[0][price_data][product_data][name]')).toBe('First Deal Sprint');
    expect(form.get('metadata[fast_bonus]')).toBe('1');
    const row = pass(db);
    expect(row).toMatchObject({ amount: 290000, list_amount: 300000, ticket_credit: 10000, installments: 1, fast_bonus: 1, status: 'pending' });
    // Same click again: the open checkout is reused.
    expect(await createSprintCheckout(rt, reg(db), { from: 'room' })).toEqual({ url: 'https://checkout.stripe.test/1' });
    await markPassPaid(rt, { sessionId: row.stripe_session_id!, paymentIntent: 'pi_1', amount: 290000, currency: 'usd', regId: 'r1' }, async () => {});
    expect(pass(db)).toMatchObject({ status: 'paid', amount: 290000, credit_amount: 300000, installments_paid: 1 });
  });

  it('after the 24-hour window the bonus is no longer attached', async () => {
    stubStripe();
    await createSprintCheckout(rt, reg(db), {}, START + 38 * MIN + 24 * HOUR + 1);
    expect(pass(db).fast_bonus).toBe(0);
  });

  it('the bonus window ends at the offer deadline when that comes first', () => {
    const late = { ...reg(db), offer_unlocked_at: START + 60 * MIN + 40 * HOUR };
    const w = sprintWindow(rt, session(db), late, late.offer_unlocked_at);
    expect(w.bonusEndsAt).toBe(w.deadline);
    expect(w.deadline).toBe(START + 60 * MIN + 48 * HOUR);
  });

  it('a ticket credit that covers the price starts the Sprint without a charge', async () => {
    ticket(db, 't1', { amount: 400000 });
    const calls = stubStripe();
    expect(await createSprintCheckout(rt, reg(db))).toEqual({ paid: true });
    expect(calls).toHaveLength(0);
    expect(pass(db)).toMatchObject({ status: 'paid', amount: 0, credit_amount: 300000 });
  });

  it('buyers are not sold twice', async () => {
    stubStripe();
    db.prepare("INSERT INTO webinar_passes (id, reg_id, lead_id, kind, status, amount, currency, created_at, updated_at) VALUES ('wpx', 'r1', 'l1', 'offer', 'paid', 300000, 'usd', 1, 1)").run();
    expect(await createSprintCheckout(rt, reg(db))).toEqual({ paid: true });
  });
});

// ───────────── Payment plan ─────────────

describe('payment plan', () => {
  let db: DatabaseSync; let rt: Runtime;
  beforeEach(() => { db = freshDb(); seed(db, { startedAgoMin: 45 }); rt = makeRt(db); db.prepare("UPDATE webinar_registrations SET offer_unlocked_at = ? WHERE id = 'r1'").run(START + 38 * MIN); ticket(db, 't1'); });

  const invoice = (id: string, reason: string, amount: number, sub = 'sub_1') => ({
    id: 'evt_' + id, type: 'invoice.paid',
    data: { object: { id, billing_reason: reason, amount_paid: amount, currency: 'usd', subscription: sub, payment_intent: 'pi_' + id, subscription_details: { metadata: { pass_id: pass(db).id } } } },
  });

  it('subscription mode, monthly, with the ticket credit as a one-off coupon', async () => {
    const calls = stubStripe();
    await createSprintCheckout(rt, reg(db), { plan: true });
    expect(calls[0]).toMatchObject({ method: 'POST', path: 'coupons' });
    expect(Object.fromEntries(calls[0].form)).toMatchObject({ amount_off: '10000', currency: 'usd', duration: 'once', max_redemptions: '1' });
    const f = calls[1].form;
    expect(Object.fromEntries(f)).toMatchObject({
      mode: 'subscription', 'line_items[0][price_data][unit_amount]': '155000', 'line_items[0][price_data][recurring][interval]': 'month',
      'discounts[0][coupon]': 'co_1', 'subscription_data[metadata][installments]': '2',
    });
    expect(f.has('payment_intent_data[metadata][pass_id]')).toBe(false); // not allowed in subscription mode
    expect(pass(db)).toMatchObject({ amount: 145000, list_amount: 310000, ticket_credit: 10000, installments: 2 });
  });

  it('counts the payments, credits what was paid, and stops the subscription after the second (once)', async () => {
    const calls = stubStripe();
    await createSprintCheckout(rt, reg(db), { plan: true });
    const p = pass(db);
    const effects = vi.fn(async () => {});
    // Checkout completes (subscription mode: no payment intent, the subscription id instead).
    await handleStripeEvent(rt, { type: 'checkout.session.completed', data: { object: { id: p.stripe_session_id, payment_status: 'paid', amount_total: 145000, currency: 'usd', subscription: 'sub_1', client_reference_id: 'r1', metadata: { pass_id: p.id, reg_id: 'r1', kind: 'offer' } } } }, effects);
    expect(pass(db)).toMatchObject({ status: 'paid', stripe_subscription_id: 'sub_1', amount: 145000, credit_amount: 155000, installments_paid: 1 });
    expect(await handleStripeEvent(rt, invoice('in_1', 'subscription_create', 145000), effects)).toMatchObject({ installment: 1, planComplete: false });
    expect(pass(db).stripe_payment_intent).toBe('pi_in_1');
    expect(await handleStripeEvent(rt, invoice('in_2', 'subscription_cycle', 155000), effects)).toMatchObject({ installment: 2, planComplete: true, duplicate: false });
    expect(pass(db)).toMatchObject({ amount: 300000, credit_amount: 310000, installments_paid: 2 });
    expect(pass(db).plan_cancel_at).toBeGreaterThan(0);
    const cancels = calls.filter((c) => c.path === 'subscriptions/sub_1');
    expect(cancels).toHaveLength(1);
    expect(cancels[0].form.get('cancel_at_period_end')).toBe('true');
    // Stripe resends the same invoice: nothing changes, no second cancel.
    expect(await handleStripeEvent(rt, invoice('in_2', 'subscription_cycle', 155000), effects)).toMatchObject({ duplicate: true });
    expect(pass(db)).toMatchObject({ amount: 300000, installments_paid: 2 });
    expect(calls.filter((c) => c.path === 'subscriptions/sub_1')).toHaveLength(1);
    expect(effects).toHaveBeenCalledTimes(1);
  });

  it('the first invoice arriving before the checkout event still marks it paid', async () => {
    stubStripe();
    await createSprintCheckout(rt, reg(db), { plan: true });
    const effects = vi.fn(async () => {});
    await handleStripeEvent(rt, invoice('in_1', 'subscription_create', 145000), effects);
    expect(pass(db)).toMatchObject({ status: 'paid', stripe_subscription_id: 'sub_1', installments_paid: 1, credit_amount: 155000 });
    expect(effects).toHaveBeenCalledTimes(1);
  });

  it('a refunded installment withdraws the Sprint and ends the plan straight away', async () => {
    const calls = stubStripe();
    await createSprintCheckout(rt, reg(db), { plan: true });
    await handleStripeEvent(rt, invoice('in_1', 'subscription_create', 145000), async () => {});
    const r = await handleStripeEvent(rt, { type: 'charge.refunded', data: { object: { payment_intent: 'pi_in_1', refunded: true, amount_refunded: 145000, metadata: {} } } });
    expect(r).toMatchObject({ refunded: true, duplicate: false });
    expect(pass(db)).toMatchObject({ status: 'refunded', credit_amount: 0 });
    expect(calls.some((c) => c.method === 'DELETE' && c.path === 'subscriptions/sub_1')).toBe(true);
  });

  it('invoices that are not ours are ignored, and the webhook lists invoice.paid', async () => {
    expect(await handleStripeEvent(rt, { type: 'invoice.paid', data: { object: { id: 'in_x', subscription: 'sub_other' } } })).toMatchObject({ ignored: 'unknown subscription' });
    expect(await handleStripeEvent(rt, { type: 'invoice.paid', data: { object: { id: 'in_y' } } })).toMatchObject({ ignored: 'not a payment plan invoice' });
    expect(STRIPE_EVENTS).toContain('invoice.paid');
  });

  it('the plan form', () => {
    const cfg = passConfig(SETTINGS);
    const f = sprintPlanForm(cfg, sprintPlan('2x1550', 'USD')!, { passId: 'wp1', reg: { id: 'r1', token: 'tok', lead_id: 'l1' }, email: null, back: 'https://live.test/offer/tok', expiresAt: 1_800_000_000_000, coupon: null, creditLabel: null, fastBonus: false });
    expect(f).toMatchObject({ success_url: 'https://live.test/offer/tok?pass=success&cs={CHECKOUT_SESSION_ID}', 'line_items[0][price_data][product_data][name]': 'First Deal Sprint (2 payments of $1,550)' });
    expect(f['discounts[0][coupon]']).toBeUndefined();
  });
});

// ───────────── The room and the thank-you page ─────────────

describe('room and thank-you page', () => {
  it('the thank-you page no longer sells the Sprint', async () => {
    const db = freshDb(); seed(db);
    const r = await registeredPassBlock(makeRt(db, { ...SETTINGS, WEBINAR_PASS: 'upsell', WEBINAR_SEAT_PRICE: '' }), reg(db), {});
    expect(r.html).toBe('');
  });
  it('the room config: locked until the pitch, the real price line, the plan and the bonus; none for buyers or under $1M', async () => {
    const db = freshDb(); seed(db); ticket(db, 't1');
    const rt = makeRt(db);
    const c = (await sprintRoomConfig(rt, reg(db), session(db), true, {}))!;
    expect(c).toMatchObject({ unlocked: false, opensAtSec: 2280, priceLine: '$3,000 − $100 ticket credit = $2,900 today', price: '$2,900', capLabel: null });
    expect(c.copy.lockedHeading).toBe('The First Deal Sprint opens at 38:00');
    expect(c.plan).toBeNull(); // one payment only: buyers are never offered a plan
    expect(c.bonus?.title).toBe('Josh reviews your Deal Plan personally');
    expect(await sprintRoomConfig(rt, reg(db), session(db), false, {})).toBeNull();
    db.prepare("INSERT INTO webinar_passes (id, reg_id, lead_id, kind, status, amount, currency, created_at, updated_at) VALUES ('wpx', 'r1', 'l1', 'offer', 'paid', 300000, 'usd', 1, 1)").run();
    expect(await sprintRoomConfig(rt, reg(db), session(db), true, {})).toBeNull();
  });
  it('a real cap shows the real count', async () => {
    const db = freshDb(); seed(db);
    const c = (await sprintRoomConfig(makeRt(db, { ...SETTINGS, WEBINAR_PASS_WEEKLY_CAP: '5' }), reg(db), session(db), true, {}))!;
    expect(c.capLabel).toBe('5 of 5 First Deal Sprint places left this week');
  });
  it('social proof only from real paid Sprints, and only from 3 up; no call path anywhere in the copy', async () => {
    const db = freshDb(); seed(db);
    const rt = makeRt(db, { ...SETTINGS, EMAIL_REPLY_TO: 'Josh’s team <team@gl.test>' });
    const paid = (id: string) => db.prepare("INSERT INTO webinar_passes (id, reg_id, lead_id, kind, status, amount, currency, paid_at, created_at, updated_at) VALUES (?, 'rx', 'lx', 'offer', 'paid', 290000, 'usd', ?, 1, 1)").run(id, Date.now());
    paid('a'); paid('b');
    let c = (await sprintRoomConfig(rt, reg(db), session(db), true, {}))!;
    expect(c.started).toBeNull();
    expect(c.teamEmail).toBe('team@gl.test');
    paid('c');
    c = (await sprintRoomConfig(rt, reg(db), session(db), true, {}))!;
    expect(c.started).toBe(3);
    expect(JSON.stringify(c.copy)).not.toMatch(/call instead|strategy call|book a call/i);
    expect(JSON.stringify(c)).not.toMatch(/applyUrl/);
  });
});

// ───────────── Closing emails ─────────────

describe('closing emails', () => {
  const seq = SEQUENCES.webinar;
  it('appended to the webinar sequence, inside the cycle', () => {
    const names = seq.steps.map((s) => s.template);
    expect(names.slice(-4)).toEqual(['w_sprint_open', 'w_sprint_bonus', 'w_sprint_closing', 'w_sprint_closed']);
    expect(seq.steps.length).toBeLessThanOrEqual(seq.cycle!);
    expect(seq.cycle).toBe(WEBINAR_CYCLE);
  });

  it('timed from the unlock and the deadline', () => {
    const t = closingTimes({ unlockedAt: 1000 * HOUR, deadline: 1050 * HOUR, bonusEndsAt: 1024 * HOUR });
    expect(t).toEqual({ w_sprint_open: 1001 * HOUR, w_sprint_bonus: 1021 * HOUR, w_sprint_closing: 1046 * HOUR, w_sprint_closed: 1050 * HOUR + 30 * MIN });
  });

  it('the unlock re-times this registration’s rows (and revives ones skipped before it)', async () => {
    const db = freshDb(); seed(db, { startedAgoMin: 45 });
    const rt = makeRt(db);
    const j = seq.steps.findIndex((s) => s.template === 'w_sprint_open');
    db.prepare("INSERT INTO emails (id, lead_id, sequence, step, template, to_email, send_at, status, created_at) VALUES ('m1', 'l1', 'webinar', ?, 'w_sprint_open', 'dana@example.com', 1, 'skipped', 1)").run(j);
    const at = START + 38 * MIN;
    db.prepare("UPDATE webinar_registrations SET offer_unlocked_at = ? WHERE id = 'r1'").run(at);
    expect(await scheduleClosingEmails(rt, reg(db), session(db))).toBe(4);
    const rows = db.prepare("SELECT template, send_at, status FROM emails WHERE lead_id = 'l1' ORDER BY step").all() as { template: string; send_at: number; status: string }[];
    expect(rows.map((r) => r.template)).toEqual(['w_sprint_open', 'w_sprint_bonus', 'w_sprint_closing', 'w_sprint_closed']);
    expect(rows.every((r) => r.status === 'pending')).toBe(true);
    expect(rows[0].send_at).toBe(at + HOUR);
    expect(rows[3].send_at).toBe(START + 60 * MIN + 48 * HOUR + 30 * MIN);
  });

  it('only for viewers who unlocked it and haven’t bought, each at its moment', async () => {
    const db = freshDb(); seed(db, { startedAgoMin: 45 });
    const rt = makeRt(db);
    const lead = { id: 'l1', webinar_token: 'tokentokentoken12345' };
    const at = START + 38 * MIN, deadline = START + 60 * MIN + 48 * HOUR;
    expect(await skipClosingEmail(rt, lead, 'w_sprint_open', at + HOUR)).toBe(true); // never unlocked
    db.prepare("UPDATE webinar_registrations SET offer_unlocked_at = ? WHERE id = 'r1'").run(at);
    expect(await skipClosingEmail(rt, lead, 'w_sprint_open', at + HOUR)).toBe(false);
    expect(await skipClosingEmail(rt, lead, 'w_sprint_bonus', at + 21 * HOUR)).toBe(false);
    expect(await skipClosingEmail(rt, lead, 'w_sprint_bonus', at + 25 * HOUR)).toBe(true); // bonus over
    expect(await skipClosingEmail(rt, lead, 'w_sprint_closing', deadline - 4 * HOUR)).toBe(false);
    expect(await skipClosingEmail(rt, lead, 'w_sprint_closed', deadline - 4 * HOUR)).toBe(true); // not closed yet
    expect(await skipClosingEmail(rt, lead, 'w_sprint_closed', deadline + 30 * MIN)).toBe(false);
    db.prepare("INSERT INTO webinar_passes (id, reg_id, lead_id, kind, status, amount, currency, created_at, updated_at) VALUES ('wpx', 'r1', 'l1', 'offer', 'paid', 300000, 'usd', 1, 1)").run();
    expect(await skipClosingEmail(rt, lead, 'w_sprint_closing', deadline - 4 * HOUR)).toBe(true); // bought
  });

  it('render cleanly and pass the house copy rules, with and without the Sprint details', () => {
    const lead = { id: 'l', first_name: 'Dana', status: 'partial' } as Lead;
    const webinar = { title: 'The Masterclass', when: 'Tue 13 Oct, 7:00pm AEDT', room: 'https://live.test/room/x', replay: 'https://live.test/replay/x', ics: null, google: null, replayHours: 48, durationMin: 60, buyin: 'Time back with my kids' };
    const sprint = { name: 'First Deal Sprint', offer: 'https://live.test/offer/x', closes: 'Thu 15 Oct, 8:00pm AEDT', bonusEnds: 'Wed 14 Oct, 7:38pm AEDT', bonusTitle: 'Josh reviews your Deal Plan personally', bonusBody: 'before your Day 7 session, Josh reads your deal-structure memo and adds his notes', price: '$3,000', priceLine: '$3,000 − $100 ticket credit = $2,900 today', plan: '2 payments of $1,550', guarantee: passConfig({}).guarantee, apply: 'https://apply.test/w/x' };
    for (const s of [sprint, undefined]) {
      const ctx = { lead, name: 'Dana', siteName: 'G&L', link: (p: string) => p, bookingUrl: null, whatsappUrl: null, callTime: null, webinar: { ...webinar, sprint } } as unknown as TemplateCtx;
      if (!s) (ctx.webinar as { sprint?: unknown }).sprint = undefined;
      for (const t of ['w_sprint_open', 'w_sprint_bonus', 'w_sprint_closing', 'w_sprint_closed']) {
        const e = TEMPLATES[t](ctx);
        expect(auditEmail(e), t).toEqual([]);
        const { text } = renderEmail(e, { openPixel: null, unsubscribeUrl: 'u', signature: 'Josh', address: 'a' });
        expect(text, t).not.toMatch(/undefined|null|NaN|—/);
        expect(text.toLowerCase(), t).not.toMatch(/\bfree\b/);
        expect(text, t).toMatch(/seller rollover|strategy call|First Deal Sprint/);
      }
    }
    expect(TEMPLATES.w_sprint_closed({ lead, name: 'Dana', link: (p: string) => p, webinar: { ...webinar, sprint } } as unknown as TemplateCtx).body.join(' ')).toContain('The First Deal Sprint offer from your masterclass has closed. If what held you back');
  });
});

// ───────────── Copy ─────────────

describe('Sprint copy', () => {
  it('every customer-facing string passes the house copy rules', () => {
    const cfg = passConfig({ ...SETTINGS, WEBINAR_OFFER_SESSION_URL: 'https://calendly.com/x' });
    const noLink = passConfig(SETTINGS);
    const strings = { copy: sprintCopy(cfg), faq: sprintFaq(cfg), perks: cfg.perks, perksNoLink: noLink.perks, bonus: fastBonus(''), price: sprintPrice(cfg, sprintPlan('2x1550', 'USD'), 10000) };
    expect(auditFields(strings)).toEqual([]);
    const all = JSON.stringify(strings);
    expect(all).not.toMatch(/!|—/);
    expect(all.toLowerCase()).not.toMatch(/\bfree\b/);
    expect(all.toLowerCase()).not.toMatch(/you will (get|find|close|land)|guarantee[sd]? (you|your|results?|returns?|approval|funding|a deal)/);
    expect(cfg.perks.some((p) => /seller rollover/.test(p.body))).toBe(true);
  });
});
