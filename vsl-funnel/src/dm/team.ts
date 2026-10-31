import type { Runtime } from '../app';
import { emailConfigured, sendViaResend } from '../integrations/email';
import { money, notify, notifyConfigured } from '../integrations/notify';
import { localClock } from '../sales/digest';
import type { Rep } from '../sales/reps';
import { flag } from '../settings';
import { logAction } from '../ops/actions';
import type { DmThread } from './inbox';
import { DAY, HOUR, type ScriptStat, awaitingReply, bestAndWorst, priority, scriptStats, windowLabel, windowState } from './rules';

/**
 * The manager side: the control-center dashboard (yesterday's results, today's tasks, per-setter numbers and
 * setter commission on DM-sourced deals), script analytics, the daily digest per setter and Slack alerts for
 * hot leads left waiting and missed follow-ups. Every number is counted from dm_threads / dm_messages / leads.
 */

/** Start of "today" and "yesterday" in the team's time zone (ms). */
export function dayBounds(now: number, tz: string) {
  let hour = 0, minute = 0;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now));
    hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
    minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  } catch {
    hour = new Date(now).getUTCHours(); minute = new Date(now).getUTCMinutes();
  }
  const startToday = now - hour * HOUR - minute * 60_000 - (now % 60_000);
  return { startToday, startYesterday: startToday - DAY, endToday: startToday + DAY };
}

export interface DayResults { conversations: number; replies: number; booked: number; showed: number; closed: number; revenue: number }

export async function dayResults(rt: Runtime, from: number, to: number, setterId?: string): Promise<DayResults> {
  const who = setterId ? ' AND assignee_id = ?3' : '';
  const args = setterId ? [from, to, setterId] : [from, to];
  const r = await rt.env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM dm_threads WHERE created_at >= ?1 AND created_at < ?2${who}) AS conversations,
            (SELECT COUNT(*) FROM dm_messages m WHERE m.direction = 'out' AND m.status = 'sent' AND m.ts >= ?1 AND m.ts < ?2 ${setterId ? 'AND m.sent_by = ?3' : "AND m.sent_by NOT IN ('trigger', 'assistant')"}) AS replies,
            (SELECT COUNT(*) FROM dm_threads WHERE booked_at >= ?1 AND booked_at < ?2${who}) AS booked,
            (SELECT COUNT(*) FROM dm_threads WHERE showed_at >= ?1 AND showed_at < ?2${who}) AS showed,
            (SELECT COUNT(*) FROM dm_threads WHERE closed_at >= ?1 AND closed_at < ?2${who}) AS closed,
            (SELECT COALESCE(SUM(t.deal_value), 0) FROM dm_threads t WHERE t.closed_at >= ?1 AND t.closed_at < ?2${who.replace('assignee_id', 't.assignee_id')}) AS revenue`,
  ).bind(...args).first<DayResults>();
  return r ?? { conversations: 0, replies: 0, booked: 0, showed: 0, closed: 0, revenue: 0 };
}

export interface Task { thread_id: string; who: string; kind: 'hot_waiting' | 'follow_up' | 'window_closing'; detail: string; assignee_id: string | null }

const who = (t: Pick<DmThread, 'name' | 'username'>) => t.name || (t.username ? `@${t.username}` : 'Instagram lead');

/** Today's tasks: unanswered hot leads, follow-ups due today, and conversations whose window closes within 3 hours. */
export function tasksFrom(threads: DmThread[], now: number, endToday: number): Task[] {
  const out: Task[] = [];
  for (const t of threads) {
    if (t.ai_flag === 'junk' || t.status === 'closed' || t.status === 'lost') continue;
    const waiting = awaitingReply(t);
    const w = windowState(t, now);
    if (waiting && t.band === 'hot') out.push({ thread_id: t.id, who: who(t), kind: 'hot_waiting', detail: `Hot, waiting ${Math.max(1, Math.round((now - (t.last_in_at ?? now)) / 60_000))} min · ${windowLabel(w)}`, assignee_id: t.assignee_id });
    else if (waiting && w.mode === 'standard' && w.msLeft < 3 * HOUR) out.push({ thread_id: t.id, who: who(t), kind: 'window_closing', detail: `Window closes in ${windowLabel(w).replace(' left', '')}`, assignee_id: t.assignee_id });
    if (t.follow_up_at && t.follow_up_at < endToday) out.push({ thread_id: t.id, who: who(t), kind: 'follow_up', detail: `Follow-up due ${t.follow_up_at < now ? 'now (overdue)' : 'today'}`, assignee_id: t.assignee_id });
  }
  const rank = { hot_waiting: 0, window_closing: 1, follow_up: 2 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind]);
}

const openThreads = async (rt: Runtime) =>
  (await rt.env.DB.prepare("SELECT * FROM dm_threads WHERE status NOT IN ('closed', 'lost') AND (last_message_at > ? OR follow_up_at IS NOT NULL) ORDER BY last_message_at DESC LIMIT 1000").bind(Date.now() - 8 * DAY).all<DmThread>()).results;

export interface SetterRow { id: string | null; name: string; open: number; waiting: number; hot: number; booked: number; showed: number; closed: number; revenue: number; cash: number; commission: number; commission_pct: number }

/** Per setter, all time (DM-sourced): booked / showed / closed, deal value, cash collected on the linked lead, and their commission on that cash. */
export async function setterBoard(rt: Runtime, threads: DmThread[]): Promise<SetterRow[]> {
  const rows = (await rt.env.DB.prepare(
    `SELECT t.assignee_id AS id, SUM(t.booked_at IS NOT NULL) AS booked, SUM(t.showed_at IS NOT NULL) AS showed, SUM(t.status = 'closed') AS closed,
            SUM(CASE WHEN t.status = 'closed' THEN COALESCE(NULLIF(l.revenue, 0), t.deal_value) ELSE 0 END) AS revenue,
            SUM(CASE WHEN t.status = 'closed' THEN COALESCE(l.cash_collected, 0) ELSE 0 END) AS cash
       FROM dm_threads t LEFT JOIN leads l ON l.id = t.lead_id GROUP BY t.assignee_id`,
  ).all<{ id: string | null; booked: number; showed: number; closed: number; revenue: number; cash: number }>()).results;
  const by = new Map(rows.map((r) => [r.id ?? '', r]));
  const ids = [...new Set([...rt.reps.filter((r) => r.active && (r.role === 'setter' || by.has(r.id))).map((r) => r.id), ...rows.map((r) => r.id ?? '')])];
  return ids.map((id) => {
    const rep = rt.reps.find((r) => r.id === id) ?? null;
    const r = by.get(id) ?? { booked: 0, showed: 0, closed: 0, revenue: 0, cash: 0 };
    const mine = threads.filter((t) => (t.assignee_id ?? '') === id);
    const pct = rep?.commission_pct ?? 0;
    return {
      id: id || null, name: rep?.name ?? 'Unassigned', open: mine.length, waiting: mine.filter(awaitingReply).length, hot: mine.filter((t) => t.band === 'hot').length,
      booked: r.booked ?? 0, showed: r.showed ?? 0, closed: r.closed ?? 0, revenue: r.revenue ?? 0, cash: r.cash ?? 0, commission_pct: pct, commission: ((r.cash ?? 0) * pct) / 100,
    };
  }).filter((r) => r.id !== null || r.open || r.booked).sort((a, b) => b.closed - a.closed || b.booked - a.booked || b.open - a.open);
}

export async function managerDashboard(rt: Runtime, now = Date.now()) {
  const tz = rt.settings.SALES_TIMEZONE || 'Australia/Sydney';
  const b = dayBounds(now, tz);
  const threads = await openThreads(rt);
  const [yesterday, today, setters, scripts] = await Promise.all([dayResults(rt, b.startYesterday, b.startToday), dayResults(rt, b.startToday, now), setterBoard(rt, threads), scriptReport(rt)]);
  return { tz, yesterday, today, tasks: tasksFrom(threads, now, b.endToday).slice(0, 60), setters, scripts };
}

// ───────────────────────────── Script analytics ─────────────────────────────

export async function scriptReport(rt: Runtime) {
  const db = rt.env.DB;
  const [uses, inbound, statuses, scripts] = await Promise.all([
    db.prepare("SELECT script_id, thread_id, ts FROM dm_messages WHERE direction = 'out' AND status = 'sent' AND script_id IS NOT NULL").all<{ script_id: string; thread_id: string; ts: number }>(),
    db.prepare("SELECT m.thread_id, m.ts FROM dm_messages m WHERE m.direction = 'in' AND m.thread_id IN (SELECT DISTINCT thread_id FROM dm_messages WHERE script_id IS NOT NULL)").all<{ thread_id: string; ts: number }>(),
    db.prepare('SELECT id, status FROM dm_threads WHERE id IN (SELECT DISTINCT thread_id FROM dm_messages WHERE script_id IS NOT NULL)').all<{ id: string; status: string }>(),
    db.prepare('SELECT id, title, category FROM dm_scripts').all<{ id: string; title: string; category: string }>(),
  ]);
  const inMap = new Map<string, number[]>();
  for (const r of inbound.results) (inMap.get(r.thread_id) ?? inMap.set(r.thread_id, []).get(r.thread_id)!).push(r.ts);
  const stats = scriptStats(uses.results, inMap, new Map(statuses.results.map((s) => [s.id, s.status])));
  const name = new Map(scripts.results.map((s) => [s.id, s]));
  const label = (s: ScriptStat | null) => (s ? { ...s, title: name.get(s.script_id)?.title ?? 'Deleted script', category: name.get(s.script_id)?.category ?? '' } : null);
  const bw = bestAndWorst(stats);
  return { rows: stats.map((s) => label(s)!), best: label(bw.best), worst: label(bw.worst), minThreads: bw.minThreads, total: uses.results.length };
}

// ───────────────────────────── Daily digest per setter ─────────────────────────────

export interface SetterDigest { title: string; lines: string[]; text: string }

/** Composes one setter's digest from counted numbers only. */
export function composeSetterDigest(rep: Pick<Rep, 'name'>, date: string, y: DayResults, tasks: Task[], link: string): SetterDigest {
  const hot = tasks.filter((t) => t.kind === 'hot_waiting');
  const fu = tasks.filter((t) => t.kind === 'follow_up');
  const closing = tasks.filter((t) => t.kind === 'window_closing');
  const lines = [
    `*Yesterday*: ${y.replies} replies sent · ${y.conversations} new conversations · ${y.booked} booked · ${y.showed} showed · ${y.closed} closed${y.revenue ? ` (${money(y.revenue)})` : ''}`,
    `*Today*: ${hot.length} hot ${hot.length === 1 ? 'lead' : 'leads'} waiting · ${fu.length} follow-up${fu.length === 1 ? '' : 's'} due · ${closing.length} window${closing.length === 1 ? '' : 's'} closing soon`,
    ...[...hot, ...closing, ...fu].slice(0, 10).map((t) => `• ${t.who}: ${t.detail}`),
    `Open the DM inbox: ${link}`,
  ];
  return { title: `DM digest for ${rep.name}, ${date}`, lines, text: lines.join('\n').replace(/\*/g, '') };
}

/** Cron: once a day at DIGEST_HOUR, one digest per active setter with assigned conversations (Slack mention and email). */
export async function maybeSendSetterDigests(rt: Runtime, now = Date.now()) {
  if (!flag(rt.settings.DM_DIGEST, true)) return 0;
  const tz = rt.settings.SALES_TIMEZONE || 'Australia/Sydney';
  const hour = Number(rt.settings.DIGEST_HOUR || 8);
  const clock = localClock(now, tz);
  if (!Number.isFinite(hour) || hour < 0 || clock.hour !== hour) return 0;
  const claim = await rt.env.DB.prepare('INSERT OR IGNORE INTO kv_state (key, value) VALUES (?, ?)').bind(`dm:digest:${clock.date}`, String(now)).run();
  if (!claim.meta.changes) return 0;
  const b = dayBounds(now, tz);
  const threads = await openThreads(rt);
  const tasks = tasksFrom(threads, now, b.endToday);
  let sent = 0;
  for (const rep of rt.reps.filter((r) => r.active && r.role === 'setter')) {
    const mine = tasks.filter((t) => t.assignee_id === rep.id);
    const y = await dayResults(rt, b.startYesterday, b.startToday, rep.id);
    if (!mine.length && !y.replies && !y.booked && !threads.some((t) => t.assignee_id === rep.id)) continue;
    const d = composeSetterDigest(rep, clock.date, y, mine, `${rt.origin}/admin#dminbox`);
    if (notifyConfigured(rt)) await notify(rt, { kind: 'digest', title: d.title, lines: d.lines.slice(0, -1), rep });
    if (rep.email && emailConfigured(rt)) {
      await sendViaResend(rt, { to: rep.email, subject: d.title, text: d.text, html: `<div style="font:15px/1.5 -apple-system,system-ui,sans-serif">${d.text.split('\n').map((l) => l.replace(/&/g, '&amp;').replace(/</g, '&lt;')).join('<br>')}</div>` }).catch((e) => console.error('dm digest email', e));
    }
    sent++;
  }
  if (sent) await logAction(rt, { dept: 'dm', kind: 'dm.digest', summary: `Daily DM digest sent to ${sent} setter${sent === 1 ? '' : 's'}`, actor: 'auto', status: 'done' });
  return sent;
}

// ───────────────────────────── Alerts ─────────────────────────────

/** Cron: alert once per inbound message when a hot lead waits too long, and once per follow-up when it is missed by 30 minutes. */
export async function processDmAlerts(rt: Runtime, now = Date.now()) {
  if (!notifyConfigured(rt)) return { hot: 0, followups: 0 };
  const mins = rt.settings.DM_HOT_ALERT_MIN === '' ? 15 : Number(rt.settings.DM_HOT_ALERT_MIN);
  let hot = 0, followups = 0;
  if (Number.isFinite(mins) && mins > 0) {
    const rows = (await rt.env.DB.prepare(
      `SELECT * FROM dm_threads WHERE band = 'hot' AND COALESCE(ai_flag, '') != 'junk' AND status NOT IN ('closed', 'lost')
         AND last_in_at IS NOT NULL AND last_in_at > COALESCE(last_out_at, 0) AND last_in_at < ? AND last_in_at > ? AND COALESCE(hot_alerted_at, 0) < last_in_at LIMIT 20`,
    ).bind(now - mins * 60_000, now - DAY).all<DmThread>()).results;
    for (const t of rows) {
      const rep = rt.reps.find((r) => r.id === t.assignee_id) ?? null;
      await notify(rt, { kind: 'hot_lead', title: `Hot DM waiting ${Math.round((now - t.last_in_at!) / 60_000)} min: ${who(t)}`, lines: [t.score_reason ?? '', `Assigned to ${rep?.name ?? 'nobody'} · ${windowLabel(windowState(t, now))}`] , rep });
      await rt.env.DB.prepare('UPDATE dm_threads SET hot_alerted_at = ? WHERE id = ?').bind(now, t.id).run();
      hot++;
    }
  }
  const due = (await rt.env.DB.prepare(
    `SELECT * FROM dm_threads WHERE follow_up_at IS NOT NULL AND follow_up_at < ? AND follow_up_at > ? AND followup_alerted_at IS NULL
       AND COALESCE(last_out_at, 0) < follow_up_at AND status NOT IN ('closed', 'lost') LIMIT 20`,
  ).bind(now - 30 * 60_000, now - 3 * DAY).all<DmThread>()).results;
  for (const t of due) {
    const rep = rt.reps.find((r) => r.id === t.assignee_id) ?? null;
    await notify(rt, { kind: 'call_soon', title: `Missed DM follow-up: ${who(t)}`, lines: [`Follow-up was due ${new Date(t.follow_up_at!).toISOString().slice(11, 16)} UTC and no message has gone out since.`, windowLabel(windowState(t, now))], rep });
    await rt.env.DB.prepare('UPDATE dm_threads SET followup_alerted_at = ? WHERE id = ?').bind(now, t.id).run();
    followups++;
  }
  return { hot, followups };
}

/** The inbox list, highest priority first. */
export function sortByPriority(threads: DmThread[], now: number) {
  return threads.map((t) => ({ t, p: priority(t, now) })).sort((a, b) => b.p - a.p || (b.t.last_message_at ?? 0) - (a.t.last_message_at ?? 0));
}
