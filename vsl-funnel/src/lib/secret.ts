import type { Env } from '../env';

let cached: string | null = null;

/**
 * HMAC secret for signed links, admin sessions and IP hashing. Uses
 * SESSION_SECRET when set; otherwise generates one on first use and keeps it in
 * D1 so it survives deploys.
 */
export async function getSecret(env: Env): Promise<string> {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (cached) return cached;
  const row = await env.DB.prepare("SELECT value FROM kv_state WHERE key = 'session_secret'").first<{ value: string }>();
  if (row) return (cached = row.value);
  const fresh = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
  await env.DB.prepare("INSERT OR IGNORE INTO kv_state (key, value) VALUES ('session_secret', ?)").bind(fresh).run();
  const saved = await env.DB.prepare("SELECT value FROM kv_state WHERE key = 'session_secret'").first<{ value: string }>();
  return (cached = saved!.value);
}
