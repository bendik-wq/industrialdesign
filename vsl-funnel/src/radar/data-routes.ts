/**
 * Radar v2 API: /admin/api/radar/data/* (mounted by routes.ts behind requireAdmin; guests read, never change or spend).
 * Studio → Radar → Sources and sweeps (public/assets/studio-radar-data.js): the keyword universe and its themes, the
 * radars built from it, subreddits, Substack publications, platform switches, the full-sweep estimate and run, live
 * sweep progress, the spend meter and the automatic transcripts.
 */
import { Hono } from 'hono';
import { type AppEnv, runtimeFrom } from '../app';
import { RADAR_COPY, ensureSeeded, getWatchlist, listWatchlists, monthSpend, radarConfig, radarStep } from './engine';
import { PLATFORMS, type Platform, SLOTS, searchSlot, slotDef } from './sources';
import { SWEEP_COPY, advanceSweeps, estimateSweep, startSweep, sweepStatus } from './sweep';
import {
  THEMES, addKeywords, addPublication, addSubreddit, cleanTheme, deleteKeyword, deletePublication, deleteSubreddit, ensureThemeRadar, listKeywords, listPublications,
  listSubreddits, platformsOff, setPlatform, setPublication, setSubreddit, updateKeyword,
} from './universe';

export const RADAR_DATA_COPY = {
  ...SWEEP_COPY,
  noKeyword: 'That keyword is not there any more.',
  noSubreddit: 'That subreddit is not on the list.',
  noPublication: 'That publication is not on the list.',
  badPlatform: 'Pick a platform.',
  noRadar: 'That radar is not there any more.',
};

export const radarData = new Hono<AppEnv>();
const body = async (c: { req: { json: <T>() => Promise<T> } }) => c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));

const PLATFORM_LABEL: Record<Platform, string> = { youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram', meta_ads: 'Meta ads', x: 'X', linkedin: 'LinkedIn', reddit: 'Reddit', substack: 'Substack' };

radarData.get('/state', async (c) => {
  const rt = runtimeFrom(c);
  await ensureSeeded(rt);
  const cfg = radarConfig(rt);
  const [spend, off, radars, keywords, subreddits, publications, sweeps, active, tools, counts] = await Promise.all([
    monthSpend(rt), platformsOff(rt), listWatchlists(rt), listKeywords(rt), listSubreddits(rt), listPublications(rt), sweepStatus(rt, 5),
    rt.env.DB.prepare("SELECT COUNT(*) AS n FROM radar_runs WHERE status IN ('pending','running')").first<{ n: number }>(),
    rt.env.DB.prepare('SELECT slot, provider, endpoint, confirmed_at FROM radar_tools WHERE selected = 1').all<{ slot: string; provider: string; endpoint: string; confirmed_at: string | null }>(),
    rt.env.DB.prepare("SELECT platform, COUNT(*) AS n, SUM(CASE WHEN transcript IS NOT NULL OR body_text IS NOT NULL THEN 1 ELSE 0 END) AS with_text FROM radar_items GROUP BY platform").all<{ platform: string; n: number; with_text: number }>(),
  ]);
  const themeIds = [...new Set([...THEMES.map((t) => t.id), ...keywords.map((k) => k.theme)])];
  return c.json({
    key: cfg.key,
    config: { budget_usd: cfg.budgetUsd, pages: cfg.pages, auto_transcribe: cfg.autoTranscribe, schedule_hours: cfg.scheduleHours, max_items: cfg.maxItems, instagram: cfg.instagram },
    spend: { spent_micros: spend.spent, reserved_micros: spend.reserved, budget_micros: cfg.budgetMicros, runs: spend.runs },
    active_runs: Number(active?.n ?? 0),
    platforms: PLATFORMS.map((p) => {
      const slot = searchSlot(p);
      const sel = tools.results.find((t) => t.slot === slot);
      const cnt = counts.results.find((x) => x.platform === p);
      return { platform: p, label: PLATFORM_LABEL[p], on: !off.has(p) && !(p === 'instagram' && !cfg.instagram), switchable: !(p === 'instagram' && !cfg.instagram), source: sel ? `${sel.provider} ${sel.endpoint}` : null, confirmed: Boolean(sel?.confirmed_at), items: Number(cnt?.n ?? 0), with_text: Number(cnt?.with_text ?? 0) };
    }),
    themes: themeIds.map((id) => {
      const def = THEMES.find((t) => t.id === id);
      const ks = keywords.filter((k) => k.theme === id);
      return { id, name: def?.name ?? id.replace(/_/g, ' '), tier: def?.tier ?? (ks[0]?.tier ?? 'adjacent'), keywords: ks.map((k) => ({ id: k.id, keyword: k.keyword, tier: k.tier, enabled: Boolean(k.enabled) })) };
    }),
    radars, subreddits, publications, sweeps,
    slots: SLOTS.map((d) => ({ slot: d.slot, label: d.label, platform: d.platform })),
    copy: { noKey: RADAR_COPY.noKey },
  });
});

/** What a full sweep (or one radar, ?radar=<id>) would cost, before it runs. */
radarData.get('/estimate', async (c) => {
  const rt = runtimeFrom(c);
  const radar = c.req.query('radar');
  return c.json(await estimateSweep(rt, radar ? { radarIds: [radar], sources: false } : {}));
});

/** Start a sweep: every enabled radar, subreddit and publication (or the given radars), then step it in the background. */
radarData.post('/sweep', async (c) => {
  const rt = runtimeFrom(c);
  const b = await body(c);
  const ids = Array.isArray(b.radar_ids) ? b.radar_ids.map(String).filter(Boolean).slice(0, 50) : null;
  if (!radarConfig(rt).key) return c.json({ ok: false, error: RADAR_COPY.noKey }, 400);
  const est = await estimateSweep(rt, ids ? { radarIds: ids, sources: b.sources === true } : {});
  if (!est.fits && b.confirm_over !== true) return c.json({ ok: false, error: SWEEP_COPY.overBudget, estimate: est }, 400);
  const s = await startSweep(rt, ids ? 'radar' : 'full', { radarIds: ids, sources: ids ? b.sources === true : true });
  if (s.queued) rt.waitUntil(radarStep(rt, { budgetMs: 25_000, maxStart: 25 }).then(() => advanceSweeps(rt)).then(() => undefined));
  return c.json({ ...s, error: s.ok ? undefined : s.notes[0] ?? SWEEP_COPY.nothing, message: s.ok ? SWEEP_COPY.started : undefined }, s.ok ? 200 : 400);
});

/** One step of the queue (the page calls this while a sweep runs, so progress does not wait for the cron). */
radarData.post('/step', async (c) => {
  const rt = runtimeFrom(c);
  if (!radarConfig(rt).key) return c.json({ ok: false, error: RADAR_COPY.noKey }, 400);
  const step = await radarStep(rt, { budgetMs: 20_000, maxStart: 20 });
  await advanceSweeps(rt);
  return c.json({ ok: true, step, sweeps: await sweepStatus(rt, 3) });
});

radarData.get('/sweeps', async (c) => c.json({ sweeps: await sweepStatus(runtimeFrom(c), Math.max(1, Math.min(20, Number(c.req.query('limit')) || 5))) }));

radarData.post('/platforms', async (c) => {
  const rt = runtimeFrom(c);
  const b = await body(c);
  if (!(PLATFORMS as readonly string[]).includes(String(b.platform))) return c.json({ ok: false, error: RADAR_DATA_COPY.badPlatform }, 400);
  await setPlatform(rt, b.platform as Platform, b.on !== false);
  return c.json({ ok: true, off: [...(await platformsOff(rt))] });
});

// ───────────── radars (partial changes: switch, platforms, X floor, pages, window) ─────────────

radarData.patch('/radars/:id', async (c) => {
  const rt = runtimeFrom(c);
  const id = c.req.param('id');
  const wl = await getWatchlist(rt, id);
  if (!wl) return c.json({ ok: false, error: RADAR_DATA_COPY.noRadar }, 404);
  const b = await body(c);
  const sets: string[] = []; const args: unknown[] = [];
  if (b.enabled !== undefined) { sets.push('enabled = ?'); args.push(b.enabled ? 1 : 0); }
  if (Array.isArray(b.platforms)) {
    const ps = [...new Set(b.platforms.map(String))].filter((p) => slotDef(searchSlot(p as Platform)) && p !== 'substack');
    if (!ps.length) return c.json({ ok: false, error: 'Pick at least one platform.' }, 400);
    sets.push('platforms_json = ?'); args.push(JSON.stringify(ps));
  }
  const n = (v: unknown, lo: number, hi: number) => (v === '' || v === null ? null : isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Math.round(Number(v)))) : undefined);
  for (const [k, lo, hi] of [['min_faves', 0, 1_000_000], ['pages', 1, 10], ['since_days', 1, 3650]] as const) {
    if (b[k] === undefined) continue;
    const v = n(b[k], lo, hi);
    if (v === undefined) continue;
    sets.push(`${k} = ?`); args.push(v);
  }
  if (!sets.length) return c.json({ ok: true, radar: wl });
  await rt.env.DB.prepare(`UPDATE radar_watchlists SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).bind(...args, new Date().toISOString(), id).run();
  return c.json({ ok: true, radar: await getWatchlist(rt, id) });
});

// ───────────── the keyword universe ─────────────

radarData.post('/keywords', async (c) => {
  const rt = runtimeFrom(c);
  const b = await body(c);
  const r = await addKeywords(rt, b.theme, b.tier, b.keywords);
  if (typeof r === 'string') return c.json({ ok: false, error: r }, 400);
  // A new theme gets its own radar, so its keywords are searched.
  const radar = await ensureThemeRadar(rt, cleanTheme(b.theme), b.tier === 'in' ? 'in' : 'adjacent', typeof b.theme_name === 'string' ? b.theme_name : undefined);
  return c.json({ ok: true, ...r, radar });
});

radarData.put('/keywords/:id', async (c) => {
  const rt = runtimeFrom(c);
  const r = await updateKeyword(rt, c.req.param('id'), await body(c));
  if (typeof r === 'string') return c.json({ ok: false, error: r }, 400);
  return r ? c.json({ ok: true }) : c.json({ ok: false, error: RADAR_DATA_COPY.noKeyword }, 404);
});

radarData.delete('/keywords/:id', async (c) => (await deleteKeyword(runtimeFrom(c), c.req.param('id')) ? c.json({ ok: true }) : c.json({ ok: false, error: RADAR_DATA_COPY.noKeyword }, 404)));

// ───────────── subreddits and publications ─────────────

radarData.post('/subreddits', async (c) => {
  const b = await body(c);
  const r = await addSubreddit(runtimeFrom(c), b.name, b.niche);
  return typeof r === 'string' ? c.json({ ok: false, error: r }, 400) : c.json({ ok: true, ...r });
});
radarData.put('/subreddits/:name', async (c) => (await setSubreddit(runtimeFrom(c), c.req.param('name'), await body(c)) ? c.json({ ok: true }) : c.json({ ok: false, error: RADAR_DATA_COPY.noSubreddit }, 404)));
radarData.delete('/subreddits/:name', async (c) => (await deleteSubreddit(runtimeFrom(c), c.req.param('name')) ? c.json({ ok: true }) : c.json({ ok: false, error: RADAR_DATA_COPY.noSubreddit }, 404)));

radarData.post('/publications', async (c) => {
  const b = await body(c);
  const r = await addPublication(runtimeFrom(c), b.url, b.name, b.niche);
  return typeof r === 'string' ? c.json({ ok: false, error: r }, 400) : c.json({ ok: true, ...r });
});
radarData.put('/publications/:id', async (c) => (await setPublication(runtimeFrom(c), c.req.param('id'), await body(c)) ? c.json({ ok: true }) : c.json({ ok: false, error: RADAR_DATA_COPY.noPublication }, 404)));
radarData.delete('/publications/:id', async (c) => (await deletePublication(runtimeFrom(c), c.req.param('id')) ? c.json({ ok: true }) : c.json({ ok: false, error: RADAR_DATA_COPY.noPublication }, 404)));
