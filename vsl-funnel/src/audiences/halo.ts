/**
 * Halo retargeting map (Sabri Suby's "halo"): every engaged state gets its own audience and its own next-step
 * creative, so the people who are not ready today see the next piece of the argument instead of the same cold ad.
 *
 * Each state names the audiences (from src/audiences/catalog.ts, created in Meta only through "Create all in
 * Meta", the approval in Command) and a recommended concept (desire, awareness, format, framework, angle) for the
 * concept machinery in src/marketing/concepts.ts. "Draft 3 ads" writes one concept of three ads for the state and
 * queues the launch for approval like every other round. Nothing here reaches Meta or anybody's inbox by itself.
 *
 * Audiences only ever hold people the consent rules allow (src/audiences/segments.ts eligibility); website and
 * video audiences are built by Meta from the Pixel, the Conversions API and its own video views.
 */
import type { Runtime } from '../app';
import { DAY_TITLES } from '../challenge/content';
import type { AngleSrc, ConceptSpec, Desire, Awareness, Format, Framework } from '../marketing/concepts';
import { draftRound, templateAds } from '../marketing/concepts';
import { AUDIENCES } from '../research/analyze';
import { audiencesReport } from './sync';

export interface HaloState {
  id: string; label: string; group: string;
  /** Plan keys of the audiences this state targets (list and website versions, or the video engagement audience). */
  audiences: string[];
  /** Why this state gets its own creative, and what the next step is. */
  nextStep: string;
  concept: { desire: Desire; awareness: Awareness; format: Format; framework: Framework; angle: Omit<AngleSrc, 'id' | 'key' | 'audience'> & { audience?: string } };
}

const ONES = ['one', 'two', 'three', 'four', 'five'];
const angle = (hook: string, promise: string, belief: string, proof_id = 'none') => ({ hook, promise, belief, proof_id });

/** The map: one row per engaged state not yet covered by a cold or a generic warm audience. */
export function haloStates(): HaloState[] {
  const s: HaloState[] = [
    {
      id: 'video50', label: 'Watched half of an ad video', group: 'Ad engagement', audiences: ['video_ads_watched50'],
      nextStep: 'They heard the idea; show them the order of the deal and send them to the masterclass.',
      concept: { desire: 'be_the_buyer', awareness: 'solution', format: 'mechanism', framework: 'mechanism',
        angle: angle('The order matters more than the money: agree the shape with the seller first, then take it to the lender.', 'The masterclass walks through each step on a real-sized example.', 'You need the bank to say yes before you talk to a seller.') },
    },
  ];
  for (const f of [{ id: 'live', label: 'live webinar' }, { id: 'auto', label: 'masterclass' }, { id: 'challenge', label: 'challenge' }] as const) {
    s.push({
      id: `noshow_${f.id}`, label: `Registered for the ${f.label}, didn’t attend`, group: 'Registered, not attended', audiences: [`list_reg_noshow_${f.id}`, `web_reg_noshow_${f.id}`],
      nextStep: 'They wanted it and life got in the way; give them the single idea from the session and a way back in.',
      concept: { desire: 'profit_no_hours', awareness: 'product', format: 'talking_head', framework: 'cost_of_waiting',
        angle: angle('The one idea from the session, in a minute: buy cash flow instead of adding hours.', 'The full walk-through is on the page whenever you have the time.', 'Growth means more hours from the owner.') },
    });
    s.push({
      id: `nobuy_${f.id}`, label: `Attended the ${f.label}, didn’t buy`, group: 'Attended, not bought', audiences: [`list_attended_nobuy_${f.id}`, `web_attended_nobuy_${f.id}`],
      nextStep: 'They know the method; answer the objection that stopped them (the lender, the cash, the seller).',
      concept: { desire: 'be_the_buyer', awareness: 'most', format: 'podcast_clip', framework: 'contrarian',
        angle: angle('The common advice says you need the cash before you talk to a seller. For an owner at $1M+ revenue, the order runs the other way.', 'Josh bought his clinics in two acquisitions, and in both the sellers financed 100% of the price.', 'You need the cash before you talk to a seller.', 'seller_financed') },
    });
  }
  s.push({
    id: 'offer_opened', label: 'Opened the offer, didn’t buy', group: 'Opened the offer', audiences: ['list_sig_offer_opened_nobuy', 'web_sig_offer_opened_nobuy'],
    nextStep: 'They looked at the terms; show plainly what the engagement covers and that the deposit is credited in full.',
    concept: { desire: 'runs_without_you', awareness: 'most', format: 'talking_head', framework: 'third_way',
      angle: angle('What the engagement covers: the buy box, the owner outreach and the deal structure, worked through with Josh’s team.', 'The deposit is credited in full against the engagement fee.', 'Buying a business is something you do alone, after hours.') },
  });
  for (let d = 1; d <= 4; d++) {
    s.push({
      id: `challenge_day${d}`, label: `Came to challenge Day ${d}`, group: 'Challenge days', audiences: [`list_challenge_day${d}`],
      nextStep: `Bring them back for day ${ONES[d]}: ${DAY_TITLES[d].toLowerCase()}.`,
      concept: { desire: 'be_the_buyer', awareness: 'product', format: 'talking_head', framework: 'mechanism',
        angle: angle(`Day ${ONES[d]} of the First Deal Challenge: ${DAY_TITLES[d].toLowerCase()}.`, `Day ${ONES[d]} builds on what you did yesterday, live with Josh.`, 'One session is enough to plan a first deal.') },
    });
  }
  return s;
}

export const haloSpec = (h: HaloState): ConceptSpec => ({
  desire: h.concept.desire, awareness: h.concept.awareness, format: h.concept.format, framework: h.concept.framework,
  audience: h.concept.angle.audience && AUDIENCES.includes(h.concept.angle.audience as never) ? h.concept.angle.audience : AUDIENCES[1],
  angle: { id: null, key: `halo_${h.id}`, audience: AUDIENCES[1], ...h.concept.angle },
});

/** Funnel HQ → Meta audiences → Halo map: each state, its audiences' state in our data and in Meta, and the concept. */
export async function haloReport(rt: Runtime) {
  const rep = await audiencesReport(rt);
  const byKey = new Map(rep.items.map((i) => [i.key, i]));
  const rounds = (await rt.env.DB.prepare("SELECT halo, id, label, status, created_at FROM ads_concept_rounds WHERE halo IS NOT NULL ORDER BY created_at DESC LIMIT 100").all<{ halo: string; id: string; label: string; status: string; created_at: number }>().catch(() => ({ results: [] }))).results;
  return {
    states: haloStates().map((h) => {
      const sample = templateAds(haloSpec(h), 1)[0] ?? null;
      return {
        id: h.id, label: h.label, group: h.group, nextStep: h.nextStep,
        concept: { desire: h.concept.desire, awareness: h.concept.awareness, format: h.concept.format, framework: h.concept.framework, angle: h.concept.angle.hook },
        sampleHook: sample?.hook ?? null,
        audiences: h.audiences.map((k) => { const it = byKey.get(k); return it ? { key: k, name: it.name, kind: it.kind, status: it.status, ours: it.ours?.n ?? null } : { key: k, name: k, kind: null, status: 'not_in_plan', ours: null }; }),
        round: rounds.find((r) => r.halo === h.id) ?? null,
      };
    }),
    pending: rep.pending,
    ready: rep.setup.ready,
  };
}

/** "Draft 3 ads" for one state: one concept, three ads, launch queued for approval. */
export async function draftHalo(rt: Runtime, stateId: string, input: { adset_id?: string } = {}) {
  const h = haloStates().find((x) => x.id === stateId);
  if (!h) throw new Error('Unknown engaged state.');
  const brief = `Retargeting round for people who ${h.label.toLowerCase()}. They already know us; this is next-step content, not the cold ad again. Next step: ${h.nextStep} Never say or imply what the reader did (no "you watched", "you registered"): Meta does not allow ads that assert personal facts.`;
  return draftRound(rt, { specs: [haloSpec(h)], adset_id: input.adset_id, halo: { id: h.id, label: h.label, brief } });
}
