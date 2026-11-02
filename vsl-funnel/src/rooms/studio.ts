/**
 * Builder B "studio": the host's production studio inside our room (pure, no I/O, like state.ts).
 *
 * Scenes (intro, main, slides, brb, qa, offer, outro), main layouts, slides as a stage source, overlays (lower
 * third, logo bug, ticker, an on-screen chat message or question, a countdown that follows the real offer close
 * or a server timer), the green room (co-hosts and invited guests wait backstage, check their audio and chat
 * privately with the host before the audience sees or hears them), the producer role (a co-host the host trusts
 * to switch scenes, push cards and run cues, who still can't end the session), and the run of show (sections of
 * the Fladlien script with server-stamped start times, and one-click cues that call the room's own engagement
 * actions through apply()).
 *
 * Every timer here is the server's: the room stamps `now` when a scene, section or countdown starts, and the
 * offer countdown reads the offer's real close time. Nothing on screen is invented.
 */

import type { Material } from '../admin/materials';
import { QUIZ_PRESETS } from './engage';
import type { ApplyResult, Member, RoomState } from './state';

export type Scene = 'intro' | 'main' | 'slides' | 'brb' | 'qa' | 'offer' | 'outro';
export const SCENES: Scene[] = ['intro', 'main', 'slides', 'brb', 'qa', 'offer', 'outro'];
export type MainLayout = 'solo' | 'side' | 'speaker_screen' | 'screen' | 'grid';
export const MAIN_LAYOUTS: MainLayout[] = ['solo', 'side', 'speaker_screen', 'screen', 'grid'];

export interface StudioState {
  on: boolean;
  scene: Scene;
  layout: MainLayout;
  sceneAt: number | null;
  sceneBy: string | null;
  /** The deck on the stage (uploaded slides, src/rooms/studio-db.ts) and the page showing. */
  deck: { id: string; title: string; pages: number } | null;
  page: number;
  /** The furthest page each deck has shown: attendees may load those pages and no further (no skipping ahead). */
  revealed: Record<string, number>;
  /** The presenter's camera in a corner of the slides scene. */
  slideCam: boolean;
  lower: { on: boolean; name: string; title: string };
  logo: boolean;
  ticker: { on: boolean; text: string };
  /** A chat message or question on screen (first name only). */
  highlight: { kind: 'chat' | 'question'; id: number; name: string; text: string; at: number } | null;
  /** offer: follows the offer's real close time; custom: a server timer the host started. */
  countdown: { kind: 'offer' } | { kind: 'custom'; endsAt: number; label: string } | null;
  /** The BRB scene's own timer (server time), when the host sets one. */
  brbEndsAt: number | null;
  music: boolean;
  /** Co-hosts the host made producers. */
  crew: Record<string, 'producer'>;
  /** The green room: people backstage, and whether they finished their audio check. */
  green: Record<string, { at: number; ready: boolean }>;
  /** Co-hosts brought on stage this session (a reconnect keeps their place). */
  staged: Record<string, true>;
  greenDefault: boolean;
  /** Private backstage chat (host, co-hosts, producers and whoever is in the green room). */
  back: { id: number; by: string; name: string; text: string; at: number }[];
  backSeq: number;
  /** Run of show: the section running now and when each section started (server time). */
  ros: { section: number; at: Record<string, number> };
}

/** Per-room defaults from Funnel HQ (rooms.studio, migration 0057). */
export interface StudioDefaults { on: boolean; scene: Scene; layout: MainLayout; greenRoom: boolean; lowerName: string; lowerTitle: string; ticker: string; music: boolean }

export function newStudio(d: Partial<StudioDefaults> = {}): StudioState {
  return {
    on: d.on ?? true, scene: d.scene ?? 'main', layout: d.layout ?? 'solo', sceneAt: null, sceneBy: null,
    deck: null, page: 0, revealed: {}, slideCam: true,
    lower: { on: false, name: d.lowerName ?? '', title: d.lowerTitle ?? '' }, logo: true, ticker: { on: false, text: d.ticker ?? '' },
    highlight: null, countdown: null, brbEndsAt: null, music: d.music ?? false,
    crew: {}, green: {}, staged: {}, greenDefault: d.greenRoom ?? false, back: [], backSeq: 0, ros: { section: -1, at: {} },
  };
}

export const LIMITS_STUDIO = { backKeep: 60, backMax: 300, lowerMax: 60, tickerMax: 160, countdownMaxSec: 4 * 3600, deckPagesMax: 300, highlightMax: 280 };

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const firstName = (n: string) => (n || '').trim().split(/\s+/)[0]?.slice(0, 40) || '';
const isStaffRole = (m: Pick<Member, 'role'> | null | undefined) => Boolean(m && (m.role === 'host' || m.role === 'cohost'));

/** The room's studio (webinars only; meetings have none). */
export const studioOf = (st: RoomState): StudioState | null => (st.mode === 'webinar' ? ((st as RoomState & { studio?: StudioState }).studio ??= newStudio()) : null);
const peek = (st: RoomState) => (st as RoomState & { studio?: StudioState }).studio ?? null;

/** Applies Funnel HQ's per-room defaults: once when the studio is made, and the on switch every time. */
export function configureStudio(st: RoomState, d: Partial<StudioDefaults>) {
  if (st.mode !== 'webinar') return;
  const s = peek(st);
  if (!s) { (st as RoomState & { studio?: StudioState }).studio = newStudio(d); return; }
  if (typeof d.on === 'boolean') s.on = d.on;
  if (typeof d.greenRoom === 'boolean') s.greenDefault = d.greenRoom;
}

// ───────────── permissions ─────────────

export const isProducer = (st: RoomState, m: Pick<Member, 'id' | 'role'> | null | undefined) => Boolean(m && m.role === 'cohost' && peek(st)?.crew[m.id] === 'producer');
/** Who runs the show: the host, and co-hosts the host made producers. */
export const canDirect = (st: RoomState, m: Pick<Member, 'id' | 'role'> | null | undefined) => Boolean(m && (m.role === 'host' || isProducer(st, m)));
export const inGreen = (st: RoomState, id: string) => Boolean(peek(st)?.on && peek(st)!.green[id]);
/** Backstage people: staff, and anyone in the green room. */
export const isBackstage = (st: RoomState, m: Pick<Member, 'id' | 'role'> | null | undefined) => Boolean(m && (isStaffRole(m) || inGreen(st, m.id)));

/** May `viewer` pull `pub`'s tracks? People in the green room are seen and heard backstage only. */
export const studioCanPull = (st: RoomState, viewer: Pick<Member, 'id' | 'role'>, pub: Pick<Member, 'id'>) => !inGreen(st, pub.id) || isBackstage(st, viewer);

/** The stage list one person gets: the green room is flagged for backstage people and left out for the audience. */
export function stageTiles<T extends { id: string }>(st: RoomState, me: Pick<Member, 'id' | 'role'>, tiles: T[]): (T & { green?: true })[] {
  const back = isBackstage(st, me);
  return tiles.filter((t) => back || !inGreen(st, t.id)).map((t) => (inGreen(st, t.id) ? { ...t, green: true as const } : t));
}

/**
 * A co-host joining, or a guest accepting an invite, waits in the green room when the room uses one (Funnel HQ's
 * setting, on by default; the Durable Object applies it before anyone joins). The audience never waits there.
 */
export function studioArrive(st: RoomState, m: Member, now: number) {
  const s = studioOf(st);
  if (!s || !s.on || !s.greenDefault || m.role === 'host') return;
  if (m.role !== 'cohost' && !m.stage) return;
  if (s.green[m.id]) return;
  if (m.role === 'cohost' && s.crew[m.id] === 'producer') return;
  // A co-host who was already brought on stage this session keeps their place when they reconnect.
  if (s.staged[m.id]) return;
  s.green[m.id] = { at: now, ready: false };
}

// ───────────── messages ─────────────

const fail = (error: string): ApplyResult => ({ ok: false, error, out: [], effects: [], changed: false });
const done = (o: Partial<ApplyResult> = {}): ApplyResult => ({ ok: true, out: [], effects: [], changed: true, ...o });
const merge = (list: ApplyResult[]): ApplyResult => ({
  ok: true, out: list.flatMap((r) => r.out), effects: list.flatMap((r) => r.effects), changed: list.some((r) => r.changed),
});
export type ApplyFn = (st: RoomState, actorId: string, raw: unknown, now: number) => ApplyResult;

export const CUES = ['push:application', 'push:deposit', 'push:sprint', 'push:vip', 'offer:open', 'offer:close', 'countdown:offer', 'poll', 'pin'] as const;

/** Every studio_* message. `apply` is state.ts's own (cues call the room's real engagement actions through it). */
export function studioApply(st: RoomState, me: Member, msg: Record<string, unknown>, now: number, apply: ApplyFn): ApplyResult {
  const s = studioOf(st);
  if (!s) return fail('not_applicable');
  const direct = canDirect(st, me);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN);
  const target = typeof msg.id === 'string' ? st.members[msg.id] ?? null : null;

  switch (msg.t) {
    case 'studio_scene': {
      if (!direct) return fail('forbidden');
      if (!SCENES.includes(msg.scene as Scene)) return fail('bad_value');
      if (msg.layout !== undefined && !MAIN_LAYOUTS.includes(msg.layout as MainLayout)) return fail('bad_value');
      if (msg.scene === 'slides' && !s.deck) return fail('no_deck');
      s.scene = msg.scene as Scene; s.sceneAt = now; s.sceneBy = me.id;
      if (msg.layout) s.layout = msg.layout as MainLayout;
      if (s.scene === 'slides' && s.deck) s.revealed[s.deck.id] = Math.max(s.revealed[s.deck.id] ?? -1, s.page);
      // The offer scene follows the real offer: its countdown appears with it when the offer has a close time.
      if (s.scene === 'offer' && st.offer.open && !s.countdown) s.countdown = { kind: 'offer' };
      return done();
    }
    case 'studio_layout': {
      if (!direct) return fail('forbidden');
      if (!MAIN_LAYOUTS.includes(msg.layout as MainLayout)) return fail('bad_value');
      s.layout = msg.layout as MainLayout;
      return done();
    }
    case 'studio_deck': {
      if (!direct) return fail('forbidden');
      if (msg.deck === null) { s.deck = null; s.page = 0; if (s.scene === 'slides') { s.scene = 'main'; s.sceneAt = now; } return done(); }
      const d = msg.deck as Record<string, unknown> | undefined;
      const id = d && typeof d.id === 'string' && /^dk[a-z0-9]{6,40}$/.test(d.id) ? d.id : null;
      const pages = Math.round(num(d?.pages));
      if (!id || !(pages >= 1 && pages <= LIMITS_STUDIO.deckPagesMax)) return fail('bad_value');
      const same = s.deck?.id === id;
      s.deck = { id, title: clean(d!.title, 120) || 'Slides', pages };
      if (!same) s.page = 0;
      s.page = Math.min(s.page, pages - 1);
      if (s.scene === 'slides') s.revealed[id] = Math.max(s.revealed[id] ?? -1, s.page);
      return done();
    }
    case 'studio_page': {
      if (!direct) return fail('forbidden');
      if (!s.deck) return fail('no_deck');
      const n = msg.delta !== undefined ? s.page + Math.round(num(msg.delta)) : Math.round(num(msg.n));
      if (!Number.isInteger(n)) return fail('bad_value');
      const page = Math.max(0, Math.min(s.deck.pages - 1, n));
      if (page === s.page) return done({ changed: false });
      s.page = page;
      if (s.scene === 'slides') s.revealed[s.deck.id] = Math.max(s.revealed[s.deck.id] ?? -1, page);
      return done();
    }
    case 'studio_slidecam': if (!direct) return fail('forbidden'); s.slideCam = msg.on !== false; return done();
    case 'studio_lower': {
      if (!direct) return fail('forbidden');
      if (typeof msg.name === 'string') s.lower.name = clean(msg.name, LIMITS_STUDIO.lowerMax);
      if (typeof msg.title === 'string') s.lower.title = clean(msg.title, LIMITS_STUDIO.lowerMax);
      if (typeof msg.on === 'boolean') s.lower.on = msg.on && Boolean(s.lower.name);
      return done();
    }
    case 'studio_logo': if (!direct) return fail('forbidden'); s.logo = msg.on === true; return done();
    case 'studio_ticker': {
      if (!direct) return fail('forbidden');
      if (typeof msg.text === 'string') s.ticker.text = clean(msg.text, LIMITS_STUDIO.tickerMax);
      s.ticker.on = msg.on === true && Boolean(s.ticker.text);
      return done();
    }
    case 'studio_highlight': {
      if (!direct) return fail('forbidden');
      if (msg.kind === null) { s.highlight = null; return done(); }
      const id = num(msg.mid);
      if (msg.kind === 'chat') {
        const m = st.chat.msgs.find((x) => x.id === id);
        if (!m) return fail('not_found');
        s.highlight = { kind: 'chat', id: m.id, name: firstName(m.name), text: m.text.slice(0, LIMITS_STUDIO.highlightMax), at: now };
      } else if (msg.kind === 'question') {
        const q = st.qa.find((x) => x.id === id);
        if (!q) return fail('not_found');
        s.highlight = { kind: 'question', id: q.id, name: firstName(q.name), text: q.text.slice(0, LIMITS_STUDIO.highlightMax), at: now };
      } else return fail('bad_value');
      return done();
    }
    case 'studio_countdown': {
      if (!direct) return fail('forbidden');
      if (msg.kind === null) { s.countdown = null; return done(); }
      if (msg.kind === 'offer') {
        // Only the real offer, with the close time the server holds.
        if (!st.offer.open || !st.offer.closesAt) return fail('offer_no_close');
        s.countdown = { kind: 'offer' };
        return done();
      }
      if (msg.kind === 'custom') {
        const sec = Math.round(num(msg.sec));
        if (!(sec >= 10 && sec <= LIMITS_STUDIO.countdownMaxSec)) return fail('bad_value');
        // The end is stamped here from the server's clock; anything the browser sends as a time is ignored.
        s.countdown = { kind: 'custom', endsAt: now + sec * 1000, label: clean(msg.label, 60) };
        return done();
      }
      return fail('bad_value');
    }
    case 'studio_brb': {
      if (!direct) return fail('forbidden');
      if (msg.sec === null) { s.brbEndsAt = null; return done(); }
      const sec = Math.round(num(msg.sec));
      if (!(sec >= 30 && sec <= 3600)) return fail('bad_value');
      s.brbEndsAt = now + sec * 1000;
      return done();
    }
    case 'studio_music': if (!direct) return fail('forbidden'); s.music = msg.on === true; return done();
    case 'studio_crew': {
      // Only the host makes or unmakes producers, and only of co-hosts.
      if (me.role !== 'host') return fail('forbidden');
      if (!target || target.role !== 'cohost') return fail('not_applicable');
      if (msg.producer === true) { s.crew[target.id] = 'producer'; delete s.green[target.id]; } else delete s.crew[target.id];
      return done({ out: [{ to: target.id, msg: { t: 'studio_role', producer: msg.producer === true, by: me.name } }] });
    }
    case 'studio_green': {
      if (!direct) return fail('forbidden');
      if (!target || target.role === 'host' || target.id === me.id) return fail('not_applicable');
      if (!(isStaffRole(target) || target.stage)) return fail('not_applicable');
      if (msg.on === true) { s.green[target.id] = s.green[target.id] ?? { at: now, ready: false }; delete s.staged[target.id]; if (st.spotlight === target.id) st.spotlight = null; }
      else { delete s.green[target.id]; s.staged[target.id] = true; }
      return done({ out: [{ to: target.id, msg: { t: msg.on === true ? 'studio_to_green' : 'studio_on_stage' } }] });
    }
    case 'studio_ready': {
      const g = s.green[me.id];
      if (!g) return fail('not_applicable');
      g.ready = msg.on !== false;
      return done();
    }
    case 'studio_back': {
      if (!isBackstage(st, me)) return fail('forbidden');
      const text = clean(msg.text, LIMITS_STUDIO.backMax);
      if (!text) return fail('empty');
      const m = { id: ++s.backSeq, by: me.id, name: me.name, text, at: now };
      s.back.push(m);
      if (s.back.length > LIMITS_STUDIO.backKeep) s.back.splice(0, s.back.length - LIMITS_STUDIO.backKeep);
      // Delivered to backstage people only, never to the audience.
      const to = Object.values(st.members).filter((x) => x.connected > 0 && isBackstage(st, x)).map((x) => x.id);
      return done({ changed: false, out: to.map((id) => ({ to: id, msg: { t: 'studio_back', m } })) });
    }
    case 'studio_section': {
      if (!direct) return fail('forbidden');
      const n = Math.round(num(msg.n));
      if (!(Number.isInteger(n) && n >= -1 && n < 200)) return fail('bad_value');
      s.ros.section = n;
      if (n >= 0 && s.ros.at[String(n)] == null) s.ros.at[String(n)] = now;
      return done();
    }
    case 'studio_cue': return cue(st, me, msg, now, apply);
    default: return fail('unknown_message');
  }
}

/**
 * One click on a cue: the room's own actions, run as if the host had pressed each button (same permission rules,
 * same effects: pushes are saved and counted, the offer opens through the live funnel, quizzes and polls record
 * answers). Scene changes ride along where the cue says so.
 */
function cue(st: RoomState, me: Member, msg: Record<string, unknown>, now: number, apply: ApplyFn): ApplyResult {
  if (!canDirect(st, me)) return fail('forbidden');
  const c = typeof msg.cue === 'string' ? msg.cue : '';
  const steps: Record<string, unknown>[] = [];
  const push = /^push:(application|deposit|sprint|vip)$/.exec(c);
  const quiz = /^quiz:([a-z0-9_]{1,40})$/.exec(c);
  const scene = /^scene:([a-z]+)$/.exec(c);
  const chapter = /^chapter:(\d{1,2})$/.exec(c);
  if (push) steps.push({ t: 'push', kind: push[1] });
  else if (c === 'offer:open') steps.push({ t: 'offer', open: true }, { t: 'studio_scene', scene: 'offer' });
  else if (c === 'offer:close') steps.push({ t: 'offer', open: false });
  else if (c === 'countdown:offer') steps.push({ t: 'studio_countdown', kind: 'offer' });
  else if (quiz) {
    const p = QUIZ_PRESETS.find((x) => x.id === quiz[1]);
    if (!p) return fail('not_found');
    steps.push({ t: 'quiz_new', question: p.question, options: p.options, correct: p.correct, explain: p.explain });
  } else if (c === 'poll') steps.push({ t: 'poll_new', question: msg.question, options: msg.options });
  else if (c === 'pin') {
    const text = clean(msg.text, 400);
    if (!text) return fail('empty');
    const r = apply(st, me.id, { t: 'chat', text }, now);
    if (!r.ok) return r;
    const pinned = apply(st, me.id, { t: 'pin', mid: st.chat.seq }, now);
    return merge([r, pinned]);
  } else if (scene) steps.push({ t: 'studio_scene', scene: scene[1] });
  else if (chapter) steps.push({ t: 'chapter', n: Number(chapter[1]) });
  else return fail('bad_value');
  const results: ApplyResult[] = [];
  for (const step of steps) {
    const r = apply(st, me.id, step, now);
    // The first step is the point of the cue: if the room refuses it, nothing else happens.
    if (!r.ok) { if (!results.length) return r; break; }
    results.push(r);
  }
  return merge(results);
}

// ───────────── what each person sees ─────────────

/** The countdown on screen, resolved to a real server time (the offer's close, or the host's timer). */
export function countdownView(st: RoomState, s: StudioState) {
  const c = s.countdown;
  if (!c) return null;
  if (c.kind === 'offer') return st.offer.open && st.offer.closesAt ? { kind: 'offer' as const, endsAt: st.offer.closesAt, label: STUDIO_COPY.offerCloses } : null;
  return { kind: 'custom' as const, endsAt: c.endsAt, label: c.label };
}

export function studioView(st: RoomState, me: Member) {
  const s = studioOf(st);
  if (!s) return null;
  const back = isBackstage(st, me);
  const direct = canDirect(st, me);
  const base = {
    on: s.on, scene: s.scene, layout: s.layout, sceneAt: s.sceneAt,
    deck: s.deck, page: s.page, slideCam: s.slideCam,
    lower: s.lower.on ? { name: s.lower.name, title: s.lower.title } : null,
    logo: s.logo, ticker: s.ticker.on ? s.ticker.text : null,
    highlight: s.highlight ? { kind: s.highlight.kind, name: s.highlight.name, text: s.highlight.text } : null,
    countdown: countdownView(st, s), brbEndsAt: s.brbEndsAt, music: s.music,
    me: { direct, producer: isProducer(st, me), green: inGreen(st, me.id), ready: s.green[me.id]?.ready ?? false },
  };
  if (!back) return base;
  return {
    ...base,
    lowerDraft: s.lower, tickerDraft: s.ticker.text, highlightId: s.highlight ? { kind: s.highlight.kind, id: s.highlight.id } : null, countdownKind: s.countdown?.kind ?? null,
    crew: Object.keys(s.crew),
    green: Object.entries(s.green).filter(([id]) => st.members[id]?.connected).map(([id, g]) => ({ id, name: st.members[id].name, role: st.members[id].role, ready: g.ready, at: g.at })),
    back: s.back.slice(-40),
    ros: s.ros, revealed: s.deck ? s.revealed[s.deck.id] ?? -1 : -1, greenDefault: s.greenDefault,
  };
}

// ───────────── slides: who may load which page ─────────────

/**
 * Staff load any page of any deck of this room (to rehearse and to see what's next). Everyone else loads pages of
 * the deck on stage that the stage has already shown, so nobody reads ahead of the presenter.
 */
export function canLoadSlide(st: RoomState, m: Pick<Member, 'id' | 'role'> | null | undefined, deckId: string, page: number) {
  if (!m || !Number.isInteger(page) || page < 0) return false;
  const s = peek(st);
  if (isStaffRole(m)) return true;
  if (!s || !s.on || st.status !== 'live') return false;
  const shown = s.revealed[deckId];
  return typeof shown === 'number' && page <= shown;
}

// ───────────── run of show (the Fladlien script, parsed by src/admin/materials.ts) ─────────────

export interface RosCue { label: string; cue: string | null; text?: string; preset?: string; question?: string; options?: string[] }
export interface RosSection { index: number; title: string; at: number; planned: number; paras: string[]; slides: string[]; cues: RosCue[]; notes: string[] }

/** A script's [HOST: …] line, as a one-click cue in our room (null cue: a reminder only). */
export function classifyHostCue(action: string): RosCue {
  const a = action.trim();
  if (/^OPEN OFFER$/i.test(a)) return { label: STUDIO_COPY.cueOpenOffer, cue: 'offer:open' };
  if (/^CLOSE OFFER$/i.test(a)) return { label: STUDIO_COPY.cueCloseOffer, cue: 'offer:close' };
  if (/^SHOW TIMER$/i.test(a)) return { label: STUDIO_COPY.cueCountdown, cue: 'countdown:offer' };
  if (/^TAKE QUESTIONS$/i.test(a)) return { label: STUDIO_COPY.cueQa, cue: 'scene:qa' };
  if (/^PUSH APPLICATION$/i.test(a)) return { label: STUDIO_COPY.cueApplication, cue: 'push:application' };
  if (/^PUSH DEPOSIT$/i.test(a)) return { label: STUDIO_COPY.cueDeposit, cue: 'push:deposit' };
  const quiz = /^QUIZ\s+([a-z0-9_]+)$/i.exec(a);
  if (quiz) return { label: `${STUDIO_COPY.cueQuiz}: ${quiz[1].toLowerCase()}`, cue: `quiz:${quiz[1].toLowerCase()}` };
  const poll = /^POLL\s+([A-Za-z0-9_]+)$/.exec(a);
  if (poll) return { label: `${STUDIO_COPY.cuePoll}: ${poll[1]}`, cue: 'poll', preset: poll[1] };
  const pin = /^PIN\s+([\s\S]+)$/.exec(a);
  if (pin) return { label: STUDIO_COPY.cuePin, cue: 'pin', text: pin[1].trim() };
  return { label: a, cue: null };
}

/** Sections with planned lengths (to the next section's mark, or the spoken words for the last one), words to read, and cues. */
export function runOfShow(m: Material): RosSection[] {
  const ch = m.chapters;
  return ch.map((c, i) => {
    const at = toSecs(c.at);
    const next = ch[i + 1] ? toSecs(ch[i + 1].at) : null;
    const planned = Math.max(30, Math.round(next != null && next > at ? next - at : c.minutes * 60));
    const paras: string[] = [], slides: string[] = [], cues: RosCue[] = [], notes: string[] = [];
    for (const b of c.blocks) {
      if (b.type === 'para') paras.push(b.text);
      else if (b.type === 'slide') slides.push(b.sub ? `${b.title} | ${b.sub}` : b.title);
      else if (b.type === 'host') cues.push(classifyHostCue(b.action));
      else if (b.type === 'note') notes.push(b.text);
    }
    return { index: i, title: c.title, at, planned, paras, slides, cues, notes };
  });
}
const toSecs = (mmss: string) => { const p = mmss.split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };

/** Which script a room reads from: the room's choice, else its live webinar or challenge day. */
export function scriptFor(room: { ref_type: string; ref_id: string | null }, chosen?: string | null) {
  if (chosen && /^[a-z0-9][a-z0-9-]{0,60}$/.test(chosen)) return chosen;
  if (room.ref_type === 'challenge') { const d = /:(\d)$/.exec(room.ref_id ?? '')?.[1]; if (d) return `challenge-day-${d}`; }
  return 'live-webinar';
}

// ───────────── Funnel HQ settings (rooms.studio JSON) ─────────────

export interface StudioSettings {
  on: boolean; scene: Scene; layout: MainLayout; greenRoom: boolean;
  colors: { bg: string; accent: string; text: string };
  logo: string | null; music: string | null; musicOn: boolean;
  introTitle: string; introNote: string; brbText: string; outroTitle: string; outroNote: string;
  lowerName: string; lowerTitle: string; ticker: string;
  offerHeading: string; offerPoints: string[];
  script: string | null;
}
export const DEFAULT_STUDIO: StudioSettings = {
  on: true, scene: 'intro', layout: 'solo', greenRoom: true,
  colors: { bg: '#0f2c5c', accent: '#c9a227', text: '#ffffff' },
  logo: null, music: null, musicOn: false,
  introTitle: '', introNote: '', brbText: '', outroTitle: '', outroNote: '',
  lowerName: '', lowerTitle: 'Founder, G&L M&A Advisory', ticker: '',
  offerHeading: '', offerPoints: [],
  script: null,
};
const HEX = /^#[0-9a-fA-F]{6}$/;
const ASSET = /^sa[a-z0-9]{6,40}$/;
/** Cleans what Funnel HQ sends (or what a template holds) into settings: unknown keys dropped, every string bounded. */
export function cleanStudioSettings(raw: unknown, base: StudioSettings = DEFAULT_STUDIO): StudioSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const col = (r.colors && typeof r.colors === 'object' ? r.colors : {}) as Record<string, unknown>;
  const str = (k: keyof StudioSettings, max: number) => (typeof r[k] === 'string' ? clean(r[k], max) : (base[k] as string));
  const asset = (k: 'logo' | 'music') => (r[k] === null || r[k] === '' ? null : typeof r[k] === 'string' && ASSET.test(r[k] as string) ? (r[k] as string) : base[k]);
  return {
    on: typeof r.on === 'boolean' ? r.on : base.on,
    scene: SCENES.includes(r.scene as Scene) ? (r.scene as Scene) : base.scene,
    layout: MAIN_LAYOUTS.includes(r.layout as MainLayout) ? (r.layout as MainLayout) : base.layout,
    greenRoom: typeof r.greenRoom === 'boolean' ? r.greenRoom : base.greenRoom,
    colors: {
      bg: typeof col.bg === 'string' && HEX.test(col.bg) ? col.bg : base.colors.bg,
      accent: typeof col.accent === 'string' && HEX.test(col.accent) ? col.accent : base.colors.accent,
      text: typeof col.text === 'string' && HEX.test(col.text) ? col.text : base.colors.text,
    },
    logo: asset('logo'), music: asset('music'), musicOn: typeof r.musicOn === 'boolean' ? r.musicOn : base.musicOn,
    introTitle: str('introTitle', 120), introNote: str('introNote', 200), brbText: str('brbText', 120), outroTitle: str('outroTitle', 120), outroNote: str('outroNote', 240),
    lowerName: str('lowerName', 60), lowerTitle: str('lowerTitle', 60), ticker: str('ticker', 160),
    offerHeading: str('offerHeading', 120),
    offerPoints: Array.isArray(r.offerPoints) ? r.offerPoints.map((x) => clean(x, 120)).filter(Boolean).slice(0, 5) : typeof r.offerPoints === 'string' ? r.offerPoints.split('\n').map((x) => clean(x, 120)).filter(Boolean).slice(0, 5) : base.offerPoints,
    script: r.script === null || r.script === '' ? null : typeof r.script === 'string' && /^[a-z0-9][a-z0-9-]{0,60}$/.test(r.script) ? r.script : base.script,
  };
}
export function parseStudioSettings(json: string | null | undefined): StudioSettings {
  if (!json) return { ...DEFAULT_STUDIO, colors: { ...DEFAULT_STUDIO.colors } };
  try { return cleanStudioSettings(JSON.parse(json)); } catch { return { ...DEFAULT_STUDIO, colors: { ...DEFAULT_STUDIO.colors } }; }
}
/** What the Durable Object needs (sent with every request, like the MoQ config). */
export function studioMeta(s: StudioSettings, enabled: boolean, hostName = ''): StudioDefaults {
  return { on: enabled && s.on, scene: s.scene, layout: s.layout, greenRoom: s.greenRoom, lowerName: s.lowerName || hostName, lowerTitle: s.lowerTitle, ticker: s.ticker, music: s.musicOn && Boolean(s.music) };
}

// ───────────── copy (checked by auditCopy in test/studio.test.ts) ─────────────

export const STUDIO_COPY = {
  tab: 'Studio',
  scenes: { intro: 'Intro', main: 'Main', slides: 'Slides', brb: 'Break', qa: 'Q&A', offer: 'Offer', outro: 'Outro' } as Record<Scene, string>,
  layouts: { solo: 'Solo', side: 'Side by side', speaker_screen: 'Speaker and screen', screen: 'Screen only', grid: 'Grid' } as Record<MainLayout, string>,
  scenesHeading: 'Scenes',
  layoutHeading: 'Layout',
  shortcuts: 'Keys 1 to 7 switch scenes. Shift with 1 to 5 picks the layout. Arrow keys move the slides. L shows the lower third, T the ticker.',
  onAir: 'On air',
  // the scenes, as the audience sees them
  introEyebrow: 'Starting soon',
  introStartsIn: 'Starts in',
  introStarting: 'Starting now',
  introWelcome: 'Welcome',
  brbHeading: 'Short break',
  brbBack: 'Back in',
  qaHeading: 'Your questions',
  qaEmpty: 'Ask in the Q&A tab. Josh answers them live.',
  offerHeadingDefault: 'The engagement is open',
  offerCta: 'Use the button under the video to secure your place.',
  offerClosed: 'The offer opens when Josh opens it.',
  offerCloses: 'Offer closes in',
  outroHeading: 'Thank you for being here',
  outroNote: 'Your room link shows the replay once it is ready.',
  fromChat: 'From the chat',
  fromQa: 'Question',
  slidesLoading: 'Loading the slide',
  sceneLabel: (a: string) => `Stage, ${a} scene`,
  // overlays
  overlaysHeading: 'Overlays',
  lowerThird: 'Lower third',
  lowerName: 'Name',
  lowerTitle: 'Title',
  show: 'Show',
  hide: 'Hide',
  logoBug: 'Logo',
  ticker: 'Ticker',
  tickerText: 'Ticker message',
  highlight: 'On screen',
  highlightClear: 'Take it off screen',
  showOnScreen: 'Show on screen',
  countdown: 'Countdown',
  countdownOffer: 'Offer close countdown',
  countdownCustom: 'Timer',
  countdownMinutes: 'Minutes',
  countdownLabel: 'Label',
  countdownStart: 'Start',
  countdownClear: 'Clear',
  brbTimer: 'Break timer',
  music: 'Intro music',
  musicNone: 'No intro music is uploaded. Add it in Funnel HQ, Rooms, Studio.',
  // slides
  slidesHeading: 'Slides',
  upload: 'Upload slides',
  uploadHelp: 'A PDF or images. Each page is rendered in this browser and stored for this room. Attendees only load pages the stage has shown.',
  uploading: (a: string, b: string) => `Uploading page ${a} of ${b}`,
  uploaded: 'Slides ready.',
  uploadFailed: 'The upload failed. Try again.',
  noStorage: 'Slide storage isn’t connected (R2 bucket RECORDINGS), so slides can’t be stored.',
  pdfFailed: 'This PDF couldn’t be read here. Export the slides as images and upload those.',
  pickDeck: 'Put on stage',
  noDecks: 'No slides uploaded for this room yet.',
  presenter: 'Presenter view',
  current: 'Now',
  next: 'Next',
  last: 'Last slide',
  notes: 'Notes',
  notesSave: 'Save notes',
  notesSaved: 'Notes saved.',
  onSlide: 'On this slide',
  sinceLive: 'Since Go live',
  prev: 'Previous',
  nextBtn: 'Next',
  slideCam: 'Camera on slides',
  close: 'Close',
  // run of show
  rosHeading: 'Run of show',
  rosNoScript: 'No script found for this room.',
  rosStart: 'Start this section',
  rosNext: 'Next section',
  planned: 'Planned',
  elapsed: 'Elapsed',
  over: 'over',
  under: 'left',
  prompter: 'Teleprompter',
  prompterMirror: 'Mirror',
  prompterBigger: 'Larger text',
  prompterSmaller: 'Smaller text',
  cues: 'Cues',
  cueApplication: 'Push the application now',
  cueDeposit: 'Push the deposit card',
  cueSprint: 'Push the Sprint card',
  cueOpenOffer: 'Open the offer',
  cueCloseOffer: 'Close the offer',
  cueCountdown: 'Show the offer countdown',
  cueQa: 'Switch to Q&A',
  cueQuiz: 'Launch quiz',
  cuePoll: 'Launch poll',
  cuePin: 'Pin in chat',
  cueDone: 'Done',
  cueNoPreset: 'This poll has no preset. Write it in the Poll tab.',
  // green room and crew
  greenHeading: 'Green room',
  greenEmpty: 'Nobody is waiting backstage.',
  greenYou: 'You are in the green room',
  greenYouBody: 'The audience can’t see or hear you yet. Check your mic, then tell the host you are ready.',
  greenMeter: 'Mic level',
  greenReady: 'I’m ready',
  greenNotReady: 'Not ready yet',
  greenChecked: 'Audio checked',
  greenWaiting: 'Checking audio',
  bringOn: 'Bring on stage',
  sendBack: 'Send to green room',
  toGreen: 'The host moved you to the green room. The audience can’t see or hear you.',
  onStageNow: 'You are on stage. The audience sees and hears you now.',
  backChat: 'Backstage chat',
  backChatPlaceholder: 'Message the team backstage',
  backChatNote: 'Only the host, co-hosts and the green room see this.',
  makeProducer: 'Make producer',
  unmakeProducer: 'Remove producer',
  producer: 'Producer',
  producerYou: 'You are a producer: you can switch scenes, push cards and run cues. Only the host can end the session.',
  producerOff: 'You are a co-host again.',
  // the host health strip
  hud: 'Health',
  hudSend: 'Sending',
  hudCpu: 'CPU',
  hudCpuNone: 'not reported',
  hudAudience: 'Audience',
  hudPaths: 'MoQ and SFU',
  hudMuted: 'You are muted. Your mic picks up speech, and nobody hears it.',
  hudUnmute: 'Turn mic on',
  hudLimited: (a: string) => `Your video is limited by ${a}.`,
  errors: {
    no_deck: 'Upload slides first.',
    offer_no_close: 'The offer has no close time yet. Open the offer first.',
    not_found: 'That item is gone.',
    forbidden: 'Only the host or a producer can do that.',
    not_applicable: 'That doesn’t apply here.',
    bad_value: 'That value isn’t allowed.',
  } as Record<string, string>,
};
