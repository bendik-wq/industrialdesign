/* Funnel HQ → Win-back: bring cold leads into the masterclass, the next live webinar or the next challenge cohort.
   Segment builder with a live count and the exact list of who would receive it, destination, sequence settings,
   Preview (every email for a sample lead), Send test (to your own address), Start (a proposal in Command that only
   your approval turns on), Pause / Resume / Stop, and the report per campaign.
   Loaded before admin.js, which calls WinbackBoard.render(ctx) with its helpers (api, send, esc, tile, …). */
(function (root) {
  'use strict';
  var CSS = '.wbk-card{margin-top:14px}.wbk-head{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:baseline;justify-content:space-between}.wbk-head h2{margin:0}' +
    '.wbk-lede{margin:6px 0 0;color:var(--muted,#6e6e73);max-width:70ch}' +
    '.wbk-off{display:flex;gap:10px;align-items:flex-start;padding:12px 14px;margin-top:12px;background:#f5f5f7;border-radius:10px;font-size:14px}.wbk-off b{color:#0f2c5c}' +
    '.wbk-list{width:100%;border-collapse:collapse;font-size:13px;margin-top:10px}.wbk-list th,.wbk-list td{padding:8px 6px;border-top:1px solid var(--line,#e5e7eb);text-align:left;vertical-align:top}.wbk-list th{position:static;background:none}.wbk-list .num{text-align:right;white-space:nowrap}' +
    '.wbk-list tr[data-wbk-open]{cursor:pointer}.wbk-list tr[data-wbk-open]:hover td{background:#f5f5f7}.wbk-list tr.on td{background:#eef2f8}' +
    '.wbk-pill{display:inline-block;padding:2px 8px;border-radius:99px;font-size:12px;background:#f5f5f7;color:#3a3a3c}.wbk-pill.running{background:#e7f4ec;color:#1d6b42}.wbk-pill.proposed{background:#fff4dd;color:#8a5a00}.wbk-pill.paused{background:#eef2f8;color:#0f2c5c}' +
    '.wbk-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px 20px;margin-top:12px}.wbk-form fieldset{border:0;padding:0;margin:0;min-width:0}.wbk-form legend{font-size:12px;font-weight:600;color:#0f2c5c;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px}' +
    '.wbk-form label{display:flex;gap:6px;align-items:center;font-size:14px;margin:4px 0}.wbk-form label.col{display:grid;gap:4px}.wbk-form .input{width:100%;box-sizing:border-box}.wbk-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.wbk-row .input{width:auto;min-width:0;flex:1}' +
    '.wbk-count{display:flex;align-items:baseline;gap:10px;margin:16px 0 4px;padding-top:12px;border-top:1px solid var(--line,#e5e7eb)}.wbk-count strong{font-family:Newsreader,Georgia,serif;font-size:36px;font-weight:500;line-height:1}' +
    '.wbk-ex{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}.wbk-ex span{font-size:12px;background:#f5f5f7;border-radius:99px;padding:3px 10px}' +
    '.wbk-steps{display:flex;flex-wrap:wrap;gap:4px 14px;margin:10px 0 0;padding:0;list-style:none;font-size:13px;color:#6e6e73}.wbk-steps li.done{color:#1d6b42}.wbk-steps li.now{color:#0f2c5c;font-weight:600}' +
    '.wbk-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:12px}.wbk-actions .input{max-width:260px}' +
    '.wbk-mail{border-top:1px solid var(--line,#e5e7eb);padding:14px 0}.wbk-mail h3{margin:0 0 2px;font-size:15px}.wbk-mail iframe{width:100%;height:460px;border:0;background:#fff;border-radius:8px;box-shadow:0 0 0 1px #e5e5ea;margin-top:8px}' +
    '.wbk-warn{color:#8a5a00}.wbk-nodata{color:#6e6e73;font-size:14px;margin:8px 0}' +
    '@media (max-width:700px){.wbk-list thead{display:none}.wbk-list tr{display:grid;grid-template-columns:1fr 1fr;gap:2px 10px;padding:8px 0;border-top:1px solid var(--line,#e5e7eb)}.wbk-list td{border:0;padding:2px 0}.wbk-list td.num{text-align:left}.wbk-list td[data-l]:before{content:attr(data-l) " ";color:#6e6e73}.wbk-mail iframe{height:520px}}';

  var STATUS = { draft: 'Draft', proposed: 'Waiting for your approval', running: 'Running', paused: 'Paused', stopped: 'Stopped', done: 'Finished' };
  var DEST = { masterclass: 'Masterclass', live: 'Live webinar', challenge: 'Challenge' };
  var sel = null;

  function render(ctx) {
    var view = ctx.view, esc = ctx.esc, n = ctx.n, when = ctx.when, tile = ctx.tile, toast = ctx.toast;
    if (!document.getElementById('wbk-css')) { var st = document.createElement('style'); st.id = 'wbk-css'; st.textContent = CSS; document.head.appendChild(st); }
    return ctx.api('winback', {}, { noRange: true }).then(function (d) {
      var cs = d.campaigns || [];
      if (sel && sel !== 'new' && !cs.some(function (c) { return c.id === sel; })) sel = null;
      if (!sel) sel = cs.length ? cs[0].id : 'new';
      var cur = sel === 'new' ? null : cs.filter(function (c) { return c.id === sel; })[0];
      var o = d.options, def = o.defaults;
      var c = cur || { id: null, name: '', status: 'draft', rules: def.rules, destination: 'masterclass', dest_ref: null, steps: def.steps, gap_days: def.gap_days, daily_cap: def.daily_cap, window_from: def.window_from, window_to: def.window_to, report: null };
      var draft = c.status === 'draft';

      var money = function (rev) { var k = Object.keys(rev || {}); if (!k.length) return '–'; return k.map(function (cur) { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(rev[cur]); } catch (e) { return cur + ' ' + n(rev[cur]); } }).join(' + '); };
      var rowsHtml = cs.map(function (x) {
        var r = x.report || {};
        var cell = function (label, v) { return '<td class="num" data-l="' + label + '">' + (r.hasData ? v : '–') + '</td>'; };
        return '<tr data-wbk-open="' + esc(x.id) + '"' + (x.id === sel ? ' class="on"' : '') + '><td><strong>' + esc(x.name) + '</strong><div class="muted">' + esc(DEST[x.destination]) + '</div></td>' +
          '<td><span class="wbk-pill ' + esc(x.status) + '">' + esc(STATUS[x.status] || x.status) + '</span>' + (x.held_reason && x.status === 'running' ? '<div class="wbk-warn small">' + esc(x.held_reason) + '</div>' : '') + '</td>' +
          cell('Sent', n(r.sent)) + cell('Opened', n(r.opened)) + cell('Clicked', n(r.clicked)) + cell('Registered', n(r.registered)) + cell('Attended', n(r.attended)) + cell('Bought', n(r.bought)) + cell('Revenue', money(r.revenue)) + '</tr>';
      }).join('');
      var list = '<div class="card"><div class="wbk-head"><h2>Win-back campaigns</h2><button class="btn-sm" data-wbk-new>New campaign</button></div>' +
        '<p class="wbk-lede">Invite people who went cold (lost, no-show, cancelled, applied and never booked, registered and never bought, bought a ticket and never the Sprint) into the Masterclass, the next live webinar or the next challenge cohort.</p>' +
        '<div class="wbk-off"><span aria-hidden="true">●</span><span><b>Nothing sends until you start it.</b> Start sends a proposal to Command → Approvals, and only your approval turns a campaign on. Pause or Stop at any time.</span></div>' +
        (cs.length ? '<table class="wbk-list"><thead><tr><th>Campaign</th><th>Status</th><th class="num">Sent</th><th class="num">Opened</th><th class="num">Clicked</th><th class="num">Registered</th><th class="num">Attended</th><th class="num">Bought</th><th class="num">Revenue</th></tr></thead><tbody>' + rowsHtml + '</tbody></table>'
          : '<p class="wbk-nodata">No campaigns yet. Build the first one below.</p>') + '</div>';

      var r = c.rules || def.rules;
      var chk = function (name, value, on, label, hint) { return '<label title="' + esc(hint || '') + '"><input type="checkbox" name="' + name + '" value="' + esc(value) + '"' + (on ? ' checked' : '') + (draft ? '' : ' disabled') + '> ' + esc(label) + '</label>'; };
      var dis = draft ? '' : ' disabled';
      var dests = o.destinations;
      var evOpts = (dests.events || []).map(function (e) { return '<option value="' + esc(e.id) + '"' + (c.dest_ref === e.id ? ' selected' : '') + '>' + esc(e.title + ' · ' + e.when + (e.next ? ' (on /live now)' : '')) + '</option>'; }).join('');
      var coOpts = (dests.cohorts || []).map(function (k) { return '<option value="' + esc(k.id) + '"' + (c.dest_ref === k.id ? ' selected' : '') + '>' + esc(k.name + ' · Day 1 ' + k.when + (k.next ? ' (on /challenge now)' : '')) + '</option>'; }).join('');
      var mc = dests.masterclass || {};
      var radio = function (v, label, extra) { return '<label><input type="radio" name="destination" value="' + v + '"' + (c.destination === v ? ' checked' : '') + dis + '> ' + label + '</label>' + (extra || ''); };
      var form = '<div class="card wbk-card"><div class="wbk-head"><h2>' + (cur ? esc(cur.name) : 'New campaign') + '</h2>' + (cur ? '<span class="wbk-pill ' + esc(c.status) + '">' + esc(STATUS[c.status]) + '</span>' : '') + '</div>' +
        (draft ? '' : '<p class="muted small">Only a draft can be edited. Stop this campaign and start a new one to change it.</p>') +
        '<form data-wbk-form class="wbk-form">' +
        '<fieldset><legend>Name</legend><input class="input" name="name" value="' + esc(c.name || '') + '" placeholder="Lost and no-shows into the live webinar"' + dis + '></fieldset>' +
        '<fieldset><legend>Who</legend>' + o.segments.map(function (s) { return chk('segments', s.id, (r.segments || []).indexOf(s.id) >= 0, s.label, s.hint); }).join('') + '</fieldset>' +
        '<fieldset><legend>How cold</legend><label class="col">Quiet for at least (days)<input class="input" type="number" name="minDays" min="0" max="3650" value="' + esc(r.minDays) + '"' + dis + '></label>' +
        '<label class="col">And at most (days, blank for no limit)<input class="input" type="number" name="maxDays" min="1" max="3650" value="' + esc(r.maxDays == null ? '' : r.maxDays) + '"' + dis + '></label>' +
        '<label class="col">Leave out anyone emailed by reactivation or win-back in the last (days)<input class="input" type="number" name="recentDays" min="0" max="365" value="' + esc(r.recentDays) + '"' + dis + '></label></fieldset>' +
        '<fieldset><legend>Tier</legend>' + o.tiers.map(function (t) { return chk('tiers', t, (r.tiers || []).indexOf(t) >= 0, t === 'none' ? 'No tier' : t + '-tier'); }).join('') + '<p class="muted small">None ticked means every tier.</p></fieldset>' +
        '<fieldset><legend>Revenue</legend>' + o.bands.map(function (b) { return chk('bands', b.id, (r.bands || []).indexOf(b.id) >= 0, b.label); }).join('') + '<p class="muted small">None ticked means every band.</p></fieldset>' +
        '<fieldset><legend>Invite them to</legend>' +
        radio('masterclass', 'The Masterclass', '<div class="muted small">' + esc(mc.title || '') + (mc.next ? ' · next showing ' + esc(mc.next) : mc.jitEvery ? ' · showings every ' + esc(mc.jitEvery) + ' minutes' : '') + (mc.price ? ' · ticket ' + esc(mc.price) : '') + '</div>') +
        radio('live', 'A live webinar', '<select class="input" name="dest_ref_live"' + dis + '>' + (evOpts || '<option value="">No live webinar scheduled</option>') + '</select>') +
        radio('challenge', 'A challenge cohort', '<select class="input" name="dest_ref_challenge"' + dis + '>' + (coOpts || '<option value="">No cohort scheduled</option>') + '</select>') +
        '</fieldset>' +
        '<fieldset><legend>Sequence</legend><label class="col">Emails per person<select class="input" name="steps"' + dis + '>' + [4, 5, 6].map(function (k) { return '<option' + (Number(c.steps) === k ? ' selected' : '') + '>' + k + '</option>'; }).join('') + '</select></label>' +
        '<label class="col">Days between emails<input class="input" type="number" name="gap_days" min="1" max="14" value="' + esc(c.gap_days) + '"' + dis + '></label></fieldset>' +
        '<fieldset><legend>Sending</legend><label class="col">Most emails a day<input class="input" type="number" name="daily_cap" min="1" max="500" value="' + esc(c.daily_cap) + '"' + dis + '></label>' +
        '<div class="wbk-row"><label class="col">From<input class="input" type="number" name="window_from" min="0" max="23" value="' + esc(c.window_from) + '"' + dis + '></label><label class="col">to<input class="input" type="number" name="window_to" min="1" max="24" value="' + esc(c.window_to) + '"' + dis + '></label></div>' +
        '<p class="muted small">Hours in ' + esc(d.timezone) + '. A person’s emails stop the moment they register, buy, book, apply or reply.</p></fieldset>' +
        '</form>' +
        '<div class="wbk-count"><strong data-wbk-count>…</strong><span class="muted" data-wbk-count-label>people match right now</span></div>' +
        '<div class="wbk-ex" data-wbk-ex></div><div data-wbk-people></div>' +
        (draft ? '<div class="wbk-actions"><button class="btn-sm" data-wbk-save>' + (cur ? 'Save draft' : 'Create draft') + '</button>' + (cur ? '<button class="btn-sm ghost" data-wbk-delete>Delete draft</button>' : '') + '</div>' : '') +
        '</div>';

      var steps = cur ? [
        ['Draft', true], ['Preview', !!cur.__previewed || !!cur.test_sent_at], ['Test sent', !!cur.test_sent_at], ['Approved in Command', !!cur.approved_at], ['Running', cur.status === 'running'],
      ] : [];
      var ctrl = cur ? '<div class="card wbk-card"><div class="wbk-head"><h2>Controls</h2>' + (cur.action && cur.status === 'proposed' ? '<a href="#command" data-go="command">Open Command → Approvals</a>' : '') + '</div>' +
        '<ul class="wbk-steps">' + steps.map(function (s, i) { var now = !s[1] && (i === 0 || steps[i - 1][1]); return '<li class="' + (s[1] ? 'done' : now ? 'now' : '') + '">' + (s[1] ? '✓ ' : (i + 1) + '. ') + esc(s[0]) + '</li>'; }).join('') + '</ul>' +
        (cur.held_reason && cur.status === 'running' ? '<p class="wbk-warn">Holding sends: ' + esc(cur.held_reason) + '</p>' : '') +
        (cur.ended_reason ? '<p class="muted">' + esc(cur.ended_reason) + '</p>' : '') +
        '<div class="wbk-actions"><button class="btn-sm ghost" data-wbk-preview>Preview every email</button>' +
        (draft ? '<input class="input" type="email" data-wbk-to placeholder="Your email" value="' + esc(cur.test_to || (d.email && d.email.owner) || '') + '"><button class="btn-sm ghost" data-wbk-test>Send test to me</button>' +
          '<button class="btn-sm" data-wbk-start' + (cur.test_sent_at ? '' : ' disabled title="Send yourself a test first"') + '>Start (needs your approval)</button>' : '') +
        (cur.status === 'running' ? '<button class="btn-sm ghost" data-wbk-pause>Pause</button>' : '') +
        (cur.status === 'paused' ? '<button class="btn-sm" data-wbk-resume>Resume</button>' : '') +
        (['running', 'paused', 'proposed'].indexOf(cur.status) >= 0 ? '<button class="btn-sm ghost" data-wbk-stop>Stop</button>' : '') + '</div>' +
        (cur.test_sent_at ? '<p class="muted small">Test sent to ' + esc(cur.test_to) + ' ' + esc(when(cur.test_sent_at)) + (d.email && !d.email.configured ? ' (simulated: connect Resend to receive it)' : '') + '.</p>' : '') +
        (d.personalize === 'ai' ? '<p class="muted small">At send time Claude rewrites each email around the person’s own answers; the preview shows the version without the rewrite. The email with the guarantees is never rewritten.</p>' : '') +
        '<div data-wbk-mails></div></div>' : '';

      var rep = cur ? cur.report : null;
      var report = cur ? '<div class="card wbk-card"><div class="wbk-head"><h2>Results</h2><span class="muted">' + (rep && rep.enrolled ? n(rep.enrolled) + ' enrolled · ' + n(rep.active) + ' still in the sequence' : '') + '</span></div>' +
        (rep && rep.hasData ? '<div class="grid g-4 tiles" style="margin-top:12px">' +
          tile('Sent', n(rep.sent), rep.simulated ? n(rep.simulated) + ' simulated (Resend not connected)' : n(rep.people) + ' people') +
          tile('Opened', n(rep.opened), 'Apple Mail opens count too') +
          tile('Clicked', n(rep.clicked), n(rep.clickers) + ' people') +
          tile('Registered', n(rep.registered), 'after their first win-back email') +
          tile('Attended', n(rep.attended), '') +
          tile('Bought', n(rep.bought), '') +
          tile('Revenue', money(rep.revenue), 'net of refunds') + '</div>' +
          (rep.stopReasons && rep.stopReasons.length ? '<p class="muted small">Stopped or finished: ' + rep.stopReasons.map(function (s) { return esc((s.reason || s.status) + ' ' + s.n); }).join(' · ') + '</p>' : '')
          : '<p class="wbk-nodata">No data yet. Results appear here once the first email goes out.</p>') + '</div>' : '';

      view.innerHTML = list + form + ctrl + report;
      wire(d, c, cur);
    });

    function formBody(c) {
      var f = view.querySelector('[data-wbk-form]');
      var all = function (name) { return Array.prototype.map.call(f.querySelectorAll('[name="' + name + '"]:checked'), function (x) { return x.value; }); };
      var v = function (name) { var el = f.querySelector('[name="' + name + '"]'); return el ? el.value : ''; };
      var dest = (f.querySelector('[name="destination"]:checked') || {}).value || 'masterclass';
      return {
        id: c.id, name: v('name'), destination: dest, dest_ref: dest === 'live' ? v('dest_ref_live') : dest === 'challenge' ? v('dest_ref_challenge') : null,
        rules: { segments: all('segments'), minDays: Number(v('minDays')), maxDays: v('maxDays') === '' ? null : Number(v('maxDays')), recentDays: Number(v('recentDays')), tiers: all('tiers'), bands: all('bands') },
        steps: Number(v('steps')), gap_days: Number(v('gap_days')), daily_cap: Number(v('daily_cap')), window_from: Number(v('window_from')), window_to: Number(v('window_to')),
      };
    }

    function showAudience(a) {
      var countEl = view.querySelector('[data-wbk-count]');
      if (!countEl) return;
      countEl.textContent = n(a.count);
      view.querySelector('[data-wbk-count-label]').textContent = a.count === 1 ? 'person matches right now' : 'people match right now';
      view.querySelector('[data-wbk-ex]').innerHTML = (a.excluded || []).map(function (e) { return '<span title="' + esc((e.sample || []).join(', ')) + '">Left out: ' + esc(e.reason) + ' · ' + n(e.n) + '</span>'; }).join('');
      var seg = {}; (ctx.__opts || []).forEach(function (s) { seg[s.id] = s.label; });
      var rows = (a.rows || []).slice(0, 100).map(function (p) {
        return '<tr><td data-l=""><strong>' + esc(p.name) + '</strong><div class="muted">' + esc(p.email) + '</div></td><td data-l="Group">' + esc(seg[p.segment] || p.segment) + '</td><td data-l="Tier">' + esc(p.tier || '–') + '</td>' +
          '<td data-l="Revenue">' + esc(p.revenue || '–') + '</td><td data-l="Quiet">' + n(p.days_quiet) + ' days</td><td data-l="Known">' + esc(p.data === 'full' ? 'Full application' : p.data === 'some' ? 'Some answers' : 'Name only') + (p.industry ? ' · ' + esc(p.industry) : '') + '</td></tr>';
      }).join('');
      view.querySelector('[data-wbk-people]').innerHTML = a.count ? '<table class="wbk-list"><thead><tr><th>Who would receive it</th><th>Group</th><th>Tier</th><th>Revenue</th><th>Quiet</th><th>What we know</th></tr></thead><tbody>' + rows + '</tbody></table>' +
        (a.count > 100 ? '<p class="muted small">Showing 100 of ' + n(a.count) + '.</p>' : '') : '<p class="wbk-nodata">Nobody matches these rules right now.</p>';
    }

    function wire(d, c, cur) {
      ctx.__opts = d.options.segments;
      view.querySelectorAll('[data-wbk-open]').forEach(function (tr) { tr.onclick = function () { sel = tr.getAttribute('data-wbk-open'); ctx.reload(); }; });
      var nb = view.querySelector('[data-wbk-new]'); if (nb) nb.onclick = function () { sel = 'new'; ctx.reload(); };
      var timer = null;
      var refresh = function () {
        clearTimeout(timer);
        timer = setTimeout(function () {
          var p = cur && cur.status !== 'draft' ? ctx.api('winback/' + encodeURIComponent(cur.id) + '/audience', {}, { noRange: true }) : ctx.send('POST', 'winback/audience', formBody(c));
          p.then(function (a) { if (a && a.ok !== false) showAudience(a); else toast((a && a.error) || 'Could not count'); });
        }, 250);
      };
      var f = view.querySelector('[data-wbk-form]');
      if (f) { f.addEventListener('change', refresh); f.addEventListener('input', refresh); }
      refresh();
      var on = function (sel2, fn) { var el = view.querySelector(sel2); if (el) el.onclick = fn; };
      on('[data-wbk-save]', function () {
        var b = formBody(c);
        (cur ? ctx.send('PUT', 'winback/' + encodeURIComponent(cur.id), b) : ctx.send('POST', 'winback', b)).then(function (r) {
          toast(r.ok ? 'Draft saved' : (r.error || 'Could not save'));
          if (r.ok) { sel = r.campaign.id; ctx.reload(); }
        });
      });
      on('[data-wbk-delete]', function () { if (!confirm('Delete this draft?')) return; ctx.send('DELETE', 'winback/' + encodeURIComponent(cur.id), {}).then(function (r) { toast(r.ok ? 'Deleted' : (r.error || 'Could not delete')); sel = null; ctx.reload(); }); });
      on('[data-wbk-preview]', function () {
        var box = view.querySelector('[data-wbk-mails]');
        box.innerHTML = '<p class="muted">Rendering…</p>';
        ctx.api('winback/' + encodeURIComponent(cur.id) + '/preview', {}, { noRange: true }).then(function (p) {
          if (!p.ok) { box.innerHTML = '<p class="wbk-warn">' + esc(p.error || 'Could not render') + '</p>'; return; }
          var dest = p.destination || {};
          box.innerHTML = '<p class="muted small">Shown for ' + esc(p.lead.name) + (p.lead.sample ? ' (a sample person: nobody matches yet)' : '') + '. Destination: ' + esc(dest.title || '') + (dest.when ? ', ' + esc(dest.when) : '') + '.' + (dest.held ? ' <span class="wbk-warn">' + esc(dest.held) + '</span>' : '') + (dest.closed ? ' <span class="wbk-warn">' + esc(dest.closed) + '</span>' : '') + '</p>' +
            p.emails.map(function (e) {
              return '<div class="wbk-mail"><h3>' + e.step + '. ' + esc(e.subject) + '</h3><div class="muted small">' + esc(e.template) + ' · day ' + e.day + ' · ' + esc(e.preheader) + '</div>' +
                (e.issues && e.issues.length ? '<p class="wbk-warn">Copy check: ' + e.issues.map(function (i) { return esc(i.rule); }).join(', ') + '</p>' : '') +
                '<iframe sandbox="" title="' + esc(e.subject) + '"></iframe></div>';
            }).join('');
          box.querySelectorAll('iframe').forEach(function (fr, i) { fr.srcdoc = p.emails[i].html; });
        });
      });
      on('[data-wbk-test]', function () {
        var to = view.querySelector('[data-wbk-to]').value;
        ctx.send('POST', 'winback/' + encodeURIComponent(cur.id) + '/test', { to: to }).then(function (r) {
          toast(r.ok ? (r.simulated ? 'Test rendered (simulated: Resend is not connected)' : r.emails + ' test emails sent to ' + r.to) : (r.error || 'Could not send'));
          if (r.ok) ctx.reload();
        });
      });
      on('[data-wbk-start]', function () {
        ctx.send('POST', 'winback/' + encodeURIComponent(cur.id) + '/start', {}).then(function (r) {
          toast(r.ok ? 'Sent to Command for your approval. Nothing sends until you approve it.' : (r.error || 'Could not start'));
          ctx.reload();
        });
      });
      on('[data-wbk-pause]', function () { ctx.send('POST', 'winback/' + encodeURIComponent(cur.id) + '/pause', {}).then(function (r) { toast(r.ok ? 'Paused' : (r.error || 'Could not pause')); ctx.reload(); }); });
      on('[data-wbk-resume]', function () { ctx.send('POST', 'winback/' + encodeURIComponent(cur.id) + '/resume', {}).then(function (r) { toast(r.ok ? 'Resumed' : (r.error || 'Could not resume')); ctx.reload(); }); });
      on('[data-wbk-stop]', function () { if (!confirm('Stop this campaign for good? Nobody gets another email from it.')) return; ctx.send('POST', 'winback/' + encodeURIComponent(cur.id) + '/stop', {}).then(function (r) { toast(r.ok ? 'Stopped' : (r.error || 'Could not stop')); ctx.reload(); }); });
    }
  }

  root.WinbackBoard = { render: render };
})(window);
