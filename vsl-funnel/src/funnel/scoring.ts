import { APPLICATION, type Question, TARGET_COUNTRIES, TIER_RULES, TIER_THRESHOLDS, type Tier } from '../config';

export type Answers = Record<string, string | string[] | undefined>;

export interface ScoreResult {
  score: number;
  tier: Tier;
  scoreTier: Tier;
  flags: string[];
  caps: string[];
  breakdown: { question: string; answer: string; points: number }[];
}

const TIER_RANK: Record<Tier, number> = { A: 3, B: 2, C: 1 };
const worse = (a: Tier, b: Tier): Tier => (TIER_RANK[a] <= TIER_RANK[b] ? a : b);

export function tierFromScore(score: number): Tier {
  if (score >= TIER_THRESHOLDS.A) return 'A';
  if (score >= TIER_THRESHOLDS.B) return 'B';
  return 'C';
}

/**
 * Scores an application. Points come from the answer options in config; hard
 * rules (flags) then cap the tier, so a high score can't buy past a
 * disqualifier like "not ready to invest".
 */
export function scoreApplication(answers: Answers, country: string | null, questions: Question[] = APPLICATION): ScoreResult {
  const flags = new Set<string>();
  const breakdown: ScoreResult['breakdown'] = [];
  let raw = 0;

  for (const q of questions) {
    const a = answers[q.id];
    if (q.type === 'single') {
      const opt = q.options.find((o) => o.value === a);
      if (!opt) continue;
      raw += opt.points;
      opt.flags?.forEach((f) => flags.add(f));
      breakdown.push({ question: q.id, answer: opt.label, points: opt.points });
    } else if (q.type === 'multi') {
      const vals = Array.isArray(a) ? a : a ? [a] : [];
      const opts = q.options.filter((o) => vals.includes(o.value));
      const pts = opts.reduce((s, o) => s + o.points, 0);
      raw += pts;
      opts.forEach((o) => o.flags?.forEach((f) => flags.add(f)));
      if (opts.length) breakdown.push({ question: q.id, answer: opts.map((o) => o.label).join(', '), points: pts });
    } else if (q.type === 'text') {
      const len = typeof a === 'string' ? a.trim().length : 0;
      const rule = [...q.points].sort((x, y) => y.minChars - x.minChars).find((r) => len >= r.minChars);
      const pts = rule?.points ?? 0;
      raw += pts;
      if (len) breakdown.push({ question: q.id, answer: `${len} characters`, points: pts });
    }
  }

  if (country && !TARGET_COUNTRIES.includes(country)) flags.add('out_of_market');

  const score = Math.max(0, Math.min(100, Math.round(raw)));
  const scoreTier = tierFromScore(score);
  let tier = scoreTier;
  const caps: string[] = [];
  for (const rule of TIER_RULES) {
    if (rule.when(flags) && TIER_RANK[rule.maxTier] < TIER_RANK[tier]) {
      tier = worse(tier, rule.maxTier);
      caps.push(rule.reason);
    }
  }
  return { score, tier, scoreTier, flags: [...flags], caps, breakdown };
}

/** Validates and normalises a single step's answer against its question. Returns null if invalid. */
export function normaliseAnswer(q: Question, value: unknown): string | string[] | null {
  if (q.type === 'single') return typeof value === 'string' && q.options.some((o) => o.value === value) ? value : null;
  if (q.type === 'multi') {
    const vals = (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string' && q.options.some((o) => o.value === v));
    return vals.length ? [...new Set(vals)] : null;
  }
  if (q.type === 'text') {
    const s = typeof value === 'string' ? value.trim().slice(0, 2000) : '';
    return s.length >= q.minLength ? s : null;
  }
  return null;
}
