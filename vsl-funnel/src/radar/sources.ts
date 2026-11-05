/**
 * Radar: the source map. Each slot (a platform and what we need from it) gets one Monid tool, picked by the owner
 * from what Monid's discover offers, with the known actors pre-selected when they appear. The input mapper turns
 * our query fields (keywords, max items, date range, country, video URLs) into that tool's own input schema, and
 * the owner sees the exact input before the first paid run.
 */

export const PLATFORMS = ['youtube', 'tiktok', 'instagram', 'meta_ads', 'x', 'linkedin', 'reddit', 'substack'] as const;
export type Platform = (typeof PLATFORMS)[number];
/** Platforms whose items are videos (transcribed through Monid) and text platforms (body_text is the transcript). */
export const VIDEO_PLATFORMS = ['youtube', 'tiktok', 'instagram'] as const satisfies readonly Platform[];
export const TEXT_PLATFORMS = ['x', 'linkedin', 'reddit', 'substack'] as const satisfies readonly Platform[];
export const isTextPlatform = (p: string): boolean => (TEXT_PLATFORMS as readonly string[]).includes(p);
export const isVideoPlatform = (p: string): boolean => (VIDEO_PLATFORMS as readonly string[]).includes(p);
/** Platforms a radar searches by keyword (Substack has no search: it reads the publication list instead). */
export const KEYWORD_PLATFORMS = ['youtube', 'tiktok', 'instagram', 'meta_ads', 'x', 'linkedin', 'reddit'] as const satisfies readonly Platform[];
export type Kind = 'search' | 'transcript' | 'ads' | 'source';
export type Slot = 'youtube:search' | 'youtube:transcript' | 'tiktok:search' | 'tiktok:transcript' | 'instagram:search' | 'instagram:transcript' | 'meta_ads:ads'
  | 'x:search' | 'linkedin:search' | 'reddit:search' | 'reddit:subreddit' | 'substack:posts';

export interface SlotDef { slot: Slot; platform: Platform; kind: Kind; label: string; query: string; known: string[]; match: (endpoint: string) => boolean }

const has = (...words: string[]) => (e: string) => words.every((w) => e.toLowerCase().includes(w));
/** `known` entries are endpoints ("/a/b", any provider) or "provider /endpoint"; the first one is the default pick. */
export const SLOTS: SlotDef[] = [
  { slot: 'youtube:search', platform: 'youtube', kind: 'search', label: 'YouTube search', query: 'youtube search videos by keyword with views', known: ['anyapi /youtube.search', '/streamers/youtube-scraper'], match: has('youtube') },
  { slot: 'youtube:transcript', platform: 'youtube', kind: 'transcript', label: 'YouTube transcripts', query: 'youtube video transcript', known: ['apify /starvibe/youtube-video-transcript'], match: has('youtube', 'transcript') },
  { slot: 'tiktok:search', platform: 'tiktok', kind: 'search', label: 'TikTok search', query: 'tiktok search videos by keyword', known: ['anyapi /tiktok.search_keyword', '/clockworks/tiktok-scraper', '/clockworks/free-tiktok-scraper'], match: has('tiktok') },
  { slot: 'tiktok:transcript', platform: 'tiktok', kind: 'transcript', label: 'TikTok transcripts', query: 'tiktok video transcript', known: ['anyapi /tiktok.video_transcript_full'], match: has('tiktok', 'transcript') },
  { slot: 'instagram:search', platform: 'instagram', kind: 'search', label: 'Instagram reels', query: 'instagram reels scraper', known: ['anyapi /instagram.reels_search', '/apify/instagram-reel-scraper'], match: has('instagram') },
  { slot: 'instagram:transcript', platform: 'instagram', kind: 'transcript', label: 'Instagram transcripts', query: 'instagram reel transcript', known: ['anyapi /instagram.reel_transcript'], match: has('instagram', 'transcript') },
  { slot: 'meta_ads:ads', platform: 'meta_ads', kind: 'ads', label: 'Meta Ad Library', query: 'facebook meta ad library ads search', known: ['/curious_coder/facebook-ads-library-scraper', '/apify/facebook-ads-scraper'], match: (e) => /facebook|meta/i.test(e) && /ad/i.test(e) },
  { slot: 'x:search', platform: 'x', kind: 'search', label: 'X search', query: 'twitter x search tweets advanced query', known: ['anyapi /twitter.search'], match: (e) => /twitter|tweet/i.test(e) },
  { slot: 'linkedin:search', platform: 'linkedin', kind: 'search', label: 'LinkedIn posts', query: 'linkedin search posts by keyword', known: ['anyapi /linkedin.search_posts'], match: has('linkedin') },
  { slot: 'reddit:search', platform: 'reddit', kind: 'search', label: 'Reddit search', query: 'reddit search posts', known: ['anyapi /reddit.search'], match: has('reddit') },
  // The subreddit list. Default: Reddit search with the subreddit: operator (its input is verified); anyapi
  // /reddit.subreddit_posts is offered with a guessed input the owner can edit as a template once Monid inspects it.
  { slot: 'reddit:subreddit', platform: 'reddit', kind: 'source', label: 'Reddit subreddits', query: 'reddit subreddit top posts', known: ['anyapi /reddit.search', 'anyapi /reddit.subreddit_posts'], match: has('reddit') },
  { slot: 'substack:posts', platform: 'substack', kind: 'source', label: 'Substack publications', query: 'substack publication posts', known: ['anyapi /substack.posts'], match: has('substack') },
];
export const slotDef = (slot: string) => SLOTS.find((s) => s.slot === slot);
export const isSlot = (s: unknown): s is Slot => typeof s === 'string' && SLOTS.some((d) => d.slot === s);
export const searchSlot = (p: Platform): Slot => (p === 'meta_ads' ? 'meta_ads:ads' : p === 'substack' ? 'substack:posts' : `${p}:search` as Slot);
/** Only video platforms have a transcript slot: a text post's body_text is its transcript. */
export const transcriptSlot = (p: Platform): Slot | null => (isVideoPlatform(p) ? `${p}:transcript` as Slot : null);

/** A known actor for this slot (pre-selected when discover offers it). */
export function isRecommended(slot: Slot, provider: string, endpoint: string): boolean {
  const d = slotDef(slot);
  if (!d) return false;
  if (knownRank(slot, provider, endpoint) >= 0) return true;
  // Transcript slots: any transcript tool for the right platform counts.
  return d.kind === 'transcript' && provider.length > 0 && d.match(endpoint.toLowerCase());
}

/** Where a tool sits in its slot's known list (0 = the default pick), or -1. */
export function knownRank(slot: Slot, provider: string, endpoint: string): number {
  const d = slotDef(slot);
  if (!d) return -1;
  const e = endpoint.toLowerCase().replace(/~/g, '/');
  const p = provider.toLowerCase();
  return d.known.findIndex((k) => {
    const [kp, ke] = k.includes(' ') ? k.toLowerCase().split(' ') : ['', k.toLowerCase()];
    return (!kp || kp === p) && (e === ke || e.endsWith(ke));
  });
}

// ───────────── built-in inputs for the known tools ─────────────

/** The smallest of today / this_week / this_month / this_year that covers `days` (none past a year). */
function uploadDate(days?: number | null): string | undefined {
  if (!days || days <= 0) return undefined;
  if (days <= 1) return 'today';
  if (days <= 7) return 'this_week';
  if (days <= 31) return 'this_month';
  if (days <= 366) return 'this_year';
  return undefined;
}

/**
 * The tools Radar knows the input of, so they work without a template: the exact request bodies that Monid's
 * production tools accept. Each returns one body per run.
 */
export interface Builtin {
  slot: Slot; note: string; inputs: (q: RadarQuery) => Record<string, unknown>[];
  /** What a per-result price counts for one input, when it is not the number of items (seconds of audio, say). */
  units?: (q: RadarQuery) => number;
  /** The route Monid picked when the input named none (seen on real runs): prices a route matrix for the estimate. */
  route?: string;
  /** The output carries nextCursor and the tool takes it back as `cursor` (AnyAPI): further pages can be fetched. */
  pages?: boolean;
  /** Not confirmed against a real run: shown to the owner, who can override it with a template. */
  unverified?: boolean;
}
const kws = (q: RadarQuery) => q.keywords.slice(0, q.maxKeywords ?? 5);
export const BUILTIN: Record<string, Builtin> = {
  'anyapi /instagram.reels_search': {
    slot: 'instagram:search', note: 'query: one run per keyword, about 12 public reels each',
    inputs: (q) => kws(q).map((k) => ({ query: k })), pages: true,
  },
  // Billed per second of audio plus a flat fee: a one-minute reel cost $0.008 in production.
  'anyapi /instagram.reel_transcript': {
    slot: 'instagram:transcript', note: 'url: the reel link',
    inputs: (q) => [{ url: q.urls?.[0] ?? '' }],
    units: (q) => Math.max(1, Math.ceil(q.durationS || 90)),
  },
  // Same AnyAPI shape as the Instagram transcript ({url}); the schema inspect gives can override it with a template.
  'anyapi /tiktok.video_transcript_full': {
    slot: 'tiktok:transcript', note: 'url: the video link',
    inputs: (q) => [{ url: q.urls?.[0] ?? '' }],
  },
  // sortBy 'popular' needs the giraffe or badger route (the default lynx route refuses it).
  'anyapi /youtube.search': {
    slot: 'youtube:search', note: 'query: one run per keyword, sorted by popularity (route giraffe), about 20 videos each',
    inputs: (q) => kws(q).map((k) => { const d = uploadDate(q.sinceDays); return { query: k, sortBy: 'popular', route: 'giraffe', ...(d ? { uploadDate: d } : {}) }; }), pages: true,
  },
  'anyapi /tiktok.search_keyword': {
    slot: 'tiktok:search', note: 'query: one run per keyword, about 25 videos each',
    inputs: (q) => kws(q).map((k) => ({ query: k })), pages: true,
  },
  'apify /starvibe/youtube-video-transcript': {
    slot: 'youtube:transcript', note: 'youtube_url: the video link',
    inputs: (q) => [{ youtube_url: q.urls?.[0] ?? '' }],
  },
  // Every keyword's Ad Library search page in one run; count caps the whole run, limitPerSource each search.
  'apify /curious_coder/facebook-ads-library-scraper': {
    slot: 'meta_ads:ads', note: 'urls: an Ad Library search page per keyword (active ads), limitPerSource and count: the most ads to take',
    inputs: (q) => {
      const urls = kws(q).map((k) => ({ url: adLibraryUrl(k, q.country) }));
      return [{ urls, count: q.max * Math.max(1, urls.length), limitPerSource: q.max }];
    },
  },
  // ── Radar v2: text platforms (input shapes as sent in the real runs of 2026-11-05) ──
  // X: one advanced-syntax query per group of keywords, Top posts, 50 a page. Billed $0.0021 for 20 results with no
  // route given: the badger route ($0.0001 a result plus $0.0001 a call).
  'anyapi /twitter.search': {
    slot: 'x:search', note: 'query: X advanced search, up to 5 keywords joined with OR per query, a min_faves floor, English, no reposts; Top, 50 a page',
    inputs: (q) => xQueries(kws(q), { minFaves: q.minFaves ?? 200, sinceDays: q.sinceDays }).map((query) => ({ query, queryType: 'Top', limit: X_LIMIT })),
    route: 'badger', pages: true,
  },
  // LinkedIn: one run per keyword; billed $0.00242 a call with no route given (the hedgehog route).
  'anyapi /linkedin.search_posts': {
    slot: 'linkedin:search', note: 'query: one run per keyword, datePosted from the radar window (last month or last year), about 50 posts each',
    inputs: (q) => kws(q).map((k) => ({ query: k, datePosted: linkedinDate(q.sinceDays) })),
    route: 'hedgehog', pages: true,
  },
  // Reddit keyword search: the keyword as an exact phrase, top of the radar window. Global search is noisy, so the
  // relevance check drops what is off topic.
  'reddit:search anyapi /reddit.search': {
    slot: 'reddit:search', note: 'query: the keyword as an exact phrase, top posts of the radar window (month or year)',
    inputs: (q) => kws(q).map((k) => ({ query: redditPhrase(k), sort: 'top', timeframe: redditTimeframe(q.sinceDays) })),
    route: 'bison', pages: true,
  },
  // The subreddit list through search: subreddit:<name>, top of the month (the verified input shape: query, sort, timeframe).
  'reddit:subreddit anyapi /reddit.search': {
    slot: 'reddit:subreddit', note: 'query: subreddit:<name>, top posts of the month (one run per subreddit)',
    inputs: (q) => (q.subreddit ? [{ query: `subreddit:${q.subreddit}`, sort: 'top', timeframe: redditTimeframe(q.sinceDays ?? 31) }] : []),
    route: 'bison', pages: true,
  },
  'reddit:subreddit anyapi /reddit.subreddit_posts': {
    slot: 'reddit:subreddit', note: 'subreddit, sort top, timeframe: field names not yet confirmed by a real run, so edit them as a template if Monid lists others',
    inputs: (q) => (q.subreddit ? [{ subreddit: q.subreddit, sort: 'top', timeframe: redditTimeframe(q.sinceDays ?? 31) }] : []),
    pages: true, unverified: true,
  },
  // Substack: one run per publication (billed $0.00044 a post plus $0.00039 a call on the octopus route).
  'anyapi /substack.posts': {
    slot: 'substack:posts', note: 'url: the publication, limit, includeContent and onlyFree (one run per publication)',
    inputs: (q) => (q.publication ? [{ url: q.publication, limit: q.max, includeContent: true, onlyFree: true, ...(q.minReactions ? { minReactions: q.minReactions } : {}) }] : []),
    route: 'octopus',
  },
};
/** The built-in input for a tool; per slot first, since one endpoint can serve two slots (Reddit search). */
export const builtinFor = (provider: string, endpoint: string, slot?: string): Builtin | null => {
  const key = `${provider.toLowerCase()} ${endpoint.toLowerCase().replace(/~/g, '/')}`;
  if (slot && BUILTIN[`${slot} ${key}`]) return BUILTIN[`${slot} ${key}`];
  if (BUILTIN[key]) return BUILTIN[key];
  // No slot given: any slot's built-in for this endpoint (enough to say "built in" in the sources list).
  return slot ? null : Object.entries(BUILTIN).find(([k]) => k.endsWith(` ${key}`))?.[1] ?? null;
};

// ───────────── query builders for the text platforms ─────────────

export const X_LIMIT = 50;
/** One keyword as an X search term: a phrase in quotes, a single word bare. Quotes and parentheses inside are dropped. */
const xTerm = (k: string) => { const t = k.replace(/["()]/g, ' ').replace(/\s+/g, ' ').trim(); return /\s/.test(t) ? `"${t}"` : t; };
/**
 * X advanced search for top performers: `(<kw1> OR <kw2> ...) min_faves:<n> lang:en -is:retweet`, plus since:<date>
 * when the radar has a window. Keywords are grouped (up to `per` a query, each query under 480 characters, X's limit
 * being 512) so a radar of 40 keywords costs 8 calls a page, not 40.
 */
export function xQueries(keywords: string[], o: { minFaves: number; sinceDays?: number | null; per?: number; now?: number }): string[] {
  const per = o.per ?? 5;
  const tail = [`min_faves:${Math.max(0, Math.round(o.minFaves))}`, 'lang:en', '-is:retweet'];
  if (o.sinceDays && o.sinceDays > 0) tail.push(`since:${new Date((o.now ?? Date.now()) - o.sinceDays * 86400_000).toISOString().slice(0, 10)}`);
  const end = ` ${tail.join(' ')}`;
  const terms = [...new Set(keywords.map(xTerm).filter(Boolean))];
  const out: string[] = [];
  let group: string[] = [];
  const flush = () => { if (group.length) out.push(`(${group.join(' OR ')})${end}`); group = []; };
  for (const t of terms) {
    const next = `(${[...group, t].join(' OR ')})${end}`;
    if (group.length >= per || (group.length && next.length > 480)) flush();
    group.push(t);
  }
  flush();
  return out;
}
/** LinkedIn's datePosted from a radar window: past-24h, past-week, last-month or last-year (blank window: last-month). */
export function linkedinDate(days?: number | null): string {
  if (days && days <= 1) return 'past-24h';
  if (days && days <= 7) return 'past-week';
  if (!days || days <= 31) return 'last-month';
  return 'last-year';
}
/** Reddit's timeframe: day, week, month or year (all time is never asked: top performers now, not years ago). */
export function redditTimeframe(days?: number | null): string {
  if (days && days <= 1) return 'day';
  if (days && days <= 7) return 'week';
  if (days && days <= 31) return 'month';
  return 'year';
}
/** A Reddit search term: a multi-word keyword as an exact phrase. */
export const redditPhrase = (k: string) => { const t = k.replace(/"/g, '').trim(); return /\s/.test(t) ? `"${t}"` : t; };
/** A subreddit name from "r/Name", "/r/Name/" or a link; null when it is not a valid name. */
export function subredditName(v: string): string | null {
  const m = String(v).trim().match(/^(?:https?:\/\/(?:www\.|old\.)?reddit\.com)?\/?(?:r\/)?([A-Za-z0-9_]{2,21})\/?$/);
  return m ? m[1] : null;
}
/** A publication's https URL and host from "name", "name.substack.com", a custom domain or a link; null when invalid. */
export function publicationUrl(v: string): { url: string; host: string } | null {
  let t = String(v).trim();
  if (!t) return null;
  if (/^[a-z0-9-]+$/i.test(t)) t = `${t}.substack.com`;
  if (!/^https?:\/\//i.test(t)) t = `https://${t}`;
  try {
    const u = new URL(t);
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname)) return null;
    return { url: `https://${u.hostname.toLowerCase()}`, host: u.hostname.toLowerCase() };
  } catch { return null; }
}

const usd = (value: number) => ({ value, currency: 'USD' });
const matrix = (base: number, routes: Record<string, number>) => ({
  type: 'PER_UNIT_MATRIX', amount: usd(base), selectors: [{ key: 'route', in: 'body' }],
  variants: Object.entries(routes).map(([route, v]) => ({ when: { route }, price: { type: 'PER_CALL', amount: usd(v) } })),
});
const X_PRICE = {
  type: 'PER_UNIT_MATRIX', amount: usd(0.0001), selectors: [{ key: 'route', in: 'body' }],
  variants: [
    { when: { route: 'lynx' }, price: { type: 'PER_CALL', amount: usd(0.00054) } },
    { when: { route: 'capybara' }, price: { type: 'PER_CALL', amount: usd(0.0006) } },
    { when: { route: 'badger' }, price: { type: 'PER_RESULT', amount: usd(0.0001), flatFee: usd(0.0001) } },
    { when: { route: 'octopus' }, price: { type: 'PER_RESULT', amount: usd(0.00022), flatFee: usd(0.0044) } },
  ],
};
const REDDIT_PRICE = matrix(0.00035, { bison: 0.00035, octopus: 0.00038, badger: 0.0008, giraffe: 0.0012 });
/**
 * The default tool of each slot (chosen for the owner, 2026-11-05), seeded selected and ready to run, with the price
 * Monid listed for it. "Find sources" refreshes the price from Monid; the owner can still pick another tool.
 */
export const DEFAULT_TOOLS: { slot: Slot; provider: string; endpoint: string; name: string; price: unknown }[] = [
  // Radar v2 (prices as Monid listed them on the real runs of 2026-11-05).
  { slot: 'x:search', provider: 'anyapi', endpoint: '/twitter.search', name: 'AnyAPI', price: X_PRICE },
  { slot: 'linkedin:search', provider: 'anyapi', endpoint: '/linkedin.search_posts', name: 'AnyAPI', price: matrix(0.0012, { giraffe: 0.0012, hedgehog: 0.00242, fox: 0.018 }) },
  { slot: 'reddit:search', provider: 'anyapi', endpoint: '/reddit.search', name: 'AnyAPI', price: REDDIT_PRICE },
  { slot: 'reddit:subreddit', provider: 'anyapi', endpoint: '/reddit.search', name: 'AnyAPI', price: REDDIT_PRICE },
  { slot: 'substack:posts', provider: 'anyapi', endpoint: '/substack.posts', name: 'AnyAPI', price: { type: 'PER_UNIT_MATRIX', amount: usd(0.00044), selectors: [{ key: 'route', in: 'body' }], variants: [{ when: { route: 'octopus' }, price: { type: 'PER_RESULT', amount: usd(0.00044), flatFee: usd(0.00039) } }] } },
  { slot: 'youtube:search', provider: 'anyapi', endpoint: '/youtube.search', name: 'AnyAPI', price: matrix(0.0005, { lynx: 0.0005, badger: 0.0012, giraffe: 0.0012 }) },
  { slot: 'youtube:transcript', provider: 'apify', endpoint: '/starvibe/youtube-video-transcript', name: 'Apify', price: { type: 'PER_RESULT', amount: usd(0.005) } },
  // Billed $0.0012 a call in production with no route given, so the estimate uses that rather than the base.
  { slot: 'tiktok:search', provider: 'anyapi', endpoint: '/tiktok.search_keyword', name: 'AnyAPI', price: matrix(0.0012, { bison: 0.0006, quokka: 0.0008, giraffe: 0.0012, fox: 0.0036 }) },
  { slot: 'tiktok:transcript', provider: 'anyapi', endpoint: '/tiktok.video_transcript_full', name: 'AnyAPI', price: null },
  { slot: 'instagram:search', provider: 'anyapi', endpoint: '/instagram.reels_search', name: 'AnyAPI', price: matrix(0.0011, { chameleon: 0.0011, lynx: 0.00188, tiger: 0.0024 }) },
  { slot: 'instagram:transcript', provider: 'anyapi', endpoint: '/instagram.reel_transcript', name: 'AnyAPI', price: { type: 'TIERED', amount: usd(0.0001), default: { type: 'PER_RESULT', amount: usd(0.0001), flatFee: usd(0.0015) } } },
  { slot: 'meta_ads:ads', provider: 'apify', endpoint: '/curious_coder/facebook-ads-library-scraper', name: 'Apify', price: { type: 'PER_RESULT', amount: usd(0.00075) } },
];

// ───────────── the input mapper ─────────────

export interface RadarQuery {
  keywords: string[]; max: number; sinceDays?: number | null; country?: string | null; urls?: string[]; durationS?: number | null;
  /** How many keywords run (one run each, or grouped for X). Default 5; themed radars run all of theirs. */
  maxKeywords?: number;
  /** X: the min_faves floor. */
  minFaves?: number | null;
  /** reddit:subreddit: the subreddit name. substack:posts: the publication URL and an optional reactions floor. */
  subreddit?: string | null; publication?: string | null; minReactions?: number | null;
}
interface Field { name: string; type: string; enum?: unknown[]; default?: unknown; itemsType?: string; required: boolean }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The fields of an input schema (JSON Schema properties, or an array of {name, type}). */
export function schemaFields(schema: unknown): Field[] {
  let s = schema;
  if (typeof s === 'string') { try { s = JSON.parse(s); } catch { return []; } }
  if (isObj(s) && isObj(s.inputSchema)) s = s.inputSchema;
  if (Array.isArray(s)) {
    return s.filter(isObj).map((f) => ({ name: String(f.name ?? f.key ?? ''), type: String(f.type ?? 'string').toLowerCase(), enum: Array.isArray(f.enum) ? f.enum : undefined, default: f.default, required: Boolean(f.required), itemsType: isObj(f.items) ? String(f.items.type ?? '') : undefined })).filter((f) => f.name);
  }
  if (!isObj(s) || !isObj(s.properties)) return [];
  const req = new Set(Array.isArray(s.required) ? s.required.map(String) : []);
  return Object.entries(s.properties).filter(([, v]) => isObj(v)).map(([name, v]) => {
    const f = v as Record<string, unknown>;
    let type = String(Array.isArray(f.type) ? f.type.find((t) => t !== 'null') ?? 'string' : f.type ?? (f.editor === 'requestListSources' ? 'array' : 'string')).toLowerCase();
    if (f.editor === 'requestListSources' || f.editor === 'stringList') type = 'array';
    return { name, type, enum: Array.isArray(f.enum) ? f.enum : undefined, default: f.default ?? f.prefill, required: req.has(name), itemsType: isObj(f.items) ? String(f.items.type ?? '') : f.editor === 'requestListSources' ? 'object' : undefined };
  });
}

const lc = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const KEY_ARRAY = ['searchqueries', 'searchterms', 'queries', 'keywords', 'searchkeywords', 'search', 'terms', 'hashtags', 'searchquery', 'query', 'keyword', 'q', 'searchterm', 'term', 'searchstring'];
const MAX = ['maxitems', 'maxresults', 'resultslimit', 'resultsperpage', 'maxresultspersearch', 'maxresultsperquery', 'maxvideos', 'maxads', 'count', 'limit', 'maxposts', 'maxreels', 'numberofresults'];
const COUNTRY = ['country', 'countrycode', 'countries', 'region', 'gl', 'location', 'adlibrarycountry'];
const SINCE = ['publishedafter', 'datefilter', 'uploaddate', 'oldestpostdate', 'onlypostsnewerthan', 'since', 'startdate', 'fromdate', 'datefrom', 'oldestdate', 'daterange', 'dateposted', 'period'];
const URLS = ['starturls', 'urls', 'videourls', 'postorvideourls', 'links', 'videos', 'directurls', 'url', 'videourl', 'youtubeurl', 'link', 'videolink'];
const SORT = ['sortingorder', 'sortby', 'sort', 'order'];

function find(fields: Field[], names: string[], used: Set<string>): Field | undefined {
  for (const n of names) {
    const f = fields.find((x) => lc(x.name) === n && !used.has(x.name) && x.type !== 'boolean');
    if (f) return f;
  }
  return undefined;
}

const DAY_WORDS: [RegExp, number][] = [[/hour/i, 1 / 24], [/today|day/i, 1], [/week/i, 7], [/month/i, 31], [/year/i, 366]];
/** The smallest enum value that still covers `days` ("week" for 5 days), or the largest one. */
function sinceEnum(values: unknown[], days: number): unknown {
  const ranked = values.map((v) => ({ v, d: DAY_WORDS.find(([re]) => re.test(String(v)))?.[1] })).filter((x) => x.d != null).sort((a, b) => a.d! - b.d!);
  return (ranked.find((x) => x.d! >= days) ?? ranked[ranked.length - 1])?.v;
}

/** The Meta Ad Library search page for a keyword (what the ad library scrapers take as start URLs). */
export function adLibraryUrl(keyword: string, country?: string | null): string {
  const p = new URLSearchParams({ active_status: 'active', ad_type: 'all', country: (country || 'ALL').toUpperCase(), q: keyword, search_type: 'keyword_unordered', media_type: 'all' });
  return `https://www.facebook.com/ads/library/?${p.toString()}`;
}

/** Fallback field names per slot when a tool gave no schema (the shapes of the usual actors). */
const KNOWN_FIELDS: Record<Slot, Field[]> = {
  'youtube:search': [{ name: 'searchQueries', type: 'array', itemsType: 'string', required: true }, { name: 'maxResults', type: 'integer', required: false }, { name: 'dateFilter', type: 'string', enum: ['hour', 'today', 'week', 'month', 'year'], required: false }],
  'youtube:transcript': [{ name: 'startUrls', type: 'array', itemsType: 'string', required: true }],
  'tiktok:search': [{ name: 'searchQueries', type: 'array', itemsType: 'string', required: true }, { name: 'resultsPerPage', type: 'integer', required: false }],
  'tiktok:transcript': [{ name: 'url', type: 'string', required: true }],
  'instagram:transcript': [{ name: 'url', type: 'string', required: true }],
  'instagram:search': [{ name: 'username', type: 'array', itemsType: 'string', required: true }, { name: 'resultsLimit', type: 'integer', required: false }],
  'meta_ads:ads': [{ name: 'urls', type: 'array', itemsType: 'object', required: true }, { name: 'count', type: 'integer', required: false }],
  'x:search': [{ name: 'query', type: 'string', required: true }, { name: 'limit', type: 'integer', required: false }],
  'linkedin:search': [{ name: 'query', type: 'string', required: true }],
  'reddit:search': [{ name: 'query', type: 'string', required: true }],
  'reddit:subreddit': [{ name: 'subreddit', type: 'string', required: true }],
  'substack:posts': [{ name: 'url', type: 'string', required: true }, { name: 'limit', type: 'integer', required: false }],
};

export interface Mapped { inputs: Record<string, unknown>[]; notes: string[]; missing: string[] }

/** Fill {{keywords}} {{keyword}} {{max}} {{country}} {{since_days}} {{url}} {{urls}} in a template value. */
function fill(v: unknown, q: RadarQuery, keyword: string): unknown {
  if (typeof v === 'string') {
    const whole: Record<string, unknown> = { '{{keywords}}': q.keywords, '{{urls}}': q.urls ?? [], '{{max}}': q.max, '{{since_days}}': q.sinceDays ?? null };
    if (v in whole) return whole[v];
    return v.replaceAll('{{keyword}}', keyword).replaceAll('{{country}}', (q.country || '').toUpperCase()).replaceAll('{{url}}', q.urls?.[0] ?? '').replaceAll('{{max}}', String(q.max)).replaceAll('{{subreddit}}', q.subreddit ?? '').replaceAll('{{publication}}', q.publication ?? '');
  }
  if (Array.isArray(v)) return v.map((x) => fill(x, q, keyword));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, q, keyword)]));
  return v;
}

/**
 * Map a query into a tool's input. One input when the tool takes a list of searches, one per keyword (up to 5)
 * when it takes a single search string. The owner's template (JSON) is merged on top and may use placeholders.
 * A known tool (BUILTIN) gets its built-in input instead of the guess from the schema.
 */
export function mapInput(slot: Slot, schema: unknown, q: RadarQuery, template?: Record<string, unknown> | null, tool?: { provider: string; endpoint: string } | null): Mapped {
  const bi = tool ? builtinFor(tool.provider, tool.endpoint, slot) : null;
  if (bi && bi.slot === slot) {
    const kw = q.keywords.map((k) => k.trim()).filter(Boolean);
    const qq = { ...q, keywords: kw, urls: (q.urls ?? []).filter(Boolean) };
    const raw = bi.inputs(qq);
    const inputs = raw.map((b, i) => (template ? { ...b, ...(fill(template, qq, kw[i] ?? kw[0] ?? '') as Record<string, unknown>) } : b));
    const notes = [`Built-in input for ${tool!.provider} ${tool!.endpoint}. ${bi.note}.`];
    if (bi.unverified) notes.push('This input is not yet confirmed by a real run. If the first run fails, the provider\'s message shows here and a template can fix the field names.');
    const cap = q.maxKeywords ?? 5;
    if (bi.slot !== 'reddit:subreddit' && bi.slot !== 'substack:posts' && kw.length > cap) notes.push(`Only the first ${cap} keywords run.`);
    return { inputs, notes, missing: [] };
  }
  let fields = schemaFields(schema);
  const notes: string[] = [];
  if (!fields.length) { fields = KNOWN_FIELDS[slot]; notes.push('This tool gave no input schema, so the usual field names are used.'); }
  const used = new Set<string>();
  const base: Record<string, unknown> = {};
  // Required fields with a default keep it.
  for (const f of fields) if (f.required && f.default !== undefined) base[f.name] = f.default;

  const def = slotDef(slot)!;
  const kw = q.keywords.map((k) => k.trim()).filter(Boolean);
  const urls = (q.urls ?? []).filter(Boolean);
  let perKeyword: Field | undefined;

  if (def.kind === 'source') {
    // A subreddit or a publication: the field that names it.
    const val = q.subreddit ?? q.publication ?? '';
    const f = find(fields, def.platform === 'reddit' ? ['subreddit', 'subredditname', 'sub', 'name', 'query', 'q'] : ['url', 'publication', 'publicationurl', 'link', 'domain'], used);
    if (f) {
      used.add(f.name);
      base[f.name] = lc(f.name) === 'query' || lc(f.name) === 'q' ? `subreddit:${val}` : f.type === 'array' ? [val] : val;
      notes.push(`${f.name}: the ${def.platform === 'reddit' ? 'subreddit' : 'publication'}`);
    }
  } else if (def.kind === 'transcript') {
    const f = find(fields, URLS, used);
    if (f) {
      used.add(f.name);
      base[f.name] = f.type === 'array' ? (f.itemsType === 'object' ? urls.map((url) => ({ url })) : urls) : urls[0] ?? '';
      notes.push(`${f.name}: the video link`);
    }
  } else {
    const kf = find(fields, KEY_ARRAY, used);
    const uf = find(fields, URLS, used);
    if (def.kind === 'ads' && uf && (!kf || uf.required)) {
      if (uf) {
        used.add(uf.name);
        const list = kw.map((k) => adLibraryUrl(k, q.country));
        base[uf.name] = uf.type === 'array' ? (uf.itemsType === 'string' ? list : list.map((url) => ({ url }))) : list[0];
        if (uf.type !== 'array') perKeyword = uf;
        notes.push(`${uf.name}: an Ad Library search page per keyword (active ads${q.country ? `, ${q.country.toUpperCase()}` : ', every country'})`);
      }
    } else if (kf) {
      used.add(kf.name);
      if (kf.type === 'array') base[kf.name] = lc(kf.name) === 'hashtags' ? kw.map((k) => k.replace(/[^a-z0-9]/gi, '')) : kw;
      else { base[kf.name] = kw[0] ?? ''; perKeyword = kf; }
      notes.push(`${kf.name}: the keywords${kf.type === 'array' ? '' : ' (one run per keyword)'}`);
    }
  }

  const mf = find(fields, MAX, used);
  if (mf) { used.add(mf.name); base[mf.name] = mf.type === 'string' ? String(q.max) : q.max; notes.push(`${mf.name}: ${q.max}`); }

  if (q.country) {
    const cf = find(fields, COUNTRY, used);
    if (cf && !(def.kind === 'ads' && base[cf.name] !== undefined)) {
      used.add(cf.name);
      const code = q.country.toUpperCase();
      const val = cf.enum ? cf.enum.find((e) => String(e).toUpperCase() === code) ?? cf.enum.find((e) => String(e).toLowerCase() === code.toLowerCase()) : cf.type === 'array' ? [code] : code;
      if (val !== undefined) { base[cf.name] = val; notes.push(`${cf.name}: ${code}`); }
    }
  }

  if (q.sinceDays && def.kind !== 'transcript') {
    const sf = find(fields, SINCE, used);
    if (sf) {
      used.add(sf.name);
      if (sf.enum?.length) { const v = sinceEnum(sf.enum, q.sinceDays); if (v !== undefined) base[sf.name] = v; }
      else if (sf.type === 'integer' || sf.type === 'number') base[sf.name] = q.sinceDays;
      else if (/newerthan/i.test(sf.name)) base[sf.name] = `${q.sinceDays} days`;
      else base[sf.name] = new Date(Date.now() - q.sinceDays * 86400_000).toISOString().slice(0, 10);
      if (base[sf.name] !== undefined) notes.push(`${sf.name}: the last ${q.sinceDays} days`);
    }
  }

  if (def.kind === 'search') {
    const so = find(fields, SORT, used);
    const want = so?.enum?.find((e) => /view|popular/i.test(String(e)));
    if (so && want !== undefined) { base[so.name] = want; notes.push(`${so.name}: ${String(want)}`); }
  }

  const missing = fields.filter((f) => f.required && base[f.name] === undefined && !(template && f.name in template)).map((f) => f.name);
  const one = (k: string): Record<string, unknown> => {
    const b: Record<string, unknown> = { ...base };
    if (perKeyword) b[perKeyword.name] = def.kind === 'ads' ? adLibraryUrl(k, q.country) : k;
    return template ? { ...b, ...(fill(template, q, k) as Record<string, unknown>) } : b;
  };
  const cap = q.maxKeywords ?? 5;
  const inputs = perKeyword && def.kind !== 'transcript' && def.kind !== 'source' ? kw.slice(0, cap).map(one) : [one(kw[0] ?? '')];
  if (perKeyword && kw.length > cap) notes.push(`Only the first ${cap} keywords run (one run each).`);
  return { inputs, notes, missing };
}
