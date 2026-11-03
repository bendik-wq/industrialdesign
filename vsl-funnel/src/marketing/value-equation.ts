/**
 * Offer copy check: the value equation (Hormozi) as an advisory lint over our offer surfaces.
 *
 * Value = (dream outcome × perceived likelihood) ÷ (time to the first result × effort and sacrifice). For every
 * offer page, offer email and room offer card we look for each of the four parts in the copy as it stands now
 * (an edited email is checked in its edited form) and, for each part that is missing, suggest what to add with
 * lines built only from facts we may state: the guarantee as worded, the method, Josh's two seller-financed
 * acquisitions, the real deposit credit and the real schedule. Suggestions only: nothing here edits any copy, and
 * the check never blocks a send or a publish.
 *
 * Detection is a plain word match, so it can miss a paraphrase or count a passing mention. It is a prompt for a
 * person, not a score of the copy.
 */
import type { Runtime } from '../app';
import { auditCopy } from '../content/copy-rules';
import { OFFER as CHALLENGE_OFFER } from '../challenge/content';
import { depositConfig, depositCopy } from '../sales/deposit';
import { GUARANTEE_HEADLINE, guarantee } from '../sales/guarantee';
import { liveEmail } from '../live/events';
import { postEmail } from '../live/lifecycle';
import { defaultEditable, loadOverrides } from '../integrations/email-overrides';
import { TEMPLATES } from '../integrations/templates';

export type Element = 'dream' | 'likelihood' | 'time' | 'effort';
export type Product = 'engagement' | 'sprint';

export const ELEMENTS: { id: Element; label: string; what: string }[] = [
  { id: 'dream', label: 'Dream outcome', what: 'What they end up with: their first competitor bought, a signed letter of intent, a group that sells at a higher multiple.' },
  { id: 'likelihood', label: 'Likelihood booster', what: 'Why it works for them: the guarantee as worded, the method (the 1.5x test, commercial debt, seller finance and seller rollover), Josh’s two seller-financed acquisitions.' },
  { id: 'time', label: 'Time to first result', what: 'When the first real result lands: kickoff, the first working session, Day 1, seven days to a plan, 90 days to a letter of intent.' },
  { id: 'effort', label: 'Effort and sacrifice reduced', what: 'What they don’t have to do or give up: done with you, the team builds the buy box and scripts, the deposit credited in full.' },
];

const norm = (s: string) => s.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').toLowerCase();

const PATTERNS: Record<Element, { kind: string; re: RegExp }[]> = {
  dream: [
    { kind: 'outcome', re: /\bbuy (?:a |your |the )?(?:first )?(?:competitor|business|company)\b|\bfirst (?:deal|acquisition|competitor)\b|\bown (?:a |another |more )?(?:second )?(?:business|businesses|company|companies|clinics?)\b|\bletter of intent\b|\bloi\b|\bhigher multiple\b|\bgroup (?:exit|multiple|of businesses)\b|\bruns without you\b|\bprofit without\b|\bbe the buyer\b|\bcash flow you buy\b|\bbuy (?:the|a) competitor\b/ },
  ],
  likelihood: [
    { kind: 'guarantee', re: /\bguarantee\b|\bkeeps? working with you at no extra cost\b|\bfull refund\b|\bmoney-back\b/ },
    { kind: 'method', re: /\b1\.5x\b|\bdebt service coverage\b|\bseller (?:finance|rollover)\b|\b3c (?:model|acquisition model)\b|\bcommercial debt\b/ },
    { kind: 'proof', re: /\btwo acquisitions\b|\bsellers? financed\b|\bbought his clinics\b/ },
  ],
  time: [
    { kind: 'timing', re: /\b(?:within|in|by|over|for)\s+(?:\d+|seven|ninety|thirty|fourteen|the first)\s+(?:days?|weeks?)\b|\bthis week\b|\bday [1-7]\b|\bfirst (?:session|call|week|working session)\b|\bkickoff\b|\bseven days\b|\b90 days\b/ },
  ],
  effort: [
    { kind: 'done with you', re: /\bdone with you\b|\bwith (?:josh's |the |his )team\b|\bteam (?:beside|with) you\b|\bbuilt with the team\b|\bworked through with\b|\bwe (?:build|draft|write|do|find)\b|\bscripts provided\b|\bthe team (?:builds|drafts|writes|checks|reads)\b/ },
    { kind: 'sacrifice', re: /\bcredited in full\b|\bcredited against\b|\bnothing to install\b|\bone click\b|\byou don't (?:have|need) to\b|\bno personal guarantee\b/ },
  ],
};

export interface ElementResult { id: Element; label: string; present: boolean; found: string[]; evidence: string | null }

/** Which of the four parts a piece of copy carries (pure). */
export function checkValueEquation(text: string): ElementResult[] {
  const t = norm(text);
  return ELEMENTS.map((e) => {
    const hits = PATTERNS[e.id].map((p) => ({ kind: p.kind, m: t.match(p.re) })).filter((h) => h.m);
    const first = hits[0]?.m;
    const at = first?.index ?? -1;
    return { id: e.id, label: e.label, present: hits.length > 0, found: hits.map((h) => h.kind), evidence: first ? t.slice(Math.max(0, at - 40), at + first[0].length + 40).replace(/\s+/g, ' ').trim() : null };
  });
}

/**
 * Lines we may state, per product and part. Every line is a fact from the business facts or the offer terms and
 * passes auditCopy (a test keeps it so). The guarantee is quoted by its headline and always sent to its conditions.
 */
export const FACT_LINES: Record<Product, Record<Element, string[]>> = {
  engagement: {
    dream: ['Buy your first competitor with Josh’s team beside you.', 'The engagement runs from your buy box to a signed letter of intent with a seller.'],
    likelihood: [
      `${GUARANTEE_HEADLINE}. The conditions are in full on the guarantee page.`,
      'Josh bought his clinics in two acquisitions, and in both the sellers financed 100% of the price.',
      'Every deal is structured with commercial debt, seller finance and seller rollover, and tested at 1.5x debt service coverage.',
    ],
    time: ['Kickoff happens within 7 days of signing, and the weekly working sessions start from there.', 'The guarantee is measured at 90 days: a signed letter of intent, or the team keeps working with you.'],
    effort: ['Done with you: Josh’s team builds the buy box, the owner list and the outreach scripts with you.', 'The deposit is credited in full against the engagement fee.'],
  },
  sprint: {
    dream: ['A plan for your first acquisition, built on your own numbers.'],
    likelihood: ['Josh bought his clinics in two acquisitions, and in both the sellers financed 100% of the price.', 'Every structure in the plan is tested at 1.5x debt service coverage.'],
    time: ['Seven days from your numbers to a plan for a first acquisition.'],
    effort: ['Josh’s team prepares the capacity review, the buy box, the shortlist and the structure memo; you bring your numbers.', 'The full Sprint fee is credited against the engagement fee.'],
  },
};

const ADVICE: Record<Element, string> = {
  dream: 'Say what they end up with, in their words: the competitor bought, the letter of intent signed, the group they own.',
  likelihood: 'Give one reason to believe it works for them. Use only what is true: the guarantee as worded (with its conditions linked), the method, or Josh’s two seller-financed acquisitions. Never add a client result we can’t show.',
  time: 'Say when the first real result lands. Use the real schedule only; never invent a speed.',
  effort: 'Say what they don’t have to do alone or give up: who does the work with them, and the credit of what they already paid.',
};

export interface Surface { id: string; label: string; kind: 'page' | 'email' | 'room'; product: Product; edit: string; text: string; edited?: boolean }
export interface Suggestion { element: Element; label: string; advice: string; lines: string[] }

export function suggestionsFor(results: ElementResult[], product: Product): Suggestion[] {
  return results.filter((r) => !r.present).map((r) => ({ element: r.id, label: r.label, advice: ADVICE[r.id], lines: FACT_LINES[product][r.id] }));
}

/** One surface checked (pure). */
export function checkSurface(s: Surface) {
  const elements = checkValueEquation(s.text);
  return { id: s.id, label: s.label, kind: s.kind, product: s.product, edit: s.edit, edited: Boolean(s.edited), elements, missing: elements.filter((e) => !e.present).length, suggestions: suggestionsFor(elements, s.product), excerpt: s.text.replace(/\s+/g, ' ').slice(0, 280) };
}

const plain = (h: string) => h.replace(/<br\s*\/?>|<\/(p|li|div)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

/** The offer emails we check, by template key (the ones that exist in this build). */
export const OFFER_EMAILS: { key: string; label: string; product: Product }[] = [
  { key: 'ch_offer_1', label: 'Challenge offer email 1', product: 'engagement' },
  { key: 'ch_offer_2', label: 'Challenge offer email 2', product: 'engagement' },
  { key: 'ch_offer_3', label: 'Challenge offer email 3', product: 'engagement' },
  { key: 'ch_offer_4', label: 'Challenge offer email 4', product: 'engagement' },
  { key: 'w_offer', label: 'Masterclass offer email', product: 'sprint' },
  { key: 'w_sprint_open', label: 'Masterclass: Sprint open', product: 'sprint' },
  { key: 'w_sprint_closing', label: 'Masterclass: Sprint closing', product: 'sprint' },
];

/** Every offer surface as it reads now (edited emails in their edited form). */
export async function offerSurfaces(rt: Runtime): Promise<Surface[]> {
  const cfg = depositConfig(rt);
  const g = guarantee(rt);
  const dc = depositCopy(cfg);
  const out: Surface[] = [
    { id: 'room_deposit', label: 'Room offer card: engagement deposit (live room, challenge pitch)', kind: 'room', product: 'engagement', edit: '#rooms',
      text: [dc.eyebrow, dc.heading, dc.price, dc.priceNote, ...dc.secures, dc.fees, dc.button, g.headline, g.body].join('\n') },
    { id: 'challenge_offer', label: 'Challenge Day 5 offer page', kind: 'page', product: 'engagement', edit: '#challenge',
      text: [CHALLENGE_OFFER.eyebrow, CHALLENGE_OFFER.heading, CHALLENGE_OFFER.lede, ...CHALLENGE_OFFER.stack, CHALLENGE_OFFER.depositLine, CHALLENGE_OFFER.reason, CHALLENGE_OFFER.guaranteeLink].join('\n') },
  ];
  const sample = { name: '{first_name}', title: 'the live session', when: '{time}', room: '{room}', ticket: null, ticketLabel: null, attended: true, offerOpened: true, closes: '{deadline}', replay: true, deposit: cfg.label };
  const live = liveEmail('replay_last', sample);
  if (live) out.push({ id: 'email:live_replay_last', label: 'Live webinar: offer closing email', kind: 'email', product: 'engagement', edit: '#live', text: [live.subject, live.preheader, ...live.paras].join('\n') });
  const nobuy = postEmail('nobuy_questions', { name: '{first_name}', title: 'the live session', room: '{room}', closes: '{deadline}', deposit: cfg.label, onboarding: null, highlights: [], replayCloses: null });
  out.push({ id: 'email:live_nobuy_questions', label: 'Live webinar: three questions before deciding', kind: 'email', product: 'engagement', edit: '#live', text: [nobuy.subject, nobuy.preheader, ...nobuy.paras].join('\n') });
  const overrides = await loadOverrides(rt).catch(() => new Map());
  for (const e of OFFER_EMAILS) {
    if (!TEMPLATES[e.key]) continue;
    const o = overrides.get(e.key) as { subject?: string; preheader?: string; body?: string; ps?: string } | undefined;
    const d = o?.body ? null : defaultEditable(e.key);
    const text = o?.body ? [o.subject, o.preheader, o.body, o.ps].filter(Boolean).map((x) => plain(String(x))).join('\n') : d ? [d.subject, d.preheader, d.body, d.ps].filter(Boolean).join('\n') : '';
    if (text) out.push({ id: `email:${e.key}`, label: e.label, kind: 'email', product: e.product, edit: `#emails/${e.key}`, text, edited: Boolean(o?.body) });
  }
  return out;
}

/** Funnel HQ: every surface checked, the parts and the lines we may use. */
export async function valueEquationReport(rt: Runtime) {
  const surfaces = (await offerSurfaces(rt)).map(checkSurface);
  return {
    elements: ELEMENTS,
    surfaces,
    summary: { surfaces: surfaces.length, complete: surfaces.filter((s) => !s.missing).length, missing: Object.fromEntries(ELEMENTS.map((e) => [e.id, surfaces.filter((s) => s.elements.some((x) => x.id === e.id && !x.present)).length])) },
    note: 'Suggestions only. Nothing is edited for you. Detection is a word match: it can miss a paraphrase, so read the copy before changing it.',
  };
}

/** Check any pasted copy (an ad, a page draft) for the four parts. */
export function checkPasted(text: string, product: Product = 'engagement') {
  const t = String(text ?? '').slice(0, 20_000);
  return { ...checkSurface({ id: 'pasted', label: 'Pasted copy', kind: 'page', product, edit: '', text: t }), copyIssues: auditCopy(t).slice(0, 10) };
}

export const allFactLines = () => (Object.values(FACT_LINES) as Record<Element, string[]>[]).flatMap((p) => Object.values(p).flat());
