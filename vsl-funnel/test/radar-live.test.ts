import { describe, expect, it } from 'vitest';
import { estimateMicros, monidClient, parsePrice, parseRun, priceFor, runInput } from '../src/radar/monid';
import { normalise, scoreItem, transcriptText } from '../src/radar/normalise';
import { DEFAULT_TOOLS, SLOTS, adLibraryUrl, builtinFor, isRecommended, knownRank, mapInput, schemaFields } from '../src/radar/sources';
import { IG_SEARCH_RUN, IG_TRANSCRIPT_RUN } from './monid-live';
import { FAILED_INPUT_RUN, INSPECT_ANYAPI_YT, INSPECT_FB_ADS, META_ADS_RUN, RUN_STARTED, TT_SEARCH_RUN, YT_SEARCH_RUN, YT_TRANSCRIPT_RUN } from './monid-live';

// Radar against Monid's real reply shapes (saved production runs in test/fixtures/monid): the run body wrapper,
// inspect's input.body schema, route-priced matrices, cost in dollars, provider refusals, the built-in inputs of the
// known tools, and each platform's normaliser and score.

const NOW = Date.parse('2026-11-05T03:00:00Z');
const DAY = 86400_000;

function fake(reply: (path: string, body: unknown) => { status?: number; json: unknown }) {
  const calls: { path: string; body: unknown }[] = [];
  const fetchFn = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname.replace(/^\/v1/, '');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    const r = reply(path, body);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  };
  return { calls, fetchFn };
}

describe('the Monid client, real shapes', () => {
  it('sends the tool input wrapped as {body}, reads the RUNNING reply, then the COMPLETED run with its cost in dollars', async () => {
    const f = fake((path) => (path === '/run' ? { json: RUN_STARTED } : { json: YT_SEARCH_RUN }));
    const c = monidClient('k', f.fetchFn);
    const started = await c.run('anyapi', '/youtube.search', { query: 'buy a business no money down', sortBy: 'popular', route: 'giraffe' });
    expect(f.calls[0].body).toEqual({ provider: 'anyapi', endpoint: '/youtube.search', input: { body: { query: 'buy a business no money down', sortBy: 'popular', route: 'giraffe' } } });
    expect(started).toMatchObject({ runId: RUN_STARTED.runId, status: 'RUNNING', costMicros: null });
    const done = await c.getRun(String(RUN_STARTED.runId));
    expect(done).toMatchObject({ status: 'COMPLETED', costMicros: 1200, resultCount: 1 });
    expect(done.error).toBeUndefined();
    // An input already wrapped is not wrapped twice.
    expect(runInput({ body: { query: 'x' } })).toEqual({ body: { query: 'x' } });
    expect(runInput(null)).toEqual({ body: {} });
  });

  it('a COMPLETED run the provider refused is a failure with the provider\'s message and no cost', () => {
    expect(parseRun(FAILED_INPUT_RUN)).toMatchObject({ status: 'FAILED', costMicros: 0, error: 'source_unknown: sortBy popular is not available on route lynx' });
    expect(parseRun({ status: 'COMPLETED', providerResponse: { httpStatus: 502 }, cost: { value: 0, currency: 'USD' } })).toMatchObject({ status: 'FAILED', error: 'the provider answered 502' });
    expect(parseRun({ status: 'COMPLETED', providerResponse: { httpStatus: 200 }, output: [] }).status).toBe('COMPLETED');
  });

  it('inspect: the input schema is input.body, the price a matrix by route, notes joined', async () => {
    const f = fake(() => ({ json: INSPECT_ANYAPI_YT }));
    const t = await monidClient('k', f.fetchFn).inspect('anyapi', '/youtube.search');
    expect(f.calls[0]).toEqual({ path: '/inspect', body: { provider: 'anyapi', endpoint: '/youtube.search' } });
    expect(t).toMatchObject({ provider: 'anyapi', endpoint: '/youtube.search', name: 'AnyAPI', docUrl: 'https://docs.example/youtube.search', notes: 'sortBy popular needs the giraffe or badger route.' });
    expect(schemaFields(t.inputSchema).map((x) => x.name)).toEqual(['query', 'sortBy', 'uploadDate', 'route']);
    expect(t.price).toMatchObject({ type: 'PER_UNIT_MATRIX', amount: 0.0005, currency: 'USD', selectors: [{ key: 'route', in: 'body' }] });
    expect(t.price!.variants!.map((v) => [v.when.route, v.amount])).toEqual([['lynx', 0.0005], ['badger', 0.0012], ['giraffe', 0.0012]]);
  });
});

describe('prices, real shapes', () => {
  const matrix = parsePrice(RUN_STARTED.price)!;
  it('a matrix costs the variant of the chosen route, else the base amount', () => {
    expect(priceFor(matrix, { query: 'x', route: 'giraffe' })).toMatchObject({ type: 'PER_CALL', amount: 0.0012 });
    expect(estimateMicros(matrix, 15, { query: 'x', route: 'giraffe' })).toBe(1200);
    expect(estimateMicros(matrix, 15, { body: { route: 'lynx' } })).toBe(500);
    expect(estimateMicros(matrix, 15, { query: 'x' })).toBe(500);
    // A price stored after parsing (radar_tools.price_json) parses to the same thing.
    expect(parsePrice(JSON.parse(JSON.stringify(matrix)))).toEqual(matrix);
    const tiered = parsePrice(IG_TRANSCRIPT_RUN.price);
    expect(parsePrice(JSON.parse(JSON.stringify(tiered)))).toEqual(tiered);
  });
  it('per result: {value, currency} in dollars', () => {
    const p = parsePrice(INSPECT_FB_ADS.price)!;
    expect(p).toMatchObject({ type: 'PER_RESULT', amount: 0.00075, currency: 'USD', notes: 'Per-result price applies per query in the input.' });
    expect(estimateMicros(p, 15)).toBe(11_250);
    expect(estimateMicros(parsePrice(YT_TRANSCRIPT_RUN.price), 1)).toBe(5000);
  });
  it('tiered: the default tier, per unit plus its flat fee (the 65-unit reel billed $0.008)', () => {
    const p = parsePrice(IG_TRANSCRIPT_RUN.price)!;
    expect(p).toMatchObject({ type: 'PER_RESULT', amount: 0.0001, flatFee: 0.0015, currency: 'USD' });
    expect(estimateMicros(p, 65)).toBe(8000);
    expect(parseRun(IG_TRANSCRIPT_RUN).costMicros).toBe(8000);
  });
});

describe('the known tools and their built-in inputs', () => {
  const q = { keywords: ['buy a business', 'seller financing'], max: 15, sinceDays: 90, country: 'us' };
  it('the production tools are the recommended defaults of their slots', () => {
    expect(knownRank('youtube:search', 'anyapi', '/youtube.search')).toBe(0);
    expect(knownRank('youtube:search', 'other', '/youtube.search')).toBe(-1);
    expect(knownRank('tiktok:search', 'anyapi', '/tiktok.search_keyword')).toBe(0);
    expect(knownRank('youtube:transcript', 'apify', '/starvibe/youtube-video-transcript')).toBe(0);
    expect(knownRank('meta_ads:ads', 'apify', '/curious_coder/facebook-ads-library-scraper')).toBe(0);
    expect(isRecommended('tiktok:transcript', 'anyapi', '/tiktok.video_transcript_full')).toBe(true);
    expect(knownRank('instagram:search', 'anyapi', '/instagram.reels_search')).toBe(0);
    expect(knownRank('instagram:transcript', 'anyapi', '/instagram.reel_transcript')).toBe(0);
    // Every default tool has a built-in input.
    for (const t of DEFAULT_TOOLS) expect(builtinFor(t.provider, t.endpoint)?.slot, t.slot).toBe(t.slot);
    expect(DEFAULT_TOOLS.map((t) => t.slot).sort()).toEqual(SLOTS.map((s) => s.slot).sort());
  });
  it('YouTube search: one run per keyword, popular on the giraffe route, upload date from the radar\'s window', () => {
    const m = mapInput('youtube:search', INSPECT_ANYAPI_YT.input.body, q, null, { provider: 'anyapi', endpoint: '/youtube.search' });
    expect(m.inputs).toEqual([
      { query: 'buy a business', sortBy: 'popular', route: 'giraffe', uploadDate: 'this_year' },
      { query: 'seller financing', sortBy: 'popular', route: 'giraffe', uploadDate: 'this_year' },
    ]);
    expect(m.missing).toEqual([]);
    expect(m.notes[0]).toMatch(/Built-in input/);
    expect(mapInput('youtube:search', null, { ...q, sinceDays: 5 }, null, { provider: 'anyapi', endpoint: '/youtube.search' }).inputs[0].uploadDate).toBe('this_week');
    expect(mapInput('youtube:search', null, { ...q, sinceDays: null }, null, { provider: 'anyapi', endpoint: '/youtube.search' }).inputs[0]).not.toHaveProperty('uploadDate');
    // The owner's template still goes on top.
    expect(mapInput('youtube:search', null, q, { route: 'badger' }, { provider: 'anyapi', endpoint: '/youtube.search' }).inputs[1]).toMatchObject({ query: 'seller financing', route: 'badger' });
  });
  it('TikTok search, the YouTube transcript and the Meta Ad Library', () => {
    expect(mapInput('tiktok:search', null, q, null, { provider: 'anyapi', endpoint: '/tiktok.search_keyword' }).inputs).toEqual([{ query: 'buy a business' }, { query: 'seller financing' }]);
    expect(mapInput('youtube:transcript', null, { keywords: [], max: 1, urls: ['https://www.youtube.com/watch?v=_qrVANZNXNg'] }, null, { provider: 'apify', endpoint: '/starvibe/youtube-video-transcript' }).inputs)
      .toEqual([{ youtube_url: 'https://www.youtube.com/watch?v=_qrVANZNXNg' }]);
    const ads = mapInput('meta_ads:ads', INSPECT_FB_ADS.input.body, q, null, { provider: 'apify', endpoint: '/curious_coder/facebook-ads-library-scraper' });
    expect(ads.inputs).toEqual([{ urls: [{ url: adLibraryUrl('buy a business', 'us') }, { url: adLibraryUrl('seller financing', 'us') }], count: 30, limitPerSource: 15 }]);
    // The same URL shape the production run used.
    expect(adLibraryUrl('buy a business', 'US')).toBe('https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=US&q=buy+a+business&search_type=keyword_unordered&media_type=all');
  });
  it('Instagram: reels search per keyword; the reel transcript takes the link and counts the reel\'s seconds', () => {
    expect(mapInput('instagram:search', null, q, null, { provider: 'anyapi', endpoint: '/instagram.reels_search' }).inputs).toEqual([{ query: 'buy a business' }, { query: 'seller financing' }]);
    const tq = { keywords: [], max: 1, urls: ['https://www.instagram.com/reel/DYRouZDjnOb/'], durationS: 64.76 };
    expect(mapInput('instagram:transcript', null, tq, null, { provider: 'anyapi', endpoint: '/instagram.reel_transcript' }).inputs).toEqual([{ url: 'https://www.instagram.com/reel/DYRouZDjnOb/' }]);
    expect(builtinFor('anyapi', '/instagram.reel_transcript')!.units!(tq)).toBe(65);
    expect(builtinFor('anyapi', '/instagram.reel_transcript')!.units!({ ...tq, durationS: null })).toBe(90);
  });
  it('the TikTok transcript tool fills its link from the schema inspect gives', () => {
    expect(mapInput('tiktok:transcript', { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }, { keywords: [], max: 1, urls: ['https://www.tiktok.com/@a/video/1'] }, null, { provider: 'anyapi', endpoint: '/tiktok.video_transcript_full' }).inputs)
      .toEqual([{ url: 'https://www.tiktok.com/@a/video/1' }]);
  });
});

describe('normalisers on real output', () => {
  it('YouTube search (anyapi): ids, channel, views, published from createdUtc, length text, thumbnail; no likes or followers', () => {
    const items = normalise('youtube', YT_SEARCH_RUN.output, NOW);
    expect(items).toHaveLength(4);
    expect(items[0]).toMatchObject({
      id: 'youtube:j39pFtLyFSU', url: 'https://www.youtube.com/watch?v=j39pFtLyFSU', title: 'How to Buy a Business With No Money Down', author: 'Marvin Francois',
      author_id: 'UCCU8OcQzN6X00j-CXvWnAog', views: 11_206, duration_s: 4250, published_at: new Date(1792030668 * 1000).toISOString(),
      thumbnail_url: 'https://i.ytimg.com/vi/j39pFtLyFSU/hq720.jpg', embed_url: 'https://www.youtube-nocookie.com/embed/j39pFtLyFSU?rel=0&modestbranding=1',
      likes: null, comments: null, followers: null,
    });
  });
  it('TikTok search (anyapi): handle, followers, plays, likes, comments, shares, cover; never the video file', () => {
    const [t, ...rest] = normalise('tiktok', TT_SEARCH_RUN.output, NOW);
    expect(rest).toHaveLength(2);
    expect(t).toMatchObject({
      id: 'tiktok:7635714843097517342', author: 'brian_luebben', author_id: '6812256086281651206', followers: 191_598, views: 59_481, likes: 4663, comments: 51, shares: 601,
      duration_s: 66.067, caption: 'How to buy a business for no money down', title: 'How to buy a business for no money down',
      url: 'https://www.tiktok.com/@brian_luebben/video/7635714843097517342', embed_url: 'https://www.tiktok.com/embed/v2/7635714843097517342', media_url: null,
      published_at: new Date(1777828421 * 1000).toISOString(),
    });
    expect(t.thumbnail_url).toMatch(/^https:\/\/p16-common-sign\.tiktokcdn-us\.com\//);
  });
  it('Meta ads (curious_coder): days active from the start date, variants from collation_count, creative text and media; catalogue placeholders skipped', () => {
    const [video, dyn, image] = normalise('meta_ads', META_ADS_RUN.output, NOW);
    expect(video).toMatchObject({
      id: 'meta_ads:2043835713041207', author: 'Next Insurance', ad_active: 1, ad_variants: 1, media_kind: 'video', ad_cta: 'Get quote', followers: 106_718,
      caption: 'Trusted By Over 750,000 Customers. Buy Your Insurance Easily Online in 5 Minutes!', title: 'Get a Free Quote Online in 5min',
      url: 'https://www.facebook.com/ads/library/?id=2043835713041207', ad_start: new Date(1769673600 * 1000).toISOString(),
      ad_active_days: Math.round((NOW - 1769673600 * 1000) / DAY), ad_platforms: expect.stringContaining('facebook'),
    });
    expect(video.media_url).toMatch(/^https:\/\/video/);
    expect(dyn).toMatchObject({ id: 'meta_ads:2092222814666607', ad_variants: 4, title: 'Honest ratings & reviews', caption: expect.stringMatching(/^No freebies/), ad_cta: 'Subscribe', media_kind: 'image' });
    expect(image).toMatchObject({ id: 'meta_ads:2006807903279406', title: 'Natural Relief in Weeks', media_kind: 'image', ad_link: 'https://shop.pipitea.com/ppch/sp', caption: expect.stringMatching(/^I found a wallet/) });
  });
  it('the YouTube transcript (starvibe): segments with [m:ss] marks, and the video\'s numbers for the item', () => {
    const text = transcriptText(YT_TRANSCRIPT_RUN.output)!;
    expect(text.split('\n')[0]).toBe('[0:00] have you ever wanted to buy a small');
    expect(text.split('\n')).toHaveLength(8);
    const [v] = normalise('youtube', YT_TRANSCRIPT_RUN.output, NOW);
    expect(v).toMatchObject({ id: 'youtube:_qrVANZNXNg', views: 18_524, likes: 464, comments: 24, followers: 125_000, duration_s: 1041, author: 'Mat Sorensen | Retirement Planning & Tax Strategy', published_at: '2024-03-15T15:00:28.000Z' });
  });
});

describe('Instagram on real output', () => {
  it('reels search (anyapi): handle, views, likes, comments, reshares, cover; never the video file', () => {
    const [r, ...rest] = normalise('instagram', IG_SEARCH_RUN.output, NOW);
    expect(rest).toHaveLength(2);
    expect(r).toMatchObject({
      id: 'instagram:3896074262511776667', url: 'https://www.instagram.com/reel/DYRouZDjnOb/', author: 'themikewarren', author_id: '37347225',
      views: 1394, likes: 34, comments: 13, shares: 20, followers: null, duration_s: 64.76000213623047, media_url: null,
      published_at: new Date(1778691135 * 1000).toISOString(), title: 'I Found a HVAC Company That\'s Almost Impossible to Lose Money On',
    });
    expect(r.thumbnail_url).toMatch(/^https:\/\/scontent-[a-z0-9-]+\.cdninstagram\.com\//);
    const items = normalise('instagram', IG_SEARCH_RUN.output, NOW);
    const s = items.map((i) => scoreItem(i, { platformViews: items.map((x) => x.views!), now: NOW }));
    expect(s.every((p) => p.ratio_basis === 'platform' && p.engagement != null)).toBe(true);
  });
  it('the reel transcript: timed segments, and the like count for the item', () => {
    const text = transcriptText(IG_TRANSCRIPT_RUN.output)!;
    expect(text.split('\n')[0]).toBe('[0:00] I found a small HVAC company making $225,000 a year in profit.');
    expect(text.split('\n')).toHaveLength(6);
    const [v] = normalise('instagram', IG_TRANSCRIPT_RUN.output, NOW);
    expect(v).toMatchObject({ id: 'instagram:3896074262511776667', likes: 34, author: 'themikewarren' });
  });
});

describe('scoring on real output', () => {
  it('YouTube search scores on views against the typical video and views per day, with no engagement part', () => {
    const items = normalise('youtube', YT_SEARCH_RUN.output, NOW);
    const all = items.map((i) => i.views!);
    const s = items.map((i) => scoreItem(i, { platformViews: all, now: NOW }));
    for (const p of s) expect(p).toMatchObject({ ratio_basis: 'platform', engagement: null });
    // The newest video (three weeks old, 11K views) beats an older one with fewer views.
    const byId = Object.fromEntries(items.map((i, k) => [i.external_id, s[k]]));
    expect(byId['j39pFtLyFSU'].score).toBeGreaterThan(byId['-DAzLPJQRaQ'].score);
    expect(byId['j39pFtLyFSU'].velocity).toBe(Math.round(11_206 / ((NOW - 1792030668 * 1000) / DAY)));
    expect(Math.max(...s.map((p) => p.score))).toBeLessThanOrEqual(100);
  });
  it('TikTok scores on plays against followers, velocity and engagement', () => {
    const items = normalise('tiktok', TT_SEARCH_RUN.output, NOW);
    const s = items.map((i) => scoreItem(i, { now: NOW }));
    for (const p of s) expect(p.ratio_basis).toBe('followers');
    expect(s[0].engagement).toBe(Math.round(((4663 + 51 + 601) / 59_481) * 1000) / 1000);
    expect(s[0].ratio).toBe(Math.round((59_481 / 191_598) * 1000) / 1000);
    for (const p of s) expect(p.score).toBeGreaterThan(0);
  });
});
