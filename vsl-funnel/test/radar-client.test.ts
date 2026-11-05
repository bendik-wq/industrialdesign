import { describe, expect, it } from 'vitest';
import { MonidError, estimateMicros, monidClient, parseDiscover, parsePrice, parseRun, toMicros } from '../src/radar/monid';
import { adLibraryUrl, isRecommended, mapInput, schemaFields } from '../src/radar/sources';
import { DISCOVER_A, DISCOVER_B, INSPECT_ADS, INSPECT_YT } from './radar-fixtures';

// Radar: the Monid client against a fake API (sync 200, async 202 + polling, failures), discover parsing, prices,
// and the input mapper for each kind of tool.

type Call = { url: string; method: string; body: unknown; auth: string | null };
function fakeMonid(routes: Record<string, (body: unknown, calls: Call[]) => { status?: number; json: unknown }>) {
  const calls: Call[] = [];
  const fetchFn = async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body, auth: new Headers(init?.headers).get('authorization') });
    const key = `${method} ${u.pathname.replace(/^\/v1/, '').replace(/\/runs\/.+$/, '/runs/:id')}`;
    const h = routes[key];
    if (!h) return new Response('{"error":"not found"}', { status: 404 });
    const r = h(body, calls);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchFn };
}

describe('Monid client', () => {
  it('sends the bearer key and parses a sync 200 run with its bill in micro-dollars', async () => {
    const f = fakeMonid({ 'POST /run': () => ({ json: { runId: 'run_1', status: 'COMPLETED', output: [{ a: 1 }, { a: 2 }], resultCount: 2, billing: { actualCost: { value: 12_500, unit: 'MICRO_DOLLAR' } } } }) });
    const c = monidClient('mk_test', f.fetchFn);
    const r = await c.run('apify', '/streamers/youtube-scraper', { searchQueries: ['x'] });
    expect(f.calls[0]).toMatchObject({ url: 'https://api.monid.ai/v1/run', method: 'POST', auth: 'Bearer mk_test', body: { provider: 'apify', endpoint: '/streamers/youtube-scraper', input: { body: { searchQueries: ['x'] } } } });
    expect(r).toMatchObject({ runId: 'run_1', status: 'COMPLETED', resultCount: 2, costMicros: 12_500 });
    expect(r.output).toHaveLength(2);
  });

  it('handles a 202 RUNNING and then polls GET /runs/:id until COMPLETED', async () => {
    let polls = 0;
    const f = fakeMonid({
      'POST /run': () => ({ status: 202, json: { runId: 'run_async', status: 'RUNNING' } }),
      'GET /runs/:id': () => (++polls < 2 ? { json: { runId: 'run_async', status: 'RUNNING' } } : { json: { runId: 'run_async', status: 'COMPLETED', output: { items: [{ id: 1 }] }, billing: { actualCost: { value: 3000 } } } }),
    });
    const c = monidClient('k', f.fetchFn);
    const started = await c.run('apify', '/x', {});
    expect(started).toMatchObject({ runId: 'run_async', status: 'RUNNING', costMicros: null });
    expect((await c.getRun('run_async')).status).toBe('RUNNING');
    const done = await c.getRun('run_async');
    expect(done).toMatchObject({ status: 'COMPLETED', costMicros: 3000 });
    expect(f.calls.at(-1)!.url).toBe('https://api.monid.ai/v1/runs/run_async');
  });

  it('reports failures plainly: bad key, no credit, rate limit, other errors, FAILED runs', async () => {
    for (const [status, re] of [[401, /did not accept the API key/], [402, /out of credit/], [429, /slow down/], [500, /Monid answered 500: boom/]] as const) {
      const f = fakeMonid({ 'POST /run': () => ({ status, json: { error: 'boom' } }) });
      const err = await monidClient('k', f.fetchFn).run('a', '/b', {}).catch((e) => e);
      expect(err).toBeInstanceOf(MonidError);
      expect(err.message).toMatch(re);
    }
    const f = fakeMonid({ 'GET /runs/:id': () => ({ json: { status: 'FAILED', error: { message: 'actor crashed' }, billing: { actualCost: { value: 100 } } } }) });
    expect(await monidClient('k', f.fetchFn).getRun('r')).toMatchObject({ status: 'FAILED', error: 'actor crashed', costMicros: 100 });
    expect(() => monidClient('', f.fetchFn)).toThrow(/Monid API key/);
    // A 202 without a run id can't be polled: refuse it rather than lose the run.
    const g = fakeMonid({ 'POST /run': () => ({ status: 202, json: { status: 'RUNNING' } }) });
    await expect(monidClient('k', g.fetchFn).run('a', '/b', {})).rejects.toThrow(/no run id/);
  });

  it('inspect keeps the schema and the price', async () => {
    const f = fakeMonid({ 'POST /inspect': () => ({ json: INSPECT_YT }) });
    const t = await monidClient('k', f.fetchFn).inspect('apify', '/streamers/youtube-scraper');
    expect(t).toMatchObject({ provider: 'apify', endpoint: '/streamers/youtube-scraper', name: 'Apify', docUrl: 'https://apify.com/streamers/youtube-scraper', price: { type: 'PER_RESULT', amount: 5000, currency: 'MICRO_DOLLAR' } });
    expect(schemaFields(t.inputSchema).map((x) => x.name)).toContain('searchQueries');
  });
});

describe('discover parsing', () => {
  it('finds tools in any wrapper, normalises endpoints and dedupes', () => {
    const a = parseDiscover(DISCOVER_A);
    expect(a.map((t) => t.endpoint)).toEqual(['/streamers/youtube-scraper', '/someone/youtube-comments']);
    expect(a[0].price).toMatchObject({ type: 'PER_RESULT', amount: 0.005 });
    const b = parseDiscover(DISCOVER_B);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ provider: 'apify', endpoint: '/clockworks/tiktok-scraper', name: 'TikTok Scraper', price: { type: 'PER_RESULT', amount: 0.004 } });
    expect(parseDiscover([...DISCOVER_A.results, ...DISCOVER_A.results])).toHaveLength(2);
    for (const junk of [null, 'text', 42, { results: 'none' }, [{ foo: 1 }], { a: { b: { c: { d: { e: { f: [{ provider: 'x', endpoint: 'y' }] } } } } } }]) expect(() => parseDiscover(junk)).not.toThrow();
  });
  it('known actors are recommended for their slot', () => {
    expect(isRecommended('youtube:search', 'apify', '/streamers/youtube-scraper')).toBe(true);
    expect(isRecommended('tiktok:search', 'apify', '/clockworks/tiktok-scraper')).toBe(true);
    expect(isRecommended('meta_ads:ads', 'apify', '/curious_coder/facebook-ads-library-scraper')).toBe(true);
    expect(isRecommended('youtube:transcript', 'apify', '/someone/youtube-transcript-scraper')).toBe(true);
    expect(isRecommended('youtube:search', 'apify', '/someone/youtube-comments')).toBe(false);
  });
});

describe('prices', () => {
  it('converts to micro-dollars and estimates a run', () => {
    expect(toMicros(0.005)).toBe(5000);
    expect(toMicros(5000, 'MICRO_DOLLAR')).toBe(5000);
    expect(estimateMicros(parsePrice({ type: 'PER_RESULT', amount: 0.005, currency: 'USD' }), 15)).toBe(75_000);
    expect(estimateMicros(parsePrice({ type: 'PER_CALL', amount: 0.02, flatFee: 0.01 }), 15)).toBe(30_000);
    expect(estimateMicros(null, 15)).toBe(0);
    expect(parseRun({ status: 'completed', output: [] }).status).toBe('COMPLETED');
  });
});

describe('the input mapper', () => {
  const q = { keywords: ['business acquisition', 'seller financing'], max: 15, sinceDays: 30, country: 'us' };
  it('fills a YouTube search tool: list of queries, max, date enum, sort by views; keeps required defaults', () => {
    const m = mapInput('youtube:search', INSPECT_YT.inputSchema, q);
    expect(m.inputs).toEqual([{ searchQueries: ['business acquisition', 'seller financing'], maxResults: 15, dateFilter: 'month', sortingOrder: 'views' }]);
    expect(m.missing).toEqual([]);
    expect(m.notes.join(' ')).toMatch(/searchQueries/);
  });
  it('runs once per keyword when the tool takes one search string', () => {
    const m = mapInput('tiktok:search', { properties: { query: { type: 'string' }, limit: { type: 'number' }, region: { type: 'string', enum: ['US', 'AU', 'GB'] } }, required: ['query'] }, q);
    expect(m.inputs).toEqual([{ query: 'business acquisition', limit: 15, region: 'US' }, { query: 'seller financing', limit: 15, region: 'US' }]);
  });
  it('builds Ad Library search URLs for the Meta ads scrapers', () => {
    const m = mapInput('meta_ads:ads', INSPECT_ADS.inputSchema, q);
    expect(m.inputs).toHaveLength(1);
    const urls = m.inputs[0].urls as { url: string }[];
    expect(urls).toHaveLength(2);
    expect(urls[0].url).toBe(adLibraryUrl('business acquisition', 'us'));
    expect(new URL(urls[0].url).searchParams.get('country')).toBe('US');
    expect(new URL(urls[0].url).searchParams.get('active_status')).toBe('active');
    expect(m.inputs[0].count).toBe(15);
  });
  it('fills transcript tools with the video link', () => {
    expect(mapInput('youtube:transcript', { properties: { startUrls: { type: 'array', items: { type: 'object' } } } }, { keywords: [], max: 1, urls: ['https://www.youtube.com/watch?v=aBcDeFgHiJ1'] }).inputs)
      .toEqual([{ startUrls: [{ url: 'https://www.youtube.com/watch?v=aBcDeFgHiJ1' }] }]);
    expect(mapInput('tiktok:transcript', { properties: { videoUrl: { type: 'string' } } }, { keywords: [], max: 1, urls: ['https://www.tiktok.com/@a/video/1'] }).inputs)
      .toEqual([{ videoUrl: 'https://www.tiktok.com/@a/video/1' }]);
  });
  it('uses the usual field names when a tool gives no schema, reports missing required fields, and merges the template', () => {
    const none = mapInput('youtube:search', null, q);
    expect(none.inputs[0]).toMatchObject({ searchQueries: q.keywords, maxResults: 15, dateFilter: 'month' });
    expect(none.notes[0]).toMatch(/no input schema/);
    const miss = mapInput('youtube:search', { properties: { channelId: { type: 'string' }, searchQueries: { type: 'array' } }, required: ['channelId'] }, q);
    expect(miss.missing).toEqual(['channelId']);
    const t = mapInput('youtube:search', { properties: { channelId: { type: 'string' }, q: { type: 'string' } }, required: ['channelId'] }, q, { channelId: 'UC123', note: 'about {{keyword}} in {{country}}', all: '{{keywords}}' });
    expect(t.missing).toEqual([]);
    expect(t.inputs[1]).toMatchObject({ q: 'seller financing', channelId: 'UC123', note: 'about seller financing in US', all: q.keywords });
  });
  it('accepts a date field as a plain date, and ignores booleans named like search fields', () => {
    const m = mapInput('tiktok:search', { properties: { search: { type: 'boolean' }, searchQueries: { type: 'array' }, publishedAfter: { type: 'string' } } }, { ...q, sinceDays: 7 });
    expect(m.inputs[0].search).toBeUndefined();
    expect(m.inputs[0].searchQueries).toEqual(q.keywords);
    expect(m.inputs[0].publishedAfter).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
