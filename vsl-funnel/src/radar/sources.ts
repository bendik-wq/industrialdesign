/**
 * Radar: the source map. Each slot (a platform and what we need from it) gets one Monid tool, picked by the owner
 * from what Monid's discover offers, with the known actors pre-selected when they appear. The input mapper turns
 * our query fields (keywords, max items, date range, country, video URLs) into that tool's own input schema, and
 * the owner sees the exact input before the first paid run.
 */

export const PLATFORMS = ['youtube', 'tiktok', 'instagram', 'meta_ads'] as const;
export type Platform = (typeof PLATFORMS)[number];
export type Kind = 'search' | 'transcript' | 'ads';
export type Slot = 'youtube:search' | 'youtube:transcript' | 'tiktok:search' | 'tiktok:transcript' | 'instagram:search' | 'meta_ads:ads';

export interface SlotDef { slot: Slot; platform: Platform; kind: Kind; label: string; query: string; known: string[]; match: (endpoint: string) => boolean }

const has = (...words: string[]) => (e: string) => words.every((w) => e.toLowerCase().includes(w));
export const SLOTS: SlotDef[] = [
  { slot: 'youtube:search', platform: 'youtube', kind: 'search', label: 'YouTube search', query: 'youtube search videos by keyword with views', known: ['/streamers/youtube-scraper'], match: has('youtube') },
  { slot: 'youtube:transcript', platform: 'youtube', kind: 'transcript', label: 'YouTube transcripts', query: 'youtube video transcript', known: [], match: has('youtube', 'transcript') },
  { slot: 'tiktok:search', platform: 'tiktok', kind: 'search', label: 'TikTok search', query: 'tiktok search videos by keyword', known: ['/clockworks/tiktok-scraper', '/clockworks/free-tiktok-scraper'], match: has('tiktok') },
  { slot: 'tiktok:transcript', platform: 'tiktok', kind: 'transcript', label: 'TikTok transcripts', query: 'tiktok video transcript', known: [], match: has('tiktok', 'transcript') },
  { slot: 'instagram:search', platform: 'instagram', kind: 'search', label: 'Instagram reels', query: 'instagram reels scraper', known: ['/apify/instagram-reel-scraper'], match: has('instagram') },
  { slot: 'meta_ads:ads', platform: 'meta_ads', kind: 'ads', label: 'Meta Ad Library', query: 'facebook meta ad library ads search', known: ['/curious_coder/facebook-ads-library-scraper', '/apify/facebook-ads-scraper'], match: (e) => /facebook|meta/i.test(e) && /ad/i.test(e) },
];
export const slotDef = (slot: string) => SLOTS.find((s) => s.slot === slot);
export const isSlot = (s: unknown): s is Slot => typeof s === 'string' && SLOTS.some((d) => d.slot === s);
export const searchSlot = (p: Platform): Slot => (p === 'meta_ads' ? 'meta_ads:ads' : `${p}:search` as Slot);
export const transcriptSlot = (p: Platform): Slot | null => (p === 'youtube' || p === 'tiktok' ? `${p}:transcript` : null);

/** A known actor for this slot (pre-selected when discover offers it). */
export function isRecommended(slot: Slot, provider: string, endpoint: string): boolean {
  const d = slotDef(slot);
  if (!d) return false;
  const e = endpoint.toLowerCase().replace(/~/g, '/');
  if (d.known.some((k) => e === k || e.endsWith(k))) return true;
  // Transcript slots have no fixed actor: a transcript tool for the right platform counts.
  return d.kind === 'transcript' && provider.length > 0 && d.match(e);
}

// ───────────── the input mapper ─────────────

export interface RadarQuery { keywords: string[]; max: number; sinceDays?: number | null; country?: string | null; urls?: string[] }
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
  'tiktok:transcript': [{ name: 'postURLs', type: 'array', itemsType: 'string', required: true }],
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
 */
export function mapInput(slot: Slot, schema: unknown, q: RadarQuery, template?: Record<string, unknown> | null): Mapped {
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
