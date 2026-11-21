import fs from 'node:fs';
import {Config} from '@remotion/cli/config';

// Use a preinstalled Chromium when present (no Chrome download needed).
// Override with REMOTION_BROWSER=/path/to/chrome, or set it to "" to let Remotion manage its own.
const candidate = process.env.REMOTION_BROWSER ?? '/opt/pw-browsers/chromium';
if (candidate && fs.existsSync(candidate)) {
  Config.setBrowserExecutable(candidate);
  Config.setChromeMode('chrome-for-testing');
}

Config.setVideoImageFormat('jpeg');
Config.setJpegQuality(95);
Config.setCodec('h264');
Config.setCrf(16);
Config.setPixelFormat('yuv420p');
