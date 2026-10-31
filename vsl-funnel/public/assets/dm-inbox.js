/* Funnel HQ → DM inbox: the Instagram DM sales inbox (Meta's official Instagram API only).
   Priority inbox with the thread, lead profile, status, assignee, tags, team notes, the messaging window,
   reply box with scripts and AI drafts; the control center (results, tasks, setters, bulk reassign);
   scripts library with analytics; keyword triggers; and the connect card used on Integrations.
   Loaded before admin.js, which calls DmInbox.render(ctx) and DmInbox.integrationCard(el, ctx). */
(function (root) {
  'use strict';
  var CSS = '' +
    '.dmx-sub{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px}' +
    '.dmx-sub button{border:0;background:var(--surface-2);color:var(--ink-2);border-radius:999px;padding:6px 14px;font:600 13px var(--font);cursor:pointer}' +
    '.dmx-sub button[aria-pressed="true"]{background:var(--ink);color:var(--plane)}' +
    '.dmx-me{margin-left:auto;display:flex;gap:6px;align-items:center;font-size:13px;color:var(--muted)}' +
    '.dmx{display:grid;grid-template-columns:minmax(280px,380px) 1fr;gap:0;background:var(--surface);border-radius:12px;min-height:640px;overflow:hidden;box-shadow:0 0 0 1px var(--border)}' +
    '.dmx-list{border-right:1px solid var(--border);display:flex;flex-direction:column;min-width:0}' +
    '.dmx-tools{padding:10px;display:grid;gap:8px;border-bottom:1px solid var(--border)}' +
    '.dmx-tools .row{display:flex;gap:6px;flex-wrap:wrap}.dmx-tools select,.dmx-tools input{flex:1;min-width:0}' +
    '.dmx-rows{overflow:auto;flex:1;max-height:72vh}' +
    '.dmx-row{display:grid;grid-template-columns:20px 1fr auto;gap:4px 8px;padding:10px 12px;border-bottom:1px solid var(--border);cursor:pointer;transition:background .15s}' +
    '.dmx-row:hover{background:var(--surface-2)}.dmx-row.on{background:var(--surface-2);box-shadow:inset 3px 0 0 #0f2c5c}' +
    '.dmx-row .nm{font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dmx-row .pv{grid-column:2/4;color:var(--ink-2);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.dmx-row .meta{grid-column:2/4;display:flex;gap:6px;flex-wrap:wrap;font-size:12px;color:var(--muted)}.dmx-row .unread{font-weight:800;color:var(--ink)}' +
    '.dmx-b{display:inline-block;border-radius:999px;padding:0 8px;font-size:11.5px;font-weight:700;line-height:18px}' +
    '.dmx-b.hot{background:#fde7e4;color:#9b1c10}.dmx-b.warm{background:#fff4d6;color:#7a5200}.dmx-b.cold{background:#e8eef7;color:#0f2c5c}.dmx-b.junk{background:#eee;color:#666}.dmx-b.closing{background:#e3f4e3;color:#0b5d0b}' +
    '.dmx-b.win-open{background:#e3f4e3;color:#0b5d0b}.dmx-b.win-soon{background:#fff4d6;color:#7a5200}.dmx-b.win-closed{background:#eee;color:#666}.dmx-b.win-human{background:#e8eef7;color:#0f2c5c}' +
    '.dmx-bulk{display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding:8px 10px;background:#0f2c5c;color:#fff;font-size:13px}.dmx-bulk select,.dmx-bulk input{max-width:150px}' +
    '.dmx-thread{display:grid;grid-template-columns:1fr minmax(240px,300px);min-width:0}' +
    '.dmx-main{display:flex;flex-direction:column;min-width:0;border-right:1px solid var(--border)}' +
    '.dmx-head{padding:12px 16px;border-bottom:1px solid var(--border);display:grid;gap:8px}.dmx-head h2{margin:0;font-size:17px}' +
    '.dmx-ctl{display:flex;gap:6px;flex-wrap:wrap}.dmx-ctl select,.dmx-ctl input{font-size:13px}' +
    '.dmx-msgs{flex:1;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:8px;max-height:52vh;background:var(--plane)}' +
    '.dmx-m{max-width:78%;padding:8px 12px;border-radius:16px;font-size:14px;white-space:pre-wrap;word-wrap:break-word}' +
    '.dmx-m.in{align-self:flex-start;background:var(--surface);box-shadow:0 0 0 1px var(--border)}.dmx-m.out{align-self:flex-end;background:#0f2c5c;color:#fff}' +
    '.dmx-m.failed{background:#fde7e4;color:#9b1c10}.dmx-m small{display:block;opacity:.7;font-size:11px;margin-top:2px}' +
    '.dmx-reply{border-top:1px solid var(--border);padding:10px 12px;display:grid;gap:8px}.dmx-reply textarea{width:100%;min-height:76px;box-sizing:border-box;resize:vertical;font:14px/1.45 var(--font)}' +
    '.dmx-reply .row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}' +
    '.dmx-side{padding:12px 14px;display:grid;gap:14px;align-content:start;overflow:auto;max-height:80vh}.dmx-side h3{margin:0 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}' +
    '.dmx-side dl{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;margin:0;font-size:13px}.dmx-side dt{color:var(--muted)}.dmx-side dd{margin:0;word-break:break-word}' +
    '.dmx-note{font-size:13px;padding:6px 0;border-top:1px solid var(--border);white-space:pre-wrap}.dmx-note b{font-weight:650}.dmx-note.system{color:var(--muted)}.dmx-note.summary{background:var(--surface-2);padding:8px;border-radius:8px;border:0}' +
    '.dmx-empty{display:grid;place-items:center;color:var(--muted);padding:40px;text-align:center}' +
    '.dmx-back{display:none}.dmx-tasks li{margin:4px 0}.dmx-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;align-items:end}.dmx-form label{display:grid;gap:4px;font-size:13px}.dmx-form textarea{min-height:64px}' +
    '@media (max-width:900px){.dmx{grid-template-columns:1fr;min-height:0}.dmx-thread{display:none;grid-template-columns:1fr}.dmx.show .dmx-list{display:none}.dmx.show .dmx-thread{display:grid}' +
    '.dmx-main{border-right:0}.dmx-back{display:inline-block}.dmx-msgs{max-height:none;min-height:40vh}.dmx-m{max-width:88%}.dmx-rows{max-height:none}.dmx-side{max-height:none;border-top:1px solid var(--border)}}';

  var S = { sub: 'inbox', view: 'open', band: '', assignee: '', q: '', sel: {}, open: null, status: null };
  var store = { get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private window */ } } };
  var STATUS_LABEL = { new: 'New', replied: 'Replied', qualified: 'Qualified', booked: 'Booked', showed: 'Showed', closed: 'Closed', lost: 'Lost' };

  function css() { if (!document.getElementById('dmx-css')) { var st = document.createElement('style'); st.id = 'dmx-css'; st.textContent = CSS; document.head.appendChild(st); } }
  function me() { return store.get('dmx-me') || ''; }
  function ago(ms) { if (!ms) return ''; var m = Math.round((Date.now() - ms) / 60000); if (m < 60) return Math.max(1, m) + 'm'; var h = Math.round(m / 60); if (h < 48) return h + 'h'; return Math.round(h / 24) + 'd'; }
  function bandPill(esc, b) { return b ? '<span class="dmx-b ' + esc(b) + '">' + esc(b.charAt(0).toUpperCase() + b.slice(1)) + '</span>' : ''; }
  function winPill(esc, w) {
    if (!w) return '';
    var cls = w.mode === 'closed' ? 'win-closed' : w.mode === 'human_agent' ? 'win-human' : w.ms_left < 3 * 3600000 ? 'win-soon' : 'win-open';
    return '<span class="dmx-b ' + cls + '" title="Meta allows replies for 24 hours after their last message">' + esc(w.label) + '</span>';
  }
  function repOptions(esc, reps, sel, none) {
    return '<option value="">' + esc(none || 'Unassigned') + '</option>' + reps.map(function (r) { return '<option value="' + esc(r.id) + '"' + (r.id === sel ? ' selected' : '') + '>' + esc(r.name) + (r.role !== 'setter' ? ' (' + esc(r.role) + ')' : '') + '</option>'; }).join('');
  }
  function statusOptions(esc, sel) { return Object.keys(STATUS_LABEL).map(function (s) { return '<option value="' + s + '"' + (s === sel ? ' selected' : '') + '>' + STATUS_LABEL[s] + '</option>'; }).join(''); }

  function render(ctx) {
    css();
    var view = ctx.view, esc = ctx.esc;
    return ctx.api('dm/status', {}, { noRange: true }).then(function (st) {
      S.status = st;
      var subs = [['inbox', 'Inbox'], ['control', 'Control center'], ['scripts', 'Scripts'], ['triggers', 'Keyword triggers'], ['connect', 'Connect']];
      view.innerHTML = '<div class="dmx-sub" role="tablist">' + subs.map(function (s) { return '<button type="button" data-dmx-sub="' + s[0] + '" aria-pressed="' + (S.sub === s[0]) + '">' + s[1] + '</button>'; }).join('') +
        '<label class="dmx-me">Sending as <select class="input" data-dmx-me>' + repOptions(esc, st.reps, me(), 'Pick your name') + '</select></label></div>' +
        (st.configured ? '' : '<div class="card notice" style="margin-bottom:14px">Instagram is not connected yet. Open Connect to add the token and switch on webhooks. Conversations appear here as soon as Meta sends them.</div>') +
        '<div data-dmx-body></div>';
      view.querySelectorAll('[data-dmx-sub]').forEach(function (b) { b.onclick = function () { S.sub = b.getAttribute('data-dmx-sub'); render(ctx); }; });
      view.querySelector('[data-dmx-me]').onchange = function () { store.set('dmx-me', this.value); };
      var body = view.querySelector('[data-dmx-body]');
      if (S.sub === 'control') return control(ctx, body);
      if (S.sub === 'scripts') return scripts(ctx, body);
      if (S.sub === 'triggers') return triggers(ctx, body);
      if (S.sub === 'connect') return integrationCard(body, ctx);
      return inbox(ctx, body);
    });
  }

  // ───────────── Inbox ─────────────
  function inbox(ctx, box) {
    var esc = ctx.esc, st = S.status;
    box.innerHTML = '<div class="dmx' + (S.open ? ' show' : '') + '"><div class="dmx-list"><div class="dmx-tools">' +
      '<div class="seg" role="group" aria-label="Conversations">' + [['open', 'Open'], ['waiting', 'Waiting'], ['all', 'All'], ['done', 'Closed / lost'], ['junk', 'Junk']].map(function (v) { return '<button type="button" data-dmx-view="' + v[0] + '" aria-pressed="' + (S.view === v[0]) + '">' + v[1] + '</button>'; }).join('') + '</div>' +
      '<div class="row"><select class="input" data-dmx-band aria-label="Score"><option value="">Hot, warm and cold</option><option value="hot">Hot</option><option value="warm">Warm</option><option value="cold">Cold</option></select>' +
      '<select class="input" data-dmx-assignee aria-label="Assignee"><option value="">Everyone</option><option value="none">Unassigned</option>' + st.reps.map(function (r) { return '<option value="' + esc(r.id) + '">' + esc(r.name) + '</option>'; }).join('') + '</select></div>' +
      '<input class="input" type="search" placeholder="Search name, handle or message" data-dmx-q value="' + esc(S.q) + '"></div>' +
      '<div data-dmx-bulk></div><div class="dmx-rows" data-dmx-rows><div class="dmx-empty">Loading</div></div></div>' +
      '<div class="dmx-thread" data-dmx-thread><div class="dmx-empty">Pick a conversation. The list is sorted by score and how long they have waited.</div></div></div>';
    var shell = box.querySelector('.dmx');
    box.querySelector('[data-dmx-band]').value = S.band;
    box.querySelector('[data-dmx-assignee]').value = S.assignee;
    box.querySelectorAll('[data-dmx-view]').forEach(function (b) { b.onclick = function () { S.view = b.getAttribute('data-dmx-view'); inbox(ctx, box); }; });
    box.querySelector('[data-dmx-band]').onchange = function () { S.band = this.value; loadList(); };
    box.querySelector('[data-dmx-assignee]').onchange = function () { S.assignee = this.value; loadList(); };
    var qt; box.querySelector('[data-dmx-q]').oninput = function () { var v = this.value; clearTimeout(qt); qt = setTimeout(function () { S.q = v; loadList(); }, 250); };

    function loadList() {
      return ctx.api('dm/threads', { view: S.view, band: S.band, assignee: S.assignee, q: S.q }, { noRange: true }).then(function (d) {
        var rows = box.querySelector('[data-dmx-rows]');
        if (!d.threads.length) { rows.innerHTML = '<div class="dmx-empty">' + (st.counts && st.counts.threads ? 'Nothing here with these filters.' : 'No conversations yet. Connect Instagram, then import the last 30 days.') + '</div>'; bulkBar(); return; }
        rows.innerHTML = d.threads.map(function (t) {
          var nm = t.name || (t.username ? '@' + t.username : 'Instagram user');
          var rep = st.reps.filter(function (r) { return r.id === t.assignee_id; })[0];
          return '<div class="dmx-row' + (S.open === t.id ? ' on' : '') + '" data-dmx-open="' + esc(t.id) + '"><input type="checkbox" aria-label="Select" data-dmx-sel="' + esc(t.id) + '"' + (S.sel[t.id] ? ' checked' : '') + '>' +
            '<span class="nm' + (t.unread ? ' unread' : '') + '">' + esc(nm) + '</span><span class="muted" style="font-size:12px">' + esc(ago(t.last_message_at)) + '</span>' +
            '<span class="pv">' + esc(t.last_preview || '') + '</span>' +
            '<span class="meta">' + bandPill(esc, t.ai_flag === 'junk' ? 'junk' : t.band) + (t.ai_flag === 'closing' ? '<span class="dmx-b closing">About to close</span>' : '') +
            (t.waiting ? '<span>waiting ' + esc(ago(Date.now() - t.waiting_min * 60000)) + '</span>' : '') + winPill(esc, t.window) +
            '<span>' + esc(STATUS_LABEL[t.status] || t.status) + '</span><span>' + esc(rep ? rep.name : 'Unassigned') + '</span>' +
            t.tags.map(function (g) { return '<span>#' + esc(g) + '</span>'; }).join('') + '</span></div>';
        }).join('');
        rows.querySelectorAll('[data-dmx-sel]').forEach(function (c) {
          c.onclick = function (ev) { ev.stopPropagation(); if (c.checked) S.sel[c.getAttribute('data-dmx-sel')] = true; else delete S.sel[c.getAttribute('data-dmx-sel')]; bulkBar(); };
        });
        rows.querySelectorAll('[data-dmx-open]').forEach(function (r) { r.onclick = function () { openThread(r.getAttribute('data-dmx-open')); }; });
        bulkBar();
      });
    }

    function bulkBar() {
      var ids = Object.keys(S.sel), el = box.querySelector('[data-dmx-bulk]');
      if (!ids.length) { el.innerHTML = ''; return; }
      el.innerHTML = '<div class="dmx-bulk"><b>' + ids.length + ' selected</b><select class="input" data-b-assign><option value="-">Assign to</option>' + repOptions(esc, st.reps, null, 'Nobody') + '</select>' +
        '<select class="input" data-b-status><option value="">Status</option>' + statusOptions(esc, null) + '</select><input class="input" data-b-tag placeholder="Add tag">' +
        '<button class="btn-sm" type="button" data-b-go>Apply</button><button class="btn-sm ghost" type="button" data-b-clear>Clear</button></div>';
      el.querySelector('[data-b-clear]').onclick = function () { S.sel = {}; loadList(); };
      el.querySelector('[data-b-go]').onclick = function () {
        var a = el.querySelector('[data-b-assign]').value, s = el.querySelector('[data-b-status]').value, g = el.querySelector('[data-b-tag]').value;
        var payload = { ids: ids, actor: me() };
        if (a !== '-') payload.assignee_id = a || null;
        if (s) payload.status = s;
        if (g) payload.tag = g;
        ctx.send('POST', 'dm/bulk', payload).then(function (r) { ctx.toast(r.ok ? 'Updated ' + r.updated + ' conversations' : (r.error || 'Failed')); S.sel = {}; loadList(); });
      };
    }

    function openThread(id) {
      S.open = id;
      shell.classList.add('show');
      box.querySelectorAll('.dmx-row').forEach(function (r) { r.classList.toggle('on', r.getAttribute('data-dmx-open') === id); });
      var pane = box.querySelector('[data-dmx-thread]');
      pane.innerHTML = '<div class="dmx-empty">Loading</div>';
      Promise.all([ctx.api('dm/threads/' + encodeURIComponent(id), {}, { noRange: true }), ctx.api('dm/scripts', {}, { noRange: true })]).then(function (res) { threadView(pane, res[0], res[1]); });
      ctx.send('PATCH', 'dm/threads/' + encodeURIComponent(id), { unread: 0 });
    }

    function threadView(pane, d, sc) {
      var t = d.thread, nm = t.name || (t.username ? '@' + t.username : 'Instagram user');
      var scriptsActive = sc.scripts.filter(function (s) { return s.active; });
      var msgs = d.messages.map(function (m) {
        var who = m.direction === 'in' ? '' : m.sent_by === 'trigger' ? 'Keyword trigger' : m.sent_by === 'assistant' ? 'Automated assistant' : m.sent_by === 'instagram' ? 'Sent from Instagram' : ((st.reps.filter(function (r) { return r.id === m.sent_by; })[0] || {}).name || 'Team');
        var kind = m.kind !== 'text' ? m.kind.replace('_', ' ') : '';
        return '<div class="dmx-m ' + m.direction + (m.status === 'failed' ? ' failed' : '') + '">' + esc(m.body || '[' + (kind || 'attachment') + ']') +
          (m.media_url ? '<br><a href="' + esc(m.media_url) + '" target="_blank" rel="noopener noreferrer">media</a>' : '') +
          '<small>' + esc([kind, who, m.tag === 'HUMAN_AGENT' ? 'human agent tag' : '', m.ai_drafted ? 'AI draft' : '', m.status === 'failed' ? 'not sent: ' + (m.error || '') : '', ctx.when(m.ts)].filter(Boolean).join(' · ')) + '</small></div>';
      }).join('') || '<div class="dmx-empty">No messages yet.</div>';
      var notes = d.notes.map(function (n) { return '<div class="dmx-note ' + esc(n.kind) + '">' + (n.author ? '<b>' + esc(n.author) + '</b> ' : '') + '<span class="muted">' + esc(ctx.when(n.ts)) + '</span><br>' + esc(n.body) + '</div>'; }).join('') || '<p class="muted">No notes yet.</p>';
      var L = d.lead;
      var leadBox = L ? '<dl><dt>Lead</dt><dd><a href="#lead=' + esc(L.id) + '">' + esc(L.name || L.email || L.ref) + '</a></dd><dt>Status</dt><dd>' + esc(L.status) + '</dd><dt>Tier</dt><dd>' + esc(L.tier || '-') + '</dd>' +
        '<dt>Revenue</dt><dd>' + esc(L.revenue_band || t.revenue_band || '-') + '</dd><dt>Industry</dt><dd>' + esc(L.industry || '-') + '</dd>' + (L.call_at ? '<dt>Call</dt><dd>' + esc(ctx.when(L.call_at)) + '</dd>' : '') +
        '<dt>Source</dt><dd>' + esc(L.source || '-') + '</dd><dt>Matched by</dt><dd>' + esc(t.lead_match || '-') + '</dd></dl><button class="btn-sm ghost" type="button" data-unlink>Unlink</button>'
        : '<p class="muted small">Not linked to a lead yet. It links itself when they share an email or phone number, or apply through the DM link.</p><input class="input" placeholder="Find a lead by name, email or ref" data-lead-q><div data-lead-res></div>';
      pane.innerHTML = '<div class="dmx-main"><div class="dmx-head"><div class="row" style="gap:8px;align-items:center;flex-wrap:wrap"><button class="btn-sm ghost dmx-back" type="button" data-back>Back</button><h2>' + esc(nm) + '</h2>' +
        (t.username ? '<a class="muted" href="https://www.instagram.com/' + encodeURIComponent(t.username) + '/" target="_blank" rel="noopener noreferrer">@' + esc(t.username) + '</a>' : '') + bandPill(esc, t.band) + winPill(esc, t.window) +
        (t.ai_flag ? '<span class="dmx-b ' + esc(t.ai_flag) + '">' + (t.ai_flag === 'junk' ? 'Junk' : 'About to close') + '</span>' : '') + '</div>' +
        '<div class="muted small">' + esc(t.score_reason || '') + (t.ai_reason ? ' · ' + esc(t.ai_reason) : '') + '</div>' +
        '<div class="dmx-ctl"><select class="input" data-f="status" aria-label="Status">' + statusOptions(esc, t.status) + '</select>' +
        '<select class="input" data-f="assignee_id" aria-label="Assignee">' + repOptions(esc, st.reps, t.assignee_id) + '</select>' +
        '<input class="input" type="datetime-local" data-f="follow_up_at" aria-label="Follow-up" title="Follow-up" value="' + (t.follow_up_at ? new Date(t.follow_up_at - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '') + '">' +
        '<input class="input" data-f="tags" placeholder="tags, comma separated" value="' + esc(t.tags.join(', ')) + '">' +
        '<input class="input" type="number" min="0" step="100" data-f="deal_value" placeholder="Deal value" value="' + (t.deal_value || '') + '" style="max-width:120px"></div></div>' +
        '<div class="dmx-msgs" data-msgs>' + msgs + '</div>' +
        '<div class="dmx-reply"><div class="row"><select class="input" data-script aria-label="Insert a script"><option value="">Insert a script or quick reply</option>' + scriptsActive.map(function (s) { return '<option value="' + esc(s.id) + '">' + esc(s.category + ': ' + s.title) + '</option>'; }).join('') + '</select>' +
        '<button class="btn-sm ghost" type="button" data-draft>AI draft</button><span class="muted small" data-draft-note></span></div>' +
        '<textarea class="input" data-text placeholder="' + (t.window.mode === 'closed' ? 'The messaging window is closed. Meta allows a reply after their next message.' : 'Write a reply') + '"' + (t.window.mode === 'closed' ? ' disabled' : '') + '></textarea>' +
        '<div class="row"><button class="btn-sm" type="button" data-send' + (t.window.mode === 'closed' ? ' disabled' : '') + '>Send</button><span class="muted small">' + esc(t.window.label) + (t.window.mode === 'human_agent' ? '. Sent with the human agent tag: write it yourself.' : '') + '</span></div></div></div>' +
        '<aside class="dmx-side"><div><h3>Lead profile</h3>' + leadBox + '</div>' +
        '<div><h3>Attribution</h3><dl><dt>Came from</dt><dd>' + esc((t.source || 'dm').replace('_', ' ')) + (t.source_detail ? ' (' + esc(t.source_detail) + ')' : '') + '</dd>' +
        '<dt>DM link</dt><dd>' + (d.link ? esc(d.link.label) + ' · ' + esc(d.linkVisits) + ' visits from this chat' : 'Not sent') + '</dd>' +
        '<dt>Started</dt><dd>' + esc(ctx.when(t.created_at)) + '</dd></dl></div>' +
        (d.comments.length ? '<div><h3>Comments</h3>' + d.comments.map(function (c) { return '<div class="dmx-note">' + esc(c.body || '') + '<br><span class="muted small">' + esc(ctx.when(c.ts)) + (c.private_reply_at ? ' · private reply sent' : '') + (c.error ? ' · ' + esc(c.error) : '') + '</span></div>'; }).join('') + '</div>' : '') +
        '<div><h3>Pre-call summary</h3><button class="btn-sm ghost" type="button" data-summary>' + (t.summary_at ? 'Write it again' : 'Write summary now') + '</button></div>' +
        '<div><h3>Team chat and notes</h3><textarea class="input" data-note placeholder="Note for the team" style="width:100%;min-height:56px;box-sizing:border-box"></textarea><button class="btn-sm ghost" type="button" data-add-note style="margin-top:6px">Add note</button>' + notes + '</div></aside>';
      var m = pane.querySelector('[data-msgs]'); m.scrollTop = m.scrollHeight;
      pane.querySelector('[data-back]').onclick = function () { S.open = null; shell.classList.remove('show'); };
      var patch = function (body) { body.actor = me(); return ctx.send('PATCH', 'dm/threads/' + encodeURIComponent(t.id), body).then(function (r) { if (!r.ok) ctx.toast(r.error || 'Failed'); else { ctx.toast('Saved'); loadList(); } return r; }); };
      pane.querySelectorAll('[data-f]').forEach(function (el) {
        el.onchange = function () {
          var f = el.getAttribute('data-f'), v = el.value, b = {};
          if (f === 'tags') b.tags = v.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
          else if (f === 'follow_up_at') b.follow_up_at = v ? new Date(v).getTime() : null;
          else if (f === 'deal_value') b.deal_value = Number(v || 0);
          else b[f] = v || null;
          patch(b).then(function () { if (f === 'status') openThread(t.id); });
        };
      });
      var text = pane.querySelector('[data-text]'), scriptId = null, aiDrafted = false;
      pane.querySelector('[data-script]').onchange = function () {
        var s = scriptsActive.filter(function (x) { return x.id === this.value; }, this)[0];
        if (!s) return;
        scriptId = s.id; aiDrafted = false;
        var first = (t.name || '').split(' ')[0] || 'there';
        text.value = s.body.replace(/\{first_name\}|\{name\}/g, first).replace(/\{username\}/g, t.username ? '@' + t.username : '').replace(/\{link\}/g, '');
        text.focus();
      };
      pane.querySelector('[data-draft]').onclick = function () {
        var b = this, note = pane.querySelector('[data-draft-note]');
        b.disabled = true; note.textContent = 'Drafting';
        ctx.send('POST', 'dm/threads/' + encodeURIComponent(t.id) + '/draft', { by: me() }).then(function (r) {
          b.disabled = false;
          if (!r.ok) { note.textContent = r.error || 'Failed'; return; }
          text.value = r.text || ''; scriptId = r.script_id; aiDrafted = Boolean(r.ai);
          note.textContent = r.note || 'Draft ready. Read it, edit it, then send it yourself.';
        });
      };
      text && text.addEventListener('input', function () { if (!text.value) { scriptId = null; aiDrafted = false; } });
      pane.querySelector('[data-send]').onclick = function () {
        var b = this;
        if (!me()) { ctx.toast('Pick your name under Sending as first'); return; }
        b.disabled = true;
        ctx.send('POST', 'dm/threads/' + encodeURIComponent(t.id) + '/send', { text: text.value, by: me(), script_id: scriptId, ai_drafted: aiDrafted }).then(function (r) {
          b.disabled = false;
          if (!r.ok) { ctx.toast(r.error || 'Not sent'); return; }
          ctx.toast('Sent'); openThread(t.id); loadList();
        });
      };
      pane.querySelector('[data-add-note]').onclick = function () {
        var v = pane.querySelector('[data-note]').value;
        ctx.send('POST', 'dm/threads/' + encodeURIComponent(t.id) + '/notes', { body: v, author: me() }).then(function (r) { if (r.ok) openThread(t.id); else ctx.toast(r.error || 'Failed'); });
      };
      pane.querySelector('[data-summary]').onclick = function () {
        this.disabled = true;
        ctx.send('POST', 'dm/threads/' + encodeURIComponent(t.id) + '/summary', {}).then(function (r) { ctx.toast(r.ok ? (r.note ? 'Summary written from rules. ' + r.note : 'Summary written and posted') : (r.error || 'Failed')); openThread(t.id); });
      };
      var unlink = pane.querySelector('[data-unlink]');
      if (unlink) unlink.onclick = function () { patch({ lead_id: null }).then(function () { openThread(t.id); }); };
      var lq = pane.querySelector('[data-lead-q]');
      if (lq) {
        var lt;
        lq.oninput = function () {
          var v = lq.value; clearTimeout(lt);
          lt = setTimeout(function () {
            ctx.api('dm/leads', { q: v }, { noRange: true }).then(function (r) {
              var res = pane.querySelector('[data-lead-res]');
              res.innerHTML = r.leads.map(function (l) { return '<div class="dmx-note"><button class="btn-sm ghost" type="button" data-link="' + esc(l.id) + '">Link</button> ' + esc([l.first_name, l.last_name].filter(Boolean).join(' ') || l.email) + ' <span class="muted">' + esc(l.email || '') + ' · ' + esc(l.status) + '</span></div>'; }).join('') || (v.length > 1 ? '<p class="muted small">No match.</p>' : '');
              res.querySelectorAll('[data-link]').forEach(function (b) { b.onclick = function () { patch({ lead_id: b.getAttribute('data-link') }).then(function () { openThread(t.id); }); }; });
            });
          }, 250);
        };
      }
    }

    loadList().then(function () { if (S.open) openThread(S.open); });
  }

  // ───────────── Control center ─────────────
  function control(ctx, box) {
    var esc = ctx.esc, n = ctx.n, pct = ctx.pct;
    var money = function (v) { return '$' + Math.round(v || 0).toLocaleString(); };
    return ctx.api('dm/dashboard', {}, { noRange: true }).then(function (d) {
      var y = d.yesterday, t = d.today, s = d.scripts;
      var tasks = d.tasks.map(function (k) {
        var rep = S.status.reps.filter(function (r) { return r.id === k.assignee_id; })[0];
        return '<li><a href="#dminbox" data-go-thread="' + esc(k.thread_id) + '">' + esc(k.who) + '</a> · ' + esc(k.detail) + ' · <span class="muted">' + esc(rep ? rep.name : 'Unassigned') + '</span></li>';
      }).join('');
      var line = function (r) { return r ? esc(r.title) + ': ' + (r.reply_rate == null ? '-' : pct(r.reply_rate)) + ' reply, ' + (r.book_rate == null ? '-' : pct(r.book_rate)) + ' booked, in ' + n(r.threads) + ' conversations' : 'Not enough data yet'; };
      box.innerHTML =
        '<div class="grid g-4 tiles">' + ctx.tile('Yesterday: replies sent', n(y.replies), n(y.conversations) + ' new conversations') + ctx.tile('Yesterday: booked', n(y.booked), n(y.showed) + ' showed') +
        ctx.tile('Yesterday: closed', n(y.closed), money(y.revenue) + ' deal value') + ctx.tile('Today so far', n(t.replies) + (t.replies === 1 ? ' reply' : ' replies'), n(t.booked) + ' booked · ' + n(t.closed) + ' closed') + '</div>' +
        '<div class="grid g-2" style="margin-top:14px"><div class="card"><h2>Today’s tasks</h2><p class="sub">Unanswered hot leads, windows closing within 3 hours, follow-ups due today. Times in ' + esc(d.tz) + '.</p>' + (tasks ? '<ul class="dmx-tasks plain-list">' + tasks + '</ul>' : '<p class="muted">Nothing waiting.</p>') + '</div>' +
        '<div class="card"><h2>Scripts</h2><p class="sub">Reply rate per conversation, among scripts used in at least ' + n(s.minThreads) + ' conversations.</p><dl class="kv"><dt>Best</dt><dd>' + line(s.best) + '</dd><dt>Worst</dt><dd>' + line(s.worst) + '</dd><dt>Messages sent from scripts</dt><dd>' + n(s.total) + '</dd></dl></div></div>' +
        '<div class="card" style="margin-top:14px"><h2>Setters</h2><p class="sub">Open conversations now; booked, showed and closed from DMs (all time). Commission is the setter’s rate in Reps &amp; routing times cash collected on their closed DM deals.</p><div class="table-wrap"><table class="t"><thead><tr><th>Setter</th><th class="num">Open</th><th class="num">Waiting</th><th class="num">Hot</th><th class="num">Booked</th><th class="num">Showed</th><th class="num">Closed</th><th class="num">Revenue</th><th class="num">Cash</th><th class="num">Commission</th></tr></thead><tbody>' +
        d.setters.map(function (r) { return '<tr><td>' + esc(r.name) + '</td><td class="num">' + n(r.open) + '</td><td class="num">' + n(r.waiting) + '</td><td class="num">' + n(r.hot) + '</td><td class="num">' + n(r.booked) + '</td><td class="num">' + n(r.showed) + '</td><td class="num">' + n(r.closed) + '</td><td class="num">' + money(r.revenue) + '</td><td class="num">' + money(r.cash) + '</td><td class="num">' + money(r.commission) + (r.commission_pct ? ' <span class="muted">(' + r.commission_pct + '%)</span>' : '') + '</td></tr>'; }).join('') +
        '</tbody></table></div><p class="muted small">Bulk reassign: tick conversations in the Inbox and use the bar above the list.</p></div>';
      box.querySelectorAll('[data-go-thread]').forEach(function (a) { a.onclick = function (ev) { ev.preventDefault(); S.sub = 'inbox'; S.view = 'all'; S.open = a.getAttribute('data-go-thread'); render(ctx); }; });
    });
  }

  // ───────────── Scripts ─────────────
  function scripts(ctx, box) {
    var esc = ctx.esc, n = ctx.n, pct = ctx.pct;
    return ctx.api('dm/scripts', {}, { noRange: true }).then(function (d) {
      var stat = {}; d.report.rows.forEach(function (r) { stat[r.script_id] = r; });
      var rate = function (v) { return v == null ? '-' : pct(v); };
      box.innerHTML = '<div class="card"><h2>New script or quick reply</h2><p class="sub">Merge tags: {first_name}, {username}, {link}. FAQ scripts are also what the automated assistant may answer from, when it is switched on.</p>' +
        '<form class="dmx-form" data-new><input type="hidden" name="id"><label>Title<input class="input" name="title" required></label><label>Category<select class="input" name="category">' + d.categories.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('') + '</select></label>' +
        '<label style="grid-column:1/-1">Message<textarea class="input" name="body" required></textarea></label><button class="btn-sm" type="submit">Save script</button></form></div>' +
        '<div class="card" style="margin-top:14px"><h2>Library and results</h2><p class="sub">Per script: conversations it was used in, share of all script sends, and how many replied after it, booked and closed.' + (d.report.best ? ' Best: ' + esc(d.report.best.title) + '.' : '') + (d.report.worst ? ' Worst: ' + esc(d.report.worst.title) + '.' : '') + '</p><div class="table-wrap"><table class="t"><thead><tr><th>Script</th><th>Category</th><th class="num">Conversations</th><th class="num">Share</th><th class="num">Reply rate</th><th class="num">Booked</th><th class="num">Closed</th><th></th></tr></thead><tbody>' +
        d.scripts.map(function (s) { var r = stat[s.id] || {}; return '<tr' + (s.active ? '' : ' class="muted"') + '><td><b>' + esc(s.title) + '</b><div class="muted small">' + esc(s.body.slice(0, 140)) + '</div></td><td>' + esc(s.category) + '</td><td class="num">' + n(r.threads || 0) + '</td><td class="num">' + rate(r.share) + '</td><td class="num">' + rate(r.reply_rate) + '</td><td class="num">' + rate(r.book_rate) + '</td><td class="num">' + rate(r.close_rate) + '</td><td>' + (s.active ? '<button class="btn-sm ghost" type="button" data-edit="' + esc(s.id) + '">Edit</button> <button class="btn-sm ghost" type="button" data-archive="' + esc(s.id) + '">Archive</button>' : 'archived') + '</td></tr>'; }).join('') +
        '</tbody></table></div></div>';
      var f = box.querySelector('[data-new]');
      f.onsubmit = function (ev) { ev.preventDefault(); var b = Object.fromEntries(new FormData(f).entries()); ctx.send('POST', 'dm/scripts', b).then(function (r) { ctx.toast(r.ok ? 'Saved' : (r.error || 'Failed')); if (r.ok) scripts(ctx, box); }); };
      box.querySelectorAll('[data-edit]').forEach(function (b) { b.onclick = function () { var s = d.scripts.filter(function (x) { return x.id === b.getAttribute('data-edit'); })[0]; f.id.value = s.id; f.title.value = s.title; f.category.value = s.category; f.body.value = s.body; f.scrollIntoView({ behavior: 'smooth' }); }; });
      box.querySelectorAll('[data-archive]').forEach(function (b) { b.onclick = function () { ctx.send('DELETE', 'dm/scripts/' + encodeURIComponent(b.getAttribute('data-archive'))).then(function () { scripts(ctx, box); }); }; });
    });
  }

  // ───────────── Triggers ─────────────
  function triggers(ctx, box) {
    var esc = ctx.esc, n = ctx.n;
    return ctx.api('dm/triggers', {}, { noRange: true }).then(function (d) {
      var reps = S.status.reps;
      box.innerHTML = '<div class="card"><h2>New keyword trigger</h2><p class="sub">When a comment, Story reply or DM contains a keyword: tag the conversation, assign it, and send the first message. Meta’s rules apply: a comment gets one private reply within 7 days; Story replies and DMs get the message inside the 24-hour window. The DM link is one of your tracked links, so visits and applications tie back to the conversation.</p>' +
        '<form class="dmx-form" data-new><input type="hidden" name="id"><label>Name<input class="input" name="name" required placeholder="Masterclass comment"></label><label>Keywords (comma separated)<input class="input" name="keywords" required placeholder="deal, buy"></label>' +
        '<label>Match<select class="input" name="match_mode"><option value="word">Whole word</option><option value="contains">Anywhere</option><option value="exact">Whole message</option></select></label>' +
        '<label>Listen on<span><label><input type="checkbox" name="src_comment" checked> comments</label> <label><input type="checkbox" name="src_story_reply" checked> Story replies</label> <label><input type="checkbox" name="src_dm" checked> DMs</label></span></label>' +
        '<label>Tag<input class="input" name="tag" placeholder="masterclass"></label><label>Assign to<select class="input" name="assign_to">' + '<option value="">Nobody</option>' + reps.map(function (r) { return '<option value="' + esc(r.id) + '">' + esc(r.name) + '</option>'; }).join('') + '</select></label>' +
        '<label>DM link (tracked link)<select class="input" name="link_code"><option value="">No link</option>' + d.links.map(function (l) { return '<option value="' + esc(l.code) + '">' + esc(l.label) + ' (' + esc(l.code) + ')</option>'; }).join('') + '</select></label>' +
        '<label>Or use a script<select class="input" name="script_id"><option value="">None</option>' + d.scripts.map(function (s) { return '<option value="' + esc(s.id) + '">' + esc(s.title) + '</option>'; }).join('') + '</select></label>' +
        '<label style="grid-column:1/-1">First message (private reply / DM)<textarea class="input" name="first_message" placeholder="Hi {first_name}, here is the link: {link}"></textarea></label>' +
        '<label style="grid-column:1/-1">Public reply under the comment (optional)<input class="input" name="public_reply" placeholder="Sent you a DM"></label><button class="btn-sm" type="submit">Save trigger</button></form></div>' +
        '<div class="card" style="margin-top:14px"><h2>Triggers</h2><div class="table-wrap"><table class="t"><thead><tr><th>Name</th><th>Keywords</th><th>Listens on</th><th>Does</th><th class="num">Fired</th><th></th></tr></thead><tbody>' +
        (d.triggers.map(function (t) {
          var src = []; try { src = JSON.parse(t.sources); } catch (e) { /* bad row */ }
          var rep = reps.filter(function (r) { return r.id === t.assign_to; })[0];
          return '<tr><td><b>' + esc(t.name) + '</b>' + (t.active ? '' : ' <span class="pill">off</span>') + '</td><td>' + esc(t.keywords) + ' <span class="muted">(' + esc(t.match_mode) + ')</span></td><td>' + esc(src.join(', ').replace(/_/g, ' ')) + '</td>' +
            '<td class="small">' + esc([t.tag ? 'tag #' + t.tag : '', rep ? 'assign ' + rep.name : '', t.first_message || t.script_id ? 'first message' : '', t.link_code ? 'link ' + t.link_code : '', t.public_reply ? 'public reply' : ''].filter(Boolean).join(' · ')) + '</td>' +
            '<td class="num">' + n(t.hits) + '</td><td><button class="btn-sm ghost" type="button" data-edit="' + esc(t.id) + '">Edit</button> <button class="btn-sm ghost" type="button" data-del="' + esc(t.id) + '">Delete</button></td></tr>';
        }).join('') || '<tr><td colspan="6" class="muted">No triggers yet.</td></tr>') + '</tbody></table></div></div>';
      var f = box.querySelector('[data-new]');
      f.onsubmit = function (ev) {
        ev.preventDefault();
        var b = Object.fromEntries(new FormData(f).entries());
        b.sources = ['comment', 'story_reply', 'dm'].filter(function (s) { return f['src_' + s].checked; });
        ctx.send('POST', 'dm/triggers', b).then(function (r) { ctx.toast(r.ok ? 'Saved' : (r.error || 'Failed')); if (r.ok) triggers(ctx, box); });
      };
      box.querySelectorAll('[data-edit]').forEach(function (b) {
        b.onclick = function () {
          var t = d.triggers.filter(function (x) { return x.id === b.getAttribute('data-edit'); })[0], src = [];
          try { src = JSON.parse(t.sources); } catch (e) { /* bad row */ }
          ['id', 'name', 'keywords', 'match_mode', 'tag', 'assign_to', 'link_code', 'script_id', 'first_message', 'public_reply'].forEach(function (k) { if (f[k]) f[k].value = t[k] || ''; });
          ['comment', 'story_reply', 'dm'].forEach(function (s) { f['src_' + s].checked = src.indexOf(s) !== -1; });
          f.scrollIntoView({ behavior: 'smooth' });
        };
      });
      box.querySelectorAll('[data-del]').forEach(function (b) { b.onclick = function () { if (confirm('Delete this trigger?')) ctx.send('DELETE', 'dm/triggers/' + encodeURIComponent(b.getAttribute('data-del'))).then(function () { triggers(ctx, box); }); }; });
    });
  }

  // ───────────── Connect (also on Integrations) ─────────────
  function integrationCard(el, ctx) {
    css();
    var esc = ctx.esc;
    return ctx.api('dm/status', {}, { noRange: true }).then(function (st) {
      var ok = function (v, yes, no) { return '<li>' + (v ? '<b style="color:var(--good-text)">Done.</b> ' + yes : '<b>To do.</b> ' + no) + '</li>'; };
      el.innerHTML = '<div class="card"><div class="card-head"><div><h2>Instagram DMs</h2><p class="sub">The DM sales inbox runs on Meta’s official Instagram API with your own professional account: messages, Story replies and mentions, and comments arrive by webhook. Nothing is scraped. Add the keys under Keys &amp; settings → Instagram DMs, then press Check.</p></div></div>' +
        '<ul class="plain-list">' + ok(st.configured, 'Access token saved' + (st.account ? ' (account ' + esc(st.account) + ')' : '') + '.', 'Add a long-lived Instagram access token.') +
        ok(st.appSecret, 'App secret saved: webhook signatures are checked.', 'Add the Meta app secret.') + ok(st.verifyToken, 'Webhook verify token saved.', 'Add a webhook verify token.') +
        ok(st.ai, 'AI drafts, flags and summaries on.', 'Optional: add the Anthropic key under Email for AI drafts. Rules work without it.') + '</ul>' +
        '<dl class="kv"><dt>Callback URL</dt><dd class="mono">' + esc(st.webhook) + '</dd><dt>Webhook fields</dt><dd>messages, messaging_postbacks, messaging_referral, comments</dd><dt>Automated assistant</dt><dd>' + (st.autoReply ? 'On' : 'Off') + '</dd><dt>Human agent tag</dt><dd>' + (st.humanAgent ? 'On' : 'Off') + '</dd></dl>' +
        '<div class="row" style="gap:8px;margin-top:10px"><button class="btn-sm" type="button" data-ig-check>Check</button><button class="btn-sm ghost" type="button" data-ig-import>Import last 30 days</button><span class="muted small" data-ig-out></span></div><div data-ig-steps class="small"></div></div>';
      var out = el.querySelector('[data-ig-out]'), steps = el.querySelector('[data-ig-steps]');
      el.querySelector('[data-ig-check]').onclick = function () {
        var b = this; b.disabled = true; out.textContent = 'Asking Meta';
        ctx.send('POST', 'dm/check', {}).then(function (r) {
          b.disabled = false;
          out.innerHTML = r.ok ? '<b style="color:var(--good-text)">Connected as @' + esc((r.account && (r.account.username || r.account.id)) || '') + '</b>' : esc(r.error || 'Failed');
          steps.innerHTML = (r.steps || []).length ? '<ol style="margin:8px 0 0 18px">' + r.steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' : '';
        });
      };
      el.querySelector('[data-ig-import]').onclick = function () {
        var b = this, tot = { conversations: 0, messages: 0 };
        b.disabled = true;
        (function step(cursor) {
          ctx.send('POST', 'dm/import', { cursor: cursor }).then(function (r) {
            if (!r.ok) { out.textContent = r.error || 'Failed'; b.disabled = false; return; }
            tot.conversations += r.conversations || 0; tot.messages += r.messages || 0;
            out.textContent = (r.next ? 'Importing: ' : 'Done: ') + tot.conversations + ' conversations, ' + tot.messages + ' messages';
            if (r.next) step(r.next); else b.disabled = false;
          });
        })(null);
      };
    });
  }

  root.DmInbox = { render: render, integrationCard: integrationCard };
})(window);
