import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/app';
import { auditCopy, auditFields } from '../src/content/copy-rules';
import { type Identity, type RoomState, apply, join, newEngage, newRoomState, parseAutoPush } from '../src/rooms/state';
import { AUDIENCE_COPY, enqueue, newCohost, queueView } from '../src/rooms/audience';
import { AudienceHub } from '../src/rooms/audience-do';
import {
  type PushPerf, MIN_SHOWN, OBJECTION_TYPES, QA_COPY, bestMinutes, classifyObjection, objectionOutcomes, pushPerformance, recommendationText, reopenKind, reopenPlan, tallyMove, tallyView,
} from '../src/rooms/qa';
import { markAnswered, objectionReport, pushReport, recordAsk, retag } from '../src/rooms/qa-db';
import { allowedNumbers, ruleDebrief } from '../src/rooms/intel';
import { createRoom } from '../src/rooms/rooms';
import { setClaudeTransport } from '../src/ops/claude';
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

const MIN = 60_000, DAY = 24 * 60 * MIN;
const T0 = Date.parse('2026-11-03T02:00:00Z');
let db: DatabaseSync;
let rt: Runtime;
const ALL = () => Object.fromEntries(SETTING_DEFS.map((d) => [d.key, ''])) as Record<string, string>;
const makeRt = (s: Record<string, string> = {}) => ({ env: { DB: d1(db), SESSION_SECRET: 'test-session-secret' }, settings: { ...ALL(), SITE_NAME: 'G&L', ...s }, reps: [], origin: 'https://apply.test', waitUntil: () => {} }) as unknown as Runtime;
const q = <T = Record<string, unknown>>(sql: string, ...a: unknown[]) => db.prepare(sql).all(...(a as (string | number | null)[])) as T[];
const x = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...(a.map((v) => (v === undefined ? null : v)) as (string | number | null)[]));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  db = freshDb();
  rt = makeRt();
});
afterEach(() => { vi.useRealTimers(); setClaudeTransport(null); });

const host: Identity = { id: 'hadmin', name: 'Josh', role: 'host' };
const ann: Identity = { id: 'rann', name: 'Ann Baker', role: 'attendee', leadId: 'l1', regId: 'r1' };
const bob: Identity = { id: 'rbob', name: 'Bob Chen', role: 'attendee', leadId: 'l2', regId: 'r2' };
const cat: Identity = { id: 'rcat', name: 'Cat Diaz', role: 'attendee', leadId: 'l3', regId: 'r3' };
function webinar(o: { offerOpen?: boolean; deposit?: boolean; sprint?: boolean } = {}) {
  const st = newRoomState({ id: 'rmqatest123', mode: 'webinar', title: 'Live', startsAt: T0, offerAvailable: true });
  st.eng = newEngage({ avail: { application: true, sprint: o.sprint ?? true, deposit: o.deposit ?? true, vip: false, resources: [] } });
  for (const w of [host, ann, bob, cat]) join(st, w, T0);
  st.status = 'live'; st.wentLiveAt = T0 - 10 * MIN;
  st.offer.open = o.offerOpen ?? true;
  return st;
}
function hubFor(st: RoomState, r: Runtime = rt) {
  const sent: { to: string; msg: Record<string, unknown> }[] = [];
  const store = new Map<string, unknown>();
  const jobs: Promise<unknown>[] = [];
  let commits = 0;
  const hub = new AudienceHub({
    st: () => st, deliver: (to, msg) => sent.push({ to, msg }), runtime: async () => r,
    storage: { get: async (k: string) => store.get(k), put: async (k: string, v: unknown) => { store.set(k, JSON.parse(JSON.stringify(v))); } } as unknown as DurableObjectStorage,
    waitUntil: (p) => { jobs.push(p); }, commit: async () => { commits++; },
  });
  const settle = async () => { while (jobs.length) await Promise.all(jobs.splice(0)); await new Promise((res) => setTimeout(res, 450)); while (jobs.length) await Promise.all(jobs.splice(0)); };
  return { hub, sent, settle, of: (t: string) => sent.filter((s) => s.msg.t === t), commits: () => commits };
}
/** An attendee's chat line through the room's own state machine, then the co-host. */
async function chat(st: RoomState, hub: AudienceHub, who: string, text: string, now = T0) {
  const r = apply(st, who, { t: 'chat', text }, now);
  expect(r.ok).toBe(true);
  await hub.afterApply(who, { t: 'chat', text }, now);
}
const lastCohost = (of: (t: string) => { msg: Record<string, unknown> }[]) => of('cohost').at(-1)!.msg as { obj: Record<string, number>; queue: { id: number; qtype: string | null; qby: string | null; status: string; text: string }[] };

// ───────────── objection types ─────────────

describe('objection types: keyword rules, every question tagged', () => {
  it('tags the common questions of a webinar audience', () => {
    const cases: [string, string][] = [
      ['How much does the engagement cost?', 'price'],
      ['Is it worth the investment for a $2M business?', 'price'],
      ['Can I pay in instalments or is there a payment plan?', 'financing'],
      ['Will the bank want a personal guarantee?', 'financing'],
      ['What if the deal falls over, do I get a refund?', 'financing'],
      ['Do you have proof this works, any case studies or results?', 'trust'],
      ['Does this work for a clinic in Australia?', 'fit'],
      ['Will this work for me if I have never bought a business?', 'fit'],
      ['How many hours a week does this take while I run my business?', 'time'],
      ['Can I join the next intake instead, not ready yet', 'timing'],
      ['Is there a recording and where is the zoom link?', 'logistics'],
      ['What did you have for breakfast?', 'other'],
    ];
    for (const [text, type] of cases) expect(classifyObjection(text).type, text).toBe(type);
  });
  it('a question gets its type in the queue; repeats from new people count once each; mentions are not counted', () => {
    const c = newCohost();
    enqueue(c, { kind: 'question', text: 'How much does the engagement cost?', who: 'a', name: 'Ann' }, T0);
    enqueue(c, { kind: 'question', text: 'How much does the engagement cost exactly?', who: 'b', name: 'Bob' }, T0);
    enqueue(c, { kind: 'question', text: 'How much does the engagement cost exactly?', who: 'b', name: 'Bob' }, T0); // same person again
    enqueue(c, { kind: 'mention', text: 'thanks', who: 'c', name: 'Cat' }, T0);
    expect(tallyView(c)).toMatchObject({ price: 2, other: 0 });
    expect(queueView(c)[0]).toMatchObject({ qtype: 'price', qby: 'rules', count: 2 });
    expect(queueView(c).find((x) => x.kind === 'mention')).toMatchObject({ qtype: null });
    tallyMove(c, 'price', 'financing', 2);
    expect(tallyView(c)).toMatchObject({ price: 0, financing: 2 });
  });
});

// ───────────── live counts in the room, the database, the AI re-tag ─────────────

describe('the co-host in the room: tags, live counts for staff, rows for the reports', () => {
  it('chat questions and Q&A questions are tagged, counted for host and co-hosts only, and stored', async () => {
    const room = await createRoom(rt, { mode: 'webinar', title: 'Live', refType: 'none', startsAt: T0 });
    const st = webinar(); st.id = room.id;
    const { hub, of, settle } = hubFor(st);
    await chat(st, hub, 'rann', 'How much does the deposit cost?');
    await chat(st, hub, 'rbob', 'How much does the deposit cost in total?');
    apply(st, 'rcat', { t: 'ask', text: 'Does this work for a clinic in Australia?' }, T0);
    await hub.afterApply('rcat', { t: 'ask' }, T0);
    await settle();
    const v = lastCohost(of);
    expect(v.obj).toMatchObject({ price: 2, fit: 1 });
    expect(v.queue.map((x) => x.qtype).sort()).toEqual(['fit', 'price']);
    expect(of('cohost').every((s) => s.to === 'hadmin')).toBe(true);
    const rows = q<{ ref: string; who: string; lead_id: string; qtype: string; source: string }>('SELECT ref, who, lead_id, qtype, source FROM room_objections ORDER BY ref');
    expect(rows.map((r) => [r.who, r.qtype, r.source])).toEqual([['rann', 'price', 'chat'], ['rbob', 'price', 'chat'], ['rcat', 'fit', 'question']]);
    expect(rows.find((r) => r.who === 'rann')!.lead_id).toBe('l1');
  });
  it('with a key, the AI co-host’s objection type replaces the rules’ and the counts move with it', async () => {
    setClaudeTransport(async () => JSON.stringify({ answer: 'We answer that live.', citations: [], confidence: 0.3, needs_human: true, objection: 'financing' }));
    const room = await createRoom(rt, { mode: 'webinar', title: 'Live', refType: 'none', startsAt: T0 });
    const st = webinar(); st.id = room.id;
    const { hub, of, settle } = hubFor(st);
    await chat(st, hub, 'rann', 'What does it cost if the deal never closes?');
    await settle();
    const v = lastCohost(of);
    expect(v.queue[0]).toMatchObject({ qtype: 'financing', qby: 'ai' });
    expect(v.obj).toMatchObject({ financing: 1, price: 0 });
    expect(q('SELECT qtype, tagged_by FROM room_objections')).toEqual([{ qtype: 'financing', tagged_by: 'ai' }]);
    // The draft stays a draft: nothing went to the room (ROOM_COHOST_AUTO is off).
    expect(of('chat')).toHaveLength(0);
  });
});

// ───────────── answer and reopen the offer ─────────────

describe('answer and reopen the offer: the team’s answer, then the offer card again', () => {
  it('chooses the deposit while the offer is open, else the Sprint, else nothing', () => {
    expect(reopenKind(webinar())).toBe('deposit');
    expect(reopenKind(webinar({ offerOpen: false }))).toBe('sprint');
    expect(reopenKind(webinar({ offerOpen: false, sprint: false }))).toBeNull();
    expect(reopenKind(webinar(), 'sprint')).toBe('sprint');
    expect(reopenKind(webinar({ offerOpen: false }), 'deposit')).toBeNull();
  });
  it('to the askers: their answer comes privately, labelled, and the open card for the room is shown to them again', async () => {
    const st = webinar();
    const pushed = apply(st, 'hadmin', { t: 'push', kind: 'deposit' }, T0);
    expect(pushed.ok).toBe(true);
    const pid = st.eng!.pushes.at(-1)!.id;
    const { hub, of, settle } = hubFor(st);
    await chat(st, hub, 'rann', 'How much is the deposit and what does it cost after?');
    await settle();
    const item = lastCohost(of).queue[0];
    expect(await hub.onMessage('rann', { t: 'cohost_reopen', id: item.id, text: 'x', scope: 'askers' }, T0)).toBe('forbidden');
    expect(await hub.onMessage('hadmin', { t: 'cohost_reopen', id: item.id, text: 'The deposit is credited in full against the engagement fee.', scope: 'askers' }, T0 + MIN)).toBeNull();
    await settle();
    expect(of('chat')).toHaveLength(0); // private: not posted to the room
    expect(of('team_answer')).toEqual([{ to: 'rann', msg: expect.objectContaining({ label: AUDIENCE_COPY.teamAnswer, text: 'The deposit is credited in full against the engagement fee.', room: false }) }]);
    expect(of('qa_reopen')).toEqual([{ to: 'rann', msg: { t: 'qa_reopen', pid, kind: 'deposit' } }]);
    expect(hub.takePending()).toBeNull(); // the card already reaches her: no new push
    expect(of('qa_reopened')).toEqual([{ to: 'hadmin', msg: expect.objectContaining({ scope: 'askers', kind: 'deposit' }) }]);
    expect(lastCohost(of).queue[0].status).toBe('sent');
    expect(q('SELECT answered_at, reopened_at FROM room_objections')).toEqual([{ answered_at: T0 + MIN, reopened_at: T0 + MIN }]);
  });
  it('to the askers with no card open: a new card for them alone through the room’s own push', async () => {
    const st = webinar({ offerOpen: false });
    const { hub, of, settle } = hubFor(st);
    await chat(st, hub, 'rann', 'Is it worth the price for a business my size?');
    await chat(st, hub, 'rbob', 'Is it worth the price for a business my size really?');
    await settle();
    const item = lastCohost(of).queue[0];
    expect(await hub.onMessage('hadmin', { t: 'cohost_reopen', id: item.id, text: 'The Sprint is built for owners at $1M revenue and up.', scope: 'askers' }, T0)).toBeNull();
    const next = hub.takePending()!;
    expect(next).toEqual({ t: 'push', kind: 'sprint', to: ['rann', 'rbob'] });
    // RoomDO runs it as the room's own push (the host is the actor).
    const r = apply(st, 'hadmin', next, T0);
    expect(r.ok).toBe(true);
    expect(st.eng!.pushes.at(-1)).toMatchObject({ kind: 'sprint', to: ['rann', 'rbob'], by: 'hadmin' });
  });
  it('an open card for selected people is widened instead of starting another', async () => {
    const st = webinar({ offerOpen: false });
    apply(st, 'hadmin', { t: 'push', kind: 'sprint', to: ['rcat'] }, T0);
    const plan = reopenPlan(st, ['rann'], 'askers');
    expect(plan).toMatchObject({ ok: true, kind: 'sprint', show: [], widen: { add: ['rann'] }, push: null });
    const { hub, of, settle, commits } = hubFor(st);
    await chat(st, hub, 'rann', 'Can I pay in instalments for this?');
    await settle();
    await hub.onMessage('hadmin', { t: 'cohost_reopen', id: lastCohost(of).queue[0].id, text: 'Yes, the team sets that up on the call.', scope: 'askers' }, T0);
    expect(st.eng!.pushes.at(-1)!.to).toEqual(['rcat', 'rann']);
    expect(commits()).toBeGreaterThan(0);
    expect(of('qa_reopen').map((s) => s.to)).toEqual(['rann']);
  });
  it('to everyone: the answer goes to the room labelled, and the offer card goes to the whole room', async () => {
    const st = webinar();
    const { hub, of, settle } = hubFor(st);
    await chat(st, hub, 'rbob', 'Do you have proof this works, any results?');
    await settle();
    await hub.onMessage('hadmin', { t: 'cohost_reopen', id: lastCohost(of).queue[0].id, text: 'Josh bought his clinics with 100% seller finance in both deals.', scope: 'all' }, T0);
    expect(of('chat')[0].msg.m).toMatchObject({ label: AUDIENCE_COPY.teamAnswer, by: 'hadmin', name: 'Josh' });
    expect(hub.takePending()).toEqual({ t: 'push', kind: 'deposit' });
    const r = apply(st, 'hadmin', { t: 'push', kind: 'deposit' }, T0);
    expect(r.ok).toBe(true);
    expect(st.eng!.pushes.at(-1)).toMatchObject({ kind: 'deposit', to: null });
    // A second reopen to everyone shows that same card again rather than pushing a new one.
    await chat(st, hub, 'rcat', 'When is the next intake, can I wait?');
    await settle();
    const it2 = lastCohost(of).queue.find((x) => x.status === 'open')!;
    await hub.onMessage('hadmin', { t: 'cohost_reopen', id: it2.id, text: 'This intake closes when the offer window does.', scope: 'all' }, T0);
    expect(hub.takePending()).toBeNull();
    expect(of('qa_reopen').at(-1)).toMatchObject({ to: 'all', msg: { pid: st.eng!.pushes.at(-1)!.id } });
  });
  it('nothing to reopen, or nobody here: nothing is sent and the item stays open', async () => {
    const st = webinar({ offerOpen: false, sprint: false });
    const { hub, of, settle } = hubFor(st);
    await chat(st, hub, 'rann', 'How much does it cost?');
    await settle();
    const id = lastCohost(of).queue[0].id;
    expect(await hub.onMessage('hadmin', { t: 'cohost_reopen', id, text: 'Answer', scope: 'askers' }, T0)).toBeNull();
    expect(of('qa_err')).toEqual([{ to: 'hadmin', msg: { t: 'qa_err', error: 'reopen_none', id } }]);
    expect(of('team_answer')).toHaveLength(0);
    const st2 = webinar();
    st2.members.rann.connected = 0;
    expect(reopenPlan(st2, ['rann'], 'askers')).toEqual({ ok: false, error: 'reopen_away' });
    expect(reopenPlan(st2, ['hadmin'], 'askers')).toEqual({ ok: false, error: 'reopen_away' });
  });
});

// ───────────── objection to purchase ─────────────

describe('objection to purchase: real counts per type', () => {
  it('counts each person once per type, bought after within the window, and leaves out people who had already paid', () => {
    const rows = [
      { room_id: 'r1', who: 'a', lead_id: 'la', qtype: 'price', at: T0, answered_at: T0 + MIN, reopened_at: T0 + MIN },
      { room_id: 'r1', who: 'a', lead_id: 'la', qtype: 'price', at: T0 + 2 * MIN, answered_at: null, reopened_at: null },
      { room_id: 'r1', who: 'b', lead_id: 'lb', qtype: 'price', at: T0, answered_at: null, reopened_at: null },
      { room_id: 'r1', who: 'c', lead_id: null, qtype: 'trust', at: T0, answered_at: null, reopened_at: null },
      { room_id: 'r1', who: 'd', lead_id: 'ld', qtype: 'timing', at: T0, answered_at: null, reopened_at: null },
      { room_id: 'r1', who: 'e', lead_id: 'le', qtype: 'fit', at: T0, answered_at: null, reopened_at: null },
    ];
    const paid: Record<string, number[]> = { a: [T0 + 5 * MIN], d: [T0 - MIN], e: [T0 + 30 * DAY] };
    const r = objectionOutcomes(rows, (_room, who) => paid[who] ?? []);
    expect(r.types).toEqual([
      { type: 'price', people: 2, bought: 1, notBought: 1, answered: 1, reopened: 1, boughtAfterReopen: 1 },
      { type: 'trust', people: 1, bought: 0, notBought: 1, answered: 0, reopened: 0, boughtAfterReopen: 0 },
      { type: 'fit', people: 1, bought: 0, notBought: 1, answered: 0, reopened: 0, boughtAfterReopen: 0 },
    ]);
    expect(r).toMatchObject({ people: 4, bought: 1 });
  });
  it('reads purchases from paid room cards and paid deposits or Sprints, per room and across rooms', async () => {
    const r1 = await createRoom(rt, { mode: 'webinar', title: 'One', refType: 'none', startsAt: T0 });
    const r2 = await createRoom(rt, { mode: 'webinar', title: 'Two', refType: 'none', startsAt: T0 });
    const ask = (roomId: string, ref: string, who: string, leadId: string | null, qtype: 'price' | 'financing' | 'trust', at = T0) => recordAsk(rt, { roomId, ref, itemId: Number(ref.split(':')[1]), who, leadId, qtype, by: 'rules', source: 'chat', text: 'q', at });
    await ask(r1.id, 'chat:1', 'rann', 'l1', 'price');
    await ask(r1.id, 'chat:2', 'rbob', 'l2', 'price');
    await ask(r1.id, 'chat:3', 'rcat', null, 'trust');
    await ask(r2.id, 'chat:1', 'rdan', 'l4', 'financing');
    await ask(r1.id, 'chat:1', 'rann', 'l1', 'price'); // the same row again: ignored
    x("INSERT INTO room_push_events (room_id, push_id, who, event, lead_id, at) VALUES (?, 1, 'rcat', 'paid', NULL, ?)", r1.id, T0 + 10 * MIN);
    x("INSERT INTO webinar_passes (id, reg_id, lead_id, kind, status, amount, currency, paid_at, created_at, updated_at) VALUES ('wp1', 'r1', 'l1', 'deposit', 'paid', 500000, 'usd', ?, ?, ?)", T0 + 20 * MIN, T0, T0);
    x("INSERT INTO webinar_passes (id, reg_id, lead_id, kind, status, amount, currency, paid_at, created_at, updated_at) VALUES ('wp2', 'r2', 'l2', 'offer', 'pending', 300000, 'usd', NULL, ?, ?)", T0, T0);
    await retag(rt, r2.id, 1, 'financing', 'ai');
    await markAnswered(rt, r1.id, 1, T0 + MIN, true);
    const one = await objectionReport(rt, { roomId: r1.id });
    expect(one.types).toEqual([
      { type: 'price', people: 2, bought: 1, notBought: 1, answered: 1, reopened: 1, boughtAfterReopen: 1 },
      { type: 'trust', people: 1, bought: 1, notBought: 0, answered: 0, reopened: 0, boughtAfterReopen: 0 },
    ]);
    expect(one.labels.price).toBe(QA_COPY.types.price);
    const all = await objectionReport(rt, { days: 30 });
    expect(all.rooms).toBe(2);
    expect(all.types.map((t) => [t.type, t.people, t.bought])).toEqual([['price', 2, 1], ['trust', 1, 1], ['financing', 1, 0]]);
  });
  it('feeds the debrief: an improvement from the real counts, every number allowed', () => {
    const base = { title: 'Live', durationMs: 60 * MIN, people: 40, peak: 30, liveMinutes: 60, lines: [], transcriptSource: 'none' as const, curve: [], events: [], marks: [], pushes: [], messages: [], reactionsKnown: true };
    const qa = [{ type: 'price', label: 'Price and value', people: 7, bought: 2, notBought: 5, reopened: 3, boughtAfterReopen: 2 }, { type: 'trust', label: 'Trust and proof', people: 2, bought: 2, notBought: 0, reopened: 0, boughtAfterReopen: 0 }];
    const d = ruleDebrief({ ...base, qa });
    expect(d.objectionOutcomes).toEqual(qa);
    const line = d.improvements.find((s) => s.includes('price and value'))!;
    expect(line).toBe("7 people raised price and value; 2 bought afterwards and 5 didn't. Answer it inside the pitch and reopen the offer right after the answer.");
    const allowed = allowedNumbers({ objectionOutcomes: qa });
    expect(['7', '2', '5'].every((n) => allowed.has(n))).toBe(true);
    expect(auditCopy(line)).toEqual([]);
    expect(ruleDebrief(base).objectionOutcomes).toBeUndefined();
  });
});

// ───────────── push analytics ─────────────

function perf(kind: string, minute: number, shown: number, goal: number, mode: 'auto' | 'manual' = 'auto', targeted = false): PushPerf {
  const counts = { shown, opened: goal, started: goal, submitted: kind === 'application' ? goal : 0, paid: kind === 'application' ? 0 : goal };
  return { room: 'r', id: 1, kind, ref: null, mode, at: T0, minute, targeted, counts, rates: { opened: null, started: null, submitted: null, paid: null } };
}
describe('push analytics: manual vs automatic, the minute, shown to paid, and the best minute', () => {
  it('turns pushes and events into a funnel per push with its minute after Go live', () => {
    const p = pushPerformance(
      [
        { room_id: 'r', id: 1, kind: 'sprint', ref: null, created_by: 'auto', created_at: T0 + 45 * MIN + 20_000, targets: null, went_live_at: T0 },
        { room_id: 'r', id: 2, kind: 'deposit', ref: null, created_by: 'hadmin', created_at: T0 + 61 * MIN, targets: '["rann"]', went_live_at: T0 },
        { room_id: 'r', id: 3, kind: 'application', ref: null, created_by: 'hadmin', created_at: T0 - MIN, targets: null, went_live_at: T0 },
      ],
      [{ room_id: 'r', push_id: 1, event: 'shown', n: 40 }, { room_id: 'r', push_id: 1, event: 'opened', n: 10 }, { room_id: 'r', push_id: 1, event: 'started', n: 6 }, { room_id: 'r', push_id: 1, event: 'paid', n: 2 }],
    );
    expect(p[0]).toMatchObject({ mode: 'auto', minute: 45, targeted: false, counts: { shown: 40, opened: 10, started: 6, submitted: 0, paid: 2 }, rates: { opened: 0.25, started: 0.15, paid: 0.05 } });
    expect(p[1]).toMatchObject({ mode: 'manual', minute: 61, targeted: true, rates: { opened: null } });
    expect(p[2].minute).toBeNull(); // before Go live
  });
  it('recommends the best five-minute window only once it has 20 people shown, compared with the schedule', () => {
    const schedule = parseAutoPush('35 application\n45 sprint');
    const data = [
      perf('sprint', 45, 30, 3), perf('sprint', 47, 20, 1), // 45-49: 50 shown, 4 paid (8%)
      perf('sprint', 31, 25, 5, 'manual'), // 30-34: 25 shown, 5 paid (20%)
      perf('sprint', 60, 19, 19, 'manual'), // too few shown to count, however good
      perf('sprint', 52, 300, 300, 'manual', true), // to selected people: left out
      perf('application', 35, 30, 9), perf('application', 20, 12, 6, 'manual'),
      perf('deposit', 70, 8, 1, 'manual'),
    ];
    const best = bestMinutes(data, schedule);
    const by = Object.fromEntries(best.map((b) => [b.kind, b]));
    expect(by.sprint).toMatchObject({ verdict: 'better_window', best: { from: 30, to: 34, shown: 25, goal: 5, manual: 1 }, scheduled: [45], scheduledStat: { from: 45, shown: 50, goal: 4, auto: 2 } });
    expect(by.application).toMatchObject({ verdict: 'schedule_best', goal: 'submitted', best: { from: 35, shown: 30, goal: 9 } });
    expect(by.deposit).toMatchObject({ verdict: 'not_enough', best: null, biggest: { shown: 8 } });
    const texts = best.map((b) => recommendationText(b));
    expect(texts[0]).toBe('The application: minutes 35 to 39 converts best, 9 of 30 shown applied (30%). Your schedule already sends it at minute 35.');
    expect(texts[1]).toBe('The Sprint card: minutes 30 to 34 converts best, 5 of 25 shown paid (20%). Your schedule sends it at minute 45, where 4 of 50 shown paid (8%). Consider moving it; the schedule only changes when you edit it.');
    expect(texts[2]).toBe(`The deposit card: not enough data yet. A window needs ${MIN_SHOWN} people shown the card; the largest so far is minutes 70 to 74 with 8.`);
    for (const t of texts) expect(auditCopy(t), t).toEqual([]);
    expect(recommendationText(bestMinutes([], parseAutoPush('40 vip'))[0])).toBe('The VIP card: no pushes after Go live yet.');
  });
  it('the report reads the rooms’ pushes and never touches the schedule', async () => {
    const room = await createRoom(rt, { mode: 'webinar', title: 'One', refType: 'none', startsAt: T0 });
    x('UPDATE rooms SET status = ?, went_live_at = ?, engage = ? WHERE id = ?', 'ended', T0, JSON.stringify({ autoPush: '40 sprint' }), room.id);
    x("INSERT INTO room_pushes (room_id, id, kind, ref, targets, target_count, created_by, created_at) VALUES (?, 1, 'sprint', NULL, NULL, 30, 'auto', ?)", room.id, T0 + 40 * MIN);
    x("INSERT INTO room_pushes (room_id, id, kind, ref, targets, target_count, created_by, created_at) VALUES (?, 2, 'sprint', NULL, NULL, 30, 'hadmin', ?)", room.id, T0 + 55 * MIN);
    for (let i = 0; i < 25; i++) x("INSERT INTO room_push_events (room_id, push_id, who, event, lead_id, at) VALUES (?, 1, ?, 'shown', NULL, ?)", room.id, `p${i}`, T0 + 40 * MIN);
    for (let i = 0; i < 2; i++) x("INSERT INTO room_push_events (room_id, push_id, who, event, lead_id, at) VALUES (?, 1, ?, 'paid', NULL, ?)", room.id, `p${i}`, T0 + 50 * MIN);
    for (let i = 0; i < 22; i++) x("INSERT INTO room_push_events (room_id, push_id, who, event, lead_id, at) VALUES (?, 2, ?, 'shown', NULL, ?)", room.id, `p${i}`, T0 + 55 * MIN);
    for (let i = 0; i < 4; i++) x("INSERT INTO room_push_events (room_id, push_id, who, event, lead_id, at) VALUES (?, 2, ?, 'paid', NULL, ?)", room.id, `q${i}`, T0 + 56 * MIN);
    const engageBefore = q('SELECT engage FROM rooms');
    const roomRow = (await import('../src/rooms/rooms')).getRoom(rt, room.id);
    const rep = await pushReport(rt, { room: await roomRow, now: T0 + DAY });
    expect(rep.pushes.map((p) => [p.id, p.mode, p.minute, p.counts.shown, p.counts.paid])).toEqual([[2, 'manual', 55, 22, 4], [1, 'auto', 40, 25, 2]]);
    const sprint = rep.best.find((b) => b.kind === 'sprint')!;
    expect(sprint).toMatchObject({ verdict: 'better_window', scheduled: [40], best: { from: 55, shown: 22, goal: 4 } });
    expect(sprint.text).toContain('the schedule only changes when you edit it');
    expect(q('SELECT engage FROM rooms')).toEqual(engageBefore);
  });
});

// ───────────── copy ─────────────

describe('copy', () => {
  it('every Q&A string passes the copy rules and every type has a label', () => {
    expect(auditFields(QA_COPY)).toEqual([]);
    for (const t of OBJECTION_TYPES) expect(QA_COPY.types[t]).toBeTruthy();
    expect(AUDIENCE_COPY.qa).toBe(QA_COPY);
  });
});
