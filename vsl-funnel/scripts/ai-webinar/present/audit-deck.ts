// Copy audit for the presented deck: every line the deck shows (its final build, from present/out/deck-text.json,
// written by export.mjs) through auditCopy and the house rules (copy-house.ts), with the slide's own spoken words as
// the context for "illustrative" and "seller rollover", exactly as audit-script.ts does for the video slides.
//   npx vite-node scripts/ai-webinar/present/audit-deck.ts      (exits 1 on any flag)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditCopy } from '../../../src/content/copy-rules';
import { extra } from '../copy-house';
import { DECK_DATA } from '../../../src/admin/deck-data';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const shown: { n: number; lines: string[]; svg: string[] }[] = JSON.parse(fs.readFileSync(path.join(HERE, 'out', 'deck-text.json'), 'utf8'));
// Chrome on every slide (brand, title, presenter, slide number) is checked once, not 203 times.
const CHROME = new Set([DECK_DATA.title, DECK_DATA.brand, DECK_DATA.presenter]);
const issues: string[] = [];
let lines = 0;
if (shown.length !== DECK_DATA.slides.length) issues.push(`deck-text.json has ${shown.length} slides, the deck ${DECK_DATA.slides.length}: rerun export.mjs`);
for (const c of CHROME) for (const i of auditCopy(c)) issues.push(`[chrome] ${i.rule}: ${i.excerpt}`);
for (const c of DECK_DATA.chapters) for (const i of auditCopy(c.title)) issues.push(`[chapter ${c.n}] ${i.rule}: ${i.excerpt}`);
for (const sl of shown) {
  const s = DECK_DATA.slides[sl.n - 1];
  // As typed in the script: the deck's typographic quotes and non-breaking hyphens back to plain ones. The chapter
  // label ("04 · How a business pays for itself", "Chapter 04 · ...") is the script's chapter heading, as on the video.
  const plain = (l: string) => l.replace(/\u2011/g, '-').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\u00a0/g, ' ');
  const all = [...sl.lines, ...sl.svg].map(plain).filter((l) => !CHROME.has(l) && !/^\d{1,3}$/.test(l) && !/^(Chapter )?\d\d · /i.test(l));
  const ctx = [...all, ...s.notes.map((p) => p.text)].join(' ');
  for (const line of all) {
    lines++;
    for (const i of auditCopy(line)) issues.push(`[${sl.n} ${s.title.slice(0, 40)}] ${i.rule}: ${i.excerpt}`);
    issues.push(...extra(line, `[${sl.n} ${s.title.slice(0, 40)}]`, ctx));
  }
}
console.log(`deck: ${shown.length} slides, ${lines} on-screen lines, ${issues.length} flags`);
for (const i of issues) console.log('  ' + i);
process.exit(issues.length ? 1 : 0);
