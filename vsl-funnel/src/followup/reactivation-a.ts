import type { EmailContent, TemplateCtx } from '../integrations/templates';
import { type Dossier, TIMELINES, industryName, profitText, yourBiz } from './dossier';

/**
 * Reactivation batch A (days 4–13 of the 30-day run, three a day):
 * how it actually works. One mechanism per email, made concrete, written
 * in Josh's plain letter voice. Every email reads naturally when any
 * dossier field is missing; where we know their industry, size, goal or
 * blockers, the copy says it back to them.
 *
 * Rules kept throughout: any numbers are illustrative and say so; funding
 * always names seller rollover alongside debt and seller finance; no
 * promised outcomes, no invented urgency, no fabricated results.
 */
type T = (c: TemplateCtx, d: Dossier) => EmailContent;

const book = (c: TemplateCtx) => c.link(c.bookingUrl ? '/book' : '/breakout');
const sizeLine = (d: Dossier) => (d.revenueLabel ? `a business doing ${d.revenueLabel.replace(/^Under /, 'under ')} in revenue` : null);
const has = (d: Dossier, blocker: string) => d.blockers.includes(blocker);
const BIG_REVENUE = ['10_25m', '25_50m', '50_100m', 'gt100m', 'gt10m'];
const illustrative = 'Illustrative numbers only. Every deal is structured on its own figures, and none of this is financial advice.';

export const REACTIVATE_A: Record<string, T> = {
  // ── Day 4: the three sources of money ──
  ra_lender_reads: (c, d) => ({
    subject: 'what a lender actually reads',
    preheader: 'It isn’t your savings. It’s the target’s cash flow.',
    body: [
      `${c.name}, most owners picture a bank manager asking what they own. For an acquisition, the questions are different.`,
      'A lender funding a purchase reads, roughly in this order:',
      '• <strong>The target’s cash flow.</strong> Lenders ask for three years of financials where they exist, and look at whether the profit is steady or lumpy.<br>• <strong>Debt cover.</strong> Whether that profit covers all the repayments about 1.5 times.<br>• <strong>The buyer.</strong> Whether the person taking over can actually run it.<br>• <strong>The rest of the stack.</strong> How much the seller is carrying as a note and rolling into a stake. A seller who stays in is a seller who believes in the business.',
      d.industry
        ? `That third point is where ${d.industry.owners} have an edge. You already run a ${d.industry.one}${sizeLine(d) ? `, ${sizeLine(d)}` : ''}. To a lender, an operator from the same industry is a much easier story than a first-timer with a spreadsheet.`
        : `That third point is where you have an edge. You already run ${sizeLine(d) ?? 'a profitable business'}. To a lender, an experienced operator is a much easier story than a first-timer with a spreadsheet.`,
      'Notice what isn’t at the top of the list: your savings. The deal is mostly assessed on the business being bought, with commercial debt, seller finance and seller rollover doing the funding.',
    ],
    cta: { label: 'How lenders test a deal →', href: c.link('/guides/dscr-explained') },
  }),
  ra_seller_mortgage: (c, d) => ({
    subject: 'a mortgage the seller holds',
    preheader: 'Seller finance, explained the simple way.',
    body: [
      `${c.name}, seller finance sounds technical. It isn’t. Think of it as a mortgage, except the seller is the bank.`,
      'When you buy a house, the bank pays the seller and you pay the bank back over years. With seller finance, part of the price simply isn’t paid on day one. The seller agrees to be paid it over a few years, with interest, out of the business’s own cash flow.',
      'Why would they? It can get them a better price and a steady income after they step away, and it shows the lender they believe the business will keep performing. The seller note normally sits behind the bank’s loan, which is part of why lenders like seeing one.',
      'In a typical stack it sits alongside commercial debt and seller rollover, where the owner keeps a stake. Together the three can cover the whole price.',
      d.industry
        ? `In ${industryName(d.industry)}, plenty of owners getting close to retirement like this arrangement: they want an income, not just a lump sum, and they want to see the ${d.industry.one} they built carried on properly.`
        : null,
    ].filter(Boolean) as string[],
    cta: { label: 'Read the seller finance guide →', href: c.link('/guides/seller-finance-explained') },
  }),
  ra_why_stay_in: (c) => ({
    subject: 'why would a seller stay in?',
    preheader: 'Seller rollover, from the seller’s side of the table.',
    body: [
      `${c.name}, the question I get most about seller rollover: why would an owner sell and still keep a stake?`,
      'Put yourself in their shoes. They’ve spent 20 or 30 years building it, and selling 100% for cash is final.',
      'Rolling part of the value into a stake they keep (somewhere between 10% and 40% in the structures we see) means:',
      '• They take most of the value off the table now.<br>• They keep some upside if the business grows under new ownership.<br>• They get a real say in who carries on what they built.',
      'For an owner who doesn’t need every dollar on day one, that can beat a bigger cheque from a stranger. And for you, every dollar they roll is a dollar of the price you don’t have to fund. It sits in the stack alongside commercial debt and seller finance.',
      'It works best when they genuinely believe in you. Which is why it starts with a proper conversation, not a lowball email.',
    ],
    cta: { label: 'Read the rollover guide →', href: c.link('/guides/seller-rollover-explained') },
  }),

  // ── Day 5: cash, honesty, and who repays what ──
  ra_working_capital: (c, d) => ({
    subject: 'the line nobody mentions',
    preheader: 'Why the funding can come to more than the price.',
    body: [
      `${c.name}, here’s the part of a deal that surprises most owners: the funding can come to more than the price.`,
      'A business needs cash to run. Wages go out before invoices come in, and stock gets bought before it gets sold.',
      'When you buy one, you need that buffer too. That’s what a working-capital line is for.',
      'In many acquisitions the lender adds a working-capital facility on top of the purchase debt. So the stack looks like this: commercial debt for most of the price, seller finance for part of it, seller rollover for the stake the owner keeps, and a working-capital line beside it so the business isn’t short of cash in its first months under you.',
      'That’s what people mean by an over-financed deal. It isn’t free money. It’s a facility that has to be serviced, and it only makes sense if the numbers still clear about 1.5 times debt cover with it included.',
      d.industry
        ? `For a ${d.industry.one}, the question is how long the gap is between doing the work and getting paid. That gap decides how big the line needs to be.`
        : 'For any business, the question is how long the gap is between doing the work and getting paid. That gap decides how big the line needs to be.',
    ],
    cta: { label: 'How over-financing works →', href: c.link('/guides/over-financed-acquisition') },
  }),
  ra_no_money_honest: (c, d) => ({
    subject: 'what “no money down” doesn’t mean',
    preheader: 'The honest version, both sides of it.',
    body: [
      `${c.name}, “no money down” gets thrown around a lot, so here’s the honest version.`,
      '<strong>What it means:</strong> the purchase price is funded by commercial debt, seller finance and seller rollover, secured against the business being bought, so none of your own cash goes into the price.',
      '<strong>What it doesn’t mean:</strong><br>• That there are no costs. Legal, accounting and due diligence cost money, and you should plan for them.<br>• That there’s no risk. The repayments are real. If the business underperforms, the debt still has to be paid.<br>• That any business will do. Plenty of deals don’t clear the test of profit covering repayments about 1.5 times, and those should be walked away from.',
      'That’s why we start with the numbers, not the excitement. A deal that works on paper first is one worth chasing.',
      profitText(d) ? `With profit ${profitText(d)} in ${yourBiz(d)}, the question isn’t whether this is possible in principle. It’s which target fits and whether its numbers hold up.` : null,
    ].filter(Boolean) as string[],
    cta: { label: 'Read the full guide →', href: c.link('/guides/how-to-buy-a-business-with-no-money-down') },
  }),
  ra_who_repays: (c, d) => ({
    subject: 'who pays the loan back',
    preheader: 'Follow the money after settlement.',
    body: [
      `${c.name}, a simple question that clears up a lot: once you own the business, where do the repayments come from?`,
      'From the business you bought. Its customers pay it, it pays its staff and its costs, and what’s left services the commercial debt and the seller note. The seller rollover isn’t a loan, so there’s nothing to repay on it: the seller is rewarded through their share of profits or a future sale.',
      'That’s why the 1.5 times test matters. If the target makes $1.50 for every $1 of repayments, there’s a buffer for a slow month.',
      `It also means the deal should stand on its own. If it only works by draining ${yourBiz(d)}, it isn’t a good deal.`,
      'If you’ve got a business in mind and want a gut check on whether its profit could carry a deal, reply with the rough numbers. I’ll give you my honest take.',
    ],
  }),

  // ── Day 6: the test, the buffer, and a question ──
  ra_dscr_worked: (c, d) => ({
    subject: '1.5, worked through',
    preheader: 'An illustrative deal, line by line.',
    body: [
      `${c.name}, I keep saying “about 1.5 times debt cover”. Here it is on an illustrative deal, so you can see what it means.`,
      '<strong>The target:</strong> makes $400k a year in profit, after paying someone to do the owner’s job. Price: $1.2M, or 3 times profit.',
      '<strong>The funding (70/20/10):</strong><br>• Commercial debt: $840k over 7 years at 9%, roughly $167k a year in repayments.<br>• Seller finance: $240k over 4 years at 6%, roughly $69k a year.<br>• Seller rollover: $120k, kept by the seller as a 10% stake. No repayments.',
      '<strong>The test:</strong> $167k + $69k is roughly $236k a year of repayments. $400k ÷ $236k is about 1.7. That clears 1.5, so it’s worth taking further.',
      'If profit were $300k instead, cover drops to about 1.3. Then you’d look at stretching the seller note, increasing the rollover or lowering the price. Or you’d walk away.',
      d.deal ? `For ${yourBiz(d)}, a sensible first target makes somewhere around ${d.deal.targetProfit} in profit. The same maths applies, scaled up or down.` : null,
    ].filter(Boolean) as string[],
    cta: { label: 'Read the DSCR guide →', href: c.link('/guides/dscr-explained') },
    ps: illustrative,
  }),
  ra_numbers_dip: (c, d) => ({
    subject: 'if the numbers dip',
    preheader: 'What happens when a bought business has a bad year.',
    body: [
      `${c.name}, a fair question most people don’t ask out loud: what happens if the business you buy has a bad year?`,
      'This is what the buffer is for. At 1.5 times debt cover, profit can fall by about a third before it stops covering the repayments.',
      'That isn’t a promise of safety. It’s room to react.',
      'The structure helps too. Lenders ask for the seller note to sit behind the bank, and some notes are written so payments can pause if the business misses agreed targets. The seller rollover has no repayments at all, and a seller who kept a stake has every reason to help fix a problem rather than walk away from it.',
      'The working-capital line is there for cash gaps, not for propping up a business that doesn’t make money.',
      has(d, 'funding') ? 'You told us funding and structure was what was in the way. This is the part of the structure that does the most to protect you.' : null,
      'None of it makes risk disappear. It means you go in with a margin, a plan and a seller on your side.',
    ].filter(Boolean) as string[],
    cta: { label: 'Talk through the risks →', href: book(c) },
  }),
  ra_fuzzy: (c, d) => ({
    subject: 'which part is fuzzy?',
    preheader: 'One question. Reply in a line.',
    body: [
      `${c.name},`,
      'I’ve sent a few emails now on how the mechanics work: lenders, seller finance, seller rollover, the 1.5 times test.',
      'Which part still feels fuzzy? Reply in a line, even just “the seller bit” or “the bank bit”, and I’ll answer it properly.',
      d.industry ? `If it’s a question that’s specific to ${industryName(d.industry)}, even better.` : null,
      'No question is too basic. Most owners have never bought a business, because nobody teaches it.',
    ].filter(Boolean) as string[],
  }),

  // ── Day 7: price ──
  ra_price_set: (c, d) => ({
    subject: 'how a price gets set',
    preheader: 'A multiple of profit, and what moves it.',
    body: [
      `${c.name}, here’s how most private businesses are priced: a multiple of profit.`,
      'The profit is the owner’s real earnings from the business, cleaned up for one-offs. The multiple is what a buyer pays for each dollar of it. For smaller private businesses a range of around 2 to 5 times is common, and it varies a lot by industry and by business.',
      '<strong>What pushes the multiple up:</strong> steady, recurring revenue and a team that runs without the owner. Lots of customers rather than a few big ones, and clean books.',
      '<strong>What pushes it down:</strong> the owner is the business, or one customer is 40% of sales. Revenue swings year to year, and nobody can explain the numbers.',
      d.industry
        ? `In ${industryName(d.industry)}, one of the biggest swing factors is how much depends on the owner personally. And many of the things that lower the price are things you, as one of the ${d.industry.owners} already in the market, are well placed to fix.`
        : 'The useful bit: many of the things that lower the price are things an operator in the same industry is well placed to fix.',
    ],
    cta: { label: 'Talk about a target’s price →', href: book(c) },
    ps: 'Ranges are illustrative. Every business is valued on its own figures, and none of this is financial advice.',
  }),
  ra_real_profit: (c, d) => ({
    subject: 'profit on paper vs real profit',
    preheader: 'Add-backs, and why they decide the price.',
    body: [
      `${c.name}, when you look at a business to buy, the profit on its tax return is rarely the number the deal is priced on.`,
      'Owners run things through their businesses: a salary set higher or lower than the market, the one-off legal bill, the car, the family member on the payroll.',
      'Adjusting for those is called normalising, and what you get is the profit a new owner would actually earn.',
      'Two things to watch. First, add-backs have to be real and provable, not wishful.',
      'Second, if the owner works in the business, take off what it would cost to pay someone to do their job. A business showing $300k with the owner working 60 hours a week isn’t a $300k business to a buyer who won’t do those hours.',
      profitText(d) ? `You know this from the inside. You told us profit in ${yourBiz(d)} is ${profitText(d)}, and you know exactly what goes into that number and what doesn’t.` : null,
      'Get this number right and the price, the debt cover and the structure all follow from it. Get it wrong and everything built on it is wrong.',
    ].filter(Boolean) as string[],
    ps: 'The figures above are illustrative, not financial advice.',
  }),
  ra_owner_is_business: (c, d) => ({
    subject: 'if the owner is the business',
    preheader: 'The biggest risk in a smaller acquisition, and how it’s handled.',
    body: [
      `${c.name}, the biggest risk in buying a smaller business: the owner is the business.`,
      'They hold the key relationships and quote every job, and staff go to them with every question.',
      'When they leave, some of that can walk out with them.',
      'You don’t have to avoid these businesses. You price and structure for it:',
      '• A handover period where the seller stays on for months, introducing you to customers and staff.<br>• Part of the price as seller finance or an earn-out, so the seller does better when the business holds up.<br>• Seller rollover, so they keep a stake and keep caring.<br>• A lower multiple, because you’re taking on the work of building the team.',
      d.industry
        ? `This is also where you have an edge as one of the ${d.industry.owners} who could buy it: you can step into that seat in a way an outside investor can’t.`
        : 'This is also where an operator has the edge over an outside investor: you can step into that seat in a way they can’t.',
    ],
    cta: { label: 'Book a strategy call →', href: book(c) },
  }),

  // ── Day 8: the seller and the first conversations ──
  ra_seller_wants: (c, d) => ({
    subject: 'what sellers actually want',
    preheader: 'Rarely just the highest number.',
    body: [
      `${c.name}, most first-time buyers think a seller wants one thing: the biggest cheque. Talk to one and you find there’s more to it.`,
      'Owners thinking about getting out say things like:',
      '• “I want my staff looked after.”<br>• “I don’t want my name on a business that gets run into the ground.”<br>• “I need an income when I stop.”<br>• “I don’t want to just disappear on day one.”',
      'Every one of those maps onto the structure. Staff and reputation: an operator who keeps the team.',
      'Income: seller finance, paid over a few years. Not disappearing: a handover period, and seller rollover so they keep a stake.',
      'Add the commercial debt and that’s the whole funding stack, built around what they actually care about.',
      d.industry ? `Plenty of retiring ${d.industry.owners} care a lot about who takes over. Coming from the same industry counts for more in that conversation than most people expect.` : null,
      'That’s why the best offers aren’t always the highest. They’re the ones that answer the seller’s real questions.',
    ].filter(Boolean) as string[],
    ps: 'If you sold tomorrow, what would you care about most? Reply and tell me. It’s the best way to understand the person across the table.',
  }),
  ra_first_conversation: (c, d) => ({
    subject: 'the first conversation with an owner',
    preheader: 'It isn’t “are you selling?”',
    body: [
      `${c.name}, how do you approach the owner of a business that isn’t for sale?`,
      'Not with “are you selling?”. Most will say no, because most haven’t decided. The first conversation is about them: how long they’ve been at it, what’s next, whether they’ve thought about who carries it on.',
      'If there’s interest, the next steps are slow and respectful: a coffee, a look at high-level numbers under a confidentiality agreement, then a rough idea of price and structure. Only then a letter of intent.',
      'Approaching owners directly, before a broker is involved, means fewer competing buyers and a seller who has chosen to talk to you specifically.',
      d.industry ? `In ${industryName(d.industry)}, you probably already know some of these owners. Think about ${d.industry.target}. Is there someone there you’ve met at an industry event or through a supplier?` : null,
      has(d, 'deal_flow') ? 'You told us finding the right business was what was in the way. This is how that starts.' : null,
    ].filter(Boolean) as string[],
    cta: { label: 'Finding off-market businesses →', href: c.link('/guides/find-off-market-businesses-for-sale') },
  }),
  ra_see_when: (c, d) => ({
    subject: 'what you see, and when',
    preheader: 'How a seller’s numbers get shared, in layers.',
    body: [
      `${c.name}, one thing that confuses first-time buyers: when do you actually get to see the numbers?`,
      'It comes in layers, and each one is earned:',
      '<strong>1. The conversation.</strong> Who they are, roughly what the business does, whether they’d consider selling.<br><strong>2. A confidentiality agreement.</strong> You agree to keep what you see private, and in return you get high-level financials, such as a few years of profit and loss.<br><strong>3. The letter of intent.</strong> Once a price and structure are agreed in principle, you get access to the full detail.<br><strong>4. Due diligence.</strong> Everything gets checked: contracts, leases, staff, tax, customers.',
      'Sellers guard their information for good reason: their staff and customers don’t know yet. Respecting that is part of earning their trust.',
      d.industry ? `If the business is a competitor in ${industryName(d.industry)}, this matters even more. You’re asking to see the books of someone who may have been competing with ${yourBiz(d)} for years.` : null,
    ].filter(Boolean) as string[],
    cta: { label: 'Questions to ask a seller →', href: c.link('/guides/questions-to-ask-a-business-seller') },
  }),

  // ── Day 9: agreeing the deal ──
  ra_loi: (c, d) => ({
    subject: 'the letter before the contract',
    preheader: 'What a letter of intent is for, and what it isn’t.',
    body: [
      `${c.name}, the letter of intent is the moment a conversation becomes a deal. It’s simpler than it sounds.`,
      'An LOI runs to a few pages. It sets out the price, the structure (how much is commercial debt, how much seller finance, how much seller rollover), the handover period, the timing and the conditions, such as finance approval and due diligence.',
      'Most of it is written as non-binding.',
      'The parts that are made binding are confidentiality and a period of exclusivity, where the seller agrees not to shop the business to anyone else while you do your checks.',
      'Why it matters: it gets the big terms agreed before anyone spends serious money on lawyers. If you can’t agree on an LOI, you were never going to agree on a contract.',
      d.timeline === '0_6' ? 'You told us you wanted to move within six months. A signed LOI is the milestone that tells you whether that’s on track.' : null,
    ].filter(Boolean) as string[],
    cta: { label: 'Read the LOI guide →', href: c.link('/guides/letter-of-intent-buying-a-business') },
  }),
  ra_earnout_note: (c, d) => ({
    subject: 'earn-out or seller note?',
    preheader: 'Two ways to pay the seller later. Different risks.',
    body: [
      `${c.name}, two terms that get mixed up: a seller note and an earn-out. Both mean part of the price is paid after settlement. They work differently.`,
      '<strong>A seller note</strong> is a fixed amount, paid over a set period with interest, like a loan from the seller. It’s owed whether the business has a great year or an average one, though it can be written to pause if things go badly.',
      '<strong>An earn-out</strong> is paid only if the business hits agreed targets after the sale, measured on revenue or profit over an agreed period, such as one to three years. Hit them and the seller gets more. Miss them and they get less.',
      'Earn-outs are useful when you and the seller disagree on what the business is worth: they believe in next year, you want proof. The catch is that they can cause arguments about how the targets were measured, so they need to be written tightly.',
      'The usual stack is commercial debt, a seller note and seller rollover. An earn-out is a tool for a specific gap, not a default.',
      has(d, 'valuation') ? 'You told us valuation and negotiation was what was in the way. An earn-out is one of the cleaner ways to bridge a gap on price.' : null,
    ].filter(Boolean) as string[],
    cta: { label: 'Book a strategy call →', href: book(c) },
  }),
  ra_due_diligence: (c, d) => ({
    subject: 'what due diligence actually checks',
    preheader: 'The things that sink deals, found before you sign.',
    body: [
      `${c.name}, due diligence is the part where you check that what the seller told you is true. Here’s what it covers:`,
      '• <strong>Financials:</strong> do the bank statements match the accounts? Are the add-backs real?<br>• <strong>Customers:</strong> how concentrated is revenue? Are any big contracts ending?<br>• <strong>Staff:</strong> who are the key people, what are they owed, are they likely to stay?<br>• <strong>Legal:</strong> leases, licences, disputes, contracts that need consent to transfer.<br>• <strong>Tax:</strong> anything owing that could follow the business.<br>• <strong>Operations:</strong> equipment, systems, suppliers.',
      'Your accountant and lawyer do the formal work. Your job is the part no professional can do: judging whether the business actually runs the way the seller says it does.',
      d.industry
        ? `That’s where being in ${industryName(d.industry)} pays off. You’ll notice things in a ${d.industry.one} that an outsider would miss.`
        : 'That’s where being an operator pays off. You’ll notice things an outsider would miss.',
    ],
    cta: { label: 'Due diligence red flags →', href: c.link('/guides/due-diligence-red-flags') },
  }),

  // ── Day 10: the legal shape, what goes wrong, and settlement ──
  ra_shares_assets: (c, d) => ({
    subject: 'buying the shares or the assets',
    preheader: 'A big decision, explained at a high level.',
    body: [
      `${c.name}, there are two basic ways to buy a business, and it’s worth knowing the difference before you talk to anyone.`,
      '<strong>Buying the shares</strong> means buying the company itself. Everything comes with it: contracts, staff, licences, history. Simpler to keep running, but you inherit any skeletons too, so due diligence and warranties matter more.',
      '<strong>Buying the assets</strong> means buying what the business uses (equipment, customer lists, brand, goodwill) into your own entity. It can be cleaner, because old liabilities stay with the seller unless you agree to take them on, but contracts, leases and licences may need to be transferred or re-signed.',
      'Which is better depends on the business, the tax position of both sides and what the lender wants. Your accountant and lawyer should make that call with you. I just want you walking in knowing the question exists.',
      d.goal === 'group' ? 'You told us you want to build a group. How each deal is held matters even more then, because the shape of deal one sets up deals two and three.' : null,
    ].filter(Boolean) as string[],
    ps: 'This is general information, not legal, tax or financial advice.',
  }),
  ra_fall_over: (c, d) => ({
    subject: 'why deals fall over',
    preheader: 'Rarely where you’d expect.',
    body: [
      `${c.name}, deals rarely fall over for dramatic reasons. These are the ones to watch for:`,
      '• <strong>The numbers didn’t survive due diligence.</strong> The profit was lower than the seller thought, or the add-backs didn’t hold up.<br>• <strong>The seller wasn’t really ready.</strong> They liked the idea of selling more than the reality of handing over.<br>• <strong>The debt cover didn’t work.</strong> At the agreed price, the profit couldn’t cover the repayments about 1.5 times.<br>• <strong>A key customer or staff member was at risk</strong>, and nobody found out until late.<br>• <strong>The buyer ran out of steam.</strong> Deals take weeks of steady work, and momentum matters.',
      'Most of these can be seen early if you know where to look. That’s the point of doing the numbers and the seller conversations properly before anyone signs.',
      has(d, 'time') ? 'You told us time was what was in the way. The last point is the one to plan for: a few steady hours a week beats a burst of enthusiasm.' : null,
      'And sometimes the right answer is to let a deal fall over. Walking away costs far less than settling a bad one.',
    ].filter(Boolean) as string[],
    cta: { label: 'Book a strategy call →', href: book(c) },
  }),
  ra_settlement: (c, d) => ({
    subject: 'what happens on settlement day',
    preheader: 'Quieter than you’d think.',
    body: [
      `${c.name}, settlement day sounds dramatic. In practice it’s mostly lawyers swapping documents.`,
      'Here’s roughly what happens:',
      '• The lender releases the commercial debt to pay the seller.<br>• The seller finance and seller rollover are documented: the seller is now owed the note over time, and holds their stake.<br>• Ownership of the shares or assets passes to you.<br>• Bank accounts, signing authorities, insurances and key supplier accounts move across.<br>• The handover period starts.',
      'Then the real day one begins: the conversation with key staff, the call or visit to key customers, and your first week as the owner.',
      `The preparation is what keeps it calm. By settlement, every one of those steps should have been agreed weeks earlier.`,
      `You’ve run ${yourBiz(d)} long enough to know the paperwork is the easy part. The people are the work.`,
    ],
    ps: 'Reply if you’d like me to walk you through any of those steps in more detail.',
  }),

  // ── Day 11: after the deal ──
  ra_handover: (c, d) => ({
    subject: 'the handover period',
    preheader: 'Why the seller doesn’t vanish on day one.',
    body: [
      `${c.name}, one of the most important lines in any deal is how long the seller stays after settlement.`,
      'A handover (sometimes called a transition period) runs for an agreed period, from a few months to longer. The seller introduces you to key customers, suppliers and staff, explains how things actually get done, and answers the questions you don’t know to ask yet.',
      'It’s easier to agree than people expect, because it suits the seller too. If they’re being paid a seller note out of the business, or they’ve kept a stake through seller rollover, they want it to do well under you.',
      'What to agree up front: how many days a week, for how long, what they’re responsible for, and when they step back.',
      has(d, 'integration') ? 'You told us integration was the worry. A well-written handover is one of the best protections against it.' : null,
    ].filter(Boolean) as string[],
    cta: { label: 'Book a strategy call →', href: book(c) },
  }),
  ra_monday_after: (c, d) => ({
    subject: 'the monday after',
    preheader: 'Staff and customers, once the sale is done.',
    body: [
      `${c.name}, the deal settles on a Friday. What happens on Monday?`,
      '<strong>Staff</strong> want to know three things: is my job safe, is my pay the same, and who do I go to now. Answer those clearly, in person, on day one.',
      'How their employment carries over depends on how the deal is structured, and your lawyer handles that part. The message is yours.',
      '<strong>Customers</strong> mostly want to know nothing is going to get worse. A call or a visit with the seller beside you does more than any letter. Keep the name, the phone number and the people they deal with the same for a while.',
      '<strong>You</strong> resist the urge to change everything. The first few months are for learning, not fixing.',
      d.industry ? `Whoever walks through the door of ${d.industry.target}, they’re loyal to the people they know there. That loyalty is a big part of what you’re buying.` : null,
    ].filter(Boolean) as string[],
    ps: 'What would worry you most about the week after buying a business? Reply and tell me.',
  }),
  ra_merge_first: (c, d) => ({
    subject: 'what to merge, what to leave alone',
    preheader: 'Integration without breaking what works.',
    body: [
      `${c.name}, once you own two businesses, the temptation is to merge everything straight away. Resist it.`,
      'A simple way to organise it:',
      '<strong>Merge early:</strong> the things customers never see. Bookkeeping, payroll, insurance, purchasing. That’s where a lot of the savings come from.<br><strong>Merge later:</strong> the systems staff use every day. Software, rosters, processes. Change them once people trust you.<br><strong>Maybe never:</strong> the brand and the front door, if customers are loyal to them.',
      'Shared costs are a big part of why buying a business like yours can work so well. But the savings come from doing it in the right order, not all at once.',
      d.industry ? `If you bought ${d.industry.target}, the question to ask about every change is simple: will a customer notice? If yes, slow down.` : 'The question to ask about every change is simple: will a customer notice? If yes, slow down.',
    ],
    cta: { label: 'Talk through integration →', href: book(c) },
  }),

  // ── Day 12: what to buy ──
  ra_next_door: (c, d) => ({
    subject: 'next door or down the road?',
    preheader: 'A competitor, or a business next to yours.',
    body: [
      `${c.name}, there are two kinds of first acquisition, and they suit different owners.`,
      '<strong>A competitor</strong> does what you do, for the same kind of customer. The upside: you know exactly how it works, and the savings from shared overheads can be large. The watch-outs: customers may overlap, and staff may know you as the opposition.',
      '<strong>An adjacent business</strong> does something next to what you do: a service your customers already buy elsewhere, or the same service in a new area. The upside: new revenue, cross-selling, less overlap. The watch-out: you’re learning something new.',
      d.industry ? `For ${d.industry.owners}, a competitor could be ${d.industry.target}. An adjacent move could be a related service your customers already pay someone else for.` : null,
      d.goal === 'acquire' ? 'You told us you wanted to grow by buying competitors or add-ons, so both are on the table for you.' : null,
      'Either way, the funding works the same: commercial debt, seller finance and seller rollover, tested at about 1.5 times debt cover.',
    ].filter(Boolean) as string[],
    cta: { label: 'Buying a competitor →', href: c.link('/guides/buy-your-competitor') },
  }),
  ra_supplier: (c, d) => ({
    subject: 'buying your supplier',
    preheader: 'Vertical acquisitions, briefly.',
    body: [
      `${c.name}, here’s an acquisition most owners never consider: buying a business above or below you in the chain.`,
      'Buying a supplier means you keep the margin they were making on you, and you control something you depend on. Buying a business you sell through, or one that serves the same end customer, can secure demand.',
      'They’re harder to get right than buying a competitor. You’re running a different kind of business, and the supplier’s other customers may include your competitors, who may not love the change.',
      'But when there’s a supplier you rely on and its owner is getting close to retirement, it’s worth a serious look. The mechanics are the same: commercial debt, seller finance and seller rollover, with the target’s own profit covering the repayments.',
      `Think about who ${yourBiz(d)} pays the most every month. Is that business owner-run? Is the owner thinking about what’s next?`,
    ],
    ps: 'If you like, reply with who your biggest supplier is (just the type of business is fine). I’ll give you my honest take on whether it’s worth thinking about.',
  }),
  ra_platform: (c, d) => ({
    subject: 'for owners past $10m',
    preheader: 'Bigger businesses, bigger deals, the same rules.',
    body: [
      d.revenue && BIG_REVENUE.includes(d.revenue) && d.revenueLabel
        ? `${c.name}, you told us ${yourBiz(d)} does ${d.revenueLabel} in revenue, so this one is written for you.`
        : `${c.name}, this one is about where it can go once a business gets bigger.`,
      'Some owners doing $10M to $50M and more in revenue go past the business down the road. They make platform deals: buying a business big enough to become the base of a group, or several at once, with a management team, a finance function and systems that can absorb more.',
      'The mechanics don’t change. Commercial debt, seller finance and seller rollover fund the price, and the 1.5 times debt cover test still decides whether a deal makes sense.',
      'What changes is the size of the cheques, the number of lenders who may want to compete for it, and how much the rollover can matter, because a larger seller may want to stay in for the next stage.',
      'The other difference is preparation. A bigger deal takes more diligence, tighter reporting and a team that has done it before.',
      d.goal === 'group' ? 'You told us you want to build a group. A platform deal is one way that starts.' : null,
    ].filter(Boolean) as string[],
    cta: { label: 'Book a strategy call →', href: book(c) },
  }),

  // ── Day 13: the bigger picture ──
  ra_worth_more: (c, d) => ({
    subject: 'why one plus one can be worth more than two',
    preheader: 'How a combined business can be valued higher (illustrative).',
    body: [
      `${c.name}, here’s one of the less obvious reasons owners buy businesses. The numbers are illustrative.`,
      'Say your business makes $500k a year and a buyer would pay 3 times profit: $1.5M. You buy a similar business making $400k, also at 3 times, for $1.2M, funded with commercial debt, seller finance and seller rollover.',
      'The combined business makes $900k, plus whatever comes from shared costs. Bigger, steadier businesses can attract a higher multiple, because they carry less risk for the next buyer. At 4 times, $900k would be valued at $3.6M, against $2.7M for the two apart.',
      'That gap is called multiple expansion.',
      'The caveat, and it’s a big one: multiples aren’t guaranteed. The market decides what a business is worth when you sell, you still have the debt and seller note to pay down, and the seller owns their rolled stake. This is a reason to build a bigger business well, not a promise of a number.',
      d.goal === 'exit'
        ? 'You told us you want to grow and then sell. This is the mechanism behind that plan.'
        : d.goal === 'group'
          ? 'You told us you want to build a group. This is the mechanism behind why a group can be valued higher than its parts.'
          : null,
    ].filter(Boolean) as string[],
    cta: { label: 'Book a strategy call →', href: book(c) },
    ps: illustrative,
  }),
  ra_your_chair: (c, d) => ({
    subject: 'your 90 days, from your chair',
    preheader: 'What you actually do, week to week.',
    body: [
      `${c.name}, I’ve described the 90 days before as milestones. Here’s what it looks like from your chair.`,
      '<strong>Weeks 1–2:</strong> a couple of hours deciding what you want to buy: size, area, type of business. You know your market, so this is mostly getting it out of your head.<br><strong>Weeks 3–6:</strong> a few conversations a week with owners. You take these, because sellers want to talk to the buyer.<br><strong>Weeks 7–10:</strong> reviewing the numbers we’ve modelled with you, and deciding which deal to chase.<br><strong>Weeks 11–13:</strong> agreeing terms with the seller and working towards a signed letter of intent.',
      'Your business keeps running the whole time. The modelling, structuring and lender introductions are done with you, not dumped on you.',
      'Ninety days is the pace we work to, not a promise. Sometimes the right business takes longer to find, and that’s fine.',
      d.timeline && TIMELINES[d.timeline] ? TIMELINES[d.timeline] : null,
    ].filter(Boolean) as string[],
    cta: { label: 'Book a strategy call →', href: book(c) },
  }),
  ra_one_page: (c, d) => ({
    subject: 'the whole thing on one page',
    preheader: 'Everything from the last ten days, in order.',
    body: [
      `${c.name}, I’ve sent a lot on how this works. Here it is on one page.`,
      '<strong>1. Find:</strong> owners ready to step back, approached directly, before a broker is involved.<br><strong>2. Price:</strong> a multiple of normalised profit, moved up or down by how much depends on the owner.<br><strong>3. Fund:</strong> commercial debt, seller finance and seller rollover, plus a working-capital line when the cash flow supports it.<br><strong>4. Test:</strong> the target’s profit covers its repayments about 1.5 times, or you don’t do it.<br><strong>5. Agree:</strong> a letter of intent, then due diligence.<br><strong>6. Settle:</strong> lawyers swap documents, and the handover begins.<br><strong>7. Run:</strong> keep the staff and customers, merge the back office first.',
      `The next step is seeing it on ${yourBiz(d)}${sizeLine(d) ? `, ${sizeLine(d)}` : ''}: what a sensible first target looks like, which structure fits, and whether the numbers clear the test. That’s what a strategy call is for.`,
    ],
    cta: { label: 'Book a strategy call →', href: book(c) },
    ps: `If your numbers have changed since you applied, you can <a href="${c.link('/apply?again=1')}">update them here</a> first.`,
  }),
};

/** Recommended send order: three a day across days 4–13. */
export const REACTIVATE_A_ORDER: string[] = [
  // Day 4
  'ra_lender_reads', 'ra_seller_mortgage', 'ra_why_stay_in',
  // Day 5
  'ra_working_capital', 'ra_no_money_honest', 'ra_who_repays',
  // Day 6
  'ra_dscr_worked', 'ra_numbers_dip', 'ra_fuzzy',
  // Day 7
  'ra_price_set', 'ra_real_profit', 'ra_owner_is_business',
  // Day 8
  'ra_seller_wants', 'ra_first_conversation', 'ra_see_when',
  // Day 9
  'ra_loi', 'ra_earnout_note', 'ra_due_diligence',
  // Day 10
  'ra_shares_assets', 'ra_fall_over', 'ra_settlement',
  // Day 11
  'ra_handover', 'ra_monday_after', 'ra_merge_first',
  // Day 12
  'ra_next_door', 'ra_supplier', 'ra_platform',
  // Day 13
  'ra_worth_more', 'ra_your_chair', 'ra_one_page',
];
