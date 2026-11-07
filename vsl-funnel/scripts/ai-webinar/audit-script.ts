// Copy audit for the AI-edition scripts: every spoken line and every on-screen line through auditCopy
// (src/content/copy-rules.ts), plus the house rules auditCopy doesn't cover on its own.
//   npx vite-node scripts/ai-webinar/audit-script.ts            (both scripts; exits 1 on any flag)
// The scripts are parsed by build.py --dump, so margin notes (<!-- -->) and bracketed owner notes are left out
// exactly as the build leaves them out.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditCopy } from '../../src/content/copy-rules';
import { extra } from './copy-house';

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Seg = { chapter: string; slide: string; onscreen: string[]; text: string; cues: string[]; layout: string; data: string[]; image: string | null; caption: string | null; kicker: string | null };

const spoken = (t: string) => t.replace(/<break[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
let flags = 0;
for (const file of ['script-ai.md', 'script-ai-josh.md']) {
  const segs: Seg[] = JSON.parse(execFileSync('python3', [path.join(HERE, 'build.py'), '--dump', '--script', file], { encoding: 'utf8', maxBuffer: 64 << 20 }));
  const bySlide = new Map<string, Seg[]>();
  for (const s of segs) bySlide.set(s.slide, [...(bySlide.get(s.slide) ?? []), s]);
  const issues: string[] = [];
  const all = segs.map((s) => spoken(s.text)).join(' ');
  if (file === 'script-ai.md' && !/narrated by an AI voice/.test(all)) issues.push('AI narrator disclosure missing');
  if (file === 'script-ai-josh.md' && !/AI version of my voice/.test(all)) issues.push('AI voice disclosure missing');
  if (!segs.some((s) => /^Education only/.test(s.slide))) issues.push('education-only slide missing');
  let words = 0;
  for (const [slide, group] of bySlide) {
    const s0 = group[0];
    // Each on-screen line on its own: the title, the subtitle, every [ON SCREEN] line, every [DATA] cell, the caption, the kicker.
    const screen = [...slide.split(' | '), ...s0.onscreen, ...s0.data.flatMap((d) => d.split('|').map((x) => x.trim())), s0.caption ?? '', s0.kicker ?? ''].filter(Boolean);
    const ctx = [...screen, ...group.map((g) => spoken(g.text))].join(' ');
    for (const g of group) {
      const t = spoken(g.text);
      words += t.split(/\s+/).filter(Boolean).length;
      for (const i of auditCopy(t)) issues.push(`[spoken] ${slide.slice(0, 50)}: ${i.rule}: ${i.excerpt}`);
      issues.push(...extra(t, `[spoken] ${slide.slice(0, 50)}`, ctx));
    }
    for (const line of screen) {
      for (const i of auditCopy(line)) issues.push(`[screen] ${slide.slice(0, 50)}: ${i.rule}: ${i.excerpt}`);
      issues.push(...extra(line, `[screen] ${slide.slice(0, 50)}`, ctx));
    }
  }
  console.log(`${file}: ${segs.length} segments, ${bySlide.size} slides, ${words} spoken words, ${issues.length} flags`);
  for (const i of issues) console.log('  ' + i);
  flags += issues.length;
}
process.exit(flags ? 1 : 0);
