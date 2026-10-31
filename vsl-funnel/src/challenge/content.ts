/**
 * Every word a visitor or participant sees in the First Deal Challenge (checked by auditCopy in the tests).
 * Proof is limited to what is true: Josh bought his clinics in two acquisitions, and in both the sellers
 * financed 100% of the price. Numbers in examples are labelled illustrative.
 */

export const CHALLENGE_NAME = 'The First Deal Challenge';

export interface WorksheetField { key: string; label: string; hint?: string; kind: 'text' | 'long' | 'money' | 'number' }
export interface Poll { id: string; question: string; options: { value: string; label: string }[] }
export interface DayContent {
  n: 1 | 2 | 3 | 4 | 5;
  title: string;
  /** One line: what the day gives them. */
  line: string;
  /** Two or three points covered live (titles only: the what and why, the how is live). */
  points: string[];
  worksheet: { heading: string; intro: string; fields: WorksheetField[] };
  poll: Poll;
}

export const DAYS: DayContent[] = [
  {
    n: 1,
    title: 'Your acquisition capacity',
    line: 'What you can buy today, worked out from your own numbers.',
    points: ['Why a lender looks at the target’s cash flow before your savings', 'The size of deal your business can carry', 'What a first deal changes for your profit and your hours'],
    worksheet: {
      heading: 'Day 1 worksheet: your capacity',
      intro: 'Your numbers stay private to you and Josh’s team. Rough figures are fine.',
      fields: [
        { key: 'revenue', label: 'Revenue, last 12 months', kind: 'money' },
        { key: 'ebitda', label: 'EBITDA (profit before interest, tax and depreciation)', kind: 'money' },
        { key: 'debt', label: 'Debt the business carries today', kind: 'money' },
        { key: 'why', label: 'What would a first acquisition change for you?', hint: 'More profit without more hours, a business that runs without you, a group you can sell at a higher multiple.', kind: 'long' },
      ],
    },
    poll: { id: 'bought', question: 'Have you bought a business before?', options: [{ value: 'none', label: 'Not yet, this is my first' }, { value: 'one', label: 'Once' }, { value: 'more', label: 'Two or more' }] },
  },
  {
    n: 2,
    title: 'Your buy box',
    line: 'The exact business to buy first, and the ones to walk away from.',
    points: ['Why your first target is a competitor or a close neighbour', 'Size, location and the red flags that end a deal', 'Why owners with no successor sell to buyers like you'],
    worksheet: {
      heading: 'Day 2 worksheet: your buy box',
      intro: 'One page that tells you, your team and a seller what you buy.',
      fields: [
        { key: 'industry', label: 'Industry and type of business', kind: 'text' },
        { key: 'size', label: 'Size range (revenue or EBITDA)', kind: 'text' },
        { key: 'where', label: 'Where (cities, regions or a drive time)', kind: 'text' },
        { key: 'never', label: 'What you would never buy', kind: 'long' },
        { key: 'why_you', label: 'Why should a seller pick you?', kind: 'long' },
      ],
    },
    poll: { id: 'target', question: 'Where is your first target?', options: [{ value: 'same', label: 'Same industry, nearby' }, { value: 'adjacent', label: 'A neighbouring industry' }, { value: 'open', label: 'Still deciding' }] },
  },
  {
    n: 3,
    title: 'Owners and outreach',
    line: 'Where the off-market owners are, and the first message that opens the conversation.',
    points: ['Why the best deals never reach a broker', 'The first message, the second call and the NDA', 'The team that makes a seller feel safe choosing you'],
    worksheet: {
      heading: 'Day 3 worksheet: your first 25 owners',
      intro: 'Start the list today. Names, not categories.',
      fields: [
        { key: 'sources', label: 'Where you will find owners (associations, suppliers, your own market)', kind: 'long' },
        { key: 'first_five', label: 'The first five owners you will contact', kind: 'long' },
        { key: 'message', label: 'Your first message, in your own words', kind: 'long' },
        { key: 'team', label: 'Who is on your side (accountant, lawyer, an advisor)', kind: 'text' },
      ],
    },
    poll: { id: 'spoken', question: 'How many owners have you spoken to about selling?', options: [{ value: 'none', label: 'None yet' }, { value: 'few', label: '1 to 5' }, { value: 'many', label: 'More than 5' }] },
  },
  {
    n: 4,
    title: 'The stack and the 1.5x test',
    line: 'How commercial debt, seller finance and seller rollover fund the price, and the one test a lender applies.',
    points: ['The three parts of the stack and what each one does for the seller', 'Debt service coverage of about 1.5x, worked on real numbers', 'The order that works: agree the shape with the seller, then the lender'],
    worksheet: {
      heading: 'Day 4 worksheet: your stack',
      intro: 'Use the target you have in mind, or an illustrative one. The calculator below does the maths.',
      fields: [
        { key: 'target_ebitda', label: 'Target’s EBITDA', kind: 'money' },
        { key: 'price', label: 'Price you expect to pay', kind: 'money' },
        { key: 'stack', label: 'Your split (debt, seller note, rollover)', hint: 'For example 70/20/10.', kind: 'text' },
        { key: 'coverage', label: 'Your coverage result', kind: 'text' },
      ],
    },
    poll: { id: 'structure', question: 'Which structure fits your first deal?', options: [{ value: 'vf100', label: 'Seller finances all of it' }, { value: 'stack', label: 'Debt, a seller note and rollover' }, { value: 'debt_roll', label: 'Debt and rollover' }, { value: 'open', label: 'Still deciding' }] },
  },
  {
    n: 5,
    title: 'Your deal plan',
    line: 'Your first acquisition on one page, and how to get to a signed letter of intent.',
    points: ['Your target, your price and your stack, written down', 'The next 90 days, week by week', 'How Josh’s team works with you from here, and what it costs'],
    worksheet: {
      heading: 'Day 5 worksheet: your deal plan',
      intro: 'Bring the four worksheets together. This is the page you work from next.',
      fields: [
        { key: 'target', label: 'Your first target, in one sentence', kind: 'long' },
        { key: 'structure', label: 'The structure you will propose', kind: 'text' },
        { key: 'next_30', label: 'What you will do in the next 30 days', kind: 'long' },
        { key: 'help', label: 'Where you want help', kind: 'long' },
      ],
    },
    poll: { id: 'loi', question: 'When do you want a signed letter of intent?', options: [{ value: '90d', label: 'Within 90 days' }, { value: 'year', label: 'This year' }, { value: 'later', label: 'Later' }] },
  },
];

export const dayContent = (n: number) => DAYS.find((d) => d.n === n) ?? null;

export const LANDING = {
  eyebrow: 'Live with Josh Li',
  h1: 'Five days. One deal mapped out, live with Josh.',
  lede: 'Five live sessions on Zoom. Each day takes one piece of your first acquisition and you finish it with Josh: the business you buy, the owners you call, and the structure that funds the price with commercial debt, seller finance and seller rollover.',
  timelineHeading: 'The five days',
  timelineNote: 'Each session runs 60 to 90 minutes, with a short worksheet you finish that day.',
  nextHeading: 'Next cohort',
  noCohort: 'The next cohort’s dates are being set. Leave your email and you hear first.',
  priceHeading: '$100 to join',
  priceLine: 'Your ticket comes off the engagement deposit if you work with Josh’s team after Day 5.',
  vipHeading: 'VIP, $300 more',
  vipLine: 'A hot seat with Josh after every session, the recordings to keep, and written feedback on your worksheets from the team. Offered once, right after your ticket.',
  hostHeading: 'Your host',
  host: 'Josh Li founded JC Health Group, his own healthcare holding company. He bought his clinics in two acquisitions, and in both the sellers financed 100% of the price.',
  forHeading: 'Who it is for',
  forLine: 'Owners doing $1M+ a year in revenue who want to buy a competitor and grow by acquisition instead of by more hours.',
  cta: 'Join the challenge',
  formHeading: 'Save your place',
  formNote: 'Next: pay your $100 ticket on a secure card form. Your dates and links arrive by email.',
  under1m: 'An honest note: the challenge is built for owners doing $1M+ a year. The deal maths on Day 4 assume a business that size. You are welcome to join, and most of it applies once you pass $1M.',
  privacy: 'We use your details to run the challenge and send your session links. Unsubscribe any time.',
  smsConsent: 'Text me a reminder before each session (optional).',
  faq: [
    { q: 'Where does it happen?', a: 'On Zoom. Your challenge page holds the Zoom link for each day, the worksheet, the chat and your progress.' },
    { q: 'What if I miss a session?', a: 'Each replay goes up on your challenge page after the session. Replays stay open until the offer closes after Day 5, and VIP members keep them.' },
    { q: 'Is anything sold during the challenge?', a: 'Yes, and it is named up front. On Days 4 and 5 Josh explains the advisory engagement and how to reserve a place with a deposit. Nothing is required to take part.' },
  ],
  disclaimer: 'Education, not legal, tax or financial advice. Every deal is structured on its own numbers. Figures in examples are illustrative.',
};

export const CHECKOUT = {
  ticketEyebrow: 'The First Deal Challenge',
  ticketHeading: 'Your challenge ticket',
  ticketLede: (label: string, when: string) => `One payment of ${label}. Your place in the cohort starting ${when} is confirmed the moment it goes through.`,
  ticketSave: (label: string) => `Whop saves your card securely, so the VIP upgrade next, and the engagement deposit later if you choose it, take one click. Today you pay ${label} for your ticket.`,
  ticketButton: (label: string) => `Pay ${label}`,
  vipEyebrow: 'One upgrade, offered once',
  vipHeading: 'Make it VIP',
  vipLede: 'Your ticket is confirmed. VIP adds three things to the same five days.',
  vipPerks: [
    { title: 'A hot seat with Josh after every session', body: 'Bring your own deal. Josh works through VIP questions live after each day’s session.' },
    { title: 'The recordings, yours to keep', body: 'Everyone else’s replays close when the offer closes after Day 5.' },
    { title: 'Written feedback on your worksheets', body: 'The team reads each worksheet you submit and writes back on your challenge page.' },
  ],
  vipCharged: (card: string | null) => (card ? `Charged to the ${card} you just used.` : 'Charged to the card you just used.'),
  vipButton: (label: string) => `Add VIP for ${label}`,
  vipSkip: 'No thanks, keep my ticket',
  vipForm: (label: string) => `Pay ${label} for VIP`,
  vipFormSave: (label: string) => `Today you pay ${label} for the VIP upgrade.`,
  paying: 'Taking your payment…',
  declined: 'Your card wasn’t charged. Check the details or use another card.',
  failed: 'Payment couldn’t be taken just now. Try again, or pay on Whop’s checkout page.',
  hosted: 'Prefer Whop’s own checkout page?',
  hostedLink: 'Pay there instead',
  loading: 'Loading the secure payment form…',
  unavailable: 'Card payments aren’t connected yet. Email the team and they send you a payment link.',
  vipDeclined: 'The upgrade wasn’t charged. Use the card form below instead.',
  welcomeEyebrow: 'You’re in',
  welcomeHeading: 'See you on Day 1',
  welcomeLede: 'Your challenge page holds everything: the Zoom link for each day, your worksheets, your progress and the replays.',
  welcomeVip: 'VIP is on. Your hot seat link appears on each day’s page.',
  calendarHeading: 'Add all five days to your calendar',
  calendarApple: 'Apple or Outlook (all five days)',
  calendarGoogle: 'Google, Day',
  hubButton: 'Open my challenge page',
  emailNote: 'The same link is in your confirmation email. Keep it: it is your personal key to the challenge.',
};

export const HUB = {
  eyebrow: 'Your challenge',
  progressHeading: 'Your progress',
  attended: 'Attended live',
  watched: 'Watched the replay',
  homework: 'Worksheet done',
  notYet: 'Not yet',
  upcoming: 'Coming up',
  todayLive: 'Live now on Zoom',
  todayStarts: 'Starts in',
  todayReplay: 'Replay',
  todayReplaySoon: 'The replay goes up here after the session.',
  todayEnded: 'Today’s session has ended.',
  openDay: 'Open Day',
  join: 'Join on Zoom',
  joinNote: 'Opens Zoom in a new tab. Keep this page open next to it for the worksheet and chat.',
  noLink: 'The Zoom link appears here before the session starts.',
  replayClosed: 'Replays closed when the offer closed.',
  replayUntil: 'Replays stay open until',
  replayKept: 'VIP: your replays stay open.',
  vipBadge: 'VIP',
  allDone: 'All five sessions are done.',
};

export const DAY_PAGE = {
  back: 'Your challenge',
  worksheetSave: 'Submit worksheet',
  worksheetSaved: 'Saved. You can edit and submit again any time.',
  worksheetEmpty: 'Fill in at least one answer first.',
  pollThanks: 'Thanks. Here is how the cohort answered.',
  chatHeading: 'Cohort chat',
  chatNote: 'Owners in this cohort. Names show as first name and last initial.',
  chatEmpty: 'No messages yet. Say hello to the cohort.',
  chatClosed: 'The chat opens 30 minutes before the session.',
  chatPlaceholder: 'Write a message',
  chatSend: 'Send',
  hotHeading: 'VIP hot seat',
  hotLine: 'Straight after the session, Josh takes VIP questions live.',
  hotJoin: 'Join the hot seat',
  hotSame: 'Stay on the same Zoom after the session ends.',
  hotAsk: 'Send Josh your hot seat question',
  hotPlaceholder: 'Your deal, your numbers, your question',
  hotSent: 'Sent. Josh sees it before the hot seat.',
  reviewHeading: 'The team’s feedback on your worksheet',
  reviewWaiting: 'Submitted. The team writes back here.',
  vipUpsell: 'VIP adds a hot seat with Josh after each session, recordings to keep and written feedback on your worksheets.',
  vipUpsellButton: 'Add VIP',
  calcHeading: 'Coverage calculator',
  calcNote: 'Illustrative. Debt service is the yearly repayment on the commercial debt and the seller note.',
  calcEbitda: 'Target EBITDA',
  calcService: 'Yearly debt service',
  calcResult: 'Coverage',
  calcPass: 'Passes the 1.5x test',
  calcFail: 'Below 1.5x: change the stack',
  notifyButton: 'Alert me when the offer opens',
  notifyOn: 'You get an alert in this tab when Josh opens the offer.',
  notifyTitle: 'The offer is open',
  replayButton: 'Watch the replay',
  locked: 'This day opens when the session starts.',
};

export const OFFER = {
  eyebrowSoft: 'Open early for challenge members',
  eyebrow: 'The advisory engagement',
  heading: 'Reserve your place in this intake',
  lede: 'Josh’s team works with you for 90 days on the 3C model: capabilities, capital and closing. You leave the challenge with a plan, and the engagement is the team beside you while you run it, all the way to a signed letter of intent.',
  stack: [
    'Your buy box, owner list and outreach scripts, built with the team',
    'Your deal structured with commercial debt, seller finance and seller rollover, and tested at 1.5x',
    'Weekly working sessions until you have a signed letter of intent',
  ],
  deposit: (label: string) => `Deposit today: ${label}`,
  depositLine: 'Credited in full against the engagement fee. The balance is due when you sign the engagement agreement after a short onboarding call.',
  ticketCredit: (label: string) => `Your ${label} challenge ticket is credited.`,
  button: (label: string) => `Reserve my place, ${label}`,
  closes: 'This offer closes in',
  closesAt: 'Closes',
  closed: 'This offer has closed.',
  reason: 'The deadline is real: the team takes on this intake’s clients together, and places are planned from the deposits in hand when it closes.',
  paid: 'Your place is reserved. The team emails you to book your onboarding call.',
  error: 'The deposit checkout didn’t open. Try again, or email the team.',
  bar: 'Engagement places for this intake',
  barButton: 'Reserve',
  guaranteeLink: 'Read the guarantee and its conditions',
};

/** Funnel HQ labels that also show on public pages (none of these are claims). */
export const DAY_TITLES = DAYS.map((d) => d.title);
