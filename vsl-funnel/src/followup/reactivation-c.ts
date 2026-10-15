import type { EmailContent, TemplateCtx } from '../integrations/templates';
import { GUIDES } from '../seo/guides';
import { BLOCKERS, GOALS, LOST_ANGLES, OBJECTIONS, TIMELINES, blockerOf, type Dossier, industryName, peers, profitText, yourBiz } from './dossier';

/**
 * Reactivation, batch C (days 24–30 of the 30-day run): objections, decisions
 * and the close. One idea per email. Every template reads the dossier at send
 * time and must still read naturally when any field is missing. Dossier text
 * fields are already HTML-escaped.
 */
type T = (c: TemplateCtx, d: Dossier) => EmailContent;

const book = (c: TemplateCtx) => c.link(c.bookingUrl ? '/book' : '/breakout');
const quote = (s: string) => `<em>“${s}”</em>`;
const sizeLine = (d: Dossier) => (d.revenueLabel ? `a business doing ${d.revenueLabel.replace(/^Under /, 'under ')} in revenue` : null);
/** The industry's own guide, falling back to the general no-money-down guide. */
const guideFor = (d: Dossier) => {
  const g = d.industry ? GUIDES.find((x) => x.industry === d.industry!.id) : null;
  return g ? `/guides/${g.slug}` : '/guides/how-to-buy-a-business-with-no-money-down';
};
const lines = (xs: (string | null | undefined | false)[]) => xs.filter(Boolean) as string[];
const TIMELINE_SAID: Record<string, string> = { '0_6': 'within six months', '6_12': 'in six to twelve months', '12_plus': 'in twelve months or more', exploring: 'whenever the right one came up' };

/** A fresh angle on the objection they raised on the call (keys match OBJECTIONS). */
const OBJECTION_FOLLOWUP: Record<string, { subject: string; body: string[] }> = {
  Price: {
    subject: 'the number that matters more than the fee',
    body: [
      'When we spoke, the investment was what gave you pause. I respect that. You should weigh every dollar that leaves your business.',
      'The way I’d frame it now: the fee is a known number, and the deal itself is funded by commercial debt, seller finance and seller rollover, not by your savings. The open question is whether there’s a deal at your size that clears the 1.5 coverage test. If there isn’t, there’s nothing to spend money on, and I’ll tell you that.',
    ],
  },
  Timing: {
    subject: 'timing, one more time',
    body: [
      'Timing was the sticking point when we spoke. Fair enough: there are seasons in a business when nothing new fits.',
      'What I’d ask is whether the season has changed, not whether the timing is perfect. It rarely is. If you have a few focused hours a week for the next quarter, the timing is probably good enough to start the search.',
    ],
  },
  'Needs to think': {
    subject: 'where the thinking landed',
    body: [
      'You wanted time to think it over when we spoke. It’s been a while, so I’m curious where the thinking landed.',
      'If it landed on “not for me”, that’s a perfectly good answer. If it landed on “maybe, but I still have a question”, reply with the question. One straight answer is often all that’s missing.',
    ],
  },
  'Partner / spouse': {
    subject: 'did they come round?',
    body: [
      'Last time you wanted to talk it through with your partner first. Good call. Have you had that conversation?',
      'If they had questions you couldn’t answer, they’re probably the same ones I get asked all the time: what’s at risk, how much time it takes, and what happens if it goes wrong. I’d rather answer those for them directly than have you relay it second-hand.',
    ],
  },
  'Funding doubts': {
    subject: 'still doubting the funding?',
    body: [
      'You had doubts about the money side when we spoke. I’d rather you keep that scepticism than lose it.',
      'The way to settle it isn’t a promise from me. It’s running the numbers on a real target: its profit, its repayments, and how much the seller carries as a note or rolls into a stake. If the cover isn’t there, the deal isn’t either.',
    ],
  },
  'Trust / proof': {
    subject: 'still weighing us up?',
    body: [
      'You wanted more to go on before trusting us with something this big. Keep that instinct.',
      'Ask for whatever you need to see. Have your own accountant and lawyer read anything before you sign it. And judge us on how straight our answers are, especially to the awkward questions.',
    ],
  },
  'Time to commit': {
    subject: 'the hours, honestly',
    body: [
      'Time was what worried you when we spoke. I don’t want to wave that away.',
      'The honest version: a few focused hours a week, mostly owner conversations and decisions only you can make. If even that isn’t there right now, it’s better to say so than start and stall.',
    ],
  },
  'Not a fit': {
    subject: 'has anything changed?',
    body: [
      'When we spoke we agreed it wasn’t the right fit, and I appreciated you being straight about it.',
      'Businesses change, though. Profit grows, a partner wants out, a competitor goes quiet. If any of that has happened, it might be worth another look.',
    ],
  },
};

export const REACTIVATE_C: Record<string, T> = {
  // ── Day 24 ──
  rc_too_busy: (c, d) => {
    const saidTime = d.blockers.includes('time');
    return {
      subject: 'the busiest owners have the most to gain',
      preheader: 'Busy is usually the reason to do it, not the reason not to.',
      body: lines([
        `${c.name},`,
        saidTime ? 'You told us being too busy running the business was part of what held you back. I want to turn that one around.' : '“I’m too busy” is the most honest objection I hear, and I want to turn it around.',
        `If ${yourBiz(d)} only grows when you push it, being busy is the ceiling. Hiring helps a bit. Buying a business that already has a team, customers and a second-in-charge changes the shape of your week, because you’re adding people who already know how to run something.`,
        'The work itself is a few focused hours a week: deciding what to buy, taking the owner conversations, and saying yes or no to the numbers. The modelling and structuring are done with you.',
        'If your calendar is the bottleneck, that’s worth half an hour to look at.',
      ]),
      cta: { label: 'Find a time →', href: book(c) },
    };
  },
  rc_goes_bad: (c) => ({
    subject: 'what if the business you buy goes bad?',
    preheader: 'The protections are built in before you sign, not after.',
    body: [
      `${c.name}, this is the fear behind a lot of the other objections, so let’s take it head on.`,
      'Businesses do have bad years. The question is what’s built into the deal for when they do. A few things we look for every time:',
      '• <strong>Headroom.</strong> The target’s profit should cover its repayments about 1.5 times, so a soft year doesn’t sink it.<br>• <strong>The seller stays on the hook.</strong> Seller finance is paid from the business’s cash flow, and with seller rollover the owner keeps a stake, so they lose too if it goes badly. That keeps them helping through the handover.<br>• <strong>Diligence before the money moves.</strong> Customer concentration, owner dependence, messy books: the red flags show up before settlement if you know where to look.<br>• <strong>Walking away.</strong> If the numbers don’t hold, we don’t do the deal.',
      'None of that makes a deal risk-free. Nothing does. But it moves the risk to where you can see it.',
    ],
    cta: { label: 'Read: due diligence red flags →', href: c.link('/guides/due-diligence-red-flags') },
    ps: `If you’d rather talk it through on your own numbers, <a href="${book(c)}">pick a time here</a>.`,
  }),
  rc_banks_wont: (c, d) => ({
    subject: 'the bank isn’t really lending to you',
    preheader: 'It’s lending against the business you’re buying.',
    body: lines([
      `${c.name}, a lot of owners rule this out because they assume a bank won’t lend to them. Maybe they’ve been knocked back before.`,
      'Acquisition lending works differently from a personal loan. The lender looks first at the business being bought: its profit, and whether that profit covers the repayments about 1.5 times. Your own balance sheet matters less than people expect.',
      'And the bank usually isn’t funding the whole price. Commercial debt covers part, the seller carries part as a note, and the seller rolls part into a stake they keep. Each layer the seller carries is a layer the bank doesn’t have to.',
      profitText(d) ? `With your business making ${profitText(d)} in profit, the question is what size of target a lender would back next to it. That’s a calculation, not a guess.` : null,
      'Whether a particular lender will back a particular deal is never certain. But “banks won’t lend to me” is usually the wrong question.',
    ]),
    cta: { label: 'How lenders test a deal →', href: c.link('/guides/dscr-explained') },
  }),
  rc_no_debt: (c) => ({
    subject: 'if you don’t want debt',
    preheader: 'Fair. Here’s what your options actually are.',
    body: [
      `${c.name}, some owners tell me they built their business debt-free and want to keep it that way. I understand that completely.`,
      'A few things worth knowing before you rule it out:',
      '• The debt in these deals sits with the business being bought and is repaid from its profit, not from yours.<br>• The mix can lean away from the bank. More seller finance and more seller rollover means less commercial debt. Some owners sell on 100% vendor finance, with no bank at all.<br>• If the numbers only work with more debt than you’re comfortable carrying, the answer is not to do that deal.',
      'Not wanting debt is a preference, and a sensible one. It just doesn’t have to rule out buying.',
    ],
    cta: { label: 'Read: 100% vendor finance →', href: c.link('/guides/100-percent-vendor-finance') },
  }),

  // ── Day 25 ──
  rc_partner: (c, d) => ({
    subject: 'the conversation at home',
    preheader: 'When your partner or spouse isn’t sold yet.',
    body: lines([
      `${c.name},`,
      d.readiness === 'partner' ? 'You told us you’d make this decision with your partner. That’s the right way to do it.' : 'If there’s a partner or spouse who’d need to be comfortable with this, they should be part of the decision, not told about it afterwards.',
      'In my experience they usually ask three things:',
      '1. <strong>Is our house on the line?</strong> The lender’s security is usually over the business being bought. Any guarantees get spelled out before anything is signed.<br>2. <strong>Will I see less of you?</strong> A few focused hours a week while you buy, and you’re buying a team, not a second job.<br>3. <strong>What if it doesn’t work?</strong> The deal has to cover its repayments about 1.5 times, the seller stays invested through rollover, and if the numbers aren’t there, there’s no deal.',
      'Those are their questions to ask, not yours to relay. They’re welcome on the call.',
    ]),
    cta: { label: 'Book a time that suits you both →', href: book(c) },
  }),
  rc_cost: (c) => ({
    subject: 'what does it cost to work with you?',
    preheader: 'The honest answer.',
    body: [
      `${c.name}, people ask this in a reply more than anywhere else, so here’s the straight answer.`,
      'Engagements are priced on the deal: its size, its structure and how much work it takes to get it done. That’s why there isn’t a number on the website. Quoting a price before we know whether there’s a deal worth doing would be a guess.',
      'So it gets discussed on the call, once we’ve looked at your business and what a first acquisition could look like. You’ll know what it costs before you commit to anything, and you won’t be asked to decide on the spot.',
      'The deal itself is funded by commercial debt, seller finance and seller rollover. The question to weigh is whether the deal is worth doing. If it isn’t, we’ll say so, and there’s nothing to pay for.',
    ],
    cta: { label: 'Book a call →', href: book(c) },
  }),
  rc_brokers: (c, d) => ({
    subject: 'if brokers let you down',
    preheader: 'They work for the seller. That’s not a criticism.',
    body: [
      `${c.name}, some owners have already tried this: rung a few brokers, looked at the listings, and found overpriced businesses with a queue of buyers.`,
      'That isn’t bad luck. A broker’s job is to get the best price for the seller. And by the time a business is listed, the owner’s expectations are set and everyone has seen it.',
      `The deals we look for mostly aren’t listed. They’re ${d.industry ? `${d.industry.many} like ${d.industry.target}` : 'businesses whose owners are thinking about getting out and haven’t told anyone'}, approached directly, before a broker is involved. You’re on the buy side, and the structure is built around what that particular owner actually wants.`,
      'If the broker route didn’t work, it’s worth seeing what the other one looks like.',
    ],
    cta: { label: 'Read: finding off-market businesses →', href: c.link('/guides/find-off-market-businesses-for-sale') },
  }),
  rc_still_thinking: (c) => ({
    subject: `still thinking about buying a business, ${c.name}?`,
    preheader: 'One line is plenty.',
    body: [
      `${c.name},`,
      'Still thinking about buying a business? Hit reply and tell me, even if it’s one word.',
    ],
  }),

  // ── Day 26 ──
  rc_not_ready: (c, d) => ({
    subject: 'ready is a checklist, not a feeling',
    preheader: 'Four questions. Most owners are closer than they think.',
    body: lines([
      `${c.name},`,
      d.readiness === 'not_now' ? 'When you applied, you said you weren’t ready to move right now. That was honest, and it might still be true.' : '“I’m not ready” is one of the most common things owners tell me.',
      'Nobody ever feels ready to buy their first business. So rather than wait for the feeling, check the list:',
      '1. Is your business profitable, with books you could show a lender?<br>2. Could it run for a few hours a week without you?<br>3. Is there a kind of business, in your industry or next to it, you’d want to own?<br>4. Are you open to the seller staying involved through seller finance or seller rollover?',
      'If it’s mostly yes, you’re closer than you feel. If it’s mostly no, you now know what to work on, and that’s useful too.',
    ]),
    cta: { label: 'Check if you qualify →', href: c.link('/apply?again=1') },
  }),
  rc_legit: (c) => ({
    subject: 'is this legit?',
    preheader: 'You should ask. Here’s how to check.',
    body: [
      `${c.name}, “buy a business with no money of your own” sounds like something you should be suspicious of. Good. So here’s how to check us rather than take my word for it.`,
      '• <strong>The mechanics are ordinary.</strong> Commercial debt, seller finance and seller rollover are standard ways businesses change hands. Ask your accountant or your bank manager.<br>• <strong>Nothing is hidden.</strong> The guides on our site lay out the structures, the 1.5 coverage test and the red flags in full.<br>• <strong>You stay in control.</strong> We work with you, not instead of you. You make every decision and sign nothing you haven’t had your own advisers read.<br>• <strong>No pressure.</strong> Nobody will ask you to decide on a call.',
      'I’m Josh Li, from G&L M&A Advisory. If there’s something specific you’d want to know before trusting us, reply and ask it.',
    ],
    cta: { label: 'Read how it works →', href: c.link('/guides/how-to-buy-a-business-with-no-money-down') },
  }),
  rc_call_agenda: (c, d) => ({
    subject: 'what actually happens on the call',
    preheader: 'The agenda, so there are no surprises.',
    body: lines([
      `${c.name}, if part of what’s stopping you is not knowing what the call is like, here it is:`,
      `<strong>First:</strong> your business. ${d.business ? `What ${d.business} looks like today, ` : 'What it looks like today, '}where the profit comes from, and what you want it to become.<br><strong>Then:</strong> the shape of a sensible first target. Size, type, and where it would come from.<br><strong>Then:</strong> the structure. How commercial debt, seller finance and seller rollover would stack up, and whether it clears the 1.5 coverage test.<br><strong>Last:</strong> whether it’s a fit, and what working together would involve.`,
      'Then the call ends and you decide, in your own time. No pressure, no deciding on the spot.',
    ]),
    cta: { label: 'Book a call →', href: book(c) },
  }),
  rc_not_fit: (c) => ({
    subject: 'if we’re not a fit, we’ll say so',
    preheader: 'And you’ll know why.',
    body: [
      `${c.name}, one thing worth knowing before you book: we turn people down.`,
      'If the business isn’t profitable enough to support a deal, if the coverage won’t get near 1.5, if the owner can’t step away for a few hours a week, or if what you want isn’t something we can help with, we’ll tell you on the call. Plainly, and with the reason.',
      'You’ll still leave knowing more about where you stand than when you came in. But I’d rather you hear “not yet” from us than be talked into something that doesn’t fit.',
    ],
    cta: { label: 'Find out where you stand →', href: book(c) },
  }),

  // ── Day 27 ──
  rc_which_true: (c) => ({
    subject: 'which of these is true for you?',
    preheader: 'Reply with a letter. That’s all.',
    body: [
      `${c.name}, quick one. Which is closest?`,
      '<strong>A.</strong> I want to buy a business, I’m just waiting for the right one.<br><strong>B.</strong> I want to, but I’m not sure about the money side.<br><strong>C.</strong> I want to, but I can’t see where I’d find the time.<br><strong>D.</strong> Not now. Maybe next year.<br><strong>E.</strong> It’s not for me.',
      'Reply with the letter. I read every reply, and it tells me what’s actually useful to send you.',
    ],
  }),
  rc_objection: (c, d) => {
    const f = d.objection && OBJECTIONS[d.objection] ? OBJECTION_FOLLOWUP[d.objection] ?? null : null;
    return {
      subject: f ? f.subject : 'the thing that usually stops people',
      preheader: f ? 'Picking up where we left off.' : 'It’s rarely the thing they say first.',
      body: f
        ? [`${c.name},`, ...f.body, 'If you want to pick it up again, reply or grab a time. If not, that’s fine too.']
        : [
            `${c.name},`,
            'When owners don’t go ahead, the reason they give first is usually time or money. The real one is often quieter: “I don’t want to look foolish if it doesn’t work.”',
            'That’s a fair fear. The answer isn’t confidence. It’s process: test the numbers before you fall for a business, keep the seller invested through seller finance and rollover, and walk away when it doesn’t add up.',
            'If something specific is holding you back, reply and tell me what it is.',
          ],
      cta: { label: 'Book a call →', href: book(c) },
    };
  },
  rc_second_blocker: (c, d) => {
    const second = blockerOf(d, 1);
    const first = blockerOf(d, 0);
    const b = second ?? (first === BLOCKERS.valuation ? BLOCKERS.integration : BLOCKERS.valuation);
    return {
      subject: second ? `and the other thing: ${b.name}` : `the part people forget: ${b.name}`,
      preheader: second ? 'You ticked more than one box. Here’s the second.' : 'It matters more than most owners expect.',
      body: [
        second ? `${c.name}, when you applied you picked more than one thing that was in the way. We’ve covered ${first!.name}. Here’s the other one.` : `${c.name}, here’s one that doesn’t get enough attention: ${b.name}.`,
        ...(second ? b.body : b.body.slice(1)).map((x) => x.replace(/^On the call /, 'On a call ').replace(/ on the call\./, ' on a call.')),
      ],
      cta: { label: 'Talk it through →', href: book(c) },
    };
  },
  rc_size: (c, d) => ({
    subject: 'is my business big enough?',
    preheader: d.deal ? `Illustratively, a first target around ${d.deal.targetProfit} profit.` : 'The answer is in your profit, not your revenue.',
    body: lines([
      `${c.name}, a lot of owners quietly rule themselves out with this one.`,
      sizeLine(d) ? `You told us you run ${sizeLine(d)}${profitText(d) ? `, making ${profitText(d)} in profit` : ''}.` : null,
      'What decides it isn’t how big your business is. It’s whether the business you buy makes enough profit to cover its own repayments about 1.5 times. Your business matters as a platform: a team, systems and credibility with a seller.',
      d.deal ? `For a business your size, an illustrative first target makes around ${d.deal.targetProfit} in profit, at a price of roughly ${d.deal.price}, funded by commercial debt, seller finance and seller rollover. Illustrative only: the real numbers depend on the target.` : 'For most owners doing over $1M in revenue, a sensible first target is a little smaller than their own business, funded by commercial debt, seller finance and seller rollover.',
    ]),
    cta: { label: 'Check if you qualify →', href: c.link('/apply?again=1') },
  }),

  // ── Day 28 ──
  rc_since_then: (c, d) => {
    const lost = d.lostReason && LOST_ANGLES[d.lostReason] ? LOST_ANGLES[d.lostReason] : null;
    return {
      subject: 'three things that move in a few months',
      preheader: 'Your numbers, the lenders, and the owners.',
      body: lines([
        `${c.name},`,
        lost,
        'When owners decide “not yet”, they tend to picture everything staying still. Three things don’t:',
        '• <strong>Your profit.</strong> A stronger year changes the size of deal a lender will look at.<br>• <strong>Lender appetite.</strong> It shifts, sometimes for you, sometimes not.<br>• <strong>The owners.</strong> Somewhere near you, an owner has decided they’re done since you last looked. They haven’t told anyone yet.',
        'If any of those has moved for you, it’s worth a fresh look.',
      ]),
      cta: { label: 'Take a fresh look →', href: book(c) },
    };
  },
  rc_timeline: (c, d) => {
    const said = TIMELINE_SAID[d.timeline ?? ''];
    const known = !!(d.timeline && TIMELINES[d.timeline]);
    return {
      subject: 'counting back from your date',
      preheader: known && said ? `You said ${said}. Here’s what that means working backwards.` : 'Work backwards from when you’d want to own it.',
      body: lines([
        `${c.name},`,
        known && said ? `When you applied, you said you’d want to close a deal ${said}.` : 'Pick a date you’d like to own your next business by.',
        'Now count back. Settlement usually follows a signed letter of intent by a few months: diligence, the lender and the lawyers. The letter of intent comes after weeks of owner conversations. Those conversations start with a target list.',
        d.timeline === '0_6' ? 'For your window, that means the target list needed to exist already. It’s tight, but not impossible if you start now.' : d.timeline === '6_12' ? 'For your window, the target list and the first conversations belong in the next few weeks.' : 'Even with a longer horizon, the conversations are what take the time, so they start long before the deal does.',
        'The date you want is decided by when you start, not when you’d like to finish.',
      ]),
      cta: { label: 'Read: the letter of intent →', href: c.link('/guides/letter-of-intent-buying-a-business') },
    };
  },
  rc_start: (c, d) => ({
    subject: 'where you would actually start',
    preheader: d.industry ? `The first step for ${d.industry.owners}.` : 'The first step is smaller than you think.',
    body: [
      `${c.name}, “I wouldn’t know where to start” stops more owners than money does.`,
      `The first step is a page, not a deal: what you’d buy, how big, where, and why it makes ${yourBiz(d)} better. Then a list of ${peers(d)} that fit. Then the first conversation with an owner, which is mostly listening.`,
      'Everything after that, from the numbers to the structure with commercial debt, seller finance and seller rollover, comes once you know who you’re talking to.',
      d.industry ? `I wrote up how it works for ${industryName(d.industry)}, including what to check and what to ask.` : 'I wrote up the whole path, start to finish.',
    ],
    cta: { label: 'Read the guide →', href: c.link(guideFor(d)) },
  }),
  rc_seller_yes: (c) => ({
    subject: 'why would a seller agree to that?',
    preheader: 'Because cash on day one isn’t all they want.',
    body: [
      `${c.name}, the doubt behind a lot of the doubts: why would an owner accept being paid over time, or keep a stake, instead of cash?`,
      'Because many of them want more than a cheque. They want their staff looked after, their customers kept, their name on the door to mean something, and an income after they step back. A seller note gives them that income. A rollover stake gives them a share of what you build.',
      'Not every seller will say yes, and the ones who need all their cash on day one aren’t the right targets. But the ones who care how it ends often prefer a buyer who knows the industry over a bigger cheque from a stranger.',
    ],
    cta: { label: 'Read: questions to ask a seller →', href: c.link('/guides/questions-to-ask-a-business-seller') },
  }),

  rc_not_yet: (c) => ({
    subject: 'a no, or a not yet?',
    preheader: 'Either is fine. I’d just like to know which.',
    body: [
      `${c.name}, is buying a business a no, or a not yet?`,
      'Reply with whichever it is. Either answer is useful.',
    ],
  }),

  // ── Day 29 ──
  rc_two_businesses: (c, d) => ({
    subject: 'two businesses, one of you',
    preheader: 'You’re not meant to run both yourself.',
    body: lines([
      `${c.name}, a version of the time objection: “I can barely run one business. How would I run two?”`,
      'You wouldn’t, not the way you run yours now. The point of buying is that the target comes with people already running it: a manager, a team, customers who know them. Your job is ownership, not doing every job twice.',
      `The handover is built into the deal. With seller finance and seller rollover the previous owner stays invested, so they have every reason to help the transition go well. And the integration plan, what merges with ${yourBiz(d)} and what stays separate for the first year, is written before anything is signed.`,
      'If you can’t picture stepping back from the day-to-day, that’s worth knowing before a deal, not after. It’s one of the things we’d look at together.',
    ]),
    cta: { label: 'Talk it through →', href: book(c) },
  }),
  rc_industry_doubt: (c, d) => ({
    subject: d.industry ? `does this work for ${d.industry.many}?` : 'does this work in my industry?',
    preheader: 'The test is the same everywhere. The targets aren’t.',
    body: lines([
      `${c.name}, “that might work in other industries, but not in mine” comes up a lot.`,
      'The funding test is the same in every industry: the target’s profit should cover its repayments about 1.5 times, with the price funded by commercial debt, seller finance and seller rollover. What changes is what you’re buying and what to check.',
      d.industry ? `In ${industryName(d.industry)}, that means ${d.industry.many} like ${d.industry.target}, and the specific risks in that kind of business. I wrote up how it works for ${d.industry.owners}.` : 'Some industries have more retiring owners, some have lumpier revenue, some depend more on one key person. I wrote up how it works start to finish, so you can judge for yourself.',
      'And if your industry genuinely doesn’t suit it, we’ll tell you that on a call.',
    ]),
    cta: { label: 'Read the guide →', href: c.link(guideFor(d)) },
  }),
  rc_two_paths: (c, d) => ({
    subject: 'two paths from here',
    preheader: 'Both are fine. Only one is a decision.',
    body: lines([
      `${c.name}, after a month of these emails, there are two ways this goes.`,
      `<strong>Path one:</strong> you keep growing ${yourBiz(d)} the way you have been. That’s a real option. Plenty of owners do well that way, and nothing about it is wrong.`,
      `<strong>Path two:</strong> you spend half an hour finding out whether there’s a deal that ${d.goal && GOALS[d.goal] ? `would help you ${GOALS[d.goal].line}` : 'fits your business'}, funded with commercial debt, seller finance and seller rollover, and you decide with real numbers in front of you.`,
      'The only path I’d steer you away from is the third one: leaving it as “maybe” for another year without ever looking.',
    ]),
    cta: { label: 'Take path two →', href: book(c) },
  }),
  rc_recap: (c, d) => ({
    subject: 'the whole month in one email',
    preheader: 'Everything that matters, in case you skimmed.',
    body: lines([
      `${c.name}, if you skimmed the last few weeks of emails (fair), here’s what matters:`,
      '1. You can buy a business with none of your own money going in, using commercial debt, seller finance and seller rollover.<br>2. The test is simple: the target’s profit should cover its repayments about 1.5 times. If it doesn’t, no deal.<br>3. The best businesses to buy usually aren’t listed. You reach the owners directly.<br>4. It takes a few focused hours a week, and the business you buy comes with its own team.<br>5. You can go from target list to signed letter of intent in about 90 days.',
      d.business || sizeLine(d) ? `And all of it applies to ${d.business ?? yourBiz(d)}${sizeLine(d) ? `, ${sizeLine(d)}` : ''}.` : null,
      'If you want to see the whole model in one place, the main video covers it.',
    ]),
    cta: { label: 'Watch the video →', href: c.link('/') },
    ps: `Prefer to see it on your own numbers? <a href="${book(c)}">Book a call</a>.`,
  }),
  rc_whynow: (c, d) => ({
    subject: 'decide on the reason, not the mood',
    preheader: d.whyNow ? 'You wrote it down once.' : 'Moods change. Reasons don’t.',
    body: lines([
      `${c.name},`,
      'Big decisions get made on a good day and put off on a bad one. That’s human. But the reason to do this doesn’t change with your mood.',
      d.whyNow ? `When we asked why now, you wrote: ${quote(d.whyNow)}` : 'When owners tell us why they want to buy, it’s rarely the spreadsheet. It’s getting off the tools, building something worth selling, or finally having a team that doesn’t need them every day.',
      d.whyNow ? 'If that’s still true, it’s still a reason, whatever kind of week you’re having.' : 'Whatever yours is, if it’s still true, it’s still a reason, whatever kind of week you’re having.',
    ]),
    cta: { label: 'Book a call →', href: book(c) },
  }),
  rc_awkward: (c) => ({
    subject: 'ask me the awkward question',
    preheader: 'The one you wouldn’t ask on a call.',
    body: [
      `${c.name}, there’s usually one question people don’t want to ask on a call. “What’s the catch?” “What if I’m not good enough at this?” “What happens if the seller lies to me?”`,
      'Hit reply and ask it. I’ll answer it straight, in writing, with no call needed.',
    ],
  }),

  // ── Day 30 / close-out ──
  rc_wrapping_up: (c) => ({
    subject: 'these emails are wrapping up',
    preheader: 'A heads-up, not a countdown.',
    body: [
      `${c.name}, a quick heads-up: this run of emails is about to end.`,
      'It isn’t a deadline. Nothing closes, nothing expires, and the call is there whenever you want it. I just don’t want to keep filling your inbox if buying a business isn’t on your mind right now.',
      'If it is, now’s a natural moment to look at it properly.',
    ],
    cta: { label: 'Book a call →', href: book(c) },
  }),
  rc_one_question: (c, d) => ({
    subject: 'what would need to be true?',
    preheader: 'One question before I go quiet.',
    body: lines([
      `${c.name}, before these emails stop, one question.`,
      `What would need to be true for you to buy a business${d.industry ? ` alongside ${yourBiz(d)}` : ''}?`,
      'Maybe it’s the right business coming up. Maybe it’s knowing the money would work. Maybe it’s a quieter year, or your partner being on board.',
      'Whatever your answer is, reply with it. It’s the most useful thing you could tell me, and I’ll tell you honestly whether it’s something we can help with.',
    ]),
  }),
  rc_final: (c, d) => ({
    subject: `thanks for reading, ${c.name}`,
    preheader: 'The last one in this run.',
    body: lines([
      `${c.name}, this is the last email in this run, so thank you for reading as many as you did.`,
      d.goal && GOALS[d.goal] ? `When you first came to us, you wanted to ${GOALS[d.goal].line}. I hope you do, whether it’s with us or not.` : 'Whether buying a business is in your future or not, I hope the ideas were useful.',
      'If it ever comes back onto your radar, everything is still here: the video, the guides, and a call whenever you want one. You can reply to this email too, it comes straight to me.',
      'Thanks again, and all the best with the business.',
      'Josh',
    ]),
    cta: { label: 'Book a call, whenever you’re ready →', href: book(c) },
    ps: 'If you’d rather not hear from us at all, the unsubscribe link at the bottom takes care of it.',
  }),
};

/** Recommended send order across days 24–30 (four or five a day); the last is the warm close-out. */
export const REACTIVATE_C_ORDER: string[] = [
  // Day 24
  'rc_too_busy', 'rc_goes_bad', 'rc_banks_wont', 'rc_no_debt',
  // Day 25
  'rc_partner', 'rc_cost', 'rc_brokers', 'rc_still_thinking',
  // Day 26
  'rc_not_ready', 'rc_legit', 'rc_call_agenda', 'rc_not_fit',
  // Day 27
  'rc_which_true', 'rc_objection', 'rc_second_blocker', 'rc_size',
  // Day 28
  'rc_since_then', 'rc_timeline', 'rc_start', 'rc_seller_yes', 'rc_not_yet',
  // Day 29
  'rc_two_businesses', 'rc_industry_doubt', 'rc_two_paths', 'rc_recap', 'rc_whynow',
  // Day 30: the awkward question, then the three-email close-out arc
  'rc_awkward', 'rc_wrapping_up', 'rc_one_question', 'rc_final',
];
