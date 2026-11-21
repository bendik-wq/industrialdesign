import {useEffect, useState} from 'react';
import {continueRender, delayRender} from 'remotion';
import {fontsReady} from './fonts';

/** true once the Google fonts are loaded, so text can be measured correctly */
export const useFontsReady = () => {
  const [ready, setReady] = useState(false);
  const [handle] = useState(() => delayRender('fonts'));
  useEffect(() => {
    fontsReady
      .then(() => document.fonts.ready)
      .then(() => {
        setReady(true);
        continueRender(handle);
      })
      .catch(() => {
        setReady(true);
        continueRender(handle);
      });
  }, [handle]);
  return ready;
};
