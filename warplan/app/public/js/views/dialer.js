import { $, $$, esc, safeUrl, dialog, confirmBox, api, post, view, stale, toast, fail, local, skeleton, emptyState, session, dateLabel, todayYmd, when } from "../core.js";
import { STAGES, stageById } from "../deal.js";
import { deepEnrichDialog } from "./outreach.js";
import { phoneMode, dial, hangUp, toggleMute, sendDigit, deviceCall, qrSvg, telWorks, watchHandoff } from "../phone.js";

// Power dialer: one owner at a time, a human on every call. Start a session, press Space to call, 1–0 for the
// outcome, and the next owner is up (auto-dialed after a short countdown when calling through Twilio). Calling
// hours, attempt limits and the do-not-call list are enforced by the server on every path.
const PREFS = { stage: "", list: "", callable: false, fresh: true, advance: 5, doubleDial: true, mode: "auto" };
const ANSWERED_KEYS = new Set(["gatekeeper", "callback", "connected", "interested", "meeting", "not_interested", "wrong_number", "dnc"]);
const LINE = { mobile: "Mobile", landline: "Landline", fixedVoip: "VoIP", nonFixedVoip: "VoIP", tollFree: "Toll-free", personal: "Personal", pager: "Pager", voicemail: "Voicemail", sharedCost: "Shared" };
let S = null; // page state
let keyHandler = null;
document.addEventListener("keydown", (e) => keyHandler?.(e));
for (const ev of ["phone:ringing", "phone:connected", "phone:ended", "phone:failed"]) window.addEventListener(ev, (e) => { if (S && $("#dmain")) S.onPhone?.(ev.slice(6), e.detail || {}); });

export async function renderDialer(seq, params) {
  const sub = params.get("view") || "dial";
  view().innerHTML = skeleton(5);
  if (S?.call) cleanupCall();
  S = null; keyHandler = null;
  if (sub === "insights") return renderInsights(seq);
  if (sub === "team") return renderTeam(seq);
  const prefs = { ...PREFS, ...local.get("dialer2", {}) };
  const qs = new URLSearchParams({ ...(prefs.stage && { stage: prefs.stage }), ...(prefs.list && { list: prefs.list }), ...(prefs.list === "hot" && { score: "60" }), ...(prefs.fresh && { fresh: "1" }), ...(prefs.callable && { callable: "1" }), ...(params.get("q") && { q: params.get("q") }) });
  const [data, me] = await Promise.all([api(`/api/dialer/queue?${qs}`), session.me ? Promise.resolve(session.me) : api("/api/me")]);
  if (stale(seq)) return;
  let ses = null;
  try { const id = sessionStorage.getItem("dialSession"); if (id) ses = await api(`/api/dialer/sessions/${id}`); if (ses?.ended_at) ses = null; } catch { ses = null; }
  S = { data, me, prefs, queue: data.queue, cur: 0, brief: new Map(), call: null, session: ses, countdown: null, onPhone: null };
  const pick = params.get("target") ? S.queue.findIndex((t) => t.id === +params.get("target")) : -1;
  if (pick >= 0) S.cur = pick;

  view().innerHTML = `
    <header class="page-head with-actions dial-head"><div><p class="eyebrow">Power dialer</p><h1>Pick up the phone.</h1></div><div id="dsession" class="dsession"></div></header>
    ${subnav("dial")}
    ${connectCard()}
    <div class="toolbar dial-tools">
      <div class="seg" role="group" aria-label="List">${[["", "Due & new"], ["new", "Never called"], ["callbacks", "Callbacks"], ["hot", "Ready to sell"]].map(([k, l]) => `<button type="button" data-list="${k}" class="${prefs.list === k ? "on" : ""}">${l}</button>`).join("")}</div>
      <label class="inline">Stage <select id="dStage"><option value="">All live</option>${STAGES.filter((s) => !["closed", "lost"].includes(s.id)).map((s) => `<option value="${s.id}" ${prefs.stage === s.id ? "selected" : ""}>${s.label}</option>`).join("")}</select></label>
      <label class="check"><input type="checkbox" id="dCallable" ${prefs.callable ? "checked" : ""}> OK to call now</label>
      <label class="check"><input type="checkbox" id="dFresh" ${prefs.fresh ? "checked" : ""}> Skip called today</label>
      <span class="spacer"></span>
      <span class="muted small">${S.queue.length} to call${data.locked_by_others ? ` · ${data.locked_by_others} with teammates` : ""}</span>
      <button class="ghost small" id="dSettings" type="button" aria-label="Dialer settings">Settings</button>
    </div>
    ${S.queue.length ? windowBanner() : ""}
    ${S.queue.length ? `<div class="dialer3"><aside class="dq panel flush" id="dq" aria-label="Call list"></aside><section class="dmain" id="dmain"></section><aside class="dside" id="dside"></aside></div>`
      : emptyState(prefs.callable ? "No one to call right now" : "No one to call", prefs.callable ? "Everyone left is outside their calling hours (8am–9pm their time), on a break between attempts, or already called today. Untick “OK to call now” to see them, or come back later." : "Targets with a phone number show up here. Find companies in Scout (Google Maps and the registries give phones), or run Find contacts / Deep enrich on your targets.", `<div class="row center-row">${prefs.callable ? `<button class="primary" id="dShowAll" type="button">Show everyone</button>` : `<a class="primary" href="#/scout">Open Scout</a>`}<a class="ghost" href="#/dialer?view=insights">Best times to call</a></div>`)}`;

  const save = () => local.set("dialer2", prefs);
  const reload = () => renderDialer(++session.seq, params);
  $$("[data-list]").forEach((b) => b.addEventListener("click", () => { prefs.list = b.dataset.list; save(); reload(); }));
  $("#dStage").addEventListener("change", (e) => { prefs.stage = e.target.value; save(); reload(); });
  $("#dCallable").addEventListener("change", (e) => { prefs.callable = e.target.checked; save(); reload(); });
  $("#dFresh").addEventListener("change", (e) => { prefs.fresh = e.target.checked; save(); reload(); });
  $("#dShowAll")?.addEventListener("click", () => { prefs.callable = false; save(); reload(); });
  $("#dSettings").addEventListener("click", () => settingsDialog(reload));
  wireConnect(reload);
  drawSession();
  if (!S.queue.length) return;
  drawQueue(); showLead();
  keyHandler = hotkeys;
}

// When nobody can be called right now, say why and when that changes (in your own clock).
function windowBanner() {
  const now = S.queue.filter((t) => t.dialable || t.callback_due).length;
  if (now) return `<p class="dial-banner ok"><b>${now}</b> of ${S.queue.length} can be called right now.</p>`;
  const next = S.queue.map((t) => t.window?.opens_at).filter(Boolean).sort()[0];
  const w = S.queue.find((t) => t.window?.opens_at === next)?.window || S.queue[0].window || {};
  return `<p class="dial-banner"><b>Nobody can be called right now.</b> ${w.local ? `It's ${esc(w.local)} for your owners${w.region ? ` (${esc(w.region)})` : ""}: ${esc(w.reason || "outside calling hours")}.` : ""}${next ? ` Calls open <b>${new Date(next).toLocaleString([], { weekday: "long", hour: "numeric", minute: "2-digit" })}</b> your time.` : ""} Use the time to research owners or line up callbacks.</p>`;
}

// Not on Twilio yet: connect it right here (owners), so calls run inside the browser with your Twilio number.
function connectCard() {
  if (S.data.twilio) return "";
  if (!S.me?.isOwner) return `<p class="dial-banner">Calling from the browser needs Twilio: ask a workspace owner to connect it. Until then, calls go out from your own phone.</p>`;
  return `<form class="panel connect-card" id="twForm" autocomplete="off">
    <div class="cc-head"><div><h2 class="h3">Call from the browser</h2><p class="muted small">Paste these from <a href="https://console.twilio.com" target="_blank" rel="noopener noreferrer">console.twilio.com</a> (dashboard → Account info). Calls then ring out of this page with your Twilio number, and the dialer can auto-dial.</p></div>
      <button class="link small" type="button" id="twLater">Not now</button></div>
    <div class="cc-fields">
      <label class="field">Account SID<input name="sid" required placeholder="AC…" spellcheck="false"></label>
      <label class="field">Auth Token<input name="key" type="password" required placeholder="32 characters" spellcheck="false"></label>
      <label class="field">Your Twilio number<input name="from" inputmode="tel" placeholder="+61 3 9000 1234 (or leave empty to use the first one)"></label>
      <button class="primary" type="submit">Connect</button>
    </div>
    <p class="muted small">No number yet? Leave it empty: you can buy one right after connecting. Upgraded (paid) Twilio accounts only: trial accounts can't call owners. Keys are encrypted and never shown again.</p>
  </form>`;
}
function wireConnect(reload) {
  const f = $("#twForm"); if (!f) return;
  try { if (sessionStorage.getItem("twLater")) { f.remove(); return; } } catch { /* ignore */ }
  $("#twLater").addEventListener("click", () => { try { sessionStorage.setItem("twLater", "1"); } catch { /* ignore */ } f.remove(); });
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(f)), btn = $("button[type=submit]", f);
    btn.disabled = true; btn.textContent = "Checking with Twilio…";
    try {
      const r = await post("/api/integrations/twilio", { key: v.key.trim(), meta: { sid: v.sid.trim(), from: v.from.trim() } }, "PUT");
      if (r.phone?.error) throw new Error(`Connected, but the browser phone isn't set up yet: ${r.phone.error}`);
      const { refreshPhone, openPhone } = await import("../phone.js");
      await refreshPhone({ preferBrowser: true });
      S.prefs.mode = "browser"; local.set("dialer2", S.prefs);
      toast(r.phone?.has_number ? "Twilio connected: press Space to call" : "Connected. Last step: get a number to call from");
      if (!r.phone?.has_number) openPhone("keypad");
      reload();
    } catch (err) { fail(err); btn.disabled = false; btn.textContent = "Connect"; }
  });
}

const subnav = (on) => `<nav class="subnav" aria-label="Dialer"><a href="#/dialer" class="${on === "dial" ? "on" : ""}">Dial</a><a href="#/dialer?view=insights" class="${on === "insights" ? "on" : ""}">Insights</a><a href="#/dialer?view=team" class="${on === "team" ? "on" : ""}">Team</a></nav>`;

// ------------------------------------------------------------------ how calls go out
function modes() {
  const out = [];
  if (phoneMode() === "browser") out.push(["browser", "This browser"]);
  if (S.data.twilio) out.push(["bridge", "Twilio rings my phone"]);
  out.push(["device", "My own phone"]);
  return out;
}
function mode() { const m = modes(); return m.find(([k]) => k === S.prefs.mode)?.[0] || m[0][0]; }

// ------------------------------------------------------------------ session bar
function drawSession() {
  const el = $("#dsession"); if (!el) return;
  const s = S.session;
  if (!s) {
    el.innerHTML = `<button class="primary" id="sStart" type="button">Start a session</button><span class="muted small">Tracks dials, conversations and pace</span>`;
    $("#sStart").addEventListener("click", async () => { try { S.session = await post("/api/dialer/sessions"); try { sessionStorage.setItem("dialSession", S.session.id); } catch { /* ignore */ } refreshSession(); } catch (e) { fail(e); } });
    return;
  }
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(s.started_at)) / 60000));
  const talk = s.talk_seconds || 0;
  el.innerHTML = `<div class="ses-stats">
      <div><span>Dials</span><b>${s.dials || 0}</b></div><div><span>Answered</span><b>${s.connect_rate || 0}%</b></div><div><span>Conversations</span><b>${s.conversations || 0}</b></div>
      <div><span>Meetings</span><b>${s.meetings || 0}</b></div><div><span>Talk</span><b>${Math.floor(talk / 60)}:${String(talk % 60).padStart(2, "0")}</b></div><div><span>Per hour</span><b>${s.per_hour || 0}</b></div>
    </div><div class="ses-end"><span class="muted small">${mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)}h ${mins % 60}m`}</span><button class="ghost small" id="sEnd" type="button">End</button></div>`;
  $("#sEnd").addEventListener("click", async () => {
    try { const r = await api(`/api/dialer/sessions/${s.id}`, { method: "DELETE" }); toast(`Session done: ${r.dials} dials, ${r.conversations} conversations, ${r.meetings} meetings`); } catch (e) { fail(e); }
    S.session = null; try { sessionStorage.removeItem("dialSession"); } catch { /* ignore */ } drawSession();
  });
  clearTimeout(S.sesT); S.sesT = setTimeout(refreshSession, 30000);
}
async function refreshSession() {
  if (!S?.session || !$("#dsession")) return;
  try { S.session = await api(`/api/dialer/sessions/${S.session.id}`); if (S.session.ended_at) { S.session = null; try { sessionStorage.removeItem("dialSession"); } catch { /* ignore */ } } } catch { /* keep the old numbers */ }
  drawSession();
}

// ------------------------------------------------------------------ queue
function drawQueue() {
  const D = S.data.dispositions, el = $("#dq"); if (!el) return;
  el.innerHTML = `<ol class="dq-list">${S.queue.map((t, i) => {
    const w = t.window || {};
    const status = t.callback_due ? `<span class="tone-warn">Callback ${new Date(t.callback.due_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>`
      : !t.dialable ? `<span class="muted">${t.phones.every((p) => p.blocked || p.capped) ? "Tried enough today" : "Not now"}</span>`
      : t.last_disposition ? esc(D[t.last_disposition]?.label || t.last_disposition) : t.calls ? "" : "Never called";
    return `<li><button type="button" data-q="${i}" class="${i === S.cur ? "on" : ""} ${t.dialable || t.callback_due ? "" : "dim"}">
      <span class="dq-top"><b>${esc(t.name)}</b>${t.score != null ? `<span class="score-dot" title="Seller readiness ${t.score}/100">${t.score}</span>` : ""}</span>
      <small>${esc([t.owner_name, (t.location || "").split(",")[0]].filter(Boolean).join(" · "))}</small>
      <small class="dq-meta">${w.local ? `<span class="clock ${w.callable ? "ok" : "no"}">${esc(w.local.replace(/^\w+ /, ""))}</span>` : ""}${status}</small></button></li>`;
  }).join("")}</ol>`;
  $$("[data-q]", el).forEach((b) => b.addEventListener("click", () => { if (S.call && S.call.phase !== "ended") { toast("Finish the call first (log an outcome)", "error"); return; } cancelCountdown(); S.cur = +b.dataset.q; drawQueue(); showLead(); }));
  $(".dq-list .on", el)?.scrollIntoView({ block: "nearest" });
}

// ------------------------------------------------------------------ the current owner
async function showLead() {
  const t = S.queue[S.cur];
  if (!t) { $("#dmain").innerHTML = emptyState("List done", "That's everyone in this list. Change the filters, or check the best times to call.", `<div class="row center-row"><a class="primary" href="#/dialer?view=insights">Insights</a><a class="ghost" href="#/pipeline">Pipeline</a></div>`); $("#dside").innerHTML = ""; return; }
  // Hold the owner so a teammate doesn't ring them at the same moment.
  const st = S;
  try { await post(`/api/dialer/claim/${t.id}`); } catch (e) { if (S !== st) return; if (e.status === 409) { toast(e.message, "error"); S.queue.splice(S.cur, 1); if (S.cur >= S.queue.length) S.cur = 0; drawQueue(); return showLead(); } }
  if (S !== st || !$("#dmain")) return;
  S.call = null;
  drawMain(); drawSide();
  // Prefetch the next owner's brief so the switch is instant.
  const next = S.queue[S.cur + 1]; if (next && !S.brief.has(next.id)) api(`/api/dialer/brief/${next.id}`).then((b) => S.brief.set(next.id, b)).catch(() => {});
}

const firstName = (t) => String(t.owner_name || "").replace(/\(.*?\)/g, "").trim().split(/\s+/)[0] || "";
function usable(t) { return t.phones.map((p, i) => ({ ...p, i })).filter((p) => !p.blocked && !p.capped); }
function bestPhone(t) {
  const lines = S.brief.get(t.id)?.lines || {};
  const list = usable(t).filter((p) => lines[p.e164]?.valid !== 0 && (p.e164 || mode() === "device"));
  // Owner's mobile first when we know the line types.
  return list.find((p) => lines[p.e164]?.line_type === "mobile" && /owner|direct|mobile/i.test(p.label)) || list.find((p) => lines[p.e164]?.line_type === "mobile") || list[0] || null;
}

function drawMain() {
  const t = S.queue[S.cur], D = S.data.dispositions, w = t.window || {};
  const lines = S.brief.get(t.id)?.lines || {};
  const first = firstName(t);
  const m = mode();
  $("#dmain").innerHTML = `
    <div class="panel dcard">
      <div class="dc-head"><div><h2>${esc(t.name)}</h2><p class="muted small">${esc([t.industry, t.location].filter(Boolean).join(" · "))}${t.website ? ` · <a href="${safeUrl(t.website)}" target="_blank" rel="noopener noreferrer">website</a>` : ""} · <a href="#/targets/${t.id}">open target</a></p></div>
        <span class="stage-pill s-${t.stage}">${stageById(t.stage).label}</span></div>
      <p class="dc-owner">${t.owner_name ? `<b>${esc(t.owner_name)}</b>${t.owner_age ? ` <span class="age ${t.owner_age >= 60 ? "old" : ""}">${t.owner_age}</span>` : ""}` : `<span class="muted">Owner unknown: ask for the owner by role</span>`}${t.calls ? ` · <span class="muted">${t.calls} earlier call${t.calls > 1 ? "s" : ""}</span>` : ""}${t.next_action ? ` · <span class="muted">next: ${esc(t.next_action)}${t.next_date ? `, ${dateLabel(t.next_date)}` : ""}</span>` : ""}</p>
      <p class="dc-clock ${w.known === false ? "unknown" : w.callable ? "ok" : "no"}"><span class="dot"></span>${w.known === false ? "Their local time is unknown: add the city or state to the target" : `${esc(w.local)} their time${w.region ? ` · ${esc(w.region)}` : ""} · ${w.callable ? `OK to call (${esc(w.hours)})` : `outside calling hours (${esc(w.hours)})`}`}</p>
      ${t.callback ? `<p class="dc-callback">⏰ Callback ${t.callback_due ? "due" : "set"} ${new Date(t.callback.due_at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}${t.callback.note ? `: ${esc(t.callback.note)}` : ""}</p>` : ""}
      <div class="phones">${t.phones.map((p, i) => {
        const li = lines[p.e164];
        const off = p.blocked || p.capped || !w.callable || li?.valid === 0 || (m !== "device" && !p.e164);
        return `<div class="phone-row ${off ? "off" : ""}"><span><b>${esc(p.value)}</b> <small class="muted">${esc(p.label)}</small>${li ? ` <span class="chip ${li.valid === 0 ? "bad" : li.line_type === "mobile" ? "good" : ""}">${li.valid === 0 ? "Not in service" : esc(LINE[li.line_type] || li.line_type || "Unknown")}</span>` : ""}
          <small class="muted">${m !== "device" && !p.e164 ? " · add the country code to call through Twilio" : p.blocked ? " · do not call" : p.capped ? ` · ${p.tries24h}/3 today, try tomorrow` : p.tries24h ? ` · ${p.tries24h}/3 today` : ""}</small></span>
          <button class="${i === bestPhone(t)?.i ? "primary" : "ghost"}" type="button" data-call="${i}" ${off ? "disabled" : ""}>☎ Call</button></div>`;
      }).join("")}</div>
      <div class="row small dc-tools">${S.data.twilio ? `<button class="link" type="button" id="lineBtn">Check number types (~$0.01 each)</button>` : ""}<button class="link" type="button" id="enrichBtn">Find the owner's direct line</button>
        <label class="inline small">Dial with <select id="dMode">${modes().map(([k, l]) => `<option value="${k}" ${k === m ? "selected" : ""}>${l}</option>`).join("")}</select></label></div>
      <div class="dc-live" id="dlive" aria-live="polite"></div>
      <div class="dc-ai" id="dai" hidden aria-live="polite"></div>
    </div>
    <div class="panel dlog">
      <div class="dlog-head"><h3 class="h3">Outcome</h3><span class="muted small">1–0 · Alt+key while typing</span></div>
      <div class="dispos">${Object.entries(D).map(([k, d]) => `<button type="button" class="ghost ${k === "dnc" ? "danger-soft" : ""}" data-d="${k}"><kbd>${d.key}</kbd> ${esc(d.label)}</button>`).join("")}</div>
      <textarea id="notes" rows="3" placeholder="Notes: what they said, family, staff, timing, gatekeeper's name… (/ to jump here)"></textarea>
      <div class="dlog-row">
        <label class="field inline small">Call back at <input type="datetime-local" id="cbAt"></label><span class="muted small" id="cbTheirs"></span>
        <label class="field inline small">or next date <input type="date" id="ndate"></label>
      </div>
      <details class="followups" ${S.prefs.followText ? "open" : ""}><summary>Follow-up after a voicemail or no answer <span class="muted small">(waits for your OK in the Inbox)</span></summary>
        <label class="check small"><input type="checkbox" id="fText" ${S.prefs.followText ? "checked" : ""}> Text them</label>
        <textarea id="fTextBody" rows="2">${esc(fill(S.data.settings.followup_text, t))}</textarea>
        ${t.email ? `<label class="check small"><input type="checkbox" id="fMail"> Email ${esc(t.email)}</label>` : ""}
      </details>
      <div class="row"><button class="link" type="button" id="skip">Skip <kbd>N</kbd></button><span class="spacer"></span><button class="link small" type="button" id="keysHelp">Shortcuts <kbd>?</kbd></button></div>
    </div>`;
  drawLive();
  $$("[data-call]").forEach((b) => b.addEventListener("click", () => startCall(+b.dataset.call)));
  $("#dMode").addEventListener("change", (e) => { S.prefs.mode = e.target.value; local.set("dialer2", S.prefs); drawLive(); });
  $("#lineBtn")?.addEventListener("click", async (e) => {
    e.currentTarget.disabled = true; e.currentTarget.textContent = "Checking…";
    try { const lines2 = await post(`/api/dialer/lines/${t.id}`); const b = S.brief.get(t.id) || {}; b.lines = lines2; S.brief.set(t.id, b); if (S.queue[S.cur] === t && !S.call) drawMain(); } catch (err) { fail(err); }
  });
  $("#enrichBtn").addEventListener("click", async () => { const out = await deepEnrichDialog({ id: t.id, name: t.name, website: t.website }); if (out) renderDialer(++session.seq, new URLSearchParams({ target: String(t.id) })); });
  $$("[data-d]").forEach((b) => b.addEventListener("click", () => logOutcome(b.dataset.d)));
  $("#skip").addEventListener("click", () => next(false));
  $("#keysHelp").addEventListener("click", helpDialog);
  $("#fText").addEventListener("change", (e) => { S.prefs.followText = e.target.checked; local.set("dialer2", S.prefs); });
  // Show the callback in the owner's own clock too.
  $("#cbAt").addEventListener("input", (e) => {
    const v = e.target.value, el = $("#cbTheirs");
    if (!v || !w.zone) { el.textContent = ""; return; }
    el.textContent = `= ${new Intl.DateTimeFormat([], { timeZone: w.zone, weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(v))} their time`;
  });
}
const fill = (tpl, t) => String(tpl || "").replaceAll("{first}", firstName(t) || "there").replaceAll("{me}", (S.me.user?.name || "").split(" ")[0] || "me").replaceAll("{company}", t.name);

// ------------------------------------------------------------------ brief, script, history
function drawSide(tab = S.sideTab || "brief") {
  const t = S.queue[S.cur]; const el = $("#dside"); if (!el || !t) return;
  S.sideTab = tab;
  const b = S.brief.get(t.id);
  el.innerHTML = `<div class="panel"><nav class="ph-tabs side-tabs">${[["brief", "Brief"], ["script", "Script"], ["history", "History"]].map(([k, l]) => `<button type="button" data-side="${k}" class="${tab === k ? "on" : ""}">${l}</button>`).join("")}</nav><div class="side-body" id="sidebody">${b ? sideBody(t, b, tab) : `<p class="muted small">Loading…</p>`}</div></div>`;
  $$("[data-side]", el).forEach((x) => x.addEventListener("click", () => drawSide(x.dataset.side)));
  if (!b) api(`/api/dialer/brief/${t.id}`).then((d) => { if (!S) return; S.brief.set(t.id, d); if (S.queue[S.cur] === t && $("#dmain")) { drawSide(); if (!S.call) drawMain(); } }).catch(() => {});
}
function sideBody(t, b, tab) {
  const first = firstName(t) || "there", me = S.me.user?.name || "me", city = (t.location || "").split(",")[0] || "the area";
  const i = b.intel;
  if (tab === "brief") {
    return `${i ? `<div class="brief-score"><b>${i.score}</b><span>/100 seller readiness</span></div><p class="small">${esc(i.reason || "")}</p>
      ${i.hooks?.length ? `<h4>Talking points</h4><ul class="small hooks">${i.hooks.map((h) => `<li>${esc(h)}</li>`).join("")}</ul>` : ""}
      ${i.signals?.length ? `<h4>Signals</h4><ul class="small">${i.signals.map((h) => `<li>${esc(h)}</li>`).join("")}</ul>` : ""}
      <p class="muted small">${[i.ownership && i.ownership !== "unknown" ? i.ownership : "", i.years ? `${i.years} years` : "", i.employees ? `~${i.employees} staff` : "", i.google?.rating ? `${i.google.rating}★ (${i.google.reviews})` : ""].filter(Boolean).map(esc).join(" · ")}</p>`
      : `<p class="muted small">No research yet. <a href="#/targets/${t.id}">Run the dossier</a> for talking points, readiness and owner signals (about 2¢).</p>`}
      ${t.motivation ? `<h4>Why they might sell</h4><p class="small">${esc(t.motivation)}</p>` : ""}
      ${b.calls.length ? `<h4>Last call</h4><p class="small"><b>${esc(S.data.dispositions[b.calls[0].disposition]?.label || b.calls[0].disposition)}</b> · ${when(b.calls[0].created_at)}${b.calls[0].user_name ? ` · ${esc(b.calls[0].user_name)}` : ""}${b.calls[0].notes ? `<br>${esc(b.calls[0].notes)}` : ""}</p>` : ""}`;
  }
  if (tab === "script") {
    const hook = i?.hooks?.[0];
    return `<p class="small"><b>Open</b> “Hi ${esc(first)}, it's ${esc(me)}. I'll be quick. I own a business locally and I've been getting to know ${esc((t.industry || "business").toLowerCase())} owners in ${esc(city)}. ${hook ? esc(hook.replace(/\.$/, "")) + ". " : `${esc(t.name)} keeps coming up for how well it's run. `}I'm not selling anything. Have you ever thought about what happens to the business when you step back one day?”</p>
      <p class="small"><b>Goal</b> a second conversation (coffee or a proper call next week). No revenue, profit or price talk on call one.</p>
      <details><summary>“How did you get my number?”</summary><p class="small">“It's on your website / the company register. I'd rather call than send a cold letter.”</p></details>
      <details><summary>“What's it worth?” / “What would you pay?”</summary><p class="small">“Honestly, I'd never guess on a first call, and I wouldn't trust anyone who did. What I can tell you is how I work: I keep the team, the name and the customers. Could we grab a coffee so I can understand the business properly?”</p></details>
      <details><summary>“Not interested”</summary><p class="small">“Completely fair, most owners I speak to aren't, today. Can I send you a short letter so you have my details for whenever the time is right?”</p></details>
      <details><summary>“Send me an email”</summary><p class="small">“Happy to. So it's actually useful to you: is it more about timing, or what happens to the team?” Then log Callback or Spoke and tick the email follow-up.</p></details>
      <details><summary>Gatekeeper</summary><p class="small">“It's ${esc(me)} for ${esc(first === "there" ? "the owner" : first)}. It's a personal matter about the business; when's the best time to catch them?” Write their name in the notes.</p></details>
      <details><summary>Voicemail (read it yourself)</summary><p class="small">“Hi ${esc(first)}, it's ${esc(me)}. I'm a local business owner with a quick question about ${esc(t.name)}, nothing to sell. I'll try you again ${new Date(Date.now() + 2 * 864e5).toLocaleDateString([], { weekday: "long" })}, or call me back on this number. Thanks.” Under 20 seconds.</p><p class="muted small">Warplan never drops recorded voicemails: prerecorded messages to mobiles need prior consent in the US.</p></details>
      <p class="small"><a href="#/simulator?target=${t.id}">Practise this owner in the Simulator →</a></p>`;
  }
  return `${b.events.length ? `<ul class="side-events">${b.events.map((e) => `<li><small class="muted">${when(e.created_at)} · ${esc(e.user_name || "")}</small><p class="small">${esc(e.body)}</p></li>`).join("")}</ul>` : `<p class="muted small">Nothing on the timeline yet.</p>`}`;
}

// ------------------------------------------------------------------ the call itself
function drawLive() {
  const el = $("#dlive"); if (!el) return;
  const t = S.queue[S.cur], c = S.call, m = mode();
  if (S.countdown) { el.innerHTML = `<div class="live countdown"><p><b>${esc(S.countdown.label)}</b> in <span class="big">${S.countdown.left}</span></p><button class="ghost" type="button" id="cdStop">Pause <kbd>Esc</kbd></button></div>`; $("#cdStop").addEventListener("click", cancelCountdown); return; }
  if (!c) {
    const p = bestPhone(t);
    const why = !t.window?.callable ? (t.window?.opens_at ? `Calling opens ${new Date(t.window.opens_at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })} your time` : "Outside their calling hours") : !p ? "No number left to try today" : "";
    el.innerHTML = `<div class="live idle"><button class="call-big" type="button" id="callBig" ${p && t.window?.callable !== false ? "" : "disabled"}>☎ Call ${p ? esc(p.value) : ""}</button><p class="muted small">${why ? esc(why) : `<kbd>Space</kbd> to call · ${m === "browser" ? "from this browser, with your local number" : m === "bridge" ? "Twilio rings your phone first, then connects them" : "shows a QR code: scan it with your phone to dial from your own number"}`}</p></div>`;
    $("#callBig").addEventListener("click", () => p && startCall(p.i));
    return;
  }
  const secs = c.liveAt ? Math.round((Date.now() - c.liveAt) / 1000) : c.startedAt ? Math.round((Date.now() - c.startedAt) / 1000) : 0;
  const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  if (c.phase === "checking") el.innerHTML = `<div class="live"><p class="state">Checking…</p></div>`;
  else if (c.phase === "ringing") el.innerHTML = `<div class="live ringing"><p class="state"><span class="pulse"></span>${c.mode === "bridge" && !c.bridged ? "Ringing your phone…" : "Ringing…"} <span class="mono">${clock}</span>${c.doubled ? ' <span class="chip">double dial</span>' : ""}</p><button class="hang" type="button" id="hang">Hang up <kbd>Space</kbd></button></div>`;
  else if (c.phase === "live") el.innerHTML = `<div class="live on"><p class="state"><span class="dot-live"></span>Connected <span class="mono big">${clock}</span></p><div class="row center-row">${c.mode === "browser" ? `<button class="ghost" type="button" id="mute">${c.muted ? "Unmute" : "Mute"} <kbd>M</kbd></button><button class="ghost" type="button" id="pad">Keypad</button>` : ""}<button class="hang" type="button" id="hang">Hang up <kbd>Space</kbd></button></div><div class="ph-keys small-keys" id="dtmf" hidden>${"123456789*0#".split("").map((k) => `<button type="button" data-dtmf="${k}">${k}</button>`).join("")}</div></div>`;
  else if (c.phase === "away") el.innerHTML = `<div class="live dlive-qr"><div class="ph-qr">${c.qr || ""}</div><div><p class="state">Call ${esc(c.number || "")} <span class="mono">${clock}</span></p><p class="small"><b>Scan with your phone's camera</b> and tap the number: it rings from your own number. When you hang up, press the outcome (1–0).</p><a class="ghost small" href="tel:${esc(String(c.number || "").replace(/[^\d+]/g, ""))}" data-handled="1" id="dHere">${telWorks() ? "Ring again on this computer" : "Call on this computer instead"}</a><p class="muted small" id="dHint" ${c.hint ? "" : "hidden"}>Nothing opened: this computer isn't linked to your phone. The QR code always works. To link it, open the phone (bottom right) → Setup.</p></div></div>`;
  else el.innerHTML = `<div class="live ended"><p class="state">${c.answered == null ? "Back from your phone" : c.answered ? "Call ended" : "No answer"}${c.duration ? ` · <span class="mono">${Math.floor(c.duration / 60)}:${String(c.duration % 60).padStart(2, "0")}</span>` : ""}</p><p class="muted small">${c.answered == null ? "How did it go? Press 1–0" : c.answered ? "Log the outcome (5–8)" : "Press 1 (no answer) or 2 (left a voicemail)"}${c.error ? ` · ${esc(c.error)}` : ""}</p>${!c.answered && c.mode !== "device" && !c.doubled && c.canRetry !== false ? `<button class="ghost small" type="button" id="redial">Call again now <kbd>D</kbd></button>` : ""}</div>`;
  $("#hang")?.addEventListener("click", endCall);
  $("#dHere")?.addEventListener("click", () => watchHandoff(() => { if (S?.call) { S.call.hint = true; drawLive(); } }));
  $("#mute")?.addEventListener("click", () => { c.muted = toggleMute(); drawLive(); });
  $("#pad")?.addEventListener("click", () => { $("#dtmf").hidden = !$("#dtmf").hidden; });
  $$("[data-dtmf]").forEach((b) => b.addEventListener("click", () => sendDigit(b.dataset.dtmf)));
  $("#redial")?.addEventListener("click", () => startCall(c.phoneIdx, { retry: true, doubled: true }));
}

async function startCall(i, { retry = false, doubled = false } = {}) {
  const t = S.queue[S.cur], p = t.phones[i];
  if (!p || (S.call && !["ended"].includes(S.call.phase))) return;
  cancelCountdown();
  const m = mode();
  S.call = { phase: "checking", mode: m, phoneIdx: i, startedAt: Date.now(), doubled, answered: false };
  clearInterval(S.tick); S.tick = setInterval(() => { if (!$("#dlive")) return clearInterval(S.tick); if (["ringing", "live", "away"].includes(S.call?.phase)) drawLive(); }, 1000);
  drawLive();
  S.onPhone = (kind, d) => phoneEvent(kind, d);
  if (m === "device") {
    // A QR code to dial from your own phone; if this computer is linked to the phone, it rings out directly too.
    const num = p.e164 || p.value;
    if (telWorks()) deviceCall(num, { targetId: t.id, fromDialer: true });
    Object.assign(S.call, { phase: "away", number: num });
    qrSvg(`tel:${String(num).replace(/[^\d+]/g, "")}`).then((svg) => { if (S?.call?.number === num) { S.call.qr = svg; drawLive(); } }).catch(() => {});
    drawLive();
    post("/api/dialer/predial", { target_id: t.id, phone: p.value, retry, session_id: S.session?.id }).catch((e) => { if (e.data?.code) toast(e.message, "error"); });
    return;
  }
  if (m === "browser") {
    S.call.phase = "ringing"; drawLive();
    await dial(p.e164 || p.value, { targetId: t.id, fromDialer: true, retry });
    return;
  }
  // Twilio bridge: rings your phone, then connects them.
  try {
    const r = await post("/api/dialer/bridge", { target_id: t.id, phone: p.value, retry, session_id: S.session?.id });
    Object.assign(S.call, { phase: "ringing", sid: r.call_sid });
    drawLive();
    S.call.poll = setInterval(async () => {
      if (!$("#dmain") || !S.call?.sid) return clearInterval(S.call?.poll);
      try {
        const s = await api(`/api/dialer/bridge/${S.call.sid}`);
        if (s.status === "in-progress" && S.call.phase !== "live") { Object.assign(S.call, { phase: "live", liveAt: Date.now(), bridged: true, answered: true }); drawLive(); }
        if (["completed", "busy", "failed", "no-answer", "canceled"].includes(s.status)) { clearInterval(S.call.poll); callEnded({ duration: s.duration, answered: S.call.answered || (s.duration || 0) > 20 }); }
      } catch { /* keep polling */ }
    }, 2500);
  } catch (e) { callFailed(e.message, e.data?.code); }
}
function phoneEvent(kind, d) {
  if (!S.call) return;
  if (kind === "ringing") { S.call.phase = "ringing"; drawLive(); }
  if (kind === "connected") { Object.assign(S.call, { phase: "live", liveAt: Date.now(), answered: true }); drawLive(); }
  if (kind === "failed") callFailed(d.error, d.code);
  if (kind === "ended") {
    if (d.via === "phone") return callEnded({ duration: d.duration, answered: null, sid: null });
    callEnded({ duration: d.duration, answered: !!d.answered, sid: d.sid });
  }
}
function callFailed(msg, code) {
  if (!S.call) return;
  Object.assign(S.call, { phase: "ended", error: msg, canRetry: !code });
  if (code === "cap" || code === "dnc" || code === "hours") { const t = S.queue[S.cur]; const p = t.phones[S.call.phoneIdx]; if (p && code !== "hours") p[code === "dnc" ? "blocked" : "capped"] = true; S.call = null; drawMain(); toast(msg, "error"); return; }
  drawLive();
}
function callEnded({ duration, answered, sid }) {
  const c = S.call; if (!c || c.phase === "ended") return;
  Object.assign(c, { phase: "ended", duration: duration ?? Math.round((Date.now() - (c.liveAt || c.startedAt)) / 1000), answered: answered ?? null, callSid: sid || c.sid });
  clearInterval(c.poll);
  // Double dial: owners often pick up the second call when it comes straight after the first.
  if (c.mode !== "device" && answered === false && !c.doubled && S.prefs.doubleDial && S.queue[S.cur]?.phones[c.phoneIdx]?.tries24h < 2) {
    countdown(3, "Double-dialing", () => startCall(c.phoneIdx, { retry: true, doubled: true }));
    return;
  }
  drawLive();
  // Recorded calls (opt-in): the AI notes arrive a few seconds after Twilio finishes the recording.
  if (S.data.settings.record && c.callSid && c.answered !== false && (c.duration || 0) >= 5) aiNotes(c.callSid);
  // Leave the keyboard on the outcome keys (focus goes back to the page if it was in a button).
  if (document.activeElement?.tagName === "BUTTON") document.activeElement.blur();
}
// Poll for the AI notes of a recorded call and show them under it: summary, the outcome it heard (one key to log),
// next step, callback time, owner facts. "Use these notes" drops them into the notes box.
async function aiNotes(callSid) {
  const box = $("#dai"); if (!box) return;
  const t = S.queue[S.cur];
  box.hidden = false;
  box.innerHTML = `<p class="muted small"><span class="pulse small-pulse"></span> Listening back to the call and writing the notes…</p>`;
  const started = Date.now();
  while (Date.now() - started < 150000) {
    await new Promise((res) => setTimeout(res, 4000));
    if (!$("#dai") || S.queue[S.cur] !== t) return;
    let r; try { r = await api(`/api/calls/notes?call_sid=${encodeURIComponent(callSid)}`); } catch { continue; }
    if (r.status === "failed") { box.innerHTML = `<p class="muted small">Couldn't write AI notes for this call: ${esc(r.error || "unknown error")}</p>`; return; }
    if (r.status !== "done" || !r.notes) continue;
    const n = r.notes, D = S.data.dispositions, d = D[n.outcome];
    box.innerHTML = `<div class="ai-head"><b>AI notes</b><span class="muted small">${n.sentiment ? esc(n.sentiment) : ""}${r.audio ? ` · <a href="${esc(r.audio)}" target="_blank" rel="noopener">play recording</a>` : ""}</span></div>
      <p class="small">${esc(n.summary || "")}</p>
      ${n.next_step ? `<p class="small"><b>Next:</b> ${esc(n.next_step)}${n.callback_when ? ` <span class="chip">⏰ ${esc(n.callback_when)}</span>` : ""}</p>` : ""}
      ${n.owner_facts?.length ? `<ul class="small ai-facts">${n.owner_facts.slice(0, 6).map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}
      <div class="row">${d ? `<button class="primary small" type="button" id="aiLog">Log “${esc(d.label)}” <kbd>${d.key}</kbd></button>` : ""}<button class="ghost small" type="button" id="aiUse">Use these notes</button></div>`;
    $(`[data-d="${n.outcome}"]`)?.classList.add("suggested");
    $("#aiUse").addEventListener("click", () => { const ta = $("#notes"); ta.value = [ta.value.trim(), n.summary, n.notes, n.next_step ? `Next: ${n.next_step}` : "", n.callback_when ? `Callback: ${n.callback_when}` : ""].filter(Boolean).join("\n"); toast("Notes added"); });
    $("#aiLog")?.addEventListener("click", () => { const ta = $("#notes"); if (!ta.value.trim()) ta.value = [n.summary, n.notes].filter(Boolean).join("\n"); logOutcome(n.outcome); });
    return;
  }
  box.innerHTML = `<p class="muted small">The AI notes are taking a while: they'll land on the timeline when ready.</p>`;
}

function endCall() {
  const c = S.call; if (!c) return;
  if (c.mode === "browser") hangUp();
  else if (c.mode === "bridge" && c.sid) api(`/api/dialer/bridge/${c.sid}`, { method: "DELETE" }).catch(fail);
}
function cleanupCall() { clearInterval(S?.call?.poll); clearInterval(S?.tick); cancelCountdown(); }

function countdown(n, label, fn) {
  cancelCountdown();
  S.countdown = { left: n, label, fn };
  drawLive();
  S.countdown.timer = setInterval(() => {
    if (!S.countdown || !$("#dlive")) return cancelCountdown();
    S.countdown.left -= 1;
    if (S.countdown.left <= 0) { const f = S.countdown.fn; cancelCountdown(); f(); } else drawLive();
  }, 1000);
}
function cancelCountdown() { if (!S?.countdown) return; clearInterval(S.countdown.timer); S.countdown = null; drawLive(); }

// ------------------------------------------------------------------ outcome → next owner
async function logOutcome(k) {
  const t = S.queue[S.cur], c = S.call, D = S.data.dispositions;
  if (!t || S.logging) return;
  if (["ringing", "live"].includes(c?.phase)) { toast("Hang up first, then log the outcome", "error"); return; }
  if (k === "dnc" && !(await confirmBox("Add to the do-not-call list?", `${t.phones[c?.phoneIdx ?? 0]?.value || "This number"} won't be called or texted from this workspace again.`, "Do not call"))) return;
  S.logging = true;
  $$("[data-d]").forEach((b) => { b.disabled = true; });
  const cbAt = $("#cbAt")?.value ? new Date($("#cbAt").value).toISOString() : undefined;
  const missed = ["no_answer", "voicemail"].includes(k);
  const body = {
    target_id: t.id, phone: t.phones[c?.phoneIdx ?? bestPhone(t)?.i ?? 0]?.value, disposition: k, notes: $("#notes").value,
    duration: c?.duration ?? null, answered: c?.answered ?? ANSWERED_KEYS.has(k), next_date: $("#ndate").value || undefined, callback_at: cbAt,
    via: c?.mode === "browser" ? "browser" : c?.mode === "bridge" ? "twilio" : "phone", call_sid: c?.callSid || undefined, session_id: S.session?.id,
    ...(missed && $("#fText")?.checked && { follow_text: $("#fTextBody").value }),
    ...($("#fMail")?.checked && { follow_email: { subject: `Quick question about ${t.name}`, body: $("#fTextBody").value } }),
  };
  try {
    const r = await post("/api/calls", body);
    toast(r.receipt);
    S.call = null;
    refreshSession();
    next(true);
  } catch (e) { fail(e); $$("[data-d]").forEach((b) => { b.disabled = false; }); }
  finally { S.logging = false; }
}
function next(logged) {
  if (S.call && !["ended"].includes(S.call.phase)) { toast("Finish the call first", "error"); return; }
  cleanupCall();
  S.call = null;
  if (logged) { S.queue.splice(S.cur, 1); if (S.cur >= S.queue.length) S.cur = 0; }
  else S.cur = (S.cur + 1) % S.queue.length;
  drawQueue(); showLead().then(() => {
    if (!S || !$("#dmain")) return;
    // Auto-advance: with Twilio the next call starts by itself after a short countdown (Esc pauses).
    const t = S.queue[S.cur];
    if (!logged || !t || mode() === "device" || !S.prefs.advance || !t.window?.callable) return;
    const p = bestPhone(t); if (!p) return;
    countdown(S.prefs.advance, `Calling ${t.name}`, () => startCall(p.i));
  });
}

// ------------------------------------------------------------------ keyboard
function hotkeys(e) {
  if (!$("#dmain")) { keyHandler = null; return; }
  if (document.querySelector("dialog[open]")) return;
  const typing = /^(TEXTAREA|INPUT|SELECT)$/.test(document.activeElement?.tagName);
  const D = S.data.dispositions;
  if (e.key === "Escape") { if (S.countdown) { e.preventDefault(); cancelCountdown(); } else if (typing) document.activeElement.blur(); return; }
  const dk = Object.entries(D).find(([, d]) => (!typing && d.key === e.key && !e.metaKey && !e.ctrlKey) || (e.altKey && e.code === `Digit${d.key}`));
  if (dk) { e.preventDefault(); logOutcome(dk[0]); return; }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  const c = S.call, t = S.queue[S.cur];
  if (e.code === "Space") {
    e.preventDefault();
    if (S.countdown) { const f = S.countdown.fn; cancelCountdown(); f(); return; }
    if (!c) { const p = bestPhone(t); if (p && t.window?.callable) startCall(p.i); return; }
    if (["ringing", "live"].includes(c.phase)) endCall();
    return;
  }
  const k = e.key.toLowerCase();
  if (k === "n" || e.key === "ArrowDown") { e.preventDefault(); next(false); }
  else if (e.key === "ArrowUp") { e.preventDefault(); if (!c || c.phase === "ended") { cancelCountdown(); S.cur = (S.cur - 1 + S.queue.length) % S.queue.length; drawQueue(); showLead(); } }
  else if (k === "m" && c?.phase === "live" && c.mode === "browser") { c.muted = toggleMute(); drawLive(); }
  else if (k === "d" && c?.phase === "ended" && !c.answered && c.mode !== "device") startCall(c.phoneIdx, { retry: true, doubled: true });
  else if (e.key === "/") { e.preventDefault(); $("#notes")?.focus(); }
  else if (e.key === "?") helpDialog();
}
function helpDialog() {
  dialog({ title: "Dialer shortcuts", submit: "", html: `<table class="mini-table keys-table"><tbody>
    ${[["Space", "Call the best number · hang up · skip the countdown"], ["1 – 9, 0", "Log the outcome (Alt + key while typing)"], ["N or ↓", "Skip to the next owner"], ["↑", "Back to the previous owner"], ["M", "Mute / unmute (browser calls)"], ["D", "Call the same number again (double dial)"], ["/", "Jump to the notes"], ["Esc", "Pause the auto-dial countdown"]].map(([k, v]) => `<tr><td><kbd>${k}</kbd></td><td>${v}</td></tr>`).join("")}
  </tbody></table>` });
}

async function settingsDialog(reload) {
  const p = S.prefs, owner = !!S.me?.isOwner;
  const r = await dialog({ title: "Dialer settings", html: `
    <label class="field">Auto-dial the next owner after logging <select name="advance">${[[0, "Off"], [3, "after 3 seconds"], [5, "after 5 seconds"], [10, "after 10 seconds"]].map(([v, l]) => `<option value="${v}" ${+p.advance === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
    <p class="muted small">Only when calling through Twilio (this browser, or Twilio ringing your phone). With your own phone the next owner is lined up and you press Space.</p>
    <label class="check"><input type="checkbox" name="doubleDial" ${p.doubleDial ? "checked" : ""}> Double dial: if nobody answers, call the same number once more straight away</label>
    <hr>
    <p class="small"><b>Workspace rules</b> (the same for everyone)</p>
    <label class="check"><input type="checkbox" name="sundays" ${S.data.settings.sundays ? "checked" : ""} ${owner ? "" : "disabled"}> Allow calls on Sundays</label>
    <label class="check"><input type="checkbox" name="record" ${S.data.settings.record ? "checked" : ""} ${owner ? "" : "disabled"}> Record Twilio calls and write AI notes</label>
    <label class="field">What the owner hears first <input name="record_notice" maxlength="200" value="${esc(S.data.settings.record_notice || "Hi, just so you know, this call is recorded.")}" ${owner ? "" : "disabled"}></label>
    <p class="muted small">Every recorded call starts with this notice, so it's legal everywhere you call (including places where everyone on the call must know). The AI transcribes the call and writes the summary, outcome, next step and owner facts. Recordings are kept on your Twilio account.</p>
    <label class="field">Default follow-up text <textarea name="followup_text" rows="3" ${owner ? "" : "disabled"}>${esc(S.data.settings.followup_text)}</textarea></label>
    <p class="muted small">Always on: 8am–9pm in the owner's time zone (8pm in FL, OK, MD, WA, MS, AL), at most 3 attempts per number per 24 hours, ${S.data.rules.retry_gap_min} minutes between attempts (except a double dial), and the do-not-call list. No parallel or predictive dialing and no recorded voicemail drops: every call has you on it.</p>` });
  if (!r) return;
  p.advance = +r.advance; p.doubleDial = !!r.doubleDial; local.set("dialer2", p);
  if (owner && (!!r.sundays !== S.data.settings.sundays || r.followup_text !== S.data.settings.followup_text || !!r.record !== !!S.data.settings.record || r.record_notice !== S.data.settings.record_notice)) {
    try { await post("/api/dialer/settings", { sundays: !!r.sundays, followup_text: r.followup_text, record: !!r.record, record_notice: r.record_notice }, "PUT"); } catch (e) { fail(e); return; }
  }
  toast("Saved"); reload();
}

// ------------------------------------------------------------------ insights
const DOWS = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [0, "Sun"]];
const HOURS = Array.from({ length: 13 }, (_, i) => i + 8); // 8am–8pm slots
const hourLabel = (h) => `${h % 12 || 12}${h < 12 ? "a" : "p"}`;
async function renderInsights(seq) {
  const d = await api("/api/dialer/insights");
  if (stale(seq)) return;
  const cell = new Map(d.grid.map((g) => [`${g.dow}:${g.hour}`, g]));
  const maxRate = Math.max(0.01, ...d.grid.filter((g) => g.dials >= 5).map((g) => g.answered / g.dials));
  const total = d.dispositions.reduce((s, x) => s + x.n, 0);
  const D = { no_answer: "No answer", voicemail: "Voicemail", gatekeeper: "Gatekeeper", callback: "Call back", connected: "Spoke", interested: "Interested", meeting: "Meeting", not_interested: "Not interested", wrong_number: "Wrong number", dnc: "Do not call" };
  view().innerHTML = `
    <header class="page-head"><p class="eyebrow">Power dialer</p><h1>When owners pick up.</h1><p class="lede">From your own calls over the last 90 days, in each owner's local time. Call in the dark cells.</p></header>
    ${subnav("insights")}
    <div class="metric-strip">${d.best_slots.length ? d.best_slots.map((b, i) => `<div><span>${i === 0 ? "Best slot" : `#${i + 1}`}</span><b>${DOWS.find(([k]) => k === b.dow)?.[1]} ${hourLabel(b.hour)}</b><small class="muted">${Math.round(b.rate * 100)}% answered · ${b.dials} dials</small></div>`).join("") : `<div><span>Best slot</span><b>—</b><small class="muted">Needs 5+ dials in a slot</small></div>`}<div><span>Answer rate, 7 days</span><b>${d.workspace_answer_rate == null ? "—" : `${d.workspace_answer_rate}%`}</b></div></div>
    <section class="panel">
      <div class="panel-head"><h2 class="h3">Answer rate by owner's local hour</h2><button class="link small" type="button" id="asTable">Show as table</button></div>
      <div class="heat" id="heat" role="img" aria-label="Answer rate by weekday and hour">
        <div class="heat-row heat-hours"><span></span>${HOURS.map((h) => `<span>${hourLabel(h)}</span>`).join("")}</div>
        ${DOWS.map(([k, l]) => `<div class="heat-row"><span>${l}</span>${HOURS.map((h) => { const g = cell.get(`${k}:${h}`); const ok = g && g.dials >= 5; const pct = ok ? Math.round((100 * g.answered) / g.dials) : null; return `<span class="heat-cell ${ok ? "" : "thin"}" style="${ok ? `--a:${Math.round(12 + 88 * (g.answered / g.dials) / maxRate)}%` : ""}" data-tip="${l} ${hourLabel(h)}: ${g ? `${g.dials} dials, ${g.answered} answered${ok ? ` (${pct}%)` : ""}, ${g.conversations} conversations` : "no dials"}"></span>`; }).join("")}</div>`).join("")}
      </div>
      <div class="heat-legend small muted"><span>Answer rate</span><span class="heat-ramp"></span><span>low → high</span><span class="heat-cell thin"></span><span>fewer than 5 dials</span></div>
      <div class="table-wrap" id="heatTable" hidden><table class="mini-table"><thead><tr><th>Day</th><th>Hour</th><th>Dials</th><th>Answered</th><th>Rate</th><th>Conversations</th></tr></thead><tbody>${d.grid.sort((a, b) => a.dow - b.dow || a.hour - b.hour).map((g) => `<tr><td>${DOWS.find(([k]) => k === g.dow)?.[1] || ""}</td><td>${hourLabel(g.hour)}</td><td>${g.dials}</td><td>${g.answered}</td><td>${g.dials ? Math.round((100 * g.answered) / g.dials) : 0}%</td><td>${g.conversations}</td></tr>`).join("")}</tbody></table></div>
    </section>
    <div class="settings-grid">
      <section class="panel">
        <div class="panel-head"><h2 class="h3">Caller ID health</h2><span class="muted small">last 7 days</span></div>
        <p class="muted small">A number answered far less than your others is probably being labelled “Spam likely”. Rest it, register it with the carriers (free via the Free Caller Registry), or add another local number. Warplan spreads calls across your numbers and prefers ones under ${d.daily_cap} dials a day.</p>
        ${d.numbers.length ? `<div class="table-wrap"><table class="mini-table"><thead><tr><th>Number</th><th>Today</th><th>7 days</th><th>Answered</th><th>Status</th></tr></thead><tbody>${d.numbers.map((n) => `<tr><td class="mono">${esc(n.caller_id)}</td><td>${n.today}${n.over_cap ? " ⚠" : ""}</td><td>${n.dials_7d}</td><td>${n.answer_rate == null ? "—" : `${n.answer_rate}%`}</td><td>${n.risk === "high" ? `<span class="status-chip bad">⚠ Likely flagged</span>` : n.risk === "watch" ? `<span class="status-chip warn">◐ Watch</span>` : `<span class="status-chip good">✓ Healthy</span>`}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted small">No Twilio calls yet.</p>`}
      </section>
      <section class="panel">
        <div class="panel-head"><h2 class="h3">Where calls end up</h2><span class="muted small">last 30 days · ${total} logged</span></div>
        ${total ? `<div class="bars">${d.dispositions.sort((a, b) => b.n - a.n).map((x) => `<div class="bar-row" title="${esc(D[x.disposition] || x.disposition)}: ${x.n}"><span>${esc(D[x.disposition] || x.disposition)}</span><span class="bar"><i style="width:${Math.max(2, (100 * x.n) / d.dispositions.reduce((m, y) => Math.max(m, y.n), 1))}%"></i></span><b>${x.n}</b></div>`).join("")}</div>` : `<p class="muted small">Log a few calls to see this.</p>`}
      </section>
    </div>`;
  $("#asTable").addEventListener("click", (e) => { const tb = $("#heatTable"); tb.hidden = !tb.hidden; e.currentTarget.textContent = tb.hidden ? "Show as table" : "Hide table"; });
  // Hover tooltip on each cell.
  const tip = document.createElement("div"); tip.className = "chart-tip"; tip.hidden = true; document.body.append(tip);
  $$(".heat-cell[data-tip]").forEach((c) => {
    c.addEventListener("mouseenter", () => { tip.textContent = c.dataset.tip; tip.hidden = false; const r = c.getBoundingClientRect(); tip.style.left = `${r.left + r.width / 2 + scrollX}px`; tip.style.top = `${r.top + scrollY - 8}px`; });
    c.addEventListener("mouseleave", () => { tip.hidden = true; });
  });
  window.addEventListener("hashchange", () => tip.remove(), { once: true });
}

async function renderTeam(seq) {
  const d = await api("/api/dialer/team");
  if (stale(seq)) return;
  const fmt = (s) => `${Math.floor((s || 0) / 3600)}h ${Math.round(((s || 0) % 3600) / 60)}m`;
  view().innerHTML = `
    <header class="page-head"><p class="eyebrow">Power dialer</p><h1>The floor.</h1><p class="lede">Who's dialing now and this week's numbers. Meetings first: that's the scoreboard that matters.</p></header>
    ${subnav("team")}
    <section class="panel"><div class="panel-head"><h2 class="h3">Dialing now</h2></div>${d.dialing_now.length ? `<div class="row">${d.dialing_now.map((u) => `<span class="chip live-chip"><span class="dot-live"></span>${esc(u.name || "Teammate")} · since ${new Date(u.started_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>`).join("")}</div>` : `<p class="muted small">Nobody is in a session right now.</p>`}</section>
    <section class="panel"><div class="panel-head"><h2 class="h3">This week</h2></div>
      ${d.leaderboard.length ? `<div class="table-wrap"><table class="list-table"><thead><tr><th>#</th><th>Who</th><th>Meetings</th><th>Conversations</th><th>Dials</th><th>Today</th><th>Talk time</th></tr></thead><tbody>${d.leaderboard.map((u, i) => `<tr><td>${i + 1}</td><td><b>${esc(u.name || "API / agent")}</b></td><td><b>${u.meetings_week || 0}</b></td><td>${u.conv_week || 0}</td><td>${u.dials_week}</td><td class="small">${u.dials_today} dials · ${u.conv_today || 0} conv.</td><td>${fmt(u.talk_week)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted small">No dials this week yet.</p>`}
    </section>`;
}
