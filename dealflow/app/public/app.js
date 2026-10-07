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
let me = null; // signed-in user, account, plan and territories
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
  const [, view, id] = location.hash.split("?")[0].split("/");
  $$(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.nav === view));
  if (view === "new") return renderNew();
  if (view === "home" || !view) return renderHome(seq);
  if (view === "agents" && id === "new") return renderAgentNew(seq);
  if (view === "agents" && id) return renderAgent(Number(id), seq);
  if (view === "agents") return renderAgents(seq);
  if (view === "pipeline") return renderPipeline(seq);
  if (view === "territories") return renderTerritories(seq);
  if (view === "team") return renderTeam(seq);
  if (view === "admin" && me.isAdmin) return renderAdmin(seq);
  if (view === "search" && id) return renderResults(Number(id), seq);
  const searches = await renderSearches();
  if (stale(seq)) return;
  if (!searches.length && view !== "all") { location.hash = "#/home"; return; }
  return renderResults(null, seq);
}

// ================================================================== new search
function renderNew() {
  renderSearches();
  if (!me.isAdmin) return renderNewInTerritory();
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

// Members search only inside the territories they hold: pick one, optionally narrow a whole-country one.
function renderNewInTerritory() {
  const mine = me.territories;
  if (!mine.length) {
    $("#view").innerHTML = `<header class="page-head"><div><h1>New search</h1></div></header>
      <div class="empty-state"><h3>Claim a territory first</h3><p class="muted">You search inside the industries and areas you hold exclusively. ${me.isOwner ? "" : "Ask your account owner to claim one."}</p>
      ${me.isOwner ? `<a class="primary" href="#/territories">Claim a territory</a>` : ""}</div>`;
    return;
  }
  const pre = Number(new URLSearchParams(location.hash.split("?")[1] || "").get("t"));
  let t = mine.find((x) => x.id === pre) || mine[0];
  const st = { region: t.region || "", minStaff: 1 };
  const draw = () => {
    const c = country(t.country);
    $("#view").innerHTML = `
      <header class="page-head"><div><h1>New search</h1><p class="muted">Pull every matching company in your territory from the official registry and score it on succession and size. Nobody else on Dealflow can search here.</p></div></header>
      <section class="step"><h3><span>1</span> Territory</h3>
        <div class="countries">${mine.map((x) => `<button type="button" class="country ${x.id === t.id ? "on" : ""}" data-t="${x.id}"><span class="flag big">${country(x.country)?.flag || ""}</span><b>${esc(x.label)}</b><span class="badge ok">Exclusive</span></button>`).join("")}</div>
        ${c.ready ? "" : `<p class="notice">${esc(c.label)} needs <code>${esc(c.needsKey)}</code> on the server before it can be searched. We've been told.</p>`}
      </section>
      ${!t.region && Array.isArray(c.regions) ? `<section class="step"><h3><span>2</span> ${esc(c.regionLabel)} (optional)</h3>
        <select id="region"><option value="">All of ${esc(c.label)}</option>${c.regions.map((r) => `<option value="${esc(r.code)}" ${r.code === st.region ? "selected" : ""}>${esc(r.name)}</option>`).join("")}</select></section>` : ""}
      <section class="step"><h3><span>${!t.region && Array.isArray(c.regions) ? 3 : 2}</span> Minimum staff</h3>
        <div class="seg" id="staff">${[0, 1, 6, 10, 20, 50].map((n) => `<button type="button" data-n="${n}" class="${n === st.minStaff ? "on" : ""}">${n ? `${n}+` : "Any"}</button>`).join("")}</div>
      </section>
      <div class="go"><button class="primary big" id="go" type="button" ${c.ready ? "" : "disabled"}>Find companies</button><span class="error" id="goErr"></span></div>`;
    $$("[data-t]").forEach((b) => b.addEventListener("click", () => { t = mine.find((x) => x.id === +b.dataset.t); st.region = t.region || ""; draw(); }));
    $("#region")?.addEventListener("change", (e) => (st.region = e.target.value));
    $$("#staff button").forEach((b) => b.addEventListener("click", () => { st.minStaff = +b.dataset.n; $$("#staff button").forEach((x) => x.classList.toggle("on", x === b)); }));
    $("#go").addEventListener("click", async () => {
      $("#go").disabled = true; $("#goErr").textContent = "";
      try {
        const s = await api("/api/searches", { method: "POST", body: JSON.stringify({ country: t.country, industry: t.industry, region: st.region, minStaff: st.minStaff }) });
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
      <div class="draft-actions"><span class="muted small" id="briefMeta">${c.ai?.brief ? aiMeta(c.ai.brief) : ""}</span><span class="btns"><button class="ghost" id="listenBtn" type="button" ${c.ai?.brief ? "" : "hidden"}>▶ Listen</button><button class="primary" id="briefBtn" type="button">${c.ai?.brief ? "Rewrite" : "Write brief"}</button></span></div>
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

    <div class="d-sec"><h3>Voice note</h3>
      <div class="voice-note">
        <button class="mic big" id="vnMic" type="button" aria-label="Record call notes"><span class="dot"></span></button>
        <div><b>Talk through the call</b><p class="muted small">Say what the owner told you: timeline, price, numbers, worries, next step. It's transcribed and turned into pipeline notes.</p></div>
      </div>
      <div class="vn-result" id="vnResult"></div>
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
      $("#draftNote").innerHTML = `${aiLetter ? `${esc(aiMeta(aiLetter))} · ` : ""}<select id="voiceSel" class="voice-sel" aria-label="Voice"><option value="warm">Warm & respectful</option><option value="jl">JL: direct operator</option></select> <button class="link strong" id="aiLetterBtn" type="button">${aiLetter ? "Rewrite" : "Write it"}</button>`;
      $("#voiceSel").value = settings().voice || "warm";
      $("#aiLetterBtn").addEventListener("click", async () => {
        $("#draftNote").textContent = "Writing…";
        try {
          aiLetter = await api(`/api/companies/${c.id}/ai`, { method: "POST", body: JSON.stringify({ kind: "letter", regenerate: true, me: settings(), voice: $("#voiceSel")?.value || settings().voice || "warm" }) });
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
      $("#listenBtn").hidden = false;
    } catch (e) { $("#briefBox").innerHTML = `<p class="error">${esc(e.message)}</p>`; }
    $("#briefBtn").disabled = false; $("#briefBtn").textContent = "Rewrite";
  });
  renderDeal(c);
  let audio;
  $("#listenBtn").addEventListener("click", () => {
    if (audio && !audio.paused) { audio.pause(); $("#listenBtn").textContent = "▶ Listen"; return; }
    audio = new Audio(`/api/companies/${c.id}/brief.mp3?t=${Date.now()}`);
    $("#listenBtn").textContent = "… loading";
    audio.addEventListener("playing", () => ($("#listenBtn").textContent = "❚❚ Pause"));
    audio.addEventListener("ended", () => ($("#listenBtn").textContent = "▶ Listen"));
    audio.addEventListener("error", () => ($("#listenBtn").textContent = "Audio failed"));
    audio.play();
  });
  micButton($("#vnMic"), async (text) => {
    $("#vnResult").innerHTML = `<p class="muted">“${esc(text)}”</p><div class="skeleton"></div><div class="skeleton short"></div>`;
    try {
      const r = await api(`/api/companies/${c.id}/voice-note`, { method: "POST", body: JSON.stringify({ text }) });
      const x = r.extracted;
      const chip = (k, v) => (v ? `<span class="xchip"><i>${k}</i>${esc(v)}</span>` : "");
      $("#vnResult").innerHTML = `<p class="transcript">“${esc(text)}”</p>
        <p>${esc(x.summary)}</p>
        <div class="xchips">${chip("Intent", x.intent)}${chip("Timeline", x.timeline)}${chip("Asking", x.asking_price)}${chip("Revenue", x.revenue)}${chip("Profit", x.profit)}${chip("Next", [x.next_step, x.next_step_date].filter(Boolean).join(" · "))}${chip("Stage", x.stage)}</div>
        ${x.concerns?.length ? `<p class="small muted">Concerns: ${esc(x.concerns.join("; "))}</p>` : ""}`;
      $("#pNotes").value = r.notes + ($("#pNotes").value ? "\n\n" + $("#pNotes").value : "");
      if (x.stage) $("#pStatus").value = x.stage;
      $("#pSaved").textContent = "Saved from voice note";
    } catch (e) { $("#vnResult").innerHTML = `<p class="error">${esc(e.message)}</p>`; }
  }, `Notes about ${c.name}. Owner ${c.owner_name || ""}.`);
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
  [sources] = await Promise.all([api("/api/sources"), refreshMe()]);
  window.addEventListener("hashchange", router); // only route once countries and industries are loaded
  router();
})();

async function refreshMe() {
  me = await api("/api/me");
  $("#acctName").textContent = me.account.name;
  $("#acctPlan").textContent = `${me.account.planLabel} · ${me.territories.length}/${me.account.maxTerritories} territories`;
  $("#adminNav").hidden = !me.isAdmin;
  return me;
}

// ================================================================== voice capture
// Tap to record, tap again to stop. Audio goes to Whisper on the server; the transcript is handed to onText.
function micButton(btn, onText, hint = "") {
  let rec = null, chunks = [], stream = null;
  btn.addEventListener("click", async () => {
    if (rec && rec.state === "recording") { rec.stop(); return; }
    if (!navigator.mediaDevices?.getUserMedia) { alert("This browser can't record audio."); return; }
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { alert("Microphone access was blocked. Allow it in the browser to use voice."); return; }
    chunks = [];
    rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      btn.classList.remove("rec"); btn.classList.add("busy");
      try {
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        const res = await fetch(`/api/voice/transcribe?hint=${encodeURIComponent(hint)}`, { method: "POST", headers: { "Content-Type": blob.type }, body: blob });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || "Transcription failed");
        if (d.text) onText(d.text);
      } catch (e) { alert(e.message); }
      btn.classList.remove("busy");
    };
    rec.start();
    btn.classList.add("rec");
  });
}

// ================================================================== home
async function renderHome(seq) {
  renderSearches();
  const h = await api("/api/home");
  if (stale(seq)) return;
  const t = h.totals || {};
  const hr = new Date().getHours();
  const hello = hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening";
  const stages = h.statuses.filter((s) => !["New", "Passed", "Not a fit"].includes(s));
  const by = Object.fromEntries(h.funnel.map((f) => [f.status, f.n]));
  const maxF = Math.max(1, ...stages.map((s) => by[s] || 0));
  const name = settings().myName?.split(" ")[0];
  $("#view").innerHTML = `
    <section class="hero-card">
      <div>
        <p class="eyebrow">${esc(new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }))}</p>
        <h1>${hello}${name ? `, ${esc(name)}` : ""}.</h1>
        <p class="lede">Tell an agent what you're looking for. It sources, values, briefs and drafts outreach while you do the calls.</p>
        <div class="composer mini">
          <button class="mic" id="homeMic" type="button" aria-label="Speak a goal"><span class="dot"></span></button>
          <input id="homeGoal" placeholder="e.g. Every week find HVAC owners over 60 around Lyon, value them and brief the top 10">
          <button class="primary" id="homeGo" type="button">Plan agent →</button>
        </div>
      </div>
    </section>
    <section class="stats">
      ${[["Companies tracked", t.companies], ["Owners 60+", t.owners60], ["Worth a call or better", t.good], ["Valued from filings", t.valued]].map(([l, v], i) => `
        <div class="stat"><span>${l}</span><b data-count="${v || 0}">${fmt(v || 0)}</b>${i === 0 ? `<small>${t.countries || 0} countries</small>` : ""}</div>`).join("")}
    </section>
    <div class="grid2">
      <section class="panel">
        <header><h3>Pipeline</h3><a href="#/pipeline">Open board →</a></header>
        ${h.funnel.length ? `<div class="funnel">${stages.map((s) => `<div class="frow"><span>${esc(s)}</span><div class="fbar"><i style="width:${((by[s] || 0) / maxF) * 100}%"></i></div><b>${by[s] || 0}</b></div>`).join("")}</div>`
          : `<p class="muted">Nothing in play yet. Open a company and move it to Researching, or let an agent do it.</p>`}
      </section>
      <section class="panel">
        <header><h3>Agent activity</h3><a href="#/agents">All agents →</a></header>
        ${h.runs.length ? `<ul class="feed">${h.runs.map((r) => `<li><a href="#/agents/${r.agent_id}"><span class="sdot ${r.status}"></span><b>${esc(r.name)}</b><small>${esc(r.summary || ({ queued: "Starting…", running: "Working…" }[r.status] || r.status))}</small></a></li>`).join("")}</ul>`
          : `<div class="empty-mini"><p class="muted">No agents yet.</p><a class="primary" href="#/agents/new">Create your first agent</a></div>`}
      </section>
      <section class="panel">
        <header><h3>Inbound sellers</h3><a href="/value" target="_blank">Valuation page ↗</a></header>
        ${h.inbound.length ? `<ul class="feed">${h.inbound.map((l) => `<li><a href="#" data-co="${l.company_id}"><span class="sdot hot"></span><b>${esc(l.company || l.name)}</b><small>${esc(l.name)} · ${esc(l.timeline || "timeline not given")} · valued ${dmoney(l.valuation_low, l.currency)}–${dmoney(l.valuation_high, l.currency)}</small></a></li>`).join("")}</ul>`
          : `<p class="muted">Owners who value their company on your public page land here. Share <b>/value</b> in letters and emails.</p>`}
      </section>
      <section class="panel">
        <header><h3>Strong targets</h3><a href="#/all">All targets →</a></header>
        ${h.fresh.length ? `<ul class="feed">${h.fresh.map((c) => `<li><a href="#" data-co="${c.id}"><span class="fitring" style="--v:${c.fit_score}">${c.fit_score}</span><b>${esc(c.name)}</b><small>${esc(c.summary || c.city || "")}</small></a></li>`).join("")}</ul>`
          : `<p class="muted">Run a search or an agent to see targets here.</p>`}
      </section>
    </div>`;
  const go = () => { const g = $("#homeGoal").value.trim(); location.hash = `#/agents/new${g ? `?goal=${encodeURIComponent(g)}` : ""}`; };
  $("#homeGo").addEventListener("click", go);
  $("#homeGoal").addEventListener("keydown", (e) => e.key === "Enter" && go());
  micButton($("#homeMic"), (text) => { $("#homeGoal").value = text; go(); }, "An acquisition sourcing goal: industry, place, owner age, size, value.");
  $$("[data-co]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); if (a.dataset.co) openCompany(+a.dataset.co); }));
  countUp();
}

function countUp() {
  $$("[data-count]").forEach((el) => {
    const end = +el.dataset.count;
    if (!end || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t0 = performance.now();
    const tick = (t) => { const k = Math.min(1, (t - t0) / 700); el.textContent = fmt(Math.round(end * (1 - (1 - k) ** 3))); if (k < 1) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
}

// ================================================================== agents
const SCHED = { manual: "Runs when you start it", daily: "Runs every day", weekly: "Runs every week" };
const STEP_ICON = { source: "◎", filter: "⧩", value: "€", brief: "✎", letter: "✉", pipeline: "➜", report: "◷" };

async function renderAgents(seq) {
  renderSearches();
  const d = await api("/api/agents");
  if (stale(seq)) return;
  $("#view").innerHTML = `
    <header class="page-head"><div><h1>Agents</h1><p class="muted">Give an agent a goal. It turns it into a plan you can check, then sources, values, briefs and drafts outreach on its own, as often as you like.</p></div>
      <a class="primary" href="#/agents/new">+ New agent</a></header>
    ${d.agents.length ? `<section class="agent-list">${d.agents.map((a) => `
      <a class="agent-card" href="#/agents/${a.id}">
        <div class="ac-top"><span class="sdot ${a.last_status || "idle"}"></span><b>${esc(a.name)}</b><span class="badge ${a.config.schedule === "manual" ? "" : "ok"}">${a.config.schedule === "manual" ? "Manual" : a.config.schedule === "daily" ? "Daily" : "Weekly"}</span></div>
        <p>${esc(a.goal)}</p>
        <div class="ac-foot"><span>${fmt(a.total_targets)} companies worked</span><span>${a.last_run_at ? `Last run ${new Date(a.last_run_at).toLocaleDateString()}` : a.last_status ? esc(a.last_status) : "Not run yet"}</span></div>
      </a>`).join("")}</section>` : ""}
    <h3 class="section-title">${d.agents.length ? "Start from a template" : "Start from a template, or describe your own"}</h3>
    <section class="templates">${d.templates.map((t) => `
      <a class="template" href="#/agents/new?goal=${encodeURIComponent(t.goal)}"><b>${esc(t.title)}</b><p>${esc(t.blurb)}</p><span>Use template →</span></a>`).join("")}
    </section>`;
}

async function renderAgentNew(seq) {
  renderSearches();
  const goal0 = new URLSearchParams(location.hash.split("?")[1] || "").get("goal") || "";
  $("#view").innerHTML = `
    <header class="page-head"><div><h1>New agent</h1><p class="muted">Say or type what you want. You'll see the plan before anything runs.</p></div></header>
    <section class="composer big">
      <button class="mic big" id="agMic" type="button" aria-label="Speak your goal"><span class="dot"></span></button>
      <textarea id="agGoal" rows="3" placeholder="Every week, find HVAC companies around Lyon with 6+ staff and owners over 60. Value them, write a brief for the best 10 and put them in Researching.">${esc(goal0)}</textarea>
      <button class="primary" id="agPlan" type="button">Plan it</button>
    </section>
    <p class="muted small hint">Mention the industry, the place, owner age, size or value, how many, and whether to write briefs or letters (say “in the JL voice” for the direct style) and how often.</p>
    <div id="plan"></div>`;
  const plan = async () => {
    const goal = $("#agGoal").value.trim();
    if (!goal) return;
    $("#agPlan").disabled = true;
    $("#plan").innerHTML = `<div class="plan-loading"><div class="skeleton"></div><div class="skeleton short"></div><div class="skeleton"></div></div>`;
    try { renderPlan(await api("/api/agents/plan", { method: "POST", body: JSON.stringify({ goal }) })); }
    catch (e) { $("#plan").innerHTML = `<p class="error">${esc(e.message)}</p>`; }
    $("#agPlan").disabled = false;
  };
  $("#agPlan").addEventListener("click", plan);
  micButton($("#agMic"), (text) => { $("#agGoal").value = text; plan(); }, "An acquisition sourcing goal: industry, place, owner age, size, value.");
  if (goal0) plan();
}

function planSteps(c) {
  const ctry = country(c.country), ind = sources.industries.find((i) => i.id === c.industry);
  const cur = { fr: "€", no: "NOK ", uk: "£", us: "$" }[c.country];
  const m = (v) => (v >= 1e6 ? `${cur}${+(v / 1e6).toFixed(1)}M` : `${cur}${Math.round(v / 1e3)}k`);
  return [
    ["source", "Source", `${(/s$/i.test(ind?.label || "") ? `All ${ind.label.toLowerCase()}` : `Every ${ind?.label} company`)} in ${c.regionLabel || `all of ${ctry?.label}`}${c.minStaff ? ` with ${c.minStaff}+ staff` : ""}, from ${c.country === "us" ? "Google Places" : "the official registry"}.`],
    ["filter", "Shortlist", `Owners ${c.minOwnerAge ? `${c.minOwnerAge}+` : "of any age"}${c.minValue || c.maxValue ? `, valued ${c.minValue ? m(c.minValue) : "any"}–${c.maxValue ? m(c.maxValue) : "any"}` : ""}; best ${c.topN} by fit, new ones only.`],
    ["value", "Value", "Valuation from filed accounts and the self-funding price at 1.5× debt cover."],
    c.brief && ["brief", "Brief", "One-page acquisition brief for each."],
    c.letter && ["letter", "Letter", `First letter in the owner's language, ${c.voice === "jl" ? "JL direct-operator" : "warm"} voice.`],
    c.stage && ["pipeline", "Pipeline", `Move to ${c.stage}.`],
    ["report", "Report", `Summary of what it found.${c.schedule !== "manual" ? ` Repeats ${c.schedule}.` : ""}`],
  ].filter(Boolean);
}

function renderPlan(p) {
  const c = { ...p.config };
  const inds = () => sources.industries.filter((i) => i.countries.includes(c.country));
  const draw = () => {
    const ctry = country(c.country);
    $("#plan").innerHTML = `
      <section class="plan">
        <div class="plan-head"><input id="agName" class="name-input" value="${esc(p.name)}" aria-label="Agent name"><span class="badge ${c.schedule === "manual" ? "" : "ok"}">${SCHED[c.schedule]}</span></div>
        ${p.warnings.map((w) => `<p class="notice">${esc(w)}</p>`).join("")}
        <ol class="steps">${planSteps(c).map(([k, t, x], i) => `<li style="--i:${i}"><span class="si">${STEP_ICON[k]}</span><div><b>${t}</b><p>${esc(x)}</p></div></li>`).join("")}</ol>
        <details class="tune" open><summary>Adjust the plan</summary>
          <div class="tune-grid">
            <label>Country<select data-k="country">${sources.countries.map((x) => `<option value="${x.id}" ${x.id === c.country ? "selected" : ""} ${x.ready ? "" : "disabled"}>${x.flag} ${esc(x.label)}${x.ready ? "" : " (needs key)"}</option>`).join("")}</select></label>
            <label>Industry<select data-k="industry">${inds().map((i) => `<option value="${i.id}" ${i.id === c.industry ? "selected" : ""}>${esc(i.label)}</option>`).join("")}</select></label>
            <label>${esc(ctry.regionLabel)}${Array.isArray(ctry.regions)
              ? `<select data-k="region"><option value="">All of ${esc(ctry.label)}</option>${ctry.regions.map((r) => `<option value="${esc(r.code)}" ${r.code === c.region ? "selected" : ""}>${esc(r.name)}</option>`).join("")}</select>`
              : `<input data-k="region" value="${esc(c.region || "")}" placeholder="City or area">`}</label>
            <label>Min staff<input data-k="minStaff" type="number" min="0" value="${c.minStaff}"></label>
            <label>Owner age at least<input data-k="minOwnerAge" type="number" min="0" max="90" value="${c.minOwnerAge || ""}" placeholder="any"></label>
            <label>How many per run<input data-k="topN" type="number" min="1" max="50" value="${c.topN}"></label>
            <label>Min value<input data-k="minValue" type="number" min="0" step="100000" value="${c.minValue || ""}" placeholder="any"></label>
            <label>Max value<input data-k="maxValue" type="number" min="0" step="100000" value="${c.maxValue || ""}" placeholder="any"></label>
            <label>Move to stage<select data-k="stage"><option value="">Don't change</option><option ${c.stage === "Researching" ? "selected" : ""}>Researching</option><option ${c.stage === "Contacted" ? "selected" : ""}>Contacted</option></select></label>
            <label>Schedule<select data-k="schedule">${Object.keys(SCHED).map((k) => `<option value="${k}" ${k === c.schedule ? "selected" : ""}>${SCHED[k]}</option>`).join("")}</select></label>
            <label>Letter voice<select data-k="voice"><option value="warm" ${c.voice === "warm" ? "selected" : ""}>Warm & respectful</option><option value="jl" ${c.voice === "jl" ? "selected" : ""}>JL: direct operator</option></select></label>
            <div class="toggles"><label class="check"><input type="checkbox" data-k="brief" ${c.brief ? "checked" : ""}> Write briefs</label><label class="check"><input type="checkbox" data-k="letter" ${c.letter ? "checked" : ""}> Write letters</label></div>
          </div>
        </details>
        <div class="row-end"><span class="muted small">Letters are signed with your Outreach settings.</span><button class="ghost" id="agSave" type="button">Save without running</button><button class="primary big" id="agLaunch" type="button">Launch agent ▸</button></div>
        <p class="error" id="agErr"></p>
      </section>`;
    $$("[data-k]").forEach((el) => el.addEventListener("change", () => {
      const k = el.dataset.k;
      c[k] = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) || 0 : el.value || null;
      if (k === "country") { c.region = null; c.regionLabel = null; if (!inds().find((i) => i.id === c.industry)) c.industry = inds()[0]?.id; }
      if (k === "region") c.regionLabel = el.tagName === "SELECT" ? (el.selectedOptions[0]?.textContent.replace(/^\S+ · /, "") || null) : el.value || null;
      p.name = $("#agName").value;
      draw();
    }));
    const launch = async (run) => {
      $("#agErr").textContent = "";
      try {
        const a = await api("/api/agents", { method: "POST", body: JSON.stringify({ name: $("#agName").value, goal: p.goal, config: c, buyer: settings(), run }) });
        location.hash = `#/agents/${a.id}`;
      } catch (e) { $("#agErr").textContent = e.message; }
    };
    $("#agLaunch").addEventListener("click", () => launch(true));
    $("#agSave").addEventListener("click", () => launch(false));
  };
  draw();
}

async function renderAgent(id, seq) {
  clearInterval(pollTimer);
  renderSearches();
  const a = await api(`/api/agents/${id}`);
  if (stale(seq)) return;
  const live = a.runs.some((r) => ["queued", "running"].includes(r.status));
  $("#view").innerHTML = `
    <header class="page-head">
      <div><p class="eyebrow"><a href="#/agents">Agents</a></p><h1>${esc(a.name)}</h1><p class="muted">${esc(a.goal)}</p></div>
      <div class="head-actions">
        <label class="switch"><input type="checkbox" id="agActive" ${a.active ? "checked" : ""}><span></span>${esc(SCHED[a.config.schedule])}</label>
        <button class="ghost" id="agDel" type="button">Delete</button>
        <button class="primary" id="agRun" type="button" ${live ? "disabled" : ""}>${live ? "Running…" : "Run now ▸"}</button>
      </div>
    </header>
    <div class="grid-agent">
      <section class="panel">
        <header><h3>Plan</h3></header>
        <ol class="steps compact ${seq !== "first" && document.querySelector(".steps.compact") ? "static" : ""}">${a.steps.map((s, i) => `<li style="--i:${i}"><span class="si">${STEP_ICON[s.key]}</span><div><b>${esc(s.title)}</b><p>${esc(s.text)}</p></div></li>`).join("")}</ol>
      </section>
      <section class="panel">
        <header><h3>Runs</h3></header>
        ${a.runs.length ? a.runs.slice(0, 5).map((r, i) => `
          <details class="run" ${i === 0 ? "open" : ""}>
            <summary><span class="sdot ${r.status}"></span><b>${new Date(r.started_at).toLocaleString()}</b><span class="muted">${esc(r.trigger)} · ${esc(r.summary || r.status)}</span></summary>
            <ol class="log">${r.log.map((l) => `<li class="${l.kind}"><time>${new Date(l.at).toLocaleTimeString()}</time><span>${esc(l.text)}</span></li>`).join("")}
              ${["queued", "running"].includes(r.status) ? `<li class="working"><time></time><span>Working<i class="dots"></i></span></li>` : ""}</ol>
          </details>`).join("") : `<p class="muted">Not run yet.</p>`}
      </section>
    </div>
    <section class="table-card">
      <div class="table-meta"><b>Companies this agent worked</b><span>${fmt(a.targets.length)}</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Company</th><th>Owner</th><th class="num">Value</th><th>Verdict</th><th>Status</th></tr></thead>
        <tbody>${a.targets.map((t) => `<tr data-id="${t.id}"><td class="co"><b>${esc(t.name)}</b><small>${esc(t.city || "")}</small></td>
          <td>${esc(t.owner_name || "–")}${t.owner_age != null ? ` <span class="age ${t.owner_age >= 60 ? "old" : ""}">${t.owner_age}</span>` : ""}</td>
          <td class="num strong-num">${t.valuation_mid ? dmoney(t.valuation_mid, t.currency) : "–"}</td>
          <td><span class="pill ${VCLASS[t.verdict]}">${esc(t.verdict)}</span></td><td class="status ${t.status !== "New" ? "active" : ""}">${esc(t.status)}</td></tr>`).join("")
          || `<tr><td colspan="5" class="empty">${live ? "Companies appear here as the agent works through them." : "None yet."}</td></tr>`}</tbody>
      </table></div>
    </section>`;
  $("#agRun").addEventListener("click", async () => { try { await api(`/api/agents/${id}/run`, { method: "POST" }); router(); } catch (e) { alert(e.message); } });
  $("#agDel").addEventListener("click", async () => { if (confirm("Delete this agent? Companies and notes it created stay.")) { await api(`/api/agents/${id}`, { method: "DELETE" }); location.hash = "#/agents"; } });
  $("#agActive").addEventListener("change", async (e) => api(`/api/agents/${id}`, { method: "PATCH", body: JSON.stringify({ active: e.target.checked }) }));
  $$("tbody tr[data-id]").forEach((tr) => tr.addEventListener("click", () => openCompany(+tr.dataset.id)));
  if (live) pollTimer = setInterval(() => { if (location.hash === `#/agents/${id}`) renderAgent(id, routeSeq); }, 5000);
}

// ================================================================== account: territories, team, admin
const COUNTRY_CUR = { fr: "€", no: "NOK ", uk: "£", us: "$" };
const indLabel = (id) => sources.industries.find((i) => i.id === id)?.label || id;

// Country + industry + area picker shared by Territories and Admin. onChange gets {country, industry, region}.
function areaPicker(el, st, onChange) {
  const draw = () => {
    const c = country(st.country);
    const inds = sources.industries.filter((i) => i.countries.includes(st.country));
    if (!inds.find((i) => i.id === st.industry)) st.industry = inds[0]?.id;
    el.innerHTML = `<div class="area-picker">
      <label>Country<select data-k="country">${sources.countries.map((x) => `<option value="${x.id}" ${x.id === st.country ? "selected" : ""}>${x.flag} ${esc(x.label)}</option>`).join("")}</select></label>
      <label>Industry<select data-k="industry">${inds.map((i) => `<option value="${i.id}" ${i.id === st.industry ? "selected" : ""}>${esc(i.label)}</option>`).join("")}</select></label>
      <label>${esc(c.regionLabel)}${Array.isArray(c.regions)
        ? `<select data-k="region"><option value="">All of ${esc(c.label)}</option>${c.regions.map((r) => `<option value="${esc(r.code)}" ${r.code === st.region ? "selected" : ""}>${esc(r.name)}</option>`).join("")}</select>`
        : `<input data-k="region" placeholder="${st.country === "us" ? "e.g. Austin, TX" : "e.g. Manchester"}" value="${esc(st.region)}">`}</label>
    </div>`;
    $$("[data-k]", el).forEach((x) => {
      const ev = x.tagName === "INPUT" ? "input" : "change";
      x.addEventListener(ev, () => {
        st[x.dataset.k] = x.value;
        if (x.dataset.k === "country") { st.region = ""; draw(); }
        else if (x.dataset.k === "industry") { /* keep region */ }
        onChange(st);
      });
    });
    onChange(st);
  };
  draw();
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

async function renderTerritories(seq) {
  renderSearches();
  const d = await api("/api/territories");
  if (stale(seq)) return;
  const pct = Math.min(100, Math.round((100 * d.used) / Math.max(1, d.limit)));
  $("#view").innerHTML = `
    <header class="page-head"><div><h1>Territories</h1><p class="muted">A territory is one industry in one area. While you hold it, no other Dealflow buyer can search it, add companies from it or receive its inbound sellers.</p></div></header>
    <section class="panel terr-meter"><header><h3>${d.used} of ${d.limit} on your ${esc(me.account.planLabel)} plan</h3>${d.used >= d.limit ? `<span class="muted small">Need more? Release one, or ask us to upgrade your plan.</span>` : ""}</header>
      <div class="meter"><span style="width:${pct}%"></span></div></section>
    <section class="terr-list">${d.territories.length ? d.territories.map((t) => `
      <div class="terr-card"><span class="flag big">${country(t.country)?.flag || ""}</span>
        <div><b>${esc(t.label)}</b><small>Exclusive since ${new Date(t.created_at).toLocaleDateString()}</small></div>
        <a class="ghost" href="#/new?t=${t.id}">Search it</a>
        ${me.isOwner ? `<button class="link danger" data-release="${t.id}" type="button">Release</button>` : ""}
      </div>`).join("") : `<div class="empty-state"><h3>No territories yet</h3><p class="muted">Claim one below to start searching.</p></div>`}
    </section>
    ${me.isOwner ? `<section class="step claim"><h3><span>+</span> Claim a territory</h3>
      <div id="claimPicker"></div>
      <div class="claim-foot"><span id="claimState" class="avail"></span><button class="primary" id="claimBtn" type="button" disabled>Claim</button></div>
      <p class="muted small">A whole-country territory covers every region in it, so it can only be claimed when no one holds any part of that industry there.</p>
    </section>` : `<p class="muted">Only your account owner can claim or release territories.</p>`}`;
  $$("[data-release]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Release this territory? Another buyer could claim it straight away.")) return;
    try { await api(`/api/territories/${b.dataset.release}`, { method: "DELETE" }); await refreshMe(); renderTerritories(routeSeq); } catch (e) { alert(e.message); }
  }));
  if (!me.isOwner) return;
  const st = { country: "fr", industry: "hvac", region: "" };
  let last = null;
  const check = debounce(async () => {
    const q = JSON.stringify(st);
    last = q;
    $("#claimState").className = "avail"; $("#claimState").textContent = "Checking…";
    const r = await api("/api/territories/check", { method: "POST", body: q }).catch((e) => ({ available: false, reason: e.message }));
    if (last !== q) return;
    $("#claimState").className = `avail ${r.available ? "ok" : "no"}`;
    $("#claimState").textContent = r.available ? `${r.label} is available` : r.reason;
    $("#claimBtn").disabled = !r.available || !d.canClaim;
    if (r.available && !d.canClaim) $("#claimState").textContent += ` · your plan is full`;
  }, 250);
  areaPicker($("#claimPicker"), st, check);
  $("#claimBtn").addEventListener("click", async () => {
    $("#claimBtn").disabled = true;
    try { await api("/api/territories", { method: "POST", body: JSON.stringify(st) }); await refreshMe(); renderTerritories(routeSeq); }
    catch (e) { $("#claimState").className = "avail no"; $("#claimState").textContent = e.message; }
  });
}

async function renderTeam(seq) {
  renderSearches();
  const d = await api("/api/team");
  if (stale(seq)) return;
  const when = (t) => (t ? new Date(t).toLocaleDateString() : "never");
  $("#view").innerHTML = `
    <header class="page-head"><div><h1>Team</h1><p class="muted">${esc(me.account.name)} · ${esc(me.account.planLabel)} plan. Everyone here shares the same territories, pipeline, drafts and agents.</p></div></header>
    <div class="grid2">
      <section class="panel"><header><h3>People</h3></header>
        <ul class="rows">${d.members.map((u) => `<li><div><b>${esc(u.name || u.email)}</b><small>${esc(u.email)} · ${u.is_admin ? "platform admin" : esc(u.role)} · last sign-in ${when(u.last_login_at)}</small></div>
          ${d.isOwner && u.id !== d.me ? `<button class="link danger" data-rm="${u.id}" type="button">Remove</button>` : ""}</li>`).join("")}</ul>
        ${d.invites.length ? `<h4>Waiting to join</h4><ul class="rows">${d.invites.map((i) => `<li><div><b>${esc(i.email || "Anyone with the link")}</b><small>${esc(i.role)} · expires ${when(i.expires_at)}</small></div><button class="link danger" data-revoke="${i.id}" type="button">Cancel</button></li>`).join("")}</ul>` : ""}
        ${d.isOwner ? `<form id="invForm" class="inline-form"><input name="email" type="email" placeholder="colleague@company.com" required><select name="role"><option value="member">Member</option><option value="owner">Owner</option></select><button class="primary">Invite</button></form>
        <div id="invOut"></div>` : ""}
      </section>
      <section class="panel"><header><h3>API & MCP tokens</h3></header>
        <p class="muted small">Use a token with the REST API (<code>Authorization: Bearer …</code>) or add Dealflow to Claude as a remote MCP server at <code>${location.origin}/mcp</code>. Tokens act as you and only see your account.</p>
        <ul class="rows">${d.tokens.map((t) => `<li><div><b>${esc(t.label)}</b><small>${esc(t.email)} · created ${when(t.created_at)} · last used ${when(t.last_used_at)}</small></div><button class="link danger" data-tok="${t.id}" type="button">Revoke</button></li>`).join("") || `<li class="muted small">No tokens yet.</li>`}</ul>
        <form id="tokForm" class="inline-form"><input name="label" placeholder="e.g. Claude Desktop" maxlength="60"><button class="primary">Create token</button></form>
        <div id="tokOut"></div>
      </section>
    </div>
    <section class="panel narrow"><header><h3>Your password</h3></header>
      <form id="pwForm" class="inline-form"><input name="current" type="password" placeholder="Current password" autocomplete="current-password" required><input name="next" type="password" placeholder="New password (10+ characters)" autocomplete="new-password" minlength="10" required><button class="ghost">Change</button></form>
      <p class="small" id="pwOut"></p>
    </section>`;
  const reload = () => renderTeam(routeSeq);
  $$("[data-rm]").forEach((b) => b.addEventListener("click", async () => { if (confirm("Remove this person? Their tokens stop working.")) { await api(`/api/team/members/${b.dataset.rm}`, { method: "DELETE" }); reload(); } }));
  $$("[data-revoke]").forEach((b) => b.addEventListener("click", async () => { await api(`/api/team/invites/${b.dataset.revoke}`, { method: "DELETE" }); reload(); }));
  $$("[data-tok]").forEach((b) => b.addEventListener("click", async () => { if (confirm("Revoke this token? Anything using it stops working.")) { await api(`/api/tokens/${b.dataset.tok}`, { method: "DELETE" }); reload(); } }));
  $("#invForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try {
      const r = await api("/api/team/invites", { method: "POST", body: JSON.stringify(f) });
      $("#invOut").innerHTML = `<div class="secret"><p>Send this link to <b>${esc(r.email)}</b>. It works once, for ${r.expiresInDays} days.</p><code>${esc(r.link)}</code><button class="ghost" type="button" data-copy="${esc(r.link)}">Copy</button></div>`;
      wireCopy();
    } catch (err) { $("#invOut").innerHTML = `<p class="error">${esc(err.message)}</p>`; }
  });
  $("#tokForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const r = await api("/api/tokens", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(e.target))) });
      $("#tokOut").innerHTML = `<div class="secret"><p>Copy it now. You won't see it again.</p><code>${esc(r.token)}</code><button class="ghost" type="button" data-copy="${esc(r.token)}">Copy</button>
        <details><summary>Claude MCP config</summary><pre>${esc(JSON.stringify({ mcpServers: { dealflow: { type: "http", url: `${location.origin}/mcp`, headers: { Authorization: `Bearer ${r.token}` } } } }, null, 2))}</pre></details></div>`;
      wireCopy();
    } catch (err) { $("#tokOut").innerHTML = `<p class="error">${esc(err.message)}</p>`; }
  });
  $("#pwForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try { await api("/api/me/password", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(e.target))) }); $("#pwOut").textContent = "Changed. Other devices have been signed out."; e.target.reset(); }
    catch (err) { $("#pwOut").textContent = err.message; }
  });
}

function wireCopy() {
  $$("[data-copy]").forEach((b) => (b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = "Copied"; } catch { b.textContent = "Select and copy"; } }));
}

async function renderAdmin(seq) {
  renderSearches();
  const d = await api("/api/admin");
  if (stale(seq)) return;
  const planOpts = (sel) => Object.entries(d.plans).filter(([id]) => id !== "admin" || sel === "admin").map(([id, p]) => `<option value="${id}" ${id === sel ? "selected" : ""}>${esc(p.label)}${p.price ? ` · $${fmt(p.price)}/mo` : ""}</option>`).join("");
  $("#view").innerHTML = `
    <header class="page-head"><div><h1>Admin</h1><p class="muted">Buyer accounts, plans and the territory map.</p></div></header>
    <section class="stats admin-kpis">
      <div class="stat"><span>paying accounts</span><b>${fmt(d.accounts.filter((a) => a.plan !== "admin" && a.active).length)}</b></div>
      <div class="stat"><span>monthly recurring</span><b>$${fmt(d.mrr)}</b></div>
      <div class="stat"><span>territories held</span><b>${fmt(d.territories.length)}</b></div>
    </section>
    <section class="table-card"><div class="table-meta"><b>Accounts</b></div><div class="table-wrap"><table class="admin-table">
      <thead><tr><th>Account</th><th>Owner</th><th>Plan</th><th>Territories</th><th>Users</th><th>Pipeline</th><th>Active</th><th></th></tr></thead>
      <tbody>${d.accounts.map((a) => `<tr data-acct="${a.id}">
        <td><b>${esc(a.name)}</b><small class="muted"> #${a.id}</small></td>
        <td>${esc(a.owners || (a.open_invites ? "invite sent" : "–"))}</td>
        <td><select data-f="plan" ${a.plan === "admin" ? "disabled" : ""}>${planOpts(a.plan)}</select></td>
        <td>${a.territories} / <input data-f="maxTerritories" type="number" min="0" max="999" value="${a.max_territories}" class="num-in"></td>
        <td>${a.users}</td><td>${a.pipeline}</td>
        <td><input data-f="active" type="checkbox" ${a.active ? "checked" : ""} ${a.id === 1 ? "disabled" : ""}></td>
        <td><button class="link" data-inv="${a.id}" type="button">New owner link</button></td></tr>`).join("")}</tbody></table></div></section>
    <div class="grid2">
      <section class="panel"><header><h3>New buyer account</h3></header>
        <form id="acctForm" class="stack-form">
          <label>Company<input name="name" required placeholder="Northstar Holdings"></label>
          <label>Owner email<input name="ownerEmail" type="email" required placeholder="jane@northstar.com"></label>
          <label>Plan<select name="plan">${planOpts("operator")}</select></label>
          <button class="primary">Create and get invite link</button>
        </form><div id="acctOut"></div>
      </section>
      <section class="panel"><header><h3>Assign a territory</h3></header>
        <label>Account<select id="asAcct">${d.accounts.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join("")}</select></label>
        <div id="asPicker"></div>
        <div class="claim-foot"><span id="asState" class="avail"></span><button class="primary" id="asBtn" type="button">Assign</button></div>
      </section>
    </div>
    <section class="table-card"><div class="table-meta"><b>Territory map</b><span>${d.territories.length} held</span></div><div class="table-wrap"><table>
      <thead><tr><th>Territory</th><th>Country</th><th>Held by</th><th>Since</th><th></th></tr></thead>
      <tbody>${d.territories.map((t) => `<tr><td><b>${esc(t.label)}</b></td><td>${country(t.country)?.flag || ""} ${esc(t.country.toUpperCase())}</td><td>${esc(t.account_name)}</td><td>${new Date(t.created_at).toLocaleDateString()}</td>
        <td><button class="link danger" data-unassign="${t.id}" type="button">Remove</button></td></tr>`).join("") || `<tr><td colspan="5" class="muted">No territories assigned yet.</td></tr>`}</tbody></table></div></section>`;
  const reload = () => renderAdmin(routeSeq);
  $$("tr[data-acct]").forEach((tr) => $$("[data-f]", tr).forEach((x) => x.addEventListener("change", async () => {
    const v = x.type === "checkbox" ? x.checked : x.type === "number" ? Number(x.value) : x.value;
    try { await api(`/api/admin/accounts/${tr.dataset.acct}`, { method: "PATCH", body: JSON.stringify({ [x.dataset.f]: v }) }); if (x.dataset.f === "plan") reload(); } catch (e) { alert(e.message); reload(); }
  })));
  $$("[data-inv]").forEach((b) => b.addEventListener("click", async () => {
    const email = prompt("Owner's email (leave empty for an open link):") ?? null;
    if (email === null) return;
    try { const r = await api(`/api/admin/accounts/${b.dataset.inv}/invite`, { method: "POST", body: JSON.stringify({ email }) }); prompt("Invite link (works once, 7 days):", r.link); } catch (e) { alert(e.message); }
  }));
  $$("[data-unassign]").forEach((b) => b.addEventListener("click", async () => { if (confirm("Remove this territory from the account?")) { await api(`/api/admin/territories/${b.dataset.unassign}`, { method: "DELETE" }); reload(); } }));
  $("#acctForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const r = await api("/api/admin/accounts", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(e.target))) });
      $("#acctOut").innerHTML = `<div class="secret"><p>${esc(r.account.name)} created. Send this to ${esc(r.invite.email)}:</p><code>${esc(r.invite.link)}</code><button class="ghost" type="button" data-copy="${esc(r.invite.link)}">Copy</button><p class="small"><a href="#/admin" id="acctDone">Done, refresh the list</a></p></div>`;
      wireCopy();
      $("#acctDone").addEventListener("click", (ev) => { ev.preventDefault(); reload(); });
    } catch (err) { $("#acctOut").innerHTML = `<p class="error">${esc(err.message)}</p>`; }
  });
  const st = { country: "fr", industry: "hvac", region: "" };
  areaPicker($("#asPicker"), st, () => { $("#asState").textContent = ""; });
  $("#asBtn").addEventListener("click", async () => {
    try { await api("/api/admin/territories", { method: "POST", body: JSON.stringify({ ...st, accountId: Number($("#asAcct").value) }) }); reload(); }
    catch (e) { $("#asState").className = "avail no"; $("#asState").textContent = e.message; }
  });
}
