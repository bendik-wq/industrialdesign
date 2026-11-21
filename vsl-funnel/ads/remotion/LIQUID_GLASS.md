# Liquid Glass: what it is and how this template fakes it

Apple's material from WWDC25 (iOS 26, iPadOS 26, macOS Tahoe 26, watchOS 26, tvOS 26).
These notes are in my own words. Sources are listed at the bottom. The technology overview
and HIG Materials pages on developer.apple.com only returned their titles to the fetch tool
(they render client-side), so the principles below come mainly from the WWDC25 session
"Meet Liquid Glass" (219) and the June 2025 newsroom post.

## Principles

1. **Lensing, not just blur.** The defining trait. Old materials blurred and scattered what was
   behind them. Liquid Glass bends and concentrates light, so content behind it stays
   recognisable but warps toward the curved rim. That is what separates it from the content
   while keeping it light and see-through. A plain grey frosted rectangle is the failure case.
2. **Specular highlights that move.** Light sources in the scene put highlights on the rim. They
   follow the shape's geometry and slide across the surface as things move or the device tilts.
   The bright rim is also what outlines the shape.
3. **Adaptive appearance.** The material adjusts to what is underneath. Shadows get stronger over
   busy or text-heavy content and weaker over plain light backgrounds. Glyphs on top flip between
   light and dark to stay legible. The **Regular** variant adapts. The **Clear** variant is more
   transparent, does not adapt, needs a dimming layer, and is only for bold content over rich
   media. Never mix the two.
4. **Selective tint.** Colour is mapped to the brightness of what's underneath, like real stained
   glass. Use it only to mark the primary action, not on every element.
5. **Soft depth.** The glass floats as a separate functional layer above the content, with a soft
   ambient shadow and a faint glow from inside when pressed.
6. **Capsules and concentric shapes.** Pills and capsules, with corner radii that nest inside the
   device or window corners.
7. **Fluid, gel-like motion.** Controls flex and light up when touched. Shapes morph between states
   instead of cutting, menus grow out of the button that opened them, and springs overshoot a
   little and settle like a droplet.
8. **Minimal chrome.** The content comes first. Glass sits only where there is a control or a
   message, and the tab bar shrinks away while you scroll.

## Implementation in Remotion (headless Chromium)

All of this lives in `src/glass/Glass.tsx` and `src/glass/lensMap.ts`.

| Principle | How it's built |
|---|---|
| Frosting | `backdrop-filter: blur(5 to 12px) url(#lens) saturate(1.7 to 2) brightness(.86 to .92)`. The blur is kept light so the lensing stays visible. |
| Lensing / refraction | `lensMap.ts` draws a per-size **displacement map** on a canvas. It uses a signed-distance field of the rounded rect. Inside a bezel band (26 to 58px) the offset follows a circular convex profile along the edge normal (R = x offset, G = y offset, 128 = none), and the flat centre is neutral. An SVG `<feImage>` feeds it to `<feDisplacementMap scale=40..120>`, and that filter is used through `backdrop-filter: url(#id)`. Sampling *inward* (`lensDirection=-1`) works best in Chromium. Outward sampling reads outside the backdrop and loses the effect. |
| Dispersion | The displacement runs three times at scale ×1, ×0.9 and ×0.8. Each pass is masked to R, G or B with `feColorMatrix` and they are combined with `feBlend mode=screen`. This gives a faint colour fringe at the rim, like real glass edges. |
| Adaptive contrast | An `feComponentTransfer` table `0 .5 cap` (cap ≈ .8 to .86) compresses only the bright part of the backdrop. Bright scenes are dimmed and dark ones left alone, so white text stays legible on both. On top of that sits a radial dark tint that is densest behind the text. The gold button turns this off (`highlightCap=1`). |
| Specular rim | A 2px gradient border (`mask-composite: exclude`) whose angle follows `lightAngle`, bright on the key-light side and on the opposite corner. It has a blurred 5px duplicate for bloom, plus inset highlights (`inset 0 1.5px .5px #fff8c`, and `inset ±3px ±4px 8px -3px` bevels). |
| Highlights that move | `lightAngle` is driven by the frame (a slow sine) and by the morph velocity, so the rim highlight and the radial hotspot slide while things move. |
| Sheen sweep | A rotated band, transparent to 42% white to transparent, with `mix-blend-mode: screen`. It is translated across the card over about 26 frames when the card enters, and again before it exits. The CTA button repeats it on a loop. |
| Depth shadow | `0 18px 44px -10px rgba(0,0,0,.42)` + `0 3px 10px rgba(0,0,0,.16)`; the gold button also gets a warm glow. |
| Capsules | `radius = height/2` by default; cards use 64 to 72px. |
| Gel morph | The caption capsule width springs between word groups (`damping 13, stiffness 190, mass .85`, slightly underdamped). Height counter-squashes in proportion to the overshoot (±12%). The lower third grows from a round bead into a pill. |
| Entrances | Cards rise with `spring({damping 14, stiffness 150, mass .9})` from +260px and scale .86, with a vertical stretch that settles. Exits use `damping 20, stiffness 220`. Active words pop with `damping 9, stiffness 260, mass .55`. |
| Punch-in | The video scale toggles 1.00 and 1.06 on each stat/CTA beat (`damping 200`, 14 frames, no overshoot), plus a slow 4% push during the CTA. |

### Chromium gotchas
- **Backdrop root:** `opacity < 1`, `filter`, `mask`, `clip-path` or `mix-blend-mode` on an
  *ancestor* of a glass element makes it refract nothing. Animate `transform` on wrappers and pass
  opacity into `<Glass opacity>` (which sets it on the glass element itself). Nested glass (the CTA
  button) only sees its parent panel, which is fine for a tinted button.
- The filter id includes the element size, so Chromium never re-uses a stale lens map while the
  width animates. Maps are cached per size.
- `feImage` with a PNG data URL works in backdrop filters, both in Chrome and in Remotion's headless render.

## Sources
- Apple Developer, Liquid Glass technology overview: https://developer.apple.com/documentation/technologyoverviews/liquid-glass (title only, page did not render for the fetcher)
- Apple HIG, Materials: https://developer.apple.com/design/human-interface-guidelines/materials (title only, same issue)
- WWDC25 session 219 "Meet Liquid Glass": https://developer.apple.com/videos/play/wwdc2025/219
- Apple Newsroom, "Apple introduces a delightful and elegant new software design" (9 June 2025): https://www.apple.com/newsroom/2025/06/apple-introduces-a-delightful-and-elegant-new-software-design/
- Web technique references found by search, but blocked by this container's network, so not read in full: https://blog.logrocket.com/how-create-liquid-glass-effects-css-and-svg/, https://webdesign.tutsplus.com/liquid-glass-effect-svg-filters--cms-109200t, https://dev.to/devyatov/liquid-glass-on-the-web-6-ways-to-build-it-with-css-and-svg-3m07. The common recipe they describe is `feTurbulence`/displacement map → `feDisplacementMap` inside `backdrop-filter: url()`, which works in Chromium only, plus rim-light layers. Here the noise map is replaced by an SDF lens map for a cleaner, lens-like edge.
