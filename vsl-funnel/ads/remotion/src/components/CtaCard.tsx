import React, {useMemo} from 'react';
import {interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {fitText} from '@remotion/layout-utils';
import {Glass} from '../glass/Glass';
import {DISPLAY_FONT, TEXT_FONT} from '../fonts';
import {useFontsReady} from '../useFontsReady';
import {GOLD, type Beat} from '../types';
import {plain, RichText} from './RichText';

const PANEL_W = 900;
const BTN_W = 620;
const BTN_H = 140;
const CENTER_Y = 0.47;

/**
 * End card. Frame 0 = beat start. beat.title = headline, beat.sub = button label,
 * beat.footnote = brand line under the button.
 */
export const CtaCard: React.FC<{beat: Beat}> = ({beat}) => {
  const frame = useCurrentFrame();
  const {fps, width: frameW, height: frameH} = useVideoConfig();
  const ready = useFontsReady();

  const titleSize = useMemo(() => {
    if (!ready) return null;
    return Math.min(104, Math.floor(fitText({text: plain(beat.title), withinWidth: PANEL_W - 140, fontFamily: DISPLAY_FONT, fontWeight: '800'}).fontSize));
  }, [ready, beat.title]);
  if (!titleSize) return null;

  const panelP = spring({frame: frame - 4, fps, config: {damping: 14, stiffness: 140, mass: 0.95}});
  const btnP = spring({frame: frame - 12, fps, config: {damping: 11, stiffness: 170, mass: 0.8}});
  const textP = spring({frame: frame - 9, fps, config: {damping: 18, stiffness: 180}});
  const brandP = spring({frame: frame - 18, fps, config: {damping: 18, stiffness: 160}});
  const panelH = 110 + titleSize * 1.08 + 56 + BTN_H + 48 + 44 + 80;
  // gentle "breathing" on the button after it lands, like a pressable glass control
  const breathe = frame > 30 ? Math.sin((frame - 30) / 9) * 0.018 : 0;
  const btnScale = interpolate(btnP, [0, 1], [0.6, 1]) + breathe;
  const sheen = interpolate(frame, [26, 52], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const btnSheen = interpolate((frame - 40) % 50, [0, 24], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});

  return (
    <div
      style={{
        position: 'absolute',
        left: (frameW - PANEL_W) / 2,
        top: frameH * CENTER_Y - panelH / 2,
        width: PANEL_W,
        height: panelH,
        transform: `translateY(${(1 - panelP) * 180}px) scale(${interpolate(panelP, [0, 1], [0.88, 1])})`,
      }}
    >
      <Glass
        width={PANEL_W}
        height={panelH}
        radius={72}
        bezel={38}
        refraction={70}
        blur={12}
        saturate={1.7}
        brightness={0.92}
        tint="rgba(255,255,255,0.07)"
        lightAngle={-30 + Math.sin(frame / 25) * 20}
        sheen={sheen > 0 && sheen < 1 ? sheen : undefined}
        opacity={Math.min(1, panelP * 1.6)}
      >
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 110,
            textAlign: 'center',
            fontFamily: DISPLAY_FONT,
            fontWeight: 800,
            fontSize: titleSize,
            letterSpacing: '-0.035em',
            lineHeight: 1.08,
            color: '#fff',
            whiteSpace: 'nowrap',
            opacity: textP,
            transform: `translateY(${(1 - textP) * 20}px)`,
            textShadow: '0 2px 16px rgba(0,0,0,0.3)',
          }}
        >
          <RichText text={beat.title} />
        </div>

        <div
          style={{
            position: 'absolute',
            left: (PANEL_W - BTN_W) / 2,
            top: 110 + titleSize * 1.08 + 56,
            width: BTN_W,
            height: BTN_H,
            transform: `scale(${btnScale})`,
          }}
        >
          <Glass
            width={BTN_W}
            height={BTN_H}
            bezel={26}
            refraction={40}
            blur={4}
            saturate={1.4}
            tint={`linear-gradient(180deg, rgba(246,218,128,0.92) 0%, rgba(232,196,92,0.86) 50%, rgba(196,152,52,0.9) 100%)`}
            lightAngle={-30 + Math.sin(frame / 20) * 25}
            sheen={frame > 40 && btnSheen > 0 && btnSheen < 1 ? btnSheen : undefined}
            shadow={0.8}
            highlightCap={1}
            opacity={Math.min(1, btnP * 1.5)}
            style={{boxShadow: `0 16px 40px -8px rgba(232,196,92,0.55), 0 4px 12px rgba(0,0,0,0.25), inset 0 2px 1px rgba(255,255,255,0.7), inset 0 -2px 2px rgba(120,80,10,0.25)`}}
          >
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 18,
                fontFamily: DISPLAY_FONT,
                fontWeight: 800,
                fontSize: 54,
                letterSpacing: '-0.02em',
                color: '#1d1505',
              }}
            >
              <span>{beat.sub ?? 'Apply below'}</span>
              <svg width={40} height={40} viewBox="0 0 24 24" style={{transform: `translateY(${Math.sin(frame / 6) * 3}px)`}}>
                <path d="M12 4v15m0 0l-6-6m6 6l6-6" fill="none" stroke="#1d1505" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          </Glass>
        </div>

        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 110 + titleSize * 1.08 + 56 + BTN_H + 48,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 16,
            fontFamily: TEXT_FONT,
            fontWeight: 600,
            fontSize: 34,
            letterSpacing: '0.01em',
            color: 'rgba(255,255,255,0.86)',
            opacity: brandP,
          }}
        >
          <div style={{width: 14, height: 14, borderRadius: 7, background: GOLD, boxShadow: '0 0 12px rgba(232,196,92,0.8)'}} />
          {beat.footnote ?? ''}
        </div>
      </Glass>
    </div>
  );
};
