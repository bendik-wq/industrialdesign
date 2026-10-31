import { describe, expect, it } from 'vitest';
import { auditCopy } from '../src/content/copy-rules';
import { MATERIAL_IDS, parseMaterial, toSec } from '../src/admin/materials';

// The project has no @types/node, so the two fs calls used are typed here (as in webinar-pass.test.ts).
const node = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown; cwd(): string } }).process;
const fs = node.getBuiltinModule('node:fs') as { readdirSync(p: string): string[]; readFileSync(p: string, enc: string): string };
const DIR = `${node.cwd()}/public/materials`;
const files: string[] = fs.readdirSync(DIR).filter((f) => f.endsWith('.md') && !['challenge-emails.md', 'challenge-homework.md'].includes(f)); // the emails and worksheets are reference copy, not scripts
const load = (f: string) => parseMaterial(fs.readFileSync(`${DIR}/${f}`, 'utf8'));

// The guarantee's conditions, said out loud wherever the deposit is sold (see the shared brief).
const CONDITIONS: [string, RegExp][] = [
  ['kickoff and financials within 7 days', /(seven|7) days/i],
  ['the last two years of financials', /two years of (your )?financials/i],
  ['weekly working sessions, miss no more than two', /miss no more than two/i],
  ['25 owner contacts a week', /(twenty-five|25) owner/i],
  ['reply within 2 business days', /(two|2) business days/i],
  ['the buy box and the 1.5x test', /buy box/i],
  ['what an LOI means', /non-binding/i],
  ['no promise of financing, a closed deal or a return', /doesn't promise financing/i],
];
const GUARANTEE = "If you don't have a signed letter of intent within 90 days, Josh's team keeps working with you at no extra cost until you do. Or, if you prefer, take a full refund of everything you paid.";

describe('materials format', () => {
  it('parses chapters, slides, cues and timing', () => {
    const m = parseMaterial(`---
title: Test
funnel: live   # comment
day: 2
duration_min: 10
offer: deposit
---
## [00:00] Open
[SLIDE: Hello | a subtitle]
[ON SCREEN: line one]
${'word '.repeat(140)}

[HOST: OPEN OFFER]
[NOTE: read the chat]
## [05:00] Next
[SLIDE: Second]
Two words.
`);
    expect(m.meta).toMatchObject({ title: 'Test', funnel: 'live', day: 2, duration_min: 10, offer: 'deposit' });
    expect(m.chapters.map((c) => [c.title, c.at, c.words])).toEqual([['Open', '00:00', 140], ['Next', '05:00', 2]]);
    expect(m.slides).toHaveLength(2);
    expect(m.slides[0]).toMatchObject({ title: 'Hello', sub: 'a subtitle', onscreen: ['line one'], at: '00:00' });
    expect(m.slides[0].notes).toHaveLength(1);
    expect(m.slides[1]).toMatchObject({ title: 'Second', at: '05:00', notes: ['Two words.'] });
    expect(m.cues).toEqual([{ at: '01:00', sec: 60, action: 'OPEN OFFER', slide: 0, chapter: 0 }]);
    expect(m.words).toBe(142);
    expect(toSec('105:30')).toBe(6330);
  });

  it('lists every material file in MATERIAL_IDS so Funnel HQ shows it', () => {
    for (const f of files) expect(MATERIAL_IDS as readonly string[], f).toContain(f.replace(/\.md$/, ''));
  });
});

describe.each(files)('%s', (file) => {
  const m = load(file);

  it('has a title, a funnel, a duration, chapters and slides', () => {
    expect(m.meta.title).not.toBe('');
    expect(m.meta.funnel).not.toBe('');
    expect(m.meta.duration_min).toBeGreaterThan(0);
    expect(m.chapters.length).toBeGreaterThan(1);
    expect(m.slides.length).toBeGreaterThan(3);
    expect(m.words).toBeGreaterThan(500);
    if (m.meta.funnel === 'challenge') expect(m.meta.day).toBeGreaterThanOrEqual(1);
  });

  it('passes the copy audit, paragraph by paragraph', () => {
    const bad: string[] = [];
    for (const c of m.chapters) for (const b of c.blocks) {
      if (b.type !== 'para') continue;
      const issues = auditCopy(b.text);
      if (/—/.test(b.text)) issues.push({ rule: 'em dash', excerpt: b.text.slice(0, 80) });
      if (/\bfree\b/i.test(b.text) && /\b(call|session|consult)/i.test(b.text) && !/no extra cost/i.test(b.text)) issues.push({ rule: 'never "free" near a call', excerpt: b.text.slice(0, 80) });
      for (const i of issues) bad.push(`${c.at} ${c.title}: ${i.rule}: ${i.excerpt}`);
    }
    expect(bad).toEqual([]);
  });

  it('keeps slide and on-screen text clean too', () => {
    const bad: string[] = [];
    // The automated-webinar copies mirror their source scripts, so only the basics are checked there; live and challenge
    // decks are new copy and pass the full audit (write lists on a slide with " · " between items, not as short sentences).
    const full = m.meta.funnel === 'live' || m.meta.funnel === 'challenge';
    for (const s of m.slides) for (const t of [s.title, s.sub, ...s.onscreen]) {
      if (/—/.test(t) || /\p{Extended_Pictographic}/u.test(t) || /!/.test(t)) bad.push(`${s.at} ${t}`);
      if (full) for (const i of auditCopy(t)) bad.push(`${s.at} ${i.rule}: ${t}`);
    }
    // Pinned messages are shown to viewers too.
    for (const c of m.cues) if (/^PIN /.test(c.action)) {
      const t = c.action.slice(4);
      if (/—/.test(t)) bad.push(`${c.at} em dash: ${t}`);
      for (const i of auditCopy(t)) bad.push(`${c.at} ${i.rule}: ${t}`);
    }
    expect(bad).toEqual([]);
  });

  if (m.meta.offer === 'deposit') {
    it('opens the offer from the host console and states the guarantee with its conditions', () => {
      expect(m.cues.some((c) => c.action === 'OPEN OFFER')).toBe(true);
      const spoken = m.chapters.flatMap((c) => c.blocks).filter((b) => b.type === 'para').map((b) => (b as { text: string }).text).join('\n').replace(/[’‘]/g, "'");
      expect(spoken).toContain(GUARANTEE);
      for (const [label, re] of CONDITIONS) expect(re.test(spoken), label).toBe(true);
    });
  }
});
