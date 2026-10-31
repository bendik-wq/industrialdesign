/* Funnel dashboard. No framework: small render functions per tab, SVG charts with hover tooltips. */
(function () {
  'use strict';

  // ───────────── helpers ─────────────
  var view = document.querySelector('[data-view]');
  var titleEl = document.querySelector('[data-title]');
  var subtitleEl = document.querySelector('[data-subtitle]');
  var filtersEl = document.querySelector('[data-filters]');
  var state = { tab: 'overview', days: 30, filters: {}, meta: null, leadsQuery: { q: '', tier: '', status: '', page: 0, sort: 'created' } };
  var liveTimer = null;
  var routing = false; // true while route() drives go(), so Back never pushes a new entry
  var lastHash = location.hash;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  // Where someone came from, in plain words: "Instagram · organic", "Google · search", "ChatGPT · AI answer".
  // Mirrors platformOf() in src/lib/attribution.ts.
  var PLATFORMS = [
    ['manychat', 'Instagram DM'], ['chatgpt|chat\\.openai|openai', 'ChatGPT'], ['claude|anthropic', 'Claude'], ['perplexity', 'Perplexity'],
    ['gemini|bard', 'Gemini'], ['copilot', 'Copilot'], ['grok|x\\.ai', 'Grok'], ['meta\\.ai', 'Meta AI'], ['deepseek', 'DeepSeek'],
    ['you\\.com|phind|kagi|poe\\.com|mistral', 'Other AI'], ['instagram|ig', 'Instagram'], ['threads', 'Threads'], ['facebook|fb|messenger', 'Facebook'],
    ['youtube|youtu\\.be', 'YouTube'], ['tiktok', 'TikTok'], ['linkedin|lnkd', 'LinkedIn'], ['x|x\\.com|t\\.co|twitter', 'X'], ['reddit', 'Reddit'],
    ['pinterest', 'Pinterest'], ['snapchat', 'Snapchat'], ['whatsapp|wa\\.me', 'WhatsApp'], ['telegram', 'Telegram'],
    ['email|newsletter|gmail|outlook|mail|resend|klaviyo|mailchimp', 'Email'], ['google', 'Google'], ['bing', 'Bing'], ['duckduckgo', 'DuckDuckGo'],
    ['yahoo', 'Yahoo'], ['brave', 'Brave Search'], ['ecosia', 'Ecosia'],
  ].map(function (p) { return [new RegExp('(^|[^a-z])(' + p[0] + ')([^a-z]|$)', 'i'), p[1]]; });
  function platformOf(src, ref, med) {
    src = String(src || '').toLowerCase(); ref = String(ref || '').toLowerCase(); med = String(med || '').toLowerCase();
    for (var i = 0; i < PLATFORMS.length; i++) {
      if (PLATFORMS[i][0].test(src) || PLATFORMS[i][0].test(ref)) return PLATFORMS[i][1] === 'Instagram' && /dm|manychat/.test(med) ? 'Instagram DM' : PLATFORMS[i][1];
    }
    if (/workers\.dev$/.test(src || ref)) return 'Old workers.dev link';
    return src || ref || 'Direct';
  }
  var CHANNEL_WORD = { 'Organic Social': 'organic', 'Paid Social': 'paid ad', 'Organic Search': 'search', 'Paid Search': 'paid search', 'AI Search': 'AI answer', 'Organic Video': 'video', 'Paid Video': 'video ad', 'Referral': 'link on their site', 'Messaging': 'message', 'Affiliate': 'partner', 'Paid Other': 'paid' };
  function where(channel, src, ref, med) {
    var p = platformOf(src, ref, med);
    if (p === 'Direct') return channel && channel !== 'Direct' ? channel : 'Direct';
    return p + (CHANNEL_WORD[channel] ? ' · ' + CHANNEL_WORD[channel] : '');
  }

  var nf = new Intl.NumberFormat();
  function n(v) { return nf.format(Math.round(v || 0)); }
  function pct(v, d) { return (v == null || !isFinite(v)) ? '–' : (v * 100).toFixed(d == null ? (v < 0.1 && v > 0 ? 1 : 0) : d) + '%'; }
  function money(v) { return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 }).format(v || 0); }
  function secs(v) { v = Math.round(v || 0); return v >= 60 ? Math.floor(v / 60) + 'm ' + (v % 60) + 's' : v + 's'; }
  function when(ms) { if (!ms) return '–'; var d = new Date(ms); return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
  function ago(ms) { var s = Math.round((Date.now() - ms) / 1000); if (s < 60) return s + 's ago'; if (s < 3600) return Math.round(s / 60) + 'm ago'; if (s < 86400) return Math.round(s / 3600) + 'h ago'; return Math.round(s / 86400) + 'd ago'; }
  function toast(msg) { var t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(function () { t.remove(); }, 2600); }
  // Any [data-copylink] button copies its value (each split-test page's own URL).
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-copylink]');
    if (!b) return;
    var t = b.getAttribute('data-copylink');
    (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function () { toast('Copied ' + (t.length > 60 ? 'all links' : t)); }, function () { prompt('Copy this', t); });
  });
  /** A page's own URL: the address without https://, plus a Copy button. */
  function linkCell(url) {
    return '<span class="mono own-url">' + esc(url.replace(/^https?:\/\//, '')) + '</span> <button class="btn-sm ghost" data-copylink="' + esc(url) + '">Copy</button>';
  }

  function range() {
    var to = Date.now();
    var from = state.days >= 3650 ? 0 : (state.days === 1 ? new Date().setHours(0, 0, 0, 0) : to - state.days * 86400000);
    return { from: from || 1, to: to };
  }

  function api(path, params, opts) {
    var q = new URLSearchParams();
    var r = range();
    if (!opts || !opts.noRange) { q.set('from', r.from); q.set('to', r.to); q.set('tz', -new Date().getTimezoneOffset()); }
    Object.keys(state.filters).forEach(function (k) { if (state.filters[k]) q.set(k, state.filters[k]); });
    Object.keys(params || {}).forEach(function (k) { if (params[k] !== '' && params[k] != null) q.set(k, params[k]); });
    return fetch('/admin/api/' + path + '?' + q.toString(), { credentials: 'same-origin' }).then(function (res) {
      if (res.status === 401) { location.href = '/admin/login'; throw new Error('unauthorised'); }
      return res.json();
    });
  }
  function send(method, path, body) {
    return fetch('/admin/api/' + path, { method: method, credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(function (r) { return r.json(); });
  }

  // ───────────── charts ─────────────
  function niceMax(v) {
    if (v <= 0) return 1;
    var p = Math.pow(10, Math.floor(Math.log10(v)));
    var m = v / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
  }

  /** Grid steps that divide a nice max into clean numbers (50 → 5 × 10, 20 → 4 × 5, 10 → 2 × 5). */
  function tickCount(max) {
    if (max <= 2) return max; // counts: never a fractional tick
    var m = max / Math.pow(10, Math.floor(Math.log10(max)));
    return m === 5 ? 5 : m === 1 ? (max >= 10 ? 2 : 4) : 4;
  }

  /** Single-series line/area chart with crosshair tooltip. points: [{label, value}] */
  function lineChart(el, points, o) {
    o = o || {};
    var W = el.clientWidth || 600, H = o.height || 180, P = { l: 40, r: 14, t: 12, b: 24 };
    var iw = W - P.l - P.r, ih = H - P.t - P.b;
    var max = o.max || niceMax(Math.max.apply(null, points.map(function (p) { return p.value; }).concat([0])));
    var fmt = o.fmt || n;
    var x = function (i) { return P.l + (points.length <= 1 ? iw / 2 : (i / (points.length - 1)) * iw); };
    var y = function (v) { return P.t + ih - (v / max) * ih; };
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(o.label || 'chart') + '">';
    var ticks = o.max ? 4 : tickCount(max);
    for (var g = 0; g <= ticks; g++) {
      var gv = (max / ticks) * g;
      svg += '<line class="' + (g === 0 ? 'baseline' : 'gridline') + '" x1="' + P.l + '" x2="' + (W - P.r) + '" y1="' + y(gv) + '" y2="' + y(gv) + '"/>';
      svg += '<text class="tick" x="' + (P.l - 6) + '" y="' + (y(gv) + 4) + '" text-anchor="end">' + esc(fmt(gv)) + '</text>';
    }
    var step = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(iw / 70))));
    points.forEach(function (p, i) { var lastFits = i === points.length - 1 && (i % step) >= step * 0.6; if (i % step === 0 && (points.length - 1 - i >= step * 0.6 || i === points.length - 1) || lastFits) svg += '<text class="tick" x="' + x(i) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(p.short || p.label) + '</text>'; });
    if (o.marker != null && o.marker >= 0 && o.marker < points.length) {
      svg += '<line class="marker-line" x1="' + x(o.marker) + '" x2="' + x(o.marker) + '" y1="' + P.t + '" y2="' + (P.t + ih) + '"/>';
      svg += '<text class="marker-label" x="' + (x(o.marker) + 5) + '" y="' + (P.t + 10) + '">' + esc(o.markerLabel || '') + '</text>';
    }
    if (points.length) {
      var d = points.map(function (p, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(p.value).toFixed(1); }).join('');
      svg += '<path class="area" d="' + d + 'L' + x(points.length - 1) + ',' + y(0) + 'L' + x(0) + ',' + y(0) + 'Z"/>';
      svg += '<path class="line" d="' + d + '"/>';
      // Optional second series (same x positions), drawn dashed and quieter.
      if (o.compare && o.compare.length === points.length) svg += '<path class="line line-compare" d="' + o.compare.map(function (v, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1); }).join('') + '"/>';
      var last = points[points.length - 1];
      svg += '<circle class="dot" r="4" cx="' + x(points.length - 1) + '" cy="' + y(last.value) + '"/>';
      if (o.endLabel !== false) svg += '<text class="end-label" x="' + Math.min(W - 2, x(points.length - 1)) + '" y="' + (y(last.value) - 9) + '" text-anchor="end">' + esc(fmt(last.value)) + '</text>';
    }
    svg += '<line class="crosshair" data-ch x1="0" x2="0" y1="' + P.t + '" y2="' + (P.t + ih) + '" visibility="hidden"/><circle class="dot" data-hd r="4" visibility="hidden"/>';
    svg += '<rect data-hit x="' + P.l + '" y="0" width="' + iw + '" height="' + H + '" fill="transparent"/></svg><div class="tooltip" role="status"></div>';
    el.innerHTML = svg;
    var s = el.querySelector('svg'), ch = s.querySelector('[data-ch]'), hd = s.querySelector('[data-hd]'), tip = el.querySelector('.tooltip');
    if (!points.length) return;
    function show(evt) {
      var rect = s.getBoundingClientRect();
      var px = (evt.clientX - rect.left) * (W / rect.width);
      var i = Math.max(0, Math.min(points.length - 1, Math.round(((px - P.l) / iw) * (points.length - 1))));
      var p = points[i];
      ch.setAttribute('x1', x(i)); ch.setAttribute('x2', x(i)); ch.setAttribute('visibility', 'visible');
      hd.setAttribute('cx', x(i)); hd.setAttribute('cy', y(p.value)); hd.setAttribute('visibility', 'visible');
      tip.innerHTML = '<div class="t"></div><div class="r"><span class="key"></span><b></b><span class="muted"></span></div>';
      tip.querySelector('.t').textContent = p.label;
      tip.querySelector('b').textContent = fmt(p.value);
      tip.querySelector('.muted').textContent = (o.series || '') + (o.compare && o.compare[i] != null ? ' · ' + (o.compareLabel || 'compare') + ' ' + fmt(o.compare[i]) : '');
      var left = (x(i) / W) * rect.width;
      tip.style.left = Math.min(rect.width - 140, Math.max(0, left + 12)) + 'px';
      tip.style.top = '8px';
      tip.classList.add('on');
    }
    s.addEventListener('pointermove', show);
    s.addEventListener('pointerleave', function () { ch.setAttribute('visibility', 'hidden'); hd.setAttribute('visibility', 'hidden'); tip.classList.remove('on'); });
  }

  /** Vertical columns with per-column hover. */
  function columnChart(el, points, o) {
    o = o || {};
    var W = el.clientWidth || 500, H = o.height || 160, P = { l: 34, r: 8, t: 14, b: 24 };
    var iw = W - P.l - P.r, ih = H - P.t - P.b;
    var max = niceMax(Math.max.apply(null, points.map(function (p) { return p.value; }).concat([0])));
    var band = iw / Math.max(1, points.length), bw = Math.min(24, band - 2);
    var y = function (v) { return P.t + ih - (v / max) * ih; };
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(o.label || 'chart') + '">';
    var ct = Math.min(2, max); for (var g = 0; g <= ct; g++) { var gv = (max / ct) * g; svg += '<line class="' + (g ? 'gridline' : 'baseline') + '" x1="' + P.l + '" x2="' + (W - P.r) + '" y1="' + y(gv) + '" y2="' + y(gv) + '"/><text class="tick" x="' + (P.l - 6) + '" y="' + (y(gv) + 4) + '" text-anchor="end">' + n(gv) + '</text>'; }
    points.forEach(function (p, i) {
      var cx = P.l + band * i + band / 2, h = Math.max(p.value ? 2 : 0, ih - (y(p.value) - P.t)), top = P.t + ih - h, r = Math.min(4, h, bw / 2);
      var path = 'M' + (cx - bw / 2) + ',' + (P.t + ih) + 'V' + (top + r) + 'Q' + (cx - bw / 2) + ',' + top + ' ' + (cx - bw / 2 + r) + ',' + top + 'H' + (cx + bw / 2 - r) + 'Q' + (cx + bw / 2) + ',' + top + ' ' + (cx + bw / 2) + ',' + (top + r) + 'V' + (P.t + ih) + 'Z';
      svg += '<path class="col" data-i="' + i + '" d="' + path + '"/><rect data-i="' + i + '" x="' + (P.l + band * i) + '" y="' + P.t + '" width="' + band + '" height="' + ih + '" fill="transparent"/>';
      if (points.length <= 12 || i % 2 === 0) svg += '<text class="tick" x="' + cx + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(p.short || p.label) + '</text>';
    });
    svg += '</svg><div class="tooltip" role="status"></div>';
    el.innerHTML = svg;
    var s = el.querySelector('svg'), tip = el.querySelector('.tooltip');
    s.addEventListener('pointermove', function (e) {
      var i = e.target.getAttribute && e.target.getAttribute('data-i');
      if (i == null) { tip.classList.remove('on'); return; }
      var p = points[+i], rect = s.getBoundingClientRect();
      tip.innerHTML = '<div class="t"></div><div class="r"><b></b></div>';
      tip.querySelector('.t').textContent = p.label;
      tip.querySelector('b').textContent = (o.fmt || n)(p.value);
      tip.style.left = Math.min(rect.width - 130, ((P.l + band * +i + band) / W) * rect.width) + 'px';
      tip.style.top = '0px';
      tip.classList.add('on');
    });
    s.addEventListener('pointerleave', function () { tip.classList.remove('on'); });
  }

  /** Horizontal bar list (HTML) — values labelled at the tip. rows: [{name, value, note}] */
  function barList(rows, o) {
    o = o || {};
    var max = Math.max.apply(null, rows.map(function (r) { return r.value; }).concat([o.max || 0, 1]));
    // Room kept free for the longest value label, so every bar is drawn on the same scale.
    var reserve = Math.max(84, Math.round(Math.max.apply(null, rows.map(function (r) { return String((o.fmt || n)(r.value)).length + (r.note ? String(r.note).length + 1 : 0); }).concat([0])) * 7.2) + 16);
    return '<div class="bars ' + (o.cls || '') + '">' + rows.map(function (r) {
      // Bar length is honest: the share of the largest value, of the space left after the value label.
      var f = max ? Math.max(0, r.value || 0) / max : 0;
      return '<div class="bar-row"><div class="name" title="' + esc(r.name) + '">' + esc(r.name) + '</div><div class="bar-track"><div class="bar-fill' + (r.value ? '' : ' zero') + '" style="width:calc((100% - ' + reserve + 'px) * ' + f.toFixed(4) + ')' + (r.color ? ';background:' + r.color : '') + '"></div><span class="bar-val">' + esc((o.fmt || n)(r.value)) + (r.note ? '<small>' + esc(r.note) + '</small>' : '') + '</span></div></div>' +
        (r.rate != null ? '<div class="bar-row"><span></span><p class="step-rate' + (r.rateWarn ? ' warn' : '') + '"' + (r.rateTitle ? ' title="' + esc(r.rateTitle) + '"' : '') + '>↓ ' + esc(r.rate) + '</p></div>' : '');
    }).join('') + '</div>';
  }

  /** Stat tile. Words (names, "Off", "Not connected", "–") and long values get a calmer size; numbers stay big. With goTab it becomes a link to that tab. */
  function tile(label, value, hint, goTab, delta) {
    var v = String(value);
    var long = v !== '–' && (v.length > 12 || !/^[\s\d.,%$A-Z€£+\-–x×]*\d/.test(v)); // a lone dash keeps the number size, so tiles line up
    var dir = delta && delta.text ? ({ up: 'up', down: 'down', flat: 'flat' })[delta.dir] || 'flat' : '';
    // Nothing yet (0, 0%, –, A$0, "0 clicks", "0 min"): same size, quieter colour, so real numbers stand out.
    // delta.zeroOk: a rate where 0 is good news (0% cancel rate, 0% bounce) keeps its normal colour.
    var zero = v === '–' || (!(delta && delta.zeroOk) && (v === '0' || v === '0%' || v === '0.0%' || v === money(0) || v === '0 clicks' || v === '0 min' || v === '0s'));
    var inner = '<div class="label">' + esc(label) + '</div><div class="' + (long ? 'value value-text' : 'value') + (zero ? ' value-zero' : '') + '">' + esc(value) + '</div>' +
      (dir ? '<div class="delta ' + dir + '">' + esc(delta.text) + '</div>' : '') + (hint ? '<div class="hint">' + esc(hint) + '</div>' : '');
    if (goTab) return '<a class="tile tile-link" href="#' + esc(goTab) + '" data-go="' + esc(goTab) + '"' + (TABS[goTab] ? ' title="' + esc('Open ' + TABS[goTab].title) + '"' : '') + ' aria-label="' + esc(label + ': ' + value + ', open details') + '">' + inner + '<span class="tile-go" aria-hidden="true">→</span></a>';
    return '<div class="tile">' + inner + '</div>';
  }

  /** Lead status as a coloured pill (won green, booked blue, partial amber, lost outlined). Text unchanged. */
  function statusPill(s, label) {
    return '<span class="pill st-' + esc(String(s || '').replace(/[^a-z_]/gi, '')) + '">' + esc(label || s || '–') + '</span>';
  }

  /** The one calm empty state used everywhere. */
  function emptyState(msg, hint) {
    return '<div class="empty"><div>' + esc(msg) + '</div>' + (hint ? '<div class="empty-hint">' + esc(hint) + '</div>' : '') + '</div>';
  }

  function tierStack(a, b, c) {
    var t = a + b + c || 1;
    return '<div class="stack" role="img" aria-label="Tier A ' + a + ', B ' + b + ', C ' + c + '">' +
      [['A', a, '--tier-a'], ['B', b, '--tier-b'], ['C', c, '--tier-c']].filter(function (x) { return x[1]; }).map(function (x) {
        return '<span title="Tier ' + x[0] + ': ' + x[1] + '" style="flex:' + x[1] / t + ';background:var(' + x[2] + ')"></span>';
      }).join('') + '</div><div class="legend"><span><i style="background:var(--tier-a)"></i>A · qualified ' + n(a) + ' (' + pct(a / t) + ')</span><span><i style="background:var(--tier-b)"></i>B · mid-fit ' + n(b) + ' (' + pct(b / t) + ')</span><span><i style="background:var(--tier-c)"></i>C · nurture ' + n(c) + ' (' + pct(c / t) + ')</span></div>';
  }

  /** Tier badge. No tier: a dashed "step N" only for unfinished applications; anyone else (e.g. booked straight on Calendly) gets a muted "no tier". */
  function tierCell(l) {
    if (l.tier) return '<span class="tier ' + esc(l.tier) + '">' + esc(l.tier) + '</span>';
    if (l.status === 'partial') {
      var st = Number(l.step_reached) || 0;
      return st > 0 ? '<span class="tier partial" title="' + esc('Left the application at step ' + st) + '">step ' + esc(st) + '</span>' : '<span class="tier partial" title="Opened the application but didn’t answer the first question">not started</span>';
    }
    return '<span class="muted no-tier" title="' + (l.status === 'booked' ? 'Booked without finishing the application' : 'No tier: the application wasn’t finished') + '">no tier</span>';
  }

  function table(cols, rows, o) {
    o = o || {};
    if (!rows.length) return emptyState(o.empty || 'No data in this range yet.', o.emptyHint);
    // o.cards: on a phone each row becomes a small card, every cell labelled with its column (data-label); cards: 3 packs the values three across.
    // o.feed: on a phone each row becomes two lines (what happened · when, then who / where / source / device), for streams.
    return '<div class="table-wrap' + (o.cards ? ' tcards' + (o.cards === 3 ? ' tcards-3' : '') : '') + (o.feed ? ' tfeed' : '') + '"><table><thead><tr>' + cols.map(function (c) { return '<th class="' + (c.num ? 'num' : '') + (c.nw ? ' nw' : '') + '">' + esc(c.label) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr' + (o.rowAttr ? ' ' + o.rowAttr(r) : '') + '>' + cols.map(function (c) {
          var body, zero = false;
          if (c.html) {
            body = c.html(r);
            zero = !!c.num && !c.zeroOk && ZERO_CELL.test(String(body));
          } else {
            var txt = c.fmt ? c.fmt(r[c.key], r) : r[c.key];
            body = esc(txt);
            // A number column with nothing in it (0, 0%, A$0, –) reads quieter, so the real numbers stand out.
            zero = !!c.num && !c.zeroOk && ZERO_CELL.test(String(txt));
          }
          return '<td class="' + (c.num ? 'num' : '') + (c.nw ? ' nw' : '') + (zero ? ' zero' : '') + '" data-label="' + esc(c.label) + '">' + body + '</td>';
        }).join('') + '</tr>';
      }).join('') + '</tbody></table></div>';
  }
  var ZERO_CELL = /^(A?\$0(\.00)?|0(\.0)?%?|0s|–|-)$/;

  // ───────────── tabs ─────────────
  var TABS = {
    command: { group: 'Command', title: 'Command', sub: 'Your Chief of Staff: ask about the numbers, give instructions, approve what the departments propose.', more: 'Chat answers from live Funnel HQ data and links each number to the view it comes from. Anything that changes something (contacting leads or clients, ad changes, spending money) waits in Approvals until you approve it, unless you switched that kind of action to auto in Integrations (Command). The activity log shows every action across departments. Routines run saved instructions on a schedule; the hourly check raises alerts; the morning brief goes to Slack and lands here.', render: renderCommand, noFilters: true },
    overview: { group: 'Today', title: 'Overview', sub: 'Every step from ad click to closed deal.', render: renderOverview },
    live: { group: 'Today', title: 'Live', sub: 'Who’s on the site now, and everything people did — from the last hour back to all time.', render: renderLive, noFilters: true },
    leads: { group: 'Sell', title: 'Leads', sub: 'Every applicant, scored and routed. Click a row for their full journey.', render: renderLeads, filters: ['range', 'channel'] },
    sales: { group: 'Sell', title: 'Calls & deals', sub: 'Calls, show rate, closes and cash by rep. Log outcomes here.', more: 'Calls, show rate, closes and cash by rep. Log outcomes here — wins ping the team in Slack / Discord.', render: renderSales, filters: ['range'] },
    dminbox: { group: 'Sell', title: 'DM inbox', sub: 'Instagram DMs in one priority inbox: scored, assigned, answered inside Meta’s windows.', more: 'Conversations from Instagram (Meta’s official API: DMs, Story replies and mentions, comments) sorted by Hot / Warm / Cold and how long they have waited. Assign setters, tag, add notes, reply with scripts or an AI draft you edit and send yourself. Control center: yesterday’s results, today’s tasks, setter numbers and bulk reassign. Scripts show which openers get replies and bookings. Keyword triggers tag, assign and send the first message.', render: renderDmInbox, noFilters: true },
    finance: { group: 'Sell', title: 'Financial model', sub: 'What the VSL and webinar funnels make per dollar of ads, and what it takes to hit a profit target.', more: 'A monthly model for each funnel: ad spend and cost per visitor in, then every conversion step down to clients won, revenue, profit, cost per booked call and CAC. Break-even lines show the most you can pay per visitor, per call and per client. The projection grows spend month by month and shows the cash you need before it pays back. Live funnel numbers sit next to each assumption once there’s enough data.', render: renderFinance, noFilters: true },
    clients: { group: 'Sell', title: 'Clients', sub: 'Every client’s health, flags, onboarding checklist, timeline and next check-in.', more: 'A client is anyone who paid for the First Deal Sprint, paid the engagement deposit or signed the engagement agreement. Health starts at 100 and every deduction comes from our own data (Sprint deliverables and calls, intake, payments, weekly sessions you log, reply times, last two-way contact, open support escalations), listed with the view it came from. Check-ins are drafted daily in the team’s voice and wait here for your approval before anything is sent.', render: renderClientsTab, noFilters: true },
    support: { group: 'Follow-up', title: 'Support', sub: 'Questions by email and from the rooms, with drafted answers, sources and escalations.', more: 'Support email (Resend inbound or any forwarder), masterclass and live room questions and challenge hot seats land here. Claude drafts each answer from our own guides, materials, the guarantee, the FAQ and the offer terms, with the sources it used and a confidence. Anything about money, refunds, payments or legal, and anything below the confidence threshold, is marked Needs a person. Nothing is sent until you approve it.', render: renderSupportTab, noFilters: true },
    insights: { group: 'Sell', title: 'Best leads', sub: 'Who your best leads are: everyone who booked, split by tier, with the A-tier unpacked.', render: renderInsights, noFilters: true },
    map: { group: 'Funnel', title: 'Funnel map', sub: 'Every page, decision and automation, with live numbers.', more: 'How everything fits together: every page, decision and automation from ad click to closed deal, with live numbers. Drag to rearrange, click any box to see how it works, and add your own steps.', render: renderMap },
    screens: { group: 'Funnel', title: 'Page previews', sub: 'Every page in the funnel, in order, live.', more: 'Every page in the funnel, in order, live. Previews never count as visits, never fire ad pixels and can’t submit anything.', render: renderScreens, noFilters: true },
    pages: { group: 'Funnel', title: 'Landing pages & tests', sub: 'Every landing page and headline test, traced to cash.', more: 'Every page people land on, and every headline being tested: the main page’s A/B test plus 100 industry landers (20 industries × 5 headlines). Each visit is traced to applications, bookings and cash.', render: renderLanders },
    vsl: { group: 'Funnel', title: 'Video (VSL)', sub: 'Who watches, where they drop, and when they reach the pitch.', render: renderVsl },
    application: { group: 'Funnel', title: 'Application', sub: 'Step drop-off, answers and lead scoring.', render: renderApplication },
    behaviour: { group: 'Funnel', title: 'On-page behaviour', sub: 'What people click, where the form slows them down and where they leave.', more: 'What people click, where the form slows them down, where they leave, what they re-read and highlight. Nothing anyone types is ever recorded.', render: renderBehaviour, filters: ['range'] },
    autopilot: { group: 'Traffic', title: 'Ads autopilot', sub: 'Every ad judged on our own results, with proposed changes to approve.', more: 'Meta is read every hour at ad level. Each ad is matched to its leads, revenue band, tickets, bookings and deposits by utm_content. Fatigued and losing ads get a pause proposal, winners a duplicate, and budget moves from losing ad sets to winning ones within your daily limit. Nothing changes on Meta until you approve, unless you set that change to auto. Without a write token, approving means you made the change in Ads Manager yourself.', render: renderAutopilot, noFilters: true },
    salesops: { group: 'Sell', title: 'Follow-up actions', sub: 'Follow up with quiet leads, no-shows and unpaid checkouts in one approved batch.', more: 'Pick an action, preview every drafted message, edit or remove any of them, then approve. Consent, unsubscribes, the suppression list and sending hours are checked when drafting and again at the moment of sending.', render: renderSalesOps, noFilters: true },
    traffic: { group: 'Traffic', title: 'Traffic & ads', sub: 'Which sources, campaigns and ads produce qualified leads — not just clicks.', render: renderTraffic },
    links: { group: 'Traffic', title: 'Links & videos', sub: 'Tracked links for your Instagram bio, ManyChat, YouTube and more, followed to closed deals.', more: 'One tracked link per place you post it (Instagram bio, each ManyChat flow, each video), followed from the tap to the booked call and the closed deal.', render: renderLinks, filters: ['range'] },
    webinar: { group: 'Traffic', title: 'Webinar', sub: 'Sessions, registrations, attendance and what they did next.', more: 'The masterclass at live.grosfjeld-li.com: sessions, who registered, who came and how long they watched, and how many went on to apply, book and buy.', render: renderWebinar, filters: ['range'] },
    liveevents: { group: 'Traffic', title: 'Live webinars', sub: 'Live sessions with Josh on Zoom: registrations, attendance, the deposit offer and the ladder.', more: 'Schedule a live webinar (the landing page /live shows the next one with a real countdown), see who registered and who came, open the host console, and run the deposit offer: Open the offer shows it in every room at once, with its real deadline, Show timer, Pin message and Close offer. Deposit buyers, revenue and show rate per event, and the ladder from registration to a signed engagement.', render: renderLiveEvents, filters: ['range'] },
    challenge: { group: 'Traffic', title: 'Challenge', sub: 'The First Deal Challenge: cohorts, registrants, attendance, worksheets and deposits, per day.', more: 'Create a cohort (five days at the same local time, each editable), paste each day’s Zoom link (or create it in the host console), and after each session paste the replay link. Registrants, VIPs, live attendance and replays, worksheets, deposits and revenue are counted per cohort and per day. Days 4 and 5 have the Open offer switch (also in the host console); the offer closes for good at the cohort’s deadline.', render: renderChallenge, noFilters: true },
    research: { group: 'Traffic', title: 'Research', sub: 'What $1M+ owners complain about and want, what competitors run, and the angles Marketing tests next.', more: 'Once a day Funnel HQ reads Reddit (official API), the Meta Ad Library, YouTube and your own leads’ answers, then groups what it finds into themes with counts and linked quotes. Competitor ads are ranked by how long they have run. Angles are drafted from the themes, checked against the copy rules and against competitor wording, and Send to Marketing proposes a test in the action log. A weekly brief goes to Slack.', render: renderResearch, noFilters: true },
    dealsprint: { group: 'Traffic', title: 'Sprint board', sub: 'First Deal Sprint buyers, day by day, and the ladder from ticket to engagement.', more: 'Every First Deal Sprint buyer with their day of 7, intake, kickoff and Deal Plan session, and each deliverable. Fill in the link and notes and mark it Ready: the buyer gets one email and sees it on their Sprint page. Mark the outcome after the Deal Plan session (proposal sent starts the follow-up emails) and draft the engagement agreement with the Sprint credit applied. The ladder at the top counts tickets, watchers, Sprint buyers and signed engagements in the selected range, with revenue per registrant and per ticket.', render: renderDealSprint, filters: ['range'] },
    materials: { group: 'Traffic', title: 'Materials', sub: 'Webinar and challenge scripts, slide decks, presenter window and run sheets.', more: 'Every script in one place, from public/materials. Read the script with the cues marked and the timing per chapter, present the slides full screen (share that window in Zoom), open the presenter window for your notes, the clock and the next host cue, print the run sheet, download the script, or save the deck as a PDF. Scripts are only served to people logged in here.', render: renderMaterials, noFilters: true },
    emails: { group: 'Follow-up', title: 'Emails', sub: 'Sequences, deliverability and engagement.', render: renderEmailsWithFlow, filters: ['range'] },
    editor: { group: 'Follow-up', title: 'Email editor', sub: 'Read and edit every email the funnel sends.', more: 'Pick an email on the left, change the wording on the right and watch the preview update. Merge tags like {first_name} fill in for each person. Saving replaces the built-in wording for every future send; “Reset to default” brings the original back. Emails written from each lead’s own application answers are shown but can’t be edited here.', render: renderEditor, noFilters: true },
    search: { group: 'Traffic', title: 'Search & AI', sub: 'Who finds you through Google, Bing, ChatGPT, Claude, Perplexity, Gemini and Grok, and which AI crawlers are reading your pages.', more: 'The landing pages, 20 industry pages and the guides are open to search engines and AI assistants; the application, booking and personal pages never are. Crawler visits show the AI companies reading your pages (search bots and live answers lead to citations; training bots feed future models). Visitors and leads from AI Search are people who clicked through from an AI answer. New pages usually take days to weeks to show up in search.', render: renderSearch, filters: ['range'] },
    content: { group: 'Traffic', title: 'Content', sub: 'Josh’s YouTube and Instagram: what travels, what brings leads, and what to make next.', more: 'Videos refresh every 6 hours (or press Refresh). Views come from YouTube and Instagram; leads, calls and revenue per video come from the tracked links in Links & videos, so add a tracked link to each video’s description to see which ones actually sell.', render: renderContent, noFilters: true },
    contracts: { group: 'Contracts', title: 'Agreements', sub: 'One-page advisory agreements: draft, preview, sign, send from Josh, and track their signature.', more: 'Make a new agreement for any lead (fee auto-quoted from their application) or anyone else, preview the exact document, sign it for the company, and it’s emailed from Josh for their e-signature. Every signature is recorded with time, IP and a fingerprint of the exact terms. Send yourself a test first.', render: renderContracts, noFilters: true },
    ytideas: { group: 'Traffic', title: 'YouTube ideas', sub: 'The next two weeks of videos, planned from what your applicants actually say, what’s winning on YouTube and what already made you money.', more: 'Twelve inputs in, 5–10 topics out, every two weeks. Each topic comes with the demand behind it, the belief it installs, two titles, two thumbnails, the hook, a mini-VSL outline and the CTA, in binge order. Export to Google Docs or Miro, or press “Explore” on any new angle to plan a sprint around it.', render: renderYtIdeas, noFilters: true },
    reactivation: { group: 'Follow-up', title: 'Reactivation', sub: 'Bring back people already in the database: past calls, no-shows, unfinished applications.', more: 'Pick the groups, untick anyone who shouldn’t get it (existing clients, friends), preview the 6 emails and launch. Sending is spread out over days to protect your email reputation. It stops for anyone who books or applies again, unsubscribes or becomes a client.', render: renderReactivation, noFilters: true },
    sms: { group: 'Follow-up', title: 'SMS & WhatsApp', sub: 'Text and WhatsApp sequences: wording, timing and links.', more: 'Message sequences by text or WhatsApp: drag messages to organise them, edit the wording and timing, choose the link and when to skip. Only to people who agreed, 8am–8pm their time, max 3 a day.', render: renderSmsTab, noFilters: true },
    voice: { group: 'Follow-up', title: 'AI calls', sub: 'Outbound confirmations and inbound calls: transcripts, recordings, outcomes.', more: 'AI calls: outbound confirmations (ElevenLabs) and inbound phone / browser calls (Vapi). Transcripts, recordings and outcomes.', render: renderVoice, filters: ['range'] },
    team: { group: 'Setup', title: 'Reps & routing', sub: 'Who takes calls, which tiers they get, and where the team gets pinged.', more: 'Who takes calls, which tiers they get, their calendar, commission and targets — and where the team gets pinged.', render: renderTeam, noFilters: true },
    integrations: { group: 'Setup', title: 'Integrations', sub: 'Connect email, WhatsApp, calendars, analytics and ad platforms.', render: renderIntegrations, noFilters: true },
    tracking: { group: 'Setup', title: 'Ad tracking', sub: 'Every conversion sent from the server to Meta and GA4, and whether it arrived.', more: 'Every conversion sent to Meta (Conversions API) and GA4 from the server: delivery, retries and match quality.', render: renderTracking, filters: ['range'] },
  };

  var eyebrowEl = document.querySelector('[data-eyebrow]');
  var moreEl = document.querySelector('[data-more]');
  var moreTextEl = document.querySelector('[data-more-text]');
  var navCurrentEl = document.querySelector('[data-nav-current]');
  var navToggleEl = document.querySelector('[data-nav-toggle]');
  var clearBtn = document.querySelector('[data-clear]');

  /** Every history write goes through here, so route() can tell our own writes from Back/Forward. */
  // Entries the dashboard writes are marked, so route() can tell Back / Forward (marked) from a hash typed into the address bar (unmarked).
  function setHash(method, hash) { history[method]({ hq: 1 }, '', hash); lastHash = location.hash; }
  function markEntry() { try { if (!(history.state && history.state.hq)) history.replaceState({ hq: 1 }, '', location.href); } catch (e) { /* ignore */ } }

  /** Remove any open drawer (lead or visitor) without touching history. */
  function closeDrawers() {
    document.querySelectorAll('.drawer, .drawer-bg').forEach(function (el) { if (el.__teardown) el.__teardown(); el.remove(); });
  }

  function setNavOpen(open) {
    document.body.classList.toggle('nav-open', open);
    if (navToggleEl) navToggleEl.setAttribute('aria-expanded', String(open));
  }

  /** Keep the active nav item (and its group heading, when it is the first in its group) inside the nav's scroll box. */
  function revealActiveNav() {
    var nav = document.querySelector('[data-nav]');
    var btn = nav && nav.querySelector('button[aria-current="page"]');
    if (!btn || nav.scrollHeight <= nav.clientHeight) return;
    var prev = btn.previousElementSibling;
    var top = (prev && prev.classList.contains('nav-h') ? prev : btn).getBoundingClientRect().top;
    var bottom = btn.getBoundingClientRect().bottom;
    var box = nav.getBoundingClientRect();
    if (top < box.top + 14) nav.scrollTop -= box.top + 14 - top;
    else if (bottom > box.bottom - 26) nav.scrollTop += bottom - (box.bottom - 26);
  }

  /** Fade the nav's top / bottom edge only when there is more to scroll in that direction. */
  function updateNavFade() {
    var nav = document.querySelector('[data-nav]');
    if (!nav) return;
    nav.classList.toggle('fade-top', nav.scrollTop > 2);
    nav.classList.toggle('fade-bottom', nav.scrollHeight - nav.clientHeight - nav.scrollTop > 2);
  }

  function go(tab, opts) {
    closeDrawers();
    // Stop page previews before their view is replaced, so third-party scripts inside them end cleanly.
    view.querySelectorAll('.screen-frame iframe').forEach(function (f) { f.src = 'about:blank'; });
    if (tab === 'experiments' || tab === 'landers') tab = 'pages';
    // Command sections live in the hash: #command/approvals, #command/thread=<id>.
    var cmdSub = '';
    if (typeof tab === 'string' && tab.indexOf('command/') === 0) { cmdSub = tab.slice(8); tab = 'command'; }
    state.commandSub = cmdSub;
    if (!TABS[tab]) tab = 'overview';
    var T = TABS[tab];
    state.tab = tab;
    state.leadsQuery._focus = false; // a fresh visit never grabs the keyboard
    clearInterval(liveTimer);
    document.querySelectorAll('[data-nav] button').forEach(function (b) { b.setAttribute('aria-current', b.getAttribute('data-tab') === tab ? 'page' : 'false'); });
    titleEl.textContent = T.title;
    subtitleEl.textContent = T.sub;
    if (eyebrowEl) eyebrowEl.textContent = T.group || '';
    if (moreEl) { moreTextEl.textContent = T.more || ''; moreEl.hidden = !T.more; moreEl.open = false; }
    if (navCurrentEl) navCurrentEl.textContent = T.title;
    setNavOpen(false);
    filtersEl.style.display = T.noFilters ? 'none' : '';
    var f = T.filters;
    var rangeEl = filtersEl.querySelector('[data-range]');
    if (rangeEl) rangeEl.style.display = !f || f.indexOf('range') > -1 ? '' : 'none';
    filtersEl.querySelectorAll('select[data-filter]').forEach(function (sel) { sel.style.display = !f || f.indexOf(sel.getAttribute('data-filter')) > -1 ? '' : 'none'; });
    updateFilterCue();
    if (!routing) {
      var h = '#' + tab + (tab === 'command' && cmdSub ? '/' + cmdSub : '');
      // A lead hash left over from a drawer that go() just closed is replaced, never stacked.
      if (location.hash.indexOf('#lead=') === 0) setHash('replaceState', h);
      else if (location.hash !== h) setHash(opts && opts.replace ? 'replaceState' : 'pushState', h);
      // A fresh navigation starts at the top of the page; Back / Forward keep the browser's position.
      window.scrollTo(0, 0);
    }
    revealActiveNav();
    updateNavFade();
    load();
  }

  /** Back / Forward / a hash typed into the address bar: show what the URL says. */
  function route() {
    if (location.hash === lastHash) return; // popstate and hashchange both fire for one change
    lastHash = location.hash;
    var typed = !(history.state && history.state.hq); // a new entry from the address bar, not Back / Forward
    markEntry();
    var h = location.hash.slice(1);
    if (h.indexOf('lead=') === 0) {
      var id = decodeURIComponent(h.slice(5));
      var open = document.querySelector('.drawer[data-lead]');
      if (open && open.getAttribute('data-lead') === id) return;
      var hadDrawer = !!document.querySelector('.drawer');
      closeDrawers();
      if (state.tab !== 'leads' && !hadDrawer) { routing = true; go('leads'); routing = false; }
      openLead(id, { fromRoute: true });
      return;
    }
    closeDrawers();
    if ((h || 'overview') !== state.tab + (state.tab === 'command' && state.commandSub ? '/' + state.commandSub : '')) {
      routing = true; go(h || 'overview'); routing = false;
      if (typed) window.scrollTo(0, 0); // a typed hash is a fresh visit: start at the top
    }
  }

  /** How many filters (visible on this tab) are narrowing the numbers; tints the bar and relabels Reset. */
  function updateFilterCue() {
    var count = 0;
    filtersEl.querySelectorAll('select[data-filter]').forEach(function (sel) {
      var v = state.filters[sel.getAttribute('data-filter')];
      sel.classList.toggle('on', !!v);
      if (v && sel.style.display !== 'none') count++;
    });
    // On Leads, the search box and the tier / status pickers in the list count too, so Reset clears them as well.
    if (state.tab === 'leads') ['tier', 'status', 'q'].forEach(function (k) { if (state.leadsQuery[k]) count++; });
    filtersEl.classList.toggle('is-filtered', count > 0);
    if (clearBtn) clearBtn.textContent = count ? 'Clear filters (' + count + ')' : 'Reset';
  }

  function load() {
    document.body.classList.add('loading');
    Promise.resolve(TABS[state.tab].render()).catch(function (e) { console.error(e); view.innerHTML = '<div class="empty">Couldn’t load this view. ' + esc(e.message) + '</div>'; })
      .then(function () { document.body.classList.remove('loading'); });
  }

  function renderMap() {
    var sum = function (arr, k) { return (arr || []).reduce(function (t, x) { return t + (x[k] || 0); }, 0); };
    var soft = function (p) { return p.catch(function () { return {}; }); };
    return Promise.all([
      api('overview'), soft(api('landers')), soft(api('triggers')), soft(api('experiments')),
      soft(fetch('/admin/api/map-layout', { credentials: 'same-origin' }).then(function (r) { return r.json(); })),
      soft(fetch('/admin/api/map-custom', { credentials: 'same-origin' }).then(function (r) { return r.json(); })),
    ]).then(function (r) {
      FunnelMap.render(view, {
        esc: esc, n: n, pct: pct, money: money, go: go,
        layout: r[4].layout || null,
        stats: { kpis: r[0].kpis, funnel: r[0].funnel, landerVisitors: sum(r[1].byIndustry, 'visitors'), mainVisitors: sum(r[3].variants, 'visitors'), triggerSent: sum(r[2].rules, 'sent') },
        save: function (pos) { send('PUT', 'map-layout', { layout: pos }); },
        custom: r[5].custom || null,
        saveCustom: function (custom) { send('PUT', 'map-custom', { custom: custom }); },
        tabs: Object.keys(TABS).filter(function (k) { return k !== 'map'; }).map(function (k) { return { id: k, title: TABS[k].title }; }),
      });
    });
  }
  var screenPrefs = (function () { try { return JSON.parse(localStorage.getItem('hq_screens') || '{}'); } catch (e) { return {}; } })();
  function renderScreens() {
    return api('pages', {}, { noRange: true }).then(function (d) {
      var dev = screenPrefs.dev === 'phone' ? 'phone' : 'desktop', size = ['s', 'm', 'l'].indexOf(screenPrefs.size) >= 0 ? screenPrefs.size : 'm';
      var W = dev === 'phone' ? { s: 200, m: 260, l: 340 }[size] : { s: 300, m: 420, l: 600 }[size];
      var DW = dev === 'phone' ? 390 : 1280, DH = dev === 'phone' ? 1500 : 1800, k = W / DW;
      var btn = function (key, val, label, cur) { return '<button class="btn-sm' + (cur === val ? '' : ' ghost') + '" data-sp="' + key + ':' + val + '">' + label + '</button>'; };
      var groups = [], byGroup = {};
      d.pages.forEach(function (p) { if (!byGroup[p.group]) { byGroup[p.group] = []; groups.push(p.group); } byGroup[p.group].push(p); });
      view.innerHTML = '<div class="card screens-bar"><div class="row">' + btn('dev', 'desktop', '🖥 Desktop', dev) + btn('dev', 'phone', '📱 Phone', dev) +
        '<span class="sep"></span>' + btn('size', 's', 'Small', size) + btn('size', 'm', 'Medium', size) + btn('size', 'l', 'Large', size) +
        '<span class="muted" style="margin-left:auto">Scroll sideways to follow the funnel →  Scroll inside a page to see all of it.</span></div></div>' +
        groups.map(function (g) {
          return '<h2 class="screens-group">' + esc(g) + '</h2><div class="screens-lane">' + byGroup[g].map(function (p, i) {
            return (i ? '<div class="screens-arrow" aria-hidden="true">→</div>' : '') +
              '<figure class="screen" style="width:' + W + 'px">' +
              '<figcaption><span class="screen-n">' + p.n + '</span><strong>' + esc(p.title) + '</strong><span class="muted">' + esc(p.desc) + '</span></figcaption>' +
              '<div class="screen-frame ' + dev + '" style="width:' + W + 'px;height:' + Math.round(DH * k) + 'px"><iframe loading="lazy" title="' + esc(p.title) + '" src="' + esc(p.src) + '" style="width:' + DW + 'px;height:' + DH + 'px;transform:scale(' + k + ')"></iframe></div>' +
              '<div class="row screen-actions"><span class="mono muted">' + esc(p.path.replace(/[?&]hq_as=\w+/, '')) + '</span><a class="btn-sm ghost" href="' + esc(p.src) + '" target="_blank" rel="noopener">Open ↗</a><button class="btn-sm ghost" data-reload="' + p.n + '">Reload</button></div></figure>';
          }).join('') + '</div>';
        }).join('') +
        '<p class="muted" style="margin-top:12px">Webinar pages are shown with a made-up sign-up, at the minute named on each one. Nothing you click in them is saved.</p>';
      view.querySelectorAll('[data-sp]').forEach(function (b) {
        b.onclick = function () { var kv = b.getAttribute('data-sp').split(':'); screenPrefs[kv[0]] = kv[1]; try { localStorage.setItem('hq_screens', JSON.stringify(screenPrefs)); } catch (e) { /* ignore */ } renderScreens(); };
      });
      view.querySelectorAll('[data-reload]').forEach(function (b) {
        b.onclick = function () { var f = b.closest('.screen').querySelector('iframe'); f.src = f.src; };
      });
    });
  }
  // ───────────── Financial model ─────────────
  var FIN_FIELDS = {
    shared: [
      ['fee', 'Average client fee', 'money'], ['refund', 'Refunds (7-day guarantee)', 'pct'], ['upfront', 'Paid upfront (rest the month after)', 'pct'],
      ['commission', 'Closer commission', 'pct'], ['fulfil', 'Delivery cost per client', 'money'], ['fixed', 'Fixed costs a month (team, tools)', 'money'],
      ['target', 'Profit target a month', 'money'], ['months', 'Months to project', 'int'], ['growth', 'Ad spend growth a month', 'pct'],
    ],
    vsl: [
      ['spend', 'Ad spend a month', 'money'], ['cpc', 'Cost per landing-page visitor', 'money2'], ['optin', 'Visitors who give contact details', 'pct'],
      ['appDone', 'Of those, finish the application', 'pct'], ['qualified', 'Applications that qualify ($1M+)', 'pct'], ['book', 'Qualified who book a call', 'pct'],
      ['show', 'Show rate', 'pct'], ['close', 'Close rate (of calls held)', 'pct'],
    ],
    webinar: [
      ['spend', 'Ad spend a month', 'money'], ['cpc', 'Cost per landing-page visitor', 'money2'], ['reg', 'Visitors who register', 'pct'],
      ['attend', 'Registrants who watch (live or replay)', 'pct'], ['applyAtt', 'Watchers who apply', 'pct'], ['applyNo', 'Non-watchers who apply (from the emails)', 'pct'],
      ['qualified', 'Applications that qualify ($1M+)', 'pct'], ['book', 'Qualified who book a call', 'pct'], ['show', 'Show rate', 'pct'], ['close', 'Close rate (of calls held)', 'pct'],
      // The paid ladder (used when "Paid ladder" is ticked): ticket → First Deal Sprint → engagement.
      ['ticket', 'Ladder: ticket price', 'money'], ['ticketBuy', 'Ladder: registrants who buy a ticket', 'pct'], ['sprintPrice', 'Ladder: First Deal Sprint price', 'money'],
      ['sprintRate', 'Ladder: watchers who buy the Sprint', 'pct'], ['sprintToEng', 'Ladder: Sprint buyers who sign the engagement', 'pct'],
      ['engFee', 'Ladder: engagement fee (before the Sprint credit)', 'money'], ['sprintCost', 'Ladder: delivery cost per Sprint', 'money'],
    ],
  };
  var FIN_MIN_N = 20; // fewer people than this and a live rate is shown but not trusted

  function renderFinance() {
    var M = window.FinModel;
    if (!M) { view.innerHTML = '<div class="card">The model script didn’t load. Refresh the page.</div>'; return Promise.resolve(); }
    return api('finance', null, { noRange: true }).then(function (d) {
      var A = d.actuals || {}, models = d.models || [];
      var cur = models[0] ? { id: models[0].id, name: models[0].name, data: M.normalise(models[0].data) } : { id: null, name: 'Base case', data: M.normalise({}) };
      var dirty = false;
      var cfmt = function (dp) { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur.data.shared.currency, maximumFractionDigits: dp || 0, minimumFractionDigits: dp || 0 }); } catch (e) { return new Intl.NumberFormat(undefined, { maximumFractionDigits: dp || 0 }); } };
      var cm = function (v, dp) { return v == null || !isFinite(v) ? '–' : cfmt(dp).format(v); };
      var n1 = function (v) { return v == null || !isFinite(v) ? '–' : v >= 10 ? n(v) : (Math.round(v * 10) / 10).toString(); };
      var shown = function (type, v) { return type === 'pct' ? +(v * 100).toFixed(2) : type === 'money2' ? +v.toFixed(2) : Math.round(v); };

      var liveHint = function (sec, key, type) {
        var a = A[sec] && A[sec][key];
        if (!a) return '';
        var val = type === 'pct' ? pct(a.value, 1) : cm(a.value, type === 'money2' ? 2 : 0);
        var ok = a.trust || a.n >= FIN_MIN_N, unit = a.unit || 'person';
        return '<div class="fm-live' + (ok ? '' : ' weak') + '" title="' + esc(a.note) + '">Live: ' + esc(val) + ' · ' + esc(n(a.n)) + ' ' + (a.n === 1 ? unit : unit === 'person' ? 'people' : unit + 's') + (ok ? ' <button type="button" class="linkish" data-fm-use="' + esc(sec + '.' + key) + '">use</button>' : ' (too few to trust)') + '</div>';
      };
      var fieldsHtml = function (sec) {
        return FIN_FIELDS[sec].map(function (f) {
          var type = f[2], v = cur.data[sec][f[0]];
          return '<label class="fm-field"><span>' + esc(f[1]) + '</span><span class="fm-in' + (type === 'pct' ? ' is-pct' : type.indexOf('money') === 0 ? ' is-money' : '') + '"><input class="input" type="number" inputmode="decimal" min="0" step="' + (type === 'money2' ? '0.1' : type === 'pct' ? '0.1' : '1') + '" data-fm="' + esc(sec + '.' + f[0]) + '" data-type="' + type + '" value="' + esc(String(shown(type, v))) + '"></span>' + liveHint(sec, f[0], type) + '</label>';
        }).join('');
      };
      var funnelCard = function (sec, title, sub) {
        return '<div class="card fm-funnel" data-fm-card="' + sec + '"><div class="card-head"><div><h2>' + esc(title) + '</h2><p class="sub">' + esc(sub) + '</p></div>' +
          (sec === 'webinar' ? '<label class="fm-toggle"><input type="checkbox" data-fm-ladder' + (cur.data.webinar.ladder ? ' checked' : '') + '> Paid ladder</label>' : '') +
          '<label class="fm-toggle"><input type="checkbox" data-fm-on="' + sec + '"' + (cur.data[sec].on ? ' checked' : '') + '> Include</label></div>' +
          '<div class="fm-fields">' + fieldsHtml(sec) + '</div><div data-fm-out="' + sec + '"></div></div>';
      };

      view.innerHTML =
        '<div class="card"><div class="card-head"><div><h2>Scenario</h2><p class="sub">Every number below is an assumption you can change; results update as you type. Where the funnel has real data, it shows next to the input (last 90 days). Ad spend and cost per visitor aren’t tracked here yet, so set those from your ad account. Save a scenario to share it with the team.</p></div></div>' +
        '<div class="row fm-bar"><select class="input" data-fm-pick style="max-width:240px">' + (models.length ? models.map(function (m) { return '<option value="' + esc(m.id) + '">' + esc(m.name) + '</option>'; }).join('') : '<option value="">Base case (not saved)</option>') + '</select>' +
        '<input class="input" data-fm-name value="' + esc(cur.name) + '" maxlength="80" style="max-width:200px" aria-label="Scenario name">' +
        '<select class="input" data-fm-cur style="max-width:90px" aria-label="Currency">' + ['USD', 'AUD', 'GBP', 'EUR', 'CAD', 'NZD'].map(function (c) { return '<option' + (c === cur.data.shared.currency ? ' selected' : '') + '>' + c + '</option>'; }).join('') + '</select>' +
        '<button class="btn-sm" type="button" data-fm-save>Save</button><button class="btn-sm ghost" type="button" data-fm-saveas>Save as new</button>' +
        '<button class="btn-sm ghost" type="button" data-fm-live>Use live numbers</button><button class="btn-sm ghost" type="button" data-fm-reset>Reset to defaults</button>' +
        (models.length ? '<button class="btn-sm ghost" type="button" data-fm-del>Delete</button>' : '') + '<span class="muted" data-fm-msg></span></div></div>' +
        '<div data-fm-total style="margin-top:14px"></div>' +
        '<div class="grid g-2" style="margin-top:14px">' +
        funnelCard('vsl', 'VSL funnel', 'Ad → VSL page → application → call → client.') +
        funnelCard('webinar', 'Webinar funnel', 'Ad → registration → masterclass (live or replay) → application → call → client. With the paid ladder: ticket → masterclass → First Deal Sprint → engagement, the Sprint fee credited against it.') + '</div>' +
        '<div class="card" style="margin-top:14px"><h2>Price and costs</h2><p class="sub">Shared by both funnels.</p><div class="fm-fields fm-fields-wide">' + fieldsHtml('shared') + '</div></div>' +
        '<div data-fm-proj style="margin-top:14px"></div><div class="grid g-2" data-fm-sens style="margin-top:14px"></div>';

      var msg = view.querySelector('[data-fm-msg]');
      var markDirty = function () { dirty = true; msg.textContent = 'Unsaved changes'; };

      var unitRows = function (p, sec) {
        var u = p.unit, f = cur.data[sec];
        var rows = [
          [sec === 'webinar' ? 'Cost per registrant' : 'Cost per lead', cm(u.perLead, 2)], ['Cost per application', cm(u.perApp)], ['Cost per qualified application', cm(u.perQualified)],
          ['Cost per booked call', cm(u.perBooked)], ['Cost per call held', cm(u.perHeld)], ['Cost to win a client (CAC)', cm(u.cac)],
          ['Return on ad spend', u.roas == null ? '–' : u.roas.toFixed(1) + '×'], ['Profit per $1 of ads', u.profitPerDollar == null ? '–' : cm(u.profitPerDollar, 2)],
        ];
        if (sec === 'webinar' && f.ladder) rows.unshift(['Revenue per registrant', cm(u.revPerRegistrant, 2)], ['Revenue per ticket', cm(u.revPerTicket, 2)], ['Cost per Sprint buyer', cm(u.perSprint)]);
        var be = [['Most you can pay per visitor', cm(u.maxCpc, 2), f.cpc > u.maxCpc], ['Most you can pay per booked call', cm(u.maxPerBooked), u.perBooked > u.maxPerBooked], ['Most you can pay per client', cm(u.maxCac), u.cac > u.maxCac]];
        return '<div class="fm-steps">' + p.steps.map(function (st, i) {
          var prev = i ? p.steps[i - 1].n : null;
          return '<div class="fm-step"><span>' + esc(st.label) + '</span><b>' + esc(n1(st.n)) + '</b>' + (prev ? '<i>' + esc(pct(st.n / prev, 1)) + '</i>' : '<i></i>') + '</div>';
        }).join('') + '</div>' +
          '<dl class="fm-kv">' + rows.map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>'; }).join('') + '</dl>' +
          '<h3 class="h3" style="margin-top:12px">Break-even</h3><dl class="fm-kv">' + be.map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd class="' + (r[2] ? 'fm-neg-t' : '') + '">' + esc(r[1]) + '</dd>'; }).join('') + '</dl>' +
          '<div class="fm-result ' + (p.profit >= 0 ? 'pos' : 'neg') + '"><span>Profit a month from this funnel</span><b>' + esc(cm(p.profit)) + '</b><small>' + esc(n1(p.deals)) + ' clients · ' + esc(cm(p.net)) + ' after refunds · before fixed costs</small></div>';
      };

      var draw = function () {
        var m = cur.data, c = M.combine(m), t = c.total, pr = M.projection(m);
        view.querySelector('[data-fm-total]').innerHTML =
          '<div class="grid g-4 tiles">' +
          tile('Ad spend a month', cm(t.spend), [m.vsl.on && 'VSL ' + cm(m.vsl.spend), m.webinar.on && 'Webinar ' + cm(m.webinar.spend)].filter(Boolean).join(' · ')) +
          tile('Clients a month', n1(t.deals), n1(t.held) + ' calls held · ' + n1(t.booked) + ' booked') +
          tile('Revenue a month', cm(t.net), 'after refunds · CAC ' + cm(t.cac) + ' · ROAS ' + (t.roas == null ? '–' : t.roas.toFixed(1) + '×')) +
          tile('Profit a month', cm(t.profitAfterFixed), 'after ads, commission, delivery and ' + cm(t.fixed) + ' fixed costs') +
          '</div><div class="grid g-4 tiles" style="margin-top:14px">' +
          tile('Spend to hit ' + cm(m.shared.target) + ' profit', t.spendForTarget == null ? 'Not reachable' : cm(t.spendForTarget), t.spendForTarget == null ? 'The funnels lose money per dollar at these rates' : 'a month, at today’s rates and VSL/webinar mix') +
          tile('Break-even ad spend', t.breakEvenSpend == null ? 'Not reachable' : cm(t.breakEvenSpend), 'a month, to cover fixed costs') +
          tile('Cash needed up front', cm(pr.cashNeeded), pr.cashNeeded ? 'deepest point of cumulative cash over ' + m.shared.months + ' months' : 'cash never goes below zero at these numbers') +
          tile('Payback', pr.paybackMonth ? 'Month ' + pr.paybackMonth : 'Not within ' + m.shared.months + ' months', 'when cumulative cash turns positive for good') + '</div>';
        c.parts.forEach(function (p) { view.querySelector('[data-fm-out="' + p.kind + '"]').innerHTML = unitRows(p, p.kind); });
        ['vsl', 'webinar'].forEach(function (k) { if (!m[k].on) view.querySelector('[data-fm-out="' + k + '"]').innerHTML = '<p class="muted" style="margin-top:12px">Left out of the totals.</p>'; view.querySelector('[data-fm-card="' + k + '"]').classList.toggle('off', !m[k].on); });
        var maxAbs = pr.rows.reduce(function (a, r) { return Math.max(a, Math.abs(r.cumCash)); }, 1);
        view.querySelector('[data-fm-proj]').innerHTML = '<div class="card"><h2>' + esc(m.shared.months) + '-month projection</h2><p class="sub">Ad spend grows ' + esc(pct(m.shared.growth, 1)) + ' a month. ' + esc(pct(m.shared.upfront)) + ' of each fee lands the month the client signs and the rest the month after. Rates stay as set above.</p>' +
          '<div class="table-wrap"><table class="t fm-proj"><thead><tr><th>Month</th><th class="num">Ad spend</th><th class="num">Clients</th><th class="num">Revenue</th><th class="num">Profit</th><th class="num">Cash in the bank (cumulative)</th></tr></thead><tbody>' +
          pr.rows.map(function (r) {
            var w = Math.round(Math.abs(r.cumCash) / maxAbs * 100);
            return '<tr><td>' + r.month + '</td><td class="num">' + esc(cm(r.spend)) + '</td><td class="num">' + esc(n1(r.deals)) + '</td><td class="num">' + esc(cm(r.net)) + '</td><td class="num' + (r.profit < 0 ? ' fm-neg-t' : '') + '">' + esc(cm(r.profit)) + '</td><td class="num"><span class="fm-cum"><span class="fm-cum-bar ' + (r.cumCash < 0 ? 'neg' : 'pos') + '" style="width:' + w + '%"></span><span>' + esc(cm(r.cumCash)) + '</span></span></td></tr>';
          }).join('') + '</tbody></table></div></div>';
        view.querySelector('[data-fm-sens]').innerHTML = ['vsl', 'webinar'].filter(function (k) { return m[k].on; }).map(function (k) {
          var s = M.sensitivity(k, m);
          return '<div class="card"><h2>' + (k === 'vsl' ? 'VSL' : 'Webinar') + ': what if</h2><p class="sub">Monthly profit (before fixed costs) if the close rate or the cost per visitor moves. The middle cell is your current scenario.</p><div class="table-wrap"><table class="t fm-sens"><thead><tr><th>Close rate ↓ · cost per visitor →</th>' +
            s.cols.map(function (x) { return '<th class="num">' + esc(cm(x, 2)) + '</th>'; }).join('') + '</tr></thead><tbody>' +
            s.rows.map(function (r, ri) { return '<tr><th>' + esc(pct(r.close, 1)) + '</th>' + r.cells.map(function (v, ci) { return '<td class="num ' + (v >= 0 ? 'fm-pos' : 'fm-neg') + (ri === 2 && ci === 2 ? ' fm-here' : '') + '">' + esc(cm(v)) + '</td>'; }).join('') + '</tr>'; }).join('') +
            '</tbody></table></div></div>';
        }).join('');
      };

      var setField = function (path, raw) {
        var parts = path.split('.'), el = view.querySelector('[data-fm="' + path + '"]'), type = el ? el.getAttribute('data-type') : 'money';
        var v = Number(raw);
        if (!isFinite(v)) return;
        cur.data[parts[0]][parts[1]] = type === 'pct' ? v / 100 : v;
        cur.data = M.normalise(cur.data);
      };
      view.querySelectorAll('[data-fm]').forEach(function (inp) {
        inp.oninput = function () { if (inp.value === '') return; setField(inp.getAttribute('data-fm'), inp.value); markDirty(); draw(); };
      });
      view.querySelectorAll('[data-fm-on]').forEach(function (cb) { cb.onchange = function () { cur.data[cb.getAttribute('data-fm-on')].on = cb.checked; markDirty(); draw(); }; });
      var ladderCb = view.querySelector('[data-fm-ladder]');
      ladderCb.onchange = function () { cur.data.webinar.ladder = ladderCb.checked; markDirty(); draw(); };
      view.querySelector('[data-fm-cur]').onchange = function () { cur.data.shared.currency = this.value; markDirty(); draw(); };
      var applyLive = function (path) {
        var p = path.split('.'), a = A[p[0]] && A[p[0]][p[1]], el = view.querySelector('[data-fm="' + path + '"]');
        if (!a || !el) return false;
        var type = el.getAttribute('data-type');
        cur.data[p[0]][p[1]] = a.value;
        el.value = shown(type, a.value);
        return true;
      };
      view.querySelectorAll('[data-fm-use]').forEach(function (b) { b.onclick = function (e) { e.preventDefault(); if (applyLive(b.getAttribute('data-fm-use'))) { cur.data = M.normalise(cur.data); markDirty(); draw(); } }; });
      view.querySelector('[data-fm-live]').onclick = function () {
        var used = 0;
        ['shared', 'vsl', 'webinar'].forEach(function (sec) { Object.keys(A[sec] || {}).forEach(function (k) { var a = A[sec][k]; if (a && (a.trust || a.n >= FIN_MIN_N) && applyLive(sec + '.' + k)) used++; }); });
        cur.data = M.normalise(cur.data);
        if (used) { markDirty(); draw(); }
        toast(used ? 'Used ' + used + ' live number' + (used === 1 ? '' : 's') + '. The rest have too little data yet.' : 'Not enough live data yet: every rate is based on fewer than ' + FIN_MIN_N + ' people.');
      };
      view.querySelector('[data-fm-reset]').onclick = function () {
        if (!confirm('Put every input back to the starting assumptions? Saved scenarios aren’t touched until you press Save.')) return;
        cur.data = M.normalise({ shared: { currency: cur.data.shared.currency } });
        view.querySelectorAll('[data-fm]').forEach(function (el) { var p = el.getAttribute('data-fm').split('.'); el.value = shown(el.getAttribute('data-type'), cur.data[p[0]][p[1]]); });
        view.querySelectorAll('[data-fm-on]').forEach(function (cb) { cb.checked = true; });
        ladderCb.checked = cur.data.webinar.ladder;
        markDirty(); draw();
      };
      var save = function (asNew) {
        var name = view.querySelector('[data-fm-name]').value.trim() || 'Base case';
        if (asNew && name === cur.name) name = name + ' (copy)';
        send('POST', 'finance/models', { id: asNew ? undefined : cur.id, name: name, data: cur.data }).then(function (r) {
          if (!r || !r.ok) { toast('Couldn’t save'); return; }
          dirty = false; toast('Saved “' + r.name + '”');
          load();
        });
      };
      view.querySelector('[data-fm-save]').onclick = function () { save(false); };
      view.querySelector('[data-fm-saveas]').onclick = function () { save(true); };
      var del = view.querySelector('[data-fm-del]');
      if (del) del.onclick = function () {
        if (!cur.id || !confirm('Delete the scenario “' + cur.name + '”?')) return;
        fetch('/admin/api/finance/models/' + encodeURIComponent(cur.id), { method: 'DELETE', credentials: 'same-origin' }).then(function () { load(); });
      };
      var pick = view.querySelector('[data-fm-pick]');
      if (cur.id) pick.value = cur.id;
      pick.onchange = function () {
        if (dirty && !confirm('Switch scenario? Unsaved changes will be lost.')) { pick.value = cur.id || ''; return; }
        var m = models.filter(function (x) { return x.id === pick.value; })[0];
        if (!m) return;
        cur = { id: m.id, name: m.name, data: M.normalise(m.data) };
        view.querySelector('[data-fm-name]').value = cur.name;
        view.querySelector('[data-fm-cur]').value = cur.data.shared.currency;
        view.querySelectorAll('[data-fm]').forEach(function (el) { var p = el.getAttribute('data-fm').split('.'); el.value = shown(el.getAttribute('data-type'), cur.data[p[0]][p[1]]); });
        view.querySelectorAll('[data-fm-on]').forEach(function (cb) { cb.checked = cur.data[cb.getAttribute('data-fm-on')].on; });
        ladderCb.checked = cur.data.webinar.ladder;
        dirty = false; msg.textContent = ''; draw();
      };
      draw();
    });
  }

  /** Webinar tab: the watch experience (moments that land, readiness scores, buy-in answers). */
  function webinarExperienceHtml(x) {
    var e = x && x.experience;
    if (!e) return '';
    var mins = e.minutes || [], max = Math.max.apply(null, mins.map(function (m) { return m.total; }).concat([1]));
    var pitch = Math.round(x.pitchAtMin || 45);
    var strip = '<div class="wx-heat" role="img" aria-label="Reactions and saved notes per minute">' + mins.map(function (m) {
      var a = m.total ? 0.12 + 0.88 * (m.total / max) : 0;
      return '<i title="Minute ' + m.minute + ': ' + n(m.new) + ' new to me, ' + n(m.do) + ' would do this, ' + n(m.explain) + ' explain more, ' + n(m.notes) + ' notes saved"' +
        ' style="background:' + (m.total ? 'rgba(15,44,92,' + a.toFixed(2) + ')' : 'var(--hair, #e3e6ec)') + (m.minute === pitch ? ';box-shadow:inset 0 -3px 0 #b7791f' : '') + '"></i>';
    }).join('') + '</div><div class="wx-heat-axis"><span>0m</span><span>15m</span><span>30m</span><span>45m (pitch)</span><span>' + mins.length + 'm</span></div>';
    var peaks = mins.filter(function (m) { return m.total; }).sort(function (a, b) { return b.total - a.total; }).slice(0, 5);
    var t = e.totals || {};
    return '<div class="card" style="margin-top:14px"><h2>Moments that land</h2><p class="sub">Reactions (New to me, I would do this, Explain more) and saved key points, per minute of the masterclass. Darker means more. Viewers only see a count once a chapter reaches 10 people.</p>' +
      '<div class="grid g-4 tiles" style="margin-top:8px">' + tile('Reactions', n(t.reactions), 'in this period', null, { zeroOk: true }) + tile('Notes saved', n(t.notes), 'key points saved', null, { zeroOk: true }) +
      tile('Readiness scored', n(t.scored), 'answered something in the room', null, { zeroOk: true }) + tile('Average readiness', e.average != null ? n(e.average) + ' / 100' : '–', 'viewers see it from 30 people') + '</div>' +
      '<div style="margin-top:14px">' + strip + '</div>' +
      (peaks.length ? '<h3 class="h3" style="margin-top:12px">Peaks</h3><ul class="plain-list">' + peaks.map(function (m) { return '<li><b>Minute ' + m.minute + '</b>: ' + n(m.new) + ' new to me · ' + n(m.do) + ' would do this · ' + n(m.explain) + ' explain more · ' + n(m.notes) + ' notes</li>'; }).join('') + '</ul>' : '') +
      ((e.topNotes || []).length ? '<h3 class="h3" style="margin-top:12px">Most saved key points</h3>' + barList(e.topNotes.map(function (k) { return { name: k.text, value: k.n }; })) : '') + '</div>' +
      '<div class="grid g-2" style="margin-top:14px"><div class="card"><h2>Readiness scores</h2><p class="sub">Acquisition readiness (0 to 100) from each viewer’s own answers: revenue band, target, timeline, the calculator’s 1.5x test, own cash and blocker.</p>' +
      barList((e.buckets || []).map(function (b) { return { name: b.label, value: b.n }; })) + '</div>' +
      '<div class="card"><h2>Biggest gap</h2><p class="sub">The gap each viewer was shown at the pitch. Lead with it on the strategy call.</p>' + ((e.gaps || []).length ? barList(e.gaps.map(function (g) { return { name: g.gap, value: g.n }; })) : '<p class="muted">No scores yet.</p>') + '</div></div>' +
      ((e.buyins || []).length ? '<div class="card" style="margin-top:14px"><h2>In their own words</h2><p class="sub">“What would your first acquisition change for you?” asked at 38 minutes and played back at the pitch. Quote it in the follow-up and on the call. Shared answers appear anonymously in the room once 5 people have shared' + (e.wallLive ? ' (showing now)' : ' (not showing yet)') + '. Hide any you don’t want shown.</p>' +
        table([
          { label: 'Who', html: function (r) { return '<strong>' + esc(r.name) + '</strong><div class="muted">' + esc(r.email || '') + (r.band ? ' · ' + esc(r.band) : '') + '</div>'; } },
          { label: 'Answer', html: function (r) { return '“' + esc(r.text) + '”'; } },
          { label: 'Next', html: function (r) { return r.booked ? statusPill('booked') : r.applied ? statusPill('applied') : '<span class="muted">–</span>'; } },
          { label: 'Wall', html: function (r) { return r.shared ? '<label class="check"><input type="checkbox" data-buyin-hide="' + esc(r.id) + '"' + (r.hidden ? ' checked' : '') + '> hide</label>' : '<span class="muted">private</span>'; } },
        ], e.buyins, { cards: true, rowAttr: function (r) { return 'class="click" data-lead="' + esc(r.lead_id) + '" tabindex="0"'; } }) + '</div>' : '');
  }

  /** Webinar tab: the deeper half (watch curve, slots, sources, groups, pre-webinar emails). */
  function webinarInsightsHtml(x, base) {
    if (!x || !x.watch) return '';
    var w = x.watch, e = x.emails || {}, q = x.qualified || {}, hl = x.headlines || { rows: [] };
    var HLMODE = hl.mode === 'even' ? 'Even split' : hl.mode === 'auto' ? 'Auto' : 'Pinned';
    var roomHtml = '<div class="card" style="margin-top:14px"><h2>Who’s in the room</h2><p class="sub">Sign-ups now say their revenue. $1M+ sign-ups get the daily emails, texts and the offer. Under $1M can still watch but get none of that, and Meta hears about them as RevenueUnder1M so you can exclude them.</p>' +
      '<div class="grid g-4 tiles" style="margin-top:8px">' +
      tile('$1M+ sign-ups', n(q.qualified), pct(q.rate) + ' of ' + n(q.regs) + ' sign-ups') +
      tile('Cost per $1M+ sign-up', q.perQualified != null ? money(q.perQualified) : '–', q.spend ? money(q.spend) + ' webinar ad spend' : 'add webinar ad spend in Traffic & ads') +
      tile('Under $1M', n((x.bands || []).filter(function (b) { return b.band === '<1m'; }).reduce(function (a, b) { return a + b.n; }, 0)), 'watch only, no follow-up', null, { zeroOk: true }) +
      tile('Not asked', n((x.bands || []).filter(function (b) { return b.band === 'unknown'; }).reduce(function (a, b) { return a + b.n; }, 0)), 'signed up before the question existed', null, { zeroOk: true }) + '</div>' +
      ((x.bands || []).length ? '<div style="margin-top:12px">' + table([{ label: 'Revenue', html: function (r) { return esc(r.label) + (r.qualified ? '' : ' <span class="muted">· not qualified</span>'); } }, { label: 'Sign-ups', key: 'n', num: true, fmt: n }], x.bands) + '</div>' : '') + '</div>' +
      '<div class="card" style="margin-top:14px"><div class="card-head"><div><h2>Headline test</h2><p class="sub"><strong>' + esc(HLMODE) + ':</strong> every headline gets its first 40 visitors, then traffic shifts to the ones that bring the most <b>$1M+</b> sign-ups per visitor (not the most sign-ups). Preview any headline with the link; previews don’t count.</p></div>' +
      '<div class="seg" role="group" aria-label="Headline mode"><button type="button" data-whl="auto" aria-pressed="' + (hl.mode === 'auto') + '">Auto</button><button type="button" data-whl="even" aria-pressed="' + (hl.mode === 'even') + '">Even</button></div></div>' +
      table([
        { label: 'Headline', html: function (r) { return '<strong>' + esc(r.angle) + '</strong><div class="muted">' + esc(r.h1) + '</div><a class="muted" href="' + esc(String(base || '').replace(/\/+$/, '') + '/?h=' + r.id) + '" target="_blank" rel="noopener">preview ↗</a>'; } },
        { label: 'Visitors', key: 'views', num: true, fmt: n },
        { label: 'Sign-ups', key: 'regs', num: true, fmt: n },
        { label: '$1M+ sign-ups', num: true, html: function (r) { return esc(n(r.qualified)) + '<div class="muted">' + esc(pct(r.rate, 1)) + ' of visitors</div>'; } },
        { label: 'Traffic now', num: true, html: function (r) { return esc(hl.mode === r.id ? '100%' : (hl.mode !== 'auto' && hl.mode !== 'even') ? '0%' : pct(r.share)); } },
        { label: '', html: function (r) { return hl.mode === r.id ? '<span class="pill">pinned</span>' : '<button type="button" class="btn-sm ghost" data-whl="' + esc(r.id) + '">Show to all</button>'; } },
      ], hl.rows) + '</div>';
    var mins = function (m) { return m + ' min'; };
    var flow = [
      { label: 'Registered', key: 'regs', num: true, fmt: n },
      { label: '$1M+', num: true, html: function (r) { return esc(n(r.qualified)) + '<div class="muted">' + esc(pct(r.qualifiedRate)) + '</div>'; } },
      { label: 'Showed', num: true, html: function (r) { return esc(pct(r.showRate)) + '<div class="muted">' + n(r.attended) + ' live · ' + n(r.replays) + ' replay</div>'; } },
      { label: 'Clicked offer', key: 'cta', num: true, fmt: n },
      { label: 'Applied', key: 'applied', num: true, fmt: n },
      { label: 'Booked', num: true, html: function (r) { return esc(n(r.booked)) + '<div class="muted">' + esc(pct(r.bookRate)) + ' of reg.</div>'; } },
      { label: 'Won', num: true, html: function (r) { return esc(n(r.won)) + (r.revenue ? '<div class="muted">' + esc(money(r.revenue)) + '</div>' : ''); } },
    ];
    var drops = (w.drops || []).map(function (d) {
      return '<li><b>Minute ' + d.minute + '</b>: ' + esc(pct(d.lost, 1)) + ' of live viewers left' + (w.offerClicks[d.minute] ? ' · ' + n(w.offerClicks[d.minute]) + ' clicked the offer here' : '') + '</li>';
    }).join('');
    var g = x.engagement || {}, st = x.stage || [];
    var engageHtml = '<div class="grid g-2" style="margin-top:14px">' +
      '<div class="card"><h2>Masterclass funnel ($1M+)</h2><p class="sub">Each step for owners doing $1M+ (and older sign-ups who weren’t asked). Applying and booking also count people who did it after the session, without the room’s button.</p>' +
      barList(st.map(function (s, i) { return { name: s.key, value: s.n, note: i && st[0].n ? pct(s.n / st[0].n) + ' of registered' : '' }; })) + '</div>' +
      '<div class="card"><h2>In the room</h2><p class="sub">What people did beyond watching.</p><div class="grid g-2 tiles" style="margin-top:8px">' +
      tile('Questions asked', n((g.questions || []).length), n((g.questions || []).filter(function (q) { return q.answer; }).length) + ' answered by the assistant') +
      tile('Calculator runs', n((g.calc || {}).runs), (g.calc && g.calc.medianPrice) ? 'typical deal: ' + money(g.calc.medianPrice) + ' price, ' + money(g.calc.medianProfit) + ' profit' : 'no runs yet') +
      tile('Worksheets unlocked', n(g.worksheets), 'attendee bonus') +
      tile('Blueprints opened', n((g.blueprints || {}).opened), n((g.blueprints || {}).built) + ' built at the pitch' + ((g.blueprints || {}).polished ? ' · ' + n(g.blueprints.polished) + ' polished by AI' : '')) +
      tile('Offer clicks', n(((g.offers || {}).call || 0) + ((g.offers || {}).selfServe || 0)), n((g.offers || {}).selfServe) + ' chose start-now · ' + n((g.offers || {}).agreements) + ' agreements sent') +
      '</div>' + ((g.targets || []).some(function (t) { return t.n; }) ? '<h3 class="h3" style="margin-top:12px">“Which business would you most like to own?” (thank-you page)</h3>' + barList((g.targets || []).map(function (t) { return { name: t.label, value: t.n }; })) : '') + '</div></div>' +
      ((g.polls || []).some(function (p) { return p.total; }) ? '<div class="card" style="margin-top:14px"><h2>Poll answers</h2><p class="sub">Asked inside the masterclass. Use them on the strategy call and in the follow-up.</p><div class="grid g-2" style="margin-top:8px">' +
        (g.polls || []).map(function (p) { return '<div><h3 class="h3">' + esc(p.question) + ' <span class="muted">· minute ' + p.at + ' · ' + n(p.total) + ' answers</span></h3><p class="muted small">' + esc(p.purpose) + '</p>' + barList(p.options.map(function (o) { return { name: o.label, value: o.n }; })) + '</div>'; }).join('') + '</div></div>' : '') +
      ((g.questions || []).length ? '<div class="card" style="margin-top:14px"><h2>Questions from the room</h2><p class="sub">Every question typed in the masterclass, with the assistant’s reply. Tick them off once someone has followed up. Questions without a reply need one by email.</p>' +
        table([
          { label: 'Who', html: function (r) { return '<strong>' + esc(r.name) + '</strong>' + (r.pass ? ' <span class="pill">paid · priority</span>' : '') + '<div class="muted">' + esc(r.email || '') + (r.band ? ' · ' + esc(r.band) : '') + '</div>'; } },
          { label: 'Question', html: function (r) { return esc(r.question) + (r.at != null ? '<div class="muted">at ' + Math.floor(r.at / 60) + ' min</div>' : ''); } },
          { label: 'Assistant replied', html: function (r) { return r.answer ? '<span class="muted">' + esc(r.answer) + '</span>' : '<span class="pill">needs a reply</span>'; } },
          { label: '', html: function (r) { return '<label class="check"><input type="checkbox" data-qdone="' + esc(r.id) + '"' + (r.handled ? ' checked' : '') + '> done</label>'; } },
        ], g.questions, { cards: true }) + '</div>' : '');
    var lv = x.live;
    var liveHtml = lv ? '<div class="card" style="margin-top:14px"><h2>Live layer</h2><p class="sub">The real people in each showing: chat between viewers, the team’s replies, call requests, and the most people truly in a showing at once (from presence pings, never estimated).</p>' +
      '<div class="grid g-4 tiles" style="margin-top:8px">' +
      tile('Chat messages', n(lv.messages), n(lv.chatters) + ' viewers wrote in the chat') +
      tile('Team replies', n(lv.teamMessages + lv.privateReplies), n(lv.teamMessages) + ' in the chat · ' + n(lv.privateReplies) + ' private answers') +
      tile('Call requests', n(lv.raises), '“Get a call from Josh’s team” ($1M+)') +
      tile('Announcements', n(lv.announcements), 'sent from the host console') + '</div>' +
      ((lv.showings || []).length ? '<div style="margin-top:12px">' + table([
        { label: 'Showing', html: function (r) { return esc(new Date(r.starts_at).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })); } },
        { label: 'Peak viewers', key: 'peak_viewers', num: true, fmt: n },
        { label: 'Messages', key: 'messages', num: true, fmt: n },
        { label: 'Team', key: 'team_messages', num: true, fmt: n },
        { label: 'Call requests', key: 'raises', num: true, fmt: n },
      ], lv.showings) + '</div>' : '') + '</div>' : '';
    return roomHtml + engageHtml + webinarExperienceHtml(x) + liveHtml + '<div class="card" style="margin-top:14px"><h2>Minute by minute</h2><p class="sub">Share of live viewers with each minute of the masterclass on screen' + (w.replayViewers ? ' (dotted line: replay watchers)' : '') + '. The marker is the pitch at ' + esc(mins(x.pitchAtMin)) + '. ' +
      (w.liveViewers ? '<b>' + esc(pct(w.atPitch)) + '</b> of ' + n(w.liveViewers) + ' live viewers were still there when the offer came up.' : 'No one has watched live in this period yet.') + '</p>' +
      '<div class="chart" data-wcurve style="margin-top:8px"></div>' + (drops ? '<h3 class="h3" style="margin-top:12px">Where people leave</h3><ul class="plain-list">' + drops + '</ul>' : '') + '</div>' +
      '<div class="grid g-2" style="margin-top:14px">' +
      '<div class="card"><h2>Which time slot works</h2><p class="sub">Sessions grouped by day and time (' + esc(x.tz) + '). Book the slots that fill <i>and</i> show up.</p>' +
      table([{ label: 'Slot', html: function (r) { return '<strong>' + esc(r.key) + '</strong><div class="muted">' + n(r.sessions) + ' session' + (r.sessions === 1 ? '' : 's') + '</div>'; } }].concat(flow), x.slots || [], { cards: true }) + '</div>' +
      '<div class="card"><h2>What each group did next</h2><p class="sub">Live viewers, replay-only viewers and no-shows. Tells you where follow-up effort pays.</p>' +
      table([{ label: 'Group', html: function (r) { return '<strong>' + esc(r.key) + '</strong>'; } }, { label: 'People', key: 'regs', num: true, fmt: n }, { label: 'Clicked offer', key: 'cta', num: true, fmt: n },
        { label: 'Applied', num: true, html: function (r) { return esc(n(r.applied)) + '<div class="muted">' + esc(pct(r.regs ? r.applied / r.regs : null)) + '</div>'; } },
        { label: 'Booked', num: true, html: function (r) { return esc(n(r.booked)) + '<div class="muted">' + esc(pct(r.bookRate)) + '</div>'; } },
        { label: 'Won', key: 'won', num: true, fmt: n }], x.groups || []) + '</div></div>' +
      '<div class="card" style="margin-top:14px"><h2>Where registrants come from</h2><p class="sub">By platform and campaign. Spend shows when the campaign’s ad spend is in Traffic &amp; ads and its name matches the utm_campaign tag.</p>' +
      table([{ label: 'Campaign / source', html: function (r) { return '<strong>' + esc(r.campaign ? r.key : r.key + ' (no campaign tag)') + '</strong>' + (r.campaign ? '<div class="muted">' + esc(r.platforms) + '</div>' : ''); } }].concat(flow).concat([
        { label: 'Spend', num: true, html: function (r) { return r.spend ? esc(money(r.spend)) : '<span class="muted">–</span>'; } },
        { label: 'Per registrant', num: true, html: function (r) { return r.perReg != null ? esc(money(r.perReg)) : '–'; } },
        { label: 'Per $1M+ sign-up', num: true, html: function (r) { return r.perQualified != null ? esc(money(r.perQualified)) : '–'; } },
        { label: 'Per booked call', num: true, html: function (r) { return r.perBooked != null ? esc(money(r.perBooked)) : '–'; } },
      ]), x.sources || [], { cards: true }) + '</div>' +
      '<div class="card" style="margin-top:14px"><h2>Pre-webinar emails</h2><p class="sub">The daily emails between registering and the session: are people reading them, and do the ones who click show up more?</p>' +
      '<div class="grid g-4 tiles" style="margin-top:8px">' +
      tile('Emails sent', n(e.sent), n(e.registrants) + ' registrants got them') +
      tile('Opened', pct(e.openRate), 'clicked ' + pct(e.clickRate)) +
      tile('Show rate if they clicked one', pct(e.showIfClicked), n(e.clickedPeople) + ' people · vs ' + pct(e.showIfNot) + ' who didn’t') +
      tile('Unsubscribed', n(e.unsubscribed), 'registrants who opted out after registering', null, { zeroOk: true }) + '</div>' +
      ((e.byDay || []).length ? '<div style="margin-top:12px">' + table([
        { label: 'Days before the session', html: function (r) { return r.daysBefore === 0 ? 'Session day' : esc(r.daysBefore + ' day' + (r.daysBefore === 1 ? '' : 's') + ' before'); } },
        { label: 'Sent', key: 'sent', num: true, fmt: n }, { label: 'Opened', num: true, html: function (r) { return esc(pct(r.openRate)); } }, { label: 'Clicked', num: true, html: function (r) { return esc(pct(r.clickRate)); } },
      ], e.byDay) + '</div>' : '') + '</div>';
  }

  function drawWebinarCurve(el, x) {
    if (!el || !x || !x.watch) return;
    var w = x.watch;
    var pts = w.live.map(function (v, i) { return { label: 'Minute ' + i, short: i + 'm', value: v }; });
    var marker = Math.min(w.live.length - 1, Math.max(0, Math.round(x.pitchAtMin)));
    lineChart(el, pts, { fmt: function (v) { return pct(v); }, max: 1, height: 220, series: 'live', marker: marker, markerLabel: 'Pitch', label: 'Webinar retention, minute by minute', compare: w.replayViewers ? w.replay : null, compareLabel: 'replay' });
  }

  /**
   * Webinar tab → host console: the real live layer on top of the recorded masterclass. The room runs on its own
   * (viewer chat, AI answers, scheduled announcements); this is the optional extra for when someone from the team
   * wants to join a showing. While a showing is open here, its viewers see "Josh's team is in the room".
   */
  function renderHostConsole(box) {
    if (!box) return;
    var hostId = (function () { try { var v = localStorage.getItem('hq_host'); if (!v) { v = Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-4); localStorage.setItem('hq_host', v); } return v; } catch (e) { return 'tab' + Math.random().toString(36).slice(2, 12); } })();
    var openId = null, timer = null, pingTimer = null, last = {}, names = ['G&L team'];
    var nameKey = 'hq_host_name';
    var myName = function () { try { var v = localStorage.getItem(nameKey); return names.indexOf(v) >= 0 ? v : names[0]; } catch (e) { return names[0]; } };
    var clock = function (t) { return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
    var STAGE = function (s) { return s.stage === 'waiting' ? 'Starts in ' + Math.max(1, -s.minute) + ' min' : s.stage === 'running' ? 'Minute ' + s.minute : s.stage === 'after' ? 'Ended, room still open' : 'Closed'; };
    var alive = function () { return document.body.contains(box); };
    function stop() { clearTimeout(timer); clearInterval(pingTimer); if (openId) leave(openId); }
    function leave(id) { try { navigator.sendBeacon('/admin/api/webinar/live/s/' + encodeURIComponent(id) + '/leave', new Blob([JSON.stringify({ host: hostId })], { type: 'application/json' })); } catch (e) { /* ignore */ } }
    window.addEventListener('pagehide', function () { if (openId) leave(openId); });
    function set(sel, html) { var el = box.querySelector(sel); if (el && last[sel] !== html) { last[sel] = html; el.innerHTML = html; } return el; }
    function nameSelect(attr) { return '<select class="input hc-name" ' + attr + ' aria-label="Post as">' + names.map(function (nm) { return '<option' + (nm === myName() ? ' selected' : '') + '>' + esc(nm) + '</option>'; }).join('') + '</select>'; }

    // ── List of showings + autopilot moments ──
    function list() {
      if (!alive()) return stop();
      openId = null; clearInterval(pingTimer);
      return fetch('/admin/api/webinar/live', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
        if (!alive() || openId) return;
        names = d.hostNames || names;
        var rows = d.showings || [];
        last = {};
        box.innerHTML = '<div class="card hc" style="margin-bottom:14px"><div class="card-head"><div><h2>Host console</h2><p class="sub">The masterclass runs on its own: viewers chat with each other, the AI assistant answers questions, and the announcements you schedule below appear by themselves. Open a showing to join it. Its viewers see “Josh’s team is in the room” only while you have it open here.' + (d.chat ? '' : ' <b>The showing chat is off</b> (WEBINAR_CHAT in Integrations → Webinar).') + '</p></div></div>' +
          (rows.length ? table([
            { label: 'Showing', nw: true, html: function (s) { return '<strong>' + esc(clock(s.starts_at)) + '</strong><div class="muted">' + esc(STAGE(s)) + (s.auto === 2 ? ' · just-in-time' : '') + '</div>'; } },
            { label: 'Watching now', num: true, html: function (s) { return '<strong>' + n(s.viewers) + '</strong>' + (s.peak ? '<div class="muted">peak ' + n(s.peak) + '</div>' : ''); } },
            { label: 'Registered', key: 'registrations', num: true, fmt: n },
            { label: 'Chat', key: 'messages', num: true, fmt: n },
            { label: 'Call requests', num: true, html: function (s) { return s.raises ? '<span class="pill hc-hot">' + n(s.raises) + ' waiting</span>' : '<span class="muted">0</span>'; } },
            { label: '', html: function (s) { return (s.hosts ? '<span class="muted">team in the room · </span>' : '') + '<button type="button" class="btn-sm" data-hc-open="' + esc(s.id) + '">Open</button>'; } },
          ], rows, { cards: true }) : '<p class="muted hc-empty">No showing is running right now or starting in the next 15 minutes.</p>') +
          '<h3 class="h3" style="margin-top:16px">Scheduled announcements (every showing)</h3><p class="sub">A banner at a set minute of every showing, with an optional button, e.g. at minute 46: “Applications for strategy calls are open this week” with the apply link. Turn on “replay” to show it at that minute of the replay too.</p>' +
          ((d.auto || []).length ? table([
            { label: 'At', nw: true, html: function (a) { return 'minute ' + n(a.at_min) + '<div class="muted">for ' + n(a.minutes) + ' min' + (a.replay ? ' · also replay' : '') + '</div>'; } },
            { label: 'Announcement', html: function (a) { return esc(a.body) + (a.link_url ? '<div class="muted">' + esc(a.link_label || 'Open') + ' → ' + esc(a.link_url) + '</div>' : ''); } },
            { label: '', html: function (a) { return '<label class="check"><input type="checkbox" data-hc-auto-on="' + esc(a.id) + '"' + (a.active ? ' checked' : '') + '> on</label> <button type="button" class="btn-sm ghost" data-hc-auto-del="' + esc(a.id) + '">Delete</button>'; } },
          ], d.auto) : '') +
          '<form class="hc-form hc-auto" data-hc-auto><label>At minute <input class="input" name="at_min" type="number" min="0" max="120" required value="46"></label><label>For (min) <input class="input" name="minutes" type="number" min="1" max="120" value="10"></label>' +
          '<label class="hc-wide">Text <input class="input" name="text" maxlength="280" required placeholder="Applications for strategy calls are open this week."></label>' +
          '<label>Button link <input class="input" name="link_url" placeholder="https://…"></label><label>Button text <input class="input" name="link_label" maxlength="40" placeholder="Apply here"></label>' +
          '<label class="check"><input type="checkbox" name="replay" checked> also in the replay</label><button class="btn-sm" type="submit">Schedule</button> <span class="muted" data-hc-msg></span></form></div>';
        box.querySelectorAll('[data-hc-open]').forEach(function (b) { b.onclick = function () { show(b.getAttribute('data-hc-open')); }; });
        box.querySelectorAll('[data-hc-auto-on]').forEach(function (cb) { cb.onchange = function () { send('PUT', 'webinar/live/auto/' + encodeURIComponent(cb.getAttribute('data-hc-auto-on')), { active: cb.checked }); }; });
        box.querySelectorAll('[data-hc-auto-del]').forEach(function (b) { b.onclick = function () { if (confirm('Delete this scheduled announcement?')) fetch('/admin/api/webinar/live/auto/' + encodeURIComponent(b.getAttribute('data-hc-auto-del')), { method: 'DELETE', credentials: 'same-origin' }).then(list); }; });
        var af = box.querySelector('[data-hc-auto]');
        af.onsubmit = function (e) {
          e.preventDefault();
          send('POST', 'webinar/live/auto', { at_min: Number(af.at_min.value), minutes: Number(af.minutes.value), text: af.text.value, link_url: af.link_url.value.trim(), link_label: af.link_label.value, replay: af.replay.checked }).then(function (r) {
            if (r && r.ok) { toast('Scheduled'); list(); } else af.querySelector('[data-hc-msg]').textContent = (r && r.error) || 'Couldn’t save';
          });
        };
        clearTimeout(timer);
        // Fresh counts every 10 s, but never while someone is typing in the schedule form.
        var again = function () { if (openId) return; if (!alive()) return stop(); if (box.contains(document.activeElement) && document.activeElement !== document.body) timer = setTimeout(again, 10000); else list(); };
        timer = setTimeout(again, 10000);
      }).catch(function () { box.innerHTML = ''; });
    }

    // ── One showing ──
    function show(id) {
      openId = id; last = {}; clearTimeout(timer);
      box.innerHTML = '<div class="card hc hc-open"><div class="card-head"><div data-hc-head><h2>Showing</h2></div><button type="button" class="btn-sm ghost" data-hc-back>← All showings</button></div>' +
        '<div class="hc-grid">' +
        '<div class="hc-col"><h3 class="h3">Showing chat</h3><div class="hc-pinned" data-hc-pin></div><ol class="hc-chat" data-hc-chat></ol>' +
        '<form class="hc-form hc-say" data-hc-say>' + nameSelect('data-hc-name') + '<input class="input" name="text" maxlength="400" autocomplete="off" placeholder="Write to everyone in this showing" required><button class="btn-sm" type="submit">Send</button></form>' +
        '<h3 class="h3" style="margin-top:16px">Announce to this showing</h3><p class="sub">A banner at the top of the room. For a real live moment, e.g. “Josh is live now for 20 minutes of Q&amp;A” with the Zoom link.</p>' +
        '<form class="hc-form hc-ann" data-hc-ann><label class="hc-wide">Text <input class="input" name="text" maxlength="280" required placeholder="Josh is live now for 20 minutes of Q&amp;A."></label>' +
        '<label>Button link <input class="input" name="link_url" placeholder="https://zoom.us/j/…"></label><label>Button text <input class="input" name="link_label" maxlength="40" placeholder="Join here"></label>' +
        '<label>Show for (min) <input class="input" name="minutes" type="number" min="1" max="180" value="20"></label><button class="btn-sm" type="submit">Announce</button> <span class="muted" data-hc-amsg></span></form><div data-hc-anns></div></div>' +
        '<div class="hc-col"><div data-hc-raises></div><h3 class="h3">Questions from this showing</h3><p class="sub">The AI assistant answers straight away. A reply here goes privately to that viewer, in their question box, as “Answered by Josh’s team”.</p><div data-hc-qs></div>' +
        '<h3 class="h3" style="margin-top:16px">Viewers</h3><div data-hc-viewers></div></div></div></div>';
      box.querySelector('[data-hc-back]').onclick = function () { leave(id); list(); };
      box.querySelector('[data-hc-name]').onchange = function (e) { try { localStorage.setItem(nameKey, e.target.value); } catch (x) { /* ignore */ } };
      var say = box.querySelector('[data-hc-say]');
      say.onsubmit = function (e) {
        e.preventDefault();
        var t = say.text.value.trim(); if (!t) return;
        send('POST', 'webinar/live/s/' + encodeURIComponent(id) + '/chat', { text: t, name: say.querySelector('[data-hc-name]').value }).then(function (r) { if (r && r.ok) { say.text.value = ''; refresh(); } else toast((r && r.error) || 'Not sent'); });
      };
      var ann = box.querySelector('[data-hc-ann]');
      ann.onsubmit = function (e) {
        e.preventDefault();
        send('POST', 'webinar/live/s/' + encodeURIComponent(id) + '/announce', { text: ann.text.value, link_url: ann.link_url.value.trim(), link_label: ann.link_label.value, minutes: Number(ann.minutes.value), name: say.querySelector('[data-hc-name]').value }).then(function (r) {
          if (r && r.ok) { ann.reset(); ann.minutes.value = 20; toast('Announced'); refresh(); } else ann.querySelector('[data-hc-amsg]').textContent = (r && r.error) || 'Couldn’t announce';
        });
      };
      // Delegated actions on the refreshed lists.
      box.querySelector('.hc-grid').addEventListener('click', function (e) {
        var b = e.target.closest('button'); if (!b) return;
        if (b.hasAttribute('data-hc-pin-id')) send('POST', 'webinar/live/s/' + encodeURIComponent(id) + '/pin', { message_id: Number(b.getAttribute('data-hc-pin-id')) || null }).then(refresh);
        else if (b.hasAttribute('data-hc-del')) { if (confirm('Delete this message for everyone?')) fetch('/admin/api/webinar/live/chat/' + encodeURIComponent(b.getAttribute('data-hc-del')), { method: 'DELETE', credentials: 'same-origin' }).then(refresh); }
        else if (b.hasAttribute('data-hc-end')) fetch('/admin/api/webinar/live/announcements/' + encodeURIComponent(b.getAttribute('data-hc-end')), { method: 'DELETE', credentials: 'same-origin' }).then(refresh);
        else if (b.hasAttribute('data-hc-raise')) send('PUT', 'webinar/live/raises/' + encodeURIComponent(b.getAttribute('data-hc-raise')), { handled: true }).then(refresh);
        else if (b.hasAttribute('data-lead-open')) openLead(b.getAttribute('data-lead-open'));
      });
      box.querySelector('.hc-grid').addEventListener('submit', function (e) {
        var f = e.target.closest('[data-hc-reply]'); if (!f) return;
        e.preventDefault();
        send('POST', 'webinar/live/questions/' + encodeURIComponent(f.getAttribute('data-hc-reply')) + '/reply', { text: f.text.value, name: say.querySelector('[data-hc-name]').value }).then(function (r) { if (r && r.ok) { f.text.value = ''; toast('Reply sent to that viewer'); delete last['[data-hc-qs]']; refresh(); } else toast((r && r.error) || 'Not sent'); });
      });
      var ping = function () { if (!alive() || openId !== id) return clearInterval(pingTimer); send('POST', 'webinar/live/s/' + encodeURIComponent(id) + '/presence', { host: hostId }); };
      clearInterval(pingTimer); ping(); pingTimer = setInterval(ping, 15000);
      refresh();
    }

    function refresh() {
      var id = openId;
      if (!id) return;
      if (!alive()) return stop();
      clearTimeout(timer);
      return fetch('/admin/api/webinar/live/s/' + encodeURIComponent(id), { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
        if (!alive() || openId !== id || !d.session) return;
        var s = d.session, p = d.presence || {};
        set('[data-hc-head]', '<h2>' + esc(clock(s.starts_at)) + ' showing · ' + esc(STAGE(s)) + '</h2><p class="sub"><b>' + n(p.viewers) + '</b> watching now' + (p.replay ? ' · ' + n(p.replay) + ' on the replay' : '') + ' · peak ' + n(p.peak) + ' · ' + n(p.host) + ' from the team here (you included). Viewers see the count only when 3 or more are in.</p>');
        var chatEl = box.querySelector('[data-hc-chat]');
        var near = chatEl && chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 60;
        var pinned = (d.chat || []).filter(function (m) { return m.pinned && !m.deleted; })[0];
        set('[data-hc-pin]', pinned ? '<span class="muted">Pinned:</span> <b>' + esc(pinned.name) + '</b> ' + esc(pinned.body) + ' <button type="button" class="btn-sm ghost" data-hc-pin-id="0">Unpin</button>' : '');
        set('[data-hc-chat]', (d.chat || []).length ? d.chat.map(function (m) {
          return '<li class="hc-msg' + (m.author === 'team' ? ' team' : '') + (m.deleted ? ' deleted' : '') + '"><span class="hc-who">' + esc(m.name) + (m.author === 'team' ? ' <span class="pill">team</span>' : '') + '</span> <span class="muted">' + esc(clock(m.t)) + (m.at != null ? ' · min ' + Math.floor(m.at / 60) : '') + '</span>' +
            '<div class="hc-body">' + (m.deleted ? '<i class="muted">deleted</i>' : esc(m.body)) + '</div>' +
            (m.deleted ? '' : '<span class="hc-acts"><button type="button" class="btn-sm ghost" data-hc-pin-id="' + (m.pinned ? 0 : m.id) + '">' + (m.pinned ? 'Unpin' : 'Pin') + '</button><button type="button" class="btn-sm ghost" data-hc-del="' + m.id + '">Delete</button></span>') + '</li>';
        }).join('') : '<li class="muted">No messages in this showing yet.</li>');
        if (chatEl && near) chatEl.scrollTop = chatEl.scrollHeight;
        var anns = (d.announcements || []).filter(function (a) { return a.live; });
        set('[data-hc-anns]', anns.map(function (a) { return '<div class="hc-annlive"><span class="pill hc-hot">on now</span> ' + esc(a.body) + (a.link_url ? ' <span class="muted">→ ' + esc(a.link_url) + '</span>' : '') + ' <span class="muted">until ' + esc(clock(a.expires_at)) + '</span> <button type="button" class="btn-sm ghost" data-hc-end="' + esc(a.id) + '">End now</button></div>'; }).join(''));
        var rs = d.raises || [];
        set('[data-hc-raises]', rs.length ? '<h3 class="h3">Call requests</h3><div class="hc-raises">' + rs.map(function (h) {
          return '<div class="hc-raise' + (h.handled ? ' done' : '') + '"><b>' + esc(h.name) + '</b> · ' + esc(h.band || '') + ' · ' + (h.replay ? 'replay' : 'showing') + (h.minute != null ? ', minute ' + h.minute : '') + ' · ' + esc(clock(h.t)) +
            '<div class="muted">' + esc([h.phone, h.email].filter(Boolean).join(' · ')) + '</div>' +
            '<button type="button" class="btn-sm ghost" data-lead-open="' + esc(h.lead_id) + '">Open lead</button> ' + (h.handled ? '<span class="muted">handled</span>' : '<button type="button" class="btn-sm" data-hc-raise="' + esc(h.id) + '">Mark handled</button>') + '</div>';
        }).join('') + '</div>' : '');
        var qBox = box.querySelector('[data-hc-qs]');
        var typing = qBox && Array.prototype.some.call(qBox.querySelectorAll('input[name=text]'), function (i) { return i.value || i === document.activeElement; });
        if (!typing) set('[data-hc-qs]', (d.questions || []).length ? d.questions.map(function (q) {
          return '<div class="hc-q"><b>' + esc(q.name) + '</b> <span class="muted">' + esc(clock(q.t)) + (q.at != null ? ' · min ' + Math.floor(q.at / 60) : '') + '</span><p>' + esc(q.question) + '</p>' +
            (q.ai ? '<p class="muted small"><b>AI assistant:</b> ' + esc(q.ai) + '</p>' : '') +
            (q.team ? '<p class="small"><b>' + esc(q.teamBy || 'Team') + ' replied:</b> ' + esc(q.team) + '</p>' : '<form class="hc-form hc-reply" data-hc-reply="' + esc(q.id) + '"><input class="input" name="text" maxlength="1200" placeholder="Private reply to ' + esc(q.name) + '" required><button class="btn-sm" type="submit">Reply</button></form>') + '</div>';
        }).join('') : '<p class="muted">No questions in this showing yet.</p>');
        set('[data-hc-viewers]', table([
          { label: 'Viewer', html: function (v) { return '<span class="hc-dot' + (v.online ? ' on' : '') + '" title="' + (v.online ? 'in the room now' : 'not in the room') + '"></span><button type="button" class="linkish" data-lead-open="' + esc(v.lead_id) + '">' + esc(v.name) + '</button>'; } },
          { label: 'Revenue', html: function (v) { return esc(v.bandLabel || v.band || '–') + (v.band && !v.qualified ? ' <span class="muted">· under $1M</span>' : ''); } },
          { label: 'Reached', num: true, html: function (v) { return v.joined || v.minute ? 'min ' + n(v.minute) : '<span class="muted">not yet</span>'; } },
          { label: 'Poll answers', html: function (v) { return v.polls.length ? v.polls.map(esc).join('<br>') : '<span class="muted">–</span>'; } },
        ], d.viewers || [], { cards: true }));
        timer = setTimeout(refresh, 4000);
      }).catch(function () { timer = setTimeout(refresh, 8000); });
    }
    list();
  }

  /** Webinar tab: the paid offer (Acquisition Assessment by default) and the optional paid seat. */
  function webinarPassHtml(p) {
    if (!p || !p.config) return '';
    var c = p.config, k = p.kpis || {}, ch = p.checklist || {}, cap = p.capacity || {};
    var MODE = { off: 'Off', upsell: 'Upsell', required: 'Required' };
    var ok = function (b, yes, no) { return '<li class="' + (b ? 'ok' : 'todo') + '"><span>' + (b ? '✓' : '·') + '</span><div class="small">' + (b ? yes : no) + '</div></li>'; };
    var modeLine = c.mode === c.requested ? MODE[c.mode] : MODE[c.requested] + ' (running as Off)';
    return '<div class="card" style="margin-top:14px" data-pass-hq><div class="card-head"><div><h2>' + esc(c.offerName) + '</h2><p class="sub">The paid offer in the masterclass: ' + esc(c.priceLabel) + ' ' + esc(c.currency) +
      ', credited against the advisory engagement if they continue. ' + (c.weeklyCap ? 'Capped at ' + n(c.weeklyCap) + ' a week.' : 'No weekly cap.') + (c.seat ? ' Paid seat: ' + esc(c.seat) + '.' : '') + '</p></div>' +
      '<span class="pill">' + esc(modeLine) + '</span></div>' +
      (c.reason ? '<div class="card notice" style="margin:10px 0">' + esc(c.reason) + '</div>' : '') +
      (p.whop && p.whop.notes ? p.whop.notes.map(function (x) { return '<div class="card notice" style="margin:10px 0" data-whop-note="' + esc(x.level) + '">' + esc(x.text) + '</div>'; }).join('') : '') +
      '<div class="grid g-4 tiles" style="margin-top:8px">' +
      tile('Sold', n(k.sold), pct(k.conversion, 1) + ' of ' + n(k.registrants) + ' registrants', null, { zeroOk: true }) +
      tile('Revenue', k.revenueLabel || '–', 'after refunds · ' + (k.creditLabel || '–') + ' credit owed against engagements', null, { zeroOk: true }) +
      tile('Refunds', n(k.refunds), k.openCheckouts ? n(k.openCheckouts) + ' checkout' + (k.openCheckouts === 1 ? '' : 's') + ' open now' : 'no open checkouts', null, { zeroOk: true }) +
      tile('This week', cap.capped ? n(cap.left) + ' of ' + n(cap.cap) + ' left' : 'No cap', cap.capped ? n(cap.used) + ' sold or in checkout since Monday' : 'set a weekly cap under Integrations → Webinar', null, { zeroOk: true }) +
      '</div>' +
      (c.seat || k.seats ? '<h3 class="h3" style="margin-top:14px">Masterclass tickets' + (c.seat ? ' · ' + esc(c.seat) : '') + '</h3><div class="grid g-4 tiles" data-ticket-hq>' +
        tile('Tickets sold', n(k.ticketsSold), 'paid, after refunds', null, { zeroOk: true }) +
        tile('Ticket revenue', k.ticketRevenueLabel || '–', 'after refunds', null, { zeroOk: true }) +
        tile('Unpaid registrations', n(k.unpaidRegistrations), 'of ' + n(k.requiredRegistrants) + ' who needed a ticket' + (k.ticketOpenCheckouts ? ' · ' + n(k.ticketOpenCheckouts) + ' in checkout now' : ''), null, { zeroOk: true }) +
        tile('Ticket refunds', n(k.ticketRefunds), 'refund in Stripe; the room closes again', null, { zeroOk: true }) +
        '</div>' : '') +
      '<div class="grid g-2" style="margin-top:12px"><div><h3 class="h3">Buyers</h3>' +
      ((p.holders || []).length ? table([
        { label: 'Name', html: function (r) { return '<strong>' + esc(r.name) + '</strong>' + (r.status === 'refunded' ? ' <span class="pill">refunded</span>' : '') + '<div class="muted">' + esc(r.email || '') + '</div>'; } },
        { label: 'Revenue', html: function (r) { return esc(r.band || '–'); } },
        { label: 'Paid', html: function (r) { return esc(r.paid) + (r.credit ? '<div class="muted">' + esc(r.credit) + ' credit</div>' : ''); } },
        { label: 'Pack', html: function (r) { return r.pack_viewed_at ? '✓ opened' : '<span class="muted">not yet</span>'; } },
        { label: 'Session booked?', html: function (r) { return r.status === 'refunded' ? '' : '<label class="check"><input type="checkbox" data-pbooked="' + esc(r.id) + '"' + (r.review_booked_at ? ' checked' : '') + '> booked</label>' + (r.review_clicked_at && !r.review_booked_at ? '<div class="muted">opened the link</div>' : ''); } },
      ], p.holders, { cards: true, rowAttr: function (r) { return 'data-lead-row="' + esc(r.lead_id) + '"'; } }) : '<p class="muted">No one has bought yet.</p>') + '</div>' +
      '<div><h3 class="h3">Setup</h3><ul class="checklist">' +
      ok(ch.secretKey, (ch.providerName || 'Stripe') + ' key added' + (ch.testMode ? ' (test mode)' : ''), 'Add the Whop API key, or the Stripe secret key (Integrations → Webinar)') +
      ok(ch.webhookSecret, 'Webhook signing secret added', 'Add the webhook signing secret' + (ch.provider === 'whop' ? ' (Integrations → Connect Whop does it)' : '') + '. Without it payments still confirm when buyers come back from ' + esc(ch.providerName || 'Stripe') + ', but refunds and closed tabs are missed.') +
      ok(c.requested !== 'off', 'Mode: ' + esc(MODE[c.requested]), 'Set the paid offer to upsell or required') +
      ok(ch.sessionUrl, 'Assessment session booking link set', 'Optional: add the session booking link, otherwise email each buyer to book') +
      '</ul><p class="small" style="margin-top:8px">' + (ch.provider === 'whop' ? 'In Whop → Dashboard → Developer → Create webhook (or press Connect Whop on Integrations), use:' : 'In Stripe → Developers → Webhooks → Add endpoint, paste:') + '</p>' +
      '<p><code style="word-break:break-all">' + esc(ch.webhookUrl) + '</code> <button type="button" class="btn-sm ghost" data-copy="' + esc(ch.webhookUrl) + '">Copy</button></p>' +
      '<p class="small">and select these events: ' + (ch.events || []).map(function (e) { return '<code style="word-break:break-all">' + esc(e) + '</code>'; }).join(', ') + '.</p>' +
      '<p class="small muted">Includes: ' + esc((c.perks || []).join(' · ')) + (c.customPerks ? ' (your own list)' : '') + '</p></div></div></div>';
  }

  function renderWebinar() {
    return Promise.all([api('webinar'), api('webinar/insights').catch(function () { return null; }), api('webinar/pass').catch(function () { return null; })]).then(function (both) {
      var d = both[0], ins = both[1], pass = both[2];
      var k = d.kpis || {}, st = d.settings || {};
      var regs = k.registrations || 0;
      var when = function (t) { return new Date(t).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); };
      var MODE = { evergreen: 'Recording in sync', stream: 'Live in our room', live: 'Live on Zoom' };
      var mins = function (s) { return s ? Math.round(s / 60) + ' min' : '–'; };
      view.innerHTML = '<div data-hostconsole></div>' +
        (st.placeholderVideo ? '<div class="card notice" style="margin-bottom:14px"><strong>Using the VSL as a placeholder recording.</strong> Add your webinar recording under Integrations → Webinar (WEBINAR_VIDEO_SRC).</div>' : '') +
        '<div class="grid g-4 tiles">' +
        tile('Registrations', n(regs), n(k.people) + (k.people === 1 ? ' person' : ' people')) +
        tile('Show rate', pct(regs ? (k.attended || 0) / regs : null), n(k.attended) + ' attended · ' + n(k.replays) + ' watched the replay') +
        tile('Avg time watched', mins(k.avg_watch_s), 'of attendees') +
        tile('Clicked the offer', n(k.cta), pct(k.attended ? (k.cta || 0) / k.attended : null) + ' of attendees') +
        '</div><div class="grid g-4 tiles" style="margin-top:14px">' +
        tile('Applied', n(k.applied), pct(regs ? (k.applied || 0) / regs : null) + ' of registrants') +
        tile('Booked a call', n(k.booked), pct(regs ? (k.booked || 0) / regs : null) + ' of registrants') +
        tile('Won', n(k.won), money(k.revenue)) +
        tile('Weekly sessions', st.schedule || '–', (st.tz || '') + ' · ' + String(st.url || '').replace(/^https?:\/\//, '')) +
        '</div><div class="grid g-4 tiles" style="margin-top:14px">' +
        tile('Financial model', 'Open', 'Cost per registrant, per call and per client, and what the webinar makes per dollar of ads', 'finance') +
        '</div>' + webinarPassHtml(pass) +
        '<div class="grid g-2" style="margin-top:14px">' +
        '<div class="card"><h2>Upcoming sessions</h2><p class="sub">Weekly sessions are created automatically from the schedule in Integrations → Webinar. Add a one-off or live session below.</p>' +
        table([
          { label: 'Starts', nw: true, html: function (r) { return esc(when(r.starts_at)) + (r.status === 'cancelled' ? ' <span class="pill">cancelled</span>' : ''); } },
          { label: 'Type', html: function (r) { return esc(MODE[r.mode] || r.mode) + (r.auto ? ' <span class="muted">· weekly</span>' : ''); } },
          { label: 'Registered', key: 'registrations', num: true, fmt: n },
          { label: '', html: function (r) { return r.status === 'cancelled' ? '' : (r.mode !== 'evergreen' ? '<a class="btn-sm ghost" href="/admin/live/' + encodeURIComponent('webinar:' + r.id) + '" target="_blank" rel="noopener">Host console</a> ' : '') + '<button class="btn-sm ghost" data-cancel="' + esc(r.id) + '">Cancel &amp; move people</button>'; } },
        ], d.upcoming || [], { cards: true }) +
        '<form class="wform" data-wform style="margin-top:14px"><h3 class="h3">Add a session</h3>' +
        '<label>Date &amp; time <input class="input" type="datetime-local" name="starts_at" required></label>' +
        '<label>Type <select class="input" name="mode"><option value="evergreen">Recording played in sync</option><option value="live">Live on Zoom (join link)</option><option value="stream">Live in our own room (stream URL)</option></select></label>' +
        '<label data-joinwrap hidden>Join link <input class="input" name="join_url" placeholder="https://zoom.us/j/…"><span class="muted small">With Zoom connected (Integrations → Zoom), leave it blank and the meeting is created for you. You can also add it later in the session’s host console.</span></label>' +
        '<label>Title (optional) <input class="input" name="title" maxlength="120" placeholder="' + esc(st.title) + '"></label>' +
        '<button class="btn-sm" type="submit">Add session</button> <span class="muted" data-wmsg></span></form></div>' +
        '<div class="card"><h2>Past sessions</h2><p class="sub">Show rate, how far people watched, and what they did next.</p>' +
        table([
          { label: 'Session', html: function (r) { return esc(when(r.starts_at)); } },
          { label: 'Reg.', key: 'registrations', num: true, fmt: n },
          { label: 'Came', html: function (r) { return n(r.attended) + ' <span class="muted">' + pct(r.registrations ? r.attended / r.registrations : null) + '</span>'; } },
          { label: 'Avg reached', html: function (r) { return mins(r.avg_pos); } },
          { label: 'Offer', key: 'cta', num: true, fmt: n },
          { label: 'Applied', key: 'applied', num: true, fmt: n },
          { label: 'Booked', key: 'booked', num: true, fmt: n },
        ], d.past || []) + '</div></div>' +
        webinarInsightsHtml(ins, st.url) +
        '<div class="card" style="margin-top:14px"><h2>Registrants</h2><p class="sub">Click a row for the full journey.</p>' +
        table([
          { label: 'Name', html: function (r) { return esc([r.first_name, r.last_name].filter(Boolean).join(' ') || '–') + '<br><span class="muted">' + esc(r.email || '') + '</span>'; } },
          { label: 'Session', html: function (r) { return esc(when(r.starts_at)); } },
          { label: 'Source', html: function (r) { return esc([where(r.channel, r.utm_source, r.referrer_host, r.utm_medium), r.utm_campaign].filter(Boolean).join(' / ')); } },
          { label: 'Came', html: function (r) { return r.joined_at ? '✓ ' + mins(r.watch_seconds) : r.replay_at ? 'replay' : '–'; } },
          { label: 'Offer', html: function (r) { return r.cta_at ? '✓' : ''; } },
          { label: 'Readiness', num: true, html: function (r) { return r.readiness != null ? '<strong>' + esc(n(r.readiness)) + '</strong>' + (r.readiness_gap ? '<div class="muted">gap: ' + esc(r.readiness_gap) + '</div>' : '') : '<span class="muted">–</span>'; } },
          { label: 'Blueprint', html: function (r) { return r.token && (r.has_blueprint || r.joined_at || r.replay_at) ? '<a href="' + esc(String(st.url || '') + '/blueprint/' + r.token) + '" target="_blank" rel="noopener" data-stop>' + (r.has_blueprint ? 'Open' : 'Build') + ' ↗</a>' : ''; } },
          { label: 'Next', html: function (r) { return r.status === 'won' ? statusPill('won') : r.booked_at ? statusPill('booked') : r.app_completed_at ? statusPill('applied', 'applied' + (r.tier ? ' (' + r.tier + ')' : '')) : ''; } },
        ], d.registrants || [], { rowAttr: function (r) { return 'class="click" data-lead="' + esc(r.lead_id) + '" tabindex="0"'; } }) + '</div>';
      view.querySelectorAll('[data-lead]').forEach(function (row) { row.onclick = function () { openLead(row.getAttribute('data-lead')); }; });
      view.querySelectorAll('[data-stop]').forEach(function (a) { a.onclick = function (e) { e.stopPropagation(); }; });
      drawWebinarCurve(view.querySelector('[data-wcurve]'), ins);
      view.querySelectorAll('[data-buyin-hide]').forEach(function (cb) {
        cb.onclick = function (e) { e.stopPropagation(); };
        cb.onchange = function () { send('PUT', 'webinar/buyin/' + encodeURIComponent(cb.getAttribute('data-buyin-hide')), { hidden: cb.checked }); };
      });
      renderHostConsole(view.querySelector('[data-hostconsole]'));
      view.querySelectorAll('[data-pbooked]').forEach(function (cb) {
        cb.onchange = function () { send('PUT', 'webinar/pass/' + encodeURIComponent(cb.getAttribute('data-pbooked')), { review_booked: cb.checked }); };
      });
      view.querySelectorAll('[data-copy]').forEach(function (b) {
        b.onclick = function () { try { navigator.clipboard.writeText(b.getAttribute('data-copy')); toast('Copied'); } catch (e) { /* ignore */ } };
      });
      view.querySelectorAll('[data-qdone]').forEach(function (cb) {
        cb.onchange = function () { send('PUT', 'webinar/questions/' + encodeURIComponent(cb.getAttribute('data-qdone')), { handled: cb.checked }); };
      });
      view.querySelectorAll('[data-whl]').forEach(function (b) {
        b.onclick = function () {
          var m = b.getAttribute('data-whl');
          if (m !== 'auto' && m !== 'even' && !confirm('Show only this headline to every new visitor? You can switch back to Auto any time.')) return;
          b.disabled = true;
          send('PUT', 'integrations', { WEBINAR_HEADLINE_TEST: m }).then(function () { toast('Headline test: ' + m); setTimeout(load, 300); });
        };
      });
      view.querySelectorAll('[data-cancel]').forEach(function (b) {
        b.onclick = function () {
          if (!confirm('Cancel this session? Everyone registered is moved to the next session and emailed a new link.')) return;
          fetch('/admin/api/webinar/sessions/' + encodeURIComponent(b.getAttribute('data-cancel')), { method: 'DELETE', credentials: 'same-origin' }).then(function () { load(); });
        };
      });
      var f = view.querySelector('[data-wform]');
      f.mode.onchange = function () { f.querySelector('[data-joinwrap]').hidden = f.mode.value !== 'live'; };
      f.onsubmit = function (e) {
        e.preventDefault();
        var t = new Date(f.starts_at.value).getTime();
        send('POST', 'webinar/sessions', { starts_at: t, mode: f.mode.value, join_url: f.join_url.value, title: f.title.value }).then(function (r) {
          if (r && r.ok) { if (r.zoom) toast(r.zoom.ok ? 'Zoom ' + r.zoom.kind + ' created' : 'Session added. Zoom: ' + r.zoom.error + ' Paste a link in its host console.'); load(); } else f.querySelector('[data-wmsg]').textContent = (r && r.error) || 'Couldn’t add the session';
        });
      };
    });
  }

  /** "Needs attention" strip on Overview: the few things worth doing today, each a link. */
  function attentionHtml(k, sl, extra) {
    var chips = [], x = extra || {};
    if (sl && sl.needsOutcome && sl.needsOutcome.length) {
      var c = sl.needsOutcome.length;
      chips.push('<a class="chip warn" href="#sales" data-go="sales"><b>' + esc(n(c)) + '</b> ' + (c === 1 ? 'past call needs an outcome' : 'past calls need an outcome') + '</a>');
    }
    if (sl && sl.upcoming && sl.upcoming.length) {
      var u = sl.upcoming[0];
      var rep = u.closer_id ? reps().filter(function (r) { return r.id === u.closer_id; })[0] : null;
      chips.push('<a class="chip" href="#lead=' + esc(u.id) + '" data-open="' + esc(u.id) + '">' + esc('Next call: ' + when(u.call_at) + ' · ' + personName(u) + (rep ? ' with ' + rep.name : '')) + '</a>');
    }
    var aOpen = x.aOpen || 0, partial = x.partial || 0;
    if (aOpen > 0) chips.push('<a class="chip warn" href="#leads" data-go="leads" data-tier="A" data-status="applied"><b>' + esc(n(aOpen)) + '</b> A-tier ' + (aOpen === 1 ? 'lead hasn’t' : 'leads haven’t') + ' booked yet</a>');
    if (partial > 0) chips.push('<a class="chip" href="#leads" data-go="leads" data-status="partial"><b>' + esc(n(partial)) + '</b> unfinished ' + (partial === 1 ? 'application' : 'applications') + ' to chase</a>');
    if (x.simEmails) chips.push('<a class="chip" href="#integrations" data-go="integrations">Emails aren’t really sending yet: connect them</a>');
    if (!chips.length) return '<div class="attention calm" data-attention><span class="status-dot" style="background:var(--good)" aria-hidden="true"></span> All caught up: no calls to log and no hot leads waiting.</div>';
    return '<div class="attention" data-attention><span class="attention-h">Needs attention</span>' + chips.join('') + '</div>';
  }

  /** "vs previous period" line for a count tile: ▲ 12% / ▼ 8% / flat. Null when there's nothing honest to compare. */
  function periodLabel() { return state.days === 1 ? 'day' : state.days + ' days'; }
  function dCount(cur, prev) {
    if (prev == null) return null;
    cur = Number(cur) || 0; prev = Number(prev) || 0;
    if (prev === 0) return cur ? { text: 'none in prev ' + periodLabel(), dir: 'flat' } : null; // nothing to compare with: say so quietly
    var ch = (cur - prev) / prev;
    if (!isFinite(ch)) return null;
    if (Math.abs(ch) < 0.02) return { text: 'no change vs prev ' + periodLabel(), dir: 'flat' };
    return { text: (ch > 0 ? '▲ ' : '▼ ') + pct(Math.abs(ch)) + ' vs prev ' + periodLabel(), dir: ch > 0 ? 'up' : 'down' };
  }
  /** Same for a rate tile, in percentage points. */
  function dRate(cur, prev) {
    if (cur == null || prev == null || !isFinite(cur) || !isFinite(prev)) return null;
    var raw = (cur - prev) * 100, pts = Math.abs(raw) < 1 ? Math.round(raw * 10) / 10 : Math.round(raw); // small rates keep one decimal
    if (!pts) return { text: 'no change vs prev ' + periodLabel(), dir: 'flat' };
    return { text: (pts > 0 ? '+' : '−') + Math.abs(pts) + ' pts vs prev ' + periodLabel(), dir: pts > 0 ? 'up' : 'down' };
  }

  function renderOverview() {
    var r = range();
    var cheap = { page: 0, sort: 'created', channel: state.filters.channel || '', from: r.from, to: r.to }; // same query the Leads tab runs
    var withPrev = state.days < 3650;
    return Promise.all([
      api('overview'), api('sales').catch(function () { return null; }),
      fetchLeads(Object.assign({ tier: 'A', status: 'applied' }, cheap)).catch(function () { return null; }),
      fetchLeads(Object.assign({ status: 'partial' }, cheap)).catch(function () { return null; }),
      withPrev ? api('overview', { from: Math.max(1, r.from - (r.to - r.from)), to: r.from }).catch(function () { return null; }) : null,
    ]).then(function (res) {
      var d = res[0], sl = res[1];
      var k = d.kpis;
      var pk = res[4] && res[4].kpis ? res[4].kpis : null;
      var dc = function (f) { return pk ? dCount(k[f], pk[f]) : null; };
      // A rate compared with a period that had no visitors at all isn't a change, it's an absence: show nothing.
      var dr = function (f) { return pk && Number(pk.visitors) > 0 ? dRate(k[f], pk[f]) : null; };
      if (sl && sl.needsOutcome) setNavBadge('sales', sl.needsOutcome.length);
      var unlogged = sl && sl.needsOutcome ? sl.needsOutcome.length : 0;
      // Every email in range was only simulated (no email provider connected): rates would read a meaningless 0%. Older APIs lack the fields → normal card.
      var simOnly = k.emails_simulated > 0 && k.emails_real === 0;
      var last = d.funnel.length - 1;
      var funnelRows = d.funnel.map(function (s, i) {
        var row = { name: s.label, value: s.n, note: i ? pct(d.funnel[0].n ? s.n / d.funnel[0].n : 0) + ' of landing' : '', rate: null };
        if (i < last && s.n > 0) {
          var nx = d.funnel[i + 1].n;
          if (nx > s.n) { row.rate = pct(nx / s.n) + ' reach the next step · some people skip this step'; row.rateTitle = 'More people reached the next step than this one: steps are tracked separately, so not everyone passes through each one.'; }
          else { row.rate = pct(nx / s.n) + ' continue'; row.rateWarn = nx / s.n < 0.5; }
        }
        return row;
      });
      // Booked → next step: past calls with no outcome logged count as "not continuing" until someone logs them, so don't flag that as a real drop.
      var bookRow = funnelRows.filter(function (row) { return /book/i.test(row.name); })[0];
      if (unlogged > 0 && bookRow && bookRow.rate) {
        bookRow.rateWarn = false;
        bookRow.rate += ' · ' + n(unlogged) + (unlogged === 1 ? ' call' : ' calls') + ' not logged yet';
        bookRow.rateTitle = 'Calls that have passed without an outcome count as not continuing until they are logged on Calls & deals.';
      }
      view.innerHTML =
        attentionHtml(k, sl, { aOpen: (res[2] && res[2].total) || 0, partial: (res[3] && res[3].total) || 0, simEmails: simOnly }) +
        '<div class="grid g-4 tiles">' +
        tile('Visitors', n(k.visitors), n(k.sessions) + ' sessions · ' + pct(k.bounce_rate) + ' bounce', 'traffic', dc('visitors')) +
        tile('VSL play rate', pct(k.play_rate), pct(k.unmute_rate) + ' unmuted · avg ' + pct(k.avg_watch_pct) + ' watched', 'vsl', dr('play_rate')) +
        tile('Applications', n(k.applications), n(k.leads) + ' leads · ' + pct(k.app_completion_rate) + ' finish the form', 'application', dc('applications')) +
        tile('Calls booked', n(k.booked), 'booked in range · ' + pct(k.booking_rate) + ' of qualified · ' + pct(k.show_rate) + ' show rate' + (unlogged ? ' · ' + n(unlogged) + ' not logged' : ''), 'sales', dc('booked')) +
        '</div><div class="grid g-4 tiles" style="margin-top:14px">' +
        tile('Opt-in rate', pct(k.opt_in_rate, 1), 'Contact details / landing visitors', 'application', dr('opt_in_rate')) +
        tile('Pitch reached', pct(k.pitch_rate), 'Of plays reach the CTA moment', 'vsl', dr('pitch_rate')) +
        tile('Revenue', money(k.revenue), n(k.won) + ' won · ' + money(k.revenue_per_visitor) + ' / visitor', 'sales', dc('revenue')) +
        tile('WhatsApp', n(k.whatsapp_clicks) + ' clicks', n(k.whatsapp_connected) + ' connected via ref code', 'sms') +
        '</div>' +
        '<div class="grid g-2 g-top" style="margin-top:14px">' +
        '<div class="card"><div class="card-head"><div><h2>Funnel</h2><p class="sub">Unique people reaching each step in this range.</p></div><a class="btn-sm ghost" href="#map" data-go="map">See it on the map →</a></div>' + barList(funnelRows, { cls: 'funnel' }) + '</div>' +
        '<div class="grid" style="align-content:start"><div class="card"><div class="card-head"><div><h2>Lead quality</h2><p class="sub">Applications by routing tier · average score ' + n(k.avg_score) + '</p></div><a class="card-link" href="#insights" data-go="insights">Who they are →</a></div>' + tierStack(k.tier_a, k.tier_b, k.tier_c) + '</div>' +
        // Nothing really sent yet: no empty rate boxes, just one quiet line and the way to connect it.
        (simOnly ? '<div class="card"><div class="card-head"><div><h2>Email</h2><p class="sub">' + esc(n(k.emails_sent) + ' written · none actually sent yet (email not connected)') + '</p></div><a class="btn-sm ghost" href="#integrations" data-go="integrations">Connect email →</a></div>' +
          '<p class="muted email-wait">Open and click rates appear here once emails send for real. <a class="card-link" href="#emails" data-go="emails">See the emails →</a></p></div></div>'
          : '<div class="card"><h2>Email</h2><p class="sub">' + n(k.emails_sent) + ' sent in range</p><div class="grid g-2 tiles">' +
          tile('Open rate', pct(k.email_open_rate), 'iPhones auto-open some emails, so this runs high', 'emails') + tile('Click rate', pct(k.email_click_rate), null, 'emails') + '</div></div></div>') +
        '</div>' +
        '<h3 class="section-title">Daily trend</h3><div class="grid g-2" data-daily></div>';
      var dailyEl = view.querySelector('[data-daily]');
      [['visitors', 'Landing visitors'], ['plays', 'VSL plays'], ['applications', 'Applications'], ['booked', 'Calls booked']].forEach(function (m) {
        var card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = '<h2>' + esc(m[1]) + '</h2><p class="sub">Per day</p><div class="chart"></div>';
        dailyEl.appendChild(card);
        var pts = d.daily.map(function (r) { var dt = new Date(r.day + 'T00:00:00'); return { label: dt.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }), short: dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), value: r[m[0]] }; });
        lineChart(card.querySelector('.chart'), pts, { series: m[1], label: m[1] + ' per day', height: 150 });
      });
    });
  }

  function renderVsl() {
    var videos = (state.meta && state.meta.videos) || [{ id: 'vsl-main' }];
    var video = state.video || videos[0].id;
    return api('vsl', { video: video }).then(function (d) {
      var s = d.summary || {};
      var dur = s.duration || 0;
      view.innerHTML =
        '<div class="row" style="margin-bottom:12px"><div class="seg" data-video>' + videos.map(function (v) { return '<button data-v="' + esc(v.id) + '" aria-pressed="' + (v.id === video) + '">' + esc(v.id.replace('vsl-', '')) + '</button>'; }).join('') + '</div></div>' +
        '<div class="grid g-4 tiles">' + tile('Views (with sound)', n(s.views), n(s.viewers) + ' unique viewers') + tile('Avg watched', pct(s.avg_pct), secs(s.avg_seconds) + ' average watch time') +
        tile('Reached the pitch', pct(s.reveal_rate), d.ctaRevealAt ? 'CTA reveals at ' + secs(d.ctaRevealAt) : 'CTA shown immediately') + tile('Clicked the CTA', pct(s.cta_rate), pct(s.completion_rate) + ' watched to the end') + '</div>' +
        '<div class="card" style="margin-top:14px"><h2>Audience retention</h2><p class="sub">Share of views still watching at each point of the video' + (dur ? ' (' + secs(dur) + ' long)' : '') + '. The line marks the pitch.</p><div class="chart" data-ret></div></div>' +
        '<div class="grid g-2" style="margin-top:14px"><div class="card"><h2>Biggest drop-offs</h2><p class="sub">Where the most viewers leave — re-edit these moments first.</p>' +
        table([{ label: 'Moment', html: function (r) { return esc(r.second != null ? secs(r.second) : r.pct + '%') + ' <span class="muted">(' + r.pct + '%)</span>'; } }, { label: 'Viewers lost', num: true, fmt: function (v) { return pct(v, 1); }, key: 'drop' }], d.drops.filter(function (x) { return x.drop > 0; })) + '</div>' +
        '<div class="card"><h2>By headline variant & device</h2><p class="sub">Does the hook change how long people watch?</p>' +
        table([{ label: 'Variant', key: 'key' }, { label: 'Views', key: 'views', num: true, fmt: n }, { label: 'Avg watched', key: 'avg_pct', num: true, fmt: function (v) { return pct(v); } }, { label: 'Pitch', key: 'reveal_rate', num: true, fmt: function (v) { return pct(v); } }, { label: 'CTA', key: 'cta_rate', num: true, fmt: function (v) { return pct(v); } }], d.byVariant) +
        '<div style="height:12px"></div>' +
        table([{ label: 'Device', key: 'key' }, { label: 'Views', key: 'views', num: true, fmt: n }, { label: 'Avg watched', key: 'avg_pct', num: true, fmt: function (v) { return pct(v); } }, { label: 'Unmuted', key: 'unmute_rate', num: true, fmt: function (v) { return pct(v); } }], d.byDevice) + '</div></div>';
      var pts = d.retention.map(function (v, i) { var sec = dur ? Math.round((i / 100) * dur) : null; return { label: (sec != null ? secs(sec) + ' · ' : '') + i + '% through', short: sec != null ? secs(sec) : i + '%', value: v }; });
      var marker = dur && d.ctaRevealAt ? Math.round((d.ctaRevealAt / dur) * 100) : null;
      lineChart(view.querySelector('[data-ret]'), pts, { fmt: function (v) { return pct(v); }, max: 1, height: 240, series: 'still watching', marker: marker, markerLabel: 'Pitch / CTA', label: 'Audience retention', endLabel: true });
      view.querySelectorAll('[data-video] button').forEach(function (b) { b.onclick = function () { state.video = b.getAttribute('data-v'); load(); }; });
    });
  }

  function renderTraffic() {
    var dims = (state.meta && state.meta.dimensions) || [{ key: 'channel', label: 'Channel' }];
    var dim = state.dim || 'platform';
    return Promise.all([api('attribution', { dim: dim }), api('ads').catch(function () { return null; })]).then(function (both) {
      var d = both[0], ads = both[1];
      var rows = d.rows;
      var maxQ = Math.min(1, Math.max.apply(null, rows.map(function (r) { return r.qualified_rate || 0; }).concat([0.0001])));
      view.innerHTML =
        '<div class="row" style="margin-bottom:12px"><label class="muted" for="dim">Break down by</label><select id="dim" class="input" data-dim>' + dims.map(function (x) { return '<option value="' + esc(x.key) + '"' + (x.key === dim ? ' selected' : '') + '>' + esc(x.label) + '</option>'; }).join('') + '</select><span class="spacer"></span><span class="muted">Leads are attributed to their last non-direct touch before applying.</span></div>' +
        adSpendHtml(ads) +
        '<div class="card" style="margin-top:14px"><h2>Every source</h2><p class="sub">All traffic, paid and free, followed to qualified leads and cash.</p>' + table([
          { label: d.label, html: function (r) { return '<strong>' + esc(r.key) + '</strong>'; } },
          { label: 'Visitors', key: 'visitors', num: true, fmt: n },
          { label: 'Bounce', key: 'bounce_rate', num: true, zeroOk: true, fmt: function (v) { return pct(v); } },
          { label: 'Engaged', key: 'avg_engaged_s', num: true, fmt: secs },
          { label: 'Leads', key: 'leads', num: true, fmt: n },
          { label: 'Apps', key: 'applications', num: true, fmt: n },
          { label: 'Qualified', key: 'qualified', num: true, fmt: n },
          { label: 'Qualified / visitor', num: true, html: function (r) { var q = r.qualified_rate || 0; return (q > 1 ? '<span title="Includes leads who booked directly without a tracked visit">100%+</span>' : esc(pct(q, 1))) + '<span class="inbar" style="width:' + Math.round((Math.min(1, q) / maxQ) * 50) + 'px"></span>'; } },
          { label: 'Avg score', key: 'avg_score', num: true, fmt: n },
          { label: 'Booked', key: 'booked', num: true, fmt: n },
          { label: 'Showed', key: 'showed', num: true, fmt: n },
          { label: 'Won', key: 'won', num: true, fmt: n },
          { label: 'Revenue', key: 'revenue', num: true, fmt: money },
          { label: 'Rev / visitor', key: 'revenue_per_visitor', num: true, fmt: money },
        ], rows, { cards: true }) + '</div>' +
        '<details class="card" style="margin-top:14px"><summary><strong>What do these mean?</strong></summary><ul class="muted" style="margin:10px 0 0;padding-left:18px;line-height:1.6">' +
        '<li><b>Platform</b>: the actual site or app: Instagram, Facebook, Google, ChatGPT, YouTube…</li>' +
        '<li><b>Organic social</b>: a social network, not from an ad (Instagram, Facebook, TikTok, LinkedIn, X). <b>Paid social</b> is the same from an ad.</li>' +
        '<li><b>Organic search</b>: Google, Bing, DuckDuckGo results. <b>AI search</b>: ChatGPT, Claude, Perplexity, Gemini, Copilot, Grok.</li>' +
        '<li><b>Referral</b>: a link on another website. <b>Messaging</b>: WhatsApp, Telegram, SMS.</li>' +
        '<li><b>Direct</b>: the browser didn’t say where they came from: typed in, a bookmark, a copied link, or an app that hides it. Instagram and Facebook taps are recognised from their built-in browser, and tracked links (Links &amp; videos) are always named.</li>' +
        '<li>Bots, link checkers (e.g. Meta checking a link you posted), scripts and your own visits while logged in here are left out of every number.</li></ul></details>' +
        '<p class="muted" style="margin-top:10px">Tip: tag ads with <span class="mono">utm_source</span>, <span class="mono">utm_campaign</span>, <span class="mono">utm_content={{ad.name}}</span> and <span class="mono">ad_id={{ad.id}}</span> to see quality per ad.</p>';
      view.querySelector('[data-dim]').onchange = function (e) { state.dim = e.target.value; load(); };
      wireAdSpend(ads);
    });
  }

  /** Traffic & ads: spend per campaign (Meta sync or typed in) next to what it bought. */
  function adSpendHtml(a) {
    if (!a) return '';
    var cur = a.currency || 'AUD';
    var cm = function (v) { if (v == null || !isFinite(v)) return '–'; try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, maximumFractionDigits: v < 20 ? 2 : 0 }).format(v); } catch (e) { return money(v); } };
    var F = { vsl: 'VSL', webinar: 'Webinar', other: 'Other' };
    var m = a.meta || {};
    var metaLine = m.configured
      ? 'Meta ad account <span class="mono">' + esc(m.account) + '</span> syncs every hour' + (a.syncedAt ? ' · last ' + esc(ago(a.syncedAt)) : '') + '. <button type="button" class="linkish" data-ads-sync>Sync now</button> · <button type="button" class="linkish" data-ads-connect>Change account</button>'
      : m.token ? 'Meta token saved. <button type="button" class="btn-sm" data-ads-connect>Connect ad account</button>'
      : 'Connect Meta to pull spend automatically: add a token with the <b>ads_read</b> permission under Integrations → Ads (Meta ads token), then come back and press Connect. Or type spend in below.';
    var tilesHtml = (a.byFunnel || []).filter(function (f) { return f.funnel !== 'other' || f.spend; }).map(function (f) {
      return tile(F[f.funnel] + ' ad spend', cm(f.spend), f.spend ? 'cost per visitor ' + cm(f.cpc) + ' · per booked call ' + cm(f.costPerBooked) + ' · CAC ' + cm(f.cac) + (f.roas != null ? ' · ROAS ' + f.roas.toFixed(1) + '×' : '') : 'no spend in this period');
    }).join('');
    var campaigns = a.campaigns || [];
    return '<div class="card"><div class="card-head"><div><h2>Ad spend and what it bought</h2><p class="sub">' + metaLine + '</p></div></div>' +
      '<div data-ads-accounts></div>' +
      '<div class="grid g-3 tiles" style="margin-top:10px">' + tilesHtml + '</div>' +
      (campaigns.length ? '<div style="margin-top:14px">' + table([
        { label: 'Campaign', html: function (r) { return '<strong>' + esc(r.name) + '</strong><div class="muted">' + esc(r.platform) + (r.manual ? ' · typed in <button type="button" class="linkish" data-ads-del="' + esc(r.platform + '|' + r.campaign_id) + '">remove</button>' : '') + '</div>'; } },
        { label: 'Funnel', html: function (r) { return '<select class="input" data-ads-funnel="' + esc(r.platform + '|' + r.campaign_id) + '" aria-label="Funnel">' + ['vsl', 'webinar', 'other'].map(function (f) { return '<option value="' + f + '"' + (f === r.funnel ? ' selected' : '') + '>' + F[f] + '</option>'; }).join('') + '</select>'; } },
        { label: 'Spend', num: true, html: function (r) { return esc(cm(r.spend)); } },
        { label: 'Link clicks', key: 'link_clicks', num: true, fmt: n },
        { label: 'Visitors', num: true, html: function (r) { return r.visitors ? esc(n(r.visitors)) + '<div class="muted">' + esc(cm(r.spend / r.visitors)) + ' each</div>' : '<span class="muted" title="No visits tagged with this campaign name. Add utm_campaign={{campaign.name}} to the ad URL.">untagged</span>'; } },
        { label: 'Leads', num: true, html: function (r) { var k = r.funnel === 'webinar' ? r.registrants : r.leads; return esc(n(k)) + (k ? '<div class="muted">' + esc(cm(r.spend / k)) + ' each</div>' : ''); } },
        { label: 'Booked', num: true, html: function (r) { return esc(n(r.booked)) + (r.booked ? '<div class="muted">' + esc(cm(r.spend / r.booked)) + ' each</div>' : ''); } },
        { label: 'Won', num: true, html: function (r) { return esc(n(r.won)) + (r.revenue ? '<div class="muted">' + esc(money(r.revenue)) + '</div>' : ''); } },
        { label: 'ROAS', num: true, html: function (r) { return r.spend && r.revenue ? esc((r.revenue / r.spend).toFixed(1) + '×') : '–'; } },
      ], campaigns, { cards: true }) + '</div>' : '<p class="muted" style="margin-top:12px">No ad spend recorded for this period yet.</p>') +
      '<details style="margin-top:14px"><summary><strong>Add spend by hand</strong> <span class="muted">(Google, YouTube, LinkedIn, or Meta before it’s connected)</span></summary>' +
      '<form class="row" data-ads-form style="margin-top:10px;flex-wrap:wrap;gap:8px">' +
      '<select class="input" name="platform" style="max-width:130px"><option value="google">Google</option><option value="youtube">YouTube</option><option value="meta">Meta</option><option value="linkedin">LinkedIn</option><option value="tiktok">TikTok</option><option value="other">Other</option></select>' +
      '<input class="input" name="campaign" placeholder="Campaign name (= its utm_campaign)" style="flex:1 1 220px" required>' +
      '<input class="input" name="month" type="month" value="' + new Date().toISOString().slice(0, 7) + '" style="max-width:160px" required>' +
      '<input class="input" name="spend" type="number" min="0" step="1" placeholder="Spend" style="max-width:120px" required>' +
      '<input class="input" name="clicks" type="number" min="0" step="1" placeholder="Clicks (optional)" style="max-width:150px">' +
      '<select class="input" name="funnel" style="max-width:120px"><option value="vsl">VSL</option><option value="webinar">Webinar</option><option value="other">Other</option></select>' +
      '<button class="btn-sm" type="submit">Add</button></form></details>' +
      '<p class="muted" style="margin-top:10px">Spend is matched to visits and leads by campaign name, so tag every ad URL with <span class="mono">utm_campaign={{campaign.name}}</span>. The financial model uses the last 30 days of spend per funnel.</p></div>';
  }

  function wireAdSpend(a) {
    if (!a) return;
    var box = view.querySelector('[data-ads-accounts]');
    view.querySelectorAll('[data-ads-connect]').forEach(function (b) {
      b.onclick = function () {
        box.innerHTML = '<p class="muted">Asking Meta for your ad accounts…</p>';
        fetch('/admin/api/ads/accounts', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (r) {
          if (!r.ok) { box.innerHTML = '<div class="card notice" style="margin-top:10px">' + esc(r.error) + '</div>'; return; }
          if (!r.accounts.length) { box.innerHTML = '<p class="muted">This token can’t see any ad accounts. Give the system user access to the ad account in Business Settings.</p>'; return; }
          box.innerHTML = '<div class="row" style="margin-top:10px;gap:8px;flex-wrap:wrap">' + r.accounts.map(function (x) { return '<button type="button" class="btn-sm ghost" data-ads-pick="' + esc(x.id) + '">' + esc(x.name + ' · ' + x.currency + (x.active ? '' : ' (inactive)')) + '</button>'; }).join('') + '</div>';
          box.querySelectorAll('[data-ads-pick]').forEach(function (p) {
            p.onclick = function () {
              box.innerHTML = '<p class="muted">Connecting and pulling the last 90 days of spend…</p>';
              send('POST', 'ads/account', { id: p.getAttribute('data-ads-pick') }).then(function (res) { toast(res.ok ? 'Connected · ' + n(res.synced ? res.synced.rows : 0) + ' campaign-days pulled' : res.error); load(); });
            };
          });
        });
      };
    });
    var sync = view.querySelector('[data-ads-sync]');
    if (sync) sync.onclick = function () { sync.textContent = 'Syncing…'; send('POST', 'ads/sync', {}).then(function (r) { toast(r.ok ? 'Synced' : r.error); load(); }); };
    view.querySelectorAll('[data-ads-funnel]').forEach(function (sel) {
      sel.onchange = function () { var k = sel.getAttribute('data-ads-funnel').split('|'); send('PUT', 'ads/campaign', { platform: k[0], campaign_id: k.slice(1).join('|'), funnel: sel.value }).then(function () { toast('Saved'); load(); }); };
    });
    view.querySelectorAll('[data-ads-del]').forEach(function (b) {
      b.onclick = function () {
        if (!confirm('Remove this typed-in spend?')) return;
        var k = b.getAttribute('data-ads-del').split('|');
        fetch('/admin/api/ads/manual?platform=' + encodeURIComponent(k[0]) + '&campaign_id=' + encodeURIComponent(k.slice(1).join('|')), { method: 'DELETE', credentials: 'same-origin' }).then(function () { load(); });
      };
    });
    var f = view.querySelector('[data-ads-form]');
    if (f) f.onsubmit = function (e) {
      e.preventDefault();
      send('POST', 'ads/manual', { platform: f.platform.value, campaign: f.campaign.value, month: f.month.value, spend: Number(f.spend.value), clicks: Number(f.clicks.value) || 0, funnel: f.funnel.value }).then(function (r) { toast(r.ok ? 'Added' : r.error); if (r.ok) load(); });
    };
  }

  function renderApplication() {
    return api('application').then(function (d) {
      // Step 1 = 100%: people can start on the main page's form without ever opening /apply, so page views aren't the base.
      var base = (d.steps[0] && d.steps[0].reached) || d.started || 1;
      var stepRows = d.steps.map(function (s) { return { name: s.step + '. ' + s.title, value: s.reached, note: pct(s.reached / base) }; });
      view.innerHTML =
        '<div class="grid g-4 tiles">' + tile('Viewed', n(d.page_views)) + tile('Started (contact given)', n(d.started), d.started > d.page_views ? 'includes the main-page form' : pct(d.started / (d.page_views || 1)) + ' of viewers') + tile('Completed', n(d.completed), pct(d.completed / (d.started || 1)) + ' of starters') +
        tile('Closer split', d.closers.map(function (c) { return c.name.split(' ')[0] + ' ' + c.leads; }).join(' · ') || '–') + '</div>' +
        '<div class="grid g-2" style="margin-top:14px"><div class="card"><h2>Step drop-off</h2><p class="sub">' + esc('People who reached each question (step 1 = 100%). ' + n(d.page_views) + ' opened the separate /apply page; the rest started on the main page.') + '</p>' + barList(stepRows) + '</div>' +
        '<div class="grid"><div class="card"><h2>Score distribution</h2><p class="sub">Completed applications by score. A ≥ 70, B ≥ 40.</p><div class="chart" data-hist></div></div>' +
        '<div class="card"><h2>Tier caps applied</h2><p class="sub">Hard rules that lowered a lead’s tier.</p>' + table([{ label: 'Reason', key: 'reason' }, { label: 'Leads', key: 'n', num: true, fmt: n }], d.caps) + '</div></div></div>' +
        '<h3 class="section-title">Answers</h3><div class="grid g-2">' + d.distributions.map(function (q) {
          return '<div class="card"><h2>' + esc(q.title) + '</h2><p class="sub">' + n(q.answered) + ' answered</p>' + barList(q.options.map(function (o) { return { name: o.label + ' (' + o.points + ' pts)', value: o.n, note: pct(o.n / (q.answered || 1)) }; })) + '</div>';
        }).join('') + '</div>';
      columnChart(view.querySelector('[data-hist]'), d.score_histogram.map(function (h) { return { label: 'Score ' + h.range, short: h.range.split('–')[0], value: h.n }; }), { label: 'Score distribution' });
    });
  }

  // ── Leads ──
  var leadsSearchT = null;
  function renderLeads() {
    var q = state.leadsQuery, r = range();
    var params = { q: q.q, tier: q.tier, status: q.status, page: q.page, sort: q.sort, channel: state.filters.channel || '', from: r.from, to: r.to };
    return fetchLeads(params).then(function (d) {
      var statuses = (state.meta && state.meta.statuses) || [];
      var live = view.querySelector('[data-q]');
      var typed = live && document.activeElement === live ? live.value : null;
      if (typed != null) q._caret = live.selectionStart;
      var exportUrl = '/admin/api/export/leads.csv?' + new URLSearchParams(Object.fromEntries(Object.entries(params).filter(function (e) { return e[1] !== '' && e[0] !== 'page'; }))).toString();
      view.innerHTML =
        '<div class="card"><div class="leads-tools"><input class="input" type="search" placeholder="Search name, email, phone or ref" aria-label="Search leads" data-q value="' + esc(q.q) + '">' +
        '<select class="input" data-tier aria-label="Tier"><option value="">All tiers</option><option>A</option><option>B</option><option>C</option></select>' +
        '<select class="input" data-status aria-label="Status"><option value="">All statuses</option>' + statuses.map(function (s) { return '<option>' + esc(s) + '</option>'; }).join('') + '</select>' +
        '<select class="input" data-sort aria-label="Sort"><option value="created">Newest</option><option value="score">Highest score</option><option value="call">Call time</option><option value="updated">Recently updated</option></select>' +
        '<span class="spacer"></span><span class="muted">' + n(d.total) + ' leads</span><a class="btn-sm ghost" href="' + esc(exportUrl) + '">Export CSV</a></div>' +
        table([
          { label: 'Lead', html: function (l) { var em = l.email || ''; return '<strong>' + esc([l.first_name, l.last_name].filter(Boolean).join(' ') || '—') + '</strong><div class="muted ell" title="' + esc(em) + '">' + esc(em) + '</div>'; } },
          { label: 'Tier', nw: true, html: tierCell },
          { label: 'Score', key: 'score', num: true, nw: true, fmt: function (v) { return v == null ? '–' : v; } },
          { label: 'Status', nw: true, html: function (l) { return statusPill(l.status); } },
          { label: 'Video', key: 'vsl_pct', num: true, nw: true, fmt: function (v) { return v == null ? '–' : pct(Math.min(1, v)); } },
          { label: 'Source', html: function (l) { var sub = (l.utm_campaign || '') + (l.utm_content ? ' · ' + l.utm_content : ''); return esc(where(l.channel, l.utm_source, null, l.utm_medium)) + '<div class="muted ell" title="' + esc(sub) + '">' + (esc(sub) || '&nbsp;') + '</div>'; } },
          { label: 'Call', nw: true, html: function (l) { return l.call_at ? esc(when(l.call_at)) : l.booked_at ? 'booked' : '<span class="muted">–</span>'; } },
          { label: 'WhatsApp', nw: true, html: function (l) { return l.whatsapp_connected_at ? '<span class="pill st-won" title="Connected">connected</span>' : l.whatsapp_clicked_at ? '<span class="pill" title="Clicked">clicked</span>' : ''; } },
          { label: 'Country', key: 'country', nw: true },
          { label: 'Created', nw: true, html: function (l) { return '<span title="' + esc(when(l.created_at)) + '">' + esc(ago(l.created_at)) + '</span>'; } },
        ], d.rows, { rowAttr: function (l) { return 'class="click" data-lead="' + esc(l.id) + '" tabindex="0"'; }, empty: 'No leads match.', emptyHint: q.q || q.tier || q.status ? 'Try clearing the search or filters.' : '' }) + '</div>' +
        '<div class="row" style="margin-top:12px"><button class="btn-sm ghost" data-prev ' + (q.page ? '' : 'disabled') + '>← Prev</button><span class="muted">Page ' + (q.page + 1) + ' of ' + Math.max(1, Math.ceil(d.total / d.pageSize)) + '</span><button class="btn-sm ghost" data-next ' + ((q.page + 1) * d.pageSize < d.total ? '' : 'disabled') + '>Next →</button></div>';
      view.querySelector('[data-tier]').value = q.tier;
      view.querySelector('[data-status]').value = q.status;
      view.querySelector('[data-sort]').value = q.sort;
      // Typing re-renders the list; put the cursor back where it was so the next keystroke lands in the box.
      var qIn = view.querySelector('[data-q]');
      if (typed != null && typed !== qIn.value) qIn.value = typed; // keys pressed while the list was loading
      if (q._focus) { qIn.focus(); var c = q._caret == null ? qIn.value.length : Math.min(q._caret, qIn.value.length); try { qIn.setSelectionRange(c, c); } catch (x) { /* type=search may refuse */ } }
      qIn.oninput = function (e) {
        clearTimeout(leadsSearchT);
        q._focus = true; q._caret = e.target.selectionStart;
        leadsSearchT = setTimeout(function () {
          var cur = view.querySelector('[data-q]');
          if (!cur || state.tab !== 'leads') return;
          q._focus = document.activeElement === cur; q._caret = cur.selectionStart;
          q.q = cur.value; q.page = 0; load();
        }, 300);
      };
      qIn.onblur = function () { setTimeout(function () { if (document.activeElement !== qIn && view.contains(qIn)) q._focus = false; }, 0); };
      view.querySelector('[data-tier]').onchange = function (e) { q.tier = e.target.value; q.page = 0; load(); };
      view.querySelector('[data-status]').onchange = function (e) { q.status = e.target.value; q.page = 0; load(); };
      view.querySelector('[data-sort]').onchange = function (e) { q.sort = e.target.value; load(); };
      view.querySelector('[data-prev]').onclick = function () { q.page--; load(); };
      view.querySelector('[data-next]').onclick = function () { q.page++; load(); };
      view.querySelectorAll('[data-lead]').forEach(function (row) {
        row.onclick = function () { openLead(row.getAttribute('data-lead')); };
        row.onkeydown = function (e) { if (e.key === 'Enter') openLead(row.getAttribute('data-lead')); };
      });
      updateFilterCue();
    });
  }
  function fetchLeads(params) {
    var q = new URLSearchParams();
    Object.keys(params).forEach(function (k) { if (params[k] !== '' && params[k] != null) q.set(k, params[k]); });
    return fetch('/admin/api/leads?' + q, { credentials: 'same-origin' }).then(function (r) { if (r.status === 401) location.href = '/admin/login'; return r.json(); });
  }

  var EVENT_LABELS = {
    page_view: 'Viewed page', vsl_play: 'Played VSL', vsl_unmute: 'Turned sound on', vsl_25: 'Watched 25%', vsl_50: 'Watched 50%', vsl_75: 'Watched 75%', vsl_95: 'Watched 95%', vsl_complete: 'Finished the video',
    vsl_cta_reveal: 'Reached the pitch', vsl_cta_click: 'Clicked CTA from video', cta_click: 'Clicked CTA', lead_captured: 'Gave contact details', app_step_saved: 'Answered a question', app_submitted: 'Submitted application',
    lead_qualified: 'Scored', lead_routed: 'Routed', booking_view: 'Saw the calendar', booking_scheduled: 'Booked a call', booking_scheduled_client: 'Booked (browser)', booking_cancelled: 'Cancelled call', whatsapp_click: 'Clicked WhatsApp',
    whatsapp_connected: 'Messaged on WhatsApp', voice_web_start: 'Started AI call (browser)', voice_call_started: 'AI call connected', voice_call_completed: 'AI call ended', voice_link_sent: 'AI sent booking link', voice_opt_out: 'Asked not to be contacted', whatsapp_sent: 'Sent WhatsApp template', email_sent: 'Email sent', email_open: 'Opened email', email_click: 'Clicked email link', unsubscribe: 'Unsubscribed',
    scroll_depth: 'Scrolled', engaged_time: 'Engaged', faq_open: 'Opened FAQ', app_view_step: 'Viewed question', lead_status_changed: 'Status changed', exit_intent: 'Exit intent', rage_click: 'Rage click', form_error: 'Form error',
  };
  EVENT_LABELS.data_claim = 'Claimed a data valuation'; EVENT_LABELS.data_cta_click = 'Clicked “Claim”'; EVENT_LABELS.data_form_start = 'Started the claim form';
  EVENT_LABELS.data_video_play = 'Played the video'; EVENT_LABELS.click = 'Clicked'; EVENT_LABELS.section_dwell = 'Read sections'; EVENT_LABELS.cta_hover = 'Hovered a button';
  EVENT_LABELS.page_exit = 'Left the page'; EVENT_LABELS.section_revisit = 'Scrolled back to a section'; EVENT_LABELS.tab_return = 'Came back to the tab'; EVENT_LABELS.copy_text = 'Copied text'; EVENT_LABELS.text_copy = 'Copied text'; EVENT_LABELS.first_interaction = 'First interaction';
  var QUIET = { app_view_step: 1, scroll_depth: 1, engaged_time: 1, click: 1, field_interaction: 1, first_interaction: 1, section_dwell: 1, cta_hover: 1, vsl_volume: 1, page_exit: 1, tab_return: 1 };

  /** Every visit and action, oldest first in the data, newest at the top. Shared by the lead and visitor drawers. */
  function journeyHtml(events, sessions, showAll) {
    var byId = {}, seen = {}, out = [];
    (sessions || []).forEach(function (s) { byId[s.id] = s; });
    events.slice().reverse().forEach(function (e) {
      if (e.session_id && !seen[e.session_id] && byId[e.session_id]) {
        seen[e.session_id] = 1;
        var s = byId[e.session_id];
        out.push('<li class="session"><span class="when">' + esc(when(s.started_at)) + '</span><span class="what"><b>New visit</b> · ' + esc(s.channel || 'Direct') + (s.utm_campaign ? ' / ' + esc(s.utm_campaign) : '') + (s.utm_content ? ' / ' + esc(s.utm_content) : '') +
          '<div class="props">' + esc([s.device, s.browser, s.os, [s.city, s.region, s.country].filter(Boolean).join(', '), s.referrer_host].filter(Boolean).join(' · ')) + '</div></span></li>');
      }
      if (!showAll && QUIET[e.name]) return;
      var props = {};
      try { props = JSON.parse(e.props || '{}'); } catch (x) { /* ignore */ }
      var detail = Object.keys(props).filter(function (k) { return ['view', 'email_id', 'event_uri'].indexOf(k) === -1 && props[k] !== null && props[k] !== ''; }).map(function (k) { return k + ': ' + (typeof props[k] === 'object' ? JSON.stringify(props[k]) : props[k]); }).join(' · ');
      out.push('<li><span class="when">' + esc(when(e.ts)) + '</span><span class="what"><b>' + esc(EVENT_LABELS[e.name] || e.name) + '</b>' + (e.path ? ' <span class="muted">' + esc(e.path) + '</span>' : '') + (detail ? '<div class="props">' + esc(detail) + '</div>' : '') + '</span></li>');
    });
    return out.reverse().join('');
  }

  /** One visitor (lead or not): who they are if they claimed, what they did, every action. */
  function openVisitor(id) {
    closeDrawers();
    var bg = document.createElement('div'); bg.className = 'drawer-bg';
    var dr = document.createElement('aside'); dr.className = 'drawer'; dr.setAttribute('role', 'dialog'); dr.setAttribute('aria-label', 'Visitor journey'); dr.setAttribute('data-visitor-drawer', id);
    dr.innerHTML = '<div class="loading-note">Loading…</div>';
    document.body.appendChild(bg); document.body.appendChild(dr);
    function teardown() { document.removeEventListener('keydown', onKey); }
    function close() { bg.remove(); dr.remove(); teardown(); if (location.hash !== '#' + state.tab) setHash('replaceState', '#' + state.tab); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    dr.__teardown = teardown;
    bg.onclick = close; document.addEventListener('keydown', onKey);
    fetch('/admin/api/visitors/' + encodeURIComponent(id), { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) { dr.innerHTML = '<div class="drawer-head"><div class="row" style="flex:1;min-width:0"><h2 class="lead-name">Visitor</h2></div><button class="close" type="button" aria-label="Close">Close ✕</button></div><div class="empty">Visitor not found.</div>'; dr.querySelector('.close').onclick = close; return; }
      var c = d.claims[0], v = d.visitor, ev = d.events, showAll = true;
      var P = function (e) { try { return JSON.parse(e.props || '{}'); } catch (x) { return {}; } };
      var count = function (name) { return ev.filter(function (e) { return e.name === name; }).length; };
      var scroll = ev.filter(function (e) { return e.name === 'scroll_depth'; }).reduce(function (m, e) { return Math.max(m, Number(P(e).pct) || 0); }, 0);
      var engaged = ev.filter(function (e) { return e.name === 'engaged_time'; }).reduce(function (t, e) { return t + (Number(P(e).ms) || 0); }, 0);
      var dwell = {};
      ev.filter(function (e) { return e.name === 'section_dwell'; }).forEach(function (e) { var p = P(e); Object.keys(p).forEach(function (k) { if (typeof p[k] === 'number') dwell[k] = (dwell[k] || 0) + p[k]; }); });
      var dwellRows = Object.keys(dwell).sort(function (a, b) { return dwell[b] - dwell[a]; }).slice(0, 8);
      var clicks = ev.filter(function (e) { return e.name === 'click' || e.name === 'cta_click' || e.name === 'data_cta_click'; }).map(function (e) { var p = P(e); return String(p.text || p.label || p.id || p.el || e.name).replace(/\s*Takes 60 seconds.*$/, '').slice(0, 60); }).filter(function (t, i, all) { return all.indexOf(t) === i; }).slice(0, 10);
      var headline = (ev.filter(function (e) { return e.name === 'page_view' && P(e).headline; })[0] || null);
      var s0 = d.sessions[d.sessions.length - 1] || {};
      var title = c ? (c.first_name + (c.company ? ' · ' + c.company : '')) : d.lead ? d.lead.name : 'Anonymous visitor';
      dr.innerHTML = '<div class="drawer-head"><div class="row" style="flex:1;min-width:0"><h2 class="lead-name">' + esc(title) + '</h2>' + (c ? '<span class="pill">claimed ' + esc(when(c.created_at)) + '</span>' : '<span class="pill">not signed up</span>') + (c && c.business_status && c.business_status !== 'Trading' ? '<span class="pill">' + esc(c.business_status) + '</span>' : '') + '</div><button class="close" type="button" aria-label="Close">Close ✕</button></div>' +
        '<p class="muted" style="margin:4px 0 14px">' + esc(c ? [c.email, c.phone, c.website].filter(Boolean).join(' · ') : 'Visitor ' + v.id) + ' · first seen ' + esc(when(v.created_at)) + '</p>' +
        (c ? '<div class="row" style="margin-bottom:14px"><a class="btn-sm ghost" href="mailto:' + esc(c.email) + '">Email</a>' + (c.phone ? '<a class="btn-sm ghost" href="tel:' + esc(c.phone) + '">Call</a>' : '') + '</div>' : '') +
        (d.lead ? '<div class="card notice" style="margin-bottom:14px">Also in the M&amp;A funnel: <strong>' + esc(d.lead.name) + '</strong> (' + esc(d.lead.status) + ', matched by ' + esc(d.lead.how) + '). <button class="btn-sm" data-openlead="' + esc(d.lead.id) + '">Open lead</button></div>' : '') +
        '<div class="grid g-4 tiles">' +
        tile('Visits', n(d.sessions.length), [s0.channel, s0.utm_campaign].filter(Boolean).join(' / ') || 'Direct') +
        tile('Time on page', secs(Math.round(engaged / 1000)), 'actively engaged') +
        tile('Scrolled', scroll ? scroll + '%' : '–', 'deepest point') +
        tile('Clicks', n(count('click') + count('data_cta_click')), n(count('data_cta_click')) + ' on “Claim” · ' + n(count('faq_open')) + ' FAQs opened') +
        '</div>' +
        '<div class="grid g-2" style="margin-top:14px"><div class="card"><h2>Profile</h2><dl class="kv" style="margin-top:10px">' +
        kv('Headline seen', headline ? P(headline).headline : '–') + kv('Source', [where(s0.channel, s0.utm_source, s0.referrer_host, s0.utm_medium), s0.utm_campaign, s0.utm_content].filter(Boolean).join(' / ')) +
        kv('Device', [s0.device, s0.browser, s0.os].filter(Boolean).join(' · ')) + kv('Location', [s0.city, s0.region, s0.country].filter(Boolean).join(', ')) +
        kv('Video', count('data_video_play') || count('vsl_play') ? 'played' : 'not played') + kv('Claim form', c ? 'submitted' : count('data_form_start') ? 'started, didn’t submit' : 'not opened') +
        (c ? kv('Revenue', c.revenue || '–') + kv('Business', c.business_status || '–') : '') + '</dl></div>' +
        '<div class="card"><h2>What they read and clicked</h2>' +
        (dwellRows.length ? '<dl class="kv" style="margin-top:10px">' + dwellRows.map(function (k) { return kv(k.replace(/^data_/, '').replace(/_/g, ' '), secs(Math.round(dwell[k]))); }).join('') + '</dl>' : '<p class="muted">No reading data yet.</p>') +
        (clicks.length ? '<p class="sub" style="margin-top:10px">Clicked: ' + esc(clicks.join(' · ')) + '</p>' : '') + '</div></div>' +
        '<div class="card" style="margin-top:14px"><div class="card-head"><div><h2>Journey</h2><p class="sub">Every visit and action: scrolls, clicks, reading time, video, form. Nothing they type is recorded.</p></div><label class="muted"><input type="checkbox" data-all checked> show all events</label></div><ul class="timeline" data-tl>' + journeyHtml(ev, d.sessions, showAll) + '</ul></div>';
      dr.querySelector('.close').onclick = close;
      dr.querySelector('[data-all]').onchange = function (e) { dr.querySelector('[data-tl]').innerHTML = journeyHtml(ev, d.sessions, e.target.checked); };
      var ol = dr.querySelector('[data-openlead]');
      if (ol) ol.onclick = function () { close(); openLead(ol.getAttribute('data-openlead')); };
    });
  }

  // One article in depth: where its visitors come from, what they searched, and how far they get.
  function openArticle(slug) {
    closeDrawers();
    var bg = document.createElement('div'); bg.className = 'drawer-bg';
    var dr = document.createElement('aside'); dr.className = 'drawer'; dr.setAttribute('role', 'dialog'); dr.setAttribute('aria-label', 'Article traffic');
    dr.innerHTML = '<div class="loading-note">Loading…</div>';
    document.body.appendChild(bg); document.body.appendChild(dr);
    function teardown() { document.removeEventListener('keydown', onKey); }
    function close() { bg.remove(); dr.remove(); teardown(); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    dr.__teardown = teardown; bg.onclick = close; document.addEventListener('keydown', onKey);
    var r = range();
    var qs = 'slug=' + encodeURIComponent(slug) + '&from=' + r.from + '&to=' + r.to + '&tz=' + (-new Date().getTimezoneOffset());
    fetch('/admin/api/search/article?' + qs, { credentials: 'same-origin' }).then(function (res) { return res.json(); }).then(function (d) {
      if (!d || d.error) { dr.innerHTML = '<div class="drawer-head"><h2 class="lead-name">Article</h2><button class="close" type="button">Close ✕</button></div><div class="empty">No data for this article yet.</div>'; dr.querySelector('.close').onclick = close; return; }
      var f = d.funnel, total = f.landed || 0;
      var step = function (label, v, hint) { var pc = total ? Math.round((v / total) * 100) : 0; return '<div class="fstep"><div class="fstep-bar"><i style="width:' + pc + '%"></i><span>' + esc(label) + '</span><b>' + n(v) + '</b></div>' + (hint ? '<small class="muted">' + esc(hint) + '</small>' : '') + '</div>'; };
      var listCard = function (title, rows, keyLabel, sub) {
        if (!rows || !rows.length) return '<div class="card"><h2>' + esc(title) + '</h2>' + (sub ? '<p class="sub">' + esc(sub) + '</p>' : '') + '<p class="muted">None yet.</p></div>';
        var max = rows.reduce(function (m, x) { return Math.max(m, x.sessions); }, 0);
        return '<div class="card"><h2>' + esc(title) + '</h2>' + (sub ? '<p class="sub">' + esc(sub) + '</p>' : '') +
          '<div class="barlist" style="margin-top:10px">' + rows.map(function (x) { return '<div class="barrow"><span class="barrow-l" title="' + esc(x[keyLabel]) + '">' + esc(x[keyLabel] || '(none)') + '</span><span class="barrow-bar"><i style="width:' + Math.round((x.sessions / max) * 100) + '%"></i></span><b>' + n(x.sessions) + '</b></div>'; }).join('') + '</div></div>';
      };
      dr.innerHTML = '<div class="drawer-head"><div class="row" style="flex:1;min-width:0"><h2 class="lead-name">' + esc(d.h1) + '</h2><span class="pill">' + esc(d.section) + '</span></div><button class="close" type="button" aria-label="Close">Close ✕</button></div>' +
        '<p class="muted" style="margin:4px 0 14px"><a href="' + esc(d.url) + '" target="_blank" rel="noopener">' + esc(String(d.url).replace(/^https?:\/\//, '')) + '</a> · <a href="' + esc(d.md) + '" target="_blank" rel="noopener">view as AI sees it (.md)</a></p>' +
        '<div class="grid g-4 tiles">' +
        tile('Reads', n(d.views.views), n(d.views.readers) + ' people') +
        tile('Entered here', n(f.landed), 'started their visit on this article') +
        tile('Became leads', n(f.leads), total ? pct(f.leads / total) + ' of those who entered here' : '–') +
        tile('Booked', n(f.booked), n(f.won) + ' won') +
        '</div>' +
        '<div class="card" style="margin-top:14px"><h2>Funnel from this article</h2><p class="sub">People whose first page on the site was this article, and how far they went.</p><div class="funnelbars" style="margin-top:12px">' +
        step('Entered on this article', f.landed) + step('Read more than one page', f.engaged) + step('Became a lead', f.leads) + step('Completed the application', f.applied) + step('Booked a call', f.booked) + step('Won', f.won) + '</div></div>' +
        '<div class="card" style="margin-top:14px"><h2>Where they came from</h2><div class="chart" data-art-series></div></div>' +
        '<div class="grid g-2" style="margin-top:14px">' +
        listCard('Platform', d.referrers, 'source', 'Google, ChatGPT, Instagram… “Direct” means the browser didn’t say: typed in, a bookmark, or an app that hides links.') +
        listCard('Exact site', d.sites, 'source', 'The referring website, when the browser passed it on.') +
        '</div>' +
        '<div class="grid g-2" style="margin-top:14px">' +
        listCard('Search terms', d.terms, 'term', 'Only when the link carried one — Google and Bing hide most queries.') +
        listCard('Country', d.countries, 'country') +
        '</div>' +
        listCard('Device', d.devices, 'device') ;
      dr.querySelector('.close').onclick = close;
      var sc = dr.querySelector('[data-art-series]');
      if (d.series && d.series.length) lineChart(sc, d.series.map(function (x) { return { label: x.day, short: x.day.slice(5), value: x.landed }; }), { label: 'Entered on this article per day', height: 160 });
      else sc.innerHTML = '<p class="muted">No visitors entered on this article in this range yet.</p>';
    });
  }

  function openLead(id, o) {
    closeDrawers();
    var pushed = false;
    if (!(o && o.fromRoute) && location.hash !== '#lead=' + id) { setHash('pushState', '#lead=' + id); pushed = true; }
    var bg = document.createElement('div'); bg.className = 'drawer-bg';
    var dr = document.createElement('aside'); dr.className = 'drawer'; dr.setAttribute('role', 'dialog'); dr.setAttribute('aria-label', 'Lead details'); dr.setAttribute('data-lead', id);
    dr.innerHTML = '<div class="loading-note">Loading…</div>';
    document.body.appendChild(bg); document.body.appendChild(dr);
    function teardown() { document.removeEventListener('keydown', onKey); }
    function close() {
      bg.remove(); dr.remove(); teardown();
      // Opened by a click: step back off the lead entry so Back doesn't reopen it. Opened from the URL: just tidy the URL.
      if (pushed && location.hash === '#lead=' + id) history.back();
      else if (location.hash !== '#' + state.tab) setHash('replaceState', '#' + state.tab);
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    dr.__teardown = teardown;
    bg.onclick = close; document.addEventListener('keydown', onKey);

    fetch('/admin/api/leads/' + encodeURIComponent(id), { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) { dr.innerHTML = '<div class="drawer-head"><div class="row" style="flex:1;min-width:0"><h2 class="lead-name">Lead</h2></div><button class="close" type="button" aria-label="Close">Close ✕</button></div><div class="empty">Lead not found.</div>'; dr.querySelector('.close').onclick = close; return; }
      var l = d.lead, sc = d.scoring || {};
      var tier = l.tier_override || l.tier;
      var showAll = false;
      var sessionsById = {};
      d.sessions.forEach(function (s) { sessionsById[s.id] = s; });

      function timeline() { return journeyHtml(d.events, d.sessions, showAll); }
      // Section chips under the name: only for sections this lead has.
      var jumps = [['ld-pipeline', 'Pipeline'], ['ld-deal', 'Deal'], ['ld-contract', 'Contract'], ['ld-app', 'Application'], ['ld-video', 'Video'], ['ld-emails', 'Emails']]
        .concat(d.calendly && d.calendly.length ? [['ld-calendly', 'Bookings']] : [])
        .concat(d.voice && d.voice.length ? [['ld-calls', 'AI calls']] : [])
        .concat([['ld-journey', 'Journey']]);

      dr.innerHTML =
        '<div class="drawer-head"><div class="row" style="flex:1;min-width:0"><h2 class="lead-name">' + esc([l.first_name, l.last_name].filter(Boolean).join(' ') || l.email) + '</h2>' + (tier ? '<span class="tier ' + esc(tier) + '">' + esc(tier) + '</span>' : '') + (l.status ? statusPill(l.status) : '') + '<span class="pill" title="Lead score out of 100 (A ≥ 70, B ≥ 40)">score ' + esc(l.score == null ? '–' : l.score + '/100') + '</span><span class="pill">ref ' + esc(l.ref_code) + '</span></div><button class="close" type="button" aria-label="Close">Close ✕</button>' +
        '<nav class="ld-jump" aria-label="Jump to section">' + jumps.map(function (j) { return '<button type="button" data-jump="' + j[0] + '">' + esc(j[1]) + '</button>'; }).join('') + '</nav></div>' +
        '<p class="muted" style="margin:4px 0 14px">' + esc(l.email || '') + (l.phone ? ' · ' + esc(l.phone) : '') + ' · created ' + esc(when(l.created_at)) + '</p>' +
        '<div class="row" style="margin-bottom:14px">' + (l.booking_join_url ? '<a class="btn-sm" target="_blank" rel="noopener" href="' + esc(l.booking_join_url) + '">Join call</a>' : '') + (l.email ? '<a class="btn-sm ghost" href="mailto:' + esc(l.email) + '">Email</a>' : '') + (l.phone ? '<a class="btn-sm ghost" href="tel:' + esc(l.phone) + '">Call</a><a class="btn-sm ghost" target="_blank" rel="noopener" href="https://wa.me/' + esc(String(l.phone).replace(/\D/g, '')) + '">WhatsApp them</a>' : '') + '</div>' +
        '<div class="grid g-2">' +
        '<div class="card" id="ld-pipeline"><h2>Pipeline</h2><div class="pipe-grid">' +
        '<label>Status <select class="input" data-f="status">' + ((state.meta && state.meta.statuses) || []).map(function (s) { return '<option' + (s === l.status ? ' selected' : '') + '>' + esc(s) + '</option>'; }).join('') + '</select></label>' +
        '<label>' + esc('Tier (auto: ' + (l.tier || 'none') + ')') + ' <select class="input" data-f="tier_override"><option value="">' + esc('Use auto tier (' + (l.tier || 'none') + ')') + '</option><option' + (l.tier_override === 'A' ? ' selected' : '') + '>A</option><option' + (l.tier_override === 'B' ? ' selected' : '') + '>B</option><option' + (l.tier_override === 'C' ? ' selected' : '') + '>C</option></select></label>' +
        '<label>Closer ' + repSelect('closer_id', l.closer_id, function (r) { return r.role !== 'setter'; }) + '</label>' +
        '<label>Setter ' + repSelect('setter_id', l.setter_id, function () { return true; }) + '</label>' +
        '<label>Deal value (AUD) <input class="input" type="number" min="0" step="100" data-f="revenue" value="' + esc(l.revenue || 0) + '"></label>' +
        '<label>Cash collected (AUD) <input class="input" type="number" min="0" step="100" data-f="cash_collected" value="' + esc(l.cash_collected || 0) + '"></label>' +
        '<label>Lost reason <select class="input" data-f="lost_reason"><option value="">—</option>' + ((state.meta && state.meta.lostReasons) || []).map(function (r) { return '<option' + (r === l.lost_reason ? ' selected' : '') + '>' + esc(r) + '</option>'; }).join('') + '</select></label>' +
        '<label class="full">Notes<textarea class="notes" data-f="notes">' + esc(l.notes || '') + '</textarea></label>' +
        '<button class="btn-sm" data-save type="button">Save</button></div></div>' +
        '<div class="card"><h2>Profile</h2><dl class="kv" style="margin-top:10px">' +
        kv('Closer', repName(l.closer_id)) + kv('Call', l.call_at ? when(l.call_at) : l.booked_at ? 'booked (time pending)' : '–') +
        (l.booking_source === 'calendly-direct' ? kv('Booked via', 'Calendly link directly (not the funnel)') : '') +
        (l.booking_host_email ? kv('Calendly host', l.booking_host_email) : '') +
        (l.booking_answers ? (function () { try { return JSON.parse(l.booking_answers).map(function (x) { return kv(x.q, x.a); }).join(''); } catch (e) { return ''; } })() : '') +
        kv('Location', [l.city, l.country].filter(Boolean).join(', ')) + kv('Device', l.device) +
        kv('WhatsApp', l.whatsapp_connected_at ? 'connected ' + when(l.whatsapp_connected_at) : l.whatsapp_clicked_at ? 'clicked ' + when(l.whatsapp_clicked_at) : (l.whatsapp_opt_in ? 'opted in' : '–')) +
        kv('Email', l.unsubscribed_at ? 'unsubscribed' : 'subscribed') + kv('Phone calls', l.do_not_call_at ? 'do not call (since ' + when(l.do_not_call_at) + ')' : l.call_consent_at ? 'consented to AI calls ' + when(l.call_consent_at) : 'no call consent') + kv('Visits', d.sessions.length) + '</dl>' +
        // Ad-tracking fields, folded away: useful for checking attribution, not for the call.
        '<details class="more-rows"><summary>Tracking details</summary><dl class="kv">' +
        kv('Route', l.route) + kv('Last touch', [where(l.channel, l.utm_source, null, l.utm_medium), l.utm_campaign, l.utm_content].filter(Boolean).join(' / ')) + kv('First touch', [where(l.ft_channel, l.ft_source), l.ft_campaign, l.ft_content].filter(Boolean).join(' / ')) +
        kv('Click id', l.click_type ? l.click_type + ' ' + String(l.click_id).slice(0, 18) + '…' : '') + kv('Headline version', l.variant) + kv('Ref code', l.ref_code) + '</dl></details></div></div>' +
        dealCard(l) +
        '<div class="card" style="margin-top:14px" id="ld-contract" data-contracts><h2>Agreement</h2><p class="muted">Loading…</p></div>' +
        '<div class="grid g-2" style="margin-top:14px"><div class="card" id="ld-app"><h2>Application</h2><dl class="kv" style="margin-top:10px">' + d.answers.map(function (a) { return kv(a.question, a.answer); }).join('') + '</dl>' +
        (sc.breakdown ? '<p class="sub" style="margin-top:12px">Scoring: ' + esc(sc.breakdown.map(function (b) { return b.question + ' +' + b.points; }).join(', ')) + (sc.caps && sc.caps.length ? ' · capped: ' + esc(sc.caps.join(', ')) : '') + '</p>' : '') + '</div>' +
        '<div class="card" id="ld-video"><h2>Video</h2>' + (d.vsl.length ? d.vsl.map(function (v) {
          return '<div style="margin:10px 0"><div class="row"><strong>' + esc(v.video_id) + '</strong><span class="muted">' + esc(when(v.started_at)) + ' · ' + esc(v.duration ? pct(Math.min(1, v.max_position / v.duration)) : '–') + ' reached · ' + esc(secs(v.watched_seconds)) + ' watched' + (v.cta_clicked ? ' · clicked CTA' : '') + '</span></div><div class="mini-ret" aria-hidden="true">' + String(v.buckets).split('').map(function (b) { return '<i' + (b === '1' ? ' class="on"' : '') + '></i>'; }).join('') + '</div></div>';
        }).join('') : '<p class="muted">No video views recorded.</p>') +
        '<h2 id="ld-emails" style="margin-top:14px">Emails</h2>' + (d.emails.length ? table([{ label: 'Email', html: function (m) { return esc(m.template) + '<div class="muted">' + esc(m.sequence) + '</div>'; } }, { label: 'Status', key: 'status' }, { label: 'When', nw: true, html: function (m) { return esc(when(m.sent_at || m.send_at)); } }, { label: 'Opened', html: function (m) { return m.opened_at ? '✓' : ''; } }, { label: 'Clicked', html: function (m) { return m.clicked_at ? '✓' : ''; } }, { label: 'Personal', html: function (m) { return m.personalized && m.personalized !== 'off' ? '<span class="pill" title="' + esc(m.facts_used || '') + '">' + esc(m.personalized) + '</span>' : ''; } }], d.emails) : '<p class="muted">None.</p>') + '</div></div>' +
        '<div class="card" style="margin-top:14px" data-behaviour><div class="card-head"><div><h2>What they did → their emails</h2><p class="sub">Every email to this lead is rewritten around these, one or two at a time, never repeating.</p></div></div><p class="muted">Loading…</p></div>' +
        (d.calendly && d.calendly.length ? '<div class="card" id="ld-calendly" style="margin-top:14px"><h2>Calendly bookings · ' + d.calendly.length + '</h2>' + table([
          { label: 'Call', html: function (b) { return esc(when(b.start_at)); } },
          { label: 'Booked', html: function (b) { return esc(b.booked_at ? when(b.booked_at) : '–'); } },
          { label: 'Status', html: function (b) { return '<span class="pill">' + esc(b.rescheduled ? 'rescheduled' : b.status) + '</span>' + (b.cancel_reason ? ' <span class="muted">' + esc(b.cancel_reason) + '</span>' : ''); } },
          { label: 'Host', key: 'host_email' },
        ], d.calendly) + '</div>' : '') +
        (d.voice && d.voice.length ? '<div class="card" id="ld-calls" style="margin-top:14px"><h2>AI calls</h2>' + d.voice.map(voiceCall).join('') + '</div>' : '') +
        '<div class="card" id="ld-journey" style="margin-top:14px"><div class="card-head"><div><h2>Journey</h2><p class="sub">Every visit and action, server-side.</p></div><label class="muted"><input type="checkbox" data-all> show all events</label></div><ul class="timeline" data-tl>' + timeline() + '</ul></div>';

      dr.querySelector('.close').onclick = close;
      // The drawer is the scroller and its head is sticky: land each section just under the head.
      dr.querySelectorAll('[data-jump]').forEach(function (b) {
        b.onclick = function () {
          var t = dr.querySelector('#' + b.getAttribute('data-jump')), h = dr.querySelector('.drawer-head');
          if (!t) return;
          var top = t.getBoundingClientRect().top - dr.getBoundingClientRect().top + dr.scrollTop;
          dr.scrollTo({ top: Math.max(0, top - (h ? h.offsetHeight : 0) - 8), behavior: 'smooth' });
        };
      });
      loadBehaviour(dr, id);
      loadPayments(dr, id);
      loadContracts(dr.querySelector('[data-contracts]'), l);
      dr.querySelector('[data-all]').onchange = function (e) { showAll = e.target.checked; dr.querySelector('[data-tl]').innerHTML = timeline(); };
      dr.querySelector('[data-save]').onclick = function () {
        var body = {};
        dr.querySelectorAll('[data-f]').forEach(function (f) { body[f.getAttribute('data-f')] = f.value; });
        send('PATCH', 'leads/' + encodeURIComponent(id), body).then(function (r) { toast(r.ok ? 'Saved' : (r.error || 'Could not save')); if (state.tab === 'leads' || state.tab === 'sales') load(); });
      };
    });
  }

  // ───────────── sales team ─────────────
  function reps() { return (state.meta && state.meta.closers) || []; }
  function repName(id) { if (!id) return 'Unassigned'; var r = reps().filter(function (x) { return x.id === id; })[0]; return r ? r.name : id; }
  function repSelect(field, current, keep) {
    var list = reps().filter(keep);
    if (current && !list.some(function (r) { return r.id === current; })) list.push({ id: current, name: current + ' (inactive)' });
    return '<select class="input" data-f="' + field + '"><option value="">— Unassigned</option>' + list.map(function (r) { return '<option value="' + esc(r.id) + '"' + (r.id === current ? ' selected' : '') + '>' + esc(r.name) + '</option>'; }).join('') + '</select>';
  }
  function personName(r) { return [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || r.id; }
  function refreshMeta() { return fetch('/admin/api/meta', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (m) { state.meta = m; }); }
  var STATUS_LABEL = { showed: 'Held', won: 'Won', lost: 'Lost', no_show: 'No-show' };

  function renderSales() {
    return api('sales').then(function (d) {
      var t = d.totals;
      setNavBadge('sales', d.needsOutcome ? d.needsOutcome.length : 0);
      var lead = function (r) { return '<a href="#lead=' + esc(r.id) + '" data-open="' + esc(r.id) + '">' + esc(personName(r)) + '</a>'; };
      var bar = function (v) { return v == null ? '<span class="muted">no target</span>' : '<div class="target"><i style="width:' + Math.min(100, v * 100).toFixed(1) + '%"></i></div><small>' + pct(v) + '</small>'; };
      view.innerHTML =
        (d.notify ? '' : '<div class="card notice"><b>Team pings are off.</b> Add a Slack or Discord webhook under <a href="#integrations" data-go="integrations">Integrations → Alerts</a> to get hot leads, bookings, call reminders and closed deals in your channel.</div>') +
        '<div class="grid g-4 tiles">' +
        tile('Calls in range', n(t.booked), 'scheduled in range · ' + n(t.upcoming) + ' upcoming') +
        // Show rate only counts calls with an outcome: say how many past calls aren't logged yet.
        tile('Show rate', pct(t.show_rate), n(t.held) + ' held · ' + n(t.no_shows) + ' no-shows' + (d.needsOutcome && d.needsOutcome.length ? ' · ' + n(d.needsOutcome.length) + ' not logged yet' : '')) +
        tile('Close rate', pct(t.close_rate), n(t.won) + ' won · ' + n(t.lost) + ' lost') +
        tile('Revenue', money(t.revenue), money(t.cash) + ' cash · avg ' + money(t.avg_deal)) + '</div>' +
        (d.needsOutcome.length ? '<div class="card" style="margin-top:14px"><h2>Needs an outcome · ' + n(d.needsOutcome.length) + '</h2><p class="sub">These calls have passed. Log what happened — it triggers the right follow-up emails, the Meta conversion and the team ping.</p>' +
          '<div class="todo todo-out">' + table([
            { label: 'Lead', html: lead },
            { label: 'Tier', nw: true, html: function (r) { return tierCell({ tier: r.tier, status: 'booked' }); } },
            { label: 'Call', nw: true, html: function (r) { return '<span class="muted">' + esc(r.call_at ? when(r.call_at) : 'booked ' + when(r.booked_at)) + '</span>'; } },
            { label: 'Closer', nw: true, html: function (r) { return esc(repName(r.closer_id)); } },
            { label: '', html: function (r) { return '<div class="row outcome" data-lead="' + esc(r.id) + '"><button class="btn-sm ghost" data-out="showed">Held</button><button class="btn-sm ghost" data-out="no_show">No-show</button><button class="btn-sm ghost" data-out="won">Won…</button><button class="btn-sm ghost" data-out="lost">Lost…</button></div>'; } },
          ], d.needsOutcome) + '</div></div>' : '') +
        '<div class="card" style="margin-top:14px" data-sec="upcoming"><h2>Upcoming calls · ' + n(d.upcoming.length) + '</h2><p class="sub">Next 14 days. Reps get pinged 15 minutes before each one.</p>' +
        '<div class="todo todo-up">' + table([
          { label: 'When', nw: true, html: function (r) { return esc(when(r.call_at)); } },
          { label: 'Lead', html: function (r) { return lead(r) + (r.tier ? ' <span class="tier ' + esc(r.tier) + '">' + esc(r.tier) + '</span>' : ''); } },
          { label: 'Closer', nw: true, html: function (r) { return esc(repName(r.closer_id)); } },
          { label: 'VSL', num: true, html: function (r) { return '<span class="todo-k">Watched </span>' + esc(r.vsl_pct ? pct(Math.min(1, r.vsl_pct)) : '–'); } },
          { label: 'Source', html: function (r) { return '<span class="muted">' + esc([where(r.channel, r.utm_source, r.referrer_host, r.utm_medium), r.utm_content].filter(Boolean).join(' / ')) + '</span>'; } },
        ], d.upcoming, { empty: 'No calls booked in the next 14 days.' }) + '</div></div>' +
        '<div class="card" style="margin-top:14px"><h2>Leaderboard</h2><p class="sub">Calls scheduled and deals closed in this range. Commission is on cash collected. Target bar is month to date (' + esc(d.tz) + ').</p>' +
        table([
          { label: 'Rep', html: function (r) { return '<b>' + esc(r.name) + '</b>' + (r.id ? '' : ' <span class="muted">(no closer set)</span>'); } },
          { label: 'Booked', key: 'booked', num: true, fmt: n },
          { label: 'Held', key: 'held', num: true, fmt: n },
          { label: 'Show', key: 'show_rate', num: true, fmt: function (v) { return pct(v); } },
          { label: 'Won', key: 'won', num: true, fmt: n },
          { label: 'Close', key: 'close_rate', num: true, fmt: function (v) { return pct(v); } },
          { label: 'Revenue', key: 'revenue', num: true, fmt: money },
          { label: 'Cash', key: 'cash', num: true, fmt: money },
          { label: 'Commission', key: 'commission', num: true, fmt: money },
          { label: 'MTD vs target', html: function (r) { return '<div class="target-cell">' + bar(r.target_progress) + '</div>'; } },
        ], d.leaderboard) + '</div>' +
        '<div class="card" style="margin-top:14px"><div class="card-head wrap-head"><div><h2>Call log</h2><p class="sub">Every past call. Fill in what happened: logging old calls never emails anyone or sends conversions to ads, and the outcome is dated to the call.</p></div>' +
        '<div class="row"><select class="input" data-cl-tier><option value="">All tiers</option><option>A</option><option>B</option><option>C</option></select><label class="muted"><input type="checkbox" data-cl-unlogged checked> only unlogged</label></div></div><div data-calllog><p class="muted">Loading…</p></div></div>' +
        '<div class="card" style="margin-top:14px"><h2>Recent outcomes</h2>' +
        table([
          { label: 'When', nw: true, html: function (r) { return esc(when(r.closed_at || r.showed_at || r.updated_at)); } },
          { label: 'Lead', html: lead },
          { label: 'Outcome', html: function (r) { return '<span class="pill out-' + esc(r.status) + ' st-' + esc(String(r.status || '').replace(/[^a-z_]/gi, '')) + '">' + esc(STATUS_LABEL[r.status] || r.status) + '</span>' + (r.lost_reason ? ' <span class="muted">' + esc(r.lost_reason) + '</span>' : ''); } },
          { label: 'Value', num: true, nw: true, html: function (r) { return r.status === 'won' ? esc(money(r.revenue)) + '<div class="muted">' + esc(money(r.cash_collected)) + ' cash</div>' : ''; } },
          { label: 'Closer', nw: true, html: function (r) { return esc(repName(r.closer_id)); } },
          { label: 'Source', html: function (r) { var src = [where(r.channel, r.utm_source, r.referrer_host, r.utm_medium), r.utm_campaign, r.utm_content].filter(Boolean).join(' / '); return '<div class="muted ell" style="max-width:260px" title="' + esc(src) + '">' + esc(src) + '</div>'; } },
        ], d.recent, { cards: true }) + '</div>' +
        // Lost reasons: a full chart when there are some, one quiet line when there are none.
        (d.lostReasons.length ? '<div class="card" style="margin-top:14px"><h2>Why deals are lost</h2><p class="sub">Lost reasons logged in this range.</p>' + barList(d.lostReasons.map(function (r) { return { name: r.reason, value: r.n }; })) + '</div>'
          : '<div class="card compact-line" style="margin-top:14px"><b>Why deals are lost</b><span class="muted">No losses logged in this range. Reasons appear here when you mark a call Lost.</span></div>') +
        (d.calendlyMonthly && d.calendlyMonthly.length ? '<div class="card" style="margin-top:14px"><h2>Calendly history</h2><p class="sub">Every booking on Josh’s Calendly by month (reschedules counted once), including ones from before the funnel.' + (t.older_unlogged ? ' ' + n(t.older_unlogged) + ' calls older than 30 days have no outcome logged; open them from Leads to fill them in.' : '') + '</p>' +
          table([
            { label: 'Month', key: 'month' },
            { label: 'Booked', key: 'booked', num: true, fmt: n },
            { label: 'Kept', key: 'kept', num: true, fmt: n },
            { label: 'Cancelled', key: 'canceled', num: true, fmt: n },
            { label: 'No-shows', key: 'no_shows', num: true, fmt: n },
            { label: 'Cancel rate', num: true, zeroOk: true, html: function (r) { return esc(pct(r.booked ? r.canceled / r.booked : 0)); } },
            { label: 'People', key: 'people', num: true, fmt: n },
          ], d.calendlyMonthly) + '</div>' : '');

      view.querySelectorAll('[data-open]').forEach(function (a) { a.onclick = function (ev) { ev.preventDefault(); openLead(a.getAttribute('data-open')); }; });
      view.querySelectorAll('[data-go]').forEach(function (a) { a.onclick = function (ev) { ev.preventDefault(); go(a.getAttribute('data-go')); }; });
      // The call log only lists calls with a known time; booked-without-a-time calls live in "Needs an outcome" above.
      var noTime = (d.needsOutcome || []).filter(function (r) { return !r.call_at; }).length;
      var noTimeMsg = function () {
        if (!view.querySelector('[data-cl-unlogged]').checked || !noTime) return 'Nothing to log here.';
        return 'No other past calls to log. The ' + n(noTime) + (noTime === 1 ? ' call without a scheduled time is' : ' calls without a scheduled time are') + ' in “Needs an outcome” above.';
      };
      var drawLog = function () {
        var box = view.querySelector('[data-calllog]');
        api('sales/calls', { tier: view.querySelector('[data-cl-tier]').value, unlogged: view.querySelector('[data-cl-unlogged]').checked ? 1 : '' }, { noRange: true }).then(function (r) {
          var m = state.meta || {};
          var sel = function (f, list, cur, blank) { return '<select class="input" data-cf="' + f + '">' + opts(list, cur, blank) + '</select>'; };
          box.innerHTML = r.calls.length ? '<div class="table-wrap"><table class="calllog"><thead><tr><th>Call</th><th>Lead</th><th>Tier</th><th>Revenue</th><th>Outcome</th><th>Temp</th><th>Objection</th><th class="num">Deal $</th><th class="num">Cash $</th><th></th></tr></thead><tbody>' +
            r.calls.map(function (c) {
              return '<tr data-id="' + esc(c.id) + '"><td>' + esc(when(c.call_at)) + '</td><td><a href="#lead=' + esc(c.id) + '" data-open="' + esc(c.id) + '">' + esc(personName(c)) + '</a><div class="muted">' + esc((c.industry || '').slice(0, 40)) + '</div></td>' +
                '<td>' + (c.tier ? '<span class="tier ' + esc(c.tier) + '">' + esc(c.tier) + '</span>' : '–') + '</td><td class="muted">' + esc(c.revenue_band || '–') + '</td>' +
                '<td>' + sel('status', ['booked', 'showed', 'no_show', 'won', 'lost', 'disqualified'], c.status) + '</td>' +
                '<td>' + sel('temperature', m.temperatures, c.temperature, '—') + '</td><td>' + sel('objection', m.objections, c.objection, '—') + '</td>' +
                '<td class="num"><input class="input" data-cf="revenue" type="number" step="500" value="' + esc(c.revenue || '') + '" style="width:100px"></td>' +
                '<td class="num"><input class="input" data-cf="cash_collected" type="number" step="500" value="' + esc(c.cash_collected || '') + '" style="width:100px"></td>' +
                '<td><button class="btn-sm" data-cl-save>Save</button></td></tr>';
            }).join('') + '</tbody></table></div><p class="muted" style="margin-top:6px">' + r.calls.length + ' calls</p>' : emptyState(noTimeMsg());
          box.querySelectorAll('[data-open]').forEach(function (a) { a.onclick = function (ev) { ev.preventDefault(); openLead(a.getAttribute('data-open')); }; });
          box.querySelectorAll('[data-cl-save]').forEach(function (b) {
            b.onclick = function () {
              var tr = b.closest('tr'), body = {};
              tr.querySelectorAll('[data-cf]').forEach(function (x) { body[x.getAttribute('data-cf')] = x.value; });
              if (body.status === 'lost' && !body.lost_reason) body.lost_reason = body.objection || 'Other';
              b.disabled = true;
              send('PATCH', 'leads/' + encodeURIComponent(tr.getAttribute('data-id')), body).then(function (res) { b.disabled = false; toast(res.ok ? 'Saved' : (res.error || 'Could not save')); if (res.ok) tr.classList.add('saved'); });
            };
          });
        });
      };
      view.querySelector('[data-cl-tier]').onchange = drawLog;
      view.querySelector('[data-cl-unlogged]').onchange = drawLog;
      drawLog();
      view.querySelectorAll('.outcome [data-out]').forEach(function (b) {
        b.onclick = function () {
          var id = b.closest('[data-lead]').getAttribute('data-lead'), status = b.getAttribute('data-out'), body = { status: status };
          if (status === 'won') {
            var v = prompt('Deal value (AUD)?'); if (v == null) return;
            var cash = prompt('Cash collected so far (AUD)?', v); if (cash == null) return;
            body.revenue = Number(String(v).replace(/[^\d.]/g, '')) || 0; body.cash_collected = Number(String(cash).replace(/[^\d.]/g, '')) || 0;
          } else if (status === 'lost') {
            var list = (state.meta.lostReasons || []);
            var pick = prompt('Why was it lost?\n' + list.map(function (r, i) { return (i + 1) + '. ' + r; }).join('\n') + '\n\nType a number:'); if (pick == null) return;
            body.lost_reason = list[(+pick || 0) - 1] || 'Other';
          }
          b.disabled = true;
          send('PATCH', 'leads/' + encodeURIComponent(id), body).then(function (r) { toast(r.ok ? 'Logged — team notified' : (r.error || 'Could not save')); load(); });
        };
      });
    });
  }



  function renderLanders() {
    return Promise.all([api('landers'), api('experiments')]).then(function (res) {
      var d = res[0], x = res[1];
      var origin = location.origin;
      var params = 'utm_source=facebook&utm_medium=paid&utm_campaign={{campaign.name}}&utm_term={{adset.name}}&utm_content={{ad.name}}&campaign_id={{campaign.id}}&adset_id={{adset.id}}&ad_id={{ad.id}}&placement={{placement}}&site_source_name={{site_source_name}}';
      var rate = function (v) { return pct(v, 1); };
      // "3 · 4.2%" on one line; a zero count reads as a quiet dash instead of "0 0.0%".
      var countRate = function (c, v) { return Number(c) ? esc(n(c)) + ' <span class="muted">' + esc(rate(v)) + '</span>' : '<span class="muted" title="None">–</span>'; };
      var sel = state.landerIndustry || '';
      var rows = d.rows.filter(function (r) { return !sel || r.industry === sel; });
      // No industry picked: landers with traffic first, the ones still waiting for visitors folded away.
      var active = rows, idle = [];
      if (!sel) {
        active = rows.filter(function (r) { return r.visitors > 0 || r.leads > 0; }).sort(function (a, b) { return (b.visitors - a.visitors) || (b.share - a.share); });
        idle = rows.filter(function (r) { return !(r.visitors > 0 || r.leads > 0); });
        if (!active.length) { active = rows.slice(0, 10); idle = rows.slice(10); }
      }
      var landerCols = [
        { label: 'Lander', html: function (r) { return '<b>' + esc(r.industry_label) + '</b> · ' + esc(r.angle_label) + '<div class="muted lander-h" title="' + esc(r.headline) + '">' + esc(r.headline) + '</div>'; } },
        { label: 'Traffic now', num: true, html: function (r) { return '<div class="target-cell"><div class="target"><i style="width:' + (r.share * 100).toFixed(1) + '%"></i></div><small>' + pct(r.share) + '</small></div>'; } },
        { label: 'Visitors', key: 'visitors', num: true, fmt: n }, { label: 'Played', key: 'plays', num: true, fmt: n },
        { label: 'Applied', num: true, html: function (r) { return n(r.leads) + ' <span class="muted">' + rate(r.lead_rate) + '</span>'; } },
        { label: 'Qualified', num: true, html: function (r) { return n(r.qualified) + (r.tier_a ? ' <span class="muted">(' + r.tier_a + ' A)</span>' : ''); } },
        { label: 'Booked', key: 'booked', num: true, fmt: n }, { label: 'Won', key: 'won', num: true, fmt: n }, { label: 'Cash', key: 'cash', num: true, fmt: money },
        { label: 'Own link', html: function (r) { return linkCell(origin + '/' + r.industry + '/' + r.angle) + ' <a class="btn-sm ghost" target="_blank" rel="noopener" href="/for/' + esc(r.industry) + '/' + esc(r.angle) + '?preview=1">Preview</a>'; } },
      ];
      var activeCount = sel ? rows.filter(function (r) { return r.visitors > 0 || r.leads > 0; }).length : active.filter(function (r) { return r.visitors > 0 || r.leads > 0; }).length;
      var idleCount = rows.length - activeCount;
      // All pages side by side: the main page's headline variants and each industry's landers.
      var pageRows = x.variants.map(function (v) { return { page: 'Main page · headline ' + v.id.toUpperCase(), visitors: v.visitors, lead_rate: v.lead_rate, qualified_rate: v.qualified_rate, booked_rate: v.booked_rate, note: v.lift == null ? 'control' : (v.significant ? 'significant ' : '') + (v.lift > 0 ? '+' : '') + pct(v.lift, 1) + ' vs A' }; })
        .concat(d.byIndustry.filter(function (r) { return r.visitors; }).map(function (r) { return { page: r.label + ' landers', visitors: r.visitors, lead_rate: r.lead_rate, qualified_rate: r.qualified_rate, booked_rate: r.visitors ? r.booked / r.visitors : 0, note: r.best ? 'leading: ' + r.best : 'still exploring' }; }));
      // Every split-test page's own URL, in one list to copy into ads or a sheet.
      var allLinks = [['Main page (splits A/B)', origin + '/']].concat(
        x.variants.filter(function (v) { return v.slug; }).map(function (v) { return ['Main page · headline ' + v.id.toUpperCase(), origin + '/' + v.slug]; }),
        d.industries.map(function (i) { return [i.label + ' (best headline wins)', origin + '/' + i.id]; }),
        d.rows.map(function (r) { return [r.industry_label + ' · ' + r.angle_label, origin + '/' + r.industry + '/' + r.angle]; }));
      var allText = allLinks.map(function (l) { return l[0] + '\t' + l[1]; }).join('\n');
      view.innerHTML =
        '<div class="card"><div class="card-head"><div><h2>Every page’s own link</h2><p class="sub">' + esc(n(allLinks.length)) + ' links. Each split-test page has its own address, so you can point an ad at exactly one version. People who arrive on a link always see that version, and it still counts in the tests below. “Industry” links let the test pick the best headline; “industry / headline” links fix one.</p></div>' +
        '<button class="btn-sm" data-copylink="' + esc(allText) + '">Copy all ' + esc(n(allLinks.length)) + '</button></div>' +
        '<details class="more-rows"><summary>Show all links</summary>' + table([{ label: 'Page', html: function (l) { return esc(l[0]); } }, { label: 'Link', html: function (l) { return linkCell(l[1]); } }], allLinks, { cards: true }) + '</details></div>' +
        '<div class="card" style="margin-top:14px"><h2>All pages compared</h2><p class="sub">Same funnel behind every page: VSL → application → booking. Compare rates, not raw counts.</p>' + table([
          { label: 'Page', key: 'page' }, { label: 'Visitors', key: 'visitors', num: true, fmt: n },
          { label: 'Applied', key: 'lead_rate', num: true, fmt: function (v) { return pct(v, 1); } },
          { label: 'Qualified', key: 'qualified_rate', num: true, fmt: function (v) { return pct(v, 1); } },
          { label: 'Booked', key: 'booked_rate', num: true, fmt: function (v) { return pct(v, 1); } },
          { label: '', html: function (r) { return '<span class="muted">' + esc(r.note) + '</span>'; } },
        ], pageRows, { cards: true }) + '</div>' +
        '<div class="card" style="margin-top:14px"><h2>Main page headline test</h2><p class="sub">Visitors to the main page (/) are split between these headlines. Judged on applications per visitor; significance from a two-proportion z-test vs. A (p &lt; 0.05). Each headline also has its own link: people who land there always see that headline and count towards it.</p>' +
        table([
          { label: 'Variant', html: function (r) { return '<strong>' + esc(r.id.toUpperCase()) + '</strong> <span class="muted">' + esc(r.weight) + '%</span><div class="muted lander-h" title="' + esc(r.headline) + '">' + esc(r.headline) + '</div>' + (r.slug ? '<div class="muted">' + linkCell(origin + '/' + r.slug) + '</div>' : ''); } },
          { label: 'Visitors', key: 'visitors', num: true, fmt: n },
          { label: 'Play', key: 'play_rate', num: true, fmt: function (v) { return pct(v); } },
          { label: 'Pitch', key: 'pitch_rate', num: true, fmt: function (v) { return pct(v); } },
          { label: 'Applied', key: 'lead_rate', num: true, fmt: function (v) { return pct(v, 1); } },
          { label: 'Qualified', key: 'qualified_rate', num: true, fmt: function (v) { return pct(v, 1); } },
          { label: 'Booked', key: 'booked_rate', num: true, fmt: function (v) { return pct(v, 1); } },
          { label: 'Result', html: function (r) { return r.p_value == null ? '<span class="muted">control</span>' : r.significant ? '<span class="pill ok">✓ significant (p=' + r.p_value.toFixed(3) + ')</span>' : '<span class="pill">not yet (p=' + r.p_value.toFixed(2) + ')</span>'; } },
        ], x.variants, { cards: true }) + '</div>' +
        '<h3 class="section-h">Industry landers</h3>' +
        '<div class="card"><h2>Meta ad links</h2><p class="sub">Pick the industry the ad set targets. Paste the website URL into the ad and the parameters into Meta’s “URL parameters” box. Or use the auto link everywhere: it reads the industry from your campaign, ad set or ad name (name them like “Dental – Lookalike”).</p>' +
        '<div class="row" style="margin:10px 0"><select class="input" data-ml-ind><option value="">Auto-detect from ad names</option>' + d.industries.map(function (i) { return '<option value="' + esc(i.id) + '">' + esc(i.label) + '</option>'; }).join('') + '</select></div>' +
        '<dl class="kv"><dt>Website URL</dt><dd><span class="mono" data-ml-url></span> <button class="btn-sm ghost" data-copy="url">Copy</button></dd><dt>URL parameters</dt><dd><span class="mono" style="word-break:break-all">' + esc(params) + '</span> <button class="btn-sm ghost" data-copy="params">Copy</button></dd></dl>' +
        '<p class="muted" style="margin-top:8px" data-ml-kw></p></div>' +
        '<div class="card" style="margin-top:14px"><h2>By industry</h2><p class="sub">Industries with visitors or applications in this range.</p>' + table([
          { label: 'Industry', key: 'label' }, { label: 'Visitors', key: 'visitors', num: true, fmt: n }, { label: 'Applied', num: true, nw: true, html: function (r) { return countRate(r.leads, r.lead_rate); } },
          { label: 'Qualified', num: true, nw: true, html: function (r) { return countRate(r.qualified, r.qualified_rate); } }, { label: 'Booked', key: 'booked', num: true, fmt: n }, { label: 'Won', key: 'won', num: true, fmt: n }, { label: 'Cash', key: 'cash', num: true, fmt: money },
          { label: 'Leading headline', html: function (r) { return esc(r.best || '–'); } },
        ], d.byIndustry.filter(function (r) { return r.visitors || r.leads; }), { cards: true }) + '</div>' +
        '<div class="card" style="margin-top:14px"><h2>By headline angle</h2><p class="sub">Across all industries.</p>' + table([
          { label: 'Angle', key: 'label', nw: true }, { label: 'Visitors', key: 'visitors', num: true, fmt: n }, { label: 'Applied', num: true, nw: true, html: function (r) { return countRate(r.leads, r.lead_rate); } },
          { label: 'Qualified', num: true, nw: true, html: function (r) { return countRate(r.qualified, r.qualified_rate); } }, { label: 'Booked', key: 'booked', num: true, fmt: n }, { label: 'Cash', key: 'cash', num: true, fmt: money },
          { label: 'Works best in', html: function (r) { return esc(r.best || '–'); } },
        ], d.byAngle, { cards: true }) + '</div>' +
        '<div class="card" style="margin-top:14px"><div class="card-head"><div><h2>All landers</h2><p class="sub">“Traffic now” is the share of new visitors each headline would get today. Every headline gets its first 60 visitors before the split starts to move.' + esc(' · ' + n(activeCount) + ' with traffic, ' + n(idleCount) + ' waiting') + '</p></div>' +
        '<select class="input" data-ld-ind><option value="">All industries</option>' + d.industries.map(function (i) { return '<option value="' + esc(i.id) + '"' + (sel === i.id ? ' selected' : '') + '>' + esc(i.label) + '</option>'; }).join('') + '</select></div>' +
        table(landerCols, active, { cards: true }) +
        (idle.length ? '<details class="more-rows"><summary>' + esc('Show the other ' + idle.length + ' landers with no visitors yet') + '</summary>' + table(landerCols, idle, { cards: true }) + '</details>' : '') + '</div>';
      var indSel = view.querySelector('[data-ml-ind]');
      var draw = function () {
        var id = indSel.value, ind = d.industries.filter(function (i) { return i.id === id; })[0];
        view.querySelector('[data-ml-url]').textContent = id ? origin + '/' + id : origin + '/m';
        view.querySelector('[data-ml-kw]').textContent = id ? 'Visitors get one of 5 ' + ind.label + ' headlines; the best one gets more traffic over time.' : 'Detects: ' + d.industries.map(function (i) { return i.label + ' (' + i.keywords.slice(0, 3).join(', ') + ')'; }).join(' · ') + '. No match → the main page.';
      };
      indSel.onchange = draw; draw();
      view.querySelectorAll('[data-copy]').forEach(function (b) { b.onclick = function () { var t = b.getAttribute('data-copy') === 'url' ? view.querySelector('[data-ml-url]').textContent : params; navigator.clipboard.writeText(t).then(function () { toast('Copied'); }); }; });
      view.querySelector('[data-ld-ind]').onchange = function (e) { state.landerIndustry = e.target.value; load(); };
    });
  }


  function renderBehaviour() {
    var path = state.bhPath || '';
    return api('behaviour', { path: path }).then(function (d) {
      var card = function (title, sub, body) { return '<div class="card"><h2>' + esc(title) + '</h2>' + (sub ? '<p class="sub">' + esc(sub) + '</p>' : '') + body + '</div>'; };
      var none = emptyState('No data in this range yet.');
      var tb = d.tabs || {};
      var firstTouch = (d.firsts || []).reduce(function (a, r) { return a + r.n; }, 0);
      // Click density down the page (where on the page people click), per page.
      var zoneBars = {};
      (d.zones || []).forEach(function (z) { (zoneBars[z.path] = zoneBars[z.path] || []).push(z); });
      var zonesHtml = Object.keys(zoneBars).slice(0, 4).map(function (pth) {
        var list = zoneBars[pth], max = Math.max.apply(null, list.map(function (z) { return z.n; }));
        return '<div class="zone-col"><div class="mono">' + esc(pth) + '</div><div class="zone-strip">' + [0, 10, 20, 30, 40, 50, 60, 70, 80, 90].map(function (b) {
          var z = list.filter(function (x) { return x.band === b; })[0], v = z ? Number(z.n) || 0 : 0, h = v / (max || 1);
          return '<div class="zone' + (h > 0.55 ? ' hot' : '') + '" title="' + b + '–' + (b + 10) + '% down the page: ' + v + ' clicks" style="--h:' + h.toFixed(2) + '"><span>' + b + '%</span><b>' + (v || '') + '</b></div>';
        }).join('') + '</div><div class="zone-legend muted">top of page ↓ bottom</div></div>';
      }).join('');
      view.innerHTML =
        '<div class="row" style="margin-bottom:12px"><select class="input" data-bh-path><option value="">All pages</option>' + (d.pages || []).map(function (p) { return '<option value="' + esc(p.path) + '"' + (p.path === path ? ' selected' : '') + '>' + esc(p.path) + ' (' + n(p.visitors) + ')</option>'; }).join('') + '</select></div>' +
        '<div class="grid g-4 tiles">' +
        tile('Tab switches', n(tb.returns || 0), n(tb.sessions || 0) + ' visits left and came back · avg ' + (tb.avg_away ? secs(tb.avg_away) : '–') + ' away') +
        tile('Dead clicks', n((d.dead || []).reduce(function (a, r) { return a + r.n; }, 0)), 'Clicks on things that do nothing') +
        tile('CTA hesitations', n((d.hovers || []).reduce(function (a, r) { return a + r.people; }, 0)), 'Hovered a button, didn’t click') +
        tile('First interaction', (d.firsts || []).length ? secs((d.firsts.reduce(function (a, r) { return a + r.avg_ms * r.n; }, 0) / (firstTouch || 1)) / 1000) : '–', 'Average time before they scroll, tap or type') + '</div>' +
        '<div class="grid g-2" style="margin-top:14px">' +
        card('What people click', 'Ranked by people, not clicks.', (d.clicks || []).length ? table([
          { label: 'Element', html: function (r) { return esc(r.text || r.el) + '<div class="muted mono">' + esc(r.path + ' · ' + (r.section || '–')) + '</div>'; } },
          { label: 'People', key: 'people', num: true, fmt: n }, { label: 'Clicks', key: 'n', num: true, fmt: n },
        ], d.clicks.slice(0, 15)) : none) +
        card('Where on the page they click', 'Each band is a tenth of the page, top to bottom; deeper blue means more clicks.', zonesHtml ? '<div class="zones">' + zonesHtml + '</div>' : none) + '</div>' +
        card('Form friction', 'Per field: how long people spend, how often they correct themselves, paste, or leave it empty. Values are never recorded.', (d.fields || []).length ? table([
          { label: 'Field', key: 'field' }, { label: 'People', key: 'people', num: true, fmt: n },
          { label: 'Avg time', num: true, html: function (r) { return esc(r.avg_s + 's'); } },
          { label: 'Corrections', key: 'corrections', num: true },
          { label: 'Pasted', num: true, html: function (r) { return esc(pct(r.paste_rate)); } },
          { label: 'Left empty', num: true, html: function (r) { return '<span' + (r.empty_rate > 0.3 ? ' class="bad"' : '') + '>' + esc(pct(r.empty_rate)) + '</span>'; } },
        ], d.fields) : none) +
        '<div class="grid g-2" style="margin-top:14px">' +
        card('Where they leave', 'The section on screen when they closed the page.', (d.exits || []).length ? table([
          { label: 'Page · section', html: function (r) { return esc(r.path) + ' · <b>' + esc(r.section) + '</b>'; } }, { label: 'Exits', key: 'n', num: true, fmt: n },
          { label: 'Scrolled', num: true, html: function (r) { return esc(r.scroll + '%'); } }, { label: 'Time', num: true, html: function (r) { return esc(secs(r.seconds)); } },
          { label: 'Never interacted', num: true, html: function (r) { return esc(pct(1 - r.interacted)); } },
        ], d.exits.slice(0, 12)) : none) +
        card('Dead & rage clicks', 'Things people expect to be clickable. Make them links, or make them look less like links.', (d.dead || []).length ? table([
          { label: 'Element', html: function (r) { return esc(r.el) + '<div class="muted mono">' + esc(r.path + ' · ' + (r.section || '–')) + '</div>'; } }, { label: 'People', key: 'people', num: true, fmt: n }, { label: 'Clicks', key: 'n', num: true, fmt: n },
        ], d.dead) : none) + '</div>' +
        '<div class="grid g-3" style="margin-top:14px">' +
        card('Sections re-read', 'Scrolled away, then came back.', (d.revisits || []).length ? barList(d.revisits.map(function (r) { return { name: r.section + (state.bhPath ? '' : ' · ' + r.path), value: r.people }; })) : none) +
        card('Button hesitation', 'Hovered without clicking (avg time hovering).', (d.hovers || []).length ? table([{ label: 'Button', html: function (r) { return esc(r.id) + '<div class="muted mono">' + esc(r.path) + '</div>'; } }, { label: 'People', key: 'people', num: true, fmt: n }, { label: 'Avg', num: true, html: function (r) { return esc(r.avg_s + 's'); } }], d.hovers) : none) +
        card('What they highlight & copy', 'Text people selected or copied: what they’re weighing up.', ((d.selects || []).length || (d.copies || []).length) ? '<ul class="quotes">' + (d.copies || []).map(function (r) { return '<li><b>copied</b> “' + esc(r.text) + '” <span class="muted">×' + r.people + '</span></li>'; }).join('') + (d.selects || []).map(function (r) { return '<li>“' + esc(r.text) + '” <span class="muted">×' + r.people + '</span></li>'; }).join('') + '</ul>' : none) + '</div>';
      view.querySelector('[data-bh-path]').onchange = function (e) { state.bhPath = e.target.value; load(); };
    });
  }

  function renderInsights() {
    return api('insights', null, { noRange: true }).then(function (d) {
      var T = d.byTier, a = d.a;
      var tierRow = function (k, label) { var t = T[k]; return Object.assign({ tier: label }, t); };
      var bars = function (title, list, sub) { return '<div class="card"><h2>' + esc(title) + '</h2>' + (sub ? '<p class="sub">' + esc(sub) + '</p>' : '') + (list && list.length ? barList(list.slice(0, 10).map(function (x) { return { name: x.k, value: x.n, note: pct(x.n / (a.people || 1)) }; })) : emptyState('No data.')) + '</div>'; };
      var orNull = function (v) { return v == null ? '–' : pct(v); };
      // A-tier cards: only the ones with answers; the empty ones are named in one quiet line (each card comes back by itself once it has data).
      var cards = [['Revenue', a.revenue_bands], ['Sector', a.sectors, 'Grouped from what they typed'], ['Budget for advisory', a.budgets], ['What they want help with', a.help], ['What applies to them', a.statements], ['Who they are', a.describes], ['Call day', a.call_weekday, 'In the sales team’s time zone'], ['Call time', a.call_hour], ['Status now', (a.statuses || []).map(function (x) { return Object.assign({}, x, { k: String(x.k == null ? '' : x.k).charAt(0).toUpperCase() + String(x.k == null ? '' : x.k).slice(1) }); })], ['Booked by month', a.booked_month]];
      var empty = [], full = [];
      cards.forEach(function (c) { if (c[1] && c[1].length) full.push(bars(c[0], c[1], c[2])); else empty.push(c[0]); });
      if (a.notes && a.notes.length) full.push('<div class="card"><h2>In their own words</h2><p class="sub">What A-tier bookers wrote in the booking form.</p><ul class="quotes">' + a.notes.map(function (q) { return '<li>“' + esc(q) + '”</li>'; }).join('') + '</ul></div>');
      else empty.push('In their own words');
      var hasInd = a.industries && a.industries.length;
      if (!hasInd) empty.push('Industries (as typed)');
      // No lonely card with empty columns beside it: 4 cards sit 2 × 2; an odd one left over on a 3-wide row takes the whole row.
      var cols = full.length % 3 === 0 ? 3 : full.length % 2 === 0 ? 2 : 3;
      if (cols === 3 && full.length % 3 === 1) full[full.length - 1] = full[full.length - 1].replace('<div class="card">', '<div class="card" style="grid-column:1/-1">');
      var aTier = (full.length ? '<div class="grid g-' + cols + '">' + full.join('') + '</div>' : '') +
        (hasInd ? '<div class="card" style="margin-top:14px"><h2>Industries (as typed)</h2><p>' + a.industries.map(function (x) { return '<span class="pill">' + esc(x.k) + (x.n > 1 ? ' ×' + x.n : '') + '</span>'; }).join(' ') + '</p></div>' : '') +
        (empty.length ? '<p class="muted empty-note" style="margin-top:12px">' + esc('No answers yet for: ' + empty.join(' · ') + '. These fill in once A-tier leads book through the Calendly form.') + '</p>' : '');
      view.innerHTML =
        '<div class="grid g-4 tiles">' +
        tile('A-tier who booked', n(a.people), pct(a.people / (d.total_booked || 1)) + ' of ' + n(d.total_booked) + ' bookers') +
        tile('A-tier cancel rate', pct(a.cancel_rate), 'vs ' + pct(T.C.cancel_rate) + ' for C-tier', null, { zeroOk: true }) +
        tile('Booked ahead (median)', a.median_days_booked_ahead == null ? '–' : a.median_days_booked_ahead.toFixed(1) + ' days', a.median_days_booked_ahead == null ? 'Needs Calendly booking times' + (a.repeat_bookers ? ' · ' + n(a.repeat_bookers) + ' booked more than once' : '') : n(a.repeat_bookers) + ' booked more than once') +
        tile('A-tier close rate', orNull(a.close_rate), a.past_calls ? n(a.outcomes_logged) + ' of ' + n(a.past_calls) + ' past calls logged' : 'No A-tier calls with a scheduled time have passed yet') + '</div>' +
        '<div class="card" style="margin-top:14px"><h2>By tier</h2><p class="sub">Tier comes from the funnel application, or from the Calendly booking form for people who booked directly (revenue, willingness to invest, budget, team size).</p>' +
        table([
          { label: 'Tier', key: 'tier' }, { label: 'People', key: 'people', num: true, fmt: n }, { label: 'Bookings', key: 'bookings', num: true, fmt: n },
          { label: 'Cancel rate', num: true, zeroOk: true, html: function (r) { return esc(pct(r.cancel_rate)); } },
          { label: 'Reschedule rate', num: true, html: function (r) { return esc(pct(r.reschedule_rate)); } },
          { label: 'Willing to invest', num: true, html: function (r) { return esc(pct(r.willing_yes)); } },
          { label: 'Logged', num: true, html: function (r) { return esc(n(r.outcomes_logged) + '/' + n(r.past_calls)); } },
          { label: 'Show', num: true, html: function (r) { return esc(orNull(r.show_rate)); } },
          { label: 'Close', num: true, html: function (r) { return esc(orNull(r.close_rate)); } },
          { label: 'Revenue', key: 'revenue', num: true, fmt: money }, { label: 'Cash', key: 'cash', num: true, fmt: money },
        ], [tierRow('A', 'A · $1M+, ready'), tierRow('B', 'B · promising'), tierRow('C', 'C · not yet'), tierRow('none', 'Untiered')].filter(function (r) { return r.people; }), { cards: true }) + '</div>' +
        '<h3 class="section-h">The A-tier</h3>' + aTier;
    });
  }

  function renderTeam() {
    return Promise.all([fetch('/admin/api/reps', { credentials: 'same-origin' }).then(function (r) { return r.json(); }), fetch('/admin/api/integrations', { credentials: 'same-origin' }).then(function (r) { return r.json(); })]).then(function (res) {
      var d = res[0], integ = res[1];
      var hooks = {};
      var vals = {};
      (integ.settings || []).forEach(function (s) { hooks[s.key] = s.source !== 'unset'; vals[s.key] = s.value; });
      var on = function (k) { return hooks[k] ? '<span class="pill ok">connected</span>' : '<span class="pill">not set</span>'; };
      function field(label, name, value, attrs) { return '<label>' + esc(label) + ' <input class="input" name="' + name + '" value="' + esc(value == null ? '' : value) + '" ' + (attrs || '') + '></label>'; }
      function form(r) {
        r = r || { role: 'closer', tiers: 'A,B', weight: 1, commission_pct: 0, monthly_target: 0, active: 1 };
        var tiers = String(r.tiers || '').split(',');
        return '<form class="rep-form grid" data-rep="' + esc(r.id || '') + '" style="gap:10px;margin-top:10px">' +
          '<div class="grid g-3" style="gap:10px">' + field('Name', 'name', r.name, 'required') + field('Email', 'email', r.email, 'type="email"') +
          '<label>Role <select class="input" name="role">' + d.roles.map(function (x) { return '<option' + (x === r.role ? ' selected' : '') + '>' + x + '</option>'; }).join('') + '</select></label></div>' +
          '<div class="grid g-3" style="gap:10px"><fieldset class="tiers"><legend>Takes tiers</legend>' + ['A', 'B', 'C'].map(function (t) { return '<label><input type="checkbox" name="tier" value="' + t + '"' + (tiers.indexOf(t) !== -1 ? ' checked' : '') + '> ' + t + '</label>'; }).join('') + '</fieldset>' +
          field('Round-robin weight', 'weight', r.weight, 'type="number" min="0" step="0.5"') +
          field('Calendar link', 'calendar_url', r.calendar_url, 'type="url" placeholder="' + esc(r.legacy_calendar || 'https://calendly.com/…') + '"') + '</div>' +
          '<div class="grid g-4" style="gap:10px">' + field('Commission % of cash', 'commission_pct', r.commission_pct, 'type="number" min="0" max="100" step="0.5"') + field('Monthly revenue target', 'monthly_target', r.monthly_target, 'type="number" min="0" step="1000"') +
          field('Slack member ID', 'slack_user_id', r.slack_user_id, 'placeholder="U0123ABCD"') + field('Discord user ID', 'discord_user_id', r.discord_user_id, 'placeholder="1234567890…"') + '</div>' +
          '<div class="row"><label class="muted"><input type="checkbox" name="active"' + (r.active ? ' checked' : '') + '> Active (gets new leads)</label><span style="flex:1"></span>' +
          (r.id && (r.slack_user_id || r.discord_user_id) ? '<button class="btn-sm ghost" type="button" data-ping="' + esc(r.id) + '">Test @mention</button>' : '') +
          '<button class="btn-sm" type="submit">' + (r.id ? 'Save' : 'Add to team') + '</button></div></form>';
      }
      view.innerHTML =
        '<div class="card"><h2>Team pings</h2><p class="sub">Paste incoming-webhook URLs under <a href="#integrations" data-go="integrations">Integrations → Alerts</a>. Closed deals go to the wins channel (or alerts if you only set one).</p>' +
        '<div class="grid g-2" style="margin-top:10px"><dl class="kv">' + '<dt>Slack · alerts</dt><dd>' + on('SLACK_WEBHOOK_URL') + '</dd><dt>Slack · wins</dt><dd>' + on('SLACK_WINS_WEBHOOK_URL') + '</dd><dt>Discord · alerts</dt><dd>' + on('DISCORD_WEBHOOK_URL') + '</dd><dt>Discord · wins</dt><dd>' + on('DISCORD_WINS_WEBHOOK_URL') + '</dd></dl>' +
        '<div><p class="sub">What gets posted: 🔥 hot A-tier leads · ✅ qualified B-tier leads · 📅 calls booked · 🚫 cancellations · ⏰ 15-minute call reminders (with @mention) · ✅ held · ❌ no-shows · 🎉 closed deals · lost deals · ☀️ daily digest at ' + esc(vals.DIGEST_HOUR || 8) + ':00.</p>' +
        '<div class="row" style="margin-top:10px"><button class="btn-sm ghost" data-test-notify="alerts">Test alerts</button><button class="btn-sm ghost" data-test-notify="wins">Test wins</button><button class="btn-sm ghost" data-test-digest>Send digest now</button></div></div></div></div>' +
        d.reps.map(function (r) { return '<div class="card' + (r.active ? '' : ' inactive') + '" style="margin-top:14px"><div class="card-head"><div><h2>' + esc(r.name) + '</h2><p class="sub">' + esc(r.role) + ' · tiers ' + esc(r.tiers || '–') + (r.calendar_url || r.legacy_calendar ? '' : ' · <b>no calendar — won’t get leads</b>') + '</p></div></div>' + form(r) + '</div>'; }).join('') +
        '<div class="card" style="margin-top:14px"><h2>Add a rep</h2><p class="sub">New closers join the round-robin for the tiers you tick, and leads book on their calendar. Find a Slack member ID in their profile → ⋯ → Copy member ID; a Discord user ID via Developer Mode → right-click → Copy User ID.</p>' + form(null) + '</div>';

      view.querySelectorAll('[data-go]').forEach(function (a) { a.onclick = function (ev) { ev.preventDefault(); go(a.getAttribute('data-go')); }; });
      view.querySelectorAll('.rep-form').forEach(function (f) {
        f.onsubmit = function (ev) {
          ev.preventDefault();
          var id = f.getAttribute('data-rep');
          var body = { tiers: [].map.call(f.querySelectorAll('[name=tier]:checked'), function (c) { return c.value; }), active: f.querySelector('[name=active]').checked };
          ['name', 'email', 'role', 'weight', 'calendar_url', 'commission_pct', 'monthly_target', 'slack_user_id', 'discord_user_id'].forEach(function (k) { body[k] = f.querySelector('[name=' + k + ']').value; });
          send(id ? 'PATCH' : 'POST', id ? 'reps/' + encodeURIComponent(id) : 'reps', body).then(function (r) {
            if (r.error) { toast(r.error); return; }
            toast(id ? 'Saved' : 'Added to the team');
            refreshMeta().then(load);
          });
        };
      });
      view.querySelectorAll('[data-ping]').forEach(function (b) { b.onclick = function () { send('POST', 'notify/test', { rep: b.getAttribute('data-ping') }).then(function (r) { toast(r.error || (r.ok ? 'Sent' : 'Webhook rejected it')); }); }; });
      view.querySelectorAll('[data-test-notify]').forEach(function (b) { b.onclick = function () { send('POST', 'notify/test', { channel: b.getAttribute('data-test-notify') }).then(function (r) { toast(r.error || (r.ok ? 'Sent — check the channel' : 'Webhook rejected it')); }); }; });
      view.querySelector('[data-test-digest]').onclick = function () { send('POST', 'notify/test', { digest: true }).then(function (r) { toast(r.error || 'Digest posted'); }); };
    });
  }


  function loadBehaviour(dr, id) {
    var box = dr.querySelector('[data-behaviour]');
    if (!box) return;
    fetch('/admin/api/leads/' + encodeURIComponent(id) + '/profile', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (p) {
      var templates = [];
      ((state.meta && state.meta.sequences) || []).forEach(function (sq) { sq.steps.forEach(function (t) { if (templates.indexOf(t) === -1) templates.push(t); }); });
      var modeNote = { ai: 'Claude rewrites each email', rules: 'a personal opening line (add an Anthropic key for full rewrites)', off: 'off' }[p.mode] || p.mode;
      box.querySelector('p.muted').outerHTML =
        '<p class="muted" style="margin-top:2px">Personalisation: <b>' + esc(modeNote) + '</b>' + (p.next ? ' · next email: <span class="mono">' + esc(p.next.template) + '</span> ' + esc(when(p.next.send_at)) : '') + '</p>' +
        (p.facts.length ? '<ul class="facts">' + p.facts.map(function (f) { return '<li' + (f.used ? ' class="used"' : '') + '><span class="w">' + esc(f.weight) + '</span>' + esc(f.text) + (f.used ? ' <span class="pill">used</span>' : '') + '</li>'; }).join('') + '</ul>' : '<p class="muted">Nothing tracked for this lead yet.</p>') +
        '<div class="row" style="margin-top:12px"><select class="input" data-pv-t>' + templates.map(function (t) { return '<option' + (p.next && p.next.template === t ? ' selected' : '') + '>' + esc(t) + '</option>'; }).join('') + '</select><button class="btn-sm" data-pv>Preview personalised email</button></div><div data-pv-out></div>';
      box.querySelector('[data-pv]').onclick = function () {
        var b = this, out = box.querySelector('[data-pv-out]');
        b.disabled = true; out.innerHTML = '<p class="muted">Writing it…</p>';
        fetch('/admin/api/leads/' + encodeURIComponent(id) + '/preview-email?template=' + encodeURIComponent(box.querySelector('[data-pv-t]').value), { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (e) {
          b.disabled = false;
          if (e.error && !e.html) { out.innerHTML = '<p class="muted">' + esc(e.error) + '</p>'; return; }
          out.innerHTML = '<p class="sub" style="margin-top:12px"><b>' + esc(e.subject) + '</b> · ' + esc(e.mode) + (e.factsUsed.length ? ' · uses ' + esc(e.factsUsed.join(', ')) : '') + (e.error ? ' · <span class="muted">' + esc(e.error) + '</span>' : '') + '</p><iframe class="email-preview" sandbox title="Email preview"></iframe>';
          out.querySelector('iframe').srcdoc = e.html;
        });
      };
    });
  }


  function ymd(ms) { if (!ms) return ''; var d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function opts(list, cur, blank) { return (blank ? '<option value="">' + esc(blank) + '</option>' : '') + (list || []).map(function (x) { return '<option' + (x === cur ? ' selected' : '') + '>' + esc(x) + '</option>'; }).join(''); }
  function dealCard(l) {
    var m = state.meta || {};
    var flags = []; try { flags = JSON.parse(l.qual_flags || '[]'); } catch (e) { /* ignore */ }
    var f = function (label, html) { return '<label>' + esc(label) + ' ' + html + '</label>'; };
    var inp = function (name, val, type, extra) { return '<input class="input" data-f="' + name + '" type="' + (type || 'text') + '" value="' + esc(val == null ? '' : val) + '"' + (extra || '') + '>'; };
    return '<div class="card" id="ld-deal" style="margin-top:14px"><div class="card-head"><div><h2>Deal</h2><p class="sub">' +
      esc([l.revenue_band && ('Revenue ' + l.revenue_band), l.industry, l.budget_band && ('Budget ' + l.budget_band), l.willing_to_invest && l.willing_to_invest !== 'unknown' && ('Willing to invest: ' + l.willing_to_invest), l.qual_source && ('qualified from ' + l.qual_source)].filter(Boolean).join(' · ') || 'No qualification data yet.') +
      (flags.length ? '<br>' + flags.map(function (x) { var t = String(x).replace(/_/g, ' '); return '<span class="pill" title="' + esc(x) + '">' + esc(t.charAt(0).toUpperCase() + t.slice(1)) + '</span>'; }).join(' ') : '') + '</p></div></div>' +
      '<div class="grid g-4 deal-grid" style="gap:10px">' +
      f('Temperature', '<select class="input" data-f="temperature">' + opts(m.temperatures, l.temperature, '—') + '</select>') +
      f('Fit (1–5)', '<select class="input" data-f="fit_rating">' + opts(['1', '2', '3', '4', '5'], l.fit_rating == null ? '' : String(l.fit_rating), '—') + '</select>') +
      f('Decision maker on call', '<select class="input" data-f="decision_maker"><option value="">—</option><option value="1"' + (l.decision_maker === 1 ? ' selected' : '') + '>Yes</option><option value="0"' + (l.decision_maker === 0 ? ' selected' : '') + '>No</option></select>') +
      f('Main objection', '<select class="input" data-f="objection">' + opts(m.objections, l.objection, '—') + '</select>') +
      f('Follow up on', inp('follow_up_at', ymd(l.follow_up_at), 'date')) +
      f('Offer bought', inp('offer', l.offer, 'text', ' placeholder="e.g. 90-day LOI program"')) +
      f('Payment plan', '<select class="input" data-f="payment_plan">' + opts(m.paymentPlans, l.payment_plan, '—') + '</select>') +
      f('Instalments', inp('installments_total', l.installments_total, 'number', ' min="0"')) +
      f('Contract signed', inp('contract_signed_at', ymd(l.contract_signed_at), 'date')) +
      f('Next payment due', inp('next_payment_at', ymd(l.next_payment_at), 'date')) +
      f('LOI signed', inp('loi_signed_at', ymd(l.loi_signed_at), 'date')) +
      f('Target business', inp('target_business', l.target_business)) +
      '</div><p class="muted" style="margin-top:8px">Saved with the Save button above. Cash collected comes from the payments below once you add any.' +
      (l.contract_signed_at && !l.loi_signed_at ? ' <b>' + Math.max(0, 90 - Math.floor((Date.now() - l.contract_signed_at) / 86400000)) + ' days left</b> in the 90-day LOI window.' : '') + '</p>' +
      '<h2 style="margin-top:14px">Payments</h2><div data-payments><p class="muted">Loading…</p></div>' +
      '<div class="row" style="margin-top:8px"><input class="input" data-pay-amt type="number" step="100" placeholder="Amount (negative = refund)" style="width:190px"><input class="input" data-pay-date type="date" value="' + ymd(Date.now()) + '"><select class="input" data-pay-method><option>stripe</option><option>bank</option><option>card</option><option>other</option></select><input class="input" data-pay-note placeholder="Note" style="flex:1"><button class="btn-sm" data-pay-add type="button">Add payment</button></div></div>';
  }
  function loadPayments(dr, id) {
    var box = dr.querySelector('[data-payments]');
    if (!box) return;
    var draw = function () {
      fetch('/admin/api/leads/' + encodeURIComponent(id) + '/payments', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
        var total = d.payments.reduce(function (t, p) { return t + p.amount; }, 0);
        box.innerHTML = d.payments.length ? table([
          { label: 'Date', html: function (p) { return esc(ymd(p.paid_at)); } },
          { label: 'Amount', num: true, html: function (p) { return '<span' + (p.amount < 0 ? ' class="muted"' : '') + '>' + esc(money(p.amount)) + '</span>'; } },
          { label: 'Method', key: 'method' }, { label: 'Note', key: 'note' },
          { label: '', html: function (p) { return '<button class="btn-sm ghost" data-pay-del="' + esc(p.id) + '">✕</button>'; } },
        ], d.payments) + '<p class="sub" style="margin-top:6px">Collected: <b>' + esc(money(total)) + '</b></p>' : '<p class="muted">No payments recorded.</p>';
        box.querySelectorAll('[data-pay-del]').forEach(function (b) { b.onclick = function () { fetch('/admin/api/leads/' + encodeURIComponent(id) + '/payments/' + encodeURIComponent(b.getAttribute('data-pay-del')), { method: 'DELETE', credentials: 'same-origin' }).then(draw); }; });
      });
    };
    draw();
    dr.querySelector('[data-pay-add]').onclick = function () {
      send('POST', 'leads/' + encodeURIComponent(id) + '/payments', { amount: dr.querySelector('[data-pay-amt]').value, paid_at: dr.querySelector('[data-pay-date]').value, method: dr.querySelector('[data-pay-method]').value, note: dr.querySelector('[data-pay-note]').value })
        .then(function (r) { if (r.error) { toast(r.error); return; } toast('Payment saved'); dr.querySelector('[data-pay-amt]').value = ''; dr.querySelector('[data-pay-note]').value = ''; draw(); var c = dr.querySelector('[data-f=cash_collected]'); if (c) c.value = r.cash_collected; });
    };
  }

  function voiceCall(v) {
    var sd = {};
    try { sd = JSON.parse(v.structured || '{}'); } catch (x) { /* ignore */ }
    var tags = [sd.wants_strategy_call && 'wants a call', sd.wants_human_callback && 'wants a person to call back', sd.do_not_contact && 'do not contact', sd.recording_consent === false && 'declined recording'].filter(Boolean);
    return '<details class="voice-call" style="margin:10px 0"><summary><strong>' + esc(when(v.created_at)) + '</strong> <span class="muted">' + esc(v.kind) + ' · ' + esc(v.duration_s ? secs(v.duration_s) : v.status) + (v.ended_reason ? ' · ' + esc(v.ended_reason) : '') + '</span>' +
      (tags.length ? ' ' + tags.map(function (t) { return '<span class="pill">' + esc(t) + '</span>'; }).join(' ') : '') + '</summary>' +
      (v.summary ? '<p>' + esc(v.summary) + '</p>' : '') + (v.recording_url ? '<audio controls preload="none" src="' + esc(v.recording_url) + '" style="width:100%"></audio>' : '') +
      (v.transcript ? '<pre class="transcript" style="white-space:pre-wrap;max-height:320px;overflow:auto">' + esc(v.transcript) + '</pre>' : '') + '</details>';
  }

  state.linkModel = state.linkModel || 'first';
  function renderLinks() {
    return api('links', { model: state.linkModel }).then(function (d) {
      var PL = { description: 'Description', pinned_comment: 'Pinned comment', end_screen: 'End screen', card: 'Card', community_post: 'Community post', shorts: 'Shorts', channel_about: 'Channel about', other: 'Other',
        bio: 'Bio', dm: 'DM (ManyChat)', story: 'Story', post: 'Post / caption', broadcast: 'Broadcast channel', ad: 'Ad', newsletter: 'Newsletter', show_notes: 'Show notes', qr: 'QR code' };
      var PRE = d.presets || {};
      function r(a, b) { return b ? pct(a / b) : '–'; }
      // One row per YouTube video, and one per platform for everything else (Instagram, ManyChat, TikTok…).
      var groups = {}, order = [];
      d.links.forEach(function (l) {
        var k = l.video_id || ('p:' + platformOf(l.utm_source, null, l.utm_medium));
        if (!groups[k]) { groups[k] = { title: l.video_id ? (l.video_title || l.label) : platformOf(l.utm_source, null, l.utm_medium), thumb: l.thumbnail, video_id: l.video_id, links: [], clicks_total: 0, visitors: 0, vsl_viewers: 0, leads: 0, applications: 0, qualified: 0, booked: 0, showed: 0, won: 0, revenue: 0 }; order.push(k); }
        var g = groups[k]; g.links.push(l);
        ['clicks_total', 'visitors', 'vsl_viewers', 'leads', 'applications', 'qualified', 'booked', 'showed', 'won', 'revenue'].forEach(function (m) { g[m] += l[m] || 0; });
      });
      var cols = [
        { label: 'Link opens', key: 'clicks_total', num: true, fmt: n }, { label: 'People', key: 'visitors', num: true, fmt: n }, { label: 'Watched VSL', key: 'vsl_viewers', num: true, fmt: n },
        { label: 'Leads', key: 'leads', num: true, fmt: n }, { label: 'Applied', key: 'applications', num: true, fmt: n }, { label: 'Qualified', key: 'qualified', num: true, fmt: n },
        { label: 'Booked', key: 'booked', num: true, fmt: n }, { label: 'Showed', key: 'showed', num: true, fmt: n }, { label: 'Won', key: 'won', num: true, fmt: n },
        { label: 'Revenue', key: 'revenue', num: true, fmt: function (v) { return v ? '$' + n(v) : '–'; } },
        { label: 'Visit → booked', num: true, html: function (x) { return esc(r(x.booked, x.visitors)); } },
      ];
      view.innerHTML =
        '<div class="card"><h2>New tracked link</h2><p class="sub">Make one link for each place you post it: your Instagram bio, each ManyChat flow, each YouTube video… Every open is counted and followed to booked calls and deals.</p>' +
        '<div class="row" style="gap:10px;flex-wrap:wrap;align-items:flex-end">' +
        '<label style="flex:1;min-width:220px"><span class="muted">Where will it go?</span><select class="input" data-preset><optgroup label="YouTube"><option value="yt">YouTube video</option>' + Object.keys(PRE).filter(function (k) { return PRE[k].group === 'YouTube'; }).map(function (k) { return '<option value="' + esc(k) + '">' + esc(PRE[k].label) + '</option>'; }).join('') + '</optgroup>' +
        ['Instagram', 'X', 'Meta ads', 'Facebook', 'Other social', 'Other'].map(function (gname) { return '<optgroup label="' + esc(gname) + '">' + Object.keys(PRE).filter(function (k) { return PRE[k].group === gname; }).map(function (k) { return '<option value="' + esc(k) + '">' + esc(PRE[k].label) + '</option>'; }).join('') + '</optgroup>'; }).join('') + '</select></label>' +
        '<label style="flex:2;min-width:260px" data-ytonly><span class="muted">YouTube video link</span><input class="input" data-yt placeholder="https://www.youtube.com/watch?v=…"></label>' +
        '<label data-ytonly><span class="muted">Spot</span><select class="input" data-pl>' + d.placements.map(function (p) { return '<option value="' + p + '">' + esc(PL[p] || p) + '</option>'; }).join('') + '</select></label>' +
        '<label style="flex:1;min-width:180px"><span class="muted">Name</span><input class="input" data-label placeholder="e.g. “Free guide” ManyChat flow"></label>' +
        '<label style="flex:1;min-width:160px"><span class="muted">Sends them to</span><input class="input" data-dest placeholder="/ (the main page)"></label>' +
        '<button class="btn-sm" data-create type="button">Create link</button></div>' +
        '<p class="muted" data-mchint style="display:none;margin:10px 0 0">ManyChat: paste the short link into a button (or the message text) in your flow. Use a separate link per flow or keyword, and you’ll see which one books calls.</p>' +
        '<p data-made style="margin:12px 0 0"></p></div>' +
        '<div class="card" style="margin-top:14px"><div class="card-head"><div><h2>By video &amp; platform</h2><p class="sub">Leads credited by ' + (state.linkModel === 'first' ? '<b>first touch</b> (the link that first brought them in)' : '<b>last touch</b> (the link they came through when they applied)') + '.</p></div>' +
        '<div class="row"><button class="btn-sm ' + (state.linkModel === 'first' ? '' : 'ghost') + '" data-model="first" type="button">First touch</button><button class="btn-sm ' + (state.linkModel === 'last' ? '' : 'ghost') + '" data-model="last" type="button">Last touch</button></div></div>' +
        (order.length ? table([{ label: 'Video / platform', html: function (g) { return '<div class="row" style="gap:10px;align-items:center;flex-wrap:nowrap">' + (g.thumb ? '<img src="' + esc(g.thumb) + '" alt="" width="80" height="45" style="border-radius:4px;object-fit:cover;flex:none">' : '') + '<span>' + (g.video_id ? '<a href="https://www.youtube.com/watch?v=' + esc(g.video_id) + '" target="_blank" rel="noopener">' + esc(g.title) + '</a>' : esc(g.title)) + '<div class="muted">' + g.links.length + ' link' + (g.links.length === 1 ? '' : 's') + '</div></span></div>'; } }].concat(cols), order.map(function (k) { return groups[k]; }), { cards: true }) : '<p class="muted">No tracked links yet. Create one above for your Instagram bio, a ManyChat flow or a video.</p>') + '</div>' +
        (d.links.length ? '<div class="card" style="margin-top:14px"><h2>By link</h2>' + table([
          { label: 'Link', html: function (l) { return '<strong>' + esc(l.label) + '</strong><div class="muted">' + esc(platformOf(l.utm_source, null, l.utm_medium) + ' · ' + (PL[l.placement] || l.placement || l.utm_medium)) + (l.dest_path && l.dest_path !== '/' ? ' → ' + esc(l.dest_path) : '') + '</div>'; } },
          { label: 'Short URL', html: function (l) { return '<button class="btn-sm ghost" type="button" data-copy="' + esc(l.short_url) + '">Copy</button> <span class="mono muted">/l/' + esc(l.code) + '</span>'; } },
        ].concat(cols).concat([{ label: '', html: function (l) { return '<button class="btn-sm ghost" type="button" data-del="' + esc(l.code) + '" title="Archive">✕</button>'; } }]), d.links, { cards: true }) + '</div>' : '') +
        '<p class="sub" style="margin-top:14px">“Link opens” counts real taps (link-preview bots and Meta’s link checks are left out). “People” counts the ones who actually loaded the page.</p>';
      function syncPreset() {
        var yt = view.querySelector('[data-preset]').value === 'yt';
        view.querySelectorAll('[data-ytonly]').forEach(function (el) { el.style.display = yt ? '' : 'none'; });
        view.querySelector('[data-mchint]').style.display = /manychat/.test(view.querySelector('[data-preset]').value) ? '' : 'none';
      }
      view.querySelector('[data-preset]').onchange = syncPreset;
      syncPreset();
      view.querySelector('[data-create]').onclick = function () {
        var out = view.querySelector('[data-made]');
        out.textContent = 'Creating…';
        var preset = view.querySelector('[data-preset]').value;
        var dest = view.querySelector('[data-dest]').value.trim().replace(/^https?:\/\/[^/]+/, '');
        if (dest && dest.charAt(0) !== '/') dest = '/' + dest;
        send('POST', 'links', { preset: preset === 'yt' ? undefined : preset, url: preset === 'yt' ? view.querySelector('[data-yt]').value : undefined, placement: view.querySelector('[data-pl]').value, label: view.querySelector('[data-label]').value, dest_path: dest || undefined }).then(function (res) {
          if (!res.ok) { out.textContent = res.error || 'Could not create the link'; return; }
          out.innerHTML = 'Created for <b>' + esc(res.link.video_title || res.link.label) + '</b>: <span class="mono">' + esc(res.link.short_url) + '</span> <button class="btn-sm" type="button" data-copy="' + esc(res.link.short_url) + '">Copy</button>';
          wireCopy(out);
          setTimeout(load, 1500);
        });
      };
      view.querySelectorAll('[data-model]').forEach(function (b) { b.onclick = function () { state.linkModel = b.getAttribute('data-model'); load(); }; });
      view.querySelectorAll('[data-del]').forEach(function (b) { b.onclick = function () { if (confirm('Archive this link? It will stop redirecting.')) send('DELETE', 'links/' + b.getAttribute('data-del')).then(load); }; });
      wireCopy(view);
    });
  }

  // ───────────── Contracts (advisory agreements) ─────────────
  var K_STATUS = { draft: 'Draft', sent: 'Sent', viewed: 'Opened', signed: 'Signed', void: 'Void' };
  var K_CUR = ['USD', 'AUD', 'CAD', 'NZD', 'GBP', 'EUR', 'SGD'];
  var kCo = null;
  function kMoney(k) { var sym = { USD: '$', AUD: 'A$', CAD: 'C$', NZD: 'NZ$', SGD: 'S$', GBP: '£', EUR: '€' }[k.currency] || (k.currency + ' '); return sym + Number(k.fee || 0).toLocaleString('en-US'); }
  function kStatus(k) { return (k.is_test ? '<span class="pill k-test">Test</span> ' : '') + '<span class="pill k-' + esc(k.status) + '">' + esc(K_STATUS[k.status] || k.status) + '</span>' + (k.status === 'signed' ? (k.paid_at ? ' <span class="pill k-paid">Paid</span>' : ' <span class="pill k-unpaid">' + (k.pay_email_sent_at ? 'Payment requested' : 'Unpaid') + '</span>') : ''); }
  function kWhen(k) { return k.signed_at ? 'signed ' + when(k.signed_at) : k.viewed_at ? 'opened ' + when(k.viewed_at) : k.sent_at ? 'sent ' + when(k.sent_at) : 'drafted ' + when(k.created_at); }
  function kWho(k) { return k.client_name || k.client_email || 'No client yet'; }

  /** A modal above everything (works on top of the lead drawer). */
  function kModal(title, wide) {
    var bg = document.createElement('div'); bg.className = 'k-modal-bg';
    var m = document.createElement('div'); m.className = 'k-modal' + (wide ? ' wide' : ''); m.setAttribute('role', 'dialog'); m.setAttribute('aria-label', title);
    m.innerHTML = '<div class="k-modal-head"><h2>' + esc(title) + '</h2><button class="close" type="button" aria-label="Close">Close ✕</button></div><div class="k-modal-body"></div>';
    document.body.appendChild(bg); document.body.appendChild(m);
    function onKey(e) { if (e.key === 'Escape') close(); }
    function close() { bg.remove(); m.remove(); document.removeEventListener('keydown', onKey); if (m.onclosed) m.onclosed(); }
    bg.onclick = close; m.querySelector('.close').onclick = close; document.addEventListener('keydown', onKey);
    m.close = close; m.body = m.querySelector('.k-modal-body');
    return m;
  }

  /** Type-or-draw signature pad; returns { el, value() }. */
  function sigPad(name) {
    var wrap = document.createElement('div'); wrap.className = 'k-sig';
    wrap.innerHTML = '<label>Your name<input class="input" data-sn value="' + esc(name) + '"></label>' +
      '<div class="sig-tabs"><button type="button" class="on" data-sm="typed">Type</button><button type="button" data-sm="drawn">Draw</button></div>' +
      '<div class="k-sig-typed" data-st>' + esc(name) + '</div><div data-sd hidden><canvas width="560" height="150"></canvas><button type="button" class="btn-sm ghost" data-sc>Clear</button></div>';
    var mode = 'typed', drawn = false, cv = wrap.querySelector('canvas'), cx = cv.getContext('2d'), down = false;
    cx.lineWidth = 2.5; cx.lineCap = 'round'; cx.strokeStyle = '#0f2c5c';
    wrap.querySelector('[data-sn]').oninput = function (e) { wrap.querySelector('[data-st]').textContent = e.target.value || ' '; };
    wrap.querySelectorAll('[data-sm]').forEach(function (b) { b.onclick = function () { mode = b.getAttribute('data-sm'); wrap.querySelectorAll('[data-sm]').forEach(function (x) { x.classList.toggle('on', x === b); }); wrap.querySelector('[data-st]').hidden = mode !== 'typed'; wrap.querySelector('[data-sd]').hidden = mode !== 'drawn'; }; });
    function pos(e) { var r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) * cv.width / r.width, y: (e.clientY - r.top) * cv.height / r.height }; }
    cv.addEventListener('pointerdown', function (e) { down = true; cv.setPointerCapture(e.pointerId); var p = pos(e); cx.beginPath(); cx.moveTo(p.x, p.y); e.preventDefault(); });
    cv.addEventListener('pointermove', function (e) { if (!down) return; var p = pos(e); cx.lineTo(p.x, p.y); cx.stroke(); drawn = true; });
    ['pointerup', 'pointercancel'].forEach(function (t) { cv.addEventListener(t, function () { down = false; }); });
    wrap.querySelector('[data-sc]').onclick = function () { cx.clearRect(0, 0, cv.width, cv.height); drawn = false; };
    return { el: wrap, value: function () { var nm = wrap.querySelector('[data-sn]').value.trim(); return { name: nm, kind: mode, signature: mode === 'drawn' && drawn ? cv.toDataURL('image/png') : null, ok: nm.length >= 2 && (mode === 'typed' || drawn) }; } };
  }

  function loadCompany() { return kCo ? Promise.resolve(kCo) : api('contracts').then(function (d) { kCo = d.company || {}; kCo.emailReady = d.emailReady; return kCo; }); }

  /** New agreement / edit draft: form on the left, live preview of the actual document on the right. */
  function openContractEditor(k, lead, done) {
    loadCompany().then(function (co) {
      var m = kModal(k ? 'Edit agreement' : 'New agreement', true);
      var state2 = { lead: k ? k.lead_id : (lead ? lead.id : '') };
      function input(name, label, val, type, extra) { return '<label>' + esc(label) + '<input class="input" data-kf="' + name + '" type="' + (type || 'text') + '" value="' + esc(val == null ? '' : val) + '"' + (extra || '') + '></label>'; }
      function area(name, label, val, rows) { return '<label class="full">' + esc(label) + '<textarea class="notes" data-kf="' + name + '" rows="' + (rows || 2) + '">' + esc(val == null ? '' : val) + '</textarea></label>'; }
      function draw(q) {
        var v = k || q;
        m.body.innerHTML = '<div class="k-editor"><div class="k-form">' +
          (k || lead ? '' : '<div class="k-pick"><label>Client<input class="input" data-kpick placeholder="Search leads by name or email, or just type a new client below"></label><div class="k-results" data-kres></div></div>') +
          (state2.lead ? '<p class="sub" data-kbasis>' + esc(q.basis || '') + '</p>' : '') +
          '<div class="pipe-grid">' +
          input('client_name', 'Client name', v.client_name) + input('client_email', 'Client email', v.client_email, 'email') +
          input('client_company', 'Their company (optional)', v.client_company) + input('title', 'Title', v.title || 'Advisory Agreement') +
          input('fee', 'Fee', v.fee, 'number', ' min="0" step="500"') +
          '<label>Currency<select class="input" data-kf="currency">' + K_CUR.map(function (c) { return '<option' + (c === (v.currency || co.currency) ? ' selected' : '') + '>' + c + '</option>'; }).join('') + '</select></label>' +
          area('payment_terms', 'When it’s paid', v.payment_terms) + area('success_fee', 'Success fee (optional; adds a 12-month introductions clause)', v.success_fee) +
          area('scope', 'What we do (one per line)', v.scope, 5) + input('term_text', 'Term', v.term_text) +
          '<label class="full">Payment link for this client (optional)<input class="input" data-kf="pay_link" type="url" placeholder="' + esc(co.payLink || 'https://buy.stripe.com/…  (e.g. a Stripe link for this amount)') + '" value="' + esc(v.pay_link || '') + '"><span class="muted small">After signing they go straight here. ' + (co.payLink ? 'Leave blank to use your default link.' : 'Set a default under Integrations → Contracts.') + '</span></label>' +
          '</div><div class="row" style="gap:8px;margin-top:12px"><button class="btn-sm" type="button" data-ksave>' + (k ? 'Save changes' : 'Save draft') + '</button><button class="btn-sm ghost" type="button" data-kcancel>Cancel</button></div>' +
          '<p class="muted small" style="margin-top:10px">Company details, governing law and courts: Integrations → Contracts (' + esc(co.name) + ', ' + esc(co.law) + ' law). Have your attorney review the agreement once before you send the first one.</p>' +
          '</div><div class="k-preview"><div class="k-paper" data-kprev>Loading preview…</div></div></div>';
        var timer;
        function vals() { var b = { lead: state2.lead }; m.body.querySelectorAll('[data-kf]').forEach(function (f) { b[f.getAttribute('data-kf')] = f.value; }); return b; }
        function preview() { clearTimeout(timer); timer = setTimeout(function () { send('POST', 'contracts/preview', vals()).then(function (r) { m.body.querySelector('[data-kprev]').innerHTML = r.html || ''; }); }, 250); }
        m.body.querySelectorAll('[data-kf]').forEach(function (f) { f.addEventListener('input', preview); });
        preview();
        m.body.querySelector('[data-kcancel]').onclick = m.close;
        m.body.querySelector('[data-ksave]').onclick = function () {
          var req = k ? send('POST', 'contracts/' + k.id + '/update', vals()) : send('POST', 'contracts', vals());
          req.then(function (r) { if (!r.ok) { toast(r.error || 'Could not save'); return; } toast('Saved. Review it, then sign and send.'); m.close(); if (done) done(); openContract(r.contract.id, done); });
        };
        var pick = m.body.querySelector('[data-kpick]');
        if (pick) {
          var t2;
          pick.oninput = function () {
            clearTimeout(t2);
            var q2 = pick.value.trim();
            if (q2.length < 2) { m.body.querySelector('[data-kres]').innerHTML = ''; return; }
            t2 = setTimeout(function () {
              api('leads', { q: q2 }).then(function (d) {
                var box = m.body.querySelector('[data-kres]');
                box.innerHTML = (d.rows || []).slice(0, 6).map(function (l) { return '<button type="button" data-kl="' + esc(l.id) + '"><strong>' + esc([l.first_name, l.last_name].filter(Boolean).join(' ') || l.email) + '</strong> <span class="muted">' + esc(l.email || '') + (l.tier ? ' · ' + esc(l.tier) : '') + '</span></button>'; }).join('') || '<p class="muted small">No lead found. Type their name and email below instead.</p>';
                box.querySelectorAll('[data-kl]').forEach(function (b) {
                  b.onclick = function () { state2.lead = b.getAttribute('data-kl'); api('contracts/quote', { lead: state2.lead }).then(function (q3) { lead = { id: state2.lead }; draw(q3); }); };
                });
              });
            }, 250);
          };
        }
      }
      if (k) draw(k); else api('contracts/quote', { lead: state2.lead || '' }).then(draw);
    });
  }

  /** One agreement: the full document, its history, and what you can do next. */
  function openContract(id, done) {
    Promise.all([loadCompany(), api('contracts'), send('POST', 'contracts/preview', { id: id })]).then(function (r) {
      var co = r[0], k = (r[1].contracts || []).filter(function (x) { return x.id === id; })[0], html = r[2].html;
      if (!k) { toast('Agreement not found'); return; }
      var m = kModal(k.title + ' · ' + kWho(k), true);
      var steps = [['Drafted', k.created_at], ['Signed by ' + (k.our_signer || co.signer).split(',')[0], k.our_signed_at], ['Emailed to ' + (k.client_email || '–'), k.sent_at], ['Opened', k.viewed_at], ['Signed by ' + (k.signer_name || 'client'), k.signed_at], ['Payment email sent', k.pay_email_sent_at], ['Paid', k.paid_at]];
      var actions = '';
      if (k.status === 'draft') actions = '<button class="btn-sm" type="button" data-ka="sign">Sign &amp; send</button><button class="btn-sm ghost" type="button" data-ka="edit">Edit</button><button class="btn-sm ghost" type="button" data-ka="test">Send me a test</button><button class="btn-sm ghost" type="button" data-ka="void">Void</button>';
      else if (k.status === 'sent' || k.status === 'viewed') actions = '<button class="btn-sm ghost" type="button" data-copy="' + esc(k.sign_url) + '">Copy signing link</button><a class="btn-sm ghost" target="_blank" rel="noopener" href="' + esc(k.sign_url) + '">Open signing page</a><button class="btn-sm ghost" type="button" data-ka="test">Send me a test</button><button class="btn-sm ghost" type="button" data-ka="void">Void</button>';
      else if (k.status === 'signed') actions = '<button class="btn-sm" type="button" data-ka="payment">' + (k.pay_email_sent_at ? 'Resend payment email' : 'Send payment email') + '</button>' + (k.paid_at ? '<button class="btn-sm ghost" type="button" data-ka="unpaid">Mark unpaid</button>' : '<button class="btn-sm ghost" type="button" data-ka="paid">Mark as paid</button>') + '<a class="btn-sm ghost" target="_blank" rel="noopener" href="' + esc(k.copy_url) + '">Signed copy (print / PDF)</a>';
      m.body.innerHTML = '<div class="k-editor"><div class="k-form">' +
        '<div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:12px">' + kStatus(k) + '<strong style="font-size:1.2rem">' + esc(kMoney(k)) + '</strong></div>' +
        '<ol class="k-steps">' + steps.map(function (s2) { return '<li class="' + (s2[1] ? 'done' : '') + '"><span>' + esc(s2[0]) + '</span><span class="muted">' + (s2[1] ? esc(when(s2[1])) : '–') + '</span></li>'; }).join('') + '</ol>' +
        (k.reminders ? '<p class="muted small">' + k.reminders + ' reminder' + (k.reminders > 1 ? 's' : '') + ' sent.</p>' : '') +
        '<div class="row k-actions">' + actions + '</div><div data-kpanel></div>' +
        (k.lead_id ? '<p style="margin-top:14px"><button class="btn-sm ghost" type="button" data-klead>Open their lead</button></p>' : '') +
        (!co.emailReady ? '<p class="muted small">Email isn’t connected, so it can’t be sent yet (Integrations → Email).</p>' : '<p class="muted small">Sent from ' + esc(co.from || '') + '.</p>') +
        '</div><div class="k-preview"><div class="k-paper">' + html + '</div></div></div>';
      wireCopy(m.body);
      var panel = m.body.querySelector('[data-kpanel]');
      var lb = m.body.querySelector('[data-klead]'); if (lb) lb.onclick = function () { m.close(); openLead(k.lead_id); };
      function refreshAfter(msg) { toast(msg); m.close(); if (done) done(); openContract(id, done); }
      m.body.querySelectorAll('[data-ka]').forEach(function (b) {
        b.onclick = function () {
          var a = b.getAttribute('data-ka');
          if (a === 'edit') { m.close(); openContractEditor(k, null, done); return; }
          if (a === 'void') { if (confirm('Void this agreement? Its signing link stops working.')) send('POST', 'contracts/' + id + '/void', {}).then(function () { refreshAfter('Voided'); }); return; }
          if (a === 'paid' || a === 'unpaid') { send('POST', 'contracts/' + id + '/' + a, {}).then(function (r3) { if (r3.ok) refreshAfter(a === 'paid' ? 'Marked as paid' : 'Marked unpaid'); else toast(r3.error || 'Could not update'); }); return; }
          if (a === 'payment') {
            panel.innerHTML = '<div class="k-signbox"><h3>Email ' + esc(k.client_name || k.client_email) + ' how to pay ' + esc(kMoney(k)) + '</h3>' +
              '<label>Payment link<input class="input" data-kpl type="url" value="' + esc(k.pay_link || co.payLink || '') + '" placeholder="https://buy.stripe.com/…"></label>' +
              '<label>Note (optional)<textarea class="notes" data-kpn rows="2" placeholder="e.g. Invoice attached separately. Card or bank transfer both fine."></textarea></label>' +
              '<p class="muted small">Includes a “Pay” button' + (co.bank ? ', your bank details,' : '') + ' and a link to their signed agreement. Sent from ' + esc(co.from || '') + '.</p>' +
              '<div class="row" style="margin-top:8px"><button class="btn-sm" type="button" data-kps>Send payment email</button><button class="btn-sm ghost" type="button" data-kno>Cancel</button></div></div>';
            panel.querySelector('[data-kno]').onclick = function () { panel.innerHTML = ''; };
            panel.querySelector('[data-kps]').onclick = function (e) {
              e.target.disabled = true; e.target.textContent = 'Sending…';
              send('POST', 'contracts/' + id + '/payment', { link: panel.querySelector('[data-kpl]').value.trim(), note: panel.querySelector('[data-kpn]').value }).then(function (r3) {
                if (!r3.ok) { toast(r3.error || 'Could not send'); e.target.disabled = false; e.target.textContent = 'Send payment email'; return; }
                refreshAfter('Payment email sent to ' + k.client_email);
              });
            };
            return;
          }
          var pad = sigPad((co.signer || 'Josh Li').split(',')[0]);
          panel.innerHTML = '<div class="k-signbox"><h3>' + (a === 'sign' ? 'Sign for ' + esc(co.name) + ', then send' : 'Send a signable test copy') + '</h3>' +
            (a === 'test' ? '<label>Send the test to<input class="input" data-kto type="email" value="' + esc(((co.from || '').match(/<([^>]+)>/) || [])[1] || co.from || '') + '"></label>' : '<p class="muted small">Your signature goes on the agreement before ' + esc(k.client_name || 'the client') + ' sees it. It’s emailed from ' + esc(co.from || '') + '.</p>') +
            '</div>';
          panel.querySelector('.k-signbox').appendChild(pad.el);
          var go = document.createElement('div'); go.className = 'row'; go.style.marginTop = '10px';
          go.innerHTML = '<button class="btn-sm" type="button" data-kgo>' + (a === 'sign' ? 'Sign and send to ' + esc(k.client_email || '') : 'Sign and send test') + '</button><button class="btn-sm ghost" type="button" data-kno>Cancel</button>';
          panel.querySelector('.k-signbox').appendChild(go);
          go.querySelector('[data-kno]').onclick = function () { panel.innerHTML = ''; };
          go.querySelector('[data-kgo]').onclick = function (e) {
            var v = pad.value();
            if (!v.ok) { toast('Type your name, or draw your signature.'); return; }
            if (a === 'sign' && !confirm('Send “' + k.title + '” (' + kMoney(k) + ') to ' + k.client_email + '?')) return;
            e.target.disabled = true; e.target.textContent = 'Sending…';
            var body = { name: v.name, kind: v.kind, signature: v.signature };
            if (a === 'test') body.to = panel.querySelector('[data-kto]').value.trim();
            send('POST', 'contracts/' + id + '/' + (a === 'sign' ? 'send' : 'test'), body).then(function (res) {
              if (!res.ok) { toast(res.error || 'Could not send'); e.target.disabled = false; e.target.textContent = 'Try again'; return; }
              if (a === 'test') { toast('Test sent to ' + body.to + '. Open it and sign it to try the whole flow.'); panel.innerHTML = ''; if (done) done(); }
              else refreshAfter('Signed and sent to ' + k.client_email);
            });
          };
        };
      });
    });
  }

  /** The Contract card inside a lead. */
  function loadContracts(box, l) {
    if (!box) return;
    function refresh() {
      api('contracts', { lead: l.id }).then(function (d) {
        var list = (d.contracts || []).filter(function (k) { return !k.is_test; });
        box.innerHTML = '<div class="card-head"><div><h2>Agreement</h2><p class="sub">One-page advisory agreement, auto-quoted from their application. You sign, it’s emailed from Josh, they sign.</p></div><button class="btn-sm" type="button" data-k-new>New agreement</button></div>' +
          (list.length ? table([
            { label: 'Agreement', html: function (k) { return '<strong>' + esc(k.title) + '</strong><div class="muted">' + esc(kWhen(k)) + '</div>'; } },
            { label: 'Fee', num: true, html: function (k) { return esc(kMoney(k)); } },
            { label: 'Status', html: kStatus },
          ], list, { rowAttr: function (k) { return 'class="click" data-kopen="' + esc(k.id) + '" tabindex="0"'; } }) : '<p class="muted">No agreement yet.</p>');
        box.querySelector('[data-k-new]').onclick = function () { openContractEditor(null, l, refresh); };
        box.querySelectorAll('[data-kopen]').forEach(function (r2) { r2.onclick = function () { openContract(r2.getAttribute('data-kopen'), refresh); }; });
      });
    }
    refresh();
  }

  function renderContracts() {
    return api('contracts').then(function (d) {
      kCo = d.company || {}; kCo.emailReady = d.emailReady;
      var all = d.contracts || [];
      var real = all.filter(function (k) { return !k.is_test; });
      var by = function (st) { return real.filter(function (k) { return st.indexOf(k.status) >= 0; }); };
      var total = function (a) { return a.reduce(function (s2, k) { return s2 + Number(k.fee || 0); }, 0); };
      var signed = by(['signed']), out = by(['sent', 'viewed']);
      view.innerHTML = '<div class="row" style="margin-bottom:14px;gap:10px"><button class="btn" type="button" data-k-new>New agreement</button><span class="muted">Sent from ' + esc(kCo.from || '–') + ' · signed for ' + esc(kCo.name || '') + ' by ' + esc(kCo.signer || '') + ' · ' + esc(kCo.law || '') + ' law</span></div>' +
        '<div class="grid g-4">' + tile('Signed', n(signed.length), '$' + n(total(signed)) + ' in fees · $' + n(total(signed.filter(function (k) { return k.paid_at; }))) + ' paid') + tile('Waiting for signature', n(out.length), '$' + n(total(out)) + ' outstanding') +
        tile('Opened, not signed', n(by(['viewed']).length), 'reminders go out on day 2 and 5') + tile('Drafts', n(by(['draft']).length), 'not sent yet') + '</div>' +
        '<div class="card" style="margin-top:14px">' + (all.length ? table([
          { label: 'Client', html: function (k) { return '<strong>' + esc(kWho(k)) + '</strong><div class="muted">' + esc(k.client_email || '') + '</div>'; } },
          { label: 'Agreement', html: function (k) { return esc(k.title) + '<div class="muted">' + esc(kWhen(k)) + '</div>'; } },
          { label: 'Fee', num: true, html: function (k) { return esc(kMoney(k)); } },
          { label: 'Status', html: kStatus },
        ], all, { cards: true, rowAttr: function (k) { return 'class="click" data-kopen="' + esc(k.id) + '" tabindex="0" title="Preview and manage"'; } }) : '<p class="muted">No agreements yet. Press <strong>New agreement</strong>, or open a lead and use its Agreement card.</p>') + '</div>';
      view.querySelector('[data-k-new]').onclick = function () { openContractEditor(null, null, load); };
      view.querySelectorAll('[data-kopen]').forEach(function (r2) { r2.onclick = function () { openContract(r2.getAttribute('data-kopen'), load); }; });
    });
  }

  /** Funnel HQ → Sprint board (public/assets/deal-sprint-board.js): First Deal Sprint delivery and the value ladder. */
  function renderLiveEvents() {
    if (!window.LiveEventsBoard) { view.innerHTML = '<div class="card">The live webinars script didn’t load. Refresh the page.</div>'; return Promise.resolve(); }
    return window.LiveEventsBoard.render({ view: view, api: api, send: send, esc: esc, n: n, pct: pct, when: when, tile: tile, toast: toast, table: table, emptyState: emptyState, reload: load });
  }

  function renderCommand() {
    if (!window.CommandBoard) { view.innerHTML = '<div class="card">The Command script didn’t load. Refresh the page.</div>'; return Promise.resolve(); }
    return window.CommandBoard.render({
      view: view, api: api, send: send, esc: esc, n: n, pct: pct, when: when, ago: ago, tile: tile, toast: toast, emptyState: emptyState, reload: load,
      sub: state.commandSub || '',
      // Change the Command section (chat, approvals, thread=…). silent: only update the address, don't re-render.
      setSub: function (sub, o) {
        state.commandSub = sub || '';
        var h = '#command' + (state.commandSub ? '/' + state.commandSub : '');
        if (location.hash !== h) setHash(o && o.silent ? 'replaceState' : 'pushState', h);
        if (!(o && o.silent)) load();
      },
    });
  }

  function renderAutopilot() {
    if (!window.AdsAutopilot) { view.innerHTML = '<div class="card">The Ads autopilot script didn’t load. Refresh the page.</div>'; return Promise.resolve(); }
    return window.AdsAutopilot.render({ view: view, api: api, send: send, esc: esc, n: n, pct: pct, when: when, tile: tile, toast: toast, emptyState: emptyState, reload: load });
  }

  function renderSalesOps() {
    if (!window.SalesActions) { view.innerHTML = '<div class="card">The Follow-up actions script didn’t load. Refresh the page.</div>'; return Promise.resolve(); }
    return window.SalesActions.render({ view: view, api: api, send: send, esc: esc, n: n, pct: pct, when: when, tile: tile, toast: toast, emptyState: emptyState, reload: load });
  }

  function renderDmInbox() {
    if (!window.DmInbox) { view.innerHTML = '<div class="card">The DM inbox script didn’t load. Refresh the page.</div>'; return Promise.resolve(); }
    return window.DmInbox.render({ view: view, api: api, send: send, esc: esc, n: n, pct: pct, when: when, tile: tile, toast: toast, emptyState: emptyState, reload: load });
  }

  function renderChallenge() {
    if (!window.ChallengeBoard) { view.innerHTML = '<div class="card">The Challenge script didn’t load. Refresh the page.</div>'; return Promise.resolve(); }
    return window.ChallengeBoard.render({ view: view, api: api, send: send, esc: esc, n: n, pct: pct, when: when, tile: tile, toast: toast, emptyState: emptyState, reload: load });
  }

  function renderResearch() {
    if (!window.ResearchBoard) { view.innerHTML = '<div class="card">The Research script didn’t load. Refresh the page.</div>'; return Promise.resolve(); }
    return window.ResearchBoard.render({ view: view, api: api, send: send, esc: esc, n: n, pct: pct, when: when, tile: tile, toast: toast, emptyState: emptyState, reload: load });
  }

  function renderDealSprint() {
    if (!window.DealSprintBoard) { view.innerHTML = '<div class="card">The Sprint board script didn’t load. Refresh the page.</div>'; return Promise.resolve(); }
    return window.DealSprintBoard.render({
      view: view, api: api, send: send, esc: esc, n: n, pct: pct, when: when, tile: tile, toast: toast, emptyState: emptyState, reload: load,
      openContract: function (id) { openContract(id, load); },
    });
  }

  /** Funnel HQ → Clients and Support (public/assets/ops-e.js). */
  function renderClientsTab() {
    if (!window.ClientsBoard) { view.innerHTML = '<div class="card">The Clients script didn’t load. Refresh the page.</div>'; return Promise.resolve(); }
    return window.ClientsBoard.render({ view: view, esc: esc, n: n, when: when, tile: tile, toast: toast, emptyState: emptyState, reload: load });
  }
  function renderSupportTab() {
    if (!window.SupportBoard) { view.innerHTML = '<div class="card">The Support script didn’t load. Refresh the page.</div>'; return Promise.resolve(); }
    return window.SupportBoard.render({ view: view, esc: esc, n: n, when: when, tile: tile, toast: toast, emptyState: emptyState, reload: load });
  }

  function renderMaterials() {
    if (!window.Materials) { view.innerHTML = '<div class="card">The Materials script didn’t load. Refresh the page.</div>'; return Promise.resolve(); }
    return window.Materials.render({ view: view, api: api, esc: esc, toast: toast });
  }

  // ───────────── YouTube idea generator ─────────────
  var YT_BELIEF = { trust: 'Trust', like: 'Like', possible: 'It’s possible', can_solve: 'Josh can solve it', better: 'Better than alternatives', now: 'Act now' };
  var ytState = { sel: null, busy: false };
  function ytVideoActions(sp, t, st, pk) {
    var base = '/admin/api/yt/sprints/' + encodeURIComponent(sp.id) + '/videos/' + encodeURIComponent(t.id);
    var miro = pk && pk.miro_url ? '<a class="btn-sm ghost" href="' + esc(pk.miro_url) + '" target="_blank" rel="noopener">Open Miro board</a>'
      : '<button class="btn-sm ghost" type="button" data-yvid="miro" data-base="' + esc(base) + '"' + (st.miro ? '' : ' data-need="Add a Miro access token under Integrations → Content to build boards."') + '>Generate Miro board</button>';
    var doc = pk && pk.doc_url ? '<a class="btn-sm ghost" href="' + esc(pk.doc_url) + '" target="_blank" rel="noopener">Open Google Doc</a>'
      : '<button class="btn-sm ghost" type="button" data-yvid="gdoc" data-base="' + esc(base) + '"' + (st.google ? '' : ' data-need="1"') + '>Generate Google Doc</button>';
    return '<div class="yt-actions"><a class="btn-sm" href="' + esc(base) + '" target="_blank" rel="noopener">' + (pk ? 'Open script & slides' : 'Write script & slides') + '</a>' + doc + miro + '</div>' +
      (pk ? '<p class="muted small">' + (pk.source === 'written' ? 'Script written for this video' : pk.source === 'ai' ? 'Script written by Claude' : 'Script outline (add the Anthropic key for full word-for-word scripts)') + '</p>' : '');
  }
  function ytTopicCard(t, i, sp, st, packs) {
    var pk = packs ? packs[t.id] : null;
    return '<div class="yt-topic"><div class="yt-th"><span class="yt-id">' + esc(t.id.toUpperCase()) + '</span><h3>' + esc(t.topic) + '</h3></div>' + (sp ? ytVideoActions(sp, t, st, pk) : '') +
      '<div class="yt-pills"><span class="pill">' + esc(t.stage) + '</span><span class="pill">' + esc(YT_BELIEF[t.belief] || t.belief) + '</span><span class="pill">' + esc(String(t.awareness).replace('_', ' ')) + '</span><span class="pill ' + (t.demand === 'direct' ? 'st-won' : '') + '">' + esc(t.demand) + ' demand</span>' + (t.angle === 'controversial' ? '<span class="pill k-unpaid">controversial</span>' : '') + '<span class="pill">' + esc(t.length_min) + ' min</span></div>' +
      '<ol class="yt-titles">' + (t.titles || []).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ol>' +
      '<div class="yt-thumbs">' + (t.thumbnails || []).map(function (x) { return '<div class="yt-thumb"><strong>' + esc(x.text) + '</strong><span>' + esc(x.visual) + '</span><em>' + esc(x.emotion) + '</em></div>'; }).join('') + '</div>' +
      '<p class="yt-hook"><b>Hook:</b> ' + esc(t.hook) + '</p>' +
      '<details><summary>Outline, evidence and CTA</summary>' +
      '<p><b>Searched as:</b> “' + esc(t.demand_phrase) + '”<br><b>Evidence:</b> ' + esc(t.evidence) + '<br><b>Format:</b> ' + esc(t.format) + '</p>' +
      '<p><b>Intro + call-outs:</b> ' + esc(t.outline.intro_callouts) + '</p><ol>' + (t.outline.logic_ladder || []).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ol>' +
      '<p><b>Callbacks:</b> ' + esc(t.outline.callbacks) + '<br><b>Proof on screen:</b> ' + esc(t.outline.proof) + '<br><b>CTA (' + esc(t.cta.type) + '):</b> ' + esc(t.cta.line) + '<br><b>End screen →</b> ' + esc(t.next_video) + '</p></details></div>';
  }
  function ytDocHtml(sp) {
    var s = sp.sprint, d = new Date(sp.created_at).toISOString().slice(0, 10);
    var h = '<h1>YouTube sprint · ' + d + '</h1><p>' + esc(s.summary) + '</p><p><b>Binge path:</b> ' + esc(s.binge_path.map(function (id) { var t = s.topics.filter(function (x) { return x.id === id; })[0]; return t ? t.topic : id; }).join(' → ')) + '</p>';
    s.topics.forEach(function (t) {
      h += '<h2>' + esc(t.id.toUpperCase() + ' · ' + t.topic) + '</h2><ul><li><b>Titles:</b> ① ' + esc(t.titles[0] || '') + ' ② ' + esc(t.titles[1] || '') + '</li>' +
        '<li><b>Thumbnails:</b> ' + (t.thumbnails || []).map(function (x, n) { return (n ? '② ' : '① ') + '“' + esc(x.text) + '”: ' + esc(x.visual) + ' (' + esc(x.emotion) + ')'; }).join(' ') + '</li>' +
        '<li><b>Demand:</b> ' + esc(t.demand + ' · “' + t.demand_phrase + '” · ' + t.evidence) + '</li><li><b>Belief:</b> ' + esc(YT_BELIEF[t.belief] || t.belief) + ' · <b>Stage:</b> ' + esc(t.stage) + ' · <b>Awareness:</b> ' + esc(t.awareness) + ' · <b>Angle:</b> ' + esc(t.angle) + '</li>' +
        '<li><b>Format:</b> ' + esc(t.format) + ' (' + esc(t.length_min) + ' min)</li><li><b>Hook:</b> ' + esc(t.hook) + '</li><li><b>Intro + call-outs:</b> ' + esc(t.outline.intro_callouts) + '</li><li><b>Logic ladder:</b><ol>' + (t.outline.logic_ladder || []).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ol></li>' +
        '<li><b>Callbacks:</b> ' + esc(t.outline.callbacks) + '</li><li><b>Proof on screen:</b> ' + esc(t.outline.proof) + '</li><li><b>CTA (' + esc(t.cta.type) + '):</b> ' + esc(t.cta.line) + '</li><li><b>End screen →</b> ' + esc(t.next_video) + '</li></ul>';
    });
    h += '<h2>New angles to explore</h2><ul>' + (s.new_angles || []).map(function (a) { return '<li><b>' + esc(a.topic) + '</b> (' + esc(a.cluster) + '): ' + esc(a.why) + '</li>'; }).join('') + '</ul>';
    return h;
  }
  function ytCopy(html, text, what) {
    try {
      if (window.ClipboardItem && html) {
        navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]).then(function () { toast('Copied. ' + what); }, function () { navigator.clipboard.writeText(text).then(function () { toast('Copied as text. ' + what); }); });
      } else navigator.clipboard.writeText(text).then(function () { toast('Copied. ' + what); });
    } catch (e) { prompt('Copy this', text); }
  }
  function renderYtIdeas() {
    return api('yt/sprints').then(function (d) {
      var st = d.status, list = d.sprints || [];
      var sp = list.filter(function (x) { return x.id === ytState.sel; })[0] || list[0] || null;
      function chk(ok, label, hint) { return '<li class="' + (ok ? 'ok' : 'todo') + '"><span>' + (ok ? '✓' : '○') + '</span><div><b>' + esc(label) + '</b><div class="muted small">' + esc(hint) + '</div></div></li>'; }
      var inputs = '<div class="card"><div class="card-head"><div><h2>The 12 inputs</h2><p class="sub">What the generator reads every time. Green ones fill themselves.</p></div><a class="btn-sm ghost" href="#integrations">Edit the manual ones</a></div><ol class="yt-inputs">' +
        chk(true, '1 · Offer & buyer', '$1M+ owners buying with debt, seller finance and seller rollover') + chk(st.brand, '2 · Brand & backstory', st.brand ? 'Set' : 'Add under Integrations → Content') + chk(true, '3 · The six beliefs', 'Trust, like, possible, can solve, better, now') +
        chk(st.applicants > 0, '4 · Demand map', st.applicants + ' applicants’ own words, needs, industries, revenue') + chk(st.youtube, '5 · What’s winning in the niche', st.youtube ? 'Live outlier search on YouTube' : 'Add the YouTube Data API key to search outliers') + chk(st.adjacent > 0, '6 · Adjacent niches', st.adjacent + ' niches to borrow formats from') +
        chk(st.videos > 0, '7 · Your winners & losers', st.videos ? st.videos + ' videos, ranked by money, then calls, then views' : 'Connect the channel in Content') + chk(st.videos > 0, '8 · Why the losers lost', 'Compared against the channel median') + chk(st.proof, '9 · Proof & testimonials', st.proof ? 'Set' : 'None set: proof videos are skipped') +
        chk(st.notes, '10 · Standing rules', st.notes ? 'Set' : 'Optional') + chk(true, '11 · Funnel numbers', st.funnel.leads + ' leads, ' + st.funnel.booked + ' calls in 90 days; ' + st.funnel.youtubeLeads + ' from YouTube') + chk(true, '12 · Content library', st.videos + ' videos + ' + st.guides + ' guides to repurpose') + '</ol>' +
        (st.ai ? '' : '<p class="muted small">No Anthropic key yet, so plans come from the built-in rules engine (good, but generic). Add the key under Integrations → Email to have Claude write each plan from the full data.</p>') + '</div>';
      var demand = '<div class="card"><h2>What your applicants say</h2><p class="sub">The demand map, from booking and application answers.</p><div class="yt-chips">' + st.says.map(function (x) { return '<span class="chip">' + esc(x.k) + ' <b>' + n(x.n) + '</b></span>'; }).join('') + '</div>' +
        '<p class="sub" style="margin-top:10px">Industries</p><div class="yt-chips">' + st.industries.map(function (x) { return '<span class="chip">' + esc(x.k) + ' <b>' + n(x.n) + '</b></span>'; }).join('') + '</div>' +
        '<p class="sub" style="margin-top:10px">Revenue</p><div class="yt-chips">' + st.revenue.map(function (x) { return '<span class="chip">' + esc(x.k) + ' <b>' + n(x.n) + '</b></span>'; }).join('') + '</div>' +
        '<p class="sub" style="margin-top:10px">Phrases checked on YouTube: ' + esc(st.phrases.join(' · ')) + '</p></div>';
      var gen = '<div class="card yt-gen"><h2>Plan the next two weeks</h2><div class="row" style="gap:8px;flex-wrap:wrap"><input class="input" data-yfocus placeholder="Optional focus, e.g. “healthcare owners”, “objection: debt”, “more bottom-of-funnel”" style="flex:1;min-width:260px"><button class="btn-sm" type="button" data-ygen>' + (ytState.busy ? 'Writing the plan…' : 'Generate 5–10 topics') + '</button></div><p class="muted small" data-ymsg>' + (st.ai ? 'Takes about a minute.' : 'Instant (rules engine).') + '</p></div>';
      var sprintHtml = '';
      if (sp) {
        var s2 = sp.sprint;
        sprintHtml = '<div class="card"><div class="card-head"><div><h2>Sprint · ' + esc(new Date(sp.created_at).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })) + (sp.focus ? ' · focus: ' + esc(sp.focus) : '') + '</h2><p class="sub">' + esc(sp.source === 'ai' ? 'Written by Claude from the 12 inputs' : 'Rules engine') + ' · ' + s2.topics.length + ' topics</p></div>' +
          '<div class="row" style="gap:6px;flex-wrap:wrap"><a class="btn-sm" href="/admin/api/yt/sprints/' + esc(sp.id) + '/doc" target="_blank" rel="noopener">Open the brief</a>' +
          (sp.sprint.miro_url ? '<a class="btn-sm ghost" href="' + esc(sp.sprint.miro_url) + '" target="_blank" rel="noopener">Open Miro board</a>' : st.miro ? '<button class="btn-sm ghost" type="button" data-ymiro>Build Miro board</button>' : '<button class="btn-sm ghost" type="button" data-yexp="miro" title="Add a Miro token under Integrations → Content to build a full board">Copy for Miro</button>') +
          '<button class="btn-sm ghost" type="button" data-yexp="gdoc">Copy for Google Docs</button><a class="btn-sm ghost" href="/admin/api/yt/sprints/' + esc(sp.id) + '/md">Download .md</a>' +
          (list.length > 1 ? '<select class="input" data-ysel>' + list.map(function (x) { return '<option value="' + esc(x.id) + '"' + (x.id === sp.id ? ' selected' : '') + '>' + esc(new Date(x.created_at).toLocaleDateString([], { day: 'numeric', month: 'short' }) + (x.focus ? ' · ' + x.focus : '')) + '</option>'; }).join('') + '</select>' : '') + '</div></div>' +
          (st.googleClient && !st.google ? '<p class="yt-connect">Google Drive isn’t connected yet, so “Generate Google Doc” opens the designed doc to paste. <a class="btn-sm" href="/admin/api/google/connect">Connect Google Drive</a></p>' : '') + '<p>' + esc(s2.summary) + '</p>' +
          '<div class="yt-path"><b>Binge path</b> ' + s2.binge_path.map(function (id) { var t = s2.topics.filter(function (x) { return x.id === id; })[0]; return '<span class="chip">' + esc(id.toUpperCase()) + ' ' + esc(t ? t.topic : '') + '</span>'; }).join('<span class="muted">→</span>') + '</div>' +
          '<div class="yt-grid">' + s2.topics.map(function (t, i) { return ytTopicCard(t, i, sp, st, (d.packs || {})[sp.id]); }).join('') + '</div>' +
          '<div class="grid g-2" style="margin-top:14px"><div><h3>New angles to explore</h3><ul class="yt-angles">' + (s2.new_angles || []).map(function (a, i2) { return '<li><div><b>' + esc(a.topic) + '</b> <span class="pill">' + esc(a.cluster) + '</span><div class="muted small">' + esc(a.why) + '</div></div><button class="btn-sm ghost" type="button" data-yangle="' + i2 + '">Explore →</button></li>'; }).join('') + '</ul></div>' +
          '<div><h3>Checks</h3><p>Controversial: ' + esc(s2.checks.controversial_share) + '<br>Beliefs covered: ' + esc((s2.checks.beliefs_covered || []).map(function (b) { return YT_BELIEF[b] || b; }).join(', ')) + '</p>' + ((s2.checks.gaps || []).length ? '<ul>' + s2.checks.gaps.map(function (g) { return '<li class="muted">' + esc(g) + '</li>'; }).join('') + '</ul>' : '') +
          ((s2.outliers || []).length ? '<h3>Winning on YouTube now</h3><ul class="yt-out">' + s2.outliers.slice(0, 10).map(function (o) { return '<li><b>' + esc(o.x) + '×</b> <a href="' + esc(o.url) + '" target="_blank" rel="noopener">' + esc(o.title) + '</a> <span class="muted">' + esc(o.channel) + ' · ' + n(o.views) + ' views</span></li>'; }).join('') + '</ul>' : '') + '</div></div></div>';
      }
      view.innerHTML = gen + sprintHtml + '<div class="grid g-2" style="margin-top:14px">' + inputs + demand + '</div>';
      function generate(focus) {
        if (ytState.busy) return;
        ytState.busy = true;
        var tab = window.open('', '_blank');
        if (tab) tab.document.write('<!doctype html><title>Writing the plan…</title><body style="font:16px Arial;display:grid;place-items:center;height:90vh;color:#1F2A44;background:#F4F4EF"><p>Writing the sprint brief… this tab opens it when it is ready.</p></body>');
        var b = view.querySelector('[data-ygen]'); b.disabled = true; b.textContent = 'Writing the plan…';
        view.querySelector('[data-ymsg]').textContent = st.ai ? 'Reading the 12 inputs and writing the plan. About a minute; keep this tab open.' : 'Planning…';
        send('POST', 'yt/sprints', { focus: focus }).then(function (r) {
          ytState.busy = false;
          if (!r.ok) { if (tab) tab.close(); toast(r.error || 'Could not generate'); load(); return; }
          ytState.sel = r.id; toast('New sprint ready'); load();
          if (tab) tab.location = '/admin/api/yt/sprints/' + encodeURIComponent(r.id) + '/doc';
        }, function () { ytState.busy = false; if (tab) tab.close(); toast('Could not reach the server'); load(); });
      }
      view.querySelector('[data-ygen]').onclick = function () { generate(view.querySelector('[data-yfocus]').value.trim()); };
      var sel = view.querySelector('[data-ysel]'); if (sel) sel.onchange = function () { ytState.sel = sel.value; load(); };
      view.querySelectorAll('[data-yangle]').forEach(function (b) { b.onclick = function () { var a = sp.sprint.new_angles[Number(b.getAttribute('data-yangle'))]; view.querySelector('[data-yfocus]').value = a.topic; generate(a.topic); }; });
      view.querySelectorAll('[data-yvid]').forEach(function (b) {
        b.onclick = function () {
          var kind = b.getAttribute('data-yvid'), base = b.getAttribute('data-base'), need = b.getAttribute('data-need');
          // Not connected: Google opens the designed doc (it has “Copy into Google Docs”); Miro explains what's missing.
          if (need) { if (kind === 'gdoc') window.open(base, '_blank'); else toast(need); return; }
          var tab = window.open('', '_blank');
          if (tab) tab.document.write('<!doctype html><title>Building…</title><body style="font:16px Arial;display:grid;place-items:center;height:90vh;color:#1F2A44;background:#F4F4EF"><p>' + (kind === 'miro' ? 'Laying out the Miro board…' : 'Writing the Google Doc…') + ' this tab opens it when it is ready.</p></body>');
          b.disabled = true; b.textContent = kind === 'miro' ? 'Building board…' : 'Creating doc…';
          send('POST', base.replace('/admin/api/', '') + '/' + kind, {}).then(function (r) {
            if (!r.ok) { if (tab) tab.close(); toast(r.error || 'Could not build it'); load(); return; }
            if (tab) tab.location = r.url; else window.open(r.url, '_blank');
            toast(kind === 'miro' ? 'Miro board ready' : 'Google Doc ready'); load();
          }, function () { if (tab) tab.close(); toast('Could not reach the server'); load(); });
        };
      });
      var mb = view.querySelector('[data-ymiro]');
      if (mb) mb.onclick = function () {
        var tab = window.open('', '_blank'); mb.disabled = true; mb.textContent = 'Building the board…';
        send('POST', 'yt/sprints/' + encodeURIComponent(sp.id) + '/miro', {}).then(function (r) {
          if (!r.ok) { if (tab) tab.close(); toast(r.error || 'Could not build the board'); load(); return; }
          if (tab) tab.location = r.url; else window.open(r.url, '_blank');
          toast('Miro board ready'); load();
        }, function () { if (tab) tab.close(); toast('Could not reach the server'); load(); });
      };
      view.querySelectorAll('[data-yexp]').forEach(function (b) {
        b.onclick = function () {
          var s2 = sp.sprint;
          if (b.getAttribute('data-yexp') === 'gdoc') {
            var html = ytDocHtml(sp);
            ytCopy(html, html.replace(/<[^>]+>/g, '\n').replace(/\n{2,}/g, '\n'), 'Open a new Google Doc (docs.new) and paste.');
          } else {
            var lines = s2.topics.map(function (t) { return t.id.toUpperCase() + ' · ' + t.titles[0] + ' [' + t.stage + ' · ' + (YT_BELIEF[t.belief] || t.belief) + ']'; }).concat((s2.new_angles || []).map(function (a) { return 'IDEA · ' + a.topic; }));
            ytCopy(null, lines.join('\n'), 'Paste on a Miro board: each line becomes a sticky note.');
          }
        };
      });
    });
  }
  function wireCopy(root) {
    root.querySelectorAll('[data-copy]').forEach(function (b) {
      b.onclick = function () { var t = b.getAttribute('data-copy'); (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function () { toast('Copied ' + t); }, function () { prompt('Copy this link', t); }); };
    });
  }

  function renderTracking() {
    return api('tracking').then(function (d) {
      var c = d.configured;
      var sum = {};
      d.byDest.forEach(function (r) { (sum[r.dest] = sum[r.dest] || { sent: 0, failed: 0, retrying: 0 })[r.status] = r.n; });
      function destTile(key, label, on) {
        var x = sum[key] || { sent: 0, failed: 0, retrying: 0 };
        var total = x.sent + x.failed + x.retrying;
        return tile(label, on ? n(x.sent) + ' delivered' : 'Not connected', on ? (total ? pct(x.sent / total) + ' success · ' + n(x.retrying) + ' retrying · ' + n(x.failed) + ' failed' : 'No events in this range yet') : 'Connect it under Integrations');
      }
      var LABELS = { em: 'Email', ph: 'Phone', fn: 'First name', ln: 'Last name', external_id: 'External ID', client_ip_address: 'IP address', client_user_agent: 'User agent', fbp: 'Browser ID (fbp)', fbc: 'Click ID (fbc)', ct: 'City', st: 'State', zp: 'Postcode', country: 'Country' };
      view.innerHTML =
        '<div class="grid g-3 tiles">' + destTile('meta', 'Meta Conversions API', c.meta) + destTile('ga4', 'GA4 Measurement Protocol', c.ga4) +
        tile('Meta Pixel', c.pixel ? 'On' : 'Off', c.pixel ? 'Browser events share event IDs with the server, so Meta deduplicates' + (c.testMode ? ' · TEST MODE ON' : '') : 'Add the Pixel ID under Integrations') + '</div>' +
        '<div class="grid g-2" style="margin-top:14px"><div class="card"><h2>Meta match keys</h2><p class="sub">Share of the last ' + n(d.metaSample) + ' Meta events that carried each customer-information key. More keys means a higher Event Match Quality.</p>' +
        (d.metaSample ? barList(d.coverage.map(function (k) { return { name: LABELS[k.key] || k.key, value: Math.round(k.pct * 100) }; }), { max: 100, fmt: function (v) { return v + '%'; } }) : emptyState('No Meta events sent yet.')) + '</div>' +
        '<div class="card"><h2>Send a test event</h2><p class="sub">In Meta Events Manager open your Pixel, then Test events, and copy the test code. The event shows up there within seconds.</p><div class="row"><input class="input" data-code placeholder="TEST12345" style="flex:1"><button class="btn-sm" data-test-meta type="button">Send test</button></div><p class="muted" data-test-out style="margin-top:10px"></p></div></div>' +
        '<div class="card" style="margin-top:14px"><h2>By event</h2>' + table([{ label: 'Destination', key: 'dest' }, { label: 'Event', key: 'event_name' }, { label: 'Sent', key: 'sent', num: true, fmt: n }, { label: 'Retrying', key: 'retrying', num: true, fmt: n }, { label: 'Failed', key: 'failed', num: true, fmt: n }, { label: 'Last', html: function (r) { return esc(when(r.last_at)); } }], d.byEvent, { cards: true, emptyHint: 'Appears once Meta CAPI or GA4 is connected under Integrations.' }) + '</div>' +
        '<div class="card" style="margin-top:14px"><h2>Problems</h2><p class="sub">Failed sends are retried automatically with back-off (1 min, 4 min, 16 min, 1 h, then every few hours). Meta only accepts events up to 7 days old.</p>' +
        (d.failures.length ? table([{ label: 'When', html: function (r) { return esc(when(r.ts)); } }, { label: 'Destination', key: 'dest' }, { label: 'Event', key: 'event_name' }, { label: 'Status', key: 'status' }, { label: 'Tries', key: 'attempts', num: true }, { label: 'Error', html: function (r) { return esc(((r.http_status ? r.http_status + ' ' : '') + (r.error || '')).slice(0, 160)); } }], d.failures, { cards: true }) : emptyState('Nothing failing.')) + '</div>';
      view.querySelector('[data-test-meta]').onclick = function () {
        var out = view.querySelector('[data-test-out]');
        out.textContent = 'Sending…';
        send('POST', 'tracking/test-meta', { code: view.querySelector('[data-code]').value }).then(function (r) { out.textContent = r.ok ? 'Meta received ' + r.events_received + ' event (trace ' + r.fbtrace_id + '). Check Test events.' : (r.error || 'Failed'); });
      };
    });
  }

  var CALL_STATUS = { queued: 'Queued', dialing: 'Calling…', done: 'Done', no_answer: 'No answer', failed: 'Failed', skipped: 'Skipped', cancelled: 'Cancelled' };
  function callOutcome(o) {
    var f = {}; try { f = JSON.parse(o.outcome || '{}'); } catch (x) { /* ignore */ }
    return [f.appointment_confirmed && 'confirmed', f.wants_reschedule && 'reschedule', f.wants_booking_link && 'wants link', f.do_not_call && 'do not call', f.bad_time && 'bad time'].filter(Boolean).join(' · ');
  }

  /** What kind of provider error this is, read only from its status code ("ElevenLabs 401: …") or its JSON status, never from
   *  digits elsewhere in the text (a phone number or request id with 401 / 429 in it). 'auth' | 'rate' | ''. */
  function errKind(s) {
    s = String(s || '');
    var m = /^[A-Za-z][\w.\- ]*?\s([45]\d\d)(?::|\s*\{|\s*$)/.exec(s), code = m ? m[1] : '';
    var j = errJson(s), st = j && j.detail && typeof j.detail === 'object' ? String(j.detail.status || j.detail.code || '') : '';
    if (code === '401' || st === 'invalid_api_key' || st === 'unauthorized') return 'auth';
    if (code === '429' || st === 'rate_limit_exceeded' || st === 'too_many_requests') return 'rate';
    return '';
  }
  function errJson(s) { var i = s.indexOf('{'); if (i < 0) return null; try { return JSON.parse(s.slice(i)); } catch (e) { return null; } }
  /** A provider error ("ElevenLabs 401: {json}") as one plain sentence. Plain text: callers esc() it.
   *  status: the queue row's status, so "will retry" is only promised while it's still queued. */
  function friendlyErr(s, status) {
    s = String(s || '');
    var head = s.split('{')[0].replace(/[:\s]+$/, ''), j = errJson(s), msg = '';
    if (j) msg = (j.detail && (j.detail.message || (typeof j.detail === 'string' ? j.detail : ''))) || j.message || j.error || '';
    if (typeof msg !== 'string') msg = '';
    var who = (/^([A-Za-z][\w.\-]*)\s[45]\d\d\b/.exec(head) || [0, 'ElevenLabs'])[1], kind = errKind(s);
    if (kind === 'auth') return who + ' rejected the API key' + (msg ? ' (' + msg + ')' : '') + '.';
    if (kind === 'rate') return 'Rate-limited by ' + who + (status === 'queued' || status === 'dialing' ? ', will retry.' : '.');
    return (head + (msg ? ' · ' + msg : '')).slice(0, 120) || s.slice(0, 80);
  }
  var CALL_PILL = { done: 'st-won', queued: 'st-booked', dialing: 'st-booked', failed: 'st-failed', cancelled: 'st-cancelled', skipped: 'st-cancelled', no_answer: 'st-cancelled' };

  function elevenCard(e) {
    // Three states: done (green ✓), failing (amber !), not done yet (empty ring).
    var step = function (ok, label, body, warn) { return '<li class="setup-step' + (ok ? ' ok' : warn ? ' warn' : '') + '"><span class="dot">' + (ok ? '✓' : warn ? '!' : '') + '</span><div><b>' + label + '</b>' + (body ? '<div class="muted">' + body + '</div>' : '') + '</div></li>'; };
    var phones = e.phoneNumbers || [];
    var phoneOk = !!e.phoneNumberId && !e.phoneError;
    var intLink = '<a href="#integrations" data-go="integrations">Open Integrations →</a>';
    var keyLink = 'Check the key → <a href="#integrations" data-go="integrations">Open Integrations</a>';
    // The phone-number lookup runs live with the saved key on every visit, so it says whether the key works right now
    // (old failed calls in the queue may predate a fixed key). Step 1, step 3 and the pill all follow it.
    var elAuth = function (x) { x = String(x || ''); return errKind(x) === 'auth' && (/^ElevenLabs\b/i.test(x) || !/^[A-Za-z][\w.\-]*\s[45]\d\d/.test(x)); }; // another provider's 401 isn't this key
    var keyBad = !!e.apiKey && elAuth(e.phoneError);
    var phoneErrHtml = e.phoneError ? esc(friendlyErr(e.phoneError)) + ' ' + (errKind(e.phoneError) === 'auth' ? keyLink : intLink) + '<details class="raw"><summary>details</summary><code>' + esc(e.phoneError) + '</code></details>' : '';
    var needsFix = keyBad || !!e.phoneError;
    var pill = e.ready && !needsFix ? '<span class="pill ok">live</span>' : needsFix ? '<span class="pill pill-warn">needs fixing</span>' : '<span class="pill">not set up</span>';
    // Two or more failed calls for the same reason: say it once above the table.
    var errGroups = {}, errAuth = {};
    (e.queue || []).forEach(function (o) { if (o.error && o.status === 'failed') { var f = friendlyErr(o.error, o.status); errGroups[f] = (errGroups[f] || 0) + 1; if (errKind(o.error) === 'auth') errAuth[f] = true; } });
    var sharedErr = Object.keys(errGroups).filter(function (f) { return errGroups[f] > 1; }).sort(function (x, y) { return errGroups[y] - errGroups[x]; })[0];
    return '<div class="card"><div class="card-head"><div><h2>AI calls · ElevenLabs</h2><p class="sub">Calls applicants who ticked the call-consent box: confirms the appointment ~2 min after they book, and calls qualified leads who applied but didn’t book (~5 min). Only inside their local calling hours (Mon–Fri 9–8, Sat 9–5), max 2 attempts, discloses AI + recording, and stops for good if they say so.</p></div>' +
      pill + '</div>' +
      '<ol class="setup">' +
      step(e.apiKey && !keyBad, '1. API key', keyBad ? 'Saved, but ElevenLabs rejects it. Paste a fresh key under <a href="#integrations" data-go="integrations">Integrations → Voice</a>.' : e.apiKey ? 'Connected.' : 'Paste it under <a href="#integrations" data-go="integrations">Integrations → Voice → ElevenLabs API key</a> (elevenlabs.io → Developers → API keys).', keyBad) +
      step(!!e.agentId, '2. Agent', (e.agentId ? 'Agent <span class="mono">' + esc(e.agentId) + '</span>. ' : '') + '<button class="btn-sm' + (e.agentId ? ' ghost' : '') + '" data-el-provision' + (e.apiKey ? '' : ' disabled') + '>' + (e.agentId ? 'Update agents in ElevenLabs' : 'Create agents in ElevenLabs') + '</button>') +
      step(phoneOk, '3. Phone number', (phones.length ? phoneErrHtml + '<select class="input" data-el-phone><option value="">Pick the number to call from…</option>' + phones.map(function (p) { return '<option value="' + esc(p.phone_number_id) + '"' + (p.phone_number_id === e.phoneNumberId ? ' selected' : '') + '>' + esc(p.phone_number + (p.label ? ' · ' + p.label : '') + ' (' + p.provider + ')') + '</option>'; }).join('') + '</select>' :
        (e.phoneError ? phoneErrHtml : 'In ElevenLabs → Phone numbers, import a Twilio number (or SIP trunk). It shows up here.')), !!e.phoneError) +
      step(e.inboundAssigned, '4. Callbacks (inbound)', e.inboundAgentId ? (e.inboundAssigned ? 'Callback agent <span class="mono">' + esc(e.inboundAgentId) + '</span> answers anyone who rings the number back, looks them up by caller ID, and logs the outcome.' : 'Callback agent created but not on the number yet. Pick the number, then press “Update agents”.') : 'Press “Create agents” to also answer people who ring the number back.') +
      step(e.webhook.secret, '5. Post-call webhook (optional, faster results)', 'ElevenLabs → Agents → Settings → Post-call webhook → URL <span class="mono">' + esc(e.webhook.url) + '</span>, then paste its secret under Integrations → Voice. Without it results are fetched every 5 minutes.') +
      '</ol>' +
      '<div class="row" style="margin-top:12px"><input class="input" data-el-to placeholder="Your mobile, e.g. +61412345678" style="flex:1;min-width:200px"><select class="input" data-el-kind><option value="confirm">Confirmation script</option><option value="speed_to_lead">Speed-to-lead script</option></select><button class="btn-sm" data-el-test' + (e.ready ? '' : ' disabled') + '>Call me (test)</button></div>' +
      '<p class="muted" style="margin-top:8px">Confirmation calls: <b>' + (e.confirm ? 'on' : 'off') + '</b> · Speed-to-lead: <b>' + (e.speedToLead ? 'on' : 'off') + '</b> · No-show rebook: <b>' + (e.rebook ? 'on' : 'off') + '</b> (toggle under Integrations → Voice) · ' + n(e.stats && e.stats.consented) + ' leads have consented to calls.</p></div>' +
      '<div class="card" style="margin-top:14px"><h2>Call queue</h2>' +
      (sharedErr ? '<p class="muted queue-err">' + esc(n(errGroups[sharedErr]) + ' calls failed: ' + sharedErr) + ' ' + (errAuth[sharedErr] ? keyLink : intLink) + '</p>' : '') +
      table([
        { label: 'When', nw: true, html: function (o) { return esc(when(o.status === 'queued' ? o.run_at : o.updated_at)); } },
        { label: 'Lead', nw: true, html: function (o) { return '<a href="#lead=' + esc(o.lead_id) + '" data-open="' + esc(o.lead_id) + '">' + esc([o.first_name, o.last_name].filter(Boolean).join(' ') || o.phone || 'lead') + '</a>' + (o.tier ? ' <span class="tier ' + esc(o.tier) + '">' + esc(o.tier) + '</span>' : ''); } },
        { label: 'Call', html: function (o) { return esc(o.kind === 'speed_to_lead' ? 'Speed-to-lead' : o.kind === 'confirm' ? 'Confirm booking' : o.kind) + ' <span class="muted">#' + esc(o.attempts || 1) + '</span>'; } },
        { label: 'Status', html: function (o) { return '<span class="pill' + (CALL_PILL[o.status] ? ' ' + CALL_PILL[o.status] : '') + '">' + esc(CALL_STATUS[o.status] || o.status) + '</span>' + (o.error ? ' <span class="muted err-short' + (sharedErr && friendlyErr(o.error, o.status) === sharedErr ? ' err-dup' : '') + '" title="' + esc(o.error) + '">' + esc(friendlyErr(o.error, o.status)) + '</span>' : ''); } },
        { label: 'Outcome', html: function (o) { return esc(callOutcome(o)); } },
      ], e.queue, { cards: true }) + '</div>';
  }

  function renderVoice() {
    return Promise.all([api('voice'), api('voice/elevenlabs', null, { noRange: true }).catch(function () { return null; })]).then(function (res) {
      var d = res[0], e = res[1];
      var t = d.totals || {};
      view.innerHTML =
        (e ? elevenCard(e) : '') +
        '<div class="grid g-3 tiles" style="margin-top:14px">' + tile('AI calls', n(t.calls || 0), n(t.phone || 0) + ' inbound phone · ' + n(t.web || 0) + ' browser · ' + n((t.calls || 0) - (t.phone || 0) - (t.web || 0)) + ' outbound') + tile('Wanted a strategy call', n(t.wants_call || 0), n(t.callbacks || 0) + ' asked for a person to call back') +
        tile('Avg length', t.avg_s ? secs(t.avg_s) : '–', (t.cost ? '$' + t.cost + ' cost · ' : '') + n(t.opt_outs || 0) + ' opted out') + '</div>' +
        '<div class="card" style="margin-top:14px"><h2>Calls</h2><p class="sub">Inbound (Vapi) and outbound (ElevenLabs). Every call opens with an AI + recording disclosure.</p>' +
        (d.calls.length ? table([
          { label: 'When', nw: true, html: function (v) { return esc(when(v.created_at)); } },
          { label: 'Who', html: function (v) { return v.lead_id ? '<a href="#lead=' + esc(v.lead_id) + '" data-open="' + esc(v.lead_id) + '">' + esc([v.first_name, v.last_name].filter(Boolean).join(' ') || 'lead') + '</a>' + (v.tier ? ' <span class="tier ' + esc(v.tier) + '">' + esc(v.tier) + '</span>' : '') : '<span class="muted">' + esc(v.from_number || 'unknown') + '</span>'; } },
          { label: 'Type', html: function (v) { return esc({ ai_confirm: 'Outbound · confirm', ai_speed_to_lead: 'Outbound · speed-to-lead', ai_callback: 'Callback (inbound)', phone: 'Inbound phone', web: 'Browser' }[v.kind] || v.kind); } },
          { label: 'Length', html: function (v) { return esc(v.duration_s ? secs(v.duration_s) : v.status); } },
          { label: 'Summary', html: function (v) { return esc((v.summary || '').slice(0, 180)); } },
          { label: 'Rec.', html: function (v) { return v.recording_url ? '<a href="' + esc(v.recording_url) + '" target="_blank" rel="noopener">▶</a>' : ''; } },
        ], d.calls, { cards: true }) : '<p class="muted">No AI calls yet.</p>') + '</div>';
      view.querySelectorAll('[data-open]').forEach(function (a) { a.onclick = function (ev) { ev.preventDefault(); openLead(a.getAttribute('data-open')); }; });
      view.querySelectorAll('[data-go]').forEach(function (a) { a.onclick = function (ev) { ev.preventDefault(); go(a.getAttribute('data-go')); }; });
      var pv = view.querySelector('[data-el-provision]');
      if (pv) pv.onclick = function () { pv.disabled = true; pv.textContent = 'Working…'; send('POST', 'voice/elevenlabs/provision', {}).then(function (r) { toast(r.ok ? ((r.created ? 'Agents created' : 'Agents updated') + (r.inbound && r.inbound.notes && r.inbound.notes.length ? ' — ' + r.inbound.notes.join(' ') : '')) : (r.error || 'Failed')); load(); }); };
      var ph = view.querySelector('[data-el-phone]');
      if (ph) ph.onchange = function () { send('POST', 'voice/elevenlabs/phone', { id: ph.value }).then(function () { toast('Saved'); load(); }); };
      var tb = view.querySelector('[data-el-test]');
      if (tb) tb.onclick = function () {
        tb.disabled = true;
        send('POST', 'voice/elevenlabs/test-call', { to: view.querySelector('[data-el-to]').value, kind: view.querySelector('[data-el-kind]').value }).then(function (r) { tb.disabled = false; toast(r.ok ? 'Calling you now…' : (r.error || 'Failed')); });
      };
    });
  }

  function kv(k, v) { return '<dt>' + esc(k) + '</dt><dd>' + esc(v == null || v === '' ? '–' : v) + '</dd>'; }

  var SMS_LABEL = { sms_confirm: 'Booking confirmed + join link', sms_24h: '24h before (reschedule link)', sms_1h: '1h before (join link)', sms_10m: '10 min before (join link)', sms_noshow_1: 'No-show: 10 min after', sms_noshow_2: 'No-show: next day', sms_abandon: 'Unfinished application (30 min)', sms_book_nudge: 'Qualified, not booked (2h)' };
  function smsCard(d) {
    if (!d) return '';
    return '<div class="card" style="margin-bottom:14px"><h2>Text messages (SMS)</h2><p class="sub">' +
      (d.configured ? (d.enabled ? 'Connected to Twilio.' : 'Connected but paused (SMS_ENABLED = false).') : 'Not connected yet: texts are simulated. Add Twilio under Integrations → SMS.') +
      ' Only to people who ticked “call or text me” (' + n(d.consent && d.consent.consented) + ' so far), 8am–8pm their time, max 3 a day, STOP opts out (' + n(d.consent && d.consent.opted_out) + '). Replies webhook: <span class="mono">' + esc(d.webhook) + '</span></p>' +
      table([
        { label: 'Text', html: function (r) { return esc(SMS_LABEL[r.template] || r.template); } },
        { label: 'Sent', key: 'sent', num: true, fmt: n }, { label: 'Clicked', key: 'clicked', num: true, fmt: n },
        { label: 'Waiting', key: 'pending', num: true, fmt: n }, { label: 'Skipped', key: 'skipped', num: true, fmt: n }, { label: 'Failed', key: 'failed', num: true, fmt: n },
      ], d.bySeq || []) +
      '<details style="margin-top:10px"><summary>Recent texts and replies</summary>' + table([
        { label: 'When', html: function (r) { return esc(ago(r.sent_at || r.created_at)); } },
        { label: 'Lead', html: function (r) { return esc([r.first_name, r.last_name].filter(Boolean).join(' ') || '–'); } },
        { label: '', html: function (r) { return r.direction === 'in' ? '⬅︎ reply' : esc(r.status); } },
        { label: 'Message', html: function (r) { return esc(r.body || SMS_LABEL[r.template] || '') + (r.error ? '<div class="muted">' + esc(r.error) + '</div>' : ''); } },
      ], d.recent || [], { rowAttr: function (r) { return r.lead_id ? 'class="click" data-lead="' + esc(r.lead_id) + '" tabindex="0"' : ''; } }) + '</details>' +
      '<div class="row" style="margin-top:10px"><input class="input" data-smsto placeholder="+61412345678" style="max-width:200px"> <button class="btn-sm ghost" data-smstest>Send test text</button> <span class="muted" data-smsmsg></span></div></div>';
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-smstest]');
    if (!b) return;
    var to = document.querySelector('[data-smsto]').value, msg = document.querySelector('[data-smsmsg]');
    msg.textContent = 'Sending…';
    send('POST', 'sms/test', { to: to }).then(function (r) { msg.textContent = r && r.ok ? 'Sent ✓' : (r && r.error) || 'Failed'; });
  });

  // ───────────── SMS builder ─────────────
  var SMS_REL = {
    trigger: [{ v: 'after', label: 'after it happens' }],
    call: [{ v: 'before', label: 'before the call' }, { v: 'after', label: 'after the call starts' }],
    webinar: [{ v: 'before', label: 'before the webinar' }, { v: 'after', label: 'after the webinar starts' }],
  };
  var SMS_LINK_LABEL = { none: 'No link', join: 'Meeting link (join)', reschedule: 'Reschedule link', book: 'Booking page', apply: 'Application', breakout: 'Prep video page', webinar_room: 'Their webinar room', webinar_replay: 'Webinar replay', challenge_today: 'Their challenge day page' };
  var SMS_SKIP_LABEL = { applied: 'they’ve applied', booked: 'they’ve booked', confirmed: 'they replied C', attended: 'they came to the webinar', missed: 'they missed the webinar', clicked: 'they clicked an earlier text' };
  var SMS_TAGS = ['first_name', 'call_time', 'closer', 'link', 'webinar_time', 'site_name'];
  var SAMPLE = { first_name: 'Dana', call_time: 'Thursday 16 October, 10:00 am AEDT', closer: 'Josh Li', link: 'apply.grosfjeld-li.com/s/k3x9q2', webinar_time: 'Tuesday 20 October, 7:00 pm AEDT', site_name: 'G&L' };
  function smsPreview(body) {
    var t = String(body || '').replace(/\{(\w+)\}/g, function (m, k) { return SAMPLE[k] != null ? SAMPLE[k] : m; }).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-');
    return t;
  }
  function smsSegs(t) {
    var gsm = /^[\n\r @£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/.test(t), len = t.length;
    return gsm ? (len <= 160 ? 1 : Math.ceil(len / 153)) : (len <= 70 ? 1 : Math.ceil(len / 67));
  }
  // Same as waTemplateText() on the server: merge tags → {{1}}, {{2}}… in order; no variable at the very start/end.
  function waTpl(st) {
    var i = 0, body = st.link !== 'none' && st.body.indexOf('{link}') < 0 ? st.body + ' {link}' : st.body;
    var t = body.replace(/\{(\w+)\}/g, function () { return '{{' + (++i) + '}}'; }).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').trim();
    if (/^\{\{/.test(t)) t = 'Hi ' + t;
    if (/\}\}[.!?]?$/.test(t)) t = t + '\n\n- G&L';
    return t;
  }
  function waVars(st) {
    var body = st.link !== 'none' && st.body.indexOf('{link}') < 0 ? st.body + ' {link}' : st.body, out = [];
    body.replace(/\{(\w+)\}/g, function (m, k) { out.push('{{' + (out.length + 1) + '}} = ' + k); return m; });
    return out.join(' · ');
  }
  function splitOffset(min) {
    var a = Math.abs(min);
    if (a && a % 1440 === 0) return { v: a / 1440, unit: 'days' };
    if (a && a % 60 === 0) return { v: a / 60, unit: 'hours' };
    return { v: a, unit: 'minutes' };
  }
  var smsState = null;
  function renderSmsTab() {
    return Promise.all([api('sms/sequences', {}, { noRange: true }), api('sms', {}, { noRange: true }).catch(function () { return null; })]).then(function (r) {
      smsState = { data: r[0], status: r[1], seqs: JSON.parse(JSON.stringify(r[0].sequences)), sel: (smsState && smsState.sel) || 'booked', dirty: false };
      drawSms();
    });
  }
  function smsStat(seq, n) {
    var x = (smsState.data.stats || []).filter(function (s) { return s.sequence === seq && Number(s.step) === n; })[0];
    return x ? n_(x.sent) + ' sent · ' + n_(x.clicked) + ' clicked' + (x.pending ? ' · ' + n_(x.pending) + ' waiting' : '') + (x.skipped ? ' · ' + n_(x.skipped) + ' skipped' : '') : 'not sent yet';
  }
  function n_(v) { return n(v || 0); }
  function setupCard(st) {
    st = st || {};
    var ok = function (b) { return b ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>'; };
    return '<div class="card"><h2>Setup</h2><ol class="sms-setup">' +
      '<li>' + ok(st.configured) + ' <strong>Connect Twilio</strong>: copy the Account SID and Auth Token from console.twilio.com into <a href="#integrations">Integrations → SMS</a>.</li>' +
      '<li>' + ok(st.configured) + ' <strong>Pick the sender</strong> (“Send texts from”): an Australian mobile number from Twilio (it can receive replies, so STOP and “C” work), or a Messaging Service (<span class="mono">MG…</span>) with that number in it. A sender name like “GLAdvisory” can’t receive replies. US leads need a US number registered for A2P 10DLC.</li>' +
      '<li><strong>Point replies here</strong>: Twilio → your number → Messaging → “A message comes in” → <span class="mono">' + esc(st.webhook || '') + '</span> (HTTP POST). That’s how STOP, “C” to confirm and replies reach Funnel HQ.</li>' +
      '<li>' + ok(st.enabled) + ' <strong>Sending is ' + (st.enabled ? 'on' : 'paused') + '</strong> (SMS_ENABLED). ' + n_(st.consent && st.consent.consented) + ' people have agreed to texts · ' + n_(st.consent && st.consent.opted_out) + ' replied STOP · ' + n_(smsState.data.confirmed) + ' confirmed by text.</li>' +
      '<li><strong>Send yourself a test</strong>: <input class="input" data-smsto placeholder="+61412345678" style="max-width:190px;display:inline-block"> <button class="btn-sm ghost" data-smstest>Send test text</button> <span class="muted" data-smsmsg></span></li>' +
      '</ol>' + (st.configured ? '' : '<p class="muted">Until Twilio is connected, texts are simulated: they’re written and logged here but not sent.</p>') +
      waSetup(smsState.data.whatsapp || {}) + '</div>';
  }
  function waSetup(w) {
    var ok = function (b) { return b ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>'; };
    return '<h3 style="margin-top:14px">WhatsApp (optional)</h3><ol class="sms-setup">' +
      '<li>' + ok(w.configured) + ' <strong>Connect the WhatsApp Cloud API</strong>: Meta Business → WhatsApp → API setup. Paste the permanent token and phone number ID into <a href="#integrations">Integrations → WhatsApp</a>.</li>' +
      '<li>' + ok(w.signed) + ' <strong>Webhook</strong>: callback URL <span class="mono">' + esc(w.webhook || '') + '</span>, your verify token, subscribe to <span class="mono">messages</span>. Add the app secret so replies (STOP, “C”) are trusted.</li>' +
      '<li><strong>Templates</strong>: switch a sequence to “WhatsApp first”, then for each text click “Copy template text” and create it in WhatsApp Manager (category Utility for reminders, Marketing for nudges) with the same name. Once approved it sends on WhatsApp; until then it goes by SMS.</li>' +
      '<li>' + n_(w.reachable) + ' leads can get WhatsApp (they agreed or have messaged you) · ' + n_(w.sent) + ' WhatsApp messages sent. Template language: <span class="mono">' + esc(w.lang || 'en') + '</span>.</li></ol>';
  }
  function drawSms() {
    var S = smsState, d = S.data, seq = S.seqs.filter(function (x) { return x.id === S.sel; })[0];
    var list = S.seqs.map(function (x) {
      return '<button class="sms-seq' + (x.id === S.sel ? ' on' : '') + '" data-seq="' + esc(x.id) + '"><span class="dot ' + (x.enabled ? 'live' : '') + '"></span><strong>' + esc(d.triggers[x.id] || x.id) + '</strong><span class="muted">' + x.steps.length + ' text' + (x.steps.length === 1 ? '' : 's') + (x.enabled ? '' : ' · off') + '</span></button>';
    }).join('');
    var rel = SMS_REL;
    var cards = seq.steps.map(function (st, i) {
      var off = splitOffset(st.offsetMin), dir = st.offsetMin < 0 ? 'before' : 'after';
      var rels = (rel.trigger).map(function (r) { return { a: 'trigger', v: r.v, label: r.label }; });
      if (seq.id === 'booked' || seq.id === 'no_show' || seq.id === 'showed') rels = rels.concat(rel.call.map(function (r) { return { a: 'call', v: r.v, label: r.label }; }));
      if (seq.id === 'webinar') rels = rels.concat(rel.webinar.map(function (r) { return { a: 'webinar', v: r.v, label: r.label }; }));
      if (seq.id === 'challenge') [1, 2, 3, 4, 5].forEach(function (d) { rels = rels.concat([{ a: 'day' + d, v: 'before', label: 'before Day ' + d + ' starts' }, { a: 'day' + d, v: 'after', label: 'after Day ' + d + ' starts' }]); });
      var relSel = '<select class="input" data-f="rel">' + rels.map(function (r) { var val = r.a + ':' + r.v; return '<option value="' + val + '"' + (st.anchor === r.a && (r.a === 'trigger' || r.v === dir) ? ' selected' : '') + '>' + esc(r.label) + '</option>'; }).join('') + '</select>';
      var prev = smsPreview(st.body);
      var segs = smsSegs(prev + (st.link !== 'none' && st.body.indexOf('{link}') < 0 ? ' ' + SAMPLE.link : ''));
      return '<div class="sms-step" draggable="true" data-i="' + i + '">' +
        '<div class="sms-row"><span class="grip" title="Drag to reorder">⋮⋮</span><span class="sms-n">Text ' + (i + 1) + '</span>' +
        '<input class="input" type="number" min="0" data-f="v" value="' + off.v + '" style="width:76px">' +
        '<select class="input" data-f="unit">' + ['minutes', 'hours', 'days'].map(function (u) { return '<option' + (u === off.unit ? ' selected' : '') + '>' + u + '</option>'; }).join('') + '</select>' + relSel +
        '<select class="input" data-f="link">' + d.links.map(function (l) { return '<option value="' + l + '"' + (l === st.link ? ' selected' : '') + '>' + esc(SMS_LINK_LABEL[l] || l) + '</option>'; }).join('') + '</select>' +
        '<button class="btn-sm ghost" data-dup title="Duplicate">⧉</button><button class="btn-sm ghost danger" data-del title="Delete">✕</button></div>' +
        '<textarea class="input sms-body" data-f="body" rows="3" maxlength="480">' + esc(st.body) + '</textarea>' +
        '<div class="sms-tags">' + SMS_TAGS.map(function (t) { return '<button class="chip" data-tag="' + t + '">{' + t + '}</button>'; }).join('') + '<span class="muted sms-count">' + prev.length + ' chars · ' + segs + ' SMS' + (segs > 2 ? ' (long)' : '') + '</span></div>' +
        '<div class="sms-preview"><span class="muted">Preview:</span> ' + esc(prev) + '</div>' +
        '<div class="sms-skip"><span class="muted">Skip this text if</span> ' + d.skips.map(function (k) { return '<label class="chip-check"><input type="checkbox" data-skip="' + k + '"' + (st.skip.indexOf(k) >= 0 ? ' checked' : '') + '> ' + esc(SMS_SKIP_LABEL[k] || k) + '</label>'; }).join('') + '</div>' +
        (seq.channel === 'whatsapp' ? '<div class="sms-wa"><span class="wa-badge">WhatsApp</span> template name <input class="input mono" data-f="wa" value="' + esc(st.wa || '') + '" placeholder="gl_' + esc(seq.id) + '_' + st.n + '" style="width:200px"> <button class="btn-sm ghost" data-copytpl>Copy template text</button> <span class="muted">' + esc(waVars(st)) + '</span>' +
          (st.wa ? '' : '<div class="muted">No template yet: goes by SMS unless they messaged you on WhatsApp in the last 24 hours.</div>') + '</div>' : '') +
        '<div class="sms-foot"><span class="muted">' + esc(smsStat(seq.id, st.n)) + '</span><button class="btn-sm ghost" data-testone>Send me this one</button></div></div>';
    }).join('');
    view.innerHTML = setupCard(S.status) +
      '<div class="sms-grid"><div class="sms-list card"><h2>Sequences</h2><p class="sub">One per moment in the funnel.</p>' + list + '</div>' +
      '<div class="card sms-editor"><div class="sms-head"><div><h2>' + esc(d.triggers[seq.id] || seq.id) + '</h2><p class="sub">Starts when this happens and stops by itself once it’s done its job (e.g. they book). Texts go out by their timing; drag to organise.</p></div>' +
      '<div class="row"><select class="input" data-channel title="How these messages are sent"><option value="sms"' + (seq.channel !== 'whatsapp' ? ' selected' : '') + '>Send by SMS</option><option value="whatsapp"' + (seq.channel === 'whatsapp' ? ' selected' : '') + '>WhatsApp first, SMS if not</option></select><label class="chip-check"><input type="checkbox" data-enabled' + (seq.enabled ? ' checked' : '') + '> On</label><button class="btn-sm ghost" data-reset>Reset to default</button><button class="btn-sm" data-save' + (S.dirty ? '' : ' disabled') + '>' + (S.dirty ? 'Save changes' : 'Saved') + '</button></div></div>' +
      '<div class="sms-palette"><span class="chip drag-new" draggable="true" data-new>＋ New text (drag into place)</span></div>' +
      '<div class="sms-steps" data-steps>' + (cards || '<div class="empty">No texts yet. Drag one in or click “Add text”.</div>') + '</div>' +
      '<button class="btn-sm ghost" data-add style="margin-top:10px">＋ Add text</button></div></div>';
    wireSms(seq);
  }
  function markDirty() { smsState.dirty = true; var b = view.querySelector('[data-save]'); if (b) { b.disabled = false; b.textContent = 'Save changes'; } }
  function wireSms(seq) {
    var S = smsState;
    view.querySelectorAll('[data-seq]').forEach(function (b) { b.onclick = function () { S.sel = b.getAttribute('data-seq'); drawSms(); }; });
    view.querySelector('[data-enabled]').onchange = function (e) { seq.enabled = e.target.checked; markDirty(); };
    view.querySelector('[data-channel]').onchange = function (e) { seq.channel = e.target.value; S.dirty = true; drawSms(); };
    view.querySelector('[data-reset]').onclick = function () {
      if (!confirm('Replace this sequence with the default texts? Unsaved changes are lost.')) return;
      var def = JSON.parse(JSON.stringify(S.data.defaults.filter(function (x) { return x.id === seq.id; })[0]));
      def.next = Math.max(def.next, seq.next);
      def.steps.forEach(function (st) { st.n = def.next++; }); // fresh numbers: earlier sends never collide
      S.seqs = S.seqs.map(function (x) { return x.id === seq.id ? def : x; });
      S.dirty = true; drawSms();
    };
    view.querySelector('[data-save]').onclick = function () {
      var b = this; b.disabled = true; b.textContent = 'Saving…';
      send('PUT', 'sms/sequences', { sequences: S.seqs }).then(function (r) {
        if (r && r.ok) { S.seqs = r.sequences; S.data.sequences = r.sequences; S.dirty = false; drawSms(); }
        else { b.disabled = false; b.textContent = 'Save changes'; alert((r && r.error) || 'Couldn’t save'); }
      });
    };
    var newStep = function () { return { n: seq.next++, body: 'Hi {first_name}, ', anchor: 'trigger', offsetMin: 60, link: 'none', skip: [] }; };
    view.querySelector('[data-add]').onclick = function () { seq.steps.push(newStep()); markDirty(); drawSms(); };
    view.querySelectorAll('.sms-step').forEach(function (card) {
      var i = Number(card.getAttribute('data-i')), st = seq.steps[i];
      var read = function () {
        var v = Math.max(0, Number(card.querySelector('[data-f="v"]').value) || 0), unit = card.querySelector('[data-f="unit"]').value;
        var rel = card.querySelector('[data-f="rel"]').value.split(':');
        var mins = v * (unit === 'days' ? 1440 : unit === 'hours' ? 60 : 1);
        st.anchor = rel[0]; st.offsetMin = rel[0] !== 'trigger' && rel[1] === 'before' ? -mins : mins;
        st.link = card.querySelector('[data-f="link"]').value;
        st.body = card.querySelector('[data-f="body"]').value;
        st.skip = Array.prototype.slice.call(card.querySelectorAll('[data-skip]:checked')).map(function (x) { return x.getAttribute('data-skip'); });
        var waIn = card.querySelector('[data-f="wa"]');
        if (waIn) { st.wa = waIn.value.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_'); var vv = card.querySelector('.sms-wa > .muted'); if (vv) vv.textContent = waVars(st); }
        var prev = smsPreview(st.body), segs = smsSegs(prev + (st.link !== 'none' && st.body.indexOf('{link}') < 0 ? ' ' + SAMPLE.link : ''));
        card.querySelector('.sms-preview').innerHTML = '<span class="muted">Preview:</span> ' + esc(prev);
        card.querySelector('.sms-count').textContent = prev.length + ' chars · ' + segs + ' SMS' + (segs > 2 ? ' (long)' : '');
        markDirty();
      };
      card.querySelectorAll('input, select, textarea').forEach(function (el) { el.addEventListener('input', read); el.addEventListener('change', read); });
      card.querySelectorAll('[data-tag]').forEach(function (b) {
        b.onclick = function () {
          var ta = card.querySelector('[data-f="body"]'), tag = '{' + b.getAttribute('data-tag') + '}', p = ta.selectionStart || ta.value.length;
          ta.value = ta.value.slice(0, p) + tag + ta.value.slice(ta.selectionEnd || p); ta.focus(); ta.selectionStart = ta.selectionEnd = p + tag.length; read();
        };
      });
      card.querySelector('[data-del]').onclick = function () { if (confirm('Delete this text? Any not-yet-sent copies are skipped.')) { seq.steps.splice(i, 1); markDirty(); drawSms(); } };
      card.querySelector('[data-dup]').onclick = function () { var c = JSON.parse(JSON.stringify(st)); c.n = seq.next++; seq.steps.splice(i + 1, 0, c); markDirty(); drawSms(); };
      var cp = card.querySelector('[data-copytpl]');
      if (cp) cp.onclick = function () {
        var t = waTpl(st);
        (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function () { cp.textContent = 'Copied ✓'; setTimeout(function () { cp.textContent = 'Copy template text'; }, 1500); }, function () { prompt('Copy this template text:', t); });
      };
      card.querySelector('[data-testone]').onclick = function () {
        var to = (view.querySelector('[data-smsto]') || {}).value || prompt('Your mobile, in international format (+61…):');
        if (!to) return;
        send('POST', 'sms/test-step', { to: to, step: st, channel: seq.channel || 'sms' }).then(function (r) { alert(r && r.ok ? 'Sent to ' + to : (r && r.error) || 'Failed'); });
      };
      // drag to reorder
      card.addEventListener('dragstart', function (e) { if (/TEXTAREA|INPUT|SELECT/.test(e.target.tagName)) { e.preventDefault(); return; } e.dataTransfer.setData('text/plain', 'move:' + i); card.classList.add('dragging'); });
      card.addEventListener('dragend', function () { card.classList.remove('dragging'); });
    });
    var box = view.querySelector('[data-steps]');
    var dropIndex = function (y) {
      var cards = Array.prototype.slice.call(box.querySelectorAll('.sms-step'));
      for (var k = 0; k < cards.length; k++) { var r = cards[k].getBoundingClientRect(); if (y < r.top + r.height / 2) return k; }
      return cards.length;
    };
    box.addEventListener('dragover', function (e) { e.preventDefault(); box.classList.add('over'); });
    box.addEventListener('dragleave', function () { box.classList.remove('over'); });
    box.addEventListener('drop', function (e) {
      e.preventDefault(); box.classList.remove('over');
      var what = e.dataTransfer.getData('text/plain'), to = dropIndex(e.clientY);
      if (what === 'new') seq.steps.splice(to, 0, newStep());
      else if (what.indexOf('move:') === 0) { var from = Number(what.slice(5)), item = seq.steps.splice(from, 1)[0]; seq.steps.splice(from < to ? to - 1 : to, 0, item); }
      else return;
      markDirty(); drawSms();
    });
    var pal = view.querySelector('[data-new]');
    pal.addEventListener('dragstart', function (e) { e.dataTransfer.setData('text/plain', 'new'); });
  }

  // ───────────── Pre-call flow (top of Emails) ─────────────
  var PC_STAGE_CLS = ['', 'st1', 'st2', 'st3', 'st4', 'st5'];
  var pcState = { hours: 30 };
  // ───────────── Content (YouTube / Instagram) ─────────────
  var ctState = { platform: 'youtube', sort: 'views' };
  function renderSearch() {
    return api('search').then(function (d) {
      var st = d.setup || {};
      var hitsTotal = d.bots.reduce(function (a, b) { return a + b.hits; }, 0);
      var aiHits = d.bots.filter(function (b) { return b.purpose && b.purpose !== 'Search engine'; }).reduce(function (a, b) { return a + b.hits; }, 0);
      var vis = function (ch) { var r = d.visits.filter(function (v) { return v.channel === ch; })[0]; return r ? r.visitors : 0; };
      var ld = function (ch, k) { var r = d.leads.filter(function (v) { return v.channel === ch; })[0]; return r ? r[k] : 0; };
      var check = function (ok, label, hint) { return '<li class="' + (ok ? 'ok' : 'todo') + '"><span>' + (ok ? '✓' : '○') + '</span><div><strong>' + esc(label) + '</strong>' + (hint ? '<div class="muted">' + hint + '</div>' : '') + '</div></li>'; };
      var link = function (u) { return '<a href="' + esc(u) + '" target="_blank" rel="noopener" class="mono">' + esc(String(u).replace(/^https?:\/\//, '')) + '</a>'; };
      var last = st.indexnowLast;
      var guides = (d.guides || []).slice().sort(function (a, b) { return (b.views - a.views) || a.h1.localeCompare(b.h1); });
      view.innerHTML =
        '<div class="grid g-4 tiles">' +
        tile('AI crawler visits', n(aiHits), 'ChatGPT, Claude, Perplexity, Gemini, Grok…') +
        tile('Search engine crawls', n(hitsTotal - aiHits), 'Google, Bing, Apple…') +
        tile('Visitors from AI answers', n(vis('AI Search')), n(ld('AI Search', 'applied')) + ' applied · ' + n(ld('AI Search', 'booked')) + ' booked') +
        tile('Visitors from Google & Bing', n(vis('Organic Search')), n(ld('Organic Search', 'applied')) + ' applied · ' + n(ld('Organic Search', 'booked')) + ' booked') +
        '</div>' +
        '<div class="grid" style="margin-top:14px"><div class="card"><h2>Crawler visits per day</h2><p class="sub">AI crawlers (search, live answers and training) reading your pages.</p><div class="chart" data-sc-ai></div></div>' +
        '<div class="card"><h2>Setup</h2><p class="sub">What helps you show up, and what’s left to do.</p><ul class="checklist">' +
        check(st.indexing, 'Pages open to search & AI', st.indexing ? st.pages + ' public pages in ' + link(st.sitemap) + ', ' + st.guides + ' guides, ' + link(st.llms) + ' for AI assistants.' : 'Switched off under Integrations → Search.') +
        check(st.google, 'Google Search Console', st.google ? 'Verified tag is on every page. Submit ' + link(st.sitemap) + ' in Search Console → Sitemaps.' : 'Add the site at search.google.com/search-console (URL prefix → HTML tag) and paste the code in Integrations → Search. Then submit the sitemap.') +
        check(st.bing, 'Bing Webmaster Tools', st.bing ? 'Verified. Bing powers ChatGPT search and Copilot.' : 'Add the site at bing.com/webmasters and paste the code in Integrations → Search (or import from Google Search Console). Bing feeds ChatGPT search and Copilot.') +
        check(last && last.at, 'IndexNow (instant indexing on Bing & others)', last && last.at ? 'Last sent ' + esc(new Date(last.at).toLocaleString()) + ': ' + esc(last.results.map(function (r) { return r.host + ' ' + r.urls + ' pages (' + (r.status >= 200 && r.status < 300 ? 'ok' : 'status ' + r.status) + ')'; }).join(', ')) : 'Send every page to Bing, Yandex and others now. Do it again after adding pages.') +
        check(st.sameAs, 'Josh’s profiles linked', st.sameAs ? 'AI assistants can connect the site to Josh.' : 'Using Instagram and YouTube by default. Add LinkedIn and X under Integrations → Search.') +
        check(st.xHandle, 'X handle for link previews', st.xHandle ? 'Shown when pages are shared on X.' : 'Add it under Integrations → Search.') +
        '</ul><div class="row" style="margin-top:12px"><button class="btn-sm" data-indexnow>Send all pages to IndexNow</button><a class="btn-sm ghost" href="#integrations">Search settings</a></div></div></div>' +
        '<div class="grid" style="margin-top:14px"><div class="card"><h2>Which AI & search crawlers</h2><p class="sub">“AI search” and “live answer” bots are what get you cited in answers; “training” bots feed future models.</p>' +
        (d.bots.length ? table([
          { label: 'Crawler', html: function (r) { return '<strong>' + esc(r.bot) + '</strong><div class="muted">' + esc(r.vendor) + '</div>'; } },
          { label: 'Kind', html: function (r) { return '<span class="pill">' + esc(r.purpose) + '</span>'; } },
          { label: 'Visits', key: 'hits', num: true, fmt: n }, { label: 'Pages', key: 'pages', num: true, fmt: n },
          { label: 'Last seen', html: function (r) { return esc(new Date(r.last_at).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })); } },
        ], d.bots, { cards: true }) : '<p class="muted">No crawler visits yet. They usually start within days of the pages going live; sending the pages to IndexNow and Search Console speeds it up.</p>') + '</div>' +
        '<div class="card"><h2>Where AI & search visitors come from</h2><p class="sub">People who clicked through from an answer or a search result.</p>' +
        (d.refs.length ? table([
          { label: 'Source', html: function (r) { return '<strong>' + esc(r.source) + '</strong><div class="muted">' + esc(r.channel) + '</div>'; } },
          { label: 'Visits', key: 'sessions', num: true, fmt: n },
        ], d.refs, { cards: true }) : '<p class="muted">None yet in this range.</p>') + '</div></div>' +
        '<div class="card" style="margin-top:14px"><h2>Most-read pages by crawlers</h2><p class="sub">The pages AI assistants and search engines fetch most.</p>' +
        (d.botPages.length ? table([
          { label: 'Page', html: function (r) { return '<span class="mono">' + esc((r.host !== 'main' ? r.host + ' ' : '') + r.path) + '</span><div class="muted">' + esc(r.bots || '') + '</div>'; } },
          { label: 'AI visits', key: 'ai_hits', num: true, fmt: n }, { label: 'All crawler visits', key: 'hits', num: true, fmt: n },
        ], d.botPages, { cards: true }) : '<p class="muted">None yet.</p>') + '</div>' +
        '<div class="card" style="margin-top:14px"><h2>Guides · ' + n(guides.length) + '</h2><p class="sub">Each article: reads, and the funnel for people who <strong>entered the site on it</strong> (landed → became a lead → applied → booked). Click a row to see where its visitors come from and what they searched.</p>' +
        table([
          { label: 'Guide', html: function (r) { return '<strong>' + esc(r.h1) + '</strong><div class="muted">' + esc(r.section) + ' · <a href="' + esc(r.url) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">open ↗</a></div>'; } },
          { label: 'Reads', key: 'views', num: true, fmt: n }, { label: 'People', key: 'visitors', num: true, fmt: n },
          { label: 'Entered here', num: true, nw: true, html: function (r) { return n(r.landed) + (r.landed ? '<div class="muted">' + n(r.fromSearch) + ' search · ' + n(r.fromAi) + ' AI</div>' : ''); } },
          { label: 'Came from', html: function (r) { return (r.sources || []).length ? r.sources.map(function (x) { return esc(x.source) + ' <span class="muted">' + n(x.sessions) + '</span>'; }).join('<br>') : '<span class="muted">–</span>'; } },
          { label: 'Clicked CTA', key: 'ctas', num: true, fmt: n },
          { label: 'Leads', num: true, nw: true, html: function (r) { return n(r.leads) + (r.booked ? ' <span class="muted">(' + n(r.booked) + ' booked)</span>' : ''); } },
        ], guides, { cards: true, rowAttr: function (r) { return 'class="click" data-article="' + esc(r.slug) + '" tabindex="0" title="See where this article’s visitors come from"'; } }) + '</div>' +
        (d.landings.length ? '<div class="card" style="margin-top:14px"><h2>Landing pages for AI & search visitors</h2>' + table([
          { label: 'Page', html: function (r) { return '<span class="mono">' + esc(r.landing_path || '/') + '</span>'; } },
          { label: 'From AI', key: 'ai', num: true, fmt: n }, { label: 'From search', key: 'organic', num: true, fmt: n },
        ], d.landings, { cards: true }) + '</div>' : '');
      view.querySelectorAll('[data-article]').forEach(function (row) {
        row.onclick = function () { openArticle(row.getAttribute('data-article')); };
        row.onkeydown = function (e) { if (e.key === 'Enter') openArticle(row.getAttribute('data-article')); };
      });
      var days = d.botDays || [];
      var el = view.querySelector('[data-sc-ai]');
      if (days.length) lineChart(el, days.map(function (x) { return { label: x.day, short: x.day.slice(5), value: x.ai }; }), { label: 'AI crawler visits per day', height: 200 });
      else el.innerHTML = '<p class="muted">No crawler visits yet.</p>';
      var b = view.querySelector('[data-indexnow]');
      b.onclick = function () {
        b.disabled = true; b.textContent = 'Sending…';
        fetch('/admin/api/search/indexnow', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' })
          .then(function (r) { return r.json(); })
          .then(function (j) { toast(j.ok ? 'Sent to IndexNow' : (j.error || 'IndexNow didn’t accept it; try again later')); load(); }, function () { toast('Couldn’t reach IndexNow'); b.disabled = false; b.textContent = 'Send all pages to IndexNow'; });
      };
    });
  }

  function renderContent() {
    return api('content', {}, { noRange: true }).then(function (d) { ctState.d = d; drawContent(); });
  }
  function compact(v) { v = Number(v) || 0; return v >= 1e6 ? (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : v >= 1e4 ? Math.round(v / 1e3) + 'k' : v >= 1e3 ? (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'k' : String(Math.round(v)); }
  function drawContent() {
    var d = ctState.d, P = ctState.platform;
    var items = d.items.filter(function (i) { return i.platform === P; });
    var withViews = items.filter(function (i) { return i.views != null; });
    var ins = d.insights[P];
    var ch = d.channel, ig = d.instagram, conn = d.connected;
    var sync = d.lastSync && d.lastSync.results ? d.lastSync.results.filter(function (r) { return r.platform === P; })[0] : null;
    var notice = P === 'youtube'
      ? (conn.youtubeKey ? '' : '<div class="card notice"><strong>Showing the latest 15 videos</strong> (YouTube’s public feed: views and likes only). Add a free YouTube Data API key in <a href="#integrations" data-go="integrations">Integrations → Content</a> for the whole channel, video length, comments and subscribers.</div>')
      : (conn.instagram ? '' : '<div class="card notice"><strong>Instagram isn’t connected.</strong> Instagram only shares numbers through its official API: switch @officialjoshli to a Business or Creator account, link it to a Facebook page, then add the account ID and an access token in <a href="#integrations" data-go="integrations">Integrations → Content</a>.</div>');
    var maxV = Math.max.apply(null, withViews.map(function (i) { return i.views; }).concat([1]));
    var top = withViews.slice().sort(function (a, b) { return b.views - a.views; }).slice(0, 12);
    var topBars = top.map(function (i, k) {
      var w = Math.max(1.5, (i.views / maxV) * 100);
      return '<li title="' + esc(i.title + ' · ' + n(i.views) + ' views' + (i.likes != null ? ' · ' + n(i.likes) + ' likes' : '')) + '"><a href="' + esc(i.url) + '" target="_blank" rel="noopener" class="ct-thumb">' + (i.thumbnail ? '<img src="' + esc(i.thumbnail) + '" alt="" loading="lazy">' : '') + '</a>' +
        '<div class="ct-barrow"><div class="ct-title">' + (k === 0 ? '<span class="pill st-booked">most viewed</span> ' : '') + esc(i.title) + '</div><div class="ct-bar"><i style="width:' + w.toFixed(1) + '%"></i><b>' + esc(compact(i.views)) + '</b>' + (ins && ins.median ? '<span class="muted">' + (i.views / ins.median).toFixed(1) + '× median</span>' : '') + '</div></div></li>';
    }).join('');
    // Views by upload date (oldest → newest), median line, top 3 labelled.
    var chrono = withViews.filter(function (i) { return i.published_at; }).sort(function (a, b) { return a.published_at - b.published_at; });
    var svg = '';
    if (chrono.length) {
      var W = 900, H = 220, pad = 34, bw = Math.max(4, Math.min(28, (W - pad - 10) / chrono.length - 4)), gap = (W - pad - 10 - bw * chrono.length) / Math.max(1, chrono.length);
      var y = function (v) { return H - 24 - (v / maxV) * (H - 44); };
      var topIds = top.slice(0, 3).map(function (i) { return i.id; });
      var bars = chrono.map(function (i, k) {
        var x = pad + k * (bw + gap) + gap / 2, h = Math.max(2, H - 24 - y(i.views));
        var label = topIds.indexOf(i.id) >= 0 ? '<text x="' + (x + bw / 2) + '" y="' + (y(i.views) - 6) + '" text-anchor="middle" class="ct-lbl">' + esc(compact(i.views)) + '</text>' : '';
        return '<g class="ct-col"><rect x="' + x.toFixed(1) + '" y="' + (H - 24 - h).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="3"><title>' + esc(new Date(i.published_at).toLocaleDateString() + ' · ' + i.title + ' · ' + n(i.views) + ' views') + '</title></rect>' + label + '</g>';
      }).join('');
      var med = ins && ins.median ? '<line x1="' + pad + '" x2="' + (W - 6) + '" y1="' + y(ins.median) + '" y2="' + y(ins.median) + '" class="ct-med"/><text x="' + (W - 6) + '" y="' + (y(ins.median) - 5) + '" text-anchor="end" class="ct-axis">median ' + esc(compact(ins.median)) + '</text>' : '';
      var first = new Date(chrono[0].published_at), last = new Date(chrono[chrono.length - 1].published_at);
      svg = '<svg class="ct-chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Views per video by upload date"><line x1="' + pad + '" x2="' + (W - 6) + '" y1="' + (H - 24) + '" y2="' + (H - 24) + '" class="ct-base"/>' + bars + med +
        '<text x="' + pad + '" y="' + (H - 6) + '" class="ct-axis">' + esc(first.toLocaleDateString([], { month: 'short', year: 'numeric' })) + '</text><text x="' + (W - 6) + '" y="' + (H - 6) + '" text-anchor="end" class="ct-axis">' + esc(last.toLocaleDateString([], { month: 'short', year: 'numeric' })) + '</text>' +
        '<text x="' + (pad - 6) + '" y="' + (y(maxV) + 4) + '" text-anchor="end" class="ct-axis">' + esc(compact(maxV)) + '</text><text x="' + (pad - 6) + '" y="' + (H - 24) + '" text-anchor="end" class="ct-axis">0</text></svg>';
    }
    var sg = d.suggestions;
    var sorters = { views: function (a, b) { return (b.views || 0) - (a.views || 0); }, recent: function (a, b) { return (b.published_at || 0) - (a.published_at || 0); }, perDay: function (a, b) { return (b.perDay || 0) - (a.perDay || 0); }, leads: function (a, b) { return ((b.funnel && b.funnel.leads) || 0) - ((a.funnel && a.funnel.leads) || 0); } };
    var list = items.slice().sort(sorters[ctState.sort]);
    view.innerHTML =
      '<div class="card ct-bar-top"><div class="row"><button class="btn-sm' + (P === 'youtube' ? '' : ' ghost') + '" data-ctp="youtube">YouTube' + (ch && ch.title ? ' · ' + esc(ch.title) : '') + '</button><button class="btn-sm' + (P === 'instagram' ? '' : ' ghost') + '" data-ctp="instagram">Instagram' + (ig && ig.username ? ' · @' + esc(ig.username) : '') + '</button>' +
      '<span class="muted" style="margin-left:auto">' + (d.lastSync ? 'Updated ' + esc(when(d.lastSync.at)) : 'Not loaded yet') + (sync && sync.error ? ' · <span class="bad">' + esc(sync.error) + '</span>' : '') + '</span><button class="btn-sm" data-ctsync>Refresh</button></div></div>' +
      notice +
      (withViews.length ? '<div class="grid g-4">' +
        (P === 'youtube' ? tile('Subscribers', ch && ch.subscribers != null ? compact(ch.subscribers) : '–', ch && ch.videos ? n(ch.videos) + ' videos on the channel' : 'needs the API key') : tile('Followers', ig && ig.followers != null ? compact(ig.followers) : '–', ig && ig.posts ? n(ig.posts) + ' posts' : '')) +
        tile('Views (' + n(withViews.length) + ' ' + (P === 'youtube' ? 'videos' : 'posts') + ')', compact(ins ? ins.totalViews : 0), 'median ' + compact(ins ? ins.median : 0) + ' per ' + (P === 'youtube' ? 'video' : 'post')) +
        tile('Most viewed', ins && ins.best ? compact(ins.best.views) + ' views' : '–', ins && ins.best ? (ins.best.x ? ins.best.x.toFixed(1) + '× the median · ' : '') + ins.best.title : '') +
        tile('Like rate', ins ? (ins.likeRate * 100).toFixed(1) + '%' : '–', 'likes per view (median)') + '</div>' : '') +
      (withViews.length ? '<div class="grid g-2 g-top"><div class="card"><h2>Most viewed</h2><p class="sub">Top ' + top.length + ' by views. Hover for details, click a thumbnail to open it.</p><ol class="ct-top">' + topBars + '</ol></div>' +
        '<div class="card"><h2>Views by upload date</h2><p class="sub">Each bar is one ' + (P === 'youtube' ? 'video' : 'post') + ', oldest on the left. The line is the median; the top 3 are labelled.</p>' + svg +
        (ins ? '<h3 class="h3" style="margin-top:12px">What the numbers say</h3><ul class="ct-ins">' +
          (ins.best ? '<li><b>' + esc(ins.best.title) + '</b> is the standout: ' + esc(compact(ins.best.views)) + ' views' + (ins.best.x ? ', ' + ins.best.x.toFixed(1) + '× a typical video' : '') + '.</li>' : '') +
          (ins.outliers.length > 1 ? '<li>' + n(ins.outliers.length) + ' ' + (P === 'youtube' ? 'videos' : 'posts') + ' did at least 2× the median.</li>' : '') +
          (ins.winningWords.length ? '<li>Words in the winners that the weak ones don’t use: <b>' + esc(ins.winningWords.join(', ')) + '</b>.</li>' : '') +
          (ins.bestDow ? '<li>Best publish day so far: <b>' + esc(ins.bestDow) + '</b>.</li>' : '') +
          (ins.longVsShort ? '<li>Median views: under 10 min <b>' + esc(compact(ins.longVsShort.under10)) + '</b> · 10 min+ <b>' + esc(compact(ins.longVsShort.over10)) + '</b>.</li>' : '') + '</ul>' : '') + '</div></div>' : (items.length ? '' : '<div class="card">' + emptyState('No ' + (P === 'youtube' ? 'videos' : 'posts') + ' loaded yet.', P === 'youtube' ? 'Press Refresh to pull the channel.' : 'Connect Instagram first.') + '</div>')) +
      '<div class="card ct-ideas"><div class="card-head"><div><h2>Next video ideas</h2><p class="sub">' + (conn.ai ? 'Written by Claude from the real numbers above (and which videos brought leads).' : 'From the numbers above. Add an Anthropic key in Integrations for full AI-written ideas with hooks.') + (sg ? ' Last generated ' + esc(when(sg.at)) + '.' : '') + '</p></div><button class="btn-sm" data-ctsuggest>' + (sg ? 'Generate new ideas' : 'Suggest my next videos') + '</button></div>' +
        (sg ? (sg.patterns.length ? '<ul class="ct-ins">' + sg.patterns.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '') +
          '<div class="ct-idea-grid">' + sg.ideas.map(function (x, k) { return '<article class="ct-idea"><span class="ct-n">' + (k + 1) + '</span><h3>' + esc(x.title) + '</h3><p><b>Hook:</b> ' + esc(x.hook) + '</p><p class="muted"><b>Format:</b> ' + esc(x.format) + '</p><p class="muted"><b>Why:</b> ' + esc(x.why) + '</p><p class="muted"><b>Ends with:</b> ' + esc(x.cta) + '</p></article>'; }).join('') + '</div>'
          : '<p class="muted" data-ctmsg>Press the button to get ideas.</p>') + '<p class="muted" data-ctmsg2></p></div>' +
      (items.length ? '<div class="card"><div class="card-head"><div><h2>All ' + (P === 'youtube' ? 'videos' : 'posts') + ' · ' + n(items.length) + '</h2><p class="sub">Leads, calls and revenue come from tracked links (<a href="#links" data-go="links">Links &amp; videos</a>). A video without one shows “add a link”.</p></div>' +
        '<label class="muted">Sort <select class="input" data-ctsort>' + [['views', 'Most views'], ['perDay', 'Views per day'], ['recent', 'Newest'], ['leads', 'Most leads']].map(function (o) { return '<option value="' + o[0] + '"' + (ctState.sort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label></div>' +
        table([
          { label: '', html: function (i) { return i.thumbnail ? '<a href="' + esc(i.url) + '" target="_blank" rel="noopener"><img class="ct-mini" src="' + esc(i.thumbnail) + '" alt="" loading="lazy"></a>' : ''; } },
          { label: 'Title', html: function (i) { return '<a href="' + esc(i.url) + '" target="_blank" rel="noopener">' + esc(i.title) + '</a><div class="muted">' + esc((i.published_at ? new Date(i.published_at).toLocaleDateString() : '') + ' · ' + i.kind + (i.duration_s ? ' · ' + Math.round(i.duration_s / 60) + ' min' : '')) + '</div>'; } },
          { label: 'Views', num: true, html: function (i) { return esc(i.views == null ? '–' : n(i.views)); } },
          { label: 'Per day', num: true, html: function (i) { return esc(i.perDay == null ? '–' : i.perDay < 10 ? i.perDay.toFixed(1) : n(Math.round(i.perDay))); } },
          { label: 'Likes', num: true, html: function (i) { return esc(i.likes == null ? '–' : n(i.likes)); } },
          { label: 'Comments', num: true, html: function (i) { return esc(i.comments == null ? '–' : n(i.comments)); } },
          { label: 'Engagement', num: true, html: function (i) { return esc(i.engagement == null ? '–' : (i.engagement * 100).toFixed(1) + '%'); } },
          { label: 'Leads → booked → won', html: function (i) { return i.platform !== 'youtube' ? '<span class="muted">–</span>' : i.funnel ? esc(n(i.funnel.leads) + ' → ' + n(i.funnel.booked) + ' → ' + n(i.funnel.won)) + (i.funnel.revenue ? '<div class="muted">' + esc(money(i.funnel.revenue)) + '</div>' : '') : '<a class="muted" href="#links" data-go="links">add a link</a>'; } },
        ], list) + '</div>' : '');
    view.querySelectorAll('[data-ctp]').forEach(function (b) { b.onclick = function () { ctState.platform = b.getAttribute('data-ctp'); drawContent(); }; });
    var srt = view.querySelector('[data-ctsort]'); if (srt) srt.onchange = function () { ctState.sort = srt.value; drawContent(); };
    view.querySelector('[data-ctsync]').onclick = function () { var b = this; b.disabled = true; b.textContent = 'Refreshing…'; send('POST', 'content/sync', {}).then(function () { renderContent(); }); };
    view.querySelector('[data-ctsuggest]').onclick = function () {
      var b = this, m = view.querySelector('[data-ctmsg2]'); b.disabled = true; b.textContent = 'Thinking…'; if (m) m.textContent = conn.ai ? 'Claude is reading the numbers (up to a minute)…' : '';
      send('POST', 'content/suggest', {}).then(function (r) { if (r && r.ok) renderContent(); else { b.disabled = false; b.textContent = 'Try again'; if (m) m.textContent = (r && r.error) || 'Couldn’t generate ideas'; } });
    };
  }

  // ───────────── Email editor ─────────────
  var edState = { sel: null, q: '', open: {} };
  var SEQ_LABEL = { abandoned: 'Unfinished application', tier_a: 'Qualified (A)', tier_b: 'Qualified (B)', tier_c: 'Not yet a fit (C)', booked: 'Booked: confirmation & reminders', precall: 'Pre-call flow', behaviour: 'Behaviour-triggered', no_show: 'No-show', post_call: 'After the call', cancelled: 'Cancelled', lost: 'Lost', won: 'Won: onboarding', nurture: 'Nurture', webinar: 'Webinar', reactivation: 'Reactivation', other: 'Other one-off emails' };
  function renderEditor() {
    return api('email-editor', {}, { noRange: true }).then(function (d) {
      edState.d = d;
      if (!edState.sel) edState.sel = (d.groups[0] && d.groups[0].emails[0] && d.groups[0].emails[0].template) || null;
      view.innerHTML = '<div class="ed-grid"><aside class="card ed-list"><input class="input" data-edq placeholder="Search emails…" value="' + esc(edState.q) + '"><p class="muted ed-count">' + n(d.edited) + ' edited · ' + n(d.groups.reduce(function (t, g) { return t + g.emails.length; }, 0)) + ' emails</p><div data-edlist></div></aside><section class="card ed-main" data-edmain><p class="loading-note">Pick an email.</p></section></div>';
      drawEditorList();
      var q = view.querySelector('[data-edq]');
      q.oninput = function () { edState.q = q.value; drawEditorList(); };
      if (edState.sel) openEditorEmail(edState.sel);
    });
  }
  function drawEditorList() {
    var d = edState.d, q = edState.q.toLowerCase(), box = view.querySelector('[data-edlist]');
    box.innerHTML = d.groups.map(function (g) {
      var list = g.emails.filter(function (e) { return !q || (e.subject + ' ' + e.template).toLowerCase().indexOf(q) >= 0; });
      if (!list.length) return '';
      var open = q || edState.open[g.id] || list.some(function (e) { return e.template === edState.sel; });
      return '<details class="ed-group"' + (open ? ' open' : '') + ' data-edg="' + esc(g.id) + '"><summary><strong>' + esc(SEQ_LABEL[g.id] || g.id) + '</strong><span class="muted"> · ' + list.length + '</span></summary><ol>' +
        list.map(function (e) {
          return '<li class="ed-item' + (e.template === edState.sel ? ' on' : '') + '" data-edt="' + esc(e.template) + '" tabindex="0" role="button"><span class="ed-subj">' + esc(e.subject) + '</span><span class="ed-meta"><span class="mono">' + esc(e.template) + '</span>' +
            (e.edited ? '<span class="pill st-booked">edited</span>' : '') + (e.personal ? '<span class="pill">from their answers</span>' : '') + (e.sent ? '<span>' + n(e.sent) + ' sent' + (e.sent ? ' · ' + pct(e.opened / e.sent) + ' opened' : '') + '</span>' : '') + '</span></li>';
        }).join('') + '</ol></details>';
    }).join('') || emptyState('No emails match.');
    box.querySelectorAll('[data-edg]').forEach(function (el) { el.ontoggle = function () { edState.open[el.getAttribute('data-edg')] = el.open; }; });
    box.querySelectorAll('[data-edt]').forEach(function (el) {
      var go_ = function () { if (edState.dirty && !confirm('Discard your unsaved changes?')) return; edState.sel = el.getAttribute('data-edt'); drawEditorList(); openEditorEmail(edState.sel); };
      el.onclick = go_; el.onkeydown = function (e) { if (e.key === 'Enter') go_(); };
    });
  }
  function openEditorEmail(t) {
    var main = view.querySelector('[data-edmain]');
    edState.dirty = false;
    main.innerHTML = '<p class="loading-note">Loading…</p>';
    fetch('/admin/api/email-editor/' + encodeURIComponent(t), { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (e) {
      if (e.error) { main.innerHTML = emptyState(e.error); return; }
      var v = e.override || e.default || {};
      var field = function (k, label, rows, hint) {
        return '<label class="ed-field"><span>' + esc(label) + (hint ? ' <span class="muted">' + esc(hint) + '</span>' : '') + '</span>' + (rows ? '<textarea class="input" data-edf="' + k + '" rows="' + rows + '">' + esc(v[k] || '') + '</textarea>' : '<input class="input" data-edf="' + k + '" value="' + esc(v[k] || '') + '">') + '</label>';
      };
      var tags = Object.keys(e.tags).map(function (k) { return '<button class="chip" type="button" data-edtag="' + esc(k) + '" title="' + esc(e.tags[k]) + '">{' + esc(k) + '}</button>'; }).join('');
      main.innerHTML =
        '<div class="ed-head"><div><h2>' + esc(v.subject || t) + '</h2><p class="muted mono">' + esc(t) + (e.override ? ' · edited ' + esc(when(e.override.updated_at)) : ' · built-in wording') + '</p></div>' +
        (e.editable ? '<div class="row"><button class="btn-sm ghost" data-edrevert disabled>Undo changes</button>' + (e.override ? '<button class="btn-sm ghost danger" data-edreset>Reset to default</button>' : '') + '<button class="btn-sm" data-edsave disabled>Saved</button></div>' : '') + '</div>' +
        (e.editable ? '' : '<div class="card notice">This email is written from each person’s own application answers, so every copy is different. It can’t be edited here; the preview shows how it reads for a recent applicant.</div>') +
        '<div class="ed-split">' +
        (e.editable ? '<div class="ed-form">' + field('subject', 'Subject') + field('preheader', 'Preview line', 0, '(shown next to the subject in the inbox)') +
          field('body', 'Email', 14, '— blank line = new paragraph · **bold** · [link text](/breakout)') +
          '<div class="ed-two">' + field('cta_label', 'Button text', 0, '(leave empty for no button)') + field('cta_href', 'Button link', 0, '{booking_link}, /breakout, https://…') + '</div>' +
          field('ps', 'P.S.', 3) +
          '<div class="ed-tags"><span class="muted">Insert into the field you’re in:</span>' + tags + '</div><p class="muted ed-err" data-ederr></p></div>' : '') +
        '<div class="ed-prev"><div class="row"><strong>Preview</strong><span class="muted">for a recent applicant</span></div><iframe class="email-preview" sandbox title="Email preview" data-edframe></iframe></div></div>';
      var frame = main.querySelector('[data-edframe]');
      var lastFocus = null, timer = null;
      var collect = function () { var o = {}; main.querySelectorAll('[data-edf]').forEach(function (f) { o[f.getAttribute('data-edf')] = f.value; }); return o; };
      var preview = function () {
        var body = e.editable ? { fields: collect() } : {};
        fetch('/admin/api/email-editor/' + encodeURIComponent(t) + '/preview', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
          .then(function (r) { return r.json(); }).then(function (p) {
            var err = main.querySelector('[data-ederr]');
            if (p.error) { if (err) err.textContent = p.error; return; }
            if (err) err.textContent = '';
            frame.srcdoc = p.html;
          });
      };
      preview();
      if (!e.editable) return;
      var save = main.querySelector('[data-edsave]'), revert = main.querySelector('[data-edrevert]');
      var dirty = function () { edState.dirty = true; save.disabled = false; save.textContent = 'Save'; revert.disabled = false; clearTimeout(timer); timer = setTimeout(preview, 450); };
      main.querySelectorAll('[data-edf]').forEach(function (f) { f.addEventListener('input', dirty); f.addEventListener('focus', function () { lastFocus = f; }); });
      main.querySelectorAll('[data-edtag]').forEach(function (b) {
        b.onmousedown = function (ev) { ev.preventDefault(); };
        b.onclick = function () {
          var f = lastFocus || main.querySelector('[data-edf="body"]'), tag = '{' + b.getAttribute('data-edtag') + '}';
          var a = f.selectionStart != null ? f.selectionStart : f.value.length, z = f.selectionEnd != null ? f.selectionEnd : a;
          f.value = f.value.slice(0, a) + tag + f.value.slice(z); f.focus(); f.selectionStart = f.selectionEnd = a + tag.length; dirty();
        };
      });
      revert.onclick = function () { edState.dirty = false; openEditorEmail(t); };
      save.onclick = function () {
        save.disabled = true; save.textContent = 'Saving…';
        send('PUT', 'email-editor/' + encodeURIComponent(t), collect()).then(function (r) {
          if (r && r.ok) { edState.dirty = false; toast('Saved. Every future send uses the new wording.'); renderEditor(); }
          else { save.disabled = false; save.textContent = 'Save'; main.querySelector('[data-ederr]').textContent = (r && r.error) || 'Couldn’t save'; }
        });
      };
      var reset = main.querySelector('[data-edreset]');
      if (reset) reset.onclick = function () { if (!confirm('Go back to the built-in wording for this email?')) return; send('DELETE', 'email-editor/' + encodeURIComponent(t)).then(function () { edState.dirty = false; toast('Back to the default'); renderEditor(); }); };
    });
  }

  // ───────────── Reactivation ─────────────
  var reState = null;
  function renderReactivation() {
    return api('reactivation', {}, { noRange: true }).then(function (d) {
      var prev = reState;
      reState = { d: d, segs: prev ? prev.segs : Object.keys(d.segments).filter(function (k) { return d.counts[k] > 0; }), off: prev ? prev.off : {}, q: '',
        f: prev ? prev.f : { tiers: { A: true, B: true, C: true, none: true }, data: 'any', revenue: '', industry: '', source: 'any', age: 'any' } };
      drawReactivation();
    });
  }
  /** One person's reactivation, as they'd get it: which emails send, which skip, each rendered with their answers. */
  function previewPerson(id, seg) {
    closeDrawers();
    var row = (reState && reState.d.audience.filter(function (r) { return r.id === id; })[0]) || {};
    var bg = document.createElement('div'); bg.className = 'drawer-bg';
    var dr = document.createElement('aside'); dr.className = 'drawer'; dr.setAttribute('role', 'dialog'); dr.setAttribute('aria-label', 'Reactivation preview');
    dr.innerHTML = '<div class="loading-note">Writing their emails…</div>';
    document.body.appendChild(bg); document.body.appendChild(dr);
    function teardown() { document.removeEventListener('keydown', onKey); }
    function close() { bg.remove(); dr.remove(); teardown(); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    dr.__teardown = teardown; bg.onclick = close; document.addEventListener('keydown', onKey);
    var q = 'lead=' + encodeURIComponent(id) + '&segment=' + encodeURIComponent(seg || '');
    fetch('/admin/api/reactivation/person?' + q, { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) { dr.innerHTML = '<div class="empty">' + esc(d.error) + '</div>'; return; }
      var name = [row.first_name, row.last_name].filter(Boolean).join(' ') || row.email || 'This person';
      dr.innerHTML = '<div class="drawer-head"><div class="row" style="flex:1;min-width:0"><h2 class="lead-name">' + esc(name) + '</h2>' + (row.tier ? '<span class="tier ' + esc(row.tier) + '">' + esc(row.tier) + '</span>' : '') + '</div><button class="close" type="button" aria-label="Close">Close ✕</button></div>' +
        '<p class="muted" style="margin:4px 0 12px">' + n(d.sends) + ' of ' + n(d.emails.length) + ' emails will send; the rest skip because they’re written around an answer this person never gave. Click one to read it exactly as they’ll get it.</p>' +
        '<ol class="re-track re-person">' + d.emails.map(function (e) { return '<li' + (e.skipped ? ' class="skipped"' : ' data-rp="' + esc(e.template) + '" tabindex="0" role="button"') + '><span class="muted">Day ' + (e.day + 1) + '</span> <span class="pc-subj">' + esc(e.skipped ? e.template.replace(/^rx_/, '') + ' (skipped: no answer on file)' : e.subject) + '</span>' + (e.personal && !e.skipped ? ' <span class="pill st-won">personal</span>' : '') + '</li>'; }).join('') + '</ol>' +
        '<div class="pc-preview" data-rpout hidden></div>';
      dr.querySelector('.close').onclick = close;
      dr.querySelectorAll('[data-rp]').forEach(function (li) {
        var go_ = function () {
          var out = dr.querySelector('[data-rpout]'); out.hidden = false; out.innerHTML = '<p class="loading-note">Loading…</p>';
          fetch('/admin/api/reactivation/person?' + q + '&template=' + encodeURIComponent(li.getAttribute('data-rp')), { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (e) {
            if (e.error) { out.innerHTML = '<p class="muted">' + esc(e.error) + '</p>'; return; }
            out.innerHTML = '<div class="row pc-prev-head"><strong>' + esc(e.subject) + '</strong></div><iframe class="email-preview" sandbox title="Email preview"></iframe>';
            out.querySelector('iframe').srcdoc = e.html;
            out.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          });
        };
        li.onclick = go_; li.onkeydown = function (ev) { if (ev.key === 'Enter') go_(); };
      });
    });
  }
  function emailPreview(box, template) {
    var out = box.querySelector('[data-pcout]');
    out.hidden = false; out.innerHTML = '<p class="loading-note">Loading the email…</p>';
    fetch('/admin/api/precall-flow/email?template=' + encodeURIComponent(template), { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (e) {
      if (e.error) { out.innerHTML = '<p class="muted">' + esc(e.error) + '</p>'; return; }
      out.innerHTML = '<div class="row pc-prev-head"><strong>' + esc(e.subject) + '</strong><span class="muted mono">' + esc(template) + '</span><button class="btn-sm ghost" data-pcclose>Close</button></div><iframe class="email-preview" sandbox title="Email preview"></iframe>';
      out.querySelector('iframe').srcdoc = e.html;
      out.querySelector('[data-pcclose]').onclick = function () { out.hidden = true; };
      out.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }
  function drawReactivation() {
    var S = reState, d = S.d, segs = d.segments;
    var F = S.f, DAY = 86400000, nowMs = Date.now();
    var inSegs = d.audience.filter(function (r) { return S.segs.indexOf(r.segment) >= 0; });
    var tierOf = function (r) { return r.tier === 'A' || r.tier === 'B' || r.tier === 'C' ? r.tier : 'none'; };
    var passAge = function (r) { var age = nowMs - r.created_at; return F.age === 'any' || (F.age === 'recent' && age < 90 * DAY) || (F.age === 'mid' && age >= 90 * DAY && age < 365 * DAY) || (F.age === 'old' && age >= 365 * DAY); };
    var rows = inSegs.filter(function (r) {
      return F.tiers[tierOf(r)] && (F.data === 'any' || r.data === F.data || (F.data === 'some+' && r.data !== 'none')) &&
        (!F.revenue || r.revenue_key === F.revenue) && (!F.industry || r.industry_id === F.industry) &&
        (F.source === 'any' || (F.source === 'calendly') === (r.booking_source === 'calendly-direct')) && passAge(r);
    });
    var tierCount = function (t) { return inSegs.filter(function (r) { return tierOf(r) === t; }).length; };
    var opts = function (key, labelKey) { var m = {}; inSegs.forEach(function (r) { if (r[key]) m[r[key]] = r[labelKey]; }); return Object.keys(m).sort(function (a, b) { return String(m[a]).localeCompare(String(m[b])); }).map(function (k) { return [k, m[k]]; }); };
    var dataPill = function (r) { return r.data === 'full' ? '<span class="pill st-won" title="' + r.facts + ' answers on file">full application</span>' : r.data === 'some' ? '<span class="pill" title="' + r.facts + ' answers on file">some answers</span>' : '<span class="pill muted">no answers</span>'; };
    var q = S.q.toLowerCase();
    var shown = q ? rows.filter(function (r) { return ((r.first_name || '') + ' ' + (r.last_name || '') + ' ' + r.email).toLowerCase().indexOf(q) >= 0; }) : rows;
    var chosen = rows.filter(function (r) { return !S.off[r.id]; });
    var t = d.report.totals;
    view.innerHTML =
      (d.emailLive ? '' : '<div class="card notice"><strong>Emails are simulated right now.</strong> Launching queues the campaign and logs every email, but nothing reaches anyone until you connect Resend in <a href="#integrations" data-go="integrations">Integrations → Email</a>.</div>') +
      (t.reactivated ? '<div class="grid g-4">' + tile('Reactivated', n(t.reactivated), 'people in the campaign') + tile('Booked again', n(t.rebooked), pct(t.reactivated ? t.rebooked / t.reactivated : null) + ' of them') + tile('Applied again', n(t.reapplied), '') + tile('Unsubscribed', n(t.unsubscribed), pct(t.reactivated ? t.unsubscribed / t.reactivated : null)) + '</div>' : '') +
      '<div class="card"><h2>1 · Who to bring back</h2><p class="sub">Each person is in one group only (the first that fits). Clients, unsubscribes and anyone reactivated in the last 90 days are never included.</p><div class="re-segs">' +
      Object.keys(segs).map(function (k) {
        var on = S.segs.indexOf(k) >= 0;
        return '<label class="re-seg' + (on ? ' on' : '') + (d.counts[k] ? '' : ' empty') + '"><input type="checkbox" data-seg="' + esc(k) + '"' + (on ? ' checked' : '') + (d.counts[k] ? '' : ' disabled') + '><span class="re-n">' + n(d.counts[k] || 0) + '</span><strong>' + esc(segs[k].label) + '</strong><span class="muted">' + esc(segs[k].hint) + '</span></label>';
      }).join('') + '</div></div>' +
      '<div class="card"><h2>2 · Filter</h2><p class="sub">Narrow it down. Tiers come from their application score (or Calendly qualification for imported calls).</p>' +
      '<div class="re-filters"><div><span class="re-flabel">Tier</span><div class="row" style="gap:6px;flex-wrap:wrap">' + [['A', 'A-tier'], ['B', 'B-tier'], ['C', 'C-tier'], ['none', 'Unscored']].map(function (t) { return '<label class="re-chip' + (F.tiers[t[0]] ? ' on' : '') + '"><input type="checkbox" data-retier="' + t[0] + '"' + (F.tiers[t[0]] ? ' checked' : '') + '> ' + esc(t[1]) + ' <span class="muted">' + n(tierCount(t[0])) + '</span></label>'; }).join('') + '</div></div>' +
      '<div><span class="re-flabel">What we know</span><select class="input" data-ref="data"><option value="any">Anyone</option><option value="full"' + (F.data === 'full' ? ' selected' : '') + '>Full application (most personal emails)</option><option value="some+"' + (F.data === 'some+' ? ' selected' : '') + '>At least some answers</option><option value="none"' + (F.data === 'none' ? ' selected' : '') + '>No answers on file</option></select></div>' +
      '<div><span class="re-flabel">Revenue</span><select class="input" data-ref="revenue"><option value="">Any</option>' + opts('revenue_key', 'revenue').map(function (o) { return '<option value="' + esc(o[0]) + '"' + (F.revenue === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select></div>' +
      '<div><span class="re-flabel">Industry</span><select class="input" data-ref="industry"><option value="">Any</option>' + opts('industry_id', 'industry').map(function (o) { return '<option value="' + esc(o[0]) + '"' + (F.industry === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select></div>' +
      '<div><span class="re-flabel">Came in via</span><select class="input" data-ref="source"><option value="any">Anywhere</option><option value="funnel"' + (F.source === 'funnel' ? ' selected' : '') + '>The funnel</option><option value="calendly"' + (F.source === 'calendly' ? ' selected' : '') + '>Calendly (imported)</option></select></div>' +
      '<div><span class="re-flabel">Came in</span><select class="input" data-ref="age"><option value="any">Any time</option><option value="recent"' + (F.age === 'recent' ? ' selected' : '') + '>Last 3 months</option><option value="mid"' + (F.age === 'mid' ? ' selected' : '') + '>3–12 months ago</option><option value="old"' + (F.age === 'old' ? ' selected' : '') + '>Over a year ago</option></select></div>' +
      '</div><p class="muted" style="margin-top:8px">' + n(rows.length) + ' of ' + n(inSegs.length) + ' people match.</p></div>' +
      '<div class="card"><div class="card-head"><div><h2>3 · Review the list · ' + n(chosen.length) + ' of ' + n(rows.length) + ' selected</h2><p class="sub">Untick anyone who shouldn’t get it, e.g. people who already became clients (logging their outcome in Calls &amp; deals also removes them).</p></div>' +
      '<div class="row"><input class="input" data-req placeholder="Search name or email" value="' + esc(S.q) + '" style="max-width:220px"><button class="btn-sm ghost" data-reall="1">Tick all</button><button class="btn-sm ghost" data-reall="0">Untick all</button></div></div>' +
      '<div class="re-list">' + (shown.length ? '<table class="t"><thead><tr><th></th><th>Person</th><th>Tier</th><th>What they told us</th><th>Group</th><th>Came in</th><th></th></tr></thead><tbody>' + shown.slice(0, 400).map(function (r) {
        var told = [r.industry, r.revenue].filter(Boolean).join(' · ');
        return '<tr class="click" data-reopen="' + esc(r.id) + '"><td><input type="checkbox" data-reid="' + esc(r.id) + '"' + (S.off[r.id] ? '' : ' checked') + '></td><td><strong>' + esc([r.first_name, r.last_name].filter(Boolean).join(' ') || '–') + '</strong><div class="muted">' + esc(r.email) + '</div></td>' +
          '<td>' + (r.tier ? '<span class="tier ' + esc(r.tier) + '">' + esc(r.tier) + '</span>' : '<span class="muted">–</span>') + '</td>' +
          '<td>' + (told ? esc(told) : '<span class="muted">–</span>') + (r.business ? '<div class="muted re-biz" title="' + esc(r.business) + '">' + esc(r.business) + '</div>' : '') + '<div style="margin-top:3px">' + dataPill(r) + (r.why_now ? ' <span class="pill" title="Wrote why now in their own words">why now</span>' : '') + (r.objection ? ' <span class="pill" title="Objection / reason logged">' + esc(r.objection) + '</span>' : '') + '</div></td>' +
          '<td>' + esc(segs[r.segment].label) + '<div class="muted">' + statusPill(r.status) + '</div></td>' +
          '<td>' + esc(when(r.created_at)) + '<div class="muted">' + esc(r.booking_source === 'calendly-direct' ? 'Calendly import' : 'Funnel') + '</div></td>' +
          '<td><button class="btn-sm ghost" data-reprev="' + esc(r.id) + '" data-reseg="' + esc(r.segment) + '">Preview their emails</button></td></tr>';
      }).join('') + '</tbody></table>' + (shown.length > 400 ? '<p class="muted">Showing the first 400; search to find others.</p>' : '') : emptyState('Nobody in the chosen groups.')) + '</div></div>' +
      '<div class="card re-mails"><h2>4 · The ' + d.emails.length + ' emails</h2><p class="sub">30 days, 3 to 5 every day between 8am and 7pm, each a different angle: days 1–4 are written from their own answers, days 5–14 explain how a deal actually works, days 15–24 are about the opportunity and their life as an owner, and days 25–31 handle the objections and close out. The ones marked <span class="pill st-won">personal</span> are written from each person’s own application: what they do, their size, their goal and timeline, what was in the way and why now in their own words, plus why they’re back (no-show, cancelled, lost…). If someone never gave that answer, that email skips itself. In between: the deal structures (70/20/10, 60/40, 100% vendor finance), the objections and a straight ask to book. Use “Preview their emails” on any person to read exactly what they’ll get.</p><div class="re-days">' +
      (function () { var by = {}, days = []; d.emails.forEach(function (e) { if (!by[e.day]) { by[e.day] = []; days.push(e.day); } by[e.day].push(e); }); return days.map(function (dd) { return '<section><h3>Day ' + (dd + 1) + '<span class="muted"> · ' + by[dd].length + '</span></h3><ol class="re-track">' + by[dd].map(function (e) { return '<li data-pcview="' + esc(e.template) + '" tabindex="0" role="button"><span class="pc-subj">' + esc(e.subject) + '</span>' + (/^rx_/.test(e.template) ? ' <span class="pill st-won">personal</span>' : '') + '</li>'; }).join('') + '</ol></section>'; }).join(''); })() +
      '</div><div class="pc-preview" data-pcout hidden></div></div>' +
      '<div class="card"><h2>5 · Launch</h2><p class="sub"><b>Each person gets the campaign for their tier:</b> A-tier (and anyone without a tier) gets the 30-day run below, then five more months of emails; B-tier gets the mid-fit campaign (book a call when it makes sense); C-tier gets the not-ready-yet campaign (the masterclass, and apply again when the numbers change). Every campaign runs six months, about 1,000 emails, and picks its teaching emails from what each person reads on the site. Starts at 8am (sales time zone) and adds this many new people a day, a couple of minutes apart. Each person then gets 3–5 emails a day for 30 days, on their own schedule. That’s a lot of email: start with a small batch (20–30), and watch the unsubscribe and complaint rates in the first week before sending to everyone. Replies come to your inbox and don’t stop the emails by themselves, so if someone replies “not interested”, press <b>Stop their emails</b> next to them under Campaign results. It stops for anyone who books or applies again, unsubscribes or becomes a client.</p>' +
      '<div class="row re-launch"><label>New people per day <input class="input" type="number" min="5" max="200" value="40" data-reper style="width:90px"></label><span class="muted" data-redays></span>' +
      '<label>Type <b>SEND</b> to confirm <input class="input" data-reconfirm style="width:110px" autocomplete="off"></label><button class="btn" data-relaunch' + (chosen.length ? '' : ' disabled') + '>Launch for ' + n(chosen.length) + ' people</button><span data-remsg class="muted"></span></div>' +
      (t.reactivated ? '<p style="margin-top:10px"><button class="btn-sm ghost danger" data-restop>Stop all pending reactivation emails</button></p>' : '') + '</div>' +
      (d.report.people.length ? '<div class="card"><h2>Campaign results</h2>' + (function (q) { if (!q) return ''; var fmt = function (ms) { return new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); }; return '<p class="sub"><b>' + n(q.sent) + '</b> sent' + (q.lastSentAt ? ' (latest ' + esc(fmt(q.lastSentAt)) + ')' : '') + ' · <b>' + n(q.pending) + '</b> queued' + (q.nextAt ? ' · next one goes out <b>' + esc(fmt(q.nextAt)) + '</b> (your time)' : '') + (q.lastAt && q.pending ? ' · last ' + esc(fmt(q.lastAt)) : '') + '. Emails start at 8am in the sales time zone, so a campaign launched in the evening begins the next morning.</p>'; })(d.report.queue) + table([
        { label: 'Email', key: 'template' }, { label: 'Sent', key: 'sent', num: true, fmt: n }, { label: 'Waiting', key: 'pending', num: true, fmt: n },
        { label: 'Opened', key: 'opened', num: true, fmt: n }, { label: 'Clicked', key: 'clicked', num: true, fmt: n }, { label: 'Skipped', key: 'skipped', num: true, fmt: n },
      ], d.report.steps) + '<h3 class="h3" style="margin-top:14px">People</h3>' + table([
        { label: 'Person', html: function (r) { return '<strong>' + esc([r.first_name, r.last_name].filter(Boolean).join(' ') || r.email) + '</strong><div class="muted">' + esc(r.email) + '</div>'; } },
        { label: 'Group', html: function (r) { return esc((segs[r.reactivation_segment] || {}).label || r.reactivation_segment || ''); } },
        { label: 'Started', html: function (r) { return esc(when(r.reactivated_at)); } },
        { label: 'Result', html: function (r) { return r.rebooked ? '<span class="pill st-booked">booked again</span>' : r.reapplied ? '<span class="pill">applied again</span>' : r.unsubscribed ? '<span class="muted">unsubscribed</span>' : statusPill(r.status); } },
        { label: '', html: function (r) { return r.rebooked || r.reapplied || r.unsubscribed ? '' : '<button class="btn-sm ghost" type="button" data-re-stop1="' + esc(r.id) + '" title="They replied, or asked to stop">Stop their emails</button>'; } },
      ], d.report.people, { rowAttr: function (r) { return 'class="click" data-lead="' + esc(r.id) + '" tabindex="0"'; } }) + '</div>' : '');
    var per = view.querySelector('[data-reper]'), daysEl = view.querySelector('[data-redays]');
    var upd = function () { var p = Math.max(5, Number(per.value) || 40); daysEl.textContent = chosen.length ? '≈ ' + Math.ceil(chosen.length / p) + ' day' + (Math.ceil(chosen.length / p) === 1 ? '' : 's') + ' to start everyone' : ''; };
    per.oninput = upd; upd();
    view.querySelectorAll('[data-seg]').forEach(function (b) { b.onchange = function () { var k = b.getAttribute('data-seg'); S.segs = b.checked ? S.segs.concat([k]) : S.segs.filter(function (x) { return x !== k; }); drawReactivation(); }; });
    view.querySelectorAll('[data-retier]').forEach(function (b) { b.onchange = function () { F.tiers[b.getAttribute('data-retier')] = b.checked; drawReactivation(); }; });
    view.querySelectorAll('[data-ref]').forEach(function (sel) { sel.onchange = function () { F[sel.getAttribute('data-ref')] = sel.value; drawReactivation(); }; });
    view.querySelectorAll('[data-reprev]').forEach(function (b) { b.onclick = function (e) { e.stopPropagation(); previewPerson(b.getAttribute('data-reprev'), b.getAttribute('data-reseg')); }; });
    view.querySelectorAll('[data-reid]').forEach(function (b) { b.onclick = function (e) { e.stopPropagation(); S.off[b.getAttribute('data-reid')] = !b.checked; drawReactivation(); }; });
    view.querySelectorAll('[data-reopen]').forEach(function (r) { r.onclick = function () { openLead(r.getAttribute('data-reopen')); }; });
    view.querySelectorAll('[data-reall]').forEach(function (b) { b.onclick = function () { var on = b.getAttribute('data-reall') === '1'; shown.forEach(function (r) { S.off[r.id] = !on; }); drawReactivation(); }; });
    var qi = view.querySelector('[data-req]');
    qi.oninput = function () { S.q = qi.value; var pos = qi.selectionStart; drawReactivation(); var q2 = view.querySelector('[data-req]'); q2.focus(); q2.setSelectionRange(pos, pos); };
    view.querySelectorAll('[data-pcview]').forEach(function (el) { var go_ = function () { emailPreview(view.querySelector('.re-mails'), el.getAttribute('data-pcview')); }; el.onclick = go_; el.onkeydown = function (e) { if (e.key === 'Enter') go_(); }; });
    view.querySelectorAll('[data-lead]').forEach(function (row) { row.onclick = function () { openLead(row.getAttribute('data-lead')); }; });
    var lb = view.querySelector('[data-relaunch]');
    lb.onclick = function () {
      var msg = view.querySelector('[data-remsg]');
      if (view.querySelector('[data-reconfirm]').value.trim() !== 'SEND') { msg.textContent = 'Type SEND first.'; return; }
      lb.disabled = true; msg.textContent = 'Launching…';
      send('POST', 'reactivation/launch', { ids: chosen.map(function (r) { return r.id; }), perDay: Number(per.value) || 40, confirm: 'SEND' }).then(function (r) {
        if (r && r.ok) { toast('Launched for ' + r.launched + ' people over ' + r.days + ' day' + (r.days === 1 ? '' : 's')); reState = null; renderReactivation(); }
        else { lb.disabled = false; msg.textContent = (r && r.error) || 'Couldn’t launch'; }
      });
    };
    var st = view.querySelector('[data-restop]');
    view.querySelectorAll('[data-re-stop1]').forEach(function (b) {
      b.onclick = function (e) { e.stopPropagation(); send('POST', 'reactivation/stop', { lead: b.getAttribute('data-re-stop1') }).then(function (r) { toast(r.ok ? 'Stopped ' + r.cancelled + ' emails for them' : 'Could not stop'); b.remove(); }); };
    });
    if (st) st.onclick = function () { if (!confirm('Cancel every reactivation email that hasn’t gone yet?')) return; send('POST', 'reactivation/stop', {}).then(function (r) { toast('Stopped ' + ((r && r.cancelled) || 0) + ' pending emails'); renderReactivation(); }); };
  }

  function renderEmailsWithFlow() {
    return renderEmails().then(function () {
      var box = document.createElement('div');
      box.className = 'card pcflow';
      box.innerHTML = '<p class="loading-note">Loading the pre-call flow…</p>';
      view.insertBefore(box, view.firstChild);
      loadPrecallFlow(box);
    });
  }
  function loadPrecallFlow(box) {
    fetch('/admin/api/precall-flow', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.scenarios) { box.innerHTML = '<p class="muted">Couldn’t load the pre-call flow.</p>'; return; }
      drawPrecallFlow(box, d);
    });
  }
  function pcLabel(h) { return h < 48 ? 'Call in ' + h + ' hours' : 'Call in ' + Math.round(h / 24) + ' days'; }
  function drawPrecallFlow(box, d) {
    var sc = d.scenarios.filter(function (x) { return x.hours === pcState.hours; })[0] || d.scenarios[2] || d.scenarios[0];
    var tz = d.tz;
    var dayFmt = function (t) { try { return new Date(t).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short', timeZone: tz }); } catch (e) { return new Date(t).toLocaleDateString(); } };
    var timeFmt = function (t) { try { return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: tz }); } catch (e) { return new Date(t).toLocaleTimeString(); } };
    var items = sc.emails.map(function (e) { return { at: e.at, kind: 'pc', e: e }; })
      .concat(sc.reminders.map(function (r) { return { at: r.at, kind: 'rem', e: r }; }))
      .concat([{ at: sc.callAt, kind: 'call', e: { subject: 'Strategy call' } }])
      .sort(function (a, b) { return a.at - b.at; });
    var days = [], byDay = {};
    items.forEach(function (it) { var k = dayFmt(it.at); if (!byDay[k]) { byDay[k] = []; days.push(k); } byDay[k].push(it); });
    var personal = sc.emails.filter(function (e) { return e.personal; }).length;
    var card = function (it) {
      if (it.kind === 'call') return '<li class="pc-item pc-call"><span class="pc-time">' + esc(timeFmt(it.at)) + '</span><strong>📞 The call</strong></li>';
      var e = it.e;
      return '<li class="pc-item ' + (it.kind === 'rem' ? 'pc-rem' : PC_STAGE_CLS[e.stage]) + '" data-pcview="' + esc(e.template) + '" tabindex="0" role="button" title="Preview this email">' +
        '<span class="pc-time">' + esc(timeFmt(it.at)) + '</span>' +
        '<span class="pc-subj">' + esc(e.subject) + '</span>' +
        '<span class="pc-meta">' + (it.kind === 'rem' ? 'reminder' : esc(d.stages[e.stage] || '') + (e.personal ? ' · <b>from their application</b>' : '')) + '</span></li>';
    };
    box.innerHTML =
      '<div class="pc-head"><div><h2>Pre-call flow</h2><p class="sub">What a booked lead gets between booking and the call: <b>' + n(sc.emails.length) + ' pre-call emails</b> (' + n(personal) + ' written from their own application) plus ' + n(sc.reminders.length) + ' reminders. ' +
      'Spread over 7am–9pm their time, at least 30–45 minutes apart, ' + n(d.limits.min) + '–' + n(d.limits.max) + ' emails, at most ' + n(d.limits.perDay) + ' a day; stops 2¼ hours before the call or as soon as they cancel. Example: ' + esc(d.lead.name) + (d.lead.sample ? '' : ' (a real recent applicant)') + ', ' + esc(tz) + '.</p></div>' +
      '<div class="row pc-scen">' + d.scenarios.map(function (x) { return '<button class="btn-sm' + (x.hours === sc.hours ? '' : ' ghost') + '" data-pch="' + x.hours + '">' + esc(pcLabel(x.hours)) + '<span class="muted"> · ' + n(x.emails.length) + '</span></button>'; }).join('') + '</div></div>' +
      '<div class="pc-legend">' + [1, 2, 3, 4, 5].map(function (i) { return '<span class="' + PC_STAGE_CLS[i] + '"><i></i>' + esc(d.stages[i]) + '</span>'; }).join('') + '<span class="pc-rem"><i></i>Reminders</span></div>' +
      '<div class="pc-days">' + days.map(function (k) { return '<section class="pc-day"><h3>' + esc(k) + '<span class="muted"> · ' + n(byDay[k].filter(function (x) { return x.kind === 'pc'; }).length) + ' emails</span></h3><ol>' + byDay[k].map(card).join('') + '</ol></section>'; }).join('') + '</div>' +
      '<div class="pc-preview" data-pcout hidden></div>' +
      '<p class="muted pc-foot">Change the numbers in <a href="#integrations" data-go="integrations">Integrations → Email</a> (Pre-call emails: at least / at most / most in one day). A call booked further out gets the fuller story; a short-notice call gets the most important emails, still in order.</p>';
    box.querySelectorAll('[data-pch]').forEach(function (b) { b.onclick = function () { pcState.hours = Number(b.getAttribute('data-pch')); drawPrecallFlow(box, d); }; });
    var open = function (el) {
      var t = el.getAttribute('data-pcview'), out = box.querySelector('[data-pcout]');
      box.querySelectorAll('.pc-item.on').forEach(function (x) { x.classList.remove('on'); }); el.classList.add('on');
      out.hidden = false; out.innerHTML = '<p class="loading-note">Loading the email…</p>';
      fetch('/admin/api/precall-flow/email?template=' + encodeURIComponent(t), { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (e) {
        if (e.error) { out.innerHTML = '<p class="muted">' + esc(e.error) + '</p>'; return; }
        out.innerHTML = '<div class="row pc-prev-head"><strong>' + esc(e.subject) + '</strong><span class="muted mono">' + esc(t) + '</span><button class="btn-sm ghost" data-pcclose>Close</button></div><iframe class="email-preview" sandbox title="Email preview"></iframe>';
        out.querySelector('iframe').srcdoc = e.html;
        out.querySelector('[data-pcclose]').onclick = function () { out.hidden = true; el.classList.remove('on'); };
        out.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    };
    box.querySelectorAll('[data-pcview]').forEach(function (el) {
      el.onclick = function () { open(el); };
      el.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(el); } };
    });
  }

  function renderEmails() {
    return Promise.all([api('emails'), api('triggers')]).then(function (res) {
      var d = res[0], tr = res[1];
      var tpl = d.templates || [], order = [], bySeq = {};
      tpl.forEach(function (r) {
        var k = r.sequence;
        if (!bySeq[k]) { bySeq[k] = { rows: [], sent: 0, simulated: 0, skipped: 0, failed: 0, opened: 0, clicked: 0 }; order.push(k); }
        var g = bySeq[k];
        g.rows.push(r);
        ['sent', 'simulated', 'skipped', 'failed', 'opened', 'clicked'].forEach(function (f) { g[f] += Number(r[f]) || 0; });
      });
      var totSent = tpl.reduce(function (t, r) { return t + (Number(r.sent) || 0); }, 0);
      var totSim = tpl.reduce(function (t, r) { return t + (Number(r.simulated) || 0); }, 0);
      // "Sent" counts simulated emails too, so "nothing really sent" is sent − simulated = 0.
      var allSimulated = totSim > 0 && totSent - totSim === 0;
      var emailCols = [{ label: 'Sequence', key: 'sequence' }, { label: '#', key: 'step', num: true, fmt: function (v) { return v + 1; } }, { label: 'Template', html: function (r) { return '<a href="/admin/api/email-preview/' + esc(r.template) + '" target="_blank" rel="noopener">' + esc(r.template) + ' ↗</a>'; } },
        { label: 'Sent (incl. simulated)', key: 'sent', num: true, fmt: n }, { label: 'Simulated', key: 'simulated', num: true, fmt: n }, { label: 'Skipped', key: 'skipped', num: true, fmt: n }, { label: 'Failed', key: 'failed', num: true, fmt: n },
        { label: 'Open rate', num: true, html: function (r) { return esc(pct(r.opened / (r.sent || 1))); } }, { label: 'Click rate', num: true, html: function (r) { return esc(pct(r.clicked / (r.sent || 1))); } }];
      var rules = (tr && tr.rules) || [], fails = d.failures || [];
      var fired = function (r) { return (Number(r.queued) || 0) > 0 || (Number(r.sent) || 0) > 0; };
      var firedRules = rules.filter(fired), quietRules = rules.filter(function (r) { return !fired(r); });
      var trigCols = [
        { label: 'Trigger', html: function (r) { var code = r.template + ' · sends ' + (r.delay ? r.delay + ' min after' : 'right away'); return '<div class="trig-name" title="' + esc(code) + '">' + esc(r.label) + '<div class="muted mono trig-code">' + esc(code) + '</div></div>'; } },
        { label: 'Fired', key: 'queued', num: true, fmt: n }, { label: 'Sent', key: 'sent', num: true, fmt: n },
        { label: 'Skipped', num: true, html: function (r) { return '<span class="muted" title="Condition no longer true when it was time to send (e.g. they booked)">' + n(r.skipped) + '</span>'; } },
        { label: 'Opened', num: true, html: function (r) { return esc(r.sent ? pct(r.opened / r.sent) : '–'); } },
        { label: 'Clicked', num: true, html: function (r) { return esc(r.sent ? pct(r.clicked / r.sent) : '–'); } },
        { label: 'Booked after', key: 'booked_after', num: true, fmt: n },
      ];
      // No failures: one calm line in the Queue card instead of an empty half-width card.
      var queueCard = '<div class="card"><div class="card-head wrap-head"><div><h2>Queue</h2><p class="sub">Scheduled and waiting for the 5-minute sender.</p></div>' +
        (fails.length ? '' : '<span class="calm-line"><span class="status-dot" style="background:var(--good)" aria-hidden="true"></span> No failed sends · retries 3× with back-off</span>') + '</div>' +
        table([{ label: 'Sequence', html: function (r) { return esc(seqLabel(r.sequence)); } }, { label: 'Pending', key: 'pending', num: true, fmt: n }, { label: 'Next send', html: function (r) { return esc(when(r.next_at)); } }], d.queue || []) + '</div>';
      var stat = function (label, val, cls, tip) { return '<span class="seq-stat' + (cls ? ' ' + cls : '') + '"' + (tip ? ' title="' + esc(tip) + '"' : '') + '><small>' + esc(label) + '</small>' + esc(val) + '</span>'; };
      var seqHtml = order.map(function (k) {
        var g = bySeq[k], steps = g.rows.length, desc = seqDesc(k);
        return '<details class="seq-group"' + (g.failed > 0 ? ' open' : '') + '><summary><span class="seq-name"' + (desc ? ' title="' + esc(desc) + '"' : '') + '><b>' + esc(seqLabel(k)) + '</b> <span class="muted">' + esc(steps + (steps === 1 ? ' email' : ' emails')) + '</span>' + (desc ? '<span class="seq-desc">' + esc(desc) + '</span>' : '') + '</span>' +
          stat('Sent for real', n(Math.max(0, g.sent - g.simulated)), '', 'Sent through Resend: all sends minus simulated ones (' + n(g.sent) + ' − ' + n(g.simulated) + ')') +
          stat('Simulated', n(g.simulated), '', 'Rendered and logged but not sent: no Resend key was connected') + stat('Skipped', n(g.skipped), '', 'Not sent because it no longer applied (e.g. they booked)') + stat('Failed', n(g.failed), g.failed > 0 ? 'seq-failed' : '', 'Failed after 3 retries') +
          stat('Open rate', g.sent ? pct(g.opened / g.sent) : '–', '', 'Opened ÷ all sends, simulated included') + stat('Click rate', g.sent ? pct(g.clicked / g.sent) : '–', '', 'Clicked ÷ all sends, simulated included') + '</summary>' +
          table(emailCols, g.rows) + '</details>';
      }).join('');
      view.innerHTML =
        (allSimulated ? '<div class="card notice" style="margin-bottom:14px">Emails are simulated: no Resend key yet, so nothing is actually sent and open/click rates show once it’s connected. <a href="#integrations" data-go="integrations">Connect it in Integrations →</a></div>' : '') +
        '<div class="card" style="margin-bottom:14px"><h2>Behaviour-triggered emails</h2><p class="sub">' + esc('One email when someone does something specific on the page, written for them from what they did. Each fires once per person; at most 8 emails a day to anyone in total; re-checked right before sending. · ' + n(firedRules.length) + ' of ' + n(rules.length) + ' fired in this range') + '</p>' +
        (firedRules.length ? table(trigCols, firedRules, { cards: 3 }) : emptyState('None of the ' + n(rules.length) + ' triggers has fired in this range yet.')) +
        (quietRules.length ? '<details class="more-rows"><summary>' + esc('Show the other ' + quietRules.length + (quietRules.length === 1 ? ' trigger that hasn’t' : ' triggers that haven’t') + ' fired yet') + '</summary>' + table(trigCols, quietRules, { cards: 3 }) + '</details>' : '') + '</div>' +
        (fails.length ? '<div class="grid g-2" style="margin-bottom:14px">' + queueCard + '<div class="card"><h2>Recent failures · ' + esc(n(fails.length)) + '</h2><p class="sub">Retries 3× with back-off before failing.</p>' + table([{ label: 'Template', key: 'template' }, { label: 'To', key: 'to_email' }, { label: 'Error', key: 'error' }], fails) + '</div></div>'
          : '<div style="margin-bottom:14px">' + queueCard + '</div>') +
        '<div class="card"><h2>By email</h2><p class="sub">“Simulated” means no Resend key was connected — the email was rendered and logged but not sent. Click a sequence to see each email.</p>' +
        (order.length ? '<div class="seq-list">' + seqHtml + '</div>' : emptyState('No data in this range yet.')) + '</div>';
    });
  }
  /** Readable sequence name: its name in config if it has one, else the key ("tier_a" → "Tier A"). */
  function seqLabel(k) {
    var list = state.meta && Array.isArray(state.meta.sequences) ? state.meta.sequences : [];
    var x = list.filter(function (s) { return s && (s.id === k || s.key === k); })[0];
    if (x && (x.name || x.label)) return String(x.name || x.label);
    var t = String(k == null ? '' : k).replace(/_/g, ' ').replace(/\b([a-z])\b/g, function (c) { return c.toUpperCase(); });
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  function seqDesc(k) {
    var list = state.meta && Array.isArray(state.meta.sequences) ? state.meta.sequences : [];
    var x = list.filter(function (s) { return s && (s.id === k || s.key === k); })[0];
    return x && x.description ? String(x.description).replace(/\s*\(see [^)]*\)/g, '') : ''; // drop code pointers like "(see personalize/triggers.ts)"
  }

  var liveState = { window: '24h', all: false };
  function renderLive() {
    var WINDOWS = [['1h', 'Last hour'], ['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days'], ['90d', '90 days'], ['all', 'All time']];
    var rows = [], nextBefore = null, paged = false;
    var cols = [
      { label: 'When', html: function (e) { return '<span title="' + esc(when(e.ts)) + '">' + esc(ago(e.ts)) + '</span>'; } },
      { label: 'Event', html: function (e) { return '<strong>' + esc(EVENT_LABELS[e.name] || e.name) + '</strong> <span class="muted">' + esc(e.path || '') + '</span>'; } },
      { label: 'Who', html: function (e) { return e.lead_id ? '<a href="#lead=' + esc(e.lead_id) + '" data-open="' + esc(e.lead_id) + '">' + esc([e.first_name, e.last_name].filter(Boolean).join(' ') || 'lead') + '</a>' + (e.tier ? ' <span class="tier ' + esc(e.tier) + '">' + esc(e.tier) + '</span>' : '') : (e.visitor_id ? '<a href="#" data-visitor="' + esc(e.visitor_id) + '" class="muted">anonymous</a>' : '<span class="muted">anonymous</span>'); } },
      { label: 'Where', html: function (e) { return esc([e.city, e.country].filter(Boolean).join(', ')); } },
      { label: 'Source', html: function (e) { return esc(where(e.channel, e.utm_source, e.referrer_host, e.utm_medium)) + (e.utm_campaign ? ' <span class="muted">' + esc(e.utm_campaign) + '</span>' : ''); } },
      { label: 'Device', key: 'device' },
    ];
    function wire() {
      view.querySelectorAll('[data-open]').forEach(function (a) { a.onclick = function (ev) { ev.preventDefault(); openLead(a.getAttribute('data-open')); }; });
      view.querySelectorAll('a[data-visitor]').forEach(function (a) { a.onclick = function (ev) { ev.preventDefault(); openVisitor(a.getAttribute('data-visitor')); }; });
      view.querySelectorAll('[data-lw]').forEach(function (b) { b.onclick = function () { liveState.window = b.getAttribute('data-lw'); draw(); }; });
      var all = view.querySelector('[data-lall]'); if (all) all.onchange = function () { liveState.all = all.checked; draw(); };
      var more = view.querySelector('[data-lmore]'); if (more) more.onclick = function () { more.disabled = true; more.textContent = 'Loading…'; fetchPage(nextBefore).then(function (d) { rows = rows.concat(d.events); nextBefore = d.nextBefore; paged = true; paint(d); }); };
    }
    function fetchPage(before) {
      return api('live', { window: liveState.window, all: liveState.all ? '1' : '', before: before || '' }, { noRange: true });
    }
    function paint(d) {
      var t = d.totals || {};
      var label = (WINDOWS.filter(function (w) { return w[0] === liveState.window; })[0] || [0, ''])[1];
      view.innerHTML =
        '<div class="grid g-3">' + tile('Active right now', n(d.active), 'Visitors in the last 5 minutes') + '<div class="card" style="grid-column:span 2"><h2>Being viewed right now</h2>' + (d.activePages.length ? barList(d.activePages.map(function (p) { return { name: p.path, value: p.n }; })) : '<p class="muted">Nobody on the site this minute.</p>') + '</div></div>' +
        '<div class="card" style="margin-top:14px"><div class="card-head"><div><h2>Activity · ' + esc(label) + '</h2><p class="sub">Everything people did, newest first. Pick how far back to look; scroll down and press “Load older” to keep going.</p></div>' +
        '<div class="row" style="gap:6px;flex-wrap:wrap">' + WINDOWS.map(function (w) { return '<button class="btn-sm' + (w[0] === liveState.window ? '' : ' ghost') + '" data-lw="' + w[0] + '">' + esc(w[1]) + '</button>'; }).join('') + '</div></div>' +
        '<div class="grid g-4 tiles" style="margin:10px 0 14px">' + tile('Visitors', n(t.visitors || 0), label) + tile('Page views', n(t.views || 0), n(t.events || 0) + ' events in total') + tile('New leads', n(t.leads || 0), n(t.applied || 0) + ' finished the application') + tile('Calls booked', n(t.booked || 0), label) + '</div>' +
        (d.pages && d.pages.length ? '<details class="more-rows" style="margin-bottom:12px"><summary>Most-viewed pages · ' + esc(label) + '</summary>' + barList(d.pages.map(function (p) { return { name: p.path, value: p.n }; })) + '</details>' : '') +
        '<label class="muted" style="display:inline-flex;gap:6px;align-items:center;margin-bottom:8px"><input type="checkbox" data-lall' + (liveState.all ? ' checked' : '') + '> show every signal (scrolls, reading time, hovers…)</label>' +
        (rows.length ? table(cols, rows, { feed: true }) : '<p class="muted">Nothing in this range.</p>') +
        (nextBefore ? '<div class="row" style="justify-content:center;margin-top:12px"><button class="btn-sm ghost" data-lmore>Load older</button></div>' : (rows.length ? '<p class="muted" style="text-align:center;margin-top:10px">That’s everything in this range.</p>' : '')) +
        '</div>';
      wire();
    }
    function draw() {
      rows = []; nextBefore = null; paged = false;
      return fetchPage(null).then(function (d) { rows = d.events; nextBefore = d.nextBefore; paint(d); });
    }
    // Auto-refresh only while you're looking at the newest page (it would throw away older rows you loaded).
    liveTimer = setInterval(function () { if (!document.hidden && !document.querySelector('.drawer') && !paged) draw(); }, 5000);
    return draw();
  }

  var openSettings = null; // settings groups left open across a save (Integrations)
  function renderIntegrations() {
    return fetch('/admin/api/integrations', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
      var groups = {};
      d.settings.forEach(function (s) { (groups[s.group] = groups[s.group] || []).push(s); });
      var groupNames = Object.keys(groups);
      var slug = function (g) { return String(g).toLowerCase().replace(/[^a-z0-9]+/g, '-'); };
      // Status tile → the settings group that configures it (case-insensitive; tried with the key, then the label).
      var TILE_GROUP = { email: 'Email', whatsapp: 'WhatsApp', voice: 'Voice', 'voice agent': 'Voice', aicalls: 'Voice', 'ai calls (elevenlabs)': 'Voice', booking: 'Booking', calendly: 'Booking', analytics: 'Analytics', posthog: 'Analytics', ga4: 'Analytics', meta: 'Ads', alerts: 'Alerts', slack: 'Alerts', 'team pings': 'Alerts', crm: 'Alerts', 'crm webhook': 'Alerts', video: 'Video', whop: 'Webinar', zoom: 'Live', 'zoom (live events)': 'Live' };
      var findGroup = function (name) {
        if (!name) return null;
        var want = String(TILE_GROUP[String(name).toLowerCase()] || name).toLowerCase();
        return groupNames.filter(function (g) { return g.toLowerCase() === want; })[0] || null;
      };
      view.innerHTML =
        '<div class="card"><h2>Status</h2><p class="sub">Click a service to jump to its settings.</p><div class="int-grid" style="margin-top:10px">' + Object.keys(d.status).map(function (k) {
          var s = d.status[k];
          var g = findGroup(k) || findGroup(s.label);
          return '<div class="int' + (g ? ' click" role="button" tabindex="0" data-set-jump="' + esc(slug(g)) + '" title="' + esc('Open ' + g + ' settings') : '') + '"><span class="badge">' + (s.connected ? '<span class="status-dot" style="background:var(--good)" aria-hidden="true"></span>' : '<span class="status-dot" style="background:var(--axis)" aria-hidden="true"></span>') + '</span><div><b>' + esc(s.label || k) + ' · ' + (s.connected ? 'connected' : 'not connected') + '</b><span>' + esc(s.detail) + '</span></div></div>';
        }).join('') + '</div></div>' +
        '<div class="card" style="margin-top:14px"><div class="card-head"><div><h2>Calendly</h2><p class="sub">With the personal access token connected: exact call times the moment someone books, meeting links in the reminders, the host mapped to your closer, their booking answers, a signed webhook (bookings, cancellations, reschedules, no-shows) and an hourly sync. Calls booked straight from the Calendly link are imported for the sales numbers only; they get no emails.</p></div></div>' +
        '<div class="row"><button class="btn-sm" data-cal-connect>Connect webhook &amp; import</button><button class="btn-sm ghost" data-cal-sync>Sync now</button><button class="btn-sm ghost" data-cal-history>Import full history</button><span class="muted" data-cal-out></span></div></div>' +
        '<div class="card" style="margin-top:14px" data-whop-card><div class="card-head"><div><h2>Payments: Whop</h2><p class="sub">With the Whop API key saved (Keys &amp; settings → Webinar), Whop takes the Masterclass ticket and First Deal Sprint payments instead of Stripe. Connect reads the company behind the key and creates the payments webhook (' + esc(d.webhooks.whop) + ': payment.succeeded, refund.created, refund.updated). Whop caps checkout links at $2,500 until you apply for higher ones in Whop → Settings → Payments.</p></div><div class="row"><button class="btn-sm" type="button" data-whop-connect>Connect Whop</button></div></div>' +
        '<div data-whop-out class="muted small">' + esc((d.status.whop && d.status.whop.detail) || '') + '</div></div>' +
        '<div style="margin-top:14px" data-dm-int></div>' +
        '<div class="card" style="margin-top:14px" data-zoom-card><div class="card-head"><div><h2>Zoom</h2><p class="sub">Live webinar sessions and challenge days run on Zoom. Each event has a host console (Webinar → Upcoming sessions → Host console) where you paste its Zoom link. With a Zoom Server-to-Server OAuth app connected (Keys &amp; settings → Live), Funnel HQ creates the meeting itself, or a Zoom Webinar when your account has the add-on, and opens a fresh host start link for you.</p></div><div class="row"><button class="btn-sm" type="button" data-zoom-check>Check</button></div></div>' +
        '<div data-zoom-out class="muted small">' + esc((d.status.zoom && d.status.zoom.detail) || '') + '</div></div>' +
        '<div class="card" style="margin-top:14px"><div class="card-head"><div><h2>Bounce blocking</h2><p class="sub">When an email hard-bounces or someone marks it as spam, Resend tells the funnel and that address is blocked: every queued email to it is cancelled and nothing is ever sent to it again, in any campaign.</p></div><div class="row"><button class="btn-sm" type="button" data-bb-connect>Connect bounce blocking</button></div></div>' +
        '<div class="row"><input class="input" type="email" placeholder="block an address by hand" data-bb-email style="flex:1"><button class="btn-sm ghost" type="button" data-bb-add>Block</button></div><div data-bb-list class="muted" style="margin-top:10px">Loading…</div></div>' +
        '<div class="grid g-2" style="margin-top:14px"><div class="card"><h2>Test email</h2><p class="sub">Sends a test through Resend to confirm the key, domain and From address.</p><div class="row"><input class="input" type="email" placeholder="you@company.com" data-test-to style="flex:1"><button class="btn-sm" data-test>Send test</button></div></div>' +
        '<div class="card"><h2>Webhook URLs</h2><p class="sub">Paste these into each provider.</p><dl class="kv">' + kv('Calendly', d.webhooks.calendly) + kv('Cal.com / GHL / Zapier', d.webhooks.booking) + kv('WhatsApp Cloud API', d.webhooks.whatsapp) + kv('Vapi (voice) Server URL', d.webhooks.voice) + kv('Resend (bounces)', d.webhooks.resend) + kv('Whop (payments)', d.webhooks.whop) + kv('Stripe (payments)', d.webhooks.stripe) + '</dl></div></div>' +
        '<div class="card" style="margin-top:14px"><div class="card-head"><div><h2>Voice assistant</h2><p class="sub">Creates (or updates) the inbound assistant in your Vapi account from the copy, FAQs and rules in config. Save your Vapi keys and webhook secret first. Then in Vapi, set your phone number’s Server URL to the voice URL above and leave its assistant empty.</p></div><div class="row"><a class="btn-sm ghost" href="/admin/api/voice/assistant.json" target="_blank" rel="noopener">View JSON</a><button class="btn-sm" type="button" data-provision>Create / update assistant</button></div></div></div>' +
        '<form class="card" style="margin-top:14px" data-settings><div class="card-head sticky-head"><div><h2>Keys & settings</h2><p class="sub">Values set as Worker secrets/vars are locked here (they always win). Secrets are never shown — leave a masked field blank to keep it, type “-” to clear it.</p></div><button class="btn-sm" type="submit">Save changes</button></div>' +
        '<div class="set-jump">' + groupNames.map(function (g) { return '<a href="#integrations" data-set-jump="' + esc(slug(g)) + '">' + esc(g) + '</a>'; }).join('') + '</div>' +
        groupNames.map(function (g, gi) {
          var list = groups[g];
          var x = list.filter(function (s) { return (s.source && s.source !== '' && s.source !== 'unset') || s.value; }).length, y = list.length;
          return '<details class="settings-group" id="set-' + esc(slug(g)) + '"' + ((openSettings ? openSettings.indexOf(slug(g)) !== -1 : gi === 0) ? ' open' : '') + '><summary><h3>' + esc(g) + '</h3><span class="pill' + (x === y ? ' st-won' : '') + '">' + x + ' of ' + y + ' set</span></summary>' + list.map(function (s) {
            var locked = s.source === 'env';
            return '<div class="setting"><div><label for="s_' + esc(s.key) + '">' + esc(s.label) + '</label>' + (s.help ? '<div class="help">' + esc(s.help) + '</div>' : '') + '</div><div><input id="s_' + esc(s.key) + '" name="' + esc(s.key) + '" ' + (s.secret ? 'type="password" autocomplete="new-password" placeholder="' + esc(s.value ? s.value + ' (saved)' : (s.placeholder || '')) + '" value=""' : 'value="' + esc(s.value) + '" placeholder="' + esc(s.placeholder || '') + '"') + (locked ? ' disabled' : '') + '><div class="src">' + (locked ? 'Set via Worker environment' : s.source === 'dashboard' ? 'Saved in dashboard' : 'Not set') + ' · <span class="mono">' + esc(s.key) + '</span></div></div></div>';
          }).join('') + '</details>';
        }).join('') + '<div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn-sm" type="submit">Save changes</button></div></form>';
      openSettings = null;
      // Claude (MCP) and Zapier & webhooks panels (public/assets/ops-e.js), above Keys & settings.
      if (window.AutomationsPanel) {
        var autoBox = document.createElement('div');
        var settingsForm = view.querySelector('[data-settings]');
        settingsForm.parentNode.insertBefore(autoBox, settingsForm);
        window.AutomationsPanel.render(autoBox, { esc: esc, when: when, toast: toast }).catch(function (e) { autoBox.innerHTML = '<div class="card">' + esc(e.message) + '</div>'; });
      }

      var jumpTo = function (key) {
        var el = document.getElementById('set-' + key);
        if (!el) return;
        el.open = true;
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
      view.querySelectorAll('[data-set-jump]').forEach(function (a) {
        a.onclick = function (ev) { ev.preventDefault(); jumpTo(a.getAttribute('data-set-jump')); };
        if (a.tagName !== 'A') a.onkeydown = function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); jumpTo(a.getAttribute('data-set-jump')); } };
      });

      view.querySelector('[data-provision]').onclick = function () {
        send('POST', 'voice/provision', {}).then(function (r) { toast(r.ok ? 'Assistant ' + (r.created ? 'created' : 'updated') + ' ✓' : (r.error || 'Failed')); if (r.ok) load(); });
      };
      var calOut = view.querySelector('[data-cal-out]');
      var calDone = function (r) { calOut.textContent = r.ok ? ((r.name ? 'Connected as ' + r.name + ' · ' : '') + (r.sync ? r.sync.events + ' events checked, ' + r.sync.updated + ' updated, ' + r.sync.imported + ' imported, ' + r.sync.cancelled + ' cancelled' : 'synced')) : (r.error || 'Failed'); };
      view.querySelector('[data-cal-connect]').onclick = function () { calOut.textContent = 'Connecting…'; send('POST', 'calendly/connect', {}).then(calDone); };
      view.querySelector('[data-cal-history]').onclick = function () {
        var b = this, tot = { events: 0, imported: 0, updated: 0, cancelled: 0 };
        b.disabled = true;
        (function step(cursor) {
          send('POST', 'calendly/import', { cursor: cursor }).then(function (r) {
            if (!r.ok) { calOut.textContent = r.error || 'Failed'; b.disabled = false; return; }
            ['events', 'imported', 'updated', 'cancelled'].forEach(function (k) { tot[k] += r[k] || 0; });
            calOut.textContent = (r.next ? 'Importing… ' : 'Done: ') + tot.events + ' bookings, ' + tot.imported + ' new people, ' + tot.updated + ' updated';
            if (r.next) step(r.next); else b.disabled = false;
          });
        })(null);
      };
      view.querySelector('[data-cal-sync]').onclick = function () { calOut.textContent = 'Syncing…'; send('POST', 'calendly/sync', {}).then(calDone); };
      var bbList = view.querySelector('[data-bb-list]');
      var bbLoad = function () {
        fetch('/admin/api/email/suppressions', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (b) {
          view.querySelector('[data-bb-connect]').textContent = b.connected ? 'Reconnect' : 'Connect bounce blocking';
          bbList.innerHTML = (b.connected ? '<b style="color:var(--good)">On.</b> ' : '<b>Off.</b> Click Connect to switch it on. ') + (b.list.length ? b.list.length + ' blocked address' + (b.list.length === 1 ? '' : 'es') + ':' + '<div class="table-wrap" style="margin-top:8px"><table class="t"><tbody>' + b.list.map(function (x) {
            return '<tr><td class="mono">' + esc(x.email) + '</td><td>' + esc(x.reason) + '</td><td class="muted">' + esc(x.detail || '') + '</td><td>' + esc(new Date(x.created_at).toLocaleDateString()) + '</td><td><button class="btn-sm ghost" type="button" data-bb-del="' + esc(x.email) + '">Unblock</button></td></tr>';
          }).join('') + '</tbody></table></div>' : 'No blocked addresses yet.');
          bbList.querySelectorAll('[data-bb-del]').forEach(function (btn) {
            btn.onclick = function () {
              if (!confirm('Unblock ' + btn.getAttribute('data-bb-del') + '? Emails to a bounced address hurt your sender reputation.')) return;
              send('DELETE', 'email/suppressions?email=' + encodeURIComponent(btn.getAttribute('data-bb-del'))).then(function (r) { toast(r.note || 'Unblocked'); bbLoad(); });
            };
          });
        });
      };
      bbLoad();
      view.querySelector('[data-whop-connect]').onclick = function () {
        var out = view.querySelector('[data-whop-out]'), b = this;
        b.disabled = true; out.textContent = 'Connecting to Whop…';
        send('POST', 'whop/connect', {}).then(function (r) {
          b.disabled = false;
          if (!r.ok) { out.textContent = r.error || 'Failed'; return; }
          var w = r.webhook || {};
          out.innerHTML = '<b style="color:var(--good)">Connected to ' + esc((r.company && (r.company.title || r.company.id)) || 'Whop') + '</b> (' + esc(r.company && r.company.id) + '). ' +
            (w.created ? 'Webhook created and its secret saved.' : esc(w.note || '')) +
            ((r.steps || []).length ? '<ol style="margin:8px 0 0 18px">' + r.steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' : '');
          toast(w.created ? 'Whop connected ✓' : 'Whop company saved');
        });
      };
      var dmInt = view.querySelector('[data-dm-int]');
      if (dmInt && window.DmInbox) window.DmInbox.integrationCard(dmInt, { api: api, send: send, esc: esc });
      view.querySelector('[data-zoom-check]').onclick = function () {
        var out = view.querySelector('[data-zoom-out]'), b = this;
        b.disabled = true; out.textContent = 'Asking Zoom…';
        fetch('/admin/api/live-events/zoom/check', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (r) {
          b.disabled = false;
          var head = r.ready ? '<b style="color:var(--good)">Ready.</b> Funnel HQ can create Zoom meetings' + (r.webinars ? ' and Zoom Webinars' : r.webinars === false ? ' (no Zoom Webinar add-on, so meetings)' : '') + '.' + (r.canRefreshHostLink ? '' : ' Add meeting:read:meeting:admin so the host start link refreshes.')
            : (r.configured ? '<b>Not ready.</b> ' : '') + esc(r.reason || '');
          out.innerHTML = head + (r.scopes && r.scopes.length ? '<div class="mono" style="margin-top:6px">Scopes: ' + esc(r.scopes.join(' ')) + '</div>' : '') +
            (r.ready ? '' : '<ol style="margin:8px 0 0 18px">' + (r.steps || []).map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>');
        }).catch(function () { b.disabled = false; out.textContent = 'Couldn’t reach Funnel HQ. Try again.'; });
      };
      view.querySelector('[data-bb-connect]').onclick = function () {
        bbList.textContent = 'Connecting to Resend…';
        send('POST', 'email/suppressions/connect', {}).then(function (r) { toast(r.ok ? 'Bounce blocking on ✓' : (r.error || 'Failed')); bbLoad(); });
      };
      view.querySelector('[data-bb-add]').onclick = function () {
        send('POST', 'email/suppressions', { email: view.querySelector('[data-bb-email]').value }).then(function (r) { toast(r.ok ? 'Blocked · ' + r.cancelled + ' queued emails cancelled' : (r.error || 'Failed')); bbLoad(); });
      };
      view.querySelector('[data-test]').onclick = function () {
        send('POST', 'integrations/test-email', { to: view.querySelector('[data-test-to]').value }).then(function (r) { toast(r.ok ? 'Test email sent ✓' : (r.error || 'Failed')); });
      };
      view.querySelector('[data-settings]').onsubmit = function (e) {
        e.preventDefault();
        var body = {};
        d.settings.forEach(function (s) {
          var input = e.target.elements[s.key];
          if (!input || input.disabled) return;
          var v = input.value;
          if (s.secret) { if (v === '-') body[s.key] = ''; else if (v) body[s.key] = v; }
          else if (v !== s.value) body[s.key] = v;
        });
        // Keep the groups that were open, so the page doesn't jump back to the top after saving.
        openSettings = [].map.call(view.querySelectorAll('details.settings-group[open]'), function (x) { return x.id.slice(4); });
        send('PUT', 'integrations', body).then(function () { toast('Saved'); load(); });
      };
    });
  }

  // ───────────── filters, nav, theme ─────────────
  function populateFilters() {
    var r = range();
    var base = '/admin/api/attribution?from=' + r.from + '&to=' + r.to + '&dim=';
    ['channel', 'campaign', 'variant'].forEach(function (dim) {
      fetch(base + dim, { credentials: 'same-origin' }).then(function (x) { return x.json(); }).then(function (d) {
        var sel = document.querySelector('[data-filter="' + dim + '"]');
        var cur = sel.value;
        var first = sel.options[0].outerHTML;
        sel.innerHTML = first + (d.rows || []).filter(function (row) { return row.key !== '(none)'; }).map(function (row) { return '<option value="' + esc(row.key) + '">' + esc(row.key) + '</option>'; }).join('');
        sel.value = cur;
        sel.title = sel.value ? sel.options[sel.selectedIndex].text : '';
        updateFilterCue();
      }).catch(function () {});
    });
  }

  document.querySelectorAll('[data-range] button').forEach(function (b) {
    b.onclick = function () {
      state.days = +b.getAttribute('data-days');
      document.querySelectorAll('[data-range] button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      populateFilters();
      load();
    };
  });
  document.querySelectorAll('[data-filter]').forEach(function (sel) {
    sel.onchange = function () {
      state.filters[sel.getAttribute('data-filter')] = sel.value;
      sel.title = sel.value ? sel.options[sel.selectedIndex].text : '';
      updateFilterCue();
      load();
    };
  });
  document.querySelector('[data-clear]').onclick = function () {
    state.filters = {};
    if (state.tab === 'leads') { state.leadsQuery.tier = ''; state.leadsQuery.status = ''; state.leadsQuery.q = ''; state.leadsQuery.page = 0; state.leadsQuery._focus = false; }
    document.querySelectorAll('[data-filter]').forEach(function (s) { s.value = ''; s.title = ''; });
    updateFilterCue();
    load();
  };
  document.querySelectorAll('[data-nav] button').forEach(function (b) { b.onclick = function () { go(b.getAttribute('data-tab')); }; });

  // Phone: the ☰ button opens the grouped nav as a sheet; picking a tab (go) or Escape closes it.
  if (navToggleEl) navToggleEl.onclick = function () { setNavOpen(!document.body.classList.contains('nav-open')); };
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && document.body.classList.contains('nav-open')) { setNavOpen(false); navToggleEl.focus(); } });

  // One handler for every in-app link: data-go="<tab>" switches tab, data-open="<lead id>" opens the lead drawer.
  // Per-tab onclick bindings that already handled the click call preventDefault, so they never fire twice.
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest && e.target.closest('[data-go],[data-open]');
    if (!a) return;
    if (!(view.contains(a) || a.closest('.drawer') || a.closest('[data-attention]') || a.closest('.side'))) return;
    e.preventDefault();
    if (a.hasAttribute('data-open')) { openLead(a.getAttribute('data-open')); return; }
    if (a.hasAttribute('data-tier') || a.hasAttribute('data-status')) {
      // A to-do chip opens Leads with exactly that filter (and nothing left over from earlier).
      state.leadsQuery.tier = a.getAttribute('data-tier') || '';
      state.leadsQuery.status = a.getAttribute('data-status') || '';
      state.leadsQuery.q = '';
      state.leadsQuery.page = 0;
    }
    go(a.getAttribute('data-go'));
  });
  addEventListener('hashchange', route);
  addEventListener('popstate', route);

  // Sidebar "Find a lead": from any tab, Enter opens Leads filtered to what was typed (and only that). "/" jumps to the box.
  var navSearch = document.querySelector('[data-nav-search]');
  if (navSearch) {
    var navSearchIn = navSearch.querySelector('input');
    navSearch.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = navSearchIn.value.trim();
      state.leadsQuery.q = v; state.leadsQuery.tier = ''; state.leadsQuery.status = ''; state.leadsQuery.page = 0;
      // Finding a lead means every lead: all time, all channels (the bar then reads "All time", so it's clear why).
      if (v) {
        var allBtn = filtersEl.querySelector('[data-range] button[data-days="3650"]');
        if (state.days !== 3650 && allBtn) {
          state.days = 3650;
          filtersEl.querySelectorAll('[data-range] button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === allBtn)); });
          populateFilters();
        }
        state.filters.channel = '';
        var chSel = filtersEl.querySelector('select[data-filter="channel"]');
        if (chSel) { chSel.value = ''; chSel.title = ''; }
      }
      navSearchIn.value = '';
      navSearchIn.blur();
      go('leads'); // go() keeps q, resets _focus and loads the list
      state.leadsQuery._focus = true; // the list renders after the fetch, so the Leads search box gets the focus, showing the query
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('.drawer')) return;
      var a = document.activeElement;
      if (a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable)) return;
      e.preventDefault();
      if (navToggleEl && getComputedStyle(navToggleEl).display !== 'none') setNavOpen(true); // phone: the box lives in the nav sheet
      navSearchIn.focus();
    });
  }

  /** Small count on a nav item (e.g. calls waiting for an outcome on Calls & deals). */
  function setNavBadge(key, count) {
    var el = document.querySelector('[data-nav-badge="' + key + '"]');
    if (!el) return;
    count = count || 0;
    el.textContent = count > 99 ? '99+' : String(count);
    el.hidden = !count;
    el.title = count ? count + (count === 1 ? ' call needs' : ' calls need') + ' an outcome' : '';
  }

  var themeBtn = document.querySelector('[data-theme-toggle]');
  var themes = ['auto', 'light', 'dark'];
  function applyTheme(t) {
    if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
    themeBtn.textContent = 'Theme: ' + t;
    try { localStorage.setItem('admin_theme', t); } catch (e) { /* ignore */ }
  }
  var savedTheme = 'auto';
  try { savedTheme = localStorage.getItem('admin_theme') || 'auto'; } catch (e) { /* ignore */ }
  applyTheme(savedTheme);
  themeBtn.onclick = function () { applyTheme(themes[(themes.indexOf(themeBtn.textContent.replace('Theme: ', '')) + 1) % 3]); if (state.tab !== 'integrations') load(); };

  var navEl = document.querySelector('[data-nav]');
  if (navEl) navEl.addEventListener('scroll', updateNavFade, { passive: true });
  addEventListener('resize', updateNavFade);

  var resizeT;
  addEventListener('resize', function () { clearTimeout(resizeT); resizeT = setTimeout(function () { if (['overview', 'vsl', 'application'].indexOf(state.tab) !== -1) load(); }, 250); });

  fetch('/admin/api/meta', { credentials: 'same-origin' }).then(function (r) { if (r.status === 401) location.href = '/admin/login'; return r.json(); }).then(function (meta) {
    state.meta = meta;
    populateFilters();
    var h = location.hash.slice(1);
    if (h.indexOf('lead=') === 0) { routing = true; go('leads'); routing = false; openLead(decodeURIComponent(h.slice(5)), { fromRoute: true }); }
    else go(h || 'overview', { replace: true });
    lastHash = location.hash;
    markEntry();
    if (state.tab !== 'command') api('ops', {}, { noRange: true }).then(function (d) { var el = document.querySelector('[data-nav-badge="command"]'); if (el && d && d.pending) { el.textContent = d.pending > 99 ? '99+' : String(d.pending); el.hidden = false; el.title = d.pending + ' waiting for your decision'; } }).catch(function () {});
    if (state.tab !== 'overview' && state.tab !== 'sales') api('sales').then(function (d) { setNavBadge('sales', d && d.needsOutcome ? d.needsOutcome.length : 0); }).catch(function () {});
  });
})();
