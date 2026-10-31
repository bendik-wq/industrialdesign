# Materials format: webinar and challenge scripts

Every script the team presents (the live webinar, the five challenge days, the automated webinars) is one Markdown file in
`public/materials/<id>.md`, written in the format below. Funnel HQ → **Materials** turns each file into:

- a **script view** (spoken words, cues marked, words and minutes per chapter, printable),
- a **slide deck** built from the `[SLIDE]` cues (full screen, keyboard and clicker navigation, PDF via the browser's print),
- a **presenter window** (current and next slide, the words to say, a running clock against the planned time, the next host cue),
- a **run sheet** (chapters and host cues minute by minute, printable),
- a **download** of the `.md` file.

The files are private. The worker answers `/materials/*` with a plain 404 unless the request carries an admin session,
and Funnel HQ reads them through `env.ASSETS.fetch` (`src/routes/admin.ts`, `/admin/api/materials`). The parser is
`parseMaterial()` in `src/admin/materials.ts`.

## The file

```
---
title: The First Deal Live Webinar
funnel: live            # live | challenge | auto
day:                    # 1..5 for challenge days, blank otherwise
duration_min: 116       # the planned length, including live interaction
offer: deposit          # deposit | soft | sprint | none
---
## [00:00] Chapter title
[SLIDE: Title | optional subtitle]
[ON SCREEN: a line shown on the current slide]
[HOST: OPEN OFFER]
[NOTE: a stage direction only the presenter sees]
Spoken paragraphs are plain text, one to three sentences each.

[12:30]
```

Rules:

- **Frontmatter** between `---` lines. `title`, `funnel` and `duration_min` are required. Extra keys (`presenter`, `source`) are kept and ignored.
- **Chapters** start with `## [mm:ss] Title`. The time is when the chapter should start; minutes can run past 59 (`## [104:00] Your questions`).
  A chapter without a time continues the estimated clock.
- **Lines starting with `[` are cues and are never spoken.** Everything else (outside headings) is spoken, and a blank line ends a paragraph.
- **`[SLIDE: Title | subtitle]`** starts a new slide. Words spoken after it, up to the next slide, are that slide's speaker notes.
  A title in quotes (`[SLIDE: "I've acquired 10 clinics..."]`) renders in italics.
- **`[ON SCREEN: text]`** adds a line to the current slide. Write lists with ` · ` between items, not as short sentences.
- **`[HOST: action]`** is a host-console action, shown on the run sheet and highlighted in the presenter window:
  `OPEN OFFER`, `CLOSE OFFER`, `POLL <id>`, `PIN <text>`, `SHOW TIMER`, `TAKE QUESTIONS`.
  The automated webinars also use room cues the player fires on its own: `SHOW CALCULATOR`, `SHOW BUY-IN`, `SHOW WORKSHEET`.
- **`[NOTE: text]`** is a direction for the presenter (read the chat, re-ask, what to skip). Notes starting with `RE-ASK` or `Read` also appear on the run sheet.
- **`[mm:ss]`** on its own line is a checkpoint: the clock resets to it (used by the recorded script to keep takes on time).

## Timing

Each slide and host cue gets an estimated time: the chapter's start time plus the spoken words before it at **140 words a minute**.
`words` and `minutes` count spoken words only. Set the chapter times to include live interaction (polls, reading the chat,
checkout pauses), so the presenter window's "ahead / behind" reads true.

## Copy rules, enforced by `test/materials.test.ts`

Every file is parsed and checked:

- every spoken paragraph passes `auditCopy` (`src/content/copy-rules.ts`), with no em dashes and never "free" next to a call;
- for `funnel: live` and `funnel: challenge`, slide titles, subtitles, on-screen lines and `PIN` texts pass `auditCopy` too;
- each file has a title, a funnel, a duration, chapters and slides (challenge files also need a `day`);
- `offer: deposit` files must contain a `[HOST: OPEN OFFER]` cue, say the guarantee word for word, and say each of its conditions out loud
  (kickoff and two years of financials within seven days, miss no more than two sessions, twenty-five owner contacts a week,
  reply within two business days, the buy box and the 1.5x test, the LOI definition, and that it doesn't promise financing);
- every file is listed in `MATERIAL_IDS` (`src/admin/materials.ts`), so Funnel HQ shows it. The challenge ids
  `challenge-day-1` to `challenge-day-5` are already listed and appear as soon as their files exist.

## The copies of existing scripts

`auto-webinar-ai.md` is a copy of `scripts/ai-webinar/script-ai.md` (the AI build reads that file, so edit it there and copy it
across), and `auto-webinar-recorded.md` is the recorded masterclass script, version 3, with its cues converted to this format.

## Presenting on Zoom

1. Open Funnel HQ → Materials, pick the script, press **Presenter window**. Keep this window on your own screen.
2. Press **Open slides window** in the presenter window (or **Present slides** in Funnel HQ), and share that window in Zoom.
   Press F inside it for full screen.
3. Move with →, space, Page Down or a clicker; ← or Page Up goes back; B (or .) blacks the screen; T switches the light and dark decks.
   Either window can drive: they stay in step.
4. Press **Start clock** (or S) when you go live. The bar shows the planned time of the current slide and whether you're ahead or behind;
   the yellow strip shows the next host cue, for example "At 47:54: OPEN OFFER".
5. **Deck as PDF** opens the print dialog with one 16:9 slide per page: choose "Save as PDF".
