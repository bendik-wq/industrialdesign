import type { Runtime } from '../app';
import { feeDue } from '../sales/contracts';
import { toMinor } from '../webinar/pass';
import { chapters } from '../webinar/room';
import { webinarSettings } from '../webinar/webinar';
import { editionName } from '../webinar/editions';
import { type ConvKind, type Funnel, captureConversion } from './capture';

/**
 * Stage events per person per funnel. Most stages are already recorded server-side by the funnels themselves
 * (registrations, payments, room joins, per-minute watch strings, polls, questions, offer unlocks, homework,
 * refunds); syncStages copies them into attr_stages with one de-duplicated row per person per stage, so
 * every report reads one table. The live rooms' minutes come from their own presence polls (recordMinute).
 */

export interface StageDef { id: string; label: string; funnels: Funnel[]; money?: boolean; contract?: boolean }

/** The stage ids the Funnel map contract names, in funnel order, plus the extra stages this tab shows. */
export const STAGES: StageDef[] = [
  { id: 'visit', label: 'Visited the registration page', funnels: ['auto', 'live', 'challenge'], contract: true },
  { id: 'registered', label: 'Registered', funnels: ['auto', 'live', 'challenge'], contract: true },
  { id: 'ticket_paid', label: 'Paid the ticket', funnels: ['auto', 'live', 'challenge'], money: true, contract: true },
  { id: 'vip_paid', label: 'Paid the VIP upgrade', funnels: ['challenge'], money: true, contract: true },
  { id: 'attended', label: 'Attended (live or room)', funnels: ['auto', 'live', 'challenge'], contract: true },
  { id: 'watched_25', label: 'Watched 25%', funnels: ['auto', 'live'], contract: true },
  { id: 'watched_50', label: 'Watched 50%', funnels: ['auto', 'live'], contract: true },
  { id: 'watched_75', label: 'Watched 75%', funnels: ['auto', 'live'] },
  { id: 'watched_100', label: 'Watched to the end', funnels: ['auto', 'live'] },
  { id: 'homework_day1', label: 'Homework Day 1', funnels: ['challenge'], contract: true },
  { id: 'homework_day2', label: 'Homework Day 2', funnels: ['challenge'], contract: true },
  { id: 'homework_day3', label: 'Homework Day 3', funnels: ['challenge'], contract: true },
  { id: 'homework_day4', label: 'Homework Day 4', funnels: ['challenge'], contract: true },
  { id: 'homework_day5', label: 'Homework Day 5', funnels: ['challenge'], contract: true },
  { id: 'offer_seen', label: 'Saw the offer', funnels: ['auto', 'live', 'challenge'], contract: true },
  { id: 'offer_clicked', label: 'Clicked the offer', funnels: ['auto', 'live'] },
  { id: 'checkout_started', label: 'Started checkout', funnels: ['auto', 'live', 'challenge'], contract: true },
  { id: 'checkout_abandoned', label: 'Left checkout unpaid', funnels: ['auto', 'live', 'challenge'] },
  { id: 'sprint_paid', label: 'Bought the First Deal Sprint', funnels: ['auto'], money: true, contract: true },
  { id: 'deposit_paid', label: 'Paid the engagement deposit', funnels: ['live', 'challenge'], money: true, contract: true },
  { id: 'engagement_signed', label: 'Signed the engagement', funnels: ['auto', 'live', 'challenge'], money: true, contract: true },
  { id: 'replay_watched', label: 'Watched the replay', funnels: ['auto', 'live', 'challenge'] },
  { id: 'refund', label: 'Refunded', funnels: ['auto', 'live', 'challenge'], money: true },
];
/** Stages that hold several rows per person (one per chapter, poll, question, day). */
export const DETAIL_STAGES = ['chapter', 'poll', 'question', 'attended_day', 'zoom_joined', 'ticket_checkout_started'];

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const ABANDON_AFTER = HOUR;

/** One stage row (idempotent on funnel + registration + stage + detail key). */
export async function recordStage(rt: Pick<Runtime, 'env'>, s: { funnel: Funnel; stage: string; leadId: string; regId: string; ts: number; value?: number | null; detail?: string | null; key?: string | null; cohortRef?: string | null; edition?: string | null; source?: string }) {
  const id = `${s.funnel}:${s.regId}:${s.stage}${s.key ? `:${s.key}` : ''}`.slice(0, 200);
  const r = await rt.env.DB.prepare(
    `INSERT OR IGNORE INTO attr_stages (id, funnel, stage, lead_id, reg_id, cohort_ref, edition, ts, value, detail, source)
     VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, (SELECT edition FROM attr_conversions WHERE kind = 'registered' AND ref_id = ?)), ?, ?, ?, ?)`,
  ).bind(id, s.funnel, s.stage, s.leadId, s.regId, s.cohortRef ?? null, s.edition ?? null, s.regId, s.ts, s.value ?? null, s.detail ?? null, s.source ?? 'server').run();
  return (r.meta.changes ?? 0) > 0;
}

/** A minute on screen in a live room (from the room's presence poll; repeated polls in the same minute are one row). */
export async function recordMinute(rt: Pick<Runtime, 'env'>, o: { funnel: 'live' | 'challenge'; eventRef: string; regId: string; leadId: string; startsAt: number; now?: number; source?: 'room' | 'zoom' }) {
  const now = o.now ?? Date.now();
  const minute = Math.floor((now - o.startsAt) / MIN);
  if (minute < 0 || minute > 600) return false;
  const r = await rt.env.DB.prepare('INSERT OR IGNORE INTO attr_watch (funnel, event_ref, reg_id, lead_id, minute, source) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(o.funnel, o.eventRef, o.regId, o.leadId, minute, o.source ?? 'room').run();
  return (r.meta.changes ?? 0) > 0;
}

const ED = (alias: string) => `(SELECT edition FROM attr_conversions c WHERE c.kind = 'registered' AND c.ref_id = ${alias})`;
const ins = (cols = 'id, funnel, stage, lead_id, reg_id, cohort_ref, edition, ts, value, detail, source') => `INSERT OR IGNORE INTO attr_stages (${cols}) `;

/** The SQL that copies each server-recorded stage into attr_stages (all idempotent). since = earliest registration to scan. */
function stageSql(now: number): { sql: string; binds: unknown[] }[] {
  const q = (sql: string, ...binds: unknown[]) => ({ sql, binds });
  return [
    // ── automated webinar ──
    q(`${ins()} SELECT 'auto:'||r.id||':registered', 'auto', 'registered', r.lead_id, r.id, r.session_id, ${ED('r.id')}, r.created_at, NULL, NULL, 'sync' FROM webinar_registrations r WHERE r.created_at >= ?1`),
    q(`${ins()} SELECT 'auto:'||r.id||':offer_seen', 'auto', 'offer_seen', r.lead_id, r.id, r.session_id, ${ED('r.id')}, r.offer_unlocked_at, NULL, NULL, 'sync' FROM webinar_registrations r WHERE r.created_at >= ?1 AND r.offer_unlocked_at IS NOT NULL`),
    q(`${ins()} SELECT 'auto:'||r.id||':offer_clicked', 'auto', 'offer_clicked', r.lead_id, r.id, r.session_id, ${ED('r.id')},
         COALESCE(r.cta_at, (SELECT MIN(i.created_at) FROM webinar_interactions i WHERE i.reg_id = r.id AND i.kind = 'offer')), NULL, NULL, 'sync'
         FROM webinar_registrations r WHERE r.created_at >= ?1 AND (r.cta_at IS NOT NULL OR EXISTS (SELECT 1 FROM webinar_interactions i WHERE i.reg_id = r.id AND i.kind = 'offer'))`),
    q(`${ins()} SELECT 'auto:'||i.reg_id||':poll:'||i.key, 'auto', 'poll', i.lead_id, i.reg_id, i.session_id, ${ED('i.reg_id')}, i.created_at, i.at_sec, i.key||'='||COALESCE(i.value, ''), 'sync'
         FROM webinar_interactions i JOIN webinar_registrations r ON r.id = i.reg_id WHERE i.kind = 'poll' AND r.created_at >= ?1`),
    q(`${ins()} SELECT 'auto:'||i.reg_id||':question:'||i.id, 'auto', 'question', i.lead_id, i.reg_id, i.session_id, ${ED('i.reg_id')}, i.created_at, i.at_sec, NULL, 'sync'
         FROM webinar_interactions i JOIN webinar_registrations r ON r.id = i.reg_id WHERE i.kind = 'question' AND r.created_at >= ?1`),
    // Passes (ticket = seat, Sprint = offer) on an auto-webinar registration.
    q(`${ins()} SELECT 'auto:'||p.reg_id||':ticket_paid', 'auto', 'ticket_paid', p.lead_id, p.reg_id, r.session_id, ${ED('p.reg_id')}, MIN(p.paid_at), MAX(p.amount), p.currency, 'sync'
         FROM webinar_passes p JOIN webinar_registrations r ON r.id = p.reg_id WHERE p.kind = 'seat' AND p.paid_at IS NOT NULL AND r.created_at >= ?1 GROUP BY p.reg_id`),
    q(`${ins()} SELECT 'auto:'||p.reg_id||':sprint_paid', 'auto', 'sprint_paid', p.lead_id, p.reg_id, r.session_id, ${ED('p.reg_id')}, MIN(p.paid_at), MAX(p.amount), p.currency, 'sync'
         FROM webinar_passes p JOIN webinar_registrations r ON r.id = p.reg_id WHERE p.kind = 'offer' AND p.paid_at IS NOT NULL AND r.created_at >= ?1 GROUP BY p.reg_id`),
    q(`${ins()} SELECT 'auto:'||p.reg_id||':checkout_started', 'auto', 'checkout_started', p.lead_id, p.reg_id, r.session_id, ${ED('p.reg_id')}, MIN(p.created_at), NULL, NULL, 'sync'
         FROM webinar_passes p JOIN webinar_registrations r ON r.id = p.reg_id WHERE p.kind = 'offer' AND r.created_at >= ?1 GROUP BY p.reg_id`),
    q(`${ins()} SELECT 'auto:'||p.reg_id||':ticket_checkout_started', 'auto', 'ticket_checkout_started', p.lead_id, p.reg_id, r.session_id, ${ED('p.reg_id')}, MIN(p.created_at), NULL, NULL, 'sync'
         FROM webinar_passes p JOIN webinar_registrations r ON r.id = p.reg_id WHERE p.kind = 'seat' AND r.created_at >= ?1 GROUP BY p.reg_id`),
    q(`${ins()} SELECT 'auto:'||p.reg_id||':checkout_abandoned', 'auto', 'checkout_abandoned', p.lead_id, p.reg_id, r.session_id, ${ED('p.reg_id')}, MAX(p.created_at), NULL, 'sprint', 'sync'
         FROM webinar_passes p JOIN webinar_registrations r ON r.id = p.reg_id WHERE p.kind = 'offer' AND r.created_at >= ?1 GROUP BY p.reg_id
         HAVING SUM(p.paid_at IS NOT NULL) = 0 AND MAX(p.created_at) < ?2`, now - ABANDON_AFTER),
    // ── live webinar ──
    q(`${ins()} SELECT 'live:'||r.id||':registered', 'live', 'registered', r.lead_id, r.id, r.event_id, NULL, r.created_at, NULL, NULL, 'sync' FROM live_webinar_regs r WHERE r.created_at >= ?1`),
    q(`${ins()} SELECT 'live:'||r.id||':attended', 'live', 'attended', r.lead_id, r.id, r.event_id, NULL, COALESCE(r.joined_at, r.zoom_clicked_at), NULL, CASE WHEN r.joined_at IS NULL THEN 'zoom' ELSE 'room' END, 'sync'
         FROM live_webinar_regs r WHERE r.created_at >= ?1 AND (r.joined_at IS NOT NULL OR r.zoom_clicked_at IS NOT NULL)`),
    q(`${ins()} SELECT 'live:'||r.id||':zoom_joined', 'live', 'zoom_joined', r.lead_id, r.id, r.event_id, NULL, r.zoom_clicked_at, NULL, NULL, 'sync' FROM live_webinar_regs r WHERE r.created_at >= ?1 AND r.zoom_clicked_at IS NOT NULL`),
    q(`${ins()} SELECT 'live:'||r.id||':replay_watched', 'live', 'replay_watched', r.lead_id, r.id, r.event_id, NULL, r.replay_at, NULL, NULL, 'sync' FROM live_webinar_regs r WHERE r.created_at >= ?1 AND r.replay_at IS NOT NULL`),
    q(`${ins()} SELECT 'live:'||r.id||':offer_seen', 'live', 'offer_seen', r.lead_id, r.id, r.event_id, NULL, r.offer_seen_at, NULL, NULL, 'sync' FROM live_webinar_regs r WHERE r.created_at >= ?1 AND r.offer_seen_at IS NOT NULL`),
    q(`${ins()} SELECT 'live:'||r.id||':offer_clicked', 'live', 'offer_clicked', r.lead_id, r.id, r.event_id, NULL, r.offer_clicked_at, NULL, NULL, 'sync' FROM live_webinar_regs r WHERE r.created_at >= ?1 AND r.offer_clicked_at IS NOT NULL`),
    q(`${ins()} SELECT 'live:'||v.reg_id||':poll:'||v.poll_id, 'live', 'poll', r.lead_id, v.reg_id, r.event_id, NULL, v.created_at, v.choice, COALESCE(p.preset, 'poll')||'='||CASE WHEN v.choice < 0 THEN 'sentence' ELSE COALESCE(json_extract(p.options, '$['||v.choice||']'), v.choice) END, 'sync'
         FROM live_webinar_poll_votes v JOIN live_webinar_polls p ON p.id = v.poll_id JOIN live_webinar_regs r ON r.id = v.reg_id WHERE r.created_at >= ?1`),
    q(`${ins()} SELECT 'live:'||r.id||':ticket_paid', 'live', 'ticket_paid', r.lead_id, r.id, r.event_id, NULL, MIN(p.paid_at), MAX(p.amount), p.currency, 'sync'
         FROM webinar_passes p JOIN live_webinar_regs r ON r.id = p.reg_id WHERE p.kind = 'live_ticket' AND p.paid_at IS NOT NULL AND r.created_at >= ?1 GROUP BY r.id`),
    // Deposits from the live room: the pass carries source 'live', the event id and the buyer.
    q(`${ins()} SELECT 'live:'||r.id||':checkout_started', 'live', 'checkout_started', r.lead_id, r.id, r.event_id, NULL, MIN(p.created_at), NULL, NULL, 'sync'
         FROM webinar_passes p JOIN live_webinar_regs r ON r.event_id = p.ref_id AND r.lead_id = p.lead_id WHERE p.kind = 'deposit' AND p.source = 'live' AND r.created_at >= ?1 GROUP BY r.id`),
    q(`${ins()} SELECT 'live:'||r.id||':deposit_paid', 'live', 'deposit_paid', r.lead_id, r.id, r.event_id, NULL, MIN(p.paid_at), MAX(p.amount), p.currency, 'sync'
         FROM webinar_passes p JOIN live_webinar_regs r ON r.event_id = p.ref_id AND r.lead_id = p.lead_id WHERE p.kind = 'deposit' AND p.source = 'live' AND p.paid_at IS NOT NULL AND r.created_at >= ?1 GROUP BY r.id`),
    q(`${ins()} SELECT 'live:'||r.id||':checkout_abandoned', 'live', 'checkout_abandoned', r.lead_id, r.id, r.event_id, NULL, MAX(p.created_at), NULL, 'deposit', 'sync'
         FROM webinar_passes p JOIN live_webinar_regs r ON r.event_id = p.ref_id AND r.lead_id = p.lead_id WHERE p.kind = 'deposit' AND p.source = 'live' AND r.created_at >= ?1 GROUP BY r.id
         HAVING SUM(p.paid_at IS NOT NULL) = 0 AND MAX(p.created_at) < ?2`, now - ABANDON_AFTER),
    // ── 5-day challenge ──
    q(`${ins()} SELECT 'challenge:'||r.id||':registered', 'challenge', 'registered', r.lead_id, r.id, r.cohort_id, NULL, r.created_at, NULL, NULL, 'sync' FROM challenge_registrations r WHERE r.created_at >= ?1`),
    q(`${ins()} SELECT 'challenge:'||o.reg_id||':'||o.kind||'_paid', 'challenge', o.kind||'_paid', o.lead_id, o.reg_id, r.cohort_id, NULL, MIN(o.paid_at), MAX(o.amount), o.currency, 'sync'
         FROM challenge_orders o JOIN challenge_registrations r ON r.id = o.reg_id WHERE o.paid_at IS NOT NULL AND o.kind IN ('ticket', 'vip') AND r.created_at >= ?1 GROUP BY o.reg_id, o.kind`),
    q(`${ins()} SELECT 'challenge:'||o.reg_id||':ticket_checkout_started', 'challenge', 'ticket_checkout_started', o.lead_id, o.reg_id, r.cohort_id, NULL, MIN(o.created_at), NULL, NULL, 'sync'
         FROM challenge_orders o JOIN challenge_registrations r ON r.id = o.reg_id WHERE o.kind = 'ticket' AND r.created_at >= ?1 GROUP BY o.reg_id`),
    q(`${ins()} SELECT 'challenge:'||p.reg_id||':attended', 'challenge', 'attended', r.lead_id, p.reg_id, r.cohort_id, NULL, MIN(COALESCE(p.joined_at, p.present_at)), COUNT(*), NULL, 'sync'
         FROM challenge_progress p JOIN challenge_registrations r ON r.id = p.reg_id WHERE (p.joined_at IS NOT NULL OR p.present_at IS NOT NULL) AND r.created_at >= ?1 GROUP BY p.reg_id`),
    q(`${ins()} SELECT 'challenge:'||p.reg_id||':attended_day:'||p.day, 'challenge', 'attended_day', r.lead_id, p.reg_id, r.cohort_id, NULL, COALESCE(p.joined_at, p.present_at), p.day, 'day '||p.day, 'sync'
         FROM challenge_progress p JOIN challenge_registrations r ON r.id = p.reg_id WHERE (p.joined_at IS NOT NULL OR p.present_at IS NOT NULL) AND r.created_at >= ?1`),
    q(`${ins()} SELECT 'challenge:'||p.reg_id||':replay_watched', 'challenge', 'replay_watched', r.lead_id, p.reg_id, r.cohort_id, NULL, MIN(p.replay_at), COUNT(*), NULL, 'sync'
         FROM challenge_progress p JOIN challenge_registrations r ON r.id = p.reg_id WHERE p.replay_at IS NOT NULL AND r.created_at >= ?1 GROUP BY p.reg_id`),
    q(`${ins()} SELECT 'challenge:'||h.reg_id||':homework_day'||h.day, 'challenge', 'homework_day'||h.day, r.lead_id, h.reg_id, r.cohort_id, NULL, h.created_at, h.day, NULL, 'sync'
         FROM challenge_homework h JOIN challenge_registrations r ON r.id = h.reg_id WHERE r.created_at >= ?1`),
    q(`${ins()} SELECT 'challenge:'||p.reg_id||':poll:'||p.day||':'||p.poll, 'challenge', 'poll', r.lead_id, p.reg_id, r.cohort_id, NULL, p.created_at, p.day, p.poll||'='||p.value, 'sync'
         FROM challenge_polls p JOIN challenge_registrations r ON r.id = p.reg_id WHERE r.created_at >= ?1`),
    q(`${ins()} SELECT 'challenge:'||h.reg_id||':question:'||h.id, 'challenge', 'question', r.lead_id, h.reg_id, r.cohort_id, NULL, h.created_at, h.day, NULL, 'sync'
         FROM challenge_hot_seats h JOIN challenge_registrations r ON r.id = h.reg_id WHERE r.created_at >= ?1`),
    q(`${ins()} SELECT 'challenge:'||d.reg_id||':checkout_started', 'challenge', 'checkout_started', d.lead_id, d.reg_id, d.cohort_id, NULL, d.started_at, NULL, NULL, 'sync'
         FROM challenge_deposits d JOIN challenge_registrations r ON r.id = d.reg_id WHERE r.created_at >= ?1`),
    q(`${ins()} SELECT 'challenge:'||r.id||':deposit_paid', 'challenge', 'deposit_paid', r.lead_id, r.id, r.cohort_id, NULL, MIN(p.paid_at), MAX(p.amount), p.currency, 'sync'
         FROM webinar_passes p JOIN challenge_registrations r ON r.id = p.ref_id WHERE p.kind = 'deposit' AND p.source = 'challenge' AND p.paid_at IS NOT NULL AND r.created_at >= ?1 GROUP BY r.id`),
    q(`${ins()} SELECT 'challenge:'||d.reg_id||':checkout_abandoned', 'challenge', 'checkout_abandoned', d.lead_id, d.reg_id, d.cohort_id, NULL, d.started_at, NULL, 'deposit', 'sync'
         FROM challenge_deposits d JOIN challenge_registrations r ON r.id = d.reg_id WHERE r.created_at >= ?1 AND d.paid_at IS NULL AND d.started_at < ?2
           AND NOT EXISTS (SELECT 1 FROM webinar_passes p WHERE p.kind = 'deposit' AND p.source = 'challenge' AND p.ref_id = d.reg_id AND p.paid_at IS NOT NULL)`, now - ABANDON_AFTER),
  ];
}

type AutoRow = { id: string; lead_id: string; session_id: string; created_at: number; joined_at: number | null; replay_at: number | null; last_seen_at: number | null; max_position: number; live_minutes: string | null; replay_minutes: string | null; starts_at: number };
const ones = (s: string | null) => (s ? [...s].filter((c) => c === '1').length : 0);
const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/** Watch-based stages for the auto webinar (attended, watched %, chapters, replay), from its per-minute strings. */
async function autoWatchStages(rt: Runtime, since: number) {
  const db = rt.env.DB;
  const w = webinarSettings(rt);
  const len = Math.max(1, Math.round(w.durationMin));
  const ch = chapters(rt);
  const rows = await db.prepare(
    `SELECT r.id, r.lead_id, r.session_id, r.created_at, r.joined_at, r.replay_at, r.last_seen_at, r.max_position, r.live_minutes, r.replay_minutes, s.starts_at
       FROM webinar_registrations r JOIN webinar_sessions s ON s.id = r.session_id
      WHERE r.created_at >= ? AND (r.joined_at IS NOT NULL OR r.replay_at IS NOT NULL) LIMIT 5000`,
  ).bind(since).all<AutoRow>();
  const stmts: D1PreparedStatement[] = [];
  const put = (r: AutoRow, stage: string, ts: number, value: number | null, detail: string | null, key?: string) => stmts.push(db.prepare(
    `${ins()} VALUES (?, 'auto', ?, ?, ?, ?, ${ED('?')}, ?, ?, ?, 'sync')`,
  ).bind(`auto:${r.id}:${stage}${key ? `:${key}` : ''}`, stage, r.lead_id, r.id, r.session_id, r.id, ts, value, detail));
  // Updatable values (minutes keep growing while they watch): refreshed after the insert.
  const upd: { id: string; value: number }[] = [];
  for (const r of rows.results) {
    const seen = r.last_seen_at ?? r.joined_at ?? r.replay_at ?? r.created_at;
    if (r.joined_at) { put(r, 'attended', r.joined_at, ones(r.live_minutes), 'room'); upd.push({ id: `auto:${r.id}:attended`, value: ones(r.live_minutes) }); }
    if (r.replay_at) { put(r, 'replay_watched', r.replay_at, ones(r.replay_minutes), null); upd.push({ id: `auto:${r.id}:replay_watched`, value: ones(r.replay_minutes) }); }
    const reached = (r.max_position || 0) / (len * 60);
    for (const p of [25, 50, 75, 100]) if (reached >= (p === 100 ? 0.97 : p / 100)) put(r, `watched_${p}`, seen, p, null);
    for (const c of ch) if ((r.max_position || 0) >= c.at * 60) put(r, 'chapter', seen, c.at, c.title, `${c.at}-${slugOf(c.title)}`);
  }
  for (let i = 0; i < stmts.length; i += 200) await db.batch(stmts.slice(i, i + 200));
  const u = upd.map((x) => db.prepare('UPDATE attr_stages SET value = ? WHERE id = ? AND (value IS NULL OR value < ?)').bind(x.value, x.id, x.value));
  for (let i = 0; i < u.length; i += 200) await db.batch(u.slice(i, i + 200));
  return stmts.length;
}

/** Live-room watch % per person, from the minutes their room recorded (attr_watch) against the event length. */
async function liveWatchStages(rt: Runtime, since: number) {
  const db = rt.env.DB;
  const rows = await db.prepare(
    `SELECT r.id, r.lead_id, r.event_id, e.duration_min, COUNT(w.minute) AS mins, MAX(w.minute) AS last_min, e.starts_at
       FROM live_webinar_regs r JOIN live_webinars e ON e.id = r.event_id JOIN attr_watch w ON w.funnel = 'live' AND w.event_ref = r.event_id AND w.reg_id = r.id
      WHERE r.created_at >= ? GROUP BY r.id`,
  ).bind(since).all<{ id: string; lead_id: string; event_id: string; duration_min: number; mins: number; last_min: number; starts_at: number }>();
  const stmts: D1PreparedStatement[] = [];
  for (const r of rows.results) {
    const share = r.mins / Math.max(1, r.duration_min);
    const ts = r.starts_at + (r.last_min + 1) * MIN;
    stmts.push(db.prepare('UPDATE attr_stages SET value = ? WHERE id = ?').bind(r.mins, `live:${r.id}:attended`));
    for (const p of [25, 50, 75, 100]) if (share >= (p === 100 ? 0.97 : p / 100)) {
      stmts.push(db.prepare(`${ins()} VALUES (?, 'live', ?, ?, ?, ?, NULL, ?, ?, NULL, 'sync')`).bind(`live:${r.id}:watched_${p}`, `watched_${p}`, r.lead_id, r.id, r.event_id, ts, p));
    }
  }
  for (let i = 0; i < stmts.length; i += 200) await db.batch(stmts.slice(i, i + 200));
}

/** Refunds (from the purchase rows) as stage rows, and refunded amounts onto the conversions. */
async function refunds(rt: Runtime) {
  const db = rt.env.DB;
  await db.batch([
    db.prepare(`${ins()} SELECT CASE WHEN p.source = 'live' THEN 'live' WHEN p.source = 'challenge' THEN 'challenge' ELSE 'auto' END||':'||p.reg_id||':refund:'||p.id,
         CASE WHEN p.source = 'live' THEN 'live' WHEN p.source = 'challenge' THEN 'challenge' ELSE 'auto' END, 'refund', p.lead_id, p.reg_id, p.ref_id, NULL,
         COALESCE(p.refunded_at, p.updated_at), p.refunded_amount, p.kind, 'sync'
         FROM webinar_passes p WHERE p.refunded_amount > 0`),
    db.prepare(`${ins()} SELECT 'challenge:'||o.reg_id||':refund:'||o.id, 'challenge', 'refund', o.lead_id, o.reg_id, NULL, NULL, o.updated_at, o.refunded_amount, o.kind, 'sync'
         FROM challenge_orders o WHERE o.refunded_amount > 0`),
    db.prepare(`UPDATE attr_stages SET value = (SELECT p.refunded_amount FROM webinar_passes p WHERE attr_stages.id LIKE '%:refund:'||p.id) WHERE stage = 'refund' AND EXISTS (SELECT 1 FROM webinar_passes p WHERE attr_stages.id LIKE '%:refund:'||p.id)`),
    db.prepare(`UPDATE attr_conversions SET refunded = (SELECT p.refunded_amount FROM webinar_passes p WHERE p.id = attr_conversions.ref_id), updated_at = ?1
         WHERE kind IN ('ticket_paid', 'sprint_paid', 'deposit_paid') AND EXISTS (SELECT 1 FROM webinar_passes p WHERE p.id = attr_conversions.ref_id AND p.refunded_amount != attr_conversions.refunded)`).bind(Date.now()),
    db.prepare(`UPDATE attr_conversions SET refunded = (SELECT o.refunded_amount FROM challenge_orders o WHERE o.id = attr_conversions.ref_id), updated_at = ?1
         WHERE kind IN ('ticket_paid', 'vip_paid') AND EXISTS (SELECT 1 FROM challenge_orders o WHERE o.id = attr_conversions.ref_id AND o.refunded_amount != attr_conversions.refunded)`).bind(Date.now()),
  ]);
}

/** The funnel registration a purchase or signed engagement belongs to: the latest registration before it. */
export async function latestReg(rt: Pick<Runtime, 'env'>, leadId: string, before: number): Promise<{ funnel: Funnel; id: string; cohort: string; at: number } | null> {
  const r = await rt.env.DB.prepare(
    `SELECT 'auto' AS funnel, id, session_id AS cohort, created_at AS at FROM webinar_registrations WHERE lead_id = ?1 AND created_at <= ?2
     UNION ALL SELECT 'live', id, event_id, created_at FROM live_webinar_regs WHERE lead_id = ?1 AND created_at <= ?2
     UNION ALL SELECT 'challenge', id, cohort_id, created_at FROM challenge_registrations WHERE lead_id = ?1 AND created_at <= ?2
     ORDER BY at DESC LIMIT 1`,
  ).bind(leadId, before).first<{ funnel: Funnel; id: string; cohort: string; at: number }>();
  return r ?? null;
}

/** Purchases and registrations that have no conversion row yet (paid on the saved card, before this existed…). */
async function backfillConversions(rt: Runtime, since: number, limit = 150) {
  const db = rt.env.DB;
  type Cand = { kind: ConvKind; funnel: Funnel; ref_id: string; reg_id: string | null; lead_id: string; at: number; amount: number; refunded: number; currency: string | null; cohort: string | null };
  const cands = await db.prepare(
    `SELECT * FROM (
       SELECT 'registered' AS kind, 'auto' AS funnel, r.id AS ref_id, r.id AS reg_id, r.lead_id, r.created_at AS at, 0 AS amount, 0 AS refunded, NULL AS currency, r.session_id AS cohort FROM webinar_registrations r WHERE r.created_at >= ?1
       UNION ALL SELECT 'registered', 'live', r.id, r.id, r.lead_id, r.created_at, 0, 0, NULL, r.event_id FROM live_webinar_regs r WHERE r.created_at >= ?1
       UNION ALL SELECT 'registered', 'challenge', r.id, r.id, r.lead_id, r.created_at, 0, 0, NULL, r.cohort_id FROM challenge_registrations r WHERE r.created_at >= ?1
       UNION ALL SELECT CASE p.kind WHEN 'seat' THEN 'ticket_paid' WHEN 'live_ticket' THEN 'ticket_paid' WHEN 'deposit' THEN 'deposit_paid' ELSE 'sprint_paid' END,
              CASE WHEN p.kind = 'live_ticket' OR p.source = 'live' THEN 'live' WHEN p.source = 'challenge' THEN 'challenge' ELSE 'auto' END,
              p.id, p.reg_id, p.lead_id, p.paid_at, p.amount, p.refunded_amount, p.currency, p.ref_id
         FROM webinar_passes p WHERE p.paid_at IS NOT NULL AND p.paid_at >= ?1 AND p.kind IN ('seat', 'offer', 'deposit', 'live_ticket')
       UNION ALL SELECT CASE o.kind WHEN 'vip' THEN 'vip_paid' ELSE 'ticket_paid' END, 'challenge', o.id, o.reg_id, o.lead_id, o.paid_at, o.amount, o.refunded_amount, o.currency, r.cohort_id
         FROM challenge_orders o JOIN challenge_registrations r ON r.id = o.reg_id WHERE o.paid_at IS NOT NULL AND o.paid_at >= ?1
     ) x WHERE NOT EXISTS (SELECT 1 FROM attr_conversions c WHERE c.kind = x.kind AND c.ref_id = x.ref_id)
     ORDER BY at LIMIT ?2`,
  ).bind(since, limit).all<Cand>();
  let n = 0;
  for (const c of cands.results) {
    let regId = c.reg_id, cohort = c.cohort;
    // Deposits: the registration is the live reg for that event, or the challenge reg (ref_id).
    if (c.kind === 'deposit_paid' && c.funnel === 'live') {
      const r = await db.prepare('SELECT id FROM live_webinar_regs WHERE event_id = ? AND lead_id = ?').bind(c.cohort, c.lead_id).first<{ id: string }>();
      regId = r?.id ?? regId;
    } else if (c.kind === 'deposit_paid' && c.funnel === 'challenge') {
      const r = await db.prepare('SELECT id, cohort_id FROM challenge_registrations WHERE id = ?').bind(c.cohort).first<{ id: string; cohort_id: string }>();
      regId = r?.id ?? regId; cohort = r?.cohort_id ?? cohort;
    } else if (c.kind === 'ticket_paid' && c.funnel === 'auto') {
      const r = await db.prepare('SELECT session_id FROM webinar_registrations WHERE id = ?').bind(c.reg_id).first<{ session_id: string }>();
      cohort = r?.session_id ?? null;
    } else if (c.kind === 'sprint_paid') {
      const r = await db.prepare('SELECT session_id FROM webinar_registrations WHERE id = ?').bind(c.reg_id).first<{ session_id: string }>();
      cohort = r?.session_id ?? null;
    }
    await captureConversion(rt, { kind: c.kind, funnel: c.funnel, refId: c.ref_id, regId, leadId: c.lead_id, at: c.at, amount: c.amount, refunded: c.refunded, currency: c.currency, cohortRef: cohort, via: 'sync' });
    n++;
  }
  // Signed engagements: credited to the funnel the person last registered in before signing. Revenue counts once paid.
  const signed = await db.prepare(
    `SELECT k.id, k.lead_id, k.signed_at, k.paid_at, k.fee, k.currency, k.credit_amount, k.credit_label FROM contracts k
      WHERE k.status = 'signed' AND COALESCE(k.is_test, 0) = 0 AND k.signed_at >= ?1
        AND NOT EXISTS (SELECT 1 FROM attr_conversions c WHERE c.kind = 'engagement_signed' AND c.ref_id = k.id AND (c.amount > 0 OR k.paid_at IS NULL)) LIMIT 100`,
  ).bind(since).all<{ id: string; lead_id: string; signed_at: number; paid_at: number | null; fee: number; currency: string; credit_amount: number; credit_label: string | null }>();
  for (const k of signed.results) {
    const reg = await latestReg(rt, k.lead_id, k.signed_at);
    if (!reg) continue; // not from a webinar funnel
    const amount = k.paid_at ? toMinor(feeDue(k).net, k.currency) : 0;
    await captureConversion(rt, { kind: 'engagement_signed', funnel: reg.funnel, refId: k.id, regId: reg.id, leadId: k.lead_id, at: k.signed_at, amount, currency: k.currency, cohortRef: reg.cohort, via: 'sync' });
    await recordStage(rt, { funnel: reg.funnel, stage: 'engagement_signed', leadId: k.lead_id, regId: reg.id, ts: k.signed_at, value: amount, cohortRef: reg.cohort, source: 'sync' });
    n++;
  }
  return n;
}

/**
 * Brings attr_stages and attr_conversions up to date from the funnels' own tables. Idempotent; runs from the
 * 5-minute cron (at most every 10 minutes) and before the report loads. full = rescan everything.
 */
export async function syncAttribution(rt: Runtime, o: { full?: boolean; force?: boolean; now?: number } = {}) {
  const db = rt.env.DB;
  const now = o.now ?? Date.now();
  const last = await db.prepare("SELECT value FROM kv_state WHERE key = 'attr:sync'").first<{ value: string }>().catch(() => null);
  if (!o.force && !o.full && last && now - Number(last.value) < 10 * MIN) return { skipped: true };
  await db.prepare("INSERT INTO kv_state (key, value) VALUES ('attr:sync', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(now)).run();
  const done = await db.prepare("SELECT value FROM kv_state WHERE key = 'attr:full'").first<{ value: string }>().catch(() => null);
  const full = o.full || !done;
  const since = full ? 0 : now - 120 * DAY;
  for (const s of stageSql(now)) {
    const binds = [since, ...s.binds];
    await db.prepare(s.sql).bind(...binds).run();
  }
  await autoWatchStages(rt, since);
  await liveWatchStages(rt, since);
  await refunds(rt);
  const conv = await backfillConversions(rt, since, full ? 1000 : 150);
  if (full) await db.prepare("INSERT INTO kv_state (key, value) VALUES ('attr:full', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(now)).run();
  return { skipped: false, conversions: conv, full };
}

export const currentEdition = (rt: Pick<Runtime, 'settings'>) => editionName(rt.settings);
