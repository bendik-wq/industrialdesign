/**
 * The room's state machine (pure: no I/O, so the tests drive it directly). The Durable Object (do.ts) keeps one
 * RoomState per room, feeds it every WebSocket message through apply(), persists it, then sends each socket its
 * own view(). Effects that need the database or the SFU (go live, end, the offer, closing someone's tracks) are
 * returned, never performed here.
 *
 * Two modes on one engine:
 *  - meeting: everyone may publish camera, mic and screen (client calls, up to about 12 on camera);
 *  - webinar: the host and co-hosts are on stage; the audience only subscribes. Raise hand → host invites →
 *    attendee accepts → on stage (may publish) → host can send them back to the audience.
 * Every count is the number of sockets actually connected; nothing is padded.
 */

export type RoomMode = 'webinar' | 'meeting';
export type Role = 'host' | 'cohost' | 'guest' | 'attendee';
export type TrackKind = 'audio' | 'video' | 'screen' | 'screenaudio';
export type Layout = 'auto' | 'speaker' | 'side' | 'screen' | 'grid';

export interface Identity { id: string; name: string; role: Role; leadId?: string | null; regId?: string | null }
export interface TrackRef { trackName: string; kind: TrackKind; mid?: string | null; simulcast?: boolean }
export interface Member extends Identity {
  connected: number;
  joinedAt: number;
  lastAt: number;
  stage: boolean;
  stageAt: number | null;
  hand: number | null;
  invited: number | null;
  sessionId: string | null;
  tracks: TrackRef[];
  audioOff: boolean;
  videoOff: boolean;
  lastChatAt: number;
  lastReactAt: number;
}
export interface ChatMsg { id: number; by: string; name: string; role: Role; text: string; at: number }
export interface Question { id: number; by: string; name: string; text: string; at: number; votes: string[]; answered: boolean }
export interface Poll { id: number; question: string; options: string[]; votes: Record<string, number>; open: boolean; at: number }
export interface OfferState { available: boolean; open: boolean; closesAt: number | null; label: string | null }

export interface RoomState {
  v: 1;
  id: string;
  mode: RoomMode;
  title: string;
  startsAt: number | null;
  status: 'lobby' | 'live' | 'ended';
  wentLiveAt: number | null;
  endedAt: number | null;
  members: Record<string, Member>;
  /** Removed from the room by a host: their id can't rejoin this room. */
  banned: string[];
  layout: Layout;
  spotlight: string | null;
  chat: { locked: boolean; slowSec: number; pinned: number | null; msgs: ChatMsg[]; seq: number };
  qa: Question[];
  qaSeq: number;
  polls: Poll[];
  pollSeq: number;
  offer: OfferState;
  timer: { endsAt: number; label: string } | null;
  peak: number;
  recording: boolean;
}

export const LIMITS = { chatKeep: 200, chatMax: 400, qaKeep: 150, qaMax: 300, openQuestionsPerPerson: 5, pollOptions: 5, meetingOnCamera: 12, stageMax: 6, timerMaxSec: 4 * 3600 };
export const SLOW_STEPS = [0, 5, 10, 30, 60] as const;
export const REACTIONS = ['clap', 'heart', 'idea', 'yes', 'question'] as const;
export const LAYOUTS: Layout[] = ['auto', 'speaker', 'side', 'screen', 'grid'];

export function newRoomState(o: { id: string; mode: RoomMode; title: string; startsAt: number | null; offerAvailable?: boolean }): RoomState {
  return {
    v: 1, id: o.id, mode: o.mode, title: o.title, startsAt: o.startsAt, status: o.mode === 'meeting' ? 'live' : 'lobby', wentLiveAt: null, endedAt: null,
    members: {}, banned: [], layout: 'auto', spotlight: null,
    chat: { locked: false, slowSec: 0, pinned: null, msgs: [], seq: 0 }, qa: [], qaSeq: 0, polls: [], pollSeq: 0,
    offer: { available: Boolean(o.offerAvailable), open: false, closesAt: null, label: null }, timer: null, peak: 0, recording: false,
  };
}

export const isStaff = (m: Pick<Member, 'role'> | null | undefined) => Boolean(m && (m.role === 'host' || m.role === 'cohost'));
/** Who may send media into the room right now. */
export const canPublish = (st: RoomState, m: Member | null | undefined) => Boolean(m && st.status !== 'ended' && (st.mode === 'meeting' || isStaff(m) || m.stage));
/** Whether this person may receive the stage now: webinars show the stage once the host goes live (staff and people on stage see it backstage too). */
export const canSeeStage = (st: RoomState, m: Member | null | undefined) => Boolean(m && st.status !== 'ended' && (st.mode === 'meeting' || st.status === 'live' || isStaff(m) || m.stage));
/** Members whose tracks are visible to the room (connected, publishing, on stage or in a meeting). */
export const stageMembers = (st: RoomState) => Object.values(st.members).filter((m) => m.connected > 0 && (st.mode === 'meeting' || isStaff(m) || m.stage));
export const connectedCount = (st: RoomState) => Object.values(st.members).filter((m) => m.connected > 0).length;

/** Track names are always prefixed with the publisher's id, so nobody can publish under someone else's name. */
export const trackPrefix = (memberId: string) => `${memberId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)}-`;
export const validTrackName = (memberId: string, name: unknown): name is string =>
  typeof name === 'string' && name.length <= 80 && name.startsWith(trackPrefix(memberId)) && /^[A-Za-z0-9_-]+$/.test(name);

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '');

// ───────────── joining and leaving ─────────────

export function join(st: RoomState, who: Identity, now: number): { ok: true; member: Member } | { ok: false; error: string } {
  if (st.banned.includes(who.id)) return { ok: false, error: 'removed' };
  if (st.status === 'ended' && !isStaff(who)) return { ok: false, error: 'ended' };
  const prev = st.members[who.id];
  const staff = isStaff(who);
  const m: Member = prev
    ? { ...prev, name: who.name || prev.name, role: who.role, connected: prev.connected + 1, lastAt: now }
    : {
      ...who, connected: 1, joinedAt: now, lastAt: now, stage: staff, stageAt: staff ? now : null, hand: null, invited: null,
      sessionId: null, tracks: [], audioOff: false, videoOff: false, lastChatAt: 0, lastReactAt: 0,
    };
  st.members[who.id] = m;
  st.peak = Math.max(st.peak, connectedCount(st));
  return { ok: true, member: m };
}

/** A socket closed. When it was their last one, their hand, invite and tracks go. */
export function leave(st: RoomState, id: string, now: number) {
  const m = st.members[id];
  if (!m) return null;
  m.connected = Math.max(0, m.connected - 1);
  m.lastAt = now;
  if (m.connected === 0) {
    m.hand = null; m.invited = null; m.sessionId = null; m.tracks = [];
    if (!isStaff(m) && st.mode === 'webinar') m.stage = false;
    if (st.spotlight === id) st.spotlight = null;
  }
  return m;
}

/** Drops members who left long ago (keeps the state small for webinars with hundreds of people). */
export function prune(st: RoomState, now: number, keepMs = 6 * 3600_000) {
  for (const [id, m] of Object.entries(st.members)) if (m.connected === 0 && now - m.lastAt > keepMs) delete st.members[id];
}

// ───────────── tracks (called by the SFU proxy in the Durable Object) ─────────────

export function claimSession(st: RoomState, memberId: string, sessionId: string) {
  const m = st.members[memberId];
  if (!m || !/^[A-Za-z0-9]{8,128}$/.test(sessionId)) return false;
  m.sessionId = sessionId;
  m.tracks = [];
  return true;
}
export const ownsSession = (st: RoomState, memberId: string, sessionId: unknown) => Boolean(typeof sessionId === 'string' && st.members[memberId]?.sessionId === sessionId);

export function addTracks(st: RoomState, memberId: string, tracks: TrackRef[]) {
  const m = st.members[memberId];
  if (!m) return;
  for (const t of tracks) {
    m.tracks = m.tracks.filter((x) => x.trackName !== t.trackName && x.kind !== t.kind);
    m.tracks.push(t);
  }
}
export function removeTracks(st: RoomState, memberId: string, names: string[]) {
  const m = st.members[memberId];
  if (m) m.tracks = m.tracks.filter((t) => !names.includes(t.trackName));
}

/** May `viewer` pull this remote track? Only tracks currently published by someone visible, and only when the viewer may see the stage. */
export function canPull(st: RoomState, viewerId: string, remote: { sessionId?: unknown; trackName?: unknown }) {
  const viewer = st.members[viewerId];
  if (!viewer || !canSeeStage(st, viewer)) return false;
  const pub = Object.values(st.members).find((m) => m.sessionId && m.sessionId === remote.sessionId);
  if (!pub || pub.id === viewerId || pub.connected === 0) return false;
  if (!(st.mode === 'meeting' || isStaff(pub) || pub.stage)) return false;
  return pub.tracks.some((t) => t.trackName === remote.trackName);
}

// ───────────── messages ─────────────

export type Out = { to: 'all' | string; msg: Record<string, unknown> };
export type Effect =
  | { type: 'went_live' }
  | { type: 'ended' }
  | { type: 'offer'; open: boolean }
  | { type: 'close_tracks'; memberId: string; sessionId: string | null; mids: string[] }
  | { type: 'kick'; memberId: string }
  | { type: 'on_stage'; memberId: string }
  | { type: 'recording'; on: boolean };
export interface ApplyResult { ok: boolean; error?: string; out: Out[]; effects: Effect[]; changed: boolean }

const fail = (error: string): ApplyResult => ({ ok: false, error, out: [], effects: [], changed: false });
const done = (o: Partial<ApplyResult> = {}): ApplyResult => ({ ok: true, out: [], effects: [], changed: true, ...o });

/** Every client message, with its permission rule. Mutates `st`. */
export function apply(st: RoomState, actorId: string, raw: unknown, now: number): ApplyResult {
  const me = st.members[actorId];
  if (!me) return fail('not_in_room');
  if (!raw || typeof raw !== 'object') return fail('bad_message');
  const msg = raw as Record<string, unknown>;
  const staff = isStaff(me);
  const host = me.role === 'host';
  const target = typeof msg.id === 'string' ? st.members[msg.id] ?? null : null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN);

  switch (msg.t) {
    // ── chat ──
    case 'chat': {
      if (st.status === 'ended') return fail('ended');
      if (st.chat.locked && !staff) return fail('chat_locked');
      if (!staff && st.chat.slowSec > 0 && now - me.lastChatAt < st.chat.slowSec * 1000) return fail('slow_mode');
      if (!staff && now - me.lastChatAt < 1000) return fail('too_fast');
      const text = clean(msg.text, LIMITS.chatMax);
      if (!text) return fail('empty');
      const m: ChatMsg = { id: ++st.chat.seq, by: me.id, name: me.name, role: me.role, text, at: now };
      st.chat.msgs.push(m);
      if (st.chat.msgs.length > LIMITS.chatKeep) st.chat.msgs.splice(0, st.chat.msgs.length - LIMITS.chatKeep);
      me.lastChatAt = now;
      return done({ out: [{ to: 'all', msg: { t: 'chat', m } }], changed: false });
    }
    case 'chat_delete': {
      if (!staff) return fail('forbidden');
      st.chat.msgs = st.chat.msgs.filter((m) => m.id !== msg.mid);
      if (st.chat.pinned === msg.mid) st.chat.pinned = null;
      return done();
    }
    case 'pin': {
      if (!staff) return fail('forbidden');
      if (msg.mid === null) { st.chat.pinned = null; return done(); }
      if (!st.chat.msgs.some((m) => m.id === msg.mid)) return fail('not_found');
      st.chat.pinned = msg.mid as number;
      return done();
    }
    case 'chat_lock': if (!staff) return fail('forbidden'); st.chat.locked = msg.on === true; return done();
    case 'slow': {
      if (!staff) return fail('forbidden');
      const s = num(msg.sec);
      if (!(SLOW_STEPS as readonly number[]).includes(s)) return fail('bad_value');
      st.chat.slowSec = s;
      return done();
    }

    // ── Q&A ──
    case 'ask': {
      if (st.status === 'ended') return fail('ended');
      const text = clean(msg.text, LIMITS.qaMax);
      if (text.length < 3) return fail('empty');
      if (st.qa.filter((q) => q.by === me.id && !q.answered).length >= LIMITS.openQuestionsPerPerson) return fail('too_many_questions');
      st.qa.push({ id: ++st.qaSeq, by: me.id, name: me.name, text, at: now, votes: [], answered: false });
      if (st.qa.length > LIMITS.qaKeep) st.qa.splice(0, st.qa.length - LIMITS.qaKeep);
      return done();
    }
    case 'upvote': {
      const q = st.qa.find((x) => x.id === msg.qid);
      if (!q) return fail('not_found');
      if (q.by === me.id) return fail('own_question');
      q.votes = q.votes.includes(me.id) ? q.votes.filter((v) => v !== me.id) : [...q.votes, me.id];
      return done();
    }
    case 'answer': {
      if (!staff) return fail('forbidden');
      const q = st.qa.find((x) => x.id === msg.qid);
      if (!q) return fail('not_found');
      q.answered = msg.on !== false;
      return done();
    }
    case 'q_delete': {
      if (!staff) return fail('forbidden');
      st.qa = st.qa.filter((x) => x.id !== msg.qid);
      return done();
    }

    // ── polls ──
    case 'poll_new': {
      if (!staff) return fail('forbidden');
      const question = clean(msg.question, 200);
      const options = (Array.isArray(msg.options) ? msg.options : []).map((o) => clean(o, 80)).filter(Boolean).slice(0, LIMITS.pollOptions);
      if (!question || options.length < 2) return fail('poll_incomplete');
      for (const p of st.polls) p.open = false;
      st.polls.push({ id: ++st.pollSeq, question, options, votes: {}, open: true, at: now });
      if (st.polls.length > 20) st.polls.splice(0, st.polls.length - 20);
      return done();
    }
    case 'vote': {
      const p = st.polls.find((x) => x.id === msg.pid);
      if (!p || !p.open) return fail('poll_closed');
      const c = num(msg.choice);
      if (!Number.isInteger(c) || c < 0 || c >= p.options.length) return fail('bad_value');
      if (me.id in p.votes) return fail('already_voted');
      p.votes[me.id] = c;
      return done();
    }
    case 'poll_close': {
      if (!staff) return fail('forbidden');
      const p = st.polls.find((x) => x.id === msg.pid);
      if (!p) return fail('not_found');
      p.open = false;
      return done();
    }

    // ── the stage (webinars) ──
    case 'hand': {
      if (st.mode !== 'webinar' || staff || me.stage) return fail('not_applicable');
      me.hand = msg.up === false ? null : me.hand ?? now;
      return done();
    }
    case 'invite': {
      if (!staff) return fail('forbidden');
      if (st.mode !== 'webinar' || !target || target.connected === 0 || isStaff(target) || target.stage) return fail('not_applicable');
      if (stageMembers(st).length >= LIMITS.stageMax) return fail('stage_full');
      target.invited = now;
      return done({ out: [{ to: target.id, msg: { t: 'invited', by: me.name } }] });
    }
    case 'accept': {
      if (!me.invited) return fail('not_invited');
      if (stageMembers(st).length >= LIMITS.stageMax) return fail('stage_full');
      me.invited = null; me.hand = null; me.stage = true; me.stageAt ??= now;
      return done({ effects: [{ type: 'on_stage', memberId: me.id }] });
    }
    case 'decline': me.invited = null; return done();
    case 'unstage': {
      // A host sends someone back to the audience, or someone on stage steps down themselves.
      const who = msg.id === undefined ? me : target;
      if (!who || st.mode !== 'webinar' || isStaff(who) || !who.stage) return fail('not_applicable');
      if (who.id !== me.id && !staff) return fail('forbidden');
      const mids = who.tracks.map((t) => t.mid).filter((x): x is string => Boolean(x));
      who.stage = false; who.tracks = [];
      if (st.spotlight === who.id) st.spotlight = null;
      return done({ out: [{ to: who.id, msg: { t: 'unstaged' } }], effects: [{ type: 'close_tracks', memberId: who.id, sessionId: who.sessionId, mids }] });
    }
    case 'mute': {
      if (!staff) return fail('forbidden');
      if (!target || target.id === me.id) return fail('not_applicable');
      if (target.role === 'host' && !host) return fail('forbidden');
      target.audioOff = true;
      return done({ out: [{ to: target.id, msg: { t: 'muted', by: me.name } }] });
    }
    case 'kick': {
      if (!staff) return fail('forbidden');
      if (!target || target.id === me.id || target.role === 'host' || (target.role === 'cohost' && !host)) return fail('forbidden');
      if (!st.banned.includes(target.id)) st.banned.push(target.id);
      const mids = target.tracks.map((t) => t.mid).filter((x): x is string => Boolean(x));
      const sessionId = target.sessionId;
      target.stage = false; target.tracks = []; target.hand = null; target.invited = null;
      if (st.spotlight === target.id) st.spotlight = null;
      return done({ out: [{ to: target.id, msg: { t: 'removed' } }], effects: [{ type: 'close_tracks', memberId: target.id, sessionId, mids }, { type: 'kick', memberId: target.id }] });
    }
    case 'spotlight': {
      if (!staff) return fail('forbidden');
      if (msg.id === null) { st.spotlight = null; return done(); }
      if (!target || !stageMembers(st).some((m) => m.id === target.id)) return fail('not_applicable');
      st.spotlight = target.id;
      return done();
    }
    case 'layout': {
      if (!staff) return fail('forbidden');
      if (!LAYOUTS.includes(msg.layout as Layout)) return fail('bad_value');
      st.layout = msg.layout as Layout;
      return done();
    }
    case 'media': {
      // What I'm sending (self-reported, for the tiles' mic and camera icons).
      const before = `${me.audioOff}${me.videoOff}`;
      if (typeof msg.audioOff === 'boolean') me.audioOff = msg.audioOff;
      if (typeof msg.videoOff === 'boolean') me.videoOff = msg.videoOff;
      return done({ changed: before !== `${me.audioOff}${me.videoOff}` });
    }

    // ── host flow ──
    case 'golive': {
      if (!staff) return fail('forbidden');
      if (st.mode !== 'webinar') return fail('not_applicable');
      if (st.status === 'live') return done({ changed: false });
      if (st.status === 'ended') return fail('ended');
      st.status = 'live'; st.wentLiveAt ??= now;
      return done({ effects: [{ type: 'went_live' }] });
    }
    case 'end': {
      if (!host) return fail('forbidden');
      if (st.status === 'ended') return done({ changed: false });
      st.status = 'ended'; st.endedAt = now; st.timer = null;
      for (const p of st.polls) p.open = false;
      return done({ out: [{ to: 'all', msg: { t: 'ended' } }], effects: [{ type: 'ended' }] });
    }
    case 'offer': {
      if (!staff) return fail('forbidden');
      if (!st.offer.available) return fail('no_offer');
      return done({ effects: [{ type: 'offer', open: msg.open !== false }], changed: false });
    }
    case 'timer': {
      if (!staff) return fail('forbidden');
      if (msg.sec === null) { st.timer = null; return done(); }
      const s = Math.round(num(msg.sec));
      if (!(s >= 10 && s <= LIMITS.timerMaxSec)) return fail('bad_value');
      st.timer = { endsAt: now + s * 1000, label: clean(msg.label, 60) };
      return done();
    }
    case 'recording': {
      if (!staff) return fail('forbidden');
      st.recording = msg.on === true;
      return done({ effects: [{ type: 'recording', on: st.recording }] });
    }
    case 'react': {
      if (!REACTIONS.includes(msg.kind as (typeof REACTIONS)[number])) return fail('bad_value');
      if (now - me.lastReactAt < 1500) return fail('too_fast');
      me.lastReactAt = now;
      return done({ out: [{ to: 'all', msg: { t: 'react', kind: msg.kind } }], changed: false });
    }
    case 'ping': return done({ changed: false, out: [{ to: me.id, msg: { t: 'pong', now } }] });
    default: return fail('unknown_message');
  }
}

// ───────────── what each person sees ─────────────

const tile = (m: Member) => ({ id: m.id, name: m.name, role: m.role, sessionId: m.sessionId, tracks: m.tracks, audioOff: m.audioOff, videoOff: m.videoOff });

/** The view one person gets. The audience never receives the attendee list, only the real count. */
export function view(st: RoomState, me: Member, now: number, o: { chat?: boolean } = {}) {
  const staff = isStaff(me);
  const seeStage = canSeeStage(st, me);
  const poll = [...st.polls].reverse().find((p) => p.open) ?? (staff ? st.polls[st.polls.length - 1] : null) ?? null;
  const pollView = (p: Poll) => {
    const counts = p.options.map((_, i) => Object.values(p.votes).filter((v) => v === i).length);
    const mine = me.id in p.votes ? p.votes[me.id] : null;
    return { id: p.id, question: p.question, options: p.options, open: p.open, mine, counts: staff || mine !== null || !p.open ? counts : null, total: Object.keys(p.votes).length };
  };
  return {
    t: 'state',
    now,
    room: {
      id: st.id, mode: st.mode, title: st.title, startsAt: st.startsAt, status: st.status, wentLiveAt: st.wentLiveAt, endedAt: st.endedAt,
      layout: st.layout, spotlight: st.spotlight, count: connectedCount(st), recording: st.recording,
      timer: st.timer, offer: st.offer,
      chat: { locked: st.chat.locked, slowSec: st.chat.slowSec, pinned: st.chat.msgs.find((m) => m.id === st.chat.pinned) ?? null },
    },
    me: { id: me.id, name: me.name, role: me.role, stage: me.stage || st.mode === 'meeting' || staff, canPublish: canPublish(st, me), hand: me.hand, invited: me.invited, audioOff: me.audioOff, videoOff: me.videoOff },
    stage: seeStage ? stageMembers(st).map(tile) : [],
    qa: [...st.qa].sort((a, b) => Number(a.answered) - Number(b.answered) || b.votes.length - a.votes.length || a.at - b.at)
      .map((q) => ({ id: q.id, name: q.name, text: q.text, votes: q.votes.length, mine: q.by === me.id, voted: q.votes.includes(me.id), answered: q.answered })),
    poll: poll ? pollView(poll) : null,
    people: staff
      ? Object.values(st.members).filter((m) => m.connected > 0).map((m) => ({ id: m.id, name: m.name, role: m.role, stage: m.stage || isStaff(m), hand: m.hand, invited: m.invited, audioOff: m.audioOff }))
        .sort((a, b) => (b.hand ? 1 : 0) - (a.hand ? 1 : 0) || (a.hand ?? 0) - (b.hand ?? 0) || a.name.localeCompare(b.name))
      : null,
    ...(o.chat ? { chat: st.chat.msgs.slice(-100) } : {}),
  };
}
