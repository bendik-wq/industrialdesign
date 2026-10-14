import { APPLICATION } from '../config';
import { defang } from '../lib/text';
import { type Lead, parseAnswers } from '../funnel/leads';
import { type Industry, inferIndustry, INDUSTRIES } from '../landers/catalog';

/**
 * Everything we know about a lead from their application and their Calendly
 * booking, shaped for follow-up copy: what they do, how big they are, what
 * they want, what's in the way and what they said in their own words.
 * Every field can be missing (imported bookings, half-finished forms), and
 * every template must still read well without it.
 */
export interface Dossier {
  business: string | null;
  industry: Industry | null;
  revenue: string | null;
  revenueLabel: string | null;
  profit: string | null;
  profitLabel: string | null;
  goal: string | null;
  timeline: string | null;
  blockers: string[];
  readiness: string | null;
  role: string | null;
  /** "Why now?" in their own words (trimmed). */
  whyNow: string | null;
  /** Calendly booking questions they answered. */
  booking: { q: string; a: string }[];
  objection: string | null;
  lostReason: string | null;
  /** Illustrative first-deal ranges for their size (null when we don't know their profit). */
  deal: DealShape | null;
}

export interface DealShape {
  targetProfit: string;
  price: string;
  combined: string;
}

const optionLabel = (id: string, value: string | null) => {
  if (!value) return null;
  const q = APPLICATION.find((x) => x.id === id) as { options?: { value: string; label: string }[] } | undefined;
  return q?.options?.find((o) => o.value === value)?.label ?? null;
};

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * Everything a lead or a Calendly invitee typed is untrusted, and the templates build HTML.
 * Escape it here, once, so no template can forget: their words appear as text, never as markup or links.
 */
export const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const safe = (s: string | null) => (s == null ? null : escHtml(defang(s)));

/** Revenue bands from Calendly qualification ("1-3m"…) mapped onto the application's values. */
const BAND_TO_REVENUE: Record<string, string> = { '<1m': 'lt1m', '1-3m': '1_3m', '3-10m': '3_10m', '10m+': 'gt10m' };

const DEALS: Record<string, DealShape> = {
  lt250k: { targetProfit: '$150k–$300k', price: '$450k–$1M', combined: 'a combined business making around double your profit today' },
  '250k_1m': { targetProfit: '$250k–$800k', price: '$750k–$3M', combined: 'a combined business making around double your profit today, more with the right target' },
  gt1m: { targetProfit: '$1M–$3M', price: '$3M–$12M', combined: 'a group making around double today’s profit, more with the right target' },
};

/** Rough profit band from revenue when we only have revenue (Calendly-only leads). */
const PROFIT_FROM_REVENUE: Record<string, string> = { '1_3m': 'lt250k', '3_10m': '250k_1m', gt10m: 'gt1m' };

export function buildDossier(lead: Lead): Dossier {
  const a = parseAnswers(lead);
  const business = str(a.business);
  const revenue = str(a.revenue) ?? (lead.revenue_band ? BAND_TO_REVENUE[lead.revenue_band] ?? null : null);
  const profit = str(a.profit);
  const blockers = (Array.isArray(a.blockers) ? a.blockers : typeof a.blockers === 'string' ? [a.blockers] : []).filter((b) => typeof b === 'string');
  let booking: { q: string; a: string }[] = [];
  try {
    booking = (JSON.parse(lead.booking_answers || '[]') as { q?: string; a?: string }[])
      .filter((x) => x && typeof x.q === 'string' && typeof x.a === 'string' && x.a.trim())
      .map((x) => ({ q: escHtml(defang(x.q!.trim().slice(0, 200))), a: escHtml(defang(x.a!.trim().slice(0, 400))) }));
  } catch { /* ignore */ }
  const industry = (lead.industry ? INDUSTRIES.find((i) => i.id === lead.industry) : null) ?? inferIndustry(business, ...booking.map((b) => b.a));
  const why = str(a.why_now);
  // Trim on the raw text (so an entity is never cut in half), then escape.
  const whyTrimmed = why ? (why.length > 280 ? `${why.slice(0, 277).replace(/\s+\S*$/, '')}…` : why) : null;
  const profitForDeal = profit && profit !== 'loss' ? profit : revenue ? PROFIT_FROM_REVENUE[revenue] : undefined;
  return {
    business: safe(business),
    industry: industry ?? null,
    revenue,
    revenueLabel: optionLabel('revenue', revenue),
    profit,
    profitLabel: optionLabel('profit', profit),
    goal: str(a.goal),
    timeline: str(a.timeline),
    blockers,
    readiness: str(a.readiness),
    role: str(a.role),
    whyNow: safe(whyTrimmed),
    booking,
    // Matched against fixed lists (OBJECTIONS / LOST_ANGLES), never printed raw.
    objection: lead.objection,
    lostReason: lead.lost_reason,
    deal: profitForDeal ? DEALS[profitForDeal] ?? null : null,
  };
}

/** Behaviour-profile facts that just repeat the application (src/personalize/profile.ts). */
export const ANSWER_FACTS = ['a_business', 'a_revenue', 'a_goal', 'a_timeline', 'a_blockers', 'a_why_now', 'a_readiness'];

/** "dental" / "HVAC" / "medical & GP clinics": an industry label mid-sentence. */
export const industryName = (i: Industry) => (/^[A-Z]{2}/.test(i.label) ? i.label : i.label[0].toLowerCase() + i.label.slice(1));

/** "$250k – $1M" / "under $250k"; null for loss-making (not something to say back). */
export const profitText = (d: Dossier) => (d.profit && d.profit !== 'loss' && d.profitLabel ? d.profitLabel.replace(/^Under /, 'under ') : null);

// ───────────── Copy blocks keyed by their answers ─────────────

/** "your HVAC business" / "your business". */
export const yourBiz = (d: Dossier) => (d.industry ? `your ${d.industry.one}` : 'your business');
/** "HVAC businesses" / "businesses like yours". */
export const peers = (d: Dossier) => (d.industry ? d.industry.many : 'businesses like yours');

export const BLOCKERS: Record<string, { name: string; subject: string; body: string[] }> = {
  deal_flow: {
    name: 'finding the right businesses to buy',
    subject: 'where the good deals actually are',
    body: [
      'You said finding the right business to buy is what’s in the way. That’s the most common answer we get, and the good news is it’s the easiest one to fix.',
      'The best acquisitions almost never get listed. They’re owners in their 60s with no succession plan, competitors who are tired, and the business down the road whose owner has been thinking about getting out for three years and has told nobody.',
      'On the call we’ll sketch your target list: the kind of business, the size, the area, and how we reach those owners directly, before a broker ever gets involved.',
    ],
  },
  funding: {
    name: 'funding and structuring the deal',
    subject: 'how the money side works',
    body: [
      'You said funding and structure is what’s in the way. Fair. It’s the part nobody explains properly.',
      'Here’s the shape of it. Senior debt from a lender covers most of the price, secured against the cash flow of the business you’re buying. The seller carries part as a note, paid out of the same cash flow over a few years, and rolls part into a stake they keep (seller rollover). Stack it right and the financing covers more than the price, so none of your own cash goes in.',
      'Lenders look for a debt service coverage ratio around 1.5: the target’s profit covers its repayments one and a half times. That number decides everything, and we’ll run it on your situation on the call.',
    ],
  },
  valuation: {
    name: 'valuation and negotiation',
    subject: 'what to pay (and how not to overpay)',
    body: [
      'You said valuation and negotiation is what’s in the way. It should be. It’s where most first-time buyers lose money.',
      'Small private businesses usually trade on a multiple of profit, and the multiple moves with how dependent the business is on its owner, how lumpy its revenue is and how clean its books are. The price matters less than the terms: how much the seller carries, over how long, and what’s tied to performance.',
      'On the call we’ll show you how we frame an offer so the seller gets a number they’re happy with and the deal still pays for itself.',
    ],
  },
  integration: {
    name: 'integrating it without breaking your business',
    subject: 'buying without breaking what you’ve built',
    body: [
      'You said integration is what worries you: bolting a second business onto yours without breaking what you’ve built. That instinct is right.',
      'The deals that work start with an integration plan before the LOI is signed: which systems merge, which stay separate for the first year, who runs what, and which customers and staff get a phone call on day one.',
      'We’ll walk through what that looks like for a business your size on the call, so you can see it before you commit to anything.',
    ],
  },
  time: {
    name: 'not having the time',
    subject: 'a few hours a week',
    body: [
      'You said you’re too busy running the business. Every owner who’s done this said the same thing.',
      'Here’s the honest time cost: a few focused hours a week for 90 days. You make the decisions and take the key seller conversations. My team does the modelling, the structuring and the lender introductions with you, so you’re not learning it all from scratch at 10pm.',
      'And here’s the twist: the business you buy often comes with the second-in-charge you’ve been trying to hire.',
    ],
  },
  never_considered: {
    name: 'never having seriously considered it',
    subject: 'the growth path nobody tells you about',
    body: [
      'You said you hadn’t seriously considered buying a business before. Most owners haven’t. It’s not how anyone teaches growth.',
      'But it’s the fastest way to grow there is. Organic growth adds a few customers a month. An acquisition adds a whole customer base, a team and a profit line on the day it settles.',
      'The call is a safe place to find out whether it makes sense for you. No pressure either way.',
    ],
  },
};

export const GOALS: Record<string, { line: string; body: string[] }> = {
  acquire: {
    line: 'grow by acquiring competitors or add-ons',
    body: [
      'You told us you want to grow by buying competitors or add-ons. That’s the cleanest version of this: same industry, same customers, overlapping costs.',
      'A tuck-in acquisition usually means one set of overheads, one office and one admin team, so a lot of the target’s revenue drops straight to profit. That’s how one deal can double a business.',
    ],
  },
  group: {
    line: 'build a group of businesses',
    body: [
      'You told us you want to build a group. That’s the long game, and it’s the one that creates real wealth: a group of businesses is valued at a higher multiple than any one of them alone.',
      'The first deal sets the pattern for the rest: the lender relationships, the structure and the integration playbook. On the call we’ll treat it as deal one of several, not a one-off.',
    ],
  },
  exit: {
    line: 'grow, then sell at a higher valuation',
    body: [
      'You told us you want to grow and then sell at a higher valuation. Buying is often the fastest route to that.',
      'Buyers pay a bigger multiple for a bigger business. Double the profit through an acquisition and you don’t just double the sale price: the multiple usually goes up too. Fund the acquisition with the seller’s and the lender’s money and that uplift is almost all yours.',
    ],
  },
  unsure: {
    line: 'work out the right next move',
    body: [
      'You said you’re not sure yet what you want. That’s an honest answer and a good place to start.',
      'On the call we’ll lay out the paths side by side: grow organically, buy a competitor, build a group, or set up for an exit. You’ll leave knowing which one fits your numbers, even if the answer is “not yet”.',
    ],
  },
};

export const TIMELINES: Record<string, string> = {
  '0_6': 'You said you want to move in the next six months. Good: a signed LOI in 90 days is exactly the pace we work to, which leaves room to settle inside your window.',
  '6_12': 'You said six to twelve months. The search and the first conversations with owners are the slow part, so starting them now is what makes a settlement inside twelve months realistic.',
  '12_plus': 'You said twelve months or more. That’s fine, but the right business rarely comes along on schedule. The owners who win start the conversations early and buy when the right one is ready.',
  exploring: 'You said you’re just exploring. Perfect. The call will show you what a deal would look like for you, with numbers, so exploring turns into an actual decision either way.',
};

/** Answers to the objection they raised on the call (lead.objection). */
export const OBJECTIONS: Record<string, { subject: string; body: string[] }> = {
  Price: {
    subject: 'on the investment',
    body: [
      'On the call the investment came up, and I get it. It’s a real number.',
      'Here’s how I’d think about it: one acquisition at your size adds more profit in its first year than the program costs, and the deal itself is funded by the lender and the seller, not by you. The question isn’t whether you can afford the program. It’s whether you can afford to keep growing one customer at a time.',
      'And there’s the 7-day money-back guarantee if it isn’t what we said it would be.',
    ],
  },
  Timing: {
    subject: 'on timing',
    body: [
      'You mentioned timing on the call. There’s never a perfect time to buy a business: the good ones come up when an owner decides they’re done, not when it suits you.',
      'Starting now doesn’t mean buying now. It means building the target list and starting the conversations, so when the right one is ready, you are too.',
    ],
  },
  'Needs to think': {
    subject: 'a few things to think about',
    body: [
      'You wanted some time to think it over, which is fair. To make the thinking useful, here are the three questions that usually settle it:',
      '1. Does your business have the cash flow to support a deal at around 1.5x debt service coverage?<br>2. Is there a business in your industry or area you’d love to own?<br>3. What happens to your growth in the next three years if you don’t do this?',
      'If you’ve got answers to those, reply and tell me. I’ll tell you honestly whether it makes sense.',
    ],
  },
  'Partner / spouse': {
    subject: 'for your partner',
    body: [
      'You mentioned you want to talk it through with your partner. Good. Anyone who’ll be part of an acquisition should be part of the decision.',
      'Happy to do a short call with both of you, so they hear it first-hand and can ask their own questions. Just reply with a couple of times that work.',
    ],
  },
  'Funding doubts': {
    subject: 'will a lender really fund it?',
    body: [
      'You had doubts about the funding side. Healthy skepticism.',
      'Lenders fund acquisitions on the cash flow of the business being bought, not on your house. If the target’s profit covers its repayments around 1.5 times, it’s fundable. If it doesn’t, we don’t do the deal. And the seller carrying part of the price as a note is normal, not exotic: it’s how most small businesses change hands.',
    ],
  },
  'Trust / proof': {
    subject: 'fair question: why trust us?',
    body: [
      'You wanted more proof before going ahead. Fair. You should be careful who you let near your business.',
      'I’ve bought two businesses with 100% seller finance myself. We work with you, not for you: you run the deal and make every decision, and we’re beside you on the structure, the modelling and the lender conversations. And there’s a 7-day money-back guarantee.',
      'Reply with whatever you’d need to see to be comfortable, and I’ll answer it straight.',
    ],
  },
  'Time to commit': {
    subject: 'the real time cost',
    body: [
      'You were worried about the time it would take. Here’s the honest version: a few focused hours a week for 90 days. We do the heavy lifting on the models and the paperwork with you, and you take the conversations that only an owner can take.',
    ],
  },
  'Not a fit': {
    subject: 'thanks for your time',
    body: [
      'We agreed on the call it isn’t the right fit right now, and I appreciate you being straight about it.',
      'If things change (the business grows, a competitor comes up for sale, a partner wants out), my door’s open.',
    ],
  },
};

/** Long-term re-engagement angle by why they were lost (lead.lost_reason). */
export const LOST_ANGLES: Record<string, string> = {
  Price: 'Last time we spoke the investment was the sticking point. If the numbers on your side have moved since, it might be worth another look.',
  Timing: 'Last time we spoke the timing wasn’t right. Owners come up for sale when they decide they’re done, not on a schedule, so it’s worth keeping an eye out.',
  'No funding fit': 'Last time we spoke the funding didn’t stack up for a deal at that size. Profit grows, and so does what a lender will back, so check in when your numbers move.',
  'Not a decision maker': 'Last time we spoke the decision sat with someone else in the business. If they’d like to hear it first-hand, I’m happy to walk them through it.',
  'Went with someone else': 'You went another way last time, and I hope it’s going well. If you ever want a second opinion on a deal, reply.',
  'Not qualified': 'Last time we spoke the business wasn’t quite at the size where a deal makes sense yet. If that’s changed, I’d like to hear about it.',
  Ghosted: 'We lost touch after the call, which happens. If acquisitions are back on your radar, I’m still here.',
};

export const blockerOf = (d: Dossier, i = 0) => BLOCKERS[d.blockers.filter((b) => BLOCKERS[b])[i] ?? ''] ?? null;
