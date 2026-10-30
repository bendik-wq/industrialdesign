import { test } from "node:test";
import assert from "node:assert/strict";
import { debtSchedule, covenantMetrics, cashForecast, xray, retention, gatekeeper, addMonths, slope } from "../src/crew/maths.js";

// The Part 2 example: $500k EBITDA, $1.5M price, 70% bank at 8% over 7 years, 20% seller note at 5% over 5, 10% rollover.
const deal = { cur: "$", ebitda: 500000, multiple: 3, fcfPct: 100, vf: { pct: 20, years: 5, rate: 5, holiday: 0, io: 0 }, bank: { pct: 70, years: 7, rate: 8 }, roll: { pct: 10 }, inv: { pct: 0, stake: 0 }, own: { pct: 0 } };

test("months and slope", () => {
  assert.equal(addMonths("2026-11", 3), "2027-02");
  assert.equal(slope([1, 2, 3, 4]), 1);
  assert.equal(slope([2, null]), null);
});

test("debt schedule matches the Part 2 repayments", () => {
  const s = debtSchedule(deal, "2026-06");
  const first12 = Object.values(s.byPeriod).slice(0, 12).reduce((t, x) => t + x.total, 0);
  assert.ok(Math.abs(first12 - (196386 + 67936)) < 50, `annual service ${first12}`);
  assert.equal(Object.keys(s.byPeriod)[0], "2026-07");
});

test("covenant metrics: healthy, then a slide that projects a breach", () => {
  const s = debtSchedule(deal, "2026-06");
  const healthy = Array.from({ length: 12 }, (_, i) => ({ period: addMonths("2026-06", i + 1), ebitda: 500000 / 12 }));
  const h = covenantMetrics(healthy, s);
  assert.equal(h.status, "ok");
  assert.ok(Math.abs(h.dscr - 1.89) < 0.02, `dscr ${h.dscr}`);
  // EBITDA falling 3% a month.
  const slide = Array.from({ length: 12 }, (_, i) => ({ period: addMonths("2026-06", i + 1), ebitda: (500000 / 12) * 0.97 ** i }));
  const c = covenantMetrics(slide, s);
  assert.ok(c.trend_per_month < 0);
  assert.ok(c.forward.dscr < c.dscr);
  assert.ok(["warning", "breach"].includes(c.status), c.status);
  assert.ok(c.months_to_breach != null && c.months_to_breach <= 6);
});

test("cash forecast", () => {
  const f = cashForecast({ cash: 100000, monthlyEbitda: 20000, monthlyService: 25000, taxRate: 0.25 });
  assert.ok(f.weekly_net < 0);
  assert.ok(f.weeks_of_cover > 0);
  assert.equal(f.path.length, 13);
});

test("x-ray: proof of cash, tax mismatch, concentration, add-backs, peg", () => {
  const pnl = Array.from({ length: 24 }, (_, i) => ({ period: addMonths("2024-06", i + 1), revenue: 100000, ebitda: 20000 }));
  const bank = Array.from({ length: 24 }, (_, i) => ({ period: addMonths("2024-06", i + 1), deposits: 92000 }));
  const x = xray({ pnl, bank, tax: [{ year: 2025, revenue: 1000000 }], customers: [{ name: "A", revenue: 400000 }, { name: "B", revenue: 300000 }, { name: "C", revenue: 300000 }],
    addbacks: [{ label: "Owner car", amount: 20000, class: "documented" }, { label: "Consulting", amount: 30000, class: "unsupported" }], nwc: [{ period: "2025-12", receivables: 150000, payables: 50000 }, { period: "2025-06", receivables: 130000, payables: 50000 }] });
  const y25 = x.proof_of_cash.find((p) => p.year === "2025");
  assert.equal(y25.gap_pct, -8);
  assert.equal(x.tax_check[0].revenue_gap_pct, 20);
  assert.equal(x.concentration.top1, 40);
  assert.equal(x.concentration.top2, 70);
  assert.equal(x.adjusted_ebitda.base, 260000);
  assert.equal(x.adjusted_ebitda.seller_adjusted, 290000);
  assert.equal(x.working_capital_peg.average, 90000);
});

test("retention: departures, flight risk and lost customers", () => {
  const baseline = [{ name: "Dr Lee", pay: 200000, revenue: 600000 }, { name: "Sam", pay: 90000, revenue: 200000 }, { name: "Ana", pay: 80000, revenue: 200000 }];
  const staff = [{ name: "Dr Lee", pay: 180000, revenue: 450000, start_date: "2015-01-01" }, { name: "Ana", pay: 80000, revenue: 210000, start_date: "2026-03-01" }];
  const r = retention({ staff, baseline, customers: [{ name: "X", revenue: 50 }], baselineCustomers: [{ name: "X", revenue: 100 }, { name: "Y", revenue: 100 }], cliffs: [{ person: "Dr Lee", label: "lock-in ends", date: "2026-12-01" }], today: "2026-10-30" });
  assert.equal(r.staff_retention_pct, 66.67);
  assert.equal(r.departed[0].name, "Sam");
  assert.equal(r.people[0].name, "Dr Lee");
  assert.ok(r.people[0].risk >= 70, `risk ${r.people[0].risk}`);
  assert.equal(r.customer_revenue_retention_pct, 50);
  assert.equal(r.shrinking_customers[0].change_pct, -50);
});

test("gatekeeper: passes a good deal, pauses on capacity, restructures a bad stack", () => {
  const ok = gatekeeper({ portfolio: [{ name: "A", ebitda: 600000, service: 300000 }], candidate: deal, synergyPct: 5, growthPct: 6 });
  assert.equal(ok.verdict, "pursue", JSON.stringify(ok.failed));
  const busy = gatekeeper({ portfolio: [], candidate: deal, backlog: [{ name: "A", days_since_close: 40, open_plan: 12, overdue_plan: 4 }, { name: "B", days_since_close: 90, open_plan: 5, overdue_plan: 8 }] });
  assert.equal(busy.verdict, "pause");
  const bad = gatekeeper({ portfolio: [], candidate: { ...deal, vf: { pct: 70, years: 7, rate: 4 }, bank: { pct: 0 }, roll: { pct: 30 } } });
  assert.equal(bad.verdict, "restructure");
});

test("x-ray groups a July-June year into one financial year", async () => {
  const { fyOf, fyEndOf } = await import("../src/crew/maths.js");
  assert.equal(fyOf("2024-07", 6), "2025");
  assert.equal(fyOf("2025-06", 6), "2025");
  const pnl = ["2024-07","2024-08","2024-09","2024-10","2024-11","2024-12","2025-01","2025-02","2025-03","2025-04","2025-05","2025-06"].map((period) => ({ period, revenue: 100, ebitda: 20 }));
  assert.equal(fyEndOf(pnl), 6);
  const x = xray({ pnl, tax: [{ year: "2025", revenue: 1200 }] });
  assert.equal(x.years.length, 1);
  assert.equal(x.years[0].months, 12);
  assert.equal(x.tax_check[0].revenue_gap_pct, 0);
});

test("board scout scores a seasoned local CFO above a junior out-of-area one", async () => {
  const { scoreCandidate } = await import("../src/crew/maths.js");
  const vet = { firstName: "Paul", lastName: "Perosin", headline: "CFO Private Equity, CEO Private Family Office", city: "Sydney", connectionsCount: 900,
    experience: [{ position: "Chief Financial Officer", companyName: "M&J Chickens", startDate: { year: 2024 }, endDate: { text: "Present" } },
      { position: "Chief Financial Officer", companyName: "Harris Farm Markets", startDate: { year: 2021 }, endDate: { year: 2024 } },
      { position: "Executive Board Member", companyName: "Western Sydney Wanderers FC", startDate: { year: 2014 }, endDate: { year: 2024 } },
      { position: "Finance Manager", companyName: "Retail Co", startDate: { year: 2001 }, endDate: { year: 2014 } }] };
  const junior = { firstName: "A", lastName: "B", headline: "Analyst", city: "Perth", experience: [{ position: "Financial Analyst", companyName: "X", startDate: { year: 2022 }, endDate: { text: "Present" } }] };
  const a = scoreCandidate(vet, "finance", { area: "Sydney", nowYear: 2026 }), b = scoreCandidate(junior, "finance", { area: "Sydney", nowYear: 2026 });
  assert.ok(a.score >= 60, `vet ${a.score} ${a.why}`);
  assert.ok(b.score < 20, `junior ${b.score}`);
  assert.equal(a.board_roles, 1);
  assert.equal(a.career_years, 25);
  const op = scoreCandidate({ ...vet, experience: [{ position: "General Manager", companyName: "Coastal Physiotherapy", startDate: { year: 2010 }, endDate: { text: "Present" } }] }, "sector", { area: "Sydney", sector: "physio, allied health", nowYear: 2026 });
  assert.ok(op.score >= 40, `sector ${op.score} ${op.why}`);
});

test("board scout counts overlapping roles once", async () => {
  const { scoreCandidate } = await import("../src/crew/maths.js");
  const p = { firstName: "J", lastName: "B", city: "New York", experience: [
    { position: "CEO", companyName: "A", startDate: { year: 1990 }, endDate: { year: 2010 } },
    { position: "Managing Director", companyName: "B", startDate: { year: 2000 }, endDate: { year: 2015 } }] };
  assert.equal(scoreCandidate(p, "chair", { area: "New York", nowYear: 2026 }).seat_years, 25);
});
