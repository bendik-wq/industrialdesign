import type { Env } from '../env';
import { ANGLES, type Industry, landerId } from './catalog';

/**
 * Which headline each new visitor from an industry sees. Thompson sampling:
 * every angle gets a Beta(successes + 1, failures + 1) draw and the highest
 * draw wins, so traffic shifts towards what converts while weaker headlines
 * still get some traffic. Early on (little data) it's close to an even split,
 * and every angle is guaranteed its first 60 visitors.
 *
 * Success = an application started (contact details given). Once an industry
 * has 30+ qualified (A/B) applications, success switches to qualified
 * applications, the number that actually matters.
 */
export interface ArmStats { visitors: number; leads: number; qualified: number; booked: number }

let cache: { at: number; stats: Map<string, ArmStats> } | null = null;

export async function landerStats(env: Env, force = false): Promise<Map<string, ArmStats>> {
  if (!force && cache && Date.now() - cache.at < 5 * 60_000) return cache.stats;
  const since = Date.now() - 90 * 86_400_000;
  const [v, l] = await Promise.all([
    env.DB.prepare('SELECT lander, COUNT(DISTINCT visitor_id) AS n FROM sessions WHERE lander IS NOT NULL AND is_bot = 0 AND started_at > ? GROUP BY 1').bind(since).all<{ lander: string; n: number }>(),
    env.DB.prepare(
      `SELECT ft_lander AS lander, COUNT(*) AS leads, SUM(app_completed_at IS NOT NULL AND COALESCE(tier_override, tier) IN ('A', 'B')) AS qualified, SUM(booked_at IS NOT NULL) AS booked
         FROM leads WHERE ft_lander IS NOT NULL AND created_at > ? GROUP BY 1`,
    ).bind(since).all<{ lander: string; leads: number; qualified: number; booked: number }>(),
  ]);
  const stats = new Map<string, ArmStats>();
  for (const r of v.results) stats.set(r.lander, { visitors: r.n, leads: 0, qualified: 0, booked: 0 });
  for (const r of l.results) {
    const s = stats.get(r.lander) ?? { visitors: 0, leads: 0, qualified: 0, booked: 0 };
    stats.set(r.lander, { ...s, leads: r.leads, qualified: r.qualified, booked: r.booked });
  }
  cache = { at: Date.now(), stats };
  return stats;
}

// Beta sampling via two Gamma draws (Marsaglia & Tsang).
function gamma(k: number, rnd: () => number): number {
  if (k < 1) return gamma(k + 1, rnd) * Math.pow(rnd(), 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do {
      const u1 = rnd() || 1e-12, u2 = rnd();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rnd();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
export const betaSample = (a: number, b: number, rnd: () => number = Math.random) => { const x = gamma(a, rnd); return x / (x + gamma(b, rnd)); };

export const MIN_VISITORS = 60;

export function chooseAngle(industry: Industry, stats: Map<string, ArmStats>, rnd: () => number = Math.random): { angle: string; reason: string; probs?: Record<string, number> } {
  const arms = ANGLES.map((a) => ({ angle: a.id, s: stats.get(landerId(industry.id, a.id)) ?? { visitors: 0, leads: 0, qualified: 0, booked: 0 } }));
  const cold = arms.filter((x) => x.s.visitors < MIN_VISITORS);
  if (cold.length) return { angle: cold[Math.floor(rnd() * cold.length)].angle, reason: 'exploring' };
  const useQualified = arms.reduce((t, x) => t + x.s.qualified, 0) >= 30;
  let best = { angle: arms[0].angle, draw: -1 };
  for (const x of arms) {
    const wins = useQualified ? x.s.qualified : x.s.leads;
    const draw = betaSample(wins + 1, Math.max(0, x.s.visitors - wins) + 1, rnd);
    if (draw > best.draw) best = { angle: x.angle, draw };
  }
  return { angle: best.angle, reason: useQualified ? 'optimising for qualified applications' : 'optimising for applications' };
}

/** Share of traffic each angle would get right now (simulated), for the dashboard. */
export function trafficShare(industry: Industry, stats: Map<string, ArmStats>, runs = 2000) {
  const counts: Record<string, number> = Object.fromEntries(ANGLES.map((a) => [a.id, 0]));
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < runs; i++) counts[chooseAngle(industry, stats, rnd).angle]++;
  return Object.fromEntries(Object.entries(counts).map(([k, n]) => [k, n / runs]));
}
