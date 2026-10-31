import { Hono } from 'hono';
import { type AppEnv, type Runtime, runtimeFrom } from '../app';
import { requireAdmin } from '../admin/auth';
import { saveSettings } from '../settings';
import { logAction } from '../ops/actions';
import { claudeReady, NO_KEY_NOTE } from '../ops/claude';
import { REPLY_KIND, draftForThread, ingestEmail, manualDraft, minConfidence, processSupport, sendDraft } from './inbox';

/** Funnel HQ → Support. Mounted at /admin/api/support (admin-only). */
export const supportAdmin = new Hono<AppEnv>();
supportAdmin.use('*', requireAdmin);

const body = async (c: { req: { json: <T>() => Promise<T> } }) => (await c.req.json<Record<string, unknown>>().catch(() => ({}))) as Record<string, unknown>;
const parse = <T>(s: unknown, d: T): T => { try { return (JSON.parse(String(s ?? '')) as T) ?? d; } catch { return d; } };

export async function supportOverview(rt: Runtime, status: string) {
  const db = rt.env.DB;
  const filter = ['open', 'drafted', 'escalated', 'answered', 'closed'].includes(status) ? status : '';
  const { results } = await db.prepare(
    `SELECT t.*, (SELECT body FROM support_messages m WHERE m.thread_id = t.id AND m.direction = 'in' ORDER BY created_at DESC LIMIT 1) AS last_in,
            (SELECT COUNT(*) FROM support_messages m WHERE m.thread_id = t.id) AS n
       FROM support_threads t ${filter ? 'WHERE t.status = ?' : "WHERE t.status != 'closed'"}
      ORDER BY CASE t.status WHEN 'escalated' THEN 0 WHEN 'drafted' THEN 1 WHEN 'open' THEN 2 ELSE 3 END, t.updated_at DESC LIMIT 300`,
  ).bind(...(filter ? [filter] : [])).all<Record<string, unknown>>();
  const { results: counts } = await db.prepare('SELECT status, COUNT(*) AS n FROM support_threads GROUP BY status').all<{ status: string; n: number }>();
  const s = rt.settings;
  return {
    threads: results.map((t) => ({ ...t, last_in: String(t.last_in ?? '').slice(0, 220) })),
    counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
    setup: {
      ai: claudeReady(rt) ? null : NO_KEY_NOTE,
      resendInbound: Boolean(s.SUPPORT_RESEND_WEBHOOK_SECRET),
      forwarding: Boolean(s.SUPPORT_INBOUND_SECRET),
      canSend: Boolean(s.RESEND_API_KEY && (s.SUPPORT_FROM || s.EMAIL_FROM)),
      minConfidence: minConfidence(rt),
      urls: { resend: `${rt.origin}/hooks/resend-inbound`, forward: `${rt.origin}/hooks/support-email` },
    },
  };
}

supportAdmin.get('/', async (c) => c.json(await supportOverview(runtimeFrom(c), c.req.query('status') ?? '')));

supportAdmin.get('/threads/:id', async (c) => {
  const db = runtimeFrom(c).env.DB;
  const id = c.req.param('id');
  const thread = await db.prepare('SELECT t.*, l.first_name, l.last_name, l.ref_code FROM support_threads t LEFT JOIN leads l ON l.id = t.lead_id WHERE t.id = ?').bind(id).first();
  if (!thread) return c.json({ error: 'not found' }, 404);
  const [{ results: messages }, { results: drafts }] = await Promise.all([
    db.prepare('SELECT * FROM support_messages WHERE thread_id = ? ORDER BY created_at').bind(id).all(),
    db.prepare('SELECT * FROM support_drafts WHERE thread_id = ? ORDER BY created_at DESC LIMIT 10').bind(id).all<Record<string, unknown>>(),
  ]);
  return c.json({ thread, messages, drafts: drafts.map((d) => ({ ...d, citations: parse(d.citations, []) })) });
});

supportAdmin.post('/threads/:id/draft', async (c) => c.json(await draftForThread(runtimeFrom(c), c.req.param('id'))));

supportAdmin.post('/threads/:id/reply', async (c) => {
  const rt = runtimeFrom(c);
  const b = await body(c);
  const text = String(b.body ?? '').trim();
  if (!text) return c.json({ ok: false, summary: 'Write the reply first.' }, 400);
  const id = await manualDraft(rt, c.req.param('id'), text);
  const r = await sendDraft(rt, id, 'you');
  await logAction(rt, { dept: 'support', kind: REPLY_KIND, summary: r.summary, actor: 'you', status: r.ok ? 'done' : 'failed', payload: { draftId: id } });
  return c.json(r, r.ok ? 200 : 400);
});

supportAdmin.post('/threads/:id/status', async (c) => {
  const b = await body(c);
  const status = String(b.status ?? '');
  if (!['open', 'closed'].includes(status)) return c.json({ ok: false }, 400);
  await runtimeFrom(c).env.DB.prepare("UPDATE support_threads SET status = ?, escalated = CASE WHEN ? = 'closed' THEN 0 ELSE escalated END, updated_at = ? WHERE id = ?").bind(status, status, Date.now(), c.req.param('id')).run();
  return c.json({ ok: true });
});

supportAdmin.put('/drafts/:did', async (c) => {
  const b = await body(c);
  const text = String(b.body ?? '').trim().slice(0, 8000);
  if (!text) return c.json({ ok: false }, 400);
  await runtimeFrom(c).env.DB.prepare("UPDATE support_drafts SET body = ?, edited = 1 WHERE id = ? AND status = 'draft'").bind(text, c.req.param('did')).run();
  return c.json({ ok: true });
});

supportAdmin.post('/drafts/:did/send', async (c) => {
  const rt = runtimeFrom(c);
  const b = await body(c);
  const r = await sendDraft(rt, c.req.param('did'), 'you', typeof b.body === 'string' && b.body.trim() ? b.body : undefined);
  await logAction(rt, { dept: 'support', kind: REPLY_KIND, summary: r.summary, actor: 'you', status: r.ok ? 'done' : 'failed', payload: { draftId: c.req.param('did') } });
  return c.json(r, r.ok ? 200 : 400);
});

supportAdmin.post('/drafts/:did/discard', async (c) => {
  await runtimeFrom(c).env.DB.prepare("UPDATE support_drafts SET status = 'discarded' WHERE id = ? AND status = 'draft'").bind(c.req.param('did')).run();
  return c.json({ ok: true });
});

/** Pull in room questions and draft open threads now (the cron does this every 5 minutes). */
supportAdmin.post('/process', async (c) => c.json(await processSupport(runtimeFrom(c))));

/** Paste a question to see how the inbox handles it (stored as an email thread from that address). */
supportAdmin.post('/test', async (c) => {
  const rt = runtimeFrom(c);
  const b = await body(c);
  const r = await ingestEmail(rt, { from: String(b.from ?? ''), subject: String(b.subject ?? 'Test question'), text: String(b.text ?? '') });
  if (!r.ok || !('threadId' in r) || !r.threadId) return c.json(r, 400);
  return c.json({ ...r, draft: await draftForThread(rt, r.threadId) });
});

/** One click: create the Resend webhook for received mail (email.received) and keep its signing secret. */
supportAdmin.post('/connect', async (c) => {
  const rt = runtimeFrom(c);
  if (!rt.settings.RESEND_API_KEY) return c.json({ ok: false, error: 'Add the Resend API key first (Integrations → Email).' }, 400);
  const endpoint = `${rt.origin}/hooks/resend-inbound`;
  const res = await fetch('https://api.resend.com/webhooks', {
    method: 'POST',
    headers: { authorization: `Bearer ${rt.settings.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, events: ['email.received'] }),
  });
  const j = (await res.json().catch(() => ({}))) as { signing_secret?: string; message?: string };
  if (!res.ok || !j.signing_secret) return c.json({ ok: false, error: `Resend said ${res.status}: ${j.message ?? 'no signing secret returned'}. Create it in Resend → Webhooks (${endpoint}, event email.received) and paste the signing secret under Integrations → Clients & support. Then add a receiving domain or use your .resend.app address (Resend → Emails → Receiving).` }, 400);
  await saveSettings(rt.env, { SUPPORT_RESEND_WEBHOOK_SECRET: j.signing_secret });
  return c.json({ ok: true, endpoint });
});
