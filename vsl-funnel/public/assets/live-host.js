/* Funnel HQ → host console for one live event (/admin/live/:key): the Zoom join link (paste or create through the
 * Zoom API), the host start link, the schedule, and a preview of what viewers see. Data comes embedded as JSON. */
(function () {
  'use strict';
  var box = document.querySelector('[data-live-host]');
  var dataEl = document.getElementById('live-host-data');
  if (!box || !dataEl) return;
  var ev = JSON.parse(dataEl.textContent || '{}');
  var api = '/admin/api/live-events/' + encodeURIComponent(ev.key);
  var skew = ev.serverNow ? ev.serverNow - Date.now() : 0;
  var preview = null;
  function now() { return Date.now() + skew; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function when(ms) { return new Date(ms).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }); }
  function localInput(ms) { var d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); }
  function send(method, url, body) {
    return fetch(url, { method: method, credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return { error: 'HTTP ' + r.status }; }); });
  }
  function toast(msg, bad) {
    var t = document.createElement('div'); t.className = 'lh-toast' + (bad ? ' bad' : ''); t.setAttribute('role', 'status'); t.textContent = msg;
    document.body.appendChild(t); setTimeout(function () { t.remove(); }, 3200);
  }
  function stage() {
    var s = ev.schedule; if (!s) return { label: 'Not scheduled', cls: '' };
    var t = now(), start = s.startsAt, end = start + s.durationMin * 60000, opens = start - ev.opensMin * 60000;
    if (t < opens) return { label: 'Scheduled', cls: '' };
    if (t < start) return { label: 'Doors open', cls: 'on' };
    if (t < end) return { label: 'Live now (by the schedule)', cls: 'live' };
    return { label: 'Ended', cls: '' };
  }
  function kindLabel() {
    var m = /^challenge:[^:]+:(\d+)$/.exec(ev.key);
    if (m) return 'Challenge, Day ' + m[1];
    return ev.kind === 'webinar' ? 'Live webinar session' : 'Live event';
  }

  function render() {
    var st = stage(), s = ev.schedule, setup = ev.setup || {}, z = ev.zoom;
    var sessionNote = ev.session && ev.session.mode !== 'live'
      ? '<p class="lh-warn">This webinar session is set to <b>' + esc(ev.session.mode) + '</b>, so its room ' + (ev.session.mode === 'evergreen' ? 'plays the recording and doesn’t show this link' : 'plays the stream URL when one is set, else this link') + '. Live Zoom sessions are created as “live” under Webinar → Upcoming sessions.</p>' : '';
    box.innerHTML =
      '<header class="lh-head"><p class="lh-eyebrow">' + esc(kindLabel()) + '</p><h1>' + esc(ev.title) + '</h1>' +
      '<p class="lh-when">' + (s ? esc(when(s.startsAt)) + ' · ' + s.durationMin + ' min' : 'No start time yet') + ' <span class="lh-pill ' + st.cls + '">' + esc(st.label) + '</span></p></header>' +
      (setup.ready ? '' : '<section class="lh-sec lh-setup"><h2>Zoom API not connected</h2><p>' + esc(/^Zoom API not connected/.test(setup.reason || '') ? 'Events still run: paste the Zoom link below. Connect Zoom and Funnel HQ creates each meeting for you.' : setup.reason) + '</p><details><summary>Connect Zoom so Funnel HQ creates the meeting</summary><ol>' + (setup.steps || []).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ol></details></section>') +
      '<section class="lh-sec"><h2>Join link</h2>' + sessionNote +
        (ev.joinUrl
          ? '<div class="lh-link"><span class="mono" data-link>' + esc(ev.joinUrl) + '</span><div class="lh-row"><button class="btn-sm ghost" type="button" data-copy>Copy</button><a class="btn-sm ghost" href="' + esc(ev.joinUrl) + '" target="_blank" rel="noopener">Open</a><button class="btn-sm ghost" type="button" data-remove>Remove</button></div></div>' +
            '<p class="lh-help">Viewers get it from ' + ev.opensMin + ' minutes before the start until ' + ev.overrunMin + ' minutes after the scheduled end. It never appears on public pages.</p>'
          : '<p class="lh-help">No link yet. Viewers see the start time and “The link appears here” until you add one.</p>') +
        '<form class="lh-row lh-form" data-link-form><label class="lh-grow"><span class="sr">Zoom or other https link</span><input class="input" name="join_url" type="url" inputmode="url" placeholder="https://us02web.zoom.us/j/…" required></label><button class="btn-sm" type="submit">' + (ev.joinUrl ? 'Replace link' : 'Save link') + '</button></form>' +
      '</section>' +
      '<section class="lh-sec"><h2>Host</h2>' +
        (z
          ? '<p>Zoom ' + esc(z.kind || 'meeting') + ' <span class="mono">' + esc(z.id) + '</span>' + (z.password ? ' · passcode <span class="mono">' + esc(z.password) + '</span>' : '') + '</p><div class="lh-row"><a class="btn-sm" href="' + esc(api + '/start') + '" target="_blank" rel="noopener">Start as host in Zoom</a></div><p class="lh-help">Opens a fresh host link each time (Zoom expires them after two hours). Only signed-in Funnel HQ users can open it.</p>'
          : setup.ready
            ? '<form class="lh-grid" data-zoom-form><label>Starts<input class="input" name="starts_at" type="datetime-local" required value="' + (s ? esc(localInput(s.startsAt)) : '') + '"></label><label>Length (minutes)<input class="input" name="duration_min" type="number" min="15" max="600" value="' + (s ? s.durationMin : 90) + '"></label><label class="lh-full">Title in Zoom<input class="input" name="title" maxlength="200" value="' + esc(ev.title) + '"></label><div class="lh-full lh-row"><button class="btn-sm" type="submit">Create Zoom meeting</button><span class="lh-help">A Zoom Webinar when your account has the add-on, else a meeting with everyone muted on entry. The join link fills in above.</span></div></form>'
            : '<p class="lh-help">Start the meeting from your Zoom app, signed in to the account that owns the link.</p>') +
      '</section>' +
      (ev.scheduleFrom === 'webinar'
        ? '<section class="lh-sec"><h2>Schedule</h2><p class="lh-help">Set by the webinar session. Change the time under Funnel HQ → Webinar.</p></section>'
        : '<section class="lh-sec"><h2>Schedule</h2><form class="lh-grid" data-sched-form><label>Starts<input class="input" name="starts_at" type="datetime-local" required value="' + (s ? esc(localInput(s.startsAt)) : '') + '"></label><label>Length (minutes)<input class="input" name="duration_min" type="number" min="15" max="600" value="' + (s ? s.durationMin : 90) + '"></label><div class="lh-full lh-row"><button class="btn-sm ghost" type="submit">Save schedule</button></div></form></section>') +
      '<section class="lh-sec"><h2>What viewers see</h2><div data-preview></div></section>';
    bind();
    if (window.LivePlayer) {
      if (preview) preview.destroy();
      preview = window.LivePlayer.mount(box.querySelector('[data-preview]'), { key: ev.key, playback: ev.playback, serverNow: ev.serverNow, poll: false, onNeedLink: function () {} });
    }
  }

  function apply(r, msg) {
    if (r && r.event) { ev = r.event; skew = ev.serverNow ? ev.serverNow - Date.now() : 0; render(); toast(msg); return; }
    toast((r && r.error) || 'Something went wrong', true);
  }
  function bind() {
    var lf = box.querySelector('[data-link-form]');
    lf.onsubmit = function (e) { e.preventDefault(); var b = lf.querySelector('button'); b.disabled = true; send('PUT', api, { join_url: lf.join_url.value }).then(function (r) { b.disabled = false; apply(r, 'Link saved'); }); };
    var rm = box.querySelector('[data-remove]');
    if (rm) rm.onclick = function () { if (confirm('Remove the join link? Viewers will see “The link appears here” until you add one.')) send('PUT', api, { join_url: '' }).then(function (r) { apply(r, 'Link removed'); }); };
    var cp = box.querySelector('[data-copy]');
    if (cp) cp.onclick = function () { (navigator.clipboard ? navigator.clipboard.writeText(ev.joinUrl) : Promise.reject()).then(function () { toast('Copied'); }, function () { toast('Select the link and copy it', true); }); };
    var zf = box.querySelector('[data-zoom-form]');
    if (zf) zf.onsubmit = function (e) {
      e.preventDefault();
      var b = zf.querySelector('button'); b.disabled = true; b.textContent = 'Creating in Zoom…';
      send('POST', api + '/zoom', { starts_at: new Date(zf.starts_at.value).getTime(), duration_min: Number(zf.duration_min.value), title: zf.title.value })
        .then(function (r) { b.disabled = false; b.textContent = 'Create Zoom meeting'; apply(r, r && r.kind === 'webinar' ? 'Zoom Webinar created' : 'Zoom meeting created'); });
    };
    var sf = box.querySelector('[data-sched-form]');
    if (sf) sf.onsubmit = function (e) {
      e.preventDefault();
      send('PUT', api, { starts_at: new Date(sf.starts_at.value).getTime(), duration_min: Number(sf.duration_min.value) }).then(function (r) { apply(r, 'Schedule saved'); });
    };
  }

  render();
  // Keep the status pill honest as time passes.
  var lastStage = stage().label;
  setInterval(function () { var l = stage().label; if (l !== lastStage) { lastStage = l; var p = box.querySelector('.lh-pill'); if (p) { var st = stage(); p.textContent = st.label; p.className = 'lh-pill ' + st.cls; } } }, 15000);
})();
