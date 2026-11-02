/* Funnel HQ → Rooms → a room's details: call quality per person (area A "media", src/rooms/media.ts).
   admin-rooms.js calls RoomMediaAdmin.fill(cell, roomId) under the attendance table. Everything shown was
   measured by each person's own browser during the session and summarised by the room once a minute. */
(function () {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var LV = { good: ['Good', '#1d7a4f'], fair: ['Fair', '#b26a00'], poor: ['Weak', '#b3261e'], bad: ['Very weak', '#b3261e'] };
  var NAMES = { windows: 'Windows', mac: 'Mac', ios: 'iPhone/iPad', android: 'Android', chromeos: 'ChromeOS', linux: 'Linux', other: 'Other', chrome: 'Chrome', edge: 'Edge', safari: 'Safari', firefox: 'Firefox', samsung: 'Samsung', none: 'none', sfu: 'SFU', moq: 'MoQ' };
  var name = function (k) { return NAMES[k] || k || '–'; };
  function bar(r) {
    var n = Math.max(1, r.samples);
    return '<span style="display:inline-flex;width:120px;height:8px;border-radius:4px;overflow:hidden;background:#e8e8ed;vertical-align:middle" title="' + esc(r.n_good + ' good, ' + r.n_fair + ' fair, ' + r.n_poor + ' weak, ' + r.n_bad + ' very weak samples') + '">' +
      [['n_good', '#1d7a4f'], ['n_fair', '#b26a00'], ['n_poor', '#e0645c'], ['n_bad', '#b3261e']].map(function (x) { return '<span style="width:' + (r[x[0]] / n * 100) + '%;background:' + x[1] + '"></span>'; }).join('') + '</span>';
  }
  // Host diagnostics (0075): who could not see or hear the host, for how long, and why (each attendee's own browser checked).
  var WHY = { not_found: 'host track not at the video server', retrying: 'still connecting', pending: 'waiting for the video', stalled: 'stopped arriving', audio_only: 'their connection too weak for video', no_connection: 'their media connection down', moq_wait: 'broadcast not playing', autoplay: 'sound blocked until they tapped' };
  function dur(ms) { ms = Math.round((ms || 0) / 1000); if (!ms) return '–'; var m = Math.floor(ms / 60), s = ms % 60; return m ? m + ' min ' + s + ' s' : s + ' s'; }
  function reasons(list) { return (list || []).map(function (x) { return (WHY[x.reason] || x.reason) + ' ' + x.n; }).join(', '); }
  function rxHtml(rx) {
    if (!rx) return '';
    var s = rx.summary || {}, rows = (rx.rows || []).filter(function (r) { return r.no_video_ms > 0 || r.no_audio_ms > 0; });
    var head = '<p style="margin-top:16px"><strong>Could attendees see and hear the host</strong> ';
    if (rx.note) return head + '<span class="muted">' + esc(rx.note) + '</span></p>';
    if (!s.attendees) return head + '<span class="muted">No receive checks yet. Each attendee’s browser checks the host’s video and sound arrive.</span></p>';
    return head + esc(s.cantSee) + ' of ' + esc(s.attendees) + ' could not see the host at some point (' + esc(dur(s.cantSeeMs)) + ' in total, longest ' + esc(dur(s.longestNoVideoMs)) + ')' +
      ' · ' + esc(s.cantHear) + ' could not hear the host (' + esc(dur(s.cantHearMs)) + ' in total, longest ' + esc(dur(s.longestNoAudioMs)) + ')' +
      ' · camera self-check republished ' + esc(s.republishes || 0) + ' times' +
      (s.videoReasons && s.videoReasons.length ? '<br><span class="muted">Video: ' + esc(reasons(s.videoReasons)) + '</span>' : '') +
      (s.audioReasons && s.audioReasons.length ? '<br><span class="muted">Sound: ' + esc(reasons(s.audioReasons)) + '</span>' : '') + '</p>' +
      (rows.length ? '<table><thead><tr><th>Who</th><th class="num">No video</th><th>Why</th><th class="num">No sound</th><th>Why</th></tr></thead><tbody>' + rows.map(function (r) {
        return '<tr><td>' + esc(r.name) + '<div class="muted">' + esc(r.role) + '</div></td><td class="num">' + esc(dur(r.no_video_ms)) + (r.video_episodes > 1 ? ' <span class="muted">(' + esc(r.video_episodes) + ' times)</span>' : '') + '</td><td>' + esc(WHY[r.video_reason] || r.video_reason || '–') + '</td>' +
          '<td class="num">' + esc(dur(r.no_audio_ms)) + (r.audio_episodes > 1 ? ' <span class="muted">(' + esc(r.audio_episodes) + ' times)</span>' : '') + '</td><td>' + esc(WHY[r.audio_reason] || r.audio_reason || '–') + '</td></tr>';
      }).join('') + '</tbody></table>' : '');
  }
  function fill(cell, id) {
    if (!cell) return;
    var box = document.createElement('div');
    box.style.marginTop = '12px';
    box.innerHTML = '<p><strong>Call quality</strong> <span class="muted">loading</span></p>';
    cell.appendChild(box);
    fetch('/admin/api/rooms/' + encodeURIComponent(id) + '/media', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
      var rows = d.rows || [], s = d.summary || {};
      if (!rows.length) { box.innerHTML = '<p><strong>Call quality</strong> <span class="muted">' + esc(d.note || 'No reports yet. Each person’s browser reports its connection during the session.') + '</span></p>'; return; }
      var paths = Object.keys(s.byPath || {}).map(function (k) { return name(k) + ' ' + s.byPath[k]; }).join(', ');
      box.innerHTML = '<p><strong>Call quality</strong> ' + esc(s.people) + ' people · median delay ' + esc(s.medianRtt != null ? s.medianRtt + ' ms' : '–') +
        ' · median loss ' + esc(s.medianLoss != null ? (s.medianLoss * 100).toFixed(1) + ' %' : '–') + ' · ' + esc(s.reconnects) + ' reconnects · ' + esc(s.relayed) + ' through a relay · ' + esc(paths) +
        (s.trouble ? ' · <strong style="color:#b3261e">' + esc(s.trouble) + ' with a weak connection a quarter of the time or more</strong>' : '') + '</p>' +
        '<table><thead><tr><th>Who</th><th>Device</th><th>Path</th><th>Quality over the session</th><th>Worst</th><th class="num">Delay</th><th class="num">Loss</th><th class="num">Jitter</th><th class="num">Down / up kbps</th><th class="num">Reconnects</th><th>Effects</th></tr></thead><tbody>' +
        rows.map(function (r) {
          var w = LV[r.worst] || LV.good;
          return '<tr><td>' + esc(r.name) + '<div class="muted">' + esc(r.role) + '</div></td><td>' + esc(name(r.browser) + ' on ' + name(r.os)) + (r.mobile ? ' <span class="muted">(phone)</span>' : '') + '</td>' +
            '<td>' + esc(name(r.path)) + (r.relay ? ' <span class="muted">relay' + (r.proto ? ' ' + esc(String(r.proto).toUpperCase()) : '') + '</span>' : '') + '</td>' +
            '<td>' + bar(r) + (r.audio_only_samples ? ' <span class="muted">audio only ' + Math.round(r.audio_only_samples / Math.max(1, r.samples) * 100) + '%</span>' : '') + '</td>' +
            '<td style="color:' + w[1] + '">' + esc(w[0]) + '</td>' +
            '<td class="num">' + esc(r.rtt_avg != null ? r.rtt_avg + ' ms' : '–') + '</td><td class="num">' + esc(r.loss_avg != null ? (r.loss_avg * 100).toFixed(1) + '%' : '–') + '</td><td class="num">' + esc(r.jitter_avg != null ? r.jitter_avg + ' ms' : '–') + '</td>' +
            '<td class="num">' + esc((r.kbps_in_avg != null ? r.kbps_in_avg : '–') + ' / ' + (r.kbps_out_avg != null ? r.kbps_out_avg : '–')) + '</td><td class="num">' + esc(r.reconnects) + '</td>' +
            '<td>' + esc([r.fx && r.fx !== 'off' ? (r.fx === 'brand' ? 'backdrop' : r.fx) : '', r.noise === 'strong' ? 'strong noise reduction' : r.noise === 'off' ? 'noise reduction off' : ''].filter(Boolean).join(', ') || '–') + '</td></tr>';
        }).join('') + '</tbody></table>' + rxHtml(d.rx);
    }).catch(function () { box.innerHTML = '<p><strong>Call quality</strong> <span class="muted">Could not load.</span></p>'; });
  }
  window.RoomMediaAdmin = { fill: fill };
})();
