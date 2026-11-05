import type { Runtime } from '../app';
import { brainSearch as bSearch, glFacts as bFacts, legendCards as bCards } from '../brain/retrieve';
import { FACTS, FRAMEWORKS, HOOKS_BANK } from '../studio/copy-brain';

/**
 * The brain Radar's format analysis and adaptation read from (contract in the Radar v2 brief): `brainSearch`,
 * `legendCards` and `glFacts`. Builder B's module (src/brain/*) loads the private brain repo into D1/Vectorize at
 * deploy time; `getBrain` uses it, and whenever it has no data this fallback is built from what is already public in this repo: the copy brain (src/studio/copy-brain.ts) and short, generic
 * statements of each copy legend's best-known principles. No private brain text lives here.
 */

export interface BrainHit { id: string; title: string; path: string; section?: string; snippet: string; score: number; legend?: string }
export interface LegendCard { legend: string; page: string; principles: string[]; techniques: string[] }
export interface Brain {
  brainSearch(query: string, o?: { k?: number; scope?: 'copy' | 'gl' | 'all' }): Promise<BrainHit[]>;
  legendCards(task: string, n?: number): Promise<LegendCard[]>;
  glFacts(): Promise<string>;
}

/** Generic, public summaries of each legend's method (plus the Studio frameworks as Sultanic's card). */
export const FALLBACK_LEGENDS: (LegendCard & { tags: string[] })[] = [
  { legend: 'Eugene Schwartz', page: 'fallback/schwartz', tags: ['hook', 'awareness', 'headline', 'mechanism', 'sophistication'],
    principles: ['Match the opening to the reader\'s awareness level', 'In a sophisticated market, lead with a new mechanism, not a bigger claim', 'Channel desire that already exists; do not try to create it'],
    techniques: ['Name the mechanism in the hook', 'Intensify the desire before the proof'] },
  { legend: 'Gary Halbert', page: 'fallback/halbert', tags: ['hook', 'specificity', 'story', 'audience'],
    principles: ['The right audience beats the clever line', 'Specifics are believed, generalities are skimmed', 'Write to one person'],
    techniques: ['Specific numbers and names over adjectives', 'A personal, plain-spoken story open'] },
  { legend: 'Claude Hopkins', page: 'fallback/hopkins', tags: ['proof', 'specificity', 'reason why'],
    principles: ['Give the reason why for every claim', 'Specific claims carry weight, vague ones carry none'],
    techniques: ['Replace adjectives with a fact the viewer can check'] },
  { legend: 'David Ogilvy', page: 'fallback/ogilvy', tags: ['headline', 'hook', 'research', 'title'],
    principles: ['The headline does most of the work', 'Research the product until the facts sell it'],
    techniques: ['Put the benefit and the audience in the title', 'Use the facts the research turned up as the proof'] },
  { legend: 'Joe Sugarman', page: 'fallback/sugarman', tags: ['structure', 'retention', 'beats', 'flow'],
    principles: ['Each line exists to get the next one read', 'Curiosity carries the viewer through the slow parts'],
    techniques: ['Open loops at the end of each beat', 'Short first lines'] },
  { legend: 'Dan Kennedy', page: 'fallback/kennedy', tags: ['cta', 'offer', 'audience', 'call-out'],
    principles: ['Call out the exact buyer and repel the rest', 'Every piece ends in one clear next step'],
    techniques: ['A call-out line that names the owner and their revenue', 'One CTA, said plainly'] },
  { legend: 'John Carlton', page: 'fallback/carlton', tags: ['hook', 'story', 'voice'],
    principles: ['Sound like a person talking across a table', 'Lead with the most interesting true thing'],
    techniques: ['Cold-open on the moment of tension'] },
  { legend: 'Clayton Makepeace', page: 'fallback/makepeace', tags: ['emotion', 'stakes', 'proof'],
    principles: ['Find the dominant emotion and lead with it', 'Back every emotional claim with proof'],
    techniques: ['Stakes beat before the mechanism'] },
  { legend: 'Alex Hormozi', page: 'fallback/hormozi', tags: ['offer', 'proof', 'cta', 'value', 'hook'],
    principles: ['Value = dream outcome x likelihood, divided by time and effort', 'Show, do not tell: proof over promises'],
    techniques: ['Make the hook a result the viewer wants', 'Lower the perceived effort of the next step'] },
  { legend: 'Alen Sultanic', page: 'src/studio/copy-brain.ts', tags: ['framework', 'mechanism', 'cta', 'close', 'structure', 'hook'],
    principles: Object.values(FRAMEWORKS).slice(0, 4).map((f) => `${f.label}: ${f.sub}`),
    techniques: HOOKS_BANK.split('\n').filter((l) => l.startsWith('- ')).slice(0, 3).map((l) => l.slice(2, 160)) },
];

const tokens = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2);

/** Rank the fallback legends for a task by tag overlap (stable order for ties). */
export function fallbackLegendCards(task: string, n = 4): LegendCard[] {
  const t = new Set(tokens(task));
  return FALLBACK_LEGENDS
    .map((c, i) => ({ c, i, s: c.tags.filter((g) => g.split(/\s+/).some((w) => t.has(w))).length }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, Math.max(1, Math.min(8, n)))
    .map(({ c }) => ({ legend: c.legend, page: c.page, principles: c.principles, techniques: c.techniques }));
}

export const fallbackBrain: Brain = {
  async brainSearch(query, o = {}) {
    const q = new Set(tokens(query));
    const k = o.k ?? 5;
    const docs: BrainHit[] = [
      ...Object.entries(FRAMEWORKS).map(([id, f]) => ({ id: `framework:${id}`, title: f.label, path: 'src/studio/copy-brain.ts', snippet: f.body.slice(0, 600), score: 0, legend: 'Alen Sultanic' })),
      { id: 'gl:facts', title: 'G&L true facts', path: 'src/studio/copy-brain.ts', snippet: FACTS.slice(0, 900), score: 0 },
    ].filter((d) => o.scope !== 'gl' || d.id.startsWith('gl:')).filter((d) => o.scope !== 'copy' || !d.id.startsWith('gl:'));
    for (const d of docs) d.score = tokens(`${d.title} ${d.snippet}`).filter((w) => q.has(w)).length;
    return docs.filter((d) => d.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
  },
  async legendCards(task, n) { return fallbackLegendCards(task, n); },
  async glFacts() { return FACTS; },
};

/**
 * The brain for this runtime: builder B's retrieval over the private brain loaded at deploy time (src/brain/retrieve).
 * Each call falls back to the public copy brain above when the brain has no data or fails, so the pipeline behaves
 * the same with an empty brain.
 */
export function getBrain(rt: Runtime): Brain {
  return {
    async brainSearch(query, o = {}) {
      try { const hits = await bSearch(rt, query, o); if (hits.length) return hits; } catch (e) { console.error('radar: brainSearch failed', e instanceof Error ? e.message : e); }
      return fallbackBrain.brainSearch(query, o);
    },
    async legendCards(task, n = 4) {
      try { const cards = await bCards(rt, task, n); if (cards.length) return cards.map((c) => ({ legend: c.legend, page: c.page, principles: c.principles, techniques: c.techniques })); } catch (e) { console.error('radar: legendCards failed', e instanceof Error ? e.message : e); }
      return fallbackBrain.legendCards(task, n);
    },
    async glFacts() {
      try { const f = await bFacts(rt); if (f) return f; } catch (e) { console.error('radar: glFacts failed', e instanceof Error ? e.message : e); }
      return fallbackBrain.glFacts();
    },
  };
}

/** A legend card as prompt text (≤ 900 chars each, as the contract promises). */
export const cardText = (c: LegendCard) => `${c.legend}: principles: ${c.principles.join('; ')}. Techniques: ${c.techniques.join('; ')}.`.slice(0, 900);
