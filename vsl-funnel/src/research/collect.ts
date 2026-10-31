import type { Runtime } from '../app';
import { newId } from '../lib/ids';
import { type ResearchConfig, researchConfig } from './config';
import { adsForCompetitor, adsForKeyword, redditSearch, redditSubreddit, youtubeSearch } from './sources';
import { saveAds, saveItems } from './store';
import { collectVoc } from './voc';

/**
 * Daily collection, cut into small jobs. The 5-minute cron runs a few jobs per tick, so Reddit sees a
 * handful of requests every few minutes (far under its limits) and no single Worker run makes many
 * subrequests. Progress lives in kv_state under research:collect.
 */
export type Job =
  | { t: 'voc' }
  | { t: 'reddit_sub'; sub: string }
  | { t: 'reddit_search'; q: string }
  | { t: 'ads_competitor'; name: string; pageId: string | null }
  | { t: 'ads_keyword'; q: string }
  | { t: 'yt_search'; q: string };

export function buildJobs(cfg: ResearchConfig): { jobs: Job[]; skipped: string[] } {
  const jobs: Job[] = [{ t: 'voc' }];
  const skipped: string[] = [];
  for (const sub of cfg.subreddits) jobs.push({ t: 'reddit_sub', sub });
  for (const q of cfg.keywords) jobs.push({ t: 'reddit_search', q });
  if (cfg.adToken) {
    for (const c of cfg.competitors) jobs.push({ t: 'ads_competitor', name: c.name, pageId: c.pageId });
    for (const q of cfg.adKeywords) jobs.push({ t: 'ads_keyword', q });
  } else skipped.push('Meta Ad Library (no token)');
  if (cfg.ytKey) for (const q of cfg.ytQueries) jobs.push({ t: 'yt_search', q });
  else skipped.push('YouTube (no API key)');
  return { jobs, skipped };
}

export const jobLabel = (j: Job) => j.t === 'voc' ? 'own leads' : j.t === 'reddit_sub' ? `r/${j.sub}` : j.t === 'reddit_search' ? `Reddit search "${j.q}"` : j.t === 'ads_competitor' ? `ads: ${j.name}` : j.t === 'ads_keyword' ? `ads search "${j.q}"` : `YouTube "${j.q}"`;

export async function runJob(rt: Runtime, cfg: ResearchConfig, j: Job) {
  switch (j.t) {
    case 'voc': return { source: 'voc', ...(await saveItems(rt, await collectVoc(rt))) };
    case 'reddit_sub': return { source: 'reddit', ...(await saveItems(rt, await redditSubreddit(rt, cfg, j.sub))) };
    case 'reddit_search': return { source: 'reddit', ...(await saveItems(rt, await redditSearch(rt, cfg, j.q))) };
    case 'ads_competitor': return { source: 'ads', ...(await saveAds(rt, await adsForCompetitor(cfg, { name: j.name, pageId: j.pageId }))) };
    case 'ads_keyword': return { source: 'ads', ...(await saveAds(rt, await adsForKeyword(cfg, j.q))) };
    case 'yt_search': return { source: 'youtube', ...(await saveItems(rt, await youtubeSearch(cfg, j.q))) };
  }
}

export interface CollectState {
  date: string; runId: string; jobs: Job[]; idx: number; skipped: string[];
  added: Record<string, number>; saved: Record<string, number>; errors: string[]; analyzed: boolean; finishedAt?: number;
}
const STATE_KEY = 'research:collect';

export async function loadState(rt: Runtime): Promise<CollectState | null> {
  const row = await rt.env.DB.prepare('SELECT value FROM kv_state WHERE key = ?').bind(STATE_KEY).first<{ value: string }>().catch(() => null);
  try { return row ? (JSON.parse(row.value) as CollectState) : null; } catch { return null; }
}
async function saveState(rt: Runtime, s: CollectState) {
  await rt.env.DB.prepare('INSERT INTO kv_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(STATE_KEY, JSON.stringify(s)).run();
}

export async function startCollection(rt: Runtime, date: string, now = Date.now()): Promise<CollectState> {
  const cfg = researchConfig(rt);
  const { jobs, skipped } = buildJobs(cfg);
  const runId = newId('rr_');
  await rt.env.DB.prepare("INSERT INTO research_runs (id, kind, status, started_at) VALUES (?, 'collect', 'running', ?)").bind(runId, now).run();
  const s: CollectState = { date, runId, jobs, idx: 0, skipped, added: {}, saved: {}, errors: [], analyzed: false };
  await saveState(rt, s);
  return s;
}

/** Runs the next `max` jobs; a job that fails is noted and skipped (a rate limit stops the slice early). */
export async function collectSlice(rt: Runtime, s: CollectState, max = 3, now = Date.now()) {
  const cfg = researchConfig(rt);
  let ran = 0;
  while (s.idx < s.jobs.length && ran < max) {
    const j = s.jobs[s.idx];
    ran++;
    try {
      const r = await runJob(rt, cfg, j);
      s.added[r.source] = (s.added[r.source] ?? 0) + r.added;
      s.saved[r.source] = (s.saved[r.source] ?? 0) + r.saved;
      s.idx++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/rate limit/i.test(msg)) { s.errors.push(`${jobLabel(j)}: ${msg}`.slice(0, 300)); break; } // retry this job next tick
      s.errors.push(`${jobLabel(j)}: ${msg}`.slice(0, 300));
      s.idx++;
    }
  }
  if (s.errors.length > 40) s.errors = s.errors.slice(-40);
  if (s.idx >= s.jobs.length && !s.finishedAt) {
    s.finishedAt = now;
    await rt.env.DB.prepare("UPDATE research_runs SET status = 'done', stats = ?, finished_at = ? WHERE id = ?")
      .bind(JSON.stringify({ added: s.added, saved: s.saved, errors: s.errors, skipped: s.skipped, jobs: s.jobs.length }), now, s.runId).run();
  }
  await saveState(rt, s);
  return s;
}
