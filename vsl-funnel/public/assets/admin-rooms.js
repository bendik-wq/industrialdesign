/* Funnel HQ → Rooms: our own video rooms (src/rooms). Live webinars and challenge days that run in our room, and
   meeting rooms for clients and leads (onboarding, kickoff, weekly working sessions). Attendance per person and
   recordings come from the rooms themselves. Loaded before admin.js, which calls RoomsBoard.render(ctx) for the
   Rooms tab and RoomsBoard.section(ctx) under Live webinars. The "Meeting room" buttons in the lead and client
   drawers are handled here too (data-room-new). */
(function (root) {
  'use strict';
  var CSS = '.rmb-list td{vertical-align:top}.rmb-act{display:flex;flex-wrap:wrap;gap:6px}.rmb-form{display:flex;flex-wrap:wrap;gap:10px;align-items:end}.rmb-form label{display:grid;gap:4px;font-size:13px;color:var(--ink-2)}' +
    '.rmb-dlg{position:fixed;inset:0;z-index:200;display:grid;place-items:center;padding:16px;background:rgba(0,0,0,.35)}.rmb-dlg-in{background:#fff;border-radius:14px;padding:24px;max-width:460px;width:100%;display:grid;gap:12px}' +
    '.rmb-dlg-in h2{margin:0}.rmb-dlg-in label{display:grid;gap:4px;font-size:13px;color:var(--ink-2)}.rmb-links{font-size:13px;overflow-wrap:anywhere}.rmb-todo li{margin:4px 0;font-size:13px}';
  var KIND = { live: 'Live webinar', challenge: 'Challenge day', lead: 'Meeting', none: 'Room' };
  var STATUS = { scheduled: 'Scheduled', live: 'Live', ended: 'Ended', cancelled: 'Cancelled' };
  var MEETINGS = [['onboarding', 'Onboarding call'], ['kickoff', 'Kickoff'], ['weekly', 'Weekly working session'], ['other', 'Other meeting']];
  function css() { if (!document.getElementById('rmb-css')) { var s = document.createElement('style'); s.id = 'rmb-css'; s.textContent = CSS; document.head.appendChild(s); } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function req(method, path, body) {
    return fetch('/admin/api/' + path, { method: method, credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) }).then(function (r) { return r.json(); });
  }
  function fmt(t) { if (!t) return '–'; try { return new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(t)); } catch (e) { return new Date(t).toLocaleString(); } }
  function copy(text, toast) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast('Link copied'); }, function () { window.prompt('Copy this link', text); });
  }

  function table(rooms, o) {
    if (!rooms.length) return '<p class="muted">No rooms yet. Set a live webinar or challenge day to run in our room, or create a meeting room below.</p>';
    return '<div class="table-wrap"><table class="rmb-list"><thead><tr><th>When</th><th>Room</th><th>Kind</th><th>Status</th><th class="num">People</th><th class="num">Minutes</th><th class="num">Peak</th><th></th></tr></thead><tbody>' +
      rooms.slice(0, o && o.limit || 200).map(function (r) {
        return '<tr data-rmb-row="' + esc(r.id) + '"><td>' + esc(fmt(r.starts_at)) + '</td><td><strong>' + esc(r.title) + '</strong>' + (r.guest ? '<div class="muted">' + esc(r.guest) + '</div>' : '') + '</td><td>' + esc((r.mode === 'meeting' ? 'Meeting' : KIND[r.ref_type] || 'Room')) + '</td><td>' + esc(STATUS[r.status] || r.status) + '</td>' +
          '<td class="num">' + esc(r.people) + '</td><td class="num">' + esc(r.minutes) + '</td><td class="num">' + esc(r.peak) + '</td>' +
          '<td><div class="rmb-act"><a class="btn-sm" href="' + esc(r.hostUrl) + '" target="_blank" rel="noopener">Open as host</a><button class="btn-sm ghost" data-rmb-links="' + esc(r.id) + '">Links</button><button class="btn-sm ghost" data-rmb-detail="' + esc(r.id) + '">Attendance</button>' +
          (r.lead_id && r.status !== 'cancelled' ? '<button class="btn-sm ghost" data-rmb-email="' + esc(r.id) + '">Email invite</button>' : '') + '</div></td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function wire(box, ctx, reload) {
    box.querySelectorAll('[data-rmb-links]').forEach(function (b) {
      b.onclick = function () {
        req('POST', 'rooms/' + b.getAttribute('data-rmb-links') + '/links').then(function (d) {
          var out = '<div class="rmb-dlg" data-rmb-dlg><div class="rmb-dlg-in"><h2>Room links</h2>' +
            '<p class="rmb-links"><strong>Host</strong> (you, signed in): <a href="' + esc(d.host) + '" target="_blank" rel="noopener">' + esc(d.host) + '</a></p>' +
            '<p class="rmb-links"><strong>Co-host</strong> (valid 48 hours, anyone with it joins backstage): <span class="mono">' + esc(d.cohost) + '</span> <button class="btn-sm ghost" data-c="' + esc(d.cohost) + '">Copy</button></p>' +
            (d.guest ? '<p class="rmb-links"><strong>Guest</strong> (personal to the client): <span class="mono">' + esc(d.guest) + '</span> <button class="btn-sm ghost" data-c="' + esc(d.guest) + '">Copy</button></p>' : '') +
            '<button class="btn-sm" data-close>Done</button></div></div>';
          document.body.insertAdjacentHTML('beforeend', out);
          var dlg = document.querySelector('[data-rmb-dlg]');
          dlg.querySelectorAll('[data-c]').forEach(function (c) { c.onclick = function () { copy(c.getAttribute('data-c'), ctx.toast); }; });
          dlg.querySelector('[data-close]').onclick = function () { dlg.remove(); };
          dlg.onclick = function (e) { if (e.target === dlg) dlg.remove(); };
        });
      };
    });
    box.querySelectorAll('[data-rmb-email]').forEach(function (b) {
      b.onclick = function () { b.disabled = true; req('POST', 'rooms/' + b.getAttribute('data-rmb-email') + '/email').then(function (d) { ctx.toast(d.ok ? 'Invite sent' : (d.error || 'Not sent (no email address, or already sent)')); b.disabled = false; }); };
    });
    box.querySelectorAll('[data-rmb-detail]').forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-rmb-detail');
        var row = box.querySelector('[data-rmb-row="' + id + '"]');
        var next = row.nextElementSibling;
        if (next && next.hasAttribute('data-rmb-att')) { next.remove(); return; }
        req('GET', 'rooms/' + id).then(function (d) {
          var att = d.attendance || [], recs = d.recordings || [];
          var html = '<tr data-rmb-att><td colspan="8">' +
            (att.length ? '<table><thead><tr><th>Who</th><th>Role</th><th>First joined</th><th>Last seen</th><th class="num">Minutes</th><th class="num">Joins</th><th>On stage</th></tr></thead><tbody>' + att.map(function (a) {
              return '<tr><td>' + esc(a.name) + (a.email ? '<div class="muted">' + esc(a.email) + '</div>' : '') + '</td><td>' + esc(a.role) + '</td><td>' + esc(fmt(a.first_at)) + '</td><td>' + esc(fmt(a.last_at)) + '</td><td class="num">' + esc(a.minutes) + '</td><td class="num">' + esc(a.joins) + '</td><td>' + (a.on_stage_at ? esc(fmt(a.on_stage_at)) : '–') + '</td></tr>';
            }).join('') + '</tbody></table>' : '<p class="muted">Nobody has joined this room yet.</p>') +
            '<p style="margin-top:10px"><strong>Recordings</strong> ' + (recs.length ? recs.map(function (r) { return r.url ? '<a href="' + esc(r.url) + '" target="_blank" rel="noopener">' + esc(fmt(r.started_at)) + '</a> (' + ((r.bytes || 0) / 1048576).toFixed(1) + ' MB)' : esc(fmt(r.started_at)) + ' (' + esc(r.status) + ')'; }).join(' · ') : '<span class="muted">none yet</span>') + '</p></td></tr>';
          row.insertAdjacentHTML('afterend', html);
        });
      };
    });
  }

  function render(ctx) {
    css();
    var view = ctx.view;
    return req('GET', 'rooms').then(function (d) {
      var todo = (d.todo || []).length ? '<div class="card"><h2>To finish setting up rooms</h2><ul class="rmb-todo">' + d.todo.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul></div>' : '';
      var s = d.setup || {};
      view.innerHTML = '<div class="grid g-4 tiles">' +
        ctx.tile('Video (SFU)', s.sfu ? 'Connected' : 'Not set', 'Cloudflare Realtime app') + ctx.tile('TURN', s.turn ? 'Connected' : 'Not set', 'for strict office and hotel networks') +
        ctx.tile('Recordings', s.r2 ? 'R2 bucket' : 'Download', s.r2 ? 'uploaded and used as the replay' : 'no RECORDINGS bucket bound yet') + ctx.tile('Rooms', ctx.n((d.rooms || []).length), 'live, challenge and meetings') + '</div>' + todo +
        '<div class="card" style="margin-top:14px"><h2>New meeting room</h2><p class="sub">For a client or lead, use Meeting room in their lead or client drawer: the invite goes to their email. Rooms made here are for the team (share the co-host link).</p>' +
        '<div class="rmb-form"><label>Title<input class="input" data-n="title" placeholder="Team meeting"></label><label>When<input class="input" type="datetime-local" data-n="starts_at"></label><label>Length (minutes)<input class="input" type="number" min="15" max="240" value="60" data-n="duration_min"></label>' +
        '<label>Kind<select class="input" data-n="mode"><option value="meeting">Meeting (everyone on camera)</option><option value="webinar">Webinar (stage and audience)</option></select></label><button class="btn-sm" data-rmb-create>Create room</button></div></div>' +
        '<div class="card" style="margin-top:14px"><h2>Rooms</h2>' + table(d.rooms || []) + '</div>';
      wire(view, ctx);
      view.querySelector('[data-rmb-create]').onclick = function () {
        var b = {}; view.querySelectorAll('[data-n]').forEach(function (i) { b[i.getAttribute('data-n')] = i.value; });
        b.starts_at = b.starts_at ? new Date(b.starts_at).getTime() : null;
        b.duration_min = Number(b.duration_min);
        req('POST', 'rooms', b).then(function (r) { if (r.ok) { ctx.toast('Room created'); ctx.reload(); } else ctx.toast(r.error || 'Could not create it'); });
      };
    });
  }

  /** The Rooms section under Funnel HQ → Live webinars. */
  function section(ctx) {
    css();
    return req('GET', 'rooms').then(function (d) {
      var old = ctx.view.querySelector('[data-rmb-section]'); if (old) old.remove();
      var el = document.createElement('div');
      el.setAttribute('data-rmb-section', '');
      el.className = 'card'; el.style.marginTop = '14px';
      el.innerHTML = '<div class="card-head"><div><h2>Rooms</h2><p class="sub">Live webinars and challenge days set to run in our room, and client meeting rooms. Attendance per person comes from the room itself.</p></div><a class="btn-sm ghost" href="#rooms" data-go="rooms">All rooms</a></div>' +
        ((d.todo || []).length ? '<ul class="rmb-todo">' + d.todo.slice(0, 2).map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>' : '') + table(d.rooms || [], { limit: 8 });
      ctx.view.appendChild(el);
      wire(el, ctx);
    }).catch(function () { /* the board still shows */ });
  }

  // Meeting room for a lead or client (buttons in the lead drawer and the client detail).
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-room-new]');
    if (!b) return;
    css();
    var lead = b.getAttribute('data-lead'), name = b.getAttribute('data-name') || 'this client';
    var html = '<div class="rmb-dlg" data-rmb-dlg><div class="rmb-dlg-in"><h2>Meeting room with ' + esc(name) + '</h2>' +
      '<label>What it is<select class="input" data-m="kind">' + MEETINGS.map(function (m) { return '<option value="' + m[0] + '">' + esc(m[1]) + '</option>'; }).join('') + '</select></label>' +
      '<label>When<input class="input" type="datetime-local" data-m="starts_at"></label><label>Length (minutes)<input class="input" type="number" min="15" max="240" value="60" data-m="duration_min"></label>' +
      '<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-m="email" checked> Email them the link now</label>' +
      '<div class="row" style="gap:8px"><button class="btn-sm" data-go-create>Create room</button><button class="btn-sm ghost" data-close>Cancel</button></div><div data-out></div></div></div>';
    document.body.insertAdjacentHTML('beforeend', html);
    var dlg = document.querySelector('[data-rmb-dlg]');
    var close = function () { dlg.remove(); };
    dlg.querySelector('[data-close]').onclick = close;
    dlg.onclick = function (ev) { if (ev.target === dlg) close(); };
    dlg.querySelector('[data-go-create]').onclick = function () {
      var v = function (k) { return dlg.querySelector('[data-m="' + k + '"]'); };
      var at = v('starts_at').value ? new Date(v('starts_at').value).getTime() : null;
      this.disabled = true;
      req('POST', 'rooms', { lead_id: lead, kind: v('kind').value, starts_at: at, duration_min: Number(v('duration_min').value), email: v('email').checked, mode: 'meeting' }).then(function (r) {
        var out = dlg.querySelector('[data-out]');
        if (!r.ok) { out.innerHTML = '<p class="muted">' + esc(r.error || 'Could not create it') + '</p>'; return; }
        out.innerHTML = '<p class="rmb-links">' + (r.emailed ? 'Invite emailed. ' : v('email').checked ? 'The email didn’t send (no address, or email isn’t connected). Copy the link instead. ' : '') +
          '<a class="btn-sm" href="' + esc(r.hostUrl) + '" target="_blank" rel="noopener">Open as host</a> <button class="btn-sm ghost" data-cg>Copy their link</button></p>';
        out.querySelector('[data-cg]').onclick = function () { copy(r.guestUrl, function (t) { var n = document.createElement('p'); n.className = 'muted'; n.textContent = t; out.appendChild(n); }); };
        dlg.querySelector('[data-go-create]').remove();
        dlg.querySelector('[data-close]').textContent = 'Done';
      });
    };
  });

  root.RoomsBoard = { render: render, section: section };
})(window);
