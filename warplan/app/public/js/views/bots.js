// Prospecting bots. Buying: finds the businesses you'd buy in an area, emails the owner directly every weekday and
// hands you the ones to call. Selling: shops a business to the buyers directory (private equity) for the best price.
import { $, $$, esc, api, post, toast, fail, view, stale, session, dialog, confirmBox, skeleton, when } from "../core.js";
import { renderEmail, defaultTemplates, MAX_TOUCHES, FLOW_LENGTHS, buyingFor } from "../bot-emails.js";

const STATUS = { active: "Emailing", call: "To call", replied: "Replied", no_email: "No email", opted_out: "Opted out", bounced: "Bounced", removed: "Stopped", called: "Called", finished: "Flow finished" };
const KIND = { owner: "owner", decision_maker: "decision maker", front_desk: "front desk" };
const LOGICON = { found: "＋", sent: "✉", follow_up: "↻", queued: "⧗", replied: "★", call: "☎", skipped: "–", error: "!", run: "▸" };
const TZS = ["Australia/Melbourne", "Australia/Sydney", "Australia/Brisbane", "Australia/Adelaide", "Australia/Perth", "Pacific/Auckland", "Europe/London", "Europe/Oslo", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles"];
const CURS = ["A$", "$", "NZ$", "C$", "£", "€", "kr"];
const COUNTRIES = [["AU", "Australia"], ["NZ", "New Zealand"], ["US", "United States"], ["CA", "Canada"], ["GB", "United Kingdom"], ["IE", "Ireland"], ["NO", "Norway"], ["SE", "Sweden"], ["DK", "Denmark"], ["FI", "Finland"]];
let industries = null;
const money = (v, c = "$") => (v ? (v >= 1e6 ? `${c}${(v / 1e6).toFixed(1).replace(/\.0$/, "")}M` : `${c}${Math.round(v / 1e3)}k`) : "");

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
        <p class="lede">Buying: every weekday it finds the businesses you'd buy in your area and emails the owner directly. Selling: it shops a business to ${d.funds || "hundreds of"} private equity buyers. One email a day for up to ${MAX_TOUCHES} days, then the ones to call land on your list.</p></div>
      ${owner ? `<div class="head-actions row"><a class="ghost" href="#/buyers">Buyers directory</a><button class="ghost" id="newSell" type="button">+ Sell a business</button><button class="primary" id="newBot" type="button">+ Find businesses to buy</button></div>` : ""}
    </header>
    ${!d.mailbox ? `<p class="banner">Connect your mailbox first so the bot sends from your own address: <a href="#/settings/email">Settings → Email</a>.</p>` : ""}
    ${!d.data_ready ? `<p class="banner">Business search isn't connected for this workspace yet: <a href="#/settings/integrations">Settings → Integrations</a>.</p>` : ""}
    ${d.bots.length ? `<div class="bot-grid">${d.bots.map((b) => card(b, owner)).join("")}</div>`
      : `<div class="empty"><h2>No bots yet</h2><p class="muted">Start with one. It starts in review mode, so nothing goes out until you approve it in the Inbox.</p>${owner ? `<div class="row" style="justify-content:center"><button class="primary" type="button" id="newBot2">Find businesses to buy</button><button class="ghost" type="button" id="newSell2">Sell a business</button></div>` : ""}</div>`}
    <p class="muted small">Every email carries your name and an opt-out line. Anyone who replies, opts out or bounces is never emailed by the bot again. An out-of-office reply pauses them for a week. Emails go out on weekdays, spread across the morning.</p>`;
  $("#newBot")?.addEventListener("click", () => editBot(d, null, "buy"));
  $("#newBot2")?.addEventListener("click", () => editBot(d, null, "buy"));
  $("#newSell")?.addEventListener("click", () => editBot(d, null, "sell"));
  $("#newSell2")?.addEventListener("click", () => editBot(d, null, "sell"));
  if (params.get("new") === "sell" && owner) editBot(d, null, "sell", { buyers: { segments: params.getAll("segment"), countries: params.getAll("country"), sectors: params.get("q") || "" } });
  wireCards(d, seq, params);
}

const sub = (b) => (b.kind === "sell" ? `Selling ${b.sell?.business || ""}${b.sell?.ebitda ? ` · ${money(b.sell.ebitda, b.sell.currency)} EBITDA` : ""}` : `${b.buying || ""} · ${(b.areas || []).join(" · ")}`);
function card(b, owner) {
  const s = b.stats || {};
  const sell = b.kind === "sell";
  return `<article class="bot-card ${b.status}">
    <header><a href="#/bots/${b.id}"><h2>${esc(b.name)}</h2></a><span class="chip">${sell ? "Selling" : "Buying"}</span><span class="chip ${b.status === "active" ? "on" : ""}">${b.status === "active" ? (b.running ? "Running…" : "Active") : "Paused"}</span><span class="chip">${b.mode === "autopilot" ? "Autopilot" : "Review first"}</span></header>
    <p class="muted small">${esc(sub(b))}</p>
    <div class="bot-stats">
      <div><b>${s.active || 0}</b><span>${sell ? "buyers emailing" : "emailing"}</span></div><div><b>${s.emails || 0}</b><span>emails</span></div>
      <div><b>${s.replied || 0}</b><span>replied</span></div><div class="${(s.call || 0) + (sell ? 0 : s.no_email || 0) ? "hot" : ""}"><b>${sell ? s.no_email || 0 : (s.call || 0) + (s.no_email || 0)}</b><span>${sell ? "no email" : "to call"}</span></div>
    </div>
    <footer class="row"><a class="ghost small" href="#/bots/${b.id}">Open</a>${owner ? `<button class="ghost small" type="button" data-run="${b.id}">Run now</button>
      <button class="ghost small" type="button" data-toggle="${b.id}">${b.status === "active" ? "Pause" : "Start"}</button>` : ""}
      <span class="muted small">${b.last_run_on ? `Last run ${esc(b.last_run_on)}` : "Not run yet"} · ${b.daily_new}/day · ${b.touches}-day flow</span></footer>
  </article>`;
}

function wireCards(d, seq, params, reload = () => renderBots(++session.seq, params)) {
  $$("[data-toggle]").forEach((btn) => btn.addEventListener("click", async () => {
    const b = d.bots.find((x) => x.id === +btn.dataset.toggle);
    try { await post(`/api/bots/${b.id}`, { status: b.status === "active" ? "paused" : "active" }, "PATCH"); toast(b.status === "active" ? "Paused" : "Started: it runs every weekday morning"); reload(); } catch (e) { fail(e); }
  }));
  $$("[data-run]").forEach((btn) => btn.addEventListener("click", async () => {
    btn.disabled = true; btn.textContent = "Running… (a few minutes)";
    try { const r = await post(`/api/bots/${btn.dataset.run}/run`, {}); toast(`Done: ${r.found} found · ${r.first} first emails · ${r.followups} follow-ups · ${r.queued} for review${r.calls ? ` · ${r.calls} call tasks` : ""}`); reload(); }
    catch (e) { fail(e); btn.disabled = false; btn.textContent = "Run now"; }
  }));
}

// ------------------------------------------------------------------ one bot
async function renderBot(seq, d, id, params) {
  const b = d.bots.find((x) => x.id === +id);
  if (!b) { view().innerHTML = `<div class="empty"><h2>That bot doesn't exist</h2><a href="#/bots">All bots</a></div>`; return; }
  const sell = b.kind === "sell";
  const tabs = sell ? [["prospects", "Buyers"], ["activity", "Activity"], ["emails", "The emails"]] : [["prospects", "Prospects"], ["calls", "Call list"], ["activity", "Activity"], ["emails", "The emails"]];
  const tab = tabs.some(([k]) => k === params.get("tab")) ? params.get("tab") : "prospects";
  const owner = !!session.me?.isOwner;
  const s = b.stats || {};
  view().innerHTML = `
    <header class="page-head with-actions">
      <div><p class="eyebrow"><a href="#/bots">Prospecting bots</a> · ${sell ? "Selling" : "Buying"}</p><h1>${esc(b.name)}</h1>
        <p class="lede muted">${esc(sub(b))} · ${b.daily_new} new a day · ${b.touches}-day flow, ${b.gap_days === 1 ? "one email every weekday" : `an email every ${b.gap_days} days`} · ${b.mode === "autopilot" ? "sends on its own" : "you approve each email in the Inbox"}</p></div>
      ${owner ? `<div class="row"><button class="ghost" type="button" data-toggle="${b.id}">${b.status === "active" ? "Pause" : "Start"}</button><button class="ghost" type="button" data-run="${b.id}">Run now</button><button class="ghost" type="button" id="edit">Edit</button><button class="link danger" type="button" id="del">Delete</button></div>` : ""}
    </header>
    <div class="kpis four">${[[sell ? "Buyers emailing" : "Emailing", s.active || 0], ["Emails (sent or for review)", s.emails || 0], ["Replied", s.replied || 0], [sell ? "No email found" : "To call", sell ? s.no_email || 0 : (s.call || 0) + (s.no_email || 0)]].map(([l, v], i) => `<div class="kpi ${i === 2 && v ? "accent" : ""}"><span>${l}</span><b>${v}</b></div>`).join("")}</div>
    <nav class="tabs" style="margin-top:24px">${tabs.map(([k, l]) => `<a href="#/bots/${b.id}?tab=${k}" class="${k === tab ? "on" : ""}">${l}</a>`).join("")}</nav>
    <div id="pane">${skeleton(3)}</div>`;
  wireCards({ bots: [b] }, seq, params, () => renderBots(++session.seq, params, id));
  $("#edit")?.addEventListener("click", () => editBot(d, b, b.kind));
  $("#del")?.addEventListener("click", async () => {
    if (!(await confirmBox(`Delete ${b.name}?`, "The bot stops and its list and activity are deleted. Targets it added stay in your pipeline.", "Delete bot"))) return;
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
  if (sell) {
    pane.innerHTML = !rows.length ? `<p class="muted">No buyers contacted yet. Start the bot or press Run now: it picks the best-fitting funds from the <a href="#/buyers">buyers directory</a>.</p>`
      : `<div class="table-wrap panel flush"><table class="ttable"><thead><tr><th>Buyer</th><th>Status</th><th class="num">Emails</th><th>Size</th><th>Next email</th><th></th></tr></thead><tbody>
        ${rows.map((r) => `<tr><td><a href="${esc(r.website || "#")}" target="_blank" rel="noopener noreferrer"><b>${esc(r.name)}</b></a><small class="muted block">${esc(r.location || "")}${r.email ? ` · ${esc(r.email)}` : r.contact_url ? ` · <a href="${esc(r.contact_url)}" target="_blank" rel="noopener noreferrer">contact page</a>` : ""}</small></td>
          <td><span class="chip st-${esc(r.status)}">${STATUS[r.status] || esc(r.status)}</span></td><td class="num">${r.step}/${b.touches}</td><td class="small">${esc(r.size || (r.segment === "mm" ? "Middle market" : "Lower middle market"))}</td>
          <td>${r.status === "active" && r.next_at ? when(r.next_at) : "–"}</td><td>${owner && r.status === "active" ? `<button class="link" type="button" data-p="${r.id}" data-a="stop">Stop</button>` : ""}</td></tr>`).join("")}</tbody></table></div>`;
  } else {
    const list = tab === "calls" ? rows.filter((r) => r.status === "call" || r.status === "no_email") : rows;
    pane.innerHTML = !list.length ? `<p class="muted">${tab === "calls" ? "Nobody to call yet. A prospect lands here after the last email with no reply, or when there's no email to find. Every 7th email also creates a call task on the target." : "No prospects yet."}</p>`
      : `<div class="table-wrap panel flush"><table class="ttable"><thead><tr><th>Business</th><th>Status</th><th class="num">Emails</th><th>${tab === "calls" ? "Phone" : "Next email"}</th><th>Signals</th><th></th></tr></thead><tbody>
        ${list.map((r) => `<tr><td><a href="#/targets/${r.target_id}"><b>${esc(r.name)}</b></a><small class="muted block">${esc(r.location || "")}${r.email ? ` · ${esc(r.email)} (${KIND[r.email_kind] || "email"})` : ""}</small></td>
          <td><span class="chip st-${esc(r.status)}">${STATUS[r.status] || esc(r.status)}</span></td><td class="num">${r.step}/${b.touches}</td>
          <td>${tab === "calls" || r.status === "call" || r.status === "no_email" ? (r.phone ? `<a href="tel:${esc(r.phone.replace(/\s/g, ""))}">${esc(r.phone)}</a>` : '<span class="muted">no number</span>') : r.status === "active" && r.next_at ? when(r.next_at) : "–"}</td>
          <td class="small">${(r.signals || []).map((x) => esc(x.label)).join(" · ") || '<span class="muted">–</span>'}</td>
          <td class="row">${owner ? (r.status === "active" ? `<button class="link" type="button" data-p="${r.id}" data-a="stop">Stop</button>` : r.status === "call" || r.status === "no_email" ? `<button class="link" type="button" data-p="${r.id}" data-a="called">Called</button>` : "") : ""}</td></tr>`).join("")}</tbody></table></div>`;
  }
  $$("[data-p]", pane).forEach((btn) => btn.addEventListener("click", async () => {
    try { await post(`/api/bots/${b.id}/prospects/${btn.dataset.p}/${btn.dataset.a}`, {}); toast(btn.dataset.a === "stop" ? "Stopped: no more emails to them" : "Marked as called"); renderBots(++session.seq, params, id); } catch (e) { fail(e); }
  }));
}

const sample = (b) => (b.kind === "sell"
  ? { kind: "sell", first: "", fund: "Example Capital", sender: b.sender_name || "You", business: b.sell?.business, sector: b.sell?.sector, area: b.sell?.location, revenue: b.sell?.revenue, ebitda: b.sell?.ebitda, currency: b.sell?.currency, phone: b.phone, touches: b.touches, gapDays: b.gap_days }
  : { first: "Sarah", company: "Westside Co", sender: b.sender_name || "You", group: b.group_name, buying: b.buying, area: String((b.areas || [])[0] || "your area").split(",")[0], phone: b.phone, signals: { reviews: 180, rating: 4.8 }, touches: b.touches, gapDays: b.gap_days });
function emailsPane(pane, b) {
  pane.innerHTML = `<p class="muted small">What ${b.kind === "sell" ? "each buyer" : "a prospect"} receives, in order (sample ${b.kind === "sell" ? "fund" : "business"}). Change the wording under Edit. Your signature and an opt-out line are added to each.</p>
    <ol class="bot-emails">${Array.from({ length: b.touches }, (_, i) => { const e = renderEmail(b.templates, i + 1, sample(b)); return `<li><p class="muted small">Day ${i + 1}${i + 1 === b.touches ? " · last email" : ""}</p><b>${esc(e.subject)}</b><pre>${esc(e.body)}</pre></li>`; }).join("")}</ol>`;
}

// ------------------------------------------------------------------ setup
async function editBot(d, b = null, kind = "buy", preset = {}) {
  const s = d.suggest || {};
  const sell = kind === "sell";
  const cur = b || { name: "", kind, industry: s.industry || "physio", areas: [], buying: s.buying || "", sender_name: s.name || "", group_name: s.company || "", phone: s.phone || "", daily_new: sell ? 5 : 10, touches: 30, gap_days: 1, send_hour: 9, timezone: s.timezone || "Australia/Melbourne", owner_emails: 1, mode: "review", templates: {},
    sell: { currency: "A$" }, buyers: { segments: ["lmm"], countries: ["AU"], sectors: "", ...(preset.buyers || {}) } };
  const flowDays = FLOW_LENGTHS.includes(cur.touches) ? cur.touches : 30;
  let tpl = { subject: cur.templates?.subject || defaultTemplates(kind, cur.touches).subject, steps: cur.templates?.steps || defaultTemplates(kind, cur.touches).steps };
  const custom = !!(cur.templates?.steps || cur.templates?.subject);
  const stepsHtml = (steps) => steps.map((t, i) => `<details class="step"${i === 0 ? " open" : ""}><summary>Day ${i + 1}${i === 0 ? " · first email" : i === steps.length - 1 ? " · last email" : ""}: <span class="muted">${esc(t.split("\n").filter(Boolean)[1] || "").slice(0, 70)}</span></summary><textarea name="step${i}" rows="5">${esc(t)}</textarea></details>`).join("");
  const f = await dialog({ title: b ? `Edit ${b.name}` : sell ? "Sell a business: shop it to buyers" : "New bot: find businesses to buy", wide: true, submit: b ? "Save" : "Create bot", html: `
    <div class="bot-form">
      <section>
        <label class="field">Name<input name="name" maxlength="80" required value="${esc(cur.name)}" placeholder="${sell ? "e.g. Sell · Westside Physio" : "e.g. Physio · West Melbourne"}"></label>
        ${sell ? `
        <h3 class="terr-h">The business you're selling</h3>
        <label class="field">How buyers should read it<input name="business" maxlength="120" required value="${esc(cur.sell?.business || "")}" placeholder="a physio group in Melbourne's west"></label>
        <div class="two"><label class="field">Sector<input name="sector" maxlength="60" value="${esc(cur.sell?.sector || "")}" placeholder="allied health"></label><label class="field">Location<input name="location" maxlength="80" value="${esc(cur.sell?.location || "")}" placeholder="Melbourne"></label></div>
        <div class="three"><label class="field">Currency<select name="currency">${CURS.map((c) => `<option ${c === (cur.sell?.currency || "A$") ? "selected" : ""}>${c}</option>`).join("")}</select></label><label class="field">Revenue<input name="revenue" inputmode="numeric" value="${cur.sell?.revenue || ""}" placeholder="4200000"></label><label class="field">EBITDA<input name="ebitda" inputmode="numeric" value="${cur.sell?.ebitda || ""}" placeholder="900000"></label></div>
        <h3 class="terr-h">Which buyers</h3>
        <div class="row"><label class="check"><input type="checkbox" name="seg_lmm" ${(cur.buyers?.segments || []).includes("lmm") ? "checked" : ""}> Lower middle market</label><label class="check"><input type="checkbox" name="seg_mm" ${(cur.buyers?.segments || []).includes("mm") ? "checked" : ""}> Middle market</label></div>
        <div class="country-picks">${COUNTRIES.map(([c, n]) => `<label class="check"><input type="checkbox" name="c_${c}" ${(cur.buyers?.countries || []).includes(c) ? "checked" : ""}> ${n}</label>`).join("")}</div>
        <label class="field">Sectors they should invest in (comma separated)<input name="sectors" maxlength="160" value="${esc(cur.buyers?.sectors || "")}" placeholder="healthcare, allied health"></label>
        <p class="muted small" id="matchCount"></p>` : `
        <h3 class="terr-h">What it looks for</h3>
        <label class="field">Kind of business<select name="industry">${(industries || []).map((i) => `<option value="${i.id}" ${i.id === cur.industry ? "selected" : ""}>${esc(i.label)}</option>`).join("")}</select></label>
        <label class="field">Areas (one per line; it rotates through them)<textarea name="areas" rows="3" required placeholder="Melton, Victoria&#10;Werribee, Victoria">${esc((cur.areas || []).join("\n"))}</textarea></label>
        ${s.sites?.length ? `<button class="link-btn small" type="button" id="useSites">Use the areas around my territory sites</button>` : ""}
        <label class="field">What you're buying (as it reads in the email)<input name="buying" maxlength="120" value="${esc(cur.buying)}" placeholder="physio clinics"></label>
        <label class="check"><input type="checkbox" name="owner_emails" ${cur.owner_emails ? "checked" : ""}> Find the owner's own email (paid data, about $0.05 each), else use the front desk</label>`}
        <h3 class="terr-h">Who it's from</h3>
        <div class="two"><label class="field">Your name<input name="sender_name" maxlength="80" required value="${esc(cur.sender_name)}"></label>${sell ? `<span></span>` : `<label class="field">Your group<input name="group_name" maxlength="80" value="${esc(cur.group_name)}" placeholder="XYZ Group"></label>`}</div>
        <label class="field">Number for them to call<input name="phone" maxlength="40" value="${esc(cur.phone)}" placeholder="0400 000 000"></label>
        <h3 class="terr-h">Pace</h3>
        <div class="two"><label class="field">Flow length<select name="flow">${FLOW_LENGTHS.map((n) => `<option value="${n}" ${n === flowDays ? "selected" : ""}>${n} days (${n} emails)</option>`).join("")}</select></label><label class="field">${sell ? "New buyers a day" : "New businesses a day"}<input name="daily_new" type="number" min="1" max="30" value="${cur.daily_new}"></label></div>
        <div class="two"><label class="field">Days between emails<input name="gap_days" type="number" min="1" max="14" value="${cur.gap_days}"></label><label class="field">Send from (hour)<input name="send_hour" type="number" min="6" max="18" value="${cur.send_hour}"></label></div>
        <label class="field">Time zone<select name="timezone">${[...new Set([cur.timezone, ...TZS])].map((z) => `<option ${z === cur.timezone ? "selected" : ""}>${esc(z)}</option>`).join("")}</select></label>
        <h3 class="terr-h">Sending</h3>
        <label class="check"><input type="radio" name="mode" value="review" ${cur.mode !== "autopilot" ? "checked" : ""}> Review first: every email waits for your approval in the Inbox</label>
        <label class="check"><input type="radio" name="mode" value="autopilot" ${cur.mode === "autopilot" ? "checked" : ""}> Autopilot: sends on its own from your mailbox</label>
        <label class="check" id="confirmWrap" hidden><input type="checkbox" name="confirm_autopilot"> I'm sure: emails go out without my review, and I'm allowed to email these ${sell ? "firms" : "businesses"}</label>
      </section>
      <section>
        <h3 class="terr-h">The emails</h3>
        <p class="muted small">${custom ? "Your own wording." : "Our direct copy for this flow. Edit any day to make it yours."} <button class="link-btn small" type="button" id="resetTpl">Use the default copy</button></p>
        <label class="field">Subject<input name="subject" maxlength="140" value="${esc(tpl.subject)}"></label>
        <div id="steps">${stepsHtml(tpl.steps)}</div>
        <p class="muted small">Placeholders: ${sell ? "{fund} {business} {Business} {sector} {area} {revenue} {ebitda} {sender} {phone} {call}" : "{first} {company} {sender} {group} {buying} {area} {phone} {call} {signal} {when}"}</p>
        <h3 class="terr-h">Preview: day 1</h3><div id="preview" class="bot-preview"></div>
      </section>
    </div>`,
    onOpen: (dlg) => {
      const form = $("form", dlg);
      let edited = custom;
      const values = () => Object.fromEntries(new FormData(form));
      const draw = () => {
        const v = values();
        const steps = tpl.steps.map((_, i) => v[`step${i}`]);
        const fake = sell ? { kind: "sell", sender_name: v.sender_name, phone: v.phone, touches: +v.flow, gap_days: +v.gap_days, sell: { business: v.business, sector: v.sector, location: v.location, revenue: +v.revenue, ebitda: +v.ebitda, currency: v.currency } }
          : { sender_name: v.sender_name, group_name: v.group_name, buying: v.buying, areas: String(v.areas || "").split("\n"), phone: v.phone, touches: +v.flow, gap_days: +v.gap_days };
        const e = renderEmail({ subject: v.subject, steps }, 1, sample(fake));
        $("#preview", dlg).innerHTML = `<b>${esc(e.subject)}</b><pre>${esc(e.body)}</pre>`;
      };
      const loadDefaults = () => { tpl = defaultTemplates(kind, +form.flow.value); form.subject.value = tpl.subject; $("#steps", dlg).innerHTML = stepsHtml(tpl.steps); edited = false; draw(); };
      form.addEventListener("input", (e) => { if (e.target.name === "subject" || /^step\d+$/.test(e.target.name || "")) edited = true; draw(); });
      form.flow.addEventListener("change", () => { if (!edited) loadDefaults(); });
      $("#resetTpl", dlg).addEventListener("click", loadDefaults);
      form.industry?.addEventListener("change", () => { const i = (industries || []).find((x) => x.id === form.industry.value); if (i && !b) form.buying.value = buyingFor(i.id, i.label.split(/[\/&(]/)[0].trim().toLowerCase()); draw(); });
      $$("input[name=mode]", dlg).forEach((r) => r.addEventListener("change", () => { $("#confirmWrap", dlg).hidden = !(form.mode.value === "autopilot" && cur.mode !== "autopilot"); }));
      $("#useSites", dlg)?.addEventListener("click", async (e) => {
        e.target.textContent = "Looking up your sites…";
        try { const r = await api("/api/bots/areas"); if (r.areas.length) { form.areas.value = r.areas.join("\n"); draw(); e.target.textContent = "Filled from your sites"; } else e.target.textContent = "Couldn't name those areas: type them in"; } catch (err2) { e.target.textContent = err2.message; }
      });
      if (sell) {
        const count = async () => {
          const v = values(); const p = new URLSearchParams();
          ["lmm", "mm"].forEach((x) => v[`seg_${x}`] && p.append("segment", x));
          try {
            const segs = p.getAll("segment"), cs = COUNTRIES.map(([c]) => c).filter((c) => v[`c_${c}`]);
            const r = await api(`/api/buyers${segs.length === 1 ? `?segment=${segs[0]}` : ""}`);
            const n = r.funds.filter((x) => (!cs.length || cs.some((c) => x.hq_country === c || (x.regions || []).includes(c)))).length;
            $("#matchCount", dlg).textContent = `${n} buyers in the directory match the segment and countries (sector and size narrow it further).`;
          } catch { /* the count is a hint */ }
        };
        form.addEventListener("change", (e) => { if (/^(seg_|c_)/.test(e.target.name || "")) count(); });
        count();
      }
      draw();
    } });
  if (!f) return;
  const steps = tpl.steps.map((_, i) => f[`step${i}`]);
  const touches = +f.flow;
  const body = { name: f.name, kind, sender_name: f.sender_name, phone: f.phone, daily_new: +f.daily_new, touches, gap_days: +f.gap_days, send_hour: +f.send_hour, timezone: f.timezone, mode: f.mode, confirm_autopilot: !!f.confirm_autopilot,
    // Only save wording that differs from our defaults, so copy improvements reach bots that never changed it.
    templates: (() => { const dft = defaultTemplates(kind, touches); return f.subject === dft.subject && steps.join("\u0000") === dft.steps.join("\u0000") ? {} : { subject: f.subject, steps }; })() };
  if (sell) Object.assign(body, { sell: { business: f.business, sector: f.sector, location: f.location, revenue: f.revenue, ebitda: f.ebitda, currency: f.currency },
    buyers: { segments: ["lmm", "mm"].filter((x) => f[`seg_${x}`]), countries: COUNTRIES.map(([c]) => c).filter((c) => f[`c_${c}`]), sectors: f.sectors } });
  else Object.assign(body, { industry: f.industry, areas: f.areas.split("\n"), buying: f.buying, group_name: f.group_name, owner_emails: !!f.owner_emails });
  try {
    const saved = b ? await post(`/api/bots/${b.id}`, body, "PATCH") : await post("/api/bots", body);
    toast(b ? "Saved" : "Bot created. Read the emails, then press Start.");
    location.hash = `#/bots/${saved.id}?tab=emails`;
  } catch (e) { fail(e); }
}
