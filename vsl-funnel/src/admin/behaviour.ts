import type { Env } from '../env';

/** On-page behaviour: what people click, where forms cause friction, where they leave, what they re-read. */
export async function behaviour(env: Env, from: number, to: number, path: string | null) {
  const db = env.DB;
  const where = `e.ts BETWEEN ? AND ? AND e.is_bot = 0${path ? ' AND e.path = ?' : ''}`;
  const p = path ? [from, to, path] : [from, to];
  const q = <T>(sql: string) => db.prepare(sql).bind(...p).all<T>().then((r) => r.results);
  const j = (k: string) => `json_extract(e.props, '$.${k}')`;
  const [pages, clicks, dead, zones, fields, exits, hovers, tabs, revisits, selects, copies, firsts] = await Promise.all([
    q<{ path: string; visitors: number }>(`SELECT e.path, COUNT(DISTINCT e.visitor_id) AS visitors FROM events e WHERE ${where} AND e.name = 'page_view' GROUP BY 1 ORDER BY 2 DESC LIMIT 20`),
    q(`SELECT e.path, ${j('el')} AS el, MAX(${j('text')}) AS text, MAX(${j('section')}) AS section, COUNT(*) AS n, COUNT(DISTINCT e.visitor_id) AS people
         FROM events e WHERE ${where} AND e.name = 'click' AND ${j('dead')} = 0 GROUP BY 1, 2 ORDER BY people DESC LIMIT 40`),
    q(`SELECT e.path, ${j('el')} AS el, MAX(${j('section')}) AS section, COUNT(*) AS n, COUNT(DISTINCT e.visitor_id) AS people
         FROM events e WHERE ${where} AND e.name IN ('click', 'rage_click') AND (${j('dead')} = 1 OR e.name = 'rage_click') GROUP BY 1, 2 ORDER BY n DESC LIMIT 20`),
    q(`SELECT e.path, CAST(${j('y')} / 10 AS INTEGER) * 10 AS band, COUNT(*) AS n FROM events e WHERE ${where} AND e.name = 'click' GROUP BY 1, 2 ORDER BY 1, 2`),
    q(`SELECT ${j('field')} AS field, COUNT(*) AS n, COUNT(DISTINCT e.visitor_id) AS people, ROUND(AVG(${j('ms')}) / 1000.0, 1) AS avg_s,
              ROUND(AVG(${j('corrections')}), 1) AS corrections, ROUND(AVG(${j('pasted')}), 3) AS paste_rate, ROUND(AVG(${j('empty')}), 3) AS empty_rate
         FROM events e WHERE ${where} AND e.name = 'field_interaction' GROUP BY 1 ORDER BY people DESC LIMIT 30`),
    q(`SELECT e.path, COALESCE(${j('section')}, '(top)') AS section, COUNT(*) AS n, ROUND(AVG(${j('scroll')})) AS scroll, ROUND(AVG(${j('s')})) AS seconds, ROUND(AVG(${j('interacted')}), 2) AS interacted
         FROM events e WHERE ${where} AND e.name = 'page_exit' GROUP BY 1, 2 ORDER BY n DESC LIMIT 30`),
    q(`SELECT e.path, ${j('id')} AS id, COUNT(*) AS n, COUNT(DISTINCT e.visitor_id) AS people, ROUND(AVG(${j('ms')}) / 1000.0, 1) AS avg_s
         FROM events e WHERE ${where} AND e.name = 'cta_hover' GROUP BY 1, 2 ORDER BY people DESC LIMIT 20`),
    q<{ sessions: number; returns: number; avg_away: number }>(`SELECT COUNT(DISTINCT e.session_id) AS sessions, COUNT(*) AS returns, ROUND(AVG(${j('away_s')})) AS avg_away FROM events e WHERE ${where} AND e.name = 'tab_return'`),
    q(`SELECT e.path, ${j('section')} AS section, COUNT(DISTINCT e.visitor_id) AS people FROM events e WHERE ${where} AND e.name = 'section_revisit' GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 20`),
    q(`SELECT ${j('text')} AS text, COUNT(DISTINCT e.visitor_id) AS people FROM events e WHERE ${where} AND e.name = 'text_select' GROUP BY 1 ORDER BY 2 DESC LIMIT 15`),
    q(`SELECT ${j('text')} AS text, COUNT(DISTINCT e.visitor_id) AS people FROM events e WHERE ${where} AND e.name = 'text_copy' GROUP BY 1 ORDER BY 2 DESC LIMIT 10`),
    q<{ type: string; n: number; avg_ms: number }>(`SELECT ${j('type')} AS type, COUNT(*) AS n, ROUND(AVG(${j('ms')})) AS avg_ms FROM events e WHERE ${where} AND e.name = 'first_interaction' GROUP BY 1`),
  ]);
  return { pages, clicks, dead, zones, fields, exits, hovers, tabs: tabs[0] ?? null, revisits, selects, copies, firsts };
}
