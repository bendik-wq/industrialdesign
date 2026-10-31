/* Funnel HQ → Research: what $1M+ owners complain about and want (Reddit, YouTube, our own leads),
   what competitors run (Meta Ad Library), the themes found in it, and the angle backlog for Marketing.
   Loaded before admin.js, which calls ResearchBoard.render(ctx) with its helpers (api, send, esc, tile, …). */
(function (root) {
  'use strict';
  var CSS = '.rsb-head{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:baseline;justify-content:space-between}.rsb-head h2{margin:0}' +
    '.rsb-actions{display:flex;flex-wrap:wrap;gap:8px}.rsb-notes p{margin:4px 0;font-size:13px}.rsb-notes .warn{color:#8a5a00}' +
    '.rsb-seg{margin:16px 0 8px}.rsb-list{display:grid;gap:0}.rsb-item{padding:14px 0;border-top:1px solid var(--border)}.rsb-item:first-child{border-top:0}' +
    '.rsb-item h3{font-size:15px;margin:0 0 4px;font-weight:650;line-height:1.35}.rsb-item p{margin:4px 0;font-size:13.5px;line-height:1.45}' +
    '.rsb-meta{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:6px 0;font-size:12.5px;color:var(--muted)}' +
    '.rsb-q{margin:6px 0 0;padding:0 0 0 10px;border-left:2px solid var(--border);font-size:13px;color:var(--ink-2)}.rsb-q a{color:#0f2c5c;text-decoration:none;font-size:12px;margin-left:4px;white-space:nowrap}' +
    '.rsb-count{font-variant-numeric:tabular-nums;font-weight:700;color:#0f2c5c}.rsb-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px}' +
    '.rsb-filters{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}.rsb-filters select{min-width:0;max-width:100%}' +
    '.rsb-ad{display:grid;grid-template-columns:110px 1fr;gap:4px 16px;padding:12px 0;border-top:1px solid var(--border)}.rsb-ad:first-child{border-top:0}' +
    '.rsb-days{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums;color:#0f2c5c;line-height:1}.rsb-days small{display:block;font-size:12px;font-weight:500;color:var(--muted);margin-top:2px}' +
    '.rsb-ad p{margin:2px 0;font-size:13px;line-height:1.45;white-space:pre-line}.rsb-cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}' +
    '.rsb-cols .bar-row{grid-template-columns:1fr;gap:2px}.rsb-cols .bar-row .name{white-space:normal}' +
    '@media (max-width:640px){.rsb-ad{grid-template-columns:1fr}.rsb-actions .btn-sm{flex:1 1 auto}}';

  var STATUS = [['new', 'New'], ['approved', 'Approved for testing'], ['testing', 'Testing'], ['winner', 'Winner'], ['retired', 'Retired']];
  var SECTIONS = [['angles', 'Angles'], ['voc', 'Our customers'], ['market', 'Market'], ['ads', 'Competitor ads']];
  var KIND = { post: 'Reddit post', comment: 'Reddit comment', video: 'YouTube', application: 'Application', booking: 'Booking form', objection: 'Call outcome', call_note: 'Call notes', webinar_question: 'Masterclass question', webinar_chat: 'Masterclass chat' };
  var section = 'angles';
  try { section = localStorage.getItem('rsb-section') || 'angles'; } catch (e) { /* private mode */ }

  function render(ctx) {
    var view = ctx.view, esc = ctx.esc, n = ctx.n, when = ctx.when, tile = ctx.tile, toast = ctx.toast;
    if (!document.getElementById('rsb-css')) { var st = document.createElement('style'); st.id = 'rsb-css'; st.textContent = CSS; document.head.appendChild(st); }
    return ctx.api('research', {}, { noRange: true }).then(function (d) {
      if (d.ok === false) { view.innerHTML = '<div class="card">' + esc(d.error || 'Could not load Research.') + '</div>'; return; }
      var c = d.counts || {}, col = d.collection, an = d.analysis;
      var backlog = (d.angles || []).filter(function (a) { return a.status !== 'retired'; }).length;
      var status = '<span class="muted">' +
        (col ? 'Collection ' + esc(col.date) + ': ' + n(col.done) + ' of ' + n(col.total) + ' sources read' : 'Nothing collected yet') +
        (an ? ' · analysis ' + esc(when(an.at)) + ' (' + (an.mode === 'ai' ? 'Claude' : 'keyword rules') + ')' : '') + '</span>';
      var head = '<div class="card"><div class="rsb-head"><h2>Research</h2>' + status + '</div>' +
        '<div class="rsb-actions" style="margin-top:12px"><button class="btn-sm" data-rsb="collect">Collect now</button><button class="btn-sm ghost" data-rsb="analyze">Run analysis</button>' +
        '<button class="btn-sm ghost" data-rsb="brief-preview">Preview weekly brief</button><button class="btn-sm ghost" data-rsb="brief-send">Send brief to Slack</button></div>' +
        ((d.notes || []).length ? '<div class="rsb-notes" style="margin-top:10px">' + d.notes.map(function (x) { return '<p class="' + (x.level === 'warn' ? 'warn' : 'muted') + '">' + esc(x.text) + '</p>'; }).join('') + '</div>' : '') +
        (col && col.errors && col.errors.length ? '<details style="margin-top:8px"><summary class="muted">Source errors in the last run (' + n(col.errors.length) + ')</summary>' + col.errors.map(function (e) { return '<p class="muted small">' + esc(e) + '</p>'; }).join('') + '</details>' : '') +
        '<div data-rsb-brief></div></div>';
      var tiles = '<div class="grid g-4 tiles" style="margin-top:14px">' +
        tile('Own answers', n((c.voc || {}).n || 0), 'Applications, booking forms, calls, masterclass') +
        tile('Public posts and videos', n(((c.reddit || {}).n || 0) + ((c.youtube || {}).n || 0)), n((c.reddit || {}).n || 0) + ' Reddit, ' + n((c.youtube || {}).n || 0) + ' YouTube') +
        tile('Competitor ads', n((c.ads || {}).n || 0), 'Meta Ad Library') +
        tile('Angle backlog', n(backlog), 'Not retired') + '</div>';
      var seg = '<div class="seg rsb-seg" role="tablist">' + SECTIONS.map(function (s) { return '<button type="button" data-rsb-sec="' + s[0] + '" aria-pressed="' + (section === s[0]) + '">' + esc(s[1]) + '</button>'; }).join('') + '</div>';
      view.innerHTML = head + tiles + seg + '<div data-rsb-body></div>';
      wireHead();
      view.querySelectorAll('[data-rsb-sec]').forEach(function (b) {
        b.onclick = function () {
          section = b.getAttribute('data-rsb-sec');
          try { localStorage.setItem('rsb-section', section); } catch (e) { /* ignore */ }
          view.querySelectorAll('[data-rsb-sec]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
          body(d);
        };
      });
      body(d);
    });

    function quotes(list) {
      return (list || []).map(function (q) {
        var link = q.url ? '<a href="' + esc(q.url) + '"' + (q.url.charAt(0) === '/' ? '' : ' target="_blank" rel="noopener noreferrer"') + '>' + esc(q.community || KIND[q.kind] || 'source') + ' ↗</a>' : '<span class="muted small">' + esc(q.community || '') + '</span>';
        return '<blockquote class="rsb-q">' + esc(q.quote) + ' ' + link + '</blockquote>';
      }).join('');
    }

    function themeList(themes, empty) {
      if (!themes.length) return ctx.emptyState(empty);
      return '<div class="rsb-list">' + themes.map(function (t) {
        return '<div class="rsb-item"><h3><span class="rsb-count">' + n(t.count) + '</span> ' + esc(t.label) + ' <span class="pill">' + esc(t.kind) + '</span></h3>' +
          (t.summary ? '<p class="muted">' + esc(t.summary) + '</p>' : '') + quotes(t.quotes) + '</div>';
      }).join('') + '</div>';
    }

    function bars(title, rows) {
      if (!rows || !rows.length) return '';
      var max = rows[0].count || 1;
      return '<div class="card"><h2>' + esc(title) + '</h2><div class="bars" style="margin-top:10px">' + rows.slice(0, 8).map(function (r) {
        return '<div class="bar-row"><span class="name" title="' + esc(r.label) + '">' + esc(r.label) + '</span><span class="bar-track"><span class="bar-fill" style="width:' + Math.max(2, Math.round(r.count / max * 100)) + '%"></span><span class="bar-val">' + n(r.count) + '</span></span></div>';
      }).join('') + '</div></div>';
    }

    function body(d) {
      var box = view.querySelector('[data-rsb-body]');
      var themes = d.themes || [];
      if (section === 'voc') {
        var v = d.voc || {};
        box.innerHTML = '<div class="rsb-cols">' + bars('What held applicants back', v.blockers) + bars('Their goal', v.goals) + bars('Objections logged on calls', v.objections) + '</div>' +
          '<div class="card" style="margin-top:14px"><h2>Themes in what our leads wrote</h2><p class="sub">From application answers, booking forms, call notes and masterclass questions and chat' + (v.applicants ? ' (' + n(v.applicants) + ' applicants in the last 12 months)' : '') + '. Counts are the answers linked to each theme.</p>' +
          themeList(themes.filter(function (t) { return t.scope === 'voc'; }), 'No themes yet. Collect, then run the analysis.') + '</div>';
        return;
      }
      if (section === 'market') {
        box.innerHTML = '<div class="card"><h2>What owners say in public</h2><p class="sub">Reddit posts and comments and rising YouTube videos. Counts are the posts linked to each theme; every quote links to its source.</p>' +
          themeList(themes.filter(function (t) { return t.scope === 'market'; }), 'No market themes yet. Collect, then run the analysis.') + '</div>';
        return;
      }
      if (section === 'ads') return adsSection(d, box);
      anglesSection(d, box);
    }

    function anglesSection(d, box) {
      var filter = box.getAttribute('data-filter') || '';
      var list = (d.angles || []).filter(function (a) { return filter ? a.status === filter : a.status !== 'retired'; });
      var counts = {}; (d.angles || []).forEach(function (a) { counts[a.status] = (counts[a.status] || 0) + 1; });
      var filters = '<div class="rsb-filters"><select class="input" data-rsb-filter aria-label="Show angles"><option value="">All but retired</option>' + STATUS.map(function (s) { return '<option value="' + s[0] + '"' + (filter === s[0] ? ' selected' : '') + '>' + esc(s[1]) + ' (' + n(counts[s[0]] || 0) + ')</option>'; }).join('') + '</select></div>';
      var items = list.map(function (a) {
        var sel = '<select class="input" data-rsb-status="' + esc(a.id) + '" aria-label="Status">' + STATUS.map(function (s) { return '<option value="' + s[0] + '"' + (a.status === s[0] ? ' selected' : '') + '>' + esc(s[1]) + '</option>'; }).join('') + '</select>';
        var sendBtn = a.action_id && a.status !== 'new' ? '<span class="muted small">Sent to Marketing ' + esc(when(a.sent_at)) + '</span>' : '<button class="btn-sm" data-rsb-send="' + esc(a.id) + '">Send to Marketing</button>';
        return '<div class="rsb-item"><h3>' + esc(a.hook) + '</h3><p>' + esc(a.promise) + '</p>' +
          '<div class="rsb-meta"><span class="pill">' + esc(a.audience || '') + '</span><span class="pill">' + esc(a.revenue_band || '') + '</span><span>Breaks the belief: ' + esc(a.belief || '') + '</span></div>' +
          (a.proof ? '<p class="muted small">Proof: ' + esc(a.proof) + '</p>' : '') +
          (a.evidence && a.evidence.length ? '<details><summary class="muted small">Evidence (' + n(a.evidence.length) + ')</summary>' + quotes(a.evidence) + '</details>' : '') +
          '<div class="rsb-row">' + sel + sendBtn + '<span class="muted small">' + (a.origin === 'ai' ? 'Drafted by Claude' : 'From the approved templates') + ' · ' + esc(when(a.created_at)) + '</span></div></div>';
      }).join('');
      box.innerHTML = '<div class="card"><div class="card-head"><div><h2>Angle backlog</h2><p class="sub">Each angle passed the copy rules and the originality check against competitor ads. Send to Marketing proposes a test in the action log for approval.</p></div></div>' +
        filters + (items ? '<div class="rsb-list">' + items + '</div>' : ctx.emptyState('No angles here yet.', 'Run the analysis to draft angles from the themes.')) + '</div>';
      var f = box.querySelector('[data-rsb-filter]');
      if (f) f.onchange = function () { box.setAttribute('data-filter', f.value); anglesSection(d, box); };
      box.querySelectorAll('[data-rsb-status]').forEach(function (s) {
        s.onchange = function () {
          ctx.send('PATCH', 'research/angles/' + encodeURIComponent(s.getAttribute('data-rsb-status')), { status: s.value }).then(function (r) {
            toast(r.ok ? 'Status saved' : (r.error || 'Could not save'));
            if (r.ok) { (d.angles || []).forEach(function (a) { if (a.id === s.getAttribute('data-rsb-status')) a.status = s.value; }); anglesSection(d, box); }
          });
        };
      });
      box.querySelectorAll('[data-rsb-send]').forEach(function (b) {
        b.onclick = function () {
          b.disabled = true;
          ctx.send('POST', 'research/angles/' + encodeURIComponent(b.getAttribute('data-rsb-send')) + '/send', {}).then(function (r) {
            toast(r.ok ? 'Sent to Marketing for approval' : (r.error || 'Could not send'));
            if (r.ok) ctx.reload(); else b.disabled = false;
          });
        };
      });
    }

    function adsSection(d, box) {
      var comp = (d.themes || []).filter(function (t) { return t.scope === 'competitor'; });
      var offers = comp.length ? '<div class="rsb-list">' + comp.map(function (t) {
        var m = t.meta || {};
        return '<div class="rsb-item"><h3>' + esc(t.label) + ' <span class="muted small">' + n(m.ads || 0) + ' ads, ' + n(m.active || 0) + ' live, longest ' + n(m.longestDays || 0) + ' days</span></h3>' +
          (m.aiHook ? '<p>Hook: ' + esc(m.aiHook) + '</p>' : '') + (m.aiOffer ? '<p>Offer: ' + esc(m.aiOffer) + '</p>' : '') +
          (m.aiGuarantee ? '<p>Guarantee: ' + esc(m.aiGuarantee) + '</p>' : '') + (m.aiPrice ? '<p>Price: ' + esc(m.aiPrice) + '</p>' : '') +
          '<div class="rsb-meta">' + (m.offers || []).map(function (o) { return '<span class="pill">' + esc(o) + '</span>'; }).join('') + (m.prices && m.prices.length ? '<span>Prices seen: ' + esc(m.prices.join(', ')) + '</span>' : '') + '</div></div>';
      }).join('') + '</div>' : ctx.emptyState('No competitor offers read yet.', 'Add the Ad Library token and competitor names under Integrations → Research, then collect.');
      box.innerHTML = '<div class="card"><h2>Competitor offers</h2><p class="sub">Per advertiser: what they lead with, what they sell and how long their longest ad has run. For reading the market only; angles never reuse their wording.</p>' + offers + '</div>' +
        '<div class="card" style="margin-top:14px"><h2>Ads board</h2><p class="sub">Days running is a proxy for winners: advertisers rarely keep paying for an ad that loses money.</p>' +
        '<div class="rsb-filters"><select class="input" data-ads-adv aria-label="Advertiser"><option value="">All advertisers</option></select>' +
        '<select class="input" data-ads-days aria-label="Running for"><option value="0">Any age</option><option value="7">7+ days</option><option value="30">30+ days</option><option value="90">90+ days</option></select>' +
        '<label class="muted small"><input type="checkbox" data-ads-active> Live only</label></div><div data-ads-list><p class="muted">Loading…</p></div></div>';
      var adv = box.querySelector('[data-ads-adv]'), days = box.querySelector('[data-ads-days]'), live = box.querySelector('[data-ads-active]');
      function load(first) {
        ctx.api('research/ads', { advertiser: adv.value, minDays: days.value, active: live.checked ? '1' : '' }, { noRange: true }).then(function (r) {
          if (first) adv.innerHTML = '<option value="">All advertisers</option>' + (r.advertisers || []).map(function (a) { return '<option value="' + esc(a.name) + '">' + esc(a.name) + ' (' + n(a.n) + ')</option>'; }).join('');
          var listBox = box.querySelector('[data-ads-list]');
          listBox.innerHTML = (r.ads || []).length ? r.ads.map(function (a) {
            return '<div class="rsb-ad"><div class="rsb-days">' + (a.days == null ? '–' : n(a.days)) + '<small>days ' + (a.active ? 'live' : 'ran') + '</small></div><div>' +
              '<div class="rsb-meta"><strong style="color:var(--ink)">' + esc(a.page_name || a.tracked_as) + '</strong>' + (a.competitor ? '' : '<span class="pill">' + esc(a.tracked_as) + '</span>') +
              (a.platforms || []).map(function (p) { return '<span class="pill">' + esc(String(p).toLowerCase()) + '</span>'; }).join('') + (a.start_at ? '<span>since ' + esc(new Date(a.start_at).toLocaleDateString()) + '</span>' : '') + '</div>' +
              (a.title ? '<p><strong>' + esc(a.title) + '</strong></p>' : '') + (a.body ? '<p>' + esc(a.body) + '</p>' : '') +
              '<div class="rsb-meta">' + (a.caption ? '<span>Lands on ' + esc(a.caption) + '</span>' : '') + '<a href="' + esc(a.link_url) + '" target="_blank" rel="noopener noreferrer">Ad Library ↗</a></div></div></div>';
          }).join('') : ctx.emptyState('No ads match.', 'Change the filters, or collect first.');
        });
      }
      adv.onchange = days.onchange = live.onchange = function () { load(false); };
      load(true);
    }

    function wireHead() {
      var btn = function (k) { return view.querySelector('[data-rsb="' + k + '"]'); };
      var busy = function (b, on, label) { b.disabled = on; if (label) b.textContent = label; };
      btn('collect').onclick = function () {
        var b = btn('collect'); busy(b, true, 'Collecting…');
        ctx.send('POST', 'research/collect', {}).then(function (r) { toast(r.ok ? r.message : (r.error || 'Could not collect')); busy(b, false, 'Collect now'); if (r.ok) ctx.reload(); });
      };
      btn('analyze').onclick = function () {
        var b = btn('analyze'); busy(b, true, 'Analysing…');
        ctx.send('POST', 'research/analyze', {}).then(function (r) { toast(r.ok ? n(r.themes) + ' themes, ' + n(r.anglesAdded) + ' new angles' + (r.note ? '. ' + r.note : '') : (r.error || 'Could not analyse')); busy(b, false, 'Run analysis'); if (r.ok) ctx.reload(); });
      };
      btn('brief-preview').onclick = function () {
        ctx.api('research/brief', {}, { noRange: true }).then(function (r) {
          view.querySelector('[data-rsb-brief]').innerHTML = '<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)"><h2>' + esc(r.title || 'Research brief') + '</h2>' + (r.lines || []).map(function (l) { return '<p style="margin:4px 0;font-size:13.5px">' + esc(l) + '</p>'; }).join('') + '</div>';
        });
      };
      btn('brief-send').onclick = function () {
        var b = btn('brief-send'); busy(b, true);
        ctx.send('POST', 'research/brief', {}).then(function (r) {
          busy(b, false);
          toast(r.ok ? (r.sent && (r.sent.slack || r.sent.discord) ? 'Brief sent and logged' : 'Brief logged. No Slack or Discord webhook is set.') : (r.error || 'Could not send'));
        });
      };
    }
  }

  root.ResearchBoard = { render: render };
})(window);
