# AI-edition masterclass

Builds the AI edition of the masterclass: Josh's method narrated by an AI voice (ElevenLabs stock voice "George", British,
disclosed in the opening and on every slide), pitching the First Deal Sprint from the first minute.
`script-ai-josh.md` is the first-person version for Josh's own cloned voice once his professional clone is trained
(run with `VOICE_ID=4VFizj5F8jBY7TGDsGjk` after swapping the script in).

1. Put the ElevenLabs API key in `scripts/ai-webinar/.key` (never committed). It's the same key as Funnel HQ → Integrations → Voice.
2. `python3 build.py --dry` builds everything with silent placeholder audio (no credit used).
3. `VOICE_SPEED=0.92 python3 build.py` renders the voice (about 21,000 characters; cached by text, so re-runs only pay for changed slides),
   the slides, the video and the HLS files in `public/assets/media/webinar/ai/`, and rewrites `src/webinar/edition-ai.ts`
   with the timeline measured from the real audio.
4. `npx vitest run test/webinar-editions.test.ts`, deploy, then set `WEBINAR_EDITION=ai` in Funnel HQ → Settings → Webinar.

Edit the words in `script-ai.md` (it must pass the copy audit), never the generated timeline.
