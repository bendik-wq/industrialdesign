/**
 * Engagement in our webinar rooms (pure: no I/O, so the tests drive it directly). engage-db.ts stores what these
 * rules decide; the room's state machine (state.ts) holds the live part (pushes, the knowledge check, the
 * agenda, the leaderboard) and the Durable Object turns real events into point awards.
 *
 *  - Deal momentum: points for real actions only (on time, minutes present, chapters reached, poll answers,
 *    questions, knowledge checks, Deal Plan steps, the application, staying to the end). Chat earns nothing.
 *    Every action has its points and a cap; each award has a key, so the same thing never counts twice.
 *    ENGAGE_POINTS overrides the defaults ("question:5x3, poll:3x10").
 *  - Unlocks: real files (public/unlocks, served only to people who earned them) at point thresholds, or for
 *    staying to the end. ENGAGE_UNLOCKS overrides the defaults ("calculator:25, scripts:60, buybox:100, checklist:end").
 *  - The Deal Plan: the worksheet each attendee fills while Josh teaches (buy box, owners per week, the 1.5x
 *    test, the first three actions). Four steps, each counted once when it is really filled in.
 */

export type PointAction = 'on_time' | 'present_10' | 'chapter' | 'poll' | 'question' | 'quiz' | 'quiz_correct' | 'plan_step' | 'application' | 'stayed_end' | 'early' | 'referral';
export interface PointRule { points: number; cap: number; label: string }
export type PointRules = Record<PointAction, PointRule>;

export const DEFAULT_RULES: PointRules = {
  on_time: { points: 10, cap: 1, label: 'Joined on time' },
  present_10: { points: 5, cap: 12, label: 'Ten minutes in the room' },
  chapter: { points: 5, cap: 12, label: 'Reached a new chapter' },
  poll: { points: 3, cap: 10, label: 'Answered a poll' },
  question: { points: 5, cap: 3, label: 'Asked a question' },
  quiz: { points: 5, cap: 10, label: 'Answered a knowledge check' },
  quiz_correct: { points: 5, cap: 10, label: 'Got a knowledge check right' },
  plan_step: { points: 10, cap: 4, label: 'Completed a Deal Plan step' },
  application: { points: 30, cap: 1, label: 'Sent the application' },
  stayed_end: { points: 20, cap: 1, label: 'Stayed to the end' },
  // Lifecycle (builder E): in the waiting room before the start (server clock), and an owner you brought who attended.
  early: { points: 10, cap: 1, label: 'In the waiting room before the start' },
  referral: { points: 25, cap: 5, label: 'An owner you brought attended' },
};
export const POINT_ACTIONS = Object.keys(DEFAULT_RULES) as PointAction[];
/** Questions shorter than this earn no points (no farming with "hi"). */
export const QUESTION_MIN_CHARS = 15;
/** Joining within this long of Go live counts as on time. */
export const ON_TIME_MS = 5 * 60_000;

/** "question:5x3, poll:3" → the defaults with those overrides (unknown actions and silly values are ignored). */
export function parseRules(raw: string | null | undefined): PointRules {
  const out: PointRules = JSON.parse(JSON.stringify(DEFAULT_RULES));
  for (const part of String(raw ?? '').split(/[,;\n]+/)) {
    const m = /^\s*([a-z_0-9]+)\s*:\s*(\d{1,3})(?:\s*[x×*]\s*(\d{1,3}))?\s*$/i.exec(part);
    if (!m || !(m[1] in out)) continue;
    const r = out[m[1] as PointAction];
    r.points = Math.min(500, Number(m[2]));
    if (m[3]) r.cap = Math.max(1, Math.min(100, Number(m[3])));
  }
  return out;
}

// ───────────── unlocks: the assets ─────────────

export interface Asset { id: string; title: string; body: string; file: string; type: string; download: string }
/** Real files under public/unlocks (served by /rooms/a/... only to people who earned them, never as plain static files). */
export const ASSETS: Asset[] = [
  { id: 'calculator', title: 'The 1.5x deal calculator', body: 'A spreadsheet that runs the 1.5x debt service coverage test on any business: commercial debt, seller finance and seller rollover, with every formula visible.', file: '/unlocks/deal-calculator.csv', type: 'text/csv; charset=utf-8', download: 'deal-calculator.csv' },
  { id: 'scripts', title: 'The owner outreach scripts', body: 'The letter, the email, the first call and the follow-ups for owners with no successor, word for word.', file: '/unlocks/owner-outreach-scripts.html', type: 'text/html; charset=utf-8', download: '' },
  { id: 'buybox', title: 'The buy box template', body: 'One page that pins down what you buy: industry, size, geography, the owner, the numbers and the walk-away lines.', file: '/unlocks/buy-box-template.html', type: 'text/html; charset=utf-8', download: '' },
  { id: 'checklist', title: 'The first-deal checklist', body: 'Every step from the first owner conversation to a signed letter of intent, in order, with what to ask for at each one.', file: '/unlocks/first-deal-checklist.html', type: 'text/html; charset=utf-8', download: '' },
];
export const assetById = (id: unknown) => ASSETS.find((a) => a.id === id) ?? null;

export interface UnlockRule { asset: string; at: number | 'end' }
export const DEFAULT_UNLOCKS: UnlockRule[] = [
  { asset: 'calculator', at: 25 },
  { asset: 'scripts', at: 60 },
  { asset: 'buybox', at: 100 },
  { asset: 'checklist', at: 'end' },
];
/** "calculator:25, scripts:60, checklist:end" (blank = the defaults; "off" = no unlocks). */
export function parseUnlocks(raw: string | null | undefined): UnlockRule[] {
  const v = String(raw ?? '').trim();
  if (!v) return DEFAULT_UNLOCKS.map((u) => ({ ...u }));
  if (/^(off|none)$/i.test(v)) return [];
  const out: UnlockRule[] = [];
  for (const part of v.split(/[,;\n]+/)) {
    const m = /^\s*([a-z]+)\s*:\s*(end|\d{1,4})\s*$/i.exec(part);
    if (!m || !assetById(m[1].toLowerCase()) || out.some((u) => u.asset === m[1].toLowerCase())) continue;
    out.push({ asset: m[1].toLowerCase(), at: m[2].toLowerCase() === 'end' ? 'end' : Number(m[2]) });
  }
  return out;
}
/** The point-threshold unlocks someone has reached (the "end" one is granted only by staying to the end). */
export const earnedAt = (rules: UnlockRule[], points: number) => rules.filter((u) => typeof u.at === 'number' && points >= u.at).map((u) => u.asset);
/** The next threshold above these points (for the progress ring), or null. */
export function nextUnlock(rules: UnlockRule[], points: number) {
  const n = rules.filter((u): u is UnlockRule & { at: number } => typeof u.at === 'number' && u.at > points).sort((a, b) => a.at - b.at)[0];
  return n ? { asset: n.asset, at: n.at, title: assetById(n.asset)?.title ?? n.asset } : null;
}

// ───────────── the agenda (host chapter markers) ─────────────

export interface AgendaItem { title: string; teaser: string }
/** The live webinar's agenda, in the order of the run sheet (public/materials/live-webinar.md). */
export const DEFAULT_AGENDA: AgendaItem[] = [
  { title: 'One decision tonight', teaser: 'What this session is for, and the one decision it helps you make.' },
  { title: 'Buying beats building', teaser: 'Why a group trades at a higher multiple than one business (illustrative: 3 to 5x against 8 to 12x).' },
  { title: 'Where the businesses are', teaser: 'Owners with no successor, off market, and the first conversation with one.' },
  { title: 'The 1.5x test', teaser: 'How big a business you can buy, and the one test every deal has to pass.' },
  { title: 'Structure, not cash', teaser: 'Commercial debt, seller finance and seller rollover, and the order: the seller first, then the lender.' },
  { title: 'The obstacles', teaser: 'Time, team and the first deal: what stands between you and a signed letter of intent.' },
  { title: 'How the engagement works', teaser: 'Ninety days done with you, the price, the guarantee and its conditions.' },
  { title: 'Your questions', teaser: 'Josh answers the questions from the room.' },
];
/** "Title | teaser" per line (blank = the default agenda). */
export function parseAgenda(raw: string | null | undefined): AgendaItem[] {
  const lines = String(raw ?? '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 20);
  if (!lines.length) return DEFAULT_AGENDA.map((a) => ({ ...a }));
  return lines.map((l) => {
    const [t, ...rest] = l.split('|');
    return { title: clean(t, 80), teaser: clean(rest.join('|'), 200) };
  }).filter((a) => a.title);
}
export const agendaText = (a: AgendaItem[]) => a.map((x) => (x.teaser ? `${x.title} | ${x.teaser}` : x.title)).join('\n');

// ───────────── knowledge checks (one question, a right answer, an explanation) ─────────────

export interface QuizPreset { id: string; question: string; options: string[]; correct: number; explain: string }
export const QUIZ_PRESETS: QuizPreset[] = [
  {
    id: 'dscr', question: 'Illustrative: a business makes $600K a year before loan payments, and the loan payments are $500K a year. Does it pass the 1.5x test?',
    options: ['Yes', 'No'], correct: 1,
    explain: '$600K divided by $500K is 1.2x. To carry $500K of payments it needs $750K of cash flow (illustrative numbers). Change the structure until the numbers clear 1.5x, or walk away.',
  },
  {
    id: 'stack', question: 'Which three pieces fund the purchase in this structure?',
    options: ['Commercial debt, seller finance and seller rollover', 'Personal savings, a home loan and friends', 'A broker, an auction and an overdraft'], correct: 0,
    explain: 'The lender lends against the target’s cash flow. Seller finance and seller rollover close the gap, and the seller keeps a stake that gets paid twice.',
  },
  {
    id: 'order', question: 'Who do you agree the shape of the deal with first?',
    options: ['The seller', 'The lender'], correct: 0,
    explain: 'Agree the shape with the seller first, then take it to the lender. Lenders assess a structure, and the structure starts with what the seller accepts.',
  },
  {
    id: 'where', question: 'Where do the best first deals come from?',
    options: ['Broker listings', 'Owners with no successor, approached directly', 'Auctions'], correct: 1,
    explain: 'Listed businesses draw a crowd of buyers. An owner with no successor, approached directly and early, talks to one buyer: you.',
  },
  {
    id: 'multiple', question: 'Illustrative ranges: one small business trades at 3 to 5x EBITDA. What does a group of them trade at?',
    options: ['The same 3 to 5x', '8 to 12x', 'Under 2x'], correct: 1,
    explain: 'A group with a management team and several sites trades at a higher multiple (illustrative: 8 to 12x). That gap is the reason to buy the competitor instead of only building.',
  },
];
export function cleanQuiz(raw: { question?: unknown; options?: unknown; correct?: unknown; explain?: unknown }) {
  const question = clean(raw.question, 240);
  const options = (Array.isArray(raw.options) ? raw.options : []).map((o) => clean(o, 120)).filter(Boolean).slice(0, 4);
  const correct = Number(raw.correct);
  const explain = clean(raw.explain, 400);
  if (!question || options.length < 2 || !Number.isInteger(correct) || correct < 0 || correct >= options.length) return null;
  return { question, options, correct, explain };
}

// ───────────── the Deal Plan worksheet ─────────────

export interface PlanData {
  industry: string; size: string; geography: string; owners_per_week: string;
  cash_flow: string; debt_service: string;
  action_1: string; action_2: string; action_3: string;
}
export const PLAN_KEYS: (keyof PlanData)[] = ['industry', 'size', 'geography', 'owners_per_week', 'cash_flow', 'debt_service', 'action_1', 'action_2', 'action_3'];
export const PLAN_STEPS = [
  { id: 'buybox', keys: ['industry', 'size', 'geography'] as (keyof PlanData)[] },
  { id: 'outreach', keys: ['owners_per_week'] as (keyof PlanData)[] },
  { id: 'coverage', keys: ['cash_flow', 'debt_service'] as (keyof PlanData)[] },
  { id: 'actions', keys: ['action_1', 'action_2', 'action_3'] as (keyof PlanData)[] },
] as const;

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '');
/** A money figure typed any way ("$650k", "1.2m", "650,000") → a number, or null. */
export function money(v: unknown): number | null {
  const s = String(v ?? '').toLowerCase().replace(/[$,\s]/g, '');
  const m = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] === 'm' ? 1_000_000 : m[2] === 'k' ? 1_000 : 1);
  return Number.isFinite(n) && n > 0 && n < 1e12 ? n : null;
}
export function cleanPlan(raw: unknown): PlanData {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = {} as PlanData;
  for (const k of PLAN_KEYS) out[k] = clean(r[k], k.startsWith('action') ? 200 : 120);
  const n = Number(out.owners_per_week.replace(/[^\d]/g, ''));
  out.owners_per_week = out.owners_per_week ? (Number.isFinite(n) && n > 0 ? String(Math.min(1000, n)) : '') : '';
  return out;
}
/** The 1.5x test on the worksheet's two numbers. */
export function coverage(p: Pick<PlanData, 'cash_flow' | 'debt_service'>) {
  const cf = money(p.cash_flow), ds = money(p.debt_service);
  if (cf == null || ds == null) return null;
  const ratio = Math.round((cf / ds) * 100) / 100;
  return { ratio, passes: ratio >= 1.5, maxDebtService: Math.round(cf / 1.5) };
}
/** Which steps are really done (each field filled with something meaningful; the numbers must parse). */
export function planSteps(p: PlanData): string[] {
  const done: string[] = [];
  const filled = (k: keyof PlanData) => p[k].length >= (k.startsWith('action') ? 6 : 2);
  if (filled('industry') && filled('size') && filled('geography')) done.push('buybox');
  if (Number(p.owners_per_week) > 0) done.push('outreach');
  if (coverage(p)) done.push('coverage');
  if (filled('action_1') && filled('action_2') && filled('action_3')) done.push('actions');
  return done;
}

// ───────────── the leaderboard (opt-in, first names only) ─────────────

export const firstName = (name: string) => (name || '').replace(/[^\p{L}\p{M}' -]/gu, '').trim().split(/\s+/)[0]?.slice(0, 20) || '';
export function leaderboard(points: Record<string, number>, names: Record<string, string>, optIn: string[], n = 10) {
  return optIn.map((id) => ({ id, name: firstName(names[id] ?? ''), points: points[id] ?? 0 })).filter((x) => x.name && x.points > 0)
    .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name)).slice(0, n);
}

// ───────────── the room's own copy (checked by auditCopy) ─────────────

export const ENGAGE_COPY = {
  momentum: 'Deal momentum',
  points: (n: number) => (n === 1 ? '1 point' : `${n} points`),
  nextAt: (title: string, n: number) => `${title} unlocks at ${n} points.`,
  allUnlocked: 'Every unlock is yours.',
  earnHeading: 'How to earn points',
  earnNote: 'Points come from what you do in the session. Chat earns none, and each action counts up to a limit.',
  unlocksHeading: 'Your unlocks',
  locked: (n: number) => `At ${n} points`,
  lockedEnd: 'For staying to the end',
  open: 'Open',
  boardHeading: 'Leaderboard',
  boardOptIn: 'Show my first name on the leaderboard',
  boardEmpty: 'Nobody has opted in yet.',
  boardOff: 'The host has the leaderboard off.',
  award: (label: string, n: number) => `${label}: +${n}`,
  unlocked: (title: string) => `Unlocked: ${title}`,
  agendaNow: 'Now',
  agendaNext: 'Next up',
  agendaDone: 'Final chapter',
  tray: 'For you',
  dismiss: 'Not now',
  // pushes
  appEyebrow: 'Apply to work with Josh’s team',
  appHeading: 'Your application',
  appBody: 'A few questions about your business. Josh’s team reads every answer before anything else happens.',
  appButton: 'Start my application',
  appContinue: 'Continue',
  appBack: 'Back',
  appSubmit: 'Send my application',
  appStep: (i: number, n: number) => `Step ${i} of ${n}`,
  appAbout: 'Applying as',
  appDoneHeading: 'Your application is in',
  appDoneBody: 'Josh’s team reads it next. Your answers stay with the team.',
  appDoneNext: 'What happens next',
  appDoneOffer: 'The offer from this session is open in the room. You can secure your place there while Josh keeps teaching.',
  appDoneSprint: 'If you want your first deal mapped out in writing first, the First Deal Sprint is open to you from this room.',
  appMissing: 'Answer this one to continue.',
  appNeedsLead: 'Open the room from the personal link in your email to apply here.',
  sprintEyebrow: 'Open in this session',
  oneClickHeading: 'Confirm your payment',
  oneClickCharged: (card: string) => `Charged to the ${card} saved with your ticket.`,
  oneClickChargedNoCard: 'Charged to the card saved with your ticket.',
  oneClickConfirm: (total: string) => `Confirm and pay ${total}`,
  otherCard: 'Use a different card',
  paying: 'Taking your payment…',
  paidHeading: 'Payment received',
  paidBody: 'Thank you. Your confirmation email has the next step. You can go back to the room tab now.',
  sprintPaidBody: 'Your First Deal Sprint has started. Josh’s team emails you the kickoff details, and your intake form is in the same email.',
  sprintUnavailable: 'The Sprint can’t be bought from this room right now. Email the team and they send you a payment link.',
  sprintUnderMillion: 'The First Deal Sprint is for owners doing $1M or more a year.',
  vipEyebrow: 'Challenge VIP',
  vipHeading: 'Upgrade to VIP',
  vipBody: 'A daily hot-seat Q&A after each session, the recordings kept, and a review of your worksheets by the team.',
  vipButton: 'See the VIP upgrade',
  resourceEyebrow: 'From Josh',
  resourceButton: 'Open it',
  depositButton: 'See the offer',
  // knowledge checks
  quizEyebrow: 'Knowledge check',
  quizRight: 'Right.',
  quizWrong: 'Not quite.',
  quizAnswer: (a: string) => `The answer: ${a}.`,
  quizClosed: 'This knowledge check has closed.',
  // the Deal Plan
  planTab: 'Deal Plan',
  planHeading: 'Your Deal Plan',
  planIntro: 'Fill it in while Josh teaches. It saves as you type, and a copy comes to your email after the session.',
  planBuyBox: 'Your buy box',
  planIndustry: 'Industry',
  planIndustryHint: 'e.g. commercial HVAC',
  planSize: 'Size of business you want to buy',
  planSizeHint: 'e.g. $2M to $5M revenue',
  planGeography: 'Where',
  planGeographyHint: 'e.g. within two hours of Dallas',
  planOutreach: 'Owner outreach',
  planOwners: 'Owners you contact each week',
  planOwnersHint: 'e.g. 25',
  planCoverage: 'The 1.5x test (illustrative numbers are fine)',
  planCashFlow: 'The target’s yearly cash flow before loan payments',
  planCashFlowHint: 'e.g. $900K',
  planDebt: 'Yearly loan payments in your structure',
  planDebtHint: 'e.g. $550K',
  planPasses: (r: string) => `${r}x: passes the 1.5x test.`,
  planFails: (r: string, max: string) => `${r}x: below 1.5x. Payments up to ${max} a year pass at this cash flow.`,
  planActions: 'Your first three actions',
  planAction: (i: number) => `Action ${i}`,
  planActionHints: ['e.g. Write my buy box on one page', 'e.g. List 50 owners over 60 in my area', 'e.g. Send the first 25 letters on Monday'],
  planSaved: 'Saved',
  planSaving: 'Saving…',
  planSteps: (n: number) => `${n} of 4 steps done`,
  planNeedsLead: 'Open the room from the personal link in your email to save a Deal Plan.',
  // host
  pushTab: 'Push',
  pushHeading: 'Push to the room',
  pushTo: 'Send to',
  pushEveryone: 'Everyone',
  pushSelected: 'Selected people',
  pushApplication: 'The application',
  pushSprint: 'First Deal Sprint payment card',
  pushDeposit: 'Engagement deposit payment card',
  pushVip: 'Challenge VIP upgrade',
  pushResource: 'A resource',
  pushSend: 'Push',
  pushClose: 'Take it down',
  pushNeedsOffer: 'Open the offer first: the deposit card follows the offer’s real deadline.',
  pushLive: 'Live pushes',
  pushNone: 'Nothing pushed yet.',
  funnel: { shown: 'Shown', opened: 'Opened', started: 'Started', submitted: 'Submitted', paid: 'Paid' },
  tierNote: 'Tiers are visible to the team only.',
  quizHeading: 'Knowledge check',
  quizPreset: 'Ready-made',
  quizOwn: 'Write your own',
  quizQuestion: 'Question',
  quizOptions: 'Answers, one per line',
  quizCorrect: 'Right answer (number)',
  quizExplain: 'Explanation shown after they answer',
  quizStart: 'Start the check',
  quizClose: 'Close the check',
  quizRightPct: (n: number, t: number) => `${n} of ${t} right`,
  agendaHeading: 'Agenda',
  agendaStart: 'Start the first chapter',
  agendaNextBtn: 'Next chapter',
  agendaBack: 'Previous',
  boardToggleOn: 'Show the leaderboard',
  boardToggleOff: 'Hide the leaderboard',
  selectHint: 'Tick people in the People tab to send to them only.',
  selectedCount: (n: number) => `Selected (${n})`,
  endNote: 'Your summary and your Deal Plan come to your email shortly.',
  momentumHeading: 'Your Deal momentum',
  upTo: (n: number) => `up to ${n} times`,
  close: 'Close',
  errors: {
    push_kind: 'That push isn’t available in this room.',
    push_targets: 'Pick at least one person, or send to everyone.',
    offer_closed: 'Open the offer first.',
    quiz_incomplete: 'Add a question, at least two answers and the right one.',
    already_answered: 'You already answered this one.',
    quiz_closed: 'This knowledge check has closed.',
    not_targeted: 'That isn’t open for you.',
  } as Record<string, string>,
};

/** The application questions in the room. Same ids and options (so the scoring is unchanged); two titles reworded for a room with no booking call. */
export const ROOM_QUESTION_TITLES: Record<string, { title: string; help?: string }> = {
  readiness: { title: 'If Josh’s team shows you a clear path, are you ready to invest in getting it done?' },
  why_now: { title: 'Why now? What would doubling the size of your business change for you?', help: 'The more specific you are, the more useful your plan with the team will be.' },
};

// ───────────── the summary email (pure; sent by engage-db.ts) ─────────────

export interface SummaryInput {
  name: string; title: string; points: number;
  unlocks: { title: string; url: string }[];
  plan: PlanData | null; planUrl: string | null;
  bought: boolean; offer: { label: string; closesAt: string; url: string } | null;
  applied: boolean;
}
export function summaryEmail(x: SummaryInput) {
  const paras = [`Hi ${x.name},`, `Here is your summary from ${x.title}.`];
  paras.push(x.points ? `Deal momentum: ${x.points} points from what you did in the session.` : 'You were in the room for the session.');
  if (x.unlocks.length) paras.push(`Unlocked for you: ${x.unlocks.map((u) => `${u.title} (${u.url})`).join('; ')}.`);
  if (x.plan) {
    const c = coverage(x.plan);
    const box = [x.plan.industry, x.plan.size, x.plan.geography].filter(Boolean).join(', ');
    if (box) paras.push(`Buy box: ${box}.`);
    if (x.plan.owners_per_week) paras.push(`Owner outreach: ${x.plan.owners_per_week} owners a week.`);
    if (c) paras.push(`The 1.5x test on your numbers: ${c.ratio}x, ${c.passes ? 'which passes' : 'below 1.5x, so the structure changes before the lender sees it'}.`);
    const acts = [x.plan.action_1, x.plan.action_2, x.plan.action_3].filter(Boolean);
    if (acts.length) paras.push(`First three actions: ${acts.map((a) => a.replace(/[.;]+$/, '')).join('; ')}.`);
  }
  if (x.applied) paras.push('Josh’s team has your application.');
  if (!x.bought && x.offer) paras.push(`The ${x.offer.label} offer from this session closes on ${x.offer.closesAt}. It is here: ${x.offer.url}`);
  return {
    subject: x.plan ? `Your Deal Plan from ${x.title}` : `Your summary from ${x.title}`,
    preheader: x.plan ? 'Your buy box, your 1.5x test and your first three actions.' : 'Your points, your unlocks and the next step.',
    heading: x.plan ? 'Your Deal Plan' : 'Your session summary',
    paras,
    button: x.planUrl ? { label: 'Open my Deal Plan', href: x.planUrl } : x.offer && !x.bought ? { label: 'See the offer', href: x.offer.url } : undefined,
  };
}
