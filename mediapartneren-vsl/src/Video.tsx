import React from 'react';
import { AbsoluteFill, Series, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, F, Mark, Shot, THEME } from './ui';
import { EndCard, Gap, Guarantee, Leak, Lines, NextStep, Objections, Options, Stack, Track, TwoTypes } from './scenes';

const S = 30; // fps

type Item = { ch: number; sec: number; el: React.ReactNode };
// Chapters shown in the bar at the bottom.
export const CHAPTERS = ['Kjenner du deg igjen?', 'To typer bedrifter', 'Hvor salget lekker', 'Ikke din feil', 'Den tredje veien', 'Garantien', 'Neste steg'];

export const TIMELINE: Item[] = [
  // 1 hook: the customer's own words
  { ch: 0, sec: 5.5, el: <Objections /> },
  { ch: 0, sec: 4.5, el: <Lines lines={[{ t: 'Hører du dette oftere enn', size: 92, dim: true }, { t: '*«Vi* *kjører»?*', size: 150, at: 16 }]} /> },
  { ch: 0, sec: 5, el: <Lines lines={[{ t: 'Da er det ikke markedsføringen', size: 96 }, { t: 'som er problemet.', size: 96, at: 18 }]} /> },
  { ch: 0, sec: 5, el: <Lines lines={[{ t: 'Det er det som skjer', size: 96 }, { t: '*etter* at kunden tar kontakt.', size: 96, at: 16 }]} /> },
  { ch: 0, sec: 5.5, el: <Lines kicker="Det vi lover" lines={[{ t: '*10* *nye* *kunder* på 90 dager.', size: 108, at: 8 }, { t: 'Uten en krone mer i annonser.', size: 78, at: 36, dim: true }]} /> },
  // 2 two types + who we are
  { ch: 1, sec: 8, el: <TwoTypes /> },
  { ch: 1, sec: 4.5, el: <Lines lines={[{ t: 'Forskjellen har nesten ingenting', size: 88 }, { t: 'med *budsjettet* å gjøre.', size: 88, at: 16 }]} /> },
  { ch: 1, sec: 6, el: <Lines kicker="Hvem vi er" lines={[{ t: '[Navn] og [Navn].', size: 100, at: 10 }, { t: '_[X]_ _år_ i salg og salgsledelse.', size: 76, at: 34, dim: true }]} /> },
  { ch: 1, sec: 4.5, el: <Lines lines={[{ t: 'Vi har sittet i de samme møtene', size: 84 }, { t: 'som teamet ditt sitter i *hver* *dag.*', size: 84, at: 16 }]} /> },
  // 3 the leak
  { ch: 2, sec: 9, el: <Leak /> },
  { ch: 2, sec: 5, el: <Lines lines={[{ t: 'Og så blir konklusjonen alltid:', size: 72, dim: true }, { t: '*«Vi* *trenger* *mer* *markedsføring.»*', size: 104, at: 18 }]} /> },
  { ch: 2, sec: 3.5, el: <Lines lines={[{ t: 'Mer vann i en bøtte med hull.', size: 110 }]} /> },
  // 4 not your fault
  { ch: 3, sec: 3.5, el: <Lines lines={[{ t: 'Det er ikke *din* *feil.*', size: 150 }]} /> },
  { ch: 3, sec: 7, el: <Gap /> },
  // 5 the third way
  { ch: 4, sec: 8, el: <Options /> },
  { ch: 4, sec: 4, el: <Lines lines={[{ t: 'Vi selger for deg', size: 150 }, { t: '*først.*', size: 190, at: 14 }]} /> },
  { ch: 4, sec: 10, el: <Track /> },
  { ch: 4, sec: 5, el: <Lines lines={[{ t: 'Ingen kurs. Ingen teori.', size: 96, dim: true }, { t: 'De ser det skje. *Så* *gjør* *de* *det* *selv.*', size: 96, at: 26 }]} /> },
  { ch: 4, sec: 8, el: <Stack /> },
  // 6 guarantee
  { ch: 5, sec: 8, el: <Guarantee /> },
  { ch: 5, sec: 5, el: <Lines lines={[{ t: 'Du risikerer ikke pengene.', size: 96 }, { t: 'Bare å fortsette *som* *i* *dag.*', size: 96, at: 26 }]} /> },
  // 7 next step
  { ch: 6, sec: 8, el: <NextStep /> },
  { ch: 6, sec: 6, el: <Lines lines={[{ t: 'Om 90 dager er du 90 dager eldre uansett.', size: 74, dim: true }, { t: 'Spørsmålet er om du har', size: 104, at: 30 }, { t: '*flere* *kunder.*', size: 150, at: 44 }]} /> },
  { ch: 6, sec: 6, el: <EndCard Mark={Mark} /> },
];

export const TOTAL = TIMELINE.reduce((a, t) => a + Math.round(t.sec * S), 0);

const Background: React.FC = () => {
  const f = useCurrentFrame();
  const drift = Math.sin(f / 90) * 40;
  if (THEME === 'blue') {
    return (
      <AbsoluteFill style={{ background: `radial-gradient(1400px 900px at 50% -10%, #2D5BFF, ${C.bg} 55%, #061F5C)` }}>
        {/* dotted map texture */}
        <AbsoluteFill style={{
          backgroundImage: 'radial-gradient(rgba(255,255,255,.28) 1.4px, transparent 1.6px)', backgroundSize: '22px 22px',
          backgroundPosition: `${drift}px 0`, opacity: 0.55,
          WebkitMaskImage: 'radial-gradient(ellipse 70% 60% at 50% 40%, transparent 30%, #000 80%)',
          maskImage: 'radial-gradient(ellipse 70% 60% at 50% 40%, transparent 30%, #000 80%)',
        }} />
        <AbsoluteFill style={{ background: `radial-gradient(900px 500px at 50% 115%, ${C.orange}40, transparent 70%)` }} />
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      {/* vertical light beam: stripes fading blue to orange */}
      <AbsoluteFill style={{
        left: 560 + drift, right: 560 - drift,
        background: `repeating-linear-gradient(90deg, rgba(255,255,255,.0) 0 10px, rgba(255,255,255,.9) 10px 12px), linear-gradient(180deg, ${C.blue}, ${C.blue} 30%, ${C.orange} 100%)`,
        backgroundBlendMode: 'multiply', opacity: 0.34,
        WebkitMaskImage: 'radial-gradient(ellipse 50% 70% at 50% 60%, #000 20%, transparent 75%)',
        maskImage: 'radial-gradient(ellipse 50% 70% at 50% 60%, #000 20%, transparent 75%)',
      }} />
      <AbsoluteFill style={{ background: `radial-gradient(900px 500px at 50% 112%, ${C.orange}55, transparent 70%), radial-gradient(800px 500px at 50% -10%, ${C.blue}40, transparent 70%)` }} />
    </AbsoluteFill>
  );
};

const Chrome: React.FC = () => {
  const f = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  let acc = 0; let ch = 0;
  for (const t of TIMELINE) { const d = Math.round(t.sec * S); if (f >= acc) ch = t.ch; acc += d; }
  const sec = Math.floor(f / S);
  const tc = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  return (
    <AbsoluteFill style={{ padding: '54px 70px', justifyContent: 'space-between', pointerEvents: 'none' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <Mark size={44} />
          <span style={{ fontFamily: F.display, fontSize: 30, fontWeight: 600, color: C.ink, letterSpacing: '-0.03em' }}>media<b style={{ fontWeight: 800 }}>partneren</b></span>
        </div>
        <div style={{ fontFamily: F.mono, fontSize: 20, color: C.faint, letterSpacing: '.12em' }}>{String(ch + 1).padStart(2, '0')} / {String(CHAPTERS.length).padStart(2, '0')} · {CHAPTERS[ch].toUpperCase()}</div>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        {CHAPTERS.map((c, i) => (
          <div key={c} style={{ flex: 1, height: 4, borderRadius: 2, background: i < ch ? C.ink : i === ch ? C.orange : 'rgba(255,255,255,.14)' }} />
        ))}
        <div style={{ fontFamily: F.mono, fontSize: 18, color: C.faint, marginLeft: 14, width: 70 }}>{tc}</div>
      </div>
      <div style={{ position: 'absolute', left: 70, right: 70, bottom: 50, height: 0, opacity: interpolate(f, [0, durationInFrames], [1, 1]) }} />
    </AbsoluteFill>
  );
};

export const VSL: React.FC = () => (
  <AbsoluteFill style={{ background: C.bg, fontFamily: F.display }}>
    <Background />
    <Series>
      {TIMELINE.map((t, i) => {
        const d = Math.round(t.sec * S);
        return <Series.Sequence key={i} durationInFrames={d}><Shot dur={d}>{t.el}</Shot></Series.Sequence>;
      })}
    </Series>
    <Chrome />
  </AbsoluteFill>
);
