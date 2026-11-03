import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/app';
import { auditCopy } from '../src/content/copy-rules';
import { type BrowserLike, type PageLike, setBrowserLauncher } from '../src/infra/browser';
import { STREAM_COPY, iframeSrc, refreshStream, sendToStream, streamConfig, streamVideoSrc, syncStreamCopies } from '../src/infra/cf-stream';
import { checkPdfRenderToken, pdfLink, pdfRenderToken } from '../src/infra/pdf';
import { signedFileUrl, verifySignedFile } from '../src/infra/signed-files';
import { ROOM_TARGET_NAME, WATCH_TARGETS, checkPage, maybeRunWatchdog, runWatchdog, watchdogReport } from '../src/infra/watchdog';
import { KV_SETTINGS_KEY, KV_SETTINGS_TTL_S, SETTINGS as SETTING_DEFS, loadSettings, resetSettingsCache, saveSettings } from '../src/settings';

// ───────────── a real SQLite database shaped like D1, with every migration applied ─────────────
interface Stmt { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } }
interface DatabaseSync { prepare(sql: string): Stmt; exec(sql: string): void }
const node = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown; cwd(): string } }).process;
const { DatabaseSync } = node.getBuiltinModule('node:sqlite') as { DatabaseSync: new (path: string) => DatabaseSync };
const fs = node.getBuiltinModule('node:fs') as { readdirSync(p: string): string[]; readFileSync(p: string, enc: string): string };
let sqls: string[] = [];
function d1(db: DatabaseSync) {
  const prepare = (sql: string) => {
    let args: unknown[] = [];
    const norm = () => args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? Number(a) : a)) as (string | number | null)[];
    const st = {
      sql,
      bind: (...a: unknown[]) => { args = a; return st; },
      first: async <T>() => { sqls.push(sql); return (db.prepare(sql).get(...norm()) as T | undefined) ?? null; },
      all: async <T>() => { sqls.push(sql); return { results: db.prepare(sql).all(...norm()) as T[] }; },
      run: async () => { sqls.push(sql); const r = db.prepare(sql).run(...norm()); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
    };
    return st;
  };
  return { prepare, batch: async (stmts: { sql: string; run: () => Promise<unknown>; all: () => Promise<unknown> }[]) => { const out = []; for (const s of stmts) out.push(/^\s*select|\breturning\b/i.test(s.sql) ? await s.all() : await s.run()); return out; } };
}
function freshDb() {
  const db = new DatabaseSync(':memory:');
  const dir = `${node.cwd()}/migrations`;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(`${dir}/${f}`, 'utf8'));
  return db;
}

// ───────────── fakes: KV (with TTL), R2, the browser ─────────────
function fakeKv() {
  const m = new Map<string, { v: string; exp: number }>();
  const calls = { get: 0, put: 0, delete: 0, ttl: [] as number[] };
  return {
    calls, m,
    get: async (k: string, type?: string) => { calls.get++; const e = m.get(k); if (!e || e.exp <= Date.now()) { m.delete(k); return null; } return type === 'json' ? JSON.parse(e.v) : e.v; },
    put: async (k: string, v: string, o?: { expirationTtl?: number }) => { calls.put++; if (o?.expirationTtl) calls.ttl.push(o.expirationTtl); m.set(k, { v, exp: Date.now() + (o?.expirationTtl ?? 1e9) * 1000 }); },
    delete: async (k: string) => { calls.delete++; m.delete(k); },
  };
}
function fakeR2() {
  const m = new Map<string, { body: Uint8Array; type: string }>();
  return {
    m,
    head: async (k: string) => (m.has(k) ? { key: k, size: m.get(k)!.body.byteLength } : null),
    get: async (k: string) => { const o = m.get(k); return o ? { body: o.body, size: o.body.byteLength, httpMetadata: { contentType: o.type } } : null; },
    put: async (k: string, b: Uint8Array | string, o?: { httpMetadata?: { contentType?: string } }) => { m.set(k, { body: typeof b === 'string' ? new TextEncoder().encode(b) : b, type: o?.httpMetadata?.contentType ?? 'application/octet-stream' }); },
  };
}
interface FakePageSpec { status?: number; selectors?: string[]; pageErrors?: string[]; throws?: string }
/** A browser whose pages answer from `spec(url)`; goto can also be routed through the app itself (`via`). */
function fakeBrowser(spec: (url: string) => FakePageSpec, via?: (url: string) => Promise<{ status: number; html: string }>) {
  const log = { gotos: [] as string[], pdfs: 0, closed: 0, pagesClosed: 0, html: [] as string[] };
  const browser: BrowserLike = {
    async newPage() {
      const handlers: Record<string, ((x: unknown) => void)[]> = {};
      let cur: FakePageSpec = {};
      const page: PageLike = {
        async goto(url) {
          log.gotos.push(url);
          cur = spec(url);
          if (cur.throws) throw new Error(cur.throws);
          let status = cur.status ?? 200;
          if (via) { const r = await via(url); status = r.status; log.html.push(r.html); }
          for (const e of cur.pageErrors ?? []) (handlers.pageerror ?? []).forEach((h) => h(new Error(e)));
          return { status: () => status };
        },
        async pdf() { log.pdfs++; return new TextEncoder().encode('%PDF-1.7 fake'); },
        on(ev: string, fn: (x: never) => void) { (handlers[ev] ??= []).push(fn as (x: unknown) => void); return page; },
        async waitForSelector(sel) {
          const want = sel.split(',').map((x) => x.trim());
          if (want.some((w) => (cur.selectors ?? []).includes(w))) return {};
          throw new Error(`timeout waiting for ${sel}`);
        },
        async setRequestInterception() {},
        async close() { log.pagesClosed++; },
      } as PageLike;
      return page;
    },
    async close() { log.closed++; },
  };
  return { browser, log };
}

const ORIGIN = 'https://apply.test';
const T0 = Date.parse('2026-11-03T02:00:00Z');
const ALL = () => Object.fromEntries(SETTING_DEFS.map((d) => [d.key, ''])) as Record<string, string>;
let db: DatabaseSync;
let r2: ReturnType<typeof fakeR2>;
const pending: Promise<unknown>[] = [];
const env = (extra: Record<string, unknown> = {}) => ({ DB: d1(db), SESSION_SECRET: 's'.repeat(32), RECORDINGS: r2, ASSETS: { fetch: async (r: Request) => { try { return new Response(fs.readFileSync(`${node.cwd()}/public${new URL(r.url).pathname}`, 'utf8'), { headers: { 'content-type': 'text/html; charset=utf-8' } }); } catch { return new Response('', { status: 404 }); } } }, ...extra });
const makeRt = (s: Record<string, string> = {}, e: Record<string, unknown> = {}) =>
  ({ env: env(e), settings: { ...ALL(), ...s }, reps: [], origin: ORIGIN, waitUntil: (p: Promise<unknown>) => { pending.push(p.catch(() => null)); } }) as unknown as Runtime;
const q = <T = Record<string, unknown>>(sql: string, ...a: unknown[]) => db.prepare(sql).all(...(a as (string | number | null)[])) as T[];
const x = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...(a as (string | number | null)[]));
const exCtx = { waitUntil: (p: Promise<unknown>) => { pending.push(p.catch(() => null)); }, passThroughOnException: () => {} };
type App = { fetch: (r: Request, e: unknown, c: unknown) => Promise<Response> };
let app: App;
const call = (path: string, init: RequestInit = {}, e: Record<string, unknown> = {}) => {
  const headers = new Headers(init.headers);
  if (!headers.has('cf-connecting-ip')) headers.set('cf-connecting-ip', '203.0.113.7');
  return app.fetch(new Request(path.startsWith('http') ? path : `${ORIGIN}${path}`, { ...init, headers }), env(e), exCtx);
};
const setSetting = (k: string, v: string) => x('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, v);

beforeAll(async () => { app = (await import('../src/index')).default as unknown as App; }, 60_000);
beforeEach(() => {
  db = freshDb();
  r2 = fakeR2();
  sqls = [];
  resetSettingsCache();
  setBrowserLauncher(null);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); setBrowserLauncher(null); pending.length = 0; resetSettingsCache(); });

const settingsReads = () => sqls.filter((s) => s === 'SELECT key, value FROM settings').length;

// ───────────── Workers KV: the settings cache ─────────────

describe('Workers KV settings cache (KV_CACHE)', () => {
  it('off (default): KV is never touched and every miss reads D1 as before', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(T0);
    const kv = fakeKv();
    const e = env({ CACHE: kv }) as never;
    setSetting('SITE_NAME', 'G&L');
    expect((await loadSettings(e)).SITE_NAME).toBe('G&L');
    vi.setSystemTime(T0 + 16_000);
    await loadSettings(e);
    expect(settingsReads()).toBe(2);
    expect(kv.calls).toEqual({ get: 0, put: 0, delete: 0, ttl: [] });
  });
  it('without the binding, on or off, settings load from D1 and saving works', async () => {
    setSetting('KV_CACHE', 'on');
    const e = env() as never;
    expect((await loadSettings(e)).KV_CACHE).toBe('on');
    await saveSettings(e, { SITE_NAME: 'New' });
    expect((await loadSettings(e)).SITE_NAME).toBe('New');
  });
  it('on: one D1 read fills KV for 60 s; other isolates read KV; a save clears it at once; it expires after the TTL', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(T0);
    const kv = fakeKv();
    const e = env({ CACHE: kv }) as never;
    setSetting('KV_CACHE', 'on'); setSetting('SITE_NAME', 'G&L'); setSetting('RESEND_API_KEY', 're_secret_value');
    x("INSERT INTO settings (key, value, updated_at) VALUES ('_internal_marker', 'x', 0)");
    await loadSettings(e);
    expect(settingsReads()).toBe(1);
    expect(kv.calls.put).toBe(1);
    expect(kv.calls.ttl).toEqual([KV_SETTINGS_TTL_S]);
    const blob = JSON.parse(kv.m.get(KV_SETTINGS_KEY)!.v);
    expect(blob.db.SITE_NAME).toBe('G&L');
    expect(blob.db._internal_marker).toBeUndefined(); // only real settings are cached

    // Past this isolate's 15 s memory: read from KV, not D1.
    vi.setSystemTime(T0 + 16_000);
    expect((await loadSettings(e)).SITE_NAME).toBe('G&L');
    expect(settingsReads()).toBe(1);
    expect(kv.calls.get).toBe(1);

    // A save clears both tiers; the next load sees the new value at once.
    await saveSettings(e, { SITE_NAME: 'G&L M&A' });
    expect(kv.calls.delete).toBe(1);
    expect(kv.m.has(KV_SETTINGS_KEY)).toBe(false);
    expect((await loadSettings(e)).SITE_NAME).toBe('G&L M&A');
    expect(settingsReads()).toBe(2);

    // The KV copy expires after its TTL: a later load past both tiers reads D1 again.
    vi.setSystemTime(T0 + 16_000 + (KV_SETTINGS_TTL_S + 1) * 1000);
    await loadSettings(e);
    expect(settingsReads()).toBe(3);
  });
  it('turning it off clears the KV copy and later loads stop using KV', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(T0);
    const kv = fakeKv();
    const e = env({ CACHE: kv }) as never;
    setSetting('KV_CACHE', 'on');
    await loadSettings(e);
    await saveSettings(e, { KV_CACHE: 'off' });
    await loadSettings(e); // D1: learns it is off
    const gets = kv.calls.get, puts = kv.calls.put;
    vi.setSystemTime(T0 + 20_000);
    await loadSettings(e);
    expect([kv.calls.get, kv.calls.put]).toEqual([gets, puts]);
    expect(kv.m.has(KV_SETTINGS_KEY)).toBe(false);
  });
  it('a broken KV never breaks settings', async () => {
    const bad = { get: async () => { throw new Error('kv down'); }, put: async () => { throw new Error('kv down'); }, delete: async () => { throw new Error('kv down'); } };
    const e = env({ CACHE: bad }) as never;
    setSetting('KV_CACHE', 'on'); setSetting('SITE_NAME', 'G&L');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await loadSettings(e)).SITE_NAME).toBe('G&L');
    await saveSettings(e, { SITE_NAME: 'B' });
    expect((await loadSettings(e)).SITE_NAME).toBe('B');
  });
});

// ───────────── signed R2 links ─────────────

describe('signed file links', () => {
  it('work until they expire, only for their exact key and name, and only under pdf/ and rooms/', async () => {
    const rt = makeRt();
    const url = await signedFileUrl(rt, 'pdf/plan/x/abc.pdf', 60_000, { name: 'Deal Plan.pdf', now: T0 });
    const u = new URL(url);
    expect(u.pathname.startsWith('/files/s/')).toBe(true);
    const k = u.pathname.slice('/files/s/'.length);
    const qp = Object.fromEntries(u.searchParams);
    expect(await verifySignedFile(rt.env, k, qp, T0 + 1000)).toEqual({ key: 'pdf/plan/x/abc.pdf', name: 'Deal Plan.pdf' });
    expect(await verifySignedFile(rt.env, k, qp, T0 + 61_000)).toBeNull(); // expired
    expect(await verifySignedFile(rt.env, k, { ...qp, n: 'Other.pdf' }, T0)).toBeNull();
    expect(await verifySignedFile(rt.env, k, { ...qp, e: String(T0 + 9e9) }, T0)).toBeNull();
    const other = new URL(await signedFileUrl(rt, 'pdf/plan/x/zzz.pdf', 60_000, { name: 'Deal Plan.pdf', now: T0 }));
    expect(await verifySignedFile(rt.env, other.pathname.slice(9), qp, T0)).toBeNull(); // another key with this signature
    await expect(signedFileUrl(rt, 'slides/secret.png', 1000)).rejects.toThrow();
    await expect(signedFileUrl(rt, 'pdf/../rooms/x', 1000)).rejects.toThrow();
  });
  it('the route serves the file with its download name, and 404s a bad link', async () => {
    await r2.put('pdf/t/a.pdf', '%PDF-1.7 x', { httpMetadata: { contentType: 'application/pdf' } });
    const url = await signedFileUrl(makeRt(), 'pdf/t/a.pdf', 60_000, { name: 'Plan.pdf' });
    const res = await call(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="Plan.pdf"');
    expect(await res.text()).toBe('%PDF-1.7 x');
    expect((await call(url.replace(/s=[0-9a-f]{4}/, 's=0000'))).status).toBe(404);
  });
});

// ───────────── Download PDF ─────────────

async function seedPlan() {
  const { createRoom } = await import('../src/rooms/rooms');
  const { planUrl } = await import('../src/rooms/engage-db');
  const rt = makeRt();
  const room = await createRoom(rt, { mode: 'webinar', title: 'Buy your first competitor', refType: 'none' });
  x('INSERT INTO room_plans (room_id, who, data, steps, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', room.id, 'rlr1', JSON.stringify({ industry: 'HVAC', cash_flow: '900k', debt_service: '550k', action_1: 'Write my buy box' }), '[]', T0, T0);
  return { room, url: await planUrl(rt, room.id, 'rlr1') };
}

describe('Download PDF (PDF_RENDER)', () => {
  it('render tokens last five minutes and only for their own page', async () => {
    const rt = makeRt();
    const t = await pdfRenderToken(rt, '/sign/abc/copy', T0);
    expect(await checkPdfRenderToken(rt, '/sign/abc/copy', t, T0 + 60_000)).toBe(true);
    expect(await checkPdfRenderToken(rt, '/sign/abc/copy', t, T0 + 6 * 60_000)).toBe(false);
    expect(await checkPdfRenderToken(rt, '/sign/other/copy', t, T0)).toBe(false);
    expect(await checkPdfRenderToken(rt, '/sign/abc/copy', 'nope', T0)).toBe(false);
  });
  it('off: the Deal Plan page has no PDF link and the PDF route goes back to the page without a browser', async () => {
    const { url } = await seedPlan();
    const fb = fakeBrowser(() => ({}));
    setBrowserLauncher(async () => fb.browser);
    const page = await (await call(url)).text();
    expect(page).not.toContain('Download PDF');
    const res = await call(`${url}/pdf`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!, ORIGIN).pathname).toBe(new URL(url).pathname);
    expect(fb.log.gotos).toEqual([]);
  });
  it('on without Browser Rendering (local dev): no link, nothing breaks', async () => {
    setSetting('PDF_RENDER', 'on');
    const { url } = await seedPlan();
    expect(await (await call(url)).text()).not.toContain('Download PDF');
    expect((await call(`${url}/pdf`, { redirect: 'manual' })).status).toBe(302);
  });
  it('on: renders our own page through a signed render link once, stores it under pdf/, and hands out a signed short-lived link', async () => {
    setSetting('PDF_RENDER', 'on');
    const { room, url } = await seedPlan();
    const fb = fakeBrowser(() => ({}), async (u) => { const r = await call(u); return { status: r.status, html: await r.text() }; });
    setBrowserLauncher(async () => fb.browser);
    const page = await (await call(url)).text();
    expect(page).toContain('Download PDF');

    const res = await call(`${url}/pdf`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const link = res.headers.get('location')!;
    expect(link).toMatch(/^https:\/\/apply\.test\/files\/s\/.+e=\d+.*s=[0-9a-f]{32}/);
    expect(fb.log.gotos).toHaveLength(1);
    expect(fb.log.gotos[0]).toMatch(new RegExp(`/rooms/plan/${room.id}/rlr1\\.[0-9a-f]{24}\\?pdf=\\d+\\.[0-9a-f]{24}$`));
    expect(fb.log.html[0]).toContain('HVAC'); // the renderer saw the real page
    expect(fb.log.html[0]).not.toContain('Download PDF'); // without its own PDF link
    expect([...r2.m.keys()]).toEqual([expect.stringMatching(new RegExp(`^pdf/plan/${room.id}/[0-9a-f]{24}\\.pdf$`))]);
    expect(fb.log.closed).toBe(1);

    const file = await call(link);
    expect(file.headers.get('content-type')).toBe('application/pdf');
    expect(file.headers.get('content-disposition')).toContain('Deal Plan.pdf');

    // Unchanged plan: the stored PDF is reused (no second render).
    await call(`${url}/pdf`, { redirect: 'manual' });
    expect(fb.log.gotos).toHaveLength(1);
    // A changed plan renders again.
    x("UPDATE room_plans SET data = ?, updated_at = ? WHERE who = 'rlr1'", JSON.stringify({ industry: 'Dental' }), T0 + 1);
    await call(`${url}/pdf`, { redirect: 'manual' });
    expect(fb.log.gotos).toHaveLength(2);
    expect(r2.m.size).toBe(2);
  });
  it('a bad plan link is a 404 and a failed render goes back to the page', async () => {
    setSetting('PDF_RENDER', 'on');
    const { room, url } = await seedPlan();
    const fb = fakeBrowser(() => ({ status: 500 }));
    setBrowserLauncher(async () => fb.browser);
    expect((await call(`/rooms/plan/${room.id}/rlr1.000000000000000000000000/pdf`)).status).toBe(404);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await call(`${url}/pdf`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).not.toContain('/files/');
    expect(r2.m.size).toBe(0);
    expect(fb.log.pagesClosed).toBe(1);
    expect(q("SELECT source FROM app_errors WHERE source = 'Download PDF'")).toHaveLength(1);
  });
  it('the signed agreement copy: PDF link only when on, the print button hidden for the renderer', async () => {
    setSetting('PDF_RENDER', 'on');
    const token = 'a'.repeat(40);
    x(`INSERT INTO contracts (id, token, lead_id, status, title, fee, currency, body_html, doc_hash, created_at, signed_at, is_test)
       VALUES ('k_test1', ?, 'l1', 'signed', 'Engagement letter', 40000, 'USD', '<p>Terms</p>', 'h1', ?, ?, 1)`, token, T0, T0);
    const fb = fakeBrowser(() => ({}), async (u) => { const r = await call(u); return { status: r.status, html: await r.text() }; });
    setBrowserLauncher(async () => fb.browser);
    const copy = await (await call(`/sign/${token}/copy`)).text();
    expect(copy).toContain(`/sign/${token}/pdf`);
    expect(copy).toContain('data-print');
    const res = await call(`/sign/${token}/pdf`, { redirect: 'manual' });
    expect(res.headers.get('location')).toContain('/files/s/');
    expect(fb.log.html[0]).toContain('Signed by both parties');
    expect(fb.log.html[0]).not.toContain('data-print');
    expect(fb.log.html[0]).not.toContain(`/sign/${token}/pdf`);
    expect([...r2.m.keys()][0]).toMatch(/^pdf\/contracts\/k_test1\//);
    // An unsigned agreement has no PDF: back to the signing page.
    x("UPDATE contracts SET status = 'sent' WHERE id = 'k_test1'");
    const back = await call(`/sign/${token}/pdf`, { redirect: 'manual' });
    expect(back.headers.get('location')).toBe(`/sign/${token}`);
  });
  it('renders are rate limited per IP (a stored PDF does not count)', async () => {
    setSetting('PDF_RENDER', 'on');
    const fb = fakeBrowser(() => ({}));
    setBrowserLauncher(async () => fb.browser);
    const rt = makeRt({ PDF_RENDER: 'on' });
    let links = 0;
    for (let i = 0; i < 22; i++) if (await pdfLink(rt, { key: `pdf/t/${i}.pdf`, path: '/x', name: 'x.pdf', ip: '1.2.3.4' })) links++;
    expect(links).toBe(20);
    expect(await pdfLink(rt, { key: 'pdf/t/0.pdf', path: '/x', name: 'x.pdf', ip: '1.2.3.4' })).toContain('/files/s/');
  });
});

// ───────────── the funnel watchdog ─────────────

const allGood = (url: string): FakePageSpec => {
  const path = new URL(url).pathname;
  if (path === '/' || path === '/apply') return { selectors: ['[data-app] input[name=first_name]'] };
  if (path === '/live') return { selectors: ['form[data-live-register]'] };
  if (path === '/webinar') return { selectors: ['form input[name=first_name]'] };
  if (path.includes('/join/')) return { selectors: ['form button.rm-primary'] };
  return { status: 404 };
};

describe('funnel watchdog (WATCHDOG)', () => {
  it('a page passes with its CTA and no page errors; fails on a status, a missing CTA, a page error or a crash', async () => {
    const t = WATCH_TARGETS[0];
    const run = async (spec: FakePageSpec) => checkPage(fakeBrowser(() => spec).browser, ORIGIN, t);
    expect((await run({ selectors: [t.cta] })).status).toBe('ok');
    expect(await run({ status: 500, selectors: [t.cta] })).toMatchObject({ status: 'failed', error: 'The page answered 500' });
    expect(await run({ selectors: [] })).toMatchObject({ status: 'failed', error: expect.stringContaining('main button or form is missing') });
    expect(await run({ selectors: [t.cta], pageErrors: ['TypeError: x is undefined'] })).toMatchObject({ status: 'failed', error: 'Page error: TypeError: x is undefined' });
    expect(await run({ throws: 'net::ERR_NAME_NOT_RESOLVED' })).toMatchObject({ status: 'failed', error: 'net::ERR_NAME_NOT_RESOLVED' });
    // The live page with no session: the link to the masterclass counts, with a note.
    const live = WATCH_TARGETS.find((w) => w.path === '/live')!;
    expect(await checkPage(fakeBrowser(() => ({ selectors: ['.lv-link'] })).browser, ORIGIN, live)).toMatchObject({ status: 'ok', note: 'no live session scheduled' });
  });
  it('records a run, checks the next open room’s join page, logs failures in the error log and pings Slack once on the change', async () => {
    const { createRoom } = await import('../src/rooms/rooms');
    const rt = makeRt({ WATCHDOG: 'on', SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x' });
    await createRoom(rt, { mode: 'webinar', title: 'Tonight', refType: 'none', startsAt: Date.now() + 3_600_000 });
    const posts: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string, init: { body?: string } = {}) => { posts.push(`${u} ${init.body ?? ''}`); return new Response('ok'); }));
    let spec = allGood;
    const fb = fakeBrowser((u) => spec(u));
    setBrowserLauncher(async () => fb.browser);

    const r1 = await runWatchdog(rt);
    expect(r1).toMatchObject({ ok: true, checked: 5, failed: 0, skipped: 0 });
    expect(fb.log.gotos.some((u) => /\/rooms\/rm[a-z0-9]+\/join\/[0-9a-f]{16}$/.test(u))).toBe(true);
    expect(posts).toEqual([]); // first run all good: nothing to say

    spec = (u) => (new URL(u).pathname === '/apply' ? { selectors: [], pageErrors: ['ReferenceError: app is not defined'] } : allGood(u));
    const r2_ = await runWatchdog(rt);
    expect(r2_).toMatchObject({ ok: false, failed: 1 });
    expect(q<{ source: string; kind: string; message: string }>("SELECT source, kind, message FROM app_errors")).toEqual([
      { source: 'funnel watchdog', kind: 'cron', message: expect.stringContaining('Application, first step (/apply)') },
    ]);
    expect(posts.filter((p) => p.includes('hooks.slack.test'))).toHaveLength(1);
    await runWatchdog(rt); // still failing: no second ping
    expect(posts.filter((p) => p.includes('hooks.slack.test'))).toHaveLength(1);
    spec = allGood;
    await runWatchdog(rt); // recovered: one ping
    expect(posts.filter((p) => p.includes('hooks.slack.test'))).toHaveLength(2);

    const rep = await watchdogReport(rt);
    expect(rep.on).toBe(true);
    expect(rep.runs).toHaveLength(4);
    expect(rep.runs[0].ok).toBe(true);
    expect(rep.runs[2].checks.find((c) => c.path === '/apply')).toMatchObject({ status: 'failed' });
  });
  it('without Browser Rendering every page is recorded as skipped and nothing is logged as an error', async () => {
    const rt = makeRt({ WATCHDOG: 'on' });
    const r = await runWatchdog(rt);
    expect(r).toMatchObject({ ok: false, checked: 0, failed: 0 });
    expect(r.results.every((c) => c.status === 'skipped')).toBe(true);
    expect(r.results.find((c) => c.name === ROOM_TARGET_NAME)?.note).toContain('no upcoming room');
    expect(q('SELECT * FROM app_errors')).toEqual([]);
    const rep = await watchdogReport(rt);
    expect(rep.browser).toBe(false);
    expect(rep.runs).toHaveLength(1);
  });
  it('the cron runs it at most once an hour, only when on, and keeps 30 days of runs', async () => {
    const fb = fakeBrowser(allGood);
    setBrowserLauncher(async () => fb.browser);
    expect(await maybeRunWatchdog(makeRt(), T0)).toEqual({ skipped: 'off' });
    expect(await maybeRunWatchdog(makeRt({ WATCHDOG: 'on' }), T0)).toEqual({ skipped: 'no PUBLIC_URL' });
    const rt = makeRt({ WATCHDOG: 'on', PUBLIC_URL: ORIGIN });
    x('INSERT INTO watchdog_runs (started_at, ms, ok, checked, failed, skipped, results) VALUES (?, 1, 1, 1, 0, 0, ?)', T0 - 31 * 86_400_000, '[]');
    expect(await maybeRunWatchdog(rt, T0)).toMatchObject({ ok: true });
    expect(await maybeRunWatchdog(rt, T0 + 5 * 60_000)).toEqual({ skipped: 'not due' });
    expect(await maybeRunWatchdog(rt, T0 + 50 * 60_000)).toEqual({ skipped: 'not due' });
    expect(await maybeRunWatchdog(rt, T0 + 60 * 60_000)).toMatchObject({ ok: true });
    expect(q<{ n: number }>('SELECT COUNT(*) AS n FROM watchdog_runs')[0].n).toBe(2); // the 31-day-old run is gone
  });
  it('the Funnel HQ endpoints answer behind the admin sign-in', async () => {
    expect((await call('/admin/api/cf/watchdog')).status).toBe(401);
  });
});

// ───────────── Cloudflare Stream ─────────────

const UIDV = '0123456789abcdef0123456789abcdef';
function streamApi(o: { state?: string; ready?: boolean; fail?: number } = {}) {
  const calls: { url: string; method: string; auth: string; body: Record<string, unknown> | null }[] = [];
  const f = vi.fn(async (u: string, init: RequestInit = {}) => {
    const auth = new Headers(init.headers).get('authorization') ?? '';
    calls.push({ url: String(u), method: init.method ?? 'GET', auth, body: init.body ? JSON.parse(String(init.body)) : null });
    if (o.fail) return new Response(JSON.stringify({ success: false, errors: [{ message: 'Authentication error' }] }), { status: o.fail });
    return Response.json({ success: true, result: {
      uid: UIDV, readyToStream: Boolean(o.ready), status: { state: o.state ?? 'queued' },
      preview: `https://customer-abc123xyz.cloudflarestream.com/${UIDV}/watch`, thumbnail: `https://customer-abc123xyz.cloudflarestream.com/${UIDV}/thumbnails/thumbnail.jpg`,
      playback: { hls: `https://customer-abc123xyz.cloudflarestream.com/${UIDV}/manifest/video.m3u8` }, duration: o.ready ? 3600.5 : -1,
    } });
  });
  return { f, calls };
}
async function seedRecording(status = 'ready') {
  const { createRoom } = await import('../src/rooms/rooms');
  const room = await createRoom(makeRt(), { mode: 'webinar', title: 'Live: buy a competitor', refType: 'none' });
  x('INSERT INTO room_recordings (id, room_id, r2_key, mime, status, started_at) VALUES (?, ?, ?, ?, ?, ?)', 'recabc12345678', room.id, `rooms/${room.id}/recabc12345678.webm`, 'video/webm', status, T0);
  await r2.put(`rooms/${room.id}/recabc12345678.webm`, 'WEBMDATA', { httpMetadata: { contentType: 'video/webm' } });
  return room;
}

describe('Cloudflare Stream (STREAM_ACCOUNT_TOKEN)', () => {
  it('is off without the token; the account id defaults to ours', () => {
    expect(streamConfig({}).on).toBe(false);
    expect(streamConfig({ STREAM_ACCOUNT_TOKEN: 't' })).toEqual({ on: true, token: 't', accountId: '50e9fc42a7947d3f932cd1ed0bf95c03' });
    expect(streamConfig({ STREAM_ACCOUNT_TOKEN: 't', STREAM_ACCOUNT_ID: 'f'.repeat(32) }).accountId).toBe('f'.repeat(32));
  });
  it('(c) a Stream id or link becomes its HLS manifest; any other video URL is unchanged', () => {
    expect(streamVideoSrc('https://cdn.example.com/vsl.mp4')).toBe('https://cdn.example.com/vsl.mp4');
    expect(streamVideoSrc('/assets/media/hls/main/index.m3u8')).toBe('/assets/media/hls/main/index.m3u8');
    expect(streamVideoSrc('')).toBe('');
    const m = `https://customer-abc123xyz.cloudflarestream.com/${UIDV}/manifest/video.m3u8`;
    expect(streamVideoSrc(m)).toBe(m);
    expect(streamVideoSrc(UIDV)).toBe(`https://videodelivery.net/${UIDV}/manifest/video.m3u8`);
    expect(streamVideoSrc(UIDV, 'abc123xyz')).toBe(m);
    expect(streamVideoSrc(`https://customer-abc123xyz.cloudflarestream.com/${UIDV}/watch`)).toBe(m);
    expect(streamVideoSrc(`https://iframe.videodelivery.net/${UIDV}`, 'customer-abc123xyz.cloudflarestream.com')).toBe(m);
    expect(streamVideoSrc(`https://evil.example.com/${UIDV}/watch`)).toBe(`https://evil.example.com/${UIDV}/watch`);
  });
  it('(c) the VSL slots use the manifest for a Stream id, and the plain URL otherwise', async () => {
    const { connectedVideoSrc } = await import('../src/funnel/pages');
    const { VIDEOS } = await import('../src/config');
    expect(connectedVideoSrc({ ...ALL(), VSL_MAIN_SRC: UIDV } as never, VIDEOS.main)).toBe(`https://videodelivery.net/${UIDV}/manifest/video.m3u8`);
    expect(connectedVideoSrc({ ...ALL(), VSL_MAIN_SRC: 'https://cdn.example.com/a.mp4' } as never, VIDEOS.main)).toBe('https://cdn.example.com/a.mp4');
    expect(connectedVideoSrc({ ...ALL(), VSL_BREAKOUT_SRC: UIDV, STREAM_CUSTOMER_CODE: 'abc123xyz' } as never, VIDEOS.precall)).toBe(`https://customer-abc123xyz.cloudflarestream.com/${UIDV}/manifest/video.m3u8`);
    expect(connectedVideoSrc(ALL() as never, VIDEOS.main)).toBe('');
  });
  it('(a) sends a finished recording through a signed R2 link, stores the uid, refreshes until ready; the token goes only to the API', async () => {
    await seedRecording();
    const api = streamApi();
    const rt = makeRt({ STREAM_ACCOUNT_TOKEN: 'tok_secret_value' });
    const r = await sendToStream(rt, 'recabc12345678', { fetcher: api.f as never, now: T0 });
    expect(r).toMatchObject({ ok: true, already: false, video: { uid: UIDV, state: 'queued', ready: 0 } });
    expect(api.calls[0]).toMatchObject({ url: 'https://api.cloudflare.com/client/v4/accounts/50e9fc42a7947d3f932cd1ed0bf95c03/stream/copy', method: 'POST', auth: 'Bearer tok_secret_value' });
    const src = String(api.calls[0].body!.url);
    expect(src).toMatch(/^https:\/\/apply\.test\/files\/s\//);
    expect(api.calls[0].body!.meta).toMatchObject({ name: 'Live: buy a competitor (2026-11-03)', rec_id: 'recabc12345678' });
    // The signed source link really serves the recording, and only for six hours.
    const u = new URL(src);
    expect(Number(u.searchParams.get('e'))).toBe(T0 + 6 * 3_600_000);
    expect(await verifySignedFile(rt.env, u.pathname.slice(9), Object.fromEntries(u.searchParams), T0)).toMatchObject({ key: expect.stringMatching(/^rooms\/.+\.webm$/) });

    // Sending again returns the copy already there.
    expect(await sendToStream(rt, 'recabc12345678', { fetcher: api.f as never })).toMatchObject({ ok: true, already: true });
    expect(api.calls).toHaveLength(1);

    // The cron refreshes it until Stream has it ready.
    const ready = streamApi({ ready: true, state: 'ready' });
    expect(await syncStreamCopies(rt, { fetcher: ready.f as never, now: T0 + 2 * 60_000 })).toEqual({ checked: 1, ready: 1 });
    expect(ready.calls[0]).toMatchObject({ url: `https://api.cloudflare.com/client/v4/accounts/50e9fc42a7947d3f932cd1ed0bf95c03/stream/${UIDV}`, method: 'GET' });
    expect(q('SELECT uid, state, ready, duration FROM stream_videos')).toEqual([{ uid: UIDV, state: 'ready', ready: 1, duration: 3600.5 }]);
    expect(await refreshStream(rt, 'recabc12345678', { fetcher: ready.f as never })).toMatchObject({ ready: 1 });
    expect(ready.calls).toHaveLength(1); // a ready copy isn't asked about again
  });
  it('(a) off, unfinished recordings and API errors are reported plainly (never the token)', async () => {
    await seedRecording('recording');
    const api = streamApi();
    expect(await sendToStream(makeRt(), 'recabc12345678', { fetcher: api.f as never })).toMatchObject({ ok: false, error: expect.stringContaining('isn’t connected') });
    const rt = makeRt({ STREAM_ACCOUNT_TOKEN: 'tok_secret_value' });
    expect(await sendToStream(rt, 'recabc12345678', { fetcher: api.f as never })).toMatchObject({ ok: false, error: 'The recording isn’t finished yet.' });
    x("UPDATE room_recordings SET status = 'ready'");
    const bad = streamApi({ fail: 403 });
    const r = await sendToStream(rt, 'recabc12345678', { fetcher: bad.f as never });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('tok_secret_value');
    expect(q('SELECT state, error FROM stream_videos')).toEqual([{ state: 'error', error: expect.stringContaining('Stream refused the token (403)') }]);
    // A failed copy can be sent again.
    expect(await sendToStream(rt, 'recabc12345678', { fetcher: api.f as never })).toMatchObject({ ok: true });
    expect(await syncStreamCopies(makeRt(), { fetcher: api.f as never })).toEqual({ skipped: 'off' });
  });
  it('(b) the replay link opened as a page plays Stream once ready; video tags, range reads and Stream off get the file as before', async () => {
    await seedRecording();
    const page = { 'sec-fetch-dest': 'document', accept: 'text/html' };
    // No Stream copy yet: the file.
    setSetting('STREAM_ACCOUNT_TOKEN', 'tok');
    let res = await call('/rooms/replay/recabc12345678', { headers: page });
    expect(res.headers.get('content-type')).toBe('video/webm');
    x(`INSERT INTO stream_videos (rec_id, uid, state, ready, preview, created_at, updated_at) VALUES ('recabc12345678', ?, 'ready', 1, ?, 0, 0)`, UIDV, `https://customer-abc123xyz.cloudflarestream.com/${UIDV}/watch`);
    res = await call('/rooms/replay/recabc12345678', { headers: page });
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain(`src="https://customer-abc123xyz.cloudflarestream.com/${UIDV}/iframe?preload=auto"`);
    expect(html).toContain('Live: buy a competitor');
    expect(res.headers.get('content-security-policy')).toContain('frame-src https://customer-abc123xyz.cloudflarestream.com;');
    // A video element, a range read and ?raw=1 still get the file.
    for (const h of [{ 'sec-fetch-dest': 'video' }, { ...page, range: 'bytes=0-3' }]) {
      const r = await call('/rooms/replay/recabc12345678', { headers: h });
      expect(r.headers.get('content-type')).toBe('video/webm');
    }
    expect((await call('/rooms/replay/recabc12345678?raw=1', { headers: page })).headers.get('content-type')).toBe('video/webm');
    // Token removed: the file again.
    x("DELETE FROM settings WHERE key = 'STREAM_ACCOUNT_TOKEN'");
    resetSettingsCache();
    expect((await call('/rooms/replay/recabc12345678', { headers: page })).headers.get('content-type')).toBe('video/webm');
  });
  it('the player address only ever points at a Stream host', () => {
    expect(iframeSrc({ uid: UIDV, preview: `https://customer-abc123xyz.cloudflarestream.com/${UIDV}/watch` })).toBe(`https://customer-abc123xyz.cloudflarestream.com/${UIDV}/iframe`);
    expect(iframeSrc({ uid: UIDV, preview: 'https://evil.example.com/x' })).toBe(`https://iframe.videodelivery.net/${UIDV}`);
    expect(iframeSrc({ uid: 'nope', preview: null })).toBeNull();
  });
});

describe('copy', () => {
  it('the settings and the user-facing strings pass auditCopy', () => {
    const mine = SETTING_DEFS.filter((d) => ['KV_CACHE', 'PDF_RENDER', 'WATCHDOG', 'STREAM_ACCOUNT_TOKEN', 'STREAM_ACCOUNT_ID', 'STREAM_CUSTOMER_CODE'].includes(d.key));
    expect(mine).toHaveLength(6);
    const strings = [...mine.flatMap((d) => [d.label, 'help' in d ? d.help : ''].filter(Boolean) as string[]), ...Object.values(STREAM_COPY), 'Download PDF',
      ...WATCH_TARGETS.map((t) => t.name), 'Funnel watchdog: every page passes again', 'The key public pages render with their main button and no page errors.'];
    for (const s of strings) expect(auditCopy(s), s).toEqual([]);
  });
});
