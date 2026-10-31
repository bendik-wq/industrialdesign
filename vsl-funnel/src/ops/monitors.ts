import type { Runtime } from '../app';
import { newId } from '../lib/ids';
import { proposeAction } from './actions';
import { type CampaignRow, type Metric, type MetricKey, type Snapshot, SOURCES, byCampaign, byContent, change, fmt, fmtChange, snapshot } from './metrics';
import { DAY } from './range';
import { postOps } from './slack';

/**
 * Proactive monitors (hourly): the last 24 hours and the last 7 days against the period just before, for the
 * key metrics and for cost per lead / per booked call by campaign. A meaningful drop or spike becomes an alert
 * with the likely cause read from the data (which campaign / ad moved, and whether spend moved with it), a
 * proposed action where one applies, and one Slack message per run. The same alert is not repeated within
 * its window (24 hours for the 24-hour comparison, 7 days for the 7-day one).
 */
export type Window = '24h' | '7d';
export const WINDOWS: Record<Window, { ms: number; label: string }> = { '24h': { ms: DAY, label: 'last 24 hours vs the 24 hours before' }, '7d': { ms: 7 * DAY, label: 'last 7 days vs the 7 days before' } };

export interface Thresholds { dropPct: number; spikePct: number; minCount: number }
export function thresholds(rt: Pick<Runtime, 'settings'>): Thresholds {
  const s = rt.settings as Partial<Record<string, string>>;
  const pos = (v: string | undefined, d: number) => { const n = Number(v); return v && Number.isFinite(n) && n > 0 ? n : d; };
  return { dropPct: pos(s.OPS_ALERT_DROP_PCT, 30) / 100, spikePct: pos(s.OPS_ALERT_SPIKE_PCT, 50) / 100, minCount: pos(s.OPS_ALERT_MIN_COUNT, 5) };
}

/** Count metrics watched for drops and spikes. */
export const WATCHED: MetricKey[] = ['visitors', 'leads', 'applications', 'webinar_regs', 'live_regs', 'challenge_regs', 'tickets', 'bookings', 'deals', 'sprint_sales', 'deposits'];

export interface Finding {
  key: string; metric: string; label: string; window: Window; direction: 'drop' | 'spike'; severity: 'medium' | 'high';
  current: number; prior: number; change: number | null; text: { current: string; prior: string; change: string };
  source: { label: string; href: string }; campaign?: string; costUp?: boolean;
}

const sev = (c: number | null, t: number, zero = false): 'medium' | 'high' => (zero || c == null || Math.abs(c) >= 2 * t ? 'high' : 'medium');

/** Pure: compare two snapshots and return what crosses the thresholds. */
export function evaluate(cur: Snapshot, prior: Snapshot, window: Window, th: Thresholds): Finding[] {
  const out: Finding[] = [];
  const push = (m: Metric, p: Metric, direction: 'drop' | 'spike', extra: Partial<Finding> = {}) => {
    const c = change(m.value, p.value);
    out.push({
      key: `${m.key}:${window}:${direction}`, metric: m.key, label: m.label, window, direction, severity: sev(c, direction === 'drop' ? th.dropPct : th.spikePct, m.value === 0),
      current: m.value ?? 0, prior: p.value ?? 0, change: c, text: { current: fmt(m), prior: fmt(p), change: fmtChange(c) }, source: m.source, ...extra,
    });
  };
  for (const k of WATCHED) {
    const m = cur[k], p = prior[k];
    const a = m.value ?? 0, b = p.value ?? 0;
    const c = change(a, b);
    if (b >= th.minCount && c != null && c <= -th.dropPct) push(m, p, 'drop');
    else if (a >= th.minCount && (b === 0 || (c != null && c >= th.spikePct))) push(m, p, 'spike');
  }
  // Show rate: only with enough calls on both sides.
  const sr = cur.show_rate, srp = prior.show_rate;
  if ((sr.den ?? 0) >= th.minCount && (srp.den ?? 0) >= th.minCount && sr.value != null && srp.value != null) {
    const c = change(sr.value, srp.value);
    if (c != null && c <= -th.dropPct) push(sr, srp, 'drop');
    else if (c != null && c >= th.spikePct) push(sr, srp, 'spike');
  }
  // Cost per lead / per booked call: a rise is the bad news.
  for (const k of ['cpl', 'cpa'] as const) {
    const m = cur[k], p = prior[k];
    if ((m.den ?? 0) >= th.minCount && (p.den ?? 0) >= th.minCount && m.value != null && p.value != null) {
      const c = change(m.value, p.value);
      if (c != null && c >= th.spikePct) push(m, p, 'spike', { costUp: true });
    }
  }
  return out;
}

/** Pure: per-campaign cost per lead / booked call rises, and campaigns that spent with nothing to show. */
export function evaluateCampaigns(cur: CampaignRow[], prior: CampaignRow[], window: Window, th: Thresholds): Finding[] {
  const out: Finding[] = [];
  const pmap = new Map(prior.map((p) => [p.campaign, p]));
  const money = (v: number | null, cur?: string | null) => fmt({ value: v, kind: 'cost', currency: cur ?? 'USD' });
  for (const c of cur) {
    const p = pmap.get(c.campaign);
    if (!p || c.spend <= 0 || p.spend <= 0) continue;
    for (const k of ['cpl', 'cpa'] as const) {
      const den = k === 'cpl' ? ['leads', c.leads, p.leads] as const : ['bookings', c.bookings, p.bookings] as const;
      if (den[2] < th.minCount) continue;
      const label = k === 'cpl' ? 'Cost per lead' : 'Cost per booked call';
      const nowVal = den[1] > 0 ? c[k] : null;
      const ch = nowVal == null ? null : change(nowVal, p[k]);
      if (nowVal == null || (ch != null && ch >= th.spikePct)) {
        out.push({
          key: `${k}:${c.campaign}:${window}:spike`, metric: k, label: `${label}, campaign ${c.campaign}`, window, direction: 'spike', severity: sev(ch, th.spikePct, nowVal == null),
          current: nowVal ?? c.spend, prior: p[k] ?? 0, change: ch,
          text: { current: nowVal == null ? `${money(c.spend, c.currency)} spent, no ${den[0]}` : money(nowVal, c.currency), prior: money(p[k], p.currency), change: nowVal == null ? `no ${den[0]}` : fmtChange(ch) },
          source: SOURCES.traffic, campaign: c.campaign, costUp: true,
        });
      }
    }
  }
  return out;
}

/** Pure: has this alert key fired within its window? */
export const isDebounced = (lastAt: number | null | undefined, now: number, window: Window) => lastAt != null && now - lastAt < WINDOWS[window].ms;

/** Which campaign / ad moved most in the direction of the change, for a count metric. Pure over the breakdowns. */
export function topMover<T extends object>(cur: T[], prior: T[], idKey: keyof T, field: keyof T, direction: 'drop' | 'spike') {
  const ids = new Set([...cur.map((r) => String(r[idKey])), ...prior.map((r) => String(r[idKey]))]);
  const get = (rows: T[], id: string) => Number(rows.find((r) => String(r[idKey]) === id)?.[field] ?? 0);
  let best: { id: string; now: number; before: number; delta: number } | null = null;
  for (const id of ids) {
    const now = get(cur, id), before = get(prior, id), delta = now - before;
    if (direction === 'drop' ? delta < 0 : delta > 0) if (!best || Math.abs(delta) > Math.abs(best.delta)) best = { id, now, before, delta };
  }
  return best;
}

const FIELD: Partial<Record<string, keyof CampaignRow>> = { visitors: 'visitors', leads: 'leads', applications: 'leads', webinar_regs: 'leads', live_regs: 'leads', challenge_regs: 'leads', tickets: 'leads', bookings: 'bookings', deals: 'bookings' };

export interface Explained { cause: string | null; action: null | { dept: 'marketing' | 'sales'; kind: string; summary: string; detail: string; payload: Record<string, unknown>; risk: 'low' | 'medium' | 'high' } }

/** The likely cause from the data, and the action to propose when one applies. */
export async function explain(rt: Runtime, f: Finding, cur: { from: number; to: number }, prior: { from: number; to: number }, th: Thresholds): Promise<Explained> {
  const money = (v: number, c: string | null) => fmt({ value: v, kind: 'money', currency: c ?? 'USD' });
  if (f.campaign) {
    const rows = await byCampaign(rt, cur);
    const r = rows.find((x) => x.campaign === f.campaign);
    return {
      cause: r ? `Campaign "${f.campaign}" spent ${money(r.spend, r.currency)} for ${r.leads} sign-ups and ${r.bookings} booked calls in the ${f.window === '24h' ? 'last 24 hours' : 'last 7 days'}.` : null,
      action: { dept: 'marketing', kind: 'marketing.pause_campaign', summary: `Pause campaign "${f.campaign}" (${f.label.split(',')[0].toLowerCase()} ${f.text.prior} → ${f.text.current})`, detail: `Raised by the hourly monitor. Approving pauses the campaign through the Marketing department; without its handler it is marked for you to pause in Ads Manager.`, payload: { campaign: f.campaign, reason: f.key }, risk: 'high' },
    };
  }
  const field = FIELD[f.metric];
  if (field) {
    const [a, b] = await Promise.all([byCampaign(rt, cur), byCampaign(rt, prior)]);
    const mv = topMover(a, b, 'campaign', field, f.direction);
    if (!mv) return { cause: null, action: null };
    const total = f.current - f.prior;
    const share = total !== 0 ? Math.round((mv.delta / total) * 100) : null;
    const sa = a.find((x) => x.campaign === mv.id), sb = b.find((x) => x.campaign === mv.id);
    const word = field === 'bookings' ? 'booked calls' : field === 'visitors' ? 'visitors' : 'sign-ups';
    let cause = `Biggest mover: campaign "${mv.id}", ${word} ${mv.before} → ${mv.now}${share != null && share > 0 && share <= 100 ? ` (${share}% of the change)` : ''}.`;
    let action: Explained['action'] = null;
    const spendA = sa?.spend ?? 0, spendB = sb?.spend ?? 0;
    if (mv.before < th.minCount && mv.now < th.minCount) cause += " The change is spread thin: no single campaign moved by much.";
    else if (spendA > 0 || spendB > 0) {
      const spendCh = change(spendA, spendB);
      cause += ` Spend there: ${money(spendB, sb?.currency ?? sa?.currency ?? null)} → ${money(spendA, sa?.currency ?? sb?.currency ?? null)}.`;
      if (f.direction === 'drop' && spendCh != null && Math.abs(spendCh) < 0.2) {
        // Same money, fewer results: look for the ad / angle that fell.
        const [ca, cb] = await Promise.all([byContent(rt, cur, mv.id), byContent(rt, prior, mv.id)]);
        const ad = topMover(ca, cb, 'content', field === 'bookings' ? 'bookings' : 'leads', 'drop');
        cause += ' Spend held steady while results fell, which points at ad fatigue.';
        if (ad && ad.before >= th.minCount) {
          cause += ` The ad "${ad.id}" went from ${ad.before} to ${ad.now} ${field === 'bookings' ? 'booked calls' : 'sign-ups'}.`;
          action = { dept: 'marketing', kind: 'marketing.pause_ad', summary: `Pause the ad "${ad.id}" in campaign "${mv.id}" (${ad.before} → ${ad.now} ${field === 'bookings' ? 'booked calls' : 'sign-ups'})`, detail: `Raised by the hourly monitor (${f.label}, ${WINDOWS[f.window].label}: ${f.text.prior} → ${f.text.current}). Spend on the campaign held steady.`, payload: { campaign: mv.id, ad: ad.id, reason: f.key }, risk: 'high' };
        }
      } else if (f.direction === 'drop' && spendCh != null && spendCh <= -0.2) {
        cause += ' Spend fell too, so fewer people saw the ads.';
      }
    }
    return { cause, action };
  }
  if (f.metric === 'show_rate' && f.direction === 'drop') {
    try {
      const { results } = await rt.env.DB.prepare("SELECT COALESCE(closer_id, 'unassigned') AS closer, SUM(status = 'no_show') AS n FROM leads WHERE booked_at IS NOT NULL AND booking_cancelled_at IS NULL AND call_at BETWEEN ? AND ? GROUP BY 1 HAVING n > 0 ORDER BY 2 DESC LIMIT 3").bind(cur.from, cur.to).all<{ closer: string; n: number }>();
      const names = new Map(rt.reps.map((r) => [r.id, r.name]));
      if (results.length) return { cause: `No-shows by closer: ${results.map((r) => `${names.get(r.closer) ?? r.closer} ${r.n}`).join(', ')}.`, action: null };
    } catch { /* no cause */ }
  }
  return { cause: null, action: null };
}

export function alertTitle(f: Finding) {
  const verb = f.costUp ? 'up' : f.direction === 'drop' ? 'down' : 'up';
  return `${f.label} ${verb} ${f.change == null ? '' : `${Math.abs(Math.round(f.change * 100))}% `}(${f.window === '24h' ? '24 hours' : '7 days'})`.replace(/\s+\(/, ' (');
}

/** Run the monitors once (claims the hour, so overlapping crons run it once). */
export async function runMonitors(rt: Runtime, now = Date.now(), o: { force?: boolean } = {}) {
  const s = rt.settings as Partial<Record<string, string>>;
  if (/^(off|false|0|no)$/i.test((s.OPS_MONITORS ?? '').trim())) return { ran: false, alerts: 0 };
  if (!o.force) {
    const hour = new Date(now).toISOString().slice(0, 13);
    const claim = await rt.env.DB.prepare('INSERT OR IGNORE INTO kv_state (key, value) VALUES (?, ?)').bind(`ops:monitor:${hour}`, String(now)).run();
    if (!claim.meta.changes) return { ran: false, alerts: 0 };
  }
  const th = thresholds(rt);
  const created: { id: string; title: string; line: string }[] = [];
  for (const w of ['24h', '7d'] as Window[]) {
    const cur = { from: now - WINDOWS[w].ms, to: now };
    const prior = { from: now - 2 * WINDOWS[w].ms, to: now - WINDOWS[w].ms - 1 };
    const [a, b, ca, cb] = await Promise.all([snapshot(rt, cur), snapshot(rt, prior), byCampaign(rt, cur), byCampaign(rt, prior)]);
    const findings = [...evaluate(a, b, w, th), ...evaluateCampaigns(ca, cb, w, th)];
    for (const f of findings) {
      const last = await rt.env.DB.prepare('SELECT MAX(created_at) AS t FROM ops_alerts WHERE key = ?').bind(f.key).first<{ t: number | null }>();
      if (isDebounced(last?.t, now, w)) continue;
      const id = newId('al_');
      const ex = await explain(rt, f, cur, prior, th).catch((e) => { console.error('ops explain', e); return { cause: null, action: null } as Explained; });
      const title = alertTitle(f);
      const body = [
        `**${f.label}**: ${f.text.prior} → ${f.text.current} (${f.text.change}), ${WINDOWS[w].label}. Source: [${f.source.label}](${f.source.href}).`,
        ex.cause ? `Likely cause: ${ex.cause}` : 'No single campaign or ad explains it in our data.',
      ];
      let actionId: string | null = null;
      if (ex.action) {
        actionId = await proposeAction(rt, { ...ex.action, source: `monitor:${id}` }, now);
        body.push(`Proposed: ${ex.action.summary}. Approve, edit or reject it in [Command → Approvals](/admin#command/approvals).`);
      }
      await rt.env.DB.prepare('INSERT INTO ops_alerts (id, key, metric, span, direction, severity, title, body, current, prior, action_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, f.key, f.metric, w, f.direction, f.severity, title, body.join('\n'), f.current, f.prior, actionId, now).run();
      created.push({ id, title, line: body.join(' ') });
    }
  }
  if (created.length) {
    const sent = await postOps(rt, { title: created.length === 1 ? `Alert: ${created[0].title}` : `${created.length} alerts from the hourly check`, lines: created.map((c) => (created.length === 1 ? c.line : `• ${c.title}. ${c.line}`)), path: '/admin#command/approvals', linkText: 'Review and approve in Funnel HQ' });
    if (sent.slack || sent.discord) await rt.env.DB.prepare(`UPDATE ops_alerts SET sent_at = ? WHERE id IN (${created.map(() => '?').join(',')})`).bind(now, ...created.map((c) => c.id)).run();
  }
  return { ran: true, alerts: created.length };
}
