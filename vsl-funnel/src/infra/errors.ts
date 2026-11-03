import type { Runtime } from '../app';
import type { Env } from '../env';

/**
 * Internal error log (Funnel HQ → Errors & cron). Unhandled request errors (app.onError), webhook failures,
 * cron job failures and Durable Object (room) errors land in `app_errors`, one row per fingerprint with a count
 * and first/last seen, plus a per-day count. Kept 14 days. Optional Slack ping the first time a fingerprint is
 * seen (setting ERRORS_SLACK = on; off by default).
 *
 * recordError never throws and never blocks the caller for long: a broken error log must not break the app.
 */
/** csp: a Content-Security-Policy violation a browser reported (src/infra/csp.ts). queue: the send queue (src/infra/queue.ts) and the live reminder workflow. */
export type ErrorKind = 'request' | 'webhook' | 'cron' | 'room' | 'csp' | 'queue';

export const ERROR_RETENTION_DAYS = 14;
const DAY = 86_400_000;
/** At most this many error-log writes per isolate per minute (a crash loop must not hammer D1). */
const WRITES_PER_MINUTE = 60;
/** At most this many "new error" Slack pings per hour. */
export const SLACK_PINGS_PER_HOUR = 5;

/** Masks things that look like secrets or personal data, so the log never stores them. */
export function scrub(s: string): string {
  return s
    .replace(/\b(bearer|basic)\s+[\w.~+/=-]{8,}/gi, '$1 ***')
    .replace(/([?&](?:\w*(?:key|token|secret)|sig|signature|password|code|t)=)[^&\s"']+/gi, '$1***')
    .replace(/\b(sk|pk|rk|whsec|apik|re|cfat|xox[abp])_[\w-]{6,}/gi, '$1_***')
    // Anthropic, GitHub, Google, AWS and Meta key shapes, and JWTs (security round).
    .replace(/\bsk-ant-[\w-]{6,}/g, 'sk-ant-***')
    .replace(/\b(gh[pousr])_\w{6,}/g, '$1_***')
    .replace(/\bAIza[\w-]{10,}/g, 'AIza***')
    .replace(/\bAKIA[0-9A-Z]{12,}/g, 'AKIA***')
    .replace(/\bEAA[A-Za-z0-9]{20,}/g, 'EAA***')
    .replace(/\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]+/g, '<jwt>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .replace(/\+?\d[\d\s-]{8,}\d/g, '<number>');
}

/** The message with the variable parts blanked out, so the same bug with different ids is one fingerprint. */
export function normaliseMessage(msg: string): string {
  return scrub(msg)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\b[A-Za-z]*_[A-Za-z0-9]{6,}\b/g, '<id>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<id>')
    .replace(/\d+(\.\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** A route path with ids replaced, for errors outside a named route: /rooms/r_abc123/done → /rooms/:x/done. */
export function normalisePath(path: string): string {
  return path
    .split('/')
    .map((seg) => (seg && (/\d/.test(seg) && seg.length > 3 || seg.length > 24) ? ':x' : seg))
    .join('/')
    .slice(0, 120);
}

/** FNV-1a 32-bit, twice with different seeds: a short, stable, dependency-free fingerprint. */
export function fingerprint(kind: string, source: string, message: string): string {
  const s = `${kind}|${source}|${normaliseMessage(message)}`;
  const h = (seed: number) => {
    let x = seed >>> 0;
    for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 0x01000193) >>> 0; }
    return x.toString(16).padStart(8, '0');
  };
  return h(0x811c9dc5) + h(0x9747b28c);
}

export function describeError(e: unknown): { message: string; stack: string | null } {
  if (e instanceof Error) {
    const name = e.name && e.name !== 'Error' ? `${e.name}: ` : '';
    const stack = (e.stack ?? '').split('\n').slice(1, 7).map((l) => l.trim()).filter(Boolean).join('\n');
    return { message: scrub(`${name}${e.message || 'error'}`).slice(0, 500), stack: stack ? scrub(stack).slice(0, 1200) : null };
  }
  const message = typeof e === 'string' ? e : (() => { try { return JSON.stringify(e) ?? String(e); } catch { return String(e); } })();
  return { message: scrub(message || 'unknown error').slice(0, 500), stack: null };
}

const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);

let windowStart = 0;
let windowWrites = 0;
function allowWrite(now: number) {
  if (now - windowStart > 60_000) { windowStart = now; windowWrites = 0; }
  windowWrites++;
  return windowWrites <= WRITES_PER_MINUTE;
}
/** Tests only. */
export function resetErrorThrottle() { windowStart = 0; windowWrites = 0; }

export interface RecordOpts {
  kind: ErrorKind;
  source: string;
  /** With a runtime, a brand new fingerprint can ping Slack (when ERRORS_SLACK is on). */
  rt?: Runtime | null;
  now?: number;
}

/** Records one error. Returns the fingerprint and whether it is new, or null when it couldn't be written. */
export async function recordError(env: Pick<Env, 'DB'> | null | undefined, e: unknown, o: RecordOpts): Promise<{ fingerprint: string; isNew: boolean } | null> {
  try {
    if (!env?.DB) return null;
    const now = o.now ?? Date.now();
    if (!allowWrite(now)) return null;
    const { message, stack } = describeError(e);
    const source = (o.source || 'unknown').slice(0, 160);
    const fp = fingerprint(o.kind, source, message);
    const rows = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO app_errors (fingerprint, kind, source, message, stack, count, first_at, last_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(fingerprint) DO UPDATE SET count = count + 1, last_at = excluded.last_at, message = excluded.message, stack = COALESCE(excluded.stack, stack)`,
      ).bind(fp, o.kind, source, message, stack, now, now),
      env.DB.prepare(
        `INSERT INTO app_error_days (day, fingerprint, kind, count) VALUES (?, ?, ?, 1)
         ON CONFLICT(day, fingerprint) DO UPDATE SET count = count + 1`,
      ).bind(dayOf(now), fp, o.kind),
      env.DB.prepare('SELECT count, notified_at FROM app_errors WHERE fingerprint = ?').bind(fp),
    ]);
    const row = ((rows[2] as { results?: { count: number; notified_at: number | null }[] })?.results ?? [])[0];
    const isNew = Number(row?.count ?? 0) === 1;
    if (isNew && o.rt && slackOn(o.rt)) await pingNew(o.rt, fp, o.kind, source, message, now);
    return { fingerprint: fp, isNew };
  } catch (err) {
    console.error('error log write failed', err);
    return null;
  }
}

export const slackOn = (rt: Runtime) => String((rt.settings as Partial<Record<string, string>>).ERRORS_SLACK ?? '').trim().toLowerCase() === 'on';

async function pingNew(rt: Runtime, fp: string, kind: ErrorKind, source: string, message: string, now: number) {
  try {
    const key = `errors:slack:${Math.floor(now / 3_600_000)}`;
    const r = await rt.env.DB.prepare(
      "INSERT INTO kv_state (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) RETURNING value",
    ).bind(key).first<{ value: string }>();
    if (Number(r?.value ?? 0) > SLACK_PINGS_PER_HOUR) return;
    const { postOps } = await import('../ops/slack');
    const out = await postOps(rt, { title: `New error (${kind}): ${source}`, lines: [message.slice(0, 300)], path: '/admin#errors', linkText: 'Open Errors in Funnel HQ' });
    if (out.slack || out.discord) await rt.env.DB.prepare('UPDATE app_errors SET notified_at = ? WHERE fingerprint = ?').bind(now, fp).run();
  } catch (e) {
    console.error('error ping failed', e);
  }
}

/** Removes error-log rows older than 14 days. At most once an hour (kv_state throttle). */
export async function purgeErrors(rt: Pick<Runtime, 'env'>, now = Date.now()) {
  const db = rt.env.DB;
  const last = await db.prepare("SELECT value FROM kv_state WHERE key = 'errors:purge'").first<{ value: string }>();
  if (last && now - Number(last.value) < 3_600_000) return null;
  await db.prepare("INSERT INTO kv_state (key, value) VALUES ('errors:purge', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(now)).run();
  const cutoff = now - ERROR_RETENTION_DAYS * DAY;
  const a = await db.prepare('DELETE FROM app_errors WHERE last_at < ?').bind(cutoff).run();
  const b = await db.prepare('DELETE FROM app_error_days WHERE day < ?').bind(dayOf(cutoff)).run();
  return { errors: a.meta.changes, days: b.meta.changes };
}

// ───────────── Funnel HQ report ─────────────

export interface ErrorRow { fingerprint: string; kind: string; source: string; message: string; stack: string | null; count: number; first_at: number; last_at: number; notified_at: number | null; recent: number }

export async function errorsReport(env: Pick<Env, 'DB'>, now = Date.now(), days = ERROR_RETENTION_DAYS) {
  const span = Math.max(1, Math.min(ERROR_RETENTION_DAYS, Math.floor(days)));
  const fromDay = dayOf(now - (span - 1) * DAY);
  const [perDay, top, recent] = await Promise.all([
    env.DB.prepare('SELECT day, kind, SUM(count) AS n, COUNT(*) AS fps FROM app_error_days WHERE day >= ? GROUP BY day, kind ORDER BY day').bind(fromDay).all<{ day: string; kind: string; n: number; fps: number }>(),
    env.DB.prepare(
      `SELECT e.fingerprint, e.kind, e.source, e.message, e.stack, e.count, e.first_at, e.last_at, e.notified_at,
              COALESCE((SELECT SUM(d.count) FROM app_error_days d WHERE d.fingerprint = e.fingerprint AND d.day >= ?), 0) AS recent
       FROM app_errors e WHERE e.last_at >= ? ORDER BY e.last_at DESC LIMIT 200`,
    ).bind(fromDay, now - span * DAY).all<ErrorRow>(),
    env.DB.prepare('SELECT COALESCE(SUM(count), 0) AS n FROM app_error_days WHERE day = ?').bind(dayOf(now)).first<{ n: number }>(),
  ]);
  // Every day in the window, zero-filled, split by kind.
  const byDay: { day: string; total: number; fingerprints: number; kinds: Record<string, number> }[] = [];
  for (let i = span - 1; i >= 0; i--) byDay.push({ day: dayOf(now - i * DAY), total: 0, fingerprints: 0, kinds: {} });
  const idx = new Map(byDay.map((d, i) => [d.day, i]));
  for (const r of perDay.results ?? []) {
    const d = byDay[idx.get(r.day) ?? -1];
    if (!d) continue;
    d.total += Number(r.n); d.fingerprints += Number(r.fps); d.kinds[r.kind] = (d.kinds[r.kind] ?? 0) + Number(r.n);
  }
  const rows = (top.results ?? []).map((r) => ({ ...r, count: Number(r.count), recent: Number(r.recent) }));
  return {
    days: byDay,
    fingerprints: rows,
    totals: {
      today: Number(recent?.n ?? 0),
      window: byDay.reduce((a, d) => a + d.total, 0),
      distinct: rows.length,
      newToday: rows.filter((r) => r.first_at >= Date.parse(`${dayOf(now)}T00:00:00Z`)).length,
    },
    retentionDays: ERROR_RETENTION_DAYS,
  };
}
