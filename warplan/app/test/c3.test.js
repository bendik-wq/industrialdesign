import { test } from "node:test";
import assert from "node:assert/strict";
import { clocks, gateSignal, HEALTHCARE, extOf, checkUpload } from "../src/dealroom.js";
import { scoreLender, lenderNeed, c1c2Summary } from "../src/capabilities.js";
import { scorecard } from "../src/today.js";
import { ROOM_TEMPLATES, RED_FLAG_MATRIX, LENDER_FIELDS } from "../public/js/jl.js";
import JL from "../../knowledge/jl-3c-skill.md";

test("every deal-room checklist line and red flag is quoted from the JL skill", () => {
  const skill = JL.replace(/\s+/g, " "), low = skill.toLowerCase();
  for (const items of Object.values(ROOM_TEMPLATES)) for (const x of items) {
    const t = x.title.replace(/ \(≥3 years\)$/, "");
    assert.ok(low.includes(t.toLowerCase()) || /NDA|statements|Tax returns/.test(t), `not in skill: ${x.title}`);
    assert.ok(skill.includes(x.section.replace(/^Days (\d+)-(\d+): /, "Days $1-$2: ")) || ["Qualification gate", "Contractual close", "Settlement"].includes(x.section), `section not in skill: ${x.section}`);
  }
  for (const f of RED_FLAG_MATRIX) assert.ok(skill.includes(`| ${f.flag} | ${f.severity.toUpperCase()} | ${f.action} |`), f.flag);
});

test("clocks: exclusivity, the 90-day DD window, 4-week papering, variance", () => {
  const c = clocks({ loi_signed_at: "2026-01-01", exclusivity_days: 60, dd_start: "2026-01-05", offer_price: 1000000, final_price: 900000 }, "2026-04-20T00:00:00Z");
  assert.equal(c.exclusivity.ends, "2026-03-02");
  assert.ok(c.exclusivity.left < 0);
  assert.equal(c.dd.used, 104);
  assert.ok(c.warnings.some((w) => w.level === "high" && /90 days maximum/.test(w.text)));
  assert.equal(c.ddVariance, -10);
  const closed = clocks({ dd_start: "2026-01-01", contract_start: "2026-02-01", settled_at: "2026-02-20", first_contact: "2025-06-01" }, "2026-09-01T00:00:00Z");
  assert.equal(closed.warnings.length, 0);
  assert.equal(closed.dd.done, true);
  assert.equal(closed.contactToClose, 264);
  assert.ok(clocks({ contract_start: "2026-01-01" }, "2026-02-15T00:00:00Z").warnings.some((w) => /4 weeks/.test(w.text)));
});

test("gate signal reads the skill's motivation indicators", () => {
  assert.equal(gateSignal({ nda_at: "2026-01-01T10:00:00Z" }, "2026-01-02T09:00:00Z").level, "high");
  assert.equal(gateSignal({ nda_at: "2026-01-01T10:00:00Z" }, "2026-01-25T09:00:00Z").level, "low");
  assert.equal(gateSignal({ nda_at: "2026-01-01T10:00:00Z" }, null, "2026-01-20T00:00:00Z").level, "low");
  assert.equal(gateSignal({}, null), null);
});

test("healthcare detection and upload checks", () => {
  assert.ok(HEALTHCARE.test("Smile Dental Clinic"));
  assert.ok(!HEALTHCARE.test("Dalton Heating & Air"));
  assert.equal(extOf("FY23 accounts.PDF"), "pdf");
  assert.throws(() => checkUpload({ name: "x.html", size: 10 }), /PDF/);
  assert.throws(() => checkUpload({ name: "x.pdf", size: 30 * 1024 * 1024 }), /20 MB/);
  assert.equal(checkUpload({ name: "a/b.pdf", size: 10 }).name, "a_b.pdf");
});

test("lender fit: ticket, DSCR and sector checks against the deal's bank slice", () => {
  const t = { industry: "Dental practice", deal: { cur: "A$", ebitda: 900000, multiple: 3, vf: { pct: 40, years: 7, rate: 6 }, bank: { pct: 60, years: 7, rate: 8 } } };
  const need = lenderNeed(t);
  assert.equal(need.amount, 1620000);
  assert.equal(need.hypothetical, false);
  const good = scoreLender({ status: "interviewed", terms: { ticket_min: 500000, ticket_max: 3000000, min_dscr: 1.3, sectors: "healthcare, dental" } }, need);
  assert.equal(good.fit, "good");
  const bad = scoreLender({ status: "prospect", terms: { ticket_max: 1000000, min_dscr: 1.6 } }, need);
  assert.equal(bad.fit, "no");
  assert.ok(good.score > bad.score);
  assert.equal(scoreLender({ status: "prospect", terms: {} }, need).fit, "unknown");
  const vf = lenderNeed({ industry: "HVAC", ebitda: 500000, deal: null });
  assert.equal(vf.hypothetical, true);
});

test("summary and scorecard follow the skill's KPIs", () => {
  const rels = [
    { kind: "board", role: "chair", name: "A", status: "signed", equity_pct: 1, terms: {} },
    { kind: "board", role: "finance", name: "B", status: "pitched", equity_pct: 1, terms: {} },
    { kind: "bench", role: "lawyer", name: "C", status: "engaged", terms: {} },
    { kind: "lender", role: "", name: "D", status: "interviewed", terms: { min_dscr: 1.5 } },
    { kind: "lender", role: "", name: "E", status: "passed", terms: {} },
  ];
  const s = c1c2Summary(rels);
  assert.equal(s.board.filled, 1);
  assert.equal(s.board.equity, 1);
  assert.equal(s.lenders.total, 1);
  assert.equal(s.lenders.inMatrix, 1);
  const sc = scorecard({ rels, rooms: [{ offer_at: "2026-01-01", contract_start: "2026-03-01" }, { offer_at: "2026-02-01" }], stages: [{ stage: "closed", n: 0 }], fin: [], stamp: "2026-04-01T00:00:00Z" });
  assert.equal(sc.closing[0].value, "50%");
  assert.equal(sc.capabilities[0].value, "1/4");
  assert.ok(LENDER_FIELDS.find((f) => f.k === "min_dscr"));
});
