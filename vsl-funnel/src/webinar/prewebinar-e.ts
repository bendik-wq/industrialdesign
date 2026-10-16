import { type PW, type PwOrder, guide, illustrative, seat, session, whenLine } from './prewebinar-kit';

/**
 * Pre-webinar batch E (days 13–14 of 14): show up ready.
 * The agenda, what to bring, three homework exercises, who to bring, how to watch,
 * what to ask, what happens after, the replay window, and the final countdown notes.
 * The 24-hour, 3-hour and 15-minute reminders are sent separately, so none of these
 * emails repeats them. Every email sells attendance, not the program.
 */
const cal = (c: Parameters<PW>[0], label: string) => ({ label, href: session(c).google ?? session(c).room });

export const PW_E: Record<string, PW> = {
  // ── Day 13: what to expect and what to bring ──
  wp_e_agenda: (c) => ({
    subject: 'what you’ll see, in order',
    preheader: 'The running order for the session, so nothing catches you off guard.',
    body: [
      `${c.name},`,
      `Here’s the running order for ${session(c).title}, start to finish:`,
      '• <strong>Why the usual routes stall.</strong> Raising capital and saving a deposit, and what each one costs you.<br>• <strong>The third way.</strong> Commercial debt against the target’s cash flow, seller finance and seller rollover, stacked together.<br>• <strong>The 1.5x test.</strong> The one number a lender reads before anything else.<br>• <strong>Finding the deal.</strong> Off-market, direct to the owner.<br>• <strong>Your questions, live.</strong>',
      'Each part builds on the one before it. Join late and the last part makes a lot less sense.',
    ],
    cta: seat(c, 'Save my link →'),
    ps: whenLine(c),
  }),
  wp_e_pen: (c) => ({
    subject: 'bring a pen',
    preheader: 'One small thing that changes how much you keep from the hour.',
    body: [
      `${c.name}, bring a pen and paper to the session.`,
      'You’ll want to write down one calculation in particular, the debt cover test, and run it on your own numbers while I’m still on screen.',
      'People who write it down remember it a week later. Everyone else remembers that it was interesting.',
    ],
    cta: seat(c, 'Open my session link →'),
  }),
  wp_e_numbers: (c) => ({
    subject: 'three numbers to have in front of you',
    preheader: 'Revenue, profit, debt. Rough is fine.',
    body: [
      `${c.name},`,
      'Before the session, jot down three rough numbers from your own business:',
      '• <strong>Revenue</strong> for the last twelve months.<br>• <strong>Profit</strong>, the real figure after you pay yourself a fair wage.<br>• <strong>Debt</strong> the business carries today.',
      'Nobody will ask you to share them. They’re for you, so that when I walk through how a lender reads a deal, you’re reading your own numbers instead of mine.',
    ],
    cta: seat(c, 'Keep my link handy →'),
    ps: 'Round numbers are fine; the point is to have a starting line.',
  }),
  wp_e_target: (c) => ({
    subject: 'have one business in mind',
    preheader: 'The hour lands harder when you’re thinking about a real company.',
    body: [
      `${c.name},`,
      'Walk into the session with one real business in mind. A competitor across town, a supplier, the firm you refer overflow work to.',
      'Every step I show you, picture it applied to that company. By the end you’ll know whether it passes the first test or not, and that’s worth more than any general idea.',
    ],
    cta: guide(c, 'buy-your-competitor', 'Buying a competitor, explained →'),
    ps: whenLine(c),
  }),
  wp_e_hw_three: (c) => ({
    subject: 'homework: three you’d buy',
    preheader: 'A ten-minute exercise before the session.',
    body: [
      `${c.name}, a short piece of homework before we meet.`,
      'Write down three businesses you would buy if the money were sorted. Name them, don’t describe them.',
      'Most owners have never done this, and that is exactly why they never buy anything. A name on paper turns an idea into a target.',
      'Bring the list. We’ll put each one through the same filter during the hour.',
    ],
    cta: guide(c, 'find-off-market-businesses-for-sale', 'Where off-market deals come from →'),
  }),
  wp_e_hw_retire: (c) => ({
    subject: 'homework: the owner near retirement',
    preheader: 'Somebody in your market is thinking about stepping back.',
    body: [
      `${c.name},`,
      'Second exercise. Think of one competitor whose owner is in their sixties, or has started talking about slowing down.',
      'Write their name next to the business. That owner has a problem you can solve, because selling to a stranger feels risky and their kids don’t want it.',
      'In the session I’ll show why seller finance and seller rollover are so attractive to exactly that person.',
    ],
    cta: guide(c, 'seller-rollover-explained', 'Why sellers stay in →'),
    ps: 'You don’t need to know them well; you only need to know they exist.',
  }),
  wp_e_hw_profit: (c) => ({
    subject: 'homework: your real profit',
    preheader: 'The number a lender cares about, worked out on your own business.',
    body: [
      `${c.name}, the last exercise is the most useful one.`,
      'Work out what your business really earns. Take net profit, add back what you pay yourself above a normal manager’s wage, then add back one-off costs that won’t repeat.',
      'That figure is close to what a lender looks at in any business you buy. Knowing yours means you’ll read the examples in the session the way a buyer does.',
    ],
    cta: guide(c, 'dscr-explained', 'How lenders read profit →'),
    ps: illustrative,
  }),
  wp_e_partner: (c) => ({
    subject: 'watch it with your partner',
    preheader: 'The person you’ll talk this over with should hear it first-hand.',
    body: [
      `${c.name},`,
      'If you have a business partner, a spouse or anyone you make big decisions with, bring them to the session.',
      'Explaining vendor finance second-hand over dinner rarely goes well. The mechanics sound strange until you see them laid out, and then they sound obvious.',
      'Sit them next to you. Then you’re both deciding from the same information.',
    ],
    cta: seat(c, 'Forward-ready link →'),
    ps: 'Your link works on one screen for both of you.',
  }),
  wp_e_screen: (c) => ({
    subject: 'watch it on a computer',
    preheader: 'The numbers on screen are hard to read on a phone.',
    body: [
      `${c.name}, one practical note.`,
      'Join from a laptop or desktop, not your phone. There are deal structures and calculations on screen, and on a phone they shrink to nothing.',
      'Plug in the charger too. The hour goes quicker than you expect.',
    ],
    cta: seat(c, 'Open it on my computer →'),
  }),
  wp_e_quiet: (c) => ({
    subject: 'somewhere quiet, for the full hour',
    preheader: 'Treat it like a meeting with a lender, because the content is exactly that.',
    body: [
      `${c.name},`,
      `Block out the full ${session(c).durationMin} minutes somewhere quiet. Door closed, notifications off, staff told you’re unavailable.`,
      'Half-watching while answering emails is how people walk away with fragments. You’ll get the whole structure only if you see it all in one sitting.',
    ],
    cta: cal(c, 'Put it in my calendar →'),
    ps: whenLine(c),
  }),
  wp_e_questions: (c) => ({
    subject: 'questions worth asking live',
    preheader: 'A few to start with, in case your mind goes blank on the day.',
    body: [
      `${c.name}, there is time for questions at the end, and I answer them live.`,
      'If you’re not sure what to ask, start with one of these:',
      '• How would a lender view a business like mine buying a competitor?<br>• What does a seller need to hear before agreeing to carry a note?<br>• Where does seller rollover fit if the owner wants out completely?<br>• What makes a deal fail the 1.5x test?',
      'Write your own underneath. The specific ones get the most useful answers.',
    ],
    cta: seat(c, 'Save my link →'),
  }),
  wp_e_after: (c) => ({
    subject: 'what happens after the hour',
    preheader: 'No surprises. Here’s exactly how it ends.',
    body: [
      `${c.name},`,
      'At the end of the session I’ll explain how we work with owners who want help doing this.',
      'If it fits where you are, you can apply. The team reviews applications and, where it makes sense, books a strategy call to look at your situation properly.',
      'If it doesn’t fit, you still leave with the full structure and the test to run on any deal. Either way, the hour is yours to use.',
    ],
    cta: seat(c, 'Keep my seat link →'),
    ps: 'No pressure on the night; the application is there for those who want it.',
  }),
  wp_e_live_room: (c) => ({
    subject: 'the replay can’t answer you',
    preheader: `The recording stays up for ${session(c).replayHours} hours. The live room is different.`,
    body: [
      `${c.name}, there is a replay. It stays up for ${session(c).replayHours} hours after the session, then it comes down.`,
      'Here’s what the replay can’t do: answer your question about your business, your market, your seller.',
      'That happens live, in the room, while I’m there. Watch the recording and you get the content without the part that applies it to you.',
    ],
    cta: seat(c, 'I’ll be there live →'),
  }),
  wp_e_why_most_skip: (c) => ({
    subject: 'why most registrants never show',
    preheader: 'They don’t decide against it. Something small just gets in the way.',
    body: [
      `${c.name},`,
      'Most people who register for a session like this never turn up. They didn’t decide against it; a call ran over, or a staff problem came up, and the hour was gone.',
      'The owners who show up treated it as fixed. Calendar blocked, team told, link saved.',
      'Do those three things now and it takes two minutes.',
    ],
    cta: cal(c, 'Block it in my calendar →'),
    ps: whenLine(c),
  }),
  wp_e_checklist: (c) => ({
    subject: 'your one-page checklist',
    preheader: 'Everything from the last few emails, on one screen.',
    body: [
      `${c.name}, here’s everything in one place:`,
      '• A pen and paper<br>• Your revenue, profit and debt, roughly<br>• Three businesses you’d buy<br>• One competitor whose owner is near retirement<br>• Your partner, if you have one<br>• A computer, a quiet room and the full hour<br>• One question you want answered live',
      'Screenshot this. That’s your preparation done.',
    ],
    cta: seat(c, 'Save my link →'),
  }),

  // ── Day 14: the last day before the session ──
  wp_e_final_stretch: (c) => ({
    subject: 'the final stretch before we meet',
    preheader: 'Close now. Here’s what matters between now and then.',
    body: [
      `${c.name},`,
      `We’re in the final stretch before ${session(c).title}.`,
      'If you’ve done the homework, good. If you haven’t, the profit calculation is the one to do next; it takes fifteen minutes and makes the whole session personal.',
    ],
    cta: guide(c, 'dscr-explained', 'Read how lenders test profit →'),
    ps: whenLine(c),
  }),
  wp_e_two_paths: (c) => ({
    subject: 'two owners, same business',
    preheader: 'Same industry, same size. A different decision on one evening.',
    body: [
      `${c.name}, picture two owners with the same size business in the same town.`,
      'One keeps working in it, hoping growth comes from more marketing and longer hours. The other spends an hour learning how acquisitions are funded with commercial debt, seller finance and seller rollover, then starts calling owners.',
      'Five years later they are running very different companies. The gap between them began with an hour like the one you have booked.',
    ],
    cta: seat(c, 'I’m the second owner →'),
  }),
  wp_e_not_fault: (c) => ({
    subject: 'nobody taught you this',
    preheader: 'Why buying a business felt out of reach until now.',
    body: [
      `${c.name},`,
      'If buying another company always felt out of reach, that has nothing to do with your ability as an operator.',
      'It has everything to do with who taught you. Banks talk about deposits, brokers talk about listed businesses, and almost nobody explains how a seller note and a rollover close the gap.',
      'I bought my own clinics with 100% vendor finance. I’ll show you how that structure works in the session.',
    ],
    cta: guide(c, '100-percent-vendor-finance', 'How 100% vendor finance works →'),
  }),
  wp_e_identity: (c) => ({
    subject: 'if you’re someone who…',
    preheader: 'This session was built for a specific kind of owner.',
    body: [
      `${c.name},`,
      'If you’re someone who built a profitable business and feels the ceiling, this hour is for you.',
      'Owners who look at a competitor and know they’d run it better belong in that room too. And when you’d rather own a group of companies than a single job with your name on it, you already know you’ll be there.',
    ],
    cta: seat(c, 'That’s me →'),
  }),
  wp_e_older: (c) => ({
    subject: 'two weeks from now',
    preheader: 'You’ll be two weeks older either way.',
    body: [
      `${c.name},`,
      'Two weeks from now you’ll be two weeks older. That part is settled.',
      'What isn’t settled is whether you spend them with a clear plan for buying your first business, or exactly where you are today. The only difference is one hour, and whether you show up for it.',
    ],
    cta: seat(c, 'I’ll be there →'),
    ps: whenLine(c),
  }),
  wp_e_cost_waiting: (c) => ({
    subject: 'the bill for waiting',
    preheader: 'The business you want to buy has a buyer. The question is who.',
    body: [
      `${c.name}, the owners near retirement in your market are going to sell. That much is certain.`,
      'When they do, somebody buys the customers, the staff and the cash flow. If it isn’t you, it’s a competitor who now has more of all three.',
      'The session is where you learn how to be the buyer instead of the one watching.',
    ],
    cta: seat(c, 'Save my link →'),
  }),
  wp_e_if_could: (c) => ({
    subject: 'if saving up worked, you’d own two',
    preheader: 'The deposit route has had years to work.',
    body: [
      `${c.name},`,
      'If you could have bought your next business by saving a deposit, you would have done it already.',
      'You’re a capable operator; the method is the problem. In the session I’ll show the one that funds the purchase from the target’s own cash flow, alongside seller finance and seller rollover.',
    ],
    cta: guide(c, 'how-to-buy-a-business-with-no-money-down', 'The no-money-down guide →'),
    ps: illustrative,
  }),
  wp_e_desire: (c) => ({
    subject: 'one deal, then the next',
    preheader: 'Where buying the first business actually leads.',
    body: [
      `${c.name},`,
      'The first deal adds a second stream of profit. The cash flow from that deal pays its own debt down while the team you put in runs it.',
      'Then the next one gets easier, because lenders and sellers can see you’ve done it before. Somewhere in that process you stop being the owner of a job and become the owner of companies.',
      'All of that starts with the structure you’ll see in the session.',
    ],
    cta: seat(c, 'Show me the structure →'),
  }),
  wp_e_tell_team: (c) => ({
    subject: 'tell your team now',
    preheader: 'A short note while there’s still time to get ready.',
    body: [
      `${c.name}, a quick one.`,
      `The session is close now: ${session(c).when}.`,
      'Tell your team now that you’re unavailable for the hour. That single conversation protects the time better than any reminder I can send.',
    ],
    cta: cal(c, 'Add it to my calendar →'),
  }),
  wp_e_your_question: (c) => ({
    subject: 'what’s your one question?',
    preheader: 'Decide it now so you don’t lose it in the moment.',
    body: [
      `${c.name},`,
      'Decide now on the one question you most want answered about your situation.',
      'Write it on the same page as your numbers. When questions open, you’ll be ready while others are still thinking.',
    ],
    cta: seat(c, 'Keep my link →'),
    ps: 'Specific questions about your industry get the best answers.',
  }),
  wp_e_test_link: (c) => ({
    subject: 'two minutes to test your link',
    preheader: 'Set it up now so joining takes no effort.',
    body: [
      `${c.name},`,
      'Well before start time, open your session link on the computer you’ll use and check it loads. Put your pen, your three numbers and your list of businesses beside it.',
      'Two minutes now saves the scramble later, and you walk in calm.',
    ],
    cta: seat(c, 'Test my link now →'),
    ps: whenLine(c),
  }),
  wp_e_belief: (c) => ({
    subject: 'you don’t need the cash',
    preheader: 'Lenders look at the business being bought before they look at you.',
    body: [
      `${c.name},`,
      'What you were told: you need a big deposit to buy a business. What lenders actually assess first is the target’s cash flow and whether it covers the repayments about 1.5 times.',
      'Commercial debt, seller finance and seller rollover do the funding. Your savings are not the main event.',
      'When we go live, I’ll walk through that structure step by step.',
    ],
    cta: guide(c, 'seller-finance-explained', 'Seller finance in plain words →'),
    ps: illustrative,
  }),
  wp_e_threshold: (c) => ({
    subject: 'this is the threshold',
    preheader: 'Most owners never get this close to doing it.',
    body: [
      `${c.name},`,
      'You registered, you read these emails, and you’ve probably done some of the homework. That already puts you ahead of most owners who say they want to grow by acquisition.',
      'The last step is the easiest one. Show up, live, for the hour.',
    ],
    cta: seat(c, 'I’m showing up →'),
  }),
  wp_e_see_you: (c) => ({
    subject: 'see you in the room',
    preheader: 'Everything’s ready. Here’s your link one more time.',
    body: [
      `${c.name},`,
      'Pen, numbers, three businesses, one question, the full hour. That’s all you need.',
      `I’ll be live for ${session(c).title}, and I’m looking forward to your question.`,
    ],
    cta: seat(c, 'My link to the session →'),
    ps: whenLine(c),
  }),
  wp_e_final_note: (c) => ({
    subject: 'one last thing before we start',
    preheader: 'Come to decide, not just to watch.',
    body: [
      `${c.name}, a final note before the session.`,
      'Come ready to make a decision about your next business, not just to collect information. You’ll have the structure, the test and a live room to ask in.',
      `If you can’t make it live, the replay stays up for ${session(c).replayHours} hours. Live is still where your question gets answered.`,
    ],
    cta: seat(c, 'Save my link →'),
  }),
};

export const PW_E_ORDER: PwOrder = [
  // Day 13
  ['wp_e_agenda', 1],
  ['wp_e_pen', 3],
  ['wp_e_numbers', 2],
  ['wp_e_target', 2],
  ['wp_e_hw_three', 2],
  ['wp_e_hw_retire', 3],
  ['wp_e_hw_profit', 2],
  ['wp_e_partner', 2],
  ['wp_e_screen', 3],
  ['wp_e_quiet', 2],
  ['wp_e_questions', 2],
  ['wp_e_after', 2],
  ['wp_e_live_room', 1],
  ['wp_e_why_most_skip', 3],
  ['wp_e_checklist', 1],
  // Day 14
  ['wp_e_final_stretch', 2],
  ['wp_e_two_paths', 3],
  ['wp_e_not_fault', 2],
  ['wp_e_identity', 2],
  ['wp_e_older', 1],
  ['wp_e_cost_waiting', 3],
  ['wp_e_if_could', 3],
  ['wp_e_desire', 3],
  ['wp_e_tell_team', 1],
  ['wp_e_your_question', 2],
  ['wp_e_test_link', 1],
  ['wp_e_belief', 2],
  ['wp_e_threshold', 1],
  ['wp_e_see_you', 1],
  ['wp_e_final_note', 1],
];
