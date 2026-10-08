/**
 * Funnel configuration: copy, experiments, application, scoring and routing.
 *
 * Everything a marketer would want to change lives here. Copy strings may
 * contain trusted inline HTML (<em>, <em>, <strong>, <br>) — they are written
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
  main: { id: 'vsl-main', srcSetting: 'VSL_MAIN_SRC', posterSetting: 'VSL_MAIN_POSTER', ctaRevealAt: 420, gateContent: false, autoplayMuted: true },
  breakout: { id: 'vsl-breakout', srcSetting: 'VSL_BREAKOUT_SRC', posterSetting: 'VSL_BREAKOUT_POSTER', ctaRevealAt: 180, gateContent: false, autoplayMuted: true },
  precall: { id: 'vsl-precall', srcSetting: 'VSL_PRECALL_SRC', fallbackSetting: 'VSL_BREAKOUT_SRC', posterSetting: 'VSL_BREAKOUT_POSTER', ctaRevealAt: 0, gateContent: false, autoplayMuted: true },
};

// ───────────────────────────── Brand ─────────────────────────────

/** Default brand. The dashboard's "Brand name" setting (SITE_NAME) overrides `name` without a redeploy. */
export const BRAND = { name: 'G&L M&A Advisory', founder: 'Josh Li' };

// ───────────────────────────── Landing copy + A/B test ─────────────────────────────

export interface LandingVariant {
  id: string;
  weight: number;
  preHeadline: string;
  headline: string;
  subheadline: string;
}

/** Headline experiment. Assignment is deterministic per visitor (hash of visitor id), so it's sticky without storage.
 *  <em> renders as the italic gold accent in the serif headline. */
export const HEADLINE_EXPERIMENT = {
  id: 'headline-v2',
  variants: [
    {
      id: 'a',
      weight: 50,
      preHeadline: 'For owners of $1M+ businesses',
      headline: 'Double Your Business<br><em>By Acquisition</em>',
      subheadline: 'Buy the competitors and add-ons next to yours, funded by the deal instead of your own cash.',
    },
    {
      id: 'b',
      weight: 50,
      preHeadline: 'For owners of $1M+ businesses',
      headline: 'Your Next $1M In Revenue<br><em>Is Already For Sale</em>',
      subheadline: 'Watch how owners buy the businesses next to theirs with vendor finance, and grow the value of what they’ll eventually sell.',
    },
  ] satisfies LandingVariant[],
};

export const LANDING = {
  ctaLabel: 'See If You Qualify',
  ctaSubtext: 'Takes about 2 minutes. For owners of businesses doing $1M+ in revenue.',
  soundPrompt: 'Click for sound',
  soundAction: 'Click for sound',
  applyTitle: 'See If You <em>Qualify</em>',
  applySubtitle: 'Answer a few questions. If your business is a fit, you’ll pick a time for a free acquisition strategy call.',
  /**
   * Headline numbers under the hero. Use real, verifiable figures only, e.g.
   * { label: 'Deals', value: '40+', detail: 'Acquisitions structured for clients' }. Hidden while empty.
   */
  stats: [] as { label: string; value: string; detail: string }[],
  problemTitle: 'Organic growth is slow. <em>Acquisition is not.</em>',
  problems: [
    { title: 'You’ve hit a ceiling', body: 'More marketing and more hires add revenue one customer at a time, and every new dollar costs more of your time.' },
    { title: 'Your competitors are for sale', body: 'Thousands of owners are approaching retirement with no succession plan. Most of those businesses never get listed.' },
    { title: 'Bigger is worth more', body: 'Larger, more diversified businesses are often valued at a higher multiple of earnings than small ones. Acquisition lifts profit and multiple together.' },
  ],
  processTitle: 'How we grow your business <em>by acquisition</em>',
  /** A real sequence, so it's numbered on the page. */
  process: [
    { title: 'Acquisition audit', body: 'We look at your numbers, your market and your goals to find where an acquisition adds the most value.' },
    { title: 'Source off-market targets', body: 'We find and approach owners in your industry who aren’t listed for sale, so you’re not bidding against private equity.' },
    { title: 'Structure and fund the deal', body: 'Vendor finance and senior debt structured so the acquired business’s cash flow pays for itself, not your operating account.' },
    { title: 'Close and integrate', body: 'Negotiation, due diligence and a 100-day integration plan so the deal adds profit without pulling you back into the weeds.' },
  ],
  /** e.g. { score: '4.9', source: 'Google', count: '120+ reviews' }. Hidden while null. */
  rating: null as { score: string; source: string; count: string } | null,
  /** Real client results only. Hidden while empty. */
  caseStudies: [] as { name: string; business: string; results: string[]; videoUrl?: string; thumbnail?: string }[],
  /** Add only real, verifiable results. Hidden while empty. */
  testimonials: [] as { quote: string; name: string; detail: string }[],
  closeKicker: '$1M+',
  closeHeadline: 'Your next acquisition, <em>structured.</em>',
  forTitle: 'This is for you if…',
  forList: [
    'You own a business doing $1M+ in annual revenue and want to grow faster than organic growth allows.',
    'Your business is profitable, and you want to buy competitors or complementary businesses.',
    'You’re planning an exit in the next few years and want it to be worth more.',
  ],
  notForTitle: 'This is not for you if…',
  notForList: [
    'Your business is under $1M in revenue or not yet profitable.',
    'You’re looking for passive income or a get-rich-quick scheme.',
    'You don’t own the business or can’t make the decision to grow it.',
  ],
};

/** Founder social proof on the resources page, e.g. { platform: 'LinkedIn', followers: '25,000+', url: '…' }. Hidden while empty. */
export const FOUNDER_SOCIALS: { platform: 'LinkedIn' | 'Instagram' | 'YouTube' | 'TikTok' | 'X'; followers: string; url: string }[] = [];

/** Consent + recording notice shown under every form and calendar. */
export const LEGAL_CONSENT =
  'By submitting this form or booking a call, you agree to our Privacy Policy and consent to be contacted by email, phone, SMS and WhatsApp using the details you provided. Calls may be recorded for quality and training purposes.';

// ───────────────────────────── Breakout (VSL #2) + FAQs ─────────────────────────────

export const BREAKOUT = {
  // Shown to B-tier applicants (not booked yet)
  applied: {
    eyebrow: 'Step 2 of 3 — Application received',
    headline: 'Before We Talk, <em>Watch Part 2</em>',
    subheadline:
      'In this breakout session Josh walks through a real add-on acquisition line by line: what the seller carries, what the bank funds, how your existing business makes you the credible buyer, and what it does to your valuation.',
  },
  // Shown after a call is booked (A-tier, or B-tier who booked)
  booked: {
    eyebrow: 'You’re booked ✓',
    headline: 'Your Call Is Confirmed. <em>Watch This Before We Speak.</em>',
    subheadline:
      'Owners who watch this before their call get twice as much out of it. It covers how the call works, what numbers to have ready and how to know if acquisition growth fits your business.',
  },
  prepareTitle: 'Before your call',
  prepare: [
    'Watch the video above in full — we’ll build on it, not repeat it.',
    'Have last year’s revenue and profit (EBITDA) to hand, roughly is fine.',
    'Think about the businesses in your industry you’d most like to own, and your exit timeline.',
    'Join from a quiet place on a laptop, with any business partner involved in the decision.',
  ],
  whatsappTitle: 'Add Josh on WhatsApp',
  whatsappBody:
    'Send Josh a quick message so you get your call reminders and the deal-structure resources straight to your phone.',
  bookTitle: 'Ready to talk now?',
  bookBody: 'If Part 2 made sense, grab a time with one of our M&A advisors.',
};

export const FAQS: { q: string; a: string }[] = [
  {
    q: 'Do I need to use my own cash to acquire a business?',
    a: 'In most of the deals we structure, the majority of the purchase price is funded by vendor finance (the seller is paid over time from the acquired business’s cash flow) and senior debt. Every deal is different and some need a contribution; the aim is to structure deals so your operating cash isn’t what the deal depends on.',
  },
  {
    q: 'Why only businesses doing $1M+?',
    a: 'At that size you already have the team, systems and track record that make sellers and lenders take you seriously, and the profit to support an acquisition. Below $1M, the better move is usually to grow the core business first.',
  },
  {
    q: 'Won’t an acquisition distract me from running my business?',
    a: 'It’s a real risk, which is why integration planning is part of the process from day one. The goal is to buy businesses your team can absorb, and to build the management layer so the group doesn’t depend on you.',
  },
  {
    q: 'What kinds of businesses should I acquire?',
    a: 'Usually competitors, suppliers, or businesses that sell to your customers: established, profitable, often with an owner approaching retirement. We avoid start-ups and turnarounds.',
  },
  {
    q: 'How does this affect what my business is worth?',
    a: 'Larger, more diversified businesses are often valued at a higher multiple of earnings than small ones. Combining profit and lifting the multiple at the same time is why acquisition can grow your exit value faster than organic growth. Outcomes depend on the deals and the market.',
  },
  {
    q: 'What happens on the strategy call?',
    a: 'We look at your business, your growth goals and your exit timeline, then map out what your first acquisition could look like. If we can help, we’ll explain how. If we can’t, we’ll tell you.',
  },
  {
    q: 'Does this work outside Australia?',
    a: 'Vendor finance and SME acquisitions work in most markets, including the US, UK, Canada and New Zealand. Lending rules differ, which we cover on the call.',
  },
  {
    q: 'What does it cost to work with you?',
    a: 'It depends on the level of support your deals need. We cover it on the call once we know it’s a fit, and there’s no pressure to decide on the spot.',
  },
];

export const RESOURCES = {
  eyebrow: 'Application received',
  headline: 'It Looks Like We’re Not <em>A Fit Yet</em>',
  subheadline: 'Our advisory work is built for owners of profitable $1M+ businesses. But you can still get the whole acquisition toolkit, completely free.',
  ps: 'P.S. Seriously, it’s free.',
  goodFitTitle: 'This is a great next step if:',
  goodFit: [
    'You’re growing toward $1M and want to be acquisition-ready when you get there.',
    'You want to understand how vendor-financed deals work before you need one.',
    'You want deal breakdowns and structures sent to you as we see them.',
  ],
  items: [
    { title: 'The $1M+ Acquisition Readiness Checklist', body: 'What lenders and sellers look at in your business before they back you as a buyer.' },
    { title: 'Vendor-Finance Deal Structure Template', body: 'A worked example of how a seller-financed add-on acquisition is put together.' },
    { title: 'Off-Market Seller Outreach Scripts', body: 'The first messages that start conversations with owners in your industry who aren’t listed for sale.' },
  ],
  resourcesUrl: '/resources#kit',
};

export const DISCLAIMER =
  'This site is not part of Facebook, Google or any of their affiliates. Results are not typical and depend on your business, market and the deals available to you. Nothing on this page is financial, legal or tax advice. Acquisitions involve risk, including the loss of money invested; get independent professional advice before entering any transaction.';

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
    id: 'business',
    type: 'text',
    title: 'What does your business do?',
    help: 'One or two lines is plenty, e.g. “Commercial HVAC services across Sydney, 25 staff.”',
    placeholder: 'What you sell, who to, and where',
    minLength: 3,
    points: [],
  },
  {
    id: 'role',
    type: 'single',
    title: 'What’s your role in the business?',
    options: [
      { value: 'owner', label: 'Founder / majority owner', points: 20 },
      { value: 'co_owner', label: 'Co-owner or partner', points: 16 },
      { value: 'exec', label: 'CEO / GM, but not an owner', points: 6, flags: ['not_owner'] },
      { value: 'no_business', label: 'I don’t own a business yet', points: 0, flags: ['no_business'] },
    ],
  },
  {
    id: 'revenue',
    type: 'single',
    title: 'What’s the business’s annual revenue?',
    help: 'Last financial year, roughly.',
    options: [
      { value: 'lt1m', label: 'Under $1M', points: 0, flags: ['under_1m'] },
      { value: '1_3m', label: '$1M – $3M', points: 15, flags: ['small'] },
      { value: '3_10m', label: '$3M – $10M', points: 22 },
      { value: 'gt10m', label: '$10M+', points: 25 },
    ],
  },
  {
    id: 'profit',
    type: 'single',
    title: 'Roughly what is its annual profit (EBITDA)?',
    help: 'Lenders and sellers look at this first.',
    options: [
      { value: 'loss', label: 'Break-even or loss-making', points: 0, flags: ['unprofitable'] },
      { value: 'lt250k', label: 'Under $250k', points: 8 },
      { value: '250k_1m', label: '$250k – $1M', points: 16 },
      { value: 'gt1m', label: '$1M+', points: 20 },
    ],
  },
  {
    id: 'goal',
    type: 'single',
    title: 'What’s your main goal for the next 2–3 years?',
    options: [
      { value: 'acquire', label: 'Grow by acquiring competitors or add-ons', points: 10 },
      { value: 'group', label: 'Build a group of businesses', points: 10 },
      { value: 'exit', label: 'Grow, then sell at a higher valuation', points: 8 },
      { value: 'unsure', label: 'Not sure yet', points: 2 },
    ],
  },
  {
    id: 'timeline',
    type: 'single',
    title: 'When would you want to close your first (or next) acquisition?',
    options: [
      { value: '0_6', label: 'In the next 6 months', points: 15 },
      { value: '6_12', label: '6 – 12 months', points: 10 },
      { value: '12_plus', label: '12 months or more', points: 4 },
      { value: 'exploring', label: 'Just exploring', points: 0, flags: ['exploring'] },
    ],
  },
  {
    id: 'blockers',
    type: 'multi',
    title: 'What’s held you back from acquiring so far?',
    help: 'Pick all that apply.',
    options: [
      { value: 'deal_flow', label: 'Finding the right businesses to buy', points: 0 },
      { value: 'funding', label: 'Funding and structuring the deal', points: 0 },
      { value: 'valuation', label: 'Valuation and negotiation', points: 0 },
      { value: 'integration', label: 'Integrating it without breaking my business', points: 0 },
      { value: 'time', label: 'I’m too busy running the business', points: 0 },
      { value: 'never_considered', label: 'Hadn’t seriously considered it', points: 0 },
    ],
  },
  {
    id: 'readiness',
    type: 'single',
    title: 'If we show you a clear path on the call, are you ready to invest in getting it done?',
    options: [
      { value: 'yes', label: 'Yes — if it’s a fit, I’m ready to move', points: 15 },
      { value: 'partner', label: 'Yes, but I’ll decide with my business partner', points: 9, flags: ['partner'] },
      { value: 'not_now', label: 'Not right now', points: 0, flags: ['not_ready'] },
    ],
  },
  {
    id: 'why_now',
    type: 'text',
    title: 'Why now? What would doubling the size of your business change for you?',
    help: 'The more specific you are, the more useful your call will be.',
    placeholder: 'e.g. We’ve plateaued at $2M and I want to exit within 5 years…',
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

/** Industries lenders won't fund or we don't serve. Matched (whole word, case-insensitive) against "What does your business do?". */
export const EXCLUDED_INDUSTRIES = ['cannabis', 'marijuana', 'adult', 'onlyfans', 'gambling', 'casino', 'crypto', 'forex', 'mlm', 'network marketing'];

/** Free mailbox providers. A business owner applying from one is a weaker signal (used together with size, never alone). */
export const PERSONAL_EMAIL_DOMAINS = ['gmail', 'googlemail', 'yahoo', 'hotmail', 'outlook', 'live', 'icloud', 'me', 'aol', 'proton', 'protonmail', 'gmx'];

/**
 * Hard rules applied after the score. Each caps the best tier a lead can reach.
 * Evaluated in order; the most restrictive cap wins. The funnel is only for
 * owners of $1M+ businesses, so anyone outside that goes to resources (C).
 * Flags come from answers (config above) and from contact checks in scoring.ts:
 * blocked, excluded_industry, personal_email, out_of_market.
 */
export const TIER_RULES: { when: (flags: Set<string>) => boolean; maxTier: Tier; reason: string }[] = [
  { when: (f) => f.has('blocked'), maxTier: 'C', reason: 'On the blocklist' },
  { when: (f) => f.has('excluded_industry'), maxTier: 'C', reason: 'Excluded industry' },
  { when: (f) => f.has('no_business'), maxTier: 'C', reason: 'Doesn’t own a business' },
  { when: (f) => f.has('under_1m'), maxTier: 'C', reason: 'Under $1M revenue' },
  { when: (f) => f.has('not_owner'), maxTier: 'B', reason: 'Not an owner (can’t decide alone)' },
  { when: (f) => f.has('unprofitable'), maxTier: 'B', reason: 'Not profitable yet' },
  { when: (f) => f.has('not_ready'), maxTier: 'B', reason: 'Not ready to invest' },
  { when: (f) => f.has('exploring'), maxTier: 'B', reason: 'Just exploring' },
  { when: (f) => f.has('personal_email') && f.has('small'), maxTier: 'B', reason: 'Personal email + $1–3M revenue' },
  { when: (f) => f.has('out_of_market'), maxTier: 'B', reason: 'Outside our markets' },
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
  { id: 'advisor', name: 'M&A Advisor', tiers: ['B'], weight: 1, bookingSetting: 'BOOKING_URL_B' },
];

/** Pipeline value assumptions used to estimate revenue per source in the dashboard. Edit to match your offer. */
export const ECONOMICS = { programPrice: 10000, currency: 'AUD' };
