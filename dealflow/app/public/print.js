// The print view: builds every letter page from the shortlist (moved out of print.html for the strict CSP).
import { letterText } from "/letters.js";
const q = new URLSearchParams(location.search);
const limit = Math.min(200, Number(q.get("limit")) || 50);
const p = new URLSearchParams({ limit, sort: q.get("sort") || "fit" });
for (const k of ["search", "minFit", "minOwnerAge", "verdict", "country"]) if (q.get(k)) p.set(k, q.get(k));
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
let s = {};
try { s = JSON.parse(localStorage.getItem("dealflow.settings") || "{}"); } catch {}
const res = await fetch(`/api/companies?${p}`);
if (res.status === 401) location.href = "/login";
const { rows } = await res.json();
// Need the address for each letter: fetch details (and any AI letter already written) in small parallel batches.
const full = [];
for (let i = 0; i < rows.length; i += 8) full.push(...await Promise.all(rows.slice(i, i + 8).map((r) => fetch(`/api/companies/${r.id}`).then((x) => x.json()))));
const mailable = full.filter((c) => c.address && c.owner_name);
const date = new Date().toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
document.getElementById("pages").innerHTML = mailable.map((c) => `
  <section class="page">
    <div class="date">${esc(date)}</div>
    <div class="addr">${esc(c.owner_name)}<br>${esc(c.name)}<br>${esc(c.address).replace(/, /g, "<br>")}</div>
    <div class="body">${esc(c.ai?.letter?.content || letterText(c, s))}</div>
  </section>`).join("");
document.getElementById("status").textContent = `${mailable.length} letters ready (${rows.length - mailable.length} skipped: no owner name or address). AI letters are used where you've written one.`;

document.getElementById("printBtn")?.addEventListener("click", () => print());
