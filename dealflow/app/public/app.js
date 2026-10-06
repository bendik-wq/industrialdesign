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
      <span class="flag">${country(s.country)?.flag || ""}</span>
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
        <option value="owner_age">Oldest owner</option><option value="founded">Oldest company</option><option value="staff">Most staff</option><option value="name">Name</option>
      </select></label>
    </section>
    <section class="table-card">
      <div class="table-wrap"><table>
        <thead><tr><th>Company</th><th>Owner</th><th class="num">Founded</th><th class="num">Staff</th><th class="num">Revenue</th><th>Verdict</th><th>Status</th></tr></thead>
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
        <td class="co"><b>${esc(r.name)}</b><small>${esc([r.city, r.legal_form].filter(Boolean).join(" · "))}${searchId ? "" : ` · ${country(r.country)?.flag || ""}`}</small></td>
        <td>${r.owner_name ? `${esc(r.owner_name)}${r.owner_age != null ? ` <span class="age ${r.owner_age >= 60 ? "old" : ""}">${r.owner_age}</span>` : ""}` : '<span class="muted">Not published</span>'}</td>
        <td class="num">${r.founded ?? "–"}</td>
        <td class="num">${esc(r.employees_band ?? (r.reviews != null ? `${fmt(r.reviews)} reviews` : "–"))}</td>
        <td class="num">${money(r.revenue, r.currency)}</td>
        <td><span class="pill ${VCLASS[r.verdict]}">${esc(r.verdict)}</span> <span class="fit">${r.fit_score}</span></td>
        <td class="status ${r.status !== "New" ? "active" : ""}">${esc(r.status)}</td>
      </tr>`).join("") || `<tr><td colspan="7" class="empty">${s && s.status !== "done" && s.status !== "failed" ? "Companies will appear here as the search runs…" : "No companies match these filters."}</td></tr>`;
    const pages = Math.max(1, Math.ceil(data.total / 50));
    $("#pageInfo").textContent = `${fmt(data.total)} companies · page ${listState.page} of ${fmt(pages)}`;
    $("#prev").disabled = listState.page <= 1;
    $("#next").disabled = listState.page >= pages;
  };
  const updateProgress = async () => {
    if (!s) { $("#sub").textContent = "Every company from every search, best fit first."; return; }
    const cur = await api(`/api/searches/${searchId}`);
    const c = country(cur.country);
    $("#sub").textContent = `Source: ${c?.label} official data${cur.total != null ? ` · ${fmt(cur.total)} registered matches` : ""} · searched ${new Date(cur.created_at).toLocaleDateString()}`;
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
  $$("#exportMenu a").forEach((a) => a.addEventListener("click", () => { const p = qs(); p.set("format", a.dataset.f); location.href = `/api/export.csv?${p}`; }));
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
      <div class="tabs">${["letter", "email", "call"].map((t, i) => `<button type="button" data-t="${t}" aria-selected="${i === 0}">${{ letter: "Letter", email: "Email sequence", call: "Call script" }[t]}</button>`).join("")}</div>
      <div class="draft" id="draft"></div>
      <div class="draft-actions"><span id="draftNote" class="muted small"></span><button class="ghost" id="copy" type="button">Copy</button></div>
    </div>`;

  const show = (t) => {
    $$(".tabs button").forEach((b) => b.setAttribute("aria-selected", b.dataset.t === t));
    const d = drafts(c, settings())[t];
    $("#draft").textContent = d.text;
    $("#draftNote").textContent = d.note;
  };
  $$(".tabs button").forEach((b) => b.addEventListener("click", () => show(b.dataset.t)));
  show("letter");
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
  const letter = `Dear ${first},

My name is ${me}. ${angle}, and I'm writing to a small number of owners whose companies I genuinely respect.

${c.name} has served ${where} ${tenure}. A reputation like that takes decades to build, and I'd like to help make sure it lasts.

If you've thought about what happens to the business when you step back — retirement, slowing down, or taking some value off the table — I'd welcome a confidential conversation. No brokers and no pressure. We keep the name and the team, and we can structure things so you're paid well over time and stay as involved as you like.

If now isn't the time, please keep this letter. I'll be in touch again in a few months.

Warm regards,
${me}
${co}
${phone} · ${email}`;
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
