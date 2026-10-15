(function () {
  'use strict';
  var printBtn = document.querySelector('[data-print]');
  if (printBtn) printBtn.onclick = function () { window.print(); };

  var form = document.querySelector('[data-sign-form]');
  if (!form) return;
  var mode = 'typed';
  var nameInput = form.querySelector('[name=name]');
  var preview = form.querySelector('[data-typed-preview]');
  var typedBox = form.querySelector('[data-typed]');
  var drawBox = form.querySelector('[data-drawn]');
  var canvas = drawBox.querySelector('canvas');
  var ctx = canvas.getContext('2d');
  var err = form.querySelector('[data-err]');
  var drawn = false;

  nameInput.addEventListener('input', function () { preview.textContent = nameInput.value.trim() || 'Your name'; });

  form.querySelectorAll('[data-mode]').forEach(function (b) {
    b.onclick = function () {
      mode = b.getAttribute('data-mode');
      form.querySelectorAll('[data-mode]').forEach(function (x) { var on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-selected', on ? 'true' : 'false'); });
      typedBox.hidden = mode !== 'typed';
      drawBox.hidden = mode !== 'drawn';
    };
  });

  // Drawing pad (mouse, touch and pen).
  ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#0f2c5c';
  var down = false;
  function pos(e) { var r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * (canvas.width / r.width), y: (e.clientY - r.top) * (canvas.height / r.height) }; }
  canvas.addEventListener('pointerdown', function (e) { down = true; canvas.setPointerCapture(e.pointerId); var p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); e.preventDefault(); });
  canvas.addEventListener('pointermove', function (e) { if (!down) return; var p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); drawn = true; e.preventDefault(); });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (t) { canvas.addEventListener(t, function () { down = false; }); });
  drawBox.querySelector('[data-clear]').onclick = function () { ctx.clearRect(0, 0, canvas.width, canvas.height); drawn = false; };

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    err.textContent = '';
    var name = nameInput.value.trim();
    if (name.length < 2) { err.textContent = 'Type your full name.'; nameInput.focus(); return; }
    if (mode === 'drawn' && !drawn) { err.textContent = 'Draw your signature, or switch to typing it.'; return; }
    if (!form.querySelector('[name=consent]').checked) { err.textContent = 'Tick the box to agree to sign electronically.'; return; }
    var btn = form.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Signing…';
    fetch(location.pathname, {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: name, title: form.querySelector('[name=title]').value, kind: mode, signature: mode === 'drawn' ? canvas.toDataURL('image/png') : null, consent: true, hash: form.getAttribute('data-hash') }),
    }).then(function (r) { return r.json(); }).then(function (res) {
      if (res.ok) { location.href = location.pathname + '/copy'; return; }
      err.textContent = res.error || 'Something went wrong. Try again.';
      btn.disabled = false; btn.textContent = 'Sign the agreement';
    }, function () {
      err.textContent = 'Couldn’t reach the server. Check your connection and try again.';
      btn.disabled = false; btn.textContent = 'Sign the agreement';
    });
  });
})();
