/* Funnel HQ → Live & webinars → Quiz: the acquisition readiness quiz (/quiz). The funnel per step with drop-off,
   completion, archetype mix, score distribution, the gaps people have, quiz → seat → attended → bought, and the
   list of quiz leads. Read only (guest links see it too). Loaded before admin.js; admin.js calls QuizBoard.render(ctx). */
(function (root) {
  'use strict';
  var CSS = '.qzb{display:grid;gap:14px}.qzb-steps{display:grid;gap:2px}.qzb-step{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,2fr) 64px 72px;gap:12px;align-items:center;padding:7px 0;border-bottom:1px solid var(--border,#e5e7eb);font-size:13px}' +
    '.qzb-step:last-child{border-bottom:0}.qzb-step .l{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.qzb-step .t{height:8px;border-radius:4px;background:var(--surface-2,#f2f3f5);overflow:hidden}.qzb-step .t i{display:block;height:100%;background:#0f2c5c;border-radius:4px}' +
    '.qzb-step .n{text-align:right;font-variant-numeric:tabular-nums;font-weight:600}.qzb-step .d{text-align:right;font-variant-numeric:tabular-nums;color:var(--muted,#6e6e73);font-size:12px}.qzb-step.warn .d{color:#b42318}' +
    '.qzb-step.sec{padding-top:12px}.qzb-2{display:grid;gap:14px}@media (min-width:900px){.qzb-2{grid-template-columns:1fr 1fr}}' +
    '.qzb-dist{display:flex;align-items:flex-end;gap:10px;height:132px;padding-top:6px}.qzb-dist div{flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;height:100%;justify-content:flex-end;font-size:12px;color:var(--muted,#6e6e73)}' +
    '.qzb-dist b{display:block;width:100%;background:#0f2c5c;border-radius:4px 4px 0 0;min-height:2px}.qzb-dist span{font-variant-numeric:tabular-nums;color:var(--ink,#1d1d1f);font-weight:600}' +
    '.qzb-pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11.5px;background:var(--surface-2,#f2f3f5)}.qzb-pill.ok{background:#e7f4ec;color:#1d7a4f}.qzb-links{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}' +
    '@media (max-width:640px){.qzb-step{grid-template-columns:minmax(0,1fr) 40px 56px!important;row-gap:6px}.qzb-step .l{grid-column:1/-1;white-space:normal}.qzb-step .t{grid-column:1}}';

  function render(ctx) {
    var view = ctx.view, esc = ctx.esc, n = ctx.n, pct = ctx.pct, when = ctx.when, tile = ctx.tile, table = ctx.table;
    if (!document.getElementById('qzb-css')) { var st = document.createElement('style'); st.id = 'qzb-css'; st.textContent = CSS; document.head.appendChild(st); }
    return ctx.api('quiz').then(function (d) {
      if (!d || !d.steps) { view.innerHTML = '<div class="card">' + ctx.emptyState('Couldn’t load the quiz numbers.', 'Refresh the page.') + '</div>'; return; }
      var k = d.kpis || {};
      var rate = function (v) { return v == null ? '–' : pct(v); };
      var tiles = '<div class="grid g-4 tiles">' +
        tile('Started', n(k.started), 'quizzes in this period') +
        tile('Completion', rate(k.completion), 'answered all ten') +
        tile('Leads', n(k.leads), rate(k.leadRate) + ' of starts gave an email') +
        tile('Saved a seat', n(k.registered), rate(k.registerRate) + ' of quiz leads') +
        '</div><div class="grid g-4 tiles" style="margin-top:14px">' +
        tile('Attended', n(k.attended), 'live or replay') +
        tile('Bought', n(k.bought), 'Sprint, deposit or won deal') +
        tile('Average score', k.avgScore == null ? '–' : String(k.avgScore), 'out of 100') +
        tile('Target', d.target === 'live' ? 'Live event' : 'Masterclass', 'where Save my seat registers') +
        '</div>';

      var max = Math.max.apply(null, d.steps.map(function (s) { return s.n; }).concat([1]));
      var steps = '<div class="card"><h2>Step by step</h2><p class="sub">Each step counts quizzes started in the range that reached it. The right column is the drop from the step before.</p><div class="qzb-steps">' +
        d.steps.map(function (s) {
          var warn = s.rate != null && s.rate < 0.7 && s.key !== 'landing' && s.key !== 'started';
          var sec = s.key === 'gate' || s.key === 'registered' || s.key === 'q1';
          return '<div class="qzb-step' + (warn ? ' warn' : '') + (sec ? ' sec' : '') + '"><span class="l" title="' + esc(s.label) + '">' + esc(s.label) + '</span><span class="t"><i style="width:' + (s.n / max * 100).toFixed(1) + '%"></i></span><span class="n">' + n(s.n) + '</span><span class="d">' + (s.rate == null ? '' : (s.drop ? '−' + n(s.drop) + ' · ' : '') + pct(s.rate)) + '</span></div>';
        }).join('') + '</div></div>';

      var archTotal = d.archetypes.reduce(function (t, a) { return t + a.n; }, 0);
      var arch = '<div class="card"><h2>Archetype mix</h2><p class="sub">Quiz leads by the buyer type their answers gave. Each lead is tagged quiz:&lt;type&gt; for email segments.</p>' +
        (archTotal ? '<div class="qzb-steps">' + d.archetypes.map(function (a) {
          return '<div class="qzb-step" style="grid-template-columns:minmax(170px,1.4fr) minmax(0,2fr) 40px 56px"><span class="l">' + esc(a.name) + '</span><span class="t"><i style="width:' + (archTotal ? a.n / archTotal * 100 : 0).toFixed(1) + '%"></i></span><span class="n">' + n(a.n) + '</span><span class="d">' + (a.avg == null ? '' : 'avg ' + a.avg) + '</span></div>';
        }).join('') + '</div>' : ctx.emptyState('No quiz leads yet', 'Archetypes show once people pass the email gate.')) + '</div>';

      var dmax = Math.max.apply(null, d.scores.map(function (s) { return s.n; }).concat([1]));
      var dist = '<div class="card"><h2>Score distribution</h2><p class="sub">Readiness scores of quiz leads, out of 100.</p>' +
        (archTotal ? '<div class="qzb-dist">' + d.scores.map(function (s) { return '<div><span>' + n(s.n) + '</span><b style="height:' + Math.max(2, s.n / dmax * 96).toFixed(0) + 'px"></b>' + esc(s.label) + '</div>'; }).join('') + '</div>' : ctx.emptyState('No scores yet')) + '</div>';

      var gmax = Math.max.apply(null, d.gaps.map(function (g) { return g.n; }).concat([1]));
      var gaps = '<div class="card"><h2>Gaps</h2><p class="sub">How often each gap was one of a lead’s top two.</p>' + (archTotal ? '<div class="qzb-steps">' + d.gaps.map(function (g) {
        return '<div class="qzb-step" style="grid-template-columns:minmax(200px,1.6fr) minmax(0,2fr) 40px"><span class="l">' + esc(g.title) + '</span><span class="t"><i style="width:' + (g.n / gmax * 100).toFixed(1) + '%"></i></span><span class="n">' + n(g.n) + '</span></div>';
      }).join('') + '</div>' : ctx.emptyState('No gaps yet')) + '</div>';

      var leads = '<div class="card"><h2>Quiz leads</h2><p class="sub">The latest 200 in the range. Click a name for the full journey.</p>' + table([
        { label: 'When', nw: true, html: function (l) { return esc(when(l.lead_at)); } },
        { label: 'Who', html: function (l) { return '<a href="#lead=' + esc(l.lead_id) + '" data-qzb-lead="' + esc(l.lead_id) + '">' + esc(l.name || l.email || 'lead') + '</a>'; } },
        { label: 'Type', html: function (l) { return esc(l.archetypeName || ''); } },
        { label: 'Score', num: true, html: function (l) { return esc(l.score); } },
        { label: 'Revenue', nw: true, html: function (l) { return esc(l.band || ''); } },
        { label: 'Top gaps', html: function (l) { return esc((l.gaps || []).join(', ')); } },
        { label: 'Seat', html: function (l) { return l.registered_at ? '<span class="qzb-pill ok">' + esc(l.target === 'live' ? 'Live' : 'Masterclass') + '</span>' : '<span class="qzb-pill">No</span>'; } },
        { label: 'Attended', html: function (l) { return l.attended ? 'Yes' : ''; } },
        { label: 'Bought', html: function (l) { return l.bought ? 'Yes' : ''; } },
        { label: 'Source', html: function (l) { return esc([l.channel, l.campaign].filter(Boolean).join(' · ')); } },
      ], d.leads || [], { cards: true, empty: 'No quiz leads in this range', emptyHint: 'People appear here when they pass the email gate.' }) + '</div>';

      var links = '<div class="card"><h2>The quiz</h2><p class="sub">Ten questions, the email gate, then the result with one action: Save my seat. Share it as /quiz on either domain.</p><div class="qzb-links">' +
        '<a class="btn-sm" href="/quiz" target="_blank" rel="noopener" data-qzb-open>Open the quiz ↗</a>' +
        '<a class="btn-sm ghost" href="/quiz?hq_preview=1&amp;hq_step=gate" target="_blank" rel="noopener">Preview the gate ↗</a>' +
        '<a class="btn-sm ghost" href="/quiz/r/preview?hq_preview=1" target="_blank" rel="noopener">Preview a result ↗</a></div></div>';

      view.innerHTML = '<div class="qzb">' + tiles + steps + '<div class="qzb-2">' + arch + dist + '</div><div class="qzb-2">' + gaps + links + '</div>' + leads + '</div>';
      view.querySelectorAll('[data-qzb-lead]').forEach(function (a) { a.onclick = function (ev) { ev.preventDefault(); if (ctx.openLead) ctx.openLead(a.getAttribute('data-qzb-lead')); }; });
    });
  }

  root.QuizBoard = { render: render };
})(window);
