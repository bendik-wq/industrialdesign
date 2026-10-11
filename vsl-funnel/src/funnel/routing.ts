import type { Runtime } from '../app';
import { TIER_ROUTES, type Route, type Tier } from '../config';
import { type Rep, calendarFor, repTiers } from '../sales/reps';

export interface RoutingDecision {
  tier: Tier;
  route: Route;
  closer: Rep | null;
  bookingUrl: string | null;
}

/**
 * Smooth weighted round-robin (the nginx algorithm): every closer accrues
 * their weight each pick, the highest current value wins and pays back the
 * total. Gives an even, interleaved spread for any weights. State lives in
 * D1 so it holds across isolates.
 */
export function pickWeighted<C extends { id: string; weight: number }>(closers: C[], state: Record<string, number>): { closer: C; state: Record<string, number> } {
  const total = closers.reduce((s, c) => s + c.weight, 0);
  const next = { ...state };
  let best: C = closers[0];
  for (const c of closers) {
    next[c.id] = (next[c.id] ?? 0) + c.weight;
    if (next[c.id] > (next[best.id] ?? 0)) best = c;
  }
  next[best.id] -= total;
  return { closer: best, state: next };
}

/** Active closers who take this tier and have a calendar connected. */
export const closersFor = (rt: Runtime, tier: Tier | null) =>
  rt.reps.filter((r) => r.active && r.role !== 'setter' && (!tier || repTiers(r).includes(tier)) && calendarFor(rt.settings, r));

export async function routeLead(rt: Runtime, tier: Tier): Promise<RoutingDecision> {
  const route = TIER_ROUTES[tier];
  const eligible = closersFor(rt, tier);
  if (!eligible.length) {
    // No calendar connected for this tier: A-tier still books with any connected calendar.
    const anyCal = tier === 'A' ? closersFor(rt, null)[0] : undefined;
    return { tier, route: tier === 'A' && !anyCal ? '/breakout' : route, closer: anyCal ?? null, bookingUrl: anyCal ? calendarFor(rt.settings, anyCal) : null };
  }

  const key = `rr:${tier}`;
  const row = await rt.env.DB.prepare('SELECT value FROM kv_state WHERE key = ?').bind(key).first<{ value: string }>();
  const { closer, state } = pickWeighted(eligible, row ? JSON.parse(row.value) : {});
  await rt.env.DB.prepare('INSERT INTO kv_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, JSON.stringify(state)).run();
  return { tier, route, closer, bookingUrl: calendarFor(rt.settings, closer) };
}

/** The booking calendar for a lead's assigned closer (used by /book and /breakout). */
export function bookingUrlFor(rt: Runtime, closerId: string | null, tier: Tier | null): string | null {
  const assigned = rt.reps.find((r) => r.id === closerId && r.active);
  if (assigned && calendarFor(rt.settings, assigned)) return calendarFor(rt.settings, assigned);
  const byTier = closersFor(rt, tier)[0];
  if (byTier) return calendarFor(rt.settings, byTier);
  const any = closersFor(rt, null)[0];
  return any ? calendarFor(rt.settings, any) : null;
}
