import type { Runtime } from '../app';
import type { Env } from '../env';
import type { Settings } from '../settings';

/**
 * Cloudflare Analytics Engine (Cloudflare platform round, builder B): a second, append-only copy of every first-party
 * tracking event (src/tracking/track.ts, which /api/e feeds) and every room quality report (src/rooms/do.ts), so the
 * owner can compare with D1 and query long ranges without loading the database. D1 stays the source of truth: its
 * writes are unchanged and happen first.
 *
 * Off by default (setting ANALYTICS_ENGINE). On, it needs the EVENTS binding (wrangler.jsonc → dataset gl_events);
 * without the binding (tests, some local runs) nothing is written and nothing fails.
 *
 * The data point layout (the dataset's columns; keep it stable, queries depend on the positions):
 *   index1   event name (Analytics Engine samples per index, so rare events stay exact)
 *   blob1    name           blob2  path        blob3  channel (first touch of this session, when known; rooms: the member's role)
 *   blob4    source (client | server | room | …)                 blob5  country (2 letters)
 *   blob6    device (mobile | desktop | tablet; rooms: os/browser) blob7  variant (A/B headline; rooms: quality level)
 *   blob8    room id        blob9  visitor id (rooms: the member id)  blob10 human | bot
 *   double1  value (props.value / amount / pct; rooms: quality score 0-100)
 *   double2  duration in ms (props.ms / duration_ms; rooms: round-trip time in ms)
 *   double3+ rooms only: loss (0-1), jitter ms, kbps in, kbps out, tier
 * Counting: SUM(_sample_interval), never COUNT(), because Analytics Engine may sample.
 */

export const AE_DATASET = 'gl_events';
export const AE_BLOBS = ['name', 'path', 'channel', 'source', 'country', 'device', 'variant', 'room_id', 'visitor_id', 'kind'] as const;
export const AE_DOUBLES = ['value', 'duration_ms', 'loss', 'jitter_ms', 'kbps_in', 'kbps_out', 'tier'] as const;
const BLOB_MAX = 256;

export interface AePoint {
  name: string;
  path?: string | null;
  channel?: string | null;
  source?: string | null;
  country?: string | null;
  device?: string | null;
  variant?: string | null;
  roomId?: string | null;
  visitorId?: string | null;
  bot?: boolean;
  value?: number | null;
  durationMs?: number | null;
  /** Rooms only: loss, jitter, kbps in, kbps out, tier (double3 onward). */
  extra?: (number | null | undefined)[];
}

const on = (v: string | undefined) => /^(on|1|true|yes)$/i.test((v ?? '').trim());
/** Copying to Analytics Engine: setting on and the binding present. */
export const aeOn = (rt: { env: Pick<Env, 'EVENTS'>; settings: Pick<Settings, 'ANALYTICS_ENGINE'> }) => on(rt.settings.ANALYTICS_ENGINE) && Boolean(rt.env.EVENTS);

const blob = (v: string | null | undefined) => (v ?? '').slice(0, BLOB_MAX);
const dbl = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The data point exactly as written (exported for tests). */
export function toDataPoint(p: AePoint): AnalyticsEngineDataPoint {
  return {
    indexes: [p.name.slice(0, 96)],
    blobs: [p.name, p.path, p.channel, p.source, p.country, p.device, p.variant, p.roomId, p.visitorId, p.bot ? 'bot' : 'human'].map(blob),
    doubles: [dbl(p.value), dbl(p.durationMs), ...(p.extra ?? []).map(dbl)],
  };
}

/** Writes one point when on. Never throws, never awaits (writeDataPoint is fire-and-forget). */
export function writeAe(rt: { env: Pick<Env, 'EVENTS'>; settings: Pick<Settings, 'ANALYTICS_ENGINE'> }, p: AePoint): boolean {
  if (!aeOn(rt)) return false;
  try { rt.env.EVENTS!.writeDataPoint(toDataPoint(p)); return true; } catch (e) { console.error('analytics engine write', String(e).slice(0, 200)); return false; }
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** A tracking event's value and duration from its props (see the layout above). */
export function eventMeasures(props: Record<string, unknown> | undefined) {
  const p = props ?? {};
  return {
    value: num(p.value) ?? num(p.amount) ?? num(p.pct),
    durationMs: num(p.ms) ?? num(p.duration_ms),
    roomId: typeof p.room_id === 'string' ? p.room_id : null,
  };
}

// ───────────── reading it back (Funnel HQ → Errors & cron → Events (Analytics Engine)) ─────────────

export const AE_SQL = {
  perDay: (days: number) => `SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day, blob1 AS name, SUM(_sample_interval) AS n FROM ${AE_DATASET} WHERE timestamp > NOW() - INTERVAL '${days}' DAY GROUP BY day, name ORDER BY day DESC, n DESC LIMIT 5000 FORMAT JSON`,
  topPaths: (days: number) => `SELECT blob2 AS path, SUM(_sample_interval) AS n FROM ${AE_DATASET} WHERE timestamp > NOW() - INTERVAL '${days}' DAY AND blob1 = 'page_view' GROUP BY path ORDER BY n DESC LIMIT 25 FORMAT JSON`,
};

async function sql<T>(accountId: string, token: string, query: string): Promise<T[]> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/analytics_engine/sql`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: query, signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Analytics Engine SQL API answered ${res.status}: ${text.replace(/\s+/g, ' ').slice(0, 200)}`);
  const j = JSON.parse(text) as { data?: T[] };
  return Array.isArray(j.data) ? j.data : [];
}

const dayKey = (v: unknown) => String(v ?? '').slice(0, 10);

/** Events per day by name (Analytics Engine and D1 side by side) and the top paths, for `days` days. */
export async function aeEventsReport(rt: Pick<Runtime, 'env' | 'settings'>, now = Date.now(), days = 30) {
  const s = rt.settings;
  const accountId = s.CF_ACCOUNT_ID?.trim();
  const token = s.CF_ANALYTICS_TOKEN?.trim();
  const status = { on: on(s.ANALYTICS_ENGINE), binding: Boolean(rt.env.EVENTS), dataset: AE_DATASET, days };
  // D1's own count for the same window, so the two can be compared.
  const since = now - days * 86_400_000;
  const { results: d1 } = await rt.env.DB.prepare(
    "SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch') AS day, name, COUNT(*) AS n FROM events WHERE ts > ? GROUP BY 1, 2",
  ).bind(since).all<{ day: string; name: string; n: number }>();
  // One row per day and event name from either side; ae is null when Analytics Engine couldn't be read.
  const merge = (ae: { day: string; name: string; n: number }[] | null) => {
    const rows = new Map<string, { day: string; name: string; ae: number | null; d1: number }>();
    for (const r of d1) rows.set(`${r.day}|${r.name}`, { day: r.day, name: r.name, ae: ae ? 0 : null, d1: r.n });
    for (const r of ae ?? []) {
      const k = `${r.day}|${r.name}`;
      const row = rows.get(k) ?? { day: r.day, name: r.name, ae: 0, d1: 0 };
      row.ae = (row.ae ?? 0) + r.n;
      rows.set(k, row);
    }
    return [...rows.values()].sort((a, b) => (a.day === b.day ? (b.ae ?? b.d1) - (a.ae ?? a.d1) : a.day < b.day ? 1 : -1));
  };
  if (!accountId || !token) return { ...status, configured: false, error: null, rows: merge(null), paths: [] };
  try {
    const [perDay, paths] = await Promise.all([
      sql<{ day: string; name: string; n: number | string }>(accountId, token, AE_SQL.perDay(days)),
      sql<{ path: string; n: number | string }>(accountId, token, AE_SQL.topPaths(days)),
    ]);
    const ae = perDay.map((r) => ({ day: dayKey(r.day), name: String(r.name ?? ''), n: Math.round(Number(r.n) || 0) }));
    return { ...status, configured: true, error: null, rows: merge(ae), paths: paths.map((p) => ({ path: p.path || '(none)', n: Math.round(Number(p.n) || 0) })) };
  } catch (e) {
    return { ...status, configured: true, error: String((e as Error)?.message ?? e).slice(0, 300), rows: merge(null), paths: [] };
  }
}
