/* Funnel HQ: AI search on Cloudflare Vectorize, and the AI Gateway note (Cloudflare round, builder C).
   HQVectors.lead(el, leadId, h)    → in the lead drawer: leads whose application reads most like this one.
   HQVectors.leads(el, h)           → on Leads: a search box over room questions, objections, call notes and answers,
                                      and "Leads like my buyers" (the centre of recent buyers, nearest who haven't bought).
   HQVectors.integrations(el, h)    → on Integrations: index status, "Index a batch now", and the AI Gateway link.
   Everything reads /admin/api/vectors/* (admin only). With VECTOR_SEARCH off, or where Vectorize doesn't run
   (local dev), each panel says so instead of failing. */
(function (root) {
  'use strict';
  var CSS = '.vx-list{list-style:none;padding:0;margin:8px 0 0;font-size:13px}.vx-list li{display:grid;grid-template-columns:1fr auto;gap:4px 12px;padding:8px 0;border-top:1px solid var(--border,#e5e5e5)}.vx-list li:first-child{border-top:0}' +
    '.vx-list .vx-m{color:var(--muted,#86868b);font-size:12px;overflow-wrap:anywhere}.vx-score{font-variant-numeric:tabular-nums;color:var(--muted,#86868b);font-size:12px;white-space:nowrap}' +
    '.vx-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.vx-row .input{flex:1;min-width:200px}.vx-kind{display:inline-block;font-size:11px;padding:1px 7px;border-radius:9px;background:var(--surface-2,#f5f5f7);margin-right:6px}' +
    '.vx-two{display:grid;grid-template-columns:1fr 1fr;gap:14px}@media (max-width:760px){.vx-two{grid-template-columns:1fr}}.vx-link{cursor:pointer;color:var(--accent,#0f2c5c);background:none;border:0;padding:0;font:inherit;text-align:left}';
  function css() { if (!document.getElementById('vx-css')) { var s = document.createElement('style'); s.id = 'vx-css'; s.textContent = CSS; document.head.appendChild(s); } }
  function get(path) { return fetch('/admin/api/vectors' + path, { credentials: 'same-origin' }).then(function (r) { return r.json().catch(function () { return { ok: false, note: 'HTTP ' + r.status }; }); }); }
  function post(path) { return fetch('/admin/api/vectors' + path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' }).then(function (r) { return r.json().catch(function () { return { ok: false, note: 'HTTP ' + r.status }; }); }); }
  var KIND = { q: 'Room question', note: 'Call note', lead: 'Application' };
  var LOOK = null;

  function leadList(list, h, empty) {
    var esc = h.esc;
    if (!list || !list.length) return '<p class="muted small">' + esc(empty) + '</p>';
    return '<ul class="vx-list">' + list.map(function (l) {
      return '<li><div><button type="button" class="vx-link" data-vx-lead="' + esc(l.id) + '"><strong>' + esc(l.name) + '</strong></button>' +
        '<div class="vx-m">' + esc([l.tier ? 'Tier ' + l.tier : '', l.status, l.band, l.bought ? 'bought' : ''].filter(Boolean).join(' · ')) + (l.business ? ' · ' + esc(l.business) : '') + '</div></div>' +
        '<span class="vx-score" title="Similarity (1 = the same)">' + esc(Number(l.score).toFixed(2)) + '</span></li>';
    }).join('') + '</ul>';
  }
  function wireLeads(el, h) { el.querySelectorAll('[data-vx-lead]').forEach(function (b) { b.onclick = function () { if (h.openLead) h.openLead(b.getAttribute('data-vx-lead')); }; }); }

  function lead(el, leadId, h) {
    if (!el) return;
    css();
    get('/similar/' + encodeURIComponent(leadId)).then(function (d) {
      if (d.off) { el.hidden = true; el.innerHTML = ''; return; } // AI search off: the drawer looks as it always did
      el.hidden = false;
      el.innerHTML = '<h2>Similar leads</h2><p class="sub">Leads whose application reads most like this one (AI search).</p>' +
        (d.ok ? leadList(d.leads, h, d.note || 'No similar leads in the index yet.') : '<p class="muted small">' + h.esc(d.note || 'Not available.') + '</p>');
      wireLeads(el, h);
    }, function () { el.innerHTML = '<h2>Similar leads</h2><p class="muted small">Couldn’t reach Funnel HQ.</p>'; });
  }

  function leads(el, h) {
    if (!el) return;
    css();
    var esc = h.esc;
    // The Leads list re-renders as you type; the lookalikes list is kept for a minute between renders.
    var cached = LOOK && Date.now() - LOOK.at < 60000 ? Promise.resolve(LOOK.d) : get('/lookalikes').then(function (d) { LOOK = { at: Date.now(), d: d }; return d; });
    cached.then(function (d) {
      if (d.off) { el.hidden = true; el.innerHTML = ''; return; } // AI search off: the Leads tab looks as it always did
      el.hidden = false;
      draw(d);
    }, function () { el.hidden = true; });
    function draw(first) {
    el.innerHTML = '<div class="vx-two">' +
      '<div class="card"><h2>Search by meaning</h2><p class="sub">Room questions and objections, call notes and summaries, and application answers. Finds “worried about the bank” when they wrote “lender”.</p>' +
      '<form class="vx-row" data-vx-search><input class="input" type="search" name="q" maxlength="300" placeholder="e.g. worried about a personal guarantee" aria-label="Search by meaning"><button class="btn-sm" type="submit">Search</button></form><div data-vx-hits></div></div>' +
      '<div class="card"><h2>Leads like my buyers</h2><p class="sub">The centre of your recent buyers’ applications, and the leads nearest to it who haven’t bought yet.</p><div data-vx-look><p class="muted small">Loading…</p></div></div></div>';
    var look = el.querySelector('[data-vx-look]');
    var d = first;
    look.innerHTML = d.ok ? (d.buyers ? '<p class="muted small">From ' + esc(d.buyers) + ' recent buyer' + (d.buyers === 1 ? '' : 's') + '.</p>' : '') + leadList(d.leads, h, d.note || 'No matches yet.') : '<p class="muted small">' + esc(d.note || 'Not available.') + '</p>';
    wireLeads(look, h);
    var form = el.querySelector('[data-vx-search]'), out = el.querySelector('[data-vx-hits]');
    form.onsubmit = function (e) {
      e.preventDefault();
      var q = form.q.value.trim();
      if (!q) return;
      out.innerHTML = '<p class="muted small">Searching…</p>';
      get('/search?q=' + encodeURIComponent(q)).then(function (d) {
        if (!d.ok) { out.innerHTML = '<p class="muted small">' + esc(d.note || 'Not available.') + '</p>'; return; }
        if (!d.hits.length) { out.innerHTML = '<p class="muted small">' + esc(d.note || 'Nothing close yet.') + '</p>'; return; }
        out.innerHTML = '<ul class="vx-list">' + d.hits.map(function (x) {
          return '<li><div><span class="vx-kind">' + esc(KIND[x.kind] || x.kind) + '</span>' + esc(x.snippet) +
            '<div class="vx-m">' + (x.leadId ? '<button type="button" class="vx-link" data-vx-lead="' + esc(x.leadId) + '">' + esc(x.leadName || 'Lead') + '</button>' : '') + (x.roomId ? (x.leadId ? ' · ' : '') + 'room ' + esc(x.roomId) : '') + '</div></div>' +
            '<span class="vx-score">' + esc(Number(x.score).toFixed(2)) + '</span></li>';
        }).join('') + '</ul>';
        wireLeads(out, h);
      }, function () { out.innerHTML = '<p class="muted small">Couldn’t reach Funnel HQ.</p>'; });
    };
    }
  }

  function integrations(el, h) {
    if (!el) return;
    css();
    var esc = h.esc, when = h.when || function (t) { return new Date(t).toLocaleString(); };
    get('/status').then(function (d) {
      var g = d.gateway || {};
      var c = d.counts || {};
      el.innerHTML = '<div class="card" style="margin-top:14px"><div class="card-head"><div><h2>AI search and AI Gateway</h2><p class="sub">Cloudflare Vectorize (index gl-knowledge) and AI Gateway. Settings: Keys &amp; settings → AI &amp; search.</p></div></div>' +
        '<dl class="kv">' +
        '<dt>AI search</dt><dd>' + esc(d.on ? 'on' : 'off') + (d.note ? ' · ' + esc(d.note) : '') + '</dd>' +
        '<dt>In the index</dt><dd>' + esc((c.lead || 0) + ' leads · ' + (c.q || 0) + ' room questions · ' + (c.note || 0) + ' call notes · ' + (c.doc || 0) + ' passages of approved material') + (d.lastIndexedAt ? ' · last ' + esc(when(d.lastIndexedAt)) : '') + '</dd>' +
        '<dt>Room AI draft</dt><dd>' + esc(d.helper ? 'on (staff see “AI draft” in the room’s Q&A)' : 'off') + '</dd>' +
        '<dt>AI Gateway</dt><dd>' + (g.on ? 'on, gateway “' + esc(g.id) + '”: every Claude call is tagged by feature. <a href="' + esc(g.dashboardUrl) + '" target="_blank" rel="noopener">Open the gateway in Cloudflare ↗</a> to see cost, speed and errors per feature (filter by the metadata key “feature”).' : esc(g.problem || 'off: Claude is called directly. Set AI_GATEWAY_ID (e.g. default) to route calls through Cloudflare AI Gateway.')) + '</dd>' +
        '</dl>' +
        ((d.sources || []).some(function (s) { return s.last_error; }) ? '<p class="muted small">Last errors: ' + esc(d.sources.filter(function (s) { return s.last_error; }).map(function (s) { return s.source + ': ' + s.last_error; }).join('; ')) + '</p>' : '') +
        (d.on ? '<div class="row" style="margin-top:10px"><button class="btn-sm ghost" type="button" data-vx-run>Index a batch now</button><button class="btn-sm ghost" type="button" data-vx-restart>Re-check everything</button><span class="muted small" data-vx-out></span></div>' : '') + '</div>';
      var out = el.querySelector('[data-vx-out]');
      var run = el.querySelector('[data-vx-run]'), rs = el.querySelector('[data-vx-restart]');
      if (run) run.onclick = function () { run.disabled = true; out.textContent = 'Indexing…'; post('/run').then(function (r) { run.disabled = false; out.textContent = r.ok ? 'Done: ' + (r.sources || []).map(function (s) { return s.source + ' ' + s.embedded; }).join(', ') + ' embedded.' : (r.note || 'Failed.'); }); };
      if (rs) rs.onclick = function () { rs.disabled = true; post('/restart').then(function () { rs.disabled = false; out.textContent = 'Every source starts over on the next batch. Unchanged text is not embedded again.'; }); };
    }, function () { el.innerHTML = ''; });
  }

  root.HQVectors = { lead: lead, leads: leads, integrations: integrations };
})(window);
