import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv, Runtime } from '../src/app';
import { auditCopy } from '../src/content/copy-rules';
import {
  JOIN_OPENS_MIN, OVERRUN_MIN, cleanJoinUrl, createZoomFor, ensureLiveInput, getLiveEvent, hostStartUrl, isLiveKey, liveStatus, playbackFor, playbackState, streamSetup, upsertLiveEvent,
} from '../src/live/stream';
import { ZOOM_STEPS, createZoomEvent, hasScope, resetZoomToken, zoomCheck, zoomTime } from '../src/live/zoom';
import { liveEventsAdmin, liveHostPage } from '../src/live/admin';
import { requireAdmin } from '../src/admin/auth';
import { liveStatusRoute } from '../src/live/routes';

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
const ZOOM = { ZOOM_ACCOUNT_ID: 'acc_1', ZOOM_CLIENT_ID: 'cid', ZOOM_CLIENT_SECRET: 'csecret123456', WEBINAR_DURATION_MIN: '90' };
const makeRt = (db: DatabaseSync, settings: Record<string, string> = {}) =>
  ({ env: { DB: d1(db) }, settings: { WEBINAR_DURATION_MIN: '90', ...settings }, reps: [], origin: 'https://apply.test', waitUntil: () => {} }) as unknown as Runtime;

const MIN = 60_000;
const ZLINK = 'https://us02web.zoom.us/j/81234567890?pwd=abc';
const START_URL = 'https://us02web.zoom.us/s/81234567890?zak=SECRET_HOST_TOKEN';
function seedSession(db: DatabaseSync, startsAt: number, mode = 'live', joinUrl: string | null = null) {
  db.prepare("INSERT INTO webinar_sessions (id, starts_at, mode, join_url, status, auto, created_at) VALUES ('s1', ?, ?, ?, 'scheduled', 0, ?)").run(startsAt, mode, joinUrl, Date.now());
}

interface Call { url: string; method: string; headers: Record<string, string>; body: string | null }
function stubZoom(o: { scope?: string; webinar?: 'ok' | 'no-plan'; tokenFail?: boolean } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ?? null });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (u === 'https://zoom.us/oauth/token') return o.tokenFail ? json(400, { reason: 'Invalid client_id or client_secret', error: 'invalid_client' }) : json(200, { access_token: 'tok', token_type: 'bearer', expires_in: 3599, scope: o.scope ?? 'meeting:write:meeting:admin meeting:read:meeting:admin' });
    if (/\/users\/me\/webinars(\?|$)/.test(u)) return o.webinar === 'ok' ? json(init.method === 'POST' ? 201 : 200, { id: 99887766554, join_url: 'https://us02web.zoom.us/w/99887766554', start_url: START_URL, password: 'pw1' }) : json(400, { code: 200, message: 'Webinar plan is missing. You must subscribe to the webinar plan and enable webinars for this user in order to perform this action.' });
    if (u.endsWith('/users/me/meetings')) return json(201, { id: 81234567890, join_url: ZLINK, start_url: START_URL, password: 'abc' });
    if (/\/meetings\/\d+$/.test(u)) return json(200, { start_url: `${START_URL}&fresh=1` });
    return json(404, { code: 1001, message: 'not stubbed' });
  }));
  return calls;
}
beforeEach(() => resetZoomToken());
afterEach(() => vi.unstubAllGlobals());

describe('setup', () => {
  it('reports what is missing, and events run on pasted links either way', () => {
    const db = freshDb();
    const none = streamSetup(makeRt(db));
    expect(none.ready).toBe(false);
    expect(none.reason).toMatch(/paste a Zoom link per event/);
    expect(none.customerCode).toBeNull();
    const part = streamSetup(makeRt(db, { ZOOM_ACCOUNT_ID: 'a' }));
    expect(part.reason).toBe('Zoom API settings incomplete: add the Zoom client ID and client secret under Integrations → Live.');
    const full = streamSetup(makeRt(db, ZOOM));
    expect(full).toEqual({ ready: true, reason: null, accountId: 'acc_1', customerCode: null });
  });
  it('has no live inputs any more', async () => {
    expect(await ensureLiveInput(makeRt(freshDb()), 'webinar:s1', 'x')).toBeNull();
  });
  it('accepts only the two key shapes and https links', () => {
    expect(isLiveKey('webinar:ws_abc')).toBe(true);
    expect(isLiveKey('challenge:c_1:3')).toBe(true);
    expect(isLiveKey('challenge:c_1')).toBe(false);
    expect(isLiveKey('other:x')).toBe(false);
    expect(cleanJoinUrl(' https://zoom.us/j/1 ')).toBe('https://zoom.us/j/1');
    expect(cleanJoinUrl('http://zoom.us/j/1')).toBeNull();
    expect(cleanJoinUrl('javascript:alert(1)')).toBeNull();
    expect(cleanJoinUrl('https://x.test/"><script>')).toBeNull();
  });
});

describe('playback by the schedule only', () => {
  const start = 1_800_000_000_000;
  const sched = { startsAt: start, durationMin: 90 };
  it('no link → none', () => {
    const p = playbackState({ schedule: sched, joinUrl: null }, start);
    expect(p.mode).toBe('none');
    expect(p.joinUrl).toBeNull();
    expect(p.hls).toBeNull();
  });
  it('before the doors open: link mode, no link handed out, not live', () => {
    const p = playbackState({ schedule: sched, joinUrl: ZLINK }, start - (JOIN_OPENS_MIN + 1) * MIN);
    expect(p).toMatchObject({ mode: 'link', isLive: false, joinUrl: null, startsAt: start, endsAt: start + 90 * MIN, provider: 'zoom' });
  });
  it('from 10 minutes before the start to the scheduled end: live, with the link', () => {
    for (const t of [start - JOIN_OPENS_MIN * MIN, start, start + 89 * MIN]) expect(playbackState({ schedule: sched, joinUrl: ZLINK }, t)).toMatchObject({ isLive: true, joinUrl: ZLINK });
  });
  it('after the scheduled end: not live; the link works through the overrun, then goes', () => {
    expect(playbackState({ schedule: sched, joinUrl: ZLINK }, start + 91 * MIN)).toMatchObject({ isLive: false, joinUrl: ZLINK });
    expect(playbackState({ schedule: sched, joinUrl: ZLINK }, start + (90 + OVERRUN_MIN) * MIN)).toMatchObject({ isLive: false, joinUrl: null, mode: 'link' });
  });
  it('no schedule: the link, never "live"', () => {
    expect(playbackState({ schedule: null, joinUrl: 'https://meet.example.com/x' }, start)).toMatchObject({ isLive: false, joinUrl: 'https://meet.example.com/x', provider: 'other' });
  });
});

describe('events in D1', () => {
  it('reads the webinar session schedule and its own link; the pasted link wins', async () => {
    const db = freshDb(), rt = makeRt(db);
    seedSession(db, Date.now() + 5 * MIN, 'live', 'https://zoom.us/j/111');
    let p = await playbackFor(rt, 'webinar:s1');
    expect(p).toMatchObject({ mode: 'link', isLive: true, joinUrl: 'https://zoom.us/j/111' });
    await upsertLiveEvent(rt, 'webinar:s1', { joinUrl: ZLINK });
    p = await playbackFor(rt, 'webinar:s1');
    expect(p.joinUrl).toBe(ZLINK);
    // The session row follows, so the room's own join endpoint hands out the same link.
    expect((db.prepare("SELECT join_url FROM webinar_sessions WHERE id = 's1'").get() as { join_url: string }).join_url).toBe(ZLINK);
  });
  it('a fallback link and an explicit schedule work for keys with no row (challenge days)', async () => {
    const rt = makeRt(freshDb());
    const p = await playbackFor(rt, 'challenge:c1:2', 'https://zoom.us/j/222', { startsAt: Date.now() + 60 * MIN, durationMin: 75 });
    expect(p).toMatchObject({ mode: 'link', isLive: false, joinUrl: null });
    expect(p.endsAt! - p.startsAt!).toBe(75 * MIN);
    expect(await playbackFor(rt, 'challenge:c1:2')).toMatchObject({ mode: 'none' });
  });
  it('upsert is idempotent and leaves unspecified fields alone', async () => {
    const db = freshDb(), rt = makeRt(db);
    await upsertLiveEvent(rt, 'challenge:c1:1', { title: 'Day 1', startsAt: 1_800_000_000_000, durationMin: 80 });
    await upsertLiveEvent(rt, 'challenge:c1:1', { joinUrl: ZLINK });
    await upsertLiveEvent(rt, 'challenge:c1:1', { joinUrl: ZLINK });
    const row = await getLiveEvent(rt, 'challenge:c1:1');
    expect(row).toMatchObject({ title: 'Day 1', starts_at: 1_800_000_000_000, duration_min: 80, join_url: ZLINK });
    expect((db.prepare('SELECT COUNT(*) AS n FROM live_events').get() as { n: number }).n).toBe(1);
  });
});

describe('public status', () => {
  it('says on/off and whether a link exists, never the link or the host link', async () => {
    const db = freshDb(), rt = makeRt(db);
    seedSession(db, Date.now() + 2 * MIN);
    await upsertLiveEvent(rt, 'webinar:s1', { joinUrl: ZLINK, zoom: { id: '81234567890', kind: 'meeting', startUrl: START_URL, password: 'abc' } });
    const st = await liveStatus(rt, 'webinar:s1');
    expect(st).toMatchObject({ isLive: true, hasLink: true });
    expect(JSON.stringify(st)).not.toMatch(/zoom\.us|SECRET|81234567890|abc/);
    expect(await liveStatus(rt, 'webinar:nope')).toBeNull();
    expect(await liveStatus(rt, '../etc')).toBeNull();
  });
  it('GET /api/live/:key/status over HTTP', async () => {
    const db = freshDb(), rt = makeRt(db);
    seedSession(db, Date.now() + 2 * MIN);
    await upsertLiveEvent(rt, 'webinar:s1', { joinUrl: ZLINK, zoom: { id: '81234567890', kind: 'meeting', startUrl: START_URL, password: 'abc' } });
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => { c.set('settings', rt.settings); c.set('reps', []); await next(); });
    app.get('/api/live/:key/status', liveStatusRoute);
    const res = await app.request('/api/live/webinar:s1/status', {}, { DB: d1(db) });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(['endsAt', 'hasLink', 'isLive', 'startsAt']);
    expect(text).not.toMatch(/zoom\.us|SECRET|pwd/);
    expect((await app.request('/api/live/webinar:missing/status', {}, { DB: d1(db) })).status).toBe(404);
  });
});

describe('Zoom API', () => {
  it('formats the start time the way Zoom wants it', () => {
    expect(zoomTime(Date.UTC(2026, 10, 3, 9, 0, 0, 456))).toBe('2026-11-03T09:00:00Z');
    expect(hasScope('meeting:write:meeting:admin webinar:read:webinar:admin', 'meeting:write')).toBe(true);
    expect(hasScope('meeting:write:admin', 'meeting:write')).toBe(true);
    expect(hasScope('meeting:read:meeting', 'meeting:write')).toBe(false);
  });
  it('gets a token with account credentials and creates a meeting', async () => {
    const calls = stubZoom();
    const z = await createZoomEvent(makeRt(freshDb(), ZOOM), { title: 'Live masterclass', startsAt: Date.UTC(2026, 10, 3, 9), durationMin: 120 });
    expect(z).toEqual({ id: '81234567890', kind: 'meeting', joinUrl: ZLINK, startUrl: START_URL, password: 'abc' });
    const tok = calls[0];
    expect(tok.method).toBe('POST');
    expect(tok.headers.authorization).toBe(`Basic ${btoa('cid:csecret123456')}`);
    expect(tok.body).toBe('grant_type=account_credentials&account_id=acc_1');
    const create = calls.find((c) => c.url.endsWith('/users/me/meetings'))!;
    expect(create.headers.authorization).toBe('Bearer tok');
    expect(JSON.parse(create.body!)).toMatchObject({ topic: 'Live masterclass', type: 2, start_time: '2026-11-03T09:00:00Z', duration: 120, timezone: 'UTC', settings: { mute_upon_entry: true, join_before_host: false } });
    expect(calls.some((c) => c.url.includes('/webinars'))).toBe(false); // no webinar scope: straight to a meeting
  });
  it('tries a Zoom Webinar when it has the scope, and falls back to a meeting without the add-on', async () => {
    const scope = 'meeting:write:meeting:admin webinar:write:webinar:admin';
    stubZoom({ scope, webinar: 'ok' });
    expect((await createZoomEvent(makeRt(freshDb(), ZOOM), { title: 'x', startsAt: Date.now() + 86_400_000, durationMin: 90 })).kind).toBe('webinar');
    resetZoomToken();
    const calls = stubZoom({ scope, webinar: 'no-plan' });
    expect((await createZoomEvent(makeRt(freshDb(), ZOOM), { title: 'x', startsAt: Date.now() + 86_400_000, durationMin: 90 })).kind).toBe('meeting');
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url.replace('https://api.zoom.us/v2', ''))).toEqual(['https://zoom.us/oauth/token', '/users/me/webinars', '/users/me/meetings']);
  });
  it('createZoomFor stores the links; the host link refreshes from Zoom', async () => {
    stubZoom();
    const db = freshDb(), rt = makeRt(db, ZOOM);
    seedSession(db, Date.now() + 86_400_000);
    await createZoomFor(rt, 'webinar:s1');
    const row = await getLiveEvent(rt, 'webinar:s1');
    expect(row).toMatchObject({ join_url: ZLINK, zoom_id: '81234567890', zoom_kind: 'meeting', zoom_start_url: START_URL, duration_min: 90 });
    expect(await hostStartUrl(rt, 'webinar:s1')).toBe(`${START_URL}&fresh=1`);
  });
  it('Check: ready, scopes, webinar availability, or the exact reason', async () => {
    const db = freshDb();
    expect((await zoomCheck(makeRt(db))).reason).toMatch(/Zoom API not connected/);
    stubZoom({ scope: 'meeting:write:meeting:admin meeting:read:meeting:admin webinar:read:list_webinars:admin', webinar: 'no-plan' });
    const ok = await zoomCheck(makeRt(db, ZOOM));
    expect(ok).toMatchObject({ ready: true, canCreate: true, canRefreshHostLink: true, webinars: false, reason: null });
    stubZoom({ tokenFail: true });
    const bad = await zoomCheck(makeRt(db, ZOOM));
    expect(bad.ready).toBe(false);
    expect(bad.reason).toBe('Zoom refused the credentials: Invalid client_id or client_secret. Check the client ID and secret.');
    stubZoom({ scope: 'user:read:user' });
    expect((await zoomCheck(makeRt(db, ZOOM))).reason).toBe('The Zoom app needs the meeting:write:meeting:admin scope to create meetings.');
  });
});

describe('host console', () => {
  const appFor = (settings: Record<string, string> = {}) => {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => { c.set('settings', { WEBINAR_DURATION_MIN: '90', ...settings } as never); c.set('reps', []); await next(); });
    app.route('/admin/api/live-events', liveEventsAdmin);
    app.get('/admin/live/:key', requireAdmin, liveHostPage);
    return app;
  };
  it('needs an admin session', async () => {
    const db = freshDb();
    const env = { DB: d1(db), ADMIN_PASSWORD: 'devpass', SECRET: 'x'.repeat(32) };
    const app = appFor();
    const page = await app.request('/admin/live/webinar:s1', {}, env);
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toBe('/admin/login');
    for (const [m, p] of [['GET', 'webinar:s1'], ['PUT', 'webinar:s1'], ['POST', 'webinar:s1/zoom'], ['GET', 'webinar:s1/start'], ['GET', 'zoom/check']]) {
      const res = await app.request(`/admin/api/live-events/${p}`, { method: m, headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: m === 'GET' ? undefined : '{}' }, env);
      expect(res.status, `${m} ${p}`).toBe(401);
    }
    // Cross-site writes are refused before auth.
    expect((await app.request('/admin/api/live-events/webinar:s1', { method: 'PUT', headers: { origin: 'https://evil.example' }, body: '{}' }, env)).status).toBe(403);
  });
});

describe('copy', () => {
  it('player, console and setup copy pass the copy rules', () => {
    const player = fs.readFileSync(`${node.cwd()}/public/assets/live-player.js`, 'utf8');
    const host = fs.readFileSync(`${node.cwd()}/public/assets/live-host.js`, 'utf8');
    const strings = [...player.matchAll(/'([A-Z][^'\n]{6,})'/g), ...host.matchAll(/'([A-Z][^'\n]{6,})'/g)].map((m) => m[1]).filter((s) => !/[{}<>=;]|^[A-Z_]+$/.test(s));
    expect(strings.length).toBeGreaterThan(10);
    const db = freshDb();
    const all = [...strings, ...ZOOM_STEPS, streamSetup(makeRt(db)).reason!, streamSetup(makeRt(db, { ZOOM_ACCOUNT_ID: 'a' })).reason!];
    for (const s of all) {
      expect(auditCopy(s), s).toEqual([]);
      expect(s, s).not.toMatch(/[—!]/);
    }
  });
});
