import type { Runtime } from '../app';
import { embedder, isLocalOnlyError, vecIndex } from '../vectors/core';

/**
 * The brain's retrieval (the contract Radar and Studio code against; see src/radar/brain-provider.ts):
 *
 *  brainSearch(rt, query, {k, scope})  hybrid search: FTS5 BM25 over chunks (title and heading weighted up) and,
 *                                       once chunks are embedded, Vectorize similarity, fused with reciprocal rank
 *                                       fusion; then graph expansion: personalized PageRank seeded from the best
 *                                       pages over the typed edges, hub-damped, blended with the lexical score and a
 *                                       small global-PageRank prior; the best lexical page is pinned first (the
 *                                       tricks that scored best in the brain's own retrieval loop). One hit per page.
 *  legendCards(rt, task, n)             the n legends most relevant to the task, each compressed into principles and
 *                                       techniques from its own chunks (deterministic, no model), at most 900 chars.
 *  glFacts(rt)                          the verified G&L facts (cited, no doubt mark) as a compact prompt block.
 *
 * Every function returns []/'' fast when the brain is not loaded (tables empty or missing), so tests and local dev
 * behave exactly as before.
 */

export type BrainScope = 'copy' | 'gl' | 'all';
export interface BrainHit { id: string; title: string; path: string; section?: string; snippet: string; score: number; legend?: string; page?: string; kind?: string }
export interface LegendCard { legend: string; page: string; principles: string[]; techniques: string[]; id?: string }

const SCOPES: Record<BrainScope, string[]> = {
  copy: ['engine/copy', 'engine/persuasion', 'engine/vsl', 'engine/webinar'],
  gl: ['ventures/gl'],
  all: [],
};
export const inScopeFolder = (folder: string, scope: BrainScope) => !SCOPES[scope].length || SCOPES[scope].some((p) => folder === p || folder.startsWith(`${p}/`));
const scopeSql = (scope: BrainScope) => (SCOPES[scope].length ? `(${SCOPES[scope].map((p) => `p.folder = '${p}' OR p.folder LIKE '${p}/%'`).join(' OR ')})` : '1 = 1');
export const asScope = (v: unknown): BrainScope => (v === 'copy' || v === 'gl' || v === 'all' ? v : 'all');

// Tuning (from tools/graph/RESULTS.md in the brain: PPR from the top 3 hits, damping 0.5, hub damping 0.5, 50/50 blend).
const RRF_K = 60;
const SEEDS = 3;
const PPR_ALPHA = 0.5;
const BLEND = 0.5;
const HUB = 0.5;
const PRIOR = 0.05;
export const VEC_NS = 'brain';
export const vecIdOf = (chunkId: string) => `brain:${chunkId}`;

const STOP = new Set('a an and are as at be by for from has have how i in is it its of on or that the this to was what which who why with does do did can should would about into than then them they their there these those our your you we my me us not no yes will just more most very so if but all any some one two get got make made use using like want need'.split(' '));

/** Query words for FTS5 (quoted, OR'ed; the porter tokenizer stems both sides). */
export function queryTerms(q: string): string[] {
  const out: string[] = [];
  for (const w of String(q ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]+/g) ?? []) {
    if (w.length < 2 || STOP.has(w) || out.includes(w)) continue;
    out.push(w);
    if (out.length >= 24) break;
  }
  return out;
}
const ftsQuery = (terms: string[]) => terms.map((t) => `"${t}"`).join(' OR ');

// ───────────── is there a brain? (one cheap query, cached briefly per database binding) ─────────────

interface BuildInfo { build_id: string; built_at: string; source?: string; pages?: number; chunks?: number; edges?: number; legends?: number }
const present = new WeakMap<object, { at: number; info: BuildInfo | null }>();
const TTL_MS = 60_000;

export async function brainBuild(rt: Pick<Runtime, 'env'>): Promise<BuildInfo | null> {
  const db = rt.env.DB as unknown as object;
  const hit = present.get(db);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.info;
  let info: BuildInfo | null = null;
  try {
    const row = await rt.env.DB.prepare("SELECT value FROM kv_state WHERE key = 'brain:build'").first<{ value: string }>();
    if (row?.value) {
      const n = await rt.env.DB.prepare('SELECT 1 AS x FROM brain_chunks LIMIT 1').first<{ x: number }>();
      info = n ? (JSON.parse(row.value) as BuildInfo) : null;
    }
  } catch { info = null; }
  present.set(db, { at: Date.now(), info });
  return info;
}
/** Tests and the seed route call this after loading rows. */
export function forgetBrainCache() { graphs.clear(); }

// ───────────── the page graph (loaded once per build) ─────────────

interface GPage { id: string; title: string; path: string; folder: string; legend: string | null; pagerank: number }
interface Graph { pages: Map<string, GPage>; adj: Map<string, Map<string, number>>; maxPr: number }
const graphs = new Map<string, Graph>();

async function loadGraph(rt: Pick<Runtime, 'env'>, buildId: string): Promise<Graph> {
  const cached = graphs.get(buildId);
  if (cached) return cached;
  const [pr, er] = await Promise.all([
    rt.env.DB.prepare('SELECT id, title, path, folder, legend, pagerank FROM brain_pages').all<GPage>(),
    rt.env.DB.prepare('SELECT src, dst, weight FROM brain_edges').all<{ src: string; dst: string; weight: number }>(),
  ]);
  const pages = new Map(pr.results.map((p) => [p.id, p]));
  const adj = new Map<string, Map<string, number>>();
  for (const e of er.results) {
    if (!pages.has(e.src) || !pages.has(e.dst)) continue;
    let m = adj.get(e.src);
    if (!m) adj.set(e.src, (m = new Map()));
    m.set(e.dst, (m.get(e.dst) ?? 0) + Number(e.weight || 0));
  }
  const g = { pages, adj, maxPr: Math.max(1e-9, ...pr.results.map((p) => Number(p.pagerank) || 0)) };
  if (graphs.size > 4) graphs.clear();
  graphs.set(buildId, g);
  return g;
}

/** Personalized PageRank: restart to the seeds with probability 1 - alpha, else follow a weighted edge. */
export function personalizedPageRank(seeds: Map<string, number>, adj: Map<string, Map<string, number>>, alpha = PPR_ALPHA, iters = 30): Map<string, number> {
  const tot = [...seeds.values()].reduce((a, b) => a + b, 0) || 1;
  const p = new Map([...seeds].map(([k, v]) => [k, v / tot]));
  let r = new Map(p);
  for (let i = 0; i < iters; i++) {
    const nx = new Map<string, number>();
    for (const [u, ru] of r) {
      const out = adj.get(u);
      if (!out || !out.size) { nx.set(u, (nx.get(u) ?? 0) + alpha * ru); continue; }
      let w = 0; for (const x of out.values()) w += x;
      for (const [v, x] of out) nx.set(v, (nx.get(v) ?? 0) + (alpha * ru * x) / w);
    }
    for (const [s, v] of p) nx.set(s, (nx.get(s) ?? 0) + (1 - alpha) * v);
    r = nx;
  }
  return r;
}

// ───────────── search ─────────────

interface ChunkRow { id: string; page_id: string; heading: string | null; text: string; legend: string | null; kind: string; s?: number }

async function ftsChunks(rt: Pick<Runtime, 'env'>, terms: string[], scope: BrainScope, limit: number, legendsOnly = false): Promise<ChunkRow[]> {
  if (!terms.length) return [];
  const sql = `SELECT c.id, c.page_id, c.heading, c.text, c.legend, c.kind, -bm25(brain_fts, 3.0, 2.0, 1.0, 1.0) AS s
    FROM brain_fts JOIN brain_chunks c ON c.rowid = brain_fts.rowid JOIN brain_pages p ON p.id = c.page_id
    WHERE brain_fts MATCH ? AND ${scopeSql(scope)}${legendsOnly ? ' AND c.legend IS NOT NULL' : ''}
    ORDER BY s DESC LIMIT ?`;
  try { return (await rt.env.DB.prepare(sql).bind(ftsQuery(terms), limit).all<ChunkRow>()).results; } catch (e) { console.error('brain fts failed', String((e as Error)?.message ?? e).slice(0, 200)); return []; }
}

const embeddedCount = new WeakMap<object, { at: number; n: number }>();
async function hasEmbeddings(rt: Pick<Runtime, 'env'>): Promise<boolean> {
  const db = rt.env.DB as unknown as object;
  const c = embeddedCount.get(db);
  if (c && c.n > 0 && Date.now() - c.at < TTL_MS) return true; // only a yes is cached: the first embeddings show up at once
  const r = await rt.env.DB.prepare('SELECT COUNT(*) AS n FROM brain_chunks WHERE embedded_hash IS NOT NULL').first<{ n: number }>().catch(() => null);
  embeddedCount.set(db, { at: Date.now(), n: Number(r?.n ?? 0) });
  return Number(r?.n ?? 0) > 0;
}

/** Vector hits (chunk ids, best first), or [] when Vectorize or Workers AI is not here or nothing is embedded yet. */
async function vectorChunks(rt: Pick<Runtime, 'env' | 'settings'>, query: string, scope: BrainScope, limit: number, legendsOnly = false): Promise<ChunkRow[]> {
  const idx = vecIndex(rt);
  const emb = embedder(rt, 'brain-search');
  if (!idx || !emb || !query.trim() || !(await hasEmbeddings(rt))) return [];
  try {
    const [v] = await emb([query.slice(0, 1000)]);
    const res = await idx.query(v, { topK: Math.min(50, limit), namespace: VEC_NS, returnMetadata: 'none' });
    const ids = res.matches.map((m) => String(m.id).replace(/^brain:/, ''));
    if (!ids.length) return [];
    const rows = (await rt.env.DB.prepare(`SELECT c.id, c.page_id, c.heading, c.text, c.legend, c.kind FROM brain_chunks c JOIN brain_pages p ON p.id = c.page_id
      WHERE c.id IN (${ids.map(() => '?').join(', ')}) AND ${scopeSql(scope)}${legendsOnly ? ' AND c.legend IS NOT NULL' : ''}`).bind(...ids).all<ChunkRow>()).results;
    const at = new Map(ids.map((id, i) => [id, i]));
    return rows.sort((a, b) => (at.get(a.id) ?? 0) - (at.get(b.id) ?? 0)); // stale vectors (chunks gone since) drop out here
  } catch (e) {
    if (!isLocalOnlyError(e)) console.error('brain vector search failed', String((e as Error)?.message ?? e).slice(0, 200));
    return [];
  }
}

/** Reciprocal rank fusion of ranked lists of chunks. */
export function rrf(lists: ChunkRow[][], k = RRF_K): Map<string, { row: ChunkRow; score: number }> {
  const out = new Map<string, { row: ChunkRow; score: number }>();
  for (const list of lists) list.forEach((row, i) => {
    const cur = out.get(row.id);
    out.set(row.id, { row, score: (cur?.score ?? 0) + 1 / (k + i + 1) });
  });
  return out;
}

const plain = (s: string) => s.replace(/\*\*|__|`/g, '').replace(/^\s*[-*]\s+/gm, '').replace(/\s+/g, ' ').trim();

/** A ~280 character window around the first query word the text contains. */
export function snippetFor(text: string, terms: string[], n = 280): string {
  const t = plain(text);
  if (t.length <= n) return t;
  const low = t.toLowerCase();
  let at = -1;
  for (const w of terms) { const i = low.indexOf(w.length > 4 ? w.slice(0, Math.max(4, w.length - 2)) : w); if (i >= 0 && (at < 0 || i < at)) at = i; }
  let start = at < 0 ? 0 : Math.max(0, at - 60);
  if (start > 0) { const dot = t.lastIndexOf('. ', at); start = dot >= start - 80 && dot >= 0 && dot < at ? dot + 2 : start; }
  const s = t.slice(start, start + n);
  const cut = s.lastIndexOf(' ');
  return `${start > 0 ? '...' : ''}${(start + n < t.length && cut > n * 0.6 ? s.slice(0, cut) : s).trim()}${start + n < t.length ? '...' : ''}`;
}

const overlap = (text: string, terms: string[]) => { const low = text.toLowerCase(); return terms.reduce((n, w) => n + (low.includes(w.length > 4 ? w.slice(0, w.length - 2) : w) ? 1 : 0), 0); };

export async function brainSearch(rt: Pick<Runtime, 'env' | 'settings'>, query: string, o: { k?: number; scope?: BrainScope } = {}): Promise<BrainHit[]> {
  const k = Math.max(1, Math.min(20, o.k ?? 6));
  const scope = o.scope ?? 'all';
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const build = await brainBuild(rt);
  if (!build) return [];
  const [lex, vec] = await Promise.all([ftsChunks(rt, terms, scope, 40), vectorChunks(rt, query, scope, 30)]);
  if (!lex.length && !vec.length) return [];
  const fused = rrf([lex, vec].filter((l) => l.length));

  // Page scores: the best chunk per page (lexical/vector fused); keep the best chunk to show.
  const best = new Map<string, { row: ChunkRow; score: number }>();
  for (const x of fused.values()) { const cur = best.get(x.row.page_id); if (!cur || x.score > cur.score) best.set(x.row.page_id, x); }
  const ranked = [...best.entries()].sort((a, b) => b[1].score - a[1].score);
  const mx = ranked[0][1].score;

  const g = await loadGraph(rt, build.build_id);
  const seeds = new Map(ranked.slice(0, SEEDS).map(([p, x]) => [p, x.score / mx]));
  const ppr = personalizedPageRank(seeds, g.adj);
  const damped = new Map<string, number>();
  for (const [p, v] of ppr) damped.set(p, v / Math.max(1, g.adj.get(p)?.size ?? 0) ** HUB);
  const rmx = Math.max(1e-12, ...damped.values());
  const final = new Map<string, number>();
  for (const p of new Set([...best.keys(), ...damped.keys()])) {
    const page = g.pages.get(p);
    if (!page || !inScopeFolder(page.folder, scope)) continue;
    final.set(p, (1 - BLEND) * ((best.get(p)?.score ?? 0) / mx) + BLEND * ((damped.get(p) ?? 0) / rmx) + PRIOR * ((Number(page.pagerank) || 0) / g.maxPr));
  }
  const top = ranked[0][0];
  const order = [...final.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p).filter((p) => p !== top);
  if (final.has(top)) order.unshift(top); // the best lexical page always leads; the graph fills the rest
  const pick = order.slice(0, k);

  // Pages reached only through the graph show their chunk with the most query words (or their first one).
  const missing = pick.filter((p) => !best.has(p));
  if (missing.length) {
    const rows = (await rt.env.DB.prepare(`SELECT id, page_id, heading, text, legend, kind FROM brain_chunks WHERE page_id IN (${missing.map(() => '?').join(', ')}) ORDER BY ord`).bind(...missing).all<ChunkRow>()).results;
    for (const p of missing) {
      const mine = rows.filter((r) => r.page_id === p);
      if (!mine.length) continue;
      const row = mine.reduce((a, b) => (overlap(b.text, terms) > overlap(a.text, terms) ? b : a), mine[0]);
      best.set(p, { row, score: 0 });
    }
  }
  const out: BrainHit[] = [];
  for (const p of pick) {
    const x = best.get(p); const page = g.pages.get(p);
    if (!x || !page) continue;
    out.push({
      id: x.row.id, title: page.title, path: page.path, ...(x.row.heading ? { section: x.row.heading } : {}),
      snippet: snippetFor(x.row.text, terms), score: Number((final.get(p) ?? 0).toFixed(4)),
      ...(page.legend ? { legend: page.legend } : {}), page: p, kind: x.row.kind,
    });
  }
  return out;
}

// ───────────── legend cards ─────────────

const CARD_MAX = 900;

/** Top-level bullets of a chunk, compressed: "Name: first sentence", markdown and doubt-marked lines dropped. */
export function bullets(text: string): string[] {
  const out: string[] = [];
  for (const b of text.split(/\n(?=[-*]\s|\d+\.\s)/)) {
    if (!/^([-*]|\d+\.)\s/.test(b) || /unverified/i.test(b)) continue;
    let t = b.replace(/^([-*]|\d+\.)\s+/, '').split('\n')[0];
    const named = /^\*\*([^*]{2,70}?)[:.]?\*\*[:.]?\s*(.*)$/.exec(t);
    t = named ? `${named[1].replace(/[:.;,\s]+$/, '')}: ${named[2]}` : t;
    t = plain(t).replace(/:\s*$/, '');
    const dot = t.search(/[.;](\s|$)/);
    if (dot > 40) t = t.slice(0, dot + 1);
    if (t.length > 170) t = `${t.slice(0, 167).replace(/\s+\S*$/, '')}...`;
    if (t.length >= 12) out.push(t);
  }
  return out;
}

/** Principles and techniques of one legend page from its chunks, task-relevant bullets first, at most 900 chars. */
export function compressLegend(legend: string, page: string, chunks: { heading: string | null; text: string; kind: string }[], terms: string[], id?: string): LegendCard {
  const principles: string[] = [], techniques: string[] = [];
  for (const c of chunks) {
    if (c.kind === 'fact') continue;
    const list = c.kind === 'technique' || /steal|technique|method|template|formula|skeleton|structure/i.test(c.heading ?? '') ? techniques : c.kind === 'principle' || c.kind === 'rule' ? principles : null;
    if (list) list.push(...bullets(c.text));
  }
  const rank = (xs: string[]) => xs.map((x, i) => ({ x, i, o: overlap(x, terms) })).sort((a, b) => b.o - a.o || a.i - b.i).map((r) => r.x);
  const P = rank([...new Set(principles)]), T = rank([...new Set(techniques)]);
  const card: LegendCard = { legend, page, principles: [], techniques: [], ...(id ? { id } : {}) };
  let size = JSON.stringify(card).length; // the cap is on the card as the prompt and the API carry it
  for (let i = 0; i < 5; i++) {
    for (const [src, dst] of [[P, card.principles], [T, card.techniques]] as const) {
      const x = src[i];
      const add = x ? JSON.stringify(x).length + 1 : 0;
      if (x && size + add <= CARD_MAX) { dst.push(x); size += add; }
    }
  }
  return card;
}

export async function legendCards(rt: Pick<Runtime, 'env' | 'settings'>, task: string, n = 3): Promise<LegendCard[]> {
  const want = Math.max(1, Math.min(20, n));
  const build = await brainBuild(rt);
  if (!build) return [];
  const terms = queryTerms(task);
  const [lex, vec] = await Promise.all([ftsChunks(rt, terms, 'all', 80, true), terms.length ? vectorChunks(rt, task, 'all', 40, true) : Promise.resolve([])]);
  const fused = rrf([lex, vec].filter((l) => l.length));
  // A legend's relevance: the sum of its best three chunk scores (one lucky chunk should not win).
  const per = new Map<string, number[]>();
  for (const x of fused.values()) if (x.row.legend) per.set(x.row.page_id, [...(per.get(x.row.page_id) ?? []), x.score]);
  const scored = [...per.entries()].map(([p, xs]) => [p, xs.sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0)] as const).sort((a, b) => b[1] - a[1]).map(([p]) => p);
  const all = (await rt.env.DB.prepare('SELECT id, title, legend FROM brain_pages WHERE legend IS NOT NULL ORDER BY pagerank DESC, id').all<{ id: string; title: string; legend: string }>()).results;
  const ids = [...new Set([...scored, ...all.map((p) => p.id)])].slice(0, want); // too few matches: fill with the most linked legends
  if (!ids.length) return [];
  const rows = (await rt.env.DB.prepare(`SELECT page_id, heading, text, kind FROM brain_chunks WHERE page_id IN (${ids.map(() => '?').join(', ')}) ORDER BY page_id, ord`).bind(...ids).all<{ page_id: string; heading: string | null; text: string; kind: string }>()).results;
  const meta = new Map(all.map((p) => [p.id, p]));
  return ids.map((id) => compressLegend(meta.get(id)?.legend ?? id, meta.get(id)?.title ?? id, rows.filter((r) => r.page_id === id), terms, id)).filter((c) => c.principles.length || c.techniques.length);
}

// ───────────── verified G&L facts ─────────────

const FACTS_MAX = 1500;
const FOLDER_RANK = ['ventures/gl/people', 'ventures/gl/business', 'ventures/gl/deals', 'ventures/gl/offers', 'ventures/gl/icp', 'ventures/gl'];

export async function glFacts(rt: Pick<Runtime, 'env'>, max = FACTS_MAX): Promise<string> {
  const build = await brainBuild(rt);
  if (!build) return '';
  const rows = (await rt.env.DB.prepare(`SELECT c.tags_json, p.folder, p.pagerank, c.ord FROM brain_chunks c JOIN brain_pages p ON p.id = c.page_id
    WHERE (p.folder = 'ventures/gl' OR p.folder LIKE 'ventures/gl/%') AND c.tags_json LIKE '%"facts"%'`).all<{ tags_json: string; folder: string; pagerank: number; ord: number }>().catch(() => ({ results: [] }))).results;
  const rank = (f: string) => { const i = FOLDER_RANK.indexOf(f); return i < 0 ? FOLDER_RANK.length : i; };
  rows.sort((a, b) => rank(a.folder) - rank(b.folder) || b.pagerank - a.pagerank || a.ord - b.ord);
  const lines: string[] = [];
  let size = 0;
  const seen = new Set<string>();
  for (const r of rows) {
    let facts: string[] = [];
    try { facts = (JSON.parse(r.tags_json) as { facts?: string[] }).facts ?? []; } catch { /* skip */ }
    for (const f of facts) {
      const key = f.toLowerCase().slice(0, 60);
      if (seen.has(key) || size + f.length + 3 > max) continue;
      seen.add(key); lines.push(`- ${f}`); size += f.length + 3;
    }
  }
  return lines.join('\n');
}
