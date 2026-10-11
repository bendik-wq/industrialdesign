import type { Tier } from '../config';
import type { Env } from '../env';
import type { Settings } from '../settings';

/** A member of the sales team. Closers take booked calls; setters can be credited on leads too. */
export interface Rep {
  id: string;
  name: string;
  email: string | null;
  role: 'closer' | 'setter' | 'manager';
  tiers: string;
  weight: number;
  calendar_url: string | null;
  booking_setting: string | null;
  commission_pct: number;
  monthly_target: number;
  slack_user_id: string | null;
  discord_user_id: string | null;
  active: number;
  created_at: number;
}

export const REP_ROLES = ['closer', 'setter', 'manager'] as const;

let cache: { at: number; reps: Rep[] } | null = null;
const TTL_MS = 15_000;

export async function loadReps(env: Env): Promise<Rep[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.reps;
  const { results } = await env.DB.prepare('SELECT * FROM reps ORDER BY created_at, name').all<Rep>().catch(() => ({ results: [] as Rep[] }));
  cache = { at: Date.now(), reps: results };
  return results;
}
export const clearRepCache = () => { cache = null; };

export const repTiers = (r: Pick<Rep, 'tiers'>) => r.tiers.split(',').map((t) => t.trim()).filter(Boolean) as Tier[];

/** A rep's booking link: their own calendar, else the legacy setting they were seeded with. */
export function calendarFor(settings: Settings, r: Pick<Rep, 'calendar_url' | 'booking_setting'>): string {
  if (r.calendar_url) return r.calendar_url;
  if (r.booking_setting && r.booking_setting in settings) return settings[r.booking_setting as keyof Settings] || '';
  return '';
}

export const slugId = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').slice(0, 30) || 'rep';
