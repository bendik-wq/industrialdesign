/* G&L Studio, the page shell and the Record view (/admin/studio).
   Everything happens in the browser: the screen (getDisplayMedia) and the camera are drawn on one canvas in the
   chosen face-cam layout at the source's resolution, the canvas and a WebAudio mix (mic + system audio) go into
   MediaRecorder, and every second's chunk is kept in IndexedDB and cut into exact 10 MiB parts that upload while
   recording (StudioCore.Uploader). On stop: the last part, complete, then the Pipeline view.
   The teleprompter, countdown, REC pill and every control are page elements, never drawn on the canvas, so none
   of them is recorded. Pure maths lives in studio-core.js (tested in test/studio-recorder.test.ts). */
(function () {
  'use strict';
  var C = window.StudioCore;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var body = document.body;
  var GUEST = body.getAttribute('data-guest') === '1';

  // ───────────── views ─────────────
  var VIEWS = ['record', 'pipeline', 'scripts', 'radar'];
  var current = 'record';
  function show(view) {
    if (VIEWS.indexOf(view) < 0) view = 'record';
    current = view;
    $$('[data-viewpane]').forEach(function (p) { p.hidden = p.getAttribute('data-viewpane') !== view; });
    $$('[data-view]').forEach(function (b, i) {
      var on = b.getAttribute('data-view') === view;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on) $('.st-seg').style.setProperty('--seg-i', String(i));
    });
    if (location.hash !== '#' + view) { try { history.replaceState(null, '', '#' + view); } catch (e) { /* file: or sandboxed */ } }
    window.dispatchEvent(new CustomEvent('studio:view', { detail: { view: view } }));
  }
  window.studio = { show: show, version: 1 };
  $$('[data-view]').forEach(function (b) { b.addEventListener('click', function () { show(b.getAttribute('data-view')); }); });
  $('.st-seg').addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    var i = VIEWS.indexOf(current) + (e.key === 'ArrowRight' ? 1 : -1);
    show(VIEWS[(i + VIEWS.length) % VIEWS.length]); $('[data-view="' + current + '"]').focus(); e.preventDefault();
  });
  window.addEventListener('hashchange', function () { show(location.hash.slice(1)); });
  show(location.hash.slice(1) || 'record');
  // The other two views come from separate modules: their first render replaces the placeholder; if a module is
  // missing in this build, the placeholder says so calmly.
  $$('[data-placeholder]').forEach(function (p) {
    var sec = p.parentNode;
    var tidy = function () { if (p.parentNode === sec && sec.children.length > 1) sec.removeChild(p); };
    if (window.MutationObserver) new MutationObserver(tidy).observe(sec, { childList: true });
    window.addEventListener('load', function () { setTimeout(function () { tidy(); if (p.parentNode === sec) p.textContent = p.getAttribute('data-placeholder'); }, 1500); });
  });

  if (!C) { note('The recorder did not load. Refresh the page.'); return; }

  // ───────────── preferences (this browser only) ─────────────
  var PREF_KEY = 'studio:prefs';
  function loadPrefs() { try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {}; } catch (e) { return {}; } }
  var P = loadPrefs();
  function savePrefs() {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify({
        layout: S.layout, corner: S.corner, size: S.size, fps: S.fps, mirror: S.mirror, autoLayout: S.autoLayout, sysAudio: S.sysAudio,
        name: S.name, role: S.role, camId: S.camId, micId: S.micId, prSpeed: S.prSpeed, prSize: S.prSize, crop: S.crop, zoomAt: S.zoomAt, cropW: S.cropW,
      }));
    } catch (e) { /* private window */ }
  }

  var S = {
    layout: C.IDS.indexOf(P.layout) >= 0 ? P.layout : 'orbit',
    corner: /^[tb][lr]$/.test(P.corner) ? P.corner : 'br', size: /^[sml]$/.test(P.size) ? P.size : 'm',
    fps: P.fps === 60 ? 60 : 30, mirror: P.mirror !== false, autoLayout: P.autoLayout !== false, sysAudio: P.sysAudio !== false,
    name: typeof P.name === 'string' ? P.name : 'Josh Li', role: typeof P.role === 'string' ? P.role : 'G&L M&A Advisory',
    camId: P.camId || '', micId: P.micId || '', prSpeed: P.prSpeed >= 0 ? P.prSpeed : 14, prSize: P.prSize || 26,
    crop: P.crop && P.crop.w ? P.crop : null, zoomAt: P.zoomAt && P.zoomAt.x != null ? P.zoomAt : { x: 0.5, y: 0.5 }, cropW: P.cropW || 46,
    phase: 'idle', paused: false, markers: [], clock: new C.Clock(), level: 0,
    screen: null, cam: null, mic: null, ac: null, dest: null, micNode: null, sysNode: null, analyser: null, abuf: null,
    zoomOn: false, zoomT: 0, morphFrom: null, morphT0: 0, lastGeom: null, drag: null,
    beats: [], beatIdx: -1, prY: 0, prTarget: null, scriptId: null,
    recorder: null, uploader: null, rec: null, mem: null, chunkSeq: 0,
  };

  var canvas = $('[data-canvas]'), ctx = canvas.getContext('2d', { alpha: false });
  var stage = $('[data-stage]');
  var titleIn = $('[data-title]');
  var SANS = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif';
  var SERIF = '"New York", "Iowan Old Style", Georgia, "Times New Roman", serif';
  var NAVY = '#0f2c5c', GOLD = 'rgba(245, 184, 46, .92)';

  var supported = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia && window.MediaRecorder && HTMLCanvasElement.prototype.captureStream);

  // ───────────── small UI helpers ─────────────
  function note(text) { var n = $('[data-note]'); if (n) { n.textContent = text; n.hidden = !text; } }
  var toastT = null;
  function toast(text) {
    var t = $('[data-toast]'); if (!t) return;
    t.textContent = text; t.classList.add('on');
    clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('on'); }, 2600);
  }
  function status(text, kind) {
    var s = $('[data-status]'); s.querySelector('span').textContent = text; s.setAttribute('data-kind', kind || '');
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function mb(bytes) { return bytes >= 1e9 ? (bytes / 1e9).toFixed(2) + ' GB' : (bytes / 1e6).toFixed(1) + ' MB'; }
  function sheet(html) {
    var sh = $('[data-sheet]'), sc = $('[data-scrim]');
    if (!html) { sh.hidden = true; sc.hidden = true; sh.innerHTML = ''; return sh; }
    sh.innerHTML = html; sh.hidden = false; sc.hidden = false;
    var f = sh.querySelector('button.primary, button'); if (f) setTimeout(function () { f.focus(); }, 30);
    return sh;
  }

  // ───────────── offscreen placeholders (no screen yet, no camera) ─────────────
  function placeholderScreen(w, h) {
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    var x = c.getContext('2d'), u = h / 900;
    var g = x.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#eef2fb'); g.addColorStop(1, '#f7f5f0');
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    // a quiet suggestion of a desktop: a window with a sidebar and a few lines
    x.fillStyle = 'rgba(255,255,255,.9)'; rr(x, w * 0.12, h * 0.14, w * 0.76, h * 0.68, 22 * u); x.fill();
    x.strokeStyle = 'rgba(15,44,92,.08)'; x.lineWidth = 2 * u; x.stroke();
    x.fillStyle = 'rgba(15,44,92,.06)'; rr(x, w * 0.12, h * 0.14, w * 0.18, h * 0.68, 22 * u); x.fill();
    x.fillStyle = 'rgba(15,44,92,.10)';
    for (var i = 0; i < 4; i++) { rr(x, w * 0.34, h * (0.22 + i * 0.08), w * (0.42 - i * 0.07), 14 * u, 7 * u); x.fill(); }
    x.fillStyle = 'rgba(15,44,92,.55)'; x.font = '600 ' + Math.round(34 * u) + 'px ' + SANS; x.textAlign = 'center';
    x.fillText('Your screen appears here', w / 2, h * 0.68);
    x.fillStyle = 'rgba(15,44,92,.4)'; x.font = '400 ' + Math.round(22 * u) + 'px ' + SANS;
    x.fillText('Choose a screen, a window or a tab', w / 2, h * 0.68 + 40 * u);
    return c;
  }
  function placeholderFace() {
    var c = document.createElement('canvas'); c.width = 960; c.height = 720;
    var x = c.getContext('2d');
    var g = x.createRadialGradient(480, 260, 40, 480, 360, 620); g.addColorStop(0, '#24467f'); g.addColorStop(1, '#0a1f45');
    x.fillStyle = g; x.fillRect(0, 0, 960, 720);
    var ini = (S.name || 'G L').split(/\s+/).map(function (p) { return p[0] || ''; }).join('').slice(0, 2).toUpperCase();
    x.fillStyle = 'rgba(255,255,255,.92)'; x.font = '600 150px ' + SANS; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(ini, 480, 330);
    x.fillStyle = 'rgba(255,255,255,.5)'; x.font = '500 30px ' + SANS; x.fillText('Camera off', 480, 470);
    return c;
  }
  var phScreen = null, phFace = null;
  function screenImg() {
    var v = S.screen && S.screen.video;
    if (v && v.videoWidth) return { img: v, w: v.videoWidth, h: v.videoHeight };
    var aw = 1600, ah = Math.round(1600 / (S.layout === 'vertical' ? 16 / 9 : canvas.width / canvas.height));
    if (!phScreen || phScreen.width !== aw || phScreen.height !== ah) phScreen = placeholderScreen(aw, ah);
    return { img: phScreen, w: aw, h: ah };
  }
  function faceImg() {
    var v = S.cam && S.cam.video;
    if (v && v.videoWidth) return { img: v, w: v.videoWidth, h: v.videoHeight };
    if (!phFace || phFace.dataset.name !== S.name) { phFace = placeholderFace(); phFace.dataset.name = S.name; }
    return { img: phFace, w: 960, h: 720 };
  }

  // ───────────── drawing ─────────────
  function rr(x, X, Y, w, h, r) {
    r = Math.max(0, Math.min(r || 0, w / 2, h / 2));
    x.beginPath();
    x.moveTo(X + r, Y); x.lineTo(X + w - r, Y); x.arcTo(X + w, Y, X + w, Y + r, r);
    x.lineTo(X + w, Y + h - r); x.arcTo(X + w, Y + h, X + w - r, Y + h, r);
    x.lineTo(X + r, Y + h); x.arcTo(X, Y + h, X, Y + h - r, r);
    x.lineTo(X, Y + r); x.arcTo(X, Y, X + r, Y, r); x.closePath();
  }
  function quadPath(x, q, r) {
    // a trapezoid with rounded corners (the tilted card)
    var n = q.length; r = Math.max(0, r || 0); x.beginPath();
    for (var i = 0; i < n; i++) {
      var a = q[(i + n - 1) % n], b = q[i], c = q[(i + 1) % n];
      var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (i === 0) x.moveTo(mx, my);
      x.arcTo(b.x, b.y, (b.x + c.x) / 2, (b.y + c.y) / 2, r);
    }
    x.closePath();
  }
  var bgCache = null;
  function drawBg(W, H, dark) {
    if (!bgCache || bgCache.w !== W || bgCache.h !== H) {
      var c = document.createElement('canvas'); c.width = W; c.height = H;
      var x = c.getContext('2d');
      var g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#143670'); g.addColorStop(0.55, '#0f2c5c'); g.addColorStop(1, '#091d40');
      x.fillStyle = g; x.fillRect(0, 0, W, H);
      var r = x.createRadialGradient(W * 0.18, H * 0.05, 0, W * 0.18, H * 0.05, Math.max(W, H) * 0.7);
      r.addColorStop(0, 'rgba(255,255,255,.10)'); r.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = r; x.fillRect(0, 0, W, H);
      bgCache = { w: W, h: H, c: c };
    }
    ctx.drawImage(bgCache.c, 0, 0);
    if (dark > 0.01) { ctx.fillStyle = 'rgba(4,6,11,' + Math.min(1, dark).toFixed(3) + ')'; ctx.fillRect(0, 0, W, H); }
  }
  function screenRegion() {
    var full = { x: 0, y: 0, w: 1, h: 1 };
    var base = S.layout === 'vertical' && S.crop ? S.crop : full;
    var z = C.ease(S.zoomT);
    if (z <= 0.001) return base;
    var zw = base.w / 2, zh = base.h / 2;
    var zx = C.clamp(S.zoomAt.x - zw / 2, base.x, base.x + base.w - zw), zy = C.clamp(S.zoomAt.y - zh / 2, base.y, base.y + base.h - zh);
    return C.lerpRegion(base, { x: zx, y: zy, w: zw, h: zh }, z);
  }
  function drawScreen(g, u) {
    var s = g.screen;
    if (s.op <= 0.01 || s.w < 2 || s.h < 2) return;
    var src = screenImg(), reg = screenRegion();
    var sr = C.coverSource(src.w, src.h, s.w / s.h, 0.5, 0.5, 1, reg);
    ctx.save(); ctx.globalAlpha = s.op;
    var tilted = Math.abs(s.tilt) > 0.05;
    var T = tilted ? C.tiltStrips(s, s.tilt, Math.max(48, Math.round(s.w / 10))) : null;
    var path = function () { if (T) quadPath(ctx, T.quad, s.r * Math.min(T.scaleL, T.scaleR)); else rr(ctx, s.x, s.y, s.w, s.h, s.r); };
    if (s.shadow > 0.01) {
      ctx.save(); path();
      ctx.shadowColor = 'rgba(2,8,22,' + (0.5 * s.shadow).toFixed(3) + ')'; ctx.shadowBlur = 70 * u; ctx.shadowOffsetY = 30 * u;
      ctx.fillStyle = '#0a1f45'; ctx.fill(); ctx.restore();
    }
    ctx.save(); path(); ctx.clip();
    if (T) {
      for (var i = 0; i < T.strips.length; i++) {
        var p = T.strips[i];
        ctx.drawImage(src.img, sr.x + p.u0 * sr.w, sr.y, (p.u1 - p.u0) * sr.w, sr.h, p.x, p.y, p.w + 0.75, p.h);
      }
    } else ctx.drawImage(src.img, sr.x, sr.y, sr.w, sr.h, s.x, s.y, s.w, s.h);
    if (s.glass > 0.01) {
      // the glass: a soft top light and a faint reflection across the card
      var y0 = T ? Math.min(T.quad[0].y, T.quad[1].y) : s.y, y1 = T ? Math.max(T.quad[2].y, T.quad[3].y) : s.y + s.h;
      var x0 = T ? T.quad[0].x : s.x, x1 = T ? T.quad[1].x : s.x + s.w;
      var lg = ctx.createLinearGradient(x0, y0, x0 + (x1 - x0) * 0.6, y1);
      lg.addColorStop(0, 'rgba(255,255,255,' + (0.16 * s.glass).toFixed(3) + ')'); lg.addColorStop(0.35, 'rgba(255,255,255,0)');
      ctx.fillStyle = lg; ctx.fillRect(Math.min(x0, x1), y0, Math.abs(x1 - x0), y1 - y0);
    }
    ctx.restore();
    if (s.glass > 0.01) {
      path(); ctx.lineWidth = 2 * u; ctx.strokeStyle = 'rgba(255,255,255,' + (0.55 * s.glass).toFixed(3) + ')'; ctx.stroke();
    }
    ctx.restore();
  }
  function drawFace(g, u) {
    var f = g.face;
    if (f.op <= 0.01 || f.w < 2 || f.h < 2) return;
    var src = faceImg();
    var sr = C.faceSource(src.w, src.h, f.w / f.h);
    ctx.save(); ctx.globalAlpha = f.op;
    var r = Math.min(f.r, f.w / 2, f.h / 2);
    if (f.ring > 0.01) {
      // the voice halo: a frosted glass ring that breathes with the level (reads on light and dark screens alike)
      var L = S.level, cx = f.x + f.w / 2, cy = f.y + f.h / 2, R = Math.min(f.w, f.h) / 2, band = (7 + 4 * L) * u;
      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, Math.max(0, R + band / 2), 0, Math.PI * 2);
      ctx.shadowColor = 'rgba(64,120,230,' + ((0.25 + 0.55 * L) * f.ring).toFixed(3) + ')'; ctx.shadowBlur = (16 + 56 * L) * u;
      ctx.lineWidth = band; ctx.strokeStyle = 'rgba(255,255,255,' + ((0.42 + 0.3 * L) * f.ring).toFixed(3) + ')'; ctx.stroke();
      ctx.shadowColor = 'transparent';
      ctx.beginPath(); ctx.arc(cx, cy, Math.max(0, R + band + 0.5 * u), 0, Math.PI * 2);
      ctx.lineWidth = 1 * u; ctx.strokeStyle = 'rgba(15,44,92,' + (0.22 * f.ring).toFixed(3) + ')'; ctx.stroke();
      ctx.restore();
    }
    if (f.shadow > 0.01) {
      ctx.save(); rr(ctx, f.x, f.y, f.w, f.h, r);
      ctx.shadowColor = 'rgba(2,8,22,' + (0.42 * f.shadow).toFixed(3) + ')'; ctx.shadowBlur = 44 * u; ctx.shadowOffsetY = 16 * u;
      ctx.fillStyle = NAVY; ctx.fill(); ctx.restore();
    }
    ctx.save(); rr(ctx, f.x, f.y, f.w, f.h, r); ctx.clip();
    if (g.grade > 0.01 && 'filter' in ctx) ctx.filter = 'saturate(' + (1 + 0.06 * g.grade) + ') contrast(' + (1 + 0.05 * g.grade) + ')';
    ctx.drawImage(src.img, sr.x, sr.y, sr.w, sr.h, f.x, f.y, f.w, f.h);
    if ('filter' in ctx) ctx.filter = 'none';
    ctx.restore();
    if (f.ring > 0.01) {
      var cx2 = f.x + f.w / 2, cy2 = f.y + f.h / 2, R2 = Math.min(f.w, f.h) / 2;
      ctx.beginPath(); ctx.arc(cx2, cy2, Math.max(0, R2 - 1.5 * u), 0, Math.PI * 2);
      ctx.lineWidth = 3.5 * u; ctx.strokeStyle = 'rgba(255,255,255,' + (0.85 * f.ring).toFixed(3) + ')'; ctx.stroke();
      ctx.beginPath(); ctx.arc(cx2, cy2, Math.max(0, R2 - 5 * u), 0, Math.PI * 2);
      ctx.lineWidth = 1.25 * u; ctx.strokeStyle = GOLD; ctx.globalAlpha = f.op * f.ring * 0.9; ctx.stroke(); ctx.globalAlpha = f.op;
    }
    if (f.rim > 0.01) {
      rr(ctx, f.x + 0.75 * u, f.y + 0.75 * u, f.w - 1.5 * u, f.h - 1.5 * u, Math.max(0, r - 0.75 * u));
      ctx.lineWidth = 1.5 * u; ctx.strokeStyle = 'rgba(255,255,255,' + (0.42 * f.rim).toFixed(3) + ')'; ctx.stroke();
    }
    ctx.restore();
  }
  function drawGrade(g, W, H) {
    if (g.grade <= 0.01) return;
    ctx.save(); ctx.globalAlpha = g.grade;
    var lg = ctx.createLinearGradient(0, 0, W, 0);
    lg.addColorStop(0.30, 'rgba(9,26,58,0)'); lg.addColorStop(0.62, 'rgba(9,26,58,.72)'); lg.addColorStop(0.92, 'rgba(8,22,50,.97)'); lg.addColorStop(1, 'rgba(8,22,50,.97)');
    ctx.fillStyle = lg; ctx.fillRect(0, 0, W, H);
    var rg = ctx.createRadialGradient(W * 0.36, H * 0.42, W * 0.18, W * 0.36, H * 0.42, W * 0.85);
    rg.addColorStop(0, 'rgba(3,9,22,0)'); rg.addColorStop(1, 'rgba(3,9,22,.55)');
    ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
  function drawSeam(g, W, H) {
    if (g.seam <= 0.01) return;
    ctx.save(); ctx.globalAlpha = g.seam;
    var lg = ctx.createLinearGradient(0, H * 0.34, 0, H * 0.5);
    lg.addColorStop(0, 'rgba(11,33,73,0)'); lg.addColorStop(1, 'rgba(12,36,78,1)');
    ctx.fillStyle = lg; ctx.fillRect(0, H * 0.34, W, H * 0.17);
    var tg = ctx.createLinearGradient(0, 0, 0, H * 0.08);
    tg.addColorStop(0, 'rgba(4,10,24,.35)'); tg.addColorStop(1, 'rgba(4,10,24,0)');
    ctx.fillStyle = tg; ctx.fillRect(0, 0, W, H * 0.08);
    ctx.restore();
  }
  function text(str, x, y, font, color, align, maxW) {
    ctx.font = font; ctx.fillStyle = color; ctx.textAlign = align || 'left'; ctx.textBaseline = 'alphabetic';
    if (maxW && ctx.measureText(str).width > maxW) { while (str.length > 1 && ctx.measureText(str + '…').width > maxW) str = str.slice(0, -1); str += '…'; }
    ctx.fillText(str, x, y);
  }
  function wrap(str, font, maxW, maxLines) {
    ctx.font = font; var words = String(str).split(/\s+/), lines = [], cur = '';
    words.forEach(function (w) { var t = cur ? cur + ' ' + w : w; if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t; });
    if (cur) lines.push(cur);
    if (lines.length > maxLines) { lines = lines.slice(0, maxLines); lines[maxLines - 1] += '…'; }
    return lines;
  }
  function drawOverlays(g, W, H, u) {
    var f = g.face, name = S.name || '', role = S.role || '', title = titleIn.value.trim();
    if (g.lt.op > 0.01 && f.w > 40 * u && (name || role)) {
      ctx.save(); ctx.globalAlpha = g.lt.op;
      rr(ctx, f.x, f.y, f.w, f.h, Math.min(f.r, f.w / 2)); ctx.clip();
      var lg = ctx.createLinearGradient(0, f.y + f.h * 0.58, 0, f.y + f.h);
      lg.addColorStop(0, 'rgba(8,22,48,0)'); lg.addColorStop(1, 'rgba(8,22,48,.82)');
      ctx.fillStyle = lg; ctx.fillRect(f.x, f.y + f.h * 0.58, f.w, f.h * 0.42);
      var px = f.x + 30 * u, by = f.y + f.h - 36 * u;
      ctx.fillStyle = GOLD; ctx.fillRect(px, by - 86 * u, 40 * u, 2 * u);
      text(name, px, by - 40 * u, '600 ' + 34 * u + 'px ' + SANS, '#fff', 'left', f.w - 60 * u);
      text(role, px, by, '400 ' + 21 * u + 'px ' + SANS, 'rgba(255,255,255,.78)', 'left', f.w - 60 * u);
      ctx.restore();
    }
    if (g.tag.op > 0.01 && name) {
      // the presenter's name as a dark glass pill inside the card, bottom left
      ctx.save(); ctx.globalAlpha = g.tag.op;
      rr(ctx, f.x, f.y, f.w, f.h, Math.min(f.r, f.w / 2)); ctx.clip();
      var tf = '600 ' + 18 * u + 'px ' + SANS, rf = '400 ' + 16 * u + 'px ' + SANS;
      ctx.font = tf; var nw = ctx.measureText(name).width; ctx.font = rf; var rw = role ? ctx.measureText(role).width : 0;
      var th = 36 * u, tw = Math.min(f.w - 28 * u, 46 * u + nw + (role ? 12 * u + rw : 0)), tx = f.x + 14 * u, ty = f.y + f.h - 14 * u - th;
      rr(ctx, tx, ty, tw, th, th / 2);
      ctx.fillStyle = 'rgba(9,24,54,.66)'; ctx.fill();
      ctx.lineWidth = 1 * u; ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.stroke();
      ctx.beginPath(); ctx.arc(tx + 18 * u, ty + th / 2, 3.5 * u, 0, Math.PI * 2); ctx.fillStyle = GOLD; ctx.fill();
      var bl = ty + th / 2 + 6 * u;
      text(name, tx + 30 * u, bl, tf, '#fff', 'left', tw - 44 * u);
      if (role && 42 * u + nw + 40 * u < tw) text(role, tx + 42 * u + nw, bl, rf, 'rgba(255,255,255,.72)', 'left', tw - nw - 56 * u);
      ctx.restore();
    }
    if (g.title.op > 0.01 && title) {
      ctx.save(); ctx.globalAlpha = g.title.op;
      ctx.fillStyle = GOLD; ctx.fillRect(g.title.x, g.title.y - 46 * u, 32 * u, 2 * u);
      text(title, g.title.x, g.title.y - 6 * u, '600 ' + 30 * u + 'px ' + SANS, 'rgba(255,255,255,.94)', 'left', g.screen.w);
      ctx.restore();
    }
    if (g.band.op > 0.01) {
      ctx.save(); ctx.globalAlpha = g.band.op;
      var m = 56 * u, base = g.band.y + Math.min(g.band.h * 0.62, 84 * u);
      ctx.fillStyle = GOLD; ctx.fillRect(m, base - 50 * u, 36 * u, 1.5 * u);
      text(title || 'Untitled recording', m, base, '400 ' + 36 * u + 'px ' + SERIF, '#fff', 'left', W * 0.6);
      var ch = S.markers.filter(function (x) { return x.kind === 'chapter'; }).pop();
      if (ch && g.screen.y > 60 * u) {
        if ('letterSpacing' in ctx) ctx.letterSpacing = (2.5 * u).toFixed(1) + 'px';
        text(String(ch.label).toUpperCase(), m, g.screen.y / 2 + 6 * u, '600 ' + 14 * u + 'px ' + SANS, 'rgba(255,255,255,.55)', 'left', W * 0.5);
        if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
      }
      if (name) text(name + (role ? '  ·  ' + role : ''), W - m, base, '500 ' + 19 * u + 'px ' + SANS, 'rgba(255,255,255,.62)', 'right', W * 0.3);
      ctx.restore();
    }
    if (g.vtitle.op > 0.01) {
      ctx.save(); ctx.globalAlpha = g.vtitle.op;
      var lines = wrap(title || 'Untitled recording', '700 ' + 50 * u + 'px ' + SANS, W - 140 * u, 2), y = g.vtitle.y;
      lines.forEach(function (l, i) { text(l, W / 2, y + i * 60 * u, '700 ' + 50 * u + 'px ' + SANS, '#fff', 'center'); });
      y += (lines.length - 1) * 60 * u;
      ctx.fillStyle = GOLD; ctx.fillRect(W / 2 - 18 * u, y + 30 * u, 36 * u, 2 * u);
      if (name) text(name + (role ? '  ·  ' + role : ''), W / 2, y + 80 * u, '500 ' + 26 * u + 'px ' + SANS, 'rgba(255,255,255,.72)', 'center', W - 140 * u);
      ctx.restore();
    }
  }
  function geomFor(layout) {
    var W = canvas.width, H = canvas.height, sc = screenImg(), fc = faceImg();
    return C.layoutGeometry(layout, W, H, { srcAspect: sc.w / sc.h, camAspect: fc.w / fc.h, corner: S.corner, size: S.size });
  }
  function startMorph() { S.morphFrom = S.lastGeom; S.morphT0 = performance.now(); }
  function currentGeom(now) {
    var g = geomFor(S.layout);
    if (S.morphFrom && now - S.morphT0 < C.MORPH_MS && reduced !== true) g = C.lerpGeom(S.morphFrom, g, C.spring((now - S.morphT0) / C.MORPH_MS));
    else S.morphFrom = null;
    if (S.drag && S.layout === 'orbit') { g.face.x = S.drag.x - g.face.w / 2; g.face.y = S.drag.y - g.face.h / 2; }
    return g;
  }
  var reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  var lastDraw = 0, lastT = 0;
  function frame() {
    try { draw(); } catch (e) { if (!frame.warned) { frame.warned = true; console.error('studio frame', e); } }
  }
  function draw() {
    var now = performance.now();
    if (now - lastDraw < 1000 / S.fps - 2) return;
    var dt = Math.min(0.1, (now - (lastT || now)) / 1000); lastT = now; lastDraw = now;
    // the mic level (ring + meter)
    if (S.analyser) { S.analyser.getFloatTimeDomainData(S.abuf); S.level = C.smoothLevel(S.level, C.levelFromSamples(S.abuf)); }
    var zt = S.zoomOn ? 1 : 0; S.zoomT += C.clamp(zt - S.zoomT, -dt / 0.42, dt / 0.42);
    var W = canvas.width, H = canvas.height, u = S.layout === 'vertical' ? W / 1080 : Math.min(W / 1920, H / 1080);
    var g = currentGeom(now);
    S.lastGeom = g;
    drawBg(W, H, g.bgDark);
    if (g.faceTop) { drawScreen(g, u); drawFace(g, u); }
    else { drawFace(g, u); drawGrade(g, W, H); drawSeam(g, W, H); drawScreen(g, u); }
    drawOverlays(g, W, H, u);
    prompterTick(dt);
    uiTick(dt);
  }
  // Frames come from a worker timer as well as requestAnimationFrame, so recording keeps going when this tab is hidden.
  (function ticker() {
    var raf = function () { frame(); requestAnimationFrame(raf); };
    requestAnimationFrame(raf);
    try {
      var w = new Worker(URL.createObjectURL(new Blob(['var t=null;onmessage=function(e){clearInterval(t);if(e.data>0)t=setInterval(function(){postMessage(0)},e.data)}'], { type: 'text/javascript' })));
      w.onmessage = function () { if (document.hidden) frame(); };
      S.tickWorker = w; w.postMessage(Math.floor(1000 / 60));
    } catch (e) { setInterval(function () { if (document.hidden) frame(); }, 33); }
  })();

  // ───────────── canvas size ─────────────
  function sizeCanvas() {
    var v = S.screen && S.screen.video, out;
    if (S.layout === 'vertical') out = C.outputSize('vertical', v ? v.videoWidth : 1920, v ? v.videoHeight : 1080);
    else out = v && v.videoWidth ? C.outputSize('landscape', v.videoWidth, v.videoHeight) : { w: 1920, h: 1080 };
    if (canvas.width !== out.w || canvas.height !== out.h) { canvas.width = out.w; canvas.height = out.h; S.lastGeom = null; S.morphFrom = null; }
    stage.style.setProperty('--ar', out.w + ' / ' + out.h);
    stage.classList.toggle('portrait', out.h > out.w);
  }

  // ───────────── layouts ─────────────
  function setLayout(id, why) {
    if (C.IDS.indexOf(id) < 0 || id === S.layout) return;
    var recording = S.phase === 'recording' || S.phase === 'countdown';
    if (recording && (id === 'vertical') !== (S.layout === 'vertical')) {
      if (why !== 'auto') toast(id === 'vertical' ? 'Vertical is a 9:16 recording: choose it before you press Record' : 'This recording is vertical: other layouts are for 16:9 recordings');
      return;
    }
    var aspectChange = (id === 'vertical') !== (S.layout === 'vertical');
    if (!aspectChange) startMorph();
    S.layout = id;
    if (aspectChange) { sizeCanvas(); syncMap(); }
    $$('[data-layout]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-layout') === id)); });
    syncLayoutLocks();
    if (!recording) savePrefs();
  }
  function syncLayoutLocks() {
    var rec = S.phase === 'recording' || S.phase === 'countdown';
    $$('[data-layout]').forEach(function (b) { var v = b.getAttribute('data-layout') === 'vertical'; b.disabled = rec && v !== (S.layout === 'vertical'); });
  }
  $$('[data-layout]').forEach(function (b) { b.addEventListener('click', function () { setLayout(b.getAttribute('data-layout')); }); });

  // Drag the orbit bubble to any corner (it snaps to the nearest one with the same spring).
  function canvasPoint(e) {
    var r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * canvas.width / r.width, y: (e.clientY - r.top) * canvas.height / r.height };
  }
  canvas.addEventListener('pointerdown', function (e) {
    if (S.layout !== 'orbit' || !S.lastGeom) return;
    var p = canvasPoint(e), f = S.lastGeom.face;
    if (p.x < f.x || p.x > f.x + f.w || p.y < f.y || p.y > f.y + f.h) return;
    S.drag = { x: f.x + f.w / 2, y: f.y + f.h / 2, ox: p.x - (f.x + f.w / 2), oy: p.y - (f.y + f.h / 2) };
    canvas.setPointerCapture(e.pointerId); stage.classList.add('dragging'); e.preventDefault();
  });
  canvas.addEventListener('pointermove', function (e) {
    if (S.drag) { var p = canvasPoint(e); S.drag.x = p.x - S.drag.ox; S.drag.y = p.y - S.drag.oy; return; }
    if (S.layout !== 'orbit' || !S.lastGeom) { canvas.style.cursor = ''; return; }
    var q = canvasPoint(e), f = S.lastGeom.face;
    canvas.style.cursor = q.x >= f.x && q.x <= f.x + f.w && q.y >= f.y && q.y <= f.y + f.h ? 'grab' : '';
  });
  function endDrag() {
    if (!S.drag) return;
    var c = C.nearestCorner(S.drag.x, S.drag.y, canvas.width, canvas.height);
    S.drag = null; stage.classList.remove('dragging');
    startMorph(); S.corner = c; savePrefs();
  }
  canvas.addEventListener('pointerup', endDrag); canvas.addEventListener('pointercancel', endDrag);

  // ───────────── look panel ─────────────
  function segInit(sel, val, cb) {
    var g = $(sel);
    function sync(v) { $$('button', g).forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-v') === String(v))); }); }
    sync(val);
    $$('button', g).forEach(function (b) { b.addEventListener('click', function () { var v = b.getAttribute('data-v'); sync(v); cb(v); }); });
    return sync;
  }
  segInit('[data-size]', S.size, function (v) { startMorph(); S.size = v; savePrefs(); });
  var syncFps = segInit('[data-fps]', S.fps, function (v) {
    if (S.phase !== 'idle') { syncFps(S.fps); toast('Frame rate is set before you record'); return; }
    S.fps = Number(v); savePrefs();
    if (S.screen) toast('Choose the screen again to capture at ' + S.fps + ' fps');
  });
  var nameIn = $('[data-name]'), roleIn = $('[data-role]');
  nameIn.value = S.name; roleIn.value = S.role;
  nameIn.addEventListener('input', function () { S.name = nameIn.value.trim(); savePrefs(); });
  roleIn.addEventListener('input', function () { S.role = roleIn.value.trim(); savePrefs(); });
  var mirrorIn = $('[data-mirror]'); mirrorIn.checked = S.mirror;
  function syncMirror() { $$('[data-selfview], [data-campreview]').forEach(function (v) { v.classList.toggle('mirror', S.mirror); }); }
  mirrorIn.addEventListener('change', function () { S.mirror = mirrorIn.checked; syncMirror(); savePrefs(); });
  syncMirror();
  var autoIn = $('[data-autolayout]'); autoIn.checked = S.autoLayout;
  autoIn.addEventListener('change', function () { S.autoLayout = autoIn.checked; savePrefs(); });
  var sysIn = $('[data-sysaudio]'); sysIn.checked = S.sysAudio;
  sysIn.addEventListener('change', function () { S.sysAudio = sysIn.checked; if (S.sysNode) S.sysNode.gain.gain.value = S.sysAudio ? 1 : 0; savePrefs(); });
  try { titleIn.value = sessionStorage.getItem('studio:title') || ''; } catch (e) { /* storage blocked */ }
  titleIn.addEventListener('input', function () { try { sessionStorage.setItem('studio:title', titleIn.value); } catch (e) { /* storage blocked */ } });

  // ───────────── camera and microphone ─────────────
  function audioCtx() {
    if (!S.ac) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      S.ac = new AC({ latencyHint: 'interactive' });
      S.dest = S.ac.createMediaStreamDestination();
      S.analyser = S.ac.createAnalyser(); S.analyser.fftSize = 1024; S.abuf = new Float32Array(S.analyser.fftSize);
    }
    if (S.ac.state === 'suspended') S.ac.resume().catch(function () { /* resumes on the next click */ });
    return S.ac;
  }
  document.addEventListener('pointerdown', function () { if (S.ac && S.ac.state === 'suspended') S.ac.resume().catch(function () {}); }, true);
  function wireMic() {
    var ac = audioCtx(); if (!ac) return;
    if (S.micNode) { try { S.micNode.src.disconnect(); } catch (e) { /* already */ } S.micNode = null; }
    var t = S.mic && S.mic.getAudioTracks()[0];
    if (!t) return;
    var src = ac.createMediaStreamSource(new MediaStream([t])), gain = ac.createGain();
    src.connect(gain); gain.connect(S.dest); src.connect(S.analyser);
    S.micNode = { src: src, gain: gain };
  }
  function wireSystem() {
    var ac = audioCtx(); if (!ac) return;
    if (S.sysNode) { try { S.sysNode.src.disconnect(); } catch (e) { /* already */ } S.sysNode = null; }
    var t = S.screen && S.screen.stream.getAudioTracks()[0];
    if (!t) return;
    var src = ac.createMediaStreamSource(new MediaStream([t])), gain = ac.createGain();
    gain.gain.value = S.sysAudio ? 1 : 0;
    src.connect(gain); gain.connect(S.dest);
    S.sysNode = { src: src, gain: gain };
  }
  function attach(video, stream) { video.srcObject = stream; video.muted = true; video.playsInline = true; var p = video.play(); if (p && p.catch) p.catch(function () {}); }
  function camConstraints(id) { return { deviceId: id ? { exact: id } : undefined, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }; }
  function micConstraints(id) { return { deviceId: id ? { exact: id } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true }; }
  function setCam(stream) {
    if (S.cam) S.cam.stream.getTracks().forEach(function (t) { t.stop(); });
    if (!stream) { S.cam = null; return; }
    var v = S.cam && S.cam.video || document.createElement('video');
    attach(v, stream); S.cam = { stream: stream, video: v };
    attach($('[data-selfview]'), stream); attach($('[data-campreview]'), stream);
    $('.st-cam').classList.add('on');
    var t = stream.getVideoTracks()[0]; if (t) { S.camId = t.getSettings().deviceId || S.camId; t.addEventListener('ended', function () { toast('The camera stopped'); }); }
  }
  function setMic(stream) {
    if (S.mic) S.mic.getTracks().forEach(function (t) { t.stop(); });
    S.mic = stream || null; wireMic();
    var t = stream && stream.getAudioTracks()[0]; if (t) S.micId = t.getSettings().deviceId || S.micId;
  }
  function fallbackOpen(kind, id) {
    var c = {}; c[kind] = kind === 'video' ? camConstraints(id) : micConstraints(id);
    return navigator.mediaDevices.getUserMedia(c).catch(function (e) {
      if (id && e && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) { var d = {}; d[kind] = kind === 'video' ? camConstraints('') : micConstraints(''); return navigator.mediaDevices.getUserMedia(d); }
      throw e;
    });
  }
  var camBusy = null;
  function camOn() {
    if (GUEST || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return Promise.resolve(false);
    if (camBusy) return camBusy;
    audioCtx();
    camBusy = navigator.mediaDevices.getUserMedia({ video: camConstraints(S.camId), audio: micConstraints(S.micId) }).catch(function (e) {
      // a saved device that is gone: open the defaults instead
      if (e && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError') && (S.camId || S.micId)) { S.camId = ''; S.micId = ''; return navigator.mediaDevices.getUserMedia({ video: camConstraints(''), audio: micConstraints('') }); }
      throw e;
    }).then(function (st) {
      setCam(new MediaStream(st.getVideoTracks())); setMic(new MediaStream(st.getAudioTracks()));
      savePrefs(); return listDevices().then(function () { return true; });
    }).catch(function (e) {
      toast(e && e.name === 'NotAllowedError' ? 'Camera and mic are blocked for this site. Allow them in the address bar.' : 'The camera did not start: ' + ((e && e.message) || 'unknown'));
      return false;
    }).then(function (ok) { camBusy = null; return ok; });
    return camBusy;
  }
  function listDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return Promise.resolve();
    return navigator.mediaDevices.enumerateDevices().then(function (ds) {
      var cams = ds.filter(function (d) { return d.kind === 'videoinput'; }), mics = ds.filter(function (d) { return d.kind === 'audioinput'; });
      var fill = function (sel, list, cur, none) {
        sel.innerHTML = list.length ? list.map(function (d, i) { return '<option value="' + esc(d.deviceId) + '"' + (d.deviceId === cur ? ' selected' : '') + '>' + esc(d.label || (none + ' ' + (i + 1))) + '</option>'; }).join('') : '<option value="">' + none + 's appear once allowed</option>';
      };
      fill($('[data-cam]'), cams, S.camId, 'Camera'); fill($('[data-mic]'), mics, S.micId, 'Microphone');
    }).catch(function () {});
  }
  $('[data-cam-on]').addEventListener('click', camOn);
  $('[data-cam]').addEventListener('change', function (e) {
    var id = e.target.value; if (!id) return;
    fallbackOpen('video', id).then(function (st) { setCam(st); S.camId = id; savePrefs(); }).catch(function () { toast('That camera did not start'); });
  });
  $('[data-mic]').addEventListener('change', function (e) {
    var id = e.target.value; if (!id) return;
    fallbackOpen('audio', id).then(function (st) { setMic(st); S.micId = id; savePrefs(); }).catch(function () { toast('That microphone did not start'); });
  });
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener('devicechange', listDevices);

  // ───────────── the screen ─────────────
  function pickScreen() {
    if (!supported || GUEST) return Promise.resolve(false);
    audioCtx();
    var opts = {
      video: { frameRate: { ideal: S.fps, max: S.fps }, width: { max: C.MAX_W }, height: { max: C.MAX_H } },
      audio: S.sysAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
      selfBrowserSurface: 'exclude', surfaceSwitching: 'include', systemAudio: 'include', monitorTypeSurfaces: 'include',
    };
    return navigator.mediaDevices.getDisplayMedia(opts).then(function (st) {
      if (S.screen) S.screen.stream.getTracks().forEach(function (t) { t.stop(); });
      var v = (S.screen && S.screen.video) || document.createElement('video');
      var t = st.getVideoTracks()[0];
      try { t.contentHint = 'detail'; } catch (e) { /* older browsers */ }
      S.screen = { stream: st, video: v, surface: (t.getSettings && t.getSettings().displaySurface) || '' };
      attach(v, st); attach($('[data-mapvideo]'), st);
      t.addEventListener('ended', function () {
        if (S.phase === 'recording') { toast('Screen sharing ended, so the recording stopped'); stopRecording(); }
        S.screen = null; screenInfo(); sizeCanvas(); syncMap(); if (S.phase === 'idle') status('Choose a screen', '');
      });
      wireSystem();
      return new Promise(function (res) {
        var done = function () { sizeCanvas(); screenInfo(); syncMap(); if (S.phase === 'idle') status('Ready', ''); res(true); };
        if (v.videoWidth) done(); else { v.addEventListener('loadedmetadata', done, { once: true }); setTimeout(done, 1500); }
      });
    }).catch(function (e) {
      if (e && e.name !== 'NotAllowedError' && e.name !== 'AbortError') toast('Screen capture did not start: ' + (e.message || e.name));
      return false;
    });
  }
  function screenInfo() {
    var el = $('[data-screen-info]'), btn = $('[data-pick-screen] span');
    if (!S.screen || !S.screen.video.videoWidth) { el.textContent = 'Screen, window or tab. System audio comes along when the browser offers it.'; btn.textContent = 'Choose screen'; return; }
    var v = S.screen.video, kind = { monitor: 'Entire screen', window: 'Window', browser: 'Tab' }[S.screen.surface] || 'Screen';
    var out = C.outputSize(S.layout === 'vertical' ? 'vertical' : 'landscape', v.videoWidth, v.videoHeight);
    el.textContent = kind + ' · ' + v.videoWidth + ' x ' + v.videoHeight + ' · records at ' + out.w + ' x ' + out.h + ', ' + S.fps + ' fps · ' + (S.screen.stream.getAudioTracks().length ? 'system audio on' : 'no system audio');
    btn.textContent = 'Change screen';
  }
  $('[data-pick-screen]').addEventListener('click', function () { if (S.phase === 'idle') pickScreen(); else toast('Stop the recording to change the screen'); });

  // ───────────── zoom area and vertical crop (on a small live map of the screen) ─────────────
  var map = $('[data-map]');
  function srcDims() { var v = S.screen && S.screen.video; return v && v.videoWidth ? { w: v.videoWidth, h: v.videoHeight } : { w: 1920, h: 1080 }; }
  function ensureCrop() {
    var d = srcDims(), a = C.verticalCropAspect(), c = S.crop;
    var cx = c ? c.x + c.w / 2 : 0.5, cy = c ? c.y + c.h / 2 : 0.5;
    S.crop = C.placeRegion(d.w, d.h, a, S.cropW / 100, cx, cy);
  }
  function syncMap() {
    var has = !!(S.screen && S.screen.video.videoWidth);
    map.classList.toggle('has', has);
    $('[data-map-empty]').hidden = has;
    var d = srcDims(); map.style.setProperty('--ar', d.w + ' / ' + d.h);
    ensureCrop();
    var bc = $('[data-box="crop"]'), bz = $('[data-box="zoom"]');
    var put = function (el, r) { el.style.left = (r.x * 100) + '%'; el.style.top = (r.y * 100) + '%'; el.style.width = (r.w * 100) + '%'; el.style.height = (r.h * 100) + '%'; };
    put(bc, S.crop); put(bz, C.zoomRegion(S.zoomAt.x, S.zoomAt.y, 2));
    bc.classList.toggle('dim', S.layout !== 'vertical');
  }
  $$('[data-box]').forEach(function (box) {
    var kind = box.getAttribute('data-box'), drag = null;
    box.addEventListener('pointerdown', function (e) {
      var r = map.getBoundingClientRect(), cur = kind === 'crop' ? S.crop : C.zoomRegion(S.zoomAt.x, S.zoomAt.y, 2);
      drag = { r: r, sx: e.clientX, sy: e.clientY, cx: cur.x + cur.w / 2, cy: cur.y + cur.h / 2 };
      box.setPointerCapture(e.pointerId); e.preventDefault();
    });
    box.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var cx = drag.cx + (e.clientX - drag.sx) / drag.r.width, cy = drag.cy + (e.clientY - drag.sy) / drag.r.height;
      if (kind === 'crop') { var d = srcDims(); S.crop = C.placeRegion(d.w, d.h, C.verticalCropAspect(), S.cropW / 100, cx, cy); }
      else { var z = C.zoomRegion(cx, cy, 2); S.zoomAt = { x: z.x + z.w / 2, y: z.y + z.h / 2 }; }
      syncMap();
    });
    var end = function () { if (drag) { drag = null; savePrefs(); } };
    box.addEventListener('pointerup', end); box.addEventListener('pointercancel', end);
  });
  var cropW = $('[data-cropw]'); cropW.value = S.cropW;
  cropW.addEventListener('input', function () { S.cropW = Number(cropW.value); syncMap(); savePrefs(); }); // syncMap keeps the crop's centre
  // Clicking the map (not a box) moves the zoom area there.
  map.addEventListener('click', function (e) {
    if (e.target.closest('[data-box]') || !map.classList.contains('has')) return;
    var r = map.getBoundingClientRect(), z = C.zoomRegion((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, 2);
    S.zoomAt = { x: z.x + z.w / 2, y: z.y + z.h / 2 }; syncMap(); savePrefs();
  });
  // ───────────── the masterclass deck (/admin/deck) ─────────────
  // Opens in its own window (choose it as the screen). Each slide carries the face-cam layout it wants (a data slide:
  // the screen big; a story beat: the face big), sent over BroadcastChannel "gl-deck"; Auto layout follows it.
  var deckLink = $('[data-open-deck]');
  if (deckLink) deckLink.addEventListener('click', function (e) {
    e.preventDefault();
    var w = window.open('/admin/deck', 'gl-deck-audience', 'popup,width=1920,height=1080');
    if (!w) location.href = '/admin/deck';
    else toast('Deck opened: choose its window as the screen, press P there for your notes');
  });
  var deckBus = null; try { deckBus = new BroadcastChannel('gl-deck'); } catch (e) { deckBus = null; }
  if (deckBus) deckBus.onmessage = function (ev) {
    var m = ev.data || {};
    if (m.type !== 'state' || !S.autoLayout || !m.cam) return;
    var want = C.layoutForBeat({ layout: m.cam }, S.layout);
    if (want !== S.layout) setLayout(want, 'auto');
  };

  function toggleZoom() {
    S.zoomOn = !S.zoomOn;
    $('[data-zoom]').setAttribute('aria-pressed', String(S.zoomOn));
    toast(S.zoomOn ? 'Zoomed 2x into the zoom area' : 'Zoom off');
  }
  $('[data-zoom]').addEventListener('click', toggleZoom);

  // ───────────── teleprompter ─────────────
  var prScroll = $('[data-pr-scroll]'), prText = $('[data-pr-text]');
  var LAYOUT_LABEL = {}; C.LAYOUTS.forEach(function (l) { LAYOUT_LABEL[l.id] = l.label; });
  function renderBeats() {
    if (!S.beats.length) {
      prText.innerHTML = '<p class="st-pr-empty">Pick a script in Scripts and its beats appear here, near your camera. The prompter is never recorded.</p>';
      S.beatIdx = -1; return;
    }
    prText.innerHTML = S.beats.map(function (b, i) {
      return '<div class="st-beat" data-i="' + i + '"><p class="st-beat-meta"><span>' + esc(LAYOUT_LABEL[b.layout] || b.layout) + '</span>' + (b.cue ? '<em>' + esc(b.cue) + '</em>' : '') + '</p><p class="st-beat-text">' + esc(b.text) + '</p></div>';
    }).join('') + '<div class="st-beat-end" aria-hidden="true"></div>';
    S.prY = 0; S.prTarget = null; S.beatIdx = -1; prText.style.transform = 'translateY(0)';
    setBeat(0, true);
  }
  function beatTop(i) { var el = prText.children[i]; return el ? el.offsetTop : 0; }
  function readLine() { return 20; } // the text's top padding: the line the owner reads from
  function setBeat(i, quiet) {
    if (!S.beats.length) return;
    i = C.clamp(i, 0, S.beats.length - 1);
    if (i === S.beatIdx) return;
    S.beatIdx = i;
    $$('.st-beat', prText).forEach(function (el, k) { el.classList.toggle('on', k === i); el.classList.toggle('past', k < i); });
    if (S.autoLayout) {
      var want = C.layoutForBeat(S.beats[i], S.layout);
      if (want !== S.layout) setLayout(want, 'auto');
    }
    if (!quiet) prScroll.setAttribute('aria-label', 'Beat ' + (i + 1) + ' of ' + S.beats.length);
  }
  function goBeat(delta) {
    if (!S.beats.length) return;
    var i = C.clamp((S.beatIdx < 0 ? 0 : S.beatIdx) + delta, 0, S.beats.length - 1);
    S.prTarget = Math.max(0, beatTop(i) - readLine() + 4);
    setBeat(i);
  }
  function prompterTick(dt) {
    if (!S.beats.length) return;
    var max = Math.max(0, prText.scrollHeight - readLine() - 40);
    if (S.prTarget != null) {
      S.prY += (S.prTarget - S.prY) * Math.min(1, dt * 9);
      if (Math.abs(S.prTarget - S.prY) < 0.5) { S.prY = S.prTarget; S.prTarget = null; }
    } else if (S.phase === 'recording' && !S.paused && S.prSpeed > 0) {
      S.prY = Math.min(max, S.prY + S.prSpeed * dt);
      // which beat is on the reading line
      var y = S.prY + readLine(), k = 0;
      for (var i = 0; i < S.beats.length; i++) if (beatTop(i) <= y) k = i;
      setBeat(k);
    }
    prText.style.transform = 'translateY(' + (-S.prY).toFixed(1) + 'px)';
  }
  prScroll.addEventListener('wheel', function (e) {
    if (!S.beats.length) return;
    e.preventDefault(); S.prTarget = null;
    S.prY = Math.max(0, S.prY + e.deltaY * 0.6);
    var y = S.prY + readLine(), k = 0;
    for (var i = 0; i < S.beats.length; i++) if (beatTop(i) <= y) k = i;
    setBeat(k);
  }, { passive: false });
  $('[data-pr-prev]').addEventListener('click', function () { goBeat(-1); });
  $('[data-pr-next]').addEventListener('click', function () { goBeat(1); });
  var spIn = $('[data-pr-speed]'), szIn = $('[data-pr-size]');
  spIn.value = S.prSpeed; szIn.value = S.prSize;
  function syncPrSize() { $('[data-prompter]').style.setProperty('--pr-size', S.prSize + 'px'); }
  syncPrSize();
  spIn.addEventListener('input', function () { S.prSpeed = Number(spIn.value); savePrefs(); });
  szIn.addEventListener('input', function () { S.prSize = Number(szIn.value); syncPrSize(); savePrefs(); });
  $('[data-pr-load]').addEventListener('click', function () {
    var beats = C.beatsFromText($('[data-pr-notes]').value, S.layout);
    if (!beats.length) { toast('Paste a few paragraphs first'); return; }
    S.beats = beats; S.scriptId = null; renderBeats(); toast(beats.length + (beats.length === 1 ? ' beat' : ' beats') + ' in the prompter');
  });
  window.addEventListener('studio:use-script', function (e) {
    var d = (e && e.detail) || {};
    var beats = C.normaliseBeats(d.beats, S.layout);
    if (!beats.length) return;
    S.beats = beats; S.scriptId = d.id ? String(d.id) : null;
    if (d.title && !titleIn.value.trim()) { titleIn.value = String(d.title).slice(0, 140); try { sessionStorage.setItem('studio:title', titleIn.value); } catch (x) { /* blocked */ } }
    renderBeats();
    show('record');
    toast('Script loaded: ' + beats.length + ' beats');
  });
  renderBeats();

  // Float the prompter above every window (Document Picture-in-Picture, Chrome and Edge), so it sits by the camera.
  var popBtn = $('[data-pr-pop]'), pip = null;
  if ('documentPictureInPicture' in window && !GUEST) popBtn.hidden = false;
  popBtn.addEventListener('click', function () {
    if (pip) { pip.close(); return; }
    var el = $('[data-prompter]'), home = el.parentNode, next = el.nextSibling;
    window.documentPictureInPicture.requestWindow({ width: 760, height: 300 }).then(function (w) {
      pip = w;
      ['/assets/glass.css', '/assets/studio.css'].forEach(function (h) { var l = w.document.createElement('link'); l.rel = 'stylesheet'; l.href = h; w.document.head.appendChild(l); });
      w.document.body.className = 'st st-pip';
      w.document.body.appendChild(el);
      w.document.addEventListener('keydown', onKey);
      w.addEventListener('pagehide', function () { home.insertBefore(el, next); pip = null; popBtn.setAttribute('aria-pressed', 'false'); });
      popBtn.setAttribute('aria-pressed', 'true');
    }).catch(function () { toast('The prompter could not float on this browser'); });
  });

  // ───────────── local safety copy (IndexedDB) ─────────────
  var dbP = null;
  function db() {
    if (dbP) return dbP;
    dbP = new Promise(function (res) {
      try {
        var r = indexedDB.open('gl-studio', 1);
        r.onupgradeneeded = function () { var d = r.result; if (!d.objectStoreNames.contains('recs')) d.createObjectStore('recs', { keyPath: 'id' }); if (!d.objectStoreNames.contains('chunks')) d.createObjectStore('chunks', { keyPath: ['rec', 'seq'] }); };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { res(null); };
        r.onblocked = function () { res(null); };
      } catch (e) { res(null); }
    });
    return dbP;
  }
  function tx(store, mode, fn) {
    return db().then(function (d) {
      if (!d) return null;
      return new Promise(function (res) {
        try {
          var t = d.transaction(store, mode), out = fn(t.objectStore(store));
          t.oncomplete = function () { res(out && 'result' in out ? out.result : true); };
          t.onerror = function () { res(null); }; t.onabort = function () { res(null); };
        } catch (e) { res(null); }
      });
    }).catch(function () { return null; });
  }
  function saveRec(rec) { return tx('recs', 'readwrite', function (s) { return s.put(rec); }); }
  function listRecs() { return tx('recs', 'readonly', function (s) { return s.getAll(); }).then(function (r) { return Array.isArray(r) ? r : []; }); }
  function range(id) { return IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]); }
  function putChunk(id, seq, blob) { return tx('chunks', 'readwrite', function (s) { return s.put({ rec: id, seq: seq, blob: blob }); }); }
  function getChunks(id) { return tx('chunks', 'readonly', function (s) { return s.getAll(range(id)); }).then(function (r) { return Array.isArray(r) ? r.sort(function (a, b) { return a.seq - b.seq; }).map(function (x) { return x.blob; }) : null; }); }
  function dropRec(id) { return Promise.all([tx('chunks', 'readwrite', function (s) { return s.delete(range(id)); }), tx('recs', 'readwrite', function (s) { return s.delete(id); })]); }
  function recBlob(rec) {
    if (S.rec && rec.id === S.rec.id && S.mem) return Promise.resolve(new Blob(S.mem, { type: rec.mime }));
    return getChunks(rec.id).then(function (list) { return list && list.length ? new Blob(list, { type: rec.mime }) : null; });
  }
  function slug(s) { return String(s || 'recording').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'recording'; }
  function download(rec) {
    return recBlob(rec).then(function (b) {
      if (!b) { toast('No local copy was found on this computer'); return; }
      var a = document.createElement('a'), url = URL.createObjectURL(b);
      a.href = url; a.download = slug(rec.title) + '-' + String(rec.created || '').slice(0, 10) + '.' + C.extFor(rec.mime);
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    });
  }

  // ───────────── upload ─────────────
  function request(method, path, data, type) {
    return fetch(path, { method: method, body: data, credentials: 'same-origin', headers: type ? { 'content-type': type } : {} }).then(function (r) {
      return r.text().then(function (t) { var j = null; try { j = t ? JSON.parse(t) : {}; } catch (e) { j = { error: t.slice(0, 200) }; } return { status: r.status, json: j }; });
    });
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  var lastRecSave = 0;
  function onUpload(st) {
    if (S.rec) {
      S.rec.uploadId = st.id; S.rec.acked = st.acked; S.rec.partSize = S.uploader ? S.uploader.partSize : S.rec.partSize;
      S.rec.elapsed = S.clock.elapsed(); S.rec.markers = S.markers;
      if (Date.now() - lastRecSave > 2000 || st.failed || st.done) { lastRecSave = Date.now(); saveRec(S.rec); }
    }
    paintUpload(st);
  }
  function paintUpload(st) {
    var box = $('[data-upload]'); box.hidden = false;
    var pct = st.bytesIn ? Math.min(100, Math.round(st.bytesAcked / st.bytesIn * 100)) : 0;
    $('[data-up-fill]').style.width = (st.done ? 100 : pct) + '%';
    box.setAttribute('data-kind', st.failed ? 'bad' : st.done ? 'ok' : '');
    var txt;
    if (st.done) txt = 'Uploaded · ' + mb(st.bytesIn);
    else if (st.failed && S.phase === 'recording') txt = 'Upload paused: ' + st.failed + '. The recording is kept on this computer and the upload tries again.';
    else if (st.failed) txt = 'Upload stopped: ' + st.failed;
    else if (!st.id) txt = 'Starting the upload';
    else if (S.phase === 'recording') txt = 'Uploading as you record · ' + st.acked + (st.acked === 1 ? ' part' : ' parts') + ' sent · ' + mb(st.bytesAcked) + ' of ' + mb(st.bytesIn) + (st.queued > 1 ? ' · catching up' : '');
    else txt = 'Finishing the upload · ' + mb(st.bytesAcked) + ' of ' + mb(st.bytesIn);
    $('[data-up-text]').textContent = txt;
    var bar = $('[data-sheet] [data-fin-fill]'); if (bar) { bar.style.width = (st.done ? 100 : pct) + '%'; var ft = $('[data-sheet] [data-fin-text]'); if (ft) ft.textContent = mb(st.bytesAcked) + ' of ' + mb(st.bytesIn); }
  }
  var createRetryT = null;
  function keepCreating() {
    clearTimeout(createRetryT);
    if (!S.uploader || S.uploader.id || S.phase !== 'recording') return;
    createRetryT = setTimeout(function () { if (S.uploader && !S.uploader.id && S.phase === 'recording') { S.uploader.failed = null; S.uploader.start().catch(keepCreating); } }, 20000);
  }
  var partRetryT = null;
  function keepSending() {
    clearTimeout(partRetryT);
    partRetryT = setTimeout(function () {
      if (S.uploader && S.uploader.failed && S.uploader.id && S.phase === 'recording') { S.uploader.retry().then(keepSending); }
    }, 20000);
  }

  // ───────────── recording ─────────────
  function setPhase(p) {
    S.phase = p;
    body.setAttribute('data-phase', p);
    var rec = p === 'recording';
    $('[data-record]').hidden = rec || p === 'countdown';
    $('[data-pause]').hidden = !rec; $('[data-stop]').hidden = !(rec || p === 'countdown');
    $$('[data-mark]').forEach(function (b) { b.disabled = !rec; });
    $('[data-recpill]').hidden = !rec;
    $('[data-record]').disabled = GUEST || !supported || p !== 'idle';
    $('[data-stop] span').textContent = p === 'countdown' ? 'Cancel' : 'Stop';
    syncLayoutLocks();
    if (p === 'idle') status(GUEST || !supported ? 'View only' : S.screen ? 'Ready' : 'Choose a screen', '');
  }
  function countdown() {
    return new Promise(function (res) {
      var el = $('[data-count]'), n = 3;
      el.hidden = false;
      var cancel = function () { clearInterval(iv); el.hidden = true; S.cancelCount = null; res(false); };
      S.cancelCount = cancel;
      var paint = function () { el.innerHTML = '<span>' + n + '</span>'; };
      paint(); status('Starting in ' + n, 'rec');
      var iv = setInterval(function () {
        n--;
        if (n <= 0) { clearInterval(iv); el.hidden = true; S.cancelCount = null; res(true); return; }
        paint(); status('Starting in ' + n, 'rec');
      }, 1000);
    });
  }
  function startRecording() {
    if (GUEST || !supported || S.phase !== 'idle') return;
    audioCtx();
    setPhase('countdown');
    var ready = (S.cam ? Promise.resolve(true) : camOn()).then(function () { return S.screen ? true : pickScreen(); });
    ready.then(function (ok) {
      if (!ok) { setPhase('idle'); return; }
      sizeCanvas();
      return countdown().then(function (go) { if (!go) { setPhase('idle'); return; } begin(); });
    }).catch(function (e) { setPhase('idle'); toast('Recording did not start: ' + ((e && e.message) || 'unknown')); });
  }
  function begin() {
    var W = canvas.width, H = canvas.height, fps = S.fps;
    var mime = C.pickMime(function (t) { return MediaRecorder.isTypeSupported(t); }, W, H, fps);
    var vs = canvas.captureStream(fps), tracks = vs.getVideoTracks();
    if (S.dest) tracks = tracks.concat(S.dest.stream.getAudioTracks());
    var recorder;
    try { recorder = new MediaRecorder(new MediaStream(tracks), { mimeType: mime || undefined, videoBitsPerSecond: C.bitrateFor(W, H, fps), audioBitsPerSecond: 192000 }); }
    catch (e) { setPhase('idle'); toast('This browser could not start the recorder: ' + e.message); return; }
    mime = recorder.mimeType || mime || 'video/webm';
    var id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
    var title = titleIn.value.trim() || 'Untitled recording';
    S.rec = { id: id, title: title, layout: S.layout, mime: mime, width: W, height: H, fps: fps, created: new Date().toISOString(), uploadId: null, partSize: null, acked: 0, elapsed: 0, markers: [], status: 'recording', scriptId: S.scriptId };
    S.mem = null; S.chunkSeq = 0; S.markers = []; renderMarkers(); $('[data-timer]').textContent = '0:00';
    saveRec(S.rec).then(function (ok) { if (!ok) S.mem = S.mem || []; });
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {}); } catch (e) { /* not offered */ }
    var meta = { title: title, layout: S.layout, mime: mime, width: W, height: H };
    if (S.scriptId) meta.script_id = S.scriptId;
    S.uploader = new C.Uploader(meta, { request: request, sleep: sleep, onState: onUpload });
    S.uploader.start().catch(keepCreating);
    recorder.ondataavailable = function (e) {
      if (!e.data || !e.data.size) return;
      var seq = S.chunkSeq++;
      if (S.mem) S.mem.push(e.data);
      else putChunk(S.rec.id, seq, e.data).then(function (ok) { if (!ok && !S.mem) { S.mem = []; toast('This browser is not keeping a local copy; the upload carries the recording'); } });
      S.uploader.push(e.data);
      if (S.uploader.failed && S.uploader.id) keepSending();
    };
    S.recorder = recorder;
    S.stopped = new Promise(function (res) { recorder.onstop = res; });
    recorder.onerror = function (e) { toast('The recorder stopped: ' + ((e.error && e.error.message) || 'error')); stopRecording(); };
    recorder.start(1000);
    S.clock.begin(); S.paused = false;
    setPhase('recording'); status('Recording 0:00', 'rec');
    $('[data-pause]').setAttribute('aria-label', 'Pause');
    if (S.beats.length) { S.prY = Math.max(0, beatTop(Math.max(0, S.beatIdx)) - readLine() + 4); }
  }
  function togglePause() {
    if (S.phase !== 'recording' || !S.recorder) return;
    if (!S.paused) { try { S.recorder.pause(); } catch (e) { return; } S.clock.pause(); S.paused = true; body.classList.add('paused'); status('Paused', 'pause'); }
    else { try { S.recorder.resume(); } catch (e) { return; } S.clock.resume(); S.paused = false; body.classList.remove('paused'); }
    var b = $('[data-pause]'); b.setAttribute('aria-label', S.paused ? 'Resume' : 'Pause'); b.title = S.paused ? 'Resume (Space)' : 'Pause (Space)';
    b.classList.toggle('on', S.paused);
  }
  function stopRecording() {
    if (S.phase === 'countdown') { if (S.cancelCount) S.cancelCount(); return; }
    if (S.phase !== 'recording' || !S.recorder) return;
    var duration = S.clock.elapsed();
    S.clock.pause(); body.classList.remove('paused');
    setPhase('finishing'); status('Uploading', 'up');
    try { if (S.recorder.state !== 'inactive') S.recorder.stop(); } catch (e) { /* already stopped */ }
    S.rec.elapsed = duration; S.rec.markers = S.markers.slice(); S.rec.status = 'stopped'; saveRec(S.rec);
    clearTimeout(createRetryT); clearTimeout(partRetryT);
    sheet('<h2 id="st-sheet-h">Finishing the upload</h2><p class="st-sub">Most of it went up while you recorded. Sending the last part now.</p><div class="st-up-bar big"><i data-fin-fill></i></div><p class="st-sub" data-fin-text></p>');
    paintUpload(S.uploader.state());
    S.stopped.then(function () { return finishUpload(S.rec, S.uploader); });
  }
  function finishUpload(rec, up, done) {
    return (done ? Promise.resolve(done) : up.finish(rec.elapsed, rec.markers)).then(function (r) {
      if (r.ok) {
        rec.status = 'done'; dropRec(rec.id).then(checkRecover);
        sheet(null); status('Uploaded', 'ok');
        S.rec = null; S.mem = null; S.uploader = null;
        setPhase('idle'); status('Uploaded', 'ok');
        toast('Uploaded. The edit starts on its own.');
        show('pipeline');
        window.dispatchEvent(new CustomEvent('studio:uploaded', { detail: { id: r.id } }));
        return;
      }
      if (r.empty) { sheet(null); dropRec(rec.id); setPhase('idle'); toast('Nothing was recorded'); if (r.id) request('POST', '/admin/api/studio/uploads/' + encodeURIComponent(r.id) + '/abort', '{}', 'application/json').catch(function () {}); return; }
      rec.status = 'failed'; rec.error = r.error; saveRec(rec);
      setPhase('idle'); status('Upload stopped', 'bad');
      failedSheet(rec, up, r.error);
    });
  }
  function failedSheet(rec, up, err) {
    var sh = sheet('<h2 id="st-sheet-h">The upload did not finish</h2><p>Your recording is safe on this computer. Retry when the connection is back, or download a copy.</p>' +
      '<p class="st-sub">' + esc(err || '') + '</p><div class="st-sheet-actions"><button type="button" class="st-btn primary" data-retry>Retry upload</button><button type="button" class="st-btn" data-dl>Download a local copy</button><button type="button" class="st-btn quiet" data-close>Close</button></div>');
    sh.querySelector('[data-retry]').addEventListener('click', function () {
      sheet('<h2 id="st-sheet-h">Finishing the upload</h2><div class="st-up-bar big"><i data-fin-fill></i></div><p class="st-sub" data-fin-text></p>');
      setPhase('finishing'); status('Uploading', 'up');
      up.failed = null; S.uploader = up; S.rec = rec;
      finishUpload(rec, up);
    });
    sh.querySelector('[data-dl]').addEventListener('click', function () { download(rec); });
    sh.querySelector('[data-close]').addEventListener('click', function () { sheet(null); checkRecover(); });
  }

  // Recordings from an earlier visit that never finished uploading.
  function checkRecover() {
    var box = $('[data-recover]');
    if (GUEST) { box.hidden = true; return; }
    listRecs().then(function (recs) {
      recs = recs.filter(function (r) { return r.status !== 'done' && (!S.rec || r.id !== S.rec.id); }).sort(function (a, b) { return String(b.created).localeCompare(String(a.created)); }).slice(0, 3);
      if (!recs.length) { box.hidden = true; box.innerHTML = ''; return; }
      box.hidden = false;
      box.innerHTML = recs.map(function (r) {
        var when = new Date(r.created); var label = isNaN(when) ? '' : when.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
        return '<div class="st-rc" data-rid="' + esc(r.id) + '"><p><b>' + esc(r.title) + '</b><span>' + esc(label) + ' · ' + C.fmtTime(r.elapsed) + ' · not uploaded yet</span></p>' +
          '<button type="button" class="st-btn primary" data-rc="retry">Retry upload</button><button type="button" class="st-btn" data-rc="dl">Download a local copy</button><button type="button" class="st-btn quiet" data-rc="drop">Discard</button></div>';
      }).join('');
      $$('[data-rc]', box).forEach(function (b) {
        b.addEventListener('click', function () {
          var id = b.closest('[data-rid]').getAttribute('data-rid'), rec = recs.filter(function (r) { return r.id === id; })[0];
          if (!rec) return;
          var act = b.getAttribute('data-rc');
          if (act === 'dl') download(rec);
          else if (act === 'drop') { if (confirm('Discard this recording from this computer? It was not uploaded.')) dropRec(id).then(checkRecover); }
          else resumeUpload(rec);
        });
      });
    });
  }
  function resumeUpload(rec) {
    if (S.phase !== 'idle') { toast('Finish the current recording first'); return; }
    recBlob(rec).then(function (blob) {
      if (!blob) { toast('No local copy was found on this computer'); return; }
      var meta = { title: rec.title, layout: rec.layout, mime: rec.mime, width: rec.width, height: rec.height };
      if (rec.scriptId) meta.script_id = rec.scriptId;
      var resumable = rec.uploadId && rec.partSize;
      var up = new C.Uploader(meta, { request: request, sleep: sleep, onState: onUpload }, resumable ? { id: rec.uploadId, partSize: rec.partSize, skipThrough: rec.acked || 0 } : {});
      S.rec = rec; S.uploader = up;
      setPhase('finishing'); status('Uploading', 'up');
      sheet('<h2 id="st-sheet-h">Uploading the recording</h2><div class="st-up-bar big"><i data-fin-fill></i></div><p class="st-sub" data-fin-text></p>');
      var go = function (u) { return u.start().then(function () { u.push(blob); return finishUpload(rec, u); }, function () { return finishUpload(rec, u); }); };
      if (!resumable) { go(up); return; }
      // The earlier upload session may have expired: if its parts are refused, start a fresh one.
      up.start().then(function () { up.push(blob); return up.finish(rec.elapsed, rec.markers); }).then(function (r) {
        if (r.ok || r.empty) return finishUpload(rec, up, r);
        var fresh = new C.Uploader(meta, { request: request, sleep: sleep, onState: onUpload });
        rec.uploadId = null; rec.acked = 0; rec.partSize = null; S.uploader = fresh;
        return go(fresh);
      });
    });
  }

  // ───────────── markers ─────────────
  function mark(kind) {
    if (S.phase !== 'recording') return;
    var t = S.clock.elapsed();
    S.markers = C.addMarker(S.markers, kind, t);
    var m = S.markers[S.markers.length - 1];
    renderMarkers();
    toast(kind === 'retake' ? 'Retake at ' + C.fmtTime(t) + ': the edit cuts back to the previous marker' : (m.label || C.MARKER_LABEL[kind]) + ' at ' + C.fmtTime(t));
    var chip = $('[data-mark="' + kind + '"]'); chip.classList.remove('flash'); void chip.offsetWidth; chip.classList.add('flash');
  }
  function renderMarkers() {
    var ol = $('[data-markers]');
    if (!S.markers.length) { ol.innerHTML = '<li class="st-empty">Markers you add while recording appear here.</li>'; return; }
    ol.innerHTML = S.markers.map(function (m) { return '<li data-kind="' + m.kind + '"><time>' + C.fmtTime(m.t) + '</time><span>' + esc(m.label || C.MARKER_LABEL[m.kind]) + '</span></li>'; }).join('');
    ol.scrollTop = ol.scrollHeight;
  }
  $$('[data-mark]').forEach(function (b) { b.addEventListener('click', function () { mark(b.getAttribute('data-mark')); }); });

  // ───────────── controls and keys ─────────────
  $('[data-record]').addEventListener('click', startRecording);
  $('[data-pause]').addEventListener('click', togglePause);
  $('[data-stop]').addEventListener('click', stopRecording);
  function typing(t) { return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)); }
  function onKey(e) {
    if (current !== 'record' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!$('[data-sheet]').hidden) return;
    if (e.key === 'Escape') { if (S.phase === 'recording' || S.phase === 'countdown') { e.preventDefault(); stopRecording(); } return; }
    if (typing(e.target)) return;
    var k = e.key.toLowerCase();
    if (/^[1-6]$/.test(k)) { setLayout(C.LAYOUTS[Number(k) - 1].id); e.preventDefault(); return; }
    if (k === ' ') { if (S.phase === 'recording') { togglePause(); e.preventDefault(); } return; }
    if (k === 'm') mark('chapter');
    else if (k === 'r') mark('retake');
    else if (k === 'h') mark('highlight');
    else if (k === 'z') toggleZoom();
    else if (k === 'arrowdown' || k === 'arrowright') { if (S.beats.length) { goBeat(1); e.preventDefault(); } }
    else if (k === 'arrowup' || k === 'arrowleft') { if (S.beats.length) { goBeat(-1); e.preventDefault(); } }
  }
  document.addEventListener('keydown', onKey);
  window.addEventListener('beforeunload', function (e) { if (S.phase === 'recording' || S.phase === 'finishing') { e.preventDefault(); e.returnValue = ''; } });

  // ───────────── per-frame UI (timer, meter) ─────────────
  var lastUi = 0;
  function uiTick() {
    var now = performance.now(); if (now - lastUi < 120) return; lastUi = now;
    var t = S.clock.elapsed();
    if (S.phase === 'recording') {
      $('[data-timer]').textContent = C.fmtTime(t);
      if (!S.paused) status('Recording ' + C.fmtTime(t), 'rec');
    }
    var lv = Math.round(S.level * 100);
    $('[data-meter]').style.transform = 'scaleX(' + (S.level).toFixed(3) + ')';
    $('[data-meter-wrap]').setAttribute('aria-valuenow', String(lv));
  }

  // ───────────── start ─────────────
  $$('[data-layout]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-layout') === S.layout)); });
  sizeCanvas(); syncMap(); setPhase('idle');
  if (GUEST) {
    note('Guest view: recording is for the owner. You can follow the pipeline and read the scripts.');
    $$('[data-pick-screen], [data-cam-on], [data-cam], [data-mic], [data-pr-pop]').forEach(function (b) { b.disabled = true; });
  } else if (!supported) {
    note('Recording works in desktop Chrome, Edge or Safari. On this device you can follow the pipeline and read the scripts.');
    $$('[data-pick-screen]').forEach(function (b) { b.disabled = true; });
  } else {
    listDevices();
    // Camera already allowed for this site: start the preview straight away.
    try {
      navigator.permissions.query({ name: 'camera' }).then(function (p) { if (p.state === 'granted') camOn(); }).catch(function () {});
    } catch (e) { /* the Permissions API does not know "camera" here */ }
    checkRecover();
  }
  window.studio.record = { state: function () { return { phase: S.phase, layout: S.layout, w: canvas.width, h: canvas.height, markers: S.markers.slice(), upload: S.uploader ? S.uploader.state() : null }; } };
})();
