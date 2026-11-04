import { copyBrief } from '../content/copy-rules';

/**
 * The copy brain behind Studio → Scripts: the house copy skills (Sultanic direct response, the FF Swipe File
 * frameworks, the 3C Acquisition Model) distilled into one system prompt for a face-cam shooting script.
 *
 * Adapted to G&L's true facts ONLY. The skills' templates carry placeholders such as "our student [NAME]",
 * "I own [X] clinics", case studies and board names; none of that is used here. Proof is limited to FACTS below,
 * example numbers are labelled illustrative, seller rollover is named whenever funding is described, and the
 * strategy call is never "free". copy-rules.ts (copyBrief + auditCopy) stays the final word: this file adds the
 * structures and the face-cam format on top of it.
 */

// ───────────── the inputs the owner picks ─────────────

export const LAYOUTS = ['orbit', 'split', 'spotlight', 'stage', 'vertical', 'cinema'] as const;
export type Layout = (typeof LAYOUTS)[number];

/** What each face-cam layout is for (builder A renders them; the generator picks one per beat). */
export const LAYOUT_GUIDE: Record<Layout, string> = {
  cinema: 'the open: wide 16:9 frame, face full and centred, one line of large text. Use for the first beat of long-form only.',
  spotlight: 'face large and centred, nothing else on screen. Use for the hook, story, belief shifts and the close: anything spoken straight to camera.',
  orbit: 'face in a round bubble floating over a quiet screen. Face-led with light context: hooks, story beats that reference something on screen.',
  stage: 'the screen fills the frame, face small in a corner. Use when the viewer must read the screen: a document, a spreadsheet, a website.',
  split: 'face and screen side by side, half each. Use to walk through numbers, a structure or a diagram while staying personal.',
  vertical: '9:16, face over the screen, for Shorts and Reels. Every beat of a Short uses this.',
};

export const FORMATS = {
  long: { label: 'Long YouTube', sub: '8 to 12 minutes', beats: [14, 22], words: [1250, 1800], spec: 'A long-form YouTube video, 8 to 12 minutes spoken. Packaging first: the hook delivers on the title at once. Then the call-in and call-out, the mechanism as a logic ladder (each beat one small step ending on an open loop into the next), a mid-video soft CTA, the close and the hard CTA. Beat 1 uses the cinema layout.' },
  short: { label: 'Short', sub: '45 seconds', beats: [4, 6], words: [100, 135], spec: 'A 45-second Short or Reel. Hook in the first two seconds, one belief shift, one identity line, the CTA. Every beat uses the vertical layout. Short lines a viewer can read as captions.' },
  vsl: { label: 'VSL segment', sub: '2 to 4 minutes', beats: [6, 10], words: [330, 560], spec: 'One segment of a video sales letter, 2 to 4 minutes: opener, not-your-fault, the payoff promise, the mechanism tease, then the close stack the framework calls for, ending on the CTA.' },
  webinar: { label: 'Webinar teaser', sub: '60 to 90 seconds', beats: [4, 7], words: [160, 230], spec: 'A 60 to 90 second teaser that makes a $1M+ owner register for the live session: the problem, why the usual way fails, what the session shows (the what and the why, not the full how), the CTA to register.' },
  email: { label: 'Email-to-video', sub: '60 to 120 seconds', beats: [4, 7], words: [170, 300], spec: 'A personal 60 to 120 second video to send inside an email, spoken like a note to one owner: a pattern-interrupt line, validate their situation, name the real problem, the mechanism, the true proof, a specific CTA, and a closing line that restates the cost of not acting (the P.S. said out loud).' },
} as const;
export type FormatId = keyof typeof FORMATS;
export const FORMAT_IDS = Object.keys(FORMATS) as FormatId[];

/** The four ICPs from the copy skill, with the 3C fill for each. */
export const ICPS = {
  trapped: { label: 'Trapped Owner', sub: 'One business, works in it, no exit', brief: 'Trapped Owner: owns one profitable business ($1M+ revenue) and works IN it every day with no exit. Pain: the business needs them, growth means more of their hours. Dream: a group of businesses run by a team, profit without more hours. Fear: "what if I can\'t run more than one."' },
  ceiling: { label: 'One-Business Ceiling', sub: 'Revenue has plateaued', brief: 'One-Business Ceiling: revenue has plateaued at a level they can\'t push past themselves (a booking-form owner wrote "stuck at the 5-6m range need more locations"). Dream: buy competitors, build a group, exit at a group multiple. Fear: "I don\'t have the capital to buy more."' },
  deployer: { label: 'HNW Capital Deployer', sub: 'Capital sitting in low-yield assets', brief: 'HNW Capital Deployer: has capital sitting in low-yield assets and wants it working in small-business cash flow. Dream: own cash-flowing companies bought on the right structure. Fear: "I don\'t know how to find or vet deals" (off-market sourcing, quality of earnings, the 1.5x test answer it).' },
  prisoner: { label: 'Corporate Prisoner', sub: 'Salary, no ownership', brief: 'Corporate Prisoner: a salary, golden handcuffs, no ownership. Dream: own a cash-flowing business. Fear: "too risky, I have a mortgage." G&L serves owners of $1M+ businesses first, so for this viewer the honest call-out is that the method assumes a business to buy with its own cash flow, and the application decides fit.' },
} as const;
export type IcpId = keyof typeof ICPS;
export const ICP_IDS = Object.keys(ICPS) as IcpId[];

// ───────────── the frameworks, distilled and adapted ─────────────

export const FRAMEWORKS = {
  two_paths: {
    label: 'Two Paths', sub: 'The hard path alone or the path someone has already walked',
    body: `THE TWO PATHS. A binary: the hard path (doing it alone, the first time, learning by expensive mistakes) against the proven path (someone who has already made those mistakes shows you).
Shape: a question that decides where they go and how fast ("what if you and I could trade places") → there are two paths → the hard path, made concrete for an owner buying a company: chasing listed deals, a bank that says no because the structure was never bankable, a year gone → the proven path: the order Josh followed (agree the shape with the seller first, then take it to the lender), the 1.5x test before any offer, off-market owners with no successor → the invitation to apply.
G&L fill: Josh bought his clinics in two acquisitions and both sellers financed 100% of the price. That is the only first-person proof. No "students", no other deals.`,
  },
  third_way: {
    label: 'Third Way', sub: 'Two exhausted options, then the little-known third',
    body: `THE THIRD WAY. Destroy the two obvious options, then reveal the third.
Shape: "There are only two ways most owners try to [buy a competitor]..." → way one: raise equity and give up control (months of pitching, a partner in your company) → way two: save the deposit from profit for years, then compete with private equity for listed deals at full price → the failure moment for each → "there's a little-known third way" → without your savings, without giving away control, without a broker auction → the third way: commercial debt lent against the target's own cash flow, plus seller finance, plus seller rollover, passing the 1.5x debt service coverage test → what it takes (the order, the test, an off-market owner).
Build the "without" line as an escalation, never three lines with the same opener.`,
  },
  saturation: {
    label: 'Saturation', sub: 'Everyone is chasing the same listed deals',
    body: `THE SATURATION FRAME. Validate why the old way worked and why it no longer does, then show the escape.
Shape: buying a business is one of the best moves an owner can make (cash flow on day one, a team in place) → so everyone moved in: buyers, search funds, private equity, all bidding on the same listed businesses through the same brokers → a listed seller gets a pile of near-identical offers and you are noise; price climbs and terms harden → the market has moved → the escape: off-market owners with no successor who have never spoken to a broker, approached directly, and a structure the seller helps finance (seller finance and seller rollover alongside commercial debt) → the CTA.
Never invent counts of buyers or offers. Describe the dynamic, not a number.`,
  },
  rich_richer: {
    label: 'Rich Get Richer', sub: 'Two groups of owners, two realities',
    body: `THE RICH GET RICHER FRAME. Two groups living two different realities, then the bridge.
Shape: most owners wake up, run the one business, add revenue by adding their own hours → another, smaller group of owners does something different: they buy competitors, so growth arrives as a whole business with its team and its customers, paid for largely by that business's cash flow (commercial debt plus seller finance plus seller rollover) → they become the buyer instead of the add-on, and a group trades at a higher multiple than a single business (illustrative: 3-5x for one business, 8-12x for a group) → the difference is one mechanism, not talent or capital → the CTA.
Josh is in the second group: founder of JC Health Group, two acquisitions, both 100% seller financed. Use only that.`,
  },
  timeline_failure: {
    label: 'Timeline of Failure', sub: 'Future-pace the moment a first deal breaks',
    body: `THE TIMELINE OF FAILURE. Acknowledge the early wins, then future-pace the predictable point where a first deal falls apart, and the one thing that prevents it.
Shape: "here's what happens to most owners on their first deal" → you find a business you like → you agree a price with the owner → the seller says yes → you take it to the bank → the bank kills it, because the structure was never bankable (it fails the 1.5x debt service coverage test, or the seller was promised all cash) → the reason: the order was wrong. Agree the shape with the seller first, then the lender → what prevents it: the 1.5x test before any offer, and a structure built from commercial debt, seller finance and seller rollover → the CTA.
Speak the timeline as fact about how deals work, never as a story about a named client.`,
  },
  desire_stacking: {
    label: 'Desire Stacking', sub: 'From the deal to who they become',
    body: `DESIRE STACKING. Layer the outcome from surface to identity; each layer adds something the last did not.
Layers: the deal (a competitor bought with the business's own cash flow, seller finance and seller rollover) → the cash flow and the second team that comes with it → the time back (profit that doesn't need more of their hours) → the group exit at a higher multiple (illustrative: 8-12x for a group against 3-5x for one business) → identity: an owner of companies instead of the person the business can't run without.
Each layer gets its own sentence shape. No "you'll finally" twice.`,
  },
  cost_inversion: {
    label: 'Cost Inversion', sub: 'What waiting really costs',
    body: `THE COST INVERSION. Make the cost of doing nothing heavier than the cost of acting.
Shape: name the decision → what not acting costs, built as an escalation: another year of growth that depends on their own hours → the off-market owner with no successor who sells to someone else, possibly a competitor → the ceiling that doesn't move → the group exit that never happens → reframe: one bad first-deal structure costs more than doing it in the right order → the CTA.
Every cost must be real and logical. No fake deadlines, no invented figures.`,
  },
  if_you_could: {
    label: 'If You Could, You Would Have', sub: 'For the owner who thinks they can do it alone',
    body: `IF YOU COULD, YOU WOULD HAVE. Dismantle "I can do this myself" for capable, high-agency owners, with respect.
Shape: if buying the competitor were only a matter of effort, a capable owner like you would have done it already → the reason it hasn't happened has nothing to do with your ability or your work ethic → it has everything to do with two gaps: the structure lenders and sellers say yes to (commercial debt, seller finance, seller rollover, the 1.5x test) and the order (seller first, lender second) → close the gaps and the deal becomes a process → the CTA.
Operator voice: no shaming, no insults.`,
  },
} as const;
export type FrameworkId = keyof typeof FRAMEWORKS;
export const FRAMEWORK_IDS = Object.keys(FRAMEWORKS) as FrameworkId[];
export type FrameworkChoice = FrameworkId | 'auto';

/** Hooks bank: the skill's hook shapes rewritten so every one is true for G&L. */
export const HOOKS_BANK = `HOOKS BANK (shapes to adapt; each one is true as written for G&L)
- Contrast: "Most owners save for years to buy a competitor. The ones building groups let the business pay for itself."
- Contrast: "You don't need savings to buy a business. You need to know what the bank will fund before you make an offer."
- Third way: "There are two ways owners try to buy a business. Both are slow. There's a third."
- Seller psychology: "Sellers don't sell to the highest bidder. They sell to the buyer who makes them feel safe."
- Not-your-fault: "The reason your offer went nowhere had nothing to do with price."
- Agitation: "Banks don't reject buyers. They reject structures."
- First-person proof (true): "I bought my clinics in two acquisitions. Both sellers financed 100% of the price."
- Booking-form proof (true): "Of the last 90 owners who booked a call with us, 39 want to buy companies. 24 have never bought one."
- Specific number (true): "A $5.5 million radiology deal. No personal guarantee. The equipment secured the loan."
- Owner's words (true quote): "One owner wrote to us: stuck at the 5-6m range, need more locations."
Never use the skill's templates that need proof we don't have ("our student [NAME]...", "I own [X] clinics...", "our clients don't spend a dollar", "retired their salary in 9 months").`;

/** The only proof and biography a script may use (from the business brief). */
export const FACTS = `TRUE FACTS (the ONLY biography and proof you may use; never invent others, never embellish these)
- Josh Li runs G&L M&A Advisory and founded JC Health Group, his own healthcare holding company.
- Josh bought his clinics in two acquisitions. In both, the sellers financed 100% of the price.
- 90 owners booked calls with G&L: 63 were under $1M revenue, 39 want to buy companies, 24 had never bought one, 24 wanted help with funding, 23 wanted help structuring debt.
- Real quotes from the booking forms: "stuck at the 5-6m range need more locations"; "I've acquired 10 clinics but some haven't made money"; "I've struggled to find a way to do this in aus with no money down".
- A $5.5M radiology deal needed no personal guarantee: the deal was over $5M and the equipment secured the loan.
THE METHOD (state as fact): buy a competitor with commercial debt + seller finance + seller rollover; the 1.5x debt service coverage test decides what's bankable; off-market owners with no successor; agree the shape with the seller first, then the lender; a group trades at a higher multiple than one business (illustrative 3-5x vs 8-12x); buy through a holding company.
WHO IT'S FOR: owners of businesses doing $1M+ revenue: capable, high-agency, money-motivated. Speak to what they gain (profit without more hours, a business that runs without them, a group exit at a higher multiple, being the buyer instead of the add-on) and the real cost of waiting.`;

export const DEFAULT_CTA = 'Apply through the link below. If it\'s a fit, the team books a strategy call to look at your numbers.';
export const WEBINAR_CTA = 'Register for the live session through the link below.';
export const ctaFor = (format: FormatId, override?: string) => (override?.trim() || (format === 'webinar' ? WEBINAR_CTA : DEFAULT_CTA));

/**
 * Auto-pick: a fixed choice per format, nudged by the ICP, so the same inputs always get the same framework
 * (and the owner sees which one before reading).
 */
export function pickFramework(format: FormatId, icp: IcpId, choice: FrameworkChoice = 'auto'): FrameworkId {
  if (choice !== 'auto' && choice in FRAMEWORKS) return choice;
  if (format === 'short') return icp === 'deployer' ? 'saturation' : icp === 'prisoner' ? 'rich_richer' : 'if_you_could';
  if (format === 'webinar') return 'timeline_failure';
  if (format === 'email') return icp === 'deployer' ? 'cost_inversion' : 'desire_stacking';
  if (format === 'vsl') return icp === 'trapped' ? 'two_paths' : 'third_way';
  // long
  return ({ trapped: 'two_paths', ceiling: 'third_way', deployer: 'saturation', prisoner: 'rich_richer' } as const)[icp];
}

export interface BrainInput { topic: string; context?: string; format: FormatId; icp: IcpId; framework: FrameworkId; cta: string; notes?: string }

/** The system prompt for one script. Includes the chosen framework in full and the house copy system. */
export function scriptSystemPrompt(i: BrainInput): string {
  const f = FORMATS[i.format];
  const fw = FRAMEWORKS[i.framework];
  const layouts = (i.format === 'short' ? (['vertical'] as Layout[]) : LAYOUTS.filter((l) => l !== 'vertical')).map((l) => `- ${l}: ${LAYOUT_GUIDE[l]}`).join('\n');
  return `You write face-cam shooting scripts for Josh Li of G&L M&A Advisory. Josh records his screen with his face on camera in one of six layouts, reading from a teleprompter beat by beat; the recorder switches layout at each beat. Your script is what he reads, what the viewer sees, and the packaging.

FORMAT: ${f.label} (${f.sub}). ${f.spec}
Write ${f.beats[0]} to ${f.beats[1]} beats and ${f.words[0]} to ${f.words[1]} spoken words in total.

THE FACE-CAM LAYOUTS (choose one per beat by what the viewer needs to see):
${layouts}
Face-led layouts (spotlight, orbit) for hooks, story, belief and identity shifts and the close; stage or split only when something on the screen carries the point.

THE VIEWER (ICP): ${ICPS[i.icp].brief}

THE FRAMEWORK FOR THIS SCRIPT (follow its shape; fill every slot with true G&L substance):
${fw.body}

${HOOKS_BANK}

${FACTS}

THE CTA (use this exact ask as the final beat's last line, and as the cta field): "${i.cta}"
Never call the strategy call "free". No fake deadlines, counts or scarcity.

OUTPUT FIELDS
- hooks: exactly 3 different opening lines (15 words max each), each a different hook shape from the bank. hook_index: the strongest (0, 1 or 2).
- beats: in order. beats[0].text opens with the chosen hook word for word. Each beat: layout (one id from the list above), text (word for word what Josh says, one or two sentences per line, lines separated by a newline), cue (a short delivery note for Josh: pace, pause, gesture, where to look), on_screen (the on-screen text for this beat, 2 to 8 words, or empty), screen (what to show on the screen during this beat: the document, the diagram, the page; empty for face-only beats).
- titles: exactly 3 options under 70 characters (mystery or the "what" + a specific benefit + an audience filter).
- thumbnail: 2 to 4 words that add to the title, never repeat it.
- description: the YouTube or post description in plain lines; put {APPLY_LINK} where the link goes; end with "Not legal, tax or financial advice." and, if any number in the script is illustrative, "Numbers shown are illustrative."
- cta: the CTA line above.
Any number that isn't one of the true facts is labelled "illustrative" where it is said and on screen. Whenever funding is described, name seller rollover alongside commercial debt and seller finance.
${i.notes ? `\nSTANDING NOTES FROM JOSH (follow them unless they break a house rule):\n${i.notes}\n` : ''}
${copyBrief('video')}`;
}

export function scriptUserPrompt(i: BrainInput): string {
  return `Write the shooting script.\nTopic: ${i.topic}${i.context ? `\n\nContext from the YouTube idea (use what fits; facts outside the TRUE FACTS list are not proof):\n${i.context}` : ''}\n\nFramework: ${FRAMEWORKS[i.framework].label}. Viewer: ${ICPS[i.icp].label}. Format: ${FORMATS[i.format].label} (${FORMATS[i.format].sub}). Return JSON only.`;
}
