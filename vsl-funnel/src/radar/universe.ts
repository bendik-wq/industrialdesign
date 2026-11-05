/**
 * Radar v2: the keyword universe, the themed radars built from it, the curated subreddits and Substack publications,
 * and the platform switches. Everything here is stored in D1 and editable in Studio → Radar → Sources & sweeps; the
 * lists below are only the first seed (written once, marked in radar_meta, never re-added after the owner deletes).
 *
 * In the niche: what G&L sells into (PE and M&A, buying small businesses, owners' exits). Adjacent: formats that travel
 * (business breakdowns, money, operator advice), searched with a higher bar (X min_faves 1000) since their reach is
 * the point. Radars with a theme search every enabled keyword of that theme.
 */
import type { Runtime } from '../app';
import { KEYWORD_PLATFORMS, PLATFORMS, type Platform, publicationUrl, subredditName } from './sources';

export type Tier = 'in' | 'adjacent';
export interface ThemeDef { id: string; name: string; tier: Tier; platforms: Platform[]; since_days: number; min_faves: number }

const ALL_TEXT_AND_VIDEO: Platform[] = ['youtube', 'tiktok', 'instagram', 'x', 'linkedin', 'reddit'];
export const THEMES: ThemeDef[] = [
  { id: 'pe_ma', name: 'PE and M&A', tier: 'in', platforms: ALL_TEXT_AND_VIDEO, since_days: 180, min_faves: 200 },
  { id: 'smb_acquisition', name: 'SMB acquisition', tier: 'in', platforms: ALL_TEXT_AND_VIDEO, since_days: 180, min_faves: 200 },
  { id: 'owner_exits', name: 'Owner exits', tier: 'in', platforms: ALL_TEXT_AND_VIDEO, since_days: 180, min_faves: 200 },
  { id: 'breakdowns', name: 'Business breakdowns', tier: 'adjacent', platforms: ['youtube', 'tiktok', 'instagram', 'x'], since_days: 90, min_faves: 1000 },
  { id: 'wealth', name: 'Wealth and money', tier: 'adjacent', platforms: ['youtube', 'tiktok', 'instagram', 'x'], since_days: 90, min_faves: 1000 },
  { id: 'operators', name: 'Operator content', tier: 'adjacent', platforms: ['youtube', 'tiktok', 'instagram', 'x', 'linkedin'], since_days: 90, min_faves: 1000 },
];
export const themeDef = (id: string | null | undefined) => THEMES.find((t) => t.id === id);
/** The X min_faves floor when a radar sets none: 200 in the niche (smaller audiences), 1000 adjacent. */
export const defaultMinFaves = (niche: string) => (niche === 'out' ? 1000 : 200);

const K = (theme: string, tier: Tier, list: string[]) => list.map((keyword) => ({ keyword, tier, theme }));
export const KEYWORD_UNIVERSE: { keyword: string; tier: Tier; theme: string }[] = [
  ...K('pe_ma', 'in', [
    'private equity small business', 'lower middle market', 'leveraged buyout', 'LBO', 'EBITDA multiple', 'add-on acquisition',
    'platform company', 'buy and build', 'roll up strategy', 'private equity roll up', 'M&A for business owners', 'quality of earnings',
    'recapitalization', 'deal structure', 'holding company', 'consolidation play', 'independent sponsor',
  ]),
  ...K('smb_acquisition', 'in', [
    'business acquisition', 'buy a business', 'buying a small business', 'buy a business no money down', 'seller financing', 'seller note',
    'earnout', 'search fund', 'ETA entrepreneurship through acquisition', 'SBA 7a loan', 'buy a competitor', 'acquire a business',
    'small business acquisition', 'due diligence small business', 'letter of intent business', 'acquisition entrepreneur',
  ]),
  ...K('owner_exits', 'in', [
    'succession planning', 'exit planning', 'sell my business', 'selling a business', 'business valuation', 'what is my business worth',
    'business broker', 'retiring business owner', 'owner exit strategy', 'equity rollover',
  ]),
  ...K('breakdowns', 'adjacent', [
    'business breakdown', 'how much does a car wash make', 'how much does a laundromat make', 'how much does an HVAC business make',
    'founder story', 'CEO interview', 'how I built my business', 'company case study', 'business model explained', 'profitable small business',
    'boring business millionaire', 'behind the scenes of a business',
  ]),
  ...K('wealth', 'adjacent', [
    'private equity explained', 'hedge fund', 'wealth building', 'cash flow business', 'real estate deal', 'family office', 'net worth',
    'investing for business owners', 'passive income business', 'how the rich make money', 'buy cash flowing assets',
  ]),
  ...K('operators', 'adjacent', [
    'operator advice', 'scaling a business', 'boring business', 'franchise', 'negotiation', 'sales training', 'offer creation', 'Hormozi',
    '100M offers', 'hiring and delegation', 'business systems', 'pricing strategy', 'small business marketing', 'entrepreneurship advice',
  ]),
];

/** A keyword radar outside the universe: Meta ads about owners and acquisitions (the Ad Library takes few, exact terms). */
export const META_ADS_RADAR = {
  name: 'Meta ads: owners and acquisitions', niche: 'in' as const, country: 'US', since_days: null,
  keywords: ['buy a business', 'business acquisition', 'seller financing', 'sell my business', 'exit planning', 'masterclass for business owners'],
};

/** The radars v1 seeded, retired by the v2 seed (only the seeded rows, matched by id prefix and exact name). */
export const V1_RADAR_NAMES = ['Acquisitions (our niche)', 'Formats that travel (outside the niche)', 'Meta ads: buying a business', 'Meta ads: high-ticket education'];

export const SUBREDDITS: { name: string; niche: 'in' | 'out' }[] = [
  { name: 'smallbusiness', niche: 'in' }, { name: 'privateequity', niche: 'in' }, { name: 'sweatystartup', niche: 'in' },
  { name: 'SearchFunds', niche: 'in' }, { name: 'acquisitions', niche: 'in' }, { name: 'Entrepreneur', niche: 'out' },
  { name: 'fatFIRE', niche: 'out' }, { name: 'business', niche: 'out' }, { name: 'investing', niche: 'out' },
  { name: 'financialindependence', niche: 'out' }, { name: 'startups', niche: 'out' },
];

/**
 * Substack publications. `verified: true` = notboring.co returned posts in a real run (2026-11-05); the others marked
 * true are well-known Substack publications by name, the ones marked false are guesses at an address. Any publication
 * whose fetch fails is switched off with the provider's message, so a wrong guess costs one call.
 */
export const PUBLICATIONS: { url: string; name: string; niche: 'in' | 'out'; verified: boolean }[] = [
  { url: 'https://www.notboring.co', name: 'Not Boring', niche: 'out', verified: true },
  { url: 'https://www.thediff.co', name: 'The Diff', niche: 'out', verified: true },
  { url: 'https://www.netinterest.co', name: 'Net Interest', niche: 'out', verified: true },
  { url: 'https://www.mbi-deepdives.com', name: 'MBI Deep Dives', niche: 'out', verified: true },
  { url: 'https://www.yetanothervalueblog.com', name: 'Yet Another Value Blog', niche: 'out', verified: true },
  { url: 'https://thebearcave.substack.com', name: 'The Bear Cave', niche: 'out', verified: true },
  { url: 'https://doomberg.substack.com', name: 'Doomberg', niche: 'out', verified: true },
  { url: 'https://kyla.substack.com', name: 'Kyla Scanlon', niche: 'out', verified: true },
  { url: 'https://pmarca.substack.com', name: 'Marc Andreessen', niche: 'out', verified: true },
  { url: 'https://pomp.substack.com', name: 'The Pomp Letter', niche: 'out', verified: true },
  { url: 'https://www.readtrung.com', name: 'SatPost by Trung Phan', niche: 'out', verified: true },
  { url: 'https://petition.substack.com', name: 'Petition', niche: 'in', verified: true },
  { url: 'https://www.newcomer.co', name: 'Newcomer', niche: 'out', verified: true },
  { url: 'https://www.lennysnewsletter.com', name: 'Lenny\'s Newsletter', niche: 'out', verified: true },
  { url: 'https://www.noahpinion.blog', name: 'Noahpinion', niche: 'out', verified: true },
  { url: 'https://www.apricitas.io', name: 'Apricitas Economics', niche: 'out', verified: true },
  { url: 'https://www.libertyrpf.com', name: 'Liberty\'s Highlights', niche: 'out', verified: true },
  { url: 'https://www.compoundingquality.net', name: 'Compounding Quality', niche: 'out', verified: true },
  { url: 'https://andrewwilkinson.substack.com', name: 'Andrew Wilkinson', niche: 'in', verified: false },
  { url: 'https://contrarianthinking.substack.com', name: 'Contrarian Thinking', niche: 'in', verified: false },
  { url: 'https://girdley.substack.com', name: 'Michael Girdley', niche: 'in', verified: false },
  { url: 'https://smbdealhunter.substack.com', name: 'SMB Deal Hunter', niche: 'in', verified: false },
  { url: 'https://sweatystartup.substack.com', name: 'The Sweaty Startup', niche: 'in', verified: false },
  { url: 'https://boringbusiness.substack.com', name: 'Boring Business', niche: 'in', verified: false },
  { url: 'https://searchfunds.substack.com', name: 'Search Funds', niche: 'in', verified: false },
  { url: 'https://www.rationalwalk.com', name: 'The Rational Walk', niche: 'out', verified: false },
  { url: 'https://clarksquarecapital.substack.com', name: 'Clark Square Capital', niche: 'out', verified: false },
  { url: 'https://speedwellresearch.substack.com', name: 'Speedwell Research', niche: 'out', verified: false },
  { url: 'https://sahilbloom.substack.com', name: 'The Curiosity Chronicle', niche: 'out', verified: false },
  { url: 'https://theprofile.substack.com', name: 'The Profile', niche: 'out', verified: false },
];

// ───────────── storage ─────────────

const parse = <T>(s: string | null | undefined, d: T): T => { try { return s ? (JSON.parse(s) as T) : d; } catch { return d; } };

export async function metaGet(rt: Runtime, key: string): Promise<string | null> {
  const r = await rt.env.DB.prepare('SELECT value FROM radar_meta WHERE key = ?').bind(key).first<{ value: string | null }>();
  return r?.value ?? null;
}
export async function metaSet(rt: Runtime, key: string, value: string) {
  await rt.env.DB.prepare('INSERT INTO radar_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value).run();
}

/** Platforms the owner switched off (no run starts for them, in any radar or sweep). */
export async function platformsOff(rt: Runtime): Promise<Set<Platform>> {
  return new Set(parse<string[]>(await metaGet(rt, 'platforms_off'), []).filter((p): p is Platform => (PLATFORMS as readonly string[]).includes(p)));
}
export async function setPlatform(rt: Runtime, platform: Platform, on: boolean) {
  const off = await platformsOff(rt);
  if (on) off.delete(platform); else off.add(platform);
  await metaSet(rt, 'platforms_off', JSON.stringify([...off]));
}

const id = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

/**
 * The v2 seed, once: the keyword universe, one radar per theme, the Meta ads radar, the subreddits and the
 * publications; the four v1 seeded radars are retired (soft-deleted; their items keep their radar ids).
 */
export async function seedV2(rt: Runtime, now = Date.now()) {
  if (await metaGet(rt, 'seed_v2')) return false;
  const db = rt.env.DB;
  const ts = (i: number) => new Date(now + i).toISOString();
  const stmts: D1PreparedStatement[] = [];
  stmts.push(db.prepare(`UPDATE radar_watchlists SET deleted_at = ? WHERE deleted_at IS NULL AND id LIKE 'wl-%' AND name IN (${V1_RADAR_NAMES.map(() => '?').join(', ')})`).bind(ts(0), ...V1_RADAR_NAMES));
  // Each keyword a millisecond apart, so the lists keep the order above.
  KEYWORD_UNIVERSE.forEach((k, i) => stmts.push(db.prepare('INSERT OR IGNORE INTO radar_keywords (id, keyword, tier, theme, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)').bind(id('kw'), k.keyword, k.tier, k.theme, ts(i), ts(i))));
  THEMES.forEach((t, i) => {
    const kws = KEYWORD_UNIVERSE.filter((k) => k.theme === t.id).map((k) => k.keyword);
    stmts.push(db.prepare('INSERT OR IGNORE INTO radar_watchlists (id, name, keywords_json, platforms_json, niche, country, since_days, enabled, created_at, updated_at, theme, min_faves) VALUES (?, ?, ?, ?, ?, NULL, ?, 1, ?, ?, ?, ?)')
      .bind(`theme-${t.id}`, t.name, JSON.stringify(kws), JSON.stringify(t.platforms), t.tier === 'in' ? 'in' : 'out', t.since_days, ts(i + 1), ts(i + 1), t.id, t.min_faves));
  });
  const m = META_ADS_RADAR;
  stmts.push(db.prepare('INSERT OR IGNORE INTO radar_watchlists (id, name, keywords_json, platforms_json, niche, country, since_days, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)')
    .bind('meta-ads-owners', m.name, JSON.stringify(m.keywords), JSON.stringify(['meta_ads']), m.niche, m.country, m.since_days, ts(THEMES.length + 1), ts(THEMES.length + 1)));
  for (const s of SUBREDDITS) stmts.push(db.prepare('INSERT OR IGNORE INTO radar_subreddits (name, niche, enabled, created_at) VALUES (?, ?, 1, ?)').bind(s.name, s.niche, ts(0)));
  for (const p of PUBLICATIONS) {
    const u = publicationUrl(p.url)!;
    stmts.push(db.prepare('INSERT OR IGNORE INTO radar_publications (id, url, name, niche, verified, enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)').bind(u.host, u.url, p.name, p.niche, p.verified ? 1 : 0, ts(0)));
  }
  stmts.push(db.prepare('INSERT INTO radar_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind('seed_v2', ts(0)));
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  return true;
}

// ───────────── the keyword universe ─────────────

export interface KeywordRow { id: string; keyword: string; tier: Tier; theme: string; enabled: number; created_at: string; updated_at: string }
export async function listKeywords(rt: Runtime): Promise<KeywordRow[]> {
  const { results } = await rt.env.DB.prepare('SELECT * FROM radar_keywords ORDER BY theme, tier, created_at, keyword').all<KeywordRow>();
  return results;
}

/** The enabled keywords of each theme. */
export async function themeKeywords(rt: Runtime): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const k of await listKeywords(rt)) if (k.enabled) out.set(k.theme, [...(out.get(k.theme) ?? []), k.keyword]);
  return out;
}

/** Copy each theme's enabled keywords into its radars (keywords_json stays the list every reader uses). */
export async function syncThemeRadars(rt: Runtime, theme?: string) {
  const map = await themeKeywords(rt);
  const { results } = await rt.env.DB.prepare('SELECT id, theme FROM radar_watchlists WHERE theme IS NOT NULL AND deleted_at IS NULL').all<{ id: string; theme: string }>();
  const ts = new Date().toISOString();
  const stmts = results.filter((r) => !theme || r.theme === theme)
    .map((r) => rt.env.DB.prepare('UPDATE radar_watchlists SET keywords_json = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(map.get(r.theme) ?? []), ts, r.id));
  if (stmts.length) await rt.env.DB.batch(stmts);
}

export const cleanKeyword = (v: unknown) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
export const cleanTheme = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

/** Add keywords (a list, or text with one per line or comma separated) to a theme. Returns how many were new. */
export async function addKeywords(rt: Runtime, themeIn: unknown, tierIn: unknown, list: unknown): Promise<{ added: number } | string> {
  const theme = cleanTheme(themeIn);
  if (!theme) return 'Pick a theme.';
  const tier: Tier = tierIn === 'adjacent' ? 'adjacent' : 'in';
  const raw = Array.isArray(list) ? list : String(list ?? '').split(/[\n,]+/);
  const kws = [...new Set(raw.map(cleanKeyword).filter(Boolean))].slice(0, 100);
  if (!kws.length) return 'Add at least one keyword.';
  const ts = new Date().toISOString();
  const res = await rt.env.DB.batch(kws.map((k) => rt.env.DB.prepare('INSERT OR IGNORE INTO radar_keywords (id, keyword, tier, theme, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)').bind(id('kw'), k, tier, theme, ts, ts)));
  await syncThemeRadars(rt, theme);
  return { added: res.reduce((n, r) => n + (r.meta?.changes ?? 0), 0) };
}

export async function updateKeyword(rt: Runtime, kid: string, b: Record<string, unknown>): Promise<boolean | string> {
  const old = await rt.env.DB.prepare('SELECT * FROM radar_keywords WHERE id = ?').bind(kid).first<KeywordRow>();
  if (!old) return false;
  const keyword = b.keyword !== undefined ? cleanKeyword(b.keyword) : old.keyword;
  if (!keyword) return 'A keyword cannot be blank.';
  const theme = b.theme !== undefined ? cleanTheme(b.theme) || old.theme : old.theme;
  const tier: Tier = b.tier === 'adjacent' || b.tier === 'in' ? b.tier : old.tier;
  const enabled = b.enabled === undefined ? old.enabled : b.enabled ? 1 : 0;
  try {
    await rt.env.DB.prepare('UPDATE radar_keywords SET keyword = ?, theme = ?, tier = ?, enabled = ?, updated_at = ? WHERE id = ?').bind(keyword, theme, tier, enabled, new Date().toISOString(), kid).run();
  } catch { return 'That keyword is already in this theme.'; }
  await syncThemeRadars(rt);
  return true;
}

export async function deleteKeyword(rt: Runtime, kid: string): Promise<boolean> {
  const r = await rt.env.DB.prepare('DELETE FROM radar_keywords WHERE id = ?').bind(kid).run();
  if (r.meta?.changes) await syncThemeRadars(rt);
  return Boolean(r.meta?.changes);
}

/** Make a radar for a theme that has keywords but no radar yet (a theme the owner added). */
export async function ensureThemeRadar(rt: Runtime, theme: string, tier: Tier, name?: string) {
  const has = await rt.env.DB.prepare('SELECT 1 FROM radar_watchlists WHERE theme = ? AND deleted_at IS NULL').bind(theme).first();
  if (has) return null;
  const def = themeDef(theme);
  const ts = new Date().toISOString();
  const rid = `theme-${theme}-${crypto.randomUUID().slice(0, 4)}`;
  const kws = (await themeKeywords(rt)).get(theme) ?? [];
  await rt.env.DB.prepare('INSERT INTO radar_watchlists (id, name, keywords_json, platforms_json, niche, since_days, enabled, created_at, updated_at, theme, min_faves) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)')
    .bind(rid, (name || def?.name || theme.replace(/_/g, ' ')).slice(0, 80), JSON.stringify(kws), JSON.stringify(def?.platforms ?? ['youtube', 'tiktok', 'instagram', 'x']), tier === 'in' ? 'in' : 'out', def?.since_days ?? 90, ts, ts, theme, def?.min_faves ?? defaultMinFaves(tier === 'in' ? 'in' : 'out')).run();
  return rid;
}

// ───────────── subreddits and publications ─────────────

export interface SubredditRow { name: string; niche: string; enabled: number; disabled_reason: string | null; last_run_at: string | null; created_at: string }
export interface PublicationRow { id: string; url: string; name: string; niche: string; verified: number; enabled: number; disabled_reason: string | null; median_interactions: number | null; last_run_at: string | null; created_at: string }

export async function listSubreddits(rt: Runtime): Promise<SubredditRow[]> {
  return (await rt.env.DB.prepare('SELECT * FROM radar_subreddits ORDER BY niche, name COLLATE NOCASE').all<SubredditRow>()).results;
}
export async function listPublications(rt: Runtime): Promise<PublicationRow[]> {
  return (await rt.env.DB.prepare('SELECT * FROM radar_publications ORDER BY niche, name COLLATE NOCASE').all<PublicationRow>()).results;
}

export async function addSubreddit(rt: Runtime, nameIn: unknown, niche: unknown): Promise<string | { name: string }> {
  const name = subredditName(String(nameIn ?? ''));
  if (!name) return 'Give a subreddit name, like r/smallbusiness.';
  await rt.env.DB.prepare('INSERT INTO radar_subreddits (name, niche, enabled, created_at) VALUES (?, ?, 1, ?) ON CONFLICT(name) DO UPDATE SET enabled = 1, disabled_reason = NULL')
    .bind(name, niche === 'out' ? 'out' : 'in', new Date().toISOString()).run();
  return { name };
}
export async function setSubreddit(rt: Runtime, name: string, b: Record<string, unknown>) {
  const sets: string[] = []; const args: unknown[] = [];
  if (b.enabled !== undefined) { sets.push('enabled = ?', 'disabled_reason = CASE WHEN ? = 1 THEN NULL ELSE disabled_reason END'); args.push(b.enabled ? 1 : 0, b.enabled ? 1 : 0); }
  if (b.niche === 'in' || b.niche === 'out') { sets.push('niche = ?'); args.push(b.niche); }
  if (!sets.length) return false;
  const r = await rt.env.DB.prepare(`UPDATE radar_subreddits SET ${sets.join(', ')} WHERE name = ?`).bind(...args, name).run();
  return Boolean(r.meta?.changes);
}
export async function deleteSubreddit(rt: Runtime, name: string) {
  return Boolean((await rt.env.DB.prepare('DELETE FROM radar_subreddits WHERE name = ?').bind(name).run()).meta?.changes);
}

export async function addPublication(rt: Runtime, urlIn: unknown, nameIn: unknown, niche: unknown): Promise<string | { id: string }> {
  const u = publicationUrl(String(urlIn ?? ''));
  if (!u) return 'Give the publication\'s address, like name.substack.com or its own domain.';
  const name = String(nameIn ?? '').trim().slice(0, 80) || u.host.replace(/^www\./, '').replace(/\.substack\.com$/, '');
  await rt.env.DB.prepare('INSERT INTO radar_publications (id, url, name, niche, verified, enabled, created_at) VALUES (?, ?, ?, ?, 0, 1, ?) ON CONFLICT(id) DO UPDATE SET enabled = 1, disabled_reason = NULL, name = excluded.name')
    .bind(u.host, u.url, name, niche === 'in' ? 'in' : 'out', new Date().toISOString()).run();
  return { id: u.host };
}
export async function setPublication(rt: Runtime, pid: string, b: Record<string, unknown>) {
  const sets: string[] = []; const args: unknown[] = [];
  if (b.enabled !== undefined) { sets.push('enabled = ?', 'disabled_reason = CASE WHEN ? = 1 THEN NULL ELSE disabled_reason END'); args.push(b.enabled ? 1 : 0, b.enabled ? 1 : 0); }
  if (b.niche === 'in' || b.niche === 'out') { sets.push('niche = ?'); args.push(b.niche); }
  if (typeof b.name === 'string' && b.name.trim()) { sets.push('name = ?'); args.push(b.name.trim().slice(0, 80)); }
  if (!sets.length) return false;
  const r = await rt.env.DB.prepare(`UPDATE radar_publications SET ${sets.join(', ')} WHERE id = ?`).bind(...args, pid).run();
  return Boolean(r.meta?.changes);
}
export async function deletePublication(rt: Runtime, pid: string) {
  return Boolean((await rt.env.DB.prepare('DELETE FROM radar_publications WHERE id = ?').bind(pid).run()).meta?.changes);
}

export const keywordPlatforms = KEYWORD_PLATFORMS;
