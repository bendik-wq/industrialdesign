/* Funnel HQ → Webinar attribution: the automated webinar, the live Zoom webinar and the 5-day challenge,
   tied back to traffic (first touch, last touch, linear) and forward to revenue net of refunds.
   Stage funnel, revenue by source / campaign / ad set / ad / tracked link / landing page / edition, cost and ROAS
   from the Meta spend sync, retention per minute, what predicts buying, cohorts, and each person's journey.
   Loaded before admin.js, which calls WebinarAttribution.render(ctx). Every number comes from /admin/api/attribution. */
(function (root) {
  'use strict';
  var CSS = '.wa-bar{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center}.wa-bar label{display:flex;gap:6px;align-items:center;font-size:13px;color:var(--ink-2)}' +
    '.wa-card{margin-top:14px}.wa-card h2{margin:0 0 4px}.wa-sub{color:var(--muted);font-size:13px;margin:0 0 12px}' +
    '.wa-funnel{display:grid;gap:6px}.wa-row{display:grid;grid-template-columns:minmax(120px,240px) 1fr minmax(70px,auto) minmax(64px,auto);gap:10px;align-items:center;font-size:13px}' +
    '.wa-track{height:18px;background:var(--surface-2,#f5f5f7);border-radius:4px;overflow:hidden}.wa-fill{height:100%;background:var(--series-1,#0f2c5c);border-radius:4px;min-width:2px}' +
    '.wa-row .num{text-align:right;font-variant-numeric:tabular-nums}.wa-nodata{color:var(--muted)}' +
    '.wa-chart{width:100%;height:auto;display:block}.wa-legend{display:flex;flex-wrap:wrap;gap:12px;font-size:12px;color:var(--ink-2);margin-top:6px}.wa-legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:-1px}' +
    '.wa-setup li{margin:6px 0;font-size:13px;overflow-wrap:anywhere}.wa-card,.wa-journey{min-width:0;overflow-wrap:anywhere}.wa-setup .ok{color:var(--muted)}.wa-setup strong{font-weight:600}' +
    '.wa-two{display:grid;grid-template-columns:1fr 1fr;gap:14px}.wa-journey{border-top:1px solid var(--border);margin-top:12px;padding-top:12px}' +
    '.wa-tl{list-style:none;padding:0;margin:0;font-size:13px}.wa-tl li{display:grid;grid-template-columns:130px 1fr;gap:10px;padding:6px 0;border-top:1px solid var(--border)}.wa-tl .t{color:var(--muted);font-variant-numeric:tabular-nums}' +
    '.wa-pill{display:inline-block;font-size:11px;padding:1px 6px;border-radius:9px;background:var(--surface-2,#f5f5f7);color:var(--ink-2);margin:1px 2px 1px 0}' +
    '@media (max-width:760px){.wa-two{grid-template-columns:1fr}.wa-row{grid-template-columns:1fr minmax(56px,auto) minmax(52px,auto)}.wa-row .wa-track{grid-column:1/-1;order:2}.wa-tl li{grid-template-columns:1fr}}';

  var FUNNELS = [['all', 'All'], ['auto', 'Automated webinar'], ['live', 'Live webinar'], ['challenge', 'Challenge']];
  var MODELS = [['last', 'Last touch'], ['first', 'First touch'], ['linear', 'Linear']];
  var DIMS = [['campaign', 'Campaign'], ['adset', 'Ad set'], ['ad', 'Ad'], ['platform', 'Source (platform)'], ['source', 'utm_source'], ['channel', 'Channel'], ['link', 'Tracked link'], ['landing', 'Landing page'], ['edition', 'Edition (recorded or AI)']];
  var STAGE_NAMES = { registered: 'Registered', ticket_paid: 'Ticket', sprint_paid: 'Sprint', deposit_paid: 'Deposit', vip_paid: 'VIP', engagement_signed: 'Engagement' };
  var COLORS = ['var(--series-1,#0f2c5c)', 'var(--series-2,#c98a00)', 'var(--series-3,#1d7a4f)', 'var(--series-4,#8a4fb5)', 'var(--series-5,#b5463c)'];
  var st = { funnel: 'all', model: 'last', dim: 'campaign', cohort: 'byWeek', lead: null };
  try { var saved = JSON.parse(localStorage.getItem('wattrib') || '{}'); ['funnel', 'model', 'dim', 'cohort'].forEach(function (k) { if (saved[k]) st[k] = saved[k]; }); } catch (e) { /* private window */ }
  function remember() { try { localStorage.setItem('wattrib', JSON.stringify({ funnel: st.funnel, model: st.model, dim: st.dim, cohort: st.cohort })); } catch (e) { /* ignore */ } }

  function render(ctx) {
    var view = ctx.view, esc = ctx.esc, n = ctx.n, pct = ctx.pct, when = ctx.when, tile = ctx.tile, table = ctx.table, toast = ctx.toast;
    if (!document.getElementById('wa-css')) { var s = document.createElement('style'); s.id = 'wa-css'; s.textContent = CSS; document.head.appendChild(s); }
    return ctx.api('attribution', { funnel: st.funnel, model: st.model, dim: st.dim }).then(function (d) {
      var cur = (d.revenue && d.revenue.currency) || (d.stages && d.stages.currency) || 'USD';
      var money = function (v, dp) { if (v == null) return '–'; try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, maximumFractionDigits: dp == null ? 0 : dp }).format(v); } catch (e) { return cur + ' ' + n(v); } };
      var ratio = function (v) { return v == null ? '–' : (Math.round(v * 100) / 100).toFixed(2) + 'x'; };
      var seg = function (name, opts, val) { return '<div class="seg" role="group" aria-label="' + esc(name) + '">' + opts.map(function (o) { return '<button type="button" data-wa-' + esc(name) + '="' + esc(o[0]) + '" aria-pressed="' + (o[0] === val) + '">' + esc(o[1]) + '</button>'; }).join('') + '</div>'; };
      var q = new URLSearchParams({ funnel: st.funnel, model: st.model, dim: st.dim, from: String(d.range.from), to: String(d.range.to) });
      var csv = function (type, label) { q.set('type', type); return '<a class="btn-sm ghost" href="/admin/api/attribution/export.csv?' + esc(q.toString()) + '">' + esc(label) + '</a>'; };

      var bar = '<div class="card"><div class="wa-bar">' + seg('funnel', FUNNELS, st.funnel) +
        '<span class="muted small">' + esc(new Date(d.range.from).toLocaleDateString()) + ' to ' + esc(new Date(d.range.to).toLocaleDateString()) + ' (date range above)</span>' +
        '<span style="flex:1"></span>' + csv('revenue', 'Revenue CSV') + csv('people', 'People CSV') + csv('conversions', 'Conversions CSV') +
        '<button class="btn-sm ghost" type="button" data-wa-sync>Rebuild from all data</button></div></div>';

      // Setup: what the owner still has to turn on.
      var todo = (d.setup.items || []).filter(function (i) { return !i.ok; });
      var setup = '<div class="card wa-card"><details' + (todo.length ? ' open' : '') + '><summary><strong>Tracking setup</strong> <span class="muted">' + (todo.length ? n(todo.length) + ' to do' : 'all set') + '</span></summary><ul class="wa-setup">' +
        (d.setup.items || []).map(function (i) { return '<li class="' + (i.ok ? 'ok' : '') + '">' + (i.ok ? 'Done: ' : '<strong>To do:</strong> ') + esc(i.text) + ' <span class="muted">' + esc(i.detail || '') + '</span></li>'; }).join('') + '</ul></details></div>';

      // Tiles.
      var S = {}; (d.stages.stages || []).forEach(function (x) { S[x.id] = x; });
      var reg = d.stages.registered || 0;
      var buyers = ['sprint_paid', 'deposit_paid'].reduce(function (a, k) { return a + ((S[k] && S[k].applies && S[k].count) || 0); }, 0);
      var tiles = '<div class="grid g-4 tiles" style="margin-top:14px">' +
        tile('Registered', reg ? n(reg) : '–', reg ? (S.visit && S.visit.count ? pct(reg / S.visit.count) + ' of ' + n(S.visit.count) + ' visitors' : 'no visit data yet') : 'no data yet') +
        tile('Attended', S.attended && S.attended.count ? n(S.attended.count) : '–', reg ? pct(S.attended ? S.attended.rate : null) + ' of registrants' : 'no data yet') +
        tile('Bought the offer', buyers ? n(buyers) : '–', reg ? pct(buyers / reg) + ' of registrants (Sprint or deposit)' : 'no data yet') +
        tile('Revenue, net of refunds', d.revenue.total ? money(d.revenue.total) : '–', (d.revenue.refunded ? money(d.revenue.refunded) + ' refunded · ' : '') + (d.revenue.spendTotal ? 'spend ' + money(d.revenue.spendTotal) + ' · ROAS ' + ratio(d.revenue.total / d.revenue.spendTotal) : 'no spend synced')) + '</div>';

      // Stage funnel (registrants in the range and how far they got).
      var stageRows = (d.stages.stages || []).filter(function (x) { return x.applies; });
      var max = Math.max(1, S.visit && S.visit.count ? S.visit.count : reg);
      var funnel = '<div class="card wa-card"><h2>Stage funnel</h2><p class="wa-sub">People who registered in the range, and how many reached each stage. Visits count distinct visitors to the registration page. Money is net of refunds.</p><div class="wa-funnel">' +
        stageRows.map(function (x) {
          var none = !x.count;
          return '<div class="wa-row"><span>' + esc(x.label) + '</span><div class="wa-track"><div class="wa-fill" style="width:' + (none ? 0 : Math.max(0.5, x.count / max * 100)).toFixed(1) + '%"></div></div>' +
            '<span class="num' + (none ? ' wa-nodata' : '') + '">' + (none ? 'no data yet' : n(x.count) + (x.rate != null ? ' · ' + pct(x.rate) : '')) + '</span>' +
            '<span class="num">' + (x.revenue ? money(x.revenue) : '') + '</span></div>';
        }).join('') + '</div></div>';

      // Revenue attribution.
      var R = d.revenue;
      var revCols = [
        { label: (DIMS.filter(function (x) { return x[0] === st.dim; })[0] || [0, 'Value'])[1], key: 'label', html: function (r) { return esc(r.label) + (r.label !== r.key ? ' <span class="muted small">' + esc(r.key) + '</span>' : ''); } },
        { label: 'Revenue', key: 'revenue', num: true, fmt: function (v) { return money(v); } },
        { label: 'Registrants', key: 'registrants', num: true, fmt: function (v) { return v % 1 ? v.toFixed(1) : n(v); } },
        { label: 'Attendees', key: 'attendees', num: true, fmt: function (v) { return v % 1 ? v.toFixed(1) : n(v); } },
        { label: 'Paying people', key: 'buyers', num: true, fmt: function (v) { return v % 1 ? v.toFixed(1) : n(v); } },
        { label: 'Per registrant', key: 'perRegistrant', num: true, fmt: function (v) { return money(v, 2); } },
        { label: 'Spend', key: 'spend', num: true, fmt: function (v) { return money(v); } },
        { label: 'Cost / registrant', key: 'costPerRegistrant', num: true, fmt: function (v) { return money(v, 2); } },
        { label: 'Cost / attendee', key: 'costPerAttendee', num: true, fmt: function (v) { return money(v, 2); } },
        { label: 'Cost / paying person', key: 'costPerBuyer', num: true, fmt: function (v) { return money(v, 2); } },
        { label: 'ROAS', key: 'roas', num: true, fmt: ratio },
      ];
      var revenue = '<div class="card wa-card"><h2>Revenue by ' + esc(((DIMS.filter(function (x) { return x[0] === st.dim; })[0]) || [0, ''])[1].toLowerCase()) + '</h2>' +
        '<p class="wa-sub">Purchases and signed engagements in the range, net of refunds. Last touch credits the last visit that came from somewhere, first touch the first visit, linear splits each sale evenly across every visit before it. Each model adds up to the same total. Spend from the Meta sync (campaign, ad set and ad only).</p>' +
        '<div class="wa-bar" style="margin-bottom:10px">' + seg('model', MODELS, st.model) + '<label>By <select class="input" data-wa-dim>' + DIMS.map(function (x) { return '<option value="' + x[0] + '"' + (x[0] === st.dim ? ' selected' : '') + '>' + esc(x[1]) + '</option>'; }).join('') + '</select></label></div>' +
        table(revCols, R.rows || [], { cards: true, empty: 'No data yet', emptyHint: 'Registrations and purchases appear here as they happen. Press Rebuild to read past ones.' }) +
        ((R.otherCurrencies || []).length ? '<p class="muted small">Not included (other currencies, not converted): ' + R.otherCurrencies.map(function (o) { return esc(o.currency) + ' ' + n(o.amount); }).join(', ') + '</p>' : '') + '</div>';

      // Time to purchase.
      var T = d.timeToPurchase;
      var ttp = '<div class="card wa-card"><h2>Time from registering to buying</h2>' + (T.n ? table([{ label: 'When', key: 'label' }, { label: 'Purchases', key: 'n', num: true, fmt: n }], T.buckets) +
        '<p class="muted small">' + (T.medians || []).map(function (m) { return esc(STAGE_NAMES[m.kind] || m.kind) + ': median ' + esc(m.medianHours) + ' h (' + n(m.n) + ')'; }).join(' · ') + '</p>' : ctx.emptyState('No data yet', 'Appears once someone who registered buys.')) + '</div>';

      // Room analytics.
      var room = roomHtml(d.room, esc, n, pct, table, ctx.emptyState);

      // Cohorts.
      var C = d.cohorts;
      var cohortRows = C[st.cohort] || [];
      var cohort = '<div class="card wa-card"><h2>Cohorts</h2><p class="wa-sub">Registrants grouped by the week they registered, or by the session, live event or challenge cohort they joined. Revenue is everything they paid since, net of refunds.</p>' +
        '<div class="wa-bar" style="margin-bottom:10px">' + seg('cohort', [['byWeek', 'Registration week'], ['byEvent', 'Session or cohort']], st.cohort) + '</div>' +
        table([{ label: 'Cohort', key: 'label' }, { label: 'Registrants', key: 'registrants', num: true, fmt: n }, { label: 'Attended', key: 'attendRate', num: true, fmt: function (v) { return pct(v); } },
          { label: 'Tickets', key: 'tickets', num: true, fmt: n }, { label: 'Offer buyers', key: 'offers', num: true, fmt: n }, { label: 'Buy rate', key: 'buyRate', num: true, fmt: function (v) { return pct(v); } },
          { label: 'Revenue', key: 'revenue', num: true, fmt: function (v) { return money(v); } }, { label: 'Per registrant', key: 'perRegistrant', num: true, fmt: function (v) { return money(v, 2); } }], cohortRows, { cards: true, empty: 'No data yet' }) + '</div>';

      // People.
      var peopleHtml = '<div class="card wa-card"><h2>People</h2><p class="wa-sub">The 25 most recent registrants in the range (People CSV has everyone). Click a row for every touch, stage and payment.</p>' +
        table([{ label: 'Who', key: 'name' }, { label: 'Funnel', key: 'funnel' }, { label: 'Registered', key: 'occurred_at', fmt: when, nw: true },
          { label: 'First touch', key: 'ft_platform', html: function (r) { return esc(r.ft_platform || 'Not tracked') + (r.ft_campaign ? '<div class="muted small">' + esc(r.ft_campaign) + '</div>' : ''); } },
          { label: 'Last touch', key: 'lt_platform', html: function (r) { return esc(r.lt_platform || 'Not tracked') + (r.lt_campaign ? '<div class="muted small">' + esc(r.lt_campaign) + (r.lt_ad_id ? ' · ad ' + esc(r.lt_ad_id) : '') + '</div>' : ''); } },
          { label: 'Touches', key: 'touches', num: true, fmt: n },
          { label: 'Stages', key: 'stages', html: function (r) { return (r.stages || []).filter(function (s) { return !/^(chapter|poll|question|attended_day|zoom_joined)$/.test(s); }).map(function (s) { return '<span class="wa-pill">' + esc(s.replace(/_/g, ' ')) + '</span>'; }).join(''); } },
          { label: 'Paid (net)', key: 'revenue', num: true, fmt: function (v) { return money(v); } }],
        d.people || [], { cards: true, empty: 'No data yet', rowAttr: function (r) { return 'class="click" tabindex="0" data-wa-lead="' + esc(r.lead_id) + '"'; } }) + '<div data-wa-journey></div></div>';

      view.innerHTML = bar + setup + tiles + funnel + revenue + ttp + room + cohort + peopleHtml;
      drawCharts(view, d.room);

      view.querySelectorAll('[data-wa-funnel]').forEach(function (b) { b.onclick = function () { st.funnel = b.getAttribute('data-wa-funnel'); remember(); render(ctx); }; });
      view.querySelectorAll('[data-wa-model]').forEach(function (b) { b.onclick = function () { st.model = b.getAttribute('data-wa-model'); remember(); render(ctx); }; });
      view.querySelectorAll('[data-wa-cohort]').forEach(function (b) { b.onclick = function () { st.cohort = b.getAttribute('data-wa-cohort'); remember(); render(ctx); }; });
      var dimSel = view.querySelector('[data-wa-dim]'); if (dimSel) dimSel.onchange = function () { st.dim = dimSel.value; remember(); render(ctx); };
      var sync = view.querySelector('[data-wa-sync]'); if (sync) sync.onclick = function () { sync.disabled = true; ctx.send('POST', 'attribution/sync', {}).then(function () { toast('Rebuilt from all data.'); render(ctx); }); };
      view.querySelectorAll('[data-wa-zoom]').forEach(function (b) { b.onclick = function () { b.disabled = true; ctx.send('POST', 'attribution/zoom/' + encodeURIComponent(b.getAttribute('data-wa-zoom')), {}).then(function (r) { toast(r.ok ? 'Zoom: ' + r.matched + ' of ' + r.participants + ' participants matched.' : r.error); render(ctx); }); }; });
      view.querySelectorAll('[data-wa-lead]').forEach(function (row) {
        var open = function () { showJourney(ctx, view.querySelector('[data-wa-journey]'), row.getAttribute('data-wa-lead'), money); };
        row.onclick = open; row.onkeydown = function (e) { if (e.key === 'Enter') open(); };
      });
    });
  }

  function roomHtml(R, esc, n, pct, table, emptyState) {
    var out = '';
    var buyCols = [{ label: 'Minutes watched', key: 'label' }, { label: 'Viewers', key: 'viewers', num: true, fmt: n }, { label: 'Buyers', key: 'buyers', num: true, fmt: n }, { label: 'Buy rate', key: 'rate', num: true, fmt: function (v) { return pct(v); } }];
    var around = function (a) { return a ? '<p class="muted small">Still watching around the offer: ' + a.map(function (x) { return 'minute ' + x.minute + ' ' + (x.share == null ? '–' : pct(x.share)); }).join(' · ') + '</p>' : ''; };
    if (R.auto) {
      var eds = R.auto.editions || [];
      out += '<div class="card wa-card"><h2>Automated webinar: retention per minute</h2><p class="wa-sub">Share of people in the room (live showing or replay) with each minute on screen, per edition. The dashed line is the offer unlock.</p>' +
        (eds.length ? '<svg class="wa-chart" data-wa-curve="auto" viewBox="0 0 640 200" role="img" aria-label="Retention per minute"></svg><div class="wa-legend">' + eds.map(function (e, i) { return '<span><i style="background:' + COLORS[i % COLORS.length] + '"></i>' + esc(e.edition) + ' (' + n(e.viewers) + ' viewers)</span>'; }).join('') + '</div>' +
          eds.map(function (e) { return '<h3 style="margin:14px 0 4px;font-size:14px">Edition: ' + esc(e.edition) + '</h3>' + around(e.aroundUnlock) + table(buyCols, e.buyByMinutes, { cards: 3 }); }).join('')
          : emptyState('No data yet', 'Appears once people watch the masterclass.')) + '</div>';
    }
    if (R.live) {
      var evs = R.live.events || [];
      out += '<div class="card wa-card"><h2>Live webinar: retention per minute</h2><p class="wa-sub">From the companion room, per live event. The dashed line is when the host opened the offer.</p>' +
        (evs.length ? evs.map(function (e, i) {
          return '<h3 style="margin:14px 0 4px;font-size:14px">' + esc(e.title) + ' <span class="muted small">' + n(e.registrants) + ' registered · ' + n(e.attended) + ' attended · ' + n(e.viewers) + ' with room minutes</span></h3>' +
            (e.viewers ? '<svg class="wa-chart" data-wa-curve="live" data-i="' + i + '" viewBox="0 0 640 160" role="img" aria-label="Retention per minute"></svg>' : '<p class="muted small">No room minutes yet.</p>') +
            around(e.aroundUnlock) + table(buyCols, e.buyByMinutes, { cards: 3 }) +
            '<p class="muted small">' + esc(e.zoomNote) + ' <button class="btn-sm ghost" type="button" data-wa-zoom="' + esc(e.id) + '">Import Zoom attendance</button></p>';
        }).join('') : emptyState('No data yet', 'Appears after a live event in the range.')) + '</div>';
    }
    if (R.challenge) {
      var days = R.challenge.days || [];
      out += '<div class="card wa-card"><h2>Challenge: attendance and homework per day</h2>' + (days.some(function (x) { return x.attended || x.homework; }) ? table([{ label: 'Day', key: 'day' }, { label: 'Attended', key: 'attended', num: true, fmt: n }, { label: 'Homework submitted', key: 'homework', num: true, fmt: n }], days, { cards: 3 }) : emptyState('No data yet', 'Appears once a cohort runs.')) + '</div>';
    }
    var P = R.predictors;
    if (P) {
      out += '<div class="card wa-card"><h2>What predicts buying</h2><p class="wa-sub">' + esc(P.note) + ' Everyone who attended: ' + n(P.viewers) + ', buyers ' + n(P.buyers) + ', buy rate ' + pct(P.baseRate) + '.</p>' +
        table([{ label: 'Chapter reached or poll answer', key: 'label', html: function (r) { return '<span class="wa-pill">' + esc(r.kind) + '</span>' + esc(r.label); } }, { label: 'People', key: 'people', num: true, fmt: n }, { label: 'Buyers', key: 'buyers', num: true, fmt: n }, { label: 'Buy rate', key: 'rate', num: true, fmt: function (v) { return pct(v); } }, { label: 'Lift', key: 'lift', num: true, fmt: function (v) { return v == null ? '–' : v.toFixed(2) + 'x'; } }],
          P.rows || [], { cards: true, empty: 'No data yet', emptyHint: 'Needs people who attended, with chapters reached or polls answered.' }) + '</div>';
    }
    return out;
  }

  function drawCharts(view, R) {
    view.querySelectorAll('[data-wa-curve]').forEach(function (svg) {
      var kind = svg.getAttribute('data-wa-curve');
      var series = kind === 'auto' ? (R.auto.editions || []) : [(R.live.events || [])[Number(svg.getAttribute('data-i'))]];
      var vb = svg.viewBox.baseVal, W = vb.width, H = vb.height, P = { l: 36, r: 10, t: 10, b: 22 };
      var len = Math.max.apply(null, series.map(function (s) { return s.len; }).concat([1]));
      var x = function (m) { return P.l + (m / Math.max(1, len - 1)) * (W - P.l - P.r); };
      var y = function (v) { return P.t + (1 - v) * (H - P.t - P.b); };
      var g = '';
      [0, 0.25, 0.5, 0.75, 1].forEach(function (v) { g += '<line x1="' + P.l + '" x2="' + (W - P.r) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="var(--grid,#e5e5e5)" stroke-width="1"/><text x="' + (P.l - 6) + '" y="' + (y(v) + 4) + '" text-anchor="end" font-size="10" fill="var(--muted,#888)">' + Math.round(v * 100) + '%</text>'; });
      for (var m = 0; m < len; m += Math.max(5, Math.round(len / 8 / 5) * 5)) g += '<text x="' + x(m) + '" y="' + (H - 6) + '" text-anchor="middle" font-size="10" fill="var(--muted,#888)">' + m + '</text>';
      series.forEach(function (s, i) {
        if (!s || !s.curve || !s.curve.length) return;
        var c = kind === 'auto' ? COLORS[i % COLORS.length] : COLORS[0];
        g += '<polyline fill="none" stroke="' + c + '" stroke-width="2" points="' + s.curve.map(function (v, k) { return x(k).toFixed(1) + ',' + y(v).toFixed(1); }).join(' ') + '"/>';
        if (s.unlockAt != null && s.unlockAt < len) g += '<line x1="' + x(s.unlockAt) + '" x2="' + x(s.unlockAt) + '" y1="' + P.t + '" y2="' + (H - P.b) + '" stroke="' + c + '" stroke-dasharray="4 3" stroke-width="1"/>';
      });
      svg.innerHTML = g;
    });
  }

  function showJourney(ctx, box, leadId, money) {
    var esc = ctx.esc, when = ctx.when;
    box.innerHTML = '<div class="wa-journey muted">Loading…</div>';
    ctx.api('attribution/journey/' + encodeURIComponent(leadId), {}, { noRange: true }).then(function (j) {
      if (!j || j.error) { box.innerHTML = '<div class="wa-journey">' + esc((j && j.error) || 'Not found') + '</div>'; return; }
      var items = [];
      (j.touches || []).forEach(function (t) { items.push({ ts: t.ts, html: '<strong>Visit</strong> ' + esc(t.platform || t.channel || 'Direct') + (t.campaign ? ' · ' + esc(t.campaign) : '') + (t.ad_id ? ' · ad ' + esc(t.ad_id) : '') + (t.link_code ? ' · link ' + esc(t.link_code) : '') + ' <span class="muted">' + esc(t.landing || '') + (t.device ? ' · ' + esc(t.device) : '') + (t.country ? ' · ' + esc(t.country) : '') + '</span>' }); });
      (j.conversions || []).forEach(function (c) { items.push({ ts: c.occurred_at, html: '<strong>' + esc((STAGE_NAMES[c.kind] || c.kind) + (c.kind === 'registered' ? '' : ' paid')) + '</strong> · ' + esc(c.funnel) + (c.net ? ' · ' + esc(money(c.net, 2)) : '') + ' <span class="muted">last touch ' + esc(c.lt_platform || 'not tracked') + (c.lt_campaign ? ' / ' + esc(c.lt_campaign) : '') + ', first touch ' + esc(c.ft_platform || 'not tracked') + '</span>' }); });
      (j.stages || []).forEach(function (s) { if (s.stage === 'registered' || /_paid$|engagement_signed/.test(s.stage)) return; items.push({ ts: s.ts, html: esc(s.stage.replace(/_/g, ' ')) + (s.detail ? ' <span class="muted">' + esc(s.detail) + '</span>' : '') + (s.stage === 'attended' && s.value ? ' <span class="muted">' + esc(s.value) + ' min</span>' : '') }); });
      items.sort(function (a, b) { return a.ts - b.ts; });
      box.innerHTML = '<div class="wa-journey"><div class="wa-bar"><h2 style="margin:0">' + esc(j.lead.name || 'Lead') + '</h2><a class="btn-sm ghost" href="' + esc(j.lead.url) + '">Open lead</a></div>' +
        (items.length ? '<ul class="wa-tl">' + items.map(function (i) { return '<li><span class="t">' + esc(when(i.ts)) + '</span><span>' + i.html + '</span></li>'; }).join('') + '</ul>' : '<p class="muted">No data yet</p>') + '</div>';
      box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  root.WebinarAttribution = { render: render };
})(window);
