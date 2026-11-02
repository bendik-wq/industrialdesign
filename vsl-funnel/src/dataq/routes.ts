import { Hono } from 'hono';
import { type AppEnv, runtimeFrom } from '../app';
import { isAdmin, requireAdmin } from '../admin/auth';
import { dateRange, ownerTz } from '../ops/range';
import { CHECKS, CHECK_KEYS } from './checks';
import { DATASETS, DATASET_KEYS, EXPORT_MAX_DAYS, EXPORT_ROW_CAP, auditExport, countRows, exportColumns, exportStream, finishExport, recentExports } from './export';
import { compare, loadResults, localDay, prevDay, runDataQuality } from './run';

/**
 * Funnel HQ → Ad tracking → Data quality and Exports. Mounted at /admin/api/dataq (admin-only).
 *
 *  GET  /                 latest run next to the day before, the last 14 days per check, recent exports
 *  POST /run              run every check now (stores today's row; posts nothing)
 *  GET  /export           ?dataset=leads&format=csv|json&from=YYYY-MM-DD&to=YYYY-MM-DD&pii=1 (streamed download)
 */
export const dataqAdmin = new Hono<AppEnv>();
dataqAdmin.use('*', requireAdmin);

const HISTORY_DAYS = 14;

dataqAdmin.get('/', async (c) => {
  const rt = runtimeFrom(c);
  const today = localDay(rt);
  let since = today;
  for (let i = 1; i < HISTORY_DAYS; i++) since = prevDay(since);
  const [rows, exports] = await Promise.all([loadResults(rt, since).catch(() => []), recentExports(rt).catch(() => [])]);
  const latestDay = rows[0]?.day ?? null;
  const latest = latestDay ? rows.filter((r) => r.day === latestDay) : [];
  const before = latestDay ? rows.filter((r) => r.day === prevDay(latestDay)) : [];
  const history: Record<string, { day: string; n: number | null }[]> = {};
  for (const r of rows) (history[r.key] ??= []).unshift({ day: r.day, n: r.n });
  return c.json({
    day: latestDay,
    today,
    computedAt: latest[0]?.computed_at ?? null,
    checks: latestDay ? compare(latest, before).map((x) => ({ ...x.def, today: x.today, yesterday: x.yesterday, warn: x.warn, delta: x.delta, history: history[x.def.key] ?? [] })) : CHECK_KEYS.map((k) => ({ ...CHECKS[k], today: null, yesterday: null, warn: false, delta: null, history: [] })),
    datasets: DATASET_KEYS.map((k) => ({ key: k, label: DATASETS[k].label, pii: DATASETS[k].pii })),
    cap: EXPORT_ROW_CAP,
    exports,
  });
});

dataqAdmin.post('/run', async (c) => {
  const rt = runtimeFrom(c);
  const run = await runDataQuality(rt);
  return c.json({ ok: true, day: run.day, warnings: run.rows.filter((r) => r.warn).length });
});

dataqAdmin.get('/export', async (c) => {
  const rt = runtimeFrom(c);
  const q = c.req.query();
  const ds = DATASETS[q.dataset ?? ''];
  if (!ds) return c.json({ ok: false, error: `Pick a dataset: ${DATASET_KEYS.join(', ')}` }, 400);
  const format = q.format === 'json' ? 'json' : q.format === 'csv' || !q.format ? 'csv' : null;
  if (!format) return c.json({ ok: false, error: 'Format is csv or json' }, 400);
  const range = dateRange(String(q.from ?? ''), String(q.to ?? ''), ownerTz(rt));
  if (!range) return c.json({ ok: false, error: 'Pick a start and end date (YYYY-MM-DD), end on or after start' }, 400);
  if (range.to - range.from > EXPORT_MAX_DAYS * 86_400_000) return c.json({ ok: false, error: `Pick at most ${EXPORT_MAX_DAYS} days` }, 400);
  // Personal details only for the signed-in admin session, checked again here, and only when asked for.
  const pii = q.pii === '1' && (await isAdmin(c));
  const total = await countRows(rt, ds, range.from, range.to);
  const rows = Math.min(total, EXPORT_ROW_CAP);
  const capped = total > EXPORT_ROW_CAP;
  const id = await auditExport(rt, { dataset: ds.key, format, from: range.from, to: range.to, pii, rows, capped, ip: c.req.header('cf-connecting-ip') ?? null, label: ds.label.toLowerCase() });
  const stream = exportStream(rt, ds, { format, pii, from: range.from, to: range.to, onDone: (n) => finishExport(rt, id, n) });
  const name = `${ds.key}-${q.from}-to-${q.to}${pii ? '' : '-no-pii'}.${format}`;
  return new Response(stream, {
    headers: {
      'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${name}"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-export-rows': String(rows),
      'x-export-capped': capped ? '1' : '0',
      'x-export-columns': String(exportColumns(ds, pii).length),
    },
  });
});
