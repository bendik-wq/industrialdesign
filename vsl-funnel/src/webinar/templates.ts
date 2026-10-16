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
      'In the session I’ll walk you through how owners of profitable businesses are buying competitors and add-ons with no money down: where the off-market deals are, how the financing gets stacked so the deal is over-financed, and the 90-day path to a signed LOI.',
      cal(c),
    ].filter(Boolean),
    cta: { label: 'My link to the session →', href: w(c).room },
    ps: 'Bring a pen. And if you’ve got a business partner, bring them too.',
  }),
  w_24h: (c) => ({
    subject: 'tomorrow: how the deal gets funded',
    preheader: `${w(c).title}, ${w(c).when}.`,
    body: [
      `${c.name},`,
      `Quick reminder: ${w(c).title} is on ${w(c).when}.`,
      'One thing to think about before then: if you could buy one business in or next to your industry, which one would it be? Have a name in mind. By the end of the session you’ll know how a deal for it could be structured.',
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
    cta: { label: 'Join the session →', href: w(c).room },
  }),
  w_live: (c) => ({
    subject: 'we’ve started',
    preheader: 'You can still jump in.',
    body: [`${c.name}, the session has just started and your seat is still there.`, 'The first ten minutes cover where the off-market deals are. Jump in now and you won’t miss much.'],
    cta: { label: 'Join now →', href: w(c).room },
  }),
  w_thanks: (c) => ({
    subject: 'thanks for coming, here’s the next step',
    preheader: 'If it made sense, this is how we start.',
    body: [
      `${c.name}, thanks for spending the hour with me.`,
      'If what you heard made sense for your business, the next step is a short application. It takes a couple of minutes, and if your numbers fit, you’ll pick a time for a strategy call with my team where we map out your first acquisition: the target, the structure and the financing.',
      `If you want to rewatch any part, the replay is up for the next ${w(c).replayHours} hours.`,
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
      'The part of the session people re-watch most is the seller note. Here’s the short version: a retiring owner who carries part of the price gets a higher total price, interest on top and a steady income. That’s why most small businesses change hands this way.',
      'Combine it with seller rollover (they keep a slice of the business) and senior debt, test it at about 1.5x debt service coverage, and the deal can be over-financed: the financing covers more than the price.',
    ],
    cta: { label: 'Map out my first deal →', href: c.link('/apply') },
  }),
  w_last: (c) => ({
    subject: 'last note about the masterclass',
    preheader: 'Then I’ll stop.',
    body: [`Hey ${c.name},`, 'This is my last note about the masterclass. If you want help mapping out your first acquisition, the application takes a couple of minutes.', 'If now isn’t the time, no hard feelings. You can join a future session any time.'],
    cta: { label: 'Apply for a strategy call →', href: c.link('/apply') },
  }),
};
