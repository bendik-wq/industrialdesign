export type Word = {
  text: string;
  /** seconds */
  start: number;
  /** seconds */
  end: number;
  highlight?: boolean;
};

export type BeatKind = 'stat' | 'lowerThird' | 'cta';

export type Beat = {
  start: number;
  end: number;
  kind: BeatKind;
  /** Wrap parts in *asterisks* to paint them gold, e.g. "*+88%*" */
  title: string;
  sub?: string;
  footnote?: string;
};

export type AdProps = {
  /** file name inside public/, e.g. "clip.mp4" */
  videoSrc: string;
  words: Word[];
  beats?: Beat[];
  /** brand line used for the automatic lower third + CTA card */
  brand?: string;
  /** auto-add a lower third (1.0s to 4.0s) and a CTA (last 3s) when the beats list has none */
  autoBrandBeats?: boolean;
  /** CTA defaults used by the automatic CTA beat */
  ctaTitle?: string;
  ctaButton?: string;
  /** optional hard override of the composition length (seconds); default = video length */
  durationInSeconds?: number;
};

export const GOLD = '#E8C45C';
