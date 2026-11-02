/* Funnel HQ → Ad tracking → Data quality and Exports (overnight loop round 1, "dataflow").
   Data quality: every check from src/dataq/checks.ts with its count, the day before, a 14-day trail, example ids
   (leads open their drawer) and a link to the view that fixes it. Exports: CSV or JSON of the key tables for a
   date range, streamed by /admin/api/dataq/export, personal details only when ticked, every download logged.
   Mounted by renderTracking() in admin.js: window.DataQualityBoard.section(ctx). */
(function (root) {
  'use strict';
  var CSS = '.dq-head{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:baseline;justify-content:space-between}.dq-head h2{margin:0}' +
    '.dq-list{display:grid;gap:0;margin-top:10px}.dq-row{display:grid;grid-template-columns:14px minmax(0,1fr) auto auto;gap:4px 12px;align-items:center;padding:12px 0;border-top:1px solid rgba(0,0,0,.08)}' +
    '.dq-row:first-child{border-top:0}.dq-dot{width:10px;height:10px;border-radius:50%;background:#c7c7cc}.dq-dot.warn{background:#b25000}.dq-dot.ok{background:#1d7a3a}' +
    '.dq-name{font-weight:600;font-size:14px}.dq-what{font-size:12px;color:#6e6e73;margin-top:2px}.dq-n{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap;font-size:14px}' +
    '.dq-n b{font-size:17px}.dq-trend{font-size:12px;white-space:nowrap;color:#6e6e73;text-align:right;min-width:110px}.dq-trend.worse{color:#b25000}.dq-trend.better{color:#1d7a3a}' +
    '.dq-more{grid-column:2 / -1;font-size:13px}.dq-more summary{cursor:pointer;color:#0f2c5c}.dq-more[open] summary{margin-bottom:6px}' +
    '.dq-ex{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}.dq-ex a,.dq-ex code{font-size:12px;padding:2px 8px;border-radius:999px;background:#f5f5f7;color:#0f2c5c;text-decoration:none}' +
    '.dq-spark{display:inline-flex;gap:2px;align-items:flex-end;height:22px;vertical-align:middle}.dq-spark i{display:block;width:6px;background:#0f2c5c;opacity:.55;border-radius:1px;min-height:1px}' +
    '.dq-kv{margin:4px 0;padding-left:18px}.dq-kv li{margin:2px 0}.dq-tbl{border-collapse:collapse;font-size:12px;margin:6px 0;width:100%;max-width:640px}.dq-tbl th,.dq-tbl td{padding:4px 8px;text-align:right;border-bottom:1px solid rgba(0,0,0,.06)}' +
    '.dq-tbl th:first-child,.dq-tbl td:first-child{text-align:left}.dq-tbl .low{color:#b25000;font-weight:600}.dq-fix{font-size:13px;white-space:nowrap}.dq-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}' +
    '.dq-form{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));align-items:end;margin-top:10px}.dq-form label{display:grid;gap:4px;font-size:13px}' +
    '.dq-form .dq-check{display:flex;gap:8px;align-items:center;grid-column:1 / -1}.dq-form .dq-actions{display:flex;gap:8px;flex-wrap:wrap;grid-column:1 / -1}' +
    '@media (max-width:640px){.dq-row{grid-template-columns:14px minmax(0,1fr) auto}.dq-trend{grid-column:2 / -1;text-align:left}.dq-fix{grid-column:2 / -1}.dq-tbl{display:block;overflow-x:auto}}';
  function css() { if (!document.getElementById('dq-css')) { var s = document.createElement('style'); s.id = 'dq-css'; s.textContent = CSS; document.head.appendChild(s); } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmt(v) { return v == null ? '–' : new Intl.NumberFormat('en-US').format(v); }
  function pct(v) { return v == null || !isFinite(v) ? '–' : Math.round(v * 100) + '%'; }
  function ymd(d) { var z = function (x) { return (x < 10 ? '0' : '') + x; }; return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()); }
  var LABEL = { byOrigin: 'Where these leads came from', byFunnel: 'Per funnel', byKind: 'Per product', byDest: 'Per destination', retrying: 'Still retrying', bounced: 'Hard bounces', complained: 'Spam complaints', manual: 'Blocked by hand', failedSends: 'Sends that failed', bounceRate: 'Bounce rate', complaintRate: 'Complaint rate', queued: 'Queued past their time', dialing: 'Dialling for over an hour', elevenlabs: 'ElevenLabs connected', groups: 'Addresses with more than one lead', phone: 'Phone not in international format', timezone: 'Time zone not valid' };

  function trend(c) {
    if (!c.today || c.today.n == null) return '<span class="dq-trend">not measured</span>';
    if (c.delta == null) return '<span class="dq-trend">no reading the day before</span>';
    if (c.delta === 0) return '<span class="dq-trend">same as the day before</span>';
    return '<span class="dq-trend ' + (c.delta > 0 ? 'worse' : 'better') + '">' + (c.delta > 0 ? '+' : '') + fmt(c.delta) + ' vs the day before</span>';
  }
  function spark(h) {
    if (!h || h.length < 2) return '';
    var max = Math.max.apply(null, h.map(function (x) { return x.n || 0; }).concat([1]));
    return ' <span class="dq-spark" role="img" aria-label="' + esc('Last ' + h.length + ' days: ' + h.map(function (x) { return x.day + ' ' + (x.n == null ? 'not measured' : x.n); }).join(', ')) + '">' +
      h.map(function (x) { return '<i style="height:' + Math.max(1, Math.round((x.n || 0) / max * 22)) + 'px" title="' + esc(x.day + ': ' + (x.n == null ? 'not measured' : x.n)) + '"></i>'; }).join('') + '</span>';
  }
  function examples(c) {
    var ex = (c.today && c.today.examples) || [];
    if (!ex.length) return '';
    return '<div>Examples:</div><div class="dq-ex">' + ex.map(function (id) {
      return c.examples === 'lead' ? '<a href="#lead=' + encodeURIComponent(id) + '">' + esc(id) + '</a>' : '<code>' + esc(id) + '</code>';
    }).join('') + '</div>';
  }
  function detail(c) {
    var d = (c.today && c.today.detail) || {};
    var out = '';
    if (d.perEvent && d.perEvent.length) {
      var keys = d.keys || ['em', 'ph', 'fbp', 'fbc', 'external_id'];
      out += '<table class="dq-tbl"><caption class="dq-sr">Meta match keys per event, last 7 days</caption><thead><tr><th scope="col">Event</th><th scope="col">Sent</th>' + keys.map(function (k) { return '<th scope="col">' + esc(k) + '</th>'; }).join('') + '</tr></thead><tbody>' +
        d.perEvent.map(function (e) { return '<tr><td>' + esc(e.event) + '</td><td>' + fmt(e.n) + '</td>' + keys.map(function (k) { return '<td class="' + (e[k] < 0.5 ? 'low' : '') + '">' + pct(e[k]) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table>';
    }
    var items = [];
    Object.keys(d).forEach(function (k) {
      if (k === 'perEvent' || k === 'keys') return;
      var v = d[k];
      if (v && typeof v === 'object') {
        var inner = Object.keys(v).map(function (s) {
          var x = v[s];
          if (x && typeof x === 'object') return esc(x.label || s) + ': ' + Object.keys(x).filter(function (y) { return y !== 'label'; }).map(function (y) { return esc(y) + ' ' + fmt(x[y]); }).join(', ');
          return esc(s) + ': ' + fmt(x);
        });
        if (inner.length) items.push('<li>' + esc(LABEL[k] || k) + ': ' + inner.join('; ') + '</li>');
      } else if (/Rate$/.test(k)) items.push('<li>' + esc(LABEL[k] || k) + ': ' + pct(v) + '</li>');
      else if (typeof v === 'boolean') items.push('<li>' + esc(LABEL[k] || k) + ': ' + (v ? 'yes' : 'no') + '</li>');
      else items.push('<li>' + esc(LABEL[k] || k) + ': ' + fmt(v) + '</li>');
    });
    return out + (items.length ? '<ul class="dq-kv">' + items.join('') + '</ul>' : '');
  }
  function row(c) {
    var t = c.today, measured = t && t.n != null;
    var cls = !measured ? '' : c.warn ? 'warn' : 'ok';
    var status = !measured ? 'Not measured' : c.warn ? 'Needs a look' : 'Clean';
    var n = measured ? '<b>' + fmt(t.n) + '</b>' + (t.total != null ? ' <span class="muted">of ' + fmt(t.total) + '</span>' : '') : '<span class="muted">–</span>';
    return '<div class="dq-row" data-check="' + esc(c.key) + '"><span class="dq-dot ' + cls + '" role="img" aria-label="' + status + '"></span>' +
      '<div><div class="dq-name">' + esc(c.label) + '</div><div class="dq-what">' + esc(c.scope === '7d' ? 'Last 7 days. ' : 'Right now. ') + esc(c.what) + '</div></div>' +
      '<div class="dq-n">' + n + spark(c.history) + '</div>' + trend(c) +
      '<details class="dq-more"><summary>Details and fix</summary>' + (t && t.note ? '<p class="muted">' + esc(t.note) + '</p>' : '') + detail(c) + examples(c) +
      '<p class="dq-fix"><a href="' + esc(c.fix.href) + '">Fix in ' + esc(c.fix.label) + '</a></p></details></div>';
  }

  function exportsCard(d) {
    var to = new Date(), from = new Date(Date.now() - 29 * 86400000);
    var recent = (d.exports || []).map(function (x) {
      return '<li>' + esc(new Date(x.created_at).toLocaleString()) + ': ' + esc(x.dataset) + ' ' + esc(String(x.format).toUpperCase()) + ', ' + fmt(x.rows) + ' rows' + (x.pii ? ', with personal details' : '') + (x.capped ? ', capped' : '') + '</li>';
    }).join('');
    return '<div class="card" style="margin-top:14px" data-dq-export><h2>Exports</h2>' +
      '<p class="sub">CSV or JSON of a table for a date range (your time zone). Up to ' + fmt(d.cap) + ' rows per file. Every download is logged in Command, Activity.</p>' +
      '<form class="dq-form" data-dq-form>' +
      '<label>Table<select class="input" name="dataset">' + (d.datasets || []).map(function (x) { return '<option value="' + esc(x.key) + '">' + esc(x.label) + '</option>'; }).join('') + '</select></label>' +
      '<label>From<input class="input" type="date" name="from" value="' + ymd(from) + '" required></label>' +
      '<label>To<input class="input" type="date" name="to" value="' + ymd(to) + '" required></label>' +
      '<label class="dq-check"><input type="checkbox" name="pii" value="1"> Include names, emails and phone numbers (admin only; leave off for a file you share)</label>' +
      '<div class="dq-actions"><button class="btn-sm" type="submit" name="format" value="csv">Download CSV</button><button class="btn-sm" type="submit" name="format" value="json">Download JSON</button></div>' +
      '</form><p class="muted" data-dq-msg role="status" style="margin-top:8px"></p>' +
      (recent ? '<details style="margin-top:8px"><summary>Recent exports</summary><ul class="dq-kv">' + recent + '</ul></details>' : '') + '</div>';
  }

  function section(ctx) {
    css();
    var host = document.createElement('div');
    host.setAttribute('data-dq', '');
    ctx.view.appendChild(host);
    function draw() {
      return fetch('/admin/api/dataq', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
        if (!d || !d.checks) { host.innerHTML = ''; return; }
        var warn = d.checks.filter(function (c) { return c.warn; }).length;
        host.innerHTML = '<div class="card" style="margin-top:14px"><div class="dq-head"><h2 id="dq-title">Data quality</h2>' +
          '<span class="muted">' + (d.day ? 'Checked ' + esc(new Date(d.computedAt).toLocaleString()) + ' · ' + warn + ' of ' + d.checks.length + ' need a look' : 'Not checked yet. The daily check runs after 6am your time.') + '</span>' +
          '<button class="btn-sm" type="button" data-dq-run>Run checks now</button></div>' +
          '<p class="sub">Each check counts real rows and lists example ids. The day before is the previous stored run; the summary also goes to Command each morning.</p>' +
          '<div class="dq-list" role="list" aria-labelledby="dq-title">' + d.checks.map(row).join('').replace(/class="dq-row"/g, 'class="dq-row" role="listitem"') + '</div></div>' + exportsCard(d);
        host.querySelector('[data-dq-run]').onclick = function (e) {
          var b = e.currentTarget; b.disabled = true; b.textContent = 'Checking…';
          ctx.send('POST', 'dataq/run', {}).then(function (r) { ctx.toast(r && r.ok ? 'Checks done: ' + r.warnings + ' need a look' : 'The checks did not run'); return draw(); }, function () { b.disabled = false; b.textContent = 'Run checks now'; });
        };
        var form = host.querySelector('[data-dq-form]'), msg = host.querySelector('[data-dq-msg]');
        form.onsubmit = function (e) {
          e.preventDefault();
          var fd = new FormData(form), fmtv = (e.submitter && e.submitter.value) || 'csv';
          if (fd.get('from') > fd.get('to')) { msg.textContent = 'The end date is before the start date.'; return; }
          var q = new URLSearchParams({ dataset: fd.get('dataset'), from: fd.get('from'), to: fd.get('to'), format: fmtv });
          if (fd.get('pii')) q.set('pii', '1');
          var a = document.createElement('a'); a.href = '/admin/api/dataq/export?' + q.toString(); a.download = ''; document.body.appendChild(a); a.click(); a.remove();
          msg.textContent = 'Download started. It is logged in Command, Activity.';
        };
      }).catch(function () { host.innerHTML = '<div class="card" style="margin-top:14px">Data quality could not load. Refresh the page.</div>'; });
    }
    return draw();
  }

  root.DataQualityBoard = { section: section };
})(window);
