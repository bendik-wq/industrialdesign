/* Area C (audience) for our webinar rooms: tap-to-react bursts (aggregated by the room, one message a second),
   live captions (the host's microphone cut into short WAV pieces at pauses, transcribed by Workers AI Whisper,
   optional machine translation), chat threads and @host mentions, the AI co-host tab for the team (clustered
   questions, drafts from our knowledge base sent by a person, buying signals with first names), consented
   purchase announcements, personal offer moments (the attendee's own Deal Plan and application on the card,
   the real deadline, a question before buying), the one abandoned-checkout nudge, the away card, a floating
   window and a mini player, gentle haptics, keyboard shortcuts, screen-reader announcements, high contrast and
   text size. Every number and notice here comes from the server. Uses window.RoomCore from room.js. */
(function () {
  'use strict';
  var R = window.RoomCore;
  if (!R || !R.CFG || !R.CFG.audience) return;
  var CFG = R.CFG, A = CFG.audience, T = A.copy, S = R.S, esc = R.esc, $ = R.$, $$ = R.$$, h = R.h;
  var STAFF = R.isStaff;
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

  // ───────────── preferences (this browser only) ─────────────
  var KEY = 'rm-aud-prefs';
  var P = { cc: true, lang: '', contrast: false, font: 0, haptics: coarse };
  try { var saved = JSON.parse(localStorage.getItem(KEY) || 'null'); if (saved) Object.keys(P).forEach(function (k) { if (k in saved) P[k] = saved[k]; }); } catch (e) { /* private mode */ }
  function savePrefs() { try { localStorage.setItem(KEY, JSON.stringify(P)); } catch (e) { /* private mode */ } }
  function applyView() {
    var d = document.documentElement;
    d.classList.toggle('rx-contrast', Boolean(P.contrast));
    d.classList.remove('rx-font-1', 'rx-font-2');
    if (P.font) d.classList.add('rx-font-' + P.font);
  }
  applyView();
  function buzz(pattern) { if (!P.haptics || reduceMotion || !navigator.vibrate) return; try { navigator.vibrate(pattern); } catch (e) { /* not allowed */ } }

  var IC = {
    clap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 11.5 6.2 8.7a1.4 1.4 0 0 1 2-2l4.3 4.3M10.5 9 7.6 6.1a1.4 1.4 0 0 1 2-2l5 5"/><path d="M12.5 7.5 11 6a1.4 1.4 0 0 1 2-2l4.4 4.4a6 6 0 0 1 0 8.5l-.6.6a6 6 0 0 1-8.5 0L4.6 13.8a1.4 1.4 0 0 1 2-2L9 14.2"/><path d="M17 2.5l.5-1.5M20 4.5l1.3-.8M21 8h1.5"/></svg>',
    heart: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 20.5s-7.5-4.4-9.3-9.4C1.5 7.7 3.6 4.5 7 4.5c2 0 3.3 1.1 5 3 1.7-1.9 3-3 5-3 3.4 0 5.5 3.2 4.3 6.6-1.8 5-9.3 9.4-9.3 9.4z"/></svg>',
    idea: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2V16h5.2v-.2c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/></svg>',
    yes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 12.5l5 5 10-11"/></svg>',
    question: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9.2 9a3 3 0 1 1 4.2 2.8c-.9.4-1.4 1.1-1.4 2V15M12 18.5v.5"/></svg>',
    cc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10.5 10.2a2.5 2.5 0 1 0 0 3.6M17 10.2a2.5 2.5 0 1 0 0 3.6" stroke-linecap="round"/></svg>',
    pip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11" width="7" height="6" rx="1" fill="currentColor"/></svg>',
    view: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>',
  };
  var KINDS = ['clap', 'heart', 'idea', 'yes', 'question'];

  function room() { return S.view && S.view.room; }
  function live() { var r = room(); return Boolean(r && r.status === 'live'); }
  function fmtWhen(t) { try { return new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short', timeZoneName: 'short' }).format(new Date(t)); } catch (e) { return new Date(t).toLocaleString(); } }
  function ago(t) { var s = Math.max(0, Math.round((R.now() - t) / 1000)); return s < 60 ? s + ' s' : Math.round(s / 60) + ' min'; }
  function langName(code) { try { return new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' }).of(code) || code; } catch (e) { return code; } }

  // ───────────── screen-reader announcements ─────────────
  var sr = null;
  function say(text) {
    if (!text) return;
    sr = sr || document.body.appendChild(h('div', { class: 'rx-sr', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }));
    sr.textContent = '';
    setTimeout(function () { sr.textContent = text; }, 60);
  }

  // ───────────── mounting on the stage ─────────────
  var M = {};
  function mount() {
    var wrap = $('.rm-stagewrap');
    if (!wrap || wrap.querySelector('.rx-layer')) return Boolean(wrap);
    M.wrap = wrap;
    M.layer = wrap.appendChild(h('div', { class: 'rx-layer', 'aria-hidden': 'true' }));
    M.tally = M.layer.appendChild(h('div', { class: 'rx-tally' }));
    M.caps = wrap.appendChild(h('div', { class: 'rx-caps', role: 'region', 'aria-label': T.cc, 'aria-live': 'off', hidden: '' }));
    M.capnote = wrap.appendChild(h('button', { type: 'button', class: 'rx-capnote', hidden: '' }));
    M.capnote.onclick = function () { noticeOpen = !noticeOpen; drawNotice(); };
    M.tools = wrap.appendChild(h('div', { class: 'rx-tools' }));
    M.miniX = wrap.appendChild(h('button', { type: 'button', class: 'rx-mini-x', 'aria-label': T.pipOff }, '×'));
    M.miniX.onclick = function () { setMini(false, true); };
    if (STAFF) M.pulse = wrap.appendChild(h('div', { class: 'rx-pulse', 'aria-hidden': 'true', hidden: '' }));
    drawTools();
    drawCaps();
    drawNotice();
    return true;
  }
  function drawTools() {
    if (!M.tools) return;
    var html = '';
    if (A.reactions && !STAFF) html += '<div class="rx-react" role="group" aria-label="' + esc(T.react) + '">' + KINDS.map(function (k, i) { return '<button type="button" data-rx="' + k + '" aria-label="' + esc(T.reactions[k]) + ' (' + (i + 1) + ')" title="' + esc(T.reactions[k]) + '">' + IC[k] + '</button>'; }).join('') + '</div>';
    html += '<span class="rx-sp"></span>';
    if (A.captions) html += '<button type="button" class="rx-ib" data-rx-cc aria-pressed="' + Boolean(P.cc) + '" aria-label="' + esc(P.cc ? T.ccOn : T.ccOff) + '" title="' + esc(T.cc) + ' (C)">' + IC.cc + '</button>';
    html += '<button type="button" class="rx-ib" data-rx-pip aria-label="' + esc(T.pip) + '" title="' + esc(T.pip) + ' (P)">' + IC.pip + '</button>';
    html += '<button type="button" class="rx-ib" data-rx-view aria-label="' + esc(T.viewHeading) + '" title="' + esc(T.viewHeading) + ' (V)">' + IC.view + '</button>';
    M.tools.innerHTML = html;
    $$('[data-rx]', M.tools).forEach(function (b) { b.onclick = function () { react(b.getAttribute('data-rx')); }; });
    var cc = $('[data-rx-cc]', M.tools); if (cc) cc.onclick = toggleCaptions;
    $('[data-rx-pip]', M.tools).onclick = pip;
    $('[data-rx-view]', M.tools).onclick = openView;
    var rg = $('.rx-react', M.tools); if (rg) rg.hidden = !live();
  }

  // ───────────── reactions ─────────────
  var rxQueue = {}, rxTimer = 0, rxMine = {}, rxWindow = [];
  function react(kind) {
    if (!live() || KINDS.indexOf(kind) < 0) return;
    var t = Date.now();
    rxWindow = rxWindow.filter(function (x) { return t - x < 5000; });
    if (rxWindow.length >= 8) { R.toast(T.rxLimit); return; }
    rxWindow.push(t);
    burst(kind, 1, true);
    rxQueue[kind] = (rxQueue[kind] || 0) + 1;
    if (!rxTimer) rxTimer = setTimeout(sendReactions, 600);
  }
  function sendReactions() {
    rxTimer = 0;
    Object.keys(rxQueue).forEach(function (k) {
      var n = Math.min(4, rxQueue[k]);
      R.send({ t: 'react', kind: k, n: n });
      rxMine[k] = (rxMine[k] || 0) + n;
    });
    rxQueue = {};
  }
  function burst(kind, n, mine) {
    if (!M.layer || !IC[kind]) return;
    if (reduceMotion) { tally(kind, n); return; }
    var shown = Math.min(n, 10);
    for (var i = 0; i < shown; i++) {
      (function (i) {
        setTimeout(function () {
          var b = h('span', { class: 'rx-burst' + (mine ? ' is-big' : '') }, IC[kind]);
          b.style.left = (mine ? 8 : 55 + Math.random() * 38) + '%';
          b.style.setProperty('--dx', Math.round((Math.random() - 0.5) * 60) + 'px');
          if (i === 0 && n > shown) b.appendChild(h('span', { class: 'rx-burst-n' }, String(n)));
          M.layer.appendChild(b);
          setTimeout(function () { b.remove(); }, 2300);
        }, i * 90);
      })(i);
    }
  }
  var tallyTimer = 0, tallyCounts = {};
  function tally(kind, n) {
    tallyCounts[kind] = (tallyCounts[kind] || 0) + n;
    M.tally.innerHTML = Object.keys(tallyCounts).map(function (k) { return '<span>' + IC[k] + tallyCounts[k] + '</span>'; }).join('');
    clearTimeout(tallyTimer); tallyTimer = setTimeout(function () { tallyCounts = {}; M.tally.innerHTML = ''; }, 3000);
  }
  function onReactions(c) {
    Object.keys(c || {}).forEach(function (k) {
      var n = c[k], own = Math.min(n, rxMine[k] || 0);
      rxMine[k] = (rxMine[k] || 0) - own;
      if (n - own > 0) burst(k, n - own, false);
    });
  }
  function onPulse(m) {
    PULSE = m;
    if (M.pulse) {
      var s = (m.s || []).slice(-24), max = Math.max.apply(null, s.concat([1]));
      M.pulse.hidden = !s.some(function (x) { return x > 0; });
      M.pulse.innerHTML = s.map(function (x) { return '<i style="height:' + Math.max(1, Math.round(x / max * 20)) + 'px"></i>'; }).join('');
    }
    if (S.tab === 'cohost') drawPulseBlock();
  }
  var PULSE = null;

  // ───────────── captions ─────────────
  var CAP = { on: false, by: null, lines: [], seen: false };
  var noticeOpen = true, noticeTimer = 0;
  function toggleCaptions() { P.cc = !P.cc; savePrefs(); drawTools(); drawCaps(); say(P.cc ? T.ccOn : T.ccOff); }
  function drawNotice() {
    if (!M.capnote) return;
    M.capnote.hidden = !CAP.on;
    if (!CAP.on) return;
    M.capnote.innerHTML = '<b>CC</b><span>' + esc(noticeOpen ? T.ccNotice : T.ccOn) + '</span>';
    M.capnote.setAttribute('aria-expanded', String(noticeOpen));
    M.capnote.setAttribute('aria-label', T.ccNotice);
    clearTimeout(noticeTimer);
    if (noticeOpen) noticeTimer = setTimeout(function () { noticeOpen = false; drawNotice(); }, 10000);
  }
  function drawCaps() {
    if (!M.caps) return;
    var show = P.cc && CAP.on;
    var last = CAP.lines.slice(-2).filter(function (l) { return R.now() - l.at < 14000; });
    M.caps.hidden = !show || !last.length;
    if (M.caps.hidden) return;
    M.caps.innerHTML = last.map(function (l) { return '<p>' + esc(l.tr || l.text) + '</p>'; }).join('<br>') +
      (last[last.length - 1].tr ? '<span class="rx-cap-tr">' + esc(T.ccTranslated) + '</span>' : '');
  }
  setInterval(function () { if (M.caps && !M.caps.hidden) drawCaps(); }, 2000);
  function onCaption(m) {
    CAP.lines.push({ id: m.id, text: m.text, at: R.now(), by: m.by });
    if (CAP.lines.length > 300) CAP.lines.splice(0, CAP.lines.length - 300);
    if (!CAP.seen && P.cc) { CAP.seen = true; R.toast(T.ccMachine); }
    drawCaps();
  }
  function onCaptionTr(m) { CAP.lines.forEach(function (l) { if (l.id === m.id) l.tr = m.text; }); drawCaps(); }
  function setCapState(c) {
    var was = CAP.on;
    CAP.on = Boolean(c && c.on); CAP.by = c && c.by;
    if (CAP.on && !was) { noticeOpen = true; say(T.ccNotice); }
    drawNotice(); drawCaps();
    if (S.tab === 'cohost') drawCohost();
  }

  // ── the host's microphone → caption pieces ──
  var CAPT = null;
  function captioning() { return Boolean(CAPT); }
  function startCaptioning() {
    var mic = S.local && S.local.mic;
    if (!mic || mic.readyState !== 'live') { R.toast(T.ccHostNoMic); return; }
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    var ctx = new AC(), rate = ctx.sampleRate;
    var c = { ctx: ctx, track: mic, src: null, proc: null, buf: [], len: 0, voiced: 0, quiet: 0, startAt: 0, prev: '', inflight: 0, beat: 0 };
    function wire(track) {
      try { if (c.src) c.src.disconnect(); } catch (e) { /* gone */ }
      c.track = track;
      c.src = ctx.createMediaStreamSource(new MediaStream([track]));
      c.src.connect(c.proc);
    }
    c.proc = ctx.createScriptProcessor(4096, 1, 1);
    c.proc.onaudioprocess = function (e) {
      var x = e.inputBuffer.getChannelData(0), sum = 0;
      for (var i = 0; i < x.length; i++) sum += x[i] * x[i];
      var rms = Math.sqrt(sum / x.length), speaking = rms > 0.012 && S.micOn !== false && c.track.enabled;
      if (!c.len) c.startAt = R.now() - Math.round(x.length / rate * 1000);
      c.buf.push(new Float32Array(x)); c.len += x.length;
      if (speaking) { c.voiced++; c.quiet = 0; } else c.quiet++;
      var sec = c.len / rate;
      // Cut at a pause after 2.5 s, or at 8 s whatever happens; silent pieces are dropped, never sent.
      if ((sec >= 2.5 && c.quiet >= 2) || sec >= 8) {
        var pieces = c.buf, n = c.len, voiced = c.voiced, at = c.startAt;
        c.buf = []; c.len = 0; c.voiced = 0; c.quiet = 0;
        if (voiced >= 3) ship(c, pieces, n, rate, at);
      }
    };
    c.proc.connect(ctx.destination);
    wire(mic);
    c.watch = setInterval(function () { var m2 = S.local && S.local.mic; if (m2 && m2 !== c.track && m2.readyState === 'live') wire(m2); }, 3000);
    c.beat = setInterval(function () { R.send({ t: 'cap_on' }); }, 30000);
    R.send({ t: 'cap_on' });
    CAPT = c;
    if (ctx.state === 'suspended') ctx.resume().catch(function () {});
    drawCohost();
  }
  function stopCaptioning() {
    var c = CAPT; if (!c) return;
    CAPT = null;
    clearInterval(c.watch); clearInterval(c.beat);
    try { c.proc.disconnect(); c.src.disconnect(); } catch (e) { /* gone */ }
    c.ctx.close().catch(function () {});
    R.send({ t: 'cap_off' });
    drawCohost();
  }
  function ship(c, pieces, n, rate, at) {
    if (c.inflight >= 2) return;
    var wav = toWav(pieces, n, rate);
    c.inflight++;
    fetch(CFG.api + '/captions?t=' + encodeURIComponent(CFG.ticket) + '&start=' + at + '&prev=' + encodeURIComponent(c.prev.slice(-160)), { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav, credentials: 'same-origin' })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (d) { c.inflight--; if (d && d.ok && d.text) c.prev = d.text; else if (d && !d.ok && CAPT) { R.toast(T.ccHostError); } })
      .catch(function () { c.inflight--; });
  }
  /** Float32 pieces at the context's rate → 16 kHz mono 16-bit WAV. */
  function toWav(pieces, n, rate) {
    var ratio = rate / 16000, out = Math.floor(n / ratio), pcm = new Int16Array(out), all = new Float32Array(n), o = 0;
    pieces.forEach(function (p) { all.set(p, o); o += p.length; });
    for (var i = 0; i < out; i++) {
      var s = Math.floor(i * ratio), e = Math.min(n, Math.floor((i + 1) * ratio)), acc = 0, k = 0;
      for (var j = s; j < e; j++) { acc += all[j]; k++; }
      var v = k ? acc / k : 0; v = Math.max(-1, Math.min(1, v));
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    var buf = new ArrayBuffer(44 + pcm.length * 2), dv = new DataView(buf);
    function str(off, s) { for (var q = 0; q < s.length; q++) dv.setUint8(off + q, s.charCodeAt(q)); }
    str(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, 16000, true); dv.setUint32(28, 32000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    str(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
    new Int16Array(buf, 44).set(pcm);
    return new Blob([buf], { type: 'audio/wav' });
  }

  // ───────────── chat: threads, @host, the team's answers ─────────────
  var replyTo = null;
  R.chatExtra = function () { var x = replyTo ? { re: replyTo.id } : {}; setReply(null); return x; };
  function setReply(m) {
    replyTo = m;
    var form = $('[data-chat-form]'); if (!form) return;
    var bar = $('.rx-replying');
    if (!m) { if (bar) bar.remove(); return; }
    if (!bar) { bar = h('div', { class: 'rx-replying' }); form.parentNode.insertBefore(bar, form); }
    bar.innerHTML = '<span>' + esc(R.tpl(T.replyTo, m.name)) + '</span><button type="button" class="rm-mini" aria-label="' + esc(T.cancelReply) + '">×</button>';
    $('button', bar).onclick = function () { setReply(null); };
    var inp = $('input', form); if (inp) inp.focus();
  }
  function decorateChat(list) {
    var by = {}; (S.chat || []).forEach(function (m) { by[m.id] = m; });
    $$('li[data-mid]', list).forEach(function (li) {
      var m = by[Number(li.getAttribute('data-mid'))]; if (!m) return;
      if (m.label) {
        li.classList.add('is-answer');
        li.insertBefore(h('span', { class: 'rx-label' }, esc(m.label) + (m.q ? ': ' + esc(m.q) : '')), li.firstChild);
      }
      if (m.re && by[m.re]) li.insertBefore(h('span', { class: 'rx-quote' }, esc(by[m.re].name + ': ' + by[m.re].text)), li.firstChild);
      if (/(^|\s)@(host|josh|team|co-?host)\b/i.test(m.text)) li.classList.add('is-mention');
      if (!m.label) {
        var b = h('button', { type: 'button', class: 'rm-mini rx-reply', 'aria-label': R.tpl(T.replyTo, m.name) }, esc(T.reply));
        b.onclick = function () { setReply(m); };
        li.appendChild(b);
      }
    });
  }

  // ───────────── the AI co-host (staff) ─────────────
  var CO = { queue: [], hot: [], ai: false, auto: false, proofOn: false, edits: {} };
  if (STAFF) R.addTab({ id: 'cohost', label: T.cohostTab, at: 3, render: function (p) { drawCohost(p); } });
  function drawPulseBlock() {
    var el = $('[data-rx-pulse]'); if (!el) return;
    var s = PULSE && PULSE.s || [], max = Math.max.apply(null, s.concat([1])), last = s.slice(-6).reduce(function (a, b) { return a + b; }, 0);
    el.innerHTML = s.some(function (x) { return x > 0; }) ? '<div class="rx-spark" aria-hidden="true">' + s.map(function (x) { return '<i style="height:' + Math.max(1, Math.round(x / max * 40)) + 'px"></i>'; }).join('') + '</div><p class="rm-note">' + esc(R.tpl(T.pulsePerMin, last)) + '</p>' : '<p class="rm-note">' + esc(T.pulseNone) + '</p>';
  }
  function drawCohost(panel) {
    var p = panel || (S.tab === 'cohost' && $('[data-panel]'));
    if (!p || !STAFF) return;
    var a = document.activeElement, focusId = a && a.getAttribute && a.getAttribute('data-co-edit'), caret = null;
    if (focusId) { try { caret = [a.selectionStart, a.selectionEnd]; } catch (e) { caret = null; } }
    var open = CO.queue.filter(function (q) { return q.status === 'open'; });
    var capBtn = A.captions ? '<div class="rx-row"><button type="button" class="' + (captioning() ? 'rm-btn' : 'rm-primary') + '" data-co-cap>' + esc(captioning() ? T.ccHostStop : T.ccHostStart) + '</button>' + (captioning() ? '<span class="rm-note">' + esc(T.ccHostLive) + '</span>' : (CAP.on && CAP.by ? '<span class="rm-note">' + esc(T.ccOn + ': ' + CAP.by) + '</span>' : '')) + '</div><p class="rm-note">' + esc(T.ccHostNote) + '</p>' : '';
    p.innerHTML = '<div class="rx-co">' +
      (capBtn ? '<section class="rx-co-sec"><h3>' + esc(T.cc) + '</h3>' + capBtn + '</section>' : '') +
      '<section class="rx-co-sec"><h3>' + esc(T.cohostHeading) + '</h3><p class="rm-note">' + esc(T.cohostIntro) + '</p>' + (CO.ai ? '' : '<p class="rm-note">' + esc(T.cohostNoKey) + '</p>') + (CO.auto ? '<p class="rm-note">' + esc(T.cohostAuto) + '</p>' : '') +
      (CO.queue.length ? '<ul class="rx-q">' + CO.queue.map(qItem).join('') + '</ul>' : '<p class="rm-note">' + esc(T.cohostEmpty) + '</p>') + '</section>' +
      '<section class="rx-co-sec"><h3>' + esc(T.hotHeading) + '</h3><p class="rm-note">' + esc(T.hotIntro) + '</p>' +
      (CO.hot.length ? '<ul class="rx-hot">' + CO.hot.map(function (x) { return '<li><b>' + esc(x.first) + '</b><span>' + esc(x.signals.map(function (s) { return T.signals[s] || s; }).join(', ')) + ' · ' + esc(ago(x.at)) + '</span><span>“' + esc(x.text) + '”</span></li>'; }).join('') + '</ul>' : '<p class="rm-note">' + esc(T.hotEmpty) + '</p>') + '</section>' +
      '<section class="rx-co-sec"><h3>' + esc(T.pulseHeading) + '</h3><div data-rx-pulse></div></section>' +
      '<section class="rx-co-sec"><h3>' + esc(T.proofHeading) + '</h3><p class="rm-note">' + esc(T.proofBody) + '</p><button type="button" class="rm-btn" data-co-proof aria-pressed="' + CO.proofOn + '">' + esc(CO.proofOn ? T.proofOn : T.proofOff) + '</button></section>' +
      '</div>';
    drawPulseBlock();
    var cb = $('[data-co-cap]', p); if (cb) cb.onclick = function () { if (captioning()) stopCaptioning(); else startCaptioning(); };
    $('[data-co-proof]', p).onclick = function () { R.send({ t: 'proof_toggle', on: !CO.proofOn }); };
    $$('[data-co-edit]', p).forEach(function (ta) { ta.oninput = function () { CO.edits[ta.getAttribute('data-co-edit')] = ta.value; }; });
    $$('[data-co-send]', p).forEach(function (b) {
      b.onclick = function () {
        var id = Number(b.getAttribute('data-co-send')), ta = $('[data-co-edit="' + id + '"]', p), text = ta ? ta.value.trim() : '';
        if (!text) { R.toast(T.errors.empty); return; }
        R.send({ t: 'cohost_send', id: id, text: text, mode: b.getAttribute('data-mode') }); delete CO.edits[id];
      };
    });
    $$('[data-co-x]', p).forEach(function (b) { b.onclick = function () { R.send({ t: 'cohost_dismiss', id: Number(b.getAttribute('data-co-x')) }); }; });
    $$('[data-co-redraft]', p).forEach(function (b) { b.onclick = function () { var id = Number(b.getAttribute('data-co-redraft')); delete CO.edits[id]; R.send({ t: 'cohost_draft', id: id }); b.textContent = T.cohostDrafting; b.disabled = true; }; });
    if (focusId) { var t = $('[data-co-edit="' + focusId + '"]', p); if (t) { t.focus(); if (caret) try { t.setSelectionRange(caret[0], caret[1]); } catch (e) { /* fine */ } } }
    var badge = $('[data-badge="cohost"]'); if (badge) { badge.hidden = !open.length; badge.textContent = String(open.length); }
  }
  function qItem(q) {
    var done = q.status !== 'open';
    var tag = q.kind === 'prebuy' ? '<span class="rx-tag">' + esc(T.cohostPrebuy) + '</span>' : q.kind === 'mention' ? '<span class="rx-tag">' + esc(T.cohostMention) + '</span>' : '';
    var draft = CO.edits[q.id] != null ? CO.edits[q.id] : (q.draft ? q.draft.text : '');
    var src = q.draft && q.draft.sources && q.draft.sources.length ? '<p class="rx-src">' + esc(T.cohostSources + ': ' + q.draft.sources.join('; ') + ' · ' + (q.draft.by === 'ai' ? T.draftAi : T.draftKb)) + '</p>' : (!q.draft && q.kind !== 'mention' && !done ? '<p class="rx-src">' + esc(T.cohostNoDraft) + '</p>' : '');
    return '<li class="rx-qi' + (q.kind === 'prebuy' ? ' is-prebuy' : '') + (done ? ' is-done' : '') + '"><p class="rx-qi-t">' + tag + esc(q.text) + '</p>' +
      '<p class="rx-qi-m">' + esc(q.count === 1 ? T.cohostAskedOne : R.tpl(T.cohostAsked, q.count)) + ': ' + esc(q.names.join(', ')) + ' · ' + esc(ago(q.at)) + (done ? ' · ' + esc(q.status === 'sent' ? T.cohostSent : T.cohostDismiss) : '') + '</p>' +
      (done ? '' : '<textarea data-co-edit="' + q.id + '" aria-label="' + esc(T.cohostDraft) + '" maxlength="600">' + esc(draft) + '</textarea>' + src +
        '<div class="rx-acts"><button type="button" class="rm-primary" data-co-send="' + q.id + '" data-mode="room">' + esc(T.cohostSend) + '</button><button type="button" class="rm-btn" data-co-send="' + q.id + '" data-mode="private">' + esc(T.cohostSendPrivate) + '</button>' +
        '<button type="button" class="rm-btn" data-co-redraft="' + q.id + '">' + esc(T.cohostDraft) + '</button><button type="button" class="rm-btn" data-co-x="' + q.id + '">' + esc(T.cohostDismiss) + '</button></div>') + '</li>';
  }

  // ───────────── cards (the team's answer, the nudge, the away card) ─────────────
  function card(html, o) {
    o = o || {};
    var old = $('.rx-card[data-k="' + (o.key || 'x') + '"]'); if (old) old.remove();
    var el = h('div', { class: 'rx-card', role: 'dialog', 'aria-modal': 'false', 'data-k': o.key || 'x', 'aria-label': o.label || '' });
    el.innerHTML = '<button type="button" class="rm-card-close" aria-label="' + esc(T.close) + '">×</button>' + html;
    document.body.appendChild(el);
    $('.rm-card-close', el).onclick = function () { el.remove(); };
    return el;
  }
  function onTeamAnswer(m) {
    buzz(30);
    say(T.privateAnswer + '. ' + m.text);
    card('<p class="rm-eyebrow">' + esc(m.label) + '</p><h3>' + esc(T.privateAnswer) + '</h3><p class="rx-q">' + esc(m.q) + '</p><p style="color:var(--ink)">' + esc(m.text) + '</p>', { key: 'answer', label: T.privateAnswer });
  }
  function onNudge(m) {
    buzz([20, 60, 20]);
    var el = card('<h3>' + esc(T.nudgeHeading) + '</h3><p>' + esc(T.nudgeBody) + '</p><div class="rm-card-a"><button type="button" class="rm-buy" data-n-go>' + esc(T.nudgeFinish) + '</button><button type="button" class="rm-btn" data-n-ask>' + esc(T.askFirst) + '</button></div>', { key: 'nudge', label: T.nudgeHeading });
    say(T.nudgeHeading);
    $('[data-n-go]', el).onclick = function () {
      el.remove();
      if (m.kind === 'deposit' && m.offerOpen !== false) { R.openOffer(); return; }
      var e = S.view && S.view.eng, px = e && (e.pushes || []).filter(function (x) { return x.kind === m.kind; })[0];
      if (px) R.actPush(px); else R.openOffer();
    };
    $('[data-n-ask]', el).onclick = function () { el.remove(); askFirst(); };
  }
  function askFirst() {
    var d = R.sheet('ask');
    d.body.innerHTML = '<p class="rm-eyebrow">' + esc(T.askFirst) + '</p><h2>' + esc(T.askHeading) + '</h2><p>' + esc(T.askBody) + '</p>' +
      '<form data-ask-first><textarea class="rm-input" name="q" rows="4" maxlength="400" aria-label="' + esc(T.askPlaceholder) + '" placeholder="' + esc(T.askPlaceholder) + '"></textarea><p class="rm-err" role="alert" hidden></p><button type="submit" class="rm-primary" style="margin-top:12px">' + esc(T.askSend) + '</button></form>';
    var f = $('[data-ask-first]', d.body), err = $('.rm-err', f);
    $('textarea', f).focus();
    f.onsubmit = function (e) {
      e.preventDefault();
      var q = f.q.value.trim();
      if (q.length < 6) { err.textContent = T.askTooShort; err.hidden = false; return; }
      R.send({ t: 'prebuy_q', text: q });
      d.body.innerHTML = '<h2>' + esc(T.askHeading) + '</h2><p>' + esc(T.askSent) + '</p>';
      say(T.askSent);
    };
  }
  function onProof(m) {
    say(m.text);
    if (!M.wrap) return;
    var old = $('.rx-proof', M.wrap); if (old) old.remove();
    var el = M.wrap.appendChild(h('div', { class: 'rx-proof', 'aria-hidden': 'true' }, esc(m.text)));
    setTimeout(function () { el.remove(); }, 7000);
  }

  // ───────────── personal offer moments, consent, a question first, checkouts ─────────────
  var ME_DATA = null, meAt = 0, meLoading = null;
  function loadMe(force) {
    if (STAFF) return Promise.resolve(null);
    if (ME_DATA && !force && Date.now() - meAt < 20000) return Promise.resolve(ME_DATA);
    if (meLoading) return meLoading;
    meLoading = R.post('/audience/me').then(function (d) { meLoading = null; if (d && d.ok) { ME_DATA = d; meAt = Date.now(); } return ME_DATA; }).catch(function () { meLoading = null; return ME_DATA; });
    return meLoading;
  }
  function personalBlock(withDeadline) {
    var el = h('section', { class: 'rx-personal', 'aria-label': T.personal.heading, 'data-rx-personal': '' });
    var d = ME_DATA, lines = (d && d.lines) || [], o = room() && room().offer;
    var html = '<h3>' + esc(T.personal.heading) + '</h3>';
    html += lines.length ? '<dl>' + lines.map(function (l) { return '<dt>' + esc(l.label) + '</dt><dd>' + esc(l.text) + '</dd>'; }).join('') + '</dl>' : '<p class="rm-note" style="margin:0">' + esc(T.personal.empty) + '</p>';
    if (withDeadline && o && o.open && o.closesAt) html += '<p class="rx-deadline">' + esc(T.personal.deadline) + ' <strong>' + esc(fmtWhen(o.closesAt)) + '</strong></p>';
    el.innerHTML = html;
    return el;
  }
  function consentBlock() {
    var d = ME_DATA;
    if (!d || !d.lead || !d.preview || !d.preview.withoutCity) return null;
    var c = d.consent || { on: false, showCity: true }, pv = c.showCity && d.preview.withCity ? d.preview.withCity : d.preview.withoutCity;
    var el = h('div', { class: 'rx-consent', 'data-rx-consent': '' });
    el.innerHTML = '<label><input type="checkbox" data-c-on' + (c.on ? ' checked' : '') + '><span>' + esc(T.consentLabel.replace('{a}', pv)) + '</span></label>' +
      '<div class="rx-sub">' + (d.preview.hasCity ? '<label><input type="checkbox" data-c-city' + (c.showCity ? ' checked' : '') + '> ' + esc(T.consentCity) + '</label> · ' : '') + esc(T.consentHelp) + '</div>';
    function save() {
      var on = $('[data-c-on]', el).checked, city = $('[data-c-city]', el) ? $('[data-c-city]', el).checked : false;
      R.post('/audience/consent', { on: on, showCity: city }).then(function (r) {
        if (r && r.ok) { d.consent = { on: r.on, showCity: r.showCity }; var span = $('label span', el); if (span) span.textContent = T.consentLabel.replace('{a}', r.showCity && d.preview.withCity ? d.preview.withCity : d.preview.withoutCity); }
      });
    }
    $('[data-c-on]', el).onchange = save;
    var cc = $('[data-c-city]', el); if (cc) cc.onchange = save;
    return el;
  }
  function askButton() { var b = h('button', { type: 'button', class: 'rm-btn rx-ask', 'data-rx-ask': '' }, esc(T.askFirst)); b.onclick = askFirst; return b; }
  /** Adds the personal lines, the consent box and the question button to the offer and Sprint sheets as they open. */
  function decorate() {
    if (STAFF) return;
    var off = $('[data-offer-sheet] [data-offer]');
    if (off && !off.hasAttribute('data-rx')) {
      off.setAttribute('data-rx', '1');
      loadMe().then(function () {
        var head = $('.rm-offer-h', off), buy = $('[data-buy]', off);
        if (head && ME_DATA) head.parentNode.insertBefore(personalBlock(true), head.nextSibling);
        if (buy) { var cb = consentBlock(); if (cb) buy.parentNode.insertBefore(cb, buy); buy.parentNode.insertBefore(askButton(), buy.nextSibling); }
      });
    }
    var sp = $('[data-esheet="sprint"] [data-sp-buy]');
    if (sp && !sp.hasAttribute('data-rx')) {
      sp.setAttribute('data-rx', '1');
      loadMe().then(function () {
        var body = sp.closest('.rm-offer'), head = body && $('.rm-offer-h', body);
        if (head && ME_DATA) head.parentNode.insertBefore(personalBlock(false), head.nextSibling ? head.nextSibling.nextSibling : null);
        var cb = consentBlock(); if (cb) sp.parentNode.insertBefore(cb, sp);
        sp.parentNode.insertBefore(askButton(), sp.nextSibling);
      });
    }
    var app = $('[data-esheet="app"] .rm-sheet-body');
    if (app && $('.rm-app-nav', app) && !app.hasAttribute('data-rx')) {
      app.setAttribute('data-rx', '1');
      loadMe().then(function () { var cb = consentBlock(); if (cb) app.appendChild(cb); });
    }
  }
  new MutationObserver(function () { decorate(); syncMini(); }).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('click', function (e) {
    if (STAFF || !e.target.closest) return;
    var t = e.target;
    if (t.closest('[data-offer-sheet] [data-buy], [data-oc-confirm], [data-oc-other], .rm-offerbar [data-buy]')) R.send({ t: 'checkout', kind: 'deposit' });
    else if (t.closest('[data-sp-buy], [data-sp-confirm], [data-sp-other]')) R.send({ t: 'checkout', kind: 'sprint' });
  }, true);

  // ───────────── attention: the away card, the floating window, the mini player ─────────────
  var AWAY = null;
  document.addEventListener('visibilitychange', function () {
    if (!S.view) return;
    if (document.hidden) {
      var e = S.view.eng || {};
      AWAY = { at: R.now(), chapter: e.agenda ? e.agenda.chapter : -1, pushes: (e.pushes || []).map(function (x) { return x.id; }), offer: Boolean(room().offer && room().offer.open), lines: CAP.lines.length };
      return;
    }
    var a = AWAY; AWAY = null;
    if (!a || R.now() - a.at < 60000 || !live() || STAFF) return;
    var e2 = S.view.eng || {}, items = [];
    if (e2.agenda && e2.agenda.chapter !== a.chapter && e2.agenda.chapter >= 0) items.push('<p>' + esc(R.tpl(T.awayChapter, e2.agenda.items[e2.agenda.chapter].title)) + '</p>');
    var o = room().offer; if (o && o.open && !a.offer) items.push('<p>' + esc(T.awayOffer) + '</p>');
    var fresh = (e2.pushes || []).filter(function (x) { return a.pushes.indexOf(x.id) < 0; }).length;
    if (fresh) items.push('<p>' + esc(fresh === 1 ? T.awayCardsOne : R.tpl(T.awayCards, fresh)) + '</p>');
    var lines = CAP.lines.slice(a.lines).slice(-3);
    function show(ls) {
      if (ls.length) items.push('<p class="rm-eyebrow" style="margin-top:8px">' + esc(T.awaySaid) + '</p><div class="rx-lines">' + ls.map(function (l) { return '<p style="margin:0 0 4px;color:inherit">' + esc(l) + '</p>'; }).join('') + '</div>');
      if (!items.length) return;
      var el = card('<h3>' + esc(T.awayHeading) + '</h3>' + items.join('') + '<div class="rm-card-a"><button type="button" class="rm-primary" data-away-x>' + esc(T.awayBack) + '</button></div>', { key: 'away', label: T.awayHeading });
      $('[data-away-x]', el).onclick = function () { el.remove(); };
      say(T.awayHeading);
    }
    if (lines.length || !CAP.on) show(lines.map(function (l) { return l.tr || l.text; }));
    else R.post('/audience/catchup', { since: a.at }).then(function (d) { show(((d && d.lines) || []).slice(-3).map(function (l) { return l.text; })); }, function () { show([]); });
  });

  var PIP = null;
  function pip() {
    var stage = $('[data-stage]');
    if (!stage) return;
    if (PIP) { PIP.close(); return; }
    if (window.documentPictureInPicture && documentPictureInPicture.requestWindow) {
      documentPictureInPicture.requestWindow({ width: 480, height: 300 }).then(function (w) {
        $$('link[rel="stylesheet"], style').forEach(function (n) { w.document.head.appendChild(n.cloneNode(true)); });
        w.document.documentElement.className = document.documentElement.className;
        w.document.body.className = 'rm-body rx-pip-body';
        var wrap = M.wrap, parent = wrap.parentNode, next = wrap.nextSibling;
        var ph = h('div', { class: 'rm-stage rm-stage--lobby' }, '<p class="rm-note">' + esc(T.pip) + '</p>');
        parent.insertBefore(ph, wrap);
        w.document.body.appendChild(wrap);
        $$('video', wrap).forEach(function (v) { v.play().catch(function () {}); });
        PIP = { close: function () { w.close(); } };
        w.addEventListener('pagehide', function () {
          parent.insertBefore(wrap, next && next.parentNode === parent ? next : ph);
          ph.remove(); PIP = null;
          $$('video', wrap).forEach(function (v) { v.play().catch(function () {}); });
        });
      }).catch(function () { videoPip(stage); });
      return;
    }
    videoPip(stage);
  }
  function videoPip(stage) {
    var vids = $$('video', stage).filter(function (v) { return v.srcObject && v.readyState >= 2; });
    var v = vids.sort(function (a, b) { return b.clientWidth - a.clientWidth; })[0];
    if (v && document.pictureInPictureEnabled && v.requestPictureInPicture) { v.requestPictureInPicture().catch(function () { R.toast(T.pipUnsupported); }); return; }
    if (v && v.webkitSetPresentationMode) { try { v.webkitSetPresentationMode('picture-in-picture'); return; } catch (e) { /* no */ } }
    R.toast(T.pipUnsupported);
  }
  // The mini player: on a phone, while a sheet covers the room (the Deal Plan, the application, the offer), the stage
  // keeps playing in a small window in the corner. Tap × to bring it back.
  var miniManual = null;
  function setMini(on, manual) { if (manual) miniManual = on; document.body.classList.toggle('rx-mini', Boolean(on)); }
  function syncMini() {
    if (!M.wrap || PIP) return;
    var narrow = window.innerWidth < 900, sheetOpen = Boolean($('.rm-sheet'));
    if (!sheetOpen) miniManual = null;
    setMini(narrow && sheetOpen && miniManual !== false && live());
  }
  window.addEventListener('resize', syncMini);

  // ───────────── view settings and shortcuts ─────────────
  function openView() {
    var d = R.sheet('view');
    d.body.innerHTML = '<h2>' + esc(T.viewHeading) + '</h2><div class="rx-view">' +
      (A.captions ? '<label class="rx-check"><input type="checkbox" data-v-cc' + (P.cc ? ' checked' : '') + '> ' + esc(T.cc) + '</label>' +
        '<label class="rm-field"><span>' + esc(T.ccLanguage) + '</span><select data-v-lang><option value="">' + esc(T.ccOriginal) + '</option>' + (A.langs || []).map(function (l) { return '<option value="' + esc(l) + '"' + (P.lang === l ? ' selected' : '') + '>' + esc(langName(l)) + '</option>'; }).join('') + '</select></label><p class="rm-note" style="margin:-8px 0 0">' + esc(T.ccMachine) + '</p>' : '') +
      '<label class="rx-check"><input type="checkbox" data-v-contrast' + (P.contrast ? ' checked' : '') + '> ' + esc(T.contrast) + '</label>' +
      '<div><p class="rm-note" style="margin:0 0 6px">' + esc(T.fontSize) + '</p><div class="rx-seg" role="group" aria-label="' + esc(T.fontSize) + '">' + T.fontSizes.map(function (s, i) { return '<button type="button" data-v-font="' + i + '" aria-pressed="' + (P.font === i) + '">' + esc(s) + '</button>'; }).join('') + '</div></div>' +
      (navigator.vibrate ? '<label class="rx-check"><input type="checkbox" data-v-hap' + (P.haptics ? ' checked' : '') + '> ' + esc(T.haptics) + '</label>' : '') +
      '<div><p class="rm-note" style="margin:0 0 6px">' + esc(T.shortcuts) + '</p><dl class="rx-keys">' + T.shortcutList.map(function (k) { return '<dt><kbd>' + esc(k[0]) + '</kbd></dt><dd>' + esc(k[1]) + '</dd>'; }).join('') + '</dl></div></div>';
    var b = d.body;
    var cc = $('[data-v-cc]', b); if (cc) cc.onchange = function () { P.cc = cc.checked; savePrefs(); drawTools(); drawCaps(); };
    var lg = $('[data-v-lang]', b); if (lg) lg.onchange = function () { P.lang = lg.value; savePrefs(); R.send({ t: 'cap_lang', lang: P.lang || null }); };
    $('[data-v-contrast]', b).onchange = function () { P.contrast = this.checked; savePrefs(); applyView(); };
    $$('[data-v-font]', b).forEach(function (x) { x.onclick = function () { P.font = Number(x.getAttribute('data-v-font')); savePrefs(); applyView(); $$('[data-v-font]', b).forEach(function (y) { y.setAttribute('aria-pressed', String(y === x)); }); }; });
    var hp = $('[data-v-hap]', b); if (hp) hp.onchange = function () { P.haptics = hp.checked; savePrefs(); };
  }
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var t = e.target, tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
    var k = e.key;
    if (k === 'c' || k === 'C') { if (A.captions) toggleCaptions(); }
    else if (/^[1-5]$/.test(k) && !STAFF) react(KINDS[Number(k) - 1]);
    else if (k === 'p' || k === 'P') pip();
    else if (k === 'v' || k === 'V') openView();
    else if (k === 'h' || k === 'H') { var hb = $('[data-hand]'); if (hb) hb.click(); }
    else if (k === 'o' || k === 'O') { if (room() && room().offer && room().offer.open && !STAFF) R.openOffer(); }
    else if (k === '?') { openView(); }
    else if (k === 'Escape') { var c = $('.rx-card'); if (c) c.remove(); }
    else return;
    e.preventDefault();
  });

  // ───────────── the room's messages and state ─────────────
  var seenPush = {}, firstState = true;
  R.on('msg', function (m) {
    switch (m.t) {
      case 'aud': setCapState(m.captions); if (P.lang && !STAFF) R.send({ t: 'cap_lang', lang: P.lang }); return;
      case 'rx': onReactions(m.c); return;
      case 'rx_pulse': onPulse(m); return;
      case 'cap': onCaption(m); return;
      case 'cap_tr': onCaptionTr(m); return;
      case 'cap_state': setCapState(m); return;
      case 'cohost': CO.queue = m.queue || []; CO.hot = m.hot || []; CO.ai = Boolean(m.ai); CO.auto = Boolean(m.auto); CO.proofOn = Boolean(m.proofOn); if (m.captions) CAP.on = m.captions.on; drawCohost(); return;
      case 'team_answer': onTeamAnswer(m); return;
      case 'nudge': onNudge(m); return;
      case 'proof': onProof(m); return;
      case 'error': if (m.for === 'react' && m.error === 'rx_limit') { /* the toast from room.js says it */ } return;
    }
  });
  R.on('chat', decorateChat);
  R.on('state', function (prev) {
    if (!mount()) return;
    var rg = $('.rx-react', M.tools); if (rg) rg.hidden = !live();
    if (S.tab === 'cohost') { /* drawn by the tab */ }
    // Screen readers and haptics: the offer opening or closing, a new card for me.
    var o = room().offer || {}, was = prev && prev.room && prev.room.offer && prev.room.offer.open;
    if (!firstState && !STAFF) {
      if (o.open && !was) { buzz([30, 50, 30]); say(T.srOfferOpen + (o.closesAt ? ' ' + R.tpl(T.srOfferCloses, fmtWhen(o.closesAt)) : '')); loadMe(true); }
      if (!o.open && was) say(T.srOfferClosed);
    }
    var e = S.view.eng;
    if (e && !STAFF) (e.pushes || []).forEach(function (x) {
      if (seenPush[x.id]) return;
      seenPush[x.id] = 1;
      if (firstState) return;
      buzz(25);
      say(R.tpl(T.srPush, T.pushTitles[x.kind] || T.pushTitles.resource));
      if (x.kind === 'sprint' || x.kind === 'deposit') loadMe(true);
    });
    firstState = false;
    syncMini();
  });
  // A late mount (the script loaded after the first state): ask the room for our part.
  if (S.view) { mount(); R.send({ t: 'aud_hello' }); }
})();
