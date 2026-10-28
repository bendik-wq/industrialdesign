import type { EmailContent, TemplateCtx } from '../integrations/templates';

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

export const WEBINAR_TEMPLATES: Record<string, T> = {
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
