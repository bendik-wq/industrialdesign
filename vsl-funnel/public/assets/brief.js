'use strict';
(function () {
  var msg = document.querySelector('[data-msg]'), doc = document.querySelector('[data-doc]');
  // "Copy into Google Docs": copy the designed page as rich HTML, then walk the user through pasting it.
  var ov = document.querySelector('[data-ov]'), q = function (k) { return ov.querySelector('[data-' + k + ']'); };
  function legacyCopy() {
    var ok = false, r = document.createRange(), sel = getSelection();
    r.selectNodeContents(doc); sel.removeAllRanges(); sel.addRange(r);
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    sel.removeAllRanges();
    return ok;
  }
  function show(ok) {
    q('ovh').textContent = ok ? 'Copied ✓' : 'One more click';
    q('ovs').textContent = ok ? 'The whole document, with its design, is on your clipboard. A new Google Doc opens empty until you paste it in.'
      : 'Your browser blocked copying. Download the file instead, or press ⌘A then ⌘C on this page and paste into a blank Google Doc.';
    q('s1').className = ok ? 'step done' : 'step';
    ov.classList.add('on');
    q('ovgo').focus();
  }
  document.querySelector('[data-gdoc]').onclick = function () {
    var html = '<meta charset="utf-8">' + doc.innerHTML, text = doc.innerText;
    if (navigator.clipboard && window.ClipboardItem) {
      navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' })
      })]).then(function () { show(true); }, function () { show(legacyCopy()); });
    } else show(legacyCopy());
  };
  q('ovgo').onclick = function () { msg.textContent = 'In the new Google Doc, press ⌘V (Mac) or Ctrl+V (Windows) to paste the document.'; };
  q('ovx').onclick = function () { ov.classList.remove('on'); };
  ov.onclick = function (ev) { if (ev.target === ov) ov.classList.remove('on'); };
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') ov.classList.remove('on'); });
  q('dl').onclick = function () {
    var name = (document.title || 'document').replace(/[^\w\s.-]+/g, '').trim().slice(0, 80) || 'document';
    var file = '<!doctype html><html><head><meta charset="utf-8"><title>' + name + '</title></head><body>' + doc.innerHTML + '</body></html>';
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([file], { type: 'text/html' }));
    a.download = name + '.html';
    document.body.appendChild(a); a.click(); a.remove();
    q('ovs').textContent = 'Downloaded. In Google Drive choose New → File upload, then right-click the file → Open with → Google Docs.';
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
