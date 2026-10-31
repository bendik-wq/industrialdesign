/* Host console (/admin/live/challenge:<cohort>:<day>): the challenge's own live controls in #live-controls.
   Days 4 and 5: the deposit offer switch with the real deadline. Every day: a team message into the cohort
   chat, and the VIP hot seat questions for that day. */
(function () {
  'use strict';
  var box = document.getElementById('live-controls');
  if (!box) return;
  var key = box.getAttribute('data-live-key') || '';
  if (key.indexOf('challenge:') !== 0) return;
  var enc = encodeURIComponent(key);
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function call(method, path, body) {
    return fetch('/admin/api/challenge/' + path, { method: method, credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(function (r) { return r.json(); });
  }
  function left(ms) { var s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h + 'h ' + m + 'm'; }
  var state = null;
  function draw() {
    var d = state; if (!d) return;
    var o = d.offer || {};
    var offer = d.canOffer
      ? '<div class="card"><h2>Deposit offer</h2><p class="muted">' + (o.expired ? 'Closed for good at the cohort deadline.' : o.open ? 'Open now. Closes in ' + left(o.closeAt - Date.now()) + ' (the cohort deadline).' : 'Not open yet. When you open it, everyone on the day page sees the offer within 10 seconds, with a sticky bar and an alert.') + '</p>' +
        (o.expired ? '' : '<button class="btn' + (o.open ? ' ghost' : '') + '" data-ch-offer="' + (o.open ? '0' : '1') + '">' + (o.open ? 'Close the offer' : (d.day === 4 ? 'Open the offer (Day 4 soft offer)' : 'Open the offer')) + '</button>') + '</div>'
      : '';
    var hot = d.hotSeats.length ? d.hotSeats.map(function (h) { return '<li><label><input type="checkbox" data-hot="' + esc(h.id) + '"' + (h.done ? ' checked' : '') + '> <strong>' + esc(h.name) + '</strong>: ' + esc(h.question) + '</label></li>'; }).join('') : '<li class="muted">No questions yet.</li>';
    box.innerHTML = offer +
      '<div class="card"><h2>Message the cohort chat</h2><form data-ch-team class="row" style="gap:8px"><input class="input" name="text" maxlength="400" placeholder="Shown with the Team badge" style="flex:1"><button class="btn" type="submit">Send</button></form></div>' +
      '<div class="card"><h2>VIP hot seat (' + esc(d.vip) + ' VIP in this cohort)</h2><ul class="plain">' + hot + '</ul></div>';
    var b = box.querySelector('[data-ch-offer]');
    if (b) b.onclick = function () {
      var open = b.getAttribute('data-ch-offer') === '1';
      if (open && !confirm('Open the deposit offer now?')) return;
      b.disabled = true;
      call('POST', 'offer/' + enc, { open: open }).then(function (r) { if (!r.ok) alert(r.error || 'Could not change the offer'); load(); });
    };
    var f = box.querySelector('[data-ch-team]');
    f.onsubmit = function (e) { e.preventDefault(); var t = f.text.value.trim(); if (!t) return; call('POST', 'chat/' + enc, { text: t }).then(function () { f.text.value = ''; }); };
    box.querySelectorAll('[data-hot]').forEach(function (c) { c.onchange = function () { call('PATCH', 'hot/' + encodeURIComponent(c.getAttribute('data-hot')), { done: c.checked }); }; });
  }
  function load() { call('GET', 'offer/' + enc).then(function (d) { if (d && d.key) { state = d; if (!box.contains(document.activeElement)) draw(); } }).catch(function () {}); }
  load(); setInterval(load, 10000);
})();
