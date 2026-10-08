import { $, $$, esc, api, post, md, view, stale, toast, fail, confirmBox, copy, download, when, skeleton, emptyState } from "../core.js";
import { askJoshAbout } from "./josh.js";

const KIND = { loi: "Letter of intent", memo: "Investment memo", outreach: "Outreach", diligence: "Diligence", board: "Board pack", plan100: "100-day plan", lender: "Lender pack" };

export async function renderDesk(seq, params) {
  view().innerHTML = skeleton(5);
  const kind = params.get("kind") || "";
  const docs = await api(`/api/documents${kind ? `?kind=${kind}` : ""}`);
  if (stale(seq)) return;
  view().innerHTML = `
    <header class="page-head with-actions"><div><p class="eyebrow">Desk</p><h1>Everything the agents wrote.</h1>
      <p class="lede">Letters, LOIs, memos, diligence reviews, board packs and 100-day plans. Edit them, print them, send them. Generate new ones from any target.</p></div>
      <div class="head-actions"><button class="primary" id="board" type="button">♜ Convene the AI Board</button></div></header>
    <div class="toolbar">
      <div class="seg" role="group" aria-label="Filter by type"><button type="button" data-k="" class="${!kind ? "on" : ""}">All</button>${Object.entries(KIND).map(([k, v]) => `<button type="button" data-k="${k}" class="${kind === k ? "on" : ""}">${v}</button>`).join("")}</div>
    </div>
    ${docs.length ? `<div class="doc-list">${docs.map((d) => `<a class="doc-row" href="#/desk/${d.id}"><span class="doc-kind k-${d.kind}">${KIND[d.kind] || d.kind}</span><b>${esc(d.title)}</b><small>${d.target_name ? esc(d.target_name) + " · " : ""}${when(d.updated_at)}</small></a>`).join("")}</div>`
      : emptyState(kind ? `No ${KIND[kind].toLowerCase()} yet` : "Nothing written yet", "Open a target in your pipeline and put an agent on it, or convene the AI Board to review the whole pipeline.", `<a class="primary" href="#/pipeline">Open the pipeline</a>`)}`;
  $$("[data-k]").forEach((b) => b.addEventListener("click", () => { location.hash = `#/desk${b.dataset.k ? `?kind=${b.dataset.k}` : ""}`; }));
  $("#board").addEventListener("click", async (e) => {
    const b = e.currentTarget;
    b.disabled = true; b.textContent = "The board is meeting…";
    try { const d = await post("/api/documents/generate", { kind: "board" }); location.hash = `#/desk/${d.id}`; }
    catch (err) { fail(err); b.disabled = false; b.textContent = "♜ Convene the AI Board"; }
  });
}

export async function renderDoc(id, seq) {
  view().innerHTML = skeleton(8);
  const d = await api(`/api/documents/${id}`).catch(() => null);
  if (stale(seq)) return;
  if (!d) { toast("That document doesn't exist any more."); location.hash = "#/desk"; return; }
  view().innerHTML = `
    <div class="doc-page">
      <header class="doc-head no-print">
        <a class="link" href="${d.target_id ? `#/targets/${d.target_id}` : "#/desk"}">← ${d.target_id ? esc(d.target_name || "Target") : "Desk"}</a>
        <div class="row">
          <button class="ghost" id="edit" type="button">Edit</button>
          <button class="ghost" id="copy" type="button">Copy</button>
          <button class="ghost" id="dl" type="button">Download</button>
          <button class="ghost" id="print" type="button">Print / PDF</button>
          <button class="ghost" id="ask" type="button">Ask Josh</button>
          <button class="icon-btn" id="del" type="button" aria-label="Delete document" title="Delete">🗑</button>
        </div>
      </header>
      <p class="eyebrow no-print">${KIND[d.kind] || d.kind} · ${when(d.updated_at)}</p>
      <h1 class="doc-title" id="title">${esc(d.title)}</h1>
      <article class="doc prose" id="docBody">${md(d.content)}</article>
      <form class="doc-edit no-print" id="editForm" hidden>
        <label class="field">Title<input name="title" value="${esc(d.title)}" maxlength="200" required></label>
        <label class="field">Text (markdown: # headings, **bold**, - lists, | tables |)<textarea name="content" rows="28">${esc(d.content)}</textarea></label>
        <div class="row"><button class="primary" type="submit">Save</button><button class="ghost" type="button" id="cancel">Cancel</button></div>
      </form>
    </div>`;
  const toggle = (on) => { $("#editForm").hidden = !on; $("#docBody").hidden = on; $("#title").hidden = on; };
  $("#edit").addEventListener("click", () => { toggle(true); $("#editForm textarea").focus(); });
  $("#cancel").addEventListener("click", () => toggle(false));
  $("#editForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try { await post(`/api/documents/${d.id}`, f, "PATCH"); d.title = f.title; d.content = f.content; $("#title").textContent = f.title; $("#docBody").innerHTML = md(f.content); toggle(false); toast("Saved"); } catch (err) { fail(err); }
  });
  $("#copy").addEventListener("click", () => copy(d.content));
  $("#dl").addEventListener("click", () => download(`${d.title.replace(/[^\w\- ]+/g, "").trim() || "document"}.md`, d.content, "text/markdown"));
  $("#print").addEventListener("click", () => window.print());
  $("#ask").addEventListener("click", () => askJoshAbout(`Review this ${KIND[d.kind] || "document"} and tell me straight what to change before I use it:\n\n${d.content.slice(0, 3500)}`, d.target_id || undefined));
  $("#del").addEventListener("click", async () => {
    if (!(await confirmBox("Delete this document?", "It can't be undone."))) return;
    try { await api(`/api/documents/${d.id}`, { method: "DELETE" }); toast("Deleted"); location.hash = d.target_id ? `#/targets/${d.target_id}` : "#/desk"; } catch (e) { fail(e); }
  });
}
