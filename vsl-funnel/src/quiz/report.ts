import type { Runtime } from '../app';
import { ARCHETYPES, ARCHETYPE_ORDER, GAPS, QUESTIONS } from './content';

/**
 * Funnel HQ → Quiz: the funnel per step with drop-off, completion, archetype mix, score distribution, what quiz
 * leads did next (registered, attended, bought) and the list of quiz leads. Every number is counted from
 * quiz_responses and the registration and payment tables for the date range (quizzes started in it); bots excluded.
 */

interface Range { from: number; to: number }
const num = (v: unknown) => Number(v) || 0;

/** Attended: joined the masterclass room or its replay, or the live room. Bought: a paid Sprint or deposit, or a won deal. */
const ATTENDED = `((q.target = 'live' AND EXISTS (SELECT 1 FROM live_webinar_regs l WHERE l.id = q.reg_id AND (l.joined_at IS NOT NULL OR l.replay_at IS NOT NULL)))
  OR (COALESCE(q.target, 'webinar') = 'webinar' AND EXISTS (SELECT 1 FROM webinar_registrations w WHERE w.id = q.reg_id AND (w.joined_at IS NOT NULL OR w.replay_at IS NOT NULL))))`;
const BOUGHT = `(EXISTS (SELECT 1 FROM webinar_passes p WHERE p.lead_id = q.lead_id AND p.status = 'paid' AND p.kind IN ('offer', 'deposit') AND p.paid_at >= q.lead_at)
  OR EXISTS (SELECT 1 FROM leads b WHERE b.id = q.lead_id AND b.status = 'won' AND COALESCE(b.closed_at, 0) >= q.lead_at))`;

export const SCORE_BUCKETS: [number, number][] = [[0, 19], [20, 39], [40, 59], [60, 79], [80, 100]];

export async function quizCounts(rt: Pick<Runtime, 'env'>, r: Range) {
  const db = rt.env.DB;
  const where = 'q.started_at BETWEEN ? AND ? AND q.is_bot = 0';
  const steps = QUESTIONS.map((_, i) => `SUM(q.step_reached >= ${i + 1}) AS s${i + 1}`).join(', ');
  const row = await db.prepare(
    `SELECT COUNT(*) AS started, ${steps}, SUM(q.completed_at IS NOT NULL) AS completed, SUM(q.gate_viewed_at IS NOT NULL) AS gate, SUM(q.lead_at IS NOT NULL) AS leads,
       SUM(q.result_viewed_at IS NOT NULL) AS result, SUM(q.registered_at IS NOT NULL) AS registered,
       SUM(q.registered_at IS NOT NULL AND ${ATTENDED}) AS attended, SUM(q.lead_at IS NOT NULL AND ${BOUGHT}) AS bought,
       AVG(CASE WHEN q.lead_at IS NOT NULL THEN q.score END) AS avg_score
     FROM quiz_responses q WHERE ${where}`,
  ).bind(r.from, r.to).first<Record<string, number | null>>();
  const landing = await db.prepare("SELECT COUNT(DISTINCT visitor_id) AS n FROM events WHERE ts BETWEEN ? AND ? AND is_bot = 0 AND name = 'page_view' AND path = '/quiz'").bind(r.from, r.to).first<{ n: number }>();
  return { landing: num(landing?.n), row: row ?? {} };
}

export async function quizReport(rt: Pick<Runtime, 'env'>, r: Range) {
  const db = rt.env.DB;
  const { landing, row } = await quizCounts(rt, r);
  const started = num(row.started);
  const funnel: { key: string; label: string; n: number }[] = [
    { key: 'landing', label: 'Saw the quiz page', n: landing },
    { key: 'started', label: 'Started', n: started },
    ...QUESTIONS.map((q, i) => ({ key: `q${i + 1}`, label: `Q${i + 1}: ${q.title}`, n: num(row[`s${i + 1}`]) })),
    { key: 'gate', label: 'Saw the email gate', n: num(row.gate) },
    { key: 'lead', label: 'Gave name and email', n: num(row.leads) },
    { key: 'result', label: 'Saw the result', n: num(row.result) },
    { key: 'registered', label: 'Saved a seat', n: num(row.registered) },
    { key: 'attended', label: 'Attended (live or replay)', n: num(row.attended) },
    { key: 'bought', label: 'Bought (Sprint, deposit or won deal)', n: num(row.bought) },
  ];
  // Drop-off from the step before (the first step has none).
  const steps = funnel.map((s, i) => {
    const prev = i ? funnel[i - 1].n : 0;
    return { ...s, rate: i && prev ? s.n / prev : null, drop: i && prev ? Math.max(0, prev - s.n) : null };
  });
  const leads = num(row.leads);
  const [arch, scores, gaps, list] = await Promise.all([
    db.prepare('SELECT archetype, COUNT(*) AS n, AVG(score) AS avg FROM quiz_responses q WHERE q.started_at BETWEEN ? AND ? AND q.is_bot = 0 AND q.lead_at IS NOT NULL GROUP BY archetype').bind(r.from, r.to).all<{ archetype: string; n: number; avg: number }>(),
    db.prepare('SELECT score FROM quiz_responses q WHERE q.started_at BETWEEN ? AND ? AND q.is_bot = 0 AND q.lead_at IS NOT NULL').bind(r.from, r.to).all<{ score: number }>(),
    db.prepare("SELECT t.tag, COUNT(*) AS n FROM lead_tags t JOIN quiz_responses q ON q.lead_id = t.lead_id WHERE t.tag LIKE 'quiz:gap:%' AND q.started_at BETWEEN ? AND ? AND q.is_bot = 0 AND q.lead_at IS NOT NULL GROUP BY t.tag").bind(r.from, r.to).all<{ tag: string; n: number }>(),
    db.prepare(
      `SELECT q.id, q.token, q.lead_id, q.score, q.archetype, q.gaps, q.revenue_band, q.lead_at, q.registered_at, q.target, q.channel, q.utm_campaign,
         l.first_name, l.last_name, l.email, l.status, ${ATTENDED} AS attended, ${BOUGHT} AS bought
       FROM quiz_responses q LEFT JOIN leads l ON l.id = q.lead_id
       WHERE q.started_at BETWEEN ? AND ? AND q.is_bot = 0 AND q.lead_at IS NOT NULL ORDER BY q.lead_at DESC LIMIT 200`,
    ).bind(r.from, r.to).all<Record<string, unknown>>(),
  ]);
  const byArch = new Map(arch.results.map((a) => [a.archetype, a]));
  return {
    range: r,
    kpis: {
      started, leads, completion: started ? num(row.completed) / started : null, leadRate: started ? leads / started : null,
      registered: num(row.registered), registerRate: leads ? num(row.registered) / leads : null, attended: num(row.attended), bought: num(row.bought),
      avgScore: row.avg_score == null ? null : Math.round(Number(row.avg_score)),
    },
    steps,
    archetypes: ARCHETYPE_ORDER.map((id) => ({ id, name: ARCHETYPES[id].name, n: num(byArch.get(id)?.n), avg: byArch.get(id) ? Math.round(num(byArch.get(id)!.avg)) : null })),
    scores: SCORE_BUCKETS.map(([lo, hi]) => ({ label: `${lo} to ${hi}`, n: scores.results.filter((s) => s.score >= lo && s.score <= hi).length })),
    gaps: Object.values(GAPS).map((g) => ({ id: g.id, title: g.title, n: num(gaps.results.find((x) => x.tag === `quiz:gap:${g.id}`)?.n) })).sort((a, b) => b.n - a.n),
    leads: list.results.map((x) => ({
      id: x.id, lead_id: x.lead_id, name: [x.first_name, x.last_name].filter(Boolean).join(' ') || null, email: x.email ?? null,
      score: x.score, archetype: x.archetype, archetypeName: ARCHETYPES[x.archetype as keyof typeof ARCHETYPES]?.name ?? null,
      gaps: (() => { try { return (JSON.parse(String(x.gaps ?? '[]')) as string[]).map((g) => GAPS[g as keyof typeof GAPS]?.title ?? g); } catch { return []; } })(),
      band: x.revenue_band, lead_at: x.lead_at, registered_at: x.registered_at, target: x.target, attended: Boolean(x.attended), bought: Boolean(x.bought),
      channel: x.channel, campaign: x.utm_campaign, status: x.status,
    })),
  };
}
