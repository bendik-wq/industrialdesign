/* Funnel HQ → Ads autopilot (Marketing department) and Follow-up actions (Sales department).
   Ads autopilot: every ad with fatigue / losing / winner badges, the proposals waiting (Approve / Edit / Reject),
   ad drafts from research angles, history and the thresholds. Follow-up actions: draft one bulk follow-up
   (quiet leads, no-shows, unpaid checkouts), preview and edit every message, approve to send.
   Loaded before admin.js, which calls AdsAutopilot.render(ctx) / SalesActions.render(ctx) with its helpers. */
(function (root) {
  'use strict';
  var CSS = '.ap-card{margin-top:14px}.ap-head{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:baseline;justify-content:space-between}.ap-head h2{margin:0}' +
    '.ap-prop{border-top:1px solid var(--border,#e5e5ea);padding:14px 0}.ap-prop:first-of-type{border-top:0}.ap-prop h3{margin:0 0 4px;font-size:15px}' +
    '.ap-detail{white-space:pre-wrap;font-size:13px;color:var(--ink-2,#3a3a3c);margin:6px 0 10px;line-height:1.5}' +
    '.ap-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.ap-edit{display:grid;gap:8px;margin:8px 0}.ap-edit textarea{width:100%;min-height:90px;box-sizing:border-box}.ap-edit[hidden]{display:none}' +
    '.ap-b{display:inline-block;border-radius:999px;padding:1px 8px;font-size:12px;font-weight:650;margin:0 4px 2px 0}.ap-b.fatigue{background:#fff4e0;color:#8a5a00}.ap-b.loser{background:#f5f5f7;color:#6e6e73;border:1px solid #d2d2d7}.ap-b.winner{background:#e6f4ea;color:#1d6b3a}' +
    '.ap-table{width:100%;border-collapse:collapse;font-size:13px}.ap-table th,.ap-table td{padding:8px 6px;border-top:1px solid var(--border,#e5e5ea);text-align:left;vertical-align:top}.ap-table .num{text-align:right;white-space:nowrap}.ap-why{font-size:12px;color:#6e6e73;margin-top:2px}' +
    '.ap-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;align-items:end}.ap-form label{display:grid;gap:4px;font-size:13px}.ap-form .wide{grid-column:1/-1}' +
    '.ap-msg{border-top:1px solid var(--border,#e5e5ea);padding:10px 0}.ap-msg pre{white-space:pre-wrap;font-family:inherit;font-size:13px;line-height:1.5;margin:6px 0}.ap-note{color:#8a5a00;font-size:13px;margin:4px 0}' +
    '.ap-plays{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}.ap-checks{display:flex;flex-wrap:wrap;gap:6px 12px;font-size:13px}.ap-form .ap-checks label{display:inline-flex;gap:6px;align-items:center}' +
    '@media (max-width:900px){.ap-table thead{display:none}.ap-table tr{display:grid;grid-template-columns:1fr 1fr;gap:4px 10px;padding:8px 0;border-top:1px solid var(--border,#e5e5ea)}.ap-table td{border:0;padding:2px 0}.ap-table td:first-child{grid-column:1/-1}.ap-table td[data-l]::before{content:attr(data-l) " ";color:#6e6e73;font-size:12px}}';
  function css() { if (!document.getElementById('ap-css')) { var st = document.createElement('style'); st.id = 'ap-css'; st.textContent = CSS; document.head.appendChild(st); } }

  var BADGE = { fatigue: 'Fatigued', loser: 'Losing', winner: 'Winner' };
  var KIND = { 'marketing.pause_ad': 'Pause ad', 'marketing.duplicate_ad': 'Duplicate ad', 'marketing.shift_budget': 'Move budget', 'marketing.launch_angle_ads': 'New ads from an angle', 'marketing.test_angle': 'Test an angle', 'marketing.sync': 'Read Meta' };

  function money(v, cur) { if (v == null || !isFinite(v)) return '–'; try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'USD', maximumFractionDigits: v >= 100 ? 0 : 2 }).format(v); } catch (e) { return (cur || '') + ' ' + v.toFixed(2); } }
  function num(v, d) { return v == null || !isFinite(v) ? '–' : Number(v).toFixed(d == null ? 0 : d); }

  // ───────────── Ads autopilot ─────────────
  function renderAds(ctx) {
    css();
    var view = ctx.view, esc = ctx.esc, n = ctx.n, when = ctx.when, toast = ctx.toast;
    return ctx.api('autopilot', {}, { noRange: true }).then(function (d) {
      var cur = (d.ads[0] && d.ads[0].currency) || 'USD';
      var notes = (d.notes || []).map(function (x) { return '<p class="ap-note">' + esc(x) + '</p>'; }).join('');
      var head = '<div class="card"><div class="ap-head"><h2>Ads autopilot</h2><span class="muted">' +
        (d.configured ? 'Meta read ' + (d.syncedAt ? esc(when(d.syncedAt)) : 'not yet') + ' · hourly' : 'Meta not connected') +
        ' · ' + (d.write ? 'write token connected: approved changes go to Meta' : 'no write token: approve means you apply it in Ads Manager') +
        ' · autopilot ' + (d.on ? 'on' : 'off') + '</span></div>' +
        '<div class="ap-actions" style="margin-top:10px"><button class="btn-sm" data-ap-sync' + (d.configured ? '' : ' disabled') + '>Read Meta now</button><button class="btn-sm ghost" data-ap-run>Run the rules</button></div>' + notes + '</div>';

      var props = (d.proposals || []).map(function (p) { return proposal(p, d, cur); }).join('');
      var propCard = '<div class="card ap-card"><div class="ap-head"><h2>Proposed changes</h2><span class="muted">' + n((d.proposals || []).length) + ' waiting</span></div>' +
        (props || '<p class="muted">Nothing waiting. The rules run every hour after Meta is read.</p>') + '</div>';

      var rows = (d.ads || []).map(function (a) {
        var r = a.results || {};
        var badges = (a.badges || []).map(function (b) { return '<span class="ap-b ' + esc(b) + '">' + esc(BADGE[b] || b) + '</span>'; }).join('');
        return '<tr><td><strong>' + esc(a.name) + '</strong><div class="muted small">' + esc(a.ad_id) + ' · ' + esc((a.status || '').toLowerCase()) + '</div>' + badges +
          (a.reasons && a.reasons.length ? '<div class="ap-why">' + esc(a.reasons.join(' ')) + '</div>' : '') + '</td>' +
          '<td class="num" data-l="Spend">' + money(a.spend, cur) + '</td><td class="num" data-l="CTR">' + num(a.ctr, 2) + '%</td><td class="num" data-l="Freq.">' + num(a.frequency, 2) + '</td><td class="num" data-l="CPC">' + money(a.cpc, cur) + '</td>' +
          '<td class="num" data-l="Leads">' + n(r.leads) + '</td><td class="num" data-l="$1M+">' + n(r.qualified) + '</td><td class="num" data-l="Tickets">' + n(r.tickets) + '</td><td class="num" data-l="Booked">' + n(r.bookings) + '</td><td class="num" data-l="Deposits">' + n(r.deposits) + '</td>' +
          '<td class="num" data-l="Per lead">' + money(a.cpl, cur) + '</td><td class="num" data-l="Per ticket">' + money(a.cpaTicket, cur) + '</td></tr>';
      }).join('');
      var adsCard = '<div class="card ap-card"><div class="ap-head"><h2>Ads, last 14 days</h2><span class="muted">Results are our own: leads, revenue band, tickets, bookings and deposits matched by utm_content</span></div>' +
        (rows ? '<div class="table-wrap"><table class="ap-table"><thead><tr><th>Ad</th><th class="num">Spend</th><th class="num">Link CTR</th><th class="num">Freq.</th><th class="num">CPC</th><th class="num">Leads</th><th class="num">$1M+</th><th class="num">Tickets</th><th class="num">Booked</th><th class="num">Deposits</th><th class="num">Per lead</th><th class="num">Per ticket</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
          : '<p class="muted">No ad spend read yet.</p>') + '</div>';

      var adsetOpts = '<option value="">Choose later</option>' + (d.adsets || []).map(function (s) { return '<option value="' + esc(s.id) + '">' + esc(s.name || s.id) + (s.effective_status ? ' (' + esc(s.effective_status.toLowerCase()) + ')' : '') + '</option>'; }).join('');
      var drafts = (d.drafts || []).map(function (x) {
        return '<div class="ap-msg"><strong>' + esc(x.angle) + '</strong> <span class="pill">' + esc(x.status) + '</span> <span class="muted small">' + esc(when(x.created_at)) + '</span>' +
          (x.error ? '<p class="ap-note">' + esc(x.error) + '</p>' : '') +
          (x.ad_ids && x.ad_ids.length ? '<p class="muted small">Paused ads on Meta: ' + esc(x.ad_ids.join(', ')) + '</p>' : '') +
          (x.spec ? '<details><summary>Paste-ready spec</summary><pre>' + esc(x.spec) + '</pre></details>' : '') + '</div>';
      }).join('');
      var angleCard = '<div class="card ap-card"><div class="ap-head"><h2>New ads from an angle</h2><span class="muted">Research sends angles here too</span></div>' +
        '<form class="ap-form" data-ap-angle><label class="wide">Angle<textarea class="input" name="angle" rows="2" required placeholder="Owners who think buying a competitor needs millions in cash"></textarea></label>' +
        '<label class="wide">What research found (optional)<textarea class="input" name="evidence" rows="2"></textarea></label>' +
        '<label>Ad set for the paused ads<select class="input" name="adset_id">' + adsetOpts + '</select></label>' +
        '<label>Reuse the image of creative (id, optional)<input class="input" name="creative_id" placeholder="Text only if blank"></label>' +
        '<button class="btn-sm" type="submit">Draft three ads</button></form>' +
        '<p class="muted small">Every draft is checked against the copy rules before you see it. Approving creates paused ads tagged with their own utm_content, or a spec to paste when there is no write token.</p>' + drafts + '</div>';

      var hist = (d.history || []).map(function (h) {
        return '<tr><td>' + esc(when(h.decided_at || h.created_at)) + '</td><td>' + esc(KIND[h.kind] || h.kind) + '</td><td>' + esc(h.summary) + (h.result ? '<div class="ap-why">' + esc(h.result) + '</div>' : '') + '</td><td><span class="pill">' + esc(h.status) + '</span> <span class="muted small">' + esc(h.decided_by || h.actor) + '</span></td></tr>';
      }).join('');
      var histCard = '<div class="card ap-card"><div class="ap-head"><h2>History</h2></div>' + (hist ? '<div class="table-wrap"><table class="ap-table"><thead><tr><th>When</th><th>Change</th><th>What happened</th><th>Status</th></tr></thead><tbody>' + hist + '</tbody></table></div>' : '<p class="muted">No decisions yet.</p>') + '</div>';

      var s = d.settings || {};
      var field = function (k, label, ph) { return '<label>' + esc(label) + '<input class="input" name="' + k + '" value="' + esc(s[k] || '') + '" placeholder="' + esc(ph || '') + '"></label>'; };
      var setCard = '<div class="card ap-card"><div class="ap-head"><h2>Targets and limits</h2><span class="muted">In the ad account currency</span></div><form class="ap-form" data-ap-settings>' +
        field('ADS_TARGET_CPL', 'Target cost per lead', '60') + field('ADS_TARGET_CPA_TICKET', 'Target cost per ticket', '150') + field('ADS_TARGET_CPA_DEPOSIT', 'Target cost per deposit', '1500') + field('ADS_TARGET_CPA_BOOKING', 'Target cost per booked call', '250') +
        field('ADS_LOSER_SPEND', 'Spend before judging an ad', String(d.targets.loserSpend)) + field('ADS_MAX_DAILY_SHIFT_PCT', 'Most budget moved per ad set per day (%)', '20') + field('ADS_MAX_DAILY_BUDGET', 'Highest daily budget per ad set', 'no cap') +
        field('ADS_FATIGUE_FREQUENCY', 'Fatigue: frequency above', '2.5') + field('ADS_FATIGUE_CTR_DROP_PCT', 'Fatigue: link CTR down by (%)', '30') + field('ADS_WINNER_MIN_RESULTS', 'Winner: results needed', '3') +
        field('ADS_PAGE_ID', 'Facebook Page ID for new ads', '') + field('ADS_LANDING_URL', 'Landing page for new ads', '') + field('ADS_AUTOPILOT', 'Autopilot (on or off)', 'on') +
        '<button class="btn-sm" type="submit">Save</button></form></div>';

      view.innerHTML = head + propCard + adsCard + angleCard + histCard + setCard;
      wireAds(d, cur);
    });

    function proposal(p, d, cur) {
      var pl = p.payload || {};
      var manual = !d.write && p.kind !== 'marketing.launch_angle_ads' && p.kind !== 'marketing.test_angle';
      var edit = '';
      if (p.kind === 'marketing.shift_budget') edit = '<div class="ap-edit" data-ap-editbox hidden><label>Amount per day<input class="input" type="number" min="1" step="1" data-ap-amount value="' + esc(((pl.amount || 0) / 100).toFixed(0)) + '"></label><button class="btn-sm ghost" data-ap-save-edit="' + esc(p.id) + '">Save amount</button></div>';
      if (p.kind === 'marketing.launch_angle_ads') {
        edit = '<div class="ap-edit" data-ap-editbox hidden>' + (pl.drafts || []).map(function (x, i) {
          return '<div data-ap-draft="' + i + '"><label>Headline ' + (i + 1) + '<input class="input" data-f="headline" value="' + esc(x.headline) + '"></label><label>Primary text ' + (i + 1) + '<textarea class="input" data-f="primary">' + esc(x.primary) + '</textarea></label><label>Description ' + (i + 1) + '<input class="input" data-f="description" value="' + esc(x.description || '') + '"></label></div>';
        }).join('') + '<label>Ad set<select class="input" data-ap-adset><option value="">Choose later</option>' + (d.adsets || []).map(function (s) { return '<option value="' + esc(s.id) + '"' + (s.id === pl.adset_id ? ' selected' : '') + '>' + esc(s.name || s.id) + '</option>'; }).join('') + '</select></label>' +
          '<button class="btn-sm ghost" data-ap-save-edit="' + esc(p.id) + '">Save drafts</button></div>';
      }
      return '<div class="ap-prop" data-ap-prop="' + esc(p.id) + '" data-kind="' + esc(p.kind) + '"><h3>' + esc(p.summary) + '</h3><span class="pill">' + esc(KIND[p.kind] || p.kind) + '</span> <span class="muted small">' + esc(p.risk || '') + ' risk · ' + esc(when(p.created_at)) + '</span>' +
        '<div class="ap-detail">' + esc(p.detail || '') + '</div>' + edit +
        '<div class="ap-actions"><button class="btn-sm" data-ap-approve="' + esc(p.id) + '"' + (manual ? ' data-manual="1"' : '') + '>' + (manual ? 'I applied it in Ads Manager' : 'Approve') + '</button>' +
        (edit ? '<button class="btn-sm ghost" data-ap-edit>Edit</button>' : '') + '<button class="btn-sm ghost" data-ap-reject="' + esc(p.id) + '">Reject</button></div></div>';
    }

    function wireAds() {
      var reload = function () { return renderAds(ctx); };
      var busy = function (btn, on) { if (btn) { btn.disabled = on; } };
      view.querySelectorAll('[data-ap-sync]').forEach(function (b) { b.onclick = function () { busy(b, true); ctx.send('POST', 'autopilot/sync', {}).then(function (r) { toast(r.ok ? 'Read ' + r.synced.rows + ' ad-days from Meta' : r.error); reload(); }); }; });
      view.querySelectorAll('[data-ap-run]').forEach(function (b) { b.onclick = function () { busy(b, true); ctx.send('POST', 'autopilot/run', {}).then(function (r) { toast(r.ok ? r.run.proposed.length + ' new proposals' : r.error); reload(); }); }; });
      view.querySelectorAll('[data-ap-approve]').forEach(function (b) {
        b.onclick = function () {
          busy(b, true);
          ctx.send('POST', 'autopilot/actions/' + b.getAttribute('data-ap-approve') + '/approve', { manual: b.getAttribute('data-manual') === '1' }).then(function (r) { toast(r.summary || (r.ok ? 'Done' : 'Failed')); reload(); });
        };
      });
      view.querySelectorAll('[data-ap-reject]').forEach(function (b) { b.onclick = function () { busy(b, true); ctx.send('POST', 'autopilot/actions/' + b.getAttribute('data-ap-reject') + '/reject', {}).then(function () { toast('Rejected'); reload(); }); }; });
      view.querySelectorAll('[data-ap-edit]').forEach(function (b) { b.onclick = function () { var box = b.closest('[data-ap-prop]').querySelector('[data-ap-editbox]'); if (box) box.hidden = !box.hidden; }; });
      view.querySelectorAll('[data-ap-save-edit]').forEach(function (b) {
        b.onclick = function () {
          var card = b.closest('[data-ap-prop]'), id = b.getAttribute('data-ap-save-edit'), body = {};
          if (card.getAttribute('data-kind') === 'marketing.shift_budget') body.amount = Number(card.querySelector('[data-ap-amount]').value);
          else {
            body.drafts = Array.prototype.map.call(card.querySelectorAll('[data-ap-draft]'), function (el) { return { headline: el.querySelector('[data-f=headline]').value, primary: el.querySelector('[data-f=primary]').value, description: el.querySelector('[data-f=description]').value }; });
            body.adset_id = card.querySelector('[data-ap-adset]').value;
          }
          ctx.send('PUT', 'autopilot/actions/' + id, body).then(function (r) { toast(r.ok ? (r.capped ? 'Saved, capped at ' + r.amount : 'Saved') : r.error); if (r.ok) reload(); });
        };
      });
      var af = view.querySelector('[data-ap-angle]');
      if (af) af.onsubmit = function (e) {
        e.preventDefault();
        var fd = new FormData(af), btn = af.querySelector('button');
        busy(btn, true); btn.textContent = 'Drafting…';
        ctx.send('POST', 'autopilot/angle', { angle: fd.get('angle'), evidence: fd.get('evidence'), adset_id: fd.get('adset_id'), creative_id: fd.get('creative_id') }).then(function (r) {
          toast(r.ok ? r.drafts.length + ' drafts ready for approval' : r.error); if (r.ok) reload(); else { busy(btn, false); btn.textContent = 'Draft three ads'; }
        });
      };
      var sf = view.querySelector('[data-ap-settings]');
      if (sf) sf.onsubmit = function (e) {
        e.preventDefault();
        var body = {}; new FormData(sf).forEach(function (v, k) { body[k] = v; });
        ctx.send('PUT', 'autopilot/settings', body).then(function (r) { toast(r.ok ? 'Saved' : r.error); if (r.ok) reload(); });
      };
    }
  }

  // ───────────── Follow-up actions ─────────────
  function renderSales(ctx, openBatch) {
    css();
    var view = ctx.view, esc = ctx.esc, n = ctx.n, when = ctx.when, toast = ctx.toast;
    return ctx.api('autopilot/followups', {}, { noRange: true }).then(function (d) {
      var ch = '<div class="ap-checks"><label><input type="checkbox" name="ch_email" checked> Email</label><label><input type="checkbox" name="ch_sms" checked> SMS (only people who agreed to texts)</label></div>';
      var plays = d.plays.map(function (p) {
        var extra = p.id === 'quiet'
          ? '<label>Quiet for at least (days)<input class="input" type="number" name="days" min="1" max="365" value="' + esc(d.quietDays) + '"></label><div class="ap-checks">' + d.stages.map(function (s) { return '<label><input type="checkbox" name="st_' + esc(s) + '"' + (['applied', 'showed', 'nurture'].indexOf(s) >= 0 ? ' checked' : '') + '> ' + esc(s) + '</label>'; }).join('') + '</div>'
          : '';
        return '<form class="card ap-form" data-sa-play="' + esc(p.id) + '" style="align-content:start"><h2 class="wide" style="margin:0">' + esc(p.label) + '</h2><p class="muted small wide" style="margin:0">' + esc(p.describe) + '</p>' + extra + ch + '<button class="btn-sm" type="submit">Draft the messages</button></form>';
      }).join('');
      var rows = (d.batches || []).map(function (b) {
        return '<tr data-sa-batch="' + esc(b.batch_id) + '" style="cursor:pointer"><td>' + esc(when(b.created_at)) + '</td><td>' + esc(b.play) + '</td><td class="num">' + n(b.leads) + '</td><td class="num">' + n(b.messages) + '</td>' +
          '<td>' + esc(b.action_status || '') + (b.sent ? ' · ' + n(b.sent) + ' sent' + (b.simulated ? ' (' + n(b.simulated) + ' simulated)' : '') : '') + (b.queued ? ' · ' + n(b.queued) + ' waiting for sending hours' : '') + (b.skipped ? ' · ' + n(b.skipped) + ' skipped' : '') + '</td></tr>';
      }).join('');
      view.innerHTML = '<div class="card"><p class="muted" style="margin:0">Each action drafts one message per lead and puts them in one proposal. Nothing is sent until you approve. Unsubscribes, bounced addresses, STOP replies and people without text consent are left out, texts go 8am to 8pm their time and email 7am to 9pm, and anyone who becomes active, rebooks or pays before sending is skipped. Without Resend or Twilio connected, sends are simulated and marked as such. At most ' + esc(d.maxPerBatch) + ' leads per batch.</p></div>' +
        '<div class="ap-plays ap-card">' + plays + '</div><div data-sa-preview></div>' +
        '<div class="card ap-card"><div class="ap-head"><h2>Batches</h2></div>' + (rows ? '<div class="table-wrap"><table class="ap-table"><thead><tr><th>Drafted</th><th>Action</th><th class="num">Leads</th><th class="num">Messages</th><th>Status</th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '<p class="muted">No follow-up batches yet.</p>') + '</div>';
      wireSales(d);
      if (openBatch) preview(openBatch.batchId, openBatch.actionId, openBatch.excluded);
    });

    function wireSales(d) {
      view.querySelectorAll('[data-sa-play]').forEach(function (f) {
        f.onsubmit = function (e) {
          e.preventDefault();
          var body = { play: f.getAttribute('data-sa-play'), channels: [], stages: [] };
          var fd = new FormData(f);
          if (fd.get('ch_email')) body.channels.push('email');
          if (fd.get('ch_sms')) body.channels.push('sms');
          if (fd.get('days')) body.days = Number(fd.get('days'));
          d.stages.forEach(function (s) { if (fd.get('st_' + s)) body.stages.push(s); });
          var btn = f.querySelector('button'); btn.disabled = true; btn.textContent = 'Drafting…';
          ctx.send('POST', 'autopilot/followups', body).then(function (r) {
            if (!r.ok) { toast(r.error); btn.disabled = false; btn.textContent = 'Draft the messages'; return; }
            if (!r.actionId) { toast('Nobody to follow up right now' + (r.excluded.length ? ' (' + r.excluded.length + ' left out)' : '')); btn.disabled = false; btn.textContent = 'Draft the messages'; return; }
            renderSales(ctx, { batchId: r.batchId, actionId: r.actionId, excluded: r.excluded });
          });
        };
      });
      view.querySelectorAll('[data-sa-batch]').forEach(function (tr) {
        tr.onclick = function () { var b = (d.batches || []).filter(function (x) { return x.batch_id === tr.getAttribute('data-sa-batch'); })[0]; preview(b.batch_id, b.action_status === 'proposed' ? b.action_id : null, null); };
      });
    }

    function preview(batchId, actionId, excluded) {
      var box = view.querySelector('[data-sa-preview]');
      ctx.api('autopilot/followups/' + batchId, {}, { noRange: true }).then(function (r) {
        var msgs = r.messages.map(function (m) {
          var draft = m.status === 'draft' && actionId;
          return '<div class="ap-msg" data-sa-msg="' + esc(m.id) + '" data-ch="' + esc(m.channel) + '"><strong>' + esc([m.first_name, m.last_name].filter(Boolean).join(' ') || m.to_addr) + '</strong> <span class="pill">' + esc(m.channel) + '</span> <span class="muted small">' + esc(m.to_addr) + ' · ' + esc(m.status) + (m.status === 'draft' || m.status === 'queued' ? ' · goes ' + esc(when(m.send_at)) : '') + (m.error ? ' · ' + esc(m.error) : '') + '</span>' +
            (m.subject ? '<div><strong>' + esc(m.subject) + '</strong></div>' : '') + '<pre>' + esc(m.text) + '</pre>' +
            (draft ? '<div class="ap-actions"><button class="btn-sm ghost" data-sa-edit>Edit</button><button class="btn-sm ghost" data-sa-drop>Remove</button></div><div class="ap-edit" data-sa-editbox hidden>' + (m.subject ? '<input class="input" data-sa-subject value="' + esc(m.subject) + '">' : '') + '<textarea class="input" data-sa-text>' + esc(m.text) + '</textarea><button class="btn-sm" data-sa-save>Save</button></div>' : '') + '</div>';
        }).join('');
        var left = excluded && excluded.length ? '<details><summary>' + n(excluded.length) + ' left out</summary><ul>' + excluded.map(function (x) { return '<li>' + esc(x.name) + ': ' + esc(x.why) + '</li>'; }).join('') + '</ul></details>' : '';
        box.innerHTML = '<div class="card ap-card"><div class="ap-head"><h2>Preview</h2><span class="muted">' + n(r.messages.length) + ' messages</span></div>' + left +
          (actionId ? '<div class="ap-actions" style="margin:10px 0"><button class="btn-sm" data-sa-approve>Approve and send</button><button class="btn-sm ghost" data-sa-reject>Reject</button></div>' : '') + msgs + '</div>';
        box.scrollIntoView({ behavior: 'smooth', block: 'start' });
        var ap = box.querySelector('[data-sa-approve]');
        if (ap) ap.onclick = function () { ap.disabled = true; ctx.send('POST', 'autopilot/actions/' + actionId + '/approve', {}).then(function (x) { toast(x.summary || 'Done'); renderSales(ctx); }); };
        var rj = box.querySelector('[data-sa-reject]');
        if (rj) rj.onclick = function () { ctx.send('POST', 'autopilot/actions/' + actionId + '/reject', {}).then(function () { toast('Rejected'); renderSales(ctx); }); };
        box.querySelectorAll('[data-sa-msg]').forEach(function (el) {
          var id = el.getAttribute('data-sa-msg');
          var e1 = el.querySelector('[data-sa-edit]'); if (e1) e1.onclick = function () { var b = el.querySelector('[data-sa-editbox]'); b.hidden = !b.hidden; };
          var dr = el.querySelector('[data-sa-drop]'); if (dr) dr.onclick = function () { ctx.send('DELETE', 'autopilot/followups/msg/' + id).then(function () { preview(batchId, actionId, excluded); }); };
          var sv = el.querySelector('[data-sa-save]'); if (sv) sv.onclick = function () {
            var subj = el.querySelector('[data-sa-subject]');
            ctx.send('PUT', 'autopilot/followups/msg/' + id, { subject: subj ? subj.value : undefined, text: el.querySelector('[data-sa-text]').value }).then(function (x) { toast(x.ok ? 'Saved' : x.error); if (x.ok) preview(batchId, actionId, excluded); });
          };
        });
      });
    }
  }

  root.AdsAutopilot = { render: renderAds };
  root.SalesActions = { render: renderSales };
})(window);
