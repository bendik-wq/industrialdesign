/* Funnel HQ → Materials: webinar and challenge scripts as a reading view, a run sheet, a slide deck and a presenter window.
   The server parses public/materials/<id>.md (src/admin/materials.ts); this file only renders the parsed JSON.
   Loaded by /admin (Materials.render(ctx), called from admin.js) and by /admin/present (Materials.present()). */
(function (root) {
  'use strict';

  var BRAND = 'G&L M&A Advisory';
  var FONTS = 'https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400..600;1,6..72,400..600&family=Inter:opsz,wght@14..32,400..700&display=swap';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function sec(t) { var p = String(t || '0:0').split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; }
  function mmss(s) { s = Math.max(0, Math.round(s)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }
  function num(n) { return Number(n || 0).toLocaleString('en-US'); }
  function storeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function storeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function getJSON(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (r) {
      if (r.status === 401) { location.href = '/admin/login'; throw new Error('unauthorised'); }
      if (!r.ok) throw new Error('Not found');
      return r.json();
    });
  }
  function fonts() {
    if (document.getElementById('mat-fonts')) return;
    var l = document.createElement('link'); l.id = 'mat-fonts'; l.rel = 'stylesheet'; l.href = FONTS; document.head.appendChild(l);
  }
  function css() {
    if (document.getElementById('mat-css')) return;
    var st = document.createElement('style'); st.id = 'mat-css'; st.textContent = CSS; document.head.appendChild(st);
  }

  var CSS = [
    // Slides: 16:9, sized by their container so the same markup works full screen, in previews and in print.
    '.ms-slide{position:relative;aspect-ratio:16/9;width:100%;container-type:inline-size;overflow:hidden;font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;color:#fff;',
    'background:radial-gradient(62% 65% at 85% 0%,#1a3a72 0%,rgba(26,58,114,0) 60%),linear-gradient(160deg,#0f2c5c 0%,#0b2149 55%,#08183a 100%)}',
    '.ms-slide .ms-in{position:absolute;inset:0;display:flex;flex-direction:column;padding:5.6cqw 7.8cqw 4.4cqw}',
    '.ms-slide .ms-eyebrow{font:500 1.05cqw/1 Inter,system-ui,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:#a9bbdb;min-height:1.2cqw}',
    '.ms-slide .ms-main{flex:1;display:flex;flex-direction:column;justify-content:center;max-width:80cqw}',
    '.ms-slide h1{margin:0;font:500 5.3cqw/1.05 Newsreader,Georgia,serif;letter-spacing:-.06cqw;text-wrap:balance}',
    '.ms-slide h1.long{font-size:4.1cqw;line-height:1.09}.ms-slide h1.xlong{font-size:3.2cqw;line-height:1.14}',
    '.ms-slide h1.quote{font-style:italic}',
    '.ms-slide .ms-sub{margin:1.8cqw 0 0;font:400 2cqw/1.38 Inter,system-ui,sans-serif;color:#cdd8ec;max-width:72cqw;text-wrap:pretty}',
    '.ms-slide .ms-sub.small{font-size:1.55cqw}',
    '.ms-slide .ms-on{margin-top:2.6cqw;display:flex;flex-direction:column;gap:.9cqw}',
    '.ms-slide .ms-on p{margin:0;font:500 1.75cqw/1.35 Inter,system-ui,sans-serif;padding:1.1cqw 1.6cqw;border-left:.32cqw solid #fdd050;background:rgba(255,255,255,.07);border-radius:.2cqw;max-width:78cqw}',
    '.ms-slide .ms-on.many p{font-size:1.35cqw;padding:.8cqw 1.3cqw}',
    '.ms-slide .ms-foot{display:flex;justify-content:space-between;align-items:flex-end;padding-top:1.4cqw;border-top:1px solid rgba(255,255,255,.14);font:400 1.1cqw/1.3 Inter,system-ui,sans-serif;color:#8fa3c7}',
    '.ms-slide .ms-foot b{font:600 1.3cqw/1 Newsreader,Georgia,serif;color:#e8eef9;letter-spacing:.01em}',
    '.ms-slide.light{color:#1d1d1f;background:linear-gradient(180deg,#ffffff 0%,#f5f5f7 100%)}',
    '.ms-slide.light .ms-eyebrow{color:#0f2c5c}.ms-slide.light .ms-sub{color:#515154}.ms-slide.light .ms-on p{background:#fff;border-left-color:#0f2c5c;box-shadow:0 0 0 1px rgba(0,0,0,.06)}',
    '.ms-slide.light .ms-foot{color:#86868b;border-top-color:rgba(0,0,0,.1)}.ms-slide.light .ms-foot b{color:#0f2c5c}',

    // Script view
    '.mat-script{max-width:760px;font-size:16px;line-height:1.6;color:var(--ink,#111)}',
    '.mat-ch{margin:34px 0 10px;padding-top:18px;border-top:1px solid var(--border,rgba(0,0,0,.1))}.mat-ch:first-child{margin-top:0;border-top:0;padding-top:0}',
    '.mat-ch h2{margin:0;font:600 21px/1.25 Newsreader,Georgia,serif;letter-spacing:-.01em}',
    '.mat-ch .mat-meta{margin:4px 0 0;font-size:12.5px;color:var(--muted,#888);font-variant-numeric:tabular-nums}',
    '.mat-ch .mat-t{display:inline-block;min-width:52px;font:600 13px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:#0f2c5c}',
    '.mat-p{margin:0 0 12px}',
    '.mat-cue{margin:10px 0;font-size:12.5px;line-height:1.45;color:var(--ink-2,#555);padding:6px 10px;border-left:2px solid var(--border,rgba(0,0,0,.15));background:var(--surface-2,#f5f5f7);border-radius:0 6px 6px 0}',
    '.mat-cue b{font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;margin-right:6px;color:var(--muted,#888)}',
    '.mat-cue.slide{border-left-color:#0f2c5c}.mat-cue.slide b{color:#0f2c5c}',
    '.mat-cue.host{border-left-color:#c8961e;background:rgba(253,208,80,.14)}.mat-cue.host b{color:#8a6510}',
    '.mat-cue.note{font-style:italic}',
    '.mat-cue .mat-at{float:right;font:600 11.5px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted,#888)}',

    // Run sheet
    '.mat-run{width:100%;border-collapse:collapse;font-size:13.5px}',
    '.mat-run td,.mat-run th{padding:7px 8px;border-bottom:1px solid var(--border,rgba(0,0,0,.08));text-align:left;vertical-align:top}',
    '.mat-run td.t{width:62px;font:600 13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;color:#0f2c5c;white-space:nowrap}',
    '.mat-run tr.ch td{font-weight:650;background:var(--surface-2,#f5f5f7)}',
    '.mat-run tr.host td.what{color:#8a6510;font-weight:650}',
    '.mat-run td.n{color:var(--muted,#888);white-space:nowrap;text-align:right}',

    // Funnel HQ tab
    '.mat-list tbody tr{cursor:pointer}.mat-list tbody tr[aria-selected="true"] td{background:var(--surface-2)}',
    '.mat-head{display:flex;flex-wrap:wrap;gap:10px 16px;align-items:flex-start;justify-content:space-between;margin-bottom:12px}',
    '.mat-head h2{margin:0;font-size:17px}.mat-actions{display:flex;flex-wrap:wrap;gap:6px}',
    '.mat-split{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:24px;align-items:start}',
    '.mat-side{position:sticky;top:12px;display:grid;gap:10px}.mat-side .ms-slide{border-radius:8px}',
    '.mat-side p{margin:0;font-size:12.5px;color:var(--muted)}',
    '@media (max-width:980px){.mat-split{grid-template-columns:1fr}.mat-side{position:static}}',

    // /admin/present
    'html.mp,html.mp body{margin:0;height:100%;background:#000}',
    '.mp-stage{position:fixed;inset:0;display:grid;place-items:center;background:#000;cursor:none}',
    '.mp-stage .ms-slide{width:min(100vw,177.78vh)}',
    '.mp-black{position:fixed;inset:0;background:#000;opacity:0;pointer-events:none;transition:opacity .2s}.mp-black.on{opacity:1}',
    '.mp-hint{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);font:500 13px/1.4 Inter,system-ui,sans-serif;color:#cdd8ec;background:rgba(0,0,0,.55);padding:8px 14px;border-radius:999px;transition:opacity .25s;pointer-events:none}',
    '.mp-hint.off{opacity:0}',
    // Presenter window
    'html.pw,html.pw body{margin:0;min-height:100%;background:#111214;color:#f2f2f2;font:14px/1.5 Inter,system-ui,-apple-system,sans-serif}',
    '.pw-bar{display:flex;flex-wrap:wrap;gap:8px 18px;align-items:center;padding:10px 16px;border-bottom:1px solid #2a2b2f;position:sticky;top:0;background:#111214;z-index:2}',
    '.pw-clock{font:600 30px/1 ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums}',
    '.pw-plan{font-size:13px;color:#a6a8ad}.pw-plan b{color:#f2f2f2;font-weight:600}.pw-plan .ahead{color:#5bd36b}.pw-plan .behind{color:#ff8a7a}',
    '.pw-bar button,.pw-bar a{font:600 12.5px/1 Inter,system-ui,sans-serif;color:#f2f2f2;background:#24262b;border:1px solid #34363c;border-radius:8px;padding:8px 11px;cursor:pointer;text-decoration:none}',
    '.pw-bar button:hover,.pw-bar a:hover{background:#2e3036}.pw-bar .grow{flex:1}',
    '.pw-cue{margin:12px 16px 0;padding:10px 14px;border-radius:10px;background:#1c1d21;border:1px solid #2a2b2f;font-size:15px}',
    '.pw-cue b{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.pw-cue.now{background:#3a2e0a;border-color:#c8961e;color:#ffe08a}',
    '.pw-grid{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(0,1fr);gap:16px;padding:16px}',
    '.pw-grid h3{margin:0 0 6px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#8b8d93;font-weight:650}',
    '.pw-grid .ms-slide{border-radius:6px}',
    '.pw-notes{grid-column:1/-1;font-size:21px;line-height:1.55;max-width:1100px}.pw-notes p{margin:0 0 14px}',
    '.pw-notes .pw-cueline{font-size:14px;color:#ffe08a;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
    '.pw-notes .pw-noteline{font-size:14px;color:#a6a8ad;font-style:italic}',
    '.pw-list{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:6px}.pw-list button{font:500 12px/1.3 Inter,sans-serif;color:#c9cbd0;background:#1c1d21;border:1px solid #2a2b2f;border-radius:7px;padding:6px 8px;cursor:pointer;max-width:240px;text-align:left}',
    '.pw-list button[aria-current="true"]{background:#0f2c5c;border-color:#3b5d99;color:#fff}',
    '@media (max-width:900px){.pw-grid{grid-template-columns:1fr}}',
    // Printable pages (script, run sheet) opened from the tab
    'html.pp body{margin:0;background:#fff;color:#111;font-family:Inter,system-ui,-apple-system,sans-serif}.pp-wrap{max-width:780px;margin:0 auto;padding:40px 24px}',
    '.pp-wrap h1{font:600 30px/1.2 Newsreader,Georgia,serif;margin:0 0 4px}.pp-wrap .pp-sub{color:#666;margin:0 0 28px;font-size:13px}',
    // Deck (print to PDF)
    'html.pd body{margin:0;background:#2b2b2b}.pd-deck{display:grid;gap:24px;padding:24px;justify-items:center}.pd-deck .ms-slide{width:min(1280px,100%)}',
    '@media print{',
    '  html.pd body{background:none}.pd-deck{display:block;padding:0}.pd-deck .ms-slide{width:16in;height:9in;break-after:page;page-break-after:always;-webkit-print-color-adjust:exact;print-color-adjust:exact}',
    '  .no-print{display:none!important}.mat-cue{break-inside:avoid;-webkit-print-color-adjust:exact;print-color-adjust:exact}.mat-ch h2{break-after:avoid}',
    '}',
  ].join('\n');

  function pageRule(rule) { var st = document.createElement('style'); st.textContent = rule; document.head.appendChild(st); }

  // ───────────── rendering ─────────────
  function slideHtml(m, s, o) {
    o = o || {};
    if (!s) return '<div class="ms-slide' + (o.light ? ' light' : '') + '"><div class="ms-in"><div class="ms-main"><p class="ms-sub">End of the deck</p></div></div></div>';
    var len = s.title.length, quote = /^["“]/.test(s.title);
    var cls = (len > 70 ? 'xlong' : len > 38 ? 'long' : '') + (quote ? ' quote' : '');
    return '<div class="ms-slide' + (o.light ? ' light' : '') + '" data-i="' + s.index + '"><div class="ms-in">' +
      '<div class="ms-eyebrow">' + esc(s.chapterTitle) + '</div>' +
      '<div class="ms-main"><h1 class="' + cls + '">' + esc(s.title) + '</h1>' +
      (s.sub ? '<p class="ms-sub' + (s.sub.length > 140 ? ' small' : '') + '">' + esc(s.sub) + '</p>' : '') +
      (s.onscreen.length ? '<div class="ms-on' + (s.onscreen.length > 2 ? ' many' : '') + '">' + s.onscreen.map(function (x) { return '<p>' + esc(x) + '</p>'; }).join('') + '</div>' : '') +
      '</div><div class="ms-foot"><b>' + esc(BRAND) + '</b><span>' + (o.number ? esc((s.index + 1) + ' / ' + m.slides.length) : '') + '</span></div></div></div>';
  }

  function scriptHtml(m) {
    return '<div class="mat-script">' + m.chapters.map(function (c) {
      return '<section class="mat-ch"><h2><span class="mat-t">' + esc(c.at) + '</span>' + esc(c.title) + '</h2>' +
        '<p class="mat-meta">' + num(c.words) + ' spoken words · about ' + esc(c.minutes) + ' min at 140 wpm</p>' +
        c.blocks.map(function (b) {
          switch (b.type) {
            case 'para': return '<p class="mat-p">' + esc(b.text) + '</p>';
            case 'slide': return '<div class="mat-cue slide"><span class="mat-at">' + esc(b.at) + '</span><b>Slide</b>' + esc(b.title) + (b.sub ? ' · ' + esc(b.sub) : '') + '</div>';
            case 'onscreen': return '<div class="mat-cue"><b>On screen</b>' + esc(b.text) + '</div>';
            case 'host': return '<div class="mat-cue host"><span class="mat-at">' + esc(b.at) + '</span><b>Host</b>' + esc(b.action) + '</div>';
            case 'note': return '<div class="mat-cue note"><b>Note</b>' + esc(b.text) + '</div>';
            case 'mark': return '<div class="mat-cue"><b>Mark</b>' + esc(b.at) + '</div>';
            case 'heading': return '<h3>' + esc(b.text) + '</h3>';
            default: return '<div class="mat-cue"><b>Cue</b>' + esc(b.text) + '</div>';
          }
        }).join('') + '</section>';
    }).join('') + '</div>';
  }

  function runSheetHtml(m) {
    var rows = '';
    m.chapters.forEach(function (c) {
      var slides = c.blocks.filter(function (b) { return b.type === 'slide'; }).length;
      rows += '<tr class="ch"><td class="t">' + esc(c.at) + '</td><td class="what">' + esc(c.title) + '</td><td class="n">' + num(c.words) + ' words · ' + esc(c.minutes) + ' min · ' + slides + ' slides</td></tr>';
      c.blocks.forEach(function (b) {
        if (b.type === 'host') rows += '<tr class="host"><td class="t">' + esc(b.at) + '</td><td class="what">' + esc(b.action) + '</td><td class="n">Host</td></tr>';
        else if (b.type === 'note' && /^(RE-ASK|Read)/i.test(b.text)) rows += '<tr><td class="t"></td><td>' + esc(b.text) + '</td><td class="n">Note</td></tr>';
      });
    });
    rows += '<tr class="ch"><td class="t">' + esc(m.end) + '</td><td class="what">End (estimated)</td><td class="n">' + num(m.words) + ' words in all</td></tr>';
    return '<table class="mat-run"><thead><tr><th>Time</th><th>Chapter or host action</th><th class="n">Detail</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function nextCue(m, i) {
    for (var k = 0; k < m.cues.length; k++) if (m.cues[k].slide >= i) return m.cues[k];
    return null;
  }

  // ───────────── Funnel HQ tab ─────────────
  var tabState = { id: storeGet('mat.id') || '', mode: storeGet('mat.mode') || 'script' };

  function render(ctx) {
    css(); fonts();
    var view = ctx.view;
    return getJSON('/admin/api/materials').then(function (d) {
      var list = d.materials || [];
      if (!list.length) { view.innerHTML = '<div class="card"><p class="muted">No materials yet. Add a script to public/materials/ (see docs/materials-format.md).</p></div>'; return; }
      if (!list.some(function (x) { return x.id === tabState.id; })) tabState.id = list[0].id;
      var funnelName = { live: 'Live webinar', challenge: 'Challenge', auto: 'Automated webinar' };
      var offerName = { deposit: 'Engagement deposit', soft: 'Soft offer', sprint: 'First Deal Sprint', none: 'None' };
      var rows = list.map(function (x) {
        return '<tr data-id="' + esc(x.id) + '" aria-selected="' + (x.id === tabState.id) + '" tabindex="0"><td><b>' + esc(x.title) + '</b></td><td>' + esc(funnelName[x.funnel] || x.funnel) + '</td><td class="num">' + esc(x.day || '–') + '</td>' +
          '<td class="num">' + (x.duration_min ? esc(x.duration_min) + ' min' : '–') + '</td><td class="num">' + num(x.words) + '</td><td class="num">' + esc(x.minutes) + ' min</td><td class="num">' + esc(x.slides) + '</td><td>' + esc(offerName[x.offer] || x.offer || '–') + '</td></tr>';
      }).join('');
      view.innerHTML = '<div class="card"><div class="table-wrap"><table class="mat-list"><thead><tr><th>Material</th><th>Funnel</th><th class="num">Day</th><th class="num">Planned</th><th class="num">Spoken words</th><th class="num">At 140 wpm</th><th class="num">Slides</th><th>Offer</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>' +
        '<div class="card" style="margin-top:14px" data-mat-detail><p class="muted">Loading…</p></div>';
      function pick(id) {
        tabState.id = id; storeSet('mat.id', id);
        view.querySelectorAll('.mat-list tbody tr').forEach(function (tr) { tr.setAttribute('aria-selected', String(tr.getAttribute('data-id') === id)); });
        detail(view.querySelector('[data-mat-detail]'), id);
      }
      view.querySelector('.mat-list tbody').addEventListener('click', function (e) { var tr = e.target.closest('tr[data-id]'); if (tr) pick(tr.getAttribute('data-id')); });
      view.querySelector('.mat-list tbody').addEventListener('keydown', function (e) { if (e.key === 'Enter') { var tr = e.target.closest('tr[data-id]'); if (tr) pick(tr.getAttribute('data-id')); } });
      pick(tabState.id);
    });
  }

  function detail(el, id) {
    el.innerHTML = '<p class="muted">Loading…</p>';
    getJSON('/admin/api/materials/' + encodeURIComponent(id)).then(function (m) {
      var p = '/admin/present?id=' + encodeURIComponent(id);
      var open = function (href, label, extra) { return '<a class="btn-sm' + (extra || ' ghost') + '" href="' + esc(href) + '" target="_blank" rel="noopener">' + label + '</a>'; };
      var hostCues = m.cues.length;
      el.innerHTML = '<div class="mat-head"><div><h2>' + esc(m.meta.title || id) + '</h2><p class="sub" style="margin:2px 0 0">' +
        num(m.words) + ' spoken words · about ' + esc(m.minutes) + ' min of speaking · runs to ' + esc(m.end) + (m.meta.duration_min ? ' (planned ' + esc(m.meta.duration_min) + ' min)' : '') + ' · ' + m.chapters.length + ' chapters · ' + m.slides.length + ' slides · ' + hostCues + ' host cues</p></div>' +
        '<div class="mat-actions">' + open(p + '&view=slides', 'Present slides', '') + open(p + '&view=presenter', 'Presenter window') +
        open('/materials/' + id + '.md?download=1', 'Download .md') + open(p + '&view=deck', 'Deck as PDF') + open(p + '&view=script', 'Print script') + open(p + '&view=runsheet', 'Print run sheet') + '</div></div>' +
        '<div class="seg" role="group" aria-label="View" style="margin-bottom:14px"><button type="button" data-mode="script">Script</button><button type="button" data-mode="runsheet">Run sheet</button><button type="button" data-mode="slides">Slides</button></div>' +
        '<div data-mat-body></div>';
      var body = el.querySelector('[data-mat-body]');
      function show(mode) {
        tabState.mode = mode; storeSet('mat.mode', mode);
        el.querySelectorAll('[data-mode]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-mode') === mode)); });
        if (mode === 'runsheet') body.innerHTML = runSheetHtml(m);
        else if (mode === 'slides') body.innerHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px">' + m.slides.map(function (s) { return '<div><div style="border-radius:8px;overflow:hidden">' + slideHtml(m, s) + '</div><p class="muted small" style="margin:4px 0 0">' + esc(s.at) + ' · slide ' + (s.index + 1) + '</p></div>'; }).join('') + '</div>';
        else body.innerHTML = '<div class="mat-split">' + scriptHtml(m) + '<aside class="mat-side"><div data-mat-preview>' + slideHtml(m, m.slides[0]) + '</div><p>The slide for the part you’re reading. Press <b>Present slides</b> to share it full screen, and <b>Presenter window</b> for your notes, the clock and the next host cue.</p></aside></div>';
        if (mode === 'script') wirePreview(body, m);
      }
      el.querySelectorAll('[data-mode]').forEach(function (b) { b.addEventListener('click', function () { show(b.getAttribute('data-mode')); }); });
      show(tabState.mode === 'runsheet' || tabState.mode === 'slides' ? tabState.mode : 'script');
    }).catch(function (e) { el.innerHTML = '<p class="muted">Couldn’t load this material: ' + esc(e.message) + '</p>'; });
  }

  // While reading the script, the side panel shows the slide that's up at that point.
  function wirePreview(body, m) {
    var prev = body.querySelector('[data-mat-preview]');
    var cues = Array.prototype.slice.call(body.querySelectorAll('.mat-cue.slide'));
    if (!prev || !cues.length || !('IntersectionObserver' in window)) return;
    var idx = 0;
    cues.forEach(function (c, i) { c.setAttribute('data-si', i); });
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { var i = +en.target.getAttribute('data-si'); if (i !== idx) { idx = i; prev.innerHTML = slideHtml(m, m.slides[i]); } }
      });
    }, { rootMargin: '0px 0px -70% 0px' });
    cues.forEach(function (c) { io.observe(c); });
  }

  // ───────────── /admin/present ─────────────
  function present() {
    css(); fonts();
    var q = new URLSearchParams(location.search);
    var id = q.get('id') || '', mode = q.get('view') || 'slides';
    var app = document.getElementById('app');
    getJSON('/admin/api/materials/' + encodeURIComponent(id)).then(function (m) {
      document.title = (m.meta.title || id) + ' · ' + ({ slides: 'Slides', presenter: 'Presenter', deck: 'Deck', script: 'Script', runsheet: 'Run sheet' }[mode] || '');
      if (mode === 'presenter') return presenterWindow(app, m, id);
      if (mode === 'deck') return deck(app, m, q.get('theme') === 'light');
      if (mode === 'script' || mode === 'runsheet') return printable(app, m, mode);
      return slidesWindow(app, m, id, q.get('theme') === 'light');
    }).catch(function (e) { app.innerHTML = '<p style="color:#fff;font:16px system-ui;padding:24px">Couldn’t load this material: ' + esc(e.message) + '</p>'; });
  }

  function channel(id) {
    try { return new BroadcastChannel('gl-present-' + id); } catch (e) { return { postMessage: function () {}, addEventListener: function () {} }; }
  }

  function navKeys(e, go, i, n) {
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    var k = e.key;
    if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'PageDown' || k === ' ' || k === 'Enter' || k === 'n') { go(Math.min(n - 1, i + 1)); return true; }
    if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp' || k === 'Backspace' || k === 'p') { go(Math.max(0, i - 1)); return true; }
    if (k === 'Home') { go(0); return true; }
    if (k === 'End') { go(n - 1); return true; }
    return false;
  }

  // The window Josh shares in Zoom: slides only, nothing else on screen.
  function slidesWindow(app, m, id, light) {
    document.documentElement.className = 'mp';
    var i = Math.min(Math.max(0, Number(storeGet('mat.slide.' + id)) || 0), m.slides.length - 1), black = false;
    app.innerHTML = '<div class="mp-stage" data-stage></div><div class="mp-black" data-black></div><div class="mp-hint" data-hint>→ / space next · ← back · B black · F full screen · T light or dark</div>';
    var stage = app.querySelector('[data-stage]'), bl = app.querySelector('[data-black]'), hint = app.querySelector('[data-hint]');
    var bc = channel(id);
    function draw() { stage.innerHTML = slideHtml(m, m.slides[i], { light: light }); bl.classList.toggle('on', black); }
    function go(n, quiet) { i = n; storeSet('mat.slide.' + id, String(i)); draw(); if (!quiet) bc.postMessage({ type: 'go', i: i }); }
    function setBlack(v, quiet) { black = v; draw(); if (!quiet) bc.postMessage({ type: 'black', on: black }); }
    bc.addEventListener('message', function (e) {
      var d = e.data || {};
      if (d.type === 'go' && typeof d.i === 'number') go(d.i, true);
      else if (d.type === 'black') setBlack(!!d.on, true);
      else if (d.type === 'theme') { light = !!d.light; draw(); }
      else if (d.type === 'hello') bc.postMessage({ type: 'state', i: i, black: black, light: light });
    });
    document.addEventListener('keydown', function (e) {
      if (navKeys(e, function (n) { go(n); }, i, m.slides.length)) { e.preventDefault(); return; }
      if (e.key === 'b' || e.key === 'B' || e.key === '.') { setBlack(!black); e.preventDefault(); }
      else if (e.key === 'f' || e.key === 'F') { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(function () {}); }
      else if (e.key === 't' || e.key === 'T') { light = !light; draw(); bc.postMessage({ type: 'theme', light: light }); }
    });
    stage.addEventListener('click', function () { go(Math.min(m.slides.length - 1, i + 1)); });
    setTimeout(function () { hint.classList.add('off'); }, 3500);
    draw();
    bc.postMessage({ type: 'state', i: i, black: black, light: light });
  }

  // Josh's own window: current and next slide, the spoken words, the clock and the next host cue.
  function presenterWindow(app, m, id) {
    document.documentElement.className = 'pw';
    var i = Math.min(Math.max(0, Number(storeGet('mat.slide.' + id)) || 0), m.slides.length - 1), black = false, light = false;
    var startKey = 'mat.start.' + id, pausedKey = 'mat.paused.' + id;
    var start = Number(storeGet(startKey)) || 0, paused = Number(storeGet(pausedKey)) || 0; // paused = elapsed ms frozen while paused
    var bc = channel(id);
    app.innerHTML = '<div class="pw-bar"><span class="pw-clock" data-clock>00:00</span><span class="pw-plan" data-plan></span><span class="grow"></span>' +
      '<button type="button" data-act="start">Start clock</button><button type="button" data-act="reset">Reset</button>' +
      '<button type="button" data-act="black">Black (B)</button><button type="button" data-act="theme">Light/dark (T)</button>' +
      '<button type="button" data-act="slides">Open slides window</button><span class="pw-plan" data-wall></span></div>' +
      '<div class="pw-cue" data-cue></div>' +
      '<div class="pw-grid"><div><h3 data-cur-h>Now</h3><div data-cur></div></div><div><h3>Next</h3><div data-next></div></div>' +
      '<div class="pw-notes" data-notes></div><div class="pw-list" data-list></div></div>';
    var $ = function (s) { return app.querySelector(s); };
    $('[data-list]').innerHTML = m.slides.map(function (s) { return '<button type="button" data-go="' + s.index + '" title="' + esc(s.title) + '">' + esc(s.at) + ' · ' + esc(s.title.length > 34 ? s.title.slice(0, 33) + '…' : s.title) + '</button>'; }).join('');
    function elapsed() { return start ? Date.now() - start : paused; }
    function tick() {
      var el = elapsed() / 1000, s = m.slides[i];
      $('[data-clock]').textContent = mmss(el);
      var plan = sec(s.at), diff = el - plan;
      $('[data-plan]').innerHTML = 'Slide ' + (i + 1) + ' of ' + m.slides.length + ' · planned at <b>' + esc(s.at) + '</b>' +
        (start || paused ? ' · <span class="' + (diff > 30 ? 'behind' : diff < -30 ? 'ahead' : '') + '">' + (Math.abs(diff) <= 30 ? 'on time' : mmss(Math.abs(diff)) + (diff > 0 ? ' behind' : ' ahead')) + '</span>' : '');
      $('[data-wall]').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      $('[data-act="start"]').textContent = start ? 'Pause clock' : (paused ? 'Resume clock' : 'Start clock');
    }
    function draw() {
      var s = m.slides[i];
      $('[data-cur]').innerHTML = slideHtml(m, s, { light: light, number: true });
      $('[data-next]').innerHTML = slideHtml(m, m.slides[i + 1], { light: light, number: true });
      $('[data-cur-h]').textContent = black ? 'Now (screen is black)' : 'Now';
      var c = nextCue(m, i), cue = $('[data-cue]');
      if (c) {
        var now = c.slide === i;
        cue.className = 'pw-cue' + (now ? ' now' : '');
        cue.innerHTML = (now ? 'On this slide, at <b>' + esc(c.at) + '</b>: ' : 'Next host cue, at <b>' + esc(c.at) + '</b>: ') + '<b>' + esc(c.action) + '</b>' + (now ? '' : ' (slide ' + (c.slide + 1) + ')');
      } else { cue.className = 'pw-cue'; cue.textContent = 'No more host cues.'; }
      // Speaker notes: the words to say on this slide, with the cues in between, read from the chapter blocks.
      var notes = [], on = false;
      m.chapters.forEach(function (ch) {
        ch.blocks.forEach(function (b) {
          if (b.type === 'slide') on = b.slide === i;
          else if (on || (i === 0 && !notes.length && s.implicit)) {
            if (b.type === 'para') notes.push('<p>' + esc(b.text) + '</p>');
            else if (b.type === 'host') notes.push('<p class="pw-cueline">[' + esc(b.at) + '] HOST: ' + esc(b.action) + '</p>');
            else if (b.type === 'note') notes.push('<p class="pw-noteline">' + esc(b.text) + '</p>');
            else if (b.type === 'onscreen') notes.push('<p class="pw-noteline">On screen: ' + esc(b.text) + '</p>');
          }
        });
      });
      $('[data-notes]').innerHTML = notes.join('') || '<p class="pw-noteline">No spoken words on this slide.</p>';
      app.querySelectorAll('[data-go]').forEach(function (b) { b.setAttribute('aria-current', String(+b.getAttribute('data-go') === i)); });
      var curBtn = app.querySelector('[data-go="' + i + '"]'); if (curBtn && curBtn.scrollIntoView) curBtn.scrollIntoView({ block: 'nearest' });
      tick();
    }
    function go(n, quiet) { i = Math.min(Math.max(0, n), m.slides.length - 1); storeSet('mat.slide.' + id, String(i)); draw(); window.scrollTo(0, 0); if (!quiet) bc.postMessage({ type: 'go', i: i }); }
    bc.addEventListener('message', function (e) {
      var d = e.data || {};
      if ((d.type === 'go' || d.type === 'state') && typeof d.i === 'number') { if (d.type === 'state') { black = !!d.black; light = !!d.light; } go(d.i, true); }
      else if (d.type === 'black') { black = !!d.on; draw(); }
      else if (d.type === 'theme') { light = !!d.light; draw(); }
    });
    app.addEventListener('click', function (e) {
      var g = e.target.closest('[data-go]'); if (g) { go(+g.getAttribute('data-go')); return; }
      var a = e.target.closest('[data-act]'); if (!a) return;
      var act = a.getAttribute('data-act');
      if (act === 'start') {
        if (start) { paused = Date.now() - start; start = 0; } else { start = Date.now() - paused; paused = 0; }
        storeSet(startKey, String(start)); storeSet(pausedKey, String(paused)); tick();
      } else if (act === 'reset') { start = 0; paused = 0; storeSet(startKey, '0'); storeSet(pausedKey, '0'); tick(); }
      else if (act === 'black') { black = !black; bc.postMessage({ type: 'black', on: black }); draw(); }
      else if (act === 'theme') { light = !light; bc.postMessage({ type: 'theme', light: light }); draw(); }
      else if (act === 'slides') window.open('/admin/present?id=' + encodeURIComponent(id) + '&view=slides' + (light ? '&theme=light' : ''), 'gl-slides-' + id, 'popup,width=1280,height=760');
    });
    document.addEventListener('keydown', function (e) {
      if (navKeys(e, function (n) { go(n); }, i, m.slides.length)) { e.preventDefault(); return; }
      if (e.key === 'b' || e.key === 'B' || e.key === '.') { black = !black; bc.postMessage({ type: 'black', on: black }); draw(); e.preventDefault(); }
      else if (e.key === 't' || e.key === 'T') { light = !light; bc.postMessage({ type: 'theme', light: light }); draw(); }
      else if (e.key === 's' || e.key === 'S') { if (start) { paused = Date.now() - start; start = 0; } else { start = Date.now() - paused; paused = 0; } storeSet(startKey, String(start)); storeSet(pausedKey, String(paused)); tick(); }
    });
    setInterval(tick, 1000);
    draw();
    bc.postMessage({ type: 'hello' });
  }

  function deck(app, m, light) {
    document.documentElement.className = 'pd';
    pageRule('@page{size:16in 9in;margin:0}');
    app.innerHTML = '<p class="no-print" style="color:#ddd;font:14px system-ui;text-align:center;margin:16px">Choose “Save as PDF” in the print dialog. One slide per page, 16:9. <button type="button" data-print>Print</button></p>' +
      '<div class="pd-deck">' + m.slides.map(function (s) { return slideHtml(m, s, { light: light }); }).join('') + '</div>';
    app.querySelector('[data-print]').addEventListener('click', function () { window.print(); });
    (document.fonts ? document.fonts.ready : Promise.resolve()).then(function () { setTimeout(function () { window.print(); }, 300); });
  }

  function printable(app, m, mode) {
    document.documentElement.className = 'pp';
    pageRule('@page{margin:14mm}');
    app.innerHTML = '<div class="pp-wrap"><p class="no-print" style="text-align:right"><button type="button" data-print>Print</button></p><h1>' + esc(m.meta.title) + (mode === 'runsheet' ? ': run sheet' : '') + '</h1>' +
      '<p class="pp-sub">' + num(m.words) + ' spoken words · about ' + esc(m.minutes) + ' min of speaking at 140 wpm · runs to ' + esc(m.end) + ' · ' + BRAND + '</p>' +
      (mode === 'runsheet' ? runSheetHtml(m) : scriptHtml(m)) + '</div>';
    app.querySelector('[data-print]').addEventListener('click', function () { window.print(); });
  }

  root.Materials = { render: render, present: present, slideHtml: slideHtml, scriptHtml: scriptHtml, runSheetHtml: runSheetHtml };
  if (document.documentElement.hasAttribute('data-present')) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', present); else present();
  }
})(window);
