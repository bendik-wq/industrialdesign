# Pages and copy

## Pages (static templates in `public/`, filled by HTMLRewriter in `src/funnel/pages.ts`)
- **`/` landing VSL**: server-chosen headline variant (sticky per visitor, `?v=b` previews, `?preview=1` isn't counted). Muted autoplay with a "click to listen" overlay that restarts with sound. No seek bar, and the progress bar runs fast at the start. Resumes where they left off. The CTA, application and rest of the page unlock at the pitch timestamp. Sticky mobile CTA. FAQ, guarantee, (real-only) testimonials, WhatsApp. Sections carry `data-section` attributes for tracking.
- **`/apply`**: one question per screen with keyboard shortcuts. Contact details (name, email, mobile) come first, plus the **unticked** AI-call consent checkbox with its full disclosure text. Every answer is saved server-side as they go. Ends with an "analysing" step, then routes.
- **`/book`**: closer's Calendly embed. The lead id is passed in Calendly's `salesforce_uuid` tracking param for exact matching. The browser postMessage reports the booking instantly, then the webhook confirms it.
- **`/breakout`**: VSL #2, objection FAQs, book CTA and WhatsApp. When the visitor is booked it switches to a pre-call version: call time, meeting link, prep checklist, pre-call video and FAQs.
- **`/resources`**: C-tier starter kit plus WhatsApp.
- **`/privacy`**: template. It must disclose tracking, profiling for personalised emails, AI calls, call recording, and processors and cross-border transfers (Cloudflare, Resend, Anthropic, ElevenLabs/Twilio, Calendly, Meta, Google, PostHog). Have a lawyer review it.
- **Landers** `/for/:industry[/:angle]` and `/m`: see landers.md.

## Copy rules (enforced in prompts, templates and tests)
- Plain, personal, letter-style writing from the founder: short sentences, no hype, no exclamation marks, no emojis in emails.
- Respect the user's banned words. Example: the original build never calls the strategy call "free", and a test asserts it.
- No fabricated testimonials, results, clients or case studies. The testimonials section stays hidden until real ones are added.
- Label illustrative numbers as "illustrative, not advice". No promises of outcomes, approvals or returns. No false urgency.
- State the offer the same way everywhere. In the original: a signed LOI in 90 days on an acquisition that can double or triple the business, no money down, over-financed (seller finance plus senior debt cover more than the price), deals tested at about 1.5x DSCR, done with you not for you, 7-day money-back guarantee.
- For VSL and email copy in the user's own style, use their copywriting skill if they have one.
