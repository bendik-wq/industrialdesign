import type { Runtime } from '../app';
import { APPLICATION } from '../config';
import { runWorkersAi } from '../infra/ai-gateway';
import { flag } from '../settings';

/**
 * AI search on Cloudflare Vectorize (Cloudflare round, builder C). The pieces with no I/O of their own:
 * which index and embedder to use, vector ids, the text we embed for a lead, hashing, and the vector maths.
 *
 * Index gl-knowledge: 768 dimensions, cosine, filled with Workers AI bge-base-en-v1.5 embeddings. Every vector
 * lives in a namespace (lead | q | note | doc) and its id carries the same prefix (lead:…, q:…, note:…, doc:…),
 * so a query never mixes kinds and needs no metadata index. Metadata stays small; snippets live in D1 (vec_items).
 */

export const EMBED_MODEL = '@cf/baai/bge-base-en-v1.5';
export const DIMS = 768;
export const NAMESPACES = ['lead', 'q', 'note', 'doc'] as const;
export type Ns = (typeof NAMESPACES)[number];
/** bge-base reads 512 tokens; a little under 2,000 characters keeps us inside it. */
export const MAX_EMBED_CHARS = 1900;

/** The slice of the Vectorize binding we use (the real one, or a fake in tests). */
export interface VecIndex {
  upsert(v: { id: string; values: number[]; namespace?: string; metadata?: Record<string, string | number | boolean> }[]): Promise<unknown>;
  query(values: number[], o: { topK?: number; namespace?: string; returnMetadata?: 'none' | 'indexed' | 'all' | boolean; returnValues?: boolean }): Promise<{ matches: { id: string; score: number; metadata?: Record<string, unknown> }[] }>;
  getByIds(ids: string[]): Promise<{ id: string; values: number[] | Float32Array | Float64Array; metadata?: Record<string, unknown> }[]>;
  deleteByIds(ids: string[]): Promise<unknown>;
}
export type Embedder = (texts: string[]) => Promise<number[][]>;

export const NOT_HERE = 'AI search is not available here: the Vectorize index only runs on Cloudflare (not in local dev or tests).';
export const OFF_NOTE = 'AI search is off. Turn on VECTOR_SEARCH under Integrations → AI & search; the index fills over the next hours.';

type S = Partial<Record<string, string>>;
export const vectorSearchOn = (rt: Pick<Runtime, 'settings'>) => flag((rt.settings as unknown as S).VECTOR_SEARCH);
export const roomHelperOn = (rt: Pick<Runtime, 'settings'>) => flag((rt.settings as unknown as S).ROOM_AI_HELPER);

// Tests swap these in; production reads the bindings.
let fakeIndex: VecIndex | null = null;
let fakeEmbed: Embedder | null = null;
export function setVectorTestDoubles(o: { index?: VecIndex | null; embed?: Embedder | null }) {
  if ('index' in o) fakeIndex = o.index ?? null;
  if ('embed' in o) fakeEmbed = o.embed ?? null;
}

export function vecIndex(rt: Pick<Runtime, 'env'>): VecIndex | null {
  if (fakeIndex) return fakeIndex;
  const v = (rt.env as { VECTORS?: unknown }).VECTORS as VecIndex | undefined;
  return v && typeof v.query === 'function' ? v : null;
}

export function embedder(rt: Pick<Runtime, 'env' | 'settings'>, feature = 'vector-index'): Embedder | null {
  if (fakeEmbed) return fakeEmbed;
  const ai = rt.env.AI as unknown as { run(m: string, i: unknown, o?: unknown): Promise<unknown> } | undefined;
  if (!ai) return null;
  return async (texts) => {
    if (!texts.length) return [];
    const out = await runWorkersAi<{ data?: number[][] }>(ai, rt.settings, feature, EMBED_MODEL, { text: texts.map(clip) });
    const data = out?.data ?? [];
    if (data.length !== texts.length || data.some((v) => !Array.isArray(v) || v.length !== DIMS)) throw new Error(`embedding returned ${data.length} vectors for ${texts.length} texts`);
    return data;
  };
}

/** `wrangler dev --local` binds Vectorize and Workers AI as stubs that throw this on use. */
export const isLocalOnlyError = (e: unknown) => /needs to be run remotely|not supported (in|when running) local/i.test(String((e as Error)?.message ?? e));

/** Why AI search can't run here, or null when it can. */
export function unavailable(rt: Pick<Runtime, 'env' | 'settings'>): string | null {
  if (!vectorSearchOn(rt)) return OFF_NOTE;
  if (!vecIndex(rt) || !embedder(rt)) return NOT_HERE;
  return null;
}

// ───────────── text, ids and hashes ─────────────

export const clip = (s: string, n = MAX_EMBED_CHARS) => (s.length > n ? s.slice(0, n) : s);
export const squash = (s: unknown) => String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

export async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Vectorize ids are at most 64 bytes: a long ref is replaced by a hash of it (the prefix stays). */
export async function vecId(ns: Ns, ref: string): Promise<string> {
  const id = `${ns}:${ref}`;
  if (new TextEncoder().encode(id).length <= 64) return id;
  return `${ns}:h${(await sha256(ref)).slice(0, 40)}`;
}

export const metaHash = (m: Record<string, unknown>) => sha256(JSON.stringify(Object.keys(m).sort().map((k) => [k, m[k]])));

/** Small metadata only: strings capped, no PII. */
export function smallMeta(m: Record<string, string | number | boolean | null | undefined>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(m)) if (v != null && v !== '') out[k] = typeof v === 'string' ? v.slice(0, 64) : v;
  return out;
}

export interface LeadForText { answers: string | null; industry?: string | null; revenue_band?: string | null; booking_answers?: string | null; objection?: string | null; lost_reason?: string | null; target_business?: string | null }

/** What we embed for a lead: their application answers as labelled text (never their name, email or phone). */
export function leadText(l: LeadForText): string {
  let a: Record<string, unknown> = {};
  try { a = JSON.parse(l.answers || '{}') as Record<string, unknown>; } catch { a = {}; }
  const parts: string[] = [];
  for (const q of APPLICATION) {
    if (q.type === 'contact') continue;
    const v = a[q.id];
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
    const vals = Array.isArray(v) ? v : [v];
    const label = 'options' in q && q.options ? vals.map((x) => q.options!.find((o) => o.value === x)?.label ?? String(x)).join(', ') : vals.map(String).join(', ');
    parts.push(`${squash(q.title)} ${squash(label)}`);
  }
  try {
    for (const x of JSON.parse(l.booking_answers || '[]') as { q?: string; a?: string }[]) if (x?.a) parts.push(`${squash(x.q)} ${squash(x.a)}`);
  } catch { /* not JSON */ }
  if (!parts.length) return ''; // no answers yet: nothing to compare
  if (l.industry) parts.push(`Industry: ${squash(l.industry)}`);
  if (l.revenue_band) parts.push(`Revenue band: ${squash(l.revenue_band)}`);
  if (l.target_business) parts.push(`Target business: ${squash(l.target_business)}`);
  if (l.objection) parts.push(`Main objection: ${squash(l.objection)}`);
  return clip(parts.join('\n'));
}

// ───────────── vector maths ─────────────

export function norm(v: ArrayLike<number>) { let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i]; return Math.sqrt(s); }
export function normalize(v: ArrayLike<number>): number[] {
  const n = norm(v);
  return n ? Array.from(v, (x) => x / n) : Array.from(v);
}
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>) {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0; for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  const d = norm(a) * norm(b);
  return d ? dot / d : 0;
}
/** The centroid of unit-length versions of the vectors (each buyer counts once, whatever its length), unit length. */
export function meanVector(vs: ArrayLike<number>[]): number[] | null {
  const ok = vs.filter((v) => v && v.length);
  if (!ok.length) return null;
  const d = ok[0].length;
  const sum = new Array<number>(d).fill(0);
  let n = 0;
  for (const v of ok) {
    if (v.length !== d) continue;
    const u = normalize(v);
    for (let i = 0; i < d; i++) sum[i] += u[i];
    n++;
  }
  if (!n) return null;
  return normalize(sum.map((x) => x / n));
}
