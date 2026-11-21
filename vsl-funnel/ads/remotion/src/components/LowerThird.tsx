import React, {useMemo} from 'react';
import {interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {measureText} from '@remotion/layout-utils';
import {Glass} from '../glass/Glass';
import {DISPLAY_FONT, TEXT_FONT} from '../fonts';
import {useFontsReady} from '../useFontsReady';
import {GOLD, type Beat} from '../types';
import {plain, RichText} from './RichText';

const H = 100;
const CENTER_Y = 0.735;
const SIZE = 40;

/** Glass pill that grows out of a bead (gel morph). Frame 0 = beat start. */
export const LowerThird: React.FC<{beat: Beat}> = ({beat}) => {
  const frame = useCurrentFrame();
  const {fps, width: frameW, height: frameH} = useVideoConfig();
  const ready = useFontsReady();
  const durF = Math.round((beat.end - beat.start) * fps);

  const full = useMemo(() => {
    if (!ready) return null;
    const tw = measureText({text: plain(beat.title), fontFamily: DISPLAY_FONT, fontSize: SIZE, fontWeight: '700', letterSpacing: '-0.01em'}).width;
    const sw = beat.sub ? measureText({text: beat.sub, fontFamily: TEXT_FONT, fontSize: 30, fontWeight: '500'}).width + 34 : 0;
    return 28 + 22 + 22 + tw + sw + 44;
  }, [ready, beat.title, beat.sub]);
  if (!full) return null;

  const bead = spring({frame, fps, config: {damping: 12, stiffness: 200, mass: 0.7}});
  const grow = spring({frame: frame - 6, fps, config: {damping: 13, stiffness: 160, mass: 0.9}});
  const out = spring({frame: frame - (durF - 14), fps, config: {damping: 18, stiffness: 200}});
  const g = Math.max(0, grow - out * 1.1);
  const w = H + (full - H) * g;
  const stretch = (w - full) / full;
  const h = H * (1 - Math.max(-0.1, Math.min(0.1, stretch)));
  const scale = interpolate(Math.max(0, bead - out), [0, 1], [0.3, 1]);
  const textP = Math.max(0, spring({frame: frame - 12, fps, config: {damping: 18, stiffness: 200}}) - out * 1.6);

  return (
    <div
      style={{
        position: 'absolute',
        left: (frameW - w) / 2,
        top: frameH * CENTER_Y - h / 2,
        width: w,
        height: h,
        transform: `scale(${scale})`,
      }}
    >
      <Glass
        width={w}
        height={h}
        bezel={30}
        refraction={70}
        blur={6}
        brightness={0.9}
        tint="rgba(18,18,24,0.18)"
        lightAngle={-50 + frame * 1.2}
        opacity={Math.min(1, Math.max(0, bead - out) * 1.5)}
        sheen={interpolate(frame, [14, 38], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 22,
            whiteSpace: 'nowrap',
            opacity: textP,
          }}
        >
          <div
            style={{
              width: 22,
              height: 22,
              borderRadius: 11,
              background: `radial-gradient(circle at 35% 30%, #fff6d6 0%, ${GOLD} 45%, #a8822a 100%)`,
              boxShadow: '0 0 16px rgba(232,196,92,0.7)',
              flexShrink: 0,
            }}
          />
          <div style={{fontFamily: DISPLAY_FONT, fontWeight: 700, fontSize: SIZE, letterSpacing: '-0.01em', color: '#fff', textShadow: '0 1px 8px rgba(0,0,0,0.3)'}}>
            <RichText text={beat.title} />
          </div>
          {beat.sub ? (
            <div style={{fontFamily: TEXT_FONT, fontWeight: 500, fontSize: 30, color: 'rgba(255,255,255,0.75)', paddingLeft: 12, borderLeft: '1.5px solid rgba(255,255,255,0.35)'}}>
              {beat.sub}
            </div>
          ) : null}
        </div>
      </Glass>
    </div>
  );
};
