import { $, $$, esc, safeUrl, dialog, api, post, view, stale, toast, fail, local, skeleton, emptyState, session, dateLabel, todayYmd } from "../core.js";
import { STAGES, stageById } from "../deal.js";
import { deepEnrichDialog } from "./outreach.js";

// Power dialer: work the call list top to bottom. Call (your phone, or Twilio rings you and bridges), take notes,
// hit 1-9 for the outcome, and the next owner is up. Every outcome moves the target on and lands on its timeline.
let active = null; // { sid, timer, poll, started }
let keyHandler = null;
let onPhone = null;
window.addEventListener("phone:connected", (e) => { if ($("#dmain")) onPhone?.connected(e.detail); });
window.addEventListener("phone:ended", (e) => { if ($("#dmain")) onPhone?.ended(e.detail); });
document.addEventListener("keydown", (e) => keyHandler?.(e));

export async function renderDialer(seq, params) {
  view().innerHTML = skeleton(5);
  const prefs = local.get("dialer", { stage: "", fresh: true, autodial: false });
  const qs = new URLSearchParams({ ...(prefs.stage && { stage: prefs.stage }), ...(prefs.fresh && { fresh: "1" }), ...(params.get("q") && { q: params.get("q") }) });
  const [data, stats, me] = await Promise.all([api(`/api/dialer/queue?${qs}`), api("/api/calls"), session.me ? Promise.resolve(session.me) : api("/api/me")]);
  if (stale(seq)) return;
  const D = data.dispositions;
  let queue = data.queue, cur = 0;
  const pick = params.get("target") ? queue.findIndex((t) => t.id === +params.get("target")) : -1;
  if (pick >= 0) cur = pick;

  view().innerHTML = `
    <header class="page-head with-actions"><div><p class="eyebrow">Power dialer</p><h1>Pick up the phone.</h1>
      <p class="lede">Every owner with a number, due callbacks first. Call, take notes, press 1–9 for the outcome and the next owner is up. Outcomes set the next action and move the stage for you.</p></div>
      <div class="metric-strip mini" id="dstats">${statsHtml(stats.today)}</div></header>
    <div class="toolbar">
      <label class="inline">Stage <select id="dStage"><option value="">All live stages</option>${STAGES.filter((s) => !["closed", "lost"].includes(s.id)).map((s) => `<option value="${s.id}" ${prefs.stage === s.id ? "selected" : ""}>${s.label}</option>`).join("")}</select></label>
      <label class="check"><input type="checkbox" id="dFresh" ${prefs.fresh ? "checked" : ""}> Skip owners already called today</label>
      ${data.twilio ? `<label class="check"><input type="checkbox" id="dAuto" ${prefs.autodial ? "checked" : ""}> Auto-dial the next one</label>` : `<a class="small" href="#/settings/integrations">Connect Twilio for click-to-call →</a>`}
      <span class="spacer"></span><span class="muted small">${queue.length} to call</span>
    </div>
    ${queue.length ? `<div class="dialer"><aside class="dq panel flush" id="dq"></aside><section class="dmain" id="dmain"></section></div>`
      : emptyState("No one to call", "Targets with a phone number show up here. Find companies in Scout (Google Maps and the registries give phones), or run Find contacts / Deep enrich on your targets.", `<div class="row center-row"><a class="primary" href="#/scout">Open Scout</a><a class="ghost" href="#/pipeline">Pipeline</a></div>`)}`;

  const savePrefs = () => local.set("dialer", prefs);
  $("#dStage").addEventListener("change", (e) => { prefs.stage = e.target.value; savePrefs(); renderDialer(++session.seq, params); });
  $("#dFresh").addEventListener("change", (e) => { prefs.fresh = e.target.checked; savePrefs(); renderDialer(++session.seq, params); });
  $("#dAuto")?.addEventListener("change", (e) => { prefs.autodial = e.target.checked; savePrefs(); });
  if (!queue.length) return;

  const drawQueue = () => {
    $("#dq").innerHTML = `<ol class="dq-list">${queue.map((t, i) => `<li><button type="button" data-q="${i}" class="${i === cur ? "on" : ""}">
      <b>${esc(t.name)}</b><small>${esc([t.owner_name, t.location].filter(Boolean).join(" · "))}</small>
      <small class="${t.next_date && t.next_date <= todayYmd() ? "tone-warn" : "muted"}">${t.last_disposition ? `${esc(D[t.last_disposition]?.label || t.last_disposition)} · ` : t.calls ? "" : "Never called · "}${t.next_date ? `due ${dateLabel(t.next_date)}` : stageById(t.stage).label}</small></button></li>`).join("")}</ol>`;
    $$("[data-q]").forEach((b) => b.addEventListener("click", () => { if (active) { toast("Finish the call first (log an outcome)", "error"); return; } cur = +b.dataset.q; drawMain(); drawQueue(); }));
  };

  const drawMain = () => {
    const t = queue[cur];
    if (!t) { $("#dmain").innerHTML = emptyState("List done", "That's everyone in this list. Change the filters or come back tomorrow.", `<div class="row center-row"><a class="primary" href="#/pipeline">Pipeline</a></div>`); return; }
    const first = String(t.owner_name || "").replace(/\(.*?\)/g, "").trim().split(/\s+/)[0] || "there";
    const myName = me.user?.name || "me";
    const city = (t.location || "").split(",")[0] || "the area";
    $("#dmain").innerHTML = `
      <div class="panel dcard">
        <div class="dc-head"><div><h2>${esc(t.name)}</h2><p class="muted">${esc([t.industry, t.location].filter(Boolean).join(" · "))}${t.website ? ` · <a href="${safeUrl(t.website)}" target="_blank" rel="noopener noreferrer">website</a>` : ""} · <a href="#/targets/${t.id}">open target</a></p></div>
          <span class="stage-pill s-${t.stage}">${stageById(t.stage).label}</span></div>
        <p class="dc-owner">${t.owner_name ? `<b>${esc(t.owner_name)}</b>${t.owner_age ? ` <span class="age ${t.owner_age >= 60 ? "old" : ""}">${t.owner_age}</span>` : ""}` : `<span class="muted">Owner unknown: ask for the owner by role</span>`}${t.calls ? ` · <span class="muted">${t.calls} earlier call${t.calls > 1 ? "s" : ""}</span>` : ""}</p>
        ${t.next_action ? `<p class="small">Next action: <b>${esc(t.next_action)}</b>${t.next_date ? ` · ${dateLabel(t.next_date)}` : ""}</p>` : ""}
        <div class="phones">${t.phones.map((p, i) => `<div class="phone-row"><span><b>${esc(p.value)}</b> <small class="muted">${esc(p.label)}</small></span>
          <a class="${i ? "ghost" : "primary"}" href="tel:${esc(p.value.replace(/[^\d+]/g, ""))}" data-tel="${i}" data-target="${t.id}">☎ Call</a>${data.twilio ? `<button class="ghost" type="button" data-bridge="${i}">Call via Twilio</button>` : ""}</div>`).join("")}</div>
        <div class="row small"><button class="link" type="button" id="enrichBtn">Find the owner's direct line (Deep enrich)</button></div>
        <p class="call-status" id="cstatus" hidden></p>
      </div>
      <div class="dgrid">
        <div class="panel script">
          <h3 class="h3">First-call script</h3>
          <p><b>Open:</b> “Hi ${esc(first)}, it's ${esc(myName)}. I'll be quick. I own a business locally and I've been getting to know ${esc((t.industry || "business").toLowerCase())} owners in ${esc(city)}. ${esc(t.name)} keeps coming up for how well it's run. I'm not selling anything. Have you ever thought about what happens to the business when you step back one day?”</p>
          <p><b>Goal:</b> a second conversation (coffee or a proper call next week). No revenue, profit or price talk on call one.</p>
          <details><summary>“How did you get my number?”</summary><p>“It's on your website / the company register. I'd rather call than send a cold letter.”</p></details>
          <details><summary>“What's it worth?” / “What would you pay?”</summary><p>“Honestly, I'd never guess on a first call, and I wouldn't trust anyone who did. What I can tell you is how I work: I keep the team, the name and the customers. Could we grab a coffee so I can understand the business properly?”</p></details>
          <details><summary>“Not interested”</summary><p>“Completely fair, most owners I speak to aren't, today. Can I send you a short letter so you have my details for whenever the time is right?”</p></details>
          <details><summary>Gatekeeper</summary><p>“It's ${esc(myName)} for ${esc(first === "there" ? "the owner" : first)}. It's a personal matter about the business; when's the best time to catch them?”</p></details>
          <p class="small"><a href="#/simulator?target=${t.id}">Practise this owner in the Simulator →</a></p>
        </div>
        <div class="panel">
          <h3 class="h3">Notes <span class="muted small" id="timer"></span></h3>
          <textarea id="notes" rows="6" placeholder="What they said, family, staff, timing… (Alt+1–9 logs the outcome while typing)"></textarea>
          <label class="field inline small">Next date <input type="date" id="ndate"></label>
          <div class="dispos">${Object.entries(D).map(([k, d]) => `<button type="button" class="ghost" data-d="${k}"><kbd>${d.key}</kbd> ${esc(d.label)}</button>`).join("")}</div>
          <div class="row"><button class="link" type="button" id="skip">Skip →</button></div>
        </div>
      </div>`;
    let phoneIdx = 0, startedAt = null;
    const startTimer = () => { startedAt = Date.now(); clearInterval(active?.timer); const tick = () => { const s = Math.round((Date.now() - startedAt) / 1000); const el = $("#timer"); if (el) el.textContent = `· ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }; tick(); active = { ...(active || {}), timer: setInterval(tick, 1000), started: startedAt }; };
    $$("[data-tel]").forEach((a) => a.addEventListener("click", () => { phoneIdx = +a.dataset.tel; startTimer(); }));
    // The browser phone intercepts tel: clicks; follow it so the timer and the call length stay right.
    $$("[data-tel]").forEach((a) => a.addEventListener("pointerdown", () => { phoneIdx = +a.dataset.tel; }));
    onPhone = {
      connected: () => { startTimer(); active.browser = true; },
      ended: (d) => { if (active) { active.browser = d.via !== "phone"; active.duration = d.duration; active.callSid = d.sid; clearInterval(active.timer); } const el = $("#cstatus"); if (el) { el.hidden = false; el.textContent = `Call ended${d.duration ? ` · ${d.duration}s` : ""}. Log the outcome (1–9).`; } },
    };
    $$("[data-bridge]").forEach((b) => b.addEventListener("click", () => bridge(+b.dataset.bridge)));
    const status = (txt) => { const el = $("#cstatus"); if (el) { el.hidden = !txt; el.innerHTML = txt; } };
    const bridge = async (i) => {
      phoneIdx = i;
      try {
        const r = await post("/api/dialer/bridge", { target_id: t.id, phone: t.phones[i].value });
        startTimer();
        active.sid = r.call_sid;
        status(`Ringing your phone (${esc(r.ringing)})… answer it and Warplan connects ${esc(r.dialing)}. <button class="link" type="button" id="hang">Hang up</button>`);
        $("#hang")?.addEventListener("click", async () => { try { await api(`/api/dialer/bridge/${r.call_sid}`, { method: "DELETE" }); } catch (e) { fail(e); } });
        active.poll = setInterval(async () => {
          if (!$("#dmain")) { endCall(); return; }
          try {
            const s = await api(`/api/dialer/bridge/${r.call_sid}`);
            if (["completed", "busy", "failed", "no-answer", "canceled"].includes(s.status)) { clearInterval(active?.poll); status(`Call ${esc(s.status)}${s.duration ? ` · ${s.duration}s` : ""}. Log the outcome.`); if (active) active.duration = s.duration; }
            else status(`${s.status === "in-progress" ? "Connected" : esc(s.status)}… <button class="link" type="button" id="hang2">Hang up</button>`), $("#hang2")?.addEventListener("click", () => api(`/api/dialer/bridge/${r.call_sid}`, { method: "DELETE" }).catch(fail));
          } catch { /* keep polling */ }
        }, 3000);
      } catch (e) { fail(e); }
    };
    $("#enrichBtn").addEventListener("click", async () => { const out = await deepEnrichDialog({ id: t.id, name: t.name, website: t.website }); if (out) renderDialer(++session.seq, new URLSearchParams({ target: String(t.id) })); });
    const log = async (k) => {
      const btns = $$("[data-d]"); btns.forEach((b) => { b.disabled = true; });
      const dur = active?.duration ?? (startedAt ? Math.round((Date.now() - startedAt) / 1000) : null);
      try {
        const r = await post("/api/calls", { target_id: t.id, phone: t.phones[phoneIdx]?.value, disposition: k, notes: $("#notes").value, duration: dur, next_date: $("#ndate").value || undefined, via: active?.sid ? "twilio" : active?.browser ? "browser" : "phone", call_sid: active?.sid || active?.callSid });
        toast(r.receipt);
        endCall();
        queue.splice(cur, 1);
        if (cur >= queue.length) cur = 0;
        api("/api/calls").then((s) => { const el = $("#dstats"); if (el) el.innerHTML = statsHtml(s.today); }).catch(() => {});
        drawQueue(); drawMain();
        if (prefs.autodial && data.twilio && queue[cur]?.phones.length) setTimeout(() => $("[data-bridge='0']")?.click(), 1500);
      } catch (e) { fail(e); btns.forEach((b) => { b.disabled = false; }); }
    };
    $$("[data-d]").forEach((b) => b.addEventListener("click", () => log(b.dataset.d)));
    $("#skip").addEventListener("click", () => { endCall(); cur = (cur + 1) % queue.length; drawQueue(); drawMain(); });
    keyHandler = (e) => {
      if (!$("#dmain")) { keyHandler = null; endCall(); return; }
      const typing = /^(TEXTAREA|INPUT|SELECT)$/.test(document.activeElement?.tagName);
      if (typing && !e.altKey) return;
      const k = Object.entries(D).find(([, d]) => d.key === e.key || (e.altKey && e.code === `Digit${d.key}`));
      if (k) { e.preventDefault(); log(k[0]); }
    };
  };
  drawQueue(); drawMain();
}

function endCall() {
  if (!active) return;
  clearInterval(active.timer); clearInterval(active.poll);
  active = null;
}
const statsHtml = (s) => `<div><span>Dials today</span><b>${s.dials}</b></div><div><span>Conversations</span><b>${s.connects}</b></div><div><span>Meetings</span><b>${s.meetings}</b></div>`;
