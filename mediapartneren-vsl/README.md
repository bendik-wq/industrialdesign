# Mediapartneren VSL (Remotion)

Kinetic-text VSL in the Midnight style (#02070A, #0297DE, #FC734D, Archivo + Geist Mono).
The narration that goes with it is in `../mediapartneren/vsl-manus.html`.

```
npm install
npm run studio     # edit and preview in the browser
npm run render     # writes out/vsl.mp4 (1920x1080, 30 fps, ~2:19)
```

Scenes and timing live in `src/Video.tsx` (`TIMELINE`), visuals in `src/scenes.tsx`.
Fill in `[Navn]` and `[X]` in `src/Video.tsx` before publishing.
After rendering, copy `out/vsl.mp4` to `../mediapartneren/media/vsl.mp4`.
