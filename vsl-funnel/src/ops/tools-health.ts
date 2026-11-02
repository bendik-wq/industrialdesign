import type Anthropic from '@anthropic-ai/sdk';
import type { Runtime } from '../app';
import { CHECKS, isWarn } from '../dataq/checks';
import { compare, loadResults, prevDay } from '../dataq/run';
import { cronReport } from '../infra/cron';
import { errorsReport } from '../infra/errors';
import { conceptsView } from '../marketing/concepts';
import { merFloor, merGuard, merSummary } from '../marketing/mer';
import { SIGNALS, signalsOn, signalValuesOn } from '../tracking/signals';
import { type Source, SOURCES } from './metrics';
import type { Range } from './range';
import { deployedBuild, listReleases } from './releases';

/**
 * The Command chat's read tools for health and marketing results (overnight round 2, "command"): errors, cron,
 * data quality, MER, ad concept results, Meta signals, room engagement and deploys. Every tool only reads; anything
 * that would change something still goes through propose_action. Each result names the Funnel HQ view it comes from.
 */
const RANGE_PROPS = {
  range: { type: 'string', description: 'Named range in the owner’s time zone (today, yesterday, 24h, 7d, 30d, 90d, this_week, last_week, mtd, last_month, weekend).' },
  from: { type: 'string', description: 'Custom start date YYYY-MM-DD (inclusive).' },
  to: { type: 'string', description: 'Custom end date YYYY-MM-DD (inclusive).' },
} as const;

export const HEALTH_TOOLS: Anthropic.Tool[] = [
  { name: 'errors', description: 'Errors from pages, webhooks, cron jobs and rooms, grouped by fingerprint (where + message with ids blanked): occurrences per UTC day, the top fingerprints with their source, count in the window, first and last seen, and which are new. Use for "what broke overnight?".', input_schema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 14, description: 'UTC days to look back, today included. Default 2.' } } } },
  { name: 'cron_health', description: 'Every job of the 5-minute cron: last run, status (ok, failed, slow = passed its time budget), last error, duration, average and slowest run, failures in total, and when the cron last ticked.', input_schema: { type: 'object', properties: {} } },
  { name: 'data_quality', description: 'The daily data-quality checks (attribution, Meta match keys, failed sends, bounces, stuck AI calls, duplicates, formats): the latest day against the day before, which need a look and which got worse, with example ids and where to fix each.', input_schema: { type: 'object', properties: {} } },
  { name: 'mer', description: 'Blended MER (revenue net of refunds ÷ ad spend) over 7 and 30 days, each against the window before, the MER floor (ADS_MER_FLOOR) and whether the autopilot is holding scaling proposals.', input_schema: { type: 'object', properties: {} } },
  { name: 'ad_concepts', description: 'Ad concept tests (rounds of concepts, each a bundle of desire, awareness, format, audience, angle and framework): spend, registrants, buyers, revenue, cost per registrant and buyer, ROAS and the verdict per concept, plus which value of each variable is winning. Use for "which ad concept is winning?".', input_schema: { type: 'object', properties: { rounds: { type: 'integer', minimum: 1, maximum: 10, description: 'Most recent rounds to include. Default 3.' } } } },
  { name: 'meta_signals', description: 'Deep-funnel signals sent to the Meta Conversions API (watched 30+ minutes, stayed for the pitch, opened an offer, started checkout, applied in the room, signed the engagement) for a range, per signal and funnel, with the count held back for lack of consent.', input_schema: { type: 'object', properties: { ...RANGE_PROPS } } },
  { name: 'room_engagement', description: 'Webinar and meeting rooms that went live in a range: attendees, peak, average minutes connected, people who stayed 30+ minutes, pushes by kind (application, sprint, deposit, vip, resource) with shown, opened, started, submitted and paid counts, and points earned.', input_schema: { type: 'object', properties: { ...RANGE_PROPS } } },
  { name: 'deploys', description: 'The running build id (as on /health) and the last deploys with the change notes each carried (recorded by npm run deploy). Use for "what changed?".', input_schema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 20 } } } },
];

const NAMES = new Set(HEALTH_TOOLS.map((t) => t.name));
export const isHealthTool = (name: string) => NAMES.has(name);

export interface HealthToolCtx { tz: string; now: number; range: (dflt: string) => Range; iso: (t: number | null | undefined) => string | null }
interface Out { result: unknown; summary: string; sources: Source[] }
const n = (v: unknown) => Number(v) || 0;
const cap = (s: unknown, max = 200) => (s == null ? null : String(s).slice(0, max));

export async function runHealthTool(rt: Runtime, name: string, input: Record<string, unknown>, c: HealthToolCtx): Promise<Out> {
  const db = rt.env.DB;
  switch (name) {
    case 'errors': {
      const days = Math.max(1, Math.min(14, Number(input.days) || 2));
      const r = await errorsReport(rt.env, c.now, days);
      const top = r.fingerprints.slice(0, 15).map((e) => ({ kind: e.kind, where: e.source, message: cap(e.message), in_window: e.recent, all_time: e.count, first_seen: c.iso(e.first_at), last_seen: c.iso(e.last_at), new_in_window: e.first_at >= c.now - days * 86_400_000, stack_first_line: cap((e.stack ?? '').split('\n')[0], 160) }));
      const total = r.days.reduce((a, d) => a + d.total, 0);
      return { result: { window_utc_days: r.days.map((d) => ({ day: d.day, occurrences: d.total, by_kind: d.kinds })), occurrences: total, distinct: r.fingerprints.length, top, note: 'Counts are per UTC day. Messages are masked for secrets and personal data.' }, summary: `${r.fingerprints.length} distinct errors, ${total} occurrences in ${days} UTC day${days === 1 ? '' : 's'}`, sources: [SOURCES.errors] };
    }
    case 'cron_health': {
      const r = await cronReport(rt.env);
      const jobs = r.jobs.map((j) => ({ job: j.job, status: j.last_status, last_started: c.iso(j.last_started), last_ms: j.last_ms, last_ok: c.iso(j.last_ok_at), last_error: cap(j.last_error), runs: n(j.runs), fails: n(j.fails), slow: n(j.slow), avg_ms: j.avg_ms, max_ms: n(j.max_ms) }));
      const bad = jobs.filter((j) => j.status !== 'ok');
      return { result: { last_tick: r.lastTick ? { at: c.iso(r.lastTick.at), minutes_ago: Math.floor((c.now - r.lastTick.at) / 60_000), ms: r.lastTick.ms, jobs: r.lastTick.jobs, failed: r.lastTick.failed, slow: r.lastTick.slow } : null, budget_ms: r.budgetMs, not_ok: bad, jobs }, summary: `${jobs.length} cron jobs, ${bad.length} failed or slow`, sources: [SOURCES.errors] };
    }
    case 'data_quality': {
      const latest = await db.prepare('SELECT MAX(day) AS day FROM dq_results').first<{ day: string | null }>();
      if (!latest?.day) return { result: { note: 'No data-quality run stored yet. It runs once a day after 6am (owner time zone).' }, summary: 'No data-quality run yet', sources: [SOURCES.dataq] };
      const before = prevDay(latest.day);
      const rows = await loadResults(rt, before);
      const cmp = compare(rows.filter((r) => r.day === latest.day), rows.filter((r) => r.day === before));
      const checks = cmp.map((r) => ({ key: r.def.key, label: r.def.label, scope: r.def.scope, problems: r.today?.n ?? null, looked_at: r.today?.total ?? null, day_before: r.yesterday?.n ?? null, change: r.delta, needs_a_look: r.today ? isWarn(r.today) : false, got_worse: r.warn && r.delta != null && r.delta > 0, examples: r.today?.examples.slice(0, 5) ?? [], note: r.today?.note ?? null, fix: r.def.fix }));
      const warn = checks.filter((x) => x.needs_a_look);
      return { result: { day: latest.day, compared_with: before, checks, what: Object.fromEntries(Object.values(CHECKS).map((d) => [d.key, d.what])) }, summary: `${warn.length} of ${checks.length} checks need a look, ${checks.filter((x) => x.got_worse).length} got worse`, sources: [SOURCES.dataq] };
    }
    case 'mer': {
      const s = await merSummary(rt, c.now);
      const floor = merFloor(rt.settings as unknown as Record<string, string>);
      const guard = merGuard(floor, s.w7, s.comparable, s.currency ?? s.spendCurrency);
      return { result: { currency: s.currency ?? s.spendCurrency, comparable: s.comparable, last_7_days: s.w7, last_30_days: s.w30, floor, holding_scaling: guard.holdScaling, guard: guard.reason, note: s.note, daily: s.series.slice(-14).map((d) => ({ day: d.day, revenue: d.revenue, spend: d.spend, mer_7d: d.mer7 })) }, summary: `MER 7 days ${s.w7.mer ?? 'n/a'}${floor != null ? `, floor ${floor}` : ''}`, sources: [SOURCES.autopilot] };
    }
    case 'ad_concepts': {
      const v = await conceptsView(rt, c.now);
      const take = Math.max(1, Math.min(10, Number(input.rounds) || 3));
      const rounds = v.rounds.slice(0, take).map((r) => ({
        round: r.label, kind: r.kind, status: r.status, created: c.iso(r.created_at),
        concepts: r.concepts.map((x) => ({ concept: x.idx, labels: x.labels, verdict: x.verdict, verdict_by: x.verdict_by, verdict_reason: x.verdict_reason, metrics: x.metrics, ads: x.ads.length }))
          .sort((a, b) => (b.metrics?.roas ?? -1) - (a.metrics?.roas ?? -1) || (a.metrics?.costPerRegistrant ?? Infinity) - (b.metrics?.costPerRegistrant ?? Infinity)),
      }));
      const leaders = Object.fromEntries(Object.entries(v.byVariable).map(([k, rows]) => [k, rows.filter((x) => x.spend > 0).slice(0, 3)]));
      const winners = rounds.flatMap((r) => r.concepts.filter((x) => x.verdict === 'winner').map((x) => ({ round: r.round, ...x })));
      return { result: { currency: v.currency, note: 'Results are from our own data: spend from Meta ad insights, registrants and buyers from attribution, revenue net of refunds, matched by the ad tag.', winners, rounds, best_by_variable: leaders }, summary: `${v.rounds.length} concept rounds, ${winners.length} winner${winners.length === 1 ? '' : 's'}`, sources: [SOURCES.autopilot] };
    }
    case 'meta_signals': {
      const r = c.range('7d');
      const { results } = await db.prepare('SELECT signal, funnel, status, COUNT(*) AS n, SUM(estimate) AS estimated FROM meta_signals WHERE sent_at BETWEEN ? AND ? GROUP BY signal, funnel, status').bind(r.from, r.to).all<{ signal: string; funnel: string; status: string; n: number; estimated: number }>();
      const signals = SIGNALS.map((d) => {
        const mine = results.filter((x) => x.signal === d.id);
        return { signal: d.label, meta_event: d.meta, sent: mine.filter((x) => x.status === 'sent').reduce((a, x) => a + n(x.n), 0), no_consent: mine.filter((x) => x.status === 'no_consent').reduce((a, x) => a + n(x.n), 0), with_estimated_value: mine.reduce((a, x) => a + n(x.estimated), 0), by_funnel: Object.fromEntries(['auto', 'live', 'challenge'].map((f) => [f, mine.filter((x) => x.funnel === f && x.status === 'sent').reduce((a, x) => a + n(x.n), 0)])) };
      });
      const sent = signals.reduce((a, x) => a + x.sent, 0);
      return { result: { range: r.label, on: signalsOn(rt), values_on: signalValuesOn(rt), signals }, summary: `${sent} signals sent to Meta, ${r.label.toLowerCase()}`, sources: [SOURCES.audiences] };
    }
    case 'room_engagement': {
      const r = c.range('7d');
      const rooms = await db.prepare(
        `SELECT r.id, r.title, r.mode, r.status, r.ref_type, r.went_live_at, r.ended_at, r.peak,
                (SELECT COUNT(*) FROM room_attendance a WHERE a.room_id = r.id AND a.role IN ('attendee', 'guest')) AS attendees,
                (SELECT AVG(a.minutes) FROM room_attendance a WHERE a.room_id = r.id AND a.role IN ('attendee', 'guest')) AS avg_min,
                (SELECT COUNT(*) FROM room_attendance a WHERE a.room_id = r.id AND a.role IN ('attendee', 'guest') AND a.minutes >= 30) AS stayed_30
           FROM rooms r WHERE r.went_live_at BETWEEN ? AND ? ORDER BY r.went_live_at DESC LIMIT 20`,
      ).bind(r.from, r.to).all<Record<string, unknown> & { id: string }>();
      const ids = rooms.results.map((x) => x.id);
      const ph = ids.map(() => '?').join(', ');
      const [pushes, events, points] = ids.length ? await Promise.all([
        db.prepare(`SELECT room_id, kind, COUNT(*) AS n FROM room_pushes WHERE room_id IN (${ph}) GROUP BY room_id, kind`).bind(...ids).all<{ room_id: string; kind: string; n: number }>().then((x) => x.results),
        db.prepare(`SELECT e.room_id, p.kind, e.event, COUNT(DISTINCT e.who) AS n FROM room_push_events e JOIN room_pushes p ON p.room_id = e.room_id AND p.id = e.push_id WHERE e.room_id IN (${ph}) GROUP BY e.room_id, p.kind, e.event`).bind(...ids).all<{ room_id: string; kind: string; event: string; n: number }>().then((x) => x.results),
        db.prepare(`SELECT room_id, COUNT(DISTINCT who) AS people, SUM(points) AS points FROM room_points WHERE room_id IN (${ph}) GROUP BY room_id`).bind(...ids).all<{ room_id: string; people: number; points: number }>().then((x) => x.results).catch(() => []),
      ]) : [[], [], []];
      const out = rooms.results.map((x) => {
        const kinds = [...new Set(pushes.filter((p) => p.room_id === x.id).map((p) => p.kind))];
        const funnel = Object.fromEntries(kinds.map((k) => [k, { pushes: pushes.filter((p) => p.room_id === x.id && p.kind === k).reduce((a, p) => a + n(p.n), 0), ...Object.fromEntries(['shown', 'opened', 'started', 'submitted', 'paid', 'dismissed'].map((ev) => [ev, events.filter((e) => e.room_id === x.id && e.kind === k && e.event === ev).reduce((a, e) => a + n(e.n), 0)])) }]));
        const pt = points.find((p) => p.room_id === x.id);
        return { title: x.title, mode: x.mode, status: x.status, for: x.ref_type, went_live: c.iso(n(x.went_live_at)), ended: c.iso(n(x.ended_at) || null), peak: n(x.peak), attendees: n(x.attendees), avg_minutes: x.avg_min == null ? null : Math.round(n(x.avg_min)), stayed_30_min: n(x.stayed_30), pushes: funnel, purchases: events.filter((e) => e.room_id === x.id && e.event === 'paid').reduce((a, e) => a + n(e.n), 0), points: pt ? { people: n(pt.people), total: n(pt.points) } : null, link: `/admin#rooms` };
      });
      return { result: { range: r.label, rooms: out, note: 'Attendees are people who joined as attendee or guest; hosts are not counted. Purchases are people with a paid event on a room push.' }, summary: `${out.length} room${out.length === 1 ? '' : 's'} live, ${r.label.toLowerCase()}`, sources: [SOURCES.rooms] };
    }
    case 'deploys': {
      const rows = await listReleases(rt, { limit: Math.max(1, Math.min(20, Number(input.limit) || 5)) });
      const build = deployedBuild(rt.env);
      return { result: { running_build: build, releases: rows.map((x) => ({ build: x.build, deployed: c.iso(x.deployed_at), changes: x.notes })), note: rows.length ? null : 'No deploy notes recorded yet: npm run deploy records them on the next deploy.' }, summary: rows.length ? `${rows.length} deploy${rows.length === 1 ? '' : 's'}, running ${build ?? 'a local build'}` : 'No deploy notes yet', sources: [SOURCES.activity] };
    }
    default:
      return { result: { error: `Unknown tool ${name}` }, summary: 'Unknown tool', sources: [] };
  }
}
