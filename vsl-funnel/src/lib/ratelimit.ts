import type { Env } from '../env';

/**
 * Simple fixed-window per-key rate limit backed by kv_state. Used to throttle the public forms that
 * send email / SMS / Slack on each hit (application, webinar sign-up, data claim), so a script can't
 * flood a victim's inbox or phone from our sender. Returns true when the caller is over the limit.
 */
export async function overLimit(env: Env, key: string, max: number, windowMs = 3_600_000): Promise<boolean> {
  const k = `rl:${key}`;
  const row = await env.DB.prepare('SELECT value FROM kv_state WHERE key = ?').bind(k).first<{ value: string }>().catch(() => null);
  const now = Date.now();
  let n = 0;
  let t = now;
  try {
    const r = JSON.parse(row?.value ?? '{}') as { n?: number; t?: number };
    if (r.t && now - r.t < windowMs) { n = r.n ?? 0; t = r.t; }
  } catch { /* fresh window */ }
  if (n >= max) return true;
  await env.DB.prepare('INSERT INTO kv_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(k, JSON.stringify({ n: n + 1, t })).run();
  return false;
}
