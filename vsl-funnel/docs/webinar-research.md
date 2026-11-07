# What the best webinars and keynotes do on screen, and what we took for the masterclass deck

Research for the presented deck (`public/assets/deck/`, `/admin/deck`) and the script (`scripts/ai-webinar/script-ai-josh.md`).
Done 2026-11-07. The question: what do the presentations that sell best (and the keynote that set the bar for design) do
that "boring slides" don't, and how much of it fits a $1M+ owner deciding to book a strategy call?

## Method
1. **The brain first** (Bendik's wiki): `engine/webinar/the-webinar/` (Brunson, Fladlien, Graziosi and Robbins, Hormozi,
   Porterfield, Kennedy, Ruffino, Walker), `engine/persuasion/nlp/` (Milton model, anchoring, sleight of mouth, Robbins'
   stage methods, the copy checklist) and the private note on the earlier 111-slide Dealmaker deck (summarised below, not quoted).
2. **Public replays** found with Monid (YouTube search, sorted by popularity) and their transcripts pulled with Monid
   (Apify transcript actor): 12 searches, 16 transcript pulls (15 with text, 14 summarised).
3. **Structure** of each transcript summarised with DeepSeek (Flash): run of show with timestamps, the slide and stage
   devices the speaker uses or refers to, how desire and proof are shown, the closing mechanics, pacing, five transferable
   patterns. The summaries are in the session scratchpad, not committed (they paraphrase third-party talks).
4. **Visual references**, the lawful way: Playwright screenshots of public pages only (YouTube poster frames from
   `i.ytimg.com`, public landing pages, Speaker Deck and SlideShare search pages), described with DeepSeek vision. No video
   was downloaded or ripped and nothing behind a login or paywall was opened. The screenshots are in
   `docs/webinar-refs/` (gitignored, never committed or published).
5. **Rule for using any of it:** patterns only (devices, pacing, build techniques, hierarchy, how proof and desire are shown).
   No other creator's slides, words, characters, names or branding are in our deck or script.

## Sources studied

| Presentation | Who | Public source | Why it's here |
|---|---|---|---|
| Perfect Webinar training (110 min) | Russell Brunson | youtube.com/watch?v=r5RDc_wqmiU (re-upload of his free training, 45k views) | The most copied selling structure; stack, "if/all", recap slide |
| $3M in 90 minutes at 10X | Russell Brunson | youtube.com/watch?v=On7dJ_cqD4E (6k) | The structure live on stage, with timings |
| Knowledge Business Blueprint 2020 (137 min) | Tony Robbins, Dean Graziosi | youtube.com/watch?v=H1rGPScketw (4k) | Two-host mega-webinar, long runway, repeated closes |
| Fear of not being enough, full intervention (68 min) | Tony Robbins | youtube.com/watch?v=QOLzURdopV4 (309k) | State change, one story carrying the argument, room scans |
| 14 webinar steps (27 min) | Jason Fladlien | youtube.com/watch?v=AwZbMUoRKcg (46k) | His own map of the sequence |
| Close 30% of a room on a $3k offer (63 min) | Jason Fladlien | youtube.com/watch?v=B90eANIJ2XI (13k) | Objections inside the teaching, QR close, proof by receipts |
| 2026 livestream (7.5 h) | Alex Hormozi | youtube.com/watch?v=vhOV_Od0A3M (1.1M) | Teach everything, sell the implementation, long-form attention |
| Seven mindset shifts (60 min) | Myron Golden | youtube.com/watch?v=x3TbOrkbUR8 (535k) | Contrast and value framing without a hard pitch |
| Profitable webinar prep (48 min) | Amy Porterfield | youtube.com/watch?v=zf7mzsXVqfA | Workbook, time rules, the pitch by minute 45 |
| iPhone keynote, Macworld 2007 (80 min) | Steve Jobs | youtube.com/watch?v=2MlSJLPxGYs, vN4U5FqrOdQ | The design bar: one idea per slide, reveals, demos, price framing |
| Find businesses no one else knows about (80 min) | Codie Sanchez | youtube.com/watch?v=3mtS8rOAqoM (496k) | Acquisition niche: numbers on screen, the deal tracker, the future graph |
| Making billions buying businesses (64 min) | Walker Deibel | youtube.com/watch?v=SXwOv9QUWws (11k) | Acquisition niche: application CTA, selectivity as scarcity |
| How to structure an acquisition (66 min) | Carl Allen | youtube.com/watch?v=RPu0575AzVA (73k) | Acquisition niche: worked deal maths, live DSCR calculator |

Landing pages captured for design: Dealmaker Wealth Society, Codie Sanchez (two pages), Acquisition.com, Mastermind,
Myron Golden, Amy Porterfield, Walker Deibel, Apple Events and Newsroom; Speaker Deck and SlideShare searches for
public webinar and pitch decks (mostly generic corporate decks: useful mainly as what to avoid).

## What each one does (short)
- **Brunson.** One big domino stated early; three secrets each break a false belief with a story; a permission ask before
  the offer ("ok if I take 10 minutes"); a stack slide that re-shows every earlier item as each new one lands; "if all"
  questions before the price; a recap slide with the price and the URL left up while he answers questions. On the 10X stage
  the ask starts at 44:38 of 66 minutes, after hand-raise polls every few minutes.
- **Robbins and Graziosi.** A long runway: no price until about 75 minutes, first enrol call at 82 minutes, then the close
  repeated eight times across guests, testimonials and objections. Chat prompts every 10 to 15 minutes break monologues.
  Robbins' intervention has no slides at all: one person's story carries an hour, and he makes the room look around at
  its own raised hands (social proof the audience produces).
- **Fladlien.** Says up front there will be an offer, names the false beliefs in minute 2, teaches 3 to 5 inputs with a
  small commitment after each, handles 5 to 9 objections inside the teaching, then a short core offer and a long bonus
  stack where each bonus kills one objection. On a live room he closes with a QR code and a URL, proof by receipts
  (invoices, wires) and real capacity as the scarcity.
- **Hormozi.** Teaches the real thing for hours; the ask is light and repeated; the visual is him and a whiteboard, the
  "slide" is a hand-drawn number. Attention comes from density of useful ideas, not production.
- **Golden.** Value by contrast: what something costs against what it's worth to the buyer, drawn as two columns.
- **Porterfield.** A workbook to fill in during the webinar; the pitch by about minute 45; the URL said before 60.
- **Jobs.** A new idea or visual every 2 to 6 minutes; promise, problem, mechanism, live proof, recap; three things
  revealed as one ("an iPod, a phone, an internet communicator"); before-and-after screens side by side; the price framed
  against what you'd spend today before it's shown; partners as borrowed authority; almost no text on screen.
- **Codie Sanchez.** Numbers on screen all the time: listings with price, cash flow and debt service, a P&L, a deal tracker
  dashboard, and to close a ten-year line that compares the build path with the acquisition path.
- **Walker Deibel.** The offer is an application: soft mention at 43% of the runtime, then the selectivity of the cohort
  as the reason to apply, never a countdown.
- **Carl Allen.** Worked deal structures for most of an hour, then a live coverage calculator (debt service, DSCR); one
  soft ask at the very end.
- **Our own earlier deck (Dealmaker deck, May 2026, private note in the brain).** 111 slides on Fladlien's nine-part
  architecture with full speaker notes, editorial look (serif, cream, two accents). It carried figures the owner hadn't
  confirmed and an unset price, which is why the current script uses only the approved proof list.

## Pattern library

| # | Pattern | Seen in (with time in the replay) | What it does to a viewer | How we use it |
|---|---|---|---|---|
| P1 | **One idea per slide, revealed in builds** | Jobs throughout (a new visual every 2 to 6 min, three-in-one reveal 01:52 to 03:20); Brunson's restack (53:45 to 55:31) | Attention resets on every reveal; the speaker is never ahead of the screen | Every list, comparison, table and scene reveals one row or element per click (436 build states over 203 slides) |
| P2 | **Say the ask up front, with a condition** | Fladlien: two agendas and a bold conditional in the first minutes (14 steps 00:00 to 04:58) | The ask later is expected, not a trick; the viewer agrees to judge on a condition | Script: the two-jobs slide now adds a condition you can hold Josh to |
| P3 | **Name the big domino, then knock the others over** | Brunson (training 33:41 to 47:27; 10X 16:11, 42:35) | One belief carries every objection | The big domino scene: one domino, three objections, the chain falls on one click |
| P4 | **Numbers that move on screen** | Codie Sanchez (listings, P&L, tracker 41:37 to 77:28); Carl Allen's live DSCR calculator (63:48 to 65:50) | Proof by experience: the viewer watches the deal pass | The 1.5x gauge, Dan's numbers with markers sliding past the test line, the multiple arbitrage chart, the group value bars, the 90-owner dot grid |
| P5 | **Before and after, side by side** | Jobs (competitor screens vs iPhone, 60:52 to 61:55); Golden's two-column value; Sanchez's build vs buy line (78:09) | Contrast does the arguing | Two paths (a road that forks under a ceiling), waiting has a cost (33 small blocks vs one block), the two-path close |
| P6 | **The stack, built line by line, with the total last** | Brunson (stack and recap 51:19 to 63:37); Fladlien (59:12 to 61:40) | Value accumulates visibly before the ask | "Everything in one place" as a ledger that fills line by line and ends on "Apply and book" (no price: the call sells, the fee is covered on the call) |
| P7 | **Risk reversal you can read** | Graziosi (30-day guarantee 82:32, 133:19); Fladlien (better than money back) | Certainty, the variable Fladlien says matters most | The guarantee as a receipt that prints clause by clause, conditions ticked, the 7-day refund stamped |
| P8 | **Audience participation every 10 to 15 minutes** | Brunson's hand raises (03:17 to 37:15); Robbins' room scans (32:23, 65:31); KBB chat prompts (12:59, 44:46, 59:09) | Micro-commitments; the room supplies its own social proof | Poll slides show the room's real poll (question and options) when the poll fires; buy-in and worksheet cues in the presenter notes |
| P9 | **The last reveal is a gift ("one more thing")** | Jobs' reveal rhythm; Brunson's stay-to-the-end bonus (28:28) | Ends on generosity, keeps the no-buyers warm | Script: the worksheet beat now opens "One more thing, and it's for everyone" |
| P10 | **One action, one URL or QR, left on screen** | Fladlien's QR close (61:40); Brunson's recap slide with URL (60:28); Deibel's "apply" (60:50, 63:58) | Nothing to decide but yes or no | Apply-and-book slides with a QR code to /apply, the three steps (apply, book, talk) and the address |
| P11 | **A cinematic section opener per chapter** | Jobs' black stage between segments; Robbins' state changes | Signals a new act; lets the presenter breathe and the face carry the moment | Dark full-bleed openers with a huge chapter numeral; the clock at 9:40 for Dan's Tuesday; the kitchen table seen from the seller's chair |
| P12 | **The same anchor, the same way, every time** | Robbins (anchoring); Jobs' repeated tag lines | A phrase the viewer can't unhear | "Owners build." then "Buyers compound." on a dark slide, the second line on the click, identical at all six firings |
| P13 | **Teach the real thing, sell the implementation** | Hormozi (hours of teaching), Allen (an hour of deal maths) | Trust; the call becomes the obvious next step | Kept from the script: the 1.5x test and the structure are shown in full; the call applies them to the viewer's numbers |
| P14 | **Selectivity, not a countdown** | Deibel (vetted cohorts, 59:26, 63:37); Fladlien (capacity maths 62:01) | Real scarcity reads as honest to a $1M+ owner | Kept: an application, a limited number of engagements per intake, no timer |
| P15 | **The face carries the story, the screen carries the numbers** | Robbins (no slides in an hour of story); Jobs (demos full screen) | Matches the medium to the beat | Each slide tells Studio which face-cam layout to use: story beats put Josh big (spotlight), data scenes put the screen big (stage) |

## The ten that matter most for booking rate (in order)
1. **One action, left on screen** (P10). A QR code and the address on every apply slide; the same three steps every time.
2. **The ask said up front, with a condition** (P2). Nobody feels ambushed at minute 46; the condition is checkable.
3. **Numbers that move** (P4). The 1.5x gauge and Dan's markers are the "demo": the viewer watches a deal pass the test.
4. **Risk reversal you can read** (P7). The guarantee is shown in full, clause by clause; certainty is what gets a $1M+ owner to book.
5. **The big domino** (P3). One belief that answers "no money, no experience, my industry is different" in one picture.
6. **Before and after** (P5). Two paths and the cost of waiting make the status quo the risky choice.
7. **The stack, line by line** (P6). The call, the engagement, the protection, then "Apply and book".
8. **Participation every 10 to 15 minutes** (P8). The room's polls on screen when they fire.
9. **Selectivity, not a countdown** (P14). Honest scarcity keeps trust, which is what books calls in this audience.
10. **One idea per click** (P1). Keeps attention through a 100-plus minute talk; the presenter view always shows what the next click reveals.

## Visual notes from the screenshots (DeepSeek vision, summarised)
- **Adopt:** generous dark negative space with one message (Jobs 2007 poster, Fladlien thumbnails); a single strong
  accent colour for the action (Dealmaker Wealth Society's gold, Golden's gold: ours is navy); a stats strip with lots of
  white space (Acquisition.com); split layout with a portrait on one side and the type on the other (Golden, Mastermind).
- **Avoid:** busy photo montages behind copy, neon promo bars and stickers, several competing calls to action, all-caps
  hype type in saturated red, oversized rounded cards and product renders, dense tiny text (the generic Speaker Deck and
  SlideShare decks are mostly this).

## What changed in the script because of this
- **The two-jobs slide** gains Fladlien's conditional promise: "If by the end you can't name one business you'd want to
  own, and see how its numbers could work, close the tab and don't give us another thought." (both scripts)
- **The worksheet beat** opens with Jobs' "one more thing", framed as a gift for everyone, whether they apply or not.
- **Scene tags** (`[SCENE: id]`, never spoken, ignored by the video build) on 35 slides call for the visuals above.
- Everything else (the words, the NLP structure, the anchor, the loops, the CTAs) is unchanged. The copy audit stays at 0 flags.

## Spend
DeepSeek about $0.36 (balance 4.93 to 4.57): 14 transcript summaries (two passes; the first lost its output to reasoning
tokens) and 26 screenshot descriptions. Monid about $0.09: 12 YouTube searches and 16 transcripts.
