# InfoCardReel: card-over-head Reels format

A vertical 9:16 (1080×1920) Instagram Reel or Short:
- **Top:** a white rounded info card. It has Josh's avatar and name, a dark label pill (DEAL BREAKDOWN, SELLER CHECKLIST, DUE DILIGENCE, NEWS…), a bold headline, label/value rows that pop in the moment Josh says them, and a small footnote.
- **Card position:** the card is 820px wide and floats with a gentle bob, overlapping the top edge of the video so it hovers just above Josh's head.
- **Bottom (y 700–1920):** Josh talking, cropped from the 4K footage, with word-by-word captions. The active word and highlighted keywords turn yellow.

Row tones: `bad` = red, `good` = green, none = ink.

## Make one
1. **Pick a 30–50s section** from a long-form, using the Whisper transcript (`openai-whisper`, base model, `word_timestamps=True`).
2. **Cut and crop it** to the bottom panel:
   ```
   ffmpeg -ss START -to END -i SOURCE_4K.mp4 \
     -vf "crop=1260:1423:1350:360,scale=1080:1220:flags=lanczos" \
     -af "loudnorm=I=-14:TP=-1.5:LRA=11" -c:v libx264 -crf 16 -pix_fmt yuv420p -c:a aac -b:a 192k \
     public/reel_NAME.mp4
   ```
   - The crop above suits the 30 Oct set (Josh centred at about x 1970).
   - Keep the crop clear of burnt-in captions.
3. **Write `props/reel_NAME.json`** with `videoSrc`, `avatarSrc`, `name`, `handle`, `durationInSeconds`, `card {kicker, title, rows[{label, value, at, tone}], footnote}` and `words[]`. Word times are relative to the cut.
   - Merge Whisper's split tokens ("-year", ".9", "%") into the previous word.
   - Fix mishearings by hand.
4. **Render:** `COMP=InfoCardReel ./render.sh props/reel_NAME.json ../out/reels/reel_NAME.mp4 --concurrency=2`

## Card rules
- Facts on the card must come from what Josh says in the clip, or from his verified deal facts.
- Examples in the video are labelled "Illustrative example" in the footnote.
- No platform badges (verified ticks etc.).
- No income claims.
- 4–5 rows maximum.

Examples: `props/reel_pe.json`, `props/reel_seller.json`, `props/reel_staff.json`.
