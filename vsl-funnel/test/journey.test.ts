import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/app';
import { auditCopy, auditEmail } from '../src/content/copy-rules';
import { PATHS_COPY, twoPaths, twoPathsHtml, twoPathsText } from '../src/rooms/plan-paths';
import { cleanPlan, summaryEmail } from '../src/rooms/engage';
import {
  buyDepositAddon, declineDepositAddon, depositAddonCardHtml, depositAddonConfig, depositAddonCopy, depositAddonToken, depositAddonTotal, settleDepositAddon,
} from '../src/sales/deposit-addon';
import { type PassRow, passPaidEffects } from '../src/webinar/pass';
import { WHOP_PRODUCT, handleWhopEvent } from '../src/webinar/whop';
import { GA4_EVENTS, META_EVENTS } from '../src/tracking/catalog';
import { SETTINGS } from '../src/settings';
import { buyerJourney, commonPaths, minutesBucket, pathSteps, sourceToken, syncBuyerPaths } from '../src/attribution/buyer-path';

// ───────────── A real SQLite database shaped like D1, with every migration applied ─────────────

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
const pending: Promise<unknown>[] = [];
const BASE = { WHOP_API_KEY: 'apik_test', WHOP_WEBHOOK_SECRET: 'ws_test', WHOP_COMPANY_ID: 'biz_test', SALES_TIMEZONE: 'Australia/Sydney', WEBINAR_PASS: 'required', WEBINAR_SEAT_PRICE: '100', ADMIN_PASSWORD: 'devpass' };
const ADDON = { ...BASE, DEPOSIT_ADDON: 'Lender-ready financial pack', DEPOSIT_ADDON_PRICE: '750', DEPOSIT_ADDON_DESCRIPTION: 'Josh’s team prepares your last two years of financials into the pack lenders ask for.' };
const makeRt = (db: DatabaseSync, settings: Record<string, string> = BASE) =>
  ({ env: { DB: d1(db), ADMIN_PASSWORD: 'devpass' }, settings: { ...settings }, reps: [], origin: 'https://apply.test', waitUntil: (p: Promise<unknown>) => { pending.push(p); } }) as unknown as Runtime;
afterEach(() => { vi.unstubAllGlobals(); pending.length = 0; });

const HOUR = 3_600_000, DAY = 24 * HOUR;
const T0 = Date.parse('2026-10-20T10:00:00Z');

// ═════════════ 1. The Deal Plan's two paths ═════════════

describe('Deal Plan: conservative vs ambitious', () => {
  it('runs the 1.5x test on the person’s own numbers for both paths', () => {
    const p = twoPaths(900_000, 550_000)!;
    expect(p.conservative).toMatchObject({ deals: 1, cashFlow: 900_000, debtService: 550_000, ratio: 1.64, passes: true, maxDebtService: 600_000, leftAfter: 350_000, stressRatio: 1.31, stressPasses: false });
    // Three targets like theirs: the same ratio, but one business down a fifth hurts the group far less.
    expect(p.ambitious).toMatchObject({ deals: 3, cashFlow: 2_700_000, debtService: 1_650_000, ratio: 1.64, passes: true, maxDebtService: 1_800_000, leftAfter: 1_050_000, stressRatio: 1.53, stressPasses: true });
    expect(twoPaths(null, 550_000)).toBeNull();
    expect(twoPaths(900_000, 0)).toBeNull();
  });

  it('a failing structure says how far the payments must come down, per deal', () => {
    const lines = twoPathsText(600_000, 500_000);
    expect(lines.join(' ')).toContain('1.20x, below 1.5x');
    expect(lines.join(' ')).toContain('$400,000 a year or less per deal');
    expect(twoPathsText(900_000, 550_000).join(' ')).not.toContain('or less per deal');
  });

  it('labels what is assumed, names seller rollover with the funding, and passes the copy rules', () => {
    const lines = twoPathsText(900_000, 550_000);
    const all = lines.join(' ');
    expect(all).toMatch(/seller rollover/);
    expect(all).toMatch(/commercial debt/);
    expect(all).toMatch(/illustrative/);
    expect(all).not.toMatch(/guarantee|will (make|earn)/i);
    for (const l of lines) expect(auditCopy(l), l).toEqual([]);
    for (const v of Object.values(PATHS_COPY)) if (typeof v === 'string') expect(auditCopy(v), v).toEqual([]);
    for (const v of Object.values(PATHS_COPY.rows)) expect(auditCopy(v), v).toEqual([]);
    expect(twoPathsText(null, null)).toEqual([]);
  });

  it('the summary email carries both paths and still passes the email rules', () => {
    const plan = cleanPlan({ industry: 'HVAC', size: '$2M to $5M', geography: 'Dallas', owners_per_week: '25', cash_flow: '$900k', debt_service: '550,000', action_1: 'Write my buy box', action_2: 'List 50 owners', action_3: 'Send 25 letters' });
    const m = summaryEmail({ name: 'Dana', title: 'Buy your first competitor', points: 40, unlocks: [], plan, planUrl: 'https://apply.test/rooms/plan/x', bought: false, offer: null, applied: false });
    const body = m.paras.join(' ');
    expect(body).toContain('Conservative: one small bolt-on now: $900,000 of cash flow against $550,000');
    expect(body).toContain('Ambitious: a 3-target roll-up (targets two and three illustrative): $2,700,000');
    expect(auditEmail({ subject: m.subject, preheader: m.preheader, body: m.paras })).toEqual([]);
    // No numbers in the plan: no paths.
    const bare = summaryEmail({ name: 'Dana', title: 'X', points: 0, unlocks: [], plan: cleanPlan({ industry: 'HVAC' }), planUrl: null, bought: false, offer: null, applied: false });
    expect(bare.paras.join(' ')).not.toContain('Two paths');
  });

  it('the plan page block shows both columns with the test results', () => {
    const html = twoPathsHtml(900_000, 550_000);
    expect(html).toContain(PATHS_COPY.conservativeName);
    expect(html).toContain(PATHS_COPY.ambitiousName);
    expect(html).toContain('1.64x, passes');
    expect(html).toContain('1.31x, below 1.5x'); // the single deal's stress case
    expect(html).toContain('seller rollover');
    expect(html).not.toMatch(/<script/);
    expect(twoPathsHtml(null, 1)).toBe('');
  });
});

// ═════════════ 2. The post-deposit one-click add-on ═════════════

function seedDeposit(db: DatabaseSync, o: { card?: boolean } = {}) {
  const now = Date.now();
  db.prepare("INSERT INTO leads (id, ref_code, created_at, updated_at, first_name, last_name, email, status, revenue_band) VALUES ('l1', 'R1', ?, ?, 'Dana', 'Lee', 'dana@example.com', 'partial', '3m-10m')").run(now - DAY, now);
  db.prepare(`INSERT INTO webinar_passes (id, reg_id, lead_id, kind, product, status, amount, currency, paid_at, provider, stripe_session_id, stripe_payment_intent, whop_member_id, whop_payment_method_id, card_brand, card_last4, source, ref_id, credit_amount, created_at, updated_at)
    VALUES ('dep1', 'live:tok', 'l1', 'deposit', 'Engagement deposit', 'paid', 500000, 'usd', ?, 'whop', 'whop_pay_dep', 'pay_dep', ?, ?, 'mastercard', '5454', 'live', 'e1', 500000, ?, ?)`)
    .run(now - 60_000, o.card === false ? null : 'mber_9', o.card === false ? null : 'payt_dep', now, now);
  // An older ticket on a different card: the add-on must not use it.
  db.prepare(`INSERT INTO webinar_passes (id, reg_id, lead_id, kind, product, status, amount, currency, paid_at, provider, stripe_session_id, whop_member_id, whop_payment_method_id, card_brand, card_last4, created_at, updated_at)
    VALUES ('t1', 'r1', 'l1', 'live_ticket', 'Live ticket', 'paid', 10000, 'usd', ?, 'whop', 'ch_t', 'mber_1', 'payt_ticket', 'visa', '4242', ?, ?)`).run(now - DAY, now, now);
}
const addons = (db: DatabaseSync) => db.prepare("SELECT * FROM webinar_passes WHERE kind = 'deposit_addon'").all() as (PassRow & Record<string, unknown>)[];
const REG = 'regtokenregtoken1234';

interface Call { method: string; path: string; headers: Record<string, string>; body: Record<string, unknown> | null }
function stubWhop(o: { create?: { status: number; message: string }; statuses?: Record<string, unknown>[] } = {}) {
  const calls: Call[] = [];
  let s = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const u = String(url);
    const path = u.replace('https://api.whop.com/api/v1/', '');
    calls.push({ method: init.method ?? 'GET', path, headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (!u.startsWith('https://api.whop.com/')) return json(200, { ok: true });
    if (path === 'payments' && init.method === 'POST') return o.create ? json(o.create.status, { error: { message: o.create.message } }) : json(201, { id: 'pay_da1', status: 'open' });
    if (/^payments\/[^/]+\/status$/.test(path)) { const list = o.statuses ?? [{ status: 'succeeded' }]; return json(200, list[Math.min(s++, list.length - 1)]); }
    if (path.startsWith('payments/')) return json(200, {});
    return json(404, { error: { message: 'not stubbed' } });
  }));
  return calls;
}
const noSleep = async () => {};

describe('deposit add-on: settings and copy', () => {
  it('is off by default and needs both a name and a valid price', () => {
    expect(depositAddonConfig({}, 'USD')).toBeNull();
    expect(depositAddonConfig({ DEPOSIT_ADDON: 'Pack' }, 'USD')).toBeNull();
    expect(depositAddonConfig({ DEPOSIT_ADDON: 'off', DEPOSIT_ADDON_PRICE: '750' }, 'USD')).toBeNull();
    expect(depositAddonConfig({ DEPOSIT_ADDON: 'Pack', DEPOSIT_ADDON_PRICE: '50000' }, 'USD')).toBeNull();
    expect(depositAddonConfig({ DEPOSIT_ADDON: 'Pack', DEPOSIT_ADDON_PRICE: '$750', DEPOSIT_ADDON_URL: 'http://insecure.test' }, 'USD')).toMatchObject({ name: 'Pack', price: 750, amount: 75000, label: '$750', url: null });
    const keys = SETTINGS.map((s) => s.key as string);
    for (const k of ['DEPOSIT_ADDON', 'DEPOSIT_ADDON_PRICE', 'DEPOSIT_ADDON_DESCRIPTION', 'DEPOSIT_ADDON_URL', 'DEPOSIT_ADDON_REFUND']) expect(keys).toContain(k);
    for (const k of ['DEPOSIT_ADDON', 'DEPOSIT_ADDON_PRICE']) expect((SETTINGS.find((s) => s.key === k) as { help?: string }).help).toMatch(/Blank = off/);
  });
  it('states the product, the total and the card, and passes the house rules', () => {
    const k = depositAddonCopy({ name: 'Lender-ready financial pack', total: '$787.50', card: 'Mastercard ending 5454', fee: 5 });
    expect(k.button).toBe('Add Lender-ready financial pack for $787.50');
    expect(k.charged).toMatch(/charged to the Mastercard ending 5454 you just used for your deposit, including Whop’s 5% service fee/);
    for (const v of Object.values(k)) expect(auditCopy(v), v).toEqual([]);
    expect(depositAddonTotal(depositAddonConfig({ DEPOSIT_ADDON: 'P', DEPOSIT_ADDON_PRICE: '750' }, 'USD')!, 5)).toEqual({ fee: 3750, total: 78750, label: '$787.50' });
  });
  it('is its own product in Whop, Meta and GA4', () => {
    expect(WHOP_PRODUCT.deposit_addon).toBe('vsl-funnel-deposit-addon');
    expect(META_EVENTS.deposit_addon_purchased).toBe('Purchase');
    expect(GA4_EVENTS.deposit_addon_purchased).toBe('purchase');
  });
});

describe('deposit add-on on the welcome page', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = freshDb(); seedDeposit(db); });

  it('shows nothing while off (the default)', async () => {
    expect(await depositAddonCardHtml(makeRt(db), 'l1', REG)).toBe('');
  });
  it('when on: one explicit button on the deposit card, a No thanks, nothing pre-ticked, no timer', async () => {
    const html = await depositAddonCardHtml(makeRt(db, ADDON), 'l1', REG);
    expect(html).toMatch(/data-dep-addon-buy="da\|l1\|regtokenregtoken1234\.[0-9a-f]{32}"/);
    expect(html).toMatch(/Add Lender-ready financial pack for \$787\.50/);
    expect(html).toMatch(/Mastercard ending 5454/);
    expect(html).not.toMatch(/Visa ending 4242/);
    expect(html).toMatch(/data-dep-addon-no/);
    expect(html).not.toMatch(/type="checkbox"|checked|countdown|data-timer/i);
    expect(db.prepare("SELECT first_shown_at FROM deposit_addon_offers WHERE lead_id = 'l1'").get()).toBeTruthy();
    // A deposit with no saved card (paid another way): not offered.
    const db2 = freshDb(); seedDeposit(db2, { card: false });
    expect(await depositAddonCardHtml(makeRt(db2, ADDON), 'l1', REG)).toBe('');
  });
  it('offered once: No thanks hides it for good, and a buy after that is refused without calling Whop', async () => {
    const rt = makeRt(db, ADDON);
    const t = await depositAddonToken(rt, 'l1', REG);
    expect(await declineDepositAddon(rt, t)).toEqual({ ok: true });
    expect(await depositAddonCardHtml(rt, 'l1', REG)).toBe('');
    const calls = stubWhop();
    expect(await buyDepositAddon(rt, t, { sleep: noSleep })).toMatchObject({ ok: false, outcome: 'no_method' });
    expect(calls.filter((c) => c.path === 'payments')).toHaveLength(0);
  });
  it('a forged or edited link is refused', async () => {
    const rt = makeRt(db, ADDON);
    const t = await depositAddonToken(rt, 'l1', REG);
    expect(await buyDepositAddon(rt, t.replace('l1', 'l2'), { sleep: noSleep })).toMatchObject({ ok: false, outcome: 'bad_link' });
    expect(await buyDepositAddon(rt, 'nope', { sleep: noSleep })).toMatchObject({ ok: false, outcome: 'bad_link' });
    expect(await declineDepositAddon(rt, `${t}x`)).toEqual({ ok: false });
  });
});

describe('buying the deposit add-on', () => {
  let db: DatabaseSync; let rt: Runtime;
  beforeEach(() => { db = freshDb(); seedDeposit(db); rt = makeRt(db, ADDON); });

  it('one click charges the deposit’s card once, as its own product, with no credit, and records it', async () => {
    const calls = stubWhop();
    const t = await depositAddonToken(rt, 'l1', REG);
    const r = await buyDepositAddon(rt, t, { sleep: noSleep, effects: passPaidEffects });
    expect(r).toMatchObject({ ok: true, outcome: 'paid', next: `https://apply.test/live/welcome/${REG}?addon=1` });
    const pay = calls.find((c) => c.path === 'payments' && c.method === 'POST')!;
    expect(pay.body).toMatchObject({ member_id: 'mber_9', payment_method_id: 'payt_dep', off_session: false, variant: { initial_price: 750, title: 'Lender-ready financial pack', product: { external_identifier: 'vsl-funnel-deposit-addon' } }, metadata: { kind: 'deposit_addon', ref_id: 'dep1' } });
    expect(pay.headers['Idempotency-Key'] ?? pay.headers['idempotency-key']).toMatch(/^deposit_addon_wp/);
    const rows = addons(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'paid', amount: 75000, credit_amount: 0, source: 'deposit', ref_id: 'dep1', one_click: 1 });
    await Promise.all(pending);
    const ev = db.prepare("SELECT props FROM events WHERE name = 'deposit_addon_purchased'").get() as { props: string } | undefined;
    expect(ev && JSON.parse(ev.props)).toMatchObject({ pass_id: rows[0].id, value: 750, currency: 'USD', product: 'Lender-ready financial pack' });
    expect(db.prepare('SELECT kind, amount FROM attr_conversions WHERE ref_id = ?').get(rows[0].id)).toEqual({ kind: 'addon_paid', amount: 75000 });
    // The deposit's own credit is untouched.
    expect((db.prepare("SELECT credit_amount FROM webinar_passes WHERE id = 'dep1'").get() as { credit_amount: number }).credit_amount).toBe(500000);
    // The webhook's copy is a duplicate; a second click doesn't charge again; the page shows it as theirs.
    await handleWhopEvent(rt, { type: 'payment.succeeded', data: { id: 'pay_da1', status: 'paid', total: 750, currency: 'usd', metadata: { pass_id: rows[0].id, kind: 'deposit_addon' } } }, async () => { throw new Error('effects ran twice'); });
    expect(await buyDepositAddon(rt, t, { sleep: noSleep })).toMatchObject({ ok: true, outcome: 'already' });
    expect(calls.filter((c) => c.path === 'payments' && c.method === 'POST')).toHaveLength(1);
    expect(await depositAddonCardHtml(rt, 'l1', REG)).toMatch(/data-dep-addon-bought/);
  });

  it('a double click while the first is in flight never charges twice', async () => {
    const calls = stubWhop({ statuses: [{ status: 'pending' }] });
    const t = await depositAddonToken(rt, 'l1', REG);
    const [a, b] = await Promise.all([buyDepositAddon(rt, t, { sleep: noSleep, tries: 1 }), buyDepositAddon(rt, t, { sleep: noSleep, tries: 1 })]);
    expect([a.outcome, b.outcome].sort()).toEqual(['in_flight', 'pending']);
    expect(calls.filter((c) => c.path === 'payments' && c.method === 'POST')).toHaveLength(1);
  });

  it('declined: nothing charged, the row expires; off: refused without calling Whop', async () => {
    stubWhop({ create: { status: 402, message: 'card_declined: Your card was declined' } });
    const t = await depositAddonToken(rt, 'l1', REG);
    expect(await buyDepositAddon(rt, t, { sleep: noSleep })).toMatchObject({ ok: false, outcome: 'declined' });
    expect(addons(db)[0].status).toBe('expired');
    vi.unstubAllGlobals();
    const calls = stubWhop();
    expect(await buyDepositAddon(makeRt(db), t, { sleep: noSleep })).toMatchObject({ ok: false, outcome: 'off' });
    expect(calls).toHaveLength(0);
  });

  it('3D Secure: back on the welcome page, Whop’s status settles it', async () => {
    stubWhop({ statuses: [{ status: 'requires_action', next_action: { type: 'redirect', data: { url: 'https://whop.test/3ds' } } }] });
    const t = await depositAddonToken(rt, 'l1', REG);
    expect(await buyDepositAddon(rt, t, { sleep: noSleep, tries: 1 })).toEqual({ ok: true, outcome: 'action', next: 'https://whop.test/3ds' });
    vi.unstubAllGlobals(); stubWhop();
    expect(await settleDepositAddon(rt, 'l1', async () => {})).toBe('paid');
    expect(addons(db)[0].status).toBe('paid');
  });

  it('refunds take the deposit’s path: a refund in Whop marks it refunded and the deposit stays', async () => {
    stubWhop();
    await buyDepositAddon(rt, await depositAddonToken(rt, 'l1', REG), { sleep: noSleep, effects: async () => {} });
    const row = addons(db)[0];
    await handleWhopEvent(rt, { type: 'refund.created', data: { id: 'rf_1', status: 'succeeded', amount: 750, currency: 'usd', payment: { id: row.stripe_payment_intent, total: 750, refunded_amount: 750 } } });
    expect(addons(db)[0]).toMatchObject({ status: 'refunded', refunded_amount: 75000 });
    expect(db.prepare("SELECT status FROM webinar_passes WHERE id = 'dep1'").get()).toEqual({ status: 'paid' });
  });
});

// ═════════════ 3. Where did this buyer come from ═════════════

function seedBuyer(db: DatabaseSync, id: string, o: { at: number; adId?: string | null; asks?: string | null; email?: boolean; leftCheckout?: boolean; minutes?: number }) {
  const at = o.at;
  const ins = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...(a as (string | number | null)[]));
  ins("INSERT INTO leads (id, ref_code, created_at, updated_at, first_name, email, status) VALUES (?, ?, ?, ?, ?, ?, 'partial')", id, `R${id}`, at - 5 * DAY, at, id.toUpperCase(), `${id}@example.com`);
  const t1 = at - 4 * DAY;
  ins(`INSERT INTO attr_touches (session_id, lead_id, visitor_id, ts, landing, channel, platform, source, medium, campaign, content, ad_id) VALUES (?, ?, 'v1', ?, '/l/hvac', ?, ?, ?, ?, 'Live Nov', ?, ?)`,
    `s1${id}`, id, t1, o.adId ? 'Paid Social' : 'Organic Search', o.adId ? 'Facebook' : 'Google', o.adId ? 'facebook' : 'google', o.adId ? 'paid' : 'organic', o.adId ? 'cad_1' : null, o.adId ?? null);
  ins("INSERT INTO attr_touches (session_id, lead_id, visitor_id, ts, landing, channel, platform) VALUES (?, ?, 'v1', ?, '/live', 'Direct', 'Direct')", `s2${id}`, id, t1 + HOUR);
  const st = (stage: string, ts: number, value: number | null = null, detail: string | null = null) =>
    ins("INSERT INTO attr_stages (id, funnel, stage, lead_id, reg_id, cohort_ref, ts, value, detail, source) VALUES (?, 'live', ?, ?, ?, 'e1', ?, ?, ?, 'sync')", `live:r${id}:${stage}`, stage, id, `r${id}`, ts, value, detail);
  st('registered', t1 + HOUR + 60_000);
  st('attended', at - 2 * HOUR, o.minutes ?? 52, 'room');
  st('offer_seen', at - HOUR);
  ins("INSERT OR IGNORE INTO rooms (id, mode, title, ref_type, ref_id, created_at, updated_at) VALUES ('room1', 'webinar', 'Buy a competitor live', 'live', 'e1', ?, ?)", at, at);
  ins("INSERT INTO room_attendance (room_id, who, lead_id, reg_id, role, first_at, last_at, minutes) VALUES ('room1', ?, ?, ?, 'attendee', ?, ?, ?)", `w${id}`, id, `r${id}`, at - 2 * HOUR, at, o.minutes ?? 52);
  ins("INSERT OR IGNORE INTO room_pushes (room_id, id, kind, created_at) VALUES ('room1', 1, 'deposit', ?)", at - HOUR);
  ins("INSERT INTO room_push_events (room_id, push_id, who, event, lead_id, at) VALUES ('room1', 1, ?, 'shown', ?, ?)", `w${id}`, id, at - HOUR);
  ins("INSERT INTO room_push_events (room_id, push_id, who, event, lead_id, at) VALUES ('room1', 1, ?, 'opened', ?, ?)", `w${id}`, id, at - HOUR + 30_000);
  if (o.asks) ins("INSERT INTO room_objections (room_id, ref, item_id, who, lead_id, qtype, source, text, at) VALUES ('room1', ?, 1, ?, ?, ?, 'question', 'Can the seller finance part of it?', ?)", `qa:${id}`, `w${id}`, id, o.asks, at - 90 * 60_000);
  if (o.email) ins("INSERT INTO emails (id, lead_id, sequence, step, template, to_email, subject, send_at, status, sent_at, opened_at, clicked_at, created_at) VALUES (?, ?, 'live', 1, 'live_reminder', ?, 'Tonight', ?, 'sent', ?, ?, ?, ?)", `em${id}`, id, `${id}@example.com`, at - DAY, at - DAY, at - DAY + HOUR, at - DAY + 2 * HOUR, at - DAY);
  ins("INSERT INTO outbound_calls (id, lead_id, kind, status, run_at, created_at, updated_at) VALUES (?, ?, 'confirm', 'done', ?, ?, ?)", `oc${id}`, id, at - 3 * DAY, at, at);
  if (o.leftCheckout) ins("INSERT INTO webinar_passes (id, reg_id, lead_id, kind, product, status, amount, currency, provider, source, ref_id, created_at, updated_at) VALUES (?, ?, ?, 'deposit', 'Engagement deposit', 'expired', 500000, 'usd', 'whop', 'live', 'e1', ?, ?)", `wx${id}`, `live:r${id}`, id, at - 40 * 60_000, at);
  ins("INSERT INTO webinar_passes (id, reg_id, lead_id, kind, product, status, amount, currency, paid_at, provider, source, ref_id, created_at, updated_at) VALUES (?, ?, ?, 'deposit', 'Engagement deposit', 'paid', 500000, 'usd', ?, 'whop', 'live', 'e1', ?, ?)", `wp${id}`, `live:r${id}`, id, at, at - 5 * 60_000, at);
  ins(`INSERT INTO attr_conversions (id, kind, funnel, ref_id, reg_id, lead_id, occurred_at, amount, currency, ft_ts, ft_platform, ft_channel, ft_campaign, ft_content, ft_ad_id, ft_landing, created_at, updated_at)
       VALUES (?, 'deposit_paid', 'live', ?, ?, ?, ?, 500000, 'usd', ?, ?, ?, 'Live Nov', ?, ?, '/l/hvac', ?, ?)`,
  `cv${id}`, `wp${id}`, `r${id}`, id, at, t1, o.adId ? 'Facebook' : 'Google', o.adId ? 'Paid Social' : 'Organic Search', o.adId ? 'cad_1' : null, o.adId ?? null, at, at);
  // After the purchase: never part of the path.
  ins("INSERT INTO emails (id, lead_id, sequence, step, template, to_email, subject, send_at, status, sent_at, clicked_at, created_at) VALUES (?, ?, 'deposit', 0, 'deposit_welcome', ?, 'Welcome', ?, 'sent', ?, ?, ?)", `ew${id}`, id, `${id}@example.com`, at + HOUR, at + HOUR, at + 2 * HOUR, at + HOUR);
}

function seedAds(db: DatabaseSync) {
  const now = T0;
  db.prepare("INSERT INTO ad_entities (id, level, name, updated_at) VALUES ('1201', 'ad', 'Seller finance hook v2', ?)").run(now);
  db.prepare("INSERT INTO ads_concepts (id, round_id, idx, desire, awareness, format, audience, angle, framework, created_at, updated_at) VALUES ('c1', 'rd1', 1, 'growth', 'problem', 'video', 'owners', 'Buy your competitor with its own cash flow', 'pas', ?, ?)").run(now, now);
  db.prepare("INSERT INTO ads_concept_ads (id, round_id, concept_id, idx, hook, body, headline, utm_content, meta_ad_id, status, created_at, updated_at) VALUES ('a1', 'rd1', 'c1', 1, 'The seller can be your bank', 'body', 'headline', 'cad_1', '1201', 'launched', ?, ?)").run(now, now);
}

describe('where did this buyer come from', () => {
  let db: DatabaseSync; let rt: Runtime;
  beforeEach(() => {
    db = freshDb(); rt = makeRt(db); seedAds(db);
    seedBuyer(db, 'b1', { at: T0, adId: '1201', asks: 'financing', email: true, leftCheckout: true });
    seedBuyer(db, 'b2', { at: T0 + DAY, adId: '1201', asks: 'financing', email: true, leftCheckout: true, minutes: 70 });
    seedBuyer(db, 'b3', { at: T0 + 2 * DAY, adId: null, asks: null, email: false, minutes: 10 });
  });

  it('helpers: source tokens, minute buckets and first-occurrence paths', () => {
    expect(sourceToken({ platform: 'Facebook', channel: 'Paid Social', adId: '1' })).toBe('Ad on Facebook');
    expect(sourceToken({ platform: 'Google', channel: 'Organic Search' })).toBe('From Google');
    expect(sourceToken({ platform: 'Direct', channel: 'Direct' })).toBe('Came direct');
    expect(sourceToken(null)).toBe('Source not tracked');
    expect([minutesBucket(null), minutesBucket(10), minutesBucket(52), minutesBucket(120)]).toEqual(['', ' (under 15 min)', ' (45 to 89 min)', ' (90+ min)']);
    expect(pathSteps([{ ts: 1, type: 'visit', label: '', token: 'A' }, { ts: 2, type: 'visit', label: '', token: 'A' }, { ts: 3, type: 'email', label: '', token: 'B' }, { ts: 9, type: 'email', label: '', token: 'C' }], 5, 'Paid the deposit'))
      .toEqual(['A', 'B', 'Paid the deposit']);
  });

  it('one buyer’s timeline: first ad with its concept and hook, landers, minutes, cards, questions, messages, checkouts, time to buy', async () => {
    const j = (await buyerJourney(rt, 'b1'))!;
    expect(j.buyer).toBe(true);
    const b = j.buys[0];
    expect(b).toMatchObject({ kind: 'deposit_paid', funnel: 'live', amount: 5000, currency: 'USD' });
    expect(b.first).toMatchObject({ platform: 'Facebook', campaign: 'Live Nov', adId: '1201', adName: 'Seller finance hook v2', concept: 'Buy your competitor with its own cash flow', hook: 'The seller can be your bank', landing: '/l/hvac' });
    expect(b.landers).toEqual(['/l/hvac', '/live']);
    expect(b.minutes).toBe(52); // the live webinar's minutes and the room's minutes are the same minutes, counted once
    expect(b.pushes).toEqual({ seen: 1, opened: 1 });
    expect(b.questions).toEqual({ financing: 1 });
    expect(b.emails).toEqual({ sent: 1, opened: 1, clicked: 1 }); // the welcome email after paying isn't counted
    expect(b.calls).toEqual({ made: 1, connected: 1 });
    expect(b.checkouts).toEqual({ attempts: 2, unpaid: 1 });
    expect(b.hoursToBuy).toBe(96);
    expect(b.steps).toEqual([
      'Ad on Facebook', 'Registered for the live webinar', 'Spoke to the AI caller', 'Clicked an email', 'Attended the live webinar (45 to 89 min)',
      'Asked about financing', 'Saw the offer', 'Opened the deposit offer card', 'Left a checkout unpaid', 'Paid the deposit',
    ]);
    // The full timeline includes what came after (the welcome email), the path does not.
    expect(j.events.some((e) => e.label.includes('Welcome'))).toBe(true);
  });

  it('a lead who hasn’t bought gets the path so far, not a buyer card', async () => {
    db.prepare("INSERT INTO leads (id, ref_code, created_at, updated_at, email, status) VALUES ('n1', 'RN', ?, ?, 'n1@example.com', 'partial')").run(T0, T0);
    db.prepare("INSERT INTO attr_touches (session_id, lead_id, visitor_id, ts, landing, channel, platform) VALUES ('sn', 'n1', 'vn', ?, '/', 'Organic Search', 'Google')").run(T0);
    const j = (await buyerJourney(rt, 'n1'))!;
    expect(j.buyer).toBe(false);
    expect(j.buys).toEqual([]);
    expect(j.events[0].token).toBe('From Google');
    expect(await buyerJourney(rt, 'nobody')).toBeNull();
  });

  it('common paths to a deposit: real counts per sequence, step frequency, ads, concepts, hooks and question types', async () => {
    expect(await syncBuyerPaths(rt, { now: T0 + 10 * DAY })).toBe(3);
    expect(await syncBuyerPaths(rt, { now: T0 + 10 * DAY })).toBe(0); // stored and settled: nothing to redo
    const r = await commonPaths(rt, 'all', { from: T0 - DAY, to: T0 + 5 * DAY }, 'deposit_paid');
    expect(r.buyers).toBe(3);
    expect(r.distinctPaths).toBe(2);
    // b1 and b2 share a path (their minutes differ but fall in the same bucket).
    expect(r.sequences[0]).toMatchObject({ count: 2, share: 2 / 3 });
    expect(r.sequences[0].steps[0]).toBe('Ad on Facebook');
    expect(r.sequences[0].leads.sort()).toEqual(['b1', 'b2']);
    expect(r.sequences[1]).toMatchObject({ count: 1, steps: ['From Google', 'Registered for the live webinar', 'Spoke to the AI caller', 'Attended the live webinar (under 15 min)', 'Saw the offer', 'Opened the deposit offer card', 'Paid the deposit'] });
    expect(r.steps.find((s) => s.label === 'Paid the deposit')).toMatchObject({ count: 3, share: 1 });
    expect(r.steps.find((s) => s.label === 'Asked about financing')).toMatchObject({ count: 2 });
    expect(r.ads).toEqual([{ label: 'Seller finance hook v2 (1201)', count: 2 }]);
    expect(r.concepts).toEqual([{ label: 'Buy your competitor with its own cash flow', count: 2 }]);
    expect(r.hooks).toEqual([{ label: 'The seller can be your bank', count: 2 }]);
    expect(r.questions).toEqual([{ label: 'financing', count: 2 }]);
    expect(r.firstTouch).toEqual([{ label: 'Ad on Facebook', count: 2 }, { label: 'From Google', count: 1 }]);
    expect(r.touched).toEqual({ emailClicked: 2, aiCallConnected: 3, leftCheckoutFirst: 2, openedRoomCard: 3 });
    expect(r.medianHoursToBuy).toBe(96);
    expect(r.medianMinutes).toBe(52);
    // Other filters: a funnel with none, a range with none, Sprint buyers (none).
    expect((await commonPaths(rt, 'auto', { from: 0, to: T0 + 9 * DAY })).buyers).toBe(0);
    expect((await commonPaths(rt, 'all', { from: 0, to: T0 - DAY })).buyers).toBe(0);
    expect((await commonPaths(rt, 'all', { from: 0, to: T0 + 9 * DAY }, 'sprint_paid')).buyers).toBe(0);
    expect((await commonPaths(rt, 'all', { from: 0, to: T0 + 9 * DAY }, 'all')).buyers).toBe(3);
  });

  it('a path computed right after the purchase is refreshed once, later', async () => {
    expect(await syncBuyerPaths(rt, { now: T0 + 60_000, limit: 1 })).toBe(1);
    const first = db.prepare("SELECT computed_at FROM attr_buyer_paths WHERE conv_id = 'cvb3'").get() as { computed_at: number } | undefined;
    expect(first).toBeTruthy(); // newest purchase first
    expect(await syncBuyerPaths(rt, { now: T0 + 10 * DAY })).toBe(3); // the other two, plus the refresh of b3
    expect(await syncBuyerPaths(rt, { now: T0 + 11 * DAY })).toBe(0);
  });
});
