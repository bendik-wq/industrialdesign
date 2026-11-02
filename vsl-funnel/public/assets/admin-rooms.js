/* Funnel HQ → Rooms: our own video rooms (src/rooms). Live webinars and challenge days that run in our room, and
   meeting rooms for clients and leads (onboarding, kickoff, weekly working sessions). Attendance per person and
   recordings come from the rooms themselves. Loaded before admin.js, which calls RoomsBoard.render(ctx) for the
   Rooms tab and RoomsBoard.section(ctx) under Live webinars. The "Meeting room" buttons in the lead and client
   drawers are handled here too (data-room-new). Webinars show how their audience watches (MoQ or the SFU), the
   host's MoQ broadcast health, and a per-room choice of auto, SFU only or MoQ. */
(function (root) {
  'use strict';
  var CSS = '.rmb-list td{vertical-align:top}.rmb-act{display:flex;flex-wrap:wrap;gap:6px}.rmb-form{display:flex;flex-wrap:wrap;gap:10px;align-items:end}.rmb-form label{display:grid;gap:4px;font-size:13px;color:var(--ink-2)}' +
    '.rmb-dlg{position:fixed;inset:0;z-index:200;display:grid;place-items:center;padding:16px;background:rgba(0,0,0,.35)}.rmb-dlg-in{background:#fff;border-radius:14px;padding:24px;max-width:460px;width:100%;display:grid;gap:12px}' +
    '.rmb-dlg-in h2{margin:0}.rmb-dlg-in label{display:grid;gap:4px;font-size:13px;color:var(--ink-2)}.rmb-links{font-size:13px;overflow-wrap:anywhere}.rmb-todo li{margin:4px 0;font-size:13px}.rmb-bc{display:grid;gap:4px;font-size:13px}.rmb-bc select{font-size:13px;padding:4px 6px}' +
    '.rmb-eng{display:grid;gap:18px;padding:8px 0}.rmb-eng h3{margin:0 0 6px;font-size:14px}.rmb-g2{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:18px}.rmb-bars{display:grid;gap:4px;font-size:12px}.rmb-bar{display:grid;grid-template-columns:90px 1fr 40px;gap:8px;align-items:center}.rmb-bar i{display:block;height:8px;border-radius:4px;background:#0f2c5c}' +
    '.rmb-curve{width:100%;height:120px;background:#f5f5f7;border-radius:10px}.rmb-curve polyline{fill:none;stroke:#0f2c5c;stroke-width:2;vector-effect:non-scaling-stroke}.rmb-tl{list-style:none;margin:0;padding:0;font-size:13px}.rmb-tl li{padding:4px 0;border-top:1px solid rgba(0,0,0,.08)}.rmb-tl time{color:var(--ink-2);margin-right:8px;font-variant-numeric:tabular-nums}' +
    '.rmb-eng textarea{width:100%;min-height:120px;font:13px/1.4 ui-monospace,Menlo,monospace}.rmb-eng table td,.rmb-eng table th{font-size:12px}';
  var KIND = { live: 'Live webinar', challenge: 'Challenge day', lead: 'Meeting', none: 'Room' };
  var STATUS = { scheduled: 'Scheduled', live: 'Live', ended: 'Ended', cancelled: 'Cancelled' };
  var BCAST = [['', 'Default'], ['auto', 'Auto'], ['moq', 'MoQ'], ['sfu', 'SFU only']];
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
    return '<div class="table-wrap"><table class="rmb-list"><thead><tr><th>When</th><th>Room</th><th>Kind</th><th>Status</th><th class="num">People</th><th class="num">Minutes</th><th class="num">Peak</th><th>Viewers and broadcast</th><th></th></tr></thead><tbody>' +
      rooms.slice(0, o && o.limit || 200).map(function (r) {
        return '<tr data-rmb-row="' + esc(r.id) + '"><td>' + esc(fmt(r.starts_at)) + '</td><td><strong>' + esc(r.title) + '</strong>' + (r.guest ? '<div class="muted">' + esc(r.guest) + '</div>' : '') + '</td><td>' + esc((r.mode === 'meeting' ? 'Meeting' : KIND[r.ref_type] || 'Room')) + '</td><td>' + esc(STATUS[r.status] || r.status) + '</td>' +
          '<td class="num">' + esc(r.people) + '</td><td class="num">' + esc(r.minutes) + '</td><td class="num">' + esc(r.peak) + '</td>' +
          '<td>' + (r.mode === 'webinar' ? '<div class="rmb-bc"><select data-rmb-bc="' + esc(r.id) + '" aria-label="How viewers watch">' + BCAST.map(function (b) { return '<option value="' + b[0] + '"' + ((r.broadcast || '') === b[0] ? ' selected' : '') + '>' + esc(b[1]) + '</option>'; }).join('') + '</select><span class="muted" data-rmb-live="' + esc(r.id) + '">' + (r.status === 'live' ? 'Checking…' : '–') + '</span></div>' : '<span class="muted">Meeting (SFU)</span>') + '</td>' +
          '<td><div class="rmb-act"><a class="btn-sm" href="' + esc(r.hostUrl) + '" target="_blank" rel="noopener">Open as host</a><button class="btn-sm ghost" data-rmb-links="' + esc(r.id) + '">Links</button><button class="btn-sm ghost" data-rmb-detail="' + esc(r.id) + '">Attendance</button>' +
          (r.mode === 'webinar' ? '<button class="btn-sm ghost" data-rmb-eng="' + esc(r.id) + '">Engagement</button>' : '') +
          (r.lead_id && r.status !== 'cancelled' ? '<button class="btn-sm ghost" data-rmb-email="' + esc(r.id) + '">Email invite</button>' : '') + '</div></td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function rate(k) { return k == null ? '' : k >= 1000 ? (k / 1000).toFixed(1) + ' Mbps' : k + ' kbps'; }
  /** One line per live webinar from its Durable Object: real viewers on each path and the host's MoQ broadcast. */
  function liveLine(b) {
    if (!b) return '–';
    var head = b.mode === 'sfu' ? 'SFU only' : !b.ready ? 'MoQ not set up' : b.live ? 'Broadcasting ' + rate(b.kbps) + (b.fps != null ? ', ' + b.fps + ' fps' : '') : 'Not broadcasting' + (b.error ? ' (' + b.error + ')' : '');
    var auto = b.mode === 'auto' && !b.engaged && b.ready ? ' · MoQ from ' + b.minAudience + ' viewers' : '';
    return b.moq + ' on MoQ · ' + b.sfu + ' on SFU · ' + head + auto;
  }
  function wire(box, ctx, reload) {
    box.querySelectorAll('[data-rmb-bc]').forEach(function (sel) {
      sel.onchange = function () {
        var id = sel.getAttribute('data-rmb-bc');
        sel.disabled = true;
        req('POST', 'rooms/' + id + '/broadcast', { mode: sel.value || null }).then(function (d) {
          sel.disabled = false;
          if (!d.ok) { ctx.toast(d.error || 'Not saved'); return; }
          ctx.toast('Saved: viewers use ' + (d.effective === 'sfu' ? 'the SFU only' : d.effective === 'moq' ? 'MoQ' : 'auto'));
          var out = box.querySelector('[data-rmb-live="' + id + '"]'); if (out && d.live && d.live.broadcast) out.textContent = liveLine(d.live.broadcast);
        });
      };
    });
    box.querySelectorAll('[data-rmb-live]').forEach(function (out) {
      if (out.textContent === '–') return;
      req('GET', 'rooms/' + out.getAttribute('data-rmb-live') + '/live').then(function (d) { out.textContent = liveLine(d && d.broadcast); }).catch(function () { out.textContent = '–'; });
    });
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
    box.querySelectorAll('[data-rmb-eng]').forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-rmb-eng');
        var row = box.querySelector('[data-rmb-row="' + id + '"]');
        var next = row.nextElementSibling;
        if (next && next.hasAttribute('data-rmb-engrow')) { next.remove(); return; }
        req('GET', 'rooms/' + id + '/engage').then(function (d) {
          row.insertAdjacentHTML('afterend', '<tr data-rmb-engrow><td colspan="9">' + engagePanel(d) + '</td></tr>');
          var el = row.nextElementSibling;
          wireEngage(el, id, ctx);
        });
      };
    });
    box.querySelectorAll('[data-rmb-detail]').forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-rmb-detail');
        var row = box.querySelector('[data-rmb-row="' + id + '"]');
        var next = row.nextElementSibling;
        if (next && next.hasAttribute('data-rmb-att')) { next.remove(); return; }
        req('GET', 'rooms/' + id).then(function (d) {
          var att = d.attendance || [], recs = d.recordings || [];
          var html = '<tr data-rmb-att><td colspan="9">' +
            (att.length ? '<table><thead><tr><th>Who</th><th>Role</th><th>First joined</th><th>Last seen</th><th class="num">Minutes</th><th class="num">Joins</th><th>On stage</th></tr></thead><tbody>' + att.map(function (a) {
              return '<tr><td>' + esc(a.name) + (a.email ? '<div class="muted">' + esc(a.email) + '</div>' : '') + '</td><td>' + esc(a.role) + '</td><td>' + esc(fmt(a.first_at)) + '</td><td>' + esc(fmt(a.last_at)) + '</td><td class="num">' + esc(a.minutes) + '</td><td class="num">' + esc(a.joins) + '</td><td>' + (a.on_stage_at ? esc(fmt(a.on_stage_at)) : '–') + '</td></tr>';
            }).join('') + '</tbody></table>' : '<p class="muted">Nobody has joined this room yet.</p>') +
            '<p style="margin-top:10px"><strong>Recordings</strong> ' + (recs.length ? recs.map(function (r) { return r.url ? '<a href="' + esc(r.url) + '" target="_blank" rel="noopener">' + esc(fmt(r.started_at)) + '</a> (' + ((r.bytes || 0) / 1048576).toFixed(1) + ' MB)' : esc(fmt(r.started_at)) + ' (' + esc(r.status) + ')'; }).join(' · ') : '<span class="muted">none yet</span>') + '</p></td></tr>';
          row.insertAdjacentHTML('afterend', html);
        });
      };
    });
  }

  // ── Engagement per room: the push funnel, points, retention, top questions, people, one person's timeline ──
  var KINDS = { application: 'Application', sprint: 'First Deal Sprint card', deposit: 'Deposit card', vip: 'Challenge VIP', resource: 'Resource' };
  function curve(points) {
    if (!points.length) return '<p class="muted">No minutes recorded yet (the curve starts when the host goes live).</p>';
    var max = Math.max.apply(null, points.map(function (p) { return p.n; }).concat([1])), last = points[points.length - 1].minute || 1;
    var pts = points.map(function (p) { return (p.minute / last * 100).toFixed(2) + ',' + (100 - p.n / max * 100).toFixed(2); }).join(' ');
    return '<svg class="rmb-curve" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Attendees in the room by minute"><polyline points="' + pts + '"/></svg>' +
      '<p class="muted" style="font-size:12px">Peak ' + max + ' attendees · ' + points.length + ' minutes recorded · ' + (points[points.length - 1].n) + ' at the last minute</p>';
  }
  function engagePanel(d) {
    if (!d || !d.ok) return '<p class="muted">Couldn’t load the engagement for this room.</p>';
    var F = ['shown', 'opened', 'started', 'submitted', 'paid'];
    var pushes = (d.pushes || []).length ? '<table><thead><tr><th>Push</th><th class="num">Sent to</th>' + F.map(function (f) { return '<th class="num">' + f.charAt(0).toUpperCase() + f.slice(1) + '</th>'; }).join('') + '<th class="num">Dismissed</th></tr></thead><tbody>' +
      d.pushes.map(function (p) { return '<tr><td>' + esc(p.title || KINDS[p.kind] || p.kind) + (p.open ? '' : ' <span class="muted">(down)</span>') + '</td><td class="num">' + esc(p.targets) + '</td>' + F.map(function (f) { return '<td class="num">' + esc(p.counts[f]) + '</td>'; }).join('') + '<td class="num">' + esc(p.counts.dismissed) + '</td></tr>'; }).join('') + '</tbody></table>' : '<p class="muted">Nothing pushed in this room yet.</p>';
    var maxB = Math.max.apply(null, (d.points.buckets || []).map(function (b) { return b.n; }).concat([1]));
    var bars = '<div class="rmb-bars">' + (d.points.buckets || []).map(function (b) { return '<div class="rmb-bar"><span>' + b.from + (b.to ? '–' + (b.to - 1) : '+') + ' pts</span><i style="width:' + Math.round(b.n / maxB * 100) + '%"></i><span class="num">' + b.n + '</span></div>'; }).join('') + '</div>';
    var qs = (d.questions || []).length ? '<ol style="margin:0;padding-left:18px;font-size:13px">' + d.questions.map(function (q) { return '<li>' + esc(q.text) + ' <span class="muted">· ' + q.votes + ' votes · ' + esc(q.name) + (q.answered ? ' · answered' : '') + '</span></li>'; }).join('') + '</ol>' : '<p class="muted">No questions yet.</p>';
    var quiz = (d.quiz || []).length ? '<ul style="margin:0;padding-left:18px;font-size:13px">' + d.quiz.map(function (q) { return '<li>' + esc(q.question) + ' <span class="muted">· ' + q.right + ' of ' + q.answers + ' right</span></li>'; }).join('') + '</ul>' : '<p class="muted">No knowledge checks yet.</p>';
    var apps = (d.applications || []).length ? '<ul style="margin:0;padding-left:18px;font-size:13px">' + d.applications.map(function (a) { return '<li>' + esc(a.name) + ' · tier ' + esc(a.tier || '–') + (a.score != null ? ' · score ' + a.score : '') + '</li>'; }).join('') + '</ul>' : '<p class="muted">No applications from this room yet.</p>';
    var people = (d.people || []).length ? '<div class="table-wrap"><table><thead><tr><th>Who</th><th class="num">Points</th><th class="num">Minutes</th><th class="num">Unlocks</th><th class="num">Deal Plan steps</th><th>Applied</th><th>Tier</th><th></th></tr></thead><tbody>' +
      d.people.map(function (p) { return '<tr><td>' + esc(p.name) + (p.email ? '<div class="muted">' + esc(p.email) + '</div>' : '') + '</td><td class="num">' + p.points + '</td><td class="num">' + p.minutes + '</td><td class="num">' + p.unlocks + '</td><td class="num">' + p.planSteps + ' of 4</td><td>' + (p.applied ? 'Yes' : '–') + '</td><td>' + esc(p.tier || '–') + '</td><td><button class="btn-sm ghost" data-rmb-person="' + esc(p.who) + '">Timeline</button></td></tr>'; }).join('') + '</tbody></table></div>' : '<p class="muted">Nobody in the audience yet.</p>';
    var rules = Object.keys(d.rules || {}).map(function (k) { var r = d.rules[k]; return esc(r.label) + ' +' + r.points + (r.cap > 1 ? ' (up to ' + r.cap + ')' : ''); }).join(' · ');
    var unlocks = (d.unlocks || []).map(function (u) { return esc(u.title) + ' at ' + (u.at === 'end' ? 'the end' : u.at + ' points'); }).join(' · ');
    return '<div class="rmb-eng">' +
      '<div><h3>Pushes: shown, opened, started, submitted, paid</h3>' + pushes + '</div>' +
      '<div class="rmb-g2"><div><h3>Points distribution</h3>' + bars + '</div><div><h3>Retention</h3>' + curve(d.retention || []) + '</div></div>' +
      '<div class="rmb-g2"><div><h3>Top questions</h3>' + qs + '</div><div><h3>Knowledge checks</h3>' + quiz + '<h3 style="margin-top:12px">Applications (tier is team-only)</h3>' + apps + '</div></div>' +
      '<div><h3>People</h3>' + people + '<div data-rmb-tl></div></div>' +
      '<div class="rmb-g2"><div><h3>Agenda for this room</h3><p class="muted" style="font-size:12px">One chapter per line: Title | teaser shown as “Next up”. Blank lines are ignored; an empty box uses the default agenda.</p><textarea data-rmb-agenda>' + esc(d.agendaText || '') + '</textarea>' +
        '<label style="display:flex;gap:8px;align-items:center;font-size:13px;margin:8px 0"><input type="checkbox" data-rmb-board' + (d.settings && d.settings.board ? ' checked' : '') + '> Leaderboard starts on (first names of people who opt in, never emails; the host can hide it)</label><button class="btn-sm" data-rmb-save>Save</button></div>' +
        '<div><h3>Rules (Settings → Live)</h3><p class="muted" style="font-size:12px">' + rules + '</p><p class="muted" style="font-size:12px">Unlocks: ' + unlocks + '</p><h3 style="margin-top:12px">Summary emails</h3><p class="muted" style="font-size:12px">Each attendee gets their points, unlocks, Deal Plan, application status and the offer’s real close time if they didn’t buy, 10 minutes after the session ends (once each, never to the unsubscribed).</p><button class="btn-sm ghost" data-rmb-sum>Send the summaries now</button></div></div>' +
      '</div>';
  }
  function wireEngage(el, id, ctx) {
    var tl = el.querySelector('[data-rmb-tl]');
    el.querySelectorAll('[data-rmb-person]').forEach(function (b) {
      b.onclick = function () {
        req('GET', 'rooms/' + id + '/engage/person/' + encodeURIComponent(b.getAttribute('data-rmb-person'))).then(function (d) {
          var plan = d.plan ? '<p style="font-size:13px"><strong>Deal Plan:</strong> ' + esc([d.plan.industry, d.plan.size, d.plan.geography].filter(Boolean).join(', ') || '–') + (d.plan.owners_per_week ? ' · ' + esc(d.plan.owners_per_week) + ' owners a week' : '') + (d.plan.coverage ? ' · ' + d.plan.coverage.ratio + 'x' + (d.plan.coverage.passes ? ' (passes 1.5x)' : ' (below 1.5x)') : '') + [d.plan.action_1, d.plan.action_2, d.plan.action_3].filter(Boolean).map(function (a, i) { return '<br>' + (i + 1) + '. ' + esc(a); }).join('') + '</p>' : '';
          tl.innerHTML = '<h3 style="margin-top:12px">' + esc(d.name) + '</h3>' + plan + '<ul class="rmb-tl">' + (d.items || []).map(function (it) { return '<li><time>' + esc(fmt(it.at)) + '</time>' + esc(it.text) + '</li>'; }).join('') + '</ul>';
        });
      };
    });
    el.querySelector('[data-rmb-save]').onclick = function () {
      req('POST', 'rooms/' + id + '/engage', { agenda: el.querySelector('[data-rmb-agenda]').value, board: el.querySelector('[data-rmb-board]').checked }).then(function (d) { ctx.toast(d.ok ? 'Saved: the room picks it up on the next join' : (d.error || 'Not saved')); });
    };
    el.querySelector('[data-rmb-sum]').onclick = function () {
      var b = this; b.disabled = true;
      req('POST', 'rooms/' + id + '/summaries').then(function (d) { b.disabled = false; ctx.toast(d.ok ? 'Summaries: ' + d.sent + ' sent, ' + d.skipped + ' skipped' : (d.error || 'Not sent')); });
    };
  }

  function render(ctx) {
    css();
    var view = ctx.view;
    return req('GET', 'rooms').then(function (d) {
      var todo = (d.todo || []).length ? '<div class="card"><h2>To finish setting up rooms</h2><ul class="rmb-todo">' + d.todo.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul></div>' : '';
      var s = d.setup || {};
      view.innerHTML = '<div class="grid g-4 tiles">' +
        ctx.tile('Video (SFU)', s.sfu ? 'Connected' : 'Not set', 'Cloudflare Realtime app') + ctx.tile('TURN', s.turn ? 'Connected' : 'Not set', 'for strict office and hotel networks') +
        ctx.tile('Recordings', s.r2 ? 'R2 bucket' : 'Download', s.r2 ? 'uploaded and used as the replay' : 'no RECORDINGS bucket bound yet') + ctx.tile('Rooms', ctx.n((d.rooms || []).length), 'live, challenge and meetings') + '</div>' +
        '<div class="grid g-4 tiles" style="margin-top:14px">' + ctx.tile('Big webinars (MoQ)', s.moq ? 'Connected' : 'Not set', s.moq ? 'Cloudflare MoQ relay, tokens valid until ' + (s.moqExpires ? new Date(s.moqExpires).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '–') : 'every viewer watches over the SFU') +
        ctx.tile('Default for webinars', s.broadcast === 'sfu' ? 'SFU only' : s.broadcast === 'moq' ? 'MoQ' : 'Auto', s.broadcast === 'auto' ? 'MoQ from ' + s.moqAudience + ' viewers at once' : 'ROOM_BROADCAST; change per room below') + '</div>' + todo +
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
