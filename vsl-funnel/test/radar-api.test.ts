import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/app';
import { analyse, cleanAnalysis, glIssues } from '../src/radar/analyse';
import { RADAR_COPY, monthSpend, queueWatchlist, radarConfig, radarStep, upsertItem } from '../src/radar/engine';
import type { MonidClient } from '../src/radar/monid';
import { normalise } from '../src/radar/normalise';
import { SETTINGS, type Settings } from '../src/settings';
import { auditCopy } from '../src/content/copy-rules';
import { RADAR_UI_COPY } from '../src/radar/routes';
import { ANALYSIS_AD, ANALYSIS_BAD, ANALYSIS_VIDEO, DISCOVER_A, INSPECT_ADS, INSPECT_YT, META_AD_ROWS, NOW, TIKTOK_ROWS, TRANSCRIPT_OUTPUT, YOUTUBE_ROWS } from './radar-fixtures';
import { type SqlDb, d1, freshDb } from './studio-fakes';

// Radar on the whole worker (in-memory SQLite D1 with every migration, a fake Monid behind global fetch, a stubbed
// Workers AI) and the engine on its own with a fake Monid client: sources, the exact input before the first paid
// run, budget stops, the Instagram gate, guests, async runs and polling, analysis validation and the copy gate,
// "Make it a script" and the digest.

// ───────────── the engine with a fake client ─────────────

const blankSettings = () => Object.fromEntries(SETTINGS.map((s) => [s.key, ''])) as Settings;
function rtFor(db: SqlDb, over: Partial<Settings> = {}): Runtime {
  return { env: { DB: d1(db) } as never, settings: { ...blankSettings(), MONID_API_KEY: 'mk_test', ...over }, reps: [], origin: 'https://apply.test', waitUntil: () => {} };
}
function fakeClient(script: { run: (p: string, e: string, i: unknown) => ReturnType<MonidClient['run']>; getRun?: (id: string) => ReturnType<MonidClient['getRun']> }) {
  const calls = { run: [] as { provider: string; endpoint: string; input: unknown }[], getRun: [] as string[] };
  const client: MonidClient = {
    discover: async () => [], inspect: async (provider, endpoint) => ({ provider, endpoint }),
    run: async (p, e, i) => { calls.run.push({ provider: p, endpoint: e, input: i }); return script.run(p, e, i); },
    getRun: async (id) => { calls.getRun.push(id); return script.getRun!(id); },
  };
  return { client, calls };
}
async function addTool(rt: Runtime, slot: string, endpoint: string, inspect: { inputSchema?: unknown; price?: unknown }, confirmed = true) {
  await rt.env.DB.prepare('INSERT INTO radar_tools (slot, provider, endpoint, schema_json, price_json, selected, confirmed_at, found_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)')
    .bind(slot, 'apify', endpoint, inspect.inputSchema ? JSON.stringify(inspect.inputSchema) : null, inspect.price ? JSON.stringify(inspect.price) : null, confirmed ? new Date().toISOString() : null, new Date().toISOString()).run();
}
const wl = (over: Record<string, unknown> = {}) => ({ id: 'wl-test', name: 'Test', keywords: ['business acquisition'], platforms: ['youtube'] as never[], niche: 'in' as const, country: null, since_days: 30, enabled: true, last_run_at: null, created_at: '', updated_at: '', ...over });
async function insertWl(rt: Runtime, w: ReturnType<typeof wl>) {
  await rt.env.DB.prepare('INSERT INTO radar_watchlists (id, name, keywords_json, platforms_json, niche, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(w.id, w.name, JSON.stringify(w.keywords), JSON.stringify(w.platforms), w.niche, 'x', 'x').run();
}

describe('engine: runs, polling, money', () => {
  let db: SqlDb;
  beforeEach(() => { db = freshDb(); });

  it('a sync 200 run saves scored items and its billed cost', async () => {
    const rt = rtFor(db);
    await addTool(rt, 'youtube:search', '/streamers/youtube-scraper', INSPECT_YT);
    await insertWl(rt, wl());
    const q = await queueWatchlist(rt, wl());
    expect(q).toMatchObject({ queued: 1, est_micros: 75_000 }); // 15 results at 5000 micro-dollars
    const { client, calls } = fakeClient({ run: async () => ({ runId: 'r1', status: 'COMPLETED', output: YOUTUBE_ROWS, resultCount: 3, costMicros: 60_000 }) });
    const out = await radarStep(rt, { client });
    expect(out).toMatchObject({ started: 1, completed: 1 });
    expect(calls.run[0].input).toEqual({ searchQueries: ['business acquisition'], maxResults: 15, dateFilter: 'month', sortingOrder: 'views' });
    const items = db.prepare('SELECT id, score, niche, radar_ids, transcript_source FROM radar_items ORDER BY score DESC').all() as { id: string; score: number; niche: string; radar_ids: string; transcript_source: string }[];
    expect(items.map((i) => i.id)).toEqual(['youtube:aBcDeFgHiJ1', 'youtube:ZyXwVuTsRq2']);
    expect(items[0]).toMatchObject({ niche: 'in', radar_ids: '["wl-test"]', transcript_source: 'captions' });
    expect(items[0].score).toBeGreaterThan(items[1].score);
    expect(await monthSpend(rt)).toMatchObject({ spent: 60_000, reserved: 0 });
  });

  it('a 202 run is stored and polled on later steps until it completes (no long waits)', async () => {
    const rt = rtFor(db);
    await addTool(rt, 'tiktok:search', '/clockworks/tiktok-scraper', { inputSchema: { properties: { searchQueries: { type: 'array' }, resultsPerPage: { type: 'integer' } } }, price: { type: 'PER_RESULT', amount: 0.004 } });
    await insertWl(rt, wl({ platforms: ['tiktok'] }));
    await queueWatchlist(rt, wl({ platforms: ['tiktok'] }));
    let state = 'RUNNING';
    const { client, calls } = fakeClient({ run: async () => ({ runId: 'async-1', status: 'RUNNING', output: null, resultCount: null, costMicros: null }), getRun: async () => ({ runId: 'async-1', status: state, output: state === 'COMPLETED' ? TIKTOK_ROWS : null, resultCount: 1, costMicros: state === 'COMPLETED' ? 4000 : null }) });
    let t = Date.now();
    expect(await radarStep(rt, { client, now: t })).toMatchObject({ started: 1, completed: 0 });
    expect(await monthSpend(rt, t)).toMatchObject({ reserved: 60_000 }); // the estimate is held while it runs
    expect((await radarStep(rt, { client, now: t })).polled).toBe(0); // not due yet
    t += 31_000;
    expect((await radarStep(rt, { client, now: t })).polled).toBe(1);
    state = 'COMPLETED'; t += 61_000;
    expect(await radarStep(rt, { client, now: t })).toMatchObject({ polled: 1, completed: 1 });
    expect(calls.getRun).toEqual(['async-1', 'async-1']);
    expect(db.prepare('SELECT status, cost_micros, items_saved FROM radar_runs').get()).toMatchObject({ status: 'completed', cost_micros: 4000, items_saved: 1 });
    expect(db.prepare("SELECT views FROM radar_items WHERE id = 'tiktok:7301234567890123456'").get()).toMatchObject({ views: 910_000 });
  });

  it('a failed run records Monid\'s status and its bill; a timeout keeps the estimate as cost', async () => {
    const rt = rtFor(db);
    await addTool(rt, 'youtube:search', '/streamers/youtube-scraper', INSPECT_YT);
    await queueWatchlist(rt, wl());
    await radarStep(rt, { client: fakeClient({ run: async () => ({ runId: 'f', status: 'FAILED', output: null, resultCount: null, costMicros: 100, error: 'actor crashed' }) }).client });
    expect(db.prepare('SELECT status, cost_micros, error FROM radar_runs').get()).toMatchObject({ status: 'failed', cost_micros: 100, error: 'Monid: FAILED, actor crashed' });
    await queueWatchlist(rt, wl());
    await radarStep(rt, { client: fakeClient({ run: async () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; } }).client });
    expect(db.prepare("SELECT cost_micros, cost_estimated FROM radar_runs WHERE status = 'failed' ORDER BY created_at DESC, rowid DESC").get()).toMatchObject({ cost_micros: 75_000, cost_estimated: 1 });
  });

  it('budget: nothing queues past the monthly budget, and a pending run is skipped once spend has reached it', async () => {
    const rt = rtFor(db, { RADAR_BUDGET_USD_MONTH: '0.1' });
    expect(radarConfig(rt).budgetMicros).toBe(100_000);
    await addTool(rt, 'youtube:search', '/streamers/youtube-scraper', INSPECT_YT);
    expect((await queueWatchlist(rt, wl())).queued).toBe(1); // 75,000 of 100,000
    const second = await queueWatchlist(rt, wl());
    expect(second.queued).toBe(0);
    expect(second.notes).toContain(RADAR_COPY.budgetWouldPass);
    // A big bill lands from elsewhere this month: the pending run must not start.
    await rt.env.DB.prepare("INSERT INTO radar_runs (id, slot, provider, endpoint, input_json, status, cost_micros, created_at, updated_at) VALUES ('old', 'youtube:search', 'apify', '/x', '{}', 'completed', 100000, ?, ?)").bind(new Date().toISOString(), new Date().toISOString()).run();
    const { client, calls } = fakeClient({ run: async () => { throw new Error('must not run'); } });
    expect(await radarStep(rt, { client })).toMatchObject({ skipped: 1, started: 0 });
    expect(calls.run).toHaveLength(0);
    expect((await queueWatchlist(rt, wl())).notes).toEqual([RADAR_COPY.budget]);
  });

  it('Instagram gate: no Instagram run while RADAR_INSTAGRAM is off, even one already queued', async () => {
    const rt = rtFor(db);
    await addTool(rt, 'instagram:search', '/apify/instagram-reel-scraper', {});
    const q = await queueWatchlist(rt, wl({ platforms: ['instagram'] }));
    expect(q.queued).toBe(0);
    expect(q.notes).toEqual([RADAR_COPY.instagramOff]);
    await rt.env.DB.prepare("INSERT INTO radar_runs (id, slot, provider, endpoint, input_json, status, est_micros, created_at, updated_at) VALUES ('ig', 'instagram:search', 'apify', '/apify/instagram-reel-scraper', '{}', 'pending', 10, ?, ?)").bind(new Date().toISOString(), new Date().toISOString()).run();
    const { client, calls } = fakeClient({ run: async () => { throw new Error('must not run'); } });
    expect(await radarStep(rt, { client })).toMatchObject({ skipped: 1 });
    expect(calls.run).toHaveLength(0);
    // Switched on by the owner: it queues.
    expect((await queueWatchlist(rtFor(db, { RADAR_INSTAGRAM: 'on' }), wl({ platforms: ['instagram'] }))).queued).toBe(1);
  });

  it('refuses unpicked and unconfirmed sources, and does nothing without a key', async () => {
    const rt = rtFor(db);
    expect((await queueWatchlist(rt, wl())).notes).toEqual([RADAR_COPY.noSource('YouTube search')]);
    await addTool(rt, 'youtube:search', '/streamers/youtube-scraper', INSPECT_YT, false);
    expect((await queueWatchlist(rt, wl())).notes).toEqual([RADAR_COPY.notConfirmed('YouTube search')]);
    expect((await queueWatchlist(rtFor(db, { MONID_API_KEY: '' }), wl())).notes).toEqual([RADAR_COPY.noKey]);
    expect(await radarStep(rtFor(db, { MONID_API_KEY: '' }))).toMatchObject({ started: 0 });
  });

  it('an item found by an in-niche and an outside radar is marked both; metrics refresh, transcripts stay', async () => {
    const rt = rtFor(db);
    const [it] = normalise('youtube', YOUTUBE_ROWS, NOW);
    await upsertItem(rt, it, wl({ id: 'a', niche: 'in' }), NOW);
    await upsertItem(rt, { ...it, views: 2_000_000, captions: 'different' }, wl({ id: 'b', niche: 'out' }), NOW);
    expect(db.prepare('SELECT niche, radar_ids, views, transcript FROM radar_items').get()).toMatchObject({ niche: 'both', radar_ids: '["a","b"]', views: 2_000_000, transcript: it.captions });
  });
});

describe('analysis: validation and the copy gate', () => {
  it('validates and clamps: unknown layouts become spotlight, a reply without a hook is refused', () => {
    const a = cleanAnalysis(ANALYSIS_VIDEO, 'video');
    expect(a.for_gl.layouts.map((l) => l.layout)).toEqual(['cinema', 'split', 'spotlight']);
    expect(a.for_gl.angles).toHaveLength(3);
    expect(a.drop_offs[0]).toEqual({ t: '4:30', why: 'A long definition with no new tension.' });
    expect(() => cleanAnalysis({ for_gl: { hook: 'x' } }, 'video')).toThrow(/without a hook/);
    expect(() => cleanAnalysis('nonsense', 'video')).toThrow();
    const ad = cleanAnalysis(ANALYSIS_AD, 'ad');
    expect(ad).toMatchObject({ kind: 'ad', offer: 'A free webinar', beats: [], for_gl: { how_we_run: expect.stringMatching(/seller rollover/) } });
  });
  it('the G&L part goes through auditCopy and the house rules', () => {
    expect(glIssues(cleanAnalysis(ANALYSIS_VIDEO, 'video'))).toEqual([]);
    const rules = glIssues(cleanAnalysis(ANALYSIS_BAD, 'video')).map((f) => `${f.path}: ${f.rule}`);
    expect(rules).toEqual(expect.arrayContaining([
      'for_gl.apply: hedge: "might"', 'for_gl.apply: house rule: the call is never "free"', 'script: house rule: name seller rollover when funding is described',
    ]));
    expect(rules.some((r) => r.startsWith('for_gl.angles[0]: hedge'))).toBe(true);
  });
  it('a draft that trips the rules is rewritten once; the cleaner version is kept', async () => {
    const replies = [ANALYSIS_BAD, ANALYSIS_VIDEO];
    const prompts: string[] = [];
    const out = await analyse(async (_s, m) => { prompts.push(m.at(-1)!.content); return JSON.stringify(replies.shift()); }, { platform: 'youtube', title: 't', caption: null, author: 'a', url: null, views: 1, likes: 1, comments: 1, shares: 0, followers: 1, published_at: null, duration_s: 60, score: 50, score_json: null, transcript: '[0:00] hi', transcript_source: 'captions', ad_active_days: null, ad_variants: null, ad_cta: null, ad_link: null, media_kind: null });
    expect(out).toMatchObject({ attempts: 2, flags: [] });
    expect(prompts[1]).toMatch(/breaks the copy rules/);
    expect(prompts[0]).toMatch(/Transcript \(captions\)/);
  });
});

describe('copy shown in Radar', () => {
  it('passes auditCopy, with no em dashes or exclamation marks', () => {
    const all = [...Object.values(RADAR_COPY).map((v) => (typeof v === 'function' ? v('YouTube search') : v)), ...Object.values(RADAR_UI_COPY)];
    for (const s of all) {
      expect(auditCopy(s), s).toEqual([]);
      expect(s).not.toMatch(/[—–!]/);
    }
    for (const k of ['MONID_API_KEY', 'RADAR_BUDGET_USD_MONTH', 'RADAR_MAX_ITEMS', 'RADAR_INSTAGRAM', 'RADAR_SCHEDULE_HOURS']) {
      const def = SETTINGS.find((s) => s.key === k) as { group: string; help?: string } | undefined;
      expect(def?.group).toBe('Radar');
      expect(auditCopy(def?.help ?? ''), k).toEqual([]);
    }
    expect((SETTINGS.find((s) => s.key === 'RADAR_INSTAGRAM') as { help: string }).help).toMatch(/never to scrape Instagram/);
  });
});

// ───────────── the routes, on the whole worker ─────────────

const ORIGIN = 'https://apply.test';
let sdb: SqlDb;
let pending: Promise<unknown>[] = [];
const exCtx = { waitUntil: (p: Promise<unknown>) => { pending.push(p.catch(() => null)); }, passThroughOnException: () => {} };
let envOver: Record<string, string> = {};
const monidCalls: { path: string; body: unknown }[] = [];
let runReply: () => { status?: number; json: unknown } = () => ({ json: { runId: 'r', status: 'COMPLETED', output: YOUTUBE_ROWS, resultCount: 3, billing: { actualCost: { value: 50_000 } } } });
let aiAnalysis: unknown = ANALYSIS_VIDEO;
const SCRIPT_REPLY = {
  hooks: ['Banks don\'t reject buyers. They reject structures.', 'I bought my clinics in two acquisitions. Both sellers financed 100% of the price.', 'The reason your offer went nowhere had nothing to do with price.'],
  hook_index: 1,
  beats: [{ layout: 'vertical', text: 'I bought my clinics in two acquisitions. Both sellers financed 100% of the price.', cue: 'Calm', on_screen: 'Two acquisitions', screen: '' }, { layout: 'vertical', text: 'Apply through the link below. If it\'s a fit, the team books a strategy call to look at your numbers.', cue: '', on_screen: 'Apply below', screen: '' }],
  titles: ['How Owners Buy a Competitor', 'Seller First', 'The Order That Works'], thumbnail: 'Seller first', description: 'Apply: {APPLY_LINK}\nNot legal, tax or financial advice.', cta: 'Apply through the link below. If it\'s a fit, the team books a strategy call to look at your numbers.',
};
const aiCalls: { schema: Record<string, unknown> }[] = [];
const envFor = () => ({
  DB: d1(sdb), SESSION_SECRET: 'env-session-secret-'.padEnd(40, 'z'), ADMIN_PASSWORD: 'devpass-owner-only', ...envOver,
  ASSETS: { fetch: async () => new Response('<!doctype html><html><body></body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }) },
  AI: { run: async (_m: string, input: { response_format?: { json_schema?: { properties?: Record<string, unknown> } } }) => {
    const props = input.response_format?.json_schema?.properties ?? {};
    aiCalls.push({ schema: props });
    return { response: JSON.stringify('for_gl' in props ? aiAnalysis : SCRIPT_REPLY) };
  } },
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
async function ownerCookie() { return cookieOf(await call('/admin/login', { method: 'POST', headers: { ...same, 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=devpass-owner-only' }), '_fa'); }
async function guestCookie(owner: string) {
  const { url } = (await (await call('/admin/api/guest-access', { method: 'POST', headers: { ...json, cookie: owner }, body: JSON.stringify({ label: 'Viewer', days: 1 }) })).json()) as { url: string };
  return cookieOf(await call(new URL(url).pathname, { headers: { 'sec-fetch-site': 'cross-site' } }), '_fg');
}
const post = (path: string, cookie: string, body: unknown = {}) => call(`/admin/api/radar${path}`, { method: 'POST', headers: { ...json, cookie }, body: JSON.stringify(body) });
const get = async <T = Record<string, unknown>>(path: string, cookie: string) => (await (await call(`/admin/api/radar${path}`, { headers: { cookie } })).json()) as T;

beforeAll(async () => {
  vi.stubGlobal('HTMLRewriter', class { on() { return this; } transform(r: Response) { return r; } });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== 'api.monid.ai') return new Response('{"error":"offline"}', { status: 503 });
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = url.pathname.replace(/^\/v1/, '');
    monidCalls.push({ path, body });
    const reply = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/discover') return reply(body.query.includes('youtube search') ? DISCOVER_A : body.query.includes('ad library') ? { results: [{ provider: 'apify', endpoint: '/curious_coder/facebook-ads-library-scraper' }] } : { results: [] });
    if (path === '/inspect') return reply(body.endpoint === '/streamers/youtube-scraper' ? INSPECT_YT : body.endpoint.includes('facebook') ? INSPECT_ADS : { provider: body.provider, endpoint: body.endpoint });
    if (path === '/run') { const r = runReply(); return reply(r.json, r.status); }
    if (path.startsWith('/runs/')) return reply({ status: 'COMPLETED', output: TRANSCRIPT_OUTPUT, billing: { actualCost: { value: 1000 } } });
    return reply({ error: 'unknown' }, 404);
  }));
  app = (await import('../src/index')).default as unknown as App;
}, 60_000);
beforeEach(async () => {
  sdb = freshDb();
  envOver = { MONID_API_KEY: 'mk_test' };
  monidCalls.length = 0; aiCalls.length = 0; pending = [];
  aiAnalysis = ANALYSIS_VIDEO;
  runReply = () => ({ json: { runId: 'r', status: 'COMPLETED', output: YOUTUBE_ROWS, resultCount: 3, billing: { actualCost: { value: 50_000 } } } });
  (await import('../src/settings')).resetSettingsCache();
  (await import('../src/lib/hq-cache')).memoryClear();
  (await import('../src/admin/guest')).resetGuestCaches();
});

describe('routes: /admin/api/radar*', () => {
  it('needs an admin session', async () => {
    expect((await call('/admin/api/radar/state')).status).toBe(401);
    expect((await call('/admin/api/radar/sources/find', { method: 'POST', headers: json, body: '{"slot":"youtube:search"}' })).status).toBe(401);
  });

  it('the full path: seeded radars, find sources, the exact input, confirm, run, items, analyse, script, digest', async () => {
    const owner = await ownerCookie();
    const st = await get<{ key: boolean; watchlists: { id: string; name: string; niche: string; keywords: string[]; platforms: string[] }[]; spend: { budget_micros: number }; config: { instagram: boolean } }>('/state', owner);
    expect(st.key).toBe(true);
    expect(st.spend.budget_micros).toBe(20_000_000);
    expect(st.config.instagram).toBe(false);
    expect(st.watchlists.map((w) => w.niche)).toEqual(['in', 'out', 'in', 'out']);
    expect(st.watchlists[0].keywords).toEqual(expect.arrayContaining(['business acquisition', 'buy a business no money down', 'seller financing', 'roll up strategy', 'private equity small business', 'ETA search fund', 'M&A for business owners']));
    expect(st.watchlists[1].keywords).toEqual(expect.arrayContaining(['founder story', 'business breakdown', 'how I made', 'finance explained', 'Alex Hormozi']));

    // Find sources: discover, inspect, and the known actor pre-selected (not yet confirmed).
    const found = (await (await post('/sources/find', owner, { slot: 'youtube:search' })).json()) as { ok: boolean; found: number; preselected: string };
    expect(found).toMatchObject({ ok: true, found: 2, preselected: 'apify /streamers/youtube-scraper' });
    expect(monidCalls.map((c) => c.path)).toEqual(['/discover', '/inspect', '/inspect']);
    // Running before confirming the input is refused, and nothing is paid.
    const ytId = st.watchlists[0].id;
    const early = await post(`/watchlists/${ytId}/run`, owner);
    expect(early.status).toBe(400);
    expect(((await early.json()) as { notes: string[] }).notes).toContain(RADAR_COPY.notConfirmed('YouTube search'));
    expect(monidCalls.some((c) => c.path === '/run')).toBe(false);
    // The exact input, then confirm.
    const pv = await get<{ inputs: Record<string, unknown>[]; est_micros: number; missing: string[] }>('/sources/preview?slot=youtube:search', owner);
    expect(pv.inputs[0]).toMatchObject({ searchQueries: st.watchlists[0].keywords, maxResults: 15, dateFilter: 'year', sortingOrder: 'views' });
    expect(pv.est_micros).toBe(75_000);
    expect(pv.missing).toEqual([]);
    expect((await post('/sources/confirm', owner, { slot: 'youtube:search' })).status).toBe(200);

    // Run: queued, then started in the background (sync 200), items saved and scored, cost recorded.
    const run = (await (await post(`/watchlists/${ytId}/run`, owner)).json()) as { ok: boolean; queued: number; notes: string[] };
    expect(run).toMatchObject({ ok: true, queued: 1 });
    expect(run.notes).toContain(RADAR_COPY.noSource('TikTok search')); // TikTok has no source yet
    expect(monidCalls.filter((c) => c.path === '/run')).toHaveLength(1);
    const items = (await get<{ items: { id: string; score: number; niche: string; score_parts: { ratio: number } }[] }>('/items?sort=score', owner)).items;
    expect(items.map((i) => i.id)).toEqual(['youtube:aBcDeFgHiJ1', 'youtube:ZyXwVuTsRq2']);
    expect(items[0].score_parts.ratio).toBeGreaterThan(10);
    expect(((await get<{ items: unknown[] }>('/items?niche=out', owner)).items)).toHaveLength(0);
    expect(((await get<{ items: unknown[] }>(`/items?radar=${ytId}`, owner)).items)).toHaveLength(2);
    const st2 = await get<{ spend: { spent_micros: number } }>('/state', owner);
    expect(st2.spend.spent_micros).toBe(50_000);

    // Analyse (Workers AI, the video schema), cached on the item.
    const an = (await (await post('/items/youtube:aBcDeFgHiJ1/analyse', owner)).json()) as { ok: boolean; brain: string; flags: unknown[]; analysis: { hook: { text: string } } };
    expect(an).toMatchObject({ ok: true, brain: 'workers-ai', flags: [] });
    expect(an.analysis.hook.text).toBe('I bought this company without a dollar of my own.');
    expect(aiCalls[0].schema).toHaveProperty('drop_offs');
    const one = await get<{ item: { analysis: { for_gl: { hook: string } }; transcript: string; raw_json?: unknown } }>('/items/youtube:aBcDeFgHiJ1', owner);
    expect(one.item.analysis.for_gl.hook).toMatch(/two acquisitions/);
    expect(one.item.raw_json).toBeUndefined();

    // Make it a script: a Studio script from the analysis, listed in Studio → Scripts.
    const sc = (await (await post('/items/youtube:aBcDeFgHiJ1/script', owner)).json()) as { ok: boolean; script: { id: string; beats: number } };
    expect(sc).toMatchObject({ ok: true, script: { beats: 2 } });
    const scripts = (await (await call('/admin/api/studio/scripts', { headers: { cookie: owner } })).json()) as { scripts: { id: string; source: string; format: string }[] };
    expect(scripts.scripts[0]).toMatchObject({ id: sc.script.id, source: 'radar', format: 'long' });
    expect(sdb.prepare('SELECT script_id FROM radar_items WHERE id = ?').get('youtube:aBcDeFgHiJ1')).toMatchObject({ script_id: sc.script.id });

    // The digest groups the analysed items by hook type and format.
    const dg = await get<{ items: number; analysed: number; hooks: { label: string; examples: { id: string }[] }[] }>('/digest', owner);
    expect(dg).toMatchObject({ items: 2, analysed: 1 });
    expect(dg.hooks[0]).toMatchObject({ label: 'result', examples: [{ id: 'youtube:aBcDeFgHiJ1' }] });
  });

  it('transcripts come from the Monid transcript source (202, then polled)', async () => {
    const owner = await ownerCookie();
    await get('/state', owner);
    sdb.prepare("INSERT INTO radar_tools (slot, provider, endpoint, schema_json, selected, confirmed_at, found_at) VALUES ('youtube:transcript', 'apify', '/x/youtube-transcript', ?, 1, 'now', 'now')").run(JSON.stringify({ properties: { startUrls: { type: 'array', items: { type: 'object' } } } }));
    const rt = rtFor(sdb);
    const [it] = normalise('youtube', YOUTUBE_ROWS.slice(1, 2), NOW);
    await upsertItem(rt, it, null, NOW);
    runReply = () => ({ status: 202, json: { runId: 'tr-1', status: 'RUNNING' } });
    expect((await post(`/items/${it.id}/transcript`, owner)).status).toBe(200);
    expect(monidCalls.find((c) => c.path === '/run')?.body).toMatchObject({ endpoint: '/x/youtube-transcript', input: { startUrls: [{ url: 'https://www.youtube.com/watch?v=ZyXwVuTsRq2' }] } });
    sdb.prepare("UPDATE radar_runs SET next_poll_at = '2000-01-01T00:00:00Z'").run();
    expect((await post('/step', owner)).status).toBe(200);
    expect(sdb.prepare('SELECT transcript, transcript_source FROM radar_items WHERE id = ?').get(it.id)).toMatchObject({ transcript_source: 'monid', transcript: expect.stringMatching(/^\[0:00\] I bought/) });
  });

  it('Instagram stays off: no find, no run; the state says so', async () => {
    const owner = await ownerCookie();
    const st = await get<{ slots: { slot: string; off: boolean }[] }>('/state', owner);
    expect(st.slots.find((s) => s.slot === 'instagram:search')?.off).toBe(true);
    const r = await post('/sources/find', owner, { slot: 'instagram:search' });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe(RADAR_COPY.instagramOff);
    expect(monidCalls).toHaveLength(0);
  });

  it('without a key: a calm refusal, nothing called', async () => {
    envOver = {};
    const owner = await ownerCookie();
    const st = await get<{ key: boolean; watchlists: { id: string }[] }>('/state', owner);
    expect(st.key).toBe(false);
    const r = await post(`/watchlists/${st.watchlists[0].id}/run`, owner);
    expect(((await r.json()) as { error: string }).error).toBe(RADAR_COPY.noKey);
    expect(monidCalls).toHaveLength(0);
  });

  it('watchlists: create, validate, edit, delete', async () => {
    const owner = await ownerCookie();
    expect((await post('/watchlists', owner, { name: '', keywords: ['x'], platforms: ['youtube'] })).status).toBe(400);
    expect((await post('/watchlists', owner, { name: 'X', keywords: [], platforms: ['youtube'] })).status).toBe(400);
    const made = (await (await post('/watchlists', owner, { name: 'Founders', keywords: 'founder story\nhow I made', platforms: ['youtube', 'nope'], niche: 'out', country: 'au', since_days: '45' })).json()) as { watchlist: { id: string; keywords: string[]; platforms: string[]; country: string; since_days: number } };
    expect(made.watchlist).toMatchObject({ keywords: ['founder story', 'how I made'], platforms: ['youtube'], country: 'AU', since_days: 45 });
    const put = await call(`/admin/api/radar/watchlists/${made.watchlist.id}`, { method: 'PUT', headers: { ...json, cookie: owner }, body: JSON.stringify({ name: 'Founders 2', keywords: ['a'], platforms: ['tiktok'], enabled: false }) });
    expect(((await put.json()) as { watchlist: { name: string; enabled: boolean } }).watchlist).toMatchObject({ name: 'Founders 2', enabled: false });
    expect((await call(`/admin/api/radar/watchlists/${made.watchlist.id}`, { method: 'DELETE', headers: { ...same, cookie: owner } })).status).toBe(200);
  });

  it('guests can read everything but never spend, analyse, write a script or change a radar', async () => {
    const owner = await ownerCookie();
    const st = await get<{ watchlists: { id: string }[] }>('/state', owner);
    const g = await guestCookie(owner);
    expect((await call('/admin/api/radar/state', { headers: { cookie: g } })).status).toBe(200);
    expect((await call('/admin/api/radar/items', { headers: { cookie: g } })).status).toBe(200);
    expect((await call('/admin/api/radar/digest', { headers: { cookie: g } })).status).toBe(200);
    for (const [path, body] of [[`/watchlists/${st.watchlists[0].id}/run`, {}], ['/sources/find', { slot: 'youtube:search' }], ['/sources/confirm', { slot: 'youtube:search' }], ['/sources/select', { slot: 'youtube:search', provider: 'a', endpoint: '/b' }], ['/items/youtube:x/analyse', {}], ['/items/youtube:x/script', {}], ['/items/youtube:x/transcript', {}], ['/watchlists', { name: 'x', keywords: ['x'], platforms: ['youtube'] }], ['/step', {}]] as const) {
      expect((await post(path, g, body)).status, path).toBe(403);
    }
    expect((await call(`/admin/api/radar/watchlists/${st.watchlists[0].id}`, { method: 'DELETE', headers: { ...same, cookie: g } })).status).toBe(403);
    expect(monidCalls).toHaveLength(0);
  });

  it('the Studio page carries the Radar view and a CSP for exactly the players and the ad media', async () => {
    const owner = await ownerCookie();
    const res = await call('/admin/studio', { headers: { cookie: owner } });
    const html = await res.text();
    expect(html).toContain('id="studio-radar"');
    expect(html).toContain('data-view="radar"');
    expect(html).toContain('/assets/studio-radar.js');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("frame-src 'self' https://www.youtube-nocookie.com https://www.tiktok.com;");
    expect(csp).toContain("media-src 'self' blob: mediastream: https://*.fbcdn.net;");
  });

  it('Meta ads normalise with the copy about spend; ads analyse with the ad schema', async () => {
    const owner = await ownerCookie();
    const rt = rtFor(sdb);
    for (const it of normalise('meta_ads', META_AD_ROWS, NOW)) await upsertItem(rt, it, null, NOW);
    const items = (await get<{ items: { id: string; ad_active_days: number }[] }>('/items?platform=meta_ads&sort=longevity', owner)).items;
    expect(items.map((i) => i.id)).toEqual(['meta_ads:1234567890123456', 'meta_ads:9876543210987654']);
    aiAnalysis = ANALYSIS_AD;
    const an = (await (await post('/items/meta_ads:1234567890123456/analyse', owner)).json()) as { ok: boolean; analysis: { kind: string; landing_promise: string } };
    expect(an).toMatchObject({ ok: true, analysis: { kind: 'ad', landing_promise: 'A 3-step method' } });
    expect(aiCalls[0].schema).toHaveProperty('landing_promise');
    expect(((await get<{ copy: { adSpend: string } }>('/state', owner)).copy.adSpend)).toMatch(/no spend for commercial ads/);
  });
});
