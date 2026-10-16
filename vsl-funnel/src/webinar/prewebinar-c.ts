import type { TemplateCtx } from '../integrations/templates';
import { type PW, type PwOrder, guide, illustrative, seat, session, whenLine } from './prewebinar-kit';

/**
 * Pre-webinar run, block C (days 7–9 of 14): finding and closing the deal, and what it builds.
 * Closing from the 3C model (off-market, direct to owner, NDA and financials, indicative offer,
 * LOI, quality of earnings, the red flags, the transition, the holdco) and the opportunity it
 * opens (multiple arbitrage, the owner's life after). One idea per email; every one points to
 * the session for the full process.
 */

/** Their calendar link when we have one, otherwise their link to the session. */
const cal = (c: TemplateCtx, label: string) => {
  const g = session(c).google;
  return g ? { label, href: g } : seat(c, label);
};
const advice = 'Education only, not legal, tax or financial advice.';

export const PW_C: Record<string, PW> = {
  // ── Day 7: finding the business, and the seller behind it ──
  wp_c_never_list: (c) => ({
    subject: 'the best businesses never hit the market',
    preheader: 'What you see on broker sites is the smaller part of the market.',
    body: [
      `${c.name},`,
      'Most good businesses are never listed for sale.',
      'The owner sells to someone they already know, or to the buyer who wrote to them first, or to a key employee. The deal is done before a broker ever hears about it.',
      'So if your search starts and ends on listing sites, you’re fishing in the part of the pond everyone else has already fished.',
      `In ${session(c).title} I’ll show you where the rest of the market sits, and how owners like you get in front of it first.`,
    ],
    cta: seat(c, 'Save my link →'),
    ps: 'Every deal I care about started with a conversation, not a listing.',
  }),
  wp_c_listed_auction: (c) => ({
    subject: 'a listed business is an auction',
    preheader: 'And auctions are built to get the seller the highest price.',
    body: [
      `${c.name},`,
      'When a business goes to a broker, the broker’s job is simple: get as many buyers as possible bidding against each other.',
      'That’s good for the seller. For you, it means paying the most, on the shortest timeline, with the least room to structure the deal around seller finance and rollover.',
      'Off-market, there is no auction. There is one owner, one buyer and a conversation about what works for both of them.',
    ],
    cta: guide(c, 'find-off-market-businesses-for-sale', 'How off-market deals are found →'),
    ps: whenLine(c),
  }),
  wp_c_direct_letter: (c) => ({
    subject: 'how you reach an owner who isn’t selling',
    preheader: 'Direct to owner. A letter, a call, a reason to talk.',
    body: [
      `${c.name},`,
      'The way in is direct to the owner. A short letter or a call that says who you are, why their business, and that you’d like a confidential conversation.',
      'Most owners won’t reply the first time. Some will, because the thought has been sitting in the back of their mind for years and nobody has ever asked.',
      'That one reply is worth more than a hundred listings, because you’re the only buyer in the room.',
      'I’ll walk through exactly what goes in that first message during the session.',
    ],
    cta: seat(c, 'My link to the session →'),
  }),
  wp_c_your_list: (c) => ({
    subject: 'your target list is already in your head',
    preheader: 'The competitor down the road. The supplier you rely on.',
    body: [
      `${c.name},`,
      'You already know the businesses in your industry better than any broker does.',
      '• The competitor whose owner keeps talking about slowing down.<br>• The supplier you depend on.<br>• The firm in the next town that does what you do.',
      'That knowledge is an advantage outsiders pay for. A lender also reads an operator buying in their own industry as a far easier story than a first-timer.',
      'Write five names down before the session. You’ll know what to do with them by the end of it.',
    ],
    cta: guide(c, 'buy-your-competitor', 'Read: buying your competitor →'),
    ps: 'Keep the list private for now; you’ll see why in the session.',
  }),
  wp_c_safe_not_highest: (c) => ({
    subject: 'sellers don’t sell to the highest bidder',
    preheader: 'They sell to whoever makes them feel safe.',
    body: [
      `${c.name},`,
      'The owner selling a business they spent 25 years building is not running a spreadsheet competition.',
      'They want to know their staff keep their jobs, their customers are looked after, their name stays clean and the money actually arrives. The buyer who answers those fears wins, even when another bid is higher.',
      'That’s why credibility does the work capital does for everyone else. A board, proper advisers and a clear plan make you the safe choice.',
      `I’ll show you how to become that buyer in ${session(c).title}.`,
    ],
    cta: seat(c, 'Hold my place →'),
    ps: 'The highest offer loses more deals than you’d expect, because it rarely comes with a plan.',
  }),
  wp_c_seller_fears: (c) => ({
    subject: 'what keeps a seller up at night',
    preheader: 'It’s rarely the price.',
    body: [
      `${c.name},`,
      'A seller’s real worries sound like this:',
      '• Will my team be treated properly?<br>• Will my customers notice anything went wrong?<br>• Will this buyer actually pay me what they promised?<br>• Will I regret it a year from now?',
      'Answer those four before you ever talk about price, and the price conversation gets much easier.',
    ],
    cta: seat(c, 'Save my link →'),
    ps: 'Sellers remember how a buyer made them feel long after they forget the number.',
  }),
  wp_c_retiring_wave: (c) => ({
    subject: 'the owners who built it are getting older',
    preheader: 'A generation of business owners is heading for the door.',
    body: [
      `${c.name},`,
      'A large share of the profitable small businesses in the US and Australia were built by owners now at or near retirement age.',
      'Many of them have no succession plan. The kids have careers of their own, the staff can’t fund a buyout, and the owner has never sold anything before.',
      'Every one of those owners needs a buyer they can trust. That is the opportunity this whole session is built around.',
    ],
    cta: seat(c, 'My link to the session →'),
    ps: whenLine(c),
  }),
  wp_c_no_successor: (c) => ({
    subject: 'when the kids don’t want the business',
    preheader: 'The quiet problem behind most owner sales.',
    body: [
      `${c.name},`,
      'The owner who built it hoped one of the kids would take over. The kids became engineers and doctors and moved to other cities.',
      'Now the owner has a business that pays well, a team that relies on them and no plan for the day they stop.',
      'You can be the plan. And seller finance plus rollover lets them keep an income and a stake while you take it forward.',
    ],
    cta: guide(c, 'seller-rollover-explained', 'How rollover works for the seller →'),
  }),
  wp_c_two_buyers: (c) => ({
    subject: 'two buyers, one business',
    preheader: 'A hypothetical. The difference is how each one shows up.',
    body: [
      `${c.name}, a hypothetical worth thinking about.`,
      'Two buyers approach the same owner. The first sends a spreadsheet and a cash offer with a two-week deadline. The second sends a short letter, meets the owner twice and arrives with a board, an accountant and a plan for the staff.',
      'The first buyer has more money on paper. The second one gets the deal, on seller finance and rollover, because the owner trusts them with what they built.',
      'Everything in the session is about becoming the second buyer.',
    ],
    cta: seat(c, 'Keep my seat →'),
  }),
  wp_c_first_call: (c) => ({
    subject: 'the first call isn’t about price',
    preheader: 'Talk about the owner first. The numbers come later.',
    body: [
      `${c.name},`,
      'Buyers who lead with price on the first call lose the owner in the first ten minutes.',
      'Ask how they started. Ask what they’re proudest of, and what they want their life to look like after the sale. Then listen.',
      'An owner who feels understood keeps talking, and the deal gets built from what they tell you.',
    ],
    cta: seat(c, 'Save my link →'),
    ps: 'I’ll share the exact order of that first conversation in the session.',
  }),
  wp_c_questions: (c) => ({
    subject: 'what to ask a seller',
    preheader: 'The questions that tell you whether a deal is real.',
    body: [
      `${c.name},`,
      'A handful of questions tell you most of what you need before you spend a dollar on advisers:',
      '• Why are you selling, and why now?<br>• Who runs the business day to day when you’re away?<br>• How much revenue comes from your top three customers?<br>• Would you stay on for a transition, and for how long?<br>• Would you consider carrying part of the price as a note?',
      'The answers sort the real deals from the ones that will waste six months of your life.',
    ],
    cta: guide(c, 'questions-to-ask-a-business-seller', 'The full question list →'),
    ps: 'The last question is the one most buyers never ask, and it changes the whole structure.',
  }),
  wp_c_why_now: (c) => ({
    subject: 'why are you selling now',
    preheader: 'The one question that reveals the most.',
    body: [
      `${c.name},`,
      'Of every question you ask a seller, “why now” tells you the most.',
      'Retirement, health or a move is a clean answer. A vague answer, or one that changes between meetings, is a signal to look much harder at the numbers.',
    ],
    cta: seat(c, 'My link to the session →'),
  }),
  wp_c_credibility: (c) => ({
    subject: 'credibility closes what cash can’t',
    preheader: 'Why a board and proper advisers win you the deal.',
    body: [
      `${c.name},`,
      'When you write to an owner with a board behind you (a chair, a finance lead, a legal lead and someone who has operated in the sector), you stop being a stranger with an offer.',
      'You become an organisation the owner can trust with their staff and their name. Add a top accountant and an M&A lawyer, and the seller’s own advisers relax too.',
      'That institutional credibility is what stands in for personal capital, and it’s the first C of the model.',
    ],
    cta: seat(c, 'Save my link →'),
    ps: 'The session covers who sits on that board and how to recruit them.',
  }),
  wp_c_five_names: (c) => ({
    subject: 'five names before tonight',
    preheader: 'A two-minute job that makes the session ten times more useful.',
    body: [
      `${c.name},`,
      'Before you go to bed tonight, write down five businesses you would buy if the money weren’t the question.',
      'You’ll use that list in the session.',
    ],
    cta: seat(c, 'Keep my link handy →'),
  }),
  wp_c_who_buys_first: (c) => ({
    subject: 'someone is going to buy that business',
    preheader: 'The only question is whether it’s you or your competitor.',
    body: [
      `${c.name},`,
      'The owner you’ve been watching will sell one day. That part isn’t up to you.',
      'What is up to you is who they sell to. If it’s your competitor, you face a bigger rival with your old neighbour’s customers. If it’s you, those customers become yours.',
      'Waiting another year rarely makes the decision for you in your favour.',
    ],
    cta: seat(c, 'Make sure I’m there →'),
    ps: whenLine(c),
  }),

  // ── Day 8: the process, from NDA to due diligence ──
  wp_c_nda: (c) => ({
    subject: 'the NDA is where it gets real',
    preheader: 'An NDA and three years of financials sort serious from curious.',
    body: [
      `${c.name},`,
      'Once an owner is willing to talk, the next step is an NDA and three years of financials.',
      'The NDA protects them, which makes them comfortable sharing. The financials tell you whether the business is worth your time before anyone spends money on advisers.',
      'An owner who won’t share three years of numbers under an NDA has told you something important already.',
    ],
    cta: seat(c, 'Save my link →'),
    ps: 'In the session I’ll show you what to look at first when those numbers arrive.',
  }),
  wp_c_three_years: (c) => ({
    subject: 'why one good year proves nothing',
    preheader: 'Three years of financials show you the trend.',
    body: [
      `${c.name},`,
      'Any business can have one great year. A big contract lands, a competitor closes, prices spike for a season.',
      'Three years shows you the shape. Is profit steady, climbing or sliding, and does the story the owner tells match the line on the page?',
      'Lenders read it the same way, which is why the trend matters as much to your funding as it does to your judgement.',
    ],
    cta: guide(c, 'dscr-explained', 'How lenders read the numbers →'),
  }),
  wp_c_indicative: (c) => ({
    subject: 'the indicative offer, explained',
    preheader: 'A short document that sets the shape of the whole deal.',
    body: [
      `${c.name},`,
      'Once the numbers look right, you send an indicative offer. A short letter with the price range, the structure and how you plan to fund it.',
      'The skill is front-loading the economics. You make it clear early that part of the price is a seller note and part is a stake the owner keeps, alongside commercial debt from a lender, so there are no surprises later.',
      'Owners who see the structure early and agree to it don’t walk away at the last minute.',
    ],
    cta: seat(c, 'My link to the session →'),
    ps: 'I’ll show you how that letter is worded in the session.',
  }),
  wp_c_loi: (c) => ({
    subject: 'what goes in a letter of intent',
    preheader: 'The LOI turns a conversation into a deal you can fund.',
    body: [
      `${c.name},`,
      'After the indicative offer comes the LOI, the letter of intent. It sets out the price, the funding structure, the transition period, exclusivity and the timeline for due diligence.',
      'It’s the document your lender, your lawyer and your accountant all work from. Get it right and everything after it moves faster.',
      advice,
    ],
    cta: guide(c, 'letter-of-intent-buying-a-business', 'Read the LOI guide →'),
    ps: 'Exclusivity in the LOI is what stops the owner shopping your offer to someone else.',
  }),
  wp_c_loi_binding: (c) => ({
    subject: 'which parts of an LOI bind you',
    preheader: 'Most of it is a statement of intent. A few clauses are not.',
    body: [
      `${c.name},`,
      'Most of an LOI is generally non-binding. It records what both sides intend while due diligence happens.',
      'A few clauses are written to bind, typically confidentiality and exclusivity. Know which is which before you sign, and have your lawyer draft it.',
      advice,
    ],
    cta: seat(c, 'Save my link →'),
  }),
  wp_c_qoe: (c) => ({
    subject: 'quality of earnings is the whole game',
    preheader: 'Due diligence asks one question: is the profit real?',
    body: [
      `${c.name},`,
      'Due diligence covers contracts, leases, staff and legal matters. At its centre is one question: is the profit real, and will it still be there after the owner leaves?',
      'That’s what a quality of earnings review answers. A good accountant rebuilds the profit from the bank statements up, strips out anything one-off and tells you what the business actually earns.',
      'Your lender sizes the debt on that number, so it decides everything.',
    ],
    cta: guide(c, 'due-diligence-red-flags', 'What diligence looks for →'),
    ps: 'I’ll walk through a diligence checklist step by step in the session.',
  }),
  wp_c_addbacks: (c) => ({
    subject: 'the owner’s car is in the profit line',
    preheader: 'Add-backs, and why they need checking.',
    body: [
      `${c.name},`,
      'Small business accounts carry the owner’s life inside them. The car, the phone, a family member on the payroll, a trip that was half holiday.',
      'Some of that is fair to add back to profit, because it leaves with the owner. Some of it is real cost dressed up as a perk.',
      'Your accountant’s job is to tell the two apart. The difference between them can move the price a long way.',
    ],
    cta: seat(c, 'My link to the session →'),
  }),
  wp_c_tax_returns: (c) => ({
    subject: 'when the books don’t match the tax return',
    preheader: 'Red flag number one. You walk.',
    body: [
      `${c.name},`,
      'The first red flag is simple. The financials the owner shows you don’t match the tax returns they filed.',
      'Either the books are inflated to get a better price, or the tax returns understate income. A lender won’t fund profit that was never reported, and you shouldn’t either.',
      'You don’t negotiate around this one. You thank the owner and walk.',
    ],
    cta: guide(c, 'due-diligence-red-flags', 'All the red flags →'),
    ps: 'Walking from a bad deal is a skill, and it’s the one that protects you most.',
  }),
  wp_c_concentration: (c) => ({
    subject: 'one customer can sink the deal',
    preheader: 'Customer concentration, the quiet risk.',
    body: [
      `${c.name},`,
      'A business where one customer brings in a large slice of revenue is a business with a single point of failure.',
      'Lose that customer after you buy, and the profit that pays the debt goes with them. Lenders know this, and they price it in or decline.',
      'Ask about the top three customers early. If the answer worries you, the structure has to protect you, or you walk.',
    ],
    cta: seat(c, 'Save my link →'),
  }),
  wp_c_wont_stay: (c) => ({
    subject: 'a seller who won’t stay is telling you something',
    preheader: 'The transition is part of the price.',
    body: [
      `${c.name},`,
      'Ask the owner if they’ll stay on for a handover period. Watch how they answer.',
      'An owner who wants to hand over the keys on settlement day and disappear is either exhausted or knows something you don’t. Both are a problem.',
      'The owners worth buying from want to see the business land well, and they’ll stay to make sure it does.',
    ],
    cta: seat(c, 'Keep my seat →'),
    ps: 'Seller finance and rollover give them a reason to care how it goes after the sale.',
  }),
  wp_c_profit_leaves: (c) => ({
    subject: 'profit that walks out with the owner',
    preheader: 'When the relationships live in one person’s phone.',
    body: [
      `${c.name},`,
      'Some businesses make good money because of one person. Every big client is a personal friend of the owner, every supplier deal was done on a handshake.',
      'Buy that business and the profit leaves when the owner does. What you paid for was a job, not a company.',
      'Diligence checks whether the business runs without them. If it can’t, and the owner won’t transition the relationships, you walk.',
    ],
    cta: guide(c, 'due-diligence-red-flags', 'Read the red flags guide →'),
  }),
  wp_c_walk_away: (c) => ({
    subject: 'the deals you don’t do',
    preheader: 'Walking away is part of the model, not a failure of it.',
    body: [
      `${c.name},`,
      'The buyers who build groups walk away from far more deals than they close.',
      'Books that don’t match tax returns, heavy customer concentration, a seller who won’t transition, profit that leaves with the owner. Any one of those, and the deal is off.',
      'Banks don’t reject buyers, they reject structures. A deal that fails the test is one you’re lucky to lose.',
    ],
    cta: seat(c, 'My link to the session →'),
    ps: 'The session shows you the test every deal has to pass, so you can apply it yourself.',
  }),
  wp_c_advisers: (c) => ({
    subject: 'who you want on your side of the table',
    preheader: 'A good accountant and an M&A lawyer pay for themselves.',
    body: [
      `${c.name},`,
      'Two advisers make or break a first acquisition. An accountant who has run quality of earnings reviews before, and a lawyer who writes M&A contracts for a living.',
      'They catch what you don’t know to look for, and their names on your side tell the seller you’re serious. Tight contracts at the end protect everything you negotiated at the start.',
      'Their fees can be built into the funding through a working-capital line, alongside commercial debt, seller finance and rollover.',
    ],
    cta: seat(c, 'Save my link →'),
  }),
  wp_c_short_test: (c) => ({
    subject: 'one test decides the deal',
    preheader: 'A short note on debt cover.',
    body: [
      `${c.name},`,
      'Before you fall in love with a business, check whether its profit covers all the debt repayments about 1.5 times.',
      'If it doesn’t, the structure has to change or the deal goes.',
    ],
    cta: guide(c, 'dscr-explained', 'How the 1.5x test works →'),
  }),
  wp_c_not_your_fault: (c) => ({
    subject: 'nobody teaches owners how to buy',
    preheader: 'If the process feels unfamiliar, there’s a reason.',
    body: [
      `${c.name},`,
      'You learned how to sell, hire, price and deliver because running your business forced you to. Nobody ever forced you to learn how to buy one.',
      'That has nothing to do with ability. It has everything to do with the fact that acquisition is taught in private equity firms and corporate development teams, not in owner circles.',
      'The process is learnable, and it’s the same steps every time. The session lays them out in order.',
    ],
    cta: seat(c, 'Show me the process →'),
    ps: whenLine(c),
  }),

  // ── Day 9: after the deal, and what it builds ──
  wp_c_transition: (c) => ({
    subject: 'keep the seller in the building',
    preheader: 'The transition is where most value is kept or lost.',
    body: [
      `${c.name},`,
      'The day you settle is not the day the owner leaves. A good deal keeps them involved through a handover, introducing you to clients, staff and suppliers one relationship at a time.',
      'Seller finance and rollover make that natural. The seller is still being paid from the business and still owns a slice of it, so they want it to do well under you.',
      'That alignment is worth more than any clause in the contract.',
    ],
    cta: guide(c, 'seller-finance-explained', 'Why seller finance keeps them in →'),
    ps: 'In the session I’ll show how the transition is written into the deal.',
  }),
  wp_c_first_months: (c) => ({
    subject: 'what not to change in the first months',
    preheader: 'The urge to fix everything costs more than it saves.',
    body: [
      `${c.name},`,
      'New owners want to change everything in the first month. New systems, new pricing, new branding.',
      'Staff and customers are watching for exactly that. Keep the business steady first, learn how it actually runs with the seller beside you, then improve one thing at a time.',
    ],
    cta: seat(c, 'Save my link →'),
  }),
  wp_c_holdco: (c) => ({
    subject: 'buy through a company, not in your own name',
    preheader: 'Why a holdco sits on top of every deal.',
    body: [
      `${c.name},`,
      'Every acquisition is made through a holding company, with a separate entity for each business you buy.',
      'That keeps each deal’s debt and risk with that deal, and gives you one clean structure to grow a group under. It also looks to a seller and a lender like what it is, a buyer building something serious.',
      `We’ll cover the structure in ${session(c).title}. ${advice}`,
    ],
    cta: seat(c, 'My link to the session →'),
  }),
  wp_c_ringfence: (c) => ({
    subject: 'when one business has a bad year',
    preheader: 'Separate entities keep a problem where it started.',
    body: [
      `${c.name},`,
      'Every business has a bad year eventually. In a group held through one entity, that year can drag the others down with it.',
      'With a holdco and a separate company per acquisition, a problem in one business stays in that business. Your other companies, and your own assets, sit apart from it.',
      advice,
    ],
    cta: seat(c, 'Save my link →'),
  }),
  wp_c_multiple_gap: (c) => ({
    subject: 'the gap between 4x and 10x',
    preheader: 'Why a group is worth more than its parts.',
    body: [
      `${c.name},`,
      'Small businesses trade at roughly 3 to 5 times EBITDA. Groups of them, with a team and systems, trade at 8 to 12 times.',
      'Buy three businesses each making $500k at 4x and you’ve paid $6M for $1.5M of profit. Valued as a group at 9x, that same $1.5M is worth $13.5M.',
      'Same profit, valued as a platform. That gap is the reason owners build groups.',
      illustrative,
    ],
    cta: seat(c, 'Show me how groups are built →'),
    ps: 'The session shows how the first deal is funded from the business’s own cash flow, with commercial debt, seller finance and rollover.',
  }),
  wp_c_same_dollar: (c) => ({
    subject: 'the same dollar of profit, valued twice',
    preheader: 'Buyers pay for size and reliability.',
    body: [
      `${c.name},`,
      'A buyer of a small business pays for a job with a profit attached. A buyer of a group pays for a machine with a team, systems and several income streams.',
      'The second is less risky to own, so it earns a higher multiple. You’re buying at the small business price and building toward the group price.',
      illustrative,
    ],
    cta: seat(c, 'Hold my place →'),
  }),
  wp_c_second_deal: (c) => ({
    subject: 'the second deal is easier than the first',
    preheader: 'The process repeats, and you bring a track record.',
    body: [
      `${c.name},`,
      'The first acquisition teaches you the steps: the outreach, the NDA, the offer, the LOI, the diligence and the handover.',
      'By the second one you have a holdco, a board, advisers who know you and a lender who has seen you perform. Sellers see a group, not a first-timer.',
      'That’s when it stops being a deal and starts being a strategy.',
    ],
    cta: seat(c, 'My link to the session →'),
    ps: whenLine(c),
  }),
  wp_c_time_back: (c) => ({
    subject: 'what you do with the time back',
    preheader: 'The real return on owning companies.',
    body: [
      `${c.name},`,
      'Most owners I talk to aren’t short of income. They’re short of time, because the business still runs through them.',
      'When you own companies with managers running them, your week changes. You set direction, read the numbers and decide where the next deal comes from.',
      'The rest of the week is yours again, for your family and for the things you postponed.',
    ],
    cta: seat(c, 'Save my link →'),
  }),
  wp_c_team_runs_it: (c) => ({
    subject: 'a team that runs it without you',
    preheader: 'Acquisitions force the step most owners avoid.',
    body: [
      `${c.name},`,
      'You can’t personally run three businesses. That’s the point.',
      'Buying your second company forces you to build a management layer, which is the step most owners never take on their own. A general manager in each business, a finance lead across the group, you above them.',
      'The business that used to need you every day becomes one company in a group that doesn’t.',
    ],
    cta: seat(c, 'My link to the session →'),
    ps: 'The fear of running more than one is answered by not running any of them alone.',
  }),
  wp_c_owner_of_companies: (c) => ({
    subject: 'owner of companies, not a job',
    preheader: 'The identity shift underneath every deal.',
    body: [
      `${c.name},`,
      'Running a business and owning companies are two different jobs.',
      'The first one has you in the work, solving today’s problem. The second has you above the work, deciding which businesses to own and who runs them.',
      'You already have what the second role needs. You’ve built something profitable and you understand how a business makes money. The session is about using that.',
    ],
    cta: seat(c, 'I’ll be there →'),
  }),
  wp_c_stack: (c) => ({
    subject: 'what the first deal actually buys you',
    preheader: 'More than a business. Here’s the stack.',
    body: [
      `${c.name},`,
      'The first acquisition gets you a second business, funded by its own cash flow through commercial debt, seller finance and seller rollover.',
      'That business brings profit that pays its own debt and then pays you. Once a team runs it, you get your time back. Keep going, and you stop being a business owner with a job and become an owner of companies.',
      `Every layer of that starts with the first deal, and the first deal starts at ${session(c).title}.`,
    ],
    cta: cal(c, 'Put it in my calendar →'),
    ps: whenLine(c),
  }),
  wp_c_josh_clinics: (c) => ({
    subject: 'how I bought my own clinics',
    preheader: '100% vendor finance, through a holding group.',
    body: [
      `${c.name},`,
      'I run my own healthcare holding group. I bought the clinics in it with 100% vendor finance, which means the sellers carried the price and were paid out of the clinics’ own cash flow.',
      'That only happened because the sellers trusted the structure and trusted who they were selling to. Everything I’ll teach in the session is the process that made it possible.',
    ],
    cta: guide(c, '100-percent-vendor-finance', 'How 100% vendor finance works →'),
    ps: 'Your structure will be its own, built on the target’s numbers, with commercial debt and rollover where they fit.',
  }),
  wp_c_thirty_days: (c) => ({
    subject: 'thirty days from now',
    preheader: 'The only difference will be the decision.',
    body: [
      `${c.name},`,
      'Thirty days from now you’ll be thirty days older either way. The business you want will still be out there, or someone else will be talking to its owner.',
      'The only difference between those two versions of next month is whether you show up and learn the process.',
    ],
    cta: seat(c, 'Keep my seat →'),
  }),
  wp_c_full_process: (c) => ({
    subject: 'the whole process, start to finish',
    preheader: 'From the first letter to the handover, in one session.',
    body: [
      `${c.name},`,
      'Over the last three days I’ve sent you pieces of the closing process. Finding the owner, the NDA, the offer, the LOI, diligence, the red flags, the transition and the holdco.',
      `${session(c).title} puts them in order, with the funding (commercial debt, seller finance and seller rollover) attached to each step. You’ll leave knowing exactly what happens next.`,
      `It’s on ${session(c).when}. Put it in your calendar now so nothing else takes the slot.`,
    ],
    cta: cal(c, 'Add it to my calendar →'),
    ps: `If you can’t make it live, the replay stays up for ${session(c).replayHours} hours, though live is where you can ask questions.`,
  }),
  wp_c_bring_one: (c) => ({
    subject: 'bring one business with you',
    preheader: 'Have a real target in mind when we start.',
    body: [
      `${c.name},`,
      'Come to the session with one real business in mind.',
      'Every step I walk through will land harder when you can picture it on a company you know.',
    ],
    cta: seat(c, 'My link to the session →'),
  }),
};

export const PW_C_ORDER: PwOrder = [
  // Day 7
  ['wp_c_never_list', 1],
  ['wp_c_listed_auction', 2],
  ['wp_c_direct_letter', 2],
  ['wp_c_your_list', 2],
  ['wp_c_safe_not_highest', 1],
  ['wp_c_seller_fears', 2],
  ['wp_c_retiring_wave', 1],
  ['wp_c_no_successor', 2],
  ['wp_c_two_buyers', 3],
  ['wp_c_first_call', 2],
  ['wp_c_questions', 1],
  ['wp_c_why_now', 3],
  ['wp_c_credibility', 3],
  ['wp_c_five_names', 3],
  ['wp_c_who_buys_first', 2],
  // Day 8
  ['wp_c_nda', 1],
  ['wp_c_three_years', 2],
  ['wp_c_indicative', 1],
  ['wp_c_loi', 1],
  ['wp_c_loi_binding', 3],
  ['wp_c_qoe', 1],
  ['wp_c_addbacks', 2],
  ['wp_c_tax_returns', 2],
  ['wp_c_concentration', 2],
  ['wp_c_wont_stay', 2],
  ['wp_c_profit_leaves', 2],
  ['wp_c_walk_away', 2],
  ['wp_c_advisers', 3],
  ['wp_c_short_test', 3],
  ['wp_c_not_your_fault', 2],
  // Day 9
  ['wp_c_transition', 1],
  ['wp_c_first_months', 3],
  ['wp_c_holdco', 1],
  ['wp_c_ringfence', 3],
  ['wp_c_multiple_gap', 1],
  ['wp_c_same_dollar', 2],
  ['wp_c_second_deal', 2],
  ['wp_c_time_back', 2],
  ['wp_c_team_runs_it', 2],
  ['wp_c_owner_of_companies', 2],
  ['wp_c_stack', 1],
  ['wp_c_josh_clinics', 2],
  ['wp_c_thirty_days', 3],
  ['wp_c_full_process', 1],
  ['wp_c_bring_one', 3],
];
