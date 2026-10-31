import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv, Runtime } from '../src/app';
import { auditCopy } from '../src/content/copy-rules';
import { requireAdmin } from '../src/admin/auth';
import { SETTINGS } from '../src/settings';
import { researchConfig, parseCompetitors } from '../src/research/config';
import { adsForCompetitor, adsForKeyword, daysRunning, redditSearch, redditSubreddit, youtubeSearch, type ResearchItemInput } from '../src/research/sources';
import { dedupeItems, saveAds, saveItems } from '../src/research/store';
import { collectVoc, vocCounts } from '../src/research/voc';
import { MAX_SHARED_WORDS, RULE_ANGLES, angleProblems, copiedFrom, longestSharedRun, loadInputs, runAnalysis, type ResearchClaude } from '../src/research/analyze';
import { buildJobs } from '../src/research/collect';
import { buildBrief, maybeRunResearch, sendBrief } from '../src/research/brief';
import { researchView, adsBoard } from '../src/research/view';
import { researchAdmin } from '../src/research/admin';

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
function freshDb(withActions = true) {
  const db = new DatabaseSync(':memory:');
  const dir = `${node.cwd()}/migrations`;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(`${dir}/${f}`, 'utf8'));
  // Builder A's action log (migration 0043) in its minimal shape, when this tree doesn't have it yet.
  if (withActions) db.exec('CREATE TABLE IF NOT EXISTS ops_actions (id TEXT PRIMARY KEY, dept TEXT, kind TEXT, summary TEXT, detail TEXT, lead_id TEXT, actor TEXT, status TEXT, payload TEXT, created_at INTEGER, updated_at INTEGER)');
  return db;
}
const makeRt = (db: DatabaseSync, settings: Record<string, string> = {}) =>
  ({ env: { DB: d1(db) }, settings: { SALES_TIMEZONE: 'UTC', ...settings }, reps: [], origin: 'https://apply.test', waitUntil: () => {} }) as unknown as Runtime;

interface Call { url: string; method: string; headers: Record<string, string>; body: string | null }
const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
function stubFetch(handler: (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ?? null });
    return handler(String(url), init);
  }));
  return calls;
}
afterEach(() => { vi.unstubAllGlobals(); });

const DAY = 86400_000;
const NOW = Date.UTC(2026, 9, 26, 12); // a Monday
const post = (id: string, o: Record<string, unknown> = {}) => ({ kind: 't3', data: { id, name: `t3_${id}`, title: `Post ${id} about SBA loan for buying a business`, selftext: 'We are stuck at 3M and the bank wants a huge down payment.', permalink: `/r/smallbusiness/comments/${id}/x/`, subreddit: 'smallbusiness', score: 40, num_comments: 12, created_utc: NOW / 1000 - 3600, ...o } });

const COMPETITOR_AD = 'Discover the secret system wealthy investors use to buy cash flowing businesses with zero money down and retire early in twelve months';

describe('Reddit client', () => {
  it('reads the public .json listing with a descriptive User-Agent, filters NSFW and stickied posts, and pulls top comments', async () => {
    const db = freshDb();
    const rt = makeRt(db, { REDDIT_USERNAME: 'gl_owner' });
    const calls = stubFetch((u) => {
      if (u.startsWith('https://www.reddit.com/r/smallbusiness/top.json?t=week')) return json(200, { data: { children: [post('a1'), post('a2', { over_18: true }), post('a3', { stickied: true }), post('a4', { num_comments: 30 })] } });
      if (u.startsWith('https://www.reddit.com/comments/a4.json')) return json(200, [{}, { data: { children: [
        { kind: 't1', data: { id: 'c1', body: 'The seller financing part is what nobody explains, banks want 20 percent down.', permalink: '/r/smallbusiness/comments/a4/x/c1/', subreddit: 'smallbusiness', score: 9, created_utc: NOW / 1000 } },
        { kind: 't1', data: { id: 'c2', body: '[deleted]', permalink: '/x', subreddit: 'smallbusiness', score: 1, created_utc: NOW / 1000 } },
        { kind: 'more', data: {} },
      ] } }]);
      return json(404, {});
    });
    const items = await redditSubreddit(rt, researchConfig(rt), 'smallbusiness');
    expect(items.map((i) => i.id)).toEqual(['reddit:t3_a1', 'reddit:t3_a4', 'reddit:t1_c1']);
    expect(items[0]).toMatchObject({ source: 'reddit', kind: 'post', url: 'https://www.reddit.com/r/smallbusiness/comments/a1/x/', community: 'r/smallbusiness', score: 40 });
    expect(items[2]).toMatchObject({ kind: 'comment', title: expect.stringContaining('Re: Post a4') });
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.headers['user-agent']).toBe('web:gl-funnel-research:1.0 (by /u/gl_owner)');
      expect(c.headers.authorization).toBeUndefined();
    }
  });

  it('uses app-only OAuth when a client id and secret are set, and caches the token', async () => {
    const db = freshDb();
    const rt = makeRt(db, { REDDIT_CLIENT_ID: 'cid', REDDIT_CLIENT_SECRET: 'sec' });
    const calls = stubFetch((u) => {
      if (u === 'https://www.reddit.com/api/v1/access_token') return json(200, { access_token: 'rtok', expires_in: 3600 });
      if (u.startsWith('https://oauth.reddit.com/search?q=seller%20financing')) return json(200, { data: { children: [post('s1')] } });
      return json(404, {});
    });
    const cfg = researchConfig(rt);
    const a = await redditSearch(rt, cfg, 'seller financing');
    await redditSearch(rt, cfg, 'seller financing');
    expect(a[0]).toMatchObject({ id: 'reddit:t3_s1', query: 'search: seller financing' });
    const tokenCalls = calls.filter((c) => c.url.endsWith('/access_token'));
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0].headers.authorization).toBe(`Basic ${btoa('cid:sec')}`);
    expect(tokenCalls[0].body).toBe('grant_type=client_credentials');
    expect(calls.filter((c) => c.url.startsWith('https://oauth.reddit.com')).every((c) => c.headers.authorization === 'Bearer rtok')).toBe(true);
  });

  it('reports a rate limit so the cron retries the job later', async () => {
    const db = freshDb();
    const rt = makeRt(db);
    stubFetch(() => json(429, {}));
    await expect(redditSearch(rt, researchConfig(rt), 'exit')).rejects.toThrow(/rate limit/);
  });
});

describe('Meta Ad Library client', () => {
  it('queries ads_archive by page id with the countries and token, and stores the public Ad Library link (not the tokened snapshot)', async () => {
    const db = freshDb();
    const rt = makeRt(db, { META_AD_LIBRARY_TOKEN: 'ADTOKEN123', RESEARCH_AD_COUNTRIES: 'GB, us' });
    const calls = stubFetch((u) => {
      if (u.startsWith('https://graph.facebook.com/v21.0/ads_archive?')) return json(200, { data: [
        { id: '111', page_id: '999', page_name: 'Deal Coach', ad_creative_bodies: [COMPETITOR_AD], ad_creative_link_titles: ['Free training'], ad_delivery_start_time: new Date(NOW - 120 * DAY).toISOString(), ad_snapshot_url: 'https://www.facebook.com/ads/archive/render_ad/?id=111&access_token=ADTOKEN123', publisher_platforms: ['facebook', 'instagram'] },
        { id: '112', page_id: '999', page_name: 'Deal Coach', ad_creative_bodies: ['Short test ad'], ad_delivery_start_time: new Date(NOW - 20 * DAY).toISOString(), ad_delivery_stop_time: new Date(NOW - 10 * DAY).toISOString() },
      ] });
      return json(404, {});
    });
    const cfg = researchConfig(rt);
    const ads = await adsForCompetitor(cfg, { name: 'Deal Coach', pageId: '999' });
    const q = new URL(calls[0].url).searchParams;
    expect(q.get('search_page_ids')).toBe('["999"]');
    expect(q.get('ad_reached_countries')).toBe('["GB","US"]');
    expect(q.get('access_token')).toBe('ADTOKEN123');
    expect(q.get('ad_type')).toBe('ALL');
    expect(ads[0]).toMatchObject({ id: '111', tracked_as: 'Deal Coach', platforms: ['facebook', 'instagram'], link_url: 'https://www.facebook.com/ads/library/?id=111' });
    expect(JSON.stringify(ads)).not.toContain('ADTOKEN123');
    expect(daysRunning(ads[0], NOW)).toBe(120);
    expect(daysRunning(ads[1], NOW)).toBe(10);
  });

  it('falls back to the ads token, labels keyword hits, and explains a missing Ad Library permission', async () => {
    const db = freshDb();
    const rt = makeRt(db, { META_ADS_TOKEN: 'ADSREAD' });
    stubFetch(() => json(200, { data: [{ id: '5', page_name: 'Someone', ad_creative_bodies: ['Buy a business'] }] }));
    const cfg = researchConfig(rt);
    expect(cfg.adToken).toBe('ADSREAD');
    expect((await adsForKeyword(cfg, 'buy a business'))[0].tracked_as).toBe('search: buy a business');
    stubFetch(() => json(400, { error: { message: 'Application does not have permission for this action', code: 10 } }));
    await expect(adsForKeyword(cfg, 'x')).rejects.toThrow(/Ad Library API access/);
  });

  it('parses competitor names and page ids', () => {
    expect(parseCompetitors('Deal Coach|123456789, 987654321, Acquisition Lab')).toEqual([
      { name: 'Deal Coach', pageId: '123456789' }, { name: '987654321', pageId: '987654321' }, { name: 'Acquisition Lab', pageId: null },
    ]);
  });
});

describe('YouTube client', () => {
  it('searches recent videos and adds view counts', async () => {
    const db = freshDb();
    const rt = makeRt(db, { YOUTUBE_API_KEY: 'YTK' });
    const calls = stubFetch((u) => {
      if (u.startsWith('https://www.googleapis.com/youtube/v3/search?')) return json(200, { items: [{ id: { videoId: 'v1' }, snippet: { title: 'How I bought a business with SBA &amp; seller notes', description: 'd', channelTitle: 'Chan', publishedAt: new Date(NOW - 5 * DAY).toISOString() } }] });
      if (u.startsWith('https://www.googleapis.com/youtube/v3/videos?')) return json(200, { items: [{ id: 'v1', statistics: { viewCount: '54321', commentCount: '12' } }] });
      return json(404, {});
    });
    const items = await youtubeSearch(researchConfig(rt), 'buy a business', NOW);
    expect(items[0]).toMatchObject({ id: 'youtube:v1', url: 'https://www.youtube.com/watch?v=v1', score: 54321, title: 'How I bought a business with SBA & seller notes' });
    expect(new URL(calls[0].url).searchParams.get('order')).toBe('viewCount');
    expect(new URL(calls[0].url).searchParams.get('key')).toBe('YTK');
  });
});

describe('dedupe', () => {
  it('saving the same post twice keeps one row and refreshes its numbers', async () => {
    const db = freshDb();
    const rt = makeRt(db);
    const item: ResearchItemInput = { id: 'reddit:t3_z', source: 'reddit', kind: 'post', external_id: 't3_z', url: 'https://www.reddit.com/x', title: 'T', body: 'B', community: 'r/x', query: 'q', score: 1, comments: 0, published_at: NOW };
    expect(dedupeItems([item, { ...item, score: 3 }])).toHaveLength(1);
    expect(await saveItems(rt, [item, { ...item, score: 3 }])).toEqual({ saved: 1, added: 1 });
    expect(await saveItems(rt, [{ ...item, score: 50 }])).toEqual({ saved: 1, added: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n, MAX(score) AS s FROM research_items').get()).toEqual({ n: 1, s: 50 });
    const ad = { id: '1', page_id: 'p', page_name: 'P', tracked_as: 'search: x', body: 'b', title: null, description: null, caption: null, link_url: null, platforms: [], languages: [], start_at: NOW - DAY, stop_at: null };
    await saveAds(rt, [ad]);
    expect(await saveAds(rt, [{ ...ad, tracked_as: 'P Brand', stop_at: NOW }])).toEqual({ saved: 1, added: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n, tracked_as, stop_at FROM research_ads').get()).toEqual({ n: 1, tracked_as: 'P Brand', stop_at: NOW });
  });
});

function seedLeads(db: DatabaseSync) {
  const ins = db.prepare("INSERT INTO leads (id, ref_code, created_at, updated_at, email, answers, app_completed_at, booking_answers, objection, notes, revenue_band, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'applied')");
  ins.run('L1', 'AAAAA1', NOW - DAY, NOW - DAY, 'a@x.com', JSON.stringify({ why_now: 'We are stuck at the 5m range and need more locations, call me on +1 555 123 4567', blockers: ['funding', 'deal_flow'], goal: 'acquire' }), NOW - DAY, null, null, null, '3m-10m');
  ins.run('L2', 'AAAAA2', NOW - DAY, NOW - DAY, 'b@x.com', JSON.stringify({ blockers: ['funding'], goal: 'group' }), NOW - DAY, JSON.stringify([{ q: 'What do you want help with?', a: 'Structuring seller finance and the bank loan for a second clinic' }, { q: 'Phone', a: '+61 400 000 000 000' }]), 'Funding doubts', 'Worried the bank will want a personal guarantee', '1m-3m');
  db.prepare("INSERT INTO webinar_interactions (id, reg_id, lead_id, session_id, kind, value, created_at) VALUES ('wi1', 'r1', 'L1', 's1', 'question', 'How do I fund an acquisition with no money down?', ?)").run(NOW - DAY);
}

describe('voice of customer', () => {
  it('turns application, booking, call and masterclass answers into linked items without contact details, and counts blockers', async () => {
    const db = freshDb();
    seedLeads(db);
    const rt = makeRt(db);
    const items = await collectVoc(rt, NOW);
    const ids = items.map((i) => i.id).sort();
    expect(ids).toEqual(['voc:app:L1', 'voc:app:L2', 'voc:book:L2', 'voc:call:L2', 'voc:wq:wi1']);
    const app = items.find((i) => i.id === 'voc:app:L1')!;
    expect(app.body).toContain('Held back by: Funding and structuring the deal; Finding the right businesses to buy');
    expect(app.body).not.toMatch(/555/);
    expect(app.url).toBe('/admin#lead=L1');
    expect(items.find((i) => i.id === 'voc:book:L2')!.body).not.toContain('Phone');
    const counts = await vocCounts(rt, NOW);
    expect(counts.blockers[0]).toEqual({ label: 'Funding and structuring the deal', count: 2 });
    expect(counts.objections).toEqual([{ label: 'Funding doubts', count: 1 }]);
  });
});

describe('originality', () => {
  it('measures the longest shared run of words', () => {
    expect(longestSharedRun('Buy a cash flowing business today', 'how to buy a cash flowing business')).toBe(5);
    expect(longestSharedRun('Totally different words here', COMPETITOR_AD)).toBe(0);
    expect(copiedFrom('Use the secret system wealthy investors use to buy companies', [COMPETITOR_AD])).toBe(COMPETITOR_AD);
    expect(copiedFrom('Agree the shape with the seller first', [COMPETITOR_AD])).toBeNull();
  });
  it('every approved template angle passes the copy rules and the angle checks', () => {
    for (const [k, a] of Object.entries(RULE_ANGLES)) {
      expect(angleProblems({ ...a, evidence: ['x'], origin: 'rules' }, [COMPETITOR_AD]), k).toEqual([]);
    }
  });
});

/** A Claude stand-in that answers with refs from the prompt, including an angle that copies a competitor ad. */
function mockClaude(seen: { system?: string; user?: string }): ResearchClaude {
  return {
    create: async (p) => {
      seen.system = (p.system as { text: string }[])[0].text;
      seen.user = (p.messages as { content: string }[])[0].content;
      const out = {
        market_themes: [{ label: 'Banks want a big down payment', kind: 'complaint', summary: 'Owners hit the deposit wall.', refs: ['m0', 'm1', 'm99', 'v0'] }],
        voc_themes: [{ label: 'Funding a second location', kind: 'desire', summary: 'Applicants want structure help.', refs: ['v0', 'v1', 'v2', 'x7'] }],
        competitor_angles: [{ advertiser: 'Deal Coach', hook: 'Zero down and retire early', offer: 'Free training then a program', guarantee: 'none seen', price: 'none seen', refs: ['a0'] }],
        angles: [
          { hook: 'Agree the shape with the seller first, then take it to the lender.', promise: 'Seller finance and seller rollover agreed first, commercial debt second, so the bank sees a structure that passes 1.5x coverage.', proof_id: 'seller_financed', audience: 'One-Business Ceiling', revenue_band: '$3M to $10M', belief: 'You start at the bank.', refs: ['v0', 'm0'] },
          { hook: 'The secret system wealthy investors use to buy cash flowing businesses.', promise: 'Learn the structure owners use.', proof_id: 'none', audience: 'Trapped Owner', revenue_band: 'All $1M+', belief: 'Buying is only for the rich.', refs: ['m1'] },
          { hook: 'Owners like you close in 47 days on average.', promise: 'Buy your competitor.', proof_id: 'none', audience: 'Trapped Owner', revenue_band: 'All $1M+', belief: 'Deals take years.', refs: ['v1'] },
          { hook: 'You might want to buy a competitor.', promise: 'It could potentially work.', proof_id: 'none', audience: 'Trapped Owner', revenue_band: 'All $1M+', belief: 'x', refs: ['v1'] },
        ],
      };
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(out) }] };
    },
  };
}

async function seedResearch(db: DatabaseSync, rt: Runtime) {
  seedLeads(db);
  await saveItems(rt, await collectVoc(rt, NOW), NOW);
  await saveItems(rt, [
    { id: 'reddit:t3_m1', source: 'reddit', kind: 'post', external_id: 't3_m1', url: 'https://www.reddit.com/r/smallbusiness/comments/m1/', title: 'Bank wants 30% down for an SBA loan', body: 'How do people finance buying a business?', community: 'r/smallbusiness', query: 'search: SBA loan', score: 120, comments: 40, published_at: NOW - 2 * DAY },
    { id: 'reddit:t3_m2', source: 'reddit', kind: 'post', external_id: 't3_m2', url: 'https://www.reddit.com/r/Entrepreneur/comments/m2/', title: 'Burned out, want to exit', body: 'Working 70 hours and no successor.', community: 'r/Entrepreneur', query: 'r/Entrepreneur top week', score: 80, comments: 10, published_at: NOW - 3 * DAY },
  ], NOW);
  await saveAds(rt, [{ id: '111', page_id: '999', page_name: 'Deal Coach', tracked_as: 'Deal Coach', body: COMPETITOR_AD, title: 'Free training', description: null, caption: 'dealcoach.example', link_url: 'https://www.facebook.com/ads/library/?id=111', platforms: ['facebook'], languages: [], start_at: NOW - 120 * DAY, stop_at: null }], NOW);
}

describe('theme and angle pipeline', () => {
  it('with Claude: counts come from linked rows, quotes from stored excerpts, and copied or non-compliant angles are dropped', async () => {
    const db = freshDb();
    const rt = makeRt(db, { ANTHROPIC_API_KEY: 'sk-test' });
    await seedResearch(db, rt);
    const seen: { system?: string; user?: string } = {};
    const r = await runAnalysis(rt, { client: mockClaude(seen), now: NOW });
    expect(r.mode).toBe('ai');
    expect(seen.system).toContain('Never reuse a phrase of five or more words');
    expect(seen.system).toContain('seller_financed:');
    expect(seen.user).toContain('a0 | Deal Coach | 120 days');
    expect(r.anglesAdded).toBe(1);
    expect(r.dropped.map((d: { hook: string }) => d.hook)).toHaveLength(3);
    expect(JSON.stringify(r.dropped)).toContain('copies competitor ad wording');
    expect(JSON.stringify(r.dropped)).toContain('unsupported number');
    expect(JSON.stringify(r.dropped)).toContain('hedge');

    const themes = db.prepare('SELECT scope, label, item_count, item_ids, meta FROM research_themes ORDER BY scope').all() as { scope: string; label: string; item_count: number; item_ids: string; meta: string | null }[];
    const market = themes.find((t) => t.scope === 'market')!;
    expect(market.item_count).toBe(2); // m99 and the v ref are not market rows
    const voc = themes.find((t) => t.scope === 'voc')!;
    expect(voc.item_count).toBe(3);
    const comp = themes.find((t) => t.scope === 'competitor')!;
    expect(JSON.parse(comp.meta!)).toMatchObject({ advertiser: 'Deal Coach', longestDays: 120, aiOffer: 'Free training then a program', offers: expect.arrayContaining(['free lead magnet', 'no money down claim']) });

    // Angles in the backlog never carry a long verbatim span from any competitor ad.
    const ads = (db.prepare('SELECT body, title FROM research_ads').all() as { body: string; title: string }[]).map((a) => `${a.title} ${a.body}`);
    const angles = db.prepare('SELECT hook, promise, belief FROM research_angles').all() as { hook: string; promise: string; belief: string }[];
    expect(angles.length).toBeGreaterThan(0);
    for (const a of angles) for (const t of [a.hook, a.promise, a.belief]) for (const ad of ads) expect(longestSharedRun(t, ad)).toBeLessThanOrEqual(MAX_SHARED_WORDS);

    const view = await researchView(rt, NOW);
    const mt = view.themes.find((t) => t.scope === 'market')!;
    expect(mt.quotes[0]).toMatchObject({ url: 'https://www.reddit.com/r/smallbusiness/comments/m1/', quote: 'How do people finance buying a business?' });
    expect(view.angles[0]).toMatchObject({ status: 'new', proof: expect.stringContaining('sellers financed 100%') });
    expect(view.angles[0].evidence.length).toBe(2);

    // Running again does not duplicate the same angle.
    const again = await runAnalysis(rt, { client: mockClaude({}), now: NOW + 1 });
    expect(again.anglesAdded).toBe(0);
  });

  it('without the Anthropic key: raw data still grouped by rules, angles from the approved templates', async () => {
    const db = freshDb();
    const rt = makeRt(db);
    await seedResearch(db, rt);
    const r = await runAnalysis(rt, { now: NOW });
    expect(r.mode).toBe('rules');
    expect(r.anglesAdded).toBeGreaterThan(0);
    const labels = (db.prepare("SELECT label FROM research_themes WHERE scope = 'voc'").all() as { label: string }[]).map((t) => t.label);
    expect(labels).toContain('Funding the purchase (SBA, bank, cash, seller financing)');
    expect(labels).toContain('Objection on calls: Funding doubts');
    const view = await researchView(rt, NOW);
    expect(view.notes[0].text).toMatch(/No Anthropic key/);
    const inputs = await loadInputs(rt, NOW);
    expect(inputs.market).toHaveLength(2);
  });

  it('falls back to rules when Claude fails', async () => {
    const db = freshDb();
    const rt = makeRt(db, { ANTHROPIC_API_KEY: 'sk-test' });
    await seedResearch(db, rt);
    const r = await runAnalysis(rt, { client: { create: async () => { throw new Error('overloaded'); } }, now: NOW });
    expect(r.mode).toBe('rules');
    expect(r.note).toMatch(/overloaded/);
  });
});

describe('Funnel HQ routes', () => {
  const appFor = (settings: Record<string, string> = {}, auth = false) => {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => { c.set('settings', { SALES_TIMEZONE: 'UTC', PUBLIC_URL: 'https://apply.test', ...settings } as never); c.set('reps', []); await next(); });
    if (auth) app.use('/admin/api/*', requireAdmin);
    app.route('/admin/api/research', researchAdmin);
    return app;
  };
  const exec = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

  it('needs an admin session, and refuses cross-site writes', async () => {
    const db = freshDb();
    const env = { DB: d1(db), ADMIN_PASSWORD: 'devpass', SECRET: 'x'.repeat(32) };
    const app = appFor({}, true);
    for (const [m, p] of [['GET', ''], ['GET', '/ads'], ['POST', '/collect'], ['POST', '/analyze'], ['GET', '/brief'], ['POST', '/brief'], ['PATCH', '/angles/x'], ['POST', '/angles/x/send']]) {
      const res = await app.request(`/admin/api/research${p}`, { method: m, headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: m === 'GET' ? undefined : '{}' }, env, exec);
      expect(res.status, `${m} ${p}`).toBe(401);
    }
    expect((await app.request('/admin/api/research/collect', { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' }, env, exec)).status).toBe(403);
  });

  it('Send to Marketing logs it and proposes marketing.test_angle through the action layer; status changes are logged', async () => {
    const db = freshDb();
    const rt = makeRt(db);
    await seedResearch(db, rt);
    await runAnalysis(rt, { now: NOW });
    const angle = db.prepare('SELECT id, hook FROM research_angles LIMIT 1').get() as { id: string; hook: string };
    const app = appFor();
    const env = { DB: d1(db) };
    const res = await app.request(`/admin/api/research/angles/${angle.id}/send`, { method: 'POST', body: '{}' }, env, exec);
    const body = await res.json() as { ok: boolean; actionId: string };
    expect(body.ok).toBe(true);
    const actions = db.prepare('SELECT id, dept, kind, status, actor, payload, risk FROM ops_actions ORDER BY created_at').all() as { id: string; dept: string; kind: string; status: string; actor: string; payload: string; risk: string | null }[];
    const proposal = actions.find((a) => a.kind === 'marketing.test_angle')!;
    expect(proposal).toMatchObject({ id: body.actionId, dept: 'marketing', status: 'proposed' });
    expect(JSON.parse(proposal.payload)).toMatchObject({ angleId: angle.id, hook: angle.hook });
    expect(proposal.risk ?? JSON.parse(proposal.payload).risk).toBe('medium');
    expect(actions.find((a) => a.kind === 'research.angle_sent')).toMatchObject({ dept: 'research', actor: 'you', status: 'done' });
    expect(db.prepare('SELECT status, action_id FROM research_angles WHERE id = ?').get(angle.id)).toEqual({ status: 'approved', action_id: body.actionId });
    expect((await app.request(`/admin/api/research/angles/${angle.id}/send`, { method: 'POST', body: '{}' }, env, exec)).status).toBe(409);

    // Once Marketing's proposal is approved, the angle shows as testing.
    db.prepare("UPDATE ops_actions SET status = 'approved' WHERE id = ?").run(body.actionId);
    const view = await researchView(rt, NOW);
    expect(view.angles.find((a) => a.id === angle.id)!.status).toBe('testing');

    const bad = await app.request(`/admin/api/research/angles/${angle.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'viral' }) }, env, exec);
    expect(bad.status).toBe(400);
    const ok = await app.request(`/admin/api/research/angles/${angle.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'winner' }) }, env, exec);
    expect(ok.status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS n FROM ops_actions WHERE kind = 'research.angle_status'").get()).toEqual({ n: 1 });
  });

  it('the ads board filters by advertiser and running days', async () => {
    const db = freshDb();
    const rt = makeRt(db);
    await saveAds(rt, [
      { id: '1', page_id: 'p', page_name: 'Deal Coach', tracked_as: 'Deal Coach', body: 'a', title: null, description: null, caption: null, link_url: null, platforms: ['facebook'], languages: [], start_at: NOW - 100 * DAY, stop_at: null },
      { id: '2', page_id: 'q', page_name: 'Other Page', tracked_as: 'search: buy a business', body: 'b', title: null, description: null, caption: null, link_url: null, platforms: [], languages: [], start_at: NOW - 5 * DAY, stop_at: null },
    ], NOW);
    const all = await adsBoard(rt, {}, NOW);
    expect(all.ads.map((a) => [a.id, a.days])).toEqual([['1', 100], ['2', 5]]);
    expect(all.advertisers.map((a) => a.name).sort()).toEqual(['Deal Coach', 'Other Page']);
    expect((await adsBoard(rt, { minDays: 30 }, NOW)).ads.map((a) => a.id)).toEqual(['1']);
    expect((await adsBoard(rt, { advertiser: 'Other Page' }, NOW)).ads.map((a) => a.id)).toEqual(['2']);
  });
});

describe('cron and weekly brief', () => {
  it('collects in slices, analyses once, and posts the brief on its day with real counts', async () => {
    const db = freshDb();
    seedLeads(db);
    const rt = makeRt(db, { RESEARCH_SUBREDDITS: 'smallbusiness', RESEARCH_KEYWORDS: 'exit', RESEARCH_HOUR: '0', RESEARCH_BRIEF_DAY: 'Mon', RESEARCH_BRIEF_HOUR: '13', SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x' });
    const slack: string[] = [];
    stubFetch((u, init) => {
      if (u.startsWith('https://www.reddit.com/r/smallbusiness/top.json')) return json(200, { data: { children: [post('a1')] } });
      if (u.startsWith('https://www.reddit.com/comments/a1.json')) return json(200, [{}, { data: { children: [] } }]);
      if (u.startsWith('https://www.reddit.com/search.json')) return json(200, { data: { children: [post('s1', { title: 'Planning my exit, no successor' })] } });
      if (u === 'https://hooks.slack.test/x') { slack.push(String(init.body)); return new Response('ok'); }
      return json(404, {});
    });
    expect(buildJobs(researchConfig(rt)).jobs.map((j) => j.t)).toEqual(['voc', 'reddit_sub', 'reddit_search']);
    const first = await maybeRunResearch(rt, NOW);
    expect(first).toMatchObject({ collected: 3 });
    expect(first?.analysis).toBeUndefined(); // analysis on the next tick, once collection is done
    const second = await maybeRunResearch(rt, NOW + 5 * 60_000);
    expect(second?.analysis).toMatchObject({ mode: 'rules' });
    expect(await maybeRunResearch(rt, NOW + 10 * 60_000)).toBeNull(); // nothing left for today

    const brief = await buildBrief(rt, NOW + DAY);
    expect(brief.numbers).toMatchObject({ reddit: 2, voc: 5, adsNew: 0 });
    expect(brief.lines[0]).toBe('New this week: 2 Reddit posts and comments, 0 YouTube videos, 5 answers from our own leads, 0 competitor ads.');
    for (const l of brief.lines) expect(l).not.toMatch(/[—!]/);

    const monday13 = Date.UTC(2026, 10, 2, 13, 2);
    const out = await maybeRunResearch(rt, monday13);
    expect(out?.brief).toBeTruthy();
    expect(slack).toHaveLength(1);
    expect(slack[0]).toContain('Research brief');
    expect(db.prepare("SELECT COUNT(*) AS n FROM ops_actions WHERE kind = 'research.brief' AND actor = 'auto'").get()).toEqual({ n: 1 });
    await maybeRunResearch(rt, monday13 + 5 * 60_000);
    expect(slack).toHaveLength(1); // once per day
  });

  it('works without the action log table (stub logs to the console)', async () => {
    const db = freshDb(false);
    const rt = makeRt(db);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const b = await sendBrief(rt, NOW);
    expect(b.sent).toEqual({ slack: false, discord: false });
  });
});

describe('copy', () => {
  it('Research tab and settings copy pass the copy rules', () => {
    const js = fs.readFileSync(`${node.cwd()}/public/assets/admin-research.js`, 'utf8');
    const strings = [...js.matchAll(/'([A-Z][^'\n]{6,})'/g)].map((m) => m[1]).filter((s) => !/[{}<>=;]|^[A-Z_]+$/.test(s));
    expect(strings.length).toBeGreaterThan(10);
    const help = SETTINGS.filter((s) => s.group === 'Research').flatMap((s) => [s.label, 'help' in s ? s.help : '']).filter(Boolean) as string[];
    for (const s of [...strings, ...help]) {
      expect(auditCopy(s), s).toEqual([]);
      expect(s, s).not.toMatch(/[—!]/);
    }
  });
});
