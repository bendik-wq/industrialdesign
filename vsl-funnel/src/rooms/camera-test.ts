import type { Context } from 'hono';
import type { AppEnv } from '../app';

/**
 * Camera check results (/camera-test). The page posts what the browser reports for each attempt to open the
 * camera and mic (error names, sizes, frame stats; never images or audio). Kept in kv_state, newest 40.
 */
const PREFIX = 'camtest:';
const KEEP = 40;
const LIMIT_PER_IP_HOUR = 20;

export async function cameraTestPost(c: Context<AppEnv>) {
  const raw = await c.req.text();
  if (raw.length > 60_000) return c.json({ ok: false, error: 'too large' }, 413);
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return c.json({ ok: false, error: 'bad json' }, 400); }
  const db = c.env.DB;
  const ip = c.req.header('cf-connecting-ip') ?? '';
  const hour = Math.floor(Date.now() / 3_600_000);
  const rlKey = `camtest-rl:${ip}:${hour}`;
  const seen = await db.prepare('SELECT value FROM kv_state WHERE key = ?').bind(rlKey).first<{ value: string }>();
  const n = Number(seen?.value ?? 0);
  if (n >= LIMIT_PER_IP_HOUR) return c.json({ ok: false, error: 'too many checks, try again later' }, 429);
  await db.prepare('INSERT INTO kv_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(rlKey, String(n + 1)).run();

  const code = Math.random().toString(36).slice(2, 7).toUpperCase();
  const country = (c.req.raw as unknown as { cf?: { country?: string } }).cf?.country ?? null;
  const rec = { code, at: Date.now(), country, data: body };
  await db.prepare('INSERT INTO kv_state (key, value) VALUES (?, ?)').bind(`${PREFIX}${Date.now()}:${code}`, JSON.stringify(rec)).run();
  // Keep the newest KEEP checks and drop old rate-limit counters.
  await db.prepare(`DELETE FROM kv_state WHERE key LIKE '${PREFIX}%' AND key NOT IN (SELECT key FROM kv_state WHERE key LIKE '${PREFIX}%' ORDER BY key DESC LIMIT ${KEEP})`).run();
  await db.prepare("DELETE FROM kv_state WHERE key LIKE 'camtest-rl:%' AND key NOT LIKE ?").bind(`camtest-rl:%:${hour}`).run();
  return c.json({ ok: true, code });
}

export async function cameraTestList(c: Context<AppEnv>) {
  const { results } = await c.env.DB.prepare(`SELECT value FROM kv_state WHERE key LIKE '${PREFIX}%' ORDER BY key DESC LIMIT ${KEEP}`).all<{ value: string }>();
  return c.json({ checks: results.map((r) => { try { return JSON.parse(r.value); } catch { return null; } }).filter(Boolean) });
}
