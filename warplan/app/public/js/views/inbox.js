import { $, $$, esc, api, post, view, session, stale, toast, fail, when, skeleton, emptyState } from "../core.js";

const TOOL = { draft_document: "Write a document", log_activity: "Log on the timeline", update_target: "Update a target", create_target: "Add a target" };
const SOURCE = { autopilot: "Autopilot", api: "API", user: "You", mcp: "AI app" };

// Show the count of pending proposals on the nav item.
export async function refreshInboxBadge() {
  try {
    const items = await api("/api/inbox");
    const b = $("#inboxBadge");
    if (b) { b.hidden = !items.length; b.textContent = items.length; }
    return items.length;
  } catch { return 0; }
}

export async function renderInbox(seq, params) {
  view().innerHTML = skeleton(4);
  const status = params.get("status") || "pending";
  const [items, auto] = await Promise.all([api(`/api/inbox?status=${status}`), api("/api/autopilot")]);
  if (stale(seq)) return;
  const owner = session.me.isOwner;
  view().innerHTML = `
    <header class="page-head with-actions"><div><p class="eyebrow">Inbox</p><h1>Your agents, waiting on you.</h1>
      <p class="lede">Every morning the autopilot reads your pipeline and lines up the next moves: follow-ups for owners who went quiet, first letters for new targets, the weekly board review. Nothing goes out until you approve it here.</p></div>
      <div class="head-actions">${owner ? `<button class="ghost" id="runNow" type="button">Run the autopilot now</button>` : ""}</div></header>
    <div class="autopilot-bar">
      <div><b>Autopilot</b> <span class="status ${auto.settings.enabled ? "on" : ""}">${auto.settings.enabled ? "On" : "Off"}</span><span class="muted small"> · ${esc(auto.schedule)} · proposes, never sends on its own</span></div>
      ${owner ? `<label class="switch"><input type="checkbox" id="autoToggle" ${auto.settings.enabled ? "checked" : ""}><span></span>${auto.settings.enabled ? "Turn off" : "Turn on"}</label>` : ""}
    </div>
    <div class="toolbar"><div class="seg" role="group" aria-label="Filter">${[["pending", "Waiting"], ["done", "Done"], ["dismissed", "Dismissed"], ["all", "All"]].map(([k, v]) => `<button type="button" data-st="${k}" class="${k === status ? "on" : ""}" aria-pressed="${k === status}">${v}</button>`).join("")}</div></div>
    ${items.length ? `<div class="inbox">${items.map(card).join("")}</div>` : emptyState(status === "pending" ? "Nothing waiting" : "Nothing here", status === "pending" ? "When the autopilot or another agent proposes a move, it lands here for you to approve." : "No proposals with this status yet.", owner && status === "pending" ? `<button class="primary" data-run type="button">Run the autopilot now</button>` : "")}`;
  $$("[data-st]").forEach((b) => b.addEventListener("click", () => { location.hash = `#/inbox?status=${b.dataset.st}`; }));
  const run = async (btn) => {
    btn.disabled = true; btn.textContent = "Reading your pipeline…";
    try { const r = await post("/api/autopilot/run"); toast(r.proposals ? `${r.proposals} new proposal${r.proposals > 1 ? "s" : ""}` : "Nothing new to propose right now"); renderInbox(seq, params); refreshInboxBadge(); }
    catch (e) { fail(e); btn.disabled = false; btn.textContent = "Run the autopilot now"; }
  };
  $("#runNow")?.addEventListener("click", (e) => run(e.currentTarget));
  $("[data-run]")?.addEventListener("click", (e) => run(e.currentTarget));
  $("#autoToggle")?.addEventListener("change", async (e) => {
    try { await post("/api/autopilot", { enabled: e.target.checked }, "PUT"); toast(e.target.checked ? "Autopilot on" : "Autopilot off"); renderInbox(seq, params); } catch (err) { fail(err); }
  });
  $$("[data-decide]").forEach((b) => b.addEventListener("click", async () => {
    const [id, verb] = b.dataset.decide.split(":");
    const row = b.closest(".proposal");
    $$("button", row).forEach((x) => { x.disabled = true; });
    if (verb === "approve") b.textContent = "Working…";
    try {
      const r = await post(`/api/inbox/${id}/${verb}`);
      if (verb === "approve") {
        if (r.ok) { toast(r.result?.receipt || "Done"); if (r.result?.document_id) { location.hash = `#/desk/${r.result.document_id}`; refreshInboxBadge(); return; } }
        else toast(r.result?.error || "That didn't work", "error");
      } else toast("Dismissed");
      renderInbox(seq, params); refreshInboxBadge();
    } catch (e) { fail(e); $$("button", row).forEach((x) => { x.disabled = false; }); b.textContent = verb === "approve" ? "Approve" : "Dismiss"; }
  }));
}

// Exactly what approving will do: every field of the action, so nothing hides behind a friendly title.
const LABELS = { to: "To", subject: "Subject", body: "Message", provider: "Service", endpoint: "Endpoint", campaign_name: "Campaign", campaign_id: "Campaign id", target_ids: "Targets", input: "Input", kind: "Document", channel: "Channel", mobile: "Mobile lookup" };
function details(a) {
  const rows = Object.entries(a.input || {}).filter(([k, v]) => v !== "" && v != null && !["reason", "target_id"].includes(k));
  if (!rows.length) return "";
  const show = (v) => (typeof v === "object" ? JSON.stringify(v).slice(0, 600) : String(v).slice(0, 1500));
  return `<dl class="p-details">${rows.map(([k, v]) => `<div><dt>${esc(LABELS[k] || k)}</dt><dd class="pre-line">${esc(show(v))}</dd></div>`).join("")}</dl>`;
}

function card(a) {
  const res = a.result;
  return `<article class="proposal st-${a.status}">
    <div class="p-main">
      <div class="p-meta"><span class="p-src">${esc(SOURCE[a.source] || a.source)}</span><span>${esc(TOOL[a.tool] || a.tool)}</span>${a.target_name ? `<a href="#/targets/${a.target_id}">${esc(a.target_name)}</a>` : ""}<span class="muted">${when(a.created_at)}</span></div>
      <h2 class="p-title">${esc(a.title)}</h2>
      ${a.reason ? `<p class="muted pre-line">${esc(a.reason)}</p>` : ""}
      ${a.status === "pending" ? details(a) : ""}
      ${a.status !== "pending" ? `<p class="small ${a.status === "failed" ? "tone-bad" : "muted"}">${a.status === "done" ? `Approved by ${esc(a.decided_by)} ${when(a.decided_at)}${res?.document_id ? ` · <a href="#/desk/${res.document_id}">open the document</a>` : res?.receipt ? ` · ${esc(res.receipt)}` : ""}` : a.status === "dismissed" ? `Dismissed by ${esc(a.decided_by)}` : a.status === "failed" ? `Failed: ${esc(res?.error || "unknown error")}` : "Running…"}</p>` : ""}
    </div>
    ${a.status === "pending" ? `<div class="p-actions"><button class="primary" type="button" data-decide="${a.id}:approve">Approve</button><button class="ghost" type="button" data-decide="${a.id}:dismiss">Dismiss</button></div>` : ""}
  </article>`;
}
