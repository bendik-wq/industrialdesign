import { recommend, structure, STRUCTURES, money as dmoney } from "/deal.js";
import { letterText } from "/letters.js";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n) => Number(n || 0).toLocaleString();
const YEAR = new Date().getFullYear();
const VERDICTS = ["Strong target", "Worth a call", "Watch list", "Long shot"];
const VCLASS = { "Strong target": "v-strong", "Worth a call": "v-call", "Watch list": "v-watch", "Long shot": "v-long" };

let sources = null;
let pollTimer = null;
let routeSeq = 0; // a slower, older view must not overwrite the one the user just navigated to
const stale = (seq) => seq !== routeSeq;
const listState = { page: 1, verdict: "", q: "", minOwnerAge: "", minStaff: "", ownerKnown: false, sort: "fit", status: "" };

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } });
  if (res.status === 401) { location.href = "/login"; throw new Error("signed out"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const settings = () => { try { return JSON.parse(localStorage.getItem("dealflow.settings") || "{}"); } catch { return {}; } };
const money = (v, cur) => (v ? `${{ EUR: "€", GBP: "£", USD: "$", NOK: "NOK " }[cur] ?? ""}${v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : Math.round(v / 1e3) + "k"}` : "–");
const country = (id) => sources?.countries.find((c) => c.id === id);

// ================================================================== sidebar
async function renderSearches(activeId) {
  const list = await api("/api/searches");
  $("#searches").innerHTML = list.length ? list.map((s) => {
    const pct = s.pages ? Math.round((100 * s.pages_done) / s.pages) : 0;
    const st = s.status === "done" ? `${fmt(s.found)} found · ${fmt(s.strong)} worth a call`
      : s.status === "failed" ? "Failed" : s.status === "queued" ? "Starting…" : `Searching… ${pct}%`;
    return `<a class="search-item ${s.id == activeId ? "active" : ""} ${s.status}" href="#/search/${s.id}">
      <span class="flag">${country(s.country)?.flag || (s.label === "Inbound sellers" ? "📥" : "✚")}</span>
      <span><b>${esc(s.label)}</b><small>${esc(st)}</small></span></a>`;
  }).join("") : `<p class="muted small">No searches yet.</p>`;
  return list;
}

// ================================================================== router
async function router() {
  const seq = ++routeSeq;
  clearInterval(pollTimer);
  closeDrawer();
  $("#side").classList.remove("open");
  const [, view, id] = location.hash.split("/");
  $$(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.nav === view));
  if (view === "new") return renderNew();
  if (view === "pipeline") return renderPipeline(seq);
  if (view === "search" && id) return renderResults(Number(id), seq);
  const searches = await renderSearches();
  if (stale(seq)) return;
  if (!searches.length && view !== "all") { location.hash = "#/new"; return; }
  return renderResults(null, seq);
}

// ================================================================== new search
function renderNew() {
  renderSearches();
  const st = { country: "fr", industry: "hvac", region: "", minStaff: 1 };
  const draw = () => {
    const c = country(st.country);
    const inds = sources.industries.filter((i) => i.countries.includes(st.country));
    if (!inds.find((i) => i.id === st.industry)) st.industry = inds[0]?.id;
    $("#view").innerHTML = `
      <header class="page-head"><div><h1>New search</h1><p class="muted">Pick a country, an industry and an area. We pull every matching company from the official registry, then score each one on how likely the owner is to sell and how big the business is.</p></div></header>
      <section class="step"><h3><span>1</span> Country</h3>
        <div class="countries">${sources.countries.map((x) => `
          <button type="button" class="country ${x.id === st.country ? "on" : ""}" data-c="${x.id}">
            <span class="flag big">${x.flag}</span><b>${esc(x.label)}</b>
            <ul>${x.publishes.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>
            ${x.ready ? `<span class="badge ok">Ready</span>` : `<span class="badge warn" title="${esc(x.keyHelp)}">Needs ${esc(x.needsKey)}</span>`}
          </button>`).join("")}
        </div>
        ${c.ready ? "" : `<p class="notice">To search ${esc(c.label)}, add the secret <code>${esc(c.needsKey)}</code> to the Worker. ${esc(c.keyHelp)}.</p>`}
      </section>
      <section class="step"><h3><span>2</span> Industry</h3>
        <select id="industry">${inds.map((i) => `<option value="${i.id}" ${i.id === st.industry ? "selected" : ""}>${esc(i.label)}</option>`).join("")}</select>
      </section>
      <section class="step"><h3><span>3</span> ${esc(c.regionLabel)}</h3>
        ${Array.isArray(c.regions)
          ? `<select id="region"><option value="">All of ${esc(c.label)}</option>${c.regions.map((r) => `<option value="${esc(r.code)}" ${r.code === st.region ? "selected" : ""}>${esc(r.name)}</option>`).join("")}</select>`
          : `<input id="region" placeholder="${st.country === "us" ? "e.g. Austin, TX" : "e.g. Manchester"}" value="${esc(st.region)}">`}
      </section>
      <section class="step"><h3><span>4</span> Minimum staff</h3>
        <div class="seg" id="staff">${[0, 1, 6, 10, 20, 50].map((n) => `<button type="button" data-n="${n}" class="${n === st.minStaff ? "on" : ""}">${n ? `${n}+` : "Any"}</button>`).join("")}</div>
        <p class="muted small">Companies with no employees are usually one-person shops with nothing to buy but the owner. ${st.country === "us" ? "Google doesn't publish headcount, so this filter doesn't apply to US searches." : ""}</p>
      </section>
      <div class="go"><button class="primary big" id="go" type="button" ${c.ready ? "" : "disabled"}>Find companies</button><span class="error" id="goErr"></span></div>
      <section class="how">
        <h3>How companies are scored</h3>
        <div class="how-grid">
          <div><b>Succession (55%)</b><p>Owner's age from the registry (60+ scores high), company age, a single person running it, the owner's name on the door. Points come off when a younger family member is already in management.</p></div>
          <div><b>Size (45%)</b><p>Registered headcount, number of sites, published revenue, Google review volume. Companies with 250+ staff are flagged as too big for most buyers.</p></div>
          <div><b>Verdict</b><p><span class="pill v-strong">Strong target</span> 65+ · <span class="pill v-call">Worth a call</span> 50+ · <span class="pill v-watch">Watch list</span> 35+ · <span class="pill v-long">Long shot</span></p></div>
        </div>
      </section>`;
    $$(".country").forEach((b) => b.addEventListener("click", () => { st.country = b.dataset.c; st.region = ""; draw(); }));
    $("#industry").addEventListener("change", (e) => (st.industry = e.target.value));
    $("#region").addEventListener("input", (e) => (st.region = e.target.value));
    $("#region").addEventListener("change", (e) => (st.region = e.target.value));
    $$("#staff button").forEach((b) => b.addEventListener("click", () => { st.minStaff = +b.dataset.n; $$("#staff button").forEach((x) => x.classList.toggle("on", x === b)); }));
    $("#go").addEventListener("click", async () => {
      $("#go").disabled = true; $("#goErr").textContent = "";
      try {
        const s = await api("/api/searches", { method: "POST", body: JSON.stringify(st) });
        location.hash = `#/search/${s.id}`;
      } catch (e) { $("#goErr").textContent = e.message; $("#go").disabled = false; }
    });
  };
  draw();
}

// ================================================================== results
async function renderResults(searchId, seq) {
  const searches = await renderSearches(searchId);
  if (stale(seq)) return;
  const s = searchId ? searches.find((x) => x.id === searchId) : null;
  if (searchId && !s) { location.hash = "#/all"; return; }
  Object.assign(listState, { page: 1 });
  $("#view").innerHTML = `
    <header class="page-head">
      <div>
        <h1>${s ? `${country(s.country)?.flag || ""} ${esc(s.label)}` : "All targets"}</h1>
        <p class="muted" id="sub"></p>
      </div>
      <div class="head-actions">
        ${s ? `<button class="ghost" id="del" type="button">Delete search</button>` : ""}
        <div class="menu"><button class="primary" id="exportBtn" type="button">Export ▾</button>
          <div class="menu-pop" id="exportMenu" hidden>
            <a data-f="full">Spreadsheet (all fields)</a>
            <a data-f="mail">Mailing list (owner + address)</a>
            <a data-f="email">Email leads (rows with an email)</a>
            <a data-print="1">Print letters for top 50 ↗</a>
          </div></div>
      </div>
    </header>
    <div class="progress" id="progress" hidden><div class="bar"><div id="bar"></div></div><span id="progressText"></span></div>
    <div class="verdicts" id="verdicts"></div>
    <section class="filters">
      <input id="q" type="search" placeholder="Search name, town, owner, postcode…" value="${esc(listState.q)}">
      <label>Owner age <select id="minOwnerAge"><option value="">Any</option><option value="55">55+</option><option value="60">60+</option><option value="65">65+</option></select></label>
      <label>Staff <select id="minStaff"><option value="">Any</option><option value="1">1+</option><option value="10">10+</option><option value="20">20+</option><option value="50">50+</option></select></label>
      <label class="check"><input id="ownerKnown" type="checkbox"> Owner age known</label>
      <label>Status <select id="status"><option value="">Any</option><option>Any pipeline</option>${sources.statuses.map((x) => `<option>${x}</option>`).join("")}</select></label>
      <span class="spacer"></span>
      <label>Sort <select id="sort">
        <option value="fit">Best fit</option><option value="succession">Most likely to sell</option><option value="size">Biggest</option>
        <option value="owner_age">Oldest owner</option><option value="founded">Oldest company</option><option value="staff">Most staff</option><option value="value">Highest value</option><option value="name">Name</option>
      </select></label>
    </section>
    <section class="table-card">
      <div class="table-wrap"><table>
        <thead><tr><th>Company</th><th>Owner</th><th class="num">Founded</th><th class="num">Staff</th><th class="num">Revenue</th><th class="num" title="Indicative equity value, midpoint">Value</th><th>Verdict</th><th>Status</th></tr></thead>
        <tbody id="rows"></tbody>
      </table></div>
      <nav class="pager"><button id="prev" type="button">← Prev</button><span id="pageInfo"></span><button id="next" type="button">Next →</button></nav>
    </section>`;
  for (const k of ["minOwnerAge", "minStaff", "sort", "status"]) $(`#${k}`).value = listState[k] === "Any" ? "Any pipeline" : listState[k];
  $("#ownerKnown").checked = listState.ownerKnown;

  const qs = () => {
    const p = new URLSearchParams();
    if (searchId) p.set("search", searchId);
    for (const k of ["q", "minOwnerAge", "minStaff", "sort", "verdict", "status"]) if (listState[k]) p.set(k, listState[k]);
    if (listState.ownerKnown) p.set("ownerKnown", "1");
    return p;
  };
  const load = async () => {
    const p = qs(); p.set("page", listState.page); p.set("limit", 50);
    const [data, st] = await Promise.all([api(`/api/companies?${p}`), api(`/api/stats${searchId ? `?search=${searchId}` : ""}`)]);
    const by = Object.fromEntries(st.map((x) => [x.verdict, x]));
    const total = st.reduce((n, x) => n + x.n, 0);
    $("#verdicts").innerHTML = `<button type="button" class="vchip ${!listState.verdict ? "on" : ""}" data-v=""><b>${fmt(total)}</b> All</button>` +
      VERDICTS.map((v) => `<button type="button" class="vchip ${VCLASS[v]} ${listState.verdict === v ? "on" : ""}" data-v="${v}"><b>${fmt(by[v]?.n || 0)}</b> ${v}</button>`).join("");
    $$(".vchip").forEach((b) => b.addEventListener("click", () => { listState.verdict = b.dataset.v; listState.page = 1; load(); }));
    $("#rows").innerHTML = data.rows.map((r) => `
      <tr data-id="${r.id}">
        <td class="co"><b>${esc(r.name)}${r.inbound ? ' <span class="pill inbound">Inbound</span>' : ""}</b><small>${esc([r.city, r.legal_form].filter(Boolean).join(" · "))}${searchId ? "" : ` · ${country(r.country)?.flag || ""}`}</small></td>
        <td>${r.owner_name ? `${esc(r.owner_name)}${r.owner_age != null ? ` <span class="age ${r.owner_age >= 60 ? "old" : ""}">${r.owner_age}</span>` : ""}` : '<span class="muted">Not published</span>'}</td>
        <td class="num">${r.founded ?? "–"}</td>
        <td class="num">${esc(r.employees_band ?? (r.reviews != null ? `${fmt(r.reviews)} reviews` : "–"))}</td>
        <td class="num">${money(r.revenue, r.currency)}</td>
        <td class="num strong-num">${r.valuation_mid ? dmoney(r.valuation_mid, r.currency) : "–"}</td>
        <td><span class="pill ${VCLASS[r.verdict]}">${esc(r.verdict)}</span> <span class="fit">${r.fit_score}</span></td>
        <td class="status ${r.status !== "New" ? "active" : ""}">${esc(r.status)}</td>
      </tr>`).join("") || `<tr><td colspan="8" class="empty">${s && s.status !== "done" && s.status !== "failed" ? "Companies will appear here as the search runs…" : "No companies match these filters."}</td></tr>`;
    const pages = Math.max(1, Math.ceil(data.total / 50));
    $("#pageInfo").textContent = `${fmt(data.total)} companies · page ${listState.page} of ${fmt(pages)}`;
    $("#prev").disabled = listState.page <= 1;
    $("#next").disabled = listState.page >= pages;
  };
  const updateProgress = async () => {
    if (!s) { $("#sub").textContent = "Every company from every search, best fit first."; return; }
    const cur = await api(`/api/searches/${searchId}`);
    const c = country(cur.country);
    $("#sub").textContent = `Source: ${c?.label || "registry lookups"} official data${cur.total != null ? ` · ${fmt(cur.total)} registered matches` : ""} · searched ${new Date(cur.created_at).toLocaleDateString()}`;
    if (cur.status === "done" && cur.error) {
      $("#progress").hidden = false;
      $("#progressText").innerHTML = `⚠ ${esc(cur.error)} <button class="ghost" id="retry" type="button">Run again</button>`;
      $("#bar").style.width = "100%";
      $("#retry").onclick = async () => { await api(`/api/searches/${searchId}/retry`, { method: "POST" }); router(); };
      return false;
    }
    const running = cur.status === "running" || cur.status === "queued";
    $("#progress").hidden = !running && cur.status !== "failed";
    if (cur.status === "failed") {
      $("#progressText").innerHTML = `Stopped after ${fmt(cur.found)} companies: ${esc(cur.error || "unknown error")} <button class="ghost" id="retry" type="button">Run again</button>`;
      $("#bar").style.width = `${cur.pages ? Math.round((100 * cur.pages_done) / cur.pages) : 0}%`;
      $("#retry").onclick = async () => { await api(`/api/searches/${searchId}/retry`, { method: "POST" }); router(); };
    }
    if (running) {
      const pct = cur.pages ? Math.round((100 * cur.pages_done) / cur.pages) : 2;
      $("#bar").style.width = `${Math.max(2, pct)}%`;
      $("#progressText").textContent = `Pulling companies from the registry… ${fmt(cur.found)} saved so far (${pct}%)`;
    }
    return running;
  };

  let t;
  $("#q").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => { listState.q = e.target.value.trim(); listState.page = 1; load(); }, 250); });
  for (const k of ["minOwnerAge", "minStaff", "sort", "status"]) $(`#${k}`).addEventListener("change", (e) => { listState[k] = e.target.value === "Any pipeline" ? "Any" : e.target.value; listState.page = 1; load(); });
  $("#ownerKnown").addEventListener("change", (e) => { listState.ownerKnown = e.target.checked; listState.page = 1; load(); });
  $("#prev").addEventListener("click", () => { listState.page--; load(); });
  $("#next").addEventListener("click", () => { listState.page++; load(); });
  $("#rows").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-id]"); if (tr) openCompany(+tr.dataset.id); });
  $("#exportBtn").addEventListener("click", (e) => { e.stopPropagation(); $("#exportMenu").hidden = !$("#exportMenu").hidden; });
  $$("#exportMenu a").forEach((a) => a.addEventListener("click", () => {
    const p = qs();
    if (a.dataset.print) { p.set("limit", "50"); window.open(`/print.html?${p}`, "_blank"); return; }
    p.set("format", a.dataset.f); location.href = `/api/export.csv?${p}`;
  }));
  $("#del")?.addEventListener("click", async () => {
    if (!confirm("Delete this search? Pipeline notes on its companies are kept.")) return;
    await api(`/api/searches/${searchId}`, { method: "DELETE" });
    location.hash = "#/all";
  });

  await Promise.all([load(), updateProgress()]);
  if (s && (s.status === "running" || s.status === "queued")) {
    pollTimer = setInterval(async () => {
      const running = await updateProgress();
      await load();
      renderSearches(searchId);
      if (!running) clearInterval(pollTimer);
    }, 4000);
  }
}

// ================================================================== pipeline board
async function renderPipeline(seq = routeSeq) {
  renderSearches();
  const { statuses, rows } = await api("/api/pipeline");
  if (stale(seq)) return;
  const cols = statuses.filter((s) => s !== "New");
  $("#view").innerHTML = `
    <header class="page-head"><div><h1>Pipeline</h1><p class="muted">Every company you've moved past “New”. Open a card to update its stage or notes.</p></div></header>
    ${rows.length ? `<div class="board">${cols.map((c) => {
      const items = rows.filter((r) => r.status === c);
      return `<section class="col"><h4>${esc(c)} <span>${items.length}</span></h4>${items.map((r) => `
        <button type="button" class="card" data-id="${r.id}">
          <b>${country(r.country)?.flag || ""} ${esc(r.name)}</b>
          <small>${esc(r.summary || r.city || "")}</small>
          ${r.notes ? `<p>${esc(r.notes.slice(0, 120))}${r.notes.length > 120 ? "…" : ""}</p>` : ""}
          <span class="muted small">Updated ${new Date(r.updated_at).toLocaleDateString()}</span>
        </button>`).join("")}</section>`;
    }).join("")}</div>` : `<div class="empty-state"><h3>Nothing in your pipeline yet</h3><p class="muted">Open any company and set its status to “Researching” or “Contacted” to track it here.</p><a class="primary" href="#/all">Browse targets</a></div>`}`;
  $$(".card").forEach((b) => b.addEventListener("click", () => openCompany(+b.dataset.id)));
}

// ================================================================== company drawer
async function openCompany(id) {
  const c = await api(`/api/companies/${id}`);
  const cty = country(c.country);
  const q = encodeURIComponent(`${c.name} ${c.city || ""}`);
  const bar = (label, v, note) => `<div class="sbar"><div class="sbar-top"><span>${label}</span><b>${v}</b></div><div class="track"><div class="fill" style="width:${Math.max(2, v)}%"></div></div><small>${note}</small></div>`;
  $("#drawerBody").innerHTML = `
    <div class="d-head">
      <div>
        <h2>${esc(c.name)}</h2>
        <p class="muted">${cty?.flag || ""} ${esc([c.city, c.postcode].filter(Boolean).join(" "))}${c.legal_form ? ` · ${esc(c.legal_form)}` : ""}</p>
      </div>
      <button class="close" id="closeDrawer" aria-label="Close">×</button>
    </div>
    <div class="verdict-box"><span class="pill big ${VCLASS[c.verdict]}">${esc(c.verdict)}</span><p>${esc(c.summary || "Limited data published for this company.")}</p></div>
    <div class="sbars">
      ${bar("Likely to sell", c.succession_score, "Owner age, company age, key-person risk")}
      ${bar("Size", c.size_score, "Staff, sites, revenue, reviews")}
      ${bar("Overall fit", c.fit_score, "55% likely to sell + 45% size")}
    </div>

    <div class="d-sec deal" id="deal"></div>

    <div class="d-sec"><h3>AI deal brief</h3>
      <div class="ai-box" id="briefBox">${c.ai?.brief ? md(c.ai.brief.content) : `<p class="muted">A one-page read on why this could be a deal, the risks and how to open the conversation.</p>`}</div>
      <div class="draft-actions"><span class="muted small" id="briefMeta">${c.ai?.brief ? aiMeta(c.ai.brief) : ""}</span><button class="primary" id="briefBtn" type="button">${c.ai?.brief ? "Rewrite" : "Write brief"}</button></div>
    </div>

    <div class="d-sec"><h3>People on record</h3>
      ${c.people.length ? `<ul class="people">${c.people.map((p) => {
        const age = p.birthYear ? YEAR - p.birthYear - (p.birthMonth && p.birthMonth > new Date().getMonth() + 1 ? 1 : 0) : null;
        return `<li><b>${esc(p.name)}</b><span class="muted">${esc(p.role || "")}</span>${age != null ? `<span class="age ${age >= 60 ? "old" : ""}">${age}</span>` : ""}</li>`;
      }).join("")}</ul>` : `<p class="muted">The ${esc(cty?.label || "")} source doesn't publish owners for this company.</p>`}
    </div>

    <div class="d-sec"><h3>Why it scores</h3>
      <ul class="signals">${c.signals.map((s) => `<li><span class="pts ${s.pts < 0 ? "neg" : ""}">${s.pts > 0 ? "+" : ""}${s.pts || "·"}</span><div><b>${esc(s.label)}</b><small>${esc(s.detail)}</small></div></li>`).join("") || '<li><span></span><div class="muted">No strong signals published.</div></li>'}</ul>
    </div>

    <div class="d-sec"><h3>Facts</h3>
      <dl class="facts">
        <div><dt>Founded</dt><dd>${c.founded ?? "–"}</dd></div>
        <div><dt>Staff</dt><dd>${esc(c.employees_band ?? "Not published")}</dd></div>
        <div><dt>Revenue</dt><dd>${c.revenue ? `${money(c.revenue, c.currency)} (${c.revenue_year})` : "Not published"}</dd></div>
        <div><dt>Sites</dt><dd>${c.establishments ?? "–"}</dd></div>
        <div><dt>Address</dt><dd>${esc(c.address || "–")}</dd></div>
        <div><dt>Activity code</dt><dd>${esc(c.industry_code || "–")}</dd></div>
        <div><dt>Phone</dt><dd>${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : "–"}</dd></div>
        <div><dt>Website</dt><dd>${c.website ? `<a href="${esc(c.website)}" target="_blank" rel="noopener">${esc(c.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""))}</a>` : "–"}</dd></div>
      </dl>
      <div class="links">
        ${c.registry_url ? `<a href="${esc(c.registry_url)}" target="_blank" rel="noopener">Official registry ↗</a>` : ""}
        <a href="https://www.google.com/search?q=${q}" target="_blank" rel="noopener">Google ↗</a>
        <a href="https://www.google.com/maps/search/${q}" target="_blank" rel="noopener">Maps & reviews ↗</a>
        ${c.owner_name ? `<a href="https://www.linkedin.com/search/results/all/?keywords=${encodeURIComponent(`${c.owner_name} ${c.name}`)}" target="_blank" rel="noopener">Owner on LinkedIn ↗</a>` : ""}
      </div>
    </div>

    <div class="d-sec"><h3>Pipeline</h3>
      <div class="pipe">
        <select id="pStatus">${sources.statuses.map((s) => `<option ${s === c.status ? "selected" : ""}>${s}</option>`).join("")}</select>
        <textarea id="pNotes" placeholder="What did you learn? Next step and date…">${esc(c.notes)}</textarea>
        <div class="row-end"><small class="muted" id="pSaved">${c.pipeline_updated ? `Saved ${new Date(c.pipeline_updated).toLocaleString()}` : ""}</small><button class="primary" id="pSave" type="button">Save</button></div>
      </div>
    </div>

    <div class="d-sec"><h3>Reach out</h3>
      <div class="tabs">${["ai", "letter", "email", "call"].map((t, i) => `<button type="button" data-t="${t}" aria-selected="${i === 0}">${{ ai: `✦ AI letter${{ fr: " (French)", no: " (Norwegian)" }[c.country] || ""}`, letter: "Letter", email: "Email sequence", call: "Call script" }[t]}</button>`).join("")}</div>
      <div class="draft" id="draft"></div>
      <div class="draft-actions"><span id="draftNote" class="muted small"></span><button class="ghost" id="copy" type="button">Copy</button></div>
    </div>`;

  let aiLetter = c.ai?.letter || null;
  const show = (t) => {
    $$(".tabs button").forEach((b) => b.setAttribute("aria-selected", b.dataset.t === t));
    if (t === "ai") {
      $("#draft").textContent = aiLetter ? aiLetter.content : "Writes a personal letter in the owner's own language using the facts on record and your Outreach settings.";
      $("#draftNote").innerHTML = `${aiLetter ? `${esc(aiMeta(aiLetter))} · ` : ""}<button class="link strong" id="aiLetterBtn" type="button">${aiLetter ? "Rewrite" : "Write it"}</button>`;
      $("#aiLetterBtn").addEventListener("click", async () => {
        $("#draftNote").textContent = "Writing…";
        try {
          aiLetter = await api(`/api/companies/${c.id}/ai`, { method: "POST", body: JSON.stringify({ kind: "letter", regenerate: true, me: settings() }) });
        } catch (e) { $("#draftNote").textContent = e.message; return; }
        show("ai");
      });
      return;
    }
    const d = drafts(c, settings())[t];
    $("#draft").textContent = d.text;
    $("#draftNote").textContent = d.note;
  };
  $$(".tabs button").forEach((b) => b.addEventListener("click", () => show(b.dataset.t)));
  show("ai");
  $("#briefBtn").addEventListener("click", async () => {
    $("#briefBtn").disabled = true; $("#briefBtn").textContent = "Writing…";
    $("#briefBox").innerHTML = `<div class="skeleton"></div><div class="skeleton short"></div><div class="skeleton"></div>`;
    try {
      const b = await api(`/api/companies/${c.id}/ai`, { method: "POST", body: JSON.stringify({ kind: "brief", regenerate: true }) });
      $("#briefBox").innerHTML = md(b.content);
      $("#briefMeta").textContent = aiMeta(b);
    } catch (e) { $("#briefBox").innerHTML = `<p class="error">${esc(e.message)}</p>`; }
    $("#briefBtn").disabled = false; $("#briefBtn").textContent = "Rewrite";
  });
  renderDeal(c);
  $("#copy").addEventListener("click", async () => { await navigator.clipboard.writeText($("#draft").textContent); $("#copy").textContent = "Copied"; setTimeout(() => ($("#copy").textContent = "Copy"), 1200); });
  $("#pSave").addEventListener("click", async () => {
    const r = await api(`/api/companies/${c.id}/pipeline`, { method: "PUT", body: JSON.stringify({ status: $("#pStatus").value, notes: $("#pNotes").value }) });
    $("#pSaved").textContent = `Saved ${new Date(r.updated_at).toLocaleTimeString()}`;
    if (location.hash.startsWith("#/pipeline")) renderPipeline();
  });
  $("#closeDrawer").addEventListener("click", closeDrawer);
  $("#drawer").classList.add("open"); $("#scrim").classList.add("open"); $("#drawer").setAttribute("aria-hidden", "false");
}
function closeDrawer() { $("#drawer").classList.remove("open"); $("#scrim").classList.remove("open"); $("#drawer").setAttribute("aria-hidden", "true"); }

// ================================================================== deal builder
function renderDeal(c) {
  const box = $("#deal");
  const base = recommend(c);
  if (!base) {
    box.innerHTML = `<h3>Deal</h3><p class="muted">Not enough published financials to value this company yet. Ask for three years of accounts on the first call.</p>`;
    return;
  }
  const v = base.valuation, cur = c.currency;
  const lo = Math.max(1, v.equity[0] * 0.5), hi = v.equity[2] * 1.4;
  let price = Math.round(base.fundablePrice);
  let key = base.best.key;
  const draw = () => {
    const s = structure(key, price, v.ebitda);
    const pos = (x) => `${Math.max(0, Math.min(100, ((x - lo) / (hi - lo)) * 100))}%`;
    const maxD = Math.max(2.5, ...s.dscr.filter(Boolean));
    box.innerHTML = `
      <h3>Deal</h3>
      <div class="val">
        <div class="val-head"><span>Indicative value</span><b>${dmoney(v.equity[0], cur)} – ${dmoney(v.equity[2], cur)}</b></div>
        <div class="val-track"><div class="val-band" style="left:${pos(v.equity[0])};width:calc(${pos(v.equity[2])} - ${pos(v.equity[0])})"></div><div class="val-price" style="left:${pos(price)}"></div></div>
        <div class="val-legend"><span><i class="sw band"></i>Fair value</span><span><i class="sw tick"></i>Your price</span><span class="fund">Self-funding price at 1.5× DSCR: <b>${dmoney(base.fundablePrice, cur)}</b> (${esc(base.fundableStructure)})</span></div>
        <small class="muted">${esc(v.basis)} · ${v.multiple.join("–")}× EBITDA${v.netCash ? ` · net cash ${dmoney(v.netCash, cur)}` : ""} · <span class="conf ${v.confidence}">${v.confidence} confidence</span></small>
      </div>
      <label class="price">Your price <b>${dmoney(price, cur)}</b>
        <input type="range" id="priceR" min="${Math.round(lo)}" max="${Math.round(hi)}" step="${Math.max(1000, Math.round((hi - lo) / 200))}" value="${price}"></label>
      <div class="structs">${Object.entries(STRUCTURES).map(([k, x]) => `<button type="button" data-k="${k}" class="${k === key ? "on" : ""}">${esc(x.label)}${k === base.best.key ? ' <span class="rec">★</span>' : ""}</button>`).join("")}</div>
      <p class="muted small">${esc(s.blurb)}</p>
      <div class="deal-kpis">
        <div><span>Cash at close</span><b>${dmoney(0, cur)}</b></div>
        <div><span>Lowest coverage (DSCR)</span><b class="${s.bankable ? "good" : "bad"}">${s.minDscr ? s.minDscr.toFixed(2) + "×" : "–"}</b></div>
        <div><span>Max price at 1.5×</span><b>${dmoney(s.maxPriceAt15, cur)}</b></div>
      </div>
      <div class="dscr">${s.dscr.map((d, i) => `<div class="col"><div class="bar ${d == null ? "none" : d >= 1.5 ? "ok" : "low"}" style="height:${d == null ? 4 : Math.min(100, (d / maxD) * 100)}%"><span>${d == null ? "holiday" : d.toFixed(1) + "×"}</span></div><small>Y${i + 1}</small></div>`).join("")}<div class="line" style="bottom:${(1.5 / maxD) * 100}%"><span>1.5× bank minimum</span></div></div>
      <ul class="parts">${s.parts.map((p) => `<li><b>${{ bank: "Bank loan", seller: "Seller note", earnout: "Earn-out" }[p.k]}</b> ${dmoney(p.amount, cur)} <span class="muted">${Math.round(p.pct * 100)}%${p.terms ? ` · ${p.terms.rate}% over ${p.terms.years} yrs${p.terms.holiday ? ` · ${p.terms.holiday}-month holiday` : ""}` : " · paid years 2–3 if profit holds"}</span></li>`).join("")}</ul>
      <div class="row-end"><span class="verdict-line ${s.bankable ? "good" : "bad"}">${s.bankable ? "Bankable: cash flow covers debt by 1.5× or more every year." : `Below 1.5× in some years. Lower the price to about ${dmoney(s.maxPriceAt15, cur)} or lengthen the seller note.`}</span>
        <button class="ghost" id="offerBtn" type="button">Indicative offer ↗</button></div>`;
    $("#priceR").addEventListener("input", (e) => { price = +e.target.value; draw(); $("#priceR").focus(); });
    $$(".structs button").forEach((b) => b.addEventListener("click", () => { key = b.dataset.k; draw(); }));
    $("#offerBtn").addEventListener("click", () => openOffer(c, v, s));
  };
  draw();
}

function openOffer(c, v, s) {
  const me = settings(), cur = c.currency, today = new Date().toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
  const w = window.open("", "_blank");
  if (!w) return;
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Indicative offer · ${esc(c.name)}</title><link rel="icon" href="data:,">
  <style>body{font:15px/1.6 Georgia,serif;max-width:720px;margin:48px auto;padding:0 24px;color:#111}h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 6px;text-transform:uppercase;letter-spacing:.06em;font-family:system-ui}table{border-collapse:collapse;width:100%}td{padding:6px 0;border-bottom:1px solid #ddd}td:last-child{text-align:right}.muted{color:#666}@media print{button{display:none}}</style></head><body>
  <button onclick="print()">Print / save as PDF</button>
  <p class="muted">${esc(today)}</p>
  <h1>Non-binding indicative offer</h1>
  <p>To: ${esc(c.owner_name || "The owners")}, ${esc(c.name)}${c.address ? `, ${esc(c.address)}` : ""}<br>From: ${esc(me.myName || "[Your name]")}, ${esc(me.myCompany || "[Your company]")}</p>
  <p>Thank you for the conversation about the future of ${esc(c.name)}. Subject to the conditions below, we are pleased to set out the basis on which we would acquire 100% of the shares.</p>
  <h2>Price and structure</h2>
  <table><tr><td>Headline price (cash-free, debt-free, normal working capital)</td><td><b>${dmoney(s.price, cur)}</b></td></tr>
  ${s.parts.map((p) => `<tr><td>${{ bank: "Paid at completion, funded by senior bank debt", seller: `Vendor loan note at ${p.terms.rate}% over ${p.terms.years} years${p.terms.holiday ? `, first payment after ${p.terms.holiday} months` : ""}`, earnout: "Earn-out, paid in years 2 and 3 subject to maintained profitability" }[p.k]}</td><td>${dmoney(p.amount, cur)}</td></tr>`).join("")}</table>
  <p class="muted">Basis: ${esc(v.basis)}; ${v.multiple.join("–")}× EBITDA for comparable owner-operated companies.</p>
  <h2>Conditions</h2>
  <ul><li>Satisfactory financial, legal and commercial due diligence, including a quality-of-earnings review of the last three years.</li>
  <li>${s.parts.some((p) => p.k === "bank") ? "Senior debt approval on terms acceptable to us." : "No external financing condition."}</li>
  <li>Continuity of key staff and customer contracts; a handover period with you of 6–12 months on agreed terms.</li>
  <li>Exclusivity for 60 days from acceptance of this letter.</li></ul>
  <h2>Timetable</h2><p>Due diligence within 60 days of acceptance and signing within 30 days after that.</p>
  <p>This letter is not legally binding except for confidentiality and exclusivity. We look forward to your thoughts.</p>
  <p>${esc(me.myName || "[Your name]")}<br>${esc(me.myCompany || "[Your company]")}<br>${esc([me.myPhone, me.myEmail].filter(Boolean).join(" · "))}</p>
  </body></html>`);
  w.document.close();
}

const aiMeta = (o) => `${o.model.startsWith("claude") ? "Claude" : "Workers AI"} · ${new Date(o.created_at).toLocaleDateString()}`;
// Minimal, safe markdown: escape first, then headings, bullets, bold, paragraphs.
function md(src) {
  const lines = esc(src).split(/\n/);
  let out = "", inList = false;
  for (const raw of lines) {
    const l = raw.trim();
    const bullet = l.match(/^[-*•]\s+(.*)/) || l.match(/^\d+[.)]\s+(.*)/);
    if (bullet) { if (!inList) { out += "<ul>"; inList = true; } out += `<li>${inline(bullet[1])}</li>`; continue; }
    if (inList) { out += "</ul>"; inList = false; }
    if (!l) continue;
    const h = l.match(/^#{1,4}\s+(.*)/);
    out += h ? `<h4>${inline(h[1])}</h4>` : `<p>${inline(l)}</p>`;
  }
  return out + (inList ? "</ul>" : "");
}
const inline = (t) => t.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

// ================================================================== outreach drafts
function drafts(c, s) {
  const first = (c.owner_name || "").split(" ")[0] || "there";
  const me = s.myName || "[Your name]", co = s.myCompany || "[Your company]", phone = s.myPhone || "[Your phone]", email = s.myEmail || "[Your email]";
  const angle = s.myAngle || "I run an operating business in your industry";
  const where = c.city || "your area";
  const tenure = c.founded ? `since ${c.founded}` : "for years";
  const foreign = { fr: "French", no: "Norwegian" }[c.country];
  const lang = foreign ? ` Translate to ${foreign} before sending; owners respond far better in their own language.` : "";
  const footer = `\n\n—\n${co} · ${s.myAddress || "[Your mailing address]"}\nNot interested? Reply "no thanks" and I won't contact you again.`;
  const letter = letterText(c, s);
  const e1 = `Subject: ${c.name} — a question

Hi ${first},

${angle}. I came across ${c.name}; serving ${where} ${tenure} is no small thing.

Have you ever thought about selling the business, or bringing in a partner so you can step back?

If it's on your radar in the next few years, I'd value 15 minutes. If not, no problem at all.

${me}
${phone}${footer}`;
  const e2 = `Subject: re: ${c.name}

${first}, following up on my note. Most owners I speak with aren't selling tomorrow; they just want to know their options and what the business is worth.

Happy to share how we've structured deals so owners keep their legacy and their people. Worth a quick call?

${me}${footer}`;
  const e3 = `Subject: closing the loop

${first}, I'll leave it here for now. If the timing changes, I'm on ${phone}. I'll check back in six months.

${me}${footer}`;
  const call = `OPENER
"Hi, is this ${first}? This is ${me} from ${co}. ${angle}. I'll be quick — have you ever thought about selling ${c.name}?"

IF YES / MAYBE
"What would a good outcome look like for you — timing, your role afterwards, your team?"
→ Ask: revenue, number of staff, customer mix, recurring contracts.
→ Next step: "Can I send a short NDA so we can look at the last three years of numbers together?"

IF NOT NOW
"Completely understand. You've built something real ${tenure}. Mind if I check back in six months?"

IF NO
"No problem at all — thank you for your time." (Set status to Passed.)

WHAT WE KNOW
• ${c.summary || "Limited data published"}
• ${c.signals.filter((x) => x.pts > 0).map((x) => x.label).join("\n• ")}`;
  return {
    letter: { text: letter, note: `Best first touch for owners over 55.${lang}` },
    email: { text: [e1, "────────── 4 days later ──────────", e2, "────────── 10 days later ──────────", e3].join("\n\n"), note: `Send from a separate, warmed-up domain. Includes address and opt-out.${lang}` },
    call: { text: call, note: "People dial, not robots. Check national do-not-call lists before calling." },
  };
}

// ================================================================== boot
$("#scrim").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
document.addEventListener("click", () => { const m = $("#exportMenu"); if (m) m.hidden = true; });
$("#menuBtn").addEventListener("click", () => $("#side").classList.toggle("open"));
$("#addBtn").addEventListener("click", () => { $("#addErr").textContent = ""; $("#addForm").reset(); $("#addDlg").showModal(); });
$("#addCancel").addEventListener("click", () => $("#addDlg").close());
$("#addForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $("#addErr").textContent = "Looking it up…";
  try {
    const c = await api("/api/companies/add", { method: "POST", body: JSON.stringify({ country: f.get("country"), number: f.get("number") }) });
    $("#addDlg").close();
    renderSearches();
    openCompany(c.id);
  } catch (err) { $("#addErr").textContent = err.message; }
});
$("#logout").addEventListener("click", async () => { await fetch("/api/logout", { method: "POST" }); location.href = "/login"; });
$("#settingsBtn").addEventListener("click", () => {
  const s = settings();
  for (const el of $("#settingsForm").elements) if (el.name) el.value = s[el.name] || "";
  $("#settings").showModal();
});
$("#settingsForm").addEventListener("submit", () => {
  const s = {};
  for (const el of $("#settingsForm").elements) if (el.name) s[el.name] = el.value.trim();
  try { localStorage.setItem("dealflow.settings", JSON.stringify(s)); } catch { /* storage unavailable */ }
});
(async () => {
  sources = await api("/api/sources");
  window.addEventListener("hashchange", router); // only route once countries and industries are loaded
  router();
})();
