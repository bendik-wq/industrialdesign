/* Funnel HQ → Sandbox: pick a journey, shape a sample lead, press Play. The server runs the real rules
   (/admin/api/sandbox/run) and renders each step on demand (/admin/api/sandbox/detail). Nothing is sent. */
(function () {
  'use strict';

  var COPY = {
    eyebrow: 'Sandbox',
    title: 'Watch the automation work',
    lede: 'Pick a journey, shape a sample lead, and press Play. Every email, text and AI call lights up the moment the real rules would send it, and anything held back says why. Nothing is sent and nothing is saved.',
    live: 'Live webinar',
    liveBlurb: 'Registration, the welcome call, reminders by email, text and call, the live session, the offer, and the paths after it: bought, didn’t buy, missed it.',
    strategy: 'Application to strategy call',
    strategyBlurb: 'The application, the speed-to-lead call, booking, the confirmation call, the pre-call emails and texts, and what happens after a missed call.',
    start: 'Start',
    fine: 'The sample lead and the sample session are made up and labelled sample. The rules, the wording and the timing are the real ones from this account.',
    lead: 'Sample lead', does: 'What they do',
    name: 'First name', country: 'Country', tz: 'Time zone', tzSmall: 'Their reminders follow it', revenue: 'Revenue', callOk: 'Ticked “call me”', textOk: 'Ticked “text me”',
    oneBox: 'On the application one box covers calls and texts.',
    registers: 'Registers', startsAt: 'Session starts', joins: 'Joins live', joinMin: 'Arrives', leaves: 'Leaves', buys: 'Pays the deposit',
    applies: 'Applies', books: 'Books a call', callIn: 'Call booked for', shows: 'Shows up to the call', rebooks: 'Rebooks after missing it',
    answers: 'Picks up AI calls', optOut: 'Opts out', pain: 'Main challenge on a call',
    play: 'Play', pause: 'Pause', step: 'Next step', reset: 'Back to the start', speed: 'Speed',
    upNext: 'Up next:', done: 'The simulation has finished.', fired: 'fired', held: 'held back',
    assume: 'What this sample assumes',
    sent: 'Sent', skipped: 'Held back', cancelled: 'Cancelled', doneChip: 'Done', note: 'Moment', due: 'Due',
    whyHeld: 'Why it didn’t go', whyCancelled: 'Why it was cancelled',
    subject: 'Subject', from: 'From', preheader: 'Preview', when: 'When', theirTime: 'their time',
    emailFine: 'The real email, rendered from this account’s templates for the sample lead. Links are disabled here.',
    textFirst: 'First text to this number, so it carries the opt-out line.',
    auVariant: 'Australian mobiles get the sender name, with an opt-out link instead of “Reply STOP”',
    agent: 'Agent', opening: 'What Sam says first', script: 'The script for this call', facts: 'Offer facts and rules Sam is given', allVars: 'Everything Sam receives',
    objective: 'The next action Sam drives to', sampleTimes: 'Sample times Sam offers', success: 'Counts as a yes', sayLike: 'Lines like', painH: 'Their challenge, and the one guide Sam offers', painSays: 'They say', painOffer: 'Sam offers', noPain: 'No challenge named, so no guide offered.',
    talk: 'Talk to Sam now', talkFine: 'Opens the live voice demo with this exact call. You play the sample lead through your microphone. Nobody is called.',
    agentLive: 'Live in this account', agentOff: 'Not live in this account yet',
    loadErr: 'Couldn’t load that step. Run the simulation again.', runErr: 'The simulation didn’t run. Try again.',
    precall: 'pre-call emails', cancelledGroup: 'planned messages cancelled', show: 'Show', hide: 'Hide',
    session: 'the session', call: 'the strategy call',
  };

  var ICON = {
    email: '<path d="M3.5 6.5h17v11h-17z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="m4 7 8 6 8-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    sms: '<path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3v-3H5A1.5 1.5 0 0 1 3.5 15V7A1.5 1.5 0 0 1 5 5.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
    call: '<path d="M6.6 3.8 9 3.5l1.6 4-2 1.4a10 10 0 0 0 6.5 6.5l1.4-2 4 1.6-.3 2.4a2 2 0 0 1-2.1 1.7A15.5 15.5 0 0 1 4.9 5.9a2 2 0 0 1 1.7-2.1z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
    session: '<rect x="3" y="6" width="12.5" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m15.5 10.5 5-3v9l-5-3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
    purchase: '<rect x="3" y="5.5" width="18" height="13" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3 10h18M7 15h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    step: '<circle cx="12" cy="8" r="3.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5 20a7 7 0 0 1 14 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    skip: '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m6.5 6.5 11 11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    play: '<path d="M7 4.5v15l12.5-7.5z" fill="currentColor"/>',
    pause: '<rect x="6" y="4.5" width="4" height="15" rx="1.2" fill="currentColor"/><rect x="14" y="4.5" width="4" height="15" rx="1.2" fill="currentColor"/>',
    next: '<path d="M5 5v14l10-7z" fill="currentColor"/><rect x="16.5" y="5" width="2.5" height="14" rx="1" fill="currentColor"/>',
    back: '<path d="M19 5v14L9 12z" fill="currentColor"/><rect x="5" y="5" width="2.5" height="14" rx="1" fill="currentColor"/>',
    x: '<path d="m5 5 14 14M19 5 5 19" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
  };
  var svg = function (k) { return '<svg viewBox="0 0 24 24" aria-hidden="true">' + (ICON[k] || '') + '</svg>'; };
  var CH_NAME = { email: 'Email', sms: 'Text', call: 'AI call', session: 'Session', purchase: 'Purchase', step: 'Lead' };
  var STATUS = { sent: COPY.sent, skipped: COPY.skipped, cancelled: COPY.cancelled, done: COPY.doneChip, note: COPY.note };
  var SPEEDS = [{ v: 15 * 60e3, l: '15 min a second' }, { v: 3600e3, l: '1 hour a second' }, { v: 6 * 3600e3, l: '6 hours a second' }, { v: 24 * 3600e3, l: '1 day a second' }];

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var main = $('[data-main]');
  var st = { opts: null, journey: null, input: null, sim: null, t: 0, playing: false, speed: 3600e3, raf: 0, last: 0, fired: -1, open: null, expanded: {}, timer: 0, seq: 0 };
  try { var saved = JSON.parse(localStorage.getItem('sb:prefs') || 'null'); if (saved && saved.speed) st.speed = saved.speed; } catch (e) { /* defaults */ }

  // ───────── time ─────────
  function fmt(t, o) { try { return new Intl.DateTimeFormat('en-AU', Object.assign({ timeZone: st.input.lead.tz }, o)).format(t); } catch (e) { return new Date(t).toUTCString(); } }
  var hm = function (t) { return fmt(t, { hour: 'numeric', minute: '2-digit' }).replace(' ', ' '); };
  var dayKey = function (t) { return fmt(t, { year: 'numeric', month: 'numeric', day: 'numeric' }); };
  var dayLabel = function (t) { return fmt(t, { weekday: 'long', day: 'numeric', month: 'long' }); };
  function span(ms) {
    var m = Math.round(Math.abs(ms) / 60e3);
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60), mm = m % 60;
    if (h < 48) return h + ' h' + (mm ? ' ' + mm + ' min' : '');
    var d = Math.floor(h / 24), hh = h % 24;
    return d + ' days' + (hh ? ' ' + hh + ' h' : '');
  }
  function rel(t) {
    var mk = st.sim.markers, a = mk[0];
    if (st.journey === 'live') {
      var start = a.at, end = mk[1].at;
      if (t < start) return span(start - t) + ' before ' + COPY.session;
      if (t < end) return 'Minute ' + Math.floor((t - start) / 60e3) + ' of ' + COPY.session;
      return span(t - end) + ' after ' + COPY.session;
    }
    var call = mk.filter(function (m) { return /call/i.test(m.label); })[0];
    if (!call) return span(t - a.at) + ' after applying';
    return t < call.at ? span(call.at - t) + ' before ' + COPY.call : span(t - call.at) + ' after ' + COPY.call;
  }

  // ───────── input ─────────
  function defaults(j) {
    var d = st.opts.defaults;
    return { journey: j, lead: Object.assign({}, d.lead), choices: Object.assign({}, d.choices) };
  }
  function query() { return encodeURIComponent(JSON.stringify(st.input)); }
  function run(keepTime) {
    var my = ++st.seq;
    var prevT = st.t, prevStart = st.sim && st.sim.start;
    return fetch('/admin/api/sandbox/run?q=' + query(), { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
      if (my !== st.seq) return;
      if (!d || !d.ok) throw new Error('run');
      st.input = d.input; st.sim = d.sim;
      st.t = keepTime && prevStart ? Math.min(st.sim.end, Math.max(st.sim.start, prevT)) : st.sim.start;
      st.fired = -1; st.expanded = {};
      drawWork();
    }).catch(function () { if (my === st.seq) toast(COPY.runErr); });
  }
  function rerun() { clearTimeout(st.timer); st.timer = setTimeout(function () { run(true); }, 220); }
  function toast(t) { var n = $('[data-next]'); if (n) n.textContent = t; else main.innerHTML = '<p class="sb-loading">' + esc(t) + '</p>'; }

  // ───────── journey picker ─────────
  function art(list) {
    return '<div class="sb-pick-art" aria-hidden="true">' + list.map(function (k, i) {
      var c = { email: 'var(--c-email)', sms: 'var(--c-sms)', call: 'var(--c-call)', session: 'var(--c-session)', purchase: 'var(--c-purchase)', step: 'var(--c-step)' }[k];
      return (i ? '<em></em>' : '') + '<i style="background:' + c + ';color:' + c + '"><span style="color:#fff;display:grid">' + svg(k) + '</span></i>';
    }).join('') + '</div>';
  }
  function drawPicker() {
    stop();
    st.journey = null; st.sim = null;
    main.innerHTML = '<section class="sb-hero"><p class="sb-eyebrow">' + esc(COPY.eyebrow) + '</p><h1>' + esc(COPY.title) + '</h1><p class="sb-lede">' + esc(COPY.lede) + '</p></section>' +
      '<div class="sb-picks">' +
      '<button type="button" class="sb-pick" data-pick="live">' + art(['step', 'call', 'email', 'sms', 'session', 'purchase']) + '<b>' + esc(COPY.live) + '</b><span>' + esc(COPY.liveBlurb) + '</span><span class="sb-pick-go">' + esc(COPY.start) + ' →</span></button>' +
      '<button type="button" class="sb-pick" data-pick="strategy">' + art(['step', 'call', 'email', 'sms', 'call', 'session']) + '<b>' + esc(COPY.strategy) + '</b><span>' + esc(COPY.strategyBlurb) + '</span><span class="sb-pick-go">' + esc(COPY.start) + ' →</span></button>' +
      '</div><p class="sb-fine">' + esc(COPY.fine) + '</p>';
    main.querySelectorAll('[data-pick]').forEach(function (b) { b.onclick = function () { choose(b.getAttribute('data-pick')); }; });
  }
  function choose(j) {
    st.journey = j;
    var keep = st.input && st.input.lead;
    st.input = defaults(j);
    if (keep) st.input.lead = Object.assign({}, keep);
    try { history.replaceState(null, '', '#' + j); } catch (e) { /* fine */ }
    main.innerHTML = '<p class="sb-loading">Running the sample through the real rules…</p>';
    run(false);
  }

  // ───────── the controls ─────────
  function sel(key, label, options, value, small) {
    return '<label class="sb-f"><span>' + esc(label) + (small ? '<small>' + esc(small) + '</small>' : '') + '</span><select data-k="' + key + '">' +
      options.map(function (o) { return '<option value="' + esc(JSON.stringify(o[0])) + '"' + (JSON.stringify(o[0]) === JSON.stringify(value) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select></label>';
  }
  function sw(key, label, value, small) {
    return '<label class="sb-f"><span>' + esc(label) + (small ? '<small>' + esc(small) + '</small>' : '') + '</span><span class="sb-sw"><input type="checkbox" role="switch" data-k="' + key + '"' + (value ? ' checked' : '') + '><i></i></span></label>';
  }
  function seg(key, label, options, value) {
    return '<div class="sb-f is-wide"><span>' + esc(label) + '</span><div class="sb-seg" role="group" aria-label="' + esc(label) + '">' +
      options.map(function (o) { return '<button type="button" data-seg="' + key + '" data-v="' + esc(JSON.stringify(o[0])) + '" aria-pressed="' + (JSON.stringify(o[0]) === JSON.stringify(value)) + '">' + esc(o[1]) + '</button>'; }).join('') + '</div></div>';
  }
  function panel() {
    var L = st.input.lead, C = st.input.choices, o = st.opts;
    var country = o.countries.filter(function (c) { return c.id === L.country; })[0] || o.countries[0];
    var h = '<h2>' + esc(COPY.lead) + '<small>sample</small></h2>' +
      '<label class="sb-f"><span>' + esc(COPY.name) + '</span><input type="text" data-k="lead.name" value="' + esc(L.name) + '" maxlength="30" autocomplete="off"></label>' +
      sel('lead.country', COPY.country, o.countries.map(function (c) { return [c.id, c.label + ' (' + (/^\+(1|\d{2})/.exec(c.phone) || [''])[0] + ')']; }), L.country) +
      sel('lead.tz', COPY.tz, country.zones.map(function (z) { return [z, z.split('/').pop().replace(/_/g, ' ')]; }), L.tz, COPY.tzSmall) +
      sel('lead.revenue', COPY.revenue, o.revenues.map(function (r) { return [r.id, r.label]; }), L.revenue) +
      sw('lead.callOk', COPY.callOk, L.callOk, st.journey === 'strategy' ? COPY.oneBox : '') +
      sw('lead.textOk', COPY.textOk, L.textOk);
    h += '<h2>' + esc(COPY.does) + '</h2>';
    if (st.journey === 'live') {
      h += sel('choices.registerBefore', COPY.registers, [[6 * 1440, '6 days before'], [3 * 1440, '3 days before'], [1440, 'The day before'], [180, '3 hours before'], [30, '30 minutes before']], C.registerBefore) +
        sel('choices.startHour', COPY.startsAt, [[12, '12:00 pm'], [16, '4:00 pm'], [19, '7:00 pm'], [21, '9:00 pm']], C.startHour, 'Event time zone: ' + (st.sim.eventTz || '').split('/').pop().replace(/_/g, ' ')) +
        sw('choices.joins', COPY.joins, C.joins) +
        (C.joins ? sel('choices.joinMin', COPY.joinMin, [[-10, '10 minutes early'], [0, 'On time'], [15, '15 minutes late'], [40, '40 minutes late']], C.joinMin) +
          sel('choices.leaveMin', COPY.leaves, [[null, 'Stays to the end'], [30, 'At minute 30'], [50, 'At minute 50'], [90, 'At minute 90']], C.leaveMin) : '') +
        seg('choices.buys', COPY.buys, [['no', 'No'], ['live', 'In the session'], ['after', 'The day after']], C.buys);
    } else {
      h += sel('choices.appliesAt', COPY.applies, o.applyTimes.map(function (a) { return [a.id, a.label]; }), C.appliesAt) +
        sel('choices.booksAfter', COPY.books, [[10, '10 minutes later'], [120, '2 hours later'], [1440, 'The next day'], [null, 'Never']], C.booksAfter) +
        (C.booksAfter != null ? sel('choices.callInDays', COPY.callIn, [[1, 'The next day, 10 am'], [2, 'In 2 days, 10 am'], [5, 'In 5 days, 10 am']], C.callInDays) +
          sw('choices.noShow', COPY.shows, !C.noShow) + (C.noShow ? sw('choices.rebooks', COPY.rebooks, C.rebooks) : '') : '');
    }
    h += sw('choices.answers', COPY.answers, C.answers) +
      sel('choices.optOut', COPY.optOut, [['none', 'No'], ['text', 'Replies STOP to the first text'], ['call', 'Tells Sam to stop on a call']], C.optOut) +
      sel('choices.pain', COPY.pain, [['none', 'Doesn’t name one']].concat((o.pains || []).map(function (p) { return [p.id, p.label]; })), C.pain || 'none');
    var tierNote = st.sim.tier ? '<p class="sb-note">The real scoring puts this sample at <b>tier ' + esc(st.sim.tier) + '</b>. Number used: ' + esc(st.sim.phone.replace(/(\+\d{1,2})(\d{3})(\d+)/, '$1 $2 $3')) + ' (sample).</p>'
      : '<p class="sb-note">Number used: ' + esc(st.sim.phone.replace(/(\+\d{1,2})(\d{3})(\d+)/, '$1 $2 $3')) + ' (sample).</p>';
    return h + tierNote;
  }
  function set(path, v) {
    var p = path.split('.'), o = st.input;
    o[p[0]][p[1]] = v;
    if (path === 'lead.country') { var c = st.opts.countries.filter(function (x) { return x.id === v; })[0]; if (c) st.input.lead.tz = c.zones[0]; }
    if (path === 'choices.noShow') st.input.choices.noShow = !v; // the switch reads "shows up"
  }
  function bindPanel(root) {
    root.querySelectorAll('select[data-k]').forEach(function (s) { s.onchange = function () { set(s.getAttribute('data-k'), JSON.parse(s.value)); redrawPanel(); rerun(); }; });
    root.querySelectorAll('input[type=checkbox][data-k]').forEach(function (s) { s.onchange = function () { set(s.getAttribute('data-k'), s.checked); redrawPanel(); rerun(); }; });
    root.querySelectorAll('input[type=text][data-k]').forEach(function (s) { s.oninput = function () { var v = s.value.trim(); if (/^[\p{L}][\p{L}' .-]{0,29}$/u.test(v)) { set(s.getAttribute('data-k'), v); rerun(); } }; });
    root.querySelectorAll('[data-seg]').forEach(function (b) { b.onclick = function () { set(b.getAttribute('data-seg'), JSON.parse(b.getAttribute('data-v'))); redrawPanel(); rerun(); }; });
  }
  function redrawPanel() { var p = $('[data-panel]'); if (!p) return; var f = document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute('data-k'); p.innerHTML = panel(); bindPanel(p); if (f) { var el = p.querySelector('[data-k="' + f + '"]'); if (el) el.focus(); } }

  // ───────── the workspace ─────────
  function rowsModel() {
    // Fold rows that share a group (the pre-call emails, the messages a booking cancelled) into one row.
    var ev = st.sim.events, out = [], byGroup = {};
    ev.forEach(function (e, i) {
      e._i = i;
      if (e.group) {
        if (!byGroup[e.group]) { byGroup[e.group] = { group: e.group, items: [], at: e.at, ch: e.ch, phase: e.phase }; out.push(byGroup[e.group]); }
        byGroup[e.group].items.push(e);
        return;
      }
      out.push(e);
    });
    return out.map(function (r) { return r.items && r.items.length === 1 ? r.items[0] : r; });
  }
  function groupTitle(g) {
    var n = g.items.length;
    if (/^cancelled:/.test(g.group)) return n + ' ' + COPY.cancelledGroup;
    if (/^precall:/.test(g.group)) return n + ' ' + COPY.precall;
    return n + ' messages';
  }
  function rowHtml(e, sub) {
    var chip = STATUS[e.status] || '';
    return '<li class="sb-row ch-' + e.ch + ' st-' + e.status + '" data-i="' + e._i + '" data-id="' + esc(e.id) + '">' +
      '<time>' + esc(hm(e.at)) + '</time><span class="sb-node">' + svg(e.status === 'skipped' || e.status === 'cancelled' ? 'skip' : e.ch) + '</span>' +
      '<button type="button" class="sb-card" data-open="' + esc(e.id) + '"><span class="sb-card-t">' + (sub ? '' : '<span class="sb-ch">' + esc(CH_NAME[e.ch]) + '</span>') + '<b>' + esc(e.title) + '</b><span class="sb-chip" data-chip="' + esc(chip) + '">' + esc(chip) + '</span></span>' +
      (e.sub && e.sub !== e.title ? '<span class="sb-card-s">' + esc(e.sub) + '</span>' : '') + (e.reason ? '<span class="sb-card-r">' + esc(e.reason) + '</span>' : '') + '</button></li>';
  }
  function groupHtml(g) {
    var first = g.items[0], cancelled = /^cancelled:/.test(g.group);
    var subj = g.items.map(function (x) { return x.sub || x.title; }).slice(0, 2).join(' · ');
    return '<li class="sb-row sb-group ch-' + g.ch + ' st-' + (cancelled ? 'cancelled' : 'sent') + '" data-group="' + esc(g.group) + '" data-i="' + first._i + '">' +
      '<time>' + esc(hm(g.at)) + '</time><span class="sb-node">' + svg(cancelled ? 'skip' : g.ch) + '</span>' +
      '<button type="button" class="sb-card" data-expand="' + esc(g.group) + '" aria-expanded="false"><span class="sb-card-t"><span class="sb-ch">' + esc(CH_NAME[g.ch]) + '</span><b>' + esc(groupTitle(g)) + '</b><span class="sb-chip" data-gchip>' + '</span></span>' +
      '<span class="sb-card-s">' + esc(cancelled ? (first.reason || '') : subj) + '</span><span class="sb-more">' + esc(COPY.show) + '</span></button></li>' +
      '<li class="sb-sub-wrap" style="list-style:none"><ul class="sb-sub sb-rows" data-sub="' + esc(g.group) + '">' + g.items.map(function (x) { return rowHtml(x, true); }).join('') + '</ul></li>';
  }
  function timelineHtml() {
    var model = rowsModel(), h = '', phase = null, day = null, open = false;
    model.forEach(function (r) {
      var at = r.at, ph = r.phase;
      if (ph !== phase) {
        if (open) h += '</ul>';
        h += '<div class="sb-phase"><h3>' + esc(ph) + '</h3></div>';
        phase = ph; day = null; open = false;
      }
      if (dayKey(at) !== day) {
        if (open) h += '</ul>';
        h += '<div class="sb-day">' + esc(dayLabel(at)) + '</div><ul class="sb-rows">';
        day = dayKey(at); open = true;
      }
      h += r.items ? groupHtml(r) : rowHtml(r);
    });
    if (open) h += '</ul>';
    return h;
  }
  function drawWork() {
    var j = st.journey, sim = st.sim;
    var speedOpts = SPEEDS.map(function (s) { return '<option value="' + s.v + '"' + (s.v === st.speed ? ' selected' : '') + '>' + esc(s.l) + '</option>'; }).join('');
    main.innerHTML =
      '<div class="sb-head"><div><h1>' + esc(j === 'live' ? COPY.live : COPY.strategy) + '</h1><p>' + esc(st.input.lead.name) + ' (sample) · ' + esc((st.input.lead.tz || '').split('/').pop().replace(/_/g, ' ')) + ' time</p></div>' +
      '<div class="sb-seg" role="group" aria-label="Journey"><button type="button" data-j="live" aria-pressed="' + (j === 'live') + '">' + esc(COPY.live) + '</button><button type="button" data-j="strategy" aria-pressed="' + (j === 'strategy') + '">' + esc(COPY.strategy) + '</button></div></div>' +
      '<div class="sb-work"><aside class="sb-panel" data-panel aria-label="Sample lead and choices">' + panel() + '</aside>' +
      '<section aria-label="Timeline"><div class="sb-player" data-player>' +
      '<div class="sb-prow"><button type="button" class="sb-btn" data-reset aria-label="' + esc(COPY.reset) + '" title="' + esc(COPY.reset) + '">' + svg('back') + '</button>' +
      '<button type="button" class="sb-btn is-play" data-play aria-label="' + esc(COPY.play) + '">' + svg('play') + '</button>' +
      '<button type="button" class="sb-btn" data-step aria-label="' + esc(COPY.step) + '" title="' + esc(COPY.step) + '">' + svg('next') + '</button>' +
      '<div class="sb-clock" aria-live="off"><b data-clock></b><span data-rel></span></div>' +
      '<label class="sb-speed"><span class="sr" hidden>' + esc(COPY.speed) + '</span><select data-speed aria-label="' + esc(COPY.speed) + '">' + speedOpts + '</select></label></div>' +
      '<div class="sb-track"><div class="sb-ticks" data-ticks></div><input class="sb-range" type="range" min="0" max="1000" step="1" value="0" data-range aria-label="Simulated time"><div class="sb-marks" data-marks></div></div>' +
      '<div class="sb-next" data-next></div></div>' +
      '<div class="sb-info">' + (sim.account.notes.length ? '<p class="sb-acct">' + esc(sim.account.notes.join(' ')) + '</p>' : '') +
      '<details class="sb-assume"><summary>' + esc(COPY.assume) + '</summary><ul>' + sim.assumptions.map(function (a) { return '<li>' + esc(a) + '</li>'; }).join('') + '</ul></details></div>' +
      '<div class="sb-tl" data-tl>' + timelineHtml() + '</div></section></div>';
    main.querySelectorAll('[data-j]').forEach(function (b) { b.onclick = function () { if (b.getAttribute('data-j') !== st.journey) choose(b.getAttribute('data-j')); }; });
    bindPanel($('[data-panel]'));
    $('[data-play]').onclick = toggle;
    $('[data-step]').onclick = stepNext;
    $('[data-reset]').onclick = function () { stop(); setT(st.sim.start); };
    $('[data-speed]').onchange = function () { st.speed = Number(this.value); try { localStorage.setItem('sb:prefs', JSON.stringify({ speed: st.speed })); } catch (e) { /* fine */ } };
    var range = $('[data-range]');
    range.oninput = function () { stop(); setT(st.sim.start + (st.sim.end - st.sim.start) * Number(range.value) / 1000, true); };
    main.querySelectorAll('[data-open]').forEach(function (b) { b.onclick = function () { openDetail(b.getAttribute('data-open')); }; });
    main.querySelectorAll('[data-expand]').forEach(function (b) {
      b.onclick = function () {
        var g = b.getAttribute('data-expand'), row = b.closest('.sb-group'), on = !row.classList.contains('is-expanded');
        row.classList.toggle('is-expanded', on); b.setAttribute('aria-expanded', String(on));
        b.querySelector('.sb-more').textContent = on ? COPY.hide : COPY.show;
        st.expanded[g] = on;
        row.parentNode.querySelector('[data-sub="' + g.replace(/"/g, '') + '"]').style.display = on ? 'block' : '';
      };
    });
    drawTicks();
    st.fired = -1;
    setT(st.t, true);
  }
  function pct(t) { return ((t - st.sim.start) / Math.max(1, st.sim.end - st.sim.start)) * 100; }
  function drawTicks() {
    var colors = { email: 'var(--c-email)', sms: 'var(--c-sms)', call: 'var(--c-call)', session: 'var(--c-session)', purchase: 'var(--c-purchase)', step: 'var(--c-step)' };
    $('[data-ticks]').innerHTML = st.sim.events.map(function (e) { return '<i class="' + (e.status === 'skipped' || e.status === 'cancelled' ? 'is-off' : '') + '" style="left:' + pct(e.at).toFixed(2) + '%;background:' + colors[e.ch] + '"></i>'; }).join('');
    var lastP = -100;
    $('[data-marks]').innerHTML = st.sim.markers.map(function (m) { var p = pct(m.at); if (p - lastP < 14) return ''; lastP = p; return p > 78 ? '<span style="right:0;transform:none">' + esc(m.label) + '</span>' : '<span style="left:' + Math.max(6, p).toFixed(2) + '%">' + esc(m.label) + '</span>'; }).join('');
  }

  // ───────── the clock ─────────
  function setT(t, scrubbed) {
    var sim = st.sim;
    st.t = Math.min(sim.end, Math.max(sim.start, t));
    var p = pct(st.t);
    var range = $('[data-range]');
    if (range) { range.value = String(Math.round(p * 10)); range.style.setProperty('--p', p.toFixed(2) + '%'); }
    $('[data-clock]').textContent = fmt(st.t, { weekday: 'short', day: 'numeric', month: 'short' }) + ', ' + hm(st.t);
    $('[data-rel]').textContent = rel(st.t) + ' · ' + COPY.theirTime;
    // events fired so far
    var ev = sim.events, n = 0;
    while (n < ev.length && ev[n].at <= st.t) n++;
    var prev = st.fired;
    if (n !== prev) {
      main.querySelectorAll('.sb-row[data-i]').forEach(function (row) {
        var i = Number(row.getAttribute('data-i')), past = i < n;
        if (row.classList.contains('sb-group')) {
          var g = row.getAttribute('data-group'), items = sim.events.filter(function (e) { return e.group === g; });
          var k = items.filter(function (e) { return e.at <= st.t; }).length;
          past = k > 0;
          var chip = row.querySelector('[data-gchip]');
          if (chip) chip.textContent = /^cancelled:/.test(g) ? (k ? COPY.cancelled : '') : k + ' of ' + items.length;
          var justG = !scrubbed && prev >= 0 && items.some(function (e) { return e._i >= prev && e._i < n; });
          if (justG) { row.classList.remove('is-fired'); void row.offsetWidth; row.classList.add('is-fired'); }
        } else if (!scrubbed && prev >= 0 && i >= prev && i < n) { row.classList.remove('is-fired'); void row.offsetWidth; row.classList.add('is-fired'); }
        row.classList.toggle('is-past', past);
        row.classList.toggle('is-future', !past);
        var c = row.querySelector('.sb-chip:not([data-gchip])');
        if (c) c.textContent = past ? c.getAttribute('data-chip') : COPY.due;
      });
      st.fired = n;
      placeNow(n, !scrubbed && prev >= 0 && n > prev);
    }
    var nowL = $('[data-now] span'); if (nowL) nowL.textContent = hm(st.t);
    var next = ev[n];
    var heldN = ev.slice(0, n).filter(function (e) { return e.status === 'skipped' || e.status === 'cancelled'; }).length;
    $('[data-next]').innerHTML = next ? '<span>' + esc(COPY.upNext) + '</span><b>' + esc(next.title) + '</b><span>in ' + esc(span(next.at - st.t)) + '</span><span class="sb-count">' + (n - heldN) + ' ' + esc(COPY.fired) + ' · ' + heldN + ' ' + esc(COPY.held) + '</span>'
      : '<b>' + esc(COPY.done) + '</b><span class="sb-count">' + (n - heldN) + ' ' + esc(COPY.fired) + ' · ' + heldN + ' ' + esc(COPY.held) + '</span>';
    if (st.t >= sim.end && st.playing) stop();
  }
  function placeNow(n, follow) {
    var old = $('[data-now]'); if (old) old.remove();
    var rows = Array.prototype.slice.call(main.querySelectorAll('.sb-tl > .sb-rows > .sb-row[data-i]'));
    var target = rows.filter(function (r) { return !r.classList.contains('is-past'); })[0];
    var li = document.createElement('li');
    li.className = 'sb-now'; li.setAttribute('data-now', ''); li.setAttribute('aria-hidden', 'true');
    li.innerHTML = '<span>' + esc(hm(st.t)) + '</span>';
    if (target) target.parentNode.insertBefore(li, target);
    else if (rows.length) rows[rows.length - 1].parentNode.appendChild(li);
    if (follow && st.playing) {
      var y = li.getBoundingClientRect().top, vh = window.innerHeight;
      if (y < 200 || y > vh - 140) window.scrollTo({ top: window.scrollY + y - vh * 0.45, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
  }
  function frame(now) {
    if (!st.playing) return;
    var dt = Math.min(100, now - (st.last || now));
    st.last = now;
    setT(st.t + dt / 1000 * st.speed);
    if (st.playing) st.raf = requestAnimationFrame(frame);
  }
  function play() {
    if (st.t >= st.sim.end) setT(st.sim.start, true);
    st.playing = true; st.last = 0;
    var b = $('[data-play]'); b.innerHTML = svg('pause'); b.setAttribute('aria-label', COPY.pause);
    st.raf = requestAnimationFrame(frame);
  }
  function stop() {
    st.playing = false; cancelAnimationFrame(st.raf);
    var b = $('[data-play]'); if (b) { b.innerHTML = svg('play'); b.setAttribute('aria-label', COPY.play); }
  }
  function toggle() { if (st.playing) stop(); else play(); }
  function stepNext() {
    stop();
    var next = st.sim.events.filter(function (e) { return e.at > st.t; })[0];
    if (!next) return;
    setT(next.at);
    var row = main.querySelector('[data-id="' + next.id.replace(/"/g, '') + '"]') || main.querySelector('.sb-row.is-fired');
    if (row) row.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }

  // ───────── the detail sheet ─────────
  var sheet = $('[data-sheet]'), scrim = $('[data-scrim]');
  function closeSheet() {
    sheet.classList.remove('is-on'); scrim.classList.remove('is-on');
    main.querySelectorAll('.sb-row.is-open').forEach(function (r) { r.classList.remove('is-open'); });
    setTimeout(function () { if (!sheet.classList.contains('is-on')) { sheet.hidden = true; scrim.hidden = true; sheet.innerHTML = ''; } }, 260);
    if (st.open && st.open.focus) st.open.focus();
    st.open = null;
  }
  function openDetail(id) {
    var ev = st.sim.events.filter(function (e) { return e.id === id; })[0];
    if (!ev) return;
    main.querySelectorAll('.sb-row.is-open').forEach(function (r) { r.classList.remove('is-open'); });
    var row = main.querySelector('[data-id="' + id.replace(/"/g, '') + '"]');
    if (row) row.classList.add('is-open');
    st.open = row ? row.querySelector('.sb-card') : null;
    sheet.hidden = false; scrim.hidden = false;
    requestAnimationFrame(function () { sheet.classList.add('is-on'); scrim.classList.add('is-on'); });
    sheet.innerHTML = head(ev) + '<p class="sb-loading">Rendering…</p>';
    bindSheet();
    var needs = ev.ch === 'email' || ev.ch === 'sms' || (ev.ch === 'call' && ev.ref.kind !== 'info');
    if (!needs) { sheet.innerHTML = head(ev) + body(ev, null); bindSheet(); return; }
    fetch('/admin/api/sandbox/detail?q=' + query() + '&id=' + encodeURIComponent(id), { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.ok) throw new Error('detail');
      sheet.innerHTML = head(ev) + body(ev, d.detail);
      bindSheet();
      var f = sheet.querySelector('iframe[data-frame]');
      if (f && d.detail.email) f.srcdoc = d.detail.email.html;
    }).catch(function () { sheet.innerHTML = head(ev) + '<p class="sb-why">' + esc(COPY.loadErr) + '</p>'; bindSheet(); });
  }
  function bindSheet() { var x = sheet.querySelector('[data-x]'); if (x) { x.onclick = closeSheet; x.focus({ preventScroll: true }); } }
  function head(ev) {
    var chip = STATUS[ev.status] || '';
    return '<div class="sb-sh-top ch-' + ev.ch + '"><span class="sb-node">' + svg(ev.ch) + '</span><div><h2 id="sb-sheet-h">' + esc(ev.title) + '</h2><p>' + esc(CH_NAME[ev.ch]) + ' · ' + esc(fmt(ev.at, { weekday: 'long', day: 'numeric', month: 'long' })) + ', ' + esc(hm(ev.at)) + ' ' + esc(COPY.theirTime) + ' · ' + esc(chip) + '</p></div>' +
      '<button type="button" class="sb-x" data-x aria-label="Close">' + svg('x') + '</button></div>' +
      (ev.reason ? '<p class="sb-why"><b>' + esc(ev.status === 'cancelled' ? COPY.whyCancelled : COPY.whyHeld) + '</b>' + esc(ev.reason) + '</p>' : '');
  }
  function body(ev, d) {
    var h = '';
    if (ev.lines && ev.lines.length) h += '<ul class="sb-lines">' + ev.lines.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul>';
    if (!d) return h;
    if (d.email) {
      h += '<dl class="sb-kv"><dt>' + esc(COPY.subject) + '</dt><dd><b>' + esc(d.email.subject) + '</b></dd>' + (d.email.preheader ? '<dt>' + esc(COPY.preheader) + '</dt><dd>' + esc(d.email.preheader) + '</dd>' : '') + '<dt>' + esc(COPY.from) + '</dt><dd>' + esc(d.email.from) + '</dd></dl>' +
        '<iframe class="sb-frame" data-frame sandbox="" title="Email preview" referrerpolicy="no-referrer"></iframe><p class="sb-meta">' + esc(COPY.emailFine) + '</p>';
    }
    if (d.text) {
      var tx = d.text;
      h += '<div class="sb-phone"><div class="sb-phone-h"><b>' + esc(tx.from) + '</b>Text message</div><div class="sb-bubble">' + esc(tx.body) + '</div>' +
        '<p class="sb-meta">' + tx.body.length + ' characters · ' + tx.segments + ' segment' + (tx.segments === 1 ? '' : 's') + (tx.firstText ? ' · ' + esc(COPY.textFirst) : '') + '</p></div>';
      if (tx.auVariant) h += '<div class="sb-sec"><h3>' + esc(COPY.auVariant) + '</h3><div class="sb-phone"><div class="sb-phone-h"><b>' + esc(tx.auVariant.from) + '</b>Text message</div><div class="sb-bubble">' + esc(tx.auVariant.body) + '</div><p class="sb-meta">' + tx.auVariant.segments + ' segment' + (tx.auVariant.segments === 1 ? '' : 's') + '</p></div></div>';
    }
    if (d.call) {
      var c = d.call, v = c.vars || {};
      h += '<dl class="sb-kv"><dt>' + esc(COPY.agent) + '</dt><dd>' + esc(c.agent) + ' <span class="sb-status ' + (c.live ? 'is-live' : 'is-off') + '">' + esc(c.live ? COPY.agentLive : COPY.agentOff) + '</span></dd>' +
        (v.flow_label ? '<dt>Step</dt><dd>' + esc(v.flow_label) + (v.attempt ? ', attempt ' + esc(v.attempt) : '') + '</dd>' : '') +
        (v.close_time && v.close_time !== 'not set' ? '<dt>Offer closes</dt><dd>' + esc(v.close_time) + '</dd>' : '') + '</dl>' +
        '<div class="sb-sec"><h3>' + esc(COPY.opening) + '</h3><p class="sb-quote">' + esc(c.firstMessage) + '</p></div>' +
        (c.sales ? '<div class="sb-sec sb-goal" data-objective><h3>' + esc(COPY.objective) + '</h3><p><b>' + esc(c.sales.label) + '.</b> ' + esc(c.sales.objective) + '</p>' +
          '<p class="sb-meta"><b>' + esc(COPY.success) + ':</b> ' + esc(c.sales.success) + '</p>' +
          (c.sales.examples && c.sales.examples.length ? '<p class="sb-meta"><b>' + esc(COPY.sayLike) + ':</b></p><ul class="sb-lines">' + c.sales.examples.map(function (x) { return '<li>“' + esc(x) + '”</li>'; }).join('') + '</ul>' : '') + '</div>' +
          '<div class="sb-sec sb-res" data-resource><h3>' + esc(COPY.painH) + '</h3>' +
          (c.sales.pain ? '<dl class="sb-kv"><dt>' + esc(COPY.painSays) + '</dt><dd>“' + esc(c.sales.pain.says) + '” <span class="sb-meta">(' + esc(c.sales.pain.label) + ')</span></dd>' +
            '<dt>' + esc(COPY.painOffer) + '</dt><dd><b>' + esc(c.sales.pain.title) + '</b>: ' + esc(c.sales.pain.why) + '<br><span class="sb-meta">' + esc(c.sales.pain.url) + '</span></dd></dl>' : '<p>' + esc(COPY.noPain) + '</p>') +
          '<p class="sb-meta">' + esc(c.sales.email) + '</p></div>' : '') +
        (c.booking ? '<div class="sb-sec" data-booking><h3>' + esc(c.booking.title) + '</h3>' + c.booking.lines.map(function (x) { return '<p>' + esc(x) + '</p>'; }).join('') +
          (c.booking.sample && c.booking.sample.length ? '<p class="sb-meta"><b>' + esc(COPY.sampleTimes) + ':</b></p><ul class="sb-lines">' + c.booking.sample.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul><p class="sb-meta">' + esc(c.booking.sampleNote) + '</p>' : '') + '</div>' : '') +
        (v.script ? '<div class="sb-sec"><h3>' + esc(COPY.script) + '</h3><pre class="sb-pre">' + esc(v.script) + '</pre></div>' : '') +
        (v.offer_facts ? '<details class="sb-more-d"><summary>' + esc(COPY.facts) + '</summary><pre class="sb-pre">' + esc(v.offer_facts) + (v.voicemail_rule ? '\n\n' + esc(v.voicemail_rule) : '') + '</pre></details>' : '') +
        '<details class="sb-more-d"><summary>' + esc(COPY.allVars) + '</summary><pre class="sb-pre">' + esc(Object.keys(v).filter(function (k) { return k !== 'script' && k !== 'offer_facts'; }).map(function (k) { return k + ': ' + v[k]; }).join('\n')) + '</pre></details>';
      if (c.talk) {
        var spec = { q: st.input, id: ev.id, title: c.talk.label };
        var b64 = btoa(unescape(encodeURIComponent(JSON.stringify(spec)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        h += '<div class="sb-talk"><a href="/admin/voice-demo?sb=' + b64 + '" target="_blank" rel="noopener">' + svg('mic') + esc(COPY.talk) + '</a><small>' + esc(COPY.talkFine) + '</small></div>';
      }
    }
    return h;
  }
  scrim.onclick = closeSheet;
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !sheet.hidden) { closeSheet(); return; }
    var tag = (e.target && e.target.tagName) || '';
    if (!st.sim || /INPUT|SELECT|TEXTAREA/.test(tag) || !sheet.hidden) return;
    if (e.key === ' ' && tag !== 'BUTTON') { e.preventDefault(); toggle(); }
    if (e.key === 'ArrowRight' && e.shiftKey) { e.preventDefault(); stepNext(); }
  });

  // ───────── start ─────────
  fetch('/admin/api/sandbox/options', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (o) {
    st.opts = o;
    var h = (location.hash || '').slice(1);
    if (h === 'live' || h === 'strategy') choose(h); else drawPicker();
  }).catch(function () { main.innerHTML = '<p class="sb-loading">' + esc(COPY.runErr) + '</p>'; });
  window.addEventListener('hashchange', function () { var h = location.hash.slice(1); if (!h && st.journey) drawPicker(); });
})();
