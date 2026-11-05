/**
 * Radar API: /admin/api/radar/* (owner; guests read-only: every non-GET is refused by requireAdmin's guest gate).
 * Every Monid call is server-side; nothing here waits for a scrape to finish (runs are queued and stepped).
 */
import { Hono } from 'hono';
import { type AppEnv, type Runtime, runtimeFrom } from '../app';
import { requireAdmin } from '../admin/auth';
import { ctaFor, pickFramework } from '../studio/copy-brain';
import { brainOf, saveScript, writeStudioScript } from '../studio/scripts';
import { type Analysis, type AnalyseInput, analyseWithBrain, scriptContext } from './analyse';
import {
  RADAR_COPY, type ToolRow, cleanWatchlist, digest, ensureSeeded, getItem, getWatchlist, listItems, listWatchlists, monthSpend, previewFor,
  queueTranscript, queueWatchlist, radarConfig, radarStep, recentRuns,
} from './engine';
import { radarFormatsAdmin } from './formats-routes';
import { MonidError, monidClient, parsePrice } from './monid';
import { type RadarQuery, SLOTS, type Slot, builtinFor, isRecommended, isSlot, knownRank, slotDef } from './sources';
import { radarData } from './data-routes';
import { advanceSweeps } from './sweep';

export const RADAR_UI_COPY = {
  notFound: 'That item is not there any more.',
  noBrain: 'No analyst is available here. Add the Anthropic key in Integrations, or run where Workers AI is available.',
  failed: 'The analysis did not finish this time. Try again in a minute.',
  scriptFailed: 'The script could not be written this time. Try again in a minute.',
  noAnalysis: 'Analyse this first, then make it a script.',
  noWatchlist: 'That radar is not there any more.',
};

export const radarAdmin = new Hono<AppEnv>();
radarAdmin.use('*', requireAdmin);
// Radar v2: keyword universe, subreddits, publications, platform switches, sweeps (Studio → Radar → Sources and sweeps).
radarAdmin.route('/data', radarData);
// Radar v2 (builder C): viral formats, adaptations and the analysis pipeline (src/radar/formats-routes.ts).
radarAdmin.route('/formats', radarFormatsAdmin);

const parse = <T>(s: string | null | undefined, d: T): T => { try { return s ? (JSON.parse(s) as T) : d; } catch { return d; } };
const body = async (c: { req: { json: <T>() => Promise<T> } }) => c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
const errMsg = (e: unknown, d: string) => (e instanceof MonidError ? e.message : e instanceof Error && /declined|too long|without a hook|not a script|no beats/.test(e.message) ? e.message : d);

async function toolsBySlot(rt: Runtime) {
  const { results } = await rt.env.DB.prepare('SELECT * FROM radar_tools ORDER BY slot, selected DESC, recommended DESC, found_at DESC').all<ToolRow>();
  return results;
}

/** A query to preview a slot's input with: the first radar that uses the platform, or its niche keywords. */
async function sampleQuery(rt: Runtime, slot: Slot): Promise<RadarQuery> {
  const def = slotDef(slot)!;
  const cfg = radarConfig(rt);
  if (def.kind === 'transcript') return { keywords: [], max: 1, urls: [def.platform === 'youtube' ? 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' : def.platform === 'instagram' ? 'https://www.instagram.com/reel/C0000000000/' : 'https://www.tiktok.com/@creator/video/7300000000000000000'], durationS: 60 };
  if (def.slot === 'reddit:subreddit') return { keywords: [], max: cfg.maxItems, subreddit: 'smallbusiness', sinceDays: 31 };
  if (def.slot === 'substack:posts') return { keywords: [], max: cfg.maxItems, publication: 'https://www.notboring.co' };
  const wl = (await listWatchlists(rt)).find((w) => w.platforms.includes(def.platform));
  return { keywords: wl?.keywords ?? ['business acquisition'], max: cfg.maxItems, sinceDays: wl?.since_days ?? null, country: wl?.country ?? null, maxKeywords: wl?.theme ? 60 : undefined, minFaves: wl?.min_faves ?? (wl?.niche === 'out' ? 1000 : 200) };
}

radarAdmin.get('/state', async (c) => {
  const rt = runtimeFrom(c);
  await ensureSeeded(rt);
  const cfg = radarConfig(rt);
  const [spend, watchlists, tools, counts, runs] = await Promise.all([
    monthSpend(rt), listWatchlists(rt), toolsBySlot(rt),
    rt.env.DB.prepare('SELECT platform, COUNT(*) AS n, SUM(CASE WHEN analysis_json IS NOT NULL THEN 1 ELSE 0 END) AS analysed FROM radar_items GROUP BY platform').all<{ platform: string; n: number; analysed: number }>(),
    rt.env.DB.prepare("SELECT COUNT(*) AS n FROM radar_runs WHERE status IN ('pending','running')").first<{ n: number }>(),
  ]);
  const slots = SLOTS.map((d) => {
    const sel = tools.find((t) => t.slot === d.slot && t.selected);
    return {
      slot: d.slot, platform: d.platform, kind: d.kind, label: d.label,
      off: d.platform === 'instagram' && !cfg.instagram,
      candidates: tools.filter((t) => t.slot === d.slot).length,
      selected: sel ? { provider: sel.provider, endpoint: sel.endpoint, name: sel.name, price: parsePrice(parse(sel.price_json, null)), confirmed: Boolean(sel.confirmed_at) } : null,
    };
  });
  return c.json({
    key: cfg.key,
    brain: brainOf(rt),
    config: { budget_usd: cfg.budgetUsd, max_items: cfg.maxItems, instagram: cfg.instagram, schedule_hours: cfg.scheduleHours },
    spend: { spent_micros: spend.spent, reserved_micros: spend.reserved, budget_micros: cfg.budgetMicros, runs: spend.runs },
    active_runs: Number(runs?.n ?? 0),
    watchlists, slots,
    counts: counts.results,
    copy: { retention: RADAR_COPY.retention, adSpend: RADAR_COPY.adSpend, instagramOff: RADAR_COPY.instagramOff, noKey: RADAR_COPY.noKey },
  });
});

// ───────────── sources ─────────────

radarAdmin.get('/sources', async (c) => {
  const rt = runtimeFrom(c);
  const tools = await toolsBySlot(rt);
  return c.json({
    slots: SLOTS.map((d) => ({
      slot: d.slot, label: d.label, platform: d.platform, kind: d.kind,
      tools: tools.filter((t) => t.slot === d.slot).map((t) => ({
        provider: t.provider, endpoint: t.endpoint, name: t.name, description: t.description, doc_url: t.doc_url,
        price: parsePrice(parse(t.price_json, null)), recommended: Boolean(t.recommended), selected: Boolean(t.selected), confirmed: Boolean(t.confirmed_at),
        template: parse(t.template_json, null), has_schema: Boolean(t.schema_json), builtin: Boolean(builtinFor(t.provider, t.endpoint, t.slot)),
      })),
    })),
  });
});

/** Find sources for one slot: discover, inspect the top candidates, store them, pre-select a known actor. */
radarAdmin.post('/sources/find', async (c) => {
  const rt = runtimeFrom(c);
  const b = await body(c);
  if (!isSlot(b.slot)) return c.json({ ok: false, error: 'Pick a platform.' }, 400);
  const def = slotDef(b.slot)!;
  const cfg = radarConfig(rt);
  if (!cfg.key) return c.json({ ok: false, error: RADAR_COPY.noKey }, 400);
  if (def.platform === 'instagram' && !cfg.instagram) return c.json({ ok: false, error: RADAR_COPY.instagramOff }, 400);
  try {
    const client = monidClient(rt.settings.MONID_API_KEY);
    const found = await client.discover(def.query, 10);
    // The slot's default tool is always a candidate, even when discover did not list it this time.
    const [dp, de] = def.known[0]?.includes(' ') ? def.known[0].split(' ') : [];
    if (dp && de && !found.some((t) => knownRank(def.slot, t.provider, t.endpoint) === 0)) found.unshift({ provider: dp, endpoint: de });
    const rank = (r: number) => (r < 0 ? 99 : r);
    const ranked = found
      .map((t) => ({ t, rec: isRecommended(def.slot, t.provider, t.endpoint), known: rank(knownRank(def.slot, t.provider, t.endpoint)), fit: def.match(t.endpoint) || def.match(`${t.name ?? ''} ${t.description ?? ''}`) }))
      .sort((a, b2) => Number(b2.rec) - Number(a.rec) || a.known - b2.known || Number(b2.fit) - Number(a.fit))
      .slice(0, 6);
    const now = new Date().toISOString();
    let inspected = 0;
    for (const [i, { t, rec }] of ranked.entries()) {
      let full = t;
      if (i < 4) { try { full = { ...t, ...(await client.inspect(t.provider, t.endpoint)) }; inspected++; } catch (e) { console.warn('radar inspect failed', e instanceof Error ? e.message : e); } }
      await rt.env.DB.prepare(
        `INSERT INTO radar_tools (slot, provider, endpoint, name, description, price_json, schema_json, doc_url, recommended, found_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(slot, provider, endpoint) DO UPDATE SET name = excluded.name, description = excluded.description, price_json = COALESCE(excluded.price_json, radar_tools.price_json),
           schema_json = COALESCE(excluded.schema_json, radar_tools.schema_json), doc_url = COALESCE(excluded.doc_url, radar_tools.doc_url), recommended = excluded.recommended, found_at = excluded.found_at`,
      ).bind(def.slot, full.provider, full.endpoint, full.name ?? null, (full.description ?? full.summary ?? null)?.slice(0, 600) ?? null, full.price ? JSON.stringify(full.price) : null,
        full.inputSchema ? JSON.stringify(full.inputSchema).slice(0, 60_000) : null, full.docUrl ?? null, rec ? 1 : 0, now).run();
    }
    const hasSel = await rt.env.DB.prepare('SELECT 1 FROM radar_tools WHERE slot = ? AND selected = 1').bind(def.slot).first();
    const rec = ranked.find((x) => x.rec);
    if (!hasSel && rec) await rt.env.DB.prepare('UPDATE radar_tools SET selected = 1 WHERE slot = ? AND provider = ? AND endpoint = ?').bind(def.slot, rec.t.provider, rec.t.endpoint).run();
    return c.json({ ok: true, found: ranked.length, inspected, preselected: !hasSel && rec ? `${rec.t.provider} ${rec.t.endpoint}` : null });
  } catch (e) {
    return c.json({ ok: false, error: errMsg(e, 'Finding sources did not work this time. Try again.') }, 502);
  }
});

/** Pick a tool for a slot (any provider + endpoint; one Monid did not list is inspected first), with an optional input template. */
radarAdmin.post('/sources/select', async (c) => {
  const rt = runtimeFrom(c);
  const b = await body(c);
  if (!isSlot(b.slot)) return c.json({ ok: false, error: 'Pick a platform.' }, 400);
  const provider = String(b.provider ?? '').trim().slice(0, 80);
  let endpoint = String(b.endpoint ?? '').trim().slice(0, 200);
  if (!provider || !endpoint) return c.json({ ok: false, error: 'Give the provider and the endpoint.' }, 400);
  if (!endpoint.startsWith('/')) endpoint = `/${endpoint}`;
  let template: Record<string, unknown> | null = null;
  if (b.template != null && b.template !== '') {
    const t = typeof b.template === 'string' ? parse<unknown>(b.template, undefined) : b.template;
    if (!t || typeof t !== 'object' || Array.isArray(t)) return c.json({ ok: false, error: 'The input template must be a JSON object.' }, 400);
    template = t as Record<string, unknown>;
  }
  const row = await rt.env.DB.prepare('SELECT 1 FROM radar_tools WHERE slot = ? AND provider = ? AND endpoint = ?').bind(b.slot, provider, endpoint).first();
  if (!row) {
    if (!radarConfig(rt).key) return c.json({ ok: false, error: RADAR_COPY.noKey }, 400);
    try {
      const t = await monidClient(rt.settings.MONID_API_KEY).inspect(provider, endpoint);
      await rt.env.DB.prepare('INSERT INTO radar_tools (slot, provider, endpoint, name, description, price_json, schema_json, doc_url, recommended, found_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(b.slot, provider, endpoint, t.name ?? null, (t.description ?? t.summary ?? null)?.slice(0, 600) ?? null, t.price ? JSON.stringify(t.price) : null, t.inputSchema ? JSON.stringify(t.inputSchema).slice(0, 60_000) : null, t.docUrl ?? null, isRecommended(b.slot, provider, endpoint) ? 1 : 0, new Date().toISOString()).run();
    } catch (e) {
      return c.json({ ok: false, error: errMsg(e, 'Monid could not describe that tool.') }, 502);
    }
  }
  await rt.env.DB.batch([
    rt.env.DB.prepare('UPDATE radar_tools SET selected = 0, confirmed_at = NULL WHERE slot = ?').bind(b.slot),
    rt.env.DB.prepare('UPDATE radar_tools SET selected = 1, template_json = ?, confirmed_at = NULL WHERE slot = ? AND provider = ? AND endpoint = ?').bind(template ? JSON.stringify(template) : null, b.slot, provider, endpoint),
  ]);
  return c.json({ ok: true });
});

/** The exact input the picked tool gets for a sample query, and what it would cost. */
radarAdmin.get('/sources/preview', async (c) => {
  const rt = runtimeFrom(c);
  const slot = c.req.query('slot');
  if (!isSlot(slot)) return c.json({ ok: false, error: 'Pick a platform.' }, 400);
  const tool = await rt.env.DB.prepare('SELECT * FROM radar_tools WHERE slot = ? AND selected = 1').bind(slot).first<ToolRow>();
  if (!tool) return c.json({ ok: false, error: RADAR_COPY.noSource(slotDef(slot)!.label) }, 404);
  const q = await sampleQuery(rt, slot);
  return c.json({ ok: true, slot, provider: tool.provider, endpoint: tool.endpoint, query: q, confirmed: Boolean(tool.confirmed_at), ...previewFor(tool, q) });
});

radarAdmin.post('/sources/confirm', async (c) => {
  const rt = runtimeFrom(c);
  const b = await body(c);
  if (!isSlot(b.slot)) return c.json({ ok: false, error: 'Pick a platform.' }, 400);
  const r = await rt.env.DB.prepare('UPDATE radar_tools SET confirmed_at = ? WHERE slot = ? AND selected = 1').bind(new Date().toISOString(), b.slot).run();
  return (r.meta?.changes ?? 0) ? c.json({ ok: true }) : c.json({ ok: false, error: RADAR_COPY.noSource(slotDef(b.slot)!.label) }, 404);
});

// ───────────── watchlists ─────────────

radarAdmin.get('/watchlists', async (c) => c.json({ watchlists: await listWatchlists(runtimeFrom(c)) }));

radarAdmin.post('/watchlists', async (c) => {
  const rt = runtimeFrom(c);
  const w = cleanWatchlist(await body(c));
  if (typeof w === 'string') return c.json({ ok: false, error: w }, 400);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await rt.env.DB.prepare('INSERT INTO radar_watchlists (id, name, keywords_json, platforms_json, niche, country, since_days, enabled, created_at, updated_at, theme, min_faves, pages) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, w.name, JSON.stringify(w.keywords), JSON.stringify(w.platforms), w.niche, w.country, w.since_days, w.enabled ? 1 : 0, now, now, w.theme ?? null, w.min_faves ?? null, w.pages ?? null).run();
  return c.json({ ok: true, watchlist: await getWatchlist(rt, id) });
});

radarAdmin.put('/watchlists/:id', async (c) => {
  const rt = runtimeFrom(c);
  const w = cleanWatchlist(await body(c));
  if (typeof w === 'string') return c.json({ ok: false, error: w }, 400);
  // A themed radar keeps its theme (and its keywords come from the universe) unless the body names another.
  const r = await rt.env.DB.prepare('UPDATE radar_watchlists SET name = ?, keywords_json = CASE WHEN ? IS NOT NULL OR theme IS NULL THEN ? ELSE keywords_json END, platforms_json = ?, niche = ?, country = ?, since_days = ?, enabled = ?, theme = COALESCE(?, theme), min_faves = ?, pages = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
    .bind(w.name, w.keywords.length ? 1 : null, JSON.stringify(w.keywords), JSON.stringify(w.platforms), w.niche, w.country, w.since_days, w.enabled ? 1 : 0, w.theme ?? null, w.min_faves ?? null, w.pages ?? null, new Date().toISOString(), c.req.param('id')).run();
  return (r.meta?.changes ?? 0) ? c.json({ ok: true, watchlist: await getWatchlist(rt, c.req.param('id')) }) : c.json({ ok: false, error: RADAR_UI_COPY.noWatchlist }, 404);
});

radarAdmin.delete('/watchlists/:id', async (c) => {
  const rt = runtimeFrom(c);
  const r = await rt.env.DB.prepare('UPDATE radar_watchlists SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').bind(new Date().toISOString(), c.req.param('id')).run();
  return (r.meta?.changes ?? 0) ? c.json({ ok: true }) : c.json({ ok: false, error: RADAR_UI_COPY.noWatchlist }, 404);
});

/** Run one radar now: queue its runs, then take one short step in the background. */
radarAdmin.post('/watchlists/:id/run', async (c) => {
  const rt = runtimeFrom(c);
  const wl = await getWatchlist(rt, c.req.param('id'));
  if (!wl) return c.json({ ok: false, error: RADAR_UI_COPY.noWatchlist }, 404);
  const q = await queueWatchlist(rt, wl);
  if (q.queued) rt.waitUntil(radarStep(rt, { budgetMs: 25_000 }).then(() => undefined));
  return c.json({ ok: q.queued > 0, queued: q.queued, est_micros: q.est_micros, notes: q.notes, error: q.queued ? undefined : q.notes[0] }, q.queued ? 200 : 400);
});

/** Advance the queue now (start pending runs, check running ones). */
radarAdmin.post('/step', async (c) => {
  const rt = runtimeFrom(c);
  if (!radarConfig(rt).key) return c.json({ ok: false, error: RADAR_COPY.noKey }, 400);
  const out = await radarStep(rt, { budgetMs: 20_000 });
  await advanceSweeps(rt);
  return c.json({ ok: true, ...out });
});

radarAdmin.get('/runs', async (c) => c.json({ runs: await recentRuns(runtimeFrom(c)) }));

// ───────────── items ─────────────

radarAdmin.get('/items', async (c) => {
  const rt = runtimeFrom(c);
  const q = c.req.query();
  return c.json({ items: await listItems(rt, { platform: q.platform, niche: q.niche, radar: q.radar, sort: q.sort, limit: Number(q.limit) || undefined, all: q.all === '1' }) });
});

radarAdmin.get('/items/:id', async (c) => {
  const item = await getItem(runtimeFrom(c), c.req.param('id'));
  return item ? c.json({ item }) : c.json({ ok: false, error: RADAR_UI_COPY.notFound }, 404);
});

radarAdmin.post('/items/:id/transcript', async (c) => {
  const rt = runtimeFrom(c);
  const r = await queueTranscript(rt, c.req.param('id'));
  if (r.ok) rt.waitUntil(radarStep(rt, { budgetMs: 25_000 }).then(() => undefined));
  return c.json({ ok: r.ok, error: r.note }, r.ok ? 200 : 400);
});

type ItemRow = AnalyseInput & { id: string; analysis_json: string | null };

/** Analyse one item (cached; this re-runs it). */
radarAdmin.post('/items/:id/analyse', async (c) => {
  const rt = runtimeFrom(c);
  const item = await rt.env.DB.prepare('SELECT * FROM radar_items WHERE id = ?').bind(c.req.param('id')).first<ItemRow>();
  if (!item) return c.json({ ok: false, error: RADAR_UI_COPY.notFound }, 404);
  const brain = brainOf(rt);
  if (!brain) return c.json({ ok: false, error: RADAR_UI_COPY.noBrain }, 400);
  try {
    const out = await analyseWithBrain(rt, brain, item);
    const now = new Date().toISOString();
    await rt.env.DB.prepare('UPDATE radar_items SET analysis_json = ?, analysis_brain = ?, analysis_flags = ?, analyzed_at = ? WHERE id = ?')
      .bind(JSON.stringify(out.analysis), brain, JSON.stringify(out.flags), now, item.id).run();
    return c.json({ ok: true, analysis: out.analysis, flags: out.flags, brain, analyzed_at: now });
  } catch (e) {
    console.error('radar analysis failed', e instanceof Error ? e.message : e);
    return c.json({ ok: false, error: errMsg(e, RADAR_UI_COPY.failed) }, 502);
  }
});

/** "Make it a script": a Studio script written from the analysis, ready in Studio → Scripts. */
radarAdmin.post('/items/:id/script', async (c) => {
  const rt = runtimeFrom(c);
  const item = await rt.env.DB.prepare('SELECT * FROM radar_items WHERE id = ?').bind(c.req.param('id')).first<ItemRow & { ad_active_days: number | null }>();
  if (!item) return c.json({ ok: false, error: RADAR_UI_COPY.notFound }, 404);
  const a = parse<Analysis | null>(item.analysis_json, null);
  if (!a) return c.json({ ok: false, error: RADAR_UI_COPY.noAnalysis }, 400);
  const brain = brainOf(rt);
  if (!brain) return c.json({ ok: false, error: RADAR_UI_COPY.noBrain }, 400);
  const b = await body(c);
  const longForm = item.platform === 'youtube' && (item.duration_s ?? 0) > 180;
  const format = b.format === 'long' || b.format === 'short' ? b.format : longForm ? 'long' : 'short';
  const icp = 'ceiling' as const;
  const framework = pickFramework(format, icp);
  const topic = (a.for_gl.angles[0] || a.topic || a.for_gl.hook).slice(0, 600);
  try {
    const written = await writeStudioScript(rt, brain, { topic, context: scriptContext(a, item), format, icp, framework, cta: ctaFor(format, rt.settings.STUDIO_SCRIPT_CTA), notes: rt.settings.STUDIO_SCRIPT_NOTES || undefined });
    const row = await saveScript(rt, { topic, source: 'radar', source_ref: item.id, format, icp, framework, brain, ...written });
    await rt.env.DB.prepare('UPDATE radar_items SET script_id = ? WHERE id = ?').bind(row.id, item.id).run();
    return c.json({ ok: true, script: { id: row.id, title: row.title, beats: row.script.beats.length, flags: row.flags.length } });
  } catch (e) {
    console.error('radar script failed', e instanceof Error ? e.message : e);
    return c.json({ ok: false, error: errMsg(e, RADAR_UI_COPY.scriptFailed) }, 502);
  }
});

radarAdmin.get('/digest', async (c) => {
  const days = Math.max(1, Math.min(60, Number(c.req.query('days')) || 7));
  return c.json(await digest(runtimeFrom(c), Date.now(), days));
});
