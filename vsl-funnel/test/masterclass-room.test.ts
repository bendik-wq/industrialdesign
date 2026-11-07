import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/app';
import { auditCopy } from '../src/content/copy-rules';
import { CONVERT_COPY, applicationConfig, applicationEvent, sprintPayExtras, sprintPaySheet, submitMasterclassApplication } from '../src/webinar/room-convert';
import { scoreApplication } from '../src/funnel/scoring';
import { STAGES } from '../src/attribution/stages';
import { PassError } from '../src/webinar/pass';
import type { Registration } from '../src/webinar/webinar';
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
const TOKEN = 'tokentokentoken12345';
const SETTINGS: Record<string, string> = {
  SALES_TIMEZONE: 'America/New_York', SITE_NAME: 'G&L', WHOP_API_KEY: 'apik_test', WHOP_COMPANY_ID: 'biz_test', WEBINAR_PASS: 'upsell', WEBINAR_PASS_PRICE: '3000',
  WEBINAR_DURATION_MIN: '66', WEBINAR_PITCH_AT: '38', WEBINAR_REPLAY_HOURS: '48',
};
let db: DatabaseSync;
let rt: Runtime;
const pending: Promise<unknown>[] = [];
const ALL = () => Object.fromEntries(SETTING_DEFS.map((d) => [d.key, ''])) as Record<string, string>;
const makeRt = (s: Record<string, string> = SETTINGS) => ({ env: { DB: d1(db), SESSION_SECRET: 'test-session-secret' }, settings: { ...ALL(), ...s }, reps: [], origin: 'https://apply.test', waitUntil: (p: Promise<unknown>) => { pending.push(p.catch(() => null)); } }) as unknown as Runtime;
const q = <T = Record<string, unknown>>(sql: string, ...a: unknown[]) => db.prepare(sql).all(...(a as (string | number | null)[])) as T[];
const x = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...(a.map((v) => (v === undefined ? null : v)) as (string | number | null)[]));

let calls: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
function stubWhop() {
  calls = [];
  let n = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { method?: string; body?: string } = {}) => {
    const u = String(url);
    const path = u.replace('https://api.whop.com/api/v1/', '');
    calls.push({ method: init.method ?? 'GET', path, body: init.body && init.body.startsWith('{') ? JSON.parse(init.body) : null });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (!u.startsWith('https://api.whop.com/')) return json(200, { ok: true });
    if (path === 'checkout_configurations' && init.method === 'POST') { n++; return json(201, { id: `ch_test${n}`, purchase_url: `https://whop.com/checkout/plan_test${n}?session=ch_test${n}`, plan: { id: `plan_test${n}` } }); }
    return json(404, { error: { message: 'not stubbed' } });
  }));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  db = freshDb();
  rt = makeRt();
  stubWhop();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); pending.length = 0; });

const APP_ANSWERS = { business: 'Commercial HVAC services, 25 staff', role: 'owner', revenue: '3_10m', profit: '250k_1m', goal: 'acquire', timeline: '0_6', blockers: ['funding'], readiness: 'yes', why_now: 'We have plateaued at $4M and I want to buy the competitor across town before someone else does.' };

/** A $1M+ registration 45 minutes into a showing (past the 38:00 pitch), with a paid $100 Whop ticket. */
function seed(o: { band?: string; startedAgoMin?: number; unlocked?: boolean; maxPos?: number; ticket?: boolean; applied?: boolean } = {}) {
  const start = T0 - (o.startedAgoMin ?? 45) * MIN;
  x(`INSERT INTO leads (id, ref_code, created_at, updated_at, visitor_id, first_name, last_name, email, status, revenue_band, country, industry, app_completed_at, webinar_token)
     VALUES ('l1', 'R1', ?, ?, 'v1', 'Dana', 'Lee', 'dana@example.com', 'partial', ?, 'US', 'HVAC', ?, ?)`, T0 - DAY, T0 - DAY, o.band ?? '3m-10m', o.applied ? T0 - DAY : null, TOKEN);
  x("INSERT INTO webinar_sessions (id, starts_at, mode, status, auto, created_at) VALUES ('s1', ?, 'evergreen', 'scheduled', 1, ?)", start, T0 - DAY);
  x("INSERT INTO webinar_registrations (id, token, session_id, lead_id, created_at, revenue_band, joined_at, last_seen_at, max_position) VALUES ('r1', ?, 's1', 'l1', ?, ?, ?, ?, ?)",
    TOKEN, T0 - DAY, o.band ?? '3m-10m', start, T0, o.maxPos ?? (o.startedAgoMin ?? 45) * 60);
  if (o.unlocked !== false) x("UPDATE webinar_registrations SET offer_unlocked_at = ? WHERE id = 'r1'", start + 38 * MIN);
  if (o.ticket !== false) {
    x(`INSERT INTO webinar_passes (id, reg_id, lead_id, kind, product, status, amount, currency, paid_at, provider, stripe_session_id, created_at, updated_at)
       VALUES ('t1', 'r1', 'l1', 'seat', 'Masterclass ticket', 'paid', 10000, 'usd', ?, 'whop', 'ch_t', ?, ?)`, T0 - HOUR, T0 - HOUR, T0 - HOUR);
  }
  return { start };
}
const reg = () => q<Registration & { offer_unlocked_at: number | null }>("SELECT * FROM webinar_registrations WHERE id = 'r1'")[0];

describe('copy', () => {
  it('every string the masterclass adds passes the copy rules', () => {
    for (const [k, v] of Object.entries(CONVERT_COPY)) {
      expect(auditCopy(v.replace(/\{\w+\}/g, '3')), k).toEqual([]);
    }
  });
  it('the room application is an auto-funnel stage too', () => {
    expect(STAGES.find((s) => s.id === 'room_application')!.funnels).toContain('auto');
  });
});

describe('the application sheet in the masterclass room', () => {
  it('is offered at the edition’s pitch minute, prefilled from the registration; not to someone who applied or under $1M', async () => {
    seed();
    const cfg = (await applicationConfig(rt, reg(), true))!;
    expect(cfg.atSec).toBe(38 * 60);
    expect(cfg.answers.revenue).toBe('3_10m'); // from the registration's revenue band
    expect(cfg.answers.business).toBe('HVAC');
    expect(cfg).toMatchObject({ name: 'Dana Lee', email: 'dana@example.com', submitted: false, preview: false });
    expect(cfg.questions.map((qq) => qq.id)).toContain('why_now');
    expect(await applicationConfig(rt, reg(), false)).toBeNull();
    // The AI edition's timeline moves the card with its pitch.
    rt = makeRt({ ...SETTINGS, WEBINAR_PITCH_AT: '' , WEBINAR_EDITION: 'ai' });
    const ai = await applicationConfig(rt, reg(), true);
    const { edition } = await import('../src/webinar/editions');
    expect(ai!.atSec).toBe(edition({ WEBINAR_EDITION: 'ai' }).pitchAtMin * 60);
    // The Funnel HQ preview never reads a lead.
    expect(await applicationConfig(rt, reg(), true, { preview: true })).toMatchObject({ preview: true, submitted: false });
  });
  it('not again once they applied', async () => {
    seed({ applied: true });
    expect(await applicationConfig(rt, reg(), true)).toBeNull();
  });
  it('records shown / opened / started once each, and nothing before the pitch', async () => {
    seed({ startedAgoMin: 20, maxPos: 20 * 60, unlocked: false });
    expect(await applicationEvent(rt, reg(), { stage: 'shown', pos: 20 * 60 })).toEqual({ ok: false });
    expect(await applicationEvent(rt, reg(), { stage: 'nonsense', pos: 40 * 60 })).toEqual({ ok: false });
    for (let i = 0; i < 2; i++) {
      await applicationEvent(rt, reg(), { stage: 'shown', pos: 38 * 60, replay: true });
      await applicationEvent(rt, reg(), { stage: 'opened', pos: 38 * 60 + 5 });
      await applicationEvent(rt, reg(), { stage: 'started', pos: 38 * 60 + 9 });
    }
    expect(q("SELECT key FROM webinar_interactions WHERE reg_id = 'r1' AND kind = 'application' ORDER BY created_at, key")).toHaveLength(3);
    expect(q("SELECT detail FROM attr_stages WHERE reg_id = 'r1' AND funnel = 'auto' AND stage = 'room_push' ORDER BY detail")).toEqual([
      { detail: 'application:opened' }, { detail: 'application:shown' }, { detail: 'application:started' },
    ]);
  });
  it('sends through the same scoring and records the stage and Meta’s event once; ROOM_APP_FOLLOWUPS off sends no follow-ups', async () => {
    seed();
    const r = await submitMasterclassApplication(rt, reg(), { answers: APP_ANSWERS, pos: 40 * 60 }, null);
    await Promise.all(pending);
    const expected = scoreApplication(APP_ANSWERS as never, { country: 'US', email: 'dana@example.com', phone: null, blocklist: [] });
    expect(r).toMatchObject({ ok: true, tier: expected.tier, score: expected.score });
    // A and B tiers book straight from the room, through the registration's handoff to /book.
    expect(r.book).toBe(expected.tier === 'C' ? null : `${rt.origin}/w/${TOKEN}?to=book`);
    expect(q("SELECT tier, score, app_completed_at IS NOT NULL AS done FROM leads WHERE id = 'l1'")[0]).toEqual({ tier: expected.tier, score: expected.score, done: 1 });
    expect(q("SELECT stage, funnel, value, detail FROM attr_stages WHERE reg_id = 'r1' AND stage = 'room_application'")).toEqual([{ stage: 'room_application', funnel: 'auto', value: expected.score, detail: expected.tier }]);
    expect(q("SELECT name, event_id FROM attr_capi WHERE lead_id = 'l1'")).toEqual([{ name: 'attr_room_application', event_id: 'room_application-r1' }]);
    expect(q<{ n: number }>("SELECT COUNT(*) AS n FROM emails WHERE lead_id = 'l1' AND (sequence LIKE 'tier_%' OR sequence = 'nurture')")[0].n).toBe(0);
    expect(q<{ n: number }>("SELECT COUNT(*) AS n FROM outbound_calls WHERE lead_id = 'l1'")[0].n).toBe(0);
    // Again (a double tap): no second Meta event.
    await submitMasterclassApplication(rt, reg(), { answers: APP_ANSWERS }, null);
    expect(q("SELECT name FROM attr_capi WHERE lead_id = 'l1'")).toHaveLength(1);
    // The config no longer offers it.
    expect(await applicationConfig(rt, reg(), true)).toBeNull();
  });
  it('ROOM_APP_FOLLOWUPS on: the application’s usual follow-ups go, as in the live room', async () => {
    rt = makeRt({ ...SETTINGS, ROOM_APP_FOLLOWUPS: 'on' });
    seed();
    await submitMasterclassApplication(rt, reg(), { answers: APP_ANSWERS }, null);
    await Promise.all(pending);
    const onCount = q<{ n: number }>("SELECT COUNT(*) AS n FROM emails WHERE lead_id = 'l1'")[0].n;
    db = freshDb(); rt = makeRt(); seed();
    await submitMasterclassApplication(rt, reg(), { answers: APP_ANSWERS }, null);
    await Promise.all(pending);
    const offCount = q<{ n: number }>("SELECT COUNT(*) AS n FROM emails WHERE lead_id = 'l1'")[0].n;
    expect(onCount).toBeGreaterThan(offCount);
  });
  it('a missing answer points at its question', async () => {
    seed();
    const { why_now: _w, ...partial } = APP_ANSWERS;
    await expect(submitMasterclassApplication(rt, reg(), { answers: partial }, null)).rejects.toMatchObject({ field: 'why_now', status: 400 });
    await expect(submitMasterclassApplication(rt, reg(), { answers: { ...APP_ANSWERS, role: 'not-an-option' } }, null)).rejects.toMatchObject({ field: 'role' });
  });
});

describe('the Sprint’s payment sheet in the masterclass room', () => {
  it('says who is paying', async () => {
    seed();
    expect(await sprintPayExtras(rt, reg())).toEqual({ paySheet: true, payingAs: 'Paying as Dana Lee, dana@example.com for HVAC' });
    expect(await sprintPayExtras(makeRt({ ...SETTINGS, WHOP_API_KEY: '' }), reg())).toMatchObject({ paySheet: false });
  });
  it('opens Whop’s embedded checkout, prefilled, under the replay close, with the ticket credited; one row and one session per viewer', async () => {
    const { start } = seed();
    const r = await sprintPaySheet(rt, reg());
    expect(r.ok).toBe(true);
    const sheet = (r as { sheet: Record<string, unknown> }).sheet;
    const close = start + 66 * MIN + 48 * HOUR;
    expect(sheet).toMatchObject({
      planId: 'plan_test1', sessionId: 'ch_test1', hostedUrl: 'https://whop.com/checkout/plan_test1?session=ch_test1', payingAs: 'Paying as Dana Lee, dana@example.com for HVAC',
      prefill: { 'data-whop-checkout-prefill-email': 'dana@example.com', 'data-whop-checkout-prefill-name': 'Dana Lee' }, deadline: close,
    });
    expect(String(sheet.timer)).toContain(`data-pay-deadline="${close}"`);
    expect(String(sheet.timer)).toContain('Closes with your replay in');
    expect(String(sheet.payPage)).toMatch(/^https:\/\/apply\.test\/pay\/wp[0-9a-z]+\.[0-9a-f]{24}$/);
    const row = q("SELECT kind, status, amount, ticket_credit, source, ref_id, deadline_at, deadline_reason, embedded, return_url, fast_bonus FROM webinar_passes WHERE kind = 'offer'");
    expect(row).toEqual([{ kind: 'offer', status: 'pending', amount: 290000, ticket_credit: 10000, source: 'auto', ref_id: 's1', deadline_at: close, deadline_reason: 'replay', embedded: 1, return_url: `https://apply.test/webinar/sprint/${TOKEN}?welcome=1`, fast_bonus: 1 }]); // inside the 24-hour fast-action window
    const cfgCall = calls.find((c) => c.path === 'checkout_configurations')!;
    expect(cfgCall.body!.metadata).toMatchObject({ lead_id: 'l1', kind: 'offer', source: 'auto', ref_id: 's1' });
    // Tracking: the auto funnel's checkout stage and Meta's event, each once (the same event id as the payment links).
    expect(q("SELECT stage, detail FROM attr_stages WHERE reg_id = 'r1' AND stage = 'checkout_started'")).toEqual([{ stage: 'checkout_started', detail: 'sprint:pay_sheet' }]);
    expect(q("SELECT name, event_id FROM attr_capi WHERE lead_id = 'l1'")).toEqual([{ name: 'attr_checkout_started', event_id: 'checkout_started-r1' }]); // (a real registration id is long enough for the ics- id)
    // Opened again: the same row and the cached session (no second Whop call, no second event).
    const again = await sprintPaySheet(rt, reg());
    expect((again as { sheet: { sessionId: string } }).sheet.sessionId).toBe('ch_test1');
    expect(calls.filter((c) => c.path === 'checkout_configurations')).toHaveLength(1);
    expect(q("SELECT id FROM webinar_passes WHERE kind = 'offer'")).toHaveLength(1);
    expect(q("SELECT name FROM attr_capi WHERE lead_id = 'l1'")).toHaveLength(1);
  });
  it('is refused before the pitch, after the replay closes and under $1M; a buyer goes to their Sprint page', async () => {
    seed({ startedAgoMin: 20, maxPos: 20 * 60, unlocked: false });
    await expect(sprintPaySheet(rt, reg())).rejects.toBeInstanceOf(PassError);
    expect(calls).toHaveLength(0);
    db = freshDb(); rt = makeRt(); seed();
    vi.setSystemTime(T0 + 3 * DAY);
    await expect(sprintPaySheet(rt, reg())).rejects.toMatchObject({ status: 410 });
    vi.setSystemTime(T0);
    db = freshDb(); rt = makeRt(); seed({ band: '100k-1m' });
    await expect(sprintPaySheet(rt, reg())).rejects.toMatchObject({ status: 403 });
    db = freshDb(); rt = makeRt(); seed();
    x(`INSERT INTO webinar_passes (id, reg_id, lead_id, kind, product, status, amount, currency, paid_at, provider, stripe_session_id, created_at, updated_at)
       VALUES ('o1', 'r1', 'l1', 'offer', 'First Deal Sprint', 'paid', 290000, 'usd', ?, 'whop', 'ch_o', ?, ?)`, T0, T0, T0);
    expect(await sprintPaySheet(rt, reg())).toMatchObject({ ok: true, paid: true, next: `https://apply.test/webinar/sprint/${TOKEN}?welcome=1` });
  });
  it('Whop refusing the session leaves the card form on our pay page (same row, same deadline)', async () => {
    seed();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 500, headers: { 'content-type': 'application/json' } })));
    const r = await sprintPaySheet(rt, reg());
    expect((r as { fallback: string }).fallback).toMatch(/^https:\/\/apply\.test\/pay\/wp/);
    expect(q("SELECT status, deadline_reason FROM webinar_passes WHERE kind = 'offer'")).toEqual([{ status: 'pending', deadline_reason: 'replay' }]);
  });
});
