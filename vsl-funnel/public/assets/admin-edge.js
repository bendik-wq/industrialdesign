/* Funnel HQ → Errors & cron: two Cloudflare platform cards (Cloudflare round, builder B).
   - Bot protection: the Turnstile mode (TURNSTILE_MODE) and pass/fail per public form for 7 days (/admin/api/edge/bots).
   - Events (Analytics Engine): per day by event name for 30 days next to D1's own count, and the top paths
     (/admin/api/edge/events, read through Cloudflare's Analytics Engine SQL API).
   Loaded before admin.js; admin-errors.js calls EdgeCards.render(ctx, host) after it draws the error log. */
(function (root) {
  'use strict';
  var FORM = { apply: 'Application', webinar: 'Masterclass registration', live: 'Live registration', challenge: 'Challenge registration', room_join: 'Room join link' };
  var MODE = { off: 'Off', log: 'Log only (nothing is refused)', enforce: 'Enforce (failed checks are refused)' };

  function card(host) { var el = document.createElement('div'); el.className = 'card'; host.appendChild(el); return el; }

  function bots(ctx, el) {
    var esc = ctx.esc, n = ctx.n;
    el.innerHTML = '<h2>Bot protection</h2><p class="sub">Loading…</p>';
    return ctx.api('edge/bots', {}, { noRange: true }).then(function (d) {
      if (!d || !d.forms) { el.innerHTML = '<h2>Bot protection</h2>' + ctx.emptyState('Couldn’t load bot protection.'); return; }
      var rows = d.forms.map(function (f) {
        var checked = f.pass + f.fail + f.missing;
        return { form: FORM[f.form] || f.form, pass: f.pass, fail: f.fail, missing: f.missing, unreachable: f.unreachable, rate: checked ? Math.round(f.pass / checked * 100) + '%' : '–' };
      });
      var any = rows.some(function (r) { return r.pass + r.fail + r.missing + r.unreachable > 0; });
      el.innerHTML = '<h2>Bot protection</h2>' +
        '<p class="sub">Cloudflare Turnstile on the public forms. Mode: <b>' + esc(MODE[d.mode] || d.mode) + '</b>. Last ' + n(d.days) + ' days (UTC).' +
        ' Change it in Integrations → Security (Bot protection mode: off, log or enforce). If Cloudflare can’t be reached, forms always go through.</p>' +
        (d.problem ? '<p class="er-note">' + esc(d.problem) + '</p>' : '') +
        (any || d.mode !== 'off' ? ctx.table([
          { label: 'Form', key: 'form' },
          { label: 'Passed', key: 'pass', num: true, fmt: n },
          { label: 'Failed', key: 'fail', num: true, fmt: n },
          { label: 'No token', key: 'missing', num: true, fmt: n },
          { label: 'Cloudflare unreachable', key: 'unreachable', num: true, fmt: n },
          { label: 'Pass rate', key: 'rate', num: true },
        ], rows, { cards: 3 }) : ctx.emptyState('Bot protection is off.', 'Add the Turnstile keys and set the mode to log to start counting.'));
    }).catch(function () { el.innerHTML = '<h2>Bot protection</h2>' + ctx.emptyState('Couldn’t load bot protection.'); });
  }

  function events(ctx, el) {
    var esc = ctx.esc, n = ctx.n;
    el.innerHTML = '<h2>Events (Analytics Engine)</h2><p class="sub">Loading…</p>';
    return ctx.api('edge/events', {}, { noRange: true }).then(function (d) {
      if (!d || !d.rows) { el.innerHTML = '<h2>Events (Analytics Engine)</h2>' + ctx.emptyState('Couldn’t load the events.'); return; }
      var status = 'Copying: <b>' + (d.on ? (d.binding ? 'on' : 'on, but the EVENTS binding is missing') : 'off') + '</b> (setting ANALYTICS_ENGINE, dataset ' + esc(d.dataset) + '). Last ' + n(d.days) + ' days, UTC. Counts are compared only from the day copying started.';
      var head = '<h2>Events (Analytics Engine)</h2><p class="sub">' + status + '</p>';
      if (!d.configured) { el.innerHTML = head + ctx.emptyState('Add the token in Integrations to read these.', 'Integrations → Analytics: the Cloudflare account ID and an API token with Account Analytics Read.'); return; }
      if (d.error) { el.innerHTML = head + '<p class="er-note">' + esc(d.error) + '</p>'; return; }
      var names = {}, days = {};
      d.rows.forEach(function (r) {
        var t = names[r.name] || (names[r.name] = { name: r.name, ae: 0, d1: 0 }); t.ae += r.ae || 0; t.d1 += r.d1 || 0;
      });
      var byName = Object.keys(names).map(function (k) { return names[k]; }).sort(function (a, b) { return b.ae - a.ae || b.d1 - a.d1; });
      var opts = '<option value="">All events</option>' + byName.map(function (r) { return '<option value="' + esc(r.name) + '">' + esc(r.name) + '</option>'; }).join('');
      el.innerHTML = head +
        '<h3>By event name</h3>' + ctx.table([
          { label: 'Event', key: 'name' },
          { label: 'Analytics Engine', key: 'ae', num: true, fmt: n },
          { label: 'D1', key: 'd1', num: true, fmt: n },
        ], byName.slice(0, 40), { cards: 3, empty: 'No events yet.' }) +
        '<h3>Per day</h3><p><label>Event <select data-edge-name>' + opts + '</select></label></p><div data-edge-days></div>' +
        '<h3>Top paths (page views)</h3>' + ctx.table([
          { label: 'Path', key: 'path' },
          { label: 'Page views', key: 'n', num: true, fmt: n },
        ], d.paths, { empty: 'No page views copied yet.' });
      var pick = el.querySelector('[data-edge-name]'), box = el.querySelector('[data-edge-days]');
      function draw() {
        var want = pick.value; days = {};
        d.rows.forEach(function (r) {
          if (want && r.name !== want) return;
          var t = days[r.day] || (days[r.day] = { day: r.day, ae: 0, d1: 0 }); t.ae += r.ae || 0; t.d1 += r.d1 || 0;
        });
        var list = Object.keys(days).sort().reverse().map(function (k) { return days[k]; });
        box.innerHTML = ctx.table([
          { label: 'Day', key: 'day', nw: true },
          { label: 'Analytics Engine', key: 'ae', num: true, fmt: n },
          { label: 'D1', key: 'd1', num: true, fmt: n },
        ], list, { cards: 3, empty: 'No events on these days.' });
      }
      pick.onchange = draw;
      draw();
    }).catch(function () { el.innerHTML = '<h2>Events (Analytics Engine)</h2>' + ctx.emptyState('Couldn’t load the events.'); });
  }

  function render(ctx, host) {
    if (!host) return;
    bots(ctx, card(host));
    events(ctx, card(host));
  }

  root.EdgeCards = { render: render };
})(window);
