import type { Runtime } from '../app';
import type { ApplyResult, Member, RoomState } from './state';
import type { RoomRow } from './rooms';

/**
 * The waiting room (builder E "lifecycle"), on top of the room's lobby. Pure message handling for state.ts
 * (one dispatch line there) and the page config for renderRoomPage; the browser side is room-lifecycle.js.
 *
 *  - lc_early: an attendee in the room before the scheduled start (inside the 15 minutes the waiting room is
 *    open, on the server's clock, while the host hasn't gone live) earns the 'early' points once.
 *  - lc_from / lc_from_get: "say where you're from". Only people connected to this room (real attendees, never
 *    staff and never made up); one place per person, the latest replaces the earlier one; first name only.
 *  - lc_preq: the host or a co-host brings a question someone sent before the session into the room's Q&A.
 */

const MIN = 60_000;
export const WAITING_ROOM_MS = 15 * MIN;
export interface FromEntry { id: string; name: string; place: string; at: number }
export interface LcRoomState { from: FromEntry[]; preq: string[] }
export const LC_LIMITS = { fromKeep: 400, fromShow: 80, placeMax: 40, fromGapMs: 20_000 };

const ok = (o: Partial<ApplyResult> = {}): ApplyResult => ({ ok: true, out: [], effects: [], changed: false, ...o });
const no = (error: string): ApplyResult => ({ ok: false, error, out: [], effects: [], changed: false });
const lcOf = (st: RoomState & { lc?: LcRoomState }) => (st.lc ??= { from: [], preq: [] });
const staffRole = (m: Pick<Member, 'role'>) => m.role === 'host' || m.role === 'cohost';
/** "Austin, Texas" (letters, spaces, commas, dots, hyphens and apostrophes; no links, no digits runs). */
export function cleanPlace(v: unknown) {
  const s = typeof v === 'string' ? v.normalize('NFC').replace(/[^\p{L}\p{M} ,.'’-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, LC_LIMITS.placeMax) : '';
  return /\p{L}{2}/u.test(s) ? s : '';
}
const firstName = (name: string) => name.split(/\s+/)[0]?.replace(/[^\p{L}'’-]/gu, '').slice(0, 30) || 'An owner';
export const fromList = (st: RoomState & { lc?: LcRoomState }) => lcOf(st).from.slice(-LC_LIMITS.fromShow).map((f) => ({ name: f.name, place: f.place }));
/** Whether "now" is inside the waiting room's early window (before the start, at most 15 minutes before). */
export const inEarlyWindow = (st: Pick<RoomState, 'startsAt' | 'status'>, now: number) => Boolean(st.startsAt && st.status === 'lobby' && now >= st.startsAt - WAITING_ROOM_MS && now < st.startsAt);

/** state.ts apply() hands every lc_* message here. */
export function lcApply(st: RoomState & { lc?: LcRoomState }, me: Member, msg: Record<string, unknown>, now: number): ApplyResult {
  if (st.mode !== 'webinar') return no('not_applicable');
  const staff = staffRole(me);
  switch (msg.t) {
    case 'lc_early': {
      if (staff || me.connected <= 0 || !inEarlyWindow(st, now)) return ok();
      return ok({ effects: [{ type: 'award', awards: [{ memberId: me.id, action: 'early', key: '1' }] }] });
    }
    case 'lc_from_get':
      return ok({ out: [{ to: me.id, msg: { t: 'lc_from', list: fromList(st), n: lcOf(st).from.length } }] });
    case 'lc_from': {
      if (staff) return no('forbidden');
      if (st.status === 'ended') return no('ended');
      if (me.connected <= 0) return no('not_in_room');
      const place = cleanPlace(msg.place);
      if (!place) return no('lc_place');
      const L = lcOf(st);
      const mine = L.from.find((f) => f.id === me.id);
      if (mine && now - mine.at < LC_LIMITS.fromGapMs) return no('lc_wait');
      L.from = L.from.filter((f) => f.id !== me.id);
      L.from.push({ id: me.id, name: firstName(me.name), place, at: now });
      if (L.from.length > LC_LIMITS.fromKeep) L.from.splice(0, L.from.length - LC_LIMITS.fromKeep);
      // changed: false (no full state broadcast for this); the Durable Object saves on lc_from.
      return ok({ out: [{ to: 'all', msg: { t: 'lc_from', list: fromList(st), n: L.from.length } }] });
    }
    case 'lc_preq': {
      if (!staff) return no('forbidden');
      if (st.status === 'ended') return no('ended');
      const text = typeof msg.text === 'string' ? msg.text.replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) : '';
      const key = typeof msg.key === 'string' ? msg.key.slice(0, 40) : '';
      if (text.length < 3 || !key) return no('empty');
      const L = lcOf(st);
      if (L.preq.includes(key)) return ok();
      L.preq.push(key);
      const name = `${firstName(typeof msg.name === 'string' ? msg.name : '')} (asked before the session)`;
      st.qa.push({ id: ++st.qaSeq, by: `pre:${key}`, name, text, at: now, votes: [], answered: false });
      return ok({ changed: true });
    }
  }
  return no('bad_message');
}
/** For the Durable Object: messages after which it saves without a full broadcast. */
export const lcSaves = (t: unknown) => t === 'lc_from';

/** renderRoomPage's config block for the waiting room (webinars only). */
export async function lifecycleRoomCfg(rt: Runtime, room: Pick<RoomRow, 'id' | 'mode' | 'ref_type' | 'ref_id' | 'starts_at'>, who: { role: string }) {
  if (room.mode !== 'webinar') return null;
  const { LC_ROOM_COPY, parseSlides } = await import('../live/lifecycle');
  const { engageConfig } = await import('./engage-db');
  let video: string | null = null, slides = parseSlides(null), preq: { id: string; name: string; text: string }[] = [];
  if (room.ref_type === 'live' && room.ref_id) {
    const L = await import('../live/lifecycle-db');
    const lc = await L.lcEvent(rt, room.ref_id).catch(() => null);
    // The room's content policy allows media from this site only, so the loop plays a same-site video (or the slides).
    if (lc?.video_url?.startsWith('/')) video = lc.video_url;
    slides = parseSlides(lc?.slides ?? null);
    if (who.role === 'host' || who.role === 'cohost') preq = (await L.preQuestions(rt, room.ref_id).catch(() => [])).map((q) => ({ id: q.id, name: q.name, text: q.text }));
  }
  const early = engageConfig(rt).rules.early?.points ?? 0;
  const copy = { ...LC_ROOM_COPY, earlyNote: early ? LC_ROOM_COPY.earlyNote(early) : '', fromCount: LC_ROOM_COPY.fromCount(1), fromCountMany: LC_ROOM_COPY.fromCount(7).replace('7', '{n}'), preqOpen: LC_ROOM_COPY.preqOpen(7).replace('7', '{n}') };
  return { waitingMs: WAITING_ROOM_MS, startsAt: room.starts_at, video, slides, preq, earlyPoints: early, copy };
}
