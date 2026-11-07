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
| Intro (hook, proof, pain, gain, position) | Owners build. Buyers compound. | 00:00 | POLL target_type ~10:10 |
| Content | The ceiling | 10:41 | |
| | The owner down the road | 17:39 | POLL blocker ~22:40 |
| | How a business pays for itself | 23:02 | CALCULATOR ~28:15, POLL own_cash ~29:35 |
| | What a group is worth | 29:55 | BUY-IN ~33:00, **APPLY OPENS ~33:23** |
| | What 90 owners told us | 34:13 | POLL timeline ~37:50, CTA ~38:00 |
| | The seller's side of the table | 38:18 | CTA ~42:15 |
| | The first conversation | 42:38 | CTA ~45:55 |
| Transition (double tie-down, big domino) | Two yeses and the big domino | 46:17 | CTA ~49:45 |
| Offer | What happens when you apply | 49:56 | CTA ~58:20, POLL soft_close ~60:40, CTA ~60:55 |
| Pitch | Twelve months from now | 61:13 | CTA ~67:30 (after "We're going"), CTA ~72:00 |
| | Who you're becoming | 72:14 | CTA ~77:00 |
| | The questions owners ask us (the second pitch) | 77:12 | CTA ~80:45, ~84:15, ~86:00, ~88:05, ~93:05 |
| | Three owners, three situations (scripted interventions) | 93:25 | CTA ~99:20 |
| | Your decision | 99:30 | CTA ~102:00, WORKSHEET ~103:00 |

About 19,180 spoken words (the November 2026 desire rewrite added about 1,200, +7%, inside the agreed ±10%): **about 105 minutes
of speech** at 183 words a minute. The real chapter, poll, CTA and pitch times are measured from the audio at the render and
written to `src/webinar/edition-ai.ts`; never edit that file by hand. Rerender with `VOICE_SPEED=0.92` as before; at 0.86 it runs
nearer 112 minutes. The dry build times it with the breaths between slides.

Word counts per section: intro 1,950 (10.7 min) · content 6,520 (35.6 min) · transition 670 (3.6 min) · offer 2,070 (11.3 min) · pitch 7,980 (43.6 min).

**One source:** edit `script-ai-josh.md` only, then `python3 scripts/ai-webinar/sync_scripts.py` regenerates `script-ai.md`
(Josh's own facts move to the third person, "my team" becomes "Josh's team", the disclosure swaps) and rewrites the chapter
times in both. A new sentence where Josh speaks about himself needs a line in its `PERSON` list, or the run stops and names it.

## Where the booking calls to action land
- **The button appears at `[APPLY OPENS]` (about 33:23)**, the content's midpoint, right after the viewer writes what their first
  acquisition would change for them. That is the edition's pitch minute (`pitchAtMin`): the room shows the Apply button and the
  in-room application card from there to the end. A timeline with `cta: 'apply'` never unlocks the First Deal Sprint in the room.
- **Each `[CTA]` (16, all after the pitch, each placed right after an emotional peak: the 90 owners, the seller's chair, the
  coffee, the big domino, the guarantee, "We're going", the two Tuesdays, the identity reveal, the owners' questions, the close)** is a spoken ask that the room marks: the Apply button and the application card pulse for a
  few seconds (`ctaAt` in the timeline, `webinar-room.js`), respecting reduced motion.
- After an in-room application, A and B tiers get **"Book my strategy call"** straight away (`/w/<token>?to=book` → one-tap `/book`);
  C tier sees "the team replies by email". The room's own button switches to booking too.
- The pitch poll (`soft_close`) asks "Is a strategy call with Josh's team right for you?" for this recording; same answer values,
  so the hot-lead ping and Funnel HQ read it as before.

## The desire layer (November 2026, docs/desire-doctrine.md)
- **Proof in the first two minutes:** right after the anchor, "Twice, the sellers financed the whole price" as an IF...THEN
  (if you run a profitable business and an owner near you has no successor, the price can be paid from its own profit; Josh
  has done it twice), beside the signing photo. It opens one more loop ("it wasn't luck, and it wasn't money") that the
  seller's question closes. The title slide's subtitle carries the same fact.
- **Scenes instead of statements:** 17 story beats are now film scenes in the deck (a time and place slug, one sensory line
  per click): the ceiling at home, breakfast at 7:10, the industry dinner (his phone stayed in his pocket; Dan's buzzed four
  times before the entrée), Graham's call, the drive past the yard, the group's table, the first ten minutes of the call, the
  middle weeks, the letter, Graham's workshop, "We're going", the other Tuesday, the end of the call, and the last line.
  Pain scenes are near-black, the wanted future warm white.
- **Motifs:** the phone, the kitchen table at 9:40 (cold tea, then hot tea), the sign over Graham's gate, Easter ("I'll see",
  then "We're going"). Each returns in the felt future and again in the first path, so the two futures compare object for object.
- **The cost made physical:** 78 Saturdays (eighteen months of "just for a while") and one more year as 52 squares, 12 month-end
  reports and one more year on every owner with no successor; both labelled illustrative.
- **The felt future as a day:** one Tuesday a year after the first deal, hour by hour (7:50 am to 9:40 pm), ending on the call
  Dan is looking forward to making (the reach, not only the arrival); a Thursday in week six built the same way for the engagement.
- **The two-state cut:** "The same Tuesday, two ways", split down the middle, one matched pair per click.
- **The identity reveal:** "I'm an owner." struck through, then "I'm a buyer.", said once by the viewer, tied to a behaviour.
- **The close:** the three reasons (why this path, the reason to believe it, why now) as a proof ledger, the guarantee restated
  beside the last ask, and Josh's last line joined to his proof.
- **Softened absolutes:** "the question every seller asks" is now "the question sellers ask"; "never list" is "rarely list".

## The levers, section by section (also marked in the scripts as `<!-- ... -->` margin notes, never spoken or shown)
- **Intro:** pace before lead (four true statements for the $1M+ owner) · negative command ("don't answer it yet") · the anchor
  "Owners build. Buyers compound." (a dark slide labelled "The line to remember", same words every time; six firings: hook, end of
  the ceiling, the desire peak before the button, the big domino, the identity statement, the close) · not-your-fault frame ·
  two-agenda open (Fladlien): the ask is named in minute 4, with a checkable condition on the first agenda (research pattern P2) · the protagonist Dan (an illustrative composite) and the **three
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
  visible no, the worksheet for everyone either way, opened as "one more thing" (Jobs' last reveal, research pattern P9).
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

**Added 2026-11-07, the owner's decision ("bring the proof in"), from Josh's Dealmaker deck:**
- *Josh's own statements, always as "I" (Josh script) or attributed to him (narrator):* in banking by 21 with $30M+ in deals;
  $100M+ in transactions advised on and closed; first deal at 25, 100% seller financed, youngest in Australian history to do so in
  healthcare; before it, unemployed, no experience, about 1,000 cold calls and four dead deals; first deal over 7 years at 4%,
  none of his own money, about $150K out in year one, about 13,000 customers on day one; JC Health Group a multi 7-figure
  portfolio, KingLi an 8-figure group being built, a 9-figure exit as his goal; a board with 200+ years of experience, a former
  federal minister in the chair, cold-calling from his bedroom a few years before. (Who's behind the method; Two acquisitions,
  both seller financed; The credibility you borrow.)
- *Clients' results, each block with "These are their results, not a promise of yours.":* Jason (radiology): first deal $5.5M,
  nothing down, no personal guarantee, the $200M exit seven years later, as the deck attributes it (One deal, over five million,
  no personal guarantee; the two answers that mention it now say Jason's). Cam: two deals in 23 days, 100% seller finance; an
  $850K 100% seller-financed LOI. Saul: first NDA. A member: two deals in a morning, $508K combined EBITDA. Jy: a board in 29 days,
  CEO of KingVets. Christian: a $2.4M deal, financed above the price (his result and photo only; nothing personal about him,
  anywhere). Members: a $4.4M SBA approval, four LOIs in a day incl. one on a $23M business, a 700K over 7 years seller-financed
  contract. (In their own messages; Two more who moved; The receipts.)
- *Documents:* a real target's P&L under review, JC Health Group's redacted NBIO (What closing looks like on paper; A real offer,
  redacted).
- *Left out on purpose:* the deck's own offer, value stack, "live only", "limited spots" and 48-hour lines (the masterclass sells
  apply and book); the market numbers ($10T, ~75% without a succession plan, 60 cents on the dollar), because the deck gives no
  source; the coach quoting billionaires; crude chat lines (cropped or masked in `deck-images.json`).
- The copy audit allows these numbers only in their exact wording, and a client's only beside the typicality line (`PROOF` in
  `copy-house.ts`).

## The owner must verify or approve before the render
1. **Deck images with people or private material** (`"consent": "verify"` in `deck-images.json`; the voiced build refuses until
   `"confirmed": true`): `josh-portrait` (title slide), `josh-handshake` (Josh with a seller; captioned "Josh Li with a seller at
   signing"), `jc-health-board` (captioned "The board of JC Health Group, Josh Li's healthcare holding company"; no board members
   are named), `outreach-dm` (the owner outreach template; check it has no real names). The client chats, case
   studies, board photos and documents were approved on 2026-11-07 (see "Added 2026-11-07" above) and are `"confirmed": true`.
2. Extract the deck images (`python3 deck_images.py <deck.pdf>`): every used image is a placeholder until then.
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

## The presented deck
Josh can also present this script himself from Funnel HQ → Studio → Deck (`/admin/deck`): builds, scenes, presenter
view with these levers per slide, and the PDF export. How it works: README.md, "The presented deck". The research behind
its devices: `docs/webinar-research.md`.

## Checks run
- Copy audit: `npx vite-node scripts/ai-webinar/audit-script.ts` → 0 flags on both scripts (auditCopy on every spoken segment and
  every on-screen line, plus: no em or en dashes, no exclamation marks, no "free", no liveness or invented scarcity words, no
  promised results, example numbers labelled illustrative on the same slide, seller rollover named wherever funding is described).
- `python3 build.py --slides` and `--dry` into `out-dry/` (no voice credit, live files untouched): not rerun in the November 2026 desire pass.
