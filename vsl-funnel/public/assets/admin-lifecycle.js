/* Funnel HQ → Live webinars → one event → Show-up (builder E "lifecycle"): the show-up funnel (registered →
   added to a calendar → reminded → joined → stayed → bought), who came back from which reminder, the reminder
   subject test, channels, questions sent before the session, referrals, and the event's pre-show settings
   (video, waiting room slides, cadence, the subject test, a new time). Mounted by live-events-board.js. */
(function (root) {
  'use strict';
  var CSS = '.lcb-bars{display:grid;gap:8px;margin:8px 0 4px}.lcb-bar{display:grid;grid-template-columns:minmax(120px,220px) 1fr auto;gap:10px;align-items:center;font-size:13px}' +
    '.lcb-track{height:12px;border-radius:999px;background:rgba(15,44,92,.08);overflow:hidden}.lcb-fill{height:100%;background:#0f2c5c;border-radius:999px;transition:width .25s}' +
    '.lcb-n{font-variant-numeric:tabular-nums;white-space:nowrap}.lcb-muted{color:#86868b}.lcb-grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));margin-top:14px}' +
    '.lcb-list{margin:6px 0 0;padding-left:18px;font-size:13px}.lcb-list li{margin:4px 0}.lcb-form{display:grid;gap:10px}.lcb-form label{display:grid;gap:4px;font-size:13px}' +
    '.lcb-cad{display:grid;grid-template-columns:auto repeat(2,64px);gap:6px 10px;font-size:13px;align-items:center}.lcb-cad b{font-weight:600}.lcb-cad input{justify-self:center}' +
    '.lcb-sw{display:grid;grid-template-columns:auto 1fr;gap:10px;align-items:start;font-size:14px;line-height:1.45}.lcb-sw input{margin-top:3px}' +
    '@media (max-width:640px){.lcb-bar{grid-template-columns:1fr auto}.lcb-bar .lcb-track{grid-column:1 / -1;order:3}}';
  function css() { if (!document.getElementById('lcb-css')) { var s = document.createElement('style'); s.id = 'lcb-css'; s.textContent = CSS; document.head.appendChild(s); } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function pct(v) { return v == null || !isFinite(v) ? '–' : Math.round(v * 100) + '%'; }
  function req(method, path, body) {
    return fetch('/admin/api/' + path, { method: method, credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }); });
  }
  var KINDS = [['confirm', 'Confirmation'], ['r24h', '24 hours before'], ['r3h', '3 hours before'], ['r1h', '1 hour before'], ['r10m', '10 minutes before'], ['live', 'We’re live now'], ['missing', 'You’re missing it (+5 min)']];
  var REM = { r24h: '24 hours', r3h: '3 hours', r1h: '1 hour', missing: 'You’re missing it' };

  function localInput(ms, tz) {
    try {
      var p = {}; new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
      return p.year + '-' + p.month + '-' + p.day + 'T' + p.hour + ':' + p.minute;
    } catch (e) { return ''; }
  }

  function mount(el, id, ctx) {
    if (!el) return;
    css();
    var toast = (ctx && ctx.toast) || function () {};
    req('GET', 'live-events/' + encodeURIComponent(id) + '/lifecycle').then(function (d) {
      if (!d || !d.funnel) { el.innerHTML = ''; return; }
      var top = d.funnel[0].n || 0;
      var bars = d.funnel.map(function (s, i) {
        var w = top ? Math.max(s.n ? 2 : 0, Math.round(s.n / top * 100)) : 0;
        return '<div class="lcb-bar"><span>' + esc(s.label) + '</span><div class="lcb-track" role="img" aria-label="' + esc(s.label + ': ' + s.n) + '"><div class="lcb-fill" style="width:' + w + '%"></div></div><span class="lcb-n"><b>' + s.n + '</b> <span class="lcb-muted">' + (i ? pct(s.ofRegistered) + ' of registered' : '') + '</span></span></div>';
      }).join('');
      var back = d.cameBack.length ? '<ol class="lcb-list">' + d.cameBack.map(function (x) { return '<li>' + esc(x.label) + ': <b>' + x.n + '</b></li>'; }).join('') + '</ol>' : '<p class="lcb-muted">Nobody has joined yet.</p>';
      var ab = d.ab.rows.map(function (r) {
        var row = function (v, k) { return '<tr><td>' + esc(REM[r.kind] || r.kind) + ' ' + k.toUpperCase() + '</td><td>' + esc(v.subject) + '</td><td class="num">' + v.sent + '</td><td class="num">' + v.opened + '</td><td class="num">' + v.clicked + '</td><td class="num">' + v.joined + (v.sent ? ' (' + pct(v.joined / v.sent) + ')' : '') + '</td></tr>'; };
        return row(r.a, 'a') + row(r.b, 'b') + (r.p == null ? '' : '<tr><td colspan="6" class="lcb-muted">p = ' + r.p.toFixed(3) + (r.p < 0.05 ? ' (significant)' : ' (not significant yet)') + '</td></tr>');
      }).join('');
      var R = d.referrals, CH = d.channels, ST = d.settings;
      var cad = KINDS.map(function (k) {
        return '<span>' + esc(k[1]) + '</span><input type="checkbox" data-cad="email.' + k[0] + '"' + (ST.cadence.email[k[0]] ? ' checked' : '') + (k[0] === 'confirm' ? ' disabled' : '') + ' aria-label="Email: ' + esc(k[1]) + '"><input type="checkbox" data-cad="sms.' + k[0] + '"' + (ST.cadence.sms[k[0]] ? ' checked' : '') + ' aria-label="Text: ' + esc(k[1]) + '">';
      }).join('');
      el.innerHTML = '<div class="card" style="margin-top:14px"><h2>Show-up funnel</h2><p class="sub">Real people for this event only. Reminded means an email or a text was delivered (simulated counts while email or texting isn’t connected). Stayed means half the session or more in our room or the companion room.</p>' +
        '<div class="lcb-bars">' + bars + '</div></div>' +
        '<div class="lcb-grid">' +
          '<div class="card"><h2>Who came back from which reminder</h2><p class="sub">Each joiner’s last tracked click in the six hours before they joined.</p>' + back + '</div>' +
          '<div class="card"><h2>Channels</h2><ul class="lcb-list"><li>Emails delivered: <b>' + CH.emailsSent + '</b></li><li>Texts delivered: <b>' + CH.textsSent + '</b></li><li>Texts held back for an AI call at the same time: <b>' + CH.textsHeldForCall + '</b></li><li>One-tap text opt-ins: <b>' + CH.smsOptins + '</b></li>' +
            '<li>Calendars: ' + (d.calendar.length ? d.calendar.map(function (c) { return esc(c.kind) + ' ' + c.n; }).join(', ') : 'none yet') + '</li><li>Pre-session worksheets: <b>' + d.worksheets + '</b></li></ul></div>' +
          '<div class="card"><h2>Referrals</h2><ul class="lcb-list"><li>Link clicks: <b>' + R.clicks + '</b></li><li>Counted registrations: <b>' + R.counted + '</b></li><li>Attended: <b>' + R.attended + '</b></li>' +
            (R.rejected.length ? '<li>Not counted: ' + R.rejected.map(function (x) { return esc(x.label) + ' ' + x.n; }).join(', ') + '</li>' : '') + '</ul>' +
            (R.top.length ? '<p class="sub" style="margin-top:8px">Top referrers</p><ol class="lcb-list">' + R.top.map(function (t) { return '<li>' + esc(t.name) + ': ' + t.registered + ' registered, ' + t.attended + ' attended</li>'; }).join('') + '</ol>' : '') + '</div>' +
          '<div class="card"><h2>Questions sent before the session</h2>' + (d.questions.length ? '<ol class="lcb-list">' + d.questions.map(function (q) { return '<li><b>' + esc(q.name) + '</b> ' + esc(q.text) + '</li>'; }).join('') + '</ol><p class="lcb-muted" style="font-size:13px">In our room, the host adds them to the Q&amp;A with one tap.</p>' : '<p class="lcb-muted">None yet.</p>') + '</div>' +
        '</div>' +
        '<div class="card" style="margin-top:14px"><h2>Reminder subject test</h2><p class="sub">Half of registrants get the B subject on the 24 hour, 3 hour, 1 hour and “you’re missing it” emails (sticky per person). The test compares who joined.</p>' +
          '<label style="display:flex;gap:8px;align-items:center;font-size:14px"><input type="checkbox" data-ab' + (ST.subjectAb ? ' checked' : '') + '> Split subject lines A/B for this event</label>' +
          (d.ab.on || d.ab.rows.some(function (r) { return r.b.sent; }) ? '<div class="table-wrap"><table><thead><tr><th>Email</th><th>Subject</th><th class="num">Sent</th><th class="num">Opened</th><th class="num">Clicked</th><th class="num">Joined</th></tr></thead><tbody>' + ab + '</tbody></table></div>' : '') + '</div>' +
        '<div class="card" style="margin-top:14px"><h2>Pre-show and reminders</h2><div class="lcb-grid" style="margin-top:0">' +
          '<div class="lcb-form"><label>“Watch this before” video (YouTube, Vimeo, an https video, or a path on this site; the waiting room plays only a path on this site)<input class="input" data-v value="' + esc(ST.video || '') + '" placeholder="https://www.youtube.com/watch?v=…"></label>' +
          '<label>Waiting room slides, one per line: Title | text (blank = the defaults)<textarea class="input" rows="5" data-sl>' + esc(ST.slidesCustom ? ST.slides.map(function (s) { return s.title + ' | ' + s.body; }).join('\n') : '') + '</textarea></label></div>' +
          '<div><p class="sub" style="margin:0 0 6px">Cadence (texts only to people who agreed, inside texting hours, at most 3 a day; a text is held back when an AI call is queued at the same time)</p><div class="lcb-cad"><b></b><b>Email</b><b>Text</b>' + cad + '</div></div>' +
        '</div><p style="margin-top:12px"><button class="btn-sm" type="button" data-save-lc>Save</button></p></div>' +
        '<div class="card" style="margin-top:14px"><h2>Move this event</h2><p class="sub">Registrants get the new time with an updated calendar entry (calendar version ' + ST.icsSeq + '), and the reminders run again for the new time. Cancelling sends a cancellation that removes the calendar entry.</p>' +
          '<div class="leb-form"><label>New date and time (' + esc(d.event.tz) + ')<input class="input" type="datetime-local" data-new value="' + esc(localInput(d.event.startsAt, d.event.tz)) + '"></label><button class="btn-sm" type="button" data-move>Move and notify</button></div></div>';
      var box2 = document.createElement('div'); el.appendChild(box2); mount2(box2, id, toast);
      el.querySelector('[data-save-lc]').onclick = function () {
        var cadence = { email: {}, sms: {} };
        Array.prototype.forEach.call(el.querySelectorAll('[data-cad]'), function (i) { var p = i.getAttribute('data-cad').split('.'); cadence[p[0]][p[1]] = i.checked; });
        req('PATCH', 'live-events/' + encodeURIComponent(id) + '/lifecycle', { video_url: el.querySelector('[data-v]').value, slides: el.querySelector('[data-sl]').value, cadence: cadence, subject_ab: el.querySelector('[data-ab]').checked })
          .then(function (r) { toast(r.ok ? 'Saved' : r.error || 'Could not save'); if (r.ok) mount(el, id, ctx); });
      };
      el.querySelector('[data-ab]').onchange = function () { el.querySelector('[data-save-lc]').click(); };
      el.querySelector('[data-move]').onclick = function () {
        var v = el.querySelector('[data-new]').value;
        if (!v || !confirm('Move this event to ' + v.replace('T', ' ') + '? Every registrant gets the new time.')) return;
        req('PATCH', 'live-events/' + encodeURIComponent(id), { starts_at: v }).then(function (r) { toast(r.ok ? 'Moved. Registrants get the new time.' : r.error || 'Could not move it'); if (r.ok && ctx && ctx.reload) ctx.reload(); });
      };
    });
  }
  // Round 4 "lifecycle2": the per-event switches (all off by default) and what each step did, in real numbers.
  var PLAN = { full: 'All three lead-in parts', partial: 'The parts that still fit', compressed: 'One essentials email (late sign-up)', none: 'Reminders only (too late for more)', off: 'Switched off' };
  function mount2(el, id, toast) {
    req('GET', 'live-events/' + encodeURIComponent(id) + '/lifecycle2').then(function (d) {
      if (!d || !d.toggles) { el.innerHTML = ''; return; }
      var T = d.toggles;
      var sw = function (k, label, help) {
        return '<label class="lcb-sw"><input type="checkbox" data-lc2="' + k + '"' + (T[k] ? ' checked' : '') + '><span><b>' + esc(label) + '</b><br><span class="lcb-muted">' + esc(help) + '</span></span></label>';
      };
      var plans = Object.keys(d.plans).filter(function (k) { return k !== 'off'; }).map(function (k) { return '<li>' + esc(PLAN[k] || k) + ': <b>' + d.plans[k] + '</b></li>'; }).join('');
      var rows = d.steps.filter(function (s) { return s.sent || s.skipped.length; }).map(function (s) {
        return '<tr><td>' + esc(s.label) + '</td><td class="num">' + s.sent + '</td><td class="num">' + s.opened + ' <span class="lcb-muted">' + pct(s.openRate) + '</span></td><td class="num">' + s.clicked + ' <span class="lcb-muted">' + pct(s.clickRate) + '</span></td>' +
          '<td class="num">' + s.outcome + ' <span class="lcb-muted">' + pct(s.outcomeRate) + ' ' + esc(s.outcomeLabel.toLowerCase()) + '</span></td><td class="num">' + s.bought + '</td>' +
          '<td>' + (s.skipped.length ? s.skipped.map(function (x) { return esc(x.why) + ' ' + x.n; }).join(', ') : '<span class="lcb-muted">none</span>') + '</td></tr>';
      }).join('');
      var C = d.compare;
      el.innerHTML = '<div class="card" style="margin-top:14px" data-lc2-card><h2>Lead-in, late sign-ups and missed live</h2>' +
        '<p class="sub">Off until you switch them on, for this event only. Every email waits for 8:00 to 20:00 in the person’s zone, keeps six hours from any other email and two hours from an AI call, goes at most once a day per person, honours unsubscribe and the pre-session daily cap (now ' + d.dailyCap + ').</p>' +
        '<div class="lcb-form">' +
          sw('leadin', 'Bootcamp lead-in', 'Three short parts before the session, a day apart (4, 3 and 2 days before): the welcome with the “watch this before” video, the biggest-question prompt, the pre-work worksheet. On the confirmation page with their real dates, and by email. A part is not emailed once its step is done on the page.') +
          sw('adaptive', 'Adaptive by sign-up date', 'People who register less than about three days before the start (too late for the series) get one essentials email six hours after signing up (why come live, the calendar, the worksheet), never within four hours of the start.') +
          sw('missed', 'Missed-live path', 'People who didn’t come and haven’t bought get one short email 18 hours after the end, keyed to how much of the replay they watched, and a second only after they watch more. Only while the deposit offer is open (' + d.offerHours + ' hours after the end), with time to spare. It replaces the no-show highlights email for this event.') +
        '</div>' +
        (plans ? '<p class="sub" style="margin-top:12px">Registrants by plan</p><ul class="lcb-list">' + plans + '</ul>' : '') +
        '<p class="sub" style="margin-top:12px">What each step did</p>' +
        (rows ? '<div class="table-wrap"><table><thead><tr><th>Step</th><th class="num">Sent</th><th class="num">Opened</th><th class="num">Clicked</th><th class="num">Outcome</th><th class="num">Deposit after</th><th>Held back</th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '<p class="lcb-muted">Nothing has gone out for this event yet.</p>') +
        '<p class="lcb-muted" style="font-size:13px;margin-top:8px">Joined live: ' + C.got.joined + ' of ' + C.got.n + ' (' + pct(C.got.rate) + ') who got a lead-in or essentials email, against ' + C.didNot.joined + ' of ' + C.didNot.n + ' (' + pct(C.didNot.rate) + ') who didn’t. Not a controlled test: early sign-ups get more parts and show up more anyway.</p>' +
        '</div>';
      Array.prototype.forEach.call(el.querySelectorAll('[data-lc2]'), function (i) {
        i.onchange = function () {
          var b = {}; b[i.getAttribute('data-lc2')] = i.checked;
          req('PATCH', 'live-events/' + encodeURIComponent(id) + '/lifecycle2', b).then(function (r) { toast(r.ok ? (i.checked ? 'Switched on for this event' : 'Switched off for this event') : r.error || 'Could not save'); mount2(el, id, toast); });
        };
      });
    });
  }
  root.LifecycleBoard = { mount: mount };
})(window);
