import { $, $$, esc, api, post, md, view, session, stale, toast, fail, dialog, confirmBox, play, stopAudio, micButton, MIC, local, copy, when, skeleton } from "../core.js";

const STARTERS = [
  "What do I actually say on the first call with an owner?",
  "Build me a no-money-down structure for a $600k EBITDA business where I keep control.",
  "Look at my pipeline. Which target should I push hardest this week, and how?",
  "A 68-year-old owner says he has other buyers. What do I say?",
  "What should be in my first offer letter?",
  "I run a $4M HVAC company. How would I buy my biggest competitor with no money down?",
];

export async function askJoshAbout(text, target) {
  const t = await post("/api/threads", { agent: "josh", ...(target ? { target } : {}) });
  sessionStorage.setItem("wp.pending", text);
  location.hash = `#/josh/${t.id}`;
}

// Read a text/event-stream response, calling onEvent for each JSON data payload.
async function readSSE(res, onEvent) {
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const data = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      if (data) { try { onEvent(JSON.parse(data)); } catch { /* ignore a malformed chunk */ } }
    }
  }
}

// Send a message and stream the reply into `bubble`. Resolves with {reply, title}.
export async function streamReply(threadId, text, bubble, signal) {
  const res = await fetch(`/api/threads/${threadId}/messages`, {
    method: "POST", signal,
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ text }),
  });
  if (res.status === 401) { location.href = "/login"; throw new Error("Signed out"); }
  if (!res.ok || !(res.headers.get("Content-Type") || "").includes("event-stream")) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || `Request failed (${res.status})`);
  }
  let acc = "", final = null, error = null, raf = 0;
  const acts = [];
  const paint = () => { raf = 0; bubble.innerHTML = actionsHtml(acts) + md(acc) + '<span class="caret" aria-hidden="true"></span>'; bubble.closest(".msgs")?.scrollTo({ top: 1e9 }); };
  await readSSE(res, (ev) => {
    if (ev.t) { acc += ev.t; if (!raf) raf = requestAnimationFrame(paint); }
    if (ev.action) { acts.push(ev.action); if (!raf) raf = requestAnimationFrame(paint); }
    if (ev.done) final = ev;
    if (ev.error) error = ev.error;
  });
  if (error) throw new Error(error);
  return final ? { ...final, content: [final.receipts, final.reply].filter(Boolean).join("\n\n") } : { reply: acc, content: acc };
}

// Live receipts while the agent works: what it read (quietly) and what it changed (prominently).
const TOOL_LABEL = { search_pipeline: "Searched the pipeline", get_target: "Read the target", pipeline_overview: "Checked the pipeline", list_documents: "Looked at documents", get_document: "Read a document", model_deal: "Ran the deal engine", draft_document: "Writing a document" };
export function actionsHtml(acts) {
  if (!acts.length) return "";
  return `<div class="acts">${acts.map((a) => `<div class="act ${a.ok ? (a.write ? "did" : "read") : "fail"}">${a.ok ? (a.write ? "✓" : "·") : "✕"} ${esc(a.write || !a.ok ? a.receipt || a.name : TOOL_LABEL[a.name] || a.name)}${a.link ? ` <a href="${esc(a.link.replace(/^\//, ""))}">open</a>` : ""}</div>`).join("")}</div>`;
}

function bubble(m, speaker) {
  if (m.role === "user") return `<div class="msg user">${md(m.content)}</div>`;
  return `<div class="msg assistant">${md(m.content)}<div class="msg-tools"><button class="say" type="button" title="Play out loud" aria-label="Play out loud" data-speaker="${speaker}">▶</button><button class="mini-btn" type="button" data-copy title="Copy">Copy</button></div><textarea hidden>${esc(m.content)}</textarea></div>`;
}
export function wireBubbles(root) {
  $$(".msg.assistant:not([data-wired])", root).forEach((b) => {
    b.dataset.wired = "1";
    const text = () => $("textarea", b)?.value || b.textContent;
    $(".say", b)?.addEventListener("click", (e) => { const s = e.currentTarget; s.classList.contains("on") ? stopAudio() : play(text(), s.dataset.speaker, s); });
    $("[data-copy]", b)?.addEventListener("click", () => copy(text()));
  });
}
const scrollDown = () => { const m = $("#msgs"); if (m) m.scrollTop = m.scrollHeight; };

export async function renderJosh(id, seq) {
  view().innerHTML = skeleton(5);
  const [threads, t] = await Promise.all([api("/api/threads?agent=josh"), id ? api(`/api/threads/${id}`).catch(() => null) : null]);
  if (stale(seq)) return;
  if (id && !t) { toast("That conversation doesn't exist any more."); location.hash = "#/josh"; return; }
  const autoSpeak = local.get("speak", true);
  const brain = session.team.brain;
  view().innerHTML = `
    <div class="chat-layout">
      <aside class="threads" aria-label="Conversations">
        <button class="primary wide" id="newThread" type="button">+ New conversation</button>
        <input class="thread-search" id="threadSearch" type="search" placeholder="Search conversations" aria-label="Search conversations">
        <div id="threadList">${threadList(threads, id)}</div>
      </aside>
      <section class="chat">
        <header class="chat-head">
          <div class="avatar josh">J</div>
          <div><h1 class="h2">Josh <span class="tag">AI</span>${t?.target ? ` <a class="chip" href="#/targets/${t.target.id}">${esc(t.target.name)}</a>` : ""}</h1>
            <p class="muted small">Trained on Josh Li's own videos and he can see your pipeline. The AI version, not Josh himself; get legal, tax and lending specifics signed off by your advisors.</p></div>
          <div class="chat-actions">
            <label class="switch"><input type="checkbox" id="speakToggle" ${autoSpeak ? "checked" : ""}><span></span>Speak</label>
            ${t ? `<button class="icon-btn" id="threadMenu" type="button" aria-label="Rename or delete" title="Rename or delete">⋯</button>` : ""}
          </div>
        </header>
        <div class="msgs" id="msgs" aria-live="polite">
          ${t && t.messages.length ? t.messages.map((m) => bubble(m, "arcas")).join("") : `<div class="empty-chat"><div class="avatar josh big">J</div><h2>What are you trying to buy?</h2><p class="muted">Tap the mic and talk, or pick one:</p>
            <div class="starters">${STARTERS.map((s) => `<button type="button" class="starter">${esc(s)}</button>`).join("")}</div></div>`}
        </div>
        <div class="composer">
          <button class="mic big" id="mic" type="button" aria-label="Talk to Josh">${MIC}</button>
          <textarea id="input" rows="1" placeholder="Type, or tap the mic and talk…" aria-label="Message to Josh"></textarea>
          <button class="primary" id="send" type="button">Send</button>
        </div>
        <p class="brain muted">${brain.kind === "claude" ? `Claude · ${esc(brain.model)}${brain.own ? " · your key" : ""}` : `Workers AI · <a href="#/settings/integrations">connect Claude for sharper answers</a>`}</p>
      </section>
    </div>`;
  $("#speakToggle").addEventListener("change", (e) => local.set("speak", e.target.checked));
  $("#newThread").addEventListener("click", async () => { try { const n = await post("/api/threads", { agent: "josh" }); location.hash = `#/josh/${n.id}`; } catch (e) { fail(e); } });
  let searchT;
  $("#threadSearch").addEventListener("input", (e) => {
    clearTimeout(searchT);
    searchT = setTimeout(async () => { const list = await api(`/api/threads?agent=josh&q=${encodeURIComponent(e.target.value)}`); if (!stale(seq)) $("#threadList").innerHTML = threadList(list, id, e.target.value); }, 250);
  });
  $("#threadMenu")?.addEventListener("click", () => threadMenu(t));
  wireBubbles($("#msgs"));
  scrollDown();

  let threadId = id, busy = false, controller = null;
  const sendBtn = $("#send");
  const send = async (text) => {
    text = text.trim();
    if (!text || busy) return;
    if (!threadId) {
      try { const n = await post("/api/threads", { agent: "josh" }); threadId = n.id; history.replaceState(null, "", `#/josh/${n.id}`); } catch (e) { fail(e); return; }
    }
    busy = true;
    $(".empty-chat")?.remove();
    $("#input").value = ""; $("#input").style.height = "auto";
    $("#msgs").insertAdjacentHTML("beforeend", bubble({ role: "user", content: text }, "arcas") + `<div class="msg assistant streaming"><div class="typing"><span></span><span></span><span></span></div></div>`);
    const live = $$(".msg.assistant.streaming").pop();
    scrollDown();
    controller = new AbortController();
    sendBtn.textContent = "Stop"; sendBtn.classList.add("stop");
    try {
      const r = await streamReply(threadId, text, live, controller.signal);
      live.outerHTML = bubble({ role: "assistant", content: r.content || r.reply }, "arcas");
      wireBubbles($("#msgs"));
      if ($("#speakToggle")?.checked && r.reply) play(r.reply, "arcas", $$(".msg.assistant .say").pop());
      // New conversations get their title from the first message: refresh the list.
      api("/api/threads?agent=josh").then((list) => { if (!stale(seq)) $("#threadList").innerHTML = threadList(list, threadId); }).catch(() => {});
    } catch (e) {
      if (e.name === "AbortError") live.insertAdjacentHTML("beforeend", `<p class="muted small">Stopped. The full answer is saved in the conversation.</p>`);
      else { live.remove(); $("#msgs").insertAdjacentHTML("beforeend", `<p class="error">${esc(e.message)}</p>`); $("#input").value = text; }
    }
    live.classList.remove("streaming");
    busy = false; controller = null;
    sendBtn.textContent = "Send"; sendBtn.classList.remove("stop");
    scrollDown();
  };
  sendBtn.addEventListener("click", () => (busy ? controller?.abort() : send($("#input").value)));
  $("#input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(e.target.value); } });
  $("#input").addEventListener("input", (e) => { e.target.style.height = "auto"; e.target.style.height = `${Math.min(180, e.target.scrollHeight)}px`; });
  $$(".starter").forEach((b) => b.addEventListener("click", () => send(b.textContent)));
  micButton($("#mic"), send, "A question for an acquisition advisor about buying a business: vendor finance, bank debt, rollover equity, earn-outs.");
  const pending = sessionStorage.getItem("wp.pending");
  if (pending) { sessionStorage.removeItem("wp.pending"); send(pending); } else $("#input").focus({ preventScroll: true });
}

function threadList(threads, id, q = "") {
  if (!threads.length) return `<p class="muted small pad">${q ? "Nothing matches." : "Your conversations with Josh show up here."}</p>`;
  return threads.map((x) => `<a class="thread ${x.id === id ? "on" : ""}" href="#/josh/${x.id}"><b>${esc(x.title)}</b><small>${when(x.updated_at)}${x.meta?.target ? " · target" : ""}</small></a>`).join("");
}

async function threadMenu(t) {
  const r = await dialog({
    title: "Conversation",
    html: `<label class="field">Title<input name="title" value="${esc(t.title)}" maxlength="120" required></label>
      <p class="muted small">Started ${when(t.created_at)} · ${t.messages.length} messages</p>
      <button type="button" class="link danger" data-del>Delete this conversation</button>`,
    onOpen: (d, done) => $("[data-del]", d).addEventListener("click", async () => {
      done(null);
      if (await confirmBox("Delete conversation?", "This removes every message in it. It can't be undone.")) {
        try { await api(`/api/threads/${t.id}`, { method: "DELETE" }); toast("Deleted"); location.hash = "#/josh"; } catch (e) { fail(e); }
      }
    }),
  });
  if (!r) return;
  try { await post(`/api/threads/${t.id}`, { title: r.title }, "PATCH"); toast("Renamed"); window.dispatchEvent(new HashChangeEvent("hashchange")); } catch (e) { fail(e); }
}
