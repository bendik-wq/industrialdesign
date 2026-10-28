/* Funnel HQ → Sprint board: First Deal Sprint delivery (one card per buyer) and the value ladder report.
   Loaded before admin.js, which calls DealSprintBoard.render(ctx) with its own helpers (api, send, esc, tile, …). */
(function (root) {
  'use strict';

  var STATUS = { waiting: 'Waiting', in_progress: 'In progress', ready: 'Ready' };
  var OUTCOME = { '': 'No outcome yet', proposal_sent: 'Proposal sent', signed: 'Engagement signed', not_continuing: 'Not continuing', refunded: 'Refunded' };
  var K_STATUS = { draft: 'Draft', sent: 'Sent', viewed: 'Opened', signed: 'Signed', void: 'Void' };
  var INTAKE = [['revenue', 'Revenue'], ['ebitda', 'EBITDA'], ['industry', 'Industry'], ['locations', 'Locations'], ['buy_what', 'Would buy first'], ['cash', 'Cash for a first deal'], ['timeline', 'Timeline'], ['financials_url', 'Financial statements'], ['notes', 'Notes']];
  var CSS = '.dsb-card{margin-top:14px}.dsb-head{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:baseline;justify-content:space-between}.dsb-head h2{margin:0}' +
    '.dsb-meta{display:flex;flex-wrap:wrap;gap:6px;align-items:center}.dsb-checks{display:flex;flex-wrap:wrap;gap:8px 18px;margin:12px 0}.dsb-checks label{display:inline-flex;gap:6px;align-items:center;font-size:14px}' +
    '.dsb-del{display:grid;grid-template-columns:52px minmax(140px,1.2fr) 130px minmax(140px,1.4fr) minmax(140px,1.6fr) auto;gap:8px;align-items:start;padding:8px 0;border-top:1px solid var(--line,#e5e7eb)}' +
    '.dsb-del textarea{min-height:38px;resize:vertical}.dsb-del .muted{font-size:12px}.dsb-out{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;align-items:end;margin-top:12px}' +
    '.dsb-out label{display:grid;gap:4px;font-size:13px}.dsb-ladder td,.dsb-ladder th{white-space:nowrap}' +
    '@media (max-width:760px){.dsb-del{grid-template-columns:1fr 1fr}.dsb-del>*:nth-child(2){grid-column:span 1}.dsb-del textarea,.dsb-del input[type=url]{grid-column:1/-1}}';

  function render(ctx) {
    var view = ctx.view, esc = ctx.esc, n = ctx.n, pct = ctx.pct, when = ctx.when, tile = ctx.tile, toast = ctx.toast;
    if (!document.getElementById('dsb-css')) { var st = document.createElement('style'); st.id = 'dsb-css'; st.textContent = CSS; document.head.appendChild(st); }
    return ctx.api('deal-sprint').then(function (d) {
      var L = d.ladder || {}, cur = L.currency || 'USD';
      var money = function (v) { if (v == null || !isFinite(v)) return '–'; try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(v); } catch (e) { return cur + ' ' + n(v); } };
      var steps = L.steps || [];
      var prevN = null;
      var ladderRows = steps.map(function (s) {
        var rate = s.n != null && prevN ? s.n / prevN : null;
        if (s.n != null) prevN = s.n;
        return '<tr><td>' + esc(s.label) + (s.key === 'unlocked' ? ' <span class="muted">(from the room’s offer-unlock event)</span>' : '') + (s.key === 'sprints' && L.sprintSplit ? ' <span class="muted">' + n(L.sprintSplit.full) + ' paid in full · ' + n(L.sprintSplit.plan) + ' on a plan</span>' : '') + '</td><td class="num">' + (s.n == null ? '–' : n(s.n)) + '</td><td class="num">' + (rate == null ? '–' : pct(rate, 1)) + '</td><td class="num">' + (s.revenue == null ? '' : esc(money(s.revenue))) + '</td></tr>';
      }).join('');
      var E = L.engagements || {};
      var ladder = '<div class="grid g-4 tiles">' +
        tile('Revenue per registrant', money(L.perRegistrant), 'tickets + Sprints + engagements ÷ people who registered') +
        tile('Revenue per ticket', money(L.perTicket), 'the same revenue ÷ tickets sold') +
        tile('Ladder revenue', money(L.revenue && L.revenue.total), 'tickets ' + money(L.revenue && L.revenue.tickets) + ' · Sprints ' + money(L.revenue && L.revenue.sprints) + ' · engagements ' + money(L.revenue && L.revenue.engagements)) +
        tile('Engagements signed', n(E.signed || 0), n(E.paid || 0) + ' paid · ' + money(E.gross) + ' in fees before the Sprint credit') + '</div>' +
        '<div class="card" style="margin-top:14px"><h2>The ladder</h2><p class="sub">Each step counted by when it happened in the selected range. Engagement revenue is net of the Sprint credit, which is already counted as Sprint revenue. Tickets are paid masterclass seats.</p>' +
        '<div class="table-wrap"><table class="dsb-ladder"><thead><tr><th>Step</th><th class="num">People</th><th class="num">From the step before</th><th class="num">Revenue</th></tr></thead><tbody>' + ladderRows + '</tbody></table></div></div>';

      var cfg = d.config || {};
      var setup = (!cfg.kickoffUrl || !cfg.planUrl) ? '<div class="card" style="margin-top:14px"><p class="muted">' +
        (!cfg.kickoffUrl ? 'No kickoff booking link is set, so buyers are told the team emails them to book it. ' : '') +
        (!cfg.planUrl ? 'No Deal Plan session link is set either. ' : '') + 'Add them under Integrations → Webinar (First Deal Sprint).</p></div>' : '';

      var sprints = d.sprints || [];
      var cards = sprints.map(function (s) {
        var finished = s.day > (cfg.days || 7);
        var dayLabel = s.status === 'refunded' ? 'Refunded' : finished ? 'Past day ' + (cfg.days || 7) : 'Day ' + s.day + ' of ' + (cfg.days || 7);
        var chk = function (key, label, on) { return '<label><input type="checkbox" data-dsb-flag="' + key + '"' + (on ? ' checked' : '') + '> ' + esc(label) + '</label>'; };
        var intake = s.intake ? '<details><summary>Intake received ' + esc(when(s.intake.submitted_at)) + '</summary><dl class="fm-kv">' + INTAKE.map(function (f) {
          var v = s.intake[f[0]];
          if (!v) return '';
          return '<dt>' + esc(f[1]) + '</dt><dd>' + (f[0] === 'financials_url' && /^https:\/\//.test(v) ? '<a href="' + esc(v) + '" target="_blank" rel="noopener">Open</a>' : esc(v)) + '</dd>';
        }).join('') + '</dl></details>' : '<span class="pill">Intake not received</span>';
        var dels = (s.deliverables || []).map(function (x) {
          return '<div class="dsb-del" data-dsb-del="' + esc(x.key) + '"><span class="muted">Day ' + x.day + '</span><div><strong>' + esc(x.title) + '</strong>' +
            (x.emailed_at ? '<div class="muted">Emailed ' + esc(when(x.emailed_at)) + '</div>' : x.ready_at ? '<div class="muted">Ready ' + esc(when(x.ready_at)) + '</div>' : '') + '</div>' +
            '<select class="input" data-f="status" aria-label="Status">' + Object.keys(STATUS).map(function (k) { return '<option value="' + k + '"' + (x.status === k ? ' selected' : '') + '>' + STATUS[k] + '</option>'; }).join('') + '</select>' +
            '<input class="input" type="url" data-f="link" placeholder="https:// link to the document" value="' + esc(x.link || '') + '" aria-label="Link">' +
            '<textarea class="input" data-f="notes" placeholder="Notes the buyer sees when it is ready" aria-label="Notes">' + esc(x.notes || '') + '</textarea>' +
            '<button class="btn-sm" type="button" data-dsb-save-del>Save</button></div>';
        }).join('');
        var k = s.contract;
        var kLine = k ? '<span class="pill">' + esc(K_STATUS[k.status] || k.status) + ' agreement · ' + esc(money(k.fee)) + (k.credit ? ' less ' + esc(money(k.credit)) + ' credit' : '') + (k.paid_at ? ' · paid' : '') + '</span>' : '';
        return '<div class="card dsb-card" data-dsb="' + esc(s.id) + '">' +
          '<div class="dsb-head"><h2>' + esc(s.name) + '</h2><div class="dsb-meta"><span class="pill">' + esc(dayLabel) + '</span>' + (s.fast_bonus ? '<span class="pill">Fast-action bonus</span>' : '') +
          (s.plan ? '<span class="pill">' + (s.plan === 'plan' ? 'Payment plan' : 'Paid in full') + '</span>' : '') + kLine + '</div></div>' +
          '<p class="muted">' + esc([s.email, s.band, (s.product || 'Sprint') + ' ' + s.paid + ' paid ' + when(s.paid_at), s.credit ? s.credit + ' credit' : null].filter(Boolean).join(' · ')) +
          (s.portal ? ' · <a href="' + esc(s.portal) + '" target="_blank" rel="noopener">Their Sprint page</a>' : '') + ' · <a href="#lead=' + esc(s.lead_id) + '">Lead</a></p>' +
          intake +
          '<div class="dsb-checks">' + chk('kickoff_booked', 'Kickoff booked', s.kickoff_booked_at) + chk('kickoff_held', 'Kickoff held', s.kickoff_held_at) + chk('plan_booked', 'Deal Plan session booked', s.plan_booked_at) + chk('plan_held', 'Deal Plan session held', s.plan_held_at) + '</div>' +
          '<h3 class="h3">Deliverables</h3><p class="muted" style="margin:0 0 4px">Marking one Ready emails the buyer once, with the link and notes.</p>' + dels +
          '<div class="dsb-out"><label>Outcome<select class="input" data-o="outcome">' + Object.keys(OUTCOME).map(function (o) { return '<option value="' + o + '"' + ((s.outcome || '') === o ? ' selected' : '') + '>' + OUTCOME[o] + '</option>'; }).join('') + '</select></label>' +
          '<label>Engagement fee (' + esc(cur) + ')<input class="input" type="number" min="0" step="1000" data-o="engagement_fee" value="' + esc(s.engagement_fee == null ? '' : String(s.engagement_fee)) + '"></label>' +
          '<label style="grid-column:1/-1">Team notes<textarea class="input" data-o="notes">' + esc(s.notes || '') + '</textarea></label>' +
          '<div class="row" style="gap:8px"><button class="btn-sm" type="button" data-dsb-save>Save</button><button class="btn-sm ghost" type="button" data-dsb-agree>' + (k ? 'Open engagement agreement' : 'Draft engagement agreement') + '</button></div></div>' +
          (s.outcome === 'proposal_sent' ? '<p class="muted" style="margin-top:8px">Proposal follow-ups go out on day 1, 3 and 7 after ' + esc(when(s.proposal_sent_at)) + ', and stop when the outcome changes.</p>' : '') +
          '</div>';
      }).join('');

      view.innerHTML = ladder + setup + '<h2 style="margin:22px 0 0">Sprint buyers</h2>' +
        (sprints.length ? cards : '<div class="card" style="margin-top:14px">' + ctx.emptyState('No First Deal Sprint buyers yet.', 'Each paid Sprint appears here with its day, intake, calls and deliverables.') + '</div>');

      var put = function (path, body) { return fetch('/admin/api/deal-sprint/' + path, { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(function (r) { return r.json(); }); };
      view.querySelectorAll('[data-dsb]').forEach(function (card) {
        var id = card.getAttribute('data-dsb');
        card.querySelectorAll('[data-dsb-flag]').forEach(function (cb) {
          cb.onchange = function () {
            var b = {}; b[cb.getAttribute('data-dsb-flag')] = cb.checked;
            put(encodeURIComponent(id), b).then(function (r) { toast(r && r.ok ? 'Saved' : (r && r.error) || 'Couldn’t save'); if (r && r.ok && cb.checked && /held/.test(cb.getAttribute('data-dsb-flag'))) ctx.reload(); });
          };
        });
        card.querySelectorAll('[data-dsb-save-del]').forEach(function (btn) {
          btn.onclick = function () {
            var row = btn.closest('[data-dsb-del]'), key = row.getAttribute('data-dsb-del');
            var b = { status: row.querySelector('[data-f="status"]').value, link: row.querySelector('[data-f="link"]').value.trim(), notes: row.querySelector('[data-f="notes"]').value };
            btn.disabled = true;
            put(encodeURIComponent(id) + '/deliverables/' + encodeURIComponent(key), b).then(function (r) {
              btn.disabled = false;
              if (!r || !r.ok) { toast((r && r.error) || 'Couldn’t save'); return; }
              toast(r.emailed ? 'Saved, and emailed them that it’s ready' : 'Saved');
              if (r.emailed) ctx.reload();
            });
          };
        });
        card.querySelector('[data-dsb-save]').onclick = function () {
          var b = { outcome: card.querySelector('[data-o="outcome"]').value, engagement_fee: card.querySelector('[data-o="engagement_fee"]').value, notes: card.querySelector('[data-o="notes"]').value };
          put(encodeURIComponent(id), b).then(function (r) { toast(r && r.ok ? 'Saved' : (r && r.error) || 'Couldn’t save'); if (r && r.ok) ctx.reload(); });
        };
        card.querySelector('[data-dsb-agree]').onclick = function () {
          ctx.send('POST', 'deal-sprint/' + encodeURIComponent(id) + '/agreement', {}).then(function (r) {
            if (!r || !r.ok) { toast((r && r.error) || 'Couldn’t prepare the agreement'); return; }
            if (r.created) toast('Draft created with the auto-quote and the Sprint credit');
            ctx.openContract(r.contractId);
          });
        };
      });
    });
  }

  root.DealSprintBoard = { render: render };
})(this);
