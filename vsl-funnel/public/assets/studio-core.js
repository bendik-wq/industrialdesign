/* G&L Studio, the recorder's pure logic (no DOM, no media): layout geometry for the six face-cam layouts, the
   morph between them, perspective strips for the tilted screen card, output size, bitrate and container choice,
   the exact-size part buffer and the uploader that sends parts while recording. studio.js draws and records;
   this file only computes, so test/studio-recorder.test.ts runs it in Node.
   Loaded as a classic script (window.StudioCore) and readable as CommonJS by the tests. */
(function (root) {
  'use strict';

  var LAYOUTS = [
    { id: 'orbit', key: '1', label: 'Orbit', hint: 'Face bubble over your screen' },
    { id: 'split', key: '2', label: 'Split', hint: 'Screen left, portrait face card right' },
    { id: 'spotlight', key: '3', label: 'Spotlight', hint: 'You fill the frame, the screen floats beside you' },
    { id: 'stage', key: '4', label: 'Stage', hint: 'Screen full size, presenter card bottom left' },
    { id: 'vertical', key: '5', label: 'Vertical', hint: '9:16 for Shorts and Reels' },
    { id: 'cinema', key: '6', label: 'Cinema', hint: 'Letterboxed 2.39:1 with a title band' },
  ];
  var IDS = LAYOUTS.map(function (l) { return l.id; });
  var MAX_W = 3840, MAX_H = 2160;
  var MORPH_MS = 360;
  var CINEMA = 2.39;
  var ORBIT_D = { s: 200, m: 280, l: 360 };

  function even(n) { n = Math.max(2, Math.round(n)); return n % 2 ? n - 1 : n; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  /** The canvas size: the source's own resolution (up to 3840x2160, never upscaled); 9:16 for vertical. */
  function outputSize(layout, srcW, srcH) {
    srcW = srcW || 1920; srcH = srcH || 1080;
    if (layout === 'vertical') return srcH >= 2160 && srcW >= 3840 ? { w: 2160, h: 3840 } : { w: 1080, h: 1920 };
    var s = Math.min(1, MAX_W / srcW, MAX_H / srcH);
    return { w: even(srcW * s), h: even(srcH * s) };
  }

  /** About 0.1 bit per pixel per frame, kept between 8 and 45 Mbps. */
  function bitrateFor(w, h, fps) { return Math.round(clamp(0.1 * w * h * fps, 8e6, 45e6)); }

  /** MP4 (H.264 High + AAC) where the browser records it, else WebM VP9/Opus. 4K60 asks for level 5.2 first. */
  function mimeCandidates(w, h, fps) {
    var list = [];
    if (w * h > 1920 * 1088 && fps > 30) list.push('video/mp4;codecs=avc1.640034,mp4a.40.2');
    list.push('video/mp4;codecs=avc1.640033,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4');
    return list;
  }
  function pickMime(isSupported, w, h, fps) {
    var c = mimeCandidates(w, h, fps);
    for (var i = 0; i < c.length; i++) { try { if (isSupported(c[i])) return c[i]; } catch (e) { /* next */ } }
    return '';
  }
  function extFor(mime) { return /mp4/.test(mime || '') ? 'mp4' : 'webm'; }

  // ───────────── motion ─────────────

  /** A damped spring from 0 to 1 over t in [0, 1]: a small overshoot (about 3%), settled exactly at 1. */
  function spring(t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    var z = 0.72, w = 11, wd = w * Math.sqrt(1 - z * z);
    var x = 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + (z * w / wd) * Math.sin(wd * t));
    var tail = 0.85; // blend the last stretch onto 1 so the frame at t=1 is exact
    return t < tail ? x : x + (1 - x) * ((t - tail) / (1 - tail));
  }
  function ease(t) { t = clamp(t, 0, 1); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  /** Numbers interpolate; anything else (strings, booleans) flips at the halfway point. */
  function lerpGeom(a, b, t) {
    if (typeof a === 'number' && typeof b === 'number') return lerp(a, b, t);
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      var o = {};
      Object.keys(b).forEach(function (k) { o[k] = k in a ? lerpGeom(a[k], b[k], t) : b[k]; });
      return o;
    }
    return t < 0.5 ? a : b;
  }

  // ───────────── layouts ─────────────

  /** The largest rect of `aspect` inside bw x bh. */
  function fit(aspect, bw, bh) { var w = bw, h = bw / aspect; if (h > bh) { h = bh; w = bh * aspect; } return { w: w, h: h }; }

  function corner(c, W, H, d, m) {
    var x = /l/.test(c) ? m : W - m - d, y = /t/.test(c) ? m : H - m - d;
    return { x: x, y: y };
  }
  /** The nearest corner to a point (for dragging the orbit bubble). */
  function nearestCorner(x, y, W, H) { return (y < H / 2 ? 't' : 'b') + (x < W / 2 ? 'l' : 'r'); }

  var HIDDEN = { op: 0 };
  function base() {
    return {
      bgDark: 0,
      screen: { x: 0, y: 0, w: 0, h: 0, r: 0, tilt: 0, op: 1, glass: 0, shadow: 0 },
      face: { x: 0, y: 0, w: 0, h: 0, r: 0, op: 1, ring: 0, shadow: 0, rim: 0 },
      faceTop: true, grade: 0, seam: 0,
      lt: { op: 0 }, tag: { op: 0 }, band: { op: 0, y: 0, h: 0 }, title: { op: 0, x: 0, y: 0 }, vtitle: { op: 0, y: 0 },
    };
  }

  /**
   * Where everything sits in one layout, in canvas pixels. o: { srcAspect, camAspect, corner, size }.
   * u is one design pixel at 1080p, so a 4K canvas gets the same composition at twice the detail.
   */
  function layoutGeometry(id, W, H, o) {
    o = o || {};
    var src = o.srcAspect || W / H, cam = o.camAspect || 16 / 9;
    var g = base(), u, m;
    if (id === 'vertical') {
      u = W / 1080; m = 40 * u;
      g.face = { x: 0, y: 0, w: W, h: H * 0.5, r: 0, op: 1, ring: 0, shadow: 0, rim: 0 };
      var ch = H * 0.38;
      g.screen = { x: m, y: H * 0.5 - 36 * u, w: W - 2 * m, h: ch, r: 30 * u, tilt: 0, op: 1, glass: 1, shadow: 1 };
      g.faceTop = false; g.seam = 1;
      g.vtitle = { op: 1, y: g.screen.y + ch + 92 * u };
      return g;
    }
    u = Math.min(W / 1920, H / 1080);
    if (id === 'orbit') {
      var d = (ORBIT_D[o.size] || ORBIT_D.m) * u; m = 44 * u;
      var p = corner(o.corner || 'br', W, H, d, m);
      g.screen = { x: 0, y: 0, w: W, h: H, r: 0, tilt: 0, op: 1, glass: 0, shadow: 0 };
      g.face = { x: p.x, y: p.y, w: d, h: d, r: d / 2, op: 1, ring: 1, shadow: 1, rim: 0 };
    } else if (id === 'split') {
      m = 36 * u; var gap = 28 * u;
      var boxW = W * 0.68 - m - gap / 2, top = 96 * u;
      var s = fit(src, boxW, H - top - m);
      var sy = Math.max(top, (H - s.h) / 2 + 24 * u);
      g.screen = { x: m + (boxW - s.w) / 2, y: sy, w: s.w, h: s.h, r: 22 * u, tilt: 0, op: 1, glass: 1, shadow: 1 };
      var fx = W * 0.68 + gap / 2;
      g.face = { x: fx, y: m, w: W - m - fx, h: H - 2 * m, r: 28 * u, op: 1, ring: 0, shadow: 1, rim: 1 };
      g.lt = { op: 1 };
      g.title = { op: 1, x: g.screen.x, y: sy - 30 * u };
    } else if (id === 'spotlight') {
      // a gentle push-in so the face can sit left of centre; any sliver the camera does not reach on the right is
      // under the darkest part of the grade, where the card floats
      var cx = 0.40 * W, fw = Math.max(W, H * cam) * 1.14, fh = fw / cam;
      var x0 = Math.min(0, cx - fw / 2);
      g.face = { x: x0, y: (H - fh) / 2 - 0.04 * H, w: fw, h: fh, r: 0, op: 1, ring: 0, shadow: 0, rim: 0 };
      var c = fit(src, 0.45 * W, 0.62 * H);
      g.screen = { x: 0.715 * W - c.w / 2, y: 0.5 * H - c.h / 2, w: c.w, h: c.h, r: 18 * u, tilt: -17, op: 1, glass: 1, shadow: 1 };
      g.faceTop = false; g.grade = 1;
    } else if (id === 'stage') {
      m = 48 * u; var pw = 500 * u, ph = pw * 9 / 16;
      g.screen = { x: 0, y: 0, w: W, h: H, r: 0, tilt: 0, op: 1, glass: 0, shadow: 0 };
      g.face = { x: m, y: H - m - ph, w: pw, h: ph, r: 26 * u, op: 1, ring: 0, shadow: 1, rim: 1 };
      g.tag = { op: 1 };
    } else if (id === 'cinema') {
      var bh = Math.min(H, W / CINEMA), by = (H - bh) / 2;
      m = 40 * u;
      g.bgDark = 1;
      g.screen = { x: 0, y: by, w: W, h: bh, r: 0, tilt: 0, op: 1, glass: 0, shadow: 0 };
      var iw = 300 * u, ih = iw * 3 / 4;
      g.face = { x: W - m - iw, y: by + bh - m - ih, w: iw, h: ih, r: 18 * u, op: 1, ring: 0, shadow: 1, rim: 1 };
      g.band = { op: 1, y: by + bh, h: H - by - bh };
    }
    return g;
  }

  /** The aspect of the vertical layout's screen card, which the owner's crop region keeps. */
  function verticalCropAspect(W, H) { var g = layoutGeometry('vertical', W || 1080, H || 1920); return g.screen.w / g.screen.h; }

  /**
   * A source rect (in source pixels) that covers a destination of aspect `dstAspect`, centred on a focus point
   * (fx, fy in 0..1 of the region), zoomed by z (1 = the whole region), inside region r (normalised 0..1).
   */
  function coverSource(sw, sh, dstAspect, fx, fy, z, r) {
    r = r || { x: 0, y: 0, w: 1, h: 1 };
    var rw = sw * r.w, rh = sh * r.h, rx = sw * r.x, ry = sh * r.y;
    var w = rw, h = rw / dstAspect;
    if (h > rh) { h = rh; w = rh * dstAspect; }
    z = Math.max(1, z || 1); w /= z; h /= z;
    var x = rx + clamp(rw * (fx == null ? 0.5 : fx) - w / 2, 0, rw - w);
    var y = ry + clamp(rh * (fy == null ? 0.5 : fy) - h / 2, 0, rh - h);
    return { x: x, y: y, w: w, h: h };
  }
  /** The face: centre-weighted, a touch above centre (eyes sit on the upper third), a slight push in. */
  function faceSource(cw, ch, dstAspect) { return coverSource(cw, ch, dstAspect, 0.5, 0.44, 1.06); }

  /** A normalised region of fixed aspect (in pixels of a sw x sh source), moved to centre (cx, cy), kept inside. */
  function placeRegion(sw, sh, aspect, widthFrac, cx, cy) {
    var w = clamp(widthFrac, 0.1, 1), h = (w * sw / aspect) / sh;
    if (h > 1) { h = 1; w = (aspect * sh) / sw; }
    return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w: w, h: h };
  }
  /** The 2x zoom window around a point, as a normalised region. */
  function zoomRegion(cx, cy, factor) { var s = 1 / (factor || 2); return { x: clamp(cx - s / 2, 0, 1 - s), y: clamp(cy - s / 2, 0, 1 - s), w: s, h: s }; }
  function lerpRegion(a, b, t) { return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t) }; }

  /**
   * Perspective strips for a card turned `deg` about its vertical axis (negative turns the left edge away).
   * Each strip maps a slice of the source (u0..u1 of its width) to a destination column with its own height,
   * so drawing them side by side is a true perspective projection with straight, converging top and bottom edges.
   */
  function tiltStrips(rect, deg, n, focal) {
    n = n || 96;
    var th = deg * Math.PI / 180, f = (focal || 2.4) * rect.w, cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    function at(u) {
      var X = (u - 0.5) * rect.w, Z = X * Math.sin(th), s = f / (f + Z);
      return { x: cx + X * Math.cos(th) * s, h: rect.h * s };
    }
    var out = [], prev = at(0);
    for (var i = 0; i < n; i++) {
      var nx = at((i + 1) / n);
      var h = Math.max(prev.h, nx.h);
      out.push({ u0: i / n, u1: (i + 1) / n, x: prev.x, w: nx.x - prev.x, y: cy - h / 2, h: h });
      prev = nx;
    }
    var a = at(0), b = at(1);
    return { strips: out, quad: [{ x: a.x, y: cy - a.h / 2 }, { x: b.x, y: cy - b.h / 2 }, { x: b.x, y: cy + b.h / 2 }, { x: a.x, y: cy + a.h / 2 }], scaleL: a.h / rect.h, scaleR: b.h / rect.h };
  }

  // ───────────── audio level ─────────────

  /** RMS of a time-domain buffer to 0..1 (-54 dB is silence, -12 dB is full). */
  function levelFromSamples(buf) {
    var s = 0; for (var i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    var rms = Math.sqrt(s / (buf.length || 1)), db = 20 * Math.log10(rms || 1e-9);
    return clamp((db + 54) / 42, 0, 1);
  }
  /** Fast attack, slow release, so the ring breathes with the voice instead of flickering. */
  function smoothLevel(prev, next) { return next > prev ? prev + (next - prev) * 0.5 : prev + (next - prev) * 0.08; }

  // ───────────── time and markers ─────────────

  function fmtTime(s) {
    s = Math.max(0, Math.floor(s || 0));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (x < 10 ? '0' : '') + x;
  }
  var MARKER_LABEL = { chapter: 'Chapter', retake: 'Retake', highlight: 'Highlight' };
  /** A marker at recorded time t (seconds, pauses excluded), rounded to a tenth. Chapters are numbered. */
  function addMarker(list, kind, t, label) {
    if (!MARKER_LABEL[kind]) return list;
    var mk = { t: Math.round(Math.max(0, t) * 10) / 10, kind: kind };
    if (kind === 'chapter') mk.label = label || ('Chapter ' + (list.filter(function (x) { return x.kind === 'chapter'; }).length + 1));
    else if (label) mk.label = label;
    return list.concat([mk]);
  }

  /** A clock that leaves out paused time. */
  function Clock(now) {
    this.now = now || function () { return Date.now(); };
    this.start = 0; this.pausedAt = 0; this.paused = 0; this.running = false;
  }
  Clock.prototype.begin = function () { this.start = this.now(); this.paused = 0; this.pausedAt = 0; this.running = true; };
  Clock.prototype.pause = function () { if (this.running && !this.pausedAt) this.pausedAt = this.now(); };
  Clock.prototype.resume = function () { if (this.pausedAt) { this.paused += this.now() - this.pausedAt; this.pausedAt = 0; } };
  Clock.prototype.elapsed = function () { if (!this.start) return 0; var end = this.pausedAt || this.now(); return Math.max(0, (end - this.start - this.paused) / 1000); };

  // ───────────── teleprompter ─────────────

  /** Beats from a script (the Scripts view) or from pasted notes (one beat per paragraph, in the current layout). */
  function normaliseBeats(beats, fallbackLayout) {
    return (Array.isArray(beats) ? beats : []).map(function (b) {
      var text = String((b && b.text) || '').trim();
      return { layout: IDS.indexOf(b && b.layout) >= 0 ? b.layout : (fallbackLayout || 'orbit'), text: text, cue: b && b.cue ? String(b.cue) : '' };
    }).filter(function (b) { return b.text; });
  }
  function beatsFromText(text, layout) { return normaliseBeats(String(text || '').split(/\n\s*\n/).map(function (p) { return { text: p.replace(/\s+/g, ' ') }; }), layout); }
  /** Which layout to show for a beat while recording in a given output (vertical never mixes with landscape). */
  function layoutForBeat(beat, current) {
    if (!beat || IDS.indexOf(beat.layout) < 0) return current;
    if ((beat.layout === 'vertical') !== (current === 'vertical')) return current;
    return beat.layout;
  }

  // ───────────── upload: exact-size parts ─────────────

  /** Collects recorder chunks and cuts exact partSize parts (R2 needs every part but the last the same size). */
  function PartBuffer(partSize) {
    if (!(partSize > 0)) throw new Error('partSize');
    this.partSize = partSize; this.chunks = []; this.size = 0; this.next = 1; this.offset = 0; this.total = 0;
  }
  PartBuffer.prototype.push = function (blob) { if (blob && blob.size) { this.chunks.push(blob); this.size += blob.size; this.total += blob.size; } };
  PartBuffer.prototype.take = function () {
    if (this.size < this.partSize) return null;
    var all = this.chunks.length === 1 ? this.chunks[0] : new Blob(this.chunks);
    var part = all.slice(0, this.partSize), rest = all.slice(this.partSize);
    this.chunks = rest.size ? [rest] : [];
    this.size -= this.partSize;
    var p = { n: this.next++, blob: part, start: this.offset, end: this.offset + this.partSize, last: false };
    this.offset += this.partSize;
    return p;
  };
  /** Everything left as the last part (null when nothing is left). */
  PartBuffer.prototype.flush = function () {
    if (!this.size) return null;
    var blob = this.chunks.length === 1 ? this.chunks[0] : new Blob(this.chunks);
    var p = { n: this.next++, blob: blob, start: this.offset, end: this.offset + blob.size, last: true };
    this.offset += blob.size; this.chunks = []; this.size = 0;
    return p;
  };

  /** Wait before retry `attempt` (1-based): 1 s, 2 s, 4 s ... up to 30 s, with a little jitter. */
  function backoff(attempt, rnd) { var base = Math.min(30000, 1000 * Math.pow(2, Math.max(0, attempt - 1))); return Math.round(base * (0.85 + 0.3 * (rnd == null ? Math.random() : rnd))); }
  /** Network errors, timeouts, 408, 429 and 5xx are worth retrying; other 4xx are not (auth, guest, bad request). */
  function retriable(status) { return !status || status === 408 || status === 429 || status >= 500; }

  /**
   * Sends parts in order while recording. deps: { request(method, path, body, contentType) -> Promise<{status, json}>,
   * sleep(ms), onState(state) }. meta goes to POST /uploads. Parts n <= skipThrough were sent before (resume).
   */
  function Uploader(meta, deps, opts) {
    opts = opts || {};
    this.meta = meta; this.deps = deps; this.maxAttempts = opts.maxAttempts || 7;
    this.id = opts.id || null; this.partSize = opts.partSize || 0; this.skipThrough = opts.skipThrough || 0;
    this.pre = []; this.buf = this.partSize ? new PartBuffer(this.partSize) : null;
    this.queue = []; this.acked = opts.skipThrough || 0; this.bytesAcked = 0; this.bytesIn = 0; this.bytesSkipped = 0;
    this.stopped = false; this.failed = null; this.pumping = null; this.done = false; this.creating = null;
  }
  Uploader.prototype.state = function () {
    return { id: this.id, acked: this.acked, queued: this.queue.length, bytesAcked: this.bytesAcked + this.bytesSkipped, bytesIn: this.bytesIn, failed: this.failed, done: this.done, stopped: this.stopped };
  };
  Uploader.prototype.emit = function () { if (this.deps.onState) try { this.deps.onState(this.state()); } catch (e) { /* the UI only */ } };
  Uploader.prototype.call = function (method, path, body, type) {
    var self = this, attempt = 0;
    function go() {
      attempt++;
      return Promise.resolve().then(function () { return self.deps.request(method, path, body, type); }).then(function (r) {
        if (r && r.status >= 200 && r.status < 300) return r.json || {};
        var err = new Error((r && r.json && r.json.error) || ('HTTP ' + (r && r.status))); err.status = r && r.status; throw err;
      }, function (e) { var err = new Error((e && e.message) || 'network'); err.status = 0; throw err; }).catch(function (e) {
        if (!retriable(e.status) || attempt >= self.maxAttempts) throw e;
        self.emit();
        return self.deps.sleep(backoff(attempt)).then(go);
      });
    }
    return go();
  };
  /** Starts the upload session (retries on its own); chunks pushed before it answers wait in memory. */
  Uploader.prototype.start = function () {
    var self = this;
    if (this.id && this.buf) return Promise.resolve(this.id);
    if (this.creating) return this.creating;
    this.creating = this.call('POST', '/admin/api/studio/uploads', JSON.stringify(this.meta), 'application/json').then(function (j) {
      if (!j || !j.id || !(j.partSize > 0)) throw new Error('The upload could not start.');
      self.id = j.id; self.partSize = j.partSize; self.buf = new PartBuffer(j.partSize);
      self.pre.forEach(function (b) { self.buf.push(b); }); self.pre = [];
      self.emit(); self.pump();
      return self.id;
    }).catch(function (e) { self.creating = null; self.failed = e.message || 'The upload could not start.'; self.emit(); throw e; });
    return this.creating;
  };
  Uploader.prototype.push = function (blob) {
    if (!blob || !blob.size) return;
    this.bytesIn += blob.size;
    if (this.buf) { this.buf.push(blob); this.pump(); } else this.pre.push(blob);
    this.emit();
  };
  Uploader.prototype.cut = function () {
    var p;
    while ((p = this.buf.take())) this.enqueue(p);
  };
  Uploader.prototype.enqueue = function (p) {
    if (p.n <= this.skipThrough) { this.bytesSkipped += p.blob.size; return; }
    this.queue.push(p);
  };
  /** Sends queued parts one at a time, in order. Resolves when the queue is empty or a part failed for good. */
  Uploader.prototype.pump = function () {
    var self = this;
    if (!this.buf || this.failed) return this.pumping || Promise.resolve();
    this.cut();
    if (this.pumping) return this.pumping;
    function next() {
      if (self.failed) return Promise.resolve();
      self.cut();
      var p = self.queue[0];
      if (!p) return Promise.resolve();
      return self.call('PUT', '/admin/api/studio/uploads/' + encodeURIComponent(self.id) + '/parts/' + p.n, p.blob, 'application/octet-stream').then(function () {
        self.queue.shift(); self.acked = p.n; self.bytesAcked += p.blob.size; self.emit();
        return next();
      }, function (e) { self.failed = e.message || 'A part did not upload.'; self.emit(); });
    }
    this.pumping = next().then(function () { self.pumping = null; });
    return this.pumping;
  };
  /** After the recorder stops: the last part, then complete. Resolves { ok, id } or { ok:false, error }. */
  Uploader.prototype.finish = function (duration, markers) {
    var self = this;
    this.stopped = true; this.emit();
    return this.start().then(function () {
      if (!self.finalQueued) { self.finalQueued = true; self.cut(); var last = self.buf.flush(); if (last) self.enqueue(last); }
      return self.drain();
    }).then(function () {
      if (self.failed) return { ok: false, error: self.failed, id: self.id };
      if (!self.acked && !self.bytesSkipped) return { ok: false, error: 'Nothing was recorded.', id: self.id, empty: true };
      return self.call('POST', '/admin/api/studio/uploads/' + encodeURIComponent(self.id) + '/complete', JSON.stringify({ duration_s: Math.round(duration * 10) / 10, markers: markers || [] }), 'application/json')
        .then(function () { self.done = true; self.emit(); return { ok: true, id: self.id }; });
    }).catch(function (e) { self.failed = self.failed || e.message || 'The upload did not finish.'; self.emit(); return { ok: false, error: self.failed, id: self.id }; });
  };
  Uploader.prototype.drain = function () {
    var self = this;
    return this.pump().then(function () { return self.queue.length && !self.failed ? self.drain() : null; });
  };
  /** After a failure: clear it and carry on from the first part the server has not confirmed. */
  Uploader.prototype.retry = function (duration, markers) { this.failed = null; return this.stopped ? this.finish(duration, markers) : this.start().then(this.pump.bind(this)); };

  var api = {
    LAYOUTS: LAYOUTS, IDS: IDS, MORPH_MS: MORPH_MS, MAX_W: MAX_W, MAX_H: MAX_H, MARKER_LABEL: MARKER_LABEL,
    outputSize: outputSize, bitrateFor: bitrateFor, mimeCandidates: mimeCandidates, pickMime: pickMime, extFor: extFor,
    spring: spring, ease: ease, lerp: lerp, lerpGeom: lerpGeom, clamp: clamp, fit: fit,
    layoutGeometry: layoutGeometry, nearestCorner: nearestCorner, verticalCropAspect: verticalCropAspect,
    coverSource: coverSource, faceSource: faceSource, placeRegion: placeRegion, zoomRegion: zoomRegion, lerpRegion: lerpRegion, tiltStrips: tiltStrips,
    levelFromSamples: levelFromSamples, smoothLevel: smoothLevel,
    fmtTime: fmtTime, addMarker: addMarker, Clock: Clock,
    normaliseBeats: normaliseBeats, beatsFromText: beatsFromText, layoutForBeat: layoutForBeat,
    PartBuffer: PartBuffer, backoff: backoff, retriable: retriable, Uploader: Uploader, HIDDEN: HIDDEN,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.StudioCore = api;
})(typeof window !== 'undefined' ? window : null);
