// Deal engine, shared by the browser (Deal Builder, Value Ladder, pipeline) and the Worker (LOIs, board packs).
// Pure functions only: no DOM, no storage.
// A deal is a capital stack: vendor finance, commercial debt, seller rollover, investor capital, own cash.
// Any mix works as long as the buyer keeps majority control and DSCR >= 1.5 in every year.

export const CURS = ["$", "€", "£", "NOK "];
export const ELEMENTS = [
  { k: "vf", label: "Vendor finance", short: "Seller note", debt: true },
  { k: "bank", label: "Commercial debt", short: "Bank", debt: true },
  { k: "roll", label: "Seller rollover", short: "Rollover", equity: true },
  { k: "inv", label: "Investor capital", short: "Investors", equity: true },
  { k: "own", label: "Your cash", short: "Your cash" },
];
export const DEAL_DEFAULTS = {
  cur: "$", ebitda: 600000, multiple: 3, fcfPct: 80, nonVoting: true,
  vf: { pct: 100, years: 7, rate: 4, holiday: 0, io: 0 },
  bank: { pct: 0, years: 7, rate: 8 },
  roll: { pct: 0 }, inv: { pct: 0, stake: 0 }, own: { pct: 0 },
};
export const PRESETS = {
  vanilla: { name: "100% vendor finance", note: "Josh's first deal: the whole price paid to the seller over 7 years at 4%.", set: { vf: { pct: 100, years: 7, rate: 4, holiday: 0, io: 0 }, bank: { pct: 0, years: 5, rate: 8 }, roll: { pct: 0 }, inv: { pct: 0, stake: 0 }, own: { pct: 0 } } },
  blend: { name: "Bank + vendor note", note: "Bank funds what it will, the seller carries the rest, subordinated to the bank.", set: { vf: { pct: 40, years: 7, rate: 6, holiday: 6, io: 0 }, bank: { pct: 60, years: 7, rate: 8 }, roll: { pct: 0 }, inv: { pct: 0, stake: 0 }, own: { pct: 0 } } },
  asset: { name: "60/40 asset-backed", note: "Asset-heavy business: 60% commercial debt secured on the assets, 40% seller rollover.", set: { vf: { pct: 0, years: 7, rate: 4, holiday: 0, io: 0 }, bank: { pct: 60, years: 7, rate: 7.5 }, roll: { pct: 40 }, inv: { pct: 0, stake: 0 }, own: { pct: 0 } } },
  hallelujah: { name: "Hallelujah", note: "Interest-only to the seller for years, then a balloon (refinanced).", set: { vf: { pct: 100, years: 10, rate: 7, holiday: 0, io: 120 }, bank: { pct: 0, years: 5, rate: 8 }, roll: { pct: 0 }, inv: { pct: 0, stake: 0 }, own: { pct: 0 } } },
};

const n = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
// Fill in anything missing and coerce numbers, so stored or API-supplied deals can't break the model.
export function normalizeDeal(d = {}) {
  const D = DEAL_DEFAULTS;
  return {
    cur: CURS.includes(d.cur) ? d.cur : D.cur,
    ebitda: Math.max(0, n(d.ebitda, D.ebitda)), multiple: Math.min(30, Math.max(0.1, n(d.multiple, D.multiple))),
    fcfPct: Math.min(100, Math.max(1, n(d.fcfPct, D.fcfPct))), nonVoting: d.nonVoting ?? D.nonVoting,
    vf: { pct: n(d.vf?.pct, D.vf.pct), years: Math.min(99, Math.max(0.5, n(d.vf?.years, D.vf.years))), rate: n(d.vf?.rate, D.vf.rate), holiday: Math.max(0, n(d.vf?.holiday, 0)), io: Math.max(0, n(d.vf?.io, 0)) },
    bank: { pct: n(d.bank?.pct, D.bank.pct), years: Math.min(40, Math.max(0.5, n(d.bank?.years, D.bank.years))), rate: n(d.bank?.rate, D.bank.rate) },
    roll: { pct: n(d.roll?.pct, 0) }, inv: { pct: n(d.inv?.pct, 0), stake: n(d.inv?.stake, 0) }, own: { pct: n(d.own?.pct, 0) },
  };
}

// Monthly schedule for an amortising loan with an optional payment holiday and interest-only period.
export function loanSchedule(P, ratePct, years, holiday = 0, io = 0, horizon = 120) {
  const r = ratePct / 1200, nm = Math.round(years * 12);
  const pay = [], bal = [];
  let b = P;
  const amortMonths = Math.max(1, nm - holiday - io);
  const amort = b <= 0 ? 0 : r === 0 ? b / amortMonths : (b * r) / (1 - (1 + r) ** -amortMonths);
  for (let m = 1; m <= horizon; m++) {
    let p = 0;
    if (b > 0.5 && m <= nm) {
      if (m <= holiday) p = 0; // no payments, no interest during the holiday (the way Josh negotiates it)
      else if (m <= holiday + io) p = b * r;
      else { const interest = b * r; p = Math.min(amort, b + interest); b -= p - interest; }
      if (m === nm && b > 0.5) { p += b; b = 0; } // balloon: whatever is left at term
    }
    pay.push(p); bal.push(Math.max(0, b));
  }
  return { pay, bal };
}

export function dealModel(d, ebitda = d.ebitda, multiple = d.multiple) {
  const price = ebitda * multiple;
  const amt = Object.fromEntries(ELEMENTS.map((e) => [e.k, (price * (Number(d[e.k].pct) || 0)) / 100]));
  const allocated = ELEMENTS.reduce((t, e) => t + (Number(d[e.k].pct) || 0), 0);
  const horizon = Math.max(12, Math.round(Math.max(d.vf.years, d.bank.years, 1) * 12));
  const vf = loanSchedule(amt.vf, d.vf.rate, d.vf.years, d.vf.holiday, d.vf.io, horizon);
  const bank = loanSchedule(amt.bank, d.bank.rate, d.bank.years, 0, 0, horizon);
  const fcf = (ebitda * d.fcfPct) / 100;
  const years = [];
  for (let y = 0; y < horizon / 12; y++) {
    const sl = (a) => a.slice(y * 12, y * 12 + 12).reduce((t, v) => t + v, 0);
    const v = sl(vf.pay), bk = sl(bank.pay), service = v + bk;
    years.push({ y: y + 1, vf: v, bank: bk, service, dscr: service > 0 ? fcf / service : null, debtLeft: (vf.bal[y * 12 + 11] || 0) + (bank.bal[y * 12 + 11] || 0) });
  }
  const serviced = years.filter((x) => x.dscr != null);
  const minDscr = serviced.length ? Math.min(...serviced.map((x) => x.dscr)) : null;
  const sellerStake = Number(d.roll.pct) || 0, investorStake = Number(d.inv.stake) || 0;
  const yourEconomic = Math.max(0, 100 - sellerStake - investorStake);
  const yourVotes = d.nonVoting ? 100 : yourEconomic;
  const control = yourVotes > 50;
  const bankable = minDscr == null || minDscr >= 1.5;
  const complete = Math.abs(allocated - 100) < 0.01;
  return {
    price, amt, allocated, complete, years, minDscr, fcf, yourEconomic, yourVotes, control, bankable,
    cashFromYou: amt.own, cashAtClose: amt.bank + amt.inv + amt.own,
    maxPrice: minDscr ? price * Math.min(minDscr / 1.5, 3) : null,
    works: complete && control && bankable,
  };
}

// Highest multiple this stack can pay while keeping DSCR >= 1.5 every year (binary search on the model).
export function maxMultiple(d) {
  let lo = 0.1, hi = 20;
  if (dealModel(d, d.ebitda, lo).minDscr != null && dealModel(d, d.ebitda, lo).minDscr < 1.5) return null;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2, m = dealModel(d, d.ebitda, mid);
    if (m.minDscr == null || m.minDscr >= 1.5) lo = mid; else hi = mid;
  }
  return Math.floor(lo * 100) / 100;
}

export function money(v, cur = "$") {
  if (v == null || !Number.isFinite(Number(v))) return "–";
  const a = Math.abs(v), s = v < 0 ? "−" : "";
  return `${s}${cur}${a >= 1e9 ? (a / 1e9).toFixed(1) + "B" : a >= 1e6 ? (a / 1e6).toFixed(2).replace(/\.?0+$/, "") + "M" : a >= 1e3 ? Math.round(a / 1e3) + "k" : Math.round(a)}`;
}
export const pct = (v) => `${Math.round(v * 10) / 10}%`;

export function structureSummary(d, m) {
  const parts = ELEMENTS.filter((e) => d[e.k].pct > 0).map((e) => {
    if (e.k === "vf") return `${d.vf.pct}% vendor finance (${d.vf.years} yrs at ${d.vf.rate}%${d.vf.holiday ? `, ${d.vf.holiday}-month payment holiday` : ""}${d.vf.io ? `, ${d.vf.io} months interest-only` : ""})`;
    if (e.k === "bank") return `${d.bank.pct}% commercial debt (${d.bank.years} yrs at ${d.bank.rate}%)`;
    if (e.k === "roll") return `${d.roll.pct}% seller rollover equity`;
    if (e.k === "inv") return `${d.inv.pct}% investor capital for ${d.inv.stake}% equity`;
    return `${d.own.pct}% my own cash`;
  });
  return `${money(m.price, d.cur)} price (${d.multiple}x ${money(d.ebitda, d.cur)} EBITDA), funded by ${parts.join(", ") || "nothing yet"}. ${d.nonVoting ? "Rollover/investor shares are non-voting." : ""} The model says: I keep ${pct(m.yourEconomic)} economic ownership and ${pct(m.yourVotes)} of the votes, minimum DSCR ${m.minDscr ? m.minDscr.toFixed(2) + "x" : "n/a"} (free cash flow ${d.fcfPct}% of EBITDA), my cash in: ${money(m.cashFromYou, d.cur)}.`;
}

// Value Ladder: what the owner's own company is worth today, and after buying N competitors with one structure.
export const LADDER_DEFAULTS = { myEbitda: 800000, deals: 4, targetEbitda: 500000, buyMultiple: 3, synergy: 10 };
// Size premium: buyers pay higher multiples for bigger, de-risked groups. Indicative, conservative bands.
export function multipleFor(ebitda, cur) {
  const k = cur === "NOK " ? ebitda / 10 : ebitda; // NOK bands scaled roughly to USD
  return k < 1e6 ? 3.5 : k < 2e6 ? 4.5 : k < 5e6 ? 5.5 : k < 10e6 ? 7 : 8;
}
export function ladderModel(x, d) {
  const cur = d.cur;
  const per = dealModel(d, x.targetEbitda, x.buyMultiple); // one acquisition; every deal uses the same structure
  const todayValue = x.myEbitda * multipleFor(x.myEbitda, cur);
  const debt3 = per.years[2]?.debtLeft ?? 0;
  const steps = [];
  for (let k = 0; k <= x.deals; k++) {
    const acquired = k * x.targetEbitda * (1 + x.synergy / 100);
    const ebitda = x.myEbitda + acquired;
    const multiple = multipleFor(ebitda, cur);
    const value = ebitda * multiple;
    const debtAtClose = k * (per.amt.vf + per.amt.bank);
    const outsideEquity = k * (per.amt.roll + per.amt.inv); // sellers/investors who took equity, priced at the deal
    const outsideStake = outsideEquity ? Math.min(0.9, outsideEquity / Math.max(1, value - debtAtClose)) : 0;
    steps.push({ n: k, ebitda, multiple, value, price: k * per.price, service: k * (per.years[1]?.service ?? per.years[0].service), dscr: k ? per.minDscr : null, outsideStake, equity3: (value - k * debt3) * (1 - outsideStake) });
  }
  return { cur, todayValue, steps, final: steps[steps.length - 1], per, d };
}

// Pipeline stages, in order. `p` is a rough probability of closing, used for the weighted pipeline value.
export const STAGES = [
  { id: "sourced", label: "Sourced", p: 0.02 },
  { id: "contacted", label: "Contacted", p: 0.05 },
  { id: "first_call", label: "First call", p: 0.1 },
  { id: "meeting", label: "Meeting", p: 0.2 },
  { id: "docs", label: "NDA & docs", p: 0.35 },
  { id: "loi", label: "LOI sent", p: 0.5 },
  { id: "diligence", label: "Diligence", p: 0.7 },
  { id: "closed", label: "Closed", p: 1 },
  { id: "lost", label: "Lost", p: 0 },
];
export const stageById = (id) => STAGES.find((s) => s.id === id) || STAGES[0];

// A target's deal: its own saved structure, or the default structure sized to its EBITDA.
export function targetDeal(t, fallback = DEAL_DEFAULTS) {
  const base = normalizeDeal(t.deal || fallback);
  if (!t.deal && t.ebitda) base.ebitda = Number(t.ebitda);
  if (!t.deal && t.currency) base.cur = CURS.includes(t.currency) ? t.currency : base.cur;
  return base;
}
