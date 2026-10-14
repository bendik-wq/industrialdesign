/* Funnel dashboard. No framework: small render functions per tab, SVG charts with hover tooltips. */
(function () {
  'use strict';

  // ───────────── helpers ─────────────
  var view = document.querySelector('[data-view]');
  var titleEl = document.querySelector('[data-title]');
  var subtitleEl = document.querySelector('[data-subtitle]');
  var filtersEl = document.querySelector('[data-filters]');
  var state = { tab: 'overview', days: 30, filters: {}, meta: null, leadsQuery: { q: '', tier: '', status: '', page: 0, sort: 'created' } };
  var liveTimer = null;
  var routing = false; // true while route() drives go(), so Back never pushes a new entry
  var lastHash = location.hash;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var nf = new Intl.NumberFormat();
  function n(v) { return nf.format(Math.round(v || 0)); }
  function pct(v, d) { return (v == null || !isFinite(v)) ? '–' : (v * 100).toFixed(d == null ? (v < 0.1 && v > 0 ? 1 : 0) : d) + '%'; }
  function money(v) { return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 }).format(v || 0); }
  function secs(v) { v = Math.round(v || 0); return v >= 60 ? Math.floor(v / 60) + 'm ' + (v % 60) + 's' : v + 's'; }
  function when(ms) { if (!ms) return '–'; var d = new Date(ms); return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
  function ago(ms) { var s = Math.round((Date.now() - ms) / 1000); if (s < 60) return s + 's ago'; if (s < 3600) return Math.round(s / 60) + 'm ago'; if (s < 86400) return Math.round(s / 3600) + 'h ago'; return Math.round(s / 86400) + 'd ago'; }
  function toast(msg) { var t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(function () { t.remove(); }, 2600); }

  function range() {
    var to = Date.now();
    var from = state.days >= 3650 ? 0 : (state.days === 1 ? new Date().setHours(0, 0, 0, 0) : to - state.days * 86400000);
    return { from: from || 1, to: to };
  }

  function api(path, params, opts) {
    var q = new URLSearchParams();
    var r = range();
    if (!opts || !opts.noRange) { q.set('from', r.from); q.set('to', r.to); q.set('tz', -new Date().getTimezoneOffset()); }
    Object.keys(state.filters).forEach(function (k) { if (state.filters[k]) q.set(k, state.filters[k]); });
    Object.keys(params || {}).forEach(function (k) { if (params[k] !== '' && params[k] != null) q.set(k, params[k]); });
    return fetch('/admin/api/' + path + '?' + q.toString(), { credentials: 'same-origin' }).then(function (res) {
      if (res.status === 401) { location.href = '/admin/login'; throw new Error('unauthorised'); }
      return res.json();
    });
  }
  function send(method, path, body) {
    return fetch('/admin/api/' + path, { method: method, credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(function (r) { return r.json(); });
  }

  // ───────────── charts ─────────────
  function niceMax(v) {
    if (v <= 0) return 1;
    var p = Math.pow(10, Math.floor(Math.log10(v)));
    var m = v / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
  }

  /** Grid steps that divide a nice max into clean numbers (50 → 5 × 10, 20 → 4 × 5, 10 → 2 × 5). */
  function tickCount(max) {
    if (max <= 2) return max; // counts: never a fractional tick
    var m = max / Math.pow(10, Math.floor(Math.log10(max)));
    return m === 5 ? 5 : m === 1 ? (max >= 10 ? 2 : 4) : 4;
  }

  /** Single-series line/area chart with crosshair tooltip. points: [{label, value}] */
  function lineChart(el, points, o) {
    o = o || {};
    var W = el.clientWidth || 600, H = o.height || 180, P = { l: 40, r: 14, t: 12, b: 24 };
    var iw = W - P.l - P.r, ih = H - P.t - P.b;
    var max = o.max || niceMax(Math.max.apply(null, points.map(function (p) { return p.value; }).concat([0])));
    var fmt = o.fmt || n;
    var x = function (i) { return P.l + (points.length <= 1 ? iw / 2 : (i / (points.length - 1)) * iw); };
    var y = function (v) { return P.t + ih - (v / max) * ih; };
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(o.label || 'chart') + '">';
    var ticks = o.max ? 4 : tickCount(max);
    for (var g = 0; g <= ticks; g++) {
      var gv = (max / ticks) * g;
      svg += '<line class="' + (g === 0 ? 'baseline' : 'gridline') + '" x1="' + P.l + '" x2="' + (W - P.r) + '" y1="' + y(gv) + '" y2="' + y(gv) + '"/>';
      svg += '<text class="tick" x="' + (P.l - 6) + '" y="' + (y(gv) + 4) + '" text-anchor="end">' + esc(fmt(gv)) + '</text>';
    }
    var step = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(iw / 70))));
    points.forEach(function (p, i) { var lastFits = i === points.length - 1 && (i % step) >= step * 0.6; if (i % step === 0 && (points.length - 1 - i >= step * 0.6 || i === points.length - 1) || lastFits) svg += '<text class="tick" x="' + x(i) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(p.short || p.label) + '</text>'; });
    if (o.marker != null && o.marker >= 0 && o.marker < points.length) {
      svg += '<line class="marker-line" x1="' + x(o.marker) + '" x2="' + x(o.marker) + '" y1="' + P.t + '" y2="' + (P.t + ih) + '"/>';
      svg += '<text class="marker-label" x="' + (x(o.marker) + 5) + '" y="' + (P.t + 10) + '">' + esc(o.markerLabel || '') + '</text>';
    }
    if (points.length) {
      var d = points.map(function (p, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(p.value).toFixed(1); }).join('');
      svg += '<path class="area" d="' + d + 'L' + x(points.length - 1) + ',' + y(0) + 'L' + x(0) + ',' + y(0) + 'Z"/>';
      svg += '<path class="line" d="' + d + '"/>';
      var last = points[points.length - 1];
      svg += '<circle class="dot" r="4" cx="' + x(points.length - 1) + '" cy="' + y(last.value) + '"/>';
      if (o.endLabel !== false) svg += '<text class="end-label" x="' + Math.min(W - 2, x(points.length - 1)) + '" y="' + (y(last.value) - 9) + '" text-anchor="end">' + esc(fmt(last.value)) + '</text>';
    }
    svg += '<line class="crosshair" data-ch x1="0" x2="0" y1="' + P.t + '" y2="' + (P.t + ih) + '" visibility="hidden"/><circle class="dot" data-hd r="4" visibility="hidden"/>';
    svg += '<rect data-hit x="' + P.l + '" y="0" width="' + iw + '" height="' + H + '" fill="transparent"/></svg><div class="tooltip" role="status"></div>';
    el.innerHTML = svg;
    var s = el.querySelector('svg'), ch = s.querySelector('[data-ch]'), hd = s.querySelector('[data-hd]'), tip = el.querySelector('.tooltip');
    if (!points.length) return;
    function show(evt) {
      var rect = s.getBoundingClientRect();
      var px = (evt.clientX - rect.left) * (W / rect.width);
      var i = Math.max(0, Math.min(points.length - 1, Math.round(((px - P.l) / iw) * (points.length - 1))));
      var p = points[i];
      ch.setAttribute('x1', x(i)); ch.setAttribute('x2', x(i)); ch.setAttribute('visibility', 'visible');
      hd.setAttribute('cx', x(i)); hd.setAttribute('cy', y(p.value)); hd.setAttribute('visibility', 'visible');
      tip.innerHTML = '<div class="t"></div><div class="r"><span class="key"></span><b></b><span class="muted"></span></div>';
      tip.querySelector('.t').textContent = p.label;
      tip.querySelector('b').textContent = fmt(p.value);
      tip.querySelector('.muted').textContent = o.series || '';
      var left = (x(i) / W) * rect.width;
      tip.style.left = Math.min(rect.width - 140, Math.max(0, left + 12)) + 'px';
      tip.style.top = '8px';
      tip.classList.add('on');
    }
    s.addEventListener('pointermove', show);
    s.addEventListener('pointerleave', function () { ch.setAttribute('visibility', 'hidden'); hd.setAttribute('visibility', 'hidden'); tip.classList.remove('on'); });
  }

  /** Vertical columns with per-column hover. */
  function columnChart(el, points, o) {
    o = o || {};
    var W = el.clientWidth || 500, H = o.height || 160, P = { l: 34, r: 8, t: 14, b: 24 };
    var iw = W - P.l - P.r, ih = H - P.t - P.b;
    var max = niceMax(Math.max.apply(null, points.map(function (p) { return p.value; }).concat([0])));
    var band = iw / Math.max(1, points.length), bw = Math.min(24, band - 2);
    var y = function (v) { return P.t + ih - (v / max) * ih; };
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(o.label || 'chart') + '">';
    var ct = Math.min(2, max); for (var g = 0; g <= ct; g++) { var gv = (max / ct) * g; svg += '<line class="' + (g ? 'gridline' : 'baseline') + '" x1="' + P.l + '" x2="' + (W - P.r) + '" y1="' + y(gv) + '" y2="' + y(gv) + '"/><text class="tick" x="' + (P.l - 6) + '" y="' + (y(gv) + 4) + '" text-anchor="end">' + n(gv) + '</text>'; }
    points.forEach(function (p, i) {
      var cx = P.l + band * i + band / 2, h = Math.max(p.value ? 2 : 0, ih - (y(p.value) - P.t)), top = P.t + ih - h, r = Math.min(4, h, bw / 2);
      var path = 'M' + (cx - bw / 2) + ',' + (P.t + ih) + 'V' + (top + r) + 'Q' + (cx - bw / 2) + ',' + top + ' ' + (cx - bw / 2 + r) + ',' + top + 'H' + (cx + bw / 2 - r) + 'Q' + (cx + bw / 2) + ',' + top + ' ' + (cx + bw / 2) + ',' + (top + r) + 'V' + (P.t + ih) + 'Z';
      svg += '<path class="col" data-i="' + i + '" d="' + path + '"/><rect data-i="' + i + '" x="' + (P.l + band * i) + '" y="' + P.t + '" width="' + band + '" height="' + ih + '" fill="transparent"/>';
      if (points.length <= 12 || i % 2 === 0) svg += '<text class="tick" x="' + cx + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(p.short || p.label) + '</text>';
    });
    svg += '</svg><div class="tooltip" role="status"></div>';
    el.innerHTML = svg;
    var s = el.querySelector('svg'), tip = el.querySelector('.tooltip');
    s.addEventListener('pointermove', function (e) {
      var i = e.target.getAttribute && e.target.getAttribute('data-i');
      if (i == null) { tip.classList.remove('on'); return; }
      var p = points[+i], rect = s.getBoundingClientRect();
      tip.innerHTML = '<div class="t"></div><div class="r"><b></b></div>';
      tip.querySelector('.t').textContent = p.label;
      tip.querySelector('b').textContent = (o.fmt || n)(p.value);
      tip.style.left = Math.min(rect.width - 130, ((P.l + band * +i + band) / W) * rect.width) + 'px';
      tip.style.top = '0px';
      tip.classList.add('on');
    });
    s.addEventListener('pointerleave', function () { tip.classList.remove('on'); });
  }

  /** Horizontal bar list (HTML) — values labelled at the tip. rows: [{name, value, note}] */
  function barList(rows, o) {
    o = o || {};
    var max = Math.max.apply(null, rows.map(function (r) { return r.value; }).concat([o.max || 0, 1]));
    // Room kept free for the longest value label, so every bar is drawn on the same scale.
    var reserve = Math.max(84, Math.round(Math.max.apply(null, rows.map(function (r) { return String((o.fmt || n)(r.value)).length + (r.note ? String(r.note).length + 1 : 0); }).concat([0])) * 7.2) + 16);
    return '<div class="bars ' + (o.cls || '') + '">' + rows.map(function (r) {
      // Bar length is honest: the share of the largest value, of the space left after the value label.
      var f = max ? Math.max(0, r.value || 0) / max : 0;
      return '<div class="bar-row"><div class="name" title="' + esc(r.name) + '">' + esc(r.name) + '</div><div class="bar-track"><div class="bar-fill' + (r.value ? '' : ' zero') + '" style="width:calc((100% - ' + reserve + 'px) * ' + f.toFixed(4) + ')' + (r.color ? ';background:' + r.color : '') + '"></div><span class="bar-val">' + esc((o.fmt || n)(r.value)) + (r.note ? '<small>' + esc(r.note) + '</small>' : '') + '</span></div></div>' +
        (r.rate != null ? '<div class="bar-row"><span></span><p class="step-rate' + (r.rateWarn ? ' warn' : '') + '"' + (r.rateTitle ? ' title="' + esc(r.rateTitle) + '"' : '') + '>↓ ' + esc(r.rate) + '</p></div>' : '');
    }).join('') + '</div>';
  }

  /** Stat tile. Words (names, "Off", "Not connected", "–") and long values get a calmer size; numbers stay big. With goTab it becomes a link to that tab. */
  function tile(label, value, hint, goTab, delta) {
    var v = String(value);
    var long = v !== '–' && (v.length > 12 || !/^[\s\d.,%$A-Z€£+\-–x×]*\d/.test(v)); // a lone dash keeps the number size, so tiles line up
    var dir = delta && delta.text ? ({ up: 'up', down: 'down', flat: 'flat' })[delta.dir] || 'flat' : '';
    // Nothing yet (0, 0%, –, A$0, "0 clicks", "0 min"): same size, quieter colour, so real numbers stand out.
    // delta.zeroOk: a rate where 0 is good news (0% cancel rate, 0% bounce) keeps its normal colour.
    var zero = v === '–' || (!(delta && delta.zeroOk) && (v === '0' || v === '0%' || v === '0.0%' || v === money(0) || v === '0 clicks' || v === '0 min' || v === '0s'));
    var inner = '<div class="label">' + esc(label) + '</div><div class="' + (long ? 'value value-text' : 'value') + (zero ? ' value-zero' : '') + '">' + esc(value) + '</div>' +
      (dir ? '<div class="delta ' + dir + '">' + esc(delta.text) + '</div>' : '') + (hint ? '<div class="hint">' + esc(hint) + '</div>' : '');
    if (goTab) return '<a class="tile tile-link" href="#' + esc(goTab) + '" data-go="' + esc(goTab) + '"' + (TABS[goTab] ? ' title="' + esc('Open ' + TABS[goTab].title) + '"' : '') + ' aria-label="' + esc(label + ': ' + value + ', open details') + '">' + inner + '<span class="tile-go" aria-hidden="true">→</span></a>';
    return '<div class="tile">' + inner + '</div>';
  }

  /** Lead status as a coloured pill (won green, booked blue, partial amber, lost outlined). Text unchanged. */
  function statusPill(s, label) {
    return '<span class="pill st-' + esc(String(s || '').replace(/[^a-z_]/gi, '')) + '">' + esc(label || s || '–') + '</span>';
  }

  /** The one calm empty state used everywhere. */
  function emptyState(msg, hint) {
    return '<div class="empty"><div>' + esc(msg) + '</div>' + (hint ? '<div class="empty-hint">' + esc(hint) + '</div>' : '') + '</div>';
  }

  function tierStack(a, b, c) {
    var t = a + b + c || 1;
    return '<div class="stack" role="img" aria-label="Tier A ' + a + ', B ' + b + ', C ' + c + '">' +
      [['A', a, '--tier-a'], ['B', b, '--tier-b'], ['C', c, '--tier-c']].filter(function (x) { return x[1]; }).map(function (x) {
        return '<span title="Tier ' + x[0] + ': ' + x[1] + '" style="flex:' + x[1] / t + ';background:var(' + x[2] + ')"></span>';
      }).join('') + '</div><div class="legend"><span><i style="background:var(--tier-a)"></i>A · qualified ' + n(a) + ' (' + pct(a / t) + ')</span><span><i style="background:var(--tier-b)"></i>B · mid-fit ' + n(b) + ' (' + pct(b / t) + ')</span><span><i style="background:var(--tier-c)"></i>C · nurture ' + n(c) + ' (' + pct(c / t) + ')</span></div>';
  }

  /** Tier badge. No tier: a dashed "step N" only for unfinished applications; anyone else (e.g. booked straight on Calendly) gets a muted "no tier". */
  function tierCell(l) {
    if (l.tier) return '<span class="tier ' + esc(l.tier) + '">' + esc(l.tier) + '</span>';
    if (l.status === 'partial') {
      var st = Number(l.step_reached) || 0;
      return st > 0 ? '<span class="tier partial" title="' + esc('Left the application at step ' + st) + '">step ' + esc(st) + '</span>' : '<span class="tier partial" title="Opened the application but didn’t answer the first question">not started</span>';
    }
    return '<span class="muted no-tier" title="' + (l.status === 'booked' ? 'Booked without finishing the application' : 'No tier: the application wasn’t finished') + '">no tier</span>';
  }

  function table(cols, rows, o) {
    o = o || {};
    if (!rows.length) return emptyState(o.empty || 'No data in this range yet.', o.emptyHint);
    // o.cards: on a phone each row becomes a small card, every cell labelled with its column (data-label); cards: 3 packs the values three across.
    // o.feed: on a phone each row becomes two lines (what happened · when, then who / where / source / device), for streams.
    return '<div class="table-wrap' + (o.cards ? ' tcards' + (o.cards === 3 ? ' tcards-3' : '') : '') + (o.feed ? ' tfeed' : '') + '"><table><thead><tr>' + cols.map(function (c) { return '<th class="' + (c.num ? 'num' : '') + (c.nw ? ' nw' : '') + '">' + esc(c.label) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr' + (o.rowAttr ? ' ' + o.rowAttr(r) : '') + '>' + cols.map(function (c) {
          var body, zero = false;
          if (c.html) {
            body = c.html(r);
            zero = !!c.num && !c.zeroOk && ZERO_CELL.test(String(body));
          } else {
            var txt = c.fmt ? c.fmt(r[c.key], r) : r[c.key];
            body = esc(txt);
            // A number column with nothing in it (0, 0%, A$0, –) reads quieter, so the real numbers stand out.
            zero = !!c.num && !c.zeroOk && ZERO_CELL.test(String(txt));
          }
          return '<td class="' + (c.num ? 'num' : '') + (c.nw ? ' nw' : '') + (zero ? ' zero' : '') + '" data-label="' + esc(c.label) + '">' + body + '</td>';
        }).join('') + '</tr>';
      }).join('') + '</tbody></table></div>';
  }
  var ZERO_CELL = /^(A?\$0(\.00)?|0(\.0)?%?|0s|–|-)$/;

  // ───────────── tabs ─────────────
  var TABS = {
    overview: { group: 'Today', title: 'Overview', sub: 'Every step from ad click to closed deal.', render: renderOverview },
    live: { group: 'Today', title: 'Live', sub: 'Real-time activity across the funnel (refreshes every 5 seconds).', render: renderLive, noFilters: true },
    leads: { group: 'Sell', title: 'Leads', sub: 'Every applicant, scored and routed. Click a row for their full journey.', render: renderLeads, filters: ['range', 'channel'] },
    sales: { group: 'Sell', title: 'Calls & deals', sub: 'Calls, show rate, closes and cash by rep. Log outcomes here.', more: 'Calls, show rate, closes and cash by rep. Log outcomes here — wins ping the team in Slack / Discord.', render: renderSales, filters: ['range'] },
    insights: { group: 'Sell', title: 'Best leads', sub: 'Who your best leads are: everyone who booked, split by tier, with the A-tier unpacked.', render: renderInsights, noFilters: true },
    map: { group: 'Funnel', title: 'Funnel map', sub: 'Every page, decision and automation, with live numbers.', more: 'How everything fits together: every page, decision and automation from ad click to closed deal, with live numbers. Drag to rearrange, click any box to see how it works, and add your own steps.', render: renderMap },
    screens: { group: 'Funnel', title: 'Page previews', sub: 'Every page in the funnel, in order, live.', more: 'Every page in the funnel, in order, live. Previews never count as visits, never fire ad pixels and can’t submit anything.', render: renderScreens, noFilters: true },
    pages: { group: 'Funnel', title: 'Landing pages & tests', sub: 'Every landing page and headline test, traced to cash.', more: 'Every page people land on, and every headline being tested: the main page’s A/B test plus 100 industry landers (20 industries × 5 headlines). Each visit is traced to applications, bookings and cash.', render: renderLanders },
    vsl: { group: 'Funnel', title: 'Video (VSL)', sub: 'Who watches, where they drop, and when they reach the pitch.', render: renderVsl },
    application: { group: 'Funnel', title: 'Application', sub: 'Step drop-off, answers and lead scoring.', render: renderApplication },
    behaviour: { group: 'Funnel', title: 'On-page behaviour', sub: 'What people click, where the form slows them down and where they leave.', more: 'What people click, where the form slows them down, where they leave, what they re-read and highlight. Nothing anyone types is ever recorded.', render: renderBehaviour, filters: ['range'] },
    traffic: { group: 'Traffic', title: 'Traffic & ads', sub: 'Which sources, campaigns and ads produce qualified leads — not just clicks.', render: renderTraffic },
    links: { group: 'Traffic', title: 'Links & videos', sub: 'One tracked link per video and placement, followed to closed deals.', more: 'One tracked link per video and placement, followed all the way from click to booked call to closed deal.', render: renderLinks, filters: ['range'] },
    webinar: { group: 'Traffic', title: 'Webinar', sub: 'Sessions, registrations, attendance and what they did next.', more: 'The masterclass at live.grosfjeld-li.com: sessions, who registered, who came and how long they watched, and how many went on to apply, book and buy.', render: renderWebinar, filters: ['range'] },
    data: { group: 'Traffic', title: 'Data partner page', sub: 'Who visited the data-buyer referral page, and who claimed a valuation.', more: 'The data-buyer referral page: who visited, watched, clicked and claimed a valuation, and where they came from.', render: renderData, filters: ['range'] },
    emails: { group: 'Follow-up', title: 'Emails', sub: 'Sequences, deliverability and engagement.', render: renderEmails, filters: ['range'] },
    sms: { group: 'Follow-up', title: 'SMS & WhatsApp', sub: 'Text and WhatsApp sequences: wording, timing and links.', more: 'Message sequences by text or WhatsApp: drag messages to organise them, edit the wording and timing, choose the link and when to skip. Only to people who agreed, 8am–8pm their time, max 3 a day.', render: renderSmsTab, noFilters: true },
    voice: { group: 'Follow-up', title: 'AI calls', sub: 'Outbound confirmations and inbound calls: transcripts, recordings, outcomes.', more: 'AI calls: outbound confirmations (ElevenLabs) and inbound phone / browser calls (Vapi). Transcripts, recordings and outcomes.', render: renderVoice, filters: ['range'] },
    team: { group: 'Setup', title: 'Reps & routing', sub: 'Who takes calls, which tiers they get, and where the team gets pinged.', more: 'Who takes calls, which tiers they get, their calendar, commission and targets — and where the team gets pinged.', render: renderTeam, noFilters: true },
    integrations: { group: 'Setup', title: 'Integrations', sub: 'Connect email, WhatsApp, calendars, analytics and ad platforms.', render: renderIntegrations, noFilters: true },
    tracking: { group: 'Setup', title: 'Ad tracking', sub: 'Every conversion sent from the server to Meta and GA4, and whether it arrived.', more: 'Every conversion sent to Meta (Conversions API) and GA4 from the server: delivery, retries and match quality.', render: renderTracking, filters: ['range'] },
  };

  var eyebrowEl = document.querySelector('[data-eyebrow]');
  var moreEl = document.querySelector('[data-more]');
  var moreTextEl = document.querySelector('[data-more-text]');
  var navCurrentEl = document.querySelector('[data-nav-current]');
  var navToggleEl = document.querySelector('[data-nav-toggle]');
  var clearBtn = document.querySelector('[data-clear]');

  /** Every history write goes through here, so route() can tell our own writes from Back/Forward. */
  // Entries the dashboard writes are marked, so route() can tell Back / Forward (marked) from a hash typed into the address bar (unmarked).
  function setHash(method, hash) { history[method]({ hq: 1 }, '', hash); lastHash = location.hash; }
  function markEntry() { try { if (!(history.state && history.state.hq)) history.replaceState({ hq: 1 }, '', location.href); } catch (e) { /* ignore */ } }

  /** Remove any open drawer (lead or visitor) without touching history. */
  function closeDrawers() {
    document.querySelectorAll('.drawer, .drawer-bg').forEach(function (el) { if (el.__teardown) el.__teardown(); el.remove(); });
  }

  function setNavOpen(open) {
    document.body.classList.toggle('nav-open', open);
    if (navToggleEl) navToggleEl.setAttribute('aria-expanded', String(open));
  }

  /** Keep the active nav item (and its group heading, when it is the first in its group) inside the nav's scroll box. */
  function revealActiveNav() {
    var nav = document.querySelector('[data-nav]');
    var btn = nav && nav.querySelector('button[aria-current="page"]');
    if (!btn || nav.scrollHeight <= nav.clientHeight) return;
    var prev = btn.previousElementSibling;
    var top = (prev && prev.classList.contains('nav-h') ? prev : btn).getBoundingClientRect().top;
    var bottom = btn.getBoundingClientRect().bottom;
    var box = nav.getBoundingClientRect();
    if (top < box.top + 14) nav.scrollTop -= box.top + 14 - top;
    else if (bottom > box.bottom - 26) nav.scrollTop += bottom - (box.bottom - 26);
  }

  /** Fade the nav's top / bottom edge only when there is more to scroll in that direction. */
  function updateNavFade() {
    var nav = document.querySelector('[data-nav]');
    if (!nav) return;
    nav.classList.toggle('fade-top', nav.scrollTop > 2);
    nav.classList.toggle('fade-bottom', nav.scrollHeight - nav.clientHeight - nav.scrollTop > 2);
  }

  function go(tab, opts) {
    closeDrawers();
    // Stop page previews before their view is replaced, so third-party scripts inside them end cleanly.
    view.querySelectorAll('.screen-frame iframe').forEach(function (f) { f.src = 'about:blank'; });
    if (tab === 'experiments' || tab === 'landers') tab = 'pages';
    if (!TABS[tab]) tab = 'overview';
    var T = TABS[tab];
    state.tab = tab;
    state.leadsQuery._focus = false; // a fresh visit never grabs the keyboard
    clearInterval(liveTimer);
    document.querySelectorAll('[data-nav] button').forEach(function (b) { b.setAttribute('aria-current', b.getAttribute('data-tab') === tab ? 'page' : 'false'); });
    titleEl.textContent = T.title;
    subtitleEl.textContent = T.sub;
    if (eyebrowEl) eyebrowEl.textContent = T.group || '';
    if (moreEl) { moreTextEl.textContent = T.more || ''; moreEl.hidden = !T.more; moreEl.open = false; }
    if (navCurrentEl) navCurrentEl.textContent = T.title;
    setNavOpen(false);
    filtersEl.style.display = T.noFilters ? 'none' : '';
    var f = T.filters;
    var rangeEl = filtersEl.querySelector('[data-range]');
    if (rangeEl) rangeEl.style.display = !f || f.indexOf('range') > -1 ? '' : 'none';
    filtersEl.querySelectorAll('select[data-filter]').forEach(function (sel) { sel.style.display = !f || f.indexOf(sel.getAttribute('data-filter')) > -1 ? '' : 'none'; });
    updateFilterCue();
    if (!routing) {
      var h = '#' + tab;
      // A lead hash left over from a drawer that go() just closed is replaced, never stacked.
      if (location.hash.indexOf('#lead=') === 0) setHash('replaceState', h);
      else if (location.hash !== h) setHash(opts && opts.replace ? 'replaceState' : 'pushState', h);
      // A fresh navigation starts at the top of the page; Back / Forward keep the browser's position.
      window.scrollTo(0, 0);
    }
    revealActiveNav();
    updateNavFade();
    load();
  }

  /** Back / Forward / a hash typed into the address bar: show what the URL says. */
  function route() {
    if (location.hash === lastHash) return; // popstate and hashchange both fire for one change
    lastHash = location.hash;
    var typed = !(history.state && history.state.hq); // a new entry from the address bar, not Back / Forward
    markEntry();
    var h = location.hash.slice(1);
    if (h.indexOf('lead=') === 0) {
      var id = decodeURIComponent(h.slice(5));
      var open = document.querySelector('.drawer[data-lead]');
      if (open && open.getAttribute('data-lead') === id) return;
      var hadDrawer = !!document.querySelector('.drawer');
      closeDrawers();
      if (state.tab !== 'leads' && !hadDrawer) { routing = true; go('leads'); routing = false; }
      openLead(id, { fromRoute: true });
      return;
    }
    closeDrawers();
    if ((h || 'overview') !== state.tab) {
      routing = true; go(h || 'overview'); routing = false;
      if (typed) window.scrollTo(0, 0); // a typed hash is a fresh visit: start at the top
    }
  }

  /** How many filters (visible on this tab) are narrowing the numbers; tints the bar and relabels Reset. */
  function updateFilterCue() {
    var count = 0;
    filtersEl.querySelectorAll('select[data-filter]').forEach(function (sel) {
      var v = state.filters[sel.getAttribute('data-filter')];
      sel.classList.toggle('on', !!v);
      if (v && sel.style.display !== 'none') count++;
    });
    // On Leads, the search box and the tier / status pickers in the list count too, so Reset clears them as well.
    if (state.tab === 'leads') ['tier', 'status', 'q'].forEach(function (k) { if (state.leadsQuery[k]) count++; });
    filtersEl.classList.toggle('is-filtered', count > 0);
    if (clearBtn) clearBtn.textContent = count ? 'Clear filters (' + count + ')' : 'Reset';
  }

  function load() {
    document.body.classList.add('loading');
    Promise.resolve(TABS[state.tab].render()).catch(function (e) { console.error(e); view.innerHTML = '<div class="empty">Couldn’t load this view. ' + esc(e.message) + '</div>'; })
      .then(function () { document.body.classList.remove('loading'); });
  }

  function renderMap() {
    var sum = function (arr, k) { return (arr || []).reduce(function (t, x) { return t + (x[k] || 0); }, 0); };
    var soft = function (p) { return p.catch(function () { return {}; }); };
    return Promise.all([
      api('overview'), soft(api('landers')), soft(api('triggers')), soft(api('experiments')),
      soft(fetch('/admin/api/map-layout', { credentials: 'same-origin' }).then(function (r) { return r.json(); })),
      soft(fetch('/admin/api/map-custom', { credentials: 'same-origin' }).then(function (r) { return r.json(); })),
    ]).then(function (r) {
      FunnelMap.render(view, {
        esc: esc, n: n, pct: pct, money: money, go: go,
        layout: r[4].layout || null,
        stats: { kpis: r[0].kpis, funnel: r[0].funnel, landerVisitors: sum(r[1].byIndustry, 'visitors'), mainVisitors: sum(r[3].variants, 'visitors'), triggerSent: sum(r[2].rules, 'sent') },
        save: function (pos) { send('PUT', 'map-layout', { layout: pos }); },
        custom: r[5].custom || null,
        saveCustom: function (custom) { send('PUT', 'map-custom', { custom: custom }); },
        tabs: Object.keys(TABS).filter(function (k) { return k !== 'map'; }).map(function (k) { return { id: k, title: TABS[k].title }; }),
      });
    });
  }

  /** A per-visitor rate that can pass 100% when some people's visits weren't tracked: say so instead of printing 140%. */
  function capRate(v, why) {
    if (v == null || !isFinite(v)) return '–';
    return v > 1 ? '<span title="' + esc(why || 'Includes claims from people whose visit wasn’t tracked') + '">100%+</span>' : esc(pct(v));
  }
  var ANGLE_LABEL = { cash: 'Cash', recap: 'Recapitalise', debt: 'Pay down debt', revenue: 'New revenue', curious: 'Curiosity' };
  function headlineCard(d) {
    var t = d.test || {}, rows = (d.headlines || []).slice();
    var pinned = rows.filter(function (r) { return r.id === t.mode; })[0];
    rows.sort(function (a, b) { return (b.best - a.best) || (b.visitors - a.visitors); });
    var leader = rows[0];
    var status = pinned ? '<strong>Pinned:</strong> everyone sees “' + esc(pinned.text) + '”.'
      : t.mode === 'even' ? '<strong>Even split:</strong> each headline gets 1/20 of new visitors.'
      : '<strong>Auto:</strong> every headline gets its first ' + n(t.min) + ' visitors, then traffic shifts to the ones that convert (currently judged on ' + esc(t.metric || 'claims') + ').';
    var bar = function (v) { return '<span class="hl-bar"><i style="width:' + Math.round(Math.min(1, v || 0) * 100) + '%"></i></span> ' + esc(pct(v || 0)); };
    return '<div class="card" style="margin-top:14px"><div class="hl-head"><div><h2>Headline test · 20 headlines</h2><p class="sub">' + status +
      (leader && leader.visitors && !pinned ? ' Leader right now: <strong>' + esc(leader.id) + '</strong> (' + esc(pct(leader.best)) + ' chance it’s the best).' : '') +
      ' Each person keeps the headline they first saw. Preview any with <span class="mono">?h=id</span> (previews aren’t counted).</p></div>' +
      '<div class="row">' + (t.mode !== 'auto' ? '<button class="btn-sm" data-hlmode="auto">Back to auto</button>' : '') + (t.mode !== 'even' ? '<button class="btn-sm ghost" data-hlmode="even">Even split</button>' : '') + '</div></div>' +
      table([
        { label: 'Headline', html: function (r) { return esc(r.text) + '<div class="muted"><span class="mono">' + esc(r.id) + '</span> · ' + esc(ANGLE_LABEL[r.angle] || r.angle) + ' · <a href="' + esc(d.url) + '/?h=' + esc(r.id) + '" target="_blank" rel="noopener">preview</a></div>'; } },
        { label: 'Visitors', key: 'visitors', num: true, fmt: n },
        { label: 'Clicked claim', num: true, html: function (r) { return esc(n(r.clicked)) + '<div class="muted">' + capRate(r.clickRate) + '</div>'; } },
        { label: 'Claims', num: true, html: function (r) { return esc(n(r.claims)) + '<div class="muted">' + capRate(r.rate) + '</div>'; } },
        { label: 'Chance best', html: function (r) { return bar(r.best); } },
        { label: 'Traffic now', html: function (r) { return pinned ? (r.id === pinned.id ? '100%' : '0%') : t.mode === 'even' ? '5%' : bar(r.share); } },
        { label: '', html: function (r) { return r.id === t.mode ? '<span class="pill">pinned</span>' : '<button class="btn-sm ghost" data-hlmode="' + esc(r.id) + '">Pin</button>'; } },
      ], rows) + '</div>';
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-hlmode]');
    if (!b) return;
    var m = b.getAttribute('data-hlmode');
    if (m !== 'auto' && m !== 'even' && !confirm('Show only this headline to everyone? (You can switch back to auto any time.)')) return;
    b.disabled = true;
    send('PUT', 'integrations', { DATA_HEADLINE_TEST: m }).then(function () { setTimeout(function () { go('data'); }, 300); });
  });
  var screenPrefs = (function () { try { return JSON.parse(localStorage.getItem('hq_screens') || '{}'); } catch (e) { return {}; } })();
  function renderScreens() {
    return api('pages', {}, { noRange: true }).then(function (d) {
      var dev = screenPrefs.dev === 'phone' ? 'phone' : 'desktop', size = ['s', 'm', 'l'].indexOf(screenPrefs.size) >= 0 ? screenPrefs.size : 'm';
      var W = dev === 'phone' ? { s: 200, m: 260, l: 340 }[size] : { s: 300, m: 420, l: 600 }[size];
      var DW = dev === 'phone' ? 390 : 1280, DH = dev === 'phone' ? 1500 : 1800, k = W / DW;
      var btn = function (key, val, label, cur) { return '<button class="btn-sm' + (cur === val ? '' : ' ghost') + '" data-sp="' + key + ':' + val + '">' + label + '</button>'; };
      var groups = [], byGroup = {};
      d.pages.forEach(function (p) { if (!byGroup[p.group]) { byGroup[p.group] = []; groups.push(p.group); } byGroup[p.group].push(p); });
      view.innerHTML = '<div class="card screens-bar"><div class="row">' + btn('dev', 'desktop', '🖥 Desktop', dev) + btn('dev', 'phone', '📱 Phone', dev) +
        '<span class="sep"></span>' + btn('size', 's', 'Small', size) + btn('size', 'm', 'Medium', size) + btn('size', 'l', 'Large', size) +
        '<span class="muted" style="margin-left:auto">Scroll sideways to follow the funnel →  Scroll inside a page to see all of it.</span></div></div>' +
        groups.map(function (g) {
          return '<h2 class="screens-group">' + esc(g) + '</h2><div class="screens-lane">' + byGroup[g].map(function (p, i) {
            return (i ? '<div class="screens-arrow" aria-hidden="true">→</div>' : '') +
              '<figure class="screen" style="width:' + W + 'px">' +
              '<figcaption><span class="screen-n">' + p.n + '</span><strong>' + esc(p.title) + '</strong><span class="muted">' + esc(p.desc) + '</span></figcaption>' +
              '<div class="screen-frame ' + dev + '" style="width:' + W + 'px;height:' + Math.round(DH * k) + 'px"><iframe loading="lazy" title="' + esc(p.title) + '" src="' + esc(p.src) + '" style="width:' + DW + 'px;height:' + DH + 'px;transform:scale(' + k + ')"></iframe></div>' +
              '<div class="row screen-actions"><span class="mono muted">' + esc(p.path.replace(/[?&]hq_as=\w+/, '')) + '</span><a class="btn-sm ghost" href="' + esc(p.src) + '" target="_blank" rel="noopener">Open ↗</a><button class="btn-sm ghost" data-reload="' + p.n + '">Reload</button></div></figure>';
          }).join('') + '</div>';
        }).join('') +
        '<p class="muted" style="margin-top:12px">Webinar “registered”, room and replay pages are personal (each needs a sign-up link), so they aren’t shown here. Open them from a test registration.</p>';
      view.querySelectorAll('[data-sp]').forEach(function (b) {
        b.onclick = function () { var kv = b.getAttribute('data-sp').split(':'); screenPrefs[kv[0]] = kv[1]; try { localStorage.setItem('hq_screens', JSON.stringify(screenPrefs)); } catch (e) { /* ignore */ } renderScreens(); };
      });
      view.querySelectorAll('[data-reload]').forEach(function (b) {
        b.onclick = function () { var f = b.closest('.screen').querySelector('iframe'); f.src = f.src; };
      });
    });
  }
  function renderData() {
    return api('data').then(function (d) {
      var f = d.funnel || {}, v = f.visitors || 0;
      // Claims can come from a direct link whose visit wasn't tracked, so a share can't honestly go over 100%.
      var share = function (x) { x = x || 0; return v && x <= v ? pct(x / v) + ' of visitors' : 'more than tracked visitors (some came from a direct link)'; };
      var claims = d.claims || [];
      var fu = claims.filter(function (c) { return !c.redirected; }).length;
      var when = function (t) { return new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); };
      view.innerHTML =
        (d.referral ? '' : '<div class="card notice" style="margin-bottom:14px"><strong>No partner referral link yet.</strong> Claims are saved here and pinged to the team; add the link under Integrations → Data so people go straight to ' + esc(d.partner) + ' after claiming.</div>') +
        '<div class="grid g-4 tiles">' +
        tile('Visitors', n(v), n(f.views) + ' page views') +
        tile('Watched the video', n(f.played), share(f.played)) +
        tile('Clicked “Claim”', n(f.cta), share(f.cta)) +
        tile('Claimed a valuation', n(f.claims), share(f.claims)) +
        '</div>' +
        '<div class="card" style="margin-top:14px"><h2>' + esc('Claims · ' + n(claims.length) + (fu ? ' · ' + n(fu) + ' need follow-up' : '')) + '</h2><p class="sub">Page: <a href="' + esc(d.url) + '" target="_blank" rel="noopener">' + esc(String(d.url).replace(/^https?:\/\//, '')) + '</a> · partner: ' + esc(d.partner) + (d.referral ? ' · sends people to <span class="mono">' + esc(d.referral) + '</span>' : '') + '</p>' +
        table([
          { label: 'When', html: function (r) { return esc(when(r.created_at)); } },
          { label: 'Name', key: 'first_name' },
          { label: 'Company', html: function (r) { return esc(r.company || '') + (r.website ? '<div class="muted">' + esc(r.website) + '</div>' : ''); } },
          { label: 'Contact', html: function (r) { return esc(r.email) + (r.phone ? '<div class="muted">' + esc(r.phone) + '</div>' : ''); } },
          { label: 'Revenue', html: function (r) { return esc(r.revenue || '–') + (r.business_status && r.business_status !== 'Trading' ? '<div><span class="pill">' + esc(r.business_status) + '</span></div>' : ''); } },
          { label: 'Headline', html: function (r) { return '<span class="mono">' + esc(r.headline || '–') + '</span>'; } },
          { label: 'Source', html: function (r) { return esc([r.channel, r.utm_source, r.utm_campaign].filter(Boolean).join(' · ') || '–'); } },
          { label: 'Sent to partner', html: function (r) { return r.redirected ? '✓' : '<span class="pill st-partial">Needs follow-up</span>'; } },
        ], claims, { rowAttr: function (r) { return r.visitor_id ? 'class="click" data-visitor="' + esc(r.visitor_id) + '" tabindex="0" title="See everything they did"' : ''; } }) + '</div>' +
        headlineCard(d) +
        '<div class="card" style="margin-top:14px"><h2>Recent visitors</h2><p class="sub">Everyone on the data page, newest first: what they scrolled, clicked, read and whether they claimed. Click a row for their full journey. Anonymous until they claim; then you see who they are.</p>' +
        table([
          { label: 'Last seen', html: function (r) { return esc(when(r.last_ts)) + (r.visits > 1 ? '<div class="muted">' + esc(n(r.visits)) + ' visits</div>' : ''); } },
          { label: 'Who', html: function (r) { return r.claim ? '<strong>' + esc(r.claim.first_name) + '</strong> · ' + esc(r.claim.company || '') + '<div class="muted">' + esc(r.claim.email) + '</div>' : r.lead_id ? '<span class="pill">funnel lead</span>' : '<span class="muted">Anonymous</span>'; } },
          { label: 'Source', html: function (r) { var s = r.session || {}; return esc([s.channel, s.utm_campaign].filter(Boolean).join(' / ') || 'Direct') + '<div class="muted">' + esc([s.device, [s.city, s.country].filter(Boolean).join(', ')].filter(Boolean).join(' · ')) + '</div>'; } },
          { label: 'Headline', html: function (r) { return '<span class="mono">' + esc(r.headline || '–') + '</span>'; } },
          { label: 'Time', num: true, html: function (r) { return esc(r.engaged_ms ? secs(Math.round(r.engaged_ms / 1000)) : '–'); } },
          { label: 'Scrolled', num: true, html: function (r) { return esc(r.scroll ? r.scroll + '%' : '–'); } },
          { label: 'Clicks', num: true, html: function (r) { return esc(n(r.clicks || 0)); } },
          { label: 'Did', html: function (r) { return [r.video ? 'video' : '', r.faqs ? n(r.faqs) + ' FAQ' : '', r.cta ? 'clicked Claim' : '', r.form ? 'opened form' : '', r.claim ? '<strong>claimed</strong>' : ''].filter(Boolean).join(' · ') || '<span class="muted">just looked</span>'; } },
        ], d.visitors || [], { rowAttr: function (r) { return 'class="click" data-visitor="' + esc(r.visitor_id) + '" tabindex="0"'; } }) + '</div>';
      view.querySelectorAll('[data-visitor]').forEach(function (row) {
        row.onclick = function () { openVisitor(row.getAttribute('data-visitor')); };
        row.onkeydown = function (e) { if (e.key === 'Enter') openVisitor(row.getAttribute('data-visitor')); };
      });
    });
  }
  function renderWebinar() {
    return api('webinar').then(function (d) {
      var k = d.kpis || {}, st = d.settings || {};
      var regs = k.registrations || 0;
      var when = function (t) { return new Date(t).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); };
      var MODE = { evergreen: 'Recording in sync', stream: 'Live in our room', live: 'Live link (Zoom…)' };
      var mins = function (s) { return s ? Math.round(s / 60) + ' min' : '–'; };
      view.innerHTML =
        (st.placeholderVideo ? '<div class="card notice" style="margin-bottom:14px"><strong>Using the VSL as a placeholder recording.</strong> Add your webinar recording under Integrations → Webinar (WEBINAR_VIDEO_SRC).</div>' : '') +
        '<div class="grid g-4 tiles">' +
        tile('Registrations', n(regs), n(k.people) + (k.people === 1 ? ' person' : ' people')) +
        tile('Show rate', pct(regs ? (k.attended || 0) / regs : null), n(k.attended) + ' attended · ' + n(k.replays) + ' watched the replay') +
        tile('Avg time watched', mins(k.avg_watch_s), 'of attendees') +
        tile('Clicked the offer', n(k.cta), pct(k.attended ? (k.cta || 0) / k.attended : null) + ' of attendees') +
        '</div><div class="grid g-4 tiles" style="margin-top:14px">' +
        tile('Applied', n(k.applied), pct(regs ? (k.applied || 0) / regs : null) + ' of registrants') +
        tile('Booked a call', n(k.booked), pct(regs ? (k.booked || 0) / regs : null) + ' of registrants') +
        tile('Won', n(k.won), money(k.revenue)) +
        tile('Weekly sessions', st.schedule || '–', (st.tz || '') + ' · ' + String(st.url || '').replace(/^https?:\/\//, '')) +
        '</div>' +
        '<div class="grid g-2" style="margin-top:14px">' +
        '<div class="card"><h2>Upcoming sessions</h2><p class="sub">Weekly sessions are created automatically from the schedule in Integrations → Webinar. Add a one-off or live session below.</p>' +
        table([
          { label: 'Starts', nw: true, html: function (r) { return esc(when(r.starts_at)) + (r.status === 'cancelled' ? ' <span class="pill">cancelled</span>' : ''); } },
          { label: 'Type', html: function (r) { return esc(MODE[r.mode] || r.mode) + (r.auto ? ' <span class="muted">· weekly</span>' : ''); } },
          { label: 'Registered', key: 'registrations', num: true, fmt: n },
          { label: '', html: function (r) { return r.status === 'cancelled' ? '' : '<button class="btn-sm ghost" data-cancel="' + esc(r.id) + '">Cancel &amp; move people</button>'; } },
        ], d.upcoming || [], { cards: true }) +
        '<form class="wform" data-wform style="margin-top:14px"><h3 class="h3">Add a session</h3>' +
        '<label>Date &amp; time <input class="input" type="datetime-local" name="starts_at" required></label>' +
        '<label>Type <select class="input" name="mode"><option value="evergreen">Recording played in sync</option><option value="stream">Live in our own room (Cloudflare Stream)</option><option value="live">Live on Zoom / YouTube (join link)</option></select></label>' +
        '<label data-joinwrap hidden>Join link <input class="input" name="join_url" placeholder="https://zoom.us/j/…"></label>' +
        '<label>Title (optional) <input class="input" name="title" maxlength="120" placeholder="' + esc(st.title) + '"></label>' +
        '<button class="btn-sm" type="submit">Add session</button> <span class="muted" data-wmsg></span></form></div>' +
        '<div class="card"><h2>Past sessions</h2><p class="sub">Show rate, how far people watched, and what they did next.</p>' +
        table([
          { label: 'Session', html: function (r) { return esc(when(r.starts_at)); } },
          { label: 'Reg.', key: 'registrations', num: true, fmt: n },
          { label: 'Came', html: function (r) { return n(r.attended) + ' <span class="muted">' + pct(r.registrations ? r.attended / r.registrations : null) + '</span>'; } },
          { label: 'Avg reached', html: function (r) { return mins(r.avg_pos); } },
          { label: 'Offer', key: 'cta', num: true, fmt: n },
          { label: 'Applied', key: 'applied', num: true, fmt: n },
          { label: 'Booked', key: 'booked', num: true, fmt: n },
        ], d.past || []) + '</div></div>' +
        '<div class="card" style="margin-top:14px"><h2>Registrants</h2><p class="sub">Click a row for the full journey.</p>' +
        table([
          { label: 'Name', html: function (r) { return esc([r.first_name, r.last_name].filter(Boolean).join(' ') || '–') + '<br><span class="muted">' + esc(r.email || '') + '</span>'; } },
          { label: 'Session', html: function (r) { return esc(when(r.starts_at)); } },
          { label: 'Source', html: function (r) { return esc([r.channel, r.utm_campaign].filter(Boolean).join(' / ') || 'Direct'); } },
          { label: 'Came', html: function (r) { return r.joined_at ? '✓ ' + mins(r.watch_seconds) : r.replay_at ? 'replay' : '–'; } },
          { label: 'Offer', html: function (r) { return r.cta_at ? '✓' : ''; } },
          { label: 'Next', html: function (r) { return r.status === 'won' ? statusPill('won') : r.booked_at ? statusPill('booked') : r.app_completed_at ? statusPill('applied', 'applied' + (r.tier ? ' (' + r.tier + ')' : '')) : ''; } },
        ], d.registrants || [], { rowAttr: function (r) { return 'class="click" data-lead="' + esc(r.lead_id) + '" tabindex="0"'; } }) + '</div>';
      view.querySelectorAll('[data-lead]').forEach(function (row) { row.onclick = function () { openLead(row.getAttribute('data-lead')); }; });
      view.querySelectorAll('[data-cancel]').forEach(function (b) {
        b.onclick = function () {
          if (!confirm('Cancel this session? Everyone registered is moved to the next session and emailed a new link.')) return;
          fetch('/admin/api/webinar/sessions/' + encodeURIComponent(b.getAttribute('data-cancel')), { method: 'DELETE', credentials: 'same-origin' }).then(function () { load(); });
        };
      });
      var f = view.querySelector('[data-wform]');
      f.mode.onchange = function () { f.querySelector('[data-joinwrap]').hidden = f.mode.value !== 'live'; };
      f.onsubmit = function (e) {
        e.preventDefault();
        var t = new Date(f.starts_at.value).getTime();
        send('POST', 'webinar/sessions', { starts_at: t, mode: f.mode.value, join_url: f.join_url.value, title: f.title.value }).then(function (r) {
          if (r && r.ok) load(); else f.querySelector('[data-wmsg]').textContent = (r && r.error) || 'Couldn’t add the session';
        });
      };
    });
  }

  /** "Needs attention" strip on Overview: the few things worth doing today, each a link. */
  function attentionHtml(k, sl, extra) {
    var chips = [], x = extra || {};
    if (sl && sl.needsOutcome && sl.needsOutcome.length) {
      var c = sl.needsOutcome.length;
      chips.push('<a class="chip warn" href="#sales" data-go="sales"><b>' + esc(n(c)) + '</b> ' + (c === 1 ? 'past call needs an outcome' : 'past calls need an outcome') + '</a>');
    }
    if (sl && sl.upcoming && sl.upcoming.length) {
      var u = sl.upcoming[0];
      var rep = u.closer_id ? reps().filter(function (r) { return r.id === u.closer_id; })[0] : null;
      chips.push('<a class="chip" href="#lead=' + esc(u.id) + '" data-open="' + esc(u.id) + '">' + esc('Next call: ' + when(u.call_at) + ' · ' + personName(u) + (rep ? ' with ' + rep.name : '')) + '</a>');
    }
    var aOpen = x.aOpen || 0, partial = x.partial || 0;
    if (aOpen > 0) chips.push('<a class="chip warn" href="#leads" data-go="leads" data-tier="A" data-status="applied"><b>' + esc(n(aOpen)) + '</b> A-tier ' + (aOpen === 1 ? 'lead hasn’t' : 'leads haven’t') + ' booked yet</a>');
    if (partial > 0) chips.push('<a class="chip" href="#leads" data-go="leads" data-status="partial"><b>' + esc(n(partial)) + '</b> unfinished ' + (partial === 1 ? 'application' : 'applications') + ' to chase</a>');
    if (x.simEmails) chips.push('<a class="chip" href="#integrations" data-go="integrations">Emails aren’t really sending yet: connect them</a>');
    if (!chips.length) return '<div class="attention calm" data-attention><span class="status-dot" style="background:var(--good)" aria-hidden="true"></span> All caught up: no calls to log and no hot leads waiting.</div>';
    return '<div class="attention" data-attention><span class="attention-h">Needs attention</span>' + chips.join('') + '</div>';
  }

  /** "vs previous period" line for a count tile: ▲ 12% / ▼ 8% / flat. Null when there's nothing honest to compare. */
  function periodLabel() { return state.days === 1 ? 'day' : state.days + ' days'; }
  function dCount(cur, prev) {
    if (prev == null) return null;
    cur = Number(cur) || 0; prev = Number(prev) || 0;
    if (prev === 0) return cur ? { text: 'none in prev ' + periodLabel(), dir: 'flat' } : null; // nothing to compare with: say so quietly
    var ch = (cur - prev) / prev;
    if (!isFinite(ch)) return null;
    if (Math.abs(ch) < 0.02) return { text: 'no change vs prev ' + periodLabel(), dir: 'flat' };
    return { text: (ch > 0 ? '▲ ' : '▼ ') + pct(Math.abs(ch)) + ' vs prev ' + periodLabel(), dir: ch > 0 ? 'up' : 'down' };
  }
  /** Same for a rate tile, in percentage points. */
  function dRate(cur, prev) {
    if (cur == null || prev == null || !isFinite(cur) || !isFinite(prev)) return null;
    var raw = (cur - prev) * 100, pts = Math.abs(raw) < 1 ? Math.round(raw * 10) / 10 : Math.round(raw); // small rates keep one decimal
    if (!pts) return { text: 'no change vs prev ' + periodLabel(), dir: 'flat' };
    return { text: (pts > 0 ? '+' : '−') + Math.abs(pts) + ' pts vs prev ' + periodLabel(), dir: pts > 0 ? 'up' : 'down' };
  }

  function renderOverview() {
    var r = range();
    var cheap = { page: 0, sort: 'created', channel: state.filters.channel || '', from: r.from, to: r.to }; // same query the Leads tab runs
    var withPrev = state.days < 3650;
    return Promise.all([
      api('overview'), api('sales').catch(function () { return null; }),
      fetchLeads(Object.assign({ tier: 'A', status: 'applied' }, cheap)).catch(function () { return null; }),
      fetchLeads(Object.assign({ status: 'partial' }, cheap)).catch(function () { return null; }),
      withPrev ? api('overview', { from: Math.max(1, r.from - (r.to - r.from)), to: r.from }).catch(function () { return null; }) : null,
    ]).then(function (res) {
      var d = res[0], sl = res[1];
      var k = d.kpis;
      var pk = res[4] && res[4].kpis ? res[4].kpis : null;
      var dc = function (f) { return pk ? dCount(k[f], pk[f]) : null; };
      // A rate compared with a period that had no visitors at all isn't a change, it's an absence: show nothing.
      var dr = function (f) { return pk && Number(pk.visitors) > 0 ? dRate(k[f], pk[f]) : null; };
      if (sl && sl.needsOutcome) setNavBadge('sales', sl.needsOutcome.length);
      var unlogged = sl && sl.needsOutcome ? sl.needsOutcome.length : 0;
      // Every email in range was only simulated (no email provider connected): rates would read a meaningless 0%. Older APIs lack the fields → normal card.
      var simOnly = k.emails_simulated > 0 && k.emails_real === 0;
      var last = d.funnel.length - 1;
      var funnelRows = d.funnel.map(function (s, i) {
        var row = { name: s.label, value: s.n, note: i ? pct(d.funnel[0].n ? s.n / d.funnel[0].n : 0) + ' of landing' : '', rate: null };
        if (i < last && s.n > 0) {
          var nx = d.funnel[i + 1].n;
          if (nx > s.n) { row.rate = pct(nx / s.n) + ' reach the next step · some people skip this step'; row.rateTitle = 'More people reached the next step than this one: steps are tracked separately, so not everyone passes through each one.'; }
          else { row.rate = pct(nx / s.n) + ' continue'; row.rateWarn = nx / s.n < 0.5; }
        }
        return row;
      });
      // Booked → next step: past calls with no outcome logged count as "not continuing" until someone logs them, so don't flag that as a real drop.
      var bookRow = funnelRows.filter(function (row) { return /book/i.test(row.name); })[0];
      if (unlogged > 0 && bookRow && bookRow.rate) {
        bookRow.rateWarn = false;
        bookRow.rate += ' · ' + n(unlogged) + (unlogged === 1 ? ' call' : ' calls') + ' not logged yet';
        bookRow.rateTitle = 'Calls that have passed without an outcome count as not continuing until they are logged on Calls & deals.';
      }
      view.innerHTML =
        attentionHtml(k, sl, { aOpen: (res[2] && res[2].total) || 0, partial: (res[3] && res[3].total) || 0, simEmails: simOnly }) +
        '<div class="grid g-4 tiles">' +
        tile('Visitors', n(k.visitors), n(k.sessions) + ' sessions · ' + pct(k.bounce_rate) + ' bounce', 'traffic', dc('visitors')) +
        tile('VSL play rate', pct(k.play_rate), pct(k.unmute_rate) + ' unmuted · avg ' + pct(k.avg_watch_pct) + ' watched', 'vsl', dr('play_rate')) +
        tile('Applications', n(k.applications), n(k.leads) + ' leads · ' + pct(k.app_completion_rate) + ' finish the form', 'application', dc('applications')) +
        tile('Calls booked', n(k.booked), 'booked in range · ' + pct(k.booking_rate) + ' of qualified · ' + pct(k.show_rate) + ' show rate' + (unlogged ? ' · ' + n(unlogged) + ' not logged' : ''), 'sales', dc('booked')) +
        '</div><div class="grid g-4 tiles" style="margin-top:14px">' +
        tile('Opt-in rate', pct(k.opt_in_rate, 1), 'Contact details / landing visitors', 'application', dr('opt_in_rate')) +
        tile('Pitch reached', pct(k.pitch_rate), 'Of plays reach the CTA moment', 'vsl', dr('pitch_rate')) +
        tile('Revenue', money(k.revenue), n(k.won) + ' won · ' + money(k.revenue_per_visitor) + ' / visitor', 'sales', dc('revenue')) +
        tile('WhatsApp', n(k.whatsapp_clicks) + ' clicks', n(k.whatsapp_connected) + ' connected via ref code', 'sms') +
        '</div>' +
        '<div class="grid g-2 g-top" style="margin-top:14px">' +
        '<div class="card"><div class="card-head"><div><h2>Funnel</h2><p class="sub">Unique people reaching each step in this range.</p></div><a class="btn-sm ghost" href="#map" data-go="map">See it on the map →</a></div>' + barList(funnelRows, { cls: 'funnel' }) + '</div>' +
        '<div class="grid" style="align-content:start"><div class="card"><div class="card-head"><div><h2>Lead quality</h2><p class="sub">Applications by routing tier · average score ' + n(k.avg_score) + '</p></div><a class="card-link" href="#insights" data-go="insights">Who they are →</a></div>' + tierStack(k.tier_a, k.tier_b, k.tier_c) + '</div>' +
        // Nothing really sent yet: no empty rate boxes, just one quiet line and the way to connect it.
        (simOnly ? '<div class="card"><div class="card-head"><div><h2>Email</h2><p class="sub">' + esc(n(k.emails_sent) + ' written · none actually sent yet (email not connected)') + '</p></div><a class="btn-sm ghost" href="#integrations" data-go="integrations">Connect email →</a></div>' +
          '<p class="muted email-wait">Open and click rates appear here once emails send for real. <a class="card-link" href="#emails" data-go="emails">See the emails →</a></p></div></div>'
          : '<div class="card"><h2>Email</h2><p class="sub">' + n(k.emails_sent) + ' sent in range</p><div class="grid g-2 tiles">' +
          tile('Open rate', pct(k.email_open_rate), 'iPhones auto-open some emails, so this runs high', 'emails') + tile('Click rate', pct(k.email_click_rate), null, 'emails') + '</div></div></div>') +
        '</div>' +
        '<h3 class="section-title">Daily trend</h3><div class="grid g-2" data-daily></div>';
      var dailyEl = view.querySelector('[data-daily]');
      [['visitors', 'Landing visitors'], ['plays', 'VSL plays'], ['applications', 'Applications'], ['booked', 'Calls booked']].forEach(function (m) {
        var card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = '<h2>' + esc(m[1]) + '</h2><p class="sub">Per day</p><div class="chart"></div>';
        dailyEl.appendChild(card);
        var pts = d.daily.map(function (r) { var dt = new Date(r.day + 'T00:00:00'); return { label: dt.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }), short: dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), value: r[m[0]] }; });
        lineChart(card.querySelector('.chart'), pts, { series: m[1], label: m[1] + ' per day', height: 150 });
      });
    });
  }

  function renderVsl() {
    var videos = (state.meta && state.meta.videos) || [{ id: 'vsl-main' }];
    var video = state.video || videos[0].id;
    return api('vsl', { video: video }).then(function (d) {
      var s = d.summary || {};
      var dur = s.duration || 0;
      view.innerHTML =
        '<div class="row" style="margin-bottom:12px"><div class="seg" data-video>' + videos.map(function (v) { return '<button data-v="' + esc(v.id) + '" aria-pressed="' + (v.id === video) + '">' + esc(v.id.replace('vsl-', '')) + '</button>'; }).join('') + '</div></div>' +
        '<div class="grid g-4 tiles">' + tile('Views (with sound)', n(s.views), n(s.viewers) + ' unique viewers') + tile('Avg watched', pct(s.avg_pct), secs(s.avg_seconds) + ' average watch time') +
        tile('Reached the pitch', pct(s.reveal_rate), d.ctaRevealAt ? 'CTA reveals at ' + secs(d.ctaRevealAt) : 'CTA shown immediately') + tile('Clicked the CTA', pct(s.cta_rate), pct(s.completion_rate) + ' watched to the end') + '</div>' +
        '<div class="card" style="margin-top:14px"><h2>Audience retention</h2><p class="sub">Share of views still watching at each point of the video' + (dur ? ' (' + secs(dur) + ' long)' : '') + '. The line marks the pitch.</p><div class="chart" data-ret></div></div>' +
        '<div class="grid g-2" style="margin-top:14px"><div class="card"><h2>Biggest drop-offs</h2><p class="sub">Where the most viewers leave — re-edit these moments first.</p>' +
        table([{ label: 'Moment', html: function (r) { return esc(r.second != null ? secs(r.second) : r.pct + '%') + ' <span class="muted">(' + r.pct + '%)</span>'; } }, { label: 'Viewers lost', num: true, fmt: function (v) { return pct(v, 1); }, key: 'drop' }], d.drops.filter(function (x) { return x.drop > 0; })) + '</div>' +
        '<div class="card"><h2>By headline variant & device</h2><p class="sub">Does the hook change how long people watch?</p>' +
        table([{ label: 'Variant', key: 'key' }, { label: 'Views', key: 'views', num: true, fmt: n }, { label: 'Avg watched', key: 'avg_pct', num: true, fmt: function (v) { return pct(v); } }, { label: 'Pitch', key: 'reveal_rate', num: true, fmt: function (v) { return pct(v); } }, { label: 'CTA', key: 'cta_rate', num: true, fmt: function (v) { return pct(v); } }], d.byVariant) +
        '<div style="height:12px"></div>' +
        table([{ label: 'Device', key: 'key' }, { label: 'Views', key: 'views', num: true, fmt: n }, { label: 'Avg watched', key: 'avg_pct', num: true, fmt: function (v) { return pct(v); } }, { label: 'Unmuted', key: 'unmute_rate', num: true, fmt: function (v) { return pct(v); } }], d.byDevice) + '</div></div>';
      var pts = d.retention.map(function (v, i) { var sec = dur ? Math.round((i / 100) * dur) : null; return { label: (sec != null ? secs(sec) + ' · ' : '') + i + '% through', short: sec != null ? secs(sec) : i + '%', value: v }; });
      var marker = dur && d.ctaRevealAt ? Math.round((d.ctaRevealAt / dur) * 100) : null;
      lineChart(view.querySelector('[data-ret]'), pts, { fmt: function (v) { return pct(v); }, max: 1, height: 240, series: 'still watching', marker: marker, markerLabel: 'Pitch / CTA', label: 'Audience retention', endLabel: true });
      view.querySelectorAll('[data-video] button').forEach(function (b) { b.onclick = function () { state.video = b.getAttribute('data-v'); load(); }; });
    });
  }

  function renderTraffic() {
    var dims = (state.meta && state.meta.dimensions) || [{ key: 'channel', label: 'Channel' }];
    var dim = state.dim || 'channel';
    return api('attribution', { dim: dim }).then(function (d) {
      var rows = d.rows;
      var maxQ = Math.min(1, Math.max.apply(null, rows.map(function (r) { return r.qualified_rate || 0; }).concat([0.0001])));
      view.innerHTML =
        '<div class="row" style="margin-bottom:12px"><label class="muted" for="dim">Break down by</label><select id="dim" class="input" data-dim>' + dims.map(function (x) { return '<option value="' + esc(x.key) + '"' + (x.key === dim ? ' selected' : '') + '>' + esc(x.label) + '</option>'; }).join('') + '</select><span class="spacer"></span><span class="muted">Leads are attributed to their last non-direct touch before applying.</span></div>' +
        '<div class="card">' + table([
          { label: d.label, html: function (r) { return '<strong>' + esc(r.key) + '</strong>'; } },
          { label: 'Visitors', key: 'visitors', num: true, fmt: n },
          { label: 'Bounce', key: 'bounce_rate', num: true, zeroOk: true, fmt: function (v) { return pct(v); } },
          { label: 'Engaged', key: 'avg_engaged_s', num: true, fmt: secs },
          { label: 'Leads', key: 'leads', num: true, fmt: n },
          { label: 'Apps', key: 'applications', num: true, fmt: n },
          { label: 'Qualified', key: 'qualified', num: true, fmt: n },
          { label: 'Qualified / visitor', num: true, html: function (r) { var q = r.qualified_rate || 0; return (q > 1 ? '<span title="Includes leads who booked directly without a tracked visit">100%+</span>' : esc(pct(q, 1))) + '<span class="inbar" style="width:' + Math.round((Math.min(1, q) / maxQ) * 50) + 'px"></span>'; } },
          { label: 'Avg score', key: 'avg_score', num: true, fmt: n },
          { label: 'Booked', key: 'booked', num: true, fmt: n },
          { label: 'Showed', key: 'showed', num: true, fmt: n },
          { label: 'Won', key: 'won', num: true, fmt: n },
          { label: 'Revenue', key: 'revenue', num: true, fmt: money },
          { label: 'Rev / visitor', key: 'revenue_per_visitor', num: true, fmt: money },
        ], rows, { cards: true }) + '</div>' +
        '<p class="muted" style="margin-top:10px">Tip: tag ads with <span class="mono">utm_source</span>, <span class="mono">utm_campaign</span>, <span class="mono">utm_content={{ad.name}}</span> and <span class="mono">ad_id={{ad.id}}</span> to see quality per ad.</p>';
      view.querySelector('[data-dim]').onchange = function (e) { state.dim = e.target.value; load(); };
    });
  }

  function renderApplication() {
    return api('application').then(function (d) {
      // Step 1 = 100%: people can start on the main page's form without ever opening /apply, so page views aren't the base.
      var base = (d.steps[0] && d.steps[0].reached) || d.started || 1;
      var stepRows = d.steps.map(function (s) { return { name: s.step + '. ' + s.title, value: s.reached, note: pct(s.reached / base) }; });
      view.innerHTML =
        '<div class="grid g-4 tiles">' + tile('Viewed', n(d.page_views)) + tile('Started (contact given)', n(d.started), d.started > d.page_views ? 'includes the main-page form' : pct(d.started / (d.page_views || 1)) + ' of viewers') + tile('Completed', n(d.completed), pct(d.completed / (d.started || 1)) + ' of starters') +
        tile('Closer split', d.closers.map(function (c) { return c.name.split(' ')[0] + ' ' + c.leads; }).join(' · ') || '–') + '</div>' +
        '<div class="grid g-2" style="margin-top:14px"><div class="card"><h2>Step drop-off</h2><p class="sub">' + esc('People who reached each question (step 1 = 100%). ' + n(d.page_views) + ' opened the separate /apply page; the rest started on the main page.') + '</p>' + barList(stepRows) + '</div>' +
        '<div class="grid"><div class="card"><h2>Score distribution</h2><p class="sub">Completed applications by score. A ≥ 70, B ≥ 40.</p><div class="chart" data-hist></div></div>' +
        '<div class="card"><h2>Tier caps applied</h2><p class="sub">Hard rules that lowered a lead’s tier.</p>' + table([{ label: 'Reason', key: 'reason' }, { label: 'Leads', key: 'n', num: true, fmt: n }], d.caps) + '</div></div></div>' +
        '<h3 class="section-title">Answers</h3><div class="grid g-2">' + d.distributions.map(function (q) {
          return '<div class="card"><h2>' + esc(q.title) + '</h2><p class="sub">' + n(q.answered) + ' answered</p>' + barList(q.options.map(function (o) { return { name: o.label + ' (' + o.points + ' pts)', value: o.n, note: pct(o.n / (q.answered || 1)) }; })) + '</div>';
        }).join('') + '</div>';
      columnChart(view.querySelector('[data-hist]'), d.score_histogram.map(function (h) { return { label: 'Score ' + h.range, short: h.range.split('–')[0], value: h.n }; }), { label: 'Score distribution' });
    });
  }

  // ── Leads ──
  var leadsSearchT = null;
  function renderLeads() {
    var q = state.leadsQuery, r = range();
    var params = { q: q.q, tier: q.tier, status: q.status, page: q.page, sort: q.sort, channel: state.filters.channel || '', from: r.from, to: r.to };
    return fetchLeads(params).then(function (d) {
      var statuses = (state.meta && state.meta.statuses) || [];
      var live = view.querySelector('[data-q]');
      var typed = live && document.activeElement === live ? live.value : null;
      if (typed != null) q._caret = live.selectionStart;
      var exportUrl = '/admin/api/export/leads.csv?' + new URLSearchParams(Object.fromEntries(Object.entries(params).filter(function (e) { return e[1] !== '' && e[0] !== 'page'; }))).toString();
      view.innerHTML =
        '<div class="card"><div class="leads-tools"><input class="input" type="search" placeholder="Search name, email, phone or ref" aria-label="Search leads" data-q value="' + esc(q.q) + '">' +
        '<select class="input" data-tier aria-label="Tier"><option value="">All tiers</option><option>A</option><option>B</option><option>C</option></select>' +
        '<select class="input" data-status aria-label="Status"><option value="">All statuses</option>' + statuses.map(function (s) { return '<option>' + esc(s) + '</option>'; }).join('') + '</select>' +
        '<select class="input" data-sort aria-label="Sort"><option value="created">Newest</option><option value="score">Highest score</option><option value="call">Call time</option><option value="updated">Recently updated</option></select>' +
        '<span class="spacer"></span><span class="muted">' + n(d.total) + ' leads</span><a class="btn-sm ghost" href="' + esc(exportUrl) + '">Export CSV</a></div>' +
        table([
          { label: 'Lead', html: function (l) { var em = l.email || ''; return '<strong>' + esc([l.first_name, l.last_name].filter(Boolean).join(' ') || '—') + '</strong><div class="muted ell" title="' + esc(em) + '">' + esc(em) + '</div>'; } },
          { label: 'Tier', nw: true, html: tierCell },
          { label: 'Score', key: 'score', num: true, nw: true, fmt: function (v) { return v == null ? '–' : v; } },
          { label: 'Status', nw: true, html: function (l) { return statusPill(l.status); } },
          { label: 'Video', key: 'vsl_pct', num: true, nw: true, fmt: function (v) { return v == null ? '–' : pct(Math.min(1, v)); } },
          { label: 'Source', html: function (l) { var sub = (l.utm_campaign || '') + (l.utm_content ? ' · ' + l.utm_content : ''); return esc(l.channel || 'Direct') + '<div class="muted ell" title="' + esc(sub) + '">' + (esc(sub) || '&nbsp;') + '</div>'; } },
          { label: 'Call', nw: true, html: function (l) { return l.call_at ? esc(when(l.call_at)) : l.booked_at ? 'booked' : '<span class="muted">–</span>'; } },
          { label: 'WhatsApp', nw: true, html: function (l) { return l.whatsapp_connected_at ? '<span class="pill st-won" title="Connected">connected</span>' : l.whatsapp_clicked_at ? '<span class="pill" title="Clicked">clicked</span>' : ''; } },
          { label: 'Country', key: 'country', nw: true },
          { label: 'Created', nw: true, html: function (l) { return '<span title="' + esc(when(l.created_at)) + '">' + esc(ago(l.created_at)) + '</span>'; } },
        ], d.rows, { rowAttr: function (l) { return 'class="click" data-lead="' + esc(l.id) + '" tabindex="0"'; }, empty: 'No leads match.', emptyHint: q.q || q.tier || q.status ? 'Try clearing the search or filters.' : '' }) + '</div>' +
        '<div class="row" style="margin-top:12px"><button class="btn-sm ghost" data-prev ' + (q.page ? '' : 'disabled') + '>← Prev</button><span class="muted">Page ' + (q.page + 1) + ' of ' + Math.max(1, Math.ceil(d.total / d.pageSize)) + '</span><button class="btn-sm ghost" data-next ' + ((q.page + 1) * d.pageSize < d.total ? '' : 'disabled') + '>Next →</button></div>';
      view.querySelector('[data-tier]').value = q.tier;
      view.querySelector('[data-status]').value = q.status;
      view.querySelector('[data-sort]').value = q.sort;
      // Typing re-renders the list; put the cursor back where it was so the next keystroke lands in the box.
      var qIn = view.querySelector('[data-q]');
      if (typed != null && typed !== qIn.value) qIn.value = typed; // keys pressed while the list was loading
      if (q._focus) { qIn.focus(); var c = q._caret == null ? qIn.value.length : Math.min(q._caret, qIn.value.length); try { qIn.setSelectionRange(c, c); } catch (x) { /* type=search may refuse */ } }
      qIn.oninput = function (e) {
        clearTimeout(leadsSearchT);
        q._focus = true; q._caret = e.target.selectionStart;
        leadsSearchT = setTimeout(function () {
          var cur = view.querySelector('[data-q]');
          if (!cur || state.tab !== 'leads') return;
          q._focus = document.activeElement === cur; q._caret = cur.selectionStart;
          q.q = cur.value; q.page = 0; load();
        }, 300);
      };
      qIn.onblur = function () { setTimeout(function () { if (document.activeElement !== qIn && view.contains(qIn)) q._focus = false; }, 0); };
      view.querySelector('[data-tier]').onchange = function (e) { q.tier = e.target.value; q.page = 0; load(); };
      view.querySelector('[data-status]').onchange = function (e) { q.status = e.target.value; q.page = 0; load(); };
      view.querySelector('[data-sort]').onchange = function (e) { q.sort = e.target.value; load(); };
      view.querySelector('[data-prev]').onclick = function () { q.page--; load(); };
      view.querySelector('[data-next]').onclick = function () { q.page++; load(); };
      view.querySelectorAll('[data-lead]').forEach(function (row) {
        row.onclick = function () { openLead(row.getAttribute('data-lead')); };
        row.onkeydown = function (e) { if (e.key === 'Enter') openLead(row.getAttribute('data-lead')); };
      });
      updateFilterCue();
    });
  }
  function fetchLeads(params) {
    var q = new URLSearchParams();
    Object.keys(params).forEach(function (k) { if (params[k] !== '' && params[k] != null) q.set(k, params[k]); });
    return fetch('/admin/api/leads?' + q, { credentials: 'same-origin' }).then(function (r) { if (r.status === 401) location.href = '/admin/login'; return r.json(); });
  }

  var EVENT_LABELS = {
    page_view: 'Viewed page', vsl_play: 'Played VSL', vsl_unmute: 'Turned sound on', vsl_25: 'Watched 25%', vsl_50: 'Watched 50%', vsl_75: 'Watched 75%', vsl_95: 'Watched 95%', vsl_complete: 'Finished the video',
    vsl_cta_reveal: 'Reached the pitch', vsl_cta_click: 'Clicked CTA from video', cta_click: 'Clicked CTA', lead_captured: 'Gave contact details', app_step_saved: 'Answered a question', app_submitted: 'Submitted application',
    lead_qualified: 'Scored', lead_routed: 'Routed', booking_view: 'Saw the calendar', booking_scheduled: 'Booked a call', booking_scheduled_client: 'Booked (browser)', booking_cancelled: 'Cancelled call', whatsapp_click: 'Clicked WhatsApp',
    whatsapp_connected: 'Messaged on WhatsApp', voice_web_start: 'Started AI call (browser)', voice_call_started: 'AI call connected', voice_call_completed: 'AI call ended', voice_link_sent: 'AI sent booking link', voice_opt_out: 'Asked not to be contacted', whatsapp_sent: 'Sent WhatsApp template', email_sent: 'Email sent', email_open: 'Opened email', email_click: 'Clicked email link', unsubscribe: 'Unsubscribed',
    scroll_depth: 'Scrolled', engaged_time: 'Engaged', faq_open: 'Opened FAQ', app_view_step: 'Viewed question', lead_status_changed: 'Status changed', exit_intent: 'Exit intent', rage_click: 'Rage click', form_error: 'Form error',
  };
  EVENT_LABELS.data_claim = 'Claimed a data valuation'; EVENT_LABELS.data_cta_click = 'Clicked “Claim”'; EVENT_LABELS.data_form_start = 'Started the claim form';
  EVENT_LABELS.data_video_play = 'Played the video'; EVENT_LABELS.click = 'Clicked'; EVENT_LABELS.section_dwell = 'Read sections'; EVENT_LABELS.cta_hover = 'Hovered a button';
  EVENT_LABELS.page_exit = 'Left the page'; EVENT_LABELS.section_revisit = 'Scrolled back to a section'; EVENT_LABELS.tab_return = 'Came back to the tab'; EVENT_LABELS.copy_text = 'Copied text'; EVENT_LABELS.text_copy = 'Copied text'; EVENT_LABELS.first_interaction = 'First interaction';
  var QUIET = { app_view_step: 1, scroll_depth: 1, engaged_time: 1, click: 1, field_interaction: 1, first_interaction: 1, section_dwell: 1, cta_hover: 1, vsl_volume: 1, page_exit: 1, tab_return: 1 };

  /** Every visit and action, oldest first in the data, newest at the top. Shared by the lead and visitor drawers. */
  function journeyHtml(events, sessions, showAll) {
    var byId = {}, seen = {}, out = [];
    (sessions || []).forEach(function (s) { byId[s.id] = s; });
    events.slice().reverse().forEach(function (e) {
      if (e.session_id && !seen[e.session_id] && byId[e.session_id]) {
        seen[e.session_id] = 1;
        var s = byId[e.session_id];
        out.push('<li class="session"><span class="when">' + esc(when(s.started_at)) + '</span><span class="what"><b>New visit</b> · ' + esc(s.channel || 'Direct') + (s.utm_campaign ? ' / ' + esc(s.utm_campaign) : '') + (s.utm_content ? ' / ' + esc(s.utm_content) : '') +
          '<div class="props">' + esc([s.device, s.browser, s.os, [s.city, s.region, s.country].filter(Boolean).join(', '), s.referrer_host].filter(Boolean).join(' · ')) + '</div></span></li>');
      }
      if (!showAll && QUIET[e.name]) return;
      var props = {};
      try { props = JSON.parse(e.props || '{}'); } catch (x) { /* ignore */ }
      var detail = Object.keys(props).filter(function (k) { return ['view', 'email_id', 'event_uri'].indexOf(k) === -1 && props[k] !== null && props[k] !== ''; }).map(function (k) { return k + ': ' + (typeof props[k] === 'object' ? JSON.stringify(props[k]) : props[k]); }).join(' · ');
      out.push('<li><span class="when">' + esc(when(e.ts)) + '</span><span class="what"><b>' + esc(EVENT_LABELS[e.name] || e.name) + '</b>' + (e.path ? ' <span class="muted">' + esc(e.path) + '</span>' : '') + (detail ? '<div class="props">' + esc(detail) + '</div>' : '') + '</span></li>');
    });
    return out.reverse().join('');
  }

  /** One visitor (lead or not): who they are if they claimed, what they did, every action. */
  function openVisitor(id) {
    closeDrawers();
    var bg = document.createElement('div'); bg.className = 'drawer-bg';
    var dr = document.createElement('aside'); dr.className = 'drawer'; dr.setAttribute('role', 'dialog'); dr.setAttribute('aria-label', 'Visitor journey'); dr.setAttribute('data-visitor-drawer', id);
    dr.innerHTML = '<div class="loading-note">Loading…</div>';
    document.body.appendChild(bg); document.body.appendChild(dr);
    function teardown() { document.removeEventListener('keydown', onKey); }
    function close() { bg.remove(); dr.remove(); teardown(); if (location.hash !== '#' + state.tab) setHash('replaceState', '#' + state.tab); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    dr.__teardown = teardown;
    bg.onclick = close; document.addEventListener('keydown', onKey);
    fetch('/admin/api/visitors/' + encodeURIComponent(id), { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) { dr.innerHTML = '<div class="drawer-head"><div class="row" style="flex:1;min-width:0"><h2 class="lead-name">Visitor</h2></div><button class="close" type="button" aria-label="Close">Close ✕</button></div><div class="empty">Visitor not found.</div>'; dr.querySelector('.close').onclick = close; return; }
      var c = d.claims[0], v = d.visitor, ev = d.events, showAll = true;
      var P = function (e) { try { return JSON.parse(e.props || '{}'); } catch (x) { return {}; } };
      var count = function (name) { return ev.filter(function (e) { return e.name === name; }).length; };
      var scroll = ev.filter(function (e) { return e.name === 'scroll_depth'; }).reduce(function (m, e) { return Math.max(m, Number(P(e).pct) || 0); }, 0);
      var engaged = ev.filter(function (e) { return e.name === 'engaged_time'; }).reduce(function (t, e) { return t + (Number(P(e).ms) || 0); }, 0);
      var dwell = {};
      ev.filter(function (e) { return e.name === 'section_dwell'; }).forEach(function (e) { var p = P(e); Object.keys(p).forEach(function (k) { if (typeof p[k] === 'number') dwell[k] = (dwell[k] || 0) + p[k]; }); });
      var dwellRows = Object.keys(dwell).sort(function (a, b) { return dwell[b] - dwell[a]; }).slice(0, 8);
      var clicks = ev.filter(function (e) { return e.name === 'click' || e.name === 'cta_click' || e.name === 'data_cta_click'; }).map(function (e) { var p = P(e); return String(p.text || p.label || p.id || p.el || e.name).replace(/\s*Takes 60 seconds.*$/, '').slice(0, 60); }).filter(function (t, i, all) { return all.indexOf(t) === i; }).slice(0, 10);
      var headline = (ev.filter(function (e) { return e.name === 'page_view' && P(e).headline; })[0] || null);
      var s0 = d.sessions[d.sessions.length - 1] || {};
      var title = c ? (c.first_name + (c.company ? ' · ' + c.company : '')) : d.lead ? d.lead.name : 'Anonymous visitor';
      dr.innerHTML = '<div class="drawer-head"><div class="row" style="flex:1;min-width:0"><h2 class="lead-name">' + esc(title) + '</h2>' + (c ? '<span class="pill">claimed ' + esc(when(c.created_at)) + '</span>' : '<span class="pill">not signed up</span>') + (c && c.business_status && c.business_status !== 'Trading' ? '<span class="pill">' + esc(c.business_status) + '</span>' : '') + '</div><button class="close" type="button" aria-label="Close">Close ✕</button></div>' +
        '<p class="muted" style="margin:4px 0 14px">' + esc(c ? [c.email, c.phone, c.website].filter(Boolean).join(' · ') : 'Visitor ' + v.id) + ' · first seen ' + esc(when(v.created_at)) + '</p>' +
        (c ? '<div class="row" style="margin-bottom:14px"><a class="btn-sm ghost" href="mailto:' + esc(c.email) + '">Email</a>' + (c.phone ? '<a class="btn-sm ghost" href="tel:' + esc(c.phone) + '">Call</a>' : '') + '</div>' : '') +
        (d.lead ? '<div class="card notice" style="margin-bottom:14px">Also in the M&amp;A funnel: <strong>' + esc(d.lead.name) + '</strong> (' + esc(d.lead.status) + ', matched by ' + esc(d.lead.how) + '). <button class="btn-sm" data-openlead="' + esc(d.lead.id) + '">Open lead</button></div>' : '') +
        '<div class="grid g-4 tiles">' +
        tile('Visits', n(d.sessions.length), [s0.channel, s0.utm_campaign].filter(Boolean).join(' / ') || 'Direct') +
        tile('Time on page', secs(Math.round(engaged / 1000)), 'actively engaged') +
        tile('Scrolled', scroll ? scroll + '%' : '–', 'deepest point') +
        tile('Clicks', n(count('click') + count('data_cta_click')), n(count('data_cta_click')) + ' on “Claim” · ' + n(count('faq_open')) + ' FAQs opened') +
        '</div>' +
        '<div class="grid g-2" style="margin-top:14px"><div class="card"><h2>Profile</h2><dl class="kv" style="margin-top:10px">' +
        kv('Headline seen', headline ? P(headline).headline : '–') + kv('Source', [s0.channel, s0.utm_source, s0.utm_campaign, s0.utm_content].filter(Boolean).join(' / ')) +
        kv('Device', [s0.device, s0.browser, s0.os].filter(Boolean).join(' · ')) + kv('Location', [s0.city, s0.region, s0.country].filter(Boolean).join(', ')) +
        kv('Video', count('data_video_play') || count('vsl_play') ? 'played' : 'not played') + kv('Claim form', c ? 'submitted' : count('data_form_start') ? 'started, didn’t submit' : 'not opened') +
        (c ? kv('Revenue', c.revenue || '–') + kv('Business', c.business_status || '–') : '') + '</dl></div>' +
        '<div class="card"><h2>What they read and clicked</h2>' +
        (dwellRows.length ? '<dl class="kv" style="margin-top:10px">' + dwellRows.map(function (k) { return kv(k.replace(/^data_/, '').replace(/_/g, ' '), secs(Math.round(dwell[k]))); }).join('') + '</dl>' : '<p class="muted">No reading data yet.</p>') +
        (clicks.length ? '<p class="sub" style="margin-top:10px">Clicked: ' + esc(clicks.join(' · ')) + '</p>' : '') + '</div></div>' +
        '<div class="card" style="margin-top:14px"><div class="card-head"><div><h2>Journey</h2><p class="sub">Every visit and action: scrolls, clicks, reading time, video, form. Nothing they type is recorded.</p></div><label class="muted"><input type="checkbox" data-all checked> show all events</label></div><ul class="timeline" data-tl>' + journeyHtml(ev, d.sessions, showAll) + '</ul></div>';
      dr.querySelector('.close').onclick = close;
      dr.querySelector('[data-all]').onchange = function (e) { dr.querySelector('[data-tl]').innerHTML = journeyHtml(ev, d.sessions, e.target.checked); };
      var ol = dr.querySelector('[data-openlead]');
      if (ol) ol.onclick = function () { close(); openLead(ol.getAttribute('data-openlead')); };
    });
  }

  function openLead(id, o) {
    closeDrawers();
    var pushed = false;
    if (!(o && o.fromRoute) && location.hash !== '#lead=' + id) { setHash('pushState', '#lead=' + id); pushed = true; }
    var bg = document.createElement('div'); bg.className = 'drawer-bg';
    var dr = document.createElement('aside'); dr.className = 'drawer'; dr.setAttribute('role', 'dialog'); dr.setAttribute('aria-label', 'Lead details'); dr.setAttribute('data-lead', id);
    dr.innerHTML = '<div class="loading-note">Loading…</div>';
    document.body.appendChild(bg); document.body.appendChild(dr);
    function teardown() { document.removeEventListener('keydown', onKey); }
    function close() {
      bg.remove(); dr.remove(); teardown();
      // Opened by a click: step back off the lead entry so Back doesn't reopen it. Opened from the URL: just tidy the URL.
      if (pushed && location.hash === '#lead=' + id) history.back();
      else if (location.hash !== '#' + state.tab) setHash('replaceState', '#' + state.tab);
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    dr.__teardown = teardown;
    bg.onclick = close; document.addEventListener('keydown', onKey);

    fetch('/admin/api/leads/' + encodeURIComponent(id), { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) { dr.innerHTML = '<div class="drawer-head"><div class="row" style="flex:1;min-width:0"><h2 class="lead-name">Lead</h2></div><button class="close" type="button" aria-label="Close">Close ✕</button></div><div class="empty">Lead not found.</div>'; dr.querySelector('.close').onclick = close; return; }
      var l = d.lead, sc = d.scoring || {};
      var tier = l.tier_override || l.tier;
      var showAll = false;
      var sessionsById = {};
      d.sessions.forEach(function (s) { sessionsById[s.id] = s; });

      function timeline() { return journeyHtml(d.events, d.sessions, showAll); }
      // Section chips under the name: only for sections this lead has.
      var jumps = [['ld-pipeline', 'Pipeline'], ['ld-deal', 'Deal'], ['ld-app', 'Application'], ['ld-video', 'Video'], ['ld-emails', 'Emails']]
        .concat(d.calendly && d.calendly.length ? [['ld-calendly', 'Bookings']] : [])
        .concat(d.voice && d.voice.length ? [['ld-calls', 'AI calls']] : [])
        .concat([['ld-journey', 'Journey']]);

      dr.innerHTML =
        '<div class="drawer-head"><div class="row" style="flex:1;min-width:0"><h2 class="lead-name">' + esc([l.first_name, l.last_name].filter(Boolean).join(' ') || l.email) + '</h2>' + (tier ? '<span class="tier ' + esc(tier) + '">' + esc(tier) + '</span>' : '') + (l.status ? statusPill(l.status) : '') + '<span class="pill" title="Lead score out of 100 (A ≥ 70, B ≥ 40)">score ' + esc(l.score == null ? '–' : l.score + '/100') + '</span><span class="pill">ref ' + esc(l.ref_code) + '</span></div><button class="close" type="button" aria-label="Close">Close ✕</button>' +
        '<nav class="ld-jump" aria-label="Jump to section">' + jumps.map(function (j) { return '<button type="button" data-jump="' + j[0] + '">' + esc(j[1]) + '</button>'; }).join('') + '</nav></div>' +
        '<p class="muted" style="margin:4px 0 14px">' + esc(l.email || '') + (l.phone ? ' · ' + esc(l.phone) : '') + ' · created ' + esc(when(l.created_at)) + '</p>' +
        '<div class="row" style="margin-bottom:14px">' + (l.booking_join_url ? '<a class="btn-sm" target="_blank" rel="noopener" href="' + esc(l.booking_join_url) + '">Join call</a>' : '') + (l.email ? '<a class="btn-sm ghost" href="mailto:' + esc(l.email) + '">Email</a>' : '') + (l.phone ? '<a class="btn-sm ghost" href="tel:' + esc(l.phone) + '">Call</a><a class="btn-sm ghost" target="_blank" rel="noopener" href="https://wa.me/' + esc(String(l.phone).replace(/\D/g, '')) + '">WhatsApp them</a>' : '') + '</div>' +
        '<div class="grid g-2">' +
        '<div class="card" id="ld-pipeline"><h2>Pipeline</h2><div class="pipe-grid">' +
        '<label>Status <select class="input" data-f="status">' + ((state.meta && state.meta.statuses) || []).map(function (s) { return '<option' + (s === l.status ? ' selected' : '') + '>' + esc(s) + '</option>'; }).join('') + '</select></label>' +
        '<label>' + esc('Tier (auto: ' + (l.tier || 'none') + ')') + ' <select class="input" data-f="tier_override"><option value="">' + esc('Use auto tier (' + (l.tier || 'none') + ')') + '</option><option' + (l.tier_override === 'A' ? ' selected' : '') + '>A</option><option' + (l.tier_override === 'B' ? ' selected' : '') + '>B</option><option' + (l.tier_override === 'C' ? ' selected' : '') + '>C</option></select></label>' +
        '<label>Closer ' + repSelect('closer_id', l.closer_id, function (r) { return r.role !== 'setter'; }) + '</label>' +
        '<label>Setter ' + repSelect('setter_id', l.setter_id, function () { return true; }) + '</label>' +
        '<label>Deal value (AUD) <input class="input" type="number" min="0" step="100" data-f="revenue" value="' + esc(l.revenue || 0) + '"></label>' +
        '<label>Cash collected (AUD) <input class="input" type="number" min="0" step="100" data-f="cash_collected" value="' + esc(l.cash_collected || 0) + '"></label>' +
        '<label>Lost reason <select class="input" data-f="lost_reason"><option value="">—</option>' + ((state.meta && state.meta.lostReasons) || []).map(function (r) { return '<option' + (r === l.lost_reason ? ' selected' : '') + '>' + esc(r) + '</option>'; }).join('') + '</select></label>' +
        '<label class="full">Notes<textarea class="notes" data-f="notes">' + esc(l.notes || '') + '</textarea></label>' +
        '<button class="btn-sm" data-save type="button">Save</button></div></div>' +
        '<div class="card"><h2>Profile</h2><dl class="kv" style="margin-top:10px">' +
        kv('Closer', repName(l.closer_id)) + kv('Call', l.call_at ? when(l.call_at) : l.booked_at ? 'booked (time pending)' : '–') +
        (l.booking_source === 'calendly-direct' ? kv('Booked via', 'Calendly link directly (not the funnel)') : '') +
        (l.booking_host_email ? kv('Calendly host', l.booking_host_email) : '') +
        (l.booking_answers ? (function () { try { return JSON.parse(l.booking_answers).map(function (x) { return kv(x.q, x.a); }).join(''); } catch (e) { return ''; } })() : '') +
        kv('Location', [l.city, l.country].filter(Boolean).join(', ')) + kv('Device', l.device) +
        kv('WhatsApp', l.whatsapp_connected_at ? 'connected ' + when(l.whatsapp_connected_at) : l.whatsapp_clicked_at ? 'clicked ' + when(l.whatsapp_clicked_at) : (l.whatsapp_opt_in ? 'opted in' : '–')) +
        kv('Email', l.unsubscribed_at ? 'unsubscribed' : 'subscribed') + kv('Phone calls', l.do_not_call_at ? 'do not call (since ' + when(l.do_not_call_at) + ')' : l.call_consent_at ? 'consented to AI calls ' + when(l.call_consent_at) : 'no call consent') + kv('Visits', d.sessions.length) + '</dl>' +
        // Ad-tracking fields, folded away: useful for checking attribution, not for the call.
        '<details class="more-rows"><summary>Tracking details</summary><dl class="kv">' +
        kv('Route', l.route) + kv('Last touch', [l.channel, l.utm_source, l.utm_campaign, l.utm_content].filter(Boolean).join(' / ')) + kv('First touch', [l.ft_channel, l.ft_source, l.ft_campaign, l.ft_content].filter(Boolean).join(' / ')) +
        kv('Click id', l.click_type ? l.click_type + ' ' + String(l.click_id).slice(0, 18) + '…' : '') + kv('Headline version', l.variant) + kv('Ref code', l.ref_code) + '</dl></details></div></div>' +
        dealCard(l) +
        '<div class="grid g-2" style="margin-top:14px"><div class="card" id="ld-app"><h2>Application</h2><dl class="kv" style="margin-top:10px">' + d.answers.map(function (a) { return kv(a.question, a.answer); }).join('') + '</dl>' +
        (sc.breakdown ? '<p class="sub" style="margin-top:12px">Scoring: ' + esc(sc.breakdown.map(function (b) { return b.question + ' +' + b.points; }).join(', ')) + (sc.caps && sc.caps.length ? ' · capped: ' + esc(sc.caps.join(', ')) : '') + '</p>' : '') + '</div>' +
        '<div class="card" id="ld-video"><h2>Video</h2>' + (d.vsl.length ? d.vsl.map(function (v) {
          return '<div style="margin:10px 0"><div class="row"><strong>' + esc(v.video_id) + '</strong><span class="muted">' + esc(when(v.started_at)) + ' · ' + esc(v.duration ? pct(Math.min(1, v.max_position / v.duration)) : '–') + ' reached · ' + esc(secs(v.watched_seconds)) + ' watched' + (v.cta_clicked ? ' · clicked CTA' : '') + '</span></div><div class="mini-ret" aria-hidden="true">' + String(v.buckets).split('').map(function (b) { return '<i' + (b === '1' ? ' class="on"' : '') + '></i>'; }).join('') + '</div></div>';
        }).join('') : '<p class="muted">No video views recorded.</p>') +
        '<h2 id="ld-emails" style="margin-top:14px">Emails</h2>' + (d.emails.length ? table([{ label: 'Email', html: function (m) { return esc(m.template) + '<div class="muted">' + esc(m.sequence) + '</div>'; } }, { label: 'Status', key: 'status' }, { label: 'When', nw: true, html: function (m) { return esc(when(m.sent_at || m.send_at)); } }, { label: 'Opened', html: function (m) { return m.opened_at ? '✓' : ''; } }, { label: 'Clicked', html: function (m) { return m.clicked_at ? '✓' : ''; } }, { label: 'Personal', html: function (m) { return m.personalized && m.personalized !== 'off' ? '<span class="pill" title="' + esc(m.facts_used || '') + '">' + esc(m.personalized) + '</span>' : ''; } }], d.emails) : '<p class="muted">None.</p>') + '</div></div>' +
        '<div class="card" style="margin-top:14px" data-behaviour><div class="card-head"><div><h2>What they did → their emails</h2><p class="sub">Every email to this lead is rewritten around these, one or two at a time, never repeating.</p></div></div><p class="muted">Loading…</p></div>' +
        (d.calendly && d.calendly.length ? '<div class="card" id="ld-calendly" style="margin-top:14px"><h2>Calendly bookings · ' + d.calendly.length + '</h2>' + table([
          { label: 'Call', html: function (b) { return esc(when(b.start_at)); } },
          { label: 'Booked', html: function (b) { return esc(b.booked_at ? when(b.booked_at) : '–'); } },
          { label: 'Status', html: function (b) { return '<span class="pill">' + esc(b.rescheduled ? 'rescheduled' : b.status) + '</span>' + (b.cancel_reason ? ' <span class="muted">' + esc(b.cancel_reason) + '</span>' : ''); } },
          { label: 'Host', key: 'host_email' },
        ], d.calendly) + '</div>' : '') +
        (d.voice && d.voice.length ? '<div class="card" id="ld-calls" style="margin-top:14px"><h2>AI calls</h2>' + d.voice.map(voiceCall).join('') + '</div>' : '') +
        '<div class="card" id="ld-journey" style="margin-top:14px"><div class="card-head"><div><h2>Journey</h2><p class="sub">Every visit and action, server-side.</p></div><label class="muted"><input type="checkbox" data-all> show all events</label></div><ul class="timeline" data-tl>' + timeline() + '</ul></div>';

      dr.querySelector('.close').onclick = close;
      // The drawer is the scroller and its head is sticky: land each section just under the head.
      dr.querySelectorAll('[data-jump]').forEach(function (b) {
        b.onclick = function () {
          var t = dr.querySelector('#' + b.getAttribute('data-jump')), h = dr.querySelector('.drawer-head');
          if (!t) return;
          var top = t.getBoundingClientRect().top - dr.getBoundingClientRect().top + dr.scrollTop;
          dr.scrollTo({ top: Math.max(0, top - (h ? h.offsetHeight : 0) - 8), behavior: 'smooth' });
        };
      });
      loadBehaviour(dr, id);
      loadPayments(dr, id);
      dr.querySelector('[data-all]').onchange = function (e) { showAll = e.target.checked; dr.querySelector('[data-tl]').innerHTML = timeline(); };
      dr.querySelector('[data-save]').onclick = function () {
        var body = {};
        dr.querySelectorAll('[data-f]').forEach(function (f) { body[f.getAttribute('data-f')] = f.value; });
        send('PATCH', 'leads/' + encodeURIComponent(id), body).then(function (r) { toast(r.ok ? 'Saved' : (r.error || 'Could not save')); if (state.tab === 'leads' || state.tab === 'sales') load(); });
      };
    });
  }

  // ───────────── sales team ─────────────
  function reps() { return (state.meta && state.meta.closers) || []; }
  function repName(id) { if (!id) return 'Unassigned'; var r = reps().filter(function (x) { return x.id === id; })[0]; return r ? r.name : id; }
  function repSelect(field, current, keep) {
    var list = reps().filter(keep);
    if (current && !list.some(function (r) { return r.id === current; })) list.push({ id: current, name: current + ' (inactive)' });
    return '<select class="input" data-f="' + field + '"><option value="">— Unassigned</option>' + list.map(function (r) { return '<option value="' + esc(r.id) + '"' + (r.id === current ? ' selected' : '') + '>' + esc(r.name) + '</option>'; }).join('') + '</select>';
  }
  function personName(r) { return [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || r.id; }
  function refreshMeta() { return fetch('/admin/api/meta', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (m) { state.meta = m; }); }
  var STATUS_LABEL = { showed: 'Held', won: 'Won', lost: 'Lost', no_show: 'No-show' };

  function renderSales() {
    return api('sales').then(function (d) {
      var t = d.totals;
      setNavBadge('sales', d.needsOutcome ? d.needsOutcome.length : 0);
      var lead = function (r) { return '<a href="#lead=' + esc(r.id) + '" data-open="' + esc(r.id) + '">' + esc(personName(r)) + '</a>'; };
      var bar = function (v) { return v == null ? '<span class="muted">no target</span>' : '<div class="target"><i style="width:' + Math.min(100, v * 100).toFixed(1) + '%"></i></div><small>' + pct(v) + '</small>'; };
      view.innerHTML =
        (d.notify ? '' : '<div class="card notice"><b>Team pings are off.</b> Add a Slack or Discord webhook under <a href="#integrations" data-go="integrations">Integrations → Alerts</a> to get hot leads, bookings, call reminders and closed deals in your channel.</div>') +
        '<div class="grid g-4 tiles">' +
        tile('Calls in range', n(t.booked), 'scheduled in range · ' + n(t.upcoming) + ' upcoming') +
        // Show rate only counts calls with an outcome: say how many past calls aren't logged yet.
        tile('Show rate', pct(t.show_rate), n(t.held) + ' held · ' + n(t.no_shows) + ' no-shows' + (d.needsOutcome && d.needsOutcome.length ? ' · ' + n(d.needsOutcome.length) + ' not logged yet' : '')) +
        tile('Close rate', pct(t.close_rate), n(t.won) + ' won · ' + n(t.lost) + ' lost') +
        tile('Revenue', money(t.revenue), money(t.cash) + ' cash · avg ' + money(t.avg_deal)) + '</div>' +
        (d.needsOutcome.length ? '<div class="card" style="margin-top:14px"><h2>Needs an outcome · ' + n(d.needsOutcome.length) + '</h2><p class="sub">These calls have passed. Log what happened — it triggers the right follow-up emails, the Meta conversion and the team ping.</p>' +
          '<div class="todo todo-out">' + table([
            { label: 'Lead', html: lead },
            { label: 'Tier', nw: true, html: function (r) { return tierCell({ tier: r.tier, status: 'booked' }); } },
            { label: 'Call', nw: true, html: function (r) { return '<span class="muted">' + esc(r.call_at ? when(r.call_at) : 'booked ' + when(r.booked_at)) + '</span>'; } },
            { label: 'Closer', nw: true, html: function (r) { return esc(repName(r.closer_id)); } },
            { label: '', html: function (r) { return '<div class="row outcome" data-lead="' + esc(r.id) + '"><button class="btn-sm ghost" data-out="showed">Held</button><button class="btn-sm ghost" data-out="no_show">No-show</button><button class="btn-sm ghost" data-out="won">Won…</button><button class="btn-sm ghost" data-out="lost">Lost…</button></div>'; } },
          ], d.needsOutcome) + '</div></div>' : '') +
        '<div class="card" style="margin-top:14px" data-sec="upcoming"><h2>Upcoming calls · ' + n(d.upcoming.length) + '</h2><p class="sub">Next 14 days. Reps get pinged 15 minutes before each one.</p>' +
        '<div class="todo todo-up">' + table([
          { label: 'When', nw: true, html: function (r) { return esc(when(r.call_at)); } },
          { label: 'Lead', html: function (r) { return lead(r) + (r.tier ? ' <span class="tier ' + esc(r.tier) + '">' + esc(r.tier) + '</span>' : ''); } },
          { label: 'Closer', nw: true, html: function (r) { return esc(repName(r.closer_id)); } },
          { label: 'VSL', num: true, html: function (r) { return '<span class="todo-k">Watched </span>' + esc(r.vsl_pct ? pct(Math.min(1, r.vsl_pct)) : '–'); } },
          { label: 'Source', html: function (r) { return '<span class="muted">' + esc([r.channel || 'Direct', r.utm_content].filter(Boolean).join(' / ')) + '</span>'; } },
        ], d.upcoming, { empty: 'No calls booked in the next 14 days.' }) + '</div></div>' +
        '<div class="card" style="margin-top:14px"><h2>Leaderboard</h2><p class="sub">Calls scheduled and deals closed in this range. Commission is on cash collected. Target bar is month to date (' + esc(d.tz) + ').</p>' +
        table([
          { label: 'Rep', html: function (r) { return '<b>' + esc(r.name) + '</b>' + (r.id ? '' : ' <span class="muted">(no closer set)</span>'); } },
          { label: 'Booked', key: 'booked', num: true, fmt: n },
          { label: 'Held', key: 'held', num: true, fmt: n },
          { label: 'Show', key: 'show_rate', num: true, fmt: function (v) { return pct(v); } },
          { label: 'Won', key: 'won', num: true, fmt: n },
          { label: 'Close', key: 'close_rate', num: true, fmt: function (v) { return pct(v); } },
          { label: 'Revenue', key: 'revenue', num: true, fmt: money },
          { label: 'Cash', key: 'cash', num: true, fmt: money },
          { label: 'Commission', key: 'commission', num: true, fmt: money },
          { label: 'MTD vs target', html: function (r) { return '<div class="target-cell">' + bar(r.target_progress) + '</div>'; } },
        ], d.leaderboard) + '</div>' +
        '<div class="card" style="margin-top:14px"><div class="card-head wrap-head"><div><h2>Call log</h2><p class="sub">Every past call. Fill in what happened: logging old calls never emails anyone or sends conversions to ads, and the outcome is dated to the call.</p></div>' +
        '<div class="row"><select class="input" data-cl-tier><option value="">All tiers</option><option>A</option><option>B</option><option>C</option></select><label class="muted"><input type="checkbox" data-cl-unlogged checked> only unlogged</label></div></div><div data-calllog><p class="muted">Loading…</p></div></div>' +
        '<div class="card" style="margin-top:14px"><h2>Recent outcomes</h2>' +
        table([
          { label: 'When', nw: true, html: function (r) { return esc(when(r.closed_at || r.showed_at || r.updated_at)); } },
          { label: 'Lead', html: lead },
          { label: 'Outcome', html: function (r) { return '<span class="pill out-' + esc(r.status) + ' st-' + esc(String(r.status || '').replace(/[^a-z_]/gi, '')) + '">' + esc(STATUS_LABEL[r.status] || r.status) + '</span>' + (r.lost_reason ? ' <span class="muted">' + esc(r.lost_reason) + '</span>' : ''); } },
          { label: 'Value', num: true, nw: true, html: function (r) { return r.status === 'won' ? esc(money(r.revenue)) + '<div class="muted">' + esc(money(r.cash_collected)) + ' cash</div>' : ''; } },
          { label: 'Closer', nw: true, html: function (r) { return esc(repName(r.closer_id)); } },
          { label: 'Source', html: function (r) { var src = [r.channel || 'Direct', r.utm_campaign, r.utm_content].filter(Boolean).join(' / '); return '<div class="muted ell" style="max-width:260px" title="' + esc(src) + '">' + esc(src) + '</div>'; } },
        ], d.recent, { cards: true }) + '</div>' +
        // Lost reasons: a full chart when there are some, one quiet line when there are none.
        (d.lostReasons.length ? '<div class="card" style="margin-top:14px"><h2>Why deals are lost</h2><p class="sub">Lost reasons logged in this range.</p>' + barList(d.lostReasons.map(function (r) { return { name: r.reason, value: r.n }; })) + '</div>'
          : '<div class="card compact-line" style="margin-top:14px"><b>Why deals are lost</b><span class="muted">No losses logged in this range. Reasons appear here when you mark a call Lost.</span></div>') +
        (d.calendlyMonthly && d.calendlyMonthly.length ? '<div class="card" style="margin-top:14px"><h2>Calendly history</h2><p class="sub">Every booking on Josh’s Calendly by month (reschedules counted once), including ones from before the funnel.' + (t.older_unlogged ? ' ' + n(t.older_unlogged) + ' calls older than 30 days have no outcome logged; open them from Leads to fill them in.' : '') + '</p>' +
          table([
            { label: 'Month', key: 'month' },
            { label: 'Booked', key: 'booked', num: true, fmt: n },
            { label: 'Kept', key: 'kept', num: true, fmt: n },
            { label: 'Cancelled', key: 'canceled', num: true, fmt: n },
            { label: 'No-shows', key: 'no_shows', num: true, fmt: n },
            { label: 'Cancel rate', num: true, zeroOk: true, html: function (r) { return esc(pct(r.booked ? r.canceled / r.booked : 0)); } },
            { label: 'People', key: 'people', num: true, fmt: n },
          ], d.calendlyMonthly) + '</div>' : '');

      view.querySelectorAll('[data-open]').forEach(function (a) { a.onclick = function (ev) { ev.preventDefault(); openLead(a.getAttribute('data-open')); }; });
      view.querySelectorAll('[data-go]').forEach(function (a) { a.onclick = function (ev) { ev.preventDefault(); go(a.getAttribute('data-go')); }; });
      // The call log only lists calls with a known time; booked-without-a-time calls live in "Needs an outcome" above.
      var noTime = (d.needsOutcome || []).filter(function (r) { return !r.call_at; }).length;
      var noTimeMsg = function () {
        if (!view.querySelector('[data-cl-unlogged]').checked || !noTime) return 'Nothing to log here.';
        return 'No other past calls to log. The ' + n(noTime) + (noTime === 1 ? ' call without a scheduled time is' : ' calls without a scheduled time are') + ' in “Needs an outcome” above.';
      };
      var drawLog = function () {
        var box = view.querySelector('[data-calllog]');
        api('sales/calls', { tier: view.querySelector('[data-cl-tier]').value, unlogged: view.querySelector('[data-cl-unlogged]').checked ? 1 : '' }, { noRange: true }).then(function (r) {
          var m = state.meta || {};
          var sel = function (f, list, cur, blank) { return '<select class="input" data-cf="' + f + '">' + opts(list, cur, blank) + '</select>'; };
          box.innerHTML = r.calls.length ? '<div class="table-wrap"><table class="calllog"><thead><tr><th>Call</th><th>Lead</th><th>Tier</th><th>Revenue</th><th>Outcome</th><th>Temp</th><th>Objection</th><th class="num">Deal $</th><th class="num">Cash $</th><th></th></tr></thead><tbody>' +
            r.calls.map(function (c) {
              return '<tr data-id="' + esc(c.id) + '"><td>' + esc(when(c.call_at)) + '</td><td><a href="#lead=' + esc(c.id) + '" data-open="' + esc(c.id) + '">' + esc(personName(c)) + '</a><div class="muted">' + esc((c.industry || '').slice(0, 40)) + '</div></td>' +
                '<td>' + (c.tier ? '<span class="tier ' + esc(c.tier) + '">' + esc(c.tier) + '</span>' : '–') + '</td><td class="muted">' + esc(c.revenue_band || '–') + '</td>' +
                '<td>' + sel('status', ['booked', 'showed', 'no_show', 'won', 'lost', 'disqualified'], c.status) + '</td>' +
                '<td>' + sel('temperature', m.temperatures, c.temperature, '—') + '</td><td>' + sel('objection', m.objections, c.objection, '—') + '</td>' +
                '<td class="num"><input class="input" data-cf="revenue" type="number" step="500" value="' + esc(c.revenue || '') + '" style="width:100px"></td>' +
                '<td class="num"><input class="input" data-cf="cash_collected" type="number" step="500" value="' + esc(c.cash_collected || '') + '" style="width:100px"></td>' +
                '<td><button class="btn-sm" data-cl-save>Save</button></td></tr>';
            }).join('') + '</tbody></table></div><p class="muted" style="margin-top:6px">' + r.calls.length + ' calls</p>' : emptyState(noTimeMsg());
          box.querySelectorAll('[data-open]').forEach(function (a) { a.onclick = function (ev) { ev.preventDefault(); openLead(a.getAttribute('data-open')); }; });
          box.querySelectorAll('[data-cl-save]').forEach(function (b) {
            b.onclick = function () {
              var tr = b.closest('tr'), body = {};
              tr.querySelectorAll('[data-cf]').forEach(function (x) { body[x.getAttribute('data-cf')] = x.value; });
              if (body.status === 'lost' && !body.lost_reason) body.lost_reason = body.objection || 'Other';
              b.disabled = true;
              send('PATCH', 'leads/' + encodeURIComponent(tr.getAttribute('data-id')), body).then(function (res) { b.disabled = false; toast(res.ok ? 'Saved' : (res.error || 'Could not save')); if (res.ok) tr.classList.add('saved'); });
            };
          });
        });
      };
      view.querySelector('[data-cl-tier]').onchange = drawLog;
      view.querySelector('[data-cl-unlogged]').onchange = drawLog;
      drawLog();
      view.querySelectorAll('.outcome [data-out]').forEach(function (b) {
        b.onclick = function () {
          var id = b.closest('[data-lead]').getAttribute('data-lead'), status = b.getAttribute('data-out'), body = { status: status };
          if (status === 'won') {
            var v = prompt('Deal value (AUD)?'); if (v == null) return;
            var cash = prompt('Cash collected so far (AUD)?', v); if (cash == null) return;
            body.revenue = Number(String(v).replace(/[^\d.]/g, '')) || 0; body.cash_collected = Number(String(cash).replace(/[^\d.]/g, '')) || 0;
          } else if (status === 'lost') {
            var list = (state.meta.lostReasons || []);
            var pick = prompt('Why was it lost?\n' + list.map(function (r, i) { return (i + 1) + '. ' + r; }).join('\n') + '\n\nType a number:'); if (pick == null) return;
            body.lost_reason = list[(+pick || 0) - 1] || 'Other';
          }
          b.disabled = true;
          send('PATCH', 'leads/' + encodeURIComponent(id), body).then(function (r) { toast(r.ok ? 'Logged — team notified' : (r.error || 'Could not save')); load(); });
        };
      });
    });
  }



  function renderLanders() {
    return Promise.all([api('landers'), api('experiments')]).then(function (res) {
      var d = res[0], x = res[1];
      var origin = location.origin;
      var params = 'utm_source=facebook&utm_medium=paid&utm_campaign={{campaign.name}}&utm_term={{adset.name}}&utm_content={{ad.name}}&campaign_id={{campaign.id}}&adset_id={{adset.id}}&ad_id={{ad.id}}&placement={{placement}}&site_source_name={{site_source_name}}';
      var rate = function (v) { return pct(v, 1); };
      // "3 · 4.2%" on one line; a zero count reads as a quiet dash instead of "0 0.0%".
      var countRate = function (c, v) { return Number(c) ? esc(n(c)) + ' <span class="muted">' + esc(rate(v)) + '</span>' : '<span class="muted" title="None">–</span>'; };
      var sel = state.landerIndustry || '';
      var rows = d.rows.filter(function (r) { return !sel || r.industry === sel; });
      // No industry picked: landers with traffic first, the ones still waiting for visitors folded away.
      var active = rows, idle = [];
      if (!sel) {
        active = rows.filter(function (r) { return r.visitors > 0 || r.leads > 0; }).sort(function (a, b) { return (b.visitors - a.visitors) || (b.share - a.share); });
        idle = rows.filter(function (r) { return !(r.visitors > 0 || r.leads > 0); });
        if (!active.length) { active = rows.slice(0, 10); idle = rows.slice(10); }
      }
      var landerCols = [
        { label: 'Lander', html: function (r) { return '<b>' + esc(r.industry_label) + '</b> · ' + esc(r.angle_label) + '<div class="muted lander-h" title="' + esc(r.headline) + '">' + esc(r.headline) + '</div>'; } },
        { label: 'Traffic now', num: true, html: function (r) { return '<div class="target-cell"><div class="target"><i style="width:' + (r.share * 100).toFixed(1) + '%"></i></div><small>' + pct(r.share) + '</small></div>'; } },
        { label: 'Visitors', key: 'visitors', num: true, fmt: n }, { label: 'Played', key: 'plays', num: true, fmt: n },
        { label: 'Applied', num: true, html: function (r) { return n(r.leads) + ' <span class="muted">' + rate(r.lead_rate) + '</span>'; } },
        { label: 'Qualified', num: true, html: function (r) { return n(r.qualified) + (r.tier_a ? ' <span class="muted">(' + r.tier_a + ' A)</span>' : ''); } },
        { label: 'Booked', key: 'booked', num: true, fmt: n }, { label: 'Won', key: 'won', num: true, fmt: n }, { label: 'Cash', key: 'cash', num: true, fmt: money },
        { label: '', html: function (r) { return '<a class="btn-sm ghost" target="_blank" rel="noopener" href="/for/' + esc(r.industry) + '/' + esc(r.angle) + '?preview=1">Preview</a>'; } },
      ];
      var activeCount = sel ? rows.filter(function (r) { return r.visitors > 0 || r.leads > 0; }).length : active.filter(function (r) { return r.visitors > 0 || r.leads > 0; }).length;
      var idleCount = rows.length - activeCount;
      // All pages side by side: the main page's headline variants and each industry's landers.
      var pageRows = x.variants.map(function (v) { return { page: 'Main page · headline ' + v.id.toUpperCase(), visitors: v.visitors, lead_rate: v.lead_rate, qualified_rate: v.qualified_rate, booked_rate: v.booked_rate, note: v.lift == null ? 'control' : (v.significant ? 'significant ' : '') + (v.lift > 0 ? '+' : '') + pct(v.lift, 1) + ' vs A' }; })
        .concat(d.byIndustry.filter(function (r) { return r.visitors; }).map(function (r) { return { page: r.label + ' landers', visitors: r.visitors, lead_rate: r.lead_rate, qualified_rate: r.qualified_rate, booked_rate: r.visitors ? r.booked / r.visitors : 0, note: r.best ? 'leading: ' + r.best : 'still exploring' }; }));
      view.innerHTML =
        '<div class="card"><h2>All pages compared</h2><p class="sub">Same funnel behind every page: VSL → application → booking. Compare rates, not raw counts.</p>' + table([
          { label: 'Page', key: 'page' }, { label: 'Visitors', key: 'visitors', num: true, fmt: n },
          { label: 'Applied', key: 'lead_rate', num: true, fmt: function (v) { return pct(v, 1); } },
          { label: 'Qualified', key: 'qualified_rate', num: true, fmt: function (v) { return pct(v, 1); } },
          { label: 'Booked', key: 'booked_rate', num: true, fmt: function (v) { return pct(v, 1); } },
          { label: '', html: function (r) { return '<span class="muted">' + esc(r.note) + '</span>'; } },
        ], pageRows, { cards: true }) + '</div>' +
        '<div class="card" style="margin-top:14px"><h2>Main page headline test</h2><p class="sub">Visitors to the main page (/) are split between these headlines. Judged on applications per visitor; significance from a two-proportion z-test vs. A (p &lt; 0.05). Preview with <span class="mono">/?v=b</span>.</p>' +
        table([
          { label: 'Variant', html: function (r) { return '<strong>' + esc(r.id.toUpperCase()) + '</strong> <span class="muted">' + esc(r.weight) + '%</span><div class="muted lander-h" title="' + esc(r.headline) + '">' + esc(r.headline) + '</div>'; } },
          { label: 'Visitors', key: 'visitors', num: true, fmt: n },
          { label: 'Play', key: 'play_rate', num: true, fmt: function (v) { return pct(v); } },
          { label: 'Pitch', key: 'pitch_rate', num: true, fmt: function (v) { return pct(v); } },
          { label: 'Applied', key: 'lead_rate', num: true, fmt: function (v) { return pct(v, 1); } },
          { label: 'Qualified', key: 'qualified_rate', num: true, fmt: function (v) { return pct(v, 1); } },
          { label: 'Booked', key: 'booked_rate', num: true, fmt: function (v) { return pct(v, 1); } },
          { label: 'Result', html: function (r) { return r.p_value == null ? '<span class="muted">control</span>' : r.significant ? '<span class="pill ok">✓ significant (p=' + r.p_value.toFixed(3) + ')</span>' : '<span class="pill">not yet (p=' + r.p_value.toFixed(2) + ')</span>'; } },
        ], x.variants, { cards: true }) + '</div>' +
        '<h3 class="section-h">Industry landers</h3>' +
        '<div class="card"><h2>Meta ad links</h2><p class="sub">Pick the industry the ad set targets. Paste the website URL into the ad and the parameters into Meta’s “URL parameters” box. Or use the auto link everywhere: it reads the industry from your campaign, ad set or ad name (name them like “Dental – Lookalike”).</p>' +
        '<div class="row" style="margin:10px 0"><select class="input" data-ml-ind><option value="">Auto-detect from ad names</option>' + d.industries.map(function (i) { return '<option value="' + esc(i.id) + '">' + esc(i.label) + '</option>'; }).join('') + '</select></div>' +
        '<dl class="kv"><dt>Website URL</dt><dd><span class="mono" data-ml-url></span> <button class="btn-sm ghost" data-copy="url">Copy</button></dd><dt>URL parameters</dt><dd><span class="mono" style="word-break:break-all">' + esc(params) + '</span> <button class="btn-sm ghost" data-copy="params">Copy</button></dd></dl>' +
        '<p class="muted" style="margin-top:8px" data-ml-kw></p></div>' +
        '<div class="card" style="margin-top:14px"><h2>By industry</h2><p class="sub">Industries with visitors or applications in this range.</p>' + table([
          { label: 'Industry', key: 'label' }, { label: 'Visitors', key: 'visitors', num: true, fmt: n }, { label: 'Applied', num: true, nw: true, html: function (r) { return countRate(r.leads, r.lead_rate); } },
          { label: 'Qualified', num: true, nw: true, html: function (r) { return countRate(r.qualified, r.qualified_rate); } }, { label: 'Booked', key: 'booked', num: true, fmt: n }, { label: 'Won', key: 'won', num: true, fmt: n }, { label: 'Cash', key: 'cash', num: true, fmt: money },
          { label: 'Leading headline', html: function (r) { return esc(r.best || '–'); } },
        ], d.byIndustry.filter(function (r) { return r.visitors || r.leads; }), { cards: true }) + '</div>' +
        '<div class="card" style="margin-top:14px"><h2>By headline angle</h2><p class="sub">Across all industries.</p>' + table([
          { label: 'Angle', key: 'label', nw: true }, { label: 'Visitors', key: 'visitors', num: true, fmt: n }, { label: 'Applied', num: true, nw: true, html: function (r) { return countRate(r.leads, r.lead_rate); } },
          { label: 'Qualified', num: true, nw: true, html: function (r) { return countRate(r.qualified, r.qualified_rate); } }, { label: 'Booked', key: 'booked', num: true, fmt: n }, { label: 'Cash', key: 'cash', num: true, fmt: money },
          { label: 'Works best in', html: function (r) { return esc(r.best || '–'); } },
        ], d.byAngle, { cards: true }) + '</div>' +
        '<div class="card" style="margin-top:14px"><div class="card-head"><div><h2>All landers</h2><p class="sub">“Traffic now” is the share of new visitors each headline would get today. Every headline gets its first 60 visitors before the split starts to move.' + esc(' · ' + n(activeCount) + ' with traffic, ' + n(idleCount) + ' waiting') + '</p></div>' +
        '<select class="input" data-ld-ind><option value="">All industries</option>' + d.industries.map(function (i) { return '<option value="' + esc(i.id) + '"' + (sel === i.id ? ' selected' : '') + '>' + esc(i.label) + '</option>'; }).join('') + '</select></div>' +
        table(landerCols, active, { cards: true }) +
        (idle.length ? '<details class="more-rows"><summary>' + esc('Show the other ' + idle.length + ' landers with no visitors yet') + '</summary>' + table(landerCols, idle, { cards: true }) + '</details>' : '') + '</div>';
      var indSel = view.querySelector('[data-ml-ind]');
      var draw = function () {
        var id = indSel.value, ind = d.industries.filter(function (i) { return i.id === id; })[0];
        view.querySelector('[data-ml-url]').textContent = id ? origin + '/for/' + id : origin + '/m';
        view.querySelector('[data-ml-kw]').textContent = id ? 'Visitors get one of 5 ' + ind.label + ' headlines; the best one gets more traffic over time.' : 'Detects: ' + d.industries.map(function (i) { return i.label + ' (' + i.keywords.slice(0, 3).join(', ') + ')'; }).join(' · ') + '. No match → the main page.';
      };
      indSel.onchange = draw; draw();
      view.querySelectorAll('[data-copy]').forEach(function (b) { b.onclick = function () { var t = b.getAttribute('data-copy') === 'url' ? view.querySelector('[data-ml-url]').textContent : params; navigator.clipboard.writeText(t).then(function () { toast('Copied'); }); }; });
      view.querySelector('[data-ld-ind]').onchange = function (e) { state.landerIndustry = e.target.value; load(); };
    });
  }


  function renderBehaviour() {
    var path = state.bhPath || '';
    return api('behaviour', { path: path }).then(function (d) {
      var card = function (title, sub, body) { return '<div class="card"><h2>' + esc(title) + '</h2>' + (sub ? '<p class="sub">' + esc(sub) + '</p>' : '') + body + '</div>'; };
      var none = emptyState('No data in this range yet.');
      var tb = d.tabs || {};
      var firstTouch = (d.firsts || []).reduce(function (a, r) { return a + r.n; }, 0);
      // Click density down the page (where on the page people click), per page.
      var zoneBars = {};
      (d.zones || []).forEach(function (z) { (zoneBars[z.path] = zoneBars[z.path] || []).push(z); });
      var zonesHtml = Object.keys(zoneBars).slice(0, 4).map(function (pth) {
        var list = zoneBars[pth], max = Math.max.apply(null, list.map(function (z) { return z.n; }));
        return '<div class="zone-col"><div class="mono">' + esc(pth) + '</div><div class="zone-strip">' + [0, 10, 20, 30, 40, 50, 60, 70, 80, 90].map(function (b) {
          var z = list.filter(function (x) { return x.band === b; })[0], v = z ? Number(z.n) || 0 : 0, h = v / (max || 1);
          return '<div class="zone' + (h > 0.55 ? ' hot' : '') + '" title="' + b + '–' + (b + 10) + '% down the page: ' + v + ' clicks" style="--h:' + h.toFixed(2) + '"><span>' + b + '%</span><b>' + (v || '') + '</b></div>';
        }).join('') + '</div><div class="zone-legend muted">top of page ↓ bottom</div></div>';
      }).join('');
      view.innerHTML =
        '<div class="row" style="margin-bottom:12px"><select class="input" data-bh-path><option value="">All pages</option>' + (d.pages || []).map(function (p) { return '<option value="' + esc(p.path) + '"' + (p.path === path ? ' selected' : '') + '>' + esc(p.path) + ' (' + n(p.visitors) + ')</option>'; }).join('') + '</select></div>' +
        '<div class="grid g-4 tiles">' +
        tile('Tab switches', n(tb.returns || 0), n(tb.sessions || 0) + ' visits left and came back · avg ' + (tb.avg_away ? secs(tb.avg_away) : '–') + ' away') +
        tile('Dead clicks', n((d.dead || []).reduce(function (a, r) { return a + r.n; }, 0)), 'Clicks on things that do nothing') +
        tile('CTA hesitations', n((d.hovers || []).reduce(function (a, r) { return a + r.people; }, 0)), 'Hovered a button, didn’t click') +
        tile('First interaction', (d.firsts || []).length ? secs((d.firsts.reduce(function (a, r) { return a + r.avg_ms * r.n; }, 0) / (firstTouch || 1)) / 1000) : '–', 'Average time before they scroll, tap or type') + '</div>' +
        '<div class="grid g-2" style="margin-top:14px">' +
        card('What people click', 'Ranked by people, not clicks.', (d.clicks || []).length ? table([
          { label: 'Element', html: function (r) { return esc(r.text || r.el) + '<div class="muted mono">' + esc(r.path + ' · ' + (r.section || '–')) + '</div>'; } },
          { label: 'People', key: 'people', num: true, fmt: n }, { label: 'Clicks', key: 'n', num: true, fmt: n },
        ], d.clicks.slice(0, 15)) : none) +
        card('Where on the page they click', 'Each band is a tenth of the page, top to bottom; deeper blue means more clicks.', zonesHtml ? '<div class="zones">' + zonesHtml + '</div>' : none) + '</div>' +
        card('Form friction', 'Per field: how long people spend, how often they correct themselves, paste, or leave it empty. Values are never recorded.', (d.fields || []).length ? table([
          { label: 'Field', key: 'field' }, { label: 'People', key: 'people', num: true, fmt: n },
          { label: 'Avg time', num: true, html: function (r) { return esc(r.avg_s + 's'); } },
          { label: 'Corrections', key: 'corrections', num: true },
          { label: 'Pasted', num: true, html: function (r) { return esc(pct(r.paste_rate)); } },
          { label: 'Left empty', num: true, html: function (r) { return '<span' + (r.empty_rate > 0.3 ? ' class="bad"' : '') + '>' + esc(pct(r.empty_rate)) + '</span>'; } },
        ], d.fields) : none) +
        '<div class="grid g-2" style="margin-top:14px">' +
        card('Where they leave', 'The section on screen when they closed the page.', (d.exits || []).length ? table([
          { label: 'Page · section', html: function (r) { return esc(r.path) + ' · <b>' + esc(r.section) + '</b>'; } }, { label: 'Exits', key: 'n', num: true, fmt: n },
          { label: 'Scrolled', num: true, html: function (r) { return esc(r.scroll + '%'); } }, { label: 'Time', num: true, html: function (r) { return esc(secs(r.seconds)); } },
          { label: 'Never interacted', num: true, html: function (r) { return esc(pct(1 - r.interacted)); } },
        ], d.exits.slice(0, 12)) : none) +
        card('Dead & rage clicks', 'Things people expect to be clickable. Make them links, or make them look less like links.', (d.dead || []).length ? table([
          { label: 'Element', html: function (r) { return esc(r.el) + '<div class="muted mono">' + esc(r.path + ' · ' + (r.section || '–')) + '</div>'; } }, { label: 'People', key: 'people', num: true, fmt: n }, { label: 'Clicks', key: 'n', num: true, fmt: n },
        ], d.dead) : none) + '</div>' +
        '<div class="grid g-3" style="margin-top:14px">' +
        card('Sections re-read', 'Scrolled away, then came back.', (d.revisits || []).length ? barList(d.revisits.map(function (r) { return { name: r.section + (state.bhPath ? '' : ' · ' + r.path), value: r.people }; })) : none) +
        card('Button hesitation', 'Hovered without clicking (avg time hovering).', (d.hovers || []).length ? table([{ label: 'Button', html: function (r) { return esc(r.id) + '<div class="muted mono">' + esc(r.path) + '</div>'; } }, { label: 'People', key: 'people', num: true, fmt: n }, { label: 'Avg', num: true, html: function (r) { return esc(r.avg_s + 's'); } }], d.hovers) : none) +
        card('What they highlight & copy', 'Text people selected or copied: what they’re weighing up.', ((d.selects || []).length || (d.copies || []).length) ? '<ul class="quotes">' + (d.copies || []).map(function (r) { return '<li><b>copied</b> “' + esc(r.text) + '” <span class="muted">×' + r.people + '</span></li>'; }).join('') + (d.selects || []).map(function (r) { return '<li>“' + esc(r.text) + '” <span class="muted">×' + r.people + '</span></li>'; }).join('') + '</ul>' : none) + '</div>';
      view.querySelector('[data-bh-path]').onchange = function (e) { state.bhPath = e.target.value; load(); };
    });
  }

  function renderInsights() {
    return api('insights', null, { noRange: true }).then(function (d) {
      var T = d.byTier, a = d.a;
      var tierRow = function (k, label) { var t = T[k]; return Object.assign({ tier: label }, t); };
      var bars = function (title, list, sub) { return '<div class="card"><h2>' + esc(title) + '</h2>' + (sub ? '<p class="sub">' + esc(sub) + '</p>' : '') + (list && list.length ? barList(list.slice(0, 10).map(function (x) { return { name: x.k, value: x.n, note: pct(x.n / (a.people || 1)) }; })) : emptyState('No data.')) + '</div>'; };
      var orNull = function (v) { return v == null ? '–' : pct(v); };
      // A-tier cards: only the ones with answers; the empty ones are named in one quiet line (each card comes back by itself once it has data).
      var cards = [['Revenue', a.revenue_bands], ['Sector', a.sectors, 'Grouped from what they typed'], ['Budget for advisory', a.budgets], ['What they want help with', a.help], ['What applies to them', a.statements], ['Who they are', a.describes], ['Call day', a.call_weekday, 'In the sales team’s time zone'], ['Call time', a.call_hour], ['Status now', (a.statuses || []).map(function (x) { return Object.assign({}, x, { k: String(x.k == null ? '' : x.k).charAt(0).toUpperCase() + String(x.k == null ? '' : x.k).slice(1) }); })], ['Booked by month', a.booked_month]];
      var empty = [], full = [];
      cards.forEach(function (c) { if (c[1] && c[1].length) full.push(bars(c[0], c[1], c[2])); else empty.push(c[0]); });
      if (a.notes && a.notes.length) full.push('<div class="card"><h2>In their own words</h2><p class="sub">What A-tier bookers wrote in the booking form.</p><ul class="quotes">' + a.notes.map(function (q) { return '<li>“' + esc(q) + '”</li>'; }).join('') + '</ul></div>');
      else empty.push('In their own words');
      var hasInd = a.industries && a.industries.length;
      if (!hasInd) empty.push('Industries (as typed)');
      // No lonely card with empty columns beside it: 4 cards sit 2 × 2; an odd one left over on a 3-wide row takes the whole row.
      var cols = full.length % 3 === 0 ? 3 : full.length % 2 === 0 ? 2 : 3;
      if (cols === 3 && full.length % 3 === 1) full[full.length - 1] = full[full.length - 1].replace('<div class="card">', '<div class="card" style="grid-column:1/-1">');
      var aTier = (full.length ? '<div class="grid g-' + cols + '">' + full.join('') + '</div>' : '') +
        (hasInd ? '<div class="card" style="margin-top:14px"><h2>Industries (as typed)</h2><p>' + a.industries.map(function (x) { return '<span class="pill">' + esc(x.k) + (x.n > 1 ? ' ×' + x.n : '') + '</span>'; }).join(' ') + '</p></div>' : '') +
        (empty.length ? '<p class="muted empty-note" style="margin-top:12px">' + esc('No answers yet for: ' + empty.join(' · ') + '. These fill in once A-tier leads book through the Calendly form.') + '</p>' : '');
      view.innerHTML =
        '<div class="grid g-4 tiles">' +
        tile('A-tier who booked', n(a.people), pct(a.people / (d.total_booked || 1)) + ' of ' + n(d.total_booked) + ' bookers') +
        tile('A-tier cancel rate', pct(a.cancel_rate), 'vs ' + pct(T.C.cancel_rate) + ' for C-tier', null, { zeroOk: true }) +
        tile('Booked ahead (median)', a.median_days_booked_ahead == null ? '–' : a.median_days_booked_ahead.toFixed(1) + ' days', a.median_days_booked_ahead == null ? 'Needs Calendly booking times' + (a.repeat_bookers ? ' · ' + n(a.repeat_bookers) + ' booked more than once' : '') : n(a.repeat_bookers) + ' booked more than once') +
        tile('A-tier close rate', orNull(a.close_rate), a.past_calls ? n(a.outcomes_logged) + ' of ' + n(a.past_calls) + ' past calls logged' : 'No A-tier calls with a scheduled time have passed yet') + '</div>' +
        '<div class="card" style="margin-top:14px"><h2>By tier</h2><p class="sub">Tier comes from the funnel application, or from the Calendly booking form for people who booked directly (revenue, willingness to invest, budget, team size).</p>' +
        table([
          { label: 'Tier', key: 'tier' }, { label: 'People', key: 'people', num: true, fmt: n }, { label: 'Bookings', key: 'bookings', num: true, fmt: n },
          { label: 'Cancel rate', num: true, zeroOk: true, html: function (r) { return esc(pct(r.cancel_rate)); } },
          { label: 'Reschedule rate', num: true, html: function (r) { return esc(pct(r.reschedule_rate)); } },
          { label: 'Willing to invest', num: true, html: function (r) { return esc(pct(r.willing_yes)); } },
          { label: 'Logged', num: true, html: function (r) { return esc(n(r.outcomes_logged) + '/' + n(r.past_calls)); } },
          { label: 'Show', num: true, html: function (r) { return esc(orNull(r.show_rate)); } },
          { label: 'Close', num: true, html: function (r) { return esc(orNull(r.close_rate)); } },
          { label: 'Revenue', key: 'revenue', num: true, fmt: money }, { label: 'Cash', key: 'cash', num: true, fmt: money },
        ], [tierRow('A', 'A · $1M+, ready'), tierRow('B', 'B · promising'), tierRow('C', 'C · not yet'), tierRow('none', 'Untiered')].filter(function (r) { return r.people; }), { cards: true }) + '</div>' +
        '<h3 class="section-h">The A-tier</h3>' + aTier;
    });
  }

  function renderTeam() {
    return Promise.all([fetch('/admin/api/reps', { credentials: 'same-origin' }).then(function (r) { return r.json(); }), fetch('/admin/api/integrations', { credentials: 'same-origin' }).then(function (r) { return r.json(); })]).then(function (res) {
      var d = res[0], integ = res[1];
      var hooks = {};
      var vals = {};
      (integ.settings || []).forEach(function (s) { hooks[s.key] = s.source !== 'unset'; vals[s.key] = s.value; });
      var on = function (k) { return hooks[k] ? '<span class="pill ok">connected</span>' : '<span class="pill">not set</span>'; };
      function field(label, name, value, attrs) { return '<label>' + esc(label) + ' <input class="input" name="' + name + '" value="' + esc(value == null ? '' : value) + '" ' + (attrs || '') + '></label>'; }
      function form(r) {
        r = r || { role: 'closer', tiers: 'A,B', weight: 1, commission_pct: 0, monthly_target: 0, active: 1 };
        var tiers = String(r.tiers || '').split(',');
        return '<form class="rep-form grid" data-rep="' + esc(r.id || '') + '" style="gap:10px;margin-top:10px">' +
          '<div class="grid g-3" style="gap:10px">' + field('Name', 'name', r.name, 'required') + field('Email', 'email', r.email, 'type="email"') +
          '<label>Role <select class="input" name="role">' + d.roles.map(function (x) { return '<option' + (x === r.role ? ' selected' : '') + '>' + x + '</option>'; }).join('') + '</select></label></div>' +
          '<div class="grid g-3" style="gap:10px"><fieldset class="tiers"><legend>Takes tiers</legend>' + ['A', 'B', 'C'].map(function (t) { return '<label><input type="checkbox" name="tier" value="' + t + '"' + (tiers.indexOf(t) !== -1 ? ' checked' : '') + '> ' + t + '</label>'; }).join('') + '</fieldset>' +
          field('Round-robin weight', 'weight', r.weight, 'type="number" min="0" step="0.5"') +
          field('Calendar link', 'calendar_url', r.calendar_url, 'type="url" placeholder="' + esc(r.legacy_calendar || 'https://calendly.com/…') + '"') + '</div>' +
          '<div class="grid g-4" style="gap:10px">' + field('Commission % of cash', 'commission_pct', r.commission_pct, 'type="number" min="0" max="100" step="0.5"') + field('Monthly revenue target', 'monthly_target', r.monthly_target, 'type="number" min="0" step="1000"') +
          field('Slack member ID', 'slack_user_id', r.slack_user_id, 'placeholder="U0123ABCD"') + field('Discord user ID', 'discord_user_id', r.discord_user_id, 'placeholder="1234567890…"') + '</div>' +
          '<div class="row"><label class="muted"><input type="checkbox" name="active"' + (r.active ? ' checked' : '') + '> Active (gets new leads)</label><span style="flex:1"></span>' +
          (r.id && (r.slack_user_id || r.discord_user_id) ? '<button class="btn-sm ghost" type="button" data-ping="' + esc(r.id) + '">Test @mention</button>' : '') +
          '<button class="btn-sm" type="submit">' + (r.id ? 'Save' : 'Add to team') + '</button></div></form>';
      }
      view.innerHTML =
        '<div class="card"><h2>Team pings</h2><p class="sub">Paste incoming-webhook URLs under <a href="#integrations" data-go="integrations">Integrations → Alerts</a>. Closed deals go to the wins channel (or alerts if you only set one).</p>' +
        '<div class="grid g-2" style="margin-top:10px"><dl class="kv">' + '<dt>Slack · alerts</dt><dd>' + on('SLACK_WEBHOOK_URL') + '</dd><dt>Slack · wins</dt><dd>' + on('SLACK_WINS_WEBHOOK_URL') + '</dd><dt>Discord · alerts</dt><dd>' + on('DISCORD_WEBHOOK_URL') + '</dd><dt>Discord · wins</dt><dd>' + on('DISCORD_WINS_WEBHOOK_URL') + '</dd></dl>' +
        '<div><p class="sub">What gets posted: 🔥 hot A-tier leads · ✅ qualified B-tier leads · 📅 calls booked · 🚫 cancellations · ⏰ 15-minute call reminders (with @mention) · ✅ held · ❌ no-shows · 🎉 closed deals · lost deals · ☀️ daily digest at ' + esc(vals.DIGEST_HOUR || 8) + ':00.</p>' +
        '<div class="row" style="margin-top:10px"><button class="btn-sm ghost" data-test-notify="alerts">Test alerts</button><button class="btn-sm ghost" data-test-notify="wins">Test wins</button><button class="btn-sm ghost" data-test-digest>Send digest now</button></div></div></div></div>' +
        d.reps.map(function (r) { return '<div class="card' + (r.active ? '' : ' inactive') + '" style="margin-top:14px"><div class="card-head"><div><h2>' + esc(r.name) + '</h2><p class="sub">' + esc(r.role) + ' · tiers ' + esc(r.tiers || '–') + (r.calendar_url || r.legacy_calendar ? '' : ' · <b>no calendar — won’t get leads</b>') + '</p></div></div>' + form(r) + '</div>'; }).join('') +
        '<div class="card" style="margin-top:14px"><h2>Add a rep</h2><p class="sub">New closers join the round-robin for the tiers you tick, and leads book on their calendar. Find a Slack member ID in their profile → ⋯ → Copy member ID; a Discord user ID via Developer Mode → right-click → Copy User ID.</p>' + form(null) + '</div>';

      view.querySelectorAll('[data-go]').forEach(function (a) { a.onclick = function (ev) { ev.preventDefault(); go(a.getAttribute('data-go')); }; });
      view.querySelectorAll('.rep-form').forEach(function (f) {
        f.onsubmit = function (ev) {
          ev.preventDefault();
          var id = f.getAttribute('data-rep');
          var body = { tiers: [].map.call(f.querySelectorAll('[name=tier]:checked'), function (c) { return c.value; }), active: f.querySelector('[name=active]').checked };
          ['name', 'email', 'role', 'weight', 'calendar_url', 'commission_pct', 'monthly_target', 'slack_user_id', 'discord_user_id'].forEach(function (k) { body[k] = f.querySelector('[name=' + k + ']').value; });
          send(id ? 'PATCH' : 'POST', id ? 'reps/' + encodeURIComponent(id) : 'reps', body).then(function (r) {
            if (r.error) { toast(r.error); return; }
            toast(id ? 'Saved' : 'Added to the team');
            refreshMeta().then(load);
          });
        };
      });
      view.querySelectorAll('[data-ping]').forEach(function (b) { b.onclick = function () { send('POST', 'notify/test', { rep: b.getAttribute('data-ping') }).then(function (r) { toast(r.error || (r.ok ? 'Sent' : 'Webhook rejected it')); }); }; });
      view.querySelectorAll('[data-test-notify]').forEach(function (b) { b.onclick = function () { send('POST', 'notify/test', { channel: b.getAttribute('data-test-notify') }).then(function (r) { toast(r.error || (r.ok ? 'Sent — check the channel' : 'Webhook rejected it')); }); }; });
      view.querySelector('[data-test-digest]').onclick = function () { send('POST', 'notify/test', { digest: true }).then(function (r) { toast(r.error || 'Digest posted'); }); };
    });
  }


  function loadBehaviour(dr, id) {
    var box = dr.querySelector('[data-behaviour]');
    if (!box) return;
    fetch('/admin/api/leads/' + encodeURIComponent(id) + '/profile', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (p) {
      var templates = [];
      ((state.meta && state.meta.sequences) || []).forEach(function (sq) { sq.steps.forEach(function (t) { if (templates.indexOf(t) === -1) templates.push(t); }); });
      var modeNote = { ai: 'Claude rewrites each email', rules: 'a personal opening line (add an Anthropic key for full rewrites)', off: 'off' }[p.mode] || p.mode;
      box.querySelector('p.muted').outerHTML =
        '<p class="muted" style="margin-top:2px">Personalisation: <b>' + esc(modeNote) + '</b>' + (p.next ? ' · next email: <span class="mono">' + esc(p.next.template) + '</span> ' + esc(when(p.next.send_at)) : '') + '</p>' +
        (p.facts.length ? '<ul class="facts">' + p.facts.map(function (f) { return '<li' + (f.used ? ' class="used"' : '') + '><span class="w">' + esc(f.weight) + '</span>' + esc(f.text) + (f.used ? ' <span class="pill">used</span>' : '') + '</li>'; }).join('') + '</ul>' : '<p class="muted">Nothing tracked for this lead yet.</p>') +
        '<div class="row" style="margin-top:12px"><select class="input" data-pv-t>' + templates.map(function (t) { return '<option' + (p.next && p.next.template === t ? ' selected' : '') + '>' + esc(t) + '</option>'; }).join('') + '</select><button class="btn-sm" data-pv>Preview personalised email</button></div><div data-pv-out></div>';
      box.querySelector('[data-pv]').onclick = function () {
        var b = this, out = box.querySelector('[data-pv-out]');
        b.disabled = true; out.innerHTML = '<p class="muted">Writing it…</p>';
        fetch('/admin/api/leads/' + encodeURIComponent(id) + '/preview-email?template=' + encodeURIComponent(box.querySelector('[data-pv-t]').value), { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (e) {
          b.disabled = false;
          if (e.error && !e.html) { out.innerHTML = '<p class="muted">' + esc(e.error) + '</p>'; return; }
          out.innerHTML = '<p class="sub" style="margin-top:12px"><b>' + esc(e.subject) + '</b> · ' + esc(e.mode) + (e.factsUsed.length ? ' · uses ' + esc(e.factsUsed.join(', ')) : '') + (e.error ? ' · <span class="muted">' + esc(e.error) + '</span>' : '') + '</p><iframe class="email-preview" sandbox title="Email preview"></iframe>';
          out.querySelector('iframe').srcdoc = e.html;
        });
      };
    });
  }


  function ymd(ms) { if (!ms) return ''; var d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function opts(list, cur, blank) { return (blank ? '<option value="">' + esc(blank) + '</option>' : '') + (list || []).map(function (x) { return '<option' + (x === cur ? ' selected' : '') + '>' + esc(x) + '</option>'; }).join(''); }
  function dealCard(l) {
    var m = state.meta || {};
    var flags = []; try { flags = JSON.parse(l.qual_flags || '[]'); } catch (e) { /* ignore */ }
    var f = function (label, html) { return '<label>' + esc(label) + ' ' + html + '</label>'; };
    var inp = function (name, val, type, extra) { return '<input class="input" data-f="' + name + '" type="' + (type || 'text') + '" value="' + esc(val == null ? '' : val) + '"' + (extra || '') + '>'; };
    return '<div class="card" id="ld-deal" style="margin-top:14px"><div class="card-head"><div><h2>Deal</h2><p class="sub">' +
      esc([l.revenue_band && ('Revenue ' + l.revenue_band), l.industry, l.budget_band && ('Budget ' + l.budget_band), l.willing_to_invest && l.willing_to_invest !== 'unknown' && ('Willing to invest: ' + l.willing_to_invest), l.qual_source && ('qualified from ' + l.qual_source)].filter(Boolean).join(' · ') || 'No qualification data yet.') +
      (flags.length ? '<br>' + flags.map(function (x) { var t = String(x).replace(/_/g, ' '); return '<span class="pill" title="' + esc(x) + '">' + esc(t.charAt(0).toUpperCase() + t.slice(1)) + '</span>'; }).join(' ') : '') + '</p></div></div>' +
      '<div class="grid g-4 deal-grid" style="gap:10px">' +
      f('Temperature', '<select class="input" data-f="temperature">' + opts(m.temperatures, l.temperature, '—') + '</select>') +
      f('Fit (1–5)', '<select class="input" data-f="fit_rating">' + opts(['1', '2', '3', '4', '5'], l.fit_rating == null ? '' : String(l.fit_rating), '—') + '</select>') +
      f('Decision maker on call', '<select class="input" data-f="decision_maker"><option value="">—</option><option value="1"' + (l.decision_maker === 1 ? ' selected' : '') + '>Yes</option><option value="0"' + (l.decision_maker === 0 ? ' selected' : '') + '>No</option></select>') +
      f('Main objection', '<select class="input" data-f="objection">' + opts(m.objections, l.objection, '—') + '</select>') +
      f('Follow up on', inp('follow_up_at', ymd(l.follow_up_at), 'date')) +
      f('Offer bought', inp('offer', l.offer, 'text', ' placeholder="e.g. 90-day LOI program"')) +
      f('Payment plan', '<select class="input" data-f="payment_plan">' + opts(m.paymentPlans, l.payment_plan, '—') + '</select>') +
      f('Instalments', inp('installments_total', l.installments_total, 'number', ' min="0"')) +
      f('Contract signed', inp('contract_signed_at', ymd(l.contract_signed_at), 'date')) +
      f('Next payment due', inp('next_payment_at', ymd(l.next_payment_at), 'date')) +
      f('LOI signed', inp('loi_signed_at', ymd(l.loi_signed_at), 'date')) +
      f('Target business', inp('target_business', l.target_business)) +
      '</div><p class="muted" style="margin-top:8px">Saved with the Save button above. Cash collected comes from the payments below once you add any.' +
      (l.contract_signed_at && !l.loi_signed_at ? ' <b>' + Math.max(0, 90 - Math.floor((Date.now() - l.contract_signed_at) / 86400000)) + ' days left</b> in the 90-day LOI window.' : '') + '</p>' +
      '<h2 style="margin-top:14px">Payments</h2><div data-payments><p class="muted">Loading…</p></div>' +
      '<div class="row" style="margin-top:8px"><input class="input" data-pay-amt type="number" step="100" placeholder="Amount (negative = refund)" style="width:190px"><input class="input" data-pay-date type="date" value="' + ymd(Date.now()) + '"><select class="input" data-pay-method><option>stripe</option><option>bank</option><option>card</option><option>other</option></select><input class="input" data-pay-note placeholder="Note" style="flex:1"><button class="btn-sm" data-pay-add type="button">Add payment</button></div></div>';
  }
  function loadPayments(dr, id) {
    var box = dr.querySelector('[data-payments]');
    if (!box) return;
    var draw = function () {
      fetch('/admin/api/leads/' + encodeURIComponent(id) + '/payments', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
        var total = d.payments.reduce(function (t, p) { return t + p.amount; }, 0);
        box.innerHTML = d.payments.length ? table([
          { label: 'Date', html: function (p) { return esc(ymd(p.paid_at)); } },
          { label: 'Amount', num: true, html: function (p) { return '<span' + (p.amount < 0 ? ' class="muted"' : '') + '>' + esc(money(p.amount)) + '</span>'; } },
          { label: 'Method', key: 'method' }, { label: 'Note', key: 'note' },
          { label: '', html: function (p) { return '<button class="btn-sm ghost" data-pay-del="' + esc(p.id) + '">✕</button>'; } },
        ], d.payments) + '<p class="sub" style="margin-top:6px">Collected: <b>' + esc(money(total)) + '</b></p>' : '<p class="muted">No payments recorded.</p>';
        box.querySelectorAll('[data-pay-del]').forEach(function (b) { b.onclick = function () { fetch('/admin/api/leads/' + encodeURIComponent(id) + '/payments/' + encodeURIComponent(b.getAttribute('data-pay-del')), { method: 'DELETE', credentials: 'same-origin' }).then(draw); }; });
      });
    };
    draw();
    dr.querySelector('[data-pay-add]').onclick = function () {
      send('POST', 'leads/' + encodeURIComponent(id) + '/payments', { amount: dr.querySelector('[data-pay-amt]').value, paid_at: dr.querySelector('[data-pay-date]').value, method: dr.querySelector('[data-pay-method]').value, note: dr.querySelector('[data-pay-note]').value })
        .then(function (r) { if (r.error) { toast(r.error); return; } toast('Payment saved'); dr.querySelector('[data-pay-amt]').value = ''; dr.querySelector('[data-pay-note]').value = ''; draw(); var c = dr.querySelector('[data-f=cash_collected]'); if (c) c.value = r.cash_collected; });
    };
  }

  function voiceCall(v) {
    var sd = {};
    try { sd = JSON.parse(v.structured || '{}'); } catch (x) { /* ignore */ }
    var tags = [sd.wants_strategy_call && 'wants a call', sd.wants_human_callback && 'wants a person to call back', sd.do_not_contact && 'do not contact', sd.recording_consent === false && 'declined recording'].filter(Boolean);
    return '<details class="voice-call" style="margin:10px 0"><summary><strong>' + esc(when(v.created_at)) + '</strong> <span class="muted">' + esc(v.kind) + ' · ' + esc(v.duration_s ? secs(v.duration_s) : v.status) + (v.ended_reason ? ' · ' + esc(v.ended_reason) : '') + '</span>' +
      (tags.length ? ' ' + tags.map(function (t) { return '<span class="pill">' + esc(t) + '</span>'; }).join(' ') : '') + '</summary>' +
      (v.summary ? '<p>' + esc(v.summary) + '</p>' : '') + (v.recording_url ? '<audio controls preload="none" src="' + esc(v.recording_url) + '" style="width:100%"></audio>' : '') +
      (v.transcript ? '<pre class="transcript" style="white-space:pre-wrap;max-height:320px;overflow:auto">' + esc(v.transcript) + '</pre>' : '') + '</details>';
  }

  state.linkModel = state.linkModel || 'first';
  function renderLinks() {
    return api('links', { model: state.linkModel }).then(function (d) {
      var PL = { description: 'Description', pinned_comment: 'Pinned comment', end_screen: 'End screen', card: 'Card', community_post: 'Community post', shorts: 'Shorts', channel_about: 'Channel about', other: 'Other' };
      function r(a, b) { return b ? pct(a / b) : '–'; }
      // Roll links up to one row per video (custom links stay on their own).
      var groups = {}, order = [];
      d.links.forEach(function (l) {
        var k = l.video_id || ('custom:' + l.code);
        if (!groups[k]) { groups[k] = { title: l.video_title || l.label, thumb: l.thumbnail, video_id: l.video_id, links: [], clicks_total: 0, visitors: 0, vsl_viewers: 0, leads: 0, applications: 0, qualified: 0, booked: 0, showed: 0, won: 0, revenue: 0 }; order.push(k); }
        var g = groups[k]; g.links.push(l);
        ['clicks_total', 'visitors', 'vsl_viewers', 'leads', 'applications', 'qualified', 'booked', 'showed', 'won', 'revenue'].forEach(function (m) { g[m] += l[m] || 0; });
      });
      var cols = [
        { label: 'Clicks', key: 'clicks_total', num: true, fmt: n }, { label: 'Visitors', key: 'visitors', num: true, fmt: n }, { label: 'Watched VSL', key: 'vsl_viewers', num: true, fmt: n },
        { label: 'Leads', key: 'leads', num: true, fmt: n }, { label: 'Applied', key: 'applications', num: true, fmt: n }, { label: 'Qualified', key: 'qualified', num: true, fmt: n },
        { label: 'Booked', key: 'booked', num: true, fmt: n }, { label: 'Showed', key: 'showed', num: true, fmt: n }, { label: 'Won', key: 'won', num: true, fmt: n },
        { label: 'Revenue', key: 'revenue', num: true, fmt: function (v) { return v ? '$' + n(v) : '–'; } },
        { label: 'Visit → booked', num: true, html: function (x) { return esc(r(x.booked, x.visitors)); } },
      ];
      view.innerHTML =
        '<div class="card"><h2>New tracked link</h2><p class="sub">Paste a YouTube video link and pick where the link will go. Use a separate link for each placement, so you can see which one sends buyers.</p>' +
        '<div class="row" style="gap:10px;flex-wrap:wrap"><input class="input" data-yt placeholder="https://www.youtube.com/watch?v=…" style="flex:2;min-width:260px">' +
        '<select class="input" data-pl>' + d.placements.map(function (p) { return '<option value="' + p + '">' + esc(PL[p] || p) + '</option>'; }).join('') + '</select>' +
        '<input class="input" data-label placeholder="Name (optional)" style="flex:1;min-width:160px"><button class="btn-sm" data-create type="button">Create link</button></div>' +
        '<p data-made style="margin:12px 0 0"></p></div>' +
        '<div class="card" style="margin-top:14px"><div class="card-head"><div><h2>By video</h2><p class="sub">Leads credited by ' + (state.linkModel === 'first' ? '<b>first touch</b> (the link that first brought them in)' : '<b>last touch</b> (the link they came through when they applied)') + '.</p></div>' +
        '<div class="row"><button class="btn-sm ' + (state.linkModel === 'first' ? '' : 'ghost') + '" data-model="first" type="button">First touch</button><button class="btn-sm ' + (state.linkModel === 'last' ? '' : 'ghost') + '" data-model="last" type="button">Last touch</button></div></div>' +
        (order.length ? table([{ label: 'Video', html: function (g) { return '<div class="row" style="gap:10px;align-items:center;flex-wrap:nowrap">' + (g.thumb ? '<img src="' + esc(g.thumb) + '" alt="" width="80" height="45" style="border-radius:4px;object-fit:cover;flex:none">' : '') + '<span>' + (g.video_id ? '<a href="https://www.youtube.com/watch?v=' + esc(g.video_id) + '" target="_blank" rel="noopener">' + esc(g.title) + '</a>' : esc(g.title)) + '<div class="muted">' + g.links.length + ' link' + (g.links.length === 1 ? '' : 's') + '</div></span></div>'; } }].concat(cols), order.map(function (k) { return groups[k]; }), { cards: true }) : '<p class="muted">No tracked links yet. Create one above and put it in your video description.</p>') + '</div>' +
        (d.links.length ? '<div class="card" style="margin-top:14px"><h2>By link</h2>' + table([
          { label: 'Link', html: function (l) { return '<strong>' + esc(l.label) + '</strong><div class="muted">' + esc(PL[l.placement] || l.placement || l.utm_source) + '</div>'; } },
          { label: 'Short URL', html: function (l) { return '<button class="btn-sm ghost" type="button" data-copy="' + esc(l.short_url) + '">Copy</button> <span class="mono muted">/l/' + esc(l.code) + '</span>'; } },
        ].concat(cols).concat([{ label: '', html: function (l) { return '<button class="btn-sm ghost" type="button" data-del="' + esc(l.code) + '" title="Archive">✕</button>'; } }]), d.links, { cards: true }) + '</div>' : '') +
        '<p class="sub" style="margin-top:14px">Links to your site with UTM tags work too (they show under Traffic &amp; ads). Tracked links are better for YouTube: short, and every one is followed to revenue.</p>';
      view.querySelector('[data-create]').onclick = function () {
        var out = view.querySelector('[data-made]');
        out.textContent = 'Creating…';
        send('POST', 'links', { url: view.querySelector('[data-yt]').value, placement: view.querySelector('[data-pl]').value, label: view.querySelector('[data-label]').value }).then(function (res) {
          if (!res.ok) { out.textContent = res.error || 'Could not create the link'; return; }
          out.innerHTML = 'Created for <b>' + esc(res.link.video_title || res.link.label) + '</b>: <span class="mono">' + esc(res.link.short_url) + '</span> <button class="btn-sm" type="button" data-copy="' + esc(res.link.short_url) + '">Copy</button>';
          wireCopy(out);
          setTimeout(load, 1500);
        });
      };
      view.querySelectorAll('[data-model]').forEach(function (b) { b.onclick = function () { state.linkModel = b.getAttribute('data-model'); load(); }; });
      view.querySelectorAll('[data-del]').forEach(function (b) { b.onclick = function () { if (confirm('Archive this link? It will stop redirecting.')) send('DELETE', 'links/' + b.getAttribute('data-del')).then(load); }; });
      wireCopy(view);
    });
  }
  function wireCopy(root) {
    root.querySelectorAll('[data-copy]').forEach(function (b) {
      b.onclick = function () { var t = b.getAttribute('data-copy'); (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function () { toast('Copied ' + t); }, function () { prompt('Copy this link', t); }); };
    });
  }

  function renderTracking() {
    return api('tracking').then(function (d) {
      var c = d.configured;
      var sum = {};
      d.byDest.forEach(function (r) { (sum[r.dest] = sum[r.dest] || { sent: 0, failed: 0, retrying: 0 })[r.status] = r.n; });
      function destTile(key, label, on) {
        var x = sum[key] || { sent: 0, failed: 0, retrying: 0 };
        var total = x.sent + x.failed + x.retrying;
        return tile(label, on ? n(x.sent) + ' delivered' : 'Not connected', on ? (total ? pct(x.sent / total) + ' success · ' + n(x.retrying) + ' retrying · ' + n(x.failed) + ' failed' : 'No events in this range yet') : 'Connect it under Integrations');
      }
      var LABELS = { em: 'Email', ph: 'Phone', fn: 'First name', ln: 'Last name', external_id: 'External ID', client_ip_address: 'IP address', client_user_agent: 'User agent', fbp: 'Browser ID (fbp)', fbc: 'Click ID (fbc)', ct: 'City', st: 'State', zp: 'Postcode', country: 'Country' };
      view.innerHTML =
        '<div class="grid g-3 tiles">' + destTile('meta', 'Meta Conversions API', c.meta) + destTile('ga4', 'GA4 Measurement Protocol', c.ga4) +
        tile('Meta Pixel', c.pixel ? 'On' : 'Off', c.pixel ? 'Browser events share event IDs with the server, so Meta deduplicates' + (c.testMode ? ' · TEST MODE ON' : '') : 'Add the Pixel ID under Integrations') + '</div>' +
        '<div class="grid g-2" style="margin-top:14px"><div class="card"><h2>Meta match keys</h2><p class="sub">Share of the last ' + n(d.metaSample) + ' Meta events that carried each customer-information key. More keys means a higher Event Match Quality.</p>' +
        (d.metaSample ? barList(d.coverage.map(function (k) { return { name: LABELS[k.key] || k.key, value: Math.round(k.pct * 100) }; }), { max: 100, fmt: function (v) { return v + '%'; } }) : emptyState('No Meta events sent yet.')) + '</div>' +
        '<div class="card"><h2>Send a test event</h2><p class="sub">In Meta Events Manager open your Pixel, then Test events, and copy the test code. The event shows up there within seconds.</p><div class="row"><input class="input" data-code placeholder="TEST12345" style="flex:1"><button class="btn-sm" data-test-meta type="button">Send test</button></div><p class="muted" data-test-out style="margin-top:10px"></p></div></div>' +
        '<div class="card" style="margin-top:14px"><h2>By event</h2>' + table([{ label: 'Destination', key: 'dest' }, { label: 'Event', key: 'event_name' }, { label: 'Sent', key: 'sent', num: true, fmt: n }, { label: 'Retrying', key: 'retrying', num: true, fmt: n }, { label: 'Failed', key: 'failed', num: true, fmt: n }, { label: 'Last', html: function (r) { return esc(when(r.last_at)); } }], d.byEvent, { cards: true, emptyHint: 'Appears once Meta CAPI or GA4 is connected under Integrations.' }) + '</div>' +
        '<div class="card" style="margin-top:14px"><h2>Problems</h2><p class="sub">Failed sends are retried automatically with back-off (1 min, 4 min, 16 min, 1 h, then every few hours). Meta only accepts events up to 7 days old.</p>' +
        (d.failures.length ? table([{ label: 'When', html: function (r) { return esc(when(r.ts)); } }, { label: 'Destination', key: 'dest' }, { label: 'Event', key: 'event_name' }, { label: 'Status', key: 'status' }, { label: 'Tries', key: 'attempts', num: true }, { label: 'Error', html: function (r) { return esc(((r.http_status ? r.http_status + ' ' : '') + (r.error || '')).slice(0, 160)); } }], d.failures, { cards: true }) : emptyState('Nothing failing.')) + '</div>';
      view.querySelector('[data-test-meta]').onclick = function () {
        var out = view.querySelector('[data-test-out]');
        out.textContent = 'Sending…';
        send('POST', 'tracking/test-meta', { code: view.querySelector('[data-code]').value }).then(function (r) { out.textContent = r.ok ? 'Meta received ' + r.events_received + ' event (trace ' + r.fbtrace_id + '). Check Test events.' : (r.error || 'Failed'); });
      };
    });
  }

  var CALL_STATUS = { queued: 'Queued', dialing: 'Calling…', done: 'Done', no_answer: 'No answer', failed: 'Failed', skipped: 'Skipped', cancelled: 'Cancelled' };
  function callOutcome(o) {
    var f = {}; try { f = JSON.parse(o.outcome || '{}'); } catch (x) { /* ignore */ }
    return [f.appointment_confirmed && 'confirmed', f.wants_reschedule && 'reschedule', f.wants_booking_link && 'wants link', f.do_not_call && 'do not call', f.bad_time && 'bad time'].filter(Boolean).join(' · ');
  }

  /** What kind of provider error this is, read only from its status code ("ElevenLabs 401: …") or its JSON status, never from
   *  digits elsewhere in the text (a phone number or request id with 401 / 429 in it). 'auth' | 'rate' | ''. */
  function errKind(s) {
    s = String(s || '');
    var m = /^[A-Za-z][\w.\- ]*?\s([45]\d\d)(?::|\s*\{|\s*$)/.exec(s), code = m ? m[1] : '';
    var j = errJson(s), st = j && j.detail && typeof j.detail === 'object' ? String(j.detail.status || j.detail.code || '') : '';
    if (code === '401' || st === 'invalid_api_key' || st === 'unauthorized') return 'auth';
    if (code === '429' || st === 'rate_limit_exceeded' || st === 'too_many_requests') return 'rate';
    return '';
  }
  function errJson(s) { var i = s.indexOf('{'); if (i < 0) return null; try { return JSON.parse(s.slice(i)); } catch (e) { return null; } }
  /** A provider error ("ElevenLabs 401: {json}") as one plain sentence. Plain text: callers esc() it.
   *  status: the queue row's status, so "will retry" is only promised while it's still queued. */
  function friendlyErr(s, status) {
    s = String(s || '');
    var head = s.split('{')[0].replace(/[:\s]+$/, ''), j = errJson(s), msg = '';
    if (j) msg = (j.detail && (j.detail.message || (typeof j.detail === 'string' ? j.detail : ''))) || j.message || j.error || '';
    if (typeof msg !== 'string') msg = '';
    var who = (/^([A-Za-z][\w.\-]*)\s[45]\d\d\b/.exec(head) || [0, 'ElevenLabs'])[1], kind = errKind(s);
    if (kind === 'auth') return who + ' rejected the API key' + (msg ? ' (' + msg + ')' : '') + '.';
    if (kind === 'rate') return 'Rate-limited by ' + who + (status === 'queued' || status === 'dialing' ? ', will retry.' : '.');
    return (head + (msg ? ' · ' + msg : '')).slice(0, 120) || s.slice(0, 80);
  }
  var CALL_PILL = { done: 'st-won', queued: 'st-booked', dialing: 'st-booked', failed: 'st-failed', cancelled: 'st-cancelled', skipped: 'st-cancelled', no_answer: 'st-cancelled' };

  function elevenCard(e) {
    // Three states: done (green ✓), failing (amber !), not done yet (empty ring).
    var step = function (ok, label, body, warn) { return '<li class="setup-step' + (ok ? ' ok' : warn ? ' warn' : '') + '"><span class="dot">' + (ok ? '✓' : warn ? '!' : '') + '</span><div><b>' + label + '</b>' + (body ? '<div class="muted">' + body + '</div>' : '') + '</div></li>'; };
    var phones = e.phoneNumbers || [];
    var phoneOk = !!e.phoneNumberId && !e.phoneError;
    var intLink = '<a href="#integrations" data-go="integrations">Open Integrations →</a>';
    var keyLink = 'Check the key → <a href="#integrations" data-go="integrations">Open Integrations</a>';
    // The phone-number lookup runs live with the saved key on every visit, so it says whether the key works right now
    // (old failed calls in the queue may predate a fixed key). Step 1, step 3 and the pill all follow it.
    var elAuth = function (x) { x = String(x || ''); return errKind(x) === 'auth' && (/^ElevenLabs\b/i.test(x) || !/^[A-Za-z][\w.\-]*\s[45]\d\d/.test(x)); }; // another provider's 401 isn't this key
    var keyBad = !!e.apiKey && elAuth(e.phoneError);
    var phoneErrHtml = e.phoneError ? esc(friendlyErr(e.phoneError)) + ' ' + (errKind(e.phoneError) === 'auth' ? keyLink : intLink) + '<details class="raw"><summary>details</summary><code>' + esc(e.phoneError) + '</code></details>' : '';
    var needsFix = keyBad || !!e.phoneError;
    var pill = e.ready && !needsFix ? '<span class="pill ok">live</span>' : needsFix ? '<span class="pill pill-warn">needs fixing</span>' : '<span class="pill">not set up</span>';
    // Two or more failed calls for the same reason: say it once above the table.
    var errGroups = {}, errAuth = {};
    (e.queue || []).forEach(function (o) { if (o.error && o.status === 'failed') { var f = friendlyErr(o.error, o.status); errGroups[f] = (errGroups[f] || 0) + 1; if (errKind(o.error) === 'auth') errAuth[f] = true; } });
    var sharedErr = Object.keys(errGroups).filter(function (f) { return errGroups[f] > 1; }).sort(function (x, y) { return errGroups[y] - errGroups[x]; })[0];
    return '<div class="card"><div class="card-head"><div><h2>AI calls · ElevenLabs</h2><p class="sub">Calls applicants who ticked the call-consent box: confirms the appointment ~2 min after they book, and calls qualified leads who applied but didn’t book (~5 min). Only inside their local calling hours (Mon–Fri 9–8, Sat 9–5), max 2 attempts, discloses AI + recording, and stops for good if they say so.</p></div>' +
      pill + '</div>' +
      '<ol class="setup">' +
      step(e.apiKey && !keyBad, '1. API key', keyBad ? 'Saved, but ElevenLabs rejects it. Paste a fresh key under <a href="#integrations" data-go="integrations">Integrations → Voice</a>.' : e.apiKey ? 'Connected.' : 'Paste it under <a href="#integrations" data-go="integrations">Integrations → Voice → ElevenLabs API key</a> (elevenlabs.io → Developers → API keys).', keyBad) +
      step(!!e.agentId, '2. Agent', (e.agentId ? 'Agent <span class="mono">' + esc(e.agentId) + '</span>. ' : '') + '<button class="btn-sm' + (e.agentId ? ' ghost' : '') + '" data-el-provision' + (e.apiKey ? '' : ' disabled') + '>' + (e.agentId ? 'Update agents in ElevenLabs' : 'Create agents in ElevenLabs') + '</button>') +
      step(phoneOk, '3. Phone number', (phones.length ? phoneErrHtml + '<select class="input" data-el-phone><option value="">Pick the number to call from…</option>' + phones.map(function (p) { return '<option value="' + esc(p.phone_number_id) + '"' + (p.phone_number_id === e.phoneNumberId ? ' selected' : '') + '>' + esc(p.phone_number + (p.label ? ' · ' + p.label : '') + ' (' + p.provider + ')') + '</option>'; }).join('') + '</select>' :
        (e.phoneError ? phoneErrHtml : 'In ElevenLabs → Phone numbers, import a Twilio number (or SIP trunk). It shows up here.')), !!e.phoneError) +
      step(e.inboundAssigned, '4. Callbacks (inbound)', e.inboundAgentId ? (e.inboundAssigned ? 'Callback agent <span class="mono">' + esc(e.inboundAgentId) + '</span> answers anyone who rings the number back, looks them up by caller ID, and logs the outcome.' : 'Callback agent created but not on the number yet. Pick the number, then press “Update agents”.') : 'Press “Create agents” to also answer people who ring the number back.') +
      step(e.webhook.secret, '5. Post-call webhook (optional, faster results)', 'ElevenLabs → Agents → Settings → Post-call webhook → URL <span class="mono">' + esc(e.webhook.url) + '</span>, then paste its secret under Integrations → Voice. Without it results are fetched every 5 minutes.') +
      '</ol>' +
      '<div class="row" style="margin-top:12px"><input class="input" data-el-to placeholder="Your mobile, e.g. +61412345678" style="flex:1;min-width:200px"><select class="input" data-el-kind><option value="confirm">Confirmation script</option><option value="speed_to_lead">Speed-to-lead script</option></select><button class="btn-sm" data-el-test' + (e.ready ? '' : ' disabled') + '>Call me (test)</button></div>' +
      '<p class="muted" style="margin-top:8px">Confirmation calls: <b>' + (e.confirm ? 'on' : 'off') + '</b> · Speed-to-lead: <b>' + (e.speedToLead ? 'on' : 'off') + '</b> · No-show rebook: <b>' + (e.rebook ? 'on' : 'off') + '</b> (toggle under Integrations → Voice) · ' + n(e.stats && e.stats.consented) + ' leads have consented to calls.</p></div>' +
      '<div class="card" style="margin-top:14px"><h2>Call queue</h2>' +
      (sharedErr ? '<p class="muted queue-err">' + esc(n(errGroups[sharedErr]) + ' calls failed: ' + sharedErr) + ' ' + (errAuth[sharedErr] ? keyLink : intLink) + '</p>' : '') +
      table([
        { label: 'When', nw: true, html: function (o) { return esc(when(o.status === 'queued' ? o.run_at : o.updated_at)); } },
        { label: 'Lead', nw: true, html: function (o) { return '<a href="#lead=' + esc(o.lead_id) + '" data-open="' + esc(o.lead_id) + '">' + esc([o.first_name, o.last_name].filter(Boolean).join(' ') || o.phone || 'lead') + '</a>' + (o.tier ? ' <span class="tier ' + esc(o.tier) + '">' + esc(o.tier) + '</span>' : ''); } },
        { label: 'Call', html: function (o) { return esc(o.kind === 'speed_to_lead' ? 'Speed-to-lead' : o.kind === 'confirm' ? 'Confirm booking' : o.kind) + ' <span class="muted">#' + esc(o.attempts || 1) + '</span>'; } },
        { label: 'Status', html: function (o) { return '<span class="pill' + (CALL_PILL[o.status] ? ' ' + CALL_PILL[o.status] : '') + '">' + esc(CALL_STATUS[o.status] || o.status) + '</span>' + (o.error ? ' <span class="muted err-short' + (sharedErr && friendlyErr(o.error, o.status) === sharedErr ? ' err-dup' : '') + '" title="' + esc(o.error) + '">' + esc(friendlyErr(o.error, o.status)) + '</span>' : ''); } },
        { label: 'Outcome', html: function (o) { return esc(callOutcome(o)); } },
      ], e.queue, { cards: true }) + '</div>';
  }

  function renderVoice() {
    return Promise.all([api('voice'), api('voice/elevenlabs', null, { noRange: true }).catch(function () { return null; })]).then(function (res) {
      var d = res[0], e = res[1];
      var t = d.totals || {};
      view.innerHTML =
        (e ? elevenCard(e) : '') +
        '<div class="grid g-3 tiles" style="margin-top:14px">' + tile('AI calls', n(t.calls || 0), n(t.phone || 0) + ' inbound phone · ' + n(t.web || 0) + ' browser · ' + n((t.calls || 0) - (t.phone || 0) - (t.web || 0)) + ' outbound') + tile('Wanted a strategy call', n(t.wants_call || 0), n(t.callbacks || 0) + ' asked for a person to call back') +
        tile('Avg length', t.avg_s ? secs(t.avg_s) : '–', (t.cost ? '$' + t.cost + ' cost · ' : '') + n(t.opt_outs || 0) + ' opted out') + '</div>' +
        '<div class="card" style="margin-top:14px"><h2>Calls</h2><p class="sub">Inbound (Vapi) and outbound (ElevenLabs). Every call opens with an AI + recording disclosure.</p>' +
        (d.calls.length ? table([
          { label: 'When', nw: true, html: function (v) { return esc(when(v.created_at)); } },
          { label: 'Who', html: function (v) { return v.lead_id ? '<a href="#lead=' + esc(v.lead_id) + '" data-open="' + esc(v.lead_id) + '">' + esc([v.first_name, v.last_name].filter(Boolean).join(' ') || 'lead') + '</a>' + (v.tier ? ' <span class="tier ' + esc(v.tier) + '">' + esc(v.tier) + '</span>' : '') : '<span class="muted">' + esc(v.from_number || 'unknown') + '</span>'; } },
          { label: 'Type', html: function (v) { return esc({ ai_confirm: 'Outbound · confirm', ai_speed_to_lead: 'Outbound · speed-to-lead', ai_callback: 'Callback (inbound)', phone: 'Inbound phone', web: 'Browser' }[v.kind] || v.kind); } },
          { label: 'Length', html: function (v) { return esc(v.duration_s ? secs(v.duration_s) : v.status); } },
          { label: 'Summary', html: function (v) { return esc((v.summary || '').slice(0, 180)); } },
          { label: 'Rec.', html: function (v) { return v.recording_url ? '<a href="' + esc(v.recording_url) + '" target="_blank" rel="noopener">▶</a>' : ''; } },
        ], d.calls, { cards: true }) : '<p class="muted">No AI calls yet.</p>') + '</div>';
      view.querySelectorAll('[data-open]').forEach(function (a) { a.onclick = function (ev) { ev.preventDefault(); openLead(a.getAttribute('data-open')); }; });
      view.querySelectorAll('[data-go]').forEach(function (a) { a.onclick = function (ev) { ev.preventDefault(); go(a.getAttribute('data-go')); }; });
      var pv = view.querySelector('[data-el-provision]');
      if (pv) pv.onclick = function () { pv.disabled = true; pv.textContent = 'Working…'; send('POST', 'voice/elevenlabs/provision', {}).then(function (r) { toast(r.ok ? ((r.created ? 'Agents created' : 'Agents updated') + (r.inbound && r.inbound.notes && r.inbound.notes.length ? ' — ' + r.inbound.notes.join(' ') : '')) : (r.error || 'Failed')); load(); }); };
      var ph = view.querySelector('[data-el-phone]');
      if (ph) ph.onchange = function () { send('POST', 'voice/elevenlabs/phone', { id: ph.value }).then(function () { toast('Saved'); load(); }); };
      var tb = view.querySelector('[data-el-test]');
      if (tb) tb.onclick = function () {
        tb.disabled = true;
        send('POST', 'voice/elevenlabs/test-call', { to: view.querySelector('[data-el-to]').value, kind: view.querySelector('[data-el-kind]').value }).then(function (r) { tb.disabled = false; toast(r.ok ? 'Calling you now…' : (r.error || 'Failed')); });
      };
    });
  }

  function kv(k, v) { return '<dt>' + esc(k) + '</dt><dd>' + esc(v == null || v === '' ? '–' : v) + '</dd>'; }

  var SMS_LABEL = { sms_confirm: 'Booking confirmed + join link', sms_24h: '24h before (reschedule link)', sms_1h: '1h before (join link)', sms_10m: '10 min before (join link)', sms_noshow_1: 'No-show: 10 min after', sms_noshow_2: 'No-show: next day', sms_abandon: 'Unfinished application (30 min)', sms_book_nudge: 'Qualified, not booked (2h)' };
  function smsCard(d) {
    if (!d) return '';
    return '<div class="card" style="margin-bottom:14px"><h2>Text messages (SMS)</h2><p class="sub">' +
      (d.configured ? (d.enabled ? 'Connected to Twilio.' : 'Connected but paused (SMS_ENABLED = false).') : 'Not connected yet: texts are simulated. Add Twilio under Integrations → SMS.') +
      ' Only to people who ticked “call or text me” (' + n(d.consent && d.consent.consented) + ' so far), 8am–8pm their time, max 3 a day, STOP opts out (' + n(d.consent && d.consent.opted_out) + '). Replies webhook: <span class="mono">' + esc(d.webhook) + '</span></p>' +
      table([
        { label: 'Text', html: function (r) { return esc(SMS_LABEL[r.template] || r.template); } },
        { label: 'Sent', key: 'sent', num: true, fmt: n }, { label: 'Clicked', key: 'clicked', num: true, fmt: n },
        { label: 'Waiting', key: 'pending', num: true, fmt: n }, { label: 'Skipped', key: 'skipped', num: true, fmt: n }, { label: 'Failed', key: 'failed', num: true, fmt: n },
      ], d.bySeq || []) +
      '<details style="margin-top:10px"><summary>Recent texts and replies</summary>' + table([
        { label: 'When', html: function (r) { return esc(ago(r.sent_at || r.created_at)); } },
        { label: 'Lead', html: function (r) { return esc([r.first_name, r.last_name].filter(Boolean).join(' ') || '–'); } },
        { label: '', html: function (r) { return r.direction === 'in' ? '⬅︎ reply' : esc(r.status); } },
        { label: 'Message', html: function (r) { return esc(r.body || SMS_LABEL[r.template] || '') + (r.error ? '<div class="muted">' + esc(r.error) + '</div>' : ''); } },
      ], d.recent || [], { rowAttr: function (r) { return r.lead_id ? 'class="click" data-lead="' + esc(r.lead_id) + '" tabindex="0"' : ''; } }) + '</details>' +
      '<div class="row" style="margin-top:10px"><input class="input" data-smsto placeholder="+61412345678" style="max-width:200px"> <button class="btn-sm ghost" data-smstest>Send test text</button> <span class="muted" data-smsmsg></span></div></div>';
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-smstest]');
    if (!b) return;
    var to = document.querySelector('[data-smsto]').value, msg = document.querySelector('[data-smsmsg]');
    msg.textContent = 'Sending…';
    send('POST', 'sms/test', { to: to }).then(function (r) { msg.textContent = r && r.ok ? 'Sent ✓' : (r && r.error) || 'Failed'; });
  });

  // ───────────── SMS builder ─────────────
  var SMS_REL = {
    trigger: [{ v: 'after', label: 'after it happens' }],
    call: [{ v: 'before', label: 'before the call' }, { v: 'after', label: 'after the call starts' }],
    webinar: [{ v: 'before', label: 'before the webinar' }, { v: 'after', label: 'after the webinar starts' }],
  };
  var SMS_LINK_LABEL = { none: 'No link', join: 'Meeting link (join)', reschedule: 'Reschedule link', book: 'Booking page', apply: 'Application', breakout: 'Prep video page', webinar_room: 'Their webinar room', webinar_replay: 'Webinar replay' };
  var SMS_SKIP_LABEL = { applied: 'they’ve applied', booked: 'they’ve booked', confirmed: 'they replied C', attended: 'they came to the webinar', missed: 'they missed the webinar', clicked: 'they clicked an earlier text' };
  var SMS_TAGS = ['first_name', 'call_time', 'closer', 'link', 'webinar_time', 'site_name'];
  var SAMPLE = { first_name: 'Dana', call_time: 'Thursday 16 October, 10:00 am AEDT', closer: 'Josh Li', link: 'apply.grosfjeld-li.com/s/k3x9q2', webinar_time: 'Tuesday 20 October, 7:00 pm AEDT', site_name: 'G&L' };
  function smsPreview(body) {
    var t = String(body || '').replace(/\{(\w+)\}/g, function (m, k) { return SAMPLE[k] != null ? SAMPLE[k] : m; }).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-');
    return t;
  }
  function smsSegs(t) {
    var gsm = /^[\n\r @£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/.test(t), len = t.length;
    return gsm ? (len <= 160 ? 1 : Math.ceil(len / 153)) : (len <= 70 ? 1 : Math.ceil(len / 67));
  }
  // Same as waTemplateText() on the server: merge tags → {{1}}, {{2}}… in order; no variable at the very start/end.
  function waTpl(st) {
    var i = 0, body = st.link !== 'none' && st.body.indexOf('{link}') < 0 ? st.body + ' {link}' : st.body;
    var t = body.replace(/\{(\w+)\}/g, function () { return '{{' + (++i) + '}}'; }).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').trim();
    if (/^\{\{/.test(t)) t = 'Hi ' + t;
    if (/\}\}[.!?]?$/.test(t)) t = t + '\n\n- G&L';
    return t;
  }
  function waVars(st) {
    var body = st.link !== 'none' && st.body.indexOf('{link}') < 0 ? st.body + ' {link}' : st.body, out = [];
    body.replace(/\{(\w+)\}/g, function (m, k) { out.push('{{' + (out.length + 1) + '}} = ' + k); return m; });
    return out.join(' · ');
  }
  function splitOffset(min) {
    var a = Math.abs(min);
    if (a && a % 1440 === 0) return { v: a / 1440, unit: 'days' };
    if (a && a % 60 === 0) return { v: a / 60, unit: 'hours' };
    return { v: a, unit: 'minutes' };
  }
  var smsState = null;
  function renderSmsTab() {
    return Promise.all([api('sms/sequences', {}, { noRange: true }), api('sms', {}, { noRange: true }).catch(function () { return null; })]).then(function (r) {
      smsState = { data: r[0], status: r[1], seqs: JSON.parse(JSON.stringify(r[0].sequences)), sel: (smsState && smsState.sel) || 'booked', dirty: false };
      drawSms();
    });
  }
  function smsStat(seq, n) {
    var x = (smsState.data.stats || []).filter(function (s) { return s.sequence === seq && Number(s.step) === n; })[0];
    return x ? n_(x.sent) + ' sent · ' + n_(x.clicked) + ' clicked' + (x.pending ? ' · ' + n_(x.pending) + ' waiting' : '') + (x.skipped ? ' · ' + n_(x.skipped) + ' skipped' : '') : 'not sent yet';
  }
  function n_(v) { return n(v || 0); }
  function setupCard(st) {
    st = st || {};
    var ok = function (b) { return b ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>'; };
    return '<div class="card"><h2>Setup</h2><ol class="sms-setup">' +
      '<li>' + ok(st.configured) + ' <strong>Connect Twilio</strong>: copy the Account SID and Auth Token from console.twilio.com into <a href="#integrations">Integrations → SMS</a>.</li>' +
      '<li>' + ok(st.configured) + ' <strong>Pick the sender</strong> (“Send texts from”): an Australian mobile number from Twilio (it can receive replies, so STOP and “C” work), or a Messaging Service (<span class="mono">MG…</span>) with that number in it. A sender name like “GLAdvisory” can’t receive replies. US leads need a US number registered for A2P 10DLC.</li>' +
      '<li><strong>Point replies here</strong>: Twilio → your number → Messaging → “A message comes in” → <span class="mono">' + esc(st.webhook || '') + '</span> (HTTP POST). That’s how STOP, “C” to confirm and replies reach Funnel HQ.</li>' +
      '<li>' + ok(st.enabled) + ' <strong>Sending is ' + (st.enabled ? 'on' : 'paused') + '</strong> (SMS_ENABLED). ' + n_(st.consent && st.consent.consented) + ' people have agreed to texts · ' + n_(st.consent && st.consent.opted_out) + ' replied STOP · ' + n_(smsState.data.confirmed) + ' confirmed by text.</li>' +
      '<li><strong>Send yourself a test</strong>: <input class="input" data-smsto placeholder="+61412345678" style="max-width:190px;display:inline-block"> <button class="btn-sm ghost" data-smstest>Send test text</button> <span class="muted" data-smsmsg></span></li>' +
      '</ol>' + (st.configured ? '' : '<p class="muted">Until Twilio is connected, texts are simulated: they’re written and logged here but not sent.</p>') +
      waSetup(smsState.data.whatsapp || {}) + '</div>';
  }
  function waSetup(w) {
    var ok = function (b) { return b ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>'; };
    return '<h3 style="margin-top:14px">WhatsApp (optional)</h3><ol class="sms-setup">' +
      '<li>' + ok(w.configured) + ' <strong>Connect the WhatsApp Cloud API</strong>: Meta Business → WhatsApp → API setup. Paste the permanent token and phone number ID into <a href="#integrations">Integrations → WhatsApp</a>.</li>' +
      '<li>' + ok(w.signed) + ' <strong>Webhook</strong>: callback URL <span class="mono">' + esc(w.webhook || '') + '</span>, your verify token, subscribe to <span class="mono">messages</span>. Add the app secret so replies (STOP, “C”) are trusted.</li>' +
      '<li><strong>Templates</strong>: switch a sequence to “WhatsApp first”, then for each text click “Copy template text” and create it in WhatsApp Manager (category Utility for reminders, Marketing for nudges) with the same name. Once approved it sends on WhatsApp; until then it goes by SMS.</li>' +
      '<li>' + n_(w.reachable) + ' leads can get WhatsApp (they agreed or have messaged you) · ' + n_(w.sent) + ' WhatsApp messages sent. Template language: <span class="mono">' + esc(w.lang || 'en') + '</span>.</li></ol>';
  }
  function drawSms() {
    var S = smsState, d = S.data, seq = S.seqs.filter(function (x) { return x.id === S.sel; })[0];
    var list = S.seqs.map(function (x) {
      return '<button class="sms-seq' + (x.id === S.sel ? ' on' : '') + '" data-seq="' + esc(x.id) + '"><span class="dot ' + (x.enabled ? 'live' : '') + '"></span><strong>' + esc(d.triggers[x.id] || x.id) + '</strong><span class="muted">' + x.steps.length + ' text' + (x.steps.length === 1 ? '' : 's') + (x.enabled ? '' : ' · off') + '</span></button>';
    }).join('');
    var rel = SMS_REL;
    var cards = seq.steps.map(function (st, i) {
      var off = splitOffset(st.offsetMin), dir = st.offsetMin < 0 ? 'before' : 'after';
      var rels = (rel.trigger).map(function (r) { return { a: 'trigger', v: r.v, label: r.label }; });
      if (seq.id === 'booked' || seq.id === 'no_show' || seq.id === 'showed') rels = rels.concat(rel.call.map(function (r) { return { a: 'call', v: r.v, label: r.label }; }));
      if (seq.id === 'webinar') rels = rels.concat(rel.webinar.map(function (r) { return { a: 'webinar', v: r.v, label: r.label }; }));
      var relSel = '<select class="input" data-f="rel">' + rels.map(function (r) { var val = r.a + ':' + r.v; return '<option value="' + val + '"' + (st.anchor === r.a && (r.a === 'trigger' || r.v === dir) ? ' selected' : '') + '>' + esc(r.label) + '</option>'; }).join('') + '</select>';
      var prev = smsPreview(st.body);
      var segs = smsSegs(prev + (st.link !== 'none' && st.body.indexOf('{link}') < 0 ? ' ' + SAMPLE.link : ''));
      return '<div class="sms-step" draggable="true" data-i="' + i + '">' +
        '<div class="sms-row"><span class="grip" title="Drag to reorder">⋮⋮</span><span class="sms-n">Text ' + (i + 1) + '</span>' +
        '<input class="input" type="number" min="0" data-f="v" value="' + off.v + '" style="width:76px">' +
        '<select class="input" data-f="unit">' + ['minutes', 'hours', 'days'].map(function (u) { return '<option' + (u === off.unit ? ' selected' : '') + '>' + u + '</option>'; }).join('') + '</select>' + relSel +
        '<select class="input" data-f="link">' + d.links.map(function (l) { return '<option value="' + l + '"' + (l === st.link ? ' selected' : '') + '>' + esc(SMS_LINK_LABEL[l] || l) + '</option>'; }).join('') + '</select>' +
        '<button class="btn-sm ghost" data-dup title="Duplicate">⧉</button><button class="btn-sm ghost danger" data-del title="Delete">✕</button></div>' +
        '<textarea class="input sms-body" data-f="body" rows="3" maxlength="480">' + esc(st.body) + '</textarea>' +
        '<div class="sms-tags">' + SMS_TAGS.map(function (t) { return '<button class="chip" data-tag="' + t + '">{' + t + '}</button>'; }).join('') + '<span class="muted sms-count">' + prev.length + ' chars · ' + segs + ' SMS' + (segs > 2 ? ' (long)' : '') + '</span></div>' +
        '<div class="sms-preview"><span class="muted">Preview:</span> ' + esc(prev) + '</div>' +
        '<div class="sms-skip"><span class="muted">Skip this text if</span> ' + d.skips.map(function (k) { return '<label class="chip-check"><input type="checkbox" data-skip="' + k + '"' + (st.skip.indexOf(k) >= 0 ? ' checked' : '') + '> ' + esc(SMS_SKIP_LABEL[k] || k) + '</label>'; }).join('') + '</div>' +
        (seq.channel === 'whatsapp' ? '<div class="sms-wa"><span class="wa-badge">WhatsApp</span> template name <input class="input mono" data-f="wa" value="' + esc(st.wa || '') + '" placeholder="gl_' + esc(seq.id) + '_' + st.n + '" style="width:200px"> <button class="btn-sm ghost" data-copytpl>Copy template text</button> <span class="muted">' + esc(waVars(st)) + '</span>' +
          (st.wa ? '' : '<div class="muted">No template yet: goes by SMS unless they messaged you on WhatsApp in the last 24 hours.</div>') + '</div>' : '') +
        '<div class="sms-foot"><span class="muted">' + esc(smsStat(seq.id, st.n)) + '</span><button class="btn-sm ghost" data-testone>Send me this one</button></div></div>';
    }).join('');
    view.innerHTML = setupCard(S.status) +
      '<div class="sms-grid"><div class="sms-list card"><h2>Sequences</h2><p class="sub">One per moment in the funnel.</p>' + list + '</div>' +
      '<div class="card sms-editor"><div class="sms-head"><div><h2>' + esc(d.triggers[seq.id] || seq.id) + '</h2><p class="sub">Starts when this happens and stops by itself once it’s done its job (e.g. they book). Texts go out by their timing; drag to organise.</p></div>' +
      '<div class="row"><select class="input" data-channel title="How these messages are sent"><option value="sms"' + (seq.channel !== 'whatsapp' ? ' selected' : '') + '>Send by SMS</option><option value="whatsapp"' + (seq.channel === 'whatsapp' ? ' selected' : '') + '>WhatsApp first, SMS if not</option></select><label class="chip-check"><input type="checkbox" data-enabled' + (seq.enabled ? ' checked' : '') + '> On</label><button class="btn-sm ghost" data-reset>Reset to default</button><button class="btn-sm" data-save' + (S.dirty ? '' : ' disabled') + '>' + (S.dirty ? 'Save changes' : 'Saved') + '</button></div></div>' +
      '<div class="sms-palette"><span class="chip drag-new" draggable="true" data-new>＋ New text (drag into place)</span></div>' +
      '<div class="sms-steps" data-steps>' + (cards || '<div class="empty">No texts yet. Drag one in or click “Add text”.</div>') + '</div>' +
      '<button class="btn-sm ghost" data-add style="margin-top:10px">＋ Add text</button></div></div>';
    wireSms(seq);
  }
  function markDirty() { smsState.dirty = true; var b = view.querySelector('[data-save]'); if (b) { b.disabled = false; b.textContent = 'Save changes'; } }
  function wireSms(seq) {
    var S = smsState;
    view.querySelectorAll('[data-seq]').forEach(function (b) { b.onclick = function () { S.sel = b.getAttribute('data-seq'); drawSms(); }; });
    view.querySelector('[data-enabled]').onchange = function (e) { seq.enabled = e.target.checked; markDirty(); };
    view.querySelector('[data-channel]').onchange = function (e) { seq.channel = e.target.value; S.dirty = true; drawSms(); };
    view.querySelector('[data-reset]').onclick = function () {
      if (!confirm('Replace this sequence with the default texts? Unsaved changes are lost.')) return;
      var def = JSON.parse(JSON.stringify(S.data.defaults.filter(function (x) { return x.id === seq.id; })[0]));
      def.next = Math.max(def.next, seq.next);
      def.steps.forEach(function (st) { st.n = def.next++; }); // fresh numbers: earlier sends never collide
      S.seqs = S.seqs.map(function (x) { return x.id === seq.id ? def : x; });
      S.dirty = true; drawSms();
    };
    view.querySelector('[data-save]').onclick = function () {
      var b = this; b.disabled = true; b.textContent = 'Saving…';
      send('PUT', 'sms/sequences', { sequences: S.seqs }).then(function (r) {
        if (r && r.ok) { S.seqs = r.sequences; S.data.sequences = r.sequences; S.dirty = false; drawSms(); }
        else { b.disabled = false; b.textContent = 'Save changes'; alert((r && r.error) || 'Couldn’t save'); }
      });
    };
    var newStep = function () { return { n: seq.next++, body: 'Hi {first_name}, ', anchor: 'trigger', offsetMin: 60, link: 'none', skip: [] }; };
    view.querySelector('[data-add]').onclick = function () { seq.steps.push(newStep()); markDirty(); drawSms(); };
    view.querySelectorAll('.sms-step').forEach(function (card) {
      var i = Number(card.getAttribute('data-i')), st = seq.steps[i];
      var read = function () {
        var v = Math.max(0, Number(card.querySelector('[data-f="v"]').value) || 0), unit = card.querySelector('[data-f="unit"]').value;
        var rel = card.querySelector('[data-f="rel"]').value.split(':');
        var mins = v * (unit === 'days' ? 1440 : unit === 'hours' ? 60 : 1);
        st.anchor = rel[0]; st.offsetMin = rel[0] !== 'trigger' && rel[1] === 'before' ? -mins : mins;
        st.link = card.querySelector('[data-f="link"]').value;
        st.body = card.querySelector('[data-f="body"]').value;
        st.skip = Array.prototype.slice.call(card.querySelectorAll('[data-skip]:checked')).map(function (x) { return x.getAttribute('data-skip'); });
        var waIn = card.querySelector('[data-f="wa"]');
        if (waIn) { st.wa = waIn.value.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_'); var vv = card.querySelector('.sms-wa > .muted'); if (vv) vv.textContent = waVars(st); }
        var prev = smsPreview(st.body), segs = smsSegs(prev + (st.link !== 'none' && st.body.indexOf('{link}') < 0 ? ' ' + SAMPLE.link : ''));
        card.querySelector('.sms-preview').innerHTML = '<span class="muted">Preview:</span> ' + esc(prev);
        card.querySelector('.sms-count').textContent = prev.length + ' chars · ' + segs + ' SMS' + (segs > 2 ? ' (long)' : '');
        markDirty();
      };
      card.querySelectorAll('input, select, textarea').forEach(function (el) { el.addEventListener('input', read); el.addEventListener('change', read); });
      card.querySelectorAll('[data-tag]').forEach(function (b) {
        b.onclick = function () {
          var ta = card.querySelector('[data-f="body"]'), tag = '{' + b.getAttribute('data-tag') + '}', p = ta.selectionStart || ta.value.length;
          ta.value = ta.value.slice(0, p) + tag + ta.value.slice(ta.selectionEnd || p); ta.focus(); ta.selectionStart = ta.selectionEnd = p + tag.length; read();
        };
      });
      card.querySelector('[data-del]').onclick = function () { if (confirm('Delete this text? Any not-yet-sent copies are skipped.')) { seq.steps.splice(i, 1); markDirty(); drawSms(); } };
      card.querySelector('[data-dup]').onclick = function () { var c = JSON.parse(JSON.stringify(st)); c.n = seq.next++; seq.steps.splice(i + 1, 0, c); markDirty(); drawSms(); };
      var cp = card.querySelector('[data-copytpl]');
      if (cp) cp.onclick = function () {
        var t = waTpl(st);
        (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function () { cp.textContent = 'Copied ✓'; setTimeout(function () { cp.textContent = 'Copy template text'; }, 1500); }, function () { prompt('Copy this template text:', t); });
      };
      card.querySelector('[data-testone]').onclick = function () {
        var to = (view.querySelector('[data-smsto]') || {}).value || prompt('Your mobile, in international format (+61…):');
        if (!to) return;
        send('POST', 'sms/test-step', { to: to, step: st, channel: seq.channel || 'sms' }).then(function (r) { alert(r && r.ok ? 'Sent to ' + to : (r && r.error) || 'Failed'); });
      };
      // drag to reorder
      card.addEventListener('dragstart', function (e) { if (/TEXTAREA|INPUT|SELECT/.test(e.target.tagName)) { e.preventDefault(); return; } e.dataTransfer.setData('text/plain', 'move:' + i); card.classList.add('dragging'); });
      card.addEventListener('dragend', function () { card.classList.remove('dragging'); });
    });
    var box = view.querySelector('[data-steps]');
    var dropIndex = function (y) {
      var cards = Array.prototype.slice.call(box.querySelectorAll('.sms-step'));
      for (var k = 0; k < cards.length; k++) { var r = cards[k].getBoundingClientRect(); if (y < r.top + r.height / 2) return k; }
      return cards.length;
    };
    box.addEventListener('dragover', function (e) { e.preventDefault(); box.classList.add('over'); });
    box.addEventListener('dragleave', function () { box.classList.remove('over'); });
    box.addEventListener('drop', function (e) {
      e.preventDefault(); box.classList.remove('over');
      var what = e.dataTransfer.getData('text/plain'), to = dropIndex(e.clientY);
      if (what === 'new') seq.steps.splice(to, 0, newStep());
      else if (what.indexOf('move:') === 0) { var from = Number(what.slice(5)), item = seq.steps.splice(from, 1)[0]; seq.steps.splice(from < to ? to - 1 : to, 0, item); }
      else return;
      markDirty(); drawSms();
    });
    var pal = view.querySelector('[data-new]');
    pal.addEventListener('dragstart', function (e) { e.dataTransfer.setData('text/plain', 'new'); });
  }

  function renderEmails() {
    return Promise.all([api('emails'), api('triggers')]).then(function (res) {
      var d = res[0], tr = res[1];
      var tpl = d.templates || [], order = [], bySeq = {};
      tpl.forEach(function (r) {
        var k = r.sequence;
        if (!bySeq[k]) { bySeq[k] = { rows: [], sent: 0, simulated: 0, skipped: 0, failed: 0, opened: 0, clicked: 0 }; order.push(k); }
        var g = bySeq[k];
        g.rows.push(r);
        ['sent', 'simulated', 'skipped', 'failed', 'opened', 'clicked'].forEach(function (f) { g[f] += Number(r[f]) || 0; });
      });
      var totSent = tpl.reduce(function (t, r) { return t + (Number(r.sent) || 0); }, 0);
      var totSim = tpl.reduce(function (t, r) { return t + (Number(r.simulated) || 0); }, 0);
      // "Sent" counts simulated emails too, so "nothing really sent" is sent − simulated = 0.
      var allSimulated = totSim > 0 && totSent - totSim === 0;
      var emailCols = [{ label: 'Sequence', key: 'sequence' }, { label: '#', key: 'step', num: true, fmt: function (v) { return v + 1; } }, { label: 'Template', html: function (r) { return '<a href="/admin/api/email-preview/' + esc(r.template) + '" target="_blank" rel="noopener">' + esc(r.template) + ' ↗</a>'; } },
        { label: 'Sent (incl. simulated)', key: 'sent', num: true, fmt: n }, { label: 'Simulated', key: 'simulated', num: true, fmt: n }, { label: 'Skipped', key: 'skipped', num: true, fmt: n }, { label: 'Failed', key: 'failed', num: true, fmt: n },
        { label: 'Open rate', num: true, html: function (r) { return esc(pct(r.opened / (r.sent || 1))); } }, { label: 'Click rate', num: true, html: function (r) { return esc(pct(r.clicked / (r.sent || 1))); } }];
      var rules = (tr && tr.rules) || [], fails = d.failures || [];
      var fired = function (r) { return (Number(r.queued) || 0) > 0 || (Number(r.sent) || 0) > 0; };
      var firedRules = rules.filter(fired), quietRules = rules.filter(function (r) { return !fired(r); });
      var trigCols = [
        { label: 'Trigger', html: function (r) { var code = r.template + ' · sends ' + (r.delay ? r.delay + ' min after' : 'right away'); return '<div class="trig-name" title="' + esc(code) + '">' + esc(r.label) + '<div class="muted mono trig-code">' + esc(code) + '</div></div>'; } },
        { label: 'Fired', key: 'queued', num: true, fmt: n }, { label: 'Sent', key: 'sent', num: true, fmt: n },
        { label: 'Skipped', num: true, html: function (r) { return '<span class="muted" title="Condition no longer true when it was time to send (e.g. they booked)">' + n(r.skipped) + '</span>'; } },
        { label: 'Opened', num: true, html: function (r) { return esc(r.sent ? pct(r.opened / r.sent) : '–'); } },
        { label: 'Clicked', num: true, html: function (r) { return esc(r.sent ? pct(r.clicked / r.sent) : '–'); } },
        { label: 'Booked after', key: 'booked_after', num: true, fmt: n },
      ];
      // No failures: one calm line in the Queue card instead of an empty half-width card.
      var queueCard = '<div class="card"><div class="card-head wrap-head"><div><h2>Queue</h2><p class="sub">Scheduled and waiting for the 5-minute sender.</p></div>' +
        (fails.length ? '' : '<span class="calm-line"><span class="status-dot" style="background:var(--good)" aria-hidden="true"></span> No failed sends · retries 3× with back-off</span>') + '</div>' +
        table([{ label: 'Sequence', html: function (r) { return esc(seqLabel(r.sequence)); } }, { label: 'Pending', key: 'pending', num: true, fmt: n }, { label: 'Next send', html: function (r) { return esc(when(r.next_at)); } }], d.queue || []) + '</div>';
      var stat = function (label, val, cls, tip) { return '<span class="seq-stat' + (cls ? ' ' + cls : '') + '"' + (tip ? ' title="' + esc(tip) + '"' : '') + '><small>' + esc(label) + '</small>' + esc(val) + '</span>'; };
      var seqHtml = order.map(function (k) {
        var g = bySeq[k], steps = g.rows.length, desc = seqDesc(k);
        return '<details class="seq-group"' + (g.failed > 0 ? ' open' : '') + '><summary><span class="seq-name"' + (desc ? ' title="' + esc(desc) + '"' : '') + '><b>' + esc(seqLabel(k)) + '</b> <span class="muted">' + esc(steps + (steps === 1 ? ' email' : ' emails')) + '</span>' + (desc ? '<span class="seq-desc">' + esc(desc) + '</span>' : '') + '</span>' +
          stat('Sent for real', n(Math.max(0, g.sent - g.simulated)), '', 'Sent through Resend: all sends minus simulated ones (' + n(g.sent) + ' − ' + n(g.simulated) + ')') +
          stat('Simulated', n(g.simulated), '', 'Rendered and logged but not sent: no Resend key was connected') + stat('Skipped', n(g.skipped), '', 'Not sent because it no longer applied (e.g. they booked)') + stat('Failed', n(g.failed), g.failed > 0 ? 'seq-failed' : '', 'Failed after 3 retries') +
          stat('Open rate', g.sent ? pct(g.opened / g.sent) : '–', '', 'Opened ÷ all sends, simulated included') + stat('Click rate', g.sent ? pct(g.clicked / g.sent) : '–', '', 'Clicked ÷ all sends, simulated included') + '</summary>' +
          table(emailCols, g.rows) + '</details>';
      }).join('');
      view.innerHTML =
        (allSimulated ? '<div class="card notice" style="margin-bottom:14px">Emails are simulated: no Resend key yet, so nothing is actually sent and open/click rates show once it’s connected. <a href="#integrations" data-go="integrations">Connect it in Integrations →</a></div>' : '') +
        '<div class="card" style="margin-bottom:14px"><h2>Behaviour-triggered emails</h2><p class="sub">' + esc('One email when someone does something specific on the page, written for them from what they did. Each fires once per person; at most 8 emails a day to anyone in total; re-checked right before sending. · ' + n(firedRules.length) + ' of ' + n(rules.length) + ' fired in this range') + '</p>' +
        (firedRules.length ? table(trigCols, firedRules, { cards: 3 }) : emptyState('None of the ' + n(rules.length) + ' triggers has fired in this range yet.')) +
        (quietRules.length ? '<details class="more-rows"><summary>' + esc('Show the other ' + quietRules.length + (quietRules.length === 1 ? ' trigger that hasn’t' : ' triggers that haven’t') + ' fired yet') + '</summary>' + table(trigCols, quietRules, { cards: 3 }) + '</details>' : '') + '</div>' +
        (fails.length ? '<div class="grid g-2" style="margin-bottom:14px">' + queueCard + '<div class="card"><h2>Recent failures · ' + esc(n(fails.length)) + '</h2><p class="sub">Retries 3× with back-off before failing.</p>' + table([{ label: 'Template', key: 'template' }, { label: 'To', key: 'to_email' }, { label: 'Error', key: 'error' }], fails) + '</div></div>'
          : '<div style="margin-bottom:14px">' + queueCard + '</div>') +
        '<div class="card"><h2>By email</h2><p class="sub">“Simulated” means no Resend key was connected — the email was rendered and logged but not sent. Click a sequence to see each email.</p>' +
        (order.length ? '<div class="seq-list">' + seqHtml + '</div>' : emptyState('No data in this range yet.')) + '</div>';
    });
  }
  /** Readable sequence name: its name in config if it has one, else the key ("tier_a" → "Tier A"). */
  function seqLabel(k) {
    var list = state.meta && Array.isArray(state.meta.sequences) ? state.meta.sequences : [];
    var x = list.filter(function (s) { return s && (s.id === k || s.key === k); })[0];
    if (x && (x.name || x.label)) return String(x.name || x.label);
    var t = String(k == null ? '' : k).replace(/_/g, ' ').replace(/\b([a-z])\b/g, function (c) { return c.toUpperCase(); });
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  function seqDesc(k) {
    var list = state.meta && Array.isArray(state.meta.sequences) ? state.meta.sequences : [];
    var x = list.filter(function (s) { return s && (s.id === k || s.key === k); })[0];
    return x && x.description ? String(x.description).replace(/\s*\(see [^)]*\)/g, '') : ''; // drop code pointers like "(see personalize/triggers.ts)"
  }

  function renderLive() {
    function draw() {
      return api('live', {}, { noRange: true }).then(function (d) {
        view.innerHTML =
          '<div class="grid g-3">' + tile('Active right now', n(d.active), 'Visitors in the last 5 minutes') + '<div class="card" style="grid-column:span 2"><h2>Pages being viewed</h2>' + (d.pages.length ? barList(d.pages.map(function (p) { return { name: p.path, value: p.n }; })) : '<p class="muted">Nobody on the site right now.</p>') + '</div></div>' +
          '<div class="card" style="margin-top:14px"><h2>Activity stream</h2>' + table([
            { label: 'When', html: function (e) { return '<span title="' + esc(when(e.ts)) + '">' + esc(ago(e.ts)) + '</span>'; } },
            { label: 'Event', html: function (e) { return '<strong>' + esc(EVENT_LABELS[e.name] || e.name) + '</strong> <span class="muted">' + esc(e.path || '') + '</span>'; } },
            { label: 'Who', html: function (e) { return e.lead_id ? '<a href="#lead=' + esc(e.lead_id) + '" data-open="' + esc(e.lead_id) + '">' + esc([e.first_name, e.last_name].filter(Boolean).join(' ') || 'lead') + '</a>' + (e.tier ? ' <span class="tier ' + esc(e.tier) + '">' + esc(e.tier) + '</span>' : '') : '<span class="muted">anonymous</span>'; } },
            { label: 'Where', html: function (e) { return esc([e.city, e.country].filter(Boolean).join(', ')); } },
            { label: 'Source', html: function (e) { return esc(e.channel || '') + (e.utm_campaign ? ' <span class="muted">' + esc(e.utm_campaign) + '</span>' : ''); } },
            { label: 'Device', key: 'device' },
          ], d.events, { feed: true }) + '</div>';
        view.querySelectorAll('[data-open]').forEach(function (a) { a.onclick = function (ev) { ev.preventDefault(); openLead(a.getAttribute('data-open')); }; });
        view.querySelectorAll('[data-lead]').forEach(function (row) { row.onclick = function () { openLead(row.getAttribute('data-lead')); }; });
      });
    }
    liveTimer = setInterval(function () { if (!document.hidden && !document.querySelector('.drawer')) draw(); }, 5000);
    return draw();
  }

  var openSettings = null; // settings groups left open across a save (Integrations)
  function renderIntegrations() {
    return fetch('/admin/api/integrations', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
      var groups = {};
      d.settings.forEach(function (s) { (groups[s.group] = groups[s.group] || []).push(s); });
      var groupNames = Object.keys(groups);
      var slug = function (g) { return String(g).toLowerCase().replace(/[^a-z0-9]+/g, '-'); };
      // Status tile → the settings group that configures it (case-insensitive; tried with the key, then the label).
      var TILE_GROUP = { email: 'Email', whatsapp: 'WhatsApp', voice: 'Voice', 'voice agent': 'Voice', aicalls: 'Voice', 'ai calls (elevenlabs)': 'Voice', booking: 'Booking', calendly: 'Booking', analytics: 'Analytics', posthog: 'Analytics', ga4: 'Analytics', meta: 'Ads', alerts: 'Alerts', slack: 'Alerts', 'team pings': 'Alerts', crm: 'Alerts', 'crm webhook': 'Alerts', video: 'Video' };
      var findGroup = function (name) {
        if (!name) return null;
        var want = String(TILE_GROUP[String(name).toLowerCase()] || name).toLowerCase();
        return groupNames.filter(function (g) { return g.toLowerCase() === want; })[0] || null;
      };
      view.innerHTML =
        '<div class="card"><h2>Status</h2><p class="sub">Click a service to jump to its settings.</p><div class="int-grid" style="margin-top:10px">' + Object.keys(d.status).map(function (k) {
          var s = d.status[k];
          var g = findGroup(k) || findGroup(s.label);
          return '<div class="int' + (g ? ' click" role="button" tabindex="0" data-set-jump="' + esc(slug(g)) + '" title="' + esc('Open ' + g + ' settings') : '') + '"><span class="badge">' + (s.connected ? '<span class="status-dot" style="background:var(--good)" aria-hidden="true"></span>' : '<span class="status-dot" style="background:var(--axis)" aria-hidden="true"></span>') + '</span><div><b>' + esc(s.label || k) + ' · ' + (s.connected ? 'connected' : 'not connected') + '</b><span>' + esc(s.detail) + '</span></div></div>';
        }).join('') + '</div></div>' +
        '<div class="card" style="margin-top:14px"><div class="card-head"><div><h2>Calendly</h2><p class="sub">With the personal access token connected: exact call times the moment someone books, meeting links in the reminders, the host mapped to your closer, their booking answers, a signed webhook (bookings, cancellations, reschedules, no-shows) and an hourly sync. Calls booked straight from the Calendly link are imported for the sales numbers only; they get no emails.</p></div></div>' +
        '<div class="row"><button class="btn-sm" data-cal-connect>Connect webhook &amp; import</button><button class="btn-sm ghost" data-cal-sync>Sync now</button><button class="btn-sm ghost" data-cal-history>Import full history</button><span class="muted" data-cal-out></span></div></div>' +
        '<div class="grid g-2" style="margin-top:14px"><div class="card"><h2>Test email</h2><p class="sub">Sends a test through Resend to confirm the key, domain and From address.</p><div class="row"><input class="input" type="email" placeholder="you@company.com" data-test-to style="flex:1"><button class="btn-sm" data-test>Send test</button></div></div>' +
        '<div class="card"><h2>Webhook URLs</h2><p class="sub">Paste these into each provider.</p><dl class="kv">' + kv('Calendly', d.webhooks.calendly) + kv('Cal.com / GHL / Zapier', d.webhooks.booking) + kv('WhatsApp Cloud API', d.webhooks.whatsapp) + kv('Vapi (voice) Server URL', d.webhooks.voice) + '</dl></div></div>' +
        '<div class="card" style="margin-top:14px"><div class="card-head"><div><h2>Voice assistant</h2><p class="sub">Creates (or updates) the inbound assistant in your Vapi account from the copy, FAQs and rules in config. Save your Vapi keys and webhook secret first. Then in Vapi, set your phone number’s Server URL to the voice URL above and leave its assistant empty.</p></div><div class="row"><a class="btn-sm ghost" href="/admin/api/voice/assistant.json" target="_blank" rel="noopener">View JSON</a><button class="btn-sm" type="button" data-provision>Create / update assistant</button></div></div></div>' +
        '<form class="card" style="margin-top:14px" data-settings><div class="card-head sticky-head"><div><h2>Keys & settings</h2><p class="sub">Values set as Worker secrets/vars are locked here (they always win). Secrets are never shown — leave a masked field blank to keep it, type “-” to clear it.</p></div><button class="btn-sm" type="submit">Save changes</button></div>' +
        '<div class="set-jump">' + groupNames.map(function (g) { return '<a href="#integrations" data-set-jump="' + esc(slug(g)) + '">' + esc(g) + '</a>'; }).join('') + '</div>' +
        groupNames.map(function (g, gi) {
          var list = groups[g];
          var x = list.filter(function (s) { return (s.source && s.source !== '' && s.source !== 'unset') || s.value; }).length, y = list.length;
          return '<details class="settings-group" id="set-' + esc(slug(g)) + '"' + ((openSettings ? openSettings.indexOf(slug(g)) !== -1 : gi === 0) ? ' open' : '') + '><summary><h3>' + esc(g) + '</h3><span class="pill' + (x === y ? ' st-won' : '') + '">' + x + ' of ' + y + ' set</span></summary>' + list.map(function (s) {
            var locked = s.source === 'env';
            return '<div class="setting"><div><label for="s_' + esc(s.key) + '">' + esc(s.label) + '</label>' + (s.help ? '<div class="help">' + esc(s.help) + '</div>' : '') + '</div><div><input id="s_' + esc(s.key) + '" name="' + esc(s.key) + '" ' + (s.secret ? 'type="password" autocomplete="new-password" placeholder="' + esc(s.value ? s.value + ' (saved)' : (s.placeholder || '')) + '" value=""' : 'value="' + esc(s.value) + '" placeholder="' + esc(s.placeholder || '') + '"') + (locked ? ' disabled' : '') + '><div class="src">' + (locked ? 'Set via Worker environment' : s.source === 'dashboard' ? 'Saved in dashboard' : 'Not set') + ' · <span class="mono">' + esc(s.key) + '</span></div></div></div>';
          }).join('') + '</details>';
        }).join('') + '<div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn-sm" type="submit">Save changes</button></div></form>';
      openSettings = null;

      var jumpTo = function (key) {
        var el = document.getElementById('set-' + key);
        if (!el) return;
        el.open = true;
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
      view.querySelectorAll('[data-set-jump]').forEach(function (a) {
        a.onclick = function (ev) { ev.preventDefault(); jumpTo(a.getAttribute('data-set-jump')); };
        if (a.tagName !== 'A') a.onkeydown = function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); jumpTo(a.getAttribute('data-set-jump')); } };
      });

      view.querySelector('[data-provision]').onclick = function () {
        send('POST', 'voice/provision', {}).then(function (r) { toast(r.ok ? 'Assistant ' + (r.created ? 'created' : 'updated') + ' ✓' : (r.error || 'Failed')); if (r.ok) load(); });
      };
      var calOut = view.querySelector('[data-cal-out]');
      var calDone = function (r) { calOut.textContent = r.ok ? ((r.name ? 'Connected as ' + r.name + ' · ' : '') + (r.sync ? r.sync.events + ' events checked, ' + r.sync.updated + ' updated, ' + r.sync.imported + ' imported, ' + r.sync.cancelled + ' cancelled' : 'synced')) : (r.error || 'Failed'); };
      view.querySelector('[data-cal-connect]').onclick = function () { calOut.textContent = 'Connecting…'; send('POST', 'calendly/connect', {}).then(calDone); };
      view.querySelector('[data-cal-history]').onclick = function () {
        var b = this, tot = { events: 0, imported: 0, updated: 0, cancelled: 0 };
        b.disabled = true;
        (function step(cursor) {
          send('POST', 'calendly/import', { cursor: cursor }).then(function (r) {
            if (!r.ok) { calOut.textContent = r.error || 'Failed'; b.disabled = false; return; }
            ['events', 'imported', 'updated', 'cancelled'].forEach(function (k) { tot[k] += r[k] || 0; });
            calOut.textContent = (r.next ? 'Importing… ' : 'Done: ') + tot.events + ' bookings, ' + tot.imported + ' new people, ' + tot.updated + ' updated';
            if (r.next) step(r.next); else b.disabled = false;
          });
        })(null);
      };
      view.querySelector('[data-cal-sync]').onclick = function () { calOut.textContent = 'Syncing…'; send('POST', 'calendly/sync', {}).then(calDone); };
      view.querySelector('[data-test]').onclick = function () {
        send('POST', 'integrations/test-email', { to: view.querySelector('[data-test-to]').value }).then(function (r) { toast(r.ok ? 'Test email sent ✓' : (r.error || 'Failed')); });
      };
      view.querySelector('[data-settings]').onsubmit = function (e) {
        e.preventDefault();
        var body = {};
        d.settings.forEach(function (s) {
          var input = e.target.elements[s.key];
          if (!input || input.disabled) return;
          var v = input.value;
          if (s.secret) { if (v === '-') body[s.key] = ''; else if (v) body[s.key] = v; }
          else if (v !== s.value) body[s.key] = v;
        });
        // Keep the groups that were open, so the page doesn't jump back to the top after saving.
        openSettings = [].map.call(view.querySelectorAll('details.settings-group[open]'), function (x) { return x.id.slice(4); });
        send('PUT', 'integrations', body).then(function () { toast('Saved'); load(); });
      };
    });
  }

  // ───────────── filters, nav, theme ─────────────
  function populateFilters() {
    var r = range();
    var base = '/admin/api/attribution?from=' + r.from + '&to=' + r.to + '&dim=';
    ['channel', 'campaign', 'variant'].forEach(function (dim) {
      fetch(base + dim, { credentials: 'same-origin' }).then(function (x) { return x.json(); }).then(function (d) {
        var sel = document.querySelector('[data-filter="' + dim + '"]');
        var cur = sel.value;
        var first = sel.options[0].outerHTML;
        sel.innerHTML = first + (d.rows || []).filter(function (row) { return row.key !== '(none)'; }).map(function (row) { return '<option value="' + esc(row.key) + '">' + esc(row.key) + '</option>'; }).join('');
        sel.value = cur;
        sel.title = sel.value ? sel.options[sel.selectedIndex].text : '';
        updateFilterCue();
      }).catch(function () {});
    });
  }

  document.querySelectorAll('[data-range] button').forEach(function (b) {
    b.onclick = function () {
      state.days = +b.getAttribute('data-days');
      document.querySelectorAll('[data-range] button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      populateFilters();
      load();
    };
  });
  document.querySelectorAll('[data-filter]').forEach(function (sel) {
    sel.onchange = function () {
      state.filters[sel.getAttribute('data-filter')] = sel.value;
      sel.title = sel.value ? sel.options[sel.selectedIndex].text : '';
      updateFilterCue();
      load();
    };
  });
  document.querySelector('[data-clear]').onclick = function () {
    state.filters = {};
    if (state.tab === 'leads') { state.leadsQuery.tier = ''; state.leadsQuery.status = ''; state.leadsQuery.q = ''; state.leadsQuery.page = 0; state.leadsQuery._focus = false; }
    document.querySelectorAll('[data-filter]').forEach(function (s) { s.value = ''; s.title = ''; });
    updateFilterCue();
    load();
  };
  document.querySelectorAll('[data-nav] button').forEach(function (b) { b.onclick = function () { go(b.getAttribute('data-tab')); }; });

  // Phone: the ☰ button opens the grouped nav as a sheet; picking a tab (go) or Escape closes it.
  if (navToggleEl) navToggleEl.onclick = function () { setNavOpen(!document.body.classList.contains('nav-open')); };
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && document.body.classList.contains('nav-open')) { setNavOpen(false); navToggleEl.focus(); } });

  // One handler for every in-app link: data-go="<tab>" switches tab, data-open="<lead id>" opens the lead drawer.
  // Per-tab onclick bindings that already handled the click call preventDefault, so they never fire twice.
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest && e.target.closest('[data-go],[data-open]');
    if (!a) return;
    if (!(view.contains(a) || a.closest('.drawer') || a.closest('[data-attention]') || a.closest('.side'))) return;
    e.preventDefault();
    if (a.hasAttribute('data-open')) { openLead(a.getAttribute('data-open')); return; }
    if (a.hasAttribute('data-tier') || a.hasAttribute('data-status')) {
      // A to-do chip opens Leads with exactly that filter (and nothing left over from earlier).
      state.leadsQuery.tier = a.getAttribute('data-tier') || '';
      state.leadsQuery.status = a.getAttribute('data-status') || '';
      state.leadsQuery.q = '';
      state.leadsQuery.page = 0;
    }
    go(a.getAttribute('data-go'));
  });
  addEventListener('hashchange', route);
  addEventListener('popstate', route);

  // Sidebar "Find a lead": from any tab, Enter opens Leads filtered to what was typed (and only that). "/" jumps to the box.
  var navSearch = document.querySelector('[data-nav-search]');
  if (navSearch) {
    var navSearchIn = navSearch.querySelector('input');
    navSearch.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = navSearchIn.value.trim();
      state.leadsQuery.q = v; state.leadsQuery.tier = ''; state.leadsQuery.status = ''; state.leadsQuery.page = 0;
      // Finding a lead means every lead: all time, all channels (the bar then reads "All time", so it's clear why).
      if (v) {
        var allBtn = filtersEl.querySelector('[data-range] button[data-days="3650"]');
        if (state.days !== 3650 && allBtn) {
          state.days = 3650;
          filtersEl.querySelectorAll('[data-range] button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === allBtn)); });
          populateFilters();
        }
        state.filters.channel = '';
        var chSel = filtersEl.querySelector('select[data-filter="channel"]');
        if (chSel) { chSel.value = ''; chSel.title = ''; }
      }
      navSearchIn.value = '';
      navSearchIn.blur();
      go('leads'); // go() keeps q, resets _focus and loads the list
      state.leadsQuery._focus = true; // the list renders after the fetch, so the Leads search box gets the focus, showing the query
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('.drawer')) return;
      var a = document.activeElement;
      if (a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable)) return;
      e.preventDefault();
      if (navToggleEl && getComputedStyle(navToggleEl).display !== 'none') setNavOpen(true); // phone: the box lives in the nav sheet
      navSearchIn.focus();
    });
  }

  /** Small count on a nav item (e.g. calls waiting for an outcome on Calls & deals). */
  function setNavBadge(key, count) {
    var el = document.querySelector('[data-nav-badge="' + key + '"]');
    if (!el) return;
    count = count || 0;
    el.textContent = count > 99 ? '99+' : String(count);
    el.hidden = !count;
    el.title = count ? count + (count === 1 ? ' call needs' : ' calls need') + ' an outcome' : '';
  }

  var themeBtn = document.querySelector('[data-theme-toggle]');
  var themes = ['auto', 'light', 'dark'];
  function applyTheme(t) {
    if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
    themeBtn.textContent = 'Theme: ' + t;
    try { localStorage.setItem('admin_theme', t); } catch (e) { /* ignore */ }
  }
  var savedTheme = 'auto';
  try { savedTheme = localStorage.getItem('admin_theme') || 'auto'; } catch (e) { /* ignore */ }
  applyTheme(savedTheme);
  themeBtn.onclick = function () { applyTheme(themes[(themes.indexOf(themeBtn.textContent.replace('Theme: ', '')) + 1) % 3]); if (state.tab !== 'integrations') load(); };

  var navEl = document.querySelector('[data-nav]');
  if (navEl) navEl.addEventListener('scroll', updateNavFade, { passive: true });
  addEventListener('resize', updateNavFade);

  var resizeT;
  addEventListener('resize', function () { clearTimeout(resizeT); resizeT = setTimeout(function () { if (['overview', 'vsl', 'application'].indexOf(state.tab) !== -1) load(); }, 250); });

  fetch('/admin/api/meta', { credentials: 'same-origin' }).then(function (r) { if (r.status === 401) location.href = '/admin/login'; return r.json(); }).then(function (meta) {
    state.meta = meta;
    populateFilters();
    var h = location.hash.slice(1);
    if (h.indexOf('lead=') === 0) { routing = true; go('leads'); routing = false; openLead(decodeURIComponent(h.slice(5)), { fromRoute: true }); }
    else go(h || 'overview', { replace: true });
    lastHash = location.hash;
    markEntry();
    if (state.tab !== 'overview' && state.tab !== 'sales') api('sales').then(function (d) { setNavBadge('sales', d && d.needsOutcome ? d.needsOutcome.length : 0); }).catch(function () {});
  });
})();
