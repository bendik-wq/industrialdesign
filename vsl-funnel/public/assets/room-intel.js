/* Rooms intel (area D) in the live room. Two small jobs, through window.RoomCore (room.js):
   - while the session is recorded, everyone sees that it is recorded and transcribed for the replay (privacy:
     nobody is transcribed without a visible notice);
   - the host's browser, which hears every voice, reports who is speaking when it changes (intel_speaker), so the
     transcript can name the speaker. Its own mic counts too: room.js only measures the voices it receives. */
(function () {
  'use strict';
  var tries = 0;
  function boot() {
    var R = window.RoomCore;
    if (!R) { if (tries++ < 50) setTimeout(boot, 100); return; }
    var notice = (R.CFG.intel && R.CFG.intel.notice) || '';

    // ── the notice ──
    function drawNotice() {
      var v = R.S.view; if (!v || !notice) return;
      var on = Boolean(v.room && v.room.recording && v.room.status !== 'ended');
      var el = document.querySelector('[data-ix-notice]');
      if (!on) { if (el) el.remove(); return; }
      if (el) return;
      var top = document.querySelector('.rm-top'); if (!top) return;
      el = document.createElement('p');
      el.className = 'rm-fine ix-recnotice'; el.setAttribute('data-ix-notice', ''); el.setAttribute('role', 'status');
      el.style.cssText = 'margin:0;padding:6px 16px;font-size:12px;color:#6e6e73;background:#f5f5f7;text-align:center';
      el.textContent = notice;
      top.insertAdjacentElement('afterend', el);
    }
    R.on('state', function () { setTimeout(drawNotice, 0); });

    // ── the active speaker (host only) ──
    if (R.ME.role !== 'host') return;
    var meter = null, last = null, cand = null, candAt = 0, mineAt = 0;
    function localLevel() {
      var tr = R.S.local && R.S.local.mic;
      if (!tr || tr.readyState !== 'live' || !R.S.micOn) { if (meter) { try { meter.ctx.close(); } catch (e) { /* closed */ } meter = null; } return 0; }
      if (!meter || meter.track !== tr) {
        try {
          var ctx = new (window.AudioContext || window.webkitAudioContext)();
          var src = ctx.createMediaStreamSource(new MediaStream([tr]));
          var an = ctx.createAnalyser(); an.fftSize = 512; src.connect(an);
          meter = { ctx: ctx, an: an, buf: new Float32Array(an.fftSize), track: tr };
        } catch (e) { return 0; }
      }
      meter.an.getFloatTimeDomainData(meter.buf);
      var sum = 0; for (var i = 0; i < meter.buf.length; i++) sum += meter.buf[i] * meter.buf[i];
      return Math.sqrt(sum / meter.buf.length);
    }
    setInterval(function () {
      var v = R.S.view; if (!v || v.room.status !== 'live') return;
      var t = Date.now();
      if (localLevel() > 0.03) mineAt = t;
      // My own voice in the last 1.2 s wins; else the loudest voice the room received (room.js keeps it in S.speaking).
      var now = t - mineAt < 1200 ? R.ME.id : R.S.speaking;
      if (!now) return;
      if (now !== cand) { cand = now; candAt = t; return; }
      // Report a change once it has held for about a second (no flicker on a cough).
      if (cand !== last && t - candAt >= 900) { last = cand; R.send({ t: 'intel_speaker', id: cand }); }
    }, 500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
