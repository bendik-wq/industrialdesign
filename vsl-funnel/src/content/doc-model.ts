// A tiny document model with two renderers: HTML (browser preview, copy and paste) and
// RTF (Google Docs import). Google Docs drops page breaks and custom fonts from HTML,
// but keeps them from RTF, along with rows that never split across pages.
// What Google Docs keeps from RTF (verified by round-tripping test documents):
//   fonts, sizes, colours, bold/italic, spacing, line height, left/right indents, page
//   breaks, unsplittable rows, cell shading, and paragraph borders (as horizontal rules).
// What it drops: table borders (always 1pt black, so tables are only used for black cards),
// paragraph shading, tab stops, and \uN escapes (so text is encoded as cp1252).

export type Run = { text: string; bold?: boolean; italic?: boolean; color?: string; link?: string };
export type Para = {
  kind: 'p'; runs: Run[]; size: number; color: string; bold?: boolean; italic?: boolean;
  lh?: number; before?: number; after?: number; center?: boolean; keepNext?: boolean;
  /** A hairline above or below the paragraph (Google Docs turns these into horizontal rules). */
  ruleAbove?: boolean; ruleBelow?: boolean; indent?: number; indentRight?: number;
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
    `line-height:${p.lh ?? 1.4}`, `margin:${p.before ?? 0}pt ${p.indentRight ?? 0}pt ${p.after ?? 0}pt ${p.indent ?? 0}pt`, p.center ? 'text-align:center' : '',
    p.ruleAbove ? `border-top:1px solid #D2D2D7;padding-top:7pt` : '', p.ruleBelow ? `border-bottom:1px solid #D2D2D7;padding-bottom:7pt` : ''].filter(Boolean).join(';');
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

// Unicode → Windows-1252 for the characters that differ from Latin-1.
const CP1252: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};
// Anything else outside Windows-1252 gets a plain stand-in rather than a garbled glyph.
const FALLBACK: Record<string, string> = { '→': '->', '←': '<-', '≈': '~', '≠': 'is not', '×': 'x', '≥': '>=', '≤': '<=', '☐': '', '✓': '', '✔': '', '−': '-', '\u00a0': ' ', '\u2009': ' ', '\u202f': ' ' };

function rtfText(s: string) {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '\\' || ch === '{' || ch === '}') out += `\\${ch}`;
    else if (ch === '\n') out += '\\line ';
    else if (c < 128) out += ch;
    else if (c < 256 && c >= 0xa0) out += `\\'${c.toString(16)}`;
    else if (CP1252[c]) out += `\\'${CP1252[c].toString(16)}`;
    else out += FALLBACK[ch] ?? '?';
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
    const rule = (side: 't' | 'b') => `\\brdr${side}\\brdrs\\brdrw10\\brdrcf${cf('#D2D2D7')}\\brsp80`;
    const pPr = `\\pard\\plain${inTable ? '\\intbl' : ''}${breakBefore ? '\\pagebb' : ''}${p.keepNext ? '\\keepn' : ''}${p.center ? '\\qc' : '\\ql'}` +
      `${p.indent ? `\\li${tw(p.indent)}` : ''}${p.indentRight ? `\\ri${tw(p.indentRight)}` : ''}${p.ruleAbove ? rule('t') : ''}${p.ruleBelow ? rule('b') : ''}` +
      `\\sb${tw(p.before ?? 0)}\\sa${tw(p.after ?? 0)}\\sl${lh}\\slmult1`;
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
