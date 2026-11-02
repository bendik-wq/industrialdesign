/* Simulive showings (area D): when the masterclass plays a recorded live session, the room says so plainly
   ("Recorded session", with the date it was recorded) and shows the cards Josh shared live at the same second of
   the recording. Everyone in a showing is at the same point (webinar.js plays in sync with the showing's clock and
   nobody seeks), so a card appears for everyone at once. The chat stays the showing's own real chat. */
(function () {
  'use strict';
  var cfg = (window.FUNNEL && window.FUNNEL.webinar) || {};
  var S = cfg.simulive;
  if (!S || !document.querySelector('[data-room]')) return;
  var C = S.copy || {};
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]; }); };
  var pos = function () { return window.WEBINAR_POS ? window.WEBINAR_POS() : 0; };

  // The honest label, under the title.
  var head = document.querySelector('.rm-head');
  if (head && S.note) {
    var p = document.createElement('p');
    p.className = 'muted small ix-simnote'; p.setAttribute('data-simulive-note', '');
    p.textContent = S.note;
    head.appendChild(p);
  }

  // The cards, at their moments (each once, kept after it appears).
  var box = document.createElement('div');
  box.className = 'ix-simcards'; box.setAttribute('aria-live', 'polite'); box.setAttribute('data-simulive-cards', '');
  var anchor = document.querySelector('[data-now]');
  if (anchor) anchor.parentNode.insertBefore(box, anchor); else return;
  var fired = {};
  function card(p) {
    var h = p.kind === 'sprint' ? C.sprintCard : C.applyCard, b = p.kind === 'sprint' ? C.sprintButton : C.applyButton;
    return '<article class="now-card" data-sim="' + p.kind + '" style="padding:16px;margin:12px 0;background:#f5f5f7;border-radius:14px"><p class="muted small" style="margin:0 0 4px">' + esc(C.cardNote) + '</p><h3 style="margin:0 0 10px;font-size:17px">' + esc(h) + '</h3>' +
      '<button type="button" class="btn' + (p.kind === 'sprint' ? ' btn-gold' : '') + '" data-sim-go="' + p.kind + '">' + esc(b) + '</button></article>';
  }
  function tick() {
    var t = pos();
    (S.pushes || []).forEach(function (p) {
      var k = p.kind + p.at;
      if (fired[k] || p.at > t) return;
      fired[k] = true;
      // One card per kind: a later push of the same kind replaces the earlier card.
      var old = box.querySelector('[data-sim="' + p.kind + '"]'); if (old) old.remove();
      box.insertAdjacentHTML('beforeend', card(p));
    });
  }
  box.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-sim-go]'); if (!b) return;
    if (b.getAttribute('data-sim-go') === 'sprint') {
      var sp = document.querySelector('[data-sprint-to]') || document.querySelector('[data-cta]:not([hidden])') || document.querySelector('[data-pass]');
      if (sp) sp.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (cfg.applyUrl) window.open(cfg.applyUrl, '_blank', 'noopener');
  });
  setInterval(tick, 1000);
  tick();
})();
