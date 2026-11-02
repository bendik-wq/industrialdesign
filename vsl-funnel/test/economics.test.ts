import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/app';
import { auditCopy } from '../src/content/copy-rules';
import { type CohortDef, type Sale, economicsReport, funnelFromName, matchCampaign, recommend, rollUp, setEconCampaign, spendCohort, weekOf } from '../src/admin/economics';
import { addonCardHtml, addonConfig, addonCopy, addonTotal, buyAddon, settleAddon } from '../src/webinar/ticket-addon';
import { type PassRow, passGate, passPaidEffects, registeredPassBlock } from '../src/webinar/pass';
import { WHOP_PRODUCT, handleWhopEvent } from '../src/webinar/whop';
import { META_EVENTS, GA4_EVENTS } from '../src/tracking/catalog';
import { PAID_KINDS } from '../src/attribution/capture';
import { SETTINGS } from '../src/settings';
import type { Registration } from '../src/webinar/webinar';

// ───────────── A real SQLite database shaped like D1, with every migration applied (as in one-click.test.ts) ─────────────

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
const BASE = {
  WEBINAR_PASS: 'required', WEBINAR_SEAT_PRICE: '100', WHOP_API_KEY: 'apik_test', WHOP_WEBHOOK_SECRET: 'ws_test', WHOP_COMPANY_ID: 'biz_test', SALES_TIMEZONE: 'Australia/Sydney',
  WEBINAR_DURATION_MIN: '60', WEBINAR_REPLAY_HOURS: '48', WEBINAR_PITCH_AT: '38',
};
const ADDON = { ...BASE, TICKET_ADDON: 'Deal maths workbook', TICKET_ADDON_PRICE: '27', TICKET_ADDON_DESCRIPTION: 'The spreadsheet behind the 1.5x test, with the worked example from the masterclass.' };
const makeRt = (db: DatabaseSync, settings: Record<string, string> = BASE) =>
  ({ env: { DB: d1(db) }, settings: { ...settings }, reps: [], origin: 'https://apply.test', waitUntil: (p: Promise<unknown>) => { pending.push(p); } }) as unknown as Runtime;
afterEach(() => { vi.unstubAllGlobals(); pending.length = 0; });

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-02T12:00:00Z');
const day = (offset: number) => new Date(NOW + offset * DAY).toISOString().slice(0, 10);
const money = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

// ───────────── Campaign → funnel ─────────────

describe('campaign matching', () => {
  const regs = new Map<string, Partial<Record<'auto' | 'live' | 'challenge', number>>>([
    ['c1', { auto: 3, live: 1 }], ['name:first deal challenge oct', { challenge: 5 }],
  ]);
  it('the owner’s choice wins, then the VSL/other mark, then registrations, then the name', () => {
    expect(matchCampaign({ campaign_id: 'c1', name: 'x' }, { set: 'live', regs })).toMatchObject({ funnel: 'live', how: 'set', registrations: 4 });
    expect(matchCampaign({ campaign_id: 'c1', name: 'x' }, { set: 'none', regs })).toMatchObject({ funnel: 'none', how: 'set' });
    expect(matchCampaign({ campaign_id: 'c1', name: 'x' }, { adsFunnel: 'vsl', regs })).toMatchObject({ funnel: 'none', how: 'excluded' });
    expect(matchCampaign({ campaign_id: 'c1', name: 'x' }, { regs })).toMatchObject({ funnel: 'auto', how: 'registrations', registrations: 4 });
    // utm_campaign carries the name: matched by name, case-insensitive.
    expect(matchCampaign({ campaign_id: 'c9', name: 'First Deal Challenge Oct' }, { regs })).toMatchObject({ funnel: 'challenge', how: 'registrations', registrations: 5 });
    expect(matchCampaign({ campaign_id: 'c8', name: 'Masterclass prospecting' }, { regs })).toMatchObject({ funnel: 'auto', how: 'name' });
    expect(matchCampaign({ campaign_id: 'c7', name: 'Brand awareness' }, { regs })).toMatchObject({ funnel: null, how: 'unmatched' });
  });
  it('names', () => {
    expect(funnelFromName('LIVE webinar Nov')).toBe('live');
    expect(funnelFromName('The 5-day challenge')).toBe('challenge');
    expect(funnelFromName('Master class cold')).toBe('auto');
    expect(funnelFromName('delivery')).toBeNull();
  });
});

// ───────────── Roll-up ─────────────

describe('rollUp', () => {
  const cohorts: CohortDef[] = [
    { key: 'live|e1', funnel: 'live', label: 'Live 1', at: Date.parse(`${day(-20)}T09:00:00Z`) },
    { key: 'live|e2', funnel: 'live', label: 'Live 2', at: Date.parse(`${day(-6)}T09:00:00Z`) },
  ];
  it('places live spend in the next event, after the last one in its own bucket, the masterclass by week', () => {
    expect(spendCohort('live', day(-25), cohorts)).toBe('live|e1');
    expect(spendCohort('live', day(-20), cohorts)).toBe('live|e1'); // the event day itself
    expect(spendCohort('live', day(-19), cohorts)).toBe('live|e2');
    expect(spendCohort('live', day(-1), cohorts)).toBe('live|after');
    expect(spendCohort('auto', '2026-11-04', cohorts)).toBe('auto|week|2026-11-02');
    expect(weekOf(Date.parse('2026-11-08T23:00:00Z'))).toBe('2026-11-02');
  });

  it('recovery, cost per buyer, ROAS and self-liquidation from real rows only', () => {
    const sale = (o: Partial<Sale>): Sale => ({ funnel: 'live', part: 'ticket', lead_id: 'l', cohort: 'live|e1', paid_at: NOW - 21 * DAY, net: 100, gross: 100, ...o });
    const r = rollUp({
      spend: [{ day: day(-25), campaign_id: 'c', spend: 300, funnel: 'live' }, { day: day(-10), campaign_id: 'c', spend: 500, funnel: 'live' }],
      sales: [
        sale({ lead_id: 'a' }), sale({ lead_id: 'b' }), sale({ lead_id: 'c' }), sale({ lead_id: 'd', net: 0 }), // d refunded in full: not a buyer
        sale({ lead_id: 'a', part: 'deposit', net: 4900, gross: 4900 }),
        sale({ lead_id: 'x', cohort: 'live|e2', paid_at: NOW - 7 * DAY }),
      ],
      cohorts,
    });
    const live = r.totals.find((t) => t.funnel === 'live')!;
    expect(live).toMatchObject({ spend: 800, ticket: 400, frontEnd: 400, deposit: 4900, backEnd: 4900, total: 5300, buyers: 4, cpa: 200, roas: 6.63, selfLiquidates: false });
    expect(live.recovery).toBeCloseTo(0.5);
    const e1 = r.byEvent.find((x) => x.key === 'live|e1')!;
    expect(e1).toMatchObject({ spend: 300, frontEnd: 300, buyers: 3, cpa: 100, selfLiquidates: true, label: 'Live 1' });
    const e2 = r.byEvent.find((x) => x.key === 'live|e2')!;
    expect(e2).toMatchObject({ spend: 500, frontEnd: 100, selfLiquidates: false });
    // Weekly: spend days and paid days.
    expect(r.byWeek.reduce((a, w) => a + w.spend, 0)).toBe(800);
    expect(r.totals.find((t) => t.funnel === 'auto')).toMatchObject({ spend: 0, recovery: null, selfLiquidates: null, cpa: null });
  });
});

// ───────────── Recommendation ─────────────

describe('recommendation box', () => {
  const base = { spend: 0, ticket: 0, vip: 0, addon: 0, frontEnd: 0, sprint: 0, deposit: 0, engagement: 0, backEnd: 0, total: 0, buyers: 0, ticketSales: 0, ticketGross: 0, vipBuyers: 0, vipGross: 0, vipSales: 0, addonBuyers: 0, addonGross: 0, addonSales: 0, recovery: null, cpa: null, roas: null, selfLiquidates: null };
  it('challenge: ticket price and VIP take-rate that cover spend at today’s cost per buyer', () => {
    // 40 buyers at $100, 8 VIPs at $300, $8,000 spend → CPA $200; front end $6,400.
    const m = { ...base, spend: 8000, ticket: 4000, vip: 2400, frontEnd: 6400, buyers: 40, ticketSales: 40, ticketGross: 4000, vipBuyers: 8, vipGross: 2400, vipSales: 8, recovery: 0.8, cpa: 200, selfLiquidates: false };
    const r = recommend('challenge', m, { money });
    expect(r.estimate).toBe(true);
    expect(r.priceNeeded).toBe(140); // 200 - 60 VIP per buyer
    expect(r.currentPrice).toBe(100);
    expect(r.bump).toMatchObject({ name: 'VIP upgrade', price: 300, currentTake: 0.2, takeNeeded: 0.33, reachable: true });
    expect(r.lines.join(' ')).toMatch(/Estimate: a ticket of about \$140 \(today \$100\)/);
    expect(r.lines.join(' ')).toMatch(/34% of ticket buyers taking the VIP upgrade at \$300/);
    for (const l of r.lines) expect(auditCopy(l), l).toEqual([]);
  });
  it('masterclass with the add-on, refunds counted, small sample flagged, unreachable bump said plainly', () => {
    const m = { ...base, spend: 3000, ticket: 900, frontEnd: 900, buyers: 9, ticketSales: 10, ticketGross: 1000, recovery: 0.3, cpa: 333.33, selfLiquidates: false };
    const r = recommend('auto', m, { money, addon: { name: 'Deal maths workbook', price: 27 } });
    expect(r.small).toBe(true);
    expect(r.priceNeeded).toBeCloseTo(370.37, 1); // 333.33 / 0.9 kept after refunds
    expect(r.bump).toMatchObject({ reachable: false });
    expect(r.lines.some((l) => /can’t cover the gap on its own/.test(l))).toBe(true);
    expect(r.lines.some((l) => /too few to rely on/.test(l))).toBe(true);
    for (const l of r.lines) expect(auditCopy(l), l).toEqual([]);
  });
  it('already self-liquidating, no spend, no buyers', () => {
    const ok = recommend('live', { ...base, spend: 1000, ticket: 1500, frontEnd: 1500, buyers: 30, ticketSales: 30, ticketGross: 1500, recovery: 1.5, cpa: 33.33, selfLiquidates: true }, { money });
    expect(ok.lines.join(' ')).toMatch(/already covers its ad spend: 150% recovered/);
    const none = recommend('live', base, { money });
    expect(none.lines[0]).toMatch(/No ad spend/);
    const noBuyers = recommend('auto', { ...base, spend: 500 }, { money });
    expect(noBuyers.lines[0]).toMatch(/no ticket buyers yet/);
    for (const l of [...ok.lines, ...none.lines, ...noBuyers.lines, ...recommend('auto', { ...base, spend: 500, buyers: 5, cpa: 100, ticketSales: 5, ticketGross: 500, ticket: 500, frontEnd: 400, selfLiquidates: false }, { money }).lines]) expect(auditCopy(l), l).toEqual([]);
  });
});

// ───────────── The report on a real database ─────────────

function seedFunnels(db: DatabaseSync) {
  const t = (d: number) => NOW + d * DAY;
  const lead = (id: string) => db.prepare("INSERT INTO leads (id, ref_code, created_at, updated_at, first_name, email, status) VALUES (?, ?, ?, ?, 'A', ?, 'partial')").run(id, `R${id}`, t(-30), t(-30), `${id}@example.com`);
  ['m1', 'm2', 'm3', 'v1', 'v2', 'c1', 'c2'].forEach(lead);
  // Spend: a masterclass campaign (matched by its registrations' utm_campaign), a live one (by id), a challenge one (by name), a VSL one (excluded), one unknown.
  const spend = db.prepare("INSERT INTO ad_spend (platform, campaign_id, day, campaign_name, spend, currency, source, updated_at) VALUES ('meta', ?, ?, ?, ?, 'USD', 'sync', 1)");
  spend.run('111', day(-12), 'Cold traffic A', 250); spend.run('111', day(-5), 'Cold traffic A', 250);
  spend.run('222', day(-15), 'Event promo', 300);
  spend.run('333', day(-9), 'Challenge Nov', 400);
  spend.run('444', day(-9), 'Apply now', 1000);
  spend.run('555', day(-9), 'Brand', 50);
  db.prepare("INSERT INTO ad_campaigns (platform, campaign_id, funnel) VALUES ('meta', '444', 'vsl')").run();
  const reg = db.prepare("INSERT INTO attr_conversions (id, kind, funnel, ref_id, reg_id, lead_id, occurred_at, lt_campaign, lt_campaign_id, created_at, updated_at) VALUES (?, 'registered', ?, ?, ?, ?, ?, ?, ?, 1, 1)");
  reg.run('a1', 'auto', 'r1', 'r1', 'm1', t(-12), 'cold traffic a', null);
  reg.run('a2', 'auto', 'r2', 'r2', 'm2', t(-12), 'Cold traffic A', null);
  reg.run('a3', 'live', 'lr1', 'lr1', 'v1', t(-14), null, '222');
  // Masterclass: session + registrations, two paid tickets ($100, one refunded half), one add-on ($27), a Sprint ($2,900).
  db.prepare("INSERT INTO webinar_sessions (id, starts_at, mode, status, auto, created_at) VALUES ('s1', ?, 'evergreen', 'scheduled', 1, ?)").run(t(-11), t(-20));
  const wr = db.prepare("INSERT INTO webinar_registrations (id, token, session_id, lead_id, created_at) VALUES (?, ?, 's1', ?, ?)");
  wr.run('r1', 'tok_r1_aaaaaaaaaaaaaa', 'm1', t(-12)); wr.run('r2', 'tok_r2_aaaaaaaaaaaaaa', 'm2', t(-12)); wr.run('r3', 'tok_r3_aaaaaaaaaaaaaa', 'm3', t(-12));
  const pass = db.prepare("INSERT INTO webinar_passes (id, reg_id, lead_id, kind, product, status, amount, refunded_amount, currency, paid_at, source, ref_id, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'usd', ?, ?, ?, 'whop', 1, 1)");
  pass.run('p1', 'r1', 'm1', 'seat', 'Masterclass ticket', 'paid', 10000, 0, t(-12), null, null);
  pass.run('p2', 'r2', 'm2', 'seat', 'Masterclass ticket', 'paid', 10000, 5000, t(-12), null, null);
  pass.run('p3', 'r3', 'm3', 'seat', 'Masterclass ticket', 'refunded', 10000, 10000, t(-12), null, null); // fully refunded: a sale, not a buyer, $0
  pass.run('p4', 'r1', 'm1', 'addon', 'Deal maths workbook', 'paid', 2700, 0, t(-12), 'masterclass', 'r1');
  pass.run('p5', 'r1', 'm1', 'offer', 'First Deal Sprint', 'paid', 290000, 0, t(-11), null, null);
  pass.run('p6', 'r2', 'm2', 'seat', 'Masterclass ticket', 'expired', 10000, 0, null, null, null); // never paid
  // Live: one event, one $50 ticket, one $5,000 deposit.
  db.prepare("INSERT INTO live_webinars (id, title, starts_at, tz, created_at, updated_at) VALUES ('e1', 'Buy a competitor live', ?, 'UTC', 1, 1)").run(t(-13));
  pass.run('p7', 'lr1', 'v1', 'live_ticket', 'Live webinar ticket', 'paid', 5000, 0, t(-14), 'live', 'e1');
  pass.run('p8', 'live:x', 'v1', 'deposit', 'Engagement deposit', 'paid', 500000, 0, t(-13), 'live', 'e1');
  // Challenge: cohort, $100 ticket x2, one $300 VIP.
  db.prepare("INSERT INTO challenge_cohorts (id, name, start_date, start_time, timezone, created_at, updated_at) VALUES ('k1', 'November cohort', ?, '18:00', 'UTC', 1, 1)").run(day(-3));
  const cr = db.prepare("INSERT INTO challenge_registrations (id, token, cohort_id, lead_id, created_at) VALUES (?, ?, 'k1', ?, ?)");
  cr.run('cr1', 'ctok1', 'c1', t(-10)); cr.run('cr2', 'ctok2', 'c2', t(-10));
  const ord = db.prepare("INSERT INTO challenge_orders (id, reg_id, lead_id, kind, status, amount, currency, created_at, updated_at, paid_at) VALUES (?, ?, ?, ?, 'paid', ?, 'usd', 1, 1, ?)");
  ord.run('o1', 'cr1', 'c1', 'ticket', 10000, t(-9)); ord.run('o2', 'cr2', 'c2', 'ticket', 10000, t(-9)); ord.run('o3', 'cr1', 'c1', 'vip', 30000, t(-9));
}

describe('economicsReport on a real database', () => {
  let db: DatabaseSync; let rt: Runtime;
  beforeEach(() => { db = freshDb(); seedFunnels(db); rt = makeRt(db, ADDON); });

  it('matches spend, nets refunds and splits front end from back end per funnel', async () => {
    const r = await economicsReport(rt, { days: 30, now: NOW });
    expect(r.currency).toBe('USD');
    const by = Object.fromEntries(r.totals.map((t) => [t.funnel, t]));
    // Masterclass: $500 spend; tickets $100 + $50 (+ $0 refunded) = $150, add-on $27 → $177 front end; Sprint $2,900.
    expect(by.auto).toMatchObject({ spend: 500, ticket: 150, addon: 27, frontEnd: 177, sprint: 2900, backEnd: 2900, buyers: 2, cpa: 250, selfLiquidates: false });
    expect(by.auto.recovery).toBeCloseTo(0.354, 3);
    expect(by.auto.roas).toBeCloseTo(6.15, 2);
    // Live: $300 spend, $50 ticket, $5,000 deposit.
    expect(by.live).toMatchObject({ spend: 300, frontEnd: 50, deposit: 5000, buyers: 1, cpa: 300, selfLiquidates: false });
    // Challenge: $400 spend (by name), $200 tickets + $300 VIP = $500 → self-liquidating.
    expect(by.challenge).toMatchObject({ spend: 400, ticket: 200, vip: 300, frontEnd: 500, buyers: 2, vipBuyers: 1, selfLiquidates: true });
    expect(r.excludedSpend).toBe(1000);
    expect(r.unmatchedSpend).toBe(50);
    expect(r.campaigns.find((c) => c.campaign_id === '111')).toMatchObject({ funnel: 'auto', how: 'registrations', registrations: 2 });
    expect(r.campaigns.find((c) => c.campaign_id === '222')).toMatchObject({ funnel: 'live', how: 'registrations' });
    expect(r.campaigns.find((c) => c.campaign_id === '333')).toMatchObject({ funnel: 'challenge', how: 'name' });
    // Per event: the live event and the challenge cohort carry their spend and sales.
    expect(r.byEvent.find((x) => x.key === 'live|e1')).toMatchObject({ spend: 300, frontEnd: 50, backEnd: 5000, label: expect.stringContaining('Buy a competitor live') });
    expect(r.byEvent.find((x) => x.key === 'challenge|k1')).toMatchObject({ spend: 400, frontEnd: 500, selfLiquidates: true });
    expect(r.recommendations.find((x) => x.funnel === 'challenge')!.lines[1]).toMatch(/already covers its ad spend/);
    for (const rec of r.recommendations) for (const l of rec.lines) expect(auditCopy(l), l).toEqual([]);
  });

  it('the owner can move a campaign, mark it as not a ticket funnel, and hand it back to matching', async () => {
    expect(await setEconCampaign(rt, '555', 'live')).toEqual({ ok: true });
    let r = await economicsReport(rt, { days: 30, now: NOW });
    expect(r.totals.find((t) => t.funnel === 'live')!.spend).toBe(350);
    expect(r.unmatchedSpend).toBe(0);
    await setEconCampaign(rt, '111', 'none');
    r = await economicsReport(rt, { days: 30, now: NOW });
    expect(r.totals.find((t) => t.funnel === 'auto')!.spend).toBe(0);
    await setEconCampaign(rt, '111', 'match');
    r = await economicsReport(rt, { days: 30, now: NOW });
    expect(r.totals.find((t) => t.funnel === 'auto')!.spend).toBe(500);
    expect(await setEconCampaign(rt, '111', 'bogus')).toMatchObject({ ok: false });
  });
});

// ───────────── The one-click ticket add-on ─────────────

const TOKEN = 'tokentokentoken12345';
function seedTicket(db: DatabaseSync, o: { saved?: boolean } = {}) {
  const now = Date.now();
  db.prepare("INSERT INTO leads (id, ref_code, created_at, updated_at, first_name, last_name, email, status, revenue_band, webinar_token) VALUES ('l1', 'R1', ?, ?, 'Dana', 'Lee', 'dana@example.com', 'partial', '3m-10m', ?)").run(now, now, TOKEN);
  db.prepare("INSERT INTO webinar_sessions (id, starts_at, mode, status, auto, created_at) VALUES ('s1', ?, 'evergreen', 'scheduled', 1, ?)").run(now + 2 * DAY, now);
  db.prepare("INSERT INTO webinar_registrations (id, token, session_id, lead_id, created_at, pass_required) VALUES ('r1', ?, 's1', 'l1', ?, 1)").run(TOKEN, now);
  db.prepare(`INSERT INTO webinar_passes (id, reg_id, lead_id, kind, product, status, amount, currency, paid_at, provider, stripe_session_id, stripe_payment_intent, whop_member_id, whop_payment_method_id, card_brand, card_last4, created_at, updated_at)
    VALUES ('t1', 'r1', 'l1', 'seat', 'Masterclass ticket', 'paid', 10000, 'usd', ?, 'whop', 'ch_t', 'pay_t', ?, ?, 'visa', '4242', ?, ?)`).run(now - 60_000, o.saved === false ? null : 'mber_1', o.saved === false ? null : 'payt_1', now, now);
}
const reg = (db: DatabaseSync) => db.prepare("SELECT * FROM webinar_registrations WHERE id = 'r1'").get() as Registration;
const addons = (db: DatabaseSync) => db.prepare("SELECT * FROM webinar_passes WHERE kind = 'addon'").all() as (PassRow & Record<string, unknown>)[];

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
    if (path === 'payments' && init.method === 'POST') return o.create ? json(o.create.status, { error: { message: o.create.message } }) : json(201, { id: 'pay_ad1', status: 'open' });
    if (/^payments\/[^/]+\/status$/.test(path)) { const list = o.statuses ?? [{ status: 'succeeded' }]; return json(200, list[Math.min(s++, list.length - 1)]); }
    if (path.startsWith('payments/')) return json(200, {});
    return json(404, { error: { message: 'not stubbed' } });
  }));
  return calls;
}
const noSleep = async () => {};

describe('ticket add-on settings', () => {
  it('is off by default and needs both a name and a valid price', () => {
    expect(addonConfig({})).toBeNull();
    expect(addonConfig({ TICKET_ADDON: 'Workbook' })).toBeNull();
    expect(addonConfig({ TICKET_ADDON: 'off', TICKET_ADDON_PRICE: '27' })).toBeNull();
    expect(addonConfig({ TICKET_ADDON: 'Workbook', TICKET_ADDON_PRICE: '5000' })).toBeNull(); // not a low price
    expect(addonConfig({ TICKET_ADDON: 'Workbook', TICKET_ADDON_PRICE: '$27', TICKET_ADDON_URL: 'http://insecure.test' })).toMatchObject({ name: 'Workbook', price: 27, amount: 2700, currency: 'USD', label: '$27', url: null });
    const keys = SETTINGS.map((s) => s.key as string);
    for (const k of ['TICKET_ADDON', 'TICKET_ADDON_PRICE', 'TICKET_ADDON_DESCRIPTION', 'TICKET_ADDON_URL']) expect(keys).toContain(k);
    for (const k of ['TICKET_ADDON', 'TICKET_ADDON_PRICE']) expect((SETTINGS.find((s) => s.key === k) as { help?: string }).help).toMatch(/Blank = off/);
  });
  it('its copy passes the house rules and states the total and the card', () => {
    const k = addonCopy({ name: 'Deal maths workbook', total: '$28.35', card: 'Visa ending 4242', fee: 5, url: null });
    expect(k.button).toBe('Add Deal maths workbook for $28.35');
    expect(k.charged).toMatch(/charged to the Visa ending 4242 you used for your ticket, including Whop’s 5% service fee/);
    for (const v of Object.values(k)) expect(auditCopy(v), v).toEqual([]);
    for (const v of Object.values(addonCopy({ name: 'X', total: '$27', card: null, fee: 0, url: 'https://x.test' }))) expect(auditCopy(v), v).toEqual([]);
    expect(addonTotal(addonConfig({ TICKET_ADDON: 'W', TICKET_ADDON_PRICE: '27' })!, 5)).toEqual({ fee: 135, total: 2835, label: '$28.35' });
  });
  it('is its own product in Meta, GA4 and attribution', () => {
    expect(META_EVENTS.ticket_addon_purchased).toBe('Purchase');
    expect(GA4_EVENTS.ticket_addon_purchased).toBe('purchase');
    expect(PAID_KINDS).toContain('addon_paid');
    expect(WHOP_PRODUCT.addon).toBe('vsl-funnel-ticket-addon');
  });
});

describe('ticket add-on on the thank-you page', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = freshDb(); seedTicket(db); });

  it('shows nothing while off (the default)', async () => {
    expect(await addonCardHtml(makeRt(db), reg(db))).toBe('');
    const b = await registeredPassBlock(makeRt(db), reg(db), {});
    expect(b.html).not.toMatch(/data-addon/);
  });
  it('when on: one explicit button, nothing pre-ticked, on the paid ticket page only', async () => {
    const rt = makeRt(db, ADDON);
    const html = await addonCardHtml(rt, reg(db));
    expect(html).toMatch(/data-addon-buy="tokentokentoken12345"/);
    expect(html).toMatch(/Add Deal maths workbook for \$28\.35/);
    expect(html).toMatch(/Visa ending 4242/);
    expect(html).not.toMatch(/type="checkbox"|checked|countdown|data-timer/i);
    const b = await registeredPassBlock(rt, reg(db), {});
    expect(b.rest).toMatch(/data-addon-buy/);
    // No saved card (hosted checkout) → not offered.
    const db2 = freshDb(); seedTicket(db2, { saved: false });
    expect(await addonCardHtml(makeRt(db2, ADDON), reg(db2))).toBe('');
  });
});

describe('buying the ticket add-on', () => {
  let db: DatabaseSync; let rt: Runtime;
  beforeEach(() => { db = freshDb(); seedTicket(db); rt = makeRt(db, ADDON); });

  it('one click charges the saved ticket card once, as its own product, and records the purchase', async () => {
    const calls = stubWhop();
    const r = await buyAddon(rt, reg(db), { sleep: noSleep, effects: passPaidEffects });
    expect(r).toMatchObject({ ok: true, outcome: 'paid', next: expect.stringContaining(`/registered/${TOKEN}?addon=1`) });
    const pay = calls.find((c) => c.path === 'payments' && c.method === 'POST')!;
    expect(pay.body).toMatchObject({ member_id: 'mber_1', payment_method_id: 'payt_1', off_session: false, variant: { initial_price: 27, title: 'Deal maths workbook', product: { external_identifier: 'vsl-funnel-ticket-addon' } }, metadata: { kind: 'addon' } });
    expect(pay.headers['Idempotency-Key'] ?? pay.headers['idempotency-key']).toMatch(/^ticket_addon_wp/);
    const rows = addons(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'paid', amount: 2700, product: 'Deal maths workbook', credit_amount: 0, reg_id: 'r1' });
    await Promise.all(pending);
    // Its own Purchase event (value = its price, order id = its row) and its own attribution conversion.
    const ev = db.prepare("SELECT props FROM events WHERE name = 'ticket_addon_purchased'").get() as { props: string } | undefined;
    expect(ev && JSON.parse(ev.props)).toMatchObject({ pass_id: rows[0].id, value: 27, currency: 'USD', product: 'Deal maths workbook' });
    expect(db.prepare("SELECT kind, amount FROM attr_conversions WHERE ref_id = ?").get(rows[0].id)).toEqual({ kind: 'addon_paid', amount: 2700 });
    // The webhook's copy is a duplicate; a second click doesn't charge again.
    await handleWhopEvent(rt, { type: 'payment.succeeded', data: { id: 'pay_ad1', status: 'paid', total: 27, currency: 'usd', metadata: { pass_id: rows[0].id, kind: 'addon', reg_id: 'r1' } } }, async () => { throw new Error('effects ran twice'); });
    expect(await buyAddon(rt, reg(db), { sleep: noSleep })).toMatchObject({ ok: true, outcome: 'already' });
    expect(calls.filter((c) => c.path === 'payments' && c.method === 'POST')).toHaveLength(1);
    // The page now shows the buyer's card.
    expect(await addonCardHtml(rt, reg(db))).toMatch(/data-addon-bought/);
  });

  it('a double click while the first is in flight never charges twice', async () => {
    const calls = stubWhop({ statuses: [{ status: 'pending' }] });
    const [a, b] = await Promise.all([buyAddon(rt, reg(db), { sleep: noSleep, tries: 1 }), buyAddon(rt, reg(db), { sleep: noSleep, tries: 1 })]);
    expect([a.outcome, b.outcome].sort()).toEqual(['in_flight', 'pending']);
    expect(calls.filter((c) => c.path === 'payments' && c.method === 'POST')).toHaveLength(1);
  });

  it('declined: nothing charged, the row expires, the buyer can try again', async () => {
    stubWhop({ create: { status: 402, message: 'card_declined: Your card was declined' } });
    const r = await buyAddon(rt, reg(db), { sleep: noSleep });
    expect(r).toMatchObject({ ok: false, outcome: 'declined' });
    expect(addons(db)[0].status).toBe('expired');
    vi.unstubAllGlobals(); stubWhop();
    expect(await buyAddon(rt, reg(db), { sleep: noSleep })).toMatchObject({ ok: true, outcome: 'paid' });
  });

  it('off, or no paid ticket card: refused without calling Whop', async () => {
    const calls = stubWhop();
    expect(await buyAddon(makeRt(db), reg(db), { sleep: noSleep })).toMatchObject({ ok: false, outcome: 'off' });
    db.prepare("UPDATE webinar_passes SET status = 'refunded' WHERE id = 't1'").run();
    expect(await buyAddon(rt, reg(db), { sleep: noSleep })).toMatchObject({ ok: false, outcome: 'no_method' });
    expect(calls.filter((c) => c.path === 'payments')).toHaveLength(0);
  });

  it('3D Secure: back on the page, Whop’s status settles it', async () => {
    stubWhop({ statuses: [{ status: 'requires_action', next_action: { type: 'redirect', data: { url: 'https://whop.test/3ds' } } }] });
    expect(await buyAddon(rt, reg(db), { sleep: noSleep, tries: 1 })).toEqual({ ok: true, outcome: 'action', next: 'https://whop.test/3ds' });
    vi.unstubAllGlobals(); stubWhop();
    expect(await settleAddon(rt, 'l1', async () => {})).toBe('paid');
    expect(addons(db)[0].status).toBe('paid');
  });

  it('refunds follow the ticket’s path, and a refunded ticket still closes the room when the add-on stays', async () => {
    stubWhop();
    await buyAddon(rt, reg(db), { sleep: noSleep, effects: async () => {} });
    const row = addons(db)[0];
    await handleWhopEvent(rt, { type: 'refund.created', data: { id: 'rf_1', status: 'succeeded', amount: 27, currency: 'usd', payment: { id: row.stripe_payment_intent, total: 27, refunded_amount: 27 } } });
    expect(addons(db)[0]).toMatchObject({ status: 'refunded', refunded_amount: 2700 });
    // Now: add-on paid again (a second purchase), ticket refunded → the room needs a ticket again.
    db.prepare("UPDATE webinar_passes SET status = 'paid', refunded_amount = 0 WHERE id = ?").run(row.id);
    db.prepare("UPDATE webinar_passes SET status = 'refunded' WHERE id = 't1'").run();
    expect(await passGate(rt, reg(db) as Registration & { pass_required: number })).toBe(true);
  });
});
