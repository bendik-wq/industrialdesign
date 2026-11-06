import { APP_REVENUE_BAND } from '../sales/qualify';
import { dealMath } from '../webinar/experience';
import { type ArchetypeId, type GapId, type QuestionId, QUESTIONS } from './content';

/**
 * Acquisition readiness: a deterministic score out of 100, an archetype and the two gaps to close first, from the
 * ten quiz answers. Every weight is here in the open (RESULT_COPY.howText says the same in words). Pure: no I/O.
 */

export type Answers = Partial<Record<QuestionId, string>>;

/** Points per answer. Each factor's max adds to 100; industry and the blocker carry no points. */
export const WEIGHTS: Record<Exclude<QuestionId, 'industry' | 'blocker'>, { max: number; gap: GapId; points: Record<string, number> }> = {
  revenue: { max: 20, gap: 'scale', points: { lt1m: 4, '1_3m': 12, '3_10m': 16, '10_25m': 20, '25_50m': 20, '50_100m': 20, gt100m: 20 } },
  team: { max: 15, gap: 'owner', points: { yes: 15, partly: 8, no: 2 } },
  margin: { max: 12, gap: 'margin', points: { lt10: 3, '10_20': 8, '20_30': 11, gt30: 12, unsure: 4 } },
  deals: { max: 12, gap: 'plan', points: { '0': 3, '1': 9, '2': 12 } },
  funding: { max: 12, gap: 'structure', points: { structure: 12, bank: 8, cash: 6, unsure: 2 } },
  debt: { max: 10, gap: 'funding', points: { use: 10, open: 8, wary: 4, never: 0 } },
  timeline: { max: 10, gap: 'plan', points: { '90d': 10, '6_12': 7, exploring: 3 } },
  goal: { max: 9, gap: 'deal_flow', points: { competitor: 9, group: 9, supply: 8, exit: 6, unsure: 2 } },
};

/** The blocker they named points at a gap, and that gap comes first (it is what they told us stops them). */
export const BLOCKER_GAP: Record<string, GapId> = { finding: 'deal_flow', funding: 'funding', credibility: 'credibility', structuring: 'structure', time: 'owner' };
const BLOCKER_BOOST = 1.01; // more than any shortfall (at most 1), so the named gap always leads
/** Tie-break order (and the fallback when nothing is missing): the gaps the masterclass spends longest on first. */
const GAP_ORDER: GapId[] = ['structure', 'funding', 'deal_flow', 'plan', 'margin', 'owner', 'credibility', 'scale'];

const VALID: Record<string, Set<string>> = Object.fromEntries(QUESTIONS.map((q) => [q.id, new Set(q.options.map((o) => o.value))]));
/** A known option for that question, else null. */
export const validAnswer = (q: string, v: unknown): string | null => (typeof v === 'string' && VALID[q]?.has(v) ? v : null);
/** Only known questions with known options; anything else is dropped. */
export function cleanAnswers(raw: unknown): Answers {
  const out: Answers = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const q of QUESTIONS) { const v = validAnswer(q.id, (raw as Record<string, unknown>)[q.id]); if (v) out[q.id] = v; }
  return out;
}
export const missingAnswers = (a: Answers) => QUESTIONS.filter((q) => !a[q.id]).map((q) => q.id);

export interface Factor { id: string; max: number; points: number }

export function readinessScore(a: Answers): { score: number; factors: Factor[] } {
  const factors = Object.entries(WEIGHTS).map(([id, w]) => {
    const v = a[id as QuestionId];
    const points = v != null ? w.points[v] ?? 0 : 0;
    return { id, max: w.max, points: Math.max(0, Math.min(w.max, points)) };
  });
  const score = Math.max(0, Math.min(100, Math.round(factors.reduce((t, f) => t + f.points, 0))));
  return { score, factors };
}

/** The two gaps: the blocker they named first, then the largest share of points missed, ties in GAP_ORDER. */
export function topGaps(a: Answers, factors = readinessScore(a).factors): GapId[] {
  const weight = new Map<GapId, number>();
  for (const f of factors) {
    const gap = WEIGHTS[f.id as keyof typeof WEIGHTS].gap;
    const short = (f.max - f.points) / f.max;
    if (short > 0) weight.set(gap, Math.max(weight.get(gap) ?? 0, short));
  }
  const named = a.blocker ? BLOCKER_GAP[a.blocker] : undefined;
  if (named) weight.set(named, (weight.get(named) ?? 0) + BLOCKER_BOOST);
  const ranked = [...weight.entries()].filter(([, w]) => w > 0).sort((x, y) => y[1] - x[1] || GAP_ORDER.indexOf(x[0]) - GAP_ORDER.indexOf(y[0])).map(([g]) => g);
  for (const g of GAP_ORDER) if (ranked.length < 2 && !ranked.includes(g)) ranked.push(g);
  return ranked.slice(0, 2);
}

/**
 * The archetype, first rule that matches:
 *  1. under $1M revenue → foundation;
 *  2. wants to exit at a higher multiple → exit_builder;
 *  3. has bought one or more businesses → consolidator;
 *  4. the business needs them every day, or a score under 50 → stuck_scaler;
 *  5. everyone else (no deal yet, a business in shape) → first_deal.
 */
export function archetypeFor(a: Answers, score: number): ArchetypeId {
  if (a.revenue === 'lt1m') return 'foundation';
  if (a.goal === 'exit') return 'exit_builder';
  if (a.deals === '1' || a.deals === '2') return 'consolidator';
  if (a.team === 'no' || score < 50) return 'stuck_scaler';
  return 'first_deal';
}

export interface QuizResult { score: number; archetype: ArchetypeId; gaps: GapId[]; band: string | null; factors: Factor[] }

export function scoreQuiz(a: Answers): QuizResult {
  const { score, factors } = readinessScore(a);
  return { score, archetype: archetypeFor(a, score), gaps: topGaps(a, factors), band: a.revenue ? APP_REVENUE_BAND[a.revenue] ?? null : null, factors };
}

// ───────────── the illustrative 1.5x teaser ─────────────

/** Mid-points used for the teaser (illustrative). */
export const REVENUE_MID: Record<string, number> = { lt1m: 600_000, '1_3m': 2_000_000, '3_10m': 6_000_000, '10_25m': 17_000_000, '25_50m': 37_000_000, '50_100m': 75_000_000, gt100m: 120_000_000 };
export const MARGIN_MID: Record<string, number> = { lt10: 0.07, '10_20': 0.15, '20_30': 0.25, gt30: 0.33, unsure: 0.15 };
export const TEASER_MULTIPLE = 3;

export interface Teaser { revenue: number; margin: number; assumedMargin: boolean; profit: number; price: number; debt: number; note: number; roll: number; service: number; dscr: number; clears: boolean; maxPrice: number }

/**
 * A target with the same revenue and margin as theirs, priced at 3 times profit and funded 70% commercial debt,
 * 20% seller note and 10% seller rollover: the room calculator's own assumptions (dealMath: 9% over 10 years,
 * 6% over 5 years). Illustrative only, and labelled so wherever it is shown.
 */
export function teaser(a: Answers): Teaser | null {
  const revenue = a.revenue ? REVENUE_MID[a.revenue] : undefined;
  if (!revenue) return null;
  const margin = MARGIN_MID[a.margin ?? 'unsure'] ?? MARGIN_MID.unsure;
  const profit = Math.round(revenue * margin);
  const price = profit * TEASER_MULTIPLE;
  const m = dealMath(profit, price);
  const dscr = Math.round(m.dscr * 100) / 100;
  // The highest price the same profit carries at exactly 1.5x with this structure (debt service scales with price).
  const perDollar = dealMath(1, 1).service;
  const maxPrice = Math.round(profit / (1.5 * perDollar));
  return { revenue, margin, assumedMargin: !a.margin || a.margin === 'unsure', profit, price, debt: Math.round(m.debt), note: Math.round(m.note), roll: Math.round(m.roll), service: Math.round(m.service), dscr, clears: dscr >= 1.5, maxPrice };
}

/** "$2.0M", "$900,000", "$141,000": short money for the teaser (rounded to the nearest thousand below $1M). */
export function money(v: number) {
  if (v >= 1_000_000) return `$${(Math.round(v / 100_000) / 10).toFixed(1).replace(/\.0$/, '')}M`;
  return `$${(Math.round(v / 1000) * 1000).toLocaleString('en-US')}`;
}

/** "$900K", "$2.7M": the compact form for the teaser's figures. */
export function shortMoney(v: number) {
  if (v >= 1_000_000) return money(v);
  return `$${Math.round(v / 1000)}K`;
}
