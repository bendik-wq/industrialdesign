# Liquid Glass UGC ad template (Remotion)

This template wraps a vertical talking-head clip (1080x1920, 30 fps) in Apple-style Liquid Glass:
- glass caption capsule at 62% height
- stat cards
- a brand lower third
- a CTA end card

The composition length comes from the video. Everything is driven by props, so a new clip needs no code change.
Design notes: [LIQUID_GLASS.md](LIQUID_GLASS.md).

## Setup
```bash
npm ci
npm run studio        # live preview (uses /opt/pw-browsers/chromium if present)
```

## Render
```bash
cp /path/to/final_clip.mp4 public/clip.mp4
./render.sh props/my-ad.json out/my-ad.mp4
# extra Remotion flags pass straight through, e.g. first 12 s only:
./render.sh props/test.json out/test.mp4 --frames=0-359
```
`render.sh` uses `/opt/pw-browsers/chromium` when it exists. Override it with
`REMOTION_BROWSER=/path/to/chrome`, or set `REMOTION_BROWSER=` (empty) to let Remotion download its own browser.
Fonts (Inter Tight and Inter) load from Google Fonts at render time.

## Props format
```jsonc
{
  "videoSrc": "clip.mp4",            // file inside public/
  "words": [                          // word timings in seconds (e.g. from Whisper word timestamps)
    {"text": "Doing", "start": 0.40, "end": 0.62},
    {"text": "$1M+", "start": 0.62, "end": 1.05, "highlight": true}   // highlight = gold
  ],
  "beats": [                          // optional
    {"kind": "stat", "start": 5.4, "end": 10.2,
     "title": "*+88%*", "sub": "HVAC add-on deals (Jan to May 2025)", "footnote": "Illustrative"},
    {"kind": "stat", "start": 14, "end": 18, "title": "Bought at *4x* → valued at *8-12x*"},
    {"kind": "stat", "start": 22, "end": 26, "title": "5 × $1M profit → *$40M* group", "footnote": "Illustrative"},
    {"kind": "lowerThird", "start": 1, "end": 4, "title": "G&L M&A Advisory"},
    {"kind": "cta", "start": 59.2, "end": 62.2, "title": "Doing *$1M+* a year?", "sub": "Apply below", "footnote": "G&L M&A Advisory"}
  ],
  "brand": "G&L M&A Advisory",        // optional, used by the automatic beats
  "autoBrandBeats": true,             // default true: adds lowerThird 1-4 s and CTA (last 3 s) if missing
  "ctaTitle": "Doing *$1M+* a year?", // optional defaults for the automatic CTA
  "ctaButton": "Apply below",
  "durationInSeconds": 30             // optional override; default = video duration
}
```
- Wrap text in `*asterisks*` in `title`/`sub` to paint it gold (#E8C45C).
- Captions are grouped automatically into 2 to 4 words, using pauses (>0.32 s), punctuation and length (≤20 chars).
  They hide when the CTA starts.
- Stat beat: `title` is the big number line, `sub` is the description, `footnote` is the small uppercase note.
- CTA beat: `title` is the headline, `sub` is the button label, `footnote` is the brand line.
- Placement: stat cards sit in the upper-middle (about 34%), captions at 62%, the lower third at about 73.5%.
  Nothing is drawn in the top 20% of the frame.

## Files
- `src/LiquidGlassAd.tsx`: composition (video, punch-in zoom, vignette, beat sequencing)
- `src/glass/Glass.tsx`, `src/glass/lensMap.ts`: the glass material (refraction, rim light, sheen)
- `src/components/*`: Captions, StatCard, LowerThird, CtaCard
- `props/test.json`: the 12 s test props used with the stand-in clip (`public/standin.mp4`, not committed)
