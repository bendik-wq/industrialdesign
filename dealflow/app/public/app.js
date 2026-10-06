const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n) => Number(n || 0).toLocaleString();
const YEAR = new Date().getFullYear();

const state = { page: 1, limit: 50, tiers: new Set(), total: 0 };
let statuses = [];

function loadSettings() {
  try { return JSON.parse(localStorage.getItem("dealflow.settings") || "{}"); } catch { return {}; }
}
function saveSettings(s) {
  try { localStorage.setItem("dealflow.settings", JSON.stringify(s)); } catch { /* storage unavailable */ }
}

function params() {
  const p = new URLSearchParams();
  const q = $("#q").value.trim();
  if (q) p.set("q", q);
  if ($("#metro").value) p.set("metro", $("#metro").value);
  for (const t of state.tiers) p.append("tier", t);
  if (+$("#minSuccession").value) p.set("minSuccession", $("#minSuccession").value);
  if ($("#status").value) p.set("status", $("#status").value);
  if ($("#hideSole").checked) p.set("sole", "0");
  if ($("#lapsed").checked) p.set("lapsed", "1");
  if ($("#excluded").checked) p.set("excluded", "1");
  p.set("sort", $("#sort").value);
  return p;
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

// ---------- KPIs ----------
async function loadStats() {
  const s = await api("/api/stats");
  const inPipe = s.pipeline.reduce((n, r) => n + r.n, 0);
  const tiles = [
    ["Target companies", s.targets, () => reset()],
    ["Prime: Mid+ size & succession ≥ 50", s.prime, () => { reset(); setTiers(["Large", "Mid"]); setSucc(50); }, "hot"],
    ["Succession ≥ 50", s.high_succession, () => { reset(); setSucc(50); }],
    ["Mid or Large", s.mid_plus, () => { reset(); setTiers(["Large", "Mid"]); }],
    ["License lapsed (wind-down?)", s.lapsed, () => { reset(); $("#lapsed").checked = true; }],
    ["In pipeline", inPipe, () => { reset(); $("#status").value = "Any pipeline"; }],
  ];
  $("#kpis").innerHTML = tiles.map(([l, v, , cls], i) => `<button class="kpi ${cls || ""}" data-i="${i}" type="button"><div class="v">${fmt(v)}</div><div class="l">${esc(l)}</div></button>`).join("");
  $("#kpis").querySelectorAll(".kpi").forEach((b) => b.addEventListener("click", () => { tiles[b.dataset.i][2](); state.page = 1; load(); }));
}
function reset() {
  $("#q").value = ""; $("#metro").value = ""; $("#status").value = "";
  $("#hideSole").checked = $("#lapsed").checked = $("#excluded").checked = false;
  setTiers([]); setSucc(0);
}
function setTiers(list) {
  state.tiers = new Set(list);
  document.querySelectorAll("#tiers button").forEach((b) => b.setAttribute("aria-pressed", state.tiers.has(b.dataset.tier)));
}
function setSucc(v) { $("#minSuccession").value = v; $("#minSuccOut").textContent = v; }

// ---------- table ----------
const meter = (v, hot) => `<div class="meter ${hot ? "hot" : ""}"><div class="track"><div class="fill" style="width:${Math.max(2, v)}%"></div></div><span>${v}</span></div>`;

async function load() {
  const p = params();
  p.set("page", state.page);
  p.set("limit", state.limit);
  $("#count").textContent = "Loading…";
  const data = await api(`/api/companies?${p}`);
  state.total = data.total;
  $("#count").textContent = `${fmt(data.total)} companies`;
  const start = (state.page - 1) * state.limit;
  $("#rows").innerHTML = data.rows.map((r, i) => `
    <tr data-id="${r.id}" class="${r.non_target ? "excluded" : ""}">
      <td class="num muted">${start + i + 1}</td>
      <td class="co"><b>${esc(r.name)}</b>${r.legal_name && r.legal_name.toLowerCase() !== r.name.toLowerCase() ? `<small>${esc(r.legal_name)}</small>` : `<small>${esc(r.entity || "")}</small>`}</td>
      <td>${esc(r.owner)}</td>
      <td class="loc">${esc(r.city || r.county)}<br><small>${esc(r.metro)}</small></td>
      <td class="num">~${r.licensed_since ?? "–"}</td>
      <td class="num">${r.business_since ?? "–"}</td>
      <td class="num">${r.license_count}${r.active_licenses === 0 ? ' <small class="muted" title="All licenses expired">lapsed</small>' : ""}</td>
      <td><span class="tier ${r.size_tier}">${r.size_tier}</span></td>
      <td>${meter(r.succession_score, r.succession_score >= 60)}</td>
      <td class="num fit ${r.fit_score >= 55 ? "hot" : ""}">${r.fit_score}</td>
      <td class="status ${r.status !== "New" ? "active" : ""}">${esc(r.status)}</td>
    </tr>`).join("") || `<tr><td colspan="11" class="muted" style="text-align:center;padding:30px">No companies match these filters.</td></tr>`;
  const pages = Math.max(1, Math.ceil(data.total / state.limit));
  $("#pageInfo").textContent = `Page ${state.page} of ${fmt(pages)}`;
  $("#prev").disabled = state.page <= 1;
  $("#next").disabled = state.page >= pages;
}

// ---------- drawer ----------
async function openCompany(id) {
  const c = await api(`/api/companies/${id}`);
  const q = encodeURIComponent(`${c.legal_name || c.name} ${c.city || c.county} TX`);
  const yrsLicensed = c.licensed_since ? YEAR - c.licensed_since : null;
  const groups = { succession: "Succession", size: "Size", flag: "Flag" };
  $("#drawerBody").innerHTML = `
    <div class="d-head">
      <div><h2>${esc(c.name)}</h2><p>${esc(c.owner)} · ${esc([c.city, c.county + " County"].filter(Boolean).join(", "))} · ${esc(c.metro)}</p></div>
      <button class="close" id="closeDrawer" aria-label="Close">×</button>
    </div>
    <div class="scores">
      <div class="score"><div class="v">${c.fit_score}</div><div class="l">Fit score</div></div>
      <div class="score"><div class="v">${c.succession_score}</div><div class="l">Succession</div></div>
      <div class="score"><div class="v">${c.size_score}</div><div class="l">Size · ${esc(c.size_tier)}</div></div>
    </div>

    <div class="d-sec"><h3>Why it scores</h3>
      <ul class="signals">${c.signals.map((s) => `
        <li><span class="pts ${s.pts < 0 ? "neg" : ""}">${s.pts > 0 ? "+" : ""}${s.pts || "·"}</span>
        <div><b>${esc(s.label)}<span class="kind">${groups[s.type] || ""}</span></b><small>${esc(s.detail)}</small></div></li>`).join("") || '<li><span></span><div class="muted">No strong signals</div></li>'}
      </ul>
    </div>

    <div class="d-sec"><h3>Company facts</h3>
      <dl class="facts">
        <div><dt>Legal name</dt><dd>${esc(c.legal_name || "Not matched")}</dd></div>
        <div><dt>Entity</dt><dd>${esc(c.entity || "–")}</dd></div>
        <div><dt>Address</dt><dd>${esc([c.street, c.city, c.zip].filter(Boolean).join(", ") || "Not available")}</dd></div>
        <div><dt>Phone</dt><dd>${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : "–"}</dd></div>
        <div><dt>Website</dt><dd>${c.website ? `<a href="${esc(c.website)}" target="_blank" rel="noopener">${esc(c.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""))}</a>` : "–"}</dd></div>
        <div><dt>Email (from website)</dt><dd>${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : "–"}</dd></div>
        <div><dt>Google</dt><dd>${c.reviews != null ? `${c.rating ?? "–"}★ · ${fmt(c.reviews)} reviews` : "–"}</dd></div>
        <div><dt>Locations (sales tax outlets)</dt><dd>${c.outlets || "–"}</dd></div>
        <div><dt>Est. licensed since</dt><dd>${c.licensed_since ? `~${c.licensed_since} (${yrsLicensed} yrs)` : "–"}</dd></div>
        <div><dt>Business since</dt><dd>${c.business_since || "–"}</dd></div>
      </dl>
    </div>

    <div class="d-sec"><h3>Licensed contractors (TDLR)</h3>
      <table class="lic"><thead><tr><th>Name</th><th class="num">License #</th><th>Class</th><th>Expires</th></tr></thead><tbody>
      ${c.licensees.map((l) => `<tr><td>${esc(l.owner)}</td><td class="num">${l.number}</td><td>${esc(l.subtype)}</td><td>${esc(l.expires)}${l.active ? "" : ' <small class="muted">lapsed</small>'}</td></tr>`).join("")}
      </tbody></table>
    </div>

    <div class="d-sec"><h3>Research</h3>
      <div class="links">
        <a href="https://www.google.com/search?q=${q}" target="_blank" rel="noopener">Google</a>
        <a href="https://www.google.com/maps/search/${q}" target="_blank" rel="noopener">Maps & reviews</a>
        <a href="https://www.tdlr.texas.gov/LicenseSearch/" target="_blank" rel="noopener">TDLR license search</a>
        <a href="https://mycpa.cpa.state.tx.us/coa/" target="_blank" rel="noopener">Comptroller entity search</a>
        <a href="https://www.linkedin.com/search/results/all/?keywords=${encodeURIComponent(`${c.owner} ${c.name}`)}" target="_blank" rel="noopener">LinkedIn</a>
      </div>
    </div>

    <div class="d-sec"><h3>Pipeline</h3>
      <div class="pipe">
        <select id="pStatus">${statuses.map((s) => `<option ${s === c.status ? "selected" : ""}>${s}</option>`).join("")}</select>
        <textarea id="pNotes" placeholder="Call notes, owner situation, next step…">${esc(c.notes)}</textarea>
        <div class="row-end"><small class="muted" id="pSaved">${c.updated_at ? `Saved ${new Date(c.updated_at).toLocaleString()}` : ""}</small><button class="primary" id="pSave" type="button">Save</button></div>
      </div>
    </div>

    <div class="d-sec"><h3>Outreach drafts</h3>
      <div class="tabs" role="tablist">
        <button role="tab" data-t="letter" aria-selected="true">Letter</button>
        <button role="tab" data-t="email">Email sequence</button>
        <button role="tab" data-t="call">Call script</button>
      </div>
      <div class="draft" id="draft"></div>
      <div class="draft-actions"><span id="draftNote"></span><button class="ghost" id="copyDraft" type="button">Copy</button></div>
    </div>`;

  const showDraft = (t) => {
    document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", b.dataset.t === t));
    const d = drafts(c, loadSettings())[t];
    $("#draft").textContent = d.text;
    $("#draftNote").textContent = d.note;
  };
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => showDraft(b.dataset.t)));
  showDraft("letter");
  $("#copyDraft").addEventListener("click", async () => {
    await navigator.clipboard.writeText($("#draft").textContent);
    $("#copyDraft").textContent = "Copied";
    setTimeout(() => ($("#copyDraft").textContent = "Copy"), 1200);
  });
  $("#pSave").addEventListener("click", async () => {
    const r = await api(`/api/companies/${c.id}/pipeline`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: $("#pStatus").value, notes: $("#pNotes").value }),
    });
    $("#pSaved").textContent = `Saved ${new Date(r.updated_at).toLocaleTimeString()}`;
    load(); loadStats();
  });
  $("#closeDrawer").addEventListener("click", closeDrawer);
  $("#drawer").classList.add("open");
  $("#scrim").classList.add("open");
  $("#drawer").setAttribute("aria-hidden", "false");
}
function closeDrawer() {
  $("#drawer").classList.remove("open");
  $("#scrim").classList.remove("open");
  $("#drawer").setAttribute("aria-hidden", "true");
}

// ---------- outreach templates ----------
function drafts(c, s) {
  const first = (c.owner || "").split(" ")[0] || "there";
  const me = s.myName || "[Your name]";
  const co = s.myCompany || "[Your company]";
  const phone = s.myPhone || "[Your phone]";
  const email = s.myEmail || "[Your email]";
  const angle = s.myAngle || "We're a Texas HVAC operator";
  const where = c.city || `${c.county} County`;
  const yrs = c.licensed_since ? YEAR - c.licensed_since : null;
  const tenure = c.business_since ? `since ${c.business_since}` : yrs ? `for over ${Math.floor(yrs / 5) * 5} years` : "for years";

  const letter = `${first} —

My name is ${me}. ${angle}, and I'm writing to a small number of owners whose companies I respect.

${c.name} has been serving ${where} ${tenure}. That kind of reputation takes decades to build, and I'd like to make sure it lasts.

If you've ever thought about what happens to the business when you step back — retirement, slowing down, or just taking chips off the table — I'd welcome a confidential conversation. No brokers, no pressure. We keep the name, keep your people, and can structure things so you're paid well over time and stay involved as much or as little as you like.

If now isn't the time, keep this letter. I'll check in again in a few months.

${me}
${co}
${phone} · ${email}`;

  const footer = `\n\n—\n${co}${s.myAddress ? ` · ${s.myAddress}` : " · [Your mailing address]"}\nNot interested? Reply "no thanks" and I won't contact you again.`;
  const email1 = `Subject: ${c.name} — a question for ${first}

Hi ${first},

${angle}. I came across ${c.name} — serving ${where} ${tenure} is no small thing.

Have you ever thought about selling the business, or bringing in a partner so you can step back?

If it's on your radar in the next few years, I'd value 15 minutes. If not, no problem at all.

${me}
${phone}${footer}`;
  const email2 = `Subject: re: ${c.name}

${first}, following up on my note. Most owners I talk to aren't looking to sell tomorrow — they just want to know their options and what the business is worth.

Happy to share how we've structured deals so owners keep their legacy and their team. Worth a quick call?

${me}${footer}`;
  const email3 = `Subject: closing the loop

${first}, I'll leave it here for now. If timing changes, my number is ${phone}. I'll check back in 6 months.

${me}${footer}`;

  const call = `Opener
"Hi, is this ${first}? ${first}, this is ${me} with ${co}. ${angle}. I'll be quick — have you ever thought about selling ${c.name}?"

If YES / MAYBE
"Great. What would the ideal outcome look like for you — timing, your role after, your team?"
→ Ask: rough revenue, # of techs & trucks, residential vs commercial mix, service agreements.
→ Next step: "Can I send a short NDA so we can look at the last 3 years of numbers together?"

If NOT NOW
"Totally understand. You've built something real ${tenure}. Mind if I check back in 6 months?"
→ Log follow-up date in notes.

If NO
"No problem at all — thanks for your time, ${first}." (Mark "Passed".)

Context for this call
• ${c.signals.filter((x) => x.pts > 0).map((x) => x.label).join("\n• ") || "No strong signals"}`;

  return {
    letter: { text: letter, note: "Best channel for owners 55+. Export the mail list for Lob/PostGrid." },
    email: { text: [email1, "────────── Day 4 ──────────", email2, "────────── Day 10 ──────────", email3].join("\n\n"), note: "Send from a separate warmed-up domain. Includes CAN-SPAM address + opt-out." },
    call: { text: call, note: "Humans dial only: no robocalls/AI voice. Check numbers against the Do Not Call list." },
  };
}

// ---------- wiring ----------
let t;
const debounced = () => { clearTimeout(t); t = setTimeout(() => { state.page = 1; load(); }, 250); };
$("#q").addEventListener("input", debounced);
for (const id of ["#metro", "#status", "#sort", "#hideSole", "#lapsed", "#excluded"]) $(id).addEventListener("change", () => { state.page = 1; load(); });
$("#minSuccession").addEventListener("input", (e) => { $("#minSuccOut").textContent = e.target.value; debounced(); });
document.querySelectorAll("#tiers button").forEach((b) => b.addEventListener("click", () => {
  state.tiers.has(b.dataset.tier) ? state.tiers.delete(b.dataset.tier) : state.tiers.add(b.dataset.tier);
  b.setAttribute("aria-pressed", state.tiers.has(b.dataset.tier));
  state.page = 1; load();
}));
$("#prev").addEventListener("click", () => { state.page--; load(); });
$("#next").addEventListener("click", () => { state.page++; load(); });
$("#rows").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-id]"); if (tr) openCompany(tr.dataset.id); });
$("#scrim").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

$("#exportBtn").addEventListener("click", (e) => { e.stopPropagation(); $("#exportMenu").hidden = !$("#exportMenu").hidden; });
document.addEventListener("click", () => ($("#exportMenu").hidden = true));
$("#exportMenu").querySelectorAll("a").forEach((a) => a.addEventListener("click", () => {
  const p = params(); p.set("format", a.dataset.format);
  location.href = `/api/export.csv?${p}`;
}));

$("#settingsBtn").addEventListener("click", () => {
  const s = loadSettings();
  for (const el of $("#settingsForm").elements) if (el.name) el.value = s[el.name] || "";
  $("#settings").showModal();
});
$("#settingsForm").addEventListener("submit", () => {
  const s = {};
  for (const el of $("#settingsForm").elements) if (el.name) s[el.name] = el.value.trim();
  saveSettings(s);
});

(async () => {
  const m = await api("/api/meta");
  statuses = m.statuses;
  $("#metro").innerHTML += m.metros.map((r) => `<option value="${esc(r.metro)}">${esc(r.metro)} (${fmt(r.n)})</option>`).join("");
  $("#status").innerHTML += statuses.map((s) => `<option>${s}</option>`).join("");
  await Promise.all([loadStats(), load()]);
})();
