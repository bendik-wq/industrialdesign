import { Config } from '@remotion/cli/config';
Config.setBrowserExecutable('/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell');
Config.setChromiumOpenGlRenderer('swangle');
Config.setCodec('h264');
Config.setCrf(26);
Config.setConcurrency(4);
