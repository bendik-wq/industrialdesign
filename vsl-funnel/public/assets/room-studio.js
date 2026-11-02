/* Builder B "studio": the host's production studio in our room (src/rooms/studio.ts on the server).
   One scene renderer draws every scene (intro, main, slides, break, Q&A, offer, outro) and the overlays (lower
   third, logo, ticker, an on-screen chat message or question, the countdown) onto a canvas. The same renderer:
     - draws the program over the stage for everyone watching over the SFU (and the host, who sees what goes out),
     - is the room's compositor for the MoQ broadcast and the recording (room.js calls RoomStudio.composite),
   so attendees, MoQ viewers and the replay all see the same scene. Directors (the host and producers) get the
   scene bar with keyboard shortcuts, the Studio tab (overlays, slides, green room, crew), the presenter view,
   the run of show with its teleprompter and one-click cues, and the health strip. People waiting in the green
   room get their audio check and the backstage chat. Every timer uses the server clock (RoomCore.now). */
(function () {
  'use strict';
  var R = window.RoomCore;
  if (!R || !R.CFG.studio || !R.CFG.studio.on) return;
  var CFG = R.CFG, ST = CFG.studio, SC = ST.copy, B = ST.brand || {}, S = R.S, ME = R.ME;
  var esc = R.esc, h = R.h, $ = R.$, $$ = R.$$;
  var COL = Object.assign({ bg: '#0f2c5c', accent: '#c9a227', text: '#ffffff' }, B.colors || {});
  var SERIF = '"Newsreader", Georgia, "Times New Roman", serif';
  var UI = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Inter, Arial, sans-serif';
  var SCENES = ['intro', 'main', 'slides', 'brb', 'qa', 'offer', 'outro'];
  var LAYOUTS = ['solo', 'side', 'speaker_screen', 'screen', 'grid'];
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var isHost = ME.role === 'host';

  /** Copy functions arrive as templates ({a}, {b}) from the page config. */
  function fmt(x, a, b) { return typeof x === 'function' ? x(a, b) : String(x == null ? '' : x).replace(/\{a\}/g, a == null ? '' : a).replace(/\{b\}/g, b == null ? '' : b); }
  function sv() { return (S.view && S.view.studio) || null; }
  function on() { var s = sv(); return Boolean(s && s.on); }
  function direct() { var s = sv(); return Boolean(s && s.me && s.me.direct); }
  function backstage() { var s = sv(); return Boolean(R.isStaff || (s && s.me && s.me.green)); }
  function t() { return R.now(); }
  function api(path) { return CFG.api + path; }
  function slideUrl(deck, n) { return api('/studio/slide/' + deck + '/' + n + '?t=' + encodeURIComponent(CFG.ticket)); }
  function errText(e) { return (SC.errors && SC.errors[e]) || e; }
  R.on('error', function (m) { if (m && m.for && /^studio_/.test(m.for) && SC.errors[m.error]) { /* room.js already toasted the raw code: replace it */ R.toast(errText(m.error)); } });

  // ───────────── images: the logo and the slides ─────────────
  var logo = null;
  if (B.logo) { logo = new Image(); logo.src = B.logo; }
  var slides = {};
  function slide(deck, n) {
    if (!deck || n < 0 || n >= deck.pages) return null;
    var k = deck.id + ':' + n, e = slides[k];
    if (!e) {
      e = slides[k] = { img: new Image(), ok: false, err: false, at: Date.now() };
      e.img.onload = function () { e.ok = true; };
      e.img.onerror = function () { e.err = true; setTimeout(function () { if (slides[k] === e) delete slides[k]; }, 3000); };
      e.img.src = slideUrl(deck.id, n);
    }
    return e;
  }

  // ───────────── drawing helpers ─────────────
  function rr(g, x, y, w, hh, r) { r = Math.min(r, w / 2, hh / 2); g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + hh, r); g.arcTo(x + w, y + hh, x, y + hh, r); g.arcTo(x, y + hh, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  function media(g, src, sw, sh, x, y, w, hh, cover, r, bg) {
    g.save(); rr(g, x, y, w, hh, r || 0); g.clip();
    g.fillStyle = bg || '#000'; g.fillRect(x, y, w, hh);
    if (src && sw && sh) {
      var sc = cover ? Math.max(w / sw, hh / sh) : Math.min(w / sw, hh / sh), dw = sw * sc, dh = sh * sc;
      try { g.drawImage(src, x + (w - dw) / 2, y + (hh - dh) / 2, dw, dh); } catch (e) { /* not ready */ }
    }
    g.restore();
  }
  function font(weight, size, fam) { return weight + ' ' + size + 'px ' + (fam || UI); }
  function wrap(g, text, maxW, maxLines) {
    var words = String(text || '').split(/\s+/), lines = [], cur = '';
    for (var i = 0; i < words.length; i++) {
      var test = cur ? cur + ' ' + words[i] : words[i];
      if (g.measureText(test).width > maxW && cur) { lines.push(cur); cur = words[i]; if (lines.length === maxLines) break; } else cur = test;
    }
    if (lines.length < maxLines && cur) lines.push(cur);
    if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) { var l = lines[maxLines - 1]; while (l && g.measureText(l + '…').width > maxW) l = l.slice(0, -1); lines[maxLines - 1] = l + '…'; }
    return lines;
  }
  function text(g, s, x, y, f, color, align) { g.font = f; g.fillStyle = color; g.textAlign = align || 'left'; g.textBaseline = 'alphabetic'; g.fillText(s, x, y); }
  /** Digits at a fixed advance so a ticking countdown doesn't shimmer. */
  function tabular(g, s, x, y, f, color, align) {
    g.font = f; g.fillStyle = color; g.textBaseline = 'alphabetic'; g.textAlign = 'left';
    var dw = g.measureText('0').width, total = 0, i;
    for (i = 0; i < s.length; i++) total += /\d/.test(s[i]) ? dw : g.measureText(s[i]).width;
    var cx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
    for (i = 0; i < s.length; i++) { var w = /\d/.test(s[i]) ? dw : g.measureText(s[i]).width; g.fillText(s[i], cx + (w - g.measureText(s[i]).width) / 2, y); cx += w; }
  }
  function shade(hex, f) {
    var n = parseInt(String(hex).slice(1), 16), r = n >> 16 & 255, gg = n >> 8 & 255, b = n & 255;
    var m = function (c) { return Math.max(0, Math.min(255, Math.round(f < 0 ? c * (1 + f) : c + (255 - c) * f))); };
    return 'rgb(' + m(r) + ',' + m(gg) + ',' + m(b) + ')';
  }
  function backdrop(g, W, H) {
    var gr = g.createLinearGradient(0, 0, W, H); gr.addColorStop(0, COL.bg); gr.addColorStop(1, shade(COL.bg, -0.45));
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
  }
  function logoAt(g, x, y, maxW, maxH, align) {
    if (!logo || !logo.complete || !logo.naturalWidth) return false;
    var sc = Math.min(maxW / logo.naturalWidth, maxH / logo.naturalHeight), w = logo.naturalWidth * sc, hh = logo.naturalHeight * sc;
    try { g.drawImage(logo, align === 'right' ? x - w : align === 'center' ? x - w / 2 : x, y, w, hh); } catch (e) { /* not ready */ }
    return true;
  }
  function clock(ms) { return R.clock(ms); }

  // ───────────── the stage's sources (room.js tiles) ─────────────
  function vid(id) { var el = S.tiles && S.tiles[id]; var v = el && el.querySelector('video'); return v && v.srcObject && v.videoWidth ? v : null; }
  function sources() {
    var v = S.view, out = [];
    ((v && v.stage) || []).forEach(function (m) {
      if (m.green) return;
      if ((m.tracks || []).some(function (x) { return x.kind === 'screen'; })) out.push({ id: m.id + ':screen', m: m, screen: true, video: vid(m.id + ':screen') });
      out.push({ id: m.id + ':cam', m: m, screen: false, video: m.videoOff ? null : vid(m.id + ':cam') });
    });
    return out;
  }
  function cams(T) { return T.filter(function (x) { return !x.screen; }); }
  function lead(T) {
    var c = cams(T), sp = S.view && S.view.room.spotlight;
    return c.filter(function (x) { return x.m.id === sp; })[0] || c.filter(function (x) { return x.m.role === 'host'; })[0] || c[0] || null;
  }
  function tile(g, x, X, Y, W, H, o) {
    o = o || {};
    if (!x) return;
    var v = x.video;
    media(g, v, v && v.videoWidth, v && v.videoHeight, X, Y, W, H, !x.screen, o.r == null ? 14 : o.r, x.screen ? '#000' : shade(COL.bg, -0.6));
    if (!v) {
      var rad = Math.min(W, H) * 0.16;
      g.fillStyle = shade(COL.bg, 0.15); g.beginPath(); g.arc(X + W / 2, Y + H / 2, rad, 0, Math.PI * 2); g.fill();
      text(g, (x.m.name || '?').trim().charAt(0).toUpperCase(), X + W / 2, Y + H / 2 + rad * 0.36, font(600, Math.round(rad), UI), COL.text, 'center');
    }
    if (o.label !== false) {
      var lab = x.screen ? x.m.name + ' · ' + (CFG.copy.screen || 'Screen') : x.m.name, fs = W > 600 ? 18 : 13;
      g.font = font(600, fs); var tw = g.measureText(lab).width;
      g.fillStyle = 'rgba(0,0,0,.55)'; rr(g, X + 12, Y + H - fs - 26, tw + 20, fs + 14, 8); g.fill();
      text(g, lab, X + 22, Y + H - 21, font(600, fs), '#fff');
      if (x.m.audioOff && !x.screen) { g.fillStyle = '#ff453a'; g.beginPath(); g.arc(X + tw + 44, Y + H - 19 - fs / 2 + 2, 5, 0, Math.PI * 2); g.fill(); }
    }
    if (o.shadow) { g.save(); g.strokeStyle = 'rgba(255,255,255,.18)'; g.lineWidth = 2; rr(g, X, Y, W, H, o.r == null ? 14 : o.r); g.stroke(); g.restore(); }
  }

  // ───────────── scenes ─────────────
  var P = 28, G = 16;
  function sceneMain(g, W, H, s, T) {
    var screen = T.filter(function (x) { return x.screen; })[0], c = cams(T), lay = s.layout, ld = lead(T);
    if (!T.length) { centered(g, W, H, SC.introWelcome, (S.view && S.view.room.title) || CFG.room.title, null); return; }
    if ((lay === 'screen' || lay === 'speaker_screen') && screen) {
      if (lay === 'screen') { tile(g, screen, P, P, W - 2 * P, H - 2 * P); return; }
      var sw = Math.round((W - 2 * P - G) * 0.74), cw = W - 2 * P - G - sw, ch = Math.round(cw * 9 / 16);
      tile(g, screen, P, P, sw, H - 2 * P);
      [ld].concat(c.filter(function (x) { return x !== ld; })).filter(Boolean).slice(0, 3).forEach(function (x, i) { tile(g, x, P + sw + G, P + i * (ch + G), cw, ch); });
      return;
    }
    if (lay === 'side' && c.length >= 2) {
      var pair = [ld].concat(c.filter(function (x) { return x !== ld; })).slice(0, 2), w = (W - 2 * P - G) / 2, hh = w * 9 / 16, y = (H - hh) / 2;
      pair.forEach(function (x, i) { tile(g, x, P + i * (w + G), y, w, hh); });
      return;
    }
    if (lay === 'grid' && (c.length + (screen ? 1 : 0)) >= 2) {
      var list = (screen ? [screen] : []).concat(c), n = list.length, cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols);
      var cw2 = (W - 2 * P - G * (cols - 1)) / cols, chh = (H - 2 * P - G * (rows - 1)) / rows, tw2 = Math.min(cw2, chh * 16 / 9), th = tw2 * 9 / 16;
      var ox = (W - (tw2 * cols + G * (cols - 1))) / 2, oy = (H - (th * rows + G * (rows - 1))) / 2;
      list.forEach(function (x, i) { tile(g, x, ox + (i % cols) * (tw2 + G), oy + Math.floor(i / cols) * (th + G), tw2, th); });
      return;
    }
    tile(g, ld || screen, P, P, W - 2 * P, H - 2 * P);
  }
  function sceneSlides(g, W, H, s, T) {
    var e = s.deck ? slide(s.deck, s.page) : null;
    if (e && e.ok) media(g, e.img, e.img.naturalWidth, e.img.naturalHeight, P, P, W - 2 * P, H - 2 * P, false, 10, 'rgba(0,0,0,0)');
    else text(g, SC.slidesLoading, W / 2, H / 2, font(500, 26), 'rgba(255,255,255,.75)', 'center');
    if (s.slideCam) { var ld = lead(T); if (ld && ld.video) tile(g, ld, W - P - 288, H - P - 162, 288, 162, { label: false, shadow: true, r: 12 }); }
    // The next page loads in the background for the people who may see it (staff).
    if (R.isStaff && s.deck) slide(s.deck, s.page + 1);
  }
  /** A centred title card (intro, break, outro): laid out first, then drawn in the vertical middle. */
  function centered(g, W, H, eyebrow, head, lines) {
    var items = [], hasLogo = logo && logo.complete && logo.naturalWidth;
    if (hasLogo) items.push({ k: 'logo', h: 72, gap: 28 });
    if (eyebrow) items.push({ k: 'eyebrow', s: eyebrow.toUpperCase(), h: 20, gap: 22 });
    g.font = font(500, 60, SERIF);
    wrap(g, head, W - 240, 2).forEach(function (l) { items.push({ k: 'head', s: l, h: 66, gap: 6 }); });
    (lines || []).forEach(function (l) {
      if (!l) return;
      if (typeof l === 'object') { if (l.label) items.push({ k: 'label', s: l.label, h: 20, gap: 14, top: 30 }); items.push({ k: 'big', s: l.big, h: 86, gap: 10 }); return; }
      g.font = font(400, 24); wrap(g, l, W - 320, 3).forEach(function (x, i) { items.push({ k: 'note', s: x, h: 26, gap: 10, top: i ? 0 : 22 }); });
    });
    var total = items.reduce(function (a, it, i) { return a + (it.top || 0) + it.h + (i < items.length - 1 ? it.gap : 0); }, 0);
    var y = Math.max(32, (H - total) / 2);
    items.forEach(function (it) {
      y += it.top || 0;
      if (it.k === 'logo') logoAt(g, W / 2, y, 260, 72, 'center');
      else if (it.k === 'eyebrow') text(g, it.s, W / 2, y + it.h, font(600, 20), 'rgba(255,255,255,.78)', 'center');
      else if (it.k === 'head') text(g, it.s, W / 2, y + it.h - 12, font(500, 60, SERIF), COL.text, 'center');
      else if (it.k === 'label') text(g, it.s, W / 2, y + it.h, font(500, 20), 'rgba(255,255,255,.7)', 'center');
      else if (it.k === 'big') tabular(g, it.s, W / 2, y + it.h, font(600, 92), COL.text, 'center');
      else text(g, it.s, W / 2, y + it.h - 4, font(400, 24), 'rgba(255,255,255,.82)', 'center');
      y += it.h + it.gap;
    });
  }
  function sceneIntro(g, W, H, s) {
    var r = S.view ? S.view.room : CFG.room, at = r.startsAt, now = t();
    var lines = [];
    if (at && at > now) lines.push({ big: clock(at - now), label: SC.introStartsIn });
    else if (at) lines.push(SC.introStarting);
    if (B.introNote) lines.push(B.introNote);
    centered(g, W, H, at ? SC.introEyebrow : SC.introWelcome, B.introTitle || r.title || CFG.room.title, lines);
  }
  function sceneBrb(g, W, H, s) {
    var now = t(), lines = [];
    if (s.brbEndsAt && s.brbEndsAt > now) lines.push({ big: clock(s.brbEndsAt - now), label: SC.brbBack });
    centered(g, W, H, (S.view && S.view.room.title) || '', B.brbText || SC.brbHeading, lines);
  }
  function sceneOutro(g, W, H, s) {
    var o = (S.view && S.view.room.offer) || {}, now = t(), lines = [B.outroNote || SC.outroNote];
    if (o.open && o.closesAt && o.closesAt > now) lines.push({ big: clock(o.closesAt - now), label: SC.offerCloses });
    centered(g, W, H, (S.view && S.view.room.title) || '', B.outroTitle || SC.outroHeading, lines);
  }
  function card(g, x, y, w, hh) { g.save(); g.shadowColor = 'rgba(0,0,0,.25)'; g.shadowBlur = 30; g.shadowOffsetY = 10; g.fillStyle = '#fff'; rr(g, x, y, w, hh, 22); g.fill(); g.restore(); }
  function sceneQa(g, W, H, s, T) {
    var ld = lead(T), cw = 400, chh = 225;
    if (ld) tile(g, ld, W - P - cw, P, cw, chh);
    var x = P, y = P, w = W - 3 * P - cw + P - G, hh = H - 2 * P;
    card(g, x, y, w, hh);
    var hl = s.highlight, cy = y + 74;
    text(g, hl ? (hl.kind === 'question' ? SC.fromQa : SC.fromChat) : SC.qaHeading, x + 48, cy, font(600, 22), '#0f2c5c');
    if (hl) {
      g.font = font(500, 44, SERIF);
      wrap(g, hl.text, w - 96, 7).forEach(function (l) { cy += 58; text(g, l, x + 48, cy, font(500, 44, SERIF), '#1d1d1f'); });
      if (hl.name) text(g, hl.name, x + 48, cy + 56, font(600, 22), '#6e6e73');
    } else {
      g.font = font(500, 40, SERIF);
      wrap(g, SC.qaEmpty, w - 96, 4).forEach(function (l) { cy += 56; text(g, l, x + 48, cy, font(500, 40, SERIF), '#1d1d1f'); });
    }
  }
  function sceneOffer(g, W, H, s, T) {
    var ld = lead(T), o = (S.view && S.view.room.offer) || {}, now = t();
    var cw = 384, chh = 216;
    if (ld) tile(g, ld, P, P, cw, chh);
    logoAt(g, P, P + chh + 28, cw, 64, 'left');
    var x = P + cw + G + 8, y = P, w = W - x - P, hh = H - 2 * P;
    card(g, x, y, w, hh);
    var cy = y + 72;
    if (o.open) {
      if (o.label) text(g, o.label, x + 48, cy, font(600, 22), '#0f2c5c');
      g.font = font(500, 50, SERIF);
      wrap(g, B.offerHeading || SC.offerHeadingDefault, w - 96, 2).forEach(function (l) { cy += 62; text(g, l, x + 48, cy, font(500, 50, SERIF), '#1d1d1f'); });
      cy += 18;
      (B.offerPoints || []).slice(0, 5).forEach(function (p) {
        g.font = font(400, 24); var ls = wrap(g, p, w - 130, 2);
        cy += 40; g.fillStyle = COL.accent; g.beginPath(); g.arc(x + 58, cy - 8, 5, 0, Math.PI * 2); g.fill();
        ls.forEach(function (l, i) { if (i) cy += 32; text(g, l, x + 78, cy, font(400, 24), '#1d1d1f'); });
      });
      var by = y + hh - 56;
      text(g, SC.offerCta, x + 48, by, font(600, 22), '#1d1d1f');
      if (o.closesAt && o.closesAt > now) {
        text(g, SC.offerCloses, x + 48, by - 92, font(500, 20), '#6e6e73');
        tabular(g, clock(o.closesAt - now), x + 48, by - 34, font(600, 54), '#1d1d1f', 'left');
      }
      g.fillStyle = COL.accent; g.fillRect(x + 48, by + 14, 120, 4);
    } else {
      g.font = font(500, 44, SERIF);
      wrap(g, SC.offerClosed, w - 96, 3).forEach(function (l) { cy += 58; text(g, l, x + 48, cy, font(500, 44, SERIF), '#1d1d1f'); });
    }
  }

  // ───────────── overlays ─────────────
  function overlays(g, W, H, s, scene) {
    var now = t(), tickerH = 0;
    if (s.ticker && scene !== 'intro') {
      tickerH = 52;
      g.fillStyle = 'rgba(10,14,24,.86)'; g.fillRect(0, H - tickerH, W, tickerH);
      g.fillStyle = COL.accent; g.fillRect(0, H - tickerH, 6, tickerH);
      g.font = font(500, 22); var tw = g.measureText(s.ticker).width;
      g.save(); g.beginPath(); g.rect(24, H - tickerH, W - 24, tickerH); g.clip();
      if (reduced || tw < W - 60) text(g, s.ticker, 32, H - 18, font(500, 22), '#fff');
      else { var off = (performance.now() / 1000 * 110) % (tw + 160); text(g, s.ticker, W - off, H - 18, font(500, 22), '#fff'); text(g, s.ticker, W - off + tw + 160, H - 18, font(500, 22), '#fff'); }
      g.restore();
    }
    if (s.logo && scene !== 'intro' && scene !== 'brb' && scene !== 'outro' && scene !== 'offer') logoAt(g, W - 40, 34, 150, 56, 'right');
    var cd = s.countdown;
    if (cd && cd.endsAt > now && scene !== 'offer' && scene !== 'outro' && scene !== 'intro') {
      var lab = (cd.label ? cd.label + ' ' : '') + clock(cd.endsAt - now);
      g.font = font(600, 22); var w = g.measureText(lab).width + 36;
      g.fillStyle = 'rgba(10,14,24,.8)'; rr(g, 40, 34, w, 46, 23); g.fill();
      tabular(g, lab, 58, 65, font(600, 22), '#fff', 'left');
    }
    if (s.lower && (scene === 'main' || scene === 'slides' || scene === 'qa')) {
      var lx = 48, ly = H - tickerH - 150;
      g.font = font(600, 30); var nw = g.measureText(s.lower.name).width; g.font = font(400, 20); var tw2 = g.measureText(s.lower.title || '').width;
      var bw = Math.max(nw, tw2) + 56;
      g.fillStyle = 'rgba(10,14,24,.82)'; rr(g, lx, ly, bw, s.lower.title ? 96 : 66, 12); g.fill();
      g.fillStyle = COL.accent; g.fillRect(lx, ly + 14, 5, (s.lower.title ? 96 : 66) - 28);
      text(g, s.lower.name, lx + 28, ly + 44, font(600, 30), '#fff');
      if (s.lower.title) text(g, s.lower.title, lx + 28, ly + 76, font(400, 20), 'rgba(255,255,255,.8)');
    }
    if (s.highlight && (scene === 'main' || scene === 'slides')) {
      var hw = Math.min(820, W - 160), hx = (W - hw) / 2;
      g.font = font(500, 26); var hl = wrap(g, s.highlight.text, hw - 64, 3);
      var hh2 = 84 + hl.length * 34, hy = H - tickerH - hh2 - (s.lower ? 170 : 36);
      card(g, hx, hy, hw, hh2);
      text(g, (s.highlight.kind === 'question' ? SC.fromQa : SC.fromChat) + (s.highlight.name ? ' · ' + s.highlight.name : ''), hx + 32, hy + 42, font(600, 18), '#0f2c5c');
      hl.forEach(function (l, i) { text(g, l, hx + 32, hy + 82 + i * 34, font(500, 26), '#1d1d1f'); });
    }
  }

  // ───────────── the program: one frame of the current scene ─────────────
  var lastScene = null, sceneChangedAt = 0;
  function effectiveScene(s) {
    var r = S.view && S.view.room;
    // Before Go live the audience sees the intro whatever the host is preparing backstage.
    if (r && r.status === 'lobby' && !backstage()) return 'intro';
    return SCENES.indexOf(s.scene) >= 0 ? s.scene : 'main';
  }
  function frame(g, W, H) {
    var s = sv(); if (!s) return;
    var scene = effectiveScene(s), T = sources();
    if (scene !== lastScene) { lastScene = scene; sceneChangedAt = performance.now(); }
    backdrop(g, W, H);
    // The ticker takes the bottom band: scenes lay out above it.
    var H2 = s.ticker && scene !== 'intro' ? H - 52 : H;
    if (scene === 'intro') sceneIntro(g, W, H, s);
    else if (scene === 'slides') sceneSlides(g, W, H2, s, T);
    else if (scene === 'brb') sceneBrb(g, W, H2, s);
    else if (scene === 'qa') sceneQa(g, W, H2, s, T);
    else if (scene === 'offer') sceneOffer(g, W, H2, s, T);
    else if (scene === 'outro') sceneOutro(g, W, H2, s);
    else sceneMain(g, W, H2, s, T);
    overlays(g, W, H, s, scene);
    // A short fade between scenes (none with reduced motion).
    var k = reduced ? 1 : Math.min(1, (performance.now() - sceneChangedAt) / 220);
    if (k < 1) { g.globalAlpha = 1 - k; g.fillStyle = COL.bg; g.fillRect(0, 0, W, H); g.globalAlpha = 1; }
  }

  /** room.js's compositor (MoQ broadcast and recording) asks for each frame here while the studio is on. */
  window.RoomStudio = {
    composite: function (g, W, H) { if (!on()) return false; frame(g, W, H); return true; },
  };

  // ───────────── the program over the stage (SFU viewers and the team) ─────────────
  var prog = null, live = null, raf = 0, lastDraw = 0;
  function ensureProgram() {
    var wrapEl = $('.rm-stagewrap'); if (!wrapEl) return null;
    if (prog && prog.el.parentNode === wrapEl) return prog;
    var el = h('div', { class: 'rs-program', role: 'img', 'aria-label': fmt(SC.sceneLabel, SC.scenes.main) });
    var c = h('canvas', { 'aria-hidden': 'true' });
    el.appendChild(c);
    live = h('p', { class: 'rs-sr', 'aria-live': 'polite' });
    el.appendChild(live);
    var mute = h('button', { type: 'button', class: 'rs-music', hidden: '' }, esc(SC.music));
    mute.onclick = function () { musicMuted = !musicMuted; if (music) music.muted = musicMuted || isHost; mute.setAttribute('aria-pressed', String(!musicMuted)); };
    wrapEl.insertBefore(el, wrapEl.firstChild);
    var old = $('.rs-music', wrapEl); if (old) old.remove();
    wrapEl.insertBefore(mute, el.nextSibling);
    prog = { el: el, canvas: c, g: c.getContext('2d'), mute: mute };
    return prog;
  }
  function programVisible() {
    var stageEl = $('[data-stage]');
    return on() && stageEl && !R.moqPlaying() && !stageEl.classList.contains('rm-stage--moq');
  }
  function loop(ts) {
    raf = requestAnimationFrame(loop);
    if (document.hidden || ts - lastDraw < 33) return;
    lastDraw = ts;
    var stageEl = $('[data-stage]'), p = ensureProgram();
    if (!p || !stageEl) return;
    var show = programVisible();
    var wrapEl = p.el.parentNode;
    wrapEl.classList.toggle('rs-on', show);
    p.el.hidden = !show;
    if (!show) { p.mute.hidden = true; return; }
    // Cover the stage box exactly (16:9; the lobby box is taller, so the scene sits centred in it).
    var x = stageEl.offsetLeft, y = stageEl.offsetTop, w = stageEl.offsetWidth, hh = stageEl.offsetHeight;
    var s = p.el.style; if (s.left !== x + 'px') s.left = x + 'px'; if (s.top !== y + 'px') s.top = y + 'px'; if (s.width !== w + 'px') s.width = w + 'px'; if (s.height !== hh + 'px') s.height = hh + 'px';
    var dpr = Math.min(2, window.devicePixelRatio || 1), cw = Math.max(2, Math.round(w * dpr)), ch = Math.max(2, Math.round(hh * dpr));
    if (p.canvas.width !== cw || p.canvas.height !== ch) { p.canvas.width = cw; p.canvas.height = ch; }
    var g = p.g, sc = Math.min(cw / 1280, ch / 720);
    g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = COL.bg; g.fillRect(0, 0, cw, ch);
    g.setTransform(sc, 0, 0, sc, (cw - 1280 * sc) / 2, (ch - 720 * sc) / 2);
    frame(g, 1280, 720);
  }
  /** What a screen reader hears: the scene and the overlays' words (not the ticking numbers). */
  var lastSpoken = '';
  function speak() {
    if (!prog || !live) return;
    var s = sv(); if (!s) return;
    var scene = effectiveScene(s);
    prog.el.setAttribute('aria-label', fmt(SC.sceneLabel, SC.scenes[scene] || scene));
    var bits = [];
    if (scene === 'slides' && s.deck) bits.push(s.deck.title + ', ' + (s.page + 1) + ' / ' + s.deck.pages);
    if (s.lower && (scene === 'main' || scene === 'slides' || scene === 'qa')) bits.push(s.lower.name + (s.lower.title ? ', ' + s.lower.title : ''));
    if (s.highlight) bits.push((s.highlight.kind === 'question' ? SC.fromQa : SC.fromChat) + ': ' + s.highlight.text);
    if (s.ticker) bits.push(s.ticker);
    var line = bits.join('. ');
    if (line !== lastSpoken) { lastSpoken = line; live.textContent = line; }
  }

  // ───────────── intro music ─────────────
  var music = null, musicMuted = false;
  function syncMusic() {
    var s = sv();
    var want = Boolean(s && s.on && B.music && s.music && effectiveScene(s) === 'intro' && !R.moqPlaying() && !S.ended);
    if (prog) prog.mute.hidden = !(want && !isHost);
    if (want && !music) {
      music = new Audio(B.music); music.loop = true; music.volume = 0.35; music.preload = 'auto';
      // The host's copy is silent here (no echo into the mic); the compositor mixes it into the broadcast and recording.
      music.muted = isHost || musicMuted;
      music.play().catch(function () { /* needs a tap: the Enter button usually counted */ });
      if (isHost) music.addEventListener('playing', feedMusic);
    }
    if (!want && music) { var m = music; music = null; try { m.pause(); m.src = ''; } catch (e) { /* gone */ } }
    if (isHost && music) feedMusic();
  }
  var fedTrack = null;
  function feedMusic() {
    var comp = R.compositor(); if (!comp || !music) return;
    try {
      var st = music.captureStream ? music.captureStream() : music.mozCaptureStream ? music.mozCaptureStream() : null;
      var tr = st && st.getAudioTracks()[0];
      if (tr && tr !== fedTrack) { fedTrack = tr; comp.addAudio(tr); }
    } catch (e) { /* not capturable in this browser */ }
  }

  // ───────────── directors: the scene bar and keyboard shortcuts ─────────────
  function sceneBar() {
    var wrapEl = $('.rm-stagewrap'); if (!wrapEl) return;
    var bar = $('[data-rs-bar]');
    if (!direct() || !on()) { if (bar) bar.remove(); return; }
    if (!bar) { bar = h('div', { class: 'rs-bar', 'data-rs-bar': '', role: 'toolbar', 'aria-label': SC.scenesHeading }); var stg = $('[data-stage]', wrapEl); wrapEl.insertBefore(bar, stg ? stg.nextSibling : null); }
    var s = sv(), html = '<div class="rs-scenes">';
    SCENES.forEach(function (k, i) {
      var off = k === 'slides' && !s.deck;
      html += '<button type="button" class="rs-scene' + (s.scene === k ? ' is-on' : '') + '" data-rs-scene="' + k + '" aria-pressed="' + (s.scene === k) + '"' + (off ? ' disabled' : '') + '><kbd>' + (i + 1) + '</kbd><span>' + esc(SC.scenes[k]) + '</span>' + (s.scene === k ? '<i class="rs-air">' + esc(SC.onAir) + '</i>' : '') + '</button>';
    });
    html += '</div><div class="rs-sub">';
    if (s.scene === 'main') html += '<div class="rs-seg" role="group" aria-label="' + esc(SC.layoutHeading) + '">' + LAYOUTS.map(function (l, i) { return '<button type="button" data-rs-layout="' + l + '" aria-pressed="' + (s.layout === l) + '" title="Shift+' + (i + 1) + '">' + esc(SC.layouts[l]) + '</button>'; }).join('') + '</div>';
    if (s.scene === 'slides' && s.deck) html += '<div class="rs-seg"><button type="button" data-rs-page="-1" aria-label="' + esc(SC.prev) + '">‹</button><span class="rs-pg">' + (s.page + 1) + ' / ' + s.deck.pages + '</span><button type="button" data-rs-page="1" aria-label="' + esc(SC.nextBtn) + '">›</button></div><button type="button" class="rs-chip" data-rs-presenter>' + esc(SC.presenter) + '</button>';
    html += '<button type="button" class="rs-chip" data-rs-q="lower" aria-pressed="' + Boolean(s.lower) + '">' + esc(SC.lowerThird) + ' <kbd>L</kbd></button>' +
      '<button type="button" class="rs-chip" data-rs-q="ticker" aria-pressed="' + Boolean(s.ticker) + '"' + (s.tickerDraft ? '' : ' disabled') + '>' + esc(SC.ticker) + ' <kbd>T</kbd></button>' +
      (B.logo ? '<button type="button" class="rs-chip" data-rs-q="logo" aria-pressed="' + Boolean(s.logo) + '">' + esc(SC.logoBug) + '</button>' : '') +
      '<button type="button" class="rs-chip" data-rs-ros>' + esc(SC.rosHeading) + '</button></div>';
    if (bar.getAttribute('data-html') !== html) {
      bar.setAttribute('data-html', html); bar.innerHTML = html;
      $$('[data-rs-scene]', bar).forEach(function (b) { b.onclick = function () { setScene(b.getAttribute('data-rs-scene')); }; });
      $$('[data-rs-layout]', bar).forEach(function (b) { b.onclick = function () { R.send({ t: 'studio_layout', layout: b.getAttribute('data-rs-layout') }); }; });
      $$('[data-rs-page]', bar).forEach(function (b) { b.onclick = function () { R.send({ t: 'studio_page', delta: Number(b.getAttribute('data-rs-page')) }); }; });
      var pr = $('[data-rs-presenter]', bar); if (pr) pr.onclick = openPresenter;
      $('[data-rs-ros]', bar).onclick = openRos;
      $$('[data-rs-q]', bar).forEach(function (b) { b.onclick = function () { quick(b.getAttribute('data-rs-q')); }; });
    }
  }
  function setScene(k) { if (k === 'slides' && !(sv() && sv().deck)) { R.toast(SC.errors.no_deck); return; } R.send({ t: 'studio_scene', scene: k }); }
  function quick(k) {
    var s = sv(); if (!s) return;
    if (k === 'lower') R.send({ t: 'studio_lower', on: !s.lower });
    if (k === 'ticker') R.send({ t: 'studio_ticker', on: !s.ticker });
    if (k === 'logo') R.send({ t: 'studio_logo', on: !s.logo });
  }
  document.addEventListener('keydown', function (e) {
    if (!direct() || !on() || e.ctrlKey || e.metaKey || e.altKey) return;
    var a = document.activeElement, tag = a && a.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (a && a.isContentEditable)) return;
    var digit = /^Digit([1-7])$/.exec(e.code || '');
    if (digit && e.shiftKey) { var l = LAYOUTS[Number(digit[1]) - 1]; if (l) { R.send({ t: 'studio_layout', layout: l }); e.preventDefault(); } return; }
    if (digit) { setScene(SCENES[Number(digit[1]) - 1]); e.preventDefault(); return; }
    var s = sv();
    if ((e.key === 'ArrowRight' || e.key === 'PageDown') && s.deck && (s.scene === 'slides' || presenterOpen())) { R.send({ t: 'studio_page', delta: 1 }); e.preventDefault(); }
    else if ((e.key === 'ArrowLeft' || e.key === 'PageUp') && s.deck && (s.scene === 'slides' || presenterOpen())) { R.send({ t: 'studio_page', delta: -1 }); e.preventDefault(); }
    else if (e.key === 'l' || e.key === 'L') quick('lower');
    else if (e.key === 't' || e.key === 'T') { if (s.tickerDraft) quick('ticker'); }
    else if (e.key === 'Escape') { closeOverlays(); }
  });

  // ───────────── the Studio tab (staff) ─────────────
  function injectTab() {
    if (!R.isStaff) return;
    var nav = $('[data-tabs]'); if (!nav || $('[data-tab="studio"]', nav)) return;
    var b = h('button', { type: 'button', role: 'tab', 'data-tab': 'studio' }, esc(SC.tab) + '<span class="rm-badge" data-badge="studio" hidden></span>');
    var host = $('[data-tab="host"]', nav); nav.insertBefore(b, host || null);
    b.onclick = function () { S.tab = 'studio'; R.renderTabs(); renderTab(true); };
  }
  var tabKey = '';
  function renderTab(force) {
    if (S.tab !== 'studio') return;
    var p = $('[data-panel]'); if (!p || !S.view) return;
    var s = sv(); if (!s) { p.innerHTML = '<p class="rm-note">' + esc(SC.errors.not_applicable) + '</p>'; return; }
    // Redraw only when what the tab shows changed, so typing in its fields survives the room's updates.
    var key = JSON.stringify([s.me, s.lowerDraft, s.tickerDraft, s.ticker, s.lower, s.logo, s.countdownKind, s.countdown, s.brbEndsAt, s.music, s.deck, s.page, s.slideCam, s.green, s.crew, (S.view.people || []).filter(function (x) { return x.role === 'cohost'; }).map(function (x) { return x.id + x.name; }), decks.list && decks.list.map(function (d) { return d.id + d.status; }), up.busy, up.msg, s.highlight, (s.back || []).length, S.view.room.offer && S.view.room.offer.open]);
    if (!force && key === tabKey && $('[data-rs-tab]', p)) { renderBack(); syncGreenMedia(); return; }
    tabKey = key;
    var saved = {}; $$('[data-rs-tab] input, [data-rs-tab] textarea', p).forEach(function (e) { if (e.name) saved[e.name] = e.value; });
    var a = document.activeElement, focusName = a && p.contains(a) && a.name ? a.name : null;
    var d = direct(), dis = d ? '' : ' disabled';
    var html = '<div class="rs-tab" data-rs-tab>';
    if (!d) html += '<p class="rm-note">' + esc(SC.errors.forbidden) + '</p>';
    // Overlays
    html += '<section class="rs-sec"><h3 class="rm-h3">' + esc(SC.overlaysHeading) + '</h3>' +
      '<div class="rs-row"><label class="rm-field"><span>' + esc(SC.lowerName) + '</span><input name="lname" maxlength="60" value="' + esc(s.lowerDraft.name) + '"' + dis + '></label><label class="rm-field"><span>' + esc(SC.lowerTitle) + '</span><input name="ltitle" maxlength="60" value="' + esc(s.lowerDraft.title) + '"' + dis + '></label></div>' +
      '<div class="rs-row"><button type="button" class="rm-btn" data-rs-lower' + dis + '>' + esc((s.lower ? SC.hide : SC.show) + ' · ' + SC.lowerThird) + '</button>' + (B.logo ? '<button type="button" class="rm-btn" data-rs-logo' + dis + '>' + esc((s.logo ? SC.hide : SC.show) + ' · ' + SC.logoBug) + '</button>' : '') + '</div>' +
      '<label class="rm-field"><span>' + esc(SC.tickerText) + '</span><input name="ticker" maxlength="160" value="' + esc(s.tickerDraft) + '"' + dis + '></label>' +
      '<div class="rs-row"><button type="button" class="rm-btn" data-rs-ticker' + dis + '>' + esc((s.ticker ? SC.hide : SC.show) + ' · ' + SC.ticker) + '</button></div>' +
      (s.highlight ? '<div class="rs-hl"><p class="rm-eyebrow">' + esc(SC.highlight) + '</p><p>' + esc(s.highlight.text) + '</p><button type="button" class="rm-btn" data-rs-hlclear' + dis + '>' + esc(SC.highlightClear) + '</button></div>' : '') +
      '<h4 class="rs-h4">' + esc(SC.countdown) + '</h4><div class="rs-row">' +
      '<button type="button" class="rm-btn" data-rs-cdoffer' + dis + (S.view.room.offer && S.view.room.offer.open && S.view.room.offer.closesAt ? '' : ' disabled') + ' aria-pressed="' + (s.countdownKind === 'offer') + '">' + esc(SC.countdownOffer) + '</button>' +
      '<label class="rm-field rm-inline"><span>' + esc(SC.countdownMinutes) + '</span><input name="cdmin" type="number" min="1" max="240" value="5"' + dis + '></label>' +
      '<input class="rm-input" name="cdlabel" maxlength="60" placeholder="' + esc(SC.countdownLabel) + '"' + dis + '>' +
      '<button type="button" class="rm-btn" data-rs-cdstart' + dis + '>' + esc(SC.countdownStart) + '</button>' +
      (s.countdownKind ? '<button type="button" class="rm-btn" data-rs-cdclear' + dis + '>' + esc(SC.countdownClear) + '</button>' : '') + '</div>' +
      '<h4 class="rs-h4">' + esc(SC.brbTimer) + '</h4><div class="rs-row"><label class="rm-field rm-inline"><span>' + esc(SC.countdownMinutes) + '</span><input name="brbmin" type="number" min="1" max="60" value="5"' + dis + '></label><button type="button" class="rm-btn" data-rs-brb' + dis + '>' + esc(SC.countdownStart) + '</button>' + (s.brbEndsAt ? '<button type="button" class="rm-btn" data-rs-brbclear' + dis + '>' + esc(SC.countdownClear) + '</button>' : '') + '</div>' +
      '<div class="rs-row">' + (B.music ? '<button type="button" class="rm-btn" data-rs-music aria-pressed="' + Boolean(s.music) + '"' + dis + '>' + esc((s.music ? SC.hide : SC.show) + ' · ' + SC.music) + '</button>' : '<p class="rm-note">' + esc(SC.musicNone) + '</p>') + '</div></section>';
    // Slides
    html += '<section class="rs-sec"><h3 class="rm-h3">' + esc(SC.slidesHeading) + '</h3><p class="rm-note">' + esc(SC.uploadHelp) + '</p>' +
      '<div class="rs-row"><label class="rm-btn rs-file"' + (up.busy || !d ? ' aria-disabled="true"' : '') + '><input type="file" accept="application/pdf,image/png,image/jpeg,image/webp" multiple data-rs-upload' + (up.busy || !d ? ' disabled' : '') + '>' + esc(SC.upload) + '</label>' + (s.deck ? '<button type="button" class="rm-btn" data-rs-presenter2>' + esc(SC.presenter) + '</button>' : '') + '</div>' +
      (up.msg ? '<p class="rm-note" role="status">' + esc(up.msg) + '</p>' : '') +
      (decks.list && decks.list.length ? '<ul class="rs-decks">' + decks.list.map(function (k) { var cur = s.deck && s.deck.id === k.id; return '<li><span>' + esc(k.title) + ' <span class="rm-fine">' + k.pages + '</span></span>' + (k.status === 'ready' ? '<button type="button" class="rm-mini" data-rs-deck="' + esc(k.id) + '"' + dis + (cur ? ' aria-pressed="true"' : '') + '>' + esc(SC.pickDeck) + '</button>' : '') + '</li>'; }).join('') + '</ul>' : '<p class="rm-note">' + esc(decks.storage === false ? SC.noStorage : SC.noDecks) + '</p>') +
      (s.deck ? '<label class="rs-check"><input type="checkbox" data-rs-slidecam' + (s.slideCam ? ' checked' : '') + dis + '> ' + esc(SC.slideCam) + '</label>' : '') + '</section>';
    // Green room
    var green = s.green || [];
    html += '<section class="rs-sec"><h3 class="rm-h3">' + esc(SC.greenHeading) + '</h3>' +
      (green.length ? '<ul class="rs-green">' + green.map(function (x) { return '<li data-rs-gm="' + esc(x.id) + '"><div class="rs-gv"><video playsinline autoplay muted></video></div><div class="rs-gi"><strong>' + esc(x.name) + '</strong><span class="rm-fine">' + esc(x.ready ? SC.greenChecked : SC.greenWaiting) + '</span></div><button type="button" class="rm-mini" data-rs-on="' + esc(x.id) + '"' + dis + '>' + esc(SC.bringOn) + '</button></li>'; }).join('') + '</ul>' : '<p class="rm-note">' + esc(SC.greenEmpty) + '</p>');
    var onStage = (S.view.stage || []).filter(function (m) { return !m.green && m.role !== 'host' && m.id !== ME.id; });
    if (onStage.length) html += '<ul class="rs-people">' + onStage.map(function (m) { return '<li><span>' + esc(m.name) + '</span><button type="button" class="rm-mini" data-rs-back="' + esc(m.id) + '"' + dis + '>' + esc(SC.sendBack) + '</button></li>'; }).join('') + '</ul>';
    html += '<h4 class="rs-h4">' + esc(SC.backChat) + '</h4><ol class="rs-backlist" data-rs-backlist></ol><form class="rm-form" data-rs-backform><input name="back" maxlength="300" autocomplete="off" placeholder="' + esc(SC.backChatPlaceholder) + '" aria-label="' + esc(SC.backChatPlaceholder) + '"><button type="submit" class="rm-send">' + esc(CFG.copy.send) + '</button></form><p class="rm-fine">' + esc(SC.backChatNote) + '</p></section>';
    // Crew (host): producers
    var cohosts = (S.view.people || []).filter(function (x) { return x.role === 'cohost'; });
    if (isHost && cohosts.length) html += '<section class="rs-sec"><h3 class="rm-h3">' + esc(SC.producer) + '</h3><ul class="rs-people">' + cohosts.map(function (x) { var pr = (s.crew || []).indexOf(x.id) >= 0; return '<li><span>' + esc(x.name) + (pr ? ' <span class="rm-role">' + esc(SC.producer) + '</span>' : '') + '</span><button type="button" class="rm-mini" data-rs-crew="' + esc(x.id) + '" data-on="' + (!pr) + '">' + esc(pr ? SC.unmakeProducer : SC.makeProducer) + '</button></li>'; }).join('') + '</ul></section>';
    html += '<section class="rs-sec"><p class="rm-fine">' + esc(SC.shortcuts) + '</p></section></div>';
    p.innerHTML = html;
    $$('input, textarea', p).forEach(function (e) { if (e.name && saved[e.name] != null && e.type !== 'checkbox') e.value = saved[e.name]; if (focusName && e.name === focusName) e.focus(); });
    var on2 = function (sel, fn) { var e = $(sel, p); if (e) e.onclick = fn; };
    var val = function (n) { var e = $('[name="' + n + '"]', p); return e ? e.value : ''; };
    on2('[data-rs-lower]', function () { R.send({ t: 'studio_lower', name: val('lname'), title: val('ltitle'), on: !s.lower }); });
    on2('[data-rs-logo]', function () { R.send({ t: 'studio_logo', on: !s.logo }); });
    on2('[data-rs-ticker]', function () { R.send({ t: 'studio_ticker', text: val('ticker'), on: !s.ticker }); });
    on2('[data-rs-hlclear]', function () { R.send({ t: 'studio_highlight', kind: null }); });
    on2('[data-rs-cdoffer]', function () { R.send({ t: 'studio_countdown', kind: s.countdownKind === 'offer' ? null : 'offer' }); });
    on2('[data-rs-cdstart]', function () { R.send({ t: 'studio_countdown', kind: 'custom', sec: Math.round(Number(val('cdmin')) * 60), label: val('cdlabel') }); });
    on2('[data-rs-cdclear]', function () { R.send({ t: 'studio_countdown', kind: null }); });
    on2('[data-rs-brb]', function () { R.send({ t: 'studio_brb', sec: Math.round(Number(val('brbmin')) * 60) }); });
    on2('[data-rs-brbclear]', function () { R.send({ t: 'studio_brb', sec: null }); });
    on2('[data-rs-music]', function () { R.send({ t: 'studio_music', on: !s.music }); });
    on2('[data-rs-presenter2]', openPresenter);
    var sc2 = $('[data-rs-slidecam]', p); if (sc2) sc2.onchange = function () { R.send({ t: 'studio_slidecam', on: sc2.checked }); };
    var upl = $('[data-rs-upload]', p); if (upl) upl.onchange = function () { if (upl.files && upl.files.length) upload(Array.prototype.slice.call(upl.files)); upl.value = ''; };
    $$('[data-rs-deck]', p).forEach(function (b) { b.onclick = function () { var k = decks.list.filter(function (x) { return x.id === b.getAttribute('data-rs-deck'); })[0]; if (k) R.send({ t: 'studio_deck', deck: { id: k.id, title: k.title, pages: k.pages } }); }; });
    $$('[data-rs-on]', p).forEach(function (b) { b.onclick = function () { R.send({ t: 'studio_green', id: b.getAttribute('data-rs-on'), on: false }); }; });
    $$('[data-rs-back]', p).forEach(function (b) { b.onclick = function () { R.send({ t: 'studio_green', id: b.getAttribute('data-rs-back'), on: true }); }; });
    $$('[data-rs-crew]', p).forEach(function (b) { b.onclick = function () { R.send({ t: 'studio_crew', id: b.getAttribute('data-rs-crew'), producer: b.getAttribute('data-on') === 'true' }); }; });
    var bf = $('[data-rs-backform]', p); if (bf) bf.onsubmit = function (e) { e.preventDefault(); var v = bf.back.value.trim(); if (v) R.send({ t: 'studio_back', text: v }); bf.back.value = ''; };
    renderBack(); syncGreenMedia();
  }
  /** The backstage chat list (the tab and the green room card share it). */
  function renderBack() {
    var s = sv(); if (!s) return;
    $$('[data-rs-backlist]').forEach(function (list) {
      var msgs = s.back || backMsgs;
      var html = msgs.map(function (m) { return '<li' + (m.by === ME.id ? ' class="is-mine"' : '') + '><strong>' + esc(m.name) + '</strong> ' + esc(m.text) + '</li>'; }).join('');
      if (list.getAttribute('data-n') !== String(msgs.length)) { list.innerHTML = html; list.setAttribute('data-n', String(msgs.length)); list.scrollTop = list.scrollHeight; }
    });
  }
  var backMsgs = [];
  R.on('studio_back', function (m) {
    var s = sv(); if (s && s.back && !s.back.some(function (x) { return x.id === m.m.id; })) s.back.push(m.m);
    if (!(s && s.back)) backMsgs.push(m.m);
    renderBack();
    if (m.m.by !== ME.id && S.tab !== 'studio' && R.isStaff) { var b = $('[data-badge="studio"]'); if (b) { b.hidden = false; b.textContent = '•'; } }
  });

  /** Staff see and hear the green room in the Studio tab (their tracks are pulled by room.js like any stage track). */
  var greenAudio = {};
  function syncGreenMedia() {
    var want = {};
    ((S.view && S.view.stage) || []).forEach(function (m) {
      if (!m.green || m.id === ME.id || !R.isStaff) return;
      (m.tracks || []).forEach(function (tr) {
        var p = S.pulls[tr.trackName]; if (!p || !p.track) return;
        if (tr.kind === 'video') { var li = $('[data-rs-gm="' + m.id + '"] video'); if (li && (!li.srcObject || li.srcObject.getVideoTracks()[0] !== p.track)) { li.srcObject = new MediaStream([p.track]); li.play().catch(function () {}); } }
        if (tr.kind === 'audio') {
          want[tr.trackName] = true;
          var a = greenAudio[tr.trackName];
          if (!a) { a = greenAudio[tr.trackName] = h('audio', { autoplay: '' }); a.style.display = 'none'; document.body.appendChild(a); if (S.devices.speaker && a.setSinkId) a.setSinkId(S.devices.speaker).catch(function () {}); }
          if (!a.srcObject || a.srcObject.getAudioTracks()[0] !== p.track) { a.srcObject = new MediaStream([p.track]); a.play().catch(function () {}); }
        }
      });
    });
    Object.keys(greenAudio).forEach(function (k) { if (!want[k]) { greenAudio[k].srcObject = null; greenAudio[k].remove(); delete greenAudio[k]; } });
  }

  // ───────────── slides: upload (PDF through pdf.js, pinned and checked) ─────────────
  var decks = { list: null, storage: null, loading: false };
  var up = { busy: false, msg: '' };
  function loadDecks() {
    if (!R.isStaff || decks.loading) return Promise.resolve();
    decks.loading = true;
    return R.post('/studio/decks').then(function (d) { decks.loading = false; if (d && d.ok) { decks.list = d.decks; decks.storage = d.storage; renderTab(); } }).catch(function () { decks.loading = false; });
  }
  var pdfjs = null;
  function b64(buf) { var s = '', a = new Uint8Array(buf); for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); }
  function loadPdfjs() {
    if (pdfjs) return pdfjs;
    var P2 = ST.pdfjs;
    if (!P2) return Promise.reject(new Error('pdfjs'));
    pdfjs = new Promise(function (res, rej) {
      var sc = document.createElement('script'); sc.src = P2.src; sc.integrity = P2.integrity; sc.crossOrigin = 'anonymous'; sc.referrerPolicy = 'no-referrer';
      sc.onload = function () { res(window.pdfjsLib); }; sc.onerror = function () { rej(new Error('pdfjs')); };
      document.head.appendChild(sc);
    }).then(function (lib) {
      if (!lib) throw new Error('pdfjs');
      // The worker is fetched, checked against its pinned hash, then run from a blob (the CDN can't run workers for this page).
      return fetch(P2.worker, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' }).then(function (r) { return r.arrayBuffer(); }).then(function (buf) {
        return crypto.subtle.digest('SHA-384', buf).then(function (d) {
          if ('sha384-' + b64(d) !== P2.workerIntegrity) throw new Error('pdfjs worker integrity');
          lib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([buf], { type: 'text/javascript' }));
          return lib;
        });
      });
    });
    pdfjs.catch(function () { pdfjs = null; });
    return pdfjs;
  }
  function toBlob(canvas) {
    return new Promise(function (res) { canvas.toBlob(function (b) { if (b && b.type === 'image/webp') res(b); else canvas.toBlob(function (b2) { res(b2); }, 'image/png'); }, 'image/webp', 0.92); });
  }
  function upload(files) {
    if (up.busy) return;
    var pdf = files.filter(function (f) { return f.type === 'application/pdf' || /\.pdf$/i.test(f.name); })[0];
    var imgs = files.filter(function (f) { return /^image\/(png|jpeg|webp)$/.test(f.type); }).sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true }); });
    if (!pdf && !imgs.length) return;
    up.busy = true; up.msg = fmt(SC.uploading, '1', '…'); renderTab(true);
    var title = (pdf ? pdf.name : imgs[0].name).replace(/\.[a-z0-9]+$/i, '').slice(0, 120);
    var renderPage;
    var start = pdf
      ? loadPdfjs().then(function (lib) { return pdf.arrayBuffer().then(function (buf) { return lib.getDocument({ data: buf, isEvalSupported: false }).promise; }); }).then(function (doc) {
        renderPage = function (i) {
          return doc.getPage(i + 1).then(function (page) {
            var vp0 = page.getViewport({ scale: 1 }), scale = Math.min(3, 1920 / vp0.width), vp = page.getViewport({ scale: scale });
            var c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
            var g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
            return page.render({ canvasContext: g, viewport: vp }).promise.then(function () { return toBlob(c); });
          });
        };
        return doc.numPages;
      }, function () { throw new Error(SC.pdfFailed); })
      : Promise.resolve().then(function () {
        renderPage = function (i) {
          return createImageBitmap(imgs[i]).then(function (bm) {
            var sc = Math.min(1, 1920 / bm.width), c = document.createElement('canvas'); c.width = Math.round(bm.width * sc); c.height = Math.round(bm.height * sc);
            c.getContext('2d').drawImage(bm, 0, 0, c.width, c.height); return toBlob(c);
          });
        };
        return imgs.length;
      });
    var deckId = null, pages = 0;
    start.then(function (n) {
      pages = Math.min(300, n);
      return R.post('/studio/deck', { title: title, pages: pages });
    }).then(function (r) {
      if (!r || !r.ok) throw new Error((r && r.error) || SC.uploadFailed);
      deckId = r.id;
      var chain = Promise.resolve();
      for (var i = 0; i < pages; i++) (function (i) {
        chain = chain.then(function () {
          up.msg = fmt(SC.uploading, String(i + 1), String(pages)); renderTab(true);
          return renderPage(i).then(function (blob) {
            return fetch(api('/studio/deck/' + deckId + '/' + i + '?t=' + encodeURIComponent(CFG.ticket)), { method: 'PUT', body: blob, headers: { 'content-type': blob.type }, credentials: 'same-origin' }).then(function (x) { return x.json(); }).then(function (j) { if (!j.ok) throw new Error(j.error || SC.uploadFailed); });
          });
        });
      })(i);
      return chain;
    }).then(function () {
      return R.post('/studio/deck/' + deckId + '/done', { notes: [] });
    }).then(function (r) {
      up.busy = false; up.msg = SC.uploaded;
      if (r && r.ok && r.deck) R.send({ t: 'studio_deck', deck: { id: r.deck.id, title: r.deck.title, pages: r.deck.pages } });
      return loadDecks();
    }).catch(function (e) { up.busy = false; up.msg = (e && e.message) || SC.uploadFailed; renderTab(true); });
  }

  // ───────────── the presenter view (current and next slide, notes, timers) ─────────────
  var pres = null;
  function presenterOpen() { return Boolean(pres); }
  function openPresenter() {
    var s = sv(); if (!s || !s.deck) { R.toast(SC.errors.no_deck); return; }
    if (pres) return;
    if (!decks.list) loadDecks();
    var el = h('div', { class: 'rs-pres', role: 'dialog', 'aria-modal': 'true', 'aria-label': SC.presenter });
    el.innerHTML = '<header class="rs-pres-h"><strong data-p-title></strong><span class="rs-pres-t"><span>' + esc(SC.onSlide) + ' <b data-p-on></b></span><span>' + esc(SC.sinceLive) + ' <b data-p-live></b></span></span><button type="button" class="rm-btn" data-p-close>' + esc(SC.close) + '</button></header>' +
      '<div class="rs-pres-b"><figure class="rs-pres-cur"><figcaption>' + esc(SC.current) + ' <span data-p-n></span></figcaption><img alt="" data-p-cur></figure>' +
      '<aside class="rs-pres-side"><figure class="rs-pres-next"><figcaption>' + esc(SC.next) + '</figcaption><img alt="" data-p-next><p class="rm-note" data-p-last hidden>' + esc(SC.last) + '</p></figure>' +
      '<label class="rm-field rs-pres-notes"><span>' + esc(SC.notes) + '</span><textarea data-p-notes rows="8"></textarea></label><button type="button" class="rm-btn" data-p-save>' + esc(SC.notesSave) + '</button></aside></div>' +
      '<footer class="rs-pres-f"><button type="button" class="rm-btn" data-p-prev>‹ ' + esc(SC.prev) + '</button><button type="button" class="rm-primary" data-p-nextbtn>' + esc(SC.nextBtn) + ' ›</button></footer>';
    document.body.appendChild(el);
    pres = { el: el, page: -1, deck: null, at: R.now(), notes: null };
    $('[data-p-close]', el).onclick = closePresenter;
    $('[data-p-prev]', el).onclick = function () { R.send({ t: 'studio_page', delta: -1 }); };
    $('[data-p-nextbtn]', el).onclick = function () { R.send({ t: 'studio_page', delta: 1 }); };
    $('[data-p-save]', el).onclick = function () {
      var s2 = sv(); if (!s2 || !s2.deck || !pres.notes) return;
      pres.notes[s2.page] = $('[data-p-notes]', el).value;
      R.post('/studio/deck/' + s2.deck.id + '/notes', { notes: pres.notes }).then(function (r) { R.toast(r && r.ok ? SC.notesSaved : SC.uploadFailed); });
    };
    $('[data-p-nextbtn]', el).focus();
    syncPresenter();
  }
  function closePresenter() { if (pres) { pres.el.remove(); pres = null; } }
  setInterval(function () {
    if (!pres || !S.view) return;
    var on2 = $('[data-p-on]', pres.el), lv = $('[data-p-live]', pres.el), wl = S.view.room.wentLiveAt;
    if (on2) on2.textContent = R.clock(R.now() - pres.at);
    if (lv) lv.textContent = wl ? R.clock(R.now() - wl) : '–';
  }, 1000);
  function syncPresenter() {
    if (!pres) return;
    var s = sv(); if (!s || !s.deck) { closePresenter(); return; }
    var el = pres.el;
    if (pres.deck !== s.deck.id || pres.page !== s.page) {
      if (pres.page !== s.page) pres.at = R.now();
      pres.deck = s.deck.id; pres.page = s.page;
      $('[data-p-title]', el).textContent = s.deck.title;
      $('[data-p-n]', el).textContent = (s.page + 1) + ' / ' + s.deck.pages;
      $('[data-p-cur]', el).src = slideUrl(s.deck.id, s.page);
      var hasNext = s.page + 1 < s.deck.pages, nx = $('[data-p-next]', el);
      nx.hidden = !hasNext; $('[data-p-last]', el).hidden = hasNext;
      if (hasNext) nx.src = slideUrl(s.deck.id, s.page + 1);
      var k = decks.list && decks.list.filter(function (d) { return d.id === s.deck.id; })[0];
      pres.notes = k ? (k.notes || []).slice() : [];
      while (pres.notes.length < s.deck.pages) pres.notes.push('');
      $('[data-p-notes]', el).value = pres.notes[s.page] || '';
    }
  }
  function closeOverlays() { closePresenter(); closeRos(); }

  // ───────────── run of show and teleprompter ─────────────
  var ros = null, rosData = null, rosLoading = null;
  var done = {};
  try { done = JSON.parse(sessionStorage.getItem('rs-cues-' + CFG.room.id) || '{}') || {}; } catch (e) { done = {}; }
  function saveDone() { try { sessionStorage.setItem('rs-cues-' + CFG.room.id, JSON.stringify(done)); } catch (e) { /* private mode */ } }
  function loadRos() {
    if (rosData) return Promise.resolve(rosData);
    if (rosLoading) return rosLoading;
    rosLoading = R.post('/studio/script').then(function (d) { rosLoading = null; rosData = d && d.ok ? d : { sections: [], error: (d && d.error) || SC.rosNoScript }; return rosData; }).catch(function () { rosLoading = null; return { sections: [], error: SC.rosNoScript }; });
    return rosLoading;
  }
  var prompt = { size: 34, mirror: false, speed: 0, at: 0 };
  try { var ps = JSON.parse(localStorage.getItem('rs-prompter') || 'null'); if (ps) { prompt.size = ps.size || 34; prompt.mirror = Boolean(ps.mirror); } } catch (e) { /* none */ }
  function savePrompt() { try { localStorage.setItem('rs-prompter', JSON.stringify({ size: prompt.size, mirror: prompt.mirror })); } catch (e) { /* private mode */ } }
  function openRos() {
    if (ros) { closeRos(); return; }
    var el = h('div', { class: 'rs-ros', role: 'dialog', 'aria-label': SC.rosHeading });
    el.innerHTML = '<p class="rm-note">…</p>';
    document.body.appendChild(el);
    ros = { el: el, shown: -2 };
    loadRos().then(function () { if (ros) drawRos(true); });
  }
  function closeRos() { if (ros) { ros.el.remove(); ros = null; } }
  function curSection() { var s = sv(); return s && s.ros ? s.ros.section : -1; }
  function stdCues() {
    var e = (S.view && S.view.eng && S.view.eng.avail) || {};
    var list = [];
    if (e.application) list.push({ label: SC.cueApplication, cue: 'push:application' });
    if (S.view && S.view.room.offer && S.view.room.offer.available) list.push({ label: S.view.room.offer.open ? SC.cueCloseOffer : SC.cueOpenOffer, cue: S.view.room.offer.open ? 'offer:close' : 'offer:open' });
    if (e.deposit) list.push({ label: SC.cueDeposit, cue: 'push:deposit' });
    if (e.sprint) list.push({ label: SC.cueSprint, cue: 'push:sprint' });
    list.push({ label: SC.cueQa, cue: 'scene:qa' });
    return list;
  }
  function cueBtn(c, key) {
    var isDone = key && done[key];
    if (!c.cue) return '<span class="rs-note">' + esc(c.label) + '</span>';
    return '<button type="button" class="rs-cue' + (isDone ? ' is-done' : '') + '" data-cue="' + esc(c.cue) + '"' + (key ? ' data-key="' + esc(key) + '"' : '') + (c.text ? ' data-text="' + esc(c.text) + '"' : '') + (c.preset ? ' data-preset="' + esc(c.preset) + '"' : '') + '>' + esc(c.label) + (c.text ? '<small>' + esc(c.text) + '</small>' : '') + (isDone ? ' <span class="rs-tick">' + esc(SC.cueDone) + '</span>' : '') + '</button>';
  }
  function drawRos(force) {
    if (!ros || !rosData) return;
    var n = curSection(), secs = rosData.sections || [];
    if (!force && ros.shown === n) { tickRos(); return; }
    ros.shown = n;
    var cur = secs[n] || null, presets = (CFG.engage && CFG.engage.presets) || [];
    var html = '<header class="rs-ros-h"><div><p class="rm-eyebrow">' + esc(SC.rosHeading) + (rosData.title ? ' · ' + esc(rosData.title) : '') + '</p><h2>' + esc(cur ? cur.title : (rosData.error || secs.length ? (secs[0] ? secs[0].title : '') : SC.rosNoScript)) + '</h2><p class="rs-ros-t" data-ros-t></p></div>' +
      '<div class="rs-ros-c"><button type="button" class="rm-btn" data-ros-prev aria-label="' + esc(SC.prev) + '">‹</button><button type="button" class="rm-primary" data-ros-next>' + esc(n < 0 ? SC.rosStart : SC.rosNext) + '</button>' +
      '<button type="button" class="rm-btn" data-ros-small aria-label="' + esc(SC.prompterSmaller) + '">A−</button><button type="button" class="rm-btn" data-ros-big aria-label="' + esc(SC.prompterBigger) + '">A+</button><button type="button" class="rm-btn" data-ros-mirror aria-pressed="' + prompt.mirror + '">' + esc(SC.prompterMirror) + '</button><button type="button" class="rm-btn" data-ros-close>' + esc(SC.close) + '</button></div></header>' +
      '<div class="rs-ros-cues" role="group" aria-label="' + esc(SC.cues) + '">' + stdCues().map(function (c) { return cueBtn(c, null); }).join('') +
      (presets.length ? '<select class="rm-input rs-quiz" data-ros-quiz aria-label="' + esc(SC.cueQuiz) + '"><option value="">' + esc(SC.cueQuiz) + '</option>' + presets.map(function (q) { return '<option value="' + esc(q.id) + '">' + esc(q.question.slice(0, 70)) + '</option>'; }).join('') + '</select>' : '') + '</div>' +
      (cur && cur.cues.length ? '<div class="rs-ros-cues rs-ros-script" role="group" aria-label="' + esc(SC.cues) + '">' + cur.cues.map(function (c, i) { return cueBtn(c, n + ':' + i); }).join('') + '</div>' : '') +
      '<div class="rs-prompt' + (prompt.mirror ? ' is-mirror' : '') + '" data-ros-prompt tabindex="0" style="font-size:' + prompt.size + 'px">' +
      (cur ? (cur.notes.length ? '<p class="rs-pnote">' + esc(cur.notes.join(' ')) + '</p>' : '') + cur.paras.map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('') : (rosData.error ? '<p>' + esc(rosData.error) + '</p>' : '')) + '</div>' +
      '<ol class="rs-ros-list">' + secs.map(function (x, i) { return '<li class="' + (i === n ? 'is-now' : i < n ? 'is-done' : '') + '"><button type="button" data-ros-go="' + i + '"><span>' + esc(x.title) + '</span><span class="rm-fine" data-ros-li="' + i + '"></span></button></li>'; }).join('') + '</ol>';
    ros.el.innerHTML = html;
    var el = ros.el;
    $('[data-ros-close]', el).onclick = closeRos;
    $('[data-ros-next]', el).onclick = function () { if (n + 1 < secs.length) R.send({ t: 'studio_section', n: n + 1 }); };
    $('[data-ros-prev]', el).onclick = function () { if (n > 0) R.send({ t: 'studio_section', n: n - 1 }); };
    $('[data-ros-big]', el).onclick = function () { prompt.size = Math.min(72, prompt.size + 4); savePrompt(); drawRos(true); };
    $('[data-ros-small]', el).onclick = function () { prompt.size = Math.max(18, prompt.size - 4); savePrompt(); drawRos(true); };
    $('[data-ros-mirror]', el).onclick = function () { prompt.mirror = !prompt.mirror; savePrompt(); drawRos(true); };
    $$('[data-ros-go]', el).forEach(function (b) { b.onclick = function () { R.send({ t: 'studio_section', n: Number(b.getAttribute('data-ros-go')) }); }; });
    var qz = $('[data-ros-quiz]', el); if (qz) qz.onchange = function () { if (qz.value) { runCue({ cue: 'quiz:' + qz.value }); qz.value = ''; } };
    $$('[data-cue]', el).forEach(function (b) {
      b.onclick = function () {
        var key = b.getAttribute('data-key'), c = { cue: b.getAttribute('data-cue'), text: b.getAttribute('data-text') };
        if (c.cue === 'poll') {
          var sec = secs[n], q = sec && sec.cues[Number((key || ':').split(':')[1])];
          if (!q || !q.question) { R.toast(SC.cueNoPreset); return; }
          c.question = q.question; c.options = q.options;
        }
        runCue(c);
        if (key) { done[key] = Date.now(); saveDone(); drawRos(true); }
      };
    });
    tickRos();
  }
  function runCue(c) { var m = { t: 'studio_cue', cue: c.cue }; if (c.text) m.text = c.text; if (c.question) { m.question = c.question; m.options = c.options; } R.send(m); }
  /** Elapsed against planned, per section, from the server's section start times. */
  function tickRos() {
    if (!ros || !rosData) return;
    var s = sv(); if (!s || !s.ros) return;
    var secs = rosData.sections || [], n = s.ros.section, at = s.ros.at || {}, now = R.now();
    var spent = function (i) { var a = at[String(i)]; if (!a) return null; var nextAt = null; for (var j = i + 1; j < secs.length + 1; j++) if (at[String(j)] && at[String(j)] > a) { nextAt = at[String(j)]; break; } return ((i === n ? now : nextAt || now) - a); };
    var tEl = $('[data-ros-t]', ros.el);
    if (tEl && secs[n]) {
      var sp = spent(n) || 0, pl = secs[n].planned * 1000, diff = sp - pl;
      tEl.innerHTML = esc(SC.elapsed) + ' <b>' + esc(R.clock(sp)) + '</b> · ' + esc(SC.planned) + ' <b>' + esc(R.clock(pl)) + '</b> · <span class="' + (diff > 0 ? 'rs-over' : 'rs-under') + '">' + esc(R.clock(Math.abs(diff))) + ' ' + esc(diff > 0 ? SC.over : SC.under) + '</span>';
    } else if (tEl) tEl.textContent = '';
    secs.forEach(function (x, i) {
      var li = $('[data-ros-li="' + i + '"]', ros.el); if (!li) return;
      var sp2 = spent(i);
      li.textContent = (sp2 != null ? R.clock(sp2) + ' / ' : '') + R.clock(x.planned * 1000);
      li.classList.toggle('rs-over', sp2 != null && sp2 > x.planned * 1000);
    });
  }

  // ───────────── highlight a chat message or a question on screen ─────────────
  function injectHighlight() {
    if (!direct() || !on()) return;
    var p = $('[data-panel]'); if (!p) return;
    var s = sv(), cur = s && s.highlightId;
    var add = function (anchor, kind, id) {
      var li = anchor.closest('li'); if (!li) return;
      var b = $('[data-rs-hl]', li);
      var isOn = Boolean(cur && cur.kind === kind && cur.id === id);
      if (!b) { b = h('button', { type: 'button', class: 'rm-mini', 'data-rs-hl': kind + ':' + id }); anchor.parentNode.insertBefore(b, anchor.nextSibling); anchor.parentNode.insertBefore(document.createTextNode(' '), b); b.onclick = function () { var c2 = sv().highlightId; R.send(c2 && c2.kind === kind && c2.id === id ? { t: 'studio_highlight', kind: null } : { t: 'studio_highlight', kind: kind, mid: id }); }; }
      b.textContent = isOn ? SC.highlightClear : SC.showOnScreen;
      b.setAttribute('aria-pressed', String(isOn));
    };
    $$('[data-pin]', p).forEach(function (a) { add(a, 'chat', Number(a.getAttribute('data-pin'))); });
    $$('[data-ans]', p).forEach(function (a) { add(a, 'question', Number(a.getAttribute('data-ans'))); });
  }

  // ───────────── the green room card (for whoever waits backstage) ─────────────
  var gm = { el: null, ctx: null, raf: 0, track: null };
  function greenCard() {
    var s = sv(), mine = s && s.me && s.me.green && on();
    var wrapEl0 = $('.rm-stagewrap'); if (wrapEl0) wrapEl0.classList.toggle('rs-greenon', Boolean(mine));
    if (!mine) { if (gm.el) { gm.el.remove(); gm.el = null; stopMeter(); } return; }
    if (!gm.el) {
      gm.el = h('section', { class: 'rs-greencard', 'aria-label': SC.greenHeading });
      gm.el.innerHTML = '<p class="rm-eyebrow">' + esc(SC.greenHeading) + '</p><h2>' + esc(SC.greenYou) + '</h2><p class="rm-note">' + esc(SC.greenYouBody) + '</p>' +
        '<div class="rs-gc-b"><video playsinline autoplay muted class="is-mirror" data-gc-video></video><div class="rs-gc-c"><span class="rm-fine">' + esc(SC.greenMeter) + '</span><div class="rs-meter" aria-hidden="true"><span data-gc-meter></span></div>' +
        '<p class="rs-gc-state" data-gc-state></p><button type="button" class="rm-primary" data-gc-ready></button></div></div>' +
        '<h3 class="rs-h4">' + esc(SC.backChat) + '</h3><ol class="rs-backlist" data-rs-backlist></ol><form class="rm-form" data-gc-form><input name="back" maxlength="300" autocomplete="off" placeholder="' + esc(SC.backChatPlaceholder) + '" aria-label="' + esc(SC.backChatPlaceholder) + '"><button type="submit" class="rm-send">' + esc(CFG.copy.send) + '</button></form>';
      var wrapEl = $('.rm-stagewrap'); if (!wrapEl) return;
      wrapEl.appendChild(gm.el);
      $('[data-gc-ready]', gm.el).onclick = function () { R.send({ t: 'studio_ready', on: !(sv() && sv().me.ready) }); };
      $('[data-gc-form]', gm.el).onsubmit = function (e) { e.preventDefault(); var v = this.back.value.trim(); if (v) R.send({ t: 'studio_back', text: v }); this.back.value = ''; };
    }
    var rb = $('[data-gc-ready]', gm.el); rb.textContent = s.me.ready ? SC.greenNotReady : SC.greenReady; rb.className = s.me.ready ? 'rm-btn' : 'rm-primary';
    var stEl = $('[data-gc-state]', gm.el); stEl.textContent = s.me.ready ? SC.greenChecked : SC.greenWaiting; stEl.classList.toggle('is-ok', s.me.ready);
    var v = $('[data-gc-video]', gm.el); if (S.local.cam && (!v.srcObject || v.srcObject.getVideoTracks()[0] !== S.local.cam)) { v.srcObject = new MediaStream([S.local.cam]); v.play().catch(function () {}); }
    startMeter();
    renderBack();
  }
  function startMeter() {
    if (!S.local.mic || (gm.track && gm.src === S.local.mic)) return;
    stopMeter();
    try {
      gm.src = S.local.mic; gm.track = S.local.mic.clone(); gm.track.enabled = true;
      gm.ctx = gm.ctx || new (window.AudioContext || window.webkitAudioContext)();
      var an = gm.ctx.createAnalyser(); an.fftSize = 512; gm.ctx.createMediaStreamSource(new MediaStream([gm.track])).connect(an);
      var buf = new Uint8Array(an.fftSize);
      (function tick() { an.getByteTimeDomainData(buf); var m = 0; for (var i = 0; i < buf.length; i++) m = Math.max(m, Math.abs(buf[i] - 128)); var el = gm.el && $('[data-gc-meter]', gm.el); if (el) el.style.transform = 'scaleX(' + Math.min(1, m / 60) + ')'; gm.raf = requestAnimationFrame(tick); })();
    } catch (e) { /* no meter */ }
  }
  function stopMeter() { if (gm.raf) cancelAnimationFrame(gm.raf); gm.raf = 0; if (gm.track) { gm.track.stop(); gm.track = null; } gm.src = null; }

  // ───────────── the health strip (staff): sending rate, CPU, muted while speaking, audience, paths ─────────────
  var hud = { el: null, last: null, kbps: null, limit: null, cpu: null, talk: 0, warn: false, an: null, mic: null, clone: null, ctx: null };
  function ensureHud() {
    if (!R.isStaff || !S.view) return;
    var top = $('.rm-top'); if (!top) return;
    if (!hud.el || !document.body.contains(hud.el)) {
      hud.el = h('div', { class: 'rs-hud', role: 'status', 'aria-label': SC.hud });
      top.parentNode.insertBefore(hud.el, top.nextSibling);
    }
  }
  if ('PressureObserver' in window) {
    try { new window.PressureObserver(function (recs) { var r = recs[recs.length - 1]; if (r) hud.cpu = r.state; }).observe('cpu', { sampleInterval: 2000 }).catch(function () { /* not allowed */ }); } catch (e) { /* unsupported */ }
  }
  function hudStats() {
    var pc = S.pc;
    if (!pc || pc.connectionState !== 'connected') { hud.kbps = null; return Promise.resolve(); }
    return pc.getStats().then(function (stats) {
      var bytes = 0, limit = null;
      stats.forEach(function (x) { if (x.type === 'outbound-rtp') { bytes += x.bytesSent || 0; if (x.kind === 'video' && x.qualityLimitationReason && x.qualityLimitationReason !== 'none') limit = x.qualityLimitationReason; } });
      var nowMs = Date.now();
      if (hud.last) hud.kbps = Math.max(0, Math.round((bytes - hud.last.bytes) * 8 / Math.max(1, nowMs - hud.last.t)));
      hud.last = { t: nowMs, bytes: bytes }; hud.limit = limit;
    }).catch(function () {});
  }
  function hudMic() {
    // Speaking with the mic off: a muted clone of the mic still hears the room, and nothing is sent anywhere.
    var mic = S.local.mic;
    if (!mic || S.micOn) { hud.talk = 0; hud.warn = false; return; }
    try {
      if (hud.mic !== mic) {
        if (hud.clone) hud.clone.stop();
        hud.mic = mic; hud.clone = mic.clone(); hud.clone.enabled = true;
        hud.ctx = hud.ctx || new (window.AudioContext || window.webkitAudioContext)();
        hud.an = hud.ctx.createAnalyser(); hud.an.fftSize = 1024; hud.ctx.createMediaStreamSource(new MediaStream([hud.clone])).connect(hud.an);
      }
      if (hud.ctx.state === 'suspended') hud.ctx.resume().catch(function () {});
      var buf = new Float32Array(hud.an.fftSize); hud.an.getFloatTimeDomainData(buf);
      var sum = 0; for (var i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      var rms = Math.sqrt(sum / buf.length);
      hud.talk = rms > 0.035 ? hud.talk + 1 : Math.max(0, hud.talk - 1);
      hud.warn = hud.talk >= 3;
    } catch (e) { hud.warn = false; }
  }
  function drawHud() {
    ensureHud();
    if (!hud.el || !S.view) return;
    var r = S.view.room, people = S.view.people || [], aud = people.filter(function (x) { return x.role !== 'host' && x.role !== 'cohost'; }).length;
    var b = r.broadcast;
    var cpu = hud.cpu || (hud.limit === 'cpu' ? 'serious' : null);
    var html = '<span><b>' + esc(SC.hudSend) + '</b> ' + (hud.kbps == null ? '–' : hud.kbps >= 1000 ? (hud.kbps / 1000).toFixed(1) + ' Mbps' : hud.kbps + ' kbps') + '</span>' +
      '<span class="' + (cpu === 'serious' || cpu === 'critical' ? 'rs-bad' : '') + '"><b>' + esc(SC.hudCpu) + '</b> ' + esc(cpu || SC.hudCpuNone) + '</span>' +
      '<span><b>' + esc(SC.hudAudience) + '</b> ' + aud + '</span>' +
      (b ? '<span><b>' + esc(SC.hudPaths) + '</b> ' + b.moq + ' / ' + b.sfu + '</span>' : '') +
      (hud.limit && hud.limit !== 'cpu' ? '<span class="rs-bad">' + esc(fmt(SC.hudLimited, hud.limit)) + '</span>' : '');
    if (hud.el.getAttribute('data-html') !== html) { hud.el.setAttribute('data-html', html); hud.el.innerHTML = html; }
    var warn = $('[data-rs-mutewarn]');
    if (hud.warn && !warn) {
      warn = h('div', { class: 'rs-mutewarn', role: 'alert', 'data-rs-mutewarn': '' }, '<span>' + esc(SC.hudMuted) + '</span><button type="button" class="rm-btn">' + esc(SC.hudUnmute) + '</button>');
      document.body.appendChild(warn);
      $('button', warn).onclick = function () { R.setMic(true); warn.remove(); hud.warn = false; hud.talk = 0; };
    } else if (!hud.warn && warn) warn.remove();
  }
  setInterval(function () { if (!R.isStaff || !S.view || S.ended) return; hudStats().then(drawHud); }, 2000);
  setInterval(function () { if (!S.view || S.ended || !S.view.me.canPublish) return; hudMic(); if (R.isStaff) drawHud(); }, 400);

  // ───────────── wiring ─────────────
  function sync() {
    if (!S.view) return;
    if (!raf) raf = requestAnimationFrame(loop);
    ensureProgram(); sceneBar(); speak(); syncMusic(); greenCard(); syncPresenter(); injectHighlight();
    if (S.tab === 'studio') renderTab(); else syncGreenMedia();
    if (ros) drawRos(false);
  }
  R.on('shell', function () { prog = null; injectTab(); if (R.isStaff && !decks.list) loadDecks(); });
  R.on('render', sync);
  R.on('chat', injectHighlight);
  // Switching tabs redraws the chat and Q&A lists: put the On screen buttons back.
  document.addEventListener('click', function (e) { if (e.target && e.target.closest && e.target.closest('[data-tab]')) setTimeout(injectHighlight, 0); });
  R.on('studio_role', function (m) { R.toast(m.producer ? SC.producerYou : SC.producerOff); });
  R.on('studio_to_green', function () { R.toast(SC.toGreen); });
  R.on('studio_on_stage', function () { R.toast(SC.onStageNow); });
  R.on('ended', function () { if (music) { try { music.pause(); } catch (e) { /* gone */ } music = null; } closeOverlays(); });
  setInterval(function () { if (ros) tickRos(); }, 1000);
  // Run of show prefetch for directors, so the first click shows it at once.
  R.on('state', function () { if (direct() && !rosData && !rosLoading) loadRos(); });
})();
