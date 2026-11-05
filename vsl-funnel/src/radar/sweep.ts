/**
 * Radar v2: sweeps. A sweep runs every enabled radar (each keyword on each of its platforms, paged by RADAR_PAGES),
 * the curated subreddits and the Substack publications, in one go, under one id, so its progress, its cost and the
 * automatic transcripts that follow it can be shown and checked. "Full sweep" in Studio starts one after showing the
 * estimate; the cron starts a smaller one with whatever is due by RADAR_SCHEDULE_HOURS.
 *
 * After a sweep's searches finish, the best new videos (by score, relevant to their radar, taking turns across
 * YouTube, TikTok and Instagram) are transcribed, up to RADAR_AUTO_TRANSCRIBE, within the monthly budget. Text posts
 * need no transcript: their body_text is it.
 */
import type { Runtime } from '../app';
import {
  type QueueResult, RADAR_COPY, type RadarConfig, type ToolRow, type WlRow, ensureSeeded, insertRun, listWatchlists, monthSpend, previewFor, queryFor, queueTranscript,
  queueWatchlist, radarConfig, radarStep, relevantTo, selectedTool, toWl,
} from './engine';
import { type Platform, type RadarQuery, type Slot, VIDEO_PLATFORMS, builtinFor, searchSlot, slotDef, transcriptSlot } from './sources';
import { platformsOff } from './universe';

const parse = <T>(s: string | null | undefined, d: T): T => { try { return s ? (JSON.parse(s) as T) : d; } catch { return d; } };

export const SWEEP_COPY = {
  started: 'The sweep has started. Results arrive over the next minutes; this page follows them.',
  nothing: 'Nothing to run: every radar, subreddit and publication is switched off or has no confirmed source.',
  overBudget: 'This sweep would take the month past the Radar budget. Raise the budget in Integrations, switch some radars off, or lower the pages per search.',
};

// ───────────── the estimate ─────────────

export interface SweepLine { kind: 'radar' | 'subreddits' | 'publications' | 'transcripts'; id: string | null; name: string; platform: Platform | null; calls: number; pages: number; est_micros: number; note?: string }
export interface SweepEstimate { lines: SweepLine[]; total_micros: number; runs: number; budget_micros: number; committed_micros: number; left_micros: number; fits: boolean; notes: string[] }

/** Pages a search reads: the radar's own setting or RADAR_PAGES, when its tool pages at all. */
const pagesFor = (tool: Pick<ToolRow, 'provider' | 'endpoint' | 'slot'>, cfg: RadarConfig, own?: number | null) => (builtinFor(tool.provider, tool.endpoint, tool.slot)?.pages ? own ?? cfg.pages : 1);

interface Usable { tool: ToolRow | null; why: string | null }
async function usable(rt: Runtime, slot: Slot, off: Set<Platform>, cfg: RadarConfig, cache: Map<Slot, Usable>): Promise<Usable> {
  if (cache.has(slot)) return cache.get(slot)!;
  const def = slotDef(slot)!;
  let res: Usable;
  if (off.has(def.platform)) res = { tool: null, why: RADAR_COPY.platformOff(def.label) };
  else if (def.platform === 'instagram' && !cfg.instagram) res = { tool: null, why: RADAR_COPY.instagramOff };
  else {
    const tool = await selectedTool(rt, slot);
    res = !tool ? { tool: null, why: RADAR_COPY.noSource(def.label) } : !tool.confirmed_at ? { tool: null, why: RADAR_COPY.notConfirmed(def.label) } : { tool, why: null };
  }
  cache.set(slot, res);
  return res;
}

/**
 * What a sweep would cost: for each radar and platform, the listed price of each call × the pages it may read (an
 * upper bound: a page that finds nothing ends the search), plus one call per subreddit (× pages) and per publication,
 * plus the automatic transcripts at the average transcript price. `radarIds` limits it to those radars (and leaves the
 * subreddits and publications out unless `sources` is set).
 */
export async function estimateSweep(rt: Runtime, o: { radarIds?: string[] | null; sources?: boolean; now?: number } = {}): Promise<SweepEstimate> {
  await ensureSeeded(rt);
  const cfg = radarConfig(rt);
  const off = await platformsOff(rt);
  const cache = new Map<Slot, Usable>();
  const lines: SweepLine[] = [];
  const notes = new Set<string>();
  const wls = (await listWatchlists(rt)).filter((w) => w.enabled && (!o.radarIds || o.radarIds.includes(w.id)));
  for (const wl of wls) {
    const q = await queryFor(rt, wl, cfg);
    for (const p of wl.platforms) {
      const slot = searchSlot(p);
      const u = await usable(rt, slot, off, cfg, cache);
      if (!u.tool) { if (u.why) notes.add(u.why); continue; }
      const pv = previewFor(u.tool, q);
      const pages = pagesFor(u.tool, cfg, wl.pages);
      lines.push({ kind: 'radar', id: wl.id, name: wl.name, platform: p, calls: pv.inputs.length, pages, est_micros: pv.est_micros * pages });
    }
  }
  const withSources = o.sources ?? !o.radarIds;
  if (withSources) {
    const subs = (await rt.env.DB.prepare('SELECT name FROM radar_subreddits WHERE enabled = 1').all<{ name: string }>()).results;
    if (subs.length) {
      const u = await usable(rt, 'reddit:subreddit', off, cfg, cache);
      if (u.tool) {
        const per = previewFor(u.tool, { keywords: [], max: cfg.maxItems, subreddit: subs[0].name, sinceDays: 31 }).est_micros;
        const pages = pagesFor(u.tool, cfg);
        lines.push({ kind: 'subreddits', id: null, name: 'Subreddits', platform: 'reddit', calls: subs.length, pages, est_micros: per * subs.length * pages });
      } else if (u.why) notes.add(u.why);
    }
    const pubs = (await rt.env.DB.prepare('SELECT url FROM radar_publications WHERE enabled = 1').all<{ url: string }>()).results;
    if (pubs.length) {
      const u = await usable(rt, 'substack:posts', off, cfg, cache);
      if (u.tool) {
        const per = previewFor(u.tool, { keywords: [], max: cfg.maxItems, publication: pubs[0].url }).est_micros;
        lines.push({ kind: 'publications', id: null, name: 'Substack publications', platform: 'substack', calls: pubs.length, pages: 1, est_micros: per * pubs.length });
      } else if (u.why) notes.add(u.why);
    }
  }
  if (cfg.autoTranscribe > 0) {
    const each: number[] = [];
    for (const p of VIDEO_PLATFORMS) {
      const slot = transcriptSlot(p)!;
      const u = await usable(rt, slot, off, cfg, cache);
      if (u.tool) each.push(previewFor(u.tool, { keywords: [], max: 1, urls: ['https://example.com/v'], durationS: 90 }).est_micros);
    }
    if (each.length) {
      const avg = Math.round(each.reduce((a, b) => a + b, 0) / each.length);
      lines.push({ kind: 'transcripts', id: null, name: 'Automatic transcripts', platform: null, calls: cfg.autoTranscribe, pages: 1, est_micros: avg * cfg.autoTranscribe, note: 'at most; only new videos that are on topic' });
    }
  }
  const total = lines.reduce((a, l) => a + l.est_micros, 0);
  const { committed } = await monthSpend(rt, o.now);
  const left = Math.max(0, cfg.budgetMicros - committed);
  return {
    lines, total_micros: total, runs: lines.reduce((a, l) => a + (l.kind === 'transcripts' ? 0 : l.calls * l.pages), 0),
    budget_micros: cfg.budgetMicros, committed_micros: committed, left_micros: left, fits: total <= left, notes: [...notes],
  };
}

// ───────────── starting a sweep ─────────────

/** Queue one run per subreddit and per publication that is enabled (and due, when `cutoff` is given). */
export async function queueSources(rt: Runtime, sweepId: string | null, o: { cutoff?: string | null; now?: number } = {}): Promise<QueueResult> {
  const cfg = radarConfig(rt);
  const now = o.now ?? Date.now();
  const out: QueueResult = { queued: 0, est_micros: 0, notes: [] };
  if (!cfg.key) { out.notes.push(RADAR_COPY.noKey); return out; }
  const off = await platformsOff(rt);
  const cache = new Map<Slot, Usable>();
  let { committed } = await monthSpend(rt, now);
  const ts = new Date(now).toISOString();
  const due = o.cutoff ? ' AND (last_run_at IS NULL OR last_run_at <= ?)' : '';
  const lists: { slot: Slot; rows: { ref: string; q: RadarQuery }[]; table: string; key: string }[] = [];
  const subs = (await rt.env.DB.prepare(`SELECT name FROM radar_subreddits WHERE enabled = 1${due} ORDER BY name`).bind(...(o.cutoff ? [o.cutoff] : [])).all<{ name: string }>()).results;
  lists.push({ slot: 'reddit:subreddit', table: 'radar_subreddits', key: 'name', rows: subs.map((s) => ({ ref: s.name, q: { keywords: [], max: cfg.maxItems, subreddit: s.name, sinceDays: 31 } })) });
  const pubs = (await rt.env.DB.prepare(`SELECT id, url FROM radar_publications WHERE enabled = 1${due} ORDER BY id`).bind(...(o.cutoff ? [o.cutoff] : [])).all<{ id: string; url: string }>()).results;
  lists.push({ slot: 'substack:posts', table: 'radar_publications', key: 'id', rows: pubs.map((p) => ({ ref: p.id, q: { keywords: [], max: cfg.maxItems, publication: p.url } })) });
  for (const l of lists) {
    if (!l.rows.length) continue;
    const u = await usable(rt, l.slot, off, cfg, cache);
    if (!u.tool) { if (u.why) out.notes.push(u.why); continue; }
    const done: string[] = [];
    for (const r of l.rows) {
      const pv = previewFor(u.tool, r.q);
      const input = pv.inputs[0];
      if (!input) continue;
      const per = pv.est_each[0] ?? 0;
      if (committed + per > cfg.budgetMicros) { out.notes.push(RADAR_COPY.budgetWouldPass); break; }
      await insertRun(rt, { slot: l.slot, tool: u.tool, input, est: per, sweep_id: sweepId, page: 1, query: r.q.subreddit ? `r/${r.q.subreddit}` : r.q.publication ?? null, source_ref: r.ref });
      committed += per; out.est_micros += per; out.queued++; done.push(r.ref);
    }
    for (let i = 0; i < done.length; i += 50) {
      await rt.env.DB.batch(done.slice(i, i + 50).map((ref) => rt.env.DB.prepare(`UPDATE ${l.table} SET last_run_at = ? WHERE ${l.key} = ?`).bind(ts, ref)));
    }
  }
  return out;
}

export interface SweepStart { ok: boolean; sweep_id: string | null; queued: number; est_micros: number; notes: string[] }

/**
 * Start a sweep: queue every enabled radar (or the given ones, or only those due when `cutoff` is set), then the
 * subreddits and publications. Nothing is queued past the monthly budget (each run is checked as it is queued and
 * again before it starts).
 */
export async function startSweep(rt: Runtime, kind: 'full' | 'cron' | 'radar', o: { radarIds?: string[] | null; sources?: boolean; cutoff?: string | null; now?: number } = {}): Promise<SweepStart> {
  const now = o.now ?? Date.now();
  const cfg = radarConfig(rt);
  if (!cfg.key) return { ok: false, sweep_id: null, queued: 0, est_micros: 0, notes: [RADAR_COPY.noKey] };
  await ensureSeeded(rt);
  const id = `sw-${new Date(now).toISOString().slice(0, 16).replace(/[-:T]/g, '')}-${crypto.randomUUID().slice(0, 6)}`;
  const ts = new Date(now).toISOString();
  await rt.env.DB.prepare('INSERT INTO radar_sweeps (id, kind, status, started_at) VALUES (?, ?, ?, ?)').bind(id, kind, 'running', ts).run();
  const notes = new Set<string>();
  let queued = 0, est = 0;
  const where = ['deleted_at IS NULL', 'enabled = 1'];
  const args: unknown[] = [];
  if (o.cutoff) { where.push('(last_run_at IS NULL OR last_run_at <= ?)'); args.push(o.cutoff); }
  const { results } = await rt.env.DB.prepare(`SELECT * FROM radar_watchlists WHERE ${where.join(' AND ')} ORDER BY created_at`).bind(...args).all<WlRow>();
  for (const r of results.filter((x) => !o.radarIds || o.radarIds.includes(x.id))) {
    const q = await queueWatchlist(rt, toWl(r), now, { sweep_id: id });
    queued += q.queued; est += q.est_micros; q.notes.forEach((n) => notes.add(n));
  }
  if (o.sources ?? !o.radarIds) {
    const s = await queueSources(rt, id, { cutoff: o.cutoff, now });
    queued += s.queued; est += s.est_micros; s.notes.forEach((n) => notes.add(n));
  }
  if (!queued) {
    await rt.env.DB.prepare("UPDATE radar_sweeps SET status = 'done', finished_at = ?, notes_json = ? WHERE id = ?").bind(ts, JSON.stringify([...notes]), id).run();
    return { ok: false, sweep_id: id, queued: 0, est_micros: 0, notes: notes.size ? [...notes] : [SWEEP_COPY.nothing] };
  }
  await rt.env.DB.prepare('UPDATE radar_sweeps SET queued = ?, est_micros = ?, notes_json = ? WHERE id = ?').bind(queued, est, JSON.stringify([...notes]), id).run();
  return { ok: true, sweep_id: id, queued, est_micros: est, notes: [...notes] };
}

// ───────────── automatic transcription ─────────────

export interface Candidate { id: string; platform: string; score: number; est: number }

/**
 * Pick up to `n` videos to transcribe: each platform's own ranking by score, taken in turns (the best remaining head
 * first in each round) so one platform cannot take every slot, skipping any whose estimate no longer fits the budget.
 */
export function selectForTranscription(items: Candidate[], n: number, budgetLeft: number): Candidate[] {
  if (n <= 0) return [];
  const by = new Map<string, Candidate[]>();
  for (const it of [...items].sort((a, b) => b.score - a.score)) by.set(it.platform, [...(by.get(it.platform) ?? []), it]);
  const out: Candidate[] = [];
  let left = budgetLeft;
  while (out.length < n && [...by.values()].some((l) => l.length)) {
    const heads = [...by.entries()].filter(([, l]) => l.length).sort((a, b) => b[1][0].score - a[1][0].score);
    for (const [, list] of heads) {
      if (out.length >= n) break;
      // The best one of this platform that still fits.
      while (list.length) {
        const c = list.shift()!;
        if (c.est <= left) { out.push(c); left -= c.est; break; }
      }
    }
  }
  return out;
}

/** Queue the automatic transcripts for a sweep's new videos. Returns how many were queued. */
export async function autoTranscribe(rt: Runtime, sweep: { id: string; started_at: string }, now = Date.now()): Promise<number> {
  const cfg = radarConfig(rt);
  if (cfg.autoTranscribe <= 0 || !cfg.key) return 0;
  const off = await platformsOff(rt);
  const cache = new Map<Slot, Usable>();
  const est = new Map<string, ToolRow>();
  for (const p of VIDEO_PLATFORMS) { const u = await usable(rt, transcriptSlot(p)!, off, cfg, cache); if (u.tool) est.set(p, u.tool); }
  if (!est.size) return 0;
  const { results } = await rt.env.DB.prepare(
    `SELECT id, platform, score, duration_s, url, title, caption, author, radar_ids FROM radar_items
      WHERE platform IN (${[...est.keys()].map(() => '?').join(', ')}) AND first_seen >= ? AND transcript IS NULL
        AND (transcript_source IS NULL OR transcript_source = 'missing') AND url IS NOT NULL
      ORDER BY score DESC LIMIT 600`,
  ).bind(...est.keys(), sweep.started_at).all<{ id: string; platform: string; score: number; duration_s: number | null; url: string; title: string | null; caption: string | null; author: string | null; radar_ids: string }>();
  const { results: wls } = await rt.env.DB.prepare('SELECT id, keywords_json FROM radar_watchlists').all<{ id: string; keywords_json: string }>();
  const kwOf = new Map(wls.map((w) => [w.id, parse<string[]>(w.keywords_json, [])]));
  const cands: Candidate[] = results
    .filter((r) => relevantTo(`${r.title ?? ''} ${r.caption ?? ''} ${r.author ?? ''}`, parse<string[]>(r.radar_ids, []).flatMap((x) => kwOf.get(x) ?? [])))
    .map((r) => ({ id: r.id, platform: r.platform, score: r.score, est: previewFor(est.get(r.platform)!, { keywords: [], max: 1, urls: [r.url], durationS: r.duration_s }).est_micros }));
  const { committed } = await monthSpend(rt, now);
  const pick = selectForTranscription(cands, cfg.autoTranscribe, Math.max(0, cfg.budgetMicros - committed));
  let queued = 0;
  for (const c of pick) if ((await queueTranscript(rt, c.id, now, { sweep_id: sweep.id })).ok) queued++;
  return queued;
}

// ───────────── progress ─────────────

interface SweepRow { id: string; kind: string; status: string; est_micros: number; queued: number; transcripts_queued: number; notes_json: string | null; started_at: string; finished_at: string | null }

/** Move sweeps on: searches done → automatic transcripts → done. A sweep left running for two days is closed. */
export async function advanceSweeps(rt: Runtime, now = Date.now()) {
  const { results } = await rt.env.DB.prepare("SELECT * FROM radar_sweeps WHERE status IN ('running', 'transcribing') ORDER BY started_at").all<SweepRow>();
  const ts = new Date(now).toISOString();
  for (const s of results) {
    const active = await rt.env.DB.prepare("SELECT COUNT(*) AS n FROM radar_runs WHERE sweep_id = ? AND status IN ('pending', 'running')").bind(s.id).first<{ n: number }>();
    const stale = now - Date.parse(s.started_at) > 2 * 86400_000;
    if (Number(active?.n ?? 0) > 0 && !stale) continue;
    if (s.status === 'running' && !stale) {
      const n = await autoTranscribe(rt, s, now);
      await rt.env.DB.prepare('UPDATE radar_sweeps SET status = ?, transcripts_queued = ?, finished_at = ? WHERE id = ?').bind(n ? 'transcribing' : 'done', n, n ? null : ts, s.id).run();
    } else {
      await rt.env.DB.prepare("UPDATE radar_sweeps SET status = 'done', finished_at = ? WHERE id = ?").bind(ts, s.id).run();
    }
  }
}

/** The latest sweeps with their live numbers: runs by status, money, items found, transcripts. */
export async function sweepStatus(rt: Runtime, limit = 5) {
  const { results } = await rt.env.DB.prepare('SELECT * FROM radar_sweeps ORDER BY started_at DESC LIMIT ?').bind(limit).all<SweepRow>();
  const out = [];
  for (const s of results) {
    const r = await rt.env.DB.prepare(
      `SELECT COUNT(*) AS runs,
              SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
              COALESCE(SUM(CASE WHEN status IN ('completed','failed') THEN cost_micros ELSE 0 END), 0) AS cost_micros,
              COALESCE(SUM(items_saved), 0) AS items_saved,
              SUM(CASE WHEN slot LIKE '%:transcript' THEN 1 ELSE 0 END) AS transcripts,
              SUM(CASE WHEN slot LIKE '%:transcript' AND status = 'completed' AND items_saved > 0 THEN 1 ELSE 0 END) AS transcribed,
              SUM(CASE WHEN page > 1 THEN 1 ELSE 0 END) AS extra_pages
         FROM radar_runs WHERE sweep_id = ?`,
    ).bind(s.id).first<Record<string, number | null>>();
    const fresh = await rt.env.DB.prepare('SELECT COUNT(*) AS n FROM radar_items WHERE first_seen >= ?').bind(s.started_at).first<{ n: number }>();
    const n = (k: string) => Number(r?.[k] ?? 0);
    const { results: errors } = await rt.env.DB.prepare("SELECT slot, error, COUNT(*) AS n FROM radar_runs WHERE sweep_id = ? AND status = 'failed' AND error IS NOT NULL GROUP BY slot, error ORDER BY n DESC LIMIT 5").bind(s.id).all<{ slot: string; error: string; n: number }>();
    out.push({
      id: s.id, kind: s.kind, status: s.status, started_at: s.started_at, finished_at: s.finished_at, est_micros: s.est_micros, notes: parse<string[]>(s.notes_json, []),
      runs: n('runs'), pending: n('pending'), running: n('running'), completed: n('completed'), failed: n('failed'), skipped: n('skipped'), extra_pages: n('extra_pages'),
      cost_micros: n('cost_micros'), items_saved: n('items_saved'), new_items: Number(fresh?.n ?? 0),
      transcripts_queued: s.transcripts_queued, transcripts: n('transcripts'), transcribed: n('transcribed'), errors,
    });
  }
  return out;
}

// ───────────── the cron ─────────────

/**
 * The cron job (every 5 minutes): when RADAR_SCHEDULE_HOURS is set, a sweep of whatever is due (radars, subreddits
 * and publications whose last run is older than that), then one step of the queue (more runs per step than a button
 * press, since a sweep holds hundreds), then the sweeps move on.
 */
export async function radarTick(rt: Runtime, now = Date.now()) {
  const cfg = radarConfig(rt);
  if (!cfg.key) return { queued: 0, step: null };
  let queued = 0;
  if (cfg.scheduleHours > 0) {
    await ensureSeeded(rt);
    const cutoff = new Date(now - cfg.scheduleHours * 3600_000).toISOString();
    const due = await rt.env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM radar_watchlists WHERE deleted_at IS NULL AND enabled = 1 AND (last_run_at IS NULL OR last_run_at <= ?))
            + (SELECT COUNT(*) FROM radar_subreddits WHERE enabled = 1 AND (last_run_at IS NULL OR last_run_at <= ?))
            + (SELECT COUNT(*) FROM radar_publications WHERE enabled = 1 AND (last_run_at IS NULL OR last_run_at <= ?)) AS n`,
    ).bind(cutoff, cutoff, cutoff).first<{ n: number }>();
    if (Number(due?.n ?? 0) > 0) queued = (await startSweep(rt, 'cron', { cutoff, sources: true, now })).queued;
  }
  const step = await radarStep(rt, { budgetMs: 60_000, maxStart: 40 });
  await advanceSweeps(rt, now);
  return { queued, step };
}
