import type { EmailContent, SprintEmailCtx, TemplateCtx } from '../integrations/templates';

/**
 * Webinar emails. Every link to the room / replay is the person's own (their token), and the
 * session time is shown in their time zone. Attendance decides which follow-up they get.
 */
type T = (c: TemplateCtx) => EmailContent;

const w = (c: TemplateCtx) => c.webinar ?? { title: 'the masterclass', when: 'the session time you picked', room: c.link('/'), replay: c.link('/'), ics: null, google: null, replayHours: 48, durationMin: 60 };
const cal = (c: TemplateCtx) => {
  const x = w(c);
  return x.google || x.ics ? `Add it to your calendar: ${x.google ? `<a href="${x.google}">Google</a>` : ''}${x.google && x.ics ? ' · ' : ''}${x.ics ? `<a href="${x.ics}">Apple / Outlook</a>` : ''}` : '';
};

/** Paid-ticket mode: the straight-to-checkout link and the ticket price. */
const tk = (c: TemplateCtx) => {
  const x = w(c) as ReturnType<typeof w> & { ticket?: string; ticketPrice?: string | null };
  return { href: x.ticket ?? x.room, price: x.ticketPrice || 'the ticket' };
};
const ticketGuarantee = (c: TemplateCtx) => `The ticket guarantee: watch it, and if you don’t think it was worth far more than ${tk(c).price}, reply within 7 days for a full refund.`;
/** The First Deal Sprint closing emails (fallbacks keep a dashboard preview readable). */
const sp = (c: TemplateCtx): SprintEmailCtx => {
  const x = w(c) as ReturnType<typeof w> & { sprint?: SprintEmailCtx | null };
  return x.sprint ?? {
    name: 'First Deal Sprint', offer: x.room, closes: 'when your replay closes', bonusEnds: null, bonusTitle: null, bonusBody: null,
    price: '$3,000', priceLine: '$3,000 today', plan: null, guarantee: 'Do the Sprint. If at the end of your Deal Plan session you don’t think it was worth far more than you paid, tell us that day and we refund the full fee.', apply: (x as { apply?: string }).apply ?? c.link('/apply'),
  };
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const bonusLine = (s: SprintEmailCtx) => (s.bonusTitle && s.bonusEnds ? `Fast-action bonus until ${s.bonusEnds}: ${s.bonusTitle}.${s.bonusBody ? ` ${cap(s.bonusBody.replace(/\.$/, ''))}.` : ''}` : '');
const priceWithPlan = (s: SprintEmailCtx) => `${s.priceLine}${s.plan ? `, or ${s.plan}` : ''}.`;

export const WEBINAR_TEMPLATES: Record<string, T> = {
  // "Finish your ticket": registered while the ticket is paid, not paid yet (SEQUENCES.ticket). Stops once it is paid.
  w_ticket_1: (c) => ({
    subject: 'one step left on your masterclass ticket',
    preheader: 'Your personal link goes out once the ticket is paid.',
    body: [
      `Hey ${c.name},`,
      `You registered for <strong>${w(c).title}</strong> (${w(c).when}). Your ${tk(c).price} ticket isn’t paid yet, so your seat in the room isn’t confirmed.`,
      'The room is kept for owners who are serious about buying a business. Pay the ticket and your personal link and reminders come straight through.',
      'In the hour you’ll see how a competitor gets bought with the bank’s money and the seller’s instead of yours: commercial debt, seller finance and seller rollover, tested at about 1.5x debt service coverage.',
      `Your ${tk(c).price} comes off the First Deal Sprint if you start it after the masterclass.`,
    ],
    cta: { label: 'Finish my ticket →', href: tk(c).href },
    ps: ticketGuarantee(c),
  }),
  w_ticket_2: (c) => ({
    subject: 'whose money buys your next business',
    preheader: 'Your cash, or the bank’s and the seller’s.',
    body: [
      `${c.name},`,
      'The default plan for buying a competitor is to save up the price and pay it from your own cash. That cash then sits in someone else’s business instead of working in yours.',
      'The masterclass shows the structure the bank and the seller fund. Commercial debt is lent against the target’s cash flow, the seller carries part of the price as a note, and seller rollover keeps the seller in the deal with a stake.',
      `Your ${tk(c).price} ticket is still open. The link takes you straight to secure checkout.`,
    ],
    cta: { label: 'Get my ticket →', href: tk(c).href },
    ps: ticketGuarantee(c),
  }),
  w_ticket_3: (c) => ({
    subject: 'last note about your ticket',
    preheader: 'Then I’ll leave it with you.',
    body: [
      `Hey ${c.name},`,
      `This is my last note about your masterclass ticket. If you want to see how a deal for a business in your industry gets funded, it is ${tk(c).price}, and it comes off the First Deal Sprint if you start it afterwards.`,
      'If your session time has passed, the link takes you to the next showings and you pick one.',
      ticketGuarantee(c),
    ],
    cta: { label: 'Get my ticket →', href: tk(c).href },
  }),
  w_confirm: (c) => ({
    subject: `you’re in: ${w(c).title}`,
    preheader: `${w(c).when}. Your personal link is inside.`,
    body: [
      `Hey ${c.name},`,
      `You’re registered for <strong>${w(c).title}</strong>.`,
      `<strong>When:</strong> ${w(c).when}<br><strong>How long:</strong> about ${w(c).durationMin} minutes<br><strong>Where:</strong> your personal link below (it works on your phone or computer, nothing to install).`,
      'In the masterclass I walk you through how owners of profitable businesses buy a competitor or an add-on while their own cash stays working in the business.',
      'You’ll see where the off-market deals are and how the funding is built from commercial debt, seller finance and seller rollover so the deal is over-financed. Then the 90-day path to a signed LOI.',
      cal(c),
    ].filter(Boolean),
    cta: { label: 'My link to the masterclass →', href: w(c).room },
    ps: 'Bring a pen. And if you’ve got a business partner, bring them too.',
  }),
  w_24h: (c) => ({
    subject: 'tomorrow: how the deal gets funded',
    preheader: `${w(c).title}, ${w(c).when}.`,
    body: [
      `${c.name},`,
      `Quick reminder: ${w(c).title} is on ${w(c).when}.`,
      'Before then, pick one business in or next to your industry that you would buy tomorrow if the money were sorted. Have a name in mind.',
      'By the end of the hour you’ll know how a deal for it gets structured with commercial debt, seller finance and seller rollover.',
    ],
    cta: { label: 'Save my link →', href: w(c).room },
  }),
  w_3h: (c) => ({
    subject: `${c.name}, a few hours to go`,
    preheader: 'Your link is below.',
    body: [`Hey ${c.name},`, `We start at ${w(c).when}. Here’s your link so you don’t have to look for it later.`, 'Find somewhere you can watch without interruptions for an hour. It’s worth it.'],
    cta: { label: 'Open my link →', href: w(c).room },
  }),
  w_15m: (c) => ({
    subject: 'starting in 15 minutes',
    preheader: 'Grab a coffee and join.',
    body: [`${c.name}, we start in 15 minutes.`, 'Click below a few minutes early to make sure your sound works.'],
    cta: { label: 'Join the masterclass →', href: w(c).room },
  }),
  w_live: (c) => ({
    subject: 'your showing has started',
    preheader: 'You can still jump in.',
    body: [`${c.name}, your showing of the masterclass has just started.`, 'The first ten minutes cover where the off-market deals are. Jump in now and you won’t miss much.'],
    cta: { label: 'Join now →', href: w(c).room },
  }),
  w_thanks: (c) => ({
    subject: 'thanks for coming, here’s the next step',
    preheader: 'If it made sense, this is how we start.',
    body: [
      `${c.name}, thanks for spending the hour with me.`,
      'If what you heard made sense for your business, the next step is a short application. It takes a couple of minutes.',
      'When your numbers fit, you pick a time for a strategy call with my team and we map out your first acquisition: the target, the structure, and the split between commercial debt, seller finance and seller rollover.',
      `The replay stays up for the next ${w(c).replayHours} hours if you want to rewatch any part.`,
    ],
    cta: { label: 'See if my business qualifies →', href: c.link('/apply') },
    ps: `Replay: <a href="${w(c).replay}">watch it again here</a>.`,
  }),
  w_missed: (c) => ({
    subject: 'you missed it, so here’s the replay',
    preheader: `Up for ${w(c).replayHours} hours.`,
    body: [
      `Hey ${c.name},`,
      'Looks like you couldn’t make it. No problem, life happens.',
      `I’ve put the replay up for you. It’ll be there for the next ${w(c).replayHours} hours, then it comes down.`,
    ],
    cta: { label: 'Watch the replay →', href: w(c).replay },
  }),
  w_replay_last: (c) => ({
    subject: 'the replay comes down soon',
    preheader: 'Last chance to watch it.',
    body: [`${c.name},`, 'The replay is coming down in a few hours. If buying a business is on your mind this year, it’s the best hour you’ll spend this week.'],
    cta: { label: 'Watch it now →', href: w(c).replay },
  }),
  w_offer: (c) => ({
    subject: 'the question I get after every session',
    preheader: '“Would this work for my business?”',
    body: [
      `Hey ${c.name},`,
      'After every session, the most common question is: “Would this work for my business?”',
      'The honest answer depends on your numbers: your profit, your industry, and what’s for sale near you. That’s exactly what the application and the strategy call are for.',
      'If it fits, we map out your first deal. If it doesn’t, we tell you straight.',
    ],
    cta: { label: 'Find out if it fits →', href: c.link('/apply') },
  }),
  w_story: (c) => ({
    subject: 'why the seller funds the deal',
    preheader: 'It’s in their interest, not just yours.',
    body: [
      `${c.name},`,
      'The part of the masterclass people rewatch most is the seller note.',
      'A retiring owner who carries part of the price gets a higher total price, interest on top and a steady income after settlement. That’s why a seller agrees to it.',
      'Put that note next to commercial debt and seller rollover (the seller keeps a slice of the business), test the whole stack at about 1.5x debt service coverage, and the funding can cover more than the price: working capital and closing costs included.',
      'That’s how I bought my own clinics, in two acquisitions, with 100% seller finance.',
    ],
    cta: { label: 'Map out my first deal →', href: c.link('/apply') },
  }),
  w_last: (c) => ({
    subject: 'last note about the masterclass',
    preheader: 'Then I’ll stop.',
    body: [`Hey ${c.name},`, 'This is my last note about the masterclass. If you want help mapping out your first acquisition, the application takes a couple of minutes.', 'If now isn’t the time, no hard feelings. You can join a future session any time.'],
    cta: { label: 'Apply for a strategy call →', href: c.link('/apply') },
  }),
  w_left_early: (c) => ({
    subject: 'you left before the funding part',
    preheader: 'The second half is where the deal gets paid for.',
    body: [
      `Hey ${c.name},`,
      'You dropped off before the second half of the masterclass, and that half is the one that answers where the money comes from.',
      'I break down how a deal is funded with commercial debt, seller finance and seller rollover, so your own cash stays in your business.',
      'Then the 1.5x test: the profit of the business you buy has to cover its yearly debt payments about one and a half times. A deal that passes gets funded on the business’s cash flow, and one that fails gets restructured or dropped.',
      'The last part covers what the next step looks like if you want my team to map out your first deal.',
      `Your replay is up for ${w(c).replayHours} hours from the session.`,
    ],
    cta: { label: 'Watch the second half →', href: w(c).replay },
    ps: 'If you saw the start, skip ahead to the funding section. It begins around the halfway mark.',
  }),
  w_clicked: (c) => ({
    subject: 'your application is half done',
    preheader: 'Pick up where you left off.',
    body: [
      `${c.name},`,
      'You clicked through to apply during the masterclass and didn’t get to the end of the form.',
      'Everything you filled in is saved. The rest takes about two minutes, and then my team looks at your numbers before your strategy call.',
    ],
    cta: { label: 'Finish my application →', href: (c as TemplateCtx & { applyUrl?: string }).applyUrl ?? w(c).replay },
    ps: 'If something in the form stopped you, reply to this email and tell me what it was.',
  }),
  w_next_showing: (c) => ({
    subject: 'the next showing starts shortly',
    preheader: 'You can watch it in the next few minutes.',
    body: [
      `Hey ${c.name},`,
      'You missed your session time, and that is easy to fix.',
      'The masterclass runs every 15 minutes for most of the day, so the next showing is only minutes away. Your link drops you straight into it.',
    ],
    cta: { label: 'Watch the next showing →', href: (w(c) as { next?: string }).next ?? w(c).replay },
    ps: 'Give it the full hour. The second half explains the funding stack: commercial debt, seller finance and seller rollover.',
  }),
  w_bonus: (c) => ({
    subject: 'your deal structure worksheet',
    preheader: 'For the owners who stayed to the end.',
    body: [
      `${c.name},`,
      'You stayed to the end of the masterclass, so here is the attendee worksheet I promised.',
      'Fill it in for one business you would like to own: the target, its profit and asking price, the 1.5x test, and a first draft of the stack across commercial debt, seller finance and seller rollover.',
      `Then apply for a strategy call and bring the worksheet with you. My team works from it to map out your first acquisition.`,
    ],
    cta: { label: 'Get my worksheet →', href: (w(c) as { worksheet?: string }).worksheet ?? w(c).replay },
    ps: `When the worksheet is done, the application is here: <a href="${c.link('/apply')}">apply for a strategy call</a>.`,
  }),
  // Sent after the showing, only to people who saved at least one key point (see SEQUENCES.webinar).
  w_notes: (c) => {
    const x = w(c) as ReturnType<typeof w> & { notes?: string[]; notesUrl?: string; buyin?: string | null };
    const notes = x.notes ?? [];
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return {
      subject: 'your notes from the masterclass',
      preheader: 'The key points you saved, in one place.',
      body: [
        `${c.name},`,
        notes.length ? `Here are the ${notes.length === 1 ? 'key point' : `${notes.length} key points`} you saved during the masterclass, in the order they came up.` : 'Here are the key points you saved during the masterclass.',
        ...(notes.length ? [notes.map((n, i) => `${i + 1}. ${esc(n)}`).join('<br>')] : []),
        ...(x.buyin ? [`You also wrote down what a first acquisition would change for you: “${esc(x.buyin)}”.`] : []),
        'Every number in them is illustrative. The next step is a short application, and when your numbers fit, my team maps your first deal with you across commercial debt, seller finance and seller rollover.',
      ],
      cta: { label: 'Open my notes →', href: x.notesUrl ?? x.replay },
      ps: `Ready to map your first deal? <a href="${(x as { apply?: string }).apply ?? c.link('/apply')}">Apply for a strategy call</a>.`,
    };
  },
  // ── The First Deal Sprint closing emails (unlocked it in the room, didn't buy; one objection each) ──
  w_sprint_open: (c) => {
    const s = sp(c);
    const buyin = (w(c) as { buyin?: string | null }).buyin;
    const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return {
      subject: `your numbers, and the ${s.name}`,
      preheader: 'The plan for your first deal, written with you in seven days.',
      body: [
        `${c.name},`,
        `The ${s.name} opened for you in the masterclass.`,
        ...(buyin ? [`You wrote down what a first acquisition would change for you: “${esc(buyin)}”. The Sprint is the first seven days of getting there.`] : []),
        'The objection I hear most at this point is “I’m not ready to buy yet.” The Sprint is how you get ready.',
        'In seven days you know what your profit carries at 1.5x, which business to buy first, and how a deal for it splits across commercial debt, seller finance and seller rollover. Whether you then make an offer, and when, stays your call.',
        `${priceWithPlan(s)} ${s.guarantee}`,
        `It is open until ${s.closes}, when your replay closes.`,
      ],
      cta: { label: `See the ${s.name} →`, href: s.offer },
      ps: bonusLine(s) || undefined,
    };
  },
  w_sprint_bonus: (c) => {
    const s = sp(c);
    return {
      subject: 'your fast-action bonus ends in a few hours',
      preheader: s.bonusTitle ? `${s.bonusTitle}, until ${s.bonusEnds ?? 'later today'}.` : `It comes with the ${s.name}.`,
      body: [
        `${c.name},`,
        `${bonusLine(s) || `The fast-action bonus on the ${s.name} ends in a few hours.`}`,
        'If what holds you back is time, here is what the week asks of you: the kickoff call and your numbers on Day 1, short replies to my team during the week, and the 60-minute Deal Plan session on Day 7.',
        'My team does the research and the writing.',
        `${priceWithPlan(s)} Everything you pay for it comes off the advisory engagement if you continue.`,
      ],
      cta: { label: `Start my ${s.name} →`, href: s.offer },
      ps: `The ${s.name} itself stays open until ${s.closes}.`,
    };
  },
  w_sprint_closing: (c) => {
    const s = sp(c);
    return {
      subject: `the ${s.name} closes in a few hours`,
      preheader: `Open until ${s.closes}, then it closes with your replay.`,
      body: [
        `${c.name},`,
        `The ${s.name} from your masterclass closes at ${s.closes}, when your replay comes down.`,
        `Owners ask me whether the ${s.price} is wasted if they don’t go on with us. You keep everything: the capacity numbers, the buy box, the shortlist, the memo and the outreach script.`,
        'If you do continue, the full fee comes off the advisory engagement.',
        `And the guarantee stands: ${s.guarantee.charAt(0).toLowerCase()}${s.guarantee.slice(1)}`,
      ],
      cta: { label: `Start my ${s.name} →`, href: s.offer },
      ps: priceWithPlan(s),
    };
  },
  w_sprint_closed: (c) => {
    const s = sp(c);
    return {
      subject: `the ${s.name} has closed`,
      preheader: 'If something held you back, reply and tell me what it was.',
      body: [
        `${c.name},`,
        `The ${s.name} offer from your masterclass has closed.`,
        'If what held you back was “what if there’s no business for me to buy”, reply to this email and tell me. My team reads every reply.',
        'Send your revenue, your industry and the kind of business you would buy first. We tell you straight whether a first deal fits, and how it splits across commercial debt, seller finance and seller rollover.',
      ],
    };
  },
  w_blueprint: (c) => ({
    subject: 'your acquisition blueprint',
    preheader: 'One page, built from your answers in the masterclass.',
    body: [
      `${c.name},`,
      'Your Acquisition Blueprint is ready. It is built from what you told us: the size of your business, the business you would most like to own and what stands in the way today.',
      'It shows the first deal that fits, the stack on your numbers across commercial debt, seller finance and seller rollover, and the 1.5x test already run on it.',
      'Then the gap between selling one business and selling a group, and your first 90 days. Every number in it is illustrative, and the strategy call is where my team checks it against your real numbers.',
    ],
    cta: { label: 'Open my blueprint →', href: (w(c) as { blueprint?: string }).blueprint ?? w(c).replay },
    ps: `When you have read it, the application is here: <a href="${(w(c) as { apply?: string }).apply ?? c.link('/apply')}">apply for a strategy call</a>.`,
  }),
};
