// A tiny document model with two renderers: HTML (browser preview, copy and paste) and
// RTF (Google Docs import). Google Docs drops page breaks and custom fonts from HTML,
// but keeps them from RTF, along with rows that never split across pages.

export type Run = { text: string; bold?: boolean; italic?: boolean; color?: string; link?: string };
export type Para = {
  kind: 'p'; runs: Run[]; size: number; color: string; bold?: boolean; italic?: boolean;
  lh?: number; before?: number; after?: number; center?: boolean; keepNext?: boolean;
};
export type Cell = { paras: Para[]; bg?: string; pad?: [number, number, number, number]; rule?: { top?: boolean; bottom?: boolean } };
export type Table = { kind: 'table'; widths: number[]; rows: { cells: Cell[]; keep?: boolean }[]; rule?: string };
export type Block = Para | Table | { kind: 'break' };

export const FONT = 'Inter';
const STACK = `${FONT},-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif`;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ───────────── HTML ─────────────

function paraHtml(p: Para) {
  const st = [`font-family:${STACK}`, `font-size:${p.size}pt`, `color:${p.color}`, p.bold ? 'font-weight:bold' : '', p.italic ? 'font-style:italic' : '',
    `line-height:${p.lh ?? 1.4}`, `margin:${p.before ?? 0}pt 0 ${p.after ?? 0}pt 0`, p.center ? 'text-align:center' : ''].filter(Boolean).join(';');
  const runs = p.runs.map((r) => {
    const s = [r.bold ? 'font-weight:bold' : '', r.italic ? 'font-style:italic' : '', r.color ? `color:${r.color}` : ''].filter(Boolean).join(';');
    const t = esc(r.text) || '&nbsp;';
    const inner = s ? `<span style="${s}">${t}</span>` : t;
    return r.link ? `<a href="${esc(r.link)}" style="color:inherit">${inner}</a>` : inner;
  }).join('');
  return `<p style="${st}">${runs}</p>`;
}

function tableHtml(t: Table) {
  const line = t.rule ?? '#D2D2D7';
  const cols = `<colgroup>${t.widths.map((w) => `<col width="${w}%">`).join('')}</colgroup>`;
  const rows = t.rows.map((r) => `<tr>${r.cells.map((c, i) => {
    const [pt, pr, pb, pl] = c.pad ?? [0, 0, 0, 0];
    const side = (on?: boolean) => (on ? `1px solid ${line}` : `0px solid ${c.bg ?? '#FFFFFF'}`);
    const st = `width:${t.widths[i]}%;${c.bg ? `background-color:${c.bg};` : ''}padding:${pt}pt ${pr}pt ${pb}pt ${pl}pt;border-top:${side(c.rule?.top)};border-bottom:${side(c.rule?.bottom)};border-left:0px solid #FFFFFF;border-right:0px solid #FFFFFF;vertical-align:top;`;
    return `<td width="${t.widths[i]}%" style="${st}">${c.paras.map(paraHtml).join('')}</td>`;
  }).join('')}</tr>`).join('');
  return `<table width="100%" style="width:100%;border-collapse:collapse;">${cols}${rows}</table>`;
}

export function toHtml(blocks: Block[]) {
  return blocks.map((b) => (b.kind === 'p' ? paraHtml(b) : b.kind === 'table' ? tableHtml(b) : '<p style="page-break-before:always;margin:0;"></p>')).join('\n');
}

// ───────────── RTF ─────────────

const PAGE_W = 12240, PAGE_H = 15840, MARGIN_X = 1440, MARGIN_Y = 1296;
export const CONTENT_W = PAGE_W - 2 * MARGIN_X;
const tw = (pt: number) => Math.round(pt * 20);

function rtfText(s: string) {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '\\' || ch === '{' || ch === '}') out += `\\${ch}`;
    else if (ch === '\n') out += '\\line ';
    else if (c < 128) out += ch;
    else if (c < 0x10000) out += `\\u${c > 32767 ? c - 65536 : c}?`;
    else {
      const v = c - 0x10000, hi = 0xd800 + (v >> 10), lo = 0xdc00 + (v & 0x3ff);
      out += `\\u${hi - 65536}?\\u${lo - 65536}?`;
    }
  }
  return out;
}

export function toRtf(blocks: Block[]) {
  const colors: string[] = [];
  const cf = (hex: string) => {
    const h = hex.toUpperCase();
    let i = colors.indexOf(h);
    if (i < 0) i = colors.push(h) - 1;
    return i + 1;
  };
  const para = (p: Para, end: '\\par' | '\\cell', inTable: boolean, breakBefore: boolean) => {
    const lh = Math.round((p.lh ?? 1.4) * 240);
    const pPr = `\\pard\\plain${inTable ? '\\intbl' : ''}${breakBefore ? '\\pagebb' : ''}${p.keepNext ? '\\keepn' : ''}${p.center ? '\\qc' : '\\ql'}\\sb${tw(p.before ?? 0)}\\sa${tw(p.after ?? 0)}\\sl${lh}\\slmult1`;
    const base = `\\f0\\fs${Math.round(p.size * 2)}\\cf${cf(p.color)}${p.bold ? '\\b' : ''}${p.italic ? '\\i' : ''}`;
    const runs = p.runs.map((r) => {
      const fmt = `${r.bold ? '\\b' : ''}${r.italic ? '\\i' : ''}${r.color ? `\\cf${cf(r.color)}` : ''}`;
      const t = `{${fmt}${fmt ? ' ' : ''}${rtfText(r.text)}}`;
      return r.link ? `{\\field{\\*\\fldinst{HYPERLINK "${r.link.replace(/["\\{}]/g, '')}"}}{\\fldrslt${t}}}` : t;
    }).join('');
    return `${pPr}{${base} ${runs}}${end}\n`;
  };
  const out: string[] = [];
  let pendingBreak = false;
  for (const b of blocks) {
    if (b.kind === 'break') { pendingBreak = true; continue; }
    if (b.kind === 'p') { out.push(para(b, '\\par', false, pendingBreak)); pendingBreak = false; continue; }
    if (pendingBreak) { out.push(`\\pard\\plain\\pagebb\\sb0\\sa0\\sl20\\slmult0{\\fs2 }\\par\n`); pendingBreak = false; }
    const line = cf(b.rule ?? '#D2D2D7');
    for (const r of b.rows) {
      let x = 0;
      const defs = r.cells.map((c, i) => {
        x += Math.round((CONTENT_W * b.widths[i]) / 100);
        const [pt, pr, pb, pl] = c.pad ?? [0, 0, 0, 0];
        const side = (s: string, on?: boolean) => (on ? `\\clbrdr${s}\\brdrs\\brdrw10\\brdrcf${line}` : `\\clbrdr${s}\\brdrnone`);
        return `\\clvertalt${side('t', c.rule?.top)}${side('l')}${side('b', c.rule?.bottom)}${side('r')}${c.bg ? `\\clcbpat${cf(c.bg)}` : ''}` +
          `\\clpadt${tw(pt)}\\clpadft3\\clpadr${tw(pr)}\\clpadfr3\\clpadb${tw(pb)}\\clpadfb3\\clpadl${tw(pl)}\\clpadfl3\\cellx${x}`;
      }).join('');
      const p0 = r.cells[0]?.pad ?? [0, 0, 0, 0];
      out.push(`\\trowd\\trgaph0\\trleft0${r.keep ? '\\trkeep' : ''}\\trpaddt${tw(p0[0])}\\trpaddft3\\trpaddr${tw(p0[1])}\\trpaddfr3\\trpaddb${tw(p0[2])}\\trpaddfb3\\trpaddl${tw(p0[3])}\\trpaddfl3${defs}\n`);
      for (const c of r.cells) {
        const ps = c.paras.length ? c.paras : [{ kind: 'p', runs: [{ text: '' }], size: 2, color: '#FFFFFF' } as Para];
        ps.forEach((p, k) => out.push(para(p, k === ps.length - 1 ? '\\cell' : '\\par', true, false)));
      }
      out.push('\\row\n');
    }
  }
  const tbl = colors.map((h) => `\\red${parseInt(h.slice(1, 3), 16)}\\green${parseInt(h.slice(3, 5), 16)}\\blue${parseInt(h.slice(5, 7), 16)};`).join('');
  return `{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1{\\fonttbl{\\f0\\fswiss\\fcharset0 ${FONT};}}{\\colortbl;${tbl}}\n` +
    `\\paperw${PAGE_W}\\paperh${PAGE_H}\\margl${MARGIN_X}\\margr${MARGIN_X}\\margt${MARGIN_Y}\\margb${MARGIN_Y}\\widowctrl\n${out.join('')}}`;
}
