// Prospecting bots: set one up per patch (what you buy, where), and it finds the businesses, emails the owner
// directly, follows up every weekday and hands you the ones to call.
import { $, $$, esc, api, post, toast, fail, view, stale, session, dialog, confirmBox, skeleton, when } from "../core.js";
import { renderEmail, DEFAULT_TEMPLATES, MAX_TOUCHES, buyingFor } from "../bot-emails.js";

const STATUS = { active: "Emailing", call: "To call", replied: "Replied", no_email: "No email: call", opted_out: "Opted out", bounced: "Bounced", removed: "Stopped", called: "Called" };
const KIND = { owner: "owner", decision_maker: "decision maker", front_desk: "front desk" };
const LOGICON = { found: "＋", sent: "✉", follow_up: "↻", queued: "⧗", replied: "★", call: "☎", skipped: "–", error: "!", run: "▸" };
const TZS = ["Australia/Melbourne", "Australia/Sydney", "Australia/Brisbane", "Australia/Adelaide", "Australia/Perth", "Pacific/Auckland", "Europe/London", "Europe/Oslo", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles"];
let industries = null;

export async function renderBots(seq, params, id) {
  view().innerHTML = skeleton(4);
  const [d, scout] = await Promise.all([api("/api/bots"), industries ? Promise.resolve(null) : api("/api/scout").catch(() => null)]);
  if (stale(seq)) return;
  if (scout) industries = scout.industries;
  if (id) return renderBot(seq, d, id, params);
  const owner = !!session.me?.isOwner;
  view().innerHTML = `
    <header class="page-head with-actions">
      <div><p class="eyebrow">Agents · Outbound</p><h1>Prospecting bots</h1>
        <p class="lede">Each bot works one patch. Every weekday morning it finds the businesses you'd buy there, emails the owner directly (“we're looking to buy … have you ever thought about selling?”), follows up, and hands you the ones to call.</p></div>
      ${owner ? `<div class="head-actions"><button class="primary" id="newBot" type="button">+ New bot</button></div>` : ""}
    </header>
    ${!d.mailbox ? `<p class="banner">Connect your mailbox first so the bot can send from your own address: <a href="#/settings/email">Settings → Email</a>.</p>` : ""}
    ${!d.data_ready ? `<p class="banner">Business search isn't connected for this workspace yet: <a href="#/settings/integrations">Settings → Integrations</a>.</p>` : ""}
    ${d.bots.length ? `<div class="bot-grid">${d.bots.map((b) => card(b, owner)).join("")}</div>`
      : `<div class="empty"><h2>No bots yet</h2><p class="muted">Start with one: the kind of business you buy, the area, and how you sign off. It starts in review mode, so nothing goes out until you approve it in the Inbox.</p>${owner ? `<button class="primary" type="button" id="newBot2">Set up your first bot</button>` : ""}</div>`}
    <p class="muted small">Every email carries your name and an opt-out line. Anyone who replies, opts out or bounces is never emailed by the bot again, and each prospect gets at most the number of emails you set (up to ${MAX_TOUCHES}).</p>`;
  $("#newBot")?.addEventListener("click", () => editBot(d));
  $("#newBot2")?.addEventListener("click", () => editBot(d));
  wireCards(d, seq, params);
}

function card(b, owner) {
  const s = b.stats || {};
  return `<article class="bot-card ${b.status}">
    <header><a href="#/bots/${b.id}"><h2>${esc(b.name)}</h2></a><span class="chip ${b.status === "active" ? "on" : ""}">${b.status === "active" ? (b.running ? "Running…" : "Active") : "Paused"}</span><span class="chip">${b.mode === "autopilot" ? "Autopilot" : "Review first"}</span></header>
    <p class="muted small">${esc(b.buying || "")} · ${esc((b.areas || []).join(" · "))}</p>
    <div class="bot-stats">
      <div><b>${(s.active || 0)}</b><span>emailing</span></div><div><b>${s.emails || 0}</b><span>emails</span></div>
      <div><b>${s.replied || 0}</b><span>replied</span></div><div class="${(s.call || 0) + (s.no_email || 0) ? "hot" : ""}"><b>${(s.call || 0) + (s.no_email || 0)}</b><span>to call</span></div>
    </div>
    <footer class="row"><a class="ghost small" href="#/bots/${b.id}">Open</a>${owner ? `<button class="ghost small" type="button" data-run="${b.id}">Run now</button>
      <button class="ghost small" type="button" data-toggle="${b.id}">${b.status === "active" ? "Pause" : "Start"}</button>` : ""}
      <span class="muted small">${b.last_run_on ? `Last run ${esc(b.last_run_on)}` : "Not run yet"} · ${b.daily_new}/day · ${b.touches} emails each</span></footer>
  </article>`;
}

function wireCards(d, seq, params, reload = () => renderBots(++session.seq, params)) {
  $$("[data-toggle]").forEach((btn) => btn.addEventListener("click", async () => {
    const b = d.bots.find((x) => x.id === +btn.dataset.toggle);
    try { await post(`/api/bots/${b.id}`, { status: b.status === "active" ? "paused" : "active" }, "PATCH"); toast(b.status === "active" ? "Paused" : "Started: it runs every weekday morning"); reload(); } catch (e) { fail(e); }
  }));
  $$("[data-run]").forEach((btn) => btn.addEventListener("click", async () => {
    btn.disabled = true; btn.textContent = "Running… (a few minutes)";
    try { const r = await post(`/api/bots/${btn.dataset.run}/run`, {}); toast(`Done: ${r.found} found · ${r.first} first emails · ${r.followups} follow-ups · ${r.queued} for review · ${r.calls + r.no_email} to call`); reload(); }
    catch (e) { fail(e); btn.disabled = false; btn.textContent = "Run now"; }
  }));
}

// ------------------------------------------------------------------ one bot
async function renderBot(seq, d, id, params) {
  const b = d.bots.find((x) => x.id === +id);
  if (!b) { view().innerHTML = `<div class="empty"><h2>That bot doesn't exist</h2><a href="#/bots">All bots</a></div>`; return; }
  const tab = ["prospects", "calls", "activity", "emails"].includes(params.get("tab")) ? params.get("tab") : "prospects";
  const owner = !!session.me?.isOwner;
  view().innerHTML = `
    <header class="page-head with-actions">
      <div><p class="eyebrow"><a href="#/bots">Prospecting bots</a></p><h1>${esc(b.name)}</h1>
        <p class="lede muted">${esc(b.buying)} in ${esc((b.areas || []).join(", "))} · ${b.daily_new} new a day · ${b.touches} emails each, ${b.gap_days === 1 ? "every weekday" : `every ${b.gap_days} days`} · ${b.mode === "autopilot" ? "sends on its own" : "you approve each email in the Inbox"}</p></div>
      ${owner ? `<div class="row"><button class="ghost" type="button" data-toggle="${b.id}">${b.status === "active" ? "Pause" : "Start"}</button><button class="ghost" type="button" data-run="${b.id}">Run now</button><button class="ghost" type="button" id="edit">Edit</button><button class="link danger" type="button" id="del">Delete</button></div>` : ""}
    </header>
    <div class="kpis four">${[["Emailing", b.stats.active || 0], ["Emails (sent or for review)", b.stats.emails || 0], ["Replied", b.stats.replied || 0], ["To call", (b.stats.call || 0) + (b.stats.no_email || 0)]].map(([l, v], i) => `<div class="kpi ${i === 3 && v ? "accent" : ""}"><span>${l}</span><b>${v}</b></div>`).join("")}</div>
    <nav class="tabs" style="margin-top:24px">${[["prospects", "Prospects"], ["calls", "Call list"], ["activity", "Activity"], ["emails", "The emails"]].map(([k, l]) => `<a href="#/bots/${b.id}?tab=${k}" class="${k === tab ? "on" : ""}">${l}</a>`).join("")}</nav>
    <div id="pane">${skeleton(3)}</div>`;
  wireCards({ bots: [b] }, seq, params, () => renderBots(++session.seq, params, id));
  $("#edit")?.addEventListener("click", () => editBot(d, b));
  $("#del")?.addEventListener("click", async () => {
    if (!(await confirmBox(`Delete ${b.name}?`, "The bot stops and its prospect list and activity are deleted. Targets it added stay in your pipeline.", "Delete bot"))) return;
    try { await api(`/api/bots/${b.id}`, { method: "DELETE" }); location.hash = "#/bots"; } catch (e) { fail(e); }
  });
  const pane = $("#pane");
  if (tab === "emails") return emailsPane(pane, b);
  if (tab === "activity") {
    const rows = await api(`/api/bots/${b.id}/log`);
    if (stale(seq)) return;
    pane.innerHTML = rows.length ? `<ul class="bot-log">${rows.map((r) => `<li class="k-${esc(r.kind)}"><span class="ico">${LOGICON[r.kind] || "·"}</span><span>${r.target_id ? `<a href="#/targets/${r.target_id}">${esc(r.text)}</a>` : esc(r.text)}</span><small class="muted">${when(r.created_at)}</small></li>`).join("")}</ul>`
      : `<p class="muted">Nothing yet. ${b.status === "active" ? "It runs every weekday morning." : "Start it, or press Run now."}</p>`;
    return;
  }
  const rows = await api(`/api/bots/${b.id}/prospects`);
  if (stale(seq)) return;
  const list = tab === "calls" ? rows.filter((r) => r.status === "call" || r.status === "no_email") : rows;
  pane.innerHTML = !list.length ? `<p class="muted">${tab === "calls" ? "Nobody to call yet. A prospect lands here after the last email with no reply, or when there's no email to find." : "No prospects yet."}</p>`
    : `<div class="table-wrap panel flush"><table class="ttable"><thead><tr><th>Business</th><th>Status</th><th class="num">Emails</th><th>${tab === "calls" ? "Phone" : "Next email"}</th><th>Signals</th><th></th></tr></thead><tbody>
      ${list.map((r) => `<tr><td><a href="#/targets/${r.target_id}"><b>${esc(r.name)}</b></a><small class="muted block">${esc(r.location || "")}${r.email ? ` · ${esc(r.email)} (${KIND[r.email_kind] || "email"})` : ""}</small></td>
        <td><span class="chip st-${esc(r.status)}">${STATUS[r.status] || esc(r.status)}</span></td><td class="num">${r.step}/${b.touches}</td>
        <td>${tab === "calls" || r.status === "call" || r.status === "no_email" ? (r.phone ? `<a href="tel:${esc(r.phone.replace(/\s/g, ""))}">${esc(r.phone)}</a>` : '<span class="muted">no number</span>') : r.status === "active" && r.next_at ? when(r.next_at) : "–"}</td>
        <td class="small">${(r.signals || []).map((s) => esc(s.label)).join(" · ") || '<span class="muted">–</span>'}</td>
        <td class="row">${owner ? (r.status === "active" ? `<button class="link" type="button" data-p="${r.id}" data-a="stop">Stop</button>` : r.status === "call" || r.status === "no_email" ? `<button class="link" type="button" data-p="${r.id}" data-a="called">Called</button>` : "") : ""}</td></tr>`).join("")}</tbody></table></div>`;
  $$("[data-p]", pane).forEach((btn) => btn.addEventListener("click", async () => {
    try { await post(`/api/bots/${b.id}/prospects/${btn.dataset.p}/${btn.dataset.a}`, {}); toast(btn.dataset.a === "stop" ? "Stopped: no more emails to them" : "Marked as called"); renderBots(++session.seq, params, id); } catch (e) { fail(e); }
  }));
}

const sample = (b) => ({ first: "Sarah", company: "Westside Physio", sender: b.sender_name || "You", group: b.group_name, buying: b.buying, area: String((b.areas || [])[0] || "your area").split(",")[0], phone: b.phone, signals: { reviews: 180, rating: 4.8 }, touches: b.touches, gapDays: b.gap_days });
function emailsPane(pane, b) {
  pane.innerHTML = `<p class="muted small">What a prospect receives, in order (sample business). Edit the wording under Edit. Your signature and an opt-out line are added to each.</p>
    <ol class="bot-emails">${Array.from({ length: b.touches }, (_, i) => { const e = renderEmail(b.templates, i + 1, sample(b)); return `<li><p class="muted small">${i === 0 ? "Day 1" : `${i * b.gap_days} ${b.gap_days === 1 ? "weekday" : "day"}${i * b.gap_days === 1 ? "" : "s"} later`}${i + 1 === b.touches ? " · last email, then it goes on your call list" : ""}</p><b>${esc(e.subject)}</b><pre>${esc(e.body)}</pre></li>`; }).join("")}</ol>`;
}

// ------------------------------------------------------------------ setup
async function editBot(d, b = null) {
  const s = d.suggest || {};
  const cur = b || { name: "", industry: s.industry || "physio", areas: [], buying: s.buying || "", sender_name: s.name || "", group_name: s.company || "", phone: s.phone || "", daily_new: 10, touches: 6, gap_days: 1, send_hour: 9, timezone: s.timezone || "Australia/Melbourne", owner_emails: 1, mode: "review", templates: {} };
  const tpl = { subject: cur.templates?.subject || DEFAULT_TEMPLATES.subject, steps: cur.templates?.steps || DEFAULT_TEMPLATES.steps };
  const f = await dialog({ title: b ? `Edit ${b.name}` : "New prospecting bot", wide: true, submit: b ? "Save" : "Create bot", html: `
    <div class="bot-form">
      <section>
        <h3 class="terr-h">What it looks for</h3>
        <label class="field">Name<input name="name" maxlength="80" required value="${esc(cur.name)}" placeholder="e.g. Physio · West Melbourne"></label>
        <label class="field">Kind of business<select name="industry">${(industries || []).map((i) => `<option value="${i.id}" ${i.id === cur.industry ? "selected" : ""}>${esc(i.label)}</option>`).join("")}</select></label>
        <label class="field">Areas (one per line; it rotates through them)<textarea name="areas" rows="3" required placeholder="Melton, Victoria&#10;Werribee, Victoria">${esc((cur.areas || []).join("\n"))}</textarea></label>
        ${s.sites?.length ? `<button class="link-btn small" type="button" id="useSites">Use the areas around my territory sites</button>` : ""}
        <label class="field">What you're buying (as it reads in the email)<input name="buying" maxlength="120" value="${esc(cur.buying)}" placeholder="physio clinics"></label>
        <h3 class="terr-h">Who it's from</h3>
        <div class="two"><label class="field">Your name<input name="sender_name" maxlength="80" required value="${esc(cur.sender_name)}"></label><label class="field">Your group<input name="group_name" maxlength="80" value="${esc(cur.group_name)}" placeholder="XYZ Group"></label></div>
        <label class="field">Number for them to call<input name="phone" maxlength="40" value="${esc(cur.phone)}" placeholder="0400 000 000"></label>
        <h3 class="terr-h">Pace</h3>
        <div class="two"><label class="field">New businesses a day<input name="daily_new" type="number" min="1" max="30" value="${cur.daily_new}"></label><label class="field">Emails per business (max ${MAX_TOUCHES})<input name="touches" type="number" min="1" max="${MAX_TOUCHES}" value="${cur.touches}"></label></div>
        <div class="two"><label class="field">Days between emails<input name="gap_days" type="number" min="1" max="14" value="${cur.gap_days}"></label><label class="field">Send from (hour)<input name="send_hour" type="number" min="6" max="18" value="${cur.send_hour}"></label></div>
        <label class="field">Time zone<select name="timezone">${[...new Set([cur.timezone, ...TZS])].map((z) => `<option ${z === cur.timezone ? "selected" : ""}>${esc(z)}</option>`).join("")}</select></label>
        <label class="check"><input type="checkbox" name="owner_emails" ${cur.owner_emails ? "checked" : ""}> Find the owner's own email (paid data, about $0.05 each), else use the front desk</label>
        <h3 class="terr-h">Sending</h3>
        <label class="check"><input type="radio" name="mode" value="review" ${cur.mode !== "autopilot" ? "checked" : ""}> Review first: every email waits for your approval in the Inbox</label>
        <label class="check"><input type="radio" name="mode" value="autopilot" ${cur.mode === "autopilot" ? "checked" : ""}> Autopilot: sends on its own from your mailbox</label>
        <label class="check" id="confirmWrap" hidden><input type="checkbox" name="confirm_autopilot"> I'm sure: emails go out without my review, and I'm allowed to email these businesses where I operate</label>
      </section>
      <section>
        <h3 class="terr-h">The emails</h3>
        <label class="field">Subject<input name="subject" maxlength="140" value="${esc(tpl.subject)}"></label>
        <div id="steps">${tpl.steps.map((t, i) => `<label class="field">Email ${i + 1}${i === 0 ? " (first)" : i === tpl.steps.length - 1 ? " (last)" : ""}<textarea name="step${i}" rows="5">${esc(t)}</textarea></label>`).join("")}</div>
        <p class="muted small">Placeholders: {first} {company} {sender} {group} {buying} {area} {phone} {call} {signal} {when}</p>
        <h3 class="terr-h">Preview</h3><div id="preview" class="bot-preview"></div>
      </section>
    </div>`,
    onOpen: (dlg) => {
      const form = $("form", dlg);
      const draw = () => {
        const v = Object.fromEntries(new FormData(form));
        const steps = tpl.steps.map((_, i) => v[`step${i}`]);
        const e = renderEmail({ subject: v.subject, steps }, 1, sample({ ...v, areas: v.areas.split("\n"), touches: +v.touches, gap_days: +v.gap_days }));
        $("#preview", dlg).innerHTML = `<b>${esc(e.subject)}</b><pre>${esc(e.body)}</pre>`;
      };
      form.addEventListener("input", draw); draw();
      form.industry.addEventListener("change", () => { const i = (industries || []).find((x) => x.id === form.industry.value); if (i && !b) form.buying.value = buyingFor(i.id, i.label.split(/[\/&(]/)[0].trim().toLowerCase()); draw(); });
      $$("input[name=mode]", dlg).forEach((r) => r.addEventListener("change", () => { $("#confirmWrap", dlg).hidden = !(form.mode.value === "autopilot" && cur.mode !== "autopilot"); }));
      $("#useSites", dlg)?.addEventListener("click", async (e) => {
        e.target.textContent = "Looking up your sites…";
        try { const r = await api("/api/bots/areas"); if (r.areas.length) { form.areas.value = r.areas.join("\n"); draw(); e.target.textContent = "Filled from your sites"; } else e.target.textContent = "Couldn't name those areas: type them in"; } catch (err2) { e.target.textContent = err2.message; }
      });
    } });
  if (!f) return;
  const body = { name: f.name, industry: f.industry, areas: f.areas.split("\n"), buying: f.buying, sender_name: f.sender_name, group_name: f.group_name, phone: f.phone,
    daily_new: +f.daily_new, touches: +f.touches, gap_days: +f.gap_days, send_hour: +f.send_hour, timezone: f.timezone, owner_emails: !!f.owner_emails, mode: f.mode, confirm_autopilot: !!f.confirm_autopilot,
    templates: { subject: f.subject, steps: tpl.steps.map((_, i) => f[`step${i}`]) } };
  try {
    const saved = b ? await post(`/api/bots/${b.id}`, body, "PATCH") : await post("/api/bots", body);
    toast(b ? "Saved" : "Bot created. Press Start when you're happy with the emails.");
    location.hash = `#/bots/${saved.id}?tab=emails`;
  } catch (e) { fail(e); }
}
