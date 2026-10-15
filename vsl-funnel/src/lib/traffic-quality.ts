import type { Runtime } from '../app';
import type { Env } from '../env';
import { DATACENTER_ORG } from './geo';

/**
 * Keeps non-people out of the numbers after the fact. Some of it can't be decided on the first request:
 * a visit from a hosting company's network (scripts, scanners, AI tools) looks like a person until it
 * never scrolls, plays or clicks. Real people on a VPN do scroll, so only silent ones are removed.
 */

const SILENT = 'COALESCE(s.engaged_ms, 0) = 0 AND COALESCE(s.max_scroll, 0) = 0 AND s.pageviews <= 1';

async function markSessions(env: Env, ids: { id: string; visitor_id: string; reason: string }[]) {
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    await env.DB.batch(chunk.flatMap((r) => [
      env.DB.prepare('UPDATE sessions SET is_bot = 1, bot_reason = ? WHERE id = ? AND is_bot = 0').bind(r.reason, r.id),
      env.DB.prepare('UPDATE events SET is_bot = 1 WHERE session_id = ?').bind(r.id),
      // The visitor only stops counting if none of their visits were a person.
      env.DB.prepare('UPDATE visitors SET is_bot = 1 WHERE id = ? AND lead_id IS NULL AND NOT EXISTS (SELECT 1 FROM sessions WHERE visitor_id = ? AND is_bot = 0)').bind(r.visitor_id, r.visitor_id),
    ]));
  }
}

/** Every 5 minutes: silent visits from hosting networks, link checkers and script user agents become bots. */
export async function sweepBots(rt: Runtime) {
  const env = rt.env;
  const now = Date.now();
  // The first run goes back over everything already recorded; after that, the last two days.
  const done = await env.DB.prepare("SELECT value FROM kv_state WHERE key = 'botsweep:v1'").first<{ value: string }>();
  const from = done ? now - 2 * 86_400_000 : 0;
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.visitor_id, s.as_org, s.asn, s.user_agent FROM sessions s
      WHERE s.is_bot = 0 AND s.started_at BETWEEN ? AND ? AND ${SILENT}
        AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.visitor_id = s.visitor_id)
      ORDER BY s.started_at DESC LIMIT 2000`,
  ).bind(from, now - 30 * 60_000).all<{ id: string; visitor_id: string; as_org: string | null; asn: number | null; user_agent: string | null }>();
  const hits = results.flatMap((s) => {
    const reason =
      s.asn === 32934 || /facebook|meta platforms/i.test(s.as_org ?? '') ? 'link-checker'
      : s.user_agent && !s.user_agent.includes('(') ? 'fake-ua'
      : s.as_org && DATACENTER_ORG.test(s.as_org) ? 'datacenter'
      : null;
    return reason ? [{ id: s.id, visitor_id: s.visitor_id, reason }] : [];
  });
  await markSessions(env, hits);
  if (!done) await env.DB.prepare("INSERT INTO kv_state (key, value) VALUES ('botsweep:v1', ?) ON CONFLICT(key) DO NOTHING").bind(String(now)).run();
  return { checked: results.length, marked: hits.length };
}

/** On login: this browser's earlier visits were you testing, so they stop counting too. */
export async function markInternal(env: Env, visitorId: string | undefined) {
  if (!visitorId || !/^v[0-9a-z]{12,24}$/.test(visitorId)) return;
  const { results } = await env.DB.prepare('SELECT id, visitor_id FROM sessions WHERE visitor_id = ? AND is_bot = 0 LIMIT 500').bind(visitorId).all<{ id: string; visitor_id: string }>();
  await markSessions(env, results.map((r) => ({ ...r, reason: 'internal' })));
}
