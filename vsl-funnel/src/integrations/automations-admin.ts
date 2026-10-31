import { Hono } from 'hono';
import { type AppEnv, type Runtime, runtimeFrom } from '../app';
import { requireAdmin } from '../admin/auth';
import { newId } from '../lib/ids';
import { saveSettings } from '../settings';
import { logAction } from '../ops/actions';
import { TOOLS } from '../mcp/tools';
import { HOOK_EVENTS, type DeliveryRow, deliverOne, newSecret, validHookUrl } from './webhooks-out';
import { ZAPIER_ACTIONS } from './hooks-in';

/**
 * Funnel HQ → Integrations → "Claude (MCP)" and "Zapier & webhooks". Mounted at /admin/api/automations.
 * Tokens and secrets are generated here and shown once; afterwards only their last four characters are.
 */
export const automationsAdmin = new Hono<AppEnv>();
automationsAdmin.use('*', requireAdmin);

const body = async (c: { req: { json: <T>() => Promise<T> } }) => (await c.req.json<Record<string, unknown>>().catch(() => ({}))) as Record<string, unknown>;
const tail = (v: string) => (v ? `••••${v.slice(-4)}` : '');
const fromEnv = (rt: Runtime, key: string) => Boolean(((rt.env as unknown as Record<string, string | undefined>)[key] ?? '').trim());
const cleanEvents = (v: unknown) => {
  const list = Array.isArray(v) ? v.map(String) : [];
  if (list.includes('*')) return ['*'];
  return list.filter((e) => e in HOOK_EVENTS);
};

automationsAdmin.get('/', async (c) => {
  const rt = runtimeFrom(c);
  const db = rt.env.DB;
  const [{ results: subs }, { results: deliveries }, stats] = await Promise.all([
    db.prepare('SELECT id, url, events, label, active, last_status, last_at, created_at, secret FROM hook_subscriptions ORDER BY created_at').all<Record<string, unknown>>(),
    db.prepare(`SELECT d.id, d.sub_id, d.status, d.attempts, d.last_status, d.last_error, d.next_at, d.created_at, d.delivered_at, e.event
                  FROM hook_deliveries d JOIN hook_events e ON e.id = d.event_id ORDER BY d.created_at DESC LIMIT 50`).all<Record<string, unknown>>(),
    db.prepare("SELECT COUNT(*) AS events, MAX(created_at) AS last FROM hook_events").first<{ events: number; last: number | null }>(),
  ]);
  const s = rt.settings;
  return c.json({
    mcp: {
      url: `${rt.origin}/mcp`,
      token: tail(s.MCP_TOKEN), tokenSet: Boolean(s.MCP_TOKEN), locked: fromEnv(rt, 'MCP_TOKEN'),
      tools: TOOLS.map((t) => ({ name: t.name, title: t.title, write: Boolean(t.write) })),
    },
    zapier: {
      secret: tail(s.ZAPIER_INBOUND_SECRET), secretSet: Boolean(s.ZAPIER_INBOUND_SECRET),
      actions: ZAPIER_ACTIONS.map((a) => ({ action: a, url: `${rt.origin}/hooks/zapier/${a}` })),
    },
    support: { forwardSecretSet: Boolean(s.SUPPORT_INBOUND_SECRET), forwardUrl: `${rt.origin}/hooks/support-email` },
    events: HOOK_EVENTS,
    subscriptions: subs.map(({ secret, ...r }) => ({ ...r, secret: tail(String(secret)), events: JSON.parse(String(r.events)) })),
    deliveries,
    stats,
  });
});

/** Generate (or rotate) one of the shared secrets. Shown once. */
automationsAdmin.post('/secret/:which', async (c) => {
  const rt = runtimeFrom(c);
  const key = ({ mcp: 'MCP_TOKEN', zapier: 'ZAPIER_INBOUND_SECRET', support: 'SUPPORT_INBOUND_SECRET' } as const)[c.req.param('which') as 'mcp' | 'zapier' | 'support'];
  if (!key) return c.json({ ok: false, error: 'unknown secret' }, 404);
  if (fromEnv(rt, key)) return c.json({ ok: false, error: `${key} is set as a Worker secret; rotate it with wrangler secret put ${key}.` }, 400);
  const value = `${key === 'MCP_TOKEN' ? 'mcp_' : ''}${newSecret()}${newSecret().slice(0, 16)}`;
  await saveSettings(rt.env, { [key]: value });
  await logAction(rt, { dept: 'chief', kind: 'integrations.secret', summary: `${key} generated (the previous one stopped working)`, actor: 'you', status: 'done' });
  return c.json({ ok: true, key, value });
});

automationsAdmin.post('/subscriptions', async (c) => {
  const rt = runtimeFrom(c);
  const b = await body(c);
  const url = validHookUrl(String(b.url ?? ''));
  if (!url) return c.json({ ok: false, error: 'Use an https:// URL (a Zapier Catch Hook, Make or n8n webhook).' }, 400);
  const events = cleanEvents(b.events);
  if (!events.length) return c.json({ ok: false, error: 'Pick at least one event.' }, 400);
  const id = newId('hs_');
  const secret = newSecret();
  await rt.env.DB.prepare('INSERT INTO hook_subscriptions (id, url, events, secret, label, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
    .bind(id, url, JSON.stringify(events), secret, String(b.label ?? '').slice(0, 80) || null, Date.now()).run();
  await logAction(rt, { dept: 'chief', kind: 'integrations.webhook', summary: `Webhook added: ${new URL(url).host} (${events.join(', ')})`, actor: 'you', status: 'done' });
  return c.json({ ok: true, id, secret });
});

automationsAdmin.put('/subscriptions/:id', async (c) => {
  const b = await body(c);
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (b.active != null) { sets.push('active = ?'); vals.push(b.active ? 1 : 0); }
  if (b.events != null) { const e = cleanEvents(b.events); if (!e.length) return c.json({ ok: false, error: 'Pick at least one event.' }, 400); sets.push('events = ?'); vals.push(JSON.stringify(e)); }
  if (b.label != null) { sets.push('label = ?'); vals.push(String(b.label).slice(0, 80) || null); }
  if (!sets.length) return c.json({ ok: false }, 400);
  await runtimeFrom(c).env.DB.prepare(`UPDATE hook_subscriptions SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, c.req.param('id')).run();
  return c.json({ ok: true });
});

automationsAdmin.post('/subscriptions/:id/rotate', async (c) => {
  const secret = newSecret();
  await runtimeFrom(c).env.DB.prepare('UPDATE hook_subscriptions SET secret = ? WHERE id = ?').bind(secret, c.req.param('id')).run();
  return c.json({ ok: true, secret });
});

automationsAdmin.delete('/subscriptions/:id', async (c) => {
  const db = runtimeFrom(c).env.DB;
  await db.batch([db.prepare('DELETE FROM hook_deliveries WHERE sub_id = ?').bind(c.req.param('id')), db.prepare('DELETE FROM hook_subscriptions WHERE id = ?').bind(c.req.param('id'))]);
  return c.json({ ok: true });
});

/** Send a signed test event (event "test.ping") to one subscriber right now. */
automationsAdmin.post('/subscriptions/:id/test', async (c) => {
  const rt = runtimeFrom(c);
  const db = rt.env.DB;
  const sub = await db.prepare('SELECT id, url, secret FROM hook_subscriptions WHERE id = ?').bind(c.req.param('id')).first<{ id: string; url: string; secret: string }>();
  if (!sub) return c.json({ ok: false, error: 'not found' }, 404);
  const now = Date.now();
  const evId = newId('ev_');
  const payload = JSON.stringify({ test: true, message: 'Test event from Funnel HQ' });
  const dlId = newId('dl_');
  await db.batch([
    db.prepare('INSERT INTO hook_events (id, event, ref_id, payload, created_at) VALUES (?, ?, ?, ?, ?)').bind(evId, 'test.ping', evId, payload, now),
    db.prepare("INSERT INTO hook_deliveries (id, sub_id, event_id, status, attempts, next_at, created_at) VALUES (?, ?, ?, 'pending', 0, ?, ?)").bind(dlId, sub.id, evId, now, now),
  ]);
  const row: DeliveryRow = { id: dlId, sub_id: sub.id, event_id: evId, attempts: 0, url: sub.url, secret: sub.secret, event: 'test.ping', payload, ev_created: now };
  const r = await deliverOne(rt, row, now);
  const d = await db.prepare('SELECT last_status, last_error FROM hook_deliveries WHERE id = ?').bind(dlId).first<{ last_status: number | null; last_error: string | null }>();
  return c.json({ ok: r === 'delivered', result: r, status: d?.last_status ?? null, error: d?.last_error ?? null });
});
