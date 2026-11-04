import React from 'react';
import { Composition } from 'remotion';
import { TOTAL, VSL } from './Video';

export const Root: React.FC = () => (
  <Composition id="VSL" component={VSL} durationInFrames={TOTAL} fps={30} width={1920} height={1080} />
);
