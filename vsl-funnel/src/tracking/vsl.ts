import type { Runtime } from '../app';
import { VIDEOS } from '../config';
import type { VisitorCtx } from '../lib/identity';
import { type TrackIdentity, identityFromVisitor, track } from './track';

export const BUCKETS = 100;
const EMPTY = '0'.repeat(BUCKETS);
const VIDEO_IDS = new Set(Object.values(VIDEOS).map((v) => v.id));
const MILESTONES = [25, 50, 75, 95] as const;

export interface Heartbeat {
  view: string; // client-generated view id
  video: string;
  pos: number; // current position (s)
  dur: number; // duration (s)
  buckets: string; // 100 chars of 0/1, cumulative for this view
  watched: number; // seconds actually played since the last beat
  unmuted?: boolean;
  revealed?: boolean;
  cta?: boolean;
  ended?: boolean;
  path?: string;
}

interface ViewRow {
  id: string;
  visitor_id: string | null;
  duration: number | null;
  max_position: number;
  buckets: string;
  unmuted: number;
  completed: number;
  cta_revealed: number;
  cta_clicked: number;
}

/** OR-merge two watched-bucket bitmaps. */
export function mergeBuckets(a: string, b: string) {
  let out = '';
  for (let i = 0; i < BUCKETS; i++) out += a[i] === '1' || b[i] === '1' ? '1' : '0';
  return out;
}

export function parseHeartbeat(raw: unknown): Heartbeat | null {
  if (!raw || typeof raw !== 'object') return null;
  const h = raw as Record<string, unknown>;
  const num = (x: unknown, max: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.max(0, Math.min(max, x)) : 0);
  if (typeof h.view !== 'string' || !/^[\w-]{8,40}$/.test(h.view)) return null;
  if (typeof h.video !== 'string' || !VIDEO_IDS.has(h.video)) return null;
  const buckets = typeof h.buckets === 'string' && /^[01]{100}$/.test(h.buckets) ? h.buckets : EMPTY;
  return {
    view: h.view,
    video: h.video,
    pos: num(h.pos, 6 * 3600),
    dur: num(h.dur, 6 * 3600),
    buckets,
    watched: num(h.watched, 30), // a beat never covers more than ~30 s of play
    unmuted: h.unmuted === true,
    revealed: h.revealed === true,
    cta: h.cta === true,
    ended: h.ended === true,
    path: typeof h.path === 'string' ? h.path.slice(0, 200) : undefined,
  };
}

/**
 * Merges a player heartbeat into its view row and emits milestone events
 * exactly once, server-side — so drop-off and milestone counts are reliable
 * even if the client double-sends or skips beats.
 */
export async function recordHeartbeat(rt: Runtime, v: VisitorCtx, hb: Heartbeat) {
  const db = rt.env.DB;
  const now = Date.now();
  const prev = await db.prepare('SELECT id, visitor_id, duration, max_position, buckets, unmuted, completed, cta_revealed, cta_clicked FROM vsl_views WHERE id = ?').bind(hb.view).first<ViewRow>();
  if (prev && prev.visitor_id !== v.visitorId) return; // view ids are per-visitor

  const duration = hb.dur || prev?.duration || 0;
  const buckets = mergeBuckets(prev?.buckets ?? EMPTY, hb.buckets);
  const maxPos = Math.max(prev?.max_position ?? 0, hb.pos);
  const reachedPct = duration ? Math.round((maxPos / duration) * 100) : 0;
  const prevPct = prev && duration ? Math.round((prev.max_position / duration) * 100) : 0;
  const completed = hb.ended || reachedPct >= 98 ? 1 : 0;

  if (!prev) {
    await db.prepare(
      `INSERT INTO vsl_views (id, video_id, visitor_id, session_id, lead_id, variant, started_at, updated_at, duration, max_position, watched_seconds,
         buckets, played, unmuted, completed, cta_revealed, cta_clicked, is_bot)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?)`,
    )
      .bind(hb.view, hb.video, v.visitorId, v.sessionId, v.leadId, v.variant, now, now, duration || null, maxPos, hb.watched, buckets,
        hb.unmuted ? 1 : 0, completed, hb.revealed ? 1 : 0, hb.cta ? 1 : 0, v.isBot ? 1 : 0)
      .run();
  } else {
    await db.prepare(
      `UPDATE vsl_views SET updated_at = ?, duration = ?, max_position = ?, watched_seconds = watched_seconds + ?, buckets = ?,
         unmuted = MAX(unmuted, ?), completed = MAX(completed, ?), cta_revealed = MAX(cta_revealed, ?), cta_clicked = MAX(cta_clicked, ?)
       WHERE id = ?`,
    )
      .bind(now, duration || null, maxPos, hb.watched, buckets, hb.unmuted ? 1 : 0, completed, hb.revealed ? 1 : 0, hb.cta ? 1 : 0, hb.view)
      .run();
  }

  const who: TrackIdentity = identityFromVisitor(v);
  const base = { video: hb.video, view: hb.view };
  const emit = (name: Parameters<typeof track>[2]['name'], props: Record<string, unknown> = {}) =>
    track(rt, who, { name, source: 'client', path: hb.path ?? null, props: { ...base, ...props } });

  if (!prev) await emit('vsl_play');
  if (hb.unmuted && !prev?.unmuted) await emit('vsl_unmute', { at: Math.round(hb.pos) });
  for (const m of MILESTONES) if (reachedPct >= m && (!prev || prevPct < m)) await emit(`vsl_${m}` as 'vsl_25');
  if (completed && !prev?.completed) await emit('vsl_complete');
  if (hb.revealed && !prev?.cta_revealed) await emit('vsl_cta_reveal', { at: Math.round(hb.pos) });
  if (hb.cta && !prev?.cta_clicked) await emit('vsl_cta_click', { at: Math.round(hb.pos) });
}
