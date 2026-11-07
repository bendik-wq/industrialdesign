# The Acquisition Masterclass, AI edition v3: notes for the owner

What the script is for, how it runs, where it asks for the application, which persuasion levers sit where, and what you
must check before the voice render. The scripts: `script-ai.md` (AI narrator, third person) and `script-ai-josh.md`
(first person, for Josh's cloned voice). Same words apart from the person.

## The one job
Sell desire for the buyer's path and one action: **apply, then book a strategy call with Josh's team** (the button under
the video opens the in-room application; qualified owners then book in one tap on `/book`). Not a course: every teaching
point is carried by a story and a felt future. The call is never called free. The engagement's fee exists and is
covered on the call; the masterclass sells the call, not a price.

## Run of show (estimated at 183 spoken words a minute, the rate measured on the last voiced render)

| Part | Chapter | Starts | Cues |
|---|---|---|---|
| Intro (hook, pain, gain, position) | Owners build. Buyers compound. | 00:00 | POLL target_type 09:04 |
| Content | The ceiling | 09:37 | |
| | The owner down the road | 15:15 | POLL blocker 20:09 |
| | How a business pays for itself | 20:28 | CALCULATOR 25:25, POLL own_cash 26:39 |
| | What a group is worth | 27:00 | BUY-IN 30:00, **APPLY OPENS 30:19** |
| | What 90 owners told us | 30:57 | POLL timeline 34:32, CTA 34:44 |
| | The seller's side of the table | 35:02 | CTA 39:03 |
| | The first conversation | 39:22 | CTA 42:24 |
| Transition (double tie-down, big domino) | Two yeses and the big domino | 42:44 | CTA 46:13 |
| Offer | What happens when you apply | 46:21 | CTA ~53, POLL soft_close ~57, CTA ~57 |
| Pitch | Twelve months from now | 57:38 | CTA ~66 |
| | Who you're becoming | 66:01 | CTA ~70:40 |
| | The questions owners ask us (the second pitch) | 70:50 | CTA ~74, ~78, ~80, ~82, ~87 |
| | Three owners, three situations (scripted interventions) | 87:39 | CTA ~93:40 |
| | Your decision | 93:44 | CTA ~95:45, WORKSHEET ~96:40 |

About 17,900 spoken words: **about 98 minutes of speech; the dry build (silent audio at the same rate, with the breaths between slides) times it at 99.8 minutes**, with the button at 30:41, the pitch poll at 57:54 and the worksheet at 97:56. The real chapter, poll, CTA and pitch times are measured from the audio at the
render and written to `src/webinar/edition-ai.ts`; never edit that file by hand. If the owner wants it closer to 105 minutes,
render at `VOICE_SPEED=0.86` instead of 0.92 (slower, same words).

Word counts per section: intro 1,760 (9.6 min) · content 6,060 (33.1 min) · transition 662 (3.6 min) · offer 2,067 (11.3 min) · pitch 7,375 (40.3 min).

## Where the booking calls to action land
- **The button appears at `[APPLY OPENS]` (about 30:19)**, the content's midpoint, right after the viewer writes what their first
  acquisition would change for them. That is the edition's pitch minute (`pitchAtMin`): the room shows the Apply button and the
  in-room application card from there to the end. A timeline with `cta: 'apply'` never unlocks the First Deal Sprint in the room.
- **Each `[CTA]` (15, all after the pitch)** is a spoken ask that the room marks: the Apply button and the application card pulse for a
  few seconds (`ctaAt` in the timeline, `webinar-room.js`), respecting reduced motion.
- After an in-room application, A and B tiers get **"Book my strategy call"** straight away (`/w/<token>?to=book` → one-tap `/book`);
  C tier sees "the team replies by email". The room's own button switches to booking too.
- The pitch poll (`soft_close`) asks "Is a strategy call with Josh's team right for you?" for this recording; same answer values,
  so the hot-lead ping and Funnel HQ read it as before.

## The levers, section by section (also marked in the scripts as `<!-- ... -->` margin notes, never spoken or shown)
- **Intro:** pace before lead (four true statements for the $1M+ owner) · negative command ("don't answer it yet") · the anchor
  "Owners build. Buyers compound." (a dark slide labelled "The line to remember", same words every time; six firings: hook, end of
  the ceiling, the desire peak before the button, the big domino, the identity statement, the close) · not-your-fault frame ·
  two-agenda open (Fladlien): the ask is named in minute 4 · the protagonist Dan (an illustrative composite) and the **three
  nested loops**: A Dan's Tuesday night, C the big domino, B the question every seller asks · qualification up front.
- **Content:** story-led desire, not teaching. Dan's ceiling in close-up (sensory density) → Graham, the owner with no successor
  (the inciting incident) → the wrong maths and the right one (structure, the 1.5x test, the calculator as proof by experience)
  → the group picture (desire stacking: profit, time, exit, identity) → the button → the 90 booking forms as "people like you"
  → the seller's chair (perceptual positions) → the first conversation as a scene (the buyer's frame without a script).
  The opening hook question is answered in chapter 2 (an early payoff before the bigger loops).
- **Transition:** the double tie-down (does it work, could you do it) answered silently, loop B closed ("Why should I trust you
  with my life's work?"), loop C closed with the big domino, the small dominoes knocked over one at a time, anchor.
- **Offer:** loop A closed (Dan didn't buy a business that night, he applied: the story presupposes the CTA) · three steps to the
  call · what happens on the call (concrete, no promised outcome) · the engagement on the 3C model, each C as what it is, why it
  matters, what it feels like · the shape of the ninety days and a Thursday in week six (future pacing of behaviour, built only
  from the guarantee's conditions) · the LOI guarantee and the 7-day money-back read word for word with every condition and what
  it doesn't promise · who it's not for (takeaway) · what the team won't do · real scarcity only · self-prediction question.
- **Pitch:** Dan's ninety days and Dan a year after (future pace in close-up, labelled illustrative, no numbers or forecast) ·
  two paths, the other Tuesday (Dickens-lite, ordinary not catastrophic) · cost of waiting (illustrative) · **Dilts' logical
  levels**, one slide per level, ending on "I'm a buyer" and the anchor · 39 owner questions, facts first then one varied
  Sleight-of-Mouth reframe each, bridging to the button · four scripted case walkthroughs (Priya, Tom, Leah, Mark), illustrative
  composites, never presented as clients or testimonials · the After Close (thirty days), identity close, choice close with a
  visible no, the worksheet for everyone either way.
- **Big domino, word for word:** "You don't have to become a different person to buy a company, and you don't have to do it alone.
  You have to be seen as the buyer. And the credibility that makes you the buyer can be borrowed, from a team that has done it,
  until it's yours."

## Proof used (only the approved facts)
Josh Li founded JC Health Group, his own healthcare holding company · two acquisitions, the sellers financed 100% of the price in
both · the booking forms: 90 owners booked calls, 63 under $1M, 39 want to buy, 24 never bought, 24 wanted funding help, 23 wanted
debt-structuring help · the three quotes, word for word · one $5.5M radiology deal needed no personal guarantee (over $5M,
equipment secured the loan), told as one deal, not a rule · the method (commercial debt, seller finance, seller rollover; the 1.5x
test; off-market owners with no successor; group multiples as illustrative ranges; seller first, lender second) · the guarantee
and the 7-day refund, exact wording and conditions. Every other number is labelled illustrative on its slide.

## The owner must verify or approve before the render
1. **Deck images with people or private material** (`"consent": "verify"` in `deck-images.json`; the voiced build refuses until
   `"confirmed": true`): `josh-portrait` (title slide), `josh-handshake` (Josh with a seller; captioned "Josh Li with a seller at
   signing"), `jc-health-board` (captioned "The board of JC Health Group, Josh Li's healthcare holding company"; no board members
   are named), `outreach-dm` (the owner outreach template; check it has no real names). The client LOI chats and student result
   chats were left out on purpose: they carry claims outside the approved proof list.
2. Extract the deck images (`python3 deck_images.py <deck.pdf>`): all 11 used images are placeholders until then.
3. **Engagement facts the script states:** 90-day "Done with you" engagement on the 3C model; weekly working sessions; outreach
   scripts provided; the engagement has a fee covered on the call; calls run on video. Confirm each is how the team runs it.
4. **Guarantee wording and conditions** (read verbatim on screen and in the voice): confirm they match the signed terms and have
   had legal review.
5. **Scarcity:** the script says the team takes a limited number of engagements per intake, without a number. If
   `ENGAGEMENT_INTAKE_CAP` is set and you want the number spoken, swap in the bracketed owner note in "Why there's an application".
6. **The composites:** Dan, Graham, Priya, Tom, Leah and Mark are illustrative and said to be so, on screen and in the voice. Tom
   mirrors the "5-6m" booking-form quote and Leah the "10 clinics" quote; both are framed as built from owners like them, not as
   those owners. Approve that framing.
7. **Josh's voice version:** only once his professional clone is approved for this use (the footer then reads "Josh Li, in an AI
   version of his voice").
8. Room settings after the render: `WEBINAR_EDITION=ai`. Clear any `WEBINAR_PITCH_AT` override, or the button appears at the
   override instead of 30:19.

## Checks run
- Copy audit: `npx vite-node scripts/ai-webinar/audit-script.ts` → 0 flags on both scripts (auditCopy on every spoken segment and
  every on-screen line, plus: no em or en dashes, no exclamation marks, no "free", no liveness or invented scarcity words, no
  promised results, example numbers labelled illustrative on the same slide, seller rollover named wherever funding is described).
- `python3 build.py --slides` and `--dry` into `out-dry/` (no voice credit, live files untouched).
