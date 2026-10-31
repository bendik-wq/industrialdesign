import type { Context, Hono } from 'hono';
import { type AppEnv, type Runtime, runtimeFrom } from '../app';
import { zoomApi, zoomConfigured } from '../live/zoom';
import { recordMinute, recordStage, syncAttribution } from './stages';
import { DIMS, MODELS, type FunnelSel, type Range, cohorts, journey, parseDim, parseFunnel, parseModel, people, revenueBy, roomAnalytics, setupChecks, stageCounts, stagesContract, timeToPurchase } from './report';

/**
 * Funnel HQ → Webinar attribution (/admin/api/attribution*). Mounted inside the admin router, so every route
 * is behind requireAdmin.
 */

const DAY = 86_400_000;

/** from / to as epoch ms or YYYY-MM-DD; default: the last 30 days. */
export function parseRange(q: Record<string, string | undefined>, now = Date.now()): Range {
  const t = (v: string | undefined, end: boolean) => {
    if (!v) return null;
    if (/^\d{9,15}$/.test(v)) return Number(v);
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) { const d = Date.parse(`${v}T00:00:00Z`); return Number.isFinite(d) ? d + (end ? DAY - 1 : 0) : null; }
    return null;
  };
  const to = t(q.to, true) ?? now;
  const from = t(q.from, false) ?? to - 30 * DAY;
  return { from: Math.max(0, Math.min(from, to)), to };
}

const csvCell = (v: unknown) => {
  const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  // Formula injection guard for spreadsheets.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
export const toCsv = (rows: Record<string, unknown>[], cols?: string[]) => {
  const keys = cols ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return [keys.join(','), ...rows.map((r) => keys.map((k) => csvCell(r[k])).join(','))].join('\n');
};

async function full(rt: Runtime, f: FunnelSel, r: Range, model: ReturnType<typeof parseModel>, dim: ReturnType<typeof parseDim>) {
  const [stages, revenue, ttp, coh, room, list, setup] = await Promise.all([
    stageCounts(rt, f, r), revenueBy(rt, f, r, model, dim), timeToPurchase(rt, f, r), cohorts(rt, f, r), roomAnalytics(rt, f, r), people(rt, f, r, 25), setupChecks(rt),
  ]);
  return { funnel: f, range: r, model, dim, models: MODELS, dims: DIMS, stages, revenue, timeToPurchase: ttp, cohorts: coh, room, people: list, setup };
}

/** Zoom attendance for one live event (report:read:admin): minutes per registrant matched by email. */
export async function importZoomAttendance(rt: Runtime, eventId: string) {
  if (!zoomConfigured(rt.settings)) return { ok: false as const, error: 'Zoom isn’t connected. Connect the Server-to-Server app in Integrations first.' };
  const db = rt.env.DB;
  const ev = await db.prepare('SELECT id, starts_at FROM live_webinars WHERE id = ?').bind(eventId).first<{ id: string; starts_at: number }>();
  const le = await db.prepare('SELECT zoom_id, zoom_kind FROM live_events WHERE key = ?').bind(`webinar:${eventId}`).first<{ zoom_id: string | null; zoom_kind: string | null }>();
  if (!ev || !le?.zoom_id) return { ok: false as const, error: 'This event has no Zoom meeting created through the Zoom app, so Zoom can’t report on it.' };
  type P = { user_email?: string; email?: string; join_time?: string; leave_time?: string; duration?: number };
  const list: P[] = [];
  let next = '';
  try {
    for (let i = 0; i < 10; i++) {
      const r = await zoomApi<{ participants?: P[]; next_page_token?: string }>(rt, 'GET', `/report/${le.zoom_kind === 'webinar' ? 'webinars' : 'meetings'}/${encodeURIComponent(le.zoom_id)}/participants?page_size=300${next ? `&next_page_token=${encodeURIComponent(next)}` : ''}`);
      list.push(...(r.participants ?? []));
      next = r.next_page_token ?? '';
      if (!next) break;
    }
  } catch (e) {
    return { ok: false as const, error: `Zoom refused the attendance report: ${e instanceof Error ? e.message : 'unknown error'}. The app needs the report:read:admin scope.` };
  }
  let matched = 0;
  for (const p of list) {
    const email = (p.user_email ?? p.email ?? '').trim().toLowerCase();
    if (!email) continue;
    const reg = await db.prepare('SELECT r.id, r.lead_id FROM live_webinar_regs r JOIN leads l ON l.id = r.lead_id WHERE r.event_id = ? AND LOWER(l.email) = ?').bind(eventId, email).first<{ id: string; lead_id: string }>();
    if (!reg) continue;
    const join = Date.parse(p.join_time ?? ''), leave = Date.parse(p.leave_time ?? '');
    if (!Number.isFinite(join) || !Number.isFinite(leave) || leave <= join) continue;
    matched++;
    for (let t = join; t < leave; t += 60_000) await recordMinute(rt, { funnel: 'live', eventRef: eventId, regId: reg.id, leadId: reg.lead_id, startsAt: ev.starts_at, now: t, source: 'zoom' });
    await recordStage(rt, { funnel: 'live', stage: 'attended', leadId: reg.lead_id, regId: reg.id, ts: join, cohortRef: eventId, detail: 'zoom', source: 'zoom' });
  }
  return { ok: true as const, participants: list.length, matched };
}

export function mountAttributionAdmin(admin: Hono<AppEnv>) {
  const q = (c: Context<AppEnv>) => c.req.query() as Record<string, string | undefined>;

  // The contract the Funnel map reads: { stages: [{ id, label, count, revenue? }] }.
  admin.get('/attribution/stages', async (c) => {
    const rt = runtimeFrom(c);
    await syncAttribution(rt).catch((e) => console.error('attribution sync', e));
    return c.json(await stagesContract(rt, parseFunnel(q(c).funnel), parseRange(q(c))));
  });

  admin.get('/attribution', async (c) => {
    const rt = runtimeFrom(c);
    await syncAttribution(rt).catch((e) => console.error('attribution sync', e));
    const p = q(c);
    return c.json(await full(rt, parseFunnel(p.funnel), parseRange(p), parseModel(p.model), parseDim(p.dim)));
  });

  admin.get('/attribution/revenue', async (c) => {
    const p = q(c);
    return c.json(await revenueBy(runtimeFrom(c), parseFunnel(p.funnel), parseRange(p), parseModel(p.model), parseDim(p.dim)));
  });

  admin.get('/attribution/journey/:lead', async (c) => {
    const j = await journey(runtimeFrom(c), c.req.param('lead'));
    return j ? c.json(j) : c.json({ error: 'No such lead' }, 404);
  });

  admin.post('/attribution/sync', async (c) => c.json(await syncAttribution(runtimeFrom(c), { full: true })));

  admin.post('/attribution/zoom/:event', async (c) => c.json(await importZoomAttendance(runtimeFrom(c), c.req.param('event'))));

  admin.get('/attribution/export.csv', async (c) => {
    const rt = runtimeFrom(c);
    const p = q(c);
    const f = parseFunnel(p.funnel), r = parseRange(p);
    const type = ['revenue', 'people', 'stages', 'conversions'].includes(p.type ?? '') ? p.type! : 'revenue';
    let rows: Record<string, unknown>[];
    if (type === 'revenue') rows = (await revenueBy(rt, f, r, parseModel(p.model), parseDim(p.dim))).rows;
    else if (type === 'people') rows = (await people(rt, f, r, 5000)).map((x) => ({ ...x, stages: x.stages.join(' ') }));
    else if (type === 'stages') rows = (await stageCounts(rt, f, r)).stages;
    else rows = (await rt.env.DB.prepare(`SELECT * FROM attr_conversions WHERE occurred_at BETWEEN ? AND ? ${f === 'all' ? '' : 'AND funnel = ?'} ORDER BY occurred_at`).bind(...(f === 'all' ? [r.from, r.to] : [r.from, r.to, f])).all()).results as Record<string, unknown>[];
    const name = `webinar-attribution-${type}-${new Date(r.from).toISOString().slice(0, 10)}-${new Date(r.to).toISOString().slice(0, 10)}.csv`;
    return new Response(toCsv(rows), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' } });
  });
}
