import type { Context } from 'hono';
import { type AppEnv, type Runtime, runtimeFrom } from '../app';
import { newId } from '../lib/ids';
import { render } from '../funnel/pages';
import type { Chapter } from './content';
import { type Registration, getRegistration, getSession, phase, replayUrl, roomUrl, webinarBase } from './webinar';

/**
 * The watch experience: what happens on the page while the recording plays, all automatic.
 *  - The deal builder: "your deal, building as you watch", one step per chapter, filled from the viewer's own answers.
 *  - The acquisition readiness score: 0 to 100 from their own answers, with the criteria shown.
 *  - Key-moment takeaways they can save to their notes (server-side), a notes page and a notes email.
 *  - Real reactions per chapter, shown to others only above REACTION_MIN.
 * Honesty: it's a recording. Nothing here invents a count, a benchmark or a live moment. Every number a
 * viewer sees is their own, illustrative and labelled so, or a real aggregate above a minimum.
 * Every string is checked by auditCopy (test/webinar-experience.test.ts).
 */

/** A real count of other viewers is only shown from this many people up. */
export const REACTION_MIN = 10;
/** The average readiness score is only shown once this many people have one. */
export const AVERAGE_MIN = 30;

// ───────────── Takeaways (from the masterclass script, in order) ─────────────

export interface Takeaway { id: string; at: number; text: string } // at = second of the masterclass

export const TAKEAWAYS: Takeaway[] = [
  { id: 'big-idea', at: 91, text: 'Buy a business that is already built, and let commercial debt, seller finance and seller rollover pay the price instead of your savings.' },
  { id: 'third-way', at: 452, text: 'Hiring and marketing move the ceiling a few inches a year, while buying a business that is already built moves it in one step.' },
  { id: 'revenue-gap', at: 550, text: 'Illustrative: adding $500,000 of profit at a 15% margin takes about $3.3M of new revenue, or one acquisition of a business that already makes it.' },
  { id: 'off-market', at: 753, text: 'Listed businesses are auctions, and the best deals sit with owners who have no successor and have not listed yet.' },
  { id: 'rollover-signal', at: 864, text: 'A seller who agrees to roll part of the price into equity is betting their own money that the numbers are real.' },
  { id: 'red-flags', at: 1043, text: 'Walk away when the financials do not match the tax returns, one customer is most of the revenue, or the seller will not stay through the handover.' },
  { id: 'dscr', at: 1204, text: 'Debt service coverage is yearly profit divided by yearly debt payments, and lenders want to see about 1.5x or better.' },
  { id: 'structures', at: 1280, text: 'Banks do not reject buyers, they reject structures.' },
  { id: 'pass-fail', at: 1385, text: 'Illustrative: $500,000 of profit against $300,000 of yearly payments is 1.67x and passes, while $350,000 of payments gives 1.43x and fails.' },
  { id: 'levers', at: 1460, text: 'A deal that fails the test tells you which lever to pull: a longer seller note, a payment holiday, more rollover or a lower price.' },
  { id: 'stack', at: 1611, text: 'In the illustrative 70/20/10 stack, commercial debt funds 70% of the price, seller finance 20% and seller rollover the last 10%.' },
  { id: 'over-financed', at: 1700, text: 'A well structured deal is over-financed: a working capital line covers closing costs and day one cash when the cash flow supports it.' },
  { id: 'order', at: 1848, text: 'Agree the shape of the deal with the seller first, then take it to a lender with the 1.5x test already run.' },
  { id: 'multiples', at: 1990, text: 'Illustrative ranges: one small business trades at 3 to 5x profit, and a group of them at 8 to 12x.' },
  { id: 'group-math', at: 2066, text: 'Illustrative: two businesses making $500,000 each are worth about $4M apart and $8M together as a group at 8x.' },
  { id: 'sprint-days', at: 2602, text: 'The First Deal Sprint: in seven days, your acquisition capacity, your buy box, a first shortlist, a deal-structure memo, an outreach script and a Deal Plan session.' },
  { id: 'guarantee', at: 2996, text: 'The Sprint guarantee: if at the end of your Deal Plan session it was not worth far more than you paid, tell the team that day and the full fee is refunded.' },
  { id: 'management-layer', at: 3573, text: 'The management layer you build to hold two businesses together is the same layer that takes you out of the middle of the first one.' },
];

/** One line per chapter (keyed by the minute it starts) for the late-join catch-up and the away recap. */
export const CHAPTER_RECAP: Record<number, string> = {
  0: 'Growth gets slow and expensive past a point, and the answer is buying a business that is already built.',
  6: 'Hiring moves the ceiling slowly, while an acquisition adds its profit on the day the deal settles.',
  12: 'The best deals are off market, with owners who have no successor, and you approach them directly.',
  19: 'Yearly profit divided by yearly debt payments has to clear about 1.5x before a lender takes a deal seriously.',
  26: 'Commercial debt, seller finance and seller rollover, illustrated as 70/20/10, with a working capital line on top.',
  33: 'Illustrative ranges of 3 to 5x profit for one business against 8 to 12x for a group.',
  38: 'The First Deal Sprint opened: seven days with the team that end with your first deal mapped out.',
  49: 'What the Sprint costs, the ticket credit, the guarantee, the review bonus and when the offer closes.',
  55: 'The questions that decide it: timing, the shortlist, the fee, time needed, guarantees and control.',
  63: 'The worksheet unlocked, and the choice between the same year again and a year into building a group.',
};

// ───────────── The deal builder ─────────────

/** One step per chapter: unlocks at `at` (second). `soon` is the locked line ("Unlocks at 26:00: your funding stack"). */
export const BUILDER_STEPS: { id: string; at: number; title: string; soon: string }[] = [
  { id: 'target', at: 0, title: 'The business you would buy', soon: 'the business you would buy' },
  { id: 'size', at: 6 * 60, title: 'The profit it adds', soon: 'the profit it adds' },
  { id: 'where', at: 12 * 60, title: 'Where it sits', soon: 'where to find it' },
  { id: 'test', at: 19 * 60, title: 'The 1.5x test', soon: 'the 1.5x test on your numbers' },
  { id: 'stack', at: 26 * 60, title: 'Your funding stack', soon: 'your funding stack' },
  { id: 'group', at: 33 * 60, title: 'What it is worth inside a group', soon: 'your group value' },
  { id: 'plan', at: 38 * 60, title: 'Your next seven days', soon: 'your next seven days' },
];

/** Strings for the room. {placeholders} are filled in the browser with the viewer's own numbers. */
export const EXPERIENCE_COPY = {
  panelEyebrow: 'While you watch',
  panelHeading: 'Your deal, building as you watch',
  panelIntro: 'Each part fills in as the masterclass reaches it, from your own answers. Every number is illustrative.',
  unlocksAt: 'Unlocks at {time}: {what}',
  illustrative: 'Illustrative',
  targetLabels: { competitor: 'A competitor', supplier: 'A supplier', customer: 'A customer', adjacent: 'An adjacent business', not_sure: 'Not chosen yet', none_yet: 'Not chosen yet' } as Record<string, string>,
  targetNote: 'The owners who get a deal done stop thinking about acquisitions in general and start thinking about one business with one owner.',
  targetEmpty: 'Answer the question at 3:00 and this fills in with your answer.',
  sizeLine: 'A business that makes about {profit} a year, priced at {price}.',
  sizeYours: 'Your numbers from the calculator: {profit} a year in profit, priced at {price}.',
  sizeSource: 'Sized from your revenue band until you run the calculator at 26:00.',
  sizeGrowth: 'Growing that profit from scratch at a 15% margin takes about {revenue} of new revenue.',
  whereLine: 'Off market, with an owner who has no successor. You approach them directly, one owner to another.',
  whereByType: {
    competitor: 'Look for the competitor whose owner has run it for twenty years or more and has no successor.',
    supplier: 'Ask around for a supplier whose owner is winding down. Buying it takes back the margin you pay out today.',
    customer: 'A customer you buy gives you control of demand, so start with the ones who already rely on you.',
    adjacent: 'Look for a business that sells something different to the customers you already serve.',
    other: 'Start with your competitors, where the customers and the work are the same as yours.',
  } as Record<string, string>,
  testLine: '{profit} of yearly profit divided by {service} of yearly debt payments gives {dscr}.',
  testPass: 'That clears the 1.5x test with a buffer.',
  testFail: 'That falls short of 1.5x. A longer seller note, more rollover or a lower price changes it.',
  testSource: 'On the calculator assumptions: 9% over 10 years on the bank loan, 6% over 5 years on the seller note.',
  testHint: 'Run a real business through the calculator at 26:00 and this updates with your numbers.',
  stackRows: { debt: 'Commercial debt', note: 'Seller finance', roll: 'Seller rollover' } as Record<string, string>,
  stackPayments: 'Yearly debt payments: {service}. The rollover carries no yearly payment.',
  groupAlone: 'On its own at 3 to 5x profit',
  groupInside: 'Inside a group at 8 to 12x profit',
  groupNote: 'Same profit, a different multiple. Illustrative ranges, and the real number depends on the industry and the market.',
  planRows: [
    { weeks: 'Day 1', text: 'Kickoff with the team, and your numbers and today’s answers go into your file.' },
    { weeks: 'Days 2 to 6', text: 'Your acquisition capacity, your buy box for {target}, a first shortlist, your deal-structure memo and your outreach script.' },
    { weeks: 'Day 7', text: 'Your Deal Plan session: the whole deal on the table, and you decide what happens next.' },
  ],
  planTimeline: {
    '0_3': 'You said 0 to 3 months, so a mapped deal by next week keeps that window open.',
    '3_6': 'You said 3 to 6 months, and a plan in seven days leaves the rest of that time for outreach and the LOI.',
    '6_12': 'You said 6 to 12 months, and knowing your capacity now means the next months go to the right businesses.',
    learning: 'You said you are learning first, and seven days is where learning turns into a target.',
  } as Record<string, string>,
  planTargetFallback: 'the business that fits next to yours',
  // One-line summaries for steps already passed (tap one to open it again).
  short: {
    size: '{profit} profit, priced at {price}',
    where: 'Off market, an owner with no successor',
    testPass: '{dscr}, clears 1.5x',
    testFail: '{dscr}, short of 1.5x',
    stack: '{debt} commercial debt, {note} seller finance, {roll} seller rollover',
    group: '{lo} to {hi} inside a group',
    plan: 'A signed LOI by day 90',
  } as Record<string, string>,
  mappedHeading: 'Your deal is mapped',
  mappedBody: 'Target, size, the 1.5x test, the stack, the group value and your next seven days, all from your own answers.',
  mappedButton: 'Open my acquisition blueprint',
  mappedButtonWorksheet: 'Open my deal worksheet',

  scoreHeading: 'Acquisition readiness',
  scoreIntro: 'Scored from your own answers in this masterclass. Answer the questions as they appear and it updates.',
  scoreHow: 'How the score works',
  scoreAverage: 'The average across {n} viewers of this masterclass is {avg}.',
  gapLabel: 'Your gap',
  nextLabel: 'Your next step',
  nextApply: 'Apply for a strategy call',
  nextWorksheet: 'Get the worksheet',

  savedHeading: 'Your notes',
  savedEmpty: 'Save a key point when it appears and it lands here, and on your notes page after the masterclass.',
  savedLink: 'Open my notes page',
  takeawayEyebrow: 'Key point',
  saveButton: 'Save to my notes',
  savedButton: 'Saved to your notes',

  catchUpHeading: 'You joined at {time}. Here is what you missed.',
  awayHeading: 'While you were away ({mins}):',
  awaySameChapter: 'Still in “{chapter}”.',

  reactPrompt: 'Mark this part',
  reactions: { new: 'New to me', do: 'I would do this', explain: 'Explain more' } as Record<string, string>,
  reactDone: 'Marked',
  reactCount: { new: '{n} viewers marked this part “New to me”.', do: '{n} viewers marked this part “I would do this”.', explain: '{n} viewers asked for more on this part.' } as Record<string, string>,
  explainQuestion: 'Explain this part of the masterclass in more detail: {what}',
  explainSent: 'Your question went to the assistant. The answer is in the question box below.',

  buyinEyebrow: 'Your turn',
  buyinHeading: 'In one sentence: what would your first acquisition change for you?',
  buyinPrompts: ['More profit without more hours', 'A business that runs without me', 'A bigger exit'],
  buyinPlaceholder: 'Tap a starting point above and make it yours, or write your own',
  buyinShare: 'Show this anonymously to other owners watching',
  buyinButton: 'Save my answer',
  buyinThanks: 'Saved. It comes back to you at the next step.',
  buyinPlayback: 'You said: “{text}”. Here is how to start.',
  wallHeading: 'What other owners said',
  wallNote: 'Real answers from viewers who chose to share theirs, shown with a first initial only.',
};

// ───────────── Acquisition readiness score ─────────────

export interface ScoreInputs { band?: string | null; target?: string | null; timeline?: string | null; blocker?: string | null; own_cash?: string | null; dscr?: number | null }

type Factor =
  | { id: string; input: keyof ScoreInputs; label: string; max: number; kind: 'map'; points: Record<string, number>; raise: string; gap: string }
  | { id: string; input: 'dscr'; label: string; max: number; kind: 'dscr'; steps: [number, number][]; raise: string; gap: string };

/** The scoring criteria, shown to the viewer as they are. Total 100. */
export const SCORE_RULES: Factor[] = [
  {
    id: 'size', input: 'band', label: 'Business size', max: 25, kind: 'map', gap: 'business size',
    points: { '1m-3m': 15, '1m-5m': 15, '3m-10m': 20, '5m-20m': 20, '10m+': 25, '10m-25m': 25, '20m+': 25, '25m-50m': 25, '50m-100m': 25, '100m+': 25 },
    raise: 'Lenders and sellers weigh the business you already run. $1M a year in revenue with a real profit is the line, and more revenue scores higher.',
  },
  {
    id: 'target', input: 'target', label: 'A clear target', max: 20, kind: 'map', gap: 'a clear target',
    points: { competitor: 20, supplier: 16, customer: 16, adjacent: 14, not_sure: 6, none_yet: 6 },
    raise: 'Write down one business and one owner. A competitor scores highest because the customers and the work are the same as yours.',
  },
  {
    id: 'timeline', input: 'timeline', label: 'Timeline', max: 20, kind: 'map', gap: 'a timeline',
    points: { '0_3': 20, '3_6': 16, '6_12': 10, learning: 4 },
    raise: 'Set a date for a signed LOI. The 90-day plan works back from it.',
  },
  {
    id: 'numbers', input: 'dscr', label: 'Deal numbers', max: 20, kind: 'dscr', gap: 'deal numbers that clear 1.5x',
    steps: [[1.5, 20], [1.25, 12], [0, 6]],
    raise: 'Run one real business through the calculator at 26:00 and get it to 1.5x or better.',
  },
  {
    id: 'capital', input: 'own_cash', label: 'Your stance on own cash', max: 10, kind: 'map', gap: 'your stance on own cash',
    points: { none: 10, some: 10, happy: 10 },
    raise: 'Answer the question at 40:00. Any answer counts, because the structure stands on the business’s cash flow either way.',
  },
  {
    id: 'blocker', input: 'blocker', label: 'Your blocker named', max: 5, kind: 'map', gap: 'naming what stops you',
    points: { finding: 5, financing: 5, structuring: 5, time: 5, confidence: 5 },
    raise: 'Answer the question at 20:00. Naming the blocker tells you where to start.',
  },
];

/** The blocker they named, as the gap shown at the pitch. */
export const BLOCKER_GAP: Record<string, string> = {
  finding: 'finding the right deal',
  financing: 'financing structure',
  structuring: 'deal structure',
  time: 'time to run the process',
  confidence: 'confidence for a first deal',
};

/** What to do next about each gap (shown at the pitch). */
export const GAP_NEXT: Record<string, string> = {
  'finding the right deal': 'On a strategy call the team sets your target profile and the outreach that reaches owners with no successor.',
  'financing structure': 'On a strategy call the team builds the stack on your numbers across commercial debt, seller finance and seller rollover, tested at 1.5x.',
  'deal structure': 'On a strategy call the team maps the note, the rollover and the lender’s share so the structure clears 1.5x.',
  'time to run the process': 'The 90 days take a few focused hours a week. On a strategy call the team shows you where those hours go.',
  'confidence for a first deal': 'The first deal is done with you. On a strategy call the team maps it step by step from your own numbers.',
  'business size': 'Keep growing toward $1M a year, and run one business through the worksheet so you are ready when you cross that line.',
  'a clear target': 'On a strategy call the team sets your target profile with you: size, location and the kind of owner who is ready to sell.',
  'a timeline': 'Pick the date you want a signed LOI by. On a strategy call the team works the 90 days back from it.',
  'deal numbers that clear 1.5x': 'On a strategy call the team builds the stack on your numbers across commercial debt, seller finance and seller rollover, tested at 1.5x.',
  'your stance on own cash': 'On a strategy call the team shows how the stack stands without your cash, and where cash helps when you want it to.',
  'naming what stops you': 'On a strategy call the team starts with whatever is stopping you and maps the first deal from there.',
};

export interface ScoreResult { score: number; gap: string; next: string; factors: { id: string; label: string; max: number; points: number; answered: boolean; raise: string }[] }

/** Readiness score, 0 to 100, from the viewer's own answers. Transparent: the result lists each factor. */
export function readinessScore(inp: ScoreInputs): ScoreResult {
  const factors = SCORE_RULES.map((f) => {
    let points = 0;
    let answered = false;
    if (f.kind === 'map') {
      const v = inp[f.input];
      answered = v != null && v !== '';
      points = answered ? f.points[String(v)] ?? 0 : 0;
    } else {
      const d = Number(inp.dscr);
      answered = inp.dscr != null && Number.isFinite(d) && d > 0;
      points = answered ? f.steps.find(([min]) => d >= min)?.[1] ?? 0 : 0;
    }
    return { id: f.id, label: f.label, max: f.max, points: Math.max(0, Math.min(f.max, points)), answered, raise: f.raise };
  });
  const score = Math.max(0, Math.min(100, Math.round(factors.reduce((a, f) => a + f.points, 0))));
  // The single biggest gap: deal numbers that fail the test first, then the blocker they named, then the largest shortfall.
  const rule = (id: string) => SCORE_RULES.find((r) => r.id === id)!;
  const numbers = factors.find((f) => f.id === 'numbers')!;
  let gap: string;
  if (numbers.answered && Number(inp.dscr) < 1.5) gap = BLOCKER_GAP.financing;
  else if (inp.blocker && BLOCKER_GAP[inp.blocker]) gap = BLOCKER_GAP[inp.blocker];
  else {
    const worst = [...factors].sort((a, b) => (b.max - b.points) - (a.max - a.points))[0];
    gap = worst.max - worst.points > 0 ? rule(worst.id).gap : BLOCKER_GAP.structuring;
  }
  return { score, gap, next: GAP_NEXT[gap] ?? GAP_NEXT['deal structure'], factors };
}

// ───────────── Deal math (the room calculator's assumptions) ─────────────

const payment = (principal: number, rate: number, years: number) => (principal * rate) / (1 - Math.pow(1 + rate, -years));

/** 70/20/10, bank loan 9% over 10 years, seller note 6% over 5 years: same as the room calculator. */
export function dealMath(profit: number, price: number) {
  const debt = price * 0.7, note = price * 0.2, roll = price * 0.1;
  const service = payment(debt, 0.09, 10) + payment(note, 0.06, 5);
  return { debt, note, roll, service, dscr: service > 0 ? profit / service : 0 };
}

/** A sensible illustrative target for an owner's revenue band (until they run the calculator). */
export function illustrativeTarget(band: string | null | undefined) {
  const b = band ?? '';
  if (['<100k', '100k-1m', '<1m'].includes(b)) return { profit: 150_000, price: 450_000 };
  if (['1m-3m', '1m-5m'].includes(b)) return { profit: 300_000, price: 900_000 };
  if (['10m+', '10m-25m', '20m+', '25m-50m', '50m-100m', '100m+'].includes(b)) return { profit: 1_000_000, price: 3_500_000 };
  return { profit: 500_000, price: 1_500_000 }; // $3M–$10M, and anyone not asked: the masterclass's own example
}

// ───────────── Reactions ─────────────

export const REACTION_KINDS = ['new', 'do', 'explain'] as const;

/** The chapter (its start minute) a position falls in. */
export function chapterAt(chs: Chapter[], sec: number) {
  let at = chs[0]?.at ?? 0;
  for (const c of chs) if (sec >= c.at * 60) at = c.at;
  return at;
}

/** Real counts per chapter, with anything under the minimum left out (never shown, never sent to the browser). */
export function publicReactionCounts(rows: { chapter_at: number; kind: string; n: number }[], min = REACTION_MIN) {
  const out: Record<number, Record<string, number>> = {};
  for (const r of rows) {
    if (!(REACTION_KINDS as readonly string[]).includes(r.kind) || !(r.n >= min)) continue;
    (out[r.chapter_at] ??= {})[r.kind] = r.n;
  }
  return out;
}

/** The real average score, only once enough people have one. */
export function publicAverage(n: number, avg: number | null, min = AVERAGE_MIN) {
  return n >= min && avg != null ? { n, avg: Math.round(avg) } : null;
}

const pos = (v: unknown) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(6 * 3600, Math.round(Number(v)))) : 0);

export async function react(rt: Runtime, reg: Registration, body: { kind?: unknown; pos?: unknown; replay?: unknown }, chs: Chapter[]) {
  const kind = String(body.kind ?? '');
  if (!(REACTION_KINDS as readonly string[]).includes(kind)) return { ok: false as const };
  const at = pos(body.pos);
  const ch = chapterAt(chs, at);
  await rt.env.DB.prepare(
    `INSERT INTO webinar_reactions (id, reg_id, lead_id, session_id, kind, chapter_at, minute, replay, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(reg_id, kind, chapter_at) DO NOTHING`,
  ).bind(newId('wx'), reg.id, reg.lead_id, reg.session_id, kind, ch, Math.floor(at / 60), body.replay === true ? 1 : 0, Date.now()).run();
  const rows = await rt.env.DB.prepare('SELECT chapter_at, kind, COUNT(DISTINCT lead_id) AS n FROM webinar_reactions WHERE chapter_at = ? GROUP BY 1, 2').bind(ch).all<{ chapter_at: number; kind: string; n: number }>();
  return { ok: true as const, chapter: ch, counts: publicReactionCounts(rows.results)[ch] ?? {} };
}

// ───────────── Buy-in: their own words on what the first acquisition would change ─────────────

/** At least this many viewers must have chosen to share before any shared answer is shown. */
export const WALL_MIN = 5;
export const BUYIN_AT = 36 * 60 + 6;
export const BUYIN_MAX = 280;

/** Their sentence, without links, email addresses or phone numbers, on one line, at most 280 characters. */
export function cleanBuyIn(v: unknown) {
  if (typeof v !== 'string') return '';
  return v
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, ' ')
    .replace(/\b(https?:\/\/|www\.)\S+/gi, ' ')
    .replace(/\b[\w-]+(\.[\w-]+)*\.(com|net|org|io|co|au|us|uk|biz|info|me|app|ai|xyz)(\/\S*)?\b/gi, ' ')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, BUYIN_MAX)
    .trim();
}

/** "M., $3M–$10M": a first initial and the revenue band, nothing more. */
export function wallLabel(firstName: string | null | undefined, band: string | null | undefined, labels: Record<string, string>) {
  const initial = (firstName ?? '').trim().match(/\p{L}/u)?.[0];
  return [initial ? `${initial.toUpperCase()}.` : null, band ? labels[band] ?? null : null].filter(Boolean).join(', ');
}

/** Real shared answers (latest per person, hidden ones left out), only once WALL_MIN people have shared. */
export function publicWall(rows: { lead_id: string; text: string; first_name: string | null; band: string | null }[], labels: Record<string, string>, exclude?: string, min = WALL_MIN, show = 4) {
  const seen = new Set<string>();
  const latest = rows.filter((r) => (seen.has(r.lead_id) ? false : (seen.add(r.lead_id), true)));
  if (latest.length < min) return [];
  return latest.filter((r) => r.lead_id !== exclude && r.text).slice(0, show).map((r) => ({ text: r.text, who: wallLabel(r.first_name, r.band, labels) }));
}

async function wallRows(rt: Runtime) {
  return rt.env.DB.prepare(
    `SELECT i.lead_id, i.value AS text, l.first_name, COALESCE(r.revenue_band, l.revenue_band) AS band
       FROM webinar_interactions i JOIN leads l ON l.id = i.lead_id LEFT JOIN webinar_registrations r ON r.id = i.reg_id
      WHERE i.kind = 'buyin' AND i.key = 'shared' AND i.handled = 0 ORDER BY i.created_at DESC LIMIT 200`,
  ).all<{ lead_id: string; text: string; first_name: string | null; band: string | null }>().then((r) => r.results).catch(() => []);
}

/** One answer per registration (a new one replaces it). key = shared | private; handled = 1 hides it from the wall (Funnel HQ). */
export async function saveBuyIn(rt: Runtime, reg: Registration, body: { text?: unknown; share?: unknown; pos?: unknown; replay?: unknown }) {
  const text = cleanBuyIn(body.text);
  if (text.length < 3) return { ok: false as const, error: 'Write a few words first' };
  const share = body.share === true;
  const db = rt.env.DB;
  await db.prepare("DELETE FROM webinar_interactions WHERE reg_id = ? AND kind = 'buyin'").bind(reg.id).run();
  await db.prepare('INSERT INTO webinar_interactions (id, reg_id, lead_id, session_id, kind, key, value, answer, at_sec, replay, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)')
    .bind(newId('wi'), reg.id, reg.lead_id, reg.session_id, 'buyin', share ? 'shared' : 'private', text, pos(body.pos), body.replay === true ? 1 : 0, Date.now()).run();
  // On the lead's timeline in Funnel HQ, so the follow-up and the strategy call can quote it.
  const { identityFromLead, track } = await import('../tracking/track');
  await track(rt, await identityFromLead(rt.env, reg.lead_id), { name: 'webinar_buyin', source: 'server', props: { text, shared: share }, localOnly: true });
  return { ok: true as const, text, shared: share };
}

// ───────────── Notes ─────────────

export async function saveNote(rt: Runtime, reg: Registration, body: { id?: unknown; saved?: unknown; replay?: unknown }) {
  const t = TAKEAWAYS.find((x) => x.id === body.id);
  if (!t) return { ok: false as const };
  const db = rt.env.DB;
  if (body.saved === false) await db.prepare('DELETE FROM webinar_notes WHERE reg_id = ? AND takeaway_id = ?').bind(reg.id, t.id).run();
  else {
    await db.prepare(
      `INSERT INTO webinar_notes (id, reg_id, lead_id, session_id, takeaway_id, text, at_sec, replay, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(reg_id, takeaway_id) DO NOTHING`,
    ).bind(newId('wn'), reg.id, reg.lead_id, reg.session_id, t.id, t.text, t.at, body.replay === true ? 1 : 0, Date.now()).run();
  }
  const saved = await db.prepare('SELECT takeaway_id FROM webinar_notes WHERE reg_id = ? ORDER BY at_sec').bind(reg.id).all<{ takeaway_id: string }>();
  return { ok: true as const, saved: saved.results.map((r) => r.takeaway_id) };
}

/** The notes email goes only to people who saved a key point in this showing (from 30 minutes before it started). */
export async function savedNotesSince(rt: Runtime, leadId: string, since: number) {
  const row = await rt.env.DB.prepare('SELECT 1 AS x FROM webinar_notes WHERE lead_id = ? AND created_at >= ? LIMIT 1').bind(leadId, since).first<{ x: number }>().catch(() => null);
  return Boolean(row);
}

export const notesUrl = (rt: Runtime, token: string) => `${webinarBase(rt)}/notes/${token}`;

// ───────────── Score inputs and storage ─────────────

async function scoreInputs(rt: Runtime, reg: Registration) {
  const db = rt.env.DB;
  const [band, rows, calc] = await Promise.all([
    db.prepare('SELECT COALESCE(r.revenue_band, l.revenue_band) AS band FROM webinar_registrations r LEFT JOIN leads l ON l.id = r.lead_id WHERE r.id = ?').bind(reg.id).first<{ band: string | null }>(),
    db.prepare("SELECT kind, key, value FROM webinar_interactions WHERE reg_id = ? AND kind IN ('poll', 'commit') ORDER BY created_at").bind(reg.id).all<{ kind: string; key: string | null; value: string | null }>(),
    db.prepare("SELECT value FROM webinar_interactions WHERE reg_id = ? AND kind = 'calc' ORDER BY created_at DESC LIMIT 1").bind(reg.id).first<{ value: string }>(),
  ]);
  const poll = (id: string) => rows.results.find((r) => r.kind === 'poll' && r.key === id)?.value ?? null;
  const commit = rows.results.find((r) => r.kind === 'commit')?.value ?? null;
  let c: { profit: number; price: number } | null = null;
  try { const v = JSON.parse(calc?.value ?? 'null') as { profit?: number; price?: number } | null; if (v?.profit && v.price) c = { profit: v.profit, price: v.price }; } catch { /* none */ }
  const inputs: ScoreInputs = {
    band: band?.band ?? null,
    target: poll('target_type') ?? commit, // the room's answer is the more recent one
    timeline: poll('timeline'), blocker: poll('blocker'), own_cash: poll('own_cash'),
    dscr: c ? dealMath(c.profit, c.price).dscr : null,
  };
  const inRoom = Boolean(c) || rows.results.some((r) => r.kind === 'poll');
  return { inputs, calc: c, inRoom };
}

/** Recompute and keep the score once they've answered something in the room (for Funnel HQ and the real average). */
export async function refreshScore(rt: Runtime, reg: Registration) {
  const { inputs, inRoom } = await scoreInputs(rt, reg);
  if (!inRoom) return null;
  const r = readinessScore(inputs);
  await rt.env.DB.prepare(
    `INSERT INTO webinar_scores (reg_id, lead_id, score, gap, factors, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(reg_id) DO UPDATE SET score = excluded.score, gap = excluded.gap, factors = excluded.factors, updated_at = excluded.updated_at`,
  ).bind(reg.id, reg.lead_id, r.score, r.gap, JSON.stringify(r.factors.map((f) => [f.id, f.points])), Date.now()).run();
  return r;
}

/** After a poll answer, a calculator run or the thank-you answer (the request body carries the token). */
export async function refreshScoreFor(rt: Runtime, token: unknown) {
  if (typeof token !== 'string') return;
  const reg = await getRegistration(rt, token);
  if (reg) await refreshScore(rt, reg);
}

// ───────────── Room config ─────────────

/** Added to the room's config by roomExtras: everything the watch experience needs for this viewer. */
export async function experienceConfig(rt: Runtime, reg: Registration, chs: Chapter[]) {
  const db = rt.env.DB;
  const safe = <T>(p: Promise<T>, d: T) => p.catch(() => d);
  const [{ inputs, calc }, notes, reacts, avg] = await Promise.all([
    scoreInputs(rt, reg),
    safe(db.prepare('SELECT takeaway_id FROM webinar_notes WHERE reg_id = ? ORDER BY at_sec').bind(reg.id).all<{ takeaway_id: string }>(), { results: [] } as unknown as D1Result<{ takeaway_id: string }>),
    safe(db.prepare('SELECT chapter_at, kind, COUNT(DISTINCT lead_id) AS n FROM webinar_reactions GROUP BY 1, 2').all<{ chapter_at: number; kind: string; n: number }>(), { results: [] } as unknown as D1Result<{ chapter_at: number; kind: string; n: number }>),
    safe(db.prepare('SELECT COUNT(*) AS n, AVG(score) AS avg FROM (SELECT lead_id, MAX(updated_at) AS t, score FROM webinar_scores GROUP BY lead_id)').first<{ n: number; avg: number | null }>(), null),
  ]);
  const { REVENUE_LABEL } = await import('../sales/qualify');
  const [wall, buyin] = await Promise.all([
    wallRows(rt),
    safe(db.prepare("SELECT value, key FROM webinar_interactions WHERE reg_id = ? AND kind = 'buyin' ORDER BY created_at DESC LIMIT 1").bind(reg.id).first<{ value: string; key: string }>(), null),
  ]);
  const mine = await safe(db.prepare('SELECT kind, chapter_at FROM webinar_reactions WHERE reg_id = ?').bind(reg.id).all<{ kind: string; chapter_at: number }>(), { results: [] } as unknown as D1Result<{ kind: string; chapter_at: number }>);
  return {
    takeaways: TAKEAWAYS,
    recaps: chs.map((c) => ({ at: c.at, title: c.title, line: CHAPTER_RECAP[c.at] ?? '' })),
    steps: BUILDER_STEPS,
    copy: EXPERIENCE_COPY,
    rules: SCORE_RULES,
    blockerGap: BLOCKER_GAP,
    gapNext: GAP_NEXT,
    inputs,
    calc,
    illustrative: illustrativeTarget(inputs.band),
    notes: notes.results.map((r) => r.takeaway_id),
    reacted: mine.results.map((r) => `${r.kind}:${r.chapter_at}`),
    reactions: publicReactionCounts(reacts.results),
    average: publicAverage(avg?.n ?? 0, avg?.avg ?? null),
    notesUrl: notesUrl(rt, reg.token),
    buyin: buyin ? { text: buyin.value, shared: buyin.key === 'shared' } : null,
    buyinAt: BUYIN_AT,
    buyinMax: BUYIN_MAX,
    wall: publicWall(wall, REVENUE_LABEL, reg.lead_id),
  };
}

// ───────────── Notes page (/notes/:token) ─────────────

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

export const NOTES_COPY = {
  eyebrow: 'From the masterclass',
  heading: 'Your notes from the masterclass',
  intro: 'The key points you saved while you watched, in the order they came up.',
  empty: 'You have not saved any notes yet. Key points appear under the video as the masterclass reaches them, each with a button to save it here.',
  back: 'Back to the masterclass',
  apply: 'Bring these to a strategy call: apply',
  disclaimer: 'Education, not legal, tax or financial advice. Every number here is illustrative. Lending decisions, terms and results depend on the business, the lender and the deal.',
};

export async function notesPage(c: Context<AppEnv>, chs: Chapter[]) {
  const rt = runtimeFrom(c);
  const reg = await getRegistration(rt, c.req.param('token') ?? '');
  const session = reg ? await getSession(rt, reg.session_id) : null;
  if (!reg || !session) return render(c, '/webinar-expired.html', { title: 'Link not found', slots: { expired_title: 'We couldn’t find that link', expired_body: 'Register below and we’ll email you a fresh one.' }, show: { rebook: false } });
  const rows = await rt.env.DB.prepare('SELECT takeaway_id, text, at_sec FROM webinar_notes WHERE reg_id = ? ORDER BY at_sec').bind(reg.id).all<{ takeaway_id: string; text: string; at_sec: number }>();
  const p = phase(rt, session);
  const back = p === 'replay' ? replayUrl(rt, reg.token) : p === 'expired' ? null : roomUrl(rt, reg.token);
  const groups = chs.map((ch) => ({ ch, notes: rows.results.filter((r) => chapterAt(chs, r.at_sec) === ch.at) })).filter((g) => g.notes.length);
  const body = `<header class="ws-head"><span class="eyebrow">${esc(NOTES_COPY.eyebrow)}</span><h1 class="h2">${esc(NOTES_COPY.heading)}</h1><p class="lede">${esc(rows.results.length ? NOTES_COPY.intro : NOTES_COPY.empty)}</p></header>` +
    groups.map((g) => `<section class="ws-sec wx-notes-sec"><h2 class="h3">${esc(g.ch.title)}</h2><ol class="wx-notes-list">${g.notes.map((n) => `<li><span class="wx-note-time">${mmss(n.at_sec)}</span><p>${esc(n.text)}</p></li>`).join('')}</ol></section>`).join('') +
    `<p class="muted ws-disc">${esc(NOTES_COPY.disclaimer)}</p><p class="no-print wx-notes-actions">${back ? `<a class="btn btn-sm ghost" href="${esc(back)}">${esc(NOTES_COPY.back)}</a> ` : ''}<a class="btn btn-sm" href="${esc(`${rt.origin}/w/${reg.token}`)}">${esc(NOTES_COPY.apply)} →</a></p>`;
  return render(c, '/webinar-worksheet.html', { title: NOTES_COPY.heading, blocks: { worksheet: body } });
}

// ───────────── Funnel HQ ─────────────

/** "Moments that land" (reactions and note saves per minute), the score distribution and each registrant's score. */
export async function experienceInsights(rt: Runtime, range: { from: number; to: number }, durationMin: number) {
  const db = rt.env.DB;
  const len = Math.max(1, Math.round(durationMin));
  const [reacts, notes, scores, buyins] = await Promise.all([
    db.prepare('SELECT minute, kind, COUNT(*) AS n FROM webinar_reactions WHERE created_at BETWEEN ? AND ? GROUP BY 1, 2').bind(range.from, range.to).all<{ minute: number; kind: string; n: number }>(),
    db.prepare('SELECT at_sec / 60 AS minute, takeaway_id, COUNT(*) AS n FROM webinar_notes WHERE created_at BETWEEN ? AND ? GROUP BY 1, 2').bind(range.from, range.to).all<{ minute: number; takeaway_id: string; n: number }>(),
    db.prepare('SELECT score, gap FROM webinar_scores WHERE updated_at BETWEEN ? AND ?').bind(range.from, range.to).all<{ score: number; gap: string | null }>(),
    db.prepare(
      `SELECT i.id, i.value AS text, i.key, i.handled, i.created_at, i.lead_id, l.first_name, l.last_name, l.email, COALESCE(r.revenue_band, l.revenue_band) AS band,
              (l.app_completed_at IS NOT NULL) AS applied, (l.booked_at IS NOT NULL AND l.booking_cancelled_at IS NULL) AS booked
         FROM webinar_interactions i JOIN leads l ON l.id = i.lead_id LEFT JOIN webinar_registrations r ON r.id = i.reg_id
        WHERE i.kind = 'buyin' AND i.created_at BETWEEN ? AND ? ORDER BY i.created_at DESC LIMIT 200`,
    ).bind(range.from, range.to).all<{ id: string; text: string; key: string; handled: number; created_at: number; lead_id: string; first_name: string | null; last_name: string | null; email: string | null; band: string | null; applied: number; booked: number }>(),
  ]);
  const minutes = Array.from({ length: len }, (_, m) => ({ minute: m, new: 0, do: 0, explain: 0, notes: 0, total: 0 }));
  for (const r of reacts.results) { const m = minutes[Math.min(len - 1, Math.max(0, r.minute))]; if (r.kind === 'new' || r.kind === 'do' || r.kind === 'explain') { m[r.kind] += r.n; m.total += r.n; } }
  for (const r of notes.results) { const m = minutes[Math.min(len - 1, Math.max(0, Math.floor(r.minute)))]; m.notes += r.n; m.total += r.n; }
  const buckets = [[0, 19], [20, 39], [40, 59], [60, 79], [80, 100]].map(([a, b]) => ({ label: `${a} to ${b}`, n: scores.results.filter((s) => s.score >= a && s.score <= b).length }));
  const gaps = new Map<string, number>();
  for (const s of scores.results) if (s.gap) gaps.set(s.gap, (gaps.get(s.gap) ?? 0) + 1);
  const topNotes = new Map<string, number>();
  for (const r of notes.results) topNotes.set(r.takeaway_id, (topNotes.get(r.takeaway_id) ?? 0) + r.n);
  return {
    minutes,
    totals: { reactions: reacts.results.reduce((a, r) => a + r.n, 0), notes: notes.results.reduce((a, r) => a + r.n, 0), scored: scores.results.length },
    average: scores.results.length ? Math.round(scores.results.reduce((a, s) => a + s.score, 0) / scores.results.length) : null,
    buckets,
    gaps: [...gaps.entries()].map(([gap, n]) => ({ gap, n })).sort((a, b) => b.n - a.n),
    buyins: buyins.results.map((b) => ({ id: b.id, text: b.text, shared: b.key === 'shared', hidden: Boolean(b.handled), created_at: b.created_at, lead_id: b.lead_id, name: [b.first_name, b.last_name].filter(Boolean).join(' ') || b.email || 'Someone', email: b.email, band: b.band, applied: Boolean(b.applied), booked: Boolean(b.booked) })),
    wallLive: new Set(buyins.results.filter((b) => b.key === 'shared' && !b.handled).map((b) => b.lead_id)).size >= WALL_MIN,
    topNotes: [...topNotes.entries()].map(([id, n]) => ({ id, text: TAKEAWAYS.find((t) => t.id === id)?.text ?? id, n })).sort((a, b) => b.n - a.n).slice(0, 5),
  };
}
