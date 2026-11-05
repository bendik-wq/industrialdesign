// G&L Studio → Radar → Brain (#studio-brain): what the brain knows (Bendik's copy legends, persuasion, VSL and
// webinar playbooks, G&L notes), loaded at deploy into D1 and Vectorize (src/brain). A search box over the brain,
// the legends as cards with their principles, a small graph of the selected page's neighbourhood (plain SVG) and
// the load status. Mounts into #studio-brain whenever that section appears (the Radar view may re-render it).
// Guests see everything but the button that spends (embedding).

const API = '/admin/api/brain';
// The panel brings its own stylesheet, so the host page only needs the section and this module.
if (!document.querySelector('link[href="/assets/studio-brain.css"]')) {
  const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/assets/studio-brain.css'; document.head.appendChild(l);
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const SCOPES = [['copy', 'Copy'], ['gl', 'G&L'], ['all', 'All']];
const KIND = { principle: 'Principle', technique: 'Technique', example: 'Example', fact: 'Fact', rule: 'Rule' };
const day = (t) => { const d = new Date(t); return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };

const S = { status: null, cards: null, q: '', scope: 'copy', hits: null, searching: false, page: null, pageId: null, guest: false, busy: false, error: '', open: {} };
try { const sc = localStorage.getItem('brain:scope'); if (SCOPES.some(([k]) => k === sc)) S.scope = sc; } catch { /* private mode */ }

let root = null;
let started = false;

async function api(path, init = {}) {
  const r = await fetch(API + path, { credentials: 'same-origin', ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false && !('embedded' in j)) throw new Error(j.error || (r.status === 403 ? 'Only the owner can do that.' : `Something went wrong (${r.status}).`));
  return j;
}

// ───────────── the graph view: the page in the middle, its neighbours on a ring ─────────────
function graphSvg(g) {
  if (!g || !g.nodes || g.nodes.length < 2) return '<p class="br-fine">No linked pages yet.</p>';
  const W = 560, H = 360, cx = W / 2, cy = H / 2, R = 132;
  const others = g.nodes.filter((n) => n.id !== g.center).sort((a, b) => String(a.folder).localeCompare(String(b.folder)) || String(a.title).localeCompare(String(b.title)));
  const maxPr = Math.max(...g.nodes.map((n) => Number(n.pagerank) || 0), 1e-9);
  const pos = new Map([[g.center, { x: cx, y: cy }]]);
  others.forEach((n, i) => { const a = (i / others.length) * Math.PI * 2 - Math.PI / 2; pos.set(n.id, { x: cx + Math.cos(a) * R * 1.1, y: cy + Math.sin(a) * R }); });
  const edges = (g.edges || []).filter((e) => pos.has(e.src) && pos.has(e.dst)).map((e) => {
    const a = pos.get(e.src), b = pos.get(e.dst);
    const touch = e.src === g.center || e.dst === g.center;
    return `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" class="br-e${touch ? ' on' : ''}${e.type === 'sibling' ? ' sib' : ''}"/>`;
  }).join('');
  const nodes = g.nodes.map((n) => {
    const p = pos.get(n.id); if (!p) return '';
    const c = n.id === g.center;
    const r = c ? 11 : 5 + 6 * Math.sqrt((Number(n.pagerank) || 0) / maxPr);
    const label = String(n.title || n.id).replace(/\s*\(.*$/, '');
    const short = label.length > 22 ? label.slice(0, 21) + '…' : label;
    const anchor = c ? 'middle' : p.x < cx - 4 ? 'end' : p.x > cx + 4 ? 'start' : 'middle';
    const dx = c ? 0 : anchor === 'end' ? -(r + 6) : anchor === 'start' ? r + 6 : 0;
    const dy = c ? r + 16 : anchor === 'middle' ? (p.y < cy ? -(r + 6) : r + 14) : 4;
    return `<g class="br-n${c ? ' c' : ''}${n.legend ? ' lg' : ''}" data-node="${esc(n.id)}" tabindex="0" role="button" aria-label="${esc(label)}">
      <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r.toFixed(1)}"/><text x="${(p.x + dx).toFixed(1)}" y="${(p.y + dy).toFixed(1)}" text-anchor="${anchor}">${esc(short)}</text><title>${esc(n.title)}${n.folder ? ' · ' + esc(n.folder) : ''}</title></g>`;
  }).join('');
  return `<svg class="br-graph" viewBox="0 0 ${W} ${H}" role="img" aria-label="Pages linked to this one">${edges}${nodes}</svg>`;
}

// ───────────── render ─────────────
function statusLine() {
  const s = S.status;
  if (!s) return '<p class="br-fine">Loading the brain</p>';
  if (!s.loaded) return `<p class="br-line">${esc(s.note || 'The brain is not loaded here yet.')}</p>`;
  const parts = [`${s.pages} pages`, `${s.chunks} sections`, `${s.legends} legends`, `${s.embedded_pct}% embedded`];
  const build = s.build ? `Built ${esc(day(s.build.built_at))}${s.build.source ? ` from ${esc(s.build.source)}` : ''}.` : '';
  const err = s.embed && s.embed.last_error ? ` <span class="br-warn">${esc(s.embed.last_error)}</span>` : '';
  const btn = !S.guest && s.pending > 0 && s.vectors ? `<button type="button" class="br-btn br-btn-sm" data-embed${S.busy ? ' disabled' : ''}>${S.busy ? 'Embedding' : 'Embed the next batch'}</button>` : '';
  const left = s.pending > 0 ? ` ${s.pending} sections wait for embedding${s.embed ? '; the cron finishes them every few minutes' : ''}.` : '';
  return `<div class="br-status"><p class="br-stats">${parts.map((p) => `<span>${esc(p)}</span>`).join('')}</p><p class="br-fine">${build}${left}${err}</p>${btn}</div>`;
}

function resultsHtml() {
  if (S.searching) return '<p class="br-fine">Searching</p>';
  if (!S.hits) return '';
  if (!S.hits.length) return `<p class="br-empty">Nothing in the brain matches "${esc(S.q)}".</p>`;
  return `<ol class="br-hits">${S.hits.map((h) => `<li><button type="button" class="br-hit${S.pageId === h.page ? ' on' : ''}" data-page="${esc(h.page)}">
    <span class="br-hit-top"><strong>${esc(h.title)}</strong>${h.legend ? `<span class="br-tag">${esc(h.legend)}</span>` : ''}${h.kind ? `<span class="br-kind">${esc(KIND[h.kind] || h.kind)}</span>` : ''}</span>
    ${h.section ? `<span class="br-sec">${esc(h.section)}</span>` : ''}<span class="br-snip">${esc(h.snippet)}</span></button></li>`).join('')}</ol>`;
}

function cardsHtml() {
  if (!S.cards) return '<p class="br-fine">Loading the legends</p>';
  if (!S.cards.length) return '';
  return `<div class="br-grid">${S.cards.map((c) => `<button type="button" class="br-card${S.pageId === c.id ? ' on' : ''}" data-page="${esc(c.id || '')}">
    <span class="br-card-h">${esc(c.legend)}</span>
    ${c.principles.length ? `<span class="br-card-l">Principles</span><ul>${c.principles.slice(0, 3).map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
    ${c.techniques.length ? `<span class="br-card-l">Techniques</span><ul>${c.techniques.slice(0, 2).map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
  </button>`).join('')}</div>`;
}

function pageHtml() {
  if (!S.pageId) return '';
  if (!S.page) return '<aside class="br-page"><p class="br-fine">Opening the page</p></aside>';
  const p = S.page.page;
  return `<aside class="br-page" aria-label="${esc(p.title)}">
    <div class="br-page-h"><div><p class="br-eyebrow">${esc(p.folder)}</p><h3>${esc(p.title)}</h3></div><button type="button" class="br-x" data-close aria-label="Close the page"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg></button></div>
    ${graphSvg(S.page.graph)}
    <ul class="br-secs">${S.page.chunks.map((c) => {
      const open = S.open[c.id];
      const text = String(c.text || '').replace(/\*+/g, '');
      return `<li><div class="br-sec-h"><span>${esc(c.heading || 'Summary')}</span><span class="br-kind">${esc(KIND[c.kind] || c.kind)}</span>${c.verified ? '' : '<span class="br-warn">has unverified lines</span>'}</div>
      <p class="br-sec-t">${esc(open || text.length < 420 ? text : text.slice(0, 400) + '…')}</p>${text.length >= 420 ? `<button type="button" class="br-link" data-more="${esc(c.id)}">${open ? 'Show less' : 'Show all'}</button>` : ''}</li>`;
    }).join('')}</ul>
  </aside>`;
}

function render() {
  if (!root) return;
  const focus = document.activeElement && document.activeElement.id === 'br-q';
  const caret = focus ? document.activeElement.selectionStart : null;
  root.innerHTML = `<div class="br-wrap">
    <header class="br-head"><div><p class="br-eyebrow">Brain</p><h2 class="br-h">What the brain knows</h2></div>${statusLine()}</header>
    ${S.error ? `<p class="br-line br-bad" role="alert">${esc(S.error)}</p>` : ''}
    <form class="br-search" role="search" data-search>
      <label class="sr" for="br-q">Search the brain</label>
      <input id="br-q" type="search" placeholder="Search hooks, legends, structures, G&L" value="${esc(S.q)}" autocomplete="off"${S.status && !S.status.loaded ? ' disabled' : ''}>
      <div class="br-seg" role="radiogroup" aria-label="Where to search">${SCOPES.map(([k, l]) => `<button type="button" role="radio" aria-checked="${S.scope === k}" data-scope="${k}">${esc(l)}</button>`).join('')}</div>
    </form>
    <div class="br-body${S.pageId ? ' has-page' : ''}">
      <section class="br-main">${resultsHtml()}<h3 class="br-sub">Legends</h3>${cardsHtml()}</section>
      ${pageHtml()}
    </div>
  </div>`;
  if (focus) { const i = root.querySelector('#br-q'); i.focus(); if (caret != null) i.setSelectionRange(caret, caret); }
}

// ───────────── data ─────────────
async function loadStatus() { try { S.status = await api('/status'); } catch (e) { S.error = e.message; } }
async function loadCards() { try { S.cards = (await api('/legends')).cards || []; } catch (e) { S.cards = []; S.error = e.message; } }
let seq = 0;
async function search() {
  const q = S.q.trim();
  if (!q) { S.hits = null; render(); return; }
  const mine = ++seq;
  S.searching = true; render();
  try {
    const r = await api(`/search?${new URLSearchParams({ q, scope: S.scope, k: '10' })}`);
    if (mine !== seq) return;
    S.hits = r.hits || []; S.error = '';
  } catch (e) { if (mine === seq) S.error = e.message; }
  if (mine === seq) { S.searching = false; render(); }
}
async function openPage(id) {
  if (!id) return;
  S.pageId = id; S.page = null; S.open = {}; render();
  try { S.page = await api(`/page/${encodeURIComponent(id)}`); } catch (e) { S.error = e.message; S.pageId = null; }
  render();
  root?.querySelector('.br-page')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ───────────── events (delegated on the section) ─────────────
let typing = null;
function wire(el) {
  el.addEventListener('input', (e) => {
    if (e.target.id !== 'br-q') return;
    S.q = e.target.value;
    clearTimeout(typing); typing = setTimeout(search, 250);
  });
  el.addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(typing); search(); });
  el.addEventListener('click', async (e) => {
    const t = e.target.closest('button, [data-node]');
    if (!t) return;
    if (t.dataset.scope) { S.scope = t.dataset.scope; try { localStorage.setItem('brain:scope', S.scope); } catch { /* private mode */ } search(); render(); return; }
    if (t.dataset.page !== undefined) { openPage(t.dataset.page); return; }
    if (t.dataset.node) { openPage(t.dataset.node); return; }
    if (t.hasAttribute('data-close')) { S.pageId = null; S.page = null; render(); return; }
    if (t.dataset.more) { S.open[t.dataset.more] = !S.open[t.dataset.more]; render(); return; }
    if (t.hasAttribute('data-embed')) {
      S.busy = true; render();
      try {
        const r = await api('/embed', { method: 'POST', body: '{}' });
        S.error = r.ok ? '' : r.note || '';
      } catch (err) { S.error = err.message; }
      S.busy = false; await loadStatus(); render();
    }
  });
  el.addEventListener('keydown', (e) => {
    const n = e.target.closest && e.target.closest('[data-node]');
    if (n && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openPage(n.dataset.node); }
    if (e.key === 'Escape' && S.pageId) { S.pageId = null; S.page = null; render(); }
  });
}

async function start() {
  if (started) return; started = true;
  const who = await (window.__studioWho = window.__studioWho || fetch('/admin/api/whoami', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({})));
  S.guest = Boolean(who && who.guest);
  render();
  await Promise.all([loadStatus(), loadCards()]);
  render();
}

// Mount into #studio-brain now, and again whenever the Radar view renders a fresh (empty) one.
function mount() {
  const el = document.getElementById('studio-brain');
  if (!el || (el === root && el.firstElementChild)) return;
  root = el;
  if (!el.dataset.brWired) { el.dataset.brWired = '1'; wire(el); }
  render();
  if (el.offsetParent !== null || !el.closest('[hidden]')) start();
  else new IntersectionObserver((xs, io) => { if (xs.some((x) => x.isIntersecting)) { io.disconnect(); start(); } }).observe(el);
}
let queued = false;
new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; mount(); }); } }).observe(document.body || document.documentElement, { childList: true, subtree: true });
window.addEventListener('studio:view', () => mount());
mount();
