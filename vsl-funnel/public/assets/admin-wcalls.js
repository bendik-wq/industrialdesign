/* Funnel HQ → AI calls → Webinar calls: AI phone calls for the automated webinar, the live Zoom webinar and the
   5-day challenge. Per-flow switch, script and cadence, the upcoming queue, outcomes (answered, voicemail, joined
   after the call, bought after the call, opted out) with revenue after calls from our payment tables, the agent and
   a "call me" test. Loaded before admin.js; renderVoice calls WebinarCalls.render(ctx) into its own container. */
(function (root) {
  'use strict';
  var CSS = '.wc-wrap{margin-top:14px;display:grid;gap:14px}.wc-head{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:flex-start;justify-content:space-between}.wc-head h2{margin:0}' +
    '.wc-rules{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;align-items:end;margin-top:12px}.wc-rules label{display:grid;gap:4px;font-size:13px}' +
    '.wc-flow{border-top:1px solid var(--border,#e5e7eb);padding:14px 0 4px}.wc-flow:first-of-type{border-top:0;padding-top:4px}.wc-flow-h{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}' +
    '.wc-flow-h h3{margin:0;font-size:14px;font-weight:650}.wc-switch{display:inline-flex;align-items:center;gap:8px;font-size:13px;cursor:pointer}.wc-switch input{width:18px;height:18px}' +
    '.wc-step{margin:10px 0 0;padding:10px 0 0;border-top:1px dashed var(--border,#e5e7eb)}.wc-step summary{cursor:pointer;display:flex;flex-wrap:wrap;gap:6px 14px;align-items:baseline;list-style:none}.wc-step summary::-webkit-details-marker{display:none}' +
    '.wc-step summary b{font-weight:600;font-size:13.5px}.wc-out{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12.5px;color:var(--muted,#6e6e73)}.wc-out span b{color:var(--ink,#1d1d1f);font-weight:600}' +
    '.wc-edit{display:grid;gap:8px;margin-top:10px}.wc-edit textarea{width:100%;min-height:150px;box-sizing:border-box;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}.wc-cad{display:flex;flex-wrap:wrap;gap:10px;align-items:end}.wc-cad label{display:grid;gap:4px;font-size:12.5px}.wc-cad input{width:110px}' +
    '.wc-open{font-size:12.5px;color:var(--muted,#6e6e73);margin:0}.wc-issues{color:#8a5a00;font-size:12.5px;margin:4px 0 0;padding-left:18px}.wc-test{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.wc-test .input{flex:1;min-width:180px}' +
    '.wc-rev{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:13px}.wc-note{font-size:12px;color:var(--muted,#6e6e73);margin:8px 0 0}' +
    '@media (max-width:640px){.wc-cad input{width:90px}.wc-test .btn-sm{width:100%}}';
  var FUNNEL = { auto: 'Webinar', live: 'Live Zoom', ch: 'Challenge', pass: 'Purchase', vip: 'VIP' };

  function render(ctx) {
    var esc = ctx.esc, n = ctx.n, when = ctx.when, table = ctx.table, toast = ctx.toast, el = ctx.el;
    if (!el) return Promise.resolve();
    if (!document.getElementById('wc-css')) { var st = document.createElement('style'); st.id = 'wc-css'; st.textContent = CSS; document.head.appendChild(st); }
    return ctx.api('webinar-calls').then(function (d) {
      if (!d || !d.flows) { el.innerHTML = ''; return; }
      var r = d.rules || {};
      var status = d.ready ? '<span class="pill ok">live</span>' : '<span class="pill">not set up</span>';
      var setup = d.ready ? '' : '<p class="wc-open">' + (d.elevenReady ? 'ElevenLabs is connected. Create the webinar call agent to start: nothing is called until it exists.' : 'Finish the ElevenLabs steps above first (API key, phone number). Then create the webinar call agent here.') + '</p>';
      var head = '<div class="card"><div class="wc-head"><div><h2>Webinar calls</h2><p class="sub">AI calls for the automated webinar, the live Zoom webinar and the 5-day challenge. Only people who ticked a call box, inside their local calling hours (from the phone number, holidays excluded). The caller says it’s an AI assistant for Josh’s team at the start, voicemail on the first attempt only, at most ' + esc(r.perDay) + ' calls a person a day and ' + esc(r.weeklyCap) + ' a week across every flow, ' + esc(r.dailyCap) + ' calls a day in all. Stop, not interested or do not call ends every call and email at once. Each step stops the moment its goal is met.</p></div>' + status + '</div>' + setup +
        '<div class="row" style="gap:8px;flex-wrap:wrap"><button class="btn-sm' + (d.agentId ? ' ghost' : '') + '" data-wc-provision' + (d.elevenReady ? '' : ' disabled') + '>' + (d.agentId ? 'Update webinar call agent' : 'Create webinar call agent') + '</button>' + (d.agentId ? '<span class="muted mono" style="align-self:center">' + esc(d.agentId) + '</span>' : '') + '<span class="muted" style="align-self:center">' + n(d.consented) + ' people ticked the call box on a webinar, live or challenge form.</span></div>' +
        '<div class="wc-rules"><label>Minutes away before a “left” call<input class="input" type="number" min="3" max="60" data-wc-rule="leftWaitMin" value="' + esc(r.leftWaitMin) + '"></label>' +
        '<label>Max calls per person per week<input class="input" type="number" min="0" max="14" data-wc-rule="weeklyCap" value="' + esc(r.weeklyCap) + '"></label>' +
        '<label>Your mobile for tests<input class="input" data-wc-rule="ownerNumber" placeholder="+61412345678" value="' + esc(r.ownerNumber) + '"></label>' +
        '<button class="btn-sm ghost" data-wc-rules>Save</button></div>' +
        (r.callback ? '' : '<p class="wc-issues" style="padding:0">Set the callback number under Integrations → Voice: every call and voicemail reads it out.</p>') + '</div>';

      var flows = '<div class="card"><h2>Flows and scripts</h2><p class="sub">Outcomes for the selected date range. Scripts use the {{placeholders}} shown in each default; offer facts, prices, the guarantee wording and close times come from your settings at dial time.</p>' +
        d.flows.map(function (f) {
          return '<div class="wc-flow"><div class="wc-flow-h"><h3>' + esc(f.label) + '</h3><label class="wc-switch"><input type="checkbox" data-wc-toggle="' + esc(f.id) + '"' + (f.enabled ? ' checked' : '') + '> ' + (f.enabled ? 'On' : 'Off') + '</label></div>' +
            f.steps.map(function (s) {
              var o = s.outcomes || {};
              return '<details class="wc-step" data-wc-step="' + esc(s.kind) + '"><summary><b>' + esc(s.label) + '</b><span class="wc-out">' +
                '<span><b>' + n(o.answered) + '</b> answered</span><span><b>' + n(o.voicemail) + '</b> voicemail</span><span><b>' + n(o.noAnswer) + '</b> no answer</span><span><b>' + n(o.joinedAfter) + '</b> joined or watched after</span><span><b>' + n(o.optedOut) + '</b> opted out</span><span><b>' + n(o.queued) + '</b> waiting</span></span></summary>' +
                '<div class="wc-edit"><p class="wc-open">Opening after the AI disclosure: “' + esc(s.opening) + '”</p>' +
                '<textarea class="input" data-wc-script aria-label="Script for ' + esc(s.label) + '">' + esc(s.script) + '</textarea>' +
                '<div class="wc-cad"><label>Attempts (1 to 3)<input class="input" type="number" min="1" max="3" data-wc-attempts value="' + esc(s.attempts) + '"></label>' +
                '<label>Minutes between attempts<input class="input" type="number" min="5" max="4320" data-wc-spacing value="' + esc(s.spacingMin) + '"></label>' +
                '<button class="btn-sm" data-wc-save>Save script</button><button class="btn-sm ghost" data-wc-reset>Reset to default</button><button class="btn-sm ghost" data-wc-test="' + esc(s.kind) + '"' + (d.ready ? '' : ' disabled') + '>Call me with this script</button></div>' +
                '<ul class="wc-issues" data-wc-issues hidden></ul></div></details>';
            }).join('') + '</div>';
        }).join('') + '</div>';

      var rev = d.revenue || {};
      var revenue = '<div class="card"><h2>Bought after a call</h2>' +
        ((rev.purchases || []).length ? '<div class="wc-rev">' + rev.byCurrency.map(function (x) { return '<span><b>' + esc(x.label) + '</b> in all</span>'; }).join('') + rev.purchases.map(function (p) { return '<span>' + esc(p.kind) + ': ' + n(p.n) + ' (' + esc(p.label) + ')</span>'; }).join('') + '</div>' : ctx.emptyState('No data yet', 'Purchases after an answered webinar call show here.')) +
        '<p class="wc-note">' + esc(rev.note || '') + '</p></div>';

      var queue = '<div class="card"><h2>Upcoming webinar calls</h2>' + table([
        { label: 'When', nw: true, html: function (q) { return esc(when(q.run_at)); } },
        { label: 'Who', html: function (q) { return '<a href="#lead=' + esc(q.lead_id) + '" data-wc-open="' + esc(q.lead_id) + '">' + esc([q.first_name, q.last_name].filter(Boolean).join(' ') || 'lead') + '</a>'; } },
        { label: 'Call', html: function (q) { return esc(q.label) + ' <span class="muted">#' + esc((q.attempts || 0) + 1) + '</span>'; } },
        { label: 'Funnel', html: function (q) { return esc(FUNNEL[q.funnel] || q.funnel || ''); } },
        { label: '', html: function (q) { return '<button class="btn-sm ghost" data-wc-cancel="' + esc(q.id) + '">Cancel</button>'; } },
      ], d.queue || [], { cards: true, empty: 'Nothing waiting', emptyHint: d.ready ? 'Calls appear here a few minutes before they are placed.' : 'Create the webinar call agent to start.' }) + '</div>';

      el.innerHTML = '<div class="wc-wrap">' + head + queue + flows + revenue + '</div>';
      wire(d);
    });

    function wire(d) {
      var post = function (path, body) { return ctx.send('POST', 'webinar-calls' + path, body || {}); };
      var reload = function () { render(ctx); };
      var pv = el.querySelector('[data-wc-provision]');
      if (pv) pv.onclick = function () { pv.disabled = true; pv.textContent = 'Working…'; post('/provision').then(function (r) { toast(r.ok ? (r.created ? 'Webinar call agent created' : 'Webinar call agent updated') : (r.error || 'Failed')); reload(); }); };
      var rs = el.querySelector('[data-wc-rules]');
      if (rs) rs.onclick = function () {
        var b = {}; el.querySelectorAll('[data-wc-rule]').forEach(function (i) { b[i.getAttribute('data-wc-rule')] = i.value; });
        post('/rules', b).then(function (r) { toast(r.ok ? 'Saved' : (r.error || 'Failed')); if (r.ok) reload(); });
      };
      el.querySelectorAll('[data-wc-toggle]').forEach(function (cb) { cb.onchange = function () { post('/toggle', { flow: cb.getAttribute('data-wc-toggle'), on: cb.checked }).then(function (r) { toast(r.ok ? (cb.checked ? 'Flow on' : 'Flow off') : (r.error || 'Failed')); reload(); }); }; });
      var collect = function () {
        var steps = {};
        d.flows.forEach(function (f) { f.steps.forEach(function (s) { steps[s.kind] = { script: s.script, attempts: s.attempts, spacingMin: s.spacingMin }; }); });
        el.querySelectorAll('[data-wc-step]').forEach(function (box) {
          steps[box.getAttribute('data-wc-step')] = { script: box.querySelector('[data-wc-script]').value, attempts: Number(box.querySelector('[data-wc-attempts]').value), spacingMin: Number(box.querySelector('[data-wc-spacing]').value) };
        });
        return { steps: steps };
      };
      el.querySelectorAll('[data-wc-save]').forEach(function (b) {
        b.onclick = function () {
          var box = b.closest('[data-wc-step]'), list = box.querySelector('[data-wc-issues]');
          post('/config', collect()).then(function (r) {
            if (r.ok) { list.hidden = true; toast('Script saved'); return; }
            var mine = (r.issues || []).filter(function (x) { return x.kind === box.getAttribute('data-wc-step'); });
            var all = mine.length ? mine : (r.issues || []);
            list.innerHTML = all.map(function (x) { return x.issues.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join(''); }).join('') || '<li>' + esc(r.error || 'Not saved') + '</li>';
            list.hidden = false;
            toast('Not saved: fix the copy issues listed');
          });
        };
      });
      el.querySelectorAll('[data-wc-reset]').forEach(function (b) {
        b.onclick = function () {
          var box = b.closest('[data-wc-step]'), kind = box.getAttribute('data-wc-step'), def = null;
          d.flows.forEach(function (f) { f.steps.forEach(function (s) { if (s.kind === kind) def = s.defaultScript; }); });
          if (def) box.querySelector('[data-wc-script]').value = def;
        };
      });
      el.querySelectorAll('[data-wc-test]').forEach(function (b) {
        b.onclick = function () {
          var to = (el.querySelector('[data-wc-rule="ownerNumber"]') || {}).value || '';
          b.disabled = true;
          post('/test', { kind: b.getAttribute('data-wc-test'), to: to }).then(function (r) { b.disabled = false; toast(r.ok ? 'Calling you now' : (r.error || 'Failed')); });
        };
      });
      el.querySelectorAll('[data-wc-cancel]').forEach(function (b) { b.onclick = function () { post('/cancel/' + encodeURIComponent(b.getAttribute('data-wc-cancel'))).then(function () { toast('Cancelled'); reload(); }); }; });
      el.querySelectorAll('[data-wc-open]').forEach(function (a) { a.onclick = function (ev) { ev.preventDefault(); if (ctx.openLead) ctx.openLead(a.getAttribute('data-wc-open')); }; });
    }
  }

  root.WebinarCalls = { render: render };
})(window);
