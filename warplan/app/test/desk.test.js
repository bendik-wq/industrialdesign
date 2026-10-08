import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcile } from "../src/desk.js";

test("diligence: signs follow the kind and the total is recomputed", () => {
  const r = reconcile({
    reported_ebitda: 900000, normalised_ebitda: 123,
    adjustments: [
      { item: "Owner salary", amount: 110000, kind: "add-back", why: "owner paid below market rate" },
      { item: "Lawsuit settlement", amount: 90000, kind: "add-back", why: "one-off" },
      { item: "Related-party rent", amount: -40000, kind: "add-back", why: "rent above market" },
      { item: "Non-recurring contract", amount: 50000, kind: "deduction", why: "won't repeat" },
      { item: "Nothing", amount: 0, kind: "add-back", why: "no info" },
    ],
  });
  assert.deepEqual(r.adjustments.map((a) => a.amount), [-110000, 90000, 40000, -50000]);
  assert.equal(r.normalised_ebitda, 900000 - 110000 + 90000 + 40000 - 50000);
});

test("diligence: survives missing fields", () => {
  const r = reconcile({});
  assert.equal(r.normalised_ebitda, 0);
  assert.deepEqual(r.adjustments, []);
});
