import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseCsv, parseXlsx, cellValue, sheetText } from "../src/sheets.js";

test("cellValue reads money, brackets and percentages", () => {
  assert.equal(cellValue("$1,234.50"), 1234.5);
  assert.equal(cellValue("(1,200)"), -1200);
  assert.equal(cellValue("-$300"), -300);
  assert.equal(cellValue("12%"), 0.12);
  assert.equal(cellValue("1,000 AUD"), 1000);
  assert.equal(cellValue("Wages"), "Wages");
  assert.equal(cellValue("2026-07-01"), "2026-07-01");
});

test("parseCsv handles quotes, semicolons and blank lines", () => {
  const a = parseCsv('Date,Description,Amount\n01/07/2026,"Smith, J ""Plumbing""",-1,250.00\n\n02/07/2026,Deposit,"$3,400"\n');
  assert.deepEqual(a.sheets[0].rows[1], ["01/07/2026", 'Smith, J "Plumbing"', -1, 250]);
  assert.equal(a.sheets[0].rows[2][2], 3400);
  const b = parseCsv("a;b\n1;2\n");
  assert.deepEqual(b.sheets[0].rows, [["a", "b"], [1, 2]]);
});

test("parseXlsx reads shared strings, numbers, gaps and sheet names", async () => {
  const book = await parseXlsx(readFileSync(new URL("./fixtures/pl.xlsx", import.meta.url)));
  assert.deepEqual(book.sheets.map((s) => s.name), ["Profit and Loss", "Notes & Things"]);
  const r = book.sheets[0].rows;
  assert.deepEqual(r[1], ["Account", "Jul 2026", "Aug 2026", "Sep 2026"]);
  assert.deepEqual(r[2], ["Revenue", 120500.5, 118000, 131250]);
  assert.deepEqual(r[3], ["Wages", -64000, -66500, -70100]);
  assert.equal(r[4][1], 0.12);
  assert.equal(r[4][3], 0.125);
  assert.deepEqual(book.sheets[1].rows[0], ["", "A <tag> & quote's"]);
  assert.match(sheetText(book), /Revenue \| 120500.5 \| 118000 \| 131250/);
});

test("zip bombs and absurd CSV rows are refused or capped", async () => {
  const { parseXlsx, parseCsv, MAX_COLS } = await import("../src/sheets.js");
  // A deflate stream of 60 MB of zeros, wrapped in a minimal zip with an honest-looking small declared size.
  const raw = new Uint8Array(60 * 1024 * 1024);
  const comp = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
  const name = new TextEncoder().encode("xl/workbook.xml");
  const local = new Uint8Array(30 + name.length), cd = new Uint8Array(46 + name.length), end = new Uint8Array(22);
  const L = new DataView(local.buffer), C = new DataView(cd.buffer), E = new DataView(end.buffer);
  L.setUint32(0, 0x04034b50, true); L.setUint16(8, 8, true); L.setUint32(18, comp.length, true); L.setUint32(22, 1000, true); L.setUint16(26, name.length, true); local.set(name, 30);
  C.setUint32(0, 0x02014b50, true); C.setUint16(10, 8, true); C.setUint32(20, comp.length, true); C.setUint32(24, 1000, true); C.setUint16(28, name.length, true); C.setUint32(42, 0, true); cd.set(name, 46);
  E.setUint32(0, 0x06054b50, true); E.setUint16(8, 1, true); E.setUint16(10, 1, true); E.setUint32(12, cd.length, true); E.setUint32(16, local.length + comp.length, true);
  const zip = new Uint8Array(local.length + comp.length + cd.length + end.length);
  zip.set(local, 0); zip.set(comp, local.length); zip.set(cd, local.length + comp.length); zip.set(end, local.length + comp.length + cd.length);
  await assert.rejects(parseXlsx(zip), /expands to far more data/);
  const wide = parseCsv(",".repeat(200000) + "\n1,2\n");
  assert.ok(wide.sheets[0].rows.every((r) => r.length <= MAX_COLS));
});
