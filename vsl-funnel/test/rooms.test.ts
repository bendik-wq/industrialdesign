import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/app';
import { auditCopy, auditEmail, auditFields } from '../src/content/copy-rules';
import { type Identity, type RoomState, apply, canPublish, canPull, canSeeStage, connectedCount, join, leave, newRoomState, view } from '../src/rooms/state';
import { sfuProxy } from '../src/rooms/proxy';
import { SFU_BASE, mintIceServers, realtimeSetup, sfuCall } from '../src/rooms/sfu';
import { createRoom, ensureRoomFor, feedPresence, getRoom, makeInvite, makeTicket, memberId, readInvite, readTicket, roomOffer, setRoomOffer } from '../src/rooms/rooms';
import { ROOM_COPY, ROOM_GATE, meetingInvite } from '../src/rooms/copy';
import { ROOM_DAY } from '../src/challenge/content';
import { liveEmail, liveText, saveEvent } from '../src/live/events';
import { planWebinarCalls } from '../src/integrations/webinar-calls';
import { SETTINGS as SETTING_DEFS } from '../src/settings';
import { FUNNEL_MAPS } from '../src/admin/funnel-maps-defs';

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
const T0 = Date.parse('2026-11-03T02:00:00Z');
const SECRET = 'sfu-secret-NEVER-LEAK-0123456789';
const TURN_TOKEN = 'turn-token-NEVER-LEAK-abcdef';
const SETTINGS: Record<string, string> = {
  REALTIME_APP_ID: 'app123', REALTIME_APP_SECRET: SECRET, REALTIME_TURN_KEY_ID: 'turnkey1', REALTIME_TURN_TOKEN: TURN_TOKEN,
  SALES_TIMEZONE: 'Australia/Sydney', SITE_NAME: 'G&L', ELEVENLABS_API_KEY: 'sk_test', ELEVENLABS_AGENT_ID: 'agent_main', ELEVENLABS_PHONE_NUMBER_ID: 'ph_1', ELEVENLABS_WEBINAR_AGENT_ID: 'agent_web',
};
let db: DatabaseSync;
let rt: Runtime;
const pending: Promise<unknown>[] = [];
const makeRt = () => ({ env: { DB: d1(db), SESSION_SECRET: 'test-session-secret' }, settings: { ...SETTINGS }, reps: [], origin: 'https://apply.test', waitUntil: (p: Promise<unknown>) => { pending.push(p.catch(() => null)); } }) as unknown as Runtime;
const q = <T = Record<string, unknown>>(sql: string, ...a: unknown[]) => db.prepare(sql).all(...(a as (string | number | null)[])) as T[];
const x = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...(a.map((v) => (v === undefined ? null : v)) as (string | number | null)[]));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  db = freshDb();
  rt = makeRt();
  // Nothing in these tests may reach the network (Meta CAPI etc.) unless a test stubs it.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); pending.length = 0; });

const host: Identity = { id: 'hadmin', name: 'Josh', role: 'host' };
const cohost: Identity = { id: 'gco1', name: 'Mia', role: 'cohost' };
const ann: Identity = { id: 'rann', name: 'Ann B.', role: 'attendee', leadId: 'l1', regId: 'r1' };
const bob: Identity = { id: 'rbob', name: 'Bob C.', role: 'attendee', leadId: 'l2', regId: 'r2' };
function webinar(o: { offer?: boolean } = {}) {
  const st = newRoomState({ id: 'rmtest12345', mode: 'webinar', title: 'Live', startsAt: T0 + 10 * MIN, offerAvailable: o.offer });
  for (const w of [host, cohost, ann, bob]) join(st, w, T0);
  return st;
}
const ok = (st: RoomState, who: string, msg: Record<string, unknown>, t = T0) => { const r = apply(st, who, msg, t); expect(r.error ?? null).toBeNull(); return r; };
const no = (st: RoomState, who: string, msg: Record<string, unknown>, err: string, t = T0) => { const r = apply(st, who, msg, t); expect(r.ok).toBe(false); expect(r.error).toBe(err); return r; };

// ───────────── the room's state machine ─────────────

describe('roles and the stage', () => {
  it('webinar: only hosts publish; the audience sees nothing before Go live and never gets a camera', () => {
    const st = webinar();
    expect(st.status).toBe('lobby');
    expect(canPublish(st, st.members.hadmin)).toBe(true);
    expect(canPublish(st, st.members.gco1)).toBe(true);
    expect(canPublish(st, st.members.rann)).toBe(false);
    expect(canSeeStage(st, st.members.rann)).toBe(false);
    expect(canSeeStage(st, st.members.hadmin)).toBe(true); // backstage
    no(st, 'rann', { t: 'golive' }, 'forbidden');
    const r = ok(st, 'gco1', { t: 'golive' });
    expect(r.effects).toEqual([{ type: 'went_live' }]);
    expect(st.status).toBe('live');
    expect(canSeeStage(st, st.members.rann)).toBe(true);
    expect(view(st, st.members.rann, T0).stage.map((m) => m.id).sort()).toEqual(['gco1', 'hadmin']);
  });

  it('meeting: everyone publishes, no lobby', () => {
    const st = newRoomState({ id: 'rmmeet12345', mode: 'meeting', title: 'Kickoff', startsAt: null });
    join(st, host, T0); join(st, { id: 'lclient', name: 'Client', role: 'guest', leadId: 'l9' }, T0);
    expect(st.status).toBe('live');
    expect(canPublish(st, st.members.lclient)).toBe(true);
    no(st, 'lclient', { t: 'hand', up: true }, 'not_applicable');
  });

  it('raise hand → invite → accept → on stage → back to the audience', () => {
    const st = webinar();
    ok(st, 'hadmin', { t: 'golive' });
    ok(st, 'rann', { t: 'hand', up: true });
    expect(view(st, st.members.hadmin, T0).people!.find((p) => p.id === 'rann')!.hand).toBe(T0);
    expect(view(st, st.members.rann, T0).people).toBeNull(); // the audience never gets the attendee list
    no(st, 'rbob', { t: 'invite', id: 'rann' }, 'forbidden');
    no(st, 'rann', { t: 'accept' }, 'not_invited');
    const inv = ok(st, 'hadmin', { t: 'invite', id: 'rann' });
    expect(inv.out).toEqual([{ to: 'rann', msg: { t: 'invited', by: 'Josh' } }]);
    const acc = ok(st, 'rann', { t: 'accept' });
    expect(acc.effects).toEqual([{ type: 'on_stage', memberId: 'rann' }]);
    expect(st.members.rann.stage).toBe(true);
    expect(st.members.rann.hand).toBeNull();
    expect(canPublish(st, st.members.rann)).toBe(true);
    st.members.rann.sessionId = 'sessAnn00001';
    st.members.rann.tracks = [{ trackName: 'rann-video', kind: 'video', mid: '1' }, { trackName: 'rann-audio', kind: 'audio', mid: '0' }];
    // The third person sees Ann's tracks now.
    expect(canPull(st, 'rbob', { sessionId: 'sessAnn00001', trackName: 'rann-video' })).toBe(true);
    const back = ok(st, 'hadmin', { t: 'unstage', id: 'rann' });
    expect(back.effects).toEqual([{ type: 'close_tracks', memberId: 'rann', sessionId: 'sessAnn00001', mids: ['1', '0'] }]);
    expect(st.members.rann.stage).toBe(false);
    expect(canPublish(st, st.members.rann)).toBe(false);
    expect(canPull(st, 'rbob', { sessionId: 'sessAnn00001', trackName: 'rann-video' })).toBe(false);
  });

  it('host controls: mute, spotlight, layout, remove from room (and no way back in)', () => {
    const st = webinar();
    ok(st, 'hadmin', { t: 'golive' });
    ok(st, 'hadmin', { t: 'invite', id: 'rbob' }); ok(st, 'rbob', { t: 'accept' });
    expect(ok(st, 'hadmin', { t: 'mute', id: 'rbob' }).out[0]).toEqual({ to: 'rbob', msg: { t: 'muted', by: 'Josh' } });
    no(st, 'gco1', { t: 'mute', id: 'hadmin' }, 'forbidden');
    ok(st, 'hadmin', { t: 'spotlight', id: 'rbob' });
    expect(st.spotlight).toBe('rbob');
    no(st, 'hadmin', { t: 'spotlight', id: 'rann' }, 'not_applicable'); // not on stage
    ok(st, 'hadmin', { t: 'layout', layout: 'side' });
    no(st, 'hadmin', { t: 'layout', layout: 'mosaic' }, 'bad_value');
    no(st, 'gco1', { t: 'kick', id: 'hadmin' }, 'forbidden');
    const k = ok(st, 'hadmin', { t: 'kick', id: 'rbob' });
    expect(k.effects.map((e) => e.type)).toEqual(['close_tracks', 'kick']);
    expect(st.spotlight).toBeNull();
    expect(join(st, bob, T0 + MIN)).toEqual({ ok: false, error: 'removed' });
  });

  it('the count is the real number of people connected', () => {
    const st = webinar();
    expect(connectedCount(st)).toBe(4);
    join(st, ann, T0); // a second tab
    expect(connectedCount(st)).toBe(4);
    leave(st, 'rann', T0); expect(connectedCount(st)).toBe(4);
    leave(st, 'rann', T0); expect(connectedCount(st)).toBe(3);
    expect(view(st, st.members.rbob, T0).room.count).toBe(3);
    expect(st.peak).toBe(4);
  });

  it('end: only the host, and everyone is told', () => {
    const st = webinar();
    no(st, 'gco1', { t: 'end' }, 'forbidden');
    const r = ok(st, 'hadmin', { t: 'end' }, T0 + HOUR);
    expect(r.out).toEqual([{ to: 'all', msg: { t: 'ended' } }]);
    expect(r.effects).toEqual([{ type: 'ended' }]);
    expect(join(st, { ...ann, id: 'rnew' }, T0 + HOUR)).toEqual({ ok: false, error: 'ended' });
  });
});

describe('chat, Q&A, polls, offer, timer', () => {
  it('chat: lock and slow mode bind the audience, not the team; pin', () => {
    const st = webinar();
    const c = ok(st, 'rann', { t: 'chat', text: '  Hello <b>team</b>  ' });
    expect(c.out[0].msg).toMatchObject({ t: 'chat', m: { name: 'Ann B.', text: 'Hello <b>team</b>' } }); // stored raw, escaped when drawn
    no(st, 'rann', { t: 'chat', text: 'again' }, 'too_fast', T0 + 300);
    no(st, 'rann', { t: 'chat_lock', on: true }, 'forbidden');
    ok(st, 'hadmin', { t: 'chat_lock', on: true });
    no(st, 'rbob', { t: 'chat', text: 'hi' }, 'chat_locked', T0 + 5000);
    ok(st, 'gco1', { t: 'chat', text: 'Team message' }, T0 + 5000);
    ok(st, 'hadmin', { t: 'chat_lock', on: false });
    ok(st, 'hadmin', { t: 'slow', sec: 30 });
    no(st, 'hadmin', { t: 'slow', sec: 7 }, 'bad_value');
    ok(st, 'rbob', { t: 'chat', text: 'first' }, T0 + 6000);
    no(st, 'rbob', { t: 'chat', text: 'second' }, 'slow_mode', T0 + 20_000);
    ok(st, 'rbob', { t: 'chat', text: 'second' }, T0 + 37_000);
    ok(st, 'hadmin', { t: 'pin', mid: 1 });
    expect(view(st, st.members.rbob, T0).room.chat.pinned).toMatchObject({ id: 1, name: 'Ann B.' });
  });

  it('Q&A: ask, upvote (not your own), answered sorts last', () => {
    const st = webinar();
    ok(st, 'rann', { t: 'ask', text: 'How does seller rollover work?' });
    ok(st, 'rbob', { t: 'ask', text: 'What is the 1.5x test?' });
    no(st, 'rann', { t: 'upvote', qid: 1 }, 'own_question');
    ok(st, 'rann', { t: 'upvote', qid: 2 });
    ok(st, 'gco1', { t: 'upvote', qid: 2 });
    let v = view(st, st.members.rann, T0).qa;
    expect(v.map((x) => [x.id, x.votes, x.voted, x.mine])).toEqual([[2, 2, true, false], [1, 0, false, true]]);
    ok(st, 'rann', { t: 'upvote', qid: 2 }); // toggles off
    no(st, 'rann', { t: 'answer', qid: 2 }, 'forbidden');
    ok(st, 'hadmin', { t: 'answer', qid: 2 });
    v = view(st, st.members.rann, T0).qa;
    expect(v.map((x) => [x.id, x.answered])).toEqual([[1, false], [2, true]]);
  });

  it('polls: host creates, one vote each, results after voting, live counts', () => {
    const st = webinar();
    no(st, 'rann', { t: 'poll_new', question: 'Q?', options: ['a', 'b'] }, 'forbidden');
    no(st, 'hadmin', { t: 'poll_new', question: 'Q?', options: ['only one'] }, 'poll_incomplete');
    ok(st, 'hadmin', { t: 'poll_new', question: 'How will you fund it?', options: ['Seller finance', 'Bank debt', 'Both', ''] });
    expect(view(st, st.members.rann, T0).poll).toMatchObject({ options: ['Seller finance', 'Bank debt', 'Both'], counts: null, mine: null });
    ok(st, 'rann', { t: 'vote', pid: 1, choice: 2 });
    no(st, 'rann', { t: 'vote', pid: 1, choice: 0 }, 'already_voted');
    no(st, 'rbob', { t: 'vote', pid: 1, choice: 9 }, 'bad_value');
    ok(st, 'rbob', { t: 'vote', pid: 1, choice: 2 });
    expect(view(st, st.members.rann, T0).poll).toMatchObject({ mine: 2, counts: [0, 0, 2], total: 2 });
    expect(view(st, st.members.hadmin, T0).poll!.counts).toEqual([0, 0, 2]);
    ok(st, 'hadmin', { t: 'poll_close', pid: 1 });
    no(st, 'gco1', { t: 'vote', pid: 1, choice: 0 }, 'poll_closed');
  });

  it('offer: staff only, only where there is one; the room asks the funnel (an effect), it never opens it alone', () => {
    const plain = webinar();
    no(plain, 'hadmin', { t: 'offer', open: true }, 'no_offer');
    const st = webinar({ offer: true });
    no(st, 'rann', { t: 'offer', open: true }, 'forbidden');
    expect(ok(st, 'hadmin', { t: 'offer', open: true }).effects).toEqual([{ type: 'offer', open: true }]);
    expect(st.offer.open).toBe(false); // set from the database once the funnel accepted it
    expect(ok(st, 'gco1', { t: 'offer', open: false }).effects).toEqual([{ type: 'offer', open: false }]);
  });

  it('timer: from the server clock, staff only, bounded', () => {
    const st = webinar();
    no(st, 'rann', { t: 'timer', sec: 60 }, 'forbidden');
    no(st, 'hadmin', { t: 'timer', sec: 5 }, 'bad_value');
    ok(st, 'hadmin', { t: 'timer', sec: 300, label: 'Break' });
    expect(st.timer).toEqual({ endsAt: T0 + 300_000, label: 'Break' });
    expect(view(st, st.members.rann, T0 + 1000).room.timer).toEqual({ endsAt: T0 + 300_000, label: 'Break' });
    ok(st, 'hadmin', { t: 'timer', sec: null });
    expect(st.timer).toBeNull();
  });
});

// ───────────── tickets and invites ─────────────

describe('room tickets and invite links', () => {
  it('a ticket is bound to one room, one person and one role, and expires', async () => {
    const t = await makeTicket(rt, 'rmroom000001', ann, HOUR);
    expect(await readTicket(rt, t, 'rmroom000001')).toMatchObject({ p: 'rann', role: 'attendee', reg: 'r1', lead: 'l1' });
    expect(await readTicket(rt, t, 'rmroom000002')).toBeNull();
    expect(await readTicket(rt, t, 'rmroom000001', T0 + 2 * HOUR)).toBeNull();
    // Promoting yourself to host by editing the payload breaks the signature.
    const [payload, sig] = [t.slice(0, t.lastIndexOf('.')), t.slice(t.lastIndexOf('.') + 1)];
    const forged = `rt.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload.slice(3), 'base64url').toString()), role: 'host' })).toString('base64url')}.${sig}`;
    expect(await readTicket(rt, forged, 'rmroom000001')).toBeNull();
    expect(await readTicket(rt, 'nonsense', 'rmroom000001')).toBeNull();
  });

  it('invites: co-host and guest links are signed per room', async () => {
    const co = await makeInvite(rt, 'rmroom000001', 'cohost', null, DAY);
    expect(await readInvite(rt, co, 'rmroom000001')).toMatchObject({ role: 'cohost', lead: null });
    expect(await readInvite(rt, co, 'rmroom000009')).toBeNull();
    const g = await makeInvite(rt, 'rmroom000001', 'guest', 'l42');
    expect(await readInvite(rt, g, 'rmroom000001')).toMatchObject({ role: 'guest', lead: 'l42' });
    // A ticket is not an invite and an invite is not a ticket.
    expect(await readTicket(rt, g, 'rmroom000001')).toBeNull();
    expect(await readInvite(rt, await makeTicket(rt, 'rmroom000001', host), 'rmroom000001')).toBeNull();
    expect(memberId('reg', 'lr_abc-123')).toBe('rlrabc123');
  });
});

// ───────────── the SFU proxy and TURN ─────────────

interface Seen { url: string; method: string; auth: string | null; body: unknown }
function stubSfu(reply: (path: string, body: Record<string, unknown> | null) => [number, unknown]) {
  const seen: Seen[] = [];
  const f = vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const body = init.body ? JSON.parse(init.body) as Record<string, unknown> : null;
    seen.push({ url, method: init.method ?? 'GET', auth: init.headers?.authorization ?? null, body });
    const [status, out] = reply(url.replace(`${SFU_BASE}/apps/app123/`, ''), body);
    return new Response(JSON.stringify(out), { status, headers: { 'content-type': 'application/json' } });
  });
  return { f: f as unknown as typeof fetch, seen };
}
const answer = { type: 'answer', sdp: 'v=0\r\nanswer' };
const offer = { type: 'offer', sdp: 'v=0\r\noffer' };

describe('SFU proxy', () => {
  it('creates sessions for their owner and never returns the secret', async () => {
    const st = webinar();
    const { f, seen } = stubSfu(() => [201, { sessionId: 'sessHost0001' }]);
    const r = await sfuProxy(st, 'hadmin', 'session', {}, SETTINGS, f);
    expect(r).toMatchObject({ status: 200, body: { ok: true, sessionId: 'sessHost0001' } });
    expect(st.members.hadmin.sessionId).toBe('sessHost0001');
    expect(seen[0]).toMatchObject({ url: `${SFU_BASE}/apps/app123/sessions/new`, method: 'POST', auth: `Bearer ${SECRET}` });
    expect(JSON.stringify(r.body)).not.toContain(SECRET);
  });

  it('validates session ownership and publish rights; pulls only what is on stage', async () => {
    const st = webinar();
    st.members.hadmin.sessionId = 'sessHost0001';
    st.members.rann.sessionId = 'sessAnn00001';
    const { f, seen } = stubSfu((path) => [200, path.endsWith('tracks/new') ? { tracks: [{ trackName: 'hadmin-video', mid: '1' }, { trackName: 'hadmin-audio', mid: '0' }], sessionDescription: answer, requiresImmediateRenegotiation: false } : {}]);
    // Someone else's session: refused before any SFU call.
    expect((await sfuProxy(st, 'rann', 'tracks', { sessionId: 'sessHost0001', sessionDescription: offer, tracks: [{ location: 'local', mid: '0', trackName: 'rann-audio', media: 'audio' }] }, SETTINGS, f)).status).toBe(403);
    // The audience can't publish.
    expect((await sfuProxy(st, 'rann', 'tracks', { sessionId: 'sessAnn00001', sessionDescription: offer, tracks: [{ location: 'local', mid: '0', trackName: 'rann-audio', media: 'audio' }] }, SETTINGS, f)).status).toBe(403);
    // Track names carry the publisher's id.
    expect((await sfuProxy(st, 'hadmin', 'tracks', { sessionId: 'sessHost0001', sessionDescription: offer, tracks: [{ location: 'local', mid: '0', trackName: 'rann-audio', media: 'audio' }] }, SETTINGS, f)).status).toBe(400);
    expect(seen).toHaveLength(0);
    const pub = await sfuProxy(st, 'hadmin', 'tracks', { sessionId: 'sessHost0001', sessionDescription: offer, tracks: [{ location: 'local', mid: '1', trackName: 'hadmin-video', media: 'video', simulcast: true }, { location: 'local', mid: '0', trackName: 'hadmin-audio', media: 'audio' }] }, SETTINGS, f);
    expect(pub.status).toBe(200);
    expect(seen[0].body).toEqual({ sessionDescription: offer, tracks: [{ location: 'local', mid: '1', trackName: 'hadmin-video' }, { location: 'local', mid: '0', trackName: 'hadmin-audio' }] });
    expect(st.members.hadmin.tracks.map((t) => [t.trackName, t.kind, t.mid])).toEqual([['hadmin-video', 'video', '1'], ['hadmin-audio', 'audio', '0']]);
    // Before Go live the audience can't pull the host.
    const pull = { sessionId: 'sessAnn00001', tracks: [{ location: 'remote', sessionId: 'sessHost0001', trackName: 'hadmin-video', simulcast: { preferredRid: 'q' } }] };
    expect((await sfuProxy(st, 'rann', 'tracks', pull, SETTINGS, f)).status).toBe(403);
    ok(st, 'hadmin', { t: 'golive' });
    expect((await sfuProxy(st, 'rann', 'tracks', pull, SETTINGS, f)).status).toBe(200);
    expect(seen.at(-1)!.body).toEqual({ tracks: [{ location: 'remote', sessionId: 'sessHost0001', trackName: 'hadmin-video', simulcast: { preferredRid: 'q', priorityOrdering: 'asciibetical', ridNotAvailable: 'asciibetical' } }] });
    // A track nobody publishes, or a made-up layer, is refused.
    expect((await sfuProxy(st, 'rann', 'tracks', { sessionId: 'sessAnn00001', tracks: [{ location: 'remote', sessionId: 'sessHost0001', trackName: 'hadmin-screen' }] }, SETTINGS, f)).status).toBe(403);
    expect((await sfuProxy(st, 'rann', 'update', { sessionId: 'sessAnn00001', tracks: [{ location: 'remote', sessionId: 'sessHost0001', trackName: 'hadmin-video', mid: '3', simulcast: { preferredRid: 'z' } }] }, SETTINGS, f)).status).toBe(403);
    expect((await sfuProxy(st, 'rann', 'update', { sessionId: 'sessAnn00001', tracks: [{ location: 'remote', sessionId: 'sessHost0001', trackName: 'hadmin-video', mid: '3', simulcast: { preferredRid: 'f' } }] }, SETTINGS, f)).status).toBe(200);
    expect(seen.every((s) => s.auth === `Bearer ${SECRET}` && s.url.startsWith(`${SFU_BASE}/apps/app123/`))).toBe(true);
    // Renegotiate and close need the owner's session too.
    expect((await sfuProxy(st, 'rbob', 'renegotiate', { sessionId: 'sessAnn00001', sessionDescription: answer }, SETTINGS, f)).status).toBe(403);
    expect((await sfuProxy(st, 'rann', 'renegotiate', { sessionId: 'sessAnn00001', sessionDescription: answer }, SETTINGS, f)).status).toBe(200);
    const close = await sfuProxy(st, 'hadmin', 'close', { sessionId: 'sessHost0001', tracks: [{ mid: '1' }] }, SETTINGS, f);
    expect(close.status).toBe(200);
    expect(seen.at(-1)).toMatchObject({ method: 'PUT', body: { tracks: [{ mid: '1' }], force: true } });
    expect(st.members.hadmin.tracks.map((t) => t.trackName)).toEqual(['hadmin-audio']);
  });

  it('SFU errors come back without the secret; missing keys say what to add', async () => {
    const st = webinar();
    const { f } = stubSfu(() => [500, { errorCode: 'internal', errorDescription: `bad token ${SECRET}` }]);
    const r = await sfuProxy(st, 'hadmin', 'session', {}, SETTINGS, f);
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.body)).not.toContain(SECRET);
    await expect(sfuCall({}, 'POST', 'sessions/new')).rejects.toThrow(/Realtime app ID and secret/);
    expect(realtimeSetup({}).todo).toHaveLength(2);
    expect(realtimeSetup(SETTINGS).ready).toBe(true);
    const notMember = await sfuProxy(st, 'stranger', 'session', {}, SETTINGS, f);
    expect(notMember.status).toBe(403);
  });

  it('mints short-lived ICE servers per person with the TURN token, dropping port 53', async () => {
    const seen: { url: string; auth: string; body: string }[] = [];
    const f = vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
      seen.push({ url, auth: init.headers.authorization, body: init.body });
      return new Response(JSON.stringify({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] }, { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u', credential: 'c' }] }), { status: 201 });
    }) as unknown as typeof fetch;
    const r = await mintIceServers(SETTINGS, 3600, f);
    expect(seen[0]).toEqual({ url: `${SFU_BASE}/turn/keys/turnkey1/credentials/generate-ice-servers`, auth: `Bearer ${TURN_TOKEN}`, body: JSON.stringify({ ttl: 3600 }) });
    expect(r.iceServers).toEqual([{ urls: ['stun:stun.cloudflare.com:3478'] }, { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u', credential: 'c' }]);
    expect(JSON.stringify(r)).not.toContain(TURN_TOKEN);
    expect((await mintIceServers({}, 3600, f)).turn).toBe(false);
  });
});

// ───────────── presence feeding attribution and the webinar AI calls ─────────────

function seedLead(id: string, phone = '+61412345678') {
  x(`INSERT INTO leads (id, ref_code, created_at, updated_at, visitor_id, first_name, last_name, email, phone, call_consent_at, call_consent_text, status, revenue_band)
     VALUES (?, ?, ?, ?, ?, 'Dana', 'Lee', ?, ?, ?, 'webinar-v1', 'partial', '3m-10m')`, id, `R${id}`, T0 - DAY, T0 - DAY, `v${id}`, `${id}@example.com`, phone, T0 - DAY);
}

describe('presence and minutes from the room', () => {
  it('a live event in our room: room on save, attendance, joined, minutes, attended stage, then the left-mid-session call', async () => {
    const s = await saveEvent(rt, { title: 'Live in our room', starts_at: T0 - 20 * MIN, tz: 'UTC', duration_min: 120, platform: 'room' });
    expect(s.ok).toBe(true);
    const evId = (s as { id: string }).id;
    expect(q('SELECT platform FROM live_webinars WHERE id = ?', evId)[0]).toEqual({ platform: 'room' });
    const room = (await ensureRoomFor(rt, 'live', evId, { title: 'Live in our room', startsAt: T0 - 20 * MIN, durationMin: 120 }))!;
    expect(q('SELECT COUNT(*) AS n FROM rooms WHERE ref_type = ? AND ref_id = ?', 'live', evId)[0]).toEqual({ n: 1 }); // created once, on save
    seedLead('l1');
    x(`INSERT INTO live_webinar_regs (id, token, event_id, lead_id, revenue_band, created_at) VALUES ('lr1', 'ltok1aaaaaaaaaaaaaaa', ?, 'l1', '3m-10m', ?)`, evId, T0 - DAY);
    const who = { id: 'rlr1', role: 'attendee' as const, name: 'Dana L.', leadId: 'l1', regId: 'lr1' };
    await feedPresence(rt, room, [who, { id: 'hadmin', role: 'host', name: 'Josh' }], T0 - 15 * MIN, { live: true });
    await feedPresence(rt, room, [who], T0 - 14 * MIN, { live: true });
    await feedPresence(rt, room, [who], T0 - 13 * MIN, { live: true });
    expect(q('SELECT who, role, minutes FROM room_attendance WHERE room_id = ? ORDER BY who', room.id)).toEqual([{ who: 'hadmin', role: 'host', minutes: 1 }, { who: 'rlr1', role: 'attendee', minutes: 3 }]);
    const reg = q<{ joined_at: number; last_seen_at: number }>('SELECT joined_at, last_seen_at FROM live_webinar_regs WHERE id = ?', 'lr1')[0];
    expect(reg).toEqual({ joined_at: T0 - 15 * MIN, last_seen_at: T0 - 13 * MIN });
    expect(q('SELECT who, kind, seen_at FROM webinar_presence WHERE session_id = ?', evId)).toEqual([{ who: 'lr1', kind: 'viewer', seen_at: T0 - 13 * MIN }]);
    expect(q<{ n: number }>("SELECT COUNT(*) AS n FROM attr_watch WHERE funnel = 'live' AND reg_id = 'lr1' AND source = 'room'")[0].n).toBe(3);
    expect(q("SELECT stage FROM attr_stages WHERE reg_id = 'lr1'")).toEqual([{ stage: 'attended' }]);
    // They closed the room mid-session: the webinar calls see it exactly as for Zoom events.
    await planWebinarCalls(rt, T0);
    const calls = q<{ kind: string; wc_ref: string }>('SELECT kind, wc_ref FROM outbound_calls');
    expect(calls).toContainEqual({ kind: 'w_left', wc_ref: 'live:lr1' });
  });

  it('a challenge day in our room: presence, attendance after 5 minutes, minutes', async () => {
    seedLead('l2');
    x(`INSERT INTO challenge_cohorts (id, name, start_date, start_time, timezone, created_at, updated_at) VALUES ('coh1', 'Nov', '2026-11-03', '01:30', 'UTC', ?, ?)`, T0, T0);
    x('INSERT INTO challenge_days (cohort_id, day, starts_at, duration_min, platform, updated_at) VALUES (?, 1, ?, 90, ?, ?)', 'coh1', T0 - 30 * MIN, 'room', T0);
    x(`INSERT INTO challenge_registrations (id, token, cohort_id, lead_id, status, created_at, paid_at) VALUES ('cr1', 'ctok1aaaaaaaaaaaaaaa', 'coh1', 'l2', 'paid', ?, ?)`, T0 - DAY, T0 - DAY);
    const room = await ensureRoomFor(rt, 'challenge', 'challenge:coh1:1', { title: 'Day 1', startsAt: T0 - 30 * MIN, durationMin: 90 });
    const who = { id: 'rcr1', role: 'attendee' as const, name: 'Dana L.', leadId: 'l2', regId: 'cr1' };
    await feedPresence(rt, room, [who], T0 - 20 * MIN);
    expect(q('SELECT joined_at, present_at FROM challenge_progress WHERE reg_id = ?', 'cr1')).toEqual([{ joined_at: T0 - 20 * MIN, present_at: null }]);
    await feedPresence(rt, room, [who], T0 - 14 * MIN);
    expect(q('SELECT present_at FROM challenge_progress WHERE reg_id = ?', 'cr1')).toEqual([{ present_at: T0 - 14 * MIN }]);
    expect(q('SELECT who FROM webinar_presence WHERE session_id = ?', 'challenge:coh1:1')).toEqual([{ who: 'cr1' }]);
    expect(q<{ n: number }>("SELECT COUNT(*) AS n FROM attr_watch WHERE funnel = 'challenge'")[0].n).toBe(2);
  });

  it('the offer comes from the live funnel: opening in the room opens the event’s offer, with its real deadline', async () => {
    const s = await saveEvent(rt, { title: 'Live', starts_at: T0 - 20 * MIN, tz: 'UTC', duration_min: 120, platform: 'room' }) as { id: string };
    const room = (await ensureRoomFor(rt, 'live', s.id, { title: 'Live', startsAt: T0 - 20 * MIN, durationMin: 120 }))!;
    expect(await roomOffer(rt, room)).toMatchObject({ available: true, open: false });
    expect(await setRoomOffer(rt, room, true)).toEqual({ ok: true });
    const o = await roomOffer(rt, room);
    expect(o.open).toBe(true);
    expect(o.closesAt).toBe(T0 - 20 * MIN + 120 * MIN + 48 * HOUR); // the event's end + LIVE_OFFER_HOURS
    const meeting = await createRoom(rt, { mode: 'meeting', title: 'Kickoff', refType: 'lead', leadId: 'l1' });
    expect(await roomOffer(rt, meeting)).toMatchObject({ available: false });
    expect((await setRoomOffer(rt, meeting, true)).ok).toBe(false);
    expect((await getRoom(rt, meeting.id))!.mode).toBe('meeting');
  });
});

// ───────────── copy rules ─────────────

describe('copy', () => {
  it('every room string passes the copy rules', () => {
    const strings: string[] = [];
    const walk = (v: unknown) => { if (typeof v === 'string') strings.push(v); else if (typeof v === 'function') strings.push(String((v as (n: number) => string)(3))); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
    walk(ROOM_COPY); walk(ROOM_GATE); walk(ROOM_DAY);
    for (const s of strings) expect(auditCopy(s), s).toEqual([]);
    expect(auditFields(ROOM_GATE)).toEqual([]);
  });

  it('the meeting invite and the room versions of the live emails and texts pass', () => {
    const m = meetingInvite({ name: 'Dana', title: 'Kickoff with Dana Lee', when: 'Tuesday 3 November, 1:00 pm AEDT', url: 'https://apply.test/rooms/rmx?i=abc', host: 'Josh’s team' });
    expect(auditEmail({ subject: m.subject, preheader: m.preheader, body: m.paras })).toEqual([]);
    const ctx = { name: 'Dana', title: 'Live', when: 'Tue 3 Nov', room: 'https://x/live/room/t', ticket: null, ticketLabel: null, attended: false, offerOpened: false, closes: null, replay: false, deposit: '$5,000', inRoom: true };
    for (const k of ['confirm', 'r24h', 'r1h', 'r10m', 'live'] as const) {
      const e = liveEmail(k, ctx)!;
      expect(JSON.stringify(e)).not.toMatch(/Zoom/);
      expect(auditEmail({ subject: e.subject, preheader: e.preheader, body: e.paras })).toEqual([]);
    }
    expect(liveText('r10m', { title: 'Live', when: 'x', site: 'G&L', inRoom: true })).not.toMatch(/Zoom/);
    expect(liveText('r10m', { title: 'Live', when: 'x', site: 'G&L' })).toMatch(/Zoom/);
  });

  it('the four Realtime settings exist in the Live group, secrets marked; the maps mention the room', () => {
    const defs = SETTING_DEFS as readonly { key: string; group: string; secret?: boolean }[];
    const get = (k: string) => defs.find((d) => d.key === k)!;
    expect(['REALTIME_APP_ID', 'REALTIME_APP_SECRET', 'REALTIME_TURN_KEY_ID', 'REALTIME_TURN_TOKEN'].map((k) => [get(k).group, Boolean(get(k).secret)])).toEqual([['Live', false], ['Live', true], ['Live', false], ['Live', true]]);
    const maps = FUNNEL_MAPS as unknown as { id: string; summary: string }[];
    expect(maps.find((m) => m.id === 'live')!.summary).toMatch(/our own video room/);
    expect(maps.find((m) => m.id === 'challenge')!.summary).toMatch(/our own video room/);
  });
});
