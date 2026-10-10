// The phone: a pop-up softphone on every page. Call from the browser (Twilio Voice, WebRTC), text, see recent calls,
// answer incoming calls. Clicking any phone number in Warplan (any tel: link) dials it here.
import { $, $$, esc, api, post, toast, fail, when } from "./core.js";

const SDK = "/vendor/twilio-voice-2.18.5.min.js";
const OUTCOMES = [["no_answer", "No answer"], ["voicemail", "Voicemail"], ["gatekeeper", "Gatekeeper"], ["callback", "Call back"], ["connected", "Spoke"], ["interested", "Interested"], ["meeting", "Meeting"], ["not_interested", "Not interested"], ["wrong_number", "Wrong number"]];
let status = null, device = null, call = null, pending = null, tab = "keypad", thread = null, timer = null, started = 0, info = null, pollT = null;

export async function initPhone() {
  const fab = document.createElement("button");
  fab.id = "phoneFab"; fab.type = "button"; fab.className = "phone-fab"; fab.setAttribute("aria-label", "Phone"); fab.innerHTML = `✆<span class="phone-dot" hidden></span>`;
  const panel = document.createElement("section");
  panel.id = "phone"; panel.className = "phone"; panel.hidden = true; panel.setAttribute("aria-label", "Phone");
  document.body.append(fab, panel);
  fab.addEventListener("click", () => (panel.hidden ? openPhone() : closePhone()));
  // Any tel: link in the app dials from the browser when the phone is set up; otherwise the OS handles it.
  document.addEventListener("click", (e) => {
    const a = e.target.closest?.('a[href^="tel:"]');
    if (!a || !status?.ready) return;
    e.preventDefault(); e.stopPropagation();
    dial(decodeURIComponent(a.getAttribute("href").slice(4)), { targetId: a.dataset.target ? +a.dataset.target : null, fromDialer: !!a.closest("#dmain") });
  }, true);
  try { status = await api("/api/phone"); } catch { status = null; }
  if (status?.ready && status.incoming) ensureDevice().catch(() => {});
  if (status?.ready && status.incoming) { pollUnread(); pollT = setInterval(pollUnread, 60000); }
}

export function openPhone(t) { if (t) tab = t; $("#phone").hidden = false; document.body.classList.add("phone-open"); render(); }
function closePhone() { if (call || pending) { $("#phone").classList.add("mini"); } $("#phone").hidden = !(call || pending); if (!call && !pending) document.body.classList.remove("phone-open"); }

// ------------------------------------------------------------------ device
let sdkLoad = null;
function loadSdk() {
  if (window.Twilio?.Device) return Promise.resolve();
  return (sdkLoad ||= new Promise((res, rej) => { const s = document.createElement("script"); s.src = SDK; s.onload = res; s.onerror = () => rej(new Error("Couldn't load the phone")); document.head.append(s); }));
}
async function ensureDevice() {
  if (device) return device;
  await loadSdk();
  const t = await api("/api/phone/token");
  device = new window.Twilio.Device(t.token, { codecPreferences: ["opus", "pcmu"], closeProtection: true, logLevel: "error" });
  device.on("tokenWillExpire", async () => { try { device.updateToken((await api("/api/phone/token")).token); } catch { /* next call retries */ } });
  device.on("error", (e) => { if (!/token/i.test(e.message || "")) toast(`Phone: ${e.message}`, "error"); });
  device.on("incoming", onIncoming);
  if (t.incoming) await device.register();
  return device;
}

// ------------------------------------------------------------------ calls
export async function dial(raw, { targetId = null, fromDialer = false } = {}) {
  if (call) { toast("You're already on a call", "error"); return; }
  openPhone("keypad");
  try {
    const l = await api(`/api/phone/lookup?number=${encodeURIComponent(raw)}`);
    if (!l.e164) { toast("Add the country code, e.g. +1 or +47", "error"); $("#pnum") && ($("#pnum").value = raw); return; }
    info = { number: l.e164, country: l.country, via: l.caller_id, target: l.target || (targetId ? { id: targetId } : null), fromDialer, inbound: false };
    renderCall("Connecting…");
    await ensureDevice();
    call = await device.connect({ params: { To: l.e164 } });
    wire(call);
  } catch (e) { fail(e); info = null; call = null; render(); }
}
function wire(c) {
  c.on("ringing", () => renderCall("Ringing…"));
  c.on("accept", () => { started = Date.now(); renderCall(); clearInterval(timer); timer = setInterval(tick, 1000); window.dispatchEvent(new CustomEvent("phone:connected", { detail: { number: info?.number } })); });
  const end = (why) => {
    clearInterval(timer);
    const duration = started ? Math.round((Date.now() - started) / 1000) : 0;
    window.dispatchEvent(new CustomEvent("phone:ended", { detail: { number: info?.number, duration, sid: c.parameters?.CallSid, why } }));
    call = null; started = 0;
    if (info?.target?.id && !info.fromDialer) renderAfter(duration);
    else { info = null; render(); if (why) toast(why); }
  };
  c.on("disconnect", () => end());
  c.on("cancel", () => end("Missed call"));
  c.on("reject", () => end());
  c.on("error", (e) => { toast(e.message, "error"); end(); });
}
function onIncoming(c) {
  if (call) { c.reject(); return; }
  pending = c;
  const name = c.customParameters?.get("target_name"), id = c.customParameters?.get("target_id");
  info = { number: c.parameters.From, target: id ? { id: +id, name } : null, inbound: true };
  openPhone("keypad");
  $("#phone").innerHTML = `<div class="ph-call ring"><p class="muted small">Incoming call</p><h3>${esc(name || c.parameters.From)}</h3>${name ? `<p class="mono small">${esc(c.parameters.From)}</p>` : ""}
    <div class="ph-row"><button class="ph-red" id="pDecline" type="button">Decline</button><button class="ph-green" id="pAccept" type="button">Answer</button></div></div>`;
  $("#pAccept").addEventListener("click", () => { c.accept(); call = c; pending = null; wire(c); started = Date.now(); renderCall(); timer = setInterval(tick, 1000); });
  $("#pDecline").addEventListener("click", () => { c.reject(); pending = null; info = null; render(); });
  c.on("cancel", () => { if (pending === c) { pending = null; info = null; toast("Missed call"); render(); } });
}
function tick() { const s = Math.round((Date.now() - started) / 1000); const el = $("#ptime"); if (el) el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }

function renderCall(state) {
  const p = $("#phone"); p.hidden = false; p.classList.remove("mini");
  const name = info?.target?.name || "";
  p.innerHTML = `<div class="ph-call"><p class="muted small">${info?.inbound ? "Incoming" : "Calling"}</p><h3>${esc(name || info?.number || "")}</h3>${name ? `<p class="mono small">${esc(info.number)}</p>` : ""}
    ${info?.via && !info.inbound ? `<p class="muted small">${info.country ? `${esc(info.country)} · ` : ""}they see <span class="mono">${esc(info.via)}</span></p>` : ""}
    <p class="ph-state" id="pstate">${state ? esc(state) : `<span id="ptime">0:00</span>`}</p>
    <div class="ph-keys small-keys" id="dtmf" hidden>${"123456789*0#".split("").map((k) => `<button type="button" data-dtmf="${k}">${k}</button>`).join("")}</div>
    <div class="ph-row"><button class="ph-btn" id="pMute" type="button">Mute</button><button class="ph-btn" id="pPad" type="button">Keypad</button></div>
    <div class="ph-row"><button class="ph-red wide" id="pHang" type="button">Hang up</button></div>
    ${info?.target?.id ? `<p class="small"><a href="#/targets/${info.target.id}">Open ${esc(name || "target")}</a></p>` : ""}</div>`;
  $("#pHang").addEventListener("click", () => { if (call) call.disconnect(); else if (device) device.disconnectAll(); info = info && !call ? null : info; if (!call) render(); });
  $("#pMute").addEventListener("click", (e) => { if (!call) return; call.mute(!call.isMuted()); e.currentTarget.classList.toggle("on", call.isMuted()); e.currentTarget.textContent = call.isMuted() ? "Unmute" : "Mute"; });
  $("#pPad").addEventListener("click", () => { $("#dtmf").hidden = !$("#dtmf").hidden; });
  $$("[data-dtmf]").forEach((b) => b.addEventListener("click", () => call?.sendDigits(b.dataset.dtmf)));
}

// After a call with a known target (outside the dialer): log the outcome in two taps.
function renderAfter(duration) {
  const t = info.target;
  $("#phone").innerHTML = `<div class="ph-after"><h3>How did it go?</h3><p class="muted small">${esc(t.name || "Target")} · ${Math.floor(duration / 60)}m${String(duration % 60).padStart(2, "0")}s</p>
    <textarea id="pnotes" rows="3" placeholder="Notes (optional)"></textarea>
    <div class="ph-outcomes">${OUTCOMES.map(([k, l]) => `<button type="button" class="ghost" data-out="${k}">${l}</button>`).join("")}</div>
    <button class="link" type="button" id="pskip">Skip</button></div>`;
  $$("[data-out]").forEach((b) => b.addEventListener("click", async () => {
    try { const r = await post("/api/calls", { target_id: t.id, phone: info.number, disposition: b.dataset.out, notes: $("#pnotes").value, duration, via: "browser" }); toast(r.receipt); } catch (e) { fail(e); return; }
    info = null; render();
  }));
  $("#pskip").addEventListener("click", () => { info = null; render(); });
}

// ------------------------------------------------------------------ panel
function render() {
  if (call) return renderCall();
  const p = $("#phone");
  if (p.hidden) return;
  if (!status?.twilio) {
    p.innerHTML = `${head()}<div class="ph-body"><p>Call and text straight from Warplan with your own number.</p><p class="muted small">Connect Twilio (Account SID, Auth Token and the number to call from: a Twilio number or your own verified number) under Settings → Integrations.</p><a class="primary" href="#/settings/integrations">Connect Twilio</a></div>`;
    return wireHead();
  }
  if (!status.ready) {
    p.innerHTML = `${head()}<div class="ph-body"><p>Twilio is connected. One click sets up calling from the browser.</p>${status.canEdit ? `<button class="primary" id="pSetup" type="button">Set up the browser phone</button>` : `<p class="muted small">Ask a workspace owner to set it up.</p>`}</div>`;
    wireHead();
    $("#pSetup")?.addEventListener("click", async (e) => { e.currentTarget.disabled = true; e.currentTarget.textContent = "Setting up…"; try { status = await post("/api/phone/setup"); toast("Browser phone ready"); render(); } catch (err) { fail(err); render(); } });
    return;
  }
  const tabs = [["keypad", "Keypad"], ["messages", "Messages"], ["recent", "Recent"], ["settings", "⚙"]];
  p.innerHTML = `${head()}<nav class="ph-tabs">${tabs.map(([k, l]) => `<button type="button" data-tab="${k}" class="${tab === k ? "on" : ""}">${l}</button>`).join("")}</nav><div class="ph-body" id="pbody"></div>`;
  wireHead();
  $$("[data-tab]").forEach((b) => b.addEventListener("click", () => { tab = b.dataset.tab; thread = null; render(); }));
  ({ keypad, messages, recent, settings })[tab]();
}
const head = () => `<header class="ph-head"><b>Phone</b><span class="muted small mono">${esc(status?.from || "")}</span><button class="icon-btn" id="pClose" type="button" aria-label="Close">✕</button></header>`;
function wireHead() { $("#pClose")?.addEventListener("click", closePhone); }

function keypad() {
  $("#pbody").innerHTML = `<input id="pnum" class="ph-num" inputmode="tel" placeholder="+1 555 123 4567" autocomplete="off">
    <div class="ph-keys">${"123456789+0⌫".split("").map((k) => `<button type="button" data-k="${k}">${k}</button>`).join("")}</div>
    <div class="ph-row"><button class="ph-green wide" id="pCall" type="button">☎ Call</button><button class="ph-btn" id="pText" type="button">Text</button></div>`;
  const n = $("#pnum");
  $$("[data-k]").forEach((b) => b.addEventListener("click", () => { n.value = b.dataset.k === "⌫" ? n.value.slice(0, -1) : n.value + b.dataset.k; n.focus(); }));
  n.addEventListener("keydown", (e) => { if (e.key === "Enter") $("#pCall").click(); });
  $("#pCall").addEventListener("click", () => n.value.trim() && dial(n.value.trim()));
  $("#pText").addEventListener("click", () => { if (!n.value.trim()) return; tab = "messages"; thread = { number: n.value.trim(), messages: [], target: null }; render(); });
  n.focus();
}

async function messages() {
  const body = $("#pbody");
  if (thread) return renderThread();
  body.innerHTML = `<p class="muted small">Loading…</p>`;
  try {
    const d = await api("/api/phone/messages");
    localStorage.setItem("phoneSeen", new Date().toISOString()); $(".phone-dot").hidden = true;
    if (tab !== "messages" || thread) return;
    body.innerHTML = `<button class="ghost small" id="pNew" type="button">+ New message</button>${d.threads.length ? `<ul class="ph-list">${d.threads.map((t, i) => `<li><button type="button" data-th="${i}"><b>${esc(t.target?.name || t.number)}</b><small>${t.last.inbound ? "" : "You: "}${esc(t.last.body.slice(0, 60))}</small><small class="muted">${when(t.last.at)}</small></button></li>`).join("")}</ul>` : `<p class="muted small">No texts yet.</p>`}`;
    $("#pNew").addEventListener("click", () => { tab = "keypad"; render(); });
    $$("[data-th]").forEach((b) => b.addEventListener("click", () => { thread = d.threads[+b.dataset.th]; render(); }));
  } catch (e) { body.innerHTML = `<p class="tone-bad small">${esc(e.message)}</p>`; }
}
function renderThread() {
  const t = thread;
  $("#pbody").innerHTML = `<div class="ph-thread-head"><button class="link" id="pBack" type="button">← All</button><b>${esc(t.target?.name || t.number)}</b><a href="tel:${esc(t.number)}" class="ph-btn small" ${t.target ? `data-target="${t.target.id}"` : ""}>☎</a></div>
    <div class="ph-msgs" id="pmsgs">${t.messages.map((m) => `<p class="bubble ${m.inbound ? "in" : "out"}">${esc(m.body)}<small>${when(m.at)}${m.error ? ` · ${esc(m.error)}` : ""}</small></p>`).join("") || `<p class="muted small">New conversation with ${esc(t.number)}</p>`}</div>
    <form id="pform" class="ph-compose"><textarea id="pmsg" rows="2" maxlength="1600" placeholder="Text message"></textarea><button class="primary" type="submit">Send</button></form>`;
  $("#pmsgs").scrollTop = 1e9;
  $("#pBack").addEventListener("click", () => { thread = null; render(); });
  $("#pform").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = $("#pmsg").value.trim(); if (!text) return;
    const btn = $("button[type=submit]", e.target); btn.disabled = true;
    try { const r = await post("/api/phone/sms", { to: t.number, body: text, target_id: t.target?.id }); t.messages.push({ inbound: false, body: text, at: new Date().toISOString() }); t.number = r.to; renderThread(); }
    catch (err) { fail(err); btn.disabled = false; }
  });
  $("#pmsg").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#pform").requestSubmit(); } });
}

async function recent() {
  const body = $("#pbody");
  body.innerHTML = `<p class="muted small">Loading…</p>`;
  try {
    const d = await api("/api/phone/calls");
    if (tab !== "recent") return;
    body.innerHTML = d.calls.length ? `<ul class="ph-list">${d.calls.map((c) => `<li class="ph-callrow"><span><b>${esc(c.target?.name || c.number)}</b><small class="${c.inbound && c.status !== "completed" ? "tone-bad" : "muted"}">${c.inbound ? "↙ in" : "↗ out"} · ${esc(c.status)}${c.duration ? ` · ${Math.floor(c.duration / 60)}:${String(c.duration % 60).padStart(2, "0")}` : ""} · ${when(c.at)}</small></span><a class="ph-btn small" href="tel:${esc(c.number)}" ${c.target ? `data-target="${c.target.id}"` : ""}>☎</a></li>`).join("")}</ul>` : `<p class="muted small">No calls yet.</p>`;
  } catch (e) { body.innerHTML = `<p class="tone-bad small">${esc(e.message)}</p>`; }
}

function settings() {
  $("#pbody").innerHTML = `<p class="small"><b>Local presence</b>: each owner sees your number from their own country (and their own area code in the US and Canada when you have one). Otherwise <b class="mono">${esc(status.from)}</b>.</p>
    <ul class="ph-list">${status.numbers.map((n) => `<li class="ph-callrow"><span><b class="mono">${esc(n.number)}</b><small class="muted">${esc(n.country || "Other")} · ${n.owned ? `Twilio number${n.sms ? " · texts" : ""}` : "your number (calls only)"}</small></span></li>`).join("")}</ul>
    ${status.canEdit ? `<button class="ghost small" id="pNums" type="button">Refresh numbers from Twilio</button>` : ""}
    <p class="muted small">Add a number per country: buy one in Twilio, or verify your own there (Phone Numbers → Verified Caller IDs), then refresh. You can also list numbers under <a href="#/settings/integrations">Settings → Integrations → Twilio</a>.</p>
    ${status.canEdit ? `<label class="check"><input type="checkbox" id="pIn" ${status.incoming ? "checked" : ""} ${status.can_receive ? "" : "disabled"}> Ring Warplan when someone calls or texts this number</label>
    ${status.can_receive ? "" : `<p class="muted small">Receiving needs a number bought on your Twilio account; a verified caller ID can only call out.</p>`}
    <div class="row"><button class="ghost small" id="pRe" type="button">Re-run setup</button><button class="ghost small" id="pOff" type="button">Turn off the browser phone</button></div>` : `<p class="muted small">Owners can change these settings.</p>`}
    <p class="muted small">Allow the microphone when your browser asks. Use a headset for the best sound. Calls aren't recorded.</p>`;
  $("#pIn")?.addEventListener("change", async (e) => { try { status = await post("/api/phone/incoming", { on: e.target.checked }, "PUT"); if (status.incoming) { const d = await ensureDevice(); await d.register(); } toast(status.incoming ? "Incoming calls and texts now come to Warplan" : "Incoming calls go back to your old setup"); } catch (err) { fail(err); e.target.checked = !e.target.checked; } });
  $("#pNums")?.addEventListener("click", async () => { try { status = await post("/api/phone/numbers"); toast(`${status.numbers.length} number${status.numbers.length === 1 ? "" : "s"}`); render(); } catch (e) { fail(e); } });
  $("#pRe")?.addEventListener("click", async () => { try { status = await post("/api/phone/setup"); device?.destroy(); device = null; toast("Done"); render(); } catch (e) { fail(e); } });
  $("#pOff")?.addEventListener("click", async () => { try { await api("/api/phone", { method: "DELETE" }); device?.destroy(); device = null; status = await api("/api/phone"); clearInterval(pollT); render(); } catch (e) { fail(e); } });
}

async function pollUnread() {
  try {
    const d = await api("/api/phone/messages");
    const seen = localStorage.getItem("phoneSeen") || "";
    const unread = d.threads.some((t) => t.last.inbound && t.last.at > seen);
    $(".phone-dot").hidden = !unread;
  } catch { /* quiet */ }
}
