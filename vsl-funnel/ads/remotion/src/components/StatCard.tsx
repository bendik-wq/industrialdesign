import React, {useMemo} from 'react';
import {interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {fitText, measureText} from '@remotion/layout-utils';
import {Glass} from '../glass/Glass';
import {DISPLAY_FONT, TEXT_FONT} from '../fonts';
import {useFontsReady} from '../useFontsReady';
import type {Beat} from '../types';
import {plain, RichText} from './RichText';

const CARD_W = 900;
const INNER_W = 780;
const CENTER_Y = 0.8; // lower third of frame: clear of the presenter's face and of the captions (62%)

/** Glass stat card that springs up from below with a specular sheen sweep. Frame 0 = beat start. */
export const StatCard: React.FC<{beat: Beat}> = ({beat}) => {
  const frame = useCurrentFrame();
  const {fps, width: frameW, height: frameH} = useVideoConfig();
  const ready = useFontsReady();
  const durF = Math.round((beat.end - beat.start) * fps);

  const metrics = useMemo(() => {
    if (!ready) return null;
    const titleSize = Math.min(
      132,
      Math.floor(fitText({text: plain(beat.title), withinWidth: INNER_W, fontFamily: DISPLAY_FONT, fontWeight: '800'}).fontSize),
    );
    const subSize = 42;
    const subW = beat.sub
      ? measureText({text: beat.sub, fontFamily: TEXT_FONT, fontSize: subSize, fontWeight: '600'}).width
      : 0;
    const subLines = beat.sub ? Math.ceil(subW / (INNER_W - 20)) : 0;
    const titleH = titleSize * 1.05;
    const h = 76 + titleH + (subLines ? 22 + subLines * subSize * 1.22 : 0) + (beat.footnote ? 52 : 0) + 64;
    return {titleSize, subSize, h};
  }, [ready, beat.title, beat.sub, beat.footnote]);

  if (!metrics) return null;

  const inP = spring({frame, fps, config: {damping: 14, stiffness: 150, mass: 0.9}});
  const outP = spring({frame: frame - (durF - 12), fps, config: {damping: 20, stiffness: 220}});
  const p = Math.max(0, inP - outP);
  const y = interpolate(p, [0, 1], [260, 0]);
  const scale = interpolate(p, [0, 1], [0.86, 1]);
  // gel: card arrives slightly stretched vertically and settles
  const sy = 1 + (1 - Math.min(1, inP)) * 0.08 - Math.max(0, inP - 1) * 0.4;
  const sheen = interpolate(frame, [8, 34], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const sheen2 = interpolate(frame, [durF - 40, durF - 18], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const contentP = spring({frame: frame - 5, fps, config: {damping: 18, stiffness: 180}}) - outP;
  const {titleSize, subSize, h} = metrics;
  const lightAngle = -35 + Math.sin(frame / 30) * 18 - (1 - Math.min(1, inP)) * 60;

  return (
    <div
      style={{
        position: 'absolute',
        left: (frameW - CARD_W) / 2,
        top: frameH * CENTER_Y - h / 2,
        width: CARD_W,
        height: h,
        transform: `translateY(${y}px) scale(${scale}, ${scale * sy})`,
      }}
    >
      <Glass
        width={CARD_W}
        height={h}
        radius={64}
        bezel={58}
        refraction={120}
        blur={5}
        saturate={2}
        brightness={0.9}
        highlightCap={0.86}
        tint="radial-gradient(ellipse 70% 60% at 50% 50%, rgba(8,8,14,0.30), rgba(8,8,14,0.10))"
        lightAngle={lightAngle}
        sheen={sheen > 0 && sheen < 1 ? sheen : sheen2 > 0 && sheen2 < 1 ? sheen2 : undefined}
        opacity={Math.min(1, p * 1.5)}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
            padding: '0 60px',
            color: '#fff',
            opacity: Math.max(0, contentP),
            transform: `translateY(${(1 - Math.max(0, contentP)) * 18}px)`,
          }}
        >
          <div
            style={{
              fontFamily: DISPLAY_FONT,
              fontWeight: 800,
              fontSize: titleSize,
              letterSpacing: '-0.035em',
              lineHeight: 1.05,
              whiteSpace: 'nowrap',
              textShadow: '0 2px 14px rgba(0,0,0,0.25)',
            }}
          >
            <RichText text={beat.title} />
          </div>
          {beat.sub ? (
            <div
              style={{
                marginTop: 22,
                fontFamily: TEXT_FONT,
                fontWeight: 600,
                fontSize: subSize,
                lineHeight: 1.22,
                letterSpacing: '-0.01em',
                color: 'rgba(255,255,255,0.92)',
                textShadow: '0 1px 8px rgba(0,0,0,0.3)',
              }}
            >
              <RichText text={beat.sub} />
            </div>
          ) : null}
          {beat.footnote ? (
            <div
              style={{
                marginTop: 26,
                fontFamily: TEXT_FONT,
                fontWeight: 500,
                fontSize: 24,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: 'rgba(255,255,255,0.6)',
              }}
            >
              {beat.footnote}
            </div>
          ) : null}
        </div>
      </Glass>
    </div>
  );
};
