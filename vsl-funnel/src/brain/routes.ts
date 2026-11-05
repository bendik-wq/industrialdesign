import { Hono } from 'hono';
import { type AppEnv, runtimeFrom } from '../app';
import { requireAdmin } from '../admin/auth';
import { embedder, vecIndex } from '../vectors/core';
import { embedBatch, embedState, pendingCount } from './embed';
import { asScope, brainBuild, brainSearch, legendCards, queryTerms } from './retrieve';

/**
 * The Brain panel's API, mounted at /admin/api/brain (owner; guests read-only: requireAdmin's guest gate refuses
 * every non-GET).
 *
 *  GET  /status          pages, chunks, edges, legends, embedded share, the last build and the embedding job
 *  GET  /search?q=&scope=copy|gl|all&k=   hybrid search (see retrieve.ts)
 *  GET  /legends?task=&n=                 legend cards (all legends by link rank when there is no task)
 *  GET  /page/:id        one page: its sections and its neighbourhood (for the small graph view)
 *  POST /embed           embed the next batch of chunks into Vectorize; the cron finishes the rest
 */

export const BRAIN_COPY = {
  empty: 'The brain is not loaded here yet. The lead loads it at deploy with npm run brain:build and the seed script.',
  notFound: 'That page is not in the brain.',
};

export const brainAdmin = new Hono<AppEnv>();
brainAdmin.use('*', requireAdmin);

brainAdmin.get('/status', async (c) => {
  const rt = runtimeFrom(c);
  const db = c.env.DB;
  const one = async (sql: string) => Number((await db.prepare(sql).first<{ n: number }>().catch(() => null))?.n ?? 0);
  const [pages, chunks, edges, legends, embedded, pending, job] = await Promise.all([
    one('SELECT COUNT(*) AS n FROM brain_pages'), one('SELECT COUNT(*) AS n FROM brain_chunks'), one('SELECT COUNT(*) AS n FROM brain_edges'),
    one('SELECT COUNT(*) AS n FROM brain_pages WHERE legend IS NOT NULL'), one('SELECT COUNT(*) AS n FROM brain_chunks WHERE embedded_hash = hash'),
    pendingCount(rt), embedState(rt),
  ]);
  const build = await db.prepare("SELECT value FROM kv_state WHERE key = 'brain:build'").first<{ value: string }>().catch(() => null);
  let last: Record<string, unknown> | null = null;
  try { last = build?.value ? (JSON.parse(build.value) as Record<string, unknown>) : null; } catch { last = null; }
  return c.json({
    loaded: chunks > 0, note: chunks ? null : BRAIN_COPY.empty,
    pages, chunks, edges, legends, embedded, pending,
    embedded_pct: chunks ? Math.round((embedded / chunks) * 1000) / 10 : 0,
    vectors: Boolean(vecIndex(rt) && embedder(rt, 'brain-embed')),
    build: last ? { build_id: last.build_id, built_at: last.built_at, source: last.source } : null,
    embed: job,
  });
});

brainAdmin.get('/search', async (c) => {
  const rt = runtimeFrom(c);
  const q = (c.req.query('q') || '').slice(0, 300);
  const k = Math.max(1, Math.min(20, Number(c.req.query('k')) || 8));
  const hits = await brainSearch(rt, q, { k, scope: asScope(c.req.query('scope')) });
  return c.json({ q, terms: queryTerms(q), hits });
});

brainAdmin.get('/legends', async (c) => {
  const rt = runtimeFrom(c);
  const n = Math.max(1, Math.min(20, Number(c.req.query('n')) || 20));
  return c.json({ cards: await legendCards(rt, (c.req.query('task') || '').slice(0, 300), n) });
});

brainAdmin.get('/page/:id', async (c) => {
  const rt = runtimeFrom(c);
  const id = c.req.param('id');
  if (!(await brainBuild(rt))) return c.json({ ok: false, error: BRAIN_COPY.empty }, 404);
  const db = c.env.DB;
  const page = await db.prepare('SELECT id, path, title, summary, folder, legend, pagerank FROM brain_pages WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!page) return c.json({ ok: false, error: BRAIN_COPY.notFound }, 404);
  const [chunks, edges] = await Promise.all([
    db.prepare('SELECT id, heading, text, kind, verified FROM brain_chunks WHERE page_id = ? ORDER BY ord').bind(id).all(),
    db.prepare("SELECT src, dst, type, weight FROM brain_edges WHERE (src = ? OR dst = ?) AND type IN ('links_to', 'part_of')").bind(id, id).all<{ src: string; dst: string; type: string; weight: number }>(),
  ]);
  // The neighbourhood: linked pages first (both directions), at most 18, by PageRank; siblings only when few links.
  const linked = [...new Set(edges.results.map((e) => (e.src === id ? e.dst : e.src)))];
  let ids = linked;
  if (ids.length < 6) {
    const sib = await db.prepare("SELECT dst FROM brain_edges WHERE src = ? AND type = 'sibling'").bind(id).all<{ dst: string }>();
    ids = [...new Set([...ids, ...sib.results.map((r) => r.dst)])];
  }
  const nodes = ids.length ? (await db.prepare(`SELECT id, title, folder, legend, pagerank FROM brain_pages WHERE id IN (${ids.map(() => '?').join(', ')}) ORDER BY pagerank DESC LIMIT 18`).bind(...ids).all<{ id: string }>()).results : [];
  const keep = new Set([id, ...nodes.map((n) => n.id)]);
  const between = keep.size > 1 ? (await db.prepare(`SELECT src, dst, type FROM brain_edges WHERE type IN ('links_to', 'part_of') AND src IN (${[...keep].map(() => '?').join(', ')})`).bind(...keep).all<{ src: string; dst: string; type: string }>()).results.filter((e) => keep.has(e.dst)) : [];
  return c.json({ page, chunks: chunks.results, graph: { center: id, nodes: [page, ...nodes], edges: between.length ? between : ids.filter((x) => keep.has(x)).map((x) => ({ src: id, dst: x, type: 'sibling' })) } });
});

brainAdmin.post('/embed', async (c) => {
  const rt = runtimeFrom(c);
  const b = await c.req.json<{ limit?: number }>().catch(() => ({} as { limit?: number }));
  return c.json(await embedBatch(rt, { limit: Number(b.limit) || undefined }));
});
