/* Camera check: tries every reasonable way to open the camera and mic, measures what actually arrives
   (frames, size, and whether the picture is a flat placeholder such as an OS privacy image) and posts the
   technical results to /api/camera-test. No images or audio leave the browser. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var out = { at: new Date().toISOString(), ua: navigator.userAgent, attempts: [], devices: {}, perms: {}, notes: [] };
  var stepsEl = $('steps'), video = $('v');
  function step(text, cls) { var li = document.createElement('li'); li.textContent = text; if (cls) li.className = cls; stepsEl.appendChild(li); return li; }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function withTimeout(p, ms) { return Promise.race([p, new Promise(function (_, rej) { setTimeout(function () { var e = new Error('no answer in ' + ms / 1000 + 's'); e.name = 'Timeout'; rej(e); }, ms); })]); }
  function stopAll(s) { if (s) s.getTracks().forEach(function (t) { t.stop(); }); }
  function errOf(e) { return { name: (e && e.name) || 'Error', message: String((e && e.message) || e || '').slice(0, 300), constraint: e && e.constraint || undefined }; }

  // Luma stats over a small frame: a real camera picture varies; a flat placeholder (privacy image, black) doesn't.
  function frameStats() {
    try {
      var w = 64, h = 36, c = document.createElement('canvas'); c.width = w; c.height = h;
      var x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(video, 0, 0, w, h);
      var d = x.getImageData(0, 0, w, h).data, n = w * h, sum = 0, sq = 0, buckets = {};
      for (var i = 0; i < d.length; i += 4) { var y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; sum += y; sq += y * y; buckets[(d[i] >> 4) + ',' + (d[i + 1] >> 4) + ',' + (d[i + 2] >> 4)] = 1; }
      var mean = sum / n, sd = Math.sqrt(Math.max(0, sq / n - mean * mean));
      return { mean: Math.round(mean), sd: Math.round(sd * 10) / 10, colours: Object.keys(buckets).length };
    } catch (e) { return { error: errOf(e).message }; }
  }
  function measure(stream) {
    var t = stream.getVideoTracks()[0];
    video.srcObject = stream;
    var p = video.play ? video.play().catch(function () {}) : Promise.resolve();
    return p.then(function () { return wait(1800); }).then(function () {
      var r = { settings: t ? t.getSettings() : null, readyState: t ? t.readyState : null, muted: t ? t.muted : null, label: t ? t.label : null, videoW: video.videoWidth, videoH: video.videoHeight };
      var q = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null; r.frames = q ? q.totalVideoFrames : null;
      r.stats = frameStats(); var a = r.stats;
      r.verdict = !r.videoW ? 'no_frames' : (a.sd < 4 && a.mean < 20) ? 'black' : (a.colours <= 12 && a.sd < 40) ? 'placeholder' : 'picture';
      return r;
    });
  }
  function attempt(label, cons) {
    var li = step(label + ': trying…', 'muted');
    var rec = { label: label, constraints: cons };
    out.attempts.push(rec);
    var started = Date.now();
    return withTimeout(navigator.mediaDevices.getUserMedia(cons), 10000).then(function (s) {
      rec.ok = true; rec.ms = Date.now() - started;
      rec.tracks = s.getTracks().map(function (t) { return t.kind + ':' + t.label; });
      if (!cons.video) { stopAll(s); li.textContent = label + ': works'; li.className = 'ok'; return; }
      return measure(s).then(function (m) {
        rec.measure = m; stopAll(s); video.srcObject = null;
        var words = { picture: 'works, picture received (' + m.videoW + '×' + m.videoH + ')', placeholder: 'opens, but the picture is a flat placeholder (often a privacy block)', black: 'opens, but the picture is black', no_frames: 'opens, but no picture arrives' };
        li.textContent = label + ': ' + words[m.verdict]; li.className = m.verdict === 'picture' ? 'ok' : 'bad';
      });
    }).catch(function (e) {
      rec.ok = false; rec.ms = Date.now() - started; rec.error = errOf(e);
      li.textContent = label + ': failed (' + rec.error.name + (rec.error.message ? ': ' + rec.error.message : '') + ')'; li.className = 'bad';
    }).then(function () { return wait(700); }); // give the driver time to release the camera
  }
  function perms() {
    if (!navigator.permissions || !navigator.permissions.query) return Promise.resolve();
    return Promise.all(['camera', 'microphone'].map(function (k) {
      return navigator.permissions.query({ name: k }).then(function (p) { out.perms[k] = p.state; }).catch(function (e) { out.perms[k] = 'n/a: ' + errOf(e).name; });
    }));
  }
  function devices(tag) {
    return navigator.mediaDevices.enumerateDevices().then(function (ds) {
      out.devices[tag] = ds.map(function (d) { return { kind: d.kind, label: d.label, id: d.deviceId ? d.deviceId.slice(0, 10) : '', group: d.groupId ? d.groupId.slice(0, 8) : '' }; });
      return ds;
    }).catch(function (e) { out.devices[tag] = errOf(e); return []; });
  }
  function platform() {
    var u = navigator.userAgentData;
    if (!u || !u.getHighEntropyValues) return Promise.resolve();
    return u.getHighEntropyValues(['platform', 'platformVersion', 'architecture', 'bitness', 'model', 'fullVersionList']).then(function (v) { out.platform = v; }).catch(function () {});
  }
  function send() {
    out.secure = window.isSecureContext; out.top = window.top === window;
    return fetch('/api/camera-test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(out) })
      .then(function (r) { return r.json(); }).catch(function () { return {}; });
  }

  $('go').onclick = function () {
    $('go').disabled = true; stepsEl.innerHTML = ''; $('done').hidden = true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { step('This browser can’t use a camera on this page.', 'bad'); out.notes.push('no mediaDevices'); send(); return; }
    var cams = [];
    platform().then(perms).then(function () { return devices('before'); })
      .then(function () { step('Permissions: camera ' + (out.perms.camera || '?') + ', microphone ' + (out.perms.microphone || '?'), 'muted'); })
      .then(function () { return attempt('Microphone only', { audio: true }); })
      .then(function () { return attempt('Any camera, browser default', { video: true }); })
      .then(function () { return devices('after'); })
      .then(function (ds) { cams = ds.filter(function (d) { return d.kind === 'videoinput'; }); step('Cameras found: ' + (cams.length ? cams.map(function (c) { return c.label || 'unnamed'; }).join(', ') : 'none'), cams.length ? 'muted' : 'bad'); })
      .then(function () {
        var chain = Promise.resolve();
        cams.forEach(function (c) {
          var id = { exact: c.deviceId }, name = c.label || 'camera';
          chain = chain
            .then(function () { return attempt(name + ', its default', { video: { deviceId: id } }); })
            .then(function () { return attempt(name + ', HD 1280×720 at 30 fps (what the room asks)', { video: { deviceId: id, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } }); })
            .then(function () { return attempt(name + ', 640×480', { video: { deviceId: id, width: { ideal: 640 }, height: { ideal: 480 } } }); })
            .then(function () { return attempt(name + ', with microphone (as the room opens it)', { video: { deviceId: id, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); });
        });
        return chain;
      })
      .then(function () { return attempt('Front-facing camera', { video: { facingMode: 'user' } }); })
      .then(send)
      .then(function (r) { $('code').textContent = r && r.code ? r.code : 'not sent'; $('raw').textContent = JSON.stringify(out, null, 1); $('done').hidden = false; $('go').disabled = false; $('go').textContent = 'Run again'; });
  };
})();
