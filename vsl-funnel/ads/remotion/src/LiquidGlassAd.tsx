import React, {useMemo} from 'react';
import {AbsoluteFill, interpolate, OffthreadVideo, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {Captions} from './components/Captions';
import {CtaCard} from './components/CtaCard';
import {LowerThird} from './components/LowerThird';
import {StatCard} from './components/StatCard';
import type {AdProps, Beat} from './types';

const ZOOM_IN = 1.06;

/** Adds the automatic brand lower third and CTA beat when the props don't define them. */
export const resolveBeats = (props: AdProps, durationSec: number): Beat[] => {
  const beats = [...(props.beats ?? [])];
  const brand = props.brand ?? 'G&L M&A Advisory';
  if (props.autoBrandBeats !== false) {
    if (!beats.some((b) => b.kind === 'lowerThird')) {
      beats.push({kind: 'lowerThird', start: 1.0, end: 4.0, title: brand});
    }
    if (!beats.some((b) => b.kind === 'cta')) {
      beats.push({
        kind: 'cta',
        start: Math.max(0, durationSec - 3),
        end: durationSec,
        title: props.ctaTitle ?? 'Doing *$1M+* a year?',
        sub: props.ctaButton ?? 'Apply below',
        footnote: brand,
      });
    }
  }
  return beats.sort((a, b) => a.start - b.start);
};

export const LiquidGlassAd: React.FC<AdProps> = (props) => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const durationSec = durationInFrames / fps;
  const beats = useMemo(() => resolveBeats(props, durationSec), [props, durationSec]);
  const cta = beats.find((b) => b.kind === 'cta');
  const ctaF = cta ? Math.round(cta.start * fps) : undefined;

  // punch-in zoom: toggles 1.0 <-> 1.06 on every stat / CTA beat change, with a smooth spring
  const changes = beats.filter((b) => b.kind !== 'lowerThird').map((b) => Math.round(b.start * fps));
  let zoom = 1;
  changes.forEach((cf, i) => {
    const from = i % 2 === 0 ? 1 : ZOOM_IN;
    const to = i % 2 === 0 ? ZOOM_IN : 1;
    const p = spring({frame: frame - cf, fps, config: {damping: 200, stiffness: 120}, durationInFrames: 14});
    if (frame >= cf) zoom = from + (to - from) * p;
  });
  if (ctaF !== undefined && frame >= ctaF) zoom *= interpolate(frame, [ctaF, durationInFrames], [1, 1.04]);

  const ctaP = ctaF !== undefined ? spring({frame: frame - ctaF, fps, config: {damping: 200}, durationInFrames: 18}) : 0;
  const videoFilter = ctaP > 0 ? `blur(${ctaP * 16}px) brightness(${1 - ctaP * 0.4}) saturate(${1 - ctaP * 0.15})` : undefined;

  return (
    <AbsoluteFill style={{backgroundColor: '#000'}}>
      <AbsoluteFill style={{transform: `scale(${zoom})`, filter: videoFilter}}>
        <OffthreadVideo src={staticFile(props.videoSrc)} style={{width: '100%', height: '100%', objectFit: 'cover'}} />
      </AbsoluteFill>

      {/* light vignette */}
      <AbsoluteFill
        style={{
          background: 'radial-gradient(ellipse 85% 70% at 50% 45%, rgba(0,0,0,0) 55%, rgba(0,0,0,0.38) 100%)',
          pointerEvents: 'none',
        }}
      />

      {beats.map((b, i) => {
        const from = Math.round(b.start * fps);
        const dur = Math.max(1, Math.round((b.end - b.start) * fps));
        return (
          <Sequence key={i} from={from} durationInFrames={dur} layout="none">
            {b.kind === 'stat' ? <StatCard beat={b} /> : b.kind === 'lowerThird' ? <LowerThird beat={b} /> : <CtaCard beat={b} />}
          </Sequence>
        );
      })}

      <Captions words={props.words} hideFrom={ctaF} />
    </AbsoluteFill>
  );
};
