import { type Context, Hono } from 'hono';
import { type AppEnv, runtimeFrom } from '../app';
import { requireAdmin } from '../admin/auth';
import { googleReady } from '../content/video-pack';
import { DEPTS, DEPT_LABEL, actorLabel, approveAction, autoKinds, editAction, handlerKinds, listActions, parsePayload, rejectAction } from './actions';
import { briefMinute, buildBrief, composeBrief, sendBrief } from './brief';
import { type ChatEvent, OPS_MODEL, runChat } from './chat';
import { documentHtmlPage, documentToDrive, getDocument, listDocuments, saveDocument, summaryDocument } from './documents';
import './handlers';
import { runMonitors, thresholds } from './monitors';
import { ownerTz } from './range';
import { RoutineError, createRoutine, describeSchedule, listRoutines, runRoutine, updateRoutine, type Routine } from './routines';
import { opsSlackConfigured } from './slack';

const localWhen = (t: number, tz: string) => new Intl.DateTimeFormat('en-AU', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t).replace(',', '');

/** Funnel HQ → Command APIs, mounted at /admin/api/ops (admin session required). */
export const opsAdmin = new Hono<AppEnv>();
opsAdmin.use('*', requireAdmin);

const body = async (c: Context<AppEnv>) => (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
const fail = (c: Context<AppEnv>, e: unknown) => {
  if (e instanceof RoutineError) return c.json({ ok: false, error: e.message }, 400);
  console.error('ops admin', e);
  return c.json({ ok: false, error: e instanceof Error ? e.message : 'Something went wrong' }, 500);
};

opsAdmin.get('/', async (c) => {
  const rt = runtimeFrom(c);
  const s = rt.settings as Partial<Record<string, string>>;
  const [pending, alerts] = await Promise.all([
    rt.env.DB.prepare("SELECT COUNT(*) AS n FROM ops_actions WHERE status = 'proposed'").first<{ n: number }>(),
    rt.env.DB.prepare('SELECT id, title, body, severity, span, action_id, created_at FROM ops_alerts ORDER BY created_at DESC LIMIT 20').all(),
  ]);
  const brief = briefMinute(s.OPS_BRIEF_TIME);
  return c.json({
    pending: pending?.n ?? 0,
    alerts: alerts.results,
    setup: { ai: Boolean(rt.settings.ANTHROPIC_API_KEY), slack: opsSlackConfigured(rt), drive: googleReady(rt) },
    settings: {
      model: s.OPS_MODEL || OPS_MODEL, timezone: ownerTz(rt), autoKinds: autoKinds(rt),
      briefTime: brief == null ? null : `${String(Math.floor(brief / 60)).padStart(2, '0')}:${String(brief % 60).padStart(2, '0')}`,
      monitors: !/^(off|false|0|no)$/i.test((s.OPS_MONITORS ?? '').trim()), thresholds: thresholds(rt),
    },
    handlers: handlerKinds(),
    depts: DEPTS.map((d) => ({ id: d, label: DEPT_LABEL[d] })),
  });
});

// ── Chat ──
opsAdmin.get('/threads', async (c) => {
  const kind = c.req.query('kind');
  const where = kind && /^(chat|routine|brief|alert)$/.test(kind) ? 'WHERE kind = ?' : '';
  const stmt = c.env.DB.prepare(`SELECT id, title, kind, routine_id, created_at, updated_at FROM ops_threads ${where} ORDER BY updated_at DESC LIMIT 60`);
  return c.json({ threads: (await (where ? stmt.bind(kind) : stmt).all()).results });
});
opsAdmin.get('/threads/:id', async (c) => {
  const t = await c.env.DB.prepare('SELECT * FROM ops_threads WHERE id = ?').bind(c.req.param('id')).first();
  if (!t) return c.json({ error: 'Thread not found' }, 404);
  const { results } = await c.env.DB.prepare('SELECT id, role, content, tools, created_at FROM ops_messages WHERE thread_id = ? ORDER BY created_at').bind(c.req.param('id')).all<{ tools: string | null }>();
  return c.json({ thread: t, messages: results.map((m) => ({ ...m, tools: m.tools ? parsePayload(m.tools) : [] })) });
});
opsAdmin.delete('/threads/:id', async (c) => {
  await c.env.DB.batch([c.env.DB.prepare('DELETE FROM ops_messages WHERE thread_id = ?').bind(c.req.param('id')), c.env.DB.prepare('DELETE FROM ops_threads WHERE id = ?').bind(c.req.param('id'))]);
  return c.json({ ok: true });
});
/** Streams the answer as newline-delimited JSON events (thread, text, tool, done, error). */
opsAdmin.post('/chat', async (c) => {
  const rt = runtimeFrom(c);
  const b = await body(c);
  const message = String(b.message ?? '').trim();
  if (!message) return c.json({ ok: false, error: 'Type a question or an instruction.' }, 400);
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  let chain = Promise.resolve();
  const emit = (e: ChatEvent) => { chain = chain.then(() => writer.write(enc.encode(`${JSON.stringify(e)}\n`))).catch(() => {}); };
  const job = runChat(rt, { threadId: typeof b.threadId === 'string' ? b.threadId : null, message, emit })
    .catch((e) => emit({ type: 'error', error: e instanceof Error ? e.message : 'The chat failed.' }))
    .finally(() => { chain = chain.then(() => writer.close()).catch(() => {}); });
  try { c.executionCtx.waitUntil(job); } catch { /* no execution context (tests) */ }
  return new Response(readable, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
});

// ── Actions: approvals and the activity log ──
opsAdmin.get('/actions', async (c) => {
  const q = c.req.query();
  const rows = await listActions(runtimeFrom(c), { dept: q.dept, actor: q.actor, status: q.status, before: Number(q.before) || undefined, limit: Number(q.limit) || 100 });
  return c.json({ actions: rows.map((r) => ({ ...r, payload: parsePayload(r.payload), who: actorLabel(r), handled: handlerKinds().some((h) => h.kind === r.kind) })) });
});
opsAdmin.post('/actions/:id/approve', async (c) => { try { const r = await approveAction(runtimeFrom(c), c.req.param('id'), 'you'); return c.json(r, r.ok ? 200 : 400); } catch (e) { return fail(c, e); } });
opsAdmin.post('/actions/:id/reject', async (c) => { const b = await body(c); const r = await rejectAction(runtimeFrom(c), c.req.param('id'), 'you', String(b.reason ?? '').slice(0, 300)); return c.json(r, r.ok ? 200 : 400); });
opsAdmin.put('/actions/:id', async (c) => { const r = await editAction(runtimeFrom(c), c.req.param('id'), await body(c)); return c.json(r, r.ok ? 200 : 400); });

// ── Routines ──
opsAdmin.get('/routines', async (c) => {
  const rows = await listRoutines(runtimeFrom(c));
  return c.json({ routines: rows.map((r) => ({ ...r, schedule: describeSchedule(r), next_local: r.next_run_at ? localWhen(r.next_run_at, r.timezone) : null, last_local: r.last_run_at ? localWhen(r.last_run_at, r.timezone) : null })), timezone: ownerTz(runtimeFrom(c)) });
});
opsAdmin.post('/routines', async (c) => { try { return c.json({ ok: true, id: await createRoutine(runtimeFrom(c), await body(c)) }); } catch (e) { return fail(c, e); } });
opsAdmin.put('/routines/:id', async (c) => { try { await updateRoutine(runtimeFrom(c), c.req.param('id'), await body(c)); return c.json({ ok: true }); } catch (e) { return fail(c, e); } });
opsAdmin.delete('/routines/:id', async (c) => { await c.env.DB.prepare('DELETE FROM ops_routines WHERE id = ?').bind(c.req.param('id')).run(); return c.json({ ok: true }); });
opsAdmin.post('/routines/:id/run', async (c) => {
  try {
    const rt = runtimeFrom(c);
    const r = await rt.env.DB.prepare('SELECT * FROM ops_routines WHERE id = ?').bind(c.req.param('id')).first<Routine>();
    if (!r) return c.json({ ok: false, error: 'Routine not found' }, 404);
    return c.json({ ok: true, thread: await runRoutine(rt, r) });
  } catch (e) { return fail(c, e); }
});

// ── Alerts, brief ──
opsAdmin.post('/monitors/run', async (c) => { try { return c.json({ ok: true, ...(await runMonitors(runtimeFrom(c), Date.now(), { force: true })) }); } catch (e) { return fail(c, e); } });
opsAdmin.get('/brief/preview', async (c) => {
  const kind = c.req.query('kind') === 'weekend' ? 'weekend' : 'daily';
  return c.json(composeBrief(await buildBrief(runtimeFrom(c), kind)));
});
opsAdmin.post('/brief/send', async (c) => { try { const b = await body(c); return c.json({ ok: true, ...(await sendBrief(runtimeFrom(c), b.kind === 'weekend' ? 'weekend' : 'daily')) }); } catch (e) { return fail(c, e); } });

// ── Documents ──
opsAdmin.get('/documents', async (c) => c.json({ documents: await listDocuments(runtimeFrom(c)), drive: googleReady(runtimeFrom(c)) }));
opsAdmin.post('/documents', async (c) => {
  try {
    const rt = runtimeFrom(c);
    const b = await body(c);
    const range = ['mtd', 'last_week', 'last_month', 'this_week', '7d', '30d'].includes(String(b.range)) ? String(b.range) : 'mtd';
    const d = await summaryDocument(rt, range);
    const id = await saveDocument(rt, d);
    return c.json({ ok: true, id, title: d.title });
  } catch (e) { return fail(c, e); }
});
opsAdmin.get('/documents/:file{[A-Za-z0-9_]+\\.(md|html)}', async (c) => {
  const [id, ext] = c.req.param('file').split('.');
  const rt = runtimeFrom(c);
  const d = await getDocument(rt, id);
  if (!d) return c.text('Not found', 404);
  const fname = d.title.replace(/[^\w -]+/g, '').trim().replace(/\s+/g, '-').slice(0, 80) || 'document';
  if (ext === 'html') return new Response(documentHtmlPage(d, rt.origin), { headers: { 'content-type': 'text/html; charset=utf-8', 'content-disposition': `attachment; filename="${fname}.html"`, 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" } });
  return new Response(d.body, { headers: { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="${fname}.md"` } });
});
opsAdmin.get('/documents/:id', async (c) => { const d = await getDocument(runtimeFrom(c), c.req.param('id')); return d ? c.json(d) : c.json({ error: 'Not found' }, 404); });
opsAdmin.post('/documents/:id/drive', async (c) => {
  try {
    const rt = runtimeFrom(c);
    const d = await getDocument(rt, c.req.param('id'));
    if (!d) return c.json({ ok: false, error: 'Not found' }, 404);
    return c.json({ ok: true, url: await documentToDrive(rt, d) });
  } catch (e) { return c.json({ ok: false, error: e instanceof Error ? e.message : 'Google Drive failed' }, 400); }
});
opsAdmin.delete('/documents/:id', async (c) => { await c.env.DB.prepare('DELETE FROM ops_documents WHERE id = ?').bind(c.req.param('id')).run(); return c.json({ ok: true }); });
