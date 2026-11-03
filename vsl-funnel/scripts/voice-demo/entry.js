// Funnel HQ → Talk to an agent (bundled to public/assets/voice-demo.js by `npm run build:voice-demo`).
import { Conversation } from '@elevenlabs/client';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
let scenarios = [], pick = null, convo = null;
// Opened from Funnel HQ → Sandbox ("Talk to Sam now"): one call from the simulation, rebuilt on the server.
const fromSandbox = (() => {
  try {
    const raw = new URLSearchParams(location.search).get('sb');
    if (!raw) return null;
    const d = JSON.parse(decodeURIComponent(escape(atob(raw.replace(/-/g, '+').replace(/_/g, '/')))));
    return d && d.id && d.q ? { id: 'sandbox', label: 'From the sandbox: ' + String(d.title || 'this call').slice(0, 80), blurb: 'The exact call from your simulation, with the sample lead’s details and the moment it happens.', you: 'You are ' + String((d.q.lead && d.q.lead.name) || 'the sample lead').slice(0, 30) + '. Answer the way they would.', sandbox: { q: d.q, id: String(d.id) } } : null;
  } catch (e) { return null; }
})();

function setStatus(t) { $('[data-status]').textContent = t; }
function log(who, text) {
  const li = document.createElement('li');
  li.className = who === 'agent' ? 'is-agent' : 'is-you';
  li.innerHTML = '<b>' + (who === 'agent' ? 'Sam (AI)' : 'You') + '</b><span>' + esc(text) + '</span>';
  $('[data-log]').appendChild(li);
  li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function setMode(m) { const o = $('[data-orb]'); o.classList.toggle('is-speaking', m === 'speaking'); o.classList.toggle('is-listening', m === 'listening'); }
function busy(on) { $('[data-start]').hidden = on; $('[data-end]').hidden = !on; document.querySelectorAll('[data-sc]').forEach((b) => (b.disabled = on)); }

function drawScenarios() {
  $('[data-scenarios]').innerHTML = scenarios.map((s) =>
    '<button type="button" class="vd-sc" role="radio" aria-checked="false" data-sc="' + esc(s.id) + '"><b>' + esc(s.label) + '</b><span>' + esc(s.blurb) + '</span></button>').join('');
  document.querySelectorAll('[data-sc]').forEach((b) => {
    b.onclick = () => {
      pick = scenarios.find((s) => s.id === b.getAttribute('data-sc'));
      document.querySelectorAll('[data-sc]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
      $('[data-you]').textContent = pick.you;
      $('[data-start]').disabled = false;
      setStatus('Ready. Press Start and allow the microphone.');
    };
  });
}

async function start() {
  if (!pick) return;
  $('[data-log]').innerHTML = '';
  busy(true); setStatus('Connecting…');
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true }).then((st) => st.getTracks().forEach((t) => t.stop()));
  } catch (e) { busy(false); setStatus('Allow the microphone to talk to the agent (the lock icon in the address bar).'); return; }
  const r = await fetch('/admin/api/voice/demo/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pick.sandbox ? { sandbox: pick.sandbox } : { scenario: pick.id }) }).then((x) => x.json()).catch(() => null);
  if (!r || !r.ok) { busy(false); setStatus((r && r.error) || 'Couldn’t start the session. Try again.'); return; }
  try {
    convo = await Conversation.startSession({
      signedUrl: r.signedUrl,
      connectionType: 'websocket',
      dynamicVariables: r.dynamicVariables,
      onConnect: () => setStatus('Connected. Sam is speaking; answer when it’s your turn.'),
      onDisconnect: () => { busy(false); setMode(''); setStatus('Call ended.'); convo = null; },
      onError: (m) => setStatus('Problem: ' + (typeof m === 'string' ? m : 'connection error')),
      onModeChange: (m) => { setMode(m.mode); if (convo) setStatus(m.mode === 'speaking' ? 'Sam is speaking…' : 'Listening… go ahead.'); },
      onMessage: (m) => { if (m && m.message) log(m.source === 'ai' ? 'agent' : 'you', m.message.replace(/\[[^\]]+\]\s*/g, '')); },
    });
  } catch (e) { busy(false); setStatus('Couldn’t connect: ' + (e && e.message ? e.message : 'error')); }
}

$('[data-start]').onclick = start;
$('[data-end]').onclick = () => { if (convo) convo.endSession(); };
fetch('/admin/api/voice/demo/scenarios').then((x) => x.json()).then((d) => { scenarios = (fromSandbox ? [fromSandbox] : []).concat(d.scenarios || []); drawScenarios(); if (fromSandbox) { const b = document.querySelector('[data-sc="sandbox"]'); if (b) b.click(); } }).catch(() => setStatus('Couldn’t load the scenarios. Reload the page.'));
