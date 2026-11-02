import type { Runtime } from '../app';
import { compare, loadResults, prevDay } from '../dataq/run';
import { merFloor, merSummary } from '../marketing/mer';
import { SIGNALS } from '../tracking/signals';
import { fmt, SOURCES } from './metrics';
import { type ReleaseRow, deployedBuild, listReleases, releaseLine } from './releases';

/**
 * The health half of the morning brief and the weekend summary (overnight round 2, "command"): what broke, what got
 * worse and what ran, from tables other parts of the app already fill. Each section is read on its own (a missing
 * table or a failing query hides that section, never the brief), is left out when it has nothing to say, and every
 * number in it links to the Funnel HQ view it comes from. Nothing here is estimated.
 */
const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);
const fmtN = (n: number) => new Intl.NumberFormat('en-US').format(Math.round(n));
const plural = (n: number, one: string, many = `${one}s`) => `${fmtN(n)} ${n === 1 ? one : many}`;

export interface HealthErrors { occurrences: number; distinct: number; fresh: number; fromDay: string; top: { kind: string; source: string; message: string; count: number }[] }
export interface HealthCron { jobs: { job: string; status: string; error: string | null; ms: number | null; fails: number }[]; tickAgoMin: number | null }
export interface HealthDataq { day: string; prevDay: string; worse: { label: string; n: number; total: number | null; delta: number; href: string }[] }
export interface HealthMer { mer: number | null; revenue: number; spend: number; currency: string | null; prevMer: number | null; floor: number | null; comparable: boolean }
export interface HealthSignals { sent: number; noConsent: number; bySignal: { label: string; sent: number; noConsent: number }[] }
export interface HealthRoom { id: string; title: string; status: string; peak: number; attendees: number; avgMinutes: number | null; pushes: number; purchases: number }
export interface HealthBuild { id: string | null; releases: Pick<ReleaseRow, 'build' | 'deployed_at' | 'notes'>[] }

export interface BriefHealth {
  /** "in the last 24 hours" or "since Sat 31 Oct": the window the section counts cover. */
  window: string;
  errors?: HealthErrors;
  cron?: HealthCron;
  dataq?: HealthDataq;
  mer?: HealthMer;
  signals?: HealthSignals;
  rooms?: HealthRoom[];
  build?: HealthBuild;
}

type Rt = Pick<Runtime, 'env' | 'settings'>;
const quiet = async <T,>(label: string, p: () => Promise<T | undefined>): Promise<T | undefined> => {
  try { return await p(); } catch (e) { console.error(`brief health ${label}`, e); return undefined; }
};

export async function readErrors(rt: Rt, since: number, now: number): Promise<HealthErrors | undefined> {
  const fromDay = utcDay(since);
  const { results } = await rt.env.DB.prepare(
    `SELECT e.kind, e.source, e.message, e.first_at,
            COALESCE((SELECT SUM(d.count) FROM app_error_days d WHERE d.fingerprint = e.fingerprint AND d.day >= ?), 0) AS recent
       FROM app_errors e WHERE e.last_at >= ? AND e.last_at <= ? ORDER BY recent DESC, e.last_at DESC LIMIT 100`,
  ).bind(fromDay, since, now).all<{ kind: string; source: string; message: string; first_at: number; recent: number }>();
  if (!results.length) return undefined;
  return {
    occurrences: results.reduce((a, r) => a + Number(r.recent), 0),
    distinct: results.length,
    fresh: results.filter((r) => Number(r.first_at) >= since).length,
    fromDay,
    top: results.slice(0, 5).map((r) => ({ kind: r.kind, source: r.source, message: String(r.message).slice(0, 140), count: Number(r.recent) })),
  };
}

export async function readCron(rt: Rt, now: number): Promise<HealthCron | undefined> {
  const [rows, tick] = await Promise.all([
    rt.env.DB.prepare("SELECT job, last_status, last_error, last_ms, fails FROM cron_runs WHERE last_status IN ('failed', 'slow') ORDER BY last_status, job").all<{ job: string; last_status: string; last_error: string | null; last_ms: number | null; fails: number }>(),
    rt.env.DB.prepare("SELECT value FROM kv_state WHERE key = 'cron:last_tick'").first<{ value: string }>(),
  ]);
  let tickAt: number | null = null;
  try { tickAt = tick ? Number(JSON.parse(tick.value).at) || null : null; } catch { tickAt = null; }
  const ago = tickAt ? Math.floor((now - tickAt) / 60_000) : null;
  const stale = ago != null && ago >= 15 ? ago : null; // the cron runs every 5 minutes: 15+ minutes means it stopped
  if (!rows.results.length && stale == null) return undefined;
  return { jobs: rows.results.map((r) => ({ job: r.job, status: r.last_status, error: r.last_error ? String(r.last_error).slice(0, 140) : null, ms: r.last_ms == null ? null : Number(r.last_ms), fails: Number(r.fails) })), tickAgoMin: stale };
}

export async function readDataq(rt: Runtime): Promise<HealthDataq | undefined> {
  const latest = await rt.env.DB.prepare('SELECT MAX(day) AS day FROM dq_results').first<{ day: string | null }>();
  if (!latest?.day) return undefined;
  const day = latest.day, before = prevDay(day);
  const rows = await loadResults(rt, before);
  const cmp = compare(rows.filter((r) => r.day === day), rows.filter((r) => r.day === before));
  const worse = cmp.filter((r) => r.warn && r.delta != null && r.delta > 0 && r.today?.n != null)
    .map((r) => ({ label: r.def.label, n: r.today!.n!, total: r.today!.total, delta: r.delta!, href: r.def.fix.href }));
  return worse.length ? { day, prevDay: before, worse } : undefined;
}

export async function readMer(rt: Runtime, now: number): Promise<HealthMer | undefined> {
  const s = await merSummary(rt, now);
  if (s.w7.spend <= 0 && s.w7.revenue <= 0) return undefined;
  return { mer: s.w7.mer, revenue: s.w7.revenue, spend: s.w7.spend, currency: s.currency ?? s.spendCurrency, prevMer: s.w7.prev.mer, floor: merFloor(rt.settings as unknown as Record<string, string>), comparable: s.comparable };
}

export async function readSignals(rt: Rt, since: number, now: number): Promise<HealthSignals | undefined> {
  const { results } = await rt.env.DB.prepare('SELECT signal, status, COUNT(*) AS n FROM meta_signals WHERE sent_at >= ? AND sent_at <= ? GROUP BY signal, status')
    .bind(since, now).all<{ signal: string; status: string; n: number }>();
  if (!results.length) return undefined;
  const of = (id: string, status: string) => results.filter((r) => r.signal === id && r.status === status).reduce((a, r) => a + Number(r.n), 0);
  const bySignal = SIGNALS.map((d) => ({ label: d.label, sent: of(d.id, 'sent'), noConsent: of(d.id, 'no_consent') })).filter((x) => x.sent || x.noConsent);
  return { sent: bySignal.reduce((a, x) => a + x.sent, 0), noConsent: bySignal.reduce((a, x) => a + x.noConsent, 0), bySignal };
}

export async function readRooms(rt: Rt, since: number, now: number, limit = 10): Promise<HealthRoom[] | undefined> {
  const { results } = await rt.env.DB.prepare(
    `SELECT r.id, r.title, r.status, r.peak,
            (SELECT COUNT(*) FROM room_attendance a WHERE a.room_id = r.id AND a.role IN ('attendee', 'guest')) AS attendees,
            (SELECT AVG(a.minutes) FROM room_attendance a WHERE a.room_id = r.id AND a.role IN ('attendee', 'guest')) AS avg_min,
            (SELECT COUNT(*) FROM room_pushes p WHERE p.room_id = r.id) AS pushes,
            (SELECT COUNT(DISTINCT e.who) FROM room_push_events e WHERE e.room_id = r.id AND e.event = 'paid') AS purchases
       FROM rooms r
      WHERE r.went_live_at IS NOT NULL AND r.went_live_at <= ? AND (r.went_live_at >= ? OR r.ended_at >= ? OR r.status = 'live')
      ORDER BY r.went_live_at DESC LIMIT ?`,
  ).bind(now, since, since, limit).all<{ id: string; title: string; status: string; peak: number; attendees: number; avg_min: number | null; pushes: number; purchases: number }>();
  if (!results.length) return undefined;
  return results.map((r) => ({ id: r.id, title: r.title, status: r.status, peak: Number(r.peak) || 0, attendees: Number(r.attendees) || 0, avgMinutes: r.avg_min == null ? null : Math.round(Number(r.avg_min)), pushes: Number(r.pushes) || 0, purchases: Number(r.purchases) || 0 }));
}

export async function readBuild(rt: Rt, since: number): Promise<HealthBuild | undefined> {
  const id = deployedBuild(rt.env);
  const releases = await listReleases(rt, { since, limit: 5 });
  if (!id && !releases.length) return undefined;
  return { id, releases };
}

/** Every section, each read on its own. `since` starts the window; `window` is how the brief names it. */
export async function buildHealth(rt: Runtime, since: number, window: string, now = Date.now()): Promise<BriefHealth> {
  const [errors, cron, dataq, mer, signals, rooms, build] = await Promise.all([
    quiet('errors', () => readErrors(rt, since, now)),
    quiet('cron', () => readCron(rt, now)),
    quiet('data quality', () => readDataq(rt)),
    quiet('mer', () => readMer(rt, now)),
    quiet('signals', () => readSignals(rt, since, now)),
    quiet('rooms', () => readRooms(rt, since, now)),
    quiet('build', () => readBuild(rt, since)),
  ]);
  return { window, errors, cron, dataq, mer, signals, rooms, build };
}

/** Pure: the brief's health sections as markdown lines (empty when there is nothing to report). */
export function composeHealth(h: BriefHealth | undefined, when: (t: number) => string): string[] {
  if (!h) return [];
  const md: string[] = [];
  const link = (text: string, href: string) => `[${text}](${href})`;
  const S = SOURCES;
  if (h.errors) {
    const e = h.errors;
    md.push('', '## Errors');
    md.push(`${link(plural(e.distinct, 'distinct error'), S.errors.href)} seen ${h.window}${e.fresh ? `, ${link(`${fmtN(e.fresh)} new`, S.errors.href)}` : ''}. ${link(plural(e.occurrences, 'occurrence'), S.errors.href)} counted since ${e.fromDay} (UTC days).`);
    for (const x of e.top) md.push(`- ${x.kind} · ${x.source}: ${x.message} · ${link(`${fmtN(x.count)}×`, S.errors.href)}`);
  }
  if (h.cron) {
    const c = h.cron;
    md.push('', '## Cron jobs');
    if (c.tickAgoMin != null) md.push(`- The 5-minute cron last ran ${link(`${fmtN(c.tickAgoMin)} minutes ago`, S.errors.href)}.`);
    for (const j of c.jobs) {
      const how = j.status === 'failed' ? `failed${j.error ? `: ${j.error}` : ''}` : `slow${j.ms != null ? `, ran past its budget at ${link(`${fmtN(Math.round(j.ms / 1000))} s`, S.errors.href)}` : ''}`;
      md.push(`- **${j.job}** ${how}${j.fails ? ` · ${link(`${plural(j.fails, 'failure')} in total`, S.errors.href)}` : ''}`);
    }
  }
  if (h.dataq) {
    md.push('', `## Data quality got worse (${h.dataq.day} vs ${h.dataq.prevDay})`);
    for (const w of h.dataq.worse) md.push(`- **${w.label}**: ${link(`${fmtN(w.n)}${w.total != null ? ` of ${fmtN(w.total)}` : ''}`, w.href)} (${link(`+${fmtN(w.delta)}`, w.href)} vs the day before)`);
    md.push(`Every check: ${link(S.dataq.label, S.dataq.href)}`);
  }
  if (h.mer) {
    const m = h.mer;
    const money = (v: number) => fmt({ value: v, kind: 'money', currency: m.currency ?? 'USD' });
    md.push('', '## Blended MER, last 7 days');
    if (!m.comparable) md.push(`Revenue and ad spend are in different currencies, so MER is not worked out. ${link(S.autopilot.label, S.autopilot.href)}`);
    else {
      const floorTxt = m.floor == null ? 'No floor set (ADS_MER_FLOOR).' : m.mer != null && m.mer < m.floor ? `**Under the floor of ${link(String(m.floor), S.autopilot.href)}**: the autopilot holds scaling proposals.` : `At or above the floor of ${link(String(m.floor), S.autopilot.href)}.`;
      md.push(`${link(m.mer == null ? 'n/a' : m.mer.toFixed(2), S.autopilot.href)} (${link(money(m.revenue), S.autopilot.href)} revenue net of refunds ÷ ${link(money(m.spend), S.autopilot.href)} ad spend)${m.prevMer != null ? `, the 7 days before: ${link(m.prevMer.toFixed(2), S.autopilot.href)}` : ''}. ${floorTxt}`);
    }
  }
  if (h.signals) {
    const s = h.signals;
    md.push('', '## Meta signals');
    md.push(`${link(plural(s.sent, 'signal'), S.audiences.href)} sent to Meta ${h.window}${s.noConsent ? `, ${link(`${fmtN(s.noConsent)} held back`, S.audiences.href)} (no consent)` : ''}.`);
    for (const x of s.bySignal) md.push(`- ${x.label}: ${[x.sent ? link(`${fmtN(x.sent)} sent`, S.audiences.href) : '', x.noConsent ? link(`${fmtN(x.noConsent)} no consent`, S.audiences.href) : ''].filter(Boolean).join(', ')}`);
  }
  if (h.rooms?.length) {
    md.push('', `## Rooms ${h.window}`);
    for (const r of h.rooms) {
      const href = S.rooms.href;
      const parts = [`${link(plural(r.attendees, 'attendee'), href)}`, `peak ${link(fmtN(r.peak), href)}`];
      if (r.avgMinutes != null) parts.push(`${link(`${fmtN(r.avgMinutes)} min`, href)} average`);
      parts.push(`${link(plural(r.pushes, 'push', 'pushes'), href)}`, `${link(plural(r.purchases, 'purchase'), href)}`);
      md.push(`- **${r.title}**${r.status === 'live' ? ' (live now)' : ''}: ${parts.join(', ')}`);
    }
  }
  if (h.build) {
    md.push('', '## Deploys');
    if (h.build.id) md.push(`Running build ${link(h.build.id, S.activity.href)} (also on /health).`);
    for (const r of h.build.releases) md.push(`- ${releaseLine(r, when)}`);
  }
  return md;
}
