import { $, $$, esc, safeUrl, api, post, md, view, stale, toast, fail, dialog, confirmBox, when, todayYmd, addDays, dateLabel, skeleton, micButton, MIC } from "../core.js";
import { STAGES, stageById, dealModel, targetDeal, money } from "../deal.js";
import { TARGET_FIELDS } from "./pipeline.js";
import { askJoshAbout } from "./josh.js";
import { loadDeal } from "./builder.js";
import { composeEmail } from "./email.js";
import { pushDialog, deepEnrichDialog } from "./outreach.js";

const KIND_LABEL = { note: "Note", call: "Call", email: "Email", meeting: "Meeting", stage: "Stage", doc: "Document" };
const LANGS = ["", "English", "Spanish", "French", "German", "Dutch", "Italian", "Portuguese"];

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
          <p class="muted">${esc([t.industry, t.location].filter(Boolean).join(" · ") || "Add the industry and location so the agents can write about it")}${t.website ? ` · <a href="${safeUrl(t.website)}" target="_blank" rel="noopener noreferrer">${esc(t.website.replace(/^https?:\/\//, "").replace(/\/$/, ""))}</a>` : ""}</p></div>
        <label class="stage-select">Stage<select id="stage" aria-label="Stage">${STAGES.map((s) => `<option value="${s.id}" ${s.id === t.stage ? "selected" : ""}>${s.label}</option>`).join("")}</select></label>
      </div>
      <div class="row th-actions">
        <button class="primary" id="askJosh" type="button">Ask Josh about ${esc(t.name.length > 24 ? "this target" : t.name)}</button>
        <button class="ghost" id="emailOwner" type="button">✉ Email the owner</button>
        <a class="ghost" href="#/dialer?target=${t.id}">✆ Call</a>
        <button class="ghost" id="pushCampaign" type="button">⇢ Add to campaign</button>
        <button class="ghost" id="aiCallBtn" type="button" title="An AI assistant calls to find the owner and the best time">🤖 AI call</button>
        <button class="ghost" id="meetBtn" type="button" title="A notetaker joins your Zoom/Meet/Teams call and writes the notes">● Record a meeting</button>
        <a class="ghost" href="#/simulator?target=${t.id}">☎ Practise the call</a>
        <a class="ghost" href="#/builder?target=${t.id}">⚖ Structure the deal</a>
        <button class="ghost" id="edit" type="button">Edit details</button>
        <button class="icon-btn" id="del" type="button" aria-label="Delete target" title="Delete target">🗑</button>
      </div>
    </header>
    <div class="target-grid">
      <div class="tg-main">
        ${intelPanel(t)}
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
            <div class="aa"><b>€ Lender pack</b><p class="muted small">The financing request, the stress test and who to call.</p><button class="ghost" data-gen="lender" type="button">Build the lender pack</button></div>
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
          <div class="panel-head"><h2 class="h3">Contacts</h2><button class="mini-btn" id="findContacts" type="button">${t.contacts.length ? "Search again" : "Find contacts"}</button></div>
          ${t.contacts.length ? `<ul class="contact-list">${t.contacts.map((c) => `<li class="cl-${c.confidence}">
            <div><a href="${c.kind === "email" ? `mailto:${esc(c.value)}` : c.kind === "linkedin" ? safeUrl(c.value) : `tel:${esc(c.value.replace(/\s/g, ""))}" data-target="${t.id}`}" ${c.kind === "linkedin" ? 'target="_blank" rel="noopener noreferrer"' : ""}>${c.kind === "linkedin" ? "LinkedIn profile" : esc(c.value)}</a><small>${esc(c.label)} · ${esc(c.source)}${c.confidence === "guess" ? " · <b>guess</b>" : ""}</small></div>
            <span>${c.kind === "email" ? `<button class="mini-btn" data-mail="${esc(c.value)}" type="button" title="Email">✉</button>` : ""}<button class="mini-btn" data-cp="${esc(c.value)}" type="button" title="Copy">⧉</button><button class="mini-btn" data-del-c="${c.id}" type="button" title="Remove" aria-label="Remove">✕</button></span></li>`).join("")}</ul>`
            : `<p class="muted small">${t.website ? "Reads their website for emails and phone numbers, and suggests the owner's likely address." : "Add their website (Edit details) so the contact finder can read it, or add contacts by hand."}</p>`}
          <div class="row small"><button class="link-btn small" id="addContact" type="button">+ Add an email or phone</button><button class="link-btn small" id="deepEnrich" type="button">Deep enrich (owner email, LinkedIn, mobile) →</button></div>
          ${t.calls?.length ? `<h3 class="h4">Calls</h3><ul class="link-list">${t.calls.slice(0, 6).map((x) => `<li><span>${esc(x.disposition.replace("_", " "))}${x.notes ? `<small class="muted block">${esc(x.notes.slice(0, 90))}</small>` : ""}</span><small>${when(x.created_at)}</small></li>`).join("")}</ul>` : ""}
          ${t.campaigns?.length ? `<h3 class="h4">Campaigns</h3><ul class="link-list">${t.campaigns.map((x) => `<li><span>${esc(x.campaign_name || x.provider)}<small class="muted block">${esc(x.provider)} · ${esc(x.email)}</small></span><small class="${x.status === "failed" ? "tone-bad" : x.status === "replied" ? "tone-ok" : ""}">${esc(x.status)}</small></li>`).join("")}</ul>` : ""}
          ${t.emails.length ? `<h3 class="h4">Emails sent</h3><ul class="link-list">${t.emails.map((e) => `<li><span>${esc(e.subject)}<small class="muted block">to ${esc(e.to_email)}</small></span><small class="${e.status === "failed" ? "tone-bad" : ""}">${e.status === "failed" ? "failed" : when(e.created_at)}</small></li>`).join("")}</ul>` : ""}
        </section>
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

  const mail = (to = "") => composeEmail({ target: t, contacts: t.contacts, to }).then((sent) => { if (sent) renderTarget(id, seq); });
  $("#emailOwner").addEventListener("click", () => mail());
  $("#researchBtn")?.addEventListener("click", async (e) => {
    const b = e.currentTarget; b.disabled = true; b.textContent = "Researching… (20–40s)";
    try { const r = await post(`/api/targets/${t.id}/research`); toast(r.receipt); renderTarget(id, seq); } catch (err) { fail(err); b.disabled = false; b.textContent = "Research this company"; }
  });
  $("#aiCallBtn").addEventListener("click", async () => {
    const phone = (t.contacts || []).find((c) => c.kind === "phone")?.value || t.phone || "";
    const r = await dialog({ title: `AI call: ${t.name}`, submit: "Queue the call", html: `<p class="muted small">Your AI assistant line calls, says it's an AI, and asks for the owner's name and the best time to reach them (or what you write below). US and Canadian numbers. About $0.26 a minute. It waits for approval in the Inbox, and the transcript lands on the timeline.</p>
      <label class="field">Number<input name="to" value="${esc(phone)}" placeholder="+1 208 555 0100" required></label><label class="field">What to find out (optional)<textarea name="instructions" rows="3" placeholder="e.g. Confirm Jim Ellis is still the owner and ask when he's usually in the office"></textarea></label>` });
    if (!r) return;
    try { const q = await post("/api/inbox", { tool: "ai_call", input: { to: r.to, target_id: t.id, instructions: r.instructions }, target_id: t.id }); toast(q.queued ? "Queued in the Inbox for approval" : "Already queued"); } catch (e) { fail(e); }
  });
  $("#meetBtn").addEventListener("click", async () => {
    const r = await dialog({ title: `Record a meeting with ${t.name}`, submit: "Send the notetaker", html: `<p class="muted small">A notetaker bot joins your Zoom, Google Meet, Teams or Webex call and records it. When it ends, the notes (facts, motivations, numbers, next steps) and the transcript land on this target. About $0.50 per meeting hour. Tell the owner the call is recorded.</p>
      <label class="field">Meeting link<input name="meeting_url" type="url" required placeholder="https://zoom.us/j/…"></label><label class="field">Join at (leave empty to join now)<input name="join_at" type="datetime-local"></label>` });
    if (!r) return;
    try { const out = await post("/api/meetings/record", { meeting_url: r.meeting_url, target_id: t.id, join_at: r.join_at ? new Date(r.join_at).toISOString() : undefined }); toast(out.receipt); } catch (e) { fail(e); }
  });
  $("#pushCampaign").addEventListener("click", async () => { if (await pushDialog([t])) renderTarget(id, seq); });
  $("#deepEnrich").addEventListener("click", async () => { if (await deepEnrichDialog(t)) renderTarget(id, seq); });
  $$("[data-mail]").forEach((b) => b.addEventListener("click", () => mail(b.dataset.mail)));
  $$("[data-cp]").forEach((b) => b.addEventListener("click", () => navigator.clipboard.writeText(b.dataset.cp).then(() => toast("Copied"))));
  $("#findContacts").addEventListener("click", async (e) => {
    const b = e.currentTarget; b.disabled = true; b.textContent = "Reading their website…";
    try { const r = await post(`/api/targets/${t.id}/contacts/find`); toast(r.receipt); renderTarget(id, seq); } catch (err) { fail(err); b.disabled = false; b.textContent = "Find contacts"; }
  });
  $("#addContact").addEventListener("click", async () => {
    const r = await dialog({ title: "Add a contact", submit: "Add", html: `<label class="field">Type<select name="kind"><option value="email">Email</option><option value="phone">Phone</option></select></label><label class="field">Email or phone<input name="value" required></label><label class="field">Who is it? (optional)<input name="label" placeholder="e.g. Frank (owner)"></label>` });
    if (!r) return;
    try { await post(`/api/targets/${t.id}/contacts`, r); renderTarget(id, seq); } catch (e) { fail(e); }
  });
  $$("[data-del-c]").forEach((b) => b.addEventListener("click", async () => { try { await api(`/api/targets/${t.id}/contacts/${b.dataset.delC}`, { method: "DELETE" }); renderTarget(id, seq); } catch (e) { fail(e); } }));
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

// Research dossier: seller readiness, signals and hooks (or the button to run it).
function intelPanel(t) {
  const i = t.intel;
  if (!i) return `<section class="panel intel empty-intel"><div class="panel-head"><h2 class="h3">Research</h2><button class="primary" id="researchBtn" type="button">Research this company</button></div>
    <p class="muted small">Reads their Google profile and latest reviews (and the owner's replies), their website's about and team pages, and the news, then scores how ready the owner may be to sell. About $0.01–0.02.</p></section>`;
  const tone = i.score >= 70 ? "hot" : i.score >= 45 ? "warm" : "cold";
  const list = (title, xs) => (xs?.length ? `<div><h3 class="h4">${title}</h3><ul class="intel-list">${xs.slice(0, 5).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : "");
  return `<section class="panel intel">
    <div class="panel-head"><h2 class="h3">Research</h2><button class="ghost small" id="researchBtn" type="button">Refresh</button></div>
    <div class="intel-top"><div class="readiness ${tone}"><b>${i.score}</b><span>seller readiness</span></div>
      <div><p>${esc(i.readiness_reason || "")}</p><p class="muted small">${esc([i.ownership, i.years_in_business ? `${i.years_in_business} years` : "", i.employees_estimate ? `~${i.employees_estimate} staff` : "", i.revenue_estimate && i.revenue_estimate !== "unknown" ? i.revenue_estimate : "", i.google ? `${i.google.rating ?? "?"}★ (${i.google.reviews ?? 0})` : ""].filter(Boolean).join(" · "))} · researched ${when(i.updated_at)}</p></div></div>
    <div class="intel-grid">${list("Conversation hooks", i.conversation_hooks)}${list("Succession signals", i.succession_signals)}${list("Owner signals", i.owner_signals)}${list("Red flags", i.red_flags)}</div>
  </section>`;
}

export async function generateFor(t, btn) {
  const kind = btn.dataset.gen;
  const payload = { kind, target_id: t.id };
  if (kind === "outreach") { payload.channel = $("#channel").value; payload.language = $("#lang").value; }
  if (kind === "diligence") {
    const r = await dialog({ title: `Diligence review: ${t.name}`, wide: true, submit: "Review", html: `<p class="muted small">Paste the P&amp;L, management accounts or tax-return figures: several years if you have them. Text, copied from a spreadsheet, or a CSV all work. It stays in your workspace.</p><label class="field">Link to a PDF, Excel or Word file (CIM, P&amp;L, tax return)<input name="file_url" type="url" placeholder="https://… (a Dropbox/Drive public link works)"></label><p class="muted small">…or paste the figures:</p><label class="field">Financials<textarea name="financials" rows="10" placeholder="2023  Revenue 6,410,000  Cost of sales 3,980,000  Wages 1,120,000  Owner salary 60,000  Rent (owner's building) 24,000 ..."></textarea></label>` });
    if (!r) return;
    if (!r.file_url && String(r.financials || "").trim().length < 40) { toast("Paste the figures or link the file", "error"); return; }
    payload.financials = r.financials; if (r.file_url) payload.file_url = r.file_url;
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
