/* Talk instead of type, on the application.
 * Live dictation with the browser's own speech recognition (Chrome, Edge, Safari); where that isn't
 * available (Facebook / Instagram in-app browsers, Firefox) it records a short clip that our server
 * transcribes with Cloudflare Workers AI. Audio is never stored. Exposes window.VoiceInput for apply.js. */
(function () {
  'use strict';
  var cfg = window.FUNNEL || {};
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var inApp = /FBAN|FBAV|FB_IAB|Instagram|Line\/|TikTok|Snapchat/i.test(navigator.userAgent);
  var canRecord = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  var on = cfg.voiceInput !== false;
  var mode = !on ? null : SR && !inApp ? 'live' : canRecord ? 'record' : null;
  var lang = (navigator.language || 'en-AU').replace('_', '-');

  // ───────── Recording (fallback) ─────────
  function recordClip(onState, maxMs) {
    var chunks = [], rec = null, stream = null, timer = null, done = false;
    var p = new Promise(function (resolve, reject) {
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function (s) {
        stream = s;
        var type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg'].filter(function (t) { return MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t); })[0] || '';
        rec = new MediaRecorder(s, type ? { mimeType: type } : undefined);
        rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
        rec.onstop = function () {
          stream.getTracks().forEach(function (t) { t.stop(); });
          var blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
          if (blob.size < 800) return reject(new Error('empty'));
          onState('working');
          fetch('/api/apply/transcribe', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': blob.type || 'audio/webm' }, body: blob })
            .then(function (r) { return r.json().catch(function () { return {}; }); })
            .then(function (j) { if (j && typeof j.text === 'string') resolve(j.text); else reject(new Error((j && j.error) || 'failed')); }, reject);
        };
        rec.start();
        onState('listening');
        timer = setTimeout(stop, maxMs || 90000);
      }, function () { reject(new Error('denied')); });
    });
    function stop() { if (done) return; done = true; clearTimeout(timer); if (rec && rec.state !== 'inactive') rec.stop(); }
    return { promise: p, stop: stop };
  }

  // ───────── Free text: dictate into a textarea ─────────
  function attachText(textarea, button, status) {
    if (!mode) { button.hidden = true; return; }
    var active = null;
    function setUi(state, msg) {
      button.classList.toggle('on', state === 'listening');
      button.classList.toggle('working', state === 'working');
      button.querySelector('[data-mic-label]').textContent = state === 'listening' ? 'Tap when you’re done' : state === 'working' ? 'Writing it down…' : 'Talk instead of typing';
      status.textContent = msg || '';
    }
    function track(what) { try { window.funnel.track('voice_input', { mode: mode, field: textarea.name, what: what }); } catch (e) { /* never break the form */ } }
    button.addEventListener('click', function () {
      if (active) { active.stop(); return; }
      var base = textarea.value.replace(/\s+$/, '');
      var sep = base ? (/[.!?]$/.test(base) ? ' ' : '. ') : '';
      if (mode === 'live') {
        var r = new SR();
        r.lang = lang; r.continuous = true; r.interimResults = true;
        var finalText = '';
        r.onresult = function (e) {
          var interim = '';
          for (var i = e.resultIndex; i < e.results.length; i++) {
            if (e.results[i].isFinal) finalText += e.results[i][0].transcript + ' ';
            else interim += e.results[i][0].transcript;
          }
          textarea.value = (base + sep + (finalText + interim).replace(/^\s+/, '')).slice(0, 2000);
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        };
        r.onerror = function (e) { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') setUi('idle', 'Microphone blocked. Allow it in your browser settings, or just type.'); };
        r.onend = function () { active = null; setUi('idle', finalText ? 'Got it. Edit anything that’s not quite right.' : ''); if (finalText) track('live'); };
        try { r.start(); } catch (e) { return; }
        active = { stop: function () { r.stop(); } };
        setUi('listening', 'Listening… speak naturally.');
      } else {
        var clip = recordClip(function (st) { setUi(st, st === 'listening' ? 'Recording… tap when you’re done.' : 'Turning your voice into text…'); }, 120000);
        active = clip;
        clip.promise.then(function (text) {
          active = null;
          if (text) { textarea.value = (base + sep + text).slice(0, 2000); textarea.dispatchEvent(new Event('input', { bubbles: true })); track('record'); }
          setUi('idle', text ? 'Got it. Edit anything that’s not quite right.' : 'Didn’t catch that. Try again, or type.');
        }, function (err) {
          active = null;
          setUi('idle', err && err.message === 'denied' ? 'Microphone blocked. Allow it, or just type.' : 'Didn’t catch that. Try again, or type.');
        });
      }
    });
  }

  // ───────── Choices: say the answer, we pick the closest option ─────────
  var NUM = { zero: 0, one: 1, a: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100 };
  function norm(s) { return String(s || '').toLowerCase().replace(/[’']/g, '').replace(/[–—-]/g, ' ').replace(/\s+/g, ' ').trim(); }
  /** Dollar amounts mentioned ("2 million", "two point five mil", "800k", "half a million"). */
  function amounts(t) {
    t = norm(t).replace(/half a (million|mil)/g, '0.5 million').replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)\b/g, function (w) { return String(NUM[w]); });
    t = t.replace(/(\d+) point (\d+)/g, '$1.$2').replace(/(\d+) hundred (thousand|k)/g, function (m, a) { return String(a * 100) + ' thousand'; });
    var out = [], re = /\$?\s*(\d+(?:[.,]\d+)?)\s*(million|mil|m\b|k\b|thousand|grand|b\b|billion)?/g, m;
    while ((m = re.exec(t))) {
      var n = parseFloat(m[1].replace(',', '')), u = m[2] || '';
      if (/^(million|mil|m)$/.test(u)) n *= 1e6; else if (/^(k|thousand|grand)$/.test(u)) n *= 1e3; else if (/^(b|billion)$/.test(u)) n *= 1e9; else if (n < 1000) continue;
      out.push(n);
    }
    return out;
  }
  function months(t) {
    t = norm(t).replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|twelve|eighteen|twenty)\b/g, function (w) { return String(NUM[w] || (w === 'eighteen' ? 18 : 0)); });
    var m = t.match(/(\d+)\s*(month|year)/) || (/(a|one) year|this year|twelve months/.test(t) ? ['', '12', 'month'] : /couple of months|few months|soon|asap|right away|straight away|now/.test(t) ? ['', '3', 'month'] : null);
    if (!m) return null;
    return Number(m[1]) * (/year/.test(m[2]) ? 12 : 1);
  }
  function rangeOf(label) {
    var l = norm(label).replace(/\$/g, '');
    var vals = amounts('$' + l.replace(/(\d)\s*(m|k)\b/g, '$1 $2').replace(/\+/g, ' plus'));
    if (vals.length) {
      if (/under|less|below/.test(l)) return [0, vals[0]];
      if (/plus|\+|more|over|above/.test(l) && vals.length === 1) return [vals[0], Infinity];
      if (vals.length >= 2) return [vals[0], vals[1]];
    }
    var mo = l.match(/(\d+)\s*(\d+)?\s*months?/);
    if (mo) {
      if (/next/.test(l)) return [0, Number(mo[1]), 'm'];
      if (/or more/.test(l)) return [Number(mo[1]), Infinity, 'm'];
      if (mo[2]) return [Number(mo[1]), Number(mo[2]), 'm'];
    }
    return null;
  }
  var STOP = { the: 1, a: 1, an: 1, and: 1, or: 1, of: 1, to: 1, i: 1, im: 1, my: 1, it: 1, is: 1, but: 1, yet: 1, just: 1, with: 1, in: 1, on: 1, for: 1, not: 0 };
  function words(s) { return norm(s).replace(/[^a-z0-9 ]/g, ' ').split(' ').filter(function (w) { return w && !STOP[w]; }); }
  function pick(transcript, options) {
    var t = norm(transcript);
    // "A", "option B", "the second one"
    var letter = t.match(/^(?:option |answer |letter )?([a-h])\.?$/) || t.match(/\boption ([a-h])\b/);
    if (letter) return [options[letter[1].charCodeAt(0) - 97]].filter(Boolean);
    var ord = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'].filter(function (w) { return t.indexOf(w) >= 0; })[0];
    if (ord && /\b(one|option|answer)\b/.test(t)) return [options[['first', 'second', 'third', 'fourth', 'fifth', 'sixth'].indexOf(ord)]].filter(Boolean);
    // Money and time ranges.
    var amt = amounts(t), mo = months(t);
    var ranged = options.map(function (o) { return { o: o, r: rangeOf(o.label) }; }).filter(function (x) { return x.r; });
    if (/loss|losing|break ?even|negative|not profitable/.test(t)) { var lossy = options.filter(function (o) { return /loss|break/i.test(o.label); }); if (lossy.length) return lossy.slice(0, 1); }
    if (ranged.length >= 2) {
      var isMonths = ranged[0].r[2] === 'm';
      if (isMonths && /explor|curious|looking around|no rush|someday|not sure/.test(t)) { var ex0 = options.filter(function (o) { return /explor/i.test(o.label); }); if (ex0.length) return ex0; }
      var v = isMonths ? mo : amt.length ? amt[0] : null;
      if (v != null) { var hit = ranged.filter(function (x) { return v >= x.r[0] && v < (x.r[1] === Infinity ? Infinity : x.r[1] + (isMonths ? 0.01 : 0)); })[0]; if (hit) return [hit.o]; }
      if (isMonths && /explor|curious|looking around|no rush|someday|not sure/.test(t)) { var ex = options.filter(function (o) { return /explor/i.test(o.label); }); if (ex.length) return ex; }
    }
    // Word overlap.
    var said = words(t);
    var NEG = /\b(dont|don t|not|no|never|havent|hadnt|isnt)\b/;
    var saidNeg = NEG.test(t.replace(/[^a-z ]/g, ''));
    var scored = options.map(function (o) {
      var w = words(o.label), hits = w.filter(function (x) { return said.some(function (s) { return s === x || (s.length > 4 && x.length > 4 && (s.indexOf(x.slice(0, 5)) === 0 || x.indexOf(s.slice(0, 5)) === 0)); }); }).length;
      var sc = w.length ? hits / Math.sqrt(w.length) : 0;
      // An answer that says "don't / not" only wins if they said a negative too.
      if (NEG.test(norm(o.label).replace(/[^a-z ]/g, '')) && !saidNeg) sc *= 0.3;
      return { o: o, s: sc, hits: hits };
    }).sort(function (a, b) { return b.s - a.s; });
    if (!scored.length || !scored[0].hits) return [];
    if (scored[1] && scored[1].s >= scored[0].s * 0.9) return [];
    return [scored[0].o];
  }
  function pickMany(transcript, options) {
    var parts = norm(transcript).split(/\band\b|,|\balso\b|\bplus\b/);
    var out = [];
    parts.forEach(function (p) { pick(p, options).forEach(function (o) { if (out.indexOf(o) < 0) out.push(o); }); });
    return out.length ? out : pick(transcript, options);
  }

  function listenOnce(onState) {
    if (mode === 'live') {
      var r = new SR(), heard = '', stopped = false;
      r.lang = lang; r.continuous = false; r.interimResults = false; r.maxAlternatives = 1;
      var p = new Promise(function (resolve, reject) {
        r.onresult = function (e) { heard = e.results[0][0].transcript; };
        r.onerror = function (e) { reject(new Error(e.error === 'not-allowed' ? 'denied' : e.error || 'failed')); };
        r.onend = function () { resolve(heard); };
      });
      try { r.start(); } catch (e) { return { promise: Promise.reject(e), stop: function () {} }; }
      onState('listening');
      return { promise: p, stop: function () { if (!stopped) { stopped = true; r.stop(); } } };
    }
    return recordClip(onState, 20000);
  }

  function attachChoice(button, status, options, multi, onPick) {
    if (!mode) { button.hidden = true; return; }
    var active = null;
    function setUi(state, msg) {
      button.classList.toggle('on', state === 'listening');
      button.classList.toggle('working', state === 'working');
      button.querySelector('[data-mic-label]').textContent = state === 'listening' ? (mode === 'record' ? 'Tap when you’re done' : 'Listening…') : state === 'working' ? 'One sec…' : 'Say your answer';
      if (msg != null) status.textContent = msg;
    }
    button.addEventListener('click', function () {
      if (active) { active.stop(); return; }
      setUi('listening', mode === 'record' ? 'Recording… say your answer, then tap.' : 'Listening… say your answer.');
      active = listenOnce(function (st) { setUi(st); });
      active.promise.then(function (text) {
        active = null;
        var found = text ? (multi ? pickMany(text, options) : pick(text, options)) : [];
        try { window.funnel.track('voice_input', { mode: mode, field: 'choice', what: found.length ? 'matched' : 'unmatched' }); } catch (e) { /* ignore */ }
        if (!text) return setUi('idle', 'Didn’t catch that. Try again, or tap an answer.');
        if (!found.length) return setUi('idle', 'Heard “' + text.slice(0, 80) + '”. Tap the closest answer.');
        setUi('idle', 'Heard “' + text.slice(0, 80) + '”.');
        onPick(found);
      }, function (err) {
        active = null;
        setUi('idle', err && err.message === 'denied' ? 'Microphone blocked. Tap an answer instead.' : 'Didn’t catch that. Try again, or tap an answer.');
      });
    });
  }

  window.VoiceInput = { mode: mode, attachText: attachText, attachChoice: attachChoice, _pick: pick, _pickMany: pickMany };
})();
