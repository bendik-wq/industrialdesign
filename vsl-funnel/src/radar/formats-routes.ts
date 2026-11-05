/**
 * Radar v2 API (builder C): /admin/api/radar/formats/* : viral formats, the format sheet, per-item format and
 * adaptation, and the analysis pipeline (Run analysis). Owner only for anything that writes or spends; guests read.
 */
import { Hono } from 'hono';
import { type AppEnv, runtimeFrom } from '../app';
import { brainOf } from '../studio/scripts';
import { adaptFull, adaptSourceForItem, latestAdaptation } from './adapt';
import { askJson } from './analyse';
import { EXTRACT_SCHEMA, type ExtractInput, extractBatch, getExtraction, getFormat, listFormats, radarFormatConfig } from './formats';
import { PIPELINE_COPY, RADAR_GRAPH, formatSource, latestRun, modelsFor, nodeStates, startPipeline } from './pipeline-flow';

export const FORMATS_COPY = {
  notFound: 'That format is not there any more.',
  itemNotFound: 'That item is not there any more.',
  noBrain: PIPELINE_COPY.noBrain,
  failed: 'That did not finish this time. Try again in a minute.',
  noFormat: 'Read the format first, then adapt it.',
  readFailed: 'The format could not be read from this item. Try again in a minute.',
};

export const radarFormatsAdmin = new Hono<AppEnv>();
// Mounted inside radarAdmin (src/radar/routes.ts), whose requireAdmin covers every path here.

const errMsg = (e: unknown) => (e instanceof Error && /declined|too long|without|not a script|no beats/.test(e.message) ? e.message : FORMATS_COPY.failed);

async function scriptSummary(rt: ReturnType<typeof runtimeFrom>, id: string | null) {
  if (!id) return null;
  const r = await rt.env.DB.prepare('SELECT id, title, format, data, flags FROM studio_scripts WHERE id = ? AND deleted_at IS NULL').bind(id).first<{ id: string; title: string | null; format: string; data: string; flags: string | null }>();
  if (!r) return null;
  let script: unknown = null; try { script = JSON.parse(r.data); } catch { /* keep null */ }
  let flags: unknown[] = []; try { flags = JSON.parse(r.flags ?? '[]'); } catch { /* keep [] */ }
  return { id: r.id, title: r.title, format: r.format, script, flags };
}

/** The ranked formats, the latest pipeline run with each node's state, and the counts. */
radarFormatsAdmin.get('/', async (c) => {
  const rt = runtimeFrom(c);
  const ws = c.req.query('white') === '1';
  const [formats, run, counts] = await Promise.all([
    listFormats(rt, { whiteSpace: ws, limit: Number(c.req.query('limit')) || 60 }),
    latestRun(rt),
    rt.env.DB.prepare("SELECT (SELECT COUNT(*) FROM radar_items) AS items, (SELECT COUNT(*) FROM radar_item_formats WHERE error IS NULL AND format_name != '') AS extracted, (SELECT COUNT(*) FROM radar_adaptations WHERE status != 'failed') AS adaptations").first<{ items: number; extracted: number; adaptations: number }>(),
  ]);
  const scores = new Map<string, number | null>();
  if (formats.length) {
    const { results } = await rt.env.DB.prepare(`SELECT format_id, judge_score FROM radar_adaptations WHERE format_id IN (${formats.map(() => '?').join(',')}) AND status != 'failed' ORDER BY created_at`).bind(...formats.map((f) => f.id)).all<{ format_id: string; judge_score: number | null }>();
    for (const r of results) scores.set(r.format_id, r.judge_score);
  }
  return c.json({
    formats: formats.map(({ member_ids, ...f }) => ({ ...f, members: member_ids.length, judge_score: scores.get(f.id) ?? null, adapted: scores.has(f.id) })),
    run: run ? { id: run.id, status: run.status, trigger: run.trigger, node: run.node, started_at: run.started_at, updated_at: run.updated_at, finished_at: run.finished_at, error: run.error, mode: run.flow_id ? 'workflow' : 'inline' } : null,
    nodes: nodeStates(run),
    graph: RADAR_GRAPH,
    counts: counts ?? { items: 0, extracted: 0, adaptations: 0 },
    brain: brainOf(rt),
    config: radarFormatConfig(rt),
  });
});

/** Start the analysis pipeline now. */
radarFormatsAdmin.post('/run', async (c) => {
  const rt = runtimeFrom(c);
  const r = await startPipeline(rt, 'button');
  return c.json(r, r.ok ? 200 : r.id ? 409 : 400);
});

/** The format sheet: the format, its examples with their breakdowns, and the latest adaptation with its script. */
radarFormatsAdmin.get('/f/:id', async (c) => {
  const rt = runtimeFrom(c);
  const f = await getFormat(rt, c.req.param('id'));
  if (!f) return c.json({ ok: false, error: FORMATS_COPY.notFound }, 404);
  const ids = f.member_ids.slice(0, 12);
  const { results } = ids.length
    ? await rt.env.DB.prepare(`SELECT i.id, i.platform, i.title, i.author, i.url, i.thumbnail_url, i.views, i.score, i.niche, substr(COALESCE(i.caption, ''), 1, 400) AS caption, f.data_json FROM radar_items i JOIN radar_item_formats f ON f.item_id = i.id WHERE i.id IN (${ids.map(() => '?').join(',')}) ORDER BY i.score DESC`).bind(...ids).all<Record<string, unknown> & { data_json: string }>()
    : { results: [] };
  const examples = results.map(({ data_json, ...r }) => { let x = null; try { x = JSON.parse(data_json); } catch { /* none */ } return { ...r, extraction: x }; });
  const a = await latestAdaptation(rt, { format_id: f.id });
  return c.json({ format: f, examples, adaptation: a, script: await scriptSummary(rt, a?.script_id ?? null) });
});

/** Adapt one format now (adapt → judge ⇄ rewrite → store). `force` writes a new one even if nothing changed. */
radarFormatsAdmin.post('/f/:id/adapt', async (c) => {
  const rt = runtimeFrom(c);
  const m = modelsFor(rt);
  if (!m) return c.json({ ok: false, error: FORMATS_COPY.noBrain }, 400);
  const src = await formatSource(rt, c.req.param('id'));
  if (!src) return c.json({ ok: false, error: FORMATS_COPY.notFound }, 404);
  const b = await c.req.json<{ force?: boolean }>().catch(() => ({} as { force?: boolean }));
  try {
    const a = await adaptFull(rt, m, src.src, { membersHash: src.membersHash, force: b.force !== false });
    return c.json({ ok: true, adaptation: a, script: await scriptSummary(rt, a?.script_id ?? null) });
  } catch (e) {
    console.error('radar format adapt failed', e instanceof Error ? e.message : e);
    return c.json({ ok: false, error: errMsg(e) }, 502);
  }
});

/** One item's format breakdown and adaptation (for the item sheet). */
radarFormatsAdmin.get('/item/:id', async (c) => {
  const rt = runtimeFrom(c);
  const id = c.req.param('id');
  const [extraction, a] = await Promise.all([getExtraction(rt, id), latestAdaptation(rt, { item_id: id })]);
  const fmt = extraction?.format_id ? await getFormat(rt, extraction.format_id) : null;
  return c.json({ extraction, format: fmt ? { id: fmt.id, name: fmt.name, definition: fmt.definition, white_space: fmt.white_space } : null, adaptation: a, script: await scriptSummary(rt, a?.script_id ?? null) });
});

/** Read one item's format now. */
radarFormatsAdmin.post('/item/:id/extract', async (c) => {
  const rt = runtimeFrom(c);
  const brain = brainOf(rt);
  if (!brain) return c.json({ ok: false, error: FORMATS_COPY.noBrain }, 400);
  const item = await rt.env.DB.prepare('SELECT * FROM radar_items WHERE id = ?').bind(c.req.param('id')).first<ExtractInput>();
  if (!item) return c.json({ ok: false, error: FORMATS_COPY.itemNotFound }, 404);
  const r = await extractBatch(rt, askJson(rt, brain, EXTRACT_SCHEMA, 'radar-extract'), brain, [item]);
  if (!r.done) return c.json({ ok: false, error: FORMATS_COPY.readFailed }, 502);
  return c.json({ ok: true, extraction: await getExtraction(rt, item.id) });
});

/** "How the script changes for us" for one item. */
radarFormatsAdmin.post('/item/:id/adapt', async (c) => {
  const rt = runtimeFrom(c);
  const m = modelsFor(rt);
  if (!m) return c.json({ ok: false, error: FORMATS_COPY.noBrain }, 400);
  const id = c.req.param('id');
  const item = await rt.env.DB.prepare('SELECT id, platform, title, score FROM radar_items WHERE id = ?').bind(id).first<{ id: string; platform: string; title: string | null; score: number }>();
  if (!item) return c.json({ ok: false, error: FORMATS_COPY.itemNotFound }, 404);
  const e = await getExtraction(rt, id);
  if (!e) return c.json({ ok: false, error: FORMATS_COPY.noFormat }, 400);
  try {
    const a = await adaptFull(rt, m, adaptSourceForItem(item, e), { force: true });
    return c.json({ ok: true, adaptation: a, script: await scriptSummary(rt, a?.script_id ?? null) });
  } catch (err) {
    console.error('radar item adapt failed', err instanceof Error ? err.message : err);
    return c.json({ ok: false, error: errMsg(err) }, 502);
  }
});
