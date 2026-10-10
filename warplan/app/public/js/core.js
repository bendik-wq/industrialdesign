// Shared browser helpers: DOM, API client, markdown, toasts, dialogs, voice, and state that syncs to the server.
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const view = () => $("#view");
// Only http(s) links from data (websites, profiles, records); anything else (javascript:, data:) becomes "#".
export const safeUrl = (u) => (/^https?:\/\/[^\s"'<>]+$/i.test(String(u || "").trim()) ? esc(String(u).trim()) : "#");

export const session = { me: null, team: null, seq: 0 };
export const stale = (seq) => seq !== session.seq;

export async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } });
  if (res.status === 401) { location.href = "/login"; throw new Error("Signed out"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, data });
  return data;
}
export const post = (path, data, method = "POST") => api(path, { method, body: JSON.stringify(data ?? {}) });

// ------------------------------------------------------------------ formatting
export function when(iso) {
  if (!iso) return "";
  const d = new Date(iso), s = (Date.now() - d) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}
export const dateLabel = (ymd) => (ymd ? new Date(`${ymd}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }) : "");
export const todayYmd = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
export const addDays = (n) => { const d = new Date(Date.now() + n * 864e5); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
export const initials = (name) => esc(String(name || "?").split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase());

// ------------------------------------------------------------------ markdown (escape first, then a safe subset)
function inline(t) {
  return esc(t)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])\*(?!\s)(.+?)\*(?=[\s).,;:!?]|$)/g, "$1<i>$2</i>")
    .replace(/(^|[\s(])_(?!\s)(.+?)_(?=[\s).,;:!?]|$)/g, "$1<i>$2</i>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}
export function md(src) {
  const lines = String(src || "").replace(/\r/g, "").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    let m;
    if ((m = l.match(/^(#{1,4})\s+(.*)$/))) { const n = Math.min(4, m[1].length + 1); out.push(`<h${n}>${inline(m[2])}</h${n}>`); i++; continue; }
    if (/^(-{3,}|\*{3,})\s*$/.test(l)) { out.push("<hr>"); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || "")) {
      const row = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = row(l); i += 2;
      const body = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) body.push(row(lines[i++]));
      out.push(`<div class="table-wrap"><table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    if (/^\s*>/.test(l)) {
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${md(q.join("\n"))}</blockquote>`);
      continue;
    }
    if (/^\s*([-•*]|\d+[.)])\s+/.test(l)) {
      const ordered = /^\s*\d+[.)]/.test(l), items = [];
      while (i < lines.length && /^\s*([-•*]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-•*]|\d+[.)])\s+/, ""));
      out.push(`<${ordered ? "ol" : "ul"}>${items.map((x) => `<li>${inline(x)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*>|\s*([-•*]|\d+[.)])\s+|\s*\|.*\|\s*$|-{3,}\s*$)/.test(lines[i])) para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]);
    out.push(`<p>${para.map(inline).join("<br>")}</p>`);
  }
  return out.join("");
}

// ------------------------------------------------------------------ toasts and dialogs
export function toast(text, kind = "") {
  let box = $("#toasts");
  if (!box) { box = document.createElement("div"); box.id = "toasts"; box.setAttribute("role", "status"); box.setAttribute("aria-live", "polite"); document.body.append(box); }
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = text;
  box.append(el);
  setTimeout(() => el.classList.add("out"), kind === "error" ? 5000 : 2600);
  setTimeout(() => el.remove(), kind === "error" ? 5400 : 3000);
}
export const fail = (e) => toast(e?.message || String(e), "error");

// A modal dialog. `html` is the body; resolves with the submitted FormData (as an object) or null.
export function dialog({ title, html, submit = "Save", danger = false, wide = false, onOpen }) {
  return new Promise((resolve) => {
    const d = document.createElement("dialog");
    d.className = `modal${wide ? " wide" : ""}`;
    d.innerHTML = `<form method="dialog" class="modal-form"><header><h2>${esc(title)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></header>
      <div class="modal-body">${html}</div><p class="error" hidden></p>
      <footer><button type="button" class="ghost" data-close>Cancel</button>${submit ? `<button type="submit" class="${danger ? "danger-btn" : "primary"}">${esc(submit)}</button>` : ""}</footer></form>`;
    document.body.append(d);
    const done = (v) => { d.close(); d.remove(); resolve(v); };
    $$("[data-close]", d).forEach((b) => b.addEventListener("click", () => done(null)));
    d.addEventListener("cancel", (e) => { e.preventDefault(); done(null); });
    d.addEventListener("click", (e) => { if (e.target === d) done(null); });
    $("form", d).addEventListener("submit", (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.target).entries());
      $$("input[type=checkbox]", d).forEach((c) => { if (c.name) data[c.name] = c.checked; });
      done(data);
    });
    d.showModal();
    onOpen?.(d, done);
    $("input:not([type=hidden]), textarea, select", d)?.focus();
  });
}
export async function confirmBox(title, text, submit = "Delete") {
  return !!(await dialog({ title, html: `<p>${esc(text)}</p>`, submit, danger: true }));
}

// ------------------------------------------------------------------ voice
let audio = null;
export async function play(text, speaker, btn) {
  stopAudio();
  btn?.classList.add("busy");
  try {
    const res = await fetch("/api/voice/speak", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, speaker }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Voice failed");
    audio = new Audio(URL.createObjectURL(await res.blob()));
    btn?.classList.replace("busy", "on");
    audio.onended = () => btn?.classList.remove("on");
    await audio.play();
  } catch (e) { btn?.classList.remove("busy", "on"); if (e.name !== "NotAllowedError") toast(e.message, "error"); }
}
export function stopAudio() { if (audio) { audio.pause(); audio = null; } $$(".say.on").forEach((b) => b.classList.remove("on")); }

// Tap to record, tap again to stop. The transcript goes to onText.
export function micButton(btn, onText, hint = "") {
  let rec = null, chunks = [], stream = null;
  btn.addEventListener("click", async () => {
    if (rec && rec.state === "recording") { rec.stop(); return; }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { toast("This browser can't record audio.", "error"); return; }
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { toast("Microphone access was blocked. Allow it in the browser to use voice.", "error"); return; }
    stopAudio();
    chunks = [];
    rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      btn.classList.remove("rec"); btn.classList.add("busy");
      btn.setAttribute("aria-label", "Transcribing");
      try {
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        const res = await fetch(`/api/voice/transcribe?hint=${encodeURIComponent(hint)}`, { method: "POST", headers: { "Content-Type": blob.type }, body: blob });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || "Transcription failed");
        if (d.text) await onText(d.text); else toast("Didn't catch that. Try again a bit closer to the mic.");
      } catch (e) { toast(e.message, "error"); }
      btn.classList.remove("busy");
      btn.setAttribute("aria-label", "Talk");
    };
    rec.start();
    btn.classList.add("rec");
    btn.setAttribute("aria-label", "Stop recording");
  });
}
export const MIC = `<span class="dot" aria-hidden="true"></span>`;

// ------------------------------------------------------------------ state that follows the user across devices
// Kept in memory, saved to /api/state/:key (debounced), with localStorage as an offline copy.
const cache = {}, timers = {};
export const synced = {
  async load(keys) {
    await Promise.all(keys.map(async (k) => {
      let server = null;
      try { server = (await api(`/api/state/${k}`)).data; } catch { /* offline: fall back to the local copy */ }
      let local = null;
      try { local = JSON.parse(localStorage.getItem(`wp.${k}`)) ?? JSON.parse(localStorage.getItem(`df.${k}`)); } catch { /* storage unavailable */ }
      cache[k] = server ?? local;
      if (!server && local) synced.set(k, local); // first sign-in on the new version: upload what this browser had
    }));
  },
  get(k, d) { return cache[k] ?? d; },
  set(k, v) {
    cache[k] = v;
    try { localStorage.setItem(`wp.${k}`, JSON.stringify(v)); } catch { /* storage unavailable */ }
    clearTimeout(timers[k]);
    timers[k] = setTimeout(() => api(`/api/state/${k}`, { method: "PUT", body: JSON.stringify(v) }).catch(() => {}), 600);
  },
};
// Per-device conveniences only (speak toggle, last tab).
export const local = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(`wp.local.${k}`)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`wp.local.${k}`, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

// Copy text with a toast.
export async function copy(text, label = "Copied") {
  try { await navigator.clipboard.writeText(text); toast(label); } catch { toast("Couldn't copy. Select the text and copy it by hand.", "error"); }
}

// Download a string as a file.
export function download(name, text, type = "text/plain") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function skeleton(rows = 3) {
  return `<div class="skeleton" aria-busy="true" aria-label="Loading">${Array.from({ length: rows }, () => "<i></i>").join("")}</div>`;
}
export function emptyState(title, text, action = "") {
  return `<div class="empty"><h3>${esc(title)}</h3><p class="muted">${esc(text)}</p>${action}</div>`;
}
