// Warplan skeleton UI. Hash routes: home, josh[/id], simulator[/id], ladder, agents.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(`df.${k}`)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`df.${k}`, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

let me = null, team = null, routeSeq = 0;
const stale = (seq) => seq !== routeSeq;

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } });
  if (res.status === 401) { location.href = "/login"; throw new Error("signed out"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// Minimal markdown: paragraphs, bullets, bold.
function md(src) {
  const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  return src.split(/\n{2,}/).map((block) => {
    const lines = block.split("\n");
    if (lines.every((l) => /^\s*[-•*]\s+/.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-•*]\s+/, ""))}</li>`).join("")}</ul>`;
    return `<p>${lines.map(inline).join("<br>")}</p>`;
  }).join("");
}

// ================================================================== voice
let audio = null;
async function play(text, speaker, btn) {
  stopAudio();
  btn?.classList.add("busy");
  try {
    const res = await fetch("/api/voice/speak", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, speaker }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Voice failed");
    audio = new Audio(URL.createObjectURL(await res.blob()));
    btn?.classList.replace("busy", "on");
    audio.onended = () => btn?.classList.remove("on");
    await audio.play();
  } catch (e) { btn?.classList.remove("busy", "on"); console.warn(e); }
}
function stopAudio() { if (audio) { audio.pause(); audio = null; } $$(".say.on").forEach((b) => b.classList.remove("on")); }

// Tap to record, tap again to stop. The transcript goes to onText.
function micButton(btn, onText, hint = "") {
  let rec = null, chunks = [], stream = null;
  btn.addEventListener("click", async () => {
    if (rec && rec.state === "recording") { rec.stop(); return; }
    if (!navigator.mediaDevices?.getUserMedia) { alert("This browser can't record audio."); return; }
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { alert("Microphone access was blocked. Allow it in the browser to use voice."); return; }
    stopAudio();
    chunks = [];
    rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      btn.classList.remove("rec"); btn.classList.add("busy");
      try {
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        const res = await fetch(`/api/voice/transcribe?hint=${encodeURIComponent(hint)}`, { method: "POST", headers: { "Content-Type": blob.type }, body: blob });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || "Transcription failed");
        if (d.text) await onText(d.text);
      } catch (e) { alert(e.message); }
      btn.classList.remove("busy");
    };
    rec.start();
    btn.classList.add("rec");
  });
}
const MIC = `<span class="dot"></span>`;

// ================================================================== router
async function router() {
  const seq = ++routeSeq;
  stopAudio();
  $("#rail").classList.remove("open");
  const [, view, id] = location.hash.split("?")[0].split("/");
  $$(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.nav === (view || "home")));
  window.scrollTo(0, 0);
  if (view === "josh") return renderJosh(id ? Number(id) : null, seq);
  if (view === "simulator") return id ? renderCall(Number(id), seq) : renderSimSetup(seq);
  if (view === "ladder") return renderLadder();
  if (view === "agents") return renderAgents();
  return renderHome(seq);
}

// ================================================================== home
function renderHome() {
  const L = ladderModel({ ...LADDER_DEFAULTS, ...store.get("ladder", {}) });
  const live = team.agents.filter((a) => a.status === "live"), soon = team.agents.filter((a) => a.status === "soon");
  $("#view").innerHTML = `
    <section class="hero">
      <p class="eyebrow">Acquisition command</p>
      <h1>Take your market.<br><em>One competitor at a time.</em></h1>
      <p class="lede">Agents that find, value, approach and finance off-market acquisitions, and Josh in your ear for every decision. Built for owners of $1M+ businesses buying competitors without putting in their own cash.</p>
      <div class="ask">
        <button class="mic big" id="homeMic" type="button" aria-label="Talk to Josh">${MIC}</button>
        <input id="homeAsk" placeholder="Ask Josh anything, e.g. “How do I bring up seller financing on the first call?”" autocomplete="off">
        <button class="primary" id="homeGo" type="button">Ask</button>
      </div>
    </section>
    <section class="live-grid">
      ${live.map((a) => `<a class="live-card lc-${a.id}" href="#/${a.id}">
        <span class="badge live">Active</span><span class="ico">${esc(a.icon)}</span>
        <h3>${esc(a.id === "josh" ? "Ask Josh" : a.name)}</h3><p>${esc(a.blurb)}</p>
        ${a.id === "ladder" ? `<div class="mini-ladder"><span>${money(L.todayValue, L.cur)}</span><i>→</i><b>${money(L.final.value, L.cur)}</b></div>` : ""}
        <span class="go">Open →</span></a>`).join("")}
    </section>
    <section>
      <div class="sec-head"><h2>Units in training</h2><a href="#/agents">See every unit →</a></div>
      <div class="soon-row">${soon.map((a) => `<a class="soon-chip" href="#/agents"><span class="ico">${esc(a.icon)}</span><b>${esc(a.name)}</b><small>${esc(a.tag)}</small></a>`).join("")}</div>
    </section>`;
  const ask = async (text) => {
    if (!text.trim()) return;
    const t = await api("/api/threads", { method: "POST", body: JSON.stringify({ agent: "josh" }) });
    sessionStorage.setItem("df.pending", text);
    location.hash = `#/josh/${t.id}`;
  };
  $("#homeGo").addEventListener("click", () => ask($("#homeAsk").value));
  $("#homeAsk").addEventListener("keydown", (e) => { if (e.key === "Enter") ask(e.target.value); });
  micButton($("#homeMic"), ask);
}

// ================================================================== Josh
const STARTERS = [
  "I run a $4M HVAC company. How would I buy my biggest competitor with no money down?",
  "A 68-year-old owner says he has other buyers. What do I say?",
  "Vendor finance or 60/40 debt and rollover: which fits my deal?",
  "What should be in my first offer letter?",
];

async function renderJosh(id, seq) {
  const threads = await api("/api/threads?agent=josh");
  if (stale(seq)) return;
  const t = id ? await api(`/api/threads/${id}`).catch(() => null) : null;
  if (stale(seq)) return;
  if (id && !t) { location.hash = "#/josh"; return; }
  const autoSpeak = store.get("speak", true);
  $("#view").innerHTML = `
    <div class="chat-layout">
      <aside class="threads">
        <button class="primary wide" id="newThread" type="button">+ New conversation</button>
        ${threads.map((x) => `<a class="thread ${x.id === id ? "on" : ""}" href="#/josh/${x.id}"><b>${esc(x.title)}</b><small>${new Date(x.updated_at).toLocaleDateString()}</small></a>`).join("") || `<p class="muted small">Your conversations with Josh show up here.</p>`}
      </aside>
      <section class="chat">
        <header class="chat-head">
          <div class="avatar josh">J</div>
          <div><h2>Josh <span class="tag">AI</span></h2><p class="muted small">Trained on Josh Li's own videos. No fluff, just the next move. The AI version, not Josh himself; get legal, tax and lending specifics signed off by your advisors.</p></div>
          <label class="switch"><input type="checkbox" id="speakToggle" ${autoSpeak ? "checked" : ""}><span></span>Speak replies</label>
        </header>
        <div class="msgs" id="msgs">
          ${t && t.messages.length ? t.messages.map(bubble).join("") : `<div class="empty-chat"><div class="avatar josh big">J</div><h3>What are you trying to buy?</h3><p class="muted">Tap the mic and talk, or pick one:</p>
            <div class="starters">${STARTERS.map((s) => `<button type="button" class="starter">${esc(s)}</button>`).join("")}</div></div>`}
        </div>
        <div class="composer">
          <button class="mic big" id="mic" type="button" aria-label="Talk to Josh">${MIC}</button>
          <textarea id="input" rows="1" placeholder="Type, or tap the mic and talk…"></textarea>
          <button class="primary" id="send" type="button">Send</button>
        </div>
      </section>
    </div>`;
  $("#speakToggle").addEventListener("change", (e) => store.set("speak", e.target.checked));
  $("#newThread").addEventListener("click", async () => { const n = await api("/api/threads", { method: "POST", body: JSON.stringify({ agent: "josh" }) }); location.hash = `#/josh/${n.id}`; });
  wireSay($("#msgs"), "arcas");
  scrollDown();
  let threadId = id;
  const send = async (text) => {
    text = text.trim();
    if (!text) return;
    if (!threadId) {
      const n = await api("/api/threads", { method: "POST", body: JSON.stringify({ agent: "josh" }) });
      threadId = n.id;
      history.replaceState(null, "", `#/josh/${n.id}`);
    }
    $(".empty-chat")?.remove();
    $("#input").value = "";
    $("#msgs").insertAdjacentHTML("beforeend", bubble({ role: "user", content: text }) + `<div class="msg assistant typing"><span></span><span></span><span></span></div>`);
    scrollDown();
    $("#send").disabled = true;
    try {
      const r = await api(`/api/threads/${threadId}/messages`, { method: "POST", body: JSON.stringify({ text }) });
      $(".typing")?.remove();
      $("#msgs").insertAdjacentHTML("beforeend", bubble({ role: "assistant", content: r.reply }));
      wireSay($("#msgs"), "arcas");
      if ($("#speakToggle").checked) play(r.reply, "arcas", $$(".msg.assistant .say").pop());
    } catch (e) {
      $(".typing")?.remove();
      $("#msgs").insertAdjacentHTML("beforeend", `<p class="error">${esc(e.message)}</p>`);
    }
    $("#send").disabled = false;
    scrollDown();
  };
  $("#send").addEventListener("click", () => send($("#input").value));
  $("#input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(e.target.value); } });
  $("#input").addEventListener("input", (e) => { e.target.style.height = "auto"; e.target.style.height = `${Math.min(160, e.target.scrollHeight)}px`; });
  $$(".starter").forEach((b) => b.addEventListener("click", () => send(b.textContent)));
  micButton($("#mic"), send, "A question for an acquisition advisor about buying a business: vendor finance, bank debt, rollover equity, earn-outs.");
  const pending = sessionStorage.getItem("df.pending");
  if (pending) { sessionStorage.removeItem("df.pending"); send(pending); }
}

function bubble(m) {
  return m.role === "user"
    ? `<div class="msg user">${md(m.content)}</div>`
    : `<div class="msg assistant">${md(m.content)}<button class="say" type="button" title="Play" data-text="${esc(m.content)}">▶</button></div>`;
}
function wireSay(root, speaker) {
  $$(".say:not([data-wired])", root).forEach((b) => {
    b.dataset.wired = "1";
    b.addEventListener("click", () => (b.classList.contains("on") ? stopAudio() : play(b.dataset.text, speaker, b)));
  });
}
const scrollDown = () => { const m = $("#msgs"); if (m) m.scrollTop = m.scrollHeight; };

// ================================================================== Seller simulator
async function renderSimSetup(seq) {
  const past = await api("/api/threads?agent=simulator");
  if (stale(seq)) return;
  let pick = team.sellers[0].id, diff = "normal";
  $("#view").innerHTML = `
    <header class="page-head"><p class="eyebrow">Seller Simulator</p><h1>Practise the call before it's real.</h1>
      <p class="lede">The first conversation with an owner decides the deal. Call a realistic AI owner, out loud, as many times as you like. Every owner has things they won't tell you until you earn it. Then Josh scores the call.</p></header>
    <div class="sellers">${team.sellers.map((s) => `<button type="button" class="seller ${s.id === pick ? "on" : ""}" data-s="${s.id}">
      <div class="avatar av-seller">${esc(s.name.split(" ").map((w) => w[0]).slice(-2).join(""))}</div>
      <b>${esc(s.name)}</b><small>${esc(s.label)}</small><p>${esc(s.brief)}</p></button>`).join("")}</div>
    <div class="sim-start">
      <div class="seg" id="diff">${["easy", "normal", "hard"].map((d) => `<button type="button" data-d="${d}" class="${d === diff ? "on" : ""}">${d[0].toUpperCase() + d.slice(1)}</button>`).join("")}</div>
      <button class="primary big" id="startCall" type="button">☎ Start the call</button>
    </div>
    ${past.length ? `<h3 class="sub">Past calls</h3><div class="past">${past.map((p) => `<a href="#/simulator/${p.id}"><b>${esc(p.title)}</b><small>${new Date(p.created_at).toLocaleDateString()} · ${p.meta.difficulty} · ${p.meta.debrief ? "debriefed" : `${Math.floor(p.n / 2)} exchanges`}</small></a>`).join("")}</div>` : ""}`;
  $$(".seller").forEach((b) => b.addEventListener("click", () => { pick = b.dataset.s; $$(".seller").forEach((x) => x.classList.toggle("on", x === b)); }));
  $$("#diff button").forEach((b) => b.addEventListener("click", () => { diff = b.dataset.d; $$("#diff button").forEach((x) => x.classList.toggle("on", x === b)); }));
  $("#startCall").addEventListener("click", async () => {
    const t = await api("/api/threads", { method: "POST", body: JSON.stringify({ agent: "simulator", seller: pick, difficulty: diff }) });
    sessionStorage.setItem("df.ring", "1");
    location.hash = `#/simulator/${t.id}`;
  });
}

async function renderCall(id, seq) {
  const t = await api(`/api/threads/${id}`).catch(() => null);
  if (stale(seq)) return;
  if (!t) { location.hash = "#/simulator"; return; }
  const s = team.sellers.find((x) => x.id === t.meta.seller) || team.sellers[0];
  const ended = !!t.meta.debrief;
  $("#view").innerHTML = `
    <div class="call">
      <header class="call-head">
        <a class="link" href="#/simulator">← Simulator</a>
        <div class="callee"><div class="avatar av-seller big ${ended ? "" : "ring"}">${esc(s.name.split(" ").map((w) => w[0]).slice(-2).join(""))}</div>
          <div><h2>${esc(s.name)}</h2><p class="muted small">${esc(s.label)} · ${esc(t.meta.difficulty)}${ended ? " · call ended" : ` · <span id="timer">0:00</span>`}</p></div></div>
        ${ended ? `<a class="primary" href="#/josh/${t.meta.debrief}">Open Josh's debrief →</a>` : `<button class="danger-btn" id="endCall" type="button">End call & get debrief</button>`}
      </header>
      <div class="msgs call-msgs" id="msgs">${t.messages.map((m) => (m.role === "user" ? `<div class="msg user">${md(m.content)}</div>` : `<div class="msg assistant seller-msg">${md(m.content)}<button class="say" type="button" data-text="${esc(m.content)}">▶</button></div>`)).join("")}</div>
      ${ended ? "" : `<div class="composer call-composer">
        <button class="mic huge" id="mic" type="button" aria-label="Speak">${MIC}</button>
        <textarea id="input" rows="1" placeholder="Tap the mic and talk to ${esc(s.name.split(" ")[0])}, or type…"></textarea>
        <button class="primary" id="send" type="button">Say it</button>
      </div>
      <p class="muted small center">Tip: start with their story, not the price. Tap the mic, speak, tap again to send.</p>`}
      <div id="debrief"></div>
    </div>`;
  wireSay($("#msgs"), s.voice);
  scrollDown();
  if (ended) return;
  const started = Date.now();
  const tick = setInterval(() => { const el = $("#timer"); if (!el) return clearInterval(tick); const sec = Math.floor((Date.now() - started) / 1000); el.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`; }, 1000);
  if (sessionStorage.getItem("df.ring")) { sessionStorage.removeItem("df.ring"); play(t.messages[0].content, s.voice, $(".say")); }
  const send = async (text) => {
    text = text.trim();
    if (!text) return;
    $("#input").value = "";
    $("#msgs").insertAdjacentHTML("beforeend", `<div class="msg user">${md(text)}</div><div class="msg assistant seller-msg typing"><span></span><span></span><span></span></div>`);
    scrollDown();
    try {
      const r = await api(`/api/threads/${id}/messages`, { method: "POST", body: JSON.stringify({ text }) });
      $(".typing")?.remove();
      $("#msgs").insertAdjacentHTML("beforeend", `<div class="msg assistant seller-msg">${md(r.reply)}<button class="say" type="button" data-text="${esc(r.reply)}">▶</button></div>`);
      wireSay($("#msgs"), s.voice);
      play(r.reply, s.voice, $$(".say").pop());
    } catch (e) { $(".typing")?.remove(); $("#msgs").insertAdjacentHTML("beforeend", `<p class="error">${esc(e.message)}</p>`); }
    scrollDown();
  };
  $("#send").addEventListener("click", () => send($("#input").value));
  $("#input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(e.target.value); } });
  micButton($("#mic"), send, `A phone call with ${s.name}, a business owner, about selling the company.`);
  $("#endCall").addEventListener("click", async () => {
    stopAudio();
    clearInterval(tick);
    $("#endCall").disabled = true; $("#endCall").textContent = "Josh is reviewing your call…";
    try {
      const r = await api(`/api/threads/${id}/debrief`, { method: "POST" });
      $(".call-composer")?.remove(); $(".center")?.remove();
      $(".avatar.ring")?.classList.remove("ring");
      $("#endCall").outerHTML = `<a class="primary" href="#/josh/${r.thread}">Keep talking to Josh →</a>`;
      $("#debrief").innerHTML = `<section class="debrief"><header><div class="avatar josh">J</div><h3>Josh's debrief</h3><button class="say" type="button" data-text="${esc(r.text)}">▶</button></header>${md(r.text)}</section>`;
      wireSay($("#debrief"), "arcas");
      $("#debrief").scrollIntoView({ behavior: "smooth" });
    } catch (e) { $("#endCall").disabled = false; $("#endCall").textContent = "End call & get debrief"; alert(e.message); }
  });
}

// ================================================================== Value Ladder
// What the owner's own company is worth today, and after buying N competitors with no cash of their own.
// Two structures: vendor finance (seller notes + bank debt) for fragmented, owner-run markets, or 60/40 for
// asset-heavy businesses (60% commercial debt secured on 100% of the assets, 40% seller rollover equity).
const LADDER_DEFAULTS = { cur: "$", structure: "vendor", myEbitda: 800000, deals: 4, targetEbitda: 500000, buyMultiple: 3, notePct: 80, synergy: 10 };
const STRUCTS = { vendor: "Vendor finance", asset: "60/40 asset-backed" };
const CURS = ["$", "€", "£", "NOK "];
// Size premium: buyers pay higher multiples for bigger, de-risked groups. Indicative, conservative bands.
function multipleFor(ebitda, cur) {
  const k = cur === "NOK " ? ebitda / 10 : ebitda; // NOK bands scaled roughly to USD
  return k < 1e6 ? 3.5 : k < 2e6 ? 4.5 : k < 5e6 ? 5.5 : k < 10e6 ? 7 : 8;
}
const annuity = (P, r, n) => (P <= 0 ? 0 : r === 0 ? P / n : (P * r) / (1 - (1 + r) ** -n));
const balance = (P, r, n, k) => (P <= 0 ? 0 : P * (1 + r) ** k - annuity(P, r, n) * (((1 + r) ** k - 1) / r));
const BANK = { rate: 0.08, years: 5 }, NOTE = { rate: 0.04, years: 7 }, ASSET_BANK = { rate: 0.075, years: 7 };

function ladderModel(x) {
  const cur = x.cur;
  const todayValue = x.myEbitda * multipleFor(x.myEbitda, cur);
  const steps = [];
  for (let n = 0; n <= x.deals; n++) {
    const price = n * x.targetEbitda * x.buyMultiple;
    const asset = x.structure === "asset";
    const B = asset ? ASSET_BANK : BANK;
    const rollover = asset ? price * 0.4 : 0; // sellers keep equity in the group instead of being paid
    const note = asset ? 0 : price * x.notePct / 100;
    const bank = price - note - rollover;
    const acquired = n * x.targetEbitda * (1 + x.synergy / 100);
    const ebitda = x.myEbitda + acquired;
    const multiple = multipleFor(ebitda, cur);
    const value = ebitda * multiple;
    const service = annuity(bank, B.rate, B.years) + annuity(note, NOTE.rate, NOTE.years);
    const dscr = service ? (acquired * 0.8) / service : null; // acquired cash flow covers the new debt
    const debt3 = Math.max(0, balance(bank, B.rate, B.years, 3)) + Math.max(0, balance(note, NOTE.rate, NOTE.years, 3));
    // Rolled-over sellers own a slice of the group, priced at the deal: their stake = rollover / group equity at close.
    const sellerStake = rollover ? Math.min(0.9, rollover / Math.max(1, value - bank - note)) : 0;
    steps.push({ n, price, note, bank, rollover, sellerStake, ebitda, multiple, value, service, dscr, equity3: (value - debt3) * (1 - sellerStake) });
  }
  return { cur, todayValue, steps, final: steps[steps.length - 1] };
}

function money(v, cur = "$") {
  const a = Math.abs(v), s = v < 0 ? "−" : "";
  return `${s}${cur}${a >= 1e9 ? (a / 1e9).toFixed(1) + "B" : a >= 1e6 ? (a / 1e6).toFixed(1) + "M" : Math.round(a / 1e3) + "k"}`;
}

function renderLadder() {
  const x = { ...LADDER_DEFAULTS, ...store.get("ladder", {}) };
  $("#view").innerHTML = `
    <header class="page-head"><p class="eyebrow">Value Ladder</p><h1>What your company becomes.</h1>
      <p class="lede">Small companies sell for 3–4× profit. Groups sell for 6–8×. Buy competitors with the right structure, combine them, and the difference is equity you created, paid for by the businesses' own cash flow.</p></header>
    <div class="ladder">
      <form class="panel inputs" id="lf">
        <label>Structure<div class="seg" id="struct">${Object.entries(STRUCTS).map(([k, l]) => `<button type="button" data-s="${k}" class="${k === x.structure ? "on" : ""}">${l}</button>`).join("")}</div></label>
        <label>Currency<div class="seg" id="cur">${CURS.map((c) => `<button type="button" data-c="${c}" class="${c === x.cur ? "on" : ""}">${c.trim()}</button>`).join("")}</div></label>
        <label>Your yearly profit (EBITDA)<input name="myEbitda" type="number" min="0" step="50000" value="${x.myEbitda}"></label>
        <label>Competitors you buy <output>${x.deals}</output><input name="deals" type="range" min="1" max="12" value="${x.deals}"></label>
        <label>Profit per competitor (EBITDA)<input name="targetEbitda" type="number" min="0" step="50000" value="${x.targetEbitda}"></label>
        <label>Price you pay <output>${x.buyMultiple}× profit</output><input name="buyMultiple" type="range" min="2" max="6" step="0.25" value="${x.buyMultiple}"></label>
        ${x.structure === "asset"
          ? `<p class="struct-note">60% commercial debt, secured on 100% of the business's assets (${ASSET_BANK.years} years at ${ASSET_BANK.rate * 100}%). 40% rolled over: sellers keep equity in your group. For asset-heavy businesses: equipment, fleet, property, stock.</p>`
          : `<label>Paid by the seller over time <output>${x.notePct}%</output><input name="notePct" type="range" min="0" max="100" step="5" value="${x.notePct}"></label>`}
        <label>Savings from combining <output>${x.synergy}%</output><input name="synergy" type="range" min="0" max="30" step="5" value="${x.synergy}"></label>
        <p class="muted small">${x.structure === "asset" ? "Vendor finance suits small, owner-run companies in fragmented markets." : `Seller notes: ${NOTE.years} years at ${NOTE.rate * 100}%. The rest is bank debt: ${BANK.years} years at ${BANK.rate * 100}%. Best in fragmented markets of small owner-run companies; for asset-heavy targets switch to 60/40.`} Group multiples by size: 3.5× under 1M profit, 4.5×, 5.5×, 7×, 8× above 10M. Indicative, not a valuation.</p>
      </form>
      <div class="results" id="lr"></div>
    </div>`;
  const draw = () => {
    store.set("ladder", x);
    const L = ladderModel(x), f = L.final, c = x.cur;
    const created = f.equity3 - L.todayValue;
    const ok = f.dscr == null || f.dscr >= 1.5, warn = f.dscr != null && f.dscr >= 1.2 && f.dscr < 1.5;
    const max = Math.max(...L.steps.map((s) => s.value));
    $("#lr").innerHTML = `
      <div class="kpis">
        <div class="kpi"><span>Your company today</span><b>${money(L.todayValue, c)}</b><small>${multipleFor(x.myEbitda, c)}× ${money(x.myEbitda, c)} profit</small></div>
        <div class="kpi accent"><span>After ${x.deals} acquisitions</span><b>${money(f.value, c)}</b><small>${f.multiple}× ${money(f.ebitda, c)} profit</small></div>
        <div class="kpi"><span>Your equity in 3 years</span><b>${money(f.equity3, c)}</b><small>${created >= 0 ? "+" : ""}${money(created, c)} vs. today</small></div>
      </div>
      <div class="dscr-line ${ok ? "good" : warn ? "warn" : "bad"}">
        <b>${ok ? "✓ Bankable" : warn ? "! Tight" : "✕ Not bankable"}</b>
        <span>The companies you buy cover their own debt payments ${f.dscr == null ? "—" : f.dscr.toFixed(2) + "×"} (lenders want 1.5×). Yearly debt service ${money(f.service, c)}; total price ${money(f.price, c)}: ${x.structure === "asset" ? `${money(f.bank, c)} asset-backed bank debt, ${money(f.rollover, c)} rolled over (sellers own ~${Math.round(f.sellerStake * 100)}% of the group)` : `${money(f.note, c)} paid to sellers over time, ${money(f.bank, c)} bank debt`}.</span>
      </div>
      <div class="panel ladder-chart">
        <h3>Group value after each acquisition</h3>
        <table><thead><tr><th>Deals</th><th>Profit</th><th>Multiple</th><th class="bar-col">Value</th><th>Debt cover</th></tr></thead>
        <tbody>${L.steps.map((s) => `<tr title="${s.n} deals: ${money(s.value, c)} value, ${money(s.price, c)} paid">
          <td>${s.n === 0 ? "Today" : s.n}</td><td>${money(s.ebitda, c)}</td><td>${s.multiple}×</td>
          <td class="bar-col"><div class="bar-cell"><div class="bar"><span style="width:${(100 * s.value) / max}%"></span></div><b>${money(s.value, c)}</b></div></td>
          <td>${s.dscr == null ? "—" : `<span class="${s.dscr >= 1.5 ? "tone-ok" : s.dscr >= 1.2 ? "tone-warn" : "tone-bad"}">${s.dscr.toFixed(2)}×</span>`}</td></tr>`).join("")}</tbody></table>
      </div>
      <div class="ask-josh"><p>Want Josh to pressure-test this plan?</p><button class="ghost" id="askLadder" type="button">Ask Josh about these numbers →</button></div>`;
    $("#askLadder").addEventListener("click", async () => {
      const t = await api("/api/threads", { method: "POST", body: JSON.stringify({ agent: "josh" }) });
      sessionStorage.setItem("df.pending", `Pressure-test my roll-up plan. My company makes ${money(x.myEbitda, c)} EBITDA. I want to buy ${x.deals} competitors making about ${money(x.targetEbitda, c)} EBITDA each at ${x.buyMultiple}x, ${x.structure === "asset" ? "using a 60/40 structure: 60% commercial debt secured on the assets, 40% seller rollover equity" : `with ${x.notePct}% paid by seller notes and the rest bank debt`}. The model says the acquired companies cover debt service ${f.dscr ? f.dscr.toFixed(2) : "n/a"}x and the group could be worth ${money(f.value, c)}. What am I missing and what would you change?`);
      location.hash = `#/josh/${t.id}`;
    });
  };
  $("#lf").addEventListener("input", (e) => {
    const el = e.target;
    if (!el.name) return;
    x[el.name] = Number(el.value);
    const out = el.parentElement.querySelector("output");
    if (out) out.textContent = el.name === "buyMultiple" ? `${el.value}× profit` : el.name === "deals" ? el.value : `${el.value}%`;
    draw();
  });
  $$("#struct button").forEach((b) => b.addEventListener("click", () => { x.structure = b.dataset.s; store.set("ladder", x); renderLadder(); }));
  $$("#cur button").forEach((b) => b.addEventListener("click", () => { x.cur = b.dataset.c; $$("#cur button").forEach((y) => y.classList.toggle("on", y === b)); draw(); }));
  draw();
}

// ================================================================== agents
const BETS = [
  { t: "Value Ladder", s: "live", d: "Owners don't buy software, they buy a bigger exit. Show them, in their own numbers, what their company is worth after each acquisition, and when the debt stops being bankable." },
  { t: "Practise before it's real", s: "live", d: "A flight simulator for seller calls. Realistic owners with hidden motives, voice in and out, scored by Josh. Nobody else trains buyers this way." },
  { t: "Josh on the live call", s: "next", d: "With everyone's consent, Josh listens to real seller calls and whispers the next question on screen, then writes the notes and next steps automatically." },
  { t: "Make your own company worth more", s: "next", d: "An exit-readiness score for the owner's own business: owner dependence, customer concentration, clean books. Raises their multiple even if they never buy anything." },
  { t: "Sellers come to you", s: "next", d: "A 'what is my business worth' page for each member's exclusive territory. Local owners value their company and land in that member's pipeline: off-market deals on autopilot." },
  { t: "A real board, earned with equity", s: "later", d: "The AI board runs monthly meetings now; when a member is ready, we introduce vetted chairs, CFOs and M&A lawyers who work for equity and deferred fees." },
];

function renderAgents() {
  $("#view").innerHTML = `
    <header class="page-head"><p class="eyebrow">Units</p><h1>One team, from first call to the 100-day plan.</h1>
      <p class="lede">Three are live today. The rest are being built in the order the 3C model needs them: Capabilities, Capital, Closing.</p></header>
    <div class="agent-grid">${team.agents.map((a) => `
      <article class="agent ${a.status}">
        <header><span class="ico">${esc(a.icon)}</span><div><h3>${esc(a.name)}</h3><small>${esc(a.tag)}</small></div><span class="badge ${a.status}">${a.status === "live" ? "Active" : "Training"}</span></header>
        <p>${esc(a.blurb)}</p>
        <ul>${a.jobs.map((j) => `<li>${esc(j)}</li>`).join("")}</ul>
        ${a.status === "live" ? `<a class="primary" href="#/${a.id}">Open</a>` : ""}
      </article>`).join("")}</div>
    <h2 class="sub">The bets that make this different</h2>
    <div class="bets">${BETS.map((b) => `<div class="bet"><span class="badge ${b.s === "live" ? "live" : "soon"}">${b.s === "live" ? "Live" : b.s === "next" ? "Next" : "Later"}</span><h3>${esc(b.t)}</h3><p>${esc(b.d)}</p></div>`).join("")}</div>`;
}

// ================================================================== boot
$("#menuBtn").addEventListener("click", () => $("#rail").classList.toggle("open"));
$("#logout").addEventListener("click", async () => { await fetch("/api/logout", { method: "POST" }); location.href = "/login"; });
(async () => {
  [me, team] = await Promise.all([api("/api/me"), api("/api/agents")]);
  $("#who").textContent = me.user.name || me.user.email;
  window.addEventListener("hashchange", router);
  router();
})();
