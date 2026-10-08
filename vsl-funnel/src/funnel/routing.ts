import type { Runtime } from '../app';
import { CLOSERS, type Closer, TIER_ROUTES, type Route, type Tier } from '../config';

export interface RoutingDecision {
  tier: Tier;
  route: Route;
  closer: Closer | null;
  bookingUrl: string | null;
}

/**
 * Smooth weighted round-robin (the nginx algorithm): every closer accrues
 * their weight each pick, the highest current value wins and pays back the
 * total. Gives an even, interleaved spread for any weights. State lives in
 * D1 so it holds across isolates.
 */
export function pickWeighted(closers: Closer[], state: Record<string, number>): { closer: Closer; state: Record<string, number> } {
  const total = closers.reduce((s, c) => s + c.weight, 0);
  const next = { ...state };
  let best: Closer = closers[0];
  for (const c of closers) {
    next[c.id] = (next[c.id] ?? 0) + c.weight;
    if (next[c.id] > (next[best.id] ?? 0)) best = c;
  }
  next[best.id] -= total;
  return { closer: best, state: next };
}

export async function routeLead(rt: Runtime, tier: Tier): Promise<RoutingDecision> {
  const route = TIER_ROUTES[tier];
  const eligible = CLOSERS.filter((c) => c.tiers.includes(tier) && rt.settings[c.bookingSetting]);
  if (!eligible.length) {
    // No calendar connected for this tier: A-tier still books with any connected calendar.
    const anyCal = tier === 'A' ? CLOSERS.find((c) => rt.settings[c.bookingSetting]) : undefined;
    return { tier, route: tier === 'A' && !anyCal ? '/breakout' : route, closer: anyCal ?? null, bookingUrl: anyCal ? rt.settings[anyCal.bookingSetting] : null };
  }

  const key = `rr:${tier}`;
  const row = await rt.env.DB.prepare('SELECT value FROM kv_state WHERE key = ?').bind(key).first<{ value: string }>();
  const { closer, state } = pickWeighted(eligible, row ? JSON.parse(row.value) : {});
  await rt.env.DB.prepare('INSERT INTO kv_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, JSON.stringify(state)).run();
  return { tier, route, closer, bookingUrl: rt.settings[closer.bookingSetting] };
}

/** The booking calendar for a lead's assigned closer (used by /book and /breakout). */
export function bookingUrlFor(rt: Runtime, closerId: string | null, tier: Tier | null): string | null {
  const assigned = CLOSERS.find((c) => c.id === closerId);
  if (assigned && rt.settings[assigned.bookingSetting]) return rt.settings[assigned.bookingSetting];
  const byTier = CLOSERS.find((c) => tier && c.tiers.includes(tier) && rt.settings[c.bookingSetting]);
  if (byTier) return rt.settings[byTier.bookingSetting];
  const any = CLOSERS.find((c) => rt.settings[c.bookingSetting]);
  return any ? rt.settings[any.bookingSetting] : null;
}
