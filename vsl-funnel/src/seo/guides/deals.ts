import type { Guide } from '../types';

/**
 * Financing and "Finding & closing deals" guides.
 * Every worked example is labelled illustrative. No invented statistics or client results.
 */
export const DEAL_GUIDES: Guide[] = [
  // ───────────────────────────── dscr-explained ─────────────────────────────
  {
    slug: 'dscr-explained',
    title: 'DSCR Explained: Debt Service Coverage for Acquisitions',
    description:
      'What DSCR (debt service coverage ratio) means, how to calculate it, what lenders look for and why we structure acquisitions at about 1.5x. For business buyers.',
    h1: 'DSCR Explained: How Debt Service Coverage Decides Whether a Deal Pays for Itself',
    answer:
      'DSCR (debt service coverage ratio) is the cash a business has available to repay debt divided by its total annual debt repayments, interest plus principal. A DSCR of 1.5x means the business earns $1.50 for every $1 it must repay each year. Lenders use it to judge whether an acquisition can carry its own debt. G&L structures deals at around 1.5x.',
    keyPoints: [
      'DSCR = cash available for debt service ÷ annual debt service (interest + principal).',
      'Below 1.0x the business cannot cover its repayments from its own cash flow.',
      'We target around 1.5x so the acquired business pays its own debt with a buffer.',
      'Seller rollover carries no repayments, so it lifts DSCR without adding debt service.',
      'The structure (senior debt, seller finance, seller rollover) moves DSCR more than the price does.',
    ],
    body: `## What is DSCR?

DSCR stands for **debt service coverage ratio**. It answers one question: *does this business make enough cash to pay its loans, with room to spare?*

- **Debt service** is every loan repayment due in a year: interest *and* principal (the amount borrowed).
- **Cash available for debt service** is the cash profit left after running the business, before those repayments.

Divide the second by the first and you have the DSCR. At 1.0x the business earns exactly what it owes, with nothing left over. At 1.5x it earns 50% more than it owes.

In an acquisition, DSCR is the number that tells a lender, a seller and you whether the deal pays for itself from the target’s own cash flow, or quietly leans on your existing business.

## How do you calculate DSCR?

1. **Start with EBITDA.** Earnings before interest, tax, depreciation and amortisation: operating profit with non-cash and financing items stripped out.
2. **Adjust for add-backs.** Add back one-off or owner-specific costs that won’t continue (a one-time legal bill, the owner’s personal car). Be strict here. Inflated add-backs are the most common way a DSCR looks better on paper than in real life.
3. **Subtract a market salary for whoever replaces the owner.** If the seller worked in the business unpaid or underpaid, someone has to do that job after settlement.
4. **Subtract maintenance capex.** Capital expenditure is spending on equipment and assets; maintenance capex is what you must spend just to stand still.
5. **Subtract tax** (lenders differ on whether they do this; ask yours).
6. **Add up annual debt service** across every loan: senior debt repayments plus seller note repayments.
7. **Divide step 5 by step 6.**

Lenders commonly use their own version of this formula, so treat your number as an estimate until the lender has run theirs.

## A worked DSCR example (illustrative)

**Illustrative only.** A target business sells for $1.5M. After add-backs, a manager’s salary, maintenance capex and tax, it produces **$525k** a year of cash available for debt service. Assume senior debt at 8% over 5 years and a seller note at 6% over 4 years. Here is how three ways of funding the same price change the DSCR:

| Funding mix | Senior debt | Seller note | Seller rollover | Annual debt service | DSCR |
|---|---|---|---|---|---|
| All bank debt | $1.5M | $0 | $0 | about $376k | about 1.40x |
| [70/20/10](/guides/70-20-10-deal-structure) | $1.05M | $300k | $150k | about $350k | about 1.50x |
| [60/40](/guides/60-40-deal-structure) | $900k | $0 | $600k | about $225k | about 2.33x |

Same business, same price, very different risk. The 60/40 has the strongest coverage because 40% of the price is **seller rollover**: the seller keeps a stake instead of being paid, so there is no repayment on that portion. The 70/20/10 lands at about 1.5x because the seller note is a loan that needs repaying, while the 10% rollover does not.

In practice, few lenders fund 100% of a price with debt alone, so the first row is there to show the maths, not a likely offer.

## What DSCR do lenders want for a business acquisition?

Each lender sets its own minimum, often somewhere between 1.2x and 1.35x for an established business, and a **covenant** (a promise in the loan agreement) that you keep it above a floor every year. Industry, the quality of earnings and how much of the price is senior debt all shift the number.

A deal that just clears the lender’s minimum is a deal that breaks the first time a key customer leaves. That’s why we don’t design to the minimum.

## Why does G&L structure deals at about 1.5x DSCR?

At around 1.5x, the acquired business earns roughly $1.50 for every $1 it owes. That buffer does three jobs:

- **It protects your existing business.** The new acquisition should carry its own debt. If it can’t, you’re funding it from your core profit, and you’ve bought a liability.
- **It makes lenders comfortable.** A comfortable lender is more likely to add a working-capital line, which is what makes a deal [over-financed](/guides/over-financed-acquisition).
- **It survives a bad year.** Revenue dips, staff leave, a big customer renegotiates. At 1.5x, a 20% fall in cash flow still leaves you above 1.0x.

Josh Li bought two of his own clinics with 100% seller (vendor) finance, paid from each clinic’s cash flow. The lesson he carries into every structure: the seller’s repayments have to be affordable from the business itself, on a normal month, not a great one.

## How does the deal structure change DSCR?

When a deal is funded, it usually draws on three parts:

- **Senior debt (commercial debt):** a loan from a lender, repaid first, usually with the fastest repayment schedule. It has the biggest effect on DSCR.
- **Seller finance (vendor finance):** the seller lends part of the price and is repaid over time. Longer terms and lower repayments help DSCR. See [seller finance explained](/guides/seller-finance-explained).
- **Seller rollover:** the seller keeps a minority stake instead of cash. No repayments, so it adds nothing to debt service. See [seller rollover explained](/guides/seller-rollover-explained).

Moving value from senior debt to seller finance or seller rollover is the single most powerful lever on DSCR.

## How can you improve DSCR on a deal?

1. **Shift part of the price into seller rollover.** No repayments on that slice.
2. **Lengthen the seller note.** Spreading $300k over five years instead of three cuts the annual repayment sharply.
3. **Add an interest-only or deferred start** to the seller note for the first months while you settle in.
4. **Negotiate the price against verified cash flow,** not the seller’s adjusted figures.
5. **Cut out the add-backs you can’t prove.** A lower honest DSCR beats a high one that collapses in due diligence. Our [due diligence red flags](/guides/due-diligence-red-flags) guide covers the add-backs that most often fall apart.

## What happens if DSCR drops below the covenant?

A covenant breach doesn’t automatically mean the lender calls the loan, but it gives them the right to act. Typical responses are a waiver, tighter terms, extra reporting or a request for more security. Talk to your lender early: they react far better to a heads-up than to a surprise.

> This guide is general information, not financial, legal or tax advice. Get independent advice on any specific deal.

## Want your deal structured at 1.5x?

On an acquisition strategy call we look at your business and your target market, and map the structure that keeps your first deal at around 1.5x DSCR. [See if you qualify](/).`,
    faqs: [
      {
        q: 'What is a good DSCR for buying a business?',
        a: 'Lenders often set minimums around 1.2x to 1.35x, but a deal that only just clears that has little room for a bad year. We aim for about 1.5x so the business covers its debt with a buffer.',
      },
      {
        q: 'What does a DSCR of 1.5 mean?',
        a: 'It means the business produces $1.50 of cash available for debt service for every $1 of loan repayments due that year. It could lose a third of that cash flow and still cover its repayments.',
      },
      {
        q: 'Does seller finance count in DSCR?',
        a: 'Yes. Seller note repayments are debt service, so they reduce DSCR. Seller rollover does not, because the seller is taking equity rather than repayments.',
      },
      {
        q: 'Is DSCR calculated on EBITDA?',
        a: 'Lenders usually start from EBITDA, then adjust for add-backs, a replacement manager’s salary, maintenance capex and sometimes tax. Each lender uses its own definition, so ask for theirs.',
      },
      {
        q: 'What happens if my DSCR is below 1?',
        a: 'The business cannot meet its repayments from its own cash flow, so the shortfall has to come from somewhere else, usually you. Most lenders will not fund a deal that starts below 1.0x.',
      },
      {
        q: 'How do I increase DSCR without lowering the price?',
        a: 'Move part of the price into seller rollover, lengthen the seller note, add a deferred start to repayments, or reduce the senior debt share. Each lowers annual debt service.',
      },
    ],
    related: ['over-financed-acquisition', '70-20-10-deal-structure', 'seller-finance-explained', 'seller-rollover-explained', 'due-diligence-red-flags'],
    section: 'Financing',
    published: '2026-10-14',
    updated: '2026-10-14',
  },

  // ───────────────────────────── over-financed-acquisition ─────────────────────────────
  {
    slug: 'over-financed-acquisition',
    title: 'Over-Financed Acquisition: Funding More Than the Price',
    description:
      'What an over-financed acquisition is, how financing covers the price plus working capital and closing costs, and how to structure one safely. For owners.',
    h1: 'What Is an Over-Financed Acquisition (and How Do You Structure One)?',
    answer:
      'An over-financed acquisition is a business purchase where the total financing is larger than the purchase price. Senior debt, seller finance and seller rollover together cover the full price, and an extra facility, usually a lender’s working-capital line, funds working capital and closing costs. The buyer puts in no cash, and the business starts with money in the bank.',
    keyPoints: [
      'Over-financed means sources of funds exceed the purchase price.',
      'The extra pays for working capital and closing costs, so you don’t fund them yourself.',
      'It is built from senior debt, seller finance, seller rollover and usually a working-capital line.',
      'It only works if the business can service all of it: we target about 1.5x DSCR.',
      'Over-financing is a structure, not a loophole. Lenders agree to it because the numbers hold up.',
    ],
    body: `## What does over-financed mean?

Every acquisition has **sources** (where the money comes from) and **uses** (where it goes). Most buyers only think about one use: the price. But a deal has three:

1. **The purchase price** paid to the seller.
2. **Closing costs:** legal fees, accounting and due diligence, lender fees, valuation and any stamp duty or transfer costs where you are.
3. **Working capital:** the cash a business needs to run day to day, paying wages and suppliers before customers pay their invoices.

A deal is **over-financed** when the sources cover all three. You don’t write a cheque for the price, and you don’t write one for the lawyers or for payroll in month one either.

Many "no money down" deals cover the price and then leave the buyer to find $100k for costs and a cash buffer. That’s not no money down. An over-financed deal is.

## How is an over-financed deal funded?

Every over-financed deal we structure uses the same building blocks:

| Source | What it is | Repaid how |
|---|---|---|
| Senior debt (commercial debt) | A loan from a lender, secured over the business’s assets | Regular repayments, first in line |
| Seller finance (vendor finance) | The seller lends part of the price | Paid over time from the business’s cash flow |
| Seller rollover | The seller keeps a minority stake instead of cash | No repayments; the seller shares in profit and upside |
| Working-capital line | A revolving facility from the lender | Drawn and repaid as the business needs |

The first three cover the price. The fourth is what tips the deal into over-financed. The rollover is the part buyers most often leave out, and it’s the one that costs nothing in repayments. See [seller rollover explained](/guides/seller-rollover-explained).

## A worked example (illustrative)

**Illustrative only.** A retiring owner sells a business for $1.5M using a [70/20/10 structure](/guides/70-20-10-deal-structure).

**Sources**

| Source | Amount |
|---|---|
| Senior debt (70%) | $1,050,000 |
| Seller note (20%) | $300,000 |
| Seller rollover (10%) | $150,000 |
| Lender working-capital line | $200,000 |
| **Total sources** | **$1,700,000** |

**Uses**

| Use | Amount |
|---|---|
| Purchase price | $1,500,000 |
| Closing costs | $70,000 |
| Working capital buffer | $130,000 |
| **Total uses** | **$1,700,000** |

The buyer contributes $0. The business starts its first month under new ownership with $130k of working capital rather than an empty account. The seller receives most of their money at settlement, a steady income from the note, and 10% of the upside through their rollover.

Whether a lender agrees to fund closing costs, and how big the working-capital line is, depends on the lender and the business. These figures show the shape of the deal, not an offer.

## Why would a lender or seller agree to over-finance?

Because the business can carry it. Over-financing works when:

- **The cash flow covers every repayment with room to spare.** We structure at a DSCR (debt service coverage ratio) of around 1.5x. See [DSCR explained](/guides/dscr-explained).
- **The seller has skin in the game.** A seller note and a rollover stake mean the seller only gets paid in full if the business keeps performing. Lenders read that as a strong signal.
- **The buyer is credible.** An owner already running a $1M+ business in the same or an adjacent industry has the team, systems and track record that a first-time individual buyer doesn’t.
- **The assets are real.** Lenders take security over the business’s assets: receivables, equipment, contracts.

A lender is more comfortable lending into a business that starts with a cash buffer than one that starts at zero. A business with no working capital is the one that misses a payment in month three.

## Is an over-financed acquisition risky?

It’s more debt than a buyer-funded deal, so it has to be built carefully. The risks to watch:

- **Over-leverage.** Debt that only works if everything goes right. Fix: hold DSCR around 1.5x and stress-test a bad year.
- **Drawing the working-capital line to cover losses.** It’s for timing gaps, not for propping up a business that doesn’t make money.
- **Inflated earnings.** If the seller’s add-backs don’t survive due diligence, every ratio is wrong. See [due diligence red flags](/guides/due-diligence-red-flags).
- **Personal exposure.** Who guarantees the debt matters. Our 60/40 structure, for example, uses no personal guarantee: the lender takes security over 100% of the business’s assets instead. See [buying a business without a personal guarantee](/guides/buy-a-business-without-a-personal-guarantee).

## How do you structure an over-financed deal? Step by step

1. **Verify the cash flow first.** Rebuild EBITDA from bank statements and tax returns, not from the seller’s summary.
2. **Set the debt capacity.** Work backwards from a 1.5x DSCR to the total annual repayments the business can carry.
3. **Split the price** across senior debt, seller finance and seller rollover so that repayments fit inside that capacity.
4. **Size the uses.** Price, plus realistic closing costs, plus enough working capital to cover a slow quarter.
5. **Approach lenders with the full picture,** including the working-capital request, before you sign the LOI.
6. **Put the structure in the LOI** so the seller agrees to the note and rollover terms up front. See [how to write a letter of intent](/guides/letter-of-intent-buying-a-business).

## What we’ve learned about over-financing

The biggest mistake buyers make is negotiating the price hard and the structure lightly. A seller will often accept a slightly lower headline with more paid at settlement, or a full price with a longer note and a rollover stake. The structure decides whether you put money in. The price rarely does.

> This guide is general information, not financial, legal or tax advice. Lending terms vary; get independent advice on any specific deal.

## Want your first acquisition over-financed?

On an acquisition strategy call we map how your first deal could be funded end to end, price, costs and working capital, with none of your own cash. [See if you qualify](/).`,
    faqs: [
      {
        q: 'What is an over-financed acquisition?',
        a: 'It is a business purchase where the financing is larger than the purchase price, so it also pays for closing costs and working capital. The buyer puts in no cash of their own.',
      },
      {
        q: 'Can you finance closing costs when buying a business?',
        a: 'Often, yes, through a lender’s working-capital line or by sizing the facility to include costs. It depends on the lender and on whether the business’s cash flow can service the extra debt.',
      },
      {
        q: 'Is over-financing the same as 100% financing?',
        a: '100% financing covers the price. Over-financing covers the price plus closing costs and working capital, so the business starts with cash in the bank.',
      },
      {
        q: 'Why would a bank lend more than the purchase price?',
        a: 'Because the business’s cash flow covers the repayments with a buffer, the seller has money at risk through a note and rollover, and the buyer already runs a similar business. A working-capital buffer also lowers the chance of an early missed payment.',
      },
      {
        q: 'How much working capital should an acquisition have?',
        a: 'Enough to pay wages and suppliers through the gap before customers pay, plus a margin for a slow month. The right figure comes from the target’s own cash cycle, which you check in due diligence.',
      },
    ],
    related: ['dscr-explained', '70-20-10-deal-structure', 'how-to-buy-a-business-with-no-money-down', 'buy-a-business-without-a-personal-guarantee'],
    section: 'Financing',
    published: '2026-10-14',
    updated: '2026-10-14',
  },

  // ───────────────────────────── buy-a-business-without-a-personal-guarantee ─────────────────────────────
  {
    slug: 'buy-a-business-without-a-personal-guarantee',
    title: 'How to Buy a Business Without a Personal Guarantee',
    description:
      'How to buy a business without a personal guarantee: what a PG is, why lenders ask, and how a 60/40 structure with seller rollover replaces it. For owners.',
    h1: 'How to Buy a Business Without a Personal Guarantee',
    answer:
      'You can buy a business without a personal guarantee by giving the lender stronger security elsewhere: usually security over 100% of the business’s assets, a lower share of senior debt, and a seller who keeps a meaningful stake through seller rollover. G&L’s 60/40 structure uses 60% commercial debt and 40% seller rollover, with no personal guarantee from the buyer.',
    keyPoints: [
      'A personal guarantee (PG) makes you personally liable if the business can’t repay.',
      'Lenders ask for one to close a gap in their security. Close the gap another way and the PG can go.',
      'Our 60/40 structure has no PG: the lender takes security over 100% of the business’s assets instead.',
      'Lower senior debt and a large seller rollover make the lender’s position much safer.',
      'Not every lender will agree. Structure and buyer quality decide it.',
    ],
    body: `## What is a personal guarantee?

A **personal guarantee (PG)** is a promise that if the business can’t repay its loan, you will, from your own assets: savings, property, sometimes your home. It turns a business debt into a personal one.

Lenders ask for a PG because it gives them a second place to recover money if the business fails. For a buyer who already owns a successful company, signing one means betting everything you’ve built on the next deal.

There are variations. An **unlimited** guarantee covers the whole debt. A **limited** guarantee is capped at an amount. A **directors’ guarantee** is signed by the company’s directors. Read every version closely with a lawyer.

## Why do lenders ask for a personal guarantee?

Because their **security** (the assets they can claim if the loan isn’t repaid) doesn’t fully cover their risk. A lender asks itself three things:

1. **Does the business’s cash flow comfortably cover the repayments?** That’s DSCR, the debt service coverage ratio. See [DSCR explained](/guides/dscr-explained).
2. **If it fails, what can we recover?** That’s the security over assets.
3. **How much of the price are we funding, and who else is at risk?**

A PG is the lender’s answer when one of those is weak. Make all three strong and you have a real case for no PG.

## How do you avoid a personal guarantee?

The approach we use is to replace the PG with structure:

- **Lower the senior debt share.** The less of the price the lender funds, the more the business’s assets cover their loan.
- **Give the lender security over 100% of the business’s assets.** Receivables, equipment, contracts and goodwill all sit behind the loan.
- **Keep the seller in the deal through seller rollover.** A seller who keeps a large stake is betting on the business too. That’s exactly the reassurance a PG was meant to provide.
- **Keep DSCR around 1.5x.** Comfortable coverage reduces the chance the security is ever needed.
- **Buy as a credible operator.** An owner already running a $1M+ business in the same industry is a lower-risk borrower than a first-time buyer.

## How does the 60/40 structure work without a personal guarantee?

The [60/40 deal structure](/guides/60-40-deal-structure) is built specifically for this.

**Illustrative only.** A business sells for $1.5M.

| Part | Share | Amount | What it means |
|---|---|---|---|
| Senior debt (commercial debt) | 60% | $900,000 | Lender funds this, secured over 100% of the business’s assets |
| Seller rollover | 40% | $600,000 | The owner rolls $600k into a 40% stake they keep |
| Personal guarantee | n/a | $0 | None. The lender relies on the asset security instead |

Why a lender can accept this: they are funding 60% of the value, not 100%, and they have first claim over everything the business owns. The seller has $600k riding on the business’s future, which means the person who knows it best is still motivated to see it succeed.

This deal has no seller note, so there is no seller finance component. Other structures, such as the [70/20/10](/guides/70-20-10-deal-structure), use senior debt, seller finance and seller rollover together. Whether those carry a PG depends on the lender and the deal; the 60/40 is our structure designed to avoid one.

## Is buying a business without a personal guarantee realistic?

It is, but it isn’t automatic. Lenders vary widely. Some will never lend without a PG; others will on the right structure with the right buyer. Things that make a no-PG deal more likely:

- Stable, verifiable earnings with low customer concentration.
- Real assets and recurring revenue.
- A seller willing to keep a large stake.
- A buyer whose existing business shows they can run the target.

Things that make it unlikely:

- A thin DSCR or earnings that rely on add-backs you can’t prove.
- A business that depends entirely on the departing owner.
- A buyer asking the lender to fund 80–100% of the price.

## What are the trade-offs?

Avoiding a PG has a price, and it’s worth naming:

- **You own less at settlement.** In a 60/40 you own 60%, not 100%. The seller is your partner on the remaining 40%.
- **You need a shareholders’ agreement.** It should cover decision-making, dividends, and how and when you can buy out the seller’s stake later. See [seller rollover explained](/guides/seller-rollover-explained).
- **The lender’s security is wide.** Security over 100% of the assets means the lender has strong rights if things go wrong. You’re protecting your personal assets, not the business’s.

For most owners who already have a successful company, owning 60% of a business with no personal risk beats owning 100% of one that could take their house.

## What makes sellers say yes to a large rollover?

In our experience, sellers who accept a big rollover care about three things: the business continuing, their staff being looked after, and getting paid a fair amount over time rather than walking away. Show them how your operation makes their 40% worth more in a few years than it is today, and the rollover stops sounding like a discount.

> This guide is general information, not financial, legal or tax advice. Always have a lawyer review any guarantee or security document before you sign.

## Want to buy without putting your house on the line?

On an acquisition strategy call we look at whether a no-PG structure fits your business and target. [See if you qualify](/).`,
    faqs: [
      {
        q: 'Can I get a business acquisition loan without a personal guarantee?',
        a: 'Sometimes. Lenders are more likely to drop the PG when they fund a lower share of the price, take security over all the business’s assets, and the seller keeps a large stake. It depends on the lender and the deal.',
      },
      {
        q: 'What happens if I sign a personal guarantee and the business fails?',
        a: 'The lender can pursue you personally for the shortfall, up to the limit of the guarantee. That can include savings and property, so get legal advice before signing one.',
      },
      {
        q: 'What is the 60/40 deal structure?',
        a: 'It funds 60% of the price with commercial debt and 40% through seller rollover, where the seller keeps a 40% stake. There is no personal guarantee; the lender takes security over 100% of the business’s assets instead.',
      },
      {
        q: 'Do SBA or government-backed loans require a personal guarantee?',
        a: 'Government-backed small business loan programs commonly require personal guarantees from significant owners. Check the current rules for the program in your country before relying on one.',
      },
      {
        q: 'Is a limited personal guarantee better than an unlimited one?',
        a: 'A limited guarantee caps what you can lose at a set amount, so it is less risky than an unlimited one. It is still personal liability, so negotiate the cap and the release terms with a lawyer.',
      },
      {
        q: 'Does seller finance need a personal guarantee?',
        a: 'Some sellers ask for one on their note, and many don’t when they hold security or a rollover stake. It is negotiable, so put your position in the LOI.',
      },
    ],
    related: ['60-40-deal-structure', 'seller-rollover-explained', 'dscr-explained', 'over-financed-acquisition'],
    section: 'Financing',
    published: '2026-10-14',
    updated: '2026-10-14',
  },

  // ───────────────────────────── letter-of-intent-buying-a-business ─────────────────────────────
  {
    slug: 'letter-of-intent-buying-a-business',
    title: 'Letter of Intent to Buy a Business: What to Include',
    description:
      'What a letter of intent (LOI) for buying a business is, what to include, what is binding, and the 90-day path from first conversation to a signed LOI.',
    h1: 'Letter of Intent for Buying a Business: What Goes In It and How to Get One Signed',
    answer:
      'A letter of intent (LOI) is a short document in which a buyer and seller set out the main terms of a business sale before full due diligence and contracts. It covers price, how the deal is funded, timing, exclusivity and key conditions. Most of an LOI is non-binding, but confidentiality and exclusivity clauses usually are binding.',
    keyPoints: [
      'An LOI records the agreed deal in principle: price, structure, timing and conditions.',
      'Most terms are non-binding; confidentiality and exclusivity usually bind both sides.',
      'Put the full funding structure in: senior debt, seller finance and seller rollover.',
      'Exclusivity gives you time to do due diligence without a rival bidder.',
      'Our 90-day path: target profile, then outreach, then negotiation to a signed LOI.',
    ],
    body: `## What is a letter of intent when buying a business?

A **letter of intent (LOI)**, also called a heads of agreement, term sheet or memorandum of understanding depending on where you are, is the document that turns a conversation into a deal. It sets out the main terms both sides agree on before anyone spends serious money on lawyers, accountants and lenders.

It isn’t the sale contract. The **sale and purchase agreement (SPA)** comes later, after due diligence. But the LOI is where the deal is really made. Terms that aren’t in it are hard to add later, and a seller who has signed one has stopped talking to other buyers.

## Is a letter of intent legally binding?

Mostly no, partly yes. A typical LOI says:

- **Non-binding:** price, structure, timing and conditions. Either side can still walk away if due diligence or financing doesn’t work out.
- **Binding:** confidentiality (you won’t share what you learn), exclusivity (the seller won’t negotiate with anyone else for a set period), and often who pays which costs and which law governs the letter.

Write clearly which clauses bind and which don’t. Ambiguity is how an LOI ends up in a dispute. Have a lawyer check it before you sign.

## What should a letter of intent include?

| Clause | What it says | Why it matters |
|---|---|---|
| Parties and target | Who is buying what: shares or assets, which entities | Sets the legal shape of the deal |
| Price | The headline price, or how it will be calculated | The number everyone remembers |
| Funding structure | Split between senior debt, seller finance and seller rollover | Decides whether you put cash in |
| Seller note terms | Amount, term, interest, start date, security | How and when the seller is paid over time |
| Rollover terms | Stake size, rights, future buy-out | The seller’s ongoing role as a shareholder |
| Working capital | The level the business must hand over at settlement | Stops the business being emptied before you take over |
| Conditions | Due diligence, financing approval, key staff, leases, licences | Your exits if something is wrong |
| Exclusivity | No-shop period, often 60–90 days | Time to do due diligence without a rival |
| Transition | How long the seller stays and in what role | Protects relationships and know-how |
| Timeline | Target dates for due diligence and settlement | Keeps momentum |
| Confidentiality | What both sides can disclose | Protects staff and customers from rumours |

## How do you write a letter of intent for a business? Step by step

1. **Agree the deal verbally first.** The LOI should record terms the seller has already said yes to, not open a negotiation.
2. **Lead with the structure, not just the price.** Write out each part of the funding.
3. **Set conditions you genuinely need,** such as satisfactory due diligence and financing approval, and no more. A long list of conditions reads as a buyer looking for a way out.
4. **Ask for exclusivity long enough to finish due diligence and financing.**
5. **Agree a working capital target** so the business you get is the business you priced.
6. **Keep it short.** Two to four pages is common. Detail belongs in the SPA.
7. **Have a lawyer review it** before you send it.

## What does the funding section of an LOI look like? (illustrative)

**Illustrative only.** For a $1.5M purchase using a [70/20/10 structure](/guides/70-20-10-deal-structure):

> *Purchase price of $1,500,000, funded as follows: (a) $1,050,000 in cash at settlement from senior debt; (b) $300,000 by way of a vendor (seller) note, repaid monthly over four years from settlement; (c) $150,000 by the vendor rolling equity into a 10% shareholding in the purchasing entity. The buyer intends to arrange a working-capital facility in addition to the above. Subject to financing approval and satisfactory due diligence.*

Notice it names all three parts: senior debt, seller finance and seller rollover. A seller who signs this knows exactly how much arrives at settlement, how much comes later, and what they keep. There’s nothing to renegotiate in month two. Before you write numbers like these, check them against a debt service coverage ratio of around 1.5x; see [DSCR explained](/guides/dscr-explained).

## What are the most common LOI mistakes?

- **Price only, structure "to be agreed".** The structure is the deal. Leaving it vague means renegotiating the most important term after the seller thinks you’ve agreed.
- **No working capital clause.** The seller collects every receivable and leaves you an empty account.
- **Exclusivity too short.** Due diligence and financing take time. Run out and the seller can start talking to someone else.
- **Sending it too early.** An LOI the seller wasn’t expecting feels like pressure. Agree the terms in conversation first.
- **Skipping questions you should have asked.** Our list of [questions to ask a business seller](/guides/questions-to-ask-a-business-seller) covers what to cover before you write anything down.

## What happens after the LOI is signed?

Due diligence starts: financial, legal, operational and commercial. You verify the earnings, contracts, staff, licences and assets. The lender completes its credit approval. Lawyers draft the SPA, the seller note and the shareholders’ agreement for the rollover. If due diligence finds problems, the LOI’s conditions let you renegotiate or walk away. Our guide to [due diligence red flags](/guides/due-diligence-red-flags) covers what to look for.

## The 90-day path to a signed LOI

This is how we run it with owners of established $1M+ businesses. It’s done with you, not for you: you are the buyer, so sellers and lenders need to deal with you.

**Weeks 1–2: audit and target profile.** We audit your business with you: what you do well, what your team can absorb, what your profit can support. Then we set your target profile, the type and size of business that could double or triple yours. Often that’s a competitor, or an owner nearing retirement in your industry.

**Weeks 3–8: outreach.** You contact owners, both listed and off market, using our scripts, and we coach every conversation. Most of the best targets aren’t for sale until someone asks. See [how to find off-market businesses for sale](/guides/find-off-market-businesses-for-sale).

**Weeks 9–13: negotiation, financing and the LOI.** We’re in the room as you negotiate. We line up the financing with you so the structure is credible before you put it in writing. Then you sign the LOI.

The promise is a signed LOI within 90 days, and it comes with a 7-day money-back guarantee. Settlement follows after due diligence and lender approval, which runs on its own timeline.

> This guide is general information, not financial, legal or tax advice. Have a lawyer review any LOI before you sign it.

## Want a signed LOI in 90 days?

On an acquisition strategy call we look at your business, your market and what your first target could be. [See if you qualify](/).`,
    faqs: [
      {
        q: 'Is a letter of intent to buy a business binding?',
        a: 'The commercial terms, like price and structure, are usually non-binding. Clauses for confidentiality, exclusivity and sometimes costs are usually binding, and the LOI should say which is which.',
      },
      {
        q: 'How long is exclusivity in an LOI?',
        a: 'It is commonly 60 to 90 days, long enough to finish due diligence and financing. Agree an extension mechanism in case the lender or lawyers need more time.',
      },
      {
        q: 'Who writes the letter of intent, the buyer or the seller?',
        a: 'Usually the buyer, because it is effectively an offer. The seller’s adviser will then mark it up before both sides sign.',
      },
      {
        q: 'Can you back out after signing an LOI?',
        a: 'Generally yes, because the main terms are non-binding and subject to conditions like due diligence and financing. You still have to respect the binding clauses, such as confidentiality.',
      },
      {
        q: 'What comes after the LOI when buying a business?',
        a: 'Due diligence, lender credit approval, and the drafting of the sale and purchase agreement, seller note and shareholders’ agreement. Settlement happens once those are complete.',
      },
      {
        q: 'How long does it take to get to a signed LOI?',
        a: 'It varies widely. Our process is built to reach a signed LOI within 90 days: two weeks setting your target profile, six weeks of outreach, and about five weeks negotiating and lining up financing.',
      },
    ],
    related: ['questions-to-ask-a-business-seller', 'due-diligence-red-flags', 'find-off-market-businesses-for-sale', '70-20-10-deal-structure', 'buy-your-competitor'],
    section: 'Finding & closing deals',
    published: '2026-10-14',
    updated: '2026-10-14',
  },

  // ───────────────────────────── buy-your-competitor ─────────────────────────────
  {
    slug: 'buy-your-competitor',
    title: 'Buy Your Competitor: How to Fund It With No Money Down',
    description:
      'How to buy a competitor: why it is the fastest way to double a business, how to approach them, the synergies and risks, and how to fund it with seller finance.',
    h1: 'How to Buy Your Competitor: Approach, Structure and Synergies',
    answer:
      'Buying your competitor means acquiring a business that serves the same customers or market as yours, so its revenue, team and customers join yours in one move. It is often the fastest way to double a business. Owners usually fund it with senior debt, seller finance and seller rollover, so little or none of their own cash goes in.',
    keyPoints: [
      'A competitor acquisition adds customers, staff and profit in one step instead of one sale at a time.',
      'You understand the business better than any outside buyer, which lowers risk and impresses lenders.',
      'Synergies come from shared overheads, cross-selling, buying power and filled capacity.',
      'Approach the owner directly, confidentially, and talk about their future, not your growth.',
      'Fund it with senior debt, seller finance and seller rollover to keep your own cash out.',
    ],
    body: `## Why buy your competitor?

Organic growth adds one customer at a time. Buying a competitor of similar size adds all of theirs on day one: the customers, the staff, the systems and the profit. If you buy a business as big as yours, you can double in a single transaction.

You also have advantages no outside buyer has:

- **You understand the business.** You know the margins, the staff market, the seasonality and the customers. You’ll spot problems in due diligence a financial buyer would miss.
- **You’re credible to lenders.** An operator buying in their own industry is a lower-risk borrower than a first-time buyer.
- **You’re credible to the seller.** Owners want their staff and customers looked after. Someone who already runs the same kind of business is the obvious successor.

## What synergies come from buying a competitor?

**Synergies** are the gains that exist only because the two businesses are combined.

| Synergy | How it works | How confident to be |
|---|---|---|
| Overhead savings | One accounting system, one office manager, one insurance program, one software stack | High; you can see the costs |
| Buying power | Bigger orders, better supplier pricing | Medium; depends on suppliers |
| Filled capacity | Your idle crews or rooms take their overflow, and the reverse | Medium to high |
| Cross-selling | Sell your services to their customers and theirs to yours | Medium; takes time |
| Pricing | Less price competition in a local market | Low; never price a deal on it |
| Management depth | Their senior staff strengthen your team | Varies; retention is the risk |

**Rule we use:** pay for the business as it stands, and treat synergies as your upside. If the deal only works with synergies, it doesn’t work.

## How do you approach a competitor about selling?

Carefully. Owners are understandably suspicious of competitors who suddenly want to talk.

1. **Make it owner to owner.** Contact the owner directly, not through their staff.
2. **Lead with respect.** Acknowledge what they’ve built. Most owners have spent decades on it.
3. **Talk about their future, not your growth.** Retirement, succession, their team, what happens to the business when they step back.
4. **Ask, don’t pitch.** "Have you thought about what happens to the business when you’re ready to step back?" opens more doors than any offer.
5. **Offer confidentiality early,** and sign a non-disclosure agreement before you ask for numbers.
6. **Be patient.** A "not now" today is often a "let’s talk" in six months. Keep in touch.

Our [guide to finding off-market businesses](/guides/find-off-market-businesses-for-sale) covers how to build the list and the outreach cadence.

## How do you pay for a competitor without your own cash?

The same way as any no-money-down acquisition: combine the three parts.

- **Senior debt (commercial debt)** for the largest share, secured over the business’s assets.
- **Seller finance (vendor finance):** the seller is paid part of the price over time from the business’s cash flow.
- **Seller rollover:** the seller keeps a minority stake, which matters more in competitor deals than anywhere else, because it keeps the owner invested in a smooth handover. See [seller rollover explained](/guides/seller-rollover-explained).

**Illustrative only.** You run a $2M-revenue business. A competitor of a similar size, owned by someone nearing retirement, agrees a $1.5M price. Using a [70/20/10 structure](/guides/70-20-10-deal-structure): $1.05M senior debt, a $300k seller note over a few years, and a $150k rollover into a 10% stake. A lender working-capital line on top funds closing costs and a cash buffer. You put no cash in, and combined revenue is roughly double what you started with, before any synergies.

Josh Li bought two of his own clinics with 100% vendor finance, no bank and no equity partner, with each owner paid over time from the clinic’s own cash flow. That works when the seller cares more about the right successor than a lump sum, which is often true of a competitor who respects how you run your business.

## What are the risks of buying a competitor?

- **Customer loss.** Some customers chose them *because* they weren’t you. Keep the brand and key relationships in place for a transition period.
- **Staff loss.** Their best people may assume they’ll be cut. Talk to key staff early (once the seller agrees) and be specific about their future.
- **Culture clash.** Different ways of working cause friction. Integrate systems slowly and people carefully.
- **Information risk.** You’ll see their numbers, and they’ll see yours. Use an NDA and share sensitive data in stages.
- **Competition rules.** In concentrated markets, a merger of competitors may need regulatory clearance. Check the rules in your state or country.
- **Owner dependence.** If customers buy from the owner, not the business, a handover period and rollover stake are essential.

For the full due diligence list, see [due diligence red flags](/guides/due-diligence-red-flags).

## What kills competitor deals?

In our experience, three things: the buyer opens with a lowball number that insults the owner, the buyer talks only about what *they* gain, or the structure leaves the seller unsure when they get paid. Fix all three and most conversations move forward. When they do, the next step is a [letter of intent](/guides/letter-of-intent-buying-a-business).

> This guide is general information, not financial, legal or tax advice. Competition law varies by country; get advice before combining with a direct competitor.

## Want to buy a competitor without your own cash?

On an acquisition strategy call we work out which competitor could double your business and how the deal could be structured. [See if you qualify](/).`,
    faqs: [
      {
        q: 'Is it a good idea to buy a competitor?',
        a: 'Often, yes. You understand the business, lenders see you as a credible buyer, and the combined business can share overheads. The risks are customer and staff loss, which a careful transition plan addresses.',
      },
      {
        q: 'How do I ask a competitor if they want to sell?',
        a: 'Contact the owner directly and confidentially, acknowledge what they’ve built, and ask about their plans for stepping back rather than making an offer. Many owners haven’t been asked before.',
      },
      {
        q: 'How do you value a competitor’s business?',
        a: 'Start from verified, sustainable cash profit and the risk of keeping it, not from synergies. Price the business as it stands and treat any synergies as your upside.',
      },
      {
        q: 'Can I buy a competitor with no money down?',
        a: 'It is possible when senior debt, seller finance and seller rollover together cover the price and a lender adds working capital on top. It depends on the business’s cash flow and the seller’s goals.',
      },
      {
        q: 'Will customers leave if I buy my competitor?',
        a: 'Some may. Keeping the brand, key staff and the seller involved for a transition period reduces the risk, and a seller rollover stake gives the owner a reason to help.',
      },
      {
        q: 'Do I need approval to buy a competitor?',
        a: 'Small deals usually don’t, but larger mergers in concentrated markets may need clearance from a competition regulator. Check the rules in your state or country.',
      },
    ],
    related: ['find-off-market-businesses-for-sale', 'letter-of-intent-buying-a-business', 'how-to-buy-a-business-with-no-money-down', '70-20-10-deal-structure', 'seller-rollover-explained'],
    section: 'Finding & closing deals',
    published: '2026-10-14',
    updated: '2026-10-14',
  },

  // ───────────────────────────── find-off-market-businesses-for-sale ─────────────────────────────
  {
    slug: 'find-off-market-businesses-for-sale',
    title: 'Find Off-Market Businesses for Sale: Where to Look',
    description:
      'How to find off-market businesses for sale: where to look, how to contact owners who aren’t listed, what to say first, and how to spot a seller who is ready.',
    h1: 'How to Find Off-Market Businesses for Sale (and Get Owners to Talk)',
    answer:
      'An off-market business is one whose owner would sell but has not listed it with a broker or advertised it. You find them by building a list of target businesses in your industry and area, then contacting owners directly by phone, letter, email or through mutual contacts, asking about their plans rather than making an offer. Off-market deals usually face less competition and allow more flexible structures.',
    keyPoints: [
      'Many owners who would sell have never listed, and won’t until someone asks.',
      'Off-market means less competition and more room to agree seller finance and rollover.',
      'Build a target list from your own industry: competitors, suppliers’ customers, associations, registers.',
      'Open with a question about the owner’s plans, never with a price.',
      'Consistent follow-up over months finds more deals than one big campaign.',
    ],
    body: `## What does off-market mean?

An **off-market** business is one that isn’t publicly for sale: no broker listing, no advert, no sale process. The owner might be open to selling, may have thought about retiring, or may never have considered it until someone asks.

An **on-market** (listed) business is advertised, usually through a business broker running a process to attract several buyers and push the price up.

Both can work. But for a buyer who wants to fund a deal with seller finance and seller rollover, off-market is usually where the best opportunities are.

## Why are off-market deals better for buyers?

| | On-market (listed) | Off-market |
|---|---|---|
| Competition | Several buyers bidding | Often just you |
| Pace | Set by the broker’s timeline | Set by you and the owner |
| Price | Pushed up by competition | Agreed in conversation |
| Structure | Brokers often push for cash at settlement | Owners are more open to seller finance and rollover |
| Relationship | Through an intermediary | Directly owner to owner |

The structure point matters most. An owner who hasn’t been told "hold out for all cash" is far more likely to consider being paid over time, or keeping a stake. That’s how deals end up funded by senior debt, seller finance and seller rollover with none of the buyer’s cash. See [seller finance explained](/guides/seller-finance-explained).

## Where do you find off-market businesses?

Start inside your own industry. You already know more of the targets than you think.

1. **Your competitors.** List every business doing what you do within your region. Often the best target is one you already respect. See [how to buy your competitor](/guides/buy-your-competitor).
2. **Adjacent businesses.** Companies that serve your customers with a different service, or serve a different area with the same one.
3. **Industry associations and directories.** Member lists, award entrants, conference exhibitors.
4. **Licence and registration lists.** Many trades and professions are registered. Public registers can show who holds a licence and for how long. Check how you are allowed to use that data where you are.
5. **Suppliers and distributors.** They know which owners are slowing down, struggling, or talking about retirement.
6. **Accountants, lawyers and bankers** who advise owners in your industry. They see succession problems first.
7. **Your own customers and staff.** They often know the other operators personally.

## How do you spot an owner who might sell?

Look for signals, not certainty:

- The owner has run the business for a long time and has no obvious successor in the family or team.
- The business looks the same as it did years ago: same website, same vehicles, same branding.
- The owner is still doing frontline work and talks about being tired.
- Partners have split, or one has left.
- The business has stopped growing but remains profitable.

None of these mean the owner wants to sell. They mean a conversation is worth having.

## What do you say to an owner who isn’t selling?

Lead with respect and a question. Never lead with a price.

**Illustrative opening message:**

> *"Hi [Name], I run [Your Business] in [area]. I’ve admired what you’ve built at [Their Business] for a while. I’m looking to grow by partnering with or acquiring a well-run business in our industry, and I’m always respectful of the owner’s plans. Have you given any thought to what happens to the business when you eventually step back? Happy to have a confidential coffee, no obligation."*

Why it works: it’s owner to owner, it gives credit, it raises succession without assuming, and it promises confidentiality.

## What is the best outreach process? Step by step

1. **Build a list** of 50–200 target businesses that fit your target profile: size, location, services, likely owner age.
2. **Find the owner’s name** and the best way to reach them directly.
3. **Make first contact** by letter, email, phone or a mutual introduction. Use more than one channel.
4. **Follow up on a schedule.** Most first messages go unanswered. A polite follow-up after a week, then a month, then a quarter, keeps you in mind for when the timing changes.
5. **Hold a first conversation** focused on the owner: their story, their plans, their concerns.
6. **Sign an NDA** before asking for financial information.
7. **Ask the right questions.** See [questions to ask a business seller](/guides/questions-to-ask-a-business-seller).
8. **Agree terms in conversation, then write the LOI.** See [letter of intent for buying a business](/guides/letter-of-intent-buying-a-business).

In our 90-day program, weeks 3–8 are dedicated to this outreach, with our scripts and coaching on every conversation.

## What makes off-market owners say yes?

From the conversations we coach, owners rarely sell for the highest number. They sell to the person they trust with their staff, their customers and their name. Josh Li bought two clinics with 100% vendor finance because the owners cared more about the right successor and a steady income than a lump sum. That’s the same reason [100% vendor finance](/guides/100-percent-vendor-finance) works at all.

The owner-to-owner advantage is real. A business owner who runs a similar company understands the job, speaks the language, and can credibly promise the team will be looked after.

## What are the most common outreach mistakes?

- **Opening with a lowball offer.** It ends the conversation and gets talked about.
- **One message, no follow-up.** Timing is everything; the owner who says no today may be ready next year.
- **Sounding like a private equity firm.** Owners want a successor, not a "platform".
- **Asking for financials on the first call.** Earn trust first.

> This guide is general information, not financial, legal or tax advice. Check privacy and marketing rules where you are before running outreach campaigns.

## Want our outreach scripts and coaching?

On an acquisition strategy call we set your target profile and show how outreach runs inside the 90-day path to a signed LOI. [See if you qualify](/).`,
    faqs: [
      {
        q: 'How do I find a business for sale that isn’t listed?',
        a: 'Build a list of businesses in your industry and area, identify the owners, and contact them directly with a respectful question about their plans. Suppliers, accountants and industry associations often know who is thinking of stepping back.',
      },
      {
        q: 'Are off-market businesses cheaper?',
        a: 'Not necessarily cheaper, but there is usually less competition, so price and structure are agreed in conversation rather than through bidding. That often makes seller finance and rollover easier to agree.',
      },
      {
        q: 'How do you approach a business owner about buying their business?',
        a: 'Contact the owner directly, acknowledge what they have built, and ask whether they have thought about what happens when they step back. Offer a confidential conversation and never open with a price.',
      },
      {
        q: 'How many owners do I need to contact to find a deal?',
        a: 'It varies by industry and market, which is why a list of dozens to a couple of hundred targets and consistent follow-up matter more than any single message.',
      },
      {
        q: 'Should I use a business broker or go off-market?',
        a: 'Both can work. Brokers bring listed businesses with an organised process; off-market outreach finds owners nobody else is talking to, with more flexibility on structure.',
      },
    ],
    related: ['buy-your-competitor', 'questions-to-ask-a-business-seller', 'letter-of-intent-buying-a-business', '100-percent-vendor-finance'],
    section: 'Finding & closing deals',
    published: '2026-10-14',
    updated: '2026-10-14',
  },

  // ───────────────────────────── questions-to-ask-a-business-seller ─────────────────────────────
  {
    slug: 'questions-to-ask-a-business-seller',
    title: 'Questions to Ask a Business Seller: 40 Before You Buy',
    description:
      'The questions to ask a business seller before you make an offer: motivation, financials, customers, staff, operations, legal and deal structure. For buyers.',
    h1: 'Questions to Ask a Business Seller Before You Make an Offer',
    answer:
      'The most important questions to ask a business seller cover five areas: why they are selling, how reliable the earnings are, how dependent the business is on the owner and key customers, what legal or operational issues exist, and how they want to be paid. The answers tell you whether the business is worth buying and whether seller finance or seller rollover is realistic.',
    keyPoints: [
      'Start with motivation: why they’re selling shapes the whole deal.',
      'Verify earnings and add-backs against bank statements and tax returns.',
      'Test owner dependence and customer concentration early.',
      'Ask how they want to be paid before you talk about price.',
      'Ask open questions and listen. The best information comes from follow-ups.',
    ],
    body: `## Why do the right questions matter?

Most deals are won or lost in the first few conversations. Ask good questions and you learn what the seller really wants, where the risks are, and whether a structure with seller finance and seller rollover will fly. Ask poor ones, or none, and you find out in due diligence, after you’ve spent money.

Group your questions by stage. Some belong in the first coffee. Others come after an NDA (non-disclosure agreement) is signed.

## First conversation: why are they selling?

The seller’s motivation decides almost everything else: price, timing and how they want to be paid.

1. What made you start thinking about selling?
2. What would you like to be doing in two or three years?
3. What matters most to you in who takes over?
4. How important is it that your staff are looked after?
5. Have you spoken to anyone else about buying the business?
6. What would a good outcome look like for you, beyond the price?

**What you’re listening for:** a seller who talks about legacy, staff and a steady income is a strong candidate for seller finance and rollover. A seller who only talks about a number has usually been advised to run a sale process.

## The numbers: how reliable are the earnings?

Ask once the NDA is signed.

7. What were revenue and profit for each of the last three years?
8. Can we see the tax returns and bank statements for the same period?
9. What add-backs have you made, and can you show evidence for each? (An **add-back** is a cost added back to profit because it won’t continue under a new owner.)
10. How much do you pay yourself, and what work do you do for it?
11. Are there any costs that run through the business but are personal?
12. How seasonal is the business, month to month?
13. What’s owed to the business, and how long do customers take to pay?
14. What’s owed by the business: loans, leases, tax, suppliers?
15. What capital spending is due in the next two years?

These answers feed the **debt service coverage ratio (DSCR)**, which decides how much debt the business can carry. See [DSCR explained](/guides/dscr-explained).

## Customers: is the revenue durable?

16. Who are your ten biggest customers, and what share of revenue does each represent?
17. Are customers on contracts? How long, and can they be transferred to a new owner?
18. How many customers have you lost in the last two years, and why?
19. Do customers buy from the business, or from you personally?
20. How do new customers find you?

## People: who runs the business day to day?

21. Who are your key staff, and how long have they been with you?
22. Would the business run for a month without you?
23. Do key staff know you’re considering selling?
24. Are employment contracts, entitlements and pay records up to date?
25. Who holds the licences or registrations the business needs?

## Operations and assets

26. What systems and software does the business run on?
27. What equipment or vehicles does it own, and how old are they?
28. Is the premises leased? How long is left, and does the landlord have to approve a sale?
29. Are any key supplier agreements dependent on you personally?

## Legal and compliance

30. Are there any current or threatened disputes, claims or complaints?
31. Has the business had any regulatory issues or audits?
32. Are there contracts with **change-of-control** clauses? (A change-of-control clause lets the other party end the contract if ownership changes.)
33. Who owns the intellectual property: the brand, website, software and content?

For the issues these questions should flush out, see [due diligence red flags](/guides/due-diligence-red-flags).

## Deal structure: how do they want to be paid?

Ask these before you put a number on the table.

34. Would you consider being paid part of the price over time from the business’s cash flow? (That’s [seller finance](/guides/seller-finance-explained).)
35. Would you be open to keeping a stake in the business and sharing in its growth? (That’s [seller rollover](/guides/seller-rollover-explained).)
36. How much do you need at settlement, and what would you do with it?
37. How long would you be willing to stay on to hand over?
38. In what role, and for how many days a week?
39. What’s your timeline?
40. Who else needs to be part of the decision: a partner, spouse or adviser?

## How should you ask these questions?

- **Earn the right first.** Motivation questions come before financials.
- **Ask open questions** and follow up with "tell me more about that".
- **Write it down,** and check every answer against documents later.
- **Never argue with an answer in the moment.** Note it and test it in due diligence.

## What answers should worry you?

- Vague or changing numbers.
- Reluctance to share bank statements once an NDA is signed.
- "The customers all deal with me."
- Big add-backs with no evidence.
- A refusal to consider any form of payment over time, combined with a high price.

## What makes sellers say yes?

In our experience it’s the buyer who asked about *their* plans first. Josh Li bought two clinics with 100% seller finance because the owners trusted him with what they’d built. Questions that show you care about the staff and customers earn that trust far faster than questions about the price. When the answers line up, move to a [letter of intent](/guides/letter-of-intent-buying-a-business).

> This guide is general information, not financial, legal or tax advice.

## Want help running these conversations?

On an acquisition strategy call we look at your business and map your first target. We’re in the room for the conversations that matter. [See if you qualify](/).`,
    faqs: [
      {
        q: 'What is the first question to ask a business seller?',
        a: 'Ask why they are selling and what they want to be doing afterwards. Their motivation shapes the price, timing and whether seller finance or rollover will work.',
      },
      {
        q: 'What financial documents should I ask a seller for?',
        a: 'At least three years of profit and loss statements, balance sheets, tax returns and bank statements, plus evidence for every add-back. Ask once an NDA is signed.',
      },
      {
        q: 'How do I ask a seller about seller financing?',
        a: 'Ask whether they would consider being paid part of the price over time from the business’s cash flow, and how much they need at settlement. Ask before you discuss price.',
      },
      {
        q: 'What questions reveal owner dependence?',
        a: 'Ask whether the business would run for a month without them, whether customers buy from them personally, and who holds the licences. Vague answers suggest high dependence.',
      },
      {
        q: 'When should I sign an NDA with a seller?',
        a: 'Before you ask for any financial or customer information. First conversations about motivation and plans don’t need one.',
      },
      {
        q: 'What should I ask about staff when buying a business?',
        a: 'Ask who the key people are, how long they have been there, whether they know about the sale, and whether contracts and entitlements are up to date.',
      },
    ],
    related: ['due-diligence-red-flags', 'letter-of-intent-buying-a-business', 'seller-finance-explained', 'dscr-explained'],
    section: 'Finding & closing deals',
    published: '2026-10-14',
    updated: '2026-10-14',
  },

  // ───────────────────────────── due-diligence-red-flags ─────────────────────────────
  {
    slug: 'due-diligence-red-flags',
    title: 'Due Diligence Red Flags: What to Check Before You Buy',
    description:
      'The due diligence red flags that matter when buying a business: earnings, customers, staff, legal and operations, and what to do when you find one. For buyers.',
    h1: 'Due Diligence Red Flags When Buying a Business (and What to Do About Them)',
    answer:
      'Due diligence red flags are findings that suggest a business is worth less, or riskier, than the seller has presented. The most common are earnings that don’t match bank statements, add-backs without evidence, heavy dependence on one customer or the owner, contracts that end on a change of ownership, deferred equipment spending, and undisclosed debts or disputes.',
    keyPoints: [
      'Due diligence checks that the business you priced is the business you’re buying.',
      'The most common red flag: earnings that don’t reconcile to bank statements and tax returns.',
      'Owner dependence and customer concentration are the risks most often underestimated.',
      'A red flag doesn’t always kill a deal; it can change the price or the structure.',
      'Shifting value into seller finance or seller rollover makes the seller share the risk.',
    ],
    body: `## What is due diligence?

**Due diligence** is the investigation a buyer does after signing a letter of intent and before committing to the purchase. It checks the financials, contracts, staff, assets, legal position and operations against what the seller has told you.

A **red flag** is anything that suggests the business is worth less, or carries more risk, than presented. Finding one is the point of due diligence. Ignoring one is how buyers end up overpaying.

## What are the biggest financial red flags?

1. **Earnings that don’t reconcile.** Profit and loss figures that don’t match bank deposits or tax returns. Always rebuild revenue from the bank statements.
2. **Add-backs without evidence.** An **add-back** is a cost the seller says won’t continue, added back to profit. Every one needs a receipt, an invoice, or a clear reason. Be wary of add-backs that are really ongoing costs.
3. **An underpaid owner.** If the owner works 60 hours a week for a small salary, you’ll need to pay someone a market rate to replace them. That comes straight off the earnings.
4. **Revenue spikes before sale.** A sudden lift in the final year can mean pulled-forward sales or delayed costs.
5. **Working capital games.** Receivables collected early, suppliers paid late, or stock run down just before settlement.
6. **Deferred capital spending.** Equipment, vehicles or software that are overdue for replacement. That bill becomes yours.
7. **Unrecorded liabilities.** Tax arrears, staff entitlements, supplier disputes, or loans not on the balance sheet.

Each one changes your **debt service coverage ratio (DSCR)**: the cash available to repay debt divided by annual repayments. See [DSCR explained](/guides/dscr-explained).

## What are the customer and revenue red flags?

- **Customer concentration.** One customer, or a handful, making up a large share of revenue. If they leave, so does the profit.
- **Contracts that can’t be transferred.** Customer agreements with **change-of-control** clauses, meaning the customer can walk away when ownership changes.
- **Rising churn.** Customers leaving at a faster rate recently.
- **Relationships held by the owner.** Customers who buy from the person, not the business.
- **Pricing well above or below the market** that you can’t explain.

## What are the people red flags?

- **Key-person dependence.** One person, often the owner, holds the know-how, the licence or the relationships.
- **Staff who don’t know** about a sale and may leave when they find out.
- **Staff paid off the books,** misclassified as contractors, or owed entitlements.
- **High turnover** that the seller can’t explain.

## What are the legal and operational red flags?

- **Leases** close to expiry, with no renewal option, or that need landlord consent the landlord may refuse.
- **Licences and registrations** held personally by the seller, which may not transfer. Check the rules in your state or country for your industry.
- **Current or threatened disputes,** claims, complaints or regulator inquiries.
- **Intellectual property** (the brand, website, software) owned by the seller personally, not the business.
- **Compliance gaps:** safety, privacy, industry rules.

## Red flags at a glance

| Red flag | What it usually means | Typical response |
|---|---|---|
| Earnings don’t match bank | Earnings are overstated | Re-price on verified earnings |
| Unproven add-backs | Real profit is lower | Exclude them from the valuation |
| One customer is a large share | Revenue is fragile | Earn-out or bigger seller note |
| Owner holds relationships | Goodwill may not transfer | Longer handover and seller rollover |
| Change-of-control clauses | Contracts may end | Get consents before settlement |
| Deferred capex | Hidden future cost | Reduce price or fund it in the deal |
| Undisclosed liabilities | Debts become yours | Indemnity, retention or walk away |

## What should you do when you find a red flag?

A red flag isn’t automatically a deal-killer. You have five options:

1. **Ask.** Many issues have a reasonable explanation. Get it in writing, with evidence.
2. **Re-price.** Adjust the price to the verified numbers.
3. **Restructure.** Move more of the price into **seller finance** (paid over time) or **seller rollover** (a stake the seller keeps). If the earnings don’t hold up, the seller shares the downside instead of you carrying it alone. See [seller finance explained](/guides/seller-finance-explained) and [seller rollover explained](/guides/seller-rollover-explained).
4. **Protect.** Use warranties (promises in the contract), indemnities (the seller covers specific losses) or a retention (part of the price held back for a period).
5. **Walk away.** If the issue goes to the heart of the business, or the seller hid it, this is often the right call.

Restructuring is the most underused option. A senior debt, seller finance and seller rollover mix lets you keep a good business with a fixable problem, at a structure that still pays for itself.

## How do you run due diligence? Step by step

1. **Start before the LOI.** Good [questions to ask a business seller](/guides/questions-to-ask-a-business-seller) surface most issues early.
2. **Make the LOI conditional** on satisfactory due diligence and financing. See [letter of intent for buying a business](/guides/letter-of-intent-buying-a-business).
3. **Rebuild the financials** from bank statements and tax returns.
4. **Review every material contract:** customers, suppliers, leases, staff, licences.
5. **Meet key staff and, where the seller agrees, key customers.**
6. **Inspect the assets** and get a view on equipment age and condition.
7. **Get professional help:** an accountant for the numbers, a lawyer for the contracts.
8. **Write down every finding** and decide: accept, re-price, restructure, protect or walk.

## What red flags kill deals?

In the deals we work on, the issue that most often ends things isn’t a bad number. It’s a seller who hid it. A problem disclosed early is a negotiation. A problem discovered late is a trust issue, and trust is what seller finance runs on. If you’re buying a competitor, you know the business well enough to spot most of these yourself; see [how to buy your competitor](/guides/buy-your-competitor).

> This guide is general information, not financial, legal or tax advice. Use qualified advisers for due diligence on any real transaction.

## Want help structuring around what due diligence finds?

On an acquisition strategy call we look at your target and how the deal could be structured so it still pays for itself. [See if you qualify](/).`,
    faqs: [
      {
        q: 'What are red flags in due diligence?',
        a: 'Findings that suggest the business is worth less, or riskier, than presented: earnings that don’t match the bank, unproven add-backs, customer concentration, owner dependence, non-transferable contracts and hidden liabilities.',
      },
      {
        q: 'How long does due diligence take when buying a business?',
        a: 'It commonly takes several weeks to a few months, depending on the size of the business, how organised its records are and how quickly the lender works. Set exclusivity in the LOI to cover it.',
      },
      {
        q: 'What is an add-back in business valuation?',
        a: 'An add-back is a cost added back to profit because it won’t continue under the new owner, such as a one-off legal bill or the owner’s personal expenses. Each one should be backed by evidence.',
      },
      {
        q: 'Can I renegotiate the price after due diligence?',
        a: 'Yes, if due diligence finds something material. The LOI’s price is usually non-binding, so you can re-price, restructure or walk away based on what you find.',
      },
      {
        q: 'What is customer concentration risk?',
        a: 'It is the risk that a large share of revenue comes from one or a few customers, so losing one would hurt profit badly. It is commonly handled with a lower price, an earn-out or a larger seller note.',
      },
      {
        q: 'Do I need an accountant and lawyer for due diligence?',
        a: 'For any meaningful acquisition, yes. An accountant verifies the numbers and a lawyer reviews contracts, leases, licences and liabilities.',
      },
    ],
    related: ['questions-to-ask-a-business-seller', 'letter-of-intent-buying-a-business', 'dscr-explained', 'seller-finance-explained', 'buy-your-competitor'],
    section: 'Finding & closing deals',
    published: '2026-10-14',
    updated: '2026-10-14',
  },
];
