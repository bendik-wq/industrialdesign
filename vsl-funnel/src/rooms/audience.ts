/**
 * Audience experience in our webinar rooms (area C, pure: no I/O, so the tests drive it directly).
 * audience-db.ts stores what these rules decide, audience-do.ts runs them inside the room's Durable Object,
 * captions.ts turns the host's audio into captions, and public/assets/room-audience.js draws them.
 *
 *  - Reactions: tap-to-react, rate-limited per person and aggregated per second, so a thousand people send the
 *    room one message a second instead of a thousand. The host sees the pulse over time.
 *  - The AI co-host (staff only): repeated questions clustered, answers drafted from our knowledge base for a
 *    person to send with one click ("Answered by the team"), buying signals flagged privately with first names.
 *  - Social proof: purchase and application announcements only for buyers who ticked the consent box, first name
 *    and city only, rate-limited, behind the host's per-room switch. Every announcement is a real event.
 *  - Personal offer moments: the offer card echoes the attendee's own Deal Plan and application back to them.
 *  - The abandoned-checkout nudge: once per person and payment, only when the checkout really is unpaid.
 */

import { type PlanData, coverage, firstName } from './engage';
import { type ObjectionType, type Tally, QA_COPY, classifyObjection, tallyAdd } from './qa'; // qa-sells: objection types

// ───────────── reactions ─────────────

export const REACTION_KINDS = ['clap', 'heart', 'idea', 'yes', 'question'] as const;
export type ReactionKind = (typeof REACTION_KINDS)[number];
export const RX_LIMITS = {
  /** Minimum gap between two taps from one person. */
  minGapMs: 250,
  /** Most reactions one person can add inside one window. */
  perWindow: 8,
  windowMs: 5_000,
  /** How often the room sends the totals. */
  flushMs: 1_000,
  /** The host's pulse: buckets of this size, this many kept. */
  pulseBucketMs: 10_000,
  pulseKeep: 360,
};
export type RxCounts = Partial<Record<ReactionKind, number>>;
export interface PulseBucket { at: number; n: number; k: RxCounts }

/**
 * Reactions for one room: add() decides whether a tap counts (the per-person limits), flush() empties the
 * current second into one message and the pulse. Plain data, so the Durable Object can keep it in memory.
 */
export class ReactionAgg {
  private last = new Map<string, number>();
  private win = new Map<string, { start: number; n: number }>();
  private pending: RxCounts = {};
  private pendingN = 0;
  pulse: PulseBucket[] = [];

  /** `n`: taps the browser batched into one message (at most 4); only what fits the person's window counts. */
  add(who: string, kind: unknown, now: number, n = 1): { ok: true; n: number } | { ok: false; error: 'bad_value' | 'too_fast' | 'rx_limit' } {
    if (!REACTION_KINDS.includes(kind as ReactionKind)) return { ok: false, error: 'bad_value' };
    const prev = this.last.get(who);
    if (prev !== undefined && now - prev < RX_LIMITS.minGapMs) return { ok: false, error: 'too_fast' };
    let w = this.win.get(who);
    if (!w || now - w.start >= RX_LIMITS.windowMs) { w = { start: now, n: 0 }; this.win.set(who, w); }
    if (w.n >= RX_LIMITS.perWindow) return { ok: false, error: 'rx_limit' };
    const take = Math.min(Math.max(1, Math.floor(Number(n)) || 1), 4, RX_LIMITS.perWindow - w.n);
    w.n += take;
    this.last.set(who, now);
    const k = kind as ReactionKind;
    this.pending[k] = (this.pending[k] ?? 0) + take;
    this.pendingN += take;
    return { ok: true, n: take };
  }
  get waiting() { return this.pendingN; }

  /** The totals since the last flush (null when nobody reacted), added to the pulse. */
  flush(now: number): { counts: RxCounts; n: number } | null {
    if (!this.pendingN) return null;
    const counts = this.pending, n = this.pendingN;
    this.pending = {}; this.pendingN = 0;
    const at = Math.floor(now / RX_LIMITS.pulseBucketMs) * RX_LIMITS.pulseBucketMs;
    let b = this.pulse[this.pulse.length - 1];
    if (!b || b.at !== at) { b = { at, n: 0, k: {} }; this.pulse.push(b); }
    b.n += n;
    for (const [k, v] of Object.entries(counts) as [ReactionKind, number][]) b.k[k] = (b.k[k] ?? 0) + v;
    if (this.pulse.length > RX_LIMITS.pulseKeep) this.pulse.splice(0, this.pulse.length - RX_LIMITS.pulseKeep);
    // Forget people who stopped reacting (keeps memory flat in a big room).
    if (this.last.size > 2000) for (const [id, t] of this.last) if (now - t > RX_LIMITS.windowMs) { this.last.delete(id); this.win.delete(id); }
    return { counts, n };
  }
  /** The pulse for the host: the last `n` buckets, gaps filled with zero. */
  series(now: number, n = 36): PulseBucket[] {
    const end = Math.floor(now / RX_LIMITS.pulseBucketMs) * RX_LIMITS.pulseBucketMs;
    const by = new Map(this.pulse.map((b) => [b.at, b]));
    const out: PulseBucket[] = [];
    for (let i = n - 1; i >= 0; i--) { const at = end - i * RX_LIMITS.pulseBucketMs; out.push(by.get(at) ?? { at, n: 0, k: {} }); }
    return out;
  }
  /** Per-minute totals for the database (room_reaction_pulse). */
  minutes(): { minute: number; n: number; k: RxCounts }[] {
    const m = new Map<number, { n: number; k: RxCounts }>();
    for (const b of this.pulse) {
      const key = Math.floor(b.at / 60_000);
      const x = m.get(key) ?? { n: 0, k: {} };
      x.n += b.n;
      for (const [k, v] of Object.entries(b.k) as [ReactionKind, number][]) x.k[k] = (x.k[k] ?? 0) + v;
      m.set(key, x);
    }
    return [...m.entries()].map(([minute, x]) => ({ minute, ...x }));
  }
}

// ───────────── the AI co-host: questions, clusters, buying signals ─────────────

const STOP = new Set('the and for are but not you your with this that from have has was were will what when where which who how why can could would should about into than then them they their there here our out all any its also just get got does did been more most some such only own same very too off over again once each few both other a an of to in on is it be as at by or if so do no up we i me my am im josh team'.split(' '));
export const qTerms = (s: string) => [...new Set((s.toLowerCase().normalize('NFKD').match(/[a-z0-9$.]+/g) ?? []).map((w) => w.replace(/\.+$/, '').replace(/(ing|ed|es|s)$/, '')).filter((w) => w.length >= 3 && !STOP.has(w)))];

/** A chat line that reads as a question (a question mark, or a question word up front). */
export function isQuestion(text: string) {
  const t = text.trim();
  if (t.length < 10) return false;
  return /\?\s*$/.test(t) || /^(how|what|when|where|why|who|which|can|could|do|does|did|is|are|should|will|would|has|have)\b/i.test(t);
}

export type SignalKind = 'price' | 'start' | 'pay' | 'ready' | 'mention' | 'prebuy' | 'ai';
export const SIGNAL_RULES: [SignalKind, RegExp][] = [
  ['price', /\b(how much|price|pricing|cost|costs|fee|fees|what does it cost|investment)\b/i],
  ['start', /\b(how (do|can) i (start|join|sign up|get started|apply|enrol|enroll)|where do i (sign|start|join|pay)|get started|sign me up|next step|how to join)\b/i],
  ['pay', /\b(can i pay|pay (by|with|in|monthly)|payment plan|instal+ments?|split (the )?payment|invoice|credit card|deposit|refund)\b/i],
  ['ready', /\b(i'?m in|count me in|ready to (start|go|buy|join)|let'?s do (it|this)|where'?s the link|send (me )?the link|take my money|sign me)\b/i],
];
/** Buying signals in one message (rules; the AI sweep in audience-do.ts adds what the rules miss). */
export function buyingSignals(text: string): SignalKind[] {
  const t = text.replace(/[’‘]/g, "'");
  return SIGNAL_RULES.filter(([, re]) => re.test(t)).map(([k]) => k);
}
/** "@host", "@josh", "@team" (or "@cohost") in a chat line. */
export const mentionsHost = (text: string) => /(^|\s)@(host|josh|team|co-?host)\b/i.test(text);

export interface Asker { who: string; first: string }
export interface QueueItem {
  id: number;
  kind: 'question' | 'prebuy' | 'mention';
  text: string;
  askers: Asker[];
  /** Where it came from: chat message ids and Q&A question ids (so an answer can mark them answered). */
  chatIds: number[];
  qaIds: number[];
  at: number;
  lastAt: number;
  status: 'open' | 'sent' | 'dismissed';
  draft: { text: string; sources: string[]; by: 'rules' | 'ai'; confidence: number | null; at: number } | null;
  terms: string[];
  /** qa-sells: the objection type (keyword rules, re-tagged by the AI co-host) and who tagged it. */
  qtype?: ObjectionType;
  qby?: 'rules' | 'ai';
}
export interface HotEntry { who: string; first: string; signals: SignalKind[]; text: string; at: number; count: number }

/** Jaccard similarity of two term lists. */
export function similarity(a: string[], b: string[]) {
  if (!a.length || !b.length) return 0;
  const B = new Set(b);
  const inter = a.filter((x) => B.has(x)).length;
  return inter / (a.length + b.length - inter);
}
export const CLUSTER_AT = 0.5;
export const QUEUE_KEEP = 120;

export interface CohostState extends Tally { queue: QueueItem[]; seq: number; hot: HotEntry[] }
export const newCohost = (): CohostState => ({ queue: [], seq: 0, hot: [] });

/**
 * Adds a question to the queue: joins the open item it repeats (same kind, similar words), else a new item.
 * Returns the item and whether it is new (new items get a draft).
 */
export function enqueue(c: CohostState, x: { kind: QueueItem['kind']; text: string; who: string; name: string; chatId?: number; qaId?: number }, now: number) {
  const terms = qTerms(x.text);
  const first = firstName(x.name) || 'Someone';
  let best: QueueItem | null = null, bestSim = 0;
  if (x.kind !== 'mention') {
    for (const q of c.queue) {
      if (q.status !== 'open' || q.kind === 'mention') continue;
      const s = similarity(terms, q.terms);
      if (s > bestSim) { best = q; bestSim = s; }
    }
  }
  if (best && bestSim >= CLUSTER_AT) {
    if (!best.askers.some((a) => a.who === x.who)) { best.askers.push({ who: x.who, first }); tallyAdd(c, best.qtype ?? 'other'); }
    if (x.chatId) best.chatIds.push(x.chatId);
    if (x.qaId) best.qaIds.push(x.qaId);
    // A question asked before buying outranks the rest of its cluster.
    if (x.kind === 'prebuy') best.kind = 'prebuy';
    best.lastAt = now;
    return { item: best, fresh: false };
  }
  const item: QueueItem = {
    id: ++c.seq, kind: x.kind, text: x.text.slice(0, 400), askers: [{ who: x.who, first }], chatIds: x.chatId ? [x.chatId] : [], qaIds: x.qaId ? [x.qaId] : [],
    at: now, lastAt: now, status: 'open', draft: null, terms,
  };
  if (x.kind !== 'mention') { item.qtype = classifyObjection(x.text).type; item.qby = 'rules'; tallyAdd(c, item.qtype); }
  c.queue.push(item);
  if (c.queue.length > QUEUE_KEEP) {
    const drop = c.queue.findIndex((q) => q.status !== 'open');
    c.queue.splice(drop >= 0 ? drop : 0, 1);
  }
  return { item, fresh: true };
}

/** Flags one message's buying signals on the hot list (one row per person; the newest message and every signal kept). */
export function flagHot(c: CohostState, x: { who: string; name: string; text: string; signals: SignalKind[] }, now: number) {
  if (!x.signals.length) return null;
  const first = firstName(x.name) || 'Someone';
  let h = c.hot.find((e) => e.who === x.who);
  if (!h) { h = { who: x.who, first, signals: [], text: '', at: now, count: 0 }; c.hot.push(h); }
  h.signals = [...new Set([...h.signals, ...x.signals])];
  h.text = x.text.slice(0, 240); h.at = now; h.count++;
  if (c.hot.length > 200) c.hot.splice(0, c.hot.length - 200);
  return h;
}

/** The queue as staff see it: open items first (pre-purchase, then most askers, then oldest), then the rest. */
export function queueView(c: CohostState) {
  const rank = (q: QueueItem) => (q.status === 'open' ? 0 : 1);
  return [...c.queue].sort((a, b) => rank(a) - rank(b) || Number(b.kind === 'prebuy') - Number(a.kind === 'prebuy') || b.askers.length - a.askers.length || a.at - b.at)
    .slice(0, 60).map((q) => ({ id: q.id, kind: q.kind, text: q.text, count: q.askers.length, names: q.askers.slice(0, 6).map((a) => a.first), status: q.status, at: q.at, draft: q.draft, qtype: q.qtype ?? null, qby: q.qby ?? null }));
}
export const hotView = (c: CohostState) => [...c.hot].sort((a, b) => b.at - a.at).slice(0, 40).map((h) => ({ who: h.who, first: h.first, signals: h.signals, text: h.text, at: h.at, count: h.count }));

/** A draft from the knowledge base without a model: the passage's sentences that share the most words with the question. */
export function rulesDraft(question: string, passages: { title: string; text: string }[]) {
  const q = new Set(qTerms(question));
  // Only what an attendee may read: never the team's internal scripts and decks (their stage directions included).
  const top = passages.find((p) => !(p as { internal?: boolean }).internal);
  if (!top || !q.size) return null;
  const sentences = top.text.replace(/\[[^\]]{0,120}\]/g, ' ').replace(/\s+/g, ' ').split(/(?<=[.?])\s+(?=[A-Z$0-9])/).map((s) => s.trim()).filter((s) => s.length > 20 && s.length < 400);
  const scored = sentences.map((s, i) => ({ s, i, n: qTerms(s).filter((w) => q.has(w)).length })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n || a.i - b.i).slice(0, 2).sort((a, b) => a.i - b.i);
  if (!scored.length) return null;
  return { text: scored.map((x) => x.s).join(' ').replace(/—/g, ', ').slice(0, 600), sources: [top.title] };
}

// ───────────── social proof (consent first) ─────────────

export type ProofKind = 'deposit' | 'sprint' | 'application';
export const PROOF_GAP_MS = 90_000;
/** An announcement that waited longer than this is dropped: "just" has to be true. */
export const PROOF_STALE_MS = 5 * 60_000;
export interface Consent { first_name: string | null; city: string | null; show_city: number; consent_at: number; withdrawn_at: number | null }

/** The sentence for one real event, or null when there is no consent (or no usable first name). */
export function proofText(kind: ProofKind, c: Consent | null | undefined) {
  if (!c || c.withdrawn_at || !c.consent_at) return null;
  const first = firstName(c.first_name ?? '');
  if (!first) return null;
  const city = c.show_city && c.city ? cleanCity(c.city) : '';
  const who = city ? `${first} from ${city}` : first;
  return AUDIENCE_COPY.proof[kind].replace('{a}', who);
}
export const cleanCity = (s: string) => s.replace(/[^\p{L}\p{M}' .-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40);
/** The preview the consent box shows ("Sam from Perth"), so the buyer sees exactly what the room would see. */
export function proofPreview(first: string | null | undefined, city: string | null | undefined, showCity: boolean) {
  const f = firstName(first ?? '');
  if (!f) return null;
  const c = showCity && city ? cleanCity(city) : '';
  return c ? `${f} from ${c}` : f;
}

/**
 * The room's announcement queue: one at a time, at least `gapMs` apart, nothing older than PROOF_STALE_MS.
 * next() returns what to say now (or null) and when to look again.
 */
export class ProofQueue {
  items: { text: string; at: number }[] = [];
  lastAt = 0;
  constructor(public gapMs = PROOF_GAP_MS) {}
  push(text: string, now: number) { if (this.items.length < 10) this.items.push({ text, at: now }); }
  next(now: number): { text: string | null; wait: number | null } {
    this.items = this.items.filter((x) => now - x.at <= PROOF_STALE_MS);
    if (!this.items.length) return { text: null, wait: null };
    const ready = this.lastAt + this.gapMs;
    if (now < ready) return { text: null, wait: ready - now };
    const it = this.items.shift()!;
    this.lastAt = now;
    return { text: it.text, wait: this.items.length ? this.gapMs : null };
  }
}

// ───────────── personal offer moments ─────────────

export interface PersonalInput {
  plan: PlanData | null;
  app: { business?: string | null; revenueLabel?: string | null; whyNow?: string | null; submitted: boolean } | null;
}
const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
/** Lines echoing the attendee's own answers back on the offer card. Only what they really entered. */
export function personalLines(x: PersonalInput): { key: string; label: string; text: string }[] {
  const out: { key: string; label: string; text: string }[] = [];
  const C = AUDIENCE_COPY.personal;
  const p = x.plan;
  if (p) {
    const box = [p.industry, p.size, p.geography].filter(Boolean).join(', ');
    if (box) out.push({ key: 'buybox', label: C.buyBox, text: box });
    const cov = coverage(p);
    if (cov) out.push({ key: 'coverage', label: C.coverage, text: cov.passes ? C.passes(cov.ratio.toFixed(2)) : C.fails(cov.ratio.toFixed(2), money(cov.maxDebtService)) });
    if (p.owners_per_week) out.push({ key: 'outreach', label: C.outreach, text: C.owners(p.owners_per_week) });
    const first = [p.action_1].filter(Boolean)[0];
    if (first) out.push({ key: 'action', label: C.firstAction, text: first });
  }
  if (x.app) {
    const biz = [x.app.business, x.app.revenueLabel].filter(Boolean).join(', ');
    if (biz) out.push({ key: 'business', label: C.business, text: biz });
    if (x.app.whyNow) out.push({ key: 'why', label: C.whyNow, text: x.app.whyNow.length > 160 ? `${x.app.whyNow.slice(0, 157).replace(/\s+\S*$/, '')}…` : x.app.whyNow });
  }
  return out;
}

// ───────────── the abandoned-checkout nudge ─────────────

export const NUDGE_DEFAULT_MIN = 10;
export interface CheckoutRow { who: string; kind: 'deposit' | 'sprint'; lead_id: string | null; started_at: number; nudged_at: number | null }
/** Rows whose checkout started `minutes` ago or more, never nudged, from someone still here who hasn't paid. */
export function dueNudges(rows: CheckoutRow[], o: { now: number; minutes: number; here: Set<string>; paid: (row: CheckoutRow) => boolean }) {
  return rows.filter((r) => r.nudged_at == null && o.now - r.started_at >= o.minutes * 60_000 && o.here.has(r.who) && !o.paid(r));
}

// ───────────── settings (area C) ─────────────

type S = Partial<Record<string, string>>;
const on = (v: string | undefined, dflt: boolean) => (v && v.trim() ? /^(1|true|yes|on)$/i.test(v.trim()) : dflt);
export const DEFAULT_CAPTION_LANGS = ['es', 'fr', 'de', 'it', 'pt', 'zh', 'ja', 'ko', 'hi', 'ar', 'vi'];
export function audienceConfig(s: S) {
  const langs = String(s.ROOM_CAPTION_LANGS ?? '').split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter((x) => /^[a-z]{2}$/.test(x));
  const gap = Number(s.ROOM_PROOF_GAP_SEC);
  const nudge = Number(s.ROOM_CHECKOUT_NUDGE_MIN);
  return {
    reactions: on(s.ROOM_REACTIONS, true),
    captions: on(s.ROOM_CAPTIONS, true),
    langs: langs.length ? [...new Set(langs)].slice(0, 20) : DEFAULT_CAPTION_LANGS,
    proofDefault: on(s.ROOM_PROOF, false),
    proofGapMs: Number.isFinite(gap) && gap >= 20 ? Math.min(3600, gap) * 1000 : PROOF_GAP_MS,
    nudgeMin: String(s.ROOM_CHECKOUT_NUDGE_MIN ?? '').trim().toLowerCase() === 'off' ? 0 : Number.isFinite(nudge) && nudge >= 2 ? Math.min(120, nudge) : NUDGE_DEFAULT_MIN,
    cohostAuto: on(s.ROOM_COHOST_AUTO, false),
    model: String(s.ROOM_COHOST_MODEL ?? '').trim() || null,
  };
}

// ───────────── copy (checked by auditCopy in test/audience.test.ts) ─────────────

export const AUDIENCE_COPY = {
  // qa-sells: objection types, the counts and "answer and reopen the offer" (src/rooms/qa.ts)
  qa: QA_COPY,
  reactions: { clap: 'Applause', heart: 'Love it', idea: 'Useful', yes: 'Agree', question: 'Question' } as Record<ReactionKind, string>,
  react: 'React',
  rxLimit: 'One moment. Your reactions are on their way.',
  // captions
  cc: 'Captions',
  ccOn: 'Captions on',
  ccOff: 'Captions off',
  ccMachine: 'Captions are machine-generated and can contain mistakes.',
  ccNotice: 'Live captions are on. The host’s audio is transcribed by machine and kept as the session transcript.',
  ccWaiting: 'Captions appear when the host speaks.',
  ccNone: 'The host hasn’t turned on live captions.',
  ccLanguage: 'Caption language',
  ccOriginal: 'As spoken',
  ccTranslated: 'Machine translation',
  ccHostStart: 'Start live captions',
  ccHostStop: 'Stop live captions',
  ccHostNote: 'Your microphone is transcribed in short pieces while captions are on. Everyone in the room sees a notice that captions are machine-generated and kept.',
  ccHostNoMic: 'Turn your microphone on to caption it.',
  ccHostLive: 'Captioning your microphone',
  ccHostError: 'Captions paused: the speech service didn’t answer. They resume on the next sentence.',
  // co-host (staff only)
  cohostTab: 'Co-host',
  cohostHeading: 'Questions from the room',
  cohostIntro: 'Repeated questions are grouped. Each draft comes from our own guides and offer terms; a person sends it.',
  cohostNoKey: 'No Anthropic key: drafts are the closest passage from our knowledge base, and buying signals come from keyword rules.',
  cohostEmpty: 'No questions yet.',
  cohostAsked: (n: number) => `${n} people asked`,
  cohostAskedOne: '1 person asked',
  draftAi: 'AI draft',
  draftKb: 'knowledge base',
  cohostPrebuy: 'Asked before buying',
  cohostMention: 'Mentioned the host',
  cohostDraft: 'Draft',
  cohostDrafting: 'Drafting…',
  cohostNoDraft: 'Nothing in the knowledge base answers this. Write the answer yourself.',
  cohostSources: 'From',
  cohostSend: 'Send to the room',
  cohostSendPrivate: 'Send to them only',
  cohostDismiss: 'Dismiss',
  cohostSent: 'Sent',
  cohostAuto: 'Automatic answers are on: confident drafts on simple questions go out labelled as automatic.',
  hotHeading: 'Buying signals',
  hotIntro: 'Private to the team. First names only.',
  hotEmpty: 'No buying signals yet.',
  signals: { price: 'Asked the price', start: 'Asked how to start', pay: 'Asked about paying', ready: 'Said they are ready', mention: 'Mentioned the host', prebuy: 'Asked a question before buying', ai: 'Reads as ready to buy (AI)' } as Record<SignalKind, string>,
  pulseHeading: 'Reactions',
  pulseNone: 'No reactions yet.',
  pulsePerMin: (n: number) => `${n} in the last minute`,
  proofHeading: 'Purchase announcements',
  proofBody: 'Announce real purchases and applications to the room, only for buyers who agreed, with first name and city only, at most one every few minutes.',
  proofOn: 'Announcements on',
  proofOff: 'Announcements off',
  // labels the room shows
  teamAnswer: 'Answered by the team',
  autoAnswer: 'Automatic answer from the team’s assistant (AI)',
  privateAnswer: 'The team answered your question',
  // social proof
  proof: {
    deposit: '{a} just secured an engagement place.',
    sprint: '{a} just joined the First Deal Sprint.',
    application: '{a} just sent an application.',
  } as Record<ProofKind, string>,
  consentLabel: 'When I go ahead, the room can see it, as {a}.',
  consentCity: 'Show my city',
  consentHelp: 'Optional. Only your first name and city, once. Untick it any time before you pay.',
  consentSaved: 'Saved.',
  // personal offer moments
  personal: {
    heading: 'Built on your answers',
    buyBox: 'Your buy box',
    coverage: 'Your 1.5x test',
    passes: (r: string) => `${r}x on the numbers you entered, which passes.`,
    fails: (r: string, max: string) => `${r}x on the numbers you entered. Payments up to ${max} a year pass at that cash flow.`,
    outreach: 'Your outreach',
    owners: (n: string) => `${n} owners a week`,
    firstAction: 'Your first action',
    business: 'Your business',
    whyNow: 'Why now, in your words',
    deadline: 'This offer closes',
    empty: 'Fill in your Deal Plan and this card shows your own buy box and 1.5x test.',
  },
  askFirst: 'Ask a question before you buy',
  askHeading: 'Ask the team before you buy',
  askBody: 'Your question goes straight to the team in the room. The answer comes back here, to you only.',
  askPlaceholder: 'Your question',
  askSend: 'Send my question',
  askSent: 'Sent. The team answers here shortly.',
  askTooShort: 'Write a little more so the team can answer.',
  nudgeHeading: 'Your checkout is still open',
  nudgeBody: 'Finish it in the payment tab, or ask the team a question first.',
  nudgeFinish: 'Open the offer',
  // attention
  awayHeading: 'While you were away',
  awayChapter: (t: string) => `Now on: ${t}`,
  awaySaid: 'What was said',
  awayOffer: 'The offer opened while you were away.',
  awayCards: (n: number) => `${n} new cards are waiting for you.`,
  awayCardsOne: 'A new card is waiting for you.',
  awayNothing: 'You missed nothing new.',
  awayBack: 'Back to the session',
  pip: 'Keep watching in a small window',
  pipOff: 'Back to the room',
  pipUnsupported: 'This browser can’t open a floating window. The room keeps playing in this tab.',
  mini: 'Mini player',
  // view settings and accessibility
  viewHeading: 'View',
  contrast: 'High contrast',
  fontSize: 'Text size',
  fontSizes: ['Standard', 'Large', 'Largest'],
  haptics: 'Vibrate on key moments',
  shortcuts: 'Keyboard shortcuts',
  shortcutList: [
    ['C', 'Captions on or off'],
    ['1 to 5', 'React'],
    ['P', 'Floating window'],
    ['H', 'Raise or lower your hand'],
    ['O', 'Open the offer'],
    ['V', 'View settings'],
    ['?', 'These shortcuts'],
  ] as [string, string][],
  srPush: (t: string) => `New for you: ${t}`,
  srOfferOpen: 'The offer is open.',
  srOfferClosed: 'The offer has closed.',
  srOfferCloses: (t: string) => `It closes ${t}.`,
  pushTitles: { application: 'the application', sprint: 'the First Deal Sprint', deposit: 'the engagement deposit', vip: 'the VIP upgrade', resource: 'a resource from Josh' } as Record<string, string>,
  reply: 'Reply',
  replyTo: (name: string) => `Replying to ${name}`,
  cancelReply: 'Cancel reply',
  close: 'Close',
  errors: {
    rx_limit: 'One moment. Your reactions are on their way.',
    cap_off: 'Live captions are off for this room.',
    not_found: 'That question is gone.',
    empty: 'Write a little more so the team can answer.',
  } as Record<string, string>,
};
