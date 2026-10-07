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
  if (view === "builder") return renderBuilder();
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
      <p class="lede">Josh in your ear for every decision, a deal builder that tells you if a structure works, a simulator for the calls that matter, and agents that find, value, approach and finance off-market acquisitions. Built for owners of $1M+ businesses buying competitors with no money down.</p>
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
        ${a.id === "builder" ? (() => { const m = dealModel(loadDeal()); return `<div class="mini-verdict ${m.works ? "ok" : "no"}">${m.works ? "✓ Your deal works" : "✕ Your deal needs work"} · ${m.minDscr ? m.minDscr.toFixed(2) + "× DSCR" : "no debt"}</div>`; })() : ""}
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
  "What do I actually say on the first call with an owner?",
  "Build me a no-money-down structure for a $600k EBITDA business where I keep control.",
  "I run a $4M HVAC company. How would I buy my biggest competitor with no money down?",
  "A 68-year-old owner says he has other buyers. What do I say?",
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
  let pick = team.sellers[0].id, diff = "normal", stage = "first";
  $("#view").innerHTML = `
    <header class="page-head"><p class="eyebrow">Seller Simulator</p><h1>Practise the call before it's real.</h1>
      <p class="lede">The first conversation with an owner decides the deal. Call a realistic AI owner, out loud, as many times as you like. Every owner has things they won't tell you until you earn it. Then Josh scores the call.</p></header>
    <div class="sellers">${team.sellers.map((s) => `<button type="button" class="seller ${s.id === pick ? "on" : ""}" data-s="${s.id}">
      <div class="avatar av-seller">${esc(s.name.split(" ").map((w) => w[0]).slice(-2).join(""))}</div>
      <b>${esc(s.name)}</b><small>${esc(s.label)}</small><p>${esc(s.brief)}</p></button>`).join("")}</div>
    <div class="sim-start">
      <div class="seg" id="stage">${Object.entries(team.stages).map(([k, v]) => `<button type="button" data-st="${k}" class="${k === stage ? "on" : ""}" title="${esc(v.goal)}">${esc(v.label)}</button>`).join("")}</div>
      <div class="seg" id="diff">${["easy", "normal", "hard"].map((d) => `<button type="button" data-d="${d}" class="${d === diff ? "on" : ""}">${d[0].toUpperCase() + d.slice(1)}</button>`).join("")}</div>
      <button class="primary big" id="startCall" type="button">☎ Start the call</button>
    </div>
    <p class="muted small stage-goal" id="stageGoal">${esc(team.stages[stage].goal)}</p>
    ${past.length ? `<h3 class="sub">Past calls</h3><div class="past">${past.map((p) => `<a href="#/simulator/${p.id}"><b>${esc(p.title)}</b><small>${new Date(p.created_at).toLocaleDateString()} · ${esc(team.stages[p.meta.stage || "first"]?.label || "")} · ${p.meta.difficulty} · ${p.meta.debrief ? "debriefed" : `${Math.floor(p.n / 2)} exchanges`}</small></a>`).join("")}</div>` : ""}`;
  $$(".seller").forEach((b) => b.addEventListener("click", () => { pick = b.dataset.s; $$(".seller").forEach((x) => x.classList.toggle("on", x === b)); }));
  $$("#diff button").forEach((b) => b.addEventListener("click", () => { diff = b.dataset.d; $$("#diff button").forEach((x) => x.classList.toggle("on", x === b)); }));
  $$("#stage button").forEach((b) => b.addEventListener("click", () => { stage = b.dataset.st; $$("#stage button").forEach((x) => x.classList.toggle("on", x === b)); $("#stageGoal").textContent = team.stages[stage].goal; }));
  $("#startCall").addEventListener("click", async () => {
    const t = await api("/api/threads", { method: "POST", body: JSON.stringify({ agent: "simulator", seller: pick, difficulty: diff, stage }) });
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
          <div><h2>${esc(s.name)}</h2><p class="muted small">${esc(s.label)} · ${esc(team.stages[t.meta.stage || "first"]?.label || "")} · ${esc(t.meta.difficulty)}${ended ? " · call ended" : ` · <span id="timer">0:00</span>`}</p></div></div>
        ${ended ? `<a class="primary" href="#/josh/${t.meta.debrief}">Open Josh's debrief →</a>` : `<button class="danger-btn" id="endCall" type="button">End call & get debrief</button>`}
      </header>
      <div class="msgs call-msgs" id="msgs">${t.messages.map((m) => (m.role === "user" ? `<div class="msg user">${md(m.content)}</div>` : `<div class="msg assistant seller-msg">${md(m.content)}<button class="say" type="button" data-text="${esc(m.content)}">▶</button></div>`)).join("")}</div>
      ${ended ? "" : `<div class="composer call-composer">
        <button class="mic huge" id="mic" type="button" aria-label="Speak">${MIC}</button>
        <textarea id="input" rows="1" placeholder="Tap the mic and talk to ${esc(s.name.split(" ")[0])}, or type…"></textarea>
        <button class="primary" id="send" type="button">Say it</button>
      </div>
      <p class="muted small center">${t.meta.stage === "deal" ? "Goal: NDA, 3 years of financials, tax returns and a revenue breakdown, and a structure they can say yes to." : "First call: no numbers. Their story, their people, what they want next, and a reason to meet again."} Tap the mic, speak, tap again to send.</p>`}
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

// ================================================================== deal engine (shared by Deal Builder and Value Ladder)
// A deal is a capital stack: vendor finance, commercial debt, seller rollover, investor capital, own cash.
// Any mix works as long as the buyer keeps majority control and DSCR >= 1.5 in every year.
const CURS = ["$", "€", "£", "NOK "];
const ELEMENTS = [
  { k: "vf", label: "Vendor finance", short: "Seller note", debt: true },
  { k: "bank", label: "Commercial debt", short: "Bank", debt: true },
  { k: "roll", label: "Seller rollover", short: "Rollover", equity: true },
  { k: "inv", label: "Investor capital", short: "Investors", equity: true },
  { k: "own", label: "Your cash", short: "Your cash" },
];
const DEAL_DEFAULTS = {
  cur: "$", ebitda: 600000, multiple: 3, fcfPct: 80, nonVoting: true,
  vf: { pct: 100, years: 7, rate: 4, holiday: 0, io: 0 },
  bank: { pct: 0, years: 7, rate: 8 },
  roll: { pct: 0 }, inv: { pct: 0, stake: 0 }, own: { pct: 0 },
};
const PRESETS = {
  vanilla: { name: "100% vendor finance", note: "Josh's first deal: the whole price paid to the seller over 7 years at 4%.", set: { vf: { pct: 100, years: 7, rate: 4, holiday: 0, io: 0 }, bank: { pct: 0, years: 5, rate: 8 }, roll: { pct: 0 }, inv: { pct: 0, stake: 0 }, own: { pct: 0 } } },
  blend: { name: "Bank + vendor note", note: "Bank funds what it will, the seller carries the rest, subordinated to the bank.", set: { vf: { pct: 40, years: 7, rate: 6, holiday: 6, io: 0 }, bank: { pct: 60, years: 7, rate: 8 }, roll: { pct: 0 }, inv: { pct: 0, stake: 0 }, own: { pct: 0 } } },
  asset: { name: "60/40 asset-backed", note: "Asset-heavy business: 60% commercial debt secured on the assets, 40% seller rollover.", set: { vf: { pct: 0, years: 7, rate: 4, holiday: 0, io: 0 }, bank: { pct: 60, years: 7, rate: 7.5 }, roll: { pct: 40 }, inv: { pct: 0, stake: 0 }, own: { pct: 0 } } },
  hallelujah: { name: "Hallelujah", note: "Interest-only to the seller for years, then a balloon (refinanced).", set: { vf: { pct: 100, years: 10, rate: 7, holiday: 0, io: 120 }, bank: { pct: 0, years: 5, rate: 8 }, roll: { pct: 0 }, inv: { pct: 0, stake: 0 }, own: { pct: 0 } } },
};
const loadDeal = () => { const d = store.get("deal", {}); return { ...DEAL_DEFAULTS, ...d, vf: { ...DEAL_DEFAULTS.vf, ...d.vf }, bank: { ...DEAL_DEFAULTS.bank, ...d.bank }, roll: { ...DEAL_DEFAULTS.roll, ...d.roll }, inv: { ...DEAL_DEFAULTS.inv, ...d.inv }, own: { ...DEAL_DEFAULTS.own, ...d.own } }; };

// Monthly schedule for an amortising loan with an optional payment holiday and interest-only period.
function loanSchedule(P, ratePct, years, holiday = 0, io = 0, horizon = 120) {
  const r = ratePct / 1200, n = Math.round(years * 12);
  const pay = [], bal = [];
  let b = P;
  const amortMonths = Math.max(1, n - holiday - io);
  const amort = b <= 0 ? 0 : r === 0 ? b / amortMonths : (b * r) / (1 - (1 + r) ** -amortMonths);
  for (let m = 1; m <= horizon; m++) {
    let p = 0;
    if (b > 0.5 && m <= n) {
      if (m <= holiday) p = 0; // no payments, no interest during the holiday (the way Josh negotiates it)
      else if (m <= holiday + io) p = b * r;
      else { const interest = b * r; p = Math.min(amort, b + interest); b -= p - interest; }
      if (m === n && b > 0.5) { p += b; b = 0; } // balloon: whatever is left at term
    }
    pay.push(p); bal.push(Math.max(0, b));
  }
  return { pay, bal };
}

function dealModel(d, ebitda = d.ebitda, multiple = d.multiple) {
  const price = ebitda * multiple;
  const amt = Object.fromEntries(ELEMENTS.map((e) => [e.k, (price * (Number(d[e.k].pct) || 0)) / 100]));
  const allocated = ELEMENTS.reduce((t, e) => t + (Number(d[e.k].pct) || 0), 0);
  const horizon = Math.max(12, Math.round(Math.max(d.vf.years, d.bank.years, 1) * 12));
  const vf = loanSchedule(amt.vf, d.vf.rate, d.vf.years, d.vf.holiday, d.vf.io, horizon);
  const bank = loanSchedule(amt.bank, d.bank.rate, d.bank.years, 0, 0, horizon);
  const fcf = (ebitda * d.fcfPct) / 100;
  const years = [];
  for (let y = 0; y < horizon / 12; y++) {
    const sl = (a) => a.slice(y * 12, y * 12 + 12).reduce((t, v) => t + v, 0);
    const v = sl(vf.pay), bk = sl(bank.pay), service = v + bk;
    years.push({ y: y + 1, vf: v, bank: bk, service, dscr: service > 0 ? fcf / service : null, debtLeft: (vf.bal[y * 12 + 11] || 0) + (bank.bal[y * 12 + 11] || 0) });
  }
  const serviced = years.filter((x) => x.dscr != null);
  const minDscr = serviced.length ? Math.min(...serviced.map((x) => x.dscr)) : null;
  const sellerStake = Number(d.roll.pct) || 0, investorStake = Number(d.inv.stake) || 0;
  const yourEconomic = Math.max(0, 100 - sellerStake - investorStake);
  const yourVotes = d.nonVoting ? 100 : yourEconomic;
  const control = yourVotes > 50;
  const bankable = minDscr == null || minDscr >= 1.5;
  const complete = Math.abs(allocated - 100) < 0.01;
  return {
    price, amt, allocated, complete, years, minDscr, fcf, yourEconomic, yourVotes, control, bankable,
    cashFromYou: amt.own, cashAtClose: amt.bank + amt.inv + amt.own,
    maxPrice: minDscr ? price * Math.min(minDscr / 1.5, 3) : null,
    works: complete && control && bankable,
  };
}

function money(v, cur = "$") {
  const a = Math.abs(v), s = v < 0 ? "−" : "";
  return `${s}${cur}${a >= 1e9 ? (a / 1e9).toFixed(1) + "B" : a >= 1e6 ? (a / 1e6).toFixed(2).replace(/\.?0+$/, "") + "M" : Math.round(a / 1e3) + "k"}`;
}
const pct = (v) => `${Math.round(v * 10) / 10}%`;

function structureSummary(d, m) {
  const parts = ELEMENTS.filter((e) => d[e.k].pct > 0).map((e) => {
    if (e.k === "vf") return `${d.vf.pct}% vendor finance (${d.vf.years} yrs at ${d.vf.rate}%${d.vf.holiday ? `, ${d.vf.holiday}-month payment holiday` : ""}${d.vf.io ? `, ${d.vf.io} months interest-only` : ""})`;
    if (e.k === "bank") return `${d.bank.pct}% commercial debt (${d.bank.years} yrs at ${d.bank.rate}%)`;
    if (e.k === "roll") return `${d.roll.pct}% seller rollover equity`;
    if (e.k === "inv") return `${d.inv.pct}% investor capital for ${d.inv.stake}% equity`;
    return `${d.own.pct}% my own cash`;
  });
  return `${money(m.price, d.cur)} price (${d.multiple}x ${money(d.ebitda, d.cur)} EBITDA), funded by ${parts.join(", ")}. ${d.nonVoting ? "Rollover/investor shares are non-voting." : ""} The model says: I keep ${pct(m.yourEconomic)} economic ownership and ${pct(m.yourVotes)} of the votes, minimum DSCR ${m.minDscr ? m.minDscr.toFixed(2) + "x" : "n/a"} (free cash flow ${d.fcfPct}% of EBITDA), my cash in: ${money(m.cashFromYou, d.cur)}.`;
}

async function askJoshAbout(text) {
  const t = await api("/api/threads", { method: "POST", body: JSON.stringify({ agent: "josh" }) });
  sessionStorage.setItem("df.pending", text);
  location.hash = `#/josh/${t.id}`;
}

// ================================================================== Deal Builder
function renderBuilder() {
  const d = loadDeal();
  const num = (path, label, attrs = "") => { const [a, b] = path.split("."); const v = b ? d[a][b] : d[a]; return `<label>${label}<input data-p="${path}" type="number" value="${v}" ${attrs}></label>`; };
  $("#view").innerHTML = `
    <header class="page-head"><p class="eyebrow">Deal Builder</p><h1>Any structure. Two rules.</h1>
      <p class="lede">Stack the capital however you like: vendor finance, commercial debt, seller rollover, investor capital, your own cash if you want to. The deal works when you keep majority control and the business covers every repayment at least 1.5 times, every year.</p></header>
    <div class="presets">${Object.entries(PRESETS).map(([k, p]) => `<button type="button" class="preset" data-preset="${k}" title="${esc(p.note)}"><b>${esc(p.name)}</b><small>${esc(p.note)}</small></button>`).join("")}</div>
    <div class="builder">
      <form class="panel inputs" id="bf">
        <label>Currency<div class="seg" id="cur">${CURS.map((c) => `<button type="button" data-c="${c}" class="${c === d.cur ? "on" : ""}">${c.trim()}</button>`).join("")}</div></label>
        <div class="two">${num("ebitda", "Target EBITDA", 'min="0" step="25000"')}${num("multiple", "Price (× EBITDA)", 'min="0.5" max="15" step="0.25"')}</div>
        ${num("fcfPct", "Free cash flow (% of EBITDA)", 'min="10" max="100" step="5"')}
        <div class="stack-in">
          ${ELEMENTS.map((e, i) => `<fieldset class="el" style="--c: var(--s${i + 1})">
            <legend><i></i>${e.label}<output data-o="${e.k}">${d[e.k].pct}%</output></legend>
            <input data-p="${e.k}.pct" type="range" min="0" max="100" step="5" value="${d[e.k].pct}">
            ${e.k === "vf" ? `<div class="three">${num("vf.years", "Years", 'min="1" max="99"')}${num("vf.rate", "Rate %", 'min="0" max="20" step="0.25"')}${num("vf.holiday", "Holiday (mo)", 'min="0" max="24"')}</div>${num("vf.io", "Interest-only months after the holiday", 'min="0" max="120"')}` : ""}
            ${e.k === "bank" ? `<div class="two">${num("bank.years", "Years", 'min="1" max="25"')}${num("bank.rate", "Rate %", 'min="0" max="25" step="0.25"')}</div>` : ""}
            ${e.k === "inv" ? num("inv.stake", "Equity investors get (%)", 'min="0" max="100" step="1"') : ""}
          </fieldset>`).join("")}
        </div>
        <label class="check"><input type="checkbox" data-p="nonVoting" ${d.nonVoting ? "checked" : ""}> Rollover and investor shares are non-voting</label>
        <button type="button" class="ghost" id="fillGap">Fill the gap with vendor finance</button>
      </form>
      <div class="results" id="br"></div>
    </div>`;
  const save = () => store.set("deal", d);
  const draw = () => {
    save();
    const m = dealModel(d), c = d.cur;
    ELEMENTS.forEach((e) => { const o = $(`[data-o="${e.k}"]`); if (o) o.textContent = `${d[e.k].pct}%`; });
    const issues = [];
    if (!m.complete) issues.push(m.allocated < 100 ? `${100 - m.allocated}% of the price isn't funded yet` : `You've funded ${m.allocated}% of the price; bring it back to 100%`);
    if (!m.control) issues.push(`You'd hold ${pct(m.yourVotes)} of the votes; you need over 50%. Make the rollover/investor shares non-voting or give less equity away`);
    if (!m.bankable) issues.push(`The weakest year covers debt only ${m.minDscr.toFixed(2)}×. Stretch the terms, add a holiday, lower the price, or move some of it into rollover`);
    const maxRow = Math.max(...m.years.map((y) => y.service), 1);
    $("#br").innerHTML = `
      <div class="verdict ${m.works ? "ok" : "no"}"><b>${m.works ? "✓ This deal works" : "✕ Not yet"}</b>
        <span>${m.works ? `You keep control and the business carries every repayment with room to spare. ${m.cashFromYou ? `You put in ${money(m.cashFromYou, c)}.` : "No money down."}` : issues.join(". ") + "."}</span></div>
      <div class="kpis four">
        <div class="kpi"><span>Price</span><b>${money(m.price, c)}</b><small>${d.multiple}× ${money(d.ebitda, c)}</small></div>
        <div class="kpi ${m.control ? "" : "warnk"}"><span>Your control</span><b>${pct(m.yourVotes)}</b><small>of the votes · ${pct(m.yourEconomic)} of profits</small></div>
        <div class="kpi ${m.bankable ? "" : "warnk"}"><span>Weakest-year DSCR</span><b>${m.minDscr ? m.minDscr.toFixed(2) + "×" : "–"}</b><small>needs 1.5× or more</small></div>
        <div class="kpi accent"><span>Your cash in</span><b>${money(m.cashFromYou, c)}</b><small>${m.cashFromYou ? "by choice" : "no money down"}</small></div>
      </div>
      <div class="panel">
        <h3>Capital stack</h3>
        <div class="stackbar" role="img" aria-label="Capital stack">${ELEMENTS.map((e, i) => m.amt[e.k] > 0 ? `<span style="width:${(100 * m.amt[e.k]) / Math.max(m.price, 1)}%;background:var(--s${i + 1})" title="${e.label}: ${money(m.amt[e.k], c)}">${d[e.k].pct >= 12 ? `${e.short} ${d[e.k].pct}%` : ""}</span>` : "").join("")}</div>
        <table class="stack-table"><tbody>${ELEMENTS.map((e, i) => `<tr class="${m.amt[e.k] > 0 ? "" : "dim"}"><td><i style="background:var(--s${i + 1})"></i>${e.label}</td><td>${d[e.k].pct}%</td><td>${money(m.amt[e.k], c)}</td><td class="muted">${
          e.k === "vf" ? (m.amt.vf ? `paid to the seller over ${d.vf.years} yrs` : "")
          : e.k === "bank" ? (m.amt.bank ? `cash to seller at close` : "")
          : e.k === "roll" ? (m.amt.roll ? `seller keeps ${d.roll.pct}% of the company` : "")
          : e.k === "inv" ? (m.amt.inv ? `investors own ${d.inv.stake}%` : "") : (m.amt.own ? "from your pocket" : "")}</td></tr>`).join("")}</tbody></table>
        <p class="muted small">Seller gets ${money(m.amt.bank + m.amt.inv + m.amt.own, c)} at close${m.amt.vf ? `, then about ${money((m.years[1]?.vf ?? m.years[0].vf) / 12, c)}/month on the note${d.vf.holiday ? ` after a ${d.vf.holiday}-month holiday` : ""}` : ""}${m.amt.roll ? `, and keeps ${d.roll.pct}% of the business` : ""}.</p>
      </div>
      <div class="panel">
        <h3>Debt cover, year by year</h3>
        <table class="years"><thead><tr><th>Year</th><th>Seller note</th><th>Bank</th><th class="bar-col">Total debt service</th><th>DSCR</th></tr></thead>
        <tbody>${m.years.map((y) => `<tr title="Year ${y.y}: ${money(y.service, c)} debt service vs ${money(m.fcf, c)} free cash flow">
          <td>${y.y}</td><td>${money(y.vf, c)}</td><td>${money(y.bank, c)}</td>
          <td class="bar-col"><div class="bar-cell"><div class="bar"><span style="width:${(100 * y.service) / maxRow}%"></span></div><b>${money(y.service, c)}</b></div></td>
          <td>${y.dscr == null ? "–" : `<span class="${y.dscr >= 1.5 ? "tone-ok" : y.dscr >= 1.2 ? "tone-warn" : "tone-bad"}">${y.dscr.toFixed(2)}×</span>`}</td></tr>`).join("")}</tbody></table>
        <p class="muted small">Free cash flow ${money(m.fcf, c)} a year. ${m.maxPrice && m.minDscr ? `At 1.5× in the weakest year, this stack carries a price of up to ${money(m.maxPrice, c)} (${(m.maxPrice / d.ebitda).toFixed(2)}× EBITDA).` : ""} Indicative, not advice: get your accountant and lender to check the real numbers.</p>
      </div>
      <div class="ask-josh"><p>Want Josh to pressure-test this structure?</p><button class="ghost" id="askDeal" type="button">Ask Josh about this deal →</button></div>`;
    $("#askDeal").addEventListener("click", () => askJoshAbout(`Pressure-test this deal structure. ${structureSummary(d, m)} What would you change, and how would you pitch it to the seller?`));
  };
  const set = (path, val) => { const [a, b] = path.split("."); if (b) d[a][b] = val; else d[a] = val; };
  $("#bf").addEventListener("input", (e) => {
    const el = e.target; if (!el.dataset.p) return;
    set(el.dataset.p, el.type === "checkbox" ? el.checked : Number(el.value));
    if (el.dataset.p === "inv.pct" && !d.inv.stake) d.inv.stake = d.inv.pct;
    draw();
  });
  $$("#cur button").forEach((b) => b.addEventListener("click", () => { d.cur = b.dataset.c; $$("#cur button").forEach((y) => y.classList.toggle("on", y === b)); draw(); }));
  $("#fillGap").addEventListener("click", () => {
    const other = ELEMENTS.filter((e) => e.k !== "vf").reduce((t, e) => t + d[e.k].pct, 0);
    d.vf.pct = Math.max(0, 100 - other); save(); renderBuilder();
  });
  $$("[data-preset]").forEach((b) => b.addEventListener("click", () => { const p = PRESETS[b.dataset.preset].set; Object.assign(d, JSON.parse(JSON.stringify(p))); save(); renderBuilder(); }));
  draw();
}

// ================================================================== Value Ladder
// What the owner's own company is worth today, and after buying N competitors with the Deal Builder's structure.
const LADDER_DEFAULTS = { myEbitda: 800000, deals: 4, targetEbitda: 500000, buyMultiple: 3, synergy: 10 };
// Size premium: buyers pay higher multiples for bigger, de-risked groups. Indicative, conservative bands.
function multipleFor(ebitda, cur) {
  const k = cur === "NOK " ? ebitda / 10 : ebitda; // NOK bands scaled roughly to USD
  return k < 1e6 ? 3.5 : k < 2e6 ? 4.5 : k < 5e6 ? 5.5 : k < 10e6 ? 7 : 8;
}

function ladderModel(x, d = loadDeal()) {
  const cur = d.cur;
  const per = dealModel(d, x.targetEbitda, x.buyMultiple); // one acquisition; every deal uses the same structure
  const todayValue = x.myEbitda * multipleFor(x.myEbitda, cur);
  const debt3 = per.years[2]?.debtLeft ?? 0;
  const steps = [];
  for (let n = 0; n <= x.deals; n++) {
    const acquired = n * x.targetEbitda * (1 + x.synergy / 100);
    const ebitda = x.myEbitda + acquired;
    const multiple = multipleFor(ebitda, cur);
    const value = ebitda * multiple;
    const debtAtClose = n * (per.amt.vf + per.amt.bank);
    const outsideEquity = n * (per.amt.roll + per.amt.inv); // sellers/investors who took equity, priced at the deal
    const outsideStake = outsideEquity ? Math.min(0.9, outsideEquity / Math.max(1, value - debtAtClose)) : 0;
    steps.push({ n, ebitda, multiple, value, price: n * per.price, service: n * (per.years[1]?.service ?? per.years[0].service), dscr: n ? per.minDscr : null, outsideStake, equity3: (value - n * debt3) * (1 - outsideStake) });
  }
  return { cur, todayValue, steps, final: steps[steps.length - 1], per, d };
}

function renderLadder() {
  const x = { ...LADDER_DEFAULTS, ...store.get("ladder", {}) };
  const d = loadDeal();
  $("#view").innerHTML = `
    <header class="page-head"><p class="eyebrow">Value Ladder</p><h1>What your company becomes.</h1>
      <p class="lede">Small companies sell for 3–4× profit. Groups sell for 6–8×. Buy competitors with no money down, combine them, and the difference is equity you created, paid for by the businesses themselves.</p></header>
    <div class="ladder">
      <form class="panel inputs" id="lf">
        <label>Your yearly profit (EBITDA)<input name="myEbitda" type="number" min="0" step="50000" value="${x.myEbitda}"></label>
        <label>Competitors you buy <output>${x.deals}</output><input name="deals" type="range" min="1" max="12" value="${x.deals}"></label>
        <label>Profit per competitor (EBITDA)<input name="targetEbitda" type="number" min="0" step="50000" value="${x.targetEbitda}"></label>
        <label>Price you pay <output>${x.buyMultiple}× profit</output><input name="buyMultiple" type="range" min="2" max="7" step="0.25" value="${x.buyMultiple}"></label>
        <label>Savings from combining <output>${x.synergy}%</output><input name="synergy" type="range" min="0" max="30" step="5" value="${x.synergy}"></label>
        <div class="struct-note"><b>Structure for every deal</b><br>${esc(ELEMENTS.filter((e) => d[e.k].pct > 0).map((e) => `${e.label} ${d[e.k].pct}%`).join(" · "))}<br><a href="#/builder">Change it in the Deal Builder →</a></div>
        <p class="muted small">Group multiples by size: 3.5× under 1M profit, 4.5×, 5.5×, 7×, 8× above 10M. Indicative, not a valuation.</p>
      </form>
      <div class="results" id="lr"></div>
    </div>`;
  const draw = () => {
    store.set("ladder", x);
    const L = ladderModel(x, d), f = L.final, c = L.cur, per = L.per;
    const created = f.equity3 - L.todayValue;
    const ok = per.minDscr == null || per.minDscr >= 1.5, warn = per.minDscr != null && per.minDscr >= 1.2 && per.minDscr < 1.5;
    const max = Math.max(...L.steps.map((s) => s.value));
    $("#lr").innerHTML = `
      <div class="kpis">
        <div class="kpi"><span>Your company today</span><b>${money(L.todayValue, c)}</b><small>${multipleFor(x.myEbitda, c)}× ${money(x.myEbitda, c)} profit</small></div>
        <div class="kpi accent"><span>After ${x.deals} acquisitions</span><b>${money(f.value, c)}</b><small>${f.multiple}× ${money(f.ebitda, c)} profit</small></div>
        <div class="kpi"><span>Your equity in 3 years</span><b>${money(f.equity3, c)}</b><small>${created >= 0 ? "+" : ""}${money(created, c)} vs. today</small></div>
      </div>
      <div class="dscr-line ${ok ? "good" : warn ? "warn" : "bad"}">
        <b>${ok ? "✓ Bankable" : warn ? "! Tight" : "✕ Not bankable"}</b>
        <span>Each company you buy covers its own repayments ${per.minDscr == null ? "fully (no debt)" : per.minDscr.toFixed(2) + "× in its weakest year"} (lenders want 1.5×). Total price ${money(f.price, c)}; your cash in ${money(per.cashFromYou * x.deals, c)}${f.outsideStake ? `; sellers and investors end up with ~${Math.round(f.outsideStake * 100)}% of the group` : ""}.</span>
      </div>
      <div class="panel ladder-chart">
        <h3>Group value after each acquisition</h3>
        <table><thead><tr><th>Deals</th><th>Profit</th><th>Multiple</th><th class="bar-col">Value</th></tr></thead>
        <tbody>${L.steps.map((s) => `<tr title="${s.n} deals: ${money(s.value, c)} value, ${money(s.price, c)} paid">
          <td>${s.n === 0 ? "Today" : s.n}</td><td>${money(s.ebitda, c)}</td><td>${s.multiple}×</td>
          <td class="bar-col"><div class="bar-cell"><div class="bar"><span style="width:${(100 * s.value) / max}%"></span></div><b>${money(s.value, c)}</b></div></td></tr>`).join("")}</tbody></table>
      </div>
      <div class="ask-josh"><p>Want Josh to pressure-test this plan?</p><button class="ghost" id="askLadder" type="button">Ask Josh about these numbers →</button></div>`;
    $("#askLadder").addEventListener("click", () => askJoshAbout(`Pressure-test my roll-up plan. My company makes ${money(x.myEbitda, c)} EBITDA. I want to buy ${x.deals} competitors making about ${money(x.targetEbitda, c)} EBITDA each at ${x.buyMultiple}x. Each deal: ${structureSummary({ ...d, ebitda: x.targetEbitda, multiple: x.buyMultiple }, per)} The model says the group could be worth ${money(f.value, c)} with my equity at ${money(f.equity3, c)} after 3 years. What am I missing and what would you change?`));
  };
  $("#lf").addEventListener("input", (e) => {
    const el = e.target; if (!el.name) return;
    x[el.name] = Number(el.value);
    const out = el.parentElement.querySelector("output");
    if (out) out.textContent = el.name === "buyMultiple" ? `${el.value}× profit` : el.name === "deals" ? el.value : `${el.value}%`;
    draw();
  });
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
