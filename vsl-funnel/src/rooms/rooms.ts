import type { Runtime } from '../app';
import { newId } from '../lib/ids';
import { signToken, verifyToken } from '../lib/crypto';
import { getSecret } from '../lib/secret';
import type { Identity, OfferState, Role, RoomMode } from './state';

/**
 * Rooms in D1 (migration 0052): which room belongs to which live event, challenge day or client meeting,
 * signed tickets and invite links, presence and minutes fed into the tables the live funnels already use, and
 * the bridge to the existing offer (live events: live_webinars; challenge days 4 and 5: challenge_offer_state).
 */

export interface RoomRow {
  id: string; mode: RoomMode; title: string; ref_type: 'live' | 'challenge' | 'lead' | 'none'; ref_id: string | null; lead_id: string | null;
  starts_at: number | null; duration_min: number; status: 'scheduled' | 'live' | 'ended' | 'cancelled'; went_live_at: number | null; ended_at: number | null;
  peak: number; replay_url: string | null; created_by: string | null; created_at: number; updated_at: number;
  /** Webinars: how the audience receives the stage (migration 0054); null follows ROOM_BROADCAST. */
  broadcast?: string | null;
  /** Engagement settings for this room (migration 0055, engage-db.ts): JSON { agenda, board }; and when the summary emails went out. */
  engage?: string | null;
  summary_at?: number | null;
  /** Studio settings (builder B, migration 0057): JSON, see src/rooms/studio.ts StudioSettings. */
  studio?: string | null;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ROOM_ID = /^rm[a-z0-9]{8,40}$/;
export const isRoomId = (v: unknown): v is string => typeof v === 'string' && ROOM_ID.test(v);

export const getRoom = (rt: Pick<Runtime, 'env'>, id: string) => (isRoomId(id) ? rt.env.DB.prepare('SELECT * FROM rooms WHERE id = ?').bind(id).first<RoomRow>() : Promise.resolve(null));
export const roomForRef = (rt: Pick<Runtime, 'env'>, refType: 'live' | 'challenge', refId: string) =>
  rt.env.DB.prepare('SELECT * FROM rooms WHERE ref_type = ? AND ref_id = ?').bind(refType, refId).first<RoomRow>();

export async function createRoom(rt: Pick<Runtime, 'env'>, o: { mode: RoomMode; title: string; refType: RoomRow['ref_type']; refId?: string | null; leadId?: string | null; startsAt?: number | null; durationMin?: number; createdBy?: string | null }, now = Date.now()) {
  const id = newId('rm').toLowerCase();
  await rt.env.DB.prepare('INSERT INTO rooms (id, mode, title, ref_type, ref_id, lead_id, starts_at, duration_min, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, o.mode, o.title.replace(/[<>]/g, '').slice(0, 200) || 'Room', o.refType, o.refId ?? null, o.leadId ?? null, o.startsAt ?? null, Math.round(o.durationMin ?? 60), o.createdBy ?? null, now, now).run();
  return (await getRoom(rt, id))!;
}

/** The room of a live event or challenge day (created on first use, kept in step with the schedule). */
export async function ensureRoomFor(rt: Pick<Runtime, 'env'>, refType: 'live' | 'challenge', refId: string, o: { title: string; startsAt: number; durationMin: number }) {
  const cur = await roomForRef(rt, refType, refId);
  if (cur) {
    if (cur.title !== o.title || cur.starts_at !== o.startsAt || cur.duration_min !== o.durationMin)
      await rt.env.DB.prepare('UPDATE rooms SET title = ?, starts_at = ?, duration_min = ?, updated_at = ? WHERE id = ?').bind(o.title.slice(0, 200), o.startsAt, o.durationMin, Date.now(), cur.id).run();
    return (await getRoom(rt, cur.id))!;
  }
  try {
    return await createRoom(rt, { mode: 'webinar', title: o.title, refType, refId, startsAt: o.startsAt, durationMin: o.durationMin });
  } catch {
    return (await roomForRef(rt, refType, refId))!; // created by a parallel request
  }
}

// ───────────── tickets (one participant, one room, a few hours) and invite links ─────────────

export interface Ticket { r: string; p: string; role: Role; n: string; lead: string | null; reg: string | null; exp: number }
const b64 = (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s: string) => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));

export async function makeTicket(rt: Pick<Runtime, 'env'>, roomId: string, who: Identity, ttlMs = 12 * HOUR, now = Date.now()) {
  const t: Ticket = { r: roomId, p: who.id, role: who.role, n: who.name.slice(0, 60), lead: who.leadId ?? null, reg: who.regId ?? null, exp: now + ttlMs };
  return signToken(await getSecret(rt.env), `rt.${b64(JSON.stringify(t))}`);
}
export async function readTicket(rt: Pick<Runtime, 'env'>, token: unknown, roomId: string, now = Date.now()): Promise<Ticket | null> {
  if (typeof token !== 'string' || token.length > 2000) return null;
  const payload = await verifyToken(await getSecret(rt.env), token);
  if (!payload?.startsWith('rt.')) return null;
  try {
    const t = JSON.parse(unb64(payload.slice(3))) as Ticket;
    return t.r === roomId && t.exp > now && typeof t.p === 'string' && ['host', 'cohost', 'guest', 'attendee'].includes(t.role) ? t : null;
  } catch { return null; }
}
export const ticketIdentity = (t: Ticket): Identity => ({ id: t.p, name: t.n, role: t.role, leadId: t.lead, regId: t.reg });

/** Signed invite links: co-hosts (anyone holding the link joins backstage) and meeting guests (a named lead). */
/** v: the room's co-host link version (rotating it stops older co-host links); n: the name a general admission joiner typed (admission.ts). */
export interface Invite { r: string; role: 'cohost' | 'guest'; lead: string | null; exp: number; v?: number; n?: string }
export async function makeInvite(rt: Pick<Runtime, 'env'>, roomId: string, role: Invite['role'], leadId: string | null, ttlMs = 30 * DAY, now = Date.now(), extra: { v?: number; n?: string } = {}) {
  const inv: Invite = { r: roomId, role, lead: leadId, exp: now + ttlMs, ...(extra.v ? { v: extra.v } : {}), ...(extra.n ? { n: extra.n.slice(0, 60) } : {}) };
  return signToken(await getSecret(rt.env), `ri.${b64(JSON.stringify(inv))}`);
}
export async function readInvite(rt: Pick<Runtime, 'env'>, token: unknown, roomId: string, now = Date.now()): Promise<Invite | null> {
  if (typeof token !== 'string' || token.length > 1000) return null;
  const payload = await verifyToken(await getSecret(rt.env), token);
  if (!payload?.startsWith('ri.')) return null;
  try {
    const i = JSON.parse(unb64(payload.slice(3))) as Invite;
    return i.r === roomId && i.exp > now && (i.role === 'cohost' || i.role === 'guest') ? i : null;
  } catch { return null; }
}
export const inviteUrl = (rt: Pick<Runtime, 'origin'>, roomId: string, token: string) => `${rt.origin}/rooms/${roomId}?i=${encodeURIComponent(token)}`;

/** A stable short id for a person in a room (the attendee's registration id, the lead, or a random guest). */
export const memberId = (kind: 'reg' | 'lead' | 'host' | 'guest', raw: string) => `${kind[0]}${raw.replace(/[^A-Za-z0-9]/g, '').slice(0, 36)}`;

// ───────────── presence and minutes ─────────────

export interface PresenceMember { id: string; role: Role; name: string; leadId?: string | null; regId?: string | null; stage?: boolean }

/**
 * Called by the room on join and once a minute for everyone connected. Writes room_attendance for everyone, and
 * for attendees of a live event or challenge day the same tables the Zoom companion rooms write: webinar_presence
 * (so the "left mid-session" AI calls and the live counts work), joined_at / present_at, attribution minutes
 * (attr_watch) and the attended stage.
 */
export async function feedPresence(rt: Runtime, room: Pick<RoomRow, 'id' | 'ref_type' | 'ref_id' | 'starts_at' | 'duration_min' | 'status'>, members: PresenceMember[], now = Date.now(), o: { live?: boolean; offerOpen?: boolean } = {}) {
  const db = rt.env.DB;
  for (const m of members) {
    await db.prepare(
      `INSERT INTO room_attendance (room_id, who, lead_id, reg_id, name, role, first_at, last_at, minutes, joins, on_stage_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?)
       ON CONFLICT(room_id, who) DO UPDATE SET last_at = excluded.last_at, role = excluded.role, name = excluded.name,
         minutes = room_attendance.minutes + CASE WHEN excluded.last_at - room_attendance.last_at >= 50000 THEN 1 ELSE 0 END,
         on_stage_at = COALESCE(room_attendance.on_stage_at, excluded.on_stage_at)`,
    ).bind(room.id, m.id, m.leadId ?? null, m.regId ?? null, m.name.slice(0, 80), m.role, now, now, m.stage && m.role !== 'host' && m.role !== 'cohost' ? now : null).run();
  }
  const attendees = members.filter((m) => m.regId && m.leadId && (m.role === 'attendee' || m.role === 'guest'));
  if (!attendees.length || !room.ref_id) return;
  const H = await import('../attribution/hooks');
  const S = await import('../attribution/stages');
  if (room.ref_type === 'live') {
    const { getEvent, liveStage, liveSettings, offerWindow } = await import('../live/events');
    const ev = await getEvent(rt, room.ref_id);
    if (!ev) return;
    const stage = liveStage(ev, now, liveSettings(rt).offerHours);
    // Live by the schedule, or because the host pressed Go live in the room.
    const live = stage === 'live' || (o.live === true && stage !== 'closed' && stage !== 'cancelled');
    const offerOpen = offerWindow(ev, now, liveSettings(rt).offerHours).open;
    for (const m of attendees) {
      const kind = stage === 'replay' && !o.live ? 'replay' : 'viewer';
      await db.prepare('INSERT INTO webinar_presence (session_id, who, kind, first_at, seen_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id, who) DO UPDATE SET seen_at = excluded.seen_at, kind = excluded.kind').bind(ev.id, m.regId, kind, now, now).run();
      const reg = await db.prepare('SELECT joined_at, offer_seen_at FROM live_webinar_regs WHERE id = ?').bind(m.regId).first<{ joined_at: number | null; offer_seen_at: number | null }>();
      if (!reg) continue;
      await db.prepare('UPDATE live_webinar_regs SET last_seen_at = ?, joined_at = CASE WHEN ? THEN COALESCE(joined_at, ?) ELSE joined_at END WHERE id = ?').bind(now, live ? 1 : 0, now, m.regId).run();
      if (live) {
        await S.recordMinute(rt, { funnel: 'live', eventRef: ev.id, regId: m.regId!, leadId: m.leadId!, startsAt: Math.min(ev.starts_at, now), now, source: 'room' }).catch(() => null);
        if (!reg.joined_at) await H.onRoomSignal(rt, { kind: 'attended', funnel: 'live', regId: m.regId!, leadId: m.leadId!, at: now, cohortRef: ev.id, detail: 'our room' });
      }
      if ((offerOpen || o.offerOpen) && !reg.offer_seen_at) {
        await db.prepare('UPDATE live_webinar_regs SET offer_seen_at = COALESCE(offer_seen_at, ?) WHERE id = ?').bind(now, m.regId).run();
        await H.onRoomSignal(rt, { kind: 'offer_seen', funnel: 'live', regId: m.regId!, leadId: m.leadId!, at: now, cohortRef: ev.id });
      }
    }
    const n = (await db.prepare("SELECT COUNT(*) AS n FROM webinar_presence WHERE session_id = ? AND kind = 'viewer' AND seen_at > ?").bind(ev.id, now - 90_000).first<{ n: number }>())?.n ?? 0;
    if (n > 0) await db.prepare(`INSERT INTO webinar_live_peaks (session_id, peak_viewers, peak_at, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET peak_at = CASE WHEN excluded.peak_viewers > peak_viewers THEN excluded.peak_at ELSE peak_at END, peak_viewers = MAX(peak_viewers, excluded.peak_viewers), updated_at = excluded.updated_at`).bind(ev.id, n, now, now).run();
    return;
  }
  if (room.ref_type === 'challenge') {
    const { parseEventKey, inLiveWindow } = await import('../challenge/schedule');
    const k = parseEventKey(room.ref_id);
    if (!k) return;
    const d = await db.prepare('SELECT * FROM challenge_days WHERE cohort_id = ? AND day = ?').bind(k.cohortId, k.day).first<{ starts_at: number; duration_min: number }>();
    if (!d) return;
    const live = inLiveWindow(d, now) || o.live === true;
    const touch = (regId: string, col: 'joined_at' | 'present_at') =>
      db.prepare(`INSERT INTO challenge_progress (reg_id, day, ${col}) VALUES (?, ?, ?) ON CONFLICT(reg_id, day) DO UPDATE SET ${col} = COALESCE(challenge_progress.${col}, excluded.${col})`).bind(regId, k.day, now).run();
    for (const m of attendees) {
      await db.prepare("INSERT INTO webinar_presence (session_id, who, kind, first_at, seen_at) VALUES (?, ?, 'viewer', ?, ?) ON CONFLICT(session_id, who) DO UPDATE SET seen_at = excluded.seen_at").bind(room.ref_id, m.regId, now, now).run();
      if (!live) continue;
      const before = await db.prepare('SELECT joined_at FROM challenge_progress WHERE reg_id = ? AND day = ?').bind(m.regId, k.day).first<{ joined_at: number | null }>();
      await touch(m.regId!, 'joined_at');
      const p = await db.prepare('SELECT first_at FROM webinar_presence WHERE session_id = ? AND who = ?').bind(room.ref_id, m.regId).first<{ first_at: number }>();
      if (p && now - Math.max(p.first_at, d.starts_at - 15 * MIN) >= 5 * MIN) await touch(m.regId!, 'present_at');
      await S.recordMinute(rt, { funnel: 'challenge', eventRef: room.ref_id, regId: m.regId!, leadId: m.leadId!, startsAt: Math.min(d.starts_at, now), now, source: 'room' }).catch(() => null);
      if (!before?.joined_at) await H.onRoomSignal(rt, { kind: 'attended', funnel: 'challenge', regId: m.regId!, leadId: m.leadId!, at: now, cohortRef: k.cohortId, detail: `day ${k.day}, our room` });
      if (o.offerOpen) await H.onRoomSignal(rt, { kind: 'offer_seen', funnel: 'challenge', regId: m.regId!, leadId: m.leadId!, at: now, cohortRef: k.cohortId, detail: `day ${k.day}` });
    }
  }
}

// ───────────── the offer, from the existing live funnels ─────────────

/** Where the room's offer stands (read from the live event or the cohort, never kept only in the room). */
export async function roomOffer(rt: Runtime, room: Pick<RoomRow, 'ref_type' | 'ref_id'>, now = Date.now()): Promise<OfferState> {
  const none: OfferState = { available: false, open: false, closesAt: null, label: null };
  if (!room.ref_id) return none;
  const { depositConfig } = await import('../sales/deposit');
  const label = depositConfig(rt).label;
  if (room.ref_type === 'live') {
    const { getEvent, liveSettings, offerWindow } = await import('../live/events');
    const ev = await getEvent(rt, room.ref_id);
    if (!ev) return none;
    const w = offerWindow(ev, now, liveSettings(rt).offerHours);
    return { available: true, open: w.open, closesAt: w.opened ? w.closesAt : null, label };
  }
  if (room.ref_type === 'challenge') {
    const { parseEventKey } = await import('../challenge/schedule');
    const k = parseEventKey(room.ref_id);
    if (!k || (k.day !== 4 && k.day !== 5)) return none;
    const { cohortOffer } = await import('../challenge/offer');
    const s = await cohortOffer(rt, k.cohortId, now);
    return { available: true, open: s.open, closesAt: s.closeAt, label };
  }
  return none;
}

/** The host's Open / Close the offer, through the same code as the host console (deadlines stay real). */
export async function setRoomOffer(rt: Runtime, room: Pick<RoomRow, 'ref_type' | 'ref_id'>, open: boolean, now = Date.now()) {
  if (!room.ref_id) return { ok: false as const, error: 'This room has no offer.' };
  if (room.ref_type === 'live') {
    const { hostAction } = await import('../live/events');
    const r = await hostAction(rt, room.ref_id, { action: open ? 'open_offer' : 'close_offer' }, now);
    return r.ok ? { ok: true as const } : { ok: false as const, error: r.error };
  }
  if (room.ref_type === 'challenge') {
    const { setOffer } = await import('../challenge/offer');
    const r = await setOffer(rt, room.ref_id, open, now);
    return r.ok ? { ok: true as const } : { ok: false as const, error: r.error };
  }
  return { ok: false as const, error: 'This room has no offer.' };
}

/** Go live / End from the room: the rooms row, and for a live event the event's real end (the offer deadline counts from it). */
export async function markRoom(rt: Runtime, roomId: string, what: 'live' | 'ended' | 'peak', o: { peak?: number } = {}, now = Date.now()) {
  const db = rt.env.DB;
  if (what === 'peak') { await db.prepare('UPDATE rooms SET peak = MAX(peak, ?), updated_at = ? WHERE id = ?').bind(o.peak ?? 0, now, roomId).run(); return; }
  if (what === 'live') { await db.prepare("UPDATE rooms SET status = 'live', went_live_at = COALESCE(went_live_at, ?), updated_at = ? WHERE id = ?").bind(now, now, roomId).run(); return; }
  await db.prepare("UPDATE rooms SET status = 'ended', ended_at = COALESCE(ended_at, ?), updated_at = ? WHERE id = ?").bind(now, now, roomId).run();
  const room = await getRoom(rt, roomId);
  if (room?.ref_type === 'live' && room.ref_id) {
    const { hostAction } = await import('../live/events');
    await hostAction(rt, room.ref_id, { action: 'end' }, now).catch(() => null);
  }
}

// ───────────── Funnel HQ ─────────────

export async function listRooms(rt: Runtime, o: { limit?: number } = {}) {
  const { results } = await rt.env.DB.prepare(
    `SELECT r.*, (SELECT COUNT(*) FROM room_attendance a WHERE a.room_id = r.id) AS people,
            (SELECT COALESCE(SUM(a.minutes), 0) FROM room_attendance a WHERE a.room_id = r.id) AS minutes,
            (SELECT COUNT(*) FROM room_recordings k WHERE k.room_id = r.id AND k.status = 'ready') AS recordings,
            l.first_name, l.last_name, l.email
       FROM rooms r LEFT JOIN leads l ON l.id = r.lead_id ORDER BY COALESCE(r.starts_at, r.created_at) DESC LIMIT ?`,
  ).bind(Math.min(200, o.limit ?? 100)).all<RoomRow & { people: number; minutes: number; recordings: number; first_name: string | null; last_name: string | null; email: string | null }>();
  return results.map((r) => ({ ...r, hostUrl: `${rt.origin}/admin/rooms/${r.id}`, guest: r.lead_id ? [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email : null }));
}

export async function roomReport(rt: Runtime, id: string) {
  const room = await getRoom(rt, id);
  if (!room) return null;
  const db = rt.env.DB;
  const [att, recs] = await db.batch([
    db.prepare('SELECT a.*, l.email FROM room_attendance a LEFT JOIN leads l ON l.id = a.lead_id WHERE a.room_id = ? ORDER BY a.first_at LIMIT 2000').bind(id),
    db.prepare('SELECT * FROM room_recordings WHERE room_id = ? ORDER BY started_at DESC').bind(id),
  ]);
  return {
    room: { ...room, hostUrl: `${rt.origin}/admin/rooms/${room.id}` },
    attendance: att.results,
    recordings: (recs.results as { id: string; status: string }[]).map((r) => ({ ...r, url: r.status === 'ready' ? `${rt.origin}/rooms/replay/${r.id}` : null })),
  };
}
