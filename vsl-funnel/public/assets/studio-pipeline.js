// G&L Studio, builder C: the Pipeline board (#studio-pipeline).
// A calm live view of the editing loop: Recorded → In Drive → Queued → Transcribing → Planning → Rendering → Delivered.
// Reads GET /admin/api/studio/videos every 4 s while the board is on screen (paused when the tab or view is hidden),
// highlights a video when the recorder fires `studio:uploaded`, and opens a sheet per video with the before/after
// players, the edit plan as a strip, chapters, packaging, shorts, Drive links, the event timeline and the actions.
// Guests (read-only Funnel HQ links) see everything but no buttons that change anything.

const API = '/admin/api/studio';
const POLL_MS = 4000;
const STAGES = [
  { key: 'recorded', label: 'Recorded', st: ['recording', 'uploaded'] },
  { key: 'in_drive', label: 'In Drive', st: ['in_drive'] },
  { key: 'queued', label: 'Queued', st: ['queued'] },
  { key: 'transcribing', label: 'Transcribing', st: ['transcribing'] },
  { key: 'planning', label: 'Planning', st: ['planning'] },
  { key: 'rendering', label: 'Rendering', st: ['rendering'] },
  { key: 'delivered', label: 'Delivered', st: ['delivering', 'done'] },
];
const STATUS_LABEL = {
  recording: 'Recording', uploaded: 'Uploaded', in_drive: 'In Drive', queued: 'Queued', transcribing: 'Transcribing',
  planning: 'Planning the edit', rendering: 'Rendering', delivering: 'Delivering to Drive', done: 'Delivered', failed: 'Failed', skipped: 'Skipped',
};
const BRAIN = { claude: 'Claude', 'workers-ai': 'Workers AI' };
const REASONS = { silence: 'Silence', filler: 'Filler words', retake: 'Retakes', other: 'Other cuts' };

const root = document.getElementById('studio-pipeline');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ms = (t) => (t == null || t === '' ? NaN : typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : /^\d+$/.test(String(t)) ? Number(t) : Date.parse(String(t).includes('T') || String(t).endsWith('Z') ? t : String(t).replace(' ', 'T') + 'Z'));
const parse = (v, d) => { if (v == null || v === '') return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };
function dur(sec) {
  if (!isFinite(sec) || sec < 0) return '';
  sec = Math.round(sec);
  if (sec < 60) return `${sec} s`;
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return s && m < 10 ? `${m} min ${s} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}
const clock = (sec) => { sec = Math.max(0, Math.round(sec || 0)); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60; return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`; };
function when(t) {
  const d = new Date(ms(t));
  if (isNaN(d)) return '';
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase().replace(/\s/g, ' ');
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}, ${time}`;
}
function ago(t) {
  const s = (Date.now() - ms(t)) / 1000;
  if (!isFinite(s)) return '';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

let state = { data: null, guest: false, highlight: null, timer: null, inflight: false, open: null, error: '' };

// ───────────── who is looking ─────────────
window.__studioWho = window.__studioWho || fetch('/admin/api/whoami', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));

// ───────────── network ─────────────
async function api(path, init = {}) {
  const r = await fetch(API + path, { credentials: 'same-origin', ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || (r.status === 403 ? 'Only the owner can do that.' : `Something went wrong (${r.status}).`));
  return j;
}
function toast(msg) {
  let t = document.querySelector('.sb-toast');
  if (!t) { t = document.createElement('div'); t.className = 'sb-toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toast.h);
  toast.h = setTimeout(() => t.classList.remove('on'), 2600);
}

// ───────────── the model ─────────────
const sortEvents = (evs) => (Array.isArray(evs) ? evs.slice().sort((a, b) => (ms(a.at) - ms(b.at)) || ((a.id || 0) - (b.id || 0))) : []);
function stageIndex(v) {
  const st = v.status;
  let i = STAGES.findIndex((s) => s.st.includes(st));
  if (i >= 0) return i;
  // failed / skipped: the stage it was in, from the last event that names one
  const evs = sortEvents(v.events);
  for (let k = evs.length - 1; k >= 0; k--) {
    const j = STAGES.findIndex((s) => s.st.includes(evs[k].stage) || s.key === evs[k].stage);
    if (j >= 0) return j;
  }
  return 0;
}
function sinceStage(v) {
  const evs = sortEvents(v.events);
  let start = NaN;
  for (let k = evs.length - 1; k >= 0; k--) { if (evs[k].stage === v.status) start = ms(evs[k].at); else if (isFinite(start)) break; }
  if (!isFinite(start)) start = ms(v.updated_at);
  return isFinite(start) ? (Date.now() - start) / 1000 : NaN;
}
const latest = (v) => { const evs = sortEvents(v.events); return (v.status === 'failed' && v.error) || evs[evs.length - 1]?.message || v.stage_detail || ''; };

// ───────────── rendering: the shell ─────────────
function shell() {
  root.innerHTML = `<div class="sb-wrap">
    <header class="sb-card sb-head" aria-live="polite"></header>
    <div class="sb-rail-head" aria-hidden="true"><div></div><div class="sb-stages"></div></div>
    <div class="sb-list" role="list"></div>
  </div>`;
}

function headHtml(d) {
  const drive = d.drive || {};
  const scan = d.scan || {};
  const brain = d.brain || '';
  const eng = d.engine || {};
  const guest = state.guest;
  const lastT = ms(scan.last), nextT = ms(scan.next);
  const nextIn = isFinite(nextT) ? (nextT - Date.now()) / 1000 : NaN;
  const driveOk = drive.connected && drive.scopeOk !== false;
  const folder = drive.folderLink ? `<a class="sb-link" href="${esc(drive.folderLink)}" target="_blank" rel="noopener">Open the folder</a>` : '';
  const notes = [];
  if (!drive.connected && drive.configured === false) notes.push(`<div class="sb-note" style="display:block"><span><strong>One-time Google setup first.</strong> Funnel HQ needs its own Google sign-in client before it can connect to Drive (about 5 minutes, done once).</span><ol style="margin:8px 0 0 18px;padding:0;line-height:1.6"><li>Open <a class="sb-link" href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noopener">Google Cloud: Drive API</a>, pick or create a project, press Enable.</li><li><a class="sb-link" href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noopener">Google Auth Platform</a>: set it up; Audience: Internal if you use Google Workspace (else External and add your Google account as a test user).</li><li><a class="sb-link" href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noopener">Clients</a> → Create client → Web application → Authorised redirect URI: <code>${esc(drive.redirectUri || '')}</code></li><li>Paste the Client ID and Client secret in <a class="sb-link" href="/admin#integrations">Integrations → Content</a>, save, then come back and press Connect Google Drive.</li></ol>${guest ? '' : '<p style="margin:8px 0 0">Sign in with a Google account that can edit the folder.</p>'}</div>`);
  else if (!drive.connected) notes.push(`<div class="sb-note"><span>Google Drive is not connected. Connect it so recordings land in the folder and new files there get edited.</span>${guest ? '<span>The owner can connect it.</span>' : '<a class="sb-btn sb-btn-primary sb-btn-sm" href="' + esc(drive.connectUrl || '/admin/api/google/connect?to=studio') + '">Connect Google Drive</a>'}</div>`);
  else if (drive.scopeOk === false) notes.push(`<div class="sb-note"><span>Drive is connected for documents only. Reconnect once so the editor can see every file in the folder, including ones you drop in by hand.</span>${guest ? '<span>The owner can reconnect it.</span>' : '<a class="sb-btn sb-btn-primary sb-btn-sm" href="' + esc(drive.connectUrl || '/admin/api/google/connect?to=studio') + '">Reconnect for folder access</a>'}</div>`);
  if (state.error) notes.push(`<div class="sb-note warn"><span>${esc(state.error)}</span></div>`);
  return `<div class="sb-head-top">
      <div><p class="sb-eyebrow">Pipeline</p><h1 class="sb-h1">Every recording, edited and back in Drive.</h1>
      <p class="sb-sub">Recordings go to the Drive folder, are transcribed, cut and rendered at the source's full quality, then the edited version lands back in the folder.</p></div>
      ${guest ? '<span class="sb-chip">View only</span>' : `<button class="sb-btn sb-btn-quiet" data-act="scan" ${drive.connected ? '' : 'disabled title="Connect Google Drive first"'}>Check Drive now</button>`}
    </div>
    <div class="sb-facts">
      <div class="sb-fact"><div class="sb-fact-k">Google Drive</div>
        <div class="sb-fact-v"><span class="sb-chip ${driveOk ? 'ok' : 'warn'}"><i class="sb-dot"></i>${driveOk ? 'Connected' : drive.connected ? 'Needs folder access' : 'Not connected'}</span></div>
        <div class="sb-fact-s">${folder || 'Folder YOUFUCK'}</div></div>
      <div class="sb-fact"><div class="sb-fact-k">Folder checks</div>
        <div class="sb-fact-v"><span>${isFinite(lastT) ? `Last checked ${esc(when(lastT))}` : 'Not checked yet'}</span></div>
        <div class="sb-fact-s">${isFinite(nextIn) ? (nextIn > 30 ? `Next check in ${esc(dur(nextIn))}` : 'Next check is due now') : 'Every 6 hours once Drive is connected'}</div></div>
      <div class="sb-fact"><div class="sb-fact-k">Edits planned by</div>
        <div class="sb-fact-v"><span>${esc(BRAIN[brain] || 'Not set')}</span></div>
        <div class="sb-fact-s">${brain === 'claude' ? 'Reads the transcript and plans every cut' : 'Add the Anthropic key in <a class="sb-link" href="/admin#integrations">Integrations</a> to have Claude plan edits.'}</div></div>
      <div class="sb-fact"><div class="sb-fact-k">Render engine</div>
        <div class="sb-fact-v"><span class="sb-chip ${eng.ready ? 'ok' : 'warn'}"><i class="sb-dot"></i>${eng.ready ? 'Ready' : 'Not ready'}</span></div>
        <div class="sb-fact-s">${esc(eng.detail || '')}</div></div>
    </div>
    ${notes.length ? `<div class="sb-notes">${notes.join('')}</div>` : ''}`;
}

function stagesHtml(d) {
  const counts = STAGES.map(() => 0);
  for (const v of d.videos || []) if (!['failed', 'skipped'].includes(v.status)) counts[stageIndex(v)]++;
  const brain = BRAIN[d.brain] || '';
  return STAGES.map((s, i) => `<div><span>${s.key === 'planning' && brain ? `Planning (${esc(brain)})` : esc(s.label)}</span><b>${counts[i] || ''}</b></div>`).join('');
}

// ───────────── rendering: one row per video (kept between polls so bars animate) ─────────────
function rowSkeleton(v) {
  const el = document.createElement('article');
  el.className = 'sb-card sb-row';
  el.setAttribute('role', 'listitem');
  el.tabIndex = 0;
  el.dataset.id = v.id;
  el.innerHTML = `<div class="sb-who"><div class="sb-thumb"><img alt="" loading="lazy"><span class="sb-dur"></span></div>
      <div style="min-width:0"><div class="sb-title"></div><div class="sb-meta"></div></div></div>
    <div><div class="sb-track">${STAGES.map(() => '<div class="sb-seg"><i></i></div>').join('')}</div>
      <div class="sb-status"><strong></strong><span class="sb-ev"></span><span class="sb-el"></span></div></div>`;
  const img = el.querySelector('img');
  img.addEventListener('error', () => { img.remove(); }, { once: true });
  img.src = `${API}/videos/${encodeURIComponent(v.id)}/thumb`;
  el.addEventListener('click', () => openSheet(v.id));
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSheet(v.id); } });
  return el;
}
function updateRow(el, v) {
  const idx = stageIndex(v);
  const failed = v.status === 'failed', done = v.status === 'done', skipped = v.status === 'skipped';
  el.classList.toggle('is-failed', failed);
  el.classList.toggle('is-done', done);
  el.classList.toggle('is-skipped', skipped);
  el.querySelector('.sb-title').textContent = v.title || 'Untitled recording';
  const res = v.height ? `${v.height >= 2160 ? '4K' : v.height + 'p'}` : '';
  el.querySelector('.sb-meta').textContent = [v.source === 'drive' ? 'From Drive' : 'Recorded here', res, ago(v.created_at)].filter(Boolean).join(' · ');
  el.querySelector('.sb-dur').textContent = v.duration_s ? clock(v.duration_s) : '';
  el.querySelector('.sb-dur').hidden = !v.duration_s;
  const p = Math.max(0, Math.min(1, Number(v.progress) || 0));
  el.querySelectorAll('.sb-seg').forEach((seg, i) => {
    const bar = seg.firstElementChild;
    seg.className = 'sb-seg' + (i < idx || (done && i === idx) ? ' done' : '') + (i === idx && !done && !failed && !skipped ? ' now' + (p > 0 ? '' : ' indet') : '') + (failed && i === idx ? ' fail' : '');
    bar.style.width = seg.classList.contains('now') && p > 0 ? `${(p * 100).toFixed(1)}%` : '';
  });
  const label = failed ? `Failed at ${STAGES[idx].label}` : STATUS_LABEL[v.status] || v.status;
  el.querySelector('.sb-status strong').textContent = label + (!done && !failed && !skipped && p > 0 ? ` ${Math.round(p * 100)}%` : '');
  el.querySelector('.sb-ev').textContent = latest(v);
  const el2 = el.querySelector('.sb-el');
  const t = done || failed || skipped ? ago(v.updated_at) : (isFinite(sinceStage(v)) ? `for ${dur(sinceStage(v))}` : '');
  el2.textContent = t;
  el.setAttribute('aria-label', `${v.title || 'Untitled recording'}: ${label}. ${latest(v)}`);
}

function emptyHtml() {
  return `<div class="sb-card sb-empty">
    <p class="sb-eyebrow">Nothing in the pipeline yet</p>
    <h2 class="sb-h2">Record once. The edit happens on its own.</h2>
    <p class="sb-sub">Record here or drop a file in the Drive folder: it is transcribed, cut and rendered, and the edited version lands back in the folder.</p>
    <div class="sb-loop" aria-hidden="true">${STAGES.map((s) => `<span>${esc(s.label)}</span>`).join('')}</div>
    ${state.guest ? '' : '<button class="sb-btn sb-btn-primary" data-act="record">Record your first video</button>'}
  </div>`;
}

function render() {
  const d = state.data;
  if (!d) return;
  if (!root.querySelector('.sb-head')) shell();
  root.querySelector('.sb-head').innerHTML = headHtml(d);
  const videos = (d.videos || []).filter((v) => !v.deleted_at);
  root.querySelector('.sb-rail-head').style.display = videos.length ? '' : 'none';
  root.querySelector('.sb-stages').innerHTML = stagesHtml(d);
  const list = root.querySelector('.sb-list');
  if (!videos.length) { list.innerHTML = emptyHtml(); return; }
  if (list.querySelector('.sb-empty')) list.innerHTML = '';
  const have = new Map([...list.querySelectorAll('.sb-row')].map((el) => [el.dataset.id, el]));
  let prev = null;
  for (const v of videos) {
    let el = have.get(v.id);
    if (!el) el = rowSkeleton(v);
    have.delete(v.id);
    updateRow(el, v);
    const want = prev ? prev.nextSibling : list.firstChild;
    if (el !== want) list.insertBefore(el, want);
    prev = el;
  }
  for (const el of have.values()) el.remove();
  if (state.highlight) {
    const el = list.querySelector(`.sb-row[data-id="${CSS.escape(state.highlight)}"]`);
    if (el) {
      state.highlight = null;
      el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
      el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
    }
  }
}

// ───────────── polling: every 4 s while the board is on screen ─────────────
const onScreen = () => document.visibilityState === 'visible' && !root.hidden && root.offsetParent !== null;
async function refresh() {
  if (state.inflight) return;
  state.inflight = true;
  try {
    state.data = await api('/videos');
    state.error = '';
  } catch (e) {
    state.error = `The pipeline could not be read just now (${e.message}). Trying again shortly.`;
    state.data = state.data || { videos: [], scan: {}, drive: {}, engine: {} };
  } finally {
    state.inflight = false;
  }
  render();
}
function loop() {
  clearTimeout(state.timer);
  state.timer = setTimeout(async () => { if (onScreen()) await refresh(); loop(); }, POLL_MS);
}
document.addEventListener('visibilitychange', () => { if (onScreen()) refresh(); });
// The page shell toggles the section's hidden attribute when the view changes: refresh at once when it shows.
new MutationObserver(() => { if (onScreen()) refresh(); }).observe(root, { attributes: true, attributeFilter: ['hidden', 'class', 'style'] });
window.addEventListener('studio:uploaded', (e) => { state.highlight = e.detail?.id || null; refresh(); });

root.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  if (b.dataset.act === 'record') window.studio?.show?.('record');
  if (b.dataset.act === 'scan') {
    b.disabled = true; const was = b.textContent; b.textContent = 'Checking…';
    try { const r = await api('/scan', { method: 'POST', body: '{}' }); toast(r.message || (r.found != null ? `${r.found ? r.found + ' new' : 'No new'} file${r.found === 1 ? '' : 's'} in the folder` : 'Drive checked')); }
    catch (err) { toast(err.message); }
    finally { b.disabled = false; b.textContent = was; refresh(); }
  }
});

// ───────────── the sheet ─────────────
const num = (x) => (x == null || x === '' ? NaN : typeof x === 'number' ? x : /^\d+(:\d{1,2}){1,2}(\.\d+)?$/.test(String(x)) ? String(x).split(':').reduce((a, p) => a * 60 + Number(p), 0) : Number(x));
const reasonOf = (r) => { r = String(r || '').toLowerCase(); return /silen|pause|dead|gap/.test(r) ? 'silence' : /filler|\bum|\buh|crutch/.test(r) ? 'filler' : /retake|repeat|mistake|false start|flub|redo/.test(r) ? 'retake' : 'other'; };
/** The edit plan as segments over the whole recording: kept, or cut with a reason. Accepts the shapes a plan may use. */
function planSegments(plan, total) {
  if (!plan || typeof plan !== 'object') return [];
  const span = (it) => ({ s: num(it.start ?? it.from ?? it.s ?? it.in ?? it.t0 ?? it.start_s), e: num(it.end ?? it.to ?? it.e ?? it.out ?? it.t1 ?? it.end_s) });
  const segs = [];
  const mixed = plan.segments || plan.timeline || plan.edits;
  if (Array.isArray(mixed) && mixed.length) {
    for (const it of mixed) {
      const { s, e } = span(it);
      if (!(e > s)) continue;
      const keep = it.keep ?? (it.action ? /keep/i.test(it.action) : it.type ? /keep/i.test(it.type) : !it.reason && !it.cut);
      segs.push({ s, e, keep: Boolean(keep), reason: keep ? '' : reasonOf(it.reason ?? it.kind ?? it.type ?? it.why) });
    }
  } else {
    const cuts = (plan.cuts || plan.removed || []).map((it) => ({ ...span(it), reason: reasonOf(it.reason ?? it.kind ?? it.type ?? it.why) })).filter((c) => c.e > c.s).sort((a, b) => a.s - b.s);
    const keeps = (plan.keep || plan.keeps || plan.kept || []).map(span).filter((c) => c.e > c.s).sort((a, b) => a.s - b.s);
    const end = Math.max(total || 0, ...cuts.map((c) => c.e), ...keeps.map((k) => k.e));
    if (cuts.length) {
      let t = 0;
      for (const c of cuts) { if (c.s > t) segs.push({ s: t, e: c.s, keep: true }); segs.push({ s: c.s, e: c.e, keep: false, reason: c.reason }); t = Math.max(t, c.e); }
      if (end > t) segs.push({ s: t, e: end, keep: true });
    } else if (keeps.length) {
      let t = 0;
      for (const k of keeps) { if (k.s > t) segs.push({ s: t, e: k.s, keep: false, reason: 'other' }); segs.push({ s: k.s, e: k.e, keep: true }); t = Math.max(t, k.e); }
      if (end > t) segs.push({ s: t, e: end, keep: false, reason: 'other' });
    }
  }
  return segs.sort((a, b) => a.s - b.s);
}
function chaptersOf(plan, v) {
  const fromPlan = Array.isArray(plan?.chapters) ? plan.chapters : [];
  const fromMarkers = parse(v.markers_json, []).filter?.((m) => m.kind === 'chapter') || [];
  return (fromPlan.length ? fromPlan : fromMarkers).map((c) => ({ t: num(c.t ?? c.start ?? c.time ?? c.at), label: c.label ?? c.title ?? '' })).filter((c) => isFinite(c.t));
}

function stripHtml(segs, chapters, total) {
  if (!segs.length) return '<p class="sb-muted" style="margin:0">The plan appears here once the edit is planned.</p>';
  const T = Math.max(total || 0, segs[segs.length - 1].e) || 1;
  const cut = { silence: 0, filler: 0, retake: 0, other: 0 };
  let kept = 0;
  for (const g of segs) if (g.keep) kept += g.e - g.s; else cut[g.reason] += g.e - g.s;
  const bars = segs.map((g) => `<button type="button" class="${g.keep ? 'keep' : g.reason}" style="flex:${(g.e - g.s).toFixed(2)} 0 0" data-seek="${g.s}" title="${esc(`${clock(g.s)} to ${clock(g.e)} · ${g.keep ? 'kept' : REASONS[g.reason]}`)}" aria-label="${esc(`${g.keep ? 'Kept' : 'Cut, ' + REASONS[g.reason]}: ${clock(g.s)} to ${clock(g.e)}`)}"></button>`).join('');
  const ticks = chapters.map((c) => `<span style="left:${((c.t / T) * 100).toFixed(2)}%">${esc(c.label)}</span>`).join('');
  const legend = [`<span><i style="background:var(--sb-keep)"></i>Kept ${esc(dur(kept))}</span>`, ...Object.entries(cut).filter(([, s]) => s > 0).map(([k, s]) => `<span><i style="background:var(--sb-${k})"></i>${REASONS[k]} ${esc(dur(s))}</span>`)].join('');
  return `<div class="sb-strip" role="group" aria-label="Edit plan">${bars}</div>${ticks ? `<div class="sb-ticks" aria-hidden="true">${ticks}</div>` : ''}<div class="sb-legend">${legend}</div>`;
}

function copyBtn(text, label = 'Copy') { return text ? `<button type="button" class="sb-btn sb-btn-quiet sb-btn-sm" data-copy="${esc(text)}">${label}</button>` : ''; }

function sheetHtml(v, events, plan) {
  const id = encodeURIComponent(v.id);
  const total = Number(v.duration_s) || 0;
  const segs = planSegments(plan, total);
  const chapters = chaptersOf(plan, v);
  const title = plan?.title || plan?.titles?.[0] || v.title || '';
  const desc = plan?.description || '';
  const shorts = (Array.isArray(plan?.shorts) && plan.shorts.length ? plan.shorts : parse(v.shorts_json, [])) || [];
  const hasEdited = Boolean(v.edited_key || v.status === 'done' || v.status === 'delivering');
  const brain = BRAIN[v.plan_brain] || '';
  const failed = v.status === 'failed';
  const res = (w, h) => (h ? `${w || ''}${w ? '×' : ''}${h}` : '');
  const actions = state.guest ? '<p class="sb-muted" style="margin:0">This is a guest view, so changes are switched off.</p>' : `<div class="sb-actions">
      ${failed || v.status === 'skipped' ? '<button class="sb-btn sb-btn-primary" data-sheet="retry">Retry</button>' : ''}
      <button class="sb-btn sb-btn-quiet" data-sheet="reedit-open">Re-edit with notes</button>
      <button class="sb-btn sb-btn-danger" data-sheet="delete">Delete</button>
    </div>
    <div class="sb-reedit" hidden><textarea rows="3" maxlength="2000" placeholder="What should change, in plain words. For example: keep the story about the first clinic, cut the second retake of the close."></textarea>
      <div><button class="sb-btn sb-btn-primary" data-sheet="reedit">Re-edit with these notes</button></div></div>`;
  return `<div class="sb-sheet-bar"><div style="min-width:0"><p class="sb-eyebrow" style="margin:0 0 2px">${esc(STATUS_LABEL[v.status] || v.status)}${brain ? ` · planned by ${esc(brain)}` : ''}</p><h2 class="sb-h2" id="sb-sheet-title">${esc(v.title || 'Untitled recording')}</h2></div>
      <button class="sb-x" data-sheet="close" aria-label="Close">×</button></div>
    <div class="sb-sheet-body">
      ${failed && v.error ? `<div class="sb-note bad"><span>${esc(v.error)}</span></div>` : ''}
      <section><div class="sb-players">
        <div class="sb-player"><div class="sb-player-k"><span>Before</span><span>${esc([clock(total), res(v.width, v.height)].filter(Boolean).join(' · '))}</span></div>
          ${v.raw_key || v.status !== 'recording' ? `<video controls preload="metadata" playsinline src="${API}/videos/${id}/raw" poster="${API}/videos/${id}/thumb" data-raw></video>` : '<div class="sb-ph">The recording appears here once it is uploaded.</div>'}</div>
        <div class="sb-player"><div class="sb-player-k"><span>After</span><span>${esc(res(v.edited_width, v.edited_height))}</span></div>
          ${hasEdited ? (v.stream && v.stream.ready && v.stream.iframe ? `<iframe src="${esc(v.stream.iframe)}" style="border:0;width:100%;aspect-ratio:16/9;border-radius:12px;background:#000" allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen title="Edited video"></iframe>` : `<video controls preload="metadata" playsinline src="${API}/videos/${id}/preview"></video>${v.stream && !v.stream.ready && v.stream.state !== "error" ? '<p class="sb-muted" style="margin:6px 0 0">Preparing smooth playback in Cloudflare Stream.</p>' : ""}`) + `<a class="sb-link" style="display:inline-block;margin-top:6px" href="${API}/videos/${id}/edited?download=1">Download full quality</a>` : '<div class="sb-ph">The edited version appears here when it is rendered.</div>'}</div>
      </div></section>
      <section><p class="sb-sec-k"><span>The edit plan</span></p>${stripHtml(segs, chapters, total)}</section>
      <section class="sb-two">
        <div><p class="sb-sec-k"><span>Title</span>${copyBtn(title)}</p><div class="sb-copyable big">${esc(title || 'Written with the plan.')}</div>
          <p class="sb-sec-k" style="margin-top:24px"><span>Description</span>${copyBtn(desc)}</p><div class="sb-copyable">${esc(desc || 'Written with the plan.')}</div></div>
        <div><p class="sb-sec-k"><span>Chapters</span>${copyBtn(chapters.map((c) => `${clock(c.t)} ${c.label}`).join('\n'))}</p>
          ${chapters.length ? `<ul class="sb-lines">${chapters.map((c) => `<li><span class="t">${clock(c.t)}</span><span>${esc(c.label)}</span></li>`).join('')}</ul>` : '<p class="sb-muted" style="margin:0">Chapters come with the plan.</p>'}
          <p class="sb-sec-k" style="margin-top:24px"><span>Shorts</span></p>
          ${shorts.length ? `<ul class="sb-lines">${shorts.map((s) => { const a = num(s.start ?? s.from ?? s.s), b = num(s.end ?? s.to ?? s.e); const link = s.drive_link || s.link || s.url; return `<li><span class="t">${isFinite(a) ? clock(a) : ''}</span><span style="flex:1">${esc(s.title || s.hook || 'Short')}${isFinite(a) && isFinite(b) ? ` <span class="sb-muted">· ${esc(dur(b - a))}</span>` : ''}</span>${link ? `<a class="sb-link" href="${esc(link)}" target="_blank" rel="noopener">Open</a>` : ''}</li>`; }).join('')}</ul>` : '<p class="sb-muted" style="margin:0">Shorts come with the plan.</p>'}
        </div>
      </section>
      <section class="sb-two">
        <div><p class="sb-sec-k"><span>In Google Drive</span></p><ul class="sb-lines">
          <li><span style="flex:1">The recording</span>${v.drive_raw_link ? `<a class="sb-link" href="${esc(v.drive_raw_link)}" target="_blank" rel="noopener">Open in Drive</a>` : '<span class="sb-muted">Not in Drive yet</span>'}</li>
          <li><span style="flex:1">The edited version</span>${v.drive_edited_link ? `<a class="sb-link" href="${esc(v.drive_edited_link)}" target="_blank" rel="noopener">Open in Drive</a>` : '<span class="sb-muted">Not delivered yet</span>'}</li>
        </ul>
        <p class="sb-sec-k" style="margin-top:24px"><span>Actions</span></p>${actions}</div>
        <div><p class="sb-sec-k"><span>What happened</span></p>
          ${events.length ? `<ul class="sb-lines sb-events">${events.slice().reverse().map((e) => `<li><span class="t">${esc(when(e.at).split(', ').pop())}</span><span class="s">${esc((STAGES.find((s) => s.st.includes(e.stage)) || {}).label || STATUS_LABEL[e.stage] || e.stage || '')}</span><span>${esc(e.message)}</span></li>`).join('')}</ul>` : '<p class="sb-muted" style="margin:0">Nothing yet.</p>'}</div>
      </section>
    </div>`;
}

let sheetWrap = null, lastFocus = null;
function closeSheet() {
  if (!sheetWrap) return;
  const w = sheetWrap; sheetWrap = null; state.open = null;
  w.querySelectorAll('video').forEach((x) => { try { x.pause(); } catch { /* ignore */ } });
  w.classList.remove('on');
  setTimeout(() => w.remove(), 280);
  document.removeEventListener('keydown', onKey);
  lastFocus?.focus?.();
}
function onKey(e) { if (e.key === 'Escape') closeSheet(); }
async function openSheet(vid) {
  lastFocus = document.activeElement;
  state.open = vid;
  if (!sheetWrap) {
    sheetWrap = document.createElement('div');
    sheetWrap.className = 'sb-sheet-wrap';
    sheetWrap.innerHTML = '<div class="sb-sheet" role="dialog" aria-modal="true" aria-labelledby="sb-sheet-title"><div class="sb-sheet-body"><p class="sb-muted">Opening…</p></div></div>';
    document.body.appendChild(sheetWrap);
    requestAnimationFrame(() => sheetWrap?.classList.add('on'));
    sheetWrap.addEventListener('click', onSheetClick);
    document.addEventListener('keydown', onKey);
  }
  try {
    const d = await api(`/videos/${encodeURIComponent(vid)}`);
    const v = d.video || d;
    const events = sortEvents(d.events || v.events || []);
    const plan = d.plan || v.plan || parse(v.plan_json, null);
    if (!sheetWrap || state.open !== vid) return;
    sheetWrap.firstElementChild.innerHTML = sheetHtml(v, events, plan);
    sheetWrap.firstElementChild.querySelector('.sb-x')?.focus();
  } catch (e) {
    if (sheetWrap) sheetWrap.firstElementChild.innerHTML = `<div class="sb-sheet-bar"><h2 class="sb-h2" id="sb-sheet-title">Could not open this video</h2><button class="sb-x" data-sheet="close" aria-label="Close">×</button></div><div class="sb-sheet-body"><p class="sb-muted">${esc(e.message)}</p></div>`;
  }
}
async function onSheetClick(e) {
  if (e.target === sheetWrap) return closeSheet();
  const seek = e.target.closest('[data-seek]');
  if (seek) { const raw = sheetWrap.querySelector('video[data-raw]'); if (raw) { raw.currentTime = Number(seek.dataset.seek) || 0; raw.play?.().catch(() => {}); } return; }
  const cp = e.target.closest('[data-copy]');
  if (cp) { try { await navigator.clipboard.writeText(cp.dataset.copy); toast('Copied'); } catch { toast('Copy did not work in this browser'); } return; }
  const b = e.target.closest('[data-sheet]');
  if (!b) return;
  const id = state.open;
  const act = b.dataset.sheet;
  if (act === 'close') return closeSheet();
  if (act === 'reedit-open') { const box = sheetWrap.querySelector('.sb-reedit'); box.hidden = !box.hidden; if (!box.hidden) box.querySelector('textarea').focus(); return; }
  if (act === 'delete' && !b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Delete for good'; setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = 'Delete'; } }, 4000); return; }
  b.disabled = true;
  try {
    if (act === 'retry') { await api(`/videos/${encodeURIComponent(id)}/retry`, { method: 'POST', body: '{}' }); toast('Started again'); }
    if (act === 'reedit') { const notes = sheetWrap.querySelector('.sb-reedit textarea').value.trim(); await api(`/videos/${encodeURIComponent(id)}/reedit`, { method: 'POST', body: JSON.stringify({ notes }) }); toast('Re-editing with your notes'); }
    if (act === 'delete') { await api(`/videos/${encodeURIComponent(id)}`, { method: 'DELETE' }); toast('Deleted'); closeSheet(); }
    if (act !== 'delete') openSheet(id);
    refresh();
  } catch (err) { toast(err.message); b.disabled = false; }
}

// ───────────── start ─────────────
if (root) {
  shell();
  window.__studioWho.then((w) => { state.guest = Boolean(w && w.guest); render(); });
  refresh().then(loop);
}
