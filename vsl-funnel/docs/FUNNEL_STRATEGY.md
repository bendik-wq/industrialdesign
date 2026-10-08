# Funnel strategy: why it's built this way

This funnel follows the structure that most top-performing high-ticket VSL funnels share: the "VSL → application → calendar → indoctrination" model used across coaching, consulting and info-business offers. The common pattern, studied from the outside, comes down to **one job per page**: filter hard, and spend the most effort on the people most likely to buy.

The numbers in this document are **rules of thumb to beat, not promises**. Replace them with your own baseline after roughly 1,000 visitors.

---

## 1. The model

| Stage | Job | Lever that matters most |
|---|---|---|
| Ad | Make the right person curious | Hook + audience, judged on **qualified leads per dollar**, not CPC |
| VSL page | Get them to watch to the pitch | Headline → play rate. First 60 seconds → retention |
| Application | Filter, and make them commit | Contact details first, one question per screen, auto-advance |
| Routing | Spend closer time only where it pays | Score + hard caps; A goes to a closer, B is nurtured, C gets resources |
| Calendar | Book while intent is hot | A-tier sees the calendar immediately, prefilled |
| Breakout / pre-call | Make them show up already sold | Pre-call video, FAQs that handle objections, WhatsApp contact |
| Follow-up | Recover everyone who stalled | Abandon emails, tier sequences, reminders, a human on WhatsApp |
| Feedback loop | Teach the ad platform what a good lead is | `QualifiedLead` / `Schedule` sent server-side with a value |

The funnel's biggest hidden cost is usually **no-shows and unqualified calls**, not ad spend. That's why so much of this build is about what happens *after* the opt-in.

## 2. Page by page

### Landing (`/`)
- **No navigation, one action.** The only links lead to `/apply` or the privacy page.
- **Pre-headline calls out the avatar** (the black top bar), so the right people self-select in one second.
- **Headline + sub-headline sell the click on the video**, not the program. Two variants run as a live A/B test: the direct promise vs. Sultanic's "two paths are broken, here's the third way".
- **Muted autoplay + "Your video has started — click to listen".** Motion catches the eye, and the click is a micro-commitment. The video restarts from 0 with sound, so the hook isn't wasted.
- **No scrubbing, and a progress bar that runs fast at the start.** It stops people skipping to the price, and the video *feels* short early on, when most drop-off happens.
- **The CTA and the rest of the page unlock at the pitch** (`ctaRevealAt`). Visitors who click "apply" have heard the offer framed properly first. Returning visitors see the CTA immediately.
- **Below the gate:** "what you'll discover", who it's for and **not** for (repelling the wrong people raises lead quality), testimonials (hidden until you add real ones), and a repeated CTA.

### Application (`/apply`)
- **Contact details on step 1.** Everyone who starts becomes a lead, and that is what makes the abandoned-application sequence possible. This is typically the single biggest recovery lever in an application funnel.
- **One question per screen, auto-advancing on tap.** Each answer is a small yes, which builds commitment and lifts completion compared with one long form.
- **The questions do double duty:** they qualify the applicant, and they make them say out loud *why now* and *what's stopped them*. Your closer reads those answers before the call.
- **An "analysing your answers" moment** before routing makes the qualification feel real (and it is).

### Routing
- **Score = points per answer, then hard caps.** A high score can't get past "not ready to invest" or "student". Edit `TIER_RULES` in `config.ts`.
- **A → `/book`** with the assigned closer's calendar (weighted round-robin).
  **B → `/breakout`** with a setter calendar.
  **C → `/resources`**, plus WhatsApp and nurture emails.
  When no calendar is connected, A-tier falls back to the breakout page so no one hits a dead end.
- **Every tier still gets a next step.** C-tier leads become your audience for content, lower-ticket offers, and future calls once their situation changes.

### Breakout (`/breakout`)
- **VSL #2 goes deeper on the mechanism.** It shows a real deal structure line by line, which is what turns a B-tier "maybe" into a booked call.
- **FAQs carry the objection handling.** The 8 FAQs map to the real objections: money, experience, deal types, timeline, course vs. done-with-you, what the call is, other countries, price. Opens are tracked, so you can see which objections people actually check.
- **It becomes the pre-call page after booking:** call time, a "watch this before we speak" video, a prep checklist and FAQs. Prospects who arrive pre-sold close more often and no-show less.
- **"Add Josh on WhatsApp"** with a ref code. A personal channel is one of the strongest show-up levers there is, and the ref code lets you match each chat to its lead.

### Follow-up
| Sequence | Trigger | Stops when |
|---|---|---|
| `abandoned` | Contact details given | Application submitted |
| `tier_a` | A-tier submit | Call booked |
| `tier_b` | B-tier submit | Call booked |
| `tier_c` | C-tier submit | — |
| `booked` | Booking (re-scheduled when the call time changes) | Booking cancelled |

Every step re-checks the lead's live state just before sending, so nobody gets a "book your call" email after they've booked.

## 3. The feedback loop to ads

Optimising Meta for `Lead` buys you cheap leads. Optimising for **`QualifiedLead`** or **`Schedule`** buys you *customers*. This funnel sends both server-side through the Conversions API, with:
- hashed email, phone, name and city, plus `fbp`/`fbc` (from server-set cookies), IP and user agent, for high match quality;
- the same `event_id` as the browser Pixel, so the two deduplicate;
- an estimated pipeline **value** per tier, so value-based bidding favours A-tier leads (adjust `ECONOMICS` in `config.ts`).

Once you have roughly 50 `QualifiedLead` events a week, switch the campaign's optimisation event to it.

## 4. KPIs to watch (in the dashboard)

| Metric | Where | Rough healthy range* | If it's low, fix… |
|---|---|---|---|
| VSL play rate (with sound) | Overview | 40–70% of landing visitors | Headline / sub-headline, thumbnail, ad-to-page message match |
| Avg % watched | VSL | 25–45% | The first 60–90 s of the video (see "Biggest drop-offs") |
| Reached the pitch | VSL / Overview | 20–40% of plays | Move the pitch earlier, or tighten the middle |
| Opt-in (contact details / landing) | Overview | 5–15% | CTA reveal timing, offer clarity, trust |
| Application completion | Overview | 60–85% of starters | Remove or shorten questions with steep drop-off (Application tab) |
| Qualified (A+B) / applications | Overview | 40–70% | Ad targeting and the "not for you" copy |
| Booking rate (qualified → booked) | Overview | 50–80% | Calendar availability, the A-tier email sequence, speed to lead |
| Show rate | Overview | 65–85% | Pre-call video, WhatsApp, reminders, booking ≤ 3 days out |
| Revenue per visitor | Traffic | — | The number that compares ads, sources and variants fairly |

\*These are typical ranges for application-based high-ticket funnels, offered as starting points only. They vary a lot by offer, price and traffic source. Your own baseline is the real benchmark.

## 5. Testing roadmap (highest leverage first)

1. **Headline / hook** (live now as `headline-v1`). Judge it on applications per visitor, not play rate.
2. **The VSL's first 90 seconds.** Re-cut the opening using the drop-off table.
3. **CTA reveal time.** Earlier means more applications but lower intent. Watch qualified rate *and* show rate.
4. **Application length.** Cut any question whose answers don't change routing.
5. **B-tier path:** setter call vs. straight to a nurture sequence.
6. **Pre-call video length and WhatsApp prompt wording** against show rate.

Run one test at a time per page, and wait for the dashboard to show significance (p < 0.05) before calling a winner.

## 6. VSL script outlines

These are built on the Sultanic frameworks used across Owners Academy copy. Write in Josh's voice: a sharp operator who has done this, a little impatient with excuses.

### VSL #1: landing (12–18 min, pitch at ~7 min)
1. **Hook (0:00–0:30).** Pattern interrupt + promise: *"There are only two ways most people try to buy a business. Both are broken. In the next few minutes I'll show you the third way…"*
2. **Who this is for / not for (0:30–1:30).** Call out the four avatars: Corporate Prisoner, Trapped Owner, One-Business Ceiling, HNW Deployer.
3. **Credibility (1:30–2:30).** Josh's own deals, specific and verifiable. Use no claim you can't back up.
4. **The two broken paths (2:30–4:00).** Saving a deposit (years, and you still compete with PE) vs. raising capital (you lose control, it takes 12–18 months).
5. **The third way: the 3C model (4:00–6:00).** Capabilities (a board and team that make you credible), Capital (vendor finance + bankable structures), Closing (off-market sourcing, negotiation, getting it over the line).
6. **Proof** (real case studies only).
7. **The pitch (≈7:00, this is `ctaRevealAt`).** What working together looks like. Assumptive close: *"On the call we'll map out your first acquisition…"*
8. **Objections** (money, experience, time, "my situation is different").
9. **Cost inversion close.** The cost of another year of not owning anything.
10. **CTA.** *"Click the button below this video and answer a few questions. If we can help, you'll book a call with my team."*

### VSL #2: breakout (6–10 min)
- One real deal, line by line: purchase price, seller-financed portion, senior debt, the buyer's contribution, and debt service coverage from the business's cash flow.
- "Timeline of failure": find deal → offer → seller says yes → the bank kills it because the structure wasn't bankable → how 3C prevents that.
- Close: *"If this made sense, book a call and we'll do this exercise on your situation."*

### Pre-call video (3–5 min)
- What happens on the call, who'll be on it, how long it takes.
- What to prepare (budget range, timeline, industries you'd enjoy) and to bring a partner if one is involved in the decision.
- Set the frame: *"If it's a fit we'll show you how to work together. If not, we'll tell you."*

## 7. Launch checklist

- [ ] Real VSL uploaded to Cloudflare Stream and `VSL_MAIN_SRC` set; `ctaRevealAt` matches the pitch timestamp
- [ ] Breakout + pre-call videos connected
- [ ] Calendars for A/B connected; Calendly webhook created with the signing key
- [ ] Resend domain verified; `EMAIL_FROM`, `BUSINESS_ADDRESS`, `PUBLIC_URL` set; test email received; every template previewed
- [ ] Josh's WhatsApp number set; Cloud API template approved (optional)
- [ ] Meta Pixel + CAPI token; check events in Test Events, then clear the test code
- [ ] PostHog key (+ session replay)
- [ ] Slack alert webhook
- [ ] Testimonials added (real only); disclaimer + privacy policy reviewed
- [ ] `/admin*` behind Cloudflare Access
- [ ] One full test application per tier, end to end, then delete the test leads
