import type { Context, Next } from 'hono';
import type { AppEnv } from '../app';

/**
 * Short-lived cache for Funnel HQ's heavy read endpoints (overview, attribution, maps, webinar, insights, emails,
 * deliverability). Keyed by endpoint + normalised range + filters + a generation number; every admin write bumps
 * the generation, so a change made in Funnel HQ shows on the next load. Data written elsewhere (new leads, sales)
 * shows within the TTL (90 s). Two tiers: this isolate's memory, then the Workers Cache API (per data centre).
 * `?fresh=1` skips the cache. Responses carry `x-hq-cache: hit | miss | bypass`.
 */

export const HQ_CACHE_TTL_MS = 90_000;
export const GEN_KEY = 'hq:cache:gen';
/** Admin GET paths (after /admin/api) that are cached. Room lists and live consoles are not: they show live state. */
export const CACHED_PATHS: RegExp[] = [
  /^\/overview$/, /^\/attribution$/, /^\/attribution\/stages$/, /^\/maps$/, /^\/maps\/[\w-]{1,40}$/,
  /^\/webinar$/, /^\/webinar\/insights$/, /^\/insights$/, /^\/emails$/, /^\/deliverability$/,
];
const LIVE_SLACK_MS = 5 * 60_000;

/**
 * The browser sends to=Date.now() on every load, so a raw key would never repeat. A range ending in the last few
 * minutes becomes "to=now" + its span in minutes; an older range is rounded to the minute. Other params sorted.
 */
export function cacheKey(path: string, query: Record<string, string>, gen: string, now = Date.now()) {
  const q: Record<string, string> = { ...query };
  delete q.fresh;
  const to = Number(q.to), from = Number(q.from);
  if (Number.isFinite(to) && to > 0 && Math.abs(now - to) <= LIVE_SLACK_MS) {
    q.to = 'now';
    if (Number.isFinite(from) && from > 0) q.from = `span${Math.round((to - from) / 60_000)}`;
  } else {
    if (Number.isFinite(to) && to > 0) q.to = String(Math.floor(to / 60_000));
    if (Number.isFinite(from) && from > 0) q.from = String(Math.floor(from / 60_000));
  }
  const qs = Object.keys(q).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(q[k])}`).join('&');
  return `g${gen}${path}?${qs}`;
}

export const isCachedPath = (path: string) => CACHED_PATHS.some((re) => re.test(path));

type Entry = { exp: number; body: string };
const memory = new Map<string, Entry>();
const MEMORY_MAX = 120;

export function memoryGet(key: string, now = Date.now()) {
  const e = memory.get(key);
  if (!e) return null;
  if (e.exp <= now) { memory.delete(key); return null; }
  return e.body;
}
export function memoryPut(key: string, body: string, now = Date.now(), ttl = HQ_CACHE_TTL_MS) {
  if (body.length > 2_000_000) return;
  memory.delete(key);
  memory.set(key, { exp: now + ttl, body });
  while (memory.size > MEMORY_MAX) memory.delete(memory.keys().next().value!);
}
export function memoryClear() { memory.clear(); }

type DB = { prepare(sql: string): { bind(...a: unknown[]): { first<T>(): Promise<T | null>; run(): Promise<unknown> }; first<T>(): Promise<T | null> } };

export async function readGen(db: DB) {
  const row = await db.prepare('SELECT value FROM kv_state WHERE key = ?').bind(GEN_KEY).first<{ value: string }>().catch(() => null);
  return row?.value ?? '0';
}
/** Invalidate every cached Funnel HQ answer (all isolates and data centres: the generation is part of the key). */
export async function bumpGen(db: DB, now = Date.now()) {
  await db.prepare('INSERT INTO kv_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(GEN_KEY, String(now)).run();
}

const edgeCache = (): Cache | null => {
  try { return typeof caches !== 'undefined' ? (caches as unknown as { default: Cache }).default ?? null : null; } catch { return null; }
};
const edgeUrl = (origin: string, key: string) => `${origin}/admin/api/__hqcache/${encodeURIComponent(key)}`;

/** Mount after requireAdmin on the admin API router. */
export async function hqCache(c: Context<AppEnv>, next: Next) {
  const method = c.req.method;
  const base = c.req.path.replace(/^\/admin\/api/, '');
  if (method !== 'GET' && method !== 'HEAD') {
    await next();
    // Any successful change made from Funnel HQ makes every cached view stale.
    if (c.res.status < 400) {
      memoryClear();
      const p = bumpGen(c.env.DB as unknown as DB).catch(() => null);
      try { c.executionCtx.waitUntil(p); } catch { await p; }
    }
    return;
  }
  if (!isCachedPath(base)) return next();
  if (c.req.query('fresh') === '1') { await next(); c.res.headers.set('x-hq-cache', 'bypass'); return; }
  const gen = await readGen(c.env.DB as unknown as DB);
  const key = cacheKey(base, c.req.query(), gen);
  const now = Date.now();
  const hdr = (state: string) => ({ 'content-type': 'application/json; charset=UTF-8', 'x-hq-cache': state, 'cache-control': 'private, no-store' });
  const mem = memoryGet(key, now);
  if (mem != null) return c.body(mem, 200, hdr('hit'));
  const origin = new URL(c.req.url).origin;
  const edge = edgeCache();
  if (edge) {
    const hit = await edge.match(edgeUrl(origin, key)).catch(() => undefined);
    if (hit) {
      const body = await hit.text();
      memoryPut(key, body, now);
      return c.body(body, 200, hdr('hit'));
    }
  }
  await next();
  const res = c.res;
  if (res.status !== 200 || !(res.headers.get('content-type') ?? '').includes('json')) return;
  const body = await res.clone().text();
  memoryPut(key, body, now);
  if (edge) {
    const put = edge.put(edgeUrl(origin, key), new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': `max-age=${Math.round(HQ_CACHE_TTL_MS / 1000)}` } })).catch(() => null);
    try { c.executionCtx.waitUntil(put); } catch { await put; }
  }
  c.res.headers.set('x-hq-cache', 'miss');
}
