(function () {
  'use strict';
  var printBtn = document.querySelector('[data-print]');
  if (printBtn) printBtn.onclick = function () { window.print(); };

  var holder = document.querySelector('[data-sign]');
  if (!holder) return;
  var field = document.querySelector('[data-sig-field]');
  var modal = document.querySelector('[data-modal]');
  var go = document.querySelector('[data-go]');
  var prog = document.querySelector('[data-prog]');
  var nameInput = modal.querySelector('[name=name]');
  var titleInput = modal.querySelector('[name=title]');
  var preview = modal.querySelector('[data-typed-preview]');
  var typedBox = modal.querySelector('[data-typed]');
  var drawBox = modal.querySelector('[data-drawn]');
  var canvas = drawBox.querySelector('canvas');
  var ctx = canvas.getContext('2d');
  var err = modal.querySelector('[data-err]');
  var mode = 'typed', drawn = false, adopted = null, sending = false;

  function scrollToField() { field.scrollIntoView({ behavior: 'smooth', block: 'center' }); field.classList.add('pulse'); setTimeout(function () { field.classList.remove('pulse'); }, 1600); }
  function open() { modal.hidden = false; document.body.classList.add('sb-lock'); setTimeout(function () { (nameInput.value ? modal.querySelector('[name=consent]') : nameInput).focus(); }, 50); }
  function close() { modal.hidden = true; document.body.classList.remove('sb-lock'); }

  go.onclick = function () { if (adopted) finish(); else { scrollToField(); setTimeout(open, 450); } };
  field.onclick = open;
  modal.querySelector('[data-close]').onclick = close;
  modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !modal.hidden) close(); });

  nameInput.addEventListener('input', function () { preview.textContent = nameInput.value.trim() || 'Your name'; });
  modal.querySelectorAll('[data-mode]').forEach(function (b) {
    b.onclick = function () {
      mode = b.getAttribute('data-mode');
      modal.querySelectorAll('[data-mode]').forEach(function (x) { var on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-selected', on ? 'true' : 'false'); });
      typedBox.hidden = mode !== 'typed';
      drawBox.hidden = mode !== 'drawn';
    };
  });

  // Drawing pad (mouse, touch and pen).
  ctx.lineWidth = 2.6; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#0f2c5c';
  var down = false;
  function pos(e) { var r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * (canvas.width / r.width), y: (e.clientY - r.top) * (canvas.height / r.height) }; }
  canvas.addEventListener('pointerdown', function (e) { down = true; canvas.setPointerCapture(e.pointerId); var p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); e.preventDefault(); });
  canvas.addEventListener('pointermove', function (e) { if (!down) return; var p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); drawn = true; e.preventDefault(); });
  ['pointerup', 'pointercancel'].forEach(function (t) { canvas.addEventListener(t, function () { down = false; }); });
  drawBox.querySelector('[data-clear]').onclick = function () { ctx.clearRect(0, 0, canvas.width, canvas.height); drawn = false; };

  // Adopt: the signature drops into the document; the button becomes "Finish".
  modal.querySelector('[data-adopt]').onclick = function () {
    err.textContent = '';
    var name = nameInput.value.trim();
    if (name.length < 2) { err.textContent = 'Type your full name.'; nameInput.focus(); return; }
    if (mode === 'drawn' && !drawn) { err.textContent = 'Draw your signature, or switch to typing it.'; return; }
    if (!modal.querySelector('[name=consent]').checked) { err.textContent = 'Tick the box to agree.'; return; }
    adopted = { name: name, title: titleInput.value.trim(), kind: mode, signature: mode === 'drawn' ? canvas.toDataURL('image/png') : null, consent: true, hash: holder.getAttribute('data-hash') };
    field.classList.add('filled');
    field.innerHTML = mode === 'drawn' ? '<img class="sig-img" alt="Your signature" src="' + adopted.signature + '">' : '<span class="sig">' + name.replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }) + '</span>';
    var who = document.querySelector('[data-sig-who]'); if (who) who.textContent = [name, adopted.title].filter(Boolean).join(', ');
    var date = document.querySelector('[data-sig-date]'); if (date) date.textContent = 'Signed ' + new Date().toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
    close();
    prog.textContent = 'All fields complete';
    go.textContent = 'Finish';
    go.classList.add('ready');
    go.focus();
  };

  function finish() {
    if (sending) return;
    sending = true;
    go.disabled = true; go.textContent = 'Signing…';
    fetch(location.pathname, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(adopted) })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res.ok) { sending = false; go.disabled = false; go.textContent = 'Finish'; alert(res.error || 'Something went wrong. Try again.'); return; }
        var tpl = document.querySelector('[data-done-tpl]');
        var main = document.querySelector('.sign-wrap');
        var bar = document.querySelector('.sb-bar'); if (bar) bar.remove();
        main.innerHTML = '';
        main.appendChild(tpl.content.cloneNode(true));
        window.scrollTo({ top: 0, behavior: 'smooth' });
        // Like PandaDoc's "redirect after signing": straight on to payment, unless they choose to stay.
        var payA = main.querySelector('[data-pay-link]');
        if (payA) {
          var n = 5, countEl = main.querySelector('[data-count]');
          var t = setInterval(function () { n--; if (countEl) countEl.textContent = String(n); if (n <= 0) { clearInterval(t); location.href = payA.href; } }, 1000);
          var stay = main.querySelector('[data-stay]');
          if (stay) stay.onclick = function () { clearInterval(t); var r = main.querySelector('[data-redirect]'); if (r) r.textContent = 'No rush: the payment link is also in your email.'; };
        }
      }, function () { sending = false; go.disabled = false; go.textContent = 'Finish'; alert('Couldn’t reach the server. Check your connection and try again.'); });
  }
})();
