// Board, bench & lenders: C1 (Capabilities) and C2 (Capital) of the JL skill's 3C model. The board seats and
// founders' equity, the professional bench on rolled fees, the lender matrix (20-50 lenders before the first deal),
// the skill's scripts for each, and the credibility packet. All copy on this page is quoted from the skill.
import { $, $$, esc, api, post, toast, fail, view, stale, synced, dialog, confirmBox, copy, skeleton, todayYmd, dateLabel } from "../core.js";
import { BOARD_ROLES, BENCH_ROLES, RECRUITMENT, BENCH_FEES, FOUNDER_EQUITY, CREDIBILITY_OUTPUTS, C1_SCRIPTS, C2_SCRIPTS, LENDER_APPROACH, LENDER_QUESTIONS, LENDER_ONGOING, LENDER_FIELDS, LENDER_TARGET, CAPITAL_CRITICAL, UNSECURED_CONVERSION, REL_STATUSES, JL_SOURCE } from "../jl.js";
import { money } from "../deal.js";

const TABS = [["board", "Board"], ["bench", "Bench"], ["lender", "Lender matrix"], ["scripts", "Scripts"]];
const roleLabel = (kind, id) => [...BOARD_ROLES, ...BENCH_ROLES].find((r) => r.id === id)?.label || id || "";
const statusLabel = (kind, s) => (REL_STATUSES[kind].find(([k]) => k === s) || [s, s])[1];

// The skill's placeholders, filled from the profile; anything unknown stays visible as [placeholder].
function fill(text, extra = {}) {
  const p = synced.get("profile", {}) || {};
  const v = { "[Your Name]": p.name, "[Company]": p.company, "[Company Name]": p.company, "[Your Company]": p.company, "[Phone]": p.phone, ...extra };
  return Object.entries(v).reduce((s, [k, val]) => (val ? s.split(k).join(val) : s), String(text));
}

export async function renderCapital(seq, params) {
  const tab = TABS.some(([k]) => k === params.get("tab")) ? params.get("tab") : "board";
  view().innerHTML = skeleton(5);
  const data = await api("/api/relationships");
  if (stale(seq)) return;
  const s = data.summary;
  const rows = data.relationships;
  view().innerHTML = `
    <header class="page-head with-actions">
      <div><p class="eyebrow">C1 Capabilities · C2 Capital</p><h1>Board, bench &amp; lenders</h1>
        <p class="lede muted">“Your team's credibility substitutes for personal capital and experience.” Build the board and the bench, then interview lenders before you need money.</p></div>
      <div class="row"><button class="ghost" id="packet" type="button">Write the credibility packet</button><button class="primary" id="add" type="button">Add ${tab === "lender" ? "a lender" : tab === "bench" ? "to the bench" : "a board member"}</button></div>
    </header>
    <div class="kpis four">
      <div class="kpi ${s.board.filled >= 4 ? "accent" : ""}"><span>Board seats filled</span><b>${s.board.filled}/4</b><small>${s.board.equity ? `${s.board.equity}% equity committed` : "Offer founders' equity, not cash"}</small></div>
      <div class="kpi"><span>Bench engaged</span><b>${s.bench.engaged}</b><small>${s.bench.roles.map((r) => `${r.label.replace(/s$/, "")} ${r.engaged ? "✓" : "—"}`).join(" · ")}</small></div>
      <div class="kpi ${s.lenders.interviewed >= LENDER_TARGET.min ? "accent" : ""}"><span>Lenders interviewed</span><b>${s.lenders.interviewed}<small>/${LENDER_TARGET.min}–${LENDER_TARGET.max}</small></b><small>${s.lenders.total} tracked · ${s.lenders.inMatrix} with parameters</small></div>
      <div class="kpi ${s.stale ? "warnk" : ""}"><span>Going stale</span><b>${s.stale}</b><small>Board monthly · lenders quarterly</small></div>
    </div>
    <nav class="tabs" style="margin-top:24px">${TABS.map(([k, l]) => `<a href="#/capital?tab=${k}" class="${k === tab ? "on" : ""}" ${k === tab ? 'aria-current="page"' : ""}>${l}</a>`).join("")}</nav>
    <div id="pane"></div>`;
  const pane = $("#pane");
  if (tab === "board") pane.innerHTML = seatsPanel(s) + listPanel("board", rows) + guide("Recruitment strategy", RECRUITMENT) + guide(FOUNDER_EQUITY.title, FOUNDER_EQUITY.lines);
  if (tab === "bench") pane.innerHTML = listPanel("bench", rows) + guide("Fee structures", BENCH_FEES) + guide("External professional bench", BENCH_ROLES.map((r) => `${r.label}: ${r.text}`));
  if (tab === "lender") pane.innerHTML = matrixPanel(rows, s) + guide("Approach banks as interviewer, not beggar", LENDER_APPROACH) + guide("Phase 3: ongoing relationship", LENDER_ONGOING) + guide("Critical metrics", CAPITAL_CRITICAL);
  if (tab === "scripts") pane.innerHTML = scriptsPane();
  $("#add").addEventListener("click", () => edit(tab === "scripts" ? "board" : tab, null, seq));
  $("#packet").addEventListener("click", async (e) => {
    e.target.disabled = true; e.target.textContent = "Writing…";
    try { const d = await post("/api/documents/generate", { kind: "credibility" }); location.hash = `#/desk/${d.id}`; } catch (err) { fail(err); e.target.disabled = false; e.target.textContent = "Write the credibility packet"; }
  });
  wire(rows, seq);
  const focus = params.get("focus");
  if (focus) { const r = rows.find((x) => x.id === +focus); if (r) edit(r.kind, r, seq); }
}

function seatsPanel(s) {
  return `<section class="panel"><div class="panel-head"><h2 class="h3">The four seats</h2><span class="muted small">${esc(JL_SOURCE)}</span></div>
    <div class="seat-grid">${s.board.seats.map((x) => `<div class="seat ${x.filled.length ? "filled" : ""}"><b>${esc(x.label)}</b><p class="muted small">${esc(x.text)}</p><p>${x.filled.length ? esc(x.filled.join(", ")) : '<span class="tone-warn small">Open</span>'}</p></div>`).join("")}</div></section>`;
}

function guide(title, lines) {
  return `<details class="panel guide"><summary class="h3">${esc(title)}</summary><ul>${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul><p class="muted small">${esc(JL_SOURCE)}</p></details>`;
}

const due = (r) => (r.next_date ? `<span class="${r.next_date < todayYmd() ? "tone-bad" : ""}">${dateLabel(r.next_date)}</span>` : "");
const lastSeen = (r) => (r.last_contact ? `${r.days_since ? `${r.days_since}d ago` : "today"}${r.stale ? ' <span class="status-chip warn">stale</span>' : ""}` : '<span class="muted">—</span>');
const statusSelect = (r) => `<select data-status="${r.id}" aria-label="Status">${REL_STATUSES[r.kind].map(([k, l]) => `<option value="${k}" ${k === r.status ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
const actions = (r) => `<td class="acts"><button class="mini-btn" data-touch="${r.id}" type="button" title="Spoke to them today">✓ Touch</button><button class="mini-btn" data-script="${r.id}" type="button">Script</button><button class="mini-btn" data-edit="${r.id}" type="button">Edit</button></td>`;

function listPanel(kind, rows) {
  const list = rows.filter((r) => r.kind === kind);
  if (!list.length) return `<section class="panel empty"><h2>${kind === "board" ? "No board members yet" : "No one on the bench yet"}</h2><p class="muted">${kind === "board" ? "“Target recently retired executives looking for meaningful involvement.” Add the people you'd ask, then pitch them with the skill's script." : "Accountants for the QoE, M&A lawyers, an industry SME, on delayed or rolled fees."}</p><button class="primary" type="button" data-add="${kind}">Add the first one</button></section>`;
  return `<section class="panel flush table-wrap"><table class="list-table rel-table"><thead><tr><th>Name</th><th>Role</th><th>Status</th><th>${kind === "board" ? "Equity" : "Fees"}</th><th>Last touch</th><th>Next</th><th></th></tr></thead><tbody>
    ${list.map((r) => `<tr class="${r.status === "passed" ? "muted" : ""}"><td><b>${esc(r.name)}</b>${r.firm ? `<br><small class="muted">${esc(r.firm)}</small>` : ""}</td><td>${esc(roleLabel(kind, r.role))}</td><td>${statusSelect(r)}</td>
      <td>${kind === "board" ? (r.equity_pct != null ? `${r.equity_pct}%` : "—") : esc(r.terms.fees || "—")}</td><td>${lastSeen(r)}</td><td>${due(r)}</td>${actions(r)}</tr>`).join("")}
  </tbody></table></section>`;
}

const MATRIX_COLS = ["sector_exp", "min_dscr", "max_ltv", "pg_policy", "amort_years", "timing_days"];
function fmtField(f, v, cur = "$") {
  if (v == null || v === "") return '<span class="muted">?</span>';
  if (f.money) return esc(money(v, cur));
  return esc(`${v}${f.suffix || ""}`);
}
function matrixPanel(rows) {
  const list = rows.filter((r) => r.kind === "lender");
  const cols = MATRIX_COLS.map((k) => LENDER_FIELDS.find((f) => f.k === k));
  if (!list.length) return `<section class="panel empty"><h2>Build the lender matrix</h2><p class="muted">“${esc(LENDER_TARGET.note)}.” Add the banks, send the 3-4 sentence Phase 1 email, and fill in their parameters from the interview.</p><button class="primary" type="button" data-add="lender">Add the first lender</button></section>`;
  return `<section class="panel flush table-wrap"><table class="list-table rel-table"><thead><tr><th>Lender</th><th>Status</th>${cols.map((f) => `<th>${esc(f.label)}</th>`).join("")}<th>Notes</th><th>Last touch</th><th></th></tr></thead><tbody>
    ${list.map((r) => `<tr class="${r.status === "passed" ? "muted" : ""}"><td><b>${esc(r.firm || r.name)}</b><br><small class="muted">${esc(r.firm ? r.name : "")}</small></td><td>${statusSelect(r)}</td>
      ${cols.map((f) => `<td>${fmtField(f, r.terms[f.k])}</td>`).join("")}<td class="small">${esc((r.terms.sectors ? `Likes ${r.terms.sectors}. ` : "") + (r.notes || "")).slice(0, 90)}</td><td>${lastSeen(r)}</td>${actions(r)}</tr>`).join("")}
  </tbody></table></section>`;
}

function scriptBlock(key, s, extra) {
  return `<article class="panel script-card"><div class="panel-head"><h2 class="h3">${esc(s.title)}</h2><button class="ghost small" type="button" data-copy="${key}">Copy</button></div>
    ${s.subject ? `<p class="small"><b>Subject:</b> ${esc(fill(s.subject, extra))}</p>` : ""}<p class="pre-line">${esc(fill(s.text, extra))}</p><p class="muted small">${esc(JL_SOURCE)}</p></article>`;
}
const ALL_SCRIPTS = { ...C1_SCRIPTS, ...C2_SCRIPTS };
function scriptsPane() {
  return `<div class="script-grid">${Object.entries(ALL_SCRIPTS).map(([k, s]) => scriptBlock(k, s)).join("")}</div>
    ${guide("Phase 2: initial call questions", LENDER_QUESTIONS.flatMap((g) => g.qs.map((q) => `${g.group}: ${q}`)))}
    ${guide(`${UNSECURED_CONVERSION.title}: counter-approach`, UNSECURED_CONVERSION.counter)}
    ${guide(`${UNSECURED_CONVERSION.title}: fallback positions (in order)`, UNSECURED_CONVERSION.fallbacks)}
    ${guide("Credibility outputs", CREDIBILITY_OUTPUTS)}`;
}

// The right script for one person, with their name and role filled in.
function scriptFor(r) {
  const first = r.name.split(" ")[0];
  if (r.kind === "lender") {
    const s = r.status === "prospect" ? C2_SCRIPTS.lenderEmail : C2_SCRIPTS.lenderIntro;
    return { s, extra: { "[Banker Name]": first } };
  }
  if (r.kind === "board") return { s: C1_SCRIPTS.board, extra: { "[Name]": first, "[Board Chair/Finance Lead/etc.]": roleLabel("board", r.role) || "[Board Chair/Finance Lead/etc.]", "[0.5-2.0]": r.equity_pct != null ? String(r.equity_pct) : "[0.5-2.0]" } };
  return { s: { title: "Fee structures to propose", text: BENCH_FEES.map((x) => `- ${x}`).join("\n") }, extra: {} };
}

function wire(rows, seq) {
  const byId = (id) => rows.find((r) => r.id === +id);
  $$("[data-add]").forEach((b) => b.addEventListener("click", () => edit(b.dataset.add, null, seq)));
  $$("[data-edit]").forEach((b) => b.addEventListener("click", () => edit(byId(b.dataset.edit).kind, byId(b.dataset.edit), seq)));
  $$("[data-status]").forEach((sel) => sel.addEventListener("change", async () => {
    try { await post(`/api/relationships/${sel.dataset.status}`, { status: sel.value }, "PATCH"); toast(`Moved to ${statusLabel(byId(sel.dataset.status).kind, sel.value)}`); } catch (e) { fail(e); }
  }));
  $$("[data-touch]").forEach((b) => b.addEventListener("click", async () => {
    try { await post(`/api/relationships/${b.dataset.touch}`, { last_contact: todayYmd() }, "PATCH"); toast("Logged"); await renderCapital(seq, new URLSearchParams(location.hash.split("?")[1] || "")); } catch (e) { fail(e); }
  }));
  $$("[data-script]").forEach((b) => b.addEventListener("click", async () => {
    const r = byId(b.dataset.script), { s, extra } = scriptFor(r);
    const body = fill(s.text, extra), subject = s.subject ? fill(s.subject, extra) : "";
    const mail = r.email ? `mailto:${encodeURIComponent(r.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` : "";
    const go = await dialog({ title: s.title, wide: true, submit: "Copy", html: `${subject ? `<p class="small"><b>Subject:</b> ${esc(subject)}</p>` : ""}<p class="pre-line">${esc(body)}</p>${mail ? `<p><a class="ghost" href="${mail}">Open in your email</a></p>` : ""}<p class="muted small">${esc(JL_SOURCE)}. Fill any [placeholder] before sending.</p>` });
    if (go) copy(subject ? `${subject}\n\n${body}` : body);
  }));
  $$("[data-copy]").forEach((b) => b.addEventListener("click", () => { const s = ALL_SCRIPTS[b.dataset.copy]; copy(`${s.subject ? `${fill(s.subject)}\n\n` : ""}${fill(s.text)}`); }));
}

async function edit(kind, r, seq) {
  const t = r?.terms || {};
  const roles = kind === "board" ? BOARD_ROLES : kind === "bench" ? BENCH_ROLES : null;
  const field = (name, label, value = "", type = "text", extra = "") => `<label>${esc(label)}<input name="${name}" type="${type}" value="${esc(value ?? "")}" ${extra}></label>`;
  const lenderFields = kind === "lender" ? `<h3 class="h4">Lender matrix</h3><p class="muted small">From the interview. Each field has the skill's question to ask.</p><div class="form-grid">${LENDER_FIELDS.map((f) => {
    const q = LENDER_QUESTIONS.flatMap((g) => g.qs).find((x) => x.toLowerCase().includes(f.label.toLowerCase().split(" ")[0].slice(0, 5)));
    const input = f.type === "select" ? `<select name="t_${f.k}"><option value="">?</option>${f.options.map((o) => `<option ${t[f.k] === o ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>` : `<input name="t_${f.k}" type="${f.type === "number" ? "number" : "text"}" ${f.step ? `step="${f.step}"` : 'step="any"'} value="${esc(t[f.k] ?? "")}">`;
    return `<label title="${esc(q || "")}">${esc(f.label)}${f.suffix ? ` (${esc(f.suffix.trim())})` : ""}${input}</label>`;
  }).join("")}</div>` : "";
  const html = `<div class="form-grid">
      ${field("name", kind === "lender" ? "Banker's name" : "Name", r?.name, "text", "required maxlength=120")}
      ${field("firm", kind === "lender" ? "Bank / lender" : "Firm", r?.firm)}
      ${roles ? `<label>Role<select name="role">${roles.map((x) => `<option value="${x.id}" ${r?.role === x.id ? "selected" : ""}>${esc(x.label)}</option>`).join("")}</select></label>` : ""}
      <label>Status<select name="status">${REL_STATUSES[kind].map(([k, l]) => `<option value="${k}" ${(r?.status || "prospect") === k ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
      ${field("email", "Email", r?.email, "email")}${field("phone", "Phone", r?.phone)}${field("linkedin", "LinkedIn", r?.linkedin, "url")}
      ${kind === "board" ? field("equity_pct", "Founders' equity (%)", r?.equity_pct, "number", 'step="0.05" min="0" max="50" placeholder="0.25 – 2.0"') : ""}
      ${kind === "board" ? field("t_vesting", "Vesting", t.vesting || "50% on first signed SPA; 50% over 12 months post-close with monthly advisory") : ""}
      ${kind === "bench" ? field("t_fees", "Fee terms", t.fees, "text", 'placeholder="Deferred to close / paid from working capital loan"') : ""}
      ${kind !== "lender" ? field("t_track", "Track record (for the credibility packet)", t.track, "text", 'placeholder="e.g. 30 years, $200M in transactions"') : ""}
      ${field("last_contact", "Last spoke", r?.last_contact, "date")}${field("next_date", "Next follow-up", r?.next_date, "date")}
    </div>${lenderFields}<label>Notes<textarea name="notes" rows="3" maxlength="4000">${esc(r?.notes || "")}</textarea></label>
    ${r ? `<p><button class="link danger" type="button" id="relDel">Remove ${esc(r.name)}</button></p>` : ""}`;
  const f = await dialog({ title: r ? `Edit ${r.name}` : `Add ${kind === "lender" ? "a lender" : kind === "bench" ? "to the bench" : "a board member"}`, html, wide: kind === "lender", onOpen: (d, done) => {
    $("#relDel", d)?.addEventListener("click", async () => { done(null); if (await confirmBox(`Remove ${r.name}?`, "Their matrix data and deal financing records go too.", "Remove")) { await post(`/api/relationships/${r.id}`, {}, "DELETE").catch(fail); renderCapital(seq, new URLSearchParams(location.hash.split("?")[1] || "")); } });
  } });
  if (!f) return;
  const terms = {}, out = { kind };
  for (const [k, v] of Object.entries(f)) { if (k.startsWith("t_")) terms[k.slice(2)] = v; else out[k] = v; }
  out.terms = terms;
  try {
    if (r) await post(`/api/relationships/${r.id}`, out, "PATCH"); else await post("/api/relationships", out);
    toast(r ? "Saved" : "Added");
    renderCapital(seq, new URLSearchParams(location.hash.split("?")[1] || ""));
  } catch (e) { fail(e); }
}
