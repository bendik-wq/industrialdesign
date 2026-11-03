/* Funnel HQ → Home: what needs you now, today's numbers, what's coming up and quick actions.
   Uses only existing endpoints (overview, sales, leads, ops, support, clients, errors, live-events, challenge).
   Rendered by admin.js through window.HomeBoard.render(ctx). */
(function () {
  'use strict';
  var DAY = 86400000;

  function startOfToday() { var d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function soft(p) { return p.catch(function () { return null; }); }

  function dayLabel(ms) {
    var d = new Date(ms), t0 = startOfToday();
    var time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    if (ms >= t0 && ms < t0 + DAY) return { day: 'Today', time: time };
    if (ms >= t0 + DAY && ms < t0 + 2 * DAY) return { day: 'Tomorrow', time: time };
    return { day: d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }), time: time };
  }

  function render(ctx) {
    var view = ctx.view, esc = ctx.esc, n = ctx.n;
    var now = Date.now(), t0 = startOfToday(), tz = -new Date().getTimezoneOffset();
    var lead30 = { page: 0, sort: 'created', from: now - 30 * DAY, to: now };
    var eb = document.querySelector('[data-eyebrow]');
    if (eb) eb.textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

    return Promise.all([
      soft(ctx.api('overview', { from: t0, to: now, tz: tz }, { noRange: true })),
      soft(ctx.api('overview', { from: now - 7 * DAY, to: now, tz: tz }, { noRange: true })),
      soft(ctx.api('sales')),
      soft(ctx.fetchLeads(Object.assign({ tier: 'A', status: 'applied' }, lead30))),
      soft(ctx.fetchLeads(Object.assign({ status: 'partial' }, lead30))),
      soft(ctx.api('ops', {}, { noRange: true })),
      soft(ctx.api('support', {}, { noRange: true })),
      soft(ctx.api('clients', {}, { noRange: true })),
      soft(ctx.api('errors', {}, { noRange: true })),
      soft(ctx.api('live-events', {}, { noRange: true })),
      soft(ctx.api('challenge', {}, { noRange: true })),
    ]).then(function (r) {
      var today = r[0] && r[0].kpis || {}, week = r[1] && r[1].kpis || {}, sl = r[2] || {}, aOpen = r[3] && r[3].total || 0, partial = r[4] && r[4].total || 0;
      var ops = r[5] || {}, sup = r[6] && r[6].counts || {}, cli = r[7] && r[7].summary || {}, errs = r[8] && r[8].totals || {};
      if (sl.needsOutcome && ctx.setNavBadge) ctx.setNavBadge('sales', sl.needsOutcome.length);

      // ── What needs you now: one row per thing to do, most urgent first ──
      var todo = [];
      var row = function (o) { todo.push(o); };
      if (ops.pending) row({ n: ops.pending, text: ops.pending === 1 ? 'action is waiting for your approval' : 'actions are waiting for your approval', go: 'command/approvals', icon: 'sparkle', tone: 'navy' });
      var unlogged = sl.needsOutcome ? sl.needsOutcome.length : 0;
      if (unlogged) row({ n: unlogged, text: unlogged === 1 ? 'past call needs an outcome' : 'past calls need an outcome', go: 'sales', icon: 'phone', tone: 'warn' });
      if (sup.escalated) row({ n: sup.escalated, text: sup.escalated === 1 ? 'support question needs a person' : 'support questions need a person', go: 'support', icon: 'help', tone: 'warn' });
      if (aOpen) row({ n: aOpen, text: aOpen === 1 ? 'A-tier lead hasn’t booked a call' : 'A-tier leads haven’t booked a call', go: 'leads', attrs: ' data-tier="A" data-status="applied"', icon: 'star', tone: 'warn' });
      if (cli.checkins_waiting) row({ n: cli.checkins_waiting, text: cli.checkins_waiting === 1 ? 'client check-in to approve' : 'client check-ins to approve', go: 'clients', icon: 'case', tone: 'navy' });
      if (cli.at_risk) row({ n: cli.at_risk, text: cli.at_risk === 1 ? 'client at risk' : 'clients at risk', go: 'clients', icon: 'case', tone: 'bad' });
      if (sup.drafted) row({ n: sup.drafted, text: sup.drafted === 1 ? 'drafted support answer to approve' : 'drafted support answers to approve', go: 'support', icon: 'help', tone: 'navy' });
      if (partial) row({ n: partial, text: partial === 1 ? 'unfinished application to chase' : 'unfinished applications to chase', go: 'leads', attrs: ' data-status="partial"', icon: 'clip', tone: 'plain' });
      if (errs.newToday) row({ n: errs.newToday, text: errs.newToday === 1 ? 'new error today' : 'new errors today', go: 'errors', icon: 'warn', tone: 'bad' });
      if (week.emails_simulated > 0 && week.emails_real === 0) row({ n: null, text: 'Emails aren’t really sending yet: connect an email provider', go: 'integrations', icon: 'mail', tone: 'plain' });

      var needs = todo.length
        ? '<ul class="home-list" role="list">' + todo.map(function (t) {
          return '<li><a class="home-row" href="#' + esc(t.go) + '" data-go="' + esc(t.go) + '"' + (t.attrs || '') + '>' +
            '<span class="home-ic tone-' + t.tone + '">' + icon(t.icon) + '</span>' +
            '<span class="home-tx">' + (t.n != null ? '<b class="home-n">' + esc(n(t.n)) + '</b> ' : '') + esc(t.text) + '</span>' +
            '<svg class="home-chev" aria-hidden="true"><use href="#i-chev"/></svg></a></li>';
        }).join('') + '</ul>'
        : '<div class="home-calm"><span class="home-ic tone-good">' + icon('star') + '</span><div><b>You’re all caught up.</b><p>No calls to log, approvals or hot leads waiting.</p></div></div>';

      // ── Today's numbers: four big tiles, each opening its page ──
      var big = function (label, value, hint, go) {
        var zero = value === '0' || value === ctx.money(0);
        return '<a class="home-tile" href="#' + go + '" data-go="' + go + '"><span class="home-tile-l">' + esc(label) + '</span><span class="home-tile-v' + (zero ? ' is-zero' : '') + '">' + esc(value) + '</span><span class="home-tile-h">' + esc(hint) + '</span></a>';
      };
      var tiles = '<div class="home-tiles">' +
        big('Visitors', n(today.visitors || 0), n(week.visitors || 0) + ' in the last 7 days', 'traffic') +
        big('Applications', n(today.applications || 0), n(week.applications || 0) + ' in the last 7 days', 'leads') +
        big('Calls booked', n(today.booked || 0), n(week.booked || 0) + ' in the last 7 days', 'sales') +
        big('Revenue', ctx.money(today.revenue || 0), ctx.money(week.revenue || 0) + ' in the last 7 days', 'sales') + '</div>';

      // ── Coming up: calls, live webinars and challenge days, soonest first ──
      var next = [];
      (sl.upcoming || []).slice(0, 6).forEach(function (u) {
        var rep = u.closer_id ? (ctx.reps() || []).filter(function (x) { return x.id === u.closer_id; })[0] : null;
        if (u.call_at) next.push({ at: u.call_at, title: 'Call with ' + ctx.personName(u), sub: (u.tier ? 'Tier ' + u.tier : 'No tier') + (rep ? ' · ' + rep.name : ''), attr: 'data-open="' + esc(u.id) + '" href="#lead=' + esc(u.id) + '"', icon: 'phone' });
      });
      ((r[9] && r[9].events) || []).forEach(function (e) {
        if (e.status === 'scheduled' && e.starts_at > now - 2 * 3600000) next.push({ at: e.starts_at, title: e.title || 'Live webinar', sub: 'Live webinar · ' + n(e.registered || 0) + ' registered', attr: 'data-go="liveevents" href="#liveevents"', icon: 'video' });
      });
      ((r[10] && r[10].cohorts) || []).forEach(function (c) {
        if (c.status === 'cancelled') return;
        var d = (c.days || []).filter(function (x) { return x.starts_at > now - 2 * 3600000; })[0];
        if (d) next.push({ at: d.starts_at, title: c.name + ': Day ' + d.day, sub: 'Challenge · ' + (d.title || ''), attr: 'data-go="challenge" href="#challenge"', icon: 'flag' });
      });
      next.sort(function (a, b) { return a.at - b.at; });
      var upcoming = next.length
        ? '<ul class="home-list" role="list">' + next.slice(0, 6).map(function (x) {
          var w = dayLabel(x.at);
          return '<li><a class="home-row home-ev" ' + x.attr + '><span class="home-when"><b>' + esc(w.day) + '</b><small>' + esc(w.time) + '</small></span>' +
            '<span class="home-tx"><b>' + esc(x.title) + '</b><small>' + esc(x.sub) + '</small></span><svg class="home-chev" aria-hidden="true"><use href="#i-chev"/></svg></a></li>';
        }).join('') + '</ul>'
        : '<div class="home-calm"><span class="home-ic tone-plain">' + icon('calendar') + '</span><div><b>Nothing scheduled.</b><p>Booked calls, live webinars and challenge days show up here.</p></div></div>';

      // ── Quick actions: each opens its page and starts the action that already lives there ──
      var acts = [
        ['find', 'search', 'Find a lead', 'By name, email or phone'],
        ['liveevents', 'video', 'Schedule a webinar', 'Live session with the offer'],
        ['rooms', 'grid', 'Create a room', 'Meeting or webinar room'],
        ['contracts', 'sign', 'New agreement', 'Auto-quoted from the application'],
        ['testemail', 'mail', 'Send a test email', 'Check that email delivers'],
        ['command', 'sparkle', 'Ask the assistant', 'Questions about your numbers'],
        ['sandbox', 'playc', 'Open the sandbox', 'Watch the automation run, nothing sent'],
        ['voicedemo', 'phone', 'Talk to an AI agent', 'Live demo in your browser'],
      ];
      var quick = '<div class="home-quick">' + acts.map(function (a) {
        return '<button type="button" class="home-q" data-home-act="' + a[0] + '"><span class="home-ic tone-navy">' + icon(a[1]) + '</span><span><b>' + esc(a[2]) + '</b><small>' + esc(a[3]) + '</small></span></button>';
      }).join('') + '</div>';

      view.innerHTML =
        '<section class="home-sec home-needs" aria-labelledby="home-needs-h"><div class="home-h"><h2 id="home-needs-h">What needs you now</h2>' + (todo.length ? '<span class="home-count">' + todo.length + '</span>' : '') + '</div>' + needs + '</section>' +
        '<section class="home-sec" aria-labelledby="home-today-h"><div class="home-h"><h2 id="home-today-h">Today</h2><a class="card-link" href="#overview" data-go="overview">All funnel numbers →</a></div>' + tiles + '</section>' +
        '<div class="home-cols">' +
        '<section class="home-sec" aria-labelledby="home-next-h"><div class="home-h"><h2 id="home-next-h">Coming up</h2></div>' + upcoming + '</section>' +
        '<section class="home-sec" aria-labelledby="home-quick-h"><div class="home-h"><h2 id="home-quick-h">Quick actions</h2></div>' + quick + '</section>' +
        '</div>';

      view.querySelectorAll('[data-home-act]').forEach(function (b) {
        b.onclick = function () {
          var k = b.getAttribute('data-home-act'), N = window.HQNav;
          if (k === 'find') { if (window.HQUX && window.HQUX.openPalette) window.HQUX.openPalette('lead'); else { var j = document.querySelector('[data-jump]'); if (j) j.click(); } return; }
          if (k === 'voicedemo') { location.href = '/admin/voice-demo'; return; }
          if (k === 'sandbox') { location.href = '/admin/sandbox'; return; }
          if (k === 'testemail') { if (N) N.runAction('integrations', { label: 'Send a test email', focus: '[data-test-to]' }); return; }
          if (N) N.runAction(k); else ctx.go(k);
        };
      });
    });
  }

  function icon(name) { return '<svg class="ni" aria-hidden="true"><use href="#i-' + name + '"/></svg>'; }

  window.HomeBoard = { render: render };
})();
