import React from 'react';
import {CalculateMetadataFunction, Composition, staticFile} from 'remotion';
import {parseMedia} from '@remotion/media-parser';
import {LiquidGlassAd} from './LiquidGlassAd';
import type {AdProps} from './types';
import sample from '../props/test.json';

const FPS = 30;

const calculateMetadata: CalculateMetadataFunction<AdProps> = async ({props}) => {
  let seconds = props.durationInSeconds;
  if (!seconds) {
    const media = await parseMedia({
      src: staticFile(props.videoSrc),
      fields: {slowDurationInSeconds: true},
      acknowledgeRemotionLicense: true,
    });
    seconds = media.slowDurationInSeconds;
  }
  return {durationInFrames: Math.max(1, Math.floor(seconds * FPS))};
};

export const RemotionRoot: React.FC = () => (
  <Composition
    id="LiquidGlassAd"
    component={LiquidGlassAd}
    width={1080}
    height={1920}
    fps={FPS}
    durationInFrames={FPS * 10}
    defaultProps={sample as AdProps}
    calculateMetadata={calculateMetadata}
  />
);
