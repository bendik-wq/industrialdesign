/* Funnel HQ → Rooms → Studio (builder B, src/rooms/studio-routes.ts): each webinar room's production studio.
   Branding (colours, logo), intro music, the default scene and layout, the green room, the words on the intro,
   break, offer and outro scenes, the lower third and ticker defaults, which script the run of show reads, the
   room's uploaded slide decks, and show templates that carry all of it from one event to the next.
   The "Studio" button on each webinar row (admin-rooms.js) opens it. */
(function () {
  'use strict';
  var CSS = '.sts-dlg{position:fixed;inset:0;z-index:210;display:grid;place-items:center;padding:16px;background:rgba(0,0,0,.4)}' +
    '.sts-in{background:var(--surface,#fff);color:var(--ink,#1d1d1f);border-radius:14px;padding:22px;width:min(860px,100%);max-height:calc(100vh - 32px);overflow:auto;display:grid;gap:16px}' +
    '.sts-in h2{margin:0;font-size:20px}.sts-in h3{margin:0 0 6px;font-size:14px}.sts-g{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}' +
    '.sts-in label{display:grid;gap:4px;font-size:13px;color:var(--ink-2,#52514e)}.sts-in input[type=text],.sts-in textarea,.sts-in select{font:inherit;padding:6px 8px;border:1px solid rgba(127,127,127,.35);border-radius:8px;background:transparent;color:inherit}' +
    '.sts-in textarea{min-height:84px}.sts-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.sts-sec{display:grid;gap:10px;padding-top:12px;border-top:1px solid rgba(127,127,127,.25)}' +
    '.sts-prev{aspect-ratio:16/9;border-radius:12px;display:grid;place-items:center;text-align:center;padding:16px;gap:6px;max-width:420px}.sts-prev img{max-height:36px;max-width:160px}.sts-prev strong{font:500 22px/1.2 Newsreader,Georgia,serif}' +
    '.sts-list{list-style:none;margin:0;padding:0;display:grid;gap:4px;font-size:13px}.sts-list li{display:flex;justify-content:space-between;gap:8px;align-items:center;padding:4px 0;border-top:1px solid rgba(127,127,127,.2)}' +
    '.sts-chk{display:flex!important;grid-template-columns:none;align-items:center;gap:8px}.sts-note{font-size:12px;color:var(--muted,#6e6e73);margin:0}';
  var SCENES = [['intro', 'Intro'], ['main', 'Main'], ['slides', 'Slides'], ['brb', 'Break'], ['qa', 'Q&A'], ['offer', 'Offer'], ['outro', 'Outro']];
  var LAYOUTS = [['solo', 'Solo'], ['side', 'Side by side'], ['speaker_screen', 'Speaker and screen'], ['screen', 'Screen only'], ['grid', 'Grid']];
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function req(method, path, body) {
    return fetch('/admin/api/rooms/' + path, { method: method, credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) }).then(function (r) { return r.json(); });
  }
  function toast(t) { var el = document.querySelector('.toast'); if (window.__adminToast) window.__adminToast(t); else if (el) { el.textContent = t; } else { var d = document.createElement('div'); d.className = 'sts-toast'; d.setAttribute('role', 'status'); d.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1d1d1f;color:#fff;padding:8px 14px;border-radius:10px;z-index:300;font-size:14px'; d.textContent = t; document.body.appendChild(d); setTimeout(function () { d.remove(); }, 3000); } }
  function css() { if (!document.getElementById('sts-css')) { var s = document.createElement('style'); s.id = 'sts-css'; s.textContent = CSS; document.head.appendChild(s); } }
  function opts(list, cur) { return list.map(function (x) { return '<option value="' + esc(x[0]) + '"' + (x[0] === cur ? ' selected' : '') + '>' + esc(x[1]) + '</option>'; }).join(''); }

  function open(roomId) {
    css();
    var dlg = document.createElement('div'); dlg.className = 'sts-dlg'; dlg.setAttribute('role', 'dialog'); dlg.setAttribute('aria-modal', 'true'); dlg.setAttribute('aria-label', 'Studio');
    dlg.innerHTML = '<div class="sts-in"><p>Loading…</p></div>';
    document.body.appendChild(dlg);
    var close = function () { dlg.remove(); document.removeEventListener('keydown', onKey); };
    var onKey = function (e) { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    dlg.addEventListener('click', function (e) { if (e.target === dlg) close(); });
    var data = null;
    function load() { return req('GET', roomId + '/studio').then(function (d) { if (!d.ok) { dlg.firstChild.innerHTML = '<p>' + esc(d.error || 'Not found') + '</p>'; return; } data = d; draw(); }); }
    /** Offer pack (round 4, src/rooms/studio-pack.ts): the pitch scenes and the room's offer card. */
    function packSection(p) {
      var pr = data.pack || {}, keys = [['none', 'no price'], ['engagement', 'the engagement fee by size: ' + (pr.engagement || '')], ['deposit', 'the deposit: ' + (pr.deposit || '')], ['sprint', pr.sprint ? 'the Sprint: ' + pr.sprint.label : 'the Sprint (not on sale now, shows nothing)'], ['ticket', pr.ticket ? 'the ticket: ' + pr.ticket : 'the ticket (no ticket price for this room, shows nothing)']];
      var issues = data.packIssues || [];
      return '<h3>Pitch: transition, stack, comparison and the offer card</h3>' +
        '<p class="sts-note">Prices on screen come from settings only. Each stack line picks one real price by its key, or none; a line with a typed money figure or a value claim is left out. Comparison figures always show as illustrative.</p>' +
        '<div class="sts-g"><label>Offer card pushed in this room<select name="packCard">' + opts([['deposit', 'The deposit card'], ['paths', 'Two paths: the deposit and the First Deal Sprint side by side']], p.offerCard || 'deposit') + '</select></label>' +
        '<label>Transition line (Josh on camera, no slides)<input type="text" name="packLine" maxlength="140" value="' + esc(p.bridgeLine || '') + '" placeholder="Blank shows Josh with no words on screen"></label></div>' +
        '<div class="sts-g"><label>Stack heading<input type="text" name="packStackH" maxlength="90" value="' + esc(p.stackHeading || '') + '"></label><label>Comparison heading<input type="text" name="packAnchorH" maxlength="90" value="' + esc(p.anchorHeading || '') + '"></label></div>' +
        '<label>Stack, one part per line: objection | part | price key (' + keys.map(function (k) { return k[0]; }).join(', ') + ')<textarea name="packStack" rows="6">' + esc((p.stack || []).map(function (x) { return [x.objection, x.title, x.price].join(' | '); }).join('\n')) + '</textarea></label>' +
        '<ul class="sts-list">' + keys.map(function (k) { return '<li><span><b>' + esc(k[0]) + '</b></span><span>' + esc(k[1]) + '</span></li>'; }).join('') + '</ul>' +
        '<label>Comparison, one alternative per line: label | illustrative figure | note (our real price is added as the last row)<textarea name="packAnchor" rows="4">' + esc((p.anchor || []).map(function (x) { return [x.label, x.figure, x.note].join(' | '); }).join('\n')) + '</textarea></label>' +
        (issues.length ? '<ul class="sts-list" role="status">' + issues.map(function (i) { return '<li><span>' + esc(i) + '</span></li>'; }).join('') + '</ul>' : '');
    }
    function assetName(id) { var a = (data.assets || []).filter(function (x) { return x.id === id; })[0]; return a ? (a.name || a.kind) : null; }
    function draw() {
      var s = data.settings, box = dlg.firstChild;
      box.innerHTML = '<div class="sts-row" style="justify-content:space-between"><h2>Studio · ' + esc(data.room.title) + '</h2><button class="btn-sm ghost" data-x>Close</button></div>' +
        (data.storage ? '' : '<p class="sts-note">No R2 bucket (RECORDINGS) is connected, so logos, music and slides can’t be stored. Settings still save.</p>') +
        '<form data-f class="sts-sec" style="border-top:0;padding-top:0">' +
        '<div class="sts-g"><label class="sts-chk"><input type="checkbox" name="on"' + (s.on ? ' checked' : '') + '> Studio on for this room</label><label class="sts-chk"><input type="checkbox" name="greenRoom"' + (s.greenRoom ? ' checked' : '') + '> Co-hosts and guests wait in the green room</label></div>' +
        '<div class="sts-g"><label>First scene<select name="scene">' + opts(SCENES, s.scene) + '</select></label><label>Main layout<select name="layout">' + opts(LAYOUTS, s.layout) + '</select></label>' +
        '<label>Run of show script<select name="script"><option value="">Automatic (' + esc(data.script) + ')</option>' + (data.scripts || []).map(function (id) { return '<option value="' + esc(id) + '"' + (s.script === id ? ' selected' : '') + '>' + esc(id) + '</option>'; }).join('') + '</select></label></div>' +
        '<h3>Branding</h3><div class="sts-g"><label>Background<input type="color" name="bg" value="' + esc(s.colors.bg) + '"></label><label>Accent<input type="color" name="accent" value="' + esc(s.colors.accent) + '"></label><label>Text<input type="color" name="text" value="' + esc(s.colors.text) + '"></label>' +
        '<div class="sts-prev" data-prev></div></div>' +
        '<div class="sts-g"><label>Logo (PNG, SVG, WebP or JPEG, up to 2 MB)<input type="file" accept="image/png,image/svg+xml,image/webp,image/jpeg" data-up="logo"' + (data.storage ? '' : ' disabled') + '><span class="sts-note">' + esc(s.logo ? 'Current: ' + (assetName(s.logo) || 'uploaded') : 'None') + '</span>' + (s.logo ? '<button type="button" class="btn-sm ghost" data-clear="logo">Remove logo</button>' : '') + '</label>' +
        '<label>Intro music (MP3, M4A, OGG or WAV, up to 15 MB)<input type="file" accept="audio/*" data-up="music"' + (data.storage ? '' : ' disabled') + '><span class="sts-note">' + esc(s.music ? 'Current: ' + (assetName(s.music) || 'uploaded') : 'None. Use music you hold the rights to.') + '</span>' + (s.music ? '<button type="button" class="btn-sm ghost" data-clear="music">Remove music</button>' : '') + '</label>' +
        '<label class="sts-chk"><input type="checkbox" name="musicOn"' + (s.musicOn ? ' checked' : '') + '> Play the music on the intro scene</label></div>' +
        '<h3>Words on the scenes</h3><p class="sts-note">Blank uses the room’s defaults. Every line here shows on screen and in the recording, so keep it true: no invented numbers, deadlines or claims.</p>' +
        '<div class="sts-g"><label>Intro title<input type="text" name="introTitle" maxlength="120" value="' + esc(s.introTitle) + '" placeholder="The room title"></label><label>Intro note<input type="text" name="introNote" maxlength="200" value="' + esc(s.introNote) + '"></label>' +
        '<label>Break heading<input type="text" name="brbText" maxlength="120" value="' + esc(s.brbText) + '" placeholder="Short break"></label><label>Outro heading<input type="text" name="outroTitle" maxlength="120" value="' + esc(s.outroTitle) + '" placeholder="Thank you for being here"></label>' +
        '<label>Outro note<input type="text" name="outroNote" maxlength="240" value="' + esc(s.outroNote) + '"></label></div>' +
        '<div class="sts-g"><label>Lower third name<input type="text" name="lowerName" maxlength="60" value="' + esc(s.lowerName) + '" placeholder="The host’s name"></label><label>Lower third title<input type="text" name="lowerTitle" maxlength="60" value="' + esc(s.lowerTitle) + '"></label><label>Ticker message<input type="text" name="ticker" maxlength="160" value="' + esc(s.ticker) + '"></label></div>' +
        '<div class="sts-g"><label>Offer scene heading<input type="text" name="offerHeading" maxlength="120" value="' + esc(s.offerHeading) + '" placeholder="The engagement is open"></label><label>Offer scene points (one per line, up to 5)<textarea name="offerPoints">' + esc((s.offerPoints || []).join('\n')) + '</textarea></label></div>' +
        packSection(s.pack || {}) +
        '<div class="sts-row"><button class="btn-sm" type="submit">Save</button><span class="sts-note">The room picks the changes up on its next update; scene words show after a page refresh.</span></div></form>' +
        '<section class="sts-sec"><h3>Slides in this room</h3>' + ((data.decks || []).length ? '<ul class="sts-list">' + data.decks.map(function (d) { return '<li><span>' + esc(d.title) + ' · ' + d.pages + ' pages' + (d.status !== 'ready' ? ' (upload not finished)' : '') + '</span><button class="btn-sm ghost" data-deck-del="' + esc(d.id) + '">Delete</button></li>'; }).join('') + '</ul>' : '<p class="sts-note">None yet. The host uploads a PDF or images from the Studio tab in the room.</p>') + '</section>' +
        '<section class="sts-sec"><h3>Show templates</h3><p class="sts-note">A template carries this room’s studio settings (branding, music, scenes, words) to another event. Slides stay with their room.</p>' +
        '<div class="sts-row"><input type="text" data-tname maxlength="80" placeholder="Template name"><button class="btn-sm" data-tsave>Save these settings as a template</button></div>' +
        ((data.templates || []).length ? '<ul class="sts-list">' + data.templates.map(function (t) { return '<li><span>' + esc(t.name) + '</span><span class="sts-row"><button class="btn-sm ghost" data-tapply="' + esc(t.id) + '">Apply to this room</button><button class="btn-sm ghost" data-tdel="' + esc(t.id) + '">Delete</button></span></li>'; }).join('') + '</ul>' : '<p class="sts-note">No templates yet.</p>') + '</section>';
      var f = box.querySelector('[data-f]');
      function preview() {
        var p = box.querySelector('[data-prev]');
        p.style.background = 'linear-gradient(135deg,' + f.bg.value + ',#000 160%)'; p.style.color = f.text.value;
        p.innerHTML = (s.logo ? '<img alt="" src="/api/rooms/' + esc(roomId) + '/studio/asset/logo?v=' + esc(s.logo) + '">' : '') + '<span style="font-size:12px;opacity:.8">Starting soon</span><strong>' + esc(f.introTitle.value || data.room.title) + '</strong><span style="width:60px;height:3px;background:' + esc(f.accent.value) + '"></span>';
      }
      ['bg', 'accent', 'text', 'introTitle'].forEach(function (n) { f[n].oninput = preview; });
      preview();
      box.querySelector('[data-x]').onclick = close;
      function payload() {
        return {
          on: f.on.checked, greenRoom: f.greenRoom.checked, scene: f.scene.value, layout: f.layout.value, script: f.script.value || null,
          colors: { bg: f.bg.value, accent: f.accent.value, text: f.text.value }, musicOn: f.musicOn.checked,
          introTitle: f.introTitle.value, introNote: f.introNote.value, brbText: f.brbText.value, outroTitle: f.outroTitle.value, outroNote: f.outroNote.value,
          lowerName: f.lowerName.value, lowerTitle: f.lowerTitle.value, ticker: f.ticker.value, offerHeading: f.offerHeading.value, offerPoints: f.offerPoints.value,
          pack: { offerCard: f.packCard.value, bridgeLine: f.packLine.value, stackHeading: f.packStackH.value, stack: f.packStack.value, anchorHeading: f.packAnchorH.value, anchor: f.packAnchor.value },
        };
      }
      f.onsubmit = function (e) { e.preventDefault(); req('POST', roomId + '/studio', payload()).then(function (d) { if (!d.ok) { toast(d.error || 'Not saved'); return; } data.settings = d.settings; data.packIssues = d.packIssues || []; toast(data.packIssues.length ? 'Saved. Check the pitch notes.' : 'Studio saved'); draw(); }); };
      box.querySelectorAll('[data-up]').forEach(function (inp) {
        inp.onchange = function () {
          var file = inp.files && inp.files[0]; if (!file) return;
          var kind = inp.getAttribute('data-up');
          inp.disabled = true;
          fetch('/admin/api/rooms/studio/assets?kind=' + kind + '&name=' + encodeURIComponent(file.name.slice(0, 100)), { method: 'POST', credentials: 'same-origin', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file }).then(function (r) { return r.json(); }).then(function (d) {
            inp.disabled = false;
            if (!d.ok) { toast(d.error || 'Upload failed'); return; }
            var body = payload(); body[kind] = d.id; if (kind === 'music') body.musicOn = true;
            return req('POST', roomId + '/studio', body).then(function (x) { if (x.ok) { data.settings = x.settings; data.assets = (data.assets || []).concat([{ id: d.id, kind: kind, name: d.name }]); toast('Uploaded'); draw(); } });
          });
        };
      });
      box.querySelectorAll('[data-clear]').forEach(function (b) { b.onclick = function () { var body = payload(); body[b.getAttribute('data-clear')] = null; req('POST', roomId + '/studio', body).then(function (x) { if (x.ok) { data.settings = x.settings; draw(); } }); }; });
      box.querySelectorAll('[data-deck-del]').forEach(function (b) { b.onclick = function () { if (!confirm('Delete these slides from the room?')) return; req('POST', roomId + '/studio/deck/' + b.getAttribute('data-deck-del') + '/delete').then(function () { load(); }); }; });
      box.querySelector('[data-tsave]').onclick = function () {
        var name = box.querySelector('[data-tname]').value.trim(); if (!name) { toast('Name the template'); return; }
        req('POST', roomId + '/studio', payload()).then(function () { return req('POST', 'studio/templates', { name: name, room: roomId }); }).then(function (d) { if (!d.ok) { toast(d.error || 'Not saved'); return; } data.templates = d.templates; toast('Template saved'); draw(); });
      };
      box.querySelectorAll('[data-tapply]').forEach(function (b) { b.onclick = function () { if (!confirm('Replace this room’s studio settings with the template?')) return; req('POST', 'studio/templates/' + b.getAttribute('data-tapply') + '/apply', { room: roomId }).then(function (d) { if (!d.ok) { toast(d.error || 'Not applied'); return; } data.settings = d.settings; toast('Template applied'); draw(); }); }; });
      box.querySelectorAll('[data-tdel]').forEach(function (b) { b.onclick = function () { if (!confirm('Delete this template?')) return; req('POST', 'studio/templates/' + b.getAttribute('data-tdel') + '/delete').then(function (d) { data.templates = d.templates || []; draw(); }); }; });
    }
    load();
  }

  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-rmb-studio]') : null;
    if (!b) return;
    e.preventDefault();
    open(b.getAttribute('data-rmb-studio'));
  });
  window.StudioBoard = { open: open };
})();
