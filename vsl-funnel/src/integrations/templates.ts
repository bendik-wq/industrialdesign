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
  // ── Abandoned application ──────────────────────────────────────────
  abandon_1: (c) => ({
    subject: `${c.name}, your application is half done`,
    preheader: 'It saved where you left off.',
    body: [
      `Hey ${c.name},`,
      'Looks like you started your application but didn’t get to the end. No stress — it saved where you left off.',
      'It takes about 90 seconds to finish, and it’s the only way to get a strategy call with my team, where we map out what your first (or next) acquisition could look like.',
    ],
    cta: { label: 'Finish my application →', href: c.link('/apply') },
    ps: 'If something on the form didn’t make sense, just reply to this email and tell me.',
  }),
  abandon_2: (c) => ({
    subject: 'Quick question',
    preheader: 'Was it the money question?',
    body: [
      `${c.name}, quick one.`,
      'When people stop halfway through the application, it’s usually one of three things:',
      '• They don’t think it’ll work for them.<br>• They think they need a big deposit first.<br>• They think their situation is different.',
      'All three are exactly why the 3C model exists. Most of the deals we structure are funded by the seller and the bank — not your savings. And the people it works best for usually thought it wouldn’t work for them.',
      'Your answers are still saved.',
    ],
    cta: { label: 'Pick up where I left off →', href: c.link('/apply') },
    ps: waLine(c, 'Rather just ask me? Message me on WhatsApp'),
  }),
  abandon_3: (c) => ({
    subject: 'Closing your application',
    preheader: 'Last note from me on this.',
    body: [
      `Hey ${c.name},`,
      'I’m going to close out your unfinished application at the end of this week so we can give the call slots to people who are ready.',
      'If owning a cash-flowing business is still something you want this year, finish it now. If not, no hard feelings — you’ll still get the occasional email from me with deals and structures we’re seeing.',
    ],
    cta: { label: 'Finish my application →', href: c.link('/apply') },
  }),

  // ── A tier: book the call ───────────────────────────────────────────
  a_approved: (c) => ({
    subject: `${c.name}, you’re approved for a strategy call`,
    preheader: 'Pick a time that suits you.',
    body: [
      `${c.name} — congrats, your application stood out.`,
      'Based on your answers, you’re exactly the kind of person the 3C Acquisition Model was built for. The next step is a strategy call where we’ll look at your situation and map out what your first acquisition could look like — the size of deal, the structure, and the timeline.',
      'Calls are limited each week because they’re run by people who actually do deals, so grab a time now.',
    ],
    cta: { label: 'Book my strategy call →', href: c.link('/book') },
    ps: 'Before the call, watch part 2 — it walks through a real deal structure line by line: ' + `<a href="${c.link('/breakout')}">watch it here</a>.`,
  }),
  a_reminder: (c) => ({
    subject: 'Your call slot is still open',
    preheader: 'Haven’t seen your booking come through yet.',
    body: [
      `Hey ${c.name},`,
      'I noticed you were approved for a strategy call but haven’t picked a time yet.',
      'Here’s the honest truth: the question isn’t whether you can buy a business without your own savings — members do it every month. The real question is how fast you get there. This call is where we figure that out.',
    ],
    cta: { label: 'Choose my time →', href: c.link('/book') },
  }),
  a_last_call: (c) => ({
    subject: 'Should I give your spot away?',
    preheader: 'Your approval is held for a little longer.',
    body: [
      `${c.name},`,
      'Your approval for a strategy call is held for a few more days, then the slot goes to the next person on the list.',
      'If you’re serious about owning a business that pays you — instead of a job that pays you — book it now.',
    ],
    cta: { label: 'Book my call →', href: c.link('/book') },
    ps: waLine(c, 'Want to ask something first? Message me on WhatsApp'),
  }),
  a_final: (c) => ({
    subject: 'The cost of waiting',
    preheader: 'One more year of the same?',
    body: [
      `${c.name}, last one on this.`,
      'Let’s talk about what it costs you NOT to do this. Another year of trading time for money. Another year of building someone else’s asset. Another year of good businesses being sold to buyers who were simply faster.',
      'The call is free. The only thing it costs you is 45 minutes — and maybe the story you’ve been telling yourself about why now isn’t the time.',
    ],
    cta: { label: 'Book my strategy call →', href: c.link('/book') },
  }),

  // ── B tier: breakout VSL → FAQs → book ─────────────────────────────
  b_part2: (c) => ({
    subject: 'Part 2: where the money actually comes from',
    preheader: 'A real deal structure, line by line.',
    body: [
      `Hey ${c.name}, thanks for applying.`,
      'Before we go any further, watch part 2. It’s the breakout session where I walk through a real deal structure line by line — what the seller carries, what the bank funds, and why it doesn’t need to be your savings.',
      'It’s the single most important thing to understand before you look at a single business for sale.',
    ],
    cta: { label: 'Watch part 2 →', href: c.link('/breakout') },
    ps: waLine(c, 'Add me on WhatsApp'),
  }),
  b_two_paths: (c) => ({
    subject: 'Two paths',
    preheader: 'The easy way and the hard way.',
    body: [
      `${c.name},`,
      'There are two paths to owning a business. The hard path is doing it alone: saving a deposit for years, bidding on the same listed businesses as everyone else, and finding out at the bank that your structure was never fundable.',
      'The easy path is having someone show you who has already made those mistakes — so you don’t have to.',
      'That’s what the 3C model is: Capabilities (a board and team that make you credible), Capital (structures sellers and lenders say yes to) and Closing (getting it over the line).',
    ],
    cta: { label: 'See how it works →', href: c.link('/breakout') },
  }),
  b_objections: (c) => ({
    subject: 'I suspect this is why',
    preheader: 'Most people think their situation is different.',
    body: [
      `Hey ${c.name},`,
      'I suspect the reason you haven’t booked a call yet is one of these: you don’t think it’ll work for you, you don’t think you can do it, or you think your situation is different.',
      'That’s okay. Almost every member we’ve worked with thought the same thing before they started. The reason it works anyway is that the model doesn’t depend on you being special — it depends on structure, credibility and deal flow, which are all things we build with you.',
      'I answered the most common questions here:',
    ],
    cta: { label: 'Read the FAQs →', href: c.link('/breakout#faq') },
    ps: 'If you still don’t think it’ll work for you, just reply and tell me why. I’ll give you a straight answer.',
  }),
  b_book: (c) => ({
    subject: 'Want to talk it through?',
    preheader: 'A short call to map out your first acquisition.',
    body: [
      `${c.name},`,
      'If part 2 made sense and you want to see what this could look like for you, grab a time with one of our acquisition advisors.',
      'We’ll look at where you are, what kind of business you’d want to own, and what a realistic first deal looks like. If we can help, we’ll tell you how. If we can’t, we’ll tell you that too.',
    ],
    cta: { label: 'Book a call →', href: bookOrBreakout(c) },
  }),

  // ── C tier: resources ──────────────────────────────────────────────
  c_resources: (c) => ({
    subject: 'Your Acquisition Starter Kit',
    preheader: 'Checklist, deal template and seller scripts.',
    body: [
      `Hey ${c.name}, thanks for applying.`,
      'Based on your answers, the best next step is getting the fundamentals in place first. So here’s the starter kit:',
      '• The 3C Acquisition Checklist<br>• A vendor-finance deal structure template<br>• Off-market seller outreach scripts',
    ],
    cta: { label: 'Get the starter kit →', href: c.link('/resources#kit') },
    ps: waLine(c, 'Want the resources on WhatsApp? Message me here'),
  }),
  c_whatsapp: (c) => ({
    subject: 'Want these on WhatsApp?',
    preheader: 'Deals and structures, straight to your phone.',
    body: [
      `${c.name},`,
      'I share deal breakdowns, structures we’re seeing and new resources on WhatsApp first. If you want them, send me a message and I’ll add you.',
    ],
    cta: c.whatsappUrl ? { label: 'Message Josh on WhatsApp →', href: c.whatsappUrl } : { label: 'Get the resources →', href: c.link('/resources') },
  }),
  c_third_way: (c) => ({
    subject: 'The third way',
    preheader: 'Not savings. Not investors.',
    body: [
      `Hey ${c.name},`,
      'There are two ways most people try to buy a business. They save a deposit for years, or they raise money from investors and give away control.',
      'There’s a little-known third way: vendor finance plus a credible team behind you. The seller gets paid over time from the business’s own cash flow, and your savings stop being the bottleneck.',
      'When you’re ready to look at it properly, the door’s open.',
    ],
    cta: { label: 'Watch the breakdown →', href: c.link('/breakout') },
  }),

  // ── Booked: confirmation + show-up ─────────────────────────────────
  booked_confirm: (c) => ({
    subject: 'You’re booked ✓ (watch this before we talk)',
    preheader: c.callTime ? `See you ${c.callTime}.` : 'Your call is confirmed.',
    body: [
      `${c.name}, you’re confirmed${c.callTime ? ` for <strong>${c.callTime}</strong>` : ''}.`,
      'To get the most out of the call, watch this short video first. It covers how the call works, what to prepare and how to know if the 3C model fits you. People who watch it get twice as much out of the call.',
    ],
    cta: { label: 'Watch before my call →', href: c.link('/breakout') },
    ps: waLine(c, 'Add me on WhatsApp so you get your reminder'),
  }),
  call_24h: (c) => ({
    subject: `Tomorrow: your strategy call${c.callTime ? ` (${c.callTime})` : ''}`,
    preheader: 'A quick reminder and one thing to prepare.',
    body: [
      `Hey ${c.name}, quick reminder that we’re talking tomorrow${c.callTime ? ` — ${c.callTime}` : ''}.`,
      'One thing to think about before then: if you could own any kind of business, what would you enjoy owning? You don’t need a perfect answer — just a starting point.',
    ],
    cta: { label: 'Watch the pre-call video →', href: c.link('/breakout') },
  }),
  call_1h: (c) => ({
    subject: 'Starting in 1 hour',
    preheader: 'Join from a quiet spot on a laptop.',
    body: [
      `${c.name}, we’re on in about an hour.`,
      'Join from a quiet spot on a laptop, and if a partner is part of the decision, bring them along. The link is in your calendar invite.',
    ],
    ps: waLine(c, 'Running late? Message me on WhatsApp'),
  }),

  // Sent from the dashboard's Integrations tab to verify the email connection.
  test: (c) => ({
    subject: `Test email from ${c.siteName}`,
    preheader: 'Your email connection works.',
    body: ['If you’re reading this, Resend is connected and the funnel can send email. 🎉'],
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
