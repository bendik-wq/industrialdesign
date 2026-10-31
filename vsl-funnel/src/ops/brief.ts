import type { Runtime } from '../app';
import { localParts } from '../challenge/schedule';
import { newId } from '../lib/ids';
import { type ActionRow, DEPT_LABEL, type Dept, listActions } from './actions';
import { type MetricKey, type Snapshot, change, fmt, fmtChange, snapshot } from './metrics';
import { formatDay, localWeekday, ownerTz, priorOf, resolveRange } from './range';
import { postOps } from './slack';

/**
 * The morning brief (every day at OPS_BRIEF_TIME, owner's time zone) and, on Mondays, the weekend summary:
 * yesterday's numbers against the day before, what each department did (from the action log), and what is
 * waiting for a decision. Every number is a metric from metrics.ts or a count of log rows, printed with its source.
 */
export const BRIEF_METRICS: MetricKey[] = ['visitors', 'leads', 'applications', 'webinar_regs', 'live_regs', 'challenge_regs', 'tickets', 'bookings', 'show_rate', 'deals', 'revenue', 'sprint_sales', 'sprint_revenue', 'deposits', 'deposit_revenue', 'ad_spend', 'cpl', 'cpa'];

export interface BriefPeriod { label: string; priorLabel: string; cur: Snapshot; prior: Snapshot }
export interface BriefData {
  kind: 'daily' | 'weekend';
  dateLabel: string;
  periods: BriefPeriod[];
  actions: Pick<ActionRow, 'dept' | 'summary' | 'status' | 'actor'>[];
  approvals: Pick<ActionRow, 'id' | 'dept' | 'summary' | 'risk'>[];
  alerts: { title: string }[];
}

/** Pure: the brief's text from data. Only formats numbers it is given. */
export function composeBrief(d: BriefData) {
  const title = d.kind === 'weekend' ? `Weekend summary, ${d.dateLabel}` : `Morning brief, ${d.dateLabel}`;
  const md: string[] = [`# ${title}`];
  for (const p of d.periods) {
    md.push('', `## ${p.label} (vs ${p.priorLabel})`);
    const rows = BRIEF_METRICS.map((k) => ({ m: p.cur[k], q: p.prior[k] })).filter(({ m, q }) => (m.value ?? 0) !== 0 || (q.value ?? 0) !== 0);
    if (!rows.length) md.push('No activity was recorded in this period or the one before.');
    for (const { m, q } of rows) {
      const c = change(m.value, q.value);
      md.push(`- **${m.label}**: ${fmt(m)} (before: ${fmt(q)}${q.value ? `, ${fmtChange(c)}` : ''}) · [${m.source.label}](${m.source.href})`);
    }
  }
  md.push('', '## What the departments did');
  const done = d.actions.filter((a) => a.status === 'done' || a.status === 'failed');
  if (!done.length) md.push('Nothing was logged in this period.');
  const byDept = new Map<string, typeof done>();
  for (const a of done) byDept.set(a.dept, [...(byDept.get(a.dept) ?? []), a]);
  for (const [dept, list] of byDept) {
    const failed = list.filter((a) => a.status === 'failed').length;
    md.push(`- **${DEPT_LABEL[dept as Dept] ?? dept}**: ${list.length} logged${failed ? `, ${failed} failed` : ''}. ${list.slice(0, 3).map((a) => a.summary).join('; ')}`);
  }
  md.push(`Full log: [Command → Activity](/admin#command/activity)`);
  md.push('', '## Needs your decision');
  if (!d.approvals.length) md.push('Nothing is waiting for approval.');
  else {
    md.push(`${d.approvals.length} waiting in [Command → Approvals](/admin#command/approvals):`);
    for (const a of d.approvals.slice(0, 6)) md.push(`- ${DEPT_LABEL[a.dept as Dept] ?? a.dept}: ${a.summary}${a.risk === 'high' ? ' (high risk)' : ''}`);
  }
  if (d.alerts.length) {
    md.push('', '## Alerts in the last 24 hours');
    for (const a of d.alerts.slice(0, 6)) md.push(`- ${a.title}`);
  }
  const markdown = md.join('\n');
  // Slack: headings become bold lines; the bullet list stays.
  const slackLines = md.slice(1).filter((l) => l !== '').map((l) => l.replace(/^## (.*)$/, '**$1**'));
  return { title, markdown, slackLines };
}

export async function buildBrief(rt: Runtime, kind: 'daily' | 'weekend', now = Date.now()): Promise<BriefData> {
  const tz = ownerTz(rt);
  const periods: BriefPeriod[] = [];
  const add = async (key: string, label: string, priorLabel: string) => {
    const r = resolveRange(key, tz, now);
    const p = priorOf(r);
    const [cur, prior] = await Promise.all([snapshot(rt, r), snapshot(rt, p)]);
    periods.push({ label, priorLabel, cur, prior });
    return r;
  };
  let since: number;
  if (kind === 'weekend') {
    const w = await add('weekend', 'The weekend', 'the weekend before');
    await add('last_week', 'Last week (Monday to Sunday)', 'the week before');
    since = w.from;
  } else {
    since = (await add('yesterday', `Yesterday, ${formatDay(now - 86_400_000, tz)}`, 'the day before')).from;
  }
  const [actions, approvals, alerts] = await Promise.all([
    listActions(rt, { since, limit: 300 }),
    listActions(rt, { status: 'proposed', limit: 50 }),
    rt.env.DB.prepare('SELECT title FROM ops_alerts WHERE created_at >= ? ORDER BY created_at DESC LIMIT 10').bind(now - 86_400_000).all<{ title: string }>().then((r) => r.results).catch(() => []),
  ]);
  return { kind, dateLabel: formatDay(now, tz), periods, actions, approvals, alerts };
}

/** Parse "07:30" into minutes after midnight; null when the brief is off or the value is unreadable. */
export function briefMinute(raw: string | undefined): number | null {
  const v = (raw ?? '').trim();
  if (/^(off|false|no|none)$/i.test(v)) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(v || '07:30');
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return 7 * 60 + 30;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Store a brief as a Command thread (kind brief) and return its id. */
export async function saveBriefThread(rt: Runtime, title: string, markdown: string, now = Date.now()) {
  const id = newId('th_');
  await rt.env.DB.batch([
    rt.env.DB.prepare("INSERT INTO ops_threads (id, title, kind, created_at, updated_at) VALUES (?, ?, 'brief', ?, ?)").bind(id, title.slice(0, 120), now, now),
    rt.env.DB.prepare("INSERT INTO ops_messages (id, thread_id, role, content, created_at) VALUES (?, ?, 'assistant', ?, ?)").bind(newId('msg_'), id, markdown, now),
  ]);
  return id;
}

export async function sendBrief(rt: Runtime, kind: 'daily' | 'weekend', now = Date.now()) {
  const b = composeBrief(await buildBrief(rt, kind, now));
  const thread = await saveBriefThread(rt, b.title, b.markdown, now);
  await postOps(rt, { title: b.title, lines: b.slackLines, path: `/admin#command/thread=${thread}`, linkText: 'Open the brief in Funnel HQ' });
  return { thread, ...b };
}

/** Called by the 5-minute cron: sends the day's brief once, in the half hour after OPS_BRIEF_TIME. Mondays get the weekend summary. */
export async function maybeSendBrief(rt: Runtime, now = Date.now()) {
  const at = briefMinute((rt.settings as Partial<Record<string, string>>).OPS_BRIEF_TIME);
  if (at == null) return null;
  const tz = ownerTz(rt);
  const { date, time } = localParts(now, tz);
  const [h, m] = time.split(':').map(Number);
  const minute = h * 60 + m;
  if (minute < at || minute >= at + 30) return null;
  const claim = await rt.env.DB.prepare('INSERT OR IGNORE INTO kv_state (key, value) VALUES (?, ?)').bind(`ops:brief:${date}`, String(now)).run();
  if (!claim.meta.changes) return null;
  return sendBrief(rt, localWeekday(now, tz) === 1 ? 'weekend' : 'daily', now);
}
