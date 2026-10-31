// Deterministic maths for the crew. The model interprets these numbers; it never produces them.
import { dealModel, loanSchedule, normalizeDeal, multipleFor } from "../../public/js/deal.js";

// Buckets of many small customers aren't a concentration risk: "Residential (various)", "Other", "Cash sales".
export const isBucket = (name) => /\b(various|other|others|misc|sundry|cash sales|residential|private patients|walk-?ins?|retail customers|general)\b/i.test(String(name || ""));
const r2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);
const r0 = (n) => (Number.isFinite(n) ? Math.round(n) : null);
const sum = (a) => a.reduce((t, v) => t + (Number(v) || 0), 0);
const avg = (a) => (a.length ? sum(a) / a.length : null);
export const JL_DSCR = 1.5; // the skill's floor: "Maintain 1.5x Debt Service Coverage Ratio minimum"
export const EARLY_WARNING = 1.15; // alert while still 15% above the covenant (lender practice: warn 10-15% above)

export function addMonths(period, n) {
  const [y, m] = period.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
export const monthsBetween = (a, b) => { const [ya, ma] = a.split("-").map(Number), [yb, mb] = b.split("-").map(Number); return (yb - ya) * 12 + (mb - ma); };

// Least-squares slope per step.
export function slope(ys) {
  const pts = ys.map((y, x) => [x, y]).filter(([, y]) => Number.isFinite(y));
  if (pts.length < 3) return null;
  const n = pts.length, mx = sum(pts.map((p) => p[0])) / n, my = sum(pts.map((p) => p[1])) / n;
  const den = sum(pts.map(([x]) => (x - mx) ** 2));
  return den ? sum(pts.map(([x, y]) => (x - mx) * (y - my))) / den : null;
}

// ── debt ────────────────────────────────────────────────────────────────────
// Monthly scheduled debt service for a deal, keyed by period, starting the month after close.
export function debtSchedule(dealIn, closePeriod, months = 84, { rateBump = 0 } = {}) {
  const d = normalizeDeal(dealIn);
  const m = dealModel(d);
  const horizon = Math.max(months, 12);
  const vf = loanSchedule(m.amt.vf, d.vf.rate, d.vf.years, d.vf.holiday, d.vf.io, horizon);
  const bank = loanSchedule(m.amt.bank, d.bank.rate + rateBump, d.bank.years, 0, 0, horizon);
  const out = {};
  for (let i = 0; i < horizon; i++) out[addMonths(closePeriod, i + 1)] = { vf: vf.pay[i], bank: bank.pay[i], total: vf.pay[i] + bank.pay[i], balance: vf.bal[i] + bank.bal[i] };
  return { byPeriod: out, price: m.price, amounts: { vf: m.amt.vf, bank: m.amt.bank, roll: m.amt.roll }, structure: d };
}

// ── covenant ────────────────────────────────────────────────────────────────
// actuals: [{period, ebitda, cash, revenue, debt_service?}] oldest first. Uses actual debt_service where recorded,
// scheduled service otherwise. DSCR = trailing EBITDA / trailing debt service (annualised when <12 months).
export function covenantMetrics(actuals, schedule, { covenant = JL_DSCR } = {}) {
  const rows = actuals.filter((a) => Number.isFinite(a.ebitda)).map((a) => ({ ...a, service: Number.isFinite(a.debt_service) && a.debt_service > 0 ? a.debt_service : schedule.byPeriod[a.period]?.total ?? 0 }));
  if (!rows.length) return { months: 0 };
  const ttm = rows.slice(-12);
  const ebitda = sum(ttm.map((r) => r.ebitda)), service = sum(ttm.map((r) => r.service));
  const annualise = 12 / ttm.length;
  const dscr = service > 0 ? ebitda / service : null;
  // Rolling 3-month DSCR series for the trend.
  const series = rows.map((_, i) => {
    const w = rows.slice(Math.max(0, i - 2), i + 1);
    const s = sum(w.map((r) => r.service));
    return { period: rows[i].period, dscr: s > 0 && w.length === 3 ? r2(sum(w.map((r) => r.ebitda)) / s) : null };
  });
  const recent = series.slice(-9).map((s) => s.dscr);
  const trend = slope(recent);
  const last = series.filter((s) => s.dscr != null).at(-1)?.dscr ?? dscr;
  let monthsToBreach = null;
  if (trend != null && trend < 0 && last != null && last > covenant) monthsToBreach = Math.ceil((last - covenant) / -trend);
  if (last != null && last <= covenant) monthsToBreach = 0;
  // Forward view: next 12 months of scheduled service against the trailing run-rate EBITDA.
  const lastPeriod = rows.at(-1).period;
  const fwdService = sum(Array.from({ length: 12 }, (_, i) => schedule.byPeriod[addMonths(lastPeriod, i + 1)]?.total ?? 0));
  const runRate = avg(rows.slice(-3).map((r) => r.ebitda)) * 12;
  const fwd = fwdService > 0 ? runRate / fwdService : null;
  // Stress: EBITDA -10% / -20% on the forward service.
  const stress = fwdService > 0 ? { minus10: r2((runRate * 0.9) / fwdService), minus20: r2((runRate * 0.8) / fwdService) } : null;
  const maxService = (ebitda * annualise) / covenant;
  return {
    months: rows.length, covenant, warn_at: r2(covenant * EARLY_WARNING), last_period: lastPeriod,
    ttm_ebitda: r0(ebitda * annualise), ttm_service: r0(service * annualise), annualised: ttm.length < 12,
    dscr: r2(dscr), rolling_dscr: last, trend_per_month: trend == null ? null : Math.round(trend * 1000) / 1000, months_to_breach: monthsToBreach,
    headroom_pct: dscr ? r2(((dscr - covenant) / covenant) * 100) : null,
    max_service_at_covenant: r0(maxService), service_headroom: r0(maxService - service * annualise),
    forward: { run_rate_ebitda: r0(runRate), next12_service: r0(fwdService), dscr: r2(fwd), stress },
    series: series.slice(-18),
    status: dscr == null ? "no_debt" : dscr < covenant ? "breach" : dscr < covenant * EARLY_WARNING || (monthsToBreach != null && monthsToBreach <= 6) ? "warning" : "ok",
  };
}

// 13-week cash: opening cash, weekly run-rate cash generation (EBITDA less tax set-aside), weekly debt service.
export function cashForecast({ cash, monthlyEbitda, monthlyService, taxRate = 0.25, weeks = 13 }) {
  if (!Number.isFinite(cash)) return null;
  const wkIn = ((monthlyEbitda || 0) * (1 - taxRate) * 12) / 52, wkOut = ((monthlyService || 0) * 12) / 52;
  const path = [];
  let c = cash;
  for (let w = 1; w <= weeks; w++) { c += wkIn - wkOut; path.push(r0(c)); }
  const burn = wkOut - wkIn;
  return { opening: r0(cash), weekly_net: r0(wkIn - wkOut), week13: path.at(-1), low: Math.min(...path), path, weeks_of_cover: burn > 0 ? r2(cash / burn) : null };
}

// ── earnings x-ray ──────────────────────────────────────────────────────────
// pnl: [{period (YYYY or YYYY-MM), revenue, ebitda, wages?, owner_pay?}]; bank: [{period, deposits}];
// tax: [{year, revenue, net_profit}]; customers: [{name, revenue}]; addbacks: [{label, amount, class}]; nwc: [{period, receivables, inventory, payables}]
// Which financial year a period belongs to. Monthly books are grouped into years ending in `fyEnd` (1-12): an
// Australian July-June year has fyEnd 6, so 2024-07 belongs to FY2025. Annual periods (YYYY) are already years.
export function fyOf(period, fyEnd = 12) {
  const p = String(period);
  if (p.length < 7) return p.slice(0, 4);
  const y = +p.slice(0, 4), m = +p.slice(5, 7);
  return String(m > fyEnd ? y + 1 : y);
}
// The year-end month: the last month of the monthly P&L when it covers a run of 12+ months, else December.
export function fyEndOf(pnl) {
  const months = pnl.map((r) => String(r.period)).filter((p) => p.length >= 7).sort();
  return months.length >= 12 ? +months.at(-1).slice(5, 7) : 12;
}

export function xray({ pnl = [], bank = [], tax = [], customers = [], addbacks = [], nwc = [], gst = false, fyEnd = fyEndOf(pnl) }) {
  const byYear = {};
  for (const r of pnl) {
    const y = fyOf(r.period, fyEnd);
    byYear[y] ??= { revenue: 0, ebitda: 0, months: 0 };
    byYear[y].revenue += Number(r.revenue) || 0; byYear[y].ebitda += Number(r.ebitda) || 0; byYear[y].months += String(r.period).length === 7 ? 1 : 12;
  }
  const years = Object.keys(byYear).sort().map((y) => ({ year: y, ...byYear[y], margin: byYear[y].revenue ? r2((byYear[y].ebitda / byYear[y].revenue) * 100) : null }));
  const full = years.filter((y) => y.months >= 12);
  const latest = full.at(-1) || years.at(-1) || null;
  // Proof of cash: bank deposits vs P&L revenue over the same periods (deposits include GST when registered).
  const depByYear = {};
  for (const b of bank) { const y = fyOf(b.period, fyEnd); depByYear[y] = (depByYear[y] || 0) + (Number(b.deposits) || 0); }
  const proof = Object.keys(depByYear).filter((y) => byYear[y]).map((y) => {
    const expected = byYear[y].revenue * (gst ? 1.1 : 1);
    return { year: y, deposits: r0(depByYear[y]), revenue: r0(byYear[y].revenue), expected_deposits: r0(expected), gap_pct: expected ? r2(((depByYear[y] - expected) / expected) * 100) : null };
  });
  const taxCheck = tax.filter((t) => byYear[String(t.year)]).map((t) => {
    const p = byYear[String(t.year)];
    return { year: String(t.year), pnl_revenue: r0(p.revenue), tax_revenue: r0(t.revenue), revenue_gap_pct: t.revenue ? r2(((p.revenue - t.revenue) / t.revenue) * 100) : null };
  });
  // Customer concentration (skill: 1-2 entities >30% = red flag; >50% = walk or heavily discount).
  const custTotal = sum(customers.map((c) => c.revenue));
  const sorted = customers.filter((c) => !isBucket(c.name)).sort((a, b) => b.revenue - a.revenue);
  const share = (n) => (custTotal ? r2((sum(sorted.slice(0, n).map((c) => c.revenue)) / custTotal) * 100) : null);
  const concentration = customers.length ? { customers: customers.length, top1: share(1), top2: share(2), top5: share(5), top1_name: sorted[0]?.name, total: r0(custTotal) } : null;
  // Add-backs: share of reported EBITDA by class.
  const reported = latest?.ebitda ?? null;
  const byClass = { documented: 0, recurring: 0, unsupported: 0, unclassified: 0 };
  for (const a of addbacks) byClass[["documented", "recurring", "unsupported"].includes(a.class) ? a.class : "unclassified"] += Number(a.amount) || 0;
  const claimed = sum(Object.values(byClass));
  const adjusted = reported == null ? null : { reported: r0(reported), claimed_addbacks: r0(claimed), seller_adjusted: r0(reported + claimed), low: r0(reported), base: r0(reported + byClass.documented), high: r0(reported + byClass.documented + byClass.unclassified), addback_share_pct: reported ? r2((claimed / reported) * 100) : null, by_class: Object.fromEntries(Object.entries(byClass).map(([k, v]) => [k, r0(v)])) };
  // Working capital peg: average of the periods given.
  const nwcRows = nwc.map((n) => ({ period: n.period, nwc: (Number(n.receivables) || 0) + (Number(n.inventory) || 0) - (Number(n.payables) || 0) }));
  const peg = nwcRows.length ? { periods: nwcRows.length, average: r0(avg(nwcRows.map((n) => n.nwc))), min: r0(Math.min(...nwcRows.map((n) => n.nwc))), max: r0(Math.max(...nwcRows.map((n) => n.nwc))) } : null;
  const marginTrend = full.length >= 2 ? r2(full.at(-1).margin - full[0].margin) : null;
  const revenueGrowth = full.length >= 2 && full.at(-2).revenue ? r2(((full.at(-1).revenue - full.at(-2).revenue) / full.at(-2).revenue) * 100) : null;
  return { fy_end_month: fyEnd, years, latest_year: latest?.year ?? null, revenue_growth_pct: revenueGrowth, margin_change_pts: marginTrend, proof_of_cash: proof, tax_check: taxCheck, concentration, adjusted_ebitda: adjusted, working_capital_peg: peg };
}

// ── retention ───────────────────────────────────────────────────────────────
// staff: [{name, role, start_date, pay, revenue}]; baseline: the same shape at close (or null).
// customers: [{name, revenue}] for the latest period; baselineCustomers: at close.
export function retention({ staff = [], baseline = null, customers = [], baselineCustomers = null, cliffs = [], today = new Date().toISOString().slice(0, 10) }) {
  const key = (s) => String(s.name || "").trim().toLowerCase();
  const totalRev = sum(staff.map((s) => s.revenue));
  const base = new Map((baseline || []).map((s) => [key(s), s]));
  const people = staff.map((s) => {
    const b = base.get(key(s));
    const share = totalRev ? (Number(s.revenue) || 0) / totalRev : 0;
    const payChange = b && b.pay ? ((Number(s.pay) || 0) - b.pay) / b.pay : null;
    const revChange = b && b.revenue ? ((Number(s.revenue) || 0) - b.revenue) / b.revenue : null;
    const tenureYears = s.start_date ? (Date.parse(today) - Date.parse(s.start_date)) / 3.156e10 : null;
    const cliff = cliffs.filter((c) => !c.person || key(c) === key(s) || String(c.person).toLowerCase() === key(s)).map((c) => ({ ...c, days: Math.round((Date.parse(c.date) - Date.parse(today)) / 864e5) })).filter((c) => c.days >= 0 && c.days <= 120).sort((a, b) => a.days - b.days)[0] || null;
    // Flight-risk points, each tied to an evidence-based driver: production falling, pay cut, a lock-in or earn-out
    // ending, a big share of revenue walking out with them, and short tenure.
    let score = 0;
    const why = [];
    if (revChange != null && revChange <= -0.1) { score += revChange <= -0.2 ? 30 : 20; why.push(`production ${r2(revChange * 100)}% vs close`); }
    if (payChange != null && payChange <= -0.05) { score += 25; why.push(`pay ${r2(payChange * 100)}% vs close`); }
    if (cliff) { score += cliff.days <= 60 ? 25 : 15; why.push(`${cliff.label || "cliff"} in ${cliff.days} days`); }
    if (share >= 0.2) { score += 20; why.push(`${r2(share * 100)}% of revenue`); }
    if (tenureYears != null && tenureYears < 1) { score += 10; why.push("under a year in the job"); }
    return { name: s.name, role: s.role || "", revenue_share_pct: r2(share * 100), pay_change_pct: payChange == null ? null : r2(payChange * 100), production_change_pct: revChange == null ? null : r2(revChange * 100), tenure_years: tenureYears == null ? null : r2(tenureYears), cliff, risk: Math.min(100, score), why };
  }).sort((a, b) => b.risk - a.risk);
  const now = new Set(staff.map(key));
  const departed = baseline ? baseline.filter((b) => !now.has(key(b))).map((b) => ({ name: b.name, role: b.role || "", revenue: r0(b.revenue) })) : [];
  const departedRevenue = sum(departed.map((d) => d.revenue));
  const baseRevStaff = sum((baseline || []).map((b) => b.revenue));
  // Customers: lost, shrinking and concentration vs close.
  const ck = (c) => String(c.name || "").trim().toLowerCase();
  const cNow = new Map(customers.map((c) => [ck(c), c]));
  let lost = [], shrinking = [];
  if (baselineCustomers) {
    lost = baselineCustomers.filter((b) => !cNow.has(ck(b))).map((b) => ({ name: b.name, revenue_at_close: r0(b.revenue) })).sort((a, b) => b.revenue_at_close - a.revenue_at_close);
    shrinking = baselineCustomers.filter((b) => cNow.has(ck(b)) && b.revenue > 0).map((b) => ({ name: b.name, at_close: r0(b.revenue), now: r0(cNow.get(ck(b)).revenue), change_pct: r2(((cNow.get(ck(b)).revenue - b.revenue) / b.revenue) * 100) })).filter((x) => x.change_pct <= -20).sort((a, b) => a.change_pct - b.change_pct);
  }
  const baseCustRev = sum((baselineCustomers || []).map((c) => c.revenue));
  const lostRev = sum(lost.map((l) => l.revenue_at_close));
  const custTotal = sum(customers.map((c) => c.revenue));
  const top = customers.filter((c) => !isBucket(c.name)).sort((a, b) => b.revenue - a.revenue);
  return {
    staff_count: staff.length, baseline_staff: baseline ? baseline.length : null,
    staff_retention_pct: baseline && baseline.length ? r2((1 - departed.length / baseline.length) * 100) : null,
    departed, departed_revenue_share_pct: baseRevStaff ? r2((departedRevenue / baseRevStaff) * 100) : null,
    at_risk: people.filter((p) => p.risk >= 40), people: people.slice(0, 30),
    customers: customers.length, baseline_customers: baselineCustomers ? baselineCustomers.length : null,
    customer_revenue_retention_pct: baseCustRev ? r2(((baseCustRev - lostRev) / baseCustRev) * 100) : null,
    lost_customers: lost.slice(0, 15), shrinking_customers: shrinking.slice(0, 15),
    top1_share_pct: custTotal ? r2(((top[0]?.revenue || 0) / custTotal) * 100) : null, top1_name: top[0]?.name || null,
  };
}

// ── gatekeeper ──────────────────────────────────────────────────────────────
// portfolio: [{name, ebitda, service}] annual; candidate: a deal; backlog: [{name, days_since_close, open_plan, overdue_plan}]
export function gatekeeper({ portfolio = [], candidate, backlog = [], highAlerts = 0, synergyPct = 0, growthPct = 0, cur = "$" }) {
  const d = normalizeDeal(candidate);
  const m = dealModel(d);
  const y1 = m.years[0] || { service: 0 };
  const groupEbitda = sum(portfolio.map((p) => p.ebitda)) + d.ebitda;
  const groupService = sum(portfolio.map((p) => p.service)) + y1.service;
  const groupDscr = groupService > 0 ? groupEbitda / groupService : null;
  const existingDscr = sum(portfolio.map((p) => p.service)) > 0 ? sum(portfolio.map((p) => p.ebitda)) / sum(portfolio.map((p) => p.service)) : null;
  // Value bridge over 5 years: where the value comes from. Buy at the deal multiple; the combined group is worth the
  // platform multiple for its size; synergy and organic growth add EBITDA.
  const buyMultiple = d.multiple;
  const platformMultiple = multipleFor(groupEbitda, cur);
  const arbitrage = d.ebitda * Math.max(0, platformMultiple - buyMultiple);
  const synergy = d.ebitda * (synergyPct / 100) * platformMultiple;
  const organic = d.ebitda * ((1 + growthPct / 100) ** 5 - 1) * platformMultiple;
  const created = arbitrage + synergy + organic;
  const arbitrageShare = created > 0 ? arbitrage / created : null;
  const unintegrated = backlog.filter((b) => b.days_since_close <= 180 && b.open_plan > 0);
  const overdue = sum(backlog.map((b) => b.overdue_plan || 0));
  const loadIndex = unintegrated.length * 2 + Math.ceil(overdue / 5);
  const checks = [
    { id: "deal_dscr", pass: m.minDscr == null || m.minDscr >= JL_DSCR, label: "This deal covers its own debt at 1.5x", value: r2(m.minDscr) },
    { id: "group_dscr", pass: groupDscr == null || groupDscr >= JL_DSCR, label: "The group still covers all its debt at 1.5x", value: r2(groupDscr) },
    { id: "library", pass: m.library.ok, label: "Structure is from the structure library", value: m.library.ok ? "yes" : m.library.issues?.join("; ") || "no" },
    { id: "control", pass: m.control, label: "You keep control", value: r2(m.yourVotes) },
    { id: "capacity", pass: unintegrated.length < 2 && overdue < 10, label: "Integration capacity: fewer than 2 businesses still integrating and under 10 overdue plan items", value: `${unintegrated.length} integrating, ${overdue} overdue` },
    { id: "alerts", pass: highAlerts === 0, label: "No open high-severity alert on a business you already own", value: highAlerts },
    { id: "arbitrage", pass: arbitrageShare == null || arbitrageShare <= 0.6, label: "No more than 60% of the value relies on multiple arbitrage", value: arbitrageShare == null ? null : r2(arbitrageShare * 100) },
  ];
  const failed = checks.filter((c) => !c.pass).map((c) => c.id);
  const verdict = failed.some((f) => ["deal_dscr", "group_dscr", "library", "control"].includes(f)) ? "restructure" : failed.length ? "pause" : "pursue";
  return {
    verdict, failed, checks,
    deal: { price: r0(m.price), ebitda: r0(d.ebitda), multiple: d.multiple, min_dscr: r2(m.minDscr), max_price_at_1_5x: r0(m.maxPrice), year1_service: r0(y1.service) },
    group: { businesses: portfolio.length + 1, ebitda: r0(groupEbitda), service: r0(groupService), dscr: r2(groupDscr), dscr_before: r2(existingDscr), max_service_at_1_5x: r0(groupEbitda / JL_DSCR), service_headroom: r0(groupEbitda / JL_DSCR - groupService) },
    value_bridge: { buy_multiple: buyMultiple, platform_multiple: platformMultiple, arbitrage: r0(arbitrage), synergy: r0(synergy), organic: r0(organic), arbitrage_share_pct: arbitrageShare == null ? null : r2(arbitrageShare * 100), synergy_pct: synergyPct, growth_pct: growthPct },
    integration: { integrating: unintegrated.map((b) => b.name), overdue_items: overdue, load_index: loadIndex },
  };
}

// ── board scout ─────────────────────────────────────────────────────────────
// Credibility scoring for board candidates against the skill's four seats:
//   Chair: "Former executive or industry titan for credibility"; Finance Lead: "CFO/credit veteran who understands deal
//   structures"; Legal Lead: "M&A attorney or former general counsel"; Sector Operator: "Industry expert with
//   operational experience". Recruitment targets "recently retired executives looking for meaningful involvement".
export const SEAT_RULES = {
  chair: { must: /\b(ceo|chief executive|managing director|\bmd\b|president|chair(man|woman|person)?|founder|group executive|general manager)\b/i, bonus: /\b(board|non-?executive|director|chair)\b/i },
  finance: { must: /\b(cfo|chief financial|finance director|financial controller|head of finance|credit|lending|banker|banking|transaction services|corporate finance|m&a|private equity|investment director)\b/i, bonus: /\b(ca|cpa|fca|cfa|chartered accountant|m&a|acquisition|transaction|deal|credit|private equity|investment)\b/i },
  legal: { must: /\b(general counsel|legal counsel|lawyer|solicitor|attorney|partner|barrister|head of legal|chief legal)\b/i, bonus: /\b(m&a|mergers|acquisitions|corporate|commercial|transaction)\b/i },
  sector: { must: /\b(ceo|coo|chief operating|general manager|operations|managing director|owner|founder|director|head of|practice manager|principal)\b/i, bonus: null },
};
const yearOf = (d) => Number(d?.year) || (/(\d{4})/.exec(d?.text || "")?.[1] ? Number(/(\d{4})/.exec(d.text)[1]) : null);
const ongoing = (j) => !j.endDate || /present/i.test(j.endDate.text || "");

// p: a LinkedIn profile ({firstName, lastName, headline, city, location, url, connectionsCount, experience: [{position,
// companyName, startDate, endDate}], currentPosition}); seat: chair | finance | legal | sector; ctx: {area, sectorRe}.
export function scoreCandidate(p, seat, { area = "", sector = "", nowYear = new Date().getUTCFullYear() } = {}) {
  const rule = SEAT_RULES[seat];
  const exp = (p.experience || []).filter((j) => j && j.position);
  const text = (j) => `${j.position} ${j.companyName || ""}`;
  const starts = exp.map((j) => yearOf(j.startDate)).filter(Boolean);
  const career = starts.length ? nowYear - Math.min(...starts) : null;
  const seatRoles = exp.filter((j) => rule.must.test(text(j)) || (seat === "finance" && /\bfinance\b/i.test(j.position)));
  // Years in seat-relevant roles, overlapping roles counted once (a CEO who is also a director isn't two careers).
  const spans = seatRoles.map((j) => [yearOf(j.startDate), ongoing(j) ? nowYear : yearOf(j.endDate)]).filter(([a, b]) => a && b && b >= a).sort((x, y) => x[0] - y[0]);
  let seatYears = 0, edge = -Infinity;
  for (const [a, b] of spans) { const from = Math.max(a, edge); if (b > from) seatYears += b - from; edge = Math.max(edge, b); }
  const board = exp.filter((j) => /\b(board|non-?executive|chair|director of the board|advisory board|trustee)\b/i.test(j.position));
  const sectorRe = sector ? new RegExp(`\\b(${sector.split(/[,/|]+/).map((s) => s.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).filter(Boolean).join("|")})`, "i") : null;
  const sectorHits = sectorRe ? exp.filter((j) => sectorRe.test(`${text(j)} ${j.description || ""}`)).length + (sectorRe.test(p.headline || "") ? 1 : 0) : 0;
  const current = exp.filter(ongoing);
  // "Recently retired, looking for meaningful involvement": advisory/independent/board-only today, or a recent exit.
  const available = /\b(retired|semi-retired|independent|adviser|advisor|consultant|non-?executive|portfolio|board member|gaicd)\b/i.test(`${p.headline || ""} ${current.map((j) => j.position).join(" ")}`) || p.openToWork === true;
  const local = area ? new RegExp(area.split(/[,\s]+/)[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(`${p.city || ""} ${p.location || ""} ${p.state || ""}`) : true;
  const designations = /\b(gaicd|faicd|fca|ca|cpa|cfa|llb|jd|mba)\b/i.test(`${p.firstName} ${p.lastName} ${p.headline || ""}`);
  let score = 0;
  const why = [];
  if (seatRoles.length) { score += Math.min(35, 15 + seatYears * 2); why.push(`${seatYears} yr${seatYears === 1 ? "" : "s"} in ${seat === "chair" ? "chief-executive" : seat === "finance" ? "CFO/finance/credit" : seat === "legal" ? "legal/counsel" : "operating"} roles`); }
  if (rule.bonus && exp.some((j) => rule.bonus.test(text(j)) || rule.bonus.test(p.headline || ""))) { score += 8; why.push(seat === "chair" ? "board seats held" : seat === "finance" ? "deal or credit experience" : seat === "legal" ? "M&A or corporate law" : ""); }
  if (board.length) { score += Math.min(15, board.length * 5); why.push(`${board.length} board/non-exec role${board.length === 1 ? "" : "s"}`); }
  if (career != null) { score += career >= 25 ? 12 : career >= 15 ? 8 : career >= 10 ? 4 : 0; if (career >= 15) why.push(`${career}-year career`); }
  if (sectorHits) { score += Math.min(15, sectorHits * 5) * (seat === "sector" ? 2 : 1); why.push(`${sectorHits} role${sectorHits === 1 ? "" : "s"} in ${sector}`); }
  if (available) { score += 8; why.push("advisory/independent now: open to involvement"); }
  if (designations) { score += 4; why.push("professional designation"); }
  if ((p.connectionsCount || 0) >= 500) { score += 3; }
  if (!local) score -= 15;
  if (seat === "sector" && !sectorHits) score -= 20;
  if (!seatRoles.length) score -= 25;
  return {
    seat, score: Math.max(0, Math.min(100, Math.round(score))), why: why.filter(Boolean),
    name: [p.firstName, p.lastName].filter(Boolean).join(" ").trim(), headline: p.headline || "", location: [p.city, p.state, p.country].filter(Boolean).join(", ") || p.location || "",
    url: p.url || "", connections: p.connectionsCount ?? null, career_years: career, seat_years: seatYears, board_roles: board.length, available, local,
    current: current.slice(0, 2).map((j) => `${j.position} @ ${j.companyName || "?"}`),
    roles: exp.slice(0, 8).map((j) => `${j.position} @ ${j.companyName || "?"} (${j.startDate?.text || "?"}–${j.endDate?.text || "?"})`),
  };
}
