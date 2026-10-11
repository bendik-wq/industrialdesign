import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseAbnSearch, parseAbnView, pickMatch, signals, countryOf } from "../src/registry.js";

// Real ABN Lookup pages (fetched Oct 2026), so the parser is tested against what the site actually serves.
const fx = JSON.parse(readFileSync(new URL("./fixtures/abn.json", import.meta.url)));

test("ABN search: rows with ABN, name, postcode, state; the right match wins on name + postcode", () => {
  const rows = parseAbnSearch(fx.search);
  assert.ok(rows.length >= 4);
  assert.deepEqual(rows[0], { abn: "47641453125", active: true, name: "BARWON SPORTS PHYSIOTHERAPY PTY LTD", kind: "Entity Name", postcode: "3216", state: "VIC" });
  assert.equal(pickMatch(rows, { name: "Barwon Sports Physiotherapy - Belmont", location: "Belmont VIC 3216, Australia" }).abn, "47641453125");
  assert.equal(pickMatch(rows, { name: "Ocean Grove Physio", location: "Ocean Grove VIC 3226, Australia" }).abn, "30688910625");
  assert.equal(pickMatch(rows, { name: "Gorgeous Smiles Dental", location: "Melbourne VIC 3000, Australia" }), null);
});

test("ABN record: entity, type, since, every business name; many names = a chain", () => {
  const v = parseAbnView(fx.view);
  assert.equal(v.entity_name, "NDC AUSTRALIA PTY LIMITED");
  assert.equal(v.entity_type, "Australian Private Company");
  assert.equal(v.active_from, "2013-03-26");
  assert.equal(v.gst_from, "2013-03-26");
  assert.ok(v.business_names.length > 20);
  assert.equal(v.business_names[0].name, "DB Currambine");
  const s = signals({ since: v.active_from, chain: true, names_count: v.business_names.length }, new Date("2026-10-11"));
  assert.match(s[0], /13 years/); assert.match(s[1], /group or corporate roll-up/);
});

test("which registry: Australia by state + postcode or currency, UK by country or £", () => {
  assert.equal(countryOf({ location: "Geelong VIC 3220, Australia" }), "AU");
  assert.equal(countryOf({ location: "Belmont VIC 3216" }), "AU");
  assert.equal(countryOf({ location: "Leeds, England" }), "UK");
  assert.equal(countryOf({ location: "Boise, ID", currency: "$" }), null);
});

test("a long-registered chain isn't called a succession candidate", () => {
  const s = signals({ since: "1999-01-01", chain: true, names_count: 30 }, new Date("2026-10-11"));
  assert.doesNotMatch(s.join(" "), /succession/);
  assert.match(signals({ since: "1999-01-01" }, new Date("2026-10-11"))[0], /succession candidate/);
});
