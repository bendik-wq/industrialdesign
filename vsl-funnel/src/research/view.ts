import type { Runtime } from '../app';
import { PROOF } from './analyze';
import { researchConfig } from './config';
import { loadState } from './collect';
import { daysRunning } from './sources';
import { vocCounts } from './voc';

/** What Funnel HQ → Research shows. Quotes are stored excerpts with their links; counts are row counts. */

export interface ThemeRow { id: string; run_id: string; scope: string; kind: string; label: string; summary: string | null; item_count: number; item_ids: string; meta: Record<string, unknown> | null; created_at: number }
const parse = <T,>(s: string | null | undefined, d: T): T => { try { return s ? (JSON.parse(s) as T) : d; } catch { return d; } };

export async function analyzeLatest(rt: Runtime) {
  const run = await rt.env.DB.prepare("SELECT id, mode, stats, started_at, finished_at FROM research_runs WHERE kind = 'analyze' AND status = 'done' ORDER BY started_at DESC LIMIT 1")
    .first<{ id: string; mode: string; stats: string; started_at: number; finished_at: number }>();
  if (!run) return { run: null, themes: [] as ThemeRow[] };
  const { results } = await rt.env.DB.prepare('SELECT * FROM research_themes WHERE run_id = ? ORDER BY item_count DESC').bind(run.id).all<Omit<ThemeRow, 'meta'> & { meta: string | null }>();
  return { run: { ...run, stats: parse(run.stats, {}) }, themes: results.map((t) => ({ ...t, meta: parse<Record<string, unknown> | null>(t.meta, null) })) };
}

async function itemsById(rt: Runtime, ids: string[]) {
  const out = new Map<string, { id: string; source: string; kind: string; url: string | null; title: string | null; body: string | null; community: string | null; score: number; published_at: number | null }>();
  const uniq = [...new Set(ids)];
  for (let i = 0; i < uniq.length; i += 90) {
    const chunk = uniq.slice(i, i + 90);
    const { results } = await rt.env.DB.prepare(`SELECT id, source, kind, url, title, body, community, score, published_at FROM research_items WHERE id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all<any>();
    for (const r of results) out.set(r.id, r);
  }
  return out;
}

const quoteOf = (r: { body: string | null; title: string | null }) => {
  const t = (r.body || r.title || '').trim();
  return t.length > 280 ? `${t.slice(0, 279)}…` : t;
};

export async function researchView(rt: Runtime, now = Date.now()) {
  const cfg = researchConfig(rt);
  const [latest, state, runs, counts, angleRows, voc] = await Promise.all([
    analyzeLatest(rt),
    loadState(rt),
    rt.env.DB.prepare('SELECT id, kind, status, mode, stats, error, started_at, finished_at FROM research_runs ORDER BY started_at DESC LIMIT 8').all<any>(),
    rt.env.DB.prepare('SELECT source, COUNT(*) AS n, MAX(collected_at) AS last FROM research_items GROUP BY source').all<{ source: string; n: number; last: number }>(),
    rt.env.DB.prepare('SELECT * FROM research_angles ORDER BY CASE status WHEN \'winner\' THEN 0 WHEN \'testing\' THEN 1 WHEN \'approved\' THEN 2 WHEN \'new\' THEN 3 ELSE 4 END, created_at DESC LIMIT 200').all<any>(),
    vocCounts(rt, now).catch(() => null),
  ]);
  const adCount = await rt.env.DB.prepare('SELECT COUNT(*) AS n, MAX(last_seen) AS last FROM research_ads').first<{ n: number; last: number | null }>();

  // Angles sent to Marketing move to "testing" once their proposal is approved or done in the action log.
  const sent = angleRows.results.filter((a: any) => a.status === 'approved' && a.action_id);
  if (sent.length) {
    try {
      const ids = sent.map((a: any) => a.action_id);
      const { results } = await rt.env.DB.prepare(`SELECT id, status FROM ops_actions WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all<{ id: string; status: string }>();
      const ok = new Set(results.filter((r) => r.status === 'approved' || r.status === 'done').map((r) => r.id));
      for (const a of sent) if (ok.has(a.action_id)) {
        await rt.env.DB.prepare("UPDATE research_angles SET status = 'testing', updated_at = ? WHERE id = ? AND status = 'approved'").bind(now, a.id).run();
        a.status = 'testing';
      }
    } catch { /* no action log table yet */ }
  }

  const themeIds = latest.themes.filter((t) => t.scope !== 'competitor').flatMap((t) => parse<string[]>(t.item_ids, []).slice(0, 3));
  const angleIds = angleRows.results.flatMap((a: any) => parse<string[]>(a.evidence, []));
  const items = await itemsById(rt, [...themeIds, ...angleIds]);
  const evidence = (ids: string[], n: number) => ids.map((id) => items.get(id)).filter(Boolean).slice(0, n).map((r) => ({ id: r!.id, source: r!.source, kind: r!.kind, community: r!.community, url: r!.url, quote: quoteOf(r!), score: r!.score }));

  const themes = latest.themes.map((t) => {
    const ids = parse<string[]>(t.item_ids, []);
    return { id: t.id, scope: t.scope, kind: t.kind, label: t.label, summary: t.summary, count: t.item_count, meta: t.meta, quotes: t.scope === 'competitor' ? [] : evidence(ids, 3) };
  });
  const proof = new Map(PROOF.map((p) => [p.id, p.text]));
  const angles = angleRows.results.map((a: any) => ({
    id: a.id, origin: a.origin, hook: a.hook, promise: a.promise, proof_id: a.proof_id, proof: proof.get(a.proof_id) ?? null, audience: a.audience, revenue_band: a.revenue_band,
    belief: a.belief, status: a.status, action_id: a.action_id, sent_at: a.sent_at, created_at: a.created_at, evidence: evidence(parse<string[]>(a.evidence, []), 6),
  }));

  const notes: { level: 'warn' | 'info'; text: string }[] = [];
  if (!cfg.aiReady) notes.push({ level: 'warn', text: 'No Anthropic key: data is collected and grouped by keyword rules, and angles come from the approved templates. Add the key under Integrations → Email for Claude clustering, competitor offer reads and angle drafts.' });
  if (!cfg.adToken) notes.push({ level: 'warn', text: 'No Meta Ad Library token: competitor ads are not collected. Add one under Integrations → Research.' });
  if (cfg.adToken && !cfg.competitors.length) notes.push({ level: 'info', text: 'No competitor advertisers listed yet: only the Ad Library keyword searches run. Add them under Integrations → Research.' });
  if (!cfg.ytKey) notes.push({ level: 'info', text: 'No YouTube key: rising YouTube topics are skipped. Add it under Integrations → Content.' });
  if (!cfg.reddit.clientId) notes.push({ level: 'info', text: 'Reddit is read through its public .json pages at low frequency. Register a Reddit app and add its client ID and secret for the OAuth API.' });
  if (!cfg.enabled) notes.push({ level: 'info', text: 'Daily collection is off. Press Collect now to run it by hand.' });

  return {
    config: { enabled: cfg.enabled, aiReady: cfg.aiReady, model: cfg.model, hour: cfg.hour, tz: cfg.tz, briefDay: cfg.briefDay, briefHour: cfg.briefHour, subreddits: cfg.subreddits, keywords: cfg.keywords, competitors: cfg.competitors.map((c) => c.name), adKeywords: cfg.adKeywords, ytQueries: cfg.ytQueries, sources: { reddit: true, redditOauth: Boolean(cfg.reddit.clientId), ads: Boolean(cfg.adToken), youtube: Boolean(cfg.ytKey) } },
    notes,
    collection: state ? { date: state.date, done: state.idx, total: state.jobs.length, errors: state.errors.slice(-10), skipped: state.skipped, added: state.added, analyzed: state.analyzed } : null,
    counts: { ...Object.fromEntries(counts.results.map((r) => [r.source, { n: Number(r.n), last: r.last }])), ads: { n: Number(adCount?.n) || 0, last: adCount?.last ?? null } },
    analysis: latest.run ? { id: latest.run.id, mode: latest.run.mode, at: latest.run.finished_at, stats: latest.run.stats } : null,
    runs: runs.results.map((r: any) => ({ ...r, stats: parse(r.stats, null) })),
    themes, angles, voc,
  };
}

export async function adsBoard(rt: Runtime, q: { advertiser?: string; minDays?: number; active?: boolean; limit?: number }, now = Date.now()) {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (q.advertiser) { where.push('(tracked_as = ? OR page_name = ?)'); params.push(q.advertiser, q.advertiser); }
  if (q.minDays && q.minDays > 0) { where.push('start_at IS NOT NULL AND (COALESCE(CASE WHEN stop_at < ? THEN stop_at END, ?) - start_at) >= ?'); params.push(now, now, q.minDays * 86400_000); }
  if (q.active) { where.push('(stop_at IS NULL OR stop_at >= ?)'); params.push(now - 86400_000); }
  const { results } = await rt.env.DB.prepare(
    `SELECT id, page_id, page_name, tracked_as, body, title, description, caption, link_url, platforms, start_at, stop_at, first_seen, last_seen FROM research_ads
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY start_at IS NULL, start_at ASC LIMIT ?`,
  ).bind(...params, Math.min(q.limit ?? 120, 300)).all<any>();
  const { results: advertisers } = await rt.env.DB.prepare(
    `SELECT CASE WHEN tracked_as LIKE 'search: %' THEN COALESCE(page_name, tracked_as) ELSE tracked_as END AS name, COUNT(*) AS n FROM research_ads GROUP BY 1 ORDER BY n DESC LIMIT 60`,
  ).all<{ name: string; n: number }>();
  return {
    advertisers,
    ads: results.map((a) => ({
      ...a, platforms: parse<string[]>(a.platforms, []), days: daysRunning({ start_at: a.start_at, stop_at: a.stop_at && a.stop_at < now ? a.stop_at : null }, now),
      active: !a.stop_at || a.stop_at >= now - 86400_000, competitor: !String(a.tracked_as).startsWith('search: '),
    })).sort((x, y) => (y.days ?? -1) - (x.days ?? -1)),
  };
}
