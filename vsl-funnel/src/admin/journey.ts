import type { Runtime } from '../app';

/**
 * One visitor's whole journey (every visit and action across the site), plus any funnel lead they became.
 */
export async function visitorJourney(rt: Runtime, visitorId: string) {
  const db = rt.env.DB;
  const visitor = await db.prepare('SELECT * FROM visitors WHERE id = ?').bind(visitorId).first<Record<string, unknown> & { lead_id: string | null }>();
  if (!visitor) return null;
  const [sessions, events, vsl] = await Promise.all([
    db.prepare('SELECT * FROM sessions WHERE visitor_id = ? ORDER BY started_at DESC LIMIT 100').bind(visitorId).all(),
    db.prepare('SELECT id, ts, name, path, source, props, session_id FROM events WHERE visitor_id = ? ORDER BY ts DESC LIMIT 1500').bind(visitorId).all(),
    db.prepare('SELECT id, video_id, started_at, duration, max_position, watched_seconds, buckets, unmuted, completed, cta_clicked FROM vsl_views WHERE visitor_id = ? ORDER BY started_at DESC').bind(visitorId).all(),
  ]);
  let lead: { id: string; name: string; email: string | null; status: string; how: 'same browser' | 'same email' } | null = null;
  const pick = (l: { id: string; first_name: string | null; last_name: string | null; email: string | null; status: string } | null, how: 'same browser' | 'same email') =>
    l ? { id: l.id, name: [l.first_name, l.last_name].filter(Boolean).join(' ') || l.email || l.id, email: l.email, status: l.status, how } : null;
  type L = { id: string; first_name: string | null; last_name: string | null; email: string | null; status: string };
  if (visitor.lead_id) lead = pick(await db.prepare('SELECT id, first_name, last_name, email, status FROM leads WHERE id = ?').bind(visitor.lead_id).first<L>(), 'same browser');
  return { visitor, sessions: sessions.results, events: events.results, vsl: vsl.results, claims: [], lead };
}
