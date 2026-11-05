import { describe, expect, it } from 'vitest';
import { CHUNK_MAX, buildBrain, cleanText, factBullets, inScope, kindOf, legendOf, pagerank, parsePage, toSeedSql } from '../src/brain/build';
import { fixtureFiles, fixtureSnapshot, seededDb } from './brain-fixture';

// The brain loader on a synthetic wiki: scope (privacy), parsing, chunks, kinds, legends, edges, PageRank, verified
// facts and the seed SQL (run against a real SQLite with every migration).

describe('brain build: scope and privacy', () => {
  it('reads only wiki/engine/** and wiki/ventures/gl/**', () => {
    expect(inScope('engine/copy/legends/x.md')).toBe(true);
    expect(inScope('ventures/gl/people/x.md')).toBe(true);
    expect(inScope('ventures/northwind/x.md')).toBe(false);
    expect(inScope('ventures/glx/x.md')).toBe(false);
    expect(inScope('personal/diary.md')).toBe(false);
    expect(inScope('engine/.hidden/x.md')).toBe(false);
    expect(inScope('engine/copy/x.txt')).toBe(false);
    const files = fixtureFiles();
    expect(files.some((f) => f.text.includes('ZEBRACANARY'))).toBe(true); // the canary is in the fixture...
    const snap = fixtureSnapshot();
    expect(JSON.stringify(snap)).not.toContain('ZEBRACANARY'); // ...and never in the build
    expect(toSeedSql(snap).join('')).not.toContain('ZEBRACANARY');
    expect(snap.pages.map((p) => p.id).sort()).toEqual(['ada-quill', 'anchor-frames', 'boris-ledger', 'copywriting-legends', 'cora-vance', 'gl', 'hook-lab', 'market-probe', 'sam-example', 'structure-notes', 'vsl-skeleton', 'webinar-arc']);
  });
});

describe('brain build: parsing and chunks', () => {
  it('parses title, summary, headings and links; cleans links and source refs', () => {
    const p = parsePage('engine/copy/legends/ada-quill.md', fixtureFiles().find((f) => f.path.endsWith('ada-quill.md'))!.text);
    expect(p.title).toBe('Ada Quill');
    expect(p.summary).toMatch(/^Fictional headline writer/);
    expect(p.headings).toEqual(['Who / track record', 'Core ideas', 'What to steal', 'Related', 'Sources']);
    expect(p.links).toEqual(expect.arrayContaining(['copywriting-legends', 'hook-lab', 'boris-ledger']));
    expect(cleanText('See [[hook-lab]] and [[ada-quill|Ada]] (src: raw/x.md).')).toBe('See hook-lab and Ada.');
  });

  it('chunks by heading, drops Sources and Related, keeps chunks under the cap, tags kinds, legends and techniques', () => {
    const snap = fixtureSnapshot();
    const ada = snap.chunks.filter((c) => c.page_id === 'ada-quill');
    expect(ada.every((c) => !/^(Sources|Related)/.test(c.heading))).toBe(true);
    expect(snap.chunks.every((c) => c.text.length <= CHUNK_MAX + 80)).toBe(true);
    const core = ada.find((c) => c.heading.startsWith('Core ideas'))!;
    expect(core).toMatchObject({ kind: 'principle', legend: 'Ada Quill', verified: true });
    expect(core.tags.techniques).toEqual(expect.arrayContaining(['Curiosity gap', 'One reader, one promise']));
    expect(ada.find((c) => c.heading.includes('What to steal'))?.kind ?? ada.find((c) => c.text.includes('question headline'))!.kind).toMatch(/technique|principle/);
    const who = ada.find((c) => c.text.includes('record response rate'))!;
    expect(who.verified).toBe(false);
    expect(who.tags.unverified).toBe(true);
    expect(who.tags.src).toContain('raw/synthetic/ada.md');
    expect(snap.chunks.find((c) => c.page_id === 'boris-ledger' && c.heading.startsWith('Worked example'))?.kind).toBe('example');
    expect(snap.chunks.find((c) => c.page_id === 'hook-lab' && c.heading.includes('Rules'))?.kind).toBe('rule');
    expect(snap.chunks.filter((c) => c.page_id === 'sam-example').every((c) => c.kind === 'fact' && c.legend === null)).toBe(true);
  });

  it('kinds, legends and chunk ids follow the rules', () => {
    expect(kindOf('Worked example — x', 'engine/copy')).toBe('example');
    expect(kindOf('What to steal', 'engine/copy')).toBe('technique');
    expect(kindOf('Who / track record', 'engine/copy')).toBe('fact');
    expect(kindOf('Core idea 2 — awareness', 'engine/copy')).toBe('principle');
    expect(kindOf('Anything', 'ventures/gl')).toBe('fact');
    expect(legendOf('engine/copy/legends/ada-quill.md', 'Ada Quill (fictional)')).toBe('Ada Quill');
    expect(legendOf('engine/copy/legends/copywriting-legends.md', 'Hub')).toBeNull();
    expect(legendOf('engine/copy/hook-lab.md', 'Hook lab')).toBeNull();
    const snap = buildBrain([{ path: 'engine/copy/' + 'x'.repeat(70) + '.md', text: '# Long\n\nA page with a very long name and enough text to make a chunk of its own here.' }]);
    expect(snap.chunks[0].id.length).toBeLessThanOrEqual(58);
    expect(`brain:${snap.chunks[0].id}`.length).toBeLessThanOrEqual(64);
  });

  it('only cited bullets with no doubt mark become G&L facts', () => {
    const snap = fixtureSnapshot();
    const facts = snap.chunks.flatMap((c) => c.tags.facts ?? []);
    expect(facts).toEqual(expect.arrayContaining([
      'Bought two fictional clinics in the fixture, both with seller finance.',
      'Seller finance plus seller rollover plus commercial debt is the fixture default.',
    ]));
    expect(facts.join('\n')).not.toMatch(/large sum|assumption|goldfish|two weeks every time/);
    expect(snap.chunks.filter((c) => !c.page_id.match(/gl|sam|structure/)).every((c) => !c.tags.facts)).toBe(true);
    expect(factBullets('- A cited line about owners (src: raw/x.md).\n- Session notes at https://x.test (src: raw/y.md).')).toEqual(['A cited line about owners.']);
  });
});

describe('brain build: graph', () => {
  it('typed edges: links, backlinks, part_of the legends hub, siblings', () => {
    const { edges, stats } = fixtureSnapshot();
    const has = (src: string, dst: string, type: string) => edges.some((e) => e.src === src && e.dst === dst && e.type === type);
    expect(has('ada-quill', 'copywriting-legends', 'part_of')).toBe(true);
    expect(has('copywriting-legends', 'ada-quill', 'links_to')).toBe(true);
    expect(has('ada-quill', 'copywriting-legends', 'backlink')).toBe(true);
    expect(has('hook-lab', 'ada-quill', 'links_to')).toBe(true);
    expect(has('ada-quill', 'hook-lab', 'backlink')).toBe(true);
    expect(has('ada-quill', 'boris-ledger', 'sibling')).toBe(true);
    expect(edges.some((e) => e.dst === 'secret' || e.src === 'secret')).toBe(false);
    expect(stats).toMatchObject({ pages: 12, legends: 3 });
    expect(Object.keys(stats.by_edge).sort()).toEqual(['backlink', 'links_to', 'part_of', 'sibling']);
  });

  it('PageRank: the most linked page ranks highest and ranks sum to 1', () => {
    const r = pagerank(['a', 'b', 'c', 'd'], [['a', 'c'], ['b', 'c'], ['d', 'c'], ['c', 'a']]);
    expect(Object.values(r).reduce((x, y) => x + y, 0)).toBeCloseTo(1, 6);
    expect(Math.max(...Object.values(r))).toBe(r.c);
    const snap = fixtureSnapshot();
    const top = [...snap.pages].sort((a, b) => b.pagerank - a.pagerank)[0];
    expect(['boris-ledger', 'ada-quill', 'hook-lab', 'gl', 'copywriting-legends']).toContain(top.id);
  });
});

describe('brain build: seed SQL', () => {
  it('loads into D1 (every migration), fills the full-text index and records the build; reseeding is idempotent', () => {
    const snap = fixtureSnapshot();
    const files = toSeedSql(snap, 4000);
    expect(files.length).toBeGreaterThan(1); // split into batches
    expect(files[files.length - 1]).toMatch(/'rebuild'/);
    const db = seededDb(snap);
    expect(db.prepare('SELECT COUNT(*) AS n FROM brain_pages').get()).toMatchObject({ n: 12 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM brain_chunks').get()).toMatchObject({ n: snap.chunks.length });
    expect(db.prepare('SELECT COUNT(*) AS n FROM brain_edges').get()).toMatchObject({ n: snap.edges.length });
    expect((db.prepare("SELECT COUNT(*) AS n FROM brain_fts WHERE brain_fts MATCH 'curiosity'").get() as { n: number }).n).toBeGreaterThan(0);
    const kv = JSON.parse((db.prepare("SELECT value FROM kv_state WHERE key = 'brain:build'").get() as { value: string }).value);
    expect(kv).toMatchObject({ build_id: snap.build_id, pages: 12, legends: 3 });

    // Mark everything embedded, then reseed a build where one page changed and one is gone.
    db.exec('UPDATE brain_chunks SET embedded_hash = hash');
    const files2 = fixtureFiles().filter((f) => !f.path.endsWith('market-probe.md')).map((f) => (f.path.endsWith('cora-vance.md') ? { ...f, text: f.text.replace('Story first', 'Scene first') } : f));
    const snap2 = buildBrain(files2, { builtAt: '2026-11-06T10:00:00.000Z' });
    for (const sql of toSeedSql(snap2, 4000)) db.exec(sql);
    expect(db.prepare("SELECT COUNT(*) AS n FROM brain_pages WHERE id = 'market-probe'").get()).toMatchObject({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM brain_chunks').get()).toMatchObject({ n: snap2.chunks.length });
    const pending = db.prepare('SELECT page_id FROM brain_chunks WHERE embedded_hash IS NULL OR embedded_hash <> hash').all() as { page_id: string }[];
    expect([...new Set(pending.map((p) => p.page_id))]).toEqual(['cora-vance']); // only the changed chunk is queued again
    expect((db.prepare("SELECT COUNT(*) AS n FROM brain_fts WHERE brain_fts MATCH ?").get('"scene first"') as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM brain_fts WHERE brain_fts MATCH 'reviews'").get() as { n: number }).n).toBe(0);
  });
});
