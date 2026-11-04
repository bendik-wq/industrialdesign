/**
 * Funnel HQ → Studio (/admin/studio): one page with three views.
 * - Record (builder A, public/assets/studio.js + studio-core.js + studio.css): a screen recorder that composes the
 *   screen and the face cam on a canvas in the browser, records it at the source's resolution and uploads 10 MiB
 *   parts to /admin/api/studio/uploads while recording.
 * - Radar (src/radar, /assets/studio-radar.js) mounts into #studio-radar: top performers through Monid, analysed for G&L.
 * - Pipeline and Scripts (builder C, /assets/studio-pipeline.js and /assets/studio-scripts.js) mount into
 *   #studio-pipeline and #studio-scripts.
 * Guests see the page read-only: the Record view says recording is for the owner, and every write is refused on the
 * server anyway (src/admin/guest.ts).
 */
import type { Context } from 'hono';
import type { AppEnv } from '../app';
import { isAdmin } from './auth';

/** The page's own scripts only; media from the camera, screen and recorder (blob:/mediastream:); a blob: worker ticks frames. */
export const STUDIO_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  // Radar: ad creatives play from the ad's own Meta CDN URL (never re-hosted).
  "media-src 'self' blob: mediastream: https://*.fbcdn.net",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  // Radar: the platform's own players (YouTube without cookies, TikTok's embed).
  "frame-src 'self' https://www.youtube-nocookie.com https://www.tiktok.com",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');
/** Camera, microphone and screen capture for this page only. */
export const STUDIO_PERMISSIONS = 'camera=(self), microphone=(self), display-capture=(self), geolocation=()';

export const STUDIO_COPY = {
  guest: 'Guest view: recording is for the owner. You can follow the pipeline and read the scripts.',
  unsupported: 'Recording works in desktop Chrome, Edge or Safari. On this device you can follow the pipeline and read the scripts.',
  noPipeline: 'The pipeline board is not in this build yet.',
  noScripts: 'The scripts view is not in this build yet.',
  noRadar: 'Radar is not in this build yet.',
};

const ICON = (body: string) => `<svg viewBox="0 0 20 20" aria-hidden="true">${body}</svg>`;
/** Small glyphs of each layout for the layout picker. */
const LAYOUT_ICONS: Record<string, string> = {
  orbit: ICON('<rect x="2" y="4" width="16" height="12" rx="2"/><circle cx="14.2" cy="12.4" r="2.4" class="f"/>'),
  split: ICON('<rect x="2" y="6" width="10.5" height="8" rx="1.6"/><rect x="13.5" y="4" width="4.5" height="12" rx="1.4" class="f"/>'),
  spotlight: ICON('<rect x="2" y="4" width="16" height="12" rx="2" class="f2"/><path d="M11 7.2 17 6v8l-6-1.2z"/>'),
  stage: ICON('<rect x="2" y="4" width="16" height="12" rx="2"/><rect x="3.6" y="11.2" width="5.6" height="3.4" rx="1" class="f"/>'),
  vertical: ICON('<rect x="6" y="2" width="8" height="16" rx="1.8"/><rect x="6" y="2" width="8" height="7.6" rx="1.8" class="f"/>'),
  cinema: ICON('<rect x="2" y="4" width="16" height="12" rx="2"/><path d="M2 6.6h16M2 13.4h16"/><rect x="13" y="10" width="3.4" height="2.4" rx=".6" class="f"/>'),
};
const LAYOUTS: [string, string, string][] = [
  ['orbit', 'Orbit', '1'], ['split', 'Split', '2'], ['spotlight', 'Spotlight', '3'], ['stage', 'Stage', '4'], ['vertical', 'Vertical', '5'], ['cinema', 'Cinema', '6'],
];

export function studioPage(opts: { guest: boolean }) {
  const layoutButtons = LAYOUTS.map(([id, label, key]) =>
    `<button type="button" class="st-lay" data-layout="${id}" aria-pressed="false" aria-keyshortcuts="${key}" title="${label} (${key})">${LAYOUT_ICONS[id]}<span>${label}</span><kbd>${key}</kbd></button>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Studio · Funnel HQ</title><meta name="robots" content="noindex"><meta name="color-scheme" content="light">
<link rel="icon" href="/assets/favicon.svg">
<link rel="stylesheet" href="/assets/glass.css"><link rel="stylesheet" href="/assets/studio.css"><link rel="stylesheet" href="/assets/studio-board.css"><link rel="stylesheet" href="/assets/studio-radar.css">
</head>
<body class="st"${opts.guest ? ' data-guest="1"' : ''}>
<header class="st-top glass-strong">
  <div class="st-left"><a class="st-back" href="/admin" aria-label="Back to Funnel HQ"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m12 4.5-5.5 5.5 5.5 5.5"/></svg><span>Funnel HQ</span></a>
  <p class="st-brand"><span class="st-mark" aria-hidden="true"></span>Studio</p></div>
  <nav class="st-seg" role="tablist" aria-label="Studio views">
    <button type="button" role="tab" data-view="record" aria-selected="true" aria-controls="studio-record">Record</button>
    <button type="button" role="tab" data-view="pipeline" aria-selected="false" aria-controls="studio-pipeline">Pipeline</button>
    <button type="button" role="tab" data-view="scripts" aria-selected="false" aria-controls="studio-scripts">Scripts</button>
    <button type="button" role="tab" data-view="radar" aria-selected="false" aria-controls="studio-radar">Radar</button>
    <i class="st-seg-thumb" aria-hidden="true"></i>
  </nav>
  <p class="st-status" data-status role="status" aria-live="polite"><i aria-hidden="true"></i><span>Ready</span></p>
</header>

<main class="st-main">
<section id="studio-record" class="st-view" data-viewpane="record" role="tabpanel" aria-label="Record">
  <p class="st-note" data-note hidden></p>
  <div class="st-recover" data-recover hidden></div>
  <div class="st-rec">
    <div class="st-col">
      <div class="st-titlebar">
        <label class="st-title"><span class="sr">Title</span><input type="text" data-title maxlength="140" placeholder="Untitled recording" autocomplete="off" spellcheck="true"></label>
        <p class="st-timer" data-timer aria-label="Recorded time">0:00</p>
      </div>
      <div class="st-prompter" data-prompter>
        <div class="st-pr-face" aria-hidden="true"><video data-selfview muted playsinline></video></div>
        <div class="st-pr-scroll" data-pr-scroll tabindex="-1"><div class="st-pr-text" data-pr-text></div></div>
        <div class="st-pr-tools">
          <button type="button" class="st-icon" data-pr-prev title="Previous beat (Up arrow)" aria-label="Previous beat"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 12.5 5-5 5 5"/></svg></button>
          <button type="button" class="st-icon" data-pr-next title="Next beat (Down arrow)" aria-label="Next beat"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 7.5 5 5 5-5"/></svg></button>
          <button type="button" class="st-icon" data-pr-pop title="Float the prompter above other windows" aria-label="Float the prompter" hidden><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="4" width="15" height="12" rx="2"/><rect x="10" y="9.5" width="6" height="5" rx="1" class="f"/></svg></button>
        </div>
      </div>
      <div class="st-stage" data-stage>
        <canvas data-canvas width="1920" height="1080" aria-label="Recording preview: exactly what is recorded"></canvas>
        <div class="st-drop" data-orbit-handle hidden aria-hidden="true"></div>
        <div class="st-count" data-count hidden aria-live="assertive"></div>
        <p class="st-recpill" data-recpill hidden><i aria-hidden="true"></i><span>REC</span></p>
        <p class="st-toast" data-toast role="status" aria-live="polite"></p>
      </div>
      <div class="st-dock glass" data-dock>
        <div class="st-lays" role="group" aria-label="Layout">${layoutButtons}</div>
        <div class="st-ctl">
          <button type="button" class="st-rec-btn" data-record aria-keyshortcuts="Control+Shift+R"><i aria-hidden="true"></i><span>Record</span></button>
          <button type="button" class="st-icon st-pause" data-pause hidden aria-keyshortcuts="Space" title="Pause (Space)" aria-label="Pause"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 5v10M12.5 5v10"/></svg></button>
          <button type="button" class="st-stop" data-stop hidden aria-keyshortcuts="Escape" title="Stop (Esc)"><i aria-hidden="true"></i><span>Stop</span></button>
        </div>
        <div class="st-marks" role="group" aria-label="Markers">
          <button type="button" class="st-chip" data-mark="chapter" aria-keyshortcuts="M" title="Chapter marker (M)" disabled>Chapter <kbd>M</kbd></button>
          <button type="button" class="st-chip" data-mark="retake" aria-keyshortcuts="R" title="The last sentence was bad: the edit cuts back to the previous marker (R)" disabled>Retake <kbd>R</kbd></button>
          <button type="button" class="st-chip" data-mark="highlight" aria-keyshortcuts="H" title="Highlight for a short (H)" disabled>Highlight <kbd>H</kbd></button>
          <button type="button" class="st-chip" data-zoom aria-keyshortcuts="Z" aria-pressed="false" title="Zoom 2x into the zoom area (Z)">Zoom <kbd>Z</kbd></button>
        </div>
      </div>
      <div class="st-upload" data-upload hidden>
        <div class="st-up-bar"><i data-up-fill></i></div>
        <p data-up-text></p>
      </div>
    </div>

    <aside class="st-side" aria-label="Recording settings">
      <section class="st-panel">
        <h2>Sources</h2>
        <button type="button" class="st-btn" data-pick-screen><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="3.5" width="15" height="10.5" rx="1.8"/><path d="M7 17h6M10 14v3"/></svg><span>Choose screen</span></button>
        <p class="st-sub" data-screen-info>Screen, window or tab. System audio comes along when the browser offers it.</p>
        <div class="st-cam">
          <video data-campreview muted playsinline aria-label="Camera preview"></video>
          <button type="button" class="st-btn st-cam-on" data-cam-on>Turn on camera and mic</button>
        </div>
        <label class="st-field"><span>Camera</span><select data-cam></select></label>
        <label class="st-field"><span>Microphone</span><select data-mic></select></label>
        <div class="st-meter" aria-label="Microphone level" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" data-meter-wrap><i data-meter></i></div>
        <label class="st-switch"><input type="checkbox" data-sysaudio checked><span>Include system audio</span></label>
      </section>
      <section class="st-panel">
        <h2>Look</h2>
        <div class="st-two">
          <label class="st-field"><span>Name</span><input type="text" data-name maxlength="60" autocomplete="off"></label>
          <label class="st-field"><span>Role</span><input type="text" data-role maxlength="80" autocomplete="off"></label>
        </div>
        <div class="st-row"><span class="st-lbl">Bubble</span><div class="st-mini-seg" role="group" aria-label="Bubble size" data-size><button type="button" data-v="s">S</button><button type="button" data-v="m">M</button><button type="button" data-v="l">L</button></div></div>
        <div class="st-row"><span class="st-lbl">Frame rate</span><div class="st-mini-seg" role="group" aria-label="Frame rate" data-fps><button type="button" data-v="30">30 fps</button><button type="button" data-v="60">60 fps</button></div></div>
        <label class="st-switch"><input type="checkbox" data-mirror checked><span>Mirror my self view</span></label>
        <label class="st-switch"><input type="checkbox" data-autolayout checked><span>Auto layout from the script</span></label>
      </section>
      <section class="st-panel">
        <h2>Zoom and vertical crop</h2>
        <div class="st-map" data-map><video data-mapvideo muted playsinline></video><div class="st-map-empty" data-map-empty>Choose a screen to set the areas</div><div class="st-box st-box-crop" data-box="crop" title="Vertical crop: drag to move"><span>Vertical</span></div><div class="st-box st-box-zoom" data-box="zoom" title="Zoom area: drag to move"><span>Zoom</span></div></div>
        <label class="st-field st-range"><span>Vertical crop width</span><input type="range" min="20" max="100" value="46" data-cropw></label>
      </section>
      <section class="st-panel">
        <h2>Prompter</h2>
        <label class="st-field st-range"><span>Speed</span><input type="range" min="0" max="60" value="14" data-pr-speed></label>
        <label class="st-field st-range"><span>Text size</span><input type="range" min="18" max="44" value="26" data-pr-size></label>
        <details class="st-notes"><summary>Paste notes instead</summary><textarea data-pr-notes rows="5" placeholder="One beat per paragraph"></textarea><button type="button" class="st-btn" data-pr-load>Use these notes</button></details>
      </section>
      <section class="st-panel">
        <h2>Markers</h2>
        <ol class="st-markers" data-markers><li class="st-empty">Markers you add while recording appear here.</li></ol>
      </section>
      <section class="st-panel st-keys">
        <h2>Keys</h2>
        <dl><dt>1 to 6</dt><dd>Layouts</dd><dt>Space</dt><dd>Pause or resume</dd><dt>M</dt><dd>Chapter</dd><dt>R</dt><dd>Retake the last sentence</dd><dt>H</dt><dd>Highlight for a short</dd><dt>Z</dt><dd>Zoom 2x</dd><dt>Up, Down</dt><dd>Prompter beats</dd><dt>Esc</dt><dd>Stop</dd></dl>
      </section>
    </aside>
  </div>
</section>
<section id="studio-pipeline" class="st-view" data-viewpane="pipeline" role="tabpanel" aria-label="Pipeline" hidden><p class="st-placeholder" data-placeholder="${STUDIO_COPY.noPipeline}">Loading the pipeline</p></section>
<section id="studio-scripts" class="st-view" data-viewpane="scripts" role="tabpanel" aria-label="Scripts" hidden><p class="st-placeholder" data-placeholder="${STUDIO_COPY.noScripts}">Loading the scripts</p></section>
<section id="studio-radar" class="st-view" data-viewpane="radar" role="tabpanel" aria-label="Radar" hidden><p class="st-placeholder" data-placeholder="${STUDIO_COPY.noRadar}">Loading Radar</p></section>
</main>
<div class="st-sheet-scrim" data-scrim hidden></div>
<div class="st-sheet glass-strong" data-sheet role="dialog" aria-modal="true" aria-labelledby="st-sheet-h" hidden></div>
<script src="/assets/studio-core.js"></script>
<script src="/assets/studio.js"></script>
<script type="module" src="/assets/studio-pipeline.js"></script>
<script type="module" src="/assets/studio-scripts.js"></script>
<script type="module" src="/assets/studio-radar.js"></script>
</body></html>`;
}

/** GET /admin/studio (behind requireAdmin, so the owner or a guest with a live link). */
export async function studioRoute(c: Context<AppEnv>) {
  const guest = !(await isAdmin(c));
  c.header('content-security-policy', STUDIO_CSP);
  c.header('permissions-policy', STUDIO_PERMISSIONS);
  c.header('cache-control', 'no-store');
  return c.html(studioPage({ guest }));
}
