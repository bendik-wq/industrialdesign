import type { Tier } from '../config';

/**
 * Tiers people who booked through Calendly's own form (they never saw the
 * funnel application), on the same idea as the funnel's scoring:
 *   A = owns a $1M+ business, willing to invest, real budget
 *   B = promising but missing something (smaller business, or a weak signal)
 *   C = pre-revenue / employee / not willing to invest
 */
export interface Qualification {
  tier: Tier;
  score: number;
  revenue_band: string | null;
  industry: string | null;
  budget_band: string | null;
  willing_to_invest: 'yes' | 'no' | 'unknown';
  describes: string[];
  help: string[];
  statements: string[];
  flags: string[];
}

const pick = (answers: { q: string; a: string }[], re: RegExp) => answers.find((x) => re.test(x.q))?.a?.trim() ?? null;
const lines = (s: string | null) => (s ? s.split('\n').map((x) => x.trim()).filter(Boolean) : []);

export function revenueBand(raw: string | null): string | null {
  if (!raw) return null;
  const t = raw.toLowerCase().replace(/\s/g, '');
  if (/20m\+|\$20m\+/.test(t)) return '20m+';
  if (/5mto\$?20m|5m-20m|\$5m–\$20m/.test(t)) return '5m-20m';
  if (/1mto\$?5m|1m-5m|\$1m–\$3m|\$3m–\$10m/.test(t)) return '1m-5m';
  if (/100kto\$?1m|250k|500k/.test(t)) return '100k-1m';
  if (/\$?0to|under\$1m|<100/.test(t)) return '<100k';
  return null;
}

// Calendly's form and the funnel application use slightly different bands; both are kept as asked.
export const REVENUE_ORDER = ['<100k', '100k-1m', '<1m', '1m-3m', '1m-5m', '3m-10m', '5m-20m', '10m+', '20m+'];
export const REVENUE_LABEL: Record<string, string> = {
  '<100k': 'Under $100K', '100k-1m': '$100K–$1M', '<1m': 'Under $1M', '1m-3m': '$1M–$3M', '1m-5m': '$1M–$5M', '3m-10m': '$3M–$10M', '5m-20m': '$5M–$20M', '10m+': '$10M+', '20m+': '$20M+',
};
/** Funnel application revenue answer → band. */
export const APP_REVENUE_BAND: Record<string, string> = { lt1m: '<1m', '1_3m': '1m-3m', '3_10m': '3m-10m', gt10m: '10m+' };
export const isMillionPlus = (band: string | null) => Boolean(band && !['<100k', '100k-1m', '<1m'].includes(band));

export function qualifyCalendly(answers: { q: string; a: string }[]): Qualification {
  const band = revenueBand(pick(answers, /annual revenue|stage of business/i));
  const industry = pick(answers, /industry|background/i);
  const willingRaw = pick(answers, /prepared to invest in a partnership/i);
  const budget = pick(answers, /budget range/i);
  const describes = lines(pick(answers, /best describes you/i));
  const help = lines(pick(answers, /looking for help with/i));
  const statements = lines(pick(answers, /statements that apply/i));
  const willing: Qualification['willing_to_invest'] = /^yes/i.test(willingRaw ?? '') ? 'yes' : /^no/i.test(willingRaw ?? '') ? 'no' : 'unknown';
  const notPrepared = /not prepared/i.test(budget ?? '');
  const flags: string[] = [];
  let score = 0;

  score += { '20m+': 32, '5m-20m': 32, '1m-5m': 30, '100k-1m': 12, '<100k': 0 }[band ?? ''] ?? 0;
  if (willing === 'yes') score += 15;
  if (willing === 'no') { score -= 25; flags.push('Said no to investing in a partnership'); }
  if (budget) {
    if (/20k.?-.?\$?50k|50k/i.test(budget)) score += 20;
    else if (/10.?-.?\$?20k/i.test(budget)) score += 15;
    else if (/1-10k/i.test(budget)) score += 5;
    if (notPrepared) { score -= 25; flags.push('Not prepared to invest in advisory'); }
  }
  if (describes.some((d) => />10 employees/.test(d))) score += 10;
  else if (describes.some((d) => /<10 employees/.test(d))) score += 5;
  if (describes.length && describes.every((d) => /working a job/i.test(d))) { score -= 5; flags.push('Employee, no business yet'); }
  if (statements.some((s) => /have capital/i.test(s))) { score += 8; flags.push('Has capital to commit'); }
  if (statements.some((s) => /commit time/i.test(s))) score += 4;
  if (statements.some((s) => /work with Josh/i.test(s))) score += 4;
  if (help.some((h) => /buying companies/i.test(h))) score += 5;
  if (help.length && help.every((h) => /networking/i.test(h))) { score -= 10; flags.push('Only looking to network'); }
  if (band && ['1m-5m', '5m-20m', '20m+'].includes(band)) flags.push('Owns a $1M+ business');

  const big = band !== null && ['1m-5m', '5m-20m', '20m+'].includes(band);
  const capped = willing === 'no' || notPrepared;
  const tier: Tier = big && !capped && score >= 45 ? 'A' : (big || score >= 25) && !(capped && !big) ? 'B' : 'C';
  return { tier, score: Math.max(0, Math.min(100, score)), revenue_band: band, industry, budget_band: budget, willing_to_invest: willing, describes, help, statements, flags };
}
