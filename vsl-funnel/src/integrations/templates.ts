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
    ps: waLine(c, 'Need to move it? Message me on WhatsApp'),
  }),
  call_3h: (c) => ({
    subject: c.callTime ? `today at ${c.callTime}` : 'we’re talking today',
    preheader: 'A few hours to go.',
    body: [
      `${c.name}, we’re on in a few hours${c.callTime ? ` (${c.callTime})` : ''}.`,
      'The link is in your calendar invite. If you have ten minutes before then, the pre-call video is the best way to use them.',
    ],
    cta: { label: 'Watch the pre-call video →', href: c.link('/breakout') },
  }),
  call_1h: (c) => ({
    subject: 'starting in 1 hour',
    preheader: 'Join from a quiet spot on a laptop.',
    body: [
      `${c.name}, we’re on in about an hour.`,
      'Join from a quiet spot on a laptop, and if a business partner is part of the decision, bring them along. The link is in your calendar invite.',
    ],
    ps: waLine(c, 'Running late? Message me on WhatsApp'),
  }),
  call_10m: (c) => ({
    subject: 'starting in 10 minutes',
    preheader: 'The link is in your calendar invite.',
    body: [
      `${c.name}, we’re starting in 10 minutes.`,
      'The link is in your calendar invite. See you there.',
    ],
    ps: waLine(c, 'Can’t find the link? Message me on WhatsApp'),
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
