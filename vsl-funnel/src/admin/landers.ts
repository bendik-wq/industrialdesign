import type { Env } from '../env';
import { ALL_LANDERS, ANGLES, INDUSTRIES } from '../landers/catalog';
import { landerStats, trafficShare } from '../landers/bandit';

/** Every lander followed from visit to cash, plus rollups by industry and by headline angle. */
export async function landerReport(env: Env, from: number, to: number) {
  const db = env.DB;
  const [visits, plays, leads] = await Promise.all([
    db.prepare(`SELECT lander, COUNT(DISTINCT visitor_id) AS visitors, COUNT(*) AS sessions FROM sessions WHERE lander IS NOT NULL AND is_bot = 0 AND started_at BETWEEN ? AND ? GROUP BY 1`).bind(from, to).all<{ lander: string; visitors: number; sessions: number }>(),
    db.prepare(`SELECT s.lander, COUNT(DISTINCT v.visitor_id) AS plays, COUNT(DISTINCT CASE WHEN v.cta_revealed = 1 THEN v.visitor_id END) AS pitch
                  FROM vsl_views v JOIN sessions s ON s.id = v.session_id WHERE s.lander IS NOT NULL AND v.played = 1 AND v.is_bot = 0 AND s.started_at BETWEEN ? AND ? GROUP BY 1`).bind(from, to).all<{ lander: string; plays: number; pitch: number }>(),
    db.prepare(`SELECT ft_lander AS lander, COUNT(*) AS leads, SUM(app_completed_at IS NOT NULL) AS apps,
                       SUM(app_completed_at IS NOT NULL AND COALESCE(tier_override, tier) = 'A') AS tier_a,
                       SUM(app_completed_at IS NOT NULL AND COALESCE(tier_override, tier) IN ('A', 'B')) AS qualified,
                       SUM(booked_at IS NOT NULL) AS booked, SUM(status IN ('showed', 'won', 'lost')) AS showed, SUM(status = 'won') AS won,
                       COALESCE(SUM(CASE WHEN status = 'won' THEN revenue END), 0) AS revenue, COALESCE(SUM(cash_collected), 0) AS cash
                  FROM leads WHERE ft_lander IS NOT NULL AND created_at BETWEEN ? AND ? GROUP BY 1`).bind(from, to).all<Record<string, number> & { lander: string }>(),
  ]);
  const by = <T extends { lander: string }>(rows: T[]) => new Map(rows.map((r) => [r.lander, r]));
  const V = by(visits.results), P = by(plays.results), L = by(leads.results);
  const stats = await landerStats(env);
  const shares = new Map(INDUSTRIES.map((i) => [i.id, trafficShare(i, stats)]));
  const zero = { leads: 0, apps: 0, tier_a: 0, qualified: 0, booked: 0, showed: 0, won: 0, revenue: 0, cash: 0 };

  const rows = ALL_LANDERS.map((l) => {
    const v = V.get(l.id), p = P.get(l.id), d = { ...zero, ...(L.get(l.id) ?? {}) };
    const visitors = v?.visitors ?? 0;
    return {
      id: l.id, industry: l.industry.id, industry_label: l.industry.label, angle: l.angle.id, angle_label: l.angle.label,
      headline: l.headline.replace(/<[^>]+>/g, ''),
      visitors, plays: p?.plays ?? 0, pitch: p?.pitch ?? 0, leads: d.leads, apps: d.apps, tier_a: d.tier_a, qualified: d.qualified, booked: d.booked,
      showed: d.showed, won: d.won, revenue: d.revenue, cash: d.cash,
      share: shares.get(l.industry.id)?.[l.angle.id] ?? 0,
      lead_rate: visitors ? d.leads / visitors : 0, qualified_rate: visitors ? d.qualified / visitors : 0, booked_rate: visitors ? d.booked / visitors : 0,
    };
  });
  const roll = (key: 'industry' | 'angle', labels: Map<string, string>) =>
    [...labels].map(([id, label]) => {
      const rs = rows.filter((r) => r[key] === id);
      const sum = (k: keyof (typeof rows)[number]) => rs.reduce((t, r) => t + (r[k] as number), 0);
      const visitors = sum('visitors');
      const best = [...rs].filter((r) => r.visitors >= 30).sort((a, b) => b.qualified_rate - a.qualified_rate || b.lead_rate - a.lead_rate)[0];
      return { id, label, visitors, plays: sum('plays'), leads: sum('leads'), qualified: sum('qualified'), tier_a: sum('tier_a'), booked: sum('booked'), won: sum('won'), revenue: sum('revenue'), cash: sum('cash'),
        lead_rate: visitors ? sum('leads') / visitors : 0, qualified_rate: visitors ? sum('qualified') / visitors : 0, best: best ? (key === 'industry' ? best.angle_label : best.industry_label) : null };
    });
  return {
    rows,
    byIndustry: roll('industry', new Map(INDUSTRIES.map((i) => [i.id, i.label]))),
    byAngle: roll('angle', new Map(ANGLES.map((a) => [a.id, a.label]))),
    industries: INDUSTRIES.map((i) => ({ id: i.id, label: i.label, keywords: i.keywords })),
    angles: ANGLES.map((a) => ({ id: a.id, label: a.label })),
  };
}
