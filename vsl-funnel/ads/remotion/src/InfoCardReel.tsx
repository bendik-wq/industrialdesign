import React, {useMemo} from 'react';
import {AbsoluteFill, Img, OffthreadVideo, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {measureText} from '@remotion/layout-utils';
import {DISPLAY_FONT, TEXT_FONT} from './fonts';
import {useFontsReady} from './useFontsReady';
import {Glass} from './glass/Glass';
import {Captions} from './components/Captions';
import type {Word} from './types';

export type CardRow = {
  label: string;
  value: string;
  /** seconds: when the row lights up (the moment Josh says it) */
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
const H = 1920;
const VIDEO_TOP = 700; // sharp video panel 700..1920, blurred copy fills the frame behind
const CARD_W = 880;
const CARD_BOTTOM = 790; // card floats across the seam between blur fill and sharp video
const PAD_X = 46;
const PAD_Y = 40;
const TITLE_SIZE = 46;
const ROW_H = 66;
const BAD = '#FF7A7A';
const GOOD = '#5BE49B';
const ACCENT = '#FFD66B';

const Row: React.FC<{row: CardRow; first: boolean}> = ({row, first}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const at = Math.round((row.at ?? 0) * fps);
  const s = spring({frame: frame - at, fps, config: {damping: 11, stiffness: 190, mass: 0.7}});
  const lit = interpolate(frame - at, [0, 6, 30], [0, 1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const color = row.tone === 'bad' ? BAD : row.tone === 'good' ? GOOD : '#FFFFFF';
  return (
    <div
      style={{
        position: 'relative',
        height: ROW_H,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 24,
        borderTop: first ? 'none' : '1px solid rgba(255,255,255,0.16)',
      }}
    >
      {/* glint that sweeps the row as it lands */}
      <div
        style={{
          position: 'absolute',
          inset: '6px -18px',
          borderRadius: 18,
          background: `rgba(255,255,255,${0.12 * lit})`,
        }}
      />
      <div style={{fontFamily: TEXT_FONT, fontWeight: 600, fontSize: 25, color: 'rgba(255,255,255,0.62)', whiteSpace: 'nowrap', opacity: 0.35 + 0.65 * Math.min(1, s)}}>
        {row.label}
      </div>
      <div
        style={{
          fontFamily: DISPLAY_FONT,
          fontWeight: 800,
          fontSize: 31,
          color,
          textAlign: 'right',
          letterSpacing: '-0.01em',
          textShadow: '0 2px 12px rgba(0,0,0,0.35)',
          opacity: Math.min(1, s),
          transform: `translateX(${(1 - Math.min(1, s)) * 40}px) scale(${0.9 + 0.1 * s})`,
          transformOrigin: '100% 50%',
        }}
      >
        {row.value}
      </div>
    </div>
  );
};

const GlassCard: React.FC<{p: InfoCardReelProps}> = ({p}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const innerW = CARD_W - PAD_X * 2;

  const titleLines = useMemo(() => {
    const w = measureText({text: p.card.title, fontFamily: DISPLAY_FONT, fontSize: TITLE_SIZE, fontWeight: '800', letterSpacing: '-0.02em'}).width;
    return Math.max(1, Math.ceil(w / (innerW - 10)));
  }, [p.card.title, innerW]);

  const h = PAD_Y * 2 + 72 + 22 + titleLines * TITLE_SIZE * 1.08 + 16 + p.card.rows.length * ROW_H + (p.card.footnote ? 24 : 0) - 10;

  const inP = spring({frame: frame - 2, fps, config: {damping: 14, stiffness: 150, mass: 0.9}});
  const y = interpolate(inP, [0, 1], [220, 0]);
  const sc = interpolate(inP, [0, 1], [0.86, 1]);
  const sy = 1 + (1 - Math.min(1, inP)) * 0.08 - Math.max(0, inP - 1) * 0.4; // gel settle
  const bob = Math.sin(frame / 24) * 6;
  const lightAngle = -35 + Math.sin(frame / 30) * 22 - (1 - Math.min(1, inP)) * 60;
  const sheen = interpolate(frame, [8, 36], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const content = spring({frame: frame - 7, fps, config: {damping: 18, stiffness: 180}});

  return (
    <div
      style={{
        position: 'absolute',
        left: (W - CARD_W) / 2,
        top: CARD_BOTTOM - h,
        width: CARD_W,
        height: h,
        transform: `translateY(${y + bob}px) scale(${sc}, ${sc * sy})`,
        transformOrigin: '50% 100%',
      }}
    >
      <Glass
        width={CARD_W}
        height={h}
        radius={58}
        bezel={52}
        refraction={110}
        blur={6}
        saturate={2}
        brightness={0.88}
        highlightCap={0.82}
        tint="radial-gradient(ellipse 80% 70% at 50% 45%, rgba(8,10,18,0.42), rgba(8,10,18,0.22))"
        lightAngle={lightAngle}
        sheen={sheen > 0 && sheen < 1 ? sheen : undefined}
        opacity={Math.min(1, inP * 1.6)}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            padding: `${PAD_Y}px ${PAD_X}px`,
            color: '#fff',
            opacity: Math.max(0, Math.min(1, content)),
            transform: `translateY(${(1 - Math.min(1, content)) * 16}px)`,
          }}
        >
          {/* header */}
          <div style={{display: 'flex', alignItems: 'center', gap: 18, height: 72}}>
            {p.avatarSrc ? (
              <div style={{width: 66, height: 66, borderRadius: 999, padding: 3, background: 'linear-gradient(140deg, rgba(255,255,255,0.9), rgba(255,255,255,0.15))', boxShadow: '0 6px 18px rgba(0,0,0,0.35)'}}>
                <Img src={staticFile(p.avatarSrc)} style={{width: 60, height: 60, borderRadius: 999, objectFit: 'cover', display: 'block'}} />
              </div>
            ) : null}
            <div style={{flex: 1}}>
              <div style={{fontFamily: DISPLAY_FONT, fontWeight: 800, fontSize: 29, letterSpacing: '-0.01em'}}>{p.name}</div>
              {p.handle ? <div style={{fontFamily: TEXT_FONT, fontWeight: 500, fontSize: 21, color: 'rgba(255,255,255,0.65)'}}>{p.handle}</div> : null}
            </div>
            {/* kicker capsule */}
            <div
              style={{
                fontFamily: TEXT_FONT,
                fontWeight: 700,
                fontSize: 17,
                letterSpacing: '0.14em',
                color: '#1A1405',
                background: `linear-gradient(180deg, #FFE9A8, ${ACCENT})`,
                borderRadius: 999,
                padding: '10px 18px',
                boxShadow: '0 6px 18px rgba(255,200,80,0.35), inset 0 1px 0 rgba(255,255,255,0.8)',
              }}
            >
              {p.card.kicker}
            </div>
          </div>
          {/* title */}
          <div
            style={{
              marginTop: 22,
              fontFamily: DISPLAY_FONT,
              fontWeight: 800,
              fontSize: TITLE_SIZE,
              lineHeight: 1.08,
              letterSpacing: '-0.02em',
              textShadow: '0 2px 16px rgba(0,0,0,0.35)',
            }}
          >
            {p.card.title}
          </div>
          <div style={{marginTop: 16}}>
            {p.card.rows.map((r, i) => (
              <Row key={i} row={r} first={i === 0} />
            ))}
          </div>
          {p.card.footnote ? (
            <div style={{marginTop: 12, fontFamily: TEXT_FONT, fontWeight: 500, fontSize: 17, letterSpacing: '0.02em', color: 'rgba(255,255,255,0.5)'}}>
              {p.card.footnote}
            </div>
          ) : null}
        </div>
      </Glass>
    </div>
  );
};

export const InfoCardReel: React.FC<InfoCardReelProps> = (p) => {
  const ready = useFontsReady();
  const frame = useCurrentFrame();
  const fade = interpolate(frame, [0, 8], [0, 1], {extrapolateRight: 'clamp'});
  const push = interpolate(frame, [0, 900], [1.0, 1.04], {extrapolateRight: 'clamp'});
  return (
    <AbsoluteFill style={{background: '#07080C'}}>
      {/* blurred fill: the same footage, enlarged, so the glass has colour and light to bend */}
      <AbsoluteFill style={{transform: 'scale(1.35)', filter: 'blur(38px) saturate(1.5) brightness(0.62)'}}>
        <OffthreadVideo src={staticFile(p.videoSrc)} muted style={{width: '100%', height: '100%', objectFit: 'cover'}} />
      </AbsoluteFill>
      {/* glow pools behind the card */}
      <AbsoluteFill
        style={{
          background:
            'radial-gradient(520px 320px at 22% 18%, rgba(255,190,110,0.28), rgba(0,0,0,0) 70%), radial-gradient(560px 360px at 85% 32%, rgba(110,170,255,0.24), rgba(0,0,0,0) 70%)',
        }}
      />
      {/* sharp video, feathered into the fill */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: VIDEO_TOP,
          width: W,
          height: H - VIDEO_TOP,
          overflow: 'hidden',
          WebkitMaskImage: 'linear-gradient(180deg, rgba(0,0,0,0) 0%, #000 14%, #000 100%)',
          maskImage: 'linear-gradient(180deg, rgba(0,0,0,0) 0%, #000 14%, #000 100%)',
          opacity: fade,
        }}
      >
        <OffthreadVideo src={staticFile(p.videoSrc)} style={{width: '100%', height: '100%', objectFit: 'cover', transform: `scale(${push})`, transformOrigin: '50% 30%'}} />
        <div style={{position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(0,0,0,0) 70%, rgba(0,0,0,0.45) 100%)'}} />
      </div>
      {ready ? <GlassCard p={p} /> : null}
      {ready ? <Captions words={p.words} centerY={0.845} /> : null}
    </AbsoluteFill>
  );
};
