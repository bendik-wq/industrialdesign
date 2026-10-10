import { $, $$, esc, api, post, view, stale, toast, fail, dialog, skeleton, when, copy } from "../core.js";

// Data marketplace (Monid): search 2,500+ data and scraping APIs, see the price, fill the inputs, run, read the result.
// The same catalogue is open to Josh and to any MCP client through the monid_* tools.
const RECIPES = [
  ["Google reviews for a business", "google maps reviews for a place"],
  ["Who's hiring (growth signal)", "company job postings"],
  ["People at a company on LinkedIn", "linkedin company employees search"],
  ["Owner's personal email", "find personal email of a person"],
  ["Check phone numbers are real", "phone number validation carrier lookup"],
  ["Company financials & firmographics", "company enrichment revenue employees"],
  ["Scrape any website", "scrape website content markdown"],
  ["Local businesses on Yelp", "yelp business search"],
];

export async function renderData(seq) {
  view().innerHTML = skeleton(4);
  const m = await api("/api/monid");
  if (stale(seq)) return;
  if (!m.connected) {
    view().innerHTML = `<header class="page-head"><p class="eyebrow">Data</p><h1>2,500 data sources. One key.</h1>
      <p class="lede">Connect Monid to search Google Maps anywhere in Scout, deep-enrich owners (verified email, LinkedIn, mobile), and let Josh pull any data he needs: reviews, job posts, LinkedIn, company financials, web pages. One prepaid wallet, a monthly cap you set.</p></header>
      <div class="panel"><a class="primary" href="#/settings/integrations">Connect Monid →</a> <span class="muted small">Get a key at monid.ai.</span></div>`;
    return;
  }
  const b = m.budget, pct = b.monthly_usd ? Math.min(100, (b.spent_usd / b.monthly_usd) * 100) : 100;
  view().innerHTML = `
    <header class="page-head"><p class="eyebrow">Data</p><h1>2,500 data sources. One key.</h1>
      <p class="lede">Describe the data you want. Pick an endpoint, see its price, run it. Josh and your MCP clients can use the same catalogue on their own, inside the budget below.</p></header>
    <div class="metric-strip">
      <div><span>Wallet</span><b>${m.balance_usd != null ? `$${(+m.balance_usd).toFixed(2)}` : "–"}</b><small><a href="https://app.monid.ai/wallet" target="_blank" rel="noopener noreferrer">top up</a></small></div>
      <div><span>Spent this month</span><b>$${b.spent_usd.toFixed(2)}</b><small>${b.runs} run${b.runs === 1 ? "" : "s"}</small></div>
      <div><span>Monthly cap</span><b>$${b.monthly_usd}</b><small><span class="bar"><i style="width:${pct}%"></i></span></small></div>
      <div><span>Auto-approve up to</span><b>$${b.approve_over_usd}</b><small>per agent run${m.canEdit ? ` · <button class="link" id="editBudget" type="button">change</button>` : ""}</small></div>
    </div>
    <form class="panel row" id="dsf"><input name="q" id="dq" placeholder="e.g. reviews for a dental clinic, LinkedIn profile of an owner, company revenue" aria-label="Describe the data"><button class="primary" type="submit">Search</button></form>
    <div class="chips" id="recipes">${RECIPES.map(([l, q]) => `<button type="button" class="chip-btn" data-q="${esc(q)}">${esc(l)}</button>`).join("")}</div>
    <div id="found"></div>
    <div id="runner"></div>
    <section class="panel"><div class="panel-head"><h2 class="h3">Background jobs</h2><button class="ghost small" id="jobsCheck" type="button">Check now</button></div><div id="jobs"><p class="muted small">Meeting notetakers show here while they run.</p></div></section>
    <section class="panel"><h2 class="h3">Spend log</h2>${runsTable(m.runs)}</section>`;
  const drawJobs = async () => { try { const j = await api("/api/jobs"); if (j.jobs.length) $("#jobs").innerHTML = `<ul class="link-list">${j.jobs.map((x) => `<li><span>● Meeting notetaker${x.target_name ? ` · <a href="#/targets/${x.target_id}">${esc(x.target_name)}</a>` : ""}<small class="muted block">${esc(x.result?.summary || x.result?.note || x.result?.error || x.meta?.url || "")}</small></span><small class="${x.status === "failed" ? "tone-bad" : x.status === "done" ? "tone-ok" : ""}">${esc(x.status)} · ${when(x.created_at)}</small></li>`).join("")}</ul>`; } catch { /* quiet */ } };
  drawJobs();
  $("#jobsCheck").addEventListener("click", async () => { try { const r = await post("/api/jobs/check"); toast(`${r.finished} finished`); drawJobs(); } catch (e) { fail(e); } });

  $("#editBudget")?.addEventListener("click", async () => {
    const r = await dialog({ title: "Data budget", html: `<label class="field">Monthly cap (USD)<input name="monthly_usd" type="number" min="0" step="1" value="${b.monthly_usd}"></label><label class="field">Agents may spend up to this per run without asking (USD)<input name="approve_over_usd" type="number" min="0" step="0.05" value="${b.approve_over_usd}"></label><p class="muted small">Runs stop at the cap. Agent runs above the per-run limit, or with a price that can't be known up front, wait for approval in the Inbox.</p>` });
    if (!r) return;
    try { await post("/api/monid/budget", r, "PUT"); toast("Budget saved"); renderData(seq); } catch (e) { fail(e); }
  });
  const search = async (q) => {
    $("#found").innerHTML = skeleton(3); $("#runner").innerHTML = "";
    try {
      const r = await post("/api/monid/discover", { query: q, limit: 10 });
      $("#found").innerHTML = r.endpoints.length ? `<div class="panel flush"><table class="ttable"><thead><tr><th>Endpoint</th><th>What it gives</th><th>Price</th><th></th></tr></thead><tbody>${r.endpoints.map((e, i) => `<tr><td><b>${esc(e.name)}</b><small class="muted block mono">${esc(e.endpoint)}</small></td><td class="small">${esc(e.description)}</td><td class="small nowrap">${esc(e.price)}</td><td><button class="ghost" type="button" data-use="${i}">Use</button></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty"><p class="muted">Nothing matched. Try other words.</p></div>`;
      $$("[data-use]").forEach((btn) => btn.addEventListener("click", () => openRunner(r.endpoints[+btn.dataset.use])));
    } catch (e) { fail(e); $("#found").innerHTML = ""; }
  };
  $("#dsf").addEventListener("submit", (e) => { e.preventDefault(); const q = $("#dq").value.trim(); if (q) search(q); });
  $$("[data-q]").forEach((b2) => b2.addEventListener("click", () => { $("#dq").value = b2.dataset.q; search(b2.dataset.q); }));
}

async function openRunner(ep) {
  $("#runner").innerHTML = skeleton(3);
  let d;
  try { d = await post("/api/monid/inspect", { provider: ep.provider, endpoint: ep.endpoint }); } catch (e) { fail(e); $("#runner").innerHTML = ""; return; }
  const groups = ["pathParams", "queryParams", "body"].filter((g) => d.input?.[g]?.properties && Object.keys(d.input[g].properties).length);
  $("#runner").innerHTML = `<form class="panel" id="runForm">
    <h2 class="h3">${esc(d.provider)} <span class="mono muted">${esc(d.endpoint)}</span></h2>
    <p class="small">${esc(d.description || "")}</p>
    <p class="small"><b>${esc(d.price)}</b>${d.typical_seconds ? ` · usually ${d.typical_seconds}s` : ""}${(d.price_raw?.notes || []).length ? ` · <span class="muted">${esc(d.price_raw.notes.join(" "))}</span>` : ""}</p>
    ${groups.map((g) => `<fieldset class="form-grid"><legend class="muted small">${g === "body" ? "Input" : g === "queryParams" ? "Query" : "Path"}</legend>${Object.entries(d.input[g].properties).slice(0, 30).map(([k, s]) => field(g, k, s, (d.input[g].required || []).includes(k))).join("")}</fieldset>`).join("") || `<p class="muted">No inputs.</p>`}
    <div class="row"><button class="primary" type="submit">Run</button><span class="muted small">Charged to your Monid wallet and logged below.</span></div>
    <div id="out"></div></form>`;
  $("#runForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = {};
    for (const el of $$("[data-g]", e.target)) {
      const g = el.dataset.g, k = el.dataset.k, t = el.dataset.t;
      let v = el.type === "checkbox" ? el.checked : el.value.trim();
      if (el.type !== "checkbox" && v === "") continue;
      if (el.type === "checkbox" && !v && !el.dataset.touched) continue;
      if (t === "integer" || t === "number") v = Number(v);
      if (t === "array" || t === "object") { try { v = JSON.parse(v); } catch { if (t === "array") v = String(v).split(",").map((x) => x.trim()).filter(Boolean); else { toast(`${k} must be JSON`, "error"); return; } } }
      (input[g] ||= {})[k] = v;
    }
    const btn = $("button[type=submit]", e.target); btn.disabled = true; btn.textContent = "Running…";
    $("#out").innerHTML = skeleton(2);
    try {
      const r = await post("/api/monid/run", { provider: d.provider, endpoint: d.endpoint, input, reason: "Data console" });
      $("#out").innerHTML = `<p class="small">${esc(r.status)} · cost $${(+r.cost_usd).toFixed(4)}${r.status === "RUNNING" ? ` · still running, run id <span class="mono">${esc(r.run_id)}</span>` : ""} · <button type="button" class="link" id="copyOut">Copy JSON</button></p><pre class="json">${esc(JSON.stringify(r.output, null, 2)).slice(0, 60000)}</pre>`;
      $("#copyOut").addEventListener("click", () => copy(JSON.stringify(r.output, null, 2)));
    } catch (err) { fail(err); $("#out").innerHTML = ""; }
    btn.disabled = false; btn.textContent = "Run";
  });
  $$("input[type=checkbox][data-g]").forEach((c) => c.addEventListener("change", () => { c.dataset.touched = "1"; }));
  $("#runner").scrollIntoView({ behavior: "smooth", block: "start" });
}

function field(g, k, s, req) {
  const t = Array.isArray(s.type) ? s.type.find((x) => x !== "null") : s.type || (s.enum ? "string" : "string");
  const label = `${esc(s.title || k)}${req ? " *" : ""}`;
  const help = s.description ? `<small class="muted">${esc(String(s.description).slice(0, 160))}</small>` : "";
  const attrs = `data-g="${g}" data-k="${esc(k)}" data-t="${t}" ${req ? "required" : ""}`;
  const def = s.default ?? s.prefill ?? s.example ?? "";
  if (s.enum) return `<label class="field">${label}<select ${attrs}>${req ? "" : '<option value="">–</option>'}${s.enum.map((v) => `<option ${String(v) === String(def) ? "selected" : ""}>${esc(v)}</option>`).join("")}</select>${help}</label>`;
  if (t === "boolean") return `<label class="check"><input type="checkbox" ${attrs} ${def === true ? "checked" : ""}> ${label}</label>`;
  if (t === "array" || t === "object") return `<label class="field">${label}<textarea rows="2" ${attrs} placeholder='${t === "array" ? "comma, separated or JSON" : "{ }"}'>${def !== "" ? esc(typeof def === "string" ? def : JSON.stringify(def)) : ""}</textarea>${help}</label>`;
  return `<label class="field">${label}<input ${attrs} type="${t === "integer" || t === "number" ? "number" : "text"}" ${t === "number" ? 'step="any"' : ""} value="${esc(def)}">${help}</label>`;
}

const runsTable = (runs) => (runs.length ? `<div class="table-wrap"><table class="mini-table"><thead><tr><th>When</th><th>Endpoint</th><th>For</th><th class="num">Cost</th><th>Status</th></tr></thead><tbody>${runs.map((r) => `<tr><td class="nowrap">${when(r.created_at)}</td><td class="mono small">${esc(r.provider)} ${esc(r.endpoint)}</td><td class="small">${r.target_id ? `<a href="#/targets/${r.target_id}">${esc(r.target_name || "target")}</a> · ` : ""}${esc(r.purpose)}</td><td class="num">$${(+r.cost).toFixed(4)}</td><td class="small">${esc(r.status.toLowerCase())}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">No runs yet.</p>`);
