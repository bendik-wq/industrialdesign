// The phone: a pop-up softphone on every page. Call from the browser (Twilio Voice, WebRTC), text, see recent calls,
// answer incoming calls. Clicking any phone number in Warplan (any tel: link) dials it here.
import { $, $$, esc, api, post, toast, fail, when } from "./core.js";

const SDK = "/vendor/twilio-voice-2.18.5.min.js";
const OUTCOMES = [["no_answer", "No answer"], ["voicemail", "Voicemail"], ["gatekeeper", "Gatekeeper"], ["callback", "Call back"], ["connected", "Spoke"], ["interested", "Interested"], ["meeting", "Meeting"], ["not_interested", "Not interested"], ["wrong_number", "Wrong number"]];
let imsg = null, status = null, device = null, call = null, pending = null, tab = "keypad", thread = null, timer = null, started = 0, info = null, pollT = null;

// Two ways to call. "My phone" (default): calls and texts go out from your own iPhone or Android number: on the
// phone itself through its dialer and Messages, on a Mac through Continuity ("Calls from iPhone"), on Windows
// through Phone Link. When you come back to Warplan, it asks how the call went (with the time you were away).
// "Browser": calls run inside Warplan on the workspace's Twilio, with local presence and in-app texting.
const MODE_KEY = "warplan.phoneMode";
export const phoneMode = () => { let m = null; try { m = localStorage.getItem(MODE_KEY); } catch { /* private mode */ } return m === "browser" && status?.ready ? "browser" : "device"; };
// After one-click Twilio setup, switch to browser calling automatically.
const setMode = (m) => { try { localStorage.setItem(MODE_KEY, m); } catch { /* ignore */ } };
let away = null; // { number, targetId, fromDialer, t0 } while a call runs on your own phone

function deviceCall(number, { targetId = null, fromDialer = false } = {}) {
  away = { number, targetId, fromDialer, t0: Date.now() };
  const a = document.createElement("a"); a.href = `tel:${String(number).replace(/[^\d+]/g, "")}`; a.dataset.handled = "1"; document.body.append(a); a.click(); a.remove();
}
// ------------------------------------------------------------------ call from your own phone, from a computer
// A computer can only hand a number to your phone if it's set up for it (Mac: "Calls from iPhone"; Windows: Phone
// Link). So every click shows a call card with a QR code: point your phone's camera at it and it dials from your
// own number, no setup. "Call on this computer" is there too, and once it has worked we remember that.
const onPhoneItself = () => /iPhone|iPad|Android/i.test(navigator.userAgent);
const TEL_KEY = "warplan.telWorks";
export const telWorks = () => { try { return localStorage.getItem(TEL_KEY) === "1"; } catch { return false; } };
// Watch a tel:/sms: hand-off: if the page loses focus the OS took it (remember that); if not, say so.
export function watchHandoff(onFail) {
  let left = false;
  const off = () => { left = true; };
  window.addEventListener("blur", off, { once: true });
  document.addEventListener("visibilitychange", off, { once: true });
  setTimeout(() => {
    window.removeEventListener("blur", off); document.removeEventListener("visibilitychange", off);
    try { if (left) localStorage.setItem(TEL_KEY, "1"); else localStorage.removeItem(TEL_KEY); } catch { /* ignore */ }
    if (!left) onFail?.();
  }, 2500);
}
let qrLoad = null;
export async function qrSvg(text) {
  if (!window.qrcode) await (qrLoad ||= new Promise((res, rej) => { const s = document.createElement("script"); s.src = "/vendor/qrcode-1.4.4.js"; s.onload = res; s.onerror = () => { qrLoad = null; rej(new Error("Couldn't load the QR code")); }; document.head.append(s); }));
  const q = window.qrcode(0, "M"); q.addData(text); q.make();
  return q.createSvgTag({ cellSize: 4, margin: 3, scalable: true, alt: `QR code for ${text}` });
}
const telHref = (n) => `tel:${String(n).replace(/[^\d+]/g, "")}`;
const fmtSecs = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
let sheetTimer = null;

export async function callSheet(number, { targetId = null } = {}) {
  if (onPhoneItself()) return deviceCall(number, { targetId });
  openPhone(); tab = "sheet";
  const p = $("#phone");
  p.innerHTML = `${head()}<div class="ph-body"><p class="muted small">Getting the number ready…</p></div>`; wireHead();
  let l = null; try { l = await api(`/api/phone/lookup?number=${encodeURIComponent(number)}`); } catch { /* unknown number */ }
  const target = l?.target || (targetId ? { id: targetId } : null), to = l?.e164 || String(number).replace(/[^\d+]/g, "");
  // The same rules as the dialer: calling hours in their time zone, 3 tries a day, the do-not-call list.
  let chk;
  try { chk = await post("/api/dialer/predial", { phone: to, target_id: target?.id }); } catch (e) { chk = { error: e.message, code: e.data?.code }; }
  if (tab !== "sheet") return;
  if (chk.error) {
    p.innerHTML = `${head()}<div class="ph-body ph-sheet"><p class="muted small">${esc(target?.name || "Call")}</p><h3 class="mono">${esc(to)}</h3><p class="ph-blocked">${esc(chk.error)}</p><p class="muted small">Schedule it in the <a href="#/dialer">dialer</a> instead: callbacks come up first when the time is right.</p></div>`;
    wireHead(); return;
  }
  const t0 = Date.now();
  p.innerHTML = `${head()}<div class="ph-body ph-sheet">
      <p class="muted small">${target?.name ? `Call ${esc(target.name)}` : "Call"}${chk.window?.local ? ` · ${esc(chk.window.local.replace(/^\w+ /, ""))} their time` : ""}</p>
      <h3 class="mono">${esc(to)}</h3>
      ${chk.warning ? `<p class="muted small">${esc(chk.warning)}</p>` : ""}
      <div class="ph-qr" id="pqr" aria-label="QR code to call ${esc(to)}"></div>
      <p class="small center"><b>Scan with your phone's camera</b> and tap the number: it rings from your own number.</p>
      <div class="ph-row"><a class="${telWorks() ? "ph-green" : "ph-btn"}" href="${esc(telHref(to))}" data-handled="1" id="pHere">${telWorks() ? "☎ Call on this computer" : "Call on this computer"}</a><button class="ph-btn" type="button" id="pCopy">Copy</button></div>
      ${status?.ready ? `<button class="ghost small" type="button" id="pBrowser">Call from the browser instead (Twilio)</button>` : ""}
      <p class="muted small" id="pHint" hidden>Nothing opened? This computer isn't linked to your phone yet. Scan the code instead, or see <button class="link" type="button" id="pSetupLink">how to link it</button>.</p>
      <div class="ph-after-inline"><p class="small"><b>How did it go?</b> <span class="muted" id="psecs"></span></p>
        ${target?.id ? `<textarea id="pnotes" rows="2" placeholder="Notes (optional)"></textarea><div class="ph-outcomes">${OUTCOMES.map(([k, lab]) => `<button type="button" class="ghost" data-out="${k}">${lab}</button>`).join("")}</div>` : `<p class="muted small">Not a target in Warplan, so nothing to log.</p>`}</div>
    </div>`;
  wireHead();
  qrSvg(telHref(to)).then((svg) => { const el = $("#pqr"); if (el) el.innerHTML = svg; }).catch((e) => { const el = $("#pqr"); if (el) el.textContent = e.message; });
  clearInterval(sheetTimer); sheetTimer = setInterval(() => { const el = $("#psecs"); if (!el) return clearInterval(sheetTimer); el.textContent = fmtSecs(Math.round((Date.now() - t0) / 1000)); }, 1000);
  $("#pHere").addEventListener("click", () => { away = null; watchHandoff(() => { const h = $("#pHint"); if (h) h.hidden = false; }); });
  $("#pCopy").addEventListener("click", () => { navigator.clipboard?.writeText(to).then(() => toast("Number copied")).catch(() => {}); });
  $("#pSetupLink")?.addEventListener("click", () => { tab = "settings"; render(); });
  $("#pBrowser")?.addEventListener("click", () => { setMode("browser"); tab = "keypad"; dial(to, { targetId: target?.id }); });
  $$("[data-out]", p).forEach((b) => b.addEventListener("click", async () => {
    const duration = Math.round((Date.now() - t0) / 1000);
    try { const r = await post("/api/calls", { target_id: target.id, phone: to, disposition: b.dataset.out, notes: $("#pnotes")?.value || "", duration, via: "phone" }); toast(r.receipt); } catch (e) { fail(e); return; }
    clearInterval(sheetTimer); tab = "keypad"; closePhone();
  }));
}
// Texts from a computer: a QR the phone's camera turns into a ready-to-send message (or iMessage via the relay).
export async function textSheet(number, body = "") {
  const n = String(number).replace(/[^\d+]/g, "");
  if (onPhoneItself()) return deviceText(n, body);
  if (imsg?.connected) { tab = "messages"; thread = { number: n, messages: [], target: null, via: "imessage" }; openPhone(); return; }
  openPhone(); tab = "sheet";
  const sep = /iPhone|iPad|Macintosh/.test(navigator.userAgent) ? "&" : "?";
  const href = `sms:${n}${body ? `${sep}body=${encodeURIComponent(body)}` : ""}`;
  $("#phone").innerHTML = `${head()}<div class="ph-body ph-sheet"><p class="muted small">Text</p><h3 class="mono">${esc(n)}</h3>
    <div class="ph-qr" id="pqr"></div><p class="small center"><b>Scan with your phone's camera</b> to open Messages with this number${body ? " and the message" : ""}.</p>
    <div class="ph-row"><a class="ph-btn" href="${esc(href)}" data-handled="1">Open Messages on this computer</a></div>
    <p class="muted small">Want texts inside Warplan? Connect the iMessage relay or Twilio under <a href="#/settings/integrations">Settings → Integrations</a>.</p></div>`;
  wireHead();
  qrSvg(`SMSTO:${n}:${body}`).then((svg) => { const el = $("#pqr"); if (el) el.innerHTML = svg; }).catch(() => {});
}

function deviceText(number, body = "") {
  const n = String(number).replace(/[^\d+]/g, "");
  // iOS/macOS take sms:NUMBER&body=, Android sms:NUMBER?body=; both open Messages from your own number.
  const sep = /iPhone|iPad|Macintosh/.test(navigator.userAgent) ? "&" : "?";
  location.href = `sms:${n}${body ? `${sep}body=${encodeURIComponent(body)}` : ""}`;
}
// Back from a call on your phone: hand the dialer the time away, or ask how it went.
async function cameBack() {
  if (!away || document.visibilityState !== "visible") return;
  const secs = Math.round((Date.now() - away.t0) / 1000), a = away; away = null;
  if (secs < 4) return; // the dialer didn't actually open
  window.dispatchEvent(new CustomEvent("phone:ended", { detail: { number: a.number, duration: secs, via: "phone" } }));
  if (a.fromDialer) return;
  let target = a.targetId ? { id: a.targetId } : null;
  try { const l = await api(`/api/phone/lookup?number=${encodeURIComponent(a.number)}`); target = l.target || target; } catch { /* no match */ }
  if (!target) return;
  info = { number: a.number, target, via: "phone" };
  openPhone(); renderAfter(secs);
}

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
    if (!a || a.dataset.handled) return;
    const number = decodeURIComponent(a.getAttribute("href").slice(4)), opts = { targetId: a.dataset.target ? +a.dataset.target : null, fromDialer: !!a.closest("#dmain") };
    if (phoneMode() === "browser") { e.preventDefault(); e.stopPropagation(); dial(number, opts); return; }
    if (!onPhoneItself()) { e.preventDefault(); e.stopPropagation(); callSheet(number, opts); return; }
    away = { number, ...opts, t0: Date.now() }; // on the phone itself: the dialer opens; log when you're back
    post("/api/dialer/predial", { phone: number, target_id: opts.targetId || undefined }).catch((err) => { if (err.data?.code) toast(err.message, "error"); });
  }, true);
  document.addEventListener("visibilitychange", cameBack);
  window.addEventListener("focus", cameBack);
  try { status = await api("/api/phone"); } catch { status = null; }
  try { imsg = await api("/api/imessage"); } catch { imsg = null; }
  if (status?.ready && status.incoming) ensureDevice().catch(() => {});
  if ((status?.ready && status.incoming) || imsg?.connected) { pollUnread(); pollT = setInterval(pollUnread, 60000); }
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
// The dialer drives calls through these.
export const onCall = () => !!call || !!pending;
export function hangUp() { if (call) call.disconnect(); else if (device) device.disconnectAll(); }
export function toggleMute() { if (!call) return null; call.mute(!call.isMuted()); return call.isMuted(); }
export function sendDigit(d) { call?.sendDigits(d); }
export { deviceCall };

export async function dial(raw, { targetId = null, fromDialer = false, retry = false } = {}) {
  if (phoneMode() !== "browser") return deviceCall(raw, { targetId, fromDialer });
  if (call) { toast("You're already on a call", "error"); return; }
  if (!fromDialer) openPhone("keypad");
  try {
    const l = await api(`/api/phone/lookup?number=${encodeURIComponent(raw)}`);
    if (!l.e164) { toast("Add the country code, e.g. +1 or +44", "error"); $("#pnum") && ($("#pnum").value = raw); window.dispatchEvent(new CustomEvent("phone:failed", { detail: { error: "Add the country code" } })); return; }
    // Same check the server makes: the owner's calling hours, 3 tries a day, the do-not-call list.
    await post("/api/dialer/predial", { phone: l.e164, target_id: targetId || l.target?.id, check_only: true, retry });
    info = { number: l.e164, country: l.country, via: l.caller_id, target: l.target || (targetId ? { id: targetId } : null), fromDialer, inbound: false };
    if (fromDialer) $("#phone").hidden = true; else renderCall("Connecting…");
    await ensureDevice();
    call = await device.connect({ params: { To: l.e164, ...(retry && { retry: "1" }) } });
    wire(call);
  } catch (e) { fail(e); info = null; call = null; render(); window.dispatchEvent(new CustomEvent("phone:failed", { detail: { error: e.message, code: e.data?.code } })); }
}
function wire(c) {
  let answered = false;
  // From the dialer the call shows in the dialer itself; the pop-up stays out of the way.
  const show = (st) => { if (!info?.fromDialer) renderCall(st); };
  c.on("ringing", () => { show("Ringing…"); window.dispatchEvent(new CustomEvent("phone:ringing", { detail: { number: info?.number } })); });
  c.on("accept", () => { answered = true; started = Date.now(); show(); clearInterval(timer); timer = setInterval(tick, 1000); window.dispatchEvent(new CustomEvent("phone:connected", { detail: { number: info?.number } })); });
  const end = (why) => {
    clearInterval(timer);
    const duration = started ? Math.round((Date.now() - started) / 1000) : 0;
    window.dispatchEvent(new CustomEvent("phone:ended", { detail: { number: info?.number, duration, sid: c.parameters?.CallSid, why, answered } }));
    call = null; started = 0;
    if (info?.fromDialer) { info = null; $("#phone").hidden = true; document.body.classList.remove("phone-open"); return; }
    if (info?.target?.id) renderAfter(duration);
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
function tick() { if (info?.fromDialer) return; const s = Math.round((Date.now() - started) / 1000); const el = $("#ptime"); if (el) el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }

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
    try { const r = await post("/api/calls", { target_id: t.id, phone: info.number, disposition: b.dataset.out, notes: $("#pnotes").value, duration, via: info.via === "phone" ? "phone" : "browser" }); toast(r.receipt); } catch (e) { fail(e); return; }
    info = null; render();
  }));
  $("#pskip").addEventListener("click", () => { info = null; render(); });
}

// ------------------------------------------------------------------ panel
function render() {
  if (call) return renderCall();
  const p = $("#phone");
  if (p.hidden) return;
  if (phoneMode() === "device" && !(tab === "settings-browser" && status?.twilio)) return renderDevice(p);
  if (tab === "settings-browser" && status?.ready) tab = "keypad";
  if (!status?.twilio) { tab = "keypad"; return renderDevice(p); }
  if (!status.ready) {
    p.innerHTML = `${head()}<div class="ph-body"><p>Twilio is connected. One click sets up calling from the browser.</p>${status.canEdit ? `<button class="primary" id="pSetup" type="button">Set up the browser phone</button>` : `<p class="muted small">Ask a workspace owner to set it up.</p>`}</div>`;
    wireHead();
    $("#pSetup")?.addEventListener("click", async (e) => { e.currentTarget.disabled = true; e.currentTarget.textContent = "Setting up…"; try { status = await post("/api/phone/setup"); setMode("browser"); tab = "keypad"; toast("Browser phone ready"); render(); } catch (err) { fail(err); render(); } });
    return;
  }
  const tabs = [["keypad", "Keypad"], ["messages", "Messages"], ["recent", "Recent"], ["settings", "⚙"]];
  p.innerHTML = `${head()}<nav class="ph-tabs">${tabs.map(([k, l]) => `<button type="button" data-tab="${k}" class="${tab === k ? "on" : ""}">${l}</button>`).join("")}</nav><div class="ph-body" id="pbody"></div>`;
  wireHead();
  $$("[data-tab]").forEach((b) => b.addEventListener("click", () => { tab = b.dataset.tab; thread = null; render(); }));
  ({ keypad, messages, recent, settings })[tab]();
}
const head = () => `<header class="ph-head"><b>Phone</b><span class="muted small ${phoneMode() === "device" ? "" : "mono"}">${phoneMode() === "device" ? "Your phone" : esc(status?.from || "")}</span><button class="icon-btn" id="pClose" type="button" aria-label="Close">✕</button></header>`;
function wireHead() { $("#pClose")?.addEventListener("click", closePhone); }

// "My phone" mode: keypad + recent logged calls + how-to; calls and texts leave from your own number.
function renderDevice(p) {
  const tabs = [["keypad", "Keypad"], ...(imsg?.connected ? [["messages", "iMessage"]] : []), ["recent", "Recent"], ["settings", "Setup"]];
  if (!tabs.some(([k]) => k === tab)) tab = "keypad";
  p.innerHTML = `${head()}<nav class="ph-tabs">${tabs.map(([k, l]) => `<button type="button" data-tab="${k}" class="${tab === k ? "on" : ""}">${l}</button>`).join("")}</nav><div class="ph-body" id="pbody"></div>`;
  wireHead();
  $$("[data-tab]").forEach((b) => b.addEventListener("click", () => { tab = b.dataset.tab; thread = null; render(); }));
  if (tab === "messages") return imessages();
  if (tab === "keypad") {
    $("#pbody").innerHTML = `<input id="pnum" class="ph-num" inputmode="tel" placeholder="+1 555 123 4567" autocomplete="off">
      <div class="ph-keys">${"123456789+0⌫".split("").map((k) => `<button type="button" data-k="${k}">${k}</button>`).join("")}</div>
      <div class="ph-row"><button class="ph-green wide" id="pCall" type="button">☎ Call from my phone</button><button class="ph-btn" id="pText" type="button">Text</button></div>
      <p class="muted small center">Goes out from your own number. Back here afterwards, Warplan asks how it went.</p>`;
    const n = $("#pnum");
    $$("[data-k]").forEach((b) => b.addEventListener("click", () => { n.value = b.dataset.k === "⌫" ? n.value.slice(0, -1) : n.value + b.dataset.k; n.focus(); }));
    n.addEventListener("keydown", (e) => { if (e.key === "Enter") $("#pCall").click(); });
    $("#pCall").addEventListener("click", () => n.value.trim() && callSheet(n.value.trim()));
    // With the iMessage relay connected, texts send from Warplan (from your number); otherwise Messages opens.
    $("#pText").addEventListener("click", () => { if (!n.value.trim()) return; if (!imsg?.connected) return textSheet(n.value.trim()); tab = "messages"; thread = { number: n.value.trim(), messages: [], target: null, via: "imessage" }; render(); });
    n.focus();
  } else if (tab === "recent") {
    $("#pbody").innerHTML = `<p class="muted small">Loading…</p>`;
    api("/api/calls").then((d) => {
      if (tab !== "recent") return;
      $("#pbody").innerHTML = d.calls.length ? `<ul class="ph-list">${d.calls.slice(0, 30).map((c) => `<li class="ph-callrow"><span><b>${esc(c.target_name)}</b><small class="muted">${esc(c.disposition.replace("_", " "))}${c.duration ? ` · ${Math.floor(c.duration / 60)}:${String(c.duration % 60).padStart(2, "0")}` : ""} · ${when(c.created_at)}</small></span><a class="ph-btn small" href="tel:${esc(c.phone)}" data-target="${c.target_id}">☎</a></li>`).join("")}</ul>` : `<p class="muted small">Calls you log show here.</p>`;
    }).catch((e) => { $("#pbody").innerHTML = `<p class="tone-bad small">${esc(e.message)}</p>`; });
  } else {
    const mac = /Macintosh/.test(navigator.userAgent), iphone = /iPhone|iPad/.test(navigator.userAgent);
    $("#pbody").innerHTML = `<div class="ph-setup">
      <p><b>Calls and texts from your own number.</b> Click any number in Warplan: a QR code comes up. Point your phone's camera at it, tap, and it rings from your own number. Nothing to install.</p>
      <p class="small">${telWorks() ? "✓ This computer can also hand calls to your phone directly." : "Want one-click calling from this computer instead? Link it to your phone once:"}</p>
      ${iphone ? `<p class="small">You're on your iPhone: numbers open your dialer and Messages directly. Tip: Share → <b>Add to Home Screen</b> to use Warplan like an app.</p>` : ""}
      <details ${mac ? "open" : ""}><summary>On a Mac with an iPhone</summary><ol class="small"><li>iPhone: Settings → Phone → <b>Calls on Other Devices</b> → turn on, and allow your Mac.</li><li>Mac: FaceTime → Settings → <b>Calls from iPhone</b> on (same Apple ID, Wi-Fi and Bluetooth on).</li><li>For texts: iPhone Settings → Messages → <b>Text Message Forwarding</b> → your Mac.</li></ol><p class="muted small">Then a click on a number shows “Call … using iPhone” and you talk through the Mac.</p></details>
      <details ${!mac && !iphone ? "open" : ""}><summary>On Windows</summary><p class="small">Install <b>Phone Link</b> (Microsoft), pair your iPhone or Android, and choose Phone Link as the app for phone links. Clicks on numbers then call through your phone.</p></details>
      <details><summary>On the phone itself</summary><p class="small">Open Warplan in Safari or Chrome on your phone. Numbers open the dialer and Messages; come back to Warplan to log the call.</p></details>
      <details><summary>iMessage inside Warplan ${imsg?.connected ? "· connected" : ""}</summary><p class="small">${imsg?.connected ? `Relaying through your Mac at <span class="mono">${esc(imsg.server)}</span>. Your iMessage threads show under the iMessage tab, texts you send here go out from your own number, and replies land on the target's timeline.${imsg.private_api ? " Private API on: typing, read receipts and tapbacks (double-click a bubble)." : ""}${imsg.incoming ? "" : " Incoming messages aren't set up yet: see Settings → Integrations."}` : `See and send your iMessages here, from your own number, through a Mac that stays on (BlueBubbles, free). <a href="#/settings/integrations">Set it up</a>.`}</p></details>
      ${status?.ready ? `<button class="ghost small" id="pUseBrowser" type="button">Call from the browser instead (Twilio)</button>` : status?.twilio ? `<button class="ghost small" id="pSetupBrowser" type="button">Set up calling in the browser (Twilio)</button>` : `<p class="muted small">Prefer calling inside the browser, with local numbers per country? <a href="#/settings/integrations">Connect Twilio</a>.</p>`}
    </div>`;
    $("#pUseBrowser")?.addEventListener("click", () => { setMode("browser"); tab = "keypad"; render(); toast("Calls now run in the browser"); });
    $("#pSetupBrowser")?.addEventListener("click", () => { setMode("browser"); tab = "settings-browser"; render(); });
  }
}

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
// iMessage threads through the BlueBubbles relay on the user's Mac.
async function imessages() {
  const body = $("#pbody");
  if (thread) return renderThread();
  body.innerHTML = `<p class="muted small">Loading your iMessages…</p>`;
  try {
    const d = await api("/api/imessage/threads");
    try { localStorage.setItem("imsgSeen", new Date().toISOString()); } catch { /* ignore */ }
    $(".phone-dot").hidden = true;
    if (tab !== "messages" || thread) return;
    body.innerHTML = `<button class="ghost small" id="pNew" type="button">+ New iMessage</button>${d.threads.length ? `<ul class="ph-list">${d.threads.map((t, i) => `<li><button type="button" data-th="${i}"><b>${esc(t.target?.name || t.name || t.number)}</b><small>${t.last ? `${t.last.inbound ? "" : "You: "}${esc(t.last.body.slice(0, 60))}` : ""}</small><small class="muted">${t.last ? when(t.last.at) : ""}</small></button></li>`).join("")}</ul>` : `<p class="muted small">No conversations yet.</p>`}`;
    $("#pNew").addEventListener("click", () => { tab = "keypad"; render(); });
    $$("[data-th]").forEach((b) => b.addEventListener("click", async () => {
      const t = d.threads[+b.dataset.th];
      thread = { ...t, messages: [], via: "imessage" }; renderThread();
      try { const m = await api(`/api/imessage/messages?chat=${encodeURIComponent(t.chat)}`); if (thread?.chat === t.chat) { thread.messages = m.messages; thread.typing = m.typing; renderThread(); } } catch (e) { fail(e); }
    }));
  } catch (e) { body.innerHTML = `<p class="tone-bad small">${esc(e.message)}</p>`; }
}

const TAPBACK = { love: "❤️", like: "👍", dislike: "👎", laugh: "😂", emphasize: "‼️", question: "❓" };
let livePoll = null, lastTyping = 0;
const privateApi = () => !!imsg?.private_api;
function bubblesHtml(t) {
  if (!t.messages.length) return `<p class="muted small">New conversation with ${esc(t.number)}</p>`;
  // Receipt under your latest message only, like Messages does.
  const lastOut = [...t.messages].reverse().find((m) => !m.inbound);
  return t.messages.map((m) => `<div class="bubble-wrap ${m.inbound ? "in" : "out"}"><p class="bubble ${m.inbound ? "in" : "out"}" ${t.via === "imessage" && m.guid && privateApi() ? `data-msg="${esc(m.guid)}" title="Double-click to react"` : ""}>${esc(m.body)}<small>${when(m.at)}${m.error ? ` · ${esc(m.error)}` : ""}</small>${m.reactions?.length ? `<span class="tapbacks">${m.reactions.map((r) => `<i class="${r.mine ? "mine" : ""}">${TAPBACK[r.name] || ""}</i>`).join("")}</span>` : ""}</p>
    ${m === lastOut && (m.read_at || m.delivered_at) ? `<span class="receipt">${m.read_at ? `Read ${new Date(m.read_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "Delivered"}</span>` : ""}</div>`).join("") + (t.typing ? `<div class="bubble-wrap in"><p class="bubble in typing" aria-label="typing"><span></span><span></span><span></span></p></div>` : "");
}
function drawBubbles(stick) {
  const box = $("#pmsgs"); if (!box || !thread) return;
  const atBottom = stick || box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.innerHTML = bubblesHtml(thread);
  if (atBottom) box.scrollTop = 1e9;
  $$("[data-msg]", box).forEach((b) => b.addEventListener("dblclick", () => pickTapback(b)));
}
// Tapback picker over a bubble (Private API).
function pickTapback(el) {
  $(".tb-pick")?.remove();
  const guid = el.dataset.msg, msg = thread.messages.find((m) => m.guid === guid);
  const pick = document.createElement("div"); pick.className = "tb-pick";
  pick.innerHTML = Object.entries(TAPBACK).map(([k, e]) => `<button type="button" data-tb="${k}" class="${msg?.reactions?.some((r) => r.mine && r.name === k) ? "on" : ""}">${e}</button>`).join("");
  el.parentElement.prepend(pick);
  pick.addEventListener("click", async (e) => {
    const k = e.target.closest("[data-tb]")?.dataset.tb; if (!k) return;
    const remove = msg?.reactions?.some((r) => r.mine && r.name === k);
    pick.remove();
    try {
      await post("/api/imessage/react", { chat: thread.chat, message_guid: guid, reaction: k, remove });
      if (msg) { msg.reactions = (msg.reactions || []).filter((r) => !r.mine); if (!remove) msg.reactions.push({ name: k, mine: true }); drawBubbles(); }
    } catch (err) { fail(err); }
  });
  setTimeout(() => document.addEventListener("click", function off(ev) { if (!pick.contains(ev.target)) { pick.remove(); document.removeEventListener("click", off); } }), 0);
}
// While an iMessage thread is open: new messages, receipts and "typing…" every few seconds.
function startLive() {
  clearInterval(livePoll);
  if (thread?.via !== "imessage" || !thread.chat) return;
  const chat = thread.chat;
  livePoll = setInterval(async () => {
    if (thread?.chat !== chat || $("#phone").hidden || !$("#pmsgs")) { clearInterval(livePoll); return; }
    try {
      const m = await api(`/api/imessage/messages?chat=${encodeURIComponent(chat)}`);
      if (thread?.chat !== chat) return;
      const changed = JSON.stringify([m.messages, m.typing]) !== JSON.stringify([thread.messages, thread.typing]);
      const fresh = m.messages.length > thread.messages.length && m.messages.at(-1)?.inbound;
      thread.messages = m.messages; thread.typing = m.typing;
      if (changed) drawBubbles();
      if (fresh && privateApi() && document.visibilityState === "visible") post("/api/imessage/read", { chat }).catch(() => {});
    } catch { /* keep polling */ }
  }, 4000);
}
function renderThread() {
  const t = thread;
  $("#pbody").innerHTML = `<div class="ph-thread-head"><button class="link" id="pBack" type="button">← All</button><b>${esc(t.target?.name || t.name || t.number)}</b>${t.via === "imessage" && privateApi() ? `<span class="chip small" title="Private API on: typing, read receipts and tapbacks">live</span>` : ""}<a href="tel:${esc(t.number)}" class="ph-btn small" ${t.target ? `data-target="${t.target.id}"` : ""}>☎</a></div>
    <div class="ph-msgs ${t.via === "imessage" ? "imsg" : ""}" id="pmsgs"></div>
    <form id="pform" class="ph-compose"><textarea id="pmsg" rows="2" maxlength="1600" placeholder="${t.via === "imessage" ? "iMessage" : "Text message"}"></textarea><button class="primary" type="submit">Send</button></form>`;
  drawBubbles(true);
  $("#pBack").addEventListener("click", () => { clearInterval(livePoll); thread = null; render(); });
  $("#pform").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = $("#pmsg").value.trim(); if (!text) return;
    const btn = $("button[type=submit]", e.target); btn.disabled = true;
    try {
      const r = await post(t.via === "imessage" ? "/api/imessage/send" : "/api/phone/sms", { to: t.number, body: text, target_id: t.target?.id, ...(t.chat && { chat: t.chat }) });
      t.messages.push({ inbound: false, body: text, at: new Date().toISOString(), reactions: [] }); t.number = r.to;
      if (t.via === "imessage" && !t.chat) t.chat = `iMessage;-;${r.to}`;
      $("#pmsg").value = ""; btn.disabled = false; drawBubbles(true);
      if (t.via === "imessage" && !livePoll) startLive();
    } catch (err) { fail(err); btn.disabled = false; }
  });
  $("#pmsg").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#pform").requestSubmit(); } });
  // Let them see you typing (re-sent every 4s while you type; BlueBubbles clears it on send or after a pause).
  $("#pmsg").addEventListener("input", () => {
    if (t.via !== "imessage" || !t.chat || !privateApi() || Date.now() - lastTyping < 4000) return;
    lastTyping = Date.now(); post("/api/imessage/typing", { chat: t.chat }).catch(() => {});
  });
  if (t.via === "imessage" && t.chat) {
    startLive();
    if (privateApi() && t.messages.some((m) => m.inbound)) post("/api/imessage/read", { chat: t.chat }).catch(() => {});
  }
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
    <p class="muted small">Allow the microphone when your browser asks. Use a headset for the best sound. Calls aren't recorded.</p>
    <button class="ghost small" id="pUseDevice" type="button">Call from my own phone instead</button>`;
  $("#pUseDevice")?.addEventListener("click", () => { setMode("device"); tab = "keypad"; render(); toast("Calls now go out from your own phone"); });
  $("#pIn")?.addEventListener("change", async (e) => { try { status = await post("/api/phone/incoming", { on: e.target.checked }, "PUT"); if (status.incoming) { const d = await ensureDevice(); await d.register(); } toast(status.incoming ? "Incoming calls and texts now come to Warplan" : "Incoming calls go back to your old setup"); } catch (err) { fail(err); e.target.checked = !e.target.checked; } });
  $("#pNums")?.addEventListener("click", async () => { try { status = await post("/api/phone/numbers"); toast(`${status.numbers.length} number${status.numbers.length === 1 ? "" : "s"}`); render(); } catch (e) { fail(e); } });
  $("#pRe")?.addEventListener("click", async () => { try { status = await post("/api/phone/setup"); device?.destroy(); device = null; toast("Done"); render(); } catch (e) { fail(e); } });
  $("#pOff")?.addEventListener("click", async () => { try { await api("/api/phone", { method: "DELETE" }); device?.destroy(); device = null; status = await api("/api/phone"); clearInterval(pollT); render(); } catch (e) { fail(e); } });
}

async function pollUnread() {
  const seen = (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
  let unread = false;
  try { if (status?.ready && status.incoming) unread ||= (await api("/api/phone/messages")).threads.some((t) => t.last.inbound && t.last.at > seen("phoneSeen")); } catch { /* quiet */ }
  try { if (imsg?.connected) unread ||= (await api("/api/imessage/threads")).threads.some((t) => t.last?.inbound && t.last.at > seen("imsgSeen")); } catch { /* quiet */ }
  $(".phone-dot").hidden = !unread;
}
