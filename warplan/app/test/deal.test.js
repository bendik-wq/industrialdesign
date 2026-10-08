// Deal engine tests: the maths every verdict, LOI and board pack relies on. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { loanSchedule, dealModel, normalizeDeal, maxMultiple, money, ladderModel, LADDER_DEFAULTS, DEAL_DEFAULTS, PRESETS, targetDeal } from "../public/js/deal.js";

const close = (a, b, eps = 1) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
const deal = (over = {}) => normalizeDeal({ ...DEAL_DEFAULTS, ...over });

test("an amortising loan pays itself off exactly", () => {
  const { pay, bal } = loanSchedule(1_000_000, 6, 5);
  const total = pay.slice(0, 60).reduce((t, v) => t + v, 0);
  close(bal[59], 0);
  // Standard annuity: 1M at 6% over 60 months is ~19,332/month.
  close(pay[0], 19332.8, 1);
  assert.ok(total > 1_000_000 && total < 1_200_000);
});

test("zero-interest loans split evenly", () => {
  const { pay } = loanSchedule(120_000, 0, 1);
  pay.slice(0, 12).forEach((p) => close(p, 10_000, 0.01));
});

test("a payment holiday means no payments, then catch-up amortisation", () => {
  const { pay, bal } = loanSchedule(600_000, 4, 7, 6);
  assert.equal(pay.slice(0, 6).reduce((t, v) => t + v, 0), 0);
  assert.ok(pay[6] > 0);
  close(bal[83], 0);
});

test("interest-only then balloon at term", () => {
  const { pay } = loanSchedule(1_000_000, 7, 10, 0, 120);
  close(pay[0], 1_000_000 * 0.07 / 12, 0.01);
  close(pay[119], 1_000_000 + 1_000_000 * 0.07 / 12, 1);
});

test("the default deal (100% vendor finance, 7y at 4%, 3×) works", () => {
  const m = dealModel(deal());
  assert.equal(m.price, 1_800_000);
  assert.ok(m.complete && m.control && m.bankable && m.works);
  assert.ok(m.minDscr >= 1.5, `DSCR ${m.minDscr}`);
  assert.equal(m.cashFromYou, 0);
});

test("giving away voting equity loses control", () => {
  const m = dealModel(deal({ nonVoting: false, vf: { pct: 40 }, roll: { pct: 60 } }));
  assert.equal(m.yourVotes, 40);
  assert.equal(m.control, false);
  assert.equal(m.works, false);
});

test("non-voting rollover keeps control", () => {
  const m = dealModel(deal({ nonVoting: true, vf: { pct: 40 }, roll: { pct: 60 } }));
  assert.equal(m.yourVotes, 100);
  assert.equal(m.yourEconomic, 40);
  assert.ok(m.control);
});

test("an expensive bank-heavy deal fails the 1.5× rule", () => {
  const m = dealModel(deal({ multiple: 6, vf: { pct: 0 }, bank: { pct: 100, years: 5, rate: 9 } }));
  assert.ok(m.minDscr < 1.5);
  assert.equal(m.bankable, false);
});

test("unfunded or over-funded stacks are incomplete", () => {
  assert.equal(dealModel(deal({ vf: { pct: 80 } })).complete, false);
  assert.equal(dealModel(deal({ vf: { pct: 80 }, bank: { pct: 40 } })).complete, false);
});

test("every preset adds up to 100%", () => {
  for (const [k, p] of Object.entries(PRESETS)) {
    const m = dealModel(normalizeDeal({ ...DEAL_DEFAULTS, ...p.set }));
    assert.ok(m.complete, k);
  }
});

test("maxMultiple lands exactly on the 1.5× line", () => {
  const d = deal();
  const x = maxMultiple(d);
  assert.ok(x > 3);
  assert.ok(dealModel(d, d.ebitda, x).minDscr >= 1.5);
  assert.ok(dealModel(d, d.ebitda, x + 0.05).minDscr < 1.5);
});

test("normalizeDeal survives junk from storage or the API", () => {
  const d = normalizeDeal({ cur: "<script>", ebitda: "abc", multiple: -4, vf: { pct: "50" }, bank: null });
  assert.equal(d.cur, "$");
  assert.equal(d.ebitda, DEAL_DEFAULTS.ebitda);
  assert.ok(d.multiple > 0);
  assert.equal(d.vf.pct, 50);
  assert.equal(d.bank.pct, DEAL_DEFAULTS.bank.pct);
  assert.doesNotThrow(() => dealModel(d));
});

test("targetDeal sizes the default structure to the target's EBITDA", () => {
  const d = targetDeal({ ebitda: 900000, currency: "£" });
  assert.equal(d.ebitda, 900000);
  assert.equal(d.cur, "£");
  const saved = targetDeal({ ebitda: 900000, deal: { ...DEAL_DEFAULTS, ebitda: 1 } });
  assert.equal(saved.ebitda, 1);
});

test("money formats compactly and handles missing values", () => {
  assert.equal(money(1_800_000), "$1.8M");
  assert.equal(money(2_000_000, "€"), "€2M");
  assert.equal(money(450_000), "$450k");
  assert.equal(money(-250_000), "−$250k");
  assert.equal(money(null), "–");
  assert.equal(money(950), "$950");
});

test("the value ladder grows with each deal", () => {
  const L = ladderModel(LADDER_DEFAULTS, deal());
  assert.equal(L.steps.length, LADDER_DEFAULTS.deals + 1);
  for (let i = 1; i < L.steps.length; i++) assert.ok(L.steps[i].value > L.steps[i - 1].value);
});
