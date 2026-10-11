import { test } from "node:test";
import assert from "node:assert/strict";
import { JL_SKILL, jlSections, jlSectionCount, SOURCE_RULE } from "../src/jlskill.js";

test("the whole JL skill is bundled, with the references", () => {
  assert.ok(JL_SKILL.length > 40000);
  for (const s of ["The 3C Framework", "Payment Holiday Close", "Multi-Channel Sequencing", "Three-Legged Stool", "Have you ever thought about selling"]) assert.ok(JL_SKILL.includes(s), s);
  assert.ok(jlSectionCount > 60);
  assert.match(SOURCE_RULE, /THE JL SKILL/);
});

test("retrieval: the right sections for the question", () => {
  assert.match(jlSections("how do I write the LOI / NBIO and what goes in it, exclusivity?"), /Indicative Offer/);
  assert.match(jlSections("seller says he has other buyers at a higher price"), /No Worries, Good Luck/i);
  assert.match(jlSections("what should my first 100 days look like after settlement"), /First 100 Days/);
  assert.match(jlSections("how should I set up my holding company and SPV"), /SPV|Holding/);
  assert.equal(jlSections("zzzz qqqq"), "");
});
