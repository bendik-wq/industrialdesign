import type { Runtime } from '../app';

const DAY = 86_400_000;
/** Website usage data: 13 months (matches the privacy policy). */
export const USAGE_RETENTION_DAYS = 395;

/**
 * Once a day: delete raw interaction events older than 13 months and strip the identifying parts of old
 * sessions (IP, user agent, precise location), keeping only the aggregate numbers the dashboard needs.
 */
export async function purgeOld(rt: Runtime) {
  const db = rt.env.DB;
  const last = await db.prepare("SELECT value FROM kv_state WHERE key = 'purge:last'").first<{ value: string }>();
  if (last && Date.now() - Number(last.value) < DAY) return null;
  await db.prepare("INSERT INTO kv_state (key, value) VALUES ('purge:last', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(Date.now())).run();
  const cutoff = Date.now() - USAGE_RETENTION_DAYS * DAY;
  const events = await db.prepare(
    "DELETE FROM events WHERE ts < ? AND name NOT IN ('lead_captured', 'app_submitted', 'lead_qualified', 'booking_scheduled', 'booking_cancelled', 'lead_status_changed', 'unsubscribe') ",
  ).bind(cutoff).run();
  const sessions = await db.prepare(
    'UPDATE sessions SET ip = NULL, user_agent = NULL, latitude = NULL, longitude = NULL, postal_code = NULL, city = NULL WHERE started_at < ? AND (ip IS NOT NULL OR user_agent IS NOT NULL OR latitude IS NOT NULL)',
  ).bind(cutoff).run();
  return { events: events.meta.changes, sessions: sessions.meta.changes };
}
