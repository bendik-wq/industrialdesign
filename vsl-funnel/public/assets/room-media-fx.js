/* Rooms, background blur and the G&L backdrop (area A "media"), loaded by room-media.js only when someone turns
   an effect on. Runs on the person's own device; nothing leaves it except the finished video.
   - Segmentation: MediaPipe Tasks Vision ImageSegmenter (selfie segmenter model from our own assets, the
     library and its WebAssembly from a pinned jsDelivr build), GPU delegate with a CPU fallback, fed a small
     256x144 frame so the mask read-back stays cheap.
   - Compositing: WebGL2. The mask is smoothed over time (less flicker at the edges), the background is blurred
     at quarter size with a separable Gaussian (two passes each way), or replaced by the G&L backdrop.
   - Timing: a tiny worker ticks the frames, so a background tab keeps sending video (rAF stops there).
   - Cost: each frame's time is measured. Too slow at 24 fps drops to 15 fps; still too slow and the effect asks
     to be switched off (onSlow), and room-media.js puts the plain camera back. */
(function () {
  'use strict';
  var segP = null;
  function segmenter(cdn) {
    if (segP) return segP;
    segP = import(cdn.vision).then(function (V) {
      return V.FilesetResolver.forVisionTasks(cdn.visionWasm).then(function (files) {
        var make = function (delegate) {
          return V.ImageSegmenter.createFromOptions(files, { baseOptions: { modelAssetPath: cdn.model, delegate: delegate }, runningMode: 'VIDEO', outputCategoryMask: false, outputConfidenceMasks: true });
        };
        return make('GPU').catch(function () { return make('CPU'); });
      });
    }).catch(function (e) { segP = null; throw e; });
    return segP;
  }

  var VS = '#version 300 es\nin vec2 p;out vec2 uv;void main(){uv=p*0.5+0.5;gl_Position=vec4(p,0.,1.);}';
  var FS_COPY = '#version 300 es\nprecision mediump float;in vec2 uv;out vec4 o;uniform sampler2D t;void main(){o=texture(t,uv);}';
  var FS_BLUR = '#version 300 es\nprecision mediump float;in vec2 uv;out vec4 o;uniform sampler2D t;uniform vec2 d;' +
    'void main(){vec4 c=texture(t,uv)*0.227027;c+=texture(t,uv+d*1.3846154)*0.3162162;c+=texture(t,uv-d*1.3846154)*0.3162162;c+=texture(t,uv+d*3.2307692)*0.0702703;c+=texture(t,uv-d*3.2307692)*0.0702703;o=c;}';
  var FS_COMP = '#version 300 es\nprecision mediump float;in vec2 uv;out vec4 o;uniform sampler2D v;uniform sampler2D m;uniform sampler2D b;uniform float mode;uniform vec2 bs;uniform vec2 bo;' +
    'void main(){vec4 fg=texture(v,uv);float a=smoothstep(0.32,0.72,texture(m,uv).r);vec3 bg=mode<0.5?texture(b,uv).rgb:texture(b,uv*bs+bo).rgb;o=vec4(mix(bg,fg.rgb,a),1.);}';

  function compile(gl, vs, fs) {
    var p = gl.createProgram();
    [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]].forEach(function (x) {
      var s = gl.createShader(x[0]); gl.shaderSource(s, x[1]); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
      gl.attachShader(p, s);
    });
    gl.bindAttribLocation(p, 0, 'p');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('program: ' + gl.getProgramInfoLog(p));
    return p;
  }
  function texture(gl, filter) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter || gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter || gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  function target(gl, w, h) {
    var t = texture(gl);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    var f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { t: t, f: f, w: w, h: h };
  }

  /** The G&L backdrop: navy, a soft light, a gold hairline and the wordmark (drawn, no image files). */
  function backdrop() {
    var c = document.createElement('canvas'); c.width = 1280; c.height = 720;
    var g = c.getContext('2d');
    var lg = g.createLinearGradient(0, 0, 1280, 720); lg.addColorStop(0, '#163a73'); lg.addColorStop(0.55, '#0f2c5c'); lg.addColorStop(1, '#08193a');
    g.fillStyle = lg; g.fillRect(0, 0, 1280, 720);
    var rg = g.createRadialGradient(300, 160, 40, 300, 160, 720); rg.addColorStop(0, 'rgba(255,255,255,0.16)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = rg; g.fillRect(0, 0, 1280, 720);
    g.strokeStyle = 'rgba(255,255,255,0.05)'; g.lineWidth = 1;
    for (var x = -720; x < 1280; x += 48) { g.beginPath(); g.moveTo(x, 720); g.lineTo(x + 720, 0); g.stroke(); }
    g.fillStyle = '#f5b82e'; g.fillRect(64, 610, 120, 2);
    g.fillStyle = 'rgba(255,255,255,0.92)'; g.font = '500 44px Newsreader, Georgia, "Times New Roman", serif'; g.fillText('G&L', 64, 588);
    g.fillStyle = 'rgba(255,255,255,0.6)'; g.font = '600 15px -apple-system, system-ui, sans-serif'; g.fillText('M&A ADVISORY', 66, 640);
    return c;
  }

  function ticker(fps, fn) {
    var w = null, url = null, iv = 0;
    try {
      url = URL.createObjectURL(new Blob(['var t=0;onmessage=function(e){clearInterval(t);if(e.data>0)t=setInterval(function(){postMessage(0)},e.data)}'], { type: 'text/javascript' }));
      w = new Worker(url); w.onmessage = fn; w.postMessage(Math.round(1000 / fps));
    } catch (e) { w = null; iv = setInterval(fn, Math.round(1000 / fps)); }
    return {
      rate: function (f) { if (w) w.postMessage(Math.round(1000 / f)); else { clearInterval(iv); iv = setInterval(fn, Math.round(1000 / f)); } },
      stop: function () { if (w) { w.postMessage(0); w.terminate(); } clearInterval(iv); if (url) URL.revokeObjectURL(url); },
    };
  }

  /**
   * create(rawTrack, { mode: 'blur'|'brand', cdn, onSlow }) → Promise<{ track, setMode, stop, stats }>.
   * The output is a canvas track at the camera's size (up to 1280x720).
   */
  function create(raw, o) {
    if (!window.WebGL2RenderingContext) return Promise.reject(new Error('webgl2'));
    return segmenter(o.cdn).then(function (seg) {
      var video = document.createElement('video');
      video.muted = true; video.playsInline = true; video.setAttribute('playsinline', '');
      video.srcObject = new MediaStream([raw]);
      return video.play().then(function () { return waitSize(video); }).then(function () { return build(seg, video, raw, o); });
    });
  }
  function waitSize(video) {
    return new Promise(function (res) {
      if (video.videoWidth) { res(); return; }
      var t = setTimeout(res, 3000);
      video.addEventListener('loadedmetadata', function () { clearTimeout(t); res(); }, { once: true });
    });
  }

  function build(seg, video, raw, o) {
    var s = raw.getSettings ? raw.getSettings() : {};
    var vw = video.videoWidth || s.width || 640, vh = video.videoHeight || s.height || 360;
    var sc = Math.min(1, 1280 / vw, 720 / vh);
    var W = Math.round(vw * sc / 2) * 2, H = Math.round(vh * sc / 2) * 2;
    var out = document.createElement('canvas'); out.width = W; out.height = H;
    var gl = out.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: false, desynchronized: true, powerPreference: 'low-power' });
    if (!gl) throw new Error('webgl2');
    var small = document.createElement('canvas'); small.width = 256; small.height = Math.max(64, Math.round(256 * H / W));
    var sg = small.getContext('2d', { willReadFrequently: false });
    var quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    var P = { copy: compile(gl, VS, FS_COPY), blur: compile(gl, VS, FS_BLUR), comp: compile(gl, VS, FS_COMP) };
    var U = function (p, n) { return gl.getUniformLocation(p, n); };
    var tVideo = texture(gl), tMask = texture(gl), tBrand = texture(gl);
    // Until the first mask arrives, the whole picture is the person (no flash of background).
    gl.bindTexture(gl.TEXTURE_2D, tMask); gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([255]));
    var qw = Math.max(32, Math.round(W / 4)), qh = Math.max(18, Math.round(H / 4));
    var A = target(gl, qw, qh), B = target(gl, qw, qh);
    var brand = backdrop();
    gl.bindTexture(gl.TEXTURE_2D, tBrand); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, brand);
    // Cover-fit the 16:9 backdrop to the camera's shape.
    var ar = (W / H) / (1280 / 720), bs = ar > 1 ? [1, 1 / ar] : [ar, 1], bo = [(1 - bs[0]) / 2, (1 - bs[1]) / 2];
    var mode = o.mode === 'brand' ? 'brand' : 'blur';
    var prevMask = null, mask8 = null, maskW = 0, maskH = 0;
    var fps = 24, ema = 0, slowSince = 0, stopped = false, busy = false, lastTs = 0, frames = 0;

    function draw(prog, fb, w, h, tex, extra) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.viewport(0, 0, w, h);
      gl.useProgram(prog);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(U(prog, 't'), 0);
      if (extra) extra(prog);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    function frame() {
      if (stopped || busy || video.readyState < 2) return;
      busy = true;
      var t0 = performance.now();
      try {
        sg.drawImage(video, 0, 0, small.width, small.height);
        var ts = Math.max(lastTs + 1, Math.round(t0)); lastTs = ts;
        seg.segmentForVideo(small, ts, function (res) {
          var masks = res && res.confidenceMasks;
          var m = masks && masks[masks.length - 1];
          if (!m) return;
          var f = m.getAsFloat32Array();
          if (!mask8 || m.width !== maskW || m.height !== maskH) { maskW = m.width; maskH = m.height; mask8 = new Uint8Array(maskW * maskH); prevMask = new Float32Array(maskW * maskH); }
          for (var i = 0; i < f.length; i++) { var v = prevMask[i] * 0.4 + f[i] * 0.6; prevMask[i] = v; mask8[i] = v * 255; }
        });
        if (mask8) {
          gl.bindTexture(gl.TEXTURE_2D, tMask);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, maskW, maskH, 0, gl.RED, gl.UNSIGNED_BYTE, mask8);
        }
        gl.bindTexture(gl.TEXTURE_2D, tVideo);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
        var bg = tBrand;
        if (mode === 'blur') {
          draw(P.copy, A.f, qw, qh, tVideo);
          for (var k = 0; k < 2; k++) {
            draw(P.blur, B.f, qw, qh, A.t, function (p) { gl.uniform2f(U(p, 'd'), 2.2 / qw, 0); });
            draw(P.blur, A.f, qw, qh, B.t, function (p) { gl.uniform2f(U(p, 'd'), 0, 2.2 / qh); });
          }
          bg = A.t;
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H);
        gl.useProgram(P.comp);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tVideo); gl.uniform1i(U(P.comp, 'v'), 0);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tMask); gl.uniform1i(U(P.comp, 'm'), 1);
        gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, bg); gl.uniform1i(U(P.comp, 'b'), 2);
        gl.uniform1f(U(P.comp, 'mode'), mode === 'blur' ? 0 : 1);
        gl.uniform2f(U(P.comp, 'bs'), bs[0], bs[1]); gl.uniform2f(U(P.comp, 'bo'), bo[0], bo[1]);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.activeTexture(gl.TEXTURE0);
        frames++;
      } catch (e) { console.warn('fx frame', e); }
      busy = false;
      // Cost per frame (a smoothed average): over budget for 3 s drops to 15 fps, still over for 4 s gives up.
      var ms = performance.now() - t0;
      ema = ema ? ema * 0.85 + ms * 0.15 : ms;
      var budget = fps >= 24 ? 30 : 50;
      var now = performance.now();
      if (frames > 20 && ema > budget) {
        if (!slowSince) slowSince = now;
        if (fps >= 24 && now - slowSince > 3000) { fps = 15; tk.rate(fps); slowSince = 0; ema = 0; }
        else if (fps < 24 && now - slowSince > 4000 && o.onSlow) { o.onSlow(); slowSince = Infinity; }
      } else if (slowSince !== Infinity) slowSince = 0;
    }
    var tk = ticker(fps, frame);
    var track = out.captureStream(30).getVideoTracks()[0];
    if ('contentHint' in track) track.contentHint = 'motion';
    frame();
    return {
      track: track,
      setMode: function (m) { mode = m === 'brand' ? 'brand' : 'blur'; },
      stats: function () { return { ms: Math.round(ema * 10) / 10, fps: fps, width: W, height: H }; },
      stop: function () {
        if (stopped) return;
        stopped = true; tk.stop();
        try { video.pause(); video.srcObject = null; } catch (e) { /* gone */ }
        try { var lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); } catch (e) { /* gone */ }
      },
    };
  }

  window.RoomFx = { create: create };
})();
