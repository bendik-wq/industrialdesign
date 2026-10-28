/* The watch experience: what happens on the page while the masterclass plays, all automatic.
   - Deal builder: "your deal, building as you watch", one step per chapter, from the viewer's own answers.
   - Acquisition readiness score from their own answers, with the criteria shown.
   - Key points that slide in, each with "Save to my notes" (kept on the server, notes page + email).
   - Late-join catch-up, tab-away title and recap, quiet reactions, and the buy-in question.
   Honest by design: it's a recording. Counts from other viewers are real and only shown above a minimum
   (the server never sends smaller ones), every number in the builder is the viewer's own or labelled illustrative. */
(function () {
  'use strict';
  var cfg = (window.FUNNEL && window.FUNNEL.webinar) || {};
  var X = cfg.experience;
  var panel = document.querySelector('[data-wx-panel]'), under = document.querySelector('[data-wx-under]'), grid = document.querySelector('[data-wx-grid]');
  if (!cfg.token || !X || !panel || !under || !grid) return;
  var C = X.copy || {};
  var F = window.funnel || { track: function () {} };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]; }); };
  var fill = function (t, o) { return String(t || '').replace(/\{(\w+)\}/g, function (_, k) { return o[k] == null ? '' : o[k]; }); };
  var pos = function () { return window.WEBINAR_POS ? window.WEBINAR_POS() : 0; };
  var mmss = function (s) { s = Math.max(0, Math.floor(s)); var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (x < 10 ? '0' : '') + x; };
  var money = function (v) {
    v = Math.round(Number(v) || 0);
    if (v >= 1e6) { var m = v / 1e6; return '$' + (m >= 10 ? m.toFixed(1) : m.toFixed(2)).replace(/\.?0+$/, '') + 'M'; }
    return '$' + v.toLocaleString('en-US');
  };
  var post = function (path, body) {
    body = body || {}; body.token = cfg.token; body.replay = Boolean(cfg.replay); if (body.pos == null) body.pos = Math.round(pos());
    return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) }).then(function (r) { return r.json(); }).catch(function () { return {}; });
  };
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var pitchAt = cfg.pitchAtSec || 2700;
  var duration = cfg.durationSec || 3600;
  var recaps = X.recaps || [];
  var chapterOf = function (sec) { var c = recaps[0] || { at: 0, title: '' }; recaps.forEach(function (r) { if (sec >= r.at * 60) c = r; }); return c; };

  // ── Layout: video, key points and the offer on the left; the panel beside it (desktop) or under it (mobile) ──
  var main = document.querySelector('[data-wx-main]'), ctaEl = document.querySelector('[data-cta]');
  if (main && ctaEl) main.appendChild(ctaEl);
  var rest = document.createElement('div'); rest.className = 'wx-rest';
  ['[data-agenda]', '.room-side'].forEach(function (s) { var el = document.querySelector(s); if (el) rest.appendChild(el); });
  grid.appendChild(rest);
  grid.classList.add('wx-on');
  document.documentElement.classList.add('wx-room');

  // ── State: their answers so far ──
  var inputs = X.inputs || {};
  var calc = X.calc || null; // { profit, price } once they use the calculator
  var notes = {}; (X.notes || []).forEach(function (id) { notes[id] = true; });
  var reacted = {}; (X.reacted || []).forEach(function (k) { reacted[k] = true; });
  var reactions = X.reactions || {};
  var buyin = X.buyin || null;
  var reached = 0; // furthest point seen in this visit (the replay keeps steps open after a seek back)

  // ── Readiness score (the same rules the server uses, shown as they are) ──
  function score() {
    var factors = (X.rules || []).map(function (f) {
      var pts = 0, answered = false;
      if (f.kind === 'map') { var v = inputs[f.input]; answered = v != null && v !== ''; pts = answered ? (f.points[String(v)] || 0) : 0; }
      else { var d = Number(inputs.dscr); answered = inputs.dscr != null && isFinite(d) && d > 0; if (answered) for (var i = 0; i < f.steps.length; i++) if (d >= f.steps[i][0]) { pts = f.steps[i][1]; break; } }
      return { id: f.id, label: f.label, max: f.max, points: Math.max(0, Math.min(f.max, pts)), answered: answered, raise: f.raise, gap: f.gap };
    });
    var total = Math.max(0, Math.min(100, Math.round(factors.reduce(function (a, f) { return a + f.points; }, 0))));
    var gap, numbers = factors.filter(function (f) { return f.id === 'numbers'; })[0];
    if (numbers && numbers.answered && Number(inputs.dscr) < 1.5) gap = X.blockerGap.financing;
    else if (inputs.blocker && X.blockerGap[inputs.blocker]) gap = X.blockerGap[inputs.blocker];
    else { var worst = factors.slice().sort(function (a, b) { return (b.max - b.points) - (a.max - a.points); })[0]; gap = worst && worst.max - worst.points > 0 ? worst.gap : X.blockerGap.structuring; }
    return { score: total, factors: factors, gap: gap, next: X.gapNext[gap] || '' };
  }

  // ── Deal numbers: theirs from the calculator, else the illustrative target for their revenue band ──
  function payment(p, r, y) { return p * r / (1 - Math.pow(1 + r, -y)); }
  function deal() {
    var n = calc && calc.profit > 0 && calc.price > 0 ? calc : X.illustrative;
    var debt = n.price * 0.7, note = n.price * 0.2, roll = n.price * 0.1, service = payment(debt, 0.09, 10) + payment(note, 0.06, 5);
    return { profit: n.profit, price: n.price, debt: debt, note: note, roll: roll, service: service, dscr: n.profit / service, theirs: n === calc };
  }
  var target = function () { var t = inputs.target; return t && C.targetLabels[t] && !/not_sure|none_yet/.test(t) ? t : null; };

  // ── The deal builder ──
  var steps = X.steps || [];
  var tag = '<span class="wx-tag">' + esc(C.illustrative) + '</span>';
  function stepBody(id) {
    var d = deal(), t = target();
    if (id === 'target') {
      return t ? '<p class="wx-val">' + esc(C.targetLabels[t]) + '</p><p class="wx-sub">' + esc(C.targetNote) + '</p>'
        : '<p class="wx-val wx-quiet">' + esc(C.targetLabels.not_sure) + '</p><p class="wx-sub">' + esc(inputs.target ? C.targetNote : C.targetEmpty) + '</p>';
    }
    if (id === 'size') {
      return '<p class="wx-val">' + esc(fill(d.theirs ? C.sizeYours : C.sizeLine, { profit: money(d.profit), price: money(d.price) })) + (d.theirs ? '' : ' ' + tag) + '</p>' +
        '<p class="wx-sub">' + esc(fill(C.sizeGrowth, { revenue: money(d.profit / 0.15) })) + (d.theirs ? '' : ' ' + esc(C.sizeSource)) + '</p>';
    }
    if (id === 'where') {
      var k = t && C.whereByType[t] ? t : 'other';
      return '<p class="wx-val">' + esc(C.whereLine) + '</p><p class="wx-sub">' + esc(C.whereByType[k]) + '</p>';
    }
    if (id === 'test') {
      var ok = d.dscr >= 1.5;
      return '<p class="wx-dscr ' + (ok ? 'ok' : 'no') + '"><b>' + d.dscr.toFixed(2) + 'x</b><span>' + esc(ok ? C.testPass : C.testFail) + '</span></p>' +
        '<p class="wx-sub">' + esc(fill(C.testLine, { profit: money(d.profit), service: money(d.service), dscr: d.dscr.toFixed(2) + 'x' })) + ' ' + tag + '</p>' +
        '<p class="wx-sub">' + esc(d.theirs ? C.testSource : C.testHint) + '</p>';
    }
    if (id === 'stack') {
      var rows = [['debt', 70, d.debt], ['note', 20, d.note], ['roll', 10, d.roll]];
      return '<div class="wx-stackbar" aria-hidden="true">' + rows.map(function (r) { return '<i class="wx-s-' + r[0] + '" style="flex:' + r[1] + '"></i>'; }).join('') + '</div>' +
        '<table class="wx-rows"><tbody>' + rows.map(function (r) { return '<tr><th><i class="wx-dot wx-s-' + r[0] + '"></i>' + esc(C.stackRows[r[0]]) + ' <span>' + r[1] + '%</span></th><td>' + money(r[2]) + '</td></tr>'; }).join('') + '</tbody></table>' +
        '<p class="wx-sub">' + esc(fill(C.stackPayments, { service: money(d.service) })) + ' ' + tag + '</p>';
    }
    if (id === 'group') {
      var lo = d.profit * 3, hi = d.profit * 5, glo = d.profit * 8, ghi = d.profit * 12, w = function (v) { return Math.max(4, Math.round(v / ghi * 100)); };
      return '<div class="wx-range"><p>' + esc(C.groupAlone) + '</p><div class="wx-rbar"><i style="margin-left:' + w(lo) + '%;width:' + (w(hi) - w(lo)) + '%"></i></div><b>' + money(lo) + ' to ' + money(hi) + '</b></div>' +
        '<div class="wx-range wx-range-g"><p>' + esc(C.groupInside) + '</p><div class="wx-rbar"><i style="margin-left:' + w(glo) + '%;width:' + (w(ghi) - w(glo)) + '%"></i></div><b>' + money(glo) + ' to ' + money(ghi) + '</b></div>' +
        '<p class="wx-sub">' + esc(C.groupNote) + '</p>';
    }
    if (id === 'plan') {
      var tl = inputs.timeline && C.planTimeline[inputs.timeline];
      return '<ol class="wx-plan">' + C.planRows.map(function (r) { return '<li><b>' + esc(r.weeks) + '</b><span>' + esc(fill(r.text, { target: t ? C.targetLabels[t].toLowerCase() : C.planTargetFallback })) + '</span></li>'; }).join('') + '</ol>' +
        (tl ? '<p class="wx-sub">' + esc(tl) + '</p>' : '');
    }
    return '';
  }

  var built = false, open = {};
  function buildPanel() {
    panel.innerHTML =
      '<header class="wx-head"><p class="wx-eyebrow">' + esc(C.panelEyebrow) + '</p><h2 class="wx-h">' + esc(C.panelHeading) + '</h2><p class="wx-intro">' + esc(C.panelIntro) + '</p></header>' +
      '<div class="wx-mapped" data-wx-mapped hidden></div>' +
      '<section class="wx-score" data-wx-score></section>' +
      '<ol class="wx-steps">' + steps.map(function (s) { return '<li class="wx-step locked" data-step="' + esc(s.id) + '"><span class="wx-mark" aria-hidden="true"></span><div class="wx-step-in"><p class="wx-step-h"><span class="wx-time">' + mmss(s.at) + '</span>' + esc(s.title) + '</p><div class="wx-step-b"></div></div></li>'; }).join('') + '</ol>' +
      '<section class="wx-notes" data-wx-notes></section>';
    panel.hidden = false;
    built = true;
  }

  // A passed step folds to one line (tap to open it again); the current one is shown in full.
  function stepShort(id) {
    var d = deal(), t = target(), S = C.short || {};
    if (id === 'target') return t ? C.targetLabels[t] : C.targetLabels.not_sure;
    if (id === 'size') return fill(S.size, { profit: money(d.profit), price: money(d.price) });
    if (id === 'test') return fill(d.dscr >= 1.5 ? S.testPass : S.testFail, { dscr: d.dscr.toFixed(2) + 'x' });
    if (id === 'stack') return fill(S.stack, { debt: money(d.debt), note: money(d.note), roll: money(d.roll) });
    if (id === 'group') return fill(S.group, { lo: money(d.profit * 8), hi: money(d.profit * 12) });
    return S[id] || '';
  }
  var expanded = {}, sig = '';
  panel.addEventListener('click', function (e) {
    var b = e.target.closest('[data-wx-fold]');
    if (!b) return;
    var id = b.getAttribute('data-wx-fold');
    expanded[id] = !expanded[id];
    sig = ''; tick();
  });
  function renderSteps(p, animate) {
    var cur = null; steps.forEach(function (s) { if (p >= s.at) cur = s.id; });
    steps.forEach(function (s) {
      var li = panel.querySelector('[data-step="' + s.id + '"]');
      var b = li.querySelector('.wx-step-b');
      var isOpen = p >= s.at;
      if (isOpen) {
        if (!open[s.id] && animate && !reduced) { li.classList.add('wx-just'); setTimeout(function () { li.classList.remove('wx-just'); }, 1600); }
        open[s.id] = true;
        li.classList.remove('locked');
        var full = s.id === cur || expanded[s.id];
        li.classList.toggle('folded', !full);
        b.innerHTML = (full ? stepBody(s.id) : '<p class="wx-short">' + esc(stepShort(s.id)) + '</p>') +
          (s.id === cur ? '' : '<button type="button" class="wx-fold" data-wx-fold="' + esc(s.id) + '" aria-expanded="' + Boolean(full) + '">' + (full ? 'Less' : 'More') + '</button>');
      } else {
        open[s.id] = false;
        li.classList.add('locked');
        b.innerHTML = '<p class="wx-soon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>' + esc(fill(C.unlocksAt, { time: mmss(s.at), what: s.soon })) + '</p>';
      }
    });
    panel.querySelectorAll('.wx-step').forEach(function (li) { li.classList.toggle('current', li.getAttribute('data-step') === cur); });
  }

  // ── "Your deal is mapped" (at the pitch) with their own words played back ──
  var nextUrl = null, nextLabel = null, resolving = false;
  function resolveBlueprint(done) {
    if (nextUrl) return done();
    if (resolving) return;
    resolving = true;
    var urls = (X.blueprintUrls || []).slice();
    var tryNext = function () {
      var u = urls.shift();
      if (!u) { nextUrl = cfg.worksheetUrl; nextLabel = C.mappedButtonWorksheet; return done(); }
      fetch(u, { credentials: 'same-origin', cache: 'no-store' }).then(function (r) {
        if (r.ok && !r.redirected) { nextUrl = u; nextLabel = C.mappedButton; done(); } else tryNext();
      }).catch(tryNext);
    };
    tryNext();
  }
  function renderMapped(p) {
    var box = panel.querySelector('[data-wx-mapped]');
    if (p < pitchAt) { box.hidden = true; return; }
    var draw = function () {
      var wasHidden = box.hidden;
      box.innerHTML = '<p class="wx-mapped-h"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>' + esc(C.mappedHeading) + '</p>' +
        (buyin && buyin.text ? '<p class="wx-playback">' + esc(fill(C.buyinPlayback, { text: buyin.text })) + '</p>' : '<p class="wx-sub">' + esc(C.mappedBody) + '</p>') +
        '<div class="wx-mapped-act"><a class="btn btn-sm" href="' + esc(cfg.qualified === false ? cfg.worksheetUrl : cfg.applyUrl) + '" target="_blank" rel="noopener" data-wx-next>' + esc(cfg.qualified === false ? C.nextWorksheet : C.nextApply) + '</a>' +
        (nextUrl !== cfg.worksheetUrl || cfg.qualified !== false ? '<a class="wx-link" href="' + esc(nextUrl) + '" target="_blank" rel="noopener" data-wx-blueprint>' + esc(nextLabel) + ' →</a>' : '') + '</div>';
      box.hidden = false;
      if (wasHidden && !reduced) { box.classList.add('wx-just'); setTimeout(function () { box.classList.remove('wx-just'); }, 1600); }
      var a = box.querySelector('[data-wx-blueprint]');
      if (a) a.onclick = function () { F.track('cta_click', { id: 'webinar_blueprint', label: nextLabel }); };
      box.querySelector('[data-wx-next]').onclick = function () { post('/api/webinar/cta', {}); F.track('cta_click', { id: 'webinar_mapped_next' }); };
    };
    if (nextUrl) draw(); else resolveBlueprint(draw);
  }

  // ── The readiness meter ──
  var lastScore = null;
  function renderScore(p) {
    var el = panel.querySelector('[data-wx-score]');
    var s = score(), atPitch = p >= pitchAt;
    var openDetails = el.querySelector('details') && el.querySelector('details').open;
    el.innerHTML = '<div class="wx-score-top"><div><p class="wx-eyebrow">' + esc(C.scoreHeading) + '</p><p class="wx-score-n"><b data-wx-n>' + s.score + '</b><span>/100</span></p></div>' +
      '<p class="wx-score-intro">' + esc(C.scoreIntro) + '</p></div>' +
      '<div class="wx-meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + s.score + '" aria-label="' + esc(C.scoreHeading) + '"><i style="width:' + s.score + '%"></i></div>' +
      (atPitch ? '<div class="wx-gap"><p><span>' + esc(C.gapLabel) + '</span><b>' + esc(s.gap.charAt(0).toUpperCase() + s.gap.slice(1)) + '</b></p><p class="wx-sub"><span class="wx-next-l">' + esc(C.nextLabel) + ':</span> ' + esc(s.next) + '</p></div>' : '') +
      '<details class="wx-how"' + (openDetails ? ' open' : '') + '><summary>' + esc(C.scoreHow) + '</summary><ul>' + s.factors.map(function (f) {
        var full = f.points >= f.max;
        return '<li class="' + (full ? 'full' : '') + '"><p><span>' + esc(f.label) + '</span><b>' + f.points + ' / ' + f.max + '</b></p>' + (full ? '' : '<p class="wx-raise">' + esc(f.raise) + '</p>') + '</li>';
      }).join('') + '</ul>' + (X.average ? '<p class="wx-avg">' + esc(fill(C.scoreAverage, { n: X.average.n, avg: X.average.avg })) + '</p>' : '') + '</details>';
    if (lastScore != null && lastScore !== s.score && !reduced) { el.classList.remove('wx-bump'); void el.offsetWidth; el.classList.add('wx-bump'); }
    lastScore = s.score;
  }

  // ── Saved notes ──
  function renderNotes() {
    var el = panel.querySelector('[data-wx-notes]');
    var saved = (X.takeaways || []).filter(function (t) { return notes[t.id]; });
    el.innerHTML = '<p class="wx-eyebrow">' + esc(C.savedHeading) + (saved.length ? ' <span class="wx-count">' + saved.length + '</span>' : '') + '</p>' +
      (saved.length ? '<ol class="wx-notes-mini">' + saved.map(function (t) { return '<li><span>' + mmss(t.at) + '</span>' + esc(t.text) + '</li>'; }).join('') + '</ol><a class="wx-link" href="' + esc(X.notesUrl) + '" target="_blank" rel="noopener">' + esc(C.savedLink) + ' →</a>'
        : '<p class="wx-sub">' + esc(C.savedEmpty) + '</p>');
  }
  function toggleNote(id, btn) {
    var on = !notes[id];
    notes[id] = on;
    if (btn) { btn.classList.toggle('saved', on); btn.setAttribute('aria-pressed', String(on)); btn.querySelector('span').textContent = on ? C.savedButton : C.saveButton; }
    renderNotes();
    post('/api/webinar/note', { id: id, saved: on }).then(function (r) {
      if (r && r.saved) { notes = {}; r.saved.forEach(function (x) { notes[x] = true; }); renderNotes(); }
    });
    if (on) F.track('cta_click', { id: 'webinar_note_saved', label: id });
  }

  // ── Under the video: catch-up / away recap, reactions, key points, the buy-in question ──
  under.innerHTML = '<div data-wx-catch></div><div class="wx-react" data-wx-react></div><div data-wx-moment></div><div data-wx-buyin></div>';
  var catchEl = under.querySelector('[data-wx-catch]'), reactEl = under.querySelector('[data-wx-react]'), momentEl = under.querySelector('[data-wx-moment]'), buyinEl = under.querySelector('[data-wx-buyin]');

  function collapse(card, ms) {
    var t = setTimeout(function () { close(); }, ms);
    function close() {
      clearTimeout(t);
      if (!card.parentNode) return;
      card.style.height = card.offsetHeight + 'px';
      void card.offsetWidth;
      card.classList.add('wx-gone');
      setTimeout(function () { card.remove(); }, reduced ? 0 : 500);
    }
    var x = card.querySelector('[data-wx-close]');
    if (x) x.onclick = close;
    return close;
  }
  function recapCard(heading, lines, ms) {
    catchEl.innerHTML = '';
    var card = document.createElement('div');
    card.className = 'wx-card wx-catch';
    card.setAttribute('role', 'status');
    card.innerHTML = '<div class="wx-catch-top"><p class="wx-catch-h">' + esc(heading) + '</p><button type="button" class="wx-x" data-wx-close aria-label="Close">×</button></div>' +
      '<ul>' + lines.map(function (l) { return '<li><b>' + esc(l.t) + '</b>' + (l.line ? ' <span>' + esc(l.line) + '</span>' : '') + '</li>'; }).join('') + '</ul>' +
      '<i class="wx-timer" style="animation-duration:' + ms + 'ms"></i>';
    catchEl.appendChild(card);
    collapse(card, ms);
  }

  // Late join: a showing in progress, opened after minute 3.
  if (!cfg.replay && cfg.startsAt && cfg.serverNow && cfg.mode !== 'live') {
    var joined = (cfg.serverNow - cfg.startsAt) / 1000;
    if (joined > 180 && joined < duration) {
      var missed = recaps.filter(function (r) { return r.at * 60 < joined; });
      if (missed.length) recapCard(fill(C.catchUpHeading, { time: mmss(joined) }), missed.map(function (r) { return { t: r.title, line: r.line }; }), 20000);
    }
  }

  // Reactions (one of each per chapter; counts are real and only arrive from the server at 10 or more).
  function renderReact(p) {
    var ch = chapterOf(p), key = function (k) { return k + ':' + ch.at; };
    var counts = reactions[ch.at] || {};
    var best = null; ['new', 'do', 'explain'].forEach(function (k) { if (counts[k] && (!best || counts[k] > counts[best])) best = k; });
    var sig = ch.at + '|' + ['new', 'do', 'explain'].map(function (k) { return reacted[key(k)] ? 1 : 0; }).join('') + '|' + (best ? counts[best] : '');
    if (reactEl.getAttribute('data-sig') === sig) return;
    reactEl.setAttribute('data-sig', sig);
    var hadNote = reactEl.querySelector('.wx-react-note');
    reactEl.innerHTML = '<span class="wx-react-l">' + esc(C.reactPrompt) + '</span><div class="wx-react-b">' + ['new', 'do', 'explain'].map(function (k) {
      var done = reacted[key(k)] && k !== 'explain';
      return '<button type="button" class="wx-chip' + (reacted[key(k)] ? ' on' : '') + '" data-wx-r="' + k + '" aria-pressed="' + Boolean(reacted[key(k)]) + '"' + (done ? ' disabled' : '') + '>' + esc(C.reactions[k]) + '</button>';
    }).join('') + '</div>' + (best ? '<p class="wx-react-count">' + esc(fill(C.reactCount[best], { n: counts[best] })) + '</p>' : '');
    if (hadNote) reactEl.appendChild(hadNote);
  }
  reactEl.addEventListener('click', function (e) {
    var b = e.target.closest('[data-wx-r]');
    if (!b || b.disabled) return;
    var kind = b.getAttribute('data-wx-r'), p = pos(), ch = chapterOf(p);
    reacted[kind + ':' + ch.at] = true;
    renderReact(p);
    post('/api/webinar/react', { kind: kind, pos: Math.round(p) }).then(function (r) {
      if (r && r.ok) { reactions[r.chapter] = r.counts || {}; reactEl.removeAttribute('data-sig'); renderReact(pos()); }
    });
    F.track('cta_click', { id: 'webinar_react', label: kind });
    if (kind === 'explain') explain(p, ch);
  });
  // "Explain more": the moment goes to the assistant as a question, answered in the question box.
  function explain(p, ch) {
    var last = null; (X.takeaways || []).forEach(function (t) { if (t.at <= p && p - t.at < 240) last = t; });
    var what = last ? '“' + last.text + '”' : '“' + ch.title + '” (at ' + mmss(p) + ')';
    var q = fill(C.explainQuestion, { what: what });
    var ask = document.querySelector('[data-ask]'), qa = ask && ask.querySelector('[data-qa]');
    var item = null;
    if (qa) {
      item = document.createElement('div'); item.className = 'qa wx-qa-new';
      item.innerHTML = '<p class="qa-q">' + esc(q) + '</p><p class="qa-a muted">Thinking…</p>';
      qa.prepend(item);
    }
    var note = reactEl.querySelector('.wx-react-note');
    if (!note) { note = document.createElement('p'); note.className = 'wx-react-note'; reactEl.appendChild(note); }
    note.innerHTML = esc(C.explainSent) + (ask ? ' <button type="button" class="linkish" data-wx-goask>Show me</button>' : '');
    var go = note.querySelector('[data-wx-goask]');
    if (go) go.onclick = function () { ask.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' }); };
    post('/api/webinar/ask', { question: q, pos: Math.round(p) }).then(function (r) {
      if (!item) return;
      var el = item.querySelector('.qa-a');
      if (r && r.answer) { el.classList.remove('muted'); el.innerHTML = '<span class="qa-tag">AI assistant</span> ' + esc(r.answer); }
      else el.textContent = (r && (r.note || r.error)) || 'Thanks. Josh’s team reads every question and will reply by email.';
    });
  }

  // Key points: one at a time, from its second for 75 seconds.
  var momentId = null, closeMoment = null;
  function renderMoment(p) {
    var cur = null; (X.takeaways || []).forEach(function (t) { if (p >= t.at && p < t.at + 75) cur = t; });
    if ((cur && cur.id) === momentId) return;
    if (closeMoment) { closeMoment(); closeMoment = null; }
    momentId = cur && cur.id;
    if (!cur) return;
    var card = document.createElement('div');
    card.className = 'wx-card wx-moment' + (reduced ? '' : ' wx-in');
    card.innerHTML = '<div class="wx-moment-top"><p class="wx-eyebrow">' + esc(C.takeawayEyebrow) + ' · ' + mmss(cur.at) + '</p></div><p class="wx-moment-t">' + esc(cur.text) + '</p>' +
      '<button type="button" class="wx-save' + (notes[cur.id] ? ' saved' : '') + '" aria-pressed="' + Boolean(notes[cur.id]) + '"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1z"/></svg><span>' + esc(notes[cur.id] ? C.savedButton : C.saveButton) + '</span></button>';
    var id = cur.id;
    card.querySelector('.wx-save').onclick = function (e) { toggleNote(id, e.currentTarget); };
    momentEl.appendChild(card);
    closeMoment = collapse(card, Math.max(1000, (cur.at + 75 - p) * 1000));
  }

  // Buy-in: "what would your first acquisition change for you?" in their own words (sharing is opt-in, unticked).
  var buyinShown = false;
  function wallHtml() {
    var wall = X.wall || [];
    if (!wall.length) return '';
    return '<div class="wx-wall"><p class="wx-eyebrow">' + esc(C.wallHeading) + '</p><ul>' + wall.map(function (w) { return '<li><q>' + esc(w.text) + '</q>' + (w.who ? '<span>' + esc(w.who) + '</span>' : '') + '</li>'; }).join('') + '</ul><p class="wx-sub">' + esc(C.wallNote) + '</p></div>';
  }
  function renderBuyIn(p) {
    if (buyinShown || p < (X.buyinAt || 2300)) return;
    buyinShown = true;
    var card = document.createElement('div');
    card.className = 'wx-card wx-buyin' + (reduced ? '' : ' wx-in');
    if (buyin) { card.innerHTML = '<p class="wx-eyebrow">' + esc(C.buyinEyebrow) + '</p><p class="wx-playback">' + esc(fill(C.buyinPlayback, { text: buyin.text }).replace(/ Here is how to start\.$/, '')) + '</p>' + wallHtml(); if (!X.wall || !X.wall.length) card.hidden = true; buyinEl.appendChild(card); return; }
    var max = X.buyinMax || 280;
    card.innerHTML = '<p class="wx-eyebrow">' + esc(C.buyinEyebrow) + '</p><p class="wx-buyin-q">' + esc(C.buyinHeading) + '</p>' +
      '<div class="wx-prompts">' + (C.buyinPrompts || []).map(function (t) { return '<button type="button" class="wx-chip" data-wx-p>' + esc(t) + '</button>'; }).join('') + '</div>' +
      '<form data-wx-bf><label class="wx-sr" for="wx-buyin-t">' + esc(C.buyinHeading) + '</label><textarea id="wx-buyin-t" rows="2" maxlength="' + max + '" placeholder="' + esc(C.buyinPlaceholder) + '"></textarea>' +
      '<div class="wx-buyin-row"><label class="wx-check"><input type="checkbox" data-wx-share> <span>' + esc(C.buyinShare) + '</span></label><span class="wx-left" data-wx-left>' + max + '</span></div>' +
      '<button type="submit" class="btn btn-sm">' + esc(C.buyinButton) + '</button><p class="form-error" data-wx-err hidden></p></form>' + wallHtml();
    var ta = card.querySelector('textarea'), left = card.querySelector('[data-wx-left]');
    var count = function () { left.textContent = String(max - ta.value.length); };
    card.querySelectorAll('[data-wx-p]').forEach(function (b) {
      b.onclick = function () {
        card.querySelectorAll('[data-wx-p]').forEach(function (x) { x.classList.toggle('on', x === b); });
        if (!ta.value.trim() || (C.buyinPrompts || []).indexOf(ta.value.trim()) >= 0) ta.value = b.textContent;
        ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); count();
      };
    });
    ta.addEventListener('input', count);
    card.querySelector('[data-wx-bf]').addEventListener('submit', function (e) {
      e.preventDefault();
      var text = ta.value.trim(), btn = e.target.querySelector('button[type=submit]'), err = card.querySelector('[data-wx-err]');
      if (text.length < 3) { err.textContent = 'Write a few words first'; err.hidden = false; return; }
      btn.disabled = true;
      post('/api/webinar/buyin', { text: text, share: card.querySelector('[data-wx-share]').checked }).then(function (r) {
        btn.disabled = false;
        if (!r || !r.ok) { err.textContent = (r && r.error) || 'Something went wrong. Try again.'; err.hidden = false; return; }
        buyin = { text: r.text, shared: r.shared };
        F.track('cta_click', { id: 'webinar_buyin', label: r.shared ? 'shared' : 'private' });
        card.innerHTML = '<p class="wx-eyebrow">' + esc(C.buyinEyebrow) + '</p><p class="wx-playback">“' + esc(r.text) + '”</p><p class="wx-sub">' + esc(C.buyinThanks) + '</p>' + wallHtml();
        tick();
      });
    });
    buyinEl.appendChild(card);
  }

  // ── Tab away: the real chapter in the title; a short recap when they come back after a minute ──
  var baseTitle = document.title, awayAt = null, awayPos = 0, titleTimer = null;
  function awayTitle() { var p = pos(); if (p > 0 && p < duration) document.title = mmss(p) + ' · ' + chapterOf(p).title; }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      awayAt = Date.now(); awayPos = pos();
      awayTitle(); titleTimer = setInterval(awayTitle, 1000);
      return;
    }
    clearInterval(titleTimer); document.title = baseTitle;
    if (!awayAt) return;
    var gone = (Date.now() - awayAt) / 1000, now = pos(), from = awayPos;
    awayAt = null;
    if (gone < 60 || now - from < 45) return;
    var lines = recaps.filter(function (r) { return r.at * 60 > from && r.at * 60 <= now; }).map(function (r) { return { t: r.title, line: r.line }; });
    (X.takeaways || []).forEach(function (t) { if (t.at > from && t.at <= now) lines.push({ t: C.takeawayEyebrow + ' · ' + mmss(t.at), line: t.text }); });
    if (!lines.length) lines.push({ t: fill(C.awaySameChapter, { chapter: chapterOf(now).title }), line: '' });
    var mins = Math.max(1, Math.round(gone / 60));
    recapCard(fill(C.awayHeading, { mins: mins + ' min' }), lines.slice(0, 6), 30000);
  });

  // ── Their answers, as they give them ──
  var redraw = null;
  function soon() { clearTimeout(redraw); redraw = setTimeout(tick, 250); }
  document.addEventListener('webinar:poll', function (e) {
    var d = e.detail || {};
    var map = { target_type: 'target', timeline: 'timeline', blocker: 'blocker', own_cash: 'own_cash' };
    if (map[d.poll]) { inputs[map[d.poll]] = d.value; soon(); }
  });
  document.addEventListener('webinar:calc', function (e) {
    var d = e.detail || {};
    if (d.profit > 0 && d.price > 0) { calc = { profit: Number(d.profit), price: Number(d.price) }; inputs.dscr = deal().dscr; soon(); }
  });
  if (calc) inputs.dscr = deal().dscr;

  // ── Tick ──
  var first = true;
  function tick() {
    var p = pos();
    reached = Math.max(reached, p);
    var shown = cfg.replay ? reached : p;
    if (!built) buildPanel();
    // Redraw the panel only when something in it changes (a step unlocks, the pitch, a new answer).
    var s = steps.filter(function (x) { return shown >= x.at; }).length + '|' + (shown >= pitchAt) + '|' + JSON.stringify(inputs) + '|' + JSON.stringify(calc) + '|' + (buyin && buyin.text);
    if (s !== sig) {
      sig = s;
      renderSteps(shown, !first);
      renderMapped(shown);
      renderScore(shown);
    }
    if (first) renderNotes();
    renderReact(p);
    renderMoment(p);
    renderBuyIn(p);
    first = false;
  }
  setInterval(tick, 1000);
  tick();
})();
