import { test } from "node:test";
import assert from "node:assert/strict";
import { numbersIn, supported, verifyFindings, money } from "../src/crew/common.js";

test("numbersIn reads money, k/M, percentages and multiples", () => {
  const n = numbersIn("DSCR fell to 1.32x on $273k repayments, revenue $1.2M, margin 18%").map((x) => x.n);
  assert.deepEqual(n, [1.32, 273000, 1200000, 0.18]);
});

test("supported accepts computed numbers and rejects invented ones", () => {
  const known = [1.3214, 273323, 1200000, 0.1812];
  assert.equal(supported("DSCR 1.32x on $273k", known).ok, true);
  assert.equal(supported("margin 18%", known).ok, true);
  assert.equal(supported("3 customers over 90 days", known).ok, true);
  const bad = supported("DSCR 1.45x and $310k", known);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.bad, ["1.45x", "$310k"]);
});

test("verifyFindings drops findings with unsupported numbers", () => {
  const r = verifyFindings([{ title: "Coverage", detail: "1.32x" }, { title: "Made up", detail: "churn is 27%" }], { dscr: 1.3214 });
  assert.equal(r.kept.length, 1);
  assert.equal(r.dropped[0].title, "Made up");
  assert.equal(money(1234567), "$1.23M");
  assert.equal(money(-45210), "-$45k");
});
