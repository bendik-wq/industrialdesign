/**
 * Radar: the source map. Each slot (a platform and what we need from it) gets one Monid tool, picked by the owner
 * from what Monid's discover offers, with the known actors pre-selected when they appear. The input mapper turns
 * our query fields (keywords, max items, date range, country, video URLs) into that tool's own input schema, and
 * the owner sees the exact input before the first paid run.
 */

export const PLATFORMS = ['youtube', 'tiktok', 'instagram', 'meta_ads'] as const;
export type Platform = (typeof PLATFORMS)[number];
export type Kind = 'search' | 'transcript' | 'ads';
export type Slot = 'youtube:search' | 'youtube:transcript' | 'tiktok:search' | 'tiktok:transcript' | 'instagram:search' | 'instagram:transcript' | 'meta_ads:ads';

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
];
export const slotDef = (slot: string) => SLOTS.find((s) => s.slot === slot);
export const isSlot = (s: unknown): s is Slot => typeof s === 'string' && SLOTS.some((d) => d.slot === s);
export const searchSlot = (p: Platform): Slot => (p === 'meta_ads' ? 'meta_ads:ads' : `${p}:search` as Slot);
export const transcriptSlot = (p: Platform): Slot | null => (p === 'meta_ads' ? null : `${p}:transcript` as Slot);

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
}
export const BUILTIN: Record<string, Builtin> = {
  'anyapi /instagram.reels_search': {
    slot: 'instagram:search', note: 'query: one run per keyword, about 12 public reels each',
    inputs: (q) => q.keywords.slice(0, 5).map((k) => ({ query: k })),
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
    inputs: (q) => q.keywords.slice(0, 5).map((k) => { const d = uploadDate(q.sinceDays); return { query: k, sortBy: 'popular', route: 'giraffe', ...(d ? { uploadDate: d } : {}) }; }),
  },
  'anyapi /tiktok.search_keyword': {
    slot: 'tiktok:search', note: 'query: one run per keyword, about 25 videos each',
    inputs: (q) => q.keywords.slice(0, 5).map((k) => ({ query: k })),
  },
  'apify /starvibe/youtube-video-transcript': {
    slot: 'youtube:transcript', note: 'youtube_url: the video link',
    inputs: (q) => [{ youtube_url: q.urls?.[0] ?? '' }],
  },
  // Every keyword's Ad Library search page in one run; count caps the whole run, limitPerSource each search.
  'apify /curious_coder/facebook-ads-library-scraper': {
    slot: 'meta_ads:ads', note: 'urls: an Ad Library search page per keyword (active ads), limitPerSource and count: the most ads to take',
    inputs: (q) => {
      const urls = q.keywords.slice(0, 5).map((k) => ({ url: adLibraryUrl(k, q.country) }));
      return [{ urls, count: q.max * Math.max(1, urls.length), limitPerSource: q.max }];
    },
  },
};
export const builtinFor = (provider: string, endpoint: string): Builtin | null => BUILTIN[`${provider.toLowerCase()} ${endpoint.toLowerCase().replace(/~/g, '/')}`] ?? null;

const usd = (value: number) => ({ value, currency: 'USD' });
const matrix = (base: number, routes: Record<string, number>) => ({
  type: 'PER_UNIT_MATRIX', amount: usd(base), selectors: [{ key: 'route', in: 'body' }],
  variants: Object.entries(routes).map(([route, v]) => ({ when: { route }, price: { type: 'PER_CALL', amount: usd(v) } })),
});
/**
 * The default tool of each slot (chosen for the owner, 2026-11-05), seeded selected and ready to run, with the price
 * Monid listed for it. "Find sources" refreshes the price from Monid; the owner can still pick another tool.
 */
export const DEFAULT_TOOLS: { slot: Slot; provider: string; endpoint: string; name: string; price: unknown }[] = [
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

export interface RadarQuery { keywords: string[]; max: number; sinceDays?: number | null; country?: string | null; urls?: string[]; durationS?: number | null }
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
};

export interface Mapped { inputs: Record<string, unknown>[]; notes: string[]; missing: string[] }

/** Fill {{keywords}} {{keyword}} {{max}} {{country}} {{since_days}} {{url}} {{urls}} in a template value. */
function fill(v: unknown, q: RadarQuery, keyword: string): unknown {
  if (typeof v === 'string') {
    const whole: Record<string, unknown> = { '{{keywords}}': q.keywords, '{{urls}}': q.urls ?? [], '{{max}}': q.max, '{{since_days}}': q.sinceDays ?? null };
    if (v in whole) return whole[v];
    return v.replaceAll('{{keyword}}', keyword).replaceAll('{{country}}', (q.country || '').toUpperCase()).replaceAll('{{url}}', q.urls?.[0] ?? '').replaceAll('{{max}}', String(q.max));
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
  const bi = tool ? builtinFor(tool.provider, tool.endpoint) : null;
  if (bi && bi.slot === slot) {
    const kw = q.keywords.map((k) => k.trim()).filter(Boolean);
    const qq = { ...q, keywords: kw, urls: (q.urls ?? []).filter(Boolean) };
    const raw = bi.inputs(qq);
    const inputs = raw.map((b, i) => (template ? { ...b, ...(fill(template, qq, kw[i] ?? kw[0] ?? '') as Record<string, unknown>) } : b));
    const notes = [`Built-in input for ${tool!.provider} ${tool!.endpoint}. ${bi.note}.`];
    if (kw.length > 5) notes.push('Only the first 5 keywords run.');
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

  if (def.kind === 'transcript') {
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
  const inputs = perKeyword && def.kind !== 'transcript' ? kw.slice(0, 5).map(one) : [one(kw[0] ?? '')];
  if (perKeyword && kw.length > 5) notes.push('Only the first 5 keywords run (one run each).');
  return { inputs, notes, missing };
}
