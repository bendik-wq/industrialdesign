// Territory: the densification map. Add the places you operate (and how far each one services), see how big each
// area is, how much of the known market in it you own, and where the next deal should go to build a local
// monopoly. The maths is public/js/territory.js (same code the API uses); this file draws it.
import { $, $$, esc, api, post, toast, fail, view, stale, session, dialog, confirmBox, skeleton } from "../core.js";
import { plan, tilesFor, preparePlaces, KINDS } from "../territory.js";

const tileCache = new Map();
const fmtN = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n || 0)));
const fmtKm2 = (n) => (n >= 1e4 ? `${fmtN(n)}` : Math.round(n).toLocaleString());
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim() || "#ff5b1f";
const kindColor = (k) => ({ tuckin: css("--good"), extend: css("--signal"), arm: css("--muted"), first: css("--signal") })[k] || css("--muted");

let leafletReady = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  if (leafletReady) return leafletReady;
  leafletReady = new Promise((ok, no) => {
    const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "/vendor/leaflet-1.9.4.css"; document.head.append(l);
    const s = document.createElement("script"); s.src = "/vendor/leaflet-1.9.4.js"; s.onload = ok; s.onerror = () => no(new Error("The map didn't load. Check your connection and try again.")); document.head.append(s);
  });
  return leafletReady;
}
async function placesFor(circles, padKm) {
  const keys = tilesFor(circles, padKm).slice(0, 40);
  await Promise.all(keys.filter((k) => !tileCache.has(k)).map((k) => fetch(`/geo/${k}.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []).then((rows) => tileCache.set(k, rows))));
  return preparePlaces(keys.flatMap((k) => tileCache.get(k) || []));
}

export async function renderTerritory(seq, params) {
  view().innerHTML = skeleton(4);
  let [data] = await Promise.all([api("/api/territory"), loadLeaflet()]);
  if (stale(seq)) return;
  const L = window.L;
  let tab = ["next", "sites", "space"].includes(params.get("tab")) ? params.get("tab") : "next";
  let result = null, placing = false, focusLayer = null;

  view().innerHTML = `
    <header class="page-head with-actions">
      <div><p class="eyebrow">Densification · the Monopoly Method</p><h1>Territory</h1>
        <p class="lede muted">“Pick fragmented vertical in large metro area”, then buy the operators around you. Add where you operate and how far each site services, and the map shows how big each area is, how much of it you own, and where the next deal builds the local monopoly.</p></div>
      <div class="row"><label class="field compact">Radius for a business you'd buy<span class="unit-input"><input id="defR" type="number" min="1" max="300" step="1" value="${data.radius_km}"> km</span></label></div>
    </header>
    <div class="kpis four" id="kpis"></div>
    <p class="muted small terr-milestone" id="milestone"></p>
    <div class="terr-bar">
      <form id="find" class="terr-find" autocomplete="off"><input name="q" type="search" placeholder="Add a site: address, suburb or town" aria-label="Find a place to add as a site"><button class="primary" type="submit">Find</button><div class="terr-results" id="found" hidden></div></form>
      <button class="ghost" id="placeBtn" type="button" aria-pressed="false">Click the map to place a site</button>
    </div>
    <p class="banner" id="geoNote" hidden></p>
    <div class="terr-grid">
      <div class="terr-map" id="map" role="application" aria-label="Territory map"></div>
      <aside class="terr-side">
        <nav class="tabs terr-tabs">${[["next", "Next deal"], ["sites", "Sites"], ["space", "White space"]].map(([k, l]) => `<a href="#" data-tab="${k}" class="${k === tab ? "on" : ""}">${l}</a>`).join("")}</nav>
        <div id="pane"></div>
      </aside>
    </div>
    <p class="muted small terr-legend"><span class="dot-k" style="--k:${kindColor("tuckin")}"></span> Tuck-in · <span class="dot-k" style="--k:${kindColor("extend")}"></span> Extend · <span class="dot-k" style="--k:${kindColor("arm")}"></span> New arm · Population ≈ from GeoNames (CC BY 4.0), places of 1,000+ people. Local share counts the operators in your pipeline.</p>`;

  // ---------------------------------------------------------------- map
  const map = L.map("map", { zoomControl: true, worldCopyJump: true }).setView([-25, 134], 4);
  map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
  // OpenStreetMap's standard tiles, toned to the app's greys by CSS (inverted in dark mode).
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · Population: <a href="https://www.geonames.org/">GeoNames</a>' }).addTo(map);
  const layers = { sites: L.layerGroup().addTo(map), targets: L.layerGroup().addTo(map), space: L.layerGroup().addTo(map) };
  let fitted = false;

  const sitesOnMap = () => data.sites;
  const targetsForPlan = () => data.targets.filter((t) => !t.site && t.lat != null);

  async function compute() {
    const sites = sitesOnMap(), targets = targetsForPlan(), r = data.radius_km;
    const circles = [...sites, ...targets.map((t) => ({ lat: t.lat, lng: t.lng, radius_km: r }))];
    const places = circles.length ? await placesFor(circles, Math.max(r, ...sites.map((s) => s.radius_km)) * 4) : [];
    result = plan({ sites, targets, places, radiusKm: r });
    draw();
  }

  function draw() {
    const s = result.summary;
    $("#kpis").innerHTML = `
      <div class="kpi ${s.sites ? "accent" : ""}"><span>Footprint</span><b>${fmtKm2(s.areaKm2)}<small> km²</small></b><small>${s.sites} site${s.sites === 1 ? "" : "s"} you service from</small></div>
      <div class="kpi"><span>People in reach</span><b>≈ ${fmtN(s.people)}</b><small>Inside your service areas</small></div>
      <div class="kpi ${s.share >= 0.5 ? "accent" : ""}"><span>Local share</span><b>${s.sites ? Math.round(s.share * 100) : 0}%</b><small>${s.owned} of ${s.operators} known operators in your footprint</small></div>
      <div class="kpi"><span>Regions (arms)</span><b>${s.arms}</b><small>${s.arms > 1 ? "Each region runs as its own arm" : "One region: keep densifying it"}</small></div>`;
    const owned = data.sites.length, next = owned < 10 ? 10 : owned < 50 ? 50 : 100;
    $("#milestone").textContent = `${owned} site${owned === 1 ? "" : "s"} on the map. Milestones: “10 businesses = 1% market share → $5-10M exit”, “50 businesses = 5% market share → $40-80M exit”. Next mark: ${next}.`;

    layers.sites.clearLayers(); layers.targets.clearLayers(); layers.space.clearLayers();
    const sig = css("--signal");
    for (const site of data.sites) {
      L.circle([site.lat, site.lng], { radius: site.radius_km * 1000, color: sig, weight: 1.5, fillColor: sig, fillOpacity: 0.12, interactive: false }).addTo(layers.sites);
      const m = L.marker([site.lat, site.lng], { draggable: true, keyboard: true, title: site.name, icon: L.divIcon({ className: "terr-site", html: "<span></span>", iconSize: [18, 18] }) }).addTo(layers.sites);
      m.bindTooltip(esc(site.name), { direction: "top", offset: [0, -10] });
      m.on("dragend", async () => {
        const p = m.getLatLng().wrap();
        try { Object.assign(site, await post(`/api/territory/sites/${site.id}`, { lat: p.lat, lng: p.lng }, "PATCH")); compute(); } catch (e) { fail(e); compute(); }
      });
      m.on("click", () => { tab = "sites"; pane(); setTimeout(() => $(`#site-${site.id}`)?.scrollIntoView({ block: "nearest" }), 0); });
    }
    const rank = new Map(result.ranked.map((r, i) => [r.id, i + 1]));
    for (const t of targetsForPlan()) {
      const r = result.ranked.find((x) => x.id === t.id);
      const color = kindColor(r?.kind);
      const n = rank.get(t.id);
      const marker = n <= 5
        ? L.marker([t.lat, t.lng], { title: t.name, icon: L.divIcon({ className: "terr-rank", html: `<span style="--k:${color}">${n}</span>`, iconSize: [24, 24] }) })
        : L.circleMarker([t.lat, t.lng], { radius: 6, color, weight: 2, fillColor: color, fillOpacity: 0.7 });
      marker.bindPopup(popup(t, r)).addTo(layers.targets);
      marker.on("popupopen", () => focus(t.lat, t.lng, r?.kind));
    }
    for (const w of result.whitespace) L.circle([w.lat, w.lng], { radius: data.radius_km * 1000, color: css("--ink-2"), weight: 1, dashArray: "4 6", fill: false, interactive: false }).addTo(layers.space);
    if (!fitted) {
      // Frame your territory: sites plus the targets around them (far-away ones are still on the map when you zoom out).
      const reach = Math.max(data.radius_km, ...data.sites.map((x) => x.radius_km)) * 4;
      const near = (t) => !data.sites.length || data.sites.some((x) => map.distance([x.lat, x.lng], [t.lat, t.lng]) / 1000 <= reach);
      const pts = [...data.sites.map((x) => [x.lat, x.lng]), ...targetsForPlan().filter(near).map((t) => [t.lat, t.lng])];
      if (pts.length) { map.fitBounds(L.latLngBounds(pts).pad(0.25), { maxZoom: 11 }); fitted = true; }
    }
    pane();
  }

  function popup(t, r) {
    return `<div class="terr-pop"><b><a href="#/targets/${t.id}">${esc(t.name)}</a></b><br><span class="muted">${esc(t.location || "")}</span>
      ${r ? `<p><span class="chip" style="margin:0">${esc(KINDS[r.kind].label)}</span> <b>${r.score}</b>/100</p><ul>${r.why.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}</div>`;
  }
  function focus(lat, lng, kind) {
    if (focusLayer) map.removeLayer(focusLayer);
    focusLayer = L.circle([lat, lng], { radius: data.radius_km * 1000, color: kindColor(kind), weight: 1.5, dashArray: "6 6", fillOpacity: 0.05, interactive: false }).addTo(map);
  }

  // ---------------------------------------------------------------- side panel
  function pane() {
    $$(".terr-tabs a").forEach((a) => a.classList.toggle("on", a.dataset.tab === tab));
    const el = $("#pane");
    if (tab === "next") {
      if (!result.ranked.length) { el.innerHTML = `<div class="empty small"><p>No open targets on the map yet.</p><p class="muted">Give targets a location (suburb and city) in the <a href="#/pipeline">pipeline</a>, or find operators with <a href="#/scout">Scout</a>.</p></div>`; return; }
      el.innerHTML = `${data.sites.length ? "" : `<p class="muted small">Add your first site to see tuck-ins and extensions. Until then, targets rank by the size of their metro, their numbers and how far along they are.</p>`}
        <ol class="terr-list">${result.ranked.slice(0, 20).map((r, i) => `<li><button type="button" class="terr-item" data-t="${r.id}">
          <span class="terr-n" style="--k:${kindColor(r.kind)}">${i + 1}</span>
          <span class="terr-body"><b>${esc(r.name)}</b> <span class="chip">${esc(KINDS[r.kind].label)}</span><span class="terr-score">${r.score}</span>
          <small class="muted">${esc(r.why[0])}</small></span></button></li>`).join("")}</ol>
        <p class="muted small">Score: fit with your footprint 35%, size 25%, new people in reach 20%, how far along the deal is 20%. ${esc(KINDS.tuckin.text)}</p>`;
      $$(".terr-item", el).forEach((b) => b.addEventListener("click", () => {
        const t = data.targets.find((x) => x.id === +b.dataset.t);
        map.flyTo([t.lat, t.lng], Math.max(map.getZoom(), 10), { duration: 0.6 });
        layers.targets.eachLayer((m) => { const ll = m.getLatLng(); if (ll.lat === t.lat && ll.lng === t.lng) m.openPopup(); });
      }));
    } else if (tab === "sites") {
      const closed = data.targets.filter((t) => t.stage === "closed" && !t.site);
      el.innerHTML = `${data.sites.length ? "" : `<p class="muted small">No sites yet. Find an address above, or click “Click the map to place a site”.</p>`}
        <ul class="terr-sites">${data.sites.map((s) => { const m = result.sites.find((x) => x.id === s.id) || {}; return `<li id="site-${s.id}">
          <div class="row-between"><b>${esc(s.name)}</b><span class="row"><button class="link" type="button" data-rename="${s.id}">Rename</button><button class="link danger" type="button" data-del="${s.id}">Remove</button></span></div>
          <label class="terr-radius">Services <input type="range" min="1" max="100" step="1" value="${Math.min(100, s.radius_km)}" data-r="${s.id}" aria-label="Service radius for ${esc(s.name)}"> <output>${s.radius_km} km</output></label>
          <small class="muted">${fmtKm2(m.areaKm2 || 0)} km² · ≈ ${fmtN(m.people)} people · ${m.operators || 0} known operator${m.operators === 1 ? "" : "s"} inside${m.overlap ? ` · ${m.overlap}% shared with your other sites` : ""}</small></li>`; }).join("")}</ul>
        ${result.arms.length > 1 ? `<h3 class="terr-h">Regions</h3><ul class="terr-arms">${result.arms.map((a) => `<li><b>${esc(a.name)}</b><small class="muted">${fmtKm2(a.areaKm2)} km² · ≈ ${fmtN(a.people)} people · you own ${a.owned} of ${a.operators} known operators (${Math.round(a.pct * 100)}%)</small></li>`).join("")}</ul>` : ""}
        ${closed.length ? `<h3 class="terr-h">Closed deals not on the map</h3><ul class="terr-sites">${closed.map((t) => `<li class="row-between"><span>${esc(t.name)}<small class="muted"> ${esc(t.location || "no location")}</small></span>${t.lat != null ? `<button class="ghost small" type="button" data-own="${t.id}">Add as site</button>` : `<a class="link" href="#/targets/${t.id}">Add a location</a>`}</li>`).join("")}</ul>` : ""}`;
      let timer;
      $$("[data-r]", el).forEach((inp) => inp.addEventListener("input", () => {
        const s = data.sites.find((x) => x.id === +inp.dataset.r);
        s.radius_km = +inp.value; inp.nextElementSibling.textContent = `${s.radius_km} km`;
        clearTimeout(timer);
        timer = setTimeout(async () => { compute(); try { await post(`/api/territory/sites/${s.id}`, { radius_km: s.radius_km }, "PATCH"); } catch (e) { fail(e); } }, 250);
      }));
      $$("[data-del]", el).forEach((b) => b.addEventListener("click", async () => {
        const s = data.sites.find((x) => x.id === +b.dataset.del);
        if (!(await confirmBox("Remove this site?", `${s.name} comes off the map. Targets and deals aren't touched.`, "Remove"))) return;
        try { await api(`/api/territory/sites/${s.id}`, { method: "DELETE" }); data.sites = data.sites.filter((x) => x !== s); compute(); } catch (e) { fail(e); }
      }));
      $$("[data-rename]", el).forEach((b) => b.addEventListener("click", async () => {
        const s = data.sites.find((x) => x.id === +b.dataset.rename);
        const f = await dialog({ title: "Rename site", html: `<label class="field">Name<input name="name" maxlength="120" required value="${esc(s.name)}"></label>` });
        if (!f) return;
        try { Object.assign(s, await post(`/api/territory/sites/${s.id}`, { name: f.name }, "PATCH")); draw(); } catch (e) { fail(e); }
      }));
      $$("[data-own]", el).forEach((b) => b.addEventListener("click", async () => {
        const t = data.targets.find((x) => x.id === +b.dataset.own);
        try { data.sites.push(await post("/api/territory/sites", { name: t.name, address: t.location, lat: t.lat, lng: t.lng, target_id: t.id })); t.site = true; compute(); toast(`${t.name} is on the map`); } catch (e) { fail(e); }
      }));
    } else {
      el.innerHTML = !data.sites.length ? `<p class="muted small">Add a site first. White space is the towns near your footprint with nobody in your pipeline yet.</p>`
        : !result.whitespace.length ? `<p class="muted small">No big gaps near your footprint: every sizeable town around you already has a target in the pipeline.</p>`
        : `<p class="muted small">Towns of 5,000+ near your footprint with no operator in your pipeline yet. Find the owners there next.</p>
          <ul class="terr-sites">${result.whitespace.map((w) => `<li><div class="row-between"><b>${esc(w.name)}</b><a class="ghost small" href="#/scout?region=${encodeURIComponent(w.name)}">Scout here</a></div>
            <small class="muted">Adds ≈ ${fmtN(w.people)} people · ${w.nearestKm} km from ${esc(w.nearest)}${w.adjacent ? " · next to your footprint" : " · a new region"}</small></li>`).join("")}</ul>`;
    }
  }
  $$(".terr-tabs a").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); tab = a.dataset.tab; pane(); }));

  // ---------------------------------------------------------------- adding sites
  async function addSite(lat, lng, suggested = "", address = "") {
    const f = await dialog({ title: "Add a site", html: `<label class="field">Name<input name="name" maxlength="120" required value="${esc(suggested)}" placeholder="e.g. Parramatta depot"></label>
      <label class="field">Service radius (km)<input name="radius_km" type="number" min="1" max="300" step="1" value="${data.radius_km}"></label>
      <p class="muted small">How far your team travels from here to do a job.</p>` });
    if (!f) return;
    try { data.sites.push(await post("/api/territory/sites", { name: f.name, address, lat, lng, radius_km: +f.radius_km })); fitted = false; await compute(); toast("Site added"); } catch (e) { fail(e); }
  }
  $("#find").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = e.target.q.value.trim(), box = $("#found");
    if (!q) return;
    box.hidden = false; box.innerHTML = `<p class="muted small">Searching…</p>`;
    try {
      const { results } = await api(`/api/territory/search?q=${encodeURIComponent(q)}`);
      box.innerHTML = results.length ? results.map((r, i) => `<button type="button" data-i="${i}">${esc(r.label)}</button>`).join("") : `<p class="muted small">Nothing found. Try a suburb and city, or click the map.</p>`;
      $$("button", box).forEach((b) => b.addEventListener("click", () => {
        const r = results[+b.dataset.i]; box.hidden = true;
        map.flyTo([r.lat, r.lng], 11, { duration: 0.6 });
        addSite(r.lat, r.lng, r.label.split(",")[0], r.label);
      }));
    } catch (err) { box.innerHTML = `<p class="error small">${esc(err.message)}</p>`; }
  });
  document.addEventListener("click", function hide(e) { if (!document.body.contains($("#find"))) return document.removeEventListener("click", hide); if (!$("#find").contains(e.target)) $("#found").hidden = true; });
  const setPlacing = (on) => { placing = on; $("#placeBtn").setAttribute("aria-pressed", String(on)); $("#placeBtn").textContent = on ? "Click a spot on the map… (Esc to stop)" : "Click the map to place a site"; $("#map").classList.toggle("placing", on); };
  $("#placeBtn").addEventListener("click", () => setPlacing(!placing));
  document.addEventListener("keydown", function esc_(e) { if (!document.body.contains($("#map"))) return document.removeEventListener("keydown", esc_); if (e.key === "Escape" && placing) setPlacing(false); });
  map.on("click", (e) => {
    if (!placing) return;
    const ll = e.latlng.wrap(); // the world repeats sideways; keep longitude within ±180
    if (Math.abs(ll.lat) > 85) return toast("Pick a spot closer to land", "error");
    setPlacing(false); addSite(+ll.lat.toFixed(5), +ll.lng.toFixed(5));
  });

  let rTimer;
  $("#defR").addEventListener("input", (e) => {
    const v = +e.target.value; if (!(v >= 1 && v <= 300)) return;
    data.radius_km = v; clearTimeout(rTimer);
    rTimer = setTimeout(async () => { compute(); try { await post("/api/territory/prefs", { radius_km: v }, "PUT"); } catch (err) { fail(err); } }, 300);
  });

  // ---------------------------------------------------------------- place pipeline targets (geocoding, a few at a time)
  async function placeTargets() {
    const note = $("#geoNote");
    const missing = data.targets.filter((t) => !t.location.trim()).length;
    while (data.pending > 0 && !stale(seq)) {
      note.hidden = false; note.textContent = `Placing ${data.pending} pipeline location${data.pending === 1 ? "" : "s"} on the map…`;
      try {
        const r = await post("/api/territory/geocode", {});
        if (!r.done) { note.textContent = `${r.pending} locations still to place; the map lookup is busy, trying again shortly.`; await new Promise((ok) => setTimeout(ok, 20000)); }
        data = { ...(await api("/api/territory")), sites: data.sites, radius_km: data.radius_km };
        await compute();
      } catch (e) { note.textContent = e.message; return; }
    }
    if (stale(seq)) return;
    const unfound = data.targets.filter((t) => t.location.trim() && t.lat == null).length;
    const bits = [missing && `${missing} target${missing === 1 ? " has" : "s have"} no location`, unfound && `${unfound} location${unfound === 1 ? "" : "s"} couldn't be found`].filter(Boolean);
    note.hidden = !bits.length;
    if (bits.length) note.innerHTML = `${esc(bits.join(" · "))}. Add a suburb and city on the target to put it on the map.`;
  }

  await compute();
  placeTargets();
  setTimeout(() => map.invalidateSize(), 50);
  const stop = () => { map.remove(); window.removeEventListener("hashchange", stop); };
  window.addEventListener("hashchange", stop);
}
