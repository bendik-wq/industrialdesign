import type { Lead } from '../funnel/leads';

/**
 * Email copy. Plain, personal, letter-style emails from Josh — they read like
 * a person wrote them, which is what gets replies and show-ups.
 *
 * Every link goes through ctx.link() so clicks are tracked, the lead's browser
 * is stitched to their record, and the destination page knows who they are.
 */
export interface TemplateCtx {
  lead: Lead;
  name: string;
  siteName: string;
  link: (path: string) => string;
  bookingUrl: string | null;
  whatsappUrl: string | null;
  callTime: string | null;
  /** Calendly meeting link, when the API is connected. */
  joinUrl?: string | null;
  /** Calendly self-serve reschedule link. */
  rescheduleUrl?: string | null;
}

export interface EmailContent {
  subject: string;
  preheader: string;
  body: string[];
  cta?: { label: string; href: string };
  ps?: string;
}

type Template = (ctx: TemplateCtx) => EmailContent;

const bookOrBreakout = (c: TemplateCtx) => c.link(c.bookingUrl ? '/book' : '/breakout');
const waLine = (c: TemplateCtx, text = 'Or message me directly on WhatsApp') => (c.whatsappUrl ? `<a href="${c.whatsappUrl}">${text}</a> — I read every one.` : '');

export const TEMPLATES: Record<string, Template> = {
  // ── Abandoned application (CTA: finish the application) ────────────
  abandon_1: (c) => ({
    subject: `${c.name}, your application is half done`,
    preheader: 'It saved where you left off.',
    body: [
      `Hey ${c.name},`,
      'Looks like you started your application but didn’t get to the end. No stress, it saved where you left off.',
      'It takes a couple of minutes to finish, and it’s how you get a strategy call with my team, where we map out your first off-market acquisition: the target, the structure and the financing.',
    ],
    cta: { label: 'Finish my application →', href: c.link('/apply') },
    ps: 'If something on the form didn’t make sense, just reply to this email and tell me.',
  }),
  abandon_2: (c) => ({
    subject: `${c.name}, quick question`,
    preheader: 'Was it the funding question?',
    body: [
      `${c.name}, quick one.`,
      'When owners stop halfway through the application, it’s usually one of three things:',
      '• They think buying a business means putting in their own cash.<br>• They think they don’t have the time to run a deal.<br>• They think their industry is different.',
      'Here’s the straight answer. The deals are structured with seller finance and senior debt, and over-financed, so the stack covers more than the purchase price and none of your own cash goes in. You run the deal yourself, with my team beside you at every step. And the model depends on cash flow, not industry.',
      'Your answers are still saved.',
    ],
    cta: { label: 'Pick up where I left off →', href: c.link('/apply') },
  }),
  abandon_3: (c) => ({
    subject: 'what the call actually gets you',
    preheader: 'A signed LOI in 90 days is the goal.',
    body: [
      `Hey ${c.name},`,
      'In case it wasn’t clear what you’re applying for, here it is in plain terms.',
      'If you own a business doing $1M or more, the goal is a signed LOI within 90 days on an acquisition that can double or triple your business. No money down. The seller finance and senior debt cover more than the price, so the deal is over-financed from day one.',
      'The application is how we check the numbers fit. The strategy call takes 30 minutes.',
    ],
    cta: { label: 'Finish my application →', href: c.link('/apply') },
  }),
  abandon_4: (c) => ({
    subject: `${c.name}, you stay in control`,
    preheader: 'This is done with you, not done for you.',
    body: [
      `${c.name},`,
      'One thing owners tend to worry about: handing their growth to a consultant they’ve never met.',
      'That’s not how this works. It’s done with you, not for you. You run the deal and you make the decisions. My team coaches you, structures the deal, introduces you to lenders and sits in on the key seller conversations.',
      'It takes a few focused hours a week. Your application is still waiting where you left it.',
    ],
    cta: { label: 'Finish my application →', href: c.link('/apply') },
  }),
  abandon_5: (c) => ({
    subject: 'closing your application',
    preheader: 'Last note from me on this.',
    body: [
      `Hey ${c.name},`,
      'I’m going to close out your unfinished application so we can give the call slots to owners who are ready.',
      'If growing by acquisition is on your agenda this year, finish it now. If not, no hard feelings. You’ll still get the occasional email from me on the deals and structures we’re seeing.',
    ],
    cta: { label: 'Finish my application →', href: c.link('/apply') },
  }),

  // ── A tier: approved, book the call ────────────────────────────────
  a_approved: (c) => ({
    subject: `${c.name}, you’re approved for a strategy call`,
    preheader: 'Pick a time that suits you.',
    body: [
      `${c.name}, your application stood out.`,
      'Your business is the right size to buy another one. The next step is a 30-minute strategy call where we look at your numbers and map out your first off-market acquisition: the kind of target, the deal structure and how the financing stacks up.',
      'Calls are limited each week because they’re run by people who actually do deals, so grab a time now.',
    ],
    cta: { label: 'Book my strategy call →', href: bookOrBreakout(c) },
    ps: `Before the call, watch part 2. It walks through a real add-on acquisition line by line: <a href="${c.link('/breakout')}">watch it here</a>.`,
  }),
  a_reminder: (c) => ({
    subject: 'your call slot is still open',
    preheader: 'Haven’t seen your booking come through yet.',
    body: [
      `Hey ${c.name},`,
      'You were approved for a strategy call but haven’t picked a time yet.',
      'The question isn’t whether it can be done. I’ve bought two businesses with 100% seller finance. The real question is how fast you get to a signed LOI, and that’s what this call is for.',
    ],
    cta: { label: 'Choose my time →', href: bookOrBreakout(c) },
  }),
  a_slots: (c) => ({
    subject: `${c.name}, this week’s call times`,
    preheader: 'There are only so many each week.',
    body: [
      `${c.name},`,
      'I keep a small number of strategy calls open each week, because the people on them are the ones who structure the deals. When the week is full, it’s full.',
      'Your approval means one of those times is yours if you want it. Pick one that suits you before they go.',
    ],
    cta: { label: 'See this week’s times →', href: bookOrBreakout(c) },
  }),
  a_morning: (c) => ({
    subject: `morning, ${c.name}`,
    preheader: 'Thirty minutes, before the day gets away from you.',
    body: [
      `Morning ${c.name},`,
      'Before the day fills up: your strategy call is still waiting to be booked.',
      'Thirty minutes. Pick a time now while it’s on your mind.',
    ],
    cta: { label: 'Book my call →', href: bookOrBreakout(c) },
  }),
  a_last_call: (c) => ({
    subject: 'should I give your spot away?',
    preheader: 'Your approval is held for a little longer.',
    body: [
      `${c.name},`,
      'Your approval for a strategy call is held for a few more days, then the slot goes to the next owner on the list.',
      'Right now someone is buying the businesses in your industry. If it should be you, book the call.',
    ],
    cta: { label: 'Book my call →', href: bookOrBreakout(c) },
  }),
  a_case: (c) => ({
    subject: 'how I bought two businesses with no cash down',
    preheader: 'Both deals were 100% seller financed.',
    body: [
      `Hey ${c.name},`,
      'I’m not teaching this from a textbook. Through JC Health Group I bought two businesses, and both were 100% seller financed.',
      'That means the sellers didn’t get a big cheque from me at closing. They got paid over time, out of the cash flow of the business they sold me. My own cash stayed in my own business.',
      'It wasn’t luck. It was structure: the right target, the right terms, and a seller who understood why the deal worked for them too. That’s the part we map out with you on the call.',
    ],
    cta: { label: 'Book my strategy call →', href: bookOrBreakout(c) },
  }),
  a_objection: (c) => ({
    subject: '“I don’t have the time or the cash”',
    preheader: 'The two reasons owners hold off.',
    body: [
      `${c.name},`,
      'When an approved owner doesn’t book, it’s nearly always one of two reasons.',
      '<strong>“I don’t have the cash.”</strong> You don’t need it. Seller finance and senior debt cover more than the purchase price, so the deal is over-financed and none of your own money goes in.',
      '<strong>“I don’t have the time.”</strong> It’s a few focused hours a week. You run the deal, and my team does the heavy lifting with you: coaching, structuring, lender introductions and sitting in on the key seller conversations.',
      'If either of those was what held you back, the call is where we show you how it works for your business.',
    ],
    cta: { label: 'Book my strategy call →', href: bookOrBreakout(c) },
  }),
  a_final: (c) => ({
    subject: 'the cost of waiting',
    preheader: 'Another year of organic growth?',
    body: [
      `${c.name}, last one on this.`,
      'Let’s talk about what it costs you not to do this. Another year of growing one customer and one hire at a time. Another year of good businesses in your market being bought by someone else. Another year closer to an exit valued as one small business instead of a group.',
      'It’s 30 minutes, and you’ll leave knowing exactly what your first deal could look like.',
    ],
    cta: { label: 'Book my strategy call →', href: bookOrBreakout(c) },
  }),

  // ── B tier: part 2 → objections → book ─────────────────────────────
  b_part2: (c) => ({
    subject: 'part 2: how the deal actually gets funded',
    preheader: 'A real add-on acquisition, line by line.',
    body: [
      `Hey ${c.name}, thanks for applying.`,
      'I’ve bought two businesses with 100% seller finance through JC Health Group. Part 2 shows you how that kind of deal is built.',
      'I walk through a real add-on acquisition line by line: what the seller carries, what the bank funds, and how the stack is over-financed so none of it comes out of your own cash.',
      'Understand this before you contact a single seller.',
    ],
    cta: { label: 'Watch part 2 →', href: c.link('/breakout') },
  }),
  b_two_paths: (c) => ({
    subject: 'two ways to grow from here',
    preheader: 'The slow way and the fast way.',
    body: [
      `${c.name},`,
      'There are two ways to grow a business past where it is now. The slow path is organic: more marketing, more hires, more of your hours, one customer at a time.',
      'The fast path is buying the businesses next to yours. Their customers, staff and cash flow arrive on day one.',
      'That’s what the 3C model is for. Capabilities (your business already makes you a credible buyer), Capital (seller finance and senior debt, over-financed, so none of your cash goes in) and Closing (you run the outreach and negotiation, with us in the room).',
    ],
    cta: { label: 'See how it works →', href: c.link('/breakout') },
  }),
  b_objections: (c) => ({
    subject: 'I suspect this is why',
    preheader: 'Most owners think their industry is different.',
    body: [
      `Hey ${c.name},`,
      'I suspect the reason you haven’t booked a call yet is one of these: you think it’ll take too much cash, you think it’ll eat your time, or you think your industry is different.',
      'Here’s the straight version. The deals are over-financed, so your cash stays where it is. It takes a few focused hours a week: you make the calls and meet the sellers, and we do the heavy thinking with you. And the model depends on cash flow and structure, not industry.',
      'I answered the most common questions here.',
    ],
    cta: { label: 'Read the FAQs →', href: c.link('/breakout#faq') },
    ps: 'If you still don’t think it’ll work for your business, reply and tell me why. I’ll give you a straight answer.',
  }),
  b_dscr: (c) => ({
    subject: 'the number the bank cares about',
    preheader: 'DSCR in plain English.',
    body: [
      `${c.name},`,
      'There’s one number that decides whether an acquisition pays for itself: the debt service coverage ratio, or DSCR.',
      'It’s simple. Take the cash the business you’re buying throws off each year, and divide it by what the loan repayments cost each year. That’s it.',
      'We aim for around 1.5x. In plain terms, for every dollar of repayments, the business brings in about a dollar fifty. The deal services its own debt, with room to spare, and you aren’t propping it up from your own business.',
      'On the call we run this number on the kind of target that would fit you.',
    ],
    cta: { label: 'Book a call →', href: bookOrBreakout(c) },
  }),
  b_guarantee: (c) => ({
    subject: `${c.name}, the 7-day guarantee`,
    preheader: 'Full refund if it’s not for you.',
    body: [
      `Hey ${c.name},`,
      'If you decide to work with us, you get seven days to make sure it’s right.',
      'If at any point in those first seven days you decide it’s not for you, tell us and you get a full refund. No forms to argue over, no hard feelings.',
      'I’d rather you start with nothing to lose than sit on the fence for another year. The first step is still the strategy call.',
    ],
    cta: { label: 'Book a call →', href: bookOrBreakout(c) },
  }),
  b_book: (c) => ({
    subject: 'want to talk it through?',
    preheader: 'A short call to map out your first acquisition.',
    body: [
      `${c.name},`,
      'If part 2 made sense and you want to see what this could look like for your business, grab a time with my team.',
      'We’ll look at your numbers, the kind of off-market targets that would fit, and what a realistic first deal looks like. If we can help, we’ll tell you how. If we can’t, we’ll tell you that too.',
    ],
    cta: { label: 'Book a call →', href: bookOrBreakout(c) },
  }),
  b_last: (c) => ({
    subject: `still thinking it over, ${c.name}?`,
    preheader: 'Fair enough. Here’s what to weigh.',
    body: [
      `${c.name},`,
      'If you’re still weighing this up, that’s fair. It’s a big move.',
      'Here’s what’s on each side. Book the call and the worst case is 30 minutes and a clearer picture of what your first acquisition could look like. Don’t, and the plan for growth stays what it is today.',
      'If you’d rather see the deal structure again first, part 2 is still up.',
    ],
    cta: { label: 'Book a call →', href: bookOrBreakout(c) },
  }),
  b_final: (c) => ({
    subject: 'last email about part 2',
    preheader: 'After this, I’ll leave it with you.',
    body: [
      `Hey ${c.name},`,
      'This is the last email I’ll send you about part 2 and the strategy call.',
      'If buying the businesses next to yours isn’t a priority right now, no problem. If it is, the call is where it starts: your numbers, a target that fits, and a structure where the seller and the bank fund the deal.',
    ],
    cta: { label: 'Book my call →', href: bookOrBreakout(c) },
  }),

  // ── C tier: nurture, no call push ──────────────────────────────────
  c_resources: (c) => ({
    subject: 'your acquisition-ready toolkit',
    preheader: 'Checklist, deal template and seller scripts.',
    body: [
      `Hey ${c.name}, thanks for applying.`,
      'Based on your answers, the best next step is getting the business acquisition-ready first. So here’s the toolkit:',
      '• The $1M+ Acquisition Readiness Checklist<br>• A seller-finance deal structure template<br>• Off-market seller outreach scripts',
    ],
    cta: { label: 'Get the toolkit →', href: c.link('/resources#kit') },
  }),
  c_third_way: (c) => ({
    subject: 'the third way to grow',
    preheader: 'Not more hires. Not investors.',
    body: [
      `Hey ${c.name},`,
      'Most owners try to grow in one of two ways: grind out organic growth, or raise money and give away equity.',
      'There’s a third way: buy the businesses next to yours, with the seller and the bank financing the deal, so none of your own cash goes in.',
      'When your business is ready for it, the door’s open. In the meantime, the toolkit is the place to start.',
    ],
    cta: { label: 'Open the toolkit →', href: c.link('/resources') },
  }),
  c_seller_finance: (c) => ({
    subject: 'how seller finance actually works',
    preheader: 'The seller becomes your lender.',
    body: [
      `${c.name},`,
      'Seller finance sounds complicated. It isn’t.',
      'Instead of the seller getting the full price in cash at closing, they agree to be paid part of it over time, out of the business’s own cash flow. In effect, the seller becomes one of your lenders.',
      'Put that together with senior debt from a bank and the two can cover more than the purchase price. That’s what over-financed means, and it’s why none of your own cash has to go in.',
      'Why would a seller agree? Many want a smooth handover, a fair price and an income after they step back. A well-structured deal gives them all three. I bought both of my businesses this way.',
    ],
    cta: { label: 'See the deal template →', href: c.link('/resources') },
  }),
  c_dscr: (c) => ({
    subject: 'why a good deal pays for itself',
    preheader: 'One ratio tells you if it works.',
    body: [
      `Hey ${c.name},`,
      'If you remember one number from all this, make it DSCR: the debt service coverage ratio.',
      'It compares the cash a business generates each year with the cost of its loan repayments each year. Divide the first by the second.',
      'We look for around 1.5x. That means for every dollar going out in repayments, about a dollar fifty is coming in. The acquisition services its own debt, and your existing business doesn’t have to carry it.',
      'It’s the first thing a lender checks, so it’s worth knowing before you ever speak to a seller.',
    ],
    cta: { label: 'Read more in the resources →', href: c.link('/resources') },
  }),
  c_ready: (c) => ({
    subject: 'are you acquisition-ready?',
    preheader: 'Five things to check this month.',
    body: [
      `${c.name},`,
      'Here’s a short version of the readiness checklist. Work through it and you’ll be in a much stronger spot when you’re ready to buy.',
      '• Clean financials for the last few years, that a lender can read without a phone call.<br>• Consistent profit, not just revenue.<br>• A team that can run the day-to-day without you in every decision.<br>• A banking relationship you can lean on.<br>• A list of the businesses in your market you’d most like to own.',
      'The full checklist goes into each of these.',
    ],
    cta: { label: 'Get the full checklist →', href: c.link('/resources#kit') },
  }),
  c_reapply: (c) => ({
    subject: `${c.name}, have your numbers changed?`,
    preheader: 'If so, it’s worth another look.',
    body: [
      `Hey ${c.name},`,
      'When you applied, the timing didn’t look right for an acquisition yet.',
      'Businesses change quickly. If your revenue has grown, your profit is steadier, or you’ve got the team in place to free up some of your time, it’s worth applying again. It takes a couple of minutes.',
      'If nothing’s changed, no problem. Keep working through the toolkit.',
    ],
    cta: { label: 'Re-apply →', href: c.link('/apply?again=1') },
  }),

  // ── Booked: confirmation + show-up ─────────────────────────────────
  booked_confirm: (c) => ({
    subject: 'you’re booked ✓ (watch this before we talk)',
    preheader: c.callTime ? `See you ${c.callTime}.` : 'Your call is confirmed.',
    body: [
      `${c.name}, you’re confirmed${c.callTime ? ` for <strong>${c.callTime}</strong>` : ''}.`,
      'To get the most out of the call, watch this short video first. It covers how the call works, what numbers to have ready and how to know if acquisition growth fits your business. Owners who watch it get far more out of the call.',
    ],
    cta: { label: 'Watch before my call →', href: c.link('/breakout') },
    ps: waLine(c, 'Add me on WhatsApp so you get your reminder'),
  }),
  call_48h: (c) => ({
    subject: `two days out: what to bring${c.callTime ? ` (${c.callTime})` : ''}`,
    preheader: 'Rough numbers are fine.',
    body: [
      `Hey ${c.name}, we’re talking in two days${c.callTime ? `, ${c.callTime}` : ''}.`,
      'To make the 30 minutes count, have these to hand:',
      '• Last year’s revenue and profit (rough is fine).<br>• Any debt the business carries today.<br>• Two or three businesses in your market you’d like to own, if any come to mind.<br>• How many hours a week you could give a deal.',
      'If you haven’t watched the pre-call video yet, now’s a good time.',
    ],
    cta: { label: 'Watch the pre-call video →', href: c.link('/breakout') },
    ps: waLine(c, 'Questions before the call? Message me on WhatsApp'),
  }),
  call_24h: (c) => ({
    subject: `tomorrow: your strategy call${c.callTime ? ` (${c.callTime})` : ''}`,
    preheader: 'A quick reminder and what to have ready.',
    body: [
      `Hey ${c.name}, quick reminder that we’re talking tomorrow${c.callTime ? `, ${c.callTime}` : ''}.`,
      'Have last year’s revenue and profit to hand (rough numbers are fine), and think about which businesses in your market you’d most like to own.',
    ],
    cta: { label: 'Watch the pre-call video →', href: c.link('/breakout') },
    ps: c.rescheduleUrl ? `Need to move it? <a href="${c.link(c.rescheduleUrl)}">Pick a new time here</a>.` : waLine(c, 'Need to move it? Message me on WhatsApp'),
  }),
  call_3h: (c) => ({
    subject: c.callTime ? `today at ${c.callTime}` : 'we’re talking today',
    preheader: 'A few hours to go.',
    body: [
      `${c.name}, we’re on in a few hours${c.callTime ? ` (${c.callTime})` : ''}.`,
      c.joinUrl ? 'The meeting link is below and in your calendar invite. If you have ten minutes before then, the pre-call video is the best way to use them.' : 'The link is in your calendar invite. If you have ten minutes before then, the pre-call video is the best way to use them.',
    ],
    cta: { label: 'Watch the pre-call video →', href: c.link('/breakout') },
    ps: c.joinUrl ? `Meeting link: <a href="${c.link(c.joinUrl)}">join the call</a>.` : undefined,
  }),
  call_1h: (c) => ({
    subject: 'starting in 1 hour',
    preheader: 'Join from a quiet spot on a laptop.',
    body: [
      `${c.name}, we’re on in about an hour.`,
      `Join from a quiet spot on a laptop, and if a business partner is part of the decision, bring them along. ${c.joinUrl ? 'Here’s the link:' : 'The link is in your calendar invite.'}`,
    ],
    cta: c.joinUrl ? { label: 'Join the call →', href: c.link(c.joinUrl) } : undefined,
    ps: waLine(c, 'Running late? Message me on WhatsApp'),
  }),
  call_10m: (c) => ({
    subject: 'starting in 10 minutes',
    preheader: 'The link is in your calendar invite.',
    body: [
      `${c.name}, we’re starting in 10 minutes.`,
      c.joinUrl ? 'Here’s the link. See you there.' : 'The link is in your calendar invite. See you there.',
    ],
    cta: c.joinUrl ? { label: 'Join the call now →', href: c.link(c.joinUrl) } : undefined,
    ps: waLine(c, 'Can’t find the link? Message me on WhatsApp'),
  }),

  // ── Pre-call barrage: 6 a day between booking and the call, one pain point each ──
  // Short, from Josh, plain text. Each ends with the pre-call video or a reply ask.
  pc_ceiling: (c) => ({
    subject: 'the ceiling nobody talks about',
    preheader: 'Organic growth has a speed limit. Acquisitions don’t.',
    body: [
      `${c.name},`,
      'Most owners at $1M+ hit the same wall. You’re growing, but slowly. Every new dollar costs another hire, another campaign, another month of your time.',
      'That isn’t a you problem. Organic growth has a speed limit, and it’s set by how fast you can sell, hire and deliver.',
      'An acquisition skips the queue. You buy revenue, customers and a trained team that already exist, on day one.',
      'That’s what we’ll map out on your call.',
    ],
    cta: { label: 'Watch the pre-call video →', href: c.link('/breakout') },
    ps: 'Hit reply and tell me your revenue last year. Rough is fine. It helps me prep.',
  }),
  pc_bank: (c) => ({
    subject: 'banks don’t reject buyers',
    preheader: 'They reject structures.',
    body: [
      `${c.name}, quick one.`,
      'If you’ve ever asked a bank to fund an acquisition and got a polite no, here’s what actually happened.',
      'The bank didn’t reject you. It rejected the structure: too much senior debt on too little cash flow, no seller skin in the game, nothing left for working capital.',
      'Fix the structure and the same bank says yes. We build the structure first, then take it to the lender.',
    ],
    cta: { label: 'See how the structure works →', href: c.link('/breakout') },
  }),
  pc_own_cash: (c) => ({
    subject: 'why your own cash is the expensive way',
    preheader: 'Over-financed means the stack covers more than the price.',
    body: [
      `${c.name},`,
      'Most owners assume buying a business means writing a big cheque. Usually it’s their savings, or cash pulled out of the business they already own.',
      'That’s the most expensive money you have. It slows your current business down and leaves you exposed if the deal wobbles.',
      'We do it differently. Seller finance plus senior debt covers more than the purchase price. The extra goes into working capital and closing costs. None of your cash goes in.',
      'We call that over-financed, and we’ll show you how it applies to your situation on the call.',
    ],
    cta: { label: 'Watch the pre-call video →', href: c.link('/breakout') },
  }),
  pc_no_time: (c) => ({
    subject: '“I don’t have time to run another business”',
    preheader: 'You’re not buying a job. You’re buying a team.',
    body: [
      `${c.name},`,
      'This is the objection I hear most, and it makes sense. You’re already flat out.',
      'Here’s the thing: you’re not buying a second job. You’re buying a business that already runs, with staff who already do the work. Part of the deal is making sure the right people stay.',
      'The deal itself takes a few focused hours a week. My team handles the heavy lifting with you.',
    ],
    ps: 'On the call, tell us honestly how many hours a week you have. We’ll plan around that number.',
  }),
  pc_brokers: (c) => ({
    subject: 'the listings are the leftovers',
    preheader: 'By the time it’s on a broker site, you’re in an auction.',
    body: [
      `${c.name},`,
      'When a business hits a broker listing, every buyer in the country sees it at once. The price goes up and the terms get worse. You end up competing with buyers who have deeper pockets.',
      'The best deals never get listed. They come from talking to owners in your market who are thinking about stepping back and haven’t told anyone yet.',
      'Off-market is where you get seller finance, fair prices and time to do it properly. We’ll talk about who those owners might be in your space.',
    ],
    cta: { label: 'Watch the pre-call video →', href: c.link('/breakout') },
  }),
  pc_seller: (c) => ({
    subject: 'why would a seller finance you?',
    preheader: 'Because price is rarely what they care about most.',
    body: [
      `${c.name},`,
      'Fair question. Why would an owner let you pay them over time instead of all up front?',
      'Because most retiring owners care about three things more than squeezing the last dollar:',
      '• Their staff and customers are looked after.<br>• The business keeps their name and reputation intact.<br>• They get paid reliably, often with a better tax outcome than a lump sum.',
      'An owner-operator in the same industry is the buyer who gives them all three. That’s you.',
    ],
    ps: 'We’ll go through how to open that conversation with a seller on your call.',
  }),
  pc_dscr: (c) => ({
    subject: 'what if the debt sinks me?',
    preheader: '1.5x is the line.',
    body: [
      `${c.name},`,
      'Being scared of debt is healthy. Too much of it is how good businesses die.',
      'So every deal we structure has to pass one test: a debt service coverage ratio of about 1.5. The acquired business earns roughly $1.50 for every $1 of loan repayments.',
      'If the numbers don’t clear that line, we don’t do the deal. Simple.',
    ],
    cta: { label: 'Watch the pre-call video →', href: c.link('/breakout') },
  }),
  pc_consolidate: (c) => ({
    subject: 'someone is buying your competitors',
    preheader: 'Consolidate or be consolidated.',
    body: [
      `${c.name},`,
      'Private equity and well-funded roll-ups are buying up small businesses in almost every industry. Yours is probably no exception.',
      'Every competitor they buy gets bigger, gets better terms with suppliers and gets better at winning your customers.',
      'You can watch that happen, or you can be the one doing the buying in your own market, where you know the customers, the staff and the numbers better than any fund does.',
    ],
    ps: 'Make a list of 3 businesses in your market you’d love to own and bring it to the call.',
  }),
  pc_multiple: (c) => ({
    subject: 'bigger businesses sell for more per dollar',
    preheader: 'The quiet maths behind roll-ups.',
    body: [
      `${c.name},`,
      'Here’s something most owners never get told.',
      'Small businesses usually sell for a lower multiple of profit than bigger ones. Buyers pay a premium for size, systems and less dependence on one owner.',
      'So when you combine two businesses, you’re not only adding profit. You can also move the whole thing into a higher valuation bracket.',
      'Nothing is guaranteed and every market is different. But this is why acquisitions build wealth faster than growing one business organically.',
    ],
    cta: { label: 'Watch the pre-call video →', href: c.link('/breakout') },
  }),
  pc_in_not_on: (c) => ({
    subject: 'you are the bottleneck (said with love)',
    preheader: 'Buying a business can buy you management depth.',
    body: [
      `${c.name},`,
      'If the business slows down every time you take a week off, you don’t own a business yet. You own a very demanding job.',
      'One of the most underrated parts of an acquisition is what comes with it: managers, systems and people who already know how to run things without you.',
      'Done right, the second business makes the first one less dependent on you, not more.',
    ],
    ps: 'Reply and tell me: if you took 4 weeks off tomorrow, what would break first?',
  }),
  pc_fell_over: (c) => ({
    subject: 'if a deal has fallen over on you before',
    preheader: 'It almost always comes back to one thing.',
    body: [
      `${c.name},`,
      'Maybe you’ve looked at buying a business before and it went nowhere. The bank stalled, the seller went cold, or the numbers fell apart in due diligence.',
      'When we look back at deals like that, it almost always comes down to structure. It wasn’t built to be fundable from day one.',
      'We start with the structure, so the lender, the seller and you all say yes to the same deal.',
    ],
    cta: { label: 'Watch the pre-call video →', href: c.link('/breakout') },
  }),
  pc_lemon: (c) => ({
    subject: 'how not to buy a lemon',
    preheader: 'Due diligence is boring. It’s also the whole game.',
    body: [
      `${c.name},`,
      'The fear of buying a business that looks great on paper and falls apart after settlement is real.',
      'That’s why due diligence matters more than negotiation. We check whether the revenue is real, whether the customers stay, whether the key staff stay, and what the debt looks like.',
      'You get a checklist and a team that has seen the traps before, so you’re not finding them for the first time with your own money on the line.',
    ],
    ps: 'On the call, ask us what the three biggest red flags are. It’s a good test of anyone advising you.',
  }),
  pc_partner: (c) => ({
    subject: 'bring your partner to the call',
    preheader: 'Big decisions shouldn’t be made alone.',
    body: [
      `${c.name},`,
      'If there’s a business partner, co-owner or spouse who’d be part of a decision like this, bring them to the call.',
      'It’s far better for them to hear it first-hand and ask their own questions than to get a second-hand summary from you that evening.',
      'Just forward them the calendar invite. It’s a video call, so they can join from anywhere.',
    ],
  }),
  pc_next_year: (c) => ({
    subject: '“maybe next year”',
    preheader: 'The 90-day window exists for a reason.',
    body: [
      `${c.name},`,
      '“Next year” is the most expensive phrase in business. It’s what most owners say about the acquisition they never make.',
      'That’s why we work to a 90-day goal: a signed LOI within 90 days. A deadline forces decisions, conversations with sellers and real numbers.',
      'Your call is the first step in that window.',
    ],
    cta: { label: 'Watch the pre-call video →', href: c.link('/breakout') },
  }),
  pc_guarantee: (c) => ({
    subject: 'the 7-day rule',
    preheader: 'Here’s how the risk works if you go ahead.',
    body: [
      `${c.name},`,
      'You’ll hear about this on the call, but I want you to know it now so it isn’t in the back of your mind.',
      'If you decide to work with us and in the first 7 days it isn’t for you, you get a full refund. No conditions.',
      'I’d rather you make the decision with nothing to lose than talk yourself out of it from fear.',
    ],
  }),
  pc_done_with: (c) => ({
    subject: 'why we don’t do it for you',
    preheader: 'You keep control. You keep the upside.',
    body: [
      `${c.name},`,
      'People sometimes ask why we don’t just find the deal and hand it over.',
      'Because you are the buyer. You know your market. You’ll be the one the seller trusts, and you’ll be the one running the business afterwards. If someone else does it for you, you don’t learn how, and they take a bigger slice of the upside.',
      'So it’s done with you. You run the deal, and we give you the system, the structures, the lender introductions and a seat beside you in the key seller conversations.',
    ],
    cta: { label: 'Watch the pre-call video →', href: c.link('/breakout') },
  }),
  pc_josh: (c) => ({
    subject: 'how I bought my first two',
    preheader: '100% seller finance, both times.',
    body: [
      `${c.name},`,
      'Quick bit of background before we talk.',
      'I founded JC Health Group. When I wanted to grow faster than organic growth allowed, I bought businesses instead. Two of them, both with 100% seller finance.',
      'I didn’t have a fund or a family office. What I had was a structure that worked for the seller, the bank and me. That’s what we teach.',
    ],
    ps: 'Ask me anything about those deals on the call. Nothing is off limits.',
  }),
  pc_cash_trap: (c) => ({
    subject: 'growth is eating your cash',
    preheader: 'Organic growth costs cash up front. Acquisitions can bring it with them.',
    body: [
      `${c.name},`,
      'Growing organically is expensive. You hire before the revenue arrives, buy stock before it sells and spend on marketing before it pays back.',
      'That’s why so many $1M+ businesses feel cash-poor even when they’re growing.',
      'A well-structured acquisition works the other way round. You take on a business that already produces cash flow, and the over-financing puts working capital in from day one.',
    ],
    cta: { label: 'Watch the pre-call video →', href: c.link('/breakout') },
  }),
  pc_hiring: (c) => ({
    subject: 'still trying to hire?',
    preheader: 'Acquisitions come with trained people.',
    body: [
      `${c.name},`,
      'Hiring good people is slow, expensive and a coin flip.',
      'When you acquire a business, you get a team who already know the work, the customers and each other. Often the hardest part of growth arrives already solved.',
      'Keeping them is part of how we structure and plan the handover.',
    ],
  }),
  pc_two_paths: (c) => ({
    subject: 'two ways to do this',
    preheader: 'The hard way and the proven way.',
    body: [
      `${c.name},`,
      'There are two ways to make your first acquisition.',
      'The hard way: you figure it out alone. You find out what lenders want by getting rejected, learn negotiation from sellers who’ve done it before, and discover the due-diligence traps the expensive way. It can take years, if it happens at all.',
      'The proven way: someone who has already made those mistakes shows you the path, beside you, while you do it.',
      'Your call is where you decide which one you’re taking.',
    ],
    cta: { label: 'Watch the pre-call video →', href: c.link('/breakout') },
  }),
  pc_if_you_could: (c) => ({
    subject: 'honest question',
    preheader: 'If it were easy, you’d have done it already.',
    body: [
      `${c.name}, honest question.`,
      'If you could buy a business with no money down on your own, wouldn’t you have done it already?',
      'That isn’t a criticism. It’s just that the gap is rarely ambition. It’s knowing what lenders will fund, how to approach sellers off-market, and how to structure it so everyone says yes.',
      'That gap is exactly what we close on the call.',
    ],
  }),
  pc_cost: (c) => ({
    subject: 'what waiting costs',
    preheader: 'Every year of organic-only growth has a price.',
    body: [
      `${c.name},`,
      'Let’s talk about the cost of not doing this.',
      'It’s another year of growing one slow step at a time. It’s watching a competitor buy the business you should have bought. It’s staying the bottleneck in your own company.',
      'The call costs you 30 minutes. The status quo costs a lot more, it just doesn’t send an invoice.',
    ],
    cta: { label: 'Watch the pre-call video →', href: c.link('/breakout') },
  }),
  pc_agenda: (c) => ({
    subject: 'exactly what happens on the call',
    preheader: 'No mystery, no hard sell.',
    body: [
      `${c.name}, here’s how the call works${c.callTime ? ` (${c.callTime})` : ''}:`,
      '1. We look at your business: revenue, profit, team and goals.<br>2. We talk about what an acquisition could look like in your market.<br>3. We sketch the structure: seller finance, senior debt and the DSCR test.<br>4. If it’s a fit, we explain how we work together. If it isn’t, we’ll tell you straight.',
      'You’ll leave with a clear picture either way.',
    ],
    cta: { label: 'Watch the pre-call video →', href: c.link('/breakout') },
  }),
  pc_questions: (c) => ({
    subject: 'what’s your #1 question?',
    preheader: 'Send it now and we’ll come prepared.',
    body: [
      `${c.name},`,
      'Before we talk, what’s the one question you most want answered?',
      'Is it the financing? Whether your industry works? Whether you have the time? What it costs?',
      'Hit reply and tell me. We’ll make sure it’s answered on the call.',
    ],
    ps: waLine(c, 'Or send it on WhatsApp'),
  }),

  // ── Behaviour-triggered (one-off, rewritten per person by the personaliser) ──
  t_vsl_no_apply: (c) => ({
    subject: 'you watched most of it',
    preheader: 'The next step takes two minutes.',
    body: [
      `${c.name},`,
      'You got through most of the video, which tells me the idea landed: buying growth instead of building it, with no money down.',
      'The next step is the short application. It’s how we check the numbers fit before we put time on a call with you. Your answers so far are saved.',
    ],
    cta: { label: 'Finish my application →', href: c.link('/apply') },
  }),
  t_stalled: (c) => ({
    subject: 'that question trips a lot of owners up',
    preheader: 'There’s no wrong answer.',
    body: [
      `${c.name},`,
      'You stopped partway through the application. That’s normal: a couple of the questions make people pause.',
      'There are no wrong answers. Rough numbers are fine, and nothing you put in commits you to anything. It just tells us whether a call is worth your time.',
    ],
    cta: { label: 'Pick up where I left off →', href: c.link('/apply') },
  }),
  t_finish_booking: (c) => ({
    subject: 'your time slot is still open',
    preheader: 'You picked a day, then something came up.',
    body: [
      `${c.name},`,
      'Looks like you picked a day for your strategy call but didn’t get to confirm the time. Easy to get pulled away.',
      'The calendar is still open. It takes about 20 seconds to lock it in.',
    ],
    cta: { label: 'Confirm my time →', href: c.bookingUrl ? c.link('/book') : c.link('/breakout') },
  }),
  t_came_back: (c) => ({
    subject: 'good to see you back',
    preheader: 'Still weighing it up?',
    body: [
      `${c.name},`,
      'You were back on the page, so I’m guessing you’re still weighing this up. Fair enough: it’s a big move.',
      'The call is the easiest way to get a straight answer on whether an acquisition makes sense for your business. 30 minutes, no pressure.',
    ],
    cta: { label: 'Book my strategy call →', href: c.bookingUrl ? c.link('/book') : c.link('/breakout') },
  }),
  t_still_thinking: (c) => ({
    subject: 'what owners usually ask before they book',
    preheader: 'Three questions, three straight answers.',
    body: [
      `${c.name},`,
      'You’ve been back a few times, so let me answer the three questions owners usually have at this point.',
      '<b>Do I really put no money down?</b> Yes. Seller finance plus senior debt covers more than the price.<br><b>Do I have the time?</b> A few focused hours a week. My team does the heavy lifting with you.<br><b>What if it isn’t for me?</b> 7-day money-back guarantee, no conditions.',
    ],
    cta: { label: 'Book my strategy call →', href: c.bookingUrl ? c.link('/book') : c.link('/breakout') },
  }),
  t_guarantee: (c) => ({
    subject: 'how the 7-day guarantee works',
    preheader: 'No small print.',
    body: [
      `${c.name},`,
      'Quick one on the guarantee, since it’s the part people want to be sure about.',
      'If you start with us and decide in the first 7 days it isn’t for you, you get a full refund. No conditions, no small print. I’d rather you decide with nothing to lose.',
    ],
    cta: { label: 'Book my strategy call →', href: c.bookingUrl ? c.link('/book') : c.link('/breakout') },
  }),
  t_funding: (c) => ({
    subject: 'how the money actually works',
    preheader: 'Seller finance + senior debt, in plain English.',
    body: [
      `${c.name},`,
      'You were looking into the funding side, so here it is in plain English.',
      'The seller agrees to be paid part of the price over time, out of the business’s own cash flow. A bank funds the rest as senior debt. Together they cover more than the price, so none of your cash goes in and there’s working capital left over. Every deal has to clear a debt service coverage ratio of about 1.5.',
    ],
    cta: { label: 'See it applied to my business →', href: c.bookingUrl ? c.link('/book') : c.link('/breakout') },
  }),
  t_book_nudge: (c) => ({
    subject: 'one click from booked',
    preheader: 'You were right there.',
    body: [
      `${c.name},`,
      'You opened the booking page but didn’t pick a time. If none of the times suit you, just reply and tell me when works.',
    ],
    cta: { label: 'See the open times →', href: c.bookingUrl ? c.link('/book') : c.link('/breakout') },
  }),
  t_breakout_done: (c) => ({
    subject: 'you watched part two',
    preheader: 'Here’s the next step.',
    body: [
      `${c.name},`,
      'You watched the breakout session, so you’ve seen how the deals are structured.',
      'The next step is a strategy call where we apply it to your business: the target, the structure and the financing.',
    ],
    cta: { label: 'Book my strategy call →', href: c.bookingUrl ? c.link('/book') : c.link('/breakout') },
  }),
  t_watch_prep: (c) => ({
    subject: 'before we talk',
    preheader: 'Ten minutes that make the call twice as useful.',
    body: [
      `${c.name},`,
      `Looking forward to the call${c.callTime ? ` on ${c.callTime}` : ''}. One thing that makes it far more useful: the short pre-call video. It covers what we’ll go through and what to have ready.`,
    ],
    cta: { label: 'Watch the pre-call video →', href: c.link('/breakout') },
  }),

  // ── No-show: reschedule ────────────────────────────────────────────
  noshow_1: (c) => ({
    subject: `${c.name}, missed you just now`,
    preheader: 'Grab another time.',
    body: [
      `Hey ${c.name},`,
      'Looks like we missed each other on the call. It happens. Something came up, the link didn’t work, the day got away from you.',
      'Grab another time that suits you and we’ll pick it up from there.',
    ],
    cta: { label: 'Pick a new time →', href: c.link('/book?reschedule=1') },
    ps: waLine(c, 'Easier to sort it on WhatsApp? Message me there'),
  }),
  noshow_2: (c) => ({
    subject: 'still want that call?',
    preheader: 'Your approval still stands.',
    body: [
      `${c.name},`,
      'Your approval for a strategy call still stands. We just need a time that works.',
      'Thirty minutes, and you’ll leave with a clear picture of your first acquisition: the target, the structure and the financing.',
    ],
    cta: { label: 'Reschedule my call →', href: c.link('/book?reschedule=1') },
  }),
  noshow_3: (c) => ({
    subject: 'I’ll stop chasing after this',
    preheader: 'Last chance to rebook.',
    body: [
      `Hey ${c.name},`,
      'I don’t want to fill your inbox, so this is the last time I’ll ask.',
      'If buying your next business is still on the cards, rebook the call. If the timing’s wrong, no problem, and the door stays open.',
    ],
    cta: { label: 'Rebook my call →', href: c.link('/book?reschedule=1') },
  }),

  // ── Post-call: no decision yet ─────────────────────────────────────
  post_1: (c) => ({
    subject: `${c.name}, recap from our call`,
    preheader: 'What we covered and what happens next.',
    body: [
      `Hey ${c.name}, thanks for your time today.`,
      'A quick recap of how this works. The goal is a signed LOI within 90 days on an acquisition that can double or triple your business, with no money down. Seller finance and senior debt cover more than the price, and we aim for around 1.5x DSCR so the deal services its own debt.',
      'It’s done with you: you run the deal, and my team coaches you, structures it, introduces the lenders and sits in on the key seller conversations.',
      'If you have a question we didn’t get to, just reply to this email. If you want to see the deal structure again, it’s here.',
    ],
    cta: { label: 'Rewatch the deal breakdown →', href: c.link('/breakout') },
    ps: waLine(c),
  }),
  post_2: (c) => ({
    subject: 'nothing to lose for 7 days',
    preheader: 'Full refund if it’s not for you.',
    body: [
      `${c.name},`,
      'If what’s holding you back is the worry that it won’t be the right fit, here’s how we handle that.',
      'You get seven days. If at any point in those first seven days you decide it’s not for you, you get a full refund.',
      'So the real question isn’t whether to risk it. It’s whether you want a signed LOI in the next 90 days. If you do, reply “ready” and we’ll get you started.',
    ],
    ps: waLine(c, 'Rather talk it through? Message me on WhatsApp'),
  }),
  post_3: (c) => ({
    subject: 'should I close your file?',
    preheader: 'A one-word reply is fine.',
    body: [
      `Hey ${c.name},`,
      'I haven’t heard back since our call, so I want to check where you are.',
      'Just reply with one word:',
      '• <strong>Ready</strong> if you want to get started.<br>• <strong>Later</strong> if the timing’s off and you’d like me to check back.<br>• <strong>Close</strong> if it’s not for you.',
      'Any answer is fine. If I don’t hear back, I’ll close your file.',
    ],
  }),

  // ── Voice assistant: link sent during a call ───────────────────────
  voice_link: (c) => ({
    subject: c.bookingUrl && c.lead.app_completed_at ? 'the link to book your strategy call' : 'the link to your application',
    preheader: 'As promised on the phone.',
    body: [
      `Hey ${c.name},`,
      c.bookingUrl && c.lead.app_completed_at
        ? 'As promised on the call, here’s the link to pick a time for your strategy call with my team. We’ll map out your first off-market acquisition: the target, the structure and the financing.'
        : 'As promised on the call, here’s the link to the application. It takes a couple of minutes, and if you’re a fit you’ll pick a time for a strategy call with my team straight after.',
    ],
    cta: c.bookingUrl && c.lead.app_completed_at ? { label: 'Pick a time →', href: c.link('/book') } : { label: 'Start my application →', href: c.link('/apply') },
    ps: waLine(c),
  }),

  // Sent from the dashboard's Integrations tab to verify the email connection.
  test: (c) => ({
    subject: `Test email from ${c.siteName}`,
    preheader: 'Your email connection works.',
    body: ['If you’re reading this, Resend is connected and the funnel can send email.'],
  }),
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderEmail(content: EmailContent, opts: { openPixel: string | null; unsubscribeUrl: string; signature: string; address: string }) {
  const p = (html: string) => `<p style="margin:0 0 16px">${html}</p>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(content.subject)}</title></head>
<body style="margin:0;padding:0;background:#ffffff">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(content.preheader)}</span>
<div style="max-width:560px;margin:0 auto;padding:28px 20px;font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#111">
${content.body.map(p).join('\n')}
${content.cta ? `<p style="margin:24px 0"><a href="${content.cta.href}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;font-weight:700;padding:14px 22px;border-radius:8px">${content.cta.label}</a></p>` : ''}
${p(`Talk soon,<br>${esc(opts.signature)}`)}
${content.ps ? p(`<strong>P.S.</strong> ${content.ps}`) : ''}
<hr style="border:0;border-top:1px solid #eee;margin:28px 0 12px">
<p style="margin:0;font-size:12px;color:#888">${esc(opts.address)} · <a href="${opts.unsubscribeUrl}" style="color:#888">Unsubscribe</a></p>
${opts.openPixel ? `<img src="${opts.openPixel}" width="1" height="1" alt="" style="display:block;border:0">` : ''}
</div></body></html>`;

  const text = [
    ...content.body.map(htmlToText),
    content.cta ? `${htmlToText(content.cta.label)}: ${content.cta.href}` : '',
    `Talk soon,\n${opts.signature}`,
    content.ps ? `P.S. ${htmlToText(content.ps)}` : '',
    `Unsubscribe: ${opts.unsubscribeUrl}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  return { html, text };
}

function htmlToText(html: string) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ');
}
