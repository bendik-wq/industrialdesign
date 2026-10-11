// The deal room for one target: steps 2-5 of the JL skill's five-step deal flow plus the first 100 days.
// Qualification gate (with the seller's private upload link), NBIO/LOI and exclusivity, the diligence log graded by
// the red flag decision matrix, conditions precedent with lender fit and financing, close and settlement, 100 days.
import { $, $$, esc, api, post, toast, fail, view, stale, dialog, confirmBox, copy, skeleton, dateLabel, todayYmd, when } from "../core.js";
import { ROOM_TABS, NBIO, TIMELINE, CONTRACT_CLOSE, PLAN_PRINCIPLES, QUALIFICATION, FINANCING_STAGES, UNSECURED_CONVERSION, JL_SOURCE } from "../jl.js";
import { money } from "../deal.js";

const STATUS = [["open", "Open"], ["requested", "Requested"], ["received", "Received"], ["done", "Done"], ["issue", "Issue"], ["na", "N/A"]];
const SEV = { high: "HIGH", medium: "MEDIUM", low: "LOW" };
const kb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export async function renderRoom(id, seq, params) {
  const tab = ROOM_TABS.some(([k]) => k === params.get("tab")) ? params.get("tab") : null;
  view().innerHTML = skeleton(6);
  const R = await api(`/api/targets/${id}/room`);
  if (stale(seq)) return;
  const cur = R.target.currency || "$", r = R.room, c = R.clocks;
  const active = tab || (r.settled_at ? "plan" : r.contract_start ? "close" : r.dd_start ? "dd" : r.offer_at ? "offer" : "gate");
  const pct = (k) => { const p = R.progress[k]; return p?.total ? Math.round((p.done / p.total) * 100) : 0; };
  const steps = [
    { k: "gate", label: "Qualification gate", on: R.gatePassed, sub: R.gatePassed ? "Passed" : `${R.progress.gate?.done || 0}/${R.progress.gate?.total || 0}` },
    { k: "offer", label: r.offer_kind || "NBIO / LOI", on: !!r.loi_signed_at, sub: r.loi_signed_at ? `Signed ${dateLabel(r.loi_signed_at)}` : r.offer_at ? `Sent ${dateLabel(r.offer_at)}` : "Not sent" },
    { k: "dd", label: "Due diligence", on: c.dd?.done, sub: c.dd ? `Day ${c.dd.used} of ${TIMELINE.ddDays}` : "Not started" },
    { k: "close", label: "Contract & settlement", on: !!r.settled_at, sub: r.settled_at ? `Settled ${dateLabel(r.settled_at)}` : c.contract ? `Day ${c.contract.used} of ${TIMELINE.contractDays}` : "Not started" },
    { k: "plan", label: "First 100 days", on: pct("plan") === 100, sub: r.settled_at ? `${pct("plan")}% done` : "After settlement" },
  ];
  view().innerHTML = `
    <header class="page-head with-actions">
      <div><a class="link" href="#/targets/${R.target.id}">← ${esc(R.target.name)}</a><h1>Deal room</h1>
        <p class="muted">${esc(R.target.name)}${R.target.owner_name ? ` · ${esc(R.target.owner_name)}` : ""} · C3 Closing, from the ${esc(JL_SOURCE)}</p></div>
      <div class="row"><button class="ghost" id="upload" type="button">Upload a file</button><button class="primary" id="link" type="button">${r.link_on ? "Seller link" : "Make a seller link"}</button></div>
    </header>
    ${c.warnings.length ? `<div class="room-warn">${c.warnings.map((w) => `<p class="${w.level === "high" ? "tone-bad" : "tone-warn"}">⚠ ${esc(w.text)}</p>`).join("")}</div>` : ""}
    <ol class="flow">${steps.map((s, i) => `<li class="${s.on ? "done" : ""} ${s.k === active ? "on" : ""}"><a href="#/room/${R.target.id}?tab=${s.k}"><span class="num">${s.on ? "✓" : i + 2}</span><b>${esc(s.label)}</b><small>${esc(s.sub)}</small></a></li>`).join("")}</ol>
    <nav class="tabs">${ROOM_TABS.map(([k, l]) => `<a href="#/room/${R.target.id}?tab=${k}" class="${k === active ? "on" : ""}">${esc(l)}${R.progress[k]?.issues ? ` <span class="status-chip bad">${R.progress[k].issues}</span>` : ""}</a>`).join("")}</nav>
    <div id="pane"></div>`;
  const pane = $("#pane");
  const reload = () => renderRoom(id, seq, new URLSearchParams(`tab=${active}`));
  const P = { R, cur, reload, id };
  if (active === "gate") pane.innerHTML = gatePane(P);
  if (active === "offer") pane.innerHTML = offerPane(P);
  if (active === "dd") pane.innerHTML = ddPane(P);
  if (active === "cp") { pane.innerHTML = listPane(P, "cp", "Every deal must satisfy these.") + `<section class="panel" id="lenders"><p class="muted small">Loading lenders…</p></section>`; lendersPanel(P); }
  if (active === "close") pane.innerHTML = closePane(P);
  if (active === "plan") pane.innerHTML = planPane(P);
  wireItems(P);
  wireMilestones(P);
  $("#upload").addEventListener("click", () => uploadDialog(P));
  $("#link").addEventListener("click", () => linkDialog(P));
}

// ------------------------------------------------------------------ checklists
function itemRow(P, i) {
  const files = P.R.files.filter((f) => f.item_id === i.id);
  return `<li class="ritem s-${i.status}" data-item="${i.id}">
    <select data-istatus="${i.id}" aria-label="Status">${STATUS.map(([k, l]) => `<option value="${k}" ${k === i.status ? "selected" : ""}>${l}</option>`).join("")}</select>
    <div class="ri-main"><span class="ri-title">${esc(i.title)}</span>${i.severity ? ` <span class="sev sev-${i.severity}">${SEV[i.severity]}</span>` : ""}${i.seller ? ' <span class="status-chip" title="The seller sees this on their link">seller</span>' : ""}
      ${i.action ? `<div class="small tone-${i.severity === "high" ? "bad" : "warn"}">Action: ${esc(i.action)}</div>` : ""}
      ${i.notes ? `<div class="small muted pre-line">${esc(i.notes)}</div>` : ""}
      ${files.length ? `<div class="ri-files">${files.map((f) => `<a href="${f.url}" class="chip" download>${f.source === "seller" ? "⇪ " : ""}${esc(f.name)} · ${kb(f.size)}</a>`).join("")}</div>` : ""}</div>
    <span class="ri-due ${i.due_date && i.due_date < todayYmd() && !["done", "received", "na"].includes(i.status) ? "tone-bad" : "muted"} small">${i.due_date ? dateLabel(i.due_date) : ""}</span>
    <button class="mini-btn" type="button" data-iedit="${i.id}" aria-label="Edit">Edit</button></li>`;
}
function grouped(P, list, filter = () => true) {
  const items = (P.R.lists[list] || []).filter(filter), sections = [...new Set(items.map((i) => i.section || ""))];
  return sections.map((s) => `<h3 class="h4 rsec">${esc(s || "Other")}</h3><ul class="ritems">${items.filter((i) => (i.section || "") === s).map((i) => itemRow(P, i)).join("")}</ul>`).join("");
}
function listPane(P, list, lede = "") {
  const p = P.R.progress[list] || { done: 0, total: 0 };
  return `<section class="panel"><div class="panel-head"><h2 class="h3">${esc(Object.fromEntries(ROOM_TABS)[list])}</h2><span class="muted small">${p.done}/${p.total} done</span></div>
    <div class="progress"><span style="width:${p.total ? (p.done / p.total) * 100 : 0}%"></span></div>${lede ? `<p class="muted small">${esc(lede)}</p>` : ""}
    ${grouped(P, list)}<p><button class="ghost small" type="button" data-iadd="${list}">+ Add a line</button></p></section>`;
}

function gatePane(P) {
  const { R } = P, r = R.room, g = R.gateSignal;
  return `${listPane(P, "gate", QUALIFICATION.note)}
    <section class="panel"><h2 class="h3">Seller's side</h2>
      <p>${r.link_on ? `Link on (…${esc(r.token_hint)}). ${r.seller_views ? `Opened ${r.seller_views} time${r.seller_views === 1 ? "" : "s"}, last ${when(r.seller_seen_at)}.` : "Not opened yet."}` : "No link yet. Make one and send it to the owner after the call: they accept the NDA and upload the documents there, no account needed."}</p>
      <p>${r.nda_at ? `<span class="tone-ok">NDA accepted</span> by ${esc(r.nda_name)} on ${dateLabel(r.nda_at.slice(0, 10))}.` : "NDA not accepted yet."}</p>
      ${g ? `<p class="${g.level === "high" ? "tone-ok" : g.level === "low" ? "tone-bad" : "muted"}">Motivation signal: ${esc(g.text)}${g.level === "high" || g.level === "low" ? ` <span class="muted small">(JL skill: reading seller signals)</span>` : ""}</p>` : ""}
      <div class="row"><button class="ghost" id="chase" type="button">Chase for what's outstanding</button></div>
      <p class="muted small">The chase email waits for your approval in the Inbox before anything is sent.</p></section>
    ${R.healthcare ? "" : `<p class="muted small">Not a healthcare business, so the billing-by-practitioner line was left out. Add it with + Add a line if it applies.</p>`}`;
}

function field(name, label, value, type = "text", extra = "") { return `<label>${esc(label)}<input name="${name}" type="${type}" value="${esc(value ?? "")}" ${extra}></label>`; }
function offerPane(P) {
  const r = P.R.room, c = P.R.clocks;
  return `<section class="panel"><div class="panel-head"><h2 class="h3">${esc(NBIO.title)}</h2>${P.R.gatePassed ? "" : '<span class="tone-warn small">The qualification gate isn\'t passed yet</span>'}</div>
    <form class="milestones form-grid" data-ms>
      <label>Format<select name="offer_kind"><option value="">—</option>${["NBIO", "LOI"].map((k) => `<option ${r.offer_kind === k ? "selected" : ""}>${k}</option>`).join("")}</select></label>
      ${field("offer_at", "Sent on", r.offer_at, "date")}${field("offer_price", `Headline price (${P.cur})`, r.offer_price, "number", 'min="0" step="any"')}
      ${field("loi_signed_at", "Signed on", r.loi_signed_at, "date")}${field("exclusivity_days", "Exclusivity (days)", r.exclusivity_days, "number", 'min="0" max="365" placeholder="60-90"')}
      <label class="wide">Key terms<textarea name="offer_terms" rows="3" maxlength="4000" placeholder="Structure, conditions, timeline">${esc(r.offer_terms || "")}</textarea></label>
      <div class="row wide"><button class="primary" type="submit">Save</button><button class="ghost" type="button" id="draftLoi">Draft the LOI from the Deal Builder</button></div>
    </form>
    ${c.exclusivity ? `<p class="${c.exclusivity.left < 0 ? "tone-bad" : c.exclusivity.left <= 14 ? "tone-warn" : ""}">Exclusivity ${c.exclusivity.left < 0 ? `ended ${-c.exclusivity.left} days ago` : `ends in ${c.exclusivity.left} days`} (${dateLabel(c.exclusivity.ends)}).</p>` : ""}
    <h3 class="h4">Include</h3><ul>${NBIO.includes.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
    <ul class="muted small">${NBIO.tips.map((x) => `<li>${esc(x)}</li>`).join("")}</ul><p class="muted small">${esc(JL_SOURCE)}</p></section>`;
}

function ddPane(P) {
  const r = P.R.room, issues = (P.R.lists.dd || []).filter((i) => i.status === "issue").sort((a, b) => ["high", "medium", "low", null].indexOf(a.severity) - ["high", "medium", "low", null].indexOf(b.severity));
  return `<section class="panel"><div class="panel-head"><h2 class="h3">Diligence log</h2><span class="muted small">DD window: 90 days maximum</span></div>
    <form class="milestones row" data-ms>${field("dd_start", "Started", r.dd_start, "date")}<button class="ghost" type="submit">Save</button></form>
    <h3 class="h4">Issues ${issues.length ? `(${issues.length})` : ""}</h3>
    ${issues.length ? `<ul class="ritems">${issues.map((i) => itemRow(P, i)).join("")}</ul>` : '<p class="muted small">No issues logged. Log them as you find them; use findings to negotiate price adjustments.</p>'}
    <div class="row"><button class="primary small" type="button" id="flag">Log a red flag</button><a class="ghost small" href="#/targets/${P.R.target.id}">Run the Diligence review on the P&amp;L</a></div></section>
    ${listPane(P, "dd", "Primary focus: Quality of Earnings.")}`;
}

function closePane(P) {
  const r = P.R.room, c = P.R.clocks;
  return `<section class="panel"><h2 class="h3">Contractual close</h2>
    <form class="milestones form-grid" data-ms>
      ${field("contract_start", "Papering started", r.contract_start, "date")}${field("settled_at", "Settled on", r.settled_at, "date")}
      ${field("final_price", `Final price (${P.cur})`, r.final_price, "number", 'min="0" step="any"')}
      ${field("budget_fees", `Legal/accounting budget (${P.cur})`, r.budget_fees, "number", 'min="0" step="any"')}${field("spent_fees", `Spent so far (${P.cur})`, r.spent_fees, "number", 'min="0" step="any"')}
      ${field("first_contact", "First contact", r.first_contact, "date")}
      <div class="row wide"><button class="primary" type="submit">Save</button></div></form>
    <p class="small">${c.contract ? `Papering: day ${c.contract.used} of the 4-week target. ` : ""}${c.ddVariance != null ? `DD variance: ${c.ddVariance > 0 ? "+" : ""}${c.ddVariance}% vs the initial offer. ` : ""}${c.feesVsBudget != null ? `Fees: ${c.feesVsBudget}% of budget. ` : ""}${c.contactToClose != null ? `${c.contactToClose} days from first contact to close.` : ""}</p>
    <ul class="muted small">${CONTRACT_CLOSE.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></section>
    ${listPane(P, "close")}`;
}

function planPane(P) {
  return `${P.R.room.settled_at ? "" : '<p class="muted">Dates fill in when you record the settlement date (Close tab): Day 30, 60 and 100.</p>'}${listPane(P, "plan")}
    <details class="panel guide"><summary class="h3">Critical success factors</summary><ul>${PLAN_PRINCIPLES.map((x) => `<li>${esc(x)}</li>`).join("")}</ul><p class="muted small">${esc(JL_SOURCE)}</p></details>`;
}

// ------------------------------------------------------------------ lenders for this deal (C2 meets C3)
async function lendersPanel(P) {
  const el = $("#lenders");
  try {
    const L = await api(`/api/targets/${P.id}/lenders`);
    const n = L.need, stageOpts = (cur) => FINANCING_STAGES.map(([k, l]) => `<option value="${k}" ${cur === k ? "selected" : ""}>${l}</option>`).join("");
    el.innerHTML = `<div class="panel-head"><h2 class="h3">Financing approval: lenders that fit</h2><a class="small" href="#/capital?tab=lender">Lender matrix →</a></div>
      <p class="small">${n.hypothetical ? `The structure has no bank debt, so fit is against the whole price (${money(n.price, n.cur)}) as a hypothetical.` : `The deal needs ${money(n.amount, n.cur)} of commercial debt; weakest-year DSCR ${n.minDscr ? n.minDscr.toFixed(2) + "x" : "n/a"}.`}</p>
      ${L.lenders.length ? `<table class="mini-table"><thead><tr><th>Lender</th><th>Fit</th><th>Checks</th><th>Stage</th></tr></thead><tbody>${L.lenders.map((l) => `<tr><td><b>${esc(l.firm || l.name)}</b><br><small class="muted">${esc(l.firm ? l.name : "")} · ${esc(l.status)}</small></td>
        <td><span class="status-chip ${l.fit === "good" ? "good" : l.fit === "no" ? "bad" : ""}">${l.fit}</span></td>
        <td class="small">${l.checks.map((c) => `<div>${c.ok === true ? "✓" : c.ok === false ? "✗" : "?"} ${esc(c.label)}: <span class="muted">${esc(c.detail)}</span></div>`).join("")}${l.timing_days ? `<div class="muted">~${l.timing_days} days to funding</div>` : ""}</td>
        <td><select data-fin="${l.id}"><option value="">Not sent</option>${stageOpts(l.financing?.stage)}</select></td></tr>`).join("")}</tbody></table>` : '<p class="muted">No lenders in the matrix yet. “Build matrix of 20-50 lenders before sourcing first deal.”</p>'}
      <details class="guide"><summary class="small">${esc(UNSECURED_CONVERSION.title)}: if they want security</summary><ol class="small">${UNSECURED_CONVERSION.fallbacks.map((x) => `<li>${esc(x)}</li>`).join("")}</ol></details>`;
    $$("[data-fin]", el).forEach((s) => s.addEventListener("change", async () => {
      if (!s.value) return;
      try { await post(`/api/targets/${P.id}/financing`, { relationship_id: +s.dataset.fin, stage: s.value }); toast("Financing updated"); } catch (e) { fail(e); }
    }));
  } catch (e) { el.innerHTML = `<p class="tone-bad small">${esc(e.message)}</p>`; }
}

// ------------------------------------------------------------------ wiring
function wireMilestones(P) {
  $$("form[data-ms]").forEach((f) => f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(f).entries());
    try { await post(`/api/targets/${P.id}/room`, data, "PATCH"); toast("Saved"); P.reload(); } catch (err) { fail(err); }
  }));
  $("#draftLoi")?.addEventListener("click", async (e) => {
    e.target.disabled = true; e.target.textContent = "Writing…";
    try { const d = await post("/api/documents/generate", { kind: "loi", target_id: P.id }); location.hash = `#/desk/${d.id}`; } catch (err) { fail(err); e.target.disabled = false; }
  });
  $("#chase")?.addEventListener("click", async () => {
    try { const r = await post(`/api/targets/${P.id}/room/chase`, {}); toast(r.queued ? "Chase email drafted: approve it in the Inbox" : "Already drafted today: it's in the Inbox"); } catch (e) { fail(e); }
  });
  $("#flag")?.addEventListener("click", async () => {
    const f = await dialog({ title: "Log a red flag", html: `<p class="muted small">From the skill's Red Flag Decision Matrix; the severity and action come with it.</p>
      <label>Red flag<select name="title">${P.R.redFlagMatrix.map((x) => `<option value="${esc(x.flag)}">${esc(x.flag)} · ${x.severity.toUpperCase()} · ${esc(x.action)}</option>`).join("")}<option value="">Something else…</option></select></label>
      <label>Or describe it<input name="custom" maxlength="300"></label><label>Severity (if something else)<select name="severity"><option value="high">High</option><option value="medium" selected>Medium</option><option value="low">Low</option></select></label>
      <label>Notes<textarea name="notes" rows="3"></textarea></label>`, submit: "Log it" });
    if (!f) return;
    const title = f.custom?.trim() || f.title;
    if (!title) return;
    try { await post(`/api/targets/${P.id}/room/items`, { list: "dd", title, notes: f.notes, ...(f.custom?.trim() ? { status: "issue", severity: f.severity, section: "Red flags" } : {}) }); P.reload(); } catch (e) { fail(e); }
  });
}

function wireItems(P) {
  const all = Object.values(P.R.lists).flat();
  $$("[data-istatus]").forEach((s) => s.addEventListener("change", async () => {
    try { await post(`/api/room/items/${s.dataset.istatus}`, { status: s.value }, "PATCH"); s.closest(".ritem").className = `ritem s-${s.value}`; } catch (e) { fail(e); }
  }));
  $$("[data-iadd]").forEach((b) => b.addEventListener("click", async () => {
    const f = await dialog({ title: "Add a line", html: `${field("title", "What's needed", "", "text", "required maxlength=300")}${field("section", "Section", "")}${field("due_date", "Due", "", "date")}${b.dataset.iadd === "gate" ? `<label class="check"><input type="checkbox" name="seller" checked> The seller sees it on their link</label><label class="check"><input type="checkbox" name="upload" checked> They can upload to it</label>` : ""}` });
    if (!f) return;
    try { await post(`/api/targets/${P.id}/room/items`, { list: b.dataset.iadd, ...f }); P.reload(); } catch (e) { fail(e); }
  }));
  $$("[data-iedit]").forEach((b) => b.addEventListener("click", async () => {
    const i = all.find((x) => x.id === +b.dataset.iedit);
    const f = await dialog({ title: "Edit", html: `${field("title", "What's needed", i.title, "text", "required maxlength=300")}
      <div class="two">${field("owner", "Who", i.owner)}${field("due_date", "Due", i.due_date, "date")}</div>
      <label>Severity<select name="severity"><option value="">—</option>${Object.keys(SEV).map((k) => `<option value="${k}" ${i.severity === k ? "selected" : ""}>${k}</option>`).join("")}</select></label>
      ${field("action", "Action", i.action || "")}
      <label>Notes<textarea name="notes" rows="3" maxlength="4000">${esc(i.notes || "")}</textarea></label>
      <label class="check"><input type="checkbox" name="seller" ${i.seller ? "checked" : ""}> The seller sees it on their link</label><label class="check"><input type="checkbox" name="upload" ${i.upload ? "checked" : ""}> They can upload to it</label>
      <p><button class="link danger" type="button" id="idel">Delete this line</button></p>`, onOpen: (d, done) => $("#idel", d).addEventListener("click", async () => { done(null); if (await confirmBox("Delete this line?", i.title)) { await post(`/api/room/items/${i.id}`, {}, "DELETE").catch(fail); P.reload(); } }) });
    if (!f) return;
    try { await post(`/api/room/items/${i.id}`, f, "PATCH"); P.reload(); } catch (e) { fail(e); }
  }));
}

async function uploadDialog(P) {
  const all = Object.values(P.R.lists).flat().filter((i) => i.status !== "na");
  const f = await dialog({ title: "Upload a file", submit: "Upload", html: `<label>File<input type="file" name="file" required accept=".pdf,.xlsx,.xls,.csv,.docx,.doc,.png,.jpg,.jpeg,.txt"></label>
    <label>For<select name="item"><option value="">General</option>${all.map((i) => `<option value="${i.id}">${esc(i.title.slice(0, 70))}</option>`).join("")}</select></label><p class="muted small">PDF, Excel, CSV, Word, text or images, up to 20 MB. Attach your NDA to the NDA line and the seller can download it from their link.</p>` });
  if (!f || !(f.file instanceof File) || !f.file.size) return;
  const fd = new FormData(); fd.append("file", f.file); if (f.item) fd.append("item", f.item);
  try {
    const res = await fetch(`/api/targets/${P.id}/room/files`, { method: "POST", body: fd });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Upload failed (${res.status})`);
    toast("Uploaded"); P.reload();
  } catch (e) { fail(e); }
}

async function linkDialog(P) {
  const r = P.R.room;
  const go = await dialog({ title: "Seller link", submit: r.link_on ? "Make a new link" : "Make the link", html: `<p>The owner opens it on any device, accepts the NDA by typing their name, and uploads what the qualification gate asks for. They see only the lines marked "seller", never your notes.</p>
    ${r.link_on ? `<p class="muted small">A link is on (ends …${esc(r.token_hint)}). For security Warplan only shows a link once; making a new one turns the old one off.</p><p><button class="link danger" type="button" id="revoke">Turn the link off</button></p>` : ""}`,
    onOpen: (d, done) => $("#revoke", d)?.addEventListener("click", async () => { done(null); await post(`/api/targets/${P.id}/room/link`, {}, "DELETE").catch(fail); toast("Link turned off"); P.reload(); }) });
  if (!go) return;
  try {
    const l = await post(`/api/targets/${P.id}/room/link`, {});
    await dialog({ title: "Send this to the owner", submit: "Copy link", html: `<p><input readonly value="${esc(l.url)}" aria-label="Seller link"></p><p class="muted small">${esc(l.note)}</p>` }) && copy(l.url, "Link copied");
    P.reload();
  } catch (e) { fail(e); }
}
