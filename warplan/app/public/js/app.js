// Warplan app shell: router, navigation, command palette (⌘K / Ctrl+K), keyboard shortcuts, boot.
import { $, $$, esc, api, session, synced, stopAudio, fail, toast } from "./core.js";
import { renderHome } from "./views/home.js";
import { renderJosh } from "./views/josh.js";
import { renderSimSetup, renderCall } from "./views/simulator.js";
import { renderBuilder } from "./views/builder.js";
import { renderLadder } from "./views/ladder.js";
import { renderPipeline, addTarget } from "./views/pipeline.js";
import { renderTarget } from "./views/target.js";
import { renderDesk, renderDoc } from "./views/desk.js";
import { renderSettings } from "./views/settings.js";
import { renderAgents } from "./views/agents.js";
import { renderInbox, refreshInboxBadge } from "./views/inbox.js";
import { renderScout } from "./views/scout.js";
import { renderDialer } from "./views/dialer.js";
import { initPhone, openPhone } from "./phone.js";
import { renderData } from "./views/data.js";

const TITLES = { home: "Command", pipeline: "Pipeline", targets: "Target", josh: "Ask Josh", simulator: "Simulator", builder: "Deal Builder", ladder: "Value Ladder", desk: "Desk", agents: "Units", settings: "Settings", inbox: "Inbox", scout: "Scout", dialer: "Dialer", data: "Data" };

async function router() {
  const seq = ++session.seq;
  stopAudio();
  closeNav();
  const [path, query = ""] = location.hash.replace(/^#/, "").split("?");
  const [, viewName = "home", id] = path.split("/");
  const params = new URLSearchParams(query);
  const nav = viewName === "targets" ? "pipeline" : viewName;
  $$(".nav a").forEach((a) => { const on = a.dataset.nav === nav; a.classList.toggle("active", on); on ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current"); });
  document.title = `${TITLES[viewName] || "Warplan"} · Warplan`;
  window.scrollTo(0, 0);
  try {
    if (viewName === "josh") return await renderJosh(id ? Number(id) : null, seq);
    if (viewName === "simulator") return id ? await renderCall(Number(id), seq) : await renderSimSetup(seq, params);
    if (viewName === "pipeline") return await renderPipeline(seq, params);
    if (viewName === "targets" && id) return await renderTarget(Number(id), seq);
    if (viewName === "builder") return await renderBuilder(seq, params);
    if (viewName === "ladder") return renderLadder();
    if (viewName === "desk") return id ? await renderDoc(Number(id), seq) : await renderDesk(seq, params);
    if (viewName === "agents") return renderAgents();
    if (viewName === "inbox") return await renderInbox(seq, params);
    if (viewName === "scout") return await renderScout(seq);
    if (viewName === "dialer") return await renderDialer(seq, params);
    if (viewName === "data") return await renderData(seq);
    if (viewName === "settings") return await renderSettings(id, seq);
    if (viewName !== "home") { history.replaceState(null, "", "#/home"); }
    return await renderHome(seq);
  } catch (e) {
    if (seq !== session.seq) return;
    $("#view").innerHTML = `<div class="empty"><h2>That didn't load.</h2><p class="muted">${esc(e.message)}</p><button class="primary" type="button" id="retry">Try again</button></div>`;
    $("#retry").addEventListener("click", router);
  }
}

// ------------------------------------------------------------------ navigation drawer (small screens)
function closeNav() { document.body.classList.remove("nav-open"); $("#menuBtn")?.setAttribute("aria-expanded", "false"); }
$("#menuBtn").addEventListener("click", () => { const open = document.body.classList.toggle("nav-open"); $("#menuBtn").setAttribute("aria-expanded", String(open)); });
$("#scrim").addEventListener("click", closeNav);

// ------------------------------------------------------------------ command palette
const COMMANDS = [
  ["Go to Command", "#/home"], ["Go to Pipeline", "#/pipeline"], ["Ask Josh", "#/josh"], ["Start a practice call", "#/simulator"],
  ["Open the Deal Builder", "#/builder"], ["Open the Value Ladder", "#/ladder"], ["Open the Desk", "#/desk"], ["See every unit", "#/agents"],
  ["Add a target", () => addTarget()], ["Settings: profile", "#/settings/profile"], ["Settings: team & invites", "#/settings/team"],
  ["Settings: connect your AI keys", "#/settings/integrations"], ["Find companies to buy (Scout)", "#/scout"], ["Open the agent inbox", "#/inbox"], ["Power dialer: start calling", "#/dialer"], ["Open the phone (call or text)", () => openPhone()], ["Data marketplace (Monid): search 2,500+ APIs", "#/data"], ["Connect Instantly / Smartlead / EmailBison", "#/settings/integrations"], ["Connect your mailbox", "#/settings/email"], ["Connect Claude, ChatGPT, Cursor, Zapier (MCP)", "#/settings/connect"], ["Settings: API tokens", "#/settings/api"], ["Settings: usage", "#/settings/usage"],
];
let palette = null;
function openPalette() {
  if (palette) return;
  palette = document.createElement("dialog");
  palette.className = "palette";
  palette.innerHTML = `<input type="search" placeholder="Search targets, conversations, documents, or type a command" aria-label="Command palette"><ul role="listbox"></ul><p class="muted small">↑↓ to move · Enter to open · Esc to close</p>`;
  document.body.append(palette);
  palette.showModal();
  const input = $("input", palette), list = $("ul", palette);
  let items = [], sel = 0, t;
  const draw = () => {
    list.innerHTML = items.map((it, i) => `<li role="option" aria-selected="${i === sel}" class="${i === sel ? "on" : ""}" data-i="${i}"><span>${esc(it.label)}</span><small>${esc(it.hint || "")}</small></li>`).join("") || `<li class="muted small">Nothing found.</li>`;
    $$("li[data-i]", list).forEach((li) => li.addEventListener("click", () => run(items[+li.dataset.i])));
  };
  const search = async (q) => {
    const cmds = COMMANDS.filter(([l]) => l.toLowerCase().includes(q.toLowerCase())).map(([label, go]) => ({ label, go, hint: "command" }));
    items = cmds; sel = 0; draw();
    if (q.trim().length < 2) return;
    try {
      const r = await api(`/api/search?q=${encodeURIComponent(q)}`);
      if (!palette || input.value !== q) return;
      items = [
        ...r.targets.map((x) => ({ label: x.name, hint: `target · ${[x.industry, x.location].filter(Boolean).join(", ")}`, go: `#/targets/${x.id}` })),
        ...r.documents.map((x) => ({ label: x.title, hint: "document", go: `#/desk/${x.id}` })),
        ...r.threads.map((x) => ({ label: x.title, hint: x.agent === "simulator" ? "practice call" : "Josh", go: `#/${x.agent === "simulator" ? "simulator" : "josh"}/${x.id}` })),
        ...cmds,
        { label: `Ask Josh: “${q}”`, hint: "new conversation", go: () => import("./views/josh.js").then((m) => m.askJoshAbout(q)) },
      ];
      sel = 0; draw();
    } catch { /* keep the command list */ }
  };
  const run = (it) => { if (!it) return; closePalette(); typeof it.go === "function" ? it.go() : (location.hash = it.go); };
  input.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => search(input.value), 150); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); draw(); }
    if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(0, sel - 1); draw(); }
    if (e.key === "Enter") { e.preventDefault(); run(items[sel]); }
  });
  palette.addEventListener("close", closePalette);
  palette.addEventListener("click", (e) => { if (e.target === palette) closePalette(); });
  search("");
}
function closePalette() { if (!palette) return; const p = palette; palette = null; if (p.open) p.close(); p.remove(); }
$("#searchBtn").addEventListener("click", openPalette);
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); palette ? closePalette() : openPalette(); return; }
  const typing = e.target.closest?.("input, textarea, select, [contenteditable]") || document.querySelector("dialog[open]");
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "/") { e.preventDefault(); openPalette(); }
  if (e.key === "n" && location.hash.startsWith("#/pipeline")) { e.preventDefault(); addTarget(); }
});

// ------------------------------------------------------------------ boot
$("#logout").addEventListener("click", async () => { await fetch("/api/logout", { method: "POST" }); location.href = "/login"; });
(async () => {
  try {
    [session.me, session.team] = await Promise.all([api("/api/me"), api("/api/agents"), synced.load(["deal", "ladder", "profile"])]);
  } catch (e) {
    $("#view").innerHTML = `<div class="empty"><h2>Warplan couldn't start.</h2><p class="muted">${esc(e.message)}</p><button class="primary" type="button" id="reload">Reload</button></div>`;
    $("#reload").addEventListener("click", () => location.reload());
    return;
  }
  $("#who-name").textContent = session.me.user.name || session.me.user.email;
  $("#who-ws").textContent = session.me.account.name;
  window.addEventListener("hashchange", router);
  window.addEventListener("unhandledrejection", (e) => { if (e.reason?.message && e.reason.message !== "Signed out") fail(e.reason); });
  window.addEventListener("offline", () => toast("You're offline. Changes will fail until you reconnect.", "error"));
  router();
  refreshInboxBadge();
  initPhone();
  setInterval(() => { if (!document.hidden) refreshInboxBadge(); }, 120000);
})();
