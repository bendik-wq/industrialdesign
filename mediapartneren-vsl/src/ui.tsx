import React, { CSSProperties } from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { continueRender, delayRender, getInputProps, staticFile } from 'remotion';

// Pick a look with --props='{"theme":"blue"}'. Default is Midnight.
export const THEME: 'midnight' | 'blue' = (getInputProps() as { theme?: string }).theme === 'blue' ? 'blue' : 'midnight';

// Fonts ship with the project so rendering works offline.
const faces = [
  new FontFace('Archivo', `url(${staticFile('fonts/archivo.woff2')}) format('woff2')`, { weight: '100 900', unicodeRange: 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+20AC, U+2122, U+2190-2199, U+2212, U+2215' }),
  new FontFace('Archivo', `url(${staticFile('fonts/archivo-ext.woff2')}) format('woff2')`, { weight: '100 900', unicodeRange: 'U+0100-024F, U+1E00-1EFF' }),
  new FontFace('Manrope', `url(${staticFile('fonts/manrope.woff2')}) format('woff2')`, { weight: '200 800', unicodeRange: 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+20AC, U+2122, U+2190-2199, U+2212, U+2215' }),
  new FontFace('Manrope', `url(${staticFile('fonts/manrope-ext.woff2')}) format('woff2')`, { weight: '200 800', unicodeRange: 'U+0100-024F, U+1E00-1EFF' }),
  new FontFace('Geist Mono', `url(${staticFile('fonts/geistmono.woff2')}) format('woff2')`, { weight: '100 900' }),
];
const handle = delayRender('fonts');
Promise.all(faces.map((f) => f.load().then((l) => document.fonts.add(l)))).then(() => continueRender(handle));

export const F = { display: THEME === 'blue' ? '"Manrope", sans-serif' : '"Archivo", sans-serif', mono: '"Geist Mono", monospace' };
// orange = accent, blue = secondary (names kept from the Midnight palette).
export const C = THEME === 'blue' ? {
  bg: '#09318D', blue: '#A9BEFF', orange: '#FD91CC', ink: '#FFFFFF', onAccent: '#0A1F5C', accentDeep: '#E25BA4', markBg: '#061F5C',
  card: 'linear-gradient(180deg, rgba(255,255,255,.14), rgba(255,255,255,.06))',
  dim: 'rgba(255,255,255,.66)', faint: 'rgba(255,255,255,.42)', line: 'rgba(255,255,255,.16)',
} : {
  bg: '#02070A', blue: '#0297DE', orange: '#FC734D', ink: '#F2F5F7', onAccent: '#1a0b05', accentDeep: '#b8401f', markBg: '#0B1216',
  card: 'linear-gradient(180deg, rgba(20,28,34,.92), rgba(10,16,21,.92))',
  dim: 'rgba(242,245,247,.55)', faint: 'rgba(242,245,247,.28)', line: 'rgba(255,255,255,.10)',
};

export const ease = (f: number, from: number, to: number, a = 0, b = 1) =>
  interpolate(f, [from, to], [a, b], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

export const useIn = (delay = 0, dur = 22) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - delay, fps, config: { damping: 200 }, durationInFrames: dur });
};

// Text with *orange* and _blue_ emphasis, revealed word by word.
export const Words: React.FC<{ text: string; delay?: number; per?: number; style?: CSSProperties }> = ({ text, delay = 0, per = 3, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  let mode: 'o' | 'b' | null = null;
  const words = text.split(' ').map((raw) => {
    let w = raw;
    if (w.startsWith('*')) { mode = 'o'; w = w.slice(1); }
    if (w.startsWith('_')) { mode = 'b'; w = w.slice(1); }
    const m = mode;
    if (w.endsWith('*') || w.endsWith('_')) { w = w.slice(0, -1); mode = null; }
    else if (/[*_][.,!?»:]$/.test(w)) { w = w.slice(0, -2) + w.slice(-1); mode = null; }
    return { w, m };
  });
  return (
    <span style={{ display: 'inline', ...style }}>
      {words.map(({ w, m }, i) => {
        const p = spring({ frame: frame - delay - i * per, fps, config: { damping: 200 }, durationInFrames: 18 });
        return (
          <span key={i} style={{
            display: 'inline-block', marginRight: '0.24em', opacity: p,
            transform: `translateY(${(1 - p) * 0.45}em)`, filter: `blur(${(1 - p) * 10}px)`,
            color: m === 'o' ? C.orange : m === 'b' ? C.blue : undefined,
          }}>{w}</span>
        );
      })}
    </span>
  );
};

export const Kicker: React.FC<{ children: React.ReactNode; delay?: number; color?: string }> = ({ children, delay = 0, color = C.orange }) => {
  const p = useIn(delay);
  return (
    <div style={{ fontFamily: F.mono, fontSize: 24, letterSpacing: '.18em', textTransform: 'uppercase', color, opacity: p,
      transform: `translateY(${(1 - p) * 14}px)`, display: 'flex', alignItems: 'center', gap: 14 }}>
      <span style={{ width: 10, height: 10, borderRadius: 2, background: color, boxShadow: `0 0 18px ${color}` }} />{children}
    </div>
  );
};

// Fades a shot in and out so cuts feel smooth.
export const Shot: React.FC<{ dur: number; children: React.ReactNode; style?: CSSProperties }> = ({ dur, children, style }) => {
  const f = useCurrentFrame();
  const o = Math.min(ease(f, 0, 8), ease(f, dur - 10, dur, 1, 0));
  const s = interpolate(f, [0, dur], [1, 1.035]);
  return <AbsoluteFill style={{ opacity: o, transform: `scale(${s})`, padding: '0 150px', justifyContent: 'center', ...style }}>{children}</AbsoluteFill>;
};

export const Glass: React.FC<{ children: React.ReactNode; style?: CSSProperties; glow?: string }> = ({ children, style, glow }) => (
  <div style={{
    background: C.card,
    border: `1px solid ${glow ? glow : C.line}`, borderRadius: 28, padding: '30px 34px',
    boxShadow: glow ? `0 0 0 1px ${glow}55, 0 30px 90px -20px ${glow}88` : '0 30px 80px -30px rgba(0,0,0,.8)',
    ...style,
  }}>{children}</div>
);

export const Mark: React.FC<{ size?: number }> = ({ size = 56 }) => (
  <svg width={size} height={size} viewBox="0 0 64 64">
    <defs><linearGradient id="mg" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stopColor={C.blue} /><stop offset="1" stopColor={C.orange} /></linearGradient></defs>
    <rect width="64" height="64" rx="16" fill={C.markBg} stroke="rgba(255,255,255,.14)" />
    <path d="M15 45V24l11 13 11-13v11l12-15" fill="none" stroke="url(#mg)" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="49" cy="20" r="4" fill={C.orange} />
  </svg>
);
