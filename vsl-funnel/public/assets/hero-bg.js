/* Hero background: a slow 3D "deal network" (points + connections rotating in
 * depth) over a perspective grid floor that glides towards the viewer. Drawn
 * on a canvas behind the VSL in faint navy so it adds depth without pulling
 * focus. Pauses off-screen / in background tabs; static for reduced motion. */
(function () {
  'use strict';
  var canvas = document.querySelector('[data-hero-canvas]');
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext('2d');
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var dark = document.documentElement.getAttribute('data-palette') === 'ink';
  var ink = dark ? '200,215,255' : '15,44,92';

  var W = 0, H = 0, DPR = 1, running = true, visible = true, t0 = performance.now();
  var N = 0, pts = [];

  function seed() {
    // Fewer points on small screens; spread in a wide, shallow volume.
    N = Math.round(Math.min(120, Math.max(44, (W * H) / 11000)));
    pts = [];
    for (var i = 0; i < N; i++) {
      pts.push({ x: (Math.random() - 0.5) * 4.6, y: (Math.random() - 0.5) * 2.2, z: (Math.random() - 0.5) * 3.2, r: 0.6 + Math.random() * 1.2, p: Math.random() * Math.PI * 2 });
    }
  }

  function size() {
    var rect = canvas.getBoundingClientRect();
    DPR = Math.min(2, window.devicePixelRatio || 1);
    W = Math.max(1, rect.width); H = Math.max(1, rect.height);
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    if (!pts.length) seed();
  }

  function grid(t) {
    // Perspective floor: horizon just above the middle, lines converge to a vanishing point.
    var horizon = H * 0.52, vx = W / 2, depth = H - horizon;
    ctx.lineWidth = 1;
    // Receding horizontal lines, scrolling towards the viewer.
    var rows = 14, shift = (t * 0.00006) % 1;
    for (var i = 0; i < rows; i++) {
      var k = (i + shift) / rows;              // 0 (far) → 1 (near)
      var y = horizon + depth * k * k;
      var a = 0.02 + 0.10 * k * k;
      ctx.strokeStyle = 'rgba(' + ink + ',' + a.toFixed(3) + ')';
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    // Converging verticals.
    var cols = 22;
    for (var j = -cols; j <= cols; j++) {
      var xNear = vx + (j / cols) * W * 1.6;
      var g = ctx.createLinearGradient(0, horizon, 0, H);
      g.addColorStop(0, 'rgba(' + ink + ',0)');
      g.addColorStop(1, 'rgba(' + ink + ',0.09)');
      ctx.strokeStyle = g;
      ctx.beginPath(); ctx.moveTo(vx + (j / cols) * W * 0.08, horizon); ctx.lineTo(xNear, H); ctx.stroke();
    }
  }

  function network(t) {
    var ang = t * 0.00004, cos = Math.cos(ang), sin = Math.sin(ang);
    var tilt = 0.28, ct = Math.cos(tilt), st = Math.sin(tilt);
    var f = Math.min(W, H * 1.6) * 0.62, cx = W / 2, cy = H * 0.46;
    var proj = new Array(N);
    for (var i = 0; i < N; i++) {
      var p = pts[i];
      var bob = Math.sin(t * 0.0006 + p.p) * 0.03;
      // rotate around Y, then tilt around X
      var x = p.x * cos - p.z * sin, z = p.x * sin + p.z * cos, y = p.y + bob;
      var y2 = y * ct - z * st, z2 = y * st + z * ct + 3.2;
      var s = f / z2;
      proj[i] = { x: cx + x * s, y: cy + y2 * s, d: z2, s: s, r: p.r };
    }
    // Connections between near neighbours (in 3D), fading with distance and depth.
    ctx.lineWidth = 1;
    for (var a = 0; a < N; a++) {
      for (var b = a + 1; b < N; b++) {
        var dx = pts[a].x - pts[b].x, dy = pts[a].y - pts[b].y, dz = pts[a].z - pts[b].z;
        var dist = dx * dx + dy * dy + dz * dz;
        if (dist > 0.3) continue;
        var depth = 1 - Math.min(1, (proj[a].d + proj[b].d - 4.4) / 4);
        var alpha = (1 - dist / 0.3) * 0.22 * (0.35 + 0.65 * depth);
        if (alpha < 0.01) continue;
        ctx.strokeStyle = 'rgba(' + ink + ',' + alpha.toFixed(3) + ')';
        ctx.beginPath(); ctx.moveTo(proj[a].x, proj[a].y); ctx.lineTo(proj[b].x, proj[b].y); ctx.stroke();
      }
    }
    for (var k = 0; k < N; k++) {
      var q = proj[k];
      var dd = 1 - Math.min(1, (q.d - 2) / 2.6);
      ctx.fillStyle = 'rgba(' + ink + ',' + (0.16 + 0.42 * dd).toFixed(3) + ')';
      ctx.beginPath(); ctx.arc(q.x, q.y, q.r * (0.6 + dd), 0, Math.PI * 2); ctx.fill();
    }
  }

  function frame(now) {
    if (!running) return;
    var t = now - t0;
    ctx.clearRect(0, 0, W, H);
    grid(t);
    network(t);
    if (!reduce && visible) requestAnimationFrame(frame);
  }

  function start() { if (reduce) { frame(performance.now()); return; } running = true; requestAnimationFrame(frame); }

  size();
  start();
  var rt;
  addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { var w = W; size(); if (Math.abs(w - W) > 120) seed(); if (reduce) frame(performance.now()); }, 150); });
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (e) { var was = visible; visible = e[0].isIntersecting; if (visible && !was && !reduce) requestAnimationFrame(frame); }).observe(canvas);
  }
  document.addEventListener('visibilitychange', function () { var was = visible; visible = !document.hidden; if (visible && !was && !reduce) requestAnimationFrame(frame); });
})();
