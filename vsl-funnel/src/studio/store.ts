import type { Env } from '../env';

/**
 * G&L Studio: the D1 rows (migration 0088_studio.sql), the status machine and the small state table.
 */

export const STATUSES = ['recording', 'uploaded', 'in_drive', 'queued', 'transcribing', 'planning', 'rendering', 'delivering', 'done', 'failed', 'skipped'] as const;
export type Status = (typeof STATUSES)[number];
/** Statuses the pipeline moves on by itself. */
export const ACTIVE: Status[] = ['uploaded', 'in_drive', 'queued', 'transcribing', 'planning', 'rendering', 'delivering'];
export const isActive = (s: string) => (ACTIVE as string[]).includes(s);

/** Allowed moves. Anything active can fail; failed and skipped go back in through retry/edit; done through re-edit. */
const NEXT: Record<Status, Status[]> = {
  recording: ['uploaded', 'failed'],
  uploaded: ['in_drive', 'queued', 'skipped', 'failed'],
  in_drive: ['queued', 'skipped', 'failed'],
  queued: ['transcribing', 'failed'],
  transcribing: ['planning', 'failed'],
  planning: ['rendering', 'failed'],
  rendering: ['delivering', 'planning', 'failed'],
  delivering: ['done', 'failed'],
  done: ['planning'],
  failed: ['uploaded', 'in_drive', 'queued', 'transcribing', 'planning', 'rendering', 'delivering'],
  skipped: ['in_drive', 'queued'],
};
export const canMove = (from: string, to: string) => (NEXT[from as Status] ?? []).includes(to as Status);

/** Where a retry starts: the stage that failed (a failed recording upload cannot be retried). */
export function retryTarget(v: Pick<VideoRow, 'status' | 'failed_stage' | 'raw_key' | 'upload_id' | 'transcript_key' | 'plan_json' | 'edited_key' | 'source'>): Status | null {
  if (v.status === 'skipped') return 'in_drive';
  if (v.status !== 'failed') return null;
  const st = (v.failed_stage ?? '') as Status;
  if (st === 'recording') return null;
  if ((ACTIVE as string[]).includes(st)) {
    // Never further than the data allows.
    if ((st === 'planning' || st === 'rendering' || st === 'delivering') && !v.transcript_key) return 'queued';
    if ((st === 'rendering' || st === 'delivering') && !v.plan_json) return 'planning';
    if (st === 'delivering' && !v.edited_key) return 'rendering';
    return st;
  }
  return 'queued';
}

export interface VideoRow {
  id: string; title: string | null; source: 'studio' | 'drive'; layout: string | null; created_at: string; updated_at: string;
  duration_s: number | null; width: number | null; height: number | null; mime: string | null; raw_key: string | null; raw_size: number | null;
  upload_id: string | null; parts_json: string | null; markers_json: string | null; script_id: string | null;
  drive_raw_id: string | null; drive_raw_link: string | null; status: Status; progress: number; stage_detail: string | null;
  transcript_key: string | null; plan_json: string | null; plan_brain: string | null; edited_key: string | null; edited_size: number | null;
  edited_width: number | null; edited_height: number | null; drive_edited_id: string | null; drive_edited_link: string | null;
  shorts_json: string | null; error: string | null; attempts: number; deleted_at: string | null;
  failed_stage: string | null; notes: string | null; probe_json: string | null; analysis_key: string | null; thumb_key: string | null;
  lease_until: number | null; next_at: number | null; flow_id: string | null;
}
export interface EventRow { id: number; video_id: string; at: string; stage: string; message: string }

export const iso = (ms = Date.now()) => new Date(ms).toISOString();

export async function getVideo(env: Pick<Env, 'DB'>, id: string) {
  return env.DB.prepare('SELECT * FROM studio_videos WHERE id = ? AND deleted_at IS NULL').bind(id).first<VideoRow>();
}

const COLS = new Set(['title', 'layout', 'duration_s', 'width', 'height', 'mime', 'raw_key', 'raw_size', 'upload_id', 'parts_json', 'markers_json', 'script_id',
  'drive_raw_id', 'drive_raw_link', 'status', 'progress', 'stage_detail', 'transcript_key', 'plan_json', 'plan_brain', 'edited_key', 'edited_size',
  'edited_width', 'edited_height', 'drive_edited_id', 'drive_edited_link', 'shorts_json', 'error', 'attempts', 'deleted_at', 'failed_stage', 'notes',
  'probe_json', 'analysis_key', 'thumb_key', 'lease_until', 'next_at', 'flow_id']);

/** Updates named columns (and updated_at). Unknown keys throw: a typo must not silently drop a write. */
export async function patchVideo(env: Pick<Env, 'DB'>, id: string, patch: Partial<Record<keyof VideoRow, unknown>>, now = Date.now()) {
  const keys = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
  for (const k of keys) if (!COLS.has(k)) throw new Error(`studio: unknown column ${k}`);
  if (!keys.length) return;
  const vals = keys.map((k) => { const v = (patch as Record<string, unknown>)[k]; return typeof v === 'boolean' ? Number(v) : (v as string | number | null); });
  await env.DB.prepare(`UPDATE studio_videos SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).bind(...vals, iso(now), id).run();
}

/** Moves a video to a new status (checked against the machine) with a fresh progress. */
export async function moveTo(env: Pick<Env, 'DB'>, v: Pick<VideoRow, 'id' | 'status'>, to: Status, extra: Partial<Record<keyof VideoRow, unknown>> = {}) {
  if (v.status !== to && !canMove(v.status, to)) throw new Error(`studio: cannot move ${v.status} → ${to}`);
  await patchVideo(env, v.id, { status: to, progress: 0, ...extra });
  (v as { status: string }).status = to;
}

export async function addEvent(env: Pick<Env, 'DB'>, videoId: string, stage: string, message: string, now = Date.now()) {
  await env.DB.prepare('INSERT INTO studio_events (video_id, at, stage, message) VALUES (?, ?, ?, ?)').bind(videoId, iso(now), stage, message.slice(0, 500)).run();
}

export async function getState<T = string>(env: Pick<Env, 'DB'>, key: string, json = false): Promise<T | null> {
  const r = await env.DB.prepare('SELECT value FROM studio_state WHERE key = ?').bind(key).first<{ value: string | null }>();
  if (!r || r.value === null) return null;
  if (!json) return r.value as T;
  try { return JSON.parse(r.value) as T; } catch { return null; }
}
export async function setState(env: Pick<Env, 'DB'>, key: string, value: unknown) {
  const v = value === null ? null : typeof value === 'string' ? value : JSON.stringify(value);
  await env.DB.prepare('INSERT INTO studio_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, v).run();
}
export async function delState(env: Pick<Env, 'DB'>, ...keys: string[]) {
  for (const k of keys) await env.DB.prepare('DELETE FROM studio_state WHERE key = ?').bind(k).run();
}
export async function delStatePrefix(env: Pick<Env, 'DB'>, prefix: string) {
  await env.DB.prepare('DELETE FROM studio_state WHERE key >= ? AND key < ?').bind(prefix, `${prefix}￿`).run();
}

/** One worker at a time per video: claims the lease when it is free or expired. */
export async function claim(env: Pick<Env, 'DB'>, id: string, ms: number, now = Date.now()) {
  const r = await env.DB.prepare('UPDATE studio_videos SET lease_until = ? WHERE id = ? AND deleted_at IS NULL AND (lease_until IS NULL OR lease_until < ?)').bind(now + ms, id, now).run();
  return Number((r as { meta?: { changes?: number } }).meta?.changes ?? 0) > 0;
}
export async function release(env: Pick<Env, 'DB'>, id: string, nextAt: number | null) {
  await env.DB.prepare('UPDATE studio_videos SET lease_until = NULL, next_at = ? WHERE id = ?').bind(nextAt, id).run();
}

export const parseJson = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
};
