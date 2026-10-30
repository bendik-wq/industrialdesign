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
