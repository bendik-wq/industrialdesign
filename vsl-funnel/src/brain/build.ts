/**
 * The brain loader's pure core (no imports, no I/O): wiki pages in, a typed knowledge graph out, plus the SQL that
 * seeds it into D1. scripts/brain/build.mjs reads the files from the private brain checkout and calls this through
 * Node's type stripping; the tests call it on a tiny synthetic wiki (test/fixtures/brain-synthetic).
 *
 * PRIVACY: only wiki/engine/** and wiki/ventures/gl/** are ever read (inScope). The output (snapshot and seed SQL)
 * goes to the gitignored .brain/ folder and from there into D1 at deploy; brain text never enters a tracked file.
 *
 * Parsing follows the brain's page rules: `# Title`, a 1 to 2 sentence summary, `## headings`, bullets, `[[links]]`,
 * `(src: ...)` refs and **unverified** marks. Chunks follow the headings (~600 to 1,200 characters). Edges: wiki
 * links (links_to), their reverse (backlink), pages in the same folder (sibling) and pages pointing at their
 * folder's hub (part_of). PageRank runs over the directed links.
 */

export interface BrainFile { path: string; text: string }
export type ChunkKind = 'principle' | 'technique' | 'example' | 'fact' | 'rule';
export type EdgeType = 'links_to' | 'backlink' | 'sibling' | 'part_of';

export interface BrainPage {
  id: string; path: string; title: string; summary: string; folder: string; legend: string | null;
  pagerank: number; links: string[]; headings: string[];
}
export interface BrainChunk {
  id: string; page_id: string; ord: number; title: string; heading: string; text: string; kind: ChunkKind;
  tags: { techniques: string[]; links: string[]; src: string[]; unverified: boolean; facts?: string[] };
  legend: string | null; verified: boolean; hash: string;
}
export interface BrainEdge { src: string; dst: string; type: EdgeType; weight: number }
export interface BrainSnapshot {
  build_id: string; built_at: string; source: string;
  pages: BrainPage[]; chunks: BrainChunk[]; edges: BrainEdge[];
  stats: { pages: number; chunks: number; edges: number; legends: number; by_kind: Record<string, number>; by_edge: Record<string, number> };
}

/** The only folders (relative to wiki/) the brain may contribute. Everything else (personal, other ventures) is skipped. */
export const SCOPE_PREFIXES = ['engine/', 'ventures/gl/'] as const;
export const inScope = (rel: string) => rel.endsWith('.md') && !rel.split('/').some((p) => p.startsWith('.')) && SCOPE_PREFIXES.some((p) => rel.startsWith(p));

/** Edge weights for graph expansion (a link is the strongest signal, a shared folder the weakest). */
export const EDGE_WEIGHT: Record<EdgeType, number> = { links_to: 1, backlink: 0.6, part_of: 0.8, sibling: 0.25 };

export const CHUNK_MIN = 600;
export const CHUNK_MAX = 1200;

const LINK = /\[\[([^\]|#]+)(?:[|#]([^\]]*))?\]\]/g;
const SRC = /\(\s*src:\s*([^)]*)\)/gi;
const UNVERIFIED = /\*\*unverified\*\*|\bunverified\b/i;
/** A G&L bullet is a usable fact only when it cites a source and carries no doubt mark. */
const DOUBT = /unverified|assum|guess|consent|permission|not a client|\bclaim|cut from|swear|smok|\bfriend|named in|\bposts? (say|call|describe)|\[?confirm\]|unresolved|conflict|proposed|\btodo\b|\btbd\b|placeholder|illustrative|estimate|not yet|unknown|\?\s*$/i;
/** Build notes (links, branches, sessions, artifacts) are not facts about the business. */
const INTERNAL = /https?:\/\/|`|\bartifact|\bsession|\bbranch|\brepo\b|\bscratchpad|\bv\d+\b/i;
const CITED = /\(\s*(src:|same src)/i;
const SKIP_HEADINGS = /^(sources?|related|see also|links)$/i;

// ───────────── small helpers ─────────────

/** FNV-1a 32-bit, twice with different seeds: a stable short hash for ids and change detection (not security). */
export function hash(s: string): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

const stem = (path: string) => path.split('/').pop()!.replace(/\.md$/, '');
const folderOf = (rel: string) => rel.split('/').slice(0, -1).join('/');
const squashWs = (s: string) => s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

/** Wiki markdown to prompt text: links become their label, source refs go (they are kept in tags), bold stays. */
export function cleanText(s: string): string {
  return squashWs(s.replace(SRC, '').replace(/\(\s*same src[^)]*\)/gi, '').replace(LINK, (_m, target: string, label?: string) => (label && !/^#/.test(label) ? label : target).trim()).replace(/[ \t]+([.,;:])/g, '$1'));
}

const linksIn = (s: string) => [...s.matchAll(LINK)].map((m) => m[1].trim());
const srcsIn = (s: string) => [...s.matchAll(SRC)].flatMap((m) => m[1].split(/[,;]\s*|\s+·\s+/)).map((x) => x.trim().replace(/[.]$/, '')).filter(Boolean);

/** Technique names: the bold lead of a bullet ("- **Starving crowd:** ...") or a bold phrase that names a move. */
export function techniqueNames(s: string): string[] {
  const out = new Set<string>();
  for (const m of s.matchAll(/^\s*(?:[-*]|\d+\.)\s+\*\*([^*]{3,60}?)\*\*/gm)) {
    const name = m[1].replace(/[:.;,\s]+$/, '').trim();
    if (name && !/^(unverified|note|src)$/i.test(name)) out.add(name);
  }
  return [...out].slice(0, 12);
}

/** What a section is, from its heading first and its page second. */
export function kindOf(heading: string, folder: string): ChunkKind {
  const h = heading.toLowerCase();
  if (/worked example|\bexamples?\b|\bcase\b|swipe|sample|applying|in practice|for g&l|acquisition-offer/.test(h)) return 'example';
  if (/\brules?\b|checklist|never|must|ethic|compliance|claims|proof|guardrail|don'?ts?\b|avoid/.test(h)) return 'rule';
  if (/what to steal|technique|method|framework|template|formula|skeleton|structure|steps|how to|script|\blead\b|hooks?\b|close|pattern|sequence|playbook|beat|patterns|moves|tactic/.test(h)) return 'technique';
  if (/\bwho\b|track record|facts?\b|background|history|numbers|deals?\b|people|pricing|price|status|timeline|origin|founder|team|portfolio|stack/.test(h)) return 'fact';
  if (/core idea|principle|idea|belief|lesson|insight|\bwhy\b|model|thesis|truth/.test(h)) return 'principle';
  return folder.startsWith('ventures/') ? 'fact' : 'principle';
}

/** The legend a page is about: pages under engine/copy/legends/ except the hub (the folder's index page). */
export function legendOf(rel: string, title: string): string | null {
  if (!/(^|\/)legends\/[^/]+\.md$/.test(rel)) return null;
  const s = stem(rel);
  if (/legends$|^index$|^readme$/i.test(s)) return null;
  return title.replace(/\s*[(:].*$/, '').trim() || s;
}

/** Verified fact bullets (G&L pages): cited, no doubt mark, cleaned and cut to one or two sentences. */
export function factBullets(body: string): string[] {
  const out: string[] = [];
  for (const b of body.split(/\n(?=\s{0,1}[-*]\s)/)) {
    const line = b.replace(/^\s*[-*]\s+/, '').replace(/\n\s*/g, ' ').trim();
    if (!/^\s*[-*]\s/.test(b) || !CITED.test(line) || DOUBT.test(line) || INTERNAL.test(line.replace(SRC, ''))) continue;
    let t = cleanText(line).replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
    if (t.length > 260) { const cut = t.lastIndexOf('. ', 260); t = cut > 80 ? t.slice(0, cut + 1) : `${t.slice(0, 257).trim()}...`; }
    if (t.length >= 20) out.push(t);
  }
  return out;
}

// ───────────── one page ─────────────

interface Section { heading: string; level: number; body: string[] }

export interface ParsedPage { id: string; rel: string; title: string; summary: string; headings: string[]; links: string[]; sections: Section[] }

export function parsePage(rel: string, raw: string): ParsedPage {
  let text = raw.replace(/\r/g, '');
  if (text.startsWith('---\n')) { const end = text.indexOf('\n---', 4); if (end > 0) text = text.slice(end + 4); }
  const lines = text.split('\n');
  const titleLine = lines.find((l) => /^#\s/.test(l));
  const title = titleLine ? titleLine.replace(/^#\s+/, '').trim() : stem(rel);
  const sections: Section[] = [{ heading: '', level: 1, body: [] }];
  let fence = false;
  for (const l of lines) {
    if (/^```/.test(l)) fence = !fence;
    if (!fence && l === titleLine) continue;
    const h = !fence && /^(#{2,4})\s+(.*)$/.exec(l);
    if (h) { sections.push({ heading: h[2].trim(), level: h[1].length, body: [] }); continue; }
    sections[sections.length - 1].body.push(l);
  }
  const intro = sections[0].body.filter((l) => l.trim());
  const firstPara = intro.find((l) => !/^\s*[-*|>]/.test(l)) ?? intro[0] ?? '';
  return {
    id: stem(rel), rel, title,
    summary: cleanText(firstPara).slice(0, 400),
    headings: sections.slice(1).filter((s) => s.level === 2).map((s) => s.heading),
    links: [...new Set(linksIn(text))],
    sections,
  };
}

/** Split one section's lines into pieces of at most CHUNK_MAX characters, at bullet or paragraph boundaries. */
function splitBody(lines: string[]): string[] {
  const blocks: string[] = [];
  let cur: string[] = [];
  const flush = () => { if (cur.some((l) => l.trim())) blocks.push(cur.join('\n')); cur = []; };
  for (const l of lines) {
    // A new top-level bullet, a numbered item or a blank line starts a new block (sub-bullets stay with their parent).
    if (/^([-*]|\d+\.)\s/.test(l) || !l.trim()) flush();
    if (l.trim()) cur.push(l);
  }
  flush();
  const out: string[] = [];
  let acc = '';
  for (const b0 of blocks) {
    let b = b0;
    while (b.length > CHUNK_MAX) { // one huge block (a long table or paragraph): cut at a line or sentence end
      const cut = Math.max(b.lastIndexOf('\n', CHUNK_MAX), b.lastIndexOf('. ', CHUNK_MAX));
      const at = cut > CHUNK_MIN / 2 ? cut + 1 : CHUNK_MAX;
      if (acc) { out.push(acc); acc = ''; }
      out.push(b.slice(0, at).trim()); b = b.slice(at).trim();
    }
    if (acc && acc.length + b.length + 1 > CHUNK_MAX) { out.push(acc); acc = ''; }
    acc = acc ? `${acc}\n${b}` : b;
  }
  if (acc) out.push(acc);
  return out;
}

interface RawChunk { heading: string; body: string }

/** Sections to chunks: big sections split, small neighbours merged up to CHUNK_MIN (never across a level-2 heading's kind change). */
export function chunkPage(p: ParsedPage, folder = ''): RawChunk[] {
  const pieces: RawChunk[] = [];
  let h2 = '';
  for (const s of p.sections) {
    if (s.level === 2) h2 = s.heading;
    const heading = s.level <= 1 ? '' : s.level === 2 ? s.heading : `${h2} › ${s.heading}`;
    if (SKIP_HEADINGS.test((s.level === 2 ? s.heading : h2).trim())) continue;
    for (const body of splitBody(s.body)) pieces.push({ heading, body });
  }
  const merged: RawChunk[] = [];
  for (const c of pieces) {
    const last = merged[merged.length - 1];
    const sameTop = last && last.heading.split(' › ')[0] === c.heading.split(' › ')[0];
    const fits = last && last.body.length + c.body.length + 1 <= CHUNK_MAX;
    if (last && sameTop && last.body.length < CHUNK_MIN && fits) {
      last.body = `${last.body}\n${c.heading !== last.heading && c.heading.includes(' › ') ? `${c.heading.split(' › ')[1]}:\n` : ''}${c.body}`;
    } else if (last && fits && (last.body.length < CHUNK_MIN / 2 || c.body.length < CHUNK_MIN / 4) && last.heading && kindOf(last.heading, folder) === kindOf(c.heading, folder)) {
      // A tiny section joins a neighbour of the same kind under both headings (a 200-character chunk retrieves badly alone).
      last.heading = `${last.heading} · ${c.heading.split(' › ')[0]}`;
      last.body = `${last.body}\n${c.heading.split(' › ')[0]}:\n${c.body}`;
    } else merged.push({ ...c });
  }
  return merged;
}

// ───────────── the whole graph ─────────────

/** PageRank over directed links (dangling pages spread evenly), damping 0.85, normalised to sum 1. */
export function pagerank(ids: string[], links: [string, string][], damping = 0.85, iters = 50): Record<string, number> {
  const n = ids.length;
  if (!n) return {};
  const out: Record<string, string[]> = {};
  for (const id of ids) out[id] = [];
  for (const [a, b] of links) if (out[a] && out[b] && a !== b && !out[a].includes(b)) out[a].push(b);
  let r: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 1 / n]));
  for (let k = 0; k < iters; k++) {
    const nx: Record<string, number> = Object.fromEntries(ids.map((id) => [id, (1 - damping) / n]));
    let dangling = 0;
    for (const id of ids) {
      if (!out[id].length) { dangling += r[id]; continue; }
      const share = (damping * r[id]) / out[id].length;
      for (const t of out[id]) nx[t] += share;
    }
    for (const id of ids) nx[id] += (damping * dangling) / n;
    r = nx;
  }
  return r;
}

export function buildBrain(files: BrainFile[], o: { builtAt?: string; source?: string } = {}): BrainSnapshot {
  const scoped = files.filter((f) => inScope(f.path)).sort((a, b) => a.path.localeCompare(b.path));
  const parsed: ParsedPage[] = [];
  const seen = new Set<string>();
  for (const f of scoped) {
    const p = parsePage(f.path, f.text);
    if (seen.has(p.id)) p.id = `${folderOf(f.path).replace(/\//g, '-')}-${p.id}`; // page names are unique in the brain; guard anyway
    seen.add(p.id);
    parsed.push(p);
  }
  const ids = new Set(parsed.map((p) => p.id));
  const byId = new Map(parsed.map((p) => [p.id, p]));

  // Edges: one per (src, dst, type).
  const edges: BrainEdge[] = [];
  const key = new Set<string>();
  const add = (src: string, dst: string, type: EdgeType) => {
    if (src === dst) return;
    const k = `${src}|${dst}|${type}`;
    if (key.has(k)) return;
    key.add(k); edges.push({ src, dst, type, weight: EDGE_WEIGHT[type] });
  };
  const directed: [string, string][] = [];
  for (const p of parsed) {
    const folder = folderOf(p.rel);
    const hubName = folder.split('/').pop() ?? '';
    for (const t of p.links) {
      if (!ids.has(t) || t === p.id) continue;
      directed.push([p.id, t]);
      const tf = folderOf(byId.get(t)!.rel);
      // A page that links to its own folder's hub (the page named like the folder, or the legends hub) is part of it.
      add(p.id, t, tf === folder && (t === hubName || /legends$/.test(t)) ? 'part_of' : 'links_to');
      add(t, p.id, 'backlink');
    }
  }
  const byFolder = new Map<string, string[]>();
  for (const p of parsed) { const f = folderOf(p.rel); byFolder.set(f, [...(byFolder.get(f) ?? []), p.id]); }
  for (const list of byFolder.values()) for (const a of list) for (const b of list) if (a !== b) add(a, b, 'sibling');

  const pr = pagerank(parsed.map((p) => p.id), directed);
  const pages: BrainPage[] = parsed.map((p) => ({
    id: p.id, path: `wiki/${p.rel}`, title: p.title, summary: p.summary, folder: folderOf(p.rel),
    legend: legendOf(p.rel, p.title), pagerank: Number((pr[p.id] ?? 0).toFixed(6)),
    links: p.links.filter((l) => ids.has(l) && l !== p.id), headings: p.headings,
  }));

  const chunks: BrainChunk[] = [];
  for (const p of parsed) {
    const page = pages.find((x) => x.id === p.id)!;
    chunkPage(p, page.folder).forEach((c, i) => {
      const text = cleanText(c.body);
      if (text.length < 40 && !c.heading) return; // a stray line with nothing to retrieve
      const unverified = UNVERIFIED.test(c.body);
      const rawId = `${p.id}#${i}`;
      // Ids double as Vectorize ids ("brain:" + id, at most 64 bytes): long or non-ASCII ones are hashed.
      const id = rawId.length <= 56 && /^[\x21-\x7e]+$/.test(rawId) ? rawId : `${p.id.replace(/[^\x21-\x7e]/g, '').slice(0, 36)}#${hash(rawId).slice(0, 12)}`;
      // Third-party proof (proof networks, testimonials) needs each person's permission: never a fact for prompts.
      const facts = page.folder.startsWith('ventures/gl') && !/proof|testimonial/.test(p.id) ? factBullets(c.body) : undefined;
      chunks.push({
        id, page_id: p.id, ord: i, title: p.title, heading: c.heading, text,
        kind: kindOf(c.heading, page.folder),
        tags: { techniques: techniqueNames(c.body), links: [...new Set(linksIn(c.body))].filter((l) => ids.has(l)), src: [...new Set(srcsIn(c.body))].slice(0, 8), unverified, ...(facts?.length ? { facts } : {}) },
        legend: page.legend, verified: !unverified, hash: hash(`${p.title}\n${c.heading}\n${text}`),
      });
    });
  }

  const count = <T>(xs: T[], f: (x: T) => string) => xs.reduce<Record<string, number>>((m, x) => { m[f(x)] = (m[f(x)] ?? 0) + 1; return m; }, {});
  const builtAt = o.builtAt ?? new Date().toISOString();
  return {
    build_id: hash(builtAt + chunks.map((c) => c.hash).join('')).slice(0, 12),
    built_at: builtAt, source: o.source ?? '',
    pages, chunks, edges,
    stats: {
      pages: pages.length, chunks: chunks.length, edges: edges.length,
      legends: new Set(pages.map((p) => p.legend).filter(Boolean)).size,
      by_kind: count(chunks, (c) => c.kind), by_edge: count(edges, (e) => e.type),
    },
  };
}

// ───────────── SQL for D1 ─────────────

export const sqlStr = (v: string | null | undefined) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const sqlNum = (v: number) => (Number.isFinite(v) ? String(v) : '0');

/**
 * Seed SQL in files of at most maxBytes each (wrangler d1 execute --file). Idempotent and resumable: pages and
 * chunks are upserted by id and stamped with the build id; a chunk whose text did not change keeps its embedding
 * mark, a changed one is queued for embedding again. The last file drops rows from older builds, rebuilds the
 * full-text index and records the build in kv_state.
 */
export function toSeedSql(s: BrainSnapshot, maxBytes = 400_000): string[] {
  const now = s.built_at;
  const stmts: string[] = [];
  for (const p of s.pages) {
    stmts.push(`INSERT INTO brain_pages (id, path, title, summary, folder, legend, pagerank, links_json, headings_json, build_id, updated_at) VALUES (${[
      sqlStr(p.id), sqlStr(p.path), sqlStr(p.title), sqlStr(p.summary), sqlStr(p.folder), sqlStr(p.legend), sqlNum(p.pagerank),
      sqlStr(JSON.stringify(p.links)), sqlStr(JSON.stringify(p.headings)), sqlStr(s.build_id), sqlStr(now)].join(', ')}) ON CONFLICT(id) DO UPDATE SET path = excluded.path, title = excluded.title, summary = excluded.summary, folder = excluded.folder, legend = excluded.legend, pagerank = excluded.pagerank, links_json = excluded.links_json, headings_json = excluded.headings_json, build_id = excluded.build_id, updated_at = excluded.updated_at;`);
  }
  for (const c of s.chunks) {
    stmts.push(`INSERT INTO brain_chunks (id, page_id, ord, title, heading, text, kind, tags_json, legend, verified, hash, build_id) VALUES (${[
      sqlStr(c.id), sqlStr(c.page_id), sqlNum(c.ord), sqlStr(c.title), sqlStr(c.heading), sqlStr(c.text), sqlStr(c.kind), sqlStr(JSON.stringify(c.tags)),
      sqlStr(c.legend), c.verified ? '1' : '0', sqlStr(c.hash), sqlStr(s.build_id)].join(', ')}) ON CONFLICT(id) DO UPDATE SET page_id = excluded.page_id, ord = excluded.ord, title = excluded.title, heading = excluded.heading, text = excluded.text, kind = excluded.kind, tags_json = excluded.tags_json, legend = excluded.legend, verified = excluded.verified, embedded_hash = CASE WHEN brain_chunks.hash = excluded.hash THEN brain_chunks.embedded_hash ELSE NULL END, hash = excluded.hash, build_id = excluded.build_id;`);
  }
  stmts.push('DELETE FROM brain_edges;');
  for (const e of s.edges) stmts.push(`INSERT INTO brain_edges (src, dst, type, weight) VALUES (${sqlStr(e.src)}, ${sqlStr(e.dst)}, ${sqlStr(e.type)}, ${sqlNum(e.weight)});`);
  const tail = [
    `DELETE FROM brain_chunks WHERE build_id IS NOT ${sqlStr(s.build_id)};`,
    `DELETE FROM brain_pages WHERE build_id IS NOT ${sqlStr(s.build_id)};`,
    "INSERT INTO brain_fts(brain_fts) VALUES ('rebuild');",
    `INSERT INTO kv_state (key, value) VALUES ('brain:build', ${sqlStr(JSON.stringify({ build_id: s.build_id, built_at: s.built_at, source: s.source, ...s.stats }))}) ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
  ];
  const files: string[] = [];
  let cur = '';
  for (const st of stmts) {
    if (cur && cur.length + st.length + 1 > maxBytes) { files.push(cur); cur = ''; }
    cur += st + '\n';
  }
  // The tail always goes in the last file, so the swap (old rows out, index rebuilt) happens once everything is in.
  const t = tail.join('\n') + '\n';
  if (cur && cur.length + t.length > maxBytes) { files.push(cur); cur = ''; }
  files.push(cur + t);
  return files;
}
