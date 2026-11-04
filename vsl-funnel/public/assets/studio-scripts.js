// G&L Studio, builder C: the Scripts view (#studio-scripts).
// One button, one face-cam shooting script: a topic (or a YouTube idea), a format, a viewer and a framework go to
// POST /admin/api/studio/scripts; the script comes back as three hooks, beats with a layout each, on-screen text, what
// to show on the screen, titles, thumbnail text, description and the CTA. "Record this" hands the beats to the
// recorder: window event `studio:use-script` {id, title, beats} and window.studio.show('record').
// Guests can read every saved script; only the owner can write or delete one.

const API = '/admin/api/studio/scripts';
const root = document.getElementById('studio-scripts');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const LAYOUT_NAME = { cinema: 'Cinema', spotlight: 'Spotlight', orbit: 'Orbit', stage: 'Stage', split: 'Split', vertical: 'Vertical' };
const FALLBACK_OPTIONS = {
  brain: null,
  formats: [{ id: 'long', label: 'Long YouTube', sub: '8 to 12 minutes' }, { id: 'short', label: 'Short', sub: '45 seconds' }, { id: 'vsl', label: 'VSL segment', sub: '2 to 4 minutes' }, { id: 'webinar', label: 'Webinar teaser', sub: '60 to 90 seconds' }, { id: 'email', label: 'Email-to-video', sub: '60 to 120 seconds' }],
  icps: [], frameworks: [], auto: {}, ideas: [],
};

/** A small drawing of each face-cam layout: the frame, the face, the screen. */
function glyph(layout) {
  const face = (cx, cy, r) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="currentColor"/>`;
  const lines = (x, y, w, n = 3) => Array.from({ length: n }, (_, i) => `<rect x="${x}" y="${y + i * 4}" width="${i === n - 1 ? w * 0.6 : w}" height="1.6" rx=".8" fill="currentColor" opacity=".45"/>`).join('');
  if (layout === 'vertical') return `<svg class="sb-glyph v" viewBox="0 0 22 34" aria-hidden="true"><rect x="1" y="1" width="20" height="32" rx="3.5" fill="none" stroke="currentColor" stroke-width="1.5"/>${lines(5, 6, 12)}${face(11, 24, 4.5)}</svg>`;
  const frame = '<rect x="1" y="1" width="42" height="28" rx="4" fill="none" stroke="currentColor" stroke-width="1.5"/>';
  const body = {
    cinema: `<rect x="1" y="1" width="42" height="28" rx="4" fill="currentColor" opacity=".12"/>${face(22, 13, 6)}<rect x="12" y="23" width="20" height="2" rx="1" fill="currentColor" opacity=".6"/>`,
    spotlight: `${face(22, 12, 6.5)}<path d="M10 29c1.5-6 6.5-9 12-9s10.5 3 12 9" fill="currentColor" opacity=".55"/>`,
    orbit: `${lines(6, 7, 22)}<circle cx="34" cy="20" r="6" fill="currentColor"/><circle cx="34" cy="20" r="7.6" fill="none" stroke="currentColor" stroke-width="1" opacity=".5"/>`,
    stage: `${lines(6, 6, 32, 4)}<rect x="31" y="20" width="9" height="6" rx="1.5" fill="currentColor"/>`,
    split: `<line x1="22" y1="2" x2="22" y2="28" stroke="currentColor" stroke-width="1" opacity=".4"/>${face(12, 13, 5)}<path d="M5 28c1-4 3.8-6 7-6s6 2 7 6" fill="currentColor" opacity=".55"/>${lines(26, 9, 13)}`,
  }[layout] || face(22, 15, 6);
  return `<svg class="sb-glyph" viewBox="0 0 44 30" aria-hidden="true">${frame}${body}</svg>`;
}
const mmss = (sec) => { sec = Math.max(0, Math.round(sec || 0)); const m = Math.floor(sec / 60), s = sec % 60; return m ? `${m} min${s ? ` ${s} s` : ''}` : `${s} s`; };
const dateOf = (t) => { const d = new Date(t); return isNaN(d) ? '' : d.toLocaleDateString([], { day: 'numeric', month: 'short' }); };
const fieldName = (p) => p.replace(/^beats\[(\d+)\]\.text$/, (_, i) => `Beat ${+i + 1}`).replace(/^beats\[(\d+)\]\.on_screen$/, (_, i) => `Beat ${+i + 1}, on screen`).replace(/^hooks\[(\d+)\]$/, (_, i) => `Hook ${+i + 1}`).replace(/^titles\[(\d+)\]$/, (_, i) => `Title ${+i + 1}`).replace(/^(\w)/, (c) => c.toUpperCase());

let opts = FALLBACK_OPTIONS;
let guest = false;
let form = { topic: '', idea: '', format: 'long', icp: 'trapped', framework: 'auto' };
let saved = [];
let current = null; // the full script row
let chosenHook = 0;
let busy = null; // { started }

async function api(path = '', init = {}) {
  const r = await fetch(API + path, { credentials: 'same-origin', ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || (r.status === 403 ? 'Only the owner can do that.' : `Something went wrong (${r.status}).`));
  return j;
}
function toast(msg) {
  let t = document.querySelector('.sb-toast');
  if (!t) { t = document.createElement('div'); t.className = 'sb-toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), 2600);
}
const remember = (id) => { try { localStorage.setItem('studio:script', id || ''); } catch { /* private mode */ } };
const remembered = () => { try { return localStorage.getItem('studio:script') || ''; } catch { return ''; } };

// ───────────── the composer ─────────────
function optButtons(name, list, value, withSub = false) {
  return list.map((o) => `<button type="button" class="sb-opt" data-set="${name}" data-v="${esc(o.id)}" aria-pressed="${o.id === value}" ${guest ? 'disabled' : ''}>${esc(o.label)}${withSub && o.sub ? `<small>${esc(o.sub)}</small>` : ''}</button>`).join('');
}
function frameworkHint() {
  const fw = opts.frameworks.find((f) => f.id === form.framework);
  if (form.framework !== 'auto') return fw ? esc(fw.sub) : '';
  const auto = opts.auto?.[form.format]?.[form.icp];
  const pickedFw = opts.frameworks.find((f) => f.id === auto);
  const fmt = opts.formats.find((f) => f.id === form.format);
  const icp = opts.icps.find((f) => f.id === form.icp);
  return pickedFw ? `Auto picks <b>${esc(pickedFw.label)}</b> for ${esc(fmt?.label || 'this format')} and the ${esc(icp?.label || 'viewer')}.` : '';
}
function brainLine() {
  if (opts.brain === 'claude') return 'Written by Claude with the house copy rules. A long script takes about a minute.';
  if (opts.brain === 'workers-ai') return 'Written by Workers AI. Add the Anthropic key in <a class="sb-link" href="/admin#integrations">Integrations</a> to have Claude write them.';
  return 'No writer is available here yet. Add the Anthropic key in <a class="sb-link" href="/admin#integrations">Integrations</a>.';
}
function composeHtml() {
  const ideas = opts.ideas || [];
  const goLabel = busy ? `<span class="sb-writing"><i class="sb-spin"></i><span data-elapsed>Writing…</span></span>` : 'Write the script';
  return `<div class="sb-card sb-compose">
    <div><p class="sb-eyebrow">Scripts</p><h1 class="sb-h1" style="font-size:28px">One click, ready to shoot.</h1>
      <p class="sb-sub" style="font-size:14px">Every script is written for the face-cam format, beat by beat, in the house copy style.</p></div>
    ${guest ? '<div class="sb-note"><span>Guests can read every script. Only the owner can write new ones.</span></div>' : ''}
    <div class="sb-field"><label for="sb-topic">What is the video about</label>
      <textarea id="sb-topic" rows="3" maxlength="600" placeholder="For example: why banks say no to first-time buyers, and the order that gets a deal funded" ${guest ? 'disabled' : ''}>${esc(form.topic)}</textarea></div>
    ${ideas.length ? `<p class="sb-or">or</p><div class="sb-field"><label for="sb-idea">Start from a YouTube idea</label>
      <select id="sb-idea" ${guest ? 'disabled' : ''}><option value="">Choose an idea</option>${ideas.map((i) => `<option value="${esc(i.ref)}" ${i.ref === form.idea ? 'selected' : ''}>${esc(i.title)}${i.pack ? ' (pack written)' : ''}</option>`).join('')}</select></div>` : ''}
    <div class="sb-field"><span class="sb-fl">Format</span><div class="sb-seg-ctl">${optButtons('format', opts.formats, form.format, true)}</div></div>
    ${opts.icps.length ? `<div class="sb-field"><span class="sb-fl">Who it is for</span><div class="sb-seg-ctl">${optButtons('icp', opts.icps, form.icp)}</div></div>` : ''}
    ${opts.frameworks.length ? `<div class="sb-field"><span class="sb-fl">Framework</span><div class="sb-seg-ctl">${optButtons('framework', opts.frameworks, form.framework)}</div><div class="sb-hint">${frameworkHint()}</div></div>` : ''}
    ${guest ? '' : `<button class="sb-btn sb-btn-primary sb-go" data-act="write" ${busy || !opts.brain ? 'disabled' : ''}>${goLabel}</button>`}
    <p class="sb-hint" style="margin:-8px 0 0">${brainLine()}</p>
    <div class="sb-saved"><p class="sb-eyebrow" style="margin-bottom:4px">Saved scripts</p>
      ${saved.length ? `<ul class="sb-lines" style="border:0">${saved.map((s) => `<li data-open="${esc(s.id)}" aria-current="${current?.id === s.id}" tabindex="0"><div><div class="tt">${esc(s.title || s.topic)}</div><div class="mm">${esc([labelOf('formats', s.format), mmss(s.est_seconds), labelOf('frameworks', s.framework), dateOf(s.created_at)].filter(Boolean).join(' · '))}${s.flags ? ` · <span style="color:var(--sb-warn)">${s.flags} to check</span>` : ''}</div></div></li>`).join('')}</ul>` : '<p class="sb-muted" style="font-size:14px;margin:4px 0 0">Scripts you write are kept here.</p>'}
    </div>
  </div>`;
}
const labelOf = (k, id) => (opts[k] || []).find((o) => o.id === id)?.label || '';

// ───────────── the shooting script ─────────────
function blankHtml() {
  return `<div class="sb-script sb-blank"><div class="sb-glyphs">${['cinema', 'spotlight', 'orbit', 'split', 'stage', 'vertical'].map(glyph).join('')}</div>
    <h2 class="sb-h2" style="font-size:26px">Your shooting script appears here.</h2>
    <p class="sb-sub" style="margin:0 auto">Three hooks, every beat with its face-cam layout, what to say, what to show, and the packaging. Then press Record this.</p></div>`;
}
function scriptHtml(row) {
  const s = row.script;
  const hooks = s.hooks || [];
  const flags = row.flags || [];
  const meta = [labelOf('formats', row.format), mmss(s.est_seconds), `${s.beats.length} beats`, labelOf('frameworks', row.framework), labelOf('icps', row.icp)].filter(Boolean);
  return `<article class="sb-script" aria-labelledby="sb-script-title">
    <div class="sb-script-top"><div class="sb-script-meta">${meta.map((m) => `<span class="sb-chip">${esc(m)}</span>`).join('')}<span class="sb-chip live">${row.brain === 'claude' ? 'Claude' : 'Workers AI'}</span></div>${guest ? '' : '<button type="button" class="sb-del" data-act="delete">Delete</button>'}</div>
    <h2 id="sb-script-title">${esc(s.titles?.[0] || row.topic)}</h2>
    <p class="sb-topic">${esc(row.topic)}</p>
    ${flags.length ? `<div class="sb-note warn sb-flags" style="display:block"><strong>The copy check still flags ${flags.length === 1 ? 'one line' : `${flags.length} lines`}.</strong> Say ${flags.length === 1 ? 'it' : 'them'} in your own words before recording.
      <ul>${flags.slice(0, 8).map((f) => `<li>${esc(fieldName(f.path))}: ${esc(f.rule)}</li>`).join('')}</ul></div>` : ''}
    <p class="sb-eyebrow">Open with one of these</p>
    <div class="sb-hooks" role="radiogroup" aria-label="Hook">${hooks.map((h, i) => `<button type="button" class="sb-hook" role="radio" aria-pressed="${i === chosenHook}" aria-checked="${i === chosenHook}" data-hook="${i}"><q>${esc(h)}</q><span class="sb-chip live">Opening</span></button>`).join('')}</div>
    <p class="sb-eyebrow">The beats</p>
    <ol class="sb-beats">${s.beats.map((b, i) => `<li class="sb-beat">
      <div class="sb-beat-l"><span class="sb-beat-n">${String(i + 1).padStart(2, '0')}</span>${glyph(b.layout)}<span class="sb-lay">${esc(LAYOUT_NAME[b.layout] || b.layout)}</span></div>
      <div><p class="sb-say">${esc(i === 0 ? withHook(s, b.text) : b.text)}</p>
        ${b.cue ? `<p class="sb-cue">${esc(b.cue)}</p>` : ''}
        ${b.on_screen || b.screen ? `<div class="sb-show">${b.on_screen ? `<span><b>On screen</b> <span class="sb-ost">${esc(b.on_screen)}</span></span>` : ''}${b.screen ? `<span><b>Show</b> ${esc(b.screen)}</span>` : ''}</div>` : ''}</div>
    </li>`).join('')}</ol>
    <section class="sb-pack">
      <div><p class="sb-sec-k"><span>Titles</span>${copy((s.titles || []).join('\n'))}</p><ul class="sb-lines">${(s.titles || []).map((t) => `<li><span style="font-weight:600">${esc(t)}</span></li>`).join('')}</ul>
        <p class="sb-sec-k" style="margin-top:24px"><span>Call to action</span></p><p style="margin:0;font-size:15px;line-height:1.5">${esc(s.cta)}</p></div>
      <div><p class="sb-sec-k"><span>Thumbnail text</span></p><div class="sb-thumbcard">${esc(s.thumbnail || '')}</div>
        <p class="sb-sec-k" style="margin-top:24px"><span>Description</span>${copy(s.description)}</p><div class="sb-copyable" style="font-size:13px">${esc(s.description)}</div></div>
    </section>
    <div class="sb-record">
      <span class="sb-muted" style="font-size:13px">About ${esc(mmss(s.est_seconds))} at a steady pace</span>
      <span style="display:flex;gap:8px"><button type="button" class="sb-btn sb-btn-quiet" data-act="copy-all">Copy script</button>${guest ? '' : '<button type="button" class="sb-btn sb-btn-primary" data-act="record">Record this</button>'}</span>
    </div>
  </article>`;
}
const copy = (text) => (text ? `<button type="button" class="sb-btn sb-btn-quiet sb-btn-sm" data-copy="${esc(text)}">Copy</button>` : '');
/** Beat 1 opens with the chosen hook: swap the original hook for the one picked, or lead with it. */
function withHook(s, text) {
  const pick = s.hooks?.[chosenHook];
  if (!pick || chosenHook === s.hook_index) return text;
  const orig = s.hooks?.[s.hook_index] || s.hook || '';
  return orig && text.includes(orig) ? text.replace(orig, pick) : `${pick}\n${text}`;
}
function beatsForRecorder(row) {
  return row.script.beats.map((b, i) => ({ layout: b.layout, text: i === 0 ? withHook(row.script, b.text) : b.text, cue: b.cue || undefined, on_screen: b.on_screen || undefined, screen: b.screen || undefined }));
}
function plainScript(row) {
  const s = row.script;
  return [s.titles?.[0] || row.topic, '', ...beatsForRecorder(row).map((b, i) => `${i + 1}. [${LAYOUT_NAME[b.layout]}] ${b.text}${b.cue ? `\n   (${b.cue})` : ''}${b.on_screen ? `\n   On screen: ${b.on_screen}` : ''}${b.screen ? `\n   Show: ${b.screen}` : ''}`), '', `CTA: ${s.cta}`].join('\n');
}

// ───────────── render and events ─────────────
function render() {
  const focus = document.activeElement?.id;
  root.innerHTML = `<div class="sb-wrap"><div class="sb-scripts">${composeHtml()}<div class="sb-out">${current ? scriptHtml(current) : blankHtml()}</div></div></div>`;
  if (focus) document.getElementById(focus)?.focus();
}
async function loadList() { try { saved = (await api('')).scripts || []; } catch { saved = []; } }
async function openScript(id) {
  try {
    current = (await api(`/${encodeURIComponent(id)}`)).script;
    chosenHook = current.script.hook_index || 0;
    remember(id);
    render();
    if (matchMedia('(max-width: 900px)').matches) root.querySelector('.sb-out')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) { toast(e.message); }
}
async function write() {
  if (busy) return;
  form.topic = root.querySelector('#sb-topic')?.value.trim() || '';
  if (!form.topic && !form.idea) { toast('Write a topic, or pick a YouTube idea.'); root.querySelector('#sb-topic')?.focus(); return; }
  busy = { started: Date.now() };
  render();
  const tick = setInterval(() => { const el = root.querySelector('[data-elapsed]'); if (el && busy) { const s = Math.round((Date.now() - busy.started) / 1000); el.textContent = `Writing… ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; } }, 1000);
  try {
    const r = await api('', { method: 'POST', body: JSON.stringify({ topic: form.topic, idea: form.idea || undefined, format: form.format, icp: form.icp, framework: form.framework }) });
    current = r.script;
    chosenHook = current.script.hook_index || 0;
    remember(current.id);
    await loadList();
  } catch (e) { toast(e.message); }
  finally { clearInterval(tick); busy = null; render(); }
}

root?.addEventListener('click', async (e) => {
  const set = e.target.closest('[data-set]');
  if (set && !set.disabled) { form.topic = root.querySelector('#sb-topic')?.value || form.topic; form[set.dataset.set] = set.dataset.v; render(); return; }
  const hook = e.target.closest('[data-hook]');
  if (hook) { if (guest) return; chosenHook = Number(hook.dataset.hook); render(); return; }
  const open = e.target.closest('[data-open]');
  if (open) return openScript(open.dataset.open);
  const cp = e.target.closest('[data-copy]');
  if (cp) { try { await navigator.clipboard.writeText(cp.dataset.copy); toast('Copied'); } catch { toast('Copy did not work in this browser'); } return; }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'write') return write();
  if (act === 'copy-all' && current) { try { await navigator.clipboard.writeText(plainScript(current)); toast('Script copied'); } catch { toast('Copy did not work in this browser'); } return; }
  if (act === 'record' && current) {
    window.dispatchEvent(new CustomEvent('studio:use-script', { detail: { id: current.id, title: current.script.titles?.[0] || current.topic, beats: beatsForRecorder(current) } }));
    window.studio?.show?.('record');
    return;
  }
  if (act === 'delete' && current) {
    const b = e.target.closest('[data-act]');
    if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Delete for good'; setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = 'Delete'; } }, 4000); return; }
    try { await api(`/${encodeURIComponent(current.id)}`, { method: 'DELETE' }); current = null; remember(''); await loadList(); render(); toast('Deleted'); } catch (err) { toast(err.message); }
  }
});
root?.addEventListener('keydown', (e) => { const li = e.target.closest('[data-open]'); if (li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openScript(li.dataset.open); } });
root?.addEventListener('change', (e) => {
  if (e.target.id === 'sb-idea') {
    form.idea = e.target.value;
    const idea = (opts.ideas || []).find((i) => i.ref === form.idea);
    const ta = root.querySelector('#sb-topic');
    if (idea && ta && !ta.value.trim()) { ta.value = idea.topic; form.topic = idea.topic; }
  }
});
root?.addEventListener('input', (e) => { if (e.target.id === 'sb-topic') form.topic = e.target.value; });

async function start() {
  render();
  const who = await (window.__studioWho = window.__studioWho || fetch('/admin/api/whoami', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({})));
  guest = Boolean(who && who.guest);
  try { opts = { ...FALLBACK_OPTIONS, ...(await api('/options')) }; } catch { opts = FALLBACK_OPTIONS; }
  await loadList();
  const last = remembered();
  if (last && saved.some((s) => s.id === last)) await openScript(last);
  else if (saved[0]) await openScript(saved[0].id);
  else render();
}
// Radar's "Make it a script" opens the new script here.
window.addEventListener('studio:open-script', async (e) => { const id = e.detail?.id; if (!id) return; await loadList(); await openScript(id); });
if (root) start();
