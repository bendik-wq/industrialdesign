// Reads the spreadsheets owners actually send: CSV exports (Xero, MYOB, QuickBooks, bank statements, payroll) and
// .xlsx workbooks. No dependencies: an .xlsx is a zip of XML parts, and Workers can inflate zip entries natively.
// Every reader returns {sheets: [{name, rows: [[cell, ...], ...]}]} with cells as trimmed strings or numbers.

const err = (status, message) => Object.assign(new Error(message), { status });
export const MAX_ROWS = 5000, MAX_COLS = 60;
// Zip-bomb guards: no single part of a workbook may inflate past MAX_ENTRY, or the whole file past MAX_TOTAL.
export const MAX_ENTRY = 40 * 1024 * 1024, MAX_TOTAL = 120 * 1024 * 1024, MAX_CELL = 2000;

// ── CSV ─────────────────────────────────────────────────────────────────────
export function parseCsv(text) {
  text = String(text).replace(/^﻿/, "");
  const delim = [",", ";", "\t"].map((d) => [d, (text.split("\n")[0].match(new RegExp(d === "\t" ? "\t" : `\\${d}`, "g")) || []).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"' && cell === "") q = true;
    else if (c === delim) { if (row.length < MAX_COLS) row.push(cell.slice(0, MAX_CELL)); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      if (row.length < MAX_COLS) row.push(cell.slice(0, MAX_CELL)); cell = "";
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
      if (rows.length >= MAX_ROWS) break;
    } else if (cell.length < MAX_CELL) cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); if (row.some((x) => x.trim() !== "")) rows.push(row); }
  return { sheets: [{ name: "Sheet1", rows: rows.map((r) => r.slice(0, MAX_COLS).map(cellValue)) }] };
}

// "$1,234.50", "(1,200)", "12%", "-" → numbers where the cell is clearly a number; everything else stays text.
export function cellValue(v) {
  if (typeof v === "number") return v;
  const s = String(v ?? "").trim();
  if (!s) return "";
  const m = /^(-)?\(?-?\s*[$£€]?\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*\)?(%)?$/.exec(s.replace(/\s?(AUD|USD|GBP|NZD)$/i, ""));
  if (!m) return s;
  let n = Number(m[2].replace(/,/g, ""));
  if (m[1] || /^\(.*\)$/.test(s) || /^-/.test(s.replace(/[$£€\s]/g, ""))) n = -n;
  return m[3] ? n / 100 : n;
}

// ── XLSX ────────────────────────────────────────────────────────────────────
async function inflate(bytes, budget) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    budget.used += value.length;
    if (size > MAX_ENTRY || budget.used > MAX_TOTAL) { await reader.cancel().catch(() => {}); throw err(413, "That workbook expands to far more data than a spreadsheet should. Save it as .csv and upload again."); }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// Minimal zip reader: walk the central directory, return {name: async () => Uint8Array}.
export function unzip(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 66000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw err(400, "That file isn't a valid .xlsx (no zip directory found)");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = {}, dec = new TextDecoder(), budget = { used: 0 };
  if (count > 5000) throw err(400, "That file has too many parts to be a spreadsheet");
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nlen));
    files[name] = async () => {
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const data = b.subarray(start, start + csize);
      if (method === 0) return data;
      if (usize > MAX_ENTRY) throw err(413, "That workbook is too large to read. Save it as .csv and upload again.");
      if (method === 8) return inflate(data, budget);
      throw err(400, `Unsupported compression in ${name}`);
    };
    p += 46 + nlen + elen + clen;
  }
  return files;
}

const xmlText = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&amp;/g, "&");
const colIndex = (ref) => { let n = 0; for (const ch of ref.replace(/\d+/g, "")) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

export async function parseXlsx(buf) {
  const files = unzip(buf), dec = new TextDecoder();
  const read = async (name) => (files[name] ? dec.decode(await files[name]()) : "");
  const shared = [];
  for (const si of (await read("xl/sharedStrings.xml")).match(/<si>[\s\S]*?<\/si>/g) || [])
    shared.push(xmlText((si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map((t) => t.replace(/<[^>]+>/g, "")).join("")));
  const wb = await read("xl/workbook.xml"), rels = await read("xl/_rels/workbook.xml.rels");
  const target = {};
  for (const r of rels.match(/<Relationship [^>]*>/g) || []) {
    const id = /Id="([^"]+)"/.exec(r)?.[1], t = /Target="([^"]+)"/.exec(r)?.[1];
    if (id && t) target[id] = t.replace(/^\/?xl\//, "").replace(/^\//, "");
  }
  const sheets = [];
  for (const s of wb.match(/<sheet [^>]*\/>/g) || []) {
    const name = xmlText(/name="([^"]*)"/.exec(s)?.[1] || "Sheet");
    const rid = /r:id="([^"]+)"/.exec(s)?.[1];
    const xml = await read(`xl/${target[rid] || ""}`);
    if (!xml) continue;
    const rows = [];
    for (const r of xml.match(/<row[^>]*>[\s\S]*?<\/row>|<row[^>]*\/>/g) || []) {
      const row = [];
      for (const c of r.match(/<c [^>]*\/>|<c [^>]*>[\s\S]*?<\/c>/g) || []) {
        const ref = /r="([A-Z]+)\d+"/.exec(c)?.[1];
        const i = ref ? colIndex(ref) : row.length;
        if (i >= MAX_COLS) continue;
        const t = /t="([^"]+)"/.exec(c)?.[1];
        const v = /<v>([\s\S]*?)<\/v>/.exec(c)?.[1];
        let val = "";
        if (t === "s") val = shared[+v] ?? "";
        else if (t === "inlineStr") val = xmlText((/<t[^>]*>([\s\S]*?)<\/t>/.exec(c) || [])[1] || "");
        else if (t === "str" || t === "e") val = xmlText(v || "");
        else if (t === "b") val = v === "1" ? "TRUE" : "FALSE";
        else if (v != null && v !== "") val = Number(v);
        while (row.length < i) row.push("");
        row[i] = typeof val === "string" ? cellValue(val.trim()) : val;
      }
      if (row.some((x) => x !== "")) rows.push(row);
      if (rows.length >= MAX_ROWS) break;
    }
    sheets.push({ name, rows });
  }
  if (!sheets.length) throw err(400, "No sheets found in that workbook");
  return { sheets };
}

export async function readSheet(bytes, name = "", mime = "") {
  const lower = String(name).toLowerCase();
  if (lower.endsWith(".xlsx") || /spreadsheetml/.test(mime)) return parseXlsx(bytes);
  if (lower.endsWith(".csv") || lower.endsWith(".txt") || /csv|text\/plain/.test(mime)) return parseCsv(new TextDecoder().decode(bytes));
  if (lower.endsWith(".xls")) throw err(400, "Old .xls files can't be read. Save it as .xlsx or .csv and upload again.");
  throw err(400, "Only .csv and .xlsx files can be read");
}

// A compact text rendering for a model: the first rows of every sheet, numbers kept exact.
export function sheetText(book, maxRows = 120, maxChars = 24000) {
  let out = "";
  for (const s of book.sheets) {
    out += `## Sheet: ${s.name} (${s.rows.length} rows)\n`;
    for (const r of s.rows.slice(0, maxRows)) out += r.map((c) => (typeof c === "number" ? String(Math.round(c * 100) / 100) : String(c).replace(/\s+/g, " "))).join(" | ") + "\n";
    if (out.length > maxChars) { out = out.slice(0, maxChars) + "\n…(truncated)"; break; }
  }
  return out;
}
