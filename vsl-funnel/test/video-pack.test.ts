import { describe, expect, it } from 'vitest';
import type { Topic } from '../src/content/ideas';
import { buildPackBoard, createGoogleDoc, googleAuthUrl, packDocHtml, packDocRtf, packMiroLayout, rulesPack, scriptParas, smart, type VideoPack } from '../src/content/video-pack';
import pack from './fixtures/pack-t1.json';
import topic from './fixtures/topic-t1.json';

const P = pack as unknown as VideoPack, T = topic as unknown as Topic;

describe('video pack: Google Doc', () => {
  const html = packDocHtml(P, T, { index: 0, nextTitle: 'Where the Money Comes From', miroUrl: 'https://miro.com/app/board/x/' });
  it('has the cover, the word-for-word script for every beat and the publishing kit', () => {
    expect(html).toContain('VIDEO 01');
    for (const b of P.beats) expect(html).toContain(smart(b.headline).replace(/&/g, '&amp;'));
    expect(html).toContain('THE HOOK');
    expect(html).toContain('Everything for the upload.');
    expect(html).toContain('Three Shorts to cut from it.');
    expect(html).toContain('Open the board in Miro');
    // one page per beat
    expect(html.split('page-break-before').length - 1).toBeGreaterThanOrEqual(P.beats.length + 5);
  });
  it('sets the script in short paragraphs without changing a word', () => {
    for (const s of [P.hook.script, P.intro.script, P.close.script, ...P.beats.map((b) => b.script)]) {
      const parts = scriptParas(s);
      expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(s.replace(/\s+/g, ' ').trim());
      for (const x of parts) expect(x.split(/\s+/).length).toBeLessThan(110);
    }
  });
  it('renders the same document as RTF for Google Docs: page breaks, unsplittable slides, escaped text', () => {
    const rtf = packDocRtf({ ...P, big_idea: 'Brace {yourself} \\ “quotes”' }, T, { index: 0, miroUrl: 'https://miro.com/app/board/x/' });
    expect(rtf.startsWith('{\\rtf1')).toBe(true);
    expect(rtf.split('\\pagebb').length - 1).toBeGreaterThanOrEqual(P.beats.length + 5);
    expect(rtf).toContain('\\trkeep');
    // cp1252 hex escapes: Google Docs garbles \\uN but reads \\'hh
    expect(rtf).toContain("Brace \\{yourself\\} \\\\ \\'93quotes\\'94");
    expect(rtf).not.toMatch(/\\u\d/);
    expect(rtf).toContain('HYPERLINK "https://miro.com/app/board/x/"');
    let depth = 0;
    for (const ch of rtf.replace(/\\[\\{}]/g, '')) { if (ch === '{') depth++; if (ch === '}') depth--; expect(depth).toBeGreaterThanOrEqual(0); }
    expect(depth).toBe(0);
  });
  it('escapes anything typed into the pack', () => {
    const bad = { ...P, big_idea: '<img src=x onerror=alert(1)>' };
    expect(packDocHtml(bad, T, { index: 0 })).not.toContain('<img');
  });
});

describe('video pack: rules fallback', () => {
  it('builds every field from the topic plan, honestly', () => {
    const r = rulesPack(T, null);
    expect(r.beats).toHaveLength(T.outline.logic_ladder.length);
    expect(r.titles).toHaveLength(3);
    expect(r.close.script).not.toMatch(/\bfree\b/i);
    expect(r.description).toContain('{APPLY_LINK}');
    expect(r.compliance.join(' ')).toMatch(/Illustrative/);
  });
});

describe('video pack: Miro board', () => {
  const { frames, items } = packMiroLayout(P, T, 0);
  it('has the brief, a black slide per beat with its notes underneath, and the publishing row', () => {
    const titles = frames.map((f) => f.title);
    expect(titles).toEqual(expect.arrayContaining(['01 · Cover', '01 · The idea', '01 · Packaging', '01 · Hook', '01 · Proof', '01 · Close', '01 · Upload', '01 · Shorts', '01 · On set']));
    const beats = frames.filter((f) => /Beat \d+$/.test(f.title));
    expect(beats.length).toBe(P.beats.length);
    for (const b of beats) {
      expect(b.fill).toBe('#000000');
      const notes = frames.find((f) => f.title === `${b.title} · notes`)!;
      expect(notes.x).toBe(b.x);
      expect(notes.y).toBeGreaterThan(b.y + b.h);
    }
  });
  it('keeps every item inside its frame', () => {
    for (const it of items) {
      const f = frames[it.frame];
      expect(it.position.x).toBeGreaterThanOrEqual(0);
      expect(it.position.x).toBeLessThanOrEqual(f.w);
      expect(it.position.y).toBeGreaterThanOrEqual(0);
      expect(it.position.y).toBeLessThanOrEqual(f.h);
    }
  });
  it('creates frames first, then items parented to them, under the subrequest budget', async () => {
    const calls: string[] = [];
    let n = 0;
    const fake = (async (url: string, init: RequestInit) => {
      calls.push(url);
      const body = JSON.parse(String(init.body));
      if (url.endsWith('/boards')) return new Response(JSON.stringify({ id: 'B', viewLink: 'https://miro.com/app/board/B/' }));
      if (url.endsWith('/frames')) return new Response(JSON.stringify({ id: `F${++n}` }));
      expect((body as { parent: { id: string } }[]).every((x) => /^F\d+$/.test(x.parent.id))).toBe(true);
      return new Response(JSON.stringify({ data: [] }));
    }) as unknown as typeof fetch;
    expect(await buildPackBoard('t', P, T, 0, 'V', fake)).toBe('https://miro.com/app/board/B/');
    expect(calls.findIndex((u) => u.endsWith('/items/bulk'))).toBeGreaterThan(calls.findLastIndex((u) => u.endsWith('/frames')));
    expect(calls.length).toBeLessThan(50);
  });
});

describe('Google Drive', () => {
  it('asks only for drive.file and offline access', () => {
    const u = new URL(googleAuthUrl('cid', 'https://apply.example.com', 'st'));
    expect(u.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.file');
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('redirect_uri')).toBe('https://apply.example.com/oauth/google/callback');
  });
  it('uploads HTML as a Google Doc into the chosen folder', async () => {
    const seen: { url: string; body: string; headers: HeadersInit | undefined }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: String(init.body), headers: init.headers });
      if (url.includes('oauth2')) return new Response(JSON.stringify({ access_token: 'AT' }));
      return new Response(JSON.stringify({ id: 'D1', webViewLink: 'https://docs.google.com/document/d/D1/edit' }));
    }) as unknown as typeof fetch;
    const rt = { settings: { GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REFRESH_TOKEN: 'r', GOOGLE_DRIVE_FOLDER_ID: 'FOLDER' } } as never;
    expect(await createGoogleDoc(rt, 'Doc', '{\\rtf1 Hi}', fake)).toBe('https://docs.google.com/document/d/D1/edit');
    expect(seen[1].body).toContain('"mimeType":"application/vnd.google-apps.document"');
    expect(seen[1].body).toContain('"parents":["FOLDER"]');
    expect(seen[1].body).toContain('Content-Type: application/rtf');
    expect(seen[1].body).toContain('{\\rtf1 Hi}');
  });
});
