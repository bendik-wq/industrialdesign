import type { Runtime } from '../app';
import { newId } from '../lib/ids';
import { notify } from '../integrations/notify';
import { logAction } from '../ops/actions';
import { localClock } from '../sales/digest';
import { analyzeLatest } from './view';
import { researchConfig } from './config';
import { collectSlice, loadState, startCollection } from './collect';
import { runAnalysis } from './analyze';

/**
 * The weekly research brief (Slack / Discord + the action log) and the cron entry point.
 * Every number in the brief is a COUNT over stored rows; the link opens Funnel HQ → Research.
 */
const WEEK = 7 * 86400_000;

export async function buildBrief(rt: Runtime, now = Date.now()) {
  const since = now - WEEK;
  const db = rt.env.DB;
  const [bySource, adsNew, adsLong, angleStatus, anglesNew, latest] = await Promise.all([
    db.prepare('SELECT source, COUNT(*) AS n FROM research_items WHERE collected_at > ? GROUP BY source').bind(since).all<{ source: string; n: number }>(),
    db.prepare('SELECT COUNT(*) AS n FROM research_ads WHERE first_seen > ?').bind(since).first<{ n: number }>(),
    db.prepare('SELECT COUNT(*) AS n FROM research_ads WHERE start_at < ? AND (stop_at IS NULL OR stop_at >= ?)').bind(now - 30 * 86400_000, now - 86400_000).first<{ n: number }>(),
    db.prepare('SELECT status, COUNT(*) AS n FROM research_angles GROUP BY status').all<{ status: string; n: number }>(),
    db.prepare('SELECT hook FROM research_angles WHERE created_at > ? ORDER BY created_at DESC LIMIT 20').bind(since).all<{ hook: string }>(),
    analyzeLatest(rt),
  ]);
  const src = Object.fromEntries(bySource.results.map((r) => [r.source, Number(r.n)]));
  const status = Object.fromEntries(angleStatus.results.map((r) => [r.status, Number(r.n)]));
  const top = (scope: string) => latest.themes.filter((t) => t.scope === scope).sort((a, b) => b.item_count - a.item_count).slice(0, 3);
  const comp = latest.themes.filter((t) => t.scope === 'competitor').sort((a, b) => Number(b.meta?.longestDays ?? 0) - Number(a.meta?.longestDays ?? 0))[0];
  const numbers = {
    reddit: src.reddit ?? 0, youtube: src.youtube ?? 0, voc: src.voc ?? 0, adsNew: Number(adsNew?.n) || 0, adsRunning30: Number(adsLong?.n) || 0,
    anglesNew: anglesNew.results.length, backlog: status,
  };
  const lines = [
    `New this week: ${numbers.reddit} Reddit posts and comments, ${numbers.youtube} YouTube videos, ${numbers.voc} answers from our own leads, ${numbers.adsNew} competitor ads.`,
    `Competitor ads live for 30+ days: ${numbers.adsRunning30}.`,
    top('voc').length ? `Our leads say most: ${top('voc').map((t) => `${t.label} (${t.item_count})`).join('; ')}.` : '',
    top('market').length ? `Owners in public say most: ${top('market').map((t) => `${t.label} (${t.item_count})`).join('; ')}.` : '',
    comp ? `Longest running competitor ad: ${comp.label}, ${Number(comp.meta?.longestDays ?? 0)} days.` : '',
    `Angles: ${numbers.anglesNew} new this week; backlog ${['new', 'approved', 'testing', 'winner', 'retired'].map((k) => `${status[k] ?? 0} ${k === 'approved' ? 'approved for testing' : k}`).join(', ')}.`,
    ...anglesNew.results.slice(0, 3).map((a) => `New angle: ${a.hook}`),
    latest.run?.mode === 'rules' ? 'Themes grouped by keyword rules. Add the Anthropic key for Claude clustering and angle drafts.' : '',
  ].filter(Boolean);
  return { title: 'Research brief', lines, numbers, link: `${rt.origin}/admin#research` };
}

export async function sendBrief(rt: Runtime, now = Date.now()) {
  const b = await buildBrief(rt, now);
  const id = newId('rr_');
  await rt.env.DB.prepare("INSERT INTO research_runs (id, kind, status, body, started_at, finished_at) VALUES (?, 'brief', 'done', ?, ?, ?)").bind(id, JSON.stringify(b), now, now).run();
  const sent = await notify(rt, { kind: 'digest', title: b.title, lines: b.lines });
  await logAction(rt, { dept: 'research', kind: 'research.brief', actor: 'auto', status: 'done', summary: `Weekly research brief: ${b.numbers.anglesNew} new angles, ${b.numbers.voc} own answers, ${b.numbers.reddit} Reddit items`, detail: b.lines.join('\n'), payload: { runId: id, link: b.link, slack: sent.slack, discord: sent.discord } });
  return { ...b, id, sent };
}

const WEEKDAY = (now: number, tz: string) => {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date(now)).toLowerCase(); } catch { return new Date(now).toUTCString().slice(0, 3).toLowerCase(); }
};

/** From the 5-minute cron: continue today's collection, analyse once it's done, post the brief on its day. */
export async function maybeRunResearch(rt: Runtime, now = Date.now()) {
  const cfg = researchConfig(rt);
  const clock = localClock(now, cfg.tz);
  const out: Record<string, unknown> = {};
  if (cfg.enabled) {
    let s = await loadState(rt);
    if ((!s || s.date !== clock.date) && clock.hour >= cfg.hour) {
      const claim = await rt.env.DB.prepare('INSERT OR IGNORE INTO kv_state (key, value) VALUES (?, ?)').bind(`research:day:${clock.date}`, String(now)).run();
      if (claim.meta.changes) s = await startCollection(rt, clock.date, now);
    }
    let sliced = false;
    if (s && s.date === clock.date && s.idx < s.jobs.length) { s = await collectSlice(rt, s, 3, now); out.collected = s.idx; sliced = true; }
    // The analysis gets a cron run of its own (the tick after the last slice), so no run does both.
    if (!sliced && s && s.date === clock.date && s.idx >= s.jobs.length && !s.analyzed) {
      s.analyzed = true;
      await rt.env.DB.prepare("INSERT INTO kv_state (key, value) VALUES ('research:collect', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(s)).run();
      out.analysis = await runAnalysis(rt, { now });
      await logAction(rt, { dept: 'research', kind: 'research.analyze', actor: 'auto', status: 'done', summary: `Research analysis (${(out.analysis as { mode: string }).mode}): ${(out.analysis as { themes: number }).themes} themes, ${(out.analysis as { anglesAdded: number }).anglesAdded} new angles` });
    }
  }
  if (cfg.briefDay && WEEKDAY(now, cfg.tz) === cfg.briefDay && clock.hour === cfg.briefHour) {
    const claim = await rt.env.DB.prepare('INSERT OR IGNORE INTO kv_state (key, value) VALUES (?, ?)').bind(`research:brief:${clock.date}`, String(now)).run();
    if (claim.meta.changes) out.brief = (await sendBrief(rt, now)).id;
  }
  return Object.keys(out).length ? out : null;
}
