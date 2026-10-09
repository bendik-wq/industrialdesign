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
    return '<div class="bars ' + (o.cls || '') + '">' + rows.map(function (r) {
      var w = Math.max(r.value ? 0.4 : 0, (r.value / max) * 100);
      return '<div class="bar-row"><div class="name" title="' + esc(r.name) + '">' + esc(r.name) + '</div><div class="bar-track"><div class="bar-fill" style="width:calc(' + w.toFixed(2) + '% - 70px)' + (r.color ? ';background:' + r.color : '') + '"></div><span class="bar-val">' + esc((o.fmt || n)(r.value)) + (r.note ? '<small>' + esc(r.note) + '</small>' : '') + '</span></div></div>' +
        (r.rate != null ? '<div class="bar-row"><span></span><p class="step-rate">↓ ' + esc(r.rate) + '</p></div>' : '');
    }).join('') + '</div>';
  }

  function tile(label, value, hint) {
    return '<div class="tile"><div class="label">' + esc(label) + '</div><div class="value">' + esc(value) + '</div>' + (hint ? '<div class="hint">' + esc(hint) + '</div>' : '') + '</div>';
  }

  function tierStack(a, b, c) {
    var t = a + b + c || 1;
    return '<div class="stack" role="img" aria-label="Tier A ' + a + ', B ' + b + ', C ' + c + '">' +
      [['A', a, '--tier-a'], ['B', b, '--tier-b'], ['C', c, '--tier-c']].filter(function (x) { return x[1]; }).map(function (x) {
        return '<span title="Tier ' + x[0] + ': ' + x[1] + '" style="flex:' + x[1] / t + ';background:var(' + x[2] + ')"></span>';
      }).join('') + '</div><div class="legend"><span><i style="background:var(--tier-a)"></i>A · qualified ' + n(a) + ' (' + pct(a / t) + ')</span><span><i style="background:var(--tier-b)"></i>B · mid-fit ' + n(b) + ' (' + pct(b / t) + ')</span><span><i style="background:var(--tier-c)"></i>C · nurture ' + n(c) + ' (' + pct(c / t) + ')</span></div>';
  }

  function table(cols, rows, o) {
    o = o || {};
    if (!rows.length) return '<div class="empty">No data in this range yet.</div>';
    return '<div class="table-wrap"><table><thead><tr>' + cols.map(function (c) { return '<th class="' + (c.num ? 'num' : '') + '">' + esc(c.label) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr' + (o.rowAttr ? ' ' + o.rowAttr(r) : '') + '>' + cols.map(function (c) { return '<td class="' + (c.num ? 'num' : '') + '">' + (c.html ? c.html(r) : esc(c.fmt ? c.fmt(r[c.key], r) : r[c.key])) + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  // ───────────── tabs ─────────────
  var TABS = {
    overview: { title: 'Overview', sub: 'Every step from ad click to closed deal.', render: renderOverview },
    vsl: { title: 'VSL analytics', sub: 'Who watches, where they drop, and when they reach the pitch.', render: renderVsl },
    traffic: { title: 'Traffic & ads', sub: 'Which sources, campaigns and ads produce qualified leads — not just clicks.', render: renderTraffic },
    application: { title: 'Application', sub: 'Step drop-off, answers and lead scoring.', render: renderApplication },
    experiments: { title: 'A/B tests', sub: 'Headline experiment, judged on applications per visitor.', render: renderExperiments },
    leads: { title: 'Leads', sub: 'Every applicant, scored and routed. Click a row for their full journey.', render: renderLeads },
    emails: { title: 'Emails', sub: 'Sequences, deliverability and engagement.', render: renderEmails },
    voice: { title: 'Voice agent', sub: 'Inbound AI calls: phone and in-browser. Transcripts, recordings and what callers asked for.', render: renderVoice },
    live: { title: 'Live', sub: 'Real-time activity across the funnel (refreshes every 5 seconds).', render: renderLive, noFilters: true },
    integrations: { title: 'Integrations', sub: 'Connect email, WhatsApp, calendars, analytics and ad platforms.', render: renderIntegrations, noFilters: true },
  };

  function go(tab) {
    if (!TABS[tab]) tab = 'overview';
    state.tab = tab;
    clearInterval(liveTimer);
    document.querySelectorAll('[data-nav] button').forEach(function (b) { b.setAttribute('aria-current', b.getAttribute('data-tab') === tab ? 'page' : 'false'); });
    titleEl.textContent = TABS[tab].title;
    subtitleEl.textContent = TABS[tab].sub;
    filtersEl.style.display = TABS[tab].noFilters ? 'none' : '';
    if (location.hash.indexOf('#lead=') !== 0) history.replaceState(null, '', '#' + tab);
    load();
  }

  function load() {
    document.body.classList.add('loading');
    Promise.resolve(TABS[state.tab].render()).catch(function (e) { console.error(e); view.innerHTML = '<div class="empty">Couldn’t load this view. ' + esc(e.message) + '</div>'; })
      .then(function () { document.body.classList.remove('loading'); });
  }

  function renderOverview() {
    return api('overview').then(function (d) {
      var k = d.kpis;
      var funnelRows = d.funnel.map(function (s, i) {
        var prev = i ? d.funnel[i - 1].n : 0;
        return { name: s.label, value: s.n, note: i ? pct(d.funnel[0].n ? s.n / d.funnel[0].n : 0) + ' of landing' : '', rate: i < d.funnel.length - 1 && s.n ? pct(d.funnel[i + 1].n / s.n) + ' continue' : null, _prev: prev };
      });
      view.innerHTML =
        '<div class="grid g-4">' +
        tile('Visitors', n(k.visitors), n(k.sessions) + ' sessions · ' + pct(k.bounce_rate) + ' bounce') +
        tile('VSL play rate', pct(k.play_rate), pct(k.unmute_rate) + ' unmuted · avg ' + pct(k.avg_watch_pct) + ' watched') +
        tile('Applications', n(k.applications), n(k.leads) + ' leads · ' + pct(k.app_completion_rate) + ' finish the form') +
        tile('Calls booked', n(k.booked), pct(k.booking_rate) + ' of qualified · ' + pct(k.show_rate) + ' show rate') +
        '</div><div class="grid g-4" style="margin-top:14px">' +
        tile('Opt-in rate', pct(k.opt_in_rate, 1), 'Contact details / landing visitors') +
        tile('Pitch reached', pct(k.pitch_rate), 'Of plays reach the CTA moment') +
        tile('Revenue', money(k.revenue), n(k.won) + ' won · ' + money(k.revenue_per_visitor) + ' / visitor') +
        tile('WhatsApp', n(k.whatsapp_clicks) + ' clicks', n(k.whatsapp_connected) + ' connected via ref code') +
        '</div>' +
        '<div class="grid g-2" style="margin-top:14px">' +
        '<div class="card"><h2>Funnel</h2><p class="sub">Unique people reaching each step in this range.</p>' + barList(funnelRows, { cls: 'funnel' }) + '</div>' +
        '<div class="grid"><div class="card"><h2>Lead quality</h2><p class="sub">Applications by routing tier · average score ' + n(k.avg_score) + '</p>' + tierStack(k.tier_a, k.tier_b, k.tier_c) + '</div>' +
        '<div class="card"><h2>Email</h2><p class="sub">' + n(k.emails_sent) + ' sent in range</p><div class="grid g-2">' + tile('Open rate', pct(k.email_open_rate), 'Apple MPP inflates opens') + tile('Click rate', pct(k.email_click_rate)) + '</div></div></div>' +
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
        '<div class="grid g-4">' + tile('Views (with sound)', n(s.views), n(s.viewers) + ' unique viewers') + tile('Avg watched', pct(s.avg_pct), secs(s.avg_seconds) + ' average watch time') +
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
      var maxQ = Math.max.apply(null, rows.map(function (r) { return r.qualified_rate; }).concat([0.0001]));
      view.innerHTML =
        '<div class="row" style="margin-bottom:12px"><label class="muted" for="dim">Break down by</label><select id="dim" class="input" data-dim>' + dims.map(function (x) { return '<option value="' + esc(x.key) + '"' + (x.key === dim ? ' selected' : '') + '>' + esc(x.label) + '</option>'; }).join('') + '</select><span class="spacer"></span><span class="muted">Leads are attributed to their last non-direct touch before applying.</span></div>' +
        '<div class="card">' + table([
          { label: d.label, html: function (r) { return '<strong>' + esc(r.key) + '</strong>'; } },
          { label: 'Visitors', key: 'visitors', num: true, fmt: n },
          { label: 'Bounce', key: 'bounce_rate', num: true, fmt: function (v) { return pct(v); } },
          { label: 'Engaged', key: 'avg_engaged_s', num: true, fmt: secs },
          { label: 'Leads', key: 'leads', num: true, fmt: n },
          { label: 'Apps', key: 'applications', num: true, fmt: n },
          { label: 'Qualified', key: 'qualified', num: true, fmt: n },
          { label: 'Qualified / visitor', num: true, html: function (r) { return esc(pct(r.qualified_rate, 1)) + '<span class="inbar" style="width:' + Math.round((r.qualified_rate / maxQ) * 50) + 'px"></span>'; } },
          { label: 'Avg score', key: 'avg_score', num: true, fmt: n },
          { label: 'Booked', key: 'booked', num: true, fmt: n },
          { label: 'Showed', key: 'showed', num: true, fmt: n },
          { label: 'Won', key: 'won', num: true, fmt: n },
          { label: 'Revenue', key: 'revenue', num: true, fmt: money },
          { label: 'Rev / visitor', key: 'revenue_per_visitor', num: true, fmt: money },
        ], rows) + '</div>' +
        '<p class="muted" style="margin-top:10px">Tip: tag ads with <span class="mono">utm_source</span>, <span class="mono">utm_campaign</span>, <span class="mono">utm_content={{ad.name}}</span> and <span class="mono">ad_id={{ad.id}}</span> to see quality per ad.</p>';
      view.querySelector('[data-dim]').onchange = function (e) { state.dim = e.target.value; load(); };
    });
  }

  function renderApplication() {
    return api('application').then(function (d) {
      var first = d.page_views || d.started || 1;
      var stepRows = [{ name: 'Viewed the application', value: d.page_views }].concat(d.steps.map(function (s) { return { name: s.step + '. ' + s.title, value: s.reached, note: pct(s.reached / first) }; }));
      view.innerHTML =
        '<div class="grid g-4">' + tile('Viewed', n(d.page_views)) + tile('Started (contact given)', n(d.started), pct(d.started / (d.page_views || 1)) + ' of viewers') + tile('Completed', n(d.completed), pct(d.completed / (d.started || 1)) + ' of starters') +
        tile('Closer split', d.closers.map(function (c) { return c.name.split(' ')[0] + ' ' + c.leads; }).join(' · ') || '–') + '</div>' +
        '<div class="grid g-2" style="margin-top:14px"><div class="card"><h2>Step drop-off</h2><p class="sub">People who reached each question.</p>' + barList(stepRows) + '</div>' +
        '<div class="grid"><div class="card"><h2>Score distribution</h2><p class="sub">Completed applications by score. A ≥ 70, B ≥ 40.</p><div class="chart" data-hist></div></div>' +
        '<div class="card"><h2>Tier caps applied</h2><p class="sub">Hard rules that lowered a lead’s tier.</p>' + table([{ label: 'Reason', key: 'reason' }, { label: 'Leads', key: 'n', num: true, fmt: n }], d.caps) + '</div></div></div>' +
        '<h3 class="section-title">Answers</h3><div class="grid g-2">' + d.distributions.map(function (q) {
          return '<div class="card"><h2>' + esc(q.title) + '</h2><p class="sub">' + n(q.answered) + ' answered</p>' + barList(q.options.map(function (o) { return { name: o.label + ' (' + o.points + ' pts)', value: o.n, note: pct(o.n / (q.answered || 1)) }; })) + '</div>';
        }).join('') + '</div>';
      columnChart(view.querySelector('[data-hist]'), d.score_histogram.map(function (h) { return { label: 'Score ' + h.range, short: h.range.split('–')[0], value: h.n }; }), { label: 'Score distribution' });
    });
  }

  function renderExperiments() {
    return api('experiments').then(function (d) {
      view.innerHTML = '<div class="card"><h2>' + esc(d.id) + '</h2><p class="sub">Primary metric: ' + esc(d.primary) + '. Significance from a two-proportion z-test vs. variant A (p &lt; 0.05). Preview a variant with <span class="mono">/?v=b</span>.</p>' +
        table([
          { label: 'Variant', html: function (r) { return '<strong>' + esc(r.id.toUpperCase()) + '</strong> <span class="muted">' + esc(r.weight) + '%</span><div class="muted" style="max-width:340px;white-space:normal">' + esc(r.headline) + '</div>'; } },
          { label: 'Visitors', key: 'visitors', num: true, fmt: n },
          { label: 'Play', key: 'play_rate', num: true, fmt: function (v) { return pct(v); } },
          { label: '50% watched', key: 'half_rate', num: true, fmt: function (v) { return pct(v); } },
          { label: 'Pitch', key: 'pitch_rate', num: true, fmt: function (v) { return pct(v); } },
          { label: 'Lead', key: 'lead_rate', num: true, fmt: function (v) { return pct(v, 1); } },
          { label: 'Application', key: 'app_rate', num: true, fmt: function (v) { return pct(v, 1); } },
          { label: 'Qualified', key: 'qualified_rate', num: true, fmt: function (v) { return pct(v, 1); } },
          { label: 'Booked', key: 'booked_rate', num: true, fmt: function (v) { return pct(v, 1); } },
          { label: 'Lift vs A', num: true, html: function (r) { return r.lift == null ? '<span class="muted">control</span>' : esc((r.lift > 0 ? '+' : '') + pct(r.lift, 1)); } },
          { label: 'Result', html: function (r) { return r.p_value == null ? '' : r.significant ? '<span class="pill ok">✓ significant (p=' + r.p_value.toFixed(3) + ')</span>' : '<span class="pill">not yet (p=' + r.p_value.toFixed(2) + ')</span>'; } },
        ], d.variants) + '</div>';
    });
  }

  // ── Leads ──
  function renderLeads() {
    var q = state.leadsQuery, r = range();
    var params = { q: q.q, tier: q.tier, status: q.status, page: q.page, sort: q.sort, channel: state.filters.channel || '', from: r.from, to: r.to };
    return fetchLeads(params).then(function (d) {
      var statuses = (state.meta && state.meta.statuses) || [];
      var exportUrl = '/admin/api/export/leads.csv?' + new URLSearchParams(Object.fromEntries(Object.entries(params).filter(function (e) { return e[1] !== '' && e[0] !== 'page'; }))).toString();
      view.innerHTML =
        '<div class="row" style="margin-bottom:12px"><input class="input" type="search" placeholder="Search name, email, phone or ref" data-q value="' + esc(q.q) + '" style="min-width:260px">' +
        '<select class="input" data-tier><option value="">All tiers</option><option>A</option><option>B</option><option>C</option></select>' +
        '<select class="input" data-status><option value="">All statuses</option>' + statuses.map(function (s) { return '<option>' + esc(s) + '</option>'; }).join('') + '</select>' +
        '<select class="input" data-sort><option value="created">Newest</option><option value="score">Highest score</option><option value="call">Call time</option><option value="updated">Recently updated</option></select>' +
        '<span class="spacer"></span><span class="muted">' + n(d.total) + ' leads</span><a class="btn-sm ghost" href="' + esc(exportUrl) + '">Export CSV</a></div>' +
        '<div class="card">' + table([
          { label: 'Lead', html: function (l) { return '<strong>' + esc([l.first_name, l.last_name].filter(Boolean).join(' ') || '—') + '</strong><div class="muted">' + esc(l.email || '') + '</div>'; } },
          { label: 'Tier', html: function (l) { return l.tier ? '<span class="tier ' + esc(l.tier) + '">' + esc(l.tier) + '</span>' : '<span class="muted">step ' + esc(l.step_reached) + '</span>'; } },
          { label: 'Score', key: 'score', num: true, fmt: function (v) { return v == null ? '–' : v; } },
          { label: 'Status', html: function (l) { return '<span class="pill">' + esc(l.status) + '</span>'; } },
          { label: 'VSL', key: 'vsl_pct', num: true, fmt: function (v) { return v == null ? '–' : pct(Math.min(1, v)); } },
          { label: 'Source', html: function (l) { return esc(l.channel || 'Direct') + '<div class="muted">' + esc(l.utm_campaign || '') + (l.utm_content ? ' · ' + esc(l.utm_content) : '') + '</div>'; } },
          { label: 'Call', html: function (l) { return l.call_at ? esc(when(l.call_at)) : l.booked_at ? 'booked' : '<span class="muted">–</span>'; } },
          { label: 'WA', html: function (l) { return l.whatsapp_connected_at ? '<span class="ok" title="Connected">●</span>' : l.whatsapp_clicked_at ? '<span title="Clicked">○</span>' : ''; } },
          { label: 'Country', key: 'country' },
          { label: 'Created', html: function (l) { return '<span title="' + esc(when(l.created_at)) + '">' + esc(ago(l.created_at)) + '</span>'; } },
        ], d.rows, { rowAttr: function (l) { return 'class="click" data-lead="' + esc(l.id) + '" tabindex="0"'; } }) + '</div>' +
        '<div class="row" style="margin-top:12px"><button class="btn-sm ghost" data-prev ' + (q.page ? '' : 'disabled') + '>← Prev</button><span class="muted">Page ' + (q.page + 1) + ' of ' + Math.max(1, Math.ceil(d.total / d.pageSize)) + '</span><button class="btn-sm ghost" data-next ' + ((q.page + 1) * d.pageSize < d.total ? '' : 'disabled') + '>Next →</button></div>';
      view.querySelector('[data-tier]').value = q.tier;
      view.querySelector('[data-status]').value = q.status;
      view.querySelector('[data-sort]').value = q.sort;
      var t;
      view.querySelector('[data-q]').oninput = function (e) { clearTimeout(t); t = setTimeout(function () { q.q = e.target.value; q.page = 0; load(); }, 300); };
      view.querySelector('[data-tier]').onchange = function (e) { q.tier = e.target.value; q.page = 0; load(); };
      view.querySelector('[data-status]').onchange = function (e) { q.status = e.target.value; q.page = 0; load(); };
      view.querySelector('[data-sort]').onchange = function (e) { q.sort = e.target.value; load(); };
      view.querySelector('[data-prev]').onclick = function () { q.page--; load(); };
      view.querySelector('[data-next]').onclick = function () { q.page++; load(); };
      view.querySelectorAll('[data-lead]').forEach(function (row) {
        row.onclick = function () { openLead(row.getAttribute('data-lead')); };
        row.onkeydown = function (e) { if (e.key === 'Enter') openLead(row.getAttribute('data-lead')); };
      });
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
  var QUIET = { app_view_step: 1, scroll_depth: 1, engaged_time: 1 };

  function openLead(id) {
    history.replaceState(null, '', '#lead=' + id);
    var bg = document.createElement('div'); bg.className = 'drawer-bg';
    var dr = document.createElement('aside'); dr.className = 'drawer'; dr.setAttribute('role', 'dialog'); dr.setAttribute('aria-label', 'Lead details');
    dr.innerHTML = '<div class="empty">Loading…</div>';
    document.body.appendChild(bg); document.body.appendChild(dr);
    function close() { bg.remove(); dr.remove(); history.replaceState(null, '', '#' + state.tab); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    bg.onclick = close; document.addEventListener('keydown', onKey);

    fetch('/admin/api/leads/' + encodeURIComponent(id), { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) { dr.innerHTML = '<div class="empty">Lead not found.</div>'; return; }
      var l = d.lead, sc = d.scoring || {};
      var tier = l.tier_override || l.tier;
      var showAll = false;
      var sessionsById = {};
      d.sessions.forEach(function (s) { sessionsById[s.id] = s; });

      function timeline() {
        var seen = {}, out = [];
        d.events.slice().reverse().forEach(function (e) {
          if (e.session_id && !seen[e.session_id] && sessionsById[e.session_id]) {
            seen[e.session_id] = 1;
            var s = sessionsById[e.session_id];
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

      dr.innerHTML =
        '<button class="close" type="button" aria-label="Close">Close ✕</button>' +
        '<div class="row"><h2 class="lead-name">' + esc([l.first_name, l.last_name].filter(Boolean).join(' ') || l.email) + '</h2>' + (tier ? '<span class="tier ' + esc(tier) + '">' + esc(tier) + '</span>' : '') + '<span class="pill">score ' + esc(l.score == null ? '–' : l.score) + '</span><span class="pill">ref ' + esc(l.ref_code) + '</span></div>' +
        '<p class="muted" style="margin:4px 0 14px">' + esc(l.email || '') + (l.phone ? ' · ' + esc(l.phone) : '') + ' · created ' + esc(when(l.created_at)) + '</p>' +
        '<div class="row" style="margin-bottom:14px">' + (l.email ? '<a class="btn-sm ghost" href="mailto:' + esc(l.email) + '">Email</a>' : '') + (l.phone ? '<a class="btn-sm ghost" href="tel:' + esc(l.phone) + '">Call</a><a class="btn-sm ghost" target="_blank" rel="noopener" href="https://wa.me/' + esc(String(l.phone).replace(/\D/g, '')) + '">WhatsApp them</a>' : '') + '</div>' +
        '<div class="grid g-2">' +
        '<div class="card"><h2>Pipeline</h2><div class="grid" style="gap:10px;margin-top:10px">' +
        '<label>Status <select class="input" data-f="status">' + ((state.meta && state.meta.statuses) || []).map(function (s) { return '<option' + (s === l.status ? ' selected' : '') + '>' + esc(s) + '</option>'; }).join('') + '</select></label>' +
        '<label>Tier override <select class="input" data-f="tier_override"><option value="">— (computed: ' + esc(l.tier || 'none') + ')</option><option' + (l.tier_override === 'A' ? ' selected' : '') + '>A</option><option' + (l.tier_override === 'B' ? ' selected' : '') + '>B</option><option' + (l.tier_override === 'C' ? ' selected' : '') + '>C</option></select></label>' +
        '<label>Revenue (AUD) <input class="input" type="number" min="0" step="100" data-f="revenue" value="' + esc(l.revenue || 0) + '"></label>' +
        '<label>Notes<textarea class="notes" data-f="notes">' + esc(l.notes || '') + '</textarea></label>' +
        '<button class="btn-sm" data-save type="button">Save</button></div></div>' +
        '<div class="card"><h2>Profile</h2><dl class="kv" style="margin-top:10px">' +
        kv('Closer', l.closer_id) + kv('Route', l.route) + kv('Call', l.call_at ? when(l.call_at) : l.booked_at ? 'booked (time pending)' : '–') +
        kv('Last touch', [l.channel, l.utm_source, l.utm_campaign, l.utm_content].filter(Boolean).join(' / ')) + kv('First touch', [l.ft_channel, l.ft_source, l.ft_campaign, l.ft_content].filter(Boolean).join(' / ')) +
        kv('Click id', l.click_type ? l.click_type + ' ' + String(l.click_id).slice(0, 18) + '…' : '') + kv('Headline', l.variant) + kv('Location', [l.city, l.country].filter(Boolean).join(', ')) + kv('Device', l.device) +
        kv('WhatsApp', l.whatsapp_connected_at ? 'connected ' + when(l.whatsapp_connected_at) : l.whatsapp_clicked_at ? 'clicked ' + when(l.whatsapp_clicked_at) : (l.whatsapp_opt_in ? 'opted in' : '–')) +
        kv('Email', l.unsubscribed_at ? 'unsubscribed' : 'subscribed') + kv('Phone calls', l.do_not_call_at ? 'do not call (since ' + when(l.do_not_call_at) + ')' : 'ok') + kv('Visits', d.sessions.length) + '</dl></div></div>' +
        '<div class="grid g-2" style="margin-top:14px"><div class="card"><h2>Application</h2><dl class="kv" style="margin-top:10px">' + d.answers.map(function (a) { return kv(a.question, a.answer); }).join('') + '</dl>' +
        (sc.breakdown ? '<p class="sub" style="margin-top:12px">Scoring: ' + esc(sc.breakdown.map(function (b) { return b.question + ' +' + b.points; }).join(', ')) + (sc.caps && sc.caps.length ? ' · capped: ' + esc(sc.caps.join(', ')) : '') + '</p>' : '') + '</div>' +
        '<div class="card"><h2>Video</h2>' + (d.vsl.length ? d.vsl.map(function (v) {
          return '<div style="margin:10px 0"><div class="row"><strong>' + esc(v.video_id) + '</strong><span class="muted">' + esc(when(v.started_at)) + ' · ' + esc(v.duration ? pct(Math.min(1, v.max_position / v.duration)) : '–') + ' reached · ' + esc(secs(v.watched_seconds)) + ' watched' + (v.cta_clicked ? ' · clicked CTA' : '') + '</span></div><div class="mini-ret" aria-hidden="true">' + String(v.buckets).split('').map(function (b) { return '<i' + (b === '1' ? ' class="on"' : '') + '></i>'; }).join('') + '</div></div>';
        }).join('') : '<p class="muted">No video views recorded.</p>') +
        '<h2 style="margin-top:14px">Emails</h2>' + (d.emails.length ? table([{ label: 'Email', html: function (m) { return esc(m.template) + '<div class="muted">' + esc(m.sequence) + '</div>'; } }, { label: 'Status', key: 'status' }, { label: 'When', html: function (m) { return esc(when(m.sent_at || m.send_at)); } }, { label: 'Opened', html: function (m) { return m.opened_at ? '✓' : ''; } }, { label: 'Clicked', html: function (m) { return m.clicked_at ? '✓' : ''; } }], d.emails) : '<p class="muted">None.</p>') + '</div></div>' +
        (d.voice && d.voice.length ? '<div class="card" style="margin-top:14px"><h2>AI calls</h2>' + d.voice.map(voiceCall).join('') + '</div>' : '') +
        '<div class="card" style="margin-top:14px"><div class="card-head"><div><h2>Journey</h2><p class="sub">Every visit and action, server-side.</p></div><label class="muted"><input type="checkbox" data-all> show all events</label></div><ul class="timeline" data-tl>' + timeline() + '</ul></div>';

      dr.querySelector('.close').onclick = close;
      dr.querySelector('[data-all]').onchange = function (e) { showAll = e.target.checked; dr.querySelector('[data-tl]').innerHTML = timeline(); };
      dr.querySelector('[data-save]').onclick = function () {
        var body = {};
        dr.querySelectorAll('[data-f]').forEach(function (f) { body[f.getAttribute('data-f')] = f.value; });
        send('PATCH', 'leads/' + encodeURIComponent(id), body).then(function (r) { toast(r.ok ? 'Saved' : 'Could not save'); if (state.tab === 'leads') load(); });
      };
    });
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

  function renderVoice() {
    return api('voice').then(function (d) {
      var t = d.totals || {};
      view.innerHTML =
        '<div class="grid g-3">' + tile('AI calls', n(t.calls || 0), n(t.phone || 0) + ' phone · ' + n(t.web || 0) + ' browser') + tile('Wanted a strategy call', n(t.wants_call || 0), n(t.callbacks || 0) + ' asked for a person to call back') +
        tile('Avg length', t.avg_s ? secs(t.avg_s) : '–', (t.cost ? '$' + t.cost + ' Vapi cost · ' : '') + n(t.opt_outs || 0) + ' opted out') + '</div>' +
        '<div class="card" style="margin-top:14px"><h2>Calls</h2><p class="sub">Inbound only. The assistant tells every caller it’s an AI and that the call is recorded.</p>' +
        (d.calls.length ? table([
          { label: 'When', html: function (v) { return esc(when(v.created_at)); } },
          { label: 'Who', html: function (v) { return v.lead_id ? '<a href="#lead=' + esc(v.lead_id) + '" data-open="' + esc(v.lead_id) + '">' + esc([v.first_name, v.last_name].filter(Boolean).join(' ') || 'lead') + '</a>' + (v.tier ? ' <span class="tier ' + esc(v.tier) + '">' + esc(v.tier) + '</span>' : '') : '<span class="muted">' + esc(v.from_number || 'unknown') + '</span>'; } },
          { label: 'Type', key: 'kind' },
          { label: 'Length', html: function (v) { return esc(v.duration_s ? secs(v.duration_s) : v.status); } },
          { label: 'Summary', html: function (v) { return esc((v.summary || '').slice(0, 180)); } },
          { label: 'Rec.', html: function (v) { return v.recording_url ? '<a href="' + esc(v.recording_url) + '" target="_blank" rel="noopener">▶</a>' : ''; } },
        ], d.calls) : '<p class="muted">No AI calls yet. Connect Vapi under Integrations → Voice.</p>') + '</div>';
      view.querySelectorAll('[data-open]').forEach(function (a) { a.onclick = function (ev) { ev.preventDefault(); openLead(a.getAttribute('data-open')); }; });
    });
  }

  function kv(k, v) { return '<dt>' + esc(k) + '</dt><dd>' + esc(v == null || v === '' ? '–' : v) + '</dd>'; }

  function renderEmails() {
    return api('emails').then(function (d) {
      view.innerHTML =
        '<div class="card"><h2>By email</h2><p class="sub">“Simulated” means no Resend key was connected — the email was rendered and logged but not sent.</p>' +
        table([{ label: 'Sequence', key: 'sequence' }, { label: '#', key: 'step', num: true, fmt: function (v) { return v + 1; } }, { label: 'Template', html: function (r) { return '<a href="/admin/api/email-preview/' + esc(r.template) + '" target="_blank" rel="noopener">' + esc(r.template) + ' ↗</a>'; } },
          { label: 'Sent', key: 'sent', num: true, fmt: n }, { label: 'Simulated', key: 'simulated', num: true, fmt: n }, { label: 'Skipped', key: 'skipped', num: true, fmt: n }, { label: 'Failed', key: 'failed', num: true, fmt: n },
          { label: 'Open rate', num: true, html: function (r) { return esc(pct(r.opened / (r.sent || 1))); } }, { label: 'Click rate', num: true, html: function (r) { return esc(pct(r.clicked / (r.sent || 1))); } }], d.templates) + '</div>' +
        '<div class="grid g-2" style="margin-top:14px"><div class="card"><h2>Queue</h2><p class="sub">Scheduled and waiting for the 5-minute sender.</p>' + table([{ label: 'Sequence', key: 'sequence' }, { label: 'Pending', key: 'pending', num: true, fmt: n }, { label: 'Next send', html: function (r) { return esc(when(r.next_at)); } }], d.queue) + '</div>' +
        '<div class="card"><h2>Recent failures</h2><p class="sub">Retries 3× with back-off before failing.</p>' + table([{ label: 'Template', key: 'template' }, { label: 'To', key: 'to_email' }, { label: 'Error', key: 'error' }], d.failures) + '</div></div>';
    });
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
          ], d.events) + '</div>';
        view.querySelectorAll('[data-open]').forEach(function (a) { a.onclick = function (ev) { ev.preventDefault(); openLead(a.getAttribute('data-open')); }; });
      });
    }
    liveTimer = setInterval(function () { if (!document.hidden && !document.querySelector('.drawer')) draw(); }, 5000);
    return draw();
  }

  function renderIntegrations() {
    return fetch('/admin/api/integrations', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
      var groups = {};
      d.settings.forEach(function (s) { (groups[s.group] = groups[s.group] || []).push(s); });
      view.innerHTML =
        '<div class="card"><h2>Status</h2><div class="int-grid" style="margin-top:10px">' + Object.keys(d.status).map(function (k) {
          var s = d.status[k];
          return '<div class="int"><span class="badge">' + (s.connected ? '<span class="status-dot" style="background:var(--good)" aria-hidden="true"></span>' : '<span class="status-dot" style="background:var(--axis)" aria-hidden="true"></span>') + '</span><div><b>' + esc(s.label || k) + ' · ' + (s.connected ? 'connected' : 'not connected') + '</b><span>' + esc(s.detail) + '</span></div></div>';
        }).join('') + '</div></div>' +
        '<div class="grid g-2" style="margin-top:14px"><div class="card"><h2>Test email</h2><p class="sub">Sends a test through Resend to confirm the key, domain and From address.</p><div class="row"><input class="input" type="email" placeholder="you@company.com" data-test-to style="flex:1"><button class="btn-sm" data-test>Send test</button></div></div>' +
        '<div class="card"><h2>Webhook URLs</h2><p class="sub">Paste these into each provider.</p><dl class="kv">' + kv('Calendly', d.webhooks.calendly) + kv('Cal.com / GHL / Zapier', d.webhooks.booking) + kv('WhatsApp Cloud API', d.webhooks.whatsapp) + kv('Vapi (voice) Server URL', d.webhooks.voice) + '</dl></div></div>' +
        '<div class="card" style="margin-top:14px"><div class="card-head"><div><h2>Voice assistant</h2><p class="sub">Creates (or updates) the inbound assistant in your Vapi account from the copy, FAQs and rules in config. Save your Vapi keys and webhook secret first. Then in Vapi, set your phone number’s Server URL to the voice URL above and leave its assistant empty.</p></div><div class="row"><a class="btn-sm ghost" href="/admin/api/voice/assistant.json" target="_blank" rel="noopener">View JSON</a><button class="btn-sm" type="button" data-provision>Create / update assistant</button></div></div></div>' +
        '<form class="card" style="margin-top:14px" data-settings><div class="card-head"><div><h2>Keys & settings</h2><p class="sub">Values set as Worker secrets/vars are locked here (they always win). Secrets are never shown — leave a masked field blank to keep it, type “-” to clear it.</p></div><button class="btn-sm" type="submit">Save changes</button></div>' +
        Object.keys(groups).map(function (g) {
          return '<div class="settings-group"><h3>' + esc(g) + '</h3>' + groups[g].map(function (s) {
            var locked = s.source === 'env';
            return '<div class="setting"><div><label for="s_' + esc(s.key) + '">' + esc(s.label) + '</label>' + (s.help ? '<div class="help">' + esc(s.help) + '</div>' : '') + '</div><div><input id="s_' + esc(s.key) + '" name="' + esc(s.key) + '" ' + (s.secret ? 'type="password" autocomplete="new-password" placeholder="' + esc(s.value ? s.value + ' (saved)' : (s.placeholder || '')) + '" value=""' : 'value="' + esc(s.value) + '" placeholder="' + esc(s.placeholder || '') + '"') + (locked ? ' disabled' : '') + '><div class="src">' + (locked ? 'Set via Worker environment' : s.source === 'dashboard' ? 'Saved in dashboard' : 'Not set') + ' · <span class="mono">' + esc(s.key) + '</span></div></div></div>';
          }).join('') + '</div>';
        }).join('') + '</form>';

      view.querySelector('[data-provision]').onclick = function () {
        send('POST', 'voice/provision', {}).then(function (r) { toast(r.ok ? 'Assistant ' + (r.created ? 'created' : 'updated') + ' ✓' : (r.error || 'Failed')); if (r.ok) load(); });
      };
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
    sel.onchange = function () { state.filters[sel.getAttribute('data-filter')] = sel.value; load(); };
  });
  document.querySelector('[data-clear]').onclick = function () {
    state.filters = {};
    document.querySelectorAll('[data-filter]').forEach(function (s) { s.value = ''; });
    load();
  };
  document.querySelectorAll('[data-nav] button').forEach(function (b) { b.onclick = function () { go(b.getAttribute('data-tab')); }; });

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

  var resizeT;
  addEventListener('resize', function () { clearTimeout(resizeT); resizeT = setTimeout(function () { if (['overview', 'vsl', 'application'].indexOf(state.tab) !== -1) load(); }, 250); });

  fetch('/admin/api/meta', { credentials: 'same-origin' }).then(function (r) { if (r.status === 401) location.href = '/admin/login'; return r.json(); }).then(function (meta) {
    state.meta = meta;
    populateFilters();
    var h = location.hash.slice(1);
    if (h.indexOf('lead=') === 0) { go('leads'); openLead(h.slice(5)); } else go(h || 'overview');
  });
})();
