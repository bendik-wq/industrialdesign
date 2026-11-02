import type { Runtime } from '../app';
import { localParts } from '../challenge/schedule';
import { briefMinute, saveBriefThread } from '../ops/brief';
import { formatDay, ownerTz } from '../ops/range';
import { opsSlackConfigured, postOps } from '../ops/slack';
import { CHECKS, CHECK_KEYS, type CheckKey, type CheckResult, isWarn, runChecks } from './checks';

/**
 * The daily data-quality run: every check once a day (first cron run after DQ_HOUR in the owner's time zone),
 * stored per day in dq_results, then summarised as a brief item in Command. The summary goes to Slack only when
 * the morning brief itself is on (OPS_BRIEF_TIME not "off") and Slack or Discord is connected for Command, so
 * this adds no new destination and no new send that the owner has not already switched on.
 */
export const DQ_HOUR = 6;

export interface StoredResult extends CheckResult { day: string; computed_at: number }

const parse = (s: unknown) => { try { return s ? JSON.parse(String(s)) : null; } catch { return null; } };
const isKey = (k: unknown): k is CheckKey => typeof k === 'string' && (CHECK_KEYS as readonly string[]).includes(k);

export function localDay(rt: Pick<Runtime, 'settings'>, now = Date.now()) { return localParts(now, ownerTz(rt)).date; }
export function prevDay(day: string) { const t = Date.parse(`${day}T12:00:00Z`) - 86_400_000; return new Date(t).toISOString().slice(0, 10); }

export async function saveResults(rt: Runtime, day: string, results: CheckResult[], now = Date.now()) {
  const st = results.map((r) => rt.env.DB.prepare(
    `INSERT INTO dq_results (day, check_key, n, total, examples, detail, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(day, check_key) DO UPDATE SET n = excluded.n, total = excluded.total, examples = excluded.examples, detail = excluded.detail, computed_at = excluded.computed_at`,
  ).bind(day, r.key, r.n, r.total, JSON.stringify(r.examples.slice(0, 10)), JSON.stringify({ ...(r.detail ?? {}), ...(r.note ? { note: r.note } : {}) }), now));
  await rt.env.DB.batch(st);
}

/** Stored rows from `since` (YYYY-MM-DD) on, newest day first. */
export async function loadResults(rt: Runtime, since: string): Promise<StoredResult[]> {
  const { results } = await rt.env.DB.prepare('SELECT * FROM dq_results WHERE day >= ? ORDER BY day DESC, check_key').bind(since).all<Record<string, unknown>>();
  return results.filter((r) => isKey(r.check_key)).map((r) => {
    const detail = (parse(r.detail) ?? {}) as Record<string, unknown>;
    const note = typeof detail.note === 'string' ? detail.note : undefined;
    delete detail.note;
    return {
      key: r.check_key as CheckKey, day: String(r.day), n: r.n == null ? null : Number(r.n), total: r.total == null ? null : Number(r.total),
      examples: (parse(r.examples) as string[] | null) ?? [], detail, note, computed_at: Number(r.computed_at),
    };
  });
}

export interface DqRow { def: (typeof CHECKS)[CheckKey]; today: CheckResult | null; yesterday: CheckResult | null; warn: boolean; delta: number | null }

/** Today's checks next to yesterday's (pure). */
export function compare(today: CheckResult[], yesterday: CheckResult[]): DqRow[] {
  const t = new Map(today.map((r) => [r.key, r])), y = new Map(yesterday.map((r) => [r.key, r]));
  return CHECK_KEYS.map((k) => {
    const a = t.get(k) ?? null, b = y.get(k) ?? null;
    return { def: CHECKS[k], today: a, yesterday: b, warn: a ? isWarn(a) : false, delta: a?.n != null && b?.n != null ? a.n - b.n : null };
  });
}

const fmtN = (n: number) => new Intl.NumberFormat('en-US').format(n);
const vsYesterday = (r: DqRow) => (r.delta == null ? 'no reading yesterday' : r.delta === 0 ? 'same as yesterday' : `${r.delta > 0 ? '+' : ''}${fmtN(r.delta)} vs yesterday`);

/** The Command item (markdown) and the Slack lines. Only formats the numbers it is given. */
export function composeSummary(rows: DqRow[], dateLabel: string) {
  const title = `Data quality, ${dateLabel}`;
  const warn = rows.filter((r) => r.warn), clean = rows.filter((r) => r.today && !r.warn && r.today.n != null), off = rows.filter((r) => !r.today || r.today.n == null);
  const md: string[] = [`# ${title}`, '', `${warn.length} of ${rows.length} checks need a look, ${clean.length} are clean${off.length ? `, ${off.length} could not be measured` : ''}. Flow checks cover the last 7 days.`];
  if (warn.length) {
    md.push('', '## Needs a look');
    for (const r of warn) {
      const x = r.today!;
      md.push(`- **${r.def.label}**: ${fmtN(x.n ?? 0)}${x.total != null ? ` of ${fmtN(x.total)}` : ''} (${vsYesterday(r)}) · [Fix in ${r.def.fix.label}](${r.def.fix.href})`);
    }
  }
  if (clean.length) md.push('', '## Clean', clean.map((r) => r.def.label).join(', ') + '.');
  if (off.length) {
    md.push('', '## Not measured');
    for (const r of off) md.push(`- ${r.def.label}: ${r.today?.note ?? 'no result yet'}`);
  }
  md.push('', 'Every count, with example ids: [Ad tracking → Data quality](/admin#tracking)');
  const markdown = md.join('\n');
  const slackLines = md.slice(1).filter((l) => l !== '').map((l) => l.replace(/^## (.*)$/, '**$1**'));
  return { title, markdown, slackLines, warnings: warn.length };
}

/** Run every check now, store today's row, and return the comparison with yesterday. */
export async function runDataQuality(rt: Runtime, now = Date.now()) {
  const day = localDay(rt, now);
  const results = await runChecks(rt, now);
  await saveResults(rt, day, results, now);
  const yesterday = await loadResults(rt, prevDay(day)).then((r) => r.filter((x) => x.day === prevDay(day))).catch(() => []);
  return { day, rows: compare(results, yesterday) };
}

/** Post the day's summary into Command (a brief item) and, when the morning brief already goes to Slack, there too. */
export async function postSummary(rt: Runtime, rows: DqRow[], now = Date.now(), fetcher?: typeof fetch) {
  const s = composeSummary(rows, formatDay(now, ownerTz(rt)));
  const thread = await saveBriefThread(rt, s.title, s.markdown, now);
  const briefOn = briefMinute((rt.settings as Partial<Record<string, string>>).OPS_BRIEF_TIME) != null;
  const sent = briefOn && opsSlackConfigured(rt)
    ? await postOps(rt, { title: s.title, lines: s.slackLines, path: `/admin#command/thread=${thread}`, linkText: 'Open in Funnel HQ' }, fetcher)
    : { slack: false, discord: false };
  return { thread, ...s, sent };
}

/** Called by Command's share of the 5-minute cron: once per local day, from DQ_HOUR on. */
export async function maybeRunDataQuality(rt: Runtime, now = Date.now()) {
  const { date, time } = localParts(now, ownerTz(rt));
  if (Number(time.split(':')[0]) < DQ_HOUR) return null;
  const claim = await rt.env.DB.prepare('INSERT OR IGNORE INTO kv_state (key, value) VALUES (?, ?)').bind(`dq:run:${date}`, String(now)).run();
  if (!claim.meta.changes) return null;
  const run = await runDataQuality(rt, now);
  const post = await postSummary(rt, run.rows, now);
  return { day: run.day, warnings: post.warnings, thread: post.thread };
}
