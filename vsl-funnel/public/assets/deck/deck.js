/* The Acquisition Masterclass, the presented deck. One file, no libraries: reads the slides from
   <script type="application/json" id="deck-data"> (src/admin/deck-data.ts, generated from script-ai-josh.md by
   scripts/ai-webinar/present/build_deck.py) and presents them like a keynote: one idea at a time (builds), numbers
   that count up, bars that grow, needles that move, and the scenes the script calls for ([SCENE: id]).

   Views (?view=): audience (default; what is recorded or screen-shared), presenter (current slide, next build, the
   words, the NLP levers, the room cues, a timer paced against the plan), print (every slide at its final build, one
   page each, for the PDF export). Windows of the deck stay in step over BroadcastChannel "gl-deck", and Studio
   (public/assets/studio.js) listens on it to switch the face-cam layout per slide.

   Keys: Right, Down, Page Down, Space, N = next build · Left, Up, Page Up, Backspace = back · Home, End ·
   a number then Enter = go to slide · B or . = black · W or , = white · F = full screen · P = presenter view ·
   O = overview · ? = keys · Esc = close. Clickers send Page Up/Down (and B for black), so they work as they are.
   Motion runs 250 to 600 ms (counts and needles about 1 s), and none at all under prefers-reduced-motion. */
(function () {
  'use strict';
  var dataEl = document.getElementById('deck-data');
  if (!dataEl) return;
  var D = JSON.parse(dataEl.textContent);
  var SL = D.slides, N = SL.length;
  var params = new URLSearchParams(location.search);
  var VIEW = params.get('view') === 'presenter' ? 'presenter' : params.get('view') === 'print' ? 'print' : 'audience';
  var RM = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var STATIC = VIEW === 'print' || params.has('static');
  var ORIGIN = (document.body.getAttribute('data-apply-origin') || location.origin).replace(/\/+$/, '');
  var APPLY_URL = ORIGIN + D.applyPath + '?utm_source=masterclass&utm_medium=deck';
  var APPLY_SHOW = ORIGIN.replace(/^https?:\/\//, '') + D.applyPath;
  var Q = window.DeckQR;

  // ───────────── text helpers ─────────────
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  /** Typographic quotes and apostrophes, non-breaking hyphens, and no one-word last line on longer lines. */
  function typo(s) {
    var t = String(s == null ? '' : s).replace(/(^|[\s(])"/g, '$1“').replace(/"/g, '”').replace(/(^|[\s(])'/g, '$1‘').replace(/'/g, '’')
      .replace(/(\w)-(\w)/g, '$1‑$2');
    if (t.split(' ').length >= 5) t = t.replace(/ (\S{1,12})$/, ' $1');
    return esc(t);
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function B(k, fx, style) { return ' data-b="' + k + '"' + (fx ? ' data-fx="' + fx + '"' : '') + (style ? ' style="' + style + '"' : ''); }
  function E(k) { return ' data-e="' + k + '"'; }
  /** A number that counts up when it appears ("$500,000", "1.67x", "39 of 90"). */
  function cnt(str) {
    return /\d/.test(String(str)) ? '<span class="cnt" data-final="' + esc(str) + '">' + esc(str) + '</span>' : esc(str);
  }
  function isLabel(sub) { return !!sub && (/^Illustrative\b/.test(sub) && sub.length < 72 || /^Level \d$/.test(sub)); }
  function mmss(sec) { sec = Math.max(0, Math.round(sec)); var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), x = sec % 60; return (h ? h + ':' + pad(m) : m) + ':' + pad(x); }
  var CH = D.chapters;
  var LEVELS = SL.filter(function (s) { return /^Level \d$/.test(s.sub); }).map(function (s) { return s.title; });

  // ───────────── slide pieces ─────────────
  function chrome(s) {
    var label = s.layout === 'title' || (s.layout === 'section' && s.scene !== 'anchor') ? '' : pad(s.chapter) + ' · ' + CH[s.chapter - 1].title;
    if (s.scene === 'anchor') label = '';
    return '<div class="top"><span class="sc">' + esc(label) + '</span><span class="brand">' + esc(D.brand) + '</span></div><div class="toprule"></div>';
  }
  function foot(s) { return '<div class="foot"><span>' + esc(D.title) + '</span><span>' + esc(D.presenter) + '<span class="n">' + pad(s.n) + '</span></span></div>'; }
  // Each photo slot's size and the room a print keeps around it [w, h, side, top, bottom] (deck.css).
  var SLOT = { title: [920, 1080, 72, 72, 72], 'image-left': [880, 1080, 64, 72, 72], 'image-full': [1920, 760, 128, 56, 40], 'film-img': [920, 1080, 72, 72, 96], 'pf-img': [920, 1080, 72, 72, 96] };
  var SHARP = 1.35; // the most a deck original is ever enlarged: past it a photo goes soft on a 1080p screen
  function photo(im, cls, slot) {
    if (!im) return '';
    var sl = SLOT[cls || slot];
    if (im.src && im.w && im.h && sl) {
      // Fill the slot when the original is big enough; else show it as a print at a size that stays sharp.
      var cover = Math.max(sl[0] / im.w, sl[1] / im.h), cut = im.fit === 'cutout';
      if (im.fit === 'cover' && cover <= SHARP) return '<div class="img ' + (cls || '') + '"><img src="' + esc(im.src) + '" alt="' + esc(im.what) + '"></div>';
      var k = Math.min(SHARP, (sl[0] - 2 * sl[2]) / im.w, (sl[1] - sl[3] - (cut ? 0 : sl[4])) / im.h) * (im.zoom || 1); // zoom < 1: a quiet print
      return '<div class="img print' + (cut ? ' cut' : '') + ' ' + (cls || '') + '" style="padding:' + sl[3] + 'px ' + sl[2] + 'px ' + (cut ? 0 : sl[4]) + 'px"><img src="' + esc(im.src) + '" alt="' + esc(im.what) +
        '" style="width:' + Math.round(im.w * k) + 'px;height:' + Math.round(im.h * k) + 'px"></div>';
    }
    if (im.src) return '<div class="img' + (im.fit === 'contain' ? ' contain' : '') + ' ' + (cls || '') + '"><img src="' + esc(im.src) + '" alt="' + esc(im.what) + '"></div>';
    return '<div class="img ' + (cls || '') + '"><div class="ph"><div class="frame"></div><div class="sc">Photo · deck slide ' + esc(im.slide) + '</div><p>' + typo(/\d/.test(im.what) ? 'An image from Josh\u2019s deck' : im.what) + '</p><div class="note">' +
      (im.needsConsent ? 'Shows once the deck is extracted and Josh approves it' : 'Shows once the deck is extracted') + '</div></div></div>';
  }
  function take(lines, b) { return lines && lines.length ? '<div class="take"' + (b != null ? B(b) : '') + '>' + lines.map(function (o) { return '<p>' + typo(o) + '</p>'; }).join('') + '</div>' : ''; }
  function head(s, opts) {
    opts = opts || {};
    var lab = isLabel(s.sub);
    return (lab && opts.kick !== false ? '<div class="sc"' + E(0) + ' style="margin-bottom:22px">' + esc(s.sub) + '</div>' : '') +
      '<h1 class="hd bal"' + E(1) + ' data-fit="' + (opts.fit || 190) + '">' + typo(s.title) + '</h1>' +
      (s.sub && !lab ? '<p class="hdsub bal"' + E(2) + '>' + typo(s.sub) + '</p>' : '');
  }
  function svg(inner) { return '<svg class="viz" viewBox="0 0 1920 1080" aria-hidden="true">' + inner + '</svg>'; }
  function pane(x, y, w, inner, extra) { return '<div class="pane" style="left:' + x + 'px;top:' + y + 'px;width:' + w + 'px' + (extra ? ';' + extra : '') + '">' + inner + '</div>'; }

  // ───────────── layouts ─────────────
  var L = {};
  L.title = function (s) {
    return photo(s.image, '', 'title') + '<div class="c"><div class="sc kick"' + E(0) + '>' + esc(s.kicker || 'A masterclass from ' + D.brand) + '</div><h1 class="bal"' + E(1) + ' data-fit="520">' + typo(s.title) + '</h1>' +
      (s.sub ? '<p class="sub bal"' + E(2) + '>' + typo(s.sub) + '</p>' : '') + '<div class="byline"' + E(3) + '><span>' + esc(D.presenter) + '</span><span>' + esc(D.brand) + '</span></div></div>';
  };
  L.statement = function (s, o) {
    o = o || {};
    var lab = isLabel(s.sub), b = 0, h = '<div class="c">';
    if (lab || s.kicker) h += '<div class="sc kick"' + E(0) + '>' + esc(s.kicker || s.sub) + '</div>';
    var fitH = (s.sub && !lab) || s.onscreen.length ? 360 : 600;
    h += '<h1 class="bal"' + E(1) + ' data-fit="' + (o.fit || fitH) + '"' + (o.size ? ' style="font-size:' + o.size + 'px"' : '') + '>' + typo(s.title) + '</h1>';
    if (s.sub && !lab) h += '<p class="sub bal"' + B(++b) + ' data-fit="' + (s.sub.length > 160 ? 300 : 210) + '">' + typo(s.sub) + '</p>';
    if (s.onscreen.length && !o.noTake) h += take(s.onscreen, ++b);
    return h + '</div>';
  };
  L.section = function (s, o) {
    o = o || {};
    var big = s.kicker || o.noBig ? '' : '<div class="big num">' + pad(s.chapter) + '</div>';
    var label = s.kicker ? esc(s.kicker) : 'Chapter ' + pad(s.chapter) + ' · ' + esc(CH[s.chapter - 1].title);
    var lab = isLabel(s.sub);
    return big + '<div class="c"' + (o.cstyle ? ' style="' + o.cstyle + '"' : '') + '><div class="sc"' + E(0) + '>' + label + '</div><h1 class="bal"' + E(1) + ' data-fit="' + (o.fit || 400) + '"' + (o.size ? ' style="font-size:' + o.size + 'px"' : '') + '>' + typo(s.title) + '</h1>' +
      (s.sub ? '<p class="sub' + (lab ? '' : ' bal') + '"' + E(2) + '>' + typo(s.sub) + '</p>' : '') + (s.onscreen.length && !o.noTake ? '<p class="sub"' + B(1) + '>' + s.onscreen.map(typo).join(' ') + '</p>' : '') + '</div>';
  };
  L.stat = function (s) {
    var p = s.data[0], rest = s.data.slice(1);
    return '<div class="c">' + head(s) + '<div class="prim' + (rest.length ? '' : ' solo') + '"' + E(3) + '><div class="bignum num">' + cnt(p[0]) + '</div><div class="biglab bal">' + typo(p[1] || '') + '</div></div>' +
      (rest.length ? '<div class="row">' + rest.map(function (r, i) { return '<div' + B(i + 1) + '><div class="v num">' + cnt(r[0]) + '</div><div class="l">' + typo(r[1] || '') + '</div></div>'; }).join('') + '</div>' : '') +
      (s.caption ? '<p class="note foot-note"' + (rest.length ? B(rest.length) : '') + '>' + typo(s.caption) + '</p>' : '') + '</div>';
  };
  L.list = function (s) {
    var rows = s.data.slice(0, 3);
    return '<div class="c">' + head(s) + '<ol>' + rows.map(function (r, i) {
      return '<li class="' + (r[1] ? '' : 'one') + '"' + B(i + 1) + '><span class="i">' + pad(i + 1) + '</span><span class="t">' + typo(r[0]) + '</span>' + (r[1] ? '<span class="d">' + typo(r[1]) + '</span>' : '') + '</li>';
    }).join('') + '</ol>' + (s.caption ? '<p class="note foot-note"' + (/^Not\b|^It doesn/.test(s.caption) ? B(rows.length) : '') + '>' + typo(s.caption) + '</p>' : '') + '</div>';
  };
  L.comparison = function (s) {
    var d = s.data.slice(0, 2), txt = d.some(function (r) { return (r[1] || '').length > 10; }) ? ' txt' : '';
    return '<div class="c">' + head(s) + '<div class="cols">' + d.map(function (r, i) {
      return '<div class="col"' + B(i + 1) + '><div class="sc">' + esc(r[0]) + '</div><div class="v num' + txt + '">' + (txt ? typo(r[1]) : cnt(r[1])) + '</div><p class="b">' + typo(r[2] || '') + '</p></div>';
    }).join('') + '</div>' + (s.caption ? '<p class="note foot-note">' + typo(s.caption) + '</p>' : '') + '</div>';
  };
  // The owners' questions (the second pitch): each question, then on the next click the first line of the straight
  // answer, so a run of thirty questions plays as question and answer instead of thirty identical cards.
  var FAQ = SL.filter(function (s) { return s.layout === 'quote' && !s.caption && !s.sub && /^["“]/.test(s.title); });
  function faqAnswer(s) {
    var p = s.notes[1] && s.notes[1].text, ss = p ? p.match(/[^.?]+[.?](\s|$)/g) || [] : [], a = (ss[0] || '').trim();
    if (a.length < 40 && ss[1]) a = (a + ' ' + ss[1].trim()); // "Yes." alone says little: take the reason with it
    return a.length >= 12 && a.length <= 150 ? a : '';
  }
  L.quote = function (s) {
    var q = s.title.replace(/^["“]|["”]$/g, ''), i = FAQ.indexOf(s), ans = i >= 0 ? faqAnswer(s) : '';
    var by = i >= 0 ? 'Question ' + (i + 1) + ' of ' + FAQ.length : (s.caption || s.sub || 'What owners ask');
    return '<div class="c' + (ans ? ' faq' : '') + '"><div class="qm"' + E(0) + '>“</div><blockquote class="bal"' + E(1) + ' data-fit="' + (ans ? 380 : 540) + '">' + typo(q) + '”</blockquote><div class="by sc"' + E(2) + '>' + esc(by) + '</div>' +
      (ans ? '<p class="ans"' + B(1) + '>' + typo(ans) + '</p>' : '') + '</div>';
  };
  L.table = function (s) {
    var hdr = s.data[0], rows = s.data.slice(1);
    return '<div class="c">' + head(s) + '<table><thead><tr' + E(3) + '>' + hdr.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      rows.map(function (r, i) { return '<tr class="' + (i === rows.length - 1 ? 'res' : '') + '"' + B(i + 1) + '>' + r.map(function (x, j) { return '<td>' + (j ? cnt(x) : typo(x)) + '</td>'; }).join('') + '</tr>'; }).join('') +
      '</tbody></table>' + (s.caption ? '<p class="note foot-note">' + typo(s.caption) + '</p>' : '') + '</div>';
  };
  L.step = function (s) {
    var n = Number((s.title.match(/\d+/) || ['1'])[0]);
    var steps = s.data.map(function (r, i) { return [r[1] ? r[0] : 'Step ' + (i + 1), r[1] || r[0]]; });
    var track = steps.map(function (st, i) {
      var cls = i + 1 === n ? 'on2' : i + 1 < n ? 'past' : '';
      return '<div class="' + cls + '">' + (i + 1 <= n ? '<i class="bar"' + (i + 1 === n ? B(0, 'grow-x') : '') + '></i>' : '') + '<span>' + esc(st[0]) + '</span>' + esc(st[1]) + '</div>';
    }).join('');
    return '<div class="c"><div></div><div class="mid"><div class="dn num"' + E(0) + '>' + n + '</div><div class="tx"><div class="sc"' + E(1) + '>' + esc(s.kicker || 'Step ' + n + ' of ' + steps.length) + '</div><h1 class="bal"' + E(2) + ' data-fit="300">' + typo(s.sub || s.title) + '</h1>' +
      (s.caption ? '<p class="sub"' + B(1) + '>' + typo(s.caption) + '</p>' : '') + '</div></div><div class="track" style="grid-template-columns:repeat(' + steps.length + ',1fr)">' + track + '</div></div>';
  };
  L['image-left'] = function (s) {
    return photo(s.image, '', 'image-left') + '<div class="c"><h1 class="bal"' + E(1) + ' data-fit="320">' + typo(s.title) + '</h1>' + (s.sub ? '<p class="sub"' + E(2) + '>' + typo(s.sub) + '</p>' : '') + take(s.onscreen, 1) + '</div>' +
      (s.caption || s.image ? '<div class="pic">' + (s.caption ? '<b>Pictured</b> · ' + typo(s.caption) + '<br>' : '') + typo(s.image ? s.image.credit : '') + '</div>' : '');
  };
  L['image-full'] = function (s) {
    return photo(s.image, '', 'image-full') + '<div class="cap"><div><div class="sc"' + E(0) + '>' + esc(CH[s.chapter - 1].title) + '</div><h1 class="bal"' + E(1) + ' data-fit="130">' + typo(s.caption || s.onscreen[0] || s.title) + '</h1></div><div class="cr">' + typo(s.image ? s.image.credit : '') + '</div></div>';
  };
  L.offer = L.statement;

  // ───────────── scenes ─────────────
  // Each returns the slide's inner HTML; builds use data-b, stepped values data-steps ("build:value|build:value").
  var SC = {};
  var NAVY = 'var(--accent)';

  SC.anchor = function (s) {
    return '<div class="c"><div class="sc"' + E(0) + '>' + esc(s.kicker || 'The line to remember') + '</div><div class="l1"' + E(1) + '>Owners build.</div><div class="l2"' + B(1) + '>Buyers compound.</div></div>';
  };

  SC.clock = function (s) {
    var cx = 1420, cy = 560, r = 290, t = '';
    for (var i = 0; i < 60; i++) {
      var a = i * 6 * Math.PI / 180, long = i % 5 === 0, r1 = long ? r - 34 : r - 14;
      t += '<line x1="' + (cx + r1 * Math.sin(a)).toFixed(1) + '" y1="' + (cy - r1 * Math.cos(a)).toFixed(1) + '" x2="' + (cx + r * Math.sin(a)).toFixed(1) + '" y2="' + (cy - r * Math.cos(a)).toFixed(1) + '" stroke="' + (long ? '#f4f3ef' : '#4a4946') + '" stroke-width="' + (long ? 3 : 1.5) + '"/>';
    }
    var hour = (9 + 40 / 60) * 30, minute = 240;
    var hands = '<g class="rot" data-steps="0:' + (hour - 20) + 'deg|1:' + hour + 'deg" style="transform-origin:' + cx + 'px ' + cy + 'px"><line x1="' + cx + '" y1="' + (cy + 22) + '" x2="' + cx + '" y2="' + (cy - 150) + '" stroke="#f4f3ef" stroke-width="9" stroke-linecap="round"/></g>' +
      '<g class="rot" data-steps="0:' + (minute - 120) + 'deg|1:' + minute + 'deg" style="transform-origin:' + cx + 'px ' + cy + 'px"><line x1="' + cx + '" y1="' + (cy + 30) + '" x2="' + cx + '" y2="' + (cy - 240) + '" stroke="#f4f3ef" stroke-width="4" stroke-linecap="round"/></g>' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="10" fill="#f4f3ef"/>';
    return svg('<circle cx="' + cx + '" cy="' + cy + '" r="' + (r + 26) + '" fill="none" stroke="#2c2c2b" stroke-width="1.5"/>' + t + hands) +
      L.section(s, { noBig: true, size: 104, cstyle: 'right:900px', noTake: true });
  };

  SC['revenue-hours'] = function (s) {
    var d = s.data, x0 = 170, x1 = 1110, yb = 860;
    var rev = 'M' + x0 + ' ' + yb + ' C 500 ' + (yb - 40) + ', 800 ' + (yb - 90) + ', ' + x1 + ' ' + (yb - 130);
    var hrs = 'M' + x0 + ' ' + yb + ' C 520 ' + (yb - 80) + ', 820 ' + (yb - 260) + ', ' + x1 + ' ' + (yb - 470);
    var g = '<line class="axis" x1="' + x0 + '" y1="' + yb + '" x2="' + (x1 + 40) + '" y2="' + yb + '"/><line class="axis" x1="' + x0 + '" y1="' + yb + '" x2="' + x0 + '" y2="' + (yb - 520) + '"/>' +
      '<text x="' + (x1 + 40) + '" y="' + (yb + 40) + '" text-anchor="end" class="t-sc">The years</text>' +
      '<path d="' + rev + '" pathLength="1" stroke="var(--ink)" stroke-width="5" fill="none"' + B(1, 'draw') + '/>' +
      '<path d="' + hrs + '" pathLength="1" stroke="' + NAVY + '" stroke-width="7" fill="none"' + B(2, 'draw') + '/>' +
      '<g' + B(1, 'fade') + '><circle cx="' + x1 + '" cy="' + (yb - 130) + '" r="9" fill="var(--ink)"/></g><g' + B(2, 'fade') + '><circle cx="' + x1 + '" cy="' + (yb - 470) + '" r="11" fill="' + NAVY + '"/></g>';
    var side = d.map(function (r, i) {
      return '<div' + B(i + 1) + ' style="border-top:' + (i ? '3px solid var(--accent)' : '2px solid var(--ink)') + ';padding:24px 0 40px"><div class="sc">' + esc(r[0]) + '</div><div class="serif" style="font-size:84px;line-height:1;margin:16px 0 14px;color:' + (i ? NAVY : 'var(--ink)') + '">' + typo(r[1]) + '</div><div class="lab">' + typo(r[2] || '') + '</div></div>';
    }).join('');
    return svg(g) + '<div class="c top-al">' + head(s, { fit: 200 }) + '</div>' + pane(1250, 400, 542, side) + pane(128, 900, 900, '<p class="note">' + typo(s.caption || 'Illustrative.') + '</p>');
  };

  SC['one-shape'] = function (s) {
    var g = '<line class="axis" x1="1120" y1="860" x2="1792" y2="860"/>' +
      '<rect x="1430" y="560" width="44" height="300" fill="var(--ink)"' + B(0, 'grow-y') + '/>' +
      '<rect x="1180" y="492" width="544" height="68" fill="' + NAVY + '"' + B(0, 'grow-x') + '/>' +
      '<text x="1180" y="468" class="t-sc">One business</text><text x="1496" y="720" class="t-sc">One person</text>';
    return svg(g) + L.statement(s, { size: 96, fit: 330 }).replace('<div class="c">', '<div class="c" style="right:860px">');
  };

  SC['price-stack'] = function (s) {
    var d = s.data, x0 = 128, W = 1664, y = 470, h = 120, parts = [0.5, 0.3, 0.2], cols = [NAVY, 'var(--a2)', 'var(--a3)'], x = x0, g = '', labels = '';
    for (var i = 0; i < 3; i++) {
      var w = W * parts[i];
      g += '<rect x="' + x + '" y="' + y + '" width="' + (w - 6) + '" height="' + h + '" fill="' + cols[i] + '"' + B(i + 1, 'grow-x') + '/>';
      labels += pane(x, y + h + 26, w - 40, '<div class="sc" style="color:var(--ink)">' + esc(d[i][0]) + '</div><div class="lab" style="margin-top:12px;font-size:24px">' + typo(d[i][1]) + '</div>', '').replace('<div class="pane"', '<div class="pane"' + B(i + 1));
      x += w;
    }
    g += '<rect x="' + x0 + '" y="' + y + '" width="' + W + '" height="' + h + '" fill="none" stroke="var(--hair)" stroke-width="1.5"/>';
    g += '<g' + B(4, 'fade') + '><path d="M' + x0 + ' ' + (y - 34) + ' v-18 h' + (W - 6) + ' v18" fill="none" stroke="var(--ink)" stroke-width="1.5"/></g>';
    return svg(g) + '<div class="c top-al">' + head(s, { fit: 200 }) + '</div>' +
      pane(x0, y - 112, W, '<div class="sc" style="display:flex;justify-content:space-between"><span>The price of the business you buy</span><span>Proportions illustrative</span></div>', '') +
      labels + pane(x0, 820, W, '<p class="serif" style="font-size:46px;line-height:1.15;letter-spacing:-.015em">' + typo(s.onscreen[0] || s.caption || '') + '</p>', '').replace('<div class="pane"', '<div class="pane"' + B(4));
  };

  /** A coverage gauge from 0x to 3x: the passing zone from 1.5x, a needle with stepped positions. */
  function gauge(cx, cy, r, needleSteps, zoneBuild, dark) {
    var max = 3, ang = function (v) { return (-90 + v / max * 180) * Math.PI / 180; };
    var pt = function (v, rr) { return [(cx + rr * Math.sin(ang(v))).toFixed(1), (cy - rr * Math.cos(ang(v))).toFixed(1)]; };
    var a0 = pt(0, r), a1 = pt(1.5, r), a2 = pt(3, r), g = '';
    g += '<path d="M' + a0 + ' A' + r + ' ' + r + ' 0 0 1 ' + a1 + ' A' + r + ' ' + r + ' 0 0 1 ' + a2 + '" fill="none" stroke="var(--hair)" stroke-width="2"/>';
    g += '<path d="M' + a1 + ' A' + r + ' ' + r + ' 0 0 1 ' + a2 + '" pathLength="1" fill="none" stroke="' + NAVY + '" stroke-width="16"' + B(zoneBuild, 'draw') + '/>';
    [0, 0.5, 1, 1.5, 2, 2.5, 3].forEach(function (v) {
      var p1 = pt(v, r + 14), p2 = pt(v, r + (v % 1 === 0 || v === 1.5 ? 40 : 28)), pl = pt(v, r + 78);
      g += '<line x1="' + p1[0] + '" y1="' + p1[1] + '" x2="' + p2[0] + '" y2="' + p2[1] + '" stroke="' + (v === 1.5 ? NAVY : 'var(--ink3)') + '" stroke-width="' + (v === 1.5 ? 4 : 1.5) + '"/>';
      if (v % 1 === 0 || v === 1.5) g += '<text x="' + pl[0] + '" y="' + (Number(pl[1]) + 10) + '" text-anchor="middle" style="font:' + (v === 1.5 ? '600 30px' : '400 26px') + ' Inter,Arial,sans-serif;fill:' + (v === 1.5 ? NAVY : 'var(--ink3)') + '">' + v + 'x</text>';
    });
    g += '<g class="rot" data-steps="' + needleSteps + '" style="transform-origin:' + cx + 'px ' + cy + 'px"><line x1="' + cx + '" y1="' + (cy + 26) + '" x2="' + cx + '" y2="' + (cy - r + 40) + '" stroke="var(--ink)" stroke-width="6" stroke-linecap="round"/></g>' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="16" fill="var(--ink)"/>';
    return g;
  }
  function deg(v) { return (-90 + v / 3 * 180).toFixed(1) + 'deg'; }

  SC['dscr-meter'] = function (s) {
    var g = gauge(1330, 800, 400, '0:' + deg(0) + '|1:' + deg(1.5), 2);
    var frac = '<div' + E(3) + ' style="margin-top:56px;max-width:640px"><div class="serif" style="font-size:52px;line-height:1.1;padding-bottom:18px;border-bottom:2px solid var(--ink)">Yearly profit</div><div class="serif" style="font-size:52px;line-height:1.1;padding-top:18px">Yearly debt payments</div></div>' +
      '<div' + B(1) + ' style="margin-top:56px;max-width:600px"><div class="sc" style="color:var(--accent)">The test</div><div class="serif" style="font-size:44px;line-height:1.15;margin-top:12px">About 1.5x: the profit covers the payments one and a half times.</div></div>';
    return svg(g) + '<div class="c" style="right:1060px">' + head(s, { fit: 260 }) + frac + '</div>' + pane(930, 860, 800, '<p class="note" style="text-align:center"' + B(2) + '>' + typo(s.onscreen[0] || '') + '</p>');
  };

  SC['dscr-pass'] = function (s) {
    var g = gauge(1380, 790, 360, '0:' + deg(1.43) + '|1:' + deg(1.67), 0);
    var marks = pane(1100, 860, 560, '<div style="display:flex;justify-content:space-between"><span class="sc"' + B(0) + ' style="color:var(--ink2)">Illustrative · 1.43x fails</span><span class="sc"' + B(1) + ' style="color:var(--accent)">1.67x passes</span></div>');
    return svg(g) + L.statement(s, { size: 96, fit: 330 }).replace('<div class="c">', '<div class="c" style="right:900px">') + marks;
  };

  SC['deal-math'] = function (s) {
    var hdr = s.data[0], rows = s.data.slice(1);
    var table = '<table class="compact" style="margin-top:36px"><thead><tr' + E(3) + '>' + hdr.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      rows.map(function (r, i) { return '<tr class="' + (i === rows.length - 1 ? 'res' : '') + '"' + B(i + 1) + '>' + r.map(function (x, j) { return '<td>' + (j ? cnt(x) : typo(x)) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table>';
    var x0 = 900, x1 = 1792, X = function (v) { return x0 + (v - 1) * (x1 - x0); }, y = 846, k = rows.length;
    var g = '<g' + B(k, 'fade') + '><line class="axis" x1="' + x0 + '" y1="' + y + '" x2="' + x1 + '" y2="' + y + '"/>' +
      [1, 1.25, 1.5, 1.75, 2].map(function (v) { return '<line x1="' + X(v) + '" y1="' + (y - (v === 1.5 ? 44 : 10)) + '" x2="' + X(v) + '" y2="' + (y + 10) + '" stroke="' + (v === 1.5 ? NAVY : 'var(--ink3)') + '" stroke-width="' + (v === 1.5 ? 3 : 1.5) + '"/><text x="' + X(v) + '" y="' + (y + 42) + '" text-anchor="middle" style="font:400 22px Inter,Arial,sans-serif;fill:var(--ink3)">' + v + 'x</text>'; }).join('') +
      '<text x="' + X(1.5) + '" y="' + (y - 56) + '" text-anchor="middle" class="t-sc" style="fill:' + NAVY + '">The test</text></g>' +
      '<g class="slide-x" data-steps="0:0px|' + k + ':' + (X(1.43) - X(1)).toFixed(0) + 'px"><circle cx="' + X(1) + '" cy="' + y + '" r="13" fill="var(--ink3)"' + B(k, 'fade') + '/></g>' +
      '<g class="slide-x" data-steps="0:0px|' + k + ':' + (X(1.67) - X(1)).toFixed(0) + 'px"><circle cx="' + X(1) + '" cy="' + y + '" r="15" fill="' + NAVY + '"' + B(k, 'fade') + '/></g>';
    return svg(g) + '<div class="c L-table-like">' + head(s, { fit: 200 }) + table + '</div>' +
      pane(128, 820, 700, '<p class="note">' + typo(s.caption || '') + '</p>');
  };

  SC['multiple-arbitrage'] = function (s) {
    var d = s.data, x0 = 760, x1 = 1792, X = function (v) { return x0 + v / 12 * (x1 - x0); };
    var parse = function (str) { var m = String(str).match(/(\d+)\s*to\s*(\d+)/); return m ? [Number(m[1]), Number(m[2])] : [0, 0]; };
    var r1 = parse(d[0][1]), r2 = parse(d[1][1]), y1 = 440, y2 = 620, yA = 790, g = '';
    g += '<line class="axis" x1="' + x0 + '" y1="' + yA + '" x2="' + x1 + '" y2="' + yA + '"/>';
    for (var v = 0; v <= 12; v += 2) g += '<line x1="' + X(v) + '" y1="' + (yA - 8) + '" x2="' + X(v) + '" y2="' + (yA + 8) + '" stroke="var(--ink3)" stroke-width="1.5"/><text x="' + X(v) + '" y="' + (yA + 42) + '" text-anchor="middle" style="font:400 24px Inter,Arial,sans-serif;fill:var(--ink3)">' + v + 'x</text>';
    for (v = 0; v <= 12; v++) g += '<line x1="' + X(v) + '" y1="380" x2="' + X(v) + '" y2="' + (yA - 12) + '" stroke="var(--hair)" stroke-width="1" stroke-dasharray="2 8"/>';
    g += '<rect x="' + X(r1[0]) + '" y="' + (y1 - 36) + '" width="' + (X(r1[1]) - X(r1[0])) + '" height="72" fill="var(--ink)"' + B(1, 'grow-x') + '/>';
    g += '<rect x="' + X(r2[0]) + '" y="' + (y2 - 36) + '" width="' + (X(r2[1]) - X(r2[0])) + '" height="72" fill="' + NAVY + '"' + B(2, 'grow-x') + '/>';
    g += '<g' + B(3, 'fade') + '><path d="M' + X(r1[1]) + ' ' + (y2 + 70) + ' v14 H' + X(r2[0]) + ' v-14" fill="none" stroke="var(--ink)" stroke-width="2"/></g>';
    var lab = function (r, y, b, right) {
      return pane(128, y - 50, 560, '<div class="sc" style="color:var(--ink)">' + esc(r[0]) + '</div><div class="serif num" style="font-size:64px;line-height:1;margin-top:12px;color:' + (b === 2 ? NAVY : 'var(--ink)') + '">' + typo(r[1]) + ' <span style="font:400 26px Inter,Arial,sans-serif;color:var(--ink2)">' + esc(r[2] || '') + '</span></div>').replace('<div class="pane"', '<div class="pane"' + B(b));
    };
    return svg(g) + '<div class="c top-al">' + head(s, { fit: 200 }) + '</div>' + lab(d[0], y1, 1) + lab(d[1], y2, 2) +
      pane(X(r1[1]) - 60, y2 + 98, X(r2[0]) - X(r1[1]) + 120, '<p class="lab" style="text-align:center;font-size:24px">Same profit, a different multiple</p>').replace('<div class="pane"', '<div class="pane"' + B(3)) +
      pane(128, 880, 900, '<p class="note">' + typo(s.caption || 'Illustrative ranges.') + '</p>');
  };

  SC['group-value'] = function (s) {
    var rows = s.data.slice(1), x0 = 720, W = 1072, max = 0;
    rows.forEach(function (r) { max = Math.max(max, money(r[3])); });
    var g = '', panes = '';
    rows.forEach(function (r, i) {
      var y = 470 + i * 210, w = W * money(r[3]) / max;
      g += '<rect x="' + x0 + '" y="' + y + '" width="' + w + '" height="96" fill="' + (i ? NAVY : 'var(--ink)') + '"' + B(i + 1, 'grow-x') + '/>';
      panes += pane(128, y - 6, 560, '<div class="sc" style="color:var(--ink)">' + typo(r[0]) + '</div><div class="lab" style="margin-top:10px">' + esc(r[1]) + ' profit × ' + esc(r[2]) + '</div>').replace('<div class="pane"', '<div class="pane"' + B(i + 1));
      panes += pane(x0 + 28, y + 14, 300, '<div class="serif num" style="font-size:64px;line-height:1;color:#f7f6f3">' + cnt(r[3]) + '</div>').replace('<div class="pane"', '<div class="pane"' + B(i + 1));
    });
    var half = W * money(rows[0][3]) / max;
    g += '<g' + B(3, 'fade') + '><path d="M' + (x0 + half) + ' 662 v-14 H' + (x0 + W) + ' v14" fill="none" stroke="var(--ink)" stroke-width="2"/></g>';
    panes += pane(x0 + half, 598, W - half, '<p class="lab" style="text-align:center;font-size:24px">The same profit, valued as a group</p>').replace('<div class="pane"', '<div class="pane"' + B(3));
    return svg(g) + '<div class="c top-al">' + head(s, { fit: 200 }) + '</div>' + panes + pane(128, 860, 1400, '<p class="note">' + typo(s.caption || '') + '</p>');
  };
  function money(str) { var m = String(str).replace(/,/g, '').match(/([\d.]+)\s*([MK]?)/i); if (!m) return 0; return Number(m[1]) * (/m/i.test(m[2]) ? 1e6 : /k/i.test(m[2]) ? 1e3 : 1); }

  /** 90 dots, 10 a row: `fills` = [[count, build, colour, ring]] fills the first `count` dots at that build. */
  function dots(x0, y0, pitch, fills) {
    var g = '';
    for (var i = 0; i < 90; i++) {
      var cx = x0 + (i % 10) * pitch, cy = y0 + Math.floor(i / 10) * pitch;
      g += '<circle cx="' + cx + '" cy="' + cy + '" r="' + (pitch * 0.36).toFixed(1) + '" fill="var(--hair)"/>';
      fills.forEach(function (f) {
        if (i < f[0]) g += '<circle cx="' + cx + '" cy="' + cy + '" r="' + (pitch * (f[3] ? 0.15 : 0.36)).toFixed(1) + '" fill="' + f[2] + '"' + B(f[1], 'pop', 'transition-delay:' + (i * 9) + 'ms') + '/>';
      });
    }
    return g;
  }
  SC['owners-90'] = function (s) {
    var d = s.data, n0 = parseInt(d[0][0], 10) || 39;
    var g = dots(170, 400, 56, [[n0, 1, NAVY, false], [parseInt(d[1][0], 10) || 24, 2, 'var(--bg)', true]]);
    var leg = '<div' + B(1) + ' style="border-top:3px solid var(--accent);padding-top:20px"><div class="serif num" style="font-size:96px;line-height:.9;color:var(--accent)">' + cnt(d[0][0]) + '</div><div class="lab" style="margin-top:12px">' + typo(d[0][1]) + '</div></div>' +
      '<div' + B(2) + ' style="margin-top:34px;border-top:1px solid var(--hair);padding-top:20px;display:grid;grid-template-columns:60px 1fr;column-gap:18px;align-items:center"><svg viewBox="0 0 40 40" width="44" height="44"><circle cx="20" cy="20" r="19" fill="' + NAVY + '"/><circle cx="20" cy="20" r="8" fill="var(--bg)"/></svg><div><span class="serif num" style="font-size:56px;line-height:1">' + cnt(d[1][0]) + '</span> <span class="lab">' + typo(d[1][1]) + '</span></div></div>';
    var bars = d.slice(2).map(function (r, i) {
      var v = parseInt(r[0], 10) || 0;
      return '<div' + B(3 + i) + ' style="margin-top:26px"><div style="display:flex;justify-content:space-between;align-items:baseline"><span class="lab">' + typo(r[1]) + '</span><span class="serif num" style="font-size:48px">' + cnt(r[0]) + '</span></div><div style="height:12px;background:var(--hair);margin-top:10px;position:relative"><i style="position:absolute;left:0;top:0;bottom:0;width:' + (v / 90 * 100).toFixed(1) + '%;background:var(--ink)"' + B(3 + i, 'grow-x') + '></i></div></div>';
    }).join('');
    return svg(g) + '<div class="c top-al">' + head(s, { fit: 200 }) + '</div>' + pane(860, 400, 932, leg + bars) +
      pane(128, 912, 700, '<p class="note">Each dot is one owner who booked a call. Bars are out of 90.</p>');
  };
  SC['owners-63'] = function (s) {
    var d = s.data[0], n = parseInt(d[0], 10) || 63;
    var g = dots(170, 400, 60, [[n, 1, 'var(--ink3)', false]]);
    for (var i = n; i < 90; i++) g += '<circle cx="' + (170 + (i % 10) * 60) + '" cy="' + (400 + Math.floor(i / 10) * 60) + '" r="21.6" fill="' + NAVY + '"' + B(2, 'pop', 'transition-delay:' + ((i - n) * 22) + 'ms') + '/>';
    var leg = '<div' + B(1) + '><div class="serif num" style="font-size:150px;line-height:.85;letter-spacing:-.04em">' + cnt(d[0]) + '</div><div class="lab" style="margin-top:20px;max-width:760px">' + typo(d[1]) + '</div></div>' +
      '<div' + B(2) + ' style="margin-top:56px;border-top:3px solid var(--accent);padding-top:22px"><div class="serif" style="font-size:44px;line-height:1.15;color:var(--accent)">' + typo(s.caption || '') + '</div></div>';
    return svg(g) + '<div class="c top-al">' + head(s, { fit: 200 }) + '</div>' + pane(860, 400, 932, leg);
  };

  SC['seller-chair'] = function (s) {
    var tx = 1340, ty = 600, line = '#f4f3ef', dim = '#4a4946';
    var g = '<rect x="' + (tx - 250) + '" y="' + (ty - 150) + '" width="500" height="300" rx="6" fill="none" stroke="' + line + '" stroke-width="2"/>' +
      '<rect x="' + (tx - 360) + '" y="' + (ty - 60) + '" width="64" height="120" rx="6" fill="none" stroke="' + line + '" stroke-width="2"/>' +
      '<rect x="' + (tx + 296) + '" y="' + (ty - 60) + '" width="64" height="120" rx="6" fill="none" stroke="' + line + '" stroke-width="2"/>' +
      '<circle cx="' + (tx - 120) + '" cy="' + (ty - 40) + '" r="26" fill="none" stroke="' + dim + '" stroke-width="2"/><circle cx="' + (tx + 120) + '" cy="' + (ty + 40) + '" r="26" fill="none" stroke="' + dim + '" stroke-width="2"/>' +
      '<g data-until="1"><path d="M' + (tx - 296) + ' ' + ty + ' L' + (tx + 296) + ' ' + (ty - 120) + ' M' + (tx - 296) + ' ' + ty + ' L' + (tx + 296) + ' ' + (ty + 120) + '" stroke="#7d7b76" stroke-width="1.5" stroke-dasharray="6 8" fill="none"/></g>' +
      '<g' + B(1, 'fade') + '><path d="M' + (tx + 296) + ' ' + ty + ' L' + (tx - 296) + ' ' + (ty - 120) + ' M' + (tx + 296) + ' ' + ty + ' L' + (tx - 296) + ' ' + (ty + 120) + '" stroke="' + line + '" stroke-width="2" fill="none"/></g>';
    var labels = pane(tx - 420, ty + 84, 200, '<div class="sc" style="color:#b3b1ab">Dan</div>') + pane(tx + 268, ty + 84, 220, '<div class="sc" style="color:#f4f3ef">Graham</div>') +
      pane(tx - 250, ty - 230, 500, '<div class="sc" style="text-align:center;color:#7d7b76">The kitchen table, from above</div>') +
      pane(tx - 250, ty + 190, 600, '<div class="sc" style="color:#f4f3ef;margin-bottom:12px">The seller’s chair</div><div class="serif" style="font-size:36px;line-height:1.3;color:#b3b1ab">His people, his name and his money.</div>').replace('<div class="pane"', '<div class="pane"' + B(2));
    return svg(g) + L.section(s, { noBig: true, size: 100, cstyle: 'right:1000px' }) + labels;
  };

  SC['paid-twice'] = function (s) {
    var y = 760, x0 = 160, x1 = 1760, g = '<line class="axis" x1="' + x0 + '" y1="' + y + '" x2="' + x1 + '" y2="' + y + '"/>', panes = '';
    g += '<rect x="250" y="' + (y - 230) + '" width="96" height="230" fill="' + NAVY + '"' + B(1, 'grow-y') + '/>';
    for (var i = 0; i < 12; i++) g += '<rect x="' + (560 + i * 64) + '" y="' + (y - 90) + '" width="36" height="90" fill="var(--a2)"' + B(2, 'grow-y', 'transition-delay:' + (i * 60) + 'ms') + '/>';
    g += '<rect x="1560" y="' + (y - 170) + '" width="96" height="170" fill="var(--a3)"' + B(3, 'grow-y') + '/>';
    panes += pane(200, y + 24, 340, '<div class="sc" style="color:var(--ink)">At settlement</div><div class="lab" style="margin-top:10px">The lender pays</div>').replace('<div class="pane"', '<div class="pane"' + B(1));
    panes += pane(560, y + 24, 760, '<div class="sc" style="color:var(--ink)">Over time</div><div class="lab" style="margin-top:10px">The seller’s note, paid from the profit</div>').replace('<div class="pane"', '<div class="pane"' + B(2));
    panes += pane(1440, y + 24, 352, '<div class="sc" style="color:var(--ink)">Later</div><div class="lab" style="margin-top:10px">The rollover: his slice of what comes next</div>').replace('<div class="pane"', '<div class="pane"' + B(3));
    return svg(g) + '<div class="c top-al">' + head(s, { fit: 200 }) + '</div>' + panes +
      pane(128, 372, 1500, '<p class="serif" style="font-size:42px;line-height:1.2">' + typo(s.onscreen[0] || '') + '</p>').replace('<div class="pane"', '<div class="pane"' + B(4)) +
      pane(1500, 900, 292, '<p class="note" style="text-align:right">Shape only, not to scale</p>');
  };

  SC['big-domino'] = function (s) {
    var base = 880, big = { x: 930, w: 110, h: 270 }, sm = [{ x: 1290 }, { x: 1480 }, { x: 1670 }], words = ['“I don’t have the money.”', '“I don’t have the experience.”', '“My industry is different.”'];
    var nxt = SL[s.n] && SL[s.n].title === 'Watch what falls with it' ? SL[s.n].data.map(function (r) { return r[0]; }) : null;
    if (nxt && nxt.length === 3) words = nxt.map(typo);
    var h = '<div class="dom big" style="left:' + big.x + 'px;top:' + (base - big.h) + 'px;width:' + big.w + 'px;height:' + big.h + 'px" data-steps="0:0deg|1:90deg"></div>';
    sm.forEach(function (d, i) { h += '<div class="dom" style="left:' + d.x + 'px;top:' + (base - 130) + 'px;width:46px;height:130px;--d:' + (560 + i * 240) + 'ms" data-steps="0:0deg|1:90deg"></div>'; });
    var labs = sm.map(function (d, i) { return pane(d.x - 40, base + 22, 170, '<p style="font:400 19px/1.3 Inter,Arial,sans-serif;color:#b3b1ab">' + words[i] + '</p>'); }).join('') +
      pane(big.x - 20, base + 22, 220, '<p class="sc" style="color:#f4f3ef">The big one</p>');
    return '<div class="ground" style="position:absolute;left:940px;right:120px;top:' + base + 'px;height:1px;background:#2c2c2b"></div>' + h + labs +
      L.section(s, { noBig: true, size: 120, cstyle: 'right:1000px;justify-content:flex-start;padding-top:40px', noTake: true }) +
      pane(128, 640, 760, '<p class="serif" style="font-size:40px;line-height:1.25;color:#f4f3ef">' + s.onscreen.map(typo).join(' ') + '</p>').replace('<div class="pane"', '<div class="pane"' + B(2));
  };

  SC['three-c'] = function (s) {
    var names = ['Credibility', 'Capital', 'Closing'], cur = names.indexOf(s.title);
    var strip = '<div' + E(3) + ' style="display:grid;grid-template-columns:repeat(3,1fr);gap:32px;margin-top:40px">' + names.map(function (nm, i) {
      return '<div style="border-top:' + (i === cur ? '4px solid var(--accent)' : '1px solid var(--hair)') + ';padding-top:16px"><span class="sc" style="color:' + (i === cur ? 'var(--accent)' : 'var(--ink3)') + '">The ' + ['first', 'second', 'third'][i] + ' C</span><div class="serif" style="font-size:44px;margin-top:8px;color:' + (i === cur ? 'var(--ink)' : 'var(--ink3)') + '">' + nm + '</div></div>';
    }).join('') + '</div>';
    return L.list(s).replace('</p><ol>', '</p>' + strip + '<ol>').replace('</h1><ol>', '</h1>' + strip + '<ol>');
  };

  function tick() { return '<svg viewBox="0 0 36 36" aria-hidden="true"><path d="M7 19 l7 7 l15 -16" fill="none" stroke="' + NAVY + '" stroke-width="3.5" pathLength="1" stroke-dasharray="1" stroke-dashoffset="0"/></svg>'; }
  function sentences(t) { return String(t || '').match(/[^.]+\.(\s|$)/g) || [t]; }
  function receiptLeft(s) {
    return '<div class="c" style="right:1000px;justify-content:center">' + (isLabel(s.sub) ? '' : '<div class="sc"' + E(0) + ' style="margin-bottom:28px">The protection</div>') + '<h1 class="hd bal"' + E(1) + ' data-fit="330" style="font-size:96px">' + typo(s.title) + '</h1>' + (s.sub ? '<p class="hdsub bal"' + E(2) + '>' + typo(s.sub) + '</p>' : '') + '</div>';
  }
  SC.guarantee = function (s) {
    var lines = sentences(s.onscreen[0]);
    return receiptLeft(s) + '<div class="receipt" style="left:1000px;right:128px;top:210px"><div class="rh"' + E(2) + '><span class="sc" style="color:var(--ink)">The engagement guarantee</span><span class="sc">In full</span></div>' +
      lines.map(function (t, i) { return '<div class="ln serif"' + B(i + 1) + '>' + typo(t.trim()) + '</div>'; }).join('') + '</div>';
  };
  SC['guarantee-conditions'] = function (s) {
    return receiptLeft(s) + '<div class="receipt tight" style="left:1000px;right:128px;top:170px"><div class="rh"' + E(2) + '><span class="sc" style="color:var(--ink)">The conditions</span><span class="sc">All three</span></div>' +
      s.data.map(function (r, i) { return '<div class="ln tick"' + B(i + 1) + '>' + tick() + '<div><b>' + typo(r[0]) + '.</b> ' + typo(r[1]) + '</div></div>'; }).join('') +
      '<p class="fine">' + typo(s.caption || '') + '</p></div>';
  };
  SC['guarantee-seven'] = function (s) {
    var lines = sentences(s.onscreen[0]);
    return receiptLeft(s) + '<div class="receipt" style="left:1000px;right:128px;top:230px"><div class="rh"' + E(2) + '><span class="sc" style="color:var(--ink)">The first 7 days</span><span class="sc">No conditions</span></div>' +
      lines.map(function (t, i) { return '<div class="ln"' + B(i + 1) + '>' + typo(t.trim()) + '</div>'; }).join('') + '</div>' +
      '<div class="stamp" style="left:128px;top:770px"' + B(lines.length + 1, 'stamp') + '><div class="s1">7 days</div><div class="s2">Full refund</div></div>';
  };

  SC['offer-stack'] = function (s) {
    return '<div class="c top-al">' + head(s, { fit: 200 }) + '<div class="ledger">' + s.data.map(function (r, i) {
      return '<div class="row"' + B(i + 1) + '><span class="i">' + pad(i + 1) + '</span><span class="t">' + typo(r[0]) + '</span><span class="d">' + typo(r[1]) + '</span></div>';
    }).join('') + '<div class="total"' + B(s.data.length + 1) + '><span class="l">Your next step</span><span class="v">Apply and book</span></div></div></div>';
  };

  SC['apply-qr'] = function (s) {
    var rows = s.layout === 'list' && s.data.length ? s.data.slice(0, 3) : [['Apply', 'A few minutes, a few questions'], ['Book', 'If it fits, one tap'], ['Talk', 'The strategy call, on your numbers']];
    var steps = '<div class="steps3">' + rows.map(function (r, i) { return '<div' + B(i + 1) + '><div class="k">Step ' + (i + 1) + '</div><div class="t">' + typo(r[0]) + '</div><div class="d">' + typo(r[1] || '') + '</div></div>'; }).join('') + '</div>';
    var qr = Q ? Q.svg(APPLY_URL, { label: 'QR code: apply for a strategy call', dark: '#0f2c5c', light: '#f7f6f3' }) : '';
    var lab = isLabel(s.sub);
    return '<div class="c" style="right:820px"><div class="sc"' + E(0) + ' style="margin-bottom:28px;color:var(--accent)">Your next step</div><h1 class="bal"' + E(1) + ' data-fit="300" style="font-size:112px;line-height:1">' + typo(s.title) + '</h1>' +
      (s.sub && !lab ? '<p class="sub bal"' + E(2) + ' style="margin-top:28px;font-size:32px">' + typo(s.sub) + '</p>' : '') + (s.onscreen.length && s.layout !== 'list' ? '<p class="lab"' + E(3) + ' style="margin-top:22px">' + s.onscreen.map(typo).join(' ') + '</p>' : '') + steps + '</div>' +
      '<div class="qrbox"' + E(2) + '>' + qr + '<div class="cap"><span class="sc" style="color:var(--ink)">Scan to apply</span><span class="url">' + esc(APPLY_SHOW) + '</span></div></div>';
  };

  SC.poll = function (s) {
    var p = s.poll;
    if (!p) return L.statement(s);
    return L.statement(s, { size: 96, fit: 330 }).replace('<div class="c">', '<div class="c" style="right:900px">') +
      '<div class="poll"><div class="sc"' + E(2) + ' style="color:var(--accent)">Answer under the video</div><div class="q"' + E(3) + '>' + typo(p.q) + '</div>' +
      p.options.map(function (o, i) { return '<div class="opt"' + B(0, '', 'transition-delay:' + (300 + i * 90) + 'ms') + '><span class="k">' + 'ABCDE'.charAt(i) + '</span><span class="t">' + typo(o) + '</span></div>'; }).join('') + '</div>';
  };

  function timelineScene(s, nodes, allOn) {
    var y = 820, x0 = 150, x1 = 1770, step = (x1 - x0) / (nodes.length - 1), g = '', panes = '';
    g += '<line x1="' + x0 + '" y1="' + y + '" x2="' + x1 + '" y2="' + y + '" stroke="#2c2c2b" stroke-width="2"/>';
    nodes.forEach(function (nd, i) {
      var x = x0 + i * step, b = allOn ? 0 : i + 1, last = i === nodes.length - 1;
      if (i) g += '<line x1="' + (x - step) + '" y1="' + y + '" x2="' + x + '" y2="' + y + '" stroke="#f4f3ef" stroke-width="3"' + B(b, 'grow-x') + '/>';
      g += '<circle cx="' + x + '" cy="' + y + '" r="' + (last ? 14 : 10) + '" fill="' + (last ? '#111' : '#f4f3ef') + '" stroke="#f4f3ef" stroke-width="3"' + B(b, 'pop') + '/>';
      var w = 270, left = i === 0 ? x - 12 : last ? x - w + 12 : x - w / 2, align = i === 0 ? 'left' : last ? 'right' : 'center';
      panes += pane(left, y - 92, w, '<div class="sc" style="text-align:' + align + ';color:#f4f3ef">' + esc(nd[0]) + '</div>').replace('<div class="pane"', '<div class="pane"' + B(b)) +
        pane(left, y + 34, w, '<p style="text-align:' + align + ';font:400 23px/1.4 Inter,Arial,sans-serif;color:#b3b1ab">' + esc(nd[1]) + '</p>').replace('<div class="pane"', '<div class="pane"' + B(b));
    });
    return svg(g) + panes;
  }
  var DAN = [['The first week', 'A buy box, and a list of owners with no successor'], ['The first outreach', 'Owner outreach, every week, from the scripts'],
    ['The middle weeks', 'Replies, coffees, every target run at 1.5x'], ['The letter', 'A signed letter of intent, shaped with the seller first'], ['A year after', 'Two businesses, one report, a manager in each']];
  SC['dan-timeline'] = function (s) { return L.section(s, { noBig: true, size: 112, cstyle: 'justify-content:flex-start;padding-top:24px;right:420px' }) + timelineScene(s, DAN, false); };
  SC['dan-year'] = function (s) { return L.section(s, { noBig: true, size: 112, cstyle: 'justify-content:flex-start;padding-top:24px;right:420px' }) + timelineScene(s, DAN, true); };

  SC['two-paths'] = function (s) {
    var d = s.data, fx = 960, fy = 760;
    var g = '<path d="M' + fx + ' 960 L' + fx + ' ' + fy + '" stroke="var(--ink)" stroke-width="6" fill="none" pathLength="1"' + B(0, 'draw') + '/>' +
      '<line x1="190" y1="520" x2="880" y2="520" stroke="var(--ink3)" stroke-width="1.5" stroke-dasharray="4 10"' + B(1, 'fade') + '/>' +
      '<path d="M' + fx + ' ' + fy + ' C ' + (fx - 120) + ' ' + (fy - 60) + ', ' + (fx - 260) + ' 600, 500 600 L 190 600" stroke="var(--ink3)" stroke-width="6" fill="none" pathLength="1"' + B(1, 'draw') + '/>' +
      '<path d="M' + fx + ' ' + fy + ' C ' + (fx + 140) + ' ' + (fy - 80) + ', ' + (fx + 220) + ' 470, 1380 450 L 1770 420" stroke="' + NAVY + '" stroke-width="8" fill="none" pathLength="1"' + B(2, 'draw') + '/>';
    var col = function (r, x, y, b, c, align) {
      return pane(x, y, 640, '<div style="text-align:' + align + '"><div class="sc" style="color:' + c + '">' + esc(r[0]) + '</div><div class="serif" style="font-size:72px;line-height:1;margin:14px 0 12px;color:' + c + '">' + typo(r[1]) + '</div><div class="lab">' + typo(r[2] || '') + '</div></div>').replace('<div class="pane"', '<div class="pane"' + B(b));
    };
    return svg(g) + '<div class="c top-al">' + head(s, { fit: 200 }) + '</div>' + col(d[0], 160, 640, 1, 'var(--ink2)', 'left') + col(d[1], 1150, 476, 2, NAVY, 'right') +
      pane(190, 480, 600, '<p class="sc" style="color:var(--ink3)">The same ceiling</p>').replace('<div class="pane"', '<div class="pane"' + B(1));
  };

  SC['cost-of-waiting'] = function (s) {
    var d = s.data, g = '', n = 33, size = 50, gap = 12, cols = 11, x0 = 140, y0 = 470;
    for (var i = 0; i < n; i++) g += '<rect x="' + (x0 + (i % cols) * (size + gap)) + '" y="' + (y0 + Math.floor(i / cols) * (size + gap)) + '" width="' + size + '" height="' + size + '" fill="var(--ink3)"' + B(1, 'pop', 'transition-delay:' + (i * 45) + 'ms') + '/>';
    var side = Math.sqrt(n * size * size).toFixed(0);
    g += '<rect x="' + (1200) + '" y="' + (y0) + '" width="' + side + '" height="' + side + '" fill="' + NAVY + '"' + B(2, 'pop') + '/>';
    var lab = function (r, x, y, b, c) { return pane(x, y, 640, '<div class="sc" style="color:' + c + '">' + esc(r[0]) + '</div><div class="serif num" style="font-size:80px;line-height:1;margin:10px 0">' + cnt(r[1]) + '</div><div class="lab" style="font-size:24px">' + typo(r[2] || '') + '</div>').replace('<div class="pane"', '<div class="pane"' + B(b)); };
    return svg(g) + '<div class="c top-al">' + head(s, { fit: 200 }) + '</div>' + lab(d[0], 140, 690, 1, 'var(--ink2)') + lab(d[1], 1200, 770, 2, NAVY);
  };

  SC.levels = function (s) {
    var cur = (s.sub.match(/^Level (\d)$/) || [])[1] ? Number(s.sub.slice(6)) : 0, dark = s.layout === 'section';
    var x0 = 1040, y0 = 930, stepH = 96, stepW = 120, g = '', panes = '';
    LEVELS.forEach(function (nm, i) {
      var lv = i + 1, x = x0 + i * stepW, y = y0 - lv * stepH, w = 1792 - x, b = cur ? 0 : lv;
      var fill = cur ? (lv === cur ? NAVY : lv < cur ? 'var(--panel)' : 'none') : (dark ? '#1c1c1b' : 'var(--panel)');
      g += '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + (stepH - 10) + '" fill="' + fill + '" stroke="' + (lv > cur && cur ? 'var(--hair)' : 'none') + '" stroke-width="1.5"' + (cur ? (lv === cur ? B(0, 'grow-x') : '') : B(b, 'grow-x')) + '/>';
      panes += pane(x + 24, y + 24, w - 40, '<span style="font:500 24px/1.2 Inter,Arial,sans-serif;color:' + (lv === cur ? '#f7f6f3' : lv < cur || !cur ? 'var(--ink)' : 'var(--ink3)') + '"><span style="opacity:.6;margin-right:14px">' + lv + '</span>' + esc(nm) + '</span>').replace('<div class="pane"', '<div class="pane"' + (cur ? '' : B(b)));
    });
    if (dark) return svg(g) + L.section(s, { noBig: true, size: 104, cstyle: 'right:960px' }) + panes;
    var inner = '<div class="c" style="right:940px"><div class="sc kick"' + E(0) + '>Level ' + cur + ' of ' + LEVELS.length + '</div><h1 class="bal"' + E(1) + ' data-fit="330" style="font-size:100px">' + typo(s.title) + '</h1>' + take(s.onscreen, 1) + '</div>';
    return svg(g) + inner + panes;
  };

  // ───────────── desire scenes (docs/desire-doctrine.md) ─────────────
  // Pain in near-black, the wanted future in warm white: brightness carries the feeling, never a gradient or a glow.

  /** A scene told as a film still: a slug (time, place), the title, then one sensory line per click. Each earlier
      line dims as the next arrives, so the eye stays on the newest detail; the take line lands last. */
  SC.film = function (s) {
    var lines = s.data.map(function (r) { return r.join(' '); }), n = lines.length, img = s.image;
    var slug = s.kicker || (isLabel(s.sub) ? s.sub : '');
    var h = (img ? photo(img, 'film-img') : '') + '<div class="c film' + (img ? ' with-img' : '') + '">' +
      '<div class="sc slug"' + E(0) + '>' + esc(slug) + '</div>' +
      '<h1 class="ft bal"' + E(1) + '>' + typo(s.title) + '</h1>' +
      '<div class="fls" data-fit="' + (s.onscreen.length ? 520 : 640) + '">' + lines.map(function (t, i) {
        return '<p class="fl' + (i === n - 1 && !s.onscreen.length ? ' last' : '') + '"' + B(i + 1) + (i < n - 1 ? ' data-dim="' + (i + 2) + '"' : '') + '>' + typo(t) + '</p>';
      }).join('') + '</div>' +
      (s.onscreen.length ? '<p class="ftake"' + B(n + 1) + '>' + s.onscreen.map(typo).join(' ') + '</p>' : '') + '</div>';
    return h;
  };

  /** The cost made physical: one square per unit (Saturdays, reports), popping in one after another. */
  SC.tally = function (s) {
    var d = s.data, n = Math.max(1, parseInt(d[0][0], 10) || 1), cols = n > 60 ? 13 : 13, size = 52, gap = 12;
    var rows = Math.ceil(n / cols), W = cols * size + (cols - 1) * gap, x0 = 1792 - W, y0 = Math.max(250, 560 - (rows * (size + gap)) / 2), g = '';
    for (var i = 0; i < n; i++) {
      g += '<rect x="' + (x0 + (i % cols) * (size + gap)) + '" y="' + (y0 + Math.floor(i / cols) * (size + gap)) + '" width="' + size + '" height="' + size + '" fill="var(--accent)"' +
        B(1, 'pop', 'transition-delay:' + Math.round(i * Math.min(28, 1800 / n)) + 'ms') + '/>';
    }
    var left = '<div class="sc slug"' + E(0) + '>' + esc(s.kicker || (isLabel(s.sub) ? s.sub : '')) + '</div>' +
      '<h1 class="bal tl-h"' + E(1) + ' data-fit="250">' + typo(s.title) + '</h1>' +
      '<div class="tl-n"' + B(1) + '><span class="v num">' + cnt(d[0][0]) + '</span><span class="l">' + typo(d[0][1] || '') + '</span></div>' +
      d.slice(1).map(function (r, j) { return '<div class="tl-r"' + B(j + 2) + '><span class="v num">' + typo(r[0]) + '</span><span class="l">' + typo(r[1] || '') + '</span></div>'; }).join('') +
      (s.onscreen.length ? '<p class="tl-take"' + B(d.length + 1) + '>' + s.onscreen.map(typo).join(' ') + '</p>' : '');
    return svg(g) + '<div class="c tally" style="right:' + (1920 - x0 + 72) + 'px">' + left + '</div>';
  };

  /** The felt future as a day: one moment per click, hour by hour, on a hairline timeline. */
  SC.day = function (s) {
    var d = s.data, n = d.length, top = 236, bottom = 940, step = (bottom - top) / n, g = '', panes = '';
    g += '<line x1="760" y1="' + (top + 26) + '" x2="760" y2="' + (top + step * (n - 1) + 26) + '" stroke="var(--hair)" stroke-width="2"/>';
    d.forEach(function (r, i) {
      var y = top + i * step, last = i === n - 1;
      g += '<circle cx="760" cy="' + (y + 26) + '" r="' + (last ? 13 : 9) + '" fill="' + (last ? NAVY : 'var(--ink)') + '"' + B(i + 1, 'pop') + '/>';
      panes += pane(800, y, 992, '<div class="dy-row' + (last ? ' last' : '') + '"><span class="t num">' + esc(r[0]) + '</span><span class="x">' + typo(r[1] || '') + '</span></div>').replace('<div class="pane"', '<div class="pane"' + B(i + 1) + (last ? '' : ' data-dim="' + (i + 2) + '"'));
    });
    return svg(g) + '<div class="c" style="right:1240px;justify-content:center"><div class="sc slug"' + E(0) + '>' + esc(isLabel(s.sub) ? s.sub : s.kicker || '') + '</div><h1 class="bal"' + E(1) + ' data-fit="420" style="font-size:96px;line-height:1.02">' + typo(s.title) + '</h1></div>' + panes;
  };

  /** Two futures edge to edge: the first path in near-black on the left, the second in warm white on the right,
      one matched pair per click, so the gap argues by itself. */
  SC.split = function (s) {
    var hdr = s.data[0] || ['', ''], rows = s.data.slice(1), top = 400, bottom = 940, step = (bottom - top) / Math.max(1, rows.length), h = '';
    h += '<div class="sp-l"></div>';
    h += pane(128, 156, 800, '<div class="sc"' + E(0) + ' style="color:#7d7b76">' + esc(isLabel(s.sub) ? s.sub : '') + '</div><h1 class="bal sp-h"' + E(1) + '>' + typo(s.title) + '</h1>');
    h += pane(128, top - 64, 700, '<div class="sc" style="color:#b3b1ab"' + E(2) + '>' + esc(hdr[0]) + '</div>') + pane(1088, top - 64, 704, '<div class="sc" style="color:var(--accent)"' + E(2) + '>' + esc(hdr[1]) + '</div>');
    rows.forEach(function (r, i) {
      var y = top + i * step;
      h += pane(128, y, 704, '<p class="sp-x dk">' + typo(r[0]) + '</p>').replace('<div class="pane"', '<div class="pane"' + B(i + 1));
      h += pane(1088, y, 704, '<p class="sp-x">' + typo(r[1] || '') + '</p>').replace('<div class="pane"', '<div class="pane"' + B(i + 1));
      h += '<div class="sp-rule"' + B(i + 1, 'fade') + ' style="top:' + (y - 22) + 'px"></div>';
    });
    return h;
  };

  /** The identity reveal: the old sentence, struck through with a hairline, then the new one, large. */
  SC.identity = function (s) {
    var r = s.data[0] || ['', s.title];
    return '<div class="c idn"><div class="sc"' + E(0) + '>' + esc(s.kicker || '') + '</div>' +
      '<div class="old"' + E(1) + '><span>' + typo(r[0]) + '</span><i class="strike"' + B(1, 'grow-x') + '></i></div>' +
      '<div class="new"' + B(2) + '>' + typo(r[1]) + '</div>' +
      (s.sub && !isLabel(s.sub) ? '<p class="sub"' + B(2) + '>' + typo(s.sub) + '</p>' : '') + '</div>';
  };

  /** Proof joined to the claim: the checkable facts as a ledger, one per click, beside the photograph when there is one. */
  SC.proof = function (s) {
    var img = s.image, rows = s.data;
    var ledger = '<div class="pf' + (img ? ' narrow' : '') + '">' + rows.map(function (r, i) {
      return '<div class="pf-row"' + B(i + 1) + '><div class="v num">' + typo(r[0]) + '</div><div class="d">' + typo(r[1] || '') + '</div></div>';
    }).join('') + '</div>';
    var head1 = '<div class="sc slug"' + E(0) + ' style="color:var(--accent)">' + esc(s.kicker || 'What is true') + '</div><h1 class="bal pf-h"' + E(1) + ' data-fit="' + (img ? 300 : 230) + '">' + typo(s.title) + '</h1>' +
      (s.sub && !isLabel(s.sub) && !img ? '<p class="hdsub bal"' + E(2) + '>' + typo(s.sub) + '</p>' : '');
    if (img) return photo(img, 'pf-img') + '<div class="c pf-c" style="right:1000px">' + head1 + ledger + '</div>' + '<div class="pic pf-pic">' + typo(img.credit) + '</div>';
    return '<div class="c top-al">' + head1 + ledger + '</div>';
  };

  // ───────────── a slide element ─────────────
  function build(s) {
    var el = document.createElement('div');
    var scene = s.scene && SC[s.scene] ? s.scene : null;
    var dark = s.layout === 'section';
    var layout = L[s.layout] ? s.layout : 'statement';
    // A scene replaces an image layout's picture with its own visual, so it takes the plain grid.
    var cls = scene && /^image-/.test(layout) ? 'statement' : layout;
    el.className = 'slide L-' + cls + (dark ? ' dark' : '') + (s.image && (!scene || scene === 'proof' || scene === 'film') ? ' has-img' : '') + (scene ? ' scene sc-' + scene + (scene === 'anchor' ? ' anchor' : '') : '');
    el.setAttribute('data-n', s.n);
    var body = scene ? SC[scene](s) : L[layout](s);
    el.innerHTML = (layout === 'image-full' ? '' : chrome(s)) + body + foot(s);
    // A photo the deploy didn't upload (public/admin/deck-img is filled on the machine that deploys) falls back to its labelled slot.
    if (s.image) Array.prototype.forEach.call(el.querySelectorAll('.img > img'), function (i) {
      i.addEventListener('error', function () {
        var d = i.parentNode, ph = document.createElement('div');
        ph.innerHTML = photo({ id: s.image.id, what: s.image.what, slide: s.image.slide, needsConsent: s.image.needsConsent, src: null });
        d.className = d.className.replace(/\b(print|cut|contain)\b/g, ''); d.removeAttribute('style'); d.innerHTML = ph.firstChild.innerHTML;
      });
    });
    var max = 0;
    el.querySelectorAll('[data-b]').forEach(function (x) { max = Math.max(max, Number(x.getAttribute('data-b'))); });
    el.querySelectorAll('[data-steps]').forEach(function (x) { x.getAttribute('data-steps').split('|').forEach(function (p) { max = Math.max(max, Number(p.split(':')[0])); }); });
    el._steps = max;
    return el;
  }
  function steps(i) { if (!SL[i]._steps) { var tmp = build(SL[i]); SL[i]._steps = tmp._steps; } return SL[i]._steps; }
  // Precompute the build counts once (cheap: strings only), so navigation knows where each slide ends.
  SL.forEach(function (s) { var e = build(s); s._steps = e._steps; });

  function fit(el) {
    el.querySelectorAll('[data-fit]').forEach(function (x) {
      if (x.getAttribute('data-fs0') == null) x.setAttribute('data-fs0', x.style.fontSize || '');
      x.style.fontSize = x.getAttribute('data-fs0'); // a scene's own size, or the stylesheet's
      var maxH = Number(x.getAttribute('data-fit')), fs = parseFloat(getComputedStyle(x).fontSize), guard = 0;
      while (x.scrollHeight > maxH && fs > 28 && guard++ < 80) { fs -= 2; x.style.fontSize = fs + 'px'; }
    });
  }

  // Count-ups
  function parseNum(str) { var m = String(str).match(/^(.*?)(\d[\d,]*(?:\.\d+)?)(.*)$/); if (!m) return null; return { pre: m[1], num: Number(m[2].replace(/,/g, '')), dec: (m[2].split('.')[1] || '').length, comma: m[2].indexOf(',') >= 0, post: m[3] }; }
  function fmt(p, v) { var t = v.toFixed(p.dec); if (p.comma) t = t.replace(/\B(?=(\d{3})+(?!\d))/g, ','); return p.pre + t + p.post; }
  function countUp(x, animate) {
    var p = parseNum(x.getAttribute('data-final'));
    if (!p) return;
    if (!animate || RM || STATIC) { x.textContent = x.getAttribute('data-final'); return; }
    var t0 = performance.now(), dur = 1000;
    x.textContent = fmt(p, 0);
    (function tickf(now) {
      var u = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - u, 3);
      x.textContent = u >= 1 ? x.getAttribute('data-final') : fmt(p, p.num * e);
      if (u < 1 && x.isConnected) requestAnimationFrame(tickf);
    })(t0);
  }

  /** Put a slide element at build k. animate: counts run and new builds ease in; otherwise everything jumps. */
  function setBuild(el, k, animate) {
    el.querySelectorAll('[data-b]').forEach(function (x) {
      var on = Number(x.getAttribute('data-b')) <= k, was = x.classList.contains('on');
      if (on === was) return;
      x.classList.toggle('on', on);
      var cs = x.classList.contains('cnt') ? [x] : x.querySelectorAll('.cnt');
      Array.prototype.forEach.call(cs, function (c) { if (on) countUp(c, animate); });
    });
    el.querySelectorAll('[data-until]').forEach(function (x) { x.classList.toggle('gone', k >= Number(x.getAttribute('data-until'))); });
    el.querySelectorAll('[data-dim]').forEach(function (x) { x.classList.toggle('dim', k >= Number(x.getAttribute('data-dim'))); });
    el.querySelectorAll('[data-steps]').forEach(function (x) {
      var val = null;
      x.getAttribute('data-steps').split('|').forEach(function (p) { var i = p.indexOf(':'), at = Number(p.slice(0, i)); if (at <= k) val = p.slice(i + 1); });
      if (val != null) x.style.setProperty('--v', val);
    });
  }
  /** Counts that are on screen from the start (not behind a build) run when the slide arrives. */
  function arriveCounts(el, animate) {
    el.querySelectorAll('.cnt').forEach(function (c) { if (!c.closest('[data-b]')) countUp(c, animate); });
  }

  // ───────────── a stage: one slide at a time, scaled to its box ─────────────
  function Stage(box, opts) {
    this.box = box; this.opts = opts || {}; this.i = -1; this.k = 0; this.el = null;
    var st = document.createElement('div'); st.className = 'dk-stage'; box.appendChild(st); this.st = st;
    var self = this;
    if (window.ResizeObserver) new ResizeObserver(function () { self.scale(); }).observe(box);
    else window.addEventListener('resize', function () { self.scale(); });
  }
  Stage.prototype.scale = function () {
    var w = this.box.clientWidth || window.innerWidth, h = this.box.clientHeight || window.innerHeight, s = Math.min(w / 1920, h / 1080);
    this.st.querySelectorAll('.slide').forEach(function (el) { el.style.transform = 'translate(' + ((w - 1920 * s) / 2) + 'px,' + ((h - 1080 * s) / 2) + 'px) scale(' + s + ')'; });
  };
  Stage.prototype.show = function (i, k, mode) {
    // mode: 'animate' (forward, with motion), 'jump' (no motion)
    var animate = mode === 'animate' && !RM && !STATIC && !this.opts.still;
    if (i !== this.i || !this.el) {
      var el = build(SL[i]), old = this.el;
      this.st.appendChild(el); this.el = el; this.i = i; this.scale(); fit(el);
      setBuild(el, animate ? -1 : k, false);
      if (animate) {
        el.classList.add('arriving', 'enter');
        void el.offsetWidth;
        el.classList.remove('arriving');
        setBuild(el, k, true);
        arriveCounts(el, true);
        setTimeout(function () { el.classList.remove('enter'); }, 1600);
      } else arriveCounts(el, false);
      if (old) {
        if (animate) { old.classList.add('leaving'); setTimeout(function () { old.remove(); }, 450); } else old.remove();
      }
    } else setBuild(this.el, k, animate);
    this.k = k;
  };
  Stage.prototype.refit = function () { if (this.el) fit(this.el); };

  // ───────────── state, sync, keys ─────────────
  var ID = Math.random().toString(36).slice(2);
  var bc = null; try { bc = new BroadcastChannel('gl-deck'); } catch (e) { bc = null; }
  var state = { i: 0, k: 0 };
  var listeners = [];
  function store() { try { localStorage.setItem('gl-deck-pos', state.i + '.' + state.k); } catch (e) { /* private window */ } }
  function initial() {
    var h = location.hash.replace('#', ''), m = h.match(/^(\d+)(?:\.(\d+))?$/);
    if (m) return { i: Math.min(N - 1, Math.max(0, Number(m[1]) - 1)), k: Number(m[2] || 0) };
    try { var p = (localStorage.getItem('gl-deck-pos') || '').split('.'); if (p.length === 2 && p[0] !== '') return { i: Math.min(N - 1, Number(p[0]) || 0), k: Number(p[1]) || 0 }; } catch (e) { /* none */ }
    return { i: 0, k: 0 };
  }
  function post(msg) { if (bc) { msg.src = ID; try { bc.postMessage(msg); } catch (e) { /* closed */ } } }
  function go(i, k, mode, remote) {
    i = Math.max(0, Math.min(N - 1, i)); k = Math.max(0, Math.min(steps(i), k));
    state = { i: i, k: k };
    listeners.forEach(function (f) { f(i, k, mode || 'jump'); });
    if (!remote) {
      var s = SL[i];
      post({ type: 'state', i: i, k: k, n: s.n, title: s.title, cam: s.cam, chapter: s.chapter });
      store();
      try { history.replaceState(null, '', '#' + (i + 1) + (k ? '.' + k : '')); } catch (e) { /* sandboxed */ }
    }
  }
  function next() { if (state.k < steps(state.i)) go(state.i, state.k + 1, 'animate'); else if (state.i < N - 1) go(state.i + 1, 0, 'animate'); }
  function prev() { if (state.k > 0) go(state.i, state.k - 1, 'jump'); else if (state.i > 0) go(state.i - 1, steps(state.i - 1), 'jump'); }
  if (bc) bc.onmessage = function (ev) {
    var m = ev.data || {};
    if (m.src === ID) return;
    if (m.type === 'state' && typeof m.i === 'number') go(m.i, m.k, m.k === state.k + 1 || (m.k === 0 && m.i === state.i + 1) ? 'animate' : 'jump', true);
    else if (m.type === 'hello') post({ type: 'state', i: state.i, k: state.k, n: SL[state.i].n, title: SL[state.i].title, cam: SL[state.i].cam, chapter: SL[state.i].chapter });
    else if (m.type === 'blank') blank(m.mode, true);
  };

  var blankEl = null, ovEl = null, gotoEl = null, gotoBuf = '';
  function blank(mode, remote) {
    if (!blankEl) return;
    var on = mode && !(blankEl.classList.contains('on') && blankEl.classList.contains('white') === (mode === 'white'));
    blankEl.classList.toggle('on', !!on); blankEl.classList.toggle('white', mode === 'white');
    if (!remote) post({ type: 'blank', mode: on ? mode : null });
  }
  function overlay(kind) {
    if (!ovEl) return;
    if (!kind || ovEl.getAttribute('data-kind') === kind && ovEl.classList.contains('on')) { ovEl.classList.remove('on'); return; }
    ovEl.setAttribute('data-kind', kind);
    if (kind === 'help') {
      ovEl.innerHTML = '<h2>Keys</h2><dl>' + [['Right, Down, Page Down, Space', 'Next build'], ['Left, Up, Page Up, Backspace', 'Back'], ['Home, End', 'First, last slide'], ['A number, then Enter', 'Go to that slide'],
        ['B or .', 'Black screen'], ['W or ,', 'White screen'], ['F', 'Full screen'], ['P', 'Presenter view (notes, next build, timer)'], ['O', 'Overview'], ['Esc', 'Close']].map(function (r) { return '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>'; }).join('') + '</dl>';
    } else {
      var h = '<h2>' + esc(D.title) + '</h2>';
      CH.forEach(function (c) {
        h += '<div class="ch">' + pad(c.n) + ' · ' + esc(c.title) + ' · ' + esc(c.part) + '</div><div class="grid">';
        SL.forEach(function (s, i) { if (s.chapter === c.n) h += '<button type="button" data-go="' + i + '" class="' + (i === state.i ? 'cur' : '') + '"><b>' + pad(s.n) + '</b>' + esc(s.title) + '</button>'; });
        h += '</div>';
      });
      ovEl.innerHTML = h;
    }
    ovEl.classList.add('on');
  }
  function fullscreen() { var d = document; if (!d.fullscreenElement) { (d.documentElement.requestFullscreen || function () {}).call(d.documentElement); } else if (d.exitFullscreen) d.exitFullscreen(); }
  function openPresenter() { window.open(location.pathname + location.search.replace(/view=[a-z]+&?/, '') + (location.search ? '&' : '?') + 'view=presenter#' + (state.i + 1) + '.' + state.k, 'gl-deck-presenter', 'popup,width=1440,height=900'); }
  function openAudience() { window.open(location.pathname + '#' + (state.i + 1) + '.' + state.k, 'gl-deck-audience', 'popup,width=1920,height=1080'); }

  function onKey(e) {
    var t = e.target;
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var key = e.key;
    if (/^\d$/.test(key)) { gotoBuf = (gotoBuf + key).slice(-3); if (gotoEl) { gotoEl.textContent = 'Go to slide ' + gotoBuf; gotoEl.classList.add('on'); } e.preventDefault(); return; }
    if (key === 'Enter' && gotoBuf) { go(Number(gotoBuf) - 1, 0, 'jump'); gotoBuf = ''; if (gotoEl) gotoEl.classList.remove('on'); e.preventDefault(); return; }
    if (gotoBuf && key === 'Escape') { gotoBuf = ''; if (gotoEl) gotoEl.classList.remove('on'); return; }
    switch (key) {
      case 'ArrowRight': case 'ArrowDown': case 'PageDown': case 'n': case 'N': case 'Enter': next(); break;
      case ' ': if (e.shiftKey) prev(); else next(); break;
      case 'ArrowLeft': case 'ArrowUp': case 'PageUp': case 'Backspace': prev(); break;
      case 'Home': go(0, 0, 'jump'); break;
      case 'End': go(N - 1, steps(N - 1), 'jump'); break;
      case 'b': case 'B': case '.': blank('black'); break;
      case 'w': case 'W': case ',': blank('white'); break;
      case 'f': case 'F': fullscreen(); break;
      case 'p': case 'P': if (VIEW !== 'presenter') openPresenter(); break;
      case 'a': case 'A': if (VIEW === 'presenter') openAudience(); break;
      case 'o': case 'O': overlay('overview'); break;
      case '?': overlay('help'); break;
      case 'Escape': overlay(null); blank(null); break;
      default: return;
    }
    e.preventDefault();
  }

  // ───────────── views ─────────────
  var root = document.getElementById('deck');
  if (STATIC) document.body.classList.add('static');
  function chromeOverlays(box) {
    blankEl = document.createElement('div'); blankEl.className = 'dk-blank'; box.appendChild(blankEl);
    ovEl = document.createElement('div'); ovEl.className = 'dk-ov'; ovEl.setAttribute('role', 'dialog'); box.appendChild(ovEl);
    ovEl.addEventListener('click', function (e) { var b = e.target.closest('[data-go]'); if (b) { go(Number(b.getAttribute('data-go')), 0, 'jump'); overlay(null); } });
    gotoEl = document.createElement('div'); gotoEl.className = 'dk-goto'; box.appendChild(gotoEl);
  }

  if (VIEW === 'print') {
    document.body.classList.add('print', 'static');
    var holder = document.createElement('div'); holder.className = 'dk-stage'; root.appendChild(holder);
    SL.forEach(function (s, i) { var el = build(s); holder.appendChild(el); setBuild(el, steps(i), false); arriveCounts(el, false); });
    var done = function () { holder.querySelectorAll('.slide').forEach(fit); window.__deckReady = true; };
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(done); else done();
  } else if (VIEW === 'presenter') {
    document.body.classList.add('pv');
    root.innerHTML = '<div class="pv-root"><div class="pv-top"><span class="ttl">' + esc(D.title) + ' · Presenter</span><span data-part></span><span class="pace" data-pace></span>' +
      '<span class="clk" data-elapsed aria-label="Elapsed">0:00</span><button type="button" class="pv-btn" data-timer>Start timer</button><button type="button" class="pv-btn" data-reset>Reset</button>' +
      '<button type="button" class="pv-btn prim" data-aud>Open audience window</button><button type="button" class="pv-btn" data-black>Black</button><button type="button" class="pv-btn" data-help>Keys</button></div>' +
      '<div class="pv-cur"><div class="pv-frame" data-cur></div><div class="pv-meta"><span data-pos></span><span data-chap></span><span data-plan></span></div></div>' +
      '<div class="pv-side"><div class="pv-next" data-next><span class="lbl">Next</span></div><div class="pv-notes" data-notes tabindex="0" aria-label="Speaker notes"></div></div>' +
      '<div class="pv-bottom" data-chapters></div></div>';
    var $ = function (sel) { return root.querySelector(sel); };
    var cur = new Stage($('[data-cur]')), nxt = new Stage($('[data-next]'), { still: true });
    chromeOverlays($('[data-cur]'));
    var timer = { start: 0, acc: 0, running: false };
    try { var tj = JSON.parse(sessionStorage.getItem('gl-deck-timer') || 'null'); if (tj) timer = tj; } catch (e) { /* none */ }
    function elapsed() { return (timer.acc + (timer.running ? Date.now() - timer.start : 0)) / 1000; }
    function saveTimer() { try { sessionStorage.setItem('gl-deck-timer', JSON.stringify(timer)); } catch (e) { /* none */ } }
    function startStop() { if (timer.running) { timer.acc += Date.now() - timer.start; timer.running = false; } else { timer.start = Date.now(); timer.running = true; } saveTimer(); paint(); }
    $('[data-timer]').addEventListener('click', startStop);
    $('[data-reset]').addEventListener('click', function () { timer = { start: 0, acc: 0, running: false }; saveTimer(); paint(); });
    $('[data-aud]').addEventListener('click', openAudience);
    $('[data-black]').addEventListener('click', function () { blank('black'); });
    $('[data-help]').addEventListener('click', function () { overlay('help'); });
    var chapBar = $('[data-chapters]');
    chapBar.innerHTML = CH.map(function (c) { var cnt2 = SL.filter(function (s) { return s.chapter === c.n; }).length; return '<button type="button" data-ch="' + c.n + '" style="--w:' + cnt2 + '" title="' + esc(c.title) + '">' + pad(c.n) + ' ' + esc(c.title) + '</button>'; }).join('');
    chapBar.addEventListener('click', function (e) { var b = e.target.closest('[data-ch]'); if (!b) return; var n = Number(b.getAttribute('data-ch')); for (var i = 0; i < N; i++) if (SL[i].chapter === n) { go(i, 0, 'jump'); break; } });
    function paint() {
      var el = elapsed(), s = SL[state.i], plan = s.at;
      $('[data-elapsed]').textContent = mmss(el);
      $('[data-timer]').textContent = timer.running ? 'Pause timer' : (el ? 'Resume timer' : 'Start timer');
      var diff = el - plan, pace = $('[data-pace]');
      pace.textContent = el ? (Math.abs(diff) < 30 ? 'On pace' : mmss(Math.abs(diff)) + (diff > 0 ? ' behind plan' : ' ahead of plan')) : 'Plan ' + mmss(D.plannedSec);
      pace.classList.toggle('behind', el > 0 && diff > 120);
    }
    setInterval(paint, 500);
    listeners.push(function (i, k, mode) {
      if (!timer.running && !timer.acc && (i > 0 || k > 0)) startStop();
      cur.show(i, k, mode);
      var ni = i, nk = k + 1;
      if (k >= steps(i)) { ni = i + 1; nk = 0; }
      if (ni < N) nxt.show(ni, nk, 'jump'); else if (nxt.el) { nxt.el.remove(); nxt.el = null; nxt.i = -1; }
      var s = SL[i], c = CH[s.chapter - 1];
      $('[data-part]').textContent = c.part + ' · ' + pad(c.n) + ' ' + c.title;
      $('[data-pos]').innerHTML = 'Slide <b>' + s.n + '</b> of ' + N + ' · Build <b>' + k + '</b> of ' + steps(i);
      $('[data-chap]').textContent = 'Studio layout: ' + s.cam;
      $('[data-plan]').textContent = 'Planned at ' + mmss(s.at) + ' · ' + s.words + ' words';
      var notes = $('[data-notes]');
      notes.innerHTML = (s.cues.length ? '<div class="cues">' + s.cues.map(function (q) { return '<span class="cue' + (/CTA|APPLY/.test(q.id) ? ' cta' : '') + '">' + esc(q.label) + '</span>'; }).join('') + '</div>' : '') +
        s.notes.map(function (p) { return '<p class="' + (p.aiOnly ? 'ai' : '') + '">' + esc(p.text) + '</p>'; }).join('') +
        (s.levers.length ? '<div class="lev"><h3>Levers</h3><ul>' + s.levers.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul></div>' : '');
      notes.scrollTop = 0;
      chapBar.querySelectorAll('[data-ch]').forEach(function (b) { var n = Number(b.getAttribute('data-ch')); b.classList.toggle('cur', n === s.chapter); b.classList.toggle('past', n < s.chapter); });
      paint();
    });
    document.addEventListener('keydown', function (e) { if (e.key === 's' || e.key === 'S') { startStop(); e.preventDefault(); return; } onKey(e); });
    var st0 = initial(); go(st0.i, st0.k, 'jump', true);
    post({ type: 'hello' });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { cur.refit(); nxt.refit(); });
  } else {
    var stage = new Stage(root);
    chromeOverlays(root);
    listeners.push(function (i, k, mode) { stage.show(i, k, mode); });
    document.addEventListener('keydown', onKey);
    stage.st.addEventListener('click', function (e) { if (e.button === 0 && !(ovEl && ovEl.classList.contains('on'))) next(); });
    var tx0 = null;
    stage.st.addEventListener('touchstart', function (e) { tx0 = e.touches[0].clientX; }, { passive: true });
    stage.st.addEventListener('touchend', function (e) { if (tx0 == null) return; var dx = e.changedTouches[0].clientX - tx0; if (Math.abs(dx) > 40) { if (dx < 0) next(); else prev(); } tx0 = null; });
    var idle; document.addEventListener('mousemove', function () { stage.st.classList.remove('hide-cursor'); clearTimeout(idle); idle = setTimeout(function () { stage.st.classList.add('hide-cursor'); }, 2000); });
    var hint = STATIC ? null : document.createElement('div');
    if (hint) { hint.className = 'dk-hint'; hint.textContent = 'P presenter view · ? keys'; root.appendChild(hint);
    setTimeout(function () { hint.classList.add('on'); }, 300); setTimeout(function () { hint.classList.remove('on'); }, 3800); }
    var st1 = initial(); go(st1.i, st1.k, 'jump', true);
    post({ type: 'hello' });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { stage.refit(); window.__deckReady = true; }); else window.__deckReady = true;
  }
  // For the checks (scripts/ai-webinar/present/export.mjs): drive the deck and read its state.
  window.__deck = { N: N, go: function (i, k) { go(i, k, 'jump'); }, next: next, prev: prev, state: function () { return { i: state.i, k: state.k }; }, steps: steps, slides: SL };
})();
