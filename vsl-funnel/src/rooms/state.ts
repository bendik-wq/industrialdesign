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

import { type AgendaItem, type PointAction, DEFAULT_AGENDA, QUESTION_MIN_CHARS, cleanQuiz, leaderboard } from './engage';

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
  /** How this viewer's media actually arrives (self-reported by their browser): MoQ playback or the SFU. */
  media?: 'moq' | 'sfu' | null;
  /** Why MoQ didn't work for this viewer (no WebTransport, blocked network, stalled): they stay on the SFU. */
  moqFail?: string | null;
}
export interface ChatMsg {
  id: number; by: string; name: string; role: Role; text: string; at: number;
  /** Area C (audience): a reply to message `re`; the team's answers carry a label and the question they answer. */
  re?: number; label?: string; q?: string;
}
export interface Question { id: number; by: string; name: string; text: string; at: number; votes: string[]; answered: boolean }
export interface Poll { id: number; question: string; options: string[]; votes: Record<string, number>; open: boolean; at: number }
export interface OfferState { available: boolean; open: boolean; closesAt: number | null; label: string | null }
/**
 * The room's MoQ broadcast (webinars). Config comes from settings and the room's override on every request;
 * health comes from the host's browser, which publishes the composited stage and reports every few seconds.
 */
export interface MoqState {
  mode: 'auto' | 'sfu' | 'moq';
  ready: boolean;
  minAudience: number;
  /** Auto mode switched the audience to MoQ (sticky for the session, so nobody flips back and forth). */
  engaged: boolean;
  publishing: boolean;
  at: number | null;
  by: string | null;
  kbps: number | null;
  fps: number | null;
  error: string | null;
}

/** Engagement (webinars): host pushes, knowledge checks, the agenda, the leaderboard, points and unlocks per person. */
export type PushKind = 'application' | 'sprint' | 'deposit' | 'vip' | 'resource';
export const PUSH_KINDS: PushKind[] = ['application', 'sprint', 'deposit', 'vip', 'resource'];
export type PushEvent = 'shown' | 'opened' | 'started' | 'dismissed';
export const PUSH_CLIENT_EVENTS: PushEvent[] = ['shown', 'opened', 'started', 'dismissed'];
export interface Push { id: number; kind: PushKind; ref: string | null; to: string[] | null; at: number; open: boolean; by: string }
export interface Quiz { id: number; question: string; options: string[]; correct: number; explain: string; answers: Record<string, number>; open: boolean; at: number }
export interface EngageAvail { application: boolean; sprint: boolean; deposit: boolean; vip: boolean; resources: string[] }
export interface EngageState {
  avail: EngageAvail;
  agenda: AgendaItem[];
  /** The chapter the host marked (-1 = not started). */
  chapter: number;
  pushes: Push[];
  pushSeq: number;
  quizzes: Quiz[];
  quizSeq: number;
  /** The leaderboard is shown (host's switch; off by default); only people who opted in appear on it. */
  board: boolean;
  optIn: string[];
  /** Points and unlocks per member, as confirmed by the database (the DO updates them after each award). */
  pts: Record<string, number>;
  unlocks: Record<string, string[]>;
  /** Minutes each attendee has been connected while live (for the per-10-minute award). */
  mins: Record<string, number>;
}
export interface PointAward { memberId: string; action: PointAction; key: string }
export const newEngage = (o: Partial<Pick<EngageState, 'avail' | 'agenda' | 'board'>> = {}): EngageState => ({
  avail: o.avail ?? { application: false, sprint: false, deposit: false, vip: false, resources: [] },
  agenda: o.agenda ?? DEFAULT_AGENDA.map((a) => ({ ...a })), chapter: -1, pushes: [], pushSeq: 0, quizzes: [], quizSeq: 0,
  board: o.board ?? false, optIn: [], pts: {}, unlocks: {}, mins: {},
});

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
  moq?: MoqState;
  eng?: EngageState;
}

export const MOQ_HEALTH_MS = 20_000;
export const newMoqState = (): MoqState => ({ mode: 'auto', ready: false, minAudience: 25, engaged: false, publishing: false, at: null, by: null, kbps: null, fps: null, error: null });
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
    moq: newMoqState(),
    eng: newEngage(),
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

// ───────────── MoQ: which way each viewer's media arrives ─────────────

const moqOf = (st: RoomState) => (st.moq ??= newMoqState());
/** Viewers: connected, in a webinar, not staff and not on stage (they are the only ones MoQ can serve). */
export const audience = (st: RoomState) => Object.values(st.members).filter((m) => m.connected > 0 && !isStaff(m) && !m.stage).length;
/** The host's broadcast is up: it reported publishing within the last 20 seconds. */
export const broadcastLive = (st: RoomState, now: number) => {
  const q = st.moq;
  return Boolean(q && q.ready && q.publishing && q.at !== null && now - q.at < MOQ_HEALTH_MS);
};
/** Whether the host's browser should publish to the relay now (webinar, MoQ set up and allowed, live). */
export const shouldPublishMoq = (st: RoomState, m: Member | null | undefined) =>
  Boolean(m && m.role === 'host' && st.mode === 'webinar' && st.status === 'live' && st.moq?.ready && st.moq.mode !== 'sfu');
/** Applies the room's config (settings and the Funnel HQ override); returns whether anything changed. */
export function configureMoq(st: RoomState, c: { mode: MoqState['mode']; ready: boolean; minAudience: number }) {
  const q = moqOf(st);
  const before = `${q.mode}${q.ready}${q.minAudience}${q.engaged}`;
  q.mode = c.mode; q.ready = c.ready; q.minAudience = Math.max(1, Math.round(c.minAudience));
  if (q.mode === 'sfu') q.engaged = false;
  engage(st);
  return before !== `${q.mode}${q.ready}${q.minAudience}${q.engaged}`;
}
/** Auto mode moves the audience to MoQ once it reaches the threshold, and keeps it there for the session. */
export function engage(st: RoomState) {
  const q = moqOf(st);
  if (st.mode !== 'webinar' || q.mode === 'sfu') return false;
  const was = q.engaged;
  if (q.mode === 'moq' || audience(st) >= q.minAudience) q.engaged = true;
  return q.engaged !== was;
}
/**
 * The media path for one person. The SFU for meetings, staff, people on stage, while MoQ isn't set up, allowed
 * or engaged, while the host's broadcast isn't live, and for anyone whose browser or network couldn't play it.
 */
export function mediaPath(st: RoomState, m: Member, now: number): 'moq' | 'sfu' {
  const q = st.moq;
  if (!q || st.mode !== 'webinar' || st.status !== 'live' || isStaff(m) || m.stage) return 'sfu';
  if (!q.ready || q.mode === 'sfu' || !q.engaged || m.moqFail) return 'sfu';
  return broadcastLive(st, now) ? 'moq' : 'sfu';
}
/** Viewer counts by how their media really arrives (what their browser reported, else what they were sent). */
export function mediaCounts(st: RoomState, now: number) {
  let moq = 0, sfu = 0;
  for (const m of Object.values(st.members)) {
    if (m.connected === 0 || isStaff(m) || m.stage) continue;
    const path = m.media ?? mediaPath(st, m, now);
    if (path === 'moq') moq++; else sfu++;
  }
  return { moq, sfu };
}

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
  engage(st);
  return { ok: true, member: m };
}

/** A socket closed. When it was their last one, their hand, invite and tracks go. */
export function leave(st: RoomState, id: string, now: number) {
  const m = st.members[id];
  if (!m) return null;
  m.connected = Math.max(0, m.connected - 1);
  m.lastAt = now;
  if (m.connected === 0) {
    m.hand = null; m.invited = null; m.sessionId = null; m.tracks = []; m.media = null;
    if (!isStaff(m) && st.mode === 'webinar') m.stage = false;
    if (st.spotlight === id) st.spotlight = null;
    // The host's broadcast ends with the host's last connection.
    if (st.moq && st.moq.by === id) { st.moq.publishing = false; st.moq.kbps = null; st.moq.fps = null; }
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
  | { type: 'recording'; on: boolean }
  | { type: 'award'; awards: PointAward[] }
  | { type: 'pushed'; push: Push }
  | { type: 'push_ev'; memberId: string; pushId: number; ev: PushEvent }
  | { type: 'quiz_answer'; memberId: string; quizId: number; choice: number; correct: boolean; question: string }
  | { type: 'end_unlocks'; memberIds: string[] };
export interface ApplyResult { ok: boolean; error?: string; out: Out[]; effects: Effect[]; changed: boolean }

const fail = (error: string): ApplyResult => ({ ok: false, error, out: [], effects: [], changed: false });
const done = (o: Partial<ApplyResult> = {}): ApplyResult => ({ ok: true, out: [], effects: [], changed: true, ...o });

export const engOf = (st: RoomState) => (st.eng ??= newEngage());
/** The audience members connected now (who can earn points). */
export const audienceMembers = (st: RoomState) => Object.values(st.members).filter((m) => m.connected > 0 && !isStaff(m));
const awardAll = (st: RoomState, action: PointAction, key: string): Effect[] => {
  if (st.mode !== 'webinar') return [];
  const awards = audienceMembers(st).map((m) => ({ memberId: m.id, action, key }));
  return awards.length ? [{ type: 'award', awards }] : [];
};
/** On time: everyone in the audience when the host goes live (later joiners within ON_TIME_MS are awarded on join). */
export const onTimeAwards = (st: RoomState): PointAward[] => (st.mode === 'webinar' ? audienceMembers(st).map((m) => ({ memberId: m.id, action: 'on_time' as const, key: '1' })) : []);
/** Whether a push is meant for this member (staff see every push but receive none). */
export const pushFor = (p: Push, m: Pick<Member, 'id' | 'role'>) => !isStaff(m) && (!p.to || p.to.includes(m.id));
/**
 * Once a minute while live: each attendee's minutes, and a present_10 award at every ten minutes in the room.
 * Returns the awards for the Durable Object to record.
 */
export function tickMinutes(st: RoomState): PointAward[] {
  if (st.mode !== 'webinar' || st.status !== 'live') return [];
  const e = engOf(st);
  const out: PointAward[] = [];
  for (const m of audienceMembers(st)) {
    const n = (e.mins[m.id] = (e.mins[m.id] ?? 0) + 1);
    if (n % 10 === 0) out.push({ memberId: m.id, action: 'present_10', key: String(n / 10) });
  }
  return out;
}

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
      if (typeof msg.re === 'number' && st.chat.msgs.some((x) => x.id === msg.re)) m.re = msg.re; // area C: threads
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
      // Points only for a real question (long enough); the per-action cap is enforced where the award is recorded.
      const earn = st.mode === 'webinar' && !staff && text.length >= QUESTION_MIN_CHARS;
      return done({ effects: earn ? [{ type: 'award', awards: [{ memberId: me.id, action: 'question', key: String(st.qaSeq) }] }] : [] });
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
      return done({ effects: st.mode === 'webinar' && !staff ? [{ type: 'award', awards: [{ memberId: me.id, action: 'poll', key: String(p.id) }] }] : [] });
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
      me.invited = null; me.hand = null; me.stage = true; me.stageAt ??= now; me.media = null;
      return done({ effects: [{ type: 'on_stage', memberId: me.id }] });
    }
    case 'decline': me.invited = null; return done();
    case 'unstage': {
      // A host sends someone back to the audience, or someone on stage steps down themselves.
      const who = msg.id === undefined ? me : target;
      if (!who || st.mode !== 'webinar' || isStaff(who) || !who.stage) return fail('not_applicable');
      if (who.id !== me.id && !staff) return fail('forbidden');
      const mids = who.tracks.map((t) => t.mid).filter((x): x is string => Boolean(x));
      who.stage = false; who.tracks = []; who.media = null;
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
      // Everyone already waiting in the room is on time (the Durable Object awards onTimeAwards() on went_live).
      return done({ effects: [{ type: 'went_live' }] });
    }
    case 'end': {
      if (!host) return fail('forbidden');
      if (st.status === 'ended') return done({ changed: false });
      // Staying to the end: the attendees connected when the host ends a live session.
      const stayed = st.status === 'live' && st.mode === 'webinar' ? audienceMembers(st).map((m) => m.id) : [];
      const reward = stayed.length ? awardAll(st, 'stayed_end', '1') : [];
      st.status = 'ended'; st.endedAt = now; st.timer = null;
      if (st.moq) st.moq.publishing = false;
      for (const p of st.polls) p.open = false;
      const e = engOf(st);
      for (const q of e.quizzes) q.open = false;
      for (const p of e.pushes) if (p.kind !== 'deposit') p.open = false;
      const end: Effect[] = stayed.length ? [{ type: 'end_unlocks', memberIds: stayed }] : [];
      return done({ out: [{ to: 'all', msg: { t: 'ended' } }], effects: [...reward, ...end, { type: 'ended' }] });
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
    // ── MoQ ──
    case 'moq_pub': {
      // The host's browser reports its broadcast every few seconds. Only a state change redraws everyone.
      if (me.role !== 'host') return fail('forbidden');
      const q = moqOf(st);
      const on = msg.on === true && shouldPublishMoq(st, me);
      const before = broadcastLive(st, now);
      q.publishing = on; q.at = now; q.by = me.id;
      q.kbps = on && Number.isFinite(num(msg.kbps)) ? Math.max(0, Math.round(num(msg.kbps))) : null;
      q.fps = on && Number.isFinite(num(msg.fps)) ? Math.max(0, Math.round(num(msg.fps))) : null;
      q.error = on ? null : clean(msg.error, 160) || null;
      const after = broadcastLive(st, now);
      // A fresh broadcast gives viewers whose playback stalled on the last one another try (not those whose browser can't).
      if (after && !before) for (const m of Object.values(st.members)) if (m.moqFail === 'stalled') m.moqFail = null;
      return done({ changed: before !== after });
    }
    case 'moq_view': {
      // A viewer's browser says how its media is arriving. A failure sends them to the SFU for the session.
      if (isStaff(me) || me.stage) return done({ changed: false });
      const state = msg.state;
      const before = `${me.media}${me.moqFail}`;
      if (state === 'playing') me.media = 'moq';
      else if (state === 'sfu') me.media = 'sfu';
      else if (state === 'failed' || state === 'unsupported') { me.media = 'sfu'; me.moqFail = clean(msg.reason, 80) || String(state); }
      else return fail('bad_value');
      return done({ changed: before !== `${me.media}${me.moqFail}` });
    }
    // ── engagement (webinars) ──
    case 'push': {
      if (!staff) return fail('forbidden');
      if (st.mode !== 'webinar' || st.status === 'ended') return fail('not_applicable');
      const e = engOf(st);
      const kind = msg.kind as PushKind;
      if (!PUSH_KINDS.includes(kind) || !(kind === 'resource' ? e.avail.resources.length : e.avail[kind])) return fail('push_kind');
      const ref = kind === 'resource' ? (typeof msg.ref === 'string' && e.avail.resources.includes(msg.ref) ? msg.ref : null) : null;
      if (kind === 'resource' && !ref) return fail('push_kind');
      if (kind === 'deposit' && !st.offer.open) return fail('offer_closed');
      let to: string[] | null = null;
      if (Array.isArray(msg.to)) {
        to = [...new Set(msg.to.filter((x): x is string => typeof x === 'string'))].filter((id) => st.members[id] && !isStaff(st.members[id])).slice(0, 500);
        if (!to.length) return fail('push_targets');
      }
      // One live card per kind (and resource): a new push of the same thing replaces the old one.
      for (const p of e.pushes) if (p.open && p.kind === kind && p.ref === ref) p.open = false;
      const push: Push = { id: ++e.pushSeq, kind, ref, to, at: now, open: true, by: me.id };
      e.pushes.push(push);
      if (e.pushes.length > 40) e.pushes.splice(0, e.pushes.length - 40);
      return done({ effects: [{ type: 'pushed', push }] });
    }
    case 'push_close': {
      if (!staff) return fail('forbidden');
      const p = engOf(st).pushes.find((x) => x.id === msg.pid);
      if (!p) return fail('not_found');
      p.open = false;
      return done();
    }
    case 'push_ev': {
      const p = engOf(st).pushes.find((x) => x.id === msg.pid);
      const ev = msg.ev as PushEvent;
      if (!p || !pushFor(p, me)) return fail('not_targeted');
      if (!PUSH_CLIENT_EVENTS.includes(ev)) return fail('bad_value');
      return done({ changed: false, effects: [{ type: 'push_ev', memberId: me.id, pushId: p.id, ev }] });
    }
    case 'quiz_new': {
      if (!staff) return fail('forbidden');
      if (st.mode !== 'webinar' || st.status === 'ended') return fail('not_applicable');
      const q = cleanQuiz(msg);
      if (!q) return fail('quiz_incomplete');
      const e = engOf(st);
      for (const x of e.quizzes) x.open = false;
      e.quizzes.push({ id: ++e.quizSeq, ...q, answers: {}, open: true, at: now });
      if (e.quizzes.length > 20) e.quizzes.splice(0, e.quizzes.length - 20);
      return done();
    }
    case 'quiz_answer': {
      if (staff) return fail('not_applicable');
      const q = engOf(st).quizzes.find((x) => x.id === msg.qid);
      if (!q || !q.open) return fail('quiz_closed');
      const c = num(msg.choice);
      if (!Number.isInteger(c) || c < 0 || c >= q.options.length) return fail('bad_value');
      if (me.id in q.answers) return fail('already_answered');
      q.answers[me.id] = c;
      const correct = c === q.correct;
      const awards: PointAward[] = [{ memberId: me.id, action: 'quiz', key: String(q.id) }];
      if (correct) awards.push({ memberId: me.id, action: 'quiz_correct', key: String(q.id) });
      return done({
        out: [{ to: me.id, msg: { t: 'quiz_result', qid: q.id, choice: c, correct, right: q.correct, explain: q.explain } }],
        effects: [{ type: 'quiz_answer', memberId: me.id, quizId: q.id, choice: c, correct, question: q.question }, { type: 'award', awards }],
      });
    }
    case 'quiz_close': {
      if (!staff) return fail('forbidden');
      const q = engOf(st).quizzes.find((x) => x.id === msg.qid);
      if (!q) return fail('not_found');
      q.open = false;
      return done();
    }
    case 'chapter': {
      if (!staff) return fail('forbidden');
      const e = engOf(st);
      const n = num(msg.n);
      if (!Number.isInteger(n) || n < -1 || n >= e.agenda.length) return fail('bad_value');
      e.chapter = n;
      // Everyone in the room when a chapter starts has reached it (once per chapter, whatever the host clicks).
      return done({ effects: n >= 0 && st.status === 'live' ? awardAll(st, 'chapter', String(n)) : [] });
    }
    case 'board': {
      if (!staff) return fail('forbidden');
      engOf(st).board = msg.on === true;
      return done();
    }
    case 'board_opt': {
      if (staff) return fail('not_applicable');
      const e = engOf(st);
      e.optIn = e.optIn.filter((x) => x !== me.id);
      if (msg.on === true) e.optIn.push(me.id);
      return done();
    }
    case 'ping': return done({ changed: false, out: [{ to: me.id, msg: { t: 'pong', now } }] });
    default: return fail('unknown_message');
  }
}

// ───────────── what each person sees ─────────────

/** The broadcast panel for staff (and Funnel HQ): mode, health, and viewers on each path. */
export function broadcastView(st: RoomState, now: number) {
  const q = st.moq ?? newMoqState();
  return { mode: q.mode, ready: q.ready, engaged: q.engaged, minAudience: q.minAudience, live: broadcastLive(st, now), kbps: q.kbps, fps: q.fps, error: q.error, audience: audience(st), ...mediaCounts(st, now) };
}

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
      ...(staff && st.mode === 'webinar' ? { broadcast: broadcastView(st, now) } : {}),
      chat: { locked: st.chat.locked, slowSec: st.chat.slowSec, pinned: st.chat.msgs.find((m) => m.id === st.chat.pinned) ?? null },
    },
    me: {
      id: me.id, name: me.name, role: me.role, stage: me.stage || st.mode === 'meeting' || staff, canPublish: canPublish(st, me), hand: me.hand, invited: me.invited, audioOff: me.audioOff, videoOff: me.videoOff,
      media: mediaPath(st, me, now), publishMoq: shouldPublishMoq(st, me),
    },
    stage: seeStage ? stageMembers(st).map(tile) : [],
    qa: [...st.qa].sort((a, b) => Number(a.answered) - Number(b.answered) || b.votes.length - a.votes.length || a.at - b.at)
      .map((q) => ({ id: q.id, name: q.name, text: q.text, votes: q.votes.length, mine: q.by === me.id, voted: q.votes.includes(me.id), answered: q.answered })),
    poll: poll ? pollView(poll) : null,
    people: staff
      ? Object.values(st.members).filter((m) => m.connected > 0).map((m) => ({ id: m.id, name: m.name, role: m.role, stage: m.stage || isStaff(m), hand: m.hand, invited: m.invited, audioOff: m.audioOff, pts: st.eng?.pts[m.id] ?? 0 }))
        .sort((a, b) => (b.hand ? 1 : 0) - (a.hand ? 1 : 0) || (a.hand ?? 0) - (b.hand ?? 0) || a.name.localeCompare(b.name))
      : null,
    ...(st.mode === 'webinar' ? { eng: engageView(st, me) } : {}),
    ...(o.chat ? { chat: st.chat.msgs.slice(-100) } : {}),
  };
}

/** What one person sees of the engagement: their points, unlocks and cards; staff see every push and the live counts. */
export function engageView(st: RoomState, me: Member) {
  const e = engOf(st);
  const staff = isStaff(me);
  const names: Record<string, string> = {};
  if (e.board || staff) for (const m of Object.values(st.members)) names[m.id] = m.name;
  const quiz = [...e.quizzes].reverse().find((q) => q.open || staff || me.id in q.answers) ?? null;
  const quizView = (q: Quiz) => {
    const mine = me.id in q.answers ? q.answers[me.id] : null;
    const reveal = staff || mine !== null || !q.open;
    const counts = q.options.map((_, i) => Object.values(q.answers).filter((v) => v === i).length);
    return {
      id: q.id, question: q.question, options: q.options, open: q.open, mine,
      right: reveal ? q.correct : null, explain: reveal ? q.explain : null,
      counts: staff || !q.open ? counts : null, total: Object.keys(q.answers).length,
    };
  };
  return {
    pts: e.pts[me.id] ?? 0,
    unlocks: e.unlocks[me.id] ?? [],
    agenda: { items: e.agenda, chapter: e.chapter },
    pushes: staff
      ? e.pushes.slice(-12).map((p) => ({ id: p.id, kind: p.kind, ref: p.ref, open: p.open, at: p.at, to: p.to ? p.to.length : null }))
      : e.pushes.filter((p) => p.open && pushFor(p, me)).map((p) => ({ id: p.id, kind: p.kind, ref: p.ref, at: p.at })),
    quiz: quiz ? quizView(quiz) : null,
    board: { on: e.board, optedIn: e.optIn.includes(me.id), top: e.board || staff ? leaderboard(e.pts, names, e.optIn) : [] },
    ...(staff ? { avail: e.avail } : {}),
  };
}
