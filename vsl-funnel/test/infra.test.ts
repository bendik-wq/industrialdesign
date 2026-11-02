import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/app';
import { buildId, versionAssets, versionedAssetUrl } from '../src/infra/build';
import { CRON_BUDGET_MS, cronReport, runJobs } from '../src/infra/cron';
import { ERROR_RETENTION_DAYS, SLACK_PINGS_PER_HOUR, describeError, errorsReport, fingerprint, normalisePath, purgeErrors, recordError, resetErrorThrottle, scrub } from '../src/infra/errors';
import { SETTINGS as SETTING_DEFS } from '../src/settings';
import { auditCopy } from '../src/content/copy-rules';

// ───────────── a real SQLite database shaped like D1, with every migration applied ─────────────
interface Stmt { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } }
interface DatabaseSync { prepare(sql: string): Stmt; exec(sql: string): void }
const node = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown; cwd(): string } }).process;
const { DatabaseSync } = node.getBuiltinModule('node:sqlite') as { DatabaseSync: new (path: string) => DatabaseSync };
const fs = node.getBuiltinModule('node:fs') as { readdirSync(p: string): string[]; readFileSync(p: string, enc: string): string };
function d1(db: DatabaseSync, fail?: (sql: string) => boolean) {
  const prepare = (sql: string) => {
    let args: unknown[] = [];
    const norm = () => args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? Number(a) : a)) as (string | number | null)[];
    const check = () => { if (fail?.(sql)) throw new Error('D1_ERROR: database is locked'); };
    const st = {
      sql,
      bind: (...a: unknown[]) => { args = a; return st; },
      first: async <T>() => { check(); return (db.prepare(sql).get(...norm()) as T | undefined) ?? null; },
      all: async <T>() => { check(); return { results: db.prepare(sql).all(...norm()) as T[] }; },
      run: async () => { check(); const r = db.prepare(sql).run(...norm()); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
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

const DAY = 86_400_000;
const T0 = Date.parse('2026-11-03T02:00:00Z');
const ALL = () => Object.fromEntries(SETTING_DEFS.map((d) => [d.key, ''])) as Record<string, string>;
let db: DatabaseSync;
const pending: Promise<unknown>[] = [];
const makeRt = (s: Record<string, string> = {}, fail?: (sql: string) => boolean) =>
  ({ env: { DB: d1(db, fail) }, settings: { ...ALL(), SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x', ...s }, reps: [], origin: 'https://apply.test', waitUntil: (p: Promise<unknown>) => { pending.push(p.catch(() => null)); } }) as unknown as Runtime;
const flush = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
const q = <T = Record<string, unknown>>(sql: string, ...a: unknown[]) => db.prepare(sql).all(...(a as (string | number | null)[])) as T[];

// The whole app is a big module graph: load it once, up front, with time to spare.
beforeAll(async () => { await import('../src/index'); }, 60_000);

let posts: { url: string; body: string }[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  db = freshDb();
  resetErrorThrottle();
  posts = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body?: string } = {}) => { posts.push({ url: String(url), body: String(init.body ?? '') }); return new Response('ok'); }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); pending.length = 0; });

// ───────────── 1. versioned asset URLs ─────────────
describe('versioned asset URLs', () => {
  it('adds ?v=<build> to /assets js and css only, once', () => {
    expect(versionedAssetUrl('/assets/room.js', 'abc123')).toBe('/assets/room.js?v=abc123');
    expect(versionedAssetUrl('/assets/site.css', 'abc123')).toBe('/assets/site.css?v=abc123');
    expect(versionedAssetUrl('/assets/vendor/moq/client.mjs', 'b')).toBe('/assets/vendor/moq/client.mjs?v=b');
    expect(versionedAssetUrl('/assets/x.js?render=1', 'b')).toBe('/assets/x.js?render=1&v=b');
    expect(versionedAssetUrl('/assets/x.css#top', 'b')).toBe('/assets/x.css?v=b#top');
    expect(versionedAssetUrl('/assets/x.js?v=old', 'b')).toBe('/assets/x.js?v=old');
    for (const same of ['/assets/favicon.svg', '/assets/media/a.mp4', 'https://cdn.example.com/assets/x.js', '/other/x.js', '/assets/', '']) expect(versionedAssetUrl(same, 'b')).toBe(same);
    expect(versionedAssetUrl('/assets/x.js', '')).toBe('/assets/x.js');
  });

  it('the build id comes from the define, else the deployed version, else the isolate start', () => {
    expect(buildId({ CF_VERSION_METADATA: { id: '1a2b3c4d-5e6f-7a8b-9c0d-112233445566' } })).toBe('1a2b3c4d5e6f');
    const boot = buildId(null);
    expect(boot).toMatch(/^[a-z0-9]{6,}$/);
    expect(buildId({ CF_VERSION_METADATA: { id: '<bad>' } })).toBe(boot);
    expect(buildId({})).toBe(boot);
  });

  it('passes non-HTML responses and runtimes without HTMLRewriter through unchanged', async () => {
    const js = new Response('x', { headers: { 'content-type': 'application/javascript' } });
    expect(versionAssets(js, 'b')).toBe(js);
    const html = new Response('<script src="/assets/a.js"></script>', { headers: { 'content-type': 'text/html' } });
    expect(versionAssets(html, 'b')).toBe(html); // no HTMLRewriter in Node
  });

  it('every page references its scripts and stylesheets as script[src] / link[href] (what the rewriter versions)', () => {
    const files = ['admin/index.html', 'admin/login.html', ...fs.readdirSync(`${node.cwd()}/public`).filter((f) => f.endsWith('.html'))];
    let refs = 0;
    for (const f of files) {
      const html = fs.readFileSync(`${node.cwd()}/public/${f}`, 'utf8');
      for (const m of html.matchAll(/(\w+)=["'](\/assets\/[^"']+\.(?:js|css))["']/g)) {
        refs++;
        expect(['src', 'href'], `${f}: ${m[2]}`).toContain(m[1]);
      }
      // no hard-coded version that would freeze a file at an old build
      expect(html, f).not.toMatch(/\/assets\/[^"']+\.(js|css)\?v=/);
    }
    expect(refs).toBeGreaterThan(20);
    expect(fs.readFileSync(`${node.cwd()}/wrangler.jsonc`, 'utf8')).toMatch(/"run_worker_first": \["\/\*", "!\/assets\/\*"\]/);
  });

  it('rewrites HTML responses from the real app (with a stand-in HTMLRewriter), keeping status and headers', async () => {
    // A tiny HTMLRewriter for attribute selectors like script[src^="/assets/"]: enough to prove the wiring.
    class FakeRewriter {
      private rules: { tag: string; attr: string; prefix: string; h: { element(el: unknown): void } }[] = [];
      on(sel: string, h: { element(el: unknown): void }) { const m = /^(\w+)\[(\w+)\^="([^"]+)"\]$/.exec(sel)!; this.rules.push({ tag: m[1], attr: m[2], prefix: m[3], h }); return this; }
      transform(res: Response) {
        const rules = this.rules;
        const body = res.text().then((t) => t.replace(/<(\w+)\b([^>]*)>/g, (_all, tag: string, attrs: string) => {
          let out = attrs;
          for (const r of rules) {
            if (r.tag !== tag) continue;
            const re = new RegExp(`${r.attr}="([^"]*)"`);
            const v = re.exec(out)?.[1];
            if (!v || !v.startsWith(r.prefix)) continue;
            r.h.element({ getAttribute: () => v, setAttribute: (_: string, nv: string) => { out = out.replace(re, `${r.attr}="${nv}"`); } });
          }
          return `<${tag}${out}>`;
        }));
        return new Response(new ReadableStream({ async start(c) { c.enqueue(new TextEncoder().encode(await body)); c.close(); } }), res);
      }
    }
    vi.stubGlobal('HTMLRewriter', FakeRewriter);
    const app = (await import('../src/index')).default;
    const page = '<!doctype html><html><head><link rel="stylesheet" href="/assets/site.css"><link rel="icon" href="/assets/favicon.svg"></head><body><script src="/assets/camera-test.js" defer></script><script src="https://cdn.example.com/x.js"></script></body></html>';
    const env = { DB: d1(db), ASSETS: { fetch: async () => new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } }) }, SESSION_SECRET: 'x'.repeat(32), CF_VERSION_METADATA: { id: 'feedbeef-0000-0000-0000-000000000000' } };
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
    const res = await app.fetch(new Request('https://apply.test/camera-test'), env as never, ctx as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const html = await res.text();
    expect(html).toContain('href="/assets/site.css?v=feedbeef0000"');
    expect(html).toContain('src="/assets/camera-test.js?v=feedbeef0000"');
    expect(html).toContain('href="/assets/favicon.svg"');
    expect(html).toContain('src="https://cdn.example.com/x.js"');
    const health = await (await app.fetch(new Request('https://apply.test/health'), env as never, ctx as never)).json() as { ok: boolean; build: string };
    expect(health).toEqual({ ok: true, build: 'feedbeef0000' });
  });
});

// ───────────── 2. the error log ─────────────
describe('error log', () => {
  it('masks secrets and personal data, and one bug with different ids is one fingerprint', () => {
    expect(scrub('Bearer abcdefghijklmnop failed for jo@example.com at +61 412 345 678 key=sk_live_123456789')).not.toMatch(/abcdefghijklmnop|jo@example|412 345|sk_live_1234/);
    expect(scrub('GET /x?token=supersecret&a=1')).toBe('GET /x?token=***&a=1');
    expect(fingerprint('request', 'GET /rooms/:id', 'Room r_8f7a6b5c4d not found (attempt 3)')).toBe(fingerprint('request', 'GET /rooms/:id', 'Room r_1a2b3c4d5e not found (attempt 12)'));
    expect(fingerprint('request', 'GET /a', 'boom')).not.toBe(fingerprint('cron', 'GET /a', 'boom'));
    expect(normalisePath('/rooms/r_abc123/done')).toBe('/rooms/:x/done');
    expect(normalisePath('/hooks/whop')).toBe('/hooks/whop');
    const d = describeError(new TypeError('x is undefined'));
    expect(d.message).toBe('TypeError: x is undefined');
    expect(d.stack).toBeTruthy();
    expect(describeError('plain').message).toBe('plain');
    expect(describeError({ code: 7 }).message).toBe('{"code":7}');
  });

  it('dedupes by fingerprint with counts, first/last seen and per-day counts', async () => {
    const env = { DB: d1(db) } as never;
    const a = await recordError(env, new Error('Lead l_123456789 missing'), { kind: 'request', source: 'GET /x' });
    expect(a?.isNew).toBe(true);
    vi.setSystemTime(T0 + 60_000);
    const b = await recordError(env, new Error('Lead l_987654321 missing'), { kind: 'request', source: 'GET /x' });
    expect(b).toEqual({ fingerprint: a!.fingerprint, isNew: false });
    vi.setSystemTime(T0 + DAY);
    await recordError(env, new Error('Lead l_555555555 missing'), { kind: 'request', source: 'GET /x' });
    await recordError(env, new Error('other'), { kind: 'cron', source: 'SMS' });
    const rows = q<{ count: number; first_at: number; last_at: number; message: string }>('SELECT * FROM app_errors ORDER BY count DESC');
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({ count: 3, first_at: T0, last_at: T0 + DAY, message: 'Lead l_555555555 missing' });
    expect(q('SELECT day, count FROM app_error_days WHERE fingerprint = ? ORDER BY day', a!.fingerprint)).toEqual([{ day: '2026-11-03', count: 2 }, { day: '2026-11-04', count: 1 }]);

    const rep = await errorsReport(env, T0 + DAY);
    expect(rep.days.length).toBe(ERROR_RETENTION_DAYS);
    expect(rep.days.at(-1)).toMatchObject({ day: '2026-11-04', total: 2, fingerprints: 2, kinds: { request: 1, cron: 1 } });
    expect(rep.days.at(-2)).toMatchObject({ day: '2026-11-03', total: 2 });
    expect(rep.days[0]).toMatchObject({ total: 0 });
    expect(rep.totals).toEqual({ today: 2, window: 4, distinct: 2, newToday: 1 });
    expect(rep.fingerprints[0]).toMatchObject({ source: 'SMS', recent: 1 });
  });

  it('never throws, even when the database is down', async () => {
    const env = { DB: d1(db, () => true) } as never;
    await expect(recordError(env, new Error('x'), { kind: 'request', source: 'GET /' })).resolves.toBeNull();
    await expect(recordError(null, new Error('x'), { kind: 'request', source: 'GET /' })).resolves.toBeNull();
  });

  it('caps writes per minute so a crash loop cannot hammer the database', async () => {
    const env = { DB: d1(db) } as never;
    for (let i = 0; i < 80; i++) await recordError(env, new Error('loop'), { kind: 'request', source: 'GET /' });
    expect(q<{ count: number }>('SELECT count FROM app_errors')[0].count).toBe(60);
    vi.setSystemTime(T0 + 61_000);
    await recordError(env, new Error('loop'), { kind: 'request', source: 'GET /' });
    expect(q<{ count: number }>('SELECT count FROM app_errors')[0].count).toBe(61);
  });

  it('pings Slack only for a new fingerprint, only when ERRORS_SLACK is on, at most 5 an hour', async () => {
    const off = makeRt();
    await recordError(off.env, new Error('first'), { kind: 'request', source: 'GET /', rt: off });
    expect(posts.length).toBe(0); // off by default
    const on = makeRt({ ERRORS_SLACK: 'on' });
    await recordError(on.env, new Error('second'), { kind: 'webhook', source: 'POST /hooks/x', rt: on });
    expect(posts.length).toBe(1);
    expect(posts[0].url).toBe('https://hooks.slack.test/x');
    expect(posts[0].body).toContain('New error (webhook): POST /hooks/x');
    expect(posts[0].body).toContain('/admin#errors');
    await recordError(on.env, new Error('second'), { kind: 'webhook', source: 'POST /hooks/x', rt: on });
    expect(posts.length).toBe(1); // same fingerprint again: no ping
    expect(q<{ notified_at: number }>("SELECT notified_at FROM app_errors WHERE source = 'POST /hooks/x'")[0].notified_at).toBe(T0);
    for (let i = 0; i < 10; i++) await recordError(on.env, new Error(`distinct problem ${'abcdefghij'[i]}`), { kind: 'cron', source: `job ${'abcdefghij'[i]}`, rt: on });
    expect(posts.length).toBe(SLACK_PINGS_PER_HOUR);
  });

  it('keeps 14 days', async () => {
    const env = { DB: d1(db) } as never;
    await recordError(env, new Error('old'), { kind: 'request', source: 'GET /old', now: T0 - 20 * DAY });
    await recordError(env, new Error('new'), { kind: 'request', source: 'GET /new', now: T0 - DAY });
    expect(await purgeErrors({ env } as never, T0)).toEqual({ errors: 1, days: 1 });
    expect(q<{ source: string }>('SELECT source FROM app_errors').map((r) => r.source)).toEqual(['GET /new']);
    expect(await purgeErrors({ env } as never, T0 + 60_000)).toBeNull(); // at most hourly
  });

  it('logs unhandled errors from the real app: route pattern, kind, and webhook failures once', async () => {
    const app = (await import('../src/index')).default;
    const ctxPending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { ctxPending.push(p); }, passThroughOnException: () => {} };
    const env = { DB: d1(db, (sql) => /INSERT INTO leads/i.test(sql)), ASSETS: { fetch: async () => new Response('', { status: 404 }) }, SESSION_SECRET: 'x'.repeat(32), ZAPIER_INBOUND_SECRET: 'zsecret' };
    const res = await app.fetch(new Request('https://apply.test/hooks/zapier/create-lead', { method: 'POST', headers: { 'content-type': 'application/json', 'x-zapier-secret': 'zsecret' }, body: JSON.stringify({ email: 'z@example.com' }) }), env as never, ctx as never);
    expect(res.status).toBe(500);
    await Promise.all(ctxPending);
    const rows = q<{ kind: string; source: string; count: number; message: string }>('SELECT kind, source, count, message FROM app_errors');
    expect(rows).toEqual([{ kind: 'webhook', source: 'POST /hooks/zapier/:action', count: 1, message: 'D1_ERROR: database is locked' }]);
    // "not configured" (501) is not an error
    const r2 = await app.fetch(new Request('https://apply.test/hooks/resend-inbound', { method: 'POST', body: '{}' }), { ...env, DB: d1(db) } as never, ctx as never);
    expect(r2.status).toBe(501);
    await Promise.all(ctxPending);
    expect(q('SELECT * FROM app_errors').length).toBe(1);
  });

  it('logs uncaught room (Durable Object) errors and still throws them', async () => {
    const { RoomDO } = await import('../src/index');
    const waits: Promise<unknown>[] = [];
    const state = { waitUntil: (p: Promise<unknown>) => { waits.push(p); }, storage: { get: async (k: string) => (k === 'st' ? { id: 'r1' } : null), put: async () => {}, setAlarm: async () => {}, getAlarm: async () => null, deleteAlarm: async () => {} }, getWebSockets: () => [], blockConcurrencyWhile: async (f: () => Promise<unknown>) => f(), acceptWebSocket: () => {}, id: { toString: () => 'x' } };
    const room = new RoomDO(state as never, { DB: d1(db) } as never);
    await Promise.resolve();
    await expect(room.alarm()).rejects.toThrow();
    await Promise.all(waits);
    const rows = q<{ kind: string; source: string }>('SELECT kind, source FROM app_errors');
    expect(rows).toEqual([{ kind: 'room', source: 'room alarm' }]);
  });
});

// ───────────── 3. cron isolation ─────────────
describe('cron isolation', () => {
  it('one failing, throwing or slow job never blocks the others; every run is timed and logged', async () => {
    vi.useRealTimers();
    const rt = makeRt();
    const ran: string[] = [];
    let releaseSlow: () => void = () => {};
    const out = await runJobs(rt, [
      { name: 'good', run: async () => { ran.push('good'); return { due: 2 }; } },
      { name: 'rejects', run: async () => { throw new Error('Calendly 503'); } },
      { name: 'throws sync', run: () => { throw new Error('bad config'); } },
      { name: 'slow', budgetMs: 30, run: () => new Promise((res) => { releaseSlow = () => { ran.push('slow'); res('late'); }; }) },
      { name: 'after', run: async () => { ran.push('after'); return 1; } },
    ]);
    expect(out.map((o) => [o.name, o.status])).toEqual([['good', 'ok'], ['rejects', 'failed'], ['throws sync', 'failed'], ['slow', 'slow'], ['after', 'ok']]);
    expect(out[0].result).toEqual({ due: 2 });
    expect(out[1].error).toBe('Calendly 503');
    expect(ran).toEqual(['good', 'after']);
    const rows = q<{ job: string; last_status: string; runs: number; fails: number; slow: number; last_error: string | null }>('SELECT job, last_status, runs, fails, slow, last_error FROM cron_runs ORDER BY job');
    expect(rows).toEqual([
      { job: 'after', last_status: 'ok', runs: 1, fails: 0, slow: 0, last_error: null },
      { job: 'good', last_status: 'ok', runs: 1, fails: 0, slow: 0, last_error: null },
      { job: 'rejects', last_status: 'failed', runs: 1, fails: 1, slow: 0, last_error: 'Calendly 503' },
      { job: 'slow', last_status: 'slow', runs: 1, fails: 0, slow: 1, last_error: null },
      { job: 'throws sync', last_status: 'failed', runs: 1, fails: 1, slow: 0, last_error: 'bad config' },
    ]);
    expect(q<{ kind: string; source: string }>('SELECT kind, source FROM app_errors ORDER BY source')).toEqual([{ kind: 'cron', source: 'rejects' }, { kind: 'cron', source: 'throws sync' }]);
    // The slow job keeps running and its row is updated when it finishes.
    releaseSlow();
    await flush();
    expect(ran).toContain('slow');
    const slow = q<{ last_status: string; last_error: string; runs: number; last_ok_at: number | null }>("SELECT * FROM cron_runs WHERE job = 'slow'")[0];
    expect(slow).toMatchObject({ last_status: 'slow', runs: 1, last_error: 'finished after its time budget' });
    expect(slow.last_ok_at).toBeGreaterThan(0);

    // A second tick adds to the totals; the report has the last tick summary and averages.
    await runJobs(rt, [{ name: 'good', run: async () => 1 }]);
    const rep = await cronReport(rt.env);
    expect(rep.budgetMs).toBe(CRON_BUDGET_MS);
    expect(rep.lastTick).toMatchObject({ jobs: 1, failed: [], slow: [] });
    expect(rep.jobs.find((j) => j.job === 'good')).toMatchObject({ runs: 2, fails: 0 });
  });

  it('the scheduled handler wraps every job and still runs when the error log cannot be written', async () => {
    const src = fs.readFileSync(`${node.cwd()}/src/index.ts`, 'utf8');
    const sched = src.slice(src.indexOf('async scheduled('));
    expect(sched).not.toMatch(/Promise\.all\(\[\s*processEmailQueue/);
    expect(sched).toMatch(/runJobs\(rt, \[/);
    const jobs = [...sched.matchAll(/\{ name: '([^']+)', run: \(\) => (\w+)\(rt\) \}/g)];
    expect(jobs.length).toBeGreaterThanOrEqual(31);
    expect(new Set(jobs.map((j) => j[1])).size).toBe(jobs.length); // each job once
    vi.useRealTimers();
    const rt = makeRt({}, (sql) => /cron_runs|app_errors|kv_state/.test(sql));
    const out = await runJobs(rt, [{ name: 'a', run: async () => { throw new Error('x'); } }, { name: 'b', run: async () => 2 }]);
    expect(out.map((o) => o.status)).toEqual(['failed', 'ok']);
  });
});

// ───────────── copy ─────────────
describe('copy', () => {
  it('the setting and the Errors tab strings pass auditCopy', () => {
    const def = SETTING_DEFS.find((d) => d.key === 'ERRORS_SLACK')!;
    const strings = [def.label, 'help' in def ? String(def.help) : ''];
    const js = fs.readFileSync(`${node.cwd()}/public/assets/admin-errors.js`, 'utf8').replace(/var CSS = [\s\S]*?;\n/, '');
    for (const m of js.matchAll(/'((?:[^'\\]|\\.){12,})'/g)) if (/^[A-Z][^<>{}]*\s\S+\s/.test(m[1]) && !/[;{}=]|function/.test(m[1])) strings.push(m[1]);
    const admin = fs.readFileSync(`${node.cwd()}/public/assets/admin.js`, 'utf8');
    const tab = /errors: \{ group: 'Setup', title: '([^']+)', sub: '([^']+)', more: '([^']+)'/.exec(admin)!;
    strings.push(tab[1], tab[2], tab[3]);
    expect(strings.length).toBeGreaterThan(8);
    for (const s of strings) {
      expect(auditCopy(s), s).toEqual([]);
      expect(s, s).not.toMatch(/—|!/);
    }
  });
});
