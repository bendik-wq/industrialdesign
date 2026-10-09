/* "Talk now" — in-browser call with the inbound AI assistant (Vapi).
 * Nothing loads until the visitor presses the button next to the AI + recording
 * disclosure; the server checks they're an applicant, rate-limits, and hands
 * back signed per-lead overrides. The Vapi SDK is fetched on demand. */
(function () {
  'use strict';
  var btn = document.querySelector('[data-voice-start]');
  var status = document.querySelector('[data-voice-status]');
  if (!btn) return;
  var SDK = 'https://cdn.jsdelivr.net/npm/@vapi-ai/web@2.7.0/+esm';
  var vapi = null, live = false, label = btn.textContent;

  function say(t) { if (status) status.textContent = t; }
  function setLive(on) {
    live = on;
    btn.textContent = on ? 'End the call' : label;
    btn.classList.toggle('btn-live', on);
    btn.disabled = false;
  }

  btn.addEventListener('click', function () {
    if (live && vapi) { vapi.stop(); return; }
    btn.disabled = true;
    say('Connecting… allow microphone access when your browser asks.');
    fetch('/api/voice/start', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Could not start the call'); return j; }); })
      .then(function (cfg) {
        return import(SDK).then(function (mod) {
          var Vapi = mod.default && mod.default.default ? mod.default.default : mod.default || mod.Vapi;
          vapi = new Vapi(cfg.publicKey);
          vapi.on('call-start', function () { setLive(true); say('You’re live. Speak normally — Sam can hear you.'); });
          vapi.on('call-end', function () { setLive(false); say('Call ended. If Sam sent you a link, it’s in your inbox.'); });
          vapi.on('error', function (e) { console.error(e); setLive(false); say('The call dropped. Try again, or book a time instead.'); });
          return vapi.start(cfg.assistantId, cfg.overrides);
        });
      })
      .catch(function (e) { btn.disabled = false; say(e.message || 'Could not start the call.'); });
  });
})();
