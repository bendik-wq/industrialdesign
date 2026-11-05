import type { Runtime } from '../app';
import { MAX_EMBED_CHARS, NOT_HERE, embedder, isLocalOnlyError, vecIndex } from '../vectors/core';
import { VEC_NS, vecIdOf } from './retrieve';

/**
 * Embedding the brain's chunks into the existing Vectorize index (binding VECTORS, index gl-knowledge, Workers AI
 * bge-base-en-v1.5, 768 dims), namespace "brain", metadata kind: 'brain'. Resumable: a chunk is done when its
 * embedded_hash equals its content hash, so a re-seed only re-embeds what changed. The owner starts it once
 * (POST /admin/api/brain/embed); from then on the cron finishes what is left. Progress lives in kv_state brain:embed.
 */

export const EMBED_BATCH = 48;
const PER_CALL = 24;

export interface EmbedState { started_at: string; updated_at: string; embedded: number; left: number; last_error: string | null }

async function readState(rt: Pick<Runtime, 'env'>): Promise<EmbedState | null> {
  const r = await rt.env.DB.prepare("SELECT value FROM kv_state WHERE key = 'brain:embed'").first<{ value: string }>().catch(() => null);
  try { return r?.value ? (JSON.parse(r.value) as EmbedState) : null; } catch { return null; }
}
async function writeState(rt: Pick<Runtime, 'env'>, s: EmbedState) {
  await rt.env.DB.prepare("INSERT INTO kv_state (key, value) VALUES ('brain:embed', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(s)).run();
}
export const embedState = readState;

export async function pendingCount(rt: Pick<Runtime, 'env'>): Promise<number> {
  const r = await rt.env.DB.prepare('SELECT COUNT(*) AS n FROM brain_chunks WHERE embedded_hash IS NULL OR embedded_hash <> hash').first<{ n: number }>().catch(() => null);
  return Number(r?.n ?? 0);
}

export const embedText = (c: { title: string; heading: string | null; text: string }) => `${c.title}${c.heading ? ` › ${c.heading}` : ''}\n${c.text}`.slice(0, MAX_EMBED_CHARS);

/** Embed up to `limit` chunks that are new or changed. Never throws for "not here": returns a note instead. */
export async function embedBatch(rt: Pick<Runtime, 'env' | 'settings'>, o: { limit?: number; now?: Date } = {}): Promise<{ ok: boolean; embedded: number; left: number; note?: string }> {
  const idx = vecIndex(rt), emb = embedder(rt, 'brain-embed');
  if (!idx || !emb) return { ok: false, embedded: 0, left: await pendingCount(rt), note: NOT_HERE };
  const now = (o.now ?? new Date()).toISOString();
  const prev = await readState(rt);
  const state: EmbedState = { started_at: prev?.started_at ?? now, updated_at: now, embedded: prev?.embedded ?? 0, left: 0, last_error: null };
  const { results: rows } = await rt.env.DB.prepare('SELECT id, page_id, title, heading, text, kind, legend, hash FROM brain_chunks WHERE embedded_hash IS NULL OR embedded_hash <> hash ORDER BY page_id, ord LIMIT ?')
    .bind(Math.max(1, Math.min(200, o.limit ?? EMBED_BATCH))).all<{ id: string; page_id: string; title: string; heading: string | null; text: string; kind: string; legend: string | null; hash: string }>();
  let done = 0;
  try {
    for (let i = 0; i < rows.length; i += PER_CALL) {
      const part = rows.slice(i, i + PER_CALL);
      const vectors = await emb(part.map(embedText));
      await idx.upsert(part.map((r, j) => ({
        id: vecIdOf(r.id), values: vectors[j], namespace: VEC_NS,
        metadata: { kind: 'brain', page: r.page_id.slice(0, 64), ckind: r.kind, ...(r.legend ? { legend: r.legend.slice(0, 64) } : {}) },
      })));
      await rt.env.DB.batch(part.map((r) => rt.env.DB.prepare('UPDATE brain_chunks SET embedded_hash = ? WHERE id = ? AND hash = ?').bind(r.hash, r.id, r.hash)));
      done += part.length;
    }
  } catch (e) {
    state.last_error = isLocalOnlyError(e) ? NOT_HERE : String((e as Error)?.message ?? e).slice(0, 300);
  }
  state.embedded += done;
  state.left = await pendingCount(rt);
  await writeState(rt, state);
  return state.last_error ? { ok: false, embedded: done, left: state.left, note: state.last_error } : { ok: true, embedded: done, left: state.left };
}

/** Cron: only after the owner started embedding once, and only while chunks are left. A few batches per tick. */
export async function brainTick(rt: Pick<Runtime, 'env' | 'settings'>, budgetMs = 40_000): Promise<{ embedded: number; left: number } | null> {
  if (!(await readState(rt))) return null;
  if (!vecIndex(rt) || !embedder(rt, 'brain-embed')) return null;
  const t0 = Date.now();
  let embedded = 0, left = await pendingCount(rt);
  while (left > 0 && Date.now() - t0 < budgetMs) {
    const r = await embedBatch(rt);
    embedded += r.embedded; left = r.left;
    if (!r.ok || !r.embedded) break;
  }
  return embedded ? { embedded, left } : null;
}
