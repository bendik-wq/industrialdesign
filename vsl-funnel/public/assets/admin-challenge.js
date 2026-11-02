/* Funnel HQ → Challenge: First Deal Challenge cohorts (create, re-time, Zoom / replay / hot seat links per day),
   the offer switch for Days 4 and 5, registrants with attendance, worksheets and deposits, the VIP hot seat queue,
   worksheet reviews and the report per cohort and per day; each day's automatic pushes in our room, the progress
   dashboard with the at-risk list (round 2) and the homework reminder switch (off by default).
   Loaded before admin.js, which calls ChallengeBoard.render(ctx) with its helpers (api, send, esc, tile, …). */
(function (root) {
  'use strict';
  var CSS = '.chb-card{margin-top:14px}.chb-head{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:baseline;justify-content:space-between}.chb-head h2{margin:0}' +
    '.chb-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;align-items:end}.chb-form label{display:grid;gap:4px;font-size:13px}' +
    '.chb-days{width:100%;border-collapse:collapse;font-size:13px}.chb-days th,.chb-days td{padding:8px 6px;border-top:1px solid var(--line,#e5e7eb);text-align:left;vertical-align:top}' +
    '.chb-days input{width:100%;min-width:0;box-sizing:border-box}.chb-days .num{text-align:right;white-space:nowrap}.chb-links{display:grid;gap:4px;min-width:200px}' +
    '.chb-reg{font-size:13px;width:100%;border-collapse:collapse}.chb-reg td,.chb-reg th{padding:6px;border-top:1px solid var(--line,#e5e7eb);text-align:left}.chb-d{display:inline-flex;gap:3px}' +
    '.chb-d i{display:inline-block;width:14px;height:14px;border-radius:50%;border:1px solid #c7c7cc;font-style:normal}.chb-d i.l{background:#0f2c5c;border-color:#0f2c5c}.chb-d i.r{background:#9fb3d1;border-color:#9fb3d1}.chb-d i.h{box-shadow:inset 0 0 0 3px #fff;outline:2px solid #1d7a4f}' +
    '.chb-hw{border-top:1px solid var(--line,#e5e7eb);padding:10px 0}.chb-hw dl{display:grid;grid-template-columns:minmax(120px,220px) 1fr;gap:4px 12px;margin:6px 0;font-size:13px}.chb-hw dt{color:#6e6e73}.chb-hw textarea{width:100%;min-height:60px}' +
    '.chb-legal{font-size:12px;color:#8a5a00}' +
    '.chb-ap{display:grid;gap:4px;font-size:12px;color:#6e6e73}.chb-ap textarea{width:100%;min-height:52px;font:12px/1.4 ui-monospace,Menlo,monospace;box-sizing:border-box}' +
    '.chb-pg{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}.chb-pg th,.chb-pg td{padding:6px;border-top:1px solid var(--line,#e5e7eb);text-align:right;white-space:nowrap}.chb-pg th:first-child,.chb-pg td:first-child{text-align:left;white-space:normal}' +
    '.chb-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}.chb-risk{width:100%;border-collapse:collapse;font-size:13px}.chb-risk td,.chb-risk th{padding:6px;border-top:1px solid var(--line,#e5e7eb);text-align:left}' +
    '.chb-flag{display:inline-block;padding:1px 6px;border-radius:999px;font-size:11px;background:#f5f5f7;color:#1d1d1f;margin-right:4px}.chb-flag.w{background:#fff4e5;color:#8a5a00}.chb-prefs{display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center}' +
    '@media (max-width:900px){.chb-days thead{display:none}.chb-days tr{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:8px 0;border-top:1px solid var(--line,#e5e7eb)}.chb-days td{border:0;padding:2px 0}.chb-links{grid-column:1/-1}}';

  function render(ctx) {
    var view = ctx.view, esc = ctx.esc, n = ctx.n, pct = ctx.pct, when = ctx.when, tile = ctx.tile, toast = ctx.toast;
    if (!document.getElementById('chb-css')) { var st = document.createElement('style'); st.id = 'chb-css'; st.textContent = CSS; document.head.appendChild(st); }
    return ctx.api('challenge', {}, { noRange: true }).then(function (d) {
      var cur = (d.config && d.config.currency) || 'USD';
      var money = function (v) { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(v || 0); } catch (e) { return cur + ' ' + n(v); } };
      var notes = (d.notes || []).map(function (x) { return '<p class="' + (x.level === 'warn' ? 'warn' : 'muted') + '">' + esc(x.text) + '</p>'; }).join('');
      var c0 = d.config || {};
      var form = '<div class="card"><div class="chb-head"><h2>New cohort</h2><span class="muted">Ticket ' + esc(c0.ticket) + (c0.vip ? ' · VIP ' + esc(c0.vip) : '') + ' · offer closes ' + esc(c0.offerHours) + 'h after Day 5 · <a href="' + esc(d.landing) + '" target="_blank" rel="noopener">landing page ↗</a></span></div>' +
        '<form class="chb-form" data-chb-new>' +
        '<label>Name<input class="input" name="name" placeholder="November cohort" required></label>' +
        '<label>Day 1 date<input class="input" type="date" name="start_date" required></label>' +
        '<label>Daily start time<input class="input" type="time" name="start_time" value="19:00" required></label>' +
        '<label>Time zone<input class="input" name="timezone" value="' + esc(c0.defaultTz || '') + '" placeholder="America/New_York"></label>' +
        '<label>Minutes per session<input class="input" type="number" name="duration_min" min="30" max="240" value="' + esc(c0.durationMin || 90) + '"></label>' +
        '<label>Zoom link for all days (optional)<input class="input" name="join_url" placeholder="https://zoom.us/j/…"></label>' +
        '<button class="btn-sm" type="submit">Create cohort (5 days)</button></form>' +
        '<p class="muted small">Days 2 to 5 follow on the next calendar days at the same local time. Edit any day below. Each day is also listed in its host console, where Zoom meetings can be created.</p></div>';
      var cards = (d.cohorts || []).map(function (co) { return cohortCard(co, money); }).join('');
      var pf = d.prefs || { hwReminders: false, hwHours: { from: 9, to: 19 } };
      var prefs = '<div class="card chb-card"><div class="chb-head"><h2>Homework reminder</h2><span class="muted">' + (pf.hwReminders ? '<strong>On</strong>' : 'Off') + '</span></div>' +
        '<p class="muted small">One email per day to people who attended that day live and haven’t sent the worksheet: at least 4 hours after the session, inside the sending hours in their own time zone, and at least 2 hours before the worksheet is due. Unsubscribed and suppressed addresses never get it. Off until you turn it on.</p>' +
        '<form class="chb-prefs" data-chb-prefs><label><input type="checkbox" name="hwReminders"' + (pf.hwReminders ? ' checked' : '') + '> Send the homework reminder</label>' +
        '<label>Sending hours <input class="input" name="hwHours" value="' + esc(pf.hwHours.from + '-' + pf.hwHours.to) + '" size="6" title="24 hour clock, their time zone"></label><button class="btn-sm" type="submit">Save</button></form></div>';
      view.innerHTML = (notes ? '<div class="card">' + notes + '</div>' : '') + form + prefs + (cards || '<div class="card chb-card"><p class="muted">No cohorts yet. Create the first one above: the landing page shows its real dates and countdown as soon as it exists.</p></div>');
      wire(d, money);
    });

    function autoPushField(dy) {
      var ap = dy.autoPush || {};
      var roomNote = ap.room != null && ap.room.trim() && ap.room.trim() !== String(ap.effective || '').trim() ? '<span>In the room now (set on the room): ' + esc(ap.room.replace(/\n/g, ', ')) + '</span>' : '';
      return '<label class="chb-ap">Automatic pushes in our room (minute, then what)<textarea class="input" data-f="auto_push" placeholder="' + esc(ap.default || '') + '">' + esc(ap.saved || '') + '</textarea>' +
        '<span>' + (ap.saved ? (ap.saved === 'off' ? 'Off for this day.' : 'Your schedule.') : 'Blank = this day’s default.') + ' Deposit lines wait until the host opens the offer.</span>' + roomNote + '</label>';
    }

    function cohortCard(co, money) {
      var s = co.stats || {}, off = co.offer || {};
      var tiles = '<div class="grid g-4 tiles" style="margin:12px 0">' +
        tile('Registered (paid)', n(s.registered), (s.pending ? n(s.pending) + ' started, not paid · ' : '') + (s.refunded ? n(s.refunded) + ' refunded' : '')) +
        tile('VIP take rate', s.vipRate == null ? '–' : pct(s.vipRate), n(s.vip) + ' VIP') +
        tile('Deposits', n(s.deposits), n(s.depositsStarted) + ' started checkout') +
        tile('Revenue', money(s.revenue), 'Per registrant ' + (s.perRegistrant == null ? '–' : money(s.perRegistrant))) + '</div>';
      var rows = co.days.map(function (dy) {
        var ds = (s.days || [])[dy.day - 1] || {};
        var offerBtn = dy.day >= 4 ? '<button class="btn-sm' + (off.open ? ' ghost' : '') + '" data-chb-offer="' + esc(dy.key) + '" data-open="' + (off.open ? '0' : '1') + '"' + (off.expired ? ' disabled' : '') + '>' + (off.expired ? 'Offer closed' : off.open ? 'Close offer' : 'Open offer') + '</button>' : '';
        return '<tr data-chb-day="' + dy.day + '" data-cohort="' + esc(co.id) + '"><td><strong>Day ' + dy.day + '</strong><div class="muted">' + esc(dy.title) + '</div><div class="muted">' + esc(dy.phase) + '</div></td>' +
          '<td><input class="input" type="date" data-f="date" value="' + esc(dy.date) + '"><input class="input" type="time" data-f="time" value="' + esc(dy.time) + '"><input class="input" type="number" data-f="duration_min" value="' + esc(dy.duration_min) + '" title="Minutes"></td>' +
          '<td class="chb-links"><select class="input" data-f="platform" title="Where this day runs"><option value="zoom"' + (dy.platform !== 'room' ? ' selected' : '') + '>Zoom</option><option value="room"' + (dy.platform === 'room' ? ' selected' : '') + '>Our room</option></select><input class="input" data-f="join_url" placeholder="Zoom link" value="' + esc(dy.join_url === 'room' ? '' : dy.join_url || '') + '"><input class="input" data-f="replay_url" placeholder="Replay link (after the session)" value="' + esc(dy.replay_url || '') + '"><input class="input" data-f="hot_seat_url" placeholder="VIP hot seat link (blank = same Zoom)" value="' + esc(dy.hot_seat_url || '') + '">' + autoPushField(dy) + '</td>' +
          '<td class="num">' + n(ds.live) + ' live<br>' + n(ds.replay) + ' replay<br>' + (ds.liveRate == null ? '–' : pct(ds.liveRate)) + '</td>' +
          '<td class="num">' + n(ds.homework) + '<br>' + (ds.homeworkRate == null ? '–' : pct(ds.homeworkRate)) + '</td>' +
          '<td><button class="btn-sm ghost" data-chb-save>Save</button> <a class="btn-sm ghost" href="' + esc(dy.host) + '" target="_blank" rel="noopener">Host console ↗</a> ' + (dy.platform === 'room' ? '<a class="btn-sm" href="/admin/live/' + encodeURIComponent(dy.key) + '/room" target="_blank" rel="noopener">Host room ↗</a> ' : '') + offerBtn + '</td></tr>';
      }).join('');
      return '<div class="card chb-card" data-chb-cohort="' + esc(co.id) + '"><div class="chb-head"><h2>' + esc(co.name) + (co.status === 'cancelled' ? ' <span class="pill">cancelled</span>' : '') + '</h2>' +
        '<span class="muted">' + esc(co.start_date) + ' · ' + esc(co.start_time) + ' ' + esc(co.timezone) + (co.closeAt ? ' · offer closes ' + esc(when(co.closeAt)) : '') + (off.open ? ' · <strong>offer open</strong>' : '') + '</span></div>' + tiles +
        '<table class="chb-days"><thead><tr><th>Day</th><th>When (cohort time zone)</th><th>Links</th><th class="num">Attendance</th><th class="num">Worksheets</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>' +
        '<div class="row" style="gap:8px;margin-top:12px;flex-wrap:wrap"><button class="btn-sm" data-chb-progress="' + esc(co.id) + '">Progress and who’s at risk</button><button class="btn-sm ghost" data-chb-detail="' + esc(co.id) + '">Registrants, worksheets and hot seat</button>' +
        '<button class="btn-sm ghost" data-chb-status="' + esc(co.id) + '" data-to="' + (co.status === 'cancelled' ? 'scheduled' : 'cancelled') + '">' + (co.status === 'cancelled' ? 'Restore cohort' : 'Cancel cohort') + '</button></div>' +
        '<div data-chb-progress-box="' + esc(co.id) + '"></div><div data-chb-detail-box="' + esc(co.id) + '"></div></div>';
    }

    function wire(d, money) {
      var f = view.querySelector('[data-chb-new]');
      if (f) f.onsubmit = function (e) {
        e.preventDefault();
        var b = {}; new FormData(f).forEach(function (v, k) { b[k] = v; });
        ctx.send('POST', 'challenge/cohorts', b).then(function (r) { toast(r.ok ? 'Cohort created' : (r.error || 'Could not create')); if (r.ok) ctx.reload(); });
      };
      view.querySelectorAll('[data-chb-save]').forEach(function (btn) {
        btn.onclick = function () {
          var tr = btn.closest('tr'), b = {};
          tr.querySelectorAll('[data-f]').forEach(function (i) { b[i.getAttribute('data-f')] = i.value; });
          ctx.send('PATCH', 'challenge/cohorts/' + encodeURIComponent(tr.getAttribute('data-cohort')) + '/days/' + tr.getAttribute('data-chb-day'), b).then(function (r) { toast(r.ok ? (r.moved ? 'Saved. Emails and texts re-timed.' : 'Saved') : (r.error || 'Could not save')); if (r.ok) ctx.reload(); });
        };
      });
      view.querySelectorAll('[data-chb-offer]').forEach(function (btn) {
        btn.onclick = function () {
          var open = btn.getAttribute('data-open') === '1';
          if (open && !confirm('Open the deposit offer for this cohort now? Everyone on the day page sees it within seconds.')) return;
          ctx.send('POST', 'challenge/offer/' + encodeURIComponent(btn.getAttribute('data-chb-offer')), { open: open }).then(function (r) { toast(r.ok ? (open ? 'Offer open' : 'Offer closed') : (r.error || 'Could not change')); ctx.reload(); });
        };
      });
      view.querySelectorAll('[data-chb-status]').forEach(function (btn) {
        btn.onclick = function () {
          var to = btn.getAttribute('data-to');
          if (to === 'cancelled' && !confirm('Cancel this cohort? Its emails and texts stop. Refund buyers in Whop.')) return;
          ctx.send('PATCH', 'challenge/cohorts/' + encodeURIComponent(btn.getAttribute('data-chb-status')), { status: to }).then(function (r) { toast(r.ok ? 'Saved' : (r.error || 'Could not save')); ctx.reload(); });
        };
      });
      view.querySelectorAll('[data-chb-detail]').forEach(function (btn) {
        btn.onclick = function () { detail(btn.getAttribute('data-chb-detail'), money); };
      });
      view.querySelectorAll('[data-chb-progress]').forEach(function (btn) {
        btn.onclick = function () { progress(btn.getAttribute('data-chb-progress')); };
      });
      var pf = view.querySelector('[data-chb-prefs]');
      if (pf) pf.onsubmit = function (e) {
        e.preventDefault();
        var on = pf.querySelector('[name=hwReminders]').checked;
        if (on && !(d.prefs && d.prefs.hwReminders) && !confirm('Turn on the homework reminder? From now on, people who attended a day live and haven’t sent its worksheet get one email for that day.')) return;
        ctx.send('PUT', 'challenge/prefs', { hwReminders: on, hwHours: pf.querySelector('[name=hwHours]').value }).then(function (r) { toast(r.ok ? (on ? 'Homework reminder on' : 'Homework reminder off') + (r.changed ? ' (' + r.changed + ' updated)' : '') : (r.error || 'Could not save')); if (r.ok) ctx.reload(); });
      };
    }

    /* The progress dashboard: per day counts, drop-off between days and the at-risk list (a list for the team, nothing is sent from here). */
    function progress(id) {
      var box = view.querySelector('[data-chb-progress-box="' + id + '"]');
      box.innerHTML = '<p class="muted">Loading…</p>';
      ctx.api('challenge/cohorts/' + encodeURIComponent(id) + '/progress', {}, { noRange: true }).then(function (d) {
        var rate = function (v) { return v == null ? '–' : pct(v); };
        var cols = [['Registered', 'registered'], ['Attended live', 'live'], ['Replay only', 'replay'], ['Worksheets', 'homework'], ['VIP there', 'vip'], ['Points', 'points'], ['Applications', 'applications'], ['Deposits', 'deposits']];
        var head = '<tr><th>Day</th>' + cols.map(function (c) { return '<th>' + esc(c[0]) + '</th>'; }).join('') + '<th>Live rate</th><th>Worksheet rate</th><th>Kept from day before</th></tr>';
        var rows = d.days.map(function (x) {
          return '<tr><td><strong>Day ' + x.day + '</strong> <span class="muted">' + esc(x.title) + ' · ' + esc(x.phase) + '</span></td>' + cols.map(function (c) { return '<td>' + n(x[c[1]]) + '</td>'; }).join('') +
            '<td>' + rate(x.liveRate) + '</td><td>' + rate(x.homeworkRate) + '</td><td>' + (x.fromPrev ? n(x.fromPrev.kept) + ' of ' + n(x.fromPrev.came) + ' · ' + rate(x.fromPrev.rate) : '–') + '</td></tr>';
        }).join('');
        var tiles = '<div class="grid g-4 tiles" style="margin:12px 0">' + tile('Registered (paid)', n(d.registered), n(d.vip) + ' VIP') + tile('Points earned in the room', n(d.points), 'Across all days') +
          tile('Applications', n(d.applications), 'In the room or on the application page') + tile('Deposits', n(d.deposits), 'Paid') + '</div>';
        var r = d.atRisk || { list: [] };
        var risk = r.day == null ? '<p class="muted">Nobody is at risk yet: no session has ended.</p>' : !r.list.length ? '<p class="muted">Everyone came to Day ' + r.day + ' and sent the worksheet.</p>' :
          '<p class="muted small">As of Day ' + r.day + ': missed it (no live, no replay) or no worksheet. People who paid a deposit are left out. This is a list for the team; nothing is sent from here.</p>' +
          '<div class="chb-wrap"><table class="chb-risk"><thead><tr><th>Name</th><th>Why</th><th>Days attended</th><th>Contact</th></tr></thead><tbody>' + r.list.map(function (p) {
            var why = (p.missedTwo ? '<span class="chb-flag w">Missed two in a row</span>' : p.missed ? '<span class="chb-flag w">Missed Day ' + r.day + '</span>' : '') + (p.noHomework ? '<span class="chb-flag">No worksheet</span>' : '') + (p.vip ? '<span class="chb-flag">VIP</span>' : '');
            return '<tr><td><a href="#lead=' + esc(p.lead_id) + '">' + esc(p.name) + '</a></td><td>' + why + '</td><td>' + n(p.attendedDays) + ' of 5</td><td>' + esc(p.email || '') + (p.phone ? '<div class="muted">' + esc(p.phone) + '</div>' : '') + '</td></tr>';
          }).join('') + '</tbody></table></div><button class="btn-sm ghost" data-chb-copy style="margin-top:8px">Copy the emails</button>';
        box.innerHTML = '<h3 style="margin-top:18px">Progress</h3>' + tiles + '<div class="chb-wrap"><table class="chb-pg"><thead>' + head + '</thead><tbody>' + rows + '</tbody></table></div>' +
          '<h3 style="margin-top:18px">Who’s at risk (' + n(r.list.length) + ')</h3>' + risk;
        var cp = box.querySelector('[data-chb-copy]');
        if (cp) cp.onclick = function () {
          var list = r.list.map(function (p) { return p.email; }).filter(Boolean).join(', ');
          (navigator.clipboard ? navigator.clipboard.writeText(list) : Promise.reject()).then(function () { toast('Copied ' + r.list.length + ' emails'); }, function () { prompt('Copy the emails', list); });
        };
      });
    }

    function detail(id, money) {
      var box = view.querySelector('[data-chb-detail-box="' + id + '"]');
      box.innerHTML = '<p class="muted">Loading…</p>';
      ctx.api('challenge/cohorts/' + encodeURIComponent(id), {}, { noRange: true }).then(function (d) {
        var dots = function (days) { return '<span class="chb-d">' + days.map(function (x, i) { return '<i class="' + (x.live ? 'l' : x.replay ? 'r' : '') + (x.homework ? ' h' : '') + '" title="Day ' + (i + 1) + (x.live ? ': live' : x.replay ? ': replay' : '') + (x.homework ? ', worksheet' : '') + '"></i>'; }).join('') + '</span>'; };
        var regs = d.registrants.length ? '<table class="chb-reg"><thead><tr><th>Name</th><th>Revenue</th><th>Status</th><th>VIP</th><th>Days (live · replay · worksheet ring)</th><th>Deposit</th><th>Paid</th></tr></thead><tbody>' +
          d.registrants.map(function (r) { return '<tr><td><a href="#lead=' + esc(r.lead_id) + '">' + esc(r.name) + '</a><div class="muted">' + esc(r.email || '') + '</div></td><td>' + esc(r.band || '') + '</td><td>' + esc(r.status) + '</td><td>' + (r.vip ? 'VIP' : '') + '</td><td>' + dots(r.days) + '</td><td>' + esc(r.deposit || '') + '</td><td>' + esc(r.orders.map(function (o) { return o.kind + ' ' + money(o.amount) + (o.method === 'one_click' ? ' (one click)' : '') + (o.status === 'refunded' ? ' refunded' : ''); }).join(', ')) + '</td></tr>'; }).join('') + '</tbody></table>'
          : '<p class="muted">No registrations yet.</p>';
        var hot = d.hotSeats.length ? d.hotSeats.map(function (h) { return '<li><label><input type="checkbox" data-chb-hot="' + esc(h.id) + '"' + (h.done ? ' checked' : '') + '> Day ' + esc(h.day) + ' · <strong>' + esc(h.name) + '</strong>: ' + esc(h.question) + '</label></li>'; }).join('') : '<li class="muted">No hot seat questions yet.</li>';
        var hw = d.homework.length ? d.homework.map(function (h) {
          return '<div class="chb-hw"><strong>Day ' + esc(h.day) + ' · ' + esc(h.name) + '</strong>' + (h.vip ? ' <span class="pill">VIP</span>' : '') + ' <span class="muted">' + esc(when(h.updated_at)) + '</span><dl>' + h.answers.map(function (a) { return '<dt>' + esc(a.label) + '</dt><dd>' + esc(a.value) + '</dd>'; }).join('') + '</dl>' +
            (h.vip ? '<textarea class="input" data-chb-review="' + esc(h.reg_id) + '" data-day="' + esc(h.day) + '" placeholder="Your written feedback (shown on their day page)">' + esc(h.review || '') + '</textarea><button class="btn-sm ghost" data-chb-review-save>Save feedback</button>' : '') + '</div>';
        }).join('') : '<p class="muted">No worksheets yet.</p>';
        box.innerHTML = '<h3 style="margin-top:18px">Registrants</h3>' + regs + '<h3 style="margin-top:18px">VIP hot seat questions</h3><ul class="plain">' + hot + '</ul><h3 style="margin-top:18px">Worksheets</h3>' + hw;
        box.querySelectorAll('[data-chb-hot]').forEach(function (c) { c.onchange = function () { ctx.send('PATCH', 'challenge/hot/' + encodeURIComponent(c.getAttribute('data-chb-hot')), { done: c.checked }); }; });
        box.querySelectorAll('[data-chb-review-save]').forEach(function (b) {
          b.onclick = function () { var t = b.previousElementSibling; ctx.send('PATCH', 'challenge/homework/' + encodeURIComponent(t.getAttribute('data-chb-review')) + '/' + t.getAttribute('data-day'), { review: t.value }).then(function (r) { toast(r.ok ? 'Feedback saved' : 'Could not save'); }); };
        });
      });
    }
  }

  root.ChallengeBoard = { render: render };
})(window);
