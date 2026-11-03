/* Funnel HQ → Meta audiences: the custom conversions and audiences planned for Meta (one per booking, registration
   and purchase variant), how many people each holds in our own data, their state in Meta, the setup checklist,
   "Create all in Meta" (a proposal in Command that only your approval carries out), lookalike proposals, the
   predicted booking value (an estimate) and which conversion each campaign should optimise on.
   Loaded before admin.js, which calls MetaAudiences.render(ctx) with its helpers (api, send, esc, tile, …). */
(function (root) {
  'use strict';
  var CSS = '.mau-card{margin-top:14px}.mau-lede{margin:6px 0 0;color:var(--muted,#6e6e73);max-width:72ch;font-size:14px}' +
    '.mau-steps{list-style:none;margin:10px 0 0;padding:0}.mau-steps li{display:grid;grid-template-columns:22px 1fr;gap:4px 10px;padding:10px 0;border-top:1px solid var(--border,#e5e5ea)}' +
    '.mau-steps li:first-child{border-top:0}.mau-dot{width:16px;height:16px;border-radius:50%;margin-top:2px;box-shadow:inset 0 0 0 1.5px #c7c7cc}.mau-steps li.done .mau-dot{background:#1d6b42;box-shadow:none}' +
    '.mau-steps b{font-weight:600}.mau-steps p{grid-column:2;margin:0;color:var(--muted,#6e6e73);font-size:13px;overflow-wrap:anywhere}.mau-steps label{grid-column:2;font-size:13px;display:flex;gap:6px;align-items:center}' +
    '[data-mau-create]:disabled{opacity:.45;cursor:not-allowed}.mau-actions{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;margin-top:14px}.mau-note{font-size:13px;color:var(--muted,#6e6e73)}' +
    '.mau-t{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}.mau-t th,.mau-t td{padding:8px 6px;border-top:1px solid var(--border,#e5e5ea);text-align:left;vertical-align:top}.mau-t th{font-weight:600;color:#0f2c5c;font-size:12px}' +
    '.mau-t .num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.mau-t td small{display:block;color:var(--muted,#6e6e73);font-size:12px;margin-top:2px}' +
    '.mau-g{font-size:12px;font-weight:600;color:#0f2c5c;text-transform:uppercase;letter-spacing:.04em;padding-top:16px!important;border-top:0!important}' +
    '.mau-pill{display:inline-block;padding:2px 8px;border-radius:99px;font-size:12px;background:#f5f5f7;color:#3a3a3c;white-space:nowrap}.mau-pill.created{background:#e7f4ec;color:#1d6b42}.mau-pill.queued,.mau-pill.syncing{background:#eef2f8;color:#0f2c5c}.mau-pill.error{background:#fdecea;color:#a1271b}' +
    '.mau-rule summary{cursor:pointer;color:#0f2c5c;font-size:12px}.mau-rule pre{white-space:pre-wrap;word-break:break-all;font-size:11px;background:#f5f5f7;border-radius:8px;padding:8px;margin:6px 0 0;max-width:520px}' +
    '.mau-filter{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}.mau-filter button{border:0;background:#f5f5f7;border-radius:99px;padding:5px 12px;font-size:13px;cursor:pointer;color:#1d1d1f}.mau-filter button[aria-pressed=true]{background:#0f2c5c;color:#fff}' +
    '.mau-rec{margin:8px 0 0;padding:0;list-style:none}.mau-rec li{padding:10px 0;border-top:1px solid var(--border,#e5e5ea);font-size:14px}.mau-rec li:first-child{border-top:0}.mau-rec span{display:block;color:var(--muted,#6e6e73);font-size:13px;margin-top:2px}' +
    '.mau-est{font-size:12px;font-weight:600;color:#8a5a00;background:#fff4dd;border-radius:99px;padding:2px 8px;margin-left:6px}' +
    '@media (max-width:700px){.mau-t thead{display:none}.mau-t tr{display:grid;grid-template-columns:1fr 1fr;gap:2px 10px;padding:8px 0;border-top:1px solid var(--border,#e5e5ea)}.mau-t td{border:0;padding:2px 0}.mau-t td.num{text-align:left}.mau-t td.wide{grid-column:1/-1}.mau-t td[data-l]:before{content:attr(data-l) " ";color:#6e6e73}.mau-t tr.mau-gr{display:block}.mau-rule pre{max-width:100%}}';

  var STATUS = { not_created: 'Not created', queued: 'Queued', created: 'In Meta', syncing: 'Syncing', error: 'Error' };
  var KIND = { conversion: 'Custom conversion', website: 'Website', list: 'Customer list', lookalike: 'Lookalike' };
  var filter = 'all';

  function render(ctx) {
    var view = ctx.view, esc = ctx.esc, n = ctx.n, when = ctx.when, tile = ctx.tile, toast = ctx.toast;
    if (!document.getElementById('mau-css')) { var st = document.createElement('style'); st.id = 'mau-css'; st.textContent = CSS; document.head.appendChild(st); }
    return ctx.api('audiences', {}, { noRange: true }).then(function (d) {
      var su = d.setup, S = d.summary;
      var pending = d.pending || [];
      var canCreate = su.ready && !pending.some(function (p) { return p.kind === 'marketing.audiences_create'; });
      var missing = su.steps.filter(function (x) { return !x.done && x.id !== 'terms' && x.id !== 'capi'; }).map(function (x) { return x.label; });

      var head = '<div class="card"><h2>Meta audiences and custom conversions</h2>' +
        '<p class="mau-lede">Every booked call, registration and purchase reaches Meta with the same parameters (product, funnel, tier, revenue band, session time, edition, source), so each variant has its own custom conversion to optimise on and its own audience for retargeting, exclusions and lookalikes. Website audiences follow the Pixel and Conversions API; customer lists come from our database, only people with marketing consent, replaced daily.</p>' +
        '<div class="grid g-4 tiles" style="margin-top:14px">' +
        tile('Custom conversions', n(S.conversions), 'one per variant') + tile('Website audiences', n(S.website), su.retentionDays + ' days retention') +
        tile('Customer lists', n(S.lists), su.syncOn ? 'replaced daily once created' : 'daily resync is off') + tile('In Meta', n(S.created), S.queued ? n(S.queued) + ' queued' : S.errors ? n(S.errors) + ' with errors' : 'created after your approval') +
        '</div>' +
        '<div class="mau-actions"><button class="btn-sm" data-mau-create' + (canCreate ? '' : ' disabled') + '>Create all in Meta</button>' +
        '<span class="mau-note">' + (pending.length ? 'Waiting for your approval in <a href="#command">Command</a>: ' + esc(pending[0].summary) + '.' : !su.ready ? 'Needs: ' + esc(missing.join(', ')) + '. Until then nothing is sent to Meta.' : 'Goes to Command as a proposal. Nothing is created until you approve it.') + '</span></div></div>';

      var steps = '<div class="card mau-card"><h2>Setup</h2><p class="sub">What Meta needs before audiences can be created.</p><ol class="mau-steps">' +
        su.steps.map(function (x) {
          return '<li class="' + (x.done ? 'done' : '') + '"><span class="mau-dot" aria-hidden="true"></span><b>' + esc(x.label) + (x.done ? '' : ' (to do)') + '</b><p>' + esc(x.detail) + '</p>' +
            (x.id === 'terms' ? '<label><input type="checkbox" data-mau-terms' + (x.done ? ' checked' : '') + '> I accepted the Custom Audience terms for this ad account</label>' : '') + '</li>';
        }).join('') + '</ol></div>';

      var bv = d.bookingValues || [];
      var value = '<div class="card mau-card"><h2>Predicted value of a booked call <span class="mau-est">Estimate</span></h2>' +
        '<p class="sub">Fee × show rate × close rate per tier. ' + (su.scheduleValue ? 'Sent as the value of each Schedule event (setting Send a predicted value with booked calls is on).' : 'Not sent to Meta: switch on Send a predicted value with booked calls under Integrations, Ads for value-based bidding on bookings.') + '</p>' +
        '<table class="mau-t"><thead><tr><th>Tier</th><th class="num">Fee</th><th class="num">Show</th><th class="num">Close</th><th class="num">Expected value</th><th>Based on</th></tr></thead><tbody>' +
        bv.map(function (t) {
          return '<tr><td data-l="Tier">' + esc(t.tier) + '</td><td class="num" data-l="Fee">' + esc(t.currency) + ' ' + n(t.fee) + '</td><td class="num" data-l="Show">' + Math.round(t.show * 100) + '%</td><td class="num" data-l="Close">' + Math.round(t.close * 100) + '%</td>' +
            '<td class="num" data-l="Value"><b>' + esc(t.currency) + ' ' + n(t.value) + '</b></td><td class="wide" data-l="Based on">' + esc(t.basis) + '</td></tr>';
        }).join('') + '</tbody></table></div>';

      // Deep-funnel signals (src/tracking/signals.ts): what was sent in the last 30 days and the value each carries.
      var sg = d.signals;
      var signals = !sg ? '' : '<div class="card mau-card"><h2>Deep-funnel signals <span class="mau-est">Values are estimates</span></h2>' +
        '<p class="sub">Custom events sent to Meta once per person per session, for the live rooms, the automated webinar and the challenge. ' +
        (sg.on ? 'Sending is on (setting Send deep-funnel signals to Meta).' : 'Sending is off: switch on Send deep-funnel signals to Meta under Integrations, Ads.') + ' ' +
        (sg.valuesOn ? 'Estimated values are sent with the room signals.' : 'No value is sent with the room signals: switch on Send estimated values with deep-funnel signals to send the estimates below.') +
        ' A signed engagement always carries its real contract fee.</p>' +
        '<table class="mau-t"><thead><tr><th>Signal</th><th>Meta event</th><th class="num">Sent, 30 days</th><th class="num">Value</th><th>Based on</th></tr></thead><tbody>' +
        sg.signals.map(function (x) {
          var v = x.value && x.value.value != null ? esc(x.value.currency) + ' ' + n(x.value.value) : x.id === 'contract_signed' ? 'Contract fee' : 'None';
          return '<tr><td data-l="Signal">' + esc(x.label) + '</td><td data-l="Meta event"><code>' + esc(x.meta) + '</code></td><td class="num" data-l="Sent">' + n(x.sent) + (x.noConsent ? ' <span class="sub">(' + n(x.noConsent) + ' kept first-party, no consent)</span>' : '') + '</td>' +
            '<td class="num" data-l="Value">' + v + '</td><td class="wide" data-l="Based on">' + esc(x.value ? x.value.basis : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>';

      var rec = '<div class="card mau-card"><h2>Which conversion each campaign should optimise on</h2><p class="sub">' + esc(d.learningNote) + '</p><ul class="mau-rec">' +
        d.recommendations.map(function (r) { return '<li><b>' + esc(r.campaign) + '</b>: ' + esc(r.optimise) + '<span>Then: ' + esc(r.then) + '</span></li>'; }).join('') + '</ul></div>';

      var kinds = [['all', 'All'], ['conversion', 'Custom conversions'], ['website', 'Website'], ['list', 'Customer lists'], ['lookalike', 'Lookalikes']];
      var items = d.items.filter(function (i) { return filter === 'all' || i.kind === filter; });
      var lastGroup = null;
      var rows = items.map(function (i) {
        var g = i.kind === 'conversion' ? 'Custom conversions: ' + i.group : i.group;
        var gh = g !== lastGroup ? '<tr class="mau-gr"><td colspan="6" class="mau-g">' + esc(g) + '</td></tr>' : '';
        lastGroup = g;
        var ours = i.ours ? '<b>' + n(i.ours.n) + '</b>' + (i.ours.excluded.length ? '<small>' + i.ours.excluded.map(function (x) { return n(x.n) + ' left out: ' + esc(x.reason.toLowerCase()); }).join('; ') + '</small>' : '') : '<span class="muted">' + (i.kind === 'conversion' ? 'counts in Meta' : 'from the source list') + '</span>';
        var size = i.size ? n(i.size.lower) + (i.size.upper && i.size.upper !== i.size.lower ? ' to ' + n(i.size.upper) : '') + '<small>checked ' + esc(when(i.size.at)) + '</small>' : '<span class="muted">' + (i.status === 'created' ? 'not checked yet' : 'not in Meta') + '</span>';
        var act = '';
        if (i.kind === 'list' && i.status === 'created') act += '<button class="btn-sm ghost" data-mau-sync="' + esc(i.key) + '">Sync now</button>';
        if (i.kind === 'list' && /^list_(buyers_value|all_buyers|clients)$/.test(i.key) && i.status === 'created') act += ' <button class="btn-sm ghost" data-mau-lal="' + esc(i.key) + '">Propose lookalikes</button>';
        if (i.kind === 'lookalike' && !i.sourceReady) act = '<small class="muted">after the source list is in Meta</small>';
        return gh + '<tr><td class="wide" data-l=""><b>' + esc(i.name) + '</b><small>' + esc(i.description) + (i.exclusion ? ' Use as an exclusion.' : '') + '</small>' +
          (i.rule ? '<details class="mau-rule"><summary>Rule sent to Meta</summary><pre>' + esc(JSON.stringify(i.rule, null, 1)) + '</pre></details>' : '') + '</td>' +
          '<td data-l="Type">' + esc(KIND[i.kind] || i.kind) + '</td><td class="num" data-l="Our data">' + ours + '</td>' +
          '<td data-l="Status"><span class="mau-pill ' + esc(i.status) + '">' + esc(STATUS[i.status] || i.status) + '</span>' + (i.error ? '<small>' + esc(i.error) + '</small>' : '') + (i.lastSynced ? '<small>synced ' + esc(when(i.lastSynced)) + '</small>' : '') + '</td>' +
          '<td class="num" data-l="Size in Meta">' + size + '</td><td data-l="">' + act + '</td></tr>';
      }).join('');
      var table = '<div class="card mau-card"><h2>Planned in Meta</h2><p class="sub">Our data counts the people in each segment today, after consent and suppression checks; Meta’s size appears once an audience exists and Meta has matched it. Session-time audiences follow the session times that have registrations or are scheduled.</p>' +
        '<div class="mau-filter">' + kinds.map(function (k) { return '<button data-mau-f="' + k[0] + '" aria-pressed="' + (filter === k[0]) + '">' + esc(k[1]) + '</button>'; }).join('') + '</div>' +
        '<div class="table-wrap"><table class="mau-t"><thead><tr><th>Name</th><th>Type</th><th class="num">Our data</th><th>Status</th><th class="num">Size in Meta</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';

      view.innerHTML = head + steps + '<div data-mau-halo></div>' + rec + value + signals + table;
      // Halo retargeting map (admin-ads2.js): each engaged state, its audiences and the next-step concept.
      if (root.Ads2 && root.Ads2.halo) root.Ads2.halo(ctx, view.querySelector('[data-mau-halo]'));

      var create = view.querySelector('[data-mau-create]');
      if (create) create.addEventListener('click', function () {
        create.disabled = true;
        ctx.send('POST', 'audiences/create', {}).then(function (r) { toast(r && r.ok ? 'Sent to Command for your approval' : (r && r.error) || 'Could not propose it'); ctx.reload(); });
      });
      var terms = view.querySelector('[data-mau-terms]');
      if (terms) terms.addEventListener('change', function () { ctx.send('POST', 'audiences/terms', { accepted: terms.checked }).then(function () { ctx.reload(); }); });
      view.querySelectorAll('[data-mau-f]').forEach(function (b) { b.addEventListener('click', function () { filter = b.getAttribute('data-mau-f'); ctx.reload(); }); });
      view.querySelectorAll('[data-mau-sync]').forEach(function (b) {
        b.addEventListener('click', function () { b.disabled = true; ctx.send('POST', 'audiences/sync/' + encodeURIComponent(b.getAttribute('data-mau-sync')), {}).then(function (r) { toast(r && r.ok ? 'Synced' : (r && r.error) || 'Sync failed'); ctx.reload(); }); });
      });
      view.querySelectorAll('[data-mau-lal]').forEach(function (b) {
        b.addEventListener('click', function () { b.disabled = true; ctx.send('POST', 'audiences/lookalikes', { source: b.getAttribute('data-mau-lal') }).then(function (r) { toast(r && r.ok ? 'Lookalikes sent to Command for your approval' : (r && r.error) || 'Could not propose them'); ctx.reload(); }); });
      });
    });
  }

  root.MetaAudiences = { render: render };
})(window);
