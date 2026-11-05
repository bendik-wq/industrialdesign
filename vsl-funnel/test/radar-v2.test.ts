import { beforeEach, describe, expect, it } from 'vitest';
import type { Runtime } from '../src/app';
import { auditCopy } from '../src/content/copy-rules';
import { RADAR_COPY, ensureSeeded, listItems, listWatchlists, queueWatchlist, radarConfig, radarStep, relevantText, upsertItem } from '../src/radar/engine';
import type { MonidClient, MonidRun } from '../src/radar/monid';
import { interactions, nextCursorOf, normalise, normaliseReddit, normaliseX, scoreItem, transcriptSegments } from '../src/radar/normalise';
import { DEFAULT_TOOLS, X_LIMIT, builtinFor, linkedinDate, mapInput, publicationUrl, redditPhrase, redditTimeframe, subredditName, xQueries } from '../src/radar/sources';
import { RADAR_DATA_COPY } from '../src/radar/data-routes';
import { SWEEP_COPY, advanceSweeps, estimateSweep, selectForTranscription, startSweep, sweepStatus } from '../src/radar/sweep';
import { KEYWORD_UNIVERSE, PUBLICATIONS, SUBREDDITS, THEMES, addKeywords, platformsOff, setPlatform, updateKeyword } from '../src/radar/universe';
import { SETTINGS, type Settings } from '../src/settings';
import { LINKEDIN_SEARCH_RUN, REDDIT_SEARCH_RUN, SUBSTACK_POSTS_RUN, X_SEARCH_RUN, YT_SEARCH_RUN, YT_TRANSCRIPT_RUN, IG_TRANSCRIPT_RUN } from './monid-live';
import { type SqlDb, d1, freshDb } from './studio-fakes';

// Radar v2: X, LinkedIn, Reddit and Substack on real Monid output (test/fixtures/monid, 2026-11-05), their query
// builders and prices, the one outlier score across platforms, the keyword universe and its seed, paging by
// nextCursor, the sweep estimate, sweeps end to end and the automatic transcripts within budget.

const NOW = Date.parse('2026-11-05T15:00:00Z');
const blank = () => Object.fromEntries(SETTINGS.map((s) => [s.key, ''])) as Settings;
const rtFor = (db: SqlDb, over: Partial<Settings> = {}): Runtime => ({ env: { DB: d1(db) } as never, settings: { ...blank(), MONID_API_KEY: 'mk_test', ...over }, reps: [], origin: 'https://apply.test', waitUntil: () => {} });
function fakeClient(reply: (provider: string, endpoint: string, input: Record<string, unknown>) => Partial<MonidRun>) {
  const calls: { endpoint: string; input: Record<string, unknown> }[] = [];
  const client: MonidClient = {
    discover: async () => [], inspect: async (provider, endpoint) => ({ provider, endpoint }),
    run: async (p, e, i) => { calls.push({ endpoint: e, input: i as Record<string, unknown> }); return { runId: `r${calls.length}`, status: 'COMPLETED', output: null, resultCount: null, costMicros: null, ...reply(p, e, i as Record<string, unknown>) }; },
    getRun: async (id) => ({ runId: id, status: 'COMPLETED', output: null, resultCount: null, costMicros: null }),
  };
  return { client, calls };
}

describe('normalisers on real output', () => {
  it('X: text, likes, replies, reposts (retweets + quotes), bookmarks, views, followers; the image or video preview, never the video', () => {
    const items = normalise('x', X_SEARCH_RUN.output, NOW);
    expect(items).toHaveLength(5);
    const a = items.find((i) => i.external_id === '2115071995368906798')!;
    expect(a).toMatchObject({
      id: 'x:2115071995368906798', platform: 'x', author: 'defidave', author_id: '243415763', likes: 1352, comments: 74, reposts: 221 + 35, bookmarks: 1020,
      views: 199_062, followers: 18_525, url: 'https://x.com/i/web/status/2115071995368906798', media_kind: 'image', thumbnail_url: 'https://pbs.twimg.com/media/HVo9qmqXoAAwDO6.jpg',
      published_at: new Date(1793107434 * 1000).toISOString(),
    });
    expect(a.body_text).toMatch(/^Want to know if a spot is owned by private equity\?/);
    expect(a.title).toBe('Want to know if a spot is owned by private equity?');
    const v = items.find((i) => i.external_id === '1899977043774763411')!;
    expect(v).toMatchObject({ media_kind: 'video', media_url: null, thumbnail_url: expect.stringMatching(/amplify_video_thumb.*\.jpg$/) });
    expect(nextCursorOf(X_SEARCH_RUN.output)).toBe('cur_7zQWTdBUL5plu9G8r56GDg');
    // Replies are no format: left out.
    expect(normaliseX({ ...X_SEARCH_RUN.output.data.items[0], isReply: true })).toBeNull();
  });

  it('LinkedIn: the post text, reactions as likes, comments, the author and the post link', () => {
    const items = normalise('linkedin', LINKEDIN_SEARCH_RUN.output, NOW);
    expect(items).toHaveLength(5);
    expect(items[0]).toMatchObject({ platform: 'linkedin', external_id: '7523769603370700800', author: 'Yousuf Imran', likes: 142, comments: 91, views: null, followers: null, url: expect.stringMatching(/^https:\/\/www\.linkedin\.com\/posts\//) });
    expect(items[0].body_text!.length).toBeGreaterThan(100);
    expect(items[0].author_id).toMatch(/^https:\/\/www\.linkedin\.com\/in\//);
    expect(nextCursorOf(LINKEDIN_SEARCH_RUN.output)).toBe('cur_X8defws5fFVoB-WgqHOKHg');
  });

  it('Reddit: title and self text as the body, score as likes, the subreddit as the source, the reddit link; NSFW left out', () => {
    const items = normalise('reddit', REDDIT_SEARCH_RUN.output, NOW);
    expect(items).toHaveLength(5);
    expect(items[0]).toMatchObject({ platform: 'reddit', external_id: '1pnds4s', likes: 86_851, comments: 4623, source_ref: 'mildlyinfuriating', author: 'Wander_tea', url: 'https://www.reddit.com/r/mildlyinfuriating/comments/1pnds4s/manager_took_us_out_for_treat_and_just_bought/' });
    expect(items[0].body_text).toMatch(/^Manager took us out for treat and just bought this\. We were 5 people\n\n/);
    expect(normaliseReddit({ ...REDDIT_SEARCH_RUN.output.data.posts[0], nsfw: true })).toBeNull();
  });

  it('Substack: title, subtitle, the full free text, reactions, comments, restacks, the publication as author and source', () => {
    const [s] = normalise('substack', SUBSTACK_POSTS_RUN.output, NOW);
    expect(s).toMatchObject({
      id: 'substack:218935182', platform: 'substack', title: 'Weekly Dose of Optimism #214', author: 'Not Boring by Packy McCormick', source_ref: 'www.notboring.co', author_id: 'www.notboring.co',
      likes: 90, comments: 1, reposts: 1, url: 'https://www.notboring.co/p/weekly-dose-of-optimism-214', caption: expect.stringMatching(/^Nobel, Matter Compiler/),
    });
    expect(s.body_text).toMatch(/^Cover image generated by Runway\./);
    expect(nextCursorOf(SUBSTACK_POSTS_RUN.output)).toBeNull();
  });

  it('transcript segments keep their timings (start, end) when the tool gives them', () => {
    const yt = transcriptSegments(YT_TRANSCRIPT_RUN.output);
    expect(yt).toHaveLength(8);
    expect(yt[0]).toEqual({ start: 0.04, end: 2.36, text: 'have you ever wanted to buy a small' });
    const ig = transcriptSegments(IG_TRANSCRIPT_RUN.output);
    expect(ig[0]).toMatchObject({ start: 0.08, end: 4.48, text: expect.stringMatching(/^I found a small HVAC company/) });
  });
});

describe('one outlier score across platforms', () => {
  it('weighted interactions: likes + 2 comments + 3 shares or reposts + 3 bookmarks + 2 saves', () => {
    expect(interactions({ likes: 10, comments: 2, shares: 1, reposts: 1, bookmarks: 1, saves: 1 })).toBe(10 + 4 + 6 + 3 + 2);
    expect(interactions({ likes: null, comments: null })).toBeNull();
  });

  it('X: interactions against 1% of followers, velocity on interactions, engagement on views', () => {
    const items = normalise('x', X_SEARCH_RUN.output, NOW);
    const s = items.map((i) => ({ i, p: scoreItem(i, { now: NOW }) }));
    for (const { p } of s) { expect(p).toMatchObject({ ratio_basis: 'followers', metric: 'interactions' }); expect(p.score).toBeGreaterThan(0); expect(p.score).toBeLessThanOrEqual(100); }
    const a = s.find((x) => x.i.external_id === '2115071995368906798')!.p;
    const I = 1352 + 2 * 74 + 3 * 256 + 3 * 1020;
    expect(a.interactions).toBe(I);
    expect(a.ratio).toBe(Math.round((I / (18_525 * 0.01)) * 1000) / 1000);
    expect(a.engagement).toBe(Math.round((I / 199_062) * 1000) / 1000);
    // A small account far above its usual reach outranks a huge account doing what it always does.
    const big = s.find((x) => x.i.author === 'ChrisMurphyCT')!.p;
    expect(a.score).toBeGreaterThan(big.score);
  });

  it('Substack ranks against its own publication; LinkedIn against the platform; no views means the reach parts scale to 100', () => {
    const [s] = normalise('substack', SUBSTACK_POSTS_RUN.output, NOW);
    const p = scoreItem(s, { sourceValues: [20, 30, 40], now: NOW });
    expect(p).toMatchObject({ ratio_basis: 'source', ratio: Math.round((((90 + 2 + 3) / 30)) * 1000) / 1000, engagement: null });
    const li = normalise('linkedin', LINKEDIN_SEARCH_RUN.output, NOW);
    const vals = li.map((i) => interactions(i)!);
    const ps = li.map((i) => scoreItem(i, { platformViews: vals, now: NOW }));
    expect(ps[0].ratio_basis).toBe('platform');
    expect(ps[0].score).toBeGreaterThan(ps[4].score);
    for (const x of ps) expect(x.score).toBeLessThanOrEqual(100);
  });
});

describe('query builders', () => {
  it('X: (kw OR "phrase") min_faves lang:en -is:retweet, five keywords a query, since the radar window', () => {
    const q = xQueries(['buy a business', 'LBO', 'seller "note"', 'earnout', 'search fund', 'roll up'], { minFaves: 200, sinceDays: 30, now: NOW });
    expect(q).toEqual([
      '("buy a business" OR LBO OR "seller note" OR earnout OR "search fund") min_faves:200 lang:en -is:retweet since:2026-10-06',
      '("roll up") min_faves:200 lang:en -is:retweet since:2026-10-06',
    ]);
    expect(xQueries(['a', 'a'], { minFaves: 1000 })).toEqual(['(a) min_faves:1000 lang:en -is:retweet']);
    // Long phrases split before X's 512-character limit.
    const long = Array.from({ length: 5 }, (_, i) => `${'very long keyword phrase '.repeat(4)}${i}`);
    for (const x of xQueries(long, { minFaves: 200 })) expect(x.length).toBeLessThanOrEqual(480);
  });

  it('the built-in inputs match the real runs: X, LinkedIn, Reddit search, subreddits, Substack', () => {
    const tool = (slot: string) => DEFAULT_TOOLS.find((t) => t.slot === slot)!;
    const q = { keywords: ['buy a business', 'seller financing'], max: 15, sinceDays: 180, maxKeywords: 60, minFaves: 200 };
    const x = mapInput('x:search', null, q, null, tool('x:search')).inputs;
    expect(x).toHaveLength(1);
    expect(x[0]).toMatchObject({ queryType: 'Top', limit: X_LIMIT, query: expect.stringMatching(/^\("buy a business" OR "seller financing"\) min_faves:200 lang:en -is:retweet since:\d{4}-\d\d-\d\d$/) });
    expect(Object.keys(x[0]).sort()).toEqual(Object.keys({ ...X_SEARCH_RUN.input.body }).sort());
    expect(mapInput('linkedin:search', null, { ...q, sinceDays: 30 }, null, tool('linkedin:search')).inputs).toEqual([{ query: 'buy a business', datePosted: 'last-month' }, { query: 'seller financing', datePosted: 'last-month' }]);
    expect(mapInput('reddit:search', null, q, null, tool('reddit:search')).inputs[0]).toEqual({ query: '"buy a business"', sort: 'top', timeframe: 'year' });
    expect(mapInput('reddit:subreddit', null, { keywords: [], max: 15, subreddit: 'smallbusiness', sinceDays: 31 }, null, tool('reddit:subreddit')).inputs).toEqual([{ query: 'subreddit:smallbusiness', sort: 'top', timeframe: 'month' }]);
    expect(mapInput('substack:posts', null, { keywords: [], max: 15, publication: 'https://www.notboring.co' }, null, tool('substack:posts')).inputs).toEqual([{ url: 'https://www.notboring.co', limit: 15, includeContent: true, onlyFree: true }]);
    // The subreddit_posts tool is offered with an input marked unverified; a template can change it.
    const sp = mapInput('reddit:subreddit', null, { keywords: [], max: 15, subreddit: 'SearchFunds' }, { name: '{{subreddit}}' }, { provider: 'anyapi', endpoint: '/reddit.subreddit_posts' });
    expect(sp.inputs[0]).toMatchObject({ subreddit: 'SearchFunds', name: 'SearchFunds', sort: 'top' });
    expect(sp.notes.join(' ')).toMatch(/not yet confirmed/);
    expect(builtinFor('anyapi', '/reddit.search', 'reddit:subreddit')?.slot).toBe('reddit:subreddit');
    expect(builtinFor('anyapi', '/reddit.search', 'reddit:search')?.slot).toBe('reddit:search');
  });

  it('windows, names and addresses', () => {
    expect([1, 7, 30, 90, null].map(linkedinDate)).toEqual(['past-24h', 'past-week', 'last-month', 'last-year', 'last-month']);
    expect([1, 7, 30, 90, null].map(redditTimeframe)).toEqual(['day', 'week', 'month', 'year', 'year']);
    expect(redditPhrase('seller "note"')).toBe('"seller note"');
    expect(['r/smallbusiness', '/r/SearchFunds/', 'https://www.reddit.com/r/fatFIRE/', 'privateequity', 'no spaces allowed'].map(subredditName)).toEqual(['smallbusiness', 'SearchFunds', 'fatFIRE', 'privateequity', null]);
    expect(publicationUrl('notboring')).toEqual({ url: 'https://notboring.substack.com', host: 'notboring.substack.com' });
    expect(publicationUrl('https://www.NotBoring.co/p/x')).toEqual({ url: 'https://www.notboring.co', host: 'www.notboring.co' });
    expect(publicationUrl('not a url at all')).toBeNull();
  });
});

describe('relevance for text posts', () => {
  const kws = ['buy a business', 'seller financing', 'private equity small business'];
  it('drops global Reddit noise that only mentions buying something', () => {
    for (const it of normalise('reddit', REDDIT_SEARCH_RUN.output, NOW).slice(0, 4)) expect(relevantText(it.title ?? '', it.body_text ?? '', kws), it.title!).toBe(false);
  });
  it('keeps posts on topic: a keyword phrase anywhere, a keyword word up front, or two business words', () => {
    const [x] = normalise('x', X_SEARCH_RUN.output, NOW);
    expect(relevantText(x.title!, x.body_text!, kws)).toBe(true);
    expect(relevantText('Story time', `A long intro. ${'filler '.repeat(100)} Then we used seller financing to close.`, kws)).toBe(true);
    expect(relevantText('Our revenue doubled', 'The owners kept the company.', [])).toBe(true);
    expect(relevantText('My cat', 'The business of being a cat.', [])).toBe(false);
    expect(relevantText('Anything', '', [], { listed: true })).toBe(true);
  });
});

describe('the keyword universe, seed and switches', () => {
  let db: SqlDb;
  beforeEach(() => { db = freshDb(); });

  it('about 40 keywords in the niche and 40 adjacent, grouped into themed radars; 11 subreddits; 30 publications', async () => {
    expect(KEYWORD_UNIVERSE.filter((k) => k.tier === 'in').length).toBeGreaterThanOrEqual(40);
    expect(KEYWORD_UNIVERSE.filter((k) => k.tier === 'adjacent').length).toBeGreaterThanOrEqual(36);
    expect(new Set(KEYWORD_UNIVERSE.map((k) => k.keyword.toLowerCase())).size).toBe(KEYWORD_UNIVERSE.length);
    expect(SUBREDDITS.map((s) => s.name)).toEqual(expect.arrayContaining(['smallbusiness', 'Entrepreneur', 'privateequity', 'fatFIRE', 'sweatystartup', 'business', 'investing', 'financialindependence', 'startups', 'SearchFunds', 'acquisitions']));
    expect(PUBLICATIONS).toHaveLength(30);
    for (const p of PUBLICATIONS) expect(publicationUrl(p.url)?.url, p.url).toBe(p.url);
    const rt = rtFor(db);
    // A v1 install: its four seeded radars retire, an owner-made one stays.
    for (const [id, name] of [['wl-1-a', 'Acquisitions (our niche)'], ['wl-2-b', 'Meta ads: high-ticket education'], ['mine', 'Acquisitions (our niche)']]) {
      db.prepare("INSERT INTO radar_watchlists (id, name, keywords_json, platforms_json, niche, created_at, updated_at) VALUES (?, ?, '[\"x\"]', '[\"youtube\"]', 'in', '2026-01-01', '2026-01-01')").run(id, name);
    }
    await ensureSeeded(rt);
    await ensureSeeded(rt);
    const wls = await listWatchlists(rt);
    expect(wls.map((w) => w.id)).toEqual(['mine', ...THEMES.map((t) => `theme-${t.id}`), 'meta-ads-owners']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM radar_keywords').get()).toMatchObject({ n: KEYWORD_UNIVERSE.length });
    expect(db.prepare('SELECT COUNT(*) AS n FROM radar_subreddits').get()).toMatchObject({ n: 11 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM radar_publications WHERE verified = 0').get()).toMatchObject({ n: PUBLICATIONS.filter((p) => !p.verified).length });
    // Deleted seeds stay deleted.
    db.prepare("UPDATE radar_watchlists SET deleted_at = 'x' WHERE id = 'theme-wealth'").run();
    await ensureSeeded(rt);
    expect((await listWatchlists(rt)).some((w) => w.id === 'theme-wealth')).toBe(false);
  });

  it('editing the universe updates the themed radars; a new theme gets a radar', async () => {
    const rt = rtFor(db);
    await ensureSeeded(rt);
    expect(await addKeywords(rt, 'smb_acquisition', 'in', 'buy a laundromat\nbuy a business')).toEqual({ added: 1 });
    let smb = (await listWatchlists(rt)).find((w) => w.theme === 'smb_acquisition')!;
    expect(smb.keywords).toContain('buy a laundromat');
    const kid = (db.prepare("SELECT id FROM radar_keywords WHERE keyword = 'buy a laundromat'").get() as { id: string }).id;
    expect(await updateKeyword(rt, kid, { enabled: false })).toBe(true);
    smb = (await listWatchlists(rt)).find((w) => w.theme === 'smb_acquisition')!;
    expect(smb.keywords).not.toContain('buy a laundromat');
    expect(await addKeywords(rt, 'Home Services!', 'adjacent', [''])).toBe('Add at least one keyword.');
    await setPlatform(rt, 'linkedin', false);
    expect([...(await platformsOff(rt))]).toEqual(['linkedin']);
    await setPlatform(rt, 'linkedin', true);
    expect((await platformsOff(rt)).size).toBe(0);
  });
});

describe('sweeps: estimate, paging, progress, automatic transcripts', () => {
  let db: SqlDb;
  beforeEach(() => { db = freshDb(); });

  it('the estimate is the listed price of each call × pages, per radar and platform, plus subreddits, publications and transcripts', async () => {
    const rt = rtFor(db);
    const est = await estimateSweep(rt, { now: NOW });
    const line = (name: string, platform: string) => est.lines.find((l) => l.name === name && l.platform === platform)!;
    const pe = KEYWORD_UNIVERSE.filter((k) => k.theme === 'pe_ma').length;
    expect(line('PE and M&A', 'youtube')).toMatchObject({ calls: pe, pages: 2, est_micros: pe * 1200 * 2 });
    expect(line('PE and M&A', 'linkedin')).toMatchObject({ calls: pe, pages: 2, est_micros: pe * 2420 * 2 });
    expect(line('PE and M&A', 'reddit')).toMatchObject({ calls: pe, pages: 2, est_micros: pe * 350 * 2 });
    // X groups five keywords a query; 50 results on the badger route: $0.0001 each plus $0.0001.
    expect(line('PE and M&A', 'x')).toMatchObject({ calls: Math.ceil(pe / 5), pages: 2, est_micros: Math.ceil(pe / 5) * 5100 * 2 });
    expect(est.lines.find((l) => l.kind === 'subreddits')).toMatchObject({ calls: 11, pages: 2, est_micros: 11 * 350 * 2 });
    expect(est.lines.find((l) => l.kind === 'publications')).toMatchObject({ calls: 30, pages: 1, est_micros: 30 * (15 * 440 + 390) });
    expect(est.lines.find((l) => l.kind === 'transcripts')).toMatchObject({ calls: 30 });
    expect(est.total_micros).toBe(est.lines.reduce((a, l) => a + l.est_micros, 0));
    // A full sweep at the default settings: between $1 and $2.5, well inside the $60 budget (the Integrations help says so).
    expect(est.total_micros).toBeGreaterThan(1_000_000);
    expect(est.total_micros).toBeLessThan(2_500_000);
    expect(est).toMatchObject({ budget_micros: 60_000_000, fits: true });
    // Switching a platform off takes it out of the estimate, with the reason.
    await setPlatform(rt, 'x', false);
    const est2 = await estimateSweep(rt, { now: NOW });
    expect(est2.lines.some((l) => l.platform === 'x')).toBe(false);
    expect(est2.notes).toContain(RADAR_COPY.platformOff('X search'));
    // RADAR_PAGES=1 halves the paged lines.
    const est3 = await estimateSweep(rtFor(db, { RADAR_PAGES: '1', RADAR_AUTO_TRANSCRIBE: '0' }), { now: NOW });
    expect(est3.lines.find((l) => l.name === 'PE and M&A' && l.platform === 'youtube')).toMatchObject({ pages: 1, est_micros: pe * 1200 });
    expect(est3.lines.some((l) => l.kind === 'transcripts')).toBe(false);
  });

  it('a search with a next page queues it with the cursor, up to RADAR_PAGES, and not when a page found nothing', async () => {
    const rt = rtFor(db, { RADAR_PAGES: '2' });
    await ensureSeeded(rt);
    db.prepare("UPDATE radar_watchlists SET enabled = 0").run();
    db.prepare("INSERT INTO radar_watchlists (id, name, keywords_json, platforms_json, niche, created_at, updated_at, min_faves) VALUES ('t', 'T', '[\"private equity\",\"buy a business\"]', '[\"x\"]', 'in', 'x', 'x', 500)").run();
    const wl = (await listWatchlists(rt)).find((w) => w.id === 't')!;
    const q = await queueWatchlist(rt, wl, NOW);
    expect(q).toMatchObject({ queued: 1, est_micros: 5100 });
    const { client, calls } = fakeClient(() => ({ output: X_SEARCH_RUN.output, costMicros: 2100 }));
    await radarStep(rt, { client, now: NOW });
    expect(calls[0].input).toMatchObject({ query: '("private equity" OR "buy a business") min_faves:500 lang:en -is:retweet', queryType: 'Top', limit: 50 });
    const page2 = db.prepare('SELECT page, input_json, query, status FROM radar_runs WHERE page = 2').get() as { input_json: string; status: string };
    expect(page2).toMatchObject({ status: 'pending', query: expect.stringContaining('min_faves:500') });
    expect(JSON.parse(page2.input_json)).toMatchObject({ cursor: 'cur_7zQWTdBUL5plu9G8r56GDg', limit: 50 });
    await radarStep(rt, { client, now: NOW });
    expect(calls[1].input.cursor).toBe('cur_7zQWTdBUL5plu9G8r56GDg');
    expect(db.prepare('SELECT COUNT(*) AS n FROM radar_runs').get()).toMatchObject({ n: 2 }); // page 2 of 2: no third page
    const x = db.prepare("SELECT body_text, bookmarks, reposts, query, transcript_source, score_json FROM radar_items WHERE id = 'x:2115071995368906798'").get() as { score_json: string };
    expect(x).toMatchObject({ bookmarks: 1020, reposts: 256, transcript_source: 'text', query: expect.stringContaining('private equity'), body_text: expect.stringMatching(/^Want to know/) });
    expect(JSON.parse(x.score_json)).toMatchObject({ metric: 'interactions', ratio_basis: 'followers' });
    // A page that found nothing ends the search.
    db.prepare('DELETE FROM radar_runs').run();
    await queueWatchlist(rt, wl, NOW);
    const empty = fakeClient(() => ({ output: { data: { items: [], nextCursor: 'cur_more' } } }));
    await radarStep(rt, { client: empty.client, now: NOW });
    expect(db.prepare('SELECT COUNT(*) AS n FROM radar_runs').get()).toMatchObject({ n: 1 });
  });

  it('round-robin selection across platforms by score, within what the budget has left', () => {
    const c = (id: string, platform: string, score: number, est = 5000) => ({ id, platform, score, est });
    const items = [c('y1', 'youtube', 90), c('y2', 'youtube', 80), c('y3', 'youtube', 70), c('t1', 'tiktok', 60), c('t2', 'tiktok', 50), c('i1', 'instagram', 85, 8000)];
    expect(selectForTranscription(items, 4, 1e9).map((x) => x.id)).toEqual(['y1', 'i1', 't1', 'y2']);
    expect(selectForTranscription(items, 0, 1e9)).toEqual([]);
    // 12,000 left: y1 (5000) fits, i1 (8000) no longer does, t1 (5000) does, then nothing.
    expect(selectForTranscription(items, 10, 12_000).map((x) => x.id)).toEqual(['y1', 't1']);
  });

  it('a full sweep runs every radar, subreddit and publication, then transcribes the best new videos and finishes', async () => {
    const rt = rtFor(db, { RADAR_PAGES: '1', RADAR_AUTO_TRANSCRIBE: '2' });
    await ensureSeeded(rt);
    // Keep it small: one radar (two keywords, YouTube and X), two subreddits, one publication.
    db.prepare("UPDATE radar_watchlists SET enabled = 0 WHERE id != 'theme-smb_acquisition'").run();
    db.prepare("UPDATE radar_keywords SET enabled = 0 WHERE theme = 'smb_acquisition' AND keyword NOT IN ('buy a business', 'seller financing')").run();
    db.prepare(`UPDATE radar_watchlists SET platforms_json = '["youtube","x"]' WHERE id = 'theme-smb_acquisition'`).run();
    db.prepare("UPDATE radar_subreddits SET enabled = 0 WHERE name NOT IN ('smallbusiness', 'SearchFunds')").run();
    db.prepare("UPDATE radar_publications SET enabled = 0 WHERE id NOT IN ('www.notboring.co', 'girdley.substack.com')").run();
    const est = await estimateSweep(rt, { now: Date.now() });
    const s = await startSweep(rt, 'full');
    expect(s).toMatchObject({ ok: true, queued: 2 + 1 + 2 + 2 });
    expect(s.est_micros).toBe(est.total_micros - est.lines.find((l) => l.kind === 'transcripts')!.est_micros);
    const { client, calls } = fakeClient((_p, e, input) => {
      if (e === '/youtube.search') return { output: YT_SEARCH_RUN.output, costMicros: 1200 };
      if (e === '/twitter.search') return { output: X_SEARCH_RUN.output, costMicros: 2100 };
      if (e === '/reddit.search') return { output: REDDIT_SEARCH_RUN.output, costMicros: 350 };
      if (e === '/substack.posts') return input.url === 'https://www.notboring.co' ? { output: SUBSTACK_POSTS_RUN.output, costMicros: 830 } : { status: 'FAILED', error: 'publication not found', costMicros: 0 };
      if (e === '/starvibe/youtube-video-transcript') return { output: YT_TRANSCRIPT_RUN.output, costMicros: 5000 };
      return { status: 'FAILED', error: 'unexpected' };
    });
    await radarStep(rt, { client, maxStart: 50 });
    await advanceSweeps(rt);
    let [st] = await sweepStatus(rt, 1);
    expect(st).toMatchObject({ status: 'transcribing', runs: 7 + 2, completed: 6, failed: 1, transcripts_queued: 2 });
    // The failed guess at an address is switched off with the provider's message; the real one is marked verified.
    expect(db.prepare("SELECT enabled, disabled_reason FROM radar_publications WHERE id = 'girdley.substack.com'").get()).toMatchObject({ enabled: 0, disabled_reason: 'publication not found' });
    expect(db.prepare("SELECT verified FROM radar_publications WHERE id = 'www.notboring.co'").get()).toMatchObject({ verified: 1 });
    // Items from the lists carry their source and its niche; subreddit queries are scoped.
    expect(calls.filter((c) => c.endpoint === '/reddit.search').map((c) => c.input.query).sort()).toEqual(['subreddit:SearchFunds', 'subreddit:smallbusiness']);
    expect(db.prepare("SELECT niche, source_ref, transcript_source FROM radar_items WHERE id = 'substack:218935182'").get()).toMatchObject({ niche: 'out', source_ref: 'www.notboring.co', transcript_source: 'text' });
    // The two transcripts went to YouTube videos (the only video platform searched), best score first.
    const tr = calls.filter((c) => c.endpoint === '/starvibe/youtube-video-transcript');
    expect(tr).toHaveLength(0); // queued, not yet started
    await radarStep(rt, { client, maxStart: 50 });
    await advanceSweeps(rt);
    [st] = await sweepStatus(rt, 1);
    expect(st).toMatchObject({ status: 'done', transcripts: 2, transcribed: 2 });
    expect(st.cost_micros).toBe(1200 * 2 + 2100 + 350 * 2 + 830 + 5000 * 2);
    expect(st.new_items).toBeGreaterThan(0);
    const seg = db.prepare("SELECT transcript_segments, transcribed_at FROM radar_items WHERE transcript_source = 'monid' AND id = 'youtube:_qrVANZNXNg'").get() as { transcript_segments: string } | undefined;
    if (seg) expect(JSON.parse(seg.transcript_segments)[0]).toEqual({ start: 0.04, end: 2.36, text: 'have you ever wanted to buy a small' });
    // Text posts ranked on the list (relevance applied).
    const text = await listItems(rt, { platform: 'text' });
    expect(text.every((i) => ['x', 'linkedin', 'reddit', 'substack'].includes(i.platform))).toBe(true);
    expect(text.some((i) => i.platform === 'reddit' && i.source_ref === 'smallbusiness')).toBe(false); // the noise fixture is off topic
  });

  it('automatic transcripts stop at the budget and are off at 0', async () => {
    const rt = rtFor(db, { RADAR_AUTO_TRANSCRIBE: '0' });
    await ensureSeeded(rt);
    const s = await startSweep(rt, 'radar', { radarIds: ['nope'] });
    expect(s).toMatchObject({ ok: false, queued: 0 });
    expect(radarConfig(rt).autoTranscribe).toBe(0);
    expect(radarConfig(rtFor(db)).autoTranscribe).toBe(30);
    // An item already transcribed or a text post is never picked.
    const [x] = normalise('x', X_SEARCH_RUN.output, NOW);
    await upsertItem(rt, x, null, NOW);
    expect(db.prepare("SELECT transcript_source FROM radar_items WHERE id = ?").get(x.id)).toMatchObject({ transcript_source: 'text' });
  });
});

describe('copy shown in Sources and sweeps', () => {
  it('passes auditCopy, with no em dashes or exclamation marks', () => {
    const all = [...Object.values(SWEEP_COPY), ...Object.values(RADAR_DATA_COPY), RADAR_COPY.textPost, RADAR_COPY.platformOff('X search'), RADAR_COPY.noKeywords('PE and M&A')];
    for (const k of ['RADAR_PAGES', 'RADAR_AUTO_TRANSCRIBE', 'RADAR_BUDGET_USD_MONTH', 'MONID_API_KEY', 'RADAR_SCHEDULE_HOURS']) {
      const def = SETTINGS.find((s) => s.key === k) as { group: string; help: string };
      expect(def.group).toBe('Radar');
      all.push(def.help);
    }
    for (const s of all) {
      expect(auditCopy(s), s).toEqual([]);
      expect(s).not.toMatch(/[—–!]/);
    }
  });
});
