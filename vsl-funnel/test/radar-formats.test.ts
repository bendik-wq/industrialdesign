import { beforeEach, describe, expect, it } from 'vitest';
import { auditCopy } from '../src/content/copy-rules';
import {
  ADAPT_SCHEMA, JUDGE_PASS, adaptAndGate, adaptFull, adaptIssues, adaptSourceForItem, cleanAdaptation, cleanJudge, studioFormatFor,
} from '../src/radar/adapt';
import { FALLBACK_LEGENDS, cardText, fallbackBrain, fallbackLegendCards, getBrain } from '../src/radar/brain-provider';
import {
  type Member, assignIds, cleanExtraction, cleanName, clusterAndStore, clusterMembers, extractBatch, getExtraction, itemsToExtract, jaccard, lengthBucket,
  listFormats, nameTokens, rankOf, signatureOf, statsFor, whiteSpace,
} from '../src/radar/formats';
import { FORMATS_COPY } from '../src/radar/formats-routes';
import { PIPELINE_COPY } from '../src/radar/pipeline-flow';
import { SETTINGS } from '../src/settings';
import { ADAPTATION, NOW, fakeModel, rtFor, seedItems } from './radar-formats-fakes';
import { type SqlDb, freshDb } from './studio-fakes';

// Radar v2 (builder C): extraction validation and clamping, signatures and clustering, ranking and white space,
// the adaptation's copy gates and the blind judge loop, and the fallback brain.

describe('extraction: validation and clamping', () => {
  it('maps unknown taxonomy values to other, clamps lists and labels retention risks as estimates', () => {
    const e = cleanExtraction({
      format_name: '  Deal teardown with live scorecard. ', hook: { text: 'This deal made 2 million', type: 'shock value', why: 'Result first' },
      beats: [{ t: '0:00', role: 'HOOK', what: 'Result' }, { position: 'para 2', role: 'climax', summary: 'Turn' }, { role: 'cta', summary: '' }],
      devices: ['scorecard', 'Split Screen', 'hologram', 'scorecard'], length_bucket: 'gigantic',
      retention_risks: [{ at: '0:30', why: 'Dense numbers' }, { at: '0:40' }], audience: ['owner 1m', 'cats'], emotional_driver: 'joy', why_viral: 'x'.repeat(2000),
    }, { platform: 'youtube', duration_s: 45 });
    expect(e.format_name).toBe('Deal teardown with live scorecard');
    expect(e.hook).toMatchObject({ type: 'other', why_it_works: 'Result first' });
    expect(e.beats).toEqual([{ at: '0:00', role: 'hook', summary: 'Result' }, { at: 'para 2', role: 'other', summary: 'Turn' }]);
    expect(e.devices).toEqual(['scorecard', 'split_screen']);
    expect(e.length_bucket).toBe('short'); // from the real duration, not the model
    expect(e.retention_risks).toEqual([{ at: '0:30', why: 'Dense numbers', estimate: true }]);
    expect(e.audience).toEqual(['owner_1m', 'general']);
    expect(e.emotional_driver).toBe('other');
    expect(e.why_viral.length).toBe(700);
  });

  it('throws without a format name or hook; empty audience becomes general', () => {
    expect(() => cleanExtraction({ hook: { text: 'x' } }, { platform: 'youtube' })).toThrow();
    expect(() => cleanExtraction({ format_name: 'A' }, { platform: 'youtube' })).toThrow();
    expect(cleanExtraction({ format_name: 'A b', hook: { text: 'x', type: 'number' } }, { platform: 'youtube' }).audience).toEqual(['general']);
  });

  it('length buckets come from the numbers we hold', () => {
    expect(lengthBucket({ platform: 'youtube', duration_s: 12 })).toBe('micro');
    expect(lengthBucket({ platform: 'youtube', duration_s: 120 })).toBe('mid');
    expect(lengthBucket({ platform: 'youtube', duration_s: 1200 })).toBe('xl');
    expect(lengthBucket({ platform: 'tiktok', words: 300 })).toBe('mid'); // 300 words at 150 a minute
    expect(lengthBucket({ platform: 'x', text_words: 40 })).toBe('post');
    expect(lengthBucket({ platform: 'x', text_words: 400 })).toBe('thread');
    expect(lengthBucket({ platform: 'substack', text_words: 10 })).toBe('article');
    expect(lengthBucket({ platform: 'linkedin', text_words: 500 })).toBe('article');
    expect(lengthBucket({ platform: 'youtube' }, 'long')).toBe('long');
  });
});

const member = (over: Partial<Member>): Member => ({
  item_id: 'i', platform: 'youtube', score: 50, niche: 'in', published_at: '2026-11-01T00:00:00Z', first_seen: '2026-11-01T00:00:00Z', title: null, author: null, thumbnail_url: null, snippet: null,
  format_name: 'x', tokens: [], hook_type: 'other', devices: [], length_bucket: 'short', audience: ['general'], signature: '', prev_format_id: null, ...over,
});
const mk = (id: string, name: string, hook: Member['hook_type'], over: Partial<Member> = {}) => {
  const devices = over.devices ?? ['scorecard'];
  const len = over.length_bucket ?? 'short';
  return member({ item_id: id, format_name: name, tokens: nameTokens(name), hook_type: hook, devices, length_bucket: len, signature: signatureOf({ format_name: name, hook: { text: 'x', type: hook, why_it_works: '' }, devices, length_bucket: len }), ...over });
};

describe('signatures and clustering', () => {
  it('normalises names: stop words out, plurals folded, synonyms merged', () => {
    expect(nameTokens('Deal Breakdown with a Live Scorecard')).toEqual(['deal', 'live', 'scorecard', 'teardown']);
    expect(nameTokens('Street wealth interviews')).toEqual(nameTokens('Street Wealth Interview'));
    expect(nameTokens("I bought X, here's what it made")).toEqual(['buy']);
    expect(signatureOf({ format_name: 'Deal teardown with live scorecard', hook: { text: '', type: 'number', why_it_works: '' }, devices: ['scorecard', 'on_screen_numbers', 'chart'], length_bucket: 'short' }))
      .toBe('deal-live-scorecard-teardown|result|chart+on_screen_numbers|short');
    expect(jaccard(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3);
  });

  it('merges similar names in one hook family, keeps families apart, and is deterministic', () => {
    const ms = [
      mk('a', 'Deal teardown with live scorecard', 'result_first', { score: 80 }),
      mk('b', 'Deal breakdown live scorecard', 'number', { score: 70, devices: ['chart'] }), // same family (result), synonym
      mk('c', 'Deal teardown scorecard', 'question', { score: 90 }), // same words, other family
      mk('d', 'Street wealth interview', 'question', { score: 60 }),
      mk('e', 'Street interviews about wealth', 'curiosity_gap', { score: 55 }),
    ];
    const cs = clusterMembers(ms);
    const groups = cs.map((c) => c.members.map((m) => m.item_id).sort().join(','));
    expect(groups).toEqual(['a,b', 'd,e', 'c']);
    expect(clusterMembers([...ms].reverse()).map((c) => c.seed)).toEqual(cs.map((c) => c.seed));
  });

  it('ids are stable: a cluster keeps the id its members had', () => {
    const ms = [mk('a', 'Deal teardown', 'number', { prev_format_id: 'fmt_old' }), mk('b', 'Deal teardowns', 'number', { prev_format_id: 'fmt_old' }), mk('c', 'Other thing', 'question', { prev_format_id: 'fmt_old' })];
    const ids = assignIds(clusterMembers(ms));
    expect(ids[0].id).toBe('fmt_old');
    expect(ids[1].id).not.toBe('fmt_old');
    expect(assignIds(clusterMembers(ms.map((m) => ({ ...m, prev_format_id: null }))))[0].id).toMatch(/^fmt_[a-z0-9]+$/);
  });
});

describe('ranking and white space', () => {
  it('ranks by median outlier x platform breadth x recency (one-off items held back)', () => {
    const now = Date.parse('2026-11-05T00:00:00Z');
    const fresh = '2026-11-04T00:00:00Z', old = '2026-06-01T00:00:00Z';
    const wide = statsFor([member({ item_id: '1', platform: 'youtube', score: 60, published_at: fresh }), member({ item_id: '2', platform: 'tiktok', score: 60, published_at: fresh }), member({ item_id: '3', platform: 'x', score: 60, published_at: fresh })], null);
    const narrow = statsFor([member({ item_id: '1', score: 60, published_at: fresh }), member({ item_id: '2', score: 60, published_at: fresh }), member({ item_id: '3', score: 60, published_at: fresh })], null);
    const stale = statsFor([member({ item_id: '1', platform: 'youtube', score: 60, published_at: old }), member({ item_id: '2', platform: 'tiktok', score: 60, published_at: old }), member({ item_id: '3', platform: 'x', score: 60, published_at: old })], null);
    const single = statsFor([member({ item_id: '1', score: 90, published_at: fresh })], 3);
    expect(rankOf(wide, now)).toBeGreaterThan(rankOf(narrow, now));
    expect(rankOf(narrow, now)).toBeGreaterThan(rankOf(stale, now));
    expect(rankOf(single, now)).toBeLessThan(90 * 1.0);
    expect(wide).toMatchObject({ count: 3, platform_count: 3, median_score: 60, trend: { label: 'new' } });
    expect(single.trend).toEqual({ prev: 3, delta: -2, label: 'down' });
  });

  it('white space: wins outside our niche, absent or weak in ours; owners in the audience raise it', () => {
    const out = (id: string, score: number, aud: Member['audience'] = ['general']) => member({ item_id: id, niche: 'out', score, audience: aud });
    expect(whiteSpace(statsFor([out('1', 70), out('2', 60)], null))).toMatchObject({ level: 1 });
    expect(whiteSpace(statsFor([out('1', 70), out('2', 60, ['owner_1m'])], null)).level).toBe(2);
    expect(whiteSpace(statsFor([out('1', 70), out('2', 60), member({ item_id: '3', niche: 'in', score: 20 })], null)).level).toBe(1); // weak in ours
    expect(whiteSpace(statsFor([out('1', 70), out('2', 60), member({ item_id: '3', niche: 'in', score: 65 })], null)).level).toBe(0); // strong in ours
    expect(whiteSpace(statsFor([out('1', 70)], null)).level).toBe(0); // one item is not a pattern
    expect(whiteSpace(statsFor([out('1', 10), out('2', 12)], null)).level).toBe(0); // not winning
    const why = whiteSpace(statsFor([out('1', 70), out('2', 60, ['owner_1m'])], null)).why!;
    expect(auditCopy(why)).toEqual([]);
    expect(why).not.toMatch(/[—–!]/);
  });

  it('a model name is cleaned to house punctuation and two lines', () => {
    expect(cleanName({ name: 'Named — format!', definition: 'One.\nTwo.\nThree.' }, { name: 'f', definition: 'd' })).toEqual({ name: 'Named, format', definition: 'One.\nTwo.' });
    expect(cleanName({}, { name: 'f', definition: 'd' })).toEqual({ name: 'f', definition: 'd' });
  });
});

describe('the steps on a database', () => {
  let db: SqlDb;
  beforeEach(async () => { db = freshDb(); await seedItems(db); });

  it('extracts the best items first within the per-sweep budget, then clusters, ranks and flags white space', async () => {
    const rt = rtFor(db, { RADAR_EXTRACT_PER_SWEEP: '4' });
    const m = fakeModel();
    const todo = await itemsToExtract(rt, 4, NOW);
    expect(todo.map((i) => i.id)).toEqual(['instagram:street1', 'youtube:deal1', 'tiktok:deal2', 'tiktok:street2']);
    expect(await extractBatch(rt, m.ask, 'workers-ai', todo, NOW)).toMatchObject({ done: 4, failed: 0 });
    expect(await getExtraction(rt, 'youtube:deal1')).toMatchObject({ hook: { type: 'result_first' }, length_bucket: 'long', devices: ['scorecard', 'on_screen_numbers'] });
    expect((await itemsToExtract(rt, 10, NOW)).map((i) => i.id)).toEqual(['x:bought1', 'youtube:pe1']);
    await extractBatch(rt, m.ask, 'workers-ai', await itemsToExtract(rt, 10, NOW), NOW);
    expect((await getExtraction(rt, 'youtube:pe1'))!.devices).toEqual(['talking_head', 'chart']); // the unknown device dropped

    const c1 = await clusterAndStore(rt, { ask: m.ask, brain: 'workers-ai', runId: 'r1', now: NOW });
    expect(c1.formats).toBe(4); // deal teardown (youtube long) and breakdown (tiktok short) share name and family; the street interviews merge
    const fs = await listFormats(rt);
    const deal = fs.find((f) => f.member_ids.includes('youtube:deal1'))!;
    expect(deal.member_ids.sort()).toEqual(['tiktok:deal2', 'youtube:deal1']);
    expect(deal.stats).toMatchObject({ count: 2, platform_count: 2, in_niche: 1, adjacent: 1 });
    const street = fs.find((f) => f.member_ids.includes('instagram:street1'))!;
    expect(street.white_space).toBe(2);
    expect(street.name).toBe('Named, format');
    expect(fs[0].rank).toBeGreaterThanOrEqual(fs[fs.length - 1].rank);
    // Idempotent: the same members give the same rows and no new naming calls.
    const named = m.calls.name;
    await clusterAndStore(rt, { ask: m.ask, brain: 'workers-ai', runId: 'r1', now: NOW });
    expect(m.calls.name).toBe(named);
    expect((await listFormats(rt)).map((f) => [f.id, f.rank])).toEqual(fs.map((f) => [f.id, f.rank]));
    // A failed extraction is recorded and retried after a day, not straight away.
    db.prepare("DELETE FROM radar_item_formats WHERE item_id = 'youtube:pe1'").run();
    await extractBatch(rt, async () => 'not json', 'workers-ai', await itemsToExtract(rt, 10, NOW), NOW);
    expect(db.prepare("SELECT error IS NOT NULL AS e FROM radar_item_formats WHERE item_id = 'youtube:pe1'").get()).toMatchObject({ e: 1 });
    expect(await itemsToExtract(rt, 10, NOW)).toEqual([]);
    expect((await itemsToExtract(rt, 10, NOW + 2 * 86400_000)).map((i) => i.id)).toEqual(['youtube:pe1']);
  });
});

describe('adaptation: the copy gates and the blind judge', () => {
  const legends = ['Gary Halbert', 'Eugene Schwartz', 'Dan Kennedy'];
  it('cleans: legends must be ones we gave, the ICP is clamped, 5 hooks at most', () => {
    const a = cleanAdaptation({ ...ADAPTATION, icp: 'astronaut', hooks: [...ADAPTATION.hooks, 'six'], beats: [{ ...ADAPTATION.beats[0], legend: 'halbert' }, { ...ADAPTATION.beats[1], legend: 'Shakespeare' }] }, { legends, studio_format: 'short' });
    expect(a.icp).toBe('ceiling');
    expect(a.hooks).toHaveLength(5);
    expect(a.beats.map((b) => b.legend)).toEqual(['Gary Halbert', '']);
    expect(a.legends).toEqual(['Gary Halbert']);
    expect(() => cleanAdaptation({ hooks: ['x'] }, { legends, studio_format: 'short' })).toThrow();
    expect(studioFormatFor('xl')).toBe('long');
    expect(studioFormatFor('thread')).toBe('short');
    expect(Object.keys((ADAPT_SCHEMA as { properties: object }).properties)).toEqual(['topic', 'angle', 'icp', 'original_skeleton', 'beats', 'hooks']);
  });

  it('flags our lines only: em dashes, unlabelled numbers, funding without seller rollover, hedges', () => {
    const clean = cleanAdaptation(ADAPTATION, { legends, studio_format: 'short' });
    expect(adaptIssues(clean)).toEqual([]);
    const bad = cleanAdaptation({ ...ADAPTATION, beats: [
      { ...ADAPTATION.beats[0], original: 'This made $2M — wow!', ours: 'This deal made $3M — with seller finance and a bank loan.' },
      { ...ADAPTATION.beats[1], ours: 'You might want to maybe consider it.' },
    ] }, { legends, studio_format: 'short' });
    const rules = adaptIssues(bad).map((f) => `${f.path}: ${f.rule}`).join('\n');
    expect(rules).toMatch(/beats\[0\]\.ours: em dash/);
    expect(rules).toMatch(/beats\[0\]\.ours: label example numbers/);
    expect(rules).toMatch(/seller rollover/);
    expect(rules).toMatch(/beats\[1\]\.ours: hedge/);
    expect(rules).not.toMatch(/original/);
  });

  it('one rewrite when the draft trips the rules, keeping the version with fewer flags', async () => {
    let n = 0;
    const ask = async () => JSON.stringify(++n === 1 ? { ...ADAPTATION, hooks: ['Owners — listen.', ...ADAPTATION.hooks.slice(1)] } : ADAPTATION);
    const g = await adaptAndGate(ask, { system: 's', user: 'u', legends, studio_format: 'short' });
    expect(g).toMatchObject({ attempts: 2, flags: [] });
    expect(n).toBe(2);
    const stubborn = await adaptAndGate(async () => JSON.stringify({ ...ADAPTATION, hooks: ['Owners — listen.'] }), { system: 's', user: 'u', legends, studio_format: 'short' });
    expect(stubborn.attempts).toBe(2);
    expect(stubborn.flags.map((f) => f.rule)).toContain('em dash');
  });

  it('the judge is clamped and passes only when every score is 7 or more', () => {
    expect(cleanJudge({ scores: { hook: 12, specificity: 7, mechanism: 7.4, proof_honesty: 'x', cta: 9 }, notes: ['a'], verdict: 'v' })).toMatchObject({ scores: { hook: 10, specificity: 7, mechanism: 7, proof_honesty: 1, cta: 9 }, min: 1, pass: false });
    expect(cleanJudge({ scores: { hook: 7, specificity: 7, mechanism: 7, proof_honesty: 7, cta: 7 } }).pass).toBe(true);
    expect(JUDGE_PASS).toBe(7);
  });

  it('adapt → judge ⇄ rewrite (max 2) → store, with a Studio script saved; the judge sees only our version', async () => {
    const db = freshDb(); await seedItems(db);
    const rt = rtFor(db);
    const judgeInputs: string[] = [];
    const m = fakeModel({ judge: (k) => (k < 3 ? { hook: 5, specificity: 8, mechanism: 8, proof_honesty: 8, cta: 8 } : { hook: 8, specificity: 8, mechanism: 8, proof_honesty: 8, cta: 8 }) });
    const judgeAsk = async (system: string, msgs: { role: 'user' | 'assistant'; content: string }[]) => { judgeInputs.push(msgs.map((x) => x.content).join('\n')); return m.ask(system, msgs); };
    const e = (await (async () => { await extractBatch(rt, m.ask, 'workers-ai', await itemsToExtract(rt, 1, NOW), NOW); return getExtraction(rt, 'instagram:street1'); })())!;
    const src = adaptSourceForItem({ id: 'instagram:street1', platform: 'instagram', title: 'Street interview', score: 91 }, e);
    const deps = { ask: m.ask, scriptAsk: m.ask, judgeAsk, brain: getBrain(rt), model: 'workers-ai' as const };
    const a = (await adaptFull(rt, deps, src))!;
    expect(a).toMatchObject({ status: 'stored', rounds: 2, judge_score: 8 });
    expect(a.judge!.rounds.map((r) => r.min)).toEqual([5, 5, 8]);
    expect(m.calls).toMatchObject({ adapt: 3, judge: 3, script: 3 });
    expect(a.data.hooks).toHaveLength(5);
    expect(a.data.beats[0]).toMatchObject({ legend: 'Gary Halbert', why: expect.any(String) });
    expect(db.prepare('SELECT source, source_ref FROM studio_scripts WHERE id = ?').get(a.script_id)).toMatchObject({ source: 'radar', source_ref: 'instagram:street1' });
    // Blind: the judge never sees the original creator's words or the analyst's notes.
    expect(judgeInputs.join('\n')).not.toMatch(/What do you do for a living|This deal made|Proof swap/);
    // A passing first judgement: no rewrite.
    const m2 = fakeModel();
    const b = (await adaptFull(rt, { ...deps, ask: m2.ask, scriptAsk: m2.ask, judgeAsk: m2.ask }, src, { force: true }))!;
    expect(b).toMatchObject({ rounds: 0, status: 'stored' });
    expect(m2.calls).toMatchObject({ adapt: 1, judge: 1, script: 1 });
  });
});

describe('the fallback brain and copy', () => {
  it('legend cards: ranked for the task, n at most, each under 900 characters, no em dashes', async () => {
    const cards = fallbackLegendCards('hook mechanism', 3);
    expect(cards).toHaveLength(3);
    expect(cards.map((c) => c.legend)).toContain('Eugene Schwartz');
    for (const c of FALLBACK_LEGENDS) { expect(cardText(c).length).toBeLessThanOrEqual(900); expect(cardText(c)).not.toMatch(/[—–]/); }
    expect(await fallbackBrain.glFacts()).toMatch(/Josh/);
    expect(await fallbackBrain.brainSearch('seller rollover structure', { k: 2 })).toHaveLength(2);
    expect(await fallbackBrain.brainSearch('zzzz')).toEqual([]);
  });

  it('user-facing copy passes auditCopy', () => {
    for (const s of [...Object.values(FORMATS_COPY), ...Object.values(PIPELINE_COPY)]) { expect(auditCopy(s), s).toEqual([]); expect(s).not.toMatch(/[—–!]/); }
    for (const k of ['RADAR_EXTRACT_PER_SWEEP', 'RADAR_ADAPT_TOP', 'RADAR_PIPELINE_HOURS']) {
      const def = SETTINGS.find((s) => s.key === k) as { group: string; help: string } | undefined;
      expect(def?.group).toBe('Radar');
      expect(auditCopy(def!.help), k).toEqual([]);
    }
  });
});
