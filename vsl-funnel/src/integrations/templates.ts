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
      'Looks like you started your application but didn’t get to the end. No stress, it saved where you left off.',
      'It takes about 90 seconds to finish, and it’s how you get a strategy call with my team, where we map out your first off-market acquisition: the target, the structure and the financing.',
    ],
    cta: { label: 'Finish my application →', href: c.link('/apply') },
    ps: 'If something on the form didn’t make sense, just reply to this email and tell me.',
  }),
  abandon_2: (c) => ({
    subject: 'Quick question',
    preheader: 'Was it the funding question?',
    body: [
      `${c.name}, quick one.`,
      'When owners stop halfway through the application, it’s usually one of three things:',
      '• They think buying a business means putting in their own cash.<br>• They think they don’t have the time to run a deal.<br>• They think their industry is different.',
      'Here’s the straight answer. The deals are structured with seller finance and senior debt, and over-financed, so the stack covers more than the purchase price and none of your own cash goes in. You run the deal yourself, with me and my team beside you at every step. And the model depends on cash flow, not industry.',
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
      'I’m going to close out your unfinished application at the end of this week so we can give the call slots to owners who are ready.',
      'If growing by acquisition is on your agenda this year, finish it now. If not, no hard feelings. You’ll still get the occasional email from me with deals and structures we’re seeing.',
    ],
    cta: { label: 'Finish my application →', href: c.link('/apply') },
  }),

  // ── A tier: book the call ───────────────────────────────────────────
  a_approved: (c) => ({
    subject: `${c.name}, you’re approved for a strategy call`,
    preheader: 'Pick a time that suits you.',
    body: [
      `${c.name}, your application stood out.`,
      'Your business is the right size to buy another one. The next step is a strategy call where we look at your numbers and map out your first off-market acquisition: the kind of target, the deal structure and how the financing stacks up.',
      'Calls are limited each week because they’re run by people who actually do deals, so grab a time now.',
    ],
    cta: { label: 'Book my strategy call →', href: c.link('/book') },
    ps: 'Before the call, watch part 2. It walks through a real add-on acquisition line by line: ' + `<a href="${c.link('/breakout')}">watch it here</a>.`,
  }),
  a_reminder: (c) => ({
    subject: 'Your call slot is still open',
    preheader: 'Haven’t seen your booking come through yet.',
    body: [
      `Hey ${c.name},`,
      'You were approved for a strategy call but haven’t picked a time yet.',
      'The question isn’t whether it can be done. I’ve bought two businesses with 100% seller finance. The real question is how fast you get to a signed LOI, and that’s what this call is for.',
    ],
    cta: { label: 'Choose my time →', href: c.link('/book') },
  }),
  a_last_call: (c) => ({
    subject: 'Should I give your spot away?',
    preheader: 'Your approval is held for a little longer.',
    body: [
      `${c.name},`,
      'Your approval for a strategy call is held for a few more days, then the slot goes to the next owner on the list.',
      'Right now someone is buying the businesses in your industry. If it should be you, book the call.',
    ],
    cta: { label: 'Book my call →', href: c.link('/book') },
    ps: waLine(c, 'Want to ask something first? Message me on WhatsApp'),
  }),
  a_final: (c) => ({
    subject: 'The cost of waiting',
    preheader: 'Another year of organic growth?',
    body: [
      `${c.name}, last one on this.`,
      'Let’s talk about what it costs you NOT to do this. Another year of growing one customer and one hire at a time. Another year of good businesses in your market being bought by someone else. Another year closer to an exit valued as one small business instead of a group.',
      'The call is free. It costs you 45 minutes.',
    ],
    cta: { label: 'Book my strategy call →', href: c.link('/book') },
  }),

  // ── B tier: breakout VSL → FAQs → book ─────────────────────────────
  b_part2: (c) => ({
    subject: 'Part 2: how the deal actually gets funded',
    preheader: 'A real add-on acquisition, line by line.',
    body: [
      `Hey ${c.name}, thanks for applying.`,
      'I’ve bought two businesses with 100% seller finance through JC Health Group. Part 2 shows you how that kind of deal is built.',
      'I walk through a real add-on acquisition line by line: what the seller carries, what the bank funds, and how the stack is over-financed so none of it comes out of your own cash.',
      'Understand this before you contact a single seller.',
    ],
    cta: { label: 'Watch part 2 →', href: c.link('/breakout') },
    ps: waLine(c, 'Add me on WhatsApp'),
  }),
  b_two_paths: (c) => ({
    subject: 'Two paths',
    preheader: 'The slow way and the fast way.',
    body: [
      `${c.name},`,
      'There are two ways to grow a business past where it is now. The slow path is organic: more marketing, more hires, more of your hours, one customer at a time.',
      'The fast path is buying the businesses next to yours: their customers, staff and cash flow arrive on day one.',
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
      'I answered the most common questions here:',
    ],
    cta: { label: 'Read the FAQs →', href: c.link('/breakout#faq') },
    ps: 'If you still don’t think it’ll work for your business, reply and tell me why. I’ll give you a straight answer.',
  }),
  b_book: (c) => ({
    subject: 'Want to talk it through?',
    preheader: 'A short call to map out your first acquisition.',
    body: [
      `${c.name},`,
      'If part 2 made sense and you want to see what this could look like for your business, grab a time with one of our M&A advisors.',
      'We’ll look at your numbers, the kind of off-market targets that would fit, and what a realistic first deal looks like. If we can help, we’ll tell you how. If we can’t, we’ll tell you that too.',
    ],
    cta: { label: 'Book a call →', href: bookOrBreakout(c) },
  }),

  // ── C tier: resources ──────────────────────────────────────────────
  c_resources: (c) => ({
    subject: 'Your Acquisition-Ready Toolkit',
    preheader: 'Checklist, deal template and seller scripts.',
    body: [
      `Hey ${c.name}, thanks for applying.`,
      'Based on your answers, the best next step is getting the business acquisition-ready first. So here’s the toolkit:',
      '• The $1M+ Acquisition Readiness Checklist<br>• A seller-finance deal structure template<br>• Off-market seller outreach scripts',
    ],
    cta: { label: 'Get the toolkit →', href: c.link('/resources#kit') },
  }),
  c_third_way: (c) => ({
    subject: 'The third way to grow',
    preheader: 'Not more hires. Not investors.',
    body: [
      `Hey ${c.name},`,
      'Most owners try to grow in one of two ways: grind out organic growth, or raise money and give away equity.',
      'There’s a third way: buy the businesses next to yours, with the seller and the bank financing the deal, so none of your own cash goes in.',
      'When your business is ready for it, the door’s open.',
    ],
    cta: { label: 'Watch the breakdown →', href: c.link('/breakout') },
  }),

  // ── Booked: confirmation + show-up ─────────────────────────────────
  booked_confirm: (c) => ({
    subject: 'You’re booked ✓ (watch this before we talk)',
    preheader: c.callTime ? `See you ${c.callTime}.` : 'Your call is confirmed.',
    body: [
      `${c.name}, you’re confirmed${c.callTime ? ` for <strong>${c.callTime}</strong>` : ''}.`,
      'To get the most out of the call, watch this short video first. It covers how the call works, what numbers to have ready and how to know if acquisition growth fits your business. Owners who watch it get far more out of the call.',
    ],
    cta: { label: 'Watch before my call →', href: c.link('/breakout') },
    ps: waLine(c, 'Add me on WhatsApp so you get your reminder'),
  }),
  call_24h: (c) => ({
    subject: `Tomorrow: your strategy call${c.callTime ? ` (${c.callTime})` : ''}`,
    preheader: 'A quick reminder and what to have ready.',
    body: [
      `Hey ${c.name}, quick reminder that we’re talking tomorrow${c.callTime ? `, ${c.callTime}` : ''}.`,
      'Have last year’s revenue and profit to hand (rough numbers are fine), and think about which businesses in your market you’d most like to own.',
    ],
    cta: { label: 'Watch the pre-call video →', href: c.link('/breakout') },
  }),
  call_1h: (c) => ({
    subject: 'Starting in 1 hour',
    preheader: 'Join from a quiet spot on a laptop.',
    body: [
      `${c.name}, we’re on in about an hour.`,
      'Join from a quiet spot on a laptop, and if a business partner is part of the decision, bring them along. The link is in your calendar invite.',
    ],
    ps: waLine(c, 'Running late? Message me on WhatsApp'),
  }),

  // ── Voice assistant: link sent during a call ───────────────────────
  voice_link: (c) => ({
    subject: c.bookingUrl && c.lead.app_completed_at ? 'The link to book your strategy call' : 'The link to your application',
    preheader: 'As promised on the phone.',
    body: [
      `Hey ${c.name},`,
      c.bookingUrl && c.lead.app_completed_at
        ? 'As promised on the call, here’s the link to pick a time for your strategy call with my team. We’ll map out your first off-market acquisition: the target, the structure and the financing.'
        : 'As promised on the call, here’s the link to the application. It takes two minutes, and if you’re a fit you’ll pick a time for a strategy call with my team straight after.',
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
