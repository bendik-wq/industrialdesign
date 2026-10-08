import { APPLICATION, EXCLUDED_INDUSTRIES, PERSONAL_EMAIL_DOMAINS, type Question, TARGET_COUNTRIES, TIER_RULES, TIER_THRESHOLDS, type Tier } from '../config';

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
export interface ScoreContext {
  /** Country from the visitor's IP. */
  country: string | null;
  email?: string | null;
  /** E.164, e.g. +61412345678. */
  phone?: string | null;
  /** Emails, phone numbers or @domains that should never reach a call. */
  blocklist?: string[];
}

const DIAL_TO_COUNTRY: [string, string[]][] = [
  ['971', ['AE']], ['353', ['IE']], ['61', ['AU']], ['64', ['NZ']], ['65', ['SG']], ['44', ['GB']], ['1', ['US', 'CA']],
];

/** Country (or countries) a phone number belongs to, from its dial code. */
export function phoneCountries(phone: string | null | undefined): string[] {
  const digits = phone?.replace(/\D/g, '') ?? '';
  return DIAL_TO_COUNTRY.find(([code]) => digits.startsWith(code))?.[1] ?? [];
}

export function isPersonalEmail(email: string | null | undefined) {
  const domain = email?.split('@')[1]?.toLowerCase() ?? '';
  return PERSONAL_EMAIL_DOMAINS.some((d) => domain === d || domain.startsWith(`${d}.`));
}

export function parseBlocklist(raw: string | null | undefined): string[] {
  return (raw ?? '').split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
}

export function isBlocked(list: string[], email: string | null | undefined, phone: string | null | undefined) {
  const e = email?.toLowerCase() ?? '';
  const p = phone?.replace(/\D/g, '') ?? '';
  return list.some((entry) => {
    if (entry.startsWith('@')) return e.endsWith(entry);
    if (entry.includes('@')) return e === entry;
    const digits = entry.replace(/\D/g, '');
    return digits.length >= 6 && p.endsWith(digits);
  });
}

export function matchesExcludedIndustry(text: unknown) {
  if (typeof text !== 'string' || !text) return null;
  return EXCLUDED_INDUSTRIES.find((word) => new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)) ?? null;
}

export function scoreApplication(answers: Answers, ctx: ScoreContext | string | null, questions: Question[] = APPLICATION): ScoreResult {
  const c: ScoreContext = typeof ctx === 'object' && ctx !== null ? ctx : { country: ctx };
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

  // In market if either the phone number or the IP says so (owners travel; numbers don't move).
  const markets = [...phoneCountries(c.phone), ...(c.country ? [c.country] : [])];
  if (markets.length && !markets.some((m) => TARGET_COUNTRIES.includes(m))) flags.add('out_of_market');
  if (isPersonalEmail(c.email)) flags.add('personal_email');
  if (c.blocklist?.length && isBlocked(c.blocklist, c.email, c.phone)) flags.add('blocked');
  const industry = matchesExcludedIndustry(answers.business);
  if (industry) {
    flags.add('excluded_industry');
    breakdown.push({ question: 'business', answer: `excluded industry: ${industry}`, points: 0 });
  }

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
