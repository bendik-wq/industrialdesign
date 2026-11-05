import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DIMS, setVectorTestDoubles } from '../src/vectors/core';
import { auditCopy } from '../src/content/copy-rules';
import { BRAIN_COPY } from '../src/brain/routes';
import { type SqlDb, d1, freshDb } from './studio-fakes';
import { seededDb } from './brain-fixture';

// The Brain panel's API on the whole worker (in-memory SQLite D1 with every migration and the synthetic brain):
// status, search, legends, a page with its neighbourhood, embedding (owner only), guests read-only, empty brain.

const ORIGIN = 'https://apply.test';
let sdb: SqlDb;
let pending: Promise<unknown>[] = [];
const exCtx = { waitUntil: (p: Promise<unknown>) => { pending.push(p.catch(() => null)); }, passThroughOnException: () => {} };
const envFor = () => ({
  DB: d1(sdb), SESSION_SECRET: 'env-session-secret-'.padEnd(40, 'z'), ADMIN_PASSWORD: 'devpass-owner-only',
  ASSETS: { fetch: async () => new Response('<!doctype html><html><body></body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }) },
});
type App = { fetch: (r: Request, e: unknown, c: unknown) => Promise<Response> };
let app: App;
const call = async (path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set('cf-connecting-ip', '203.0.113.9');
  const res = await app.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }), envFor(), exCtx);
  await Promise.all(pending); pending = [];
  return res;
};
const same = { origin: ORIGIN, 'sec-fetch-site': 'same-origin' };
const json = { ...same, 'content-type': 'application/json' };
const cookieOf = (res: Response, name: string) => (res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? '']).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`) && c.length > name.length + 1) ?? '';
const ownerCookie = async () => cookieOf(await call('/admin/login', { method: 'POST', headers: { ...same, 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=devpass-owner-only' }), '_fa');
async function guestCookie(owner: string) {
  const { url } = (await (await call('/admin/api/guest-access', { method: 'POST', headers: { ...json, cookie: owner }, body: JSON.stringify({ label: 'Viewer', days: 1 }) })).json()) as { url: string };
  return cookieOf(await call(new URL(url).pathname, { headers: { 'sec-fetch-site': 'cross-site' } }), '_fg');
}
const get = async <T = Record<string, unknown>>(path: string, cookie: string) => (await (await call(`/admin/api/brain${path}`, { headers: { cookie } })).json()) as T;

beforeAll(async () => {
  vi.stubGlobal('HTMLRewriter', class { on() { return this; } transform(r: Response) { return r; } });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"offline"}', { status: 503 })));
  app = (await import('../src/index')).default as unknown as App;
}, 60_000);
beforeEach(async () => {
  pending = [];
  (await import('../src/settings')).resetSettingsCache();
  (await import('../src/lib/hq-cache')).memoryClear();
  (await import('../src/admin/guest')).resetGuestCaches();
});
afterEach(() => setVectorTestDoubles({ index: null, embed: null }));

describe('brain API', () => {
  it('needs a sign-in', async () => {
    sdb = freshDb();
    expect((await call('/admin/api/brain/status')).status).toBe(401);
  });

  it('empty brain: status says so, search and legends are empty', async () => {
    sdb = freshDb();
    const owner = await ownerCookie();
    const st = await get('/status', owner);
    expect(st).toMatchObject({ loaded: false, pages: 0, chunks: 0, embedded_pct: 0, note: BRAIN_COPY.empty });
    expect(await get('/search?q=curiosity', owner)).toMatchObject({ hits: [] });
    expect(await get('/legends', owner)).toMatchObject({ cards: [] });
    expect((await call('/admin/api/brain/page/ada-quill', { headers: { cookie: owner } })).status).toBe(404);
    for (const s of Object.values(BRAIN_COPY)) expect(auditCopy(s)).toEqual([]);
  });

  it('loaded brain: status, search with scope, legends, a page with its neighbourhood', async () => {
    sdb = seededDb();
    const owner = await ownerCookie();
    const st = await get<{ loaded: boolean; pages: number; legends: number; embedded_pct: number; build: { build_id: string } }>('/status', owner);
    expect(st).toMatchObject({ loaded: true, pages: 12, legends: 3, embedded_pct: 0 });
    expect(st.build.build_id).toBeTruthy();
    const s = await get<{ hits: { title: string; legend?: string; snippet: string }[] }>('/search?q=curiosity%20headline&scope=copy', owner);
    expect(s.hits[0]).toMatchObject({ title: 'Ada Quill', legend: 'Ada Quill' });
    const gl = await get<{ hits: { path: string }[] }>('/search?q=seller%20finance&scope=gl', owner);
    expect(gl.hits.every((h) => h.path.startsWith('wiki/ventures/gl/'))).toBe(true);
    const cards = await get<{ cards: { legend: string; principles: string[] }[] }>('/legends', owner);
    expect(cards.cards.map((c) => c.legend).sort()).toEqual(['Ada Quill', 'Boris Ledger', 'Cora Vance']);
    const pg = await get<{ page: { title: string }; chunks: unknown[]; graph: { center: string; nodes: { id: string }[]; edges: { src: string; dst: string }[] } }>('/page/boris-ledger', owner);
    expect(pg.page.title).toBe('Boris Ledger');
    expect(pg.chunks.length).toBeGreaterThan(1);
    expect(pg.graph.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(['boris-ledger', 'anchor-frames', 'vsl-skeleton', 'copywriting-legends']));
    expect(pg.graph.edges.length).toBeGreaterThan(2);
  });

  it('embed: owner only; reports "not here" without Vectorize; embeds and the status counts it', async () => {
    sdb = seededDb();
    const owner = await ownerCookie();
    const g = await guestCookie(owner);
    expect((await call('/admin/api/brain/status', { headers: { cookie: g } })).status).toBe(200);
    expect((await call('/admin/api/brain/search?q=hook', { headers: { cookie: g } })).status).toBe(200);
    expect((await call('/admin/api/brain/embed', { method: 'POST', headers: { ...json, cookie: g }, body: '{}' })).status).toBe(403);
    const off = await (await call('/admin/api/brain/embed', { method: 'POST', headers: { ...json, cookie: owner }, body: '{}' })).json();
    expect(off).toMatchObject({ ok: false, embedded: 0 });
    setVectorTestDoubles({ embed: async (t) => t.map(() => new Array(DIMS).fill(0.1)), index: { upsert: async () => ({}), query: async () => ({ matches: [] }), getByIds: async () => [], deleteByIds: async () => ({}) } });
    const on = (await (await call('/admin/api/brain/embed', { method: 'POST', headers: { ...json, cookie: owner }, body: JSON.stringify({ limit: 10 }) })).json()) as { ok: boolean; embedded: number; left: number };
    expect(on).toMatchObject({ ok: true, embedded: 10 });
    const st = await get<{ embedded: number; embedded_pct: number; vectors: boolean; embed: { embedded: number } }>('/status', owner);
    expect(st).toMatchObject({ embedded: 10, vectors: true, embed: { embedded: 10 } });
    expect(st.embedded_pct).toBeGreaterThan(0);
  });
});
