import { type Context, Hono } from 'hono';
import { type AppEnv, runtimeFrom } from '../app';
import { logAction, proposeAction } from '../ops/actions';
import { PROOF, runAnalysis } from './analyze';
import { buildBrief, sendBrief } from './brief';
import { collectSlice, loadState, startCollection } from './collect';
import { localClock } from '../sales/digest';
import { researchConfig } from './config';
import { adsBoard, researchView } from './view';

/**
 * Funnel HQ → Research. Mounted at /admin/api/research behind requireAdmin (and the same-origin write check).
 *   GET    /                    themes, voice of customer, angle backlog, runs, setup notes
 *   GET    /ads                 competitor ads board (?advertiser=&minDays=&active=1)
 *   POST   /collect             start (or continue) today's collection now, one slice
 *   POST   /analyze             run the theme / angle analysis now
 *   GET    /brief               preview the weekly brief;  POST /brief  sends it
 *   PATCH  /angles/:id          { status }
 *   POST   /angles/:id/send     Send to Marketing: logs it and proposes marketing.test_angle
 */
export const researchAdmin = new Hono<AppEnv>();
export const ANGLE_STATUSES = ['new', 'approved', 'testing', 'winner', 'retired'] as const;

const fail = (c: Context<AppEnv>, e: unknown) => {
  console.error('research admin', e);
  return c.json({ ok: false, error: e instanceof Error ? e.message : 'Something went wrong' }, 500);
};

researchAdmin.get('/', async (c) => {
  try { return c.json(await researchView(runtimeFrom(c))); } catch (e) { return fail(c, e); }
});

researchAdmin.get('/ads', async (c) => {
  try {
    return c.json(await adsBoard(runtimeFrom(c), { advertiser: c.req.query('advertiser') || undefined, minDays: Number(c.req.query('minDays')) || 0, active: c.req.query('active') === '1' }));
  } catch (e) { return fail(c, e); }
});

researchAdmin.post('/collect', async (c) => {
  const rt = runtimeFrom(c);
  try {
    const cfg = researchConfig(rt);
    const today = localClock(Date.now(), cfg.tz).date;
    let s = await loadState(rt);
    const fresh = !s || s.date !== today || s.idx >= s.jobs.length;
    if (fresh) {
      await rt.env.DB.prepare('INSERT OR IGNORE INTO kv_state (key, value) VALUES (?, ?)').bind(`research:day:${today}`, String(Date.now())).run();
      s = await startCollection(rt, today);
    }
    s = await collectSlice(rt, s!, 4);
    await logAction(rt, { dept: 'research', kind: 'research.collect', actor: 'you', status: 'done', summary: `Research collection started by hand: ${s.idx} of ${s.jobs.length} sources read` });
    return c.json({ ok: true, done: s.idx, total: s.jobs.length, errors: s.errors.slice(-5), message: s.idx < s.jobs.length ? `Read ${s.idx} of ${s.jobs.length} sources. The rest follow on the cron every 5 minutes, then the analysis runs.` : 'All sources read. Run the analysis next.' });
  } catch (e) { return fail(c, e); }
});

researchAdmin.post('/analyze', async (c) => {
  const rt = runtimeFrom(c);
  try {
    const r = await runAnalysis(rt);
    await logAction(rt, { dept: 'research', kind: 'research.analyze', actor: 'you', status: 'done', summary: `Research analysis (${r.mode}): ${r.themes} themes, ${r.anglesAdded} new angles` });
    return c.json({ ok: true, ...r });
  } catch (e) { return fail(c, e); }
});

researchAdmin.get('/brief', async (c) => {
  try { return c.json(await buildBrief(runtimeFrom(c))); } catch (e) { return fail(c, e); }
});
researchAdmin.post('/brief', async (c) => {
  try { const b = await sendBrief(runtimeFrom(c)); return c.json({ ok: true, sent: b.sent, lines: b.lines }); } catch (e) { return fail(c, e); }
});

researchAdmin.patch('/angles/:id', async (c) => {
  const rt = runtimeFrom(c);
  const body = (await c.req.json().catch(() => ({}))) as { status?: string };
  const status = String(body.status ?? '');
  if (!(ANGLE_STATUSES as readonly string[]).includes(status)) return c.json({ ok: false, error: 'Unknown status' }, 400);
  const a = await rt.env.DB.prepare('SELECT id, hook, status FROM research_angles WHERE id = ?').bind(c.req.param('id')).first<{ id: string; hook: string; status: string }>();
  if (!a) return c.json({ ok: false, error: 'Angle not found' }, 404);
  await rt.env.DB.prepare('UPDATE research_angles SET status = ?, updated_at = ? WHERE id = ?').bind(status, Date.now(), a.id).run();
  await logAction(rt, { dept: 'research', kind: 'research.angle_status', actor: 'you', status: 'done', summary: `Angle marked ${status}: ${a.hook.slice(0, 120)}`, payload: { angleId: a.id, from: a.status, to: status } });
  return c.json({ ok: true, status });
});

researchAdmin.post('/angles/:id/send', async (c) => {
  const rt = runtimeFrom(c);
  const a = await rt.env.DB.prepare('SELECT * FROM research_angles WHERE id = ?').bind(c.req.param('id')).first<any>();
  if (!a) return c.json({ ok: false, error: 'Angle not found' }, 404);
  if (a.action_id && a.status !== 'new') return c.json({ ok: false, error: 'Already sent to Marketing' }, 409);
  let ids: string[] = [];
  try { ids = JSON.parse(a.evidence || '[]'); } catch { /* none */ }
  const { results: ev } = ids.length
    ? await rt.env.DB.prepare(`SELECT id, url, community FROM research_items WHERE id IN (${ids.slice(0, 12).map(() => '?').join(',')})`).bind(...ids.slice(0, 12)).all<{ id: string; url: string | null; community: string | null }>()
    : { results: [] as { id: string; url: string | null; community: string | null }[] };
  const proof = PROOF.find((p) => p.id === a.proof_id);
  const payload = {
    angleId: a.id, hook: a.hook, promise: a.promise, proofId: a.proof_id, proof: proof?.text ?? null, audience: a.audience, revenueBand: a.revenue_band, belief: a.belief,
    evidence: ev.map((e) => ({ id: e.id, url: e.url && e.url.startsWith('/') ? `${rt.origin}${e.url}` : e.url, where: e.community })),
  };
  const actionId = await proposeAction(rt, {
    dept: 'marketing', kind: 'marketing.test_angle', risk: 'medium',
    summary: `Test angle: ${a.hook.slice(0, 140)}`,
    detail: [`Promise: ${a.promise}`, `Belief it breaks: ${a.belief}`, `Audience: ${a.audience}, ${a.revenue_band}`, proof ? `Proof: ${proof.text}` : 'Proof: none', `Evidence: ${payload.evidence.length} linked items in Funnel HQ → Research`].join('\n'),
    payload,
  });
  await logAction(rt, { dept: 'research', kind: 'research.angle_sent', actor: 'you', status: 'done', summary: `Sent angle to Marketing: ${a.hook.slice(0, 120)}`, payload: { angleId: a.id, actionId } });
  await rt.env.DB.prepare("UPDATE research_angles SET status = 'approved', action_id = ?, sent_at = ?, updated_at = ? WHERE id = ?").bind(actionId, Date.now(), Date.now(), a.id).run();
  return c.json({ ok: true, actionId, status: 'approved' });
});
