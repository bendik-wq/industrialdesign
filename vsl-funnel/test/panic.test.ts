import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv, Runtime } from '../src/app';
import { auditCopy } from '../src/content/copy-rules';
import { type Identity, type RoomState, apply, join, newEngage, newRoomState } from '../src/rooms/state';
import { createRoom, ensureRoomFor, getRoom, listRooms, makeInvite, makeTicket, readInvite, readTicket, roomForRef, roomReport } from '../src/rooms/rooms';
import { saveEvent } from '../src/live/events';
import { SETTINGS as SETTING_DEFS } from '../src/settings';
import {
  PANIC_COPY, PANIC_GAP_MS, PanicHub, chainReport, isSnapshot, latestOf, logMove, mayPanic, moveRoom, moveUrlFor, movedJoinUrl, movedRedirect, panicPageCfg, panicRoute,
  panicSettings, passIdentity, readPass, rootOf, seedState, snapshotOf, waitLeft, zoomUrlFor,
} from '../src/rooms/panic';

// The admin session: a header in these tests (the real check is the signed cookie, covered by the auth tests).
vi.mock('../src/admin/auth', async (orig) => ({ ...(await orig<typeof import('../src/admin/auth')>()), isAdmin: async (c: { req: { header(n: string): string | undefined } }) => c.req.header('x-test-admin') === '1' }));

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
const makeRt = () => ({ env: { DB: d1(db), SESSION_SECRET: 'test-session-secret' }, settings: { ...ALL(), SITE_NAME: 'G&L' }, reps: [], origin: 'https://apply.test', waitUntil: () => {} }) as unknown as Runtime;
const q = <T = Record<string, unknown>>(sql: string, ...a: unknown[]) => db.prepare(sql).all(...(a as (string | number | null)[])) as T[];
const x = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...(a.map((v) => (v === undefined ? null : v)) as (string | number | null)[]));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  db = freshDb();
  rt = makeRt();
});
afterEach(() => { vi.useRealTimers(); });

function seedLead(id: string, first = 'Sam') {
  x(`INSERT INTO leads (id, ref_code, created_at, updated_at, visitor_id, first_name, last_name, email, status, revenue_band, country)
     VALUES (?, ?, ?, ?, ?, ?, 'Lee', ?, 'partial', '3m-10m', 'AU')`, id, `R${id}`, T0 - DAY, T0 - DAY, `v${id}`, first, `${id}@example.com`);
}
/** A live event in our room, live now, with settings on its row and one registration. */
async function liveEventRoom(o: { joinUrl?: string } = {}) {
  const s = await saveEvent(rt, { title: 'Buy your first competitor', starts_at: T0 - 20 * MIN, tz: 'UTC', duration_min: 120, platform: 'room', ...(o.joinUrl ? { join_url: o.joinUrl } : {}) }) as { id: string };
  const room = (await ensureRoomFor(rt, 'live', s.id, { title: 'Buy your first competitor', startsAt: T0 - 20 * MIN, durationMin: 120 }))!;
  x("UPDATE rooms SET status = 'live', went_live_at = ?, broadcast = 'sfu', engage = ?, studio = ?, panic = ? WHERE id = ?", T0 - 15 * MIN,
    JSON.stringify({ agenda: 'One\nTwo\nThree', board: true, autoPush: '35 application', priceHold: 15, ga: { on: true, v: 2, cohostV: 3 } }), JSON.stringify({ brand: 'navy' }), JSON.stringify({ cohost: false }), room.id);
  seedLead('l1', 'Ann');
  x("INSERT INTO live_webinar_regs (id, token, event_id, lead_id, revenue_band, joined_at, created_at) VALUES ('reg1', 'tok1', ?, 'l1', '3m-10m', ?, ?)", s.id, T0 - 10 * MIN, T0 - DAY);
  return { eventId: s.id, room: (await getRoom(rt, room.id))! };
}

const host: Identity = { id: 'hadmin', name: 'Josh', role: 'host' };
const ann: Identity = { id: 'rreg1', name: 'Ann Lee', role: 'attendee', leadId: 'l1', regId: 'reg1' };
const ga: Identity = { id: 'gxyz123', name: 'Pat', role: 'attendee', leadId: null, regId: null };
const co: Identity = { id: 'gco1', name: 'Kim', role: 'cohost', leadId: null, regId: null };

function liveState(id: string) {
  const st = newRoomState({ id, mode: 'webinar', title: 'Live', startsAt: T0, offerAvailable: true });
  st.eng = newEngage();
  for (const w of [host, ann, ga, co]) join(st, w, T0 - 10 * MIN);
  st.status = 'live'; st.wentLiveAt = T0 - 15 * MIN;
  return st;
}

// ───────────── permissions ─────────────

describe('who may press it', () => {
  it('the host on an admin session; a co-host only when allowed; the co-host switch is the host’s alone', () => {
    expect(mayPanic({ role: 'host', admin: true, cohostAllowed: false, target: 'room' })).toBe(true);
    expect(mayPanic({ role: 'host', admin: false, cohostAllowed: true, target: 'room' })).toBe(false);
    expect(mayPanic({ role: 'cohost', admin: false, cohostAllowed: false, target: 'room' })).toBe(false);
    expect(mayPanic({ role: 'cohost', admin: false, cohostAllowed: true, target: 'room' })).toBe(true);
    expect(mayPanic({ role: 'cohost', admin: false, cohostAllowed: true, target: 'zoom' })).toBe(true);
    expect(mayPanic({ role: 'cohost', admin: false, cohostAllowed: true, target: 'cohost' })).toBe(false);
    expect(mayPanic({ role: 'attendee', admin: true, cohostAllowed: true, target: 'room' })).toBe(false);
    expect(mayPanic({ role: 'guest', admin: false, cohostAllowed: true, target: 'zoom' })).toBe(false);
    expect(panicSettings({ panic: '{"cohost":true}' })).toEqual({ cohost: true });
    expect(panicSettings({ panic: 'nonsense' })).toEqual({ cohost: false });
    expect(panicSettings({ panic: null })).toEqual({ cohost: false });
  });
});

// ───────────── the move plan (D1) ─────────────

describe('moving the room', () => {
  it('makes a new room with the same settings, hands it the event link and marks the old one moved', async () => {
    const { eventId, room } = await liveEventRoom();
    const r = await moveRoom(rt, room, T0);
    expect(r.ok).toBe(true);
    const to = (r as { to: Awaited<ReturnType<typeof getRoom>> }).to!;
    expect(to.id).not.toBe(room.id);
    expect(to).toMatchObject({ mode: 'webinar', title: room.title, ref_type: 'live', ref_id: eventId, status: 'live', went_live_at: T0 - 15 * MIN, broadcast: 'sfu', engage: room.engage, studio: room.studio, panic: room.panic, moved_from: room.id, starts_at: room.starts_at, duration_min: 120 });
    const old = (await getRoom(rt, room.id))!;
    expect(old).toMatchObject({ moved_to: to.id, moved_at: T0, ref_type: 'none', ref_id: eventId, status: 'ended', summary_at: T0 });
    // Every existing link resolves to the new room from now on.
    expect((await roomForRef(rt, 'live', eventId))!.id).toBe(to.id);
    expect((await ensureRoomFor(rt, 'live', eventId, { title: room.title, startsAt: room.starts_at!, durationMin: 120 })).id).toBe(to.id);
    // A second press (or a racing one) on the old room makes nothing.
    expect(await moveRoom(rt, old, T0 + 1000)).toEqual({ ok: false, error: 'already_moved' });
    expect(q('SELECT COUNT(*) AS n FROM rooms')[0]).toEqual({ n: 2 });
    // The chain.
    expect(await rootOf(rt, to.id)).toBe(room.id);
    expect((await latestOf(rt, old)).id).toBe(to.id);
  });

  it('refuses an ended or cancelled room', async () => {
    const room = await createRoom(rt, { mode: 'meeting', title: 'Kickoff', refType: 'none' });
    x("UPDATE rooms SET status = 'ended' WHERE id = ?", room.id);
    expect(await moveRoom(rt, (await getRoom(rt, room.id))!, T0)).toEqual({ ok: false, error: 'ended' });
  });

  it('copies the room’s own rows: open cards with their holds, the live bonus, unlocks, Deal Plans, consent, checkouts', async () => {
    const { room } = await liveEventRoom();
    x("INSERT INTO room_pushes (room_id, id, kind, ref, targets, target_count, created_by, created_at, closed_at, hold_until) VALUES (?, 3, 'sprint', NULL, NULL, 12, 'hadmin', ?, NULL, ?)", room.id, T0 - 5 * MIN, T0 + 10 * MIN);
    x("INSERT INTO room_pushes (room_id, id, kind, ref, targets, target_count, created_by, created_at, closed_at) VALUES (?, 2, 'application', NULL, NULL, 12, 'hadmin', ?, ?)", room.id, T0 - 9 * MIN, T0 - 6 * MIN);
    x("INSERT INTO room_live_bonus (room_id, text, asset, until, on_at, updated_at) VALUES (?, 'The buy box template', NULL, 'offer', ?, ?)", room.id, T0 - 5 * MIN, T0 - 5 * MIN);
    x("INSERT INTO room_unlocks (room_id, who, asset, source, lead_id, at) VALUES (?, 'rreg1', 'scripts', 'points', 'l1', ?)", room.id, T0 - 4 * MIN);
    x("INSERT INTO room_plans (room_id, who, lead_id, reg_id, data, steps, created_at, updated_at) VALUES (?, 'rreg1', 'l1', 'reg1', '{\"industry\":\"dental\"}', '[\"box\"]', ?, ?)", room.id, T0 - 4 * MIN, T0 - 4 * MIN);
    x("INSERT INTO room_proof_consent (room_id, who, lead_id, first_name, consent_at) VALUES (?, 'rreg1', 'l1', 'Ann', ?)", room.id, T0 - 3 * MIN);
    x("INSERT INTO room_checkouts (room_id, who, kind, lead_id, started_at, nudged_at) VALUES (?, 'rreg1', 'deposit', 'l1', ?, ?)", room.id, T0 - 3 * MIN, T0 - 2 * MIN);
    const to = ((await moveRoom(rt, room, T0)) as { to: { id: string } }).to;
    expect(q('SELECT id, kind, hold_until, closed_at FROM room_pushes WHERE room_id = ?', to.id)).toEqual([{ id: 3, kind: 'sprint', hold_until: T0 + 10 * MIN, closed_at: null }]);
    expect(q('SELECT text FROM room_live_bonus WHERE room_id = ?', to.id)).toEqual([{ text: 'The buy box template' }]);
    expect(q('SELECT who, asset FROM room_unlocks WHERE room_id = ?', to.id)).toEqual([{ who: 'rreg1', asset: 'scripts' }]);
    expect(q('SELECT data FROM room_plans WHERE room_id = ?', to.id)).toEqual([{ data: '{"industry":"dental"}' }]);
    expect(q('SELECT first_name FROM room_proof_consent WHERE room_id = ?', to.id)).toEqual([{ first_name: 'Ann' }]);
    expect(q('SELECT nudged_at FROM room_checkouts WHERE room_id = ?', to.id)).toEqual([{ nudged_at: T0 - 2 * MIN }]);
    // The old rows stay (links already sent keep working).
    expect(q('SELECT COUNT(*) AS n FROM room_pushes WHERE room_id = ?', room.id)[0]).toEqual({ n: 2 });
  });

  it('never touches payments: purchases and the offer live on the event and the registration', async () => {
    const { eventId, room } = await liveEventRoom();
    const before = q('SELECT * FROM live_webinars WHERE id = ?', eventId);
    const regs = q('SELECT * FROM live_webinar_regs');
    await moveRoom(rt, room, T0);
    expect(q('SELECT * FROM live_webinars WHERE id = ?', eventId)).toEqual(before);
    expect(q('SELECT * FROM live_webinar_regs')).toEqual(regs);
  });

  it('one action per two minutes per chain; refused and done actions are logged', async () => {
    const { room } = await liveEventRoom();
    expect(await waitLeft(rt, room.id, T0)).toBe(0);
    await logMove(rt, { root: room.id, from: room.id, target: 'room', ok: true, by: host }, T0);
    expect(await waitLeft(rt, room.id, T0 + 30_000)).toBe(PANIC_GAP_MS - 30_000);
    expect(await waitLeft(rt, room.id, T0 + PANIC_GAP_MS)).toBe(0);
    // Refused attempts and the co-host switch don't count.
    await logMove(rt, { root: room.id, from: room.id, target: 'cohost', ok: true, by: host }, T0 + PANIC_GAP_MS);
    await logMove(rt, { root: room.id, from: room.id, target: 'room', ok: false, error: 'forbidden', by: co }, T0 + PANIC_GAP_MS);
    expect(await waitLeft(rt, room.id, T0 + PANIC_GAP_MS + 1)).toBe(0);
    expect(q('SELECT target, ok, error, by_role FROM room_moves ORDER BY at, target')).toEqual([
      { target: 'room', ok: 1, error: null, by_role: 'host' }, { target: 'cohost', ok: 1, error: null, by_role: 'host' }, { target: 'room', ok: 0, error: 'forbidden', by_role: 'cohost' },
    ]);
  });

  it('the Zoom link: a live event’s join_url or that challenge day’s, https only', async () => {
    const { room } = await liveEventRoom({ joinUrl: 'https://zoom.us/j/123' });
    expect(await zoomUrlFor(rt, room)).toBe('https://zoom.us/j/123');
    expect(await zoomUrlFor(rt, { ref_type: 'none', ref_id: null })).toBeNull();
    x("INSERT INTO challenge_days (cohort_id, day, starts_at, duration_min, join_url, updated_at) VALUES ('c1', 2, ?, 90, 'https://zoom.us/j/9', ?)", T0, T0);
    expect(await zoomUrlFor(rt, { ref_type: 'challenge', ref_id: 'challenge:c1:2' })).toBe('https://zoom.us/j/9');
    expect(await zoomUrlFor(rt, { ref_type: 'challenge', ref_id: 'challenge:c1:3' })).toBeNull();
  });
});

// ───────────── the session's state ─────────────

describe('what moves with the session', () => {
  it('carries chat (and an older pinned message), questions, polls, the chapter, open cards, points and the push schedule’s history', () => {
    const st = liveState('rmold00000001');
    for (let i = 0; i < 130; i++) expect(apply(st, i === 0 ? 'hadmin' : 'rreg1', { t: 'chat', text: `message ${i}` }, T0 - 5 * MIN + i * 1000).ok).toBe(true);
    const first = st.chat.msgs[0];
    st.chat.pinned = first.id;
    st.qa.push({ id: 1, by: 'rreg1', name: 'Ann', text: 'How do lenders look at the cash flow?', at: T0, votes: ['gxyz123'], answered: false }); st.qaSeq = 1;
    const e = st.eng!;
    e.chapter = 2; e.board = true; e.optIn = ['rreg1']; e.pts = { rreg1: 40 }; e.unlocks = { rreg1: ['scripts'] }; e.mins = { rreg1: 12 };
    e.pushes = [{ id: 1, kind: 'application', ref: null, to: null, at: T0 - 9 * MIN, open: false, by: 'hadmin' }, { id: 2, kind: 'sprint', ref: null, to: null, at: T0 - 2 * MIN, open: true, by: 'hadmin' }];
    e.pushSeq = 2; e.autoDone = [{ id: '35:application', how: 'auto', at: T0 - 9 * MIN }];
    st.timer = { endsAt: T0 + 10 * MIN, label: 'Break' };
    const snap = snapshotOf(st, T0);
    expect(isSnapshot(JSON.parse(JSON.stringify(snap)))).toBe(true);
    expect(isSnapshot({ v: 2 })).toBe(false);
    expect(snap.chat.msgs.length).toBe(101); // the last 100 plus the pinned one
    expect(snap.eng!.pushes.map((p) => p.id)).toEqual([2]);

    const fresh = newRoomState({ id: 'rmnew00000001', mode: 'webinar', title: 'Live', startsAt: T0, offerAvailable: true });
    fresh.eng = newEngage();
    fresh.eng.agenda = [{ title: 'One', teaser: '' }, { title: 'Two', teaser: '' }, { title: 'Three', teaser: '' }] as never;
    expect(seedState(fresh, JSON.parse(JSON.stringify(snap)), T0)).toBe(true);
    expect(fresh.status).toBe('live');
    expect(fresh.wentLiveAt).toBe(T0 - 15 * MIN);
    expect(fresh.chat.pinned).toBe(first.id);
    expect(fresh.chat.msgs.length).toBe(101);
    expect(fresh.chat.seq).toBe(st.chat.seq);
    expect(fresh.qa[0].text).toMatch(/lenders/);
    expect(fresh.eng.chapter).toBe(2);
    expect(fresh.eng.board).toBe(true);
    expect(fresh.eng.pts).toEqual({ rreg1: 40 });
    expect(fresh.eng.pushes.map((p) => p.id)).toEqual([2]);
    expect(fresh.eng.pushSeq).toBe(2);
    expect(fresh.eng.autoDone).toEqual([{ id: '35:application', how: 'auto', at: T0 - 9 * MIN }]);
    expect(fresh.timer).toEqual({ endsAt: T0 + 10 * MIN, label: 'Break' });
    // Once only.
    expect(seedState(fresh, JSON.parse(JSON.stringify(snap)), T0 + 1000)).toBe(false);
    expect(fresh.chat.msgs.length).toBe(101);
    // A new chat message continues the numbering.
    join(fresh, ann, T0);
    apply(fresh, 'rreg1', { t: 'chat', text: 'still here' }, T0 + 5000);
    expect(fresh.chat.msgs[fresh.chat.msgs.length - 1].id).toBe(st.chat.seq + 1);
  });
});

// ───────────── identity: passes for the new room ─────────────

describe('re-signed identity', () => {
  it('a pass keeps the role, lead, registration and (for general admission) the same id and name; the host goes to the admin room', async () => {
    const url = await moveUrlFor(rt, 'rmnew00000001', ann, T0);
    const pass = new URL(url).searchParams.get('mv')!;
    expect(url.startsWith('https://apply.test/rooms/rmnew00000001?mv=')).toBe(true);
    expect(await readPass(rt, pass, 'rmnew00000001', T0)).toMatchObject({ p: 'rreg1', role: 'attendee', lead: 'l1', reg: 'reg1', n: 'Ann Lee' });
    expect(await readPass(rt, pass, 'rmother000001', T0)).toBeNull();
    const gaPass = new URL(await moveUrlFor(rt, 'rmnew00000001', ga, T0)).searchParams.get('mv')!;
    expect(await readPass(rt, gaPass, 'rmnew00000001', T0)).toMatchObject({ p: 'gxyz123', n: 'Pat', role: 'attendee', lead: null, reg: null });
    const coPass = new URL(await moveUrlFor(rt, 'rmnew00000001', co, T0)).searchParams.get('mv')!;
    expect(await readPass(rt, coPass, 'rmnew00000001', T0)).toMatchObject({ role: 'cohost', p: 'gco1' });
    expect(await moveUrlFor(rt, 'rmnew00000001', host, T0)).toBe('https://apply.test/admin/rooms/rmnew00000001');
    // A host ticket is never a pass.
    expect(await readPass(rt, await makeTicket(rt, 'rmnew00000001', host), 'rmnew00000001', T0)).toBeNull();
    // A pass runs out like a page ticket.
    expect(await readPass(rt, pass, 'rmnew00000001', T0 + 13 * 3600_000)).toBeNull();
  });

  it('the pass page gives a registered attendee their own offer panel (the deposit by their registration token)', async () => {
    const { room } = await liveEventRoom();
    const to = ((await moveRoom(rt, room, T0)) as { to: NonNullable<Awaited<ReturnType<typeof getRoom>>> }).to;
    const pass = new URL(await moveUrlFor(rt, to.id, ann, T0)).searchParams.get('mv')!;
    const x1 = (await passIdentity(rt, to, pass, T0))!;
    expect(x1.who).toMatchObject({ id: 'rreg1', role: 'attendee', leadId: 'l1', regId: 'reg1' });
    expect(x1.offer).toMatchObject({ leadId: 'l1', buy: '/api/live/deposit', token: 'tok1' });
    const gaPass = new URL(await moveUrlFor(rt, to.id, ga, T0)).searchParams.get('mv')!;
    expect((await passIdentity(rt, to, gaPass, T0))!.offer).toBeNull();
    // Someone else's registration id in a forged identity gets no offer (the lead must match).
    const forged = new URL(await moveUrlFor(rt, to.id, { ...ann, leadId: 'l9' }, T0)).searchParams.get('mv')!;
    expect((await passIdentity(rt, to, forged, T0))!.offer).toBeNull();
    expect(await passIdentity(rt, to, 'junk', T0)).toBeNull();
  });
});

// ───────────── late arrivals ─────────────

describe('redirects for late arrivals', () => {
  it('re-signs invites, passes challenge tokens through, sends admins to the new host room, and follows a chain of moves', async () => {
    const { room } = await liveEventRoom();
    const gaInv = await makeInvite(rt, room.id, 'guest', null, DAY, T0, { n: 'Pat' });
    const coInv = await makeInvite(rt, room.id, 'cohost', null, DAY, T0, { v: 3 });
    const staleCo = await makeInvite(rt, room.id, 'cohost', null, DAY, T0, { v: 1 });
    const pass = new URL(await moveUrlFor(rt, room.id, ann, T0)).searchParams.get('mv')!;
    expect(await movedRedirect(rt, room, { i: gaInv })).toBeNull(); // not moved yet
    const m1 = (await moveRoom(rt, room, T0)) as { to: NonNullable<Awaited<ReturnType<typeof getRoom>>> };
    const m2 = (await moveRoom(rt, m1.to, T0 + 3 * MIN)) as { to: NonNullable<Awaited<ReturnType<typeof getRoom>>> };
    const old = (await getRoom(rt, room.id))!;
    const last = m2.to.id;

    const g = new URL((await movedRedirect(rt, old, { i: gaInv }, T0 + 4 * MIN))!);
    expect(g.pathname).toBe(`/rooms/${last}`);
    expect(await readInvite(rt, g.searchParams.get('i'), last, T0 + 4 * MIN)).toMatchObject({ role: 'guest', lead: null, n: 'Pat' });
    const c = new URL((await movedRedirect(rt, old, { i: coInv }, T0 + 4 * MIN))!);
    expect(await readInvite(rt, c.searchParams.get('i'), last, T0 + 4 * MIN)).toMatchObject({ role: 'cohost', v: 3 });
    expect(await movedRedirect(rt, old, { i: staleCo }, T0 + 4 * MIN)).toBeNull(); // a rotated co-host link stays dead
    expect(await movedRedirect(rt, old, { c: 'chtok' })).toBe(`https://apply.test/rooms/${last}?c=chtok`);
    const p = new URL((await movedRedirect(rt, old, { mv: pass }, T0 + 4 * MIN))!);
    expect(await readTicket(rt, p.searchParams.get('mv'), last, T0 + 4 * MIN)).toMatchObject({ p: 'rreg1', reg: 'reg1' });
    expect(await movedRedirect(rt, old, { admin: true })).toBe(`https://apply.test/admin/rooms/${last}`);
    expect(await movedRedirect(rt, old, {})).toBeNull();
    // The general admission link: the new room's (the admission settings moved with the row), UTMs kept.
    const j = new URL((await movedJoinUrl(rt, old, 'https://apply.test/rooms/x/join/abc?utm_source=ig'))!);
    expect(j.pathname.startsWith(`/rooms/${last}/join/`)).toBe(true);
    expect(j.searchParams.get('utm_source')).toBe('ig');
  });
});

// ───────────── the button, end to end (Worker route + the rooms' objects) ─────────────

/** Fake Durable Objects: each room's state and its PanicHub, recording what each person was sent. */
function objects() {
  const rooms = new Map<string, { st: RoomState; hub: PanicHub; sent: { to: string; msg: Record<string, unknown> }[]; store: Map<string, unknown> }>();
  const get = (id: string) => {
    let o = rooms.get(id);
    if (!o) {
      const st = newRoomState({ id, mode: 'webinar', title: 'Live', startsAt: T0, offerAvailable: true });
      st.eng = newEngage();
      const sent: { to: string; msg: Record<string, unknown> }[] = [];
      const store = new Map<string, unknown>();
      const hub = new PanicHub({
        st: () => st, deliver: (to, msg) => sent.push({ to, msg }), runtime: async () => rt,
        storage: { get: async (k: string) => store.get(k), put: async (k: string, v: unknown) => { store.set(k, JSON.parse(JSON.stringify(v))); } } as unknown as DurableObjectStorage,
        commit: async () => {},
      });
      o = { st, hub, sent, store };
      rooms.set(id, o);
    }
    return o;
  };
  const stub = (_c: unknown, id: string) => ({ fetch: async (req: Request) => (await get(id).hub.fetch(new URL(req.url).pathname, req, Date.now())) ?? new Response('nf', { status: 404 }) }) as unknown as DurableObjectStub;
  return { get, stub };
}
function button(o: ReturnType<typeof objects>) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => { c.set('settings', rt.settings as never); await next(); });
  app.post('/api/rooms/:id/panic', (c) => panicRoute(c, {
    authed: async (cc, token) => {
      const id = cc.req.param('id') ?? '';
      const t = await readTicket(rt, token, id);
      const room = t ? await getRoom(rt, id) : null;
      return t && room ? { rt, room, t } : null;
    },
    stub: o.stub as never, headersFor: () => ({}), sameOrigin: () => true,
  }));
  return async (roomId: string, who: Identity, body: Record<string, unknown>, admin = false) => {
    const res = await app.request(`/api/rooms/${roomId}/panic`, { method: 'POST', headers: { 'content-type': 'application/json', ...(admin ? { 'x-test-admin': '1' } : {}) }, body: JSON.stringify({ t: await makeTicket(rt, roomId, who), ...body }) }, { DB: rt.env.DB } as never);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
}

describe('the panic button', () => {
  it('moves everyone connected to a fresh room with the session, each with their own pass; the host to the new host room', async () => {
    const { room } = await liveEventRoom();
    const o = objects();
    const old = o.get(room.id);
    Object.assign(old.st, liveState(room.id));
    apply(old.st, 'rreg1', { t: 'chat', text: 'Can I do this with a clinic?' }, T0 - MIN);
    const press = button(o);

    // Not the attendee, not a co-host (not allowed), not the host without an admin session.
    expect((await press(room.id, ann, { target: 'room', confirm: true })).status).toBe(403);
    expect((await press(room.id, co, { target: 'room', confirm: true })).status).toBe(403);
    expect((await press(room.id, host, { target: 'room', confirm: true })).status).toBe(403);
    expect((await press(room.id, host, { target: 'room' }, true)).body).toMatchObject({ ok: false, error: 'confirm' });

    const r = await press(room.id, host, { target: 'room', confirm: true }, true);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, told: 4, seeded: true });
    const to = String(r.body.to);
    expect(r.body.url).toBe(`https://apply.test/admin/rooms/${to}`);
    // The new room's object has the session.
    expect(o.get(to).st.chat.msgs.map((m) => m.text)).toContain('Can I do this with a clinic?');
    expect(o.get(to).st.status).toBe('live');
    // Each connected person heard where to go, with a pass for themselves.
    const moved = old.sent.filter((s) => s.msg.t === 'panic_moved');
    expect(moved.map((s) => s.to).sort()).toEqual(['gco1', 'gxyz123', 'hadmin', 'rreg1']);
    const forAnn = moved.find((s) => s.to === 'rreg1')!.msg;
    expect(forAnn).toMatchObject({ host: false, text: PANIC_COPY.movedNotice, to });
    expect(await readPass(rt, new URL(String(forAnn.url)).searchParams.get('mv'), to)).toMatchObject({ p: 'rreg1', lead: 'l1', reg: 'reg1', role: 'attendee' });
    expect(moved.find((s) => s.to === 'hadmin')!.msg).toMatchObject({ host: true, url: `https://apply.test/admin/rooms/${to}` });
    // Logged.
    expect(q("SELECT target, ok, to_room, told, by_role FROM room_moves WHERE ok = 1")).toEqual([{ target: 'room', ok: 1, to_room: to, told: 4, by_role: 'host' }]);
    expect(q("SELECT COUNT(*) AS n FROM room_moves WHERE ok = 0 AND error = 'forbidden'")[0]).toEqual({ n: 3 });

    // The old room has moved; the new one can't move again within two minutes (the chain counts).
    expect((await press(room.id, host, { target: 'room', confirm: true }, true)).body).toMatchObject({ ok: false, error: 'already_moved', to });
    const again = await press(to, host, { target: 'room', confirm: true }, true);
    expect(again.status).toBe(429);
    expect(again.body).toMatchObject({ error: 'too_soon', wait: 120 });
    vi.setSystemTime(T0 + PANIC_GAP_MS + 1000);
    expect((await press(to, host, { target: 'room', confirm: true }, true)).body).toMatchObject({ ok: true });
  });

  it('the old room’s object can be broken: the move still happens, without the session state', async () => {
    const { room } = await liveEventRoom();
    const o = objects();
    const app = button({ ...o, stub: ((c: unknown, id: string) => (id === room.id ? { fetch: async () => { throw new Error('object broken'); } } : o.stub(c, id))) as never });
    const r = await app(room.id, host, { target: 'room', confirm: true }, true);
    expect(r.body).toMatchObject({ ok: true, told: 0, seeded: false });
    expect((await getRoom(rt, room.id))!.moved_to).toBe(r.body.to);
    expect(q("SELECT detail FROM room_moves WHERE ok = 1")).toEqual([{ detail: 'old room did not answer' }]);
  });

  it('the Zoom fallback: shows everyone the link while the room stays; late joiners see it; hiding it is free', async () => {
    const o = objects();
    const plain = await liveEventRoom();
    const press = button(o);
    expect((await press(plain.room.id, host, { target: 'zoom', confirm: true }, true)).body).toMatchObject({ ok: false, error: 'no_zoom' });
    x("UPDATE live_webinars SET join_url = 'https://zoom.us/j/555' WHERE id = ?", plain.eventId);
    const old = o.get(plain.room.id);
    Object.assign(old.st, liveState(plain.room.id));
    const r = await press(plain.room.id, host, { target: 'zoom', confirm: true }, true);
    expect(r.body).toMatchObject({ ok: true, zoom: true, told: 4 });
    expect(old.sent.filter((s) => s.msg.t === 'panic_zoom')).toEqual([{ to: 'all', msg: { t: 'panic_zoom', url: 'https://zoom.us/j/555', text: PANIC_COPY.zoomCardBody } }]);
    expect((await getRoom(rt, plain.room.id))!.moved_to).toBeNull();
    await old.hub.onJoin(old.st.members.rreg1);
    expect(old.sent[old.sent.length - 1]).toMatchObject({ to: 'rreg1', msg: { t: 'panic_zoom', url: 'https://zoom.us/j/555' } });
    expect((await press(plain.room.id, host, { target: 'zoom_off', confirm: true }, true)).body).toMatchObject({ ok: true, zoom: false });
    expect(old.sent[old.sent.length - 1].msg).toEqual({ t: 'panic_zoom', url: null, text: null });
    // A room move right after the Zoom card waits its two minutes.
    expect((await press(plain.room.id, host, { target: 'room', confirm: true }, true)).status).toBe(429);
  });

  it('co-hosts only when the host allows it; producers get nothing extra', async () => {
    const { room } = await liveEventRoom({ joinUrl: 'https://zoom.us/j/1' });
    const o = objects();
    Object.assign(o.get(room.id).st, liveState(room.id));
    const press = button(o);
    expect((await press(room.id, co, { target: 'cohost', allow: true })).status).toBe(403);
    expect((await press(room.id, co, { target: 'zoom', confirm: true })).status).toBe(403);
    expect((await press(room.id, host, { target: 'cohost', allow: true }, true)).body).toEqual({ ok: true, cohost: true });
    expect(panicSettings((await getRoom(rt, room.id))!)).toEqual({ cohost: true });
    expect((await press(room.id, co, { target: 'zoom', confirm: true })).body).toMatchObject({ ok: true });
    expect((await press(room.id, ann, { target: 'zoom_off', confirm: true })).status).toBe(403);
  });

  it('the room page config: staff who may use it, whether there is a Zoom link, where the room came from', async () => {
    const { room } = await liveEventRoom({ joinUrl: 'https://zoom.us/j/1' });
    expect(await panicPageCfg(rt, room, host)).toMatchObject({ can: true, host: true, cohost: false, zoom: true, movedFrom: null });
    expect(await panicPageCfg(rt, room, co)).toMatchObject({ can: false, zoom: false });
    expect(await panicPageCfg(rt, room, ann)).toMatchObject({ can: false, host: false, zoom: false });
    const to = ((await moveRoom(rt, room, T0)) as { to: NonNullable<Awaited<ReturnType<typeof getRoom>>> }).to;
    expect((await panicPageCfg(rt, to, ann)).movedFrom).toBe(room.id);
  });
});

// ───────────── Funnel HQ and reports ─────────────

describe('Funnel HQ: moved rooms and the chain', () => {
  it('lists where a room moved, and reports attendance across the chain', async () => {
    const { room } = await liveEventRoom();
    x("INSERT INTO room_attendance (room_id, who, lead_id, reg_id, name, role, first_at, last_at, minutes, joins) VALUES (?, 'rreg1', 'l1', 'reg1', 'Ann Lee', 'attendee', ?, ?, 20, 1)", room.id, T0 - 20 * MIN, T0);
    const to = ((await moveRoom(rt, room, T0)) as { to: { id: string } }).to;
    x("INSERT INTO room_attendance (room_id, who, lead_id, reg_id, name, role, first_at, last_at, minutes, joins) VALUES (?, 'rreg1', 'l1', 'reg1', 'Ann Lee', 'attendee', ?, ?, 15, 1)", to.id, T0 + MIN, T0 + 16 * MIN);
    const list = await listRooms(rt);
    expect(list.find((r) => r.id === room.id)).toMatchObject({ moved_to: to.id, moved_to_title: room.title });
    expect(list.find((r) => r.id === to.id)).toMatchObject({ moved_from: room.id, moved_from_title: room.title });
    const rep = await chainReport(rt, to.id);
    expect(rep!.chain.map((c) => c.id)).toEqual([room.id, to.id]);
    expect(rep!.chain.map((c) => c.minutes)).toEqual([20, 15]);
    expect(rep!.attendance).toEqual([expect.objectContaining({ who: 'rreg1', minutes: 35, joins: 2, rooms: 2, first_at: T0 - 20 * MIN, last_at: T0 + 16 * MIN })]);
    const r2 = await roomReport(rt, room.id);
    expect(r2!.chain.map((c) => c.id)).toEqual([room.id, to.id]);
  });
});

describe('copy', () => {
  it('every panic string passes the copy rules', () => {
    const strings: string[] = [];
    for (const v of Object.values(PANIC_COPY)) {
      if (typeof v === 'string') strings.push(v);
      else for (const s of Object.values(v)) strings.push(s.replace('{a}', '30'));
    }
    for (const s of strings) expect(auditCopy(s), s).toEqual([]);
  });
});
