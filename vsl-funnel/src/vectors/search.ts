import type { Runtime } from '../app';
import { type Passage, knowledgeBase } from '../support/kb';
import { type Ns, embedder, leadText, meanVector, unavailable, vecId, vecIndex } from './core';
import { BOUGHT_SQL } from './indexer';

/**
 * What Funnel HQ asks of the index: leads like this one, leads like my recent buyers (who haven't bought), and a
 * meaning search over questions, call notes and lead answers. Plus doc retrieval for the room helper. Every
 * function first checks `unavailable` (off, or no binding here) and says why instead of failing.
 */

export interface LeadHit { id: string; score: number; name: string; tier: string | null; status: string | null; band: string | null; bought: boolean; business: string | null }
type Rt = Pick<Runtime, 'env' | 'settings'>;

const toArr = (v: ArrayLike<number>) => Array.from(v);

async function leadRows(rt: Rt, ids: string[]) {
  const out = new Map<string, { id: string; first_name: string | null; last_name: string | null; tier: string | null; status: string | null; revenue_band: string | null; bought: number; answers: string | null }>();
  for (let i = 0; i < ids.length; i += 80) {
    const part = ids.slice(i, i + 80);
    if (!part.length) continue;
    const { results } = await rt.env.DB.prepare(
      `SELECT l.id, l.first_name, l.last_name, COALESCE(l.tier_override, l.tier) AS tier, l.status, l.revenue_band, l.answers, ${BOUGHT_SQL} AS bought
         FROM leads l WHERE l.id IN (${part.map(() => '?').join(',')})`,
    ).bind(...part).all<{ id: string; first_name: string | null; last_name: string | null; tier: string | null; status: string | null; revenue_band: string | null; bought: number; answers: string | null }>();
    for (const r of results) out.set(r.id, r);
  }
  return out;
}

function business(answers: string | null) {
  try { const a = JSON.parse(answers || '{}') as Record<string, unknown>; return typeof a.business === 'string' ? a.business.slice(0, 120) : null; } catch { return null; }
}

/** Turn index matches on lead vectors into rows (D1 is the truth for names, status and bought). */
async function toLeadHits(rt: Rt, matches: { id: string; score: number }[], o: { exclude?: Set<string>; notBought?: boolean; k: number }): Promise<LeadHit[]> {
  const ids = matches.map((m) => m.id.startsWith('lead:') ? m.id.slice(5) : '').filter((id) => id && !o.exclude?.has(id));
  const rows = await leadRows(rt, ids);
  const out: LeadHit[] = [];
  for (const m of matches) {
    const id = m.id.slice(5);
    const r = rows.get(id);
    if (!r || o.exclude?.has(id)) continue; // deleted since it was indexed, or excluded
    const bought = Boolean(Number(r.bought));
    if (o.notBought && bought) continue;
    out.push({ id, score: Math.round(m.score * 1000) / 1000, name: [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Lead', tier: r.tier, status: r.status, band: r.revenue_band, bought, business: business(r.answers) });
    if (out.length >= o.k) break;
  }
  return out;
}

/** The lead's own vector: from the index, else embedded now from their answers (not stored). */
async function leadVector(rt: Rt, leadId: string): Promise<number[] | null> {
  const idx = vecIndex(rt)!;
  const got = await idx.getByIds([await vecId('lead', leadId)]);
  if (got[0]?.values?.length) return toArr(got[0].values);
  const l = await rt.env.DB.prepare('SELECT answers, industry, revenue_band, booking_answers, objection, lost_reason, target_business FROM leads WHERE id = ?').bind(leadId).first<Record<string, string | null>>();
  const text = l ? leadText(l as never) : '';
  if (text.length < 12) return null;
  const [v] = await embedder(rt, 'vector-search')!([text]);
  return v ?? null;
}

export async function similarLeads(rt: Rt, leadId: string, k = 8): Promise<{ ok: boolean; note?: string; leads: LeadHit[] }> {
  const why = unavailable(rt);
  if (why) return { ok: false, note: why, leads: [] };
  const v = await leadVector(rt, leadId);
  if (!v) return { ok: true, note: 'This lead has no application answers to compare yet.', leads: [] };
  const res = await vecIndex(rt)!.query(v, { topK: Math.min(50, k + 6), namespace: 'lead', returnMetadata: 'none' });
  return { ok: true, leads: await toLeadHits(rt, res.matches, { exclude: new Set([leadId]), k }) };
}

/** Recent buyers (most recent purchase first) that have a vector. */
export async function recentBuyers(rt: Rt, limit = 30): Promise<string[]> {
  const { results } = await rt.env.DB.prepare(
    `SELECT l.id FROM leads l JOIN vec_items v ON v.ns = 'lead' AND v.ref = l.id
      WHERE ${BOUGHT_SQL}
      ORDER BY MAX(COALESCE(l.closed_at, 0),
                   COALESCE((SELECT MAX(p.paid_at) FROM webinar_passes p WHERE p.lead_id = l.id AND p.kind IN ('offer', 'deposit') AND p.status = 'paid'), 0),
                   COALESCE((SELECT MAX(d.paid_at) FROM challenge_deposits d WHERE d.lead_id = l.id), 0),
                   l.updated_at) DESC
      LIMIT ?`,
  ).bind(limit).all<{ id: string }>();
  return results.map((r) => r.id);
}

/** "Leads like my buyers": the centroid of recent buyers' vectors, and the nearest leads who haven't bought. */
export async function buyerLookalikes(rt: Rt, k = 20): Promise<{ ok: boolean; note?: string; buyers: number; leads: LeadHit[] }> {
  const why = unavailable(rt);
  if (why) return { ok: false, note: why, buyers: 0, leads: [] };
  const buyers = await recentBuyers(rt);
  if (!buyers.length) return { ok: true, note: 'No buyers in the index yet. This list appears once a buyer’s application has been indexed.', buyers: 0, leads: [] };
  const idx = vecIndex(rt)!;
  const vs: number[][] = [];
  for (let i = 0; i < buyers.length; i += 20) {
    const ids = await Promise.all(buyers.slice(i, i + 20).map((b) => vecId('lead', b)));
    for (const v of await idx.getByIds(ids)) if (v.values?.length) vs.push(toArr(v.values));
  }
  const centre = meanVector(vs);
  if (!centre) return { ok: true, note: 'The buyers’ vectors are still being written to the index. Try again in a few minutes.', buyers: 0, leads: [] };
  const res = await idx.query(centre, { topK: 50, namespace: 'lead', returnMetadata: 'none' });
  return { ok: true, buyers: vs.length, leads: await toLeadHits(rt, res.matches, { exclude: new Set(buyers), notBought: true, k }) };
}

export interface SearchHit { kind: Ns; score: number; snippet: string; ref: string; leadId: string | null; leadName: string | null; roomId: string | null }
export const SEARCH_KINDS: Ns[] = ['q', 'note', 'lead'];

/** Search by meaning over room questions and objections, call notes and summaries, and lead answers. */
export async function semanticSearch(rt: Rt, q: string, o: { kinds?: Ns[]; k?: number } = {}): Promise<{ ok: boolean; note?: string; hits: SearchHit[] }> {
  const why = unavailable(rt);
  if (why) return { ok: false, note: why, hits: [] };
  const query = q.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (query.length < 3) return { ok: true, note: 'Type a few words.', hits: [] };
  const k = Math.min(20, o.k ?? 12);
  const [v] = await embedder(rt, 'vector-search')!([query]);
  const idx = vecIndex(rt)!;
  const kinds = (o.kinds ?? SEARCH_KINDS).filter((x) => x !== 'doc');
  const per = await Promise.all(kinds.map(async (ns) => (await idx.query(v, { topK: k, namespace: ns, returnMetadata: 'none' })).matches.map((m) => ({ ...m, ns }))));
  const top = per.flat().sort((a, b) => b.score - a.score).slice(0, k);
  if (!top.length) return { ok: true, hits: [] };
  const { results } = await rt.env.DB.prepare(`SELECT id, ns, ref, lead_id, snippet FROM vec_items WHERE id IN (${top.map(() => '?').join(',')})`).bind(...top.map((m) => m.id)).all<{ id: string; ns: Ns; ref: string; lead_id: string | null; snippet: string | null }>();
  const items = new Map(results.map((r) => [r.id, r]));
  const leads = await leadRows(rt, [...new Set(results.map((r) => r.lead_id).filter((x): x is string => Boolean(x)))]);
  const hits: SearchHit[] = [];
  for (const m of top) {
    const it = items.get(m.id);
    if (!it) continue;
    const l = it.lead_id ? leads.get(it.lead_id) : null;
    hits.push({
      kind: it.ns, score: Math.round(m.score * 1000) / 1000, snippet: it.snippet ?? '', ref: it.ref, leadId: l ? it.lead_id : null,
      leadName: l ? [l.first_name, l.last_name].filter(Boolean).join(' ') || 'Lead' : null,
      roomId: it.ns === 'q' ? it.ref.split('|')[0] || null : null,
    });
  }
  return { ok: true, hits };
}

/** Josh's approved material nearest to a question (doc vectors only), as the passages themselves. */
export async function retrieveDocs(rt: Runtime, question: string, k = 6): Promise<(Passage & { score: number })[] | null> {
  if (unavailable(rt)) return null;
  const [v] = await embedder(rt, 'room-helper')!([question.slice(0, 600)]);
  const res = await vecIndex(rt)!.query(v, { topK: k, namespace: 'doc', returnMetadata: 'none' });
  if (!res.matches.length) return null;
  const { results } = await rt.env.DB.prepare(`SELECT id, ref FROM vec_items WHERE ns = 'doc' AND id IN (${res.matches.map(() => '?').join(',')})`).bind(...res.matches.map((m) => m.id)).all<{ id: string; ref: string }>();
  const refOf = new Map(results.map((r) => [r.id, r.ref]));
  const byId = new Map((await knowledgeBase(rt)).map((p) => [p.id, p]));
  const out: (Passage & { score: number })[] = [];
  for (const m of res.matches) {
    const p = byId.get(refOf.get(m.id) ?? '');
    if (p) out.push({ ...p, score: m.score }); // a passage that no longer exists is never used
  }
  return out.length ? out : null;
}
