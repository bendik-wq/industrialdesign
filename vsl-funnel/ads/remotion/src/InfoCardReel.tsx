import React, {useMemo} from 'react';
import {AbsoluteFill, Img, OffthreadVideo, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {DISPLAY_FONT, TEXT_FONT} from './fonts';
import {useFontsReady} from './useFontsReady';
import {groupWords} from './groupWords';
import type {Word} from './types';

export type CardRow = {
  label: string;
  value: string;
  /** seconds: when the row pops in (time Josh says it) */
  at?: number;
  tone?: 'bad' | 'good';
};

export type InfoCard = {
  kicker: string;
  title: string;
  rows: CardRow[];
  footnote?: string;
};

export type InfoCardReelProps = {
  videoSrc: string;
  avatarSrc?: string;
  name: string;
  handle?: string;
  card: InfoCard;
  words: Word[];
  durationInSeconds?: number;
};

const W = 1080;
const VIDEO_TOP = 700; // video panel occupies 700..1920
const CARD_BOTTOM = 760; // card floats over the top edge of the video
const BG = '#0D0E12';
const INK = '#111216';
const MUTED = '#6B6F78';
const BAD = '#E5484D';
const GOOD = '#18A957';
const HIGHLIGHT = '#FFD43B';

const Row: React.FC<{row: CardRow; first: boolean}> = ({row, first}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const s = spring({frame: frame - Math.round((row.at ?? 0) * fps), fps, config: {damping: 16, stiffness: 170}});
  const color = row.tone === 'bad' ? BAD : row.tone === 'good' ? GOOD : INK;
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        gap: 24,
        padding: '12px 0',
        borderTop: first ? 'none' : '1.5px solid #ECECE8',
        opacity: s,
        transform: `translateY(${(1 - s) * 18}px)`,
      }}
    >
      <div style={{fontFamily: TEXT_FONT, fontWeight: 600, fontSize: 24, color: MUTED, whiteSpace: 'nowrap'}}>{row.label}</div>
      <div style={{fontFamily: DISPLAY_FONT, fontWeight: 800, fontSize: 29, color, textAlign: 'right', lineHeight: 1.15}}>{row.value}</div>
    </div>
  );
};

const Card: React.FC<{p: InfoCardReelProps}> = ({p}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const s = spring({frame: frame - 3, fps, config: {damping: 14, stiffness: 120}});
  return (
    <div
      style={{
        position: 'absolute',
        left: (W - 820) / 2,
        width: 820,
        bottom: 1920 - CARD_BOTTOM,
        background: '#FBFBF8',
        borderRadius: 36,
        padding: '28px 34px 22px',
        boxShadow: '0 40px 90px rgba(0,0,0,0.6), 0 12px 24px rgba(0,0,0,0.35)',
        transform: `translateY(${(1 - s) * 60 + Math.sin(frame / 22) * 7}px) rotate(${Math.sin(frame / 37) * 0.6}deg) scale(${0.94 + 0.06 * s})`,
        opacity: s,
        transformOrigin: '50% 100%',
      }}
    >
      {/* header */}
      <div style={{display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16}}>
        {p.avatarSrc ? (
          <Img src={staticFile(p.avatarSrc)} style={{width: 60, height: 60, borderRadius: 999, objectFit: 'cover'}} />
        ) : null}
        <div style={{flex: 1}}>
          <div style={{fontFamily: DISPLAY_FONT, fontWeight: 800, fontSize: 28, color: INK, }}>
            {p.name}
          </div>
          {p.handle ? <div style={{fontFamily: TEXT_FONT, fontWeight: 500, fontSize: 21, color: MUTED}}>{p.handle}</div> : null}
        </div>
        <div style={{fontFamily: TEXT_FONT, fontWeight: 700, fontSize: 17, letterSpacing: 1.5, color: '#fff', background: INK, borderRadius: 999, padding: '8px 14px'}}>
          {p.card.kicker}
        </div>
      </div>
      {/* title */}
      <div style={{fontFamily: DISPLAY_FONT, fontWeight: 900, fontSize: 42, lineHeight: 1.06, color: INK, letterSpacing: -0.8, marginBottom: 8}}>
        {p.card.title}
      </div>
      {/* rows */}
      <div>
        {p.card.rows.map((r, i) => (
          <Row key={i} row={r} first={i === 0} />
        ))}
      </div>
      {p.card.footnote ? (
        <div style={{fontFamily: TEXT_FONT, fontWeight: 500, fontSize: 16, color: '#9A9DA4', marginTop: 8}}>{p.card.footnote}</div>
      ) : null}
    </div>
  );
};

const Captions: React.FC<{words: Word[]}> = ({words}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const t = frame / fps;
  const groups = useMemo(() => groupWords(words), [words]);
  const g = groups.find((x) => t >= x.start && t < x.hide);
  if (!g) return null;
  const pop = spring({frame: frame - Math.round(g.start * fps), fps, config: {damping: 13, stiffness: 220}});
  return (
    <div
      style={{
        position: 'absolute',
        left: 40,
        right: 40,
        top: 1560,
        textAlign: 'center',
        transform: `scale(${0.85 + 0.15 * pop})`,
      }}
    >
      {g.words.map((w, i) => {
        const active = t >= w.start && t < w.end + 0.05;
        const color = w.highlight || active ? HIGHLIGHT : '#FFFFFF';
        return (
          <span
            key={i}
            style={{
              fontFamily: DISPLAY_FONT,
              fontWeight: 900,
              fontSize: 76,
              color,
              textTransform: 'uppercase',
              letterSpacing: -1,
              WebkitTextStroke: '10px #000',
              paintOrder: 'stroke fill',
              textShadow: '0 8px 22px rgba(0,0,0,0.55)',
              marginRight: 18,
            }}
          >
            {w.text.replace(/[,.]$/, '')}
          </span>
        );
      })}
    </div>
  );
};

export const InfoCardReel: React.FC<InfoCardReelProps> = (p) => {
  const ready = useFontsReady();
  const frame = useCurrentFrame();
  const fade = interpolate(frame, [0, 6], [0, 1], {extrapolateRight: 'clamp'});
  return (
    <AbsoluteFill style={{background: BG}}>
      {/* soft light behind the card */}
      <AbsoluteFill style={{background: 'radial-gradient(900px 520px at 50% 22%, rgba(255,255,255,0.08), rgba(255,255,255,0) 70%)'}} />
      <div style={{position: 'absolute', left: 0, top: VIDEO_TOP, width: W, height: 1920 - VIDEO_TOP, overflow: 'hidden', opacity: fade}}>
        <OffthreadVideo src={staticFile(p.videoSrc)} style={{width: '100%', height: '100%', objectFit: 'cover'}} />
        <div style={{position: 'absolute', inset: 0, background: `linear-gradient(${BG} 0%, rgba(13,14,18,0) 12%, rgba(13,14,18,0) 70%, rgba(13,14,18,0.55) 100%)`}} />
      </div>
      {ready ? <Card p={p} /> : null}
      {ready ? <Captions words={p.words} /> : null}
    </AbsoluteFill>
  );
};
