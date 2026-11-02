/* Funnel HQ → Emails → Deliverability (overnight loop round 2, "deliverability + speed"). Read-only.
   DNS health of each sending domain (SPF, bounce MX, DKIM, DMARC, inbox MX, open/click tracking host) looked up
   over DNS-over-HTTPS, with the exact record to add; bounce and complaint rates per day against the thresholds;
   and opens, clicks, bounces and complaints per sequence so a bad sequence stands out.
   Data: GET /admin/api/deliverability (src/admin/deliverability.ts). Mounted by renderEmailsWithFlow() in admin.js:
   window.DeliverabilityBoard.section(ctx). */
(function (root) {
  'use strict';
  var CSS = '.dv-card{margin-top:14px}.dv-head{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:baseline;justify-content:space-between}.dv-head h2{margin:0}' +
    '.dv-dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:#c7c7cc;margin-right:8px;vertical-align:baseline;flex:none}.dv-dot.pass{background:#1d7a3a}.dv-dot.warn{background:#b25000}.dv-dot.fail{background:#c0362c}' +
    '.dv-lvl{font-size:12px;font-weight:650;text-transform:uppercase;letter-spacing:.04em}.dv-lvl.pass{color:#1d7a3a}.dv-lvl.warn{color:#b25000}.dv-lvl.fail{color:#c0362c}' +
    '.dv-dom{margin-top:14px}.dv-dom h3{font-size:15px;margin:0 0 4px}.dv-row{display:grid;grid-template-columns:minmax(120px,170px) minmax(0,1fr);gap:4px 16px;padding:12px 0;border-top:1px solid rgba(0,0,0,.08)}' +
    '.dv-name{font-weight:600;font-size:14px;display:flex;align-items:baseline}.dv-what{font-size:13px}.dv-host{font-size:12px;color:#6e6e73;word-break:break-all}' +
    '.dv-found{font-size:12px;color:#6e6e73;margin-top:4px;word-break:break-all}.dv-fix{margin-top:8px;background:#f5f5f7;border-radius:8px;padding:8px 10px;font-size:12px;display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 10px}' +
    '.dv-fix b{font-weight:600;color:#0f2c5c}.dv-fix code{word-break:break-all;font-size:12px}' +
    '.dv-tiles{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-top:10px}.dv-tile{background:#f5f5f7;border-radius:10px;padding:10px 12px}' +
    '.dv-tile .k{font-size:12px;color:#6e6e73}.dv-tile .v{font-size:22px;font-variant-numeric:tabular-nums;margin-top:2px}.dv-tile .s{font-size:12px;margin-top:2px}' +
    '.dv-chart{display:flex;gap:2px;align-items:flex-end;height:64px;margin-top:12px;border-bottom:1px solid rgba(0,0,0,.12)}.dv-chart i{flex:1;min-width:2px;background:#0f2c5c;opacity:.75;border-radius:1px 1px 0 0;min-height:1px}' +
    '.dv-chart i.warn{background:#b25000;opacity:1}.dv-chart i.fail{background:#c0362c;opacity:1}.dv-axis{display:flex;justify-content:space-between;font-size:11px;color:#6e6e73;margin-top:4px}' +
    '.dv-tbl{border-collapse:collapse;font-size:13px;width:100%}.dv-tbl th,.dv-tbl td{padding:7px 8px;text-align:right;border-bottom:1px solid rgba(0,0,0,.06);white-space:nowrap}.dv-tbl th:first-child,.dv-tbl td:first-child{text-align:left}' +
    '.dv-tbl th{font-size:12px;color:#6e6e73;font-weight:600}.dv-tbl .bad{color:#c0362c;font-weight:600}.dv-tbl .meh{color:#b25000;font-weight:600}.dv-wrap{overflow-x:auto}' +
    '.dv-note{font-size:12px;color:#6e6e73;margin-top:8px}' +
    '@media (max-width:640px){.dv-row{grid-template-columns:1fr}.dv-tile .v{font-size:19px}}';
  function css() { if (!document.getElementById('dv-css')) { var s = document.createElement('style'); s.id = 'dv-css'; s.textContent = CSS; document.head.appendChild(s); } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmt(v) { return v == null ? '–' : new Intl.NumberFormat('en-US').format(v); }
  function pct(v, d) { return v == null || !isFinite(v) ? '–' : (v * 100).toFixed(d == null ? (v > 0 && v < 0.01 ? 2 : 1) : d) + '%'; }
  var WORD = { pass: 'Pass', warn: 'Check', fail: 'Fix' };
  function lvl(l) { return '<span class="dv-lvl ' + esc(l) + '">' + esc(WORD[l] || l) + '</span>'; }

  function checkRow(c) {
    var fix = c.fix ? '<div class="dv-fix"><b>Add</b><span>' + esc(c.fix.type) + (c.fix.priority != null ? ' (priority ' + esc(c.fix.priority) + ')' : '') + '</span><b>Name</b><code>' + esc(c.fix.name) + '</code><b>Value</b><code>' + esc(c.fix.value) + '</code></div>' : '';
    return '<div class="dv-row"><div class="dv-name"><span class="dv-dot ' + esc(c.level) + '" aria-hidden="true"></span><span>' + esc(c.label) + '<br>' + lvl(c.level) + '</span></div>' +
      '<div><div class="dv-what">' + esc(c.detail) + '</div><div class="dv-host">' + esc(c.host) + '</div>' +
      (c.found && c.found.length ? '<div class="dv-found">Found: ' + c.found.map(esc).join(' · ') + '</div>' : '') + fix + '</div></div>';
  }

  function dnsCard(d) {
    var head = '<div class="dv-head"><div><h2><span class="dv-dot ' + esc(d.level) + '" aria-hidden="true"></span>Sending domain health</h2><p class="sub">SPF, DKIM, DMARC, MX and the tracking host, looked up live over DNS-over-HTTPS. Records go in your DNS provider (Cloudflare → DNS).</p></div>' +
      '<button class="btn-sm ghost" type="button" data-dv-refresh>Check again</button></div>';
    if (d.empty) return head + '<p class="muted">' + esc(d.empty) + '</p>';
    var doms = d.domains.map(function (x) {
      return '<div class="dv-dom"><h3>' + esc(x.domain) + (x.isFrom ? ' <span class="pill">From address</span>' : '') + (x.resendStatus ? ' <span class="pill">Resend: ' + esc(x.resendStatus) + '</span>' : '') + '</h3>' +
        x.checks.map(checkRow).join('') + '</div>';
    }).join('');
    return head + doms + (d.note ? '<p class="dv-note">' + esc(d.note) + '</p>' : '') + '<p class="dv-note">Checked ' + esc(new Date(d.checkedAt).toLocaleTimeString()) + '. Answers are kept 10 minutes; DNS changes can take up to an hour to show.</p>';
  }

  function tileHtml(k, v, s, level) { return '<div class="dv-tile"><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div><div class="s">' + (level ? lvl(level) + ' ' : '') + esc(s || '') + '</div></div>'; }

  function trendCard(s) {
    var t = s.thresholds, r = s.range, w = s.last7;
    var max = Math.max.apply(null, s.days.map(function (x) { return x.sent ? (x.bounced + x.complained) / x.sent : 0; }).concat([t.bounceFail]));
    var bars = s.days.map(function (x) {
      var rate = x.sent ? x.bounced / x.sent : 0, crate = x.sent ? x.complained / x.sent : 0;
      var cls = crate >= t.complaintFail || rate >= t.bounceFail ? 'fail' : crate >= t.complaintWarn || rate >= t.bounceWarn ? 'warn' : '';
      var h = Math.max(1, Math.round(((x.bounced + x.complained) / (x.sent || 1)) / max * 62));
      return '<i class="' + cls + '" style="height:' + (x.bounced + x.complained ? h : 1) + 'px" title="' + esc(x.day + ': ' + fmt(x.sent) + ' sent, ' + fmt(x.bounced) + ' bounced, ' + fmt(x.complained) + ' complaints') + '"></i>';
    }).join('');
    var label = s.days.length ? '<div class="dv-axis"><span>' + esc(s.days[0].day) + '</span><span>' + esc(s.days[s.days.length - 1].day) + '</span></div>' : '';
    var desc = 'Bounce and complaint rate per day, ' + s.days.length + ' days: ' + s.days.filter(function (x) { return x.bounced || x.complained; }).map(function (x) { return x.day + ' ' + x.bounced + ' bounced ' + x.complained + ' complaints of ' + x.sent; }).join('; ');
    return '<div class="dv-head"><div><h2>Bounces and complaints</h2><p class="sub">Keep bounces under ' + pct(t.bounceWarn, 0) + ' (over ' + pct(t.bounceFail, 0) + ' risks the Resend account) and spam complaints under ' + pct(t.complaintWarn, 1) + ' (Gmail’s limit is ' + pct(t.complaintFail, 1) + ').</p></div></div>' +
      (s.real === 0 && s.simulated > 0 ? '<p class="muted">Every email in this range was simulated (email isn’t connected), so there are no real bounces to show yet.</p>' : '') +
      '<div class="dv-tiles">' +
      tileHtml('Bounce rate, range', pct(r.bounceRate), fmt(r.bounced) + ' of ' + fmt(r.sent) + ' sent', r.sent >= t.minSent ? r.bounceLevel : null) +
      tileHtml('Complaint rate, range', pct(r.complaintRate, 2), fmt(r.complained) + ' spam reports', r.sent >= t.minSent ? r.complaintLevel : null) +
      tileHtml('Bounce rate, last 7 days', pct(w.bounceRate), fmt(w.bounced) + ' of ' + fmt(w.sent), w.sent >= t.minSent ? w.bounceLevel : null) +
      tileHtml('Complaint rate, last 7 days', pct(w.complaintRate, 2), fmt(w.complained) + ' spam reports', w.sent >= t.minSent ? w.complaintLevel : null) +
      '</div><div class="dv-chart" role="img" aria-label="' + esc(desc) + '">' + bars + '</div>' + label;
  }

  function seqCard(s) {
    var t = s.thresholds;
    var cls = function (v, warn, fail) { return v == null ? '' : v >= fail ? 'bad' : v >= warn ? 'meh' : ''; };
    var rows = s.sequences.map(function (x) {
      return '<tr><td><span class="dv-dot ' + esc(x.level) + '" aria-hidden="true"></span>' + esc(x.sequence) + (x.flags.length ? ' <span class="muted">' + esc(x.flags.join(', ')) + '</span>' : '') + '</td>' +
        '<td>' + fmt(x.sent) + '</td><td class="' + (x.sent >= t.minSentForOpens && x.openRate != null && x.openRate < t.lowOpen ? 'meh' : '') + '">' + pct(x.openRate) + '</td><td>' + pct(x.clickRate) + '</td>' +
        '<td class="' + (x.sent >= t.minSent ? cls(x.bounceRate, t.bounceWarn, t.bounceFail) : '') + '">' + fmt(x.bounced) + ' · ' + pct(x.bounceRate) + '</td>' +
        '<td class="' + (x.complained ? 'bad' : '') + '">' + fmt(x.complained) + '</td></tr>';
    }).join('');
    return '<div class="dv-head"><div><h2>Per sequence</h2><p class="sub">Real sends in the selected range. A sequence with complaints, bounces over ' + pct(t.bounceWarn, 0) + ' or opens under ' + pct(t.lowOpen, 0) + ' is flagged.</p></div></div>' +
      (rows ? '<div class="dv-wrap"><table class="dv-tbl"><thead><tr><th>Sequence</th><th>Sent</th><th>Opened</th><th>Clicked</th><th>Bounced</th><th>Complaints</th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '<p class="muted">No real sends in this range.</p>') +
      '<p class="dv-note">' + esc(s.note) + '</p>';
  }

  function section(ctx) {
    css();
    var box = document.createElement('div');
    box.className = 'dv';
    box.innerHTML = '<div class="card dv-card"><p class="loading-note">Checking the sending domain…</p></div>';
    var anchor = ctx.view.querySelector('.pcflow');
    if (anchor && anchor.nextSibling) ctx.view.insertBefore(box, anchor.nextSibling); else ctx.view.appendChild(box);
    function load(refresh) {
      return ctx.api('deliverability', refresh ? { refresh: 1, fresh: 1 } : null).then(function (d) {
        if (!d || !d.dns) { box.innerHTML = '<div class="card dv-card"><p class="muted">Couldn’t load deliverability.</p></div>'; return; }
        box.innerHTML = '<div class="card dv-card">' + dnsCard(d.dns) + '</div><div class="card dv-card">' + trendCard(d.stats) + '</div><div class="card dv-card">' + seqCard(d.stats) + '</div>';
        var b = box.querySelector('[data-dv-refresh]');
        if (b) b.onclick = function () { b.disabled = true; b.textContent = 'Checking…'; load(true); };
      }, function () { box.innerHTML = '<div class="card dv-card"><p class="muted">Couldn’t load deliverability.</p></div>'; });
    }
    return load(false);
  }

  root.DeliverabilityBoard = { section: section };
})(window);
