import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/app';
import { auditCopy } from '../src/content/copy-rules';
import { type Identity, type RoomState, apply, join, newEngage, newRoomState } from '../src/rooms/state';
import {
  type Bonus, DEFAULT_WEIGHTS, E2_COPY, HOT_MIN, type ScoredPerson, type Signals, WEIGHT_KEYS, asksPrice, bonusDue, bonusView, boughtWhileLive, buyingOf, cleanBonus,
  emptySignals, hotList, hotRow, parseWeights, scoreOf, whyOf,
} from '../src/rooms/engage2';
import { Engage2Hub } from '../src/rooms/engage2-do';
import { HOT_FOLLOWUP_KIND, emptyBits, getBonus, grantLiveBonus, leadScore, proposeHotFollowup, roomScores, saveScores, setBonus, settleBonus, withdrawBonus } from '../src/rooms/engage2-db';
import { callNote, onRoomPurchase } from '../src/rooms/engage-db';
import { createRoom, getRoom } from '../src/rooms/rooms';
import { approveAction } from '../src/ops/actions';
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

function seedLead(id: string, first = 'Sam') {
  x(`INSERT INTO leads (id, ref_code, created_at, updated_at, visitor_id, first_name, last_name, email, status, revenue_band, country, city, answers)
     VALUES (?, ?, ?, ?, ?, ?, 'Lee', ?, 'partial', '3m-10m', 'AU', 'Perth', '{}')`, id, `R${id}`, T0 - DAY, T0 - DAY, `v${id}`, first, `${id}@example.com`);
}
function attend(roomId: string, who: string, leadId: string | null, name: string, minutes = 0) {
  x("INSERT INTO room_attendance (room_id, who, lead_id, name, role, first_at, last_at, minutes) VALUES (?, ?, ?, ?, 'attendee', ?, ?, ?)", roomId, who, leadId, name, T0 - 10 * MIN, T0, minutes);
}
const point = (roomId: string, who: string, action: string, key: string, pts = 5) => x('INSERT INTO room_points (room_id, who, action, key, points, at) VALUES (?, ?, ?, ?, ?, ?)', roomId, who, action, key, pts, T0);
function pay(id: string, leadId: string, kind: 'offer' | 'deposit', at: number, o: { source?: string; ref?: string } = {}) {
  x("INSERT INTO webinar_passes (id, reg_id, lead_id, kind, status, amount, currency, source, ref_id, paid_at, created_at, updated_at) VALUES (?, 'r', ?, ?, 'paid', 300000, 'usd', ?, ?, ?, ?, ?)", id, leadId, kind, o.source ?? null, o.ref ?? null, at, at, at);
}
async function liveRoom() {
  const room = await createRoom(rt, { mode: 'webinar', title: 'Buy your first competitor', refType: 'none', startsAt: T0 - 10 * MIN });
  x("UPDATE rooms SET status = 'live', went_live_at = ? WHERE id = ?", T0 - 10 * MIN, room.id);
  return room;
}

const HOST: Identity = { id: 'h1', name: 'Josh Li', role: 'host' };
const att = (id: string, name: string, leadId: string | null = null): Identity => ({ id, name, role: 'attendee', leadId });
function roomState(id: string, live = true) {
  const st = newRoomState({ id, mode: 'webinar', title: 'Buy your first competitor', startsAt: T0 - 10 * MIN });
  st.eng = newEngage({ avail: { application: true, sprint: true, deposit: false, vip: false, resources: ['calculator'] } });
  if (live) { st.status = 'live'; st.wentLiveAt = T0 - 10 * MIN; }
  return st;
}
function hubFor(st: RoomState, r: Runtime = rt) {
  const sent: { to: string; msg: Record<string, unknown> }[] = [];
  const store = new Map<string, unknown>();
  let commits = 0;
  const hub = new Engage2Hub({
    st: () => st, deliver: (to, msg) => sent.push({ to, msg }), runtime: async () => r,
    storage: { get: async (k: string) => store.get(k), put: async (k: string, v: unknown) => { store.set(k, JSON.parse(JSON.stringify(v))); } } as unknown as DurableObjectStorage,
    commit: async () => { commits++; },
  });
  return { hub, sent, store, of: (t: string) => sent.filter((s) => s.msg.t === t), commits: () => commits };
}
const sig = (o: Partial<Signals> = {}): Signals => ({ ...emptySignals(), ...o });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  db = freshDb();
  rt = makeRt();
});
afterEach(() => { vi.useRealTimers(); });

// ───────────── the score (pure) ─────────────

describe('the engagement score: 0 to 100 from real signals', () => {
  it('nothing is 0, everything is 100, and the default weights add up to 100', () => {
    expect(WEIGHT_KEYS.reduce((s, k) => s + DEFAULT_WEIGHTS[k].max, 0)).toBe(100);
    expect(scoreOf(sig()).score).toBe(0);
    const all = sig({ minutes: 60, onTime: true, polls: 2, quizzes: 2, questions: 2, planSteps: 4, reactions: 10, opened: 3, applied: true, checkout: ['deposit'], focusMs: 50 * MIN, awayMs: 0 });
    expect(scoreOf(all).score).toBe(100);
  });
  it('caps each signal (reactions, minutes) so tapping or idling can’t buy a high score', () => {
    const farm = scoreOf(sig({ reactions: 5000, minutes: 600, focusMs: 600 * MIN, awayMs: 0 }));
    expect(farm.parts.reactions).toBe(3);
    expect(farm.parts.minutes).toBe(20);
    expect(farm.score).toBe(30); // 3 + 20 + 7 focus
  });
  it('leaves out the tab beacons when there are none (no penalty for an old browser) and counts away time when there are', () => {
    const base = { minutes: 60, onTime: true, applied: true, checkout: ['sprint' as const] };
    const none = scoreOf(sig(base)).score;
    expect(none).toBe(Math.round((49 / 93) * 100));
    const inView = scoreOf(sig({ ...base, focusMs: 40 * MIN, awayMs: 0 })).score;
    const away = scoreOf(sig({ ...base, focusMs: 10 * MIN, awayMs: 30 * MIN })).score;
    expect(inView).toBeGreaterThan(none);
    expect(away).toBeLessThan(none);
    // A few seconds of beacons say nothing.
    expect(scoreOf(sig({ ...base, focusMs: 10_000, awayMs: 0 })).score).toBe(none);
  });
  it('reads ROOM_SCORE_WEIGHTS overrides and ignores nonsense', () => {
    const w = parseWeights('checkout:30, minutes:10/30, nonsense:5, reactions:x, focus:0');
    expect(w.checkout).toEqual({ max: 30, full: 1 });
    expect(w.minutes).toEqual({ max: 10, full: 30 });
    expect(w.reactions).toEqual(DEFAULT_WEIGHTS.reactions);
    expect(w.focus.max).toBe(0);
    expect(scoreOf(sig({ checkout: ['deposit'] }), w).score).toBe(Math.round((30 / (100 - 12 + 30 - 10 - 7)) * 100));
  });
  it('buying signals: a checkout started, the offer opened twice, a price question; and the reasons in plain words', () => {
    expect(buyingOf(sig({ offerOpens: 1 }))).toEqual([]);
    expect(buyingOf(sig({ checkout: ['sprint'], offerOpens: 2, price: true }))).toEqual(['checkout', 'offer_twice', 'price']);
    expect(asksPrice('How much is it and can I pay monthly?')).toBe(true);
    expect(asksPrice('Great session today')).toBe(false);
    expect(whyOf(sig({ checkout: ['deposit'], offerOpens: 3, price: true, minutes: 42, planSteps: 2 }))).toEqual([
      'Started the deposit checkout', 'Opened the offer 3 times', 'Asked about the price', '2 of 4 Deal Plan steps',
    ]);
  });
});

describe('the hot list (pure)', () => {
  const p = (who: string, score: number, o: Partial<ScoredPerson> = {}): ScoredPerson => ({ who, name: `Name ${who}`, leadId: null, score, buying: [], why: [], bought: false, online: true, applied: false, consent: false, ...o });
  it('ranks by score and buying signals, leaves out buyers and people below the line without a signal', () => {
    const list = hotList([p('a', 90), p('b', 40, { buying: ['checkout', 'price'] }), p('c', 30), p('d', 95, { bought: true }), p('e', HOT_MIN)]);
    expect(list.map((x) => x.who)).toEqual(['a', 'b', 'e']); // b ranks 80 (40 + 2 signals); c is below the line; d bought
  });
  it('offers the first name to mention only with their consent', () => {
    expect(hotRow(p('a', 70, { name: 'Sam Lee', consent: true })).mention).toBe('Sam');
    expect(hotRow(p('b', 70, { name: 'Ann Ray' })).mention).toBeNull();
  });
});

// ───────────── the live-only bonus (pure) ─────────────

describe('the live-only bonus: withdrawn for real, never switched back on', () => {
  const b = (o: Partial<Bonus> = {}): Bonus => ({ text: 'A lender pack review with the team', asset: null, until: 'offer', onAt: T0 - 20 * MIN, withdrawnAt: null, withdrawnReason: null, ...o });
  const live = { status: 'live' as const, endedAt: null };
  const ended = { status: 'ended' as const, endedAt: T0 };
  const noOffer = { available: false, open: false, closesAt: null };
  it('offer mode: live before the offer opens and while it is open; withdrawn when it closes (or the host closed it early)', () => {
    expect(bonusDue(b(), live, { available: true, open: false, closesAt: null }, T0).withdraw).toBe(false);
    expect(bonusDue(b(), live, { available: true, open: true, closesAt: T0 + 60 * MIN }, T0).withdraw).toBe(false);
    expect(bonusDue(b(), ended, { available: true, open: true, closesAt: T0 + 60 * MIN }, T0).withdraw).toBe(false); // the window outlives the session
    expect(bonusDue(b(), ended, { available: true, open: false, closesAt: T0 - MIN }, T0)).toEqual({ withdraw: true, reason: 'offer_closed' });
    expect(bonusDue(b(), live, { available: true, open: false, closesAt: null }, T0, true)).toEqual({ withdraw: true, reason: 'offer_closed' });
    expect(bonusDue(b(), ended, { available: true, open: false, closesAt: null }, T0)).toEqual({ withdraw: true, reason: 'ended' }); // never opened
  });
  it('end mode (and rooms with no offer) follow the session', () => {
    expect(bonusDue(b({ until: 'end' }), live, { available: true, open: true, closesAt: T0 + MIN }, T0).withdraw).toBe(false);
    expect(bonusDue(b({ until: 'end' }), ended, { available: true, open: true, closesAt: T0 + MIN }, T0)).toEqual({ withdraw: true, reason: 'ended' });
    expect(bonusDue(b(), ended, noOffer, T0)).toEqual({ withdraw: true, reason: 'ended' });
    expect(bonusDue(b({ withdrawnAt: T0 - MIN }), live, noOffer, T0).withdraw).toBe(false); // already withdrawn
  });
  it('a purchase counts only while it was live; the view shows the real close time only while the offer is open', () => {
    expect(boughtWhileLive(b(), T0)).toBe(true);
    expect(boughtWhileLive(b({ withdrawnAt: T0 }), T0)).toBe(false);
    expect(boughtWhileLive(b(), T0 - 30 * MIN)).toBe(false);
    expect(bonusView(b(), { available: true, open: true, closesAt: T0 + MIN })).toMatchObject({ live: true, closesAt: T0 + MIN, line: E2_COPY.bonus.untilOfferAt });
    expect(bonusView(b(), { available: true, open: false, closesAt: null })).toMatchObject({ live: true, closesAt: null, line: E2_COPY.bonus.untilOffer });
    expect(bonusView(b({ withdrawnAt: T0 }), noOffer)).toMatchObject({ live: false, closesAt: null, line: E2_COPY.bonus.ended });
    expect(cleanBonus({ text: 'hi' })).toBeNull();
    expect(cleanBonus({ text: ' A lender  pack <review> ', asset: 'nope', until: 'x' })).toEqual({ text: 'A lender pack review', asset: null, until: 'offer' });
    expect(cleanBonus({ text: 'A lender pack review', asset: 'calculator', until: 'end' })).toEqual({ text: 'A lender pack review', asset: 'calculator', until: 'end' });
  });
});

describe('copy', () => {
  it('every string passes auditCopy', () => {
    const out: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === 'string') out.push(v);
      else if (typeof v === 'function') out.push(String((v as (a: unknown, b: unknown) => unknown)(3, 'Sam')));
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(E2_COPY);
    expect(out.length).toBeGreaterThan(40);
    for (const s of out) expect(auditCopy(s), s).toEqual([]);
  });
});

// ───────────── the database ─────────────

describe('scores in the database: per room member and on the lead', () => {
  it('reads real rows (points, pushes, checkouts, purchases) plus the room’s own counts, and writes both tables', async () => {
    const room = await liveRoom();
    seedLead('l1'); seedLead('l2', 'Ann'); seedLead('l3', 'Bo');
    attend(room.id, 'p1', 'l1', 'Sam Lee', 55);
    attend(room.id, 'p2', 'l2', 'Ann Ray', 12);
    attend(room.id, 'p3', 'l3', 'Bo Chen', 30);
    point(room.id, 'p1', 'on_time', '1'); point(room.id, 'p1', 'poll', '1'); point(room.id, 'p1', 'poll', '2'); point(room.id, 'p1', 'question', '4');
    for (let i = 1; i <= 4; i++) point(room.id, 'p1', 'plan_step', `s${i}`, 10);
    x("INSERT INTO room_pushes (room_id, id, kind, created_at) VALUES (?, 1, 'sprint', ?)", room.id, T0);
    x("INSERT INTO room_push_events (room_id, push_id, who, event, lead_id, at) VALUES (?, 1, 'p1', 'opened', 'l1', ?)", room.id, T0);
    x("INSERT INTO room_checkouts (room_id, who, kind, lead_id, started_at) VALUES (?, 'p1', 'deposit', 'l1', ?)", room.id, T0);
    pay('wp3', 'l3', 'deposit', T0);
    const bits = { ...emptyBits(), reactions: { p1: 4 }, focus: { p1: { f: 40 * MIN, a: 5 * MIN } }, opens: { p1: 2 }, price: { p2: 1 as const } };
    const people = await roomScores(rt, room.id, bits, { online: new Set(['p1', 'p2']), consent: new Set(['p1']) });
    const p1 = people.find((p) => p.who === 'p1')!;
    expect(p1.signals).toMatchObject({ minutes: 55, onTime: true, polls: 2, questions: 1, planSteps: 4, reactions: 4, opened: 1, offerOpens: 2, checkout: ['deposit'], focusMs: 40 * MIN, awayMs: 5 * MIN });
    expect(p1.buying).toEqual(['checkout', 'offer_twice']);
    expect(p1.score).toBeGreaterThan(60);
    expect(people.find((p) => p.who === 'p2')!.buying).toEqual(['price']);
    expect(people.find((p) => p.who === 'p3')!.bought).toBe(true);
    await saveScores(rt, room.id, people, T0);
    const rows = q<{ who: string; score: number; bought: number; lead_id: string }>('SELECT who, score, bought, lead_id FROM room_engage_scores WHERE room_id = ? ORDER BY who', room.id);
    expect(rows.map((r) => [r.who, r.bought])).toEqual([['p1', 0], ['p2', 0], ['p3', 1]]);
    expect(await leadScore(rt, 'l1')).toMatchObject({ roomId: room.id, score: p1.score, best: p1.score });
    // The lead keeps its best score across rooms; the latest one is the room's.
    await saveScores(rt, 'rmother00000', [{ ...p1, score: 20 }], T0 + MIN);
    expect(await leadScore(rt, 'l1')).toMatchObject({ roomId: 'rmother00000', score: 20, best: p1.score });
    // The AI call's facts carry the score (context only), and no new call is made.
    const note = await callNote(rt, 'l1');
    expect(note).toContain('engagement score in the live room was 20 of 100');
    expect(note).toContain('never mention a score');
  });
});

// ───────────── the room's object ─────────────

describe('in the room: beacons, offer opens, the hot list and its actions', () => {
  it('counts tab time by the server’s clock (at most 90 seconds per beacon, only while live) and offer opens 10 seconds apart', async () => {
    const room = await liveRoom();
    const st = roomState(room.id);
    join(st, HOST, T0); join(st, att('p1', 'Sam Lee', 'l1'), T0);
    const h = hubFor(st);
    await h.hub.onMessage('p1', { t: 'e2_focus', v: true }, T0);
    await h.hub.onMessage('p1', { t: 'e2_focus', v: false }, T0 + 60_000);        // 60 s in view
    await h.hub.onMessage('p1', { t: 'e2_focus', v: false }, T0 + 60_000 + 30 * MIN); // a gap: only 90 s count as away
    const saved = h.store.get('e2') as { focus: Record<string, { f: number; a: number }>; opens: Record<string, number> };
    expect(saved.focus.p1).toEqual({ f: 60_000, a: 90_000 });
    await h.hub.onMessage('p1', { t: 'e2_open', kind: 'deposit' }, T0);
    await h.hub.onMessage('p1', { t: 'e2_open', kind: 'deposit' }, T0 + 2000);
    expect((h.store.get('e2') as typeof saved).opens.p1).toBe(1);
    // Staff send no beacons.
    await h.hub.onMessage('h1', { t: 'e2_focus', v: true }, T0);
    expect((h.store.get('e2') as { last: Record<string, unknown> }).last.h1).toBeUndefined();
  });
  it('a price question and reactions are counted without touching the message; the team gets a real hot list', async () => {
    const room = await liveRoom();
    seedLead('l1'); seedLead('l2', 'Ann');
    attend(room.id, 'p1', 'l1', 'Sam Lee', 20);
    attend(room.id, 'p2', 'l2', 'Ann Ray', 3);
    const st = roomState(room.id);
    join(st, HOST, T0); join(st, att('p1', 'Sam Lee', 'l1'), T0); join(st, att('p2', 'Ann Ray', 'l2'), T0);
    st.eng!.optIn = ['p1'];
    const h = hubFor(st);
    const msg = { t: 'chat', text: 'What does it cost to join?' };
    await h.hub.observe('p1', msg, T0);
    expect(msg).toEqual({ t: 'chat', text: 'What does it cost to join?' });
    await h.hub.observe('p2', { t: 'react', kind: 'clap' }, T0);
    await h.hub.onMessage('h1', { t: 'e2_hot_get' }, T0);
    const hot = h.of('e2_hot').filter((s) => s.to === 'h1').pop()!.msg as { rows: { id: string; buying: string[]; mention: string | null }[] };
    expect(hot.rows.map((r) => r.id)).toEqual(['p1']);
    expect(hot.rows[0]).toMatchObject({ buying: ['price'], mention: 'Sam' });
    expect(h.of('e2_hot').every((s) => s.to === 'h1')).toBe(true); // never to attendees
    expect(q('SELECT who FROM room_engage_scores WHERE room_id = ? ORDER BY who', room.id).length).toBe(2);
    // Attendees can't ask for it.
    expect(await h.hub.onMessage('p1', { t: 'e2_hot_get' }, T0)).toBe('forbidden');
  });
  it('pushes the Sprint card to one person: a new card for them, then added to that card, never taking anyone else’s down', async () => {
    const room = await liveRoom();
    const st = roomState(room.id);
    join(st, HOST, T0); join(st, att('p1', 'Sam'), T0); join(st, att('p2', 'Ann'), T0); join(st, att('p3', 'Bo'), T0);
    const h = hubFor(st);
    expect(await h.hub.onMessage('p1', { t: 'e2_push', kind: 'sprint', id: 'p2' }, T0)).toBe('forbidden');
    expect(await h.hub.onMessage('h1', { t: 'e2_push', kind: 'sprint', id: 'p1' }, T0)).toBeNull();
    const next = h.hub.takePending()!;
    expect(next).toEqual({ t: 'push', kind: 'sprint', to: ['p1'] });
    const r = apply(st, 'h1', next, T0);
    expect(r.ok).toBe(true);
    x("INSERT INTO room_pushes (room_id, id, kind, targets, target_count, created_at) VALUES (?, 1, 'sprint', '[\"p1\"]', 1, ?)", room.id, T0);
    expect(await h.hub.onMessage('h1', { t: 'e2_push', kind: 'sprint', id: 'p1' }, T0)).toBe('already_open');
    expect(await h.hub.onMessage('h1', { t: 'e2_push', kind: 'sprint', id: 'p2' }, T0)).toBeNull();
    expect(h.hub.takePending()).toBeNull();
    expect(st.eng!.pushes.filter((p) => p.open)).toHaveLength(1);
    expect(st.eng!.pushes[0].to).toEqual(['p1', 'p2']);
    expect(JSON.parse(q<{ targets: string }>('SELECT targets FROM room_pushes WHERE room_id = ? AND id = 1', room.id)[0].targets)).toEqual(['p1', 'p2']);
    expect(h.commits()).toBe(1);
    // A card for everyone already reaches them.
    apply(st, 'h1', { t: 'push', kind: 'application' }, T0);
    expect(await h.hub.onMessage('h1', { t: 'e2_push', kind: 'application', id: 'p3' }, T0)).toBe('already_open');
    expect(await h.hub.onMessage('h1', { t: 'e2_push', kind: 'sprint', id: 'h1' }, T0)).toBe('not_in_room');
  });
});

describe('the live-only bonus in the room and on the purchase', () => {
  it('the host sets it before going live (copy rules apply); it can’t be changed once live, and once withdrawn it stays off', async () => {
    const room = await liveRoom();
    const st = roomState(room.id, false);
    join(st, HOST, T0); join(st, att('p1', 'Sam', 'l1'), T0);
    const h = hubFor(st);
    expect(await h.hub.onMessage('p1', { t: 'e2_bonus_set', text: 'A lender pack review with the team' }, T0)).toBe('forbidden');
    expect(await h.hub.onMessage('h1', { t: 'e2_bonus_set', text: 'Huge bonus, act now!!' }, T0)).toBe('bonus_copy');
    expect(await h.hub.onMessage('h1', { t: 'e2_bonus_set', text: 'A lender pack review with the team', asset: 'calculator', until: 'offer' }, T0)).toBeNull();
    const toP1 = h.of('e2_bonus').filter((s) => s.to === 'p1').pop()!.msg.bonus as Record<string, unknown>;
    expect(toP1).toMatchObject({ live: true, text: 'A lender pack review with the team', asset: 'The 1.5x deal calculator' });
    expect(toP1.assetId).toBeUndefined(); // the settings are for staff
    st.status = 'live';
    expect(await h.hub.onMessage('h1', { t: 'e2_bonus_set', text: 'A different bonus for the room' }, T0)).toBe('bonus_live');
    expect(await h.hub.onMessage('h1', { t: 'e2_bonus_withdraw' }, T0 + MIN)).toBeNull();
    expect((await getBonus(rt, room.id))).toMatchObject({ withdrawnAt: T0 + MIN, withdrawnReason: 'host' });
    st.status = 'lobby';
    expect(await h.hub.onMessage('h1', { t: 'e2_bonus_set', text: 'A lender pack review with the team' }, T0 + 2 * MIN)).toBe('bonus_withdrawn');
  });
  it('withdraws an offer-mode bonus when the host closes the offer, and an end-mode bonus at the end', async () => {
    const room = await liveRoom();
    const st = roomState(room.id);
    st.offer = { available: true, open: true, closesAt: T0 + 60 * MIN, label: '$5,000' };
    join(st, att('p1', 'Sam'), T0);
    const h = hubFor(st);
    await setBonus(rt, room.id, { text: 'A lender pack review with the team', asset: null, until: 'offer' }, { by: 'h1', live: false }, T0 - 20 * MIN);
    await h.hub.tick(T0);
    expect((await getBonus(rt, room.id))!.withdrawnAt).toBeNull();
    st.offer = { available: true, open: false, closesAt: T0 + 5 * MIN, label: '$5,000' }; // closed early by the host
    await h.hub.onOffer(T0 + 5 * MIN);
    expect(await getBonus(rt, room.id)).toMatchObject({ withdrawnAt: T0 + 5 * MIN, withdrawnReason: 'offer_closed' });
    expect((h.of('e2_bonus').pop()!.msg.bonus as { live: boolean }).live).toBe(false);

    const room2 = await liveRoom();
    const st2 = roomState(room2.id);
    const h2 = hubFor(st2);
    await setBonus(rt, room2.id, { text: 'A lender pack review with the team', asset: null, until: 'end' }, { by: 'h1', live: false }, T0 - 20 * MIN);
    st2.status = 'ended'; st2.endedAt = T0 + 30 * MIN;
    await h2.hub.onEnded(T0 + 30 * MIN);
    expect(await getBonus(rt, room2.id)).toMatchObject({ withdrawnAt: T0 + 30 * MIN, withdrawnReason: 'ended' });
  });
  it('records the bonus on purchases made while live (and unlocks its file), never on later ones', async () => {
    const room = await liveRoom();
    seedLead('l1'); seedLead('l2', 'Ann');
    attend(room.id, 'p1', 'l1', 'Sam Lee', 30);
    attend(room.id, 'p2', 'l2', 'Ann Ray', 30);
    await setBonus(rt, room.id, { text: 'A lender pack review with the team', asset: 'checklist', until: 'end' }, { by: 'h1', live: false }, T0 - 20 * MIN);
    pay('wp1', 'l1', 'deposit', T0);
    await onRoomPurchase(rt, { id: 'wp1', kind: 'deposit', lead_id: 'l1', paid_at: T0 });
    expect(q('SELECT room_id, pass_id, lead_id, kind, text, asset FROM room_bonus_grants')).toEqual([{ room_id: room.id, pass_id: 'wp1', lead_id: 'l1', kind: 'deposit', text: 'A lender pack review with the team', asset: 'checklist' }]);
    expect(q("SELECT who, asset, source FROM room_unlocks WHERE room_id = ?", room.id)).toEqual([{ who: 'p1', asset: 'checklist', source: 'bonus' }]);
    expect(await grantLiveBonus(rt, { id: 'wp1', kind: 'deposit', lead_id: 'l1', paid_at: T0 })).toEqual([]); // once
    // The session ended (Funnel HQ, nobody in the room): the withdrawal is settled at the real end time.
    x("UPDATE rooms SET status = 'ended', ended_at = ? WHERE id = ?", T0 + 10 * MIN, room.id);
    vi.setSystemTime(T0 + 60 * MIN);
    pay('wp2', 'l2', 'offer', T0 + 40 * MIN);
    expect(await grantLiveBonus(rt, { id: 'wp2', kind: 'offer', lead_id: 'l2', paid_at: T0 + 40 * MIN, source: 'room', ref_id: room.id }, T0 + 60 * MIN)).toEqual([]);
    expect(await getBonus(rt, room.id)).toMatchObject({ withdrawnAt: T0 + 10 * MIN, withdrawnReason: 'ended' });
    expect(q('SELECT pass_id FROM room_bonus_grants')).toHaveLength(1);
    // Settling again changes nothing.
    await settleBonus(rt, (await getRoom(rt, room.id))!, T0 + 90 * MIN);
    await withdrawBonus(rt, room.id, 'host', T0 + 90 * MIN);
    expect(await getBonus(rt, room.id)).toMatchObject({ withdrawnAt: T0 + 10 * MIN });
  });
});

describe('after the session: one Command proposal, approval required, nothing sent', () => {
  async function scored() {
    const room = await liveRoom();
    for (let i = 1; i <= 15; i++) { seedLead(`l${i}`, `P${i}`); attend(room.id, `p${i}`, `l${i}`, `P${i} Lee`, 4 * i); }
    for (let i = 1; i <= 15; i++) for (let k = 1; k <= Math.min(4, Math.floor(i / 3)); k++) point(room.id, `p${i}`, 'plan_step', `s${k}`, 10);
    x("INSERT INTO room_checkouts (room_id, who, kind, lead_id, started_at) VALUES (?, 'p2', 'deposit', 'l2', ?)", room.id, T0);
    pay('wp15', 'l15', 'deposit', T0); // the top scorer bought
    const people = await roomScores(rt, room.id, emptyBits());
    await saveScores(rt, room.id, people, T0);
    return room;
  }
  it('lists the hottest attendees who didn’t buy, once per room; approving adds notes and sends nothing', async () => {
    const room = await scored();
    const r = await proposeHotFollowup(makeRt({ ROOM_HOT_MIN: '20', ROOM_HOT_FOLLOWUP_N: '5' }), room.id, T0);
    // Ranked by score plus 20 per buying signal: l2 started a checkout (score 16, ranks 36), then the highest scores.
    expect(r!.leads.map((l) => l.lead_id)).toEqual(['l2', 'l14', 'l13', 'l12', 'l11']);
    expect(r!.leads.some((l) => l.lead_id === 'l15')).toBe(false);
    expect(r!.leads.some((l) => l.lead_id === 'l2')).toBe(true); // a checkout started puts them on the list whatever the score
    expect(r!.leads).toHaveLength(5);
    const action = q<{ id: string; kind: string; status: string; dept: string; summary: string }>('SELECT id, kind, status, dept, summary FROM ops_actions')[0];
    expect(action).toMatchObject({ kind: HOT_FOLLOWUP_KIND, status: 'proposed', dept: 'sales' });
    expect(action.summary).toContain('hottest attendees who didn');
    expect(await proposeHotFollowup(rt, room.id, T0)).toBeNull(); // once
    // Someone bought between the proposal and the approval: skipped.
    pay('wp2', 'l2', 'deposit', T0 + MIN);
    const done = await approveAction(rt, action.id);
    expect(done.ok).toBe(true);
    expect(done.summary).toContain('Nothing was sent');
    expect(q<{ notes: string | null }>("SELECT notes FROM leads WHERE id = 'l14'")[0].notes).toContain('Hot list');
    expect(q<{ notes: string | null }>("SELECT notes FROM leads WHERE id = 'l2'")[0].notes).toBeNull();
    expect(q('SELECT 1 FROM emails')).toHaveLength(0);
    expect(q('SELECT 1 FROM sms_messages')).toHaveLength(0);
  });
  it('ROOM_HOT_FOLLOWUP=off: no proposal', async () => {
    const room = await scored();
    expect(await proposeHotFollowup(makeRt({ ROOM_HOT_FOLLOWUP: 'off' }), room.id, T0)).toBeNull();
    expect(q('SELECT 1 FROM ops_actions')).toHaveLength(0);
  });
});
