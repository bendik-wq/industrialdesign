/**
 * Funnel configuration: copy, experiments, application, scoring and routing.
 *
 * Everything a marketer would want to change lives here. Copy strings may
 * contain trusted inline HTML (<mark>, <em>, <strong>, <br>) — they are written
 * by us, never by visitors.
 *
 * Proof elements (testimonials, results) are intentionally empty: add real,
 * verifiable results only. Sections with no items are hidden automatically.
 */

export type Tier = 'A' | 'B' | 'C';
export type Route = '/book' | '/breakout' | '/resources';

// ───────────────────────────── Videos ─────────────────────────────

export interface VideoDef {
  id: string;
  srcSetting: 'VSL_MAIN_SRC' | 'VSL_BREAKOUT_SRC' | 'VSL_PRECALL_SRC';
  posterSetting?: 'VSL_MAIN_POSTER' | 'VSL_BREAKOUT_POSTER';
  fallbackSetting?: 'VSL_BREAKOUT_SRC';
  /** Seconds into the video when the CTA (and gated content) is revealed. 0 = immediately. */
  ctaRevealAt: number;
  /** Hide everything below the video until the CTA reveal. */
  gateContent: boolean;
  /** Muted autoplay with a "click for sound" overlay that restarts from 0. */
  autoplayMuted: boolean;
}

export const VIDEOS: Record<'main' | 'breakout' | 'precall', VideoDef> = {
  main: { id: 'vsl-main', srcSetting: 'VSL_MAIN_SRC', posterSetting: 'VSL_MAIN_POSTER', ctaRevealAt: 420, gateContent: true, autoplayMuted: true },
  breakout: { id: 'vsl-breakout', srcSetting: 'VSL_BREAKOUT_SRC', posterSetting: 'VSL_BREAKOUT_POSTER', ctaRevealAt: 180, gateContent: false, autoplayMuted: true },
  precall: { id: 'vsl-precall', srcSetting: 'VSL_PRECALL_SRC', fallbackSetting: 'VSL_BREAKOUT_SRC', posterSetting: 'VSL_BREAKOUT_POSTER', ctaRevealAt: 0, gateContent: false, autoplayMuted: true },
};

// ───────────────────────────── Landing copy + A/B test ─────────────────────────────

export interface LandingVariant {
  id: string;
  weight: number;
  preHeadline: string;
  headline: string;
  subheadline: string;
}

/** Headline experiment. Assignment is deterministic per visitor (hash of visitor id), so it's sticky without storage. */
export const HEADLINE_EXPERIMENT = {
  id: 'headline-v1',
  variants: [
    {
      id: 'a',
      weight: 50,
      preHeadline: 'For corporate professionals &amp; business owners who want to own cash-flowing businesses',
      headline:
        'How To Acquire An Established, <mark>Profitable Business</mark> Without Using Your Own Savings',
      subheadline:
        'Watch the short video below to see the 3C Acquisition Model — the exact Capabilities → Capital → Closing process our members use to find off-market businesses, get the seller to help finance the deal, and close without competing with private equity.',
    },
    {
      id: 'b',
      weight: 50,
      preHeadline: 'Attention: anyone who has ever thought about buying a business',
      headline:
        'There Are Two Ways To Buy A Business. <mark>Both Are Broken.</mark> Here’s The Third Way.',
      subheadline:
        'Saving a deposit takes years. Raising money costs you control. In this video, Josh Li breaks down the third way — vendor finance, a credible board and off-market deal flow — and how members use it to buy cash-flowing businesses.',
    },
  ] satisfies LandingVariant[],
};

export const LANDING = {
  ctaLabel: 'Apply To Work With Us',
  ctaSubtext: 'Takes about 2 minutes. If you’re a fit, you’ll book a free acquisition strategy call.',
  soundPrompt: 'Your video has started',
  soundAction: 'Click to listen',
  gateNotice: 'The application unlocks during the video. Keep watching.',
  discoverTitle: 'In this video you’ll discover',
  discover: [
    '<strong>Why sellers don’t sell to the highest bidder</strong> — and how to become the buyer they trust with the business they spent 20 years building.',
    '<strong>The vendor-finance structure</strong> that lets the business’s own cash flow pay for the acquisition, instead of your savings.',
    '<strong>How to look bankable before you’ve bought anything</strong> — the board, advisors and credibility packet lenders and sellers want to see.',
  ],
  forTitle: 'This is for you if…',
  forList: [
    'You’re a corporate professional who wants ownership, not another promotion.',
    'You already own a business and want to grow by acquiring, not by grinding.',
    'You have capital to deploy and want cash flow, not more market exposure.',
  ],
  notForTitle: 'This is not for you if…',
  notForList: [
    'You’re looking for a get-rich-quick scheme or passive income with zero work.',
    'You aren’t willing to invest in yourself, your advisors and your process.',
  ],
  /** Add only real, verifiable results. Hidden while empty. */
  testimonials: [] as { quote: string; name: string; detail: string }[],
};

// ───────────────────────────── Breakout (VSL #2) + FAQs ─────────────────────────────

export const BREAKOUT = {
  // Shown to B-tier applicants (not booked yet)
  applied: {
    eyebrow: 'Step 2 of 3 — Application received',
    headline: 'Before We Talk, <mark>Watch Part 2</mark>',
    subheadline:
      'In this breakout session Josh walks through a real deal structure line by line — where the money comes from, what the seller carries, and what the bank needs to see.',
  },
  // Shown after a call is booked (A-tier, or B-tier who booked)
  booked: {
    eyebrow: 'You’re booked ✓',
    headline: 'Your Call Is Confirmed. <mark>Watch This Before We Speak.</mark>',
    subheadline:
      'Members who watch this before their call get twice as much out of it. It covers how the call works, what to prepare and how to know if the 3C model fits you.',
  },
  prepareTitle: 'Before your call',
  prepare: [
    'Watch the video above in full — we’ll build on it, not repeat it.',
    'Have a rough idea of your budget, timeline and the industries you’d enjoy owning.',
    'Join from a quiet place on a laptop, with any partner involved in the decision.',
  ],
  whatsappTitle: 'Add Josh on WhatsApp',
  whatsappBody:
    'Send Josh a quick message so you get your call reminders and the deal-structure resources straight to your phone.',
  bookTitle: 'Ready to talk now?',
  bookBody: 'If Part 2 made sense, grab a time with an acquisition advisor.',
};

export const FAQS: { q: string; a: string }[] = [
  {
    q: 'Do I really not need my own money to buy a business?',
    a: 'Most of the purchase price in the deals we teach is funded by vendor finance (the seller is paid over time from the business’s cash flow) and senior debt. Every deal is different and some require a contribution — the model is about structuring so your personal savings aren’t what the deal depends on. You will still need to invest in your own education, advisors and due diligence.',
  },
  {
    q: 'Do I need experience running a business?',
    a: 'No. Many members come from corporate roles. The “Capabilities” part of the model is about building a board and operating team around you so lenders and sellers see a credible buyer, not a first-timer on their own.',
  },
  {
    q: 'What kinds of businesses do members buy?',
    a: 'Established, profitable small-to-medium businesses with stable cash flow, typically with owners approaching retirement: services, trades, healthcare, distribution and B2B. We avoid start-ups and turnarounds.',
  },
  {
    q: 'How long does it take to close a first acquisition?',
    a: 'It depends on your time, market and deal size. A realistic plan is several months from starting your search to completion. Anyone promising a guaranteed timeline is guessing.',
  },
  {
    q: 'Is this a course, or do you work with me?',
    a: 'It’s an implementation program: training, templates and tools plus live support on your actual deals — sourcing, structuring, lender introductions and negotiation.',
  },
  {
    q: 'What happens on the strategy call?',
    a: 'We look at where you are today, the kind of business you want to own and your timeline, then map out what your first acquisition could look like. If we can help, we’ll explain how. If we can’t, we’ll tell you.',
  },
  {
    q: 'Does this work outside Australia?',
    a: 'Vendor finance and small-business acquisition work in most markets, including the US, UK, Canada and New Zealand. Lending rules differ, which we cover on the call.',
  },
  {
    q: 'How much does the program cost?',
    a: 'Investment depends on the level of support that fits your goals. We cover it on the call once we know it’s a fit — there’s no pressure to decide on the spot.',
  },
];

export const RESOURCES = {
  eyebrow: 'Application received',
  headline: 'Your Free <mark>Acquisition Starter Kit</mark> Is On Its Way',
  subheadline:
    'Based on your answers, the best next step is to get the fundamentals in place first. We’ve sent the starter kit to your inbox — and you can get it on WhatsApp too.',
  items: [
    { title: 'The 3C Acquisition Checklist', body: 'The Capabilities, Capital and Closing milestones in the order they happen.' },
    { title: 'Vendor-Finance Deal Structure Template', body: 'A worked example of how a seller-financed deal is put together.' },
    { title: 'Off-Market Seller Outreach Scripts', body: 'The first messages that start conversations with owners who aren’t listed.' },
  ],
  resourcesUrl: '/resources#kit',
};

export const DISCLAIMER =
  'This site is not part of Facebook, Google or any of their affiliates. Results are not typical and depend on your effort, experience, market and the deals available to you. Nothing on this page is financial, legal or tax advice. Acquisitions involve risk, including the loss of money invested; get independent professional advice before entering any transaction.';

// ───────────────────────────── Application ─────────────────────────────

export interface Option {
  value: string;
  label: string;
  points: number;
  /** Flags drive hard routing rules (see TIER_RULES). */
  flags?: string[];
}

export type Question =
  | { id: 'contact'; type: 'contact'; title: string; help?: string }
  | { id: string; type: 'single' | 'multi'; title: string; help?: string; options: Option[] }
  | { id: string; type: 'text'; title: string; help?: string; placeholder?: string; minLength: number; points: { minChars: number; points: number }[] };

/** One question per step (Typeform-style). Step 1 captures contact details so abandons can be recovered. */
export const APPLICATION: Question[] = [
  {
    id: 'contact',
    type: 'contact',
    title: 'Let’s start with the basics',
    help: 'We’ll use this to send your results. No spam — unsubscribe any time.',
  },
  {
    id: 'situation',
    type: 'single',
    title: 'Which best describes you right now?',
    options: [
      { value: 'corporate_senior', label: 'Senior corporate professional / executive', points: 22 },
      { value: 'employee', label: 'Employed, wanting to own something of my own', points: 12 },
      { value: 'owner_one', label: 'I own one business', points: 24 },
      { value: 'owner_multi', label: 'I own several businesses', points: 25 },
      { value: 'investor', label: 'Investor with capital to deploy', points: 25 },
      { value: 'student', label: 'Student / between jobs', points: 0, flags: ['low_fit'] },
    ],
  },
  {
    id: 'income',
    type: 'single',
    title: 'What’s your current annual income (or business profit)?',
    help: 'This helps us understand which deal sizes are realistic for you.',
    options: [
      { value: 'lt75', label: 'Under $75k', points: 0, flags: ['low_income'] },
      { value: '75_150', label: '$75k – $150k', points: 8 },
      { value: '150_300', label: '$150k – $300k', points: 15 },
      { value: 'gt300', label: '$300k+', points: 20 },
    ],
  },
  {
    id: 'capital',
    type: 'single',
    title: 'How much could you invest in yourself to make your first acquisition happen?',
    help: 'Education, advisors and due diligence — not the purchase price.',
    options: [
      { value: 'lt5', label: 'Less than $5k', points: 0, flags: ['no_capital'] },
      { value: '5_25', label: '$5k – $25k', points: 12 },
      { value: '25_100', label: '$25k – $100k', points: 20 },
      { value: 'gt100', label: '$100k+', points: 25 },
    ],
  },
  {
    id: 'timeline',
    type: 'single',
    title: 'When do you want to own your first (or next) business?',
    options: [
      { value: '0_3', label: 'In the next 3 months', points: 15 },
      { value: '3_6', label: '3 – 6 months', points: 11 },
      { value: '6_12', label: '6 – 12 months', points: 5 },
      { value: 'exploring', label: 'Just exploring', points: 0, flags: ['exploring'] },
    ],
  },
  {
    id: 'blockers',
    type: 'multi',
    title: 'What’s stopped you so far?',
    help: 'Pick all that apply.',
    options: [
      { value: 'capital', label: 'Not enough capital for a deposit', points: 0 },
      { value: 'deal_flow', label: 'Finding good businesses for sale', points: 0 },
      { value: 'credibility', label: 'Sellers / banks not taking me seriously', points: 0 },
      { value: 'structure', label: 'Not knowing how to structure a deal', points: 0 },
      { value: 'time', label: 'Time', points: 0 },
      { value: 'confidence', label: 'Not sure I could run it', points: 0 },
    ],
  },
  {
    id: 'readiness',
    type: 'single',
    title: 'If we show you exactly how on the call, are you ready to invest in getting it done?',
    options: [
      { value: 'yes', label: 'Yes — if it’s a fit, I’m ready to move', points: 15 },
      { value: 'partner', label: 'Yes, but I’ll decide together with my partner', points: 9, flags: ['partner'] },
      { value: 'not_now', label: 'Not right now', points: 0, flags: ['not_ready'] },
    ],
  },
  {
    id: 'why_now',
    type: 'text',
    title: 'Why now? What would owning a cash-flowing business change for you?',
    help: 'The more specific you are, the more useful your call will be.',
    placeholder: 'e.g. I’ve hit a ceiling in my role and want…',
    minLength: 10,
    points: [
      { minChars: 160, points: 5 },
      { minChars: 60, points: 3 },
    ],
  },
];

// ───────────────────────────── Scoring + routing ─────────────────────────────

/** Countries we can actively serve. Leads outside get a flag (not a penalty). */
export const TARGET_COUNTRIES = ['AU', 'NZ', 'US', 'CA', 'GB', 'IE', 'SG', 'AE'];

export const TIER_THRESHOLDS = { A: 70, B: 40 } as const;

/**
 * Hard rules applied after the score. Each caps the best tier a lead can reach.
 * Evaluated in order; the most restrictive cap wins.
 */
export const TIER_RULES: { when: (flags: Set<string>) => boolean; maxTier: Tier; reason: string }[] = [
  { when: (f) => f.has('low_fit'), maxTier: 'C', reason: 'Student / between jobs' },
  { when: (f) => f.has('no_capital') && f.has('low_income'), maxTier: 'C', reason: 'No capital and low income' },
  { when: (f) => f.has('no_capital'), maxTier: 'B', reason: 'Under $5k to invest' },
  { when: (f) => f.has('not_ready'), maxTier: 'B', reason: 'Not ready to invest' },
  { when: (f) => f.has('exploring'), maxTier: 'B', reason: 'Just exploring' },
];

export const TIER_ROUTES: Record<Tier, Route> = { A: '/book', B: '/breakout', C: '/resources' };

export interface Closer {
  id: string;
  name: string;
  tiers: Tier[];
  /** Relative share of leads in round-robin. */
  weight: number;
  bookingSetting: 'BOOKING_URL_A' | 'BOOKING_URL_B';
}

/** Lead routing: qualified leads are round-robined (weighted) across closers who take that tier. */
export const CLOSERS: Closer[] = [
  { id: 'josh', name: 'Josh Li', tiers: ['A'], weight: 1, bookingSetting: 'BOOKING_URL_A' },
  { id: 'advisor', name: 'Acquisition Advisor', tiers: ['B'], weight: 1, bookingSetting: 'BOOKING_URL_B' },
];

/** Pipeline value assumptions used to estimate revenue per source in the dashboard. Edit to match your offer. */
export const ECONOMICS = { programPrice: 10000, currency: 'AUD' };
