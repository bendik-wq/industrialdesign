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

/* deterministic pseudo-random */
const rnd = (i: number, k: number) => {
  const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/* ---------- rising glass bubbles (real refraction) ---------- */
const BUBBLES = Array.from({length: 9}, (_, i) => ({
  x: i % 2 ? 50 + rnd(i, 1) * 220 : W - 50 - rnd(i, 1) * 220,
  size: Math.round(34 + rnd(i, 2) * 92),
  speed: 1.1 + rnd(i, 3) * 1.6, // px per frame
  phase: rnd(i, 4) * (H + 300),
  wob: 10 + rnd(i, 5) * 22,
}));

const Bubble: React.FC<{b: (typeof BUBBLES)[number]; frame: number}> = ({b, frame}) => {
  const span = H + b.size * 2 + 200;
  const y = H + b.size - ((frame * b.speed + b.phase) % span);
  const x = b.x + Math.sin((frame + b.phase) / 28) * b.wob;
  const sq = 1 + Math.sin((frame + b.phase) / 9) * 0.05; // gel wobble
  return (
    <div style={{position: 'absolute', left: x - b.size / 2, top: y - b.size / 2, width: b.size, height: b.size, transform: `scale(${sq}, ${2 - sq})`}}>
      <Glass
        width={b.size}
        height={b.size}
        bezel={Math.round(b.size * 0.42)}
        refraction={Math.round(b.size * 0.9)}
        blur={0}
        saturate={1.6}
        brightness={1.05}
        highlightCap={1}
        tint="radial-gradient(circle at 34% 28%, rgba(255,255,255,0.55) 0 7%, rgba(255,255,255,0.06) 26%, rgba(255,255,255,0) 60%)"
        lightAngle={-40}
        shadow={0.25}
      />
    </div>
  );
};

/* ---------- raindrops sliding down the card glass ---------- */
const Drop: React.FC<{i: number; frame: number; cardH: number}> = ({i, frame, cardH}) => {
  const size = 12 + rnd(i, 7) * 14;
  const x = 30 + rnd(i, 8) * (CARD_W - 60);
  const cycle = 150 + rnd(i, 9) * 160;
  const t = ((frame + rnd(i, 10) * cycle) % cycle) / cycle;
  // drops cling, then slide with a little acceleration
  const slide = t < 0.45 ? t * 0.08 : 0.036 + Math.pow((t - 0.45) / 0.55, 2) * 0.96;
  const y = 18 + slide * (cardH - 40);
  const op = interpolate(t, [0, 0.06, 0.9, 1], [0, 1, 1, 0]);
  return (
    <>
      {/* wet trail */}
      <div style={{position: 'absolute', left: x + size / 2 - 1.5, top: 18, width: 3, height: Math.max(0, y - 18), borderRadius: 3, background: 'linear-gradient(180deg, rgba(255,255,255,0), rgba(255,255,255,0.06))', opacity: op}} />
      <div
        style={{
          position: 'absolute',
          left: x,
          top: y,
          width: size,
          height: size * 1.12,
          borderRadius: '50% 50% 50% 50% / 45% 45% 55% 55%',
          background: 'radial-gradient(circle at 35% 30%, rgba(255,255,255,0.95) 0 10%, rgba(255,255,255,0.22) 32%, rgba(255,255,255,0.06) 62%, rgba(255,255,255,0) 72%)',
          boxShadow: 'inset 0 -2px 3px rgba(255,255,255,0.35), 0 2px 4px rgba(0,0,0,0.25)',
          border: '1px solid rgba(255,255,255,0.28)',
          opacity: op,
        }}
      />
    </>
  );
};

/* ---------- bubble pop that delivers each value ---------- */
const Pop: React.FC<{f: number}> = ({f}) => {
  // f = frames since the row's moment
  if (f < 0 || f > 26) return null;
  const inflate = interpolate(f, [0, 7], [0.2, 1.15], {extrapolateRight: 'clamp'});
  const popped = f >= 8;
  const ring = interpolate(f, [8, 24], [0.9, 2.4], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const ringOp = interpolate(f, [8, 24], [0.9, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const S = 64;
  return (
    <div style={{position: 'absolute', right: -6, top: ROW_H / 2 - S / 2, width: S, height: S, pointerEvents: 'none'}}>
      {!popped ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 999,
            transform: `scale(${inflate})`,
            background: 'radial-gradient(circle at 34% 30%, rgba(255,255,255,0.9) 0 9%, rgba(255,255,255,0.18) 30%, rgba(180,220,255,0.10) 60%, rgba(255,255,255,0.0) 72%)',
            border: '1.5px solid rgba(255,255,255,0.55)',
            boxShadow: 'inset 0 0 14px rgba(255,255,255,0.35)',
          }}
        />
      ) : (
        <>
          <div style={{position: 'absolute', inset: 0, borderRadius: 999, border: '2px solid rgba(255,255,255,0.8)', transform: `scale(${ring})`, opacity: ringOp}} />
          {Array.from({length: 8}, (_, k) => {
            const a = (k / 8) * Math.PI * 2 + 0.3;
            const d = interpolate(f, [8, 24], [S * 0.4, S * 1.25], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
            const fall = interpolate(f, [8, 26], [0, 18], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
            const s = 5 + (k % 3) * 2;
            return (
              <div
                key={k}
                style={{
                  position: 'absolute',
                  left: S / 2 + Math.cos(a) * d - s / 2,
                  top: S / 2 + Math.sin(a) * d - s / 2 + fall,
                  width: s,
                  height: s,
                  borderRadius: 999,
                  background: 'radial-gradient(circle at 35% 30%, #fff 0 25%, rgba(255,255,255,0.35) 60%, rgba(255,255,255,0) 75%)',
                  opacity: ringOp,
                }}
              />
            );
          })}
        </>
      )}
    </div>
  );
};

const Row: React.FC<{row: CardRow; first: boolean; reveal: number; f: number}> = ({row, first, reveal, f}) => {
  const {fps} = useVideoConfig();
  const v = spring({frame: f - 8, fps, config: {damping: 9, stiffness: 210, mass: 0.6}}); // value pops when the bubble bursts
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
        <Pop f={f} />
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
  const lastLand = reveals.reduce((m, r) => (r.f >= 8 && r.f < 34 ? (r.f - 8) / 26 : m), -1);
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
        {[0, 1, 2, 3].map((i) => (
          <Drop key={i} i={i} frame={frame} cardH={h} />
        ))}
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
            {p.avatarSrc ? (
              <div style={{width: 66, height: 66, borderRadius: 999, padding: 3, background: 'linear-gradient(140deg, rgba(255,255,255,0.9), rgba(255,255,255,0.15))', boxShadow: '0 6px 18px rgba(0,0,0,0.35)'}}>
                <Img src={staticFile(p.avatarSrc)} style={{width: 60, height: 60, borderRadius: 999, objectFit: 'cover', display: 'block'}} />
              </div>
            ) : null}
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
      {/* glass bubbles drift up through the whole scene (behind the card, over Josh) */}
      {BUBBLES.map((b, i) => (
        <Bubble key={i} b={b} frame={frame} />
      ))}
      {ready ? <GlassCard p={p} /> : null}
      {ready ? <Captions words={p.words} centerY={0.845} /> : null}
    </AbsoluteFill>
  );
};
