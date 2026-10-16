import type { EmailContent, TemplateCtx } from '../integrations/templates';
import { GUIDES } from '../seo/guides';
import { REACTIVATE_A } from './reactivation-a';
import { REACTIVATE_B } from './reactivation-b';
import { REACTIVATE_C } from './reactivation-c';
import { BLOCKERS, GOALS, LOST_ANGLES, OBJECTIONS, TIMELINES, blockerOf, buildDossier, type Dossier, industryName, peers, profitText, yourBiz } from './dossier';

/**
 * Follow-up written from the lead's own application and booking answers.
 * Every template reads the dossier at send time, so a lead who changes their
 * answers (or whose objection gets logged after the call) gets copy that
 * matches. Each one must still read naturally when a field is missing.
 */
type T = (c: TemplateCtx, d: Dossier) => EmailContent;

const book = (c: TemplateCtx) => c.link(c.bookingUrl ? '/book' : '/breakout');
const rebook = (c: TemplateCtx) => c.rescheduleUrl ?? book(c);
const wa = (c: TemplateCtx) => (c.whatsappUrl ? `Or message me on WhatsApp: <a href="${c.whatsappUrl}">tap here</a>. I read every one.` : undefined);
const callLine = (c: TemplateCtx) => (c.callTime ? `See you on ${c.callTime}.` : 'See you on the call.');
const quote = (s: string) => `<em>“${s}”</em>`;
const sizeLine = (d: Dossier) => (d.revenueLabel ? `a business doing ${d.revenueLabel.replace(/^Under /, 'under ')} in revenue` : null);

const PREP: Record<string, T> = {
  pp_brief: (c, d) => ({
    subject: `${c.name}, I read your application`,
    preheader: 'Here’s what I took from it, and what we’ll cover.',
    body: [
      `Hey ${c.name},`,
      'Before your strategy call I go through every application properly. Here’s what I took from yours:',
      [
        d.business ? `• <strong>The business:</strong> ${d.business}` : null,
        sizeLine(d) ? `• <strong>Size:</strong> ${sizeLine(d)}${profitText(d) ? `, with profit ${profitText(d)}` : ''}` : null,
        d.goal && GOALS[d.goal] ? `• <strong>What you want:</strong> to ${GOALS[d.goal].line}` : null,
        d.timeline && TIMELINES[d.timeline] ? `• <strong>Timeline:</strong> ${({ '0_6': 'the next 6 months', '6_12': '6 to 12 months', '12_plus': '12 months or more', exploring: 'just exploring' } as Record<string, string>)[d.timeline]}` : null,
        blockerOf(d) ? `• <strong>What’s in the way:</strong> ${blockerOf(d)!.name}` : null,
      ].filter(Boolean).join('<br>') || '• You want to grow by acquisition, and you want to see what that looks like with real numbers.',
      d.whyNow ? `And when we asked why now, you wrote: ${quote(d.whyNow)} That’s the part I care about most. We’ll build the call around it.` : 'On the call we’ll build everything around your numbers, not a generic pitch.',
      `So on the call we’ll map out three things for ${yourBiz(d)}: the kind of business to buy, how the deal gets structured, and how the financing stacks up. ${callLine(c)}`,
    ],
    ps: 'If any of that is wrong or has changed, just reply and tell me. It makes the call better.',
  }),
  pp_blocker1: (c, d) => {
    const b = blockerOf(d, 0) ?? BLOCKERS.funding;
    return { subject: b.subject, preheader: `You said ${b.name} is what’s in the way.`, body: [`${c.name},`, ...b.body, callLine(c)] };
  },
  pp_blocker2: (c, d) => {
    const b = blockerOf(d, 1) ?? BLOCKERS.time;
    return { subject: b.subject, preheader: `The other thing you flagged: ${b.name}.`, body: [`${c.name}, one more from your application.`, ...b.body] };
  },
  pp_goal: (c, d) => ({
    subject: d.goal === 'exit' ? 'the exit maths' : d.goal === 'group' ? 'deal one of several' : 'how one deal doubles a business',
    preheader: `You want to ${(GOALS[d.goal ?? ''] ?? GOALS.acquire).line}.`,
    body: [`Hey ${c.name},`, ...(GOALS[d.goal ?? ''] ?? GOALS.acquire).body, `That’s the lens we’ll use on ${yourBiz(d)} on the call.`],
  }),
  pp_numbers: (c, d) => ({
    subject: `${c.name}, what a first deal could look like for you`,
    preheader: 'Rough numbers, at your size.',
    body: [
      `${c.name},`,
      `Here’s a rough sketch, based on what you told us${profitText(d) ? ` (profit ${profitText(d)})` : ''}. It’s illustrative, not advice, but it gives you a feel for the scale:`,
      d.deal
        ? `• <strong>Target:</strong> a business making ${d.deal.targetProfit} a year in profit<br>• <strong>Price:</strong> typically ${d.deal.price}, depending on the multiple<br>• <strong>Funding:</strong> senior debt, a seller note and seller rollover, over-financed so none of your own cash goes in<br>• <strong>Test:</strong> the target’s profit covers its repayments about 1.5 times<br>• <strong>Result:</strong> ${d.deal.combined}`
        : '• <strong>Target:</strong> a business your cash flow can support, such as one roughly your size or smaller<br>• <strong>Funding:</strong> senior debt, a seller note and seller rollover, over-financed so none of your own cash goes in<br>• <strong>Test:</strong> the target’s profit covers its repayments about 1.5 times',
      'On the call we’ll replace these ranges with your real numbers.',
    ],
    ps: 'Have your last year’s profit and loss handy if you can. It makes this part much sharper.',
  }),
  pp_industry: (c, d) => {
    const i = d.industry;
    return {
      subject: i ? `buying ${i.many}` : 'who to buy',
      preheader: i ? `What we see in ${i.many} right now.` : 'The best targets are closer than you think.',
      body: [
        `Hey ${c.name},`,
        `${i ? `${i.many[0].toUpperCase()}${i.many.slice(1)} are` : 'Established service businesses are'} some of the best acquisition targets there are: steady demand, repeat customers, and a generation of owners getting ready to retire with nobody to hand over to.`,
        i
          ? `Think about ${i.target}. Most ${i.owners} we speak to can name one or two businesses like that without trying. Those are your targets, and many of those owners would rather sell to someone in the industry who’ll look after their staff and customers.`
          : 'Think about the competitor you keep bumping into, or the business next door to yours whose owner is getting tired. Those are your targets, and many of those owners would rather sell to someone who’ll look after their staff and customers.',
        `Come to the call with a name or two in mind. ${callLine(c)}`,
      ],
    };
  },
  pp_timeline: (c, d) => ({
    subject: d.timeline === '0_6' ? 'your 90 days' : 'on timing',
    preheader: 'How the timeline actually plays out.',
    body: [
      `${c.name},`,
      TIMELINES[d.timeline ?? ''] ?? 'Here’s how the timeline plays out, so you know what you’d be signing up for.',
      'Roughly: weeks 1–3 build the target list and reach out; weeks 4–8 meet owners and model the deals; weeks 9–12 structure the offer, line up the lender and sign the LOI.',
      callLine(c),
    ],
  }),
  pp_why_now: (c, d) => ({
    subject: 'what you wrote',
    preheader: 'I keep coming back to it.',
    body: [
      `${c.name},`,
      d.whyNow ? `When we asked why now, you wrote: ${quote(d.whyNow)}` : 'When owners apply, we ask why now.',
      'Most people write a line. You told us something real, and that matters, because the owners who do this successfully are the ones with a reason that’s bigger than the deal.',
      'Bring that to the call. We’ll work backwards from it.',
    ],
  }),
  pp_booking: (c, d) => ({
    subject: 'about what you told us when you booked',
    preheader: 'We read it, and it’s shaping the call.',
    body: [
      `Hey ${c.name},`,
      'When you booked, you answered a couple of questions. Here’s what you said, so it’s fresh for both of us:',
      d.booking.length ? d.booking.slice(0, 3).map((b) => `• <strong>${b.q.replace(/\?*$/, '?')}</strong><br>${quote(b.a)}`).join('<br><br>') : 'Your notes from the booking are on file with the team.',
      `We’ll start the call right there. ${callLine(c)}`,
    ],
  }),
  pp_partner: (c, d) => ({
    subject: 'bring your partner',
    preheader: 'Anyone involved in the decision should be on the call.',
    body: [
      `${c.name},`,
      d.readiness === 'partner'
        ? 'You said you’d make this decision with your business partner. Then they should be on the call too.'
        : 'You mentioned you co-own the business. If your partner would be part of an acquisition, they should be on the call too.',
      'It saves a second meeting, and they get to ask their own questions first-hand instead of hearing it second-hand from you. Just forward them the calendar invite.',
      callLine(c),
    ],
  }),
  pp_homework: (c, d) => ({
    subject: '3 things to have ready',
    preheader: 'Ten minutes now makes the call twice as useful.',
    body: [
      `Hey ${c.name},`,
      'To get the most out of the call, have these ready:',
      `1. Your last year’s profit and loss (a rough number is fine)<br>2. ${d.industry ? `One or two ${d.industry.many} you’d love to own, like ${d.industry.target}` : 'One or two businesses you’d love to own'}<br>3. ${blockerOf(d) ? `Your biggest question about ${blockerOf(d)!.name}` : 'Your biggest question about how this works'}`,
      `That’s it. ${callLine(c)}`,
    ],
    ...(c.joinUrl ? { cta: { label: 'Save the meeting link →', href: c.joinUrl } } : {}),
  }),
};

/** Which prep emails fit this lead, most specific first. */
export function prepTemplates(d: Dossier): string[] {
  const out: string[] = [];
  if (d.business || d.goal || d.whyNow || d.revenue) out.push('pp_brief');
  if (blockerOf(d, 0)) out.push('pp_blocker1');
  if (d.booking.length) out.push('pp_booking');
  if (d.deal) out.push('pp_numbers');
  if (d.goal && GOALS[d.goal]) out.push('pp_goal');
  if (d.industry) out.push('pp_industry');
  if (d.whyNow && d.whyNow.length >= 40) out.push('pp_why_now');
  if (d.readiness === 'partner' || d.role === 'co_owner') out.push('pp_partner');
  if (d.timeline && TIMELINES[d.timeline]) out.push('pp_timeline');
  if (blockerOf(d, 1)) out.push('pp_blocker2');
  out.push('pp_homework');
  return out;
}

// ── No-show: longer rebooking run (appended after noshow_1..3) ────────
const NOSHOW: Record<string, T> = {
  ns_goal: (c, d) => ({
    subject: `${c.name}, still want to ${d.goal && GOALS[d.goal] ? GOALS[d.goal].line : 'grow by acquisition'}?`,
    preheader: 'Your application is still on my desk.',
    body: [
      `Hey ${c.name},`,
      `We missed each other on the call. Your application is still here, and so is what you told us: ${d.goal && GOALS[d.goal] ? `you want to ${GOALS[d.goal].line}` : 'you want to grow by acquisition'}.`,
      d.whyNow ? `You also wrote: ${quote(d.whyNow)} That doesn’t go away by itself.` : 'That doesn’t go away by itself.',
      'Pick a new time that actually works for you.',
    ],
    cta: { label: 'Rebook my call →', href: rebook(c) },
    ps: wa(c),
  }),
  ns_blocker: (c, d) => {
    const b = blockerOf(d);
    return {
      subject: b ? b.subject : 'the part nobody explains',
      preheader: 'Worth a read before you rebook.',
      body: [`${c.name},`, ...(b ? b.body : BLOCKERS.funding.body), 'That’s what we’d have covered on the call. Happy to pick it up whenever suits you.'],
      cta: { label: 'Pick a new time →', href: rebook(c) },
    };
  },
  ns_numbers: (c, d) => ({
    subject: 'the numbers we were going to run',
    preheader: d.deal ? `A target making ${d.deal.targetProfit} a year.` : 'A rough sketch for your size.',
    body: [
      `${c.name},`,
      d.deal
        ? `Here’s what we were going to look at for ${yourBiz(d)}: a target making ${d.deal.targetProfit} in profit, priced around ${d.deal.price}, funded by senior debt, a seller note and seller rollover with none of your own cash going in. The result: ${d.deal.combined}.`
        : `Here’s what we were going to look at for ${yourBiz(d)}: the size of target your cash flow can support, how the senior debt, seller note and seller rollover stack up, and whether the deal clears the 1.5x coverage lenders look for.`,
      'Those are illustrative numbers. Your real ones are a 30-minute call away.',
    ],
    cta: { label: 'Rebook my call →', href: rebook(c) },
  }),
  ns_final: (c) => ({
    subject: 'last one from me on this',
    preheader: 'I’ll stop chasing.',
    body: [
      `Hey ${c.name},`,
      'I’ll stop chasing after this one. If buying a business is still on the agenda, the link below gets you a new time.',
      'If not, no hard feelings. I’ll still send the odd note on the deals and structures we’re seeing.',
    ],
    cta: { label: 'Rebook my call →', href: rebook(c) },
  }),
};

// ── After the call, no decision yet (appended after post_1..3) ────────
const POSTCALL: Record<string, T> = {
  fu_objection: (c, d) => {
    const o = (d.objection && OBJECTIONS[d.objection]) || null;
    return {
      subject: o ? o.subject : 'what’s holding you back?',
      preheader: 'Picking up where we left off.',
      body: [`${c.name},`, ...(o ? o.body : ['After our call, I’m curious what’s holding you back. Most of the time it’s one of three things: the investment, the timing, or doubts about the funding. Reply and tell me which, and I’ll give you a straight answer.'])],
      ...(c.whatsappUrl ? { ps: wa(c) } : {}),
    };
  },
  fu_recap: (c, d) => ({
    subject: 'your plan, in one email',
    preheader: 'Everything from the call, short.',
    body: [
      `Hey ${c.name},`,
      'Here’s the plan we talked about, in one place:',
      `• <strong>Goal:</strong> ${d.goal && GOALS[d.goal] ? GOALS[d.goal].line : 'grow by acquisition'}<br>• <strong>Target:</strong> ${d.industry ? `a ${d.industry.one} like ${d.industry.target}` : 'a business in or next to your industry'}${d.deal ? `, making ${d.deal.targetProfit} in profit` : ''}<br>• <strong>Structure:</strong> senior debt, a seller note and seller rollover, over-financed, around 1.5x coverage<br>• <strong>Timeline:</strong> a signed LOI in 90 days<br>• <strong>Safety net:</strong> 7-day money-back guarantee`,
      'Reply with any questions and I’ll answer them personally.',
    ],
  }),
  fu_numbers: (c, d) => ({
    subject: 'the cost of not deciding',
    preheader: 'The quiet cost of not deciding.',
    body: [
      `${c.name},`,
      d.deal
        ? `A target making ${d.deal.targetProfit} a year in profit is worth that much to you every year you own it. Each month you wait is a month of that profit going to the current owner, or to whoever buys it first.`
        : 'Every month you wait is a month of a target business’s profit going to its current owner, or to whoever buys it first.',
      'That’s not a reason to rush. It’s a reason to decide.',
    ],
  }),
  fu_industry: (c, d) => ({
    subject: d.industry ? `who’s buying ${d.industry.many}` : 'someone is going to buy it',
    preheader: 'If not you, a competitor.',
    body: [
      `Hey ${c.name},`,
      `Here’s the uncomfortable bit: owners in ${peers(d)} are retiring whether or not you’re ready. When ${d.industry ? d.industry.target : 'the business down the road'} sells, it sells to someone. Sometimes a competitor, sometimes a private equity roll-up.`,
      'Either way, the customer base you could have bought goes to them. Being the buyer is a choice you can make now.',
    ],
  }),
  fu_goal: (c, d) => ({
    subject: 'back to why you applied',
    preheader: d.whyNow ? 'In your own words.' : 'The reason you started this.',
    body: [
      `${c.name},`,
      d.whyNow ? `When you applied, you wrote: ${quote(d.whyNow)}` : 'When you applied, you said you wanted to grow by acquisition.',
      'Nothing about the call changed that. The question is just whether you want to do it with a plan and a team beside you, or keep it as an idea.',
      'Reply “in” and I’ll send the next steps.',
    ],
  }),
  fu_final: (c) => ({
    subject: 'closing the loop',
    preheader: 'One last note.',
    body: [
      `Hey ${c.name},`,
      'I’ll close the loop on our conversation so it’s not hanging over you. If you want to go ahead, reply and we’ll get started this week.',
      'If not, I’ll keep you on my list for the occasional note on deals and structures. Thanks again for your time on the call.',
    ],
  }),
};

// ── Cancelled booking: get them rebooked ─────────────────────────────
const CANCELLED: Record<string, T> = {
  cx_1: (c, d) => ({
    subject: 'no problem, let’s find another time',
    preheader: 'Your application stays as it is.',
    body: [
      `Hey ${c.name},`,
      'Saw your call was cancelled. No problem at all. Things come up.',
      `Your application stays as it is, so whenever you rebook we pick up right where we were: ${d.goal && GOALS[d.goal] ? `how to ${GOALS[d.goal].line}` : 'your first acquisition'}${d.industry ? ` in ${industryName(d.industry)}` : ''}.`,
    ],
    cta: { label: 'Pick a new time →', href: book(c) },
    ps: wa(c),
  }),
  cx_2: (c, d) => {
    const b = blockerOf(d);
    return {
      subject: b ? b.subject : 'while you find a new time',
      preheader: 'Something useful in the meantime.',
      body: [`${c.name},`, ...(b ? b.body : GOALS.acquire.body)],
      cta: { label: 'Rebook my call →', href: book(c) },
    };
  },
  cx_3: (c, d) => ({
    subject: 'still keen?',
    preheader: 'A new time takes ten seconds.',
    body: [
      `Hey ${c.name},`,
      d.whyNow ? `You told us: ${quote(d.whyNow)} If that’s still true, it’s worth 30 minutes.` : 'If buying a business is still on the cards, it’s worth 30 minutes.',
    ],
    cta: { label: 'Pick a new time →', href: book(c) },
  }),
  cx_4: (c) => ({
    subject: 'should I release your spot?',
    preheader: 'Last note on the booking.',
    body: [`${c.name},`, 'I’ll stop nudging about the call after this. If you’d still like one, the link below is the quickest way.'],
    cta: { label: 'Book my call →', href: book(c) },
  }),
};

// ── Lost: long-term re-engagement ────────────────────────────────────
const LOST: Record<string, T> = {
  lo_1: (c, d) => ({
    subject: 'no hard feelings',
    preheader: 'And one thing worth keeping.',
    body: [
      `Hey ${c.name},`,
      'Thanks again for your time on the call. It wasn’t the right moment, and that’s fine.',
      `One thing worth keeping in your back pocket: when an owner in ${peers(d)} tells you they’re thinking of selling, don’t ask what they want for it. Ask what they want to do next. That’s where the seller-finance conversation starts.`,
    ],
  }),
  lo_2: (c, d) => ({
    subject: d.industry ? `what’s happening in ${industryName(d.industry)}` : 'what we’re seeing in deals right now',
    preheader: 'A quick market note.',
    body: [
      `${c.name},`,
      `Quick note on what we see again and again: plenty of owners in ${peers(d)} are open to carrying part of the price as a note. Retiring owners want their staff looked after and a steady income, and a seller note gives them both. Many also like seller rollover: keeping a slice of the business so they share in what you build.`,
      'If you ever want to sanity-check a business you’re looking at, reply.',
    ],
  }),
  lo_3: (c, d) => ({
    subject: 'checking in',
    preheader: 'Has anything changed?',
    body: [
      `Hey ${c.name},`,
      (d.lostReason && LOST_ANGLES[d.lostReason]) || 'It’s been a little while since we spoke. Has anything changed on your side?',
      'If acquisitions are back on the table, reply and we’ll pick it up.',
    ],
  }),
  lo_4: (c, d) => ({
    subject: 'the 1.5 rule',
    preheader: 'The one number lenders care about.',
    body: [
      `${c.name},`,
      'If you only remember one thing about funding an acquisition, make it this: lenders want the target’s profit to cover its repayments about 1.5 times.',
      d.deal ? `At your size, that points to a target making ${d.deal.targetProfit} a year. Keep an eye out for one.` : 'Keep that number in mind next time you hear a business is for sale.',
    ],
  }),
  lo_5: (c, d) => ({
    subject: `${c.name}, still ${d.goal === 'exit' ? 'planning the exit' : 'thinking about growth'}?`,
    preheader: 'Six months on.',
    body: [
      `Hey ${c.name},`,
      `It’s been a few months. When we spoke, you wanted to ${d.goal && GOALS[d.goal] ? GOALS[d.goal].line : 'grow by acquisition'}. Is that still the plan?`,
      'If the timing’s better now, I’d be glad to run the numbers again.',
    ],
    cta: { label: 'Book a new call →', href: book(c) },
  }),
  lo_6: (c) => ({
    subject: 'one more thing before I go quiet',
    preheader: 'The door stays open.',
    body: [
      `${c.name},`,
      'I won’t keep filling your inbox. If you ever hear of a business you’d like to buy, or a competitor who wants out, reply to this email. I’ll tell you honestly whether the deal works.',
    ],
  }),
};

// ── Won: onboarding (done with you) ──────────────────────────────────
const WON: Record<string, T> = {
  won_1: (c, d) => ({
    subject: `welcome aboard, ${c.name}`,
    preheader: 'Here’s what happens next.',
    body: [
      `${c.name}, welcome. Really glad to have you.`,
      `Here’s what the next 90 days look like: we build your target list${d.industry ? ` in ${industryName(d.industry)}` : ''}, start owner conversations, model the deals that come up, line up the lender and get you to a signed LOI.`,
      'You run the deal and make every decision. We’re beside you the whole way. And you’re covered by the 7-day money-back guarantee.',
    ],
    ps: wa(c),
  }),
  won_2: (c) => ({
    subject: 'your first homework',
    preheader: 'Four things to gather this week.',
    body: [
      `Hey ${c.name},`,
      'To get moving, gather these this week:',
      '1. Your last two to three years of profit and loss<br>2. Your current debts and repayments<br>3. A list of every business you’d consider buying (competitors, suppliers, businesses next door to yours)<br>4. The hours each week you can protect for this',
      'Reply with any questions as you go.',
    ],
  }),
  won_3: (c, d) => ({
    subject: 'building your target list',
    preheader: d.industry ? `Starting with ${d.industry.target}.` : 'Who to put on it.',
    body: [
      `${c.name},`,
      `Your target list is the engine of the whole thing. Start with the obvious ones${d.industry ? `, like ${d.industry.target}` : ''}, then widen: businesses that sell to your customers, businesses your customers buy from, and owners in their 60s with no clear successor.`,
      'Aim for 30 names. We’ll help you narrow it down.',
    ],
  }),
  won_4: (c) => ({
    subject: 'week one check-in',
    preheader: 'How’s it going?',
    body: [`Hey ${c.name},`, 'One week in. How’s it going? Reply with where you’re at, and anything that’s stuck.', 'Getting stuck early is normal. Staying stuck is the only real problem.'],
  }),
  won_5: (c) => ({
    subject: 'getting lender-ready',
    preheader: 'What lenders will ask you for.',
    body: [
      `${c.name},`,
      'Before we take a deal to a lender, make sure you have: up-to-date financials for your business, a short personal statement of assets and debts, and a one-page summary of why you’re the right owner for the target.',
      'We’ll help you write the summary. It matters more than people think.',
    ],
  }),
  won_6: (c, d) => ({
    subject: 'the LOI is the finish line',
    preheader: 'Where you should be by now.',
    body: [
      `Hey ${c.name},`,
      `About a month in. By now you should be in conversation with a few owners. Remember why you started${d.whyNow ? `: ${quote(d.whyNow)}` : '.'}`,
      'Keep the conversations going. The LOI comes from volume and follow-up, not from finding one perfect deal.',
    ],
  }),
};

// ── Long nurture: applied, never booked ──────────────────────────────
const NURTURE: Record<string, T> = {
  nu_industry: (c, d) => ({
    subject: d.industry ? `${d.industry.many} are changing hands` : 'businesses are changing hands',
    preheader: 'A generation of owners is retiring.',
    body: [
      `Hey ${c.name},`,
      `A generation of owners in ${peers(d)} is getting ready to retire, and most of them have no one to hand over to. That’s the biggest transfer of small businesses in history, and most of it will happen quietly, off-market.`,
      `The owners who end up with ${d.industry ? d.industry.target : 'those businesses'} are the ones who were already in the conversation.`,
    ],
    cta: { label: 'Book a strategy call →', href: book(c) },
  }),
  nu_blocker: (c, d) => {
    const b = blockerOf(d) ?? BLOCKERS.funding;
    return { subject: `${c.name}, on ${b.name}`, preheader: 'You flagged this when you applied.', body: [`${c.name},`, ...b.body], cta: { label: 'Talk it through →', href: book(c) } };
  },
  nu_numbers: (c, d) => ({
    subject: 'what your first deal could look like',
    preheader: 'Rough numbers for your size.',
    body: [
      `${c.name},`,
      d.deal
        ? `At your size, a first deal could look like this: a target making ${d.deal.targetProfit} in profit, priced around ${d.deal.price}, funded by senior debt, a seller note and seller rollover. Result: ${d.deal.combined}. Illustrative only, but that’s the scale.`
        : 'A sensible first deal means buying a business roughly your size or smaller, funded by senior debt, a seller note and seller rollover, with the target’s profit covering repayments about 1.5 times.',
    ],
    cta: { label: 'Run my real numbers →', href: book(c) },
  }),
  nu_goal: (c, d) => ({
    subject: d.goal === 'exit' ? 'the fastest way to a bigger exit' : 'one deal, double the business',
    preheader: 'Why acquisition beats organic growth.',
    body: [`Hey ${c.name},`, ...GOALS[d.goal && GOALS[d.goal] ? d.goal : 'acquire'].body],
    cta: { label: 'Book a strategy call →', href: book(c) },
  }),
  nu_seller: (c) => ({
    subject: 'why sellers carry the note',
    preheader: 'It’s in their interest, not just yours.',
    body: [
      `${c.name},`,
      'People assume seller finance is a favour. It isn’t.',
      'A seller who carries part of the price gets a higher total price, interest on top, a steady income in retirement, and in some cases a better tax position than taking it all up front. With seller rollover they keep a slice of the business too, so they win when you grow it.',
      'That’s why it’s how most small businesses change hands.',
    ],
  }),
  nu_why: (c, d) => ({
    subject: 'something you wrote',
    preheader: d.whyNow ? 'When you applied.' : 'A question for you.',
    body: [
      `Hey ${c.name},`,
      d.whyNow ? `When you applied, you wrote: ${quote(d.whyNow)} Is that still true?` : 'When you applied, you were thinking about growth by acquisition. Is that still on the cards?',
      'If it is, a 30-minute call will tell you whether a deal makes sense right now.',
    ],
    cta: { label: 'Book a strategy call →', href: book(c) },
  }),
  nu_dscr: (c) => ({
    subject: 'the only number that matters',
    preheader: '1.5.',
    body: [
      `${c.name},`,
      'Every acquisition we structure starts with one number: the debt service coverage ratio. The target’s profit should cover its loan repayments about 1.5 times.',
      'Hit that and lenders lean in. Miss it and no amount of charm fixes it.',
      'Next time you hear a business is for sale, ask for its profit and do the maths.',
    ],
  }),
  nu_checkin: (c) => ({
    subject: 'still on your radar?',
    preheader: 'One-word reply is fine.',
    body: [`Hey ${c.name},`, 'Quick one: is buying a business still on your radar this year? Reply yes, no or later. One word is fine, and it helps me send you the right things.'],
  }),
  nu_last: (c) => ({
    subject: 'still here when you’re ready',
    preheader: 'No more chasing.',
    body: [`${c.name},`, 'I’ll keep this short. If you ever want to look at a deal, or find out whether your business is ready to buy one, the link below books a call with my team.'],
    cta: { label: 'Book a strategy call →', href: book(c) },
  }),
};

// ───────────── Reactivation (people already in the database), written from what they told us ─────────────

/** "back in March" / "a while back": when they first came in. */
const backWhen = (ts: number | null | undefined) => {
  if (!ts) return 'a while back';
  const months = Math.floor((Date.now() - ts) / (30 * 86_400_000));
  if (months < 1) return 'recently';
  return `back in ${new Date(ts).toLocaleString('en-AU', { month: 'long', timeZone: 'UTC' })}${months >= 11 ? ` ${new Date(ts).getUTCFullYear()}` : ''}`;
};
const callDate = (c: TemplateCtx) => (c.lead.call_at ? new Date(c.lead.call_at).toLocaleString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }) : null);

/** What they told us, as short bullet lines (empty when we know nothing). */
const toldUs = (d: Dossier) => [
  d.business ? `• <strong>The business:</strong> ${d.business}` : null,
  sizeLine(d) ? `• <strong>Size:</strong> ${sizeLine(d)}${profitText(d) ? `, with profit ${profitText(d)}` : ''}` : null,
  d.goal && GOALS[d.goal] ? `• <strong>What you wanted:</strong> to ${GOALS[d.goal].line}` : null,
  d.timeline && TIMELINES[d.timeline] ? `• <strong>Timeline:</strong> ${({ '0_6': 'within 6 months', '6_12': '6 to 12 months', '12_plus': '12 months or more', exploring: 'just exploring' } as Record<string, string>)[d.timeline]}` : null,
  blockerOf(d) ? `• <strong>What was in the way:</strong> ${blockerOf(d)!.name}` : null,
  !d.business && d.booking.length ? `• <strong>From your booking:</strong> ${quote(d.booking[0].a)}` : null,
].filter(Boolean) as string[];

/** First line of the opener, by why they're in the reactivation. */
const OPENERS: Record<string, (c: TemplateCtx) => { subject: string; line: string }> = {
  no_show: (c) => ({ subject: `${c.name}, we missed each other`, line: `We had a strategy call booked${callDate(c) ? ` for ${callDate(c)}` : ''} and it didn’t happen. No stress, it happens, and I didn’t want to just let it drop.` }),
  cancelled: (c) => ({ subject: `${c.name}, about the call you cancelled`, line: 'You cancelled your strategy call and we never found another time. I wanted to check in properly before I close your file.' }),
  applied: (c) => ({ subject: `${c.name}, you applied but we never spoke`, line: `You went through the application ${backWhen(c.lead.app_completed_at ?? c.lead.created_at)}, but we never got a call in the diary.` }),
  partial: (c) => ({ subject: `${c.name}, you started something ${backWhen(c.lead.created_at).replace(/^back /, '')}`, line: `You started an application ${backWhen(c.lead.created_at)} and didn’t get to the end. Plenty of people don’t. Life gets busy.` }),
  past_call: (c) => ({ subject: `${c.name}, since we spoke`, line: `We spoke${callDate(c) ? ` on ${callDate(c)}` : ''} about buying a business with no money down, and I never heard where you landed.` }),
  nurture: (c) => ({ subject: `${c.name}, checking back in`, line: 'Last time we spoke the timing wasn’t quite right for an acquisition. It’s been long enough that I wanted to check in.' }),
  lost: (c) => ({ subject: `${c.name}, a lot can change in a few months`, line: 'We spoke a while ago and decided it wasn’t the right time. A lot can change in a few months, so I wanted to check in.' }),
};

/** The industry's own guide (falls back to its landing page). */
const guideFor = (industryId: string) => { const g = GUIDES.find((x) => x.industry === industryId); return g ? `/guides/${g.slug}` : `/${industryId}`; };

const REACTIVATE: Record<string, T> = {
  rx_open: (c, d) => {
    const o = (OPENERS[c.lead.reactivation_segment ?? ''] ?? OPENERS.applied)(c);
    const told = toldUs(d);
    return {
      subject: o.subject,
      preheader: told.length ? 'Here’s what you told us. Still the plan?' : 'Still looking to buy a business?',
      body: [
        `Hi ${c.name},`,
        o.line,
        told.length ? `Here’s what you told us ${backWhen(c.lead.created_at)}:` : 'You were looking at growing by buying a business, with no money of your own going in.',
        ...(told.length ? [told.join('<br>')] : []),
        d.lostReason && LOST_ANGLES[d.lostReason] ? LOST_ANGLES[d.lostReason] : null,
        'Is that still the plan? Just reply yes or no. Either answer is fine, and it tells me whether to keep you posted.',
      ].filter(Boolean) as string[],
    };
  },
  rx_deal: (c, d) => ({
    subject: d.industry ? `what a first deal could look like for a ${d.industry.one}` : 'what a first deal could look like for you',
    preheader: d.deal ? `Roughly ${d.deal.price}, funded without your cash.` : 'The numbers, roughly, for a business your size.',
    body: [
      `${c.name}, I ran the rough numbers for ${yourBiz(d)}${sizeLine(d) ? `, ${sizeLine(d)}` : ''}.`,
      d.deal
        ? `A sensible first target makes around ${d.deal.targetProfit} in profit, which at a typical multiple means a price of ${d.deal.price}. Bought well, that gives you ${d.deal.combined}.`
        : 'A sensible first target is a business a little smaller than yours, with steady profit and an owner ready to step back.',
      'Here’s how a deal like that is commonly funded (illustrative): 70% commercial debt, 20% seller finance paid over a few years from the business’s own cash flow, and 10% seller rollover, where the owner keeps a stake. None of your own cash goes in, and when the cash flow supports it, the lender adds a working-capital line on top.',
      'The test we run on every deal: the target’s profit has to cover its repayments about 1.5 times. If it doesn’t, we don’t do it.',
    ],
    cta: { label: 'See if you qualify →', href: c.link('/apply?again=1') },
    ps: 'Illustrative numbers only. Every deal is structured on its own figures, and none of this is financial advice.',
  }),
  rx_why: (c, d) => ({
    subject: 'what you wrote back then',
    preheader: 'In your own words. Still true?',
    body: [
      `${c.name}, when we asked why now, you wrote:`,
      quote(d.whyNow ?? ''),
      'I keep coming back to answers like that, because they’re the real reason anyone does a deal. The spreadsheet comes second.',
      'Is it still true? If it is, the next step is a short call to see whether there’s a deal that fits. If it isn’t, reply and tell me what changed.',
    ],
    cta: { label: 'Book a call →', href: book(c) },
  }),
  rx_blocker: (c, d) => {
    const b = blockerOf(d) ?? BLOCKERS.funding;
    return { subject: `still stuck on ${b.name}?`, preheader: `You said ${b.name} was what was in the way.`, body: [`${c.name},`, ...b.body.map((x) => x.replace(/^On the call /, 'On a call ')), 'If that was the only thing stopping you, it’s worth one conversation.'], cta: { label: 'Book a call →', href: book(c) } };
  },
  rx_goal: (c, d) => {
    const g = GOALS[d.goal ?? ''] ?? GOALS.acquire;
    return { subject: ({ acquire: 'about growing by acquisition', group: 'about building a group', exit: 'about growing, then selling', unsure: 'about your next move' } as Record<string, string>)[d.goal ?? ''] ?? 'about growing by acquisition', preheader: 'What you told us you wanted.', body: [`${c.name},`, ...g.body, 'Nothing about that has changed on our side. If it’s still what you want, let’s look at it properly.'], cta: { label: 'See if you qualify →', href: c.link('/apply?again=1') } };
  },
  rx_industry: (c, d) => {
    const ind = d.industry;
    return {
      subject: ind ? `${ind.owners} buying ${ind.many}` : 'where the good businesses to buy are',
      preheader: ind ? `How it works in ${industryName(ind)}.` : 'They’re rarely listed.',
      body: [
        `${c.name}, a quick one${ind ? ` for ${ind.owners}` : ''}.`,
        ind
          ? `The best ${ind.many} to buy are rarely listed. They’re owners getting ready to retire with no one to hand over to, and ${ind.target}.`
          : 'The best businesses to buy are rarely listed. They’re owners getting ready to retire with no one to hand over to, and competitors who are quietly tired.',
        `I wrote up how it works${ind ? ' in your industry' : ''}: what you’re actually buying, what to check, and how deals like this get funded with commercial debt, seller finance and seller rollover.`,
      ],
      cta: { label: ind ? `Read the ${industryName(ind)} guide →` : 'Read the guide →', href: c.link(ind ? guideFor(ind.id) : '/guides/how-to-buy-a-business-with-no-money-down') },
      ps: 'Reply with the name of a business you’ve always wanted to own. I’m curious.',
    };
  },
  rx_timeline: (c, d) => {
    const said = ({ '0_6': 'within six months', '6_12': 'in six to twelve months', '12_plus': 'in twelve months or more', exploring: 'whenever the right one came up' } as Record<string, string>)[d.timeline ?? ''] ?? 'soon';
    return {
      subject: 'your timeline',
      preheader: `You said ${said}.`,
      body: [
        `${c.name}, ${backWhen(c.lead.created_at)} you said you wanted to move ${said}.`,
        'The right business comes up when its owner decides they’re done, not when it suits you. The people who end up owning it are the ones who were already talking to that owner.',
        'Starting now doesn’t mean buying now. It means having the list, the structure and the financing ready, so when the right one comes up, you can move in 90 days rather than a year.',
      ],
      cta: { label: 'Book a call →', href: book(c) },
    };
  },
  rx_objection: (c, d) => {
    const o = d.objection && OBJECTIONS[d.objection] ? OBJECTIONS[d.objection] : null;
    const lost = d.lostReason && LOST_ANGLES[d.lostReason] ? LOST_ANGLES[d.lostReason] : null;
    return {
      subject: o ? o.subject.replace(/^on /, 'back to ') : 'the one thing that held you back',
      preheader: 'Worth another look?',
      body: [`${c.name},`, ...(o ? o.body : []), ...(lost ? [lost] : []), 'If that’s changed, reply and tell me. I’ll be straight with you about whether it makes sense now.'],
    };
  },
  rx_last: (c, d) => ({
    subject: 'closing your file',
    preheader: 'Last email from me on this.',
    body: [
      `${c.name}, I’ve sent a few of these, so this is the last one.`,
      d.goal && GOALS[d.goal] ? `When you came to us you wanted to ${GOALS[d.goal].line}. If that’s still the plan, one call will tell you whether there’s a deal that fits ${yourBiz(d)}.` : `If buying a business is still on your mind, one call will tell you whether there’s a deal that fits ${yourBiz(d)}.`,
      'If not, no hard feelings at all. Reply “not now” and I’ll stop.',
    ],
    cta: { label: 'Book a call →', href: book(c) },
  }),
};

const ALL: Record<string, T> = { ...PREP, ...NOSHOW, ...POSTCALL, ...CANCELLED, ...LOST, ...WON, ...NURTURE, ...REACTIVATE, ...REACTIVATE_A, ...REACTIVATE_B, ...REACTIVATE_C };

export const FOLLOWUP_TEMPLATES: Record<string, (c: TemplateCtx) => EmailContent> = Object.fromEntries(
  Object.entries(ALL).map(([k, fn]) => [k, (c: TemplateCtx) => fn(c, buildDossier(c.lead))]),
);

export const FOLLOWUP_GROUPS = {
  prep: Object.keys(PREP),
  no_show: Object.keys(NOSHOW),
  post_call: Object.keys(POSTCALL),
  cancelled: Object.keys(CANCELLED),
  lost: Object.keys(LOST),
  won: Object.keys(WON),
  nurture: Object.keys(NURTURE),
  reactivate: [...Object.keys(REACTIVATE), ...Object.keys(REACTIVATE_A), ...Object.keys(REACTIVATE_B), ...Object.keys(REACTIVATE_C)],
};
