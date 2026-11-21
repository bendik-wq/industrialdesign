import React, {useId, useMemo} from 'react';
import {makeLensMap} from './lensMap';

export type GlassProps = {
  width: number;
  height: number;
  radius?: number;
  /** width of the curved refracting rim, px */
  bezel?: number;
  /** max refraction offset, px (feDisplacementMap scale) */
  refraction?: number;
  /** frosting blur applied before refraction, px */
  blur?: number;
  saturate?: number;
  brightness?: number;
  /** CSS background painted inside the glass (tint). */
  tint?: string;
  /** angle (deg) the key light comes from; animate it to make the rim highlight move */
  lightAngle?: number;
  /** 0..1 progress of a specular sheen sweep across the surface; undefined = none */
  sheen?: number;
  /** strength of the drop shadow 0..1 */
  shadow?: number;
  /** 0..1 inner "press" glow */
  glow?: number;
  /** adaptive contrast: backdrop highlights are compressed to this level (1 = off) so white text holds up over bright content */
  highlightCap?: number;
  /** -1: rim samples from the inside (thick lens look), 1: rim samples from outside the shape */
  lensDirection?: 1 | -1;
  opacity?: number;
  style?: React.CSSProperties;
  children?: React.ReactNode;
};

/**
 * One piece of Liquid Glass. Real lensing comes from backdrop-filter → SVG filter that
 * displaces the backdrop through a per-size lens map (with slight RGB split, like
 * dispersion at a glass edge). Highlights, rim light and sheen are layered on top.
 *
 * NOTE: never put opacity / filter / mask / mix-blend-mode on an ANCESTOR of <Glass>:
 * in Chromium that creates a "backdrop root" and the glass would see nothing behind it.
 * Pass opacity through the `opacity` prop instead (applied to the glass element itself).
 */
export const Glass: React.FC<GlassProps> = ({
  width,
  height,
  radius,
  bezel = 22,
  refraction = 46,
  blur = 7,
  saturate = 1.8,
  brightness = 1.0,
  tint = 'rgba(255,255,255,0.06)',
  lightAngle = -35,
  sheen,
  shadow = 1,
  glow = 0,
  highlightCap = 0.8,
  lensDirection = -1,
  opacity = 1,
  style,
  children,
}) => {
  const rawId = useId();
  const w = Math.max(2, Math.round(width));
  const h = Math.max(2, Math.round(height));
  const r = Math.min(radius ?? h / 2, w / 2, h / 2);
  const bz = Math.min(bezel, r, Math.min(w, h) / 2 - 1);
  const map = useMemo(() => makeLensMap(w, h, r, bz, lensDirection), [w, h, r, bz, lensDirection]);
  // id changes with size so Chromium never re-uses a stale filter for the backdrop
  const id = `lg${rawId.replace(/[^a-zA-Z0-9]/g, '')}_${w}_${h}`;
  const s = refraction;

  const backdrop = `blur(${blur}px) url(#${id}) saturate(${saturate}) brightness(${brightness})`;
  const la = lightAngle;

  return (
    <div
      style={{
        position: 'absolute',
        width: w,
        height: h,
        borderRadius: r,
        overflow: 'hidden',
        opacity,
        backdropFilter: backdrop,
        WebkitBackdropFilter: backdrop,
        boxShadow: [
          `0 ${18 * shadow}px ${44 * shadow}px -10px rgba(0,0,0,${0.42 * shadow})`,
          `0 ${3 * shadow}px ${10 * shadow}px rgba(0,0,0,${0.16 * shadow})`,
          'inset 0 1.5px 0.5px rgba(255,255,255,0.55)',
          'inset 0 -1px 1px rgba(255,255,255,0.18)',
          'inset 3px 4px 8px -3px rgba(255,255,255,0.45)',
          'inset -3px -4px 8px -3px rgba(255,255,255,0.22)',
          `inset 0 0 ${Math.round(h * 0.35)}px rgba(255,255,255,${0.06 + glow * 0.18})`,
        ].join(', '),
        ...style,
      }}
    >
      <svg width={0} height={0} style={{position: 'absolute'}} aria-hidden>
        <filter
          id={id}
          x={0}
          y={0}
          width={w}
          height={h}
          filterUnits="userSpaceOnUse"
          primitiveUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feImage href={map} x={0} y={0} width={w} height={h} preserveAspectRatio="none" result="map" />
          <feDisplacementMap in="SourceGraphic" in2="map" scale={s} xChannelSelector="R" yChannelSelector="G" result="dR" />
          <feColorMatrix in="dR" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="cR" />
          <feDisplacementMap in="SourceGraphic" in2="map" scale={s * 0.9} xChannelSelector="R" yChannelSelector="G" result="dG" />
          <feColorMatrix in="dG" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="cG" />
          <feDisplacementMap in="SourceGraphic" in2="map" scale={s * 0.8} xChannelSelector="R" yChannelSelector="G" result="dB" />
          <feColorMatrix in="dB" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="cB" />
          <feBlend in="cR" in2="cG" mode="screen" result="cRG" />
          <feBlend in="cRG" in2="cB" mode="screen" result="lens" />
          {/* adaptive contrast: keep shadows, pull bright backdrop down toward highlightCap */}
          <feComponentTransfer in="lens">
            <feFuncR type="table" tableValues={`0 0.5 ${highlightCap}`} />
            <feFuncG type="table" tableValues={`0 0.5 ${highlightCap}`} />
            <feFuncB type="table" tableValues={`0 0.5 ${highlightCap}`} />
          </feComponentTransfer>
        </filter>
      </svg>

      {/* tint / adaptive body */}
      <div style={{position: 'absolute', inset: 0, background: tint}} />

      {/* soft top-lit body gradient: light enters from above, glass gets denser toward the bottom */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'linear-gradient(180deg, rgba(255,255,255,0.16) 0%, rgba(255,255,255,0.04) 38%, rgba(255,255,255,0) 60%, rgba(255,255,255,0.07) 100%)',
        }}
      />

      {/* specular sheen sweep */}
      {sheen !== undefined && sheen > 0 && sheen < 1 ? (
        <div
          style={{
            position: 'absolute',
            top: -h,
            bottom: -h,
            width: Math.max(140, w * 0.28),
            left: -w * 0.4 + sheen * w * 1.8,
            transform: 'rotate(18deg)',
            background:
              'linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.10) 35%, rgba(255,255,255,0.42) 50%, rgba(255,255,255,0.10) 65%, rgba(255,255,255,0) 100%)',
            mixBlendMode: 'screen',
          }}
        />
      ) : null}

      {/* specular hotspot where the key light hits the curved rim */}
      <div
        style={{
          position: 'absolute',
          width: Math.min(w, 420) * 0.9,
          height: Math.min(h, 220) * 0.7,
          left: w / 2 - Math.min(w, 420) * 0.45,
          top: -Math.min(h, 220) * 0.35,
          transform: `translateX(${Math.sin((la * Math.PI) / 180) * w * 0.38}px)`,
          background: 'radial-gradient(closest-side, rgba(255,255,255,0.32), rgba(255,255,255,0.08) 55%, rgba(255,255,255,0) 100%)',
          mixBlendMode: 'screen',
        }}
      />

      {/* rim light: gradient border that follows the key light angle */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: r,
          padding: 2,
          background: `linear-gradient(${la + 180}deg, rgba(255,255,255,0.95) 0%, rgba(255,255,255,0.28) 22%, rgba(255,255,255,0.05) 48%, rgba(255,255,255,0.22) 78%, rgba(255,255,255,0.75) 100%)`,
          WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
          WebkitMaskComposite: 'xor',
          maskComposite: 'exclude',
        }}
      />
      {/* bloom on the brightest part of the rim */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: r,
          padding: 5,
          background: `linear-gradient(${la + 180}deg, rgba(255,255,255,0.35) 0%, rgba(255,255,255,0) 30%, rgba(255,255,255,0) 75%, rgba(255,255,255,0.22) 100%)`,
          WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
          WebkitMaskComposite: 'xor',
          maskComposite: 'exclude',
          filter: 'blur(4px)',
        }}
      />

      <div style={{position: 'absolute', inset: 0}}>{children}</div>
    </div>
  );
};
