import { Hono } from 'hono';
import { type AppEnv, type Runtime, runtimeFrom } from '../app';
import { requireAdmin } from '../admin/auth';
import { newId } from '../lib/ids';
import { logAction } from '../ops/actions';
import { claudeReady, NO_KEY_NOTE } from '../ops/claude';
import { CHECKLISTS, FLAG_LABELS, rebuildClients, rescoreClient } from './health';
import { CHECKIN_KIND, editCheckin, proposeCheckin, sendCheckin, skipCheckin } from './checkins';

/** Funnel HQ → Clients. Mounted at /admin/api/clients (admin-only). */
export const clientsAdmin = new Hono<AppEnv>();
clientsAdmin.use('*', requireAdmin);

const body = async (c: { req: { json: <T>() => Promise<T> } }) => (await c.req.json<Record<string, unknown>>().catch(() => ({}))) as Record<string, unknown>;
const parse = <T>(s: unknown, d: T): T => { try { return (JSON.parse(String(s ?? '')) as T) ?? d; } catch { return d; } };
export const TOUCH_KINDS = ['session_attended', 'session_missed', 'call', 'note', 'outreach_sent'] as const;

export async function clientsOverview(rt: Runtime) {
  const db = rt.env.DB;
  const { results } = await db.prepare(
    `SELECT c.*, l.first_name, l.last_name, l.email, l.ref_code,
            (SELECT id FROM cs_checkins k WHERE k.lead_id = c.lead_id AND k.status = 'proposed' ORDER BY created_at DESC LIMIT 1) AS pending_checkin
       FROM cs_clients c JOIN leads l ON l.id = c.lead_id
      ORDER BY CASE c.band WHEN 'at_risk' THEN 0 WHEN 'watch' THEN 1 WHEN 'healthy' THEN 2 ELSE 3 END, c.health ASC LIMIT 500`,
  ).all<Record<string, unknown>>();
  const clients = results.map((r) => ({
    lead_id: r.lead_id, name: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || r.ref_code, email: r.email,
    type: r.client_type, since_at: r.since_at, health: r.health, band: r.band,
    reasons: parse(r.reasons, []), flags: parse<string[]>(r.flags, []),
    last_contact_at: r.last_contact_at, last_outbound_at: r.last_outbound_at, next_checkin_at: r.next_checkin_at, pending_checkin: r.pending_checkin, scored_at: r.scored_at,
  }));
  const count = (b: string) => clients.filter((c) => c.band === b).length;
  const lastRun = await db.prepare("SELECT value FROM kv_state WHERE key = 'cs:daily'").first<{ value: string }>().catch(() => null);
  return {
    clients,
    summary: { total: clients.length, healthy: count('healthy'), watch: count('watch'), at_risk: count('at_risk'), churned: count('churned'), checkins_waiting: clients.filter((c) => c.pending_checkin).length },
    flagLabels: FLAG_LABELS,
    checklists: CHECKLISTS,
    lastRun: lastRun?.value ?? null,
    ai: claudeReady(rt) ? null : NO_KEY_NOTE,
  };
}

/** One client's timeline: purchases, agreements, Sprint milestones, messages both ways, check-ins and logged touchpoints. */
export async function clientTimeline(rt: Runtime, leadId: string) {
  const db = rt.env.DB;
  const all = (sql: string, ...b: unknown[]) => db.prepare(sql).bind(...b).all<Record<string, unknown>>().then((r) => r.results).catch(() => []);
  const [passes, contracts, sprint, msgs, checkins, touches, emails] = await Promise.all([
    all("SELECT kind, product, status, amount, currency, paid_at, refunded_at FROM webinar_passes WHERE lead_id = ? AND status IN ('paid', 'refunded')", leadId),
    all("SELECT title, status, fee, currency, sent_at, signed_at, paid_at FROM contracts WHERE lead_id = ? AND COALESCE(is_test, 0) = 0", leadId),
    all('SELECT kickoff_booked_at, kickoff_held_at, plan_booked_at, plan_held_at, proposal_sent_at, outcome, outcome_at FROM deal_sprints WHERE lead_id = ?', leadId),
    all("SELECT m.direction, m.body, m.created_at, t.channel, t.subject, t.id AS thread_id FROM support_messages m JOIN support_threads t ON t.id = m.thread_id WHERE t.lead_id = ? ORDER BY m.created_at DESC LIMIT 50", leadId),
    all('SELECT id, status, subject, body, reason, drafted_by, error, created_at, sent_at FROM cs_checkins WHERE lead_id = ? ORDER BY created_at DESC LIMIT 30', leadId),
    all('SELECT id, kind, at, note FROM cs_touchpoints WHERE lead_id = ? ORDER BY at DESC LIMIT 100', leadId),
    all("SELECT subject, sequence, sent_at FROM emails WHERE lead_id = ? AND status = 'sent' AND sent_at IS NOT NULL ORDER BY sent_at DESC LIMIT 20", leadId),
  ]);
  const ev: { at: number; kind: string; text: string; source: string }[] = [];
  const push = (at: unknown, kind: string, text: string, source: string) => { if (at) ev.push({ at: Number(at), kind, text, source }); };
  const KIND: Record<string, string> = { offer: 'First Deal Sprint', deposit: 'Engagement deposit', seat: 'Masterclass ticket', live_ticket: 'Live webinar ticket', challenge: 'Challenge ticket' };
  for (const p of passes) {
    push(p.paid_at, 'payment', `${KIND[String(p.kind)] ?? p.product ?? p.kind} paid (${(Number(p.amount) / 100).toLocaleString('en-US')} ${String(p.currency).toUpperCase()})`, 'dealsprint');
    push(p.refunded_at, 'refund', `${KIND[String(p.kind)] ?? p.kind} refunded`, 'dealsprint');
  }
  for (const k of contracts) {
    push(k.sent_at, 'agreement', `Agreement sent: ${k.title}`, 'contracts');
    push(k.signed_at, 'agreement', `Agreement signed (${Number(k.fee).toLocaleString('en-US')} ${k.currency})`, 'contracts');
    push(k.paid_at, 'payment', 'Agreement marked paid', 'contracts');
  }
  for (const s of sprint) {
    push(s.kickoff_held_at, 'sprint', 'Sprint kickoff held', 'dealsprint');
    push(s.plan_held_at, 'sprint', 'Deal Plan session held', 'dealsprint');
    push(s.proposal_sent_at, 'sprint', 'Engagement proposal sent', 'dealsprint');
  }
  for (const m of msgs) push(m.created_at, m.direction === 'in' ? 'inbound' : 'outbound', `${m.direction === 'in' ? 'They wrote' : 'We replied'} (${m.channel}): ${String(m.body).slice(0, 160)}`, 'support');
  for (const c of checkins) push(c.sent_at ?? c.created_at, 'checkin', `Check-in ${c.status}: ${c.subject}`, 'clients');
  for (const t of touches) push(t.at, 'touch', `${String(t.kind).replace(/_/g, ' ')}${t.note ? `: ${t.note}` : ''}`, 'clients');
  for (const e of emails) push(e.sent_at, 'email', `Email (${e.sequence}): ${e.subject ?? ''}`, 'emails');
  ev.sort((a, b) => b.at - a.at);
  return { timeline: ev.slice(0, 200), checkins, touchpoints: touches };
}

clientsAdmin.get('/', async (c) => c.json(await clientsOverview(runtimeFrom(c))));

clientsAdmin.post('/rebuild', async (c) => c.json({ ok: true, ...(await rebuildClients(runtimeFrom(c))) }));

clientsAdmin.get('/:id', async (c) => {
  const rt = runtimeFrom(c);
  const id = c.req.param('id');
  const scored = await rescoreClient(rt, id);
  if (!scored) return c.json({ error: 'not a client' }, 404);
  const lead = await rt.env.DB.prepare('SELECT id, first_name, last_name, email, phone, ref_code, revenue_band, industry FROM leads WHERE id = ?').bind(id).first();
  const row = await rt.env.DB.prepare('SELECT next_checkin_at, owner_note FROM cs_clients WHERE lead_id = ?').bind(id).first<{ next_checkin_at: number | null; owner_note: string | null }>();
  const { results: history } = await rt.env.DB.prepare('SELECT day, health, band FROM cs_health_history WHERE lead_id = ? ORDER BY day DESC LIMIT 60').bind(id).all();
  return c.json({ lead, type: scored.client.type, since_at: scored.client.since_at, health: scored.health, checklist: scored.checklist, next_checkin_at: row?.next_checkin_at ?? null, owner_note: row?.owner_note ?? null, history, ...(await clientTimeline(rt, id)) });
});

clientsAdmin.post('/:id/checkin', async (c) => {
  const r = await proposeCheckin(runtimeFrom(c), c.req.param('id'), { reason: 'Requested from Funnel HQ' });
  return c.json(r, r.ok ? 200 : 400);
});

clientsAdmin.put('/:id/checklist', async (c) => {
  const rt = runtimeFrom(c);
  const b = await body(c);
  const key = String(b.key ?? '');
  const valid = Object.values(CHECKLISTS).some((l) => l.some((i) => i.key === key && !i.derive));
  if (!valid) return c.json({ ok: false, error: 'That item is filled in from the data, or does not exist.' }, 400);
  const row = await rt.env.DB.prepare('SELECT checklist FROM cs_clients WHERE lead_id = ?').bind(c.req.param('id')).first<{ checklist: string }>();
  if (!row) return c.json({ ok: false, error: 'Run the health check first.' }, 400);
  const list = parse<Record<string, number>>(row.checklist, {});
  if (b.done) list[key] = Date.now(); else delete list[key];
  await rt.env.DB.prepare('UPDATE cs_clients SET checklist = ?, updated_at = ? WHERE lead_id = ?').bind(JSON.stringify(list), Date.now(), c.req.param('id')).run();
  return c.json({ ok: true });
});

clientsAdmin.put('/:id/note', async (c) => {
  const b = await body(c);
  await runtimeFrom(c).env.DB.prepare('UPDATE cs_clients SET owner_note = ?, updated_at = ? WHERE lead_id = ?').bind(String(b.note ?? '').slice(0, 2000) || null, Date.now(), c.req.param('id')).run();
  return c.json({ ok: true });
});

clientsAdmin.post('/:id/touchpoints', async (c) => {
  const rt = runtimeFrom(c);
  const b = await body(c);
  const kind = String(b.kind ?? '');
  if (!(TOUCH_KINDS as readonly string[]).includes(kind)) return c.json({ ok: false, error: 'Unknown kind.' }, 400);
  const at = Number(b.at) > 0 && Number(b.at) <= Date.now() + 60_000 ? Number(b.at) : Date.now();
  await rt.env.DB.prepare('INSERT INTO cs_touchpoints (id, lead_id, kind, at, note, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(newId('tp_'), c.req.param('id'), kind, at, String(b.note ?? '').slice(0, 1000) || null, Date.now()).run();
  await logAction(rt, { dept: 'client_success', kind: 'cs.touchpoint', summary: `Logged ${kind.replace(/_/g, ' ')}`, leadId: c.req.param('id'), actor: 'you', status: 'done' });
  return c.json({ ok: true });
});

clientsAdmin.put('/checkins/:cid', async (c) => {
  const b = await body(c);
  const r = await editCheckin(runtimeFrom(c), c.req.param('cid'), String(b.subject ?? ''), String(b.body ?? ''));
  return c.json(r, r.ok ? 200 : 400);
});
clientsAdmin.post('/checkins/:cid/send', async (c) => {
  const rt = runtimeFrom(c);
  const r = await sendCheckin(rt, c.req.param('cid'), 'you');
  await logAction(rt, { dept: 'client_success', kind: CHECKIN_KIND, summary: r.summary, actor: 'you', status: r.ok ? 'done' : 'failed', payload: { checkinId: c.req.param('cid') } });
  return c.json(r, r.ok ? 200 : 400);
});
clientsAdmin.post('/checkins/:cid/skip', async (c) => c.json(await skipCheckin(runtimeFrom(c), c.req.param('cid'))));
