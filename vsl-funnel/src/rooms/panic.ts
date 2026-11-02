import type { Context, Hono } from 'hono';
import type { AppEnv, Runtime } from '../app';
import { newId } from '../lib/ids';
import { type RoomRow, type Ticket, getRoom, inviteUrl, isRoomId, makeInvite, makeTicket, readInvite, readTicket, ticketIdentity } from './rooms';
import { type ChatMsg, type Identity, type Member, type OfferState, type Poll, type Push, type Question, type RoomState, type AutoPushDone, newEngage } from './state';

/**
 * The host's panic button, for a live room that is failing (SFU trouble, the host's media broken, a Durable Object
 * in a bad state). Two targets:
 *
 *  - a fresh room: a new rooms row with the same title, mode, event link and settings (studio, engagement and the
 *    automatic push schedule, admission, broadcast). The event link (ref) moves to the new room in one batch, so
 *    every existing link (the attendee's /live/room/:token, a challenge day's join link, the host console) opens
 *    the new room from then on. The room's essentials are copied: the offer (read from the event, never kept in
 *    the room), the pinned message and recent chat, open cards with their price holds, the chapter, the live
 *    bonus, unlocks, Deal Plans, purchase-announcement consent. Everyone connected is told where to go: attendees
 *    and co-hosts get a fresh signed pass for the new room with the same identity (role, lead, registration and,
 *    for a general admission joiner, the same member id and name); the host goes to /admin/rooms/<new>. The old
 *    room is marked moved (status ended, its summary emails claimed so nobody is emailed twice); late arrivals on
 *    any of its links are redirected along the chain.
 *  - the Zoom fallback: when the event has a join_url, everyone gets a card with the Zoom link; the room stays as
 *    the chat and offer hub.
 *
 * Safety: the host on a signed-in admin session only (co-hosts only when the host switched that on for the room;
 * being a producer grants nothing extra); one action per two minutes per chain; payments are never touched (the
 * offer and purchases live on the event and the registration, and copied cards keep their ids and holds); every
 * action, done or refused, is logged in room_moves.
 */

export const PANIC_GAP_MS = 2 * 60_000;
const PASS_TTL_MS = 12 * 3600_000;

export const PANIC_COPY = {
  tab: 'Rescue',
  heading: 'When the room is failing',
  intro: 'Use this when the stage, your media or the room itself stops working. People keep their chat, their offer and their place.',
  moveTitle: 'Move everyone to a fresh room',
  moveBody: 'A new room opens with the same title, settings, offer, pinned message, open cards, chapter and live bonus. Everyone connected moves there on their own with a short note, and late arrivals land there too.',
  moveButton: 'Move everyone',
  zoomTitle: 'Send everyone to Zoom',
  zoomBody: 'Everyone gets a card with this event’s Zoom link. This room stays open for chat and the offer.',
  zoomButton: 'Show the Zoom card',
  zoomOff: 'Hide the Zoom card',
  noZoom: 'This event has no Zoom link. Add one in Funnel HQ, Live events, to use this.',
  confirmMove: 'Move everyone now? This room closes and the session continues in the new one.',
  confirmZoom: 'Show everyone the Zoom link now?',
  confirm: 'Yes, move now',
  confirmZoomYes: 'Yes, show it',
  cancel: 'Cancel',
  cohostLabel: 'Let co-hosts use this',
  working: 'Working on it',
  hostOnly: 'Only the host can use this.',
  movedNotice: 'We moved the session to a fresh room to keep it running well. Taking you there now.',
  movedHost: 'The new room is ready. Opening it now.',
  movedHostRec: 'Your recording is still running here. Stop it, then open the new room.',
  openNew: 'Open the new room',
  zoomCardHeading: 'The session continues on Zoom',
  zoomCardBody: 'Our video had trouble. Join on Zoom to keep watching. Chat and the offer stay open here.',
  zoomJoin: 'Join on Zoom',
  zoomShown: 'Everyone can see the Zoom card.',
  movedFrom: 'This session moved here from an earlier room.',
  errors: {
    forbidden: 'Only the host can use this.',
    too_soon: 'One rescue every two minutes. Try again in {a} seconds.',
    already_moved: 'This room has already moved.',
    ended: 'This room has ended.',
    no_zoom: 'This event has no Zoom link.',
    confirm: 'Confirm first.',
    failed: 'The move didn’t go through. Try again.',
  } as Record<string, string>,
};

// ───────────── settings and permission ─────────────

export interface PanicSettings { cohost: boolean }
export function panicSettings(room: Pick<RoomRow, 'panic'>): PanicSettings {
  try {
    const o = JSON.parse(room.panic ?? '{}') as Record<string, unknown>;
    return { cohost: o?.cohost === true };
  } catch { return { cohost: false }; }
}

export type PanicTarget = 'room' | 'zoom' | 'zoom_off' | 'cohost';
export const parseTarget = (v: unknown): PanicTarget | null => (v === 'room' || v === 'zoom' || v === 'zoom_off' || v === 'cohost' ? v : null);

/**
 * Who may press it: the host on a signed-in admin session; a co-host only when the host allowed co-hosts for this
 * room (a producer is a co-host: being one grants nothing extra). The co-host switch itself is the host's alone.
 */
export function mayPanic(o: { role: string; admin: boolean; cohostAllowed: boolean; target: PanicTarget }): boolean {
  if (o.role === 'host') return o.admin;
  if (o.target === 'cohost') return false;
  return o.role === 'cohost' && o.cohostAllowed;
}

// ───────────── the chain ─────────────

type ChainRow = Pick<RoomRow, 'id' | 'title' | 'status' | 'starts_at' | 'went_live_at' | 'ended_at' | 'created_at'> & { moved_to: string | null; moved_from: string | null; moved_at: number | null };
const CHAIN_MAX = 20;

/** The first room of the chain this room belongs to. */
export async function rootOf(rt: Pick<Runtime, 'env'>, id: string) {
  let cur = id;
  for (let i = 0; i < CHAIN_MAX; i++) {
    const r = await rt.env.DB.prepare('SELECT moved_from FROM rooms WHERE id = ?').bind(cur).first<{ moved_from: string | null }>();
    if (!r?.moved_from) return cur;
    cur = r.moved_from;
  }
  return cur;
}

/** The room late arrivals should land in: follow moved_to to its end. */
export async function latestOf(rt: Pick<Runtime, 'env'>, room: RoomRow): Promise<RoomRow> {
  let cur = room;
  for (let i = 0; i < CHAIN_MAX && cur.moved_to; i++) {
    const next = await getRoom(rt, cur.moved_to);
    if (!next) break;
    cur = next;
  }
  return cur;
}

/** Every room of the chain, first to last, with the people and minutes of each and links for Funnel HQ. */
export async function roomChain(rt: Pick<Runtime, 'env' | 'origin'>, id: string) {
  if (!isRoomId(id)) return [];
  const root = await rootOf(rt, id);
  const out: (ChainRow & { people: number; minutes: number; hostUrl: string })[] = [];
  let cur: string | null = root;
  for (let i = 0; i < CHAIN_MAX && cur; i++) {
    const r: (ChainRow & { people: number; minutes: number }) | null = await rt.env.DB.prepare(
      `SELECT r.id, r.title, r.status, r.starts_at, r.went_live_at, r.ended_at, r.created_at, r.moved_to, r.moved_from, r.moved_at,
              (SELECT COUNT(*) FROM room_attendance a WHERE a.room_id = r.id) AS people,
              (SELECT COALESCE(SUM(a.minutes), 0) FROM room_attendance a WHERE a.room_id = r.id) AS minutes
         FROM rooms r WHERE r.id = ?`,
    ).bind(cur).first();
    if (!r) break;
    out.push({ ...r, hostUrl: `${rt.origin}/admin/rooms/${r.id}` });
    cur = r.moved_to;
  }
  return out;
}

/** Attendance across the whole chain, one row per person (minutes added up, first and last seen across rooms). */
export async function chainAttendance(rt: Pick<Runtime, 'env'>, ids: string[]) {
  if (!ids.length) return [];
  const marks = ids.map(() => '?').join(', ');
  const { results } = await rt.env.DB.prepare(
    `SELECT who, MAX(name) AS name, MAX(role) AS role, MAX(lead_id) AS lead_id, MAX(reg_id) AS reg_id, MIN(first_at) AS first_at, MAX(last_at) AS last_at,
            SUM(minutes) AS minutes, SUM(joins) AS joins, COUNT(DISTINCT room_id) AS rooms
       FROM room_attendance WHERE room_id IN (${marks}) GROUP BY who ORDER BY first_at LIMIT 3000`,
  ).bind(...ids).all<{ who: string; name: string; role: string; lead_id: string | null; reg_id: string | null; first_at: number; last_at: number; minutes: number; joins: number; rooms: number }>();
  return results;
}

/** The panic log of a chain (newest first). */
export async function chainMoves(rt: Pick<Runtime, 'env'>, root: string) {
  const { results } = await rt.env.DB.prepare('SELECT * FROM room_moves WHERE root_room = ? ORDER BY at DESC LIMIT 50').bind(root).all();
  return results;
}

// ───────────── the log and the rate limit ─────────────

export async function logMove(rt: Pick<Runtime, 'env'>, o: { root: string; from: string; to?: string | null; target: PanicTarget; ok: boolean; error?: string | null; ref_type?: string | null; ref_id?: string | null; by?: Identity | null; told?: number; detail?: string | null }, now = Date.now()) {
  await rt.env.DB.prepare('INSERT INTO room_moves (id, root_room, from_room, to_room, target, ok, error, ref_type, ref_id, by_who, by_role, told, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(newId('mv').toLowerCase(), o.root, o.from, o.to ?? null, o.target, o.ok ? 1 : 0, o.error ?? null, o.ref_type ?? null, o.ref_id ?? null, o.by?.id ?? null, o.by?.role ?? null, o.told ?? 0, o.detail ? o.detail.slice(0, 500) : null, now).run();
  console.log('room panic', JSON.stringify({ target: o.target, ok: o.ok, error: o.error ?? null, from: o.from, to: o.to ?? null, by: o.by?.role ?? null, told: o.told ?? 0 }));
}

/** Milliseconds until this chain may act again (0 = now). Room moves and the Zoom card count; the switch and hiding the card don't. */
export async function waitLeft(rt: Pick<Runtime, 'env'>, root: string, now = Date.now()) {
  const r = await rt.env.DB.prepare("SELECT MAX(at) AS at FROM room_moves WHERE root_room = ? AND ok = 1 AND target IN ('room', 'zoom')").bind(root).first<{ at: number | null }>();
  return r?.at ? Math.max(0, r.at + PANIC_GAP_MS - now) : 0;
}

// ───────────── the Zoom fallback ─────────────

/** The event's Zoom (or other) link: a live event's join_url, or that challenge day's. */
export async function zoomUrlFor(rt: Pick<Runtime, 'env'>, room: Pick<RoomRow, 'ref_type' | 'ref_id'>) {
  if (!room.ref_id) return null;
  let url: string | null | undefined = null;
  if (room.ref_type === 'live') url = (await rt.env.DB.prepare('SELECT join_url FROM live_webinars WHERE id = ?').bind(room.ref_id).first<{ join_url: string | null }>())?.join_url;
  if (room.ref_type === 'challenge') {
    const m = /^challenge:([^:]+):(\d)$/.exec(room.ref_id);
    if (m) url = (await rt.env.DB.prepare('SELECT join_url FROM challenge_days WHERE cohort_id = ? AND day = ?').bind(m[1], Number(m[2])).first<{ join_url: string | null }>().catch(() => null))?.join_url;
  }
  return typeof url === 'string' && /^https:\/\//.test(url) ? url : null;
}

// ───────────── the move (D1) ─────────────

const ROOM_COLS = ['mode', 'title', 'lead_id', 'starts_at', 'duration_min', 'status', 'went_live_at', 'broadcast', 'engage', 'studio', 'panic'] as const;

/**
 * Makes the new room and moves the event link to it, in one batch: the new row (only while the old one hasn't
 * moved), the old row marked moved (its summary emails claimed, its ref released), then the ref on the new row.
 * A second press racing this one finds the old room already moved and makes nothing.
 */
export async function moveRoom(rt: Pick<Runtime, 'env'>, old: RoomRow, now = Date.now()): Promise<{ ok: true; to: RoomRow } | { ok: false; error: string }> {
  if (old.moved_to) return { ok: false, error: 'already_moved' };
  if (old.status === 'ended' || old.status === 'cancelled') return { ok: false, error: 'ended' };
  const db = rt.env.DB;
  const id = newId('rm').toLowerCase();
  const cols = ROOM_COLS.join(', ');
  await db.batch([
    db.prepare(`INSERT INTO rooms (id, ref_type, ref_id, peak, created_by, created_at, updated_at, moved_from, ${cols})
      SELECT ?, 'none', NULL, 0, 'panic', ?, ?, id, ${cols} FROM rooms WHERE id = ? AND moved_to IS NULL AND status NOT IN ('ended', 'cancelled')`).bind(id, now, now, old.id),
    db.prepare(`UPDATE rooms SET moved_to = ?, moved_at = ?, ref_type = CASE WHEN ref_type IN ('live', 'challenge') THEN 'none' ELSE ref_type END,
        status = 'ended', ended_at = COALESCE(ended_at, ?), summary_at = COALESCE(summary_at, ?), updated_at = ?
      WHERE id = ? AND moved_to IS NULL AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND moved_from = ?)`).bind(id, now, now, now, now, old.id, id, old.id),
    db.prepare('UPDATE rooms SET ref_type = ?, ref_id = ?, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND moved_to = ?)')
      .bind(old.ref_type, old.ref_id, now, id, old.id, id),
  ]);
  const to = await getRoom(rt, id);
  const fresh = await getRoom(rt, old.id);
  if (!to || fresh?.moved_to !== id) return { ok: false, error: fresh?.moved_to ? 'already_moved' : 'failed' };
  await copyRoomData(rt, old.id, id).catch((e) => console.error('room panic copy', String(e).slice(0, 300)));
  return { ok: true, to };
}

/**
 * The room's own rows the new room needs, copied under its id (the old rows stay, so links already sent keep
 * working): open cards (same ids and price holds, so a checkout from a card is the same checkout), the live bonus,
 * unlocked files, Deal Plans, purchase-announcement consent and what was already announced, checkouts started
 * (each gets one nudge, not two), and the announcement switch.
 */
export async function copyRoomData(rt: Pick<Runtime, 'env'>, from: string, to: string) {
  const db = rt.env.DB;
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO room_pushes (room_id, id, kind, ref, targets, target_count, created_by, created_at, closed_at, hold_until)
      SELECT ?, id, kind, ref, targets, target_count, created_by, created_at, closed_at, hold_until FROM room_pushes WHERE room_id = ? AND closed_at IS NULL`).bind(to, from),
    db.prepare(`INSERT OR IGNORE INTO room_live_bonus (room_id, text, asset, until, on_at, withdrawn_at, withdrawn_reason, updated_by, updated_at)
      SELECT ?, text, asset, until, on_at, withdrawn_at, withdrawn_reason, updated_by, updated_at FROM room_live_bonus WHERE room_id = ?`).bind(to, from),
    db.prepare(`INSERT OR IGNORE INTO room_unlocks (room_id, who, asset, source, lead_id, at, opened_at)
      SELECT ?, who, asset, source, lead_id, at, opened_at FROM room_unlocks WHERE room_id = ?`).bind(to, from),
    db.prepare(`INSERT OR IGNORE INTO room_plans (room_id, who, lead_id, reg_id, data, steps, created_at, updated_at)
      SELECT ?, who, lead_id, reg_id, data, steps, created_at, updated_at FROM room_plans WHERE room_id = ?`).bind(to, from),
    db.prepare(`INSERT OR IGNORE INTO room_proof_consent (room_id, who, lead_id, first_name, city, show_city, consent_at, withdrawn_at)
      SELECT ?, who, lead_id, first_name, city, show_city, consent_at, withdrawn_at FROM room_proof_consent WHERE room_id = ?`).bind(to, from),
    db.prepare(`INSERT OR IGNORE INTO room_proof_events (room_id, lead_id, kind, text, ref, at)
      SELECT ?, lead_id, kind, text, ref, at FROM room_proof_events WHERE room_id = ?`).bind(to, from),
    db.prepare(`INSERT OR IGNORE INTO room_checkouts (room_id, who, kind, lead_id, started_at, nudged_at)
      SELECT ?, who, kind, lead_id, started_at, nudged_at FROM room_checkouts WHERE room_id = ?`).bind(to, from),
    db.prepare(`INSERT OR IGNORE INTO room_audience (room_id, proof_on, updated_at)
      SELECT ?, proof_on, updated_at FROM room_audience WHERE room_id = ?`).bind(to, from),
  ]);
}

// ───────────── the Durable Object's state: what moves with the session ─────────────

export interface PanicSnapshot {
  v: 1; from: string; at: number;
  status: RoomState['status']; wentLiveAt: number | null; layout: RoomState['layout'];
  chat: { locked: boolean; slowSec: number; pinned: number | null; msgs: ChatMsg[]; seq: number };
  qa: Question[]; qaSeq: number; polls: Poll[]; pollSeq: number;
  timer: RoomState['timer']; offer: OfferState;
  eng: { chapter: number; board: boolean; optIn: string[]; pts: Record<string, number>; unlocks: Record<string, string[]>; mins: Record<string, number>; pushes: Push[]; pushSeq: number; quizSeq: number; autoDone: AutoPushDone[] } | null;
}

const CHAT_CARRY = 100;
const QA_CARRY = 150;

/** What the old room hands the new one (only what the session needs; members reconnect on their own). */
export function snapshotOf(st: RoomState, now = Date.now()): PanicSnapshot {
  const e = st.eng;
  const msgs = st.chat.msgs.slice(-CHAT_CARRY);
  // The pinned message travels even when it is older than the recent chat.
  const pin = st.chat.pinned != null ? st.chat.msgs.find((m) => m.id === st.chat.pinned) : null;
  if (pin && !msgs.includes(pin)) msgs.unshift(pin);
  return {
    v: 1, from: st.id, at: now, status: st.status, wentLiveAt: st.wentLiveAt, layout: st.layout,
    chat: { locked: st.chat.locked, slowSec: st.chat.slowSec, pinned: st.chat.pinned, msgs: msgs.map((m) => ({ ...m })), seq: st.chat.seq },
    qa: st.qa.slice(-QA_CARRY).map((q) => ({ ...q, votes: [...q.votes] })), qaSeq: st.qaSeq,
    polls: st.polls.slice(-10).map((p) => ({ ...p, options: [...p.options], votes: { ...p.votes } })), pollSeq: st.pollSeq,
    timer: st.timer ? { ...st.timer } : null, offer: { ...st.offer },
    eng: e ? {
      chapter: e.chapter, board: e.board, optIn: [...e.optIn], pts: { ...e.pts }, unlocks: JSON.parse(JSON.stringify(e.unlocks)), mins: { ...e.mins },
      pushes: e.pushes.filter((p) => p.open).map((p) => ({ ...p, to: p.to ? [...p.to] : null })), pushSeq: e.pushSeq, quizSeq: e.quizSeq, autoDone: (e.autoDone ?? []).map((d) => ({ ...d })),
    } : null,
  };
}

/** Whether a body is a snapshot this code made (the seed endpoint only takes the Worker's own, but stay strict). */
export function isSnapshot(v: unknown): v is PanicSnapshot {
  const s = v as PanicSnapshot;
  return Boolean(s && s.v === 1 && typeof s.from === 'string' && s.chat && Array.isArray(s.chat.msgs) && Array.isArray(s.qa) && Array.isArray(s.polls));
}

/**
 * Seeds a fresh room's state from the old room's snapshot, once (a repeat of the same snapshot changes nothing).
 * The agenda and the push schedule come from the room's own settings (copied with the row); what already happened
 * in this session (the chapter, cards fired or skipped, points) comes from the snapshot, so nothing fires twice.
 */
export function seedState(st: RoomState, snap: PanicSnapshot, now = Date.now()) {
  if (st.panic?.from === snap.from) return false;
  st.panic = { from: snap.from, at: now };
  if (snap.status === 'live' && st.mode === 'webinar' && st.status !== 'ended') { st.status = 'live'; st.wentLiveAt = snap.wentLiveAt ?? st.wentLiveAt ?? now; }
  st.layout = snap.layout;
  const have = new Set(st.chat.msgs.map((m) => m.id));
  st.chat.msgs = [...snap.chat.msgs.filter((m) => !have.has(m.id)), ...st.chat.msgs].sort((a, b) => a.id - b.id);
  st.chat.seq = Math.max(st.chat.seq, snap.chat.seq);
  st.chat.locked = snap.chat.locked; st.chat.slowSec = snap.chat.slowSec;
  st.chat.pinned = snap.chat.pinned != null && st.chat.msgs.some((m) => m.id === snap.chat.pinned) ? snap.chat.pinned : st.chat.pinned;
  const haveQ = new Set(st.qa.map((q) => q.id));
  st.qa = [...snap.qa.filter((q) => !haveQ.has(q.id)), ...st.qa].sort((a, b) => a.id - b.id);
  st.qaSeq = Math.max(st.qaSeq, snap.qaSeq);
  const haveP = new Set(st.polls.map((p) => p.id));
  st.polls = [...snap.polls.filter((p) => !haveP.has(p.id)), ...st.polls].sort((a, b) => a.id - b.id);
  st.pollSeq = Math.max(st.pollSeq, snap.pollSeq);
  if (snap.timer && snap.timer.endsAt > now) st.timer = snap.timer;
  // The offer is read from the event on the next minute anyway; this keeps it on screen through the move.
  if (st.offer.available) st.offer = { ...snap.offer, available: true };
  if (snap.eng) {
    const e = (st.eng ??= newEngage());
    if (snap.eng.chapter >= 0) e.chapter = Math.min(snap.eng.chapter, Math.max(0, e.agenda.length - 1));
    e.board = snap.eng.board;
    e.optIn = [...new Set([...e.optIn, ...snap.eng.optIn])];
    for (const [k, v] of Object.entries(snap.eng.pts)) e.pts[k] = Math.max(e.pts[k] ?? 0, v);
    for (const [k, v] of Object.entries(snap.eng.unlocks)) e.unlocks[k] = [...new Set([...(e.unlocks[k] ?? []), ...v])];
    for (const [k, v] of Object.entries(snap.eng.mins)) e.mins[k] = Math.max(e.mins[k] ?? 0, v);
    const haveU = new Set(e.pushes.map((p) => p.id));
    e.pushes = [...snap.eng.pushes.filter((p) => !haveU.has(p.id)), ...e.pushes].sort((a, b) => a.id - b.id);
    e.pushSeq = Math.max(e.pushSeq, snap.eng.pushSeq);
    e.quizSeq = Math.max(e.quizSeq, snap.eng.quizSeq);
    const done = new Map((e.autoDone ?? []).map((d) => [d.id, d]));
    for (const d of snap.eng.autoDone) if (!done.has(d.id)) done.set(d.id, d);
    e.autoDone = [...done.values()];
  }
  return true;
}

// ───────────── passes: the same person, in the new room ─────────────

/** Where one connected person goes: the host to the admin room; everyone else with a fresh signed pass. */
export async function moveUrlFor(rt: Pick<Runtime, 'env' | 'origin'>, to: string, who: Identity, now = Date.now()) {
  if (who.role === 'host') return `${rt.origin}/admin/rooms/${to}`;
  const pass = await makeTicket(rt, to, { id: who.id, name: who.name, role: who.role, leadId: who.leadId ?? null, regId: who.regId ?? null }, PASS_TTL_MS, now);
  return `${rt.origin}/rooms/${to}?mv=${encodeURIComponent(pass)}`;
}

/** The message a moved person gets. */
export const movedMessage = (url: string, who: Pick<Identity, 'role'>, to: string) => ({ t: 'panic_moved', url, to, host: who.role === 'host', text: who.role === 'host' ? PANIC_COPY.movedHost : PANIC_COPY.movedNotice });

/** Reads a pass for this room: the identity it carries (never the host's: the host comes in through the admin page). */
export async function readPass(rt: Pick<Runtime, 'env'>, pass: unknown, roomId: string, now = Date.now()): Promise<Ticket | null> {
  const t = await readTicket(rt, pass, roomId, now);
  return t && t.role !== 'host' ? t : null;
}

// ───────────── the Durable Object side ─────────────

export interface PanicDoHost {
  st(): RoomState | null;
  deliver(to: string, msg: Record<string, unknown>): void;
  runtime(): Promise<Runtime>;
  storage: DurableObjectStorage;
  commit(now: number): Promise<void>;
}
interface Saved { movedTo?: string | null; movedAt?: number | null; zoom?: { url: string; at: number } | null }

/** The room's part of a rescue: hand over a snapshot, take one, tell everyone connected, show or hide the Zoom card. */
export class PanicHub {
  private saved: Saved | null = null;
  constructor(private host: PanicDoHost) {}

  private async load() { return (this.saved ??= (await this.host.storage.get<Saved>('panic')) ?? {}); }
  private async persist() { if (this.saved) await this.host.storage.put('panic', this.saved); }

  /** Requests only the Worker sends (the object is reachable only through it); null = not ours. */
  async fetch(path: string, req: Request, now: number): Promise<Response | null> {
    if (!path.startsWith('/panic/')) return null;
    if (req.headers.get('x-room-panic') !== '1') return new Response('forbidden', { status: 403 });
    const st = this.host.st();
    if (!st) return Response.json({ ok: false }, { status: 409 });
    if (path === '/panic/snapshot') return Response.json(snapshotOf(st, now));
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (path === '/panic/seed') {
      if (!isSnapshot(body)) return Response.json({ ok: false, error: 'bad snapshot' }, { status: 400 });
      const changed = seedState(st, body, now);
      if (changed) await this.host.commit(now);
      return Response.json({ ok: true, changed });
    }
    if (path === '/panic/moved') {
      const to = String(body.to ?? '');
      if (!isRoomId(to)) return Response.json({ ok: false }, { status: 400 });
      const s = await this.load();
      s.movedTo = to; s.movedAt = now;
      await this.persist();
      const rt = await this.host.runtime();
      let told = 0;
      for (const m of Object.values(st.members)) {
        if (m.connected <= 0) continue;
        const url = await moveUrlFor(rt, to, m, now);
        this.host.deliver(m.id, movedMessage(url, m, to));
        told++;
      }
      return Response.json({ ok: true, told });
    }
    if (path === '/panic/zoom') {
      const url = typeof body.url === 'string' && /^https:\/\//.test(body.url) ? body.url : null;
      const s = await this.load();
      s.zoom = url ? { url, at: now } : null;
      await this.persist();
      this.host.deliver('all', { t: 'panic_zoom', url, text: url ? PANIC_COPY.zoomCardBody : null });
      return Response.json({ ok: true, told: Object.values(st.members).filter((m) => m.connected > 0).length });
    }
    return new Response('not found', { status: 404 });
  }

  /** Someone joined: the Zoom card while it is up. */
  async onJoin(m: Member) {
    const s = await this.load();
    if (s.zoom) this.host.deliver(m.id, { t: 'panic_zoom', url: s.zoom.url, text: PANIC_COPY.zoomCardBody });
  }
}

// ───────────── the Worker side ─────────────

type Authed = { rt: Runtime; room: RoomRow; t: Ticket };
export interface PanicDeps {
  authed(c: Context<AppEnv>, token: unknown): Promise<Authed | null>;
  stub(c: Context<AppEnv>, roomId: string): DurableObjectStub;
  headersFor(rt: Runtime, room: RoomRow, who: Identity): Record<string, string>;
  sameOrigin(c: Context<AppEnv>): boolean;
}

/** What room-panic.js needs: the copy for everyone; for staff who may use it, whether a Zoom link exists. */
export async function panicPageCfg(rt: Runtime, room: RoomRow, who: Identity) {
  const ps = panicSettings(room);
  const staff = who.role === 'host' || who.role === 'cohost';
  const can = staff && (who.role === 'host' || ps.cohost);
  return {
    copy: PANIC_COPY,
    can, host: who.role === 'host', cohost: ps.cohost,
    zoom: can ? Boolean(await zoomUrlFor(rt, room).catch(() => null)) : false,
    movedFrom: room.moved_from ?? null,
  };
}

const err = (c: Context<AppEnv>, error: string, status: 400 | 403 | 404 | 409 | 429 | 500 = 400, extra: Record<string, unknown> = {}) => c.json({ ok: false, error, ...extra }, status);

/** POST /api/rooms/:id/panic {t, target, confirm}: the panic button. */
export async function panicRoute(c: Context<AppEnv>, d: PanicDeps) {
  if (!d.sameOrigin(c)) return c.json({ ok: false }, 403);
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const a = await d.authed(c, b.t);
  if (!a) return err(c, 'forbidden', 403);
  const target = parseTarget(b.target);
  if (!target) return err(c, 'bad_target');
  const { isAdmin } = await import('../admin/auth');
  const who = ticketIdentity(a.t);
  const { rt, room } = a;
  const now = Date.now();
  const root = await rootOf(rt, room.id);
  const base = { root, from: room.id, target, ref_type: room.ref_type, ref_id: room.ref_id, by: who };
  const admin = who.role === 'host' ? await isAdmin(c) : false;
  if (!mayPanic({ role: who.role, admin, cohostAllowed: panicSettings(room).cohost, target })) {
    await logMove(rt, { ...base, ok: false, error: 'forbidden' }, now);
    return err(c, 'forbidden', 403);
  }
  if (target === 'cohost') {
    const allow = b.allow === true;
    await rt.env.DB.prepare('UPDATE rooms SET panic = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify({ ...panicSettings(room), cohost: allow }), now, room.id).run();
    await logMove(rt, { ...base, ok: true, detail: allow ? 'co-hosts allowed' : 'co-hosts not allowed' }, now);
    return c.json({ ok: true, cohost: allow });
  }
  if (b.confirm !== true) return err(c, 'confirm');
  if (room.moved_to) return err(c, 'already_moved', 409, { to: room.moved_to });
  if (room.status === 'ended' || room.status === 'cancelled') return err(c, 'ended', 409);
  if (target === 'zoom' || target === 'zoom_off') {
    const url = await zoomUrlFor(rt, room);
    if (target === 'zoom' && !url) return err(c, 'no_zoom');
    if (target === 'zoom') {
      const left = await waitLeft(rt, root, now);
      if (left > 0) { await logMove(rt, { ...base, ok: false, error: 'too_soon' }, now); return err(c, 'too_soon', 429, { wait: Math.ceil(left / 1000) }); }
    }
    const r = await d.stub(c, room.id).fetch(new Request('https://room/panic/zoom', { method: 'POST', headers: { 'content-type': 'application/json', 'x-room-panic': '1', ...d.headersFor(rt, room, who) }, body: JSON.stringify({ url: target === 'zoom' ? url : null }) }))
      .then((x) => x.json() as Promise<{ ok?: boolean; told?: number }>).catch(() => null);
    await logMove(rt, { ...base, ok: Boolean(r?.ok), error: r?.ok ? null : 'room_unreachable', told: r?.told ?? 0 }, now);
    return r?.ok ? c.json({ ok: true, zoom: target === 'zoom', told: r.told ?? 0 }) : err(c, 'failed', 500);
  }
  // A fresh room.
  const left = await waitLeft(rt, root, now);
  if (left > 0) { await logMove(rt, { ...base, ok: false, error: 'too_soon' }, now); return err(c, 'too_soon', 429, { wait: Math.ceil(left / 1000) }); }
  // The old room's session (best effort: a broken room may not answer; the move goes ahead without it).
  const snap = await d.stub(c, room.id).fetch(new Request('https://room/panic/snapshot', { headers: { 'x-room-panic': '1', ...d.headersFor(rt, room, who) } }))
    .then((x) => (x.ok ? x.json() : null)).catch(() => null);
  const m = await moveRoom(rt, room, now);
  if (!m.ok) {
    await logMove(rt, { ...base, ok: false, error: m.error }, now);
    return err(c, m.error, m.error === 'failed' ? 500 : 409);
  }
  const to = m.to;
  let seeded = false;
  if (isSnapshot(snap)) {
    seeded = await d.stub(c, to.id).fetch(new Request('https://room/panic/seed', { method: 'POST', headers: { 'content-type': 'application/json', 'x-room-panic': '1', ...d.headersFor(rt, to, who) }, body: JSON.stringify(snap) }))
      .then((x) => x.ok).catch(() => false);
  }
  const told = await d.stub(c, room.id).fetch(new Request('https://room/panic/moved', { method: 'POST', headers: { 'content-type': 'application/json', 'x-room-panic': '1', ...d.headersFor(rt, room, who) }, body: JSON.stringify({ to: to.id }) }))
    .then((x) => x.json() as Promise<{ told?: number }>).then((x) => x.told ?? 0).catch(() => 0);
  await logMove(rt, { ...base, ok: true, to: to.id, told, detail: `${snap ? (seeded ? 'state copied' : 'state not copied') : 'old room did not answer'}` }, now);
  return c.json({ ok: true, to: to.id, url: `${rt.origin}/admin/rooms/${to.id}`, told, seeded });
}

/**
 * A late arrival on a moved room's link: the same kind of link for the room it moved to (null = not a moved room,
 * or the link isn't valid for it). Invites and passes are re-signed for the new room with the same identity; a
 * challenge token works as is; an admin goes to the new host room.
 */
export async function movedRedirect(rt: Runtime, room: RoomRow, q: { i?: string | null; c?: string | null; mv?: string | null; admin?: boolean }, now = Date.now()) {
  if (!room.moved_to) return null;
  const to = await latestOf(rt, room);
  if (to.id === room.id) return null;
  if (q.mv) {
    const t = await readPass(rt, q.mv, room.id, now);
    return t ? moveUrlFor(rt, to.id, ticketIdentity(t), now) : null;
  }
  if (q.i) {
    const inv = await readInvite(rt, q.i, room.id, now);
    if (!inv) return null;
    const { admissionOf } = await import('./admission');
    if (inv.role === 'cohost' && (inv.v ?? 0) !== admissionOf(room).cohostV) return null;
    const extra = { ...(inv.role === 'cohost' ? { v: admissionOf(to).cohostV } : {}), ...(inv.n ? { n: inv.n } : {}) };
    return inviteUrl(rt, to.id, await makeInvite(rt, to.id, inv.role, inv.lead, Math.max(60_000, inv.exp - now), now, extra));
  }
  if (q.c) return `${rt.origin}/rooms/${to.id}?c=${encodeURIComponent(q.c)}`;
  if (q.admin) return `${rt.origin}/admin/rooms/${to.id}`;
  return null;
}

/** A moved room's general admission link: the new room's (the admission settings moved with the row). */
export async function movedJoinUrl(rt: Runtime, room: RoomRow, reqUrl: string) {
  if (!room.moved_to) return null;
  const to = await latestOf(rt, room);
  if (to.id === room.id) return null;
  const { admissionOf, joinUrl } = await import('./admission');
  if (!admissionOf(to).on) return null;
  const u = new URL(await joinUrl(rt, to));
  for (const [k, v] of new URL(reqUrl).searchParams) u.searchParams.set(k, v);
  return u.toString();
}

/**
 * The page for a pass: the same person in the new room, with what their own link would have given them (the
 * offer panel for a registration, the back link of a challenge day). Null = not a valid pass for this room.
 */
export async function passIdentity(rt: Runtime, room: RoomRow, pass: string, now = Date.now()) {
  const t = await readPass(rt, pass, room.id, now);
  if (!t) return null;
  const who = ticketIdentity(t);
  let offer: { leadId: string; band: string | null; buy: string; token: string; day?: number; welcome?: string } | null = null;
  let back: string | null = null;
  if (who.regId && who.leadId && room.ref_type === 'live' && room.ref_id) {
    const reg = await rt.env.DB.prepare('SELECT id, token, lead_id, revenue_band FROM live_webinar_regs WHERE id = ? AND event_id = ?').bind(who.regId, room.ref_id).first<{ id: string; token: string; lead_id: string; revenue_band: string | null }>();
    if (reg && reg.lead_id === who.leadId) {
      const { liveWelcomeUrl } = await import('../live/events');
      offer = { leadId: reg.lead_id, band: reg.revenue_band, buy: '/api/live/deposit', token: reg.token, welcome: liveWelcomeUrl(rt, reg.token) };
    }
  }
  if (who.regId && who.leadId && room.ref_type === 'challenge' && room.ref_id) {
    const m = /^challenge:([^:]+):(\d)$/.exec(room.ref_id);
    const { getRegById } = await import('../challenge/cohorts');
    const reg = m ? await getRegById(rt, who.regId).catch(() => null) : null;
    if (m && reg && reg.lead_id === who.leadId && reg.cohort_id === m[1] && reg.status === 'paid') {
      const day = Number(m[2]);
      if (day >= 4) offer = { leadId: reg.lead_id, band: reg.revenue_band, buy: '/api/challenge/deposit', token: reg.token, day };
      back = `/challenge/day/${reg.token}/${day}`;
    }
  }
  return { who, offer, back };
}

/** A WebSocket for a stale page of a moved room: one message saying where to go, then closed (code 4003: no reconnect). */
export async function movedSocket(rt: Runtime, room: RoomRow, who: Identity) {
  const to = await latestOf(rt, room);
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  server.accept();
  server.send(JSON.stringify(movedMessage(await moveUrlFor(rt, to.id, who), who, to.id)));
  server.close(4003, 'moved');
  return new Response(null, { status: 101, webSocket: client });
}

/** Funnel HQ: the chain, attendance across it and the panic log. */
export async function chainReport(rt: Runtime, id: string) {
  const chain = await roomChain(rt, id);
  if (!chain.length) return null;
  return { chain, attendance: await chainAttendance(rt, chain.map((r) => r.id)), moves: await chainMoves(rt, chain[0].id) };
}

/** Routes: the room's button, and Funnel HQ's chain report. */
export function mountPanic(roomsApi: Hono<AppEnv>, roomsAdmin: Hono<AppEnv>, d: PanicDeps) {
  roomsApi.post('/:id/panic', (c) => panicRoute(c, d));
  roomsAdmin.get('/:id/chain', async (c) => {
    const { runtimeFrom } = await import('../app');
    const r = await chainReport(runtimeFrom(c), c.req.param('id') ?? '');
    return r ? c.json({ ok: true, ...r }) : c.json({ ok: false, error: 'Room not found' }, 404);
  });
}
