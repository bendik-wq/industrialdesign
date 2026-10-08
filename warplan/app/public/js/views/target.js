import { $, $$, esc, api, post, md, view, stale, toast, fail, dialog, confirmBox, when, todayYmd, addDays, dateLabel, skeleton, micButton, MIC } from "../core.js";
import { STAGES, stageById, dealModel, targetDeal, money } from "../deal.js";
import { TARGET_FIELDS } from "./pipeline.js";
import { askJoshAbout } from "./josh.js";
import { loadDeal } from "./builder.js";

const KIND_LABEL = { note: "Note", call: "Call", email: "Email", meeting: "Meeting", stage: "Stage", doc: "Document" };
const LANGS = ["", "English", "Spanish", "French", "German", "Norwegian", "Swedish", "Danish", "Dutch", "Italian", "Portuguese"];

export async function renderTarget(id, seq) {
  view().innerHTML = skeleton(6);
  const t = await api(`/api/targets/${id}`).catch((e) => (e.status === 404 ? null : Promise.reject(e)));
  if (stale(seq)) return;
  if (!t) { toast("That target doesn't exist any more."); location.hash = "#/pipeline"; return; }
  const d = targetDeal(t, loadDeal()), m = dealModel(d), c = t.currency || "$";
  const today = todayYmd(), late = t.next_date && t.next_date < today;
  const fact = (label, v) => (v || v === 0 ? `<div><dt>${label}</dt><dd>${v}</dd></div>` : "");
  view().innerHTML = `
    <header class="page-head target-head">
      <a class="link" href="#/pipeline">← Pipeline</a>
      <div class="th-row">
        <div class="th-main"><h1>${esc(t.name)}</h1>
          <p class="muted">${esc([t.industry, t.location].filter(Boolean).join(" · ") || "Add the industry and location so the agents can write about it")}${t.website ? ` · <a href="${esc(t.website)}" target="_blank" rel="noopener noreferrer">${esc(t.website.replace(/^https?:\/\//, "").replace(/\/$/, ""))}</a>` : ""}</p></div>
        <label class="stage-select">Stage<select id="stage" aria-label="Stage">${STAGES.map((s) => `<option value="${s.id}" ${s.id === t.stage ? "selected" : ""}>${s.label}</option>`).join("")}</select></label>
      </div>
      <div class="row th-actions">
        <button class="primary" id="askJosh" type="button">Ask Josh about ${esc(t.name.length > 24 ? "this target" : t.name)}</button>
        <a class="ghost" href="#/simulator?target=${t.id}">☎ Practise the call</a>
        <a class="ghost" href="#/builder?target=${t.id}">⚖ Structure the deal</a>
        <button class="ghost" id="edit" type="button">Edit details</button>
        <button class="icon-btn" id="del" type="button" aria-label="Delete target" title="Delete target">🗑</button>
      </div>
    </header>
    <div class="target-grid">
      <div class="tg-main">
        <section class="panel next-card ${late ? "late" : ""}">
          <h2 class="h3">Next action</h2>
          <form id="nextForm" class="next-form">
            <input name="next_action" value="${esc(t.next_action)}" placeholder="What happens next? e.g. Call Frank Tuesday morning" maxlength="300" aria-label="Next action">
            <input name="next_date" type="date" value="${t.next_date || ""}" aria-label="Due date">
            <button class="ghost" type="submit">Save</button>
            ${t.next_action ? `<button class="primary" type="button" id="doneNext">Done ✓</button>` : ""}
          </form>
          ${late ? `<p class="tone-bad small">Overdue since ${dateLabel(t.next_date)}. Do it today or move the date honestly.</p>` : ""}
        </section>

        <section class="panel">
          <h2 class="h3">Put the team on it</h2>
          <div class="agent-actions">
            <div class="aa"><b>✉ Outreach</b><p class="muted small">First contact in a voice that makes them feel safe.</p>
              <div class="row"><select id="channel" aria-label="Channel"><option value="letter">Letter</option><option value="email">Email</option><option value="call">Cold-call script</option><option value="voicemail">Voicemail</option><option value="linkedin">LinkedIn</option></select>
              <select id="lang" aria-label="Language">${LANGS.map((l) => `<option value="${l}">${l || "Language: auto"}</option>`).join("")}</select>
              <button class="ghost" data-gen="outreach" type="button">Write it</button></div></div>
            <div class="aa"><b>✎ Letter of intent</b><p class="muted small">From this target's Deal Builder structure${t.deal ? "" : " (the default one until you structure it)"}.</p><button class="ghost" data-gen="loi" type="button">Draft the LOI</button></div>
            <div class="aa"><b>✎ Investment memo</b><p class="muted small">The case for the board, with a bad-year stress test.</p><button class="ghost" data-gen="memo" type="button">Write the memo</button></div>
            <div class="aa"><b>⌕ Diligence</b><p class="muted small">Paste their P&amp;L: normalised EBITDA, red flags, questions.</p><button class="ghost" data-gen="diligence" type="button">Review financials</button></div>
            <div class="aa"><b>⧉ 100-day plan</b><p class="muted small">Day-1 words for staff and customers, then cash and control.</p><button class="ghost" data-gen="plan100" type="button">Plan the first 100 days</button></div>
          </div>
        </section>

        <section class="panel">
          <h2 class="h3">Timeline</h2>
          <form id="noteForm" class="note-form">
            <div class="row"><select name="kind" aria-label="Type">${["note", "call", "email", "meeting"].map((k) => `<option value="${k}">${KIND_LABEL[k]}</option>`).join("")}</select><span class="muted small">Log what happened. The agents read it.</span></div>
            <div class="note-input"><textarea name="body" rows="2" placeholder="e.g. Spoke to Frank for 20 minutes. Wants to keep his two senior techs. Open to a coffee next week." aria-label="Note"></textarea>
              <button class="mic" type="button" id="noteMic" aria-label="Dictate a note">${MIC}</button></div>
            <button class="primary" type="submit">Add to timeline</button>
          </form>
          <ol class="timeline">${t.events.map((e) => `<li class="ev ev-${e.kind}"><div class="ev-head"><span class="ev-kind">${KIND_LABEL[e.kind] || e.kind}</span><span class="muted small">${esc(e.user_name)} · ${when(e.created_at)}</span>${e.kind !== "stage" && e.kind !== "doc" ? `<button class="mini-btn" data-del-ev="${e.id}" type="button" aria-label="Delete entry">✕</button>` : ""}</div><div class="ev-body">${md(e.body)}</div></li>`).join("") || `<li class="muted small">Nothing logged yet.</li>`}</ol>
        </section>
      </div>

      <aside class="tg-side">
        <section class="panel">
          <h2 class="h3">Facts</h2>
          <dl class="facts">
            ${fact("Owner", esc([t.owner_name, t.owner_age ? `${t.owner_age} years old` : ""].filter(Boolean).join(", ")))}
            ${fact("Revenue", t.revenue != null ? money(t.revenue, c) : "")}${fact("EBITDA", t.ebitda != null ? money(t.ebitda, c) : "")}${fact("Asking", t.asking != null ? money(t.asking, c) : "")}
            ${fact("Employees", t.employees)}${fact("Phone", t.phone ? `<a href="tel:${esc(t.phone)}">${esc(t.phone)}</a>` : "")}${fact("Email", t.email ? `<a href="mailto:${esc(t.email)}">${esc(t.email)}</a>` : "")}
            ${fact("Priority", ["", "High", "Normal", "Low"][t.priority])}${fact("Source", esc(t.source))}${fact("Tags", esc(t.tags))}
            ${fact("In stage since", t.stage_at ? when(t.stage_at) : "")}${t.stage === "lost" && t.lost_reason ? fact("Lost because", esc(t.lost_reason)) : ""}
          </dl>
          ${t.motivation ? `<h3 class="h4">Motivation</h3><div class="small">${md(t.motivation)}</div>` : `<p class="muted small">What does the owner want next? Add it under “Edit details”. The simulator and every agent use it.</p>`}
        </section>
        <section class="panel">
          <h2 class="h3">Deal</h2>
          <div class="deal-snap ${m.works ? "ok" : "no"}"><b>${m.works ? "✓ Works" : "✕ Not yet"}</b><span>${t.deal ? "Saved structure" : "Default structure, not saved"}</span></div>
          <dl class="facts"><div><dt>Price</dt><dd>${money(m.price, d.cur)} <small class="muted">${d.multiple}×</small></dd></div><div><dt>Weakest DSCR</dt><dd>${m.minDscr ? m.minDscr.toFixed(2) + "×" : "no debt"}</dd></div><div><dt>Your votes</dt><dd>${m.yourVotes}%</dd></div><div><dt>Your cash</dt><dd>${money(m.cashFromYou, d.cur)}</dd></div></dl>
          <a class="ghost wide" href="#/builder?target=${t.id}">Open in Deal Builder</a>
        </section>
        <section class="panel">
          <h2 class="h3">Documents</h2>
          ${t.documents.length ? `<ul class="link-list">${t.documents.map((x) => `<li><a href="#/desk/${x.id}">${esc(x.title)}</a><small>${when(x.updated_at)}</small></li>`).join("")}</ul>` : `<p class="muted small">Letters, LOIs and memos the agents write land here.</p>`}
        </section>
        <section class="panel">
          <h2 class="h3">Conversations</h2>
          ${t.threads.length ? `<ul class="link-list">${t.threads.map((x) => `<li><a href="#/${x.agent === "simulator" ? "simulator" : "josh"}/${x.id}">${esc(x.title)}</a><small>${x.agent === "simulator" ? `practice${x.meta.score != null ? ` · ${x.meta.score}/100` : ""}` : "Josh"} · ${when(x.updated_at)}</small></li>`).join("")}</ul>` : `<p class="muted small">Josh conversations and practice calls about ${esc(t.name)}.</p>`}
        </section>
      </aside>
    </div>`;

  const patch = async (data, msg) => { try { await post(`/api/targets/${t.id}`, data, "PATCH"); if (msg) toast(msg); renderTarget(id, seq); } catch (e) { fail(e); } };
  $("#stage").addEventListener("change", async (e) => {
    let extra = {};
    if (e.target.value === "lost") {
      const r = await dialog({ title: `Why did ${t.name} fall through?`, html: `<label class="field">Reason<input name="lost_reason" maxlength="300" placeholder="e.g. price gap, owner kept it"></label>`, submit: "Mark as lost" });
      if (!r) { e.target.value = t.stage; return; }
      extra = r;
    }
    patch({ stage: e.target.value, ...extra }, `Moved to ${stageById(e.target.value).label}`);
  });
  $("#askJosh").addEventListener("click", () => askJoshAbout(`Let's talk about ${t.name}. Where do I stand, what's the smartest next move, and what should I say to ${t.owner_name || "the owner"}?`, t.id));
  $("#edit").addEventListener("click", async () => {
    const r = await dialog({ title: `Edit ${t.name}`, wide: true, submit: "Save", html: `${TARGET_FIELDS(t)}
      <div class="two"><label class="field">Website<input name="website" value="${esc(t.website)}" maxlength="200"></label><label class="field">Employees<input name="employees" type="number" min="0" value="${t.employees ?? ""}"></label></div>
      <div class="three"><label class="field">Phone<input name="phone" value="${esc(t.phone)}" maxlength="40"></label><label class="field">Email<input name="email" type="email" value="${esc(t.email)}" maxlength="160"></label><label class="field">Asking price<input name="asking" type="number" min="0" step="any" value="${t.asking ?? ""}"></label></div>
      <div class="two"><label class="field">Source<input name="source" value="${esc(t.source)}" maxlength="80" placeholder="Letter campaign, referral, broker…"></label><label class="field">Tags<input name="tags" value="${esc(t.tags)}" maxlength="200" placeholder="comma separated"></label></div>
      <label class="field">What the owner wants (motivation, fears, timing)<textarea name="motivation" rows="3" maxlength="2000">${esc(t.motivation)}</textarea></label>` });
    if (r) patch(r, "Saved");
  });
  $("#del").addEventListener("click", async () => {
    if (!(await confirmBox(`Delete ${t.name}?`, "This deletes the target, its timeline and every document the agents wrote for it. It can't be undone."))) return;
    try { await api(`/api/targets/${t.id}`, { method: "DELETE" }); toast("Deleted"); location.hash = "#/pipeline"; } catch (e) { fail(e); }
  });
  $("#nextForm").addEventListener("submit", (e) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); patch(f, "Next action saved"); });
  $("#doneNext")?.addEventListener("click", async () => {
    const r = await dialog({ title: "Nice. What's next?", html: `<p class="muted">Logged: <b>${esc(t.next_action)}</b></p><label class="field">Next action<input name="next_action" maxlength="300" placeholder="e.g. Send the meeting invite"></label><label class="field">Due<input name="next_date" type="date" value="${addDays(3)}"></label>`, submit: "Save" });
    if (!r) return;
    try { await post(`/api/targets/${t.id}/events`, { kind: "note", body: `Done: ${t.next_action}` }); } catch (e) { fail(e); return; }
    patch({ next_action: r.next_action || "", next_date: r.next_action ? r.next_date : null }, "Logged");
  });
  $("#noteForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    if (!f.body.trim()) return;
    try { await post(`/api/targets/${t.id}/events`, f); renderTarget(id, seq); } catch (err) { fail(err); }
  });
  micButton($("#noteMic"), (text) => { const ta = $("#noteForm textarea"); ta.value = (ta.value ? ta.value + " " : "") + text; ta.focus(); }, `Notes after a call with ${t.owner_name || "a business owner"} about selling ${t.name}.`);
  $$("[data-del-ev]").forEach((b) => b.addEventListener("click", async () => {
    if (!(await confirmBox("Delete this entry?", "It will be removed from the timeline."))) return;
    try { await api(`/api/targets/${t.id}/events/${b.dataset.delEv}`, { method: "DELETE" }); renderTarget(id, seq); } catch (e) { fail(e); }
  }));
  $$("[data-gen]").forEach((b) => b.addEventListener("click", () => generateFor(t, b)));
}

export async function generateFor(t, btn) {
  const kind = btn.dataset.gen;
  const payload = { kind, target_id: t.id };
  if (kind === "outreach") { payload.channel = $("#channel").value; payload.language = $("#lang").value; }
  if (kind === "diligence") {
    const r = await dialog({ title: `Diligence review: ${t.name}`, wide: true, submit: "Review", html: `<p class="muted small">Paste the P&amp;L, management accounts or tax-return figures: several years if you have them. Text, copied from a spreadsheet, or a CSV all work. It stays in your workspace.</p><label class="field">Financials<textarea name="financials" rows="12" required placeholder="2023  Revenue 6,410,000  Cost of sales 3,980,000  Wages 1,120,000  Owner salary 60,000  Rent (owner's building) 24,000 ..."></textarea></label>` });
    if (!r) return;
    payload.financials = r.financials;
  }
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = "Writing…";
  btn.closest(".aa")?.classList.add("working");
  try {
    const doc = await post("/api/documents/generate", payload);
    toast(`${doc.title} is ready`);
    location.hash = `#/desk/${doc.id}`;
  } catch (e) { fail(e); btn.disabled = false; btn.textContent = label; btn.closest(".aa")?.classList.remove("working"); }
}
