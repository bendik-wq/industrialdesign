/**
 * A small Markdown renderer for guide bodies (our own content, but escaped anyway).
 * Supports: ## / ### headings (with ids for jump links), paragraphs, - and 1. lists,
 * **bold**, *italic*, [links](url), | tables |, > callouts.
 */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const slugify = (s: string) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/[’'"]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

const SAFE_HREF = /^(\/[\w\-./#?=&%]*|https:\/\/[\w\-.]+(\/[\w\-./#?=&%~+]*)?|#[\w-]+)$/;

/** Inline formatting on already-escaped text. */
function inline(raw: string): string {
  let s = esc(raw);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, href: string) => {
    const h = href.replace(/&amp;/g, '&');
    if (!SAFE_HREF.test(h)) return text;
    const ext = h.startsWith('https://');
    return `<a href="${esc(h)}"${ext ? ' target="_blank" rel="noopener"' : ''}>${text}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  return s;
}

export interface Heading { id: string; text: string }

export function renderMarkdown(md: string): { html: string; headings: Heading[] } {
  const lines = md.replace(/\r/g, '').split('\n');
  const out: string[] = [];
  const headings: Heading[] = [];
  const used = new Set<string>();
  let i = 0;
  const isBlockStart = (l: string) => /^(#{2,4}\s|[-*]\s|\d+[.)]\s|\||>\s?)/.test(l.trim());
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) { i++; continue; }
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(#{2,4})\s+(.*)$/))) {
      const level = m[1].length;
      let id = slugify(m[2]) || `s${i}`;
      while (used.has(id)) id += '-2';
      used.add(id);
      if (level === 2) headings.push({ id, text: m[2].replace(/\*\*/g, '') });
      out.push(`<h${level} id="${id}">${inline(m[2])}</h${level}>`);
      i++;
    } else if (/^[-*]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i].trim())) items.push(`<li>${inline(lines[i++].trim().slice(2))}</li>`);
      out.push(`<ul>${items.join('')}</ul>`);
    } else if (/^\d+[.)]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+[.)]\s/.test(lines[i].trim())) items.push(`<li>${inline(lines[i++].trim().replace(/^\d+[.)]\s/, ''))}</li>`);
      out.push(`<ol>${items.join('')}</ol>`);
    } else if (line.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cells = lines[i++].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
        rows.push(cells);
      }
      const [head, ...body] = rows;
      out.push(`<div class="table-wrap"><table><thead><tr>${(head ?? []).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    } else if (line.startsWith('>')) {
      const parts: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) parts.push(lines[i++].trim().replace(/^>\s?/, ''));
      out.push(`<aside class="callout">${parts.filter(Boolean).map((p) => `<p>${inline(p)}</p>`).join('')}</aside>`);
    } else {
      const parts: string[] = [];
      while (i < lines.length && lines[i].trim() && !(parts.length && isBlockStart(lines[i]))) parts.push(lines[i++].trim());
      out.push(`<p>${inline(parts.join(' '))}</p>`);
    }
  }
  return { html: out.join('\n'), headings };
}

/** Plain text (for word counts, llms-full.txt previews and descriptions). */
export const stripMarkdown = (md: string) => md.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*#>|]/g, '').replace(/\s+/g, ' ').trim();
