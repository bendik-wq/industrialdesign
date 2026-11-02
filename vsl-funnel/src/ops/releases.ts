import type { Runtime } from '../app';
import { scrub } from '../infra/errors';
import { buildId } from '../infra/build';

/**
 * "What changed": deploy notes for Command. There is no git at runtime, so `npm run deploy` (scripts/deploy.mjs)
 * substitutes __RELEASE_NOTES__ with a JSON string: { build, at, notes: [commit subjects, newest first] }. Command's
 * cron records it once per build in release_notes (migration 0071). Everything here is optional: a plain
 * `wrangler deploy`, local dev, tests or a missing table simply mean no deploy notes are shown.
 */
declare const __RELEASE_NOTES__: string | undefined;
declare const __BUILD_ID__: string | undefined;

export interface ReleaseInfo { build: string; at: number; notes: string[] }
export interface ReleaseRow { build: string; deployed_at: number; notes: string[]; version_id: string | null; recorded_at: number }

export const MAX_NOTES = 12;
const NOTE_MAX = 160;

/** Cleans what the deploy script passed in (pure): a valid build id, a time, up to 12 trimmed subjects with secrets masked. */
export function parseReleaseNotes(raw: unknown): ReleaseInfo | null {
  let v: unknown = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return null; } }
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const build = typeof o.build === 'string' && /^[\w.-]{1,64}$/.test(o.build) ? o.build : null;
  const at = Number(o.at);
  if (!build || !Number.isFinite(at) || at <= 0) return null;
  const notes = (Array.isArray(o.notes) ? o.notes : [])
    .filter((x): x is string => typeof x === 'string')
    .map((x) => scrub(x.replace(/\s+/g, ' ').trim()).slice(0, NOTE_MAX))
    .filter(Boolean)
    .slice(0, MAX_NOTES);
  return { build, at, notes };
}

/** The notes built into this Worker, or null (not deployed with npm run deploy). */
export function bundledRelease(): ReleaseInfo | null {
  return typeof __RELEASE_NOTES__ === 'string' ? parseReleaseNotes(__RELEASE_NOTES__) : null;
}

/**
 * The build id when it identifies a real deploy (set by npm run deploy, or the Worker version id), else null.
 * Local dev and tests fall back to the isolate start time in buildId(); that is not a deploy and is not shown.
 */
export function deployedBuild(env?: { CF_VERSION_METADATA?: { id?: string } } | null): string | null {
  const defined = typeof __BUILD_ID__ === 'string' && /^[\w.-]{1,64}$/.test(__BUILD_ID__);
  return defined || env?.CF_VERSION_METADATA?.id ? buildId(env) : null;
}

/** Records a release once per build (INSERT OR IGNORE). Returns true when this call stored it. */
export async function recordRelease(rt: Pick<Runtime, 'env'>, info: ReleaseInfo | null = bundledRelease(), now = Date.now()) {
  if (!info) return false;
  try {
    const r = await rt.env.DB.prepare('INSERT OR IGNORE INTO release_notes (build, deployed_at, notes, version_id, recorded_at) VALUES (?, ?, ?, ?, ?)')
      .bind(info.build, info.at, JSON.stringify(info.notes), rt.env.CF_VERSION_METADATA?.id ?? null, now).run();
    return Boolean(r.meta?.changes);
  } catch (e) {
    console.error('release notes not recorded', e); // table missing before migration 0071: harmless
    return false;
  }
}

const parseNotes = (s: unknown): string[] => { try { const v = JSON.parse(String(s ?? '[]')); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; } };

/** The latest releases, newest first; [] when the table is missing or empty. */
export async function listReleases(rt: Pick<Runtime, 'env'>, o: { since?: number; limit?: number } = {}): Promise<ReleaseRow[]> {
  try {
    const { results } = await rt.env.DB.prepare('SELECT build, deployed_at, notes, version_id, recorded_at FROM release_notes WHERE deployed_at >= ? ORDER BY deployed_at DESC LIMIT ?')
      .bind(o.since ?? 0, Math.max(1, Math.min(50, o.limit ?? 10))).all<Record<string, unknown>>();
    return results.map((r) => ({ build: String(r.build), deployed_at: Number(r.deployed_at), notes: parseNotes(r.notes), version_id: (r.version_id as string | null) ?? null, recorded_at: Number(r.recorded_at) }));
  } catch {
    return [];
  }
}

/** One line for Command: "Deployed <build> at <time>: <notes>". Pure. */
export function releaseLine(r: Pick<ReleaseRow, 'build' | 'deployed_at' | 'notes'>, when: (t: number) => string, maxNotes = 3) {
  const notes = r.notes.slice(0, maxNotes).join('; ');
  const more = r.notes.length > maxNotes ? ` (and ${r.notes.length - maxNotes} more)` : '';
  return `Deployed ${r.build} at ${when(r.deployed_at)}${notes ? `: ${notes}${more}` : ''}`;
}
