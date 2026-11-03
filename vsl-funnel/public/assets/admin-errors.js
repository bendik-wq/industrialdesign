/* Funnel HQ → Errors & cron (infra, overnight round 1): the internal error log and the 5-minute cron's per-job
   timings. Data from /admin/api/errors (src/infra/admin.ts). Errors are grouped by fingerprint (kind + where +
   message with ids blanked), counted per day, kept 14 days. Loaded before admin.js; renderErrors calls
   ErrorsBoard.render(ctx). */
(function (root) {
  'use strict';
  var CSS = '.er-wrap{display:grid;gap:14px}.er-kinds{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12.5px;color:var(--muted,#6e6e73);margin:0 0 10px}' +
    '.er-msg{font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-word;max-width:520px}.er-stack{white-space:pre-wrap;font:11.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted,#6e6e73);margin:6px 0 0}' +
    '.er-msg details summary{cursor:pointer;list-style:none}.er-msg details summary::-webkit-details-marker{display:none}' +
    '.er-st{display:inline-flex;align-items:center;gap:5px}.er-dot{width:8px;height:8px;border-radius:50%;background:var(--muted,#6e6e73)}' +
    '.er-st.ok .er-dot{background:var(--good,#16a34a)}.er-st.failed .er-dot{background:var(--critical,#d03b3b)}.er-st.slow .er-dot{background:var(--warning,#fab219)}' +
    '.er-head{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:flex-start;justify-content:space-between}.er-head h2{margin:0}' +
    '.er-sub{font-size:14px;margin:14px 0 6px}.er-switch{display:inline-flex;align-items:center;gap:8px;font-size:13px;cursor:pointer}.er-switch input{width:18px;height:18px}.er-note{font-size:12px;color:var(--muted,#6e6e73);margin:8px 0 0}';
  var KIND = { request: 'Page or API', webhook: 'Webhook', cron: 'Cron job', room: 'Room', csp: 'Content policy (CSP)', queue: 'Queue or workflow' };
  var JOB = { email: 'Emails', sms: 'Texts', call: 'AI calls', track: 'Tracking forwards' };
  var FLOW = { running: 'running', done: 'finished', stopped: 'handed back to the cron', failed: 'failed' };
  var ST = { ok: 'OK', failed: 'Failed', slow: 'Slow' };

  function ms(v) { if (v == null) return '–'; v = Number(v); return v >= 10000 ? (v / 1000).toFixed(0) + ' s' : v >= 1000 ? (v / 1000).toFixed(1) + ' s' : Math.round(v) + ' ms'; }

  function render(ctx) {
    var esc = ctx.esc, n = ctx.n, when = ctx.when, view = ctx.view;
    if (!document.getElementById('er-css')) { var st = document.createElement('style'); st.id = 'er-css'; st.textContent = CSS; document.head.appendChild(st); }
    return ctx.api('errors', {}, { noRange: true }).then(function (d) {
      if (!d || !d.days) { view.innerHTML = ctx.emptyState('Couldn’t load the error log.'); return; }
      var t = d.totals || {};
      var tiles = '<div class="grid g-4 tiles">' +
        ctx.tile('Errors today (UTC)', n(t.today)) +
        ctx.tile('Errors, last ' + d.retentionDays + ' days', n(t.window)) +
        ctx.tile('Distinct errors', n(t.distinct)) +
        ctx.tile('New today', n(t.newToday)) + '</div>';

      var max = Math.max.apply(null, d.days.map(function (x) { return x.total; }).concat([1]));
      var kindTotals = {};
      d.days.forEach(function (x) { Object.keys(x.kinds).forEach(function (k) { kindTotals[k] = (kindTotals[k] || 0) + x.kinds[k]; }); });
      var kinds = Object.keys(kindTotals).map(function (k) { return '<span>' + esc(KIND[k] || k) + ' <b>' + n(kindTotals[k]) + '</b></span>'; }).join('');
      var perDay = '<div class="card"><h2>Errors per day</h2><p class="sub">UTC days, newest first. Hover a bar for the split by kind.</p>' +
        (kinds ? '<p class="er-kinds">' + kinds + '</p>' : '') +
        '<div class="bars">' + d.days.slice().reverse().map(function (x) {
          var split = Object.keys(x.kinds).map(function (k) { return (KIND[k] || k) + ' ' + x.kinds[k]; }).join(', ');
          var w = x.total ? Math.max(1, Math.round(x.total / max * 100)) : 0;
          return '<div class="bar-row" title="' + esc(x.day + ': ' + (split || 'no errors')) + '"><span class="name">' + esc(x.day) + '</span><span class="bar-track"><span class="bar-fill' + (w ? '' : ' zero') + '" style="width:' + w + '%"></span><span class="bar-val">' + n(x.total) + (x.fingerprints ? '<small>' + n(x.fingerprints) + ' distinct</small>' : '') + '</span></span></div>';
        }).join('') + '</div></div>';

      var fps = '<div class="card"><h2>Errors by fingerprint</h2><p class="sub">One row per distinct error, latest first. Open a message for the first lines of its stack.</p>' +
        ctx.table([
          { label: 'Kind', key: 'kind', nw: true, fmt: function (v) { return KIND[v] || v; } },
          { label: 'Where', key: 'source' },
          { label: 'Message', html: function (r) { return '<div class="er-msg">' + (r.stack ? '<details><summary>' + esc(r.message) + '</summary><pre class="er-stack">' + esc(r.stack) + '</pre></details>' : esc(r.message)) + '</div>'; } },
          { label: 'Last ' + d.retentionDays + ' days', key: 'recent', num: true, fmt: n },
          { label: 'All time', key: 'count', num: true, fmt: n },
          { label: 'First seen', key: 'first_at', nw: true, fmt: when },
          { label: 'Last seen', key: 'last_at', nw: true, fmt: when },
        ], d.fingerprints, { cards: true, empty: 'No errors in the last ' + d.retentionDays + ' days.', emptyHint: 'Unhandled page and API errors, webhook failures, cron job failures and room errors show up here.' }) + '</div>';

      var c = d.cron || {}, lt = c.lastTick;
      var tick = lt ? 'Last run ' + esc(when(lt.at)) + ', ' + esc(ms(lt.ms)) + ' for ' + n(lt.jobs) + ' jobs' + (lt.failed && lt.failed.length ? ', failed: ' + esc(lt.failed.join(', ')) : '') + (lt.slow && lt.slow.length ? ', slow: ' + esc(lt.slow.join(', ')) : '') + '.' : 'The cron hasn’t run since this log was added.';
      var cron = '<div class="card"><h2>Cron jobs (every 5 minutes)</h2><p class="sub">' + tick + ' Each job runs on its own with a ' + esc(ms(c.budgetMs)) + ' budget: past it the run is marked Slow and keeps going in the background, so one job can’t hold up the others.</p>' +
        ctx.table([
          { label: 'Job', key: 'job' },
          { label: 'Status', nw: true, html: function (r) { return '<span class="er-st ' + esc(r.last_status) + '"><span class="er-dot" aria-hidden="true"></span>' + esc(ST[r.last_status] || r.last_status) + '</span>'; } },
          { label: 'Last run', key: 'last_started', nw: true, fmt: when },
          { label: 'Duration', key: 'last_ms', num: true, zeroOk: true, fmt: ms },
          { label: 'Average', key: 'avg_ms', num: true, zeroOk: true, fmt: ms },
          { label: 'Longest', key: 'max_ms', num: true, zeroOk: true, fmt: ms },
          { label: 'Runs', key: 'runs', num: true, fmt: n },
          { label: 'Failed', key: 'fails', num: true, fmt: n },
          { label: 'Slow', key: 'slow', num: true, fmt: n },
          { label: 'Last error', html: function (r) { return r.last_status === 'ok' || !r.last_error ? '–' : '<span class="er-msg">' + esc(r.last_error) + '</span>'; } },
        ], c.jobs || [], { cards: 3, empty: 'No cron runs recorded yet.', emptyHint: 'The first run after this deploy fills this in (every 5 minutes).' }) + '</div>';

      var qd = d.queue || {}, qt = qd.totals || {};
      var qState = !qd.on ? 'Off. Emails, texts, AI call dials and tracking forwards send inline from the cron and the pages, as before. Setting SEND_VIA_QUEUE.'
        : !qd.bound ? 'On, but the queue isn’t bound to this Worker, so everything still sends inline. Setting SEND_VIA_QUEUE.'
        : 'On. The cron and the pages hand each message to the gl-send queue, which sends it with retries and backoff. Messages that keep failing move to gl-send-dlq and show below.';
      var queue = '<div class="card"><h2>Send queue</h2><p class="sub">' + esc(qState) + ' Counts are the last ' + n(qd.days || 7) + ' days.</p>' +
        '<div class="grid g-4 tiles">' + ctx.tile('Sent', n(qt.sent)) + ctx.tile('Failed after retries', n(qt.failed)) + ctx.tile('Retried', n(qt.retried)) + ctx.tile('Dead letters', n(qt.dlq)) + '</div>' +
        ((qd.byKind || []).length ? ctx.table([
          { label: 'Kind', key: 'kind', fmt: function (v) { return JOB[v] || v; } },
          { label: 'Sent', key: 'sent', num: true, zeroOk: true, fmt: n },
          { label: 'Waiting', key: 'queued', num: true, zeroOk: true, fmt: n },
          { label: 'Retried', key: 'retried', num: true, zeroOk: true, fmt: n },
          { label: 'Failed', key: 'failed', num: true, zeroOk: true, fmt: n },
          { label: 'Dead letters', key: 'dlq', num: true, zeroOk: true, fmt: n },
        ], qd.byKind, { cards: 3 }) : '') +
        ((qd.dead || []).length ? '<h3 class="er-sub">Dead letters</h3>' + ctx.table([
          { label: 'Kind', key: 'kind', fmt: function (v) { return JOB[v] || v; } },
          { label: 'Message', key: 'ref', fmt: function (v) { return v; } },
          { label: 'Last error', html: function (r) { return r.last_error ? '<span class="er-msg">' + esc(r.last_error) + '</span>' : '–'; } },
          { label: 'When', key: 'updated_at', nw: true, fmt: when },
          { label: '', html: function (r) { return '<button type="button" class="btn-sm ghost" data-q-retry="' + esc(r.key) + '">Retry</button>'; } },
        ], qd.dead, { cards: 3 }) : '<p class="er-note">No dead letters.</p>');
      var fl = d.flows || {}, fb = fl.byStatus || {};
      var fParts = Object.keys(fb).map(function (k) { return n(fb[k]) + ' ' + esc(FLOW[k] || k); });
      queue += '<p class="er-note">Live reminder workflows: ' + (!fl.on ? 'off (setting LIVE_REMINDERS_VIA_WORKFLOW), the cron sends every reminder.' : !fl.bound ? 'on, but the workflow isn’t bound to this Worker, so the cron sends every reminder.' : (fParts.length ? fParts.join(', ') : 'none started yet') + (fl.late ? ', ' + n(fl.late) + ' late (the cron covers those)' : '') + '.') + '</p></div>';

      var slack = d.slack && d.slack.on;
      var head = '<div class="card"><div class="er-head"><div><h2>Error log</h2><p class="sub">Build <span class="mono">' + esc(d.build || '–') + '</span>. Kept ' + n(d.retentionDays) + ' days.</p></div>' +
        '<label class="er-switch"><input type="checkbox" data-er-slack' + (slack ? ' checked' : '') + '> Ping Slack on a new error</label></div>' +
        '<p class="er-note">Off by default. When on, the first time a new error shows up the Command Slack channel gets one message (at most 5 an hour). Setting ERRORS_SLACK.</p></div>';

      view.innerHTML = '<div class="er-wrap">' + head + tiles + perDay + fps + cron + queue + '</div>';
      Array.prototype.forEach.call(view.querySelectorAll('[data-q-retry]'), function (b) {
        b.onclick = function () {
          b.disabled = true;
          ctx.send('POST', 'errors/queue/retry', { key: b.getAttribute('data-q-retry') }).then(function (r) {
            if (r && r.ok) { ctx.toast('Back on the queue.'); ctx.reload(); } else { ctx.toast((r && r.error) || 'Couldn’t retry it.'); b.disabled = false; }
          }).catch(function () { ctx.toast('Couldn’t retry it. Try again.'); b.disabled = false; });
        };
      });
      var box = view.querySelector('[data-er-slack]');
      if (box) box.onchange = function () {
        box.disabled = true;
        ctx.send('POST', 'errors/slack', { on: box.checked }).then(function (r) {
          ctx.toast(r && r.on ? 'Slack pings on new errors are on.' : 'Slack pings on new errors are off.');
        }).catch(function () { box.checked = !box.checked; ctx.toast('Couldn’t save. Try again.'); }).then(function () { box.disabled = false; });
      };
    });
  }

  root.ErrorsBoard = { render: render };
})(window);
