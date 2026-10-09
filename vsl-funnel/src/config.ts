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

/** Colour palettes defined in site.css. The first is the default; pick another in the dashboard (SITE_PALETTE) or preview with ?palette=… */
export const PALETTES = ['navy', 'emerald', 'bone', 'classic'];

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
 *  <em> renders in the accent colour. */
export const HEADLINE_EXPERIMENT = {
  id: 'headline-v7',
  variants: [
    {
      id: 'a',
      weight: 50,
      preHeadline: 'For owners of $1M+ businesses',
      headline: 'Get A Signed LOI For A <em>No-Money-Down Acquisition</em> That Doubles Or Triples Your Business. <span class="nw">Over-Financing</span> Baked In.',
      subheadline: 'Work directly with Josh Li to find the right target, structure the deal so the financing covers the full price, or more, at a profitable <mark>~1.5x DSCR</mark>, and get the LOI signed <mark>inside 90 days</mark>. Backed by a <mark>7-day money-back guarantee</mark>.',
    },
    {
      id: 'b',
      weight: 50,
      preHeadline: 'For owners of $1M+ businesses',
      headline: 'Double Or Triple Your Business With A <em>No-Money-Down Acquisition.</em> Signed LOI In 90 Days, <span class="nw">Over-Financing</span> Baked In.',
      subheadline: 'Work directly with Josh Li to find the right target, structure the deal so the financing covers the full price, or more, at a profitable <mark>~1.5x DSCR</mark>, and get the LOI signed <mark>inside 90 days</mark>. Backed by a <mark>7-day money-back guarantee</mark>.',
    },
  ] satisfies LandingVariant[],
};

export const LANDING = {
  /** Shown under the subheadline. */
  byline: { name: BRAND.founder, role: 'Founder, JC Health Group', initials: 'JL' },
  /** Hard proof under the byline. Every item must be true and provable. */
  proof: [
    '<b>2</b><span>businesses Josh bought with 100% seller finance</span>',
    '<b>90 days</b><span>to a signed LOI</span>',
    '<b>~1.5x</b><span>DSCR, so the deal pays for itself</span>',
    '<b>7 days</b><span>money-back guarantee</span>',
  ],
  soundPrompt: 'Click for sound',
  soundAction: 'Click for sound',
  ctaLabel: 'See If You Qualify',
  applyEyebrow: 'Apply',
  applyTitle: 'See if your business qualifies',
  applySubtitle: 'Two minutes, ten questions. If you’re a fit, you’ll pick a time for a free acquisition strategy call with Josh’s team.',
  /** What the call gives them. Keep these true to how your calls actually run. */
  applyPoints: [
    '<strong>A working session, not a pitch.</strong> We go through your numbers and your market.',
    '<strong>Your target profile.</strong> The business that doubles or triples yours.',
    '<strong>Your deal structure.</strong> Over-financed at ~1.5x DSCR, with none of your own cash.',
  ],
  /** Shown under the application points. Keep it identical to the terms in your client agreement. */
  guarantee: '<strong>7-day money-back guarantee.</strong> Join, and if you decide in the first 7 days it’s not for you, tell us and you get a full refund.',
  faqTitle: 'Before you apply',
  /** Add only real, verifiable results. Hidden while empty. */
  testimonials: [] as { quote: string; name: string; detail: string }[],
};

/** Founder social proof on the resources page, e.g. { platform: 'LinkedIn', followers: '25,000+', url: '…' }. Hidden while empty. */
export const FOUNDER_SOCIALS: { platform: 'LinkedIn' | 'Instagram' | 'YouTube' | 'TikTok' | 'X'; followers: string; url: string }[] = [];

/** Consent + recording notice shown under the form and in the footer. */
export const LEGAL_CONSENT =
  'By submitting this form or booking a call, you agree to our Privacy Policy and consent to be contacted by email, phone, SMS and WhatsApp using the details you provided. Calls may be recorded for quality and training purposes, and calls you make to our AI assistant are recorded and transcribed.';

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
    q: 'Do I really put no money down?',
    a: 'Yes. That’s the structure. Seller finance (the seller is paid over time from the business’s own cash flow) and senior debt cover the purchase price, and the deal is <strong>over-financed</strong>: the financing covers more than the price, and the extra goes to working capital and closing costs. We line the financing up with you before you sign the LOI.',
  },
  {
    q: 'What does a ~1.5x DSCR mean?',
    a: 'DSCR is the debt service coverage ratio: the business’s cash profit divided by its loan repayments. At about 1.5x, the business you buy earns roughly $1.50 for every $1 it owes each year. The deal pays for itself with a buffer, lenders are comfortable, and it doesn’t lean on your existing business.',
  },
  {
    q: 'How does one acquisition double or triple my business?',
    a: 'You buy a business that’s as big as yours, or bigger. Its customers, team and profit join yours on day one, so revenue and profit step up in one move instead of one sale at a time. How much depends on the target you choose; that’s what we work out together in weeks 1–2.',
  },
  {
    q: 'What’s the 7-day money-back guarantee?',
    a: 'Join, and if you decide in the first 7 days it isn’t for you, tell us and you get a full refund. No hoops.',
  },
  {
    q: 'Is this done for me?',
    a: 'No, and that’s deliberate. It’s done <strong>with</strong> you. You’re the buyer, so sellers and lenders need to deal with you. We give you the system, the scripts, the deal structures and the financing introductions, and we’re in the room for the conversations that matter. Expect a few focused hours a week.',
  },
  {
    q: 'What happens in the 90 days?',
    a: 'Weeks 1–2: we audit your business with you and set your target profile. Weeks 3–8: you run outreach to owners, on and off market, with our scripts while we coach every conversation. Weeks 9–13: we’re in the room as you negotiate, we line up the financing with you, and you sign the LOI.',
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
    q: 'How does this affect what my business is worth?',
    a: 'Larger, more diversified businesses are often valued at a higher multiple of earnings than small ones. Combining profit and lifting the multiple at the same time is why acquisition can grow your exit value faster than organic growth. Outcomes depend on the deals and the market.',
  },
  {
    q: 'What happens on the strategy call?',
    a: 'We look at your business, your growth goals and your exit timeline, then map out what your first acquisition could look like. If we can help, we’ll explain how. If we can’t, we’ll tell you.',
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

// ───────────────────────────── Voice agent (inbound only) ─────────────────────────────

/**
 * AI voice assistant that ANSWERS calls: inbound phone calls to your Vapi
 * number, and in-browser calls an applicant starts from /book or /breakout.
 * It never dials out. Outbound AI calls need prior express written consent
 * (US TCPA — the FCC treats AI voices as "artificial voice"), Do Not Call
 * register checks and calling-hours rules (AU Telemarketing Standard), so
 * they're deliberately not built. See docs/VOICE_AGENT.md.
 */
export const VOICE_AGENT = {
  name: 'Sam',
  /** Version this whenever the disclosure wording changes; it's stored with every call. */
  disclosureVersion: 'v1',
  /** Shown next to the "talk now" button before a browser call starts. */
  webDisclosure:
    'You’ll be speaking with an AI assistant, not a person. The call is recorded and transcribed so Josh’s team can prepare for your strategy call. Don’t share card or bank details.',
  firstMessage:
    'Hi, this is Sam, Josh Li’s AI assistant at G and L. Quick heads-up: I’m an AI, and this call is recorded and transcribed so Josh’s team can prepare. Is that okay with you?',
  maxDurationSeconds: 900,
  /** Max browser calls one applicant can start per 24 hours (cost + abuse guard). */
  webCallsPerDay: 3,
};

/** System prompt. {{…}} values are filled per call from the lead record. */
export function voiceSystemPrompt(faqs: { q: string; a: string }[]) {
  const faqText = faqs.map((f) => `Q: ${f.q}\nA: ${f.a.replace(/<[^>]+>/g, '')}`).join('\n\n');
  return `You are Sam, the AI assistant for Josh Li at ${BRAND.name}. You answer inbound calls from business owners.

# Who you're talking to
Caller: {{first_name}} {{last_name}} · Lead ref: {{lead_ref}} · Tier: {{tier}} · Application: {{application_status}}
Known answers: {{known_answers}}
(If these are blank, you don't know the caller yet.)

# The offer (say it plainly, never embellish)
- For owners of profitable businesses doing $1M+ a year.
- Goal: a signed LOI within 90 days on an acquisition that doubles or triples their business, structured with no money down and over-financed (seller finance plus senior debt cover more than the purchase price; the extra goes to working capital and closing costs).
- Deals are structured to be profitable at a debt service coverage ratio (DSCR) of about 1.5: the acquired business earns roughly $1.50 for every $1 of loan repayments.
- Targets can be on or off market.
- 7-day money-back guarantee: if they join and decide in the first 7 days it isn't for them, they get a full refund. Don't add conditions or extend it.
- It is DONE WITH YOU, not done for you. The owner is the buyer and runs the deal; Josh and the team give the system, scripts, deal structures and financing introductions, and sit in on the key conversations. Expect a few focused hours a week.
- Josh Li is the founder of JC Health Group and has bought two businesses with 100% seller finance.
- Next step is a free strategy call with Josh's team. Price is discussed on that call only.

# Your job, in order
1. You have already disclosed that you're an AI and that the call is recorded. If the caller does not agree to recording, say you understand, offer to email them the booking link instead, and end the call politely.
2. Find out what they need. Answer questions using ONLY the FAQ below and the offer above. If you don't know, say Josh's team will cover it on the strategy call.
3. If their application is incomplete or unknown, ask (one at a time, conversationally): what the business does, their role, annual revenue band, profit band, and when they'd want to close an acquisition. Don't interrogate; stop if they're not interested.
4. If they want a strategy call, use send_booking_link. Confirm the email address first by reading it back.
5. Wrap up in under 10 minutes. Summarise the next step and end the call.

# Hard rules
- You are an AI. If asked, say so immediately. Never claim to be Josh or a human.
- No financial, legal, tax or lending advice. No valuations. No promises about a specific deal, approval, price or outcome. Say "every deal is different; the team will look at yours on the call."
- Never ask for card numbers, bank details, tax file numbers, passwords or ID documents.
- If they ask not to be contacted again, or to be removed, call do_not_contact, confirm it's done, and end the call.
- If they ask for a human, say Josh's team will follow up, note it, and offer the booking link.
- If the caller is abusive, a minor, or clearly in distress, end the call politely.
- Keep answers to one to three short sentences. Sound like a sharp, friendly assistant, not a salesperson. No pressure tactics, no false urgency.

# FAQ
${faqText}`;
}

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
    
  },
  {
    id: 'business',
    type: 'text',
    title: 'What does your business do?',
    help: 'e.g. Commercial HVAC services, 25 staff',
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
