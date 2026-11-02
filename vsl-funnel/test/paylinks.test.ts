import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/app';
import { auditCopy } from '../src/content/copy-rules';
import {
  PAY_COPY, checkoutStarted, clock, deadlineLabel, holdUntilFor, payLinkUrl, payingAs, pickDeadline, prefillFor, prefillFromLead, prefillInputs, priceHoldMin, readPayLink,
  rowDeadline, sessionMetadata, timerHtml, whopEmbedHtml, whopPrefillAttrs,
} from '../src/sales/paylinks';
import { payCopy, payEmbedded, payHead, payPageUrl, pendingRow, sessionFor } from '../src/sales/pay-page';
import { attendeeEngage, savePush, seedPlan, sprintCard, startRoomSprint } from '../src/rooms/engage-db';
import { ensureRoomFor } from '../src/rooms/rooms';
import { saveEvent } from '../src/live/events';
import { postEmail } from '../src/live/lifecycle';
import { SETTINGS as SETTING_DEFS } from '../src/settings';

// ───────────── a real SQLite database shaped like D1, with every migration applied ─────────────

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

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const T0 = Date.parse('2026-11-03T02:00:00Z');
const API_KEY = 'apik_secret_do_not_leak_123';
const SETTINGS: Record<string, string> = {
  SALES_TIMEZONE: 'America/New_York', SITE_NAME: 'G&L', WHOP_API_KEY: API_KEY, WHOP_COMPANY_ID: 'biz_test', WEBINAR_PASS: 'upsell', WEBINAR_PASS_PRICE: '3000',
};
let db: DatabaseSync;
let rt: Runtime;
const pending: Promise<unknown>[] = [];
const ALL = () => Object.fromEntries(SETTING_DEFS.map((d) => [d.key, ''])) as Record<string, string>;
const makeRt = (s: Record<string, string> = SETTINGS) => ({ env: { DB: d1(db), SESSION_SECRET: 'test-session-secret' }, settings: { ...ALL(), ...s }, reps: [], origin: 'https://apply.test', waitUntil: (p: Promise<unknown>) => { pending.push(p.catch(() => null)); } }) as unknown as Runtime;
const q = <T = Record<string, unknown>>(sql: string, ...a: unknown[]) => db.prepare(sql).all(...(a as (string | number | null)[])) as T[];
const x = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...(a.map((v) => (v === undefined ? null : v)) as (string | number | null)[]));

interface Call { method: string; path: string; body: Record<string, unknown> | null; headers: Record<string, string> }
let calls: Call[] = [];
function stubFetch() {
  calls = [];
  let n = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
    const u = String(url);
    const path = u.replace('https://api.whop.com/api/v1/', '');
    calls.push({ method: init.method ?? 'GET', path, body: init.body && init.body.startsWith('{') ? JSON.parse(init.body) : null, headers: init.headers ?? {} });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (!u.startsWith('https://api.whop.com/')) return json(200, { ok: true });
    if (path === 'checkout_configurations' && init.method === 'POST') { n++; return json(201, { id: `ch_test${n}`, purchase_url: `https://whop.com/checkout/plan_test${n}?session=ch_test${n}`, plan: { id: `plan_test${n}` } }); }
    if (path === 'payments' && init.method === 'POST') return json(201, { id: 'pay_x1', status: 'open' });
    return json(404, { error: { message: 'not stubbed' } });
  }));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  db = freshDb();
  rt = makeRt();
  stubFetch();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); pending.length = 0; });

const ANSWERS = { business: 'Commercial HVAC services, 25 staff', revenue: '3_10m', role: 'owner' };
function seedLead(id: string, o: { band?: string; answers?: Record<string, unknown>; phone?: string | null } = {}) {
  x(`INSERT INTO leads (id, ref_code, created_at, updated_at, visitor_id, first_name, last_name, email, phone, status, revenue_band, country, answers)
     VALUES (?, ?, ?, ?, ?, 'Dana', 'Lee', ?, ?, 'partial', ?, 'US', ?)`, id, `R${id}`, T0 - DAY, T0 - DAY, `v${id}`, `${id}@example.com`, o.phone === undefined ? '+15551234567' : o.phone, o.band ?? '3m-10m', JSON.stringify(o.answers ?? ANSWERS));
}
async function liveRoom(engage: Record<string, unknown> = {}) {
  const s = await saveEvent(rt, { title: 'Buy your first competitor', starts_at: T0 - 20 * MIN, tz: 'UTC', duration_min: 120, platform: 'room' }) as { id: string };
  const room = (await ensureRoomFor(rt, 'live', s.id, { title: 'Buy your first competitor', startsAt: T0 - 20 * MIN, durationMin: 120 }))!;
  x('UPDATE rooms SET engage = ? WHERE id = ?', JSON.stringify(engage), room.id);
  return { room: { ...room, engage: JSON.stringify(engage) }, eventId: s.id };
}
function seedReg(eventId: string, regId: string, leadId: string, who: string) {
  x(`INSERT INTO live_webinar_regs (id, token, event_id, lead_id, revenue_band, created_at) VALUES (?, ?, ?, ?, '3m-10m', ?)`, regId, `tok${regId}aaaaaaaaaaaaaaa`, eventId, leadId, T0 - DAY);
  x(`INSERT INTO room_attendance (room_id, who, lead_id, reg_id, name, role, first_at, last_at, minutes, joins) SELECT id, ?, ?, ?, 'Dana L.', 'attendee', ?, ?, 30, 1 FROM rooms WHERE ref_id = ?`, who, leadId, regId, T0 - 15 * MIN, T0, eventId);
  return { id: who, name: 'Dana L.', leadId, regId };
}
const sprintPush = (id: number, at = T0) => ({ id, kind: 'sprint' as const, ref: null, to: null, at, open: true, by: 'hadmin' });

// ───────────── prefill ─────────────

describe('prefill', () => {
  it('maps everything we know from the lead and the application', () => {
    seedLead('l1');
    const lead = q<Record<string, unknown>>("SELECT * FROM leads WHERE id = 'l1'")[0];
    expect(prefillFromLead(lead as never)).toEqual({
      email: 'l1@example.com', firstName: 'Dana', lastName: 'Lee', name: 'Dana Lee', phone: '+15551234567', country: 'US', company: 'Commercial HVAC services, 25 staff', revenue: '3_10m',
    });
    expect(prefillFromLead(null)).toBeNull();
    // A company name answer wins over the business description; markup never survives.
    expect(prefillFromLead({ ...(lead as object), answers: JSON.stringify({ company: 'Lee <b>HVAC</b> Pty', business: 'HVAC' }) } as never)!.company).toBe('Lee bHVAC/b Pty');
  });
  it('fills Whop’s embedded checkout with its documented attributes only', () => {
    const p = { email: 'dana@example.com', firstName: 'Dana', lastName: 'Lee', name: 'Dana Lee', phone: '+1555', country: 'US', company: 'HVAC', revenue: '3_10m' };
    expect(whopPrefillAttrs(p)).toEqual({ 'data-whop-checkout-prefill-email': 'dana@example.com', 'data-whop-checkout-prefill-name': 'Dana Lee' });
    expect(whopPrefillAttrs(null)).toEqual({});
    const html = whopEmbedHtml({ planId: 'plan_1', id: 'ch_1' }, p);
    expect(html).toContain('data-whop-checkout-plan-id="plan_1"');
    expect(html).toContain('data-whop-checkout-session="ch_1"');
    expect(html).toContain('data-whop-checkout-prefill-email="dana@example.com"');
    expect(html).toContain('https://js.whop.com/static/checkout/loader.js');
  });
  it('fills our registration forms (live radios, challenge select) without overwriting a value', () => {
    const p = prefillFromLead({ email: 'd@x.com', first_name: 'Dana', last_name: 'Lee', phone: '+1 555', answers: JSON.stringify({ revenue: '3_10m' }) } as never);
    const live = '<input name="first_name" autocomplete="given-name" required><input name="email" type="email"><input type="radio" name="revenue" value="1_3m"><input type="radio" name="revenue" value="3_10m"><input name="phone" type="tel"><input type="hidden" name="event_id" value="e1"><input name="tz" value="keep">';
    const out = prefillInputs(live, p);
    expect(out).toContain('<input name="first_name" autocomplete="given-name" required value="Dana">');
    expect(out).toContain('<input name="email" type="email" value="d@x.com">');
    expect(out).toContain('<input type="radio" name="revenue" value="3_10m" checked>');
    expect(out).not.toContain('value="1_3m" checked');
    expect(out).toContain('<input name="phone" type="tel" value="+1 555">');
    expect(out).toContain('<input type="hidden" name="event_id" value="e1">');
    expect(out).toContain('<input name="tz" value="keep">');
    const ch = '<select name="revenue" required data-ch-band><option value="">Choose one</option><option value="3_10m">$3M to $10M</option></select>';
    expect(prefillInputs(ch, p)).toContain('<option value="3_10m" selected>');
    expect(prefillInputs(live, null)).toBe(live);
    // Escaped: a name with a quote can't break out of the attribute.
    expect(prefillInputs('<input name="first_name">', { ...p!, firstName: 'D"><script>' })).toBe('<input name="first_name" value="D&quot;&gt;&lt;script&gt;">');
  });
  it('the Deal Plan starts from the application (not saved, so nothing counts until they save)', async () => {
    expect(seedPlan(ANSWERS, 'US')).toMatchObject({ industry: 'Commercial HVAC services, 25 staff', geography: 'United States', size: '', cash_flow: '' });
    const { room, eventId } = await liveRoom();
    seedLead('l1');
    const who = seedReg(eventId, 'lr1', 'l1', 'rlr1');
    const e = await attendeeEngage(rt, room, who);
    expect(e.plan).toMatchObject({ data: { industry: 'Commercial HVAC services, 25 staff' }, steps: [], seeded: true });
    expect(q('SELECT * FROM room_plans')).toEqual([]);
    expect(e.pay).toEqual({ payingAs: 'Paying as Dana Lee, l1@example.com for Commercial HVAC services, 25 staff' });
  });
});

// ───────────── the Whop checkout session ─────────────

describe('the Whop checkout session per person', () => {
  it('a checkout configuration with the inline plan and our attribution, cached until it expires', async () => {
    seedLead('l1');
    const id = await pendingRow(rt, { kind: 'offer', regId: 'room:rm1:rlr1', leadId: 'l1', product: 'First Deal Sprint', amount: 300000, currency: 'usd', source: 'room', refId: 'rm1', returnUrl: 'https://apply.test/rooms/rm1/done', pushId: 7, deadline: { at: T0 + 10 * MIN, reason: 'hold' } });
    const row = () => q<Record<string, unknown>>('SELECT * FROM webinar_passes WHERE id = ?', id)[0] as never;
    const s = await sessionFor(rt, row());
    expect(s).toMatchObject({ id: 'ch_test1', planId: 'plan_test1', cached: false });
    const post = calls.filter((c) => c.method === 'POST' && c.path === 'checkout_configurations');
    expect(post).toHaveLength(1);
    expect(post[0].body).toMatchObject({
      plan: { company_id: 'biz_test', currency: 'usd', initial_price: 3000, plan_type: 'one_time', visibility: 'hidden', product: { external_identifier: 'vsl-funnel-first-deal-sprint' } },
      metadata: { pass_id: id, lead_id: 'l1', kind: 'offer', product: 'First Deal Sprint', source: 'room', ref_id: 'rm1', room_id: 'rm1', push_id: '7', pay_link: '1' },
    });
    expect(String(post[0].body!.redirect_url)).toMatch(/^https:\/\/apply\.test\/pay\/wp.+\?return=1$/);
    expect(post[0].headers.authorization).toBe(`Bearer ${API_KEY}`); // server to Whop only
    expect(q('SELECT stripe_session_id, whop_plan_id, checkout_expires_at, deadline_at, push_id FROM webinar_passes WHERE id = ?', id)).toEqual([{ stripe_session_id: 'ch_test1', whop_plan_id: 'plan_test1', checkout_expires_at: T0 + 10 * MIN, deadline_at: T0 + 10 * MIN, push_id: 7 }]);
    // Cached: the second tap reuses it.
    expect(await sessionFor(rt, row())).toMatchObject({ id: 'ch_test1', cached: true });
    expect(calls.filter((c) => c.path === 'checkout_configurations')).toHaveLength(1);
    // The same person and product again reuses the waiting row (and so its session).
    expect(await pendingRow(rt, { kind: 'offer', regId: 'room:rm1:rlr1', leadId: 'l1', product: 'First Deal Sprint', amount: 300000, currency: 'usd', source: 'room', refId: 'rm1', returnUrl: 'https://apply.test/x', pushId: 7, deadline: { at: T0 + 10 * MIN, reason: 'hold' } })).toBe(id);
    // Past the deadline: no session, no payment.
    vi.setSystemTime(T0 + 11 * MIN);
    x('UPDATE webinar_passes SET checkout_expires_at = ? WHERE id = ?', T0, id);
    await expect(sessionFor(rt, row())).rejects.toThrow(PAY_COPY.closed.hold);
  });
  it('metadata names the room and push from the registration id too', () => {
    expect(sessionMetadata({ id: 'wp1', lead_id: 'l1', kind: 'offer', product: 'First Deal Sprint', reg_id: 'room:rmA:who', source: null, ref_id: null, push_id: null } as never)).toMatchObject({ room_id: 'rmA', push_id: '' });
  });
  it('the card fields refuse a payment after the real deadline', async () => {
    seedLead('l1');
    const id = await pendingRow(rt, { kind: 'deposit', regId: 'live:tok', leadId: 'l1', product: 'Engagement deposit', amount: 500000, currency: 'usd', source: 'live', refId: 'ev1', returnUrl: 'https://apply.test/live/welcome', deadline: { at: T0 + MIN, reason: 'offer' } });
    const ref = (await payPageUrl(rt, id)).split('/pay/')[1];
    vi.setSystemTime(T0 + 2 * MIN);
    const r = await payEmbedded(rt, ref, 'ctok_abcdef');
    expect(r).toMatchObject({ ok: false, error: PAY_COPY.closed.offer });
    expect(calls.filter((c) => c.path === 'payments')).toHaveLength(0);
  });
});

// ───────────── the timer ─────────────

describe('the timer: only a real deadline', () => {
  it('no deadline, no timer; the earliest real one wins', () => {
    expect(timerHtml(null)).toBe('');
    expect(pickDeadline([null, undefined, false])).toBeNull();
    expect(pickDeadline([{ at: T0 + HOUR, reason: 'offer' }, { at: T0 + 10 * MIN, reason: 'hold' }])).toEqual({ at: T0 + 10 * MIN, reason: 'hold' });
    expect(rowDeadline({ id: 'x', deadline_at: null })).toBeNull();
    const h = timerHtml({ at: T0 + 90 * MIN, reason: 'offer' }, T0);
    expect(h).toContain(`data-pay-deadline="${T0 + 90 * MIN}"`);
    expect(h).toContain('This offer closes in');
    expect(h).toContain('1:30:00');
    expect(timerHtml({ at: T0 - 1, reason: 'offer' }, T0)).toContain(PAY_COPY.closed.offer);
    expect(clock(2 * DAY + 3 * HOUR)).toBe('2d 3h 00m');
    const copy = payCopy('offer', '$3,000');
    expect(payHead(copy, null, null, T0)).not.toContain('data-pay-deadline');
    expect(payHead(copy, null, { at: T0 + MIN, reason: 'hold' }, T0)).toContain('This price holds for');
  });
  it('the Sprint card has no timer without a price hold, and the hold’s when one is set', async () => {
    seedLead('l1');
    const a = await liveRoom();
    const who = seedReg(a.eventId, 'lr1', 'l1', 'rlr1');
    await savePush(rt, a.room.id, sprintPush(1), 1);
    expect((await sprintCard(rt, 'l1', { roomId: a.room.id, who: who.id })).deadline).toBeNull();
    expect(q('SELECT hold_until FROM room_pushes')).toEqual([{ hold_until: null }]);
    x('UPDATE rooms SET engage = ? WHERE id = ?', JSON.stringify({ priceHold: 15 }), a.room.id);
    await savePush(rt, a.room.id, sprintPush(2), 1);
    expect((await sprintCard(rt, 'l1', { roomId: a.room.id, who: who.id })).deadline).toMatchObject({ at: T0 + 15 * MIN, reason: 'hold', label: 'This price holds for' });
  });
});

// ───────────── the price hold ─────────────

describe('the price hold (per room push, off by default)', () => {
  it('parses only real values', () => {
    expect(priceHoldMin(null)).toBe(0);
    expect(priceHoldMin('{}')).toBe(0);
    expect(priceHoldMin('{"priceHold":0}')).toBe(0);
    expect(priceHoldMin('{"priceHold":20}')).toBe(20);
    expect(priceHoldMin('{"priceHold":999}')).toBe(0);
    expect(priceHoldMin('not json')).toBe(0);
    expect(holdUntilFor('application', T0, 10)).toBeNull();
    expect(holdUntilFor('sprint', T0, 0)).toBeNull();
    expect(holdUntilFor('sprint', T0, 10)).toBe(T0 + 10 * MIN);
  });
  it('is enforced by the server when the checkout is created', async () => {
    seedLead('l1');
    const { room, eventId } = await liveRoom({ priceHold: 10 });
    const who = seedReg(eventId, 'lr1', 'l1', 'rlr1');
    await savePush(rt, room.id, sprintPush(1), 1);
    const back = 'https://apply.test/rooms/x/done?k=sprint';
    const ok = await startRoomSprint(rt, room, who, { returnUrl: back });
    expect(ok.url).toMatch(/\/pay\/wp/);
    expect(q("SELECT deadline_at, deadline_reason, push_id FROM webinar_passes WHERE lead_id = 'l1'")).toEqual([{ deadline_at: T0 + 10 * MIN, deadline_reason: 'hold', push_id: 1 }]);
    vi.setSystemTime(T0 + 10 * MIN);
    expect(await startRoomSprint(rt, room, who, { returnUrl: back })).toEqual({ error: PAY_COPY.closed.hold });
    expect(await startRoomSprint(rt, room, who, { oneClick: true, returnUrl: back })).toEqual({ error: PAY_COPY.closed.hold });
  });
  it('without a hold the Sprint stays open as long as the push', async () => {
    seedLead('l1');
    const { room, eventId } = await liveRoom();
    const who = seedReg(eventId, 'lr1', 'l1', 'rlr1');
    await savePush(rt, room.id, sprintPush(1), 1);
    vi.setSystemTime(T0 + 5 * HOUR);
    expect((await startRoomSprint(rt, room, who, { returnUrl: 'https://apply.test/r' })).url).toMatch(/\/pay\/wp/);
    expect(q("SELECT deadline_at FROM webinar_passes WHERE lead_id = 'l1'")).toEqual([{ deadline_at: null }]);
  });
});

// ───────────── tracking ─────────────

describe('tracking: checkout started per card, with the push', () => {
  it('a stage row with the card and push, and Meta’s event once per registration (same key as the stage sync)', async () => {
    seedLead('l1');
    const { room, eventId } = await liveRoom();
    const who = seedReg(eventId, 'lrtrack01', 'l1', 'rlr1');
    await savePush(rt, room.id, sprintPush(3), 1);
    await startRoomSprint(rt, room, who, { returnUrl: 'https://apply.test/r' });
    expect(q("SELECT funnel, stage, reg_id, detail FROM attr_stages WHERE stage = 'checkout_started'")).toEqual([{ funnel: 'live', stage: 'checkout_started', reg_id: 'lrtrack01', detail: 'sprint:push 3:page' }]);
    expect(q("SELECT key, event_id FROM attr_capi WHERE name = 'attr_checkout_started'")).toEqual([{ key: 'attr_checkout_started:lrtrack01', event_id: 'ics-lrtrack01' }]);
    // Again: no second stage row, no second Meta event.
    await checkoutStarted(rt, { lead_id: 'l1', reg_id: `room:${room.id}:rlr1`, kind: 'offer', source: 'room', ref_id: room.id, push_id: 3 }, 'again');
    expect(q("SELECT COUNT(*) AS n FROM attr_stages WHERE stage = 'checkout_started'")).toEqual([{ n: 1 }]);
    expect(q("SELECT COUNT(*) AS n FROM attr_capi WHERE name = 'attr_checkout_started'")).toEqual([{ n: 1 }]);
    // The first-party event names the card and the push.
    const ev = q<{ props: string }>("SELECT props FROM events WHERE name = 'paylink_checkout_started' LIMIT 1")[0];
    if (ev) expect(JSON.parse(ev.props)).toMatchObject({ card: 'sprint', push_id: 3 });
  });
});

// ───────────── signed links, secrets, copy ─────────────

describe('payment links in emails', () => {
  it('signed, personal and tamper-proof; never carries the email address', async () => {
    const url = await payLinkUrl(rt, { leadId: 'l1', kind: 'deposit', source: 'live', ref: 'ev1' });
    expect(url).toMatch(/^https:\/\/apply\.test\/pay\/go\/[A-Za-z0-9_-]+\.[0-9a-f]{24}$/);
    expect(url).not.toContain('example.com');
    const ref = url.split('/pay/go/')[1];
    expect(await readPayLink(rt, ref)).toEqual({ leadId: 'l1', kind: 'deposit', source: 'live', ref: 'ev1' });
    expect(await readPayLink(rt, `${ref.slice(0, -1)}${ref.endsWith('0') ? '1' : '0'}`)).toBeNull();
    expect(await readPayLink(rt, 'nonsense')).toBeNull();
  });
  it('the live “three questions” email buys from its button only while the offer is open', () => {
    const base = { name: 'Dana', title: 'Live', room: 'https://apply.test/live/room/t', deposit: '$5,000', onboarding: null, highlights: [], replayCloses: null };
    expect(postEmail('nobuy_questions', { ...base, closes: 'Friday 6 Nov, 9:00am', pay: 'https://apply.test/pay/go/x.y' }).button).toEqual({ label: 'Secure my place', href: 'https://apply.test/pay/go/x.y' });
    expect(postEmail('nobuy_questions', { ...base, closes: null, pay: 'https://apply.test/pay/go/x.y' }).button.href).toBe(base.room);
  });
});

describe('no secrets in pages', () => {
  it('neither the API key nor the webhook secret reaches anything a browser sees', async () => {
    rt = makeRt({ ...SETTINGS, WHOP_WEBHOOK_SECRET: 'ws_very_secret' });
    seedLead('l1');
    const { room, eventId } = await liveRoom({ priceHold: 5 });
    const who = seedReg(eventId, 'lr1', 'l1', 'rlr1');
    await savePush(rt, room.id, sprintPush(1), 1);
    const id = await pendingRow(rt, { kind: 'offer', regId: 'room:x:rlr1', leadId: 'l1', product: 'First Deal Sprint', amount: 300000, currency: 'usd', source: 'room', refId: room.id, returnUrl: 'https://apply.test/r', deadline: { at: T0 + 5 * MIN, reason: 'hold' } });
    const s = await sessionFor(rt, q<Record<string, unknown>>('SELECT * FROM webinar_passes WHERE id = ?', id)[0] as never);
    const pf = await prefillFor(rt, 'l1');
    const seen = [
      JSON.stringify(await attendeeEngage(rt, room, who)),
      payHead(payCopy('offer', '$3,000'), pf, { at: T0 + 5 * MIN, reason: 'hold' }, T0),
      whopEmbedHtml({ planId: s.planId!, id: s.id }, pf),
      await payPageUrl(rt, id), s.url,
    ].join('\n');
    expect(seen).not.toContain(API_KEY);
    expect(seen).not.toContain('ws_very_secret');
    expect(seen).not.toContain('test-session-secret');
  });
});

describe('copy', () => {
  it('every payment-link string passes the copy rules', () => {
    const strings = [
      ...Object.values(PAY_COPY.timer), ...Object.values(PAY_COPY.closed), PAY_COPY.whopButton, PAY_COPY.whopNote, PAY_COPY.newTab, PAY_COPY.holdSetting, PAY_COPY.linkInvalid, PAY_COPY.linkPaid,
      deadlineLabel('replay'), payingAs({ email: 'd@x.com', firstName: 'Dana', lastName: 'Lee', name: 'Dana Lee', phone: null, country: null, company: 'Lee HVAC', revenue: null })!,
    ];
    for (const s of strings) expect(auditCopy(s), s).toEqual([]);
  });
});
