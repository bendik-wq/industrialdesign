import { $, $$, esc, api, post, view, session, stale, toast, fail, dialog, confirmBox, copy, synced, when, skeleton } from "../core.js";

const TABS = [["profile", "Profile"], ["team", "Team"], ["email", "Email"], ["connect", "Connect"], ["integrations", "Integrations"], ["api", "API"], ["usage", "Usage"]];

export async function renderSettings(tab, seq) {
  tab = TABS.some(([k]) => k === tab) ? tab : "profile";
  view().innerHTML = `
    <header class="page-head"><p class="eyebrow">Settings</p><h1>${esc(session.me.account.name)}</h1></header>
    <nav class="tabs" aria-label="Settings">${TABS.map(([k, v]) => `<a href="#/settings/${k}" class="${k === tab ? "on" : ""}" ${k === tab ? 'aria-current="page"' : ""}>${v}</a>`).join("")}</nav>
    <div id="tab">${skeleton(4)}</div>`;
  const fn = { profile, team, email: emailTab, connect, integrations, api: apiTab, usage }[tab];
  try { await fn(seq); } catch (e) { if (!stale(seq)) $("#tab").innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}

// ------------------------------------------------------------------ profile
async function profile(seq) {
  const me = session.me, p = synced.get("profile", {}) || {};
  if (stale(seq)) return;
  $("#tab").innerHTML = `
    <div class="settings-grid">
      <form class="panel form-panel" id="who">
        <h2 class="h3">You</h2>
        <label class="field">Name<input name="name" value="${esc(me.user.name)}" maxlength="80" required autocomplete="name"></label>
        <label class="field">Email<input value="${esc(me.user.email)}" disabled></label>
        ${me.isOwner ? `<label class="field">Workspace name<input name="workspace" value="${esc(me.account.name)}" maxlength="80"></label>` : ""}
        <button class="primary" type="submit">Save</button>
      </form>
      <form class="panel form-panel" id="buyer">
        <h2 class="h3">How the agents introduce you</h2>
        <p class="muted small">Used in letters, LOIs and memos, and so Josh knows who he's coaching.</p>
        <label class="field">Name on letters<input name="name" value="${esc(p.name || me.user.name)}" maxlength="80"></label>
        <label class="field">Your company<input name="company" value="${esc(p.company || "")}" maxlength="120" placeholder="Dalton Group"></label>
        <label class="field">About you, in one line<input name="about" value="${esc(p.about || "")}" maxlength="240" placeholder="I run a $4M HVAC company in Ohio and I'm buying the best operators in our region"></label>
        <label class="field">Your goal<input name="goal" value="${esc(p.goal || "")}" maxlength="240" placeholder="Buy three competitors in 18 months without putting in my own cash"></label>
        <div class="two"><label class="field">Phone<input name="phone" value="${esc(p.phone || "")}" maxlength="40" autocomplete="tel"></label><label class="field">Email for letters<input name="email" type="email" value="${esc(p.email || me.user.email)}" maxlength="160"></label></div>
        <button class="primary" type="submit">Save</button>
      </form>
      <form class="panel form-panel" id="pw">
        <h2 class="h3">Password</h2>
        <label class="field">Current password<input name="current" type="password" required autocomplete="current-password"></label>
        <label class="field">New password<input name="next" type="password" required minlength="10" autocomplete="new-password"></label>
        <p class="muted small">At least 10 characters. Changing it signs you out everywhere else.</p>
        <button class="primary" type="submit">Change password</button>
      </form>
    </div>`;
  $("#who").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try { await post("/api/me", f, "PATCH"); session.me.user.name = f.name; if (f.workspace) session.me.account.name = f.workspace; $("#who-name").textContent = f.name; toast("Saved"); } catch (err) { fail(err); }
  });
  $("#buyer").addEventListener("submit", (e) => { e.preventDefault(); synced.set("profile", Object.fromEntries(new FormData(e.target))); toast("Saved. The agents will use it from now on."); });
  $("#pw").addEventListener("submit", async (e) => {
    e.preventDefault();
    try { await post("/api/me/password", Object.fromEntries(new FormData(e.target))); e.target.reset(); toast("Password changed"); } catch (err) { fail(err); }
  });
}

// ------------------------------------------------------------------ team
async function team(seq) {
  const t = await api("/api/team");
  if (stale(seq)) return;
  $("#tab").innerHTML = `
    <section class="panel">
      <div class="panel-head"><h2 class="h3">Members</h2>${t.isOwner ? `<button class="primary" id="invite" type="button">+ Invite someone</button>` : ""}</div>
      <div class="table-wrap"><table class="list-table"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Last sign-in</th><th></th></tr></thead><tbody>
      ${t.members.map((m) => `<tr><td>${esc(m.name || "–")}${m.id === t.me ? ' <span class="muted small">(you)</span>' : ""}</td><td>${esc(m.email)}</td>
        <td>${t.isOwner && m.id !== t.me ? `<select data-role="${m.id}" aria-label="Role for ${esc(m.email)}"><option value="member" ${m.role !== "owner" ? "selected" : ""}>Member</option><option value="owner" ${m.role === "owner" ? "selected" : ""}>Owner</option></select>` : m.role === "owner" ? "Owner" : "Member"}</td>
        <td class="muted">${m.last_login_at ? when(m.last_login_at) : "never"}</td>
        <td>${t.isOwner && m.id !== t.me ? `<button class="mini-btn danger" data-remove="${m.id}" data-email="${esc(m.email)}" type="button">Remove</button>` : ""}</td></tr>`).join("")}
      </tbody></table></div>
      <p class="muted small">Owners manage the team, AI keys and webhooks. Members work the pipeline and talk to the agents. Everyone shares the pipeline and documents; conversations are private.</p>
    </section>
    ${t.isOwner && t.invites.length ? `<section class="panel"><h2 class="h3">Pending invites</h2><ul class="link-list">${t.invites.map((i) => `<li><span>${esc(i.email || "Anyone with the link")} · ${i.role}</span><small>expires ${when(i.expires_at).replace(" ago", "")} <button class="mini-btn" data-revoke="${i.id}" type="button">Revoke</button></small></li>`).join("")}</ul></section>` : ""}`;
  $("#invite")?.addEventListener("click", async () => {
    const r = await dialog({ title: "Invite to the workspace", submit: "Create invite link", html: `<label class="field">Their email (optional)<input name="email" type="email" placeholder="Leave empty for a link anyone can use once"></label><label class="field">Role<select name="role"><option value="member">Member</option><option value="owner">Owner</option></select></label>` });
    if (!r) return;
    try {
      const inv = await post("/api/team/invites", r);
      await dialog({ title: "Invite link ready", submit: "", html: `<p>Send this to ${esc(inv.email || "them")}. It works once and expires in ${inv.expiresInDays} days.</p><div class="secret"><code>${esc(inv.link)}</code><button class="ghost" type="button" data-cp>Copy</button></div>`, onOpen: (d) => $("[data-cp]", d).addEventListener("click", () => copy(inv.link, "Link copied")) });
      team(seq);
    } catch (e) { fail(e); }
  });
  $$("[data-role]").forEach((s) => s.addEventListener("change", async () => { try { await post(`/api/team/members/${s.dataset.role}`, { role: s.value }, "PATCH"); toast("Role updated"); } catch (e) { fail(e); } }));
  $$("[data-remove]").forEach((b) => b.addEventListener("click", async () => {
    if (!(await confirmBox(`Remove ${b.dataset.email}?`, "They lose access immediately. Their conversations are deleted with them; targets and documents stay with the workspace.", "Remove"))) return;
    try { await api(`/api/team/members/${b.dataset.remove}`, { method: "DELETE" }); toast("Removed"); team(seq); } catch (e) { fail(e); }
  }));
  $$("[data-revoke]").forEach((b) => b.addEventListener("click", async () => { try { await api(`/api/team/invites/${b.dataset.revoke}`, { method: "DELETE" }); team(seq); } catch (e) { fail(e); } }));
}

// ------------------------------------------------------------------ integrations
async function integrations(seq) {
  const [d, seqs] = await Promise.all([api("/api/integrations"), api("/api/sequencers")]);
  if (stale(seq)) return;
  const replies = seqs.replies;
  const META_LABEL = { baseUrl: ["EmailBison address", "https://dedi.emailbison.com"], sid: ["Account SID", "AC…"], from: ["Default number (optional: found on the account)", "leave empty"], agentPhone: ["Your own phone (optional: only for “Twilio rings my phone”)", "+61412345678"], serverUrl: ["BlueBubbles server address", "https://abc-123.trycloudflare.com"], numbers: ["Local presence numbers (comma-separated, one per country)", "+447700900123, +61291234567, +4930123456"] };
  const card = (x) => `
      <form class="panel form-panel provider" data-provider="${x.id}">
        <div class="panel-head"><h2 class="h3">${esc(x.label)}</h2><span class="status ${x.connected ? "on" : ""}">${x.connected ? `Connected ··${esc(x.last4)}` : x.id === "monid" && x.platformFallback !== "not available" ? esc(x.platformFallback) : "Not connected"}</span></div>
        <label class="field">${x.id === "twilio" ? "Auth token" : x.id === "bluebubbles" ? "Server password" : "API key"}<input name="key" type="password" autocomplete="off" spellcheck="false" placeholder="${x.connected ? "Paste a new key to replace it" : "Paste the key"}" ${dis}></label>
        ${(x.metaFields || []).map((m) => `<label class="field">${esc(META_LABEL[m]?.[0] || m)}<input name="meta:${m}" value="${esc(Array.isArray(x.meta[m]) ? x.meta[m].join(", ") : x.meta[m] || "")}" placeholder="${esc(META_LABEL[m]?.[1] || "")}" ${dis}></label>`).join("")}
        <p class="muted small">${esc(x.hint)}</p>${x.id === "twilio" && x.meta?.trial ? `<p class="notice small">Trial account: it can only call numbers verified in Twilio. Upgrade it (add a card) to call owners.</p>` : ""}
        <div class="row">${d.canEdit ? `<button class="primary" type="submit">${x.connected ? (x.metaFields?.length ? "Save" : "Replace") : "Verify & connect"}</button>${x.connected ? `<button class="ghost" type="button" data-disconnect>Disconnect</button>` : ""}` : ""}${x.id === "monid" && x.connected ? `<a class="ghost" href="#/data">Open the data console</a>` : ""}${x.id === "bluebubbles" && x.connected && d.canEdit ? `<button class="ghost" type="button" data-bbhook>Reconnect incoming messages</button><button class="ghost" type="button" data-bbcheck>Check Private API</button>` : ""}</div>
        ${x.id === "bluebubbles" && x.connected ? `<p class="small" id="bbPrivate">Checking the Private API…</p>` : ""}
      </form>`;
  const k = Object.fromEntries(d.keys.map((x) => [x.id, x]));
  const dis = d.canEdit ? "" : "disabled";
  $("#tab").innerHTML = `
    <p class="lede tight">Bring your own AI accounts: every conversation, document and voice in this workspace then runs on your keys, with no daily limit from us. Keys are encrypted at rest and never shown again after you save them.</p>
    ${d.canEdit ? "" : `<p class="notice">Only workspace owners can change integrations.</p>`}
    <div class="settings-grid">
      <form class="panel form-panel provider" data-provider="anthropic">
        <div class="panel-head"><h2 class="h3">Anthropic · Claude</h2><span class="status ${k.anthropic.connected ? "on" : ""}">${k.anthropic.connected ? `Connected ··${esc(k.anthropic.last4)}` : "Not connected"}</span></div>
        <p class="muted small">Claude powers Josh (with all of his video transcripts in context), the debriefs and every agent. Without a key: ${esc(k.anthropic.platformFallback)}.</p>
        <label class="field">API key<input name="key" type="password" autocomplete="off" spellcheck="false" placeholder="${k.anthropic.connected ? "Paste a new key to replace the current one" : "sk-ant-…"}" ${dis}></label>
        <label class="field">Workspace ID (only for sk-ant-usr- keys)<input name="workspaceId" value="${esc(k.anthropic.meta.workspaceId || "")}" placeholder="wrkspc_…" ${dis}></label>
        <label class="field">Model<select name="model" ${dis}>${d.models.map((m) => `<option ${m === (k.anthropic.meta.model || d.models[0]) ? "selected" : ""}>${m}</option>`).join("")}</select></label>
        <p class="muted small">${esc(k.anthropic.hint)}</p>
        <div class="row">${d.canEdit ? `<button class="primary" type="submit">${k.anthropic.connected ? "Save" : "Verify & connect"}</button>${k.anthropic.connected ? `<button class="ghost" type="button" data-disconnect>Disconnect</button>` : ""}` : ""}</div>
      </form>
      <form class="panel form-panel provider" data-provider="elevenlabs">
        <div class="panel-head"><h2 class="h3">ElevenLabs · voices</h2><span class="status ${k.elevenlabs.connected ? "on" : ""}">${k.elevenlabs.connected ? `Connected ··${esc(k.elevenlabs.last4)}` : "Not connected"}</span></div>
        <p class="muted small">Lifelike voices for Josh and the practice owners. Without a key: ${esc(k.elevenlabs.platformFallback)}.</p>
        <label class="field">API key<input name="key" type="password" autocomplete="off" spellcheck="false" placeholder="${k.elevenlabs.connected ? "Paste a new key to replace the current one" : "sk_…"}" ${dis}></label>
        <label class="field">Josh's voice ID (optional)<input name="voiceId" value="${esc(k.elevenlabs.meta.voiceId || "")}" placeholder="From your ElevenLabs voice library" ${dis}></label>
        <p class="muted small">${esc(k.elevenlabs.hint)}</p>
        <div class="row">${d.canEdit ? `<button class="primary" type="submit">${k.elevenlabs.connected ? "Save" : "Verify & connect"}</button>${k.elevenlabs.connected ? `<button class="ghost" type="button" data-disconnect>Disconnect</button>` : ""}` : ""}</div>
      </form>
    </div>
    <h2 class="sub-sm">Data: scraping and enrichment</h2>
    <div class="settings-grid">${["monid", "google_places", "companies_house", "hunter"].map((id) => card(k[id])).join("")}</div>
    <h2 class="sub-sm">Outreach: cold email and calling</h2>
    <div class="settings-grid">${["instantly", "smartlead", "emailbison", "twilio", "bluebubbles"].map((id) => card(k[id])).join("")}</div>
    <section class="panel">
      <div class="panel-head"><h2 class="h3">Reply webhook</h2>${d.canEdit ? `<button class="ghost" id="replyHook" type="button">${replies.configured ? "Make a new URL" : "Create the URL"}</button>` : ""}</div>
      <p class="muted small">Paste this URL into Instantly (Settings → Webhooks → “Reply received”), Smartlead (campaign → Webhooks → “Email reply”) or EmailBison (Webhooks → “Lead replied”). Every reply lands on the target's timeline; the AI sorts it (interested, meeting, later, out of office, not interested, unsubscribe), moves the target on, suppresses opt-outs and drafts an answer for your approval in the Inbox.</p>
      ${replies.configured ? `<p class="small">URL created ${when(replies.created_at)}. It's shown only once; make a new one if you lost it (the old one stops working).</p>` : ""}
      ${replies.replies.length ? `<div class="table-wrap"><table class="mini-table"><thead><tr><th>When</th><th>From</th><th>Read as</th><th>Summary</th></tr></thead><tbody>${replies.replies.slice(0, 10).map((r) => `<tr><td class="nowrap">${when(r.created_at)}</td><td class="small">${r.target_id ? `<a href="#/targets/${r.target_id}">${esc(r.target_name || r.from_email)}</a>` : esc(r.from_email)}</td><td><span class="chip">${esc(r.category.replace("_", " "))}</span></td><td class="small">${esc(r.summary)}</td></tr>`).join("")}</tbody></table></div>` : ""}
    </section>
    <section class="panel">
      <div class="panel-head"><h2 class="h3">Webhooks</h2>${d.canEdit ? `<button class="primary" id="addHook" type="button">+ Add webhook</button>` : ""}</div>
      <p class="muted small">Send pipeline events to your own systems (your CRM, Zapier, Make, Slack via a relay). Each delivery is signed so you can check it came from us.</p>
      ${d.hooks.length ? `<div class="table-wrap"><table class="list-table"><thead><tr><th>URL</th><th>Events</th><th>Last delivery</th><th></th></tr></thead><tbody>${d.hooks.map((h) => `<tr><td><code>${esc(h.url)}</code></td><td class="small">${h.events === "*" ? "All events" : esc(h.events.replaceAll(",", ", "))}</td><td class="small">${h.last_at ? `<span class="${h.last_status >= 200 && h.last_status < 300 ? "tone-ok" : "tone-bad"}">${h.last_status || "failed"}</span> · ${when(h.last_at)}` : "never"}</td><td>${d.canEdit ? `<button class="mini-btn" data-test="${h.id}" type="button">Send test</button> <button class="mini-btn danger" data-delhook="${h.id}" type="button">Delete</button>` : ""}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted small">No webhooks yet.</p>`}
    </section>`;
  $$(".provider").forEach((f) => {
    const provider = f.dataset.provider;
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(f));
      const btn = $("button[type=submit]", f);
      btn.disabled = true; btn.textContent = v.key ? "Checking the key…" : "Saving…";
      const meta = { model: v.model, voiceId: v.voiceId, workspaceId: v.workspaceId };
      for (const [mk, mv] of Object.entries(v)) if (mk.startsWith("meta:")) meta[mk.slice(5)] = mv;
      try {
        const r = await post(`/api/integrations/${provider}`, { key: v.key, meta }, "PUT"); toast(v.key ? "Connected" : "Saved");
        if (r.imessage) await bbHookResult(r.imessage);
        if (r.phone) {
          if (r.phone.error) toast(`Connected, but the browser phone isn't set up yet: ${r.phone.error}`, "error");
          else { const { refreshPhone, openPhone } = await import("../phone.js"); await refreshPhone({ preferBrowser: true }); toast(r.phone.has_number ? "Browser calling is ready: click any number, or press Space in the dialer" : "Connected. Last step: get a number to call from"); openPhone("keypad"); }
        }
        session.team = await api("/api/agents"); integrations(seq);
      }
      catch (err) { fail(err); btn.disabled = false; btn.textContent = "Try again"; }
    });
    $("[data-disconnect]", f)?.addEventListener("click", async () => {
      if (!(await confirmBox("Disconnect this key?", "The workspace goes back to the platform's AI and daily limits.", "Disconnect"))) return;
      try { await api(`/api/integrations/${provider}`, { method: "DELETE" }); session.team = await api("/api/agents"); integrations(seq); } catch (e) { fail(e); }
    });
  });
  const bbShow = (st) => { const el = $("#bbPrivate"); if (el) el.innerHTML = st.private_api ? `<span class="tone-ok">Private API on</span>: typing indicators, read receipts and tapbacks work, and sends skip the Messages window.` : `<span class="muted">Private API off</span>: texts send through AppleScript. For typing, read receipts and tapbacks, turn on the Private API in BlueBubbles Server (Settings → Private API; it needs SIP partly disabled on the Mac, see bluebubbles.app/install), then press Check Private API.`; };
  if ($("#bbPrivate")) api("/api/imessage").then(bbShow).catch(() => {});
  $("[data-bbcheck]")?.addEventListener("click", async (e) => { e.currentTarget.disabled = true; try { const st = await post("/api/imessage/refresh"); bbShow(st); toast(st.private_api ? "Private API is on" : "Private API isn't reachable yet", st.private_api ? "" : "error"); } catch (err) { fail(err); } e.currentTarget.disabled = false; });
  $("[data-bbhook]")?.addEventListener("click", async (e) => { e.currentTarget.disabled = true; try { await bbHookResult(await post("/api/imessage/hook")); } catch (err) { fail(err); } integrations(seq); });
  $("#replyHook")?.addEventListener("click", async () => {
    if (replies.configured && !(await confirmBox("Make a new reply URL?", "The current URL stops working; paste the new one into your sequencer.", "Make a new one"))) return;
    try {
      const r = await post("/api/replies/hook");
      await dialog({ title: "Your reply webhook", submit: "", html: `<p>Paste this into your sequencer's reply webhook. Shown once.</p><div class="secret"><code>${esc(r.url)}</code><button class="ghost" type="button" data-cp>Copy</button></div><p class="muted small">Add <code>?from=instantly</code>, <code>?from=smartlead</code> or <code>?from=emailbison</code> to label where replies came from.</p>`, onOpen: (dl) => $("[data-cp]", dl).addEventListener("click", () => copy(r.url, "URL copied")) });
      integrations(seq);
    } catch (e) { fail(e); }
  });
  $("#addHook")?.addEventListener("click", async () => {
    const r = await dialog({ title: "Add a webhook", submit: "Add", html: `<label class="field">Endpoint URL<input name="url" type="url" required placeholder="https://hooks.zapier.com/…"></label>
      <fieldset class="checks"><legend>Events (none ticked = all)</legend>${d.events.map((ev) => `<label class="check"><input type="checkbox" name="ev:${ev}"> ${ev}</label>`).join("")}</fieldset>` });
    if (!r) return;
    const events = Object.keys(r).filter((x) => x.startsWith("ev:") && r[x]).map((x) => x.slice(3));
    try {
      const h = await post("/api/webhooks", { url: r.url, events });
      await dialog({ title: "Webhook added", submit: "", html: `<p>Your signing secret. It's shown once: store it with the receiving app.</p><div class="secret"><code>${esc(h.secret)}</code><button class="ghost" type="button" data-cp>Copy</button></div><p class="muted small">Check each delivery: <code>X-Warplan-Signature</code> is <code>sha256=</code> + HMAC-SHA256(secret, <code>timestamp + "." + body</code>), with the timestamp from <code>X-Warplan-Timestamp</code>.</p>`, onOpen: (dl) => $("[data-cp]", dl).addEventListener("click", () => copy(h.secret, "Secret copied")) });
      integrations(seq);
    } catch (e) { fail(e); }
  });
  $$("[data-test]").forEach((b) => b.addEventListener("click", async () => { b.disabled = true; try { const r = await post(`/api/webhooks/${b.dataset.test}/test`); toast(r.ok ? `Delivered (${r.status})` : `Failed (${r.status || "no response"})`, r.ok ? "" : "error"); integrations(seq); } catch (e) { fail(e); b.disabled = false; } }));
  $$("[data-delhook]").forEach((b) => b.addEventListener("click", async () => { if (!(await confirmBox("Delete this webhook?", "Deliveries stop immediately."))) return; try { await api(`/api/webhooks/${b.dataset.delhook}`, { method: "DELETE" }); integrations(seq); } catch (e) { fail(e); } }));
}

// ------------------------------------------------------------------ API
async function apiTab(seq) {
  const [t, docs] = await Promise.all([api("/api/team"), api("/api")]);
  if (stale(seq)) return;
  const origin = location.origin;
  $("#tab").innerHTML = `
    <section class="panel">
      <div class="panel-head"><h2 class="h3">API tokens</h2><button class="primary" id="newToken" type="button">+ New token</button></div>
      <p class="muted small">Connect your own tools: a token acts as you, with your access. Keep tokens secret; revoke any you don't recognise.</p>
      ${t.tokens.length ? `<div class="table-wrap"><table class="list-table"><thead><tr><th>Label</th><th>Owner</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody>${t.tokens.map((x) => `<tr><td>${esc(x.label)}</td><td class="small">${esc(x.email)}</td><td class="muted small">${when(x.created_at)}</td><td class="muted small">${x.last_used_at ? when(x.last_used_at) : "never"}</td><td><button class="mini-btn danger" data-revoke="${x.id}" type="button">Revoke</button></td></tr>`).join("")}</tbody></table></div>` : `<p class="muted small">No tokens yet.</p>`}
    </section>
    <section class="panel">
      <h2 class="h3">Quick start</h2>
<pre class="code"><code># Add a target
curl -X POST ${origin}/api/targets \\
  -H "Authorization: Bearer wp_YOUR_TOKEN" -H "Content-Type: application/json" \\
  -d '{"name":"Acme Plumbing","industry":"Plumbing","location":"Austin, TX","ebitda":450000,"stage":"sourced"}'

# Have the Outreach agent write the first letter
curl -X POST ${origin}/api/documents/generate \\
  -H "Authorization: Bearer wp_YOUR_TOKEN" -H "Content-Type: application/json" \\
  -d '{"kind":"outreach","channel":"letter","target_id":42}'

# Ask Josh, streamed
curl -N -X POST ${origin}/api/threads/7/messages \\
  -H "Authorization: Bearer wp_YOUR_TOKEN" -H "Content-Type: application/json" -H "Accept: text/event-stream" \\
  -d '{"text":"What should I say on the first call?"}'</code></pre>
    </section>
    <section class="panel">
      <h2 class="h3">Endpoints</h2>
      <div class="table-wrap"><table class="list-table api-table"><tbody>${docs.endpoints.map(([m, p, d]) => `<tr><td><span class="method m-${m.toLowerCase()}">${m}</span></td><td><code>${esc(p)}</code></td><td class="small">${esc(d)}</td></tr>`).join("")}</tbody></table></div>
      <p class="muted small">${esc(docs.webhooks)}</p>
    </section>`;
  $("#newToken").addEventListener("click", async () => {
    const r = await dialog({ title: "New API token", submit: "Create", html: `<label class="field">Label<input name="label" maxlength="60" placeholder="e.g. Zapier, our CRM" required></label>` });
    if (!r) return;
    try {
      const tok = await post("/api/tokens", r);
      await dialog({ title: "Your token", submit: "", html: `<p>Copy it now: it's shown once.</p><div class="secret"><code>${esc(tok.token)}</code><button class="ghost" type="button" data-cp>Copy</button></div>`, onOpen: (d) => $("[data-cp]", d).addEventListener("click", () => copy(tok.token, "Token copied")) });
      apiTab(seq);
    } catch (e) { fail(e); }
  });
  $$("[data-revoke]").forEach((b) => b.addEventListener("click", async () => { if (!(await confirmBox("Revoke this token?", "Anything using it stops working immediately.", "Revoke"))) return; try { await api(`/api/tokens/${b.dataset.revoke}`, { method: "DELETE" }); apiTab(seq); } catch (e) { fail(e); } }));
}

// ------------------------------------------------------------------ usage
async function usage(seq) {
  const u = await api("/api/usage?days=30");
  if (stale(seq)) return;
  const brain = session.team.brain;
  const max = Math.max(1, ...u.byDay.map((x) => x.calls));
  const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n || 0));
  const label = (f) => ({ josh: "Josh", simulator: "Practice calls", debrief: "Debriefs" }[f] || f.replace("doc:", "Document: "));
  $("#tab").innerHTML = `
    <div class="metric-strip">
      <div><span>AI calls · 30 days</span><b>${u.totals.calls}</b><small>${fmt(u.totals.input + u.totals.cached)} tokens in · ${fmt(u.totals.output)} out</small></div>
      <div><span>Cached input</span><b>${fmt(u.totals.cached)}</b><small>billed at a tenth</small></div>
      <div><span>Est. Claude cost</span><b>$${u.totals.cost.toFixed(2)}</b><small>at list prices</small></div>
      <div class="${!brain.own && u.platformToday >= u.platformDailyLimit * 0.8 ? "alert" : ""}"><span>Included today</span><b>${brain.own ? "∞" : `${u.platformToday}/${u.platformDailyLimit}`}</b><small>${brain.own ? "your own key: no limit" : "calls on the platform's AI"}</small></div>
    </div>
    <section class="panel">
      <h2 class="h3">Calls per day</h2>
      ${u.byDay.length ? `<div class="daybars" role="img" aria-label="AI calls per day for the last 30 days">${u.byDay.map((x) => `<i style="height:${Math.max(4, (100 * x.calls) / max)}%" title="${x.day}: ${x.calls} calls"></i>`).join("")}</div>` : `<p class="muted small">No AI calls yet.</p>`}
    </section>
    <section class="panel">
      <h2 class="h3">By feature</h2>
      ${u.rows.length ? `<div class="table-wrap"><table class="list-table"><thead><tr><th>Feature</th><th>Model</th><th class="num">Calls</th><th class="num">In</th><th class="num">Cached</th><th class="num">Out</th><th class="num">Est. cost</th></tr></thead><tbody>${u.rows.map((r) => `<tr><td>${esc(label(r.feature))}</td><td class="small muted">${esc(r.model)}${r.own ? " · own key" : ""}</td><td class="num">${r.calls}</td><td class="num">${fmt(r.input)}</td><td class="num">${fmt(r.cached)}</td><td class="num">${fmt(r.output)}</td><td class="num">${r.cost ? `$${r.cost.toFixed(2)}` : "–"}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted small">Nothing yet.</p>`}
      <p class="muted small">Workers AI calls show no cost here; they're covered by the platform. Claude costs are billed by Anthropic to whoever owns the key.</p>
    </section>`;
}

// ------------------------------------------------------------------ connect: plug Warplan into everything
async function connect(seq) {
  const tools = (await api("/api/agent/tools")).tools;
  if (stale(seq)) return;
  const origin = location.origin, mcp = `${origin}/mcp`;
  const snippets = (tok) => ({
    claudeCode: `claude mcp add --transport http warplan ${mcp} --header "Authorization: Bearer ${tok}"`,
    cursor: JSON.stringify({ mcpServers: { warplan: { url: mcp, headers: { Authorization: `Bearer ${tok}` } } } }, null, 2),
    desktop: JSON.stringify({ mcpServers: { warplan: { command: "npx", args: ["-y", "mcp-remote", mcp, "--header", `Authorization: Bearer ${tok}`] } } }, null, 2),
    url: `${mcp}/${tok}`,
    agent: `curl -X POST ${origin}/api/agent \\\n  -H "Authorization: Bearer ${tok}" -H "Content-Type: application/json" \\\n  -d '{"text":"I just spoke to Frank at Dalton. Log it and set a follow-up for Friday."}'`,
  });
  const draw = (tok) => {
    const s = snippets(tok || "wp_YOUR_TOKEN");
    $("#tab").innerHTML = `
    <p class="lede tight">Warplan speaks MCP, the open standard AI apps use to call tools. Connect it once and Claude, Cursor, n8n or your own agent can search your pipeline, add targets, move stages, log calls, run the deal engine and have the agents write letters and LOIs, as you, in your workspace.</p>
    <section class="panel">
      <div class="panel-head"><h2 class="h3">1 · Get a connection token</h2>${tok ? `<span class="status on">Token ready</span>` : `<button class="primary" id="mkTok" type="button">Create a connection token</button>`}</div>
      <p class="muted small">${tok ? "Copy what you need below now: the token is shown only once. Revoke it any time under Settings → API." : "A token acts as you. Make one per app so you can revoke them separately."}</p>
      ${tok ? `<div class="secret"><code>${esc(tok)}</code><button class="ghost" type="button" data-cp="${esc(tok)}">Copy</button></div>` : ""}
    </section>
    <div class="settings-grid">
      ${box("Claude Code", "Run in your terminal:", s.claudeCode)}
      ${box("Cursor / Windsurf / VS Code", "Add to mcp.json:", s.cursor)}
      ${box("Claude Desktop", "Add to claude_desktop_config.json (uses mcp-remote):", s.desktop)}
      ${box("claude.ai · n8n · anything that takes a URL", "Paste this URL as a custom connector / MCP Client Tool. The token is in the URL, so keep it private:", s.url)}
    </div>
    <section class="panel">
      <h2 class="h3">Headless agent for Zapier, Make, Slack bots</h2>
      <p class="muted small">POST any instruction to Josh and he does it with his tools, then answers. Pass <code>thread_id</code> to continue a conversation. Pair it with the signed webhooks (Integrations) to trigger flows on stage changes, new documents, approvals and the daily briefing.</p>
      <pre class="code"><code>${esc(s.agent)}</code></pre>
      <div class="row"><button class="ghost" type="button" data-cp="${esc(s.agent.replace(/\\\n\s*/g, ""))}">Copy</button><a class="ghost" href="#/settings/integrations">Set up webhooks →</a></div>
    </section>
    <section class="panel">
      <h2 class="h3">What connected agents can do</h2>
      <div class="table-wrap"><table class="list-table api-table"><tbody>${tools.map((t) => `<tr><td><code>${esc(t.name)}</code></td><td><span class="method ${t.write ? "m-post" : "m-get"}">${t.write ? "WRITE" : "READ"}</span></td><td class="small">${esc(t.description)}</td></tr>`).join("")}</tbody></table></div>
      <p class="muted small">Want a person to sign off first? External agents can <code>POST /api/inbox</code> to queue an action; it waits in the Inbox until someone approves it.</p>
    </section>`;
    $("#mkTok")?.addEventListener("click", async () => {
      try { const t = await post("/api/tokens", { label: "AI app connection" }); draw(t.token); toast("Token created. Copy it now."); } catch (e) { fail(e); }
    });
    $$("[data-cp]").forEach((b) => b.addEventListener("click", () => copy(b.dataset.cp)));
  };
  draw(null);
}
function box(title, hint, code) {
  return `<section class="panel"><h2 class="h3">${esc(title)}</h2><p class="muted small">${esc(hint)}</p><pre class="code"><code>${esc(code)}</code></pre><button class="ghost" type="button" data-cp="${esc(code)}">Copy</button></section>`;
}

// ------------------------------------------------------------------ email: send from your own mailbox
async function emailTab(seq) {
  const [box, sup] = await Promise.all([api("/api/mailbox"), api("/api/suppressions")]);
  if (stale(seq)) return;
  const P = box.presets;
  const isGmail = /gmail\.com$/.test(box.host || "smtp.gmail.com");
  $("#tab").innerHTML = `
    <p class="lede tight">Emails to owners go out from your own address, so they look like they came from you (they did), land in your Sent folder, and replies come straight back to your inbox.</p>
    <div class="settings-grid">
      <form class="panel form-panel" id="mbForm">
        <div class="panel-head"><h2 class="h3">Your mailbox</h2><span class="status ${box.connected ? "on" : ""}">${box.connected ? `Connected · ${esc(box.email)}` : "Not connected"}</span></div>
        <label class="field">Provider<select name="preset">${Object.entries(P).map(([k, v]) => `<option value="${k}" ${(box.connected ? (k === "gmail" && isGmail) || (k === "outlook" && /office365|outlook/.test(box.host)) || (k === "custom" && !isGmail && !/office365|outlook/.test(box.host)) : k === "gmail") ? "selected" : ""}>${esc(v.label)}</option>`).join("")}</select></label>
        <p class="muted small" id="presetHelp"></p>
        <div class="two"><label class="field">Send from<input name="email" type="email" required value="${esc(box.email || session.me.user.email)}"></label><label class="field">Your name<input name="from_name" value="${esc(box.from_name || session.me.user.name || "")}" maxlength="80"></label></div>
        <label class="field" id="pwLabel">App password<input name="password" type="password" autocomplete="new-password" spellcheck="false" placeholder="${box.connected ? "Leave empty to keep the current one" : "16 letters from Google"}"></label>
        <div class="two custom-only" hidden><label class="field">SMTP host<input name="host" value="${esc(box.host || "")}" placeholder="smtp.example.com"></label><label class="field">Port<input name="port" type="number" value="${box.port || 465}"></label></div>
        <label class="field">Signature<textarea name="signature" rows="3" placeholder="Bendik\nAsym Capital · +47 …">${esc(box.signature || "")}</textarea></label>
        <label class="field">Postal address (required in the US for commercial email)<input name="postal_address" value="${esc(box.postal_address || "")}" maxlength="300"></label>
        <label class="field">Daily send limit<input name="daily_limit" type="number" min="1" max="200" value="${box.daily_limit || 40}"></label>
        <p class="muted small">Personal mailboxes get flagged as spam above a few dozen cold emails a day. Start at 20–40 and write each one like it's the only one.</p>
        <div class="row"><button class="primary" type="submit">${box.connected ? "Save" : "Connect & verify"}</button>${box.connected ? `<button class="ghost" type="button" id="mbTest">Send me a test</button><button class="ghost" type="button" id="mbOff">Disconnect</button>` : ""}</div>
      </form>
      <section class="panel form-panel">
        <div class="panel-head"><h2 class="h3">Or: a ready-made inbox</h2><span class="status ${box.host === "agentmail" ? "on" : ""}">${box.host === "agentmail" ? "In use" : "AgentMail"}</span></div>
        <p class="muted small">No app password needed: Warplan creates a real inbox for you (e.g. <code>bendik.deals@agentmail.to</code>) on your Monid wallet, about $1 a month. Emails send from it, and replies are read automatically every 10 minutes: sorted by the AI, put on the right target, with a drafted answer in your Inbox.</p>
        <form class="row" id="amForm"><input name="username" placeholder="name (optional)" maxlength="40" style="flex:1"><button class="ghost" type="submit">Create my inbox</button></form>
        ${box.host === "agentmail" ? `<button class="link" type="button" id="amSync">Check for replies now</button>` : ""}
      </section>
      <section class="panel">
        <h2 class="h3">Do not contact</h2>
        <p class="muted small">Anyone here is never emailed again from this workspace. Add people who reply "no thanks" or ask to be removed.</p>
        <form class="row" id="supForm"><input name="email" type="email" placeholder="owner@company.com" required style="flex:1"><button class="ghost" type="submit">Add</button></form>
        ${sup.length ? `<ul class="link-list">${sup.map((x) => `<li><span>${esc(x.email)}</span><small>${when(x.created_at)} <button class="mini-btn" data-unsup="${esc(x.email)}" type="button">Remove</button></small></li>`).join("")}</ul>` : `<p class="muted small">Nobody yet.</p>`}
      </section>
    </div>`;
  $("#amForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!(await confirmBox("Create an inbox?", "This creates a real email inbox on your Monid wallet (about $1 a month) and makes it the address your emails send from.", "Create it"))) return;
    try { const r = await post("/api/mailbox/agentmail", { username: e.target.username.value, from_name: session.me.user.name }); toast(r.receipt); emailTab(seq); } catch (err) { fail(err); }
  });
  $("#amSync")?.addEventListener("click", async () => { try { const r = await post("/api/mailbox/sync"); toast(`${r.replies} new repl${r.replies === 1 ? "y" : "ies"}`); } catch (e) { fail(e); } });
  const form = $("#mbForm");
  const syncPreset = () => {
    const k = form.preset.value;
    $("#presetHelp").textContent = P[k].help;
    $(".custom-only").hidden = k !== "custom";
    $("#pwLabel").firstChild.textContent = k === "gmail" ? "App password" : "Password";
  };
  syncPreset();
  form.preset.addEventListener("change", syncPreset);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    const b = $("button[type=submit]", form);
    b.disabled = true; b.textContent = "Checking the login…";
    try { await post("/api/mailbox", f, "PUT"); toast("Mailbox connected"); emailTab(seq); }
    catch (err) { fail(err); b.disabled = false; b.textContent = box.connected ? "Save" : "Connect & verify"; }
  });
  $("#mbTest")?.addEventListener("click", async (e) => { e.currentTarget.disabled = true; try { await post("/api/mailbox/test"); toast(`Test sent to ${box.email}. Check your inbox.`); } catch (err) { fail(err); } e.currentTarget.disabled = false; });
  $("#mbOff")?.addEventListener("click", async () => { if (!(await confirmBox("Disconnect your mailbox?", "Warplan won't be able to send email for you until you connect it again.", "Disconnect"))) return; try { await api("/api/mailbox", { method: "DELETE" }); emailTab(seq); } catch (e) { fail(e); } });
  $("#supForm").addEventListener("submit", async (e) => { e.preventDefault(); try { await post("/api/suppressions", Object.fromEntries(new FormData(e.target))); emailTab(seq); } catch (err) { fail(err); } });
  $$("[data-unsup]").forEach((b) => b.addEventListener("click", async () => { try { await api(`/api/suppressions?email=${encodeURIComponent(b.dataset.unsup)}`, { method: "DELETE" }); emailTab(seq); } catch (e) { fail(e); } }));
}

// After connecting the iMessage relay: either Warplan registered itself on the BlueBubbles server, or the owner has
// to paste the incoming URL there by hand (older servers). The URL is shown once.
async function bbHookResult(r) {
  if (r.error) return toast(`Connected, but incoming messages aren't set up: ${r.error}`, "error");
  if (r.webhook_registered) return toast("iMessage relay connected. Replies now land on your targets' timelines.");
  if (r.url) await dialog({ title: "One more step for incoming iMessages", submit: "", html: `<p>In BlueBubbles Server → <b>API & Webhooks</b> → Add webhook, paste this URL and tick <b>New messages</b>. Shown once.</p><div class="secret"><code>${esc(r.url)}</code><button class="ghost" type="button" data-cp>Copy</button></div>`, onOpen: (dl) => $("[data-cp]", dl).addEventListener("click", () => copy(r.url, "URL copied")) });
}
