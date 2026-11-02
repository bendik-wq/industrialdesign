import type { Context } from 'hono';
import { type AppEnv, type Runtime, runtimeFrom } from '../app';
import { getRoom, type RoomRow } from './rooms';
import { DEFAULT_AUTO_PUSH, parseAutoPush } from './state';
import {
  type ObjectionRow, type ObjectionType, type PushEventCount, type PushRow, MIN_SHOWN, QA_COPY, bestMinutes, objectionOutcomes, pushPerformance, recommendationText,
} from './qa';

/**
 * Q&A that sells in the database (migration 0074): each queued question with its objection type, answered and
 * reopened marks; and the reports for Funnel HQ → Rooms and the debrief (objection to purchase, push analytics).
 * Every write here is best effort: a missing table never stops the room.
 */

type Rt = Pick<Runtime, 'env' | 'settings'>;
const DAY = 86_400_000;

export interface Ask { roomId: string; ref: string; itemId: number; who: string; leadId: string | null; qtype: ObjectionType; by: 'rules' | 'ai'; source: 'question' | 'chat' | 'prebuy'; text: string; at: number }
export async function recordAsk(rt: Rt, a: Ask) {
  await rt.env.DB.prepare(
    'INSERT INTO room_objections (room_id, ref, item_id, who, lead_id, qtype, tagged_by, source, text, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(room_id, ref) DO NOTHING',
  ).bind(a.roomId, a.ref, a.itemId, a.who, a.leadId, a.qtype, a.by, a.source, a.text.slice(0, 400), a.at).run();
}
/** The AI co-host re-tagged a question: every ask in its cluster follows. */
export async function retag(rt: Rt, roomId: string, itemId: number, qtype: ObjectionType, by: 'rules' | 'ai') {
  await rt.env.DB.prepare('UPDATE room_objections SET qtype = ?, tagged_by = ? WHERE room_id = ? AND item_id = ?').bind(qtype, by, roomId, itemId).run();
}
export async function markAnswered(rt: Rt, roomId: string, itemId: number, now: number, reopened: boolean) {
  await rt.env.DB.prepare(`UPDATE room_objections SET answered_at = COALESCE(answered_at, ?)${reopened ? ', reopened_at = COALESCE(reopened_at, ?)' : ''} WHERE room_id = ? AND item_id = ?`)
    .bind(...(reopened ? [now, now] : [now]), roomId, itemId).run();
}

// ───────────── objection to purchase ─────────────

/** Purchase times per person: paid room cards (room_push_events) and paid deposits or Sprints by their lead. */
async function purchases(rt: Rt, rows: ObjectionRow[]) {
  const db = rt.env.DB;
  const rooms = [...new Set(rows.map((r) => r.room_id))];
  const leads = [...new Set(rows.map((r) => r.lead_id).filter((x): x is string => Boolean(x)))];
  const byWho = new Map<string, number[]>(), byLead = new Map<string, number[]>();
  for (let i = 0; i < rooms.length; i += 80) {
    const part = rooms.slice(i, i + 80);
    const r = await db.prepare(`SELECT room_id, who, at FROM room_push_events WHERE event = 'paid' AND room_id IN (${part.map(() => '?').join(',')})`).bind(...part).all<{ room_id: string; who: string; at: number }>();
    for (const x of r.results) { const k = `${x.room_id}|${x.who}`; byWho.set(k, [...(byWho.get(k) ?? []), x.at]); }
  }
  for (let i = 0; i < leads.length; i += 80) {
    const part = leads.slice(i, i + 80);
    const r = await db.prepare(`SELECT lead_id, COALESCE(paid_at, updated_at) AS at FROM webinar_passes WHERE status = 'paid' AND kind IN ('offer', 'deposit') AND lead_id IN (${part.map(() => '?').join(',')})`).bind(...part).all<{ lead_id: string; at: number }>();
    for (const x of r.results) byLead.set(x.lead_id, [...(byLead.get(x.lead_id) ?? []), x.at]);
  }
  return (room: string, who: string, lead: string | null) => [...(byWho.get(`${room}|${who}`) ?? []), ...(lead ? byLead.get(lead) ?? [] : [])];
}

/** Objection to purchase for one room, or every room in the last `days`. */
export async function objectionReport(rt: Rt, o: { roomId?: string; days?: number; now?: number } = {}) {
  const now = o.now ?? Date.now();
  const rows = o.roomId
    ? await rt.env.DB.prepare('SELECT room_id, who, lead_id, qtype, at, answered_at, reopened_at FROM room_objections WHERE room_id = ? LIMIT 20000').bind(o.roomId).all<ObjectionRow>()
    : await rt.env.DB.prepare('SELECT room_id, who, lead_id, qtype, at, answered_at, reopened_at FROM room_objections WHERE at >= ? ORDER BY at DESC LIMIT 20000').bind(now - (o.days ?? 180) * DAY).all<ObjectionRow>();
  const res = objectionOutcomes(rows.results, await purchases(rt, rows.results));
  return { ...res, rooms: new Set(rows.results.map((r) => r.room_id)).size, labels: QA_COPY.types };
}

// ───────────── push analytics ─────────────

async function pushRows(rt: Rt, o: { roomId?: string; since?: number }) {
  const db = rt.env.DB;
  const where = o.roomId ? 'p.room_id = ?' : 'p.created_at >= ?';
  const arg = o.roomId ?? o.since ?? 0;
  const [p, e] = await db.batch([
    db.prepare(`SELECT p.room_id, p.id, p.kind, p.ref, p.created_by, p.created_at, p.targets, p.closed_at, r.went_live_at FROM room_pushes p JOIN rooms r ON r.id = p.room_id WHERE ${where} ORDER BY p.created_at DESC LIMIT 3000`).bind(arg),
    db.prepare(`SELECT e.room_id, e.push_id, e.event, COUNT(DISTINCT e.who) AS n FROM room_push_events e JOIN room_pushes p ON p.room_id = e.room_id AND p.id = e.push_id WHERE ${where} GROUP BY e.room_id, e.push_id, e.event`).bind(arg),
  ]) as unknown as [{ results: PushRow[] }, { results: PushEventCount[] }];
  return pushPerformance(p.results, e.results);
}

/** The automatic schedule a room runs: its own lines, else ROOM_AUTO_PUSH, else the default. */
export function scheduleOf(rt: Rt, room?: Pick<RoomRow, 'engage'> | null) {
  let own = '';
  try { const o = JSON.parse(room?.engage || '{}') as { autoPush?: unknown }; own = typeof o.autoPush === 'string' ? o.autoPush : ''; } catch { own = ''; }
  return parseAutoPush(own.trim() ? own : ((rt.settings as unknown as Record<string, string | undefined>).ROOM_AUTO_PUSH || DEFAULT_AUTO_PUSH));
}

/** Each push in one room (manual or automatic, its minute, the funnel), and the cross-room best minutes against this room's schedule. */
export async function pushReport(rt: Rt, o: { room?: RoomRow | null; days?: number; now?: number } = {}) {
  const now = o.now ?? Date.now();
  const all = await pushRows(rt, { since: now - (o.days ?? 365) * DAY });
  const schedule = scheduleOf(rt, o.room ?? null);
  const best = bestMinutes(all, schedule).map((b) => ({ ...b, text: recommendationText(b) }));
  const pushes = o.room ? await pushRows(rt, { roomId: o.room.id }) : [];
  return { pushes, best, schedule: schedule.map((s) => ({ at: s.at, kind: s.kind, ref: s.ref })), minShown: MIN_SHOWN, rooms: new Set(all.map((p) => p.room)).size, note: 'A recommendation only: the automatic push schedule changes only when you edit it.' };
}

// ───────────── Funnel HQ routes ─────────────

/** GET /admin/api/rooms/qa-report: objection to purchase and push timing across rooms. */
export async function qaReportRoute(c: Context<AppEnv>) {
  const rt = runtimeFrom(c);
  const days = Math.min(730, Math.max(7, Number(c.req.query('days')) || 180));
  try {
    const [objections, pushes] = await Promise.all([objectionReport(rt, { days }), pushReport(rt, { days })]);
    return c.json({ ok: true, days, objections, pushes });
  } catch (e) {
    return c.json({ ok: false, error: 'Apply migration 0074 to see objections and push timing.', detail: String(e).slice(0, 120) });
  }
}
/** GET /admin/api/rooms/:id/qa: the same for one room (its pushes and objections), against its own schedule. */
export async function qaRoomRoute(c: Context<AppEnv>) {
  const rt = runtimeFrom(c);
  const room = await getRoom(rt, c.req.param('id') ?? '');
  if (!room) return c.json({ ok: false, error: 'Room not found' }, 404);
  try {
    const [objections, pushes] = await Promise.all([objectionReport(rt, { roomId: room.id }), pushReport(rt, { room })]);
    return c.json({ ok: true, objections, pushes });
  } catch (e) {
    return c.json({ ok: false, error: 'Apply migration 0074 to see objections and push timing.', detail: String(e).slice(0, 120) });
  }
}
