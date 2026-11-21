import React from 'react';
import {GOLD} from '../types';

/** Renders "*gold part* rest" with the starred parts in gold. */
export const RichText: React.FC<{text: string}> = ({text}) => {
  const parts = text.split(/(\*[^*]+\*)/g).filter(Boolean);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('*') && p.endsWith('*') ? (
          <span key={i} style={{color: GOLD, textShadow: '0 0 24px rgba(232,196,92,0.35)'}}>
            {p.slice(1, -1)}
          </span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
};

export const plain = (text: string) => text.replace(/\*/g, '');
