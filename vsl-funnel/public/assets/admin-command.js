/* Funnel HQ → Command: the Chief of Staff. Chat (answers from real data, streamed, with the tool calls and their
   sources), Approvals (Approve / Edit / Reject), the activity log across departments, Routines, alerts and briefs,
   and documents. Loaded before admin.js, which calls CommandBoard.render(ctx) with its helpers. */
(function (root) {
  'use strict';
  var CSS = '' +
    '.cmd-tabs{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:14px}.cmd-tabs .seg{flex-wrap:wrap}' +
    '.cmd-badge{display:inline-block;min-width:18px;padding:0 5px;margin-left:4px;border-radius:9px;background:var(--accent);color:#0b0b0b;font-size:11px;line-height:18px;text-align:center}' +
    '.cmd-note{border-left:3px solid var(--warning);padding:8px 12px;background:var(--surface-2);border-radius:6px;margin-bottom:12px;font-size:13px}' +
    '.cmd-chat{display:grid;grid-template-columns:240px minmax(0,1fr);gap:14px;align-items:start}' +
    '.cmd-threads{display:grid;gap:2px;max-height:70vh;overflow:auto}.cmd-threads button{all:unset;cursor:pointer;padding:8px 10px;border-radius:8px;font-size:13px;line-height:1.35;display:block}' +
    '.cmd-threads button:hover{background:var(--surface-2)}.cmd-threads button[aria-current="true"]{background:var(--surface-2);font-weight:650}.cmd-threads small{display:block;color:var(--muted);font-size:11.5px;font-weight:400}' +
    '.cmd-conv{display:flex;flex-direction:column;min-height:60vh}.cmd-msgs{flex:1;display:grid;gap:14px;align-content:start;padding-bottom:12px}' +
    '.cmd-msg{max-width:760px}.cmd-msg.user{justify-self:end;background:var(--surface-2);padding:10px 14px;border-radius:14px 14px 4px 14px;white-space:pre-wrap}' +
    '.cmd-msg.assistant{line-height:1.6}.cmd-msg.assistant h1,.cmd-msg.assistant h2,.cmd-msg.assistant h3{font-size:15px;margin:14px 0 4px}.cmd-msg.assistant p{margin:0 0 8px}.cmd-msg.assistant ul{margin:0 0 8px;padding-left:20px}' +
    '.cmd-msg.assistant a{color:var(--series-1);text-decoration:none}.cmd-msg.assistant a:hover{text-decoration:underline}.cmd-msg table{border-collapse:collapse;font-size:13px;margin:6px 0}.cmd-msg td{border-top:1px solid var(--border);padding:4px 8px}' +
    '.cmd-tools{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px}.cmd-tool{font-size:12px;background:var(--surface-2);border-radius:999px;padding:3px 10px;color:var(--ink-2)}.cmd-tool b{font-weight:650;color:var(--ink)}.cmd-tool a{color:var(--series-1);text-decoration:none;margin-left:4px}' +
    '.cmd-compose{position:sticky;bottom:0;background:var(--plane);padding-top:8px;display:grid;grid-template-columns:1fr auto;gap:8px}.cmd-compose textarea{min-height:52px;max-height:200px;resize:vertical;padding:10px 12px;border:1px solid var(--border);border-radius:12px;background:var(--surface)}' +
    '.cmd-suggest{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 16px}.cmd-suggest button{border:1px solid var(--border);background:var(--surface);border-radius:999px;padding:6px 12px;cursor:pointer;font-size:13px}' +
    '.cmd-list{display:grid;gap:0}.cmd-item{border-top:1px solid var(--border);padding:12px 0;display:grid;gap:6px}.cmd-item:first-child{border-top:0}.cmd-item-head{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:baseline}' +
    '.cmd-item-head strong{font-size:14px}.cmd-actions{display:flex;flex-wrap:wrap;gap:6px}.cmd-item pre{white-space:pre-wrap;font-size:12px;background:var(--surface-2);padding:8px;border-radius:6px;margin:0;max-height:220px;overflow:auto}' +
    '.cmd-risk-high{color:var(--critical);font-weight:650}.cmd-risk-medium{color:var(--serious)}.cmd-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;align-items:end}.cmd-form label{display:grid;gap:4px;font-size:13px}' +
    '.cmd-form .wide{grid-column:1/-1}.cmd-form textarea,.cmd-edit textarea{min-height:70px;width:100%}.cmd-edit{display:grid;gap:8px}.cmd-edit input,.cmd-edit textarea{width:100%}' +
    '.cmd-filters{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px}.cmd-status{font-size:12px}.cmd-status.failed{color:var(--critical)}.cmd-status.done{color:var(--good-text)}' +
    '.cmd-doc{max-width:760px}.cmd-typing{color:var(--muted);font-size:13px}' +
    '@media (max-width:860px){.cmd-chat{grid-template-columns:1fr}.cmd-threads{max-height:none;grid-auto-flow:column;grid-auto-columns:minmax(160px,1fr);overflow-x:auto}}';

  var SUGGEST = [
    'How did last week compare with the week before?',
    'Which campaign has the best cost per booked call this month?',
    'Which A-tier leads have not booked a call yet?',
    'Make a month-to-date summary document',
  ];
  var SUBS = [['chat', 'Chat'], ['approvals', 'Approvals'], ['activity', 'Activity'], ['routines', 'Routines'], ['alerts', 'Alerts & briefs'], ['docs', 'Documents']];
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  function render(ctx) {
    var view = ctx.view, esc = ctx.esc, when = ctx.when, toast = ctx.toast;
    if (!document.getElementById('cmd-css')) { var st = document.createElement('style'); st.id = 'cmd-css'; st.textContent = CSS; document.head.appendChild(st); }
    var sub = ctx.sub || 'chat', threadId = null;
    if (sub.indexOf('thread=') === 0) { threadId = sub.slice(7); sub = 'chat'; }
    if (!SUBS.some(function (s) { return s[0] === sub; })) sub = 'chat';

    function md(text) {
      // Safe markdown: escape first, then bold, headings, lists, tables and links into Funnel HQ only.
      var inline = function (s) {
        return esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
          .replace(/\[([^\]]+)\]\((\/admin[^)\s]*)\)/g, function (_m, t, h) { return '<a href="' + h.replace(/"/g, '') + '">' + t + '</a>'; });
      };
      var out = [], list = false, table = false;
      var close = function () { if (list) out.push('</ul>'); if (table) out.push('</table>'); list = table = false; };
      String(text || '').split('\n').forEach(function (line) {
        var h = /^(#{1,3}) (.*)$/.exec(line);
        if (h) { close(); out.push('<h' + (h[1].length + 1) + '>' + inline(h[2]) + '</h' + (h[1].length + 1) + '>'); return; }
        if (/^\s*[-*] /.test(line)) { if (!list) { close(); out.push('<ul>'); list = true; } out.push('<li>' + inline(line.replace(/^\s*[-*] /, '')) + '</li>'); return; }
        if (/^\|.*\|$/.test(line.trim())) {
          if (/^\|[\s:|-]+\|$/.test(line.trim())) return;
          if (!table) { close(); out.push('<table>'); table = true; }
          out.push('<tr>' + line.trim().slice(1, -1).split('|').map(function (c) { return '<td>' + inline(c.trim()) + '</td>'; }).join('') + '</tr>');
          return;
        }
        close();
        if (line.trim()) out.push('<p>' + inline(line) + '</p>');
      });
      close();
      return out.join('');
    }
    function toolChip(t) {
      var src = (t.sources || []).map(function (s) { return '<a href="' + esc(s.href) + '">' + esc(s.label) + '</a>'; }).join('');
      return '<span class="cmd-tool" title="' + esc(JSON.stringify(t.input || {})) + '"><b>' + esc(String(t.name).replace(/_/g, ' ')) + '</b> · ' + esc(t.summary || '') + (src ? ' ·' + src : '') + '</span>';
    }
    function setBadge(n) {
      var el = document.querySelector('[data-nav-badge="command"]');
      if (el) { el.textContent = n > 99 ? '99+' : String(n); el.hidden = !n; el.title = n ? n + ' waiting for your decision' : ''; }
    }

    return ctx.api('ops', {}, { noRange: true }).then(function (o) {
      setBadge(o.pending);
      var notes = '';
      if (!o.setup.ai) notes += '<div class="cmd-note">Chat and routines need the Anthropic API key: add it in <a href="#integrations">Integrations</a> (Email group). Approvals, the activity log, alerts, the morning brief and documents work without it.</div>';
      if (!o.setup.slack) notes += '<div class="cmd-note">Connect a Slack webhook in <a href="#integrations">Integrations</a> (Alerts or Command group) to get the brief, alerts and routine results in Slack. They are saved here either way.</div>';
      var tabs = '<div class="cmd-tabs"><div class="seg" role="group" aria-label="Command sections">' + SUBS.map(function (s) {
        return '<button type="button" data-cmd-sub="' + s[0] + '" aria-pressed="' + (s[0] === sub) + '">' + esc(s[1]) + (s[0] === 'approvals' && o.pending ? '<span class="cmd-badge">' + esc(o.pending) + '</span>' : '') + '</button>';
      }).join('') + '</div><span class="muted small">Model ' + esc(o.settings.model) + ' · ' + esc(o.settings.timezone) + (o.settings.briefTime ? ' · brief at ' + esc(o.settings.briefTime) : ' · brief off') + (o.settings.autoKinds.length ? ' · auto: ' + esc(o.settings.autoKinds.join(', ')) : ' · every action waits for approval') + '</span></div>';
      view.innerHTML = notes + tabs + '<div data-cmd-body></div>';
      var body = view.querySelector('[data-cmd-body]');
      view.querySelectorAll('[data-cmd-sub]').forEach(function (b) { b.onclick = function () { ctx.setSub(b.getAttribute('data-cmd-sub')); }; });
      var pane = { chat: chat, approvals: approvals, activity: activity, routines: routines, alerts: alerts, docs: docs }[sub];
      return pane(body, o);
    });

    // ───────────── Chat ─────────────
    function chat(body) {
      return ctx.api('ops/threads', {}, { noRange: true }).then(function (d) {
        body.innerHTML = '<div class="cmd-chat"><div class="card"><button class="btn-sm" type="button" data-cmd-new style="width:100%;margin-bottom:8px">New chat</button><div class="cmd-threads" data-cmd-threads></div></div>' +
          '<div class="cmd-conv"><div class="cmd-msgs" data-cmd-msgs></div><form class="cmd-compose" data-cmd-compose><textarea name="m" placeholder="Ask about the numbers or give an instruction, e.g. follow up with every A-tier lead who went quiet" aria-label="Message"></textarea><button class="btn-sm" type="submit">Send</button></form></div></div>';
        var list = body.querySelector('[data-cmd-threads]'), msgs = body.querySelector('[data-cmd-msgs]'), form = body.querySelector('[data-cmd-compose]'), ta = form.querySelector('textarea');
        var busy = false;
        function threads(rows) {
          list.innerHTML = rows.length ? rows.map(function (t) { return '<button type="button" data-thread="' + esc(t.id) + '" aria-current="' + (t.id === threadId) + '">' + esc(t.title) + '<small>' + esc(t.kind === 'chat' ? '' : t.kind + ' · ') + esc(when(t.updated_at)) + '</small></button>'; }).join('') : '<p class="muted small">No chats yet.</p>';
          list.querySelectorAll('[data-thread]').forEach(function (b) { b.onclick = function () { ctx.setSub('thread=' + b.getAttribute('data-thread')); }; });
        }
        function empty() {
          msgs.innerHTML = '<div><h2 style="margin:0 0 4px">What do you want to know or get done?</h2><p class="muted">Answers come from your live Funnel HQ data, with links to the views behind each number. Anything that changes something is queued in Approvals for you.</p><div class="cmd-suggest">' +
            SUGGEST.map(function (s) { return '<button type="button" data-suggest>' + esc(s) + '</button>'; }).join('') + '</div></div>';
          msgs.querySelectorAll('[data-suggest]').forEach(function (b) { b.onclick = function () { ta.value = b.textContent; send(); }; });
        }
        function bubble(m) {
          if (m.role === 'user') return '<div class="cmd-msg user">' + esc(m.content) + '</div>';
          return '<div class="cmd-msg assistant">' + ((m.tools && m.tools.length) ? '<div class="cmd-tools">' + m.tools.map(toolChip).join('') + '</div>' : '') + md(m.content) + '</div>';
        }
        threads(d.threads || []);
        if (threadId) ctx.api('ops/threads/' + encodeURIComponent(threadId), {}, { noRange: true }).then(function (t) { msgs.innerHTML = (t.messages || []).map(bubble).join('') || ''; if (!t.messages) empty(); }).catch(empty);
        else empty();
        body.querySelector('[data-cmd-new]').onclick = function () { threadId = null; ctx.setSub('chat'); };
        ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
        form.onsubmit = function (e) { e.preventDefault(); send(); };

        function send() {
          var text = ta.value.trim();
          if (!text || busy) return;
          busy = true; ta.value = '';
          if (!threadId) msgs.innerHTML = '';
          msgs.insertAdjacentHTML('beforeend', bubble({ role: 'user', content: text }));
          var el = document.createElement('div'); el.className = 'cmd-msg assistant'; el.innerHTML = '<div class="cmd-tools"></div><div data-a><span class="cmd-typing">Working on it…</span></div>';
          msgs.appendChild(el);
          var toolsEl = el.querySelector('.cmd-tools'), aEl = el.querySelector('[data-a]'), acc = '';
          el.scrollIntoView({ block: 'end' });
          fetch('/admin/api/ops/chat', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ threadId: threadId, message: text }) }).then(function (res) {
            if (res.status === 401) { location.href = '/admin/login'; return; }
            if (!res.ok || !res.body) return res.json().then(function (j) { aEl.textContent = (j && j.error) || 'The chat failed.'; });
            var reader = res.body.getReader(), dec = new TextDecoder(), buf = '';
            function pump() {
              return reader.read().then(function (r) {
                if (r.done) return;
                buf += dec.decode(r.value, { stream: true });
                var lines = buf.split('\n'); buf = lines.pop();
                lines.forEach(function (line) {
                  if (!line.trim()) return;
                  var ev; try { ev = JSON.parse(line); } catch (e) { return; }
                  if (ev.type === 'thread') { if (!threadId) { threadId = ev.id; ctx.setSub('thread=' + ev.id, { silent: true }); } }
                  else if (ev.type === 'text') { acc += ev.text; aEl.innerHTML = md(acc); }
                  else if (ev.type === 'tool') { toolsEl.insertAdjacentHTML('beforeend', toolChip(ev)); }
                  else if (ev.type === 'error') { acc += '\n\n' + ev.error; aEl.innerHTML = md(acc); }
                });
                return pump();
              });
            }
            return pump();
          }).catch(function (e) { aEl.textContent = 'The chat failed: ' + e.message; }).then(function () {
            busy = false;
            ctx.api('ops/threads', {}, { noRange: true }).then(function (d2) { threads(d2.threads || []); });
            ctx.api('ops', {}, { noRange: true }).then(function (o2) { setBadge(o2.pending); });
          });
        }
      });
    }

    // ───────────── Approvals ─────────────
    function approvals(body) {
      return ctx.api('ops/actions', { status: 'proposed', limit: 100 }, { noRange: true }).then(function (d) {
        var rows = d.actions || [];
        body.innerHTML = '<div class="card"><div class="card-head"><div><h2>Waiting for your decision</h2><p class="sub">Approve runs the action through its department and logs the result. Edit changes the summary, the detail or the payload first. Reject keeps it in the log as rejected.</p></div></div>' +
          (rows.length ? '<div class="cmd-list">' + rows.map(item).join('') + '</div>' : ctx.emptyState('Nothing is waiting for approval.', 'Proposals from the chat, the hourly alerts, routines and the departments appear here.')) + '</div>';
        wire();
      });
      function item(a) {
        return '<div class="cmd-item" data-act="' + esc(a.id) + '"><div class="cmd-item-head"><span class="pill">' + esc(deptLabel(a.dept)) + '</span><strong>' + esc(a.summary) + '</strong>' +
          '<span class="cmd-risk-' + esc(a.risk || 'low') + '">' + esc((a.risk || 'low') + ' risk') + '</span><span class="muted small">' + esc(a.kind) + ' · ' + esc(a.who) + ' · ' + esc(when(a.created_at)) + (a.source ? ' · ' + esc(a.source.split(':')[0]) : '') + '</span></div>' +
          (a.detail ? '<div>' + md(a.detail) + '</div>' : '') +
          '<details><summary class="muted small">Payload' + (a.handled ? ' (carried out automatically on approval)' : ' (no automatic handler: approve, then do it by hand)') + '</summary><pre>' + esc(JSON.stringify(a.payload, null, 2)) + '</pre></details>' +
          '<div class="cmd-actions"><button class="btn-sm" data-approve>Approve</button><button class="btn-sm ghost" data-edit>Edit</button><button class="btn-sm ghost" data-reject>Reject</button></div><div data-editor></div></div>';
      }
      function wire() {
        body.querySelectorAll('[data-act]').forEach(function (row) {
          var id = row.getAttribute('data-act');
          row.querySelector('[data-approve]').onclick = function (e) {
            e.target.disabled = true;
            ctx.send('POST', 'ops/actions/' + id + '/approve', {}).then(function (r) { toast(r.summary || (r.ok ? 'Approved' : 'Not approved')); ctx.reload(); });
          };
          row.querySelector('[data-reject]').onclick = function () {
            var reason = prompt('Why are you rejecting it? (optional, saved in the log)') ;
            if (reason === null) return;
            ctx.send('POST', 'ops/actions/' + id + '/reject', { reason: reason }).then(function (r) { toast(r.summary || 'Rejected'); ctx.reload(); });
          };
          row.querySelector('[data-edit]').onclick = function () {
            ctx.api('ops/actions', { status: 'proposed', limit: 100 }, { noRange: true }).then(function (d) {
              var a = (d.actions || []).filter(function (x) { return x.id === id; })[0]; if (!a) return;
              var ed = row.querySelector('[data-editor]');
              ed.innerHTML = '<form class="cmd-edit"><label>Summary<input class="input" name="summary" value="' + esc(a.summary) + '"></label><label>Detail<textarea class="input" name="detail">' + esc(a.detail || '') + '</textarea></label>' +
                '<label>Payload (JSON)<textarea class="input mono" name="payload" rows="6">' + esc(JSON.stringify(a.payload, null, 2)) + '</textarea></label><div class="cmd-actions"><button class="btn-sm" type="submit">Save changes</button><button class="btn-sm ghost" type="button" data-cancel>Cancel</button></div></form>';
              var f = ed.querySelector('form');
              ed.querySelector('[data-cancel]').onclick = function () { ed.innerHTML = ''; };
              f.onsubmit = function (e) {
                e.preventDefault();
                ctx.send('PUT', 'ops/actions/' + id, { summary: f.summary.value, detail: f.detail.value, payload: f.payload.value }).then(function (r) { if (r.ok) { toast('Saved'); ctx.reload(); } else toast(r.error || 'Not saved'); });
              };
            });
          };
        });
      }
    }

    function deptLabel(id) { return ({ chief: 'Chief of Staff', research: 'Research', marketing: 'Marketing', sales: 'Sales', client_success: 'Client Success', support: 'Support', content: 'Content', dm: 'DM inbox' })[id] || id; }

    // ───────────── Activity ─────────────
    function activity(body, o) {
      var f = { dept: '', actor: '', status: '' }, before = null, all = [];
      body.innerHTML = '<div class="card"><div class="card-head"><div><h2>Activity across departments</h2><p class="sub">Every action taken or proposed, newest first. Who: Auto (ran by itself, allowed in settings), You, AI (proposed or done by an AI department), Slack.</p></div></div>' +
        '<div class="cmd-filters"><select class="input" data-f="dept" aria-label="Department"><option value="">All departments</option>' + o.depts.map(function (d) { return '<option value="' + esc(d.id) + '">' + esc(d.label) + '</option>'; }).join('') + '</select>' +
        '<select class="input" data-f="actor" aria-label="Who"><option value="">Anyone</option><option value="auto">Auto</option><option value="you">You</option><option value="ai">AI</option><option value="slack">Slack</option></select>' +
        '<select class="input" data-f="status" aria-label="Status"><option value="">Any status</option><option value="done">Done</option><option value="proposed">Proposed</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="failed">Failed</option></select></div>' +
        '<div data-rows></div><button class="btn-sm ghost" data-more hidden>Load older</button></div>';
      var rowsEl = body.querySelector('[data-rows]'), more = body.querySelector('[data-more]');
      body.querySelectorAll('[data-f]').forEach(function (s) { s.onchange = function () { f[s.getAttribute('data-f')] = s.value; before = null; all = []; load(); }; });
      more.onclick = load;
      function load() {
        return ctx.api('ops/actions', { dept: f.dept, actor: f.actor, status: f.status, before: before || '', limit: 100 }, { noRange: true }).then(function (d) {
          all = all.concat(d.actions || []);
          before = all.length ? all[all.length - 1].created_at : null;
          more.hidden = (d.actions || []).length < 100;
          rowsEl.innerHTML = all.length ? '<div class="table-wrap tfeed"><table><thead><tr><th>When</th><th>Department</th><th>Who</th><th>What</th><th>Status</th><th>Outcome</th></tr></thead><tbody>' + all.map(function (a) {
            return '<tr><td class="nw" data-label="When">' + esc(when(a.created_at)) + '</td><td data-label="Department">' + esc(deptLabel(a.dept)) + '</td><td data-label="Who">' + esc(a.who) + '</td><td data-label="What">' + esc(a.summary) + (a.lead_id ? ' <a href="#lead=' + esc(a.lead_id) + '">lead</a>' : '') + '<div class="muted small">' + esc(a.kind) + '</div></td>' +
              '<td data-label="Status"><span class="cmd-status ' + esc(a.status) + '">' + esc(a.status) + '</span></td><td data-label="Outcome">' + esc(a.result || '') + '</td></tr>';
          }).join('') + '</tbody></table></div>' : ctx.emptyState('Nothing logged with these filters.', 'Actions appear here as the departments work.');
        });
      }
      return load();
    }

    // ───────────── Routines ─────────────
    function routines(body) {
      return ctx.api('ops/routines', {}, { noRange: true }).then(function (d) {
        var rows = d.routines || [];
        body.innerHTML = '<div class="card"><h2>New routine</h2><p class="sub">A saved instruction the Chief of Staff runs on a schedule in your time zone. Each run starts a chat thread here and posts the answer to Slack.</p>' +
          '<form class="cmd-form" data-new><label class="wide">Instruction<textarea class="input" name="instruction" placeholder="Summarise last week against the week before and propose next week\'s tests" required></textarea></label>' +
          '<label>Name<input class="input" name="name" placeholder="Monday review"></label><label>How often<select class="input" name="cadence"><option value="daily">Every day</option><option value="weekdays">Weekdays</option><option value="weekly" selected>Weekly</option></select></label>' +
          '<label data-wd>Day<select class="input" name="weekday">' + DAYS.map(function (x, i) { return '<option value="' + i + '"' + (i === 1 ? ' selected' : '') + '>' + x + '</option>'; }).join('') + '</select></label>' +
          '<label>Time<input class="input" type="time" name="time" value="08:00" required></label><label>Time zone<input class="input" name="timezone" value="' + esc(d.timezone) + '"></label><button class="btn-sm" type="submit">Save routine</button></form></div>' +
          '<div class="card" style="margin-top:14px"><h2>Routines</h2>' + (rows.length ? '<div class="cmd-list">' + rows.map(function (r) {
            return '<div class="cmd-item" data-rt="' + esc(r.id) + '"><div class="cmd-item-head"><strong>' + esc(r.name) + '</strong><span class="muted small">' + esc(r.schedule) + '</span>' + (r.enabled ? '' : '<span class="pill">paused</span>') + '</div><div>' + esc(r.instruction) + '</div>' +
              '<div class="muted small">Next run ' + esc(r.next_local || '–') + ' · last run ' + (r.last_run_at ? (r.last_thread ? '<a href="#command/thread=' + esc(r.last_thread) + '">' + esc(r.last_local) + '</a>' : esc(r.last_local)) : 'never') + '</div>' +
              '<div class="cmd-actions"><button class="btn-sm ghost" data-run>Run now</button><button class="btn-sm ghost" data-toggle>' + (r.enabled ? 'Pause' : 'Resume') + '</button><button class="btn-sm ghost" data-del>Delete</button></div></div>';
          }).join('') + '</div>' : ctx.emptyState('No routines yet.', 'Save one above, or ask the chat to set one up: it proposes the routine for your approval.')) + '</div>';
        var f = body.querySelector('[data-new]'), wd = body.querySelector('[data-wd]');
        var sync = function () { wd.style.display = f.cadence.value === 'weekly' ? '' : 'none'; }; f.cadence.onchange = sync; sync();
        f.onsubmit = function (e) {
          e.preventDefault();
          ctx.send('POST', 'ops/routines', { name: f.name.value, instruction: f.instruction.value, cadence: f.cadence.value, weekday: Number(f.weekday.value), time: f.time.value, timezone: f.timezone.value }).then(function (r) { if (r.ok) { toast('Routine saved'); ctx.reload(); } else toast(r.error || 'Not saved'); });
        };
        body.querySelectorAll('[data-rt]').forEach(function (row) {
          var id = row.getAttribute('data-rt'), r = rows.filter(function (x) { return x.id === id; })[0];
          row.querySelector('[data-run]').onclick = function (e) { e.target.disabled = true; e.target.textContent = 'Running…'; ctx.send('POST', 'ops/routines/' + id + '/run', {}).then(function (x) { if (x.ok) ctx.setSub('thread=' + x.thread); else { toast(x.error || 'Failed'); ctx.reload(); } }); };
          row.querySelector('[data-toggle]').onclick = function () { ctx.send('PUT', 'ops/routines/' + id, { enabled: r.enabled ? 0 : 1 }).then(function () { ctx.reload(); }); };
          row.querySelector('[data-del]').onclick = function () { if (confirm('Delete this routine?')) fetch('/admin/api/ops/routines/' + id, { method: 'DELETE', credentials: 'same-origin' }).then(function () { ctx.reload(); }); };
        });
      });
    }

    // ───────────── Alerts & briefs ─────────────
    function alerts(body, o) {
      return ctx.api('ops/threads', { kind: 'brief' }, { noRange: true }).then(function (d) {
        var th = o.settings.thresholds;
        body.innerHTML = '<div class="card"><div class="card-head"><div><h2>Hourly alerts</h2><p class="sub">' + (o.settings.monitors ? 'Every hour the last 24 hours and 7 days are compared with the period before. Thresholds: a drop of ' + Math.round(th.dropPct * 100) + '%, a rise of ' + Math.round(th.spikePct * 100) + '%, at least ' + th.minCount + ' in either period. The same alert is not repeated within its window.' : 'Alerts are off (Command settings in Integrations).') + '</p></div><button class="btn-sm ghost" data-check>Run the check now</button></div>' +
          ((o.alerts || []).length ? '<div class="cmd-list">' + o.alerts.map(function (a) {
            return '<div class="cmd-item"><div class="cmd-item-head"><strong>' + esc(a.title) + '</strong><span class="' + (a.severity === 'high' ? 'cmd-risk-high' : 'cmd-risk-medium') + '">' + esc(a.severity) + '</span><span class="muted small">' + esc(when(a.created_at)) + '</span></div><div>' + md(a.body) + '</div></div>';
          }).join('') + '</div>' : ctx.emptyState('No alerts yet.', 'They appear here and in Slack when a key number moves past the thresholds.')) + '</div>' +
          '<div class="card" style="margin-top:14px"><div class="card-head"><div><h2>Morning brief and weekend summary</h2><p class="sub">' + (o.settings.briefTime ? 'Every day at ' + esc(o.settings.briefTime) + ' (' + esc(o.settings.timezone) + '): yesterday against the day before, what the departments did, and what needs a decision. Mondays: the weekend and last week.' : 'The brief is off (Command settings in Integrations).') + '</p></div>' +
          '<div class="cmd-actions"><button class="btn-sm ghost" data-preview="daily">Preview today\'s brief</button><button class="btn-sm ghost" data-preview="weekend">Preview the weekend summary</button><button class="btn-sm ghost" data-send>Send the brief now</button></div></div><div data-preview-out></div>' +
          ((d.threads || []).length ? '<div class="cmd-list">' + d.threads.map(function (t) { return '<div class="cmd-item"><a href="#command/thread=' + esc(t.id) + '">' + esc(t.title) + '</a></div>'; }).join('') + '</div>' : '') + '</div>';
        body.querySelector('[data-check]').onclick = function (e) { e.target.disabled = true; ctx.send('POST', 'ops/monitors/run', {}).then(function (r) { toast(r.ok ? (r.alerts ? r.alerts + ' new alert' + (r.alerts === 1 ? '' : 's') : 'Nothing crossed the thresholds') : (r.error || 'Failed')); ctx.reload(); }); };
        body.querySelectorAll('[data-preview]').forEach(function (b) { b.onclick = function () { ctx.api('ops/brief/preview', { kind: b.getAttribute('data-preview') }, { noRange: true }).then(function (r) { body.querySelector('[data-preview-out]').innerHTML = '<div class="cmd-msg assistant cmd-doc">' + md(r.markdown) + '</div>'; }); }; });
        body.querySelector('[data-send]').onclick = function (e) { e.target.disabled = true; ctx.send('POST', 'ops/brief/send', {}).then(function (r) { if (r.ok) ctx.setSub('thread=' + r.thread); else toast(r.error || 'Failed'); }); };
      });
    }

    // ───────────── Documents ─────────────
    function docs(body) {
      return ctx.api('ops/documents', {}, { noRange: true }).then(function (d) {
        var rows = d.documents || [];
        body.innerHTML = '<div class="card"><div class="card-head"><div><h2>Documents</h2><p class="sub">Summaries built from your data, every number with its source. Download as Markdown or HTML' + (d.drive ? ', or create a Google Doc in your Drive.' : '. Connect Google Drive in Integrations (Content) to create Google Docs too.') + ' Ask the chat for anything else, for example a summary of one campaign.</p></div></div>' +
          '<div class="cmd-actions" style="margin-bottom:10px"><button class="btn-sm" data-make="mtd">Month-to-date summary</button><button class="btn-sm ghost" data-make="last_week">Last week</button><button class="btn-sm ghost" data-make="last_month">Last month</button></div>' +
          (rows.length ? '<div class="cmd-list">' + rows.map(function (x) {
            return '<div class="cmd-item" data-doc="' + esc(x.id) + '"><div class="cmd-item-head"><strong>' + esc(x.title) + '</strong><span class="muted small">' + esc(when(x.created_at)) + '</span></div><div class="cmd-actions"><button class="btn-sm ghost" data-view>View</button>' +
              '<a class="btn-sm ghost" href="/admin/api/ops/documents/' + esc(x.id) + '.md">Download .md</a><a class="btn-sm ghost" href="/admin/api/ops/documents/' + esc(x.id) + '.html">Download .html</a>' +
              (x.drive_url ? '<a class="btn-sm ghost" href="' + esc(x.drive_url) + '" target="_blank" rel="noopener">Open in Google Docs ↗</a>' : d.drive ? '<button class="btn-sm ghost" data-drive>Create in Google Drive</button>' : '') + '<button class="btn-sm ghost" data-del>Delete</button></div><div data-out></div></div>';
          }).join('') + '</div>' : ctx.emptyState('No documents yet.', 'Make one above or ask the chat.')) + '</div>';
        body.querySelectorAll('[data-make]').forEach(function (b) { b.onclick = function () { b.disabled = true; ctx.send('POST', 'ops/documents', { range: b.getAttribute('data-make') }).then(function (r) { toast(r.ok ? 'Saved ' + r.title : (r.error || 'Failed')); ctx.reload(); }); }; });
        body.querySelectorAll('[data-doc]').forEach(function (row) {
          var id = row.getAttribute('data-doc');
          row.querySelector('[data-view]').onclick = function () { var out = row.querySelector('[data-out]'); if (out.innerHTML) { out.innerHTML = ''; return; } ctx.api('ops/documents/' + id, {}, { noRange: true }).then(function (x) { out.innerHTML = '<div class="cmd-msg assistant cmd-doc">' + md(x.body) + '</div>'; }); };
          var dr = row.querySelector('[data-drive]'); if (dr) dr.onclick = function () { dr.disabled = true; ctx.send('POST', 'ops/documents/' + id + '/drive', {}).then(function (r) { toast(r.ok ? 'Created in Google Drive' : (r.error || 'Failed')); ctx.reload(); }); };
          row.querySelector('[data-del]').onclick = function () { if (confirm('Delete this document?')) fetch('/admin/api/ops/documents/' + id, { method: 'DELETE', credentials: 'same-origin' }).then(function () { ctx.reload(); }); };
        });
      });
    }
  }

  root.CommandBoard = { render: render };
})(window);
