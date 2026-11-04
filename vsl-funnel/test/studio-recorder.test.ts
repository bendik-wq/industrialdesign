import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { STUDIO_COPY, STUDIO_CSP, STUDIO_PERMISSIONS, studioPage } from '../src/admin/studio';
import { auditCopy } from '../src/content/copy-rules';
// @ts-expect-error vite raw import of a browser script
import coreSrc from '../public/assets/studio-core.js?raw';
// @ts-expect-error vite raw import of a browser script
import pageJs from '../public/assets/studio.js?raw';

// Funnel HQ → Studio, the recorder (builder A): the pure logic in public/assets/studio-core.js, and the page route
// /admin/studio (auth, guest read-only, CSP and permissions for camera, mic and screen capture).

const mod: { exports: any } = { exports: {} };
new Function('module', coreSrc as string)(mod);
const C = mod.exports;

describe('output size, bitrate and container', () => {
  it('records at the source resolution, capped at 3840x2160, never upscaled, even sizes', () => {
    expect(C.outputSize('orbit', 1920, 1080)).toEqual({ w: 1920, h: 1080 });
    expect(C.outputSize('orbit', 3840, 2160)).toEqual({ w: 3840, h: 2160 });
    expect(C.outputSize('orbit', 5120, 2880)).toEqual({ w: 3840, h: 2160 });
    expect(C.outputSize('orbit', 1366, 768)).toEqual({ w: 1366, h: 768 });
    expect(C.outputSize('split', 1365, 767)).toEqual({ w: 1364, h: 766 });
    expect(C.outputSize('stage', 3440, 1440)).toEqual({ w: 3440, h: 1440 });
    expect(C.outputSize('stage', 6000, 1500)).toEqual({ w: 3840, h: 960 });
  });
  it('vertical is 1080x1920, or 2160x3840 when the source is 4K', () => {
    expect(C.outputSize('vertical', 1920, 1080)).toEqual({ w: 1080, h: 1920 });
    expect(C.outputSize('vertical', 2560, 1440)).toEqual({ w: 1080, h: 1920 });
    expect(C.outputSize('vertical', 3840, 2160)).toEqual({ w: 2160, h: 3840 });
  });
  it('about 0.1 bit per pixel per frame, between 8 and 45 Mbps', () => {
    expect(C.bitrateFor(1920, 1080, 30)).toBe(8e6);
    expect(C.bitrateFor(1920, 1080, 60)).toBe(12441600);
    expect(C.bitrateFor(3840, 2160, 30)).toBe(24883200);
    expect(C.bitrateFor(3840, 2160, 60)).toBe(45e6);
  });
  it('prefers MP4 H.264 High + AAC, then WebM VP9/Opus', () => {
    expect(C.pickMime(() => true, 1920, 1080, 30)).toBe('video/mp4;codecs=avc1.640033,mp4a.40.2');
    expect(C.pickMime(() => true, 3840, 2160, 60)).toBe('video/mp4;codecs=avc1.640034,mp4a.40.2');
    expect(C.pickMime((t: string) => t.startsWith('video/webm'), 1920, 1080, 30)).toBe('video/webm;codecs=vp9,opus');
    expect(C.pickMime(() => { throw new Error('x'); }, 1920, 1080, 30)).toBe('');
    expect(C.extFor('video/mp4;codecs=avc1')).toBe('mp4');
    expect(C.extFor('video/webm')).toBe('webm');
  });
});

describe('layouts', () => {
  const W = 1920, H = 1080;
  const inside = (r: { x: number; y: number; w: number; h: number }, w = W, h = H) => r.x >= -0.01 && r.y >= -0.01 && r.x + r.w <= w + 0.01 && r.y + r.h <= h + 0.01;
  it('the six fixed ids, keys 1 to 6', () => {
    expect(C.IDS).toEqual(['orbit', 'split', 'spotlight', 'stage', 'vertical', 'cinema']);
    expect(C.LAYOUTS.map((l: { key: string }) => l.key)).toEqual(['1', '2', '3', '4', '5', '6']);
  });
  it('orbit: a circular bubble in the chosen corner, S < M < L, the screen full bleed', () => {
    const sizes = ['s', 'm', 'l'].map((size) => C.layoutGeometry('orbit', W, H, { size, corner: 'br' }).face.w);
    expect(sizes[0]).toBeLessThan(sizes[1]); expect(sizes[1]).toBeLessThan(sizes[2]);
    for (const corner of ['tl', 'tr', 'bl', 'br']) {
      const g = C.layoutGeometry('orbit', W, H, { corner, size: 'l' });
      expect(g.face.w).toBe(g.face.h); expect(g.face.r).toBe(g.face.w / 2); expect(g.face.ring).toBe(1);
      expect(inside(g.face)).toBe(true);
      expect(C.nearestCorner(g.face.x + g.face.w / 2, g.face.y + g.face.h / 2, W, H)).toBe(corner);
      expect(g.screen).toMatchObject({ x: 0, y: 0, w: W, h: H });
    }
    // 4K: the same composition at twice the detail
    const k = C.layoutGeometry('orbit', 3840, 2160, { corner: 'br', size: 'm' });
    expect(k.face.w).toBeCloseTo(2 * C.layoutGeometry('orbit', W, H, { corner: 'br', size: 'm' }).face.w);
  });
  it('split: the screen card in the left ~68%, a tall portrait face card right with a lower third', () => {
    const g = C.layoutGeometry('split', W, H, { srcAspect: 16 / 9 });
    expect(inside(g.screen)).toBe(true); expect(inside(g.face)).toBe(true);
    expect(g.screen.x + g.screen.w).toBeLessThan(W * 0.68);
    expect(g.screen.x + g.screen.w).toBeGreaterThan(W * 0.6);
    expect(g.face.x).toBeGreaterThan(W * 0.68);
    expect(g.face.h).toBeGreaterThan(g.face.w * 1.5);
    expect(g.screen.w / g.screen.h).toBeCloseTo(16 / 9);
    expect(g.lt.op).toBe(1);
  });
  it('spotlight: the face fills the frame left of centre, the screen is a tilted glass card on the right', () => {
    const g = C.layoutGeometry('spotlight', W, H, { srcAspect: 16 / 9, camAspect: 16 / 9 });
    expect(g.face.x).toBeLessThanOrEqual(0); expect(g.face.y).toBeLessThanOrEqual(0);
    expect(g.face.x + g.face.w / 2).toBeLessThan(W / 2); // the face sits left, the card right
    expect(g.face.x + g.face.w).toBeGreaterThanOrEqual(W * 0.95); // any sliver left is under the grade's darkest part expect(g.face.y + g.face.h).toBeGreaterThanOrEqual(H);
    expect(g.screen.tilt).not.toBe(0); expect(g.screen.x).toBeGreaterThan(W / 2 - 50); expect(inside(g.screen)).toBe(true);
    expect(g.faceTop).toBe(false); expect(g.grade).toBe(1);
  });
  it('stage: screen full bleed, a wide presenter card bottom left', () => {
    const g = C.layoutGeometry('stage', W, H, {});
    expect(g.face.w / g.face.h).toBeCloseTo(16 / 9);
    expect(g.face.x).toBeLessThan(W * 0.1); expect(g.face.y + g.face.h).toBeGreaterThan(H * 0.9); expect(inside(g.face)).toBe(true);
  });
  it('cinema: a 2.39:1 picture between bars, a small face inset inside it, a title band below', () => {
    const g = C.layoutGeometry('cinema', W, H, {});
    expect(g.screen.w / g.screen.h).toBeCloseTo(2.39, 2);
    expect(g.face.y + g.face.h).toBeLessThanOrEqual(g.screen.y + g.screen.h);
    expect(g.face.w).toBeLessThan(W * 0.2);
    expect(g.band.y).toBeCloseTo(g.screen.y + g.screen.h); expect(g.band.op).toBe(1); expect(g.bgDark).toBe(1);
  });
  it('vertical: face in the top half, the cropped screen card below', () => {
    const g = C.layoutGeometry('vertical', 1080, 1920, {});
    expect(g.face).toMatchObject({ x: 0, y: 0, w: 1080, h: 960 });
    expect(g.screen.y).toBeGreaterThan(900); expect(inside(g.screen, 1080, 1920)).toBe(true);
    expect(C.verticalCropAspect()).toBeCloseTo(g.screen.w / g.screen.h);
  });
  it('the morph interpolates every number and lands exactly on the target', () => {
    const a = C.layoutGeometry('orbit', W, H, { corner: 'br' }), b = C.layoutGeometry('split', W, H, { srcAspect: 16 / 9 });
    const mid = C.lerpGeom(a, b, 0.5);
    expect(mid.face.w).toBeCloseTo((a.face.w + b.face.w) / 2);
    expect(C.lerpGeom(a, b, 1)).toEqual(b);
    expect(C.spring(0)).toBe(0); expect(C.spring(1)).toBe(1);
    let max = 0; for (let t = 0; t <= 1; t += 0.01) max = Math.max(max, C.spring(t));
    expect(max).toBeGreaterThan(1); expect(max).toBeLessThan(1.06); // a spring, not a bounce
    expect(C.MORPH_MS).toBeGreaterThanOrEqual(250); expect(C.MORPH_MS).toBeLessThanOrEqual(400);
  });
  it('perspective strips: contiguous columns, the near edge taller, flat when not tilted', () => {
    const rect = { x: 1000, y: 200, w: 800, h: 450 };
    const flat = C.tiltStrips(rect, 0, 40);
    expect(flat.strips.reduce((s: number, p: { w: number }) => s + p.w, 0)).toBeCloseTo(800);
    expect(flat.scaleL).toBeCloseTo(1); expect(flat.scaleR).toBeCloseTo(1);
    const t = C.tiltStrips(rect, -17, 96);
    expect(t.scaleR).toBeGreaterThan(1); expect(t.scaleL).toBeLessThan(1);
    for (let i = 1; i < t.strips.length; i++) expect(t.strips[i].x).toBeCloseTo(t.strips[i - 1].x + t.strips[i - 1].w);
    expect(t.strips[0].u0).toBe(0); expect(t.strips[95].u1).toBe(1);
  });
  it('face framing and crop regions stay inside the source and keep their aspect', () => {
    const f = C.faceSource(1920, 1080, 1);
    expect(f.w / f.h).toBeCloseTo(1); expect(f.x).toBeGreaterThanOrEqual(0); expect(f.y + f.h).toBeLessThanOrEqual(1080);
    expect(f.y + f.h / 2).toBeLessThan(540); // a touch above centre
    const r = C.placeRegion(1920, 1080, 1.4, 0.5, 0.99, 0.01);
    expect(r.x + r.w).toBeLessThanOrEqual(1); expect(r.y).toBeGreaterThanOrEqual(0);
    expect((r.w * 1920) / (r.h * 1080)).toBeCloseTo(1.4);
    const s = C.coverSource(1920, 1080, 2.39, 0.5, 0.5, 1, { x: 0, y: 0, w: 1, h: 1 });
    expect(s.w / s.h).toBeCloseTo(2.39); expect(s.w).toBe(1920);
    const z = C.coverSource(1920, 1080, 16 / 9, 0.5, 0.5, 1, C.zoomRegion(0.9, 0.9, 2));
    expect(z.w).toBeCloseTo(960); expect(z.x + z.w).toBeLessThanOrEqual(1920.001);
  });
});

describe('markers, clock, prompter', () => {
  it('numbers chapters, rounds time, ignores unknown kinds', () => {
    let m: { t: number; kind: string; label?: string }[] = [];
    m = C.addMarker(m, 'chapter', 3.14159); m = C.addMarker(m, 'retake', 9.99); m = C.addMarker(m, 'chapter', 20); m = C.addMarker(m, 'oops', 21);
    expect(m).toEqual([{ t: 3.1, kind: 'chapter', label: 'Chapter 1' }, { t: 10, kind: 'retake' }, { t: 20, kind: 'chapter', label: 'Chapter 2' }]);
    expect(C.fmtTime(0)).toBe('0:00'); expect(C.fmtTime(65.9)).toBe('1:05'); expect(C.fmtTime(3725)).toBe('1:02:05');
  });
  it('the clock leaves out paused time', () => {
    let now = 1000; const k = new C.Clock(() => now);
    k.begin(); now += 5000; k.pause(); now += 7000; expect(k.elapsed()).toBe(5); k.resume(); now += 2000;
    expect(k.elapsed()).toBe(7);
  });
  it('beats from a script or pasted notes; vertical never mixes with landscape', () => {
    const b = C.normaliseBeats([{ layout: 'split', text: ' Hi ', cue: 'smile' }, { layout: 'nope', text: 'x' }, { text: '' }], 'orbit');
    expect(b).toEqual([{ layout: 'split', text: 'Hi', cue: 'smile' }, { layout: 'orbit', text: 'x', cue: '' }]);
    expect(C.beatsFromText('One\nline\n\nTwo', 'stage').map((x: { text: string }) => x.text)).toEqual(['One line', 'Two']);
    expect(C.layoutForBeat({ layout: 'vertical' }, 'orbit')).toBe('orbit');
    expect(C.layoutForBeat({ layout: 'cinema' }, 'orbit')).toBe('cinema');
    expect(C.layoutForBeat({ layout: 'cinema' }, 'vertical')).toBe('vertical');
  });
});

describe('exact-size parts', () => {
  const bytes = (n: number, start: number) => new Blob([Uint8Array.from({ length: n }, (_, i) => (start + i) % 251)]);
  it('cuts exact partSize parts from uneven chunks, in order, with the remainder last', async () => {
    const b = new C.PartBuffer(1000);
    let pos = 0; const parts: { n: number; blob: Blob; last: boolean }[] = [];
    for (const n of [300, 900, 50, 2000, 7, 1234]) { b.push(bytes(n, pos)); pos += n; let p; while ((p = b.take())) parts.push(p); }
    const last = b.flush(); if (last) parts.push(last);
    expect(parts.map((p) => p.n)).toEqual([1, 2, 3, 4, 5]);
    expect(parts.slice(0, -1).every((p) => p.blob.size === 1000 && !p.last)).toBe(true);
    expect(parts[4].blob.size).toBe(pos - 4000); expect(parts[4].last).toBe(true);
    const all = new Uint8Array(await new Blob(parts.map((p) => p.blob)).arrayBuffer());
    expect(all.length).toBe(pos);
    expect(all.every((v, i) => v === i % 251)).toBe(true);
    expect(b.flush()).toBeNull();
  });
  it('backoff grows to 30 s; network, 408, 429 and 5xx retry, other 4xx do not', () => {
    expect(C.backoff(1, 0.5)).toBe(1000); expect(C.backoff(3, 0.5)).toBe(4000); expect(C.backoff(12, 0.5)).toBe(30000);
    expect([0, 408, 429, 500, 503].every(C.retriable)).toBe(true);
    expect([400, 401, 403, 404, 413].some(C.retriable)).toBe(false);
  });

  type Call = { method: string; path: string; size?: number; body?: string };
  function fakeServer(script: (c: Call, i: number) => { status: number; json?: unknown } | Error = () => ({ status: 200 })) {
    const calls: Call[] = [];
    const request = async (method: string, path: string, body: unknown) => {
      const c: Call = { method, path };
      if (body instanceof Blob) c.size = body.size; else if (typeof body === 'string') c.body = body;
      calls.push(c);
      const r = script(c, calls.length - 1);
      if (r instanceof Error) throw r;
      if (/\/uploads$/.test(path) && r.status === 200 && !r.json) return { status: 200, json: { id: 'vid1', partSize: 1000 } };
      return { status: r.status, json: r.json ?? (r.status === 200 && /\/parts\//.test(path) ? { n: Number(path.split('/').pop()), etag: 'e' } : {}) };
    };
    return { calls, deps: { request, sleep: async () => {}, onState: () => {} } };
  }
  it('uploads parts in order while recording, then the last part, then complete with duration and markers', async () => {
    const s = fakeServer();
    const up = new C.Uploader({ title: 'T', layout: 'orbit', mime: 'video/mp4', width: 1920, height: 1080 }, s.deps);
    up.push(bytes(600, 0)); // before the session answers: waits in memory
    await up.start();
    up.push(bytes(1700, 600)); await up.pump();
    expect(s.calls.filter((c) => c.method === 'PUT').map((c) => c.path)).toEqual(['/admin/api/studio/uploads/vid1/parts/1', '/admin/api/studio/uploads/vid1/parts/2']);
    up.push(bytes(50, 2300));
    const r = await up.finish(12.345, [{ t: 3, kind: 'chapter', label: 'Chapter 1' }]);
    expect(r).toEqual({ ok: true, id: 'vid1' });
    const puts = s.calls.filter((c) => c.method === 'PUT');
    expect(puts.map((c) => c.size)).toEqual([1000, 1000, 350]);
    expect(JSON.parse(s.calls[0].body!)).toMatchObject({ title: 'T', layout: 'orbit', width: 1920, height: 1080 });
    const done = s.calls[s.calls.length - 1];
    expect(done.path).toBe('/admin/api/studio/uploads/vid1/complete');
    expect(JSON.parse(done.body!)).toEqual({ duration_s: 12.3, markers: [{ t: 3, kind: 'chapter', label: 'Chapter 1' }] });
    expect(up.state()).toMatchObject({ done: true, acked: 3, bytesAcked: 2350, bytesIn: 2350 });
  });
  it('retries a part after network errors and 503s, keeping the order', async () => {
    let fails = 0;
    const s = fakeServer((c) => (c.path.endsWith('/parts/2') && fails++ < 3 ? (fails === 1 ? new Error('offline') : { status: 503 }) : { status: 200 }));
    const up = new C.Uploader({}, s.deps);
    await up.start(); up.push(bytes(2500, 0));
    const r = await up.finish(3, []);
    expect(r.ok).toBe(true);
    expect(s.calls.filter((c) => c.method === 'PUT').map((c) => c.path.split('/').pop())).toEqual(['1', '2', '2', '2', '2', '3']);
  });
  it('stops on a refusal (guest, gone) and carries on from the first unconfirmed part on retry', async () => {
    let refuse = true;
    const s = fakeServer((c) => (c.path.endsWith('/parts/2') && refuse ? { status: 403, json: { error: 'read only' } } : { status: 200 }));
    const up = new C.Uploader({}, s.deps);
    await up.start(); up.push(bytes(2200, 0));
    const r = await up.finish(5, []);
    expect(r).toMatchObject({ ok: false, error: 'read only' });
    expect(s.calls.some((c) => c.path.endsWith('/complete'))).toBe(false);
    refuse = false;
    const again = await up.retry(5, []);
    expect(again.ok).toBe(true);
    expect(s.calls.filter((c) => c.method === 'PUT').map((c) => c.path.split('/').pop())).toEqual(['1', '2', '2', '3']);
  });
  it('resumes an earlier session: parts already confirmed are not sent again', async () => {
    const s = fakeServer();
    const up = new C.Uploader({}, s.deps, { id: 'old', partSize: 1000, skipThrough: 2 });
    up.push(bytes(2600, 0));
    const r = await up.finish(9, []);
    expect(r).toEqual({ ok: true, id: 'old' });
    expect(s.calls.map((c) => c.method + ' ' + c.path.replace('/admin/api/studio/uploads', ''))).toEqual(['PUT /old/parts/3', 'POST /old/complete']);
  });
  it('nothing recorded: no complete', async () => {
    const s = fakeServer();
    const up = new C.Uploader({}, s.deps);
    const r = await up.finish(0, []);
    expect(r).toMatchObject({ ok: false, empty: true });
    expect(s.calls.map((c) => c.method)).toEqual(['POST']);
  });
});

describe('page copy and browser script', () => {
  it('every fixed message passes the copy rules', () => {
    for (const v of Object.values(STUDIO_COPY)) expect(auditCopy(v), v).toEqual([]);
    const visible = studioPage({ guest: false }).replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, '\n').split('\n').map((x) => x.trim()).filter((x) => x.length > 3);
    for (const line of visible) expect(auditCopy(line), line).toEqual([]);
    const strings = [...(pageJs as string).matchAll(/(?:toast|note|status)\('([^']{6,})'/g)].map((m) => m[1]);
    expect(strings.length).toBeGreaterThan(10);
    for (const s of strings) { expect(auditCopy(s), s).toEqual([]); expect(s).not.toMatch(/[—!]/); }
  });
  it('the page holds the mount points, the view switcher and both modules', () => {
    const html = studioPage({ guest: false });
    for (const s of ['id="studio-pipeline"', 'id="studio-scripts"', 'id="studio-record"', 'src="/assets/studio-core.js"', 'src="/assets/studio.js"', '<script type="module" src="/assets/studio-pipeline.js">', '<script type="module" src="/assets/studio-scripts.js">', 'href="/assets/studio-board.css"', 'href="/assets/glass.css"'])
      expect(html, s).toContain(s);
    for (const v of ['record', 'pipeline', 'scripts']) expect(html).toContain(`data-view="${v}"`);
    for (const id of C.IDS) expect(html).toContain(`data-layout="${id}"`);
    expect(html).not.toContain('data-guest');
    expect(studioPage({ guest: true })).toContain('data-guest="1"');
    expect(pageJs).toContain('window.studio = { show: show');
    expect(pageJs).toContain("'studio:use-script'");
    expect(pageJs).toContain("'studio:uploaded'");
  });
});

// ───────────── the route, on the whole worker with an in-memory D1 ─────────────

interface SqlStmt { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } }
interface SqlDb { prepare(sql: string): SqlStmt; exec(sql: string): void }
const nodeP = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown; cwd(): string } }).process;
const { DatabaseSync } = nodeP.getBuiltinModule('node:sqlite') as { DatabaseSync: new (path: string) => SqlDb };
const nfs = nodeP.getBuiltinModule('node:fs') as { readdirSync(p: string): string[]; readFileSync(p: string, enc: string): string };
function d1(db: SqlDb) {
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
  return { prepare, batch: async (stmts: { sql: string; run: () => Promise<unknown>; all: () => Promise<unknown> }[]) => { const out = []; for (const s of stmts) out.push(/^\s*select|\breturning\b/i.test(s.sql) ? await s.all() : await s.run()); return out; } };
}
function freshDb() {
  const db = new DatabaseSync(':memory:');
  const dir = `${nodeP.cwd()}/migrations`;
  for (const f of nfs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(nfs.readFileSync(`${dir}/${f}`, 'utf8'));
  return db;
}
const ORIGIN = 'https://apply.test';
let sdb: SqlDb;
const exCtx = { waitUntil: (p: Promise<unknown>) => { p.catch(() => null); }, passThroughOnException: () => {} };
const envFor = () => ({
  DB: d1(sdb), SESSION_SECRET: 'env-session-secret-'.padEnd(40, 'z'), ADMIN_PASSWORD: 'devpass-owner-only',
  ASSETS: { fetch: async () => new Response('<!doctype html><html><body></body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }) },
});
type App = { fetch: (r: Request, e: unknown, c: unknown) => Promise<Response> };
let app: App;
const call = (path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  if (!headers.has('cf-connecting-ip')) headers.set('cf-connecting-ip', '198.51.100.9');
  return app.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }), envFor(), exCtx);
};
const same = { origin: ORIGIN, 'sec-fetch-site': 'same-origin' };
const cookieOf = (res: Response, name: string) => (res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? '']).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`) && c.length > name.length + 1) ?? '';

beforeAll(async () => {
  vi.stubGlobal('HTMLRewriter', class { on() { return this; } transform(r: Response) { return r; } });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"offline"}', { status: 503 })));
  app = (await import('../src/index')).default as unknown as App;
}, 60_000);
beforeEach(async () => {
  sdb = freshDb();
  (await import('../src/settings')).resetSettingsCache();
  (await import('../src/admin/guest')).resetGuestCaches();
});

describe('/admin/studio', () => {
  it('signed out: to the login page', async () => {
    const r = await call('/admin/studio');
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/admin/login');
  });
  it('the owner: the page, with a CSP and permissions for camera, mic and screen capture', async () => {
    const login = await call('/admin/login', { method: 'POST', headers: { ...same, 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=devpass-owner-only' });
    const owner = cookieOf(login, '_fa');
    expect(owner).not.toBe('');
    const r = await call('/admin/studio', { headers: { cookie: owner } });
    expect(r.status).toBe(200);
    const csp = r.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).toContain("media-src 'self' blob: mediastream:");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(r.headers.get('permissions-policy')).toBe(STUDIO_PERMISSIONS);
    expect(STUDIO_PERMISSIONS).toMatch(/camera=\(self\).*microphone=\(self\).*display-capture=\(self\)/);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    const html = await r.text();
    expect(html).toContain('id="studio-pipeline"');
    expect(html).not.toContain('data-guest');
    expect(csp.startsWith(STUDIO_CSP)).toBe(true); // only report directives are appended
  });
  it('a guest: the same page, read-only', async () => {
    const login = await call('/admin/login', { method: 'POST', headers: { ...same, 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=devpass-owner-only' });
    const owner = cookieOf(login, '_fa');
    const inv = await call('/admin/api/guest-access', { method: 'POST', headers: { ...same, 'content-type': 'application/json', cookie: owner }, body: JSON.stringify({ label: 'Viewer', days: 7, maskPii: false }) });
    const path = new URL(((await inv.json()) as { url: string }).url).pathname;
    const g = cookieOf(await call(path, { headers: { 'sec-fetch-site': 'cross-site' } }), '_fg');
    expect(g).not.toBe('');
    const r = await call('/admin/studio', { headers: { cookie: g } });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('data-guest="1"');
  });
});
