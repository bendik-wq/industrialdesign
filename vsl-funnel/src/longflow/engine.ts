import type { LongEmail } from './kit';

/**
 * Scheduling and selection for the six-month flows (pure functions; the database side lives in
 * integrations/email.ts). Rows for the long part of a flow use step numbers from LONG_STEP up, so
 * they never clash with a flow's original steps. A row whose template is LIB_SLOT gets its email
 * chosen from the library when it's due, from what the person has read on the site by then.
 */
export const LONG_STEP = 100;
export const LIB_SLOT = '@lib';
const DAY = 86_400_000;

/** Library topics, in the order a new reader should meet them. */
export const LIB_TOPICS = [
  'lenders', 'seller_finance', 'rollover', 'structures', 'dscr', 'capabilities', 'sourcing', 'sellers',
  'owner_life', 'beliefs', 'diligence', 'closing', 'integration', 'groups', 'timing', 'industries',
] as const;
export type LibTopic = (typeof LIB_TOPICS)[number];

/** Guide pages → the library topic they show interest in (and an industry, for industry guides). */
export const GUIDE_TOPICS: Record<string, { topic: LibTopic; industry?: string }> = {
  'how-to-buy-a-business-with-no-money-down': { topic: 'structures' },
  'seller-finance-explained': { topic: 'seller_finance' },
  'seller-rollover-explained': { topic: 'rollover' },
  '60-40-deal-structure': { topic: 'structures' },
  '70-20-10-deal-structure': { topic: 'structures' },
  '100-percent-vendor-finance': { topic: 'seller_finance' },
  'dscr-explained': { topic: 'dscr' },
  'over-financed-acquisition': { topic: 'structures' },
  'buy-a-business-without-a-personal-guarantee': { topic: 'lenders' },
  'letter-of-intent-buying-a-business': { topic: 'closing' },
  'buy-your-competitor': { topic: 'sourcing' },
  'find-off-market-businesses-for-sale': { topic: 'sourcing' },
  'questions-to-ask-a-business-seller': { topic: 'sellers' },
  'due-diligence-red-flags': { topic: 'diligence' },
  'buy-a-security-business': { topic: 'industries', industry: 'security' },
  'buy-an-accounting-firm': { topic: 'industries', industry: 'accounting' },
  'buy-an-insurance-brokerage': { topic: 'industries', industry: 'insurance' },
  'buy-an-msp-it-services-business': { topic: 'industries', industry: 'it-services' },
  'buy-a-marketing-agency': { topic: 'industries', industry: 'agencies' },
  'buy-a-recruitment-agency': { topic: 'industries', industry: 'recruitment' },
  'buy-a-restaurant-or-venue': { topic: 'industries', industry: 'hospitality' },
  'buy-a-childcare-centre': { topic: 'industries', industry: 'childcare' },
  'buy-a-logistics-business': { topic: 'industries', industry: 'logistics' },
  'buy-a-rent-roll': { topic: 'industries', industry: 'property' },
};

/** What a person has shown interest in: topic → weight, plus industries that are theirs. */
export interface Interests { topics: Partial<Record<LibTopic, number>>; industries: Set<string> }

/** Interests from the pages they viewed and the guide links they clicked in emails. */
export function interestsFrom(paths: string[], industries: (string | null | undefined)[]): Interests {
  const topics: Partial<Record<LibTopic, number>> = {};
  const inds = new Set(industries.filter(Boolean) as string[]);
  for (const p of paths) {
    const g = /^\/guides\/([a-z0-9-]+)/.exec(p)?.[1];
    const hit = g ? GUIDE_TOPICS[g] : undefined;
    if (hit) { topics[hit.topic] = (topics[hit.topic] ?? 0) + 1; if (hit.industry) inds.add(hit.industry); }
    const ind = /^\/for\/([a-z0-9-]+)/.exec(p)?.[1];
    if (ind) inds.add(ind);
  }
  if (inds.size) topics.industries = (topics.industries ?? 0) + 1;
  return { topics, industries: inds };
}

/**
 * The library email for the next slot: the topic they've seen least relative to their interest
 * (reading a seller-finance guide makes seller-finance emails come up about three times as often),
 * then the next unsent email in that topic. Industry emails only go to owners in that industry.
 */
export function pickLibrary(library: Record<LibTopic, LongEmail[]>, sent: Set<string>, interests: Interests): string | null {
  let best: { id: string; score: number } | null = null;
  LIB_TOPICS.forEach((topic, order) => {
    const all = library[topic] ?? [];
    const eligible = all.filter((e) => !e.industries?.length || e.industries.some((i) => interests.industries.has(i)));
    const next = eligible.find((e) => !sent.has(e.id));
    if (!next) return;
    const seen = eligible.filter((e) => sent.has(e.id)).length;
    const score = (seen + 1) / (1 + 2 * (interests.topics[topic] ?? 0)) + order * 1e-3;
    if (!best || score < best.score) best = { id: next.id, score };
  });
  return (best as { id: string } | null)?.id ?? null;
}

/** Relative send volume by day: ~10/day in month 1, ~6/day in months 2–3, ~3–4/day after (for 1,000 over 182 days). */
const weight = (day: number) => (day < 30 ? 3 : day < 90 ? 1.8 : 1.1);

/**
 * Send times for `total` emails over `days` days from `start`, between 8am and 8pm their time,
 * spread evenly within each day. `zoned(y, m, d, hour)` turns a local wall-clock time into epoch ms.
 */
export function longTimes(start: number, tz: string, total: number, days: number, zoned: (y: number, m: number, d: number, h: number, tz: string) => number): number[] {
  if (total <= 0 || days <= 0) return [];
  let parts: Intl.DateTimeFormatPart[];
  try { parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(start); } catch { return longTimes(start, 'UTC', total, days, zoned); }
  const g = (k: string) => Number(parts.find((x) => x.type === k)!.value);
  const w = Array.from({ length: days }, (_, d) => weight(d));
  const sum = w.reduce((a, b) => a + b, 0);
  const out: number[] = [];
  let carry = 0;
  for (let d = 0; d < days && out.length < total; d++) {
    carry += (w[d] * total) / sum;
    let n = Math.floor(carry + 1e-9);
    carry -= n;
    if (d === days - 1) n = total - out.length; // land exactly on the total
    if (n <= 0) continue;
    const base = new Date(Date.UTC(g('year'), g('month') - 1, g('day') + d));
    const [y, m, dd] = [base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate()];
    for (let i = 0; i < n; i++) {
      const hour = 8 + ((i + 0.5) * 12) / n;
      const t = zoned(y, m, dd, Math.round(hour * 12) / 12, tz);
      if (t > start) out.push(t);
    }
  }
  return out.slice(0, total);
}

/**
 * Which slots carry the flow's own emails and which a library email: about half in month 1,
 * a fifth in months 2–3, an eighth after, in the flow's order. Runs out of either → the other.
 */
export function longPlan(times: number[], start: number, flowIds: string[]): string[] {
  const share = (t: number) => { const d = (t - start) / DAY; return d < 30 ? 0.5 : d < 90 ? 0.2 : 0.12; };
  const out: string[] = [];
  let fi = 0;
  let acc = 0;
  for (const t of times) {
    acc += share(t);
    const remainingSlots = times.length - out.length;
    const mustUseFlow = flowIds.length - fi >= remainingSlots; // never strand flow emails at the end
    if (fi < flowIds.length && (acc >= 1 || mustUseFlow)) { out.push(flowIds[fi++]); if (acc >= 1) acc -= 1; } else out.push(LIB_SLOT);
  }
  return out;
}
