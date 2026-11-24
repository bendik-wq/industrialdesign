import React, {useMemo} from 'react';
import {interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {measureText} from '@remotion/layout-utils';
import {Glass} from '../glass/Glass';
import {DISPLAY_FONT} from '../fonts';
import {groupWords} from '../groupWords';
import {useFontsReady} from '../useFontsReady';
import {GOLD, type Word} from '../types';

const FONT_SIZE = 78;
const WEIGHT = '800';
const LETTER = '-0.02em';
const GAP = 0.3; // em between words (must exceed the active-word pop overhang)
const PAD_X = 54;
const HEIGHT = 136;
const MAX_W = 980;
const MIN_W = HEIGHT; // a round droplet when empty
const CENTER_Y = 0.62; // fraction of frame height

/** gel spring: quick, slightly under-damped so width overshoots and settles */
const GEL = {damping: 13, stiffness: 190, mass: 0.85};

export const Captions: React.FC<{words: Word[]; hideFrom?: number; centerY?: number}> = ({words, hideFrom, centerY = CENTER_Y}) => {
  const frame = useCurrentFrame();
  const {fps, width: frameW, height: frameH} = useVideoConfig();
  const ready = useFontsReady();
  const t = frame / fps;

  const groups = useMemo(() => groupWords(words), [words]);

  const layout = useMemo(() => {
    if (!ready) return null;
    return groups.map((g) => {
      const measure = (size: number) =>
        g.words.map((w) =>
          measureText({text: w.text, fontFamily: DISPLAY_FONT, fontSize: size, fontWeight: WEIGHT, letterSpacing: LETTER}).width,
        );
      let size = FONT_SIZE;
      let ws = measure(size);
      const total = (arr: number[], s: number) => arr.reduce((a, b) => a + b, 0) + s * GAP * (arr.length - 1);
      while (total(ws, size) + PAD_X * 2 > MAX_W && size > 48) {
        size -= 2;
        ws = measure(size);
      }
      return {fontSize: size, width: Math.min(MAX_W, total(ws, size) + PAD_X * 2)};
    });
  }, [groups, ready]);

  if (!layout || groups.length === 0) return null;
  if (hideFrom !== undefined && frame >= hideFrom + 12) return null;

  // current group (last one that has started and not yet hidden)
  let gi = -1;
  for (let i = 0; i < groups.length; i++) {
    if (t >= groups[i].start && t < groups[i].hide) gi = i;
  }
  // most recent group that has started (for exit animation)
  let lastStarted = -1;
  for (let i = 0; i < groups.length; i++) if (t >= groups[i].start) lastStarted = i;

  const visible = gi >= 0;
  const ref = gi >= 0 ? gi : lastStarted;
  if (ref < 0) return null;

  const g = groups[ref];
  const startF = Math.round(g.start * fps);
  const hideF = Math.round(g.hide * fps);

  // capsule presence: blob in at a group that follows a gap, blob out after the last word
  const prev = groups[ref - 1];
  const contiguous = prev && Math.abs(prev.hide - g.start) < 1e-3;
  const appearF = contiguous ? findChainStart(groups, ref, fps) : startF;
  const inP = spring({frame: frame - appearF, fps, config: {damping: 14, stiffness: 160, mass: 0.9}});
  const outP = visible ? 0 : spring({frame: frame - hideF, fps, config: {damping: 20, stiffness: 220}});
  const ctaOut = hideFrom !== undefined ? spring({frame: frame - hideFrom, fps, config: {damping: 20, stiffness: 200}}) : 0;
  const presence = Math.max(0, Math.min(1.2, inP) - outP - ctaOut);
  if (presence <= 0.001 && !visible) return null;

  // gel width morph between groups
  const target = layout[ref].width;
  const from = contiguous ? layout[ref - 1].width : MIN_W;
  const p = spring({frame: frame - startF, fps, config: GEL});
  let w = from + (target - from) * p;
  // scale the whole droplet in/out from a small bead
  w = MIN_W + (w - MIN_W) * Math.min(1, presence);
  // squash & stretch: wider than target → slightly thinner, narrower → slightly taller
  const stretch = (w - target) / target;
  const h = HEIGHT * (1 - Math.max(-0.12, Math.min(0.12, stretch * 0.9)));
  const scale = interpolate(presence, [0, 1], [0.55, 1], {extrapolateRight: 'clamp'});

  const cx = frameW / 2;
  const cy = frameH * centerY;
  // light slowly orbits so the rim highlight "moves" with the content
  const lightAngle = -40 + Math.sin(frame / 38) * 22 + (w - target) * 0.08;

  return (
    <div
      style={{
        position: 'absolute',
        left: cx - w / 2,
        top: cy - h / 2,
        width: w,
        height: h,
        transform: `scale(${scale})`,
      }}
    >
      <Glass
        width={w}
        height={h}
        bezel={40}
        refraction={90}
        blur={7}
        saturate={1.9}
        brightness={0.9}
        tint="radial-gradient(ellipse 80% 70% at 50% 50%, rgba(10,10,16,0.30), rgba(10,10,16,0.12))"
        lightAngle={lightAngle}
        opacity={Math.min(1, presence * 1.4)}
        glow={Math.max(0, 1 - p) * 0.8}
      >
        <GroupText
          words={g.words}
          fontSize={layout[ref].fontSize}
          t={t}
          frame={frame}
          fps={fps}
          startF={startF}
          width={w}
          height={h}
        />
      </Glass>
    </div>
  );
};

const findChainStart = (groups: ReturnType<typeof groupWords>, i: number, fps: number) => {
  let j = i;
  while (j > 0 && Math.abs(groups[j - 1].hide - groups[j].start) < 1e-3) j--;
  return Math.round(groups[j].start * fps);
};

const GroupText: React.FC<{
  words: Word[];
  fontSize: number;
  t: number;
  frame: number;
  fps: number;
  startF: number;
  width: number;
  height: number;
}> = ({words, fontSize, t, frame, fps, startF, width, height}) => {
  const enter = spring({frame: frame - startF, fps, config: {damping: 18, stiffness: 240, mass: 0.7}});
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: `${GAP}em`,
        fontFamily: DISPLAY_FONT,
        fontWeight: 800,
        fontSize,
        letterSpacing: LETTER,
        lineHeight: 1,
        whiteSpace: 'nowrap',
        width,
        height,
        opacity: enter,
        transform: `translateY(${(1 - enter) * 16}px)`,
        filter: `blur(${(1 - Math.min(1, enter)) * 6}px)`,
      }}
    >
      {words.map((w, i) => {
        const sF = Math.round(w.start * fps);
        const eF = Math.round(w.end * fps);
        const on = spring({frame: frame - sF, fps, config: {damping: 9, stiffness: 260, mass: 0.55}});
        const off = spring({frame: frame - eF, fps, config: {damping: 16, stiffness: 200}});
        const active = Math.max(0, on - off);
        const spoken = t >= w.start;
        const color = w.highlight ? GOLD : '#FFFFFF';
        return (
          <span
            key={i}
            style={{
              display: 'inline-block',
              color,
              opacity: spoken ? 1 : 0.5,
              transform: `translateY(${-active * 4}px) scale(${1 + active * 0.06})`,
              textShadow: w.highlight
                ? `0 0 ${18 * active}px rgba(232,196,92,${0.55 * active}), 0 2px 8px rgba(0,0,0,0.25)`
                : '0 2px 8px rgba(0,0,0,0.28)',
            }}
          >
            {w.text}
          </span>
        );
      })}
    </div>
  );
};
