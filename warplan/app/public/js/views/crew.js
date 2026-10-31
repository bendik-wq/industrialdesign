// The crew: multi-layer agents. Start a run, watch each layer work (gather → compute → reason → verify → act),
// and work the alerts they raise. Monthly actuals for owned businesses live here too.
import { $, $$, esc, api, post, view, stale, skeleton, when, toast, fail, md, session } from "../core.js";

const KIND = { gather: "Gather", extract: "Read files", compute: "Compute", reason: "Reason", verify: "Verify", act: "Act" };
const SEV = { high: "tone-bad", medium: "tone-warn", low: "muted" };
const STAGE_LABEL = { first_call: "First call", meeting: "Meeting", docs: "NDA & docs", loi: "LOI sent", diligence: "Diligence", closed: "Owned" };
let crewCache = null;
export async function crewAgents() { return (crewCache ??= (await api("/api/crew")).agents); }

export async function renderCrew(seq, params = new URLSearchParams()) {
  view().innerHTML = skeleton(6);
  const [agents, { findings }, { runs }, list] = await Promise.all([crewAgents(), api("/api/findings"), api("/api/runs?limit=20"), api("/api/targets")]);
  const targets = Array.isArray(list) ? list : list.targets || [];
  if (stale(seq)) return;
  const byTarget = new Map();
  for (const f of findings) { const k = f.target_name || "Workspace"; byTarget.set(k, [...(byTarget.get(k) || []), f]); }
  view().innerHTML = `
    <header class="page-head"><p class="eyebrow">Agents</p><h1>The crew</h1>
      <p class="lede muted">Agents that work in layers: they gather the facts, compute the numbers in code, reason over them with the 3C model, check every claim against the numbers, then raise alerts and queue next steps for your approval. Nothing is sent or changed without you.</p></header>
    <section class="panel">
      <div class="panel-head"><h2 class="h3">Open alerts</h2><span class="muted small">${findings.length} open · ${findings.filter((f) => f.severity === "high").length} high</span></div>
      ${findings.length ? [...byTarget].map(([name, list]) => `<h3 class="h4 rsec">${esc(name)}</h3><ul class="alerts">${list.map(alertRow).join("")}</ul>`).join("") : `<p class="muted">No open alerts. The monitors re-check the businesses you own every morning.</p>`}
    </section>
    <div class="crew-grid">${agents.map((a) => agentCard(a, targets)).join("")}</div>
    <section class="panel"><div class="panel-head"><h2 class="h3">Recent runs</h2></div>
      ${runs.length ? `<ul class="runs">${runs.map(runRow).join("")}</ul>` : `<p class="muted">No runs yet.</p>`}</section>`;
  wireAlerts(() => renderCrew(++session.seq, params));
  $$("[data-run]").forEach((b) => b.addEventListener("click", async () => {
    const sel = $(`#t-${b.dataset.run}`);
    if (!sel?.value) return toast("Pick a target first");
    b.disabled = true;
    try { const r = await post("/api/runs", { agent: b.dataset.run, target_id: +sel.value }); location.hash = `#/crew/${r.id}`; }
    catch (e) { fail(e); b.disabled = false; }
  }));
}

function agentCard(a, targets) {
  const ok = targets.filter((t) => !a.stages || a.stages.includes(t.stage));
  return `<section class="panel crew-card">
    <div class="panel-head"><h2 class="h3">${esc(a.name)}</h2>${a.monitor ? `<span class="pill">Daily monitor</span>` : ""}</div>
    <p class="small">${esc(a.describe)}</p>
    <ol class="layers">${a.layers.map((l) => `<li><span class="lk">${esc(KIND[l.kind] || l.kind)}</span> ${esc(l.title)}</li>`).join("")}</ol>
    <div class="row">${ok.length ? `<select id="t-${a.id}" aria-label="Target">${ok.map((t) => `<option value="${t.id}">${esc(t.name)} · ${esc(STAGE_LABEL[t.stage] || t.stage)}</option>`).join("")}</select><button class="primary" data-run="${a.id}" type="button">Run</button>`
      : `<span class="muted small">Runs on targets at: ${(a.stages || []).map((s) => STAGE_LABEL[s] || s).join(", ")}. None yet.</span>`}</div>
  </section>`;
}

const alertRow = (f) => `<li class="alert">
  <span class="sev ${SEV[f.severity]}">${esc(f.severity)}</span>
  <div><b>${esc(f.title)}</b>${f.detail ? `<small>${esc(f.detail)}</small>` : ""}<small class="muted">${esc(f.agent_name)} · ${when(f.updated_at)}${f.run_id ? ` · <a href="#/crew/${f.run_id}">see the run</a>` : ""}</small></div>
  <span class="row"><button class="ghost small" data-fx="${f.id}" data-to="resolved" type="button">Resolved</button><button class="link small" data-fx="${f.id}" data-to="dismissed" type="button">Dismiss</button></span></li>`;

function wireAlerts(refresh) {
  $$("[data-fx]").forEach((b) => b.addEventListener("click", async () => {
    try { await post(`/api/findings/${b.dataset.fx}`, { status: b.dataset.to }, "PATCH"); refresh(); } catch (e) { fail(e); }
  }));
}

const STATUS = { queued: "Queued", running: "Working", done: "Done", failed: "Failed" };
const runRow = (r) => `<li><a href="#/crew/${r.id}"><b>${esc(r.name)}</b> · ${esc(r.target_name || "workspace")}</a>
  <span class="muted small">${STATUS[r.status] || r.status}${r.status === "running" || r.status === "queued" ? ` · layer ${Math.min(r.step + 1, r.layers)}/${r.layers}` : ""}${r.summary?.headline ? ` · ${esc(r.summary.headline)}` : ""}${r.error ? ` · <span class="tone-bad">${esc(r.error)}</span>` : ""} · ${when(r.created_at)}</span></li>`;

export async function renderRun(id, seq) {
  view().innerHTML = skeleton(5);
  let r;
  try { r = await api(`/api/runs/${id}`); } catch (e) { if (!stale(seq)) view().innerHTML = `<p class="tone-bad">${esc(e.message)}</p>`; return; }
  if (stale(seq)) return;
  const steps = new Map(r.steps.map((s) => [s.n, s]));
  const live = r.status === "queued" || r.status === "running";
  view().innerHTML = `
    <header class="page-head with-actions"><div><p class="eyebrow"><a href="#/crew">The crew</a></p><h1>${esc(r.name)}</h1>
      <p class="lede muted">${r.target_id ? `<a href="#/targets/${r.target_id}">Open the target</a> · ` : ""}${STATUS[r.status] || r.status} · started ${when(r.created_at)}${r.tokens_in ? ` · ${(r.tokens_in + r.tokens_out).toLocaleString()} tokens` : ""}</p></div>
      <div class="row">${r.summary?.document_id ? `<a class="primary" href="#/desk/${r.summary.document_id}">Open the report</a>` : ""}${r.summary?.proposals?.length ? `<a class="ghost" href="#/inbox">${r.summary.proposals.length} waiting in the Inbox</a>` : ""}</div></header>
    ${r.summary?.headline ? `<section class="panel headline"><p><b>${esc(r.summary.headline)}</b></p></section>` : ""}
    ${r.error ? `<section class="panel"><p class="tone-bad">${esc(r.error)}</p></section>` : ""}
    <section class="panel"><h2 class="h3">Layers</h2><ol class="timeline">${r.layers.map((l, i) => {
      const s = steps.get(i);
      const st = s?.status || (i === r.step && live ? "running" : i < r.step ? "done" : r.status === "done" ? "skipped" : "waiting");
      return `<li class="tl ${st}"><span class="dot" aria-hidden="true"></span><div><b>${esc(l.title)}</b> <span class="lk">${esc(KIND[l.kind] || l.kind)}</span>
        <small>${st === "running" ? "Working…" : st === "waiting" ? "Waiting" : st === "skipped" ? "Not needed" : esc(s?.summary || "")}</small>
        ${s?.data ? `<details><summary class="small">Show the working</summary><pre class="json">${esc(JSON.stringify(s.data, null, 2).slice(0, 12000))}</pre></details>` : ""}</div></li>`;
    }).join("")}</ol></section>
    ${r.findings.length ? `<section class="panel"><h2 class="h3">Alerts raised</h2><ul class="alerts">${r.findings.map((f) => alertRow({ ...f, agent_name: r.name, updated_at: r.finished_at || r.updated_at, run_id: null })).join("")}</ul></section>` : ""}`;
  wireAlerts(() => renderRun(id, ++session.seq));
  if (live) setTimeout(() => { if (!stale(seq)) renderRun(id, seq); }, 2500);
}

// Target page panel: the agents that apply at this stage, and recent runs on it.
export async function crewPanel(t) {
  const [agents, { runs }, { findings }] = await Promise.all([crewAgents(), api(`/api/runs?target_id=${t.id}&limit=5`), api(`/api/findings?target_id=${t.id}`)]);
  const ok = agents.filter((a) => !a.stages || a.stages.includes(t.stage));
  return `<section class="panel" id="crewPanel">
    <div class="panel-head"><h2 class="h3">The crew</h2>${t.stage === "closed" ? `<a class="small" href="#/actuals/${t.id}">Monthly actuals →</a>` : ""}</div>
    ${ok.length ? `<div class="agent-actions">${ok.map((a) => `<div class="aa"><b>${esc(a.name)}</b><p class="muted small">${esc(a.describe.split(": ")[0])}.</p><button class="ghost" data-crew="${a.id}" type="button">Run (${a.layers.length} layers)</button></div>`).join("")}</div>`
      : `<p class="muted small">The crew starts working on this target from the first call (Gatekeeper), at NDA and docs (Earnings X-Ray), and once you own it (Covenant Sentinel, Retention Watchtower).</p>`}
    ${findings.length ? `<h3 class="h4 rsec">Open alerts</h3><ul class="alerts">${findings.map((f) => alertRow(f)).join("")}</ul>` : ""}
    ${runs.length ? `<h3 class="h4 rsec">Recent runs</h3><ul class="runs">${runs.map(runRow).join("")}</ul>` : ""}
  </section>`;
}
export function wireCrewPanel(t, refresh) {
  $$("[data-crew]").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true;
    try { const r = await post("/api/runs", { agent: b.dataset.crew, target_id: t.id }); location.hash = `#/crew/${r.id}`; }
    catch (e) { fail(e); b.disabled = false; }
  }));
  wireAlerts(refresh);
}

// ── monthly actuals ──────────────────────────────────────────────────────────
const COLS = [["revenue", "Revenue"], ["gross_profit", "Gross profit"], ["wages", "Wages"], ["ebitda", "EBITDA"], ["cash", "Cash (month end)"], ["receivables", "Receivables"], ["payables", "Payables"], ["debt_service", "Loan repayments"], ["headcount", "Headcount"], ["customers", "Customers"]];
export async function renderActuals(targetId, seq) {
  view().innerHTML = skeleton(5);
  const [t, { actuals }] = await Promise.all([api(`/api/targets/${targetId}`), api(`/api/targets/${targetId}/actuals?months=36`)]);
  if (stale(seq)) return;
  const tgt = t.target || t;
  const last = actuals.at(-1)?.period;
  const next = last ? (() => { const [y, m] = last.split("-").map(Number); const d = new Date(Date.UTC(y, m, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; })() : new Date().toISOString().slice(0, 7);
  const rows = [...actuals, { period: next, _new: true }];
  view().innerHTML = `
    <header class="page-head"><p class="eyebrow"><a href="#/targets/${tgt.id}">${esc(tgt.name)}</a></p><h1>Monthly actuals</h1>
      <p class="lede muted">What Covenant Sentinel checks against the debt. Type the month's figures, or upload monthly P&amp;Ls to the deal room and the agent reads them in. EBITDA is the one that matters most.</p></header>
    <section class="panel"><form id="act"><div class="table-wrap"><table class="grid"><thead><tr><th>Month</th>${COLS.map(([, l]) => `<th>${l}</th>`).join("")}<th>Source</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td><input name="period" value="${esc(r.period)}" pattern="\\d{4}-\\d{2}" size="7" aria-label="Month"></td>${COLS.map(([k, l]) => `<td><input name="${k}" inputmode="decimal" value="${r[k] ?? ""}" aria-label="${l}" size="9"></td>`).join("")}<td class="muted small">${r._new ? "new" : esc(r.source)}</td></tr>`).join("")}
    </tbody></table></div>
    <div class="row"><button class="primary" type="submit">Save</button><button class="ghost" type="button" id="runCov">Save and run Covenant Sentinel</button></div></form></section>`;
  const collect = () => $$("#act tbody tr").map((tr) => Object.fromEntries($$("input", tr).map((i) => [i.name, i.value.replace(/[$,\s]/g, "")]))).filter((r) => /^\d{4}-\d{2}$/.test(r.period) && COLS.some(([k]) => r[k] !== ""));
  const save = async () => { await post(`/api/targets/${tgt.id}/actuals`, { rows: collect() }, "PUT"); toast("Saved"); };
  $("#act").addEventListener("submit", async (e) => { e.preventDefault(); try { await save(); renderActuals(targetId, ++session.seq); } catch (x) { fail(x); } });
  $("#runCov").addEventListener("click", async () => { try { await save(); const r = await post("/api/runs", { agent: "covenant", target_id: tgt.id }); location.hash = `#/crew/${r.id}`; } catch (x) { fail(x); } });
}
