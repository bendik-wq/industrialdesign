/**
 * Blended MER (marketing efficiency ratio): total revenue net of refunds ÷ total ad spend, over 7 and 30 days,
 * each next to the window before it, plus a daily series for the trend line.
 *
 * Revenue: every paid ticket, VIP upgrade, Sprint, deposit and signed engagement recorded in attr_conversions
 * (amount minus refunded), whichever ad or link brought the buyer, counted on the day it was paid.
 * Spend: the Meta spend syncs. Per day, the campaign-level rows (ad_spend, which also holds spend typed in by hand)
 * when that day has any, else the ad-level rows (ad_insights), so the same money is never counted twice.
 *
 * The autopilot reads `merGuard`: with ADS_MER_FLOOR set and the 7-day MER under it, it doesn't propose scaling
 * (duplicating winners or moving budget toward them) and says why. Pausing losers still runs.
 */
import type { Runtime } from '../app';
import { PAID_KINDS } from '../attribution/capture';
import { primaryCurrency } from '../attribution/report';
import { fromMinor } from '../webinar/pass';

const DAY = 86_400_000;
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface DayMoney { day: string; revenue: number; spend: number }
export interface MerWindow { days: number; revenue: number; spend: number; mer: number | null; prev: { revenue: number; spend: number; mer: number | null }; change: number | null }
export interface MerSummary {
  currency: string | null; spendCurrency: string | null; comparable: boolean;
  w7: MerWindow; w30: MerWindow; series: (DayMoney & { mer7: number | null })[]; note: string | null;
}

/** MER of one window: null when there's no spend (nothing to divide by). */
export const merOf = (revenue: number, spend: number) => (spend > 0 ? r2(revenue / spend) : null);

/** Sums a window of days ending at `end` (inclusive), `offset` windows back. Pure. */
export function windowOf(days: DayMoney[], end: string, len: number, offset = 0) {
  const endT = Date.parse(`${end}T00:00:00Z`) - offset * len * DAY;
  const from = ymd(endT - (len - 1) * DAY), to = ymd(endT);
  const inside = days.filter((d) => d.day >= from && d.day <= to);
  const revenue = r2(inside.reduce((a, d) => a + d.revenue, 0));
  const spend = r2(inside.reduce((a, d) => a + d.spend, 0));
  return { revenue, spend, mer: merOf(revenue, spend) };
}

/** Both windows with the change against the window before. Pure, so it is tested on fixtures. */
export function summarize(days: DayMoney[], today: string, len: number): MerWindow {
  const cur = windowOf(days, today, len, 0), prev = windowOf(days, today, len, 1);
  return { days: len, ...cur, prev, change: cur.mer != null && prev.mer != null && prev.mer > 0 ? r2(((cur.mer - prev.mer) / prev.mer) * 100) : null };
}

/** Reads revenue and spend per day for the last 60 days (two 30-day windows). */
export async function loadDailyMoney(rt: Pick<Runtime, 'env'>, now = Date.now()) {
  const db = rt.env.DB;
  const from = ymd(now - 59 * DAY), to = ymd(now);
  const fromT = Date.parse(`${from}T00:00:00Z`);
  const [conv, camp, ads] = await Promise.all([
    db.prepare(`SELECT occurred_at, currency, amount - refunded AS net FROM attr_conversions WHERE kind IN (${PAID_KINDS.map(() => '?').join(', ')}) AND occurred_at >= ? AND amount > 0`)
      .bind(...PAID_KINDS, fromT).all<{ occurred_at: number; currency: string | null; net: number }>().catch(() => ({ results: [] as { occurred_at: number; currency: string | null; net: number }[] })),
    db.prepare('SELECT day, SUM(spend) AS spend, MAX(currency) AS currency FROM ad_spend WHERE day BETWEEN ? AND ? GROUP BY day').bind(from, to)
      .all<{ day: string; spend: number; currency: string | null }>().catch(() => ({ results: [] as { day: string; spend: number; currency: string | null }[] })),
    db.prepare('SELECT day, SUM(spend) AS spend, MAX(currency) AS currency FROM ad_insights WHERE day BETWEEN ? AND ? GROUP BY day').bind(from, to)
      .all<{ day: string; spend: number; currency: string | null }>().catch(() => ({ results: [] as { day: string; spend: number; currency: string | null }[] })),
  ]);
  const currency = primaryCurrency(conv.results.map((c) => ({ currency: c.currency, net: c.net })));
  const spendCurrency = camp.results.find((c) => c.currency)?.currency ?? ads.results.find((c) => c.currency)?.currency ?? null;
  const map = new Map<string, DayMoney>();
  for (let t = fromT; t <= now; t += DAY) map.set(ymd(t), { day: ymd(t), revenue: 0, spend: 0 });
  let otherCurrency = 0;
  for (const c of conv.results) {
    const d = map.get(ymd(c.occurred_at));
    if (!d) continue;
    if (c.currency && currency && c.currency.toLowerCase() !== currency.toLowerCase()) { otherCurrency++; continue; }
    d.revenue += fromMinor(c.net, currency ?? 'USD');
  }
  const campDays = new Set<string>();
  for (const c of camp.results) { const d = map.get(c.day); if (d && c.spend) { d.spend += c.spend; campDays.add(c.day); } }
  for (const a of ads.results) { const d = map.get(a.day); if (d && !campDays.has(a.day)) d.spend += a.spend || 0; }
  const days = [...map.values()].map((d) => ({ ...d, revenue: r2(d.revenue), spend: r2(d.spend) }));
  return { days, currency, spendCurrency, otherCurrency };
}

export async function merSummary(rt: Pick<Runtime, 'env'>, now = Date.now()): Promise<MerSummary> {
  const { days, currency, spendCurrency, otherCurrency } = await loadDailyMoney(rt, now);
  const today = ymd(now);
  const comparable = !currency || !spendCurrency || currency.toLowerCase() === spendCurrency.toLowerCase();
  const w7 = summarize(days, today, 7), w30 = summarize(days, today, 30);
  const last30 = days.slice(-30);
  const series = last30.map((d) => {
    const w = windowOf(days, d.day, 7, 0);
    return { ...d, mer7: w.mer };
  });
  const notes = [
    !comparable ? `Revenue is in ${currency!.toUpperCase()} and ad spend in ${spendCurrency!.toUpperCase()}, so MER is not shown. Set the ad account and checkout to the same currency.` : '',
    otherCurrency ? `${otherCurrency} payment${otherCurrency === 1 ? '' : 's'} in another currency left out.` : '',
  ].filter(Boolean).join(' ');
  if (!comparable) { for (const w of [w7, w30]) { w.mer = null; w.prev.mer = null; w.change = null; } for (const s of series) s.mer7 = null; }
  return { currency, spendCurrency, comparable, w7, w30, series, note: notes || null };
}

// ───────────── the floor ─────────────

/** ADS_MER_FLOOR as a number, or null (blank or not a positive number = off). */
export function merFloor(s: Partial<Record<string, string>>): number | null {
  const raw = String(s.ADS_MER_FLOOR ?? '').trim();
  if (!raw) return null;
  const n = Number(raw.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface MerGuard { floor: number | null; mer: number | null; holdScaling: boolean; reason: string }

/** Whether the autopilot may propose scaling, and the sentence that says why. Pure. */
export function merGuard(floor: number | null, w7: Pick<MerWindow, 'revenue' | 'spend' | 'mer'> | null, comparable = true, cur: string | null = null): MerGuard {
  const m = (n: number) => `${cur ? `${cur.toUpperCase()} ` : ''}${Math.round(n).toLocaleString('en-US')}`;
  if (floor == null) return { floor: null, mer: w7?.mer ?? null, holdScaling: false, reason: 'No MER floor set (ADS_MER_FLOOR blank): scaling proposals are judged on each ad alone.' };
  if (!comparable) return { floor, mer: null, holdScaling: true, reason: `MER floor ${floor} is set but MER can't be worked out (revenue and ad spend are in different currencies), so the autopilot holds scaling proposals until it can.` };
  if (!w7 || w7.spend <= 0) return { floor, mer: null, holdScaling: false, reason: `MER floor ${floor}: no ad spend in the last 7 days, nothing to hold.` };
  const mer = w7.mer ?? 0;
  if (mer < floor) {
    return { floor, mer, holdScaling: true,
      reason: `Blended MER over the last 7 days is ${mer.toFixed(2)} (${m(w7.revenue)} revenue net of refunds ÷ ${m(w7.spend)} ad spend), under the floor of ${floor}. The autopilot won't propose duplicating winners or moving budget toward them until MER is back at or above the floor. Pausing losing and fatigued ads still runs.` };
  }
  return { floor, mer, holdScaling: false, reason: `Blended MER over the last 7 days is ${mer.toFixed(2)}, at or above the floor of ${floor}: scaling proposals are allowed.` };
}

/** The guard as the autopilot sees it now. */
export async function currentMerGuard(rt: Pick<Runtime, 'env' | 'settings'>, now = Date.now()) {
  const floor = merFloor(rt.settings as unknown as Record<string, string>);
  if (floor == null) return merGuard(null, null);
  const s = await merSummary(rt, now);
  return merGuard(floor, s.w7, s.comparable, s.currency ?? s.spendCurrency);
}
