import type { Runtime } from '../app';

/**
 * The engagement guarantees (owner approved): a 7-day money-back guarantee, then "Signed LOI in 90 days, or we
 * keep working free".
 * One wording everywhere it is advertised (the live room's deposit offer, the challenge pitch, the welcome
 * page, /guarantee) and written into the engagement agreement, always with its conditions in full and a link
 * to them. Settings may override the wording (GUARANTEE_HEADLINE, GUARANTEE_BODY, GUARANTEE_CONDITIONS, one
 * condition per line). FOR LEGAL REVIEW: Funnel HQ marks this text as awaiting legal review; the public pages
 * don't.
 */

export const GUARANTEE_HEADLINE = 'Signed LOI in 90 days, or we keep working free';
export const GUARANTEE_BODY = 'If you don’t have a signed letter of intent within 90 days, Josh’s team keeps working with you at no extra cost until you do. Or, if you prefer, take a full refund of everything you paid.';
export const GUARANTEE_CONDITIONS = [
  'Kickoff and the last two years of financials within 7 days of signing.',
  'Attend the weekly working sessions, missing no more than two.',
  'Send the agreed owner outreach each week: 25 owner contacts a week unless agreed otherwise, using the scripts provided.',
  'Reply to the team within 2 business days.',
  'Follow the agreed buy box and the 1.5x test. The guarantee doesn’t cover deals you choose outside them.',
];
export const GUARANTEE_DEFINITIONS = [
  'A letter of intent means a signed, non-binding LOI with a seller for a business inside the agreed buy box.',
  'The guarantee doesn’t promise financing, a closed acquisition, or any return.',
];
/** The program's 7-day money-back guarantee (owner confirmed): it runs alongside the LOI guarantee and has no conditions. */
export const MONEY_BACK_HEADLINE = '7-day money-back guarantee';
export const MONEY_BACK_BODY = 'If the engagement isn’t right for you, tell the team within 7 days of signing and you get a full refund of everything you paid. No conditions apply in those first 7 days. After that, the LOI guarantee covers you.';
export const LEGAL_REVIEW_NOTE = 'For legal review: the guarantee wording and conditions have not been reviewed by an attorney yet.';

export interface Guarantee { headline: string; body: string; conditions: string[]; definitions: string[]; url: string; moneyBack: { headline: string; body: string } }

const clean = (v: string | undefined) => (v ?? '').replace(/[<>]/g, '').trim();

export function guarantee(rt: Pick<Runtime, 'settings' | 'origin'>): Guarantee {
  const s = rt.settings as Partial<Record<string, string>>;
  const conditions = clean(s.GUARANTEE_CONDITIONS).split('\n').map((x) => x.replace(/^[-•*\d.)\s]+/, '').trim()).filter(Boolean);
  return {
    headline: clean(s.GUARANTEE_HEADLINE) || GUARANTEE_HEADLINE,
    body: clean(s.GUARANTEE_BODY) || GUARANTEE_BODY,
    conditions: conditions.length ? conditions.slice(0, 12) : GUARANTEE_CONDITIONS,
    definitions: GUARANTEE_DEFINITIONS,
    url: `${rt.origin}/guarantee`,
    moneyBack: { headline: MONEY_BACK_HEADLINE, body: clean(s.MONEY_BACK_BODY) || MONEY_BACK_BODY },
  };
}

/** The guarantee goes into every new engagement agreement unless ENGAGEMENT_GUARANTEE is off. */
export const guaranteeInAgreements = (s: Partial<Record<string, string>>) => !/^(off|no|false|0)$/i.test(String(s.ENGAGEMENT_GUARANTEE ?? '').trim());
