import { $, $$, esc, api, post, view, stale, toast, fail, local, skeleton } from "../core.js";
import { money } from "../deal.js";

// Scout: search registries and maps, tick the companies worth buying, add them to the pipeline in one go.
// Deep enrich imported targets one at a time (each takes 10-40s and costs a few cents), with live progress.
async function deepRun(ids) {
  let done = 0, emails = 0, spent = 0;
  const bar = document.createElement("div");
  bar.className = "progress-toast"; document.body.append(bar);
  const show = () => { bar.textContent = `Deep enrich: ${done}/${ids.length} · ${emails} owner email${emails === 1 ? "" : "s"} · $${spent.toFixed(2)}`; };
  show();
  for (const id of ids) {
    try {
      await post(`/api/targets/${id}/contacts/find`).catch(() => {});
      const r = await post(`/api/targets/${id}/enrich`, {});
      if (r.owner_email) emails++; spent += r.cost_usd || 0;
    } catch (e) { if (e.status === 402) { fail(e); break; } }
    done++; show();
  }
  setTimeout(() => bar.remove(), 6000);
  toast(`Deep enrich finished: ${emails} owner email${emails === 1 ? "" : "s"} for $${spent.toFixed(2)}`);
}

export async function renderScout(seq) {
  view().innerHTML = skeleton(4);
  const info = await api("/api/scout");
  if (stale(seq)) return;
  const last = local.get("scout", { source: "maps", industry: "hvac", region: "", min_staff: 0 });
  let state = { ...last, page: 1, cursor: null, results: [], currency: "$", more: false, total: null };
  view().innerHTML = `
    <header class="page-head"><p class="eyebrow">Scout</p><h1>Find the owners. Get the numbers.</h1>
      <p class="lede">Search official company registries and maps for businesses you could buy: owners and their ages, emails, phones, websites, revenue. Tick the ones worth a letter and add them to your pipeline; the contact finder can read each website for more.</p></header>
    <form class="panel scout-form" id="sf">
      <label class="field">Source<select name="source">${info.sources.map((s) => `<option value="${s.id}" ${s.id === state.source ? "selected" : ""}>${s.flag} ${esc(s.label)}${s.ready ? "" : " (needs a key)"}</option>`).join("")}</select></label>
      <label class="field">Industry<select name="industry">${info.industries.map((i) => `<option value="${i.id}" ${i.id === state.industry ? "selected" : ""}>${esc(i.label)}</option>`).join("")}</select></label>
      <label class="field" id="regionField"></label>
      <label class="field">Min. staff<input name="min_staff" type="number" min="0" value="${state.min_staff || 0}"></label>
      <button class="primary" type="submit">Search</button>
      <p class="muted small scout-gives" id="gives"></p>
    </form>
    <div id="results"></div>`;
  const form = $("#sf");
  const source = () => info.sources.find((s) => s.id === form.source.value);
  const drawRegion = () => {
    const s = source();
    $("#regionField").innerHTML = `${esc(s.regionLabel)}${Array.isArray(s.regions) ? `<select name="region"><option value="">All of ${esc(s.label)}</option>${s.regions.map((r) => `<option value="${r.code}" ${r.code === state.region ? "selected" : ""}>${esc(r.name)}</option>`).join("")}</select>` : `<input name="region" value="${esc(Array.isArray(s.regions) ? "" : state.region || "")}" placeholder="e.g. Austin, TX">`}`;
    $("#gives").innerHTML = `${s.flag} ${s.gives.map(esc).join(" · ")}${s.ready ? "" : ` · <a href="#/settings/integrations">Connect the key →</a>`}`;
  };
  drawRegion();
  form.source.addEventListener("change", () => { state.region = ""; drawRegion(); });

  const search = async (more = false) => {
    const f = Object.fromEntries(new FormData(form));
    if (!more) { state = { ...state, ...f, page: 1, cursor: null, results: [] }; local.set("scout", { source: f.source, industry: f.industry, region: f.region, min_staff: f.min_staff }); }
    const btn = more ? $("#more") : $("button[type=submit]", form);
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = "Searching…";
    if (!more) $("#results").innerHTML = skeleton(5);
    try {
      const r = await post("/api/scout/search", { source: state.source, industry: state.industry, region: state.region, min_staff: state.min_staff, page: state.page, cursor: state.cursor });
      state.results.push(...r.results); state.more = r.more; state.total = r.total; state.currency = r.currency; state.cursor = r.cursor || null;
      drawResults();
    } catch (e) { fail(e); if (!more) $("#results").innerHTML = ""; }
    btn.disabled = false; btn.textContent = label;
  };
  form.addEventListener("submit", (e) => { e.preventDefault(); search(false); });

  const drawResults = () => {
    const rows = state.results, c = state.currency;
    if (!rows.length) { $("#results").innerHTML = `<div class="empty"><h2>Nothing found</h2><p class="muted">Try another region, a lower staff minimum, or another source.</p></div>`; return; }
    const withEmail = rows.filter((r) => r.email).length, withPhone = rows.filter((r) => r.phone).length, withOwner = rows.filter((r) => r.owner_name).length;
    $("#results").innerHTML = `
      <div class="toolbar scout-bar">
        <span class="muted small">${state.total != null ? `${state.total} matches · ` : ""}showing ${rows.length} · ${withOwner} with an owner · ${withEmail} with email · ${withPhone} with phone</span>
        <span class="spacer"></span>
        <label class="check"><input type="checkbox" id="findC" checked> Find contacts on their websites</label>
        ${info.monid ? `<label class="check" title="Owner email (verified) + LinkedIn via Monid, about $0.05–0.08 each"><input type="checkbox" id="deepC"> Deep enrich owners (~$0.06 each)</label>` : ""}
        <button class="primary" id="addSel" type="button" disabled>Add 0 to pipeline</button>
      </div>
      <div class="table-wrap panel flush"><table class="ttable scout-table">
        <thead><tr><th><input type="checkbox" id="all" aria-label="Select all"></th><th>Company</th><th>Owner</th><th>Contact</th><th class="num">Revenue</th><th class="num">Op. profit</th><th class="num">${state.source === "maps" || state.source === "places" ? "Rating" : "Staff"}</th></tr></thead>
        <tbody>${rows.map((r, i) => `<tr class="${r.in_pipeline ? "dim" : ""}">
          <td><input type="checkbox" data-i="${i}" ${r.in_pipeline ? "disabled" : ""} aria-label="Select ${esc(r.name)}"></td>
          <td><b>${esc(r.name)}</b>${r.in_pipeline ? ' <span class="chip">in pipeline</span>' : ""}<small class="muted block">${esc(r.location || "")}${r.registry_url ? ` · <a href="${esc(r.registry_url)}" target="_blank" rel="noopener noreferrer">record</a>` : ""}${r.website ? ` · <a href="${esc(r.website)}" target="_blank" rel="noopener noreferrer">website</a>` : ""}</small></td>
          <td>${r.owner_name ? `${esc(r.owner_name)}${r.owner_age ? ` <span class="age ${r.owner_age >= 60 ? "old" : ""}">${r.owner_age}</span>` : ""}` : '<span class="muted">–</span>'}</td>
          <td class="small">${r.email ? `<a href="mailto:${esc(r.email)}">${esc(r.email)}</a>` : ""}${r.email && r.phone ? "<br>" : ""}${r.phone ? `<a href="tel:${esc(r.phone.replace(/\s/g, ""))}">${esc(r.phone)}</a>` : ""}${!r.email && !r.phone ? '<span class="muted">find after import</span>' : ""}</td>
          <td class="num">${r.revenue != null ? money(r.revenue, c) : "–"}</td><td class="num ${r.ebitda < 0 ? "tone-bad" : ""}">${r.ebitda != null ? money(r.ebitda, c) : "–"}</td><td class="num">${r.employees ?? r.employees_label ?? (r.rating ? `★${r.rating} <small class="muted">(${r.reviews})</small>` : "–")}</td></tr>`).join("")}</tbody></table></div>
      ${state.more ? `<div class="center-row row"><button class="ghost" id="more" type="button">Load more</button></div>` : ""}
      <p class="muted small">Owner age is from the registry's birth year. 60+ is highlighted: the classic succession window. Operating profit is as filed (EBIT), a floor for EBITDA.</p>`;
    const boxes = () => $$("[data-i]:checked");
    const sync = () => { const n = boxes().length; $("#addSel").disabled = !n; $("#addSel").textContent = `Add ${n} to pipeline`; };
    $$("[data-i]").forEach((b) => b.addEventListener("change", sync));
    $("#all").addEventListener("change", (e) => { $$("[data-i]:not(:disabled)").forEach((b) => { b.checked = e.target.checked; }); sync(); });
    $("#more")?.addEventListener("click", () => { state.page += 1; search(true); });
    $("#addSel").addEventListener("click", async (e) => {
      const picked = boxes().map((b) => rows[+b.dataset.i]);
      e.currentTarget.disabled = true; e.currentTarget.textContent = "Adding…";
      try {
        const deep = !!$("#deepC")?.checked;
        const r = await post("/api/scout/import", { companies: picked, currency: state.currency, find_contacts: $("#findC").checked && !deep });
        picked.forEach((p) => { p.in_pipeline = true; });
        toast(`Added ${r.imported} to the pipeline${deep ? ". Deep-enriching the owners one by one; keep this tab open." : $("#findC").checked ? ". The contact finder is reading their websites now." : ""}`);
        drawResults();
        if (deep) deepRun(r.ids || []);
      } catch (err) { fail(err); sync(); }
    });
  };
}
