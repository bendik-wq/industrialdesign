import { afterEach, describe, expect, it } from 'vitest';
import { brainTick, embedBatch, embedText, pendingCount } from '../src/brain/embed';
import { BRAIN_MAX, brainSection } from '../src/brain/prompt';
import { brainSearch, bullets, compressLegend, glFacts, legendCards, personalizedPageRank, queryTerms, rrf, snippetFor } from '../src/brain/retrieve';
import { DIMS, setVectorTestDoubles } from '../src/vectors/core';
import { analysisSystemPrompt, analyse, analyseWithBrain, brainTaskFor } from '../src/radar/analyse';
import { SCRIPT_SCHEMA, SCRIPT_SCHEMA_NOTES, cleanScript, writeScript, writeStudioScript } from '../src/studio/scripts';
import { ctaFor, scriptSystemPrompt, type BrainInput } from '../src/studio/copy-brain';
import { freshDb } from './studio-fakes';
import { rtFor, seededDb } from './brain-fixture';

// Retrieval over the synthetic brain in a real SQLite D1 (FTS5 BM25, graph expansion, legend cards, verified facts),
// the hybrid path with a fake Vectorize and embedder, the resumable embedding job, and the Brain section in the
// Studio writer and the Radar analyst (identical prompts when the brain is empty).

afterEach(() => setVectorTestDoubles({ index: null, embed: null }));

describe('empty brain: everything returns nothing, fast', () => {
  it('search, cards, facts and the prompt section are empty on a fresh database', async () => {
    const rt = rtFor(freshDb());
    const t0 = Date.now();
    expect(await brainSearch(rt, 'curiosity headline')).toEqual([]);
    expect(await legendCards(rt, 'headline', 3)).toEqual([]);
    expect(await glFacts(rt)).toBe('');
    expect(await brainSection(rt, 'a VSL about buying a competitor')).toBe('');
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('a database without the brain tables (migration not applied) still answers empty', async () => {
    const db = freshDb();
    db.exec('DROP TABLE brain_fts; DROP TABLE brain_chunks; DROP TABLE brain_pages; DROP TABLE brain_edges');
    const rt = rtFor(db);
    expect(await brainSearch(rt, 'curiosity')).toEqual([]);
    expect(await brainSection(rt, 'curiosity')).toBe('');
  });
});

describe('brainSearch on the synthetic brain', () => {
  it('BM25 finds the right page first, with a section, a snippet and the legend', async () => {
    const rt = rtFor(seededDb());
    const hits = await brainSearch(rt, 'curiosity gap headline');
    expect(hits[0]).toMatchObject({ title: 'Ada Quill', legend: 'Ada Quill', path: 'wiki/engine/copy/legends/ada-quill.md', page: 'ada-quill' });
    expect(hits[0].snippet).toMatch(/[Cc]uriosity/);
    expect(hits[0].section).toBeTruthy();
    expect(new Set(hits.map((h) => h.page)).size).toBe(hits.length); // one hit per page
    expect(hits[0].score).toBeGreaterThan(hits[hits.length - 1].score);
  });

  it('graph expansion brings in linked pages the words alone miss', async () => {
    const rt = rtFor(seededDb());
    const hits = await brainSearch(rt, 'risk reversal guarantee', { k: 6 });
    expect(hits[0].page).toBe('boris-ledger');
    const pages = hits.map((h) => h.page);
    // anchor-frames and vsl-skeleton link to Boris Ledger; neither says "guarantee"
    expect(pages.some((p) => p === 'anchor-frames' || p === 'vsl-skeleton')).toBe(true);
  });

  it('scope filters: copy excludes research and G&L, gl only G&L', async () => {
    const rt = rtFor(seededDb());
    const copy = await brainSearch(rt, 'buyer reviews seller finance hook', { scope: 'copy', k: 12 });
    expect(copy.every((h) => /engine\/(copy|persuasion|vsl|webinar)\//.test(h.path))).toBe(true);
    const gl = await brainSearch(rt, 'seller finance clinics', { scope: 'gl', k: 12 });
    expect(gl.length).toBeGreaterThan(0);
    expect(gl.every((h) => h.path.startsWith('wiki/ventures/gl/'))).toBe(true);
    const all = await brainSearch(rt, 'buyer reviews complaints', { scope: 'all' });
    expect(all[0].page).toBe('market-probe');
  });

  it('nothing to search for: no hits', async () => {
    const rt = rtFor(seededDb());
    expect(await brainSearch(rt, 'the and of')).toEqual([]);
    expect(await brainSearch(rt, 'xylophonequartz')).toEqual([]);
  });

  it('hybrid: vector hits are fused with BM25 (RRF) once chunks are embedded', async () => {
    const db = seededDb();
    const upserts: { id: string; namespace?: string; metadata?: Record<string, unknown> }[] = [];
    const vec = (t: string) => { const v = new Array(DIMS).fill(0); v[/story|letter|friend/i.test(t) ? 1 : 0] = 1; v[2] = 0.01; return v; };
    setVectorTestDoubles({
      embed: async (texts) => texts.map(vec),
      index: {
        upsert: async (vs) => { upserts.push(...vs); return {}; },
        query: async (_v, o) => ({ matches: [{ id: 'brain:cora-vance#1', score: 0.9 }, { id: 'brain:gone#9', score: 0.8 }].filter(() => o.namespace === 'brain') }),
        getByIds: async () => [], deleteByIds: async () => ({}),
      },
    });
    const rt = rtFor(db);
    const before = await brainSearch(rt, 'narrative tale', { k: 4 });
    expect(before).toEqual([]); // nothing embedded yet and no words match: no hits
    const r = await embedBatch(rt, { limit: 200 });
    expect(r).toMatchObject({ ok: true, left: 0 });
    expect(upserts.length).toBe(r.embedded);
    expect(upserts[0]).toMatchObject({ namespace: 'brain', metadata: { kind: 'brain' } });
    const after = await brainSearch(rt, 'narrative tale', { k: 4 });
    expect(after[0]?.page).toBe('cora-vance'); // a meaning match with no shared words; the stale vector id is dropped
  });
});

describe('legend cards and facts', () => {
  it('picks the legends that fit the task and compresses each to principles and techniques under 900 chars', async () => {
    const rt = rtFor(seededDb());
    const cards = await legendCards(rt, 'write an offer with a guarantee and bonuses', 2);
    expect(cards[0].legend).toBe('Boris Ledger');
    expect(cards).toHaveLength(2);
    expect(cards[0].principles.join(' ')).toMatch(/Risk reversal/);
    expect(cards[0].techniques.join(' ')).toMatch(/Price anchoring|Bonus as objection killer/);
    for (const c of cards) expect(JSON.stringify(c).length).toBeLessThanOrEqual(900);
    const story = await legendCards(rt, 'open the letter with a story', 1);
    expect(story[0].legend).toBe('Cora Vance');
    const all = await legendCards(rt, '', 10); // no task: every legend, most linked first
    expect(all.map((c) => c.legend).sort()).toEqual(['Ada Quill', 'Boris Ledger', 'Cora Vance']);
    expect(JSON.stringify(all)).not.toMatch(/record response rate/); // unverified lines never go on a card
  });

  it('bullets and compression are deterministic', () => {
    expect(bullets('- **Curiosity gap:** open a loop the reader must close; the headline names a payoff.\n- tiny\n- A claim **unverified**.')).toEqual(['Curiosity gap: open a loop the reader must close;']);
    const card = compressLegend('X', 'X', [{ heading: 'Core ideas', kind: 'principle', text: Array.from({ length: 30 }, (_, i) => `- Principle number ${i} with enough words to count as one.`).join('\n') }], []);
    expect(JSON.stringify(card).length).toBeLessThanOrEqual(900);
  });

  it('glFacts: only cited, unmarked G&L bullets, people first', async () => {
    const rt = rtFor(seededDb());
    const f = await glFacts(rt);
    expect(f.split('\n')[0]).toMatch(/^- Bought two fictional clinics/);
    expect(f).toMatch(/seller rollover/);
    expect(f).not.toMatch(/large sum|assumption|goldfish|two weeks/);
  });
});

describe('pure parts', () => {
  it('query terms, RRF, PPR and snippets', () => {
    expect(queryTerms('How do I write THE best Hook? hook')).toEqual(['write', 'best', 'hook']);
    const f = rrf([[{ id: 'a' }, { id: 'b' }] as never, [{ id: 'b' }, { id: 'c' }] as never]);
    expect([...f.entries()].sort((x, y) => y[1].score - x[1].score)[0][0]).toBe('b');
    const adj = new Map([['a', new Map([['b', 1]])], ['b', new Map([['a', 1], ['c', 1]])], ['c', new Map([['b', 1]])]]);
    const r = personalizedPageRank(new Map([['a', 1]]), adj);
    expect(r.get('a')!).toBeGreaterThan(r.get('c')!);
    const s = snippetFor('Intro sentence here. '.repeat(30) + 'The starving crowd matters most. ' + 'Tail words. '.repeat(30), ['starving']);
    expect(s).toMatch(/starving crowd/);
    expect(s.length).toBeLessThanOrEqual(290);
  });
});

describe('embedding job', () => {
  it('not here without the bindings; resumable in batches; the cron only works after the owner started it', async () => {
    const db = seededDb();
    const rt = rtFor(db);
    expect(await embedBatch(rt)).toMatchObject({ ok: false, embedded: 0 });
    let calls = 0;
    setVectorTestDoubles({ embed: async (t) => { calls++; return t.map(() => new Array(DIMS).fill(0.1)); }, index: { upsert: async () => ({}), query: async () => ({ matches: [] }), getByIds: async () => [], deleteByIds: async () => ({}) } });
    const total = await pendingCount(rt);
    expect(await brainTick(rt)).toBeNull(); // never started: the cron spends nothing
    const first = await embedBatch(rt, { limit: 5 });
    expect(first).toMatchObject({ ok: true, embedded: 5, left: total - 5 });
    const tick = await brainTick(rt);
    expect(tick).toMatchObject({ embedded: total - 5, left: 0 });
    expect(await pendingCount(rt)).toBe(0);
    expect(calls).toBeGreaterThan(1);
    expect(embedText({ title: 'T', heading: 'H', text: 'x'.repeat(5000) }).length).toBeLessThanOrEqual(1900);
  });
});

describe('the Brain section in the prompts', () => {
  const input: BrainInput = { topic: 'Why a guarantee and a value stack sell an offer', context: '', format: 'vsl', icp: 'ceiling', framework: 'two_paths', cta: ctaFor('vsl') };

  it('brainSection: cards, notes and facts within budget, with the citation rule', async () => {
    const rt = rtFor(seededDb());
    const s = await brainSection(rt, input.topic);
    expect(s).toMatch(/^BRAIN /);
    expect(s).toMatch(/LEGEND CARDS[\s\S]*Boris Ledger/);
    expect(s).toMatch(/VERIFIED G&L FACTS[\s\S]*fictional clinics/);
    expect(s).toMatch(/notes field, cite the page titles/);
    expect(s).not.toMatch(/ZEBRACANARY|goldfish/);
    const body = s.split('\nVERIFIED G&L FACTS')[0];
    expect(body.length).toBeLessThanOrEqual(BRAIN_MAX + 600);
  });

  it('Studio writer: identical prompt and schema with no brain; Brain section and notes field with one', async () => {
    const seen: { system: string }[] = [];
    const reply = JSON.stringify({ hooks: ['A hook line here.'], hook_index: 0, beats: [{ layout: 'spotlight', text: 'Apply through the link below.', cue: '', on_screen: '', screen: '' }], titles: ['T'], thumbnail: 'T', description: 'D', cta: input.cta, notes: 'Boris Ledger: value stack' });
    await writeScript(async (system) => { seen.push({ system }); return reply; }, input);
    expect(seen[0].system).toBe(scriptSystemPrompt(input));
    const empty = rtFor(freshDb(), { AI: { run: async (_m: string, i: { response_format: { json_schema: { properties: Record<string, unknown> } }; messages: { content: string }[] }) => { seen.push({ system: i.messages[0].content }); expect(i.response_format.json_schema).toBe(SCRIPT_SCHEMA); return { response: reply }; } } });
    await writeStudioScript(empty, 'workers-ai', input);
    expect(seen[1].system).toBe(scriptSystemPrompt(input));
    const full = rtFor(seededDb(), { AI: { run: async (_m: string, i: { response_format: { json_schema: { properties: Record<string, unknown> } }; messages: { content: string }[] }) => { seen.push({ system: i.messages[0].content }); expect(i.response_format.json_schema).toBe(SCRIPT_SCHEMA_NOTES); return { response: reply }; } } });
    const w = await writeStudioScript(full, 'workers-ai', input);
    expect(seen[2].system.startsWith(scriptSystemPrompt(input))).toBe(true);
    expect(seen[2].system).toMatch(/\n\nBRAIN [\s\S]*Boris Ledger/);
    expect(w.script.notes).toBe('Boris Ledger: value stack');
    expect(cleanScript(JSON.parse(reply), 'vsl', input.cta).notes).toBe('Boris Ledger: value stack');
    expect(SCRIPT_SCHEMA_NOTES.required).toContain('notes');
    expect(SCRIPT_SCHEMA.required).not.toContain('notes');
  });

  it('Radar analyst: identical prompt with no brain; Brain section and notes with one', async () => {
    const item = { platform: 'youtube', title: 'How I wrote a story letter that sold', caption: 'A story-first letter', author: 'a', url: null, views: 1, likes: 1, comments: 1, shares: 1, followers: 1, published_at: null, duration_s: 60, score: 50, score_json: null, transcript: 'Open on a story. Then the offer.', transcript_source: 'captions', ad_active_days: null, ad_variants: null, ad_cta: null, ad_link: null, media_kind: null };
    const reply = { summary: 's', hook: { text: 'Open on a story.', why: 'w', type: 'story' }, beats: [], drop_offs: [], cta: 'c', pattern: 'p', format: 'f', topic: 't', for_gl: { apply: 'Owners can open on the moment a seller said yes.', hook: 'The seller said yes first.', angles: ['a', 'b', 'c'], layouts: [] }, notes: 'Cora Vance: story first' };
    const systems: string[] = [];
    await analyse(async (system) => { systems.push(system); return JSON.stringify(reply); }, item);
    expect(systems[0]).toBe(analysisSystemPrompt('video'));
    expect(brainTaskFor(item)).toMatch(/^video hook structure retention How I wrote/);
    const props: Record<string, unknown>[] = [];
    const ai = { AI: { run: async (_m: string, i: { response_format: { json_schema: { properties: Record<string, unknown> } }; messages: { content: string }[] }) => { systems.push(i.messages[0].content); props.push(i.response_format.json_schema.properties); return { response: JSON.stringify(reply) }; } } };
    await analyseWithBrain(rtFor(freshDb(), ai), 'workers-ai', item);
    expect(systems[1]).toBe(analysisSystemPrompt('video'));
    expect(props[0]).not.toHaveProperty('notes');
    const out = await analyseWithBrain(rtFor(seededDb(), ai), 'workers-ai', item);
    expect(systems[2]).toMatch(/\n\nBRAIN [\s\S]*Cora Vance/);
    expect(props[1]).toHaveProperty('notes');
    expect(out.analysis.notes).toBe('Cora Vance: story first');
  });
});
