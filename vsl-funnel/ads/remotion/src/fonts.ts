import {loadFont as loadInterTight} from '@remotion/google-fonts/InterTight';
import {loadFont as loadInter} from '@remotion/google-fonts/Inter';

const display = loadInterTight('normal', {weights: ['700', '800', '900'], subsets: ['latin']});
const text = loadInter('normal', {weights: ['500', '600', '700'], subsets: ['latin']});

export const DISPLAY_FONT = display.fontFamily;
export const TEXT_FONT = text.fontFamily;

export const fontsReady = Promise.all([display.waitUntilDone(), text.waitUntilDone()]);
