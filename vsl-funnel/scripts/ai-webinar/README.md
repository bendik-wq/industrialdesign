# AI-edition masterclass

Builds the AI edition of the masterclass: Josh's method narrated by an AI voice (ElevenLabs library voice "Christopher", British, at 92% speed,
disclosed in the opening and on every slide), pitching the First Deal Sprint from the first minute.
`script-ai-josh.md` is the first-person version for Josh's own cloned voice once his professional clone is trained
(run with `VOICE_ID=4VFizj5F8jBY7TGDsGjk` after swapping the script in).

1. Put the ElevenLabs API key in `scripts/ai-webinar/.key` (never committed). It's the same key as Funnel HQ → Integrations → Voice.
2. Drop Josh's March 2026 deck (PDF) anywhere and run `python3 deck_images.py /path/to/deck.pdf`. It extracts the original images into
   `deck/` (gitignored), resolves the ones mapped in `deck-images.json` and prints what's left: open `deck/contact.html` to check the
   slide numbers marked "check slide number", fix `deck_slide` / `pick` / `crop` in the mapping, then `python3 deck_images.py --resolve`.
   Images marked `"consent": "verify"` (people, names, private chats) need the owner's OK, then `"confirmed": true`.
   Slides 55, 62 and 81 are excluded and never extracted.
3. `python3 build.py --slides` renders only the slide PNGs into `out-dry/slides` (seconds, no audio). `python3 build.py --dry` builds
   everything with silent placeholder audio into `out-dry/` (no credit used, live files untouched). Missing images show as placeholders.
4. `VOICE_SPEED=0.92 python3 build.py` renders the voice (about 21,000 characters; cached by text, so re-runs only pay for changed slides),
   the slides, the video and the HLS files in `public/assets/media/webinar/ai/`, and rewrites `src/webinar/edition-ai.ts`
   with the timeline measured from the real audio. It stops before spending anything if a mapped image is missing or unconfirmed.
5. `npx vitest run test/webinar-editions.test.ts`, deploy, then set `WEBINAR_EDITION=ai` in Funnel HQ → Settings → Webinar.

Edit the words in `script-ai.md` (it must pass the copy audit), never the generated timeline.

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

`[ON SCREEN: …]` lines show as the takeaway on `statement`, `section` and `image-left` slides; data layouts carry the same facts in `[DATA]`.
