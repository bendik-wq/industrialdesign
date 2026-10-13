import type { Runtime } from '../app';
import { webinarBase, webinarSettings } from '../webinar/webinar';

/** Funnel HQ → Webinar: sessions, registrants and how registrants move through the funnel. */
export async function webinarReport(rt: Runtime, range: { from: number; to: number }) {
  const db = rt.env.DB;
  const w = webinarSettings(rt);
  const [kpis, upcoming, past, recent] = await Promise.all([
    db.prepare(
      `SELECT COUNT(*) AS registrations, COUNT(DISTINCT r.lead_id) AS people,
              SUM(r.joined_at IS NOT NULL) AS attended, SUM(r.replay_at IS NOT NULL) AS replays, SUM(r.cta_at IS NOT NULL) AS cta,
              AVG(CASE WHEN r.joined_at IS NOT NULL THEN r.watch_seconds END) AS avg_watch_s,
              SUM(l.app_completed_at IS NOT NULL AND l.app_completed_at > r.created_at) AS applied,
              SUM(l.booked_at IS NOT NULL AND l.booked_at > r.created_at AND l.booking_cancelled_at IS NULL) AS booked,
              SUM(l.status = 'won' AND COALESCE(l.closed_at, 0) > r.created_at) AS won,
              SUM(CASE WHEN l.status = 'won' AND COALESCE(l.closed_at, 0) > r.created_at THEN l.revenue ELSE 0 END) AS revenue
         FROM webinar_registrations r JOIN leads l ON l.id = r.lead_id WHERE r.created_at BETWEEN ? AND ?`,
    ).bind(range.from, range.to).first<Record<string, number | null>>(),
    db.prepare(
      `SELECT s.*, COUNT(r.id) AS registrations FROM webinar_sessions s LEFT JOIN webinar_registrations r ON r.session_id = s.id
        WHERE s.starts_at > ? GROUP BY s.id ORDER BY s.starts_at LIMIT 12`,
    ).bind(Date.now() - w.durationMin * 60_000).all(),
    db.prepare(
      `SELECT s.*, COUNT(r.id) AS registrations, SUM(r.joined_at IS NOT NULL) AS attended, SUM(r.replay_at IS NOT NULL) AS replays,
              SUM(r.cta_at IS NOT NULL) AS cta, AVG(CASE WHEN r.joined_at IS NOT NULL THEN r.max_position END) AS avg_pos,
              SUM(l.app_completed_at IS NOT NULL AND l.app_completed_at > r.created_at) AS applied,
              SUM(l.booked_at IS NOT NULL AND l.booked_at > r.created_at AND l.booking_cancelled_at IS NULL) AS booked
         FROM webinar_sessions s LEFT JOIN webinar_registrations r ON r.session_id = s.id LEFT JOIN leads l ON l.id = r.lead_id
        WHERE s.starts_at <= ? AND s.starts_at > ? GROUP BY s.id ORDER BY s.starts_at DESC LIMIT 20`,
    ).bind(Date.now() - w.durationMin * 60_000, range.from).all(),
    db.prepare(
      `SELECT r.created_at, r.joined_at, r.watch_seconds, r.max_position, r.cta_at, r.replay_at, s.starts_at, s.mode,
              l.id AS lead_id, l.first_name, l.last_name, l.email, l.channel, l.utm_campaign, l.app_completed_at, l.booked_at, l.status, COALESCE(l.tier_override, l.tier) AS tier
         FROM webinar_registrations r JOIN webinar_sessions s ON s.id = r.session_id JOIN leads l ON l.id = r.lead_id
        WHERE r.created_at BETWEEN ? AND ? ORDER BY r.created_at DESC LIMIT 100`,
    ).bind(range.from, range.to).all(),
  ]);
  return {
    settings: {
      title: w.title, schedule: w.schedule, tz: w.tz, durationMin: w.durationMin, pitchAtMin: w.pitchAtMin, replayHours: w.replayHours,
      placeholderVideo: w.placeholderVideo, streamConfigured: Boolean(w.streamHls), url: webinarBase(rt),
    },
    kpis: kpis ?? {},
    upcoming: upcoming.results,
    past: past.results,
    registrants: recent.results,
  };
}
