/* Funnel maps: one map per funnel, every stage as a draggable box wired with arrows, with live numbers.
 * Click a stage for a plain explanation: what the person sees, what runs behind it, the settings that
 * control it, the numbers for the selected range and links to its tab and page. "All funnels" lists every
 * funnel as a strip of its stages. On a phone the canvas becomes a vertical stage list.
 * Positions and your own boxes are saved per map, for everyone (the VSL map keeps the original keys). */
(function () {
  'use strict';

  var W = 220, H = 92;
  var KIND = { traffic: 'Traffic', page: 'Page / step', decision: 'Decision', auto: 'Runs automatically', people: 'People / outcome', data: 'Data & AI' };
  var AUTO = { email: 'Email', sms: 'Text', ai_call: 'AI call', ping: 'Team ping', charge: 'One-click charge', approval: 'Needs approval', ai: 'AI', webhook: 'Webhook' };
  var PREF = 'hq_map';

  // ───────────── styles (Apple-calm: white and #f5f5f7 surfaces, hairlines, navy labels) ─────────────
  function injectStyles() {
    if (document.getElementById('fmx-css')) return;
    var css = [
      ':root{--fmx-navy:#0f2c5c;--fmx-wash:#f5f5f7;--fmx-line:rgba(0,0,0,.08)}',
      '@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--fmx-navy:#9ec5f4;--fmx-wash:#232321;--fmx-line:rgba(255,255,255,.10)}}',
      ':root[data-theme="dark"]{--fmx-navy:#9ec5f4;--fmx-wash:#232321;--fmx-line:rgba(255,255,255,.10)}',
      '.fmx-switch{display:flex;gap:4px;overflow-x:auto;padding:4px;background:var(--fmx-wash);border-radius:12px;margin:0 0 16px;scrollbar-width:none}',
      '.fmx-switch::-webkit-scrollbar{display:none}',
      '.fmx-switch button{flex:0 0 auto;border:0;background:none;padding:8px 14px;border-radius:9px;font:500 13px var(--font);color:var(--ink-2);cursor:pointer;transition:background .2s,color .2s}',
      '.fmx-switch button[aria-selected="true"]{background:var(--surface);color:var(--ink);box-shadow:0 1px 3px rgba(0,0,0,.08)}',
      '.fmx-switch button:focus-visible{outline:2px solid var(--focus);outline-offset:1px}',
      '.fmx-head{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px 24px;align-items:flex-end;margin:0 0 12px}',
      '.fmx-head h2{font:600 22px/1.2 "Newsreader",Georgia,serif;margin:0 0 4px;color:var(--ink)}',
      '.fmx-head p{margin:0;color:var(--ink-2);max-width:760px;line-height:1.5;font-size:14px}',
      '.fmx-eyebrow{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--fmx-navy);font-weight:600;margin:0 0 4px}',
      '.fmx-strip{display:flex;align-items:stretch;gap:0;overflow-x:auto;margin:0 0 14px;padding-bottom:2px}',
      '.fmx-step{flex:1 0 118px;min-width:118px;border:0;background:var(--fmx-wash);padding:10px 12px;text-align:left;cursor:pointer;font:inherit;color:var(--ink);transition:background .2s}',
      '.fmx-step:first-child{border-radius:10px 0 0 10px}.fmx-step:last-child{border-radius:0 10px 10px 0}',
      '.fmx-step+.fmx-step{border-left:1px solid var(--fmx-line)}',
      '.fmx-step:hover{background:var(--surface-2)}',
      '.fmx-step b{display:block;font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.fmx-step .v{display:block;font-size:18px;font-weight:600;margin-top:2px;font-variant-numeric:tabular-nums}',
      '.fmx-step .c{display:block;font-size:11px;color:var(--ink-2);margin-top:1px}',
      '.fmx-step .none{font-size:13px;font-weight:500;color:var(--muted)}',
      '.fmx-rows{display:grid;gap:0}',
      '.fmx-row{display:grid;grid-template-columns:minmax(180px,240px) 1fr;gap:16px;align-items:center;padding:16px 0;border-top:1px solid var(--fmx-line)}',
      '.fmx-row:first-child{border-top:0}',
      '.fmx-row h3{margin:0 0 4px;font-size:15px}',
      '.fmx-row h3 button{border:0;background:none;padding:0;font:inherit;color:var(--fmx-navy);cursor:pointer;text-align:left}',
      '.fmx-row p{margin:0;font-size:12px;color:var(--ink-2);line-height:1.45}',
      '.fmx-row .fmx-strip{margin:0}',
      '@media (max-width:720px){.fmx-row{grid-template-columns:1fr;gap:8px}.fmx-head h2{font-size:20px}}',
      '.fmx-node .fmx-n{font-size:12px;font-weight:600;color:var(--ink);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}',
      '.fmx-node .fmx-n.none{color:var(--muted);font-weight:500}',
      '.fmx-node .fmx-n i{font-style:normal;color:var(--ink-2);font-weight:500}',
      '.fmx-autos{display:flex;gap:4px;margin-top:3px;flex-wrap:nowrap;overflow:hidden}',
      '.fmx-autos span{font-size:10px;padding:1px 6px;border-radius:999px;background:var(--fmx-wash);color:var(--ink-2);white-space:nowrap}',
      '.fm-panel.fmx-panel{width:min(420px,94%);padding:20px 22px 28px}',
      '.fmx-panel h2{font:600 20px/1.25 "Newsreader",Georgia,serif;margin:4px 0 2px}',
      '.fmx-panel h4{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--fmx-navy);margin:18px 0 6px;font-weight:600}',
      '.fmx-panel p{margin:0 0 6px;line-height:1.55;font-size:14px}',
      '.fmx-big{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin:10px 0 2px}',
      '.fmx-big b{font-size:28px;font-weight:600;font-variant-numeric:tabular-nums}',
      '.fmx-big span{color:var(--ink-2);font-size:13px}',
      '.fmx-conv{font-size:13px;color:var(--ink-2)}',
      '.fmx-conv b{color:var(--ink)}',
      '.fmx-list{list-style:none;margin:0;padding:0}',
      '.fmx-list li{padding:8px 0;border-top:1px solid var(--fmx-line);font-size:13px;line-height:1.45}',
      '.fmx-list li:first-child{border-top:0}',
      '.fmx-tag{display:inline-block;font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--fmx-navy);margin-right:6px}',
      '.fmx-meta{display:block;color:var(--ink-2);font-size:12px;margin-top:2px}',
      '.fmx-set{display:grid;grid-template-columns:1fr auto;gap:2px 10px;align-items:baseline}',
      '.fmx-set code{font-size:11px;color:var(--ink-2);word-break:break-all}',
      '.fmx-set .val{font-size:12px;text-align:right;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.fmx-set .val.off{color:var(--muted)}',
      '.fmx-links{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}',
      '.fmx-links a{font-size:13px;color:var(--fmx-navy);text-decoration:none;padding:6px 0}',
      '.fmx-links a:hover{text-decoration:underline}',
      '.fmx-mlist{list-style:none;margin:0;padding:0}',
      '.fmx-mlist li{position:relative}',
      '.fmx-mlist button.item{display:grid;grid-template-columns:6px 1fr auto;gap:12px;align-items:center;width:100%;border:0;background:none;padding:12px 0;text-align:left;font:inherit;color:var(--ink);cursor:pointer;border-top:1px solid var(--fmx-line)}',
      '.fmx-mlist li:first-child button.item{border-top:0}',
      '.fmx-mlist .bar{align-self:stretch;border-radius:3px;background:var(--fm-c)}',
      '.fmx-mlist .t{font-weight:600;font-size:15px}.fmx-mlist .s{display:block;font-size:12px;color:var(--ink-2);margin-top:2px}',
      '.fmx-mlist .v{font-size:14px;font-weight:600;text-align:right;font-variant-numeric:tabular-nums}.fmx-mlist .v small{display:block;font-size:11px;font-weight:500;color:var(--ink-2)}',
      '.fmx-mlist .v.none{color:var(--muted);font-weight:500;font-size:12px}',
      '.fmx-mh{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--fmx-navy);font-weight:600;margin:22px 0 4px}',
      '@media (max-width:720px){.fm-panel.fmx-panel.fmx-sheet{position:fixed;inset:0;width:auto;z-index:60;border-left:0;padding-top:52px;animation:fmxUp .22s ease-out}',
      '.fmx-panel .close{top:14px;right:14px;font-size:18px}}',
      '@keyframes fmxUp{from{transform:translateY(16px);opacity:0}to{transform:none;opacity:1}}',
      '@media (prefers-reduced-motion:reduce){.fm-panel.fmx-panel.fmx-sheet{animation:none}}',
      '.fmx-attr{font-size:12px;color:var(--ink-2);margin:-6px 0 12px}',
      '.fmx-attr b{color:var(--ink);font-weight:600}',
    ].join('\n');
    var st = document.createElement('style');
    st.id = 'fmx-css';
    st.textContent = css;
    document.head.appendChild(st);
  }

  /**
   * ctx: { esc, n, pct, money, go, api(path, params) → Promise, send(method, path, body) → Promise,
   *        tabs: [{id, title}], isTab(id) }
   */
  function render(root, ctx) {
    injectStyles();
    var esc = ctx.esc;
    var cur = 'all';
    try { cur = localStorage.getItem(PREF) || 'all'; } catch (e) { /* private window */ }

    root.innerHTML = '<div class="fmx"><div class="fmx-switch" role="tablist" aria-label="Funnel maps"></div><div class="fmx-body"></div></div>';
    var sw = root.querySelector('.fmx-switch'), body = root.querySelector('.fmx-body');

    return ctx.api('maps').then(function (d) {
      var maps = d.maps || [];
      if (cur !== 'all' && !maps.some(function (m) { return m.id === cur; })) cur = 'all';
      sw.innerHTML = '<button role="tab" data-m="all">All funnels</button>' + maps.map(function (m) { return '<button role="tab" data-m="' + esc(m.id) + '">' + esc(m.short) + '</button>'; }).join('');
      function select(id) {
        cur = id;
        try { localStorage.setItem(PREF, id); } catch (e) { /* ignore */ }
        sw.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-selected', String(b.getAttribute('data-m') === id)); });
        var on = sw.querySelector('[aria-selected="true"]'); if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        if (id === 'all') { renderAll(body, ctx, maps, select); return Promise.resolve(); }
        body.innerHTML = '<div class="empty">Loading the map…</div>';
        return loadMap(body, ctx, id).catch(function (e) { body.innerHTML = '<div class="empty">Couldn’t load this map. ' + esc(e.message) + '</div>'; });
      }
      sw.querySelectorAll('button').forEach(function (b) { b.onclick = function () { select(b.getAttribute('data-m')); }; });
      return select(cur);
    });
  }

  // ───────────── shared formatting ─────────────
  function countText(ctx, c, short) {
    if (!c) return '';
    if (c.n == null) return 'not counted';
    if (!c.n) return 'no data yet';
    return ctx.n(c.n) + (short ? '' : ' ' + c.unit);
  }
  function revText(ctx, c) {
    if (!c || !c.revenue) return '';
    if (c.currency) { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: c.currency, maximumFractionDigits: 0 }).format(c.revenue); } catch (e) { /* fall through */ } }
    return ctx.money(c.revenue);
  }
  function convText(ctx, conv) { return conv && conv.rate != null ? ctx.pct(conv.rate) : ''; }
  function strip(ctx, steps, onStep) {
    var esc = ctx.esc;
    var el = document.createElement('div');
    el.className = 'fmx-strip';
    el.innerHTML = steps.map(function (s) {
      var c = s.n, has = c && c.n;
      var conv = convText(ctx, s.conv);
      return '<button class="fmx-step" type="button" data-step="' + esc(s.id) + '" title="' + esc(s.title) + '"><b>' + esc(s.title) + '</b>' +
        (has ? '<span class="v">' + esc(ctx.n(c.n)) + '</span>' : '<span class="v none">' + esc(c ? countText(ctx, c) : 'not counted') + '</span>') +
        '<span class="c">' + esc(conv ? conv + ' of previous' : (revText(ctx, c) || ' ')) + '</span></button>';
    }).join('');
    el.querySelectorAll('[data-step]').forEach(function (b) { b.onclick = function () { onStep(b.getAttribute('data-step')); }; });
    return el;
  }

  // ───────────── All funnels ─────────────
  function renderAll(body, ctx, maps, select) {
    var esc = ctx.esc;
    body.innerHTML = '<div class="fmx-head"><div><p class="fmx-eyebrow">Every funnel</p><h2>All funnels at a glance</h2>' +
      '<p>Each row is one funnel with its main stages in order. Numbers are for the selected date range; the percentage is the share of the stage before. Open a funnel to see every branch, automation and setting.</p></div></div><div class="fmx-rows"></div>';
    var rows = body.querySelector('.fmx-rows');
    maps.forEach(function (m) {
      var row = document.createElement('div');
      row.className = 'fmx-row';
      row.innerHTML = '<div><h3><button type="button" data-open>' + esc(m.title) + ' →</button></h3><p>' + esc(m.summary) + '</p><p style="margin-top:4px">' + m.stages + ' stages</p></div>';
      row.appendChild(strip(ctx, m.strip, function (sid) { select(m.id).then(function () { if (body.__open) body.__open(sid); }); }));
      row.querySelector('[data-open]').onclick = function () { select(m.id); };
      rows.appendChild(row);
    });
  }

  // ───────────── one map ─────────────
  function loadMap(body, ctx, id) {
    var soft = function (p) { return p.catch(function () { return {}; }); };
    return Promise.all([
      ctx.api('maps/' + id),
      soft(ctx.api('maps/' + id + '/layout', {}, { noRange: true })),
      soft(ctx.api('maps/' + id + '/custom', {}, { noRange: true })),
    ]).then(function (r) {
      var map = r[0];
      drawMap(body, ctx, map, r[1].layout || null, r[2].custom || null);
      // Webinar attribution (another tab) when it is there; nothing depends on it.
      if (map.attribution) soft(ctx.api('attribution/stages', { funnel: map.attribution })).then(function (a) {
        var list = a && Array.isArray(a.stages) ? a.stages.filter(function (s) { return s && s.label != null; }) : [];
        var host = body.querySelector('[data-attr]');
        if (!list.length || !host) return;
        host.hidden = false;
        host.innerHTML = 'From Webinar attribution: ' + list.slice(0, 10).map(function (s) { return ctx.esc(String(s.label)) + ' <b>' + (s.count ? ctx.esc(ctx.n(s.count)) : 'no data yet') + '</b>'; }).join(' · ');
      });
    });
  }

  function drawMap(body, ctx, map, layout, customIn) {
    var esc = ctx.esc;
    var saved = layout || {};
    var custom = customIn && typeof customIn === 'object' ? customIn : {};
    custom.nodes = Array.isArray(custom.nodes) ? custom.nodes : [];
    custom.edges = Array.isArray(custom.edges) ? custom.edges : [];
    custom.edits = custom.edits && typeof custom.edits === 'object' ? custom.edits : {};
    var STAGES = map.stages, EDGES = map.edges;
    var byDef = {}; STAGES.forEach(function (s) { byDef[s.id] = s; });
    var tabs = ctx.tabs || [];
    var tabTitle = {}; tabs.forEach(function (t) { tabTitle[t.id] = t.title; });
    var pos = {}, zoom = 0.85, selected = null;
    var mobile = window.matchMedia('(max-width: 720px)').matches;

    function nodes() {
      return STAGES.map(function (d) {
        var e = custom.edits[d.id] || {};
        return Object.assign({}, d, { title: e.title || d.title, sub: e.sub != null ? e.sub : d.sub, note: e.note || '', builtin: true, edited: Boolean(e.title || e.sub != null || e.note) });
      }).concat(custom.nodes.map(function (d) { return { id: d.id, kind: KIND[d.kind] ? d.kind : 'page', x: 0, y: 0, title: d.title || 'New step', sub: d.sub || '', tab: d.tab || null, note: d.note || '', builtin: false }; }));
    }
    function edges() {
      return EDGES.map(function (e) { return { from: e[0], to: e[1], label: e[2] || '', style: e[3] || '', custom: false }; })
        .concat(custom.edges.map(function (e, i) { return { from: e[0], to: e[1], label: e[2] || '', style: 'custom', custom: true, idx: i }; }));
    }
    function byId(id) { return nodes().filter(function (x) { return x.id === id; })[0]; }
    function ensurePos() { nodes().forEach(function (d) { if (pos[d.id]) return; var s = saved[d.id]; pos[d.id] = s ? { x: s.x, y: s.y } : { x: d.x, y: d.y }; }); }

    var saveT, customT;
    function saveLayout() { clearTimeout(saveT); saveT = setTimeout(function () { ctx.send('PUT', 'maps/' + map.id + '/layout', { layout: pos }); }, 400); }
    function saveCustom() { clearTimeout(customT); customT = setTimeout(function () { ctx.send('PUT', 'maps/' + map.id + '/custom', { custom: custom }); }, 300); }

    var ladder = map.ladder.map(function (id) { var s = byDef[id]; return { id: id, title: s.title, n: s.n, conv: s.conv }; });
    body.innerHTML = '<div class="fmx-head"><div><p class="fmx-eyebrow">Funnel map</p><h2>' + esc(map.title) + '</h2><p>' + esc(map.summary) + '</p></div></div>';
    body.appendChild(strip(ctx, ladder, function (sid) { open(sid); }));
    var attr = document.createElement('p'); attr.className = 'fmx-attr'; attr.setAttribute('data-attr', ''); attr.hidden = true; body.appendChild(attr);

    var wrapHtml = mobile
      ? '<div class="fmx-mobile"></div><aside class="fm-panel fmx-panel fmx-sheet" hidden></aside>'
      : '<div class="fm-bar"><div class="fm-legend">' + Object.keys(KIND).map(function (k) { return '<span class="fm-key fm-' + k + '"><i></i>' + esc(KIND[k]) + '</span>'; }).join('') +
        '<span class="fm-key"><svg width="28" height="8"><line x1="0" y1="4" x2="28" y2="4" class="fm-e-auto"/></svg>automation</span>' +
        '<span class="fm-key"><svg width="28" height="8"><line x1="0" y1="4" x2="28" y2="4" class="fm-e-custom"/></svg>your arrows</span></div>' +
        '<div class="row"><button class="btn-sm" data-add>+ Add step</button><button class="btn-sm ghost" data-z="-" aria-label="Zoom out">−</button><button class="btn-sm ghost" data-z="+" aria-label="Zoom in">+</button><button class="btn-sm ghost" data-fit>Fit</button><button class="btn-sm ghost" data-reset>Reset layout</button></div></div>' +
        '<div class="fm-wrap"><div class="fm-scroll"><div class="fm-canvas"><svg class="fm-edges"></svg></div></div><aside class="fm-panel fmx-panel" hidden></aside></div>' +
        '<p class="muted" style="margin-top:8px">Click any stage for what the person sees, what runs behind it, its settings and its numbers. Drag boxes to rearrange, drag the dot on a box’s edge onto another box to connect them, and add your own steps. Layouts are saved per map for everyone. Numbers are for the selected date range.</p>';
    var holder = document.createElement('div'); holder.innerHTML = wrapHtml;
    while (holder.firstChild) body.appendChild(holder.firstChild);
    var panel = body.querySelector('.fm-panel');
    var scroll = body.querySelector('.fm-scroll'), canvas = body.querySelector('.fm-canvas'), svg = body.querySelector('.fm-edges');

    function nodeStat(d) {
      if (!d.n) return '';
      var t = countText(ctx, d.n), conv = convText(ctx, d.conv);
      var none = !d.n.n;
      return '<div class="fmx-n' + (none ? ' none' : '') + '">' + esc(t) + (conv && !none ? ' <i>· ' + esc(conv) + '</i>' : '') + '</div>';
    }
    function autoChips(d) {
      if (!d.autosView || !d.autosView.length) return '';
      var seen = {};
      return '<div class="fmx-autos">' + d.autosView.filter(function (a) { if (seen[a.type]) return false; seen[a.type] = 1; return true; }).map(function (a) { return '<span>' + esc(AUTO[a.type] || a.type) + '</span>'; }).join('') + '</div>';
    }

    // ── canvas (desktop) ──
    function build() {
      if (mobile) { buildList(); return; }
      ensurePos();
      canvas.querySelectorAll('.fm-node').forEach(function (el) { el.remove(); });
      nodes().forEach(function (d) {
        var el = document.createElement('div');
        el.className = 'fm-node fmx-node fm-' + d.kind + (d.builtin ? '' : ' fm-custom') + (d.id === selected ? ' fm-sel' : '');
        el.setAttribute('data-id', d.id);
        el.tabIndex = 0;
        el.setAttribute('role', 'button');
        el.innerHTML = '<div class="fm-kind">' + esc(KIND[d.kind]) + (d.builtin ? '' : ' · yours') + (d.note ? ' <span class="fm-noted" title="Has notes">✎</span>' : '') + '</div><div class="fm-title">' + esc(d.title) + '</div>' +
          (d.n ? nodeStat(d) : '<div class="fm-sub">' + esc(d.sub) + '</div>') + autoChips(d) + '<span class="fm-port" title="Drag onto another box to connect"></span>';
        canvas.appendChild(el);
      });
      place();
    }
    function place() {
      var maxX = 0, maxY = 0;
      nodes().forEach(function (d) {
        var el = canvas.querySelector('[data-id="' + d.id + '"]'), p = pos[d.id];
        if (!el || !p) return;
        el.style.transform = 'translate(' + p.x + 'px,' + p.y + 'px)';
        maxX = Math.max(maxX, p.x + W); maxY = Math.max(maxY, p.y + H);
      });
      var cw = maxX + 200, ch = maxY + 160;
      canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
      canvas.style.zoom = zoom;
      svg.setAttribute('width', cw); svg.setAttribute('height', ch);
      drawEdges();
    }
    function anchor(id, toward) {
      var p = pos[id], c = { x: p.x + W / 2, y: p.y + H / 2 };
      var tc = typeof toward === 'string' ? { x: pos[toward].x + W / 2, y: pos[toward].y + H / 2 } : toward;
      var dx = tc.x - c.x, dy = tc.y - c.y;
      if (Math.abs(dx) * H > Math.abs(dy) * W) return { x: dx > 0 ? p.x + W : p.x, y: c.y, side: dx > 0 ? 'r' : 'l' };
      return { x: c.x, y: dy > 0 ? p.y + H : p.y, side: dy > 0 ? 'b' : 't' };
    }
    function curve(a, b, bSide) {
      var k = 60, c1 = { x: a.x, y: a.y }, c2 = { x: b.x, y: b.y };
      if (a.side === 'r') c1.x += k; else if (a.side === 'l') c1.x -= k; else if (a.side === 'b') c1.y += k; else c1.y -= k;
      if (bSide === 'r') c2.x += k; else if (bSide === 'l') c2.x -= k; else if (bSide === 'b') c2.y += k; else if (bSide === 't') c2.y -= k;
      return { d: 'M' + a.x + ',' + a.y + ' C' + c1.x + ',' + c1.y + ' ' + c2.x + ',' + c2.y + ' ' + b.x + ',' + b.y, c1: c1, c2: c2 };
    }
    var temp = null;
    function drawEdges() {
      if (mobile) return;
      var out = '<defs><marker id="fm-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="fm-arrowhead"/></marker></defs>';
      edges().forEach(function (e) {
        if (!pos[e.from] || !pos[e.to]) return;
        var a = anchor(e.from, e.to), b = anchor(e.to, e.from), cv = curve(a, b, b.side);
        var cls = 'fm-e' + (e.style ? ' fm-e-' + e.style : '') + (selected && (e.from === selected || e.to === selected) ? ' fm-e-hi' : '');
        out += '<path class="' + cls + '" d="' + cv.d + '" marker-end="url(#fm-arr)"/>';
        var lab = e.label;
        if (lab) {
          var mx = (a.x + 3 * cv.c1.x + 3 * cv.c2.x + b.x) / 8, my = (a.y + 3 * cv.c1.y + 3 * cv.c2.y + b.y) / 8;
          out += '<g class="fm-elab"><rect x="' + (mx - lab.length * 3.6 - 6) + '" y="' + (my - 10) + '" width="' + (lab.length * 7.2 + 12) + '" height="20" rx="10"/><text x="' + mx + '" y="' + (my + 4) + '" text-anchor="middle">' + esc(lab) + '</text></g>';
        }
      });
      if (temp) { var a = anchor(temp.from, temp.to), cv = curve(a, temp.to, null); out += '<path class="fm-e fm-e-custom fm-e-hi" d="' + cv.d + '" marker-end="url(#fm-arr)"/>'; }
      svg.innerHTML = out;
    }

    // ── list (phone) ──
    function buildList() {
      var host = body.querySelector('.fmx-mobile');
      var all = nodes(), inLadder = {}; map.ladder.forEach(function (id) { inLadder[id] = 1; });
      var item = function (d) {
        var c = d.n, conv = convText(ctx, d.conv), has = c && c.n;
        return '<li class="fm-' + esc(d.kind) + '"><button class="item" type="button" data-id="' + esc(d.id) + '"><span class="bar"></span><span><span class="t">' + esc(d.title) + '</span><span class="s">' + esc(KIND[d.kind]) + ' · ' + esc(d.sub) + '</span></span>' +
          (c ? '<span class="v' + (has ? '' : ' none') + '">' + esc(has ? ctx.n(c.n) : countText(ctx, c)) + (has && conv ? '<small>' + esc(conv) + ' of previous</small>' : '') + '</span>' : '<span></span>') + '</button></li>';
      };
      var main = map.ladder.map(function (id) { return all.filter(function (x) { return x.id === id; })[0]; }).filter(Boolean);
      var rest = all.filter(function (x) { return x.builtin && !inLadder[x.id]; });
      var mine = all.filter(function (x) { return !x.builtin; });
      host.innerHTML = '<p class="fmx-mh">Main stages, in order</p><ul class="fmx-mlist">' + main.map(item).join('') + '</ul>' +
        (rest.length ? '<p class="fmx-mh">Branches, automations and data</p><ul class="fmx-mlist">' + rest.map(item).join('') + '</ul>' : '') +
        (mine.length ? '<p class="fmx-mh">Your steps</p><ul class="fmx-mlist">' + mine.map(item).join('') + '</ul>' : '') +
        '<p class="muted" style="margin-top:12px;font-size:12px">Tap any stage for the full explanation. Open Funnel HQ on a larger screen to rearrange the map or add your own steps.</p>';
      host.querySelectorAll('[data-id]').forEach(function (b) { b.onclick = function () { open(b.getAttribute('data-id')); }; });
    }

    // ── the explanation panel ──
    function settingRow(s) {
      var val = s.secret ? (s.set ? 'set' : 'not set') : (s.set ? s.value : 'blank');
      return '<li class="fmx-set"><span>' + esc(s.label) + '<br><code>' + esc(s.key) + '</code></span><span class="val' + (s.set ? '' : ' off') + '" title="' + esc(val) + '">' + esc(val) + '</span></li>';
    }
    function autoRow(a) {
      var bits = [];
      if (a.steps) bits.push(a.steps + (a.steps === 1 ? ' email' : ' emails'));
      if (a.long) bits.push('then ' + a.long + ' in the six-month flow');
      if (a.sent != null) bits.push(a.sent ? ctx.n(a.sent) + ' sent in range' : 'none sent in range');
      if (a.calls != null) bits.push(a.calls ? ctx.n(a.calls) + ' calls in range' : 'no calls in range');
      return '<li><span class="fmx-tag">' + esc(AUTO[a.type] || a.type) + '</span>' + esc(a.label) + '<span class="fmx-meta">' + esc(a.timing) + (bits.length ? ' · ' + esc(bits.join(' · ')) : '') + '</span></li>';
    }
    function previewUrl(p) { return p + (p.indexOf('?') > -1 ? '&' : '?') + 'hq_preview=1'; }
    function connectOptions(id) {
      return nodes().filter(function (x) { return x.id !== id; }).sort(function (a, b) { return a.title.localeCompare(b.title); })
        .map(function (x) { return '<option value="' + esc(x.id) + '">' + esc(x.title) + '</option>'; }).join('');
    }
    function open(id, editing) {
      var d = byId(id);
      if (!d) { close(); return; }
      selected = id;
      if (canvas) canvas.querySelectorAll('.fm-node').forEach(function (el) { el.classList.toggle('fm-sel', el.getAttribute('data-id') === id); });
      panel.hidden = false;
      if (editing) { openEditor(d); return; }
      var all = edges();
      var ins = all.filter(function (e) { return e.to === id; }), outs = all.filter(function (e) { return e.from === id; });
      var chip = function (e, other) {
        var o = byId(other); if (!o) return '';
        return '<span class="fm-chip"><button class="fm-link" data-jump="' + esc(other) + '">' + esc(o.title) + '</button>' + (e.custom ? '<button class="fm-x" data-unlink="' + e.idx + '" title="Remove this arrow">✕</button>' : '') + '</span>';
      };
      var c = d.n, h = '';
      h += '<button class="close" type="button" aria-label="Close">✕</button><div class="fm-kind fm-' + esc(d.kind) + '">' + esc(KIND[d.kind]) + (d.builtin ? '' : ' · your step') + '</div><h2>' + esc(d.title) + '</h2><p class="sub">' + esc(d.sub) + '</p>';
      if (c) {
        h += '<h4>Live numbers</h4>';
        h += c.n ? '<div class="fmx-big"><b>' + esc(ctx.n(c.n)) + '</b><span>' + esc(c.unit) + (revText(ctx, c) ? ' · ' + esc(revText(ctx, c)) : '') + '</span></div>'
          : '<p class="fmx-conv">' + (c.n == null ? 'Not counted on this install yet.' : 'No data yet in this date range.') + '</p>';
        if (d.conv) h += '<p class="fmx-conv">' + (d.conv.rate != null ? '<b>' + esc(ctx.pct(d.conv.rate)) + '</b> of ' + esc(d.conv.fromTitle) : 'Conversion from ' + esc(d.conv.fromTitle) + ': not enough data in this range') + '</p>';
      }
      if (d.sees) h += '<h4>What the person sees</h4><p>' + esc(d.sees) + '</p>';
      if (d.behind) h += '<h4>What happens behind it</h4><p>' + esc(d.behind) + '</p>';
      if (d.autosView && d.autosView.length) h += '<h4>Automations</h4><ul class="fmx-list">' + d.autosView.map(autoRow).join('') + '</ul>';
      if (d.settingsView && d.settingsView.length) h += '<h4>Settings that control it</h4><ul class="fmx-list">' + d.settingsView.map(settingRow).join('') + '</ul><p class="muted" style="font-size:12px;margin-top:6px">Change these in Integrations. Secrets show only whether they are set.</p>';
      if (d.note) h += '<div class="fm-note"><div class="fm-kind">' + (d.builtin ? 'Your notes' : 'Notes') + '</div>' + esc(d.note).replace(/\n/g, '<br>') + '</div>';
      var links = '';
      if (d.tab) links += '<a href="#' + esc(d.tab) + '" data-tab-go="' + esc(d.tab) + '">Open ' + esc(tabTitle[d.tab] || d.tab) + ' in Funnel HQ →</a>';
      if (d.page) links += '<a href="' + esc(d.page.path) + '" target="_blank" rel="noopener">' + esc(d.page.label || 'Public page') + ' ↗</a>' + (d.page.preview ? '<a href="' + esc(previewUrl(d.page.preview)) + '" target="_blank" rel="noopener">Admin preview ↗</a>' : '');
      if (links) h += '<div class="fmx-links">' + links + '</div>';
      if (ins.length) h += '<h4>Comes from</h4><p>' + ins.map(function (e) { return chip(e, e.from); }).join(' ') + '</p>';
      if (outs.length) h += '<h4>Leads to</h4><p>' + outs.map(function (e) { return chip(e, e.to); }).join(' ') + '</p>';
      if (!mobile) {
        h += '<div class="fm-connect"><select class="input" data-to><option value="">Connect to…</option>' + connectOptions(id) + '</select><input class="input" data-label maxlength="30" placeholder="Arrow label (optional)"><button class="btn-sm ghost" data-link>Add arrow</button></div>';
        h += '<div class="row" style="margin-top:12px"><button class="btn-sm ghost" data-edit>' + (d.builtin ? 'Edit / add notes' : 'Edit') + '</button>' + (d.builtin ? '' : '<button class="btn-sm ghost danger" data-del>Delete step</button>') + '</div>';
      }
      panel.innerHTML = h;
      panel.scrollTop = 0;
      panel.querySelector('.close').onclick = close;
      panel.querySelectorAll('[data-jump]').forEach(function (b) { b.onclick = function () { open(b.getAttribute('data-jump')); centre(b.getAttribute('data-jump')); }; });
      panel.querySelectorAll('[data-unlink]').forEach(function (b) { b.onclick = function () { custom.edges.splice(Number(b.getAttribute('data-unlink')), 1); saveCustom(); open(id); }; });
      var lk = panel.querySelector('[data-link]');
      if (lk) lk.onclick = function () { var to = panel.querySelector('[data-to]').value; if (to) { link(id, to, panel.querySelector('[data-label]').value.trim()); open(id); } };
      var ed = panel.querySelector('[data-edit]'); if (ed) ed.onclick = function () { open(id, true); };
      var del = panel.querySelector('[data-del]');
      if (del) del.onclick = function () {
        if (!confirm('Delete “' + d.title + '” and its arrows?')) return;
        custom.nodes = custom.nodes.filter(function (x) { return x.id !== id; });
        custom.edges = custom.edges.filter(function (e) { return e[0] !== id && e[1] !== id; });
        delete pos[id]; saveCustom(); saveLayout(); close(); build();
      };
      var g = panel.querySelector('[data-tab-go]'); if (g) g.onclick = function (ev) { ev.preventDefault(); ctx.go(g.getAttribute('data-tab-go')); };
      if (mobile) panel.querySelector('.close').focus();
      drawEdges();
    }
    body.__open = open;
    function openEditor(d) {
      var id = d.id;
      panel.innerHTML = '<button class="close" type="button" aria-label="Close">✕</button><div class="fm-kind">' + (d.builtin ? 'Edit step' : 'Your step') + '</div>' +
        '<label class="fm-f">Title<input class="input" data-e="title" maxlength="60" value="' + esc(d.title) + '"></label>' +
        '<label class="fm-f">Subtitle<input class="input" data-e="sub" maxlength="90" value="' + esc(d.sub) + '"></label>' +
        (d.builtin ? '' :
          '<label class="fm-f">Type<select class="input" data-e="kind">' + Object.keys(KIND).map(function (k) { return '<option value="' + k + '"' + (k === d.kind ? ' selected' : '') + '>' + esc(KIND[k]) + '</option>'; }).join('') + '</select></label>' +
          '<label class="fm-f">Opens tab<select class="input" data-e="tab"><option value="">None</option>' + tabs.map(function (t) { return '<option value="' + esc(t.id) + '"' + (t.id === d.tab ? ' selected' : '') + '>' + esc(t.title) + '</option>'; }).join('') + '</select></label>') +
        '<label class="fm-f">' + (d.builtin ? 'Your notes' : 'How it works / notes') + '<textarea class="input" data-e="note" rows="6" maxlength="2000">' + esc(d.note) + '</textarea></label>' +
        '<div class="row"><button class="btn-sm" data-save>Save</button><button class="btn-sm ghost" data-cancel>Cancel</button>' +
        (d.builtin && d.edited ? '<button class="btn-sm ghost" data-revert>Reset to default</button>' : '') + '</div>';
      var val = function (k) { var el = panel.querySelector('[data-e="' + k + '"]'); return el ? el.value.trim() : ''; };
      panel.querySelector('[data-save]').onclick = function () {
        if (d.builtin) {
          var def = byDef[id], e = {};
          if (val('title') && val('title') !== def.title) e.title = val('title');
          if (val('sub') !== def.sub) e.sub = val('sub');
          if (val('note')) e.note = val('note');
          if (Object.keys(e).length) custom.edits[id] = e; else delete custom.edits[id];
        } else {
          var cn = custom.nodes.filter(function (x) { return x.id === id; })[0];
          cn.title = val('title') || 'New step'; cn.sub = val('sub'); cn.kind = val('kind'); cn.tab = val('tab') || null; cn.note = val('note');
        }
        saveCustom(); build(); open(id);
      };
      panel.querySelector('[data-cancel]').onclick = function () { open(id); };
      var rv = panel.querySelector('[data-revert]'); if (rv) rv.onclick = function () { delete custom.edits[id]; saveCustom(); build(); open(id); };
      panel.querySelector('.close').onclick = close;
      var first = panel.querySelector('[data-e="title"]'); if (first) { first.focus(); first.select(); }
      drawEdges();
    }
    function close() { panel.hidden = true; selected = null; if (canvas) canvas.querySelectorAll('.fm-sel').forEach(function (el) { el.classList.remove('fm-sel'); }); drawEdges(); }
    function centre(id) { var p = pos[id]; if (p && scroll) scroll.scrollTo({ left: (p.x + W / 2) * zoom - scroll.clientWidth / 2, top: (p.y + H / 2) * zoom - scroll.clientHeight / 2, behavior: 'smooth' }); }
    function link(from, to, label) {
      if (from === to) return false;
      if (edges().some(function (e) { return e.from === from && e.to === to; })) return false;
      if (custom.edges.length >= 400) return false;
      custom.edges.push([from, to, (label || '').slice(0, 30)]);
      saveCustom(); drawEdges();
      return true;
    }
    document.addEventListener('keydown', function onKey(e) {
      if (!document.body.contains(panel)) { document.removeEventListener('keydown', onKey); return; }
      if (e.key === 'Escape' && !panel.hidden) close();
    });

    if (mobile) { build(); return; }

    // ── drag boxes, drag ports to connect, pan the background ──
    var drag = null;
    canvas.addEventListener('pointerdown', function (e) {
      var port = e.target.closest('.fm-port'), node = e.target.closest('.fm-node');
      if (port && node) {
        var from = node.getAttribute('data-id'), a = anchor(from, { x: pos[from].x + W + 100, y: pos[from].y + H / 2 });
        drag = { link: from, sx: e.clientX, sy: e.clientY, ax: a.x, ay: a.y };
        canvas.setPointerCapture(e.pointerId); e.preventDefault();
      } else if (node) {
        var id = node.getAttribute('data-id');
        drag = { id: id, sx: e.clientX, sy: e.clientY, ox: pos[id].x, oy: pos[id].y, moved: false };
        node.setPointerCapture(e.pointerId); node.classList.add('fm-drag');
      } else {
        drag = { pan: true, sx: e.clientX, sy: e.clientY, sl: scroll.scrollLeft, st: scroll.scrollTop };
        canvas.setPointerCapture(e.pointerId);
      }
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!drag) return;
      if (drag.pan) { scroll.scrollLeft = drag.sl - (e.clientX - drag.sx); scroll.scrollTop = drag.st - (e.clientY - drag.sy); return; }
      if (drag.link) {
        temp = { from: drag.link, to: { x: drag.ax + (e.clientX - drag.sx) / zoom, y: drag.ay + (e.clientY - drag.sy) / zoom } };
        canvas.querySelectorAll('.fm-target').forEach(function (el) { el.classList.remove('fm-target'); });
        var over = document.elementFromPoint(e.clientX, e.clientY), t = over && over.closest('.fm-node');
        if (t && t.getAttribute('data-id') !== drag.link) t.classList.add('fm-target');
        drawEdges(); return;
      }
      var dx = (e.clientX - drag.sx) / zoom, dy = (e.clientY - drag.sy) / zoom;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      pos[drag.id] = { x: Math.max(0, Math.round((drag.ox + dx) / 10) * 10), y: Math.max(0, Math.round((drag.oy + dy) / 10) * 10) };
      var el = canvas.querySelector('[data-id="' + drag.id + '"]');
      el.style.transform = 'translate(' + pos[drag.id].x + 'px,' + pos[drag.id].y + 'px)';
      drawEdges();
    });
    function end(e) {
      if (!drag) return;
      if (drag.link) {
        canvas.querySelectorAll('.fm-target').forEach(function (el) { el.classList.remove('fm-target'); });
        var over = e && document.elementFromPoint(e.clientX, e.clientY), t = over && over.closest('.fm-node');
        temp = null;
        if (t && t.getAttribute('data-id') !== drag.link) { link(drag.link, t.getAttribute('data-id'), ''); open(drag.link); } else drawEdges();
      } else if (!drag.pan) {
        var el = canvas.querySelector('[data-id="' + drag.id + '"]'); el.classList.remove('fm-drag');
        if (drag.moved) { place(); saveLayout(); } else open(drag.id);
      }
      drag = null;
    }
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', function () { temp = null; end(null); });
    canvas.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { var nd = e.target.closest('.fm-node'); if (nd) { e.preventDefault(); open(nd.getAttribute('data-id')); } } });

    body.querySelector('[data-add]').onclick = function () {
      if (custom.nodes.length >= 200) { alert('That’s the limit of 200 of your own steps on one map.'); return; }
      var id = 'u_' + Math.random().toString(36).slice(2, 10);
      var x = Math.max(0, Math.round(((scroll.scrollLeft + scroll.clientWidth / 2) / zoom - W / 2) / 10) * 10);
      var y = Math.max(0, Math.round(((scroll.scrollTop + scroll.clientHeight / 2) / zoom - H / 2) / 10) * 10);
      while (Object.keys(pos).some(function (k) { return Math.abs(pos[k].x - x) < W && Math.abs(pos[k].y - y) < H; }) && y < 4800) y += 20;
      custom.nodes.push({ id: id, kind: 'page', title: 'New step', sub: '', note: '', tab: null });
      pos[id] = { x: x, y: y };
      saveCustom(); saveLayout(); build(); open(id, true);
    };
    body.querySelectorAll('[data-z]').forEach(function (b) { b.onclick = function () { zoom = Math.max(0.4, Math.min(1.4, zoom + (b.getAttribute('data-z') === '+' ? 0.1 : -0.1))); place(); }; });
    body.querySelector('[data-fit]').onclick = function () { var cw = parseFloat(canvas.style.width) || 2600; zoom = Math.max(0.4, Math.min(1.2, (scroll.clientWidth - 20) / cw)); place(); };
    body.querySelector('[data-reset]').onclick = function () {
      if (!confirm('Put the built-in boxes back where they started? Your own steps stay where they are.')) return;
      STAGES.forEach(function (d) { pos[d.id] = { x: d.x, y: d.y }; });
      place(); saveLayout();
    };

    build();
    if (scroll.clientWidth < 900) body.querySelector('[data-fit]').click();
  }

  window.FunnelMap = { render: render };
})();
