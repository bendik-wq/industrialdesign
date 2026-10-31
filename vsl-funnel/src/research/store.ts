import type { Runtime } from '../app';
import type { ResearchAdInput, ResearchItemInput } from './sources';

/**
 * Upserts keyed on the source's own id, so collecting the same post, video, answer or ad again only
 * refreshes its numbers (score, comments, stop date) and never makes a second row.
 */
export function dedupeItems<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Map<string, T>();
  for (const r of rows) seen.set(r.id, r);
  return [...seen.values()];
}

export async function saveItems(rt: Runtime, rows: ResearchItemInput[], now = Date.now()) {
  const list = dedupeItems(rows);
  if (!list.length) return { saved: 0, added: 0 };
  const before = await countWhereIn(rt, 'research_items', list.map((r) => r.id));
  const stmts = list.map((r) => rt.env.DB.prepare(
    `INSERT INTO research_items (id, source, kind, external_id, url, title, body, community, query, score, comments, lead_id, revenue_band, published_at, collected_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET score = excluded.score, comments = excluded.comments, title = COALESCE(excluded.title, research_items.title),
       body = COALESCE(excluded.body, research_items.body), revenue_band = COALESCE(excluded.revenue_band, research_items.revenue_band), updated_at = excluded.updated_at`,
  ).bind(r.id, r.source, r.kind, r.external_id, r.url, r.title, r.body, r.community, r.query, r.score, r.comments, r.lead_id ?? null, r.revenue_band ?? null, r.published_at, now, now));
  for (let i = 0; i < stmts.length; i += 50) await rt.env.DB.batch(stmts.slice(i, i + 50));
  return { saved: list.length, added: list.length - before };
}

export async function saveAds(rt: Runtime, rows: ResearchAdInput[], now = Date.now()) {
  const list = dedupeItems(rows);
  if (!list.length) return { saved: 0, added: 0 };
  const before = await countWhereIn(rt, 'research_ads', list.map((r) => r.id));
  const stmts = list.map((a) => rt.env.DB.prepare(
    `INSERT INTO research_ads (id, page_id, page_name, tracked_as, body, title, description, caption, link_url, platforms, languages, start_at, stop_at, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET stop_at = excluded.stop_at, last_seen = excluded.last_seen, platforms = excluded.platforms,
       tracked_as = CASE WHEN research_ads.tracked_as LIKE 'search: %' THEN excluded.tracked_as ELSE research_ads.tracked_as END`,
  ).bind(a.id, a.page_id, a.page_name, a.tracked_as, a.body, a.title, a.description, a.caption, a.link_url, JSON.stringify(a.platforms), JSON.stringify(a.languages), a.start_at, a.stop_at, now, now));
  for (let i = 0; i < stmts.length; i += 50) await rt.env.DB.batch(stmts.slice(i, i + 50));
  return { saved: list.length, added: list.length - before };
}

async function countWhereIn(rt: Runtime, table: 'research_items' | 'research_ads', ids: string[]) {
  let n = 0;
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const r = await rt.env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).first<{ n: number }>();
    n += Number(r?.n) || 0;
  }
  return n;
}
