import type { Runtime } from '../app';
import { hmacHex, safeEqual } from '../lib/crypto';
import { newId } from '../lib/ids';

/**
 * Zapier-style outbound webhooks. Business events are detected from our own tables every cron run (so no
 * payment, booking or lead code path has to change), stored once per (event, ref) in hook_events, and
 * delivered to every subscribed URL as signed JSON, with retries on a back-off schedule.
 *
 * Signature: header `X-Funnel-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`.
 * Receivers recompute it with the subscription's secret and reject anything older than 5 minutes.
 */

export const HOOK_EVENTS = {
  'lead.created': 'A new lead (application, registration, booking or import)',
  'ticket.paid': 'A paid ticket: masterclass, live webinar or challenge',
  'booking.created': 'A call booked (Calendly or another booking tool)',
  'deal.won': 'A lead marked won in Calls & deals',
  'deposit.paid': 'An engagement deposit paid',
  'sprint.paid': 'A First Deal Sprint paid',
  'refund.created': 'A refund (any product or payment)',
} as const;
export type HookEvent = keyof typeof HOOK_EVENTS;
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000, 24 * 3_600_000];
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

export async function signPayload(secret: string, body: string, ts = Math.floor(Date.now() / 1000)) {
  return `t=${ts},v1=${await hmacHex(secret, `${ts}.${body}`)}`;
}
export async function verifyPayload(secret: string, body: string, header: string, now = Date.now(), toleranceS = 300) {
  const m = /t=(\d+),v1=([a-f0-9]{64})/.exec(header ?? '');
  if (!m || Math.abs(now / 1000 - Number(m[1])) > toleranceS) return false;
  return safeEqual(await hmacHex(secret, `${m[1]}.${body}`), m[2]);
}

/** https only, and never an address that points back into a private network. */
export function validHookUrl(raw: string) {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || /^(\d+\.){3}\d+$/.test(h) || h.includes(':')) return null;
  return u.toString();
}

export const newSecret = () => [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('');

const matches = (events: string, ev: string) => { try { const l = JSON.parse(events) as string[]; return l.includes('*') || l.includes(ev); } catch { return false; } };

/** Store an event once and queue a delivery to every active subscriber that wants it. Returns true when new. */
export async function recordEvent(rt: Runtime, event: HookEvent, refId: string, data: Record<string, unknown>, now = Date.now()) {
  const db = rt.env.DB;
  const id = newId('ev_');
  const ins = await db.prepare('INSERT INTO hook_events (id, event, ref_id, payload, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(event, ref_id) DO NOTHING')
    .bind(id, event, refId, JSON.stringify(data), now).run();
  if (!(ins.meta?.changes ?? 0)) return false;
  const { results: subs } = await db.prepare('SELECT id, events FROM hook_subscriptions WHERE active = 1').all<{ id: string; events: string }>();
  const due = subs.filter((s) => matches(s.events, event));
  if (due.length) await db.batch(due.map((s) => db.prepare('INSERT INTO hook_deliveries (id, sub_id, event_id, status, attempts, next_at, created_at) VALUES (?, ?, ?, ?, 0, ?, ?) ON CONFLICT(sub_id, event_id) DO NOTHING').bind(newId('dl_'), s.id, id, 'pending', now, now)));
  return true;
}

type Row = Record<string, unknown>;
const leadData = (l: Row) => ({
  id: l.id, ref: l.ref_code, first_name: l.first_name, last_name: l.last_name, email: l.email, phone: l.phone, status: l.status,
  tier: l.tier_override ?? l.tier, revenue_band: l.revenue_band, industry: l.industry, channel: l.channel, utm_source: l.utm_source, utm_campaign: l.utm_campaign, created_at: l.created_at,
});
const LEAD_COLS = 'l.id, l.ref_code, l.first_name, l.last_name, l.email, l.phone, l.status, l.tier, l.tier_override, l.revenue_band, l.industry, l.channel, l.utm_source, l.utm_campaign, l.created_at';
const TICKET_KINDS = ['seat', 'live_ticket', 'challenge'];
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Find new business events since the last run. The first run only sets the cursor (no backfill of history).
 * Each run re-reads a 10-minute overlap; hook_events' unique key makes that harmless.
 */
export async function scanEvents(rt: Runtime, now = Date.now()) {
  const db = rt.env.DB;
  const cur = await db.prepare("SELECT value FROM kv_state WHERE key = 'hooks:cursor'").first<{ value: string }>();
  const setCursor = () => db.prepare("INSERT INTO kv_state (key, value) VALUES ('hooks:cursor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(now)).run();
  if (!cur) { await setCursor(); return { found: 0, first: true }; }
  const from = Number(cur.value) - 10 * 60_000;
  const all = (sql: string) => db.prepare(sql).bind(from, now).all<Row>().then((r) => r.results).catch(() => [] as Row[]);
  const [leads, passes, chDeps, booked, won, refunds, negPay] = await Promise.all([
    all(`SELECT ${LEAD_COLS} FROM leads l WHERE l.created_at > ? AND l.created_at <= ?`),
    all(`SELECT p.id AS pass_id, p.kind, p.product, p.amount, p.currency, p.paid_at, p.source, ${LEAD_COLS} FROM webinar_passes p JOIN leads l ON l.id = p.lead_id WHERE p.paid_at > ? AND p.paid_at <= ? AND p.status IN ('paid', 'refunded')`),
    all(`SELECT d.reg_id, d.amount, d.currency, d.paid_at, ${LEAD_COLS} FROM challenge_deposits d JOIN leads l ON l.id = d.lead_id WHERE d.paid_at > ? AND d.paid_at <= ?`),
    all(`SELECT l.booked_at, l.call_at, l.booking_provider, ${LEAD_COLS} FROM leads l WHERE l.booked_at > ? AND l.booked_at <= ?`),
    all(`SELECT l.closed_at, l.revenue, l.cash_collected, l.offer, ${LEAD_COLS} FROM leads l WHERE l.status = 'won' AND l.closed_at > ? AND l.closed_at <= ?`),
    all(`SELECT p.id AS pass_id, p.kind, p.product, p.refunded_amount, p.currency, p.refunded_at, ${LEAD_COLS} FROM webinar_passes p JOIN leads l ON l.id = p.lead_id WHERE p.refunded_at > ? AND p.refunded_at <= ?`),
    all(`SELECT y.id AS pay_id, y.amount, y.paid_at, y.note, ${LEAD_COLS} FROM payments y JOIN leads l ON l.id = y.lead_id WHERE y.amount < 0 AND y.created_at > ? AND y.created_at <= ?`),
  ]);
  let found = 0;
  const rec = async (e: HookEvent, ref: string, data: Record<string, unknown>) => { if (await recordEvent(rt, e, ref, data, now)) found++; };
  for (const l of leads) await rec('lead.created', String(l.id), { lead: leadData(l) });
  for (const p of passes) {
    const money = { amount: Number(p.amount) / 100, currency: String(p.currency).toUpperCase(), paid_at: p.paid_at, product: p.product, purchase_id: p.pass_id };
    if (TICKET_KINDS.includes(String(p.kind))) await rec('ticket.paid', String(p.pass_id), { ...money, ticket: p.kind, source: p.source, lead: leadData(p) });
    else if (p.kind === 'offer') await rec('sprint.paid', String(p.pass_id), { ...money, lead: leadData(p) });
    else if (p.kind === 'deposit') await rec('deposit.paid', String(p.pass_id), { ...money, source: p.source, lead: leadData(p) });
  }
  // Challenge deposits recorded without a purchase row (one-click) are reported once per lead and day.
  for (const d of chDeps) {
    const has = await db.prepare("SELECT 1 FROM webinar_passes WHERE lead_id = ? AND kind = 'deposit' AND status IN ('paid', 'refunded') AND ABS(COALESCE(paid_at, 0) - ?) < 86400000").bind(d.id, Number(d.paid_at)).first();
    if (!has) await rec('deposit.paid', `challenge:${d.reg_id}`, { amount: d.amount != null ? Number(d.amount) / 100 : null, currency: d.currency ? String(d.currency).toUpperCase() : null, paid_at: d.paid_at, source: 'challenge', lead: leadData(d) });
  }
  for (const b of booked) await rec('booking.created', `${b.id}:${b.booked_at}`, { booked_at: b.booked_at, call_at: b.call_at, provider: b.booking_provider, lead: leadData(b) });
  for (const w of won) await rec('deal.won', `${w.id}:${day(Number(w.closed_at))}`, { closed_at: w.closed_at, revenue: w.revenue, cash_collected: w.cash_collected, offer: w.offer, lead: leadData(w) });
  for (const r of refunds) await rec('refund.created', `pass:${r.pass_id}`, { amount: Number(r.refunded_amount) / 100, currency: String(r.currency).toUpperCase(), refunded_at: r.refunded_at, product: r.product ?? r.kind, lead: leadData(r) });
  for (const p of negPay) await rec('refund.created', `pay:${p.pay_id}`, { amount: Math.abs(Number(p.amount)), refunded_at: p.paid_at, note: p.note, lead: leadData(p) });
  await setCursor();
  return { found, first: false };
}

export interface DeliveryRow { id: string; sub_id: string; event_id: string; attempts: number; url: string; secret: string; event: string; payload: string; ev_created: number }

/** POST one delivery. Exported for tests (inject fetch). */
export async function deliverOne(rt: Runtime, d: DeliveryRow, now = Date.now(), f: typeof fetch = fetch) {
  const db = rt.env.DB;
  const body = JSON.stringify({ id: d.event_id, event: d.event, created_at: new Date(d.ev_created).toISOString(), data: JSON.parse(d.payload) });
  const ts = Math.floor(now / 1000);
  let status = 0, error: string | null = null;
  try {
    const res = await f(d.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'FunnelHQ-Webhooks/1', 'x-funnel-event': d.event, 'x-funnel-delivery': d.id, 'x-funnel-timestamp': String(ts), 'x-funnel-signature': await signPayload(d.secret, body, ts) },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    status = res.status;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (e) {
    error = e instanceof Error ? e.message.slice(0, 200) : 'network error';
  }
  const attempts = d.attempts + 1;
  if (!error) {
    await db.batch([
      db.prepare("UPDATE hook_deliveries SET status = 'delivered', attempts = ?, last_status = ?, last_error = NULL, delivered_at = ? WHERE id = ?").bind(attempts, status, now, d.id),
      db.prepare('UPDATE hook_subscriptions SET last_status = ?, last_at = ? WHERE id = ?').bind(status, now, d.sub_id),
    ]);
    return 'delivered' as const;
  }
  // 410 Gone: the receiver says this hook no longer exists (Zapier's convention). Stop sending to it.
  const gone = status === 410;
  const final = gone || attempts >= MAX_ATTEMPTS;
  await db.batch([
    db.prepare('UPDATE hook_deliveries SET status = ?, attempts = ?, last_status = ?, last_error = ?, next_at = ? WHERE id = ?').bind(final ? 'failed' : 'pending', attempts, status || null, error, final ? now : now + RETRY_DELAYS_MS[attempts - 1], d.id),
    db.prepare(`UPDATE hook_subscriptions SET last_status = ?, last_at = ?${gone ? ', active = 0' : ''} WHERE id = ?`).bind(status || null, now, d.sub_id),
  ]);
  return final ? ('failed' as const) : ('retry' as const);
}

export async function deliverDue(rt: Runtime, now = Date.now(), limit = 40, f: typeof fetch = fetch) {
  const { results } = await rt.env.DB.prepare(
    `SELECT d.id, d.sub_id, d.event_id, d.attempts, s.url, s.secret, e.event, e.payload, e.created_at AS ev_created
       FROM hook_deliveries d JOIN hook_subscriptions s ON s.id = d.sub_id JOIN hook_events e ON e.id = d.event_id
      WHERE d.status = 'pending' AND d.next_at <= ? AND s.active = 1 ORDER BY d.next_at LIMIT ?`,
  ).bind(now, limit).all<DeliveryRow>();
  const out = { delivered: 0, retry: 0, failed: 0 };
  for (const d of results) out[await deliverOne(rt, d, now, f)]++;
  return out;
}

export async function processWebhooks(rt: Runtime, now = Date.now()) {
  const scanned = await scanEvents(rt, now);
  const sent = await deliverDue(rt, now);
  return { ...scanned, ...sent };
}
