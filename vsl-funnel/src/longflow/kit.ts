import type { EmailContent, TemplateCtx } from '../integrations/templates';

/**
 * Long flows: every lifecycle flow (abandoned, tier A/B/C, no-show, cancelled, post-call, lost,
 * nurture, the three reactivations) runs for six months, about 1,000 emails, front-loaded:
 *  ~10 a day in month 1, ~6 a day in months 2–3, ~3–4 a day in months 4–6.
 * Each flow has ~200 emails written for its situation; the rest come from a shared library
 * (~800 emails, 16 topics) picked at send time from what the person reads on the site.
 *
 * Emails are data (no code), rendered here, so the copy is easy to review and audit.
 * Placeholders: {name} (their first name). Nothing else is substituted.
 */
export type LongCta =
  | 'next' // the flow's main ask (finish the application / book / the masterclass), worded by the flow
  | 'apply' | 'book' | 'webinar' // a specific ask, whatever the flow
  | `guide:${string}` // a guide on the site, by slug
  | 'reply' // no button: the email ends asking them to reply
  | 'none';

export interface LongEmail {
  id: string;
  subject: string;
  preheader: string;
  /** First entry is the greeting/opening line with {name}. Plain text with <strong>, <em>, <br> and • bullets. */
  body: string[];
  ps?: string;
  cta?: LongCta;
  /** Button label for this email (otherwise the flow's / guide's default). */
  label?: string;
  /** Library only: industry ids this email is about (only sent to owners in that industry). */
  industries?: string[];
}

export const GUIDE_SLUGS = [
  'how-to-buy-a-business-with-no-money-down', 'seller-finance-explained', 'seller-rollover-explained', '60-40-deal-structure', '70-20-10-deal-structure',
  '100-percent-vendor-finance', 'dscr-explained', 'over-financed-acquisition', 'buy-a-business-without-a-personal-guarantee', 'letter-of-intent-buying-a-business',
  'buy-your-competitor', 'find-off-market-businesses-for-sale', 'questions-to-ask-a-business-seller', 'due-diligence-red-flags',
  'buy-a-security-business', 'buy-an-accounting-firm', 'buy-an-insurance-brokerage', 'buy-an-msp-it-services-business', 'buy-a-marketing-agency',
  'buy-a-recruitment-agency', 'buy-a-restaurant-or-venue', 'buy-a-childcare-centre', 'buy-a-logistics-business', 'buy-a-rent-roll',
] as const;

export type Ask = 'apply' | 'book' | 'webinar' | 'followup';
const ASK_LABELS: Record<Ask, string[]> = {
  apply: ['Finish my application →', 'Pick up where I left off →', 'Complete my application →'],
  book: ['Book my strategy call →', 'Pick a time →', 'See the calendar →', 'Map my first deal →'],
  webinar: ['Save my seat at the masterclass →', 'Watch the masterclass →', 'Pick a session →'],
  followup: ['Book a follow-up →', 'Pick a time to finish the conversation →'],
};

/** Extra context the long-flow templates read (set by buildEmail). */
export interface LongCtx { ask?: Ask; webinarUrl?: string }

const fill = (s: string, c: TemplateCtx) => s.replace(/\{name\}/g, c.name);

function hrefFor(kind: Ask | 'apply' | 'book' | 'webinar', c: TemplateCtx & LongCtx) {
  if (kind === 'apply') return c.link('/apply');
  if (kind === 'webinar') return c.link(c.webinarUrl || '/webinar');
  return c.link(c.bookingUrl ? '/book' : '/breakout');
}

/** Renders one data email for a person; `n` varies the default button label. */
export function renderLong(e: LongEmail, c: TemplateCtx & LongCtx, n = 0): EmailContent {
  const out: EmailContent = { subject: fill(e.subject, c), preheader: fill(e.preheader, c), body: e.body.map((b) => fill(b, c)) };
  if (e.ps) out.ps = fill(e.ps, c);
  const cta = e.cta ?? 'next';
  if (cta.startsWith('guide:')) out.cta = { label: e.label ?? 'Read the guide →', href: c.link(`/guides/${cta.slice(6)}`) };
  else if (cta === 'next') {
    const ask = c.ask ?? 'apply';
    const labels = ASK_LABELS[ask];
    out.cta = { label: e.label ?? labels[n % labels.length], href: hrefFor(ask === 'followup' ? 'book' : ask, c) };
  } else if (cta === 'apply' || cta === 'book' || cta === 'webinar') out.cta = { label: e.label ?? ASK_LABELS[cta][0], href: hrefFor(cta, c) };
  return out;
}
