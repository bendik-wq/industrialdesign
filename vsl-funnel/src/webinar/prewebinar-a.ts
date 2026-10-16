import { type PW, type PwOrder, guide, illustrative, seat, session, whenLine } from './prewebinar-kit';
import type { TemplateCtx } from '../integrations/templates';

/**
 * Pre-webinar run, block A (days 1–3 of 14): why this session, why you.
 * Welcome, what the session covers, who it is for, Josh’s story (true facts only),
 * the one-business ceiling, organic growth’s speed limit, the saturation frame,
 * the two paths and the third-way tease, and the homework that gets them there live.
 * These emails sell attendance, not the program. The mechanism is teased, never fully taught.
 */

/** Calendar button: their Google Calendar link when we have one, otherwise their session link. */
const cal = (c: TemplateCtx, label = 'Put it in my calendar →') => {
  const g = session(c).google;
  return g ? { label, href: g } : seat(c, label);
};

export const PW_A: Record<string, PW> = {
  // ───────────── Day 1 ─────────────
  wp_a_youre_in: (c) => ({
    subject: 'you’re in',
    preheader: 'Here’s what happens between now and the session.',
    body: [
      `${c.name},`,
      `You’re registered for ${session(c).title}, on ${session(c).when}.`,
      'Over the coming days I’ll send you short notes, one idea each, so you walk in already knowing why this works and how it applies to your business.',
      'Read the ones that catch your eye. The one thing that matters is that you show up live.',
    ],
    cta: seat(c, 'Save my link →'),
    ps: 'Your link is personal to you, so keep this email somewhere you can find it.',
  }),

  wp_a_covers: (c) => ({
    subject: 'what we’ll cover in the session',
    preheader: 'Where the deals are, how they’re funded, and the path to a signed LOI.',
    body: [
      `${c.name},`,
      'Here’s what the session covers, in the order we cover it:',
      '• <strong>Where the off-market deals are.</strong> The businesses that never reach a broker’s list, and how owners like you get in front of them first.<br>• <strong>How the financing is stacked.</strong> Commercial debt, seller finance and seller rollover, arranged so the deal is over-financed and the business pays for itself.<br>• <strong>The 90-day path to a signed LOI.</strong> What you do first, what comes next, and what has to be true before you put an offer in writing.',
      'Each part builds on the one before it, which is why it’s worth being there from the first minute.',
    ],
    cta: seat(c),
    ps: whenLine(c),
  }),

  wp_a_calendar: (c) => ({
    subject: 'put it in your calendar now',
    preheader: 'Thirty seconds now saves you missing it later.',
    body: [
      `${c.name},`,
      'Every owner I know runs on their calendar. If it isn’t in there, it doesn’t happen.',
      `So before this email gets buried, add ${session(c).title} to yours. It runs about ${session(c).durationMin} minutes.`,
    ],
    cta: cal(c),
    ps: `For the record, it’s ${session(c).when}.`,
  }),

  wp_a_for_you: (c) => ({
    subject: 'who this session is built for',
    preheader: 'Owners of profitable businesses doing $1M a year or more.',
    body: [
      `${c.name},`,
      'This session is built for one kind of person: the owner of a profitable business doing $1M or more a year, in the US or Australia, who wants to grow by buying companies.',
      'Competitors, add-ons, a business next door to yours in the supply chain.',
      'You already have the thing lenders and sellers care about most. You’ve built something that works, and you know how to run it.',
      'The session shows you how to use that as the foundation for the next business, and the one after it.',
    ],
    cta: seat(c, 'See you there →'),
  }),

  wp_a_not_for: (c) => ({
    subject: 'this session isn’t for everyone',
    preheader: 'Being honest about the fit saves us both an hour.',
    body: [
      `${c.name},`,
      'This session isn’t for startups, and it isn’t for someone looking for their first ever business idea.',
      'The model runs on an existing, profitable company buying another existing, profitable company. Lenders lend against cash flow that already exists, and sellers hand over what they built to someone who has already run a business.',
      'If that’s you, you’re in the right room.',
    ],
    cta: seat(c),
    ps: 'If you registered for a colleague or partner who owns the business, forward this to them so they get their own link.',
  }),

  wp_a_josh: (c) => ({
    subject: 'how I bought my clinics',
    preheader: 'One true story, and why I run this session.',
    body: [
      `${c.name},`,
      'Quick bit about who you’ll be spending the hour with.',
      'I co-founded G&L M&A Advisory, and I run my own healthcare holding group of clinics.',
      'I bought those clinics with 100% vendor finance. The sellers carried the whole price, so none of it came out of my savings.',
      'That’s the reason I teach this. I’ve sat on the buyer’s side of the table, and I know what it took to get there.',
    ],
    cta: seat(c),
    ps: 'Seller finance is one tool of three, and in the session you’ll see how it sits with commercial debt and seller rollover.',
  }),

  wp_a_ceiling: (c) => ({
    subject: 'the one-business ceiling',
    preheader: 'Why good owners stall at the same point.',
    body: [
      `${c.name},`,
      'There’s a point most owners hit somewhere past the first million. The business is good, profitable, well run… and it stops growing faster than you can personally push it.',
      'That’s the one-business ceiling. Every new dollar depends on you, your hours and your attention.',
      'And the owners who break through it do one thing differently: they stop trying to squeeze more out of one company and start adding companies.',
      'The session shows how that’s done without writing a cheque from your own savings.',
    ],
    cta: seat(c),
  }),

  wp_a_speed_limit: (c) => ({
    subject: 'organic growth has a speed limit',
    preheader: 'You can only hire, sell and open so fast.',
    body: [
      `${c.name},`,
      'Organic growth is real, and it’s slow by design. A new hire takes months to become productive, and a new location takes a year or more to earn its keep.',
      'Each step depends on the last one paying off before you can afford the next.',
      'Buying an existing business skips that queue. You take on customers, staff and cash flow that are already there, on day one.',
    ],
    cta: seat(c),
    ps: 'That’s the whole reason the session exists: growth at the speed of a signature, funded by the business you buy.',
  }),

  wp_a_saturation: (c) => ({
    subject: 'everyone is fighting over the same deals',
    preheader: 'The listed market is the crowded market.',
    body: [
      `${c.name},`,
      'Most people who want to buy a business start in the same place: the listings sites and the brokers.',
      'Which means they’re all bidding on the same small pile of deals. Prices go up, terms get worse, and the buyer with the most cash wins.',
      'The best businesses never make it onto that pile. Their owners sell to someone who approached them directly, quietly, before anyone else knew.',
      'Where those deals are, and how you get to them first, is the first part of the session.',
    ],
    cta: seat(c),
  }),

  wp_a_two_paths: (c) => ({
    subject: 'the two ways owners try to buy',
    preheader: 'And why both of them stall.',
    body: [
      `${c.name},`,
      'When an owner decides to buy a business, they almost always pick one of two paths.',
      '• <strong>Raise capital from investors.</strong> You get the money and give up equity, control and a seat at your own table.<br>• <strong>Save up a big deposit.</strong> You keep control, and you spend years building a pile of cash while the right deal goes to someone else.',
      'Both are slow, and both put the burden on you instead of on the business being bought.',
    ],
    cta: seat(c),
    ps: 'Tomorrow I’ll tell you about the third path.',
  }),

  wp_a_third_way: (c) => ({
    subject: 'there’s a third way',
    preheader: 'Neither investors nor years of saving.',
    body: [
      `${c.name},`,
      'Yesterday I mentioned the two paths most owners take. There is a third one, and it’s the one the people building groups of companies use.',
      'The business you buy carries most of the funding. Commercial debt is lent against its cash flow, the seller finances part of the price, and the seller rolls part of their value into a stake they keep.',
      'How those pieces are arranged, and what makes a lender and a seller both say yes, is what I walk through live.',
    ],
    cta: seat(c, 'Show me the third way →'),
  }),

  wp_a_rich: (c) => ({
    subject: 'owners who buy vs owners who build',
    preheader: 'Two owners, same size business, very different ten years.',
    body: [
      `${c.name},`,
      'Picture two owners with the same $3M business.',
      'The first builds everything from scratch. New hires, new marketing, new locations, each one funded from profit and each one a fresh gamble.',
      'The second buys a competitor with the competitor’s own cash flow, then another. Ten years later one has a slightly bigger job, and the other owns a group of companies run by a team.',
      'The gap between them is one mechanism. That’s what the session is about.',
    ],
    cta: seat(c),
  }),

  wp_a_homework_target: (c) => ({
    subject: 'a small piece of homework',
    preheader: 'Think of one business you’d buy.',
    body: [
      `${c.name},`,
      'Before the session, think of one business you’d buy if the money weren’t the question.',
      'A competitor across town. A supplier you rely on. A business that serves your customers with something you don’t sell yet.',
      'Write the name down and bring it. Everything I show you lands harder when you can apply it to a real company.',
    ],
    cta: seat(c),
    ps: 'If two or three names come to mind, write them all down.',
  }),

  wp_a_block_hour: (c) => ({
    subject: 'block the whole hour',
    preheader: 'Phone face down, door closed.',
    body: [
      `${c.name},`,
      `Treat ${session(c).title} like a board meeting with yourself. Block the full ${session(c).durationMin} minutes, plus ten either side.`,
      'Owners who half watch while answering staff questions get half the value.',
      'The financing part in particular needs your full attention, because it’s the part that changes how you see your own options.',
    ],
    cta: cal(c, 'Block it in my calendar →'),
  }),

  wp_a_one_question: (c) => ({
    subject: 'one question for tonight',
    preheader: 'Worth five minutes before you switch off.',
    body: [
      `${c.name},`,
      'Here’s a question to sit with tonight.',
      'If your business were twice the size in three years, would that come from you working harder, or from you owning more?',
      'The session is about the second answer.',
    ],
    cta: seat(c),
  }),

  // ───────────── Day 2 ─────────────
  wp_a_offmarket: (c) => ({
    subject: 'most good businesses never list',
    preheader: 'Where the off-market deals actually are.',
    body: [
      `${c.name},`,
      'The businesses worth buying are run by owners who aren’t advertising. They’re busy, they’re profitable, and selling is something they think about privately.',
      'When one of those owners gets a respectful, direct approach from a credible buyer, a conversation starts that no broker ever sees.',
      'In the session I show you where to find those owners and how the first approach is made.',
    ],
    cta: seat(c),
    ps: 'Start with your own industry. You already know who’s getting close to retirement.',
  }),

  wp_a_brokers: (c) => ({
    subject: 'what the broker list really is',
    preheader: 'The leftovers, priced for a crowd.',
    body: [
      `${c.name},`,
      'A business on a broker’s list is a business that has been put up for auction.',
      'Every buyer in the market sees it, the price is set for competition, and the seller’s adviser is working to get the most cash on day one.',
      'Off-market, the conversation is different. There’s one buyer, the seller has time, and terms like seller finance and rollover are on the table from the start.',
    ],
    cta: seat(c),
  }),

  wp_a_overfinanced: (c) => ({
    subject: 'what an over-financed deal means',
    preheader: 'The funding can come to more than the price.',
    body: [
      `${c.name},`,
      'Here’s a phrase you’ll hear in the session: over-financed.',
      'It means the stack of commercial debt, seller finance and seller rollover covers the full price, with a working-capital line beside it so the business has cash to run in its first months under you.',
      'It only works when the business’s cash flow can carry the repayments comfortably. In the session I show how that test is done, with the numbers laid out.',
    ],
    cta: seat(c),
    ps: 'Over-financed isn’t a loophole. It’s a structure that has to pass the same lender tests as any other loan.',
  }),

  wp_a_ninety_days: (c) => ({
    subject: 'the 90-day path to a signed LOI',
    preheader: 'From a name on a list to an offer in writing.',
    body: [
      `${c.name},`,
      'An LOI is a letter of intent: the signed document where you and the seller agree the price and the terms before due diligence starts.',
      'In the session I lay out the 90-day path we use to get there. First the list of targets, then the approach, then the numbers, then the offer.',
      'It’s a path, not a promise. Every deal moves at the speed of its own seller, and you’ll see where the time actually goes.',
    ],
    cta: seat(c),
  }),

  wp_a_clinics: (c) => ({
    subject: 'why a seller would carry the price',
    preheader: 'The part of my own story people ask about most.',
    body: [
      `${c.name},`,
      'When people hear I bought my clinics with 100% vendor finance, the obvious question is why the sellers agreed.',
      'Seller finance gives an owner an income after they step away, and a buyer who has every reason to keep the business performing.',
      'For the right seller, that beats a lump sum from a stranger. In the session I explain how you find that seller and what makes them feel safe saying yes.',
    ],
    cta: guide(c, '100-percent-vendor-finance', 'Read the vendor finance guide →'),
    ps: whenLine(c),
  }),

  wp_a_not_your_fault: (c) => ({
    subject: 'it isn’t a capital problem',
    preheader: 'Why owners who could buy, don’t.',
    body: [
      `${c.name},`,
      'If you haven’t bought a business yet, it has nothing to do with your ability or your bank balance.',
      'It has everything to do with how acquisitions get explained. Most owners are told you need a big deposit, a private equity backer or a broker, and nobody shows them how a deal is actually structured.',
      'Once you see the structure, the question changes from “can I afford this” to “which business first”.',
    ],
    cta: seat(c),
  }),

  wp_a_if_you_could: (c) => ({
    subject: 'if harder work were the answer',
    preheader: 'You would have doubled already.',
    body: [
      `${c.name},`,
      'If working harder were the way to double your business, you would have done it already. You’re clearly not short of effort.',
      'The limit is structural. One company, one set of customers, one owner whose hours are already full.',
      'Buying a second business changes the structure instead of asking more of you.',
    ],
    cta: seat(c),
    ps: 'Bring the name of the business you’d buy. You’ll want it when we get to the financing.',
  }),

  wp_a_capital_deployer: (c) => ({
    subject: 'for anyone sitting on idle capital',
    preheader: 'Cash flowing businesses, bought on structure.',
    body: [
      `${c.name},`,
      'Some of you registering have capital parked in assets that pay very little.',
      'Profitable private businesses trade at a fraction of what listed companies do, and they produce real cash flow. The hard parts are finding the deals and knowing which ones to walk from.',
      'The session covers both, and shows why using structure instead of all your own cash keeps your capital working in more than one place.',
    ],
    cta: seat(c),
  }),

  wp_a_executive: (c) => ({
    subject: 'if you run a business for someone else',
    preheader: 'A note for the executives on the list.',
    body: [
      `${c.name},`,
      'A few of you run large businesses as executives rather than owners.',
      'You have the operating experience sellers and lenders look for. What you don’t have yet is a company with your name on the share register.',
      'The session shows how an operator buys an existing, profitable business with the target’s own cash flow doing the heavy lifting.',
    ],
    cta: seat(c),
  }),

  wp_a_timeline: (c) => ({
    subject: 'how five years disappear',
    preheader: 'The timeline most owners don’t notice they’re on.',
    body: [
      `${c.name},`,
      'Year one, you decide you’ll buy a business once you’ve saved enough. Year two, a good competitor sells to someone else.',
      'By the third year the deposit is close, and prices have gone up. By year five the plan is still a plan, and the business has the same ceiling it had at the start.',
      'Nothing about that timeline is a lack of ambition. It’s the result of using the wrong funding model.',
    ],
    cta: seat(c),
  }),

  wp_a_from_scratch: (c) => ({
    subject: 'building it all from scratch',
    preheader: 'The expensive way to grow.',
    body: [
      `${c.name},`,
      'Opening a new location from scratch means paying for the fit out, the staff, the marketing and the months of losses before it earns anything.',
      'Buying an established one means the customers, the team and the cash flow already exist, and the price can be funded by the business itself.',
      'One is a bet. The other is a purchase of something already proven.',
    ],
    cta: seat(c),
  }),

  wp_a_competitor: (c) => ({
    subject: 'the competitor you’d buy',
    preheader: 'Someone is going to buy them.',
    body: [
      `${c.name},`,
      'Think about the competitor you respect most. Their owner will sell one day.',
      'When that happens, the business goes to whoever approached first with a structure the owner trusted. That buyer gets their customers, their team and their cash flow.',
      'The session is about making sure that buyer is you.',
    ],
    cta: guide(c, 'buy-your-competitor', 'Read: buying your competitor →'),
    ps: whenLine(c),
  }),

  wp_a_why_1m: (c) => ({
    subject: 'why the $1M line matters',
    preheader: 'What lenders and sellers look at first.',
    body: [
      `${c.name},`,
      'The session is for owners at $1M or more in revenue for a practical reason.',
      'A lender funding an acquisition wants to know the buyer can run the business. A seller handing over decades of work wants the same thing.',
      'An owner with a profitable company already answers that question. That track record carries more weight in a deal than a large deposit does.',
    ],
    cta: seat(c),
  }),

  wp_a_calendar_check: (c) => ({
    subject: 'is it in your calendar yet',
    preheader: 'Quick check before the week fills up.',
    body: [
      `${c.name},`,
      `Quick check: is ${session(c).title} in your calendar?`,
      'If it isn’t, one click below adds it.',
    ],
    cta: cal(c, 'Add it now →'),
    ps: `It’s ${session(c).when}.`,
  }),

  wp_a_day_two: (c) => ({
    subject: 'two days in',
    preheader: 'Where we’ve got to, and what’s next.',
    body: [
      `${c.name},`,
      'Over the last two days we’ve covered the ceiling one business puts on you, why the listed market is crowded, and the two paths most owners get stuck on.',
      'Tomorrow I’ll get into what doing nothing actually costs. The session itself pulls it all together into one plan.',
    ],
    cta: seat(c),
  }),

  // ───────────── Day 3 ─────────────
  wp_a_cost_waiting: (c) => ({
    subject: 'what waiting actually costs',
    preheader: 'The price of another year with one business.',
    body: [
      `${c.name},`,
      'Waiting feels like it costs nothing, and the bill never shows up on a statement.',
      'Every year you wait is a year of cash flow from a second business you didn’t receive. Somewhere in that year, the competitor you wanted sells to someone else.',
      'And the ceiling stays exactly where it is. The session is one hour to decide whether you keep paying that price.',
    ],
    cta: seat(c),
  }),

  wp_a_identity: (c) => ({
    subject: 'owner of a job, or owner of companies',
    preheader: 'The shift that happens after the first deal.',
    body: [
      `${c.name},`,
      'Running one business, you are the business. Every decision runs through you, and when you stop, it stops.',
      'Owning a group, you become the person who chooses the leaders, sets the direction and allocates the capital.',
      'That shift starts with the first acquisition. The session shows how the first one is found and funded.',
    ],
    cta: seat(c),
  }),

  wp_a_desire: (c) => ({
    subject: 'what one acquisition starts',
    preheader: 'The deal is only the first layer.',
    body: [
      `${c.name},`,
      'The first acquisition gets you a second business. That second business brings a second stream of cash flow, paid for by itself.',
      'With a team running both, you get hours of your week back. And over time you stop being an owner with a job and become an owner of companies.',
      'All of it starts with one signed LOI.',
    ],
    cta: seat(c),
    ps: whenLine(c),
  }),

  wp_a_banks: (c) => ({
    subject: 'what you were told about banks',
    preheader: 'They lend against the target, not your savings.',
    body: [
      `${c.name},`,
      'Most owners believe a bank will only fund an acquisition if they put a large deposit down from their own pocket.',
      'For acquisitions, lenders look first at the cash flow of the business being bought, and whether it covers the repayments comfortably. Seller finance and seller rollover sit in the stack alongside that commercial debt.',
      'Banks reject structures more than they reject buyers. In the session I show what a structure they approve looks like.',
    ],
    cta: guide(c, 'dscr-explained', 'How lenders test a deal →'),
  }),

  wp_a_deposit: (c) => ({
    subject: 'the deposit you don’t need to save',
    preheader: 'Why years of saving is the slow road.',
    body: [
      `${c.name},`,
      'The standard advice is to save a big deposit before you buy. That advice comes from property, and businesses work differently.',
      'A business produces cash flow, and that cash flow is what commercial debt and seller finance are repaid from. A seller who rolls part of their value into a stake reduces what has to be funded at all.',
      'I’ll show you an example stack in the session, with the numbers labelled as illustrative.',
    ],
    cta: seat(c),
    ps: illustrative,
  }),

  wp_a_seller_safe: (c) => ({
    subject: 'sellers sell to who feels safe',
    preheader: 'Not always to the highest bidder.',
    body: [
      `${c.name},`,
      'An owner selling the business they spent decades building is thinking about their staff, their customers and their name.',
      'The buyer who makes them feel safe about all three has an edge over a buyer waving a bigger cheque.',
      'Part of the session covers how you build that credibility before you ever make an offer.',
    ],
    cta: seat(c),
  }),

  wp_a_leave_with: (c) => ({
    subject: 'what you’ll walk out with',
    preheader: 'Three things you’ll know by the end of the hour.',
    body: [
      `${c.name},`,
      `By the end of ${session(c).title}, you’ll know three things.`,
      '• Where to find businesses that aren’t for sale yet, and how to approach their owners.<br>• How commercial debt, seller finance and seller rollover stack so the business pays for itself.<br>• The first 90 days, step by step, from a target list to a signed LOI.',
      'Whether you act on it is your call. You’ll at least know exactly what the path looks like.',
    ],
    cta: seat(c),
    ps: whenLine(c),
  }),

  wp_a_bring_list: (c) => ({
    subject: 'bring a pen and three names',
    preheader: 'How to get the most out of the hour.',
    body: [
      `${c.name},`,
      'Two things to have next to you on the day: something to write with, and the names of three businesses you’d consider buying.',
      'As we go through the session, run each name through what I show you. By the end you’ll have a first view on which one to look at seriously.',
    ],
    cta: seat(c),
  }),

  wp_a_live: (c) => ({
    subject: 'why I’d rather you came live',
    preheader: 'There is a replay, and live is still better.',
    body: [
      `${c.name},`,
      'Live, you’re in the room with the full hour blocked out and no pause button to tempt you away.',
      `There is a replay, and it stays up for ${session(c).replayHours} hours after the session. A replay is easy to put off until the window has closed.`,
      'Come live if you can.',
    ],
    cta: seat(c),
  }),

  wp_a_your_question: (c) => ({
    subject: 'what do you want answered',
    preheader: 'Hit reply and tell me.',
    body: [
      `${c.name},`,
      'If there’s one question you want answered in the session, reply to this email and tell me.',
      'Something about funding, finding deals, your industry or your own situation. I read the replies, and plenty of what people ask is answered in the session itself, so bring yours with you.',
    ],
    cta: seat(c),
  }),

  wp_a_different: (c) => ({
    subject: 'my situation is different',
    preheader: 'The objection every owner has.',
    body: [
      `${c.name},`,
      'Every owner who registers has the same quiet thought: this works for other people, my industry or my numbers are different.',
      'The structure doesn’t depend on your industry. It depends on whether a target business has steady cash flow, and whether its seller wants a buyer they trust.',
      'Hold onto the objection and bring it to the session. You’ll be able to test it against the actual mechanics.',
    ],
    cta: seat(c),
  }),

  wp_a_offmarket_guide: (c) => ({
    subject: 'some reading before the session',
    preheader: 'How off-market businesses are found.',
    body: [
      `${c.name},`,
      'If you want a head start, this guide covers the basics of finding businesses that aren’t listed.',
      'The session goes further, into how the approach is made and what to say. Reading this first means you’ll follow that part faster.',
    ],
    cta: guide(c, 'find-off-market-businesses-for-sale', 'Read the off-market guide →'),
    ps: whenLine(c),
  }),

  wp_a_no_money_guide: (c) => ({
    subject: 'what no money down actually means',
    preheader: 'A short guide to read before we meet.',
    body: [
      `${c.name},`,
      'No money down gets misunderstood. It doesn’t mean no money is involved.',
      'It means the funding comes from the business being bought and its seller, through commercial debt, seller finance and seller rollover, instead of your own savings.',
      'This guide lays out the basics, and the session shows how the pieces fit on a real structure.',
    ],
    cta: guide(c, 'how-to-buy-a-business-with-no-money-down', 'Read the guide →'),
  }),

  wp_a_permission: (c) => ({
    subject: 'you were doing the right thing',
    preheader: 'Building organically wasn’t a mistake.',
    body: [
      `${c.name},`,
      'Growing your business by hand, one hire and one customer at a time, was the right thing to do. It’s how you got past a million.',
      'The next stage asks for a different tool. Owners who keep using the first tool for the second job hit the ceiling and stay there.',
      'You’ve earned the right to use the tool the people building groups use.',
    ],
    cta: seat(c),
  }),

  wp_a_day_three: (c) => ({
    subject: 'three days in, here’s the picture',
    preheader: 'Everything so far, in one place.',
    body: [
      `${c.name},`,
      'One business has a ceiling, and organic growth has a speed limit. The listed market is crowded, and the two usual paths are slow.',
      'There is a third way, where the business you buy and its seller fund most of the deal. The session shows you where those businesses are, how the money is stacked and the 90-day path to a signed LOI.',
      `All you need to do is be there: ${session(c).when}.`,
    ],
    cta: seat(c, 'I’ll be there →'),
    ps: 'Bring the name of the business you’d buy.',
  }),
};

export const PW_A_ORDER: PwOrder = [
  // Day 1
  ['wp_a_youre_in', 1],
  ['wp_a_covers', 1],
  ['wp_a_calendar', 1],
  ['wp_a_for_you', 1],
  ['wp_a_not_for', 2],
  ['wp_a_josh', 1],
  ['wp_a_ceiling', 1],
  ['wp_a_speed_limit', 2],
  ['wp_a_saturation', 1],
  ['wp_a_two_paths', 2],
  ['wp_a_third_way', 1],
  ['wp_a_rich', 2],
  ['wp_a_homework_target', 2],
  ['wp_a_block_hour', 2],
  ['wp_a_one_question', 3],
  // Day 2
  ['wp_a_offmarket', 1],
  ['wp_a_brokers', 2],
  ['wp_a_overfinanced', 1],
  ['wp_a_ninety_days', 1],
  ['wp_a_clinics', 2],
  ['wp_a_not_your_fault', 2],
  ['wp_a_if_you_could', 2],
  ['wp_a_capital_deployer', 3],
  ['wp_a_executive', 3],
  ['wp_a_timeline', 2],
  ['wp_a_from_scratch', 3],
  ['wp_a_competitor', 2],
  ['wp_a_why_1m', 3],
  ['wp_a_calendar_check', 2],
  ['wp_a_day_two', 3],
  // Day 3
  ['wp_a_cost_waiting', 1],
  ['wp_a_identity', 2],
  ['wp_a_desire', 2],
  ['wp_a_banks', 2],
  ['wp_a_deposit', 3],
  ['wp_a_seller_safe', 3],
  ['wp_a_leave_with', 1],
  ['wp_a_bring_list', 2],
  ['wp_a_live', 2],
  ['wp_a_your_question', 3],
  ['wp_a_different', 3],
  ['wp_a_offmarket_guide', 3],
  ['wp_a_no_money_guide', 3],
  ['wp_a_permission', 3],
  ['wp_a_day_three', 1],
];
