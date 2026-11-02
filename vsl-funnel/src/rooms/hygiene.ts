import type { Runtime } from '../app';
import { type RoomState, isStaff } from './state';

/**
 * Room Durable Object hygiene (reliability, overnight loop): the room's state stays under the storage value
 * limit however big the audience, a crashed alarm can't stop the room's minute loop, and an ended room's
 * storage is cleared after ROOM_DO_KEEP_DAYS. Everything Funnel HQ reports on lives in D1 and is never touched.
 */

const DAY = 86_400_000;
/** The whole RoomState is one storage value (SQLite-backed objects allow 2 MB); trimming starts well below. */
export const STATE_SOFT_BYTES = 1_200_000;
/** Members kept in the state: everyone connected, plus the most recently seen others up to this many. */
export const MEMBER_CAP = 2500;
/** Per-person engagement maps (points, unlocks, minutes) keep at most this many people not in the room. */
export const ENG_CAP = 4000;

export const keepDays = (s: Record<string, string | undefined>) => {
  const n = Math.round(Number(s.ROOM_DO_KEEP_DAYS));
  return Number.isFinite(n) && n > 0 ? Math.max(7, Math.min(365, n)) : 30;
};

const size = (st: RoomState) => JSON.stringify(st).length;

/**
 * Keeps the state bounded. Disconnected people beyond MEMBER_CAP go first (oldest last-seen first; never staff,
 * anyone on stage or with a raised hand); per-person engagement maps drop people who left, oldest first, beyond
 * ENG_CAP (the database keeps their points, unlocks and minutes); past STATE_SOFT_BYTES the chat and answered
 * questions shrink too. Returns what was trimmed.
 */
export function boundRoomState(st: RoomState, caps: { members?: number; eng?: number; bytes?: number } = {}) {
  const out = { members: 0, eng: 0, chat: 0 };
  const memberCap = caps.members ?? MEMBER_CAP;
  const all = Object.values(st.members);
  if (all.length > memberCap) {
    const gone = all.filter((m) => m.connected === 0 && !isStaff(m) && !m.stage && m.hand == null).sort((a, b) => a.lastAt - b.lastAt);
    for (const m of gone.slice(0, all.length - memberCap)) { delete st.members[m.id]; out.members++; }
  }
  const e = st.eng;
  if (e) {
    const engCap = caps.eng ?? ENG_CAP;
    for (const map of [e.pts, e.unlocks, e.mins] as Record<string, unknown>[]) {
      const absent = Object.keys(map).filter((id) => !st.members[id]);
      if (absent.length <= engCap) continue;
      for (const id of absent.slice(0, absent.length - engCap)) { delete map[id]; out.eng++; }
    }
    if (e.optIn.length > engCap) { const keep = e.optIn.filter((id) => st.members[id]); out.eng += e.optIn.length - keep.length; e.optIn = keep; }
  }
  // Still too big (a huge audience all connected and voting): keep the latest chat lines and the open questions.
  // The chat and questions are in the room's timeline in the database (room_intel_events) either way.
  if (size(st) > (caps.bytes ?? STATE_SOFT_BYTES)) {
    out.chat = Math.max(0, st.chat.msgs.length - 50);
    st.chat.msgs = st.chat.msgs.slice(-50);
    st.qa = st.qa.filter((q) => !q.answered).slice(-60);
  }
  return out;
}

/** When an ended room's storage may be cleared (null = not ended, or someone is still connected). */
export function cleanupAt(st: Pick<RoomState, 'status' | 'endedAt' | 'members'>, keep: number, connected: number) {
  if (st.status !== 'ended' || connected > 0) return null;
  const lastSeen = Math.max(st.endedAt ?? 0, ...Object.values(st.members).map((m) => m.lastAt ?? 0));
  return lastSeen + keep * DAY;
}

/**
 * Cron (once a day): ended or cancelled rooms past the keep period whose Durable Object hasn't been cleared yet
 * (rooms that ended before the object scheduled its own clean-up) get a /gc call. At most 20 a day.
 */
export async function sweepRoomStorage(rt: Runtime, now = Date.now()) {
  const ns = rt.env.ROOMS;
  if (!ns) return null;
  const db = rt.env.DB;
  const claim = await db.prepare("INSERT INTO kv_state (key, value) VALUES ('rooms:gc', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE kv_state.value != excluded.value")
    .bind(new Date(now).toISOString().slice(0, 10)).run();
  if (!(claim.meta?.changes ?? 0)) return null; // already ran today
  const cutoff = now - keepDays(rt.settings as unknown as Record<string, string | undefined>) * DAY;
  const { results } = await db.prepare(
    `SELECT r.id FROM rooms r WHERE r.status IN ('ended', 'cancelled') AND COALESCE(r.ended_at, r.updated_at) < ?
       AND NOT EXISTS (SELECT 1 FROM room_do_gc g WHERE g.room_id = r.id) ORDER BY COALESCE(r.ended_at, r.updated_at) LIMIT 20`,
  ).bind(cutoff).all<{ id: string }>();
  let cleared = 0;
  for (const r of results) {
    const res = await ns.get(ns.idFromName(r.id)).fetch(new Request('https://room/gc', { method: 'POST', headers: { 'x-room-gc': '1' } })).catch(() => null);
    const body = (await res?.json().catch(() => null)) as { cleared?: boolean; reason?: string } | null;
    if (body?.cleared || body?.reason === 'empty') {
      await db.prepare('INSERT INTO room_do_gc (room_id, cleaned_at, detail) VALUES (?, ?, ?) ON CONFLICT(room_id) DO NOTHING').bind(r.id, now, body.reason ?? 'swept').run();
      cleared++;
    }
  }
  return { checked: results.length, cleared };
}
