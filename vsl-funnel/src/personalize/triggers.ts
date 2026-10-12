import type { Runtime } from '../app';
import { VIDEOS } from '../config';
import type { Lead } from '../funnel/leads';
import { newId } from '../lib/ids';
import { BEHAVIOUR_TEMPLATES } from '../integrations/sequences';

/**
 * Behaviour-triggered emails: when someone does something specific on the
 * page, they get one email about exactly that (rewritten for them by the
 * personaliser, like every other email).
 *
 * Every 5 minutes: look at leads active in the last 3 hours, work out their
 * signals in a few batched queries, and queue any rule that matches. Each rule
 * fires at most once per person, there's a daily cap across all emails, and
 * the condition is re-checked right before sending (e.g. they booked meanwhile).
 */
export interface Signals {
  lead: Lead;
  sessions: number;
  sessionsAfterApply: number;
  mainVslPct: number;
  breakoutPct: number;
  precallViews: number;
  pickedDate: boolean;
  bookViews24h: number;
  emailClicks24h: number;
  guaranteeSeconds: number;
  guaranteeRevisit: boolean;
  fundingInterest: boolean;
  lastActivity: number;
}

export interface Rule {
  template: string;
  label: string;
  /** Minutes after the behaviour before sending (gives them a chance to finish on their own). */
  delay: number;
  when: (s: Signals, now: number) => boolean;
}

const booked = (l: Lead) => Boolean(l.booked_at) && !l.booking_cancelled_at;
const qualified = (l: Lead) => Boolean(l.app_completed_at) && ['A', 'B'].includes(l.tier_override ?? l.tier ?? '');

export const RULES: Rule[] = [
  { template: 't_vsl_no_apply', label: 'Watched most of the video, didn’t finish applying', delay: 30, when: (s) => !s.lead.app_completed_at && s.mainVslPct >= 0.5 },
  { template: 't_stalled', label: 'Stopped partway through the application', delay: 45, when: (s, now) => Boolean(s.lead.app_started_at) && !s.lead.app_completed_at && s.lead.step_reached >= 2 && now - s.lastActivity > 30 * 60_000 },
  { template: 't_finish_booking', label: 'Picked a day on the calendar, didn’t confirm', delay: 25, when: (s) => s.pickedDate && !booked(s.lead) && qualified(s.lead) },
  { template: 't_came_back', label: 'Qualified, not booked, came back to the site', delay: 40, when: (s) => qualified(s.lead) && !booked(s.lead) && s.sessionsAfterApply >= 1 },
  { template: 't_still_thinking', label: '3+ visits without booking', delay: 60, when: (s) => s.sessions >= 3 && !booked(s.lead) && Boolean(s.lead.app_completed_at) },
  { template: 't_guarantee', label: 'Read or re-read the guarantee, not booked', delay: 60, when: (s) => !booked(s.lead) && (s.guaranteeSeconds >= 8 || s.guaranteeRevisit) },
  { template: 't_funding', label: 'Looked into the funding (FAQ, rewatched, highlighted)', delay: 60, when: (s) => !booked(s.lead) && s.fundingInterest },
  { template: 't_book_nudge', label: 'Opened the booking page, didn’t book', delay: 30, when: (s) => qualified(s.lead) && !booked(s.lead) && s.bookViews24h >= 1 && !s.pickedDate },
  { template: 't_breakout_done', label: 'Watched the breakout video, didn’t book', delay: 30, when: (s) => qualified(s.lead) && !booked(s.lead) && s.breakoutPct >= 0.7 },
  { template: 't_watch_prep', label: 'Booked over 12h ago, hasn’t watched the pre-call video', delay: 0, when: (s, now) => booked(s.lead) && s.lead.status === 'booked' && now - (s.lead.booked_at ?? now) > 12 * 3_600_000 && s.precallViews === 0 && Boolean(s.lead.call_at && s.lead.call_at - now > 6 * 3_600_000) },
];

const FUNDING = /money|financ|fund|bank|debt|seller|capital|dscr|no money down|over-?financ/i;
const DAILY_CAP = 8; // all emails to one person in 24h, including the pre-call barrage

export async function processTriggers(rt: Runtime, now = Date.now()) {
  const db = rt.env.DB;
  const active = await db.prepare(
    `SELECT DISTINCT lead_id FROM events WHERE ts > ? AND lead_id IS NOT NULL AND source IN ('client', 'server') AND is_bot = 0 LIMIT 100`,
  ).bind(now - 3 * 3_600_000).all<{ lead_id: string }>();
  const ids = active.results.map((r) => r.lead_id);
  if (!ids.length) return { checked: 0, queued: 0 };
  const inList = ids.map(() => '?').join(',');

  const [leads, agg, texts, vsl, sess, fired, recent] = await Promise.all([
    db.prepare(`SELECT * FROM leads WHERE id IN (${inList}) AND email IS NOT NULL AND unsubscribed_at IS NULL AND COALESCE(booking_source, '') != 'calendly-direct' AND status NOT IN ('won', 'lost', 'disqualified')`).bind(...ids).all<Lead>(),
    db.prepare(
      `SELECT lead_id, MAX(ts) AS last_ts,
              SUM(name = 'booking_date_selected') AS picked,
              SUM(name = 'page_view' AND path = '/book' AND ts > ?) AS book_views,
              SUM(name = 'email_click' AND ts > ?) AS email_clicks,
              SUM(name = 'section_revisit' AND json_extract(props, '$.section') = 'guarantee') AS g_revisit,
              COALESCE(SUM(CASE WHEN name = 'section_dwell' THEN json_extract(props, '$.guarantee') END), 0) AS g_seconds
         FROM events WHERE lead_id IN (${inList}) GROUP BY lead_id`,
    ).bind(now - 86_400_000, now - 86_400_000, ...ids).all<{ lead_id: string; last_ts: number; picked: number; book_views: number; email_clicks: number; g_revisit: number; g_seconds: number }>(),
    db.prepare(`SELECT lead_id, name, props FROM events WHERE lead_id IN (${inList}) AND name IN ('faq_open', 'text_select', 'text_copy', 'vsl_rewatch', 'vsl_pause') LIMIT 2000`).bind(...ids).all<{ lead_id: string; name: string; props: string | null }>(),
    db.prepare(`SELECT lead_id, video_id, MAX(MIN(1.0, max_position / NULLIF(duration, 0))) AS pct, COUNT(*) AS views FROM vsl_views WHERE lead_id IN (${inList}) AND is_bot = 0 GROUP BY 1, 2`).bind(...ids).all<{ lead_id: string; video_id: string; pct: number | null; views: number }>(),
    db.prepare(`SELECT v.lead_id, s.started_at FROM sessions s JOIN visitors v ON v.id = s.visitor_id WHERE v.lead_id IN (${inList}) AND s.is_bot = 0`).bind(...ids).all<{ lead_id: string; started_at: number }>(),
    db.prepare(`SELECT lead_id, template FROM emails WHERE sequence = 'behaviour' AND lead_id IN (${inList})`).bind(...ids).all<{ lead_id: string; template: string }>(),
    db.prepare(`SELECT lead_id, COUNT(*) AS n FROM emails WHERE lead_id IN (${inList}) AND status IN ('sent', 'simulated', 'pending', 'sending') AND COALESCE(sent_at, send_at) > ? AND COALESCE(sent_at, send_at) < ? GROUP BY 1`).bind(...ids, now - 86_400_000, now + 3 * 3_600_000).all<{ lead_id: string; n: number }>(),
  ]);

  const aggBy = new Map(agg.results.map((a) => [a.lead_id, a]));
  const firedBy = new Map<string, Set<string>>();
  for (const f of fired.results) (firedBy.get(f.lead_id) ?? firedBy.set(f.lead_id, new Set()).get(f.lead_id)!).add(f.template);
  const recentBy = new Map(recent.results.map((r) => [r.lead_id, r.n]));
  let queued = 0;

  for (const lead of leads.results) {
    const a = aggBy.get(lead.id);
    const mine = texts.results.filter((t) => t.lead_id === lead.id);
    const funding = mine.some((t) => {
      const p = (() => { try { return JSON.parse(t.props ?? '{}'); } catch { return {}; } })();
      if (t.name === 'vsl_rewatch' || t.name === 'vsl_pause') return false; // chapter-based; only counted when chapters match the cut (see profile)
      return FUNDING.test(String(p.q ?? p.text ?? ''));
    });
    const v = (id: string) => vsl.results.find((x) => x.lead_id === lead.id && x.video_id === id);
    const starts = sess.results.filter((x) => x.lead_id === lead.id).map((x) => x.started_at);
    const s: Signals = {
      lead,
      sessions: starts.length,
      sessionsAfterApply: lead.app_completed_at ? starts.filter((t) => t > lead.app_completed_at! + 30 * 60_000).length : 0,
      mainVslPct: v(VIDEOS.main.id)?.pct ?? 0,
      breakoutPct: v(VIDEOS.breakout.id)?.pct ?? 0,
      precallViews: (v(VIDEOS.precall.id)?.views ?? 0) + (lead.booked_at ? vsl.results.filter((x) => x.lead_id === lead.id && x.video_id === VIDEOS.breakout.id).length : 0),
      pickedDate: (a?.picked ?? 0) > 0,
      bookViews24h: a?.book_views ?? 0,
      emailClicks24h: a?.email_clicks ?? 0,
      guaranteeSeconds: a?.g_seconds ?? 0,
      guaranteeRevisit: (a?.g_revisit ?? 0) > 0,
      fundingInterest: funding,
      lastActivity: a?.last_ts ?? lead.updated_at,
    };
    let budget = DAILY_CAP - (recentBy.get(lead.id) ?? 0);
    const done = firedBy.get(lead.id) ?? new Set();
    for (const rule of RULES) {
      if (budget <= 0) break;
      if (done.has(rule.template) || !rule.when(s, now)) continue;
      const step = BEHAVIOUR_TEMPLATES.findIndex((t) => t.template === rule.template);
      const res = await db.prepare(
        `INSERT INTO emails (id, lead_id, sequence, step, template, to_email, send_at, status, created_at) VALUES (?, ?, 'behaviour', ?, ?, ?, ?, 'pending', ?)
         ON CONFLICT(lead_id, sequence, step) DO NOTHING`,
      ).bind(newId('m'), lead.id, step, rule.template, lead.email, now + rule.delay * 60_000, now).run();
      if (res.meta.changes) { queued++; budget--; done.add(rule.template); break; } // one trigger per person per run, so they don't stack
    }
  }
  return { checked: leads.results.length, queued };
}
