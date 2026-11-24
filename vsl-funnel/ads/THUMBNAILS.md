# Josh Li YouTube thumbnail format: "Navy & Gold Annotated"

Premium 4K format for the G&L channel. Generated with Nano Banana Pro (VidLab `nano-banana-pro`, `resolution: 4k`, `aspect_ratio: 16:9`, about $0.08 each), using a sharp frame of Josh from the 4K source footage as the reference image.

## Why this palette
Deep midnight navy (#0B1630) and warm metallic gold (#D4A853), with ivory (#F5EFE4) text.
- It matches the brand already in Josh's edits: navy marble, serif type, gold underline scribbles.
- Navy and gold read as private banking and old money, the opposite of the red/yellow "YouTube guru" look that dominates the business niche, so the thumbnail stands out in the feed.
- Gold on navy keeps strong contrast at small sizes and on mobile.

## Layout (every thumbnail)
1. **Josh on the right third**: cut out, mid-chest up, about 70% of frame height, looking into the camera, warm key light and a thin gold rim light. No room background. No hands.
2. **Headline on the left**: 2–5 words in a high-contrast serif (Playfair-style). One word or number is in gold and/or italic. That word is the hook.
3. **Gold scribble annotations (the click triggers)**:
   - a hand-drawn circle around the key number;
   - a curved arrow pulling the eye from the text to Josh's face;
   - an underline or a strike-through that creates contrast (e.g. "$1M" crossed out);
   - a small handwritten note of 2–4 words that teases the payoff ("banks want this", "100% seller financed").
4. **"G&L" wordmark** bottom-left in a thin gold serif.
5. Lots of negative space. Nothing else: no logos, emojis or extra text.

## Headline rules
- Use a number or a contrast where possible ($100M vs $1M, $0 down).
- Keep it true. Only use real proof: two acquisitions, both 100% seller financed. No invented figures.
- Never repeat the video title. The thumbnail is the tension, and the title is the explanation.

## Prompt template
See `out/thumbs/p1.txt` (gitignored) or copy the block below and swap the TEXT and SCRIBBLE sections.

```
Ultra-premium 4K YouTube thumbnail, 16:9, for a business channel about buying companies. Editorial, clean, expensive, like a luxury finance magazine cover crossed with a hand-annotated whiteboard.

SUBJECT: the man in the reference image (keep his exact face, hair and identity), cut out cleanly and placed on the RIGHT third, framed from mid-chest up, large, filling about 70% of the frame height, <EXPRESSION>. Black crew-neck t-shirt. Soft warm key light from the left, thin warm gold rim light on hair and shoulder, crisp skin detail, razor sharp eyes. No hands visible.

BACKGROUND: deep midnight navy (#0B1630) with a subtle dark marble swirl texture and a soft vignette, a faint warm glow behind his head. No room, no furniture.

TEXT on the LEFT, exactly these words and nothing else:
<LINES, each with font: ivory serif / huge gold serif italic>

SCRIBBLE ANNOTATIONS in warm gold felt-marker / fountain-pen style, slightly imperfect confident strokes: <circle around X>, <curved arrow toward his face>, <underline / strike-through>. Small handwritten gold note beside the arrow: "<2-4 words>".

Small refined wordmark bottom-left in thin gold serif: "G&L".
Style: minimal, lots of negative space, high contrast, premium, cinematic grade, no clutter, no extra text, no logos, no emojis, no watermarks. All text perfectly spelled.
```

## Export
- Master: 3840×2160 PNG.
- Upload: 3840×2160 JPEG under 2 MB (YouTube's limit).
- QA: check every letter of the generated text before uploading. The model sometimes misspells.

## Made so far
- `100m_loan`: "$100M is easier than ~~$1M~~", for "Why It's Actually Easier To Get A $100M Loan…"
- `zero_down`: "$0 down / 2 businesses.", for "I Bought Multiple Businesses With No Money Down…"
- `banker_no` (prompt ready in p3, not generated yet: VidLab key limit): "Your banker said no?"
