/**
 * The acquisition readiness quiz: every word a visitor reads (questions, options, archetypes, gaps, the gate and the
 * result). Every string passes auditCopy (test/quiz-copy.test.ts): no emojis, exclamation marks or em dashes, no
 * hedges, no countdowns or made-up counts, no promised results, illustrative numbers labelled, seller rollover named
 * whenever funding is described, and the strategy call is never called free.
 *
 * Facts used here are the true ones only: Josh Li founded JC Health Group, his own healthcare holding company, and
 * bought his clinics in two acquisitions where the sellers financed 100% of the price; the booking-form numbers
 * (90 owners booked calls, 24 had never bought a company) come from our own booking form.
 */

export type QuestionId = 'revenue' | 'industry' | 'goal' | 'margin' | 'debt' | 'funding' | 'deals' | 'timeline' | 'blocker' | 'team';

export interface QuizOption { value: string; label: string; hint?: string }
export interface QuizQuestion { id: QuestionId; title: string; sub?: string; options: QuizOption[] }

/** One per screen, in order. The revenue values are the webinar form's own (APP_REVENUE_BAND keys). */
export const QUESTIONS: QuizQuestion[] = [
  {
    id: 'revenue', title: 'What does your business turn over in a year?', sub: 'Revenue across the whole business, before costs.',
    options: [
      { value: 'lt1m', label: 'Under $1M' },
      { value: '1_3m', label: '$1M to $3M' },
      { value: '3_10m', label: '$3M to $10M' },
      { value: '10_25m', label: '$10M to $25M' },
      { value: '25_50m', label: '$25M to $50M' },
      { value: '50_100m', label: '$50M to $100M' },
      { value: 'gt100m', label: 'Over $100M' },
    ],
  },
  {
    id: 'industry', title: 'Which industry are you in?',
    options: [
      { value: 'healthcare', label: 'Healthcare and allied health' },
      { value: 'trades', label: 'Trades and home services' },
      { value: 'professional', label: 'Professional services' },
      { value: 'manufacturing', label: 'Manufacturing and distribution' },
      { value: 'retail', label: 'Retail and hospitality' },
      { value: 'tech', label: 'Technology and agencies' },
      { value: 'other', label: 'Something else' },
    ],
  },
  {
    id: 'goal', title: 'What do you want next?',
    options: [
      { value: 'competitor', label: 'Buy a competitor' },
      { value: 'supply', label: 'Buy a supplier or a customer' },
      { value: 'group', label: 'Build a group of businesses' },
      { value: 'exit', label: 'Exit at a higher multiple' },
      { value: 'unsure', label: 'Not sure yet' },
    ],
  },
  {
    id: 'margin', title: 'What is your profit margin?', sub: 'Profit before tax as a share of revenue, with a fair wage for you taken out.',
    options: [
      { value: 'lt10', label: 'Under 10%' },
      { value: '10_20', label: '10% to 20%' },
      { value: '20_30', label: '20% to 30%' },
      { value: 'gt30', label: 'Over 30%' },
      { value: 'unsure', label: 'Not sure' },
    ],
  },
  {
    id: 'debt', title: 'How do you feel about business debt?',
    options: [
      { value: 'use', label: 'We use it today' },
      { value: 'open', label: 'Open to it when the cash flow covers it' },
      { value: 'wary', label: 'Wary of it' },
      { value: 'never', label: 'I won’t take on debt' },
    ],
  },
  {
    id: 'funding', title: 'If the right business came up today, how would you fund it?',
    options: [
      { value: 'cash', label: 'Mostly our own cash' },
      { value: 'bank', label: 'A bank loan' },
      { value: 'structure', label: 'Commercial debt, seller finance and seller rollover together' },
      { value: 'unsure', label: 'I don’t know yet' },
    ],
  },
  {
    id: 'deals', title: 'How many businesses have you bought?',
    options: [
      { value: '0', label: 'None yet' },
      { value: '1', label: 'One' },
      { value: '2', label: 'Two or more' },
    ],
  },
  {
    id: 'timeline', title: 'When do you want a signed deal?',
    options: [
      { value: '90d', label: 'Within 90 days' },
      { value: '6_12', label: 'In 6 to 12 months' },
      { value: 'exploring', label: 'I’m exploring for now' },
    ],
  },
  {
    id: 'blocker', title: 'What stands in your way most?',
    options: [
      { value: 'finding', label: 'Finding the right business' },
      { value: 'funding', label: 'Funding the deal' },
      { value: 'credibility', label: 'Being taken seriously by sellers' },
      { value: 'structuring', label: 'Structuring the deal' },
      { value: 'time', label: 'Time to run the process' },
    ],
  },
  {
    id: 'team', title: 'Could your business run for a month without you?',
    options: [
      { value: 'yes', label: 'Yes, the team runs it' },
      { value: 'partly', label: 'Partly' },
      { value: 'no', label: 'No, it needs me every day' },
    ],
  },
];

export const QUESTION_IDS = QUESTIONS.map((q) => q.id);

export type ArchetypeId = 'consolidator' | 'first_deal' | 'stuck_scaler' | 'exit_builder' | 'foundation';

export interface Archetype { id: ArchetypeId; name: string; line: string; means: string[] }

/** Plain-word names. The result page shows the name, the one line and the paragraphs under "What it means". */
export const ARCHETYPES: Record<ArchetypeId, Archetype> = {
  consolidator: {
    id: 'consolidator', name: 'The Consolidator',
    line: 'You have bought before. The next step is a repeatable way to add businesses to what you own.',
    means: [
      'A deal behind you means you know the work of a close. Moving from one deal to a group takes a funding shape you can use again.',
      'That shape is commercial debt, seller finance and seller rollover, agreed with the seller first and then taken to the lender, with the debt covered 1.5 times by the profit.',
    ],
  },
  first_deal: {
    id: 'first_deal', name: 'The First-Deal Operator',
    line: 'Your business is in shape to carry an acquisition. What is missing is the first deal.',
    means: [
      'You run a business with real revenue and a team around you. Lenders and sellers weigh the business you already run, so you start from a strong position.',
      'The first deal is mostly process: a target list, an owner with no successor, and a structure the seller agrees to before the lender sees it.',
    ],
  },
  stuck_scaler: {
    id: 'stuck_scaler', name: 'The Stuck Scaler',
    line: 'The business has grown around you. Buying the next one starts with the seat you sit in today.',
    means: [
      'When a business needs its owner every day, a second one adds to the load. Lenders and sellers both ask who runs the business after the close.',
      'Close the gaps below first and the numbers you already have start working for a deal.',
    ],
  },
  exit_builder: {
    id: 'exit_builder', name: 'The Exit Builder',
    line: 'You want to sell for more. Buying first is one way to raise what the business is worth.',
    means: [
      'A single small business and a group of them sell at different multiples. Illustrative ranges: 3 to 5 times profit for one business, 8 to 12 times for a platform of them.',
      'Owners who add a competitor or two before they sell are selling a bigger, less owner-dependent business. The masterclass shows how those purchases get funded.',
    ],
  },
  foundation: {
    id: 'foundation', name: 'The Foundation Builder',
    line: 'Under $1M a year, the first job is the business you own today.',
    means: [
      'The structures in the masterclass are built for owners doing $1M or more a year, because lenders and sellers weigh the business you already run.',
      'You are welcome to watch. The numbers will show you what to build toward before your first deal.',
    ],
  },
};

export type GapId = 'scale' | 'margin' | 'owner' | 'plan' | 'funding' | 'structure' | 'deal_flow' | 'credibility';

export interface Gap { id: GapId; title: string; fix: string }

/** Each gap with the one-line fix the masterclass teaches. */
export const GAPS: Record<GapId, Gap> = {
  scale: { id: 'scale', title: 'Size a lender will back', fix: 'The masterclass shows the numbers a business needs first, and why $1M a year in revenue is the line.' },
  margin: { id: 'margin', title: 'Profit that carries the debt', fix: 'The masterclass works the 1.5x test on real numbers, so you know the profit a target needs before you offer.' },
  owner: { id: 'owner', title: 'A business that runs without you', fix: 'The masterclass covers what your own business needs in place before you take on a second one.' },
  plan: { id: 'plan', title: 'A path to a signed LOI', fix: 'The masterclass lays out the path week by week, from a target list to an offer the owner signs.' },
  funding: { id: 'funding', title: 'Debt you are comfortable with', fix: 'The masterclass shows commercial debt lent against the target’s cash flow, with seller finance and seller rollover closing the gap.' },
  structure: { id: 'structure', title: 'A deal structure', fix: 'The masterclass shows how to agree the shape with the seller first, then take it to the lender.' },
  deal_flow: { id: 'deal_flow', title: 'Finding the right business', fix: 'The masterclass shows where the good deals are: off market, with owners who have no successor.' },
  credibility: { id: 'credibility', title: 'Credibility with sellers', fix: 'The masterclass shows how to open with the seller’s terms, so the owner sees a buyer with a plan for the business.' },
};

/** The copy around the questions and the gate. */
export const QUIZ_COPY = {
  title: 'Acquisition readiness',
  seoTitle: 'Acquisition readiness quiz | G&L M&A Advisory',
  seoDescription: 'Ten questions for owners of $1M+ businesses who want to buy a competitor or build a group. A readiness score, your buyer type and the two gaps to close first.',
  eyebrow: 'Acquisition readiness',
  heading: 'How ready is your business to buy the next one?',
  lede: 'Ten questions, about two minutes. You get a readiness score out of 100, the kind of buyer you are today and the two gaps to close first.',
  start: 'Start',
  proof: 'Of the 90 owners who booked a call with Josh’s team through our booking form, 24 had never bought a company.',
  host: 'Josh Li',
  hostLine: 'Founder of JC Health Group. Josh bought his clinics in two acquisitions, and in both the sellers financed 100% of the price.',
  back: 'Back',
  of: 'of',
  gateEyebrow: 'Your result is ready',
  gateHeading: 'Where should we send your result?',
  gateLede: 'Your score, your buyer type and your two gaps open on the next screen. We email you a copy.',
  firstName: 'First name',
  email: 'Email',
  phone: 'Mobile',
  optional: '(optional)',
  gateButton: 'Show my result',
  gateNote: 'We email you your result, and your masterclass details if you save a seat. Unsubscribe any time.',
  privacy: 'Privacy policy',
  errors: {
    first_name: 'Please enter your first name',
    email: 'Please enter a valid email address',
    disposable: 'Please use your real email address. Your result goes there.',
    phone: 'Please enter a valid mobile number, including area code, or leave it blank',
    answers: 'A few answers are missing. Go back and answer every question.',
    expired: 'This quiz has expired. Start again and it takes two minutes.',
    rate: 'Too many results from this connection. Please try again in an hour.',
    generic: 'Something went wrong. Please try again.',
  },
};

/** The result page. */
export const RESULT_COPY = {
  eyebrow: 'Your acquisition readiness',
  scoreLabel: 'Readiness score',
  outOf: 'out of 100',
  meansHeading: 'What it means',
  gapsHeading: 'Your two gaps',
  teaserHeading: 'The 1.5x test on numbers like yours',
  teaserLabel: 'Illustrative',
  teaserNote: 'Illustrative only, not a quote or advice. Assumes a price of 3 times profit, a bank loan at 9% over 10 years and a seller note at 6% over 5 years. Real deals are priced and lent on their own numbers.',
  actionHeading: 'See the whole method in the masterclass',
  actionLede: 'Josh walks through where the deals are, how commercial debt, seller finance and seller rollover fund them, and the path to a signed LOI.',
  liveLede: 'Josh runs it live and takes questions: where the deals are, how commercial debt, seller finance and seller rollover fund them, and the path to a signed LOI.',
  pickTime: 'Pick a time (shown in your time zone)',
  button: 'Save my seat',
  oneClick: 'One click. We already have your name and email.',
  none: 'No sessions are scheduled right now. We will email you when the next one opens.',
  under1m: 'The masterclass is built for owners doing $1M or more a year. You are welcome to watch.',
  registered: 'Your seat is saved. Your link is in your inbox.',
  openRoom: 'Open my registration',
  how: 'How the score works',
  howText: 'Ten answers, weighted: revenue 20, team 15, profit margin 12, deals done 12, how you would fund it 12, comfort with debt 10, timeline 10 and what you want next 9. Industry and your blocker carry no points; your blocker shapes the gaps.',
  disclaimer: 'Education, not legal, tax or financial advice. No result is promised.',
};

/** Funnel HQ labels for the archetypes and gaps (same names the visitor sees). */
export const ARCHETYPE_ORDER: ArchetypeId[] = ['consolidator', 'first_deal', 'stuck_scaler', 'exit_builder', 'foundation'];
