import { $, $$, esc, api, post, md, view, session, stale, fail, play, stopAudio, micButton, MIC, when, initials, skeleton } from "../core.js";
import { streamReply, wireBubbles } from "./josh.js";

export async function renderSimSetup(seq, params) {
  view().innerHTML = skeleton(4);
  const targetId = params.get("target");
  const [past, target] = await Promise.all([api("/api/threads?agent=simulator"), targetId ? api(`/api/targets/${targetId}`).catch(() => null) : null]);
  if (stale(seq)) return;
  const { sellers, stages } = session.team;
  let pick = target ? "target" : sellers[0].id, diff = "normal", stage = "first";
  const scored = past.filter((p) => p.meta.score != null);
  const avg = scored.length ? Math.round(scored.reduce((t, p) => t + p.meta.score, 0) / scored.length) : null;
  view().innerHTML = `
    <header class="page-head"><p class="eyebrow">Seller Simulator</p><h1>Practise the call before it's real.</h1>
      <p class="lede">The first conversation with an owner decides the deal. Call a realistic AI owner, out loud, as many times as you like. Every owner has things they won't tell you until you earn it. Then Josh scores the call.</p></header>
    ${scored.length ? `<div class="score-strip"><div><span>Calls scored</span><b>${scored.length}</b></div><div><span>Average</span><b>${avg}</b></div><div><span>Best</span><b>${Math.max(...scored.map((p) => p.meta.score))}</b></div>
      <div class="spark" aria-label="Scores over time">${scored.slice(0, 20).reverse().map((p) => `<i style="height:${Math.max(6, p.meta.score)}%" title="${p.meta.score}/100 · ${esc(p.title)}"></i>`).join("")}</div></div>` : ""}
    <h2 class="sub-sm">Who are you calling?</h2>
    <div class="sellers">
      ${target ? `<button type="button" class="seller on target-seller" data-s="target">
        <div class="avatar av-target">${initials(target.owner_name || target.name)}</div>
        <b>${esc(target.owner_name || `Owner of ${target.name}`)}</b><small>Your target · ${esc(target.name)}</small><p>Built from what you know about ${esc(target.name)}. The AI invents the hidden motives, so it plays like the real call.</p></button>` : ""}
      ${sellers.map((s) => `<button type="button" class="seller ${s.id === pick ? "on" : ""}" data-s="${s.id}">
        <div class="avatar av-seller">${initials(s.name)}</div>
        <b>${esc(s.name)}</b><small>${esc(s.label)}</small><p>${esc(s.brief)}</p></button>`).join("")}
    </div>
    ${!target ? `<p class="muted small">Want to rehearse a real owner? Open a target in your <a href="#/pipeline">pipeline</a> and press “Practise the call”.</p>` : ""}
    <div class="sim-start">
      <div class="seg" id="stage" role="group" aria-label="Which call">${Object.entries(stages).map(([k, v]) => `<button type="button" data-st="${k}" class="${k === stage ? "on" : ""}" aria-pressed="${k === stage}">${esc(v.label)}</button>`).join("")}</div>
      <div class="seg" id="diff" role="group" aria-label="Difficulty">${["easy", "normal", "hard"].map((d) => `<button type="button" data-d="${d}" class="${d === diff ? "on" : ""}" aria-pressed="${d === diff}">${d[0].toUpperCase() + d.slice(1)}</button>`).join("")}</div>
      <button class="primary big" id="startCall" type="button">☎ Start the call</button>
    </div>
    <p class="muted small stage-goal" id="stageGoal">${esc(stages[stage].goal)}</p>
    ${past.length ? `<h2 class="sub">Past calls</h2><div class="past">${past.map((p) => `<a href="#/simulator/${p.id}"><b>${esc(p.title)}</b><small>${when(p.created_at)} · ${esc(stages[p.meta.stage || "first"]?.label || "")} · ${esc(p.meta.difficulty)} · ${p.meta.score != null ? `<span class="score ${p.meta.score >= 70 ? "hi" : p.meta.score >= 50 ? "mid" : "lo"}">${p.meta.score}/100</span>` : p.meta.debrief ? "debriefed" : `${Math.floor(p.n / 2)} exchanges`}</small></a>`).join("")}</div>` : ""}`;
  const seg = (sel, attr, set) => $$(`${sel} button`).forEach((b) => b.addEventListener("click", () => { set(b.dataset[attr]); $$(`${sel} button`).forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", x === b); }); }));
  $$(".seller").forEach((b) => b.addEventListener("click", () => { pick = b.dataset.s; $$(".seller").forEach((x) => x.classList.toggle("on", x === b)); }));
  seg("#diff", "d", (v) => { diff = v; });
  seg("#stage", "st", (v) => { stage = v; $("#stageGoal").textContent = stages[stage].goal; });
  $("#startCall").addEventListener("click", async (e) => {
    e.currentTarget.disabled = true;
    try {
      const t = await post("/api/threads", { agent: "simulator", ...(pick === "target" ? { target: target.id } : { seller: pick }), difficulty: diff, stage });
      sessionStorage.setItem("wp.ring", "1");
      location.hash = `#/simulator/${t.id}`;
    } catch (err) { fail(err); e.currentTarget.disabled = false; }
  });
}

export async function renderCall(id, seq) {
  view().innerHTML = skeleton(4);
  const t = await api(`/api/threads/${id}`).catch(() => null);
  if (stale(seq)) return;
  if (!t) { location.hash = "#/simulator"; return; }
  const s = t.seller || session.team.sellers[0];
  const stages = session.team.stages;
  const ended = !!t.meta.debrief;
  const seller = (m) => `<div class="msg assistant seller-msg">${md(m.content)}<div class="msg-tools"><button class="say" type="button" data-speaker="${s.voice}" aria-label="Play">▶</button></div><textarea hidden>${esc(m.content)}</textarea></div>`;
  view().innerHTML = `
    <div class="call">
      <header class="call-head">
        <a class="link" href="#/simulator">← Simulator</a>
        <div class="callee"><div class="avatar av-seller big ${ended ? "" : "ring"}">${initials(s.name)}</div>
          <div><h1 class="h2">${esc(s.name)}</h1><p class="muted small">${esc(s.label)} · ${esc(stages[t.meta.stage || "first"]?.label || "")} · ${esc(t.meta.difficulty)}${ended ? ` · call ended${t.meta.score != null ? ` · <b>${t.meta.score}/100</b>` : ""}` : ` · <span id="timer">0:00</span>`}</p>
          ${t.target ? `<a class="chip" href="#/targets/${t.target.id}">${esc(t.target.name)}</a>` : ""}</div></div>
        ${ended ? `<a class="primary" href="#/josh/${t.meta.debrief}">Open Josh's debrief →</a>` : `<button class="danger-btn" id="endCall" type="button">End call & get debrief</button>`}
      </header>
      <div class="msgs call-msgs" id="msgs" aria-live="polite">${t.messages.map((m) => (m.role === "user" ? `<div class="msg user">${md(m.content)}</div>` : seller(m))).join("")}</div>
      ${ended ? "" : `<div class="composer call-composer">
        <button class="mic huge" id="mic" type="button" aria-label="Talk">${MIC}</button>
        <textarea id="input" rows="1" placeholder="Tap the mic and talk to ${esc(s.name.split(" ")[0])}, or type…" aria-label="What you say"></textarea>
        <button class="primary" id="send" type="button">Say it</button>
      </div>
      <p class="muted small center" id="callHint">${t.meta.stage === "deal" ? "Goal: NDA, 3 years of financials, tax returns and a revenue breakdown, and a structure they can say yes to." : "First call: no numbers. Their story, their people, what they want next, and a reason to meet again."} Tap the mic, speak, tap again to send.</p>`}
      <div id="debrief"></div>
    </div>`;
  wireBubbles($("#msgs"));
  const scrollDown = () => { const m = $("#msgs"); if (m) m.scrollTop = m.scrollHeight; };
  scrollDown();
  if (ended) return;
  const started = Date.now();
  const tick = setInterval(() => { const el = $("#timer"); if (!el) return clearInterval(tick); const sec = Math.floor((Date.now() - started) / 1000); el.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`; }, 1000);
  if (sessionStorage.getItem("wp.ring")) { sessionStorage.removeItem("wp.ring"); play(t.messages[0].content, s.voice, $(".say")); }
  let busy = false;
  const send = async (text) => {
    text = text.trim();
    if (!text || busy) return;
    busy = true;
    $("#input").value = "";
    $("#msgs").insertAdjacentHTML("beforeend", `<div class="msg user">${md(text)}</div><div class="msg assistant seller-msg streaming"><div class="typing"><span></span><span></span><span></span></div></div>`);
    const live = $$(".streaming").pop();
    scrollDown();
    try {
      const r = await streamReply(id, text, live);
      live.outerHTML = seller({ content: r.reply });
      wireBubbles($("#msgs"));
      play(r.reply, s.voice, $$(".say").pop());
    } catch (e) { live.remove(); $("#msgs").insertAdjacentHTML("beforeend", `<p class="error">${esc(e.message)}</p>`); $("#input").value = text; }
    busy = false;
    scrollDown();
  };
  $("#send").addEventListener("click", () => send($("#input").value));
  $("#input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(e.target.value); } });
  micButton($("#mic"), send, `A phone call with ${s.name}, a business owner, about selling the company.`);
  $("#endCall").addEventListener("click", async () => {
    stopAudio();
    clearInterval(tick);
    const b = $("#endCall");
    b.disabled = true; b.textContent = "Josh is reviewing your call…";
    try {
      const r = await post(`/api/threads/${id}/debrief`);
      $(".call-composer")?.remove(); $("#callHint")?.remove();
      $(".avatar.ring")?.classList.remove("ring");
      b.outerHTML = `<a class="primary" href="#/josh/${r.thread}">Keep talking to Josh →</a>`;
      $("#debrief").innerHTML = `<section class="debrief"><header><div class="avatar josh">J</div><h2>Josh's debrief${r.score != null ? ` <span class="score big ${r.score >= 70 ? "hi" : r.score >= 50 ? "mid" : "lo"}">${r.score}/100</span>` : ""}</h2><button class="say" type="button" data-speaker="arcas" aria-label="Play">▶</button></header>${md(r.text)}<textarea hidden>${esc(r.text)}</textarea></section>`;
      $("#debrief .say").addEventListener("click", (e) => (e.currentTarget.classList.contains("on") ? stopAudio() : play(r.text, "arcas", e.currentTarget)));
      $("#debrief").scrollIntoView({ behavior: "smooth" });
    } catch (e) { b.disabled = false; b.textContent = "End call & get debrief"; fail(e); }
  });
}
