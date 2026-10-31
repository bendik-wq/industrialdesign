/* Funnel HQ → Clients, Support, and the Integrations panels for Claude (MCP) and Zapier & webhooks.
   Loaded before admin.js, which calls ClientsBoard.render(ctx), SupportBoard.render(ctx) and AutomationsPanel.render(el, ctx). */
(function (root) {
  'use strict';

  var CSS = '.oe-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.oe-grid{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:14px;margin-top:14px}' +
    '.oe-list tr{cursor:pointer}.oe-list tr[aria-selected="true"] td{background:var(--surface-2)}.oe-band{font-weight:650}.oe-band.healthy{color:var(--good-text)}.oe-band.watch{color:#9a6700}.oe-band.at_risk{color:var(--critical,#d1242f)}.oe-band.churned{color:var(--muted)}' +
    '.oe-reasons li{margin:2px 0}.oe-reasons .neg{color:var(--critical,#d1242f)}.oe-reasons .pos{color:var(--good-text)}.oe-tl{list-style:none;padding:0;margin:0}.oe-tl li{padding:6px 0;border-top:1px solid var(--border);font-size:13px;display:grid;grid-template-columns:110px 1fr;gap:8px}' +
    '.oe-msg{padding:10px 12px;border-radius:10px;background:var(--surface-2);margin:8px 0;white-space:pre-wrap;font-size:14px}.oe-msg.out{background:color-mix(in srgb,var(--series-1,#0f2c5c) 8%,transparent)}.oe-msg .muted{display:block;font-size:12px;margin-bottom:4px;white-space:normal}' +
    '.oe-ta{width:100%;min-height:150px;font:inherit;padding:10px;border:1px solid var(--border);border-radius:10px;background:var(--plane);color:var(--ink)}.oe-cites a{margin-right:10px}.oe-esc{border-left:3px solid var(--warning,#fab219);padding:6px 10px;margin:8px 0;background:color-mix(in srgb,var(--warning,#fab219) 10%,transparent)}' +
    '.oe-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;background:var(--surface-2);padding:8px 10px;border-radius:8px;white-space:pre-wrap;word-break:break-all;margin:6px 0}.oe-secret{border:1px solid var(--good,#0ca30c);padding:10px;border-radius:10px;margin-top:10px}' +
    '.oe-checks label{display:flex;gap:8px;align-items:center;padding:3px 0;font-size:14px}.oe-events label{display:inline-flex;gap:6px;align-items:center;margin:2px 12px 2px 0;font-size:13px}' +
    '@media (max-width:900px){.oe-grid{grid-template-columns:1fr}.oe-tl li{grid-template-columns:1fr}}';
  function css() { if (!document.getElementById('oe-css')) { var s = document.createElement('style'); s.id = 'oe-css'; s.textContent = CSS; document.head.appendChild(s); } }
  function post(path, body, method) {
    return fetch('/admin/api/' + path, { method: method || 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }); });
  }
  function get(path) { return fetch('/admin/api/' + path, { credentials: 'same-origin' }).then(function (r) { if (r.status === 401) location.href = '/admin/login'; return r.json(); }); }
  var BAND = { healthy: 'Healthy', watch: 'Watch', at_risk: 'At risk', churned: 'Churned' };
  var TYPE = { sprint: 'First Deal Sprint', deposit: 'Deposit paid', engagement: 'Engagement' };
  var TOUCH = { session_attended: 'Weekly session attended', session_missed: 'Weekly session missed', call: 'Call', note: 'Note', outreach_sent: 'Owner outreach sent' };
  var TAB_NAME = { dealsprint: 'Sprint board', contracts: 'Agreements', support: 'Support', clients: 'Clients', sales: 'Calls & deals', emails: 'Emails' };

  // ───────────── Clients ─────────────
  var clientsSel = null;
  function renderClients(ctx) {
    css();
    var view = ctx.view, esc = ctx.esc, when = ctx.when, tile = ctx.tile, toast = ctx.toast;
    return get('clients').then(function (d) {
      var S = d.summary || {};
      var flagPills = function (flags) { return (flags || []).map(function (f) { return '<span class="pill">' + esc(d.flagLabels[f] || f) + '</span>'; }).join(' '); };
      var rows = (d.clients || []).map(function (c) {
        return '<tr data-cl="' + esc(c.lead_id) + '"' + (clientsSel === c.lead_id ? ' aria-selected="true"' : '') + '><td>' + esc(c.name) + '<div class="muted small">' + esc(c.email || '') + '</div></td><td>' + esc(TYPE[c.type] || c.type) + '</td>' +
          '<td class="num"><span class="oe-band ' + esc(c.band) + '">' + esc(c.health == null ? '–' : c.health) + '</span> <span class="muted small">' + esc(BAND[c.band] || '') + '</span></td>' +
          '<td>' + flagPills(c.flags) + '</td><td class="nw">' + esc(c.last_contact_at ? when(c.last_contact_at) : 'none yet') + '</td><td class="nw">' + (c.pending_checkin ? '<span class="pill st-booked">Waiting for approval</span>' : esc(c.next_checkin_at ? when(c.next_checkin_at) : '–')) + '</td></tr>';
      }).join('');
      view.innerHTML = (d.ai ? '<div class="card"><p class="muted">' + esc(d.ai) + ' Check-ins use the built-in template until then.</p></div>' : '') +
        '<div class="grid g-4 tiles">' + tile('Clients', String(S.total || 0), 'paid Sprint, deposit or signed engagement') + tile('At risk', String(S.at_risk || 0), 'health under 50') + tile('Watch', String(S.watch || 0), 'health 50 to 74') + tile('Check-ins waiting', String(S.checkins_waiting || 0), 'drafted, waiting for your approval') + '</div>' +
        '<div class="card" style="margin-top:14px"><div class="card-head"><div><h2>Clients</h2><p class="sub">Health starts at 100; every deduction is a row in our data, listed with the view it came from. Rebuilt daily' + (d.lastRun ? ' (last run ' + esc(d.lastRun) + ')' : '') + '.</p></div><button class="btn-sm ghost" data-oe-rebuild>Rebuild now</button></div>' +
        (rows ? '<div class="table-wrap"><table class="oe-list"><thead><tr><th>Client</th><th>Type</th><th class="num">Health</th><th>Flags</th><th>Last two-way contact</th><th>Next check-in</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
          : ctx.emptyState('No clients yet.', 'A lead becomes a client when they pay for the First Deal Sprint, pay the engagement deposit or sign the engagement agreement. Press Rebuild now after the first one.')) +
        '</div><div data-oe-detail></div>';
      view.querySelector('[data-oe-rebuild]').onclick = function (e) { e.target.disabled = true; post('clients/rebuild').then(function (r) { toast('Rebuilt ' + (r.clients || 0) + ' clients'); ctx.reload(); }); };
      view.querySelectorAll('[data-cl]').forEach(function (tr) { tr.onclick = function () { clientsSel = tr.getAttribute('data-cl'); view.querySelectorAll('[data-cl]').forEach(function (x) { x.setAttribute('aria-selected', String(x === tr)); }); clientDetail(ctx, clientsSel); }; });
      if (clientsSel && (d.clients || []).some(function (c) { return c.lead_id === clientsSel; })) clientDetail(ctx, clientsSel);
    });
  }

  function clientDetail(ctx, id) {
    var esc = ctx.esc, when = ctx.when, toast = ctx.toast;
    var box = ctx.view.querySelector('[data-oe-detail]');
    box.innerHTML = '<div class="card" style="margin-top:14px">Loading…</div>';
    get('clients/' + encodeURIComponent(id)).then(function (d) {
      if (d.error) { box.innerHTML = '<div class="card">' + esc(d.error) + '</div>'; return; }
      var L = d.lead || {}, H = d.health || {};
      var name = [L.first_name, L.last_name].filter(Boolean).join(' ') || L.email;
      var reasons = (H.reasons || []).map(function (r) { return '<li><span class="' + (r.delta < 0 ? 'neg' : 'pos') + '">' + (r.delta > 0 ? '+' : '') + esc(r.delta) + '</span> ' + esc(r.label) + ' <a href="#' + esc(r.source) + '" class="muted small">' + esc(TAB_NAME[r.source] || r.source) + '</a></li>'; }).join('') || '<li class="muted">Nothing deducted.</li>';
      var checks = (d.checklist || []).map(function (i) { return '<label><input type="checkbox" data-ck="' + esc(i.key) + '"' + (i.done_at ? ' checked' : '') + (i.auto ? ' disabled title="Filled in from the data"' : '') + '> ' + esc(i.label) + (i.done_at ? ' <span class="muted small">' + esc(when(i.done_at)) + '</span>' : '') + '</label>'; }).join('');
      var pending = (d.checkins || []).filter(function (c) { return c.status === 'proposed'; })[0];
      var pend = pending ? '<div class="card" style="margin-top:14px"><h3>Check-in waiting for approval</h3><p class="sub">Why now: ' + esc(pending.reason || '') + ' · drafted by ' + esc(pending.drafted_by) + (pending.error ? ' · ' + esc(pending.error) : '') + '</p>' +
        '<input class="input" data-ci-subject value="' + esc(pending.subject) + '" style="width:100%;margin-bottom:8px" aria-label="Subject"><textarea class="oe-ta" data-ci-body aria-label="Message">' + esc(pending.body) + '</textarea>' +
        '<div class="oe-row" style="margin-top:8px"><button class="btn-sm" data-ci-send>Approve and send</button><button class="btn-sm ghost" data-ci-save>Save edits</button><button class="btn-sm ghost" data-ci-skip>Skip</button><span class="muted small" data-ci-out></span></div></div>' : '';
      var tl = (d.timeline || []).map(function (e) { return '<li><span class="muted">' + esc(when(e.at)) + '</span><span>' + esc(e.text) + '</span></li>'; }).join('') || '<li class="muted">Nothing yet.</li>';
      var hist = (d.history || []).slice(0, 14).reverse().map(function (h) { return '<span class="oe-band ' + esc(h.band) + '" title="' + esc(h.day) + '">' + esc(h.health) + '</span>'; }).join(' · ');
      box.innerHTML = '<div class="oe-grid"><div><div class="card"><div class="card-head"><div><h2>' + esc(name) + '</h2><p class="sub">' + esc(TYPE[d.type] || d.type) + ' since ' + esc(when(d.since_at)) + ' · ' + esc(L.email || '') + (L.ref_code ? ' · ref ' + esc(L.ref_code) : '') + '</p></div>' +
        '<div><span class="oe-band ' + esc(H.band) + '" style="font-size:28px">' + esc(H.score) + '</span> <span class="muted">' + esc(BAND[H.band] || '') + '</span></div></div>' +
        '<ul class="oe-reasons">' + reasons + '</ul>' + (hist ? '<p class="muted small">Last 14 days: ' + hist + '</p>' : '') +
        '<div class="oe-row" style="margin-top:10px"><button class="btn-sm" data-ci-new' + (pending ? ' disabled' : '') + '>Draft a check-in now</button><span class="muted small">Next scheduled: ' + esc(d.next_checkin_at ? when(d.next_checkin_at) : '–') + '</span></div></div>' + pend +
        '<div class="card" style="margin-top:14px"><h3>Log a touchpoint</h3><div class="oe-row"><select class="input" data-tp-kind>' + Object.keys(TOUCH).map(function (k) { return '<option value="' + k + '">' + esc(TOUCH[k]) + '</option>'; }).join('') + '</select><input class="input" data-tp-note placeholder="Note (optional)" style="flex:1;min-width:160px"><button class="btn-sm ghost" data-tp-add>Log</button></div><p class="muted small">Weekly sessions attended or missed feed the health score and the guarantee conditions.</p></div></div>' +
        '<div><div class="card"><h3>Onboarding checklist</h3><div class="oe-checks">' + checks + '</div></div><div class="card" style="margin-top:14px"><h3>Timeline</h3><ul class="oe-tl">' + tl + '</ul></div></div></div>';
      box.querySelectorAll('[data-ck]').forEach(function (cb) { cb.onchange = function () { post('clients/' + encodeURIComponent(id) + '/checklist', { key: cb.getAttribute('data-ck'), done: cb.checked }, 'PUT').then(function (r) { toast(r.ok ? 'Saved' : (r.error || 'Not saved')); }); }; });
      var nb = box.querySelector('[data-ci-new]');
      if (nb) nb.onclick = function () { nb.disabled = true; nb.textContent = 'Drafting…'; post('clients/' + encodeURIComponent(id) + '/checkin').then(function (r) { toast(r.ok ? 'Check-in drafted for approval' : (r.error || 'Not drafted')); clientDetail(ctx, id); }); };
      if (pending) {
        var out = box.querySelector('[data-ci-out]');
        var edits = function () { return { subject: box.querySelector('[data-ci-subject]').value, body: box.querySelector('[data-ci-body]').value }; };
        box.querySelector('[data-ci-save]').onclick = function () { post('clients/checkins/' + pending.id, edits(), 'PUT').then(function (r) { out.textContent = r.ok ? ((r.issues || []).length ? 'Saved. Copy check: ' + r.issues.join(', ') : 'Saved') : (r.error || 'Not saved'); }); };
        box.querySelector('[data-ci-send]').onclick = function (e) {
          e.target.disabled = true;
          post('clients/checkins/' + pending.id, edits(), 'PUT').then(function (r) {
            if (!r.ok) { out.textContent = r.error || 'Not saved'; e.target.disabled = false; return; }
            return post('clients/checkins/' + pending.id + '/send').then(function (s) { toast(s.summary || (s.ok ? 'Sent' : 'Not sent')); clientDetail(ctx, id); });
          });
        };
        box.querySelector('[data-ci-skip]').onclick = function () { post('clients/checkins/' + pending.id + '/skip').then(function () { toast('Skipped'); clientDetail(ctx, id); }); };
      }
      box.querySelector('[data-tp-add]').onclick = function () { post('clients/' + encodeURIComponent(id) + '/touchpoints', { kind: box.querySelector('[data-tp-kind]').value, note: box.querySelector('[data-tp-note]').value }).then(function (r) { toast(r.ok ? 'Logged' : (r.error || 'Not logged')); clientDetail(ctx, id); }); };
    });
  }

  // ───────────── Support ─────────────
  var supportState = { status: '', sel: null };
  var ST = { open: 'Open', drafted: 'Draft ready', escalated: 'Needs a person', answered: 'Answered', closed: 'Closed' };
  var CH = { email: 'Email', room: 'Masterclass room', live: 'Live room', challenge: 'Challenge', zapier: 'Zapier' };
  function renderSupport(ctx) {
    css();
    var view = ctx.view, esc = ctx.esc, when = ctx.when, tile = ctx.tile, toast = ctx.toast;
    return get('support?status=' + encodeURIComponent(supportState.status)).then(function (d) {
      var C = d.counts || {}, S = d.setup || {};
      var setupBits = [];
      if (S.ai) setupBits.push(esc(S.ai) + ' Money, refund and legal questions are still flagged for a person.');
      if (!S.canSend) setupBits.push('Replies can’t be emailed yet: add the Resend API key and a From address (Integrations → Email).');
      var rows = (d.threads || []).map(function (t) {
        return '<tr data-th="' + esc(t.id) + '"' + (supportState.sel === t.id ? ' aria-selected="true"' : '') + '><td><span class="pill' + (t.status === 'escalated' ? ' st-partial' : t.status === 'drafted' ? ' st-booked' : t.status === 'answered' ? ' st-won' : '') + '">' + esc(ST[t.status] || t.status) + '</span></td><td>' + esc(t.subject || '') + '<div class="muted small">' + esc(t.last_in || '') + '</div></td><td>' + esc(t.from_name || t.from_email || '') + '<div class="muted small">' + esc(CH[t.channel] || t.channel) + '</div></td><td class="nw">' + esc(when(t.updated_at)) + '</td></tr>';
      }).join('');
      var chips = [['', 'Active'], ['escalated', 'Needs a person'], ['drafted', 'Draft ready'], ['open', 'Open'], ['answered', 'Answered'], ['closed', 'Closed']].map(function (x) { return '<button class="btn-sm' + (supportState.status === x[0] ? '' : ' ghost') + '" data-st="' + x[0] + '">' + esc(x[1]) + '</button>'; }).join('');
      view.innerHTML = (setupBits.length ? '<div class="card"><p class="muted">' + setupBits.join('<br>') + '</p></div>' : '') +
        '<div class="grid g-4 tiles">' + tile('Needs a person', String(C.escalated || 0), 'money, refunds, legal, or low confidence') + tile('Drafts ready', String(C.drafted || 0), 'waiting for approval') + tile('Open', String(C.open || 0), 'no draft yet') + tile('Answered', String(C.answered || 0), 'all time') + '</div>' +
        '<div class="card" style="margin-top:14px"><div class="card-head"><div><h2>Inbox</h2><p class="sub">Email, masterclass and live room questions, and challenge hot seats. Claude drafts from our guides, materials, the guarantee, the FAQ and the offer terms, with sources. Confidence under ' + esc(S.minConfidence) + ' goes to a person.</p></div><button class="btn-sm ghost" data-sp-process>Check for new questions</button></div>' +
        '<div class="oe-row" style="margin-bottom:10px">' + chips + '</div>' +
        (rows ? '<div class="table-wrap"><table class="oe-list"><thead><tr><th>Status</th><th>Question</th><th>From</th><th>Updated</th></tr></thead><tbody>' + rows + '</tbody></table></div>' : ctx.emptyState('Nothing here.', 'Questions from the rooms come in automatically; connect email below.')) + '</div>' +
        '<div data-sp-detail></div>' +
        '<div class="grid g-2" style="margin-top:14px"><div class="card"><h3>Connect email</h3><p class="sub">Resend inbound: press Connect (creates the email.received webhook to ' + esc(S.urls.resend) + '), then add a receiving domain or use your .resend.app address in Resend → Emails → Receiving, and forward support@ to it.' + (S.resendInbound ? ' <b>Connected.</b>' : '') + '</p><div class="oe-row"><button class="btn-sm" data-sp-connect>Connect support inbox</button></div>' +
        '<p class="sub" style="margin-top:12px">Any other forwarder (Zapier, Make, a Cloudflare Email Worker) can POST JSON {from, subject, text, html, message_id} to <span class="mono">' + esc(S.urls.forward) + '</span> with the X-Support-Secret header (generate it under Integrations → Zapier &amp; webhooks).' + (S.forwarding ? ' <b>Secret set.</b>' : '') + '</p></div>' +
        '<div class="card"><h3>Try a question</h3><p class="sub">Stored as an email thread from that address and drafted now. Nothing is sent.</p><input class="input" data-tq-from placeholder="owner@example.com" style="width:100%;margin-bottom:6px"><input class="input" data-tq-subject placeholder="Subject" style="width:100%;margin-bottom:6px"><textarea class="oe-ta" data-tq-text style="min-height:90px" placeholder="How does seller rollover work if the seller wants cash at close?"></textarea><div class="oe-row" style="margin-top:6px"><button class="btn-sm ghost" data-tq-go>Draft an answer</button></div></div></div>';
      view.querySelectorAll('[data-st]').forEach(function (b) { b.onclick = function () { supportState.status = b.getAttribute('data-st'); ctx.reload(); }; });
      view.querySelector('[data-sp-process]').onclick = function (e) { e.target.disabled = true; post('support/process').then(function (r) { toast((r.added || 0) + ' new, ' + (r.drafted || 0) + ' drafted, ' + (r.escalated || 0) + ' escalated'); ctx.reload(); }); };
      view.querySelector('[data-sp-connect]').onclick = function () { post('support/connect').then(function (r) { toast(r.ok ? 'Connected' : (r.error || 'Not connected')); if (r.ok) ctx.reload(); }); };
      view.querySelector('[data-tq-go]').onclick = function (e) {
        e.target.disabled = true; e.target.textContent = 'Drafting…';
        post('support/test', { from: view.querySelector('[data-tq-from]').value, subject: view.querySelector('[data-tq-subject]').value, text: view.querySelector('[data-tq-text]').value }).then(function (r) {
          if (!r.ok) { toast(r.error || 'Not stored'); e.target.disabled = false; e.target.textContent = 'Draft an answer'; return; }
          supportState.sel = r.threadId; supportState.status = ''; ctx.reload();
        });
      };
      view.querySelectorAll('[data-th]').forEach(function (tr) { tr.onclick = function () { supportState.sel = tr.getAttribute('data-th'); view.querySelectorAll('[data-th]').forEach(function (x) { x.setAttribute('aria-selected', String(x === tr)); }); threadDetail(ctx, supportState.sel); }; });
      if (supportState.sel) threadDetail(ctx, supportState.sel);
    });
  }

  function threadDetail(ctx, id) {
    var esc = ctx.esc, when = ctx.when, toast = ctx.toast;
    var box = ctx.view.querySelector('[data-sp-detail]');
    if (!box) return;
    box.innerHTML = '<div class="card" style="margin-top:14px">Loading…</div>';
    get('support/threads/' + encodeURIComponent(id)).then(function (d) {
      if (d.error) { box.innerHTML = ''; return; }
      var t = d.thread, draft = (d.drafts || []).filter(function (x) { return x.status === 'draft'; })[0];
      var msgs = (d.messages || []).map(function (m) { return '<div class="oe-msg ' + (m.direction === 'out' ? 'out' : '') + '"><span class="muted">' + esc(m.direction === 'out' ? 'Team' + (m.sent_by === 'auto' ? ' (auto)' : '') : (t.from_name || t.from_email || 'Viewer')) + ' · ' + esc(when(m.created_at)) + '</span>' + esc(m.body) + '</div>'; }).join('');
      var cites = draft && draft.citations && draft.citations.length ? '<div class="oe-cites small">Sources: ' + draft.citations.map(function (c) { return c.url ? '<a href="' + esc(c.url) + '" target="_blank" rel="noopener">' + esc(c.title) + '</a>' : '<span>' + esc(c.title) + '</span>'; }).join(' ') + '</div>' : '';
      var esc1 = t.escalated && t.escalate_reason ? '<div class="oe-esc"><b>Needs a person:</b> ' + esc(t.escalate_reason) + '</div>' : '';
      var draftBox = '<h3>' + (draft ? 'Draft reply' + (draft.confidence != null ? ' <span class="muted small">confidence ' + esc(Number(draft.confidence).toFixed(2)) + ' · ' + esc(draft.model || '') + '</span>' : '') : 'Reply') + '</h3>' + esc1 + cites +
        '<textarea class="oe-ta" data-dr-body aria-label="Reply">' + esc(draft ? draft.body : '') + '</textarea>' +
        '<div class="oe-row" style="margin-top:8px"><button class="btn-sm" data-dr-send>' + (t.channel === 'room' && !t.from_email ? 'Approve and post in the room' : 'Approve and send') + '</button>' + (draft ? '<button class="btn-sm ghost" data-dr-save>Save edits</button>' : '') + '<button class="btn-sm ghost" data-dr-redraft>Redraft with Claude</button>' + (draft ? '<button class="btn-sm ghost" data-dr-discard>Discard draft</button>' : '') +
        '<button class="btn-sm ghost" data-th-close>' + (t.status === 'closed' ? 'Reopen' : 'Close thread') + '</button><span class="muted small" data-dr-out></span></div>';
      box.innerHTML = '<div class="card" style="margin-top:14px"><div class="card-head"><div><h2>' + esc(t.subject || '') + '</h2><p class="sub">' + esc(CH[t.channel] || t.channel) + ' · ' + esc(t.from_email || t.from_name || '') + (t.lead_id ? ' · lead ' + esc(t.ref_code || t.lead_id) : ' · not matched to a lead') + '</p></div></div>' + msgs + '<div style="margin-top:12px">' + draftBox + '</div></div>';
      var out = box.querySelector('[data-dr-out]');
      var bodyEl = box.querySelector('[data-dr-body]');
      box.querySelector('[data-dr-send]').onclick = function (e) {
        e.target.disabled = true;
        var p = draft ? post('support/drafts/' + draft.id + '/send', { body: bodyEl.value }) : post('support/threads/' + id + '/reply', { body: bodyEl.value });
        p.then(function (r) { toast(r.summary || (r.ok ? 'Sent' : 'Not sent')); if (r.ok) ctx.reload(); else e.target.disabled = false; });
      };
      var sv = box.querySelector('[data-dr-save]');
      if (sv) sv.onclick = function () { post('support/drafts/' + draft.id, { body: bodyEl.value }, 'PUT').then(function (r) { out.textContent = r.ok ? 'Saved' : 'Not saved'; }); };
      box.querySelector('[data-dr-redraft]').onclick = function (e) { e.target.disabled = true; e.target.textContent = 'Drafting…'; post('support/threads/' + id + '/draft').then(function (r) { toast(r.note === 'no API key' ? 'Add the Anthropic API key to draft with Claude' : r.escalated ? 'Drafted; needs a person' : 'Drafted'); threadDetail(ctx, id); }); };
      var dc = box.querySelector('[data-dr-discard]');
      if (dc) dc.onclick = function () { post('support/drafts/' + draft.id + '/discard').then(function () { threadDetail(ctx, id); }); };
      box.querySelector('[data-th-close]').onclick = function () { post('support/threads/' + id + '/status', { status: t.status === 'closed' ? 'open' : 'closed' }).then(function () { ctx.reload(); }); };
    });
  }

  // ───────────── Integrations: Claude (MCP), Zapier & webhooks ─────────────
  function renderAutomations(el, ctx) {
    css();
    var esc = ctx.esc, when = ctx.when, toast = ctx.toast;
    return get('automations').then(function (d) {
      var M = d.mcp, Z = d.zapier;
      var evBoxes = Object.keys(d.events).map(function (k) { return '<label><input type="checkbox" value="' + esc(k) + '" data-ev> <span class="mono">' + esc(k) + '</span></label>'; }).join('');
      var subs = (d.subscriptions || []).map(function (s) {
        return '<tr><td>' + esc(s.label || '') + '<div class="mono small">' + esc(s.url) + '</div></td><td class="small">' + esc((s.events || []).join(', ')) + '</td><td class="nw">' + (s.active ? '<span class="pill st-won">On</span>' : '<span class="pill">Off</span>') + (s.last_status ? ' <span class="muted small">last ' + esc(s.last_status) + ' ' + esc(when(s.last_at)) + '</span>' : '') + '</td>' +
          '<td class="nw"><button class="btn-sm ghost" data-hs-test="' + esc(s.id) + '">Send test</button> <button class="btn-sm ghost" data-hs-toggle="' + esc(s.id) + '" data-on="' + (s.active ? 1 : 0) + '">' + (s.active ? 'Pause' : 'Resume') + '</button> <button class="btn-sm ghost" data-hs-rotate="' + esc(s.id) + '">New secret</button> <button class="btn-sm ghost" data-hs-del="' + esc(s.id) + '">Remove</button></td></tr>';
      }).join('');
      var dels = (d.deliveries || []).slice(0, 15).map(function (x) { return '<tr><td class="mono small">' + esc(x.event) + '</td><td>' + esc(x.status) + (x.last_error ? ' <span class="muted small">' + esc(x.last_error) + '</span>' : '') + '</td><td class="num">' + esc(x.attempts) + '</td><td class="nw">' + esc(when(x.delivered_at || x.created_at)) + '</td></tr>'; }).join('');
      var url = M.url;
      el.innerHTML = '<div class="card" style="margin-top:14px" id="int-mcp"><div class="card-head"><div><h2>Claude (MCP connector)</h2><p class="sub">Ask Claude about leads, calls, deals, ads, webinars, the Sprint board, client health and support, in Claude’s own apps. Write tools only create approvals here; nothing is sent or changed until you approve it.</p></div>' +
        (M.locked ? '<span class="muted small">Token set as a Worker secret</span>' : '<button class="btn-sm" data-mcp-gen>' + (M.tokenSet ? 'Generate new token' : 'Generate token') + '</button>') + '</div>' +
        '<p>Server URL: <span class="mono">' + esc(url) + '</span> · Token: ' + (M.tokenSet ? '<span class="mono">' + esc(M.token) + '</span>' : '<b>not set (the server is off)</b>') + '</p><div data-mcp-secret></div>' +
        '<details><summary>How to connect</summary><p><b>Claude Code</b> (terminal):</p><div class="oe-code">claude mcp add --transport http funnel-hq ' + esc(url) + ' --header "Authorization: Bearer &lt;token&gt;"</div>' +
        '<p><b>Claude Desktop</b>: Settings → Connectors → Add custom connector with the secret URL below, or in claude_desktop_config.json:</p><div class="oe-code">{ "mcpServers": { "funnel-hq": { "command": "npx", "args": ["-y", "mcp-remote", "' + esc(url) + '", "--header", "Authorization: Bearer &lt;token&gt;"] } } }</div>' +
        '<p><b>claude.ai</b>: Settings → Connectors → Add custom connector (on Team and Enterprise plans an owner adds it for the organisation). claude.ai connectors can’t send a token header, so paste the secret URL. Anyone with it can read your funnel data, so treat it like a password; generating a new token changes it.</p><div class="oe-code">' + esc(url) + '/k/&lt;token&gt;</div></details>' +
        '<details><summary>' + esc(M.tools.length) + ' tools</summary><p class="small">' + M.tools.map(function (t) { return '<span class="mono">' + esc(t.name) + '</span>' + (t.write ? ' (creates an approval)' : ''); }).join(' · ') + '</p></details></div>' +
        '<div class="card" style="margin-top:14px" id="int-zapier"><div class="card-head"><div><h2>Zapier &amp; webhooks</h2><p class="sub">Send funnel events to a Zapier “Catch Hook” (or Make, n8n). Each POST is JSON {id, event, created_at, data}, signed with X-Funnel-Signature: t=&lt;unix&gt;,v1=HMAC-SHA256(secret, "t.body"). Failed deliveries retry after 1 min, 5 min, 30 min, 2 h, 6 h and 24 h; a 410 response turns the hook off.</p></div></div>' +
        (subs ? '<div class="table-wrap"><table><thead><tr><th>Hook</th><th>Events</th><th>Status</th><th></th></tr></thead><tbody>' + subs + '</tbody></table></div>' : '<p class="muted">No hooks yet.</p>') +
        '<div data-hs-secret></div><h3 style="margin-top:12px">Add a hook</h3><div class="oe-row"><input class="input" data-hs-url placeholder="https://hooks.zapier.com/hooks/catch/…" style="flex:2;min-width:220px"><input class="input" data-hs-label placeholder="Label (optional)" style="flex:1;min-width:120px"></div><div class="oe-events" style="margin:8px 0">' + evBoxes + '</div><button class="btn-sm" data-hs-add>Add hook</button>' +
        (dels ? '<details style="margin-top:12px"><summary>Recent deliveries</summary><div class="table-wrap"><table><thead><tr><th>Event</th><th>Status</th><th class="num">Attempts</th><th>When</th></tr></thead><tbody>' + dels + '</tbody></table></div></details>' : '') +
        '<h3 style="margin-top:16px">Actions from Zapier</h3><p class="sub">POST JSON with the header X-Zapier-Secret. create-lead: {email, first_name, last_name, phone, source, note}. add-note: {email or lead_id or ref, note}.</p><p>' + Z.actions.map(function (a) { return '<span class="mono">' + esc(a.url) + '</span>'; }).join('<br>') + '</p>' +
        '<div class="oe-row"><span>Secret: ' + (Z.secretSet ? '<span class="mono">' + esc(Z.secret) + '</span>' : '<b>not set (actions are off)</b>') + '</span><button class="btn-sm ghost" data-sec="zapier">' + (Z.secretSet ? 'New secret' : 'Generate secret') + '</button>' +
        '<span>Support forwarding secret: ' + (d.support.forwardSecretSet ? 'set' : '<b>not set</b>') + '</span><button class="btn-sm ghost" data-sec="support">' + (d.support.forwardSecretSet ? 'New secret' : 'Generate secret') + '</button></div><div data-sec-out></div></div>';
      var showSecret = function (box, label, value) { box.innerHTML = '<div class="oe-secret"><b>' + esc(label) + '</b> (shown once; copy it now)<div class="oe-code">' + esc(value) + '</div><button class="btn-sm ghost" data-copylink="' + esc(value) + '">Copy</button></div>'; };
      var gen = el.querySelector('[data-mcp-gen]');
      if (gen) gen.onclick = function () {
        if (M.tokenSet && !confirm('Generate a new token? Every Claude connection using the old one stops working.')) return;
        post('automations/secret/mcp').then(function (r) { if (!r.ok) { toast(r.error || 'Not generated'); return; } showSecret(el.querySelector('[data-mcp-secret]'), 'MCP token', r.value); el.querySelector('[data-mcp-secret]').insertAdjacentHTML('beforeend', '<div class="oe-code">' + esc(url + '/k/' + r.value) + '</div>'); });
      };
      el.querySelectorAll('[data-sec]').forEach(function (b) { b.onclick = function () { post('automations/secret/' + b.getAttribute('data-sec')).then(function (r) { if (r.ok) showSecret(el.querySelector('[data-sec-out]'), r.key, r.value); else toast(r.error || 'Not generated'); }); }; });
      el.querySelector('[data-hs-add]').onclick = function () {
        var events = [].map.call(el.querySelectorAll('[data-ev]:checked'), function (x) { return x.value; });
        post('automations/subscriptions', { url: el.querySelector('[data-hs-url]').value, label: el.querySelector('[data-hs-label]').value, events: events }).then(function (r) {
          if (!r.ok) { toast(r.error || 'Not added'); return; }
          renderAutomations(el, ctx).then(function () { showSecret(el.querySelector('[data-hs-secret]'), 'Signing secret for the new hook', r.secret); });
        });
      };
      el.querySelectorAll('[data-hs-test]').forEach(function (b) { b.onclick = function () { b.disabled = true; post('automations/subscriptions/' + b.getAttribute('data-hs-test') + '/test').then(function (r) { toast(r.ok ? 'Delivered (' + r.status + ')' : 'Failed: ' + (r.error || r.status)); renderAutomations(el, ctx); }); }; });
      el.querySelectorAll('[data-hs-toggle]').forEach(function (b) { b.onclick = function () { post('automations/subscriptions/' + b.getAttribute('data-hs-toggle'), { active: b.getAttribute('data-on') !== '1' }, 'PUT').then(function () { renderAutomations(el, ctx); }); }; });
      el.querySelectorAll('[data-hs-rotate]').forEach(function (b) { b.onclick = function () { post('automations/subscriptions/' + b.getAttribute('data-hs-rotate') + '/rotate').then(function (r) { showSecret(el.querySelector('[data-hs-secret]'), 'New signing secret', r.secret); }); }; });
      el.querySelectorAll('[data-hs-del]').forEach(function (b) { b.onclick = function () { if (confirm('Remove this hook?')) post('automations/subscriptions/' + b.getAttribute('data-hs-del'), {}, 'DELETE').then(function () { renderAutomations(el, ctx); }); }; });
    });
  }

  root.ClientsBoard = { render: renderClients };
  root.SupportBoard = { render: renderSupport };
  root.AutomationsPanel = { render: renderAutomations };
})(window);
