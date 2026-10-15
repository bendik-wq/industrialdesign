import type { Sprint, Topic } from './ideas';

/**
 * Presentation exports for a YouTube sprint.
 *
 * - sprintDocHtml: a designed brief built only from tables, inline colours and font sizes, because that is
 *   what survives a paste (or an HTML upload) into Google Docs. One cover, the data, the binge path,
 *   then one page per video: titles A/B, thumbnail mock-ups, the first 15 seconds, the beats and the close.
 * - sprintPage: the same brief as a full page in Funnel HQ, with buttons to copy it into Google Docs,
 *   print it to PDF or open the Miro board.
 * - buildMiroBoard: lays the sprint out on a new Miro board through the REST API (needs MIRO_ACCESS_TOKEN).
 */

export const INK = '#1F2A44', MUTED = '#5B6478', YELLOW = '#FFD84D', PAPER = '#F4F4EF', ROW = '#FAFAF7';
export const STAGE: Record<Topic['stage'], { faint: string; dark: string; label: string }> = {
  TOFU: { faint: '#EAF1FF', dark: '#2D5BD8', label: 'Top of funnel · get found' },
  MOFU: { faint: '#FFF3DC', dark: '#B4690E', label: 'Middle · build belief' },
  BOFU: { faint: '#E5F6EC', dark: '#13804B', label: 'Bottom · book the call' },
};
export const BELIEF: Record<string, string> = { trust: 'Trust us', like: 'Like us', possible: 'It’s possible', can_solve: 'We can solve it', better: 'Better than the alternative', now: 'Act now' };

export const e = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const unquote = (s: string) => s.replace(/^[“”"]+|[“”"]+$/g, '');
const stageOf = (t: Topic) => STAGE[t.stage] ?? STAGE.MOFU;
export const ordered = (s: Sprint) => {
  const byId = new Map(s.topics.map((t) => [t.id, t]));
  const path = s.binge_path.map((id) => byId.get(id)).filter((t): t is Topic => Boolean(t));
  return [...path, ...s.topics.filter((t) => !path.includes(t))];
};
const nextLabel = (s: Sprint, t: Topic) => {
  const i = ordered(s).findIndex((x) => x.id === t.next_video);
  return i >= 0 ? `Video ${String(i + 1).padStart(2, '0')}` : t.next_video || 'the VSL';
};

export function p(text: string, o: { size?: number; color?: string; bold?: boolean; italic?: boolean; mt?: number; mb?: number; center?: boolean } = {}) {
  const st = [`font-size:${o.size ?? 11}pt`, o.color && o.color !== INK ? `color:${o.color}` : '', o.bold ? 'font-weight:bold' : '', o.italic ? 'font-style:italic' : '',
    o.mt !== undefined || o.mb !== undefined ? `margin:${o.mt ?? 0}pt 0 ${o.mb ?? 6}pt 0` : '', o.center ? 'text-align:center' : ''].filter(Boolean).join(';');
  return `<p style="${st}">${text}</p>`;
}
export function td(content: string, o: { bg?: string; pad?: number; w?: number; border?: number; extra?: string } = {}) {
  const w = o.w ? ` width="${o.w}%"` : '';
  return `<td${w} style="${o.w ? `width:${o.w}%;` : ''}${o.bg ? `background-color:${o.bg};` : ''}padding:${o.pad ?? 14}px;border:${o.border ?? 1}px solid #FFFFFF;vertical-align:top;${o.extra ?? ''}">${content}</td>`;
}
export function table(rows: string, widths?: number[]) {
  const cols = widths ? `<colgroup>${widths.map((w) => `<col width="${w}%">`).join('')}</colgroup>` : '';
  return `<table width="100%" style="width:100%;border-collapse:collapse;">${cols}${rows}</table>`;
}
export const label = (t: string, color: string) => p(e(t.toUpperCase()), { size: 9, color, bold: true, mt: 10, mb: 4 });
export const PAGE_BREAK = '<p style="page-break-before:always;margin:0;"></p>';

/** The brief as Google-Docs-safe HTML (no <html>/<body>). */
export function sprintDocHtml(s: Sprint, created: number, o: { brand?: string; preparedFor?: string; miroUrl?: string | null } = {}) {
  const topics = ordered(s);
  const date = new Date(created).toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' });
  const brand = o.brand || 'G&L M&A Advisory';
  const out: string[] = [];
  out.push(table(`<tr>${td(
    p(`${e(brand.toUpperCase())}  ·  YOUTUBE CONTENT SPRINT`, { size: 9, color: YELLOW, bold: true, mb: 18 }) +
    p(`${topics.length} videos, in binge order`, { size: 30, color: '#FFFFFF', bold: true }) +
    p(`Built from what applicants told us and what already works on the channel. ${e(date)}.`, { size: 13, color: '#D6DBE6', mb: 18 }) +
    p(`Prepared for ${e(o.preparedFor || 'Josh Li')}${o.miroUrl ? `  ·  Live board: <a href="${e(o.miroUrl)}" style="color:${YELLOW};">open in Miro</a>` : ''}`, { size: 10, color: '#D6DBE6' }),
    { bg: INK, pad: 36 })}</tr>`));
  out.push(table(`<tr>${td('', { bg: YELLOW, pad: 3 })}</tr>`));
  out.push(p('', { mb: 10 }));

  const controversial = topics.filter((t) => t.angle === 'controversial').length;
  const minutes = topics.reduce((n, t) => n + (Number(t.length_min) || 0), 0);
  const stages = (['TOFU', 'MOFU', 'BOFU'] as const).map((k) => `${topics.filter((t) => t.stage === k).length} ${k}`).join(' · ');
  const kpis: [string, string][] = [[String(topics.length), 'videos this sprint'], [stages.replace(/ (TOFU|MOFU|BOFU)/g, ''), 'top · middle · bottom of funnel'], [`${controversial}/${topics.length}`, 'controversial angles'], [`${minutes}`, 'minutes of video to film']];
  out.push(table(`<tr>${kpis.map(([n, l]) => td(p(e(n), { size: 24, bold: true, mb: 2 }) + p(e(l), { size: 9, color: MUTED }), { bg: PAPER, pad: 16, w: 25, border: 6 })).join('')}</tr>`, [25, 25, 25, 25]));

  out.push(`<h2 style="color:${INK};font-size:16pt;">The read</h2>`);
  out.push(p(e(s.summary), { mb: 10 }));

  out.push(`<h2 style="color:${INK};font-size:16pt;">The binge path (watch in this order)</h2>`);
  const W = [7, 12, 51, 22, 8];
  let rows = `<tr>${['#', 'Stage', 'Video (title A)', 'Belief it installs', 'Min'].map((h, i) => td(p(h, { size: 9, color: '#FFFFFF', bold: true }), { bg: INK, pad: 8, w: W[i] })).join('')}</tr>`;
  topics.forEach((t, i) => {
    const st = stageOf(t), bg = i % 2 ? ROW : '#FFFFFF';
    rows += `<tr>${td(p(String(i + 1).padStart(2, '0'), { color: st.dark, bold: true }), { bg, pad: 8, w: W[0] })}${td(p(e(t.stage), { size: 9, color: '#FFFFFF', bold: true, center: true }), { bg: st.dark, pad: 8, w: W[1] })}` +
      `${td(p(e(t.titles[0] ?? t.topic), { size: 10, bold: true }) + p(e(t.topic), { size: 9, color: MUTED }), { bg, pad: 8, w: W[2] })}${td(p(e(BELIEF[t.belief] ?? t.belief), { size: 10 }), { bg, pad: 8, w: W[3] })}${td(p(e(t.length_min), { size: 10 }), { bg, pad: 8, w: W[4] })}</tr>`;
  });
  out.push(table(rows, W));
  out.push(p('Each video ends by sending the viewer to the next one; the last one hands off to the VSL.', { size: 9, color: MUTED, italic: true, mt: 6 }));

  topics.forEach((t, i) => {
    const st = stageOf(t);
    out.push(PAGE_BREAK);
    out.push(table(`<tr>${td(p(`VIDEO ${String(i + 1).padStart(2, '0')}  ·  ${e(t.stage)}  ·  ${e(t.length_min)} MIN  ·  ${e(String(t.angle).toUpperCase())}`, { size: 9, color: '#FFFFFF', bold: true, mt: 0, mb: 0 }), { bg: st.dark, pad: 10 })}</tr>`));
    out.push(p(e(t.titles[0] ?? t.topic), { size: 22, bold: true, mt: 14, mb: 4 }));
    out.push(p(e(t.topic), { size: 12, color: MUTED, mt: 0, mb: 10 }));
    out.push(table(`<tr>${td(p(`<b>Why this will work.</b> ${e(t.evidence)}`, { size: 10, mt: 0, mb: 0 }), { bg: st.faint, pad: 12, extra: `border-left:4px solid ${st.dark};` })}</tr>`));
    out.push(label('Title options (A/B test)', st.dark));
    out.push(table(t.titles.slice(0, 2).map((ti, k) => `<tr>${td(p('AB'[k], { size: 12, color: st.dark, bold: true, center: true }), { bg: PAPER, pad: 10, w: 7 })}${td(p(e(ti), { size: 12, bold: true }), { bg: PAPER, pad: 10, w: 93 })}</tr>`).join(''), [7, 93]));
    out.push(label('Thumbnails', st.dark));
    const th = t.thumbnails.slice(0, 2);
    out.push(table(`<tr>${th.map((x) => td(p(e(unquote(x.text)), { size: 20, color: YELLOW, bold: true, center: true, mt: 18, mb: 18 }), { bg: INK, pad: 10, w: 50, border: 6 })).join('')}</tr>` +
      `<tr>${th.map((x) => td(p(`${e(x.visual)} · <i>${e(x.emotion)}</i>`, { size: 9, color: MUTED }), { pad: 6, w: 50 })).join('')}</tr>`, [50, 50]));
    out.push(label('The first 15 seconds', st.dark));
    out.push(table(`<tr>${td(p(`“${e(unquote(t.hook))}”`, { size: 13, italic: true, mt: 0, mb: 0 }), { bg: st.faint, pad: 16 })}</tr>`));
    out.push(label('Who it’s for', st.dark));
    out.push(p(e(t.outline.intro_callouts)));
    out.push(label('The beats', st.dark));
    out.push(table(t.outline.logic_ladder.map((x, k) => `<tr>${td(p(String(k + 1), { color: '#FFFFFF', bold: true, center: true }), { bg: st.dark, pad: 6, w: 7 })}${td(p(e(x)), { bg: ROW, pad: 6, w: 93 })}</tr>`).join(''), [7, 93]));
    out.push(label('Format & proof', st.dark));
    out.push(p(e(t.format), { mt: 0, mb: 2 }));
    out.push(p(e(t.outline.proof), { size: 10, color: MUTED }));
    out.push(p('', { mb: 4 }));
    out.push(table(`<tr>${td(p(`<b>Close:</b> ${e(t.outline.callbacks)}`, { color: '#FFFFFF', mt: 0, mb: 4 }) + p(`<b>CTA (${e(t.cta.type)}):</b> ${e(t.cta.line)}`, { color: '#FFFFFF', mt: 0, mb: 4 }) + p(`<b>Next:</b> ${e(nextLabel(s, t))}`, { color: YELLOW, mt: 0, mb: 0 }), { bg: INK, pad: 16 })}</tr>`));
  });

  if (s.new_angles?.length) {
    out.push(PAGE_BREAK);
    out.push(p('NEXT', { size: 9, color: STAGE.MOFU.dark, bold: true, mt: 0, mb: 2 }));
    out.push(p('New topics to delve into', { size: 22, bold: true, mt: 0, mb: 10 }));
    const NW = [16, 44, 40];
    let r = `<tr>${['Cluster', 'Topic', 'Why'].map((h, i) => td(p(h, { size: 9, color: '#FFFFFF', bold: true }), { bg: INK, pad: 8, w: NW[i] })).join('')}</tr>`;
    s.new_angles.forEach((a, i) => {
      const bg = i % 2 ? ROW : '#FFFFFF';
      r += `<tr>${td(p(e(a.cluster.charAt(0).toUpperCase() + a.cluster.slice(1)), { size: 10, color: STAGE.MOFU.dark, bold: true }), { bg, pad: 8, w: NW[0] })}${td(p(e(a.topic), { size: 10, bold: true }), { bg, pad: 8, w: NW[1] })}${td(p(e(a.why), { size: 9, color: MUTED }), { bg, pad: 8, w: NW[2] })}</tr>`;
    });
    out.push(table(r, NW));
  }
  const c = s.checks;
  if (c) {
    out.push(p(''));
    out.push(table(`<tr>${td(p('<b>Sprint checks</b>', { mt: 0, mb: 4 }) + p(`Controversial: ${e(c.controversial_share)}  ·  Beliefs installed: ${e((c.beliefs_covered ?? []).map((b) => BELIEF[b] ?? b).join(', '))}`, { size: 10, mt: 0, mb: 4 }) +
      (c.gaps ?? []).map((g) => p(`• ${e(g)}`, { size: 10, mt: 0, mb: 2 })).join(''), { bg: STAGE.MOFU.faint, pad: 14 })}</tr>`));
  }
  if (s.outliers?.length) {
    out.push(p('Winning on YouTube right now', { size: 14, bold: true, mt: 14, mb: 6 }));
    out.push(table(s.outliers.slice(0, 10).map((x, i) => `<tr>${td(p(`${e(x.x)}×`, { bold: true, color: STAGE.BOFU.dark }), { bg: i % 2 ? ROW : '#FFFFFF', pad: 6, w: 10 })}${td(p(`<a href="${e(x.url)}">${e(x.title)}</a>`, { size: 10 }) + p(`${e(x.channel)} · ${e(x.views.toLocaleString('en-US'))} views`, { size: 9, color: MUTED }), { bg: i % 2 ? ROW : '#FFFFFF', pad: 6, w: 90 })}</tr>`).join(''), [10, 90]));
  }
  return out.join('\n');
}

/** A designed document as a page in Funnel HQ, with buttons for Google Docs, PDF and Miro. */
export interface ShellAction { url?: string | null; endpoint?: string | null; ready?: boolean }
export function docShell(o: { title: string; barTitle: string; body: string; miro: ShellAction; gdoc: ShellAction }) {
  const btn = (a: ShellAction, kind: 'miro' | 'gdrive', open: string, build: string, connect: string) =>
    a.url ? `<a class="b ghost" href="${e(a.url)}" target="_blank" rel="noopener">${open}</a>`
      : a.ready && a.endpoint ? `<button class="b ghost" type="button" data-${kind}="${e(a.endpoint)}" data-label="${e(build)}" data-open="${e(open)}">${build}</button>`
        : `<a class="b ghost" href="/admin#integrations" title="Connect it under Integrations → Content">${connect}</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${e(o.title)}</title>
<style>
:root{color-scheme:light}
body{margin:0;background:#E9E8E2;font-family:Arial,Helvetica,sans-serif;color:${INK}}
.bar{position:sticky;top:0;z-index:5;background:${INK};color:#fff;box-shadow:0 2px 12px rgba(0,0,0,.18)}
.bar-in{max-width:880px;margin:0 auto;padding:12px 16px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.bar strong{flex:1;min-width:180px;font-size:15px}
.b{border:0;border-radius:8px;padding:9px 14px;font:600 14px Arial,sans-serif;cursor:pointer;text-decoration:none;background:${YELLOW};color:${INK}}
.b.ghost{background:transparent;color:#fff;border:1px solid rgba(255,255,255,.4)}
.b:disabled{opacity:.6;cursor:default}
.msg{max-width:880px;margin:10px auto 0;padding:0 16px;font-size:13px;color:${MUTED}}
.sheet{max-width:816px;margin:16px auto 48px;background:#fff;padding:56px 64px;box-shadow:0 6px 30px rgba(0,0,0,.08);border-radius:4px}
.sheet p{margin:0 0 6pt 0;line-height:1.45}
.sheet table{margin:0}
.sheet a{color:inherit}
@media (max-width:700px){.sheet{padding:24px 16px;margin:8px}}
.ov{position:fixed;inset:0;z-index:20;background:rgba(15,20,35,.55);display:none;align-items:center;justify-content:center;padding:16px}
.ov.on{display:flex}
.card{background:#fff;border-radius:16px;max-width:460px;width:100%;padding:28px 28px 22px;box-shadow:0 24px 60px rgba(0,0,0,.3)}
.card h2{margin:0 0 6px;font-size:22px}
.card .sub{margin:0 0 18px;color:${MUTED};font-size:14px;line-height:1.45}
.step{display:flex;gap:12px;align-items:flex-start;margin:0 0 14px;font-size:15px;line-height:1.4}
.step i{flex:none;width:26px;height:26px;border-radius:50%;background:${INK};color:#fff;font:700 13px/26px Arial;text-align:center;font-style:normal}
.step.done i{background:#1E8E3E}
.card .b{display:block;width:100%;text-align:center;padding:13px;font-size:15px;margin:6px 0 0;box-sizing:border-box}
.card .alt{display:block;margin:14px auto 0;background:none;border:0;color:${MUTED};font:13px Arial;text-decoration:underline;cursor:pointer}
kbd{background:#F1F1EC;border:1px solid #D8D8D0;border-radius:5px;padding:1px 6px;font:600 13px Arial}
@media print{body{background:#fff}.bar,.msg,.ov{display:none}.sheet{box-shadow:none;margin:0;padding:0;max-width:none}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style></head><body>
<div class="bar"><div class="bar-in"><strong>${e(o.barTitle)}</strong>
${btn(o.gdoc, 'gdrive', 'Open the Google Doc', 'Create the Google Doc', 'Connect Google')}<button class="b" type="button" data-gdoc>Copy into Google Docs</button>${btn(o.miro, 'miro', 'Open the Miro board', 'Build the Miro board', 'Connect Miro')}<button class="b ghost" type="button" data-print>Save as PDF</button></div></div>
<p class="msg" data-msg>To get this into Google Docs: press “Copy into Google Docs”, then follow the two steps.</p>
<div class="ov" data-ov role="dialog" aria-modal="true" aria-labelledby="ovh"><div class="card">
<h2 id="ovh" data-ovh>Copied ✓</h2><p class="sub" data-ovs>The whole document, with its design, is on your clipboard.</p>
<p class="step done" data-s1><i>1</i><span>Copied this document.</span></p>
<p class="step"><i>2</i><span>Open a blank Google Doc and paste: <kbd>⌘V</kbd> on Mac, <kbd>Ctrl V</kbd> on Windows.</span></p>
<a class="b" href="https://docs.new" target="_blank" rel="noopener" data-ovgo>Open a blank Google Doc</a>
<button class="b ghost" type="button" data-dl style="color:${INK};border-color:#D8D8D0">Or download it for Google Drive</button>
<button class="alt" type="button" data-ovx>Close</button>
</div></div>
<main class="sheet" data-doc>${o.body}</main>
<script src="/assets/brief.js" defer></script></body></html>`;
}

export function sprintPage(s: Sprint, created: number, o: { id: string; brand?: string; miroUrl?: string | null; miroReady?: boolean }) {
  return docShell({
    title: `YouTube sprint · ${new Date(created).toISOString().slice(0, 10)}`, barTitle: `YouTube sprint · ${s.topics.length} videos`, body: sprintDocHtml(s, created, o),
    miro: { url: o.miroUrl, ready: o.miroReady, endpoint: `/admin/api/yt/sprints/${encodeURIComponent(o.id)}/miro` }, gdoc: { ready: false },
  });
}

// ───────────── Miro ─────────────

type MiroItem = { type: 'shape' | 'text' | 'sticky_note'; data: Record<string, unknown>; style?: Record<string, unknown>; position: { x: number; y: number; origin?: 'center' }; geometry?: { width?: number; height?: number } };

/** Pure layout (testable): every item on the board, in creation order, plus which items the arrows join. */
export function miroLayout(s: Sprint, created: number) {
  const topics = ordered(s);
  const items: MiroItem[] = [];
  const CW = 440, GAP = 80, X0 = 0;
  const colX = (i: number) => X0 + i * (CW + GAP) + CW / 2;
  const width = topics.length * (CW + GAP) - GAP;
  const shape = (x: number, y: number, w: number, h: number, content: string, style: Record<string, unknown>) =>
    items.push({ type: 'shape', data: { shape: 'round_rectangle', content }, style: { borderOpacity: '0', fontFamily: 'open_sans', ...style }, position: { x, y, origin: 'center' }, geometry: { width: w, height: h } }) - 1;
  const text = (x: number, y: number, w: number, content: string, size: number, color = INK) =>
    items.push({ type: 'text', data: { content }, style: { fontSize: String(size), color, fontFamily: 'open_sans', textAlign: 'left' }, position: { x: x + w / 2, y, origin: 'center' }, geometry: { width: w } }) - 1;

  text(X0, -260, Math.min(width, 2400), `<p><strong>YouTube sprint · ${e(new Date(created).toISOString().slice(0, 10))}</strong></p>`, 64);
  text(X0, -180, Math.min(width, 2400), `<p>${e(topics.length)} videos in binge order. Each one sends the viewer to the next; the last hands off to the VSL.</p>`, 24, MUTED);
  text(X0, -110, Math.min(width, 2800), `<p>${e(s.summary)}</p>`, 16, MUTED);

  const heads: number[] = [];
  topics.forEach((t, i) => {
    const st = stageOf(t);
    heads.push(shape(colX(i), 0, CW, 64, `<p><strong>${String(i + 1).padStart(2, '0')} · ${e(t.stage)}</strong> · ${e(t.angle)} · ${e(t.length_min)} min</p>`, { fillColor: st.dark, color: '#ffffff', fontSize: '18' }));
    const body = [`<p><strong>${e(t.titles[0] ?? t.topic)}</strong></p>`, `<p>B: ${e(t.titles[1] ?? '')}</p>`, '<p></p>',
      `<p><strong>Thumbnails:</strong> “${e(unquote(t.thumbnails[0]?.text ?? ''))}” · “${e(unquote(t.thumbnails[1]?.text ?? ''))}”</p>`, '<p></p>',
      `<p><strong>Hook:</strong> <em>${e(unquote(t.hook))}</em></p>`, '<p></p>', '<p><strong>Beats</strong></p>',
      ...t.outline.logic_ladder.map((x, k) => `<p>${k + 1}. ${e(x)}</p>`), '<p></p>',
      `<p><strong>Belief:</strong> ${e(BELIEF[t.belief] ?? t.belief)}</p>`, `<p><strong>CTA (${e(t.cta.type)}):</strong> ${e(t.cta.line)}</p>`].join('');
    shape(colX(i), 60 + 560, CW, 1080, body, { fillColor: st.faint, color: INK, fontSize: '16', textAlign: 'left', textAlignVertical: 'top' });
  });
  const legendY = -40;
  (['TOFU', 'MOFU', 'BOFU'] as const).forEach((k, i) => shape(X0 + 160 + i * 340, legendY, 320, 44, `<p><strong>${k}</strong> ${e(STAGE[k].label)}</p>`, { fillColor: STAGE[k].faint, color: STAGE[k].dark, fontSize: '14' }));

  const yIdeas = 1300;
  if (s.new_angles?.length) {
    text(X0, yIdeas, 1600, '<p><strong>New topics to delve into next</strong></p>', 40);
    s.new_angles.forEach((a, i) => items.push({ type: 'sticky_note', data: { content: `<p><strong>${e(a.topic)}</strong></p><p>${e(a.why)}</p>`, shape: 'rectangle' }, style: { fillColor: 'light_yellow', textAlign: 'left', textAlignVertical: 'top' },
      position: { x: X0 + (i % 5) * 460 + 210, y: yIdeas + 220 + Math.floor(i / 5) * 300, origin: 'center' }, geometry: { width: 420 } }));
  }
  return { items, arrows: heads.slice(1).map((h, i) => [heads[i], h] as const) };
}

/** Creates the board and returns its link. Uses the bulk endpoint so a whole sprint is ~10 requests. */
export async function buildMiroBoard(token: string, s: Sprint, created: number, name: string, fetcher: typeof fetch = fetch) {
  const api = async (path: string, body: unknown) => {
    const r = await fetcher(`https://api.miro.com/v2${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) throw new Error(`Miro ${r.status}: ${String(j.message ?? j.code ?? 'request failed')}`);
    return j;
  };
  const board = await api('/boards', { name: name.slice(0, 60), description: 'YouTube sprint from Funnel HQ' });
  const id = String(board.id);
  const { items, arrows } = miroLayout(s, created);
  const ids: string[] = [];
  for (let i = 0; i < items.length; i += 20) {
    const res = await api(`/boards/${encodeURIComponent(id)}/items/bulk`, items.slice(i, i + 20));
    for (const it of (res.data as { id: string }[] | undefined) ?? []) ids.push(String(it.id));
  }
  for (const [a, b] of arrows) {
    if (!ids[a] || !ids[b]) continue;
    await api(`/boards/${encodeURIComponent(id)}/connectors`, { startItem: { id: ids[a], snapTo: 'right' }, endItem: { id: ids[b], snapTo: 'left' }, shape: 'straight', style: { strokeColor: INK, strokeWidth: '3', endStrokeCap: 'stealth' } });
  }
  return String(board.viewLink ?? `https://miro.com/app/board/${id}/`);
}
