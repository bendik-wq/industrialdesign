/* Funnel HQ → Live webinars: scheduled live events on Zoom (create, registrants, attendance, deposit buyers, the
   report and the ladder) and the host's offer controls (Open the offer, Show timer, Pin message, Close offer, polls).
   Two places load it:
     - Funnel HQ (admin.js calls LiveEventsBoard.render(ctx) with its helpers);
     - the host console /admin/live/webinar:<id> (builder A's page): it mounts the offer controls into
       #live-controls by itself when the key belongs to a live webinar event. */
(function (root) {
  'use strict';
  var CSS = '.leb-controls{display:grid;gap:12px}.leb-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.leb-state{font-size:14px}.leb-state b{font-variant-numeric:tabular-nums}' +
    '.leb-big{min-height:44px;padding:0 18px;border-radius:999px;border:0;font:600 15px/1 system-ui,-apple-system,sans-serif;cursor:pointer}.leb-open{background:#f5b82e;color:#1d1d1f}.leb-close{background:#1d1d1f;color:#fff}' +
    '.leb-form{display:grid;gap:8px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));align-items:end}.leb-form label{display:grid;gap:4px;font-size:13px}.leb-legal{border-left:3px solid #b45309;padding:8px 12px;background:#fffbeb;font-size:13px}' +
    '.leb-gt ol{margin:6px 0 0;padding-left:20px;font-size:13px}.leb-todo li{margin:4px 0;font-size:13px}.leb-ev{cursor:pointer}.leb-ev:hover td{background:rgba(15,44,92,.04)}';
  function css() { if (!document.getElementById('leb-css')) { var s = document.createElement('style'); s.id = 'leb-css'; s.textContent = CSS; document.head.appendChild(s); } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function when(ms) { if (!ms) return '–'; var d = new Date(ms); return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
  function left(ms) { var s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return h + ':' + (m < 10 ? '0' : '') + m + ':' + (x < 10 ? '0' : '') + x; }
  function req(method, path, body) {
    return fetch('/admin/api/' + path, { method: method, credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }); });
  }
  var STAGE = { waiting: 'Scheduled', live: 'Live now', replay: 'Replay open', closed: 'Closed', cancelled: 'Cancelled' };

  // ───────────── host controls (Funnel HQ and the host console) ─────────────
  function controls(el, id, toast) {
    css();
    toast = toast || function (m) { var t = document.createElement('div'); t.className = 'toast'; t.textContent = m; document.body.appendChild(t); setTimeout(function () { t.remove(); }, 2600); };
    var hostId = Math.random().toString(36).slice(2, 12);
    var data = null, timer = null, ping = null;
    function act(body) { return req('POST', 'live-events/' + encodeURIComponent(id) + '/host', body).then(function (r) { if (!r.ok) toast(r.error || 'Could not do that'); return load(); }); }
    function draw() {
      var o = data.offer, ev = data.event, R = data.report;
      var state = o.open ? 'Offer open · closes in <b data-leb-left>' + left(o.closesAt - Date.now()) + '</b> (' + esc(when(o.closesAt)) + ')' : o.opened ? 'Offer closed ' + esc(when(o.closesAt)) : 'Offer not opened yet';
      el.innerHTML = '<div class="card leb-controls"><h2 style="margin:0">The offer · ' + esc(ev.title) + '</h2>' +
        '<p class="leb-state">' + state + ' · ' + esc(STAGE[ev.stage] || ev.stage) + ' · in the room now: ' + esc(R.inRoomNow) + ' · peak ' + esc(R.peak) + ' · deposits ' + esc(R.deposits) + '</p>' +
        '<div class="leb-row">' + (o.open ? '<button class="leb-big leb-close" data-a="close_offer">Close offer</button>' : (!o.opened ? '<button class="leb-big leb-open" data-a="open_offer">OPEN OFFER</button>' : '')) +
        '<button class="btn-sm ghost" data-a="' + (o.timerOn ? 'timer_off' : 'timer_on') + '">' + (o.timerOn ? 'Hide timer' : 'SHOW TIMER') + '</button>' +
        (ev.ended_at ? '' : '<button class="btn-sm ghost" data-a="end">End the event</button>') + '</div>' +
        '<p class="muted" style="margin:0;font-size:12.5px">Open the offer: every room shows the deposit offer at once (late joiners too), changes its tab title and sends a notification to viewers who allowed it. Tell people to go back to the tab they came from. It closes ' + esc(o.hours) + ' hours after the event ends, or when you press Close offer. A closed offer stays closed.</p>' +
        '<div class="leb-row"><input class="input" data-pin-text maxlength="280" placeholder="Pin a message in every room" value="' + esc(o.pinned || '') + '" style="flex:1;min-width:200px"><button class="btn-sm" data-pin>PIN message</button>' + (o.pinned ? '<button class="btn-sm ghost" data-a="unpin">Unpin</button>' : '') + '</div>' +
        '<div class="leb-row"><span class="muted" style="font-size:13px">Script polls:</span>' + [['target_type', 'POLL target_type'], ['timeline', 'POLL timeline'], ['blocker', 'POLL blocker'], ['own_cash', 'POLL own_cash'], ['buy_in', 'POLL buy_in']].map(function (x) { return '<button class="btn-sm ghost" data-preset="' + x[0] + '">' + x[1] + '</button>'; }).join('') + '<button class="btn-sm ghost" data-a="take_questions">TAKE QUESTIONS</button></div>' +
        '<div class="leb-row"><input class="input" data-poll-q placeholder="Or type a poll question" style="flex:1;min-width:200px"><input class="input" data-poll-o placeholder="Answers, separated by |" style="flex:1;min-width:200px"><button class="btn-sm" data-poll>Push poll</button>' + (data.polls.some(function (p) { return p.open; }) ? '<button class="btn-sm ghost" data-poll-close>Close poll</button>' : '') + '</div>' +
        (data.polls.length ? '<div class="muted" style="font-size:13px">' + data.polls.slice(0, 3).map(function (p) { return esc(p.question) + ': ' + (p.sentences ? p.sentences.length + ' sentences' + (p.sentences.length ? ': “' + p.sentences.slice(0, 5).map(esc).join('” · “') + '”' : '') : p.options.map(function (x, i) { return esc(x) + ' ' + p.counts[i]; }).join(' · ')) + (p.open ? ' (open)' : ''); }).join('<br>') + '</div>' : '') +
        '<div class="leb-row"><input class="input" data-chat-t maxlength="400" placeholder="Message the chat as the team" style="flex:1;min-width:200px"><button class="btn-sm" data-chat>Send</button></div></div>';
      el.hidden = false;
      el.querySelectorAll('[data-a]').forEach(function (b) { b.onclick = function () { if (b.getAttribute('data-a') === 'open_offer' && !confirm('Open the deposit offer in every room now?')) return; if (b.getAttribute('data-a') === 'close_offer' && !confirm('Close the offer now? It can’t be reopened for this event.')) return; act({ action: b.getAttribute('data-a') }); }; });
      el.querySelectorAll('[data-preset]').forEach(function (b) { b.onclick = function () { req('POST', 'live-events/' + encodeURIComponent(id) + '/poll', { preset: b.getAttribute('data-preset') }).then(function (r) { toast(r.ok ? 'Poll pushed to every room' : r.error); load(); }); }; });
      el.querySelector('[data-pin]').onclick = function () { act({ action: 'pin', text: el.querySelector('[data-pin-text]').value }); };
      el.querySelector('[data-poll]').onclick = function () { req('POST', 'live-events/' + encodeURIComponent(id) + '/poll', { question: el.querySelector('[data-poll-q]').value, options: el.querySelector('[data-poll-o]').value.split('|') }).then(function (r) { toast(r.ok ? 'Poll pushed' : r.error); load(); }); };
      var pc = el.querySelector('[data-poll-close]'); if (pc) pc.onclick = function () { req('POST', 'live-events/' + encodeURIComponent(id) + '/poll/close', {}).then(load); };
      el.querySelector('[data-chat]').onclick = function () { req('POST', 'live-events/' + encodeURIComponent(id) + '/chat', { text: el.querySelector('[data-chat-t]').value }).then(function (r) { toast(r.ok ? 'Sent' : r.error); }); };
    }
    function load() {
      return req('GET', 'live-events/' + encodeURIComponent(id)).then(function (d) {
        if (!d || !d.event) { el.hidden = true; stop(); return null; }
        var typing = el.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
        data = d; if (!typing) draw();
        return d;
      });
    }
    function stop() { clearInterval(timer); clearInterval(ping); }
    load();
    timer = setInterval(function () { if (!document.body.contains(el)) return stop(); var l = el.querySelector('[data-leb-left]'); if (l && data) l.textContent = left(data.offer.closesAt - Date.now()); }, 1000);
    ping = setInterval(function () { if (!document.body.contains(el)) return stop(); req('POST', 'live-events/' + encodeURIComponent(id) + '/ping', { host: hostId }); load(); }, 8000);
    req('POST', 'live-events/' + encodeURIComponent(id) + '/ping', { host: hostId });
    return { stop: stop };
  }

  // On the host console page: mount into #live-controls for live webinar events (keys webinar:le…).
  function autoMount() {
    var slot = document.getElementById('live-controls');
    var key = slot && slot.getAttribute('data-live-key');
    var m = key && /^webinar:(le[0-9a-z]+)$/.exec(key);
    if (m) controls(slot, m[1]);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoMount); else autoMount();

  // ───────────── Funnel HQ tab ─────────────
  var selected = null;
  function render(ctx) {
    css();
    var view = ctx.view, n = ctx.n, pct = ctx.pct, tile = ctx.tile, toast = ctx.toast;
    return ctx.api('live-events').then(function (d) {
      var S = d.settings || {}, G = d.guarantee || {};
      var cfg = S.deposit || {};
      var tzs = ['Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane', 'Australia/Perth', 'Pacific/Auckland', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'UTC'];
      if (S.tz && tzs.indexOf(S.tz) < 0) tzs.unshift(S.tz);
      var L = d.ladder || { steps: [] }, prev = null;
      var ladder = '<div class="card" style="margin-top:14px"><h2>The ladder</h2><p class="sub">Live webinar events in the selected range: from registration to a signed engagement. Revenue is tickets plus deposits, net of refunds.</p><div class="table-wrap"><table><thead><tr><th>Step</th><th class="num">People</th><th class="num">From the step before</th></tr></thead><tbody>' +
        L.steps.map(function (s) { var r = prev ? s.n / prev : null; prev = s.n || prev; return '<tr><td>' + esc(s.label) + '</td><td class="num">' + n(s.n) + '</td><td class="num">' + (r == null ? '–' : pct(r, 1)) + '</td></tr>'; }).join('') +
        '</tbody></table></div><p class="muted">Revenue ' + esc(L.revenue) + (L.perRegistrant ? ' · per registrant ' + esc(L.perRegistrant) : '') + '</p></div>';
      var rows = (d.events || []).map(function (e) {
        return '<tr class="leb-ev" data-ev="' + esc(e.id) + '"><td>' + esc(e.when) + '</td><td>' + esc(e.title) + '</td><td>' + esc(STAGE[e.stage] || e.stage) + '</td><td class="num">' + n(e.registered) + '</td><td class="num">' + n(e.attended) + '</td><td class="num">' + (e.showRate == null ? '–' : pct(e.showRate)) + '</td><td class="num">' + n(e.peak || 0) + '</td><td class="num">' + n(e.deposits) + '</td><td class="nw"><a class="btn-sm ghost" href="' + esc(e.consoleUrl) + '" target="_blank" rel="noopener">Host console</a></td></tr>';
      }).join('');
      var todo = (d.todo || []).length ? '<div class="card" style="margin-top:14px"><h2>To do before the first event</h2><ul class="leb-todo">' + d.todo.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul></div>' : '';
      view.innerHTML =
        '<div class="grid g-4 tiles">' +
          tile('Deposit', cfg.label || '–', 'credited in full against the engagement fee') +
          tile('Ticket', S.ticket || 'No charge', S.ticket ? 'paid on our Whop page, card saved for one click' : 'set LIVE_TICKET_PRICE for a paid ticket') +
          tile('Offer closes', (S.offerHours || 48) + 'h after', 'the event ends (the replay closes with it)') +
          tile('Intake this week', S.cap && S.cap.cap ? S.cap.used + ' of ' + S.cap.cap : 'No cap', S.cap && S.cap.cap ? 'paid deposits plus open checkouts' : 'set ENGAGEMENT_INTAKE_CAP to cap places') +
        '</div>' + todo +
        '<div class="card" style="margin-top:14px"><h2>New live webinar</h2><p class="sub">The landing page /live always shows the next scheduled event with a real countdown. Paste the Zoom link here or in the host console (or create the meeting there through the Zoom API).</p>' +
          '<div class="leb-form"><label>Title<input class="input" data-f="title" placeholder="Buy your first competitor with the bank’s money and the seller’s"></label>' +
          '<label>Date and time<input class="input" type="datetime-local" data-f="starts_at"></label>' +
          '<label>Time zone<select class="input" data-f="tz">' + tzs.map(function (z) { return '<option' + (z === S.tz ? ' selected' : '') + '>' + esc(z) + '</option>'; }).join('') + '</select></label>' +
          '<label>Length (minutes)<input class="input" type="number" min="30" max="300" value="120" data-f="duration_min"></label>' +
          '<label>Zoom link<input class="input" type="url" data-f="join_url" placeholder="https://zoom.us/j/…"></label>' +
          '<button class="btn-sm" type="button" data-create>Create event</button></div></div>' +
        '<div class="card" style="margin-top:14px"><h2>Events</h2>' + (rows ? '<div class="table-wrap"><table><thead><tr><th>When</th><th>Title</th><th>Stage</th><th class="num">Registered</th><th class="num">Came live</th><th class="num">Show rate</th><th class="num">Peak</th><th class="num">Deposits</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' : ctx.emptyState('No live webinars yet.', 'Create the first one above.')) + '</div>' +
        '<div data-leb-detail></div>' + ladder +
        '<div class="card leb-gt" style="margin-top:14px"><h2>The guarantee</h2><p class="leb-legal">' + esc(G.legalReview) + '</p><p><strong>' + esc(G.headline) + '</strong></p><p>' + esc(G.body) + '</p><ol>' + (G.conditions || []).map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('') + '</ol><p class="muted">' + esc((G.definitions || []).join(' ')) + '</p><p class="muted">Public page: <a href="' + esc(G.url) + '" target="_blank" rel="noopener">' + esc(G.url) + '</a>. In engagement agreements: ' + (S.guaranteeInAgreements ? 'yes' : 'no (ENGAGEMENT_GUARANTEE is off)') + '. Edit the wording with the GUARANTEE_* settings.</p></div>';
      view.querySelector('[data-create]').onclick = function () {
        var b = {}; view.querySelectorAll('[data-f]').forEach(function (i) { b[i.getAttribute('data-f')] = i.value; });
        b.duration_min = Number(b.duration_min);
        req('POST', 'live-events', b).then(function (r) { if (r.ok) { toast('Event created'); selected = r.id; ctx.reload(); } else toast(r.error || 'Could not create it'); });
      };
      view.querySelectorAll('[data-ev]').forEach(function (tr) { tr.onclick = function (e) { if (e.target.closest('a')) return; selected = tr.getAttribute('data-ev'); detail(ctx); }; });
      if (selected || (d.events || [])[0]) { selected = selected || d.events[0].id; detail(ctx); }
    });
  }

  function detail(ctx) {
    var box = ctx.view.querySelector('[data-leb-detail]');
    if (!box) return;
    var n = ctx.n, pct = ctx.pct, tile = ctx.tile;
    req('GET', 'live-events/' + encodeURIComponent(selected)).then(function (d) {
      if (!d || !d.event) { box.innerHTML = ''; return; }
      var R = d.report, ev = d.event, o = d.offer;
      box.innerHTML = '<div class="card" style="margin-top:14px"><h2>' + esc(ev.title) + '</h2><p class="sub">' + esc(ev.when) + ' · ' + esc(STAGE[ev.stage] || ev.stage) + ' · <a href="' + esc(ev.consoleUrl) + '" target="_blank" rel="noopener">Open the host console</a> · landing <a href="' + esc(ev.landing) + '" target="_blank" rel="noopener">' + esc(ev.landing) + '</a></p>' +
        '<div class="grid g-4 tiles">' + tile('Registered', n(R.registered), R.ticketsPaid ? n(R.ticketsPaid) + ' paid tickets' : '') + tile('Came live', n(R.attended), 'show rate ' + (R.showRate == null ? '–' : pct(R.showRate))) + tile('Peak viewers', n(R.peak), 'in the room at once') +
        tile('Offer opened', o.openedAt ? when(o.openedAt) : '–', o.open ? 'open until ' + when(o.closesAt) : o.opened ? 'closed ' + when(o.closesAt) : 'not yet') + tile('Saw the offer', n(R.offerSeen), n(R.offerClicked) + ' pressed the button') + tile('Deposits', n(R.deposits), R.depositRate == null ? '' : pct(R.depositRate) + ' of those who came') + tile('Revenue', R.revenue, 'tickets and deposits, net of refunds') + '</div>' +
        '<div class="leb-form" style="margin-top:12px"><label>Zoom link<input class="input" data-e="join_url" value="' + esc(ev.join_url || '') + '"></label><label>Replay link (shown until the offer closes)<input class="input" data-e="replay_url" value="' + esc(ev.replay_url || '') + '"></label><button class="btn-sm" data-save>Save links</button>' + (ev.status === 'scheduled' ? '<button class="btn-sm ghost" data-cancel>Cancel event</button>' : '') + '</div></div>' +
        '<div data-leb-controls style="margin-top:14px"></div>' +
        '<div class="card" style="margin-top:14px"><h2>Deposit buyers</h2>' + (d.buyers.length ? ctx.table([{ label: 'Who', key: 'name' }, { label: 'Revenue', key: 'band' }, { label: 'Paid', key: 'paid' }, { label: 'Credited', key: 'credit' }, { label: 'One click', fmt: function (_v, r) { return r.oneClick ? 'Yes' : 'No'; } }, { label: 'When', fmt: function (_v, r) { return when(r.at); } }], d.buyers) : ctx.emptyState('No deposits yet.', 'Buyers appear here the moment Whop confirms the payment.')) + '</div>' +
        '<div class="card" style="margin-top:14px"><h2>Registrants</h2>' + ctx.table([{ label: 'Who', key: 'name' }, { label: 'Email', key: 'email' }, { label: 'Revenue', key: 'band' }, { label: 'Registered', fmt: function (_v, r) { return when(r.registered); } }, { label: 'Came live', fmt: function (_v, r) { return r.joined ? when(r.joined) : '–'; } }, { label: 'Saw offer', fmt: function (_v, r) { return r.offerSeen ? 'Yes' : '–'; } }, { label: 'Deposit', fmt: function (_v, r) { return r.deposit ? when(r.deposit) : '–'; } }, { label: 'Ticket', fmt: function (_v, r) { return r.ticket == null ? '–' : r.ticket ? 'Paid' : 'Unpaid'; } }], d.registrants, { cards: true, empty: 'Nobody has registered yet.' }) + '</div>';
      controls(box.querySelector('[data-leb-controls]'), ev.id, ctx.toast);
      box.querySelector('[data-save]').onclick = function () { req('PATCH', 'live-events/' + encodeURIComponent(ev.id), { join_url: box.querySelector('[data-e=join_url]').value, replay_url: box.querySelector('[data-e=replay_url]').value }).then(function (r) { ctx.toast(r.ok ? 'Saved' : r.error); }); };
      var c = box.querySelector('[data-cancel]'); if (c) c.onclick = function () { if (confirm('Cancel this event? Registrants get no more reminders.')) req('PATCH', 'live-events/' + encodeURIComponent(ev.id), { status: 'cancelled' }).then(function () { ctx.reload(); }); };
    });
  }

  root.LiveEventsBoard = { render: render, controls: controls };
})(window);
