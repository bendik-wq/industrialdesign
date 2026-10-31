import { auditEmail } from '../content/copy-rules';
import { GOALS, buildDossier, escHtml, industryName } from '../followup/dossier';
import type { Lead } from '../funnel/leads';
import type { EmailContent } from '../integrations/templates';
import { safeFirstName } from '../lib/text';
import type { Guarantee } from '../sales/guarantee';
import type { Segment } from './audience';
import type { Dest } from './destination';

/**
 * The win-back emails, in Josh's voice: honest about how long it has been, written from the lead's own application
 * answers and history, pointing to one destination with its real date. No invented deadlines (only the real event
 * date and registration close), no promised results, the call never called free, seller rollover named wherever
 * funding is, and the guarantees only in the exact wording from src/sales/guarantee.ts.
 *
 * A sequence has 4 to 6 emails: the first ones in order, and always the last-note email at the end.
 */

export const MAX_STEPS = 6;
export const MIN_STEPS = 4;
/** Which of the six templates a sequence of `steps` emails uses, in order. */
export const planFor = (steps: number) => {
  const n = Math.max(MIN_STEPS, Math.min(MAX_STEPS, Math.round(steps) || 5));
  return [...Array.from({ length: n - 1 }, (_, i) => i), MAX_STEPS - 1];
};
export const TEMPLATE_NAMES = ['Honest re-open', 'How the money side works', 'Their sticking point', 'Proof and risk', 'The cost of waiting', 'Last note'];

export interface CopyFacts {
  why: string | null; goalLine: string | null; industry: string | null; revenue: string | null; blocker: string | null; timeline: string | null;
}
export interface CopyCtx {
  name: string; segment: Segment; month: string; since: string; facts: CopyFacts; dest: Dest; link: string; guarantee: Guarantee | null;
}

const DAY = 86_400_000;
/** "3 weeks", "5 months", "over a year", "2 years". */
export function sinceText(days: number) {
  if (days < 56) return `${Math.max(1, Math.round(days / 7))} weeks`;
  const months = Math.round(days / 30.44);
  if (months < 12) return `${months} months`;
  const years = Math.floor(days / 365.25);
  return years <= 1 ? 'over a year' : `${years} years`;
}
export function monthText(t: number, now: number, tz: string) {
  const f = (o: Intl.DateTimeFormatOptions) => { try { return new Intl.DateTimeFormat('en-US', { ...o, timeZone: tz }).format(t); } catch { return new Intl.DateTimeFormat('en-US', o).format(t); } };
  const sameYear = f({ year: 'numeric' }) === (() => { try { return new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone: tz }).format(now); } catch { return String(new Date(now).getUTCFullYear()); } })();
  return sameYear ? f({ month: 'long' }) : f({ month: 'long', year: 'numeric' });
}

/** What the emails say back to them, from their own answers (escaped once in the dossier; never raw markup). */
export function factsFor(lead: Lead): CopyFacts {
  const d = buildDossier(lead);
  return {
    why: d.whyNow,
    goalLine: d.goal && GOALS[d.goal] ? GOALS[d.goal].line : null,
    industry: d.industry ? escHtml(industryName(d.industry)) : null,
    revenue: d.revenueLabel ? escHtml(d.revenueLabel.replace(/\s*–\s*/g, ' to ')) : null,
    blocker: d.blockers.find((b) => b in BLOCKER_LINES) ?? null,
    timeline: d.timeline && d.timeline in TIMELINE_WORDS ? d.timeline : null,
  };
}

const SEGMENT_LINE: Record<Segment, (c: CopyCtx) => string> = {
  lost: (c) => `We last spoke in ${c.month}, about ${c.since} ago, and it didn't go further at the time.`,
  no_show: (c) => `You booked a call with us in ${c.month}, about ${c.since} ago, and the call didn't happen.`,
  cancelled: (c) => `You booked a call with us in ${c.month}, about ${c.since} ago, and cancelled it.`,
  applied: (c) => `You applied to work with us in ${c.month}, about ${c.since} ago, and never picked a call time.`,
  registered: (c) => `You signed up for one of our sessions in ${c.month}, about ${c.since} ago, and we haven't been in touch since.`,
  ticket_no_sprint: (c) => `You bought a Masterclass ticket in ${c.month}, about ${c.since} ago, and we haven't spoken since.`,
};

/** Their own words or answers, said back once. */
function theirAnswer(c: CopyCtx) {
  const f = c.facts;
  if (f.why) return `When you applied, you wrote: "${f.why.replace(/[.\s]+$/, '')}."`;
  if (f.goalLine && f.industry) return `You told us you run a ${f.industry} business and want to ${f.goalLine}.`;
  if (f.goalLine) return `You told us you want to ${f.goalLine}.`;
  if (f.industry && f.revenue) return `You told us you run a ${f.industry} business doing ${f.revenue} a year.`;
  if (f.industry) return `You told us you run a ${f.industry} business.`;
  return null;
}

/** One paragraph on the destination, with its real date and price. */
function destLine(c: CopyCtx) {
  const d = c.dest;
  if (d.kind === 'live') {
    const price = d.price ? `A ticket is ${d.price}.` : 'There is no charge to register.';
    return `I'm running a live webinar on Zoom on ${d.when}: ${escHtml(d.title)}. ${price}`;
  }
  if (d.kind === 'challenge') {
    const price = d.price ? ` The ticket is ${d.price}.` : '';
    return `The next First Deal Challenge starts on ${d.when}: five live days on Zoom, ${d.minutes ?? 90} minutes each, and you finish with your own deal plan.${price}`;
  }
  const when = d.when ? `The next scheduled showing is ${d.when}.` : d.jitEvery ? `Showings start every ${d.jitEvery} minutes through the day, so you pick the time.` : '';
  const price = d.price ? ` A ticket is ${d.price}.` : '';
  return `${escHtml(d.title)} is the recorded session where I walk through how a first acquisition is put together. ${when}${price}`.replace(/\s+/g, ' ').trim();
}

const STRUCTURE_LINE: Record<Dest['kind'], string> = { masterclass: 'The Masterclass walks through the structure with numbers.', live: 'The webinar walks through the structure with numbers.', challenge: 'Day 4 of the challenge covers the stack and the 1.5x test with your own numbers.' };
const CTA: Record<Dest['kind'], string> = { live: 'Register for the live webinar', challenge: 'Join the First Deal Challenge', masterclass: 'Pick a Masterclass time' };
const FUNDING = 'commercial debt from a lender, seller finance (the seller carries part of the price as a note paid from the business\'s own cash flow) and seller rollover (the seller keeps a stake in the new company)';

const BLOCKER_LINES: Record<string, { subject: string; body: string[] }> = {
  deal_flow: { subject: 'Where the businesses worth buying are', body: [
    'When you applied, you said finding the right business to buy was the hard part.',
    'The best targets are off-market: owners with no successor who have never listed their business. Reaching them directly, before a broker is involved, is a skill you can learn.',
  ] },
  funding: { subject: 'Where the money for a first deal comes from', body: [
    'When you applied, you said funding the deal was the hard part.',
    `The answer is a stack: ${FUNDING}. I bought my own clinics in two acquisitions, and in both the sellers financed 100% of the price.`,
  ] },
  valuation: { subject: 'What to pay for a business', body: [
    'When you applied, you said valuation and negotiation were the hard part.',
    'The terms matter as much as the price: how much the seller carries, over how long, and how much they roll into the new company. Get those right and the deal pays for itself from the business\'s own profit.',
  ] },
  integration: { subject: 'Buying without breaking what you built', body: [
    'When you applied, you said integrating a second business was what worried you.',
    'The order matters: agree the shape of the deal with the seller first, then take it to the lender, and decide who runs what before you sign.',
  ] },
  time: { subject: 'The time a first deal takes', body: [
    'When you applied, you said time was the problem.',
    'The work that only you can do is choosing the buy box and having the first owner conversations. The modelling and the structure are what my team does with you.',
  ] },
};
const DEFAULT_BLOCKER = { subject: 'The growth path owners aren\'t taught', body: [
  'Buying a competitor isn\'t the growth path most owners were taught.',
  'An acquisition adds a customer base, a team and a profit line on the day it settles. A group of businesses also trades at a higher multiple than a single one (illustrative only: 3 to 5x profit for one business, 8 to 12x for a group).',
] };

const TIMELINE_WORDS: Record<string, string> = { '0_6': 'within six months', '6_12': 'in six to twelve months', '12_plus': 'in twelve months or more', exploring: 'whenever the right business came along' };

const hi = (c: CopyCtx) => `Hi ${escHtml(c.name)},`;
const cta = (c: CopyCtx) => ({ label: CTA[c.dest.kind], href: c.link });

/** The six templates. Each body paragraph holds three sentences at most. */
const TEMPLATES: ((c: CopyCtx) => EmailContent)[] = [
  // 0: the honest re-open
  (c) => ({
    subject: `It's been ${c.since}`,
    preheader: `An invitation, and why I'm writing now.`,
    body: [hi(c), SEGMENT_LINE[c.segment](c), theirAnswer(c) ?? '', 'I\'d like to invite you to the place where I teach the whole method, start to finish.', destLine(c), 'The link below has the details and the registration.'].filter(Boolean),
    cta: cta(c),
  }),
  // 1: the money side (seller rollover named)
  (c) => ({
    subject: 'How the money side of a first deal works',
    preheader: 'The three sources of funding in one deal.',
    body: [hi(c), 'Of the 90 owners who booked calls with us, 24 wanted help with funding and 23 with structuring the debt. That\'s the part nobody explains properly.',
      `A first deal stacks three sources: ${FUNDING}.`,
      'Lenders then apply the 1.5x debt service coverage test: the target\'s profit has to cover its repayments one and a half times. That single number decides whether the deal works.',
      destLine(c), STRUCTURE_LINE[c.dest.kind]],
    cta: cta(c),
  }),
  // 2: their sticking point
  (c) => {
    const b = (c.facts.blocker && BLOCKER_LINES[c.facts.blocker]) || DEFAULT_BLOCKER;
    return {
      subject: b.subject,
      preheader: 'The part you said was in the way.',
      body: [hi(c), ...b.body, destLine(c)],
      cta: cta(c),
    };
  },
  // 3: proof and risk (the guarantees, exact wording, only where the deposit offer is what's sold)
  (c) => {
    const g = c.guarantee;
    if (c.dest.guarantee && g) return {
      subject: 'If the deal doesn\'t come together',
      preheader: 'Both guarantees, in full.',
      body: [hi(c),
        `I open the engagement deposit at the end of ${c.dest.short}. It's credited in full against the advisory engagement, and whether you take it is your decision.`,
        `<strong>${escHtml(g.moneyBack.headline)}</strong>`, escHtml(g.moneyBack.body),
        `<strong>${escHtml(g.headline)}</strong>`, escHtml(g.body),
        `The conditions are listed in full here: <a href="${escHtml(g.url)}">${escHtml(g.url.replace(/^https?:\/\//, ''))}</a>.`,
        destLine(c)],
      cta: cta(c),
    };
    return {
      subject: 'How I bought my own clinics',
      preheader: 'Two acquisitions, both financed by the sellers.',
      body: [hi(c),
        'I bought my own clinics in two acquisitions. In both, the sellers financed 100% of the price.',
        `That's the structure the Masterclass teaches: ${FUNDING}. The order matters too: agree the shape of the deal with the seller first, then take it to the lender.`,
        destLine(c)],
      cta: cta(c),
    };
  },
  // 4: the cost of waiting (their own timeline, honestly)
  (c) => ({
    subject: 'What another year of organic growth costs',
    preheader: 'The difference between adding customers and adding a business.',
    body: [hi(c),
      c.facts.timeline ? `When you applied, you said you wanted to move ${TIMELINE_WORDS[c.facts.timeline]}. About ${c.since} have passed since then.` : `About ${c.since} have passed since we were last in touch.`,
      'Organic growth adds customers a few at a time. Buying a competitor adds a customer base, a team and a profit line on the day it settles.',
      'Owners with no successor sell to whoever brings them a workable offer. That buyer can be you, or one of your competitors.',
      destLine(c)],
    cta: cta(c),
  }),
  // 5: the last note (the real date and close, then we stop)
  (c) => ({
    subject: `Last note about ${c.dest.short}`,
    preheader: c.dest.closesText ?? 'After this one, I stop writing about it.',
    body: [hi(c),
      `This is my last email about ${c.dest.short}.`,
      destLine(c),
      c.dest.closesText ?? 'There\'s no deadline on this one. The link stays open.',
      'If the timing still isn\'t right, there\'s nothing to do. If something has changed on your side, reply and tell me where things stand.'],
    cta: cta(c),
  }),
];

/** The email for one template (0..5). Audited; a quote of theirs that trips the copy rules is left out. */
export function winbackEmail(template: number, c: CopyCtx): EmailContent {
  const t = TEMPLATES[Math.max(0, Math.min(TEMPLATES.length - 1, template))];
  const content = t(c);
  if (auditEmail(content).length && c.facts.why) return t({ ...c, facts: { ...c.facts, why: null } });
  return content;
}

/** The full context for a lead (their facts, how long it has been). */
export function copyCtx(lead: Lead, o: { segment: Segment; lastActiveAt: number; now: number; tz: string; dest: Dest; link: string; guarantee: Guarantee | null }): CopyCtx {
  return {
    name: safeFirstName(lead.first_name) ?? 'there',
    segment: o.segment,
    month: monthText(o.lastActiveAt, o.now, o.tz),
    since: sinceText((o.now - o.lastActiveAt) / DAY),
    facts: factsFor(lead),
    dest: o.dest, link: o.link, guarantee: o.guarantee,
  };
}
