import { describe, expect, it } from 'vitest';
import { auditCopy } from '../src/content/copy-rules';

// The five live sessions of "The First Deal Challenge" are content files: scripts that double as
// slide decks and run sheets. This test parses them with its own small parser (frontmatter,
// `## [mm:ss]` chapters, cue lines, spoken paragraphs) so it doesn't depend on the viewer's code.

// The project has no @types/node, so the one fs call used is typed here (as in webinar-pass.test.ts).
const node = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown; cwd(): string } }).process;
const fs = node.getBuiltinModule('node:fs') as { readFileSync(p: string, enc: string): string };
const DIR = `${node.cwd()}/public/materials`;
const read = (f: string) => fs.readFileSync(`${DIR}/${f}`, 'utf8');

type Chapter = { at: string; title: string; cues: string[]; spoken: string[] };
type Script = { meta: Record<string, string>; chapters: Chapter[] };

function parse(src: string): Script {
  const m = src.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error('missing frontmatter');
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z_]+):\s*(.*?)\s*(#.*)?$/);
    if (kv) meta[kv[1]] = kv[2];
  }
  const chapters: Chapter[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length && chapters.length) chapters[chapters.length - 1].spoken.push(para.join('\n')); para = []; };
  for (const raw of m[2].split('\n')) {
    const line = raw.trim();
    const h = line.match(/^## \[(\d{2,3}:\d{2})\]\s+(.+)$/);
    if (h) { flush(); chapters.push({ at: h[1], title: h[2], cues: [], spoken: [] }); continue; }
    if (!line) { flush(); continue; }
    if (line.startsWith('[')) { flush(); if (chapters.length) chapters[chapters.length - 1].cues.push(line); continue; }
    if (line.startsWith('#')) throw new Error(`unexpected heading: ${line}`);
    para.push(line);
  }
  flush();
  return { meta, chapters };
}

const wordsOf = (s: Script) => s.chapters.flatMap((c) => c.spoken).join(' ').split(/\s+/).filter(Boolean).length;
const spokenText = (s: Script) => s.chapters.flatMap((c) => c.spoken).join('\n').replace(/[’‘]/g, "'");
const cues = (s: Script) => s.chapters.flatMap((c) => c.cues);
const secs = (at: string) => { const [m, s] = at.split(':').map(Number); return m * 60 + s; };

const days = [1, 2, 3, 4, 5].map((d) => ({ d, s: parse(read(`challenge-day-${d}.md`)) }));

describe('challenge session scripts', () => {
  it('have the frontmatter the viewer reads', () => {
    for (const { d, s } of days) {
      for (const k of ['title', 'funnel', 'day', 'duration_min', 'offer']) expect(s.meta[k], `day ${d} ${k}`).toBeTruthy();
      expect(s.meta.funnel).toBe('challenge');
      expect(Number(s.meta.day)).toBe(d);
      expect(s.meta.title).toContain(`Day ${d}`);
      expect(Number(s.meta.duration_min)).toBeGreaterThanOrEqual(60);
      expect(s.meta.offer).toBe(d <= 3 ? 'none' : d === 4 ? 'soft' : 'deposit');
    }
  });

  it('run in order, chapter by chapter, starting at 00:00', () => {
    for (const { d, s } of days) {
      expect(s.chapters.length, `day ${d}`).toBeGreaterThanOrEqual(6);
      expect(s.chapters[0].at).toBe('00:00');
      for (let i = 1; i < s.chapters.length; i++) expect(secs(s.chapters[i].at), `day ${d} ${s.chapters[i].title}`).toBeGreaterThan(secs(s.chapters[i - 1].at));
      expect(secs(s.chapters.at(-1)!.at) / 60).toBeLessThan(Number(s.meta.duration_min));
    }
  });

  it('carry the spoken word counts for their length', () => {
    for (const { d, s } of days) {
      const n = wordsOf(s);
      const [lo, hi] = d === 5 ? [13000, 15000] : [8000, 10000];
      expect(n, `day ${d} words`).toBeGreaterThanOrEqual(lo);
      expect(n, `day ${d} words`).toBeLessThanOrEqual(hi);
    }
  });

  it('use only known cue kinds and host actions', () => {
    for (const { d, s } of days) for (const c of cues(s)) {
      expect(c, `day ${d}`).toMatch(/^\[(SLIDE|ON SCREEN|HOST|NOTE): .+\]$/);
      if (c.startsWith('[HOST:')) expect(c, `day ${d}`).toMatch(/^\[HOST: (OPEN OFFER|CLOSE OFFER|POLL [a-z0-9_]+|PIN .+|SHOW TIMER|TAKE QUESTIONS)\]$/);
    }
  });

  it('pass the copy rules in every spoken paragraph, and never use an em dash', () => {
    for (const { d, s } of days) {
      for (const p of s.chapters.flatMap((c) => c.spoken)) expect(auditCopy(p), `day ${d}: ${p}`).toEqual([]);
      expect(read(`challenge-day-${d}.md`), `day ${d}`).not.toMatch(/[—–]/);
    }
  });

  it('are live sessions: chat prompts, polls, homework, a tomorrow hook and a Q&A block', () => {
    for (const { d, s } of days) {
      const t = spokenText(s).toLowerCase();
      expect(t, `day ${d}`).toMatch(/chat/);
      expect(cues(s).some((c) => c.startsWith('[HOST: POLL')), `day ${d}`).toBe(true);
      expect(cues(s), `day ${d}`).toContain('[HOST: TAKE QUESTIONS]');
      expect(t, `day ${d}`).toMatch(/homework/);
      expect(s.chapters.some((c) => /q&a|questions/i.test(c.title)), `day ${d}`).toBe(true);
      if (d < 5) expect(t, `day ${d}`).toMatch(/tomorrow/);
    }
  });

  it('keep the offer closed until Day 5, and open it there with the guarantee and every condition', () => {
    for (const { d, s } of days.slice(0, 4)) {
      expect(cues(s), `day ${d}`).not.toContain('[HOST: OPEN OFFER]');
      expect(cues(s), `day ${d}`).not.toContain('[HOST: SHOW TIMER]');
    }
    const five = days[4].s;
    expect(cues(five)).toContain('[HOST: OPEN OFFER]');
    const t = spokenText(five);
    expect(t).toContain("If you don't have a signed letter of intent within 90 days, Josh's team keeps working with you at no extra cost until you do. Or, if you prefer, take a full refund of everything you paid.");
    const conditions: [string, RegExp][] = [
      ['kickoff and two years of financials within 7 days', /kickoff[^.]*last two years of financials[^.]*within seven days/i],
      ['weekly working sessions, miss no more than two', /weekly working sessions[^.]*miss no more than two/i],
      ['25 owner contacts a week with the scripts', /twenty-five owner contacts a week[^.]*scripts/i],
      ['reply within 2 business days', /reply to the team within two business days/i],
      ['the buy box and the 1.5x test', /follow the agreed buy box and the 1\.5x test/i],
      ['what an LOI means', /signed, non-binding (letter of intent|LOI)[^.]*inside the agreed buy box/i],
      ['what it does not promise', /doesn't promise financing, a closed acquisition, or any return/i],
    ];
    for (const [name, re] of conditions) expect(t, name).toMatch(re);
    expect(t).toMatch(/go back to the tab you joined from, the button is there now/i);
    expect(t).toMatch(/seller rollover/);
  });
});

describe('challenge homework and emails', () => {
  const blocks = (src: string) => src.replace(/^---\n[\s\S]*?\n---\n/, '').split(/\n{2,}/).map((b) => b.trim()).filter((b) => b && !b.startsWith('#') && !b.startsWith('[') && !/^\|/.test(b));
  it('cover all five days and pass the copy rules', () => {
    const hw = read('challenge-homework.md');
    for (const d of [1, 2, 3, 4, 5]) expect(hw).toMatch(new RegExp(`## Day ${d} `));
    const em = read('challenge-emails.md');
    for (const d of [1, 2, 3, 4, 5]) expect(em).toMatch(new RegExp(`Day ${d}`));
    for (const [name, src, kind] of [['homework', hw, undefined], ['emails', em, 'email']] as const) {
      expect(src, name).not.toMatch(/[—–]/);
      for (const b of blocks(src)) {
        const text = b.split('\n').filter((l) => !l.startsWith('[')).map((l) => l.replace(/^(\d+\.|-)\s+/, '').replace(/^(Subject|Preheader|P\.S\.):\s*/, '')).join('\n');
        expect(auditCopy(text, { kind }), `${name}: ${b}`).toEqual([]);
      }
    }
  });
});
