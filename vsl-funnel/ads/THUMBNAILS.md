# Format v5: Taki Moore-style system, applied to Josh

What Taki Moore's last 24 thumbnails have in common (studied Nov 2026):
- **A real cinematic frame**: Josh mid-gesture and expressive, in a real location. No studio cut-out look.
- **2–4 words of big hand-lettered marker caps** in white, placed in the empty part of the frame.
- **One accent colour** for the key word: warm yellow #FFC42E (a red X and green tick only for a before/after).
- **White hand-drawn doodles**: arrows, underlines, ticks and crosses. Sometimes whiteboard diagrams or a handwritten card held up.
- **Black-and-white grades** on some, with only the accent in colour.
- No boxes, no serif fonts, no logos.

v5 applies this to Josh with Caveat Brush (condensed marker caps) on his real 4K frames:
- `100m`: "$1M ✗ / ✓ $100M · BANKS PREFER IT", with Josh centred and gesturing.
- `zero`: "$0 DOWN · 2 COMPANIES. · 100% seller financed", with an arrow to Josh.
- `banker`: a B&W frame with "YOUR BANK / SAID NO? · here's why".

Run `render/thumbs/comp5.py NAME`. Outputs are `out/thumbs/v5_*`.

Upgrade for next time, in the Taki style: shoot Josh holding a real handwritten card or a whiteboard for the hook word. That is the strongest element in Taki's thumbnails and can't be faked well in post.

---

# Current format: v4 (v2 look, sharpened)

Bendik's verdict: v3 (lime, Unbounded) looked cheap and was rejected; the v2 navy-and-gold scribble look is the direction. v4 changes from v2:
- **Crop**: 1.25× instead of 1.5×, so the face is barely upscaled and stays crisp at 4K. Face sharpening is a large-radius clarity pass plus a fine unsharp mask.
- **Background**: darkened by about 22% for stronger separation from Josh.
- **Pen strokes**: about 1.5× heavier, with no glow, just a tight shadow.
- **Type**: headline type and the handwritten note are rendered at 2× and downsampled for razor edges.
- **Captions**: `clean.py` also removes the bottom subtitle band.

Run `render/thumbs/comp.py 100m zero banker`. It writes `v4_<name>_gold.png`. Set `SCRIB = 'white'` for white pen strokes.

---

# Rejected: format v3: "Purple cow"

The business-YouTube feed is navy, gold, red arrows and yellow Impact text, so v3 is built to be the one thumbnail that looks different in it, using Mr Beast-style click principles without copying his look:

- **One focal idea, 2–3 big words.** Everything else is small and supporting.
- **Pattern interrupt colour**: the set is graded to black and white, Josh stays in full colour, and there is one accent of **electric acid lime #CCFF2E**. Nobody in finance uses it, and it pops on both YouTube's dark and light UI.
- **A story object** that makes the idea concrete at a glance: a white loan slip stamped DECLINED next to "$100M APPROVED". The contrast is the curiosity gap.
- **Sharp type**:
  - Unbounded Black (wide, geometric, razor-edged) for the hook, set black on a lime block or white with a hard shadow.
  - IBM Plex Mono for labels, giving a term-sheet / bank-terminal feel.
  - No glow; everything is rendered at 2× and downsampled for crisp edges.
- **Real face**: Josh's actual 4K frame, sharpened, with a saturation and contrast lift. Expressive mid-sentence moments work best.

Script: `render/thumbs/comp3.py NAME` (it uses `comp.py` for the plate and mask). Fonts: Unbounded and IBM Plex Mono from github.com/google/fonts.

Outputs (`out/thumbs/`, gitignored): `v3_100m_loan`, `v3_zero_down`, `v3_banker_no`.

## Nano Banana upgrade (run when the VidLab key limit is raised)
Feed the finished v3 PNG to `nano-banana-pro` (`resolution: 4k`, `aspect_ratio: 16:9`), turning the flat props into real objects while the face is locked:

> Edit this image. Do NOT change the man's face, hair, expression or any text. Replace the flat white loan slip with a photoreal crumpled paper bank loan application lying at a slight angle with a real red rubber-stamp "DECLINED" impression, soft shadow, shallow depth of field. Keep the black-and-white background and the lime blocks exactly as they are.

After generating, paste the original face region back over the result through the mask if the model drifts the face.

---

# Previous: format v2: "Real frame, navy and gold annotated"

Built on a real 4K frame from the video itself: Josh's actual face and the actual set, never AI-generated. Everything premium is layered on top.

## The look
- **Plate**: a 4K frame from the episode where Josh is looking into the lens mid-sentence (an expressive moment beats a posed one). Crop at 1.5× so he sits on the right third.
- **Background**: the real set, kept recognisable (here the Pilates studio with its stairs and glass). It gets:
  - a light blur for depth;
  - a cinematic grade with teal shadows and warm highlights;
  - a highlight bloom and a warm window light leak;
  - a navy fade on the left so the type sits on it.
- **Josh**: cut out with segmentation and kept sharp, with a contrast lift, a warm key on the face and a gold rim light on the left edge. Burnt-in captions are inpainted out of the frame first.
- **Type**: Playfair Display with lining numerals.
  - The hook word or number is in metallic gold (a vertical gradient with a soft glow).
  - Support lines are ivory, in italic.
- **Handwriting**: Homemade Apple, set like a fountain-pen note.
- **Pen strokes**: drawn procedurally in gold, with tapered, slightly wobbly marks:
  - a circle around the hook;
  - a strike-through for contrast;
  - a double underline;
  - an arrow toward his face, only when there is room.
- No logos or wordmarks, and a subtle film grain over everything.

## Headline rules
- 2–5 words, with a number or a contrast ($100M vs ~~$1M~~, $0 down).
- Real proof only: two acquisitions, both 100% seller financed.
- Never repeat the video title.

## How to make one
Scripts are in `render/thumbs/`:
- `clean.py`: inpaints burnt-in captions out of `base_<t>.png`.
- `comp.py`: the compositor. Each thumbnail is one `cfg_*` function (text lines, pen strokes, note), plus a frame time in `T`.

Steps:
1. Grab the frame: `ffmpeg -ss <sec> -i episode.mp4 -frames:v 1 base_<sec>.png`
2. Make the mask: rembg `isnet-general-use` on the 1920px downscale → `mask_<sec>.png`. The 4K BiRefNet model runs out of memory here.
3. Run `python3 clean.py <sec>`, then `python3 comp.py <name>`.
4. Fonts come from github.com/google/fonts (OFL/Apache): Playfair Display (+Italic) and Homemade Apple.
5. Export a 3840×2160 PNG master and a JPEG under 2 MB for YouTube.

`D` in `comp.py` points at the working folder holding the frames, masks and fonts. Change it for a new machine.

## Made so far
`out/thumbs/` (gitignored):
- `100m_loan`: "$100M is easier to borrow than ~~$1M~~"
- `zero_down`: "$0 down. Two companies."
- `banker_no`: "Your banker said no?"
