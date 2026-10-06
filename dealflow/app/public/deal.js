// Deal engine shared by the browser (live sliders) and the Worker (API, MCP, seller page).
// Indicative only: ranges are small-business rules of thumb, not a substitute for a quality-of-earnings review.

// EV / EBITDA ranges for owner-operated companies (roughly €0.5–5M EBITDA).
export const MULTIPLES = {
  hvac: [3.5, 5.5], plumbing: [3, 5], electrical: [3.5, 5], roofing: [3, 4.5], landscaping: [2.5, 4],
  cleaning: [2.5, 4], pest: [4, 6], dental: [4, 6], gp: [4, 6], physio: [3.5, 5], vet: [5, 8],
  accounting: [3.5, 5], insurance: [5, 8], it: [4, 6], auto: [2.5, 4], trucking: [3, 4.5], waste: [5, 7],
  security: [3.5, 5], engineering: [4, 6], funeral: [5, 7], childcare: [4, 6],
};
const DEFAULT_MULTIPLE = [3.5, 5];
const DEFAULT_MARGIN = 0.1;
const CASH_CONVERSION = 0.8; // EBITDA → cash available for debt service, after tax and maintenance capex

// Best available earnings figure, and how it was derived (shown to the user, never hidden).
export function earnings(c) {
  if (c.ebit != null && c.ebit !== 0) return { ebitda: c.ebit, basis: `Operating profit ${c.fin_year || ""} (filed accounts)`.trim(), confidence: "high" };
  if (c.net_income != null && c.net_income !== 0) return { ebitda: c.net_income / 0.75, basis: `Net income ${c.fin_year || ""} grossed up for 25% tax`.trim(), confidence: "medium" };
  if (c.revenue) return { ebitda: c.revenue * DEFAULT_MARGIN, basis: `Assumed ${DEFAULT_MARGIN * 100}% margin on ${c.fin_year || "reported"} revenue`, confidence: "low" };
  return null;
}

export function valuation(c) {
  const e = earnings(c);
  if (!e || e.ebitda <= 0) return null;
  const [lo, hi] = MULTIPLES[c.industry] || DEFAULT_MULTIPLE;
  const netCash = (c.cash || 0) - (c.long_term_debt || 0);
  return {
    ebitda: e.ebitda, basis: e.basis, confidence: e.confidence,
    multiple: [lo, hi],
    ev: [e.ebitda * lo, e.ebitda * ((lo + hi) / 2), e.ebitda * hi],
    netCash,
    equity: [e.ebitda * lo + netCash, e.ebitda * ((lo + hi) / 2) + netCash, e.ebitda * hi + netCash].map((v) => Math.max(0, v)),
  };
}

// Annuity schedule with an optional payment holiday (interest accrues, then amortises over the remaining term).
function loan(principal, ratePct, years, holidayMonths = 0) {
  const r = ratePct / 100 / 12;
  const n = Math.max(1, years * 12 - holidayMonths);
  let bal = principal * (1 + r) ** holidayMonths;
  const pmt = r ? (bal * r) / (1 - (1 + r) ** -n) : bal / n;
  const byYear = Array(10).fill(0);
  for (let m = holidayMonths; m < years * 12 && m < 120; m++) {
    byYear[Math.floor(m / 12)] += pmt;
    bal -= pmt - bal * r;
  }
  return byYear;
}

export const STRUCTURES = {
  vendor: {
    label: "100% vendor finance",
    blurb: "Seller funds the whole price as a note. Payment holiday while you integrate. Nothing down.",
    parts: { seller: 1 }, seller: { rate: 4, years: 8, holiday: 12 },
  },
  blend: {
    label: "Bank 60 / seller 40",
    blurb: "Bank debt validates the deal; seller rolls 40% as a subordinated note with a holiday.",
    parts: { bank: 0.6, seller: 0.4 }, bank: { rate: 7.5, years: 10 }, seller: { rate: 4, years: 7, holiday: 12 },
  },
  earnout: {
    label: "Bank 50 / seller 30 / earn-out 20",
    blurb: "Earn-out paid in years 2–3 only if profit holds. Shifts risk back to the seller.",
    parts: { bank: 0.5, seller: 0.3, earnout: 0.2 }, bank: { rate: 7.5, years: 10 }, seller: { rate: 4, years: 7, holiday: 12 },
  },
};

export function structure(key, price, ebitda, overrides = {}) {
  const s = { ...STRUCTURES[key], ...overrides };
  const cfads = ebitda * CASH_CONVERSION;
  const years = Array(7).fill(0);
  const add = (arr) => arr.forEach((v, i) => i < 7 && (years[i] += v));
  if (s.parts.bank) add(loan(price * s.parts.bank, s.bank.rate, s.bank.years));
  if (s.parts.seller) add(loan(price * s.parts.seller, s.seller.rate, s.seller.years, s.seller.holiday));
  if (s.parts.earnout) { years[1] += (price * s.parts.earnout) / 2; years[2] += (price * s.parts.earnout) / 2; }
  const dscr = years.map((d) => (d > 0 ? cfads / d : null));
  const paying = dscr.filter((x) => x != null);
  const minDscr = paying.length ? Math.min(...paying) : null;
  return {
    key, label: s.label, blurb: s.blurb, price, cfads,
    parts: Object.entries(s.parts).map(([k, f]) => ({ k, amount: price * f, pct: f, terms: s[k] })),
    debtService: years, dscr, minDscr,
    bankable: minDscr != null && minDscr >= 1.5,
    maxPriceAt15: minDscr ? price * (minDscr / 1.5) : null,
    cashAtClose: 0,
  };
}

// Fair value says what the company is worth; the fundable price says what its own cash flow can pay for at 1.5×
// debt-service coverage. The recommended structure is the one that funds the highest price.
export function recommend(c, price) {
  const v = valuation(c);
  if (!v) return null;
  const probe = Object.keys(STRUCTURES).map((k) => structure(k, v.equity[1], v.ebitda));
  const top = [...probe].sort((a, b) => (b.maxPriceAt15 || 0) - (a.maxPriceAt15 || 0))[0];
  const fundable = Math.min(v.equity[1], top.maxPriceAt15 || 0);
  const p = price ?? fundable;
  const all = Object.keys(STRUCTURES).map((k) => structure(k, p, v.ebitda));
  const best = all.find((x) => x.key === top.key);
  return { valuation: v, price: p, fundablePrice: fundable, fundableStructure: top.label, structures: all, best };
}

export function money(v, cur = "EUR") {
  if (v == null || !Number.isFinite(v)) return "–";
  const sym = { EUR: "€", GBP: "£", USD: "$", NOK: "NOK " }[cur] ?? "";
  const a = Math.abs(v);
  const s = a >= 1e6 ? `${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M` : a >= 1e3 ? `${Math.round(a / 1e3)}k` : `${Math.round(a)}`;
  return `${v < 0 ? "−" : ""}${sym}${s}`;
}
