/**
 * Q&A that sells (pure: no I/O, so the tests drive it directly). qa-db.ts stores and reads what these rules decide,
 * audience-do.ts runs them inside the room's Durable Object (the co-host), and room-audience.js draws them.
 *
 *  - Objection types: every audience question and chat question is tagged price/value, time, trust/proof,
 *    fit ("will this work for me"), financing/risk, timing ("later"), logistics or other. Keyword rules first;
 *    the AI co-host re-tags it when the Anthropic key is set (it reads the question anyway to draft the answer).
 *    The team sees live counts per type (people who asked, each person once per question).
 *  - Answer and reopen the offer: one click sends the team's answer (labelled "Answered by the team", sent by the
 *    person who pressed it) and shows the offer card again, to the askers or to everyone, through the room's own
 *    push paths. reopenPlan() decides which card and who gets it.
 *  - Objection to purchase: per type, the people who raised it and how many of them bought afterwards (real counts).
 *  - Push analytics: each push (manual or automatic, the minute after Go live it went out) from shown to opened to
 *    started to paid, and across rooms the best minute per kind once a minute has enough people shown the card.
 *    A recommendation only: nothing here changes the automatic push schedule.
 */

import type { AutoPush, PushKind, RoomState } from './state';

// ───────────── objection types ─────────────

export const OBJECTION_TYPES = ['price', 'time', 'trust', 'fit', 'financing', 'timing', 'logistics', 'other'] as const;
export type ObjectionType = (typeof OBJECTION_TYPES)[number];
export const isObjectionType = (v: unknown): v is ObjectionType => typeof v === 'string' && (OBJECTION_TYPES as readonly string[]).includes(v);

/**
 * The keyword rules, most specific first: on a tie the earlier type wins (a payment plan is financing before it is
 * logistics; "how much" is price before it is time).
 */
export const OBJECTION_RULES: [Exclude<ObjectionType, 'other'>, RegExp][] = [
  ['financing', /\b(financ\w*|loans?|lenders?|banks?|debt|sba|credit score|collateral|personal guarantee|pg|seller (note|financ\w*)|rollover|payment plans?|instal+ments?|split (the )?pay\w*|pay (it )?monthly|monthly payments?|refunds?|money back|guarantee\w*|risk\w*|lose (my|the|it)|downside|worst case)\b/gi],
  ['price', /(\b(price|pricing|cost|costs|costing|how much|expensive|afford\w*|cheap\w*|worth it|worth the|value for|fees?|investment|too much|roi|return on)\b|\$\s?\d)/gi],
  ['trust', /\b(proof|results|testimonials?|reviews?|legit\w*|scams?|track record|case stud\w*|success (rate|stor\w+)|who else|clients have|credentials|real (people|clients|deals)|examples?|has anyone|evidence|trust\w*|actually work\w*)\b/gi],
  ['time', /\b(how (much time|many hours|long does it take|long will it take)|time commitment|hours (a|per) (week|day)|busy|bandwidth|full[- ]time|part[- ]time|time it takes|take (long|much time)|run my business at the same time|while i run|on top of my)\b/gi],
  ['fit', /\b(work for me|works? for (my|a|small|service)|my (industry|niche|business|situation|country|state|sector)|industr(y|ies)|niche|australia|aus|uk|canada|nz|new zealand|europe|my country|too small|small business|under \$?\d\w*|revenue (of|under|below)|beginners?|never (bought|done)|first time|no experience|service business|e-?commerce|agency|clinic|startup|does (this|it) (work|apply)|apply to me|in my case)\b/gi],
  ['timing', /\b(later|next (month|year|quarter|intake|cohort|round)|not (now|yet|ready)|wait\w*|think (about|it over)|sleep on|when is the next|another time|in a few months|down the track|someday|still (open|available)|closes? (when|tomorrow))\b/gi],
  ['logistics', /\b(zoom|link|log ?in|access|recording|replay|time ?zones?|start date|when does it start|schedule|calendar|onboarding|contract|signing|invoice|receipt|card|wire|bank transfer|paypal|currency|how (do|can) i (join|pay|sign up|start|get in)|where do i|portal|kick-?off|sessions? (are|is) (live|recorded))\b/gi],
];

/** The type of one question from the keyword rules: the type with the most hits, ties to the more specific type. */
export function classifyObjection(text: string): { type: ObjectionType; hits: number } {
  const t = String(text ?? '').replace(/[’‘]/g, "'");
  let best: ObjectionType = 'other', bestN = 0;
  for (const [type, re] of OBJECTION_RULES) {
    const n = (t.match(re) ?? []).length;
    if (n > bestN) { best = type; bestN = n; }
  }
  return { type: best, hits: bestN };
}

export type ObjectionCounts = Record<ObjectionType, number>;
export const emptyCounts = (): ObjectionCounts => Object.fromEntries(OBJECTION_TYPES.map((t) => [t, 0])) as ObjectionCounts;

/** The live tally the co-host keeps: one count per person per question, moved when the AI re-tags a question. */
export interface Tally { obj?: Partial<ObjectionCounts> }
export function tallyAdd(c: Tally, type: ObjectionType, n = 1) {
  const o = (c.obj ??= {});
  o[type] = Math.max(0, (o[type] ?? 0) + n);
}
export function tallyMove(c: Tally, from: ObjectionType, to: ObjectionType, n: number) {
  if (from === to || n <= 0) return;
  tallyAdd(c, from, -n);
  tallyAdd(c, to, n);
}
export const tallyView = (c: Tally): ObjectionCounts => ({ ...emptyCounts(), ...(c.obj ?? {}) });

// ───────────── answer and reopen the offer ─────────────

export type ReopenScope = 'askers' | 'all';
export type ReopenPlan =
  | { ok: false; error: 'reopen_none' | 'reopen_away' }
  | {
    ok: true;
    kind: 'deposit' | 'sprint';
    /** Cards already open that reach these people: their browsers show that card again. */
    show: { pid: number; to: string[] | 'all' }[];
    /** People an open card for selected people should be widened to (no new card). */
    widen: { pid: number; add: string[] } | null;
    /** A new push from the room's own push path: to these people, or everyone. */
    push: { to: string[] | null } | null;
  };

/** Which offer card to show again: the deposit while the offer is open, else the Sprint card; the host may pick one. */
export function reopenKind(st: Pick<RoomState, 'offer' | 'eng'>, want?: unknown): 'deposit' | 'sprint' | null {
  const av = st.eng?.avail;
  if (!av) return null;
  const depositOk = av.deposit && st.offer.open;
  if (want === 'deposit') return depositOk ? 'deposit' : null;
  if (want === 'sprint') return av.sprint ? 'sprint' : null;
  return depositOk ? 'deposit' : av.sprint ? 'sprint' : null;
}

/**
 * Who sees the offer card again, and how, using only the room's existing pushes:
 *  - everyone: an open card for the whole room is shown again; else a new push for the room.
 *  - the askers still in the room: an open card that reaches them is shown again; the rest join an open card for
 *    selected people, else get a new card of their own (the same rules the hot list's push uses).
 */
export function reopenPlan(st: Pick<RoomState, 'offer' | 'eng' | 'members'>, askers: string[], scope: ReopenScope, want?: unknown): ReopenPlan {
  const kind = reopenKind(st, want);
  if (!kind) return { ok: false, error: 'reopen_none' };
  const open = (st.eng?.pushes ?? []).filter((p) => p.open && p.kind === kind && p.ref === null);
  if (scope === 'all') {
    const room = open.find((p) => !p.to);
    return room ? { ok: true, kind, show: [{ pid: room.id, to: 'all' }], widen: null, push: null } : { ok: true, kind, show: [], widen: null, push: { to: null } };
  }
  const here = [...new Set(askers)].filter((id) => { const m = st.members[id]; return m && m.connected > 0 && m.role !== 'host' && m.role !== 'cohost'; });
  if (!here.length) return { ok: false, error: 'reopen_away' };
  const show = new Map<number, string[]>();
  const rest: string[] = [];
  for (const id of here) {
    const p = open.find((x) => !x.to || x.to.includes(id));
    if (p) show.set(p.id, [...(show.get(p.id) ?? []), id]); else rest.push(id);
  }
  const shared = open.find((p) => p.to);
  return {
    ok: true, kind,
    show: [...show.entries()].map(([pid, to]) => ({ pid, to })),
    widen: rest.length && shared ? { pid: shared.id, add: rest } : null,
    push: rest.length && !shared ? { to: rest } : null,
  };
}

// ───────────── objection to purchase ─────────────

export interface ObjectionRow { room_id: string; who: string; lead_id: string | null; qtype: string; at: number; answered_at: number | null; reopened_at: number | null }
export interface Outcome { type: ObjectionType; people: number; bought: number; notBought: number; answered: number; reopened: number; boughtAfterReopen: number }
/** How long after an objection a purchase still counts as following it. */
export const BUY_WINDOW_MS = 14 * 86_400_000;

/**
 * Per objection type: the people who raised it (one per person per room), how many bought afterwards (a paid deposit
 * or Sprint within BUY_WINDOW_MS of the first time they raised it) and how many didn't. People who had already paid
 * before they raised it count in neither column. `paidAt(room, who, lead)` returns their purchase times.
 */
export function objectionOutcomes(rows: ObjectionRow[], paidAt: (room: string, who: string, lead: string | null) => number[]): { types: Outcome[]; people: number; bought: number } {
  const per = new Map<string, { room: string; who: string; lead: string | null; type: ObjectionType; at: number; answered: boolean; reopened: boolean }>();
  for (const r of rows) {
    const type = isObjectionType(r.qtype) ? r.qtype : 'other';
    const k = `${r.room_id}|${r.who}|${type}`;
    const x = per.get(k);
    if (!x) per.set(k, { room: r.room_id, who: r.who, lead: r.lead_id, type, at: r.at, answered: r.answered_at != null, reopened: r.reopened_at != null });
    else { x.at = Math.min(x.at, r.at); x.answered ||= r.answered_at != null; x.reopened ||= r.reopened_at != null; x.lead ??= r.lead_id; }
  }
  const out = new Map<ObjectionType, Outcome>(OBJECTION_TYPES.map((t) => [t, { type: t, people: 0, bought: 0, notBought: 0, answered: 0, reopened: 0, boughtAfterReopen: 0 }]));
  const everyone = new Map<string, boolean>();
  for (const x of per.values()) {
    const times = paidAt(x.room, x.who, x.lead);
    if (times.some((t) => t < x.at)) continue; // bought before they asked: not an objection before buying
    const bought = times.some((t) => t >= x.at && t - x.at <= BUY_WINDOW_MS);
    const o = out.get(x.type)!;
    o.people++;
    if (bought) o.bought++; else o.notBought++;
    if (x.answered) o.answered++;
    if (x.reopened) { o.reopened++; if (bought) o.boughtAfterReopen++; }
    const pk = `${x.room}|${x.who}`;
    everyone.set(pk, (everyone.get(pk) ?? false) || bought);
  }
  const types = [...out.values()].filter((o) => o.people > 0).sort((a, b) => b.people - a.people || OBJECTION_TYPES.indexOf(a.type) - OBJECTION_TYPES.indexOf(b.type));
  return { types, people: everyone.size, bought: [...everyone.values()].filter(Boolean).length };
}

// ───────────── push analytics ─────────────

export interface PushRow { room_id: string; id: number; kind: string; ref: string | null; created_by: string | null; created_at: number; targets: string | null; went_live_at: number | null; closed_at?: number | null }
export interface PushEventCount { room_id: string; push_id: number; event: string; n: number }
export const FUNNEL = ['shown', 'opened', 'started', 'submitted', 'paid'] as const;
export type FunnelStep = (typeof FUNNEL)[number];
export interface PushPerf {
  room: string; id: number; kind: string; ref: string | null; mode: 'auto' | 'manual'; at: number;
  /** Minutes after Go live it went out (null: before Go live, or the room never went live). */
  minute: number | null;
  targeted: boolean;
  counts: Record<FunnelStep, number>;
  /** Each step as a share of shown (null while nobody was shown it). */
  rates: Record<Exclude<FunnelStep, 'shown'>, number | null>;
}
/** The step that counts as the push working: the application is submitted, a resource opened, everything else paid. */
export const goalOf = (kind: string): FunnelStep => (kind === 'application' ? 'submitted' : kind === 'resource' ? 'opened' : 'paid');

export function pushPerformance(pushes: PushRow[], events: PushEventCount[]): PushPerf[] {
  const ev = new Map<string, Record<string, number>>();
  for (const e of events) { const k = `${e.room_id}|${e.push_id}`; const m = ev.get(k) ?? {}; m[e.event] = (m[e.event] ?? 0) + Number(e.n || 0); ev.set(k, m); }
  return pushes.map((p) => {
    const m = ev.get(`${p.room_id}|${p.id}`) ?? {};
    const counts = Object.fromEntries(FUNNEL.map((f) => [f, m[f] ?? 0])) as Record<FunnelStep, number>;
    const rate = (n: number) => (counts.shown ? n / counts.shown : null);
    const minute = p.went_live_at != null && p.created_at >= p.went_live_at ? Math.floor((p.created_at - p.went_live_at) / 60_000) : null;
    return {
      room: p.room_id, id: p.id, kind: p.kind, ref: p.ref, mode: p.created_by === 'auto' ? 'auto' : 'manual', at: p.created_at, minute,
      targeted: p.targets != null,
      counts, rates: { opened: rate(counts.opened), started: rate(counts.started), submitted: rate(counts.submitted), paid: rate(counts.paid) },
    };
  });
}

export const MIN_SHOWN = 20;
export const MINUTE_BUCKET = 5;
export interface MinuteStat { from: number; to: number; shown: number; goal: number; rate: number; pushes: number; auto: number; manual: number }
export interface BestMinute {
  kind: string; goal: FunnelStep;
  best: MinuteStat | null;
  /** The minutes the schedule sends this kind at. */
  scheduled: number[];
  /** The scheduled minute's own window, when it has data. */
  scheduledStat: MinuteStat | null;
  /** The window with the most people shown so far (when no window has enough data yet). */
  biggest: MinuteStat | null;
  verdict: 'no_data' | 'not_enough' | 'schedule_best' | 'better_window' | 'not_scheduled';
}

/**
 * Across rooms: per kind, five-minute windows after Go live, each window's goal rate (paid, submitted or opened, as
 * a share of the people shown the card), and the best window among those with at least `minShown` people shown.
 * Only pushes to the whole room count (a card sent to one person after a question is a different moment).
 */
export function bestMinutes(perf: PushPerf[], schedule: AutoPush[], o: { minShown?: number; bucket?: number } = {}): BestMinute[] {
  const minShown = o.minShown ?? MIN_SHOWN, size = o.bucket ?? MINUTE_BUCKET;
  const kinds = [...new Set([...perf.map((p) => p.kind), ...schedule.map((s) => s.kind)])].filter((k) => k !== 'resource').sort((a, b) => PUSH_ORDER.indexOf(a as PushKind) - PUSH_ORDER.indexOf(b as PushKind));
  return kinds.map((kind) => {
    const goal = goalOf(kind);
    const win = new Map<number, MinuteStat>();
    for (const p of perf) {
      if (p.kind !== kind || p.minute == null || p.targeted) continue;
      const from = Math.floor(p.minute / size) * size;
      const s = win.get(from) ?? { from, to: from + size - 1, shown: 0, goal: 0, rate: 0, pushes: 0, auto: 0, manual: 0 };
      s.shown += p.counts.shown; s.goal += p.counts[goal]; s.pushes++; s[p.mode]++;
      win.set(from, s);
    }
    for (const s of win.values()) s.rate = s.shown ? s.goal / s.shown : 0;
    const all = [...win.values()];
    const ok = all.filter((s) => s.shown >= minShown).sort((a, b) => b.rate - a.rate || b.shown - a.shown || a.from - b.from);
    const scheduled = schedule.filter((s) => s.kind === kind).map((s) => s.at);
    const windowOf = (m: number) => Math.floor(m / size) * size;
    const scheduledStat = scheduled.length ? win.get(windowOf(scheduled[0])) ?? null : null;
    const best = ok[0] ?? null;
    const biggest = [...all].sort((a, b) => b.shown - a.shown)[0] ?? null;
    const verdict: BestMinute['verdict'] = !all.length ? 'no_data' : !best ? 'not_enough' : !scheduled.length ? 'not_scheduled' : scheduled.some((m) => windowOf(m) === best.from) ? 'schedule_best' : 'better_window';
    return { kind, goal, best, scheduled, scheduledStat, biggest, verdict };
  });
}
const PUSH_ORDER: PushKind[] = ['application', 'sprint', 'deposit', 'vip', 'resource'];

const pct = (r: number) => `${Math.round(r * 100)}%`;
const KIND_NAMES: Record<string, string> = { application: 'The application', sprint: 'The Sprint card', deposit: 'The deposit card', vip: 'The VIP card' };
const GOAL_NAMES: Record<string, string> = { paid: 'paid', submitted: 'applied', opened: 'opened it' };

/** One plain sentence per kind for Funnel HQ. Every number is a count of real rows; the schedule is never changed. */
export function recommendationText(b: BestMinute, minShown = MIN_SHOWN): string {
  const name = KIND_NAMES[b.kind] ?? b.kind, g = GOAL_NAMES[b.goal] ?? b.goal;
  const at = (s: MinuteStat) => `minutes ${s.from} to ${s.to}`;
  const stat = (s: MinuteStat) => `${s.goal} of ${s.shown} shown ${g} (${pct(s.rate)})`;
  const sched = b.scheduled.length ? `minute ${b.scheduled.join(' and ')}` : '';
  switch (b.verdict) {
    case 'no_data': return `${name}: no pushes after Go live yet.`;
    case 'not_enough': return `${name}: not enough data yet. A window needs ${minShown} people shown the card; the largest so far is ${at(b.biggest!)} with ${b.biggest!.shown}.`;
    case 'schedule_best': return `${name}: ${at(b.best!)} converts best, ${stat(b.best!)}. Your schedule already sends it at ${sched}.`;
    case 'not_scheduled': return `${name}: ${at(b.best!)} converts best, ${stat(b.best!)}. It isn't on the automatic schedule; add it there if you want it sent at that time.`;
    case 'better_window': return `${name}: ${at(b.best!)} converts best, ${stat(b.best!)}. Your schedule sends it at ${sched}${b.scheduledStat ? `, where ${stat(b.scheduledStat)}` : ''}. Consider moving it; the schedule only changes when you edit it.`;
  }
}

// ───────────── copy (checked by auditCopy in test/qa-sells.test.ts) ─────────────

export const QA_COPY = {
  types: {
    price: 'Price and value', time: 'Time it takes', trust: 'Trust and proof', fit: 'Will it work for me',
    financing: 'Financing and risk', timing: 'Timing, later', logistics: 'Logistics', other: 'Other',
  } as Record<ObjectionType, string>,
  countsHeading: 'Objections in the questions',
  countsIntro: 'Each question is tagged by type, from keyword rules and, with the Anthropic key, the AI co-host. Counts are people who asked.',
  countsEmpty: 'No questions tagged yet.',
  tagAi: 'tagged by AI',
  tagRules: 'tagged by keywords',
  reopenThem: 'Answer them and reopen the offer',
  reopenAll: 'Answer the room and reopen the offer',
  reopenHint: 'Sends your answer labelled “Answered by the team”, then shows the offer card again.',
  reopenDone: 'Answered. The offer card is on their screen again.',
  reopenDoneAll: 'Answered. The offer card is on everyone’s screen again.',
  errors: {
    reopen_none: 'No offer card to show: open the offer or make the Sprint available first. Send the answer on its own instead.',
    reopen_away: 'Nobody who asked is in the room now. Send the answer to the room instead.',
  } as Record<string, string>,
};
