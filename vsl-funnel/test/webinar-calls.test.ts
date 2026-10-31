import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/app';
import { auditCopy, auditEmail } from '../src/content/copy-rules';
import { WEBINAR_CALL_CONSENT, recordCallConsent } from '../src/integrations/call-consent';
import { handleElevenWebhook, processCallQueue, type OutboundCall } from '../src/integrations/elevenlabs';
import {
  DEFAULT_STEPS, STEP_META, W_FIRST_MESSAGE, W_KINDS, buildWebinarAgent, callVariables, ctxForRef, finishWebinarCall, linkMail, planWebinarCalls, saveConfig, scriptIssues,
  sweepQueue, webinarAgentPrompt, webinarCallsReport, webinarPreDial,
} from '../src/integrations/webinar-calls';
import { GUARANTEE_BODY, MONEY_BACK_BODY } from '../src/sales/guarantee';
import { getLead, type Lead } from '../src/funnel/leads';

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
  return { prepare, batch: async (stmts: { sql: string; run: () => Promise<unknown>; all: () => Promise<unknown> }[]) => { const out = []; for (const s of stmts) out.push(/^\s*select/i.test(s.sql) ? await s.all() : await s.run()); return out; } };
}
function freshDb() {
  const db = new DatabaseSync(':memory:');
  const dir = `${node.cwd()}/migrations`;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(`${dir}/${f}`, 'utf8'));
  return db;
}

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
// Tuesday 3 Nov 2026, 02:00 UTC: 10:00 in Perth, 13:00 in Sydney (inside calling hours across Australia).
const T0 = Date.parse('2026-11-03T02:00:00Z');
const SETTINGS: Record<string, string> = {
  ELEVENLABS_API_KEY: 'sk_test', ELEVENLABS_AGENT_ID: 'agent_main', ELEVENLABS_PHONE_NUMBER_ID: 'ph_1', ELEVENLABS_WEBINAR_AGENT_ID: 'agent_web',
  AI_CALL_CALLBACK_NUMBER: '+61 2 9000 0000', SALES_TIMEZONE: 'Australia/Sydney', WEBINAR_DURATION_MIN: '90', WEBINAR_PITCH_AT: '60', WEBINAR_REPLAY_HOURS: '48',
  WEBINAR_PASS: 'upsell', WHOP_API_KEY: 'apik_test', WHOP_COMPANY_ID: 'biz_test', SITE_NAME: 'G&L',
};
let db: DatabaseSync;
let rt: Runtime;
const pending: Promise<unknown>[] = [];
const makeRt = (s: Record<string, string> = SETTINGS) =>
  ({ env: { DB: d1(db) }, settings: { ...s }, reps: [], origin: 'https://apply.test', waitUntil: (p: Promise<unknown>) => { pending.push(p.catch(() => null)); } }) as unknown as Runtime;
const q = <T = Record<string, unknown>>(sql: string, ...a: unknown[]) => db.prepare(sql).all(...(a as (string | number | null)[])) as T[];
const x = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...(a.map((v) => (v === undefined ? null : v)) as (string | number | null)[]));

let n = 0;
function seedLead(o: { consent?: boolean; phone?: string | null; dnc?: boolean; unsub?: boolean } = {}) {
  const id = `l${++n}`;
  x(`INSERT INTO leads (id, ref_code, created_at, updated_at, visitor_id, first_name, email, phone, call_consent_at, call_consent_text, do_not_call_at, unsubscribed_at, status)
     VALUES (?, ?, ?, ?, ?, 'Dana', ?, ?, ?, ?, ?, ?, 'partial')`,
    id, `R${n}X`, T0 - DAY, T0 - DAY, `v${n}`, `dana${n}@example.com`, o.phone === undefined ? '+61412345678' : o.phone,
    o.consent === false ? null : T0 - DAY, o.consent === false ? null : 'webinar-v1', o.dnc ? T0 : null, o.unsub ? T0 : null);
  return id;
}
function seedSession(startsAt: number) {
  const id = `ws${++n}`;
  x(`INSERT INTO webinar_sessions (id, starts_at, mode, status, created_at) VALUES (?, ?, 'evergreen', 'scheduled', ?)`, id, startsAt, T0 - 3 * DAY);
  return id;
}
function seedReg(sessionId: string, leadId: string, o: { created?: number; joined?: number | null; seen?: number | null; pos?: number; unlocked?: number | null; replay?: number | null } = {}) {
  const id = `wr${++n}`;
  x(`INSERT INTO webinar_registrations (id, token, session_id, lead_id, created_at, joined_at, last_seen_at, max_position, offer_unlocked_at, replay_at, revenue_band)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '3m-10m')`, id, `tok${n}abcdefghijklmnop`, sessionId, leadId, o.created ?? T0 - 2 * DAY, o.joined ?? null, o.seen ?? null, o.pos ?? 0, o.unlocked ?? null, o.replay ?? null);
  return id;
}
function seedPass(leadId: string, regId: string, kind: 'offer' | 'deposit' = 'offer', paidAt = T0 - 40 * MIN) {
  const id = `p${++n}`;
  x(`INSERT INTO webinar_passes (id, reg_id, lead_id, kind, status, amount, currency, paid_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'paid', 300000, 'usd', ?, ?, ?)`, id, regId, leadId, kind, paidAt, paidAt, paidAt);
  return id;
}
const calls = () => q<OutboundCall & { wc_ref: string; wc_meta: string | null; wc_dialed_at: number | null }>('SELECT * FROM outbound_calls ORDER BY created_at, id');
const plan = async (t = T0) => { vi.setSystemTime(t); return planWebinarCalls(rt, t); };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  db = freshDb();
  rt = makeRt();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); pending.length = 0; });

// ───────────── triggers ─────────────

describe('each trigger queues the right call', () => {
  it('welcome shortly after registering, for a session days away', async () => {
    const lead = seedLead();
    const reg = seedReg(seedSession(T0 + 2 * DAY), lead, { created: T0 - 2 * MIN });
    expect(await plan()).toMatchObject({ queued: 1 });
    const c = calls()[0];
    expect(c).toMatchObject({ kind: 'w_pre_welcome', wc_ref: `auto:${reg}`, status: 'queued' });
    expect(c.run_at).toBe(T0 + 3 * MIN);
    await plan(T0 + 5 * MIN);
    expect(calls()).toHaveLength(1); // deduped per person, step and session
  });

  it('day-before reminder for a scheduled session registered well ahead', async () => {
    const lead = seedLead();
    const reg = seedReg(seedSession(T0 + 24 * HOUR + 10 * MIN), lead, { created: T0 - 3 * DAY });
    await plan();
    expect(calls().map((c) => [c.kind, c.wc_ref])).toEqual([['w_pre_day', `auto:${reg}`]]);
  });

  it('"starting in 10 minutes", but not for someone already in the room', async () => {
    const s = seedSession(T0 + 15 * MIN);
    const a = seedLead(), b = seedLead();
    seedReg(s, a, { created: T0 - DAY });
    const rb = seedReg(s, b, { created: T0 - DAY });
    x("INSERT INTO webinar_presence (session_id, who, kind, first_at, seen_at) VALUES (?, ?, 'viewer', ?, ?)", s, rb, T0 - MIN, T0 - 30_000);
    await plan();
    const pre = calls().filter((c) => c.kind === 'w_pre_start');
    expect(pre).toHaveLength(1);
    expect(pre[0].lead_id).toBe(a);
    expect(pre[0].run_at).toBe(T0 + 5 * MIN);
  });

  it('left mid-session (no heartbeat for the wait), remembering the minute and the offer', async () => {
    const s = seedSession(T0 - 70 * MIN);
    const lead = seedLead();
    const reg = seedReg(s, lead, { joined: T0 - 69 * MIN, seen: T0 - 10 * MIN, pos: 60 * 60, unlocked: T0 - 11 * MIN });
    await plan();
    const c = calls().find((r) => r.kind === 'w_left')!;
    expect(c.wc_ref).toBe(`auto:${reg}`);
    expect(JSON.parse(c.wc_meta!)).toMatchObject({ minute: 60, offerUnlocked: true });
  });

  it('a normal end (seen in the last 5 minutes) is not "left"', async () => {
    const s = seedSession(T0 - 100 * MIN); // 90-minute session ended 10 minutes ago
    seedReg(s, seedLead(), { joined: T0 - 99 * MIN, seen: T0 - 11 * MIN, pos: 89 * 60 });
    await plan();
    expect(calls().filter((c) => c.kind === 'w_left')).toHaveLength(0);
  });

  it('after the session: attended without buying (inside the offer window), missed it (replay call)', async () => {
    const s = seedSession(T0 - 90 * MIN - 2 * HOUR); // ended 2 hours ago
    const a = seedLead(), b = seedLead();
    seedReg(s, a, { joined: T0 - 3.4 * HOUR, seen: T0 - 2 * HOUR, pos: 89 * 60, unlocked: T0 - 2.5 * HOUR });
    seedReg(s, b);
    await plan();
    expect(calls().map((c) => [c.lead_id, c.kind]).sort()).toEqual([[a, 'w_post_nobuy'], [b, 'w_post_missed']]);
  });

  it('thank-you call after a purchase', async () => {
    const lead = seedLead();
    const reg = seedReg(seedSession(T0 - 4 * HOUR), lead, { joined: T0 - 4 * HOUR, unlocked: T0 - 3 * HOUR });
    const pass = seedPass(lead, reg, 'offer', T0 - 20 * MIN);
    await plan();
    const bought = calls().filter((c) => c.kind === 'w_post_bought');
    expect(bought.map((c) => c.wc_ref)).toEqual([`pass:${pass}`]);
    expect(bought[0].run_at).toBe(T0 + 10 * MIN);
    expect(calls().some((c) => c.kind === 'w_post_nobuy')).toBe(false); // a buyer is never called about what they bought
  });

  it('live Zoom: welcome and left; challenge: welcome after the ticket is paid', async () => {
    const lead = seedLead();
    x(`INSERT INTO live_webinars (id, title, starts_at, tz, duration_min, status, offer_opened_at, created_at, updated_at) VALUES ('ev1', 'Live', ?, 'UTC', 120, 'scheduled', ?, ?, ?)`, T0 - 60 * MIN, T0 - 30 * MIN, T0, T0);
    x(`INSERT INTO live_webinar_regs (id, token, event_id, lead_id, joined_at, last_seen_at, created_at) VALUES ('lr1', 'ltok1', 'ev1', ?, ?, ?, ?)`, lead, T0 - 59 * MIN, T0 - 15 * MIN, T0 - 2 * DAY);
    const lead2 = seedLead();
    x(`INSERT INTO challenge_cohorts (id, name, start_date, start_time, timezone, created_at, updated_at) VALUES ('co1', 'Nov', '2026-11-10', '19:00', 'UTC', ?, ?)`, T0, T0);
    for (let d = 1; d <= 5; d++) x('INSERT INTO challenge_days (cohort_id, day, starts_at, duration_min, updated_at) VALUES (?, ?, ?, 90, ?)', 'co1', d, T0 + 7 * DAY + (d - 1) * DAY, T0);
    x(`INSERT INTO challenge_registrations (id, token, cohort_id, lead_id, status, created_at, paid_at) VALUES ('cr1', 'ctok1', 'co1', ?, 'paid', ?, ?)`, lead2, T0 - 10 * MIN, T0 - 8 * MIN);
    await plan();
    const got = calls().map((c) => [c.kind, c.wc_ref]);
    expect(got).toContainEqual(['w_left', 'live:lr1']);
    expect(got).toContainEqual(['w_pre_welcome', 'ch:cr1:1']);
  });
});

// ───────────── goals, rejoin, opt-out ─────────────

describe('stops', () => {
  it('rejoining within the wait cancels the left call', async () => {
    const s = seedSession(T0 - 50 * MIN);
    const lead = seedLead();
    const reg = seedReg(s, lead, { joined: T0 - 49 * MIN, seen: T0 - 10 * MIN, pos: 40 * 60 });
    await plan();
    expect(calls()[0]).toMatchObject({ kind: 'w_left', status: 'queued' });
    x('UPDATE webinar_registrations SET last_seen_at = ? WHERE id = ?', T0 + MIN, reg); // back in the room
    expect(await sweepQueue(rt, T0 + 2 * MIN)).toBe(1);
    expect(calls()[0]).toMatchObject({ status: 'cancelled', error: 'rejoined' });
  });

  it('a purchase (goal met) cancels the after-session call before it is placed', async () => {
    const s = seedSession(T0 - 90 * MIN - 2 * HOUR);
    const lead = seedLead();
    const reg = seedReg(s, lead, { joined: T0 - 3.4 * HOUR, unlocked: T0 - 2.5 * HOUR });
    await plan();
    expect(calls()[0].kind).toBe('w_post_nobuy');
    seedPass(lead, reg, 'offer', T0 + MIN);
    vi.setSystemTime(T0 + 2 * MIN);
    await sweepQueue(rt, T0 + 2 * MIN);
    expect(calls().find((c) => c.kind === 'w_post_nobuy')).toMatchObject({ status: 'cancelled', error: 'bought' });
  });

  it('watching the replay stops the replay call; the dialler also re-checks right before dialling', async () => {
    const s = seedSession(T0 - 90 * MIN - 2 * HOUR);
    const lead = seedLead();
    const reg = seedReg(s, lead);
    await plan();
    const c = calls()[0];
    x('UPDATE webinar_registrations SET replay_at = ? WHERE id = ?', T0 + MIN, reg);
    x("UPDATE outbound_calls SET status = 'dialing', attempts = 1 WHERE id = ?", c.id);
    const row = calls()[0];
    expect(await webinarPreDial(rt, row, (await getLead(rt.env, lead))!, T0 + 2 * MIN)).toBeNull();
    expect(calls()[0]).toMatchObject({ status: 'skipped', error: 'watched the replay' });
  });

  it('"stop" on any call stops every flow, every queued call and every pending email', async () => {
    const lead = seedLead();
    const s = seedSession(T0 + 2 * DAY);
    const reg = seedReg(s, lead, { created: T0 - MIN });
    await plan();
    x(`INSERT INTO outbound_calls (id, lead_id, kind, status, run_at, attempts, created_at, updated_at, wc_ref) VALUES ('oc_other', ?, 'w_post_missed', 'queued', ?, 0, ?, ?, ?)`, lead, T0 + DAY, T0, T0, `auto:${reg}`);
    x(`INSERT INTO emails (id, lead_id, sequence, step, template, to_email, send_at, status, created_at) VALUES ('m1', ?, 'webinar', 1, 'w_1', 'a@b.c', ?, 'pending', ?)`, lead, T0 + HOUR, T0);
    const call = calls().find((c) => c.kind === 'w_pre_welcome')!;
    x("UPDATE outbound_calls SET status = 'dialing', attempts = 1, conversation_id = 'conv_stop' WHERE id = ?", call.id);
    await finishWebinarCall(rt, calls().find((c) => c.id === call.id)!, (await getLead(rt.env, lead))!, {
      conversation_id: 'conv_stop', status: 'done', transcript: [{ role: 'agent', message: 'Hi' }, { role: 'user', message: 'Stop calling me' }],
      analysis: { data_collection_results: { reached_person: { value: true }, do_not_call: { value: true } } },
    });
    const l = (await getLead(rt.env, lead))!;
    expect(l.do_not_call_at).toBeTruthy();
    expect(l.unsubscribed_at).toBeTruthy();
    expect(q('SELECT status FROM emails WHERE id = ?', 'm1')[0]).toEqual({ status: 'cancelled' });
    expect(calls().find((c) => c.id === 'oc_other')!.status).toBe('cancelled');
    // And nothing new is ever planned for them.
    seedReg(seedSession(T0 + 3 * DAY), lead, { created: T0 + MIN });
    await plan(T0 + 5 * MIN);
    expect(calls().filter((c) => c.status === 'queued')).toHaveLength(0);
  });

  it('an email unsubscribe or a STOP text also blocks calls', async () => {
    seedReg(seedSession(T0 + 2 * DAY), seedLead({ unsub: true }), { created: T0 - MIN });
    await plan();
    expect(calls()).toHaveLength(0);
  });
});

// ───────────── consent, caps and hours ─────────────

describe('consent, caps and calling hours', () => {
  it('no consent (or no phone) means no call', async () => {
    const s = seedSession(T0 + 2 * DAY);
    seedReg(s, seedLead({ consent: false }), { created: T0 - MIN });
    seedReg(s, seedLead({ phone: null }), { created: T0 - MIN });
    await plan();
    expect(calls()).toHaveLength(0);
  });

  it('nothing is planned until the webinar call agent exists, or with a flow switched off', async () => {
    seedReg(seedSession(T0 + 2 * DAY), seedLead(), { created: T0 - MIN });
    rt = makeRt({ ...SETTINGS, ELEVENLABS_WEBINAR_AGENT_ID: '' });
    await plan();
    expect(calls()).toHaveLength(0);
    rt = makeRt({ ...SETTINGS, AI_CALL_W_PRE: 'false' });
    await plan();
    expect(calls()).toHaveLength(0);
  });

  it('quiet hours: a welcome at 11pm Sydney waits for calling hours; a "starting now" call is dropped', async () => {
    const night = Date.parse('2026-11-03T12:00:00Z'); // 23:00 Sydney, 20:00 Perth
    vi.setSystemTime(night);
    seedReg(seedSession(night + 3 * DAY), seedLead(), { created: night - MIN });
    seedReg(seedSession(night + 15 * MIN), seedLead(), { created: night - DAY });
    await plan(night);
    const c = calls();
    expect(c.map((r) => r.kind)).toEqual(['w_pre_welcome']);
    expect(c[0].run_at).toBe(Date.parse('2026-11-04T01:00:00Z')); // 9am in Perth = 12pm in Sydney
  });

  it('never more than 2 calls a person a day, and the weekly cap across flows', async () => {
    const lead = seedLead();
    const s = seedSession(T0 + 2 * DAY);
    seedReg(s, lead, { created: T0 - MIN });
    await plan();
    for (const [i, t] of [[1, T0 - 5 * HOUR], [2, T0 - 2 * HOUR]] as const)
      x(`INSERT INTO outbound_calls (id, lead_id, kind, status, run_at, attempts, conversation_id, created_at, updated_at, wc_dialed_at) VALUES (?, ?, 'confirm', 'done', ?, 1, ?, ?, ?, ?)`, `old${i}`, lead, t, `c${i}`, t, t, t);
    const call = calls().find((c) => c.kind === 'w_pre_welcome')!;
    x("UPDATE outbound_calls SET status = 'dialing', attempts = 1 WHERE id = ?", call.id);
    const l = (await getLead(rt.env, lead))!;
    expect(await webinarPreDial(rt, calls().find((c) => c.id === call.id)!, l, T0 + 3 * MIN)).toBeNull();
    const moved = calls().find((c) => c.id === call.id)!;
    expect(moved.status).toBe('queued');
    expect(moved.run_at).toBeGreaterThanOrEqual(T0 - 5 * HOUR + DAY);
    // Weekly: 4 dials in the last week (none today) → skipped.
    x("DELETE FROM outbound_calls WHERE id LIKE 'old%'");
    for (let i = 0; i < 4; i++) { const t = T0 - (2 + i) * DAY; x(`INSERT INTO outbound_calls (id, lead_id, kind, status, run_at, attempts, conversation_id, created_at, updated_at, wc_dialed_at) VALUES (?, ?, 'w_pre_day', 'done', ?, 1, ?, ?, ?, ?)`, `wk${i}`, lead, t, `w${i}`, t, t, t); }
    x("UPDATE outbound_calls SET status = 'dialing', attempts = 1, run_at = ? WHERE id = ?", T0, call.id);
    expect(await webinarPreDial(rt, calls().find((c) => c.id === call.id)!, l, T0 + 3 * MIN)).toBeNull();
    expect(calls().find((c) => c.id === call.id)).toMatchObject({ status: 'skipped', error: 'weekly limit of 4 calls reached' });
  });

  it('the global daily cap is respected', async () => {
    rt = makeRt({ ...SETTINGS, AI_CALL_DAILY_CAP: '1' });
    const s = seedSession(T0 + 2 * DAY);
    seedReg(s, seedLead(), { created: T0 - MIN });
    seedReg(s, seedLead(), { created: T0 - MIN });
    await plan();
    expect(calls()).toHaveLength(1);
  });

  it('a call never lands in the same minutes as a pending email', async () => {
    const lead = seedLead();
    seedReg(seedSession(T0 + 2 * DAY), lead, { created: T0 - 2 * MIN });
    x(`INSERT INTO emails (id, lead_id, sequence, step, template, to_email, send_at, status, created_at) VALUES ('m2', ?, 'webinar', 2, 'w_2', 'a@b.c', ?, 'pending', ?)`, lead, T0 + 4 * MIN, T0);
    await plan();
    expect(calls()[0].run_at).toBe(T0 + 16 * MIN);
  });

  it('records consent from the registration box, only for the number on the lead', async () => {
    const a = seedLead({ consent: false, phone: null });
    expect(await recordCallConsent(rt, a, '+61412000111', { call_consent: 'on' })).toBe(true);
    expect((await getLead(rt.env, a))).toMatchObject({ phone: '+61412000111', call_consent_text: 'webinar-v1' });
    const b = seedLead({ consent: false, phone: '+61412000222' });
    expect(await recordCallConsent(rt, b, '+61499999999', { call_consent: true })).toBe(false); // someone else's number
    expect(await recordCallConsent(rt, b, '+61412000222', {})).toBe(false); // box not ticked
    expect((await getLead(rt.env, b))!.call_consent_at).toBeNull();
  });

  it('the webinar, live and challenge forms carry the unticked box with the same wording', () => {
    const html = fs.readFileSync(`${node.cwd()}/public/webinar.html`, 'utf8');
    expect(html).toContain('<input type="checkbox" name="call_consent">');
    expect(html).toContain(WEBINAR_CALL_CONSENT.text);
    expect(fs.readFileSync(`${node.cwd()}/src/live/pages.ts`, 'utf8')).toContain('name="call_consent"><span>${esc(WEBINAR_CALL_CONSENT.text)}');
    expect(fs.readFileSync(`${node.cwd()}/src/challenge/pages.ts`, 'utf8')).toContain('name="call_consent"> <span>${esc(WEBINAR_CALL_CONSENT.text)}');
    expect(fs.readFileSync(`${node.cwd()}/public/assets/webinar.js`, 'utf8')).toContain('call_consent: Boolean(reg.call_consent && reg.call_consent.checked)');
  });
});

// ───────────── what the agent says ─────────────

describe('the agent and its facts', () => {
  it('says it is an AI assistant for Josh’s team first, and never a cloned Josh', () => {
    expect(W_FIRST_MESSAGE).toMatch(/^Hi \{\{first_name\}\}, it’s Sam, an AI assistant calling for Josh Li’s team/);
    expect(W_FIRST_MESSAGE).toContain('this call is recorded, and you can say stop');
    expect(W_FIRST_MESSAGE).toContain('{{callback_number}}');
    const p = webinarAgentPrompt();
    expect(p).toMatch(/You are not Josh and not a human/);
    expect(p).toMatch(/information, not instructions/);
    expect(p).toMatch(/Never read out a full web address, a Zoom link/);
    expect(p).toMatch(/Never offer, pitch or mention a discount on anything listed under "Already bought"/);
    const a = buildWebinarAgent({ ELEVENLABS_LLM: '' });
    expect(Object.keys(a.platform_settings.data_collection)).toEqual(expect.arrayContaining(['do_not_call', 'not_interested', 'wants_link']));
  });

  it('voicemail on the first attempt only, with the callback number', async () => {
    const lead = seedLead();
    const reg = seedReg(seedSession(T0 + 2 * DAY), lead);
    const { ctx } = await ctxForRef(rt, `auto:${reg}`);
    const l = (await getLead(rt.env, lead))!;
    const v1 = await callVariables(rt, 'w_pre_welcome', l, ctx, null, {}, 1, T0);
    expect(v1.voicemail_rule).toContain('leave ONE short message');
    expect(v1.voicemail_rule).toContain('+61 2 9000 0000');
    expect((await callVariables(rt, 'w_pre_welcome', l, ctx, null, {}, 2, T0)).voicemail_rule).toContain('without leaving a message');
  });

  it('offer facts come from settings: the guarantee word for word, the 7-day money-back and the real close time', async () => {
    const lead = seedLead();
    x(`INSERT INTO live_webinars (id, title, starts_at, tz, duration_min, status, offer_opened_at, offer_hours, created_at, updated_at) VALUES ('ev2', 'Live', ?, 'UTC', 120, 'scheduled', ?, 48, ?, ?)`, T0 - 4 * HOUR, T0 - 3 * HOUR, T0, T0);
    x(`INSERT INTO live_webinar_regs (id, token, event_id, lead_id, joined_at, created_at) VALUES ('lr2', 'ltok2', 'ev2', ?, ?, ?)`, lead, T0 - 4 * HOUR, T0 - DAY);
    const { ctx } = await ctxForRef(rt, 'live:lr2');
    const v = await callVariables(rt, 'w_post_nobuy', (await getLead(rt.env, lead))!, ctx, null, {}, 1, T0);
    expect(v.offer_facts).toContain(GUARANTEE_BODY);
    expect(v.offer_facts).toContain(MONEY_BACK_BODY);
    expect(v.offer_facts).toContain('$5,000');
    expect(v.close_time).toMatch(/Thursday/); // event end (T0 - 2h) + 48h, in Sydney time
    expect(v.script).toContain(`The offer closes at ${v.close_time}`);
    expect(v.script).not.toMatch(/\{\{/);
  });

  it('buyers are never pitched what they bought; a VIP buyer hears the deposit only while it is really open', async () => {
    const lead = seedLead();
    const reg = seedReg(seedSession(T0 - 4 * HOUR), lead, { joined: T0 - 4 * HOUR });
    const pass = seedPass(lead, reg);
    const r = await ctxForRef(rt, `pass:${pass}`);
    const v = await callVariables(rt, 'w_post_bought', (await getLead(rt.env, lead))!, r.ctx, r.purchase, {}, 1, T0);
    expect(v.already_bought).toBe('First Deal Sprint');
    expect(v.script).toContain('Do not mention any other offer.');

    const lead2 = seedLead();
    x(`INSERT INTO challenge_cohorts (id, name, start_date, start_time, timezone, created_at, updated_at) VALUES ('co2', 'Oct', '2026-10-27', '19:00', 'UTC', ?, ?)`, T0, T0);
    for (let d = 1; d <= 5; d++) x('INSERT INTO challenge_days (cohort_id, day, starts_at, duration_min, updated_at) VALUES (?, ?, ?, 90, ?)', 'co2', d, T0 - (6 - d) * DAY + HOUR, T0);
    x(`INSERT INTO challenge_registrations (id, token, cohort_id, lead_id, status, vip, created_at, paid_at) VALUES ('cr2', 'ctok2', 'co2', ?, 'paid', 1, ?, ?)`, lead2, T0 - 7 * DAY, T0 - 7 * DAY);
    x(`INSERT INTO challenge_orders (id, reg_id, lead_id, kind, status, amount, currency, paid_at, created_at, updated_at, whop_payment_method_id) VALUES ('vo1', 'cr2', ?, 'vip', 'paid', 30000, 'usd', ?, ?, ?, 'pm_1')`, lead2, T0 - HOUR, T0, T0);
    x(`INSERT INTO challenge_offer_state (event_key, open_at, updated_at) VALUES ('challenge:co2:5', ?, ?)`, T0 - 2 * HOUR, T0);
    const r2 = await ctxForRef(rt, 'vip:vo1');
    const v2 = await callVariables(rt, 'w_post_bought', (await getLead(rt.env, lead2))!, r2.ctx, r2.purchase, {}, 1, T0);
    expect(v2.script).toContain('engagement deposit offer from the challenge is open until');
    expect(v2.script).toContain('one click on the card saved with their ticket');
    seedPass(lead2, 'cr2', 'deposit', T0 - 10 * MIN);
    const r3 = await ctxForRef(rt, 'vip:vo1');
    const v3 = await callVariables(rt, 'w_post_bought', (await getLead(rt.env, lead2))!, r3.ctx, r3.purchase, {}, 1, T0);
    expect(v3.script).toContain('Do not mention any other offer.');
    expect(v3.already_bought).toContain('advisory engagement');
  });
});

// ───────────── copy ─────────────

describe('copy audit', () => {
  it('every default script, opening, the consent box and the link email pass the house rules', () => {
    for (const k of W_KINDS) {
      expect(scriptIssues(DEFAULT_STEPS[k].script), k).toEqual([]);
      expect(auditCopy(STEP_META[k].opening), k).toEqual([]);
      expect(STEP_META[k].opening + DEFAULT_STEPS[k].script).not.toMatch(/—|!/);
    }
    expect(auditCopy(WEBINAR_CALL_CONSENT.text)).toEqual([]);
    expect(auditCopy(W_FIRST_MESSAGE)).toEqual([]);
    const m = linkMail('Dana', { url: 'https://x', label: 'Join the session' });
    expect(auditEmail({ subject: m.subject, preheader: m.preheader, body: m.paras })).toEqual([]);
    expect(webinarAgentPrompt()).not.toMatch(/—/);
  });

  it('refuses to save a script with fake scarcity, a human claim or a raw link', async () => {
    const bad = await saveConfig(rt, { steps: { w_post_nobuy: { script: 'Hi, this is Josh. Only 2 spots left, last chance! Go to https://zoom.us/j/1', attempts: 3, spacingMin: 1200 } } });
    expect(bad.ok).toBe(false);
    const issues = !bad.ok ? bad.issues[0].issues.join(' | ') : '';
    expect(issues).toMatch(/fake scarcity/);
    expect(issues).toMatch(/never claims to be Josh/);
    expect(issues).toMatch(/no web addresses/);
    const good = await saveConfig(rt, { steps: { w_left: { script: 'Ask how the session was going, offer the link, and end the call politely.', attempts: 9, spacingMin: 1 } } });
    expect(good.ok && good.config.steps.w_left).toEqual({ script: 'Ask how the session was going, offer the link, and end the call politely.', attempts: 3, spacingMin: 5 });
  });
});

// ───────────── the shared dialler and results ─────────────

describe('dialling through the shared queue', () => {
  it('dials with the webinar agent, records the dial time, and texts/emails the link when asked', async () => {
    const lead = seedLead();
    const s = seedSession(T0 - 90 * MIN - 2 * HOUR);
    seedReg(s, lead);
    await plan();
    const sent: { url: string; body: Record<string, unknown> | null }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body?: string } = {}) => {
      sent.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
      if (String(url).endsWith('/v1/convai/phone-numbers')) return new Response(JSON.stringify([{ phone_number_id: 'ph_1', provider: 'twilio', phone_number: '+1', label: null }]));
      return new Response(JSON.stringify({ success: true, message: 'ok', conversation_id: 'conv_w1', callSid: 'CA1' }));
    }));
    const t = calls()[0].run_at;
    vi.setSystemTime(t);
    expect((await processCallQueue(rt)).dialed).toBe(1);
    const out = sent.find((r) => r.url.includes('outbound-call'))!.body as { agent_id: string; conversation_initiation_client_data: { dynamic_variables: Record<string, string> } };
    expect(out.agent_id).toBe('agent_web');
    expect(out.conversation_initiation_client_data.dynamic_variables.flow_label).toBe('Missed it, replay call');
    expect(out.conversation_initiation_client_data.dynamic_variables.script).toContain('replay link');
    expect(calls()[0].wc_dialed_at).toBe(t);
    await handleElevenWebhook(rt, { type: 'post_call_transcription', data: {
      conversation_id: 'conv_w1', transcript: [{ role: 'agent', message: 'Hi' }, { role: 'user', message: 'Yes please send it' }],
      analysis: { data_collection_results: { reached_person: { value: true }, wants_link: { value: true } }, transcript_summary: 'Wants the replay.' },
    } });
    expect(calls()[0].status).toBe('done');
    expect(q("SELECT template, status FROM emails WHERE sequence = 'wcall'")).toEqual([{ template: 'wcall_link', status: 'simulated' }]);
    expect(q("SELECT kind FROM voice_calls")).toEqual([{ kind: 'ai_w_post_missed' }]);
  });

  it('a voicemail is retried with spacing, and the report counts it', async () => {
    const lead = seedLead();
    const s = seedSession(T0 - 90 * MIN - 2 * HOUR);
    seedReg(s, lead, { joined: T0 - 3.4 * HOUR, unlocked: T0 - 2.5 * HOUR });
    await plan();
    const c = calls()[0];
    x("UPDATE outbound_calls SET status = 'dialing', attempts = 1, conversation_id = 'conv_vm', wc_dialed_at = ? WHERE id = ?", T0, c.id);
    await finishWebinarCall(rt, calls()[0], (await getLead(rt.env, lead))!, { conversation_id: 'conv_vm', status: 'done', analysis: { data_collection_results: { reached_voicemail: { value: true } } } });
    const rows = calls();
    expect(rows.find((r) => r.id === c.id)).toMatchObject({ status: 'no_answer', error: 'voicemail' });
    const retry = rows.find((r) => r.id !== c.id)!;
    expect(retry).toMatchObject({ kind: 'w_post_nobuy', status: 'queued', attempts: 1, wc_ref: c.wc_ref });
    expect(retry.run_at).toBeGreaterThanOrEqual(T0 + 20 * HOUR);
    const rep = await webinarCallsReport(rt, { from: T0 - DAY, to: T0 + DAY });
    const step = rep.flows.find((f) => f.id === 'nobuy')!.steps.find((x) => x.kind === 'w_post_nobuy')!;
    expect(step.outcomes).toMatchObject({ voicemail: 1, queued: 1 });
  });
});

// Keep the type import used.
export type _L = Lead;
