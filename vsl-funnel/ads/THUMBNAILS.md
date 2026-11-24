# Josh Li YouTube thumbnail format v2: "Real frame, navy and gold annotated"

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
