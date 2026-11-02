import { describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/app';
import { auditCopy } from '../src/content/copy-rules';
import { type Identity, join, newRoomState } from '../src/rooms/state';
import { MEDIA_COPY, PREVIEW_MS, RX_MAX_GAP_MS, accumulateRx, cleanReport, flushReports, flushRx, mediaReport, mergeReport, previewProxy, staffView, summarizeRx, type RxRow } from '../src/rooms/media';
import { SFU_BASE } from '../src/rooms/sfu';

/* Host diagnostics (round 3): can attendees see and hear the host, the host's banner and its cause, the camera
   self-check, the "How attendees see me" preview proxy, and the Funnel HQ totals (0075 room_media_rx). */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
interface Stmt { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): unknown }
interface DatabaseSync { prepare(sql: string): Stmt; exec(sql: string): void }
const node = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown; cwd(): string } }).process;
const fs = node.getBuiltinModule('node:fs') as { readFileSync(p: string, enc: string): string; readdirSync(p: string): string[] };
const { DatabaseSync } = node.getBuiltinModule('node:sqlite') as { DatabaseSync: new (path: string) => DatabaseSync };
const src = fs.readFileSync(`${node.cwd()}/public/assets/room-media-logic.js`, 'utf8');
const mod: { exports: Any } = { exports: {} };
new Function('module', src)(mod);
const L = mod.exports;

function d1(db: DatabaseSync) {
  const prepare = (sql: string) => {
    let args: unknown[] = [];
    const norm = () => args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? Number(a) : a)) as (string | number | null)[];
    const st = {
      sql,
      bind: (...a: unknown[]) => { args = a; return st; },
      all: async <T>() => ({ results: db.prepare(sql).all(...norm()) as T[] }),
      run: async () => { db.prepare(sql).run(...norm()); return { meta: {} }; },
    };
    return st;
  };
  return { prepare, batch: async (stmts: { run: () => Promise<unknown> }[]) => { for (const s of stmts) await s.run(); return []; } };
}
function freshDb(upTo = 9999) {
  const db = new DatabaseSync(':memory:');
  const dir = `${node.cwd()}/migrations`;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) if (Number(f.slice(0, 4)) <= upTo) db.exec(fs.readFileSync(`${dir}/${f}`, 'utf8'));
  return db;
}

// ───────────── an attendee's receive check ─────────────

const base = (o: Record<string, unknown> = {}) => ({ expectVideo: true, expectAudio: true, path: 'sfu', moqPlaying: false, tier: 0, pc: 'connected', pullErr: null, retries: 0, prev: null, at: 1000, ...o });
const vid = (frames: number, bytes: number, o: Record<string, unknown> = {}) => ({ pulled: true, live: true, frames, bytes, height: 360, fps: 30, ...o });
const aud = (bytes: number, o: Record<string, unknown> = {}) => ({ pulled: true, live: true, bytes, blocked: false, ...o });

describe('receiveSample: is the host arriving', () => {
  it('ok when frames and bytes grow, with the bitrate between samples', () => {
    const a = L.receiveSample(base({ video: vid(100, 100_000), audio: aud(5000) }));
    expect([a.v, a.a]).toEqual(['ok', 'ok']); // the first sample can't judge growth
    const b = L.receiveSample(base({ video: vid(160, 225_000), audio: aud(9000), prev: a, at: 3000 }));
    expect([b.v, b.vr, b.a, b.ar]).toEqual(['ok', null, 'ok', null]);
    expect(b.kbps).toBe(500);
    expect(b.height).toBe(360);
  });
  it('stalled when the host video is pulled but no new frames are decoded, or no new audio bytes arrive', () => {
    const a = L.receiveSample(base({ video: vid(100, 100_000), audio: aud(5000) }));
    const b = L.receiveSample(base({ video: vid(100, 100_000), audio: aud(5000), prev: a, at: 3000 }));
    expect([b.v, b.vr, b.a, b.ar]).toEqual(['no', 'stalled', 'no', 'stalled']);
    // A track the browser ended counts as stalled at once.
    expect(L.receiveSample(base({ video: vid(1, 1, { live: false }), audio: aud(1) })).vr).toBe('stalled');
  });
  it('not pulled: not_found (an SFU error), retrying, or pending', () => {
    const notPulled = { video: { pulled: false }, audio: { pulled: false } };
    expect(L.receiveSample(base({ ...notPulled, pullErr: 'not_found' }))).toMatchObject({ v: 'no', vr: 'not_found', a: 'no', ar: 'not_found' });
    expect(L.receiveSample(base({ ...notPulled, retries: 2 }))).toMatchObject({ vr: 'retrying', ar: 'retrying' });
    expect(L.receiveSample(base({ video: null, audio: null }))).toMatchObject({ vr: 'pending', ar: 'pending' });
  });
  it('their own state: audio only on a weak connection, a media connection down, the broadcast not playing', () => {
    expect(L.receiveSample(base({ tier: 3, video: vid(1, 1), audio: aud(1) }))).toMatchObject({ v: 'no', vr: 'audio_only', a: 'ok' });
    expect(L.receiveSample(base({ pc: 'failed', video: vid(1, 1), audio: aud(1) }))).toMatchObject({ vr: 'no_connection', ar: 'no_connection' });
    expect(L.receiveSample(base({ path: 'moq', moqPlaying: false }))).toMatchObject({ vr: 'moq_wait', ar: 'moq_wait' });
    expect(L.receiveSample(base({ path: 'moq', moqPlaying: true }))).toMatchObject({ v: 'ok', a: 'ok' });
  });
  it('autoplay: sound pulled but the browser keeps it off', () => {
    expect(L.receiveSample(base({ video: vid(1, 1), audio: aud(1, { blocked: true }) }))).toMatchObject({ v: 'ok', a: 'no', ar: 'autoplay' });
  });
  it('nothing expected: host camera or mic off gives na, never a badge', () => {
    const r = L.receiveSample(base({ expectVideo: false, expectAudio: false }));
    expect([r.v, r.a]).toEqual(['na', 'na']);
    expect(L.rxBadge(r)).toBeNull();
  });
});

describe('createReceiveWatch: a blip flags nobody', () => {
  it('a "no" counts after 6 s, an "ok" at once; the start of the trouble is kept', () => {
    const w = L.createReceiveWatch();
    expect(w.feed({ v: 'ok', a: 'ok' }, 0)).toMatchObject({ v: 'ok', changed: true });
    expect(w.feed({ v: 'no', vr: 'stalled', a: 'ok' }, 2000)).toMatchObject({ v: 'ok', changed: false });
    expect(w.feed({ v: 'no', vr: 'stalled', a: 'ok' }, 6000)).toMatchObject({ v: 'ok' });
    const r = w.feed({ v: 'no', vr: 'stalled', a: 'ok' }, 8000);
    expect(r).toMatchObject({ v: 'no', vr: 'stalled', vSince: 2000, changed: true });
    expect(w.feed({ v: 'no', vr: 'not_found', a: 'ok' }, 10000)).toMatchObject({ vr: 'not_found', changed: true });
    expect(w.feed({ v: 'ok', a: 'ok' }, 12000)).toMatchObject({ v: 'ok', vr: null, changed: true });
    // A 4 s blip after recovering stays ok.
    w.feed({ v: 'no', vr: 'stalled', a: 'ok' }, 14000);
    expect(w.feed({ v: 'ok', a: 'ok' }, 18000)).toMatchObject({ v: 'ok', changed: false });
  });
});

// ───────────── the host's banner ─────────────

const person = (id: string, rx: Record<string, unknown> | null, o: Record<string, unknown> = {}) => ({ id, role: 'attendee', level: 'good', at: 100_000, rx: rx ? { v: 'ok', vr: null, a: 'ok', ar: null, ...rx } : null, ...o });
const crowd = (n: number, bad: Record<string, unknown>, nBad: number, o: Record<string, unknown> = {}) =>
  Array.from({ length: n }, (_, i) => person(`a${i}`, i < nBad ? bad : {}, i < nBad ? o : {}));

describe('hostReach: who can see and hear the host, and why', () => {
  it('shows at 10 % or more, hides below; staff and stale or silent reports do not count', () => {
    const now = 100_000;
    expect(L.hostReach(crowd(20, { v: 'no', vr: 'stalled' }, 1), { now })).toMatchObject({ total: 20, affected: 1, show: false });
    const r = L.hostReach(crowd(20, { v: 'no', vr: 'stalled' }, 2), { now });
    expect(r).toMatchObject({ total: 20, affected: 2, noVideo: 2, noAudio: 0, share: 0.1, show: true });
    expect(r.ids).toEqual(['a0', 'a1']);
    const extra = [person('h', { v: 'no', vr: 'stalled' }, { role: 'cohost' }), person('old', { v: 'no', vr: 'stalled' }, { at: 1 }), person('nothing', null), person('na', { v: 'na', a: 'na' })];
    expect(L.hostReach([...crowd(20, {}, 0), ...extra], { now })).toMatchObject({ total: 20, affected: 0, show: false, cause: null });
  });
  it('the host camera stopped', () => {
    expect(L.hostReach(crowd(10, { v: 'no', vr: 'stalled' }, 5), { now: 100_000, self: { camOn: true, camLive: false } }).cause).toBe('camera');
  });
  it('the host video is not at the SFU (not_found), or the self-check sees a stall: upload', () => {
    expect(L.hostReach(crowd(10, { v: 'no', vr: 'not_found', a: 'no', ar: 'not_found' }, 4), { now: 100_000, self: { camOn: true, camLive: true } }).cause).toBe('upload');
    expect(L.hostReach(crowd(10, { v: 'no', vr: 'stalled' }, 4), { now: 100_000, self: { camOn: true, camLive: true, stalled: true } }).cause).toBe('upload');
    expect(L.hostReach(crowd(10, { v: 'no', vr: 'stalled' }, 4), { now: 100_000, self: { camOn: true, camLive: true, availOut: 200 } }).cause).toBe('upload');
  });
  it('autoplay: most can see but have the sound off', () => {
    expect(L.hostReach(crowd(10, { a: 'no', ar: 'autoplay' }, 3), { now: 100_000 }).cause).toBe('autoplay');
  });
  it('their network: audio only, connections down, or a weak level', () => {
    expect(L.hostReach(crowd(10, { v: 'no', vr: 'audio_only' }, 3), { now: 100_000, self: { availOut: 2500 } }).cause).toBe('network');
    expect(L.hostReach(crowd(10, { v: 'no', vr: 'stalled' }, 3, { level: 'bad' }), { now: 100_000, self: { availOut: 2500 } }).cause).toBe('network');
    expect(L.hostReach(crowd(10, { v: 'no', vr: 'stalled' }, 3), { now: 100_000, self: { availOut: 2500 } }).cause).toBe('network');
  });
  it('camera or mic on but never published for 15 s: shown even when nobody reports (they have nothing to receive)', () => {
    expect(L.hostReach([], { now: 100_000, self: { unsentMs: 14_000 } })).toMatchObject({ show: false, cause: null });
    expect(L.hostReach([], { now: 100_000, self: { unsentMs: 15_000 } })).toMatchObject({ show: true, cause: 'unsent', total: 0 });
    expect(L.hostReach(crowd(10, { a: 'no', ar: 'autoplay' }, 3), { now: 100_000, self: { unsentMs: 20_000 } }).cause).toBe('unsent');
  });
  it('a mixed picture is unknown', () => {
    const people = [person('a', { v: 'no', vr: 'pending' }), person('b', { a: 'no', ar: 'stalled' }), person('c', {}), person('d', {})];
    expect(L.hostReach(people, { now: 100_000, self: { availOut: 2500 } }).cause).toBe('unknown');
  });
  it('rxBadge says what and why', () => {
    expect(L.rxBadge({ v: 'no', vr: 'not_found', a: 'ok' })).toEqual({ key: 'cantSee', reason: 'not_found' });
    expect(L.rxBadge({ v: 'ok', a: 'no', ar: 'autoplay' })).toEqual({ key: 'cantHear', reason: 'autoplay' });
    expect(L.rxBadge({ v: 'no', vr: 'stalled', a: 'no', ar: 'stalled' })).toEqual({ key: 'cantBoth', reason: 'stalled' });
    expect(L.rxBadge(null)).toBeNull();
  });
});

// ───────────── the publisher self-check ─────────────

describe('createPublishWatch: the host camera reaches the SFU', () => {
  const live = { live: true, published: true, receipts: null, viewers: 0, missing: 0 };
  it('bytes growing: ok; flat for 10 s: republish once, then warn once, then quiet', () => {
    const w = L.createPublishWatch();
    let t = 0;
    expect(w.feed({ ...live, bytes: 1000 }, t).state).toBe('ok');
    for (t = 2000; t <= 8000; t += 2000) expect(w.feed({ ...live, bytes: 1000 + t }, t)).toMatchObject({ state: 'ok', action: null });
    // Bytes stop at 8 s.
    for (t = 10000; t < 18000; t += 2000) expect(w.feed({ ...live, bytes: 9000 }, t).action).toBeNull();
    const rp = w.feed({ ...live, bytes: 9000 }, 18000);
    expect(rp).toMatchObject({ state: 'stalled', action: 'republish', reason: 'no_bytes', autos: 1 });
    // After the republish the counters restart; still flat 10 s later: warn, once.
    w.feed({ ...live, bytes: 0 }, 20000);
    let warned = 0, again = 0;
    for (t = 22000; t <= 60000; t += 2000) { const r = w.feed({ ...live, bytes: 0 }, t); if (r.action === 'warn') warned++; if (r.action === 'republish') again++; }
    expect([warned, again]).toEqual([1, 0]);
  });
  it('no receiver reports from the SFU for 10 s while bytes still go out', () => {
    const w = L.createPublishWatch();
    w.feed({ ...live, bytes: 0, receipts: 3 }, 0);
    const out: Any[] = [];
    for (let t = 2000; t <= 12000; t += 2000) out.push(w.feed({ ...live, bytes: t * 10, receipts: 3 }, t));
    expect(out.map((r) => r.action)).toEqual([null, null, null, null, 'republish', null]);
    expect(out[4]).toMatchObject({ reason: 'no_receipts' });
  });
  it('most viewers report the video missing for 10 s', () => {
    const w = L.createPublishWatch();
    w.feed({ ...live, bytes: 0 }, 0);
    const out: Any[] = [];
    for (let t = 2000; t <= 14000; t += 2000) out.push(w.feed({ ...live, bytes: t, viewers: 4, missing: 0.75 }, t));
    expect(out.filter((r) => r.action === 'republish')).toHaveLength(1);
    expect(out.find((r) => r.action)).toMatchObject({ action: 'republish', reason: 'viewers' });
    // One viewer alone is not enough evidence.
    const w2 = L.createPublishWatch();
    w2.feed({ ...live, bytes: 0 }, 0);
    for (let t = 2000; t <= 30000; t += 2000) expect(w2.feed({ ...live, bytes: t, viewers: 1, missing: 1 }, t).action).toBeNull();
  });
  it('camera off or not published: idle, and the stall clock restarts', () => {
    const w = L.createPublishWatch();
    w.feed({ ...live, bytes: 5 }, 0);
    expect(w.feed({ ...live, live: false, bytes: 5 }, 9000).state).toBe('idle');
    expect(w.feed({ ...live, bytes: 5 }, 12000).action).toBeNull();
    expect(w.feed({ ...live, bytes: 5 }, 20000).action).toBeNull();
    expect(w.feed({ ...live, bytes: 5 }, 22000).action).toBe('republish');
  });
});

describe('previewStats', () => {
  it('resolution, frames per second and bitrate of the pulled-back video', () => {
    const a = L.previewStats([{ type: 'inbound-rtp', kind: 'video', bytesReceived: 0, frameWidth: 640, frameHeight: 360, framesPerSecond: 29.6, framesDecoded: 0 }], null, 0);
    const b = L.previewStats([{ type: 'inbound-rtp', kind: 'audio', bytesReceived: 9 }, { type: 'inbound-rtp', kind: 'video', bytesReceived: 125_000, frameWidth: 640, frameHeight: 360, framesPerSecond: 30, framesDecoded: 30 }], a, 1000);
    expect(b).toMatchObject({ width: 640, height: 360, fps: 30, kbps: 1000, frames: 30 });
    expect(L.previewStats([], null, 0)).toMatchObject({ width: null, kbps: null, frames: 0 });
  });
});

// ───────────── the server: reports, totals, Funnel HQ ─────────────

const m = { id: 'rann', name: 'Ann', role: 'attendee' as const, leadId: 'l1' };
const rep = (rx: Record<string, unknown> | null, o: Record<string, unknown> = {}) => cleanReport({ level: 'good', score: 90, tier: 0, rc: 0, path: 'sfu', os: 'mac', browser: 'chrome', rx, ...o })!;

describe('reports carry rx and pw', () => {
  it('cleans and bounds what the browser says', () => {
    const r = rep({ v: 'no', vr: '<script>', a: 'maybe', kbps: 9e9, h: -4, fps: 'x', rt: 3 }, { pw: { st: 'weird', why: 'hack', rp: 2 } });
    expect(r.rx).toEqual({ v: 'no', vr: 'stalled', a: 'na', ar: null, kbps: 100_000, h: 0, fps: null, rt: 3 });
    expect(r.pw).toEqual({ st: 'idle', why: null, rp: 2 });
    expect(rep(null).rx).toBeNull();
    expect(rep({ v: 'ok', vr: 'not_found', a: 'no', ar: 'autoplay' }).rx).toMatchObject({ vr: null, ar: 'autoplay' });
  });
  it('a change in what they receive goes to staff at once; staff see role, rx and pw', () => {
    const a = mergeReport(null, rep({ v: 'ok', a: 'ok' }), m, 0);
    const b = mergeReport(a.rec, rep({ v: 'ok', a: 'ok' }), m, 30_000);
    expect(b.changed).toBe(false);
    const c = mergeReport(b.rec, rep({ v: 'no', vr: 'not_found', a: 'ok' }), m, 33_000);
    expect(c.changed).toBe(true);
    expect(staffView(c.rec)).toMatchObject({ id: 'rann', role: 'attendee', rx: { v: 'no', vr: 'not_found', a: 'ok', ar: null }, pw: null });
  });
  it('totals: time without the host video or sound, episodes and the last reason; long gaps are capped', () => {
    let rec = mergeReport(null, rep({ v: 'ok', a: 'ok' }), m, 0).rec;
    rec = mergeReport(rec, rep({ v: 'no', vr: 'stalled', a: 'ok' }), m, 10_000).rec;
    rec = mergeReport(rec, rep({ v: 'no', vr: 'not_found', a: 'no', ar: 'autoplay' }), m, 40_000).rec;
    rec = mergeReport(rec, rep({ v: 'ok', a: 'no', ar: 'autoplay' }), m, 50_000).rec;
    rec = mergeReport(rec, rep({ v: 'no', vr: 'stalled', a: 'ok' }), m, 60_000).rec;
    rec = mergeReport(rec, rep({ v: 'ok', a: 'ok' }), m, 60_000 + 5 * 60_000).rec;
    expect(rec.rxAcc).toMatchObject({ noV: 30_000 + 10_000 + RX_MAX_GAP_MS, noA: 10_000 + 10_000, epV: 2, epA: 1, vr: 'stalled', ar: 'autoplay', seen: true });
    // No rx at all: nothing tracked.
    expect(mergeReport(null, rep(null), m, 0).rec.rxAcc).toBeUndefined();
    expect(accumulateRx(undefined, undefined, rep(null, { pw: { st: 'stalled', why: 'no_bytes', rp: 1 } }), 0)).toMatchObject({ rp: 1, seen: true });
  });
});

describe('Funnel HQ: per session, who could not see or hear the host', () => {
  it('flushRx writes room_media_rx (0075) and mediaReport sums it per session', async () => {
    const db = freshDb();
    const DB = d1(db) as unknown as D1Database;
    const host = { id: 'hadmin', name: 'Josh', role: 'host' as const, leadId: null };
    let h = mergeReport(null, rep(null, { pw: { st: 'ok', why: null, rp: 0 } }), host, 0).rec;
    h = mergeReport(h, rep(null, { pw: { st: 'stalled', why: 'no_bytes', rp: 1 } }), host, 20_000).rec;
    let a = mergeReport(null, rep({ v: 'no', vr: 'not_found', a: 'ok' }), m, 0).rec;
    a = mergeReport(a, rep({ v: 'ok', a: 'ok' }), m, 45_000).rec;
    let b = mergeReport(null, rep({ v: 'ok', a: 'no', ar: 'autoplay' }), { ...m, id: 'rbob', name: 'Bob' }, 0).rec;
    b = mergeReport(b, rep({ v: 'ok', a: 'ok' }), { ...m, id: 'rbob', name: 'Bob' }, 20_000).rec;
    const c = mergeReport(null, rep({ v: 'ok', a: 'ok' }), { ...m, id: 'rcat', name: 'Cat' }, 0).rec;
    expect(await flushReports(DB, 'rm1', [h, a, b, c])).toBe(4);
    // A second flush never lowers the totals.
    await flushRx(DB, 'rm1', [{ ...a, rxAcc: { ...a.rxAcc!, noV: 1000 } }]);
    const rt = { env: { DB } } as unknown as Runtime;
    const out = await mediaReport(rt, 'rm1');
    expect(out.rows).toHaveLength(4);
    expect(out.rx.summary).toMatchObject({ attendees: 3, cantSee: 1, cantSeeMs: 45_000, longestNoVideoMs: 45_000, cantHear: 1, cantHearMs: 20_000, republishes: 1 });
    expect(out.rx.summary.videoReasons).toEqual([{ reason: 'not_found', n: 1 }]);
    expect(out.rx.summary.audioReasons).toEqual([{ reason: 'autoplay', n: 1 }]);
    expect(out.rx.rows[0]).toMatchObject({ who: 'rann', no_video_ms: 45_000, video_episodes: 1, video_reason: 'not_found' });
  });
  it('without migration 0075 the quality rows still save and the report says what to apply', async () => {
    const db = freshDb(74);
    const DB = d1(db) as unknown as D1Database;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = mergeReport(null, rep({ v: 'no', vr: 'stalled', a: 'ok' }), m, 0).rec;
    expect(await flushReports(DB, 'rm1', [a])).toBe(1);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
    const out = await mediaReport({ env: { DB } } as unknown as Runtime, 'rm1');
    expect(out.rows).toHaveLength(1);
    expect(out.rx).toMatchObject({ rows: [], note: expect.stringContaining('0075') });
  });
  it('summarizeRx of nothing', () => {
    expect(summarizeRx([] as RxRow[])).toMatchObject({ attendees: 0, cantSee: 0, cantHear: 0, republishes: 0 });
  });
});

// ───────────── "How attendees see me": the preview proxy ─────────────

const SECRET = 'sfu-secret-NEVER-LEAK-0123456789';
const SETTINGS = { REALTIME_APP_ID: 'app123', REALTIME_APP_SECRET: SECRET };
const T0 = 1_000_000;
function room() {
  const st = newRoomState({ id: 'rmtest12345', mode: 'webinar', title: 'Live', startsAt: T0 });
  const ids: Identity[] = [{ id: 'hadmin', name: 'Josh', role: 'host' }, { id: 'rann', name: 'Ann', role: 'attendee', leadId: 'l1', regId: 'r1' }];
  for (const w of ids) join(st, w, T0);
  st.members.hadmin.sessionId = 'sessHost0001';
  st.members.hadmin.tracks = [{ trackName: 'hadmin-video', kind: 'video', mid: '1', simulcast: true }, { trackName: 'hadmin-audio', kind: 'audio', mid: '0', simulcast: false }];
  st.members.rann.sessionId = 'sessAnn00001';
  return st;
}
function stubSfu() {
  const seen: { path: string; method: string; body: Any }[] = [];
  let n = 0;
  const f = vi.fn(async (url: string, init: { method?: string; body?: string } = {}) => {
    const path = url.replace(`${SFU_BASE}/apps/app123/`, '');
    seen.push({ path, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
    const out = path === 'sessions/new' ? { sessionId: `sessPrev000${++n}` } : path.endsWith('tracks/new') ? { tracks: [{ trackName: 'hadmin-video', mid: '0' }], requiresImmediateRenegotiation: true, sessionDescription: { type: 'offer', sdp: 'v=0' } } : {};
    return new Response(JSON.stringify(out), { status: 200 });
  });
  return { f: f as unknown as typeof fetch, seen };
}

describe('previewProxy', () => {
  it('opens a second session for the host without replacing their main one, and pulls only their own tracks', async () => {
    const st = room();
    const { f, seen } = stubSfu();
    const s = await previewProxy(st, 'hadmin', 'session', { preview: true }, SETTINGS, T0, f);
    expect(s).toMatchObject({ status: 200, changed: false, body: { ok: true, sessionId: 'sessPrev0001', until: T0 + PREVIEW_MS } });
    expect(st.members.hadmin.sessionId).toBe('sessHost0001');
    expect(st.members.hadmin.tracks).toHaveLength(2);
    const pull = { preview: true, sessionId: 'sessPrev0001', tracks: [{ location: 'remote', sessionId: 'sessHost0001', trackName: 'hadmin-video', simulcast: { preferredRid: 'h' } }] };
    const t = await previewProxy(st, 'hadmin', 'tracks', pull, SETTINGS, T0 + 1000, f);
    expect(t.status).toBe(200);
    expect(seen.at(-1)).toMatchObject({ path: 'sessions/sessPrev0001/tracks/new', body: { tracks: [{ location: 'remote', sessionId: 'sessHost0001', trackName: 'hadmin-video', simulcast: { preferredRid: 'h' } }] } });
    expect(JSON.stringify(t.body)).not.toContain(SECRET);
    // Someone else's track, a track not published, or a local publish: refused before any SFU call.
    const before = seen.length;
    expect((await previewProxy(st, 'hadmin', 'tracks', { ...pull, tracks: [{ location: 'remote', sessionId: 'sessAnn00001', trackName: 'rann-video' }] }, SETTINGS, T0, f)).status).toBe(403);
    expect((await previewProxy(st, 'hadmin', 'tracks', { ...pull, tracks: [{ location: 'remote', sessionId: 'sessHost0001', trackName: 'hadmin-screen' }] }, SETTINGS, T0, f)).status).toBe(403);
    expect((await previewProxy(st, 'hadmin', 'tracks', { ...pull, tracks: [{ location: 'local', trackName: 'hadmin-video', mid: '0' }] }, SETTINGS, T0, f)).status).toBe(403);
    // The main session id is not a preview session.
    expect((await previewProxy(st, 'hadmin', 'tracks', { ...pull, sessionId: 'sessHost0001' }, SETTINGS, T0, f)).status).toBe(403);
    expect(seen.length).toBe(before);
    // Renegotiate, switch layer, close.
    expect((await previewProxy(st, 'hadmin', 'renegotiate', { sessionId: 'sessPrev0001', sessionDescription: { type: 'answer', sdp: 'v=0' } }, SETTINGS, T0, f)).status).toBe(200);
    expect((await previewProxy(st, 'hadmin', 'renegotiate', { sessionId: 'sessPrev0001', sessionDescription: { type: 'offer', sdp: 'v=0' } }, SETTINGS, T0, f)).status).toBe(400);
    expect((await previewProxy(st, 'hadmin', 'update', { sessionId: 'sessPrev0001', tracks: [{ location: 'remote', sessionId: 'sessHost0001', trackName: 'hadmin-video', mid: '0', simulcast: { preferredRid: 'q' } }] }, SETTINGS, T0, f)).status).toBe(200);
    expect(seen.at(-1)).toMatchObject({ method: 'PUT', path: 'sessions/sessPrev0001/tracks/update' });
    expect((await previewProxy(st, 'hadmin', 'close', { sessionId: 'sessPrev0001', tracks: [{ mid: '0' }] }, SETTINGS, T0, f)).status).toBe(200);
    expect(seen.at(-1)).toMatchObject({ method: 'PUT', path: 'sessions/sessPrev0001/tracks/close', body: { force: true } });
    // Closed: the preview session is gone.
    expect((await previewProxy(st, 'hadmin', 'tracks', pull, SETTINGS, T0, f)).status).toBe(403);
  });
  it('expires after PREVIEW_MS; attendees off stage cannot open one', async () => {
    const st = room();
    const { f } = stubSfu();
    await previewProxy(st, 'hadmin', 'session', {}, SETTINGS, T0, f);
    const pull = { sessionId: 'sessPrev0001', tracks: [{ location: 'remote', sessionId: 'sessHost0001', trackName: 'hadmin-audio' }] };
    expect((await previewProxy(st, 'hadmin', 'tracks', pull, SETTINGS, T0 + PREVIEW_MS + 1, f)).status).toBe(403);
    expect((await previewProxy(st, 'rann', 'session', {}, SETTINGS, T0, f)).status).toBe(403);
  });
  it('the room routes preview calls to it (one line in do.ts) and room.js reports pull errors', () => {
    const doTs = fs.readFileSync(`${node.cwd()}/src/rooms/do.ts`, 'utf8');
    expect(doTs).toContain('body.preview === true ? await previewProxy(');
    const room = fs.readFileSync(`${node.cwd()}/public/assets/room.js`, 'utf8');
    expect(room).toContain("emit('pull_err'");
    const media = fs.readFileSync(`${node.cwd()}/public/assets/room-media.js`, 'utf8');
    for (const s of ["R.on('pull_err'", 'preview: true', 'hostReach(', 'createPublishWatch()', "mediaRebuild('selfcheck')", 'rx: HD.rx, pw: HD.pw']) expect(media).toContain(s);
  });
});

describe('copy', () => {
  it('passes the copy rules', () => {
    const strings: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === 'string') strings.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(MEDIA_COPY.hd);
    expect(strings.length).toBeGreaterThan(30);
    for (const s of strings) {
      expect(auditCopy(s), s).toEqual([]);
      expect(s, s).not.toMatch(/[—!]/);
    }
  });
});
