import type { Runtime } from '../app';
import { type BrainHit, type BrainScope, type LegendCard, brainSearch, glFacts, legendCards } from './retrieve';

/**
 * The "Brain" section Studio's script writer and Radar's analyst get in their system prompt: the legend cards that
 * fit the task, the best retrieved notes (together at most 3,500 characters) and the verified G&L facts. The model
 * cites the page titles it used in its notes field, never in spoken copy. Empty brain: '' (the prompt is unchanged).
 */

export const BRAIN_MAX = 3500;
export const BRAIN_NOTES_HELP = 'Internal notes, never spoken or shown to viewers: the brain pages you drew on, cited by page title, and how each shaped the result. Empty when no brain section was given.';

export function formatCard(c: LegendCard): string {
  return [
    `${c.legend} (page "${c.page}")`,
    c.principles.length ? `  Principles: ${c.principles.join(' | ')}` : '',
    c.techniques.length ? `  Techniques: ${c.techniques.join(' | ')}` : '',
  ].filter(Boolean).join('\n');
}
const formatHit = (h: BrainHit) => `[${h.title}${h.section ? ` › ${h.section}` : ''}] ${h.snippet}`;

export interface BrainSectionOptions { scope?: BrainScope; legends?: number; hits?: number; maxChars?: number; facts?: boolean }

/** Assemble the section within the budget; '' when the brain is empty or anything fails (the writer still runs). */
export async function brainSection(rt: Pick<Runtime, 'env' | 'settings'>, task: string, o: BrainSectionOptions = {}): Promise<string> {
  const max = o.maxChars ?? BRAIN_MAX;
  try {
    const [cards, hits, facts] = await Promise.all([
      legendCards(rt, task, o.legends ?? 3),
      brainSearch(rt, task, { k: o.hits ?? 6, scope: o.scope ?? 'copy' }),
      o.facts === false ? Promise.resolve('') : glFacts(rt),
    ]);
    if (!cards.length && !hits.length && !facts) return '';
    let used = 0;
    const cardText: string[] = [];
    // Cards take at most about 60% of the budget, so retrieved notes always get room.
    for (const c of cards) { const t = formatCard(c); if (used + t.length + 1 > max * 0.62) break; cardText.push(t); used += t.length + 1; }
    const carded = new Set(cards.slice(0, cardText.length).map((c) => c.page));
    const hitText: string[] = [];
    for (const h of hits) {
      if (h.legend && carded.has(h.title)) continue; // its card is already in
      const t = formatHit(h);
      if (used + t.length + 1 > max) continue;
      hitText.push(t); used += t.length + 1;
    }
    if (!cardText.length && !hitText.length && !facts) return '';
    return [
      'BRAIN (Bendik\'s copy library: copywriting legends, persuasion, VSL and webinar playbooks, G&L notes). Use it to shape the structure, the hook, the persuasion and the angle. It is not proof and not a script: never quote it on camera, never name a legend, a book or a page in the spoken copy, and the house rules and TRUE FACTS above win on any conflict. In the notes field, cite the page titles you drew on and what each gave you.',
      cardText.length ? `\nLEGEND CARDS (the legends that fit this task)\n${cardText.join('\n')}` : '',
      hitText.length ? `\nRELEVANT NOTES\n${hitText.join('\n')}` : '',
      facts ? `\nVERIFIED G&L FACTS (cited in the brain, no doubt mark; background for accuracy: use only as written, never embellish, numbers stay exact, and name no third party on camera)\n${facts}` : '',
    ].filter(Boolean).join('\n');
  } catch (e) {
    console.error('brain section failed', String((e as Error)?.message ?? e).slice(0, 200));
    return '';
  }
}
