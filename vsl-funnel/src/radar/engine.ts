/**
 * Radar: the engine. Watchlists queue Monid runs (budget checked before anything starts), the cron and the
 * "Run now" button advance them in short steps (start what is pending, poll what is running, never a long wait),
 * results are normalised into radar_items and scored, transcripts are fetched per item, and the weekly digest is
 * built from what was analysed. Instagram (public reels only, owner-approved) runs unless RADAR_INSTAGRAM is off.
 */
import type { Runtime } from '../app';
import { flag } from '../settings';
import { type MonidClient, MonidError, type MonidRun, RUN_DONE, estimateMicros, monidClient, parsePrice } from './monid';
import { type RadarItem, SOURCE_PLATFORMS, median, metricOf, nextCursorOf, normalise, scoreItem, transcriptSegments, transcriptText } from './normalise';
import { DEFAULT_TOOLS, KEYWORD_PLATFORMS, PLATFORMS, type Platform, type RadarQuery, type Slot, builtinFor, isTextPlatform, mapInput, searchSlot, slotDef, transcriptSlot } from './sources';
import { defaultMinFaves, platformsOff, seedV2, themeKeywords } from './universe';

// ───────────── settings ─────────────

export interface RadarConfig { key: boolean; budgetMicros: number; budgetUsd: number; maxItems: number; instagram: boolean; scheduleHours: number; pages: number; autoTranscribe: number }
export function radarConfig(rt: Pick<Runtime, 'settings'>): RadarConfig {
  const s = rt.settings;
  const num = (v: string | undefined, d: number) => (v != null && v.trim() !== '' && isFinite(Number(v)) ? Number(v) : d);
  const budgetUsd = Math.max(0, num(s.RADAR_BUDGET_USD_MONTH, 60));
  return {
    key: Boolean(s.MONID_API_KEY),
    budgetUsd,
    budgetMicros: Math.round(budgetUsd * 1_000_000),
    maxItems: Math.max(1, Math.min(100, Math.round(num(s.RADAR_MAX_ITEMS, 15)))),
    instagram: flag(s.RADAR_INSTAGRAM, true),
    scheduleHours: Math.max(0, Math.min(24 * 14, num(s.RADAR_SCHEDULE_HOURS, 24))),
    // Radar v2: pages per search (following nextCursor) and how many new videos a sweep transcribes (0 = off).
    pages: Math.max(1, Math.min(10, Math.round(num(s.RADAR_PAGES, 2)))),
    autoTranscribe: Math.max(0, Math.min(300, Math.round(num(s.RADAR_AUTO_TRANSCRIBE, 30)))),
  };
}

export const RADAR_COPY = {
  noKey: 'Radar needs a Monid API key. Add it in Integrations under Radar.',
  instagramOff: 'Instagram is switched off in Integrations (RADAR_INSTAGRAM), so no Instagram run starts. Turn it back on there to research public reels.',
  budget: 'This month\'s Radar budget is used up, so nothing new starts until next month or until the budget is raised in Integrations.',
  budgetWouldPass: 'This run would take the month past the Radar budget, so it did not start.',
  noSource: (label: string) => `Pick a source for ${label} first (Sources, Find sources).`,
  notConfirmed: (label: string) => `Confirm the input for ${label} before its first paid run (Sources).`,
  noTranscriptSource: 'There is no transcript source for this platform. The captions from the scraper are used when there are any.',
  noKeywords: (name: string) => `${name} has no keywords switched on, so it has nothing to search.`,
  textPost: 'This is a text post: its full text is its transcript, so there is nothing to transcribe.',
  platformOff: (label: string) => `${label} is switched off in Sources and sweeps, so no run starts for it.`,
  retention: 'Drop-off points are estimates from the structure and the engagement numbers. No service gives another creator\'s real retention curve.',
  adSpend: 'Meta shows no spend for commercial ads, so days active and the number of variants stand in for performance.',
};

// ───────────── money ─────────────

const monthStart = (now = Date.now()) => { const d = new Date(now); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(); };

/** This month's spend: what Monid billed, plus the estimate of anything still pending or running. */
export async function monthSpend(rt: Runtime, now = Date.now()): Promise<{ spent: number; reserved: number; committed: number; runs: number }> {
  const r = await rt.env.DB.prepare(
    `SELECT COALESCE(SUM(CASE WHEN status IN ('completed','failed') THEN cost_micros ELSE 0 END), 0) AS spent,
            COALESCE(SUM(CASE WHEN status IN ('pending','running') THEN est_micros ELSE 0 END), 0) AS reserved,
            COUNT(*) AS runs
       FROM radar_runs WHERE created_at >= ? AND status != 'skipped'`,
  ).bind(monthStart(now)).first<{ spent: number; reserved: number; runs: number }>();
  const spent = Number(r?.spent ?? 0), reserved = Number(r?.reserved ?? 0);
  return { spent, reserved, committed: spent + reserved, runs: Number(r?.runs ?? 0) };
}

// ───────────── the source map ─────────────

export interface ToolRow {
  slot: Slot; provider: string; endpoint: string; name: string | null; description: string | null; price_json: string | null; schema_json: string | null;
  doc_url: string | null; recommended: number; selected: number; template_json: string | null; confirmed_at: string | null; found_at: string;
}
const parse = <T>(s: string | null | undefined, d: T): T => { try { return s ? (JSON.parse(s) as T) : d; } catch { return d; } };

export async function selectedTool(rt: Runtime, slot: Slot): Promise<ToolRow | null> {
  return rt.env.DB.prepare('SELECT * FROM radar_tools WHERE slot = ? AND selected = 1 LIMIT 1').bind(slot).first<ToolRow>();
}

/** The exact input(s) a tool would get for a query, with what each field means and the cost estimate. */
export function previewFor(tool: ToolRow, q: RadarQuery) {
  const m = mapInput(tool.slot, parse(tool.schema_json, null), q, parse<Record<string, unknown> | null>(tool.template_json, null), tool);
  const price = parsePrice(parse(tool.price_json, null));
  // Per input: a matrix price follows the route the input picks (or the route Monid picked on real runs when the
  // input names none); a per-result price counts what the input asks for.
  const bi = builtinFor(tool.provider, tool.endpoint, tool.slot);
  const units = bi?.units?.(q);
  const est_each = m.inputs.map((input) => {
    const asked = units ?? Number(input.count ?? input.limit ?? input.maxResults ?? input.maxItems);
    return estimateMicros(price, isFinite(asked) && asked > 0 ? asked : q.max, input.route == null && bi?.route ? { ...input, route: bi.route } : input);
  });
  return { ...m, price, est_each, est_micros: est_each.reduce((a, b) => a + b, 0) };
}

// ───────────── watchlists ─────────────

export interface Watchlist {
  id: string; name: string; keywords: string[]; platforms: Platform[]; niche: 'in' | 'out'; country: string | null; since_days: number | null; enabled: boolean; last_run_at: string | null; created_at: string; updated_at: string;
  /** Radar v2: the theme whose keywords it searches (null = its own keywords), X's min_faves floor and a pages override. */
  theme?: string | null; min_faves?: number | null; pages?: number | null;
}
export interface WlRow { id: string; name: string; keywords_json: string; platforms_json: string; niche: string; country: string | null; since_days: number | null; enabled: number; last_run_at: string | null; created_at: string; updated_at: string; theme?: string | null; min_faves?: number | null; pages?: number | null }
export const toWl = (r: WlRow): Watchlist => ({
  id: r.id, name: r.name, keywords: parse<string[]>(r.keywords_json, []), platforms: parse<string[]>(r.platforms_json, []).filter((p): p is Platform => (PLATFORMS as readonly string[]).includes(p)),
  niche: r.niche === 'out' ? 'out' : 'in', country: r.country, since_days: r.since_days, enabled: Boolean(r.enabled), last_run_at: r.last_run_at, created_at: r.created_at, updated_at: r.updated_at,
  theme: r.theme ?? null, min_faves: r.min_faves ?? null, pages: r.pages ?? null,
});
/**
 * Seeds the default tool of every slot that has no pick yet (selected, and confirmed: their built-in inputs are the
 * ones verified against Monid in production, so the owner can press Run; the Sources tab still shows each exact input
 * and its cost), then the default watchlists once (never again after the owner deletes them).
 */
export async function ensureSeeded(rt: Runtime) {
  const { results: rows } = await rt.env.DB.prepare('SELECT slot, provider, endpoint, selected, confirmed_at, template_json, price_json FROM radar_tools').all<{ slot: string; provider: string; endpoint: string; selected: number; confirmed_at: string | null; template_json: string | null; price_json: string | null }>();
  const ts = new Date().toISOString();
  const seed = DEFAULT_TOOLS.flatMap((t) => {
    const row = rows.find((r) => r.slot === t.slot && r.provider === t.provider && r.endpoint === t.endpoint);
    const slotPicked = rows.some((r) => r.slot === t.slot && r.selected);
    const price = t.price ? JSON.stringify(t.price) : null;
    // A slot with no pick gets its default, ready to run.
    if (!row && !slotPicked) {
      return [rt.env.DB.prepare('INSERT INTO radar_tools (slot, provider, endpoint, name, price_json, recommended, selected, confirmed_at, found_at) VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)').bind(t.slot, t.provider, t.endpoint, t.name, price, ts, ts)];
    }
    if (!row) return [];
    // The default already listed: picked when its slot has no pick; confirmed when picked with the built-in input
    // (no template of the owner's); the listed price when it has none.
    const pick = !slotPicked || row.selected;
    const confirm = pick && !row.confirmed_at && !row.template_json;
    if ((pick && !row.selected) || confirm || (!row.price_json && price)) {
      return [rt.env.DB.prepare('UPDATE radar_tools SET selected = ?, recommended = 1, confirmed_at = COALESCE(confirmed_at, ?), price_json = COALESCE(price_json, ?) WHERE slot = ? AND provider = ? AND endpoint = ?')
        .bind(pick ? 1 : 0, confirm ? ts : null, price, t.slot, t.provider, t.endpoint)];
    }
    return [];
  });
  if (seed.length) await rt.env.DB.batch(seed);
  // Radar v2: the keyword universe, the themed radars, subreddits and publications, once (the v1 radars retire).
  await seedV2(rt);
}

export async function listWatchlists(rt: Runtime): Promise<Watchlist[]> {
  const { results } = await rt.env.DB.prepare('SELECT * FROM radar_watchlists WHERE deleted_at IS NULL ORDER BY created_at, name').all<WlRow>();
  return results.map(toWl);
}
export async function getWatchlist(rt: Runtime, id: string): Promise<Watchlist | null> {
  const r = await rt.env.DB.prepare('SELECT * FROM radar_watchlists WHERE id = ? AND deleted_at IS NULL').bind(id).first<WlRow>();
  return r ? toWl(r) : null;
}

/** Clean a watchlist from the browser. A themed radar's keywords come from the keyword universe. */
export function cleanWatchlist(b: Record<string, unknown>): Omit<Watchlist, 'id' | 'last_run_at' | 'created_at' | 'updated_at'> | string {
  const name = String(b.name ?? '').trim().slice(0, 80);
  const kwIn = Array.isArray(b.keywords) ? b.keywords : String(b.keywords ?? '').split(/[\n,]+/);
  const keywords = [...new Set(kwIn.map((k) => String(k).trim().slice(0, 80)).filter(Boolean))].slice(0, 60);
  // Substack is read from the publication list, never searched by keyword.
  const platforms = [...new Set((Array.isArray(b.platforms) ? b.platforms : []).map(String))].filter((p): p is Platform => (KEYWORD_PLATFORMS as readonly string[]).includes(p));
  const theme = typeof b.theme === 'string' && /^[a-z0-9_]{1,40}$/.test(b.theme) ? b.theme : null;
  if (!name) return 'Give the radar a name.';
  if (!keywords.length && !theme) return 'Add at least one keyword.';
  if (!platforms.length) return 'Pick at least one platform.';
  const country = String(b.country ?? '').trim().toUpperCase();
  const since = Number(b.since_days);
  const faves = Number(b.min_faves);
  const pages = Number(b.pages);
  return {
    name, keywords, platforms, niche: b.niche === 'out' ? 'out' : 'in',
    country: /^[A-Z]{2}$/.test(country) ? country : null,
    since_days: isFinite(since) && since > 0 ? Math.min(3650, Math.round(since)) : null,
    enabled: b.enabled !== false,
    theme,
    min_faves: b.min_faves !== '' && b.min_faves != null && isFinite(faves) && faves >= 0 ? Math.min(1_000_000, Math.round(faves)) : null,
    pages: b.pages !== '' && b.pages != null && isFinite(pages) && pages >= 1 ? Math.min(10, Math.round(pages)) : null,
  };
}

// ───────────── runs ─────────────

export interface QueueResult { queued: number; est_micros: number; notes: string[] }

export interface RunMeta { sweep_id?: string | null; page?: number; query?: string | null; source_ref?: string | null }
export async function insertRun(rt: Runtime, x: { watchlist_id?: string | null; item_id?: string | null; slot: Slot; tool: Pick<ToolRow, 'provider' | 'endpoint'>; input: unknown; est: number; status?: string; error?: string } & RunMeta) {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await rt.env.DB.prepare(
    'INSERT INTO radar_runs (id, watchlist_id, item_id, slot, provider, endpoint, input_json, status, est_micros, error, created_at, updated_at, sweep_id, page, query, source_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(id, x.watchlist_id ?? null, x.item_id ?? null, x.slot, x.tool.provider, x.tool.endpoint, JSON.stringify(x.input), x.status ?? 'pending', x.est, x.error ?? null, now, now,
    x.sweep_id ?? null, x.page ?? 1, x.query?.slice(0, 600) ?? null, x.source_ref ?? null).run();
  return id;
}

/** The text an input searches for (shown on the run and kept on the items it finds). */
export function queryOf(input: Record<string, unknown>): string | null {
  const v = input.query ?? input.searchQueries ?? input.subreddit ?? input.url ?? input.keyword;
  return Array.isArray(v) ? v.map(String).join(', ').slice(0, 600) : v == null ? null : String(v).slice(0, 600);
}

/** A watchlist's query for the platform: all of its keywords (themed radars read the universe), X's min_faves floor. */
export async function queryFor(rt: Runtime, wl: Watchlist, cfg: RadarConfig): Promise<RadarQuery> {
  const keywords = wl.theme ? (await themeKeywords(rt)).get(wl.theme) ?? wl.keywords : wl.keywords;
  return { keywords, max: cfg.maxItems, sinceDays: wl.since_days, country: wl.country, maxKeywords: 60, minFaves: wl.min_faves ?? defaultMinFaves(wl.niche) };
}

/** Queue one watchlist's runs: one per platform (or per keyword when a tool takes one search at a time). */
export async function queueWatchlist(rt: Runtime, wl: Watchlist, now = Date.now(), meta: RunMeta = {}): Promise<QueueResult> {
  const cfg = radarConfig(rt);
  const out: QueueResult = { queued: 0, est_micros: 0, notes: [] };
  if (!cfg.key) { out.notes.push(RADAR_COPY.noKey); return out; }
  let { committed } = await monthSpend(rt, now);
  if (committed >= cfg.budgetMicros) { out.notes.push(RADAR_COPY.budget); return out; }
  const off = await platformsOff(rt);
  const q = await queryFor(rt, wl, cfg);
  if (!q.keywords.length) { out.notes.push(RADAR_COPY.noKeywords(wl.name)); return out; }
  for (const p of wl.platforms) {
    if (p === 'instagram' && !cfg.instagram) { out.notes.push(RADAR_COPY.instagramOff); continue; }
    const slot = searchSlot(p);
    const label = slotDef(slot)!.label;
    if (off.has(p)) { out.notes.push(RADAR_COPY.platformOff(label)); continue; }
    if (p === 'substack') continue;
    const tool = await selectedTool(rt, slot);
    if (!tool) { out.notes.push(RADAR_COPY.noSource(label)); continue; }
    if (!tool.confirmed_at) { out.notes.push(RADAR_COPY.notConfirmed(label)); continue; }
    const pv = previewFor(tool, q);
    for (const [i, input] of pv.inputs.entries()) {
      const per = pv.est_each[i] ?? 0;
      if (committed + per > cfg.budgetMicros) { out.notes.push(RADAR_COPY.budgetWouldPass); break; }
      await insertRun(rt, { watchlist_id: wl.id, slot, tool, input, est: per, sweep_id: meta.sweep_id, page: 1, query: queryOf(input) });
      committed += per; out.est_micros += per; out.queued++;
    }
  }
  await rt.env.DB.prepare('UPDATE radar_watchlists SET last_run_at = ? WHERE id = ?').bind(new Date(now).toISOString(), wl.id).run();
  return out;
}

/** Queue a transcript run for one item (YouTube and TikTok). */
export async function queueTranscript(rt: Runtime, itemId: string, now = Date.now(), meta: RunMeta = {}): Promise<{ ok: boolean; note?: string; est_micros?: number }> {
  const cfg = radarConfig(rt);
  const item = await rt.env.DB.prepare('SELECT id, platform, url, duration_s FROM radar_items WHERE id = ?').bind(itemId).first<{ id: string; platform: Platform; url: string | null; duration_s: number | null }>();
  if (!item) return { ok: false, note: 'That item is not there any more.' };
  if (isTextPlatform(item.platform)) return { ok: false, note: RADAR_COPY.textPost };
  if (!cfg.key) return { ok: false, note: RADAR_COPY.noKey };
  const slot = transcriptSlot(item.platform);
  const tool = slot ? await selectedTool(rt, slot) : null;
  if (!slot || !tool || !item.url) return { ok: false, note: RADAR_COPY.noTranscriptSource };
  if (!tool.confirmed_at) return { ok: false, note: RADAR_COPY.notConfirmed(slotDef(slot)!.label) };
  if (item.platform === 'instagram' && !cfg.instagram) return { ok: false, note: RADAR_COPY.instagramOff };
  const pv = previewFor(tool, { keywords: [], max: 1, urls: [item.url], durationS: item.duration_s });
  const { committed } = await monthSpend(rt, now);
  if (committed + pv.est_micros > cfg.budgetMicros) return { ok: false, note: committed >= cfg.budgetMicros ? RADAR_COPY.budget : RADAR_COPY.budgetWouldPass };
  await insertRun(rt, { item_id: item.id, slot, tool, input: pv.inputs[0], est: pv.est_micros, sweep_id: meta.sweep_id, query: item.url });
  await rt.env.DB.prepare('UPDATE radar_items SET transcript_source = ? WHERE id = ?').bind('pending', item.id).run();
  return { ok: true, est_micros: pv.est_micros };
}

interface RunRow {
  id: string; watchlist_id: string | null; item_id: string | null; slot: Slot; provider: string; endpoint: string; input_json: string; monid_run_id: string | null; status: string; est_micros: number; polls: number; created_at: string;
  sweep_id?: string | null; page?: number | null; query?: string | null; source_ref?: string | null;
}

/** The subreddit or publication a source run read: disabled with the provider's message when the fetch failed. */
async function sourceFailed(rt: Runtime, run: RunRow, message: string) {
  if (!run.source_ref) return;
  const msg = message.slice(0, 300);
  if (run.slot === 'substack:posts') await rt.env.DB.prepare('UPDATE radar_publications SET enabled = 0, disabled_reason = ? WHERE id = ?').bind(msg, run.source_ref).run();
  // A subreddit is only switched off when the provider refused it (a 4xx), never for a passing outage.
  if (run.slot === 'reddit:subreddit' && /\b4\d\d\b|not found|private|banned|invalid/i.test(message)) await rt.env.DB.prepare('UPDATE radar_subreddits SET enabled = 0, disabled_reason = ? WHERE name = ?').bind(msg, run.source_ref).run();
}

/** Queue the next page of a search that has one (nextCursor), up to the radar's or RADAR_PAGES pages, within budget. */
async function queueNextPage(rt: Runtime, run: RunRow, output: unknown, saved: number, now: number): Promise<boolean> {
  const cursor = nextCursorOf(output);
  const page = run.page ?? 1;
  if (!cursor || saved === 0 || run.item_id) return false;
  const bi = builtinFor(run.provider, run.endpoint, run.slot);
  if (!bi?.pages) return false;
  const cfg = radarConfig(rt);
  const wl = run.watchlist_id ? await getWatchlist(rt, run.watchlist_id) : null;
  const max = wl?.pages ?? cfg.pages;
  if (page >= max) return false;
  const { committed } = await monthSpend(rt, now);
  if (committed + run.est_micros > cfg.budgetMicros) return false;
  const input = { ...parse<Record<string, unknown>>(run.input_json, {}), cursor };
  await insertRun(rt, { watchlist_id: run.watchlist_id, slot: run.slot, tool: run, input, est: run.est_micros, sweep_id: run.sweep_id, page: page + 1, query: run.query, source_ref: run.source_ref });
  return true;
}

async function finishRun(rt: Runtime, run: RunRow, r: MonidRun, now: number, touched?: Set<Platform>) {
  const cost = r.costMicros ?? run.est_micros;
  const estimated = r.costMicros == null ? 1 : 0;
  const ts = new Date(now).toISOString();
  if (r.status !== 'COMPLETED') {
    const err = `Monid: ${r.status}${r.error ? `, ${r.error.slice(0, 300)}` : ''}`;
    await rt.env.DB.prepare('UPDATE radar_runs SET status = ?, cost_micros = ?, cost_estimated = ?, error = ?, updated_at = ? WHERE id = ?')
      .bind('failed', r.costMicros ?? 0, 0, err, ts, run.id).run();
    if (run.item_id) await rt.env.DB.prepare("UPDATE radar_items SET transcript_source = CASE WHEN transcript IS NULL THEN 'missing' ELSE transcript_source END WHERE id = ?").bind(run.item_id).run();
    if ((run.page ?? 1) === 1) await sourceFailed(rt, run, r.error || err);
    return;
  }
  const def = slotDef(run.slot)!;
  let saved = 0;
  if (def.kind === 'transcript' && run.item_id) {
    const text = transcriptText(r.output);
    const segs = transcriptSegments(r.output);
    await rt.env.DB.prepare('UPDATE radar_items SET transcript = COALESCE(?, transcript), transcript_segments = COALESCE(?, transcript_segments), transcribed_at = CASE WHEN ? IS NOT NULL THEN ? ELSE transcribed_at END, transcript_source = CASE WHEN ? IS NOT NULL THEN \'monid\' WHEN transcript IS NULL THEN \'missing\' ELSE transcript_source END WHERE id = ?')
      .bind(text, segs.length ? JSON.stringify(segs) : null, text, ts, text, run.item_id).run();
    saved = text ? 1 : 0;
    // A transcript tool that also returns the video's numbers (the YouTube one gives likes, comments and subscribers,
    // which YouTube search does not) fills them in, and the platform is re-scored.
    const item = await rt.env.DB.prepare('SELECT external_id FROM radar_items WHERE id = ?').bind(run.item_id).first<{ external_id: string }>();
    const stats = item ? normalise(def.platform, r.output, now).find((x) => x.external_id === item.external_id) : undefined;
    if (stats && (stats.likes != null || stats.comments != null || stats.followers != null)) {
      await rt.env.DB.prepare('UPDATE radar_items SET views = COALESCE(?, views), likes = COALESCE(?, likes), comments = COALESCE(?, comments), followers = COALESCE(?, followers), duration_s = COALESCE(duration_s, ?) WHERE id = ?')
        .bind(stats.views, stats.likes, stats.comments, stats.followers, stats.duration_s, run.item_id).run();
      if (touched) touched.add(def.platform); else await rescore(rt, def.platform, now);
    }
  } else {
    const wl = run.watchlist_id ? await getWatchlist(rt, run.watchlist_id) : null;
    const items = normalise(def.platform, r.output, now);
    // Items from the subreddit or publication lists take that source's niche.
    const srcNiche = run.source_ref && !wl ? await sourceNiche(rt, run) : null;
    for (const it of items) await upsertItem(rt, it, wl, now, { query: run.query ?? null, niche: srcNiche });
    if (items.length) { if (touched) touched.add(def.platform); else await rescore(rt, def.platform, now); }
    saved = items.length;
    if (run.slot === 'substack:posts' && run.source_ref && items.length) await rt.env.DB.prepare('UPDATE radar_publications SET verified = 1, disabled_reason = NULL WHERE id = ?').bind(run.source_ref).run();
    await queueNextPage(rt, run, r.output, saved, now);
  }
  await rt.env.DB.prepare('UPDATE radar_runs SET status = ?, cost_micros = ?, cost_estimated = ?, result_count = ?, items_saved = ?, error = NULL, updated_at = ? WHERE id = ?')
    .bind('completed', cost, estimated, r.resultCount, saved, ts, run.id).run();
}

/**
 * One short step of the engine: start pending runs (budget re-checked), then poll the running ones that are due.
 * Stops when `budgetMs` is used, so a request or a cron job stays short.
 */
async function sourceNiche(rt: Runtime, run: RunRow): Promise<'in' | 'out' | null> {
  const r = run.slot === 'substack:posts'
    ? await rt.env.DB.prepare('SELECT niche FROM radar_publications WHERE id = ?').bind(run.source_ref).first<{ niche: string }>()
    : await rt.env.DB.prepare('SELECT niche FROM radar_subreddits WHERE name = ?').bind(run.source_ref).first<{ niche: string }>();
  return r ? (r.niche === 'out' ? 'out' : 'in') : null;
}

/**
 * One short step of the engine: start pending runs (budget re-checked), then poll the running ones that are due.
 * Stops when `budgetMs` is used, so a request or a cron job stays short. Platforms are re-scored once at the end of the
 * step, not after every run (a sweep finishes hundreds of runs).
 */
export async function radarStep(rt: Runtime, opts: { client?: MonidClient; now?: number; budgetMs?: number; maxStart?: number } = {}) {
  const touched = new Set<Platform>();
  const out = await stepRuns(rt, opts, touched);
  for (const p of touched) await rescore(rt, p, opts.now ?? Date.now());
  return out;
}

async function stepRuns(rt: Runtime, opts: { client?: MonidClient; now?: number; budgetMs?: number; maxStart?: number }, touched: Set<Platform>) {
  const cfg = radarConfig(rt);
  const out = { started: 0, completed: 0, failed: 0, polled: 0, skipped: 0 };
  if (!cfg.key && !opts.client) return out;
  const client = opts.client ?? monidClient(rt.settings.MONID_API_KEY);
  const t0 = Date.now();
  const left = () => Date.now() - t0 < (opts.budgetMs ?? 20_000);
  const now = () => opts.now ?? Date.now();
  const off = await platformsOff(rt);

  const { results: pending } = await rt.env.DB.prepare("SELECT * FROM radar_runs WHERE status = 'pending' ORDER BY created_at LIMIT ?").bind(Math.max(1, Math.min(200, opts.maxStart ?? 8))).all<RunRow>();
  for (const run of pending) {
    if (!left()) break;
    const slot = slotDef(run.slot);
    const ts = new Date(now()).toISOString();
    if (slot?.platform === 'instagram' && !cfg.instagram) {
      await rt.env.DB.prepare("UPDATE radar_runs SET status = 'skipped', est_micros = 0, error = ?, updated_at = ? WHERE id = ?").bind(RADAR_COPY.instagramOff, ts, run.id).run();
      out.skipped++; continue;
    }
    if (slot && off.has(slot.platform)) {
      await rt.env.DB.prepare("UPDATE radar_runs SET status = 'skipped', est_micros = 0, error = ?, updated_at = ? WHERE id = ?").bind(RADAR_COPY.platformOff(slot.label), ts, run.id).run();
      out.skipped++; continue;
    }
    const { committed } = await monthSpend(rt, now());
    if (committed > cfg.budgetMicros || committed - run.est_micros >= cfg.budgetMicros) {
      await rt.env.DB.prepare("UPDATE radar_runs SET status = 'skipped', est_micros = 0, error = ?, updated_at = ? WHERE id = ?").bind(RADAR_COPY.budget, ts, run.id).run();
      out.skipped++; continue;
    }
    // Claim it before calling out, so a second step running at the same time can't start it twice.
    const claim = await rt.env.DB.prepare("UPDATE radar_runs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'pending'").bind(ts, run.id).run();
    if (!(claim.meta?.changes ?? 0)) continue;
    try {
      const r = await client.run(run.provider, run.endpoint, JSON.parse(run.input_json));
      out.started++;
      if (RUN_DONE.has(r.status)) { await finishRun(rt, run, r, now(), touched); if (r.status === 'COMPLETED') out.completed++; else out.failed++; }
      else await rt.env.DB.prepare('UPDATE radar_runs SET monid_run_id = ?, next_poll_at = ?, updated_at = ? WHERE id = ?').bind(r.runId, new Date(now() + 30_000).toISOString(), ts, run.id).run();
    } catch (e) {
      const msg = e instanceof MonidError ? e.message : `The run could not start: ${String((e as Error)?.message ?? e).slice(0, 200)}`;
      // A timeout may still have started the run on Monid's side; keep its estimate as the cost so the budget stays safe.
      const timedOut = (e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError';
      await rt.env.DB.prepare("UPDATE radar_runs SET status = 'failed', cost_micros = ?, cost_estimated = ?, error = ?, updated_at = ? WHERE id = ?").bind(timedOut ? run.est_micros : 0, timedOut ? 1 : 0, msg, ts, run.id).run();
      // The provider refusing a subreddit or a publication switches that source off with its message.
      if (e instanceof MonidError && e.status >= 400 && e.status < 500 && ![401, 402, 403, 429].includes(e.status)) await sourceFailed(rt, run, msg);
      out.failed++;
    }
  }

  const { results: running } = await rt.env.DB.prepare("SELECT * FROM radar_runs WHERE status = 'running' AND monid_run_id IS NOT NULL AND (next_poll_at IS NULL OR next_poll_at <= ?) ORDER BY next_poll_at LIMIT ?").bind(new Date(now()).toISOString(), Math.max(12, Math.min(200, (opts.maxStart ?? 8) * 2))).all<RunRow>();
  for (const run of running) {
    if (!left()) break;
    const ts = new Date(now()).toISOString();
    try {
      const r = await client.getRun(run.monid_run_id!);
      out.polled++;
      if (RUN_DONE.has(r.status)) { await finishRun(rt, run, r, now(), touched); if (r.status === 'COMPLETED') out.completed++; else out.failed++; continue; }
      const age = now() - Date.parse(run.created_at);
      if (age > 24 * 3600_000) {
        await rt.env.DB.prepare("UPDATE radar_runs SET status = 'failed', cost_micros = est_micros, cost_estimated = 1, error = ?, updated_at = ? WHERE id = ?").bind('Still running after a day, so Radar stopped waiting for it.', ts, run.id).run();
        out.failed++; continue;
      }
      const wait = Math.min(10 * 60_000, 30_000 * (run.polls + 1));
      await rt.env.DB.prepare('UPDATE radar_runs SET polls = polls + 1, next_poll_at = ?, updated_at = ? WHERE id = ?').bind(new Date(now() + wait).toISOString(), ts, run.id).run();
    } catch (e) {
      const wait = Math.min(30 * 60_000, 60_000 * (run.polls + 1));
      await rt.env.DB.prepare('UPDATE radar_runs SET polls = polls + 1, next_poll_at = ?, error = ?, updated_at = ? WHERE id = ?').bind(new Date(now() + wait).toISOString(), `Checking the run failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`, ts, run.id).run();
    }
  }
  return out;
}

// ───────────── items ─────────────

export async function upsertItem(rt: Runtime, it: RadarItem, wl: Watchlist | null, now = Date.now(), extra: { query?: string | null; niche?: 'in' | 'out' | null } = {}) {
  const ts = new Date(now).toISOString();
  const old = await rt.env.DB.prepare('SELECT radar_ids, niche, transcript FROM radar_items WHERE id = ?').bind(it.id).first<{ radar_ids: string; niche: string | null; transcript: string | null }>();
  const ids = new Set(parse<string[]>(old?.radar_ids, []));
  if (wl) ids.add(wl.id);
  const found = wl?.niche ?? extra.niche ?? null;
  const niche = !found ? old?.niche ?? null : !old?.niche || old.niche === found ? found : 'both';
  const raw = JSON.stringify(it.raw).slice(0, 60_000);
  // A text post's body is its transcript: nothing to fetch.
  const text = isTextPlatform(it.platform);
  const query = extra.query ?? null;
  if (old) {
    await rt.env.DB.prepare(
      `UPDATE radar_items SET url = COALESCE(?, url), author = COALESCE(?, author), title = COALESCE(?, title), caption = COALESCE(?, caption),
         views = COALESCE(?, views), likes = COALESCE(?, likes), comments = COALESCE(?, comments), shares = COALESCE(?, shares), followers = COALESCE(?, followers),
         thumbnail_url = COALESCE(?, thumbnail_url), media_url = COALESCE(?, media_url), media_kind = COALESCE(?, media_kind),
         ad_end = COALESCE(?, ad_end), ad_active = COALESCE(?, ad_active), ad_active_days = COALESCE(?, ad_active_days), ad_variants = COALESCE(?, ad_variants),
         transcript = CASE WHEN transcript IS NULL AND ? IS NOT NULL THEN ? ELSE transcript END,
         transcript_source = CASE WHEN transcript IS NULL AND ? IS NOT NULL THEN 'captions' ELSE transcript_source END,
         body_text = COALESCE(?, body_text), bookmarks = COALESCE(?, bookmarks), saves = COALESCE(?, saves), reposts = COALESCE(?, reposts),
         source_ref = COALESCE(?, source_ref), query = COALESCE(?, query),
         niche = ?, radar_ids = ?, raw_json = ?, last_seen = ? WHERE id = ?`,
    ).bind(it.url, it.author, it.title, it.caption, it.views, it.likes, it.comments, it.shares, it.followers, it.thumbnail_url, it.media_url, it.media_kind,
      it.ad_end, it.ad_active, it.ad_active_days, it.ad_variants, it.captions, it.captions, it.captions,
      it.body_text, it.bookmarks, it.saves, it.reposts, it.source_ref, query,
      niche, JSON.stringify([...ids]), raw, ts, it.id).run();
    return 'updated' as const;
  }
  await rt.env.DB.prepare(
    `INSERT INTO radar_items (id, platform, external_id, url, author, author_id, title, caption, published_at, duration_s, views, likes, comments, shares, followers,
       thumbnail_url, embed_url, media_url, media_kind, ad_start, ad_end, ad_active, ad_active_days, ad_variants, ad_cta, ad_link, ad_platforms, niche, radar_ids,
       transcript, transcript_source, raw_json, first_seen, last_seen, body_text, bookmarks, saves, reposts, source_ref, query)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(it.id, it.platform, it.external_id, it.url, it.author, it.author_id, it.title, it.caption, it.published_at, it.duration_s, it.views, it.likes, it.comments, it.shares, it.followers,
    it.thumbnail_url, it.embed_url, it.media_url, it.media_kind, it.ad_start, it.ad_end, it.ad_active, it.ad_active_days, it.ad_variants, it.ad_cta, it.ad_link, it.ad_platforms,
    niche, JSON.stringify([...ids]), it.captions, it.captions ? 'captions' : text ? 'text' : it.platform === 'meta_ads' ? null : 'missing', raw, ts, ts,
    it.body_text, it.bookmarks, it.saves, it.reposts, it.source_ref, query).run();
  return 'inserted' as const;
}

/**
 * Re-score the items of a platform. The baselines come from what Radar has seen: each author's and the platform's
 * median metric (views on video platforms, weighted interactions on text ones; see scoreItem), and for Reddit and
 * Substack each subreddit's or publication's median. Only rows whose score moved are written.
 */
export async function rescore(rt: Runtime, platform: Platform, now = Date.now()) {
  const { results } = await rt.env.DB.prepare('SELECT id, platform, views, likes, comments, shares, bookmarks, saves, reposts, followers, published_at, author, source_ref, ad_active_days, ad_variants, ad_start, ad_end, ad_active, score, score_json FROM radar_items WHERE platform = ? ORDER BY last_seen DESC LIMIT 4000')
    .bind(platform).all<RadarItem & { id: string; score: number; score_json: string | null }>();
  const byAuthor = new Map<string, number[]>();
  const bySource = new Map<string, number[]>();
  const all: number[] = [];
  const mOf = new Map<string, number | null>();
  for (const r of results) {
    const m = metricOf(r);
    mOf.set(r.id, m);
    if (m == null) continue;
    all.push(m);
    if (r.author) byAuthor.set(r.author, [...(byAuthor.get(r.author) ?? []), m]);
    if (r.source_ref) bySource.set(r.source_ref, [...(bySource.get(r.source_ref) ?? []), m]);
  }
  // The other items' values (this item's own value taken out once).
  const others = (list: number[] | undefined, m: number | null | undefined) => { const a = [...(list ?? [])]; const i = m == null ? -1 : a.indexOf(m); if (i >= 0) a.splice(i, 1); return a; };
  const stmts: D1PreparedStatement[] = [];
  for (const r of results) {
    // Ads still running gain a day every day: refresh days active before scoring.
    const daysBefore = r.ad_active_days;
    if (platform === 'meta_ads' && r.ad_start && r.ad_active !== 0) r.ad_active_days = Math.max(0, Math.round((now - Date.parse(r.ad_start)) / 86400_000));
    const m = mOf.get(r.id);
    const p = scoreItem(r, { authorViews: others(byAuthor.get(r.author ?? ''), m), platformViews: all, sourceValues: SOURCE_PLATFORMS.has(platform) ? others(bySource.get(r.source_ref ?? ''), m) : undefined, now });
    if (r.score_json && Math.abs(p.score - (r.score ?? 0)) < 0.1 && daysBefore === r.ad_active_days) continue;
    stmts.push(rt.env.DB.prepare('UPDATE radar_items SET score = ?, score_json = ?, ad_active_days = ? WHERE id = ?').bind(p.score, JSON.stringify(p), r.ad_active_days, r.id));
  }
  for (let i = 0; i < stmts.length; i += 50) await rt.env.DB.batch(stmts.slice(i, i + 50));
  if (platform === 'substack' && bySource.size) {
    await rt.env.DB.batch([...bySource.entries()].map(([host, xs]) => rt.env.DB.prepare('UPDATE radar_publications SET median_interactions = ? WHERE id = ?').bind(median(xs), host)));
  }
}

export const SORTS = ['score', 'views', 'engagement', 'velocity', 'longevity', 'variants', 'recent'] as const;
export type Sort = (typeof SORTS)[number];

interface ItemListRow {
  id: string; platform: Platform; url: string | null; author: string | null; title: string | null; caption: string | null; published_at: string | null; duration_s: number | null;
  views: number | null; likes: number | null; comments: number | null; shares: number | null; followers: number | null; thumbnail_url: string | null; media_url: string | null; media_kind: string | null;
  ad_active_days: number | null; ad_variants: number | null; ad_active: number | null; ad_cta: string | null; niche: string | null; radar_ids: string; score: number; score_json: string | null;
  transcript_source: string | null; analyzed_at: string | null; script_id: string | null; first_seen: string; last_seen: string; hook: string | null;
}

// ───────────── relevance ─────────────
// Platform search (Instagram above all) also returns viral posts that have nothing to do with the query. An item ranks only when
// its title, caption or author mentions a word from the radar's keywords or the business vocabulary below.
const REL_STOP = new Set(["the", "and", "for", "with", "your", "you", "how", "what", "why", "that", "this", "from", "into", "about", "when", "make", "does", "much"]);
export const BUSINESS_WORDS = ['business', 'businesses', 'acquisition', 'acquisitions', 'acquire', 'acquiring', 'seller', 'sellers', 'financing', 'finance', 'financed', 'private equity',
  'roll up', 'roll-up', 'rollup', 'ebitda', 'revenue', 'profit', 'cash flow', 'cashflow', 'loan', 'sba', 'lender', 'bank', 'deal', 'deals', 'owner', 'owners', 'company', 'companies',
  'entrepreneur', 'founder', 'ceo', 'franchise', 'merger', 'invest', 'investor', 'investing', 'valuation', 'buyout', 'equity', 'startup', 'small biz', 'smallbusiness', 'laundromat', 'hvac', 'plumbing'];
const words = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9#&\s-]/g, ' ');
export function relevantTo(text: string, keywords: string[]): boolean {
  const t = ` ${words(text).replace(/#/g, ' ')} `;
  if (!t.trim()) return false;
  const kw = keywords.flatMap((k) => words(k).split(/\s+/)).filter((w) => w.length >= 4 && !REL_STOP.has(w));
  if (kw.some((w) => t.includes(` ${w}`))) return true;
  return BUSINESS_WORDS.some((w) => t.includes(` ${w}`));
}
/**
 * Relevance for text posts (X, LinkedIn, Reddit, Substack). A long post mentions "business" or "company" in passing
 * far more often than a caption does, so one stray word is not enough: it ranks when the title or opening carries a
 * radar keyword phrase or a word of one, when the whole text carries a full keyword phrase, or when it uses at least
 * two different business words. A Substack post from the owner's own list passes on its publication's word.
 */
export function relevantText(title: string, body: string, keywords: string[], o: { listed?: boolean } = {}): boolean {
  if (o.listed) return true;
  const norm = (s: string) => ` ${words(s).replace(/#/g, ' ').replace(/\s+/g, ' ').trim()} `;
  const t = norm(`${title} ${body.slice(0, 6000)}`);
  if (!t.trim()) return false;
  const phrases = keywords.map((k) => words(k).replace(/\s+/g, ' ').trim()).filter((k) => k.length >= 3);
  if (phrases.some((p) => t.includes(` ${p} `) || t.includes(` ${p}s `))) return true;
  const head = norm(`${title} ${body.slice(0, 280)}`);
  const kwWords = keywords.flatMap((k) => words(k).split(/\s+/)).filter((w) => w.length >= 4 && !REL_STOP.has(w));
  if (kwWords.some((w) => head.includes(` ${w}`))) return true;
  return new Set(BUSINESS_WORDS.filter((w) => t.includes(` ${w} `) || t.includes(` ${w}s `))).size >= 2;
}

export async function listItems(rt: Runtime, f: { platform?: string; niche?: string; radar?: string; sort?: string; limit?: number; all?: boolean }) {
  const where: string[] = []; const args: unknown[] = [];
  if (f.platform && (PLATFORMS as readonly string[]).includes(f.platform)) { where.push('platform = ?'); args.push(f.platform); }
  else if (f.platform === 'videos') where.push("platform IN ('youtube','tiktok','instagram')");
  else if (f.platform === 'text') where.push("platform IN ('x','linkedin','reddit','substack')");
  if (f.niche === 'in' || f.niche === 'out') { where.push("(niche = ? OR niche = 'both')"); args.push(f.niche); }
  if (f.radar) { where.push("radar_ids LIKE ? ESCAPE '\\'"); args.push(`%"${f.radar.replace(/"/g, '').replace(/[\\%_]/g, (ch) => `\\${ch}`)}"%`); }
  const { results } = await rt.env.DB.prepare(
    `SELECT id, platform, url, author, title, substr(caption, 1, 400) AS caption, published_at, duration_s, views, likes, comments, shares, followers, thumbnail_url, media_url, media_kind,
            ad_active_days, ad_variants, ad_active, ad_cta, niche, radar_ids, score, score_json, transcript_source, analyzed_at, script_id, first_seen, last_seen,
            json_extract(analysis_json, '$.for_gl.hook') AS hook,
            bookmarks, saves, reposts, source_ref, query, substr(body_text, 1, 1200) AS body_head
       FROM radar_items ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY score DESC LIMIT 1500`,
  ).bind(...args).all<ItemListRow & { bookmarks: number | null; saves: number | null; reposts: number | null; source_ref: string | null; query: string | null; body_head: string | null }>();
  const sort: Sort = (SORTS as readonly string[]).includes(f.sort ?? '') ? (f.sort as Sort) : 'score';
  const parts = (r: ItemListRow) => parse<Partial<{ ratio: number; velocity: number; engagement: number }>>(r.score_json, {});
  const key: Record<Sort, (r: ItemListRow) => number> = {
    score: (r) => r.score, views: (r) => r.views ?? -1, engagement: (r) => parts(r).engagement ?? -1, velocity: (r) => parts(r).velocity ?? -1,
    longevity: (r) => r.ad_active_days ?? -1, variants: (r) => r.ad_variants ?? -1, recent: (r) => Date.parse(r.published_at ?? r.first_seen) || 0,
  };
  // Off-topic items are left out unless asked for (all=1).
  let kept = results;
  if (!f.all) {
    const { results: wl } = await rt.env.DB.prepare('SELECT id, keywords_json FROM radar_watchlists').all<{ id: string; keywords_json: string }>();
    const kwOf = new Map(wl.map((w) => [w.id, parse<string[]>(w.keywords_json, [])]));
    kept = results.filter((r) => {
      const kws = parse<string[]>(r.radar_ids, []).flatMap((id) => kwOf.get(id) ?? []);
      // Text posts: the stricter check on their full opening; a Substack post comes from the owner's own list.
      if (isTextPlatform(r.platform)) return relevantText(r.title ?? '', r.body_head ?? r.caption ?? '', kws, { listed: r.platform === 'substack' });
      return relevantTo(`${r.title ?? ''} ${r.caption ?? ''} ${r.author ?? ''}`, kws);
    });
  }
  return kept.sort((a, b) => key[sort](b) - key[sort](a)).slice(0, Math.min(200, f.limit ?? 120)).map(({ body_head: _b, ...r }) => ({ ...r, radar_ids: parse<string[]>(r.radar_ids, []), score_parts: parse(r.score_json, null), score_json: undefined }));
}

export async function getItem(rt: Runtime, id: string) {
  const r = await rt.env.DB.prepare('SELECT * FROM radar_items WHERE id = ?').bind(id).first<Record<string, unknown> & { analysis_json: string | null; analysis_flags: string | null; radar_ids: string; score_json: string | null }>();
  if (!r) return null;
  const { raw_json: _raw, ...rest } = r;
  void _raw;
  const runs = await rt.env.DB.prepare('SELECT id, slot, status, cost_micros, error, created_at FROM radar_runs WHERE item_id = ? ORDER BY created_at DESC LIMIT 5').bind(id).all();
  return { ...rest, radar_ids: parse<string[]>(r.radar_ids, []), score_parts: parse(r.score_json, null), analysis: parse(r.analysis_json, null), analysis_flags: parse(r.analysis_flags, []), runs: runs.results };
}

// ───────────── the weekly digest ─────────────

const STOP = new Set('here a an and are as at be by for from how i in is it its my of on or our that the this to was what when why with you your we they he she me do does did not no yes can will just about into over more most so than then there these those who whom which while been being have has had get got make made one two three'.split(' '));

/** Patterns across the week's top items: recurring hooks, formats and topics, each with linked examples. */
export async function digest(rt: Runtime, now = Date.now(), days = 7) {
  const since = new Date(now - days * 86400_000).toISOString();
  const { results } = await rt.env.DB.prepare(
    `SELECT id, platform, title, author, url, thumbnail_url, media_url, media_kind, views, duration_s, published_at, score, score_json, niche, ad_active, ad_active_days, ad_variants, ad_cta, analysis_json FROM radar_items WHERE last_seen >= ? ORDER BY score DESC LIMIT 300`,
  ).bind(since).all<{ id: string; platform: string; title: string | null; author: string | null; url: string | null; thumbnail_url: string | null; media_url: string | null; media_kind: string | null; views: number | null; duration_s: number | null; published_at: string | null; score: number; score_json: string | null; niche: string | null; ad_active: number | null; ad_active_days: number | null; ad_variants: number | null; ad_cta: string | null; analysis_json: string | null }>();
  type Ex = { id: string; title: string | null; author: string | null; platform: string; score: number };
  const ex = (r: (typeof results)[number]): Ex => ({ id: r.id, title: r.title, author: r.author, platform: r.platform, score: r.score });
  const group = (pick: (a: Record<string, unknown>) => string | null) => {
    const m = new Map<string, Ex[]>();
    for (const r of results) {
      const a = parse<Record<string, unknown> | null>(r.analysis_json, null);
      const k = a ? pick(a)?.trim().toLowerCase() : null;
      if (k) m.set(k, [...(m.get(k) ?? []), ex(r)]);
    }
    return [...m.entries()].map(([label, items]) => ({ label, count: items.length, avg_score: Math.round(items.reduce((n, x) => n + x.score, 0) / items.length), examples: items.slice(0, 4) }))
      .sort((a, b) => b.count - a.count || b.avg_score - a.avg_score).slice(0, 8);
  };
  const hooks = group((a) => (a.hook && typeof a.hook === 'object' ? String((a.hook as Record<string, unknown>).type ?? '') : null));
  const formats = group((a) => (typeof a.format === 'string' ? a.format.split(/[,.;(]/)[0].slice(0, 40) : null));
  // Topics: the words that recur in the top titles (two-word phrases first).
  const top = results.slice(0, 120);
  const counts = new Map<string, Ex[]>();
  for (const r of top) {
    const w = (r.title ?? '').toLowerCase().replace(/[^a-z0-9$' ]+/g, ' ').split(/\s+/).filter((x) => x.length > 2 && !STOP.has(x));
    const grams = new Set<string>();
    for (let i = 0; i < w.length; i++) { grams.add(w[i]); if (i + 1 < w.length) grams.add(`${w[i]} ${w[i + 1]}`); }
    for (const g of grams) counts.set(g, [...(counts.get(g) ?? []), ex(r)]);
  }
  const ranked = [...counts.entries()].filter(([, v]) => v.length >= 2)
    .map(([label, items]) => ({ label, count: items.length, avg_score: Math.round(items.reduce((n, x) => n + x.score, 0) / items.length), examples: items.slice(0, 4), ids: items.map((x) => x.id).sort().join(' ') }))
    .sort((a, b) => (b.label.includes(' ') ? 1 : 0) - (a.label.includes(' ') ? 1 : 0) || b.count - a.count);
  // One row per idea: skip a phrase that finds exactly the same items as one already listed.
  const seenSets = new Set<string>();
  const topics: Omit<(typeof ranked)[number], 'ids'>[] = [];
  for (const { ids, ...t } of ranked) { if (seenSets.has(ids)) continue; seenSets.add(ids); topics.push(t); if (topics.length >= 8) break; }
  return {
    since, days,
    items: results.length,
    analysed: results.filter((r) => r.analysis_json).length,
    top: results.slice(0, 6).map(({ analysis_json: _a, score_json, ...r }) => ({ ...r, score_parts: parse(score_json, null) })),
    hooks, formats, topics,
  };
}

export async function recentRuns(rt: Runtime, limit = 30) {
  const { results } = await rt.env.DB.prepare('SELECT id, watchlist_id, item_id, slot, provider, endpoint, status, est_micros, cost_micros, cost_estimated, result_count, items_saved, error, created_at, updated_at FROM radar_runs ORDER BY created_at DESC LIMIT ?').bind(limit).all();
  return results;
}
