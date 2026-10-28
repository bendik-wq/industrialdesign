// Masterclass room content: chapters, in-room polls, the attendee worksheet, the thank-you page
// and the copy shown in the room. Every string here is checked by auditCopy (src/content/copy-rules.ts).

export interface Chapter { at: number; title: string } // at = minute the chapter starts

export const DEFAULT_CHAPTERS: Chapter[] = [
  { at: 0, title: 'Why profitable owners stall' },
  { at: 7, title: 'The growth ceiling' },
  { at: 14, title: 'Where the deals are' },
  { at: 21, title: 'The 1.5x test' },
  { at: 28, title: 'Building the funding stack' },
  { at: 37, title: 'From one business to a group' },
  { at: 45, title: 'Your next step' },
  { at: 52, title: 'Common questions answered' },
];

export interface Poll { id: string; at: number; question: string; options: { value: string; label: string }[]; purpose: string }

export const DEFAULT_POLLS: Poll[] = [
  {
    id: 'target_type',
    at: 3,
    question: 'What kind of business would you buy first?',
    options: [
      { value: 'competitor', label: 'A competitor' },
      { value: 'supplier', label: 'A supplier' },
      { value: 'customer', label: 'A customer' },
      { value: 'adjacent', label: 'An adjacent business' },
      { value: 'not_sure', label: 'Not sure yet' },
    ],
    purpose: 'Shows whether they already have a target in mind, which shortens the path to an LOI.',
  },
  {
    id: 'timeline',
    at: 12,
    question: 'When would you want your first deal closed?',
    options: [
      { value: '0_3', label: '0 to 3 months' },
      { value: '3_6', label: '3 to 6 months' },
      { value: '6_12', label: '6 to 12 months' },
      { value: 'learning', label: 'Just learning' },
    ],
    purpose: 'Urgency: 0 to 6 months gets called first, just learning goes to nurture.',
  },
  {
    id: 'blocker',
    at: 20,
    question: 'What is the biggest thing stopping you right now?',
    options: [
      { value: 'finding', label: 'Finding deals' },
      { value: 'financing', label: 'Financing' },
      { value: 'structuring', label: 'Structuring' },
      { value: 'time', label: 'Time' },
      { value: 'confidence', label: 'Confidence' },
    ],
    purpose: 'Tells the closer which objection to lead with on the strategy call.',
  },
  {
    id: 'own_cash',
    at: 40,
    question: 'How much of your own cash would you want in the deal?',
    options: [
      { value: 'none', label: 'None' },
      { value: 'some', label: 'Some' },
      { value: 'happy', label: 'Happy to put cash in if it helps' },
    ],
    purpose: 'Separates owners who want a fully funded stack from owners with cash ready to strengthen a deal.',
  },
  {
    id: 'soft_close',
    at: 46,
    question: 'Want us to map out your first acquisition?',
    options: [
      { value: 'yes', label: 'Yes, book a call' },
      { value: 'more', label: 'Tell me more first' },
      { value: 'not_yet', label: 'Not yet' },
    ],
    purpose: 'Buying intent at the pitch: yes gets the application straight away, tell me more gets a follow up.',
  },
];

export interface WorksheetSection { heading: string; paras: string[]; rows?: [string, string][] }

export const WORKSHEET: { title: string; intro: string; sections: WorksheetSection[]; disclaimer: string } = {
  title: 'Deal Structure Worksheet',
  intro: 'Fill this in for one business you would like to own. It takes about 20 minutes, and by the end you will know whether the deal passes the 1.5x test and how the price could be funded.',
  sections: [
    {
      heading: '1. The target',
      paras: ['Write down the business, why it fits next to yours, and where the owner is in life. A retiring owner with no successor is the seller who says yes to a note and a rollover.'],
      rows: [
        ['Business name', '______'],
        ['What it does', '______'],
        ['Why it fits with my business', '______'],
        ['Owner’s age and plans', '______'],
        ['Does the owner have a successor', '______'],
      ],
    },
    {
      heading: '2. The numbers',
      paras: ['Use yearly profit before interest and tax. Divide the asking price by that profit to get the multiple.'],
      rows: [
        ['Yearly revenue', '$______'],
        ['Yearly profit', '$______'],
        ['Asking price', '$______'],
        ['Multiple (price ÷ profit)', '______x'],
      ],
    },
    {
      heading: '3. The 1.5x test',
      paras: [
        'Debt service coverage (DSCR) = yearly profit ÷ yearly debt payments. Lenders want to see about 1.5x or better.',
        'Illustrative example: a business making $500,000 a year with $300,000 of yearly debt payments has a DSCR of 1.67x, which passes.',
        'Raise those payments to $350,000 and the DSCR drops to 1.43x. That structure fails, so you lengthen the seller note or move more of the price into seller rollover.',
      ],
      rows: [
        ['Yearly profit', '$______'],
        ['Yearly commercial debt payments', '$______'],
        ['Yearly seller note payments', '$______'],
        ['DSCR (profit ÷ total payments)', '______x'],
      ],
    },
    {
      heading: '4. The stack',
      paras: [
        'Illustrative example: a $1.5M price on $500,000 of yearly profit, funded 70/20/10.',
        'Commercial debt covers 70% ($1.05M), lent against the cash flow of the business you are buying. Seller finance covers 20% ($300,000) as a note paid from that same cash flow. Seller rollover covers the last 10% ($150,000), a stake the seller keeps.',
        'When the cash flow supports it, a working capital line goes on top, so the deal covers the price, working capital and closing costs.',
      ],
      rows: [
        ['Commercial debt (%, $)', '______'],
        ['Seller finance (%, $)', '______'],
        ['Seller rollover (%, $)', '______'],
        ['Working capital and closing costs', '$______'],
        ['My own cash in the deal', '$______'],
      ],
    },
    {
      heading: '5. Questions for the seller',
      paras: [
        'What do you want your life to look like a year after the sale?',
        'How much of the price do you need at settlement?',
        'Would you carry part of the price as a note, paid from the business over a few years?',
        'Would you keep a stake and share in what the business becomes?',
        'Which customers or staff would leave if you stepped back tomorrow?',
        'Will your last three years of financials match your tax returns?',
        'How long would you stay on to hand the business over?',
      ],
    },
    {
      heading: '6. Your next step',
      paras: ['Bring this worksheet to your strategy call. My team works from your numbers to map out the target, the structure and the path to a signed LOI.'],
    },
  ],
  disclaimer: 'Education, not legal, tax or financial advice. Every number on this worksheet is illustrative. Lending decisions, terms and results depend on the business, the lender and the deal.',
};

export const THANK_YOU: { heading: string; paras: string[]; question: string; options: { value: string; label: string }[] } = {
  heading: 'You’re registered. Now block the hour.',
  paras: [
    'Your personal link is on its way to your inbox.',
    'Add the masterclass to your calendar right now and block the full hour. The funding stack comes in the second half, and that is the part that changes how you see your next deal.',
    'Answer one question below so the session lands on the business you have in mind.',
  ],
  question: 'Which business would you most like to own?',
  options: [
    { value: 'competitor', label: 'A competitor' },
    { value: 'supplier', label: 'A supplier' },
    { value: 'adjacent', label: 'A business in an adjacent industry' },
    { value: 'none_yet', label: 'I don’t have one in mind yet' },
  ],
};

export const ROOM_COPY: {
  offerQualified: { heading: string; body: string; button: string; sub: string; secondary: string };
  offerUnder: { heading: string; body: string; button: string };
  bonus: { heading: string; body: string; button: string };
  calculator: { heading: string; body: string; note: string };
  askBox: { heading: string; placeholder: string; note: string };
} = {
  offerQualified: {
    heading: 'Let’s map out your first acquisition',
    body: 'Apply for a strategy call. My team looks at your numbers, picks the target that fits, and maps the stack across commercial debt, seller finance and seller rollover, with a signed LOI in about 90 days as the aim.',
    button: 'Apply for a strategy call',
    sub: 'The programme comes with a 7-day money-back guarantee.',
    secondary: 'Start the programme now without a call',
  },
  offerUnder: {
    heading: 'Keep building, then come back',
    body: 'The strategy call is for owners doing $1M or more a year in revenue. Keep growing toward that line, take the deal structure worksheet, and watch my YouTube channel to learn the structures before you need them.',
    button: 'Get the worksheet',
  },
  bonus: {
    heading: 'Your deal structure worksheet',
    body: 'You stayed to the end, so the attendee worksheet is yours. Run one real target through the 1.5x test and draft its stack before your strategy call.',
    button: 'Unlock my worksheet',
  },
  calculator: {
    heading: 'Run your own numbers',
    body: 'Enter the yearly profit and asking price of a business you would like to own. The calculator splits the price across commercial debt, seller finance and seller rollover, then runs the 1.5x test on the result.',
    note: 'Illustrative only. Education, not financial advice, and not an offer of finance.',
  },
  askBox: {
    heading: 'Ask a question',
    placeholder: 'Type your question about a deal, the funding or the next step',
    note: 'An AI assistant trained on Josh’s playbook answers instantly, and every question is saved for Josh’s team.',
  },
};
