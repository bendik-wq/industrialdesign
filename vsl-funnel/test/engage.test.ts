import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv, Runtime } from '../src/app';
import { auditCopy, auditEmail, auditFields } from '../src/content/copy-rules';
import { type Identity, type RoomState, apply, join, newEngage, newRoomState, onTimeAwards, tickMinutes, view } from '../src/rooms/state';
import {
  ASSETS, DEFAULT_AGENDA, DEFAULT_RULES, DEFAULT_UNLOCKS, ENGAGE_COPY, QUIZ_PRESETS, ROOM_QUESTION_TITLES, cleanPlan, cleanQuiz, coverage, earnedAt, leaderboard, money, nextUnlock,
  parseAgenda, parseRules, parseUnlocks, planSteps, summaryEmail,
} from '../src/rooms/engage';
import {
  assetUrl, attendeeEngage, awardPoints, checkAssetLink, checkPlanLink, engageAvail, engageConfig, engageReport, getPlan, grantUnlocks, leadEngagement, personTimeline, planUrl, pushStats,
  recordPushEvent, roomQuestions, savePlan, savePush, sendRoomSummaries, sprintCard, startRoomSprint, submitRoomApplication, thresholdUnlocks,
} from '../src/rooms/engage-db';
import { createRoom, ensureRoomFor, getRoom, makeTicket } from '../src/rooms/rooms';
import { JOINS_PER_IP_HOUR, JOIN_COPY, admissionOf, checkJoin, cohostTtl, cohostUrl, joinRoom, joinSheet, joinUrl, saveAdmission, trackedJoin } from '../src/rooms/admission';
import { publicRoomPage, roomsApi } from '../src/rooms/routes';
import { saveEvent } from '../src/live/events';
import { scoreApplication } from '../src/funnel/scoring';
import { STAGES } from '../src/attribution/stages';
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
const SETTINGS: Record<string, string> = {
  SALES_TIMEZONE: 'America/New_York', SITE_NAME: 'G&L', WHOP_API_KEY: 'apik_test', WHOP_COMPANY_ID: 'biz_test', WEBINAR_PASS: 'upsell', WEBINAR_PASS_PRICE: '3000',
};
let db: DatabaseSync;
let rt: Runtime;
const pending: Promise<unknown>[] = [];
const ALL = () => Object.fromEntries(SETTING_DEFS.map((d) => [d.key, ''])) as Record<string, string>;
const makeRt = (s: Record<string, string> = SETTINGS) => ({ env: { DB: d1(db), SESSION_SECRET: 'test-session-secret' }, settings: { ...ALL(), ...s }, reps: [], origin: 'https://apply.test', waitUntil: (p: Promise<unknown>) => { pending.push(p.catch(() => null)); } }) as unknown as Runtime;
const flush = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
const q = <T = Record<string, unknown>>(sql: string, ...a: unknown[]) => db.prepare(sql).all(...(a as (string | number | null)[])) as T[];
const x = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...(a.map((v) => (v === undefined ? null : v)) as (string | number | null)[]));

interface Call { method: string; path: string; body: Record<string, unknown> | null }
function stubFetch(o: { status?: string } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { method?: string; body?: string } = {}) => {
    const u = String(url);
    const path = u.replace('https://api.whop.com/api/v1/', '');
    calls.push({ method: init.method ?? 'GET', path, body: init.body && init.body.startsWith('{') ? JSON.parse(init.body) : null });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (!u.startsWith('https://api.whop.com/')) return json(200, { ok: true });
    if (path === 'payments' && init.method === 'POST') return json(201, { id: 'pay_sp1', status: 'open' });
    if (/^payments\/[^/]+\/status$/.test(path)) return json(200, { status: o.status ?? 'succeeded', next_action: null, last_payment_error: null });
    if (path.startsWith('payments/')) return json(200, {});
    return json(404, { error: { message: 'not stubbed' } });
  }));
  return calls;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  db = freshDb();
  rt = makeRt();
  stubFetch();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); pending.length = 0; });

const host: Identity = { id: 'hadmin', name: 'Josh', role: 'host' };
const ann: Identity = { id: 'rann', name: 'Ann B.', role: 'attendee', leadId: 'l1', regId: 'r1' };
const bob: Identity = { id: 'rbob', name: 'Bob C.', role: 'attendee', leadId: 'l2', regId: 'r2' };
const AVAIL = { application: true, sprint: true, deposit: true, vip: false, resources: ['calculator', 'scripts'] };
function webinar(live = true) {
  const st = newRoomState({ id: 'rmtest12345', mode: 'webinar', title: 'Live', startsAt: T0, offerAvailable: true });
  st.eng = newEngage({ avail: { ...AVAIL } });
  for (const w of [host, ann, bob]) join(st, w, T0);
  if (live) { st.status = 'live'; st.wentLiveAt = T0; }
  return st;
}
const ok = (st: RoomState, who: string, msg: Record<string, unknown>) => { const r = apply(st, who, msg, T0); expect(r.error ?? null).toBeNull(); return r; };
const no = (st: RoomState, who: string, msg: Record<string, unknown>, err: string) => { const r = apply(st, who, msg, T0); expect(r.ok).toBe(false); expect(r.error).toBe(err); return r; };
const eng = (st: RoomState, who: string) => view(st, st.members[who], T0).eng!;

function seedLead(id: string, o: { band?: string; email?: string; unsub?: boolean } = {}) {
  x(`INSERT INTO leads (id, ref_code, created_at, updated_at, visitor_id, first_name, last_name, email, status, revenue_band, unsubscribed_at, country)
     VALUES (?, ?, ?, ?, ?, 'Dana', 'Lee', ?, 'partial', ?, ?, 'US')`, id, `R${id}`, T0 - DAY, T0 - DAY, `v${id}`, o.email ?? `${id}@example.com`, o.band ?? '3m-10m', o.unsub ? T0 - DAY : null);
}
async function liveRoom() {
  const s = await saveEvent(rt, { title: 'Buy your first competitor', starts_at: T0 - 20 * MIN, tz: 'UTC', duration_min: 120, platform: 'room' }) as { id: string };
  const room = (await ensureRoomFor(rt, 'live', s.id, { title: 'Buy your first competitor', startsAt: T0 - 20 * MIN, durationMin: 120 }))!;
  return { room, eventId: s.id };
}
function seedReg(eventId: string, regId: string, leadId: string, who: string, name = 'Dana L.') {
  x(`INSERT INTO live_webinar_regs (id, token, event_id, lead_id, revenue_band, created_at) VALUES (?, ?, ?, ?, '3m-10m', ?)`, regId, `tok${regId}aaaaaaaaaaaaaaa`, eventId, leadId, T0 - DAY);
  x(`INSERT INTO room_attendance (room_id, who, lead_id, reg_id, name, role, first_at, last_at, minutes, joins) SELECT id, ?, ?, ?, ?, 'attendee', ?, ?, 30, 1 FROM rooms WHERE ref_id = ?`, who, leadId, regId, name, T0 - 15 * MIN, T0, eventId);
  return { id: who, name, leadId, regId };
}
const APP_ANSWERS = { business: 'Commercial HVAC services, 25 staff', role: 'owner', revenue: '3_10m', profit: '250k_1m', goal: 'acquire', timeline: '0_6', blockers: ['funding'], readiness: 'yes', why_now: 'We have plateaued at $4M and I want to buy the competitor across town before someone else does.' };

// ───────────── the rules (pure) ─────────────

describe('Deal momentum rules', () => {
  it('parses overrides, ignores unknown actions and silly values, and caps every action', () => {
    expect(parseRules('')).toEqual(DEFAULT_RULES);
    const r = parseRules('question:7x2, poll:0, bogus:9, chapter:abc');
    expect(r.question).toMatchObject({ points: 7, cap: 2 });
    expect(r.poll.points).toBe(0);
    expect(r.chapter).toEqual(DEFAULT_RULES.chapter);
    for (const k of Object.keys(DEFAULT_RULES) as (keyof typeof DEFAULT_RULES)[]) expect(DEFAULT_RULES[k].cap).toBeGreaterThan(0);
  });
  it('unlock thresholds: configurable, only known files, the end reward never by points', () => {
    expect(parseUnlocks('')).toEqual(DEFAULT_UNLOCKS);
    expect(parseUnlocks('off')).toEqual([]);
    const u = parseUnlocks('scripts:10, nothing:5, checklist:end, scripts:99');
    expect(u).toEqual([{ asset: 'scripts', at: 10 }, { asset: 'checklist', at: 'end' }]);
    expect(earnedAt(DEFAULT_UNLOCKS, 24)).toEqual([]);
    expect(earnedAt(DEFAULT_UNLOCKS, 25)).toEqual(['calculator']);
    expect(earnedAt(DEFAULT_UNLOCKS, 1000)).not.toContain('checklist');
    expect(nextUnlock(DEFAULT_UNLOCKS, 30)).toMatchObject({ asset: 'scripts', at: 60 });
    expect(nextUnlock(DEFAULT_UNLOCKS, 100)).toBeNull();
  });
  it('the agenda: "Title | teaser" per line, default when blank', () => {
    expect(parseAgenda('')).toEqual(DEFAULT_AGENDA);
    expect(parseAgenda('Open | Why we are here\n\nThe test')).toEqual([{ title: 'Open', teaser: 'Why we are here' }, { title: 'The test', teaser: '' }]);
  });
  it('the Deal Plan: steps count only when really filled in, and the 1.5x test is right', () => {
    expect(money('$650k')).toBe(650_000);
    expect(money('1.2m')).toBe(1_200_000);
    expect(money('abc')).toBeNull();
    const p = cleanPlan({ industry: 'HVAC', size: '$2M to $5M', geography: 'Dallas', owners_per_week: '25 a week', cash_flow: '$900k', debt_service: '$550k', action_1: 'Write my buy box', action_2: 'List 50 owners', action_3: '', extra: '<script>' });
    expect(p.owners_per_week).toBe('25');
    expect(planSteps(p)).toEqual(['buybox', 'outreach', 'coverage']);
    expect(coverage(p)).toEqual({ ratio: 1.64, passes: true, maxDebtService: 600_000 });
    expect(coverage({ cash_flow: '600k', debt_service: '500k' })).toMatchObject({ ratio: 1.2, passes: false });
    expect(planSteps(cleanPlan({ industry: 'x', size: 'y', geography: 'z' }))).toEqual([]);
  });
  it('knowledge checks need a question, two answers and a valid right answer', () => {
    expect(cleanQuiz({ question: 'Q?', options: ['a'], correct: 0 })).toBeNull();
    expect(cleanQuiz({ question: 'Q?', options: ['a', 'b'], correct: 2 })).toBeNull();
    expect(cleanQuiz({ question: 'Q?', options: ['a', 'b', ''], correct: 1, explain: 'Because' })).toEqual({ question: 'Q?', options: ['a', 'b'], correct: 1, explain: 'Because' });
    for (const p of QUIZ_PRESETS) expect(cleanQuiz(p)).not.toBeNull();
  });
  it('the leaderboard: opted-in people only, first names only, never an email', () => {
    const top = leaderboard({ a: 40, b: 90, c: 10 }, { a: 'Ann B.', b: 'bob@example.com', c: 'Cara Smith' }, ['a', 'c']);
    expect(top).toEqual([{ id: 'a', name: 'Ann', points: 40 }, { id: 'c', name: 'Cara', points: 10 }]);
    expect(JSON.stringify(leaderboard({ b: 90 }, { b: 'bob@example.com' }, ['b']))).not.toContain('@');
  });
});

// ───────────── the room's state machine ─────────────

describe('pushes', () => {
  it('only staff push; everyone or selected people; the card reaches only its targets', () => {
    const st = webinar();
    no(st, 'rann', { t: 'push', kind: 'application' }, 'forbidden');
    const r = ok(st, 'hadmin', { t: 'push', kind: 'application' });
    expect(r.effects[0]).toMatchObject({ type: 'pushed', push: { id: 1, kind: 'application', to: null } });
    expect(eng(st, 'rann').pushes).toEqual([{ id: 1, kind: 'application', ref: null, at: T0 }]);
    ok(st, 'hadmin', { t: 'push', kind: 'sprint', to: ['rann', 'hadmin', 'nobody'] });
    expect(eng(st, 'rann').pushes.map((p) => p.kind)).toEqual(['application', 'sprint']);
    expect(eng(st, 'rbob').pushes.map((p) => p.kind)).toEqual(['application']);
    expect(eng(st, 'hadmin').pushes).toContainEqual(expect.objectContaining({ kind: 'sprint', to: 1 })); // staff see the count, not who
    no(st, 'hadmin', { t: 'push', kind: 'sprint', to: ['hadmin'] }, 'push_targets');
  });
  it('a new push of the same thing replaces the old card; staff take a card down', () => {
    const st = webinar();
    ok(st, 'hadmin', { t: 'push', kind: 'application' });
    ok(st, 'hadmin', { t: 'push', kind: 'application' });
    expect(eng(st, 'rann').pushes.map((p) => p.id)).toEqual([2]);
    no(st, 'rann', { t: 'push_close', pid: 2 }, 'forbidden');
    ok(st, 'hadmin', { t: 'push_close', pid: 2 });
    expect(eng(st, 'rann').pushes).toEqual([]);
  });
  it('the deposit card follows the real offer; VIP only where it exists; resources must be known', () => {
    const st = webinar();
    no(st, 'hadmin', { t: 'push', kind: 'deposit' }, 'offer_closed');
    st.offer.open = true;
    ok(st, 'hadmin', { t: 'push', kind: 'deposit' });
    no(st, 'hadmin', { t: 'push', kind: 'vip' }, 'push_kind');
    no(st, 'hadmin', { t: 'push', kind: 'resource', ref: 'buybox' }, 'push_kind');
    ok(st, 'hadmin', { t: 'push', kind: 'resource', ref: 'scripts' });
    no(st, 'hadmin', { t: 'push', kind: 'nonsense' }, 'push_kind');
  });
  it('push events: only from the people the card is for, and only the client-side ones', () => {
    const st = webinar();
    ok(st, 'hadmin', { t: 'push', kind: 'sprint', to: ['rann'] });
    no(st, 'rbob', { t: 'push_ev', pid: 1, ev: 'opened' }, 'not_targeted');
    expect(ok(st, 'rann', { t: 'push_ev', pid: 1, ev: 'opened' }).effects).toEqual([{ type: 'push_ev', memberId: 'rann', pushId: 1, ev: 'opened' }]);
    no(st, 'rann', { t: 'push_ev', pid: 1, ev: 'paid' }, 'bad_value'); // paid and submitted only come from the server
  });
  it('meetings have no engagement', () => {
    const st = newRoomState({ id: 'rmmeet12345', mode: 'meeting', title: 'Kickoff', startsAt: null });
    join(st, host, T0);
    no(st, 'hadmin', { t: 'push', kind: 'application' }, 'not_applicable');
    expect(view(st, st.members.hadmin, T0).eng).toBeUndefined();
  });
});

describe('points from real actions (state side)', () => {
  it('chat earns nothing; short questions earn nothing; a poll answer counts once', () => {
    const st = webinar();
    expect(ok(st, 'rann', { t: 'chat', text: 'hi' }).effects).toEqual([]);
    expect(ok(st, 'rann', { t: 'ask', text: 'how?' }).effects).toEqual([]);
    expect(ok(st, 'rann', { t: 'ask', text: 'How do I find owners with no successor?' }).effects).toEqual([{ type: 'award', awards: [{ memberId: 'rann', action: 'question', key: '2' }] }]);
    ok(st, 'hadmin', { t: 'poll_new', question: 'Revenue?', options: ['<3M', '3M+'] });
    expect(ok(st, 'rann', { t: 'vote', pid: 1, choice: 0 }).effects).toEqual([{ type: 'award', awards: [{ memberId: 'rann', action: 'poll', key: '1' }] }]);
    no(st, 'rann', { t: 'vote', pid: 1, choice: 1 }, 'already_voted');
  });
  it('chapters: staff only, everyone in the room reaches it; minutes: one award per ten; on time; staying to the end', () => {
    const st = webinar();
    no(st, 'rann', { t: 'chapter', n: 0 }, 'forbidden');
    no(st, 'hadmin', { t: 'chapter', n: 99 }, 'bad_value');
    const r = ok(st, 'hadmin', { t: 'chapter', n: 0 });
    expect(r.effects).toEqual([{ type: 'award', awards: [{ memberId: 'rann', action: 'chapter', key: '0' }, { memberId: 'rbob', action: 'chapter', key: '0' }] }]);
    expect(eng(st, 'rann').agenda.chapter).toBe(0);
    let awards: unknown[] = [];
    for (let i = 0; i < 10; i++) awards = awards.concat(tickMinutes(st));
    expect(awards).toEqual([{ memberId: 'rann', action: 'present_10', key: '1' }, { memberId: 'rbob', action: 'present_10', key: '1' }]);
    expect(onTimeAwards(st).map((a) => a.memberId)).toEqual(['rann', 'rbob']);
    const end = ok(st, 'hadmin', { t: 'end' });
    expect(end.effects.map((e) => e.type)).toEqual(['award', 'end_unlocks', 'ended']);
    expect(end.effects[1]).toEqual({ type: 'end_unlocks', memberIds: ['rann', 'rbob'] });
  });
  it('ending a session that never went live rewards nobody', () => {
    const st = webinar(false);
    expect(ok(st, 'hadmin', { t: 'end' }).effects).toEqual([{ type: 'ended' }]);
  });
});

describe('knowledge checks', () => {
  it('host only; instant feedback with the explanation; one answer each; counts hidden from the audience while open', () => {
    const st = webinar();
    const p = QUIZ_PRESETS[0];
    no(st, 'rann', { t: 'quiz_new', ...p }, 'forbidden');
    no(st, 'hadmin', { t: 'quiz_new', question: 'Q', options: ['a'] }, 'quiz_incomplete');
    ok(st, 'hadmin', { t: 'quiz_new', ...p });
    expect(eng(st, 'rann').quiz).toMatchObject({ id: 1, open: true, mine: null, right: null, explain: null, counts: null });
    const r = ok(st, 'rann', { t: 'quiz_answer', qid: 1, choice: p.correct });
    expect(r.out).toEqual([{ to: 'rann', msg: { t: 'quiz_result', qid: 1, choice: p.correct, correct: true, right: p.correct, explain: p.explain } }]);
    expect(r.effects).toEqual([
      { type: 'quiz_answer', memberId: 'rann', quizId: 1, choice: p.correct, correct: true, question: p.question },
      { type: 'award', awards: [{ memberId: 'rann', action: 'quiz', key: '1' }, { memberId: 'rann', action: 'quiz_correct', key: '1' }] },
    ]);
    no(st, 'rann', { t: 'quiz_answer', qid: 1, choice: 0 }, 'already_answered');
    const wrong = ok(st, 'rbob', { t: 'quiz_answer', qid: 1, choice: 1 - p.correct });
    expect((wrong.effects[1] as { awards: unknown[] }).awards).toEqual([{ memberId: 'rbob', action: 'quiz', key: '1' }]);
    expect(eng(st, 'rann').quiz).toMatchObject({ mine: p.correct, right: p.correct, counts: null });
    expect(eng(st, 'hadmin').quiz).toMatchObject({ total: 2, counts: [1, 1] });
    no(st, 'hadmin', { t: 'quiz_answer', qid: 1, choice: 0 }, 'not_applicable');
    ok(st, 'hadmin', { t: 'quiz_close', qid: 1 });
    expect(eng(st, 'rann').quiz).toMatchObject({ open: false, counts: [1, 1] });
    no(st, 'rbob', { t: 'quiz_answer', qid: 1, choice: 0 }, 'quiz_closed');
  });
});

describe('the leaderboard', () => {
  it('off by default; the host shows it; only people who opt in appear', () => {
    const st = webinar();
    st.eng!.pts = { rann: 40, rbob: 70 };
    expect(eng(st, 'rann').board).toEqual({ on: false, optedIn: false, top: [] });
    no(st, 'rann', { t: 'board', on: true }, 'forbidden');
    ok(st, 'hadmin', { t: 'board', on: true });
    expect(eng(st, 'rann').board.top).toEqual([]);
    ok(st, 'rann', { t: 'board_opt', on: true });
    expect(eng(st, 'rbob').board.top).toEqual([{ id: 'rann', name: 'Ann', points: 40 }]);
    no(st, 'hadmin', { t: 'board_opt', on: true }, 'not_applicable');
    ok(st, 'rann', { t: 'board_opt', on: false });
    expect(eng(st, 'rbob').board.top).toEqual([]);
  });
});

// ───────────── the database: caps, unlocks, push counts ─────────────

describe('points and unlocks in the database', () => {
  it('caps each action, de-duplicates by key, and can’t be farmed', async () => {
    const room = await createRoom(rt, { mode: 'webinar', title: 'W', refType: 'none' });
    const who = { id: 'rann', leadId: 'l1', regId: 'r1' };
    const rules = engageConfig(rt).rules;
    const first = await awardPoints(rt, room, [1, 2, 3, 4, 5].map((k) => ({ who, action: 'question' as const, key: String(k) })), rules);
    expect(first.map((a) => a.points)).toEqual([5, 5, 5]); // cap 3
    expect(await awardPoints(rt, room, [{ who, action: 'poll', key: '1' }, { who, action: 'poll', key: '1' }], rules)).toHaveLength(1);
    expect(await awardPoints(rt, room, [{ who, action: 'poll', key: '1' }], rules)).toEqual([]);
    const off = parseRules('poll:0');
    expect(await awardPoints(rt, room, [{ who, action: 'poll', key: '9' }], off)).toEqual([]);
    expect(q<{ n: number }>('SELECT SUM(points) AS n FROM room_points WHERE room_id = ?', room.id)[0].n).toBe(18);
  });
  it('unlocks are granted only when earned, and the signed link opens only for that person', async () => {
    const room = await createRoom(rt, { mode: 'webinar', title: 'W', refType: 'none' });
    const who = { id: 'rann', leadId: 'l1' };
    expect(thresholdUnlocks(DEFAULT_UNLOCKS, 20)).toEqual([]);
    const url = await assetUrl(rt, room.id, 'rann', 'calculator');
    const ref = url.split('/').pop()!;
    expect(await checkAssetLink(rt, room.id, 'rann', ref)).toBeNull(); // not earned yet
    expect(await grantUnlocks(rt, room, who, thresholdUnlocks(DEFAULT_UNLOCKS, 25), 'points')).toEqual(['calculator']);
    expect(await grantUnlocks(rt, room, who, ['calculator'], 'points')).toEqual([]); // once
    expect((await checkAssetLink(rt, room.id, 'rann', ref))?.id).toBe('calculator');
    expect(await checkAssetLink(rt, room.id, 'rbob', ref)).toBeNull(); // someone else's link
    expect(await checkAssetLink(rt, room.id, 'rann', ref.replace(/.$/, (c) => (c === '0' ? '1' : '0')))).toBeNull();
    expect(q('SELECT opened_at FROM room_unlocks WHERE who = ?', 'rann')[0]).toEqual({ opened_at: T0 });
  });
  it('push counts are real rows: each person once per event, submitted and paid from the server', async () => {
    const room = await createRoom(rt, { mode: 'webinar', title: 'W', refType: 'none' });
    await savePush(rt, room.id, { id: 1, kind: 'application', ref: null, to: null, at: T0, open: true, by: 'hadmin' }, 2);
    const a = { id: 'rann', leadId: 'l1' }, b = { id: 'rbob', leadId: 'l2' };
    for (const w of [a, b]) await recordPushEvent(rt, room, 1, w, 'shown', 'application');
    expect(await recordPushEvent(rt, room, 1, a, 'shown', 'application')).toBe(false);
    await recordPushEvent(rt, room, 1, a, 'opened', 'application');
    await recordPushEvent(rt, room, 1, a, 'submitted', 'application');
    const s = await pushStats(rt, room.id);
    expect(s.pushes[0]).toMatchObject({ id: 1, kind: 'application', targets: 2, open: true, counts: { shown: 2, opened: 1, started: 0, submitted: 1, paid: 0, dismissed: 0 } });
  });
});

// ───────────── the application inside the room ─────────────

describe('the application in the room', () => {
  it('goes through the same scoring: tier, score, lead, events; prefilled from the registration; tier stays with the team', async () => {
    const { room, eventId } = await liveRoom();
    seedLead('l1');
    const who = seedReg(eventId, 'lr1', 'l1', 'rlr1');
    const pre = await attendeeEngage(rt, room, who);
    expect(pre.app).toMatchObject({ name: 'Dana Lee', email: 'l1@example.com', submitted: false });
    expect(pre.app!.answers.revenue).toBe('3_10m'); // from the registration's revenue band
    const qs = await roomQuestions();
    expect(qs.find((x) => x.id === 'readiness')!.title).toBe(ROOM_QUESTION_TITLES.readiness.title);
    expect(JSON.stringify(qs)).not.toMatch(/on the call/i);
    await expect(submitRoomApplication(rt, room, who, { answers: APP_ANSWERS }, null)).rejects.toThrow(ENGAGE_COPY.errors.not_targeted); // no push yet
    await savePush(rt, room.id, { id: 1, kind: 'application', ref: null, to: null, at: T0, open: true, by: 'hadmin' }, 1);
    const r = await submitRoomApplication(rt, room, who, { answers: APP_ANSWERS }, null);
    await flush();
    const expected = scoreApplication(APP_ANSWERS as never, { country: 'US', email: 'l1@example.com', phone: null, blocklist: [] });
    expect(r).toMatchObject({ tier: expected.tier, score: expected.score });
    expect(q('SELECT tier, score, app_completed_at IS NOT NULL AS done, revenue_band FROM leads WHERE id = ?', 'l1')[0]).toEqual({ tier: expected.tier, score: expected.score, done: 1, revenue_band: '3m-10m' });
    expect(q("SELECT name FROM events WHERE lead_id = 'l1' AND name IN ('app_submitted', 'lead_qualified') ORDER BY name")).toEqual([{ name: 'app_submitted' }, { name: 'lead_qualified' }]);
    expect(q("SELECT event FROM room_push_events WHERE who = 'rlr1'")).toEqual([{ event: 'submitted' }]);
    expect(q("SELECT stage, funnel FROM attr_stages WHERE reg_id = 'lr1' AND stage LIKE 'room_%' ORDER BY stage")).toEqual([{ stage: 'room_application', funnel: 'live' }, { stage: 'room_push', funnel: 'live' }]);
    expect(q("SELECT name FROM attr_capi WHERE lead_id = 'l1'")).toEqual([{ name: 'attr_room_application' }]);
    // Default follow-ups: the same tier emails as /apply.
    expect(q<{ n: number }>("SELECT COUNT(*) AS n FROM emails WHERE lead_id = 'l1' AND sequence LIKE 'tier_%'")[0].n).toBeGreaterThan(0);
    expect((await attendeeEngage(rt, room, who)).app!.submitted).toBe(true);
  });
  it('ROOM_APP_FOLLOWUPS off: scored and tiered the same, without the booked-call follow-ups', async () => {
    rt = makeRt({ ...SETTINGS, ROOM_APP_FOLLOWUPS: 'off' });
    const { room, eventId } = await liveRoom();
    seedLead('l1');
    const who = seedReg(eventId, 'lr1', 'l1', 'rlr1');
    await savePush(rt, room.id, { id: 1, kind: 'application', ref: null, to: ['rlr1'], at: T0, open: true, by: 'hadmin' }, 1);
    const r = await submitRoomApplication(rt, room, who, { answers: APP_ANSWERS }, null);
    expect(r.tier).toBeTruthy();
    expect(q<{ n: number }>("SELECT COUNT(*) AS n FROM emails WHERE lead_id = 'l1' AND (sequence LIKE 'tier_%' OR sequence = 'nurture')")[0].n).toBe(0);
    expect(q<{ n: number }>("SELECT COUNT(*) AS n FROM outbound_calls WHERE lead_id = 'l1'")[0].n).toBe(0);
  });
  it('a missing answer points at its question; someone the card wasn’t for is refused', async () => {
    const { room, eventId } = await liveRoom();
    seedLead('l1'); seedLead('l2');
    const who = seedReg(eventId, 'lr1', 'l1', 'rlr1');
    const other = seedReg(eventId, 'lr2', 'l2', 'rlr2', 'Bob C.');
    await savePush(rt, room.id, { id: 1, kind: 'application', ref: null, to: ['rlr1'], at: T0, open: true, by: 'hadmin' }, 1);
    await expect(submitRoomApplication(rt, room, other, { answers: APP_ANSWERS }, null)).rejects.toThrow(ENGAGE_COPY.errors.not_targeted);
    const { why_now: _w, ...partial } = APP_ANSWERS;
    await expect(submitRoomApplication(rt, room, who, { answers: partial }, null)).rejects.toMatchObject({ field: 'why_now' });
  });
});

// ───────────── HTTP: the attendee never sees the tier; only staff read the counts ─────────────

describe('room HTTP calls', () => {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => { c.set('settings', { ...ALL(), ...SETTINGS } as never); await next(); });
  app.route('/api/rooms', roomsApi);
  const call = (path: string, body: Record<string, unknown>) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, { DB: d1(db), SESSION_SECRET: 'test-session-secret' } as never, { waitUntil: () => {}, passThroughOnException: () => {} } as never);
  it('application: the response says it arrived, never the tier; host counts need a staff ticket', async () => {
    const { room, eventId } = await liveRoom();
    seedLead('l1');
    const who = seedReg(eventId, 'lr1', 'l1', 'rlr1');
    await savePush(rt, room.id, { id: 1, kind: 'application', ref: null, to: null, at: T0, open: true, by: 'hadmin' }, 1);
    const t = await makeTicket(rt, room.id, { ...who, role: 'attendee' });
    const res = await call(`/api/rooms/${room.id}/app`, { t, answers: APP_ANSWERS });
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ ok: true, received: true });
    expect(JSON.stringify(body)).not.toMatch(/tier|score/);
    expect((await call(`/api/rooms/${room.id}/engage/stats`, { t })).status).toBe(403);
    const ht = await makeTicket(rt, room.id, { id: 'hadmin', name: 'Josh', role: 'host' });
    const stats = await (await call(`/api/rooms/${room.id}/engage/stats`, { t: ht })).json() as { applications: { tier: string }[] };
    expect(stats.applications[0].tier).toBeTruthy();
    expect((await call(`/api/rooms/${room.id}/app`, { t: ht, answers: APP_ANSWERS })).status).toBe(403); // hosts don't apply
    expect((await call(`/api/rooms/${room.id}/app`, { t: 'forged', answers: APP_ANSWERS })).status).toBe(403);
  });
  it('the Deal Plan saves per person, counts each step once, and comes back', async () => {
    const { room, eventId } = await liveRoom();
    seedLead('l1');
    const who = seedReg(eventId, 'lr1', 'l1', 'rlr1');
    const t = await makeTicket(rt, room.id, { ...who, role: 'attendee' });
    const data = { industry: 'HVAC', size: '$2M to $5M', geography: 'Dallas', cash_flow: '900k', debt_service: '550k' };
    const r = await (await call(`/api/rooms/${room.id}/plan`, { t, data })).json() as { steps: string[]; coverage: { passes: boolean } };
    expect(r.steps).toEqual(['buybox', 'coverage']);
    expect(r.coverage.passes).toBe(true);
    expect((await getPlan(rt, room.id, 'rlr1'))!.data.industry).toBe('HVAC');
    expect(q("SELECT stage FROM attr_stages WHERE reg_id = 'lr1' AND stage = 'room_plan_step'")).toHaveLength(2);
  });
});

// ───────────── the First Deal Sprint card ─────────────

describe('the Sprint payment card', () => {
  it('price and name come from the settings, less the masterclass ticket credit', async () => {
    seedLead('l1');
    expect(await sprintCard(rt, 'l1')).toMatchObject({ name: 'First Deal Sprint', todayLabel: '$3,000', available: true, qualified: true, paid: false, oneClick: null });
    rt = makeRt({ ...SETTINGS, WEBINAR_PASS_PRICE: '2500' });
    expect((await sprintCard(rt, 'l1')).todayLabel).toBe('$2,500');
    x("INSERT INTO webinar_passes (id, reg_id, lead_id, kind, status, amount, currency, paid_at, provider, whop_member_id, whop_payment_method_id, card_brand, card_last4, created_at, updated_at) VALUES ('wpseat1', 'r', 'l1', 'seat', 'paid', 10000, 'usd', 1, 'whop', 'mber_1', 'payt_1', 'visa', '4242', 1, 1)");
    expect(await sprintCard(rt, 'l1')).toMatchObject({ todayLabel: '$2,400', oneClick: { card: expect.stringContaining('4242') } });
    rt = makeRt({ ...SETTINGS, WEBINAR_PASS: 'off' });
    expect((await sprintCard(rt, 'l1')).available).toBe(false);
  });
  it('only for someone the card was pushed to; $1M+ only; the pay page without a saved card', async () => {
    const { room, eventId } = await liveRoom();
    seedLead('l1'); seedLead('l3', { band: '<1m' });
    const who = seedReg(eventId, 'lr1', 'l1', 'rlr1');
    const small = seedReg(eventId, 'lr3', 'l3', 'rlr3');
    const back = 'https://apply.test/rooms/x/done?k=sprint';
    expect(await startRoomSprint(rt, room, who, { returnUrl: back })).toEqual({ error: ENGAGE_COPY.errors.not_targeted });
    await savePush(rt, room.id, { id: 1, kind: 'sprint', ref: null, to: null, at: T0, open: true, by: 'hadmin' }, 2);
    expect(await startRoomSprint(rt, room, small, { returnUrl: back })).toEqual({ error: ENGAGE_COPY.sprintUnderMillion });
    const r = await startRoomSprint(rt, room, who, { oneClick: true, returnUrl: back });
    expect(r.url).toMatch(/^https:\/\/apply\.test\/pay\/wp[0-9a-z]+\.[0-9a-f]{24}$/);
    expect(q("SELECT kind, status, amount, source, ref_id, product FROM webinar_passes WHERE lead_id = 'l1'")).toEqual([{ kind: 'offer', status: 'pending', amount: 300000, source: 'room', ref_id: room.id, product: 'First Deal Sprint' }]);
    expect(q("SELECT event FROM room_push_events WHERE who = 'rlr1'")).toEqual([{ event: 'started' }]);
  });
  it('one click on the saved ticket card: paid, the push counts it, the Sprint delivery row and the Meta room purchase event', async () => {
    const { room, eventId } = await liveRoom();
    seedLead('l1');
    const who = seedReg(eventId, 'lr1', 'l1', 'rlr1');
    x("INSERT INTO webinar_passes (id, reg_id, lead_id, kind, status, amount, currency, paid_at, provider, whop_member_id, whop_payment_method_id, card_brand, card_last4, created_at, updated_at) VALUES ('wplt1', 'r', 'l1', 'live_ticket', 'paid', 10000, 'usd', 1, 'whop', 'mber_1', 'payt_1', 'visa', '4242', 1, 1)");
    const calls = stubFetch();
    await savePush(rt, room.id, { id: 1, kind: 'sprint', ref: null, to: null, at: T0, open: true, by: 'hadmin' }, 1);
    const r = await startRoomSprint(rt, room, who, { oneClick: true, returnUrl: 'https://apply.test/rooms/x/done?k=sprint' }, { sleep: async () => {} });
    await flush();
    expect(r.paid).toBe(true);
    const create = calls.find((c) => c.method === 'POST' && c.path === 'payments')!;
    expect(create.body).toMatchObject({ member_id: 'mber_1', payment_method_id: 'payt_1', metadata: { kind: 'offer', source: 'room', ref_id: room.id } });
    expect((create.body!.variant as { initial_price: number }).initial_price).toBe(3000);
    expect(q("SELECT status FROM webinar_passes WHERE kind = 'offer'")).toEqual([{ status: 'paid' }]);
    expect(q("SELECT event FROM room_push_events WHERE who = 'rlr1' ORDER BY event")).toEqual([{ event: 'paid' }, { event: 'started' }]);
    expect(q<{ n: number }>("SELECT COUNT(*) AS n FROM deal_sprints WHERE lead_id = 'l1'")[0].n).toBe(1);
    expect(q("SELECT name FROM attr_capi WHERE lead_id = 'l1' AND name = 'attr_room_purchase'")).toHaveLength(1);
    expect((await pushStats(rt, room.id)).pushes[0].counts.paid).toBe(1);
  });
});

// ───────────── after the session: the summary email, Funnel HQ, the AI call note ─────────────

describe('after the session', () => {
  it('each attendee gets one summary: points, unlocks, the Deal Plan, the offer’s real close time; never the unsubscribed', async () => {
    const { room, eventId } = await liveRoom();
    seedLead('l1'); seedLead('l2', { unsub: true });
    const a = seedReg(eventId, 'lr1', 'l1', 'rlr1');
    seedReg(eventId, 'lr2', 'l2', 'rlr2', 'Bob C.');
    const rules = engageConfig(rt).rules;
    await awardPoints(rt, room, [{ who: a, action: 'application', key: '1' }], rules);
    await grantUnlocks(rt, room, a, ['calculator'], 'points');
    await savePlan(rt, room, a, { industry: 'HVAC', size: '$2M to $5M', geography: 'Dallas', owners_per_week: '25', cash_flow: '900k', debt_service: '550k', action_1: 'Write my buy box', action_2: 'List 50 owners', action_3: 'Send 25 letters' });
    const { setRoomOffer } = await import('../src/rooms/rooms');
    await setRoomOffer(rt, room, true);
    x("UPDATE rooms SET status = 'ended', ended_at = ? WHERE id = ?", T0, room.id);
    const r = await sendRoomSummaries(rt, room.id);
    expect(r).toEqual({ sent: 1, skipped: 1 });
    const mail = q<{ template: string; subject: string; to_email: string }>("SELECT template, subject, to_email FROM emails WHERE sequence LIKE 'room_summary:%'");
    expect(mail).toEqual([{ template: 'room_summary', subject: 'Your Deal Plan from Buy your first competitor', to_email: 'l1@example.com' }]);
    expect((await sendRoomSummaries(rt, room.id)).sent).toBe(0); // once each
    const plan = await planUrl(rt, room.id, 'rlr1');
    expect(await checkPlanLink(rt, room.id, decodeURIComponent(plan.split('/').pop()!))).toBe('rlr1');
    expect(await checkPlanLink(rt, room.id, 'rlr2.000000000000000000000000')).toBeNull();
  });
  it('the summary email itself passes the copy rules and only mentions the offer when it is open and unbought', () => {
    const base = { name: 'Dana', title: 'Buy your first competitor', points: 85, unlocks: [{ title: ASSETS[0].title, url: 'https://apply.test/rooms/a/x' }], planUrl: 'https://apply.test/rooms/plan/x', applied: true };
    const plan = cleanPlan({ industry: 'HVAC', size: '$2M to $5M', geography: 'Dallas', owners_per_week: '25', cash_flow: '900k', debt_service: '550k', action_1: 'Write my buy box', action_2: 'List 50 owners', action_3: 'Send 25 letters' });
    const m = summaryEmail({ ...base, plan, bought: false, offer: { label: '$5,000 engagement deposit', closesAt: 'Thursday 5 November, 7:00 pm EST', url: 'https://apply.test/live/room/x' } });
    expect(auditEmail({ subject: m.subject, preheader: m.preheader, body: m.paras })).toEqual([]);
    expect(m.paras.join(' ')).toContain('closes on Thursday 5 November');
    expect(m.paras.join(' ')).toContain('1.64x, which passes');
    expect(summaryEmail({ ...base, plan, bought: true, offer: { label: 'x', closesAt: 'y', url: 'z' } }).paras.join(' ')).not.toContain('closes');
    expect(summaryEmail({ ...base, plan: null, planUrl: null, bought: false, offer: null }).subject).toBe('Your summary from Buy your first competitor');
  });
  it('Funnel HQ: the report, one person’s timeline, the lead’s engagement and the AI call note', async () => {
    const { room, eventId } = await liveRoom();
    seedLead('l1');
    const a = seedReg(eventId, 'lr1', 'l1', 'rlr1');
    const rules = engageConfig(rt).rules;
    await awardPoints(rt, room, [{ who: a, action: 'on_time', key: '1' }, { who: a, action: 'chapter', key: '0' }], rules);
    await savePlan(rt, room, a, { industry: 'HVAC', size: '$2M to $5M', geography: 'Dallas' });
    x('INSERT INTO room_minutes (room_id, minute, n) VALUES (?, 0, 5), (?, 1, 4)', room.id, room.id);
    const rep = await engageReport(rt, room, [{ text: 'How do I find owners?', votes: 3, name: 'Ann', answered: false }]);
    expect(rep.people[0]).toMatchObject({ who: 'rlr1', points: 15, planSteps: 1 });
    expect(rep.retention).toEqual([{ minute: 0, n: 5 }, { minute: 1, n: 4 }]);
    expect(rep.points.buckets[0]).toMatchObject({ from: 0, to: 25, n: 1 });
    const tl = await personTimeline(rt, room.id, 'rlr1');
    expect(tl.items.map((i) => i.text)).toContain('Joined on time: +10');
    expect(await leadEngagement(rt, 'l1')).toMatchObject({ points: 15, rooms: 1, applied: false, plan: { industry: 'HVAC' } });
    const { callNote } = await import('../src/rooms/engage-db');
    expect(await callNote(rt, 'l1')).toContain('15 Deal momentum points');
    expect(q("SELECT DISTINCT stage FROM attr_stages WHERE reg_id = 'lr1' ORDER BY stage")).toEqual([{ stage: 'room_plan_step' }, { stage: 'room_points' }]);
  });
  it('what can be pushed comes from the room and the settings', () => {
    expect(engageAvail(rt, { ref_type: 'live', ref_id: 'e1', mode: 'webinar' })).toMatchObject({ application: true, sprint: true, deposit: true, vip: false });
    expect(engageAvail(rt, { ref_type: 'challenge', ref_id: 'challenge:c1:2', mode: 'webinar' })).toMatchObject({ deposit: false, vip: true });
    expect(engageAvail(makeRt({}), { ref_type: 'live', ref_id: 'e1', mode: 'webinar' }).sprint).toBe(false);
    expect(engageAvail(rt, { ref_type: 'lead', ref_id: null, mode: 'meeting' })).toMatchObject({ application: false, resources: [] });
  });
});

// ───────────── copy ─────────────

describe('engagement copy', () => {
  const plain = (h: string) => h.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<br\s*\/?>|<\/(p|li|div|h1|h2|td|th|tr)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&[a-z]+;/g, ' ');
  it('every room string, preset, agenda line, asset and setting passes the house copy rules', () => {
    const fns = Object.fromEntries(Object.entries(ENGAGE_COPY).map(([k, v]) => [k, typeof v === 'function' ? (v as (a: unknown, b: unknown) => string)(3, 7) : v]));
    const strings = { copy: fns, presets: QUIZ_PRESETS, agenda: DEFAULT_AGENDA, assets: ASSETS.map((a) => [a.title, a.body]), rules: Object.values(DEFAULT_RULES).map((r) => r.label), titles: ROOM_QUESTION_TITLES,
      settings: SETTING_DEFS.filter((s) => ['ENGAGE_POINTS', 'ENGAGE_UNLOCKS', 'ROOM_APP_FOLLOWUPS'].includes(s.key)).map((s) => [s.label, (s as { help?: string }).help ?? '']),
      stages: STAGES.filter((s) => s.id.startsWith('room_')).map((s) => s.label) };
    expect(auditFields(strings)).toEqual([]);
    expect(JSON.stringify(strings)).not.toMatch(/[!—]/);
    expect(JSON.stringify(strings)).not.toMatch(/\bbook (a|your) call\b/i);
  });
  it('the unlock files are real, on-method and pass the copy rules (illustrative numbers labelled, seller rollover named)', () => {
    for (const a of ASSETS) {
      const raw = fs.readFileSync(`${node.cwd()}/public${a.file}`, 'utf8');
      const text = a.file.endsWith('.csv') ? raw.replace(/"/g, '').replace(/,+/g, ' ').replace(/=\S+/g, '') : plain(raw);
      expect(text.length, a.id).toBeGreaterThan(800);
      // The buy box is a form: its prose (the paragraphs) is audited; the field labels and e.g. hints are not sentences.
      const prose = a.id === 'buybox' ? plain((raw.match(/<p[^>]*>[\s\S]*?<\/p>/g) ?? []).join('\n')) : text;
      expect(auditCopy(prose), a.id).toEqual([]);
      expect(text, a.id).not.toMatch(/[—!]/);
      if (/debt/i.test(text)) expect(text, a.id).toMatch(/seller rollover/i);
      if (/\$\d|\d{6}/.test(text) && a.id !== 'buybox') expect(text, a.id).toMatch(/illustrative/i);
    }
  });
  it('the calculator’s formulas point at the right cells (the default inputs pass at about 1.58x)', () => {
    const rows = fs.readFileSync(`${node.cwd()}/public/unlocks/deal-calculator.csv`, 'utf8').split('\n');
    const cell = (r: number) => rows[r - 1].split(',')[0];
    expect(cell(5)).toBe('Yearly cash flow before loan payments');
    expect(cell(6)).toBe('Purchase price');
    expect(rows[22]).toContain('=B5/B22');
    const pmt = (r: number, n: number, pv: number) => (pv * r) / (1 - (1 + r) ** -n);
    const ratio = 900_000 / (pmt(0.09, 7, 1_800_000) + pmt(0.06, 5, 900_000));
    expect(ratio).toBeGreaterThan(1.5);
    expect(ratio).toBeLessThan(1.65);
  });
});

// ───────────── general admission and co-host links ─────────────

describe('general admission links', () => {
  const visitor = (o: Record<string, unknown> = {}) => ({
    visitorId: 'vga1', sessionId: 'sga1', leadId: null, isNewVisitor: true, isNewSession: true, isBot: false, botReason: null, variant: 'a',
    ua: { device: 'desktop', browser: 'x', os: 'y' }, userAgent: 'test', geo: { country: 'US', city: null, timezone: 'America/New_York' }, ip: '1.2.3.4', touch: null, fbp: null, fbc: null, marketingConsent: false, consentRequired: false, ...o,
  }) as never;
  const page = new Hono<AppEnv>();
  page.use('*', async (c, next) => { c.set('settings', { ...ALL(), ...SETTINGS } as never); c.set('visitor', visitor()); await next(); });
  page.get('/rooms/:id', publicRoomPage);
  const get = (path: string) => page.request(path, {}, { DB: d1(db), SESSION_SECRET: 'test-session-secret' } as never, { waitUntil: () => {}, passThroughOnException: () => {} } as never);
  const roleIn = async (res: Response) => /"me":\{"id":"[^"]+","name":"([^"]*)","role":"(\w+)"/.exec(await res.text())?.slice(1);

  it('one link per room: valid until rotated or switched off; meetings are off by default', async () => {
    const room = await createRoom(rt, { mode: 'webinar', title: 'Open session', refType: 'none' });
    const url = await joinUrl(rt, room);
    expect(url).toMatch(new RegExp(`^https://apply\\.test/rooms/${room.id}/join/[0-9a-f]{16}$`));
    const slug = url.split('/').pop()!;
    expect(await checkJoin(rt, room, slug)).toMatchObject({ on: true, requireEmail: true });
    expect(await checkJoin(rt, room, slug.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')))).toBeNull();
    await saveAdmission(rt, room, { v: 1 });
    const rotated = (await getRoom(rt, room.id))!;
    expect(await checkJoin(rt, rotated, slug)).toBeNull(); // the old link stops
    expect(await checkJoin(rt, rotated, (await joinUrl(rt, rotated)).split('/').pop())).not.toBeNull();
    await saveAdmission(rt, rotated, { on: false });
    expect(await checkJoin(rt, (await getRoom(rt, room.id))!, (await joinUrl(rt, rotated)).split('/').pop())).toBeNull();
    const meet = await createRoom(rt, { mode: 'meeting', title: 'Kickoff', refType: 'none' });
    expect(admissionOf(meet).on).toBe(false);
    expect(trackedJoin(url, { utm_source: 'instagram', utm_campaign: 'live <nov>', bogus: 'x' })).toBe(`${url}?utm_source=instagram&utm_campaign=live+nov`);
  });

  it('an event’s room registers the joiner for the event through the live funnel (lead, registration, UTMs), then their personal link', async () => {
    const { room, eventId } = await liveRoom();
    x(`INSERT INTO sessions (id, visitor_id, started_at, last_seen_at, channel, utm_source, utm_medium, utm_campaign) VALUES ('sga1', 'vga1', ?, ?, 'Paid Social', 'instagram', 'story', 'live-nov')`, T0, T0);
    const r = await joinRoom(rt, room, visitor(), { first_name: 'Sam', email: 'sam@example.org', revenue: '3_10m', call_consent: 'on' }, admissionOf(room));
    await flush();
    expect(r).toMatchObject({ redirect: expect.stringMatching(/\/live\/room\/[A-Za-z0-9_-]+$/) });
    const reg = q<{ token: string; lead_id: string; event_id: string }>('SELECT token, lead_id, event_id FROM live_webinar_regs')[0];
    expect(reg.event_id).toBe(eventId);
    expect((r as { redirect: string }).redirect).toContain(reg.token);
    expect(q('SELECT first_name, email, utm_source, utm_campaign, revenue_band FROM leads WHERE id = ?', reg.lead_id)[0]).toEqual({ first_name: 'Sam', email: 'sam@example.org', utm_source: 'instagram', utm_campaign: 'live-nov', revenue_band: '3m-10m' });
    expect(q("SELECT stage FROM attr_stages WHERE stage = 'registered'")).toHaveLength(1);
    // No band given: still in (the band is optional on the join sheet).
    const r2 = await joinRoom(rt, room, visitor({ visitorId: 'vga2', sessionId: 'sga2', ip: '5.6.7.8' }), { first_name: 'Lee', email: 'lee@example.org' }, admissionOf(room));
    expect('redirect' in r2).toBe(true);
  });

  it('an address that belongs to someone else never logs this browser in: the personal link goes to their inbox', async () => {
    const room = await createRoom(rt, { mode: 'webinar', title: 'Open session', refType: 'none' });
    seedLead('l1');
    expect(await joinRoom(rt, room, visitor(), { first_name: 'Mallory', email: 'l1@example.com' }, admissionOf(room))).toEqual({ checkEmail: true });
    expect(q("SELECT template, to_email FROM emails WHERE template = 'room_join_link'")).toEqual([{ template: 'room_join_link', to_email: 'l1@example.com' }]);
    // Their own browser (linked to the lead) goes straight in with their identity.
    const own = await joinRoom(rt, room, visitor({ leadId: 'l1' }), { first_name: 'Dana', email: 'l1@example.com' }, admissionOf(room)) as { redirect: string };
    expect(own.redirect).toContain(`/rooms/${room.id}?i=`);
    const { room: live } = await liveRoom();
    x(`INSERT INTO live_webinar_regs (id, token, event_id, lead_id, revenue_band, created_at) VALUES ('lrx', 'tokxaaaaaaaaaaaaaaaaaaa', ?, 'l1', '3m-10m', ?)`, live.ref_id, T0 - DAY);
    expect(await joinRoom(rt, live, visitor({ ip: '9.9.9.9' }), { first_name: 'Mallory', email: 'l1@example.com' }, admissionOf(live))).toEqual({ checkEmail: true });
  });

  it('a new email in a non-event room becomes a lead with a personal invite; email is required unless switched off', async () => {
    const room = await createRoom(rt, { mode: 'webinar', title: 'Open session', refType: 'none' });
    expect(await joinRoom(rt, room, visitor(), { first_name: 'Sam' }, admissionOf(room))).toMatchObject({ field: 'email', status: 400 });
    const r = await joinRoom(rt, room, visitor(), { first_name: 'Sam', email: 'sam@example.org' }, admissionOf(room)) as { redirect: string };
    expect(r.redirect).toContain(`/rooms/${room.id}?i=`);
    expect(q("SELECT first_name, landing_path FROM leads WHERE email = 'sam@example.org'")).toEqual([{ first_name: 'Sam', landing_path: `/rooms/${room.id}/join` }]);
    const res = await get(new URL(r.redirect).pathname + new URL(r.redirect).search);
    expect(await roleIn(res)).toEqual(['Sam', 'attendee']);
  });

  it('roles never come from the name: name-only joiners are attendees in a webinar and guests in a meeting', async () => {
    const room = await createRoom(rt, { mode: 'webinar', title: 'Open session', refType: 'none' });
    await saveAdmission(rt, room, { requireEmail: false });
    const fresh = (await getRoom(rt, room.id))!;
    const r = await joinRoom(rt, fresh, visitor(), { first_name: 'Host', role: 'host' }, admissionOf(fresh)) as { redirect: string };
    expect(await roleIn(await get(new URL(r.redirect).pathname + new URL(r.redirect).search))).toEqual(['Host', 'attendee']);
    const meet = await createRoom(rt, { mode: 'meeting', title: 'Kickoff', refType: 'none' });
    const m = await joinRoom(rt, meet, visitor({ ip: '2.2.2.2' }), { name: 'Co-host' }, { ...admissionOf(meet), on: true }) as { redirect: string };
    expect(await roleIn(await get(new URL(m.redirect).pathname + new URL(m.redirect).search))).toEqual(['Co-host', 'guest']);
  });

  it('joins are limited per IP', async () => {
    const room = await createRoom(rt, { mode: 'webinar', title: 'Open session', refType: 'none' });
    await saveAdmission(rt, room, { requireEmail: false });
    const fresh = (await getRoom(rt, room.id))!;
    for (let i = 0; i < JOINS_PER_IP_HOUR; i++) expect('redirect' in await joinRoom(rt, fresh, visitor(), { first_name: `P${i}` }, admissionOf(fresh))).toBe(true);
    expect(await joinRoom(rt, fresh, visitor(), { first_name: 'One more' }, admissionOf(fresh))).toMatchObject({ status: 429 });
    expect('redirect' in await joinRoom(rt, fresh, visitor({ ip: '7.7.7.7' }), { first_name: 'Elsewhere' }, admissionOf(fresh))).toBe(true);
  });

  it('co-host links: validity, and rotating stops every earlier one', async () => {
    const room = await createRoom(rt, { mode: 'webinar', title: 'Live', refType: 'none', startsAt: T0 + HOUR, durationMin: 90 });
    expect(cohostTtl(room, 'day', T0)).toBe(HOUR + 90 * MIN + 12 * HOUR);
    expect(cohostTtl(room, '7d', T0)).toBe(7 * DAY);
    const url = await cohostUrl(rt, room, '7d');
    const path = new URL(url).pathname + new URL(url).search;
    expect((await roleIn(await get(path)))?.[1]).toBe('cohost');
    await saveAdmission(rt, room, { cohostV: 1 });
    expect((await get(path)).status).toBe(403);
    const next = await cohostUrl(rt, (await getRoom(rt, room.id))!, 'rotated');
    expect((await roleIn(await get(new URL(next).pathname + new URL(next).search)))?.[1]).toBe('cohost');
  });

  it('the join sheet and its messages pass the copy rules; the consent boxes start unticked', async () => {
    expect(auditFields(JOIN_COPY)).toEqual([]);
    expect(JSON.stringify(JOIN_COPY)).not.toMatch(/[!—]/);
    const room = await createRoom(rt, { mode: 'webinar', title: 'Open session', refType: 'none' });
    const html = await joinSheet(rt, room, admissionOf(room), { action: '/x' });
    expect(html).toContain('name="sms_consent"');
    expect(html).toContain('name="call_consent"');
    expect(html).not.toMatch(/checked/);
  });
});
