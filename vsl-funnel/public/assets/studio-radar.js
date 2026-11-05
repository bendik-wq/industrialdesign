// G&L Studio → Radar (#studio-radar): the viral formats across every platform and how the script changes for our niche,
// the top performers (videos, Meta ads and text posts from X, LinkedIn, Reddit and Substack), each item's transcript,
// format breakdown and G&L version, and two panels other modules mount into: Sources & sweeps (#studio-radar-data,
// /assets/studio-radar-data.js) and Brain (#studio-brain, /assets/studio-brain.js). A missing module fails quietly.
// Guests see everything but no button that changes or spends anything.

const API = '/admin/api/radar';
const root = document.getElementById('studio-radar');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const PLAT = { youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram', meta_ads: 'Meta ads', x: 'X', linkedin: 'LinkedIn', reddit: 'Reddit', substack: 'Substack' };
const TEXT = new Set(['x', 'linkedin', 'reddit', 'substack']);
const HOOK_LABEL = { question: 'Question', contrarian: 'Contrarian', result: 'Result first', story: 'Story', curiosity: 'Curiosity gap', pattern_interrupt: 'Pattern interrupt', list: 'List', authority: 'Authority', problem: 'Problem', other: 'Other',
  result_first: 'Result first', curiosity_gap: 'Curiosity gap', number: 'Number', story_cold_open: 'Story cold open', call_out: 'Call-out', proof_screenshot: 'Proof screenshot' };
const ROLE_LABEL = { hook: 'Hook', stakes: 'Stakes', setup: 'Setup', turn: 'Turn', proof: 'Proof', payoff: 'Payoff', cta: 'CTA', other: 'Beat' };
const AUD_LABEL = { employee: 'Employees', aspiring_buyer: 'Aspiring buyers', owner_1m: '$1M+ owners', investor: 'Investors', general: 'General' };
const JUDGE_LABEL = { hook: 'Hook', specificity: 'Specificity', mechanism: 'Mechanism', proof_honesty: 'Proof honesty', cta: 'CTA' };
const LEN_LABEL = { micro: 'Under 20 s', short: 'Under a minute', mid: '1 to 3 min', long: '3 to 15 min', xl: 'Over 15 min', post: 'Post', thread: 'Thread', article: 'Article' };
const LAYOUT_LABEL = { orbit: 'Orbit', split: 'Split', spotlight: 'Spotlight', stage: 'Stage', vertical: 'Vertical', cinema: 'Cinema' };
const BRAIN = { claude: 'Claude', 'workers-ai': 'Workers AI' };
const human = (s) => String(s || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const GLYPH = {
  youtube: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2" y="4.5" width="16" height="11" rx="3.2"/><path d="m8.4 7.6 4.2 2.4-4.2 2.4z" class="f"/></svg>',
  tiktok: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M11.5 3v9.2a2.9 2.9 0 1 1-2.9-2.9"/><path d="M11.5 3c.4 2 1.8 3.4 4 3.6"/></svg>',
  instagram: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="3" width="14" height="14" rx="4"/><circle cx="10" cy="10" r="3.2"/><circle cx="14.2" cy="5.8" r=".7" class="f"/></svg>',
  meta_ads: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 12.5c0-4 2-7 3.8-7 2.6 0 4.6 9 7.2 9 1.4 0 2-1.4 2-3 0-3-1.6-6-3.4-6-2.4 0-4.2 7-6.8 7C4 12.5 3 12.5 3 12.5z"/></svg>',
  x: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 4h3.6l9.4 12h-3.6z" class="f"/><path d="m15.6 4-5 5.6M9.4 10.6 4.4 16"/></svg>',
  linkedin: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="3" width="14" height="14" rx="3"/><path d="M7 9v4.5M7 6.6v.1M10 13.5V9m0 2c0-1.3.9-2 2-2s2 .7 2 2v2.5"/></svg>',
  reddit: '<svg viewBox="0 0 20 20" aria-hidden="true"><ellipse cx="10" cy="12" rx="6" ry="4.2"/><path d="m10 7.8.9-4 3 .7"/><circle cx="15" cy="4.6" r="1"/><path d="M8 13.6c1.2.7 2.8.7 4 0"/></svg>',
  substack: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 4h10M5 7h10M5 10h10v6.5l-5-3-5 3z"/></svg>',
};
const n = (v) => { if (v == null || !isFinite(v)) return '·'; const a = Math.abs(v); if (a >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, '') + 'B'; if (a >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'; if (a >= 1e4) return Math.round(v / 1e3) + 'K'; if (a >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'K'; return String(Math.round(v)); };
// Monid calls cost fractions of a cent: below a cent, show four places rather than $0.00.
const usd = (micros) => { const m = micros || 0; return '$' + (m / 1e6).toFixed(m >= 1e8 ? 0 : m > 0 && m < 10_000 ? 4 : 2); };
const pct = (x) => (x == null ? '·' : x === 0 ? '0%' : (x * 100).toFixed(x >= 0.1 ? 0 : 1) + '%');
const ago = (t) => { const s = (Date.now() - Date.parse(t)) / 1000; if (!isFinite(s)) return ''; if (s < 3600) return 'just now'; if (s < 86400) return Math.floor(s / 3600) + ' h ago'; const d = Math.floor(s / 86400); if (d < 45) return d === 1 ? 'yesterday' : d + ' days ago'; const m = Math.round(d / 30.4); return m < 12 ? m + ' months ago' : Math.round(d / 365) + ' years ago'; };
const dur = (s) => (!s ? '' : s < 60 ? Math.round(s) + ' s' : Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0'));
const dollars = (n, cur) => (/micro/i.test(cur || '') ? n / 1e6 : n);
const money = (n) => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(n < 1 ? 3 : 2)}`;
// A matrix price (by route) shows its range; the preview's estimate uses the route the input picks.
const priceText = (p) => {
  if (!p) return 'Price not listed';
  const fee = p.flatFee ? ` + $${dollars(p.flatFee, p.currency).toFixed(2)} a run` : '';
  if (p.variants && p.variants.length) {
    const xs = p.variants.map((v) => dollars(v.amount, v.currency)).concat(dollars(p.amount, p.currency)).filter((x) => x > 0);
    const lo = Math.min(...xs), hi = Math.max(...xs);
    const per = p.variants.every((v) => v.type === 'PER_RESULT') ? 'per result' : 'per run';
    return `${lo === hi ? money(lo) : `${money(lo)} to ${money(hi)}`} ${per} by route${fee}`;
  }
  return `${money(dollars(p.amount, p.currency))} ${p.type === 'PER_RESULT' ? 'per result' : 'per run'}${fee}`;
};

const TABS = [['formats', 'Viral formats'], ['top', 'Top performers'], ['sources', 'Sources & sweeps'], ['brain', 'Brain']];
let S = {
  tab: 'formats', state: null, items: [], guest: false, filters: { niche: 'all', platform: 'all', sort: 'score', radar: '' }, adSort: 'longevity',
  open: null, openFmt: null, busy: {}, sources: null, preview: {}, runs: null, edit: null, poll: null, loaded: false,
  fm: null, fmFilter: 'all', fsheet: null, mods: {},
};
try {
  const t = localStorage.getItem('radar:tab');
  const legacy = { videos: 'top', ads: 'top', hot: 'formats' };
  if (t) S.tab = legacy[t] || (TABS.some(([k]) => k === t) ? t : 'formats');
  if (t === 'ads') S.filters.platform = 'meta_ads';
} catch { /* private mode */ }

async function api(path, init = {}) {
  const r = await fetch(API + path, { credentials: 'same-origin', ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || (r.status === 403 ? 'Only the owner can do that.' : `Something went wrong (${r.status}).`));
  return j;
}
function toast(msg) {
  let t = document.querySelector('.rd-toast');
  if (!t) { t = document.createElement('div'); t.className = 'rd-toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), 3200);
}

// ───────────── data ─────────────
const isAds = () => S.filters.platform === 'meta_ads';
async function loadState() { S.state = await api('/state'); }
async function loadItems() {
  const q = new URLSearchParams({ sort: isAds() ? S.adSort : S.filters.sort });
  if (S.filters.platform !== 'all') q.set('platform', S.filters.platform);
  if (S.filters.niche !== 'all') q.set('niche', S.filters.niche);
  if (S.filters.radar) q.set('radar', S.filters.radar);
  S.items = (await api('/items?' + q)).items || [];
}
async function loadFormats() { S.fm = await api('/formats' + (S.fmFilter === 'white' ? '?white=1' : '')); }
async function refresh() {
  try {
    await loadState();
    if (S.tab === 'top') await loadItems();
    if (S.tab === 'formats') await loadFormats();
    if (S.tab === 'sources' && S.mods.data === false) { S.sources = await api('/sources'); S.runs = (await api('/runs')).runs; }
  } catch (e) { toast(e.message); }
  S.loaded = true;
  render();
  schedulePoll();
}
const pipelineRunning = () => S.fm?.run?.status === 'running';
function schedulePoll() {
  clearTimeout(S.poll);
  if (!S.state || (!S.state.active_runs && !pipelineRunning())) return;
  S.poll = setTimeout(async () => {
    if (document.hidden || root.hidden) return schedulePoll();
    if (S.state.active_runs && !S.guest && S.state.key) { try { await api('/step', { method: 'POST' }); } catch { /* the cron carries on */ } }
    const before = S.state.active_runs;
    await loadState().catch(() => null);
    if (S.state.active_runs !== before && S.tab === 'top') await loadItems().catch(() => null);
    if (S.tab === 'formats') await loadFormats().catch(() => null);
    if (S.tab === 'sources' && S.mods.data === false) S.runs = (await api('/runs').catch(() => ({ runs: S.runs }))).runs;
    if (!S.open && !S.fsheet) render();
    schedulePoll();
  }, pipelineRunning() ? 8000 : 15000);
}

// ───────────── pieces ─────────────
function meter() {
  const sp = S.state?.spend; if (!sp) return '';
  const used = sp.spent_micros + sp.reserved_micros;
  const frac = sp.budget_micros ? Math.min(1, used / sp.budget_micros) : 1;
  const full = used >= sp.budget_micros;
  return `<div class="rd-meter${full ? ' full' : ''}" title="Billed by Monid this month, plus the estimate of runs still going"><div class="rd-meter-top"><span>${usd(used)} <em>of ${usd(sp.budget_micros)}</em></span><span class="rd-meter-l">${full ? 'Budget reached' : 'this month'}</span></div><div class="rd-meter-bar"><i style="width:${(frac * 100).toFixed(1)}%"></i></div></div>`;
}
function tabs() {
  return `<nav class="rd-tabs" role="tablist" aria-label="Radar">${TABS.map(([k, l]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${S.tab === k}">${esc(l)}</button>`).join('')}</nav>`;
}
function head() {
  const st = S.state;
  const runs = st?.active_runs ? `<span class="rd-live"><i></i>${st.active_runs} run${st.active_runs === 1 ? '' : 's'} going</span>` : '';
  return `<header class="rd-head"><div><p class="rd-eyebrow">Radar</p><h1 class="rd-h1">What’s working, and how we’d use it</h1></div><div class="rd-head-r">${runs}${meter()}</div></header>${tabs()}`;
}
function noKeyLine() {
  if (!S.state || S.state.key) return '';
  return `<p class="rd-line">${esc(S.state.copy.noKey)} <a href="/admin#integrations">Open Integrations</a></p>`;
}
const seg = (name, val, opts) => `<div class="rd-seg" role="group" aria-label="${esc(name)}">${opts.map(([v, l, dis]) => `<button type="button" data-f="${name}" data-v="${v}" aria-pressed="${val === v}"${dis ? ' disabled title="Off"' : ''}>${l}</button>`).join('')}</div>`;
const chips = (name, val, opts) => `<div class="rd-pills" role="group" aria-label="${esc(name)}">${opts.map(([v, l, g]) => `<button type="button" data-f="${name}" data-v="${v}" aria-pressed="${val === v}">${g ? `<span class="rd-g">${g}</span>` : ''}${l}</button>`).join('')}</div>`;

function rail() {
  const st = S.state || { watchlists: [] };
  const ads = isAds();
  const radarRows = st.watchlists.map((w) => `<li class="rd-radar${S.filters.radar === w.id ? ' on' : ''}">
      <button type="button" class="rd-radar-main" data-radar="${esc(w.id)}" aria-pressed="${S.filters.radar === w.id}"><span class="rd-radar-name">${esc(w.name)}</span>
      <span class="rd-radar-sub"><span class="rd-chip ${w.niche === 'in' ? 'in' : 'out'}">${w.niche === 'in' ? 'Our niche' : 'Outside'}</span>${w.platforms.map((p) => `<span class="rd-g" title="${PLAT[p] || esc(p)}">${GLYPH[p] || ''}</span>`).join('')}<span>${w.keywords.length} keywords</span></span>
      <span class="rd-radar-sub">${w.enabled ? (w.last_run_at ? 'Ran ' + esc(ago(w.last_run_at)) : 'Not run yet') : 'Paused'}</span></button>
      ${S.guest ? '' : `<span class="rd-radar-act"><button type="button" class="rd-btn rd-btn-sm" data-run="${esc(w.id)}"${!st.key || S.busy['run' + w.id] ? ' disabled' : ''}>${S.busy['run' + w.id] ? 'Starting' : 'Run'}</button><button type="button" class="rd-icon" data-edit="${esc(w.id)}" aria-label="Edit ${esc(w.name)}"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 13.5-.5 3 3-.5 8.6-8.6-2.5-2.5z"/></svg></button></span>`}</li>`).join('');
  const plats = [['all', 'All'], ...Object.keys(PLAT).filter((p) => p !== 'instagram' || st.config?.instagram).map((p) => [p, PLAT[p], GLYPH[p]])];
  const filters = `<p class="rd-lbl">Platform</p>${chips('platform', S.filters.platform, plats)}
     <p class="rd-lbl">Niche</p>${seg('niche', S.filters.niche, [['all', 'All'], ['in', 'Ours'], ['out', 'Outside']])}
     <p class="rd-lbl">Sort</p>${ads ? seg('adsort', S.adSort, [['longevity', 'Days active'], ['variants', 'Variants'], ['score', 'Score']])
       : `<label class="rd-select"><span class="sr">Sort by</span><select data-sort>${[['score', 'Outlier score'], ['views', 'Views'], ['engagement', 'Engagement'], ['velocity', 'Views per day'], ['recent', 'Newest']].map(([v, l]) => `<option value="${v}"${S.filters.sort === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>`}`;
  const open = !matchMedia('(max-width: 720px)').matches || S.railOpen;
  const active = [S.filters.platform !== 'all' ? PLAT[S.filters.platform] : '', S.filters.niche !== 'all' ? (S.filters.niche === 'in' ? 'our niche' : 'outside') : '', S.filters.radar ? 'one radar' : ''].filter(Boolean).join(', ');
  return `<aside class="rd-rail" aria-label="Radars and filters"><details class="rd-raild" data-rail${open ? ' open' : ''}><summary>Radars and filters${active ? `<span>${esc(active)}</span>` : ''}</summary>
    <div class="rd-filters rd-filters-top">${filters}</div>
    <div class="rd-rail-h"><h2>Radars</h2>${S.guest ? '' : '<button type="button" class="rd-link" data-new>New radar</button>'}</div>
    <ul class="rd-radars">${S.filters.radar ? '<li><button type="button" class="rd-link rd-all" data-radar="">Show every radar</button></li>' : ''}${radarRows || '<li class="rd-muted">No radar here yet.</li>'}</ul>
    ${ads ? `<p class="rd-fine">${esc(S.state?.copy?.adSpend || '')}</p>` : ''}
  </details></aside>`;
}

function badge(it) {
  const p = it.score_parts || {};
  if (it.platform === 'meta_ads') return `<span class="rd-badge">${n(it.ad_active_days)} days</span>`;
  if (p.ratio != null && p.ratio >= 2) return `<span class="rd-badge hot" title="${p.ratio_basis === 'followers' ? 'Views against followers' : p.ratio_basis === 'author' ? 'Views against this creator’s typical views' : 'Views against the typical views Radar has found here'}">${p.ratio >= 10 ? Math.round(p.ratio) : p.ratio.toFixed(1)}x</span>`;
  return `<span class="rd-badge">${Math.round(it.score)}</span>`;
}
function textStats(it) {
  return [it.likes != null ? `${n(it.likes)} likes` : '', it.reposts != null ? `${n(it.reposts)} reposts` : it.shares != null ? `${n(it.shares)} shares` : '', it.comments != null ? `${n(it.comments)} replies` : '', it.bookmarks != null ? `${n(it.bookmarks)} saves` : ''].filter(Boolean).slice(0, 3).map((x) => `<span>${x}</span>`).join('');
}
function card(it) {
  const ad = it.platform === 'meta_ads';
  if (TEXT.has(it.platform)) {
    const body = it.body_text || it.caption || it.title || '';
    return `<li><button type="button" class="rd-card rd-card-text" data-open="${esc(it.id)}">
      <span class="rd-post-top"><span class="rd-g">${GLYPH[it.platform] || ''}</span><span class="rd-card-a">${esc(it.author || PLAT[it.platform] || '')}${it.published_at ? ' · ' + esc(ago(it.published_at)) : ''}</span>${badge(it).replace('rd-badge', 'rd-badge rd-badge-in')}</span>
      ${it.title && it.platform !== 'x' ? `<span class="rd-card-t">${esc(it.title)}</span>` : ''}
      <span class="rd-post-body">${esc(body.slice(0, 420))}</span>
      <span class="rd-stats">${textStats(it)}</span>
      ${it.hook ? `<span class="rd-card-hook"><b>For G&amp;L</b> ${esc(it.hook)}</span>` : ''}
    </button></li>`;
  }
  const thumb = it.thumbnail_url || (ad && it.media_kind === 'image' ? it.media_url : '');
  const stats = ad
    ? `<span>${n(it.ad_variants)} variant${it.ad_variants === 1 ? '' : 's'}</span>${it.ad_cta ? `<span>${esc(it.ad_cta)}</span>` : ''}${it.ad_active === 0 ? '<span>Stopped</span>' : '<span>Running</span>'}`
    : `<span>${n(it.views)} views</span><span>${pct(it.score_parts?.engagement)} eng.</span>${it.score_parts?.velocity ? `<span>${n(it.score_parts.velocity)}/day</span>` : ''}`;
  return `<li><button type="button" class="rd-card${ad ? ' ad' : ''}" data-open="${esc(it.id)}">
    <span class="rd-thumb">${thumb ? `<img src="${esc(thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="rd-thumb-empty"></span>'}
      <span class="rd-plat" title="${PLAT[it.platform] || ''}">${GLYPH[it.platform] || ''}</span>${badge(it)}${it.duration_s && !ad ? `<span class="rd-dur">${dur(it.duration_s)}</span>` : ''}</span>
    <span class="rd-card-b"><span class="rd-card-t">${esc(it.title || it.caption || 'Untitled')}</span>
      <span class="rd-card-a">${esc(it.author || '')}${it.published_at && !ad ? ' · ' + esc(ago(it.published_at)) : ''}</span>
      <span class="rd-stats">${stats}</span>
      ${it.hook ? `<span class="rd-card-hook"><b>For G&amp;L</b> ${esc(it.hook)}</span>` : ''}</span>
  </button></li>`;
}
function grid() {
  if (!S.items.length) {
    const st = S.state;
    const msg = !st?.key ? 'Nothing here yet. Once the Monid key is in, run a radar to fill this.'
      : !st.slots?.some((s) => s.selected?.confirmed) ? 'Nothing here yet. Pick and confirm a source in Sources & sweeps, then run a radar.'
      : 'Nothing matches these filters yet. Run a radar, or widen the filters.';
    return `<div class="rd-empty"><p>${esc(msg)}</p></div>`;
  }
  return `<ul class="rd-grid${isAds() ? ' ads' : ''}">${S.items.map(card).join('')}</ul>`;
}

// ───────────── the item sheet ─────────────
function player(it) {
  if (TEXT.has(it.platform)) return `<article class="rd-post"><div class="rd-post-top"><span class="rd-g">${GLYPH[it.platform] || ''}</span><b>${esc(it.author || PLAT[it.platform])}</b><span class="rd-fine">${esc(PLAT[it.platform])}</span></div>${it.title && it.platform !== 'x' ? `<h3>${esc(it.title)}</h3>` : ''}<div class="rd-post-full">${esc(it.body_text || it.caption || '').split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('')}</div></article>`;
  if (it.platform === 'youtube' && it.embed_url) return `<div class="rd-player wide"><iframe src="${esc(it.embed_url)}" title="${esc(it.title || 'YouTube video')}" allow="encrypted-media; picture-in-picture; fullscreen" allowfullscreen loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></iframe></div>`;
  if (it.platform === 'tiktok' && it.embed_url) return `<div class="rd-player tall"><iframe src="${esc(it.embed_url)}" title="${esc(it.title || 'TikTok video')}" allow="encrypted-media; fullscreen" allowfullscreen loading="lazy"></iframe></div>`;
  if (it.platform === 'meta_ads' && it.media_url) {
    return it.media_kind === 'video'
      ? `<div class="rd-player ad"><video src="${esc(it.media_url)}" controls playsinline preload="metadata"${it.thumbnail_url ? ` poster="${esc(it.thumbnail_url)}"` : ''}></video></div>`
      : `<div class="rd-player ad"><img src="${esc(it.media_url)}" alt="The ad creative" referrerpolicy="no-referrer"></div>`;
  }
  return `<div class="rd-player wide still">${it.thumbnail_url ? `<img src="${esc(it.thumbnail_url)}" alt="" referrerpolicy="no-referrer">` : ''}</div>`;
}
function metrics(it) {
  const p = it.score_parts || {};
  const cells = it.platform === 'meta_ads'
    ? [['Days active', n(it.ad_active_days)], ['Variants', n(it.ad_variants)], ['Status', it.ad_active === 0 ? 'Stopped' : 'Running'], ['Page likes', n(it.followers)], ['Button', it.ad_cta || '·']]
    : TEXT.has(it.platform)
      ? [['Views', n(it.views)], ['Likes', n(it.likes)], ['Reposts', n(it.reposts ?? it.shares)], ['Replies', n(it.comments)], ['Saves', n(it.bookmarks ?? it.saves)], ['Followers', n(it.followers)], ['Outlier', p.ratio != null ? `${p.ratio >= 10 ? Math.round(p.ratio) : p.ratio.toFixed(1)}x` : '·']]
      : [['Views', n(it.views)], ['Outlier', p.ratio != null ? `${p.ratio >= 10 ? Math.round(p.ratio) : p.ratio.toFixed(1)}x` : '·'], ['Engagement', pct(p.engagement)], ['Per day', n(p.velocity)], ['Likes', n(it.likes)], ['Comments', n(it.comments)], ['Followers', n(it.followers)]];
  return `<dl class="rd-metrics${it.platform === 'meta_ads' ? ' ad' : ''}">${cells.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}<div><dt>Score</dt><dd>${Math.round(it.score)}</dd></div></dl>`;
}
function transcriptBlock(it) {
  if (TEXT.has(it.platform)) return '';
  if (it.platform === 'meta_ads') return it.caption ? `<section class="rd-sec"><h3>Ad copy</h3><p class="rd-copy">${esc(it.caption)}</p>${it.ad_link ? `<p class="rd-fine">Links to <a href="${esc(it.ad_link)}" target="_blank" rel="noopener noreferrer">${esc(it.ad_link.replace(/^https:\/\//, '').slice(0, 60))}</a></p>` : ''}</section>` : '';
  const src = { monid: 'Transcript from Monid', captions: 'From the platform captions', pending: 'Fetching the transcript', missing: 'No transcript yet' }[it.transcript_source] || 'No transcript yet';
  const canGet = !S.guest && S.state?.key && (it.platform === 'youtube' || it.platform === 'tiktok' || (it.platform === 'instagram' && S.state?.config?.instagram)) && it.transcript_source !== 'pending' && it.transcript_source !== 'monid';
  const body = it.transcript
    ? `<div class="rd-transcript">${esc(it.transcript).split(/\n|(?=\[\d+:\d\d\])/).filter((l) => l.trim()).map((l) => `<p>${l.replace(/^\[(\d+:\d\d)\]\s*/, '<time>$1</time>')}</p>`).join('')}</div>`
    : `<p class="rd-muted">${it.caption ? 'Caption: ' + esc(it.caption.slice(0, 600)) : 'Nothing to read yet.'}</p>`;
  return `<section class="rd-sec"><div class="rd-sec-h"><h3>Transcript</h3><span class="rd-fine">${src}</span>${canGet ? `<button type="button" class="rd-btn rd-btn-sm" data-transcript${S.busy.tr ? ' disabled' : ''}>${it.transcript ? 'Fetch the full transcript' : 'Get transcript'}</button>` : ''}</div>${body}</section>`;
}
/** The format breakdown of one item (radar_item_formats). */
function breakdown(x, fmt) {
  const chipsOf = (xs, lbl) => (xs || []).map((d) => `<span class="rd-chip">${esc(lbl ? lbl[d] || human(d) : human(d))}</span>`).join('');
  return `<section class="rd-sec rd-bd">
    <div class="rd-sec-h"><h3>Format</h3>${fmt ? `<button type="button" class="rd-chip in rd-chip-btn" data-fopen="${esc(fmt.id)}">${esc(fmt.name)}${fmt.white_space ? ' · white space' : ''}</button>` : ''}</div>
    <p class="rd-bd-name">${esc(x.format_name)}</p>
    <div class="rd-bd-hook"><span class="rd-chip">${esc(HOOK_LABEL[x.hook?.type] || 'Hook')}</span><blockquote class="rd-quote">${esc(x.hook?.text)}</blockquote><p>${esc(x.hook?.why_it_works)}</p></div>
    ${x.beats?.length ? `<ol class="rd-beats">${x.beats.map((b) => `<li><time>${esc(b.at)}</time><div><b>${esc(ROLE_LABEL[b.role] || human(b.role))}</b><span>${esc(b.summary)}</span></div></li>`).join('')}</ol>` : ''}
    <dl class="rd-dl rd-dl-2">
      <div><dt>Devices</dt><dd class="rd-chiprow">${chipsOf(x.devices) || '·'}</dd></div>
      <div><dt>Length</dt><dd>${esc(LEN_LABEL[x.length_bucket] || human(x.length_bucket))}</dd></div>
      <div><dt>Audience</dt><dd class="rd-chiprow">${chipsOf(x.audience, AUD_LABEL)}</dd></div>
      <div><dt>Emotional driver</dt><dd>${esc(human(x.emotional_driver))}</dd></div>
      ${x.cta ? `<div><dt>CTA</dt><dd>${esc(x.cta)}</dd></div>` : ''}
      <div class="wide"><dt>Why it went viral</dt><dd>${esc(x.why_viral)}</dd></div>
    </dl>
    ${x.retention_risks?.length ? `<div class="rd-sec-h rd-sub-h"><h4>Retention risks</h4><span class="rd-chip est">Estimate</span></div><ul class="rd-drops">${x.retention_risks.map((d) => `<li><time>${esc(d.at)}</time><span>${esc(d.why)}</span></li>`).join('')}</ul>` : ''}
  </section>`;
}
function itemFormatBlock(it) {
  const f = S.openFmt;
  const brain = S.state?.brain;
  if (!f) return '<section class="rd-sec"><p class="rd-muted">Reading the format</p></section>';
  if (!f.extraction) {
    return `<section class="rd-sec rd-an-empty"><p>${S.busy.ex ? 'Reading the format now.' : 'The format of this one has not been read yet. The next analysis run reads the top performers first.'}</p>${S.guest || !brain ? '' : `<button type="button" class="rd-btn rd-btn-primary" data-extract${S.busy.ex ? ' disabled' : ''}>${S.busy.ex ? 'Reading' : 'Read the format'}</button>`}</section>`;
  }
  const a = f.adaptation;
  return `${breakdown(f.extraction, f.format)}
    <section class="rd-sec"><div class="rd-sec-h"><h3>How the script changes for us</h3>${!S.guest && brain ? `<button type="button" class="rd-btn rd-btn-sm${a ? '' : ' rd-btn-primary'}" data-iadapt${S.busy.ia ? ' disabled' : ''}>${S.busy.ia ? 'Writing, about two minutes' : a ? 'Write it again' : 'Show me'}</button>` : ''}</div>
    ${a ? adaptationView(a, f.script) : `<p class="rd-muted">${S.busy.ia ? 'Adapting the beats, writing the script and running the blind judge.' : 'Beat by beat, side by side, with five hooks and a Studio script.'}</p>`}</section>`;
}
function analysisBlock(it) {
  const a = it.analysis;
  const brain = S.state?.brain;
  const busy = S.busy.an;
  if (!a) {
    return `<details class="rd-older"><summary>Quick analysis</summary><div class="rd-an-empty"><p>${busy ? 'Reading it now. This takes about a minute.' : 'Not analysed yet.'}</p>${S.guest ? '' : brain ? `<button type="button" class="rd-btn" data-analyse${busy ? ' disabled' : ''}>${busy ? 'Analysing' : 'Analyse'}</button><p class="rd-fine">With ${BRAIN[brain]}</p>` : '<p class="rd-fine">Add the Anthropic key in Integrations to analyse.</p>'}</div></details>`;
  }
  const g = a.for_gl || {};
  const flags = it.analysis_flags || [];
  return `<details class="rd-older"><summary>Quick analysis and “Make it a script”</summary><section class="rd-gl"><p class="rd-eyebrow">For G&amp;L</p>
    <blockquote class="rd-gl-hook">${esc(g.hook)}</blockquote>
    <p class="rd-gl-apply">${esc(g.apply || g.how_we_run)}</p>
    ${g.angles?.length ? `<h4>Three angles</h4><ol class="rd-angles">${g.angles.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>` : ''}
    ${g.layouts?.length ? `<h4>Studio layout per beat</h4><ul class="rd-lays">${g.layouts.map((l) => `<li><span>${esc(l.beat)}</span><b>${LAYOUT_LABEL[l.layout] || esc(l.layout)}</b></li>`).join('')}</ul>` : ''}
    ${flags.length ? `<p class="rd-flag">Copy check: ${flags.length} line${flags.length === 1 ? '' : 's'} to review (${esc(flags.slice(0, 2).map((f) => f.rule).join('; '))})</p>` : ''}
    ${S.guest ? '' : `<div class="rd-gl-act">${it.script_id ? '<button type="button" class="rd-btn rd-btn-quiet" data-goscript>Open the script</button>' : ''}<button type="button" class="rd-btn" data-script${S.busy.sc ? ' disabled' : ''}>${S.busy.sc ? 'Writing the script' : it.script_id ? 'Write another script' : 'Make it a script'}</button></div>`}
  </section><p class="rd-fine rd-an-foot">Analysed ${esc(ago(it.analyzed_at))} with ${BRAIN[it.analysis_brain] || 'the analyst'}.${S.guest || !brain ? '' : ` <button type="button" class="rd-link" data-analyse${busy ? ' disabled' : ''}>${busy ? 'Analysing again' : 'Analyse again'}</button>`}</p></details>`;
}
function sheet() {
  const it = S.open;
  if (!it) return '';
  return `<div class="rd-scrim" data-close></div><div class="rd-sheet" role="dialog" aria-modal="true" aria-labelledby="rd-sheet-t">
    <header class="rd-sheet-h"><div class="rd-sheet-tl"><span class="rd-g">${GLYPH[it.platform] || ''}</span><div><h2 id="rd-sheet-t">${esc(it.title || it.caption?.slice(0, 120) || 'Untitled')}</h2><p class="rd-fine">${esc(it.author || '')}${it.published_at ? ' · ' + esc(new Date(it.published_at).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })) : ''}${it.url ? ` · <a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">Open on ${PLAT[it.platform] || 'the platform'}</a>` : ''}</p></div></div>
      <button type="button" class="rd-icon" data-close aria-label="Close"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg></button></header>
    <div class="rd-sheet-b"><div class="rd-sheet-l">${player(it)}${metrics(it)}${transcriptBlock(it)}</div><div class="rd-sheet-r">${itemFormatBlock(it)}${analysisBlock(it)}</div></div>
  </div>`;
}

// ───────────── viral formats ─────────────
function sparkline(xs, w = 120, h = 32) {
  if (!xs || xs.length < 2) return '';
  // Scaled to the format's own range (with a floor of 20 points) so the shape reads; the scores themselves are 0 to 100.
  const lo = Math.max(0, Math.min(...xs) - 5), hi = Math.min(100, Math.max(Math.max(...xs) + 5, lo + 20)), step = w / (xs.length - 1);
  const pts = xs.map((v, i) => `${(i * step).toFixed(1)},${(h - 3 - ((v - lo) / (hi - lo)) * (h - 6)).toFixed(1)}`).join(' ');
  const last = pts.split(' ').pop().split(',');
  return `<svg class="rd-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Outlier scores of its examples, oldest first"><polyline points="${pts}"/><circle cx="${last[0]}" cy="${last[1]}" r="2.4"/></svg>`;
}
function platformMix(st) {
  const ps = Object.entries(st.platforms || {}).sort((a, b) => b[1] - a[1]);
  return `<span class="rd-mix">${ps.map(([p, c]) => `<span class="rd-mix-i" title="${esc(PLAT[p] || p)}: ${c}"><span class="rd-g">${GLYPH[p] || ''}</span>${c}</span>`).join('')}</span>`;
}
const trendText = (t) => (!t ? '' : t.label === 'new' ? 'New' : t.label === 'up' ? `Up ${t.delta}` : t.label === 'down' ? `Down ${Math.abs(t.delta)}` : 'Steady');
function exampleThumbs(st) {
  return `<span class="rd-exthumbs">${(st.examples || []).slice(0, 3).map((e) => e.thumbnail_url
    ? `<span class="rd-exthumb"><img src="${esc(e.thumbnail_url)}" alt="" loading="lazy" referrerpolicy="no-referrer"><span class="rd-g">${GLYPH[e.platform] || ''}</span></span>`
    : `<span class="rd-exthumb text"><span>${esc((e.snippet || e.title || '').slice(0, 90))}</span><span class="rd-g">${GLYPH[e.platform] || ''}</span></span>`).join('')}</span>`;
}
function formatCard(f, i) {
  const st = f.stats || {};
  return `<li><button type="button" class="rd-fcard${f.white_space ? ' ws' : ''}" data-fopen="${esc(f.id)}">
    <span class="rd-fcard-top"><span class="rd-rank">${i + 1}</span>${f.white_space ? `<span class="rd-chip ws" title="${esc(f.white_space_why || '')}">White space${f.white_space === 2 ? ' · owners' : ''}</span>` : ''}${f.adapted ? `<span class="rd-chip ok">G&amp;L version${f.judge_score != null ? ` · ${f.judge_score}/10` : ''}</span>` : ''}<span class="rd-trend ${esc(st.trend?.label || '')}">${esc(trendText(st.trend))}</span></span>
    <span class="rd-fname">${esc(f.name)}</span>
    <span class="rd-fdef">${esc(f.definition || '').replace(/\n/g, '<br>')}</span>
    <span class="rd-fstats"><span><b>${st.count ?? 0}</b> examples</span><span><b>${Math.round(st.median_score ?? 0)}</b> median score</span><span><b>${pct(st.in_share)}</b> in our niche</span></span>
    <span class="rd-frow">${platformMix(st)}${sparkline(st.sparkline)}</span>
    ${exampleThumbs(st)}
  </button></li>`;
}
function pipelineStrip() {
  const d = S.fm || {};
  const run = d.run;
  const nodes = d.nodes || [];
  const brain = d.brain;
  const running = run?.status === 'running';
  const label = { idle: 'Not run', waiting: 'Waiting', working: 'Working', done: 'Done', skipped: 'Skipped', failed: 'Stopped' };
  const status = !run ? 'No analysis has run yet.' : running ? `Running since ${ago(run.started_at)}${run.mode === 'workflow' ? ' as a Workflow' : ''}.` : run.status === 'failed' ? `The last run stopped: ${run.error || 'unknown reason'}.` : `Last run finished ${ago(run.finished_at || run.updated_at)}.`;
  const c = d.counts || {};
  return `<section class="rd-flow" aria-label="Analysis pipeline">
    <div class="rd-flow-h"><div><h2>The analysis</h2><p class="rd-fine">${esc(status)} ${c.extracted ?? 0} of ${c.items ?? 0} top performers read, ${c.adaptations ?? 0} adapted for G&amp;L.</p></div>
      ${S.guest ? '' : brain ? `<button type="button" class="rd-btn rd-btn-primary" data-prun${running || S.busy.prun ? ' disabled' : ''}>${running ? 'Running' : S.busy.prun ? 'Starting' : 'Run analysis'}</button>` : '<p class="rd-fine">Add the Anthropic key in Integrations, or run where Workers AI is available.</p>'}</div>
    <ol class="rd-nodes">${nodes.map((nd) => `<li class="rd-node ${esc(nd.state)}" title="${esc(nd.kind)}"><i aria-hidden="true"></i><span>${esc(nd.label)}</span><em>${esc(label[nd.state] || nd.state)}</em></li>`).join('')}</ol>
  </section>`;
}
function formatsView() {
  const d = S.fm;
  if (!d) return '<div class="rd-empty"><p>Loading the formats</p></div>';
  const list = d.formats || [];
  const empty = !list.length ? `<div class="rd-empty"><p>${S.fmFilter === 'white' ? 'No white space yet: every winning format outside the niche is already used in ours.' : (d.counts?.items ? 'No formats yet. Run the analysis to read the top performers and group them into formats.' : 'Nothing found yet. Run a radar in Top performers first, then run the analysis.')}</p></div>` : '';
  return `${pipelineStrip()}
    <div class="rd-fbar"><p class="rd-fine">Ranked by median outlier score, platform breadth and recency. White space: wins outside our niche, absent or weak in ours.</p>${seg('fm', S.fmFilter, [['all', 'All formats'], ['white', 'White space']])}</div>
    ${empty || `<ul class="rd-fgrid">${list.map(formatCard).join('')}</ul>`}`;
}

/** Original skeleton next to the G&L version, judge scores, hooks, legends, and the Studio script. */
function adaptationView(a, script) {
  const d = a.data || {};
  const rounds = a.judge?.rounds || [];
  const j = rounds[rounds.length - 1];
  const flags = a.flags || [];
  const sideBySide = `<div class="rd-sbs" role="table" aria-label="The original next to the G&amp;L version">
    <div class="rd-sbs-h" role="row"><span role="columnheader">The original</span><span role="columnheader">For G&amp;L</span></div>
    ${(d.beats || []).map((b, i) => `<div class="rd-sbs-r" role="row">
      <div class="rd-sbs-o" role="cell"><span class="rd-role">${esc(ROLE_LABEL[b.role] || human(b.role))}</span><p>${esc(b.original || d.original_skeleton?.[i]?.summary || '')}</p></div>
      <div class="rd-sbs-g" role="cell"><p class="rd-ours">${esc(b.ours)}</p><p class="rd-why">${esc(b.why)}</p>${b.legend ? `<p class="rd-legend"><span class="rd-chip in">${esc(b.legend)}</span> ${esc(b.legend_note)}</p>` : ''}</div>
    </div>`).join('')}
  </div>`;
  const judge = j ? `<div class="rd-judge"><div class="rd-sec-h rd-sub-h"><h4>Blind judge</h4><span class="rd-chip ${j.pass ? 'ok' : 'warn'}">${j.min}/10 lowest</span><span class="rd-fine">${rounds.length > 1 ? `${rounds.length - 1} rewrite${rounds.length === 2 ? '' : 's'}` : 'First draft'}</span></div>
    <ul class="rd-scores">${Object.entries(j.scores || {}).map(([k, v]) => `<li><span>${esc(JUDGE_LABEL[k] || human(k))}</span><span class="rd-bar"><i style="width:${v * 10}%"${v < 7 ? ' class="low"' : ''}></i></span><b>${v}</b></li>`).join('')}</ul>
    ${j.verdict ? `<p class="rd-fine">${esc(j.verdict)}</p>` : ''}</div>` : '';
  const hooks = d.hooks?.length ? `<div><h4 class="rd-h4">Five hooks in our voice</h4><ol class="rd-hooks">${d.hooks.map((h) => `<li>${esc(h)}</li>`).join('')}</ol></div>` : '';
  const sc = script?.script;
  const scriptBlock = sc ? `<div class="rd-script"><div class="rd-sec-h rd-sub-h"><h4>The Studio script</h4><span class="rd-chip">${esc(script.format === 'long' ? 'Long YouTube' : 'Short')}</span>${script.flags?.length ? `<span class="rd-chip warn">${script.flags.length} to review</span>` : '<span class="rd-chip ok">Copy check passed</span>'}</div>
    <p class="rd-script-t">${esc(sc.titles?.[0] || script.title || '')}</p>
    <ol class="rd-script-b">${(sc.beats || []).map((b) => `<li><span class="rd-chip">${esc(LAYOUT_LABEL[b.layout] || b.layout)}</span><p>${esc(b.text)}</p>${b.cue ? `<span class="rd-fine">${esc(b.cue)}</span>` : ''}</li>`).join('')}</ol>
    ${S.guest ? '' : `<div class="rd-gl-act"><button type="button" class="rd-btn rd-btn-quiet" data-goscript-id="${esc(script.id)}">Open in Scripts</button><button type="button" class="rd-btn rd-btn-primary" data-record="${esc(script.id)}">Record this</button></div>`}</div>` : '';
  return `<div class="rd-adapt">
    ${d.angle ? `<p class="rd-angle"><b>Our angle</b> ${esc(d.angle)}</p>` : ''}
    ${sideBySide}
    ${flags.length ? `<p class="rd-flag">Copy check: ${flags.length} line${flags.length === 1 ? '' : 's'} to review (${esc(flags.slice(0, 2).map((f) => f.rule).join('; '))})</p>` : ''}
    <div class="rd-adapt-2">${judge}${hooks}</div>
    ${scriptBlock}
  </div>`;
}
function fsheet() {
  const x = S.fsheet;
  if (!x) return '';
  if (!x.format) return '<div class="rd-scrim" data-fclose></div><div class="rd-sheet" role="dialog" aria-modal="true" aria-label="Format"><div class="rd-empty"><p>Loading the format</p></div></div>';
  const f = x.format; const st = f.stats || {};
  const brain = S.state?.brain || S.fm?.brain;
  const ex = (x.examples || []).map((e) => `<li><button type="button" class="rd-exrow" data-open="${esc(e.id)}">
      <span class="rd-exthumb${e.thumbnail_url ? '' : ' text'}">${e.thumbnail_url ? `<img src="${esc(e.thumbnail_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span>${esc((e.caption || e.title || '').slice(0, 60))}</span>`}<span class="rd-g">${GLYPH[e.platform] || ''}</span></span>
      <span class="rd-exrow-b"><b>${esc(e.title || (e.caption || '').slice(0, 90) || 'Untitled')}</b><span class="rd-fine">${esc(e.author || '')} · score ${Math.round(e.score)} · ${e.niche === 'in' ? 'our niche' : e.niche === 'both' ? 'both' : 'outside'}</span>${e.extraction?.hook?.text ? `<span class="rd-exhook">“${esc(e.extraction.hook.text.slice(0, 140))}”</span>` : ''}</span></button></li>`).join('');
  const aud = Object.entries(st.audience || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<span class="rd-chip">${esc(AUD_LABEL[k] || human(k))} ${v}</span>`).join('');
  return `<div class="rd-scrim" data-fclose></div><div class="rd-sheet" role="dialog" aria-modal="true" aria-labelledby="rd-fs-t">
    <header class="rd-sheet-h"><div><p class="rd-eyebrow">Viral format</p><h2 id="rd-fs-t" class="rd-fs-name">${esc(f.name)}</h2><p class="rd-fdef">${esc(f.definition || '').replace(/\n/g, '<br>')}</p></div>
      <button type="button" class="rd-icon" data-fclose aria-label="Close"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg></button></header>
    <div class="rd-sheet-b"><div class="rd-sheet-l">
      ${f.white_space ? `<p class="rd-line rd-ws-line"><b>White space.</b> ${esc(f.white_space_why || '')}</p>` : ''}
      <dl class="rd-metrics"><div><dt>Examples</dt><dd>${st.count ?? 0}</dd></div><div><dt>Median score</dt><dd>${Math.round(st.median_score ?? 0)}</dd></div><div><dt>Platforms</dt><dd>${st.platform_count ?? 0}</dd></div><div><dt>In our niche</dt><dd>${pct(st.in_share)}</dd></div><div><dt>Trend</dt><dd>${esc(trendText(st.trend) || '·')}</dd></div><div><dt>Hook</dt><dd>${esc(HOOK_LABEL[f.hook_type] || human(f.hook_type))}</dd></div><div><dt>Length</dt><dd>${esc(LEN_LABEL[f.length_bucket] || human(f.length_bucket))}</dd></div><div><dt>Last seen</dt><dd>${esc(st.last_seen ? ago(st.last_seen) : '·')}</dd></div></dl>
      <div class="rd-frow rd-frow-big">${platformMix(st)}${sparkline(st.sparkline, 240, 44)}</div>
      ${aud ? `<p class="rd-chiprow rd-aud">${aud}</p>` : ''}
      <section class="rd-sec"><h3>Examples</h3><ul class="rd-exrows">${ex || '<li class="rd-muted">No examples stored.</li>'}</ul></section>
    </div><div class="rd-sheet-r">
      <div class="rd-sec-h"><h3>How the script changes for us</h3>${!S.guest && brain ? `<button type="button" class="rd-btn rd-btn-sm${x.adaptation ? '' : ' rd-btn-primary'}" data-fadapt="${esc(f.id)}"${S.busy.fa ? ' disabled' : ''}>${S.busy.fa ? 'Writing, about two minutes' : x.adaptation ? 'Write it again' : 'Adapt for G&L'}</button>` : ''}</div>
      ${x.adaptation ? adaptationView(x.adaptation, x.script) : `<p class="rd-muted">${S.busy.fa ? 'Adapting the beats, writing the script and running the blind judge.' : 'Not adapted yet. The analysis adapts the top formats; this button adapts this one now.'}</p>`}
    </div></div>
  </div>`;
}

// ───────────── panels other modules mount into ─────────────
const MODS = { sources: { key: 'data', id: 'studio-radar-data', src: '/assets/studio-radar-data.js' }, brain: { key: 'brain', id: 'studio-brain', src: '/assets/studio-brain.js' } };
async function loadModule(tab) {
  const m = MODS[tab]; if (!m || S.mods[m.key] !== undefined) return;
  S.mods[m.key] = null; // loading
  try {
    const mod = await import(m.src);
    const el = document.getElementById(m.id);
    if (typeof mod?.mount === 'function') await mod.mount(el, { guest: S.guest });
    S.mods[m.key] = true;
    window.dispatchEvent(new CustomEvent('studio:radar-panel', { detail: { id: m.id } }));
  } catch {
    S.mods[m.key] = false; // missing or broken: fail quietly
    if (tab === 'sources') { try { S.sources = await api('/sources'); S.runs = (await api('/runs')).runs; } catch { /* shown empty */ } }
  }
  render();
}

// ───────────── the built-in Sources panel (fallback) and the radar editor ─────────────
function sources() {
  const st = S.state; const src = S.sources;
  if (!st || !src) return '<div class="rd-empty"><p>Loading the sources</p></div>';
  const slotCard = (s) => {
    const info = st.slots.find((x) => x.slot === s.slot) || {};
    const sel = s.tools.find((t) => t.selected);
    const pv = S.preview[s.slot];
    const state = info.off ? '<span class="rd-chip">Off</span>' : !sel ? '<span class="rd-chip">Not picked</span>' : sel.confirmed ? '<span class="rd-chip ok">Confirmed</span>' : '<span class="rd-chip warn">Confirm the input</span>';
    if (info.off) return `<li class="rd-src off"><div class="rd-src-h"><span class="rd-g">${GLYPH[s.platform] || ''}</span><h3>${esc(s.label)}</h3>${state}</div><p class="rd-fine">${esc(st.copy.instagramOff)}</p></li>`;
    const tools = s.tools.map((t) => `<li><label class="rd-tool"><input type="radio" name="tool-${esc(s.slot)}" data-pick="${esc(s.slot)}" data-provider="${esc(t.provider)}" data-endpoint="${esc(t.endpoint)}"${t.selected ? ' checked' : ''}${S.guest ? ' disabled' : ''}>
      <span><b>${esc(t.provider)} ${esc(t.endpoint)}</b>${t.recommended ? ' <span class="rd-chip in">Known actor</span>' : ''}${t.builtin ? ' <span class="rd-chip ok">Built-in input</span>' : ''}<span class="rd-fine">${esc(priceText(t.price))}${t.description ? ' · ' + esc(t.description.slice(0, 140)) : ''}</span></span></label></li>`).join('');
    const preview = pv ? `<div class="rd-preview"><p class="rd-lbl">The exact input for ${esc(pv.query.keywords?.length ? pv.query.keywords.length + ' keywords' : 'one video')}${pv.inputs.length > 1 ? `, ${pv.inputs.length} runs` : ''}</p><pre>${esc(JSON.stringify(pv.inputs.length === 1 ? pv.inputs[0] : pv.inputs, null, 2))}</pre>
        <ul class="rd-notes">${pv.notes.map((x) => `<li>${esc(x)}</li>`).join('')}${pv.missing.length ? `<li class="warn">Required and not filled: ${esc(pv.missing.join(', '))}. Add them in the input template.</li>` : ''}</ul>
        <p class="rd-fine">Estimated cost: ${pv.est_micros ? usd(pv.est_micros) : 'not listed by Monid'} per radar run.</p>
        ${S.guest ? '' : `<div class="rd-row"><button type="button" class="rd-btn rd-btn-primary" data-confirm="${esc(s.slot)}"${pv.missing.length || sel?.confirmed ? ' disabled' : ''}>${sel?.confirmed ? 'Confirmed' : 'Confirm this input'}</button></div>`}</div>` : '';
    const custom = S.guest ? '' : `<details class="rd-custom"><summary>Use another tool or change the input</summary>
        <div class="rd-two"><label class="rd-field"><span>Provider</span><input data-cprov="${esc(s.slot)}" value="${esc(sel?.provider || 'apify')}"></label><label class="rd-field"><span>Endpoint</span><input data-cend="${esc(s.slot)}" value="${esc(sel?.endpoint || '')}" placeholder="/owner/actor"></label></div>
        <label class="rd-field"><span>Input template (JSON, merged over the mapped or built-in input; {{keywords}}, {{keyword}}, {{max}}, {{country}}, {{url}} fill in)</span><textarea rows="4" data-ctpl="${esc(s.slot)}">${esc(sel?.template ? JSON.stringify(sel.template, null, 2) : '')}</textarea></label>
        <button type="button" class="rd-btn rd-btn-quiet rd-btn-sm" data-custom="${esc(s.slot)}">Use this</button></details>`;
    return `<li class="rd-src"><div class="rd-src-h"><span class="rd-g">${GLYPH[s.platform] || ''}</span><h3>${esc(s.label)}</h3>${state}
        <span class="rd-src-act">${S.guest ? '' : `<button type="button" class="rd-btn rd-btn-quiet rd-btn-sm" data-find="${esc(s.slot)}"${!st.key || S.busy['find' + s.slot] ? ' disabled' : ''}>${S.busy['find' + s.slot] ? 'Asking Monid' : s.tools.length ? 'Find again' : 'Find sources'}</button>`}${sel ? `<button type="button" class="rd-btn rd-btn-quiet rd-btn-sm" data-preview="${esc(s.slot)}">${pv ? 'Hide input' : 'Show input'}</button>` : ''}</span></div>
      ${s.tools.length ? `<ul class="rd-tools">${tools}</ul>` : `<p class="rd-fine">${st.key ? 'Press Find sources to see what Monid offers for this.' : 'Add the Monid key first.'}</p>`}${preview}${custom}</li>`;
  };
  const runs = (S.runs || []).map((r) => `<tr><td>${esc(new Date(r.created_at).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }))}</td><td>${esc(r.slot)}</td><td><span class="rd-st ${esc(r.status)}">${esc(r.status)}</span>${r.error ? `<span class="rd-fine"> ${esc(r.error.slice(0, 120))}</span>` : ''}</td><td>${r.items_saved ?? '·'}</td><td>${r.status === 'completed' || r.status === 'failed' ? usd(r.cost_micros) + (r.cost_estimated ? ' est.' : '') : usd(r.est_micros) + ' est.'}</td></tr>`).join('');
  return `<div class="rd-sources">
    ${noKeyLine()}
    <p class="rd-line">One tool per slot. Monid lists what it has; known actors are pre-selected. Nothing paid runs until you have seen the exact input and confirmed it.</p>
    <ul class="rd-srcs">${src.slots.map(slotCard).join('')}</ul>
    <section class="rd-hot-sec"><h2>Recent runs</h2>${runs ? `<div class="rd-tablewrap"><table class="rd-table"><thead><tr><th>When</th><th>Source</th><th>Status</th><th>Items</th><th>Cost</th></tr></thead><tbody>${runs}</tbody></table></div>` : '<p class="rd-muted">No runs yet.</p>'}
    <p class="rd-fine">Settings: ${S.state.config.max_items} results per search, ${S.state.config.schedule_hours ? 'every ' + S.state.config.schedule_hours + ' hours' : 'manual runs only'}, budget ${usd(S.state.spend.budget_micros)} a month. Change them in <a href="/admin#integrations">Integrations</a> under Radar.</p></section>
  </div>`;
}
function editor() {
  const w = S.edit;
  if (!w) return '';
  const ig = S.state?.config?.instagram;
  return `<div class="rd-scrim" data-close-edit></div><form class="rd-sheet rd-edit" role="dialog" aria-modal="true" aria-labelledby="rd-edit-t" data-edit-form>
    <header class="rd-sheet-h"><h2 id="rd-edit-t">${w.id ? 'Edit radar' : 'New radar'}</h2><button type="button" class="rd-icon" data-close-edit aria-label="Close"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg></button></header>
    <div class="rd-edit-b">
      <label class="rd-field"><span>Name</span><input name="name" maxlength="80" required value="${esc(w.name || '')}"></label>
      <label class="rd-field"><span>Keywords, one per line</span><textarea name="keywords" rows="6">${esc((w.keywords || []).join('\n'))}</textarea></label>
      <fieldset class="rd-field"><legend>Platforms</legend><div class="rd-checks">${Object.keys(PLAT).map((p) => `<label><input type="checkbox" name="platforms" value="${p}"${(w.platforms || []).includes(p) ? ' checked' : ''}${p === 'instagram' && !ig ? ' disabled' : ''}> ${PLAT[p]}${p === 'instagram' && !ig ? ' (off)' : ''}</label>`).join('')}</div></fieldset>
      <fieldset class="rd-field"><legend>Niche</legend><div class="rd-checks"><label><input type="radio" name="niche" value="in"${w.niche !== 'out' ? ' checked' : ''}> Our niche</label><label><input type="radio" name="niche" value="out"${w.niche === 'out' ? ' checked' : ''}> Outside the niche</label></div></fieldset>
      <div class="rd-two"><label class="rd-field"><span>Country (two letters, blank for any)</span><input name="country" maxlength="2" value="${esc(w.country || '')}"></label><label class="rd-field"><span>Only the last N days</span><input name="since_days" inputmode="numeric" value="${esc(w.since_days || '')}"></label></div>
      <label class="rd-switch"><input type="checkbox" name="enabled"${w.enabled !== false ? ' checked' : ''}> Runs on the schedule</label>
    </div>
    <footer class="rd-edit-f">${w.id ? '<button type="button" class="rd-btn rd-btn-danger" data-del>Delete</button>' : '<span></span>'}<button type="submit" class="rd-btn rd-btn-primary">Save</button></footer>
  </form>`;
}


// The view keeps two mount points alive across renders (other modules own what is inside them).
function shell() {
  if (root.querySelector('[data-rd-main]')) return;
  root.innerHTML = `<div class="rd-wrap"><div data-rd-head></div><div data-rd-main></div><section id="studio-radar-data" class="rd-mount" aria-label="Sources and sweeps" hidden></section><section id="studio-brain" class="rd-mount" aria-label="Brain" hidden></section></div><div data-rd-over></div>`;
}
function render() {
  if (!root) return;
  shell();
  const scrollY = window.scrollY;
  const mod = MODS[S.tab];
  let body;
  if (!S.loaded) body = '<div class="rd-empty"><p>Loading Radar</p></div>';
  else if (S.tab === 'formats') body = formatsView();
  else if (S.tab === 'sources') body = S.mods.data === true ? '' : S.mods.data === false ? sources() : '<div class="rd-empty"><p>Loading the sources</p></div>';
  else if (S.tab === 'brain') body = S.mods.brain === true ? '' : S.mods.brain === false ? '<div class="rd-empty"><p>The brain panel is not installed here yet.</p></div>' : '<div class="rd-empty"><p>Loading the brain</p></div>';
  else body = `${noKeyLine()}<div class="rd-layout">${rail()}<div class="rd-main">${grid()}</div></div>`;
  root.querySelector('[data-rd-head]').innerHTML = head();
  root.querySelector('[data-rd-main]').innerHTML = body;
  for (const [tab, m] of Object.entries(MODS)) { const el = document.getElementById(m.id); if (el) el.hidden = !(S.tab === tab && S.mods[m.key] === true); }
  root.querySelector('[data-rd-over]').innerHTML = `${S.fsheet ? fsheet() : ''}${sheet()}${editor()}`;
  document.body.classList.toggle('rd-locked', Boolean(S.open || S.edit || S.fsheet));
  window.scrollTo(0, scrollY);
  if (mod) loadModule(S.tab);
}

// ───────────── actions ─────────────
async function openItem(id) {
  try {
    S.open = (await api('/items/' + encodeURIComponent(id))).item; S.openFmt = null; render();
    root.querySelector('.rd-sheet [data-close]')?.focus();
    S.openFmt = await api('/formats/item/' + encodeURIComponent(id)).catch(() => ({ extraction: null }));
    if (S.open?.id === id) render();
  } catch (e) { toast(e.message); }
}
async function openFormat(id) {
  S.fsheet = { id }; render();
  try { const r = await api('/formats/f/' + encodeURIComponent(id)); S.fsheet = { id, ...r }; render(); root.querySelector('[data-fclose].rd-icon')?.focus(); }
  catch (e) { S.fsheet = null; render(); toast(e.message); }
}
async function analyseOpen() {
  const it = S.open; if (!it || S.busy.an) return;
  S.busy.an = true; render();
  try { await api(`/items/${encodeURIComponent(it.id)}/analyse`, { method: 'POST' }); S.open = (await api('/items/' + encodeURIComponent(it.id))).item; toast('Analysed'); }
  catch (e) { toast(e.message); }
  finally { S.busy.an = false; render(); }
}
function showScript(id, record) {
  try { localStorage.setItem('studio:script', id); } catch { /* private mode */ }
  S.open = null; S.fsheet = null; render();
  window.studio?.show?.('scripts');
  window.dispatchEvent(new CustomEvent('studio:open-script', { detail: { id } }));
  if (record) toast('Open in Scripts. Press Record this there to load it into the recorder.');
}
async function recordScript(id) {
  const sc = S.fsheet?.script?.id === id ? S.fsheet.script : S.openFmt?.script?.id === id ? S.openFmt.script : null;
  if (!sc?.script?.beats?.length) return showScript(id, true);
  S.open = null; S.fsheet = null; render();
  window.dispatchEvent(new CustomEvent('studio:use-script', { detail: { id, title: sc.script.titles?.[0] || sc.title || '', beats: sc.script.beats.map((b) => ({ layout: b.layout, text: b.text, cue: b.cue || undefined, on_screen: b.on_screen || undefined, screen: b.screen || undefined })) } }));
  window.studio?.show?.('record');
  toast('The script is in the recorder');
}
async function scriptOpen() {
  const it = S.open; if (!it || S.busy.sc) return;
  S.busy.sc = true; render();
  try {
    const r = await api(`/items/${encodeURIComponent(it.id)}/script`, { method: 'POST', body: '{}' });
    S.busy.sc = false;
    showScript(r.script.id);
    toast('The script is in Scripts, ready to record');
  } catch (e) { toast(e.message); S.busy.sc = false; render(); }
}

root?.addEventListener('click', async (e) => {
  const t = e.target;
  const tab = t.closest('[data-tab]');
  if (tab) { S.tab = tab.dataset.tab; try { localStorage.setItem('radar:tab', S.tab); } catch { /* private mode */ } S.loaded = false; render(); return refresh(); }
  if (t.closest('[data-close]')) { S.open = null; S.openFmt = null; render(); return; }
  if (t.closest('[data-fclose]')) { S.fsheet = null; render(); return; }
  if (t.closest('[data-close-edit]')) { S.edit = null; render(); return; }
  const f = t.closest('[data-f]');
  if (f && !f.disabled) {
    if (f.dataset.f === 'fm') { S.fmFilter = f.dataset.v; await loadFormats().catch((err) => toast(err.message)); render(); return; }
    if (f.dataset.f === 'adsort') S.adSort = f.dataset.v; else S.filters[f.dataset.f] = f.dataset.v;
    await loadItems().catch((err) => toast(err.message)); render(); return;
  }
  const rd = t.closest('[data-radar]');
  if (rd) { S.filters.radar = S.filters.radar === rd.dataset.radar ? '' : rd.dataset.radar; await loadItems().catch((err) => toast(err.message)); render(); return; }
  const fo = t.closest('[data-fopen]');
  if (fo) { S.open = null; return openFormat(fo.dataset.fopen); }
  const op = t.closest('[data-open]');
  if (op) return openItem(op.dataset.open);
  if (t.closest('[data-analyse]')) return analyseOpen();
  if (t.closest('[data-script]')) return scriptOpen();
  if (t.closest('[data-goscript]')) return S.open?.script_id && showScript(S.open.script_id);
  const gs = t.closest('[data-goscript-id]');
  if (gs) return showScript(gs.dataset.goscriptId);
  const rec = t.closest('[data-record]');
  if (rec) return recordScript(rec.dataset.record);
  if (t.closest('[data-prun]')) {
    S.busy.prun = true; render();
    try { const r = await api('/formats/run', { method: 'POST', body: '{}' }); toast(r.mode === 'workflow' ? 'The analysis is running as a Workflow.' : 'The analysis is running. It carries on in the background.'); await loadFormats(); }
    catch (err) { toast(err.message); }
    finally { S.busy.prun = false; render(); schedulePoll(); }
    return;
  }
  const fa = t.closest('[data-fadapt]');
  if (fa) {
    const id = fa.dataset.fadapt; S.busy.fa = true; render();
    try { const r = await api(`/formats/f/${encodeURIComponent(id)}/adapt`, { method: 'POST', body: '{}' }); if (S.fsheet?.id === id) S.fsheet = { ...S.fsheet, adaptation: r.adaptation, script: r.script }; toast('Adapted for G&L'); loadFormats().then(() => { if (!S.fsheet) render(); }).catch(() => null); }
    catch (err) { toast(err.message); }
    finally { S.busy.fa = false; render(); }
    return;
  }
  if (t.closest('[data-extract]') && S.open) {
    const id = S.open.id; S.busy.ex = true; render();
    try { await api(`/formats/item/${encodeURIComponent(id)}/extract`, { method: 'POST', body: '{}' }); S.openFmt = await api('/formats/item/' + encodeURIComponent(id)); toast('Format read'); }
    catch (err) { toast(err.message); }
    finally { S.busy.ex = false; render(); }
    return;
  }
  if (t.closest('[data-iadapt]') && S.open) {
    const id = S.open.id; S.busy.ia = true; render();
    try { const r = await api(`/formats/item/${encodeURIComponent(id)}/adapt`, { method: 'POST', body: '{}' }); if (S.open?.id === id) S.openFmt = { ...S.openFmt, adaptation: r.adaptation, script: r.script }; toast('Adapted for G&L'); }
    catch (err) { toast(err.message); }
    finally { S.busy.ia = false; render(); }
    return;
  }
  if (t.closest('[data-transcript]') && S.open) {
    S.busy.tr = true; render();
    try { await api(`/items/${encodeURIComponent(S.open.id)}/transcript`, { method: 'POST' }); S.open.transcript_source = 'pending'; toast('Fetching the transcript. It shows here when it lands.'); await loadState(); schedulePoll(); }
    catch (err) { toast(err.message); }
    finally { S.busy.tr = false; render(); }
    return;
  }
  const run = t.closest('[data-run]');
  if (run) {
    const id = run.dataset.run; S.busy['run' + id] = true; render();
    try { const r = await api(`/watchlists/${encodeURIComponent(id)}/run`, { method: 'POST' }); toast(`Started ${r.queued} run${r.queued === 1 ? '' : 's'}, about ${usd(r.est_micros)}.${r.notes?.length ? ' ' + r.notes[0] : ''}`); await loadState(); schedulePoll(); }
    catch (err) { toast(err.message); }
    finally { S.busy['run' + id] = false; render(); }
    return;
  }
  const ed = t.closest('[data-edit]');
  if (ed) { S.edit = { ...(S.state.watchlists.find((w) => w.id === ed.dataset.edit) || {}) }; render(); root.querySelector('[data-edit-form] input')?.focus(); return; }
  if (t.closest('[data-new]')) { S.edit = { platforms: isAds() ? ['meta_ads'] : ['youtube', 'tiktok'], niche: 'in', enabled: true, keywords: [] }; render(); root.querySelector('[data-edit-form] input')?.focus(); return; }
  if (t.closest('[data-del]') && S.edit?.id) {
    const b = t.closest('[data-del]');
    if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Delete for good'; return; }
    try { await api('/watchlists/' + encodeURIComponent(S.edit.id), { method: 'DELETE' }); S.edit = null; toast('Deleted'); await refresh(); } catch (err) { toast(err.message); }
    return;
  }
  // The built-in Sources panel (shown only when /assets/studio-radar-data.js is not there).
  const find = t.closest('[data-find]');
  if (find) {
    const slot = find.dataset.find; S.busy['find' + slot] = true; render();
    try { const r = await api('/sources/find', { method: 'POST', body: JSON.stringify({ slot }) }); toast(`Monid offered ${r.found} tool${r.found === 1 ? '' : 's'}${r.preselected ? '. A known actor is pre-selected' : ''}.`); S.sources = await api('/sources'); await loadState(); }
    catch (err) { toast(err.message); }
    finally { S.busy['find' + slot] = false; render(); }
    return;
  }
  const pv = t.closest('[data-preview]');
  if (pv) {
    const slot = pv.dataset.preview;
    if (S.preview[slot]) { delete S.preview[slot]; render(); return; }
    try { S.preview[slot] = await api('/sources/preview?slot=' + encodeURIComponent(slot)); render(); } catch (err) { toast(err.message); }
    return;
  }
  const cf = t.closest('[data-confirm]');
  if (cf) {
    const slot = cf.dataset.confirm;
    try { await api('/sources/confirm', { method: 'POST', body: JSON.stringify({ slot }) }); toast('Confirmed. Radars can run this source now.'); S.sources = await api('/sources'); await loadState(); S.preview[slot] = await api('/sources/preview?slot=' + encodeURIComponent(slot)); render(); }
    catch (err) { toast(err.message); }
    return;
  }
  const cu = t.closest('[data-custom]');
  if (cu) {
    const slot = cu.dataset.custom;
    const q = (a) => root.querySelector(`[${a}="${slot}"]`)?.value.trim() || '';
    try { await api('/sources/select', { method: 'POST', body: JSON.stringify({ slot, provider: q('data-cprov'), endpoint: q('data-cend'), template: q('data-ctpl') || null }) }); S.sources = await api('/sources'); S.preview[slot] = await api('/sources/preview?slot=' + encodeURIComponent(slot)); await loadState(); render(); toast('Picked. Check the input, then confirm.'); }
    catch (err) { toast(err.message); }
  }
});
root?.addEventListener('toggle', (e) => { if (e.target.matches?.('[data-rail]')) S.railOpen = e.target.open; }, true);
root?.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.matches('[data-sort]')) { S.filters.sort = t.value; await loadItems().catch((err) => toast(err.message)); render(); return; }
  if (t.matches('[data-pick]')) {
    const slot = t.dataset.pick;
    try { await api('/sources/select', { method: 'POST', body: JSON.stringify({ slot, provider: t.dataset.provider, endpoint: t.dataset.endpoint }) }); S.sources = await api('/sources'); S.preview[slot] = await api('/sources/preview?slot=' + encodeURIComponent(slot)); await loadState(); render(); }
    catch (err) { toast(err.message); }
  }
});
root?.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-edit-form]'); if (!form) return;
  e.preventDefault();
  const fd = new FormData(form);
  const body = { name: fd.get('name'), keywords: String(fd.get('keywords') || '').split('\n'), platforms: fd.getAll('platforms'), niche: fd.get('niche'), country: fd.get('country'), since_days: fd.get('since_days'), enabled: fd.get('enabled') === 'on' };
  try {
    await api(S.edit.id ? '/watchlists/' + encodeURIComponent(S.edit.id) : '/watchlists', { method: S.edit.id ? 'PUT' : 'POST', body: JSON.stringify(body) });
    S.edit = null; toast('Saved'); await refresh();
  } catch (err) { toast(err.message); }
});
// A thumbnail that no longer loads (platform CDN links expire) falls back to the quiet empty frame.
root?.addEventListener('error', (e) => { const img = e.target; if (img && img.tagName === 'IMG') img.closest('.rd-thumb, .rd-player, .rd-exthumb')?.classList.add('broken'); }, true);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || root.hidden) return;
  if (S.edit) S.edit = null; else if (S.open) { S.open = null; S.openFmt = null; } else if (S.fsheet) S.fsheet = null; else return;
  render();
});

let started = false;
async function start() {
  if (started) return; started = true;
  const who = await (window.__studioWho = window.__studioWho || fetch('/admin/api/whoami', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({})));
  S.guest = Boolean(who && who.guest);
  render();
  await refresh();
}
// Load when the Radar view is first shown (or straight away when the page opens on it).
window.addEventListener('studio:view', (e) => { if (e.detail?.view === 'radar') start(); });
if (root) render();
if (root && (!root.hidden || location.hash === '#radar')) start();
