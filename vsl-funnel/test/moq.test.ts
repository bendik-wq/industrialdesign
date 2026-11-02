import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../src/app';
import { login } from '../src/admin/auth';
import { auditCopy } from '../src/content/copy-rules';
import { loadSettings, SETTINGS as SETTING_DEFS } from '../src/settings';
import { FUNNEL_MAPS } from '../src/admin/funnel-maps-defs';
import { ROOM_COPY } from '../src/rooms/copy';
import { RoomDO } from '../src/rooms/do';
import { MOQ_DEFAULT_RELAY, audienceThreshold, broadcastMode, broadcastName, connectUrl, moqSetup, relayUrl, tokenInfo } from '../src/rooms/moq';
import { createRoom, feedPresence, makeTicket } from '../src/rooms/rooms';
import { roomMeta, roomsApi } from '../src/rooms/routes';
import {
  type Identity, type RoomState, MOQ_HEALTH_MS, apply, audience, broadcastLive, configureMoq, join, leave, mediaCounts, mediaPath, newRoomState, shouldPublishMoq, view,
} from '../src/rooms/state';

// ───────────── a real SQLite database shaped like D1 (same as rooms.test.ts) ─────────────

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

// Fake relay JWTs shaped like Cloudflare's (EdDSA header, aud moq.cloudflare.com, operations); signatures are opaque here.
const b64u = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const T0 = Date.parse('2026-11-03T02:00:00Z');
const jwt = (ops: string[], exp = T0 / 1000 + 365 * 86400) => `${b64u({ alg: 'EdDSA', kid: 'moq-v1', typ: 'JWT' })}.${b64u({ aud: 'moq.cloudflare.com', exp, iss: 'cloudflare', operations: ops, sub: 'acct' })}.c2lnbmF0dXJlLU5FVkVSLUxFQUs`;
const PUB = jwt(['publish', 'subscribe']);
const SUB = jwt(['subscribe']);
const MOQ = { MOQ_PUBLISH_TOKEN: PUB, MOQ_SUBSCRIBE_TOKEN: SUB };

let db: DatabaseSync;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  db = freshDb();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const host: Identity = { id: 'hadmin', name: 'Josh', role: 'host' };
const cohost: Identity = { id: 'gco1', name: 'Mia', role: 'cohost' };
const viewer = (i: number): Identity => ({ id: `rv${i}`, name: `Viewer ${i}`, role: 'attendee', leadId: `l${i}`, regId: `r${i}` });

/** A live webinar with the host and `n` viewers; MoQ configured as asked. */
function live(n: number, c: { mode?: 'auto' | 'sfu' | 'moq'; ready?: boolean; min?: number } = {}) {
  const st = newRoomState({ id: 'rmmoqtest01', mode: 'webinar', title: 'Big one', startsAt: T0 });
  configureMoq(st, { mode: c.mode ?? 'auto', ready: c.ready ?? true, minAudience: c.min ?? 25 });
  join(st, host, T0); join(st, cohost, T0);
  for (let i = 0; i < n; i++) join(st, viewer(i), T0);
  expect(apply(st, host.id, { t: 'golive' }, T0).ok).toBe(true);
  return st;
}
const publish = (st: RoomState, t = T0, extra: Record<string, unknown> = {}) => apply(st, host.id, { t: 'moq_pub', on: true, kbps: 2400, fps: 25, ...extra }, t);
const pathOf = (st: RoomState, id: string, t = T0) => mediaPath(st, st.members[id], t);

// ───────────── settings, tokens, the broadcast name ─────────────

describe('MoQ setup and tokens', () => {
  it('reads what each relay token allows, and says what to fix', () => {
    expect(tokenInfo(PUB, T0)).toMatchObject({ publish: true, subscribe: true, expired: false });
    expect(tokenInfo(SUB, T0)).toMatchObject({ publish: false, subscribe: true });
    expect(tokenInfo('not-a-jwt')).toBeNull();
    expect(moqSetup(MOQ, T0)).toMatchObject({ ready: true, relay: MOQ_DEFAULT_RELAY, todo: [] });
    expect(moqSetup({}, T0).ready).toBe(false);
    expect(moqSetup({ MOQ_PUBLISH_TOKEN: SUB, MOQ_SUBSCRIBE_TOKEN: SUB }, T0).todo.join(' ')).toMatch(/can’t publish/);
    expect(moqSetup({ MOQ_PUBLISH_TOKEN: PUB, MOQ_SUBSCRIBE_TOKEN: jwt(['subscribe'], T0 / 1000 - 1) }, T0)).toMatchObject({ ready: false });
    expect(moqSetup({ MOQ_PUBLISH_TOKEN: PUB }, T0).todo.join(' ')).toMatch(/subscribe-only token/);
    for (const t of [...moqSetup({}, T0).todo, ...moqSetup({ MOQ_PUBLISH_TOKEN: SUB, MOQ_SUBSCRIBE_TOKEN: PUB }, T0).todo]) expect(auditCopy(t), t).toEqual([]);
  });

  it('relay URL: https only, no query; the token goes in the path (draft-16)', () => {
    expect(relayUrl({})).toBe('https://draft-16.cloudflare.mediaoverquic.com');
    expect(relayUrl({ MOQ_RELAY_URL: 'https://relay.example.com/moq/' })).toBe('https://relay.example.com/moq');
    expect(relayUrl({ MOQ_RELAY_URL: 'http://relay.example.com' })).toBe(MOQ_DEFAULT_RELAY);
    expect(relayUrl({ MOQ_RELAY_URL: 'https://relay.example.com/?jwt=x' })).toBe(MOQ_DEFAULT_RELAY);
    expect(connectUrl(MOQ_DEFAULT_RELAY, SUB)).toBe(`${MOQ_DEFAULT_RELAY}/${SUB}`);
  });

  it('mode: the room override, else ROOM_BROADCAST, else auto; the audience threshold', () => {
    expect(broadcastMode({})).toBe('auto');
    expect(broadcastMode({ ROOM_BROADCAST: 'SFU' })).toBe('sfu');
    expect(broadcastMode({ ROOM_BROADCAST: 'sfu' }, 'moq')).toBe('moq');
    expect(broadcastMode({ ROOM_BROADCAST: 'nonsense' }, null)).toBe('auto');
    expect(audienceThreshold({})).toBe(25);
    expect(audienceThreshold({ ROOM_MOQ_AUDIENCE: '200' })).toBe(200);
    expect(audienceThreshold({ ROOM_MOQ_AUDIENCE: '-3' })).toBe(25);
  });

  it('the broadcast name is unguessable: an HMAC of the room under the app secret, never the room id', async () => {
    const a = await broadcastName('secret-one', 'rmabc12345');
    expect(a).toMatch(/^gl\/[0-9a-f]{40}$/);
    expect(a).not.toContain('rmabc12345');
    expect(await broadcastName('secret-one', 'rmabc12345')).toBe(a); // stable for the room
    expect(await broadcastName('secret-two', 'rmabc12345')).not.toBe(a);
    expect(await broadcastName('secret-one', 'rmabc12346')).not.toBe(a);
  });

  it('settings: the tokens are secrets in the Live group; the map tells the story', () => {
    const defs = SETTING_DEFS as readonly { key: string; group: string; secret?: boolean; help?: string }[];
    const get = (k: string) => defs.find((d) => d.key === k)!;
    expect(['MOQ_PUBLISH_TOKEN', 'MOQ_SUBSCRIBE_TOKEN', 'MOQ_RELAY_URL', 'ROOM_BROADCAST', 'ROOM_MOQ_AUDIENCE'].map((k) => [get(k).group, Boolean(get(k).secret)]))
      .toEqual([['Live', true], ['Live', true], ['Live', false], ['Live', false], ['Live', false]]);
    for (const k of ['MOQ_PUBLISH_TOKEN', 'MOQ_SUBSCRIBE_TOKEN', 'MOQ_RELAY_URL', 'ROOM_BROADCAST', 'ROOM_MOQ_AUDIENCE']) expect(auditCopy(get(k).help!), k).toEqual([]);
    const mapText = JSON.stringify(FUNNEL_MAPS);
    expect(mapText).toMatch(/MoQ/);
    expect(mapText).toMatch(/falls back to Realtime/);
  });
});

// ───────────── who watches which way ─────────────

describe('the media path for each person', () => {
  it('auto: SFU until the audience reaches the threshold, then MoQ for the rest of the session', () => {
    const st = live(3, { min: 5 });
    publish(st);
    expect(audience(st)).toBe(3);
    expect(st.moq!.engaged).toBe(false);
    expect(pathOf(st, 'rv0')).toBe('sfu');
    join(st, viewer(3), T0); join(st, viewer(4), T0);
    expect(st.moq!.engaged).toBe(true);
    for (let i = 0; i < 5; i++) expect(pathOf(st, `rv${i}`)).toBe('moq');
    // People leave: still MoQ (nobody flips back and forth).
    for (let i = 0; i < 4; i++) leave(st, `rv${i}`, T0);
    expect(pathOf(st, 'rv4')).toBe('moq');
  });

  it('host, co-hosts and people on stage always use the SFU; an invited viewer switches to it', () => {
    const st = live(2, { mode: 'moq' });
    publish(st);
    expect(pathOf(st, host.id)).toBe('sfu');
    expect(pathOf(st, cohost.id)).toBe('sfu');
    expect(pathOf(st, 'rv0')).toBe('moq');
    apply(st, host.id, { t: 'invite', id: 'rv0' }, T0);
    expect(apply(st, 'rv0', { t: 'accept' }, T0).ok).toBe(true);
    expect(pathOf(st, 'rv0')).toBe('sfu');
    expect(view(st, st.members.rv0, T0).me).toMatchObject({ canPublish: true, media: 'sfu', publishMoq: false });
    apply(st, host.id, { t: 'unstage', id: 'rv0' }, T0);
    expect(pathOf(st, 'rv0')).toBe('moq');
  });

  it('SFU when MoQ isn’t set up, is off for the room, before Go live, or when the broadcast is down', () => {
    expect(pathOf((() => { const s = live(2, { mode: 'moq', ready: false }); publish(s); return s; })(), 'rv0')).toBe('sfu');
    expect(pathOf((() => { const s = live(2, { mode: 'sfu' }); publish(s); return s; })(), 'rv0')).toBe('sfu');
    const lobby = newRoomState({ id: 'rmmoqtest02', mode: 'webinar', title: 'x', startsAt: T0 });
    configureMoq(lobby, { mode: 'moq', ready: true, minAudience: 1 });
    join(lobby, host, T0); join(lobby, viewer(0), T0);
    expect(shouldPublishMoq(lobby, lobby.members[host.id])).toBe(false); // backstage is never broadcast
    expect(pathOf(lobby, 'rv0')).toBe('sfu');
    const st = live(2, { mode: 'moq' });
    expect(pathOf(st, 'rv0')).toBe('sfu'); // not publishing yet
    publish(st);
    expect(broadcastLive(st, T0)).toBe(true);
    expect(pathOf(st, 'rv0')).toBe('moq');
    expect(pathOf(st, 'rv0', T0 + MOQ_HEALTH_MS + 1)).toBe('sfu'); // the host stopped reporting
    expect(apply(st, host.id, { t: 'moq_pub', on: false, error: 'The MoQ relay isn’t reachable from this network.' }, T0 + 1000).changed).toBe(true);
    expect(pathOf(st, 'rv0', T0 + 1000)).toBe('sfu');
    publish(st, T0 + 2000);
    leave(st, host.id, T0 + 3000); // the host's last connection ends the broadcast
    expect(pathOf(st, 'rv0', T0 + 3000)).toBe('sfu');
  });

  it('fallback: a browser without WebTransport, or a network that blocks QUIC, stays on the SFU', () => {
    const st = live(3, { mode: 'moq' });
    publish(st);
    expect(apply(st, 'rv0', { t: 'moq_view', state: 'unsupported', reason: 'no_webtransport' }, T0).changed).toBe(true);
    expect(apply(st, 'rv1', { t: 'moq_view', state: 'failed', reason: 'network' }, T0).ok).toBe(true);
    expect(apply(st, 'rv2', { t: 'moq_view', state: 'playing' }, T0).ok).toBe(true);
    expect([pathOf(st, 'rv0'), pathOf(st, 'rv1'), pathOf(st, 'rv2')]).toEqual(['sfu', 'sfu', 'moq']);
    expect(mediaCounts(st, T0)).toEqual({ moq: 1, sfu: 2 });
    expect(apply(st, 'rv0', { t: 'moq_view', state: 'bogus' }, T0).error).toBe('bad_value');
  });

  it('a stalled viewer gets another try when a fresh broadcast starts; an unsupported one does not', () => {
    const st = live(2, { mode: 'moq' });
    publish(st);
    apply(st, 'rv0', { t: 'moq_view', state: 'failed', reason: 'stalled' }, T0);
    apply(st, 'rv1', { t: 'moq_view', state: 'unsupported', reason: 'no_webtransport' }, T0);
    apply(st, host.id, { t: 'moq_pub', on: false }, T0 + 1000);
    publish(st, T0 + 2000);
    expect(pathOf(st, 'rv0', T0 + 2000)).toBe('moq');
    expect(pathOf(st, 'rv1', T0 + 2000)).toBe('sfu');
  });

  it('only the host reports the broadcast; it can’t claim one before Go live or with MoQ off', () => {
    const st = live(1, { mode: 'moq' });
    expect(apply(st, cohost.id, { t: 'moq_pub', on: true }, T0).error).toBe('forbidden');
    expect(apply(st, 'rv0', { t: 'moq_pub', on: true }, T0).error).toBe('forbidden');
    const off = live(1, { mode: 'sfu' });
    publish(off);
    expect(broadcastLive(off, T0)).toBe(false);
  });
});

// ───────────── nothing else changes for MoQ viewers ─────────────

describe('MoQ viewers keep everything else', () => {
  it('chat, Q&A, polls, hands and the offer work the same; the view never carries a token', () => {
    const st = live(3, { mode: 'moq' });
    st.offer.available = true;
    publish(st);
    apply(st, 'rv0', { t: 'moq_view', state: 'playing' }, T0);
    expect(apply(st, 'rv0', { t: 'chat', text: 'Watching over MoQ' }, T0).out[0].to).toBe('all');
    expect(apply(st, 'rv0', { t: 'ask', text: 'How does seller rollover work?' }, T0).ok).toBe(true);
    expect(apply(st, host.id, { t: 'poll_new', question: 'Revenue?', options: ['Under $1M', '$1M+'] }, T0).ok).toBe(true);
    expect(apply(st, 'rv0', { t: 'vote', pid: 1, choice: 1 }, T0).ok).toBe(true);
    expect(apply(st, 'rv0', { t: 'hand', up: true }, T0).ok).toBe(true);
    expect(apply(st, host.id, { t: 'offer', open: true }, T0).effects).toEqual([{ type: 'offer', open: true }]);
    const v = view(st, st.members.rv0, T0);
    expect(v.me).toMatchObject({ media: 'moq', publishMoq: false, hand: T0 });
    expect(v.room).not.toHaveProperty('broadcast'); // the audience doesn't get the panel
    const hv = view(st, st.members[host.id], T0);
    expect(hv.me.publishMoq).toBe(true);
    expect(hv.room.broadcast).toMatchObject({ mode: 'moq', live: true, kbps: 2400, fps: 25, moq: 3, sfu: 0, audience: 3 }); // routed to MoQ until a browser says otherwise
    const all = JSON.stringify([v, hv, view(st, st.members[cohost.id], T0)]);
    expect(all).not.toContain(PUB);
    expect(all).not.toContain(SUB);
    expect(all).not.toContain('signature');
  });

  it('presence, minutes and the attended stage are fed the same for a MoQ viewer', async () => {
    const DB = d1(db);
    const rt = { env: { DB, SESSION_SECRET: 's' }, settings: { ...MOQ }, reps: [], origin: 'https://apply.test', waitUntil: () => {} } as never;
    const room = await createRoom(rt, { mode: 'webinar', title: 'Big', refType: 'none' });
    const st = live(1, { mode: 'moq' });
    publish(st);
    apply(st, 'rv0', { t: 'moq_view', state: 'playing' }, T0);
    const m = st.members.rv0;
    await feedPresence(rt, room, [{ id: m.id, role: m.role, name: m.name, leadId: m.leadId, regId: m.regId, stage: m.stage }], T0);
    await feedPresence(rt, room, [{ id: m.id, role: m.role, name: m.name, leadId: m.leadId, regId: m.regId, stage: m.stage }], T0 + 60_000);
    expect(db.prepare('SELECT who, role, minutes FROM room_attendance WHERE room_id = ?').all(room.id)).toEqual([{ who: 'rv0', role: 'attendee', minutes: 2 }]);
  });
});

// ───────────── token gating through the Durable Object and the API ─────────────

function fakeCtx() {
  const store = new Map<string, unknown>();
  return {
    blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn(),
    storage: { get: async (k: string) => store.get(k), put: async (k: string, v: unknown) => { store.set(k, v); }, getAlarm: async () => null, setAlarm: async () => {} },
    getWebSockets: () => [], acceptWebSocket: () => {}, waitUntil: () => {},
  };
}

async function setup(o: { mode?: 'moq' | 'sfu' | 'auto' } = {}) {
  const env = { DB: d1(db), SESSION_SECRET: 'moq-test-secret', ADMIN_PASSWORD: 'devpass', ...MOQ } as Record<string, unknown>;
  const rtBase = { env, settings: await loadSettings(env as never), reps: [], origin: 'https://apply.test', waitUntil: () => {} };
  const room = await createRoom(rtBase as never, { mode: 'webinar', title: 'Big webinar', refType: 'none' });
  if (o.mode) db.prepare('UPDATE rooms SET broadcast = ? WHERE id = ?').run(o.mode, room.id);
  const dobj = new RoomDO(fakeCtx() as never, env as never);
  await new Promise((r) => setTimeout(r, 0));
  env.ROOMS = { idFromName: (n: string) => n, get: () => ({ fetch: (req: Request) => dobj.fetch(req) }) };
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => { c.set('settings', await loadSettings(c.env)); await next(); });
  app.post('/login', async (c) => c.json(await login(c, 'devpass')));
  app.route('/api/rooms', roomsApi);
  const call = (path: string, body: Record<string, unknown>, cookie?: string) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://apply.test', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }, env as never, { waitUntil: () => {}, passThroughOnException: () => {} } as never);
  // Prime the object and seat people (the WebSocket isn't available under Node, so join directly).
  const fresh = (await (await import('../src/rooms/rooms')).getRoom(rtBase as never, room.id))!;
  await dobj.fetch(new Request('https://room/info', { headers: { 'x-room-who': JSON.stringify({ id: 'hq', name: 'HQ', role: 'host' }), 'x-room-meta': JSON.stringify(roomMeta(rtBase as never, fresh)) } }));
  const st = (dobj as unknown as { st: RoomState }).st;
  join(st, host, T0); join(st, viewer(0), T0); join(st, viewer(1), T0);
  return { env, rtBase, room, dobj, st, call };
}
const ticket = (s: Awaited<ReturnType<typeof setup>>, who: Identity) => makeTicket(s.rtBase as never, s.room.id, who);

describe('who gets which MoQ token', () => {
  it('a viewer gets the subscribe token only with a valid ticket, once the room routes them to MoQ', async () => {
    const s = await setup({ mode: 'moq' });
    const url = `https://apply.test/api/rooms/${s.room.id}/moq`;
    const t = await ticket(s, viewer(0));
    // Not live yet: nothing.
    let r = await s.call(url, { t });
    expect(r.status).toBe(403);
    expect(await r.text()).not.toContain(SUB);
    apply(s.st, host.id, { t: 'golive' }, T0);
    publish(s.st);
    r = await s.call(url, { t });
    const j = await r.json() as { ok: boolean; url: string; name: string; role: string };
    expect(j).toMatchObject({ ok: true, role: 'subscribe' });
    expect(j.url).toBe(`${MOQ_DEFAULT_RELAY}/${SUB}`);
    expect(j.name).toBe(await broadcastName('moq-test-secret', s.room.id));
    expect(JSON.stringify(j)).not.toContain(PUB);
    expect(r.headers.get('cache-control')).toBe('no-store');
    // No ticket, a forged one, another room's: refused.
    for (const bad of [undefined, 'rt.forged.sig', await makeTicket(s.rtBase as never, 'rmother12345', viewer(0))]) {
      const x = await s.call(url, { t: bad });
      expect(x.status).toBe(403);
      expect(await x.text()).not.toContain(SUB);
    }
    // A viewer whose browser can't do MoQ is on the SFU: no token for them.
    apply(s.st, 'rv1', { t: 'moq_view', state: 'unsupported', reason: 'no_webtransport' }, T0);
    expect((await s.call(url, { t: await ticket(s, viewer(1)) })).status).toBe(403);
  });

  it('the publish token reaches only the host on a signed-in admin session, and never a viewer or co-host', async () => {
    const s = await setup({ mode: 'moq' });
    const url = `https://apply.test/api/rooms/${s.room.id}/moq`;
    apply(s.st, host.id, { t: 'golive' }, T0);
    const hostTicket = await ticket(s, host);
    // A host ticket alone (no admin cookie): refused.
    let r = await s.call(url, { t: hostTicket });
    expect(r.status).toBe(403);
    expect(await r.text()).not.toContain(PUB);
    // Signed in as admin: the publish token.
    const lr = await s.call('https://apply.test/login', {});
    const cookie = (lr.headers.get('set-cookie') ?? '').split(';')[0];
    expect(cookie).toMatch(/^_fa=/);
    r = await s.call(url, { t: hostTicket }, cookie);
    const j = await r.json() as { ok: boolean; url: string; role: string };
    expect(j).toMatchObject({ ok: true, role: 'publish', url: `${MOQ_DEFAULT_RELAY}/${PUB}` });
    // An admin cookie doesn't turn a viewer's or co-host's ticket into a publisher.
    s.st.members[cohost.id] = undefined as never; join(s.st, cohost, T0);
    for (const who of [viewer(0), cohost]) {
      const x = await s.call(url, { t: await ticket(s, who) }, cookie);
      expect(await x.text()).not.toContain(PUB);
    }
    // MoQ off for this room: no publish token either.
    db.prepare("UPDATE rooms SET broadcast = 'sfu' WHERE id = ?").run(s.room.id);
    r = await s.call(url, { t: hostTicket }, cookie);
    expect(r.status).toBe(403);
    expect(await r.text()).not.toContain(PUB);
  });

  it('the room page config says only whether MoQ is on; no token, relay path or name', async () => {
    const s = await setup({ mode: 'moq' });
    const meta = roomMeta(s.rtBase as never, { ...s.room, broadcast: 'moq' });
    expect(meta.moq).toEqual({ mode: 'moq', ready: true, minAudience: 25 });
    expect(JSON.stringify(meta)).not.toContain(PUB);
    expect(JSON.stringify(meta)).not.toContain(SUB);
  });
});

describe('copy', () => {
  it('every MoQ string passes the copy rules', () => {
    for (const [k, v] of Object.entries(ROOM_COPY.moq)) expect(auditCopy(v), k).toEqual([]);
  });
});
