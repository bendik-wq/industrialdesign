import type { Runtime } from '../app';
import { webinarSettings } from '../webinar/webinar';
import { ZoomError, createZoomEvent, freshStartUrl, zoomConfigured } from './zoom';

/**
 * The live engine: every live event in the app (live webinar sessions, challenge days) runs on Zoom.
 * Event keys: 'webinar:<session id>' and 'challenge:<cohort id>:<day>'.
 * The join link is pasted per event in Funnel HQ (host console, /admin/live/:key) or created through the Zoom API.
 * Liveness comes from the schedule only: "live" means between 10 minutes before the start and the scheduled end.
 * (The module keeps its original name and exports so other code can import it unchanged; the Cloudflare Stream
 * plan was dropped for Zoom.)
 */

/** Minutes before the start that the join link opens. */
export const JOIN_OPENS_MIN = 10;
/** After the scheduled end the link stays usable this long (sessions overrun); it no longer shows as live. */
export const OVERRUN_MIN = 60;

const KEY_RE = /^(webinar:[A-Za-z0-9_-]{1,64}|challenge:[A-Za-z0-9_-]{1,64}:\d{1,2})$/;
export const isLiveKey = (k: unknown): k is string => typeof k === 'string' && KEY_RE.test(k);

/** https only, no quotes or angle brackets, 500 characters at most. */
export function cleanJoinUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!/^https:\/\/[^\s"'<>]+$/.test(t) || t.length > 500) return null;
  try { return new URL(t).protocol === 'https:' ? t : null; } catch { return null; }
}

// ───────────── setup ─────────────

export interface StreamSetup { ready: boolean; reason: string | null; accountId: string | null; customerCode: string | null }

/**
 * Whether Funnel HQ can create Zoom meetings by itself (Zoom Server-to-Server OAuth settings).
 * Events run either way: without it, paste a Zoom link per event. customerCode is always null (kept for the shape).
 */
export function streamSetup(rt: Runtime): StreamSetup {
  const s = rt.settings;
  const ready = zoomConfigured(s);
  const missing = [!s.ZOOM_ACCOUNT_ID && 'account ID', !s.ZOOM_CLIENT_ID && 'client ID', !s.ZOOM_CLIENT_SECRET && 'client secret'].filter(Boolean) as string[];
  return {
    ready,
    reason: ready ? null : missing.length === 3 ? 'Zoom API not connected: paste a Zoom link per event, or connect Zoom under Integrations → Live to create meetings automatically.' : `Zoom API settings incomplete: add the Zoom ${missing.join(' and ')} under Integrations → Live.`,
    accountId: s.ZOOM_ACCOUNT_ID || null,
    customerCode: null,
  };
}

export interface LiveInput { key: string; uid: string; rtmpsUrl: string | null; rtmpsKey: string | null; srtUrl: string | null; whipUrl: string | null; createdAt: number }
/** @deprecated Cloudflare Stream was dropped for Zoom; there are no live inputs. Always null. */
export async function ensureLiveInput(_rt: Runtime, _key: string, _title: string): Promise<LiveInput | null> {
  return null;
}

// ───────────── events ─────────────

export interface LiveEventRow {
  key: string; title: string | null; starts_at: number | null; duration_min: number | null; join_url: string | null;
  zoom_id: string | null; zoom_kind: string | null; zoom_start_url: string | null; zoom_password: string | null; created_at: number; updated_at: number;
}

export interface LiveSchedule { startsAt: number; durationMin: number }

export async function getLiveEvent(rt: Runtime, key: string) {
  return rt.env.DB.prepare('SELECT * FROM live_events WHERE key = ?').bind(key).first<LiveEventRow>();
}

/** Creates or updates an event (other parts of the app register their schedule here; undefined fields are left alone). */
export async function upsertLiveEvent(rt: Runtime, key: string, v: { title?: string | null; startsAt?: number | null; durationMin?: number | null; joinUrl?: string | null; zoom?: { id: string; kind: string; startUrl: string | null; password: string | null } | null }) {
  if (!isLiveKey(key)) throw new Error('Bad live event key');
  const now = Date.now();
  const cur = await getLiveEvent(rt, key);
  const pick = <T,>(next: T | undefined, prev: T) => (next === undefined ? prev : next);
  const row = {
    title: pick(v.title, cur?.title ?? null),
    starts_at: pick(v.startsAt, cur?.starts_at ?? null),
    duration_min: pick(v.durationMin, cur?.duration_min ?? null),
    join_url: pick(v.joinUrl, cur?.join_url ?? null),
    zoom_id: v.zoom === undefined ? cur?.zoom_id ?? null : v.zoom?.id ?? null,
    zoom_kind: v.zoom === undefined ? cur?.zoom_kind ?? null : v.zoom?.kind ?? null,
    zoom_start_url: v.zoom === undefined ? cur?.zoom_start_url ?? null : v.zoom?.startUrl ?? null,
    zoom_password: v.zoom === undefined ? cur?.zoom_password ?? null : v.zoom?.password ?? null,
  };
  await rt.env.DB.prepare(
    `INSERT INTO live_events (key, title, starts_at, duration_min, join_url, zoom_id, zoom_kind, zoom_start_url, zoom_password, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET title = excluded.title, starts_at = excluded.starts_at, duration_min = excluded.duration_min, join_url = excluded.join_url,
       zoom_id = excluded.zoom_id, zoom_kind = excluded.zoom_kind, zoom_start_url = excluded.zoom_start_url, zoom_password = excluded.zoom_password, updated_at = excluded.updated_at`,
  ).bind(key, row.title, row.starts_at, row.duration_min, row.join_url, row.zoom_id, row.zoom_kind, row.zoom_start_url, row.zoom_password, now, now).run();
  // A live webinar session keeps its own join_url too (the room's join button and /api/webinar/join read it).
  if (key.startsWith('webinar:') && v.joinUrl !== undefined) {
    await rt.env.DB.prepare('UPDATE webinar_sessions SET join_url = ? WHERE id = ?').bind(v.joinUrl, key.slice(8)).run();
  }
  statusCache.delete(key);
  return (await getLiveEvent(rt, key))!;
}

interface SessionLite { id: string; starts_at: number; title: string | null; mode: string; join_url: string | null; status: string }
async function webinarSession(rt: Runtime, key: string) {
  if (!key.startsWith('webinar:')) return null;
  return rt.env.DB.prepare('SELECT id, starts_at, title, mode, join_url, status FROM webinar_sessions WHERE id = ?').bind(key.slice(8)).first<SessionLite>();
}

export interface LiveEventInfo { key: string; title: string; schedule: LiveSchedule | null; joinUrl: string | null; row: LiveEventRow | null; session: SessionLite | null }

/** Everything known about an event: schedule (explicit > webinar session > stored row), title and link. */
export async function liveEvent(rt: Runtime, key: string, fallbackJoinUrl?: string | null, schedule?: LiveSchedule | null): Promise<LiveEventInfo> {
  const [row, session] = await Promise.all([getLiveEvent(rt, key), webinarSession(rt, key)]);
  let sched: LiveSchedule | null = schedule && schedule.startsAt > 0 ? schedule : null;
  if (!sched && session) sched = { startsAt: session.starts_at, durationMin: row?.duration_min || webinarSettings(rt).durationMin };
  if (!sched && row?.starts_at) sched = { startsAt: row.starts_at, durationMin: row.duration_min || 90 };
  const title = row?.title || session?.title || (session ? webinarSettings(rt).title : null) || defaultTitle(key);
  const joinUrl = cleanJoinUrl(row?.join_url) || cleanJoinUrl(fallbackJoinUrl) || cleanJoinUrl(session?.join_url);
  return { key, title, schedule: sched, joinUrl, row, session };
}

function defaultTitle(key: string) {
  const m = /^challenge:[^:]+:(\d+)$/.exec(key);
  return m ? `The First Deal Challenge, Day ${m[1]}` : 'Live session';
}

// ───────────── playback (viewer-facing) ─────────────

export interface Playback {
  mode: 'stream' | 'link' | 'none';
  /** Always null on Zoom (kept for the shape). */
  hls: string | null;
  whep: string | null;
  /** By the schedule only: from JOIN_OPENS_MIN before the start until the scheduled end. */
  isLive: boolean;
  replayHls: string | null;
  /** Handed out from JOIN_OPENS_MIN before the start until OVERRUN_MIN after the scheduled end (always, when no schedule is known). */
  joinUrl: string | null;
  startsAt?: number | null;
  endsAt?: number | null;
  /** 'zoom' when the link is a Zoom link. */
  provider?: 'zoom' | 'other' | null;
}

export function playbackState(info: { schedule: LiveSchedule | null; joinUrl: string | null }, now = Date.now()): Playback {
  const s = info.schedule;
  const startsAt = s ? s.startsAt : null;
  const endsAt = s ? s.startsAt + s.durationMin * 60_000 : null;
  const opensAt = startsAt === null ? null : startsAt - JOIN_OPENS_MIN * 60_000;
  const isLive = startsAt !== null && endsAt !== null && now >= opensAt! && now < endsAt;
  const usable = startsAt === null || (now >= opensAt! && now < endsAt! + OVERRUN_MIN * 60_000);
  const provider = !info.joinUrl ? null : /(^|\.)zoom\.(us|com)$/i.test(new URL(info.joinUrl).hostname) ? 'zoom' : 'other';
  return {
    mode: info.joinUrl ? 'link' : 'none',
    hls: null, whep: null, replayHls: null,
    isLive,
    joinUrl: info.joinUrl && usable ? info.joinUrl : null,
    startsAt, endsAt, provider,
  };
}

/**
 * What a viewer's page needs. Never contains the host start link or meeting internals.
 * `schedule` lets callers that keep their own timetable (challenge cohorts) pass it in.
 */
export async function playbackFor(rt: Runtime, key: string, fallbackJoinUrl?: string | null, schedule?: LiveSchedule | null): Promise<Playback> {
  if (!isLiveKey(key)) return playbackState({ schedule: null, joinUrl: cleanJoinUrl(fallbackJoinUrl) });
  return playbackState(await liveEvent(rt, key, fallbackJoinUrl, schedule));
}

// ───────────── public status (polled by live-player.js) ─────────────

export interface LiveStatus { isLive: boolean; startsAt: number | null; endsAt: number | null; hasLink: boolean }
const statusCache = new Map<string, { at: number; v: LiveStatus }>();
const STATUS_TTL_MS = 5_000;

/** Public, so it says only whether the event is on by the schedule and whether a link exists: never the link itself. */
export async function liveStatus(rt: Runtime, key: string): Promise<LiveStatus | null> {
  if (!isLiveKey(key)) return null;
  const hit = statusCache.get(key);
  if (hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.v;
  const info = await liveEvent(rt, key);
  if (!info.row && !info.session) return null;
  const p = playbackState(info);
  const v: LiveStatus = { isLive: p.isLive, startsAt: p.startsAt ?? null, endsAt: p.endsAt ?? null, hasLink: Boolean(info.joinUrl) };
  if (statusCache.size > 500) statusCache.clear();
  statusCache.set(key, { at: Date.now(), v });
  return v;
}

// ───────────── host side (admin only) ─────────────

/** Creates the Zoom meeting (or Zoom Webinar) for an event from its schedule and stores the links. */
export async function createZoomFor(rt: Runtime, key: string, o: { startsAt?: number; durationMin?: number; title?: string } = {}) {
  const info = await liveEvent(rt, key);
  const startsAt = o.startsAt || info.schedule?.startsAt;
  const durationMin = o.durationMin || info.schedule?.durationMin || 90;
  if (!startsAt) throw new ZoomError('Set the start time first.', 400);
  if (startsAt < Date.now() - 3 * 3600_000) throw new ZoomError('That start time has passed.', 400);
  const title = (o.title || info.title).replace(/[<>]/g, '').slice(0, 200);
  const z = await createZoomEvent(rt, { title, startsAt, durationMin });
  await upsertLiveEvent(rt, key, { title, startsAt, durationMin, joinUrl: z.joinUrl, zoom: { id: z.id, kind: z.kind, startUrl: z.startUrl, password: z.password } });
  return z;
}

/** The host's start link: a fresh one from Zoom when the event was created through the API, else null. */
export async function hostStartUrl(rt: Runtime, key: string): Promise<string | null> {
  const row = await getLiveEvent(rt, key);
  if (!row?.zoom_id) return null;
  if (zoomConfigured(rt.settings)) {
    try {
      const url = await freshStartUrl(rt, row.zoom_kind ?? 'meeting', row.zoom_id);
      if (url) {
        await rt.env.DB.prepare('UPDATE live_events SET zoom_start_url = ?, updated_at = ? WHERE key = ?').bind(url, Date.now(), key).run();
        return url;
      }
    } catch (e) {
      console.warn('zoom start url refresh failed', e);
    }
  }
  return row.zoom_start_url;
}
