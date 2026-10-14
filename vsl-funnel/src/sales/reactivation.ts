import type { Runtime } from '../app';
import type { Lead } from '../funnel/leads';
import { enqueueSequence, zonedTime } from '../integrations/email';

/**
 * Reactivation: re-engage people already in the database. Launched by hand from Funnel HQ after the
 * owner has reviewed (and can untick) every person. Never automatic: imported Calendly contacts only ever
 * get this when someone chooses to send it.
 */

export const REACTIVATION_SEGMENTS = {
  past_call: { label: 'Had a call, nothing logged', hint: 'Past calls with no outcome recorded. Untick anyone who’s already a client.', where: "l.booked_at IS NOT NULL AND l.booking_cancelled_at IS NULL AND l.status = 'booked' AND COALESCE(l.call_at, l.booked_at) < :now - 2 * 86400000" },
  no_show: { label: 'No-shows', hint: 'Missed their call more than 3 days ago and never rebooked.', where: "l.status = 'no_show' AND l.updated_at < :now - 3 * 86400000" },
  cancelled: { label: 'Cancelled, never rebooked', hint: 'Cancelled their call and didn’t book again.', where: "l.booking_cancelled_at IS NOT NULL AND l.booking_cancelled_at < :now - 3 * 86400000 AND l.status NOT IN ('won', 'lost')" },
  applied: { label: 'Applied, never booked', hint: 'Finished the application at least a week ago but never booked.', where: "l.app_completed_at IS NOT NULL AND l.booked_at IS NULL AND l.app_completed_at < :now - 7 * 86400000" },
  partial: { label: 'Started the application, didn’t finish', hint: 'Left contact details at least a week ago.', where: "l.app_completed_at IS NULL AND l.booked_at IS NULL AND l.created_at < :now - 7 * 86400000" },
  nurture: { label: 'Nurture (not ready yet)', hint: 'Marked nurture, usually C-tier.', where: "l.status = 'nurture'" },
  lost: { label: 'Lost more than 60 days ago', hint: 'Said no on the call; circumstances change.', where: "l.status = 'lost' AND l.updated_at < :now - 60 * 86400000" },
} as const;
export type Segment = keyof typeof REACTIVATION_SEGMENTS;

/** Never in a reactivation: unsubscribed, no email, clients, ruled out, already reactivated in the last 90 days. */
const BASE = "l.email IS NOT NULL AND l.unsubscribed_at IS NULL AND l.status NOT IN ('won', 'disqualified') AND (r.reactivated_at IS NULL OR r.reactivated_at < :now - 90 * 86400000)";

export interface AudienceRow { id: string; first_name: string | null; last_name: string | null; email: string; status: string; tier: string | null; booking_source: string | null; call_at: number | null; created_at: number; segment: Segment }

export async function reactivationAudience(rt: Runtime, segments: Segment[] = Object.keys(REACTIVATION_SEGMENTS) as Segment[]) {
  const now = Date.now();
  const out: AudienceRow[] = [];
  const seen = new Set<string>();
  const counts: Record<string, number> = {};
  for (const seg of Object.keys(REACTIVATION_SEGMENTS) as Segment[]) {
    const where = REACTIVATION_SEGMENTS[seg].where;
    const sql = `SELECT l.id, l.first_name, l.last_name, l.email, l.status, COALESCE(l.tier_override, l.tier) AS tier, l.booking_source, l.call_at, l.created_at
                   FROM leads l LEFT JOIN lead_reactivation r ON r.lead_id = l.id WHERE ${BASE} AND (${where}) ORDER BY l.created_at DESC LIMIT 2000`.replace(/:now/g, String(now));
    const { results } = await rt.env.DB.prepare(sql).all<Omit<AudienceRow, 'segment'>>();
    counts[seg] = 0;
    for (const r of results) {
      if (seen.has(r.id)) continue; // first matching segment wins
      seen.add(r.id);
      counts[seg]++;
      if (segments.includes(seg)) out.push({ ...r, segment: seg });
    }
  }
  return { rows: out, counts };
}

/**
 * Queues the 6-email reactivation for the chosen people, spread out: `perDay` new people a day, each
 * starting at 8am (sales time zone), a couple of minutes apart; each then gets 5 emails a day for 4 days, so the domain's reputation isn't hit.
 */
export async function launchReactivation(rt: Runtime, ids: string[], perDay: number) {
  const now = Date.now();
  const tz = rt.settings.SALES_TIMEZONE || 'Australia/Sydney';
  const per = Math.max(5, Math.min(200, Math.floor(perDay) || 40));
  const { rows } = await reactivationAudience(rt);
  const allowed = new Map(rows.map((r) => [r.id, r]));
  const pick = [...new Set(ids)].filter((id) => allowed.has(id));
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hourCycle: 'h23' }).formatToParts(now);
  const g = (k: string) => Number(p.find((x) => x.type === k)!.value);
  // Start today if it's still early there (the day's 5 emails run 8am–7pm), otherwise tomorrow.
  const firstDay = g('hour') < 8 ? 0 : 1;
  let launched = 0;
  for (let i = 0; i < pick.length; i++) {
    const r = allowed.get(pick[i])!;
    const day = firstDay + Math.floor(i / per);
    const d = new Date(Date.UTC(g('year'), g('month') - 1, g('day') + day));
    const eight = zonedTime(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 8, tz);
    const startAt = Math.max(now + 5 * 60_000, eight + (i % per) * 2 * 60_000);
    await rt.env.DB.prepare('INSERT INTO lead_reactivation (lead_id, reactivated_at, segment) VALUES (?, ?, ?) ON CONFLICT(lead_id) DO UPDATE SET reactivated_at = excluded.reactivated_at, segment = excluded.segment').bind(r.id, startAt, r.segment).run();
    await rt.env.DB.prepare("UPDATE emails SET status = 'cancelled' WHERE lead_id = ? AND sequence = 'reactivation' AND status = 'pending'").bind(r.id).run();
    await enqueueSequence(rt, { id: r.id, email: r.email, call_at: null, unsubscribed_at: null } as Pick<Lead, 'id' | 'email' | 'call_at' | 'unsubscribed_at'>, 'reactivation', { startAt });
    launched++;
  }
  return { launched, days: Math.ceil(pick.length / per), skipped: ids.length - pick.length };
}

/** Results: how far each person got, and who came back (booked or applied after being reactivated). */
export async function reactivationReport(rt: Runtime) {
  const db = rt.env.DB;
  const [steps, people] = await Promise.all([
    db.prepare(`SELECT template, SUM(status IN ('sent','simulated')) AS sent, SUM(status = 'pending') AS pending, SUM(status = 'skipped') AS skipped,
                       SUM(opened_at IS NOT NULL) AS opened, SUM(clicked_at IS NOT NULL) AS clicked
                  FROM emails WHERE sequence = 'reactivation' GROUP BY template ORDER BY template`).all(),
    db.prepare(`SELECT l.id, l.first_name, l.last_name, l.email, l.status, r.reactivated_at, r.segment AS reactivation_segment,
                       (l.booked_at > r.reactivated_at AND l.booking_cancelled_at IS NULL) AS rebooked, (l.app_completed_at > r.reactivated_at) AS reapplied,
                       l.unsubscribed_at > r.reactivated_at AS unsubscribed
                  FROM lead_reactivation r JOIN leads l ON l.id = r.lead_id ORDER BY r.reactivated_at DESC LIMIT 500`).all<Record<string, number | string | null>>(),
  ]);
  const p = people.results;
  return {
    steps: steps.results,
    people: p,
    totals: { reactivated: p.length, rebooked: p.filter((x) => x.rebooked).length, reapplied: p.filter((x) => x.reapplied).length, unsubscribed: p.filter((x) => x.unsubscribed).length },
  };
}
