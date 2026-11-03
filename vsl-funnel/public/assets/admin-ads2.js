/* Funnel HQ, ads round 2 (loaded before admin-autopilot.js's render runs and before admin.js):
   - Ads autopilot → "Offer copy check": the value equation (dream outcome, likelihood, time to first result,
     effort) over every offer page, offer email and room offer card, with suggested lines built only from facts we
     may state. Suggestions only: nothing is edited for you.
   - Ads autopilot → Concept testing → "Results by industry" (concept rounds drafted per industry lander).
   - Meta audiences → "Halo retargeting map": each engaged state, its audiences (created only through Create all
     in Meta, an approval in Command) and the recommended next-step concept; "Draft 3 ads" queues a launch for approval. */
(function (root) {
  'use strict';
  var CSS = '.a2-card{margin-top:14px}.a2-head{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:baseline;justify-content:space-between}.a2-head h2{margin:0}' +
    '.a2-lede{margin:6px 0 0;color:var(--muted,#6e6e73);max-width:72ch;font-size:14px}' +
    '.a2-surf{border-top:1px solid var(--border,#e5e5ea);padding:12px 0}.a2-surf:first-of-type{border-top:0}.a2-surf h3{margin:0;font-size:15px}' +
    '.a2-parts{display:flex;flex-wrap:wrap;gap:4px;margin:6px 0}.a2-part{font-size:12px;border-radius:999px;padding:2px 9px;background:#e7f4ec;color:#1d6b42}.a2-part.miss{background:#f5f5f7;color:#6e6e73;box-shadow:inset 0 0 0 1px #d2d2d7}' +
    '.a2-sug{margin:6px 0 0;padding:0;list-style:none}.a2-sug li{padding:8px 0;border-top:1px solid #f0f0f2;font-size:13px}.a2-sug b{color:#0f2c5c;font-weight:600}.a2-sug p{margin:2px 0;color:var(--ink-2,#3a3a3c)}' +
    '.a2-line{display:flex;gap:8px;align-items:flex-start;margin:4px 0}.a2-line span{flex:1;background:#f5f5f7;border-radius:8px;padding:6px 8px}' +
    '.a2-t{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}.a2-t th,.a2-t td{padding:8px 6px;border-top:1px solid var(--border,#e5e5ea);text-align:left;vertical-align:top}.a2-t th{font-weight:600;color:#0f2c5c;font-size:12px}.a2-t .num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}' +
    '.a2-t td small{display:block;color:var(--muted,#6e6e73);font-size:12px;margin-top:2px}.a2-g{font-size:12px;font-weight:600;color:#0f2c5c;text-transform:uppercase;letter-spacing:.04em;padding-top:16px!important;border-top:0!important}' +
    '.a2-pill{display:inline-block;padding:2px 8px;border-radius:99px;font-size:12px;background:#f5f5f7;color:#3a3a3c;white-space:nowrap;margin:0 4px 2px 0}.a2-pill.created{background:#e7f4ec;color:#1d6b42}.a2-pill.queued{background:#eef2f8;color:#0f2c5c}.a2-pill.error{background:#fdecea;color:#a1271b}' +
    '.a2-chips{display:flex;flex-wrap:wrap;gap:4px;margin:4px 0}.a2-chip{font-size:12px;border-radius:999px;padding:1px 8px;background:#f5f5f7;color:#3a3a3c}' +
    '.a2-paste{display:grid;gap:8px;margin-top:10px}.a2-paste textarea{width:100%;min-height:96px;box-sizing:border-box}.a2-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}' +
    '@media (max-width:760px){.a2-t thead{display:none}.a2-t tr{display:grid;grid-template-columns:1fr 1fr;gap:2px 10px;padding:8px 0;border-top:1px solid var(--border,#e5e5ea)}.a2-t td{border:0;padding:2px 0}.a2-t td.num{text-align:left}.a2-t td.wide{grid-column:1/-1}.a2-t td[data-l]:before{content:attr(data-l) " ";color:#6e6e73}.a2-t tr.a2-gr{display:block}}';
  function css() { if (!document.getElementById('a2-css')) { var st = document.createElement('style'); st.id = 'a2-css'; st.textContent = CSS; document.head.appendChild(st); } }
  function copyText(text, toast) { (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast('Copied'); }, function () { window.prompt('Copy this', text); }); }
  var KIND = { page: 'Page', email: 'Email', room: 'Room' };
  var STATUS = { not_created: 'Not created', queued: 'Queued', created: 'In Meta', syncing: 'Syncing', error: 'Error', not_in_plan: 'Waits for ad videos' };
  var LABEL = {
    desire: { profit_no_hours: 'More profit without more hours', runs_without_you: 'Runs without you', group_exit: 'Group exit', be_the_buyer: 'Be the buyer', break_ceiling: 'Past the ceiling', deploy_capital: 'Capital into cash flow' },
    awareness: { unaware: 'Unaware', problem: 'Problem aware', solution: 'Solution aware', product: 'Product aware', most: 'Most aware' },
    format: { static: 'Static', talking_head: 'Founder talking head', podcast_clip: 'Podcast clip', double_hook: 'Double hook', mechanism: 'Mechanism explainer', mini_vsl: 'Mini-VSL' },
    framework: { pas: 'Problem, agitate, solve', contrarian: 'Common belief, then why it is wrong', third_way: 'A third way', not_your_fault: 'Not your fault', cost_of_waiting: 'Cost of waiting', mechanism: 'Mechanism first' },
  };

  // ───────────── Offer copy check (value equation) ─────────────
  function surfaceHtml(ctx, s) {
    var esc = ctx.esc;
    var parts = s.elements.map(function (e) { return '<span class="a2-part' + (e.present ? '' : ' miss') + '" title="' + esc(e.evidence || 'Not found') + '">' + (e.present ? '' : 'Missing: ') + esc(e.label) + '</span>'; }).join('');
    var sug = s.suggestions.map(function (g) {
      return '<li><b>' + esc(g.label) + '</b><p>' + esc(g.advice) + '</p>' + g.lines.map(function (l) { return '<div class="a2-line"><span>' + esc(l) + '</span><button class="btn-sm ghost" data-a2-copy="' + esc(l) + '">Copy</button></div>'; }).join('') + '</li>';
    }).join('');
    return '<div class="a2-surf"><div class="a2-head"><h3>' + esc(s.label) + '</h3><span class="muted small">' + esc(KIND[s.kind] || s.kind) + (s.edited ? ' · your edited version' : '') + (s.edit ? ' · <a href="/admin' + esc(s.edit) + '">open</a>' : '') + '</span></div>' +
      '<div class="a2-parts">' + parts + '</div>' + (sug ? '<details' + (s.missing >= 2 ? ' open' : '') + '><summary class="muted small">' + s.missing + ' to add, with lines you may use</summary><ul class="a2-sug">' + sug + '</ul></details>' : '<p class="muted small" style="margin:2px 0">All four parts are there.</p>') + '</div>';
  }
  function offerCheck(ctx, box) {
    if (!box) return;
    css();
    var esc = ctx.esc, toast = ctx.toast;
    return ctx.api('autopilot/value-equation', {}, { noRange: true }).then(function (d) {
      var sm = d.summary;
      var gaps = d.elements.map(function (e) { return '<span class="a2-chip">' + esc(e.label) + ': ' + (sm.missing[e.id] || 0) + ' missing</span>'; }).join('');
      var sorted = d.surfaces.slice().sort(function (a, b) { return b.missing - a.missing; });
      box.innerHTML = '<div class="card a2-card"><div class="a2-head"><h2>Offer copy check</h2><span class="muted">' + sm.complete + ' of ' + sm.surfaces + ' offer surfaces carry all four parts of the value equation</span></div>' +
        '<p class="a2-lede">Dream outcome × likelihood, over time to the first result × effort. Each offer page, offer email and room offer card is read as it is now. Missing parts come with lines built only from facts we may state: the guarantee as worded with its conditions, the method, Josh’s two seller-financed acquisitions, the deposit credit and the real schedule. ' + esc(d.note) + '</p>' +
        '<div class="a2-chips">' + gaps + '</div>' + sorted.map(function (s) { return surfaceHtml(ctx, s); }).join('') +
        '<form class="a2-paste" data-a2-paste><label class="muted small" for="a2-paste-t">Check any copy (an ad, a page draft)</label><textarea id="a2-paste-t" class="input" name="text" placeholder="Paste copy here"></textarea>' +
        '<div class="a2-row"><select class="input" name="product" style="max-width:240px" aria-label="Product"><option value="engagement">Engagement or deposit</option><option value="sprint">First Deal Sprint</option></select><button class="btn-sm" type="submit">Check</button></div><div data-a2-pasted></div></form></div>';
      wireCopy(box, toast);
      var f = box.querySelector('[data-a2-paste]');
      f.onsubmit = function (e) {
        e.preventDefault();
        ctx.send('POST', 'autopilot/value-equation/check', { text: f.text.value, product: f.product.value }).then(function (r) {
          var out = box.querySelector('[data-a2-pasted]');
          if (!r.ok) { toast(r.error); return; }
          out.innerHTML = surfaceHtml(ctx, r) + (r.copyIssues && r.copyIssues.length ? '<p class="ap-note">Copy rules: ' + esc(r.copyIssues.map(function (i) { return i.rule; }).join('; ')) + '</p>' : '');
          wireCopy(out, toast);
        });
      };
    }).catch(function () { box.innerHTML = '<div class="card a2-card"><p class="ap-note">The offer copy check could not load. Refresh the page.</p></div>'; });
  }
  function wireCopy(el, toast) { el.querySelectorAll('[data-a2-copy]').forEach(function (b) { b.onclick = function (e) { e.preventDefault(); copyText(b.getAttribute('data-a2-copy'), toast); }; }); }

  // ───────────── Results by industry (inside Concept testing) ─────────────
  function industryTable(ctx, d, metricCells) {
    var esc = ctx.esc, n = ctx.n;
    var rows = (d.byIndustry || []).map(function (x) { return '<tr><td>' + esc(x.label) + '<div class="ap-why">' + n(x.rounds) + ' round' + (x.rounds === 1 ? '' : 's') + ', ' + n(x.ads) + ' ads</div></td>' + metricCells(x) + '</tr>'; }).join('');
    return '<div class="ap-head" style="margin-top:16px"><h3 style="margin:0;font-size:15px">Results by industry</h3><span class="muted small">Industry rounds point at that industry’s lander through the smart route</span></div>' +
      (rows ? '<div class="table-wrap"><table class="ap-table"><thead><tr><th>Industry</th><th class="num">Spend</th><th class="num">Registrants</th><th class="num">Buyers</th><th class="num">Revenue</th><th class="num">Per registrant</th><th class="num">Per buyer</th><th class="num">ROAS</th><th class="num">Hook</th><th class="num">Hold</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
        : '<p class="muted">Pick an industry when you plan a round to test concepts per industry.</p>');
  }

  // ───────────── Halo retargeting map (Meta audiences) ─────────────
  function halo(ctx, box) {
    if (!box) return;
    css();
    var esc = ctx.esc, n = ctx.n, toast = ctx.toast, when = ctx.when;
    return ctx.api('audiences/halo', {}, { noRange: true }).then(function (d) {
      var group = null;
      var rows = d.states.map(function (s) {
        var g = s.group !== group ? '<tr class="a2-gr"><td colspan="3" class="a2-g">' + esc(s.group) + '</td></tr>' : '';
        group = s.group;
        var auds = s.audiences.map(function (a) { return '<div><span class="a2-pill ' + esc(a.status) + '">' + esc(STATUS[a.status] || a.status) + '</span>' + esc(a.name) + (a.ours != null ? ' <small>' + n(a.ours) + ' people in our data</small>' : '') + '</div>'; }).join('');
        var c = s.concept;
        var chips = '<div class="a2-chips"><span class="a2-chip">' + esc(LABEL.desire[c.desire] || c.desire) + '</span><span class="a2-chip">' + esc(LABEL.awareness[c.awareness] || c.awareness) + '</span><span class="a2-chip">' + esc(LABEL.format[c.format] || c.format) + '</span><span class="a2-chip">' + esc(LABEL.framework[c.framework] || c.framework) + '</span></div>';
        var act = s.round ? '<span class="muted small">' + esc(s.round.label) + ': ' + esc(s.round.status) + ', ' + esc(when(s.round.created_at)) + '</span>' : '<button class="btn-sm ghost" data-a2-halo="' + esc(s.id) + '">Draft 3 ads</button>';
        return g + '<tr><td class="wide" data-l="State"><b>' + esc(s.label) + '</b><small>' + esc(s.nextStep) + '</small></td><td class="wide" data-l="Audiences">' + auds + '</td>' +
          '<td class="wide" data-l="Next-step concept">' + chips + '<small>Angle: ' + esc(c.angle) + '</small>' + (s.sampleHook ? '<small>Sample hook: ' + esc(s.sampleHook) + '</small>' : '') + '<div style="margin-top:6px">' + act + '</div></td></tr>';
      }).join('');
      box.innerHTML = '<div class="card a2-card"><div class="a2-head"><h2>Halo retargeting map</h2><span class="muted">' + n(d.states.length) + ' engaged states, each with its own next-step creative</span></div>' +
        '<p class="a2-lede">People who are not ready today see the next piece of the argument, not the same cold ad again. The audiences are created in Meta only through Create all in Meta, an approval in Command; customer lists hold only people with marketing consent. Draft 3 ads writes one concept for that state and queues its launch for your approval. Ads never say what the reader did.</p>' +
        '<table class="a2-t"><thead><tr><th>Engaged state</th><th>Audiences</th><th>Recommended concept</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
      box.querySelectorAll('[data-a2-halo]').forEach(function (b) {
        b.onclick = function () {
          b.disabled = true; b.textContent = 'Drafting…';
          ctx.send('POST', 'audiences/halo/' + encodeURIComponent(b.getAttribute('data-a2-halo')) + '/draft', {}).then(function (r) {
            toast(r && r.ok ? r.ads + ' ads drafted. The launch waits in Ads autopilot → Proposed changes.' : (r && r.error) || 'Could not draft');
            halo(ctx, box);
          });
        };
      });
    }).catch(function () { box.innerHTML = '<div class="card a2-card"><p class="ap-note">The halo map could not load. Refresh the page.</p></div>'; });
  }

  root.Ads2 = { offerCheck: offerCheck, industryTable: industryTable, halo: halo };
})(window);
