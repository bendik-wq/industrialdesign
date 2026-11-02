import type { Runtime } from '../app';
import { paidSaleOn } from '../lib/paid-sales';
import { fromMinor } from '../webinar/pass';
import { addonConfig } from '../webinar/ticket-addon';

/**
 * Front-end economics (Funnel HQ → Financial model, overnight loop round 2): does the ticket pay for the ads?
 *
 * Per ticket funnel (the Masterclass ticket, the live webinar ticket, the challenge ticket with its VIP upgrade) and
 * per event (masterclass registration week, live event, challenge cohort) or per calendar week:
 *   ad spend (the existing Meta spend syncs; campaign rows in ad_spend, else ad rows in ad_insights, never both for a day)
 *   front-end revenue: tickets, VIP upgrades and the ticket add-on, net of refunds
 *   recovery = front-end revenue ÷ spend; it "self-liquidates" at 100% or more
 *   cost per ticket buyer = spend ÷ buyers who kept their ticket
 *   back-end revenue: First Deal Sprints, engagement deposits, signed engagements (cash collected), net of refunds
 *   ROAS = (front end + back end) ÷ spend.
 *
 * Sales follow src/lib/paid-sales.ts: paid or refunded rows by paid_at, amount minus refunds. Nothing is estimated
 * except the recommendation box, which is labelled as an estimate and shows the arithmetic it rests on.
 *
 * Spend → funnel: the owner's choice per campaign (econ_campaigns), else the funnel most of the campaign's
 * registrations came into (their last touch's utm_campaign / campaign id, as attribution recorded it), else its
 * name ("challenge", "masterclass", "live"). Campaigns marked VSL or other in Traffic & ads are left out. What
 * can't be matched is shown as unmatched spend, so the totals always reconcile with the ad account.
 */

export type EconFunnel = 'auto' | 'live' | 'challenge';
export const ECON_FUNNELS: EconFunnel[] = ['auto', 'live', 'challenge'];
export const FUNNEL_LABEL: Record<EconFunnel, string> = { auto: 'Masterclass ticket', live: 'Live webinar ticket', challenge: 'Challenge ticket and VIP' };
export type Part = 'ticket' | 'vip' | 'addon' | 'sprint' | 'deposit' | 'engagement';
export const FRONT: Part[] = ['ticket', 'vip', 'addon'];
export const BACK: Part[] = ['sprint', 'deposit', 'engagement'];

export interface SpendRow { day: string; campaign_id: string; spend: number }
export interface CampaignInfo { campaign_id: string; name: string | null; funnel: EconFunnel | 'none' | null; how: 'set' | 'registrations' | 'name' | 'excluded' | 'unmatched'; registrations: number; spend: number }
/** One sale, in major units of `currency`. cohort: the event key (see cohortKey), null when it couldn't be placed. */
export interface Sale { funnel: EconFunnel | null; part: Part; lead_id: string; cohort: string | null; paid_at: number; net: number; gross: number }
export interface CohortDef { key: string; funnel: EconFunnel; label: string; at: number }

const DAY = 86_400_000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);
/** Monday of the UTC week. */
export const weekOf = (t: number) => { const d = new Date(t); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return ymd(d.getTime()); };
export const weekKey = (f: EconFunnel, t: number) => `${f}|week|${weekOf(t)}`;

/** First guess from a campaign's name. */
export function funnelFromName(name: string | null): EconFunnel | null {
  const n = (name ?? '').toLowerCase();
  if (/challenge/.test(n)) return 'challenge';
  if (/master ?class|evergreen|auto[ -]?webinar/.test(n)) return 'auto';
  if (/\blive\b/.test(n)) return 'live';
  return null;
}

/** The funnel a campaign feeds and how we know. Pure. */
export function matchCampaign(c: { campaign_id: string; name: string | null }, o: {
  set?: string | null; adsFunnel?: string | null; regs: Map<string, Partial<Record<EconFunnel, number>>>;
}): Pick<CampaignInfo, 'funnel' | 'how' | 'registrations'> {
  const byId = o.regs.get(c.campaign_id) ?? {};
  const byName = c.name ? o.regs.get(`name:${c.name.toLowerCase()}`) ?? {} : {};
  const counts = ECON_FUNNELS.map((f) => ({ f, n: (byId[f] ?? 0) + (byName[f] ?? 0) }));
  const registrations = counts.reduce((a, x) => a + x.n, 0);
  if (o.set === 'none') return { funnel: 'none', how: 'set', registrations };
  if (o.set && (ECON_FUNNELS as string[]).includes(o.set)) return { funnel: o.set as EconFunnel, how: 'set', registrations };
  if (o.adsFunnel === 'vsl' || o.adsFunnel === 'other') return { funnel: 'none', how: 'excluded', registrations };
  const top = counts.sort((a, b) => b.n - a.n)[0];
  if (top.n > 0) return { funnel: top.f, how: 'registrations', registrations };
  const byNameGuess = funnelFromName(c.name);
  if (byNameGuess) return { funnel: byNameGuess, how: 'name', registrations };
  return { funnel: null, how: 'unmatched', registrations };
}

/** Which event a day's spend belongs to: the first event of that funnel on or after the day; the masterclass by week. */
export function spendCohort(f: EconFunnel, day: string, cohorts: CohortDef[]) {
  const t = Date.parse(`${day}T00:00:00Z`);
  if (f === 'auto') return weekKey('auto', t);
  const next = cohorts.filter((c) => c.funnel === f && c.at >= t).sort((a, b) => a.at - b.at)[0];
  return next ? next.key : `${f}|after`;
}

export interface Money {
  spend: number; ticket: number; vip: number; addon: number; frontEnd: number; sprint: number; deposit: number; engagement: number; backEnd: number; total: number;
  buyers: number; ticketSales: number; ticketGross: number; vipBuyers: number; vipGross: number; vipSales: number; addonBuyers: number; addonGross: number; addonSales: number;
  /** Front-end revenue ÷ spend (1 = 100%). Null without spend. */
  recovery: number | null; cpa: number | null; roas: number | null; selfLiquidates: boolean | null;
}

interface Acc { spend: number; net: Record<Part, number>; gross: Record<Part, number>; sales: Record<Part, number>; buyers: Record<Part, Set<string>> }
const acc = (): Acc => ({ spend: 0, net: { ticket: 0, vip: 0, addon: 0, sprint: 0, deposit: 0, engagement: 0 }, gross: { ticket: 0, vip: 0, addon: 0, sprint: 0, deposit: 0, engagement: 0 }, sales: { ticket: 0, vip: 0, addon: 0, sprint: 0, deposit: 0, engagement: 0 }, buyers: { ticket: new Set(), vip: new Set(), addon: new Set(), sprint: new Set(), deposit: new Set(), engagement: new Set() } });
function addSale(a: Acc, s: Sale) {
  a.net[s.part] += s.net; a.gross[s.part] += s.gross; a.sales[s.part]++;
  if (s.net > 0) a.buyers[s.part].add(s.lead_id);
}
export function money(a: Acc): Money {
  const frontEnd = r2(a.net.ticket + a.net.vip + a.net.addon), backEnd = r2(a.net.sprint + a.net.deposit + a.net.engagement), spend = r2(a.spend);
  const buyers = a.buyers.ticket.size;
  return {
    spend, ticket: r2(a.net.ticket), vip: r2(a.net.vip), addon: r2(a.net.addon), frontEnd,
    sprint: r2(a.net.sprint), deposit: r2(a.net.deposit), engagement: r2(a.net.engagement), backEnd, total: r2(frontEnd + backEnd),
    buyers, ticketSales: a.sales.ticket, ticketGross: r2(a.gross.ticket), vipBuyers: a.buyers.vip.size, vipGross: r2(a.gross.vip), vipSales: a.sales.vip,
    addonBuyers: a.buyers.addon.size, addonGross: r2(a.gross.addon), addonSales: a.sales.addon,
    recovery: spend > 0 ? frontEnd / spend : null,
    cpa: spend > 0 && buyers > 0 ? r2(spend / buyers) : null,
    roas: spend > 0 ? r2((frontEnd + backEnd) / spend) : null,
    selfLiquidates: spend > 0 ? frontEnd >= spend : null,
  };
}

export interface Row extends Money { key: string; funnel: EconFunnel; label: string; at: number }

/** Rolls spend and sales up per funnel, per event and per calendar week. Pure. */
export function rollUp(o: { spend: (SpendRow & { funnel: EconFunnel })[]; sales: Sale[]; cohorts: CohortDef[] }) {
  const totals = new Map<EconFunnel, Acc>(ECON_FUNNELS.map((f) => [f, acc()]));
  const events = new Map<string, Acc>(), weeks = new Map<string, Acc>();
  const get = (m: Map<string, Acc>, k: string) => { let a = m.get(k); if (!a) { a = acc(); m.set(k, a); } return a; };
  for (const s of o.spend) {
    totals.get(s.funnel)!.spend += s.spend;
    get(events, spendCohort(s.funnel, s.day, o.cohorts)).spend += s.spend;
    get(weeks, weekKey(s.funnel, Date.parse(`${s.day}T00:00:00Z`))).spend += s.spend;
  }
  for (const s of o.sales) {
    if (!s.funnel) continue;
    addSale(totals.get(s.funnel)!, s);
    addSale(get(events, s.cohort ?? `${s.funnel}|none`), s);
    addSale(get(weeks, weekKey(s.funnel, s.paid_at)), s);
  }
  const byKey = new Map(o.cohorts.map((c) => [c.key, c]));
  const label = (k: string): { funnel: EconFunnel; label: string; at: number } => {
    const [f, a, b] = k.split('|') as [EconFunnel, string, string?];
    const c = byKey.get(k);
    if (c) return { funnel: c.funnel, label: c.label, at: c.at };
    if (a === 'week') return { funnel: f, label: f === 'auto' ? `Masterclass, registered week of ${b}` : `Week of ${b}`, at: Date.parse(`${b}T00:00:00Z`) };
    if (a === 'after') return { funnel: f, label: 'Spend after the last scheduled event', at: Number.MAX_SAFE_INTEGER };
    return { funnel: f, label: 'Sales not tied to an event', at: 0 };
  };
  const rows = (m: Map<string, Acc>, weekly = false) => [...m.entries()].map(([key, a]) => {
    const l = weekly ? (() => { const [f, , w] = key.split('|') as [EconFunnel, string, string]; return { funnel: f, label: `Week of ${w}`, at: Date.parse(`${w}T00:00:00Z`) }; })() : label(key);
    return { key, ...l, ...money(a) };
  }).sort((x, y) => y.at - x.at || x.funnel.localeCompare(y.funnel));
  return {
    totals: ECON_FUNNELS.map((f) => ({ funnel: f, label: FUNNEL_LABEL[f], ...money(totals.get(f)!) })),
    byEvent: rows(events),
    byWeek: rows(weeks, true),
  };
}

// ───────────── Recommendation (an estimate, labelled as one) ─────────────

export interface Recommendation {
  funnel: EconFunnel; estimate: true; cpa: number | null; small: boolean;
  currentPrice: number | null; priceNeeded: number | null;
  bump: { name: string; price: number; currentTake: number; takeNeeded: number | null; reachable: boolean } | null;
  lines: string[];
}
const MIN_BUYERS = 20;

/**
 * At the current cost per ticket buyer: the ticket price, and the VIP (challenge) or add-on (masterclass) take-rate,
 * that would make front-end revenue equal spend. Holds everything else at today's numbers, which a price change
 * would not: the lines say so. Pure; every line passes auditCopy (tested).
 */
export function recommend(f: EconFunnel, m: Money, o: { money: (n: number) => string; addon?: { name: string; price: number } | null }): Recommendation {
  const base = { funnel: f, estimate: true as const, cpa: m.cpa, small: m.buyers < MIN_BUYERS, currentPrice: null, priceNeeded: null, bump: null };
  if (!(m.spend > 0)) return { ...base, lines: ['No ad spend is matched to this funnel in this range, so there is nothing to recover yet.'] };
  if (!m.buyers || m.cpa == null) return { ...base, lines: [`${o.money(m.spend)} of ad spend and no ticket buyers yet, so there is no cost per buyer to price against.`] };
  const cpa = m.cpa, buyers = m.buyers;
  const keep = m.ticketGross > 0 ? Math.min(1, m.ticket / m.ticketGross) : 1; // share of ticket money kept after refunds
  const currentPrice = m.ticketSales ? r2(m.ticketGross / m.ticketSales) : null;
  const ticketPer = m.ticket / buyers, vipPer = m.vip / buyers, addonPer = m.addon / buyers;
  const priceNeeded = keep > 0 ? r2(Math.max(0, cpa - vipPer - addonPer) / keep) : null;
  const lines: string[] = [];
  lines.push(`Cost per ticket buyer: ${o.money(cpa)} (${o.money(m.spend)} of ad spend, ${buyers} buyer${buyers === 1 ? '' : 's'} who kept their ticket).`);
  if (m.selfLiquidates) lines.push(`The front end already covers its ad spend: ${Math.round((m.recovery ?? 0) * 100)}% recovered.`);
  else if (priceNeeded != null) lines.push(`Estimate: a ticket of about ${o.money(Math.ceil(priceNeeded))}${currentPrice != null ? ` (today ${o.money(currentPrice)})` : ''} would cover the spend at this cost per buyer, with ${f === 'auto' ? 'add-on' : f === 'challenge' ? 'VIP' : 'other front-end'} revenue per buyer as it is now.`);
  let bump: Recommendation['bump'] = null;
  // The bump's price as sold (gross) and what each sale kept after refunds (net), from real sales when there are any.
  const b = f === 'challenge' ? (m.vipSales ? { name: 'VIP upgrade', price: m.vipGross / m.vipSales, netEach: m.vip / m.vipSales, take: m.vipBuyers / buyers } : null)
    : f === 'auto' ? (o.addon ? { name: o.addon.name, price: m.addonSales ? m.addonGross / m.addonSales : o.addon.price, netEach: m.addonSales ? m.addon / m.addonSales : o.addon.price, take: m.addonBuyers / buyers } : null) : null;
  if (b && b.price > 0 && b.netEach > 0) {
    const rest = cpa - ticketPer - (f === 'challenge' ? addonPer : vipPer);
    const takeNeeded = rest <= 0 ? 0 : rest / b.netEach;
    bump = { name: b.name, price: r2(b.price), currentTake: b.take, takeNeeded: r2(takeNeeded), reachable: takeNeeded <= 1 };
    if (!m.selfLiquidates) {
      lines.push(takeNeeded <= 1
        ? `Estimate: at today’s ticket price, ${Math.ceil(takeNeeded * 100)}% of ticket buyers taking the ${b.name} at ${o.money(b.price)} would cover the spend (today ${Math.round(b.take * 100)}%).`
        : `Estimate: the ${b.name} at ${o.money(b.price)} can’t cover the gap on its own, even if every ticket buyer took it. The ticket price or the cost per buyer has to move.`);
    }
  } else if (f === 'auto' && !o.addon && !m.selfLiquidates) {
    lines.push('The ticket add-on is off, so the masterclass front end has one product to recover spend with.');
  }
  lines.push('These are estimates from today’s numbers. A higher price can lower the share of people who buy, which raises the cost per buyer, so test a change before relying on it.');
  if (buyers < MIN_BUYERS) lines.push(`Based on ${buyers} buyer${buyers === 1 ? '' : 's'}: too few to rely on yet.`);
  return { ...base, currentPrice, priceNeeded, bump, lines };
}

// ───────────── Loading ─────────────

type DB = Runtime['env']['DB'];
const rows = async <T>(db: DB, sql: string, args: unknown[]) => (await db.prepare(sql).bind(...args).all<T>().catch((e) => { console.error('economics query', String(e).slice(0, 200)); return { results: [] as T[] }; })).results;

/** Campaign spend per day: ad_spend rows, else ad_insights rows on days ad_spend has none. */
export async function loadSpend(db: DB, from: string, to: string) {
  const [camp, ads, names] = await Promise.all([
    rows<{ campaign_id: string; day: string; name: string | null; spend: number; currency: string | null }>(db, 'SELECT campaign_id, day, MAX(campaign_name) AS name, SUM(spend) AS spend, MAX(currency) AS currency FROM ad_spend WHERE day BETWEEN ? AND ? GROUP BY campaign_id, day', [from, to]),
    rows<{ campaign_id: string; day: string; spend: number; currency: string | null }>(db, 'SELECT campaign_id, day, SUM(spend) AS spend, MAX(currency) AS currency FROM ad_insights WHERE day BETWEEN ? AND ? AND campaign_id IS NOT NULL GROUP BY campaign_id, day', [from, to]),
    rows<{ id: string; name: string | null }>(db, "SELECT id, name FROM ad_entities WHERE level = 'campaign'", []),
  ]);
  const campDays = new Set(camp.map((c) => c.day));
  const name = new Map<string, string>();
  for (const n of names) if (n.name) name.set(n.id, n.name);
  for (const c of camp) if (c.name && !name.has(c.campaign_id)) name.set(c.campaign_id, c.name);
  const out: SpendRow[] = camp.filter((c) => c.spend).map((c) => ({ day: c.day, campaign_id: c.campaign_id, spend: c.spend }));
  for (const a of ads) if (!campDays.has(a.day) && a.spend) out.push({ day: a.day, campaign_id: a.campaign_id, spend: a.spend });
  const currency = camp.find((c) => c.currency)?.currency ?? ads.find((c) => c.currency)?.currency ?? null;
  return { spend: out, name, currency: currency ? currency.toUpperCase() : null };
}

/** Registrations per campaign key (campaign id, or name:<utm_campaign>) and funnel, from attribution's touches. */
export async function loadRegMatches(db: DB, fromT: number, toT: number) {
  const list = await rows<{ funnel: string; lt_id: string | null; lt: string | null; ft_id: string | null; ft: string | null; n: number }>(db,
    `SELECT funnel, lt_campaign_id AS lt_id, lt_campaign AS lt, ft_campaign_id AS ft_id, ft_campaign AS ft, COUNT(*) AS n FROM attr_conversions
      WHERE kind = 'registered' AND occurred_at BETWEEN ? AND ? GROUP BY 1, 2, 3, 4, 5`, [fromT, toT]);
  const m = new Map<string, Partial<Record<EconFunnel, number>>>();
  for (const r of list) {
    if (!(ECON_FUNNELS as string[]).includes(r.funnel)) continue;
    const key = r.lt_id || (r.lt ? `name:${r.lt.toLowerCase()}` : null) || r.ft_id || (r.ft ? `name:${r.ft.toLowerCase()}` : null);
    if (!key) continue;
    const c = m.get(key) ?? {};
    c[r.funnel as EconFunnel] = (c[r.funnel as EconFunnel] ?? 0) + r.n;
    m.set(key, c);
  }
  return m;
}

const isFunnel = (v: unknown): v is EconFunnel => v === 'auto' || v === 'live' || v === 'challenge';

/** Every sale in the range, placed in its funnel and event. Amounts in minor units with their currency. */
export async function loadSales(db: DB, fromT: number, toT: number) {
  const [passes, orders, engagements] = await Promise.all([
    rows<{ id: string; kind: string; source: string | null; ref_id: string | null; lead_id: string; paid_at: number; gross: number; net: number; currency: string; reg_at: number | null; ch_cohort: string | null; a_funnel: string | null; a_cohort: string | null; a_reg_at: number | null }>(db,
      `SELECT p.id, p.kind, p.source, p.ref_id, p.lead_id, p.paid_at, p.amount AS gross, p.amount - COALESCE(p.refunded_amount, 0) AS net, lower(COALESCE(p.currency, 'usd')) AS currency,
              r.created_at AS reg_at, cr.cohort_id AS ch_cohort, a.funnel AS a_funnel, a.cohort_ref AS a_cohort, ar.created_at AS a_reg_at
         FROM webinar_passes p
         LEFT JOIN webinar_registrations r ON r.id = p.reg_id
         LEFT JOIN challenge_registrations cr ON cr.id = p.ref_id AND p.source = 'challenge'
         LEFT JOIN attr_conversions a ON a.ref_id = p.id AND a.kind != 'registered'
         LEFT JOIN webinar_registrations ar ON ar.id = a.reg_id
        WHERE p.kind IN ('seat', 'addon', 'live_ticket', 'offer', 'deposit') AND ${paidSaleOn('p')} AND p.paid_at BETWEEN ? AND ? AND p.amount > 0`, [fromT, toT]),
    rows<{ id: string; kind: string; lead_id: string; paid_at: number; gross: number; net: number; currency: string; cohort_id: string | null }>(db,
      `SELECT o.id, o.kind, o.lead_id, o.paid_at, o.amount AS gross, o.amount - COALESCE(o.refunded_amount, 0) AS net, lower(o.currency) AS currency, r.cohort_id
         FROM challenge_orders o LEFT JOIN challenge_registrations r ON r.id = o.reg_id
        WHERE ${paidSaleOn('o')} AND o.paid_at BETWEEN ? AND ? AND o.amount > 0`, [fromT, toT]),
    rows<{ id: string; funnel: string; cohort_ref: string | null; lead_id: string; paid_at: number; gross: number; net: number; currency: string; reg_at: number | null }>(db,
      `SELECT a.id, a.funnel, a.cohort_ref, a.lead_id, a.occurred_at AS paid_at, a.amount AS gross, a.amount - a.refunded AS net, lower(COALESCE(a.currency, 'usd')) AS currency, ar.created_at AS reg_at
         FROM attr_conversions a LEFT JOIN webinar_registrations ar ON ar.id = a.reg_id
        WHERE a.kind = 'engagement_signed' AND a.amount > 0 AND a.occurred_at BETWEEN ? AND ?`, [fromT, toT]),
  ]);
  type Raw = Omit<Sale, 'net' | 'gross'> & { net: number; gross: number; currency: string };
  const out: Raw[] = [];
  const auto = (t: number) => weekKey('auto', t);
  for (const p of passes) {
    let funnel: EconFunnel | null = null, cohort: string | null = null;
    const part: Part = p.kind === 'seat' || p.kind === 'live_ticket' ? 'ticket' : p.kind === 'addon' ? 'addon' : p.kind === 'offer' ? 'sprint' : 'deposit';
    if (p.kind === 'seat' || p.kind === 'addon') { funnel = 'auto'; cohort = auto(p.reg_at ?? p.paid_at); }
    else if (p.kind === 'live_ticket' || p.source === 'live') { funnel = 'live'; cohort = p.ref_id ? `live|${p.ref_id}` : null; }
    else if (p.source === 'challenge') { funnel = 'challenge'; const c = p.ch_cohort ?? (p.a_funnel === 'challenge' ? p.a_cohort : null); cohort = c ? `challenge|${c}` : null; }
    else if (p.reg_at != null) { funnel = 'auto'; cohort = auto(p.reg_at); }
    else if (isFunnel(p.a_funnel)) { funnel = p.a_funnel; cohort = funnel === 'auto' ? auto(p.a_reg_at ?? p.paid_at) : p.a_cohort ? `${funnel}|${p.a_cohort}` : null; }
    out.push({ funnel, part, lead_id: p.lead_id, cohort, paid_at: p.paid_at, net: p.net, gross: p.gross, currency: p.currency });
  }
  for (const o of orders) out.push({ funnel: 'challenge', part: o.kind === 'vip' ? 'vip' : 'ticket', lead_id: o.lead_id, cohort: o.cohort_id ? `challenge|${o.cohort_id}` : null, paid_at: o.paid_at, net: o.net, gross: o.gross, currency: o.currency });
  for (const e of engagements) {
    const funnel = isFunnel(e.funnel) ? e.funnel : null;
    out.push({ funnel, part: 'engagement', lead_id: e.lead_id, cohort: funnel === 'auto' ? auto(e.reg_at ?? e.paid_at) : funnel && e.cohort_ref ? `${funnel}|${e.cohort_ref}` : null, paid_at: e.paid_at, net: e.net, gross: e.gross, currency: e.currency });
  }
  return out;
}

/** The live events and challenge cohorts that spend and sales are placed in (upcoming ones included). */
export async function loadCohorts(db: DB, fromT: number, toT: number): Promise<CohortDef[]> {
  const [events, cohorts] = await Promise.all([
    rows<{ id: string; title: string; starts_at: number }>(db, "SELECT id, title, starts_at FROM live_webinars WHERE status != 'cancelled' AND starts_at BETWEEN ? AND ?", [fromT - 60 * DAY, toT + 120 * DAY]),
    rows<{ id: string; name: string; start_date: string }>(db, "SELECT id, name, start_date FROM challenge_cohorts WHERE status != 'cancelled' AND start_date BETWEEN ? AND ?", [ymd(fromT - 60 * DAY), ymd(toT + 120 * DAY)]),
  ]);
  return [
    ...events.map((e) => ({ key: `live|${e.id}`, funnel: 'live' as const, label: `${e.title} (${ymd(e.starts_at)})`, at: e.starts_at })),
    ...cohorts.map((c) => ({ key: `challenge|${c.id}`, funnel: 'challenge' as const, label: `${c.name} (Day 1 ${c.start_date})`, at: Date.parse(`${c.start_date}T00:00:00Z`) || 0 })),
  ];
}

const fmtMoney = (currency: string) => (n: number) => {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: n % 1 ? 2 : 0 }).format(n); } catch { return `${currency} ${n.toFixed(2)}`; }
};

/** GET /admin/api/economics?days=90 */
export async function economicsReport(rt: Runtime, o: { days?: number; now?: number } = {}) {
  const db = rt.env.DB;
  const now = o.now ?? Date.now();
  const days = [30, 90, 180, 365].includes(Number(o.days)) ? Number(o.days) : 90;
  const fromT = Date.parse(`${ymd(now - (days - 1) * DAY)}T00:00:00Z`), toT = now;
  const [sp, regs, rawSales, cohorts, sets, adsF] = await Promise.all([
    loadSpend(db, ymd(fromT), ymd(toT)),
    loadRegMatches(db, fromT - 30 * DAY, toT),
    loadSales(db, fromT, toT),
    loadCohorts(db, fromT, toT),
    rows<{ campaign_id: string; funnel: string }>(db, 'SELECT campaign_id, funnel FROM econ_campaigns', []),
    rows<{ campaign_id: string; funnel: string }>(db, 'SELECT campaign_id, funnel FROM ad_campaigns', []),
  ]);
  const setMap = new Map(sets.map((s) => [s.campaign_id, s.funnel]));
  const adsMap = new Map(adsF.map((s) => [s.campaign_id, s.funnel]));

  // Campaigns: spend per campaign and its funnel.
  const perCampaign = new Map<string, number>();
  for (const s of sp.spend) perCampaign.set(s.campaign_id, (perCampaign.get(s.campaign_id) ?? 0) + s.spend);
  const campaigns: CampaignInfo[] = [...perCampaign.entries()].map(([id, spend]) => {
    const name = sp.name.get(id) ?? null;
    return { campaign_id: id, name, spend: r2(spend), ...matchCampaign({ campaign_id: id, name }, { set: setMap.get(id), adsFunnel: adsMap.get(id), regs }) };
  }).sort((a, b) => b.spend - a.spend);
  const fOf = new Map(campaigns.map((c) => [c.campaign_id, c.funnel]));
  const matched = sp.spend.filter((s) => isFunnel(fOf.get(s.campaign_id))).map((s) => ({ ...s, funnel: fOf.get(s.campaign_id) as EconFunnel }));
  const unmatchedSpend = r2(campaigns.filter((c) => c.funnel == null).reduce((a, c) => a + c.spend, 0));
  const excludedSpend = r2(campaigns.filter((c) => c.funnel === 'none').reduce((a, c) => a + c.spend, 0));

  // One currency: the one most sales are in (others are counted and left out, never converted).
  const byCur = new Map<string, number>();
  for (const s of rawSales) byCur.set(s.currency, (byCur.get(s.currency) ?? 0) + Math.abs(s.net));
  const currency = ([...byCur.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? (sp.currency ?? 'usd').toLowerCase()).toUpperCase();
  const sales: Sale[] = rawSales.filter((s) => s.currency.toUpperCase() === currency).map((s) => ({ ...s, net: fromMinor(s.net, currency), gross: fromMinor(s.gross, currency) }));
  const otherCurrency = rawSales.length - sales.length;
  const unplaced = sales.filter((s) => !s.funnel);

  const r = rollUp({ spend: matched, sales, cohorts });
  const addon = addonConfig(rt.settings as Partial<Record<string, string>>);
  const fm = fmtMoney(currency);
  const recommendations = r.totals.map((t) => recommend(t.funnel, t, { money: fm, addon: addon ? { name: addon.name, price: addon.price } : null }));
  // Rows with nothing in them (an upcoming event with no spend yet) stay out of the tables.
  const keep = (x: Money) => x.spend > 0 || x.frontEnd !== 0 || x.backEnd !== 0;
  return {
    days, from: fromT, to: toT, currency, spendCurrency: sp.currency, comparable: !sp.currency || sp.currency === currency,
    totals: r.totals, byEvent: r.byEvent.filter(keep), byWeek: r.byWeek.filter(keep),
    campaigns, unmatchedSpend, excludedSpend, otherCurrency,
    unplaced: { n: unplaced.length, net: r2(unplaced.reduce((a, s) => a + s.net, 0)) },
    recommendations,
    addon: addon ? { name: addon.name, price: addon.price, label: addon.label } : null,
  };
}

/** POST /admin/api/economics/campaign { campaign_id, funnel: auto | live | challenge | none | auto-match } */
export async function setEconCampaign(rt: Runtime, campaignId: unknown, funnel: unknown) {
  const id = typeof campaignId === 'string' ? campaignId.trim().slice(0, 120) : '';
  if (!id) return { ok: false, error: 'campaign_id is required' };
  if (funnel === 'match' || funnel === '' || funnel == null) {
    await rt.env.DB.prepare('DELETE FROM econ_campaigns WHERE campaign_id = ?').bind(id).run();
    return { ok: true };
  }
  if (!(isFunnel(funnel) || funnel === 'none')) return { ok: false, error: 'funnel must be auto, live, challenge, none or match' };
  await rt.env.DB.prepare('INSERT INTO econ_campaigns (campaign_id, funnel, updated_at) VALUES (?, ?, ?) ON CONFLICT(campaign_id) DO UPDATE SET funnel = excluded.funnel, updated_at = excluded.updated_at')
    .bind(id, funnel, Date.now()).run();
  return { ok: true };
}
