/* Funnel HQ → Financial model → Front-end economics (overnight loop round 2, "ticket economics").
   Real numbers only: ad spend per ticket funnel against ticket, VIP and add-on revenue net of refunds, the share of
   spend the front end recovers (it self-liquidates at 100%), cost per ticket buyer, then the back end (Sprint,
   deposits, engagements) and total ROAS, per event or per week. The recommendation box is an estimate and says so.
   Data: GET /admin/api/economics (src/admin/economics.ts). Mounted by renderFinance() in admin.js:
   window.EconomicsBoard.mount({ el, send, toast }). */
(function (root) {
  'use strict';
  var CSS = '.ec-head{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:flex-start;justify-content:space-between}.ec-head h2{margin:0}' +
    '.ec-ctl{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.ec-seg{display:inline-flex;border-radius:8px;background:#f5f5f7;padding:2px}.ec-seg button{border:0;background:none;padding:6px 12px;border-radius:6px;font:inherit;font-size:13px;color:#1d1d1f;cursor:pointer}' +
    '.ec-seg button[aria-pressed="true"]{background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.12);font-weight:600}' +
    '.ec-funnels{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));margin-top:14px}' +
    '.ec-f{padding:18px}.ec-f h3{margin:0;font-size:15px}.ec-big{font-size:34px;font-weight:600;letter-spacing:-.02em;margin:10px 0 2px;font-variant-numeric:tabular-nums}' +
    '.ec-tag{display:inline-block;font-size:12px;font-weight:600;padding:2px 8px;border-radius:999px;background:#f5f5f7;color:#6e6e73}.ec-tag.yes{background:#e8f5ec;color:#1d7a3a}.ec-tag.no{background:#fdf0e6;color:#b25000}' +
    '.ec-meter{position:relative;height:6px;border-radius:3px;background:#f5f5f7;margin:12px 0 14px;overflow:visible}.ec-meter i{display:block;height:100%;border-radius:3px;background:#0f2c5c;max-width:100%}' +
    '.ec-meter b{position:absolute;top:-4px;bottom:-4px;width:1px;background:#1d1d1f;opacity:.5}.ec-meter span{position:absolute;top:-18px;font-size:11px;color:#6e6e73;transform:translateX(-50%)}' +
    '.ec-kv{display:grid;grid-template-columns:1fr auto;gap:6px 12px;font-size:13px;margin:0}.ec-kv dt{color:#6e6e73}.ec-kv dd{margin:0;text-align:right;font-variant-numeric:tabular-nums}.ec-kv .sep{grid-column:1 / -1;border-top:1px solid rgba(0,0,0,.08);margin:4px 0}' +
    '.ec-rec{margin-top:14px}.ec-rec h2{margin:0 0 4px}.ec-est{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#b25000;margin-left:8px}' +
    '.ec-rec-grid{display:grid;gap:18px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));margin-top:10px}.ec-rec-grid h3{margin:0 0 6px;font-size:14px}.ec-rec-grid ul{margin:0;padding-left:18px;font-size:13px;line-height:1.5}.ec-rec-grid li{margin:3px 0}' +
    '.ec-tbl-wrap{overflow-x:auto;margin-top:10px}.ec-tbl{border-collapse:collapse;width:100%;font-size:13px;min-width:860px}.ec-tbl th,.ec-tbl td{padding:8px 10px;text-align:right;border-bottom:1px solid rgba(0,0,0,.06);white-space:nowrap;font-variant-numeric:tabular-nums}' +
    '.ec-tbl th{font-weight:600;color:#6e6e73;font-size:12px}.ec-tbl th:first-child,.ec-tbl td:first-child,.ec-tbl th:nth-child(2),.ec-tbl td:nth-child(2){text-align:left}.ec-tbl td:nth-child(2){white-space:normal;min-width:180px}' +
    '.ec-tbl .yes{color:#1d7a3a;font-weight:600}.ec-tbl .no{color:#b25000}.ec-notes{margin:10px 0 0;padding-left:18px;font-size:13px;color:#6e6e73}.ec-notes li{margin:3px 0}' +
    '.ec-camp select{font:inherit;font-size:13px;padding:4px 6px;border-radius:6px;border:1px solid rgba(0,0,0,.15);background:#fff}' +
    '@media (max-width:640px){.ec-big{font-size:28px}.ec-f{padding:14px}}';
  function css() { if (!document.getElementById('ec-css')) { var s = document.createElement('style'); s.id = 'ec-css'; s.textContent = CSS; document.head.appendChild(s); } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var FUNNEL = { auto: 'Masterclass ticket', live: 'Live webinar ticket', challenge: 'Challenge ticket and VIP' };
  var HOW = { set: 'set by you', registrations: 'matched by its registrations', name: 'matched by its name', excluded: 'VSL or other in Traffic & ads', unmatched: 'not matched' };
  var state = { days: 90, view: 'event' };
  try { state.view = localStorage.getItem('ec_view') === 'week' ? 'week' : 'event'; state.days = Number(localStorage.getItem('ec_days')) || 90; } catch (e) { /* storage blocked */ }

  function mount(ctx) {
    if (!ctx || !ctx.el) return;
    css();
    var el = ctx.el;
    el.innerHTML = '<div class="card"><p class="muted">Loading front-end economics…</p></div>';
    fetch('/admin/api/economics?days=' + state.days, { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) { draw(ctx, d); })
      .catch(function () { el.innerHTML = '<div class="card"><p class="muted">Front-end economics couldn’t load. Refresh the page.</p></div>'; });
  }

  function draw(ctx, d) {
    var el = ctx.el, cur = d.currency || 'USD';
    var mf = function (dp) { try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: dp, minimumFractionDigits: dp }); } catch (e) { return new Intl.NumberFormat('en-US', { maximumFractionDigits: dp }); } };
    var m = function (v) { return v == null || !isFinite(v) ? '–' : mf(Math.abs(v) < 100 && v % 1 ? 2 : 0).format(v); };
    var pc = function (v) { return v == null || !isFinite(v) ? '–' : Math.round(v * 100) + '%'; };
    var x = function (v) { return v == null || !isFinite(v) ? '–' : (Math.round(v * 100) / 100).toFixed(2) + '×'; };
    var tag = function (t) { return t.selfLiquidates == null ? '<span class="ec-tag">No spend matched</span>' : t.selfLiquidates ? '<span class="ec-tag yes">Self-liquidating</span>' : '<span class="ec-tag no">Not yet self-liquidating</span>'; };

    var funnelCard = function (t) {
      var rec = t.recovery, w = rec == null ? 0 : Math.min(rec, 2) / 2 * 100;
      return '<div class="card ec-f"><div class="ec-head"><h3>' + esc(FUNNEL[t.funnel]) + '</h3>' + tag(t) + '</div>' +
        '<div class="ec-big" aria-label="Front-end recovery">' + esc(pc(rec)) + '</div><div class="muted small">of ad spend recovered by the front end</div>' +
        '<div class="ec-meter" role="img" aria-label="' + esc('Recovery ' + pc(rec) + ', the 100% line is in the middle') + '"><i style="width:' + w + '%"></i><b style="left:50%"></b><span style="left:50%">100%</span></div>' +
        '<dl class="ec-kv"><dt>Ad spend</dt><dd>' + esc(m(t.spend)) + '</dd>' +
        '<dt>Tickets (net)</dt><dd>' + esc(m(t.ticket)) + '</dd>' +
        (t.funnel === 'challenge' || t.vip ? '<dt>VIP upgrades (net)</dt><dd>' + esc(m(t.vip)) + '</dd>' : '') +
        (t.funnel === 'auto' || t.addon ? '<dt>Ticket add-on (net)</dt><dd>' + esc(m(t.addon)) + '</dd>' : '') +
        '<dt><b>Front-end revenue</b></dt><dd><b>' + esc(m(t.frontEnd)) + '</b></dd>' +
        '<dt>Ticket buyers</dt><dd>' + esc(String(t.buyers)) + '</dd><dt>Cost per ticket buyer</dt><dd>' + esc(m(t.cpa)) + '</dd>' +
        '<dd class="sep"></dd>' +
        '<dt>First Deal Sprints</dt><dd>' + esc(m(t.sprint)) + '</dd><dt>Engagement deposits</dt><dd>' + esc(m(t.deposit)) + '</dd><dt>Engagements (cash)</dt><dd>' + esc(m(t.engagement)) + '</dd>' +
        '<dt><b>Back-end revenue</b></dt><dd><b>' + esc(m(t.backEnd)) + '</b></dd><dt>Total ROAS</dt><dd>' + esc(x(t.roas)) + '</dd></dl></div>';
    };

    var recBox = '<div class="card ec-rec"><h2>What would self-liquidate<span class="ec-est">Estimate</span></h2><p class="sub">Worked out from the numbers above at today’s cost per ticket buyer. Everything else is held where it is today, which a price change would not do.</p>' +
      '<div class="ec-rec-grid">' + (d.recommendations || []).map(function (r) {
        return '<div><h3>' + esc(FUNNEL[r.funnel]) + '</h3><ul>' + r.lines.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul></div>';
      }).join('') + '</div></div>';

    var list = state.view === 'week' ? d.byWeek : d.byEvent;
    var table = '<div class="card" style="margin-top:14px"><div class="ec-head"><div><h2>' + (state.view === 'week' ? 'By week' : 'By event') + '</h2><p class="sub">' +
      (state.view === 'week' ? 'Cash in each calendar week (UTC, Monday start): spend on those days against sales paid those days.' : 'Live events and challenge cohorts get the spend from the day after the previous one up to their start. Masterclass registrants are grouped by the week they registered. Sales follow the event the buyer registered for, whenever they paid.') +
      '</p></div></div>' + (list && list.length ? '<div class="ec-tbl-wrap"><table class="ec-tbl"><thead><tr><th>Funnel</th><th>' + (state.view === 'week' ? 'Week' : 'Event') + '</th><th>Ad spend</th><th>Ticket buyers</th><th>Front end</th><th>Recovery</th><th>Cost per buyer</th><th>Back end</th><th>Total ROAS</th><th>Self-liquidates</th></tr></thead><tbody>' +
      list.map(function (r) {
        return '<tr><td>' + esc(FUNNEL[r.funnel]) + '</td><td>' + esc(r.label) + '</td><td>' + esc(m(r.spend)) + '</td><td>' + esc(String(r.buyers)) + '</td><td>' + esc(m(r.frontEnd)) + '</td><td>' + esc(pc(r.recovery)) + '</td><td>' + esc(m(r.cpa)) + '</td><td>' + esc(m(r.backEnd)) + '</td><td>' + esc(x(r.roas)) + '</td><td class="' + (r.selfLiquidates == null ? '' : r.selfLiquidates ? 'yes' : 'no') + '">' + (r.selfLiquidates == null ? 'no spend' : r.selfLiquidates ? 'Yes' : 'No') + '</td></tr>';
      }).join('') + '</tbody></table></div>' : '<p class="muted">No spend or ticket sales in this range yet.</p>') + '</div>';

    var opts = function (c) {
      var v = c.how === 'set' ? (c.funnel || 'none') : 'match';
      return '<select data-ec-camp="' + esc(c.campaign_id) + '" aria-label="' + esc('Funnel for ' + (c.name || c.campaign_id)) + '">' +
        [['match', 'Match automatically'], ['auto', FUNNEL.auto], ['live', FUNNEL.live], ['challenge', FUNNEL.challenge], ['none', 'Not a ticket funnel']].map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === v ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>';
    };
    var camps = '<div class="card ec-camp" style="margin-top:14px"><h2>Campaigns</h2><p class="sub">Each campaign’s spend counts toward one ticket funnel. It is matched by the funnel most of its registrations came into (tag ad URLs with <span class="mono">utm_campaign={{campaign.name}}</span>), then by its name. Change it here when it is wrong.</p>' +
      ((d.campaigns || []).length ? '<div class="ec-tbl-wrap"><table class="ec-tbl" style="min-width:640px"><thead><tr><th>Campaign</th><th>Counts toward</th><th>Spend</th><th>Registrations</th><th>How</th></tr></thead><tbody>' +
        d.campaigns.map(function (c) { return '<tr><td style="text-align:left;white-space:normal">' + esc(c.name || c.campaign_id) + '</td><td style="text-align:left">' + opts(c) + '</td><td>' + esc(m(c.spend)) + '</td><td>' + esc(String(c.registrations)) + '</td><td style="text-align:left">' + esc((c.funnel && c.funnel !== 'none' ? FUNNEL[c.funnel] + ', ' : '') + HOW[c.how]) + '</td></tr>'; }).join('') + '</tbody></table></div>'
        : '<p class="muted">No ad spend in this range. Connect Meta under Integrations, or add spend by hand in Traffic &amp; ads.</p>') + '</div>';

    var notes = [];
    if (d.unmatchedSpend) notes.push(m(d.unmatchedSpend) + ' of spend isn’t matched to a ticket funnel yet (see Campaigns).');
    if (d.excludedSpend) notes.push(m(d.excludedSpend) + ' of spend is on campaigns marked as another funnel and is left out.');
    if (d.unplaced && d.unplaced.n) notes.push(d.unplaced.n + ' sale' + (d.unplaced.n === 1 ? '' : 's') + ' (' + m(d.unplaced.net) + ') couldn’t be tied to a funnel and are left out.');
    if (d.otherCurrency) notes.push(d.otherCurrency + ' sale' + (d.otherCurrency === 1 ? ' is' : 's are') + ' in another currency and left out (nothing is converted).');
    if (!d.comparable) notes.push('Ad spend is reported in ' + d.spendCurrency + ' and sales in ' + cur + ': the ratios compare different currencies.');
    if (!d.addon) notes.push('The ticket add-on is off (Settings → Webinar → Ticket add-on).');

    el.innerHTML = '<div class="card"><div class="ec-head"><div><h2>Front-end economics</h2><p class="sub">Does the ticket pay for the ads? Real sales net of refunds against matched ad spend, last ' + d.days + ' days. The front end self-liquidates when tickets, VIP upgrades and the add-on bring back at least what the ads cost; the Sprint, deposits and engagements are then profit on top.</p></div>' +
      '<div class="ec-ctl"><div class="ec-seg" role="group" aria-label="Range">' + [30, 90, 180, 365].map(function (n) { return '<button type="button" data-ec-days="' + n + '" aria-pressed="' + (n === d.days) + '">' + n + ' days</button>'; }).join('') + '</div>' +
      '<div class="ec-seg" role="group" aria-label="Group by"><button type="button" data-ec-view="event" aria-pressed="' + (state.view === 'event') + '">By event</button><button type="button" data-ec-view="week" aria-pressed="' + (state.view === 'week') + '">By week</button></div></div></div>' +
      (notes.length ? '<ul class="ec-notes">' + notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul>' : '') + '</div>' +
      '<div class="ec-funnels">' + (d.totals || []).map(funnelCard).join('') + '</div>' + recBox + table + camps;

    el.querySelectorAll('[data-ec-days]').forEach(function (b) { b.onclick = function () { state.days = Number(b.getAttribute('data-ec-days')); try { localStorage.setItem('ec_days', String(state.days)); } catch (e) { /* storage blocked */ } mount(ctx); }; });
    el.querySelectorAll('[data-ec-view]').forEach(function (b) { b.onclick = function () { state.view = b.getAttribute('data-ec-view'); try { localStorage.setItem('ec_view', state.view); } catch (e) { /* storage blocked */ } draw(ctx, d); }; });
    el.querySelectorAll('[data-ec-camp]').forEach(function (s) {
      s.onchange = function () {
        s.disabled = true;
        (ctx.send || function () { return Promise.resolve({}); })('POST', 'economics/campaign', { campaign_id: s.getAttribute('data-ec-camp'), funnel: s.value }).then(function (r) {
          if (!r || !r.ok) { s.disabled = false; if (ctx.toast) ctx.toast((r && r.error) || 'Couldn’t save'); return; }
          if (ctx.toast) ctx.toast('Saved');
          mount(ctx);
        });
      };
    });
  }

  root.EconomicsBoard = { mount: mount };
})(window);
