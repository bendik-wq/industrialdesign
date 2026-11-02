/* Funnel HQ → Rooms → Debrief and Content → Clips (area D, src/rooms/intel*.ts).
   For each webinar room: the transcript job (Whisper on the R2 recording, resumable), the debrief (Claude when the
   key is set, else built from the numbers; every number from the room's data), the engagement heatmap on one time
   axis with the transcript beside it (click a moment to jump the recording there), the replay link, "Use for
   showings" (simulive: the automated webinar plays this recording, labelled as a recorded session), and highlight
   clips with an export to MP4 or WebM made in this browser from the recording (MediaRecorder, captions burned in).
   admin-rooms.js calls IntelBoard.button(row) and IntelBoard.wire(box, ctx); admin.js calls IntelBoard.content(ctx). */
(function (root) {
  'use strict';
  var CSS = [
    '.ixa-dlg{position:fixed;inset:0;z-index:220;background:rgba(0,0,0,.35);display:grid;place-items:stretch;padding:24px}',
    '.ixa-in{background:var(--surface,#fff);color:var(--ink,#111);border-radius:14px;overflow:auto;display:grid;grid-template-rows:auto 1fr;max-width:1500px;width:100%;margin:0 auto}',
    '.ixa-top{position:sticky;top:0;z-index:2;background:var(--surface,#fff);border-bottom:1px solid var(--border);padding:14px 20px;display:flex;flex-wrap:wrap;gap:10px;align-items:center}',
    '.ixa-top h2{margin:0;font-size:17px;flex:1 1 280px}.ixa-status{font-size:12.5px;color:var(--ink-2);flex-basis:100%}',
    '.ixa-body{padding:18px 20px 28px;display:grid;grid-template-columns:minmax(0,1fr);gap:22px}.ixa-body section{scroll-margin-top:120px;min-width:0}.ixa-two>div{min-width:0}',
    '.ixa-two{display:grid;gap:20px;grid-template-columns:minmax(0,1fr) 360px;align-items:start}',
    '.ixa-player video{width:100%;border-radius:10px;background:#000;aspect-ratio:16/9;display:block}',
    '.ixa-tr{max-height:520px;overflow:auto;border:1px solid var(--border);border-radius:10px;padding:6px}',
    '.ixa-tr button{display:block;width:100%;text-align:left;border:0;background:none;padding:6px 8px;border-radius:7px;font:inherit;font-size:13px;line-height:1.45;color:var(--ink);cursor:pointer}',
    '.ixa-tr button:hover{background:var(--surface-2)}.ixa-tr button[aria-current="true"]{background:var(--series-1-wash)}',
    '.ixa-tr time,.ixa-list time{color:var(--muted);font-variant-numeric:tabular-nums;font-size:11.5px;margin-right:6px}.ixa-tr b{color:var(--tier-a);font-size:11.5px;margin-right:4px}',
    '.ixa-heatwrap{overflow-x:auto;-webkit-overflow-scrolling:touch}.ixa-heat{width:100%;min-width:820px;display:block;cursor:crosshair}.ixa-heat text{font:11px var(--font);fill:var(--ink-2)}.ixa-heat .ixa-lab{fill:var(--ink-2);font-weight:600}',
    '.ixa-tip{position:fixed;z-index:230;pointer-events:none;background:var(--ink);color:var(--surface);padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.45;max-width:320px}',
    '.ixa-grid{display:grid;gap:18px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}',
    '.ixa-card{border:1px solid var(--border);border-radius:12px;padding:14px 16px}.ixa-card h3{margin:0 0 8px;font-size:14px}',
    '.ixa-list{list-style:none;margin:0;padding:0;font-size:13px;display:grid;gap:8px}.ixa-list li{line-height:1.45}',
    '.ixa-list button.ixa-t{border:0;background:none;color:var(--tier-a);padding:0;font:inherit;font-weight:600;cursor:pointer;text-decoration:underline;text-underline-offset:2px}',
    '.ixa-sum{font-size:14.5px;line-height:1.55;max-width:90ch;margin:0}.ixa-note{font-size:12px;color:var(--ink-2);margin:6px 0 0}',
    '.ixa-q{color:var(--ink-2);font-style:italic}',
    '.ixa-clips{display:grid;gap:12px}.ixa-clip{display:grid;gap:8px;grid-template-columns:minmax(0,1fr) auto;border:1px solid var(--border);border-radius:12px;padding:12px 14px}',
    '.ixa-clip input,.ixa-clip textarea{width:100%;font:inherit;font-size:13px;padding:6px 8px;border:1px solid var(--border);border-radius:7px;background:var(--surface);color:var(--ink)}.ixa-clip textarea{min-height:56px}',
    '.ixa-clip .ixa-act{display:flex;flex-direction:column;gap:6px;align-items:stretch}.ixa-meta{font-size:12px;color:var(--ink-2)}',
    '.ixa-prog{height:4px;background:var(--surface-2);border-radius:2px;overflow:hidden}.ixa-prog i{display:block;height:100%;background:var(--series-1);width:0}',
    '.ixa-legend{display:flex;flex-wrap:wrap;gap:12px;font-size:12px;color:var(--ink-2);margin:6px 0 0}.ixa-legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}',
    '@media (max-width:1000px){.ixa-two{grid-template-columns:1fr}.ixa-dlg{padding:0}.ixa-in{border-radius:0}.ixa-top{position:static;padding:12px 16px}.ixa-top h2{flex-basis:100%}.ixa-body{padding:14px 16px 24px}.ixa-body section{scroll-margin-top:8px}}',
  ].join('');
  function css() { if (!document.getElementById('ixa-css')) { var s = document.createElement('style'); s.id = 'ixa-css'; s.textContent = CSS; document.head.appendChild(s); } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function req(method, path, body) {
    return fetch('/admin/api/intel/' + path, { method: method, credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) }).then(function (r) { return r.json(); });
  }
  function stamp(ms) { var s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); }
  function mins(ms) { return Math.round(ms / 60000); }
  var JOB = { queued: 'Queued', running: 'Transcribing', done: 'Transcribed', failed: 'Failed', no_ai: 'Workers AI not available', unsupported: 'Format not supported' };

  // ───────────── the Debrief panel ─────────────
  function button(r) { return '<button class="btn-sm ghost" data-ix-debrief="' + esc(r.id) + '">Debrief</button>'; }
  function wire(box, ctx) {
    box.querySelectorAll('[data-ix-debrief]').forEach(function (b) { b.onclick = function () { open(b.getAttribute('data-ix-debrief'), ctx); }; });
  }

  var P = null; // the open panel: { id, d, el, ctx, video }
  function open(id, ctx) {
    css();
    var old = document.querySelector('[data-ixa-dlg]'); if (old) old.remove();
    var dlg = document.createElement('div');
    dlg.className = 'ixa-dlg'; dlg.setAttribute('data-ixa-dlg', ''); dlg.setAttribute('role', 'dialog'); dlg.setAttribute('aria-modal', 'true'); dlg.setAttribute('aria-label', 'Debrief');
    dlg.innerHTML = '<div class="ixa-in"><div class="ixa-top"><h2>Loading the debrief…</h2><button class="btn-sm ghost" data-ixa-close>Close</button></div><div class="ixa-body"></div></div>';
    document.body.appendChild(dlg);
    var close = function () { dlg.remove(); P = null; document.removeEventListener('keydown', onKey); };
    var onKey = function (e) { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    dlg.querySelector('[data-ixa-close]').onclick = close;
    dlg.onclick = function (e) { if (e.target === dlg) close(); };
    P = { id: id, el: dlg, ctx: ctx, close: close };
    load();
  }
  function load() {
    if (!P) return Promise.resolve();
    return req('GET', 'rooms/' + P.id).then(function (d) { if (!P) return; P.d = d; draw(); });
  }
  function toast(t) { if (P && P.ctx && P.ctx.toast) P.ctx.toast(t); }

  function jobLine(d) {
    if (!d.rec) return 'No recording yet. Record the session from the host room (it uploads to R2 and becomes the replay).';
    var j = d.job, s = 'Recording ' + stamp(d.rec.durationMs) + ' · ';
    if (!d.ai.whisper) s += 'Workers AI is not bound here, so no Whisper transcript';
    else if (!j) s += 'Not transcribed yet';
    else if (j.status === 'no_ai') s += 'Workers AI is not reachable from here, so Whisper did not run (press Transcribe again once it is)';
    else s += (JOB[j.status] || j.status) + (j.size ? ' ' + Math.min(100, Math.round((j.next_offset / j.size) * 100)) + '%' : '') + ' · ' + j.chunks + ' chunks' + (j.gaps ? ' · ' + j.gaps + ' skipped (unreadable, left blank)' : '') + (j.error && j.status !== 'done' ? ' · ' + j.error : '');
    s += ' · Lines from ' + (d.transcriptSource === 'whisper' ? 'Whisper' : d.transcriptSource === 'captions' ? 'the live captions' : 'nowhere yet');
    s += ' · Debrief by ' + (d.ai.claude ? 'Claude (numbers checked)' : 'rules (no Anthropic key)');
    return s;
  }

  function draw() {
    var d = P.d, el = P.el;
    if (!d || !d.ok) { el.querySelector('.ixa-body').innerHTML = '<p class="muted">' + esc((d && d.error) || 'Couldn’t load this room.') + '</p>'; return; }
    var j = d.job;
    var running = j && (j.status === 'queued' || j.status === 'running');
    var top = el.querySelector('.ixa-top');
    top.innerHTML = '<h2>' + esc(d.room.title) + '</h2>' +
      (d.rec && d.ai.whisper ? '<button class="btn-sm" data-ixa-tr>' + (running ? 'Continue transcribing' : j && j.status !== 'queued' ? 'Transcribe again' : 'Transcribe') + '</button>' : '') +
      '<button class="btn-sm" data-ixa-deb>' + (d.debrief ? 'Rewrite the debrief' : 'Write the debrief') + '</button>' +
      (d.debrief ? '<button class="btn-sm ghost" data-ixa-post>' + (d.docId ? 'Posted to Command · post again' : 'Post to Command') + '</button>' : '') +
      (d.replayUrl ? '<a class="btn-sm ghost" href="' + esc(d.replayUrl) + '" target="_blank" rel="noopener">Open the replay</a>' : '') +
      (d.rec ? '<button class="btn-sm ghost" data-ixa-ed>' + (d.edition.active ? 'Playing in showings · refresh' : 'Use for showings') + '</button>' : '') +
      (d.rec ? '<button class="btn-sm ghost" data-ixa-clips>' + (d.clips.length ? 'Suggest clips again' : 'Suggest clips') + '</button>' : '') +
      '<button class="btn-sm ghost" data-ixa-close>Close</button><p class="ixa-status" data-ixa-status>' + esc(jobLine(d)) + '</p>';
    top.querySelector('[data-ixa-close]').onclick = P.close;
    var body = el.querySelector('.ixa-body');
    body.innerHTML =
      '<section data-ixa-debrief>' + debriefHtml(d) + '</section>' +
      '<section><h3 style="margin:0 0 6px;font-size:15px">Engagement timeline</h3><p class="ixa-note" style="margin:0 0 8px">One row per signal, one column per minute of the ' + (d.origin === 'recording' ? 'recording' : 'session') + '. Darker means more. Click a minute to jump the recording there.</p>' +
        '<div data-ixa-heatwrap class="ixa-heatwrap" tabindex="0" aria-label="Engagement timeline (scrolls sideways on small screens)">' + heatSvg(d) + '</div>' + legend() + '</section>' +
      '<section class="ixa-two"><div class="ixa-player">' + (d.rec ? '<video data-ixa-v controls preload="metadata" src="' + esc(d.rec.url) + '"></video>' : '<p class="muted">No recording: the timeline still shows the live signals.</p>') +
        '<h3 style="margin:16px 0 6px;font-size:15px">Highlight clips</h3><div data-ixa-cliplist>' + clipsHtml(d.clips) + '</div></div>' +
        '<div><h3 style="margin:0 0 6px;font-size:15px">Transcript</h3>' + (d.lines.length ? '<div class="ixa-tr" data-ixa-tr-list>' + transcriptHtml(d.lines) + '</div>' : '<p class="muted">' + (d.rec ? 'No lines yet. Press Transcribe.' : 'No transcript.') + '</p>') + '</div></section>';
    P.video = body.querySelector('[data-ixa-v]');
    wirePanel();
  }

  function seekTo(ms) {
    var v = P && P.video;
    if (v) { try { v.currentTime = ms / 1000; } catch (e) { /* loading */ } v.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    followLine(ms, true);
  }
  function followLine(ms, scroll) {
    var list = P && P.el.querySelector('[data-ixa-tr-list]'); if (!list) return;
    var best = null;
    list.querySelectorAll('[data-s]').forEach(function (b) { if (Number(b.getAttribute('data-s')) <= ms) best = b; b.removeAttribute('aria-current'); });
    if (best) { best.setAttribute('aria-current', 'true'); if (scroll) list.scrollTop = best.offsetTop - list.offsetTop - 60; }
  }

  function debriefHtml(d) {
    var b = d.debrief;
    if (!b) return '<div class="ixa-card"><h3>Debrief</h3><p class="muted" style="margin:0">Not written yet. ' + (d.rec && !d.lines.length && d.ai.whisper ? 'Transcribe the recording first for the lines, or write it now from the numbers.' : 'Press Write the debrief.') + '</p></div>';
    var t = function (ms) { return '<button type="button" class="ixa-t" data-ixa-seek="' + ms + '">' + esc(stamp(ms)) + '</button>'; };
    var st = b.stats;
    var stats = [['People', st.people], ['Peak', st.peak], ['Minutes live', st.liveMinutes], ['Chat', st.chat], ['Questions', st.questions], ['Reactions', st.reactions == null ? '–' : st.reactions], ['Applications', st.applications], ['Purchases', st.purchases]];
    var card = function (h, inner) { return '<div class="ixa-card"><h3>' + esc(h) + '</h3>' + inner + '</div>'; };
    var list = function (items, f, empty) { return items && items.length ? '<ul class="ixa-list">' + items.map(f).join('') + '</ul>' : '<p class="muted" style="margin:0;font-size:13px">' + esc(empty) + '</p>'; };
    return '<div class="ixa-card" style="display:grid;gap:10px"><h3 style="margin:0">Debrief <span class="muted" style="font-weight:400">· ' + (b.source === 'claude' ? 'Claude, every number checked against the data' : 'built from the numbers') + (d.debriefAt ? ' · ' + esc(new Date(d.debriefAt).toLocaleString()) : '') + '</span></h3>' +
        '<p class="ixa-sum">' + esc(b.summary) + '</p>' +
        '<div style="display:flex;flex-wrap:wrap;gap:18px;font-size:13px">' + stats.map(function (x) { return '<div><div class="muted" style="font-size:11.5px">' + esc(x[0]) + '</div><strong style="font-size:18px;font-variant-numeric:tabular-nums">' + esc(x[1]) + '</strong></div>'; }).join('') + '</div>' +
        (d.debriefNote ? '<p class="ixa-note">' + esc(d.debriefNote) + '</p>' : '') + (b.notes || []).map(function (n) { return '<p class="ixa-note">' + esc(n) + '</p>'; }).join('') + '</div>' +
      '<div class="ixa-grid" style="margin-top:14px">' +
        card('Where people left', list(b.leaks, function (x) { return '<li>' + t(x.fromMs) + ' ' + esc(x.text.replace(/^You lost/, 'Lost')) + '</li>'; }, 'No drop of 8% or more over three minutes.')) +
        card('What came right before applying and buying', list(b.spikes, function (x) { return '<li>' + t(x.ms) + ' ' + esc(x.text) + '</li>'; }, 'Nobody applied or bought in the room.')) +
        card('Objections raised in chat and Q&A', list(b.objections, function (x) { return '<li><strong>' + esc(x.topic) + '</strong> · ' + x.count + (x.count === 1 ? ' message' : ' messages') + x.quotes.map(function (q) { return '<br>' + t(q.ms) + ' <span class="ixa-q">"' + esc(q.text) + '"</span>'; }).join('') + '</li>'; }, 'No objections found in the messages.')) +
        // qa-sells: objection types from the co-host's tagged questions, against real purchases afterwards.
        (b.objectionOutcomes && b.objectionOutcomes.length ? card('Objections before buying', list(b.objectionOutcomes, function (x) { return '<li><strong>' + esc(x.label) + '</strong> · ' + x.people + (x.people === 1 ? ' person' : ' people') + ' · ' + x.bought + ' bought after · ' + x.notBought + ' didn’t' + (x.reopened ? ' · ' + x.reopened + ' answered with the offer reopened, ' + x.boughtAfterReopen + ' of them bought' : '') + '</li>'; }, '')) : '') +
        card('Best moments', list(b.moments, function (x) { return '<li>' + t(x.ms) + ' ' + esc(x.text.replace(/^[\d:]+: /, '')) + '</li>'; }, 'No activity recorded yet.')) +
        card('Chapters', list(b.chapters, function (x) { return '<li>' + t(x.ms) + ' ' + esc(x.title) + '</li>'; }, 'No chapters.')) +
        card('Script changes for the next run', list(b.improvements, function (x) { return '<li>' + esc(x) + '</li>'; }, 'Nothing to change from the data yet.')) +
      '</div>';
  }

  // ───────────── the heatmap ─────────────
  var ROWS = [
    { k: 'retention', label: 'Retention', color: 'var(--series-1)' },
    { k: 'reactions', label: 'Reactions', color: 'var(--series-1)' },
    { k: 'chat', label: 'Chat', color: 'var(--series-1)' },
    { k: 'questions', label: 'Questions', color: 'var(--series-1)' },
    { k: 'pushes', label: 'Pushes', color: 'var(--tier-a)' },
    { k: 'opened', label: 'Cards opened', color: 'var(--tier-a)' },
    { k: 'applications', label: 'Applications', color: 'var(--tier-a)' },
    { k: 'purchases', label: 'Purchases', color: 'var(--good)' },
  ];
  function legend() { return '<div class="ixa-legend"><span><i style="background:var(--series-1)"></i>Audience signals</span><span><i style="background:var(--tier-a)"></i>Pushes and applications</span><span><i style="background:var(--good)"></i>Purchases</span><span>Retention row: people in the room that minute (line)</span></div>'; }
  function heatSvg(d) {
    var rows = d.heat || [], n = rows.length || 1;
    var L = 104, W = 1100, cw = (W - L - 8) / n, RH = 22, top = 22, H = top + ROWS.length * (RH + 4) + 14 + 22;
    var max = {}; ROWS.forEach(function (r) { max[r.k] = Math.max.apply(null, rows.map(function (x) { return x[r.k] || 0; }).concat([1])); });
    var s = '<svg class="ixa-heat" data-ixa-heat viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Engagement by minute: retention, reactions, chat, questions, pushes, cards opened, applications and purchases">';
    // chapters along the top
    (d.chapters || []).forEach(function (c) { var x = L + (c.ms / 60000) * cw; if (x < W) s += '<line x1="' + x + '" x2="' + x + '" y1="14" y2="' + (H - 18) + '" stroke="var(--axis)" stroke-dasharray="2 3"/><text x="' + (x + 3) + '" y="11">' + esc(c.title.slice(0, 26)) + '</text>'; });
    ROWS.forEach(function (r, i) {
      var y = top + i * (RH + 4) + (i > 0 ? 14 : 0);
      s += '<text class="ixa-lab" x="0" y="' + (y + 15) + '">' + esc(r.label) + '</text>';
      if (r.k === 'retention') {
        // Scaled from the lowest to the highest minute so a fall is visible; the real numbers are labelled.
        var vals = rows.map(function (x) { return x.retention; }).filter(function (v) { return v != null; });
        var lo = vals.length ? Math.min.apply(null, vals) : 0, hi = vals.length ? Math.max.apply(null, vals) : 1, span = Math.max(1, hi - lo);
        var pts = rows.map(function (x, m) { return x.retention == null ? null : [L + m * cw + cw / 2, y + RH - 3 - ((x.retention - lo) / span) * (RH - 6)]; }).filter(Boolean);
        if (vals.length) s += '<text x="' + (L - 6) + '" y="' + (y + 9) + '" text-anchor="end" style="font-size:9.5px">' + hi + '</text><text x="' + (L - 6) + '" y="' + (y + RH) + '" text-anchor="end" style="font-size:9.5px">' + lo + '</text>';
        RH += 14;
        s += '<rect x="' + L + '" y="' + y + '" width="' + (W - L - 8) + '" height="' + RH + '" fill="var(--surface-2)" rx="3"/>';
        if (pts.length) s += '<polyline fill="none" stroke="var(--series-1)" stroke-width="2" points="' + pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ') + '"/>';
        RH -= 14;
        return;
      }
      rows.forEach(function (x, m) {
        var v = x[r.k] || 0;
        s += '<rect x="' + (L + m * cw + 0.5).toFixed(1) + '" y="' + y + '" width="' + Math.max(1, cw - 1).toFixed(1) + '" height="' + RH + '" rx="2" fill="' + (v ? r.color : 'var(--surface-2)') + '"' + (v ? ' fill-opacity="' + (0.2 + 0.8 * v / max[r.k]).toFixed(2) + '"' : '') + '/>';
      });
    });
    // time axis
    var step = n > 90 ? 15 : n > 40 ? 10 : 5;
    for (var m = 0; m <= n; m += step) s += '<text x="' + (L + m * cw) + '" y="' + (H - 4) + '">' + m + ' min</text>';
    s += '<rect data-ixa-cursor x="0" y="' + top + '" width="2" height="' + (ROWS.length * (RH + 4) + 14) + '" fill="var(--ink)" opacity="0"/>';
    return s + '</svg>';
  }
  function heatAt(svg, e) {
    var d = P.d, n = (d.heat || []).length || 1, r = svg.getBoundingClientRect();
    var x = (e.clientX - r.left) * (1100 / r.width);
    var m = Math.floor((x - 104) / ((1100 - 104 - 8) / n));
    return m >= 0 && m < n ? m : null;
  }

  function transcriptHtml(lines) {
    var prev = null;
    return lines.map(function (l) {
      var who = l.speaker && l.speaker !== prev ? '<b>' + esc(l.speaker) + '</b>' : ''; prev = l.speaker;
      return '<button type="button" data-s="' + l.start_ms + '" data-ixa-seek="' + l.start_ms + '"><time>' + esc(stamp(l.start_ms)) + '</time>' + who + esc(l.text) + '</button>';
    }).join('');
  }

  function clipsHtml(clips) {
    if (!clips || !clips.length) return '<p class="muted" style="font-size:13px">No clips yet. Suggest clips picks 3 to 6 strong moments from the debrief.</p>';
    return '<div class="ixa-clips">' + clips.map(clipRow).join('') + '</div>';
  }
  function clipRow(c) {
    return '<div class="ixa-clip" data-clip="' + esc(c.id) + '"><div style="display:grid;gap:6px"><div class="ixa-meta">' + esc(stamp(c.start_ms)) + ' to ' + esc(stamp(c.end_ms)) + ' · ' + Math.round((c.end_ms - c.start_ms) / 1000) + ' s' + (c.room_title ? ' · ' + esc(c.room_title) : '') + ' · ' + esc(c.status) + '</div>' +
      '<input data-f="title" value="' + esc(c.title) + '" aria-label="Clip title"><textarea data-f="caption" aria-label="Caption for the post">' + esc(c.caption) + '</textarea>' +
      (c.reason ? '<div class="ixa-meta">Why: ' + esc(c.reason) + '</div>' : '') + '<div class="ixa-prog" hidden><i></i></div></div>' +
      '<div class="ixa-act"><button class="btn-sm ghost" data-cl="play">Preview</button><select class="input" data-cl-shape aria-label="Shape" style="font-size:12px;padding:3px 6px"><option value="land">16:9</option><option value="square">1:1</option><option value="vert">9:16</option></select>' +
      '<button class="btn-sm" data-cl="export">Export video</button><button class="btn-sm ghost" data-cl="save">Save</button><button class="btn-sm ghost" data-cl="approve">' + (c.status === 'approved' ? 'Approved' : 'Approve') + '</button></div></div>';
  }

  function wirePanel() {
    var el = P.el, d = P.d;
    var q = function (s) { return el.querySelector(s); };
    var tr = q('[data-ixa-tr]');
    if (tr) tr.onclick = function () { runTranscribe(tr, Boolean(d.job && ['done', 'no_ai', 'failed', 'unsupported'].indexOf(d.job.status) >= 0)); };
    q('[data-ixa-deb]').onclick = function () {
      var b = this; b.disabled = true; b.textContent = d.ai.claude ? 'Claude is writing it (up to a minute)…' : 'Writing…';
      req('POST', 'rooms/' + P.id + '/debrief', {}).then(function (r) { if (r && r.ok) { toast(r.note ? 'Debrief written. ' + r.note : 'Debrief written'); load(); } else { b.disabled = false; b.textContent = 'Try again'; toast((r && r.error) || 'Not written'); } });
    };
    var post = q('[data-ixa-post]'); if (post) post.onclick = function () { post.disabled = true; req('POST', 'rooms/' + P.id + '/post', {}).then(function (r) { toast(r.ok ? 'Posted to Command → Documents' : r.error); load(); }); };
    var ed = q('[data-ixa-ed]'); if (ed) ed.onclick = function () {
      if (!confirm('Use this recording for the automated webinar’s showings? Every showing plays it in sync, labelled “Recorded session” with the date it was recorded, with its chapters and the application and Sprint cards at their live moments. The chat stays each showing’s own.')) return;
      ed.disabled = true; req('POST', 'rooms/' + P.id + '/edition', {}).then(function (r) { toast(r.ok ? 'Showings now play this recording (' + r.edition.durationMin + ' minutes; the Sprint unlocks at minute ' + r.edition.pitchAtMin + ').' : r.error); load(); });
    };
    var cl = q('[data-ixa-clips]'); if (cl) cl.onclick = function () { cl.disabled = true; cl.textContent = 'Picking…'; req('POST', 'rooms/' + P.id + '/clips', {}).then(function (r) { toast(r.ok ? r.clips.length + ' clips suggested' : r.error); load(); }); };
    el.querySelectorAll('[data-ixa-seek]').forEach(function (b) { b.onclick = function () { seekTo(Number(b.getAttribute('data-ixa-seek'))); }; });
    if (P.video) P.video.addEventListener('timeupdate', function () { followLine(P.video.currentTime * 1000, false); cursor(P.video.currentTime * 1000); });
    // The heatmap: a tooltip per minute, click to jump.
    var svg = q('[data-ixa-heat]');
    if (svg) {
      var tip = document.createElement('div'); tip.className = 'ixa-tip'; tip.hidden = true; document.body.appendChild(tip);
      svg.addEventListener('mousemove', function (e) {
        var m = heatAt(svg, e); if (m === null) { tip.hidden = true; return; }
        var r = d.heat[m], said = (d.lines || []).filter(function (l) { return l.start_ms >= m * 60000 && l.start_ms < (m + 1) * 60000; }).map(function (l) { return l.text; }).join(' ');
        var pl = function (n, one, many) { return n + ' ' + (n === 1 ? one : many); };
        tip.innerHTML = '<strong>' + m + ':00 to ' + (m + 1) + ':00</strong><br>' + (r.retention != null ? r.retention + ' in the room · ' : '') + pl(r.chat, 'chat message', 'chat messages') + ' · ' + pl(r.questions, 'question', 'questions') + ' · ' + pl(r.reactions, 'reaction', 'reactions') + (r.pushes ? ' · ' + pl(r.pushes, 'push', 'pushes') : '') + (r.opened ? ' · ' + pl(r.opened, 'card opened', 'cards opened') : '') + (r.applications ? ' · ' + r.applications + ' applied' : '') + (r.purchases ? ' · ' + r.purchases + ' bought' : '') + (said ? '<br><span style="opacity:.8">' + esc(said.slice(0, 180)) + (said.length > 180 ? '…' : '') + '</span>' : '');
        tip.hidden = false; tip.style.left = Math.min(window.innerWidth - 340, e.clientX + 12) + 'px'; tip.style.top = (e.clientY + 14) + 'px';
      });
      svg.addEventListener('mouseleave', function () { tip.hidden = true; });
      svg.addEventListener('click', function (e) { var m = heatAt(svg, e); if (m !== null) seekTo(m * 60000); });
      var obs = new MutationObserver(function () { if (!document.body.contains(svg)) { tip.remove(); obs.disconnect(); } }); obs.observe(document.body, { childList: true, subtree: true });
    }
    wireClips(el.querySelector('[data-ixa-cliplist]'), d.clips, function (ms) { seekTo(ms); if (P.video) P.video.play().catch(function () {}); });
    if (d.job && (d.job.status === 'queued' || d.job.status === 'running') && !P.auto) { P.auto = true; runTranscribe(tr, false, true); }
  }
  function cursor(ms) {
    var c = P && P.el.querySelector('[data-ixa-cursor]'); if (!c) return;
    var n = (P.d.heat || []).length || 1;
    c.setAttribute('x', String(104 + (ms / 60000) * ((1100 - 104 - 8) / n))); c.setAttribute('opacity', '0.6');
  }
  /** Keeps transcribing while the panel is open: each call runs ~20 s on the server and saves its progress. */
  function runTranscribe(btn, restart, quiet) {
    if (!P) return;
    var id = P.id;
    if (btn) { btn.disabled = true; btn.textContent = 'Transcribing…'; }
    req('POST', 'rooms/' + id + '/transcribe', { restart: Boolean(restart) }).then(function (r) {
      if (!P || P.id !== id) return;
      if (!r.ok) { toast(r.error); if (btn) btn.disabled = false; return; }
      var st = P.el.querySelector('[data-ixa-status]');
      P.d.job = r.job; if (st) st.textContent = jobLine(P.d);
      if (r.job && (r.job.status === 'queued' || r.job.status === 'running')) setTimeout(function () { runTranscribe(btn, false, true); }, 500);
      else { P.auto = false; if (!quiet || r.job.status === 'done') toast('Transcript: ' + (JOB[r.job.status] || r.job.status)); load(); }
    }).catch(function () { if (btn) btn.disabled = false; });
  }

  // ───────────── clips: edit, approve, export (in this browser) ─────────────
  function wireClips(box, clips, play) {
    if (!box) return;
    box.querySelectorAll('[data-clip]').forEach(function (row) {
      var c = clips.filter(function (x) { return x.id === row.getAttribute('data-clip'); })[0]; if (!c) return;
      var val = function (f) { return row.querySelector('[data-f="' + f + '"]').value; };
      row.querySelector('[data-cl="play"]').onclick = function () { if (play) play(c.start_ms); else window.open(c.src + '#t=' + (c.start_ms / 1000) + ',' + (c.end_ms / 1000), '_blank', 'noopener'); };
      row.querySelector('[data-cl="save"]').onclick = function () { req('POST', 'clips/' + c.id, { title: val('title'), caption: val('caption') }).then(function (r) { notify(r.ok ? 'Clip saved' : r.error); }); };
      row.querySelector('[data-cl="approve"]').onclick = function () { req('POST', 'clips/' + c.id, { title: val('title'), caption: val('caption'), status: 'approved' }).then(function (r) { notify(r.ok ? 'Approved' : r.error); if (r.ok) this.textContent = 'Approved'; }.bind(this)); };
      row.querySelector('[data-cl="export"]').onclick = function () {
        var b = this, prog = row.querySelector('.ixa-prog'), bar = prog.querySelector('i');
        b.disabled = true; b.textContent = 'Recording the clip…'; prog.hidden = false;
        var go = function (cues) {
          exportClip({ src: c.src || ('/rooms/replay/' + c.rec_id), start: c.start_ms, end: c.end_ms, title: val('title'), cues: cues, shape: row.querySelector('[data-cl-shape]').value }, function (p) { bar.style.width = Math.round(p * 100) + '%'; })
            .then(function (file) {
              var a = document.createElement('a'); a.href = URL.createObjectURL(file.blob); a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
              b.disabled = false; b.textContent = 'Export video'; prog.hidden = true; notify('Exported ' + file.name);
            }, function (e) { b.disabled = false; b.textContent = 'Export video'; prog.hidden = true; notify('Export failed: ' + (e && e.message || e)); });
        };
        if (c.cues) go(c.cues); else req('GET', 'clips').then(function (r) { var x = (r.clips || []).filter(function (y) { return y.id === c.id; })[0]; go(x ? x.cues : []); });
      };
    });
  }
  var notifyFn = null;
  function notify(t) { if (notifyFn) notifyFn(t); else toast(t); }

  /**
   * Plays the clip's stretch of the recording into a canvas (cropped to the shape, caption burned in at the
   * bottom) and records it with MediaRecorder, with the recording's own audio. MP4 when this browser can record
   * it (Chrome 126+, Safari), else WebM. Runs in real time: a 45-second clip takes 45 seconds.
   */
  function exportClip(o, progress) {
    return new Promise(function (resolve, reject) {
      if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) { reject(new Error('this browser can’t record video')); return; }
      var dims = o.shape === 'square' ? [1080, 1080] : o.shape === 'vert' ? [1080, 1920] : [1280, 720];
      var cv = document.createElement('canvas'); cv.width = dims[0]; cv.height = dims[1];
      var g = cv.getContext('2d');
      var v = document.createElement('video'); v.src = o.src; v.preload = 'auto'; v.playsInline = true; v.crossOrigin = 'use-credentials';
      var ac = new (window.AudioContext || window.webkitAudioContext)();
      var dest = ac.createMediaStreamDestination();
      var stream = cv.captureStream(30);
      var types = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
      var mime = types.filter(function (t) { return MediaRecorder.isTypeSupported(t); })[0] || '';
      var chunks = [], rec = null, raf = 0, done = false;
      function wrap(text, max) {
        var words = text.split(/\s+/), out = [], line = '';
        words.forEach(function (w) { var t = line ? line + ' ' + w : w; if (g.measureText(t).width > max && line) { out.push(line); line = w; } else line = t; });
        if (line) out.push(line); return out.slice(-3);
      }
      function frame() {
        if (done) return;
        var vw = v.videoWidth || 16, vh = v.videoHeight || 9, s = Math.max(cv.width / vw, cv.height / vh), w = vw * s, h = vh * s;
        g.fillStyle = '#000'; g.fillRect(0, 0, cv.width, cv.height);
        g.drawImage(v, (cv.width - w) / 2, (cv.height - h) / 2, w, h);
        var t = v.currentTime * 1000 - o.start;
        var cue = (o.cues || []).filter(function (x) { return x.from <= t && t < x.to; })[0];
        if (cue) {
          var fs = Math.round(cv.width / 26); g.font = '600 ' + fs + 'px -apple-system, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'bottom';
          var ls = wrap(cue.text, cv.width * 0.86), lh = fs * 1.3, y0 = cv.height - (o.shape === 'vert' ? cv.height * 0.22 : fs * 1.6);
          g.fillStyle = 'rgba(0,0,0,.62)'; g.fillRect(cv.width * 0.05, y0 - ls.length * lh - fs * 0.4, cv.width * 0.9, ls.length * lh + fs * 0.8);
          g.fillStyle = '#fff'; ls.forEach(function (l, i) { g.fillText(l, cv.width / 2, y0 - (ls.length - 1 - i) * lh); });
        }
        progress(Math.min(1, Math.max(0, t / (o.end - o.start))));
        if (v.currentTime * 1000 >= o.end || v.ended) { finish(); return; }
        raf = requestAnimationFrame(frame);
      }
      function finish() {
        if (done) return; done = true; cancelAnimationFrame(raf); v.pause();
        if (rec && rec.state !== 'inactive') rec.stop();
      }
      v.onerror = function () { reject(new Error('couldn’t load the recording')); };
      v.onloadedmetadata = function () { v.currentTime = o.start / 1000; };
      v.onseeked = function () {
        if (rec) return;
        try {
          var src = ac.createMediaElementSource(v); src.connect(dest);
          dest.stream.getAudioTracks().forEach(function (t) { stream.addTrack(t); });
        } catch (e) { /* no audio track: video only */ }
        rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 5000000 } : {});
        rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
        rec.onstop = function () {
          try { ac.close(); } catch (e) { /* closed */ }
          var type = (rec.mimeType || mime || 'video/webm').split(';')[0];
          var name = (o.title || 'clip').replace(/[^\w -]/g, '').trim().slice(0, 60).replace(/\s+/g, '-').toLowerCase() + (type.indexOf('mp4') >= 0 ? '.mp4' : '.webm');
          resolve({ blob: new Blob(chunks, { type: type }), name: name });
        };
        rec.start(1000);
        ac.resume().then(function () { return v.play(); }).then(function () { raf = requestAnimationFrame(frame); }, function (e) { reject(e); });
      };
    });
  }

  // ───────────── Content → highlight clips (every room) ─────────────
  function content(ctx) {
    css();
    var view = ctx.view;
    var old = view.querySelector('[data-ixa-content]'); if (old) old.remove();
    var card = document.createElement('div');
    card.className = 'card'; card.style.marginTop = '14px'; card.setAttribute('data-ixa-content', '');
    card.innerHTML = '<div class="card-head"><div><h2>Highlight clips from live sessions</h2><p class="sub">3 to 6 strong moments per session, picked from its debrief (applications, purchases, the busiest chat). Edit the title and caption, then export the video here: it records in this browser from the session’s recording, captions burned in.</p></div></div><div data-ixa-cliplist><p class="muted">Loading…</p></div>';
    view.appendChild(card);
    notifyFn = ctx.toast || null;
    req('GET', 'clips').then(function (r) {
      var box = card.querySelector('[data-ixa-cliplist]');
      var clips = (r && r.clips) || [];
      box.innerHTML = clips.length ? clipsHtml(clips) : '<p class="muted">No clips yet. Open Rooms → a webinar → Debrief → Suggest clips.</p>';
      wireClips(box, clips, null);
    });
  }

  root.IntelBoard = { button: button, wire: wire, open: open, content: content, exportClip: exportClip };
})(window);
