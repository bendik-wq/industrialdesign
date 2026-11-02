import { Hono } from 'hono';
import { type AppEnv, type Runtime, runtimeFrom } from '../app';
import { validateEmail, cleanName } from '../funnel/leads';
import { safeEqual } from '../lib/crypto';
import { newId, newRefCode } from '../lib/ids';
import { overLimit } from '../lib/ratelimit';
import { logAction } from '../ops/actions';
import { verifyResend } from './bounces';
import { bodyId, onceOnly } from '../lib/webhook-events';
import { draftForThread, fetchResendReceived, ingestEmail } from '../support/inbox';

/**
 * Inbound webhooks for builder E: support email (Resend inbound or any forwarder) and Zapier actions.
 * Mounted at /hooks before the main hooks router. Every route fails closed without its secret.
 */
export const opsHooks = new Hono<AppEnv>();

const bearer = (h: string | undefined) => (h && /^Bearer\s+(.+)$/i.exec(h)?.[1]?.trim()) || '';
const secretOk = (expected: string, given: string) => Boolean(expected && given && safeEqual(given, expected));
const ip = (c: { req: { header: (k: string) => string | undefined } }) => c.req.header('cf-connecting-ip') ?? 'unknown';

/** After storing a message, draft the answer in the background (the cron catches anything this misses). */
function draftLater(rt: Runtime, threadId: string | null | undefined) {
  if (threadId) rt.waitUntil(draftForThread(rt, threadId));
}

// Generic forwarder: Zapier / Make / a Cloudflare Email Worker posts JSON (or a form) with the shared secret.
opsHooks.post('/support-email', async (c) => {
  const rt = runtimeFrom(c);
  const secret = rt.settings.SUPPORT_INBOUND_SECRET;
  if (!secret) return c.json({ error: 'SUPPORT_INBOUND_SECRET not configured' }, 501);
  if (!secretOk(secret, c.req.header('x-support-secret') || bearer(c.req.header('authorization')))) return c.json({ error: 'bad secret' }, 401);
  if (await overLimit(c.env, `support-in:${ip(c)}`, 300)) return c.json({ error: 'rate limited' }, 429);
  const ct = c.req.header('content-type') ?? '';
  const b = (ct.includes('application/json') ? await c.req.json<Record<string, unknown>>().catch(() => ({})) : await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>;
  const str = (...keys: string[]) => { for (const k of keys) { const v = b[k]; if (typeof v === 'string' && v.trim()) return v; } return null; };
  const r = await ingestEmail(rt, {
    from: str('from', 'sender', 'from_email') ?? '',
    to: str('to', 'recipient'),
    subject: str('subject'),
    text: str('text', 'body_plain', 'body-plain', 'plain', 'body'),
    html: str('html', 'body_html', 'body-html'),
    messageId: str('message_id', 'messageId', 'Message-Id'),
    inReplyTo: str('in_reply_to', 'inReplyTo', 'In-Reply-To'),
  });
  if (!r.ok) return c.json(r, 400);
  if ('threadId' in r) draftLater(rt, r.threadId);
  return c.json(r);
});

// Resend inbound (event email.received, Svix-signed). The webhook has metadata only; the body is fetched by id.
opsHooks.post('/resend-inbound', async (c) => {
  const rt = runtimeFrom(c);
  const secret = rt.settings.SUPPORT_RESEND_WEBHOOK_SECRET;
  if (!secret) return c.json({ error: 'SUPPORT_RESEND_WEBHOOK_SECRET not configured' }, 501);
  const raw = await c.req.text();
  const svixId = c.req.header('svix-id');
  const ok = await verifyResend(secret, raw, { id: svixId, timestamp: c.req.header('svix-timestamp'), signature: c.req.header('svix-signature') });
  if (!ok || !svixId) return c.json({ error: 'bad signature' }, 401);
  let ev: { type?: string; data?: { email_id?: string; from?: string; to?: string[]; subject?: string; message_id?: string } };
  try { ev = JSON.parse(raw); } catch { return c.json({ error: 'invalid json' }, 400); }
  if (ev.type !== 'email.received' || !ev.data?.email_id) return c.json({ ignored: ev.type ?? 'unknown' });
  // One run per Resend event (svix-id is the same on every retry), so a retry can't file the message twice.
  const once = await onceOnly(rt.env, 'resend-inbound', svixId, () => receiveResend(rt, ev as Parameters<typeof receiveResend>[1]), { kind: ev.type });
  if (!once.ran) return once.inProgress ? c.json({ error: 'already processing' }, 409) : c.json({ ok: true, duplicate: true });
  return c.json(once.result);
});

async function receiveResend(rt: Runtime, ev: { data: { email_id: string; from?: string; to?: string[]; subject?: string; message_id?: string } }) {
  let full = null;
  try { full = await fetchResendReceived(rt, ev.data.email_id); } catch (e) { console.error('resend received fetch', e); }
  // Without the body (no API key, or Resend down) we still record the message so it isn't lost; the subject is the body.
  const m = full ?? { from: ev.data.from ?? '', subject: ev.data.subject ?? '', text: `(Body not fetched: open it in Resend → Emails → Receiving, id ${ev.data.email_id}.) ${ev.data.subject ?? ''}`, messageId: ev.data.message_id ?? null, providerId: ev.data.email_id };
  const r = await ingestEmail(rt, m);
  if (r.ok && 'threadId' in r) draftLater(rt, r.threadId);
  return r.ok ? r : { ok: false, error: r.error };
}

// Zapier (or Make, n8n): actions into the funnel. POST /hooks/zapier/create-lead | add-note
export const ZAPIER_ACTIONS = ['create-lead', 'add-note'] as const;
export const ZAPIER_DEDUPE_MS = 15 * 60_000;
class Rejected extends Error { constructor(readonly result: [Record<string, unknown>, 200 | 400]) { super('rejected'); } }
opsHooks.post('/zapier/:action', async (c) => {
  const rt = runtimeFrom(c);
  const secret = rt.settings.ZAPIER_INBOUND_SECRET;
  if (!secret) return c.json({ error: 'ZAPIER_INBOUND_SECRET not configured' }, 501);
  if (!secretOk(secret, c.req.header('x-zapier-secret') || bearer(c.req.header('authorization')))) return c.json({ error: 'bad secret' }, 401);
  if (await overLimit(c.env, `zapier-in:${ip(c)}`, 600)) return c.json({ error: 'rate limited' }, 429);
  const action = c.req.param('action');
  const ct = c.req.header('content-type') ?? '';
  const b = (ct.includes('application/json') ? await c.req.json<Record<string, unknown>>().catch(() => ({})) : await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>;
  if (!(ZAPIER_ACTIONS as readonly string[]).includes(action)) return c.json({ error: `unknown action; use one of ${ZAPIER_ACTIONS.join(', ')}` }, 404);
  // Zapier retries a step that timed out or failed: an Idempotency-Key header (or idempotency_key field) makes the
  // retry a no-op; without one, the same action with the same fields within ZAPIER_DEDUPE_MS counts once (a note
  // isn't added twice). Zapier signs nothing, so this window is also the replay protection for a leaked request.
  const explicit = (c.req.header('idempotency-key') || (typeof b.idempotency_key === 'string' ? b.idempotency_key : '')).trim().slice(0, 120);
  const id = explicit ? `key:${action}:${explicit}` : await bodyId(`${action}\n${JSON.stringify(b)}`);
  // A rejected request (400) isn't recorded as handled: sending it again gets the same answer, not "duplicate".
  const run = async () => {
    const r = await (action === 'create-lead' ? zapierCreateLead(rt, b) : zapierAddNote(rt, b));
    if (r[1] !== 200) throw new Rejected(r);
    return r;
  };
  try {
    const once = await onceOnly(rt.env, 'zapier', id, run, { kind: action, windowMs: explicit ? 0 : ZAPIER_DEDUPE_MS });
    if (!once.ran) return once.inProgress ? c.json({ error: 'already processing' }, 409) : c.json({ ok: true, duplicate: true });
    return c.json(...once.result);
  } catch (e) {
    if (e instanceof Rejected) return c.json(...e.result);
    throw e;
  }
});

const noteLine = (note: string, via: string) => `[${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC, ${via}] ${note.replace(/[<>]/g, '').trim().slice(0, 2000)}`;

export async function zapierCreateLead(rt: Runtime, b: Record<string, unknown>): Promise<[Record<string, unknown>, 200 | 400]> {
  const v = validateEmail(b.email);
  if (!v) return [{ ok: false, error: 'a valid email is required' }, 400];
  const db = rt.env.DB;
  const note = typeof b.note === 'string' && b.note.trim() ? noteLine(b.note, 'Zapier') : null;
  const existing = await db.prepare('SELECT id, ref_code, notes FROM leads WHERE email = ?').bind(v.email).first<{ id: string; ref_code: string; notes: string | null }>();
  if (existing) {
    if (note) await db.prepare('UPDATE leads SET notes = ?, updated_at = ? WHERE id = ?').bind([existing.notes, note].filter(Boolean).join('\n'), Date.now(), existing.id).run();
    await logAction(rt, { dept: 'sales', kind: 'zapier.create_lead', summary: `Zapier: lead already existed (${v.email})${note ? ', note added' : ''}`, leadId: existing.id, actor: 'auto', status: 'done' });
    return [{ ok: true, lead_id: existing.id, ref: existing.ref_code, existing: true }, 200];
  }
  const id = newId('l_');
  const ref = newRefCode();
  const now = Date.now();
  const phone = typeof b.phone === 'string' ? b.phone.replace(/[^\d+]/g, '').slice(0, 20) || null : null;
  const source = typeof b.source === 'string' ? b.source.replace(/[^\w .:/-]/g, '').slice(0, 60) || 'zapier' : 'zapier';
  await db.prepare(
    `INSERT INTO leads (id, ref_code, created_at, updated_at, first_name, last_name, email, phone, status, channel, utm_source, notes, qual_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'partial', 'Referral', ?, ?, 'zapier')`,
  ).bind(id, ref, now, now, cleanName(b.first_name), cleanName(b.last_name), v.email, phone, source, note).run();
  await logAction(rt, { dept: 'sales', kind: 'zapier.create_lead', summary: `Zapier created a lead (${v.email}, source ${source})`, leadId: id, actor: 'auto', status: 'done' });
  return [{ ok: true, lead_id: id, ref, existing: false }, 200];
}

export async function zapierAddNote(rt: Runtime, b: Record<string, unknown>): Promise<[Record<string, unknown>, 200 | 400]> {
  const note = typeof b.note === 'string' ? b.note.trim() : '';
  if (!note) return [{ ok: false, error: 'note is required' }, 400];
  const db = rt.env.DB;
  const v = validateEmail(b.email);
  const lead = typeof b.lead_id === 'string' && b.lead_id
    ? await db.prepare('SELECT id, notes FROM leads WHERE id = ?').bind(b.lead_id).first<{ id: string; notes: string | null }>()
    : typeof b.ref === 'string' && b.ref
      ? await db.prepare('SELECT id, notes FROM leads WHERE ref_code = ?').bind(b.ref.toUpperCase()).first<{ id: string; notes: string | null }>()
      : v ? await db.prepare('SELECT id, notes FROM leads WHERE email = ?').bind(v.email).first<{ id: string; notes: string | null }>() : null;
  if (!lead) return [{ ok: false, error: 'lead not found (send lead_id, ref or email)' }, 400];
  await db.prepare('UPDATE leads SET notes = ?, updated_at = ? WHERE id = ?').bind([lead.notes, noteLine(note, 'Zapier')].filter(Boolean).join('\n'), Date.now(), lead.id).run();
  await logAction(rt, { dept: 'sales', kind: 'zapier.add_note', summary: 'Zapier added a note', detail: note.slice(0, 500), leadId: lead.id, actor: 'auto', status: 'done' });
  return [{ ok: true, lead_id: lead.id }, 200];
}
