import { Hono } from 'hono';
import { type AppEnv, runtimeFrom } from '../app';
import { requireAdmin } from '../admin/auth';
import { gatewayInfo } from '../infra/ai-gateway';
import { NAMESPACES, NOT_HERE, type Ns, embedder, isLocalOnlyError, roomHelperOn, unavailable, vecIndex, vectorSearchOn } from './core';
import { indexTick, restartPasses } from './indexer';
import { buyerLookalikes, semanticSearch, similarLeads } from './search';

/**
 * Funnel HQ → AI search (admin only), mounted at /admin/api/vectors.
 *
 *  GET  /status            on/off, whether the index is reachable here, counts per kind, each source's pass, the gateway
 *  GET  /similar/:leadId   leads whose application reads most like this one
 *  GET  /lookalikes        leads like my recent buyers who haven't bought
 *  GET  /search?q=&kinds=  meaning search over room questions/objections, call notes and lead answers
 *  POST /run               index one batch now (the cron does this every 5 minutes)
 *  POST /restart           start every source's pass over (unchanged items cost nothing)
 */
export const vectorsAdmin = new Hono<AppEnv>();
vectorsAdmin.use('*', requireAdmin);

const fail = (e: unknown) => (isLocalOnlyError(e) ? NOT_HERE : String((e as Error)?.message ?? e).slice(0, 300));

vectorsAdmin.get('/status', async (c) => {
  const rt = runtimeFrom(c);
  const db = c.env.DB;
  const [counts, cursors] = await Promise.all([
    db.prepare('SELECT ns, COUNT(*) AS n, MAX(indexed_at) AS last FROM vec_items GROUP BY ns').all<{ ns: string; n: number; last: number | null }>().then((r) => r.results).catch(() => []),
    db.prepare('SELECT source, pass, pass_started_at, pass_done_at, embedded, last_error, updated_at, cursor FROM vec_cursor ORDER BY source').all().then((r) => r.results).catch(() => []),
  ]);
  const g = gatewayInfo(rt.settings);
  return c.json({
    on: vectorSearchOn(rt), helper: roomHelperOn(rt), note: unavailable(rt),
    bindings: { vectorize: Boolean(vecIndex(rt)), workersAi: Boolean(embedder(rt)) },
    counts: Object.fromEntries(NAMESPACES.map((ns) => [ns, counts.find((x) => x.ns === ns)?.n ?? 0])),
    lastIndexedAt: counts.reduce((a, x) => Math.max(a, Number(x.last) || 0), 0) || null,
    sources: cursors,
    gateway: { on: g.on, id: g.id, account: g.account, dashboardUrl: g.dashboardUrl, problem: g.problem },
  });
});

vectorsAdmin.get('/similar/:leadId', async (c) => {
  const rt = runtimeFrom(c);
  try { return c.json({ off: !vectorSearchOn(rt), ...(await similarLeads(rt, c.req.param('leadId'), 8)) }); } catch (e) { return c.json({ ok: false, note: fail(e), leads: [] }, isLocalOnlyError(e) ? 200 : 502); }
});

vectorsAdmin.get('/lookalikes', async (c) => {
  const rt = runtimeFrom(c);
  try { return c.json({ off: !vectorSearchOn(rt), ...(await buyerLookalikes(rt, 20)) }); } catch (e) { return c.json({ ok: false, note: fail(e), buyers: 0, leads: [] }, isLocalOnlyError(e) ? 200 : 502); }
});

vectorsAdmin.get('/search', async (c) => {
  const kinds = (c.req.query('kinds') || '').split(',').filter((k): k is Ns => k === 'q' || k === 'note' || k === 'lead');
  try { return c.json(await semanticSearch(runtimeFrom(c), c.req.query('q') || '', { kinds: kinds.length ? kinds : undefined })); } catch (e) { return c.json({ ok: false, note: fail(e), hits: [] }, isLocalOnlyError(e) ? 200 : 502); }
});

vectorsAdmin.post('/run', async (c) => {
  const rt = runtimeFrom(c);
  const why = unavailable(rt);
  if (why) return c.json({ ok: false, note: why });
  try {
    const r = await indexTick(rt);
    return c.json(r.skipped ? { ok: false, note: r.skipped } : { ok: true, ...r });
  } catch (e) { return c.json({ ok: false, note: fail(e) }, 502); }
});

vectorsAdmin.post('/restart', async (c) => {
  await restartPasses(runtimeFrom(c));
  return c.json({ ok: true });
});
