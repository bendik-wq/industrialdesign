# AI-edition masterclass

Builds the AI edition of the masterclass: Josh's method narrated by an AI voice (ElevenLabs library voice "Christopher", British, at 92% speed,
disclosed in the opening and on every slide). The script (v3, see WEBINAR-NOTES.md) is a story-led, identity-shift presentation of about
100 minutes that sells one action: apply and book a strategy call with Josh's team. The Apply and book button appears in the room at
`[APPLY OPENS]` (the content's midpoint) and is nudged at every `[CTA]`; the Sprint does not unlock for this recording.
`script-ai-josh.md` is the same script in the first person for Josh's own cloned voice once his professional clone is trained
(`VOICE_ID=<clone> python3 build.py --script script-ai-josh.md`; the slide footer then says it's an AI version of his voice).

1. Put the ElevenLabs API key in `scripts/ai-webinar/.key` (never committed). It's the same key as Funnel HQ → Integrations → Voice.
2. Drop Josh's March 2026 deck (PDF) anywhere and run `python3 deck_images.py /path/to/deck.pdf`. It extracts the original images into
   `deck/` (gitignored), resolves the ones mapped in `deck-images.json` and prints what's left: open `deck/contact.html` to check the
   slide numbers marked "check slide number", fix `deck_slide` / `pick` / `crop` in the mapping, then `python3 deck_images.py --resolve`.
   Images marked `"consent": "verify"` (people, names, private chats) need the owner's OK, then `"confirmed": true`.
   Slides 55, 62 and 81 are excluded and never extracted.
3. `python3 build.py --slides` renders only the slide PNGs into `out-dry/slides` (seconds, no audio). `python3 build.py --dry` builds
   everything with silent placeholder audio into `out-dry/` (no credit used, live files untouched). Missing images show as placeholders.
4. `VOICE_SPEED=0.92 python3 build.py` renders the voice (about 103,000 characters for the v3 script; cached by text, so re-runs only pay for changed slides),
   the slides, the video and the HLS files in `public/assets/media/webinar/ai/`, and rewrites `src/webinar/edition-ai.ts`
   with the timeline measured from the real audio. It stops before spending anything if a mapped image is missing or unconfirmed.
5. `npx vitest run test/webinar-editions.test.ts`, deploy, then set `WEBINAR_EDITION=ai` in Funnel HQ → Settings → Webinar.

Edit the words in `script-ai.md` and `script-ai-josh.md` (keep them the same apart from the person), then run the copy audit:
`npx vite-node scripts/ai-webinar/audit-script.ts` (every spoken and on-screen line through auditCopy, plus no dashes, no "free",
no fake liveness, illustrative labels on example numbers, seller rollover named with funding; it must print 0 flags). Never edit the
generated timeline. `<!-- ... -->` margin notes (the NLP levers) and other bracketed lines are never spoken or shown.

## Slides
`slides.js` draws every slide in one system: solid warm white `#f7f6f3` (near-black `#111` for three section breaks), navy `#0f2c5c`
as the only accent, Newsreader headlines, Inter small text, 128px margins, hairline rules, small-caps labels, big tabular numbers.
No gradients, glows, translucent overlays or bordered boxes. Each slide's look is set by lines under its `[SLIDE: title | sub]` line,
which are never spoken (the audio cache doesn't change when they do):

- `[LAYOUT: …]` one of `title`, `statement` (default), `section`, `stat`, `list`, `comparison`, `quote`, `table`, `offer`, `step`, `image-full`, `image-left`
- `[DATA: a | b | c]` repeatable rows: `stat` number | label (first row big, up to 3 more small); `list` head | description (max 3);
  `comparison` label | value | text (2 rows); `table` header row first, last row is the result; `offer` label | amount, last row is the total
- `[IMAGE: id]` an image from `deck-images.json` (`title`, `step`, `image-full`, `image-left`)
- `[CAPTION: …]` a footnote, the image caption, the quote's attribution or the step's line
- `[KICKER: …]` the small label: on `title` and `step` slides, and on a `section` slide inside a chapter (no big chapter number then)
- `step` slides take their track from `[DATA: label | name]` rows (else the Sprint's seven days)

`[ON SCREEN: …]` lines show as the takeaway on `statement`, `section` and `image-left` slides; data layouts carry the same facts in `[DATA]`.
