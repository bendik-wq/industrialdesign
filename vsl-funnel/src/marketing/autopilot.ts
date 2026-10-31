/**
 * Marketing department: the ads autopilot.
 *
 * Every hour (cron) it reads Meta at ad level (src/integrations/meta-ads.ts → ad_insights, ad_entities), joins each
 * ad to what its traffic did in our own data (leads, revenue-band events, tickets, bookings, deposits, deals,
 * matched on utm_content = the ad id or ad name), and runs three rules:
 *
 *  - fatigue: frequency rising and link CTR falling against the ad's first three days with spend, or cost per lead
 *    drifting above target while CTR falls → propose pausing the ad;
 *  - loser: spent at least ADS_LOSER_SPEND with no qualified result ($1M+ band lead, ticket, booking, deposit), or
 *    a cost per ticket far above target → propose pausing it, and move budget from its ad set to a winner's;
 *  - winner: cost per ticket / deposit / booking below target with at least ADS_WINNER_MIN_RESULTS results →
 *    propose duplicating it (paused copy) and moving budget to its ad set.
 *
 * Nothing changes on Meta without approval (or the owner setting that kind to auto). Every number in a proposal
 * comes from the rows above and is shown with where it came from.
 */
import type { Runtime } from '../app';
import { flag } from '../settings';
import { isMillionPlus } from '../sales/qualify';
import { type Risk, logAction, proposeAction, registerActionHandler } from '../ops/actions';
import { duplicateMetaAd, metaAdsConfigured, metaWriteConfigured, pauseMetaAd, setMetaDailyBudget, syncAdLevel } from '../integrations/meta-ads';
import { newId } from '../lib/ids';

const DAY = 86_400_000;
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);
const div = (a: number, b: number) => (b > 0 ? a / b : null);
const round2 = (n: number) => Math.round(n * 100) / 100;

// ───────────── settings ─────────────

export interface Targets {
  cpl: number | null; ticket: number | null; deposit: number | null; booking: number | null;
  loserSpend: number; maxShiftPct: number; maxDailyBudget: number | null;
  fatigueFreq: number; fatigueCtrDrop: number; winnerMin: number;
}
const pos = (v: string | undefined) => { const n = Number(String(v ?? '').replace(/[^\d.]/g, '')); return String(v ?? '').trim() && Number.isFinite(n) && n > 0 ? n : null; };

export function adsTargets(s: Partial<Record<string, string>>): Targets {
  const ticket = pos(s.ADS_TARGET_CPA_TICKET);
  return {
    cpl: pos(s.ADS_TARGET_CPL),
    ticket,
    deposit: pos(s.ADS_TARGET_CPA_DEPOSIT),
    booking: pos(s.ADS_TARGET_CPA_BOOKING),
    loserSpend: pos(s.ADS_LOSER_SPEND) ?? (ticket ? ticket * 2 : 300),
    maxShiftPct: Math.min(100, pos(s.ADS_MAX_DAILY_SHIFT_PCT) ?? 20),
    maxDailyBudget: pos(s.ADS_MAX_DAILY_BUDGET),
    fatigueFreq: pos(s.ADS_FATIGUE_FREQUENCY) ?? 2.5,
    fatigueCtrDrop: Math.min(95, pos(s.ADS_FATIGUE_CTR_DROP_PCT) ?? 30),
    winnerMin: Math.max(1, Math.round(pos(s.ADS_WINNER_MIN_RESULTS) ?? 3)),
  };
}
export const autopilotOn = (s: Partial<Record<string, string>>) => flag(s.ADS_AUTOPILOT, true);

// ───────────── the data per ad ─────────────

export interface DayRow { day: string; spend: number; impressions: number; reach: number; frequency: number | null; link_clicks: number }
export interface Results { leads: number; qualified: number; under1m: number; tickets: number; deposits: number; bookings: number; deals: number; revenue: number; leadDays: string[] }
export interface AdStat {
  ad_id: string; name: string; adset_id: string | null; campaign_id: string | null; status: string | null; created_time: number | null; currency: string | null;
  days: DayRow[];              // every stored day, oldest first
  spend: number; impressions: number; link_clicks: number; ctr: number | null; cpc: number | null; frequency: number | null; // the window
  results: Results;
}
const emptyResults = (): Results => ({ leads: 0, qualified: 0, under1m: 0, tickets: 0, deposits: 0, bookings: 0, deals: 0, revenue: 0, leadDays: [] });

/** Link CTR (%) of some days, impressions-weighted. */
export const ctrOf = (days: DayRow[]) => div(days.reduce((a, d) => a + d.link_clicks, 0) * 100, days.reduce((a, d) => a + d.impressions, 0));
/** Frequency of some days: impressions over reach summed per day (Meta's per-day frequency, averaged by reach). */
export const freqOf = (days: DayRow[]) => {
  const r = days.reduce((a, d) => a + (d.reach || (d.frequency ? d.impressions / d.frequency : 0)), 0);
  return div(days.reduce((a, d) => a + d.impressions, 0), r);
};

/** Loads every ad with spend in the last `windowDays`, its stored history and its results from our own data. */
export async function loadAdStats(rt: Runtime, windowDays = 14, now = Date.now()): Promise<AdStat[]> {
  const db = rt.env.DB;
  const since = ymd(now - (windowDays - 1) * DAY);
  const histFrom = ymd(now - 90 * DAY);
  const leadFrom = now - 90 * DAY;
  const [ins, ents, leads, bandEvents, passes, orders] = await Promise.all([
    db.prepare(`SELECT ad_id, day, adset_id, campaign_id, ad_name, spend, impressions, reach, frequency, link_clicks, currency FROM ad_insights
                 WHERE day >= ? AND ad_id IN (SELECT DISTINCT ad_id FROM ad_insights WHERE day >= ? AND spend > 0) ORDER BY ad_id, day`).bind(histFrom, since)
      .all<{ ad_id: string; day: string; adset_id: string | null; campaign_id: string | null; ad_name: string | null; spend: number; impressions: number; reach: number; frequency: number | null; link_clicks: number; currency: string | null }>(),
    db.prepare("SELECT id, name, status, effective_status, adset_id, campaign_id, created_time FROM ad_entities WHERE level = 'ad'")
      .all<{ id: string; name: string | null; status: string | null; effective_status: string | null; adset_id: string | null; campaign_id: string | null; created_time: number | null }>(),
    db.prepare(`SELECT id, lower(ft_content) AS ft, lower(utm_content) AS utm, created_at, revenue_band, booked_at, status, revenue FROM leads
                 WHERE (utm_content IS NOT NULL OR ft_content IS NOT NULL) AND created_at >= ?`).bind(leadFrom)
      .all<{ id: string; ft: string | null; utm: string | null; created_at: number; revenue_band: string | null; booked_at: number | null; status: string; revenue: number }>(),
    db.prepare(`SELECT e.lead_id, json_extract(e.props, '$.band') AS band FROM events e JOIN leads l ON l.id = e.lead_id
                 WHERE e.name = 'revenue_band' AND (l.utm_content IS NOT NULL OR l.ft_content IS NOT NULL) AND l.created_at >= ? ORDER BY e.ts`).bind(leadFrom)
      .all<{ lead_id: string; band: string | null }>(),
    db.prepare(`SELECT p.lead_id, p.kind FROM webinar_passes p JOIN leads l ON l.id = p.lead_id
                 WHERE p.status = 'paid' AND p.kind IN ('seat', 'live_ticket', 'deposit') AND (l.utm_content IS NOT NULL OR l.ft_content IS NOT NULL) AND l.created_at >= ?`).bind(leadFrom)
      .all<{ lead_id: string; kind: string }>(),
    db.prepare(`SELECT o.lead_id FROM challenge_orders o JOIN leads l ON l.id = o.lead_id
                 WHERE o.status = 'paid' AND o.kind = 'ticket' AND (l.utm_content IS NOT NULL OR l.ft_content IS NOT NULL) AND l.created_at >= ?`).bind(leadFrom)
      .all<{ lead_id: string }>(),
  ]);

  const entMap = new Map(ents.results.map((e) => [e.id, e]));
  const byAd = new Map<string, AdStat>();
  for (const r of ins.results) {
    let a = byAd.get(r.ad_id);
    if (!a) {
      const e = entMap.get(r.ad_id);
      a = { ad_id: r.ad_id, name: e?.name || r.ad_name || r.ad_id, adset_id: e?.adset_id ?? r.adset_id, campaign_id: e?.campaign_id ?? r.campaign_id, status: e?.effective_status ?? e?.status ?? null,
        created_time: e?.created_time ?? null, currency: r.currency, days: [], spend: 0, impressions: 0, link_clicks: 0, ctr: null, cpc: null, frequency: null, results: emptyResults() };
      byAd.set(r.ad_id, a);
    }
    a.days.push({ day: r.day, spend: r.spend ?? 0, impressions: r.impressions ?? 0, reach: r.reach ?? 0, frequency: r.frequency, link_clicks: r.link_clicks ?? 0 });
  }
  // Our results per ad: a lead belongs to the ad its first touch came from (else its latest touch), matched on id or name.
  const keyToAd = new Map<string, string>();
  for (const a of byAd.values()) { keyToAd.set(a.ad_id.toLowerCase(), a.ad_id); if (a.name) keyToAd.set(a.name.trim().toLowerCase(), a.ad_id); }
  const band = new Map<string, string>();
  for (const b of bandEvents.results) if (b.band) band.set(b.lead_id, b.band);
  const leadAd = new Map<string, string>();
  for (const l of leads.results) {
    const ad = (l.ft && keyToAd.get(l.ft.trim())) || (l.utm && keyToAd.get(l.utm.trim()));
    if (!ad) continue;
    leadAd.set(l.id, ad);
    const r = byAd.get(ad)!.results;
    r.leads++;
    r.leadDays.push(ymd(l.created_at));
    const b = l.revenue_band ?? band.get(l.id) ?? null;
    if (b) { if (isMillionPlus(b)) r.qualified++; else r.under1m++; }
    if (l.booked_at) r.bookings++;
    if (l.status === 'won') { r.deals++; r.revenue += l.revenue ?? 0; }
  }
  for (const p of passes.results) { const ad = leadAd.get(p.lead_id); if (!ad) continue; const r = byAd.get(ad)!.results; if (p.kind === 'deposit') r.deposits++; else r.tickets++; }
  for (const o of orders.results) { const ad = leadAd.get(o.lead_id); if (ad) byAd.get(ad)!.results.tickets++; }

  for (const a of byAd.values()) {
    const win = a.days.filter((d) => d.day >= since);
    a.spend = round2(win.reduce((s, d) => s + d.spend, 0));
    a.impressions = win.reduce((s, d) => s + d.impressions, 0);
    a.link_clicks = win.reduce((s, d) => s + d.link_clicks, 0);
    a.ctr = ctrOf(win);
    a.cpc = div(a.spend, a.link_clicks);
    a.frequency = freqOf(win.slice(-3));
  }
  return [...byAd.values()].sort((x, y) => y.spend - x.spend);
}

// ───────────── the rules (pure, so they're tested on fixtures) ─────────────

export interface Verdict { rule: 'fatigue' | 'loser' | 'winner'; reasons: string[]; numbers: Record<string, number | null> }
const money = (n: number | null, cur: string | null) => (n == null ? 'n/a' : `${cur ? `${cur} ` : ''}${n.toFixed(n >= 100 ? 0 : 2)}`);
const pct = (n: number | null) => (n == null ? 'n/a' : `${n.toFixed(2)}%`);

/** Fatigue: needs six days with spend (three to set the baseline, three recent). */
export function fatigue(a: AdStat, t: Targets): Verdict | null {
  const spent = a.days.filter((d) => d.spend > 0 && d.impressions > 0);
  if (spent.length < 6) return null;
  const base = spent.slice(0, 3), recent = spent.slice(-3);
  const baseCtr = ctrOf(base), recentCtr = ctrOf(recent);
  const baseFreq = freqOf(base), recentFreq = freqOf(recent);
  if (baseCtr == null || recentCtr == null || baseCtr <= 0) return null;
  const drop = ((baseCtr - recentCtr) / baseCtr) * 100;
  const ctrFalling = drop >= t.fatigueCtrDrop;
  const freqRising = recentFreq != null && baseFreq != null && recentFreq > baseFreq && recentFreq >= t.fatigueFreq;
  const recentDays = new Set(recent.map((d) => d.day));
  const recentSpend = recent.reduce((s, d) => s + d.spend, 0);
  const recentLeads = a.results.leadDays.filter((d) => recentDays.has(d)).length;
  const recentCpl = div(recentSpend, recentLeads);
  const cplDrift = t.cpl != null && recentSpend >= t.cpl && (recentCpl == null || recentCpl > t.cpl * 1.3);
  if (!ctrFalling || (!freqRising && !cplDrift)) return null;
  const reasons = [`Link CTR ${pct(recentCtr)} over the last 3 days with spend, down ${drop.toFixed(0)}% from ${pct(baseCtr)} in its first 3 days.`];
  if (freqRising) reasons.push(`Frequency ${recentFreq!.toFixed(2)}, up from ${baseFreq!.toFixed(2)} (fatigue line ${t.fatigueFreq}).`);
  if (cplDrift) reasons.push(recentCpl == null ? `${money(recentSpend, a.currency)} spent in those 3 days with no leads (target cost per lead ${money(t.cpl, a.currency)}).` : `Cost per lead ${money(recentCpl, a.currency)} in those 3 days, above the ${money(t.cpl, a.currency)} target.`);
  return { rule: 'fatigue', reasons, numbers: { baseCtr, recentCtr, ctrDropPct: round2(drop), baseFreq, recentFreq, recentCpl } };
}

const strong = (r: Results) => r.tickets + r.deposits + r.bookings;

/** Loser: enough spend and nothing down the funnel worth paying for. */
export function loser(a: AdStat, t: Targets): Verdict | null {
  if (a.spend < t.loserSpend) return null;
  const r = a.results;
  const qualifiedAny = r.qualified + strong(r);
  if (qualifiedAny === 0) {
    const band = r.leads ? ` ${r.leads} lead${r.leads === 1 ? '' : 's'}, ${r.under1m} under $1M revenue, none at $1M+.` : ' No leads.';
    return { rule: 'loser', reasons: [`${money(a.spend, a.currency)} spent in 14 days with no ticket, booking, deposit or $1M+ lead.${band}`], numbers: { spend: a.spend, leads: r.leads, under1m: r.under1m, qualified: 0 } };
  }
  const cpt = div(a.spend, r.tickets);
  if (t.ticket != null && r.deposits === 0 && r.bookings === 0 && a.spend >= t.loserSpend * 2 && (cpt == null || cpt > t.ticket * 2.5)) {
    return { rule: 'loser', reasons: [`Cost per ticket ${money(cpt, a.currency)} on ${money(a.spend, a.currency)} spend, more than 2.5 times the ${money(t.ticket, a.currency)} target, with no booking or deposit.`], numbers: { spend: a.spend, tickets: r.tickets, cpaTicket: cpt } };
  }
  return null;
}

/** Winner: below target on tickets, deposits or bookings, with volume. */
export function winner(a: AdStat, t: Targets): Verdict | null {
  const r = a.results;
  if (strong(r) < t.winnerMin) return null;
  const checks: [string, number, number | null][] = [['deposit', r.deposits, t.deposit], ['ticket', r.tickets, t.ticket], ['booked call', r.bookings, t.booking]];
  const below = checks.filter(([, n, target]) => target != null && n > 0 && a.spend / n <= target);
  if (!below.length) return null;
  const reasons = below.map(([label, n, target]) => `Cost per ${label} ${money(a.spend / n, a.currency)} on ${n} result${n === 1 ? '' : 's'}, under the ${money(target, a.currency)} target.`);
  return { rule: 'winner', reasons, numbers: { spend: a.spend, tickets: r.tickets, deposits: r.deposits, bookings: r.bookings } };
}

export function verdicts(a: AdStat, t: Targets): Verdict[] {
  const w = winner(a, t);
  if (w) return [w];
  return [loser(a, t), fatigue(a, t)].filter((v): v is Verdict => Boolean(v));
}

/**
 * A budget move between two ad sets, bounded: neither side moves more than maxShiftPct of its daily budget in one
 * day (counting moves already made today), the giver keeps at least 1 unit, and the receiver stays under the cap.
 * Budgets in the account's smallest currency unit.
 */
export function boundShift(o: { fromBudget: number; toBudget: number; requested?: number; maxPct: number; cap?: number | null; usedFrom?: number; usedTo?: number }) {
  const limitFrom = Math.floor((o.fromBudget * o.maxPct) / 100) - (o.usedFrom ?? 0);
  const limitTo = Math.floor((o.toBudget * o.maxPct) / 100) - (o.usedTo ?? 0);
  const capRoom = o.cap != null ? Math.floor(o.cap) - o.toBudget : Infinity;
  const keep = o.fromBudget - 100;
  const amount = Math.max(0, Math.min(o.requested ?? Infinity, limitFrom, limitTo, capRoom, keep));
  return { amount, fromAfter: o.fromBudget - amount, toAfter: o.toBudget + amount };
}

// ───────────── proposals ─────────────

const DEDUPE_MS = 3 * DAY;
async function seen(rt: Runtime, key: string, now: number) {
  const r = await rt.env.DB.prepare('SELECT created_at FROM ads_autopilot_log WHERE key = ?').bind(key).first<{ created_at: number }>();
  return Boolean(r && now - r.created_at < DEDUPE_MS);
}
async function remember(rt: Runtime, key: string, rule: string, target: string, actionId: string, reason: string, now: number) {
  await rt.env.DB.prepare(`INSERT INTO ads_autopilot_log (key, action_id, rule, target_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET action_id = excluded.action_id, reason = excluded.reason, created_at = excluded.created_at`).bind(key, actionId, rule, target, reason.slice(0, 500), now).run();
}

const manualSteps = {
  pause: (a: { name: string; ad_id: string }) => `Apply manually: Ads Manager → Ads → search "${a.name}" (id ${a.ad_id}) → switch it off.`,
  duplicate: (a: { name: string; ad_id: string }) => `Apply manually: Ads Manager → Ads → "${a.name}" (id ${a.ad_id}) → Duplicate → keep it paused, review, then publish.`,
  shift: (from: string, to: string, amt: string) => `Apply manually: Ads Manager → Ad sets → lower "${from}" daily budget by ${amt}, raise "${to}" by ${amt}.`,
};
const source = 'Source: Funnel HQ → Ads autopilot (Meta insights per ad, joined to our leads, revenue-band events, tickets, bookings and deposits by utm_content).';

interface AdsetRow { id: string; name: string | null; daily_budget: number | null; effective_status: string | null }

/** One pass of the rules: proposals for what changed since the last pass (deduped for three days). */
export async function runAutopilot(rt: Runtime, now = Date.now()) {
  const t = adsTargets(rt.settings as unknown as Record<string, string>);
  const stats = await loadAdStats(rt, 14, now);
  const write = metaWriteConfigured(rt);
  const out = { ads: stats.length, proposed: [] as string[], skipped: 0 };
  const active = (a: AdStat) => !a.status || /ACTIVE/i.test(a.status);
  const winners: AdStat[] = [], losers: AdStat[] = [];

  for (const a of stats) {
    for (const v of verdicts(a, t)) {
      if (v.rule === 'winner') winners.push(a); else if (v.rule === 'loser') losers.push(a);
      if (!active(a)) continue;
      const kind = v.rule === 'winner' ? 'marketing.duplicate_ad' : 'marketing.pause_ad';
      const key = `${v.rule}:${a.ad_id}`;
      if (await seen(rt, key, now)) { out.skipped++; continue; }
      const verb = v.rule === 'winner' ? 'Duplicate winning ad' : v.rule === 'fatigue' ? 'Pause fatigued ad' : 'Pause losing ad';
      const detail = [...v.reasons, '', write ? 'On approval Funnel HQ makes this change on Meta.' : (v.rule === 'winner' ? manualSteps.duplicate(a) : manualSteps.pause(a)), source].join('\n');
      const risk: Risk = v.rule === 'winner' ? 'low' : 'medium';
      const id = await proposeAction(rt, { dept: 'marketing', kind, summary: `${verb}: ${a.name}`, detail, risk,
        payload: { ad_id: a.ad_id, ad_name: a.name, adset_id: a.adset_id, rule: v.rule, reasons: v.reasons, numbers: v.numbers } });
      await remember(rt, key, v.rule, a.ad_id, id, v.reasons[0], now);
      out.proposed.push(id);
    }
  }

  // Budget: from the ad set with the most loser spend to the ad set of the best winner (ad-set budgets only, not CBO).
  if (winners.length && losers.length) {
    const { results: adsets } = await rt.env.DB.prepare("SELECT id, name, daily_budget, effective_status FROM ad_entities WHERE level = 'adset'").all<AdsetRow>();
    const sets = new Map(adsets.map((s) => [s.id, s]));
    const loserSpend = new Map<string, number>();
    for (const a of losers) if (a.adset_id) loserSpend.set(a.adset_id, (loserSpend.get(a.adset_id) ?? 0) + a.spend);
    const winnerSets = new Set(winners.map((w) => w.adset_id).filter(Boolean) as string[]);
    const from = [...loserSpend.entries()].filter(([id]) => !winnerSets.has(id) && sets.get(id)?.daily_budget).sort((x, y) => y[1] - x[1])[0]?.[0];
    const best = [...winners].sort((x, y) => (div(x.spend, strong(x.results)) ?? Infinity) - (div(y.spend, strong(y.results)) ?? Infinity));
    const to = best.map((w) => w.adset_id).find((id) => id && id !== from && sets.get(id)?.daily_budget);
    if (from && to) {
      const key = `shift:${from}>${to}`;
      const f = sets.get(from)!, g = sets.get(to)!;
      const used = await shiftedToday(rt, [from, to], now);
      const b = boundShift({ fromBudget: f.daily_budget!, toBudget: g.daily_budget!, maxPct: t.maxShiftPct, cap: t.maxDailyBudget != null ? t.maxDailyBudget * 100 : null, usedFrom: used.get(from), usedTo: used.get(to) });
      if (b.amount >= 100 && !(await seen(rt, key, now))) {
        const cur = stats[0]?.currency ?? null;
        const amt = money(b.amount / 100, cur);
        const fromName = f.name || from, toName = g.name || to;
        const detail = [
          `Ad set "${fromName}" holds the losing ads (${money(loserSpend.get(from)!, cur)} spent in 14 days without a qualified result); "${toName}" holds ${best[0].name}.`,
          `Daily budgets ${money(f.daily_budget! / 100, cur)} → ${money(b.fromAfter / 100, cur)} and ${money(g.daily_budget! / 100, cur)} → ${money(b.toAfter / 100, cur)} (at most ${t.maxShiftPct}% of either budget per day${t.maxDailyBudget ? `, cap ${money(t.maxDailyBudget, cur)}` : ''}).`,
          '', write ? 'On approval Funnel HQ changes both budgets on Meta.' : manualSteps.shift(fromName, toName, amt), source,
        ].join('\n');
        const id = await proposeAction(rt, { dept: 'marketing', kind: 'marketing.shift_budget', summary: `Move ${amt}/day from "${fromName}" to "${toName}"`, detail, risk: 'high',
          payload: { from_adset: from, to_adset: to, from_name: fromName, to_name: toName, amount: b.amount, from_before: f.daily_budget, to_before: g.daily_budget, currency: cur } });
        await remember(rt, key, 'shift', `${from}>${to}`, id, detail.split('\n')[0], now);
        out.proposed.push(id);
      }
    }
  }
  return out;
}

/** Budget already moved today per ad set (absolute), for the daily bound. */
async function shiftedToday(rt: Runtime, ids: string[], now: number) {
  const { results } = await rt.env.DB.prepare(`SELECT adset_id, SUM(ABS(delta)) AS n FROM ads_budget_shifts WHERE day = ? AND adset_id IN (${ids.map(() => '?').join(',')}) GROUP BY 1`)
    .bind(ymd(now), ...ids).all<{ adset_id: string; n: number }>();
  return new Map(results.map((r) => [r.adset_id, r.n]));
}
/** Each ad set's daily budget before today's first shift: the percentage is of that, not of an already-moved budget. */
async function budgetAtStartOfDay(rt: Runtime, id: string, current: number, now: number) {
  const r = await rt.env.DB.prepare('SELECT before_amt FROM ads_budget_shifts WHERE day = ? AND adset_id = ? ORDER BY created_at, rowid LIMIT 1').bind(ymd(now), id).first<{ before_amt: number | null }>();
  return r?.before_amt ?? current;
}

/** Cron (every 5 min): at most once an hour, read Meta at ad level, then run the rules. */
export async function maybeRunAutopilot(rt: Runtime) {
  if (!metaAdsConfigured(rt)) return null;
  const db = rt.env.DB;
  const last = await db.prepare("SELECT value FROM settings WHERE key = '_ads_autopilot_at'").first<{ value: string }>().catch(() => null);
  if (last && Date.now() - Number(last.value) < 3600_000) return null;
  await db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('_ads_autopilot_at', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(String(Date.now()), Date.now()).run();
  const synced = await syncAdLevel(rt, 7);
  const run = autopilotOn(rt.settings as unknown as Record<string, string>) ? await runAutopilot(rt) : null;
  return { synced, run };
}

// ───────────── handlers (run on approval, or straight away when the kind is set to auto) ─────────────

type P = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const noWrite = (steps: string) => ({ ok: false, summary: `Not sent to Meta: no write token (ads_management) is connected. ${steps}` });
const manualOk = (p: P) => p.manual_ack === true;

registerActionHandler('marketing.pause_ad', async (rt, raw) => {
  const p = (raw ?? {}) as Record<string, unknown>;
  const ad = { ad_id: str(p.ad_id), name: str(p.ad_name) || str(p.ad_id) };
  if (!/^\d{1,30}$/.test(ad.ad_id)) return { ok: false, summary: 'No valid ad id in the proposal.' };
  if (!metaWriteConfigured(rt)) return manualOk(p) ? { ok: true, summary: `Marked as paused by hand in Ads Manager: ${ad.name}.` } : noWrite(manualSteps.pause(ad));
  await pauseMetaAd(rt, ad.ad_id);
  await rt.env.DB.prepare("UPDATE ad_entities SET status = 'PAUSED', effective_status = 'PAUSED', updated_at = ? WHERE id = ?").bind(Date.now(), ad.ad_id).run();
  return { ok: true, summary: `Paused on Meta: ${ad.name}.` };
});

registerActionHandler('marketing.duplicate_ad', async (rt, raw) => {
  const p = (raw ?? {}) as Record<string, unknown>;
  const ad = { ad_id: str(p.ad_id), name: str(p.ad_name) || str(p.ad_id) };
  if (!/^\d{1,30}$/.test(ad.ad_id)) return { ok: false, summary: 'No valid ad id in the proposal.' };
  if (!metaWriteConfigured(rt)) return manualOk(p) ? { ok: true, summary: `Marked as duplicated by hand in Ads Manager: ${ad.name}.` } : noWrite(manualSteps.duplicate(ad));
  const r = await duplicateMetaAd(rt, ad.ad_id, str(p.target_adset_id) || undefined);
  const copy = r.copied_ad_id ?? r.ad_object_ids?.[0]?.copied_id ?? null;
  return { ok: true, summary: `Duplicated on Meta (paused, review then publish): ${ad.name}${copy ? ` → new ad ${copy}` : ''}.` };
});

registerActionHandler('marketing.shift_budget', async (rt, raw) => {
  const p = (raw ?? {}) as Record<string, unknown>;
  const from = str(p.from_adset), to = str(p.to_adset);
  if (!/^\d{1,30}$/.test(from) || !/^\d{1,30}$/.test(to) || from === to) return { ok: false, summary: 'The proposal needs two different ad sets.' };
  const t = adsTargets(rt.settings as unknown as Record<string, string>);
  const db = rt.env.DB;
  const now = Date.now();
  const sets = new Map((await db.prepare("SELECT id, name, daily_budget, effective_status FROM ad_entities WHERE level = 'adset' AND id IN (?, ?)").bind(from, to).all<AdsetRow>()).results.map((s) => [s.id, s]));
  const f = sets.get(from), g = sets.get(to);
  if (!f?.daily_budget || !g?.daily_budget) return { ok: false, summary: 'Both ad sets need their own daily budget (campaign budget optimisation is changed in Ads Manager).' };
  const used = await shiftedToday(rt, [from, to], now);
  // Re-bounded at execution: budgets may have changed, other shifts may have run today, the owner may have edited the amount.
  const [startFrom, startTo] = await Promise.all([budgetAtStartOfDay(rt, from, f.daily_budget, now), budgetAtStartOfDay(rt, to, g.daily_budget, now)]);
  const limit = boundShift({ fromBudget: startFrom, toBudget: startTo, maxPct: t.maxShiftPct, usedFrom: used.get(from), usedTo: used.get(to) }).amount;
  const b = boundShift({ fromBudget: f.daily_budget, toBudget: g.daily_budget, requested: Math.min(limit, Math.max(0, Math.round(Number(p.amount) || 0))), maxPct: 100, cap: t.maxDailyBudget != null ? t.maxDailyBudget * 100 : null });
  if (b.amount < 100) return { ok: false, summary: `Nothing to move: today's limit of ${t.maxShiftPct}% per ad set is used up or the cap is reached.` };
  const amt = (b.amount / 100).toFixed(2);
  const fromName = f.name || from, toName = g.name || to;
  const write = metaWriteConfigured(rt);
  if (!write && !manualOk(p)) return noWrite(manualSteps.shift(fromName, toName, amt));
  if (write) {
    await setMetaDailyBudget(rt, from, b.fromAfter);
    await setMetaDailyBudget(rt, to, b.toAfter);
  }
  const actionId = str(p.action_id) || null; // the handler gets the payload only; kept when a caller adds it
  await db.batch([
    db.prepare('INSERT INTO ads_budget_shifts (id, day, adset_id, delta, before_amt, after_amt, action_id, applied, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(newId('bs'), ymd(now), from, -b.amount, f.daily_budget, b.fromAfter, actionId, write ? 1 : 0, now),
    db.prepare('INSERT INTO ads_budget_shifts (id, day, adset_id, delta, before_amt, after_amt, action_id, applied, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(newId('bs'), ymd(now), to, b.amount, g.daily_budget, b.toAfter, actionId, write ? 1 : 0, now),
    db.prepare('UPDATE ad_entities SET daily_budget = ?, updated_at = ? WHERE id = ?').bind(b.fromAfter, now, from),
    db.prepare('UPDATE ad_entities SET daily_budget = ?, updated_at = ? WHERE id = ?').bind(b.toAfter, now, to),
  ]);
  return { ok: true, summary: `${write ? 'Moved on Meta' : 'Marked as moved by hand'}: ${amt}/day from "${fromName}" (now ${(b.fromAfter / 100).toFixed(2)}) to "${toName}" (now ${(b.toAfter / 100).toFixed(2)}).` };
});

/** For the log when the owner runs a sync by hand. */
export const logSync = (rt: Runtime, summary: string) => logAction(rt, { dept: 'marketing', kind: 'marketing.sync', summary, actor: 'you', status: 'done' });
