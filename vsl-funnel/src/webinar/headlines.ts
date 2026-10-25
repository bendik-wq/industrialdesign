import type { Runtime } from '../app';
import { isMillionPlus } from '../sales/qualify';

/**
 * Webinar page headline test. Angles are written for owners with money ($1M+ revenue),
 * and the test is judged on $1M+ registrations, not raw sign-ups.
 * Every lede that describes funding names commercial debt, seller finance and seller rollover.
 */
export const WEBINAR_HEADLINES: { id: string; angle: string; h1: string; lede: string }[] = [
  {
    id: 'control', angle: 'No money down (original)',
    h1: 'How owners are buying their competitors with <em><span class="nw">no money down</span></em>, and working towards a signed LOI in 90 days',
    lede: 'One hour on where the off-market deals are, how commercial debt, seller finance and seller rollover get stacked so the deal is over-financed, and the step-by-step path to a signed letter of intent.',
  },
  {
    id: 'cash', angle: 'Keep your cash',
    h1: 'Keep your cash. Buy your competitor with <em>the bank’s money and the seller’s</em>.',
    lede: 'You could write the cheque. This hour shows why you shouldn’t: how commercial debt, seller finance and seller rollover fund an acquisition while your own capital stays where it’s earning.',
  },
  {
    id: 'multiple', angle: 'Exit multiple',
    h1: 'One business sells for 3–5× profit. A group can sell for <em>8–12×</em>.',
    lede: 'Illustrative multiples. In one hour: how owners buy the businesses around them with commercial debt, seller finance and seller rollover, and lift the value of the one they already own.',
  },
  {
    id: 'pe', angle: 'Private equity is coming',
    h1: 'Private equity is buying your industry’s retiring owners. <em>You can do the same deal.</em>',
    lede: 'How to reach the owner who wants out before a fund does, and pay for the business with commercial debt, seller finance and seller rollover instead of your savings.',
  },
  {
    id: 'ceiling', angle: 'Growth ceiling',
    h1: 'You’ve built one business. Buying the next one takes <em>90 days, not 10 years</em>.',
    lede: 'For owners who have hit the limit of growing by hiring: how a competitor’s customers, team and profit join yours in one move, and the week-by-week path towards a signed letter of intent.',
  },
  {
    id: 'group', angle: 'Build the group',
    h1: 'Most owners sell one business. A few build <em>the group that buys them</em>.',
    lede: 'One hour on becoming the buyer: finding the owner with no successor, structuring the deal with commercial debt, seller finance and seller rollover, and adding the next business after that.',
  },
  {
    id: 'rollover', angle: 'Seller has skin in the game',
    h1: 'When the seller keeps a stake, <em>they’re betting their own money</em> the business is real.',
    lede: 'Why seller rollover is the strongest signal in a deal, and how it combines with commercial debt and seller finance so the purchase is funded without your savings.',
  },
];

export const HEADLINE_MIN_VIEWS = 40; // every headline gets this many visitors before traffic shifts

export interface HeadlineStat { views: number; regs: number; qualified: number }

/** Views (distinct visitors) and $1M+ registrations per headline, all time. */
export async function webinarHeadlineStats(rt: Runtime): Promise<Map<string, HeadlineStat>> {
  const [views, regs] = await Promise.all([
    rt.env.DB.prepare("SELECT json_extract(props, '$.h') AS h, COUNT(DISTINCT visitor_id) AS n FROM events WHERE name = 'webinar_headline_view' AND is_bot = 0 GROUP BY 1").all<{ h: string; n: number }>(),
    rt.env.DB.prepare('SELECT headline AS h, revenue_band AS band FROM webinar_registrations WHERE headline IS NOT NULL AND seq = 0').all<{ h: string; band: string | null }>(),
  ]);
  const out = new Map<string, HeadlineStat>(WEBINAR_HEADLINES.map((h) => [h.id, { views: 0, regs: 0, qualified: 0 }]));
  for (const v of views.results) { const s = out.get(v.h); if (s) s.views = v.n; }
  for (const r of regs.results) { const s = out.get(r.h); if (s) { s.regs++; if (isMillionPlus(r.band)) s.qualified++; } }
  return out;
}

/** Gamma(k, 1) for integer-ish k (Marsaglia–Tsang), for Beta sampling. */
function gamma(k: number, rnd: () => number): number {
  if (k < 1) return gamma(k + 1, rnd) * Math.pow(rnd(), 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do { const u1 = rnd(), u2 = rnd(); x = Math.sqrt(-2 * Math.log(u1 || 1e-12)) * Math.cos(2 * Math.PI * u2); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = rnd();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
const beta = (a: number, b: number, rnd: () => number) => { const x = gamma(a, rnd); return x / (x + gamma(b, rnd)); };

/** Thompson sampling on $1M+ registrations per visitor, after every headline has its minimum views. */
export function chooseWebinarHeadline(stats: Map<string, HeadlineStat>, mode: string, rnd: () => number = Math.random): string {
  const ids = WEBINAR_HEADLINES.map((h) => h.id);
  if (ids.includes(mode)) return mode;
  if (mode === 'even') return ids[Math.floor(rnd() * ids.length)];
  const cold = ids.filter((id) => (stats.get(id)?.views ?? 0) < HEADLINE_MIN_VIEWS);
  if (cold.length) return cold[Math.floor(rnd() * cold.length)];
  let best = ids[0], top = -1;
  for (const id of ids) {
    const s = stats.get(id)!;
    const draw = beta(1 + s.qualified, 1 + Math.max(0, s.views - s.qualified), rnd);
    if (draw > top) { top = draw; best = id; }
  }
  return best;
}

/** Share of new traffic each headline would get now (simulated), for the dashboard. */
export function webinarHeadlineOdds(stats: Map<string, HeadlineStat>, mode: string, runs = 2000) {
  const wins = new Map<string, number>();
  for (let i = 0; i < runs; i++) { const id = chooseWebinarHeadline(stats, mode); wins.set(id, (wins.get(id) ?? 0) + 1); }
  return new Map([...wins].map(([k, v]) => [k, v / runs]));
}

/** The headline this visitor sees: a preview (?h=), the one they saw before, or a fresh pick. */
export async function pickWebinarHeadline(rt: Runtime, visitorId: string | null, preview?: string | null) {
  const byId = (id: string | null | undefined) => WEBINAR_HEADLINES.find((h) => h.id === id) ?? null;
  if (preview && byId(preview)) return { headline: byId(preview)!, preview: true };
  if (visitorId) {
    const seen = await rt.env.DB.prepare("SELECT json_extract(props, '$.h') AS h FROM events WHERE name = 'webinar_headline_view' AND visitor_id = ? ORDER BY ts DESC LIMIT 1").bind(visitorId).first<{ h: string }>();
    if (byId(seen?.h)) return { headline: byId(seen!.h)!, preview: false };
  }
  const mode = (rt.settings.WEBINAR_HEADLINE_TEST || 'auto').trim().toLowerCase();
  const id = chooseWebinarHeadline(await webinarHeadlineStats(rt), mode);
  return { headline: byId(id)!, preview: false };
}
