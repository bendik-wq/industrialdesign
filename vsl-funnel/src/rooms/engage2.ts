/**
 * Engagement, round 2 (pure: no I/O, so the tests drive it directly). engage2-db.ts gathers the inputs and stores
 * what these rules decide; engage2-do.ts runs them inside the room's Durable Object.
 *
 *  - The engagement score (0 to 100) per attendee, from real signals already in the room: minutes present, on
 *    time, polls and knowledge checks answered, questions asked, Deal Plan steps, reactions (capped), pushed
 *    cards opened, the application, a checkout started, and how long the room's tab was in view (beacons from
 *    their browser, bounded by the server's clock). Each signal has a weight (its most points) and the amount
 *    that earns all of it; ROOM_SCORE_WEIGHTS overrides them ("checkout:15, minutes:20/45"). A signal with no
 *    data (no tab beacons from an old browser) is left out of the total instead of counting against them.
 *  - Buying signals: a checkout started, the offer opened twice or more, a question about the price.
 *  - The hot list for the host: ranked by score and buying signals, with the plain reasons for each person.
 *  - The live-only bonus: one per room, shown from minute one, withdrawn by the server when the room's real offer
 *    window closes or when the session ends (the owner picks), and never switched back on in that room.
 */

import { buyingSignals } from './audience';
import { assetById, firstName } from './engage';

// ───────────── the signals and the score ─────────────

export interface Signals {
  minutes: number;
  onTime: boolean;
  polls: number;
  quizzes: number;
  questions: number;
  planSteps: number;
  reactions: number;
  /** Pushed cards they opened (distinct cards). */
  opened: number;
  /** Times they opened the offer (the deposit or Sprint sheet), from their browser, at most one count per 10 seconds. */
  offerOpens: number;
  applied: boolean;
  checkout: ('deposit' | 'sprint')[];
  /** Milliseconds the room's tab was in view and away, while live (null = no beacons from their browser). */
  focusMs: number | null;
  awayMs: number | null;
  /** They asked about the price (in chat or the Q&A). */
  price: boolean;
  bought: boolean;
}
export const emptySignals = (): Signals => ({
  minutes: 0, onTime: false, polls: 0, quizzes: 0, questions: 0, planSteps: 0, reactions: 0, opened: 0, offerOpens: 0,
  applied: false, checkout: [], focusMs: null, awayMs: null, price: false, bought: false,
});

export type WeightKey = 'minutes' | 'on_time' | 'answers' | 'questions' | 'plan' | 'reactions' | 'opened' | 'application' | 'checkout' | 'focus';
/** max = the most points the signal gives; full = how much of it earns all of them. The defaults add up to 100. */
export interface Weight { max: number; full: number }
export type Weights = Record<WeightKey, Weight>;
export const DEFAULT_WEIGHTS: Weights = {
  minutes: { max: 20, full: 60 },     // an hour in the room
  on_time: { max: 5, full: 1 },
  answers: { max: 12, full: 4 },      // polls and knowledge checks answered
  questions: { max: 8, full: 2 },
  plan: { max: 12, full: 4 },         // the four Deal Plan steps
  reactions: { max: 3, full: 10 },    // capped: tapping is cheap
  opened: { max: 9, full: 3 },
  application: { max: 12, full: 1 },
  checkout: { max: 12, full: 1 },
  focus: { max: 7, full: 1 },         // the share of live time the tab was in view
};
export const WEIGHT_KEYS = Object.keys(DEFAULT_WEIGHTS) as WeightKey[];
/** Focus needs this much beacon time before it counts (a few seconds says nothing). */
export const FOCUS_MIN_MS = 2 * 60_000;

/** "checkout:15, minutes:20/45" → the defaults with those overrides (unknown keys and silly values are ignored). */
export function parseWeights(raw: string | null | undefined): Weights {
  const out: Weights = JSON.parse(JSON.stringify(DEFAULT_WEIGHTS));
  for (const part of String(raw ?? '').split(/[,;\n]+/)) {
    const m = /^\s*([a-z_]+)\s*:\s*(\d{1,3})(?:\s*\/\s*(\d{1,4}))?\s*$/i.exec(part);
    if (!m || !(m[1].toLowerCase() in out)) continue;
    const w = out[m[1].toLowerCase() as WeightKey];
    w.max = Math.min(100, Number(m[2]));
    if (m[3] && Number(m[3]) > 0) w.full = Math.min(1000, Number(m[3]));
  }
  return out;
}

/** How much of each signal they have (0..1), or null when there is no data for it. */
function shares(s: Signals, w: Weights): Record<WeightKey, number | null> {
  const r = (n: number, k: WeightKey) => Math.max(0, Math.min(1, n / w[k].full));
  const seen = (s.focusMs ?? 0) + (s.awayMs ?? 0);
  return {
    minutes: r(s.minutes, 'minutes'),
    on_time: s.onTime ? 1 : 0,
    answers: r(s.polls + s.quizzes, 'answers'),
    questions: r(s.questions, 'questions'),
    plan: r(s.planSteps, 'plan'),
    reactions: r(s.reactions, 'reactions'),
    opened: r(Math.max(s.opened, s.offerOpens), 'opened'),
    application: s.applied ? 1 : 0,
    checkout: s.checkout.length ? 1 : 0,
    focus: s.focusMs == null || seen < FOCUS_MIN_MS ? null : Math.max(0, Math.min(1, (s.focusMs ?? 0) / seen)),
  };
}

/** The score (0..100, rounded) and each signal's points. Signals without data are left out of the total. */
export function scoreOf(s: Signals, w: Weights = DEFAULT_WEIGHTS) {
  const sh = shares(s, w);
  let got = 0, possible = 0;
  const parts = {} as Record<WeightKey, number>;
  for (const k of WEIGHT_KEYS) {
    if (sh[k] == null || w[k].max <= 0) continue;
    possible += w[k].max;
    parts[k] = Math.round(sh[k]! * w[k].max * 10) / 10;
    got += sh[k]! * w[k].max;
  }
  return { score: possible > 0 ? Math.max(0, Math.min(100, Math.round((got / possible) * 100))) : 0, parts };
}

export type BuyKind = 'checkout' | 'offer_twice' | 'price';
export const BUY_KINDS: BuyKind[] = ['checkout', 'offer_twice', 'price'];
export function buyingOf(s: Signals): BuyKind[] {
  const out: BuyKind[] = [];
  if (s.checkout.length) out.push('checkout');
  if (s.offerOpens >= 2) out.push('offer_twice');
  if (s.price) out.push('price');
  return out;
}
/** A chat line or question that asks about the price (area C's buying-signal rules). */
export const asksPrice = (text: string) => buyingSignals(text).some((k) => k === 'price' || k === 'pay');

/** The plain reasons, strongest first (buying signals, then what they did). */
export function whyOf(s: Signals, max = 4): string[] {
  const c = E2_COPY.why;
  const out: string[] = [];
  if (s.checkout.includes('deposit')) out.push(c.checkoutDeposit);
  if (s.checkout.includes('sprint')) out.push(c.checkoutSprint);
  if (s.offerOpens >= 2) out.push(c.offerOpens(s.offerOpens));
  if (s.price) out.push(c.price);
  if (s.applied) out.push(c.applied);
  if (s.planSteps) out.push(c.plan(s.planSteps));
  if (s.questions) out.push(c.questions(s.questions));
  if (s.minutes >= 10) out.push(c.minutes(s.minutes));
  if (s.polls + s.quizzes) out.push(c.answers(s.polls + s.quizzes));
  if (s.focusMs != null && s.awayMs != null && s.focusMs + s.awayMs >= FOCUS_MIN_MS) out.push(c.focus(Math.round((s.focusMs / (s.focusMs + s.awayMs)) * 100)));
  return out.slice(0, max);
}

// ───────────── the hot list ─────────────

export interface ScoredPerson {
  who: string; name: string; leadId: string | null; score: number; buying: BuyKind[]; why: string[]; bought: boolean;
  online: boolean; applied: boolean; consent: boolean;
}
/** Included at this score even without a buying signal. ROOM_HOT_MIN overrides. */
export const HOT_MIN = 50;
export const HOT_SHOW = 15;
/** Buying signals count for 20 points each in the ranking (the score itself is unchanged). */
export const rankOf = (p: Pick<ScoredPerson, 'score' | 'buying'>) => p.score + 20 * p.buying.length;
/** The ranked list: buyers left out, then anyone with a buying signal or a score at the line. */
export function hotList(people: ScoredPerson[], o: { min?: number; n?: number } = {}) {
  const min = o.min ?? HOT_MIN;
  return people.filter((p) => !p.bought && (p.buying.length > 0 || p.score >= min))
    .sort((a, b) => rankOf(b) - rankOf(a) || b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, o.n ?? HOT_SHOW);
}
/** What the host's browser gets for one row: the first name to mention only with their consent. */
export function hotRow(p: ScoredPerson) {
  return { id: p.who, name: p.name, score: p.score, buying: p.buying, why: p.why, online: p.online, applied: p.applied, mention: p.consent ? firstName(p.name) || null : null };
}

// ───────────── the live-only bonus ─────────────

export type BonusUntil = 'offer' | 'end';
export interface Bonus { text: string; asset: string | null; until: BonusUntil; onAt: number; withdrawnAt: number | null; withdrawnReason: string | null }
export interface BonusRoom { status: 'lobby' | 'live' | 'ended' | 'scheduled' | 'cancelled'; endedAt: number | null }
export interface BonusOffer { available: boolean; open: boolean; closesAt: number | null }

const cleanText = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '');
export function cleanBonus(raw: { text?: unknown; asset?: unknown; until?: unknown }) {
  const text = cleanText(raw.text, 280);
  if (text.length < 8) return null;
  const asset = typeof raw.asset === 'string' && assetById(raw.asset) ? raw.asset : null;
  const until: BonusUntil = raw.until === 'end' ? 'end' : 'offer';
  return { text, asset, until };
}

/**
 * Whether the bonus is withdrawn now, and why. Offer mode: when the room's real offer window has closed (it was
 * seen open and is now closed, or its close time passed), or the session ended without the offer ever opening.
 * A room with no offer follows the session. End mode: when the session ends. Once withdrawn, always withdrawn.
 */
export function bonusDue(b: Bonus, room: BonusRoom, offer: BonusOffer, now: number, seenOpen = false): { withdraw: boolean; reason: 'offer_closed' | 'ended' | null } {
  if (b.withdrawnAt != null) return { withdraw: false, reason: null };
  const ended = room.status === 'ended' || room.status === 'cancelled';
  if (b.until === 'end' || !offer.available) return ended ? { withdraw: true, reason: 'ended' } : { withdraw: false, reason: null };
  if (offer.open) return { withdraw: false, reason: null };
  if ((offer.closesAt != null && offer.closesAt <= now) || seenOpen) return { withdraw: true, reason: 'offer_closed' };
  if (ended) return { withdraw: true, reason: 'ended' };
  return { withdraw: false, reason: null };
}
/** Whether a purchase at `at` was made while the bonus was live. */
export const boughtWhileLive = (b: Pick<Bonus, 'onAt' | 'withdrawnAt'>, at: number) => at >= b.onAt && (b.withdrawnAt == null || at < b.withdrawnAt);

/** What attendees see (and staff, with the settings). */
export function bonusView(b: Bonus | null, offer: BonusOffer, o: { staff?: boolean; mine?: boolean } = {}) {
  if (!b) return null;
  const live = b.withdrawnAt == null;
  const a = b.asset ? assetById(b.asset) : null;
  const c = E2_COPY.bonus;
  const untilLine = !live ? c.ended : b.until === 'offer' && offer.available ? (offer.open && offer.closesAt ? c.untilOfferAt : c.untilOffer) : c.untilEnd;
  return {
    live, text: b.text, asset: a ? a.title : null, until: b.until, closesAt: live && b.until === 'offer' && offer.open ? offer.closesAt : null,
    line: untilLine, mine: Boolean(o.mine),
    ...(o.staff ? { assetId: b.asset, onAt: b.onAt, withdrawnAt: b.withdrawnAt, reason: b.withdrawnReason } : {}),
  };
}

// ───────────── the room's copy (checked by auditCopy in the tests) ─────────────

export const E2_COPY = {
  hotHeading: 'Hot list',
  hotIntro: 'Private to the team. Ranked by engagement score and buying signals from this session.',
  hotEmpty: 'Nobody is showing buying signals yet. People appear here once they engage or open the offer.',
  hotBought: (n: number) => `Bought in this session: ${n}`,
  score: (n: number) => `Score ${n}`,
  offline: 'Left the room',
  buying: { checkout: 'Started checkout', offer_twice: 'Opened the offer twice', price: 'Asked the price' } as Record<BuyKind, string>,
  why: {
    checkoutDeposit: 'Started the deposit checkout',
    checkoutSprint: 'Started the Sprint checkout',
    offerOpens: (n: number) => `Opened the offer ${n} times`,
    price: 'Asked about the price',
    applied: 'Sent the application',
    plan: (n: number) => `${n} of 4 Deal Plan steps`,
    questions: (n: number) => (n === 1 ? 'Asked a question' : `Asked ${n} questions`),
    minutes: (n: number) => `${n} minutes in the room`,
    answers: (n: number) => (n === 1 ? 'Answered a poll or check' : `Answered ${n} polls and checks`),
    focus: (n: number) => `Room in view ${n}% of the time`,
  },
  pushSprint: 'Push the Sprint card',
  pushApp: 'Push the application',
  mention: 'Mention in chat',
  mentionNote: 'Mention appears only for people who opted in to showing their first name.',
  pushed: (name: string) => `Sent to ${name}.`,
  alreadyOpen: 'That card is already open for them.',
  bonus: {
    eyebrow: 'Live-only bonus',
    untilOffer: 'For anyone who goes ahead while the offer from this session is open.',
    untilOfferAt: 'For anyone who goes ahead before the offer closes.',
    untilEnd: 'For anyone who goes ahead before this session ends.',
    ended: 'The live-only bonus from this session has ended.',
    mine: 'This bonus is yours with your purchase.',
    includes: 'Includes:',
    closesIn: 'Offer closes in',
  },
  bonusHeading: 'Live-only bonus',
  bonusIntro: 'Pinned for attendees from the start. The server withdraws it when you choose, and buyers while it is live get it on their purchase.',
  bonusText: 'The bonus, in one or two sentences',
  bonusAsset: 'Unlock with it (optional)',
  bonusNone: 'No file',
  bonusUntil: 'Withdraw it when',
  bonusUntilOffer: 'The offer window closes',
  bonusUntilEnd: 'The session ends',
  bonusSave: 'Save the bonus',
  bonusWithdraw: 'Withdraw it now',
  bonusLocked: 'The session is live, so the bonus stays as announced. You can withdraw it.',
  bonusWithdrawn: 'Withdrawn. It stays off for this room.',
  bonusGrants: (n: number) => `Buyers who received it: ${n}`,
  errors: {
    bonus_text: 'Write the bonus in at least a few words.',
    bonus_copy: 'The bonus text breaks a copy rule (no exclamation marks, emojis, hedges or promised results).',
    bonus_withdrawn: 'The bonus was withdrawn and stays off for this room.',
    bonus_live: 'The session is live: the bonus stays as announced.',
    already_open: 'That card is already open for them.',
    not_in_room: 'They are not in the room.',
  } as Record<string, string>,
};

/** The line for the Command proposal and the AI call (team-facing, plain). */
export function leadLine(score: number, why: string[]) {
  return `Engagement score in the live room: ${score} of 100${why.length ? ` (${why.join('; ')})` : ''}.`;
}
