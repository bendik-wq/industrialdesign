import React, {useMemo} from 'react';
import {AbsoluteFill, OffthreadVideo, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {measureText} from '@remotion/layout-utils';
import {DISPLAY_FONT, TEXT_FONT} from './fonts';
import {useFontsReady} from './useFontsReady';
import {Glass} from './glass/Glass';
import {Captions} from './components/Captions';
import type {Word} from './types';

export type CardRow = {
  label: string;
  value: string;
  /** seconds: when the row bubbles in (the moment Josh says it) */
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
const VIDEO_TOP = 700;
const CARD_W = 860;
const CARD_BOTTOM = 800;
const PAD_X = 44;
const PAD_Y = 36;
const TITLE_SIZE = 46;
const ROW_H = 68;
const BAD = '#FF8A8A';
const GOOD = '#6BEBA8';
const ACCENT = '#FFD66B';

const Row: React.FC<{row: CardRow; first: boolean; reveal: number; f: number}> = ({row, first, reveal, f}) => {
  const {fps} = useVideoConfig();
  const v = spring({frame: f - 4, fps, config: {damping: 9, stiffness: 210, mass: 0.6}}); // value pops when the bubble bursts
  const color = row.tone === 'bad' ? BAD : row.tone === 'good' ? GOOD : '#FFFFFF';
  return (
    <div style={{position: 'relative', height: ROW_H * reveal, overflow: 'visible'}}>
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 0,
          height: ROW_H,
          borderRadius: 16,
          background: `linear-gradient(90deg, rgba(255,255,255,0), rgba(255,255,255,${0.14 * interpolate(f, [4, 10, 34], [0, 1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})}) 60%, rgba(255,255,255,0))`,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 24,
          borderTop: first ? 'none' : `1px solid rgba(255,255,255,${0.14 * reveal})`,
          opacity: Math.min(1, reveal * 1.4),
        }}
      >
        <div style={{fontFamily: TEXT_FONT, fontWeight: 600, fontSize: 25, color: 'rgba(255,255,255,0.62)', whiteSpace: 'nowrap'}}>{row.label}</div>
        <div
          style={{
            fontFamily: DISPLAY_FONT,
            fontWeight: 800,
            fontSize: 31,
            color,
            letterSpacing: '-0.01em',
            textAlign: 'right',
            textShadow: '0 2px 12px rgba(0,0,0,0.35)',
            opacity: Math.min(1, Math.max(0, v)),
            transform: `scale(${0.4 + 0.6 * v})`,
            transformOrigin: '100% 50%',
          }}
        >
          {row.value}
        </div>
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

  // each row springs its own height in -> the glass grows like gel as points land
  const reveals = p.card.rows.map((r) => {
    const at = Math.round((r.at ?? 0) * fps);
    return {f: frame - at, s: spring({frame: frame - at, fps, config: {damping: 12, stiffness: 160, mass: 0.8}})};
  });
  const base = PAD_Y * 2 + 72 + 20 + titleLines * TITLE_SIZE * 1.08 + 10;
  const rowsH = reveals.reduce((n, r) => n + ROW_H * Math.max(0, r.s), 0);
  const h = Math.round((base + rowsH) / 2) * 2; // 2px steps keep the lens-map cache small

  const inP = spring({frame: frame - 2, fps, config: {damping: 14, stiffness: 150, mass: 0.9}});
  const y = interpolate(inP, [0, 1], [220, 0]);
  const sc = interpolate(inP, [0, 1], [0.86, 1]);
  const sy = 1 + (1 - Math.min(1, inP)) * 0.08 - Math.max(0, inP - 1) * 0.4;
  const bob = Math.sin(frame / 24) * 6;
  // a fresh row makes the glass flex a touch
  const flex = reveals.reduce((m, r) => (r.f >= 0 && r.f < 20 ? Math.max(m, Math.sin((r.f / 20) * Math.PI) * 0.012) : m), 0);
  const lightAngle = -35 + Math.sin(frame / 30) * 22 - (1 - Math.min(1, inP)) * 60;
  const sheenA = interpolate(frame, [8, 36], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const lastLand = reveals.reduce((m, r) => (r.f >= 4 && r.f < 30 ? (r.f - 4) / 26 : m), -1);
  const sheen = sheenA > 0 && sheenA < 1 ? sheenA : lastLand > 0 && lastLand < 1 ? lastLand : undefined;
  const content = spring({frame: frame - 7, fps, config: {damping: 18, stiffness: 180}});

  return (
    <div
      style={{
        position: 'absolute',
        left: (W - CARD_W) / 2,
        top: CARD_BOTTOM - h,
        width: CARD_W,
        height: h,
        transform: `translateY(${y + bob}px) scale(${sc * (1 + flex)}, ${sc * sy * (1 - flex * 0.6)})`,
        transformOrigin: '50% 100%',
      }}
    >
      <Glass
        width={CARD_W}
        height={h}
        radius={56}
        bezel={50}
        refraction={110}
        blur={6}
        saturate={2}
        brightness={0.88}
        highlightCap={0.82}
        tint="radial-gradient(ellipse 80% 70% at 50% 45%, rgba(8,10,18,0.40), rgba(8,10,18,0.20))"
        lightAngle={lightAngle}
        sheen={sheen}
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
          <div style={{display: 'flex', alignItems: 'center', gap: 18, height: 72}}>
            <div style={{flex: 1}}>
              <div style={{fontFamily: DISPLAY_FONT, fontWeight: 800, fontSize: 29, letterSpacing: '-0.01em'}}>{p.name}</div>
              {p.handle ? <div style={{fontFamily: TEXT_FONT, fontWeight: 500, fontSize: 21, color: 'rgba(255,255,255,0.65)'}}>{p.handle}</div> : null}
            </div>
            <div
              style={{
                fontFamily: TEXT_FONT,
                fontWeight: 700,
                fontSize: 17,
                letterSpacing: '0.14em',
                color: '#1A1405',
                background: `linear-gradient(180deg, #FFEDB5, ${ACCENT})`,
                borderRadius: 999,
                padding: '10px 18px',
                boxShadow: '0 6px 18px rgba(255,200,80,0.35), inset 0 1px 0 rgba(255,255,255,0.85)',
              }}
            >
              {p.card.kicker}
            </div>
          </div>
          <div style={{marginTop: 20, fontFamily: DISPLAY_FONT, fontWeight: 800, fontSize: TITLE_SIZE, lineHeight: 1.08, letterSpacing: '-0.02em', textShadow: '0 2px 16px rgba(0,0,0,0.35)'}}>
            {p.card.title}
          </div>
          <div style={{marginTop: 10}}>
            {p.card.rows.map((r, i) =>
              reveals[i].f >= 0 ? <Row key={i} row={r} first={i === 0} reveal={Math.max(0, Math.min(1.08, reveals[i].s))} f={reveals[i].f} /> : null,
            )}
          </div>
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
      <AbsoluteFill style={{transform: 'scale(1.35)', filter: 'blur(38px) saturate(1.5) brightness(0.62)'}}>
        <OffthreadVideo src={staticFile(p.videoSrc)} muted style={{width: '100%', height: '100%', objectFit: 'cover'}} />
      </AbsoluteFill>
      <AbsoluteFill
        style={{
          background:
            'radial-gradient(520px 320px at 22% 18%, rgba(255,190,110,0.28), rgba(0,0,0,0) 70%), radial-gradient(560px 360px at 85% 32%, rgba(110,170,255,0.24), rgba(0,0,0,0) 70%)',
        }}
      />
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
