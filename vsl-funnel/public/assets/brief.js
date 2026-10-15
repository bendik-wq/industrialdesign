'use strict';
(function () {
  var msg = document.querySelector('[data-msg]'), doc = document.querySelector('[data-doc]');
  // Copy first (synchronously, while this tab has focus), then open the new doc.
  document.querySelector('[data-gdoc]').onclick = function () {
    var ok = false, r = document.createRange(), sel = getSelection();
    r.selectNodeContents(doc); sel.removeAllRanges(); sel.addRange(r);
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    sel.removeAllRanges();
    var w = window.open('https://docs.new', '_blank');
    msg.textContent = ok ? 'Copied. In the new Google Doc press ⌘V (Mac) or Ctrl+V (Windows): the design comes with it.' : 'Your browser blocked copying: press ⌘A then ⌘C here, and paste into the new Google Doc.';
    if (!w) msg.textContent += ' (The new tab was blocked: open docs.new yourself.)';
  };
  document.querySelector('[data-print]').onclick = function () { window.print(); };
  // Build buttons (Miro board, Google Doc): POST, then open what came back in a tab opened on the click.
  document.querySelectorAll('[data-miro],[data-gdrive]').forEach(function (b) {
    b.onclick = function () {
      var url = b.getAttribute('data-miro') || b.getAttribute('data-gdrive'), label = b.getAttribute('data-label');
      var w = window.open('', '_blank');
      if (w) w.document.write('<!doctype html><title>Building…</title><body style="font:16px Arial;display:grid;place-items:center;height:90vh;color:#1F2A44;background:#F4F4EF"><p>Building it… this tab opens it when it is ready.</p></body>');
      b.disabled = true; b.textContent = 'Building…';
      fetch(url, { method: 'POST', credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (r) {
        if (!r.ok) { if (w) w.close(); b.disabled = false; b.textContent = label; msg.textContent = r.error || 'Could not build it.'; return; }
        if (w) w.location = r.url; else location.href = r.url;
        var a = document.createElement('a'); a.className = 'b ghost'; a.href = r.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = b.getAttribute('data-open'); b.replaceWith(a);
      }, function () { if (w) w.close(); b.disabled = false; b.textContent = label; msg.textContent = 'Could not reach the server.'; });
    };
  });
})();
