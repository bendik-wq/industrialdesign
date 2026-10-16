import type { TemplateCtx } from '../integrations/templates';
import { type PW, type PwOrder, guide, illustrative, seat, session, whenLine } from './prewebinar-kit';

/**
 * Pre-webinar run, block D (days 10–12 of 14): the doubts. Each email names one real objection
 * an owner carries into the session (time, risk, the bank, capital, sellers, brokers, a nervous
 * partner, timing, "too good to be true") and moves it with a mechanism, a belief shift or an
 * identity shift, then points back to the session. No invented proof, no invented urgency.
 */

/** Their calendar link when we have one, otherwise their personal link to the session. */
const cal = (c: TemplateCtx, label = 'Put it in my calendar →') => {
  const g = session(c).google;
  return g ? { label, href: g } : seat(c, 'Save my link →');
};

export const PW_D: Record<string, PW> = {
  // ── Day 10: time, risk, the bank, capital, sellers ──
  wp_d_two_businesses: (c) => ({
    subject: 'i don’t have time to run two businesses',
    preheader: 'You won’t be running it. That’s the whole point of how it’s bought.',
    body: [
      `${c.name},`,
      'The doubt I hear first, every time: “I can barely keep up with one business. How would I run two?”',
      'You wouldn’t. The owners who build groups don’t run the businesses they buy day to day.<br>They buy businesses with a manager or a second tier already in place, keep the seller involved through the transition, and sit above it as the owner.',
      'Your job changes from doing the work to choosing the deals and holding the people accountable. That’s a different job, and in the session I’ll show you what it looks like week to week.',
    ],
    cta: seat(c, 'Save my link →'),
    ps: 'If a target only works with you inside it full time, that’s one of the deals we walk away from.',
  }),
  wp_d_hours_already: (c) => ({
    subject: 'the hours you’re already spending',
    preheader: 'Time is the argument for buying, not against it.',
    body: [
      `${c.name},`,
      'Count the hours you spend this week on work someone else could do for you.',
      'Every one of those hours is the ceiling on your current business. Growing it organically means more of them.',
      'Buying a business that comes with its own team is the one way to add revenue without adding your own hours to it. Time is the reason to look at an acquisition, and I’ll walk through how the handover is structured in the session.',
    ],
    cta: cal(c),
  }),
  wp_d_mortgage: (c) => ({
    subject: 'it’s too risky, i have a mortgage',
    preheader: 'A fair worry. Here’s where the risk actually sits in a well built deal.',
    body: [
      `${c.name},`,
      'You have a house, a family and a business that pays for both. Putting any of that on the line for a second company would be reckless.',
      'Which is why the deals we teach are built so the business being bought carries its own weight. They’re bought through a holding company, with a separate entity for each acquisition, and funded on the target’s cash flow: commercial debt, seller finance and seller rollover.',
      'What a lender asks of you personally is a conversation for your own lawyer and accountant on each deal. The session shows you how the structure is set up so you walk into that conversation knowing what to ask for.',
    ],
    cta: seat(c, 'Show me the structure →'),
    ps: 'This is education, not legal, tax or financial advice.',
  }),
  wp_d_risk_standing_still: (c) => ({
    subject: 'the risk nobody puts on the list',
    preheader: 'Standing still has a cost too. It just doesn’t send you an invoice.',
    body: [
      `${c.name},`,
      'When owners weigh up an acquisition, they list every risk of doing the deal and none of the risk of staying put.',
      'One business means one customer base, one key staff member who can leave, one competitor who can undercut you. A group spreads that.',
      'The guardrail on the deal side is simple. If the target’s profit doesn’t cover all the repayments about 1.5 times, we don’t buy it. I’ll show you that test with real mechanics in the session.',
    ],
    cta: guide(c, 'dscr-explained', 'How the 1.5x test works →'),
  }),
  wp_d_bank_said_no: (c) => ({
    subject: 'my bank already said no',
    preheader: 'Banks don’t reject buyers. They reject structures.',
    body: [
      `${c.name},`,
      'If you’ve already asked your bank and been turned down, I’d want to know what you put in front of them.',
      'Most owners ask for a loan against themselves: their savings, their house, their current business. For an acquisition, that’s the wrong application.',
      'A lender funding a purchase reads the target’s cash flow, the coverage on the repayments, and how much the seller is carrying through a note and a rollover stake. Change the structure and you change the answer, and that’s exactly what the session walks through.',
    ],
    cta: seat(c),
    ps: 'A no on one structure says nothing about the next one.',
  }),
  wp_d_wrong_desk: (c) => ({
    subject: 'you asked the wrong question',
    preheader: 'A personal loan and an acquisition loan are assessed differently.',
    body: [
      `${c.name}, a short one.`,
      'When you ask a bank for money, it assesses whatever you put in front of it. Ask about you and it judges you.<br>Ask about a business with three years of steady profit, a seller note behind the bank and the owner rolling a stake into the deal, and it judges that.',
      'Same bank. Very different conversation, and I’ll show you how to frame it at the session.',
    ],
    cta: seat(c, 'Keep my link handy →'),
  }),
  wp_d_industry_different: (c) => ({
    subject: 'my industry is different',
    preheader: 'The details change. The mechanics don’t.',
    body: [
      `${c.name},`,
      'Every owner I speak to says their industry is different. They’re right about the details: the margins, the licences, the way customers buy.',
      'The mechanics underneath stay the same in every one. A lender looks at the cash flow and the coverage, and the seller wants to feel safe handing over what they built. Commercial debt, seller finance and seller rollover fund the price whether it’s clinics, trades or logistics.',
      'I run a healthcare group. Healthcare is supposedly “different” too, and I bought my clinics with 100% vendor finance.',
    ],
    cta: seat(c, 'See the mechanics →'),
    ps: 'Bring your industry to the session and test the model against it.',
  }),
  wp_d_industry_edge: (c) => ({
    subject: 'your industry is your edge',
    preheader: 'To a seller and a lender, you’re the safest buyer in the room.',
    body: [
      `${c.name},`,
      'The thing you think makes your industry hard to buy into is the thing that makes you the right buyer.',
      'You know what a good operator in your field looks like. You know which customers are sticky, which staff matter, and which numbers lie.',
      'A retiring owner would rather hand the business to someone who understands it than to a fund with a spreadsheet. The session shows how to turn that into an offer they take seriously.',
    ],
    cta: guide(c, 'buy-your-competitor', 'Read: buying your competitor →'),
  }),
  wp_d_no_capital: (c) => ({
    subject: 'i don’t have the capital',
    preheader: 'You don’t need it. The business pays for itself.',
    body: [
      `${c.name},`,
      'Here is a stack on a $2M purchase, <strong>illustrative</strong>:',
      '• Commercial debt against the target’s cash flow: $1.2M<br>• Seller finance, paid over a few years: $500k<br>• Seller rollover, the stake the owner keeps: $300k',
      'Your savings aren’t on that list. The price is funded by the business being bought and by a seller who stays invested in it, and the session walks through each piece of the stack and when it applies.',
      illustrative,
    ],
    cta: guide(c, 'how-to-buy-a-business-with-no-money-down', 'How no money down works →'),
  }),
  wp_d_costs_honest: (c) => ({
    subject: 'what it does cost you',
    preheader: 'No money down still has costs. Here’s the honest list.',
    body: [
      `${c.name},`,
      'No money down doesn’t mean no costs. There are accountants for due diligence, M&A lawyers for the contracts, and the business needs cash to run in its first months.',
      'Those get planned for. A working-capital line sits beside the purchase debt, and the fees are budgeted before you sign anything.',
      'I’d rather you hear that from me now than discover it halfway through a deal. In the session I’ll show where each cost lands in the structure.',
    ],
    cta: seat(c),
    ps: 'Anyone who tells you a deal costs nothing is selling something.',
  }),
  wp_d_all_cash: (c) => ({
    subject: 'sellers want all cash',
    preheader: 'They want safety. Cash is just the version they’ve heard of.',
    body: [
      `${c.name},`,
      'Ask a seller what they want and they’ll say cash. Spend an hour with them and you hear what they mean: a fair price, certainty it will settle, and their staff and customers looked after.',
      'A seller note can pay a better price over time. A rollover stake lets them share in what you build next, and keeping them involved through the transition protects the legacy they care about.',
      'All cash is one answer to what they want, and the session shows you the conversation that offers them a better one.',
    ],
    cta: guide(c, 'seller-finance-explained', 'Read the seller finance guide →'),
  }),
  wp_d_all_cash_bidders: (c) => ({
    subject: 'how many cash buyers are there, really',
    preheader: 'The all-cash buyer is rarer than sellers think.',
    body: [
      `${c.name},`,
      'Sellers start by asking for cash because they imagine a line of buyers with it.',
      'For a business doing a few million in revenue, that line is short. Most of the buyers who show up need terms of their own, and the seller learns that months into the sale.',
      'The buyer who arrives early with a clear structure, a board behind them and a reason to keep the seller involved is the one who gets taken seriously. I’ll show you how that offer is laid out at the session.',
    ],
    cta: seat(c, 'Save my link →'),
  }),
  wp_d_never_bought: (c) => ({
    subject: 'i’ve never bought anything',
    preheader: 'You’ve done harder things than this already.',
    body: [
      `${c.name},`,
      'You’ve hired people, signed leases, negotiated with suppliers and kept a business profitable through years most owners don’t survive.',
      'Buying a company is a process, and you don’t run it alone. Accountants test the earnings, M&A lawyers write the contracts, and a board lends the credibility a first time buyer doesn’t have yet.',
      'The session lays out that process from the first conversation to settlement, so the first one stops being a mystery.',
    ],
    cta: cal(c),
  }),
  wp_d_first_deal: (c) => ({
    subject: 'everyone’s first deal looks like this',
    preheader: 'No track record, no fund, and a seller who still said yes.',
    body: [
      `${c.name},`,
      'Every owner with a group of companies once owned exactly one. The step from one to two is the one everyone takes without a track record.',
      'When I bought my clinics, they were funded with 100% vendor finance. What got the sellers over the line was how the deal was structured and who stood behind it, rather than a big balance sheet.',
      'That’s what I’ll take you through at the session.',
    ],
    cta: guide(c, '100-percent-vendor-finance', 'How 100% vendor finance works →'),
    ps: whenLine(c),
  }),
  wp_d_falls_over: (c) => ({
    subject: 'what if the deal falls over',
    preheader: 'Some will. That’s the process working.',
    body: [
      `${c.name},`,
      'Some deals fall over. Due diligence exists to find the reasons a deal shouldn’t happen, before you’ve signed anything that binds you.',
      'Financials that don’t match the tax returns, one customer carrying the revenue, a seller who won’t stay for the handover. When we find those, we walk.',
      'A deal that dies in diligence is the system protecting you. In the session I’ll show you the red flags we look for first.',
    ],
    cta: guide(c, 'due-diligence-red-flags', 'The red flags we walk from →'),
  }),

  // ── Day 11: after settlement, brokers, partners, timing, trust, going alone ──
  wp_d_after_settlement: (c) => ({
    subject: 'and if it goes wrong after settlement',
    preheader: 'Why the seller has every reason to make it work.',
    body: [
      `${c.name},`,
      'The other version of that worry: the deal closes, and then the business underperforms.',
      'Look at who carries that with you. A seller holding a note gets paid out of the business’s performance, and a seller who rolled part of the price into a stake only does well if the business does.',
      'That alignment is designed in on purpose, alongside the commercial debt. I’ll show you how it’s set up in the session.',
    ],
    cta: guide(c, 'seller-rollover-explained', 'How seller rollover works →'),
  }),
  wp_d_broker_junk: (c) => ({
    subject: 'brokers only show me junk',
    preheader: 'You’re looking at what’s left.',
    body: [
      `${c.name},`,
      'If you’ve browsed listings and walked away thinking everything for sale is overpriced or broken, your read is accurate.',
      'The best businesses get sold to someone the owner already knows, long before a broker lists them. What reaches the open market is what didn’t sell that way.',
      'The owners building groups go direct to the owner, off market, and the session shows you how that first approach is made.',
    ],
    cta: guide(c, 'find-off-market-businesses-for-sale', 'How to find off-market deals →'),
  }),
  wp_d_broker_incentive: (c) => ({
    subject: 'who the broker works for',
    preheader: 'It isn’t you.',
    body: [
      `${c.name}, worth knowing before you call another broker.`,
      'The broker is paid by the seller. Their job is the highest price, in cash, from whoever can close fastest.',
      'A buyer offering a structure with seller finance and a rollover stake is extra work for them, so you get pushed down the list. Going direct removes the middle of that conversation, and that’s the approach I’ll walk you through live.',
    ],
    cta: seat(c),
  }),
  wp_d_partner_nervous: (c) => ({
    subject: 'if your partner is nervous',
    preheader: 'Watch it together. Seriously.',
    body: [
      `${c.name},`,
      'If you’ve mentioned buying another business at home and got a worried look back, that’s a reasonable reaction. Your partner hears “more debt, more hours, more risk”.',
      `So bring them. Sit down together for ${session(c).title} and let them hear the mechanics directly: who lends against what, where the risk sits, and why we walk away from deals that don’t pass the test.`,
      'A decision you make together is a far better one than a decision you have to sell later.',
    ],
    cta: cal(c, 'Put it in both our calendars →'),
    ps: 'Same link works for both of you.',
  }),
  wp_d_partner_questions: (c) => ({
    subject: 'the questions they’ll ask you',
    preheader: 'Your partner’s questions are the session agenda.',
    body: [
      `${c.name},`,
      'Here are the questions a nervous partner asks: what happens to the house, where the time comes from, and what if it doesn’t work.',
      'Each one has a real answer, and each one gets covered in the session. The holding company structure, the team that runs the business, and the coverage test that decides whether a deal gets bought at all.',
      'Write their questions down and have them in front of you on the night. Better still, have them sitting next to you.',
    ],
    cta: seat(c, 'Save our link →'),
  }),
  wp_d_not_right_time: (c) => ({
    subject: 'now isn’t the right time',
    preheader: 'There’s an honest cost to waiting. Here it is.',
    body: [
      `${c.name},`,
      'Maybe it isn’t the right time to buy. I can’t tell that from here, and I won’t pretend there’s a deadline.',
      'What I can tell you is what waiting costs. The competitor you’d buy keeps being bought by someone else, the owners near retirement keep retiring, and your own ceiling stays where it is.',
      'Learning how the structure works costs you an hour. Whether you act on it this year or in three, you decide with the facts in hand.',
    ],
    cta: seat(c),
    ps: whenLine(c),
  }),
  wp_d_wait_for_rates: (c) => ({
    subject: 'waiting for rates to come down',
    preheader: 'A deal either clears the test at today’s rates or it doesn’t.',
    body: [
      `${c.name},`,
      'Owners tell me they’ll look once rates fall. Rates change what a lender charges; they don’t change how a deal is assessed.',
      'If the target’s profit covers the repayments about 1.5 times at today’s rate, the deal works today. If it doesn’t, we don’t buy it, and a lower rate later just widens the margin.',
      'The session shows you how to run that test on any business, at any rate.',
    ],
    cta: guide(c, 'dscr-explained', 'Run the coverage test →'),
  }),
  wp_d_too_good: (c) => ({
    subject: 'is this too good to be true',
    preheader: 'The mechanics are ordinary. That’s why they work.',
    body: [
      `${c.name},`,
      'When someone says “buy a business with no money down”, the right reaction is suspicion.',
      'Here’s what sits underneath it: commercial lending against a business’s cash flow, which banks do every day. Seller finance, which is a seller agreeing to be paid part of the price over time. Seller rollover, where the owner keeps a stake.',
      'None of that is new or secret. In the session I’ll show you each piece on screen, and you can judge it for yourself.',
    ],
    cta: seat(c, 'Show me the mechanics →'),
  }),
  wp_d_the_catch: (c) => ({
    subject: 'the catch',
    preheader: 'There is one. It’s work.',
    body: [
      `${c.name}, you asked for the catch, so here it is.`,
      'Finding a good business takes conversations with a lot of owners. Qualifying them takes three years of financials and an honest look at each one, and you’ll walk away from more deals than you buy.',
      'The money is the part people fear. The work is the part that decides it, and the session shows you how that work is organised.',
    ],
    cta: seat(c),
  }),
  wp_d_done_it_by_now: (c) => ({
    subject: 'if you could, you would have',
    preheader: 'Which says something about the method, not about you.',
    body: [
      `${c.name},`,
      'You’re smart, you run a profitable business, and you’ve thought about buying another one for a while. If you could have done it alone, you’d have done it by now.',
      'That isn’t a criticism. The method you had was saving a deposit or raising money and giving up control, and both of those stall.',
      'What was missing was a different way to fund it and a team behind you. That’s what the session is about.',
    ],
    cta: cal(c),
  }),
  wp_d_board: (c) => ({
    subject: 'the part you can’t do alone',
    preheader: 'Credibility is borrowed before it’s earned.',
    body: [
      `${c.name},`,
      'A seller handing over 30 years of work wants to know who’s behind the buyer.',
      'That’s why the owners who close deals put a board around them first: a chair, a finance lead, a legal lead and an operator from the sector. Add top-tier accountants and M&A lawyers, and a first time buyer looks like a safe pair of hands.',
      'I’ll show you how that board gets assembled, and why it matters more than your bank balance.',
    ],
    cta: seat(c, 'Save my link →'),
  }),
  wp_d_told_deposit: (c) => ({
    subject: 'you were told you need a deposit',
    preheader: 'That rule comes from buying houses.',
    body: [
      `${c.name},`,
      'Somewhere along the way you were told that to buy a business you need 20% or 30% down. That’s how a home loan works, and people assume a business is the same.',
      'A business produces cash. A lender funds part of the price against that cash, the seller carries part as a note, and the seller’s rollover stake covers more.',
      'The deposit rule is the first thing the session takes apart.',
    ],
    cta: guide(c, 'over-financed-acquisition', 'Read: the over-financed deal →'),
  }),
  wp_d_told_banks: (c) => ({
    subject: 'the bank story you grew up with',
    preheader: 'They aren’t the obstacle you were taught they are.',
    body: [
      `${c.name},`,
      'You were told banks don’t lend to people like you for things like this. They lend for acquisitions all the time.',
      'What they won’t fund is a structure that doesn’t hold up: a thin margin, no seller involvement, nobody credible running it. Bring them coverage of about 1.5 times, a seller note and a rollover stake, and you’re having a different meeting.',
      'I’ll go through what a lender reads, in order, at the session.',
    ],
    cta: seat(c),
  }),
  wp_d_told_buyers: (c) => ({
    subject: 'you were told buyers are rich',
    preheader: 'Sellers sell to whoever makes them feel safe.',
    body: [
      `${c.name},`,
      'The story says businesses get bought by funds and rich people with cash sitting around.',
      'Spend time with owners selling a company doing a few million a year and you learn their real criteria. They want someone who will look after the staff, keep the name, and still be standing in five years.',
      'An operator with a board behind them and a fair structure beats a stranger with a cheque more than you’d expect. The session shows you how to be that buyer.',
    ],
    cta: guide(c, 'questions-to-ask-a-business-seller', 'Questions to ask a seller →'),
  }),
  wp_d_old_you: (c) => ({
    subject: 'the old you did fine',
    preheader: 'With the information you had, you made the right calls.',
    body: [
      `${c.name},`,
      'You built a profitable business with the tools you had. You saved, reinvested, and grew it the only way anyone showed you.',
      'That wasn’t a mistake. Nobody handed you the other playbook, the one where a business is bought with its own cash flow, a seller note and a seller rollover.',
      'You’re allowed to keep everything that got you here and add the piece you were never shown.',
    ],
    cta: seat(c, 'Save my link →'),
    ps: 'That missing piece is what we cover on the night.',
  }),

  // ── Day 12: the deeper doubts, identity, and the threshold ──
  wp_d_not_numbers: (c) => ({
    subject: 'i’m not a finance person',
    preheader: 'You need one number. I’ll show you which.',
    body: [
      `${c.name},`,
      'Owners put off acquisitions because the finance looks like a foreign language. The core of it is one ratio.',
      'Take a target making $600k a year in profit. If its total repayments come to $400k, profit covers them 1.5 times, and that’s the line a lender looks for (<strong>illustrative</strong>).',
      'Your accountant handles the rest. In the session I’ll run that test on screen so you can do it on a napkin.',
      illustrative,
    ],
    cta: guide(c, 'dscr-explained', 'DSCR in plain words →'),
  }),
  wp_d_seller_trust: (c) => ({
    subject: 'why would a seller trust me',
    preheader: 'Because of what you put in front of them.',
    body: [
      `${c.name},`,
      'You’re asking a stranger to take part of their price later and trust you with what they built. Fair question.',
      'Trust comes from what they can see: a board with real names on it, advisers they’ve heard of, an offer that front-loads what matters to them and keeps them involved through the transition.',
      'The session shows you the credibility packet that does that work before you’ve said a word.',
    ],
    cta: seat(c),
  }),
  wp_d_approach_competitor: (c) => ({
    subject: 'it feels awkward to approach a competitor',
    preheader: 'The conversation is easier than the one in your head.',
    body: [
      `${c.name},`,
      'Calling a competitor to ask whether they’d sell feels like crossing a line. Owners put it off for years, worried about how it will land.',
      'An owner who has been quietly thinking about an exit has nobody to talk to about it. A respectful approach from someone who understands the business lands as a relief, and the worst answer you get is “not now”.',
      'In the session I’ll show you how that first conversation is opened, word for word.',
    ],
    cta: guide(c, 'buy-your-competitor', 'Read: approaching a competitor →'),
  }),
  wp_d_current_business: (c) => ({
    subject: 'what about the business i already have',
    preheader: 'It doesn’t have to carry the new one.',
    body: [
      `${c.name},`,
      'The fear underneath a lot of hesitation is that a second business drags down the first.',
      'Each acquisition sits in its own entity under a holding company and is funded on its own cash flow. Your current business stays your current business.',
      'What changes is that you stop being its only growth plan. I’ll show you how the holdco is laid out in the session.',
    ],
    cta: cal(c),
    ps: 'Structure is education here, not legal or tax advice; your advisers set it up for you.',
  }),
  wp_d_grow_organically: (c) => ({
    subject: 'i’ll just grow it organically',
    preheader: 'You can. Here’s the trade you’re making.',
    body: [
      `${c.name},`,
      'Organic growth is hiring, marketing and waiting, paid for out of this year’s profit and earned back over years.',
      'An acquisition adds a business that’s already profitable, with customers and staff in place, funded by debt against its cash flow, seller finance and seller rollover.',
      'Both are legitimate. Only one adds a whole company’s profit in a single settlement, and the session shows what that looks like.',
    ],
    cta: seat(c, 'Save my link →'),
  }),
  wp_d_overpay: (c) => ({
    subject: 'what if i overpay',
    preheader: 'The price gets tested before you agree to it.',
    body: [
      `${c.name},`,
      'Overpaying is a real risk, and the answer is a process. The price has to pass the coverage test, and diligence centres on the quality of the earnings so you’re paying for profit that stays after the owner leaves.',
      'And there’s a reason buyers who get the process right do well. Small businesses trade at roughly 3 to 5 times profit, while groups of them trade at 8 to 12 times (<strong>illustrative</strong> ranges).',
      'I’ll show you how an indicative offer is built so the economics are settled early.',
      illustrative,
    ],
    cta: guide(c, 'letter-of-intent-buying-a-business', 'How the offer is written →'),
  }),
  wp_d_save_first: (c) => ({
    subject: 'i’ll do it once i’ve saved enough',
    preheader: 'The saving plan has no finish line.',
    body: [
      `${c.name},`,
      'Saving for a deposit feels responsible. In practice the target keeps moving: as your business grows, so do the businesses worth buying, and the deposit you’re saving for grows with them.',
      'The owners who build groups stop waiting for the number. They fund the purchase with the target’s own cash flow, a seller note and a seller rollover stake.',
      'The session shows how, so your savings can stay where they are.',
    ],
    cta: seat(c),
  }),
  wp_d_seen_webinars: (c) => ({
    subject: 'i’ve sat through webinars like this',
    preheader: 'So have I. Here’s what this one is.',
    body: [
      `${c.name},`,
      'You’ve probably sat through an hour of hype that ended with a hard sell. I have too.',
      `${session(c).title} is the mechanics: how lenders assess a deal, how seller finance and rollover fit with commercial debt, how off market deals are found, and when to walk.`,
      'At the end I’ll tell you how we work with owners, briefly. Judge the hour on what you learn before that.',
    ],
    cta: seat(c, 'Hold my link →'),
  }),
  wp_d_replay_instead: (c) => ({
    subject: 'i’ll just catch the replay',
    preheader: 'You can. Here’s why live is better for you.',
    body: [
      `${c.name},`,
      `There is a replay, and it stays up for ${session(c).replayHours} hours after the session. If live doesn’t work, use it.`,
      'Live is better for one reason: you can ask about your own situation, your industry and your doubts, and get an answer that day.',
      'The doubts you’ve read about this week are exactly the questions worth asking in the room.',
    ],
    cta: cal(c),
    ps: whenLine(c),
  }),
  wp_d_not_ready: (c) => ({
    subject: 'i’m not ready to buy anything',
    preheader: 'You don’t need to be. You need to know the options.',
    body: [
      `${c.name},`,
      'Nobody needs to be ready to buy a business to sit through an hour about how it’s done.',
      'Being ready comes later, once you know what a lender wants, what a seller wants, and whether a deal in your industry clears the test.',
      'The session is where you get that information. What you do with it is your call.',
    ],
    cta: seat(c, 'Save my link →'),
  }),
  wp_d_permission: (c) => ({
    subject: 'permission to want more',
    preheader: 'Wanting a group of companies isn’t greed.',
    body: [
      `${c.name},`,
      'Some owners feel they should be grateful for one profitable business and stop there.',
      'Wanting a group isn’t ingratitude. It’s wanting the staff you hire to have somewhere to grow, the retiring owner down the road to have a buyer, and your own time back.',
      'Consider this your permission to take a serious look at it, starting with the session.',
    ],
    cta: seat(c),
  }),
  wp_d_already_know: (c) => ({
    subject: 'you already know how to do the hard part',
    preheader: 'Running a profitable business is the hard part.',
    body: [
      `${c.name},`,
      'Most people trying to buy a business have never run one. You already have.',
      'You know how to read a P&L, manage people and keep customers. Those are the skills a lender and a seller look for in a buyer.',
      'The funding and the deal process are learnable. That’s the part the session covers.',
    ],
    cta: cal(c),
  }),
  wp_d_owner_of_companies: (c) => ({
    subject: 'from owner of a job to owner of companies',
    preheader: 'The shift that happens after the first deal.',
    body: [
      `${c.name},`,
      'There’s a point where you stop thinking about the business as the thing you work in. You start thinking of it as the first company in a group you own.',
      'Your questions change with it. Who runs this, what does it earn, and what should we buy next.',
      'That shift starts with understanding how the next one is funded. I’ll walk you through that on the night.',
    ],
    cta: seat(c, 'Save my link →'),
  }),
  wp_d_threshold: (c) => ({
    subject: 'the moment before you decide',
    preheader: 'You’re standing at it now.',
    body: [
      `${c.name},`,
      'Every owner who builds a group reaches a point where the doubts are still there, and they show up anyway.',
      'You’ve read through the time worry, the mortgage, the bank, the capital, the sellers and the brokers. None of them disappear by thinking harder about them at home.',
      'The answers are in the session. Be there.',
    ],
    cta: cal(c, 'Lock it into my calendar →'),
    ps: whenLine(c),
  }),
  wp_d_bring_your_doubt: (c) => ({
    subject: 'bring your biggest doubt',
    preheader: 'Write it down. Bring it with you.',
    body: [
      `${c.name}, one thing to do before the session.`,
      'Write down the single reason you think this won’t work for you. Be specific: the industry, the bank, the seller, the money, the time.',
      'Keep it in front of you while I walk through the mechanics, and see whether it survives the hour.',
    ],
    cta: seat(c),
    ps: 'If it does survive, ask it in the room.',
  }),
};

export const PW_D_ORDER: PwOrder = [
  // Day 10
  ['wp_d_two_businesses', 1],
  ['wp_d_hours_already', 3],
  ['wp_d_mortgage', 1],
  ['wp_d_risk_standing_still', 2],
  ['wp_d_bank_said_no', 1],
  ['wp_d_wrong_desk', 3],
  ['wp_d_industry_different', 1],
  ['wp_d_industry_edge', 2],
  ['wp_d_no_capital', 1],
  ['wp_d_costs_honest', 2],
  ['wp_d_all_cash', 1],
  ['wp_d_all_cash_bidders', 3],
  ['wp_d_never_bought', 2],
  ['wp_d_first_deal', 2],
  ['wp_d_falls_over', 2],
  // Day 11
  ['wp_d_after_settlement', 3],
  ['wp_d_broker_junk', 1],
  ['wp_d_broker_incentive', 3],
  ['wp_d_partner_nervous', 1],
  ['wp_d_partner_questions', 2],
  ['wp_d_not_right_time', 1],
  ['wp_d_wait_for_rates', 3],
  ['wp_d_too_good', 1],
  ['wp_d_the_catch', 2],
  ['wp_d_done_it_by_now', 1],
  ['wp_d_board', 2],
  ['wp_d_told_deposit', 2],
  ['wp_d_told_banks', 3],
  ['wp_d_told_buyers', 3],
  ['wp_d_old_you', 2],
  // Day 12
  ['wp_d_not_numbers', 2],
  ['wp_d_seller_trust', 2],
  ['wp_d_approach_competitor', 3],
  ['wp_d_current_business', 3],
  ['wp_d_grow_organically', 3],
  ['wp_d_overpay', 3],
  ['wp_d_save_first', 2],
  ['wp_d_seen_webinars', 2],
  ['wp_d_replay_instead', 2],
  ['wp_d_not_ready', 3],
  ['wp_d_permission', 2],
  ['wp_d_already_know', 3],
  ['wp_d_owner_of_companies', 3],
  ['wp_d_threshold', 1],
  ['wp_d_bring_your_doubt', 1],
];
