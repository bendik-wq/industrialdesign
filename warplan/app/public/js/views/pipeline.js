import { $, $$, esc, api, post, view, session, stale, toast, fail, dialog, local, todayYmd, addDays, dateLabel, when, skeleton, emptyState } from "../core.js";
import { STAGES, CURS, money, stageById } from "../deal.js";
import { pushDialog } from "./outreach.js";

const PRIORITY = { 1: "High", 2: "Normal", 3: "Low" };

export async function renderPipeline(seq, params) {
  view().innerHTML = skeleton(6);
  const q = params.get("q") || "";
  const targets = await api(`/api/targets${q ? `?q=${encodeURIComponent(q)}` : ""}`);
  if (stale(seq)) return;
  const mode = local.get("pipelineView", "board");
  const live = targets.filter((t) => t.stage !== "lost" && t.stage !== "closed");
  const today = todayYmd();
  const due = live.filter((t) => t.next_date && t.next_date <= addDays(7));
  const overdue = live.filter((t) => t.next_date && t.next_date < today);
  const ebitda = live.reduce((s, t) => s + (t.ebitda || 0), 0);
  const weighted = live.reduce((s, t) => s + (t.asking || (t.ebitda || 0) * 3) * stageById(t.stage).p, 0);
  const cur = mostCommon(targets.map((t) => t.currency)) || "$";
  view().innerHTML = `
    <header class="page-head with-actions"><div><p class="eyebrow">Pipeline</p><h1>Every target. One board.</h1>
      <p class="lede">From the first letter to closing. Volume at the top is everything: buyers who close have 50+ owners in conversation.</p></div>
      <div class="head-actions"><button class="primary" id="addTarget" type="button">+ Add target</button></div></header>
    <div class="metric-strip">
      <div><span>Live targets</span><b>${live.length}</b><small>${targets.length - live.length ? `${targets.length - live.length} closed or lost` : "in play"}</small></div>
      <div><span>EBITDA in play</span><b>${money(ebitda, cur)}</b><small>across live targets</small></div>
      <div><span>Weighted value</span><b>${money(weighted, cur)}</b><small>price × stage odds</small></div>
      <div class="${overdue.length ? "alert" : ""}"><span>Next actions</span><b>${due.length}</b><small>${overdue.length ? `${overdue.length} overdue` : "due this week"}</small></div>
    </div>
    <div class="toolbar">
      <input type="search" id="pq" placeholder="Search name, owner, industry, place, tag" value="${esc(q)}" aria-label="Search targets">
      <div class="seg" role="group" aria-label="View"><button type="button" data-v="board" class="${mode === "board" ? "on" : ""}" aria-pressed="${mode === "board"}">Board</button><button type="button" data-v="table" class="${mode === "table" ? "on" : ""}" aria-pressed="${mode === "table"}">Table</button></div>
      <span class="spacer"></span>
      <button class="ghost" id="pushBtn" type="button" ${live.length ? "" : "disabled"}>⇢ Add to campaign</button>
      <button class="ghost" id="importBtn" type="button" title="Your own sheet, or a ListKit / Apollo / Clay export">Import CSV</button>
      <a class="ghost" href="/api/targets.csv" download>Export CSV</a>
    </div>
    <div id="pipe">${!targets.length ? (q ? emptyState("Nothing matches", `No target matches “${q}”.`) : emptyState("No targets yet", "Add the companies you'd like to buy: competitors, suppliers, businesses next door. Start with ten.", `<div class="row center-row"><button class="primary" data-add type="button">+ Add your first target</button><button class="ghost" data-import type="button">Import a CSV</button><button class="ghost" data-samples type="button">Load three examples</button></div>`)) : mode === "table" ? table(targets) : board(targets)}</div>`;

  $("#addTarget").addEventListener("click", () => addTarget());
  $("[data-add]")?.addEventListener("click", () => addTarget());
  $("[data-import]")?.addEventListener("click", importCsv);
  $("[data-samples]")?.addEventListener("click", loadSamples);
  $("#importBtn").addEventListener("click", importCsv);
  $("#pushBtn").addEventListener("click", () => pushDialog(live));
  $$(".seg [data-v]").forEach((b) => b.addEventListener("click", () => { local.set("pipelineView", b.dataset.v); renderPipeline(seq, params); }));
  let t;
  $("#pq").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => { history.replaceState(null, "", `#/pipeline${e.target.value ? `?q=${encodeURIComponent(e.target.value)}` : ""}`); renderPipeline(++session.seq, new URLSearchParams(e.target.value ? { q: e.target.value } : {})).then(() => { const i = $("#pq"); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }); }, 300); });
  wireBoard(targets, seq, params);
  $$("[data-sort]").forEach((th) => th.addEventListener("click", () => sortTable(th)));
}

function mostCommon(arr) { const c = {}; arr.forEach((x) => { c[x] = (c[x] || 0) + 1; }); return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0]; }

function card(t) {
  const today = todayYmd();
  const late = t.next_date && t.next_date < today, soon = t.next_date && !late && t.next_date <= addDays(2);
  return `<a class="tcard p${t.priority}" href="#/targets/${t.id}" draggable="true" data-id="${t.id}">
    <b>${esc(t.name)}</b>
    <small>${esc([t.industry, t.location].filter(Boolean).join(" · ") || "No details yet")}</small>
    <span class="tc-nums">${t.readiness != null ? `<i class="ready ${t.readiness >= 70 ? "hot" : t.readiness >= 45 ? "warm" : "cold"}" title="Seller readiness from research">◉ ${t.readiness}</i>` : ""}${t.ebitda ? `<i>EBITDA ${money(t.ebitda, t.currency)}</i>` : ""}${t.owner_age ? `<i>Owner ${t.owner_age}</i>` : ""}${t.docs ? `<i>${t.docs} doc${t.docs > 1 ? "s" : ""}</i>` : ""}</span>
    ${t.next_action ? `<span class="tc-next ${late ? "late" : soon ? "soon" : ""}">${late ? "Overdue · " : ""}${esc(t.next_action)}${t.next_date ? ` · ${dateLabel(t.next_date)}` : ""}</span>` : `<span class="tc-next none">No next action</span>`}
  </a>`;
}

function board(targets) {
  return `<div class="board" role="list">${STAGES.map((s) => {
    const items = targets.filter((t) => t.stage === s.id);
    const e = items.reduce((x, t) => x + (t.ebitda || 0), 0);
    return `<section class="col ${s.id === "lost" ? "col-lost" : ""}" data-stage="${s.id}" role="listitem" aria-label="${s.label}">
      <header><h2>${s.label}</h2><span>${items.length}${e ? ` · ${money(e, items[0]?.currency || "$")}` : ""}</span></header>
      <div class="col-body">${items.map(card).join("") || `<p class="col-empty">Drop a target here</p>`}</div></section>`;
  }).join("")}</div>`;
}

function table(targets) {
  return `<div class="table-wrap panel flush"><table class="ttable" id="ttable"><thead><tr>
    <th data-sort="name">Company</th><th data-sort="stage">Stage</th><th data-sort="ebitda" class="num">EBITDA</th><th data-sort="revenue" class="num">Revenue</th><th data-sort="owner_age" class="num">Owner age</th><th data-sort="readiness" class="num">Readiness</th><th data-sort="next_date">Next action</th><th data-sort="updated_at">Updated</th></tr></thead>
    <tbody>${targets.map((t) => `<tr data-href="#/targets/${t.id}" data-name="${esc(t.name.toLowerCase())}" data-stage="${STAGES.findIndex((s) => s.id === t.stage)}" data-ebitda="${t.ebitda ?? -1}" data-revenue="${t.revenue ?? -1}" data-owner_age="${t.owner_age ?? -1}" data-readiness="${t.readiness ?? -1}" data-next_date="${t.next_date || "9999"}" data-updated_at="${t.updated_at}">
      <td><a href="#/targets/${t.id}"><b>${esc(t.name)}</b></a><small class="muted block">${esc([t.industry, t.location].filter(Boolean).join(" · "))}</small></td>
      <td><span class="stage-pill s-${t.stage}">${stageById(t.stage).label}</span></td>
      <td class="num">${money(t.ebitda, t.currency)}</td><td class="num">${money(t.revenue, t.currency)}</td><td class="num">${t.owner_age ?? "–"}</td><td class="num">${t.readiness ?? "–"}</td>
      <td>${t.next_action ? `${esc(t.next_action)}${t.next_date ? `<small class="muted block ${t.next_date < todayYmd() ? "tone-bad" : ""}">${dateLabel(t.next_date)}</small>` : ""}` : '<span class="muted">–</span>'}</td>
      <td class="muted">${when(t.updated_at)}</td></tr>`).join("")}</tbody></table></div>`;
}

function sortTable(th) {
  const key = th.dataset.sort, tbody = $("#ttable tbody");
  const dir = th.dataset.dir === "asc" ? "desc" : "asc";
  $$("#ttable th").forEach((x) => { delete x.dataset.dir; x.removeAttribute("aria-sort"); });
  th.dataset.dir = dir; th.setAttribute("aria-sort", dir === "asc" ? "ascending" : "descending");
  const rows = $$("tr", tbody);
  const numeric = ["ebitda", "revenue", "owner_age", "stage"].includes(key);
  rows.sort((a, b) => {
    const x = a.dataset[key], y = b.dataset[key];
    const c = numeric ? Number(x) - Number(y) : x.localeCompare(y);
    return dir === "asc" ? c : -c;
  });
  rows.forEach((r) => tbody.append(r));
}

// Drag a card to another column to change its stage.
function wireBoard(targets, seq, params) {
  $$("#ttable tbody tr").forEach((tr) => tr.addEventListener("click", (e) => { if (!e.target.closest("a")) location.hash = tr.dataset.href; }));
  let dragId = null;
  $$(".tcard").forEach((c) => {
    c.addEventListener("dragstart", (e) => { dragId = c.dataset.id; c.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", dragId); });
    c.addEventListener("dragend", () => { c.classList.remove("dragging"); $$(".col").forEach((x) => x.classList.remove("over")); });
  });
  $$(".col").forEach((col) => {
    col.addEventListener("dragover", (e) => { if (!dragId) return; e.preventDefault(); col.classList.add("over"); });
    col.addEventListener("dragleave", (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove("over"); });
    col.addEventListener("drop", async (e) => {
      e.preventDefault();
      col.classList.remove("over");
      const id = dragId; dragId = null;
      const t = targets.find((x) => String(x.id) === id);
      if (!t || t.stage === col.dataset.stage) return;
      let extra = {};
      if (col.dataset.stage === "lost") {
        const r = await dialog({ title: `Why did ${t.name} fall through?`, html: `<label class="field">Reason<input name="lost_reason" placeholder="e.g. owner decided to keep it, price gap, sold to someone else" maxlength="300"></label>`, submit: "Mark as lost" });
        if (!r) return;
        extra = { lost_reason: r.lost_reason };
      }
      try {
        await post(`/api/targets/${t.id}`, { stage: col.dataset.stage, ...extra }, "PATCH");
        toast(`${t.name} → ${stageById(col.dataset.stage).label}`);
        renderPipeline(seq, params);
      } catch (err) { fail(err); }
    });
  });
}

export const TARGET_FIELDS = (t = {}) => `
  <label class="field">Company name<input name="name" required maxlength="140" value="${esc(t.name || "")}" placeholder="Dalton Heating & Air"></label>
  <div class="two"><label class="field">Industry<input name="industry" maxlength="80" value="${esc(t.industry || "")}" placeholder="HVAC"></label>
  <label class="field">Location<input name="location" maxlength="120" value="${esc(t.location || "")}" placeholder="Columbus, OH"></label></div>
  <div class="two"><label class="field">Owner<input name="owner_name" maxlength="120" value="${esc(t.owner_name || "")}" placeholder="Frank Dalton"></label>
  <label class="field">Owner's age<input name="owner_age" type="number" min="18" max="110" value="${t.owner_age ?? ""}"></label></div>
  <div class="three"><label class="field">Revenue<input name="revenue" type="number" min="0" step="any" value="${t.revenue ?? ""}"></label>
  <label class="field">EBITDA<input name="ebitda" type="number" step="any" value="${t.ebitda ?? ""}"></label>
  <label class="field">Currency<select name="currency">${CURS.map((c) => `<option value="${c}" ${c === (t.currency || "$") ? "selected" : ""}>${c.trim()}</option>`).join("")}</select></label></div>
  <div class="two"><label class="field">Stage<select name="stage">${STAGES.map((s) => `<option value="${s.id}" ${s.id === (t.stage || "sourced") ? "selected" : ""}>${s.label}</option>`).join("")}</select></label>
  <label class="field">Priority<select name="priority">${[1, 2, 3].map((p) => `<option value="${p}" ${p === (t.priority || 2) ? "selected" : ""}>${PRIORITY[p]}</option>`).join("")}</select></label></div>
  <div class="two"><label class="field">Next action<input name="next_action" maxlength="300" value="${esc(t.next_action || "")}" placeholder="Send the first letter"></label>
  <label class="field">Due<input name="next_date" type="date" value="${t.next_date || ""}"></label></div>`;

export async function addTarget(prefill = {}) {
  const r = await dialog({ title: "Add a target", html: TARGET_FIELDS({ next_date: addDays(2), ...prefill }), submit: "Add target", wide: true });
  if (!r) return;
  try {
    const t = await post("/api/targets", r);
    toast(`${t.name} added`);
    location.hash = `#/targets/${t.id}`;
  } catch (e) { fail(e); }
}

// ------------------------------------------------------------------ CSV import
function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true;
    else if (c === "," || c === ";" || c === "\t") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}
// Aliases cover hand-made sheets plus ListKit, Apollo, Clay and Sales Navigator exports.
const HEADER_MAP = {
  name: ["name", "company", "company name", "business", "business name", "target", "organization", "organization name", "account name"], industry: ["industry", "sector", "category", "company industry"], location: ["location", "town", "address", "region", "company address"],
  website: ["website", "url", "site", "domain", "company domain", "company website", "website url"], owner_name: ["owner", "owner name", "contact", "contact name", "ceo", "director", "full name", "person name"], owner_age: ["owner age", "age"],
  phone: ["phone", "telephone", "tel", "phone number", "mobile phone", "mobile", "direct phone", "work phone", "company phone", "corporate phone"], email: ["email", "e-mail", "email address", "work email", "business email", "verified email"], employees: ["employees", "staff", "headcount", "employee count", "# employees", "number of employees", "company size"], revenue: ["revenue", "turnover", "sales", "annual revenue", "company revenue"],
  first_name: ["first name", "firstname"], last_name: ["last name", "lastname", "surname"], city: ["city", "company city"], state: ["state", "province", "company state"], country: ["country", "company country"], title: ["title", "job title", "position"], linkedin: ["linkedin", "linkedin url", "person linkedin url", "linkedin profile"],
  ebitda: ["ebitda", "profit", "earnings", "operating profit"], asking: ["asking", "asking price", "price"], stage: ["stage", "status"], source: ["source"], tags: ["tags", "tag"],
  next_action: ["next action", "next step"], next_date: ["next date", "due", "due date"], motivation: ["notes", "motivation", "comment", "comments"],
};
function mapHeader(h) {
  const k = h.trim().toLowerCase().replace(/[_-]+/g, " ");
  return Object.entries(HEADER_MAP).find(([, al]) => al.includes(k))?.[0] || null;
}
const toNum = (v) => { const s = String(v || "").replace(/[^\d.,-]/g, "").replace(/,(?=\d{3}\b)/g, "").replace(",", "."); return s ? Number(s) : null; };

async function importCsv() {
  const input = document.createElement("input");
  input.type = "file"; input.accept = ".csv,text/csv,text/plain";
  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    if (file.size > 2e6) { toast("That file is over 2 MB. Split it up.", "error"); return; }
    const rows = parseCsv(await file.text());
    if (rows.length < 2) { toast("That CSV has no rows under the header.", "error"); return; }
    const cols = rows[0].map(mapHeader);
    if (!cols.includes("name")) { toast("Add a column called “name” or “company”.", "error"); return; }
    const stageIds = new Set(STAGES.map((s) => s.id));
    const items = rows.slice(1).map((r) => {
      const o = {};
      cols.forEach((k, i) => { if (k && r[i] != null && r[i].trim() !== "") o[k] = r[i].trim(); });
      // Person-level exports (ListKit, Apollo): build the owner and the location from their parts.
      if (!o.owner_name && (o.first_name || o.last_name)) o.owner_name = [o.first_name, o.last_name].filter(Boolean).join(" ");
      if (!o.location && (o.city || o.state || o.country)) o.location = [o.city, o.state, o.country].filter(Boolean).join(", ");
      const extra = [o.title && `${o.owner_name || "Contact"} is ${o.title}.`, o.linkedin && `LinkedIn: ${o.linkedin}`].filter(Boolean).join(" ");
      if (extra) o.motivation = [o.motivation, extra].filter(Boolean).join(" ");
      ["first_name", "last_name", "city", "state", "country", "title", "linkedin"].forEach((k) => delete o[k]);
      if (o.website && !/^https?:/i.test(o.website)) o.website = `https://${o.website}`;
      if (o.employees && /\d+\s*-\s*\d+/.test(String(o.employees))) o.employees = String(o.employees).split("-")[0];
      ["revenue", "ebitda", "asking", "employees", "owner_age"].forEach((k) => { if (k in o) o[k] = toNum(o[k]); });
      if (o.stage) { const s = STAGES.find((x) => x.label.toLowerCase() === o.stage.toLowerCase() || x.id === o.stage.toLowerCase()); o.stage = s ? s.id : "sourced"; }
      if (o.stage && !stageIds.has(o.stage)) o.stage = "sourced";
      return o;
    }).filter((o) => o.name);
    const used = [...new Set(cols.filter(Boolean))];
    const ok = await dialog({
      title: `Import ${items.length} target${items.length === 1 ? "" : "s"}?`,
      html: `<p>Columns found: <b>${used.map(esc).join(", ")}</b>.</p><p class="muted small">Unrecognised columns are skipped. Up to 500 rows per import.</p>
        <div class="table-wrap"><table class="mini-table"><tbody>${items.slice(0, 5).map((o) => `<tr><td>${esc(o.name)}</td><td>${esc(o.industry || "")}</td><td>${esc(o.location || "")}</td><td>${o.ebitda != null ? money(o.ebitda) : ""}</td></tr>`).join("")}</tbody></table></div>${items.length > 5 ? `<p class="muted small">…and ${items.length - 5} more.</p>` : ""}`,
      submit: "Import",
    });
    if (!ok) return;
    try {
      const r = await post("/api/targets/import", { rows: items.slice(0, 500) });
      toast(`Imported ${r.imported}${r.skipped.length ? `, skipped ${r.skipped.length}` : ""}`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    } catch (e) { fail(e); }
  });
  input.click();
}

async function loadSamples() {
  const rows = [
    { name: "Dalton Heating & Air", industry: "HVAC", location: "Columbus, OH", owner_name: "Frank Dalton", owner_age: 67, employees: 28, revenue: 6500000, ebitda: 900000, stage: "contacted", priority: 1, source: "Example", next_action: "Follow-up call about his techs", next_date: addDays(1), motivation: "Example target. Back pain, wants out within two years, worried about his two longest-serving techs.", tags: "example" },
    { name: "Park Family Dental", industry: "Dental", location: "Pasadena, CA", owner_name: "Dr. Susan Park", owner_age: 61, employees: 17, revenue: 3800000, ebitda: 850000, stage: "first_call", priority: 2, source: "Example", next_action: "Send the meeting invite", next_date: addDays(3), tags: "example" },
    { name: "Hughes & Co. Accountants", industry: "Accounting", location: "Leeds, UK", owner_name: "Robert Hughes", owner_age: 72, employees: 12, revenue: 2100000, ebitda: 700000, currency: "£", stage: "sourced", priority: 2, source: "Example", next_action: "Write the first letter", next_date: addDays(-1), tags: "example" },
  ];
  try { await post("/api/targets/import", { rows }); toast("Three example targets added. Delete them whenever you like."); window.dispatchEvent(new HashChangeEvent("hashchange")); } catch (e) { fail(e); }
}
