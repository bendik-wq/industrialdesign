import type { Runtime } from '../app';
import type { Env } from '../env';
import { hmacHex, safeEqual } from '../lib/crypto';
import { getSecret } from '../lib/secret';

/**
 * G&L Studio: talking to the editor container (Cloudflare Containers, class StudioEditor in src/studio/container.ts;
 * image containers/studio-editor) and the short-lived signed links it uses to reach Studio storage.
 *
 * One container instance per video (named by the video id), so a video's raw file stays on that instance's disk
 * between analysing and rendering. The container reaches the Worker over HTTPS at the Public URL:
 *   GET  /studio/blob/<id>/raw?e&s           the raw recording (Range supported; resumable)
 *   PUT  /studio/blob/<id>/<out>?op=put|part  outputs (edited, short-1..3, thumb), R2 multipart behind it
 *   POST /studio/blob/<id>/progress?e&s       live progress while it works
 * Each link names one video and one purpose, carries an expiry and an HMAC (SESSION_SECRET); nothing else is reachable.
 */

export const BLOB_PATH = '/studio/blob/';
export const BLOB_KINDS = /^(raw|progress|thumb|edited|preview|short-[1-3])$/;
export const ID_RE = /^[a-z0-9][a-z0-9-]{7,63}$/;

async function sig(env: Env, id: string, kind: string, exp: number) {
  return (await hmacHex(await getSecret(env), `studio-blob|${id}|${kind}|${exp}`)).slice(0, 40);
}
export async function blobUrl(rt: Pick<Runtime, 'env' | 'origin'>, id: string, kind: string, ttlMs: number, now = Date.now()) {
  if (!ID_RE.test(id) || !BLOB_KINDS.test(kind)) throw new Error('studio: bad blob link');
  const exp = now + ttlMs;
  return `${rt.origin}${BLOB_PATH}${id}/${kind}?e=${exp}&s=${await sig(rt.env, id, kind, exp)}`;
}
export async function verifyBlob(env: Env, id: string, kind: string, e: string | undefined, s: string | undefined, now = Date.now()) {
  if (!ID_RE.test(id) || !BLOB_KINDS.test(kind)) return false;
  const exp = Number(e);
  if (!Number.isFinite(exp) || exp < now || !s) return false;
  return safeEqual(s, await sig(env, id, kind, exp));
}

/** R2 keys for each output kind. */
export function outputKey(id: string, kind: string): string | null {
  if (kind === 'edited') return `edited/${id}.mp4`;
  if (kind === 'preview') return `previews/${id}.mp4`;
  if (kind === 'thumb') return `thumbs/${id}.jpg`;
  const m = /^short-([1-3])$/.exec(kind);
  return m ? `shorts/${id}-${m[1]}.mp4` : null;
}

export interface EngineStatus { ready: boolean; detail: string }
/** Can the editor run here? Everything missing is named, so Funnel HQ can say why (local dev has none of it). */
export function engineStatus(rt: Pick<Runtime, 'env' | 'origin'>): EngineStatus {
  const missing: string[] = [];
  if (!rt.env.STUDIO) missing.push('Studio storage (R2 bucket gl-studio)');
  if (!rt.env.STUDIO_EDITOR) missing.push('the editor container');
  if (!rt.env.AI) missing.push('Workers AI (transcripts)');
  if (missing.length) return { ready: false, detail: `Not available here: ${missing.join(', ')} not connected.` };
  if (!/^https:\/\//.test(rt.origin) || /example\.com$/.test(new URL(rt.origin).hostname)) return { ready: false, detail: 'Set the Public URL under Site, so the editor can reach Studio storage.' };
  return { ready: true, detail: 'Editor ready' };
}

/** A request to this video's container instance (started on demand by the Container class). */
export async function editorFetch(env: Env, id: string, path: string, init?: RequestInit): Promise<Response> {
  const ns = env.STUDIO_EDITOR;
  if (!ns) throw new Error('The editor container is not connected here.');
  const stub = ns.get(ns.idFromName(id));
  return stub.fetch(new Request(`http://editor${path}`, init));
}

export async function editorJson<T>(env: Env, id: string, path: string, init?: RequestInit): Promise<{ status: number; body: T | null }> {
  const r = await editorFetch(env, id, path, init);
  const body = (await r.json().catch(() => null)) as T | null;
  return { status: r.status, body };
}

export interface EditorJob<R = unknown> { kind: string; state: 'running' | 'done' | 'failed'; progress: number; detail: string; result?: R; error?: string; started: number; updated: number }
