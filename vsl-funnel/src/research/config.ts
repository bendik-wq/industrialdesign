import type { Runtime } from '../app';
import { flag } from '../settings';

/** Research department settings, with the defaults the Integrations tab shows as placeholders. */
export const DEFAULT_RESEARCH_MODEL = 'claude-sonnet-5-5';
export const DEFAULT_SUBREDDITS = ['smallbusiness', 'Entrepreneur', 'sweatystartup', 'fatFIRE', 'acquisitions', 'smallbusinessowner', 'consulting', 'HVAC', 'Plumbing', 'dentistry', 'msp', 'Accounting'];
export const DEFAULT_KEYWORDS = ['buy a business', 'acquisition', 'SBA loan', 'seller financing', 'succession', 'exit'];
export const DEFAULT_AD_KEYWORDS = ['buy a business', 'business acquisition', 'seller financing', 'acquire a company'];
export const DEFAULT_AD_COUNTRIES = ['US', 'GB', 'AU', 'IE'];
export const DEFAULT_YT_QUERIES = ['buy a business', 'business acquisition', 'ETA search fund', 'seller financing', 'SBA 7a loan'];

const list = (raw: string | undefined, dflt: string[], max = 30) => {
  const out = (raw ?? '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  return [...new Set(out.length ? out : dflt)].slice(0, max);
};

export interface Competitor { name: string; pageId: string | null }
export function parseCompetitors(raw: string | undefined): Competitor[] {
  return list(raw, [], 25).map((entry) => {
    const [a, b] = entry.split('|').map((s) => s.trim());
    if (/^\d{5,20}$/.test(a) && !b) return { name: a, pageId: a };
    return { name: a, pageId: b && /^\d{5,20}$/.test(b) ? b : null };
  }).filter((c) => c.name);
}

export function researchConfig(rt: Runtime) {
  const s = rt.settings;
  const day = (s.RESEARCH_BRIEF_DAY || 'Mon').trim();
  return {
    enabled: flag(s.RESEARCH_ENABLED, true),
    model: s.RESEARCH_MODEL || DEFAULT_RESEARCH_MODEL,
    aiReady: Boolean(s.ANTHROPIC_API_KEY),
    hour: clampHour(s.RESEARCH_HOUR, 2),
    briefDay: /^off$/i.test(day) ? null : day.slice(0, 3).toLowerCase(),
    briefHour: clampHour(s.RESEARCH_BRIEF_HOUR, 9),
    tz: s.SALES_TIMEZONE || 'Australia/Sydney',
    subreddits: list(s.RESEARCH_SUBREDDITS, DEFAULT_SUBREDDITS).map((x) => x.replace(/^\/?r\//i, '')).filter((x) => /^[A-Za-z0-9_]{2,30}$/.test(x)),
    keywords: list(s.RESEARCH_KEYWORDS, DEFAULT_KEYWORDS, 15),
    competitors: parseCompetitors(s.RESEARCH_COMPETITORS),
    adKeywords: list(s.RESEARCH_AD_KEYWORDS, DEFAULT_AD_KEYWORDS, 15),
    adCountries: list(s.RESEARCH_AD_COUNTRIES, DEFAULT_AD_COUNTRIES, 10).map((c) => c.toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)),
    ytQueries: list(s.RESEARCH_YT_QUERIES, DEFAULT_YT_QUERIES, 10),
    adToken: s.META_AD_LIBRARY_TOKEN || s.META_ADS_TOKEN || '',
    ytKey: s.YOUTUBE_API_KEY || '',
    reddit: { clientId: s.REDDIT_CLIENT_ID || '', clientSecret: s.REDDIT_CLIENT_SECRET || '', username: s.REDDIT_USERNAME || '' },
  };
}
export type ResearchConfig = ReturnType<typeof researchConfig>;

function clampHour(v: string | undefined, dflt: number) {
  const n = Number(v);
  return v && Number.isInteger(n) && n >= 0 && n <= 23 ? n : dflt;
}
