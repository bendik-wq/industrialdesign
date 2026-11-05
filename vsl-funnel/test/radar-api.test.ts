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
import { IG_SEARCH_RUN, IG_TRANSCRIPT_RUN, INSPECT_ANYAPI_YT, RUN_STARTED, TT_SEARCH_RUN, X_SEARCH_RUN, YT_SEARCH_RUN, YT_TRANSCRIPT_RUN } from './monid-live';

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
    const rt = rtFor(db, { RADAR_INSTAGRAM: 'off' });
    await addTool(rt, 'instagram:search', '/apify/instagram-reel-scraper', {});
    const q = await queueWatchlist(rt, wl({ platforms: ['instagram'] }));
    expect(q.queued).toBe(0);
    expect(q.notes).toEqual([RADAR_COPY.instagramOff]);
    await rt.env.DB.prepare("INSERT INTO radar_runs (id, slot, provider, endpoint, input_json, status, est_micros, created_at, updated_at) VALUES ('ig', 'instagram:search', 'apify', '/apify/instagram-reel-scraper', '{}', 'pending', 10, ?, ?)").bind(new Date().toISOString(), new Date().toISOString()).run();
    const { client, calls } = fakeClient({ run: async () => { throw new Error('must not run'); } });
    expect(await radarStep(rt, { client })).toMatchObject({ skipped: 1 });
    expect(calls.run).toHaveLength(0);
    // On (the default since the owner approved public reels research): it queues.
    expect((await queueWatchlist(rtFor(db), wl({ platforms: ['instagram'] }))).queued).toBe(1);
    expect(radarConfig(rtFor(db)).instagram).toBe(true);
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
    expect((SETTINGS.find((s) => s.key === 'RADAR_INSTAGRAM') as { help: string }).help).toMatch(/Owner-approved on 2026-11-05 for research on public reels only.*no logins and no DMs/);
  });
});

// ───────────── the routes, on the whole worker ─────────────

const ORIGIN = 'https://apply.test';
let sdb: SqlDb;
let pending: Promise<unknown>[] = [];
const exCtx = { waitUntil: (p: Promise<unknown>) => { pending.push(p.catch(() => null)); }, passThroughOnException: () => {} };
let envOver: Record<string, string> = {};
const monidCalls: { path: string; body: unknown }[] = [];
let runReply: (body: { endpoint: string }) => { status?: number; json: unknown } = () => ({ json: { runId: 'r', status: 'COMPLETED', output: YOUTUBE_ROWS, resultCount: 3, billing: { actualCost: { value: 50_000 } } } });
let runsReply: (id: string) => unknown = () => ({ status: 'COMPLETED', output: TRANSCRIPT_OUTPUT, billing: { actualCost: { value: 1000 } } });
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
    if (path === '/inspect') return reply(body.endpoint === '/youtube.search' ? INSPECT_ANYAPI_YT : body.endpoint === '/streamers/youtube-scraper' ? INSPECT_YT : body.endpoint.includes('facebook') ? INSPECT_ADS : { provider: body.provider, endpoint: body.endpoint });
    if (path === '/run') { const r = runReply(body); return reply(r.json, r.status); }
    if (path.startsWith('/runs/')) return reply(runsReply(decodeURIComponent(path.slice('/runs/'.length))));
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
  runsReply = () => ({ status: 'COMPLETED', output: TRANSCRIPT_OUTPUT, billing: { actualCost: { value: 1000 } } });
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
    envOver = { MONID_API_KEY: 'mk_test', RADAR_PAGES: '1' };
    const owner = await ownerCookie();
    let st = await get<{ key: boolean; watchlists: { id: string; name: string; niche: string; keywords: string[]; platforms: string[]; theme: string | null }[]; spend: { budget_micros: number }; config: { instagram: boolean } }>('/state', owner);
    expect(st.key).toBe(true);
    expect(st.spend.budget_micros).toBe(60_000_000);
    expect(st.config.instagram).toBe(true);
    // Radar v2: one radar per theme of the keyword universe, plus the Meta ads radar.
    expect(st.watchlists.map((w) => w.niche)).toEqual(['in', 'in', 'in', 'out', 'out', 'out', 'in']);
    expect(st.watchlists.map((w) => w.theme)).toEqual(['pe_ma', 'smb_acquisition', 'owner_exits', 'breakdowns', 'wealth', 'operators', null]);
    expect(st.watchlists[1].keywords).toEqual(expect.arrayContaining(['business acquisition', 'buy a business no money down', 'seller financing', 'search fund', 'SBA 7a loan']));
    expect(st.watchlists[3].keywords).toEqual(expect.arrayContaining(['founder story', 'business breakdown']));
    expect(st.watchlists[0].platforms).toEqual(['youtube', 'tiktok', 'instagram', 'x', 'linkedin', 'reddit']);
    // Narrow the first radar to five keywords and the three video platforms for this walk-through.
    const data = await get<{ themes: { id: string; keywords: { id: string; keyword: string }[] }[] }>('/data/state', owner);
    for (const k of data.themes.find((t) => t.id === 'pe_ma')!.keywords.slice(5)) {
      expect((await call(`/admin/api/radar/data/keywords/${k.id}`, { method: 'PUT', headers: { ...json, cookie: owner }, body: JSON.stringify({ enabled: false }) })).status).toBe(200);
    }
    expect((await call(`/admin/api/radar/data/radars/${st.watchlists[0].id}`, { method: 'PATCH', headers: { ...json, cookie: owner }, body: JSON.stringify({ platforms: ['youtube', 'tiktok', 'instagram'] }) })).status).toBe(200);
    st = await get('/state', owner);
    expect(st.watchlists[0].keywords).toEqual(['private equity small business', 'lower middle market', 'leveraged buyout', 'LBO', 'EBITDA multiple']);

    // The default tools are seeded, picked and ready: AnyAPI YouTube search with its built-in input and route price.
    const src = await get<{ slots: { slot: string; tools: { provider: string; endpoint: string; builtin: boolean; recommended: boolean; selected: boolean; confirmed: boolean; price: { type: string; variants: unknown[] } }[] }[] }>('/sources', owner);
    const picked = Object.fromEntries(src.slots.map((x) => { const t = x.tools.find((y) => y.selected); return [x.slot, t ? `${t.provider} ${t.endpoint}` : null]; }));
    expect(picked).toEqual({
      'youtube:search': 'anyapi /youtube.search', 'youtube:transcript': 'apify /starvibe/youtube-video-transcript', 'tiktok:search': 'anyapi /tiktok.search_keyword',
      'tiktok:transcript': 'anyapi /tiktok.video_transcript_full', 'instagram:search': 'anyapi /instagram.reels_search', 'instagram:transcript': 'anyapi /instagram.reel_transcript',
      'meta_ads:ads': 'apify /curious_coder/facebook-ads-library-scraper',
      'x:search': 'anyapi /twitter.search', 'linkedin:search': 'anyapi /linkedin.search_posts', 'reddit:search': 'anyapi /reddit.search', 'reddit:subreddit': 'anyapi /reddit.search', 'substack:posts': 'anyapi /substack.posts',
    });
    const yt = src.slots.find((x) => x.slot === 'youtube:search')!.tools.find((t) => t.selected)!;
    expect(yt).toMatchObject({ builtin: true, recommended: true, confirmed: true, price: { type: 'PER_UNIT_MATRIX' } });
    expect(yt.price.variants).toHaveLength(3);
    // Seeding again changes nothing; Find sources lists more tools and keeps the pick.
    await get('/state', owner);
    expect(sdb.prepare('SELECT COUNT(*) AS n FROM radar_tools').get()).toMatchObject({ n: 12 });
    const found = (await (await post('/sources/find', owner, { slot: 'youtube:search' })).json()) as { ok: boolean; found: number; preselected: string | null };
    expect(found).toMatchObject({ ok: true, found: 3, preselected: null });
    expect(monidCalls.map((c) => c.path)).toEqual(['/discover', '/inspect', '/inspect', '/inspect']);
    expect(sdb.prepare("SELECT provider, endpoint, confirmed_at IS NOT NULL AS ok FROM radar_tools WHERE slot = 'youtube:search' AND selected = 1").get()).toMatchObject({ provider: 'anyapi', endpoint: '/youtube.search', ok: 1 });
    // The exact input (built in: one run per keyword, the first 5, popular on the giraffe route), priced by that route.
    const pv = await get<{ inputs: Record<string, unknown>[]; est_micros: number; missing: string[]; confirmed: boolean }>('/sources/preview?slot=youtube:search', owner);
    expect(pv.inputs).toHaveLength(5);
    expect(pv.inputs[0]).toEqual({ query: st.watchlists[0].keywords[0], sortBy: 'popular', route: 'giraffe', uploadDate: 'this_year' });
    expect(pv).toMatchObject({ est_micros: 5 * 1200, missing: [], confirmed: true });

    // Run: YouTube, TikTok and Instagram, 5 keywords each. Every run answers RUNNING (Monid's real reply) and is polled
    // to COMPLETED: items saved once each and scored, the billed cost (dollars) recorded.
    const ytId = st.watchlists[0].id;
    expect(st.watchlists[0].platforms).toEqual(['youtube', 'tiktok', 'instagram']);
    runReply = (b) => ({ json: { ...RUN_STARTED, runId: `run${b.endpoint}`, endpoint: b.endpoint } });
    runsReply = (id) => (id.includes('youtube') ? YT_SEARCH_RUN : id.includes('tiktok') ? TT_SEARCH_RUN : IG_SEARCH_RUN);
    const run = (await (await post(`/watchlists/${ytId}/run`, owner)).json()) as { ok: boolean; queued: number; est_micros: number; notes: string[] };
    expect(run).toMatchObject({ ok: true, queued: 15, est_micros: 5 * 1200 + 5 * 1200 + 5 * 1100, notes: [] });
    const sent = monidCalls.filter((c) => c.path === '/run');
    expect(sent[0].body).toEqual({ provider: 'anyapi', endpoint: '/youtube.search', input: { body: pv.inputs[0] } });
    for (let i = 0; i < 4; i++) {
      sdb.prepare("UPDATE radar_runs SET next_poll_at = '2000-01-01T00:00:00Z'").run();
      expect((await post('/step', owner)).status).toBe(200);
    }
    expect(monidCalls.filter((c) => c.path === '/run')).toHaveLength(15);
    expect(sdb.prepare("SELECT COUNT(*) AS n FROM radar_runs WHERE status = 'completed'").get()).toMatchObject({ n: 15 });
    expect(sdb.prepare("SELECT slot, cost_micros, items_saved FROM radar_runs WHERE slot = 'instagram:search' LIMIT 1").get()).toMatchObject({ cost_micros: 1100, items_saved: 3 });
    const items = (await get<{ items: { id: string; score: number; score_parts: { ratio_basis: string; engagement: number | null } }[] }>('/items?platform=youtube&sort=score', owner)).items;
    expect(items.map((i) => i.id).sort()).toEqual(['youtube:-DAzLPJQRaQ', 'youtube:_qrVANZNXNg', 'youtube:j39pFtLyFSU', 'youtube:oQa1uRzj_q0']);
    expect(items[0].score_parts).toMatchObject({ ratio_basis: 'platform', engagement: null });
    expect(items[0].score).toBeGreaterThan(items[3].score);
    expect(((await get<{ items: unknown[] }>('/items?platform=tiktok', owner)).items)).toHaveLength(3);
    expect(((await get<{ items: unknown[] }>('/items?platform=instagram', owner)).items)).toHaveLength(3);
    expect(((await get<{ items: unknown[] }>('/items?niche=out', owner)).items)).toHaveLength(0);
    // Every item keeps the search that found it.
    expect(sdb.prepare("SELECT query FROM radar_items WHERE id = 'youtube:j39pFtLyFSU'").get()).toMatchObject({ query: expect.any(String) });
    expect(((await get<{ items: unknown[] }>(`/items?radar=${ytId}`, owner)).items)).toHaveLength(10);
    const st2 = await get<{ spend: { spent_micros: number } }>('/state', owner);
    expect(st2.spend.spent_micros).toBe(5 * 1200 + 5 * 1200 + 5 * 1100);

    // Analyse (Workers AI, the video schema), cached on the item.
    const top = 'youtube:j39pFtLyFSU';
    const an = (await (await post(`/items/${top}/analyse`, owner)).json()) as { ok: boolean; brain: string; flags: unknown[]; analysis: { hook: { text: string } } };
    expect(an).toMatchObject({ ok: true, brain: 'workers-ai', flags: [] });
    expect(an.analysis.hook.text).toBe('I bought this company without a dollar of my own.');
    expect(aiCalls[0].schema).toHaveProperty('drop_offs');
    const one = await get<{ item: { analysis: { for_gl: { hook: string } }; transcript: string; raw_json?: unknown } }>(`/items/${top}`, owner);
    expect(one.item.analysis.for_gl.hook).toMatch(/two acquisitions/);
    expect(one.item.raw_json).toBeUndefined();

    // Make it a script: a Studio script from the analysis, listed in Studio → Scripts (a 70-minute video: long form).
    const sc = (await (await post(`/items/${top}/script`, owner)).json()) as { ok: boolean; script: { id: string; beats: number } };
    expect(sc).toMatchObject({ ok: true, script: { beats: 2 } });
    const scripts = (await (await call('/admin/api/studio/scripts', { headers: { cookie: owner } })).json()) as { scripts: { id: string; source: string; format: string }[] };
    expect(scripts.scripts[0]).toMatchObject({ id: sc.script.id, source: 'radar', format: 'long' });
    expect(sdb.prepare('SELECT script_id FROM radar_items WHERE id = ?').get(top)).toMatchObject({ script_id: sc.script.id });

    // The digest groups the analysed items by hook type and format.
    const dg = await get<{ items: number; analysed: number; hooks: { label: string; examples: { id: string }[] }[] }>('/digest', owner);
    expect(dg).toMatchObject({ items: 10, analysed: 1 });
    expect(dg.hooks[0]).toMatchObject({ label: 'result', examples: [{ id: top }] });
  });

  it('a run the provider refused shows its message and costs nothing', async () => {
    const owner = await ownerCookie();
    const st = await get<{ watchlists: { id: string }[] }>('/state', owner);
    runReply = () => ({ json: { runId: 'bad', status: 'COMPLETED', providerResponse: { httpStatus: 400, error: { error: 'source_unknown: no such route', code: 'invalid_input' } }, cost: { value: 0, currency: 'USD' }, output: null } });
    expect((await post(`/watchlists/${st.watchlists[0].id}/run`, owner)).status).toBe(200);
    const runs = (await get<{ runs: { status: string; cost_micros: number; error: string }[] }>('/runs', owner)).runs;
    expect(runs.length).toBeGreaterThan(0);
    for (const r of runs.filter((x) => x.status !== 'pending')) expect(r).toMatchObject({ status: 'failed', cost_micros: 0, error: 'Monid: FAILED, source_unknown: no such route' });
    expect((await get<{ spend: { spent_micros: number } }>('/state', owner)).spend.spent_micros).toBe(0);
  });

  it('transcripts come from the default transcript tools (202, then polled), with the numbers they add', async () => {
    const owner = await ownerCookie();
    await get('/state', owner);
    const rt = rtFor(sdb);
    // A video from YouTube search: views, but no likes, comments or subscribers.
    const it = normalise('youtube', YT_SEARCH_RUN.output, NOW).find((x) => x.external_id === '_qrVANZNXNg')!;
    await upsertItem(rt, it, null, NOW);
    runReply = (b) => ({ status: 202, json: { ...RUN_STARTED, runId: `tr${b.endpoint}`, endpoint: b.endpoint } });
    runsReply = (id) => (id.includes('youtube') ? YT_TRANSCRIPT_RUN : IG_TRANSCRIPT_RUN);
    expect((await post(`/items/${it.id}/transcript`, owner)).status).toBe(200);
    expect(monidCalls.find((c) => c.path === '/run')?.body).toEqual({ provider: 'apify', endpoint: '/starvibe/youtube-video-transcript', input: { body: { youtube_url: 'https://www.youtube.com/watch?v=_qrVANZNXNg' } } });
    expect(sdb.prepare('SELECT est_micros FROM radar_runs').get()).toMatchObject({ est_micros: 5000 });
    sdb.prepare("UPDATE radar_runs SET next_poll_at = '2000-01-01T00:00:00Z'").run();
    expect((await post('/step', owner)).status).toBe(200);
    expect(sdb.prepare('SELECT transcript, transcript_source, likes, comments, followers, views FROM radar_items WHERE id = ?').get(it.id)).toMatchObject({
      transcript_source: 'monid', transcript: expect.stringMatching(/^\[0:00\] have you ever wanted to buy a small/), likes: 464, comments: 24, followers: 125_000, views: 18_524,
    });
    expect(JSON.parse((sdb.prepare('SELECT score_json FROM radar_items WHERE id = ?').get(it.id) as { score_json: string }).score_json)).toMatchObject({ ratio_basis: 'followers' });
    expect(sdb.prepare('SELECT status, cost_micros FROM radar_runs').get()).toMatchObject({ status: 'completed', cost_micros: 5000 });

    // An Instagram reel: the transcript tool takes the link; the estimate counts the reel's seconds plus the flat fee.
    const [reel] = normalise('instagram', IG_SEARCH_RUN.output, NOW);
    await upsertItem(rt, reel, null, NOW);
    monidCalls.length = 0;
    expect((await post(`/items/${reel.id}/transcript`, owner)).status).toBe(200);
    expect(monidCalls.find((c) => c.path === '/run')?.body).toEqual({ provider: 'anyapi', endpoint: '/instagram.reel_transcript', input: { body: { url: 'https://www.instagram.com/reel/DYRouZDjnOb/' } } });
    expect(sdb.prepare("SELECT est_micros FROM radar_runs WHERE slot = 'instagram:transcript'").get()).toMatchObject({ est_micros: 8000 });
    sdb.prepare("UPDATE radar_runs SET next_poll_at = '2000-01-01T00:00:00Z'").run();
    expect((await post('/step', owner)).status).toBe(200);
    expect(sdb.prepare('SELECT transcript, transcript_source FROM radar_items WHERE id = ?').get(reel.id)).toMatchObject({ transcript_source: 'monid', transcript: expect.stringMatching(/^\[0:00\] I found a small HVAC company/) });
    expect(sdb.prepare("SELECT cost_micros FROM radar_runs WHERE slot = 'instagram:transcript'").get()).toMatchObject({ cost_micros: 8000 });
  });

  it('Instagram switched off in Integrations: no find, no run; the state says so', async () => {
    envOver = { MONID_API_KEY: 'mk_test', RADAR_INSTAGRAM: 'off' };
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
    // Radar v2: Sources and sweeps reads for guests, never changes or spends.
    expect((await call('/admin/api/radar/data/state', { headers: { cookie: g } })).status).toBe(200);
    expect((await call('/admin/api/radar/data/estimate', { headers: { cookie: g } })).status).toBe(200);
    for (const [path, body] of [['/data/sweep', {}], ['/data/step', {}], ['/data/platforms', { platform: 'x', on: false }], ['/data/keywords', { theme: 'pe_ma', keywords: ['x'] }], ['/data/subreddits', { name: 'r/x' }], ['/data/publications', { url: 'x.substack.com' }]] as const) {
      expect((await post(path, g, body)).status, path).toBe(403);
    }
    expect((await call(`/admin/api/radar/data/radars/${st.watchlists[0].id}`, { method: 'PATCH', headers: { ...json, cookie: g }, body: '{"enabled":false}' })).status).toBe(403);
    expect(monidCalls).toHaveLength(0);
  });

  it('Sources and sweeps: the universe, lists and switches, the estimate, then a full sweep stepped to the end', async () => {
    envOver = { MONID_API_KEY: 'mk_test', RADAR_PAGES: '1', RADAR_AUTO_TRANSCRIBE: '0' };
    const owner = await ownerCookie();
    type DataState = { config: { pages: number; auto_transcribe: number; budget_usd: number }; platforms: { platform: string; on: boolean; source: string | null }[]; themes: { id: string; tier: string; keywords: { id: string; keyword: string }[] }[]; radars: { id: string; theme: string | null; enabled: boolean }[]; subreddits: { name: string }[]; publications: { id: string; verified: number }[]; sweeps: unknown[] };
    let ds = await get<DataState>('/data/state', owner);
    expect(ds.config).toMatchObject({ pages: 1, auto_transcribe: 0, budget_usd: 60 });
    expect(ds.platforms.map((p) => p.platform)).toEqual(['youtube', 'tiktok', 'instagram', 'meta_ads', 'x', 'linkedin', 'reddit', 'substack']);
    expect(ds.platforms.find((p) => p.platform === 'x')).toMatchObject({ on: true, source: 'anyapi /twitter.search' });
    expect(ds.themes.map((t) => t.id)).toEqual(['pe_ma', 'smb_acquisition', 'owner_exits', 'breakdowns', 'wealth', 'operators']);
    expect(ds.subreddits).toHaveLength(11);
    expect(ds.publications).toHaveLength(30);
    // A new theme from the keyword editor gets its own radar.
    const add = (await (await post('/data/keywords', owner, { theme: 'home_services', theme_name: 'Home services', tier: 'adjacent', keywords: 'HVAC business\nplumbing business' })).json()) as { ok: boolean; added: number; radar: string };
    expect(add).toMatchObject({ ok: true, added: 2, radar: expect.stringMatching(/^theme-home_services/) });
    expect((await post('/data/subreddits', owner, { name: 'https://www.reddit.com/r/HVAC/', niche: 'out' })).status).toBe(200);
    expect((await post('/data/publications', owner, { url: 'notboring', niche: 'out' })).status).toBe(200);
    expect((await post('/data/publications', owner, { url: 'not a url' })).status).toBe(400);
    expect((await post('/data/platforms', owner, { platform: 'nope' })).status).toBe(400);
    // Only X, and only the SMB radar, for the run below.
    for (const p of ['youtube', 'tiktok', 'instagram', 'meta_ads', 'linkedin', 'reddit', 'substack']) expect((await post('/data/platforms', owner, { platform: p, on: false })).status).toBe(200);
    ds = await get<DataState>('/data/state', owner);
    for (const r of ds.radars.filter((x) => x.theme !== 'smb_acquisition')) {
      expect((await call(`/admin/api/radar/data/radars/${r.id}`, { method: 'PATCH', headers: { ...json, cookie: owner }, body: '{"enabled":false}' })).status).toBe(200);
    }
    const est = await get<{ total_micros: number; runs: number; fits: boolean; lines: { platform: string; calls: number }[] }>('/data/estimate', owner);
    const smb = ds.themes.find((t) => t.id === 'smb_acquisition')!.keywords.length;
    expect(est).toMatchObject({ runs: Math.ceil(smb / 5), total_micros: Math.ceil(smb / 5) * 5100, fits: true });
    runReply = () => ({ json: { runId: 'x1', status: 'COMPLETED', output: X_SEARCH_RUN.output, cost: { value: 0.0021, currency: 'USD' } } });
    const sw = (await (await post('/data/sweep', owner)).json()) as { ok: boolean; queued: number; sweep_id: string };
    expect(sw).toMatchObject({ ok: true, queued: Math.ceil(smb / 5) });
    for (let i = 0; i < 3; i++) await post('/data/step', owner);
    const sweeps = (await get<{ sweeps: { id: string; status: string; completed: number; cost_micros: number; new_items: number }[] }>('/data/sweeps', owner)).sweeps;
    expect(sweeps[0]).toMatchObject({ id: sw.sweep_id, status: 'done', completed: Math.ceil(smb / 5), cost_micros: Math.ceil(smb / 5) * 2100, new_items: 5 });
    const xi = (await get<{ items: { platform: string; reposts: number; bookmarks: number; query: string }[] }>('/items?platform=x', owner)).items;
    expect(xi.length).toBeGreaterThan(0);
    expect(xi[0]).toMatchObject({ platform: 'x', query: expect.stringContaining('min_faves:200') });
    // Over budget: refused with the estimate, nothing queued.
    envOver = { MONID_API_KEY: 'mk_test', RADAR_PAGES: '1', RADAR_BUDGET_USD_MONTH: '0.001' };
    (await import('../src/settings')).resetSettingsCache();
    const over = await post('/data/sweep', owner);
    expect(over.status).toBe(400);
    expect(((await over.json()) as { error: string }).error).toMatch(/past the Radar budget/);
  });

  it('the Studio page carries the Radar view and a CSP for exactly the players and the ad media', async () => {
    const owner = await ownerCookie();
    const res = await call('/admin/studio', { headers: { cookie: owner } });
    const html = await res.text();
    expect(html).toContain('id="studio-radar"');
    expect(html).toContain('data-view="radar"');
    expect(html).toContain('/assets/studio-radar.js');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("frame-src 'self' https://www.youtube-nocookie.com https://www.tiktok.com https://iframe.videodelivery.net https://*.cloudflarestream.com;");
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
