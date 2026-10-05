import { useEffect, useLayoutEffect, useState } from 'react';
import { useApp } from '../store/app';

function systemDark(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Resolves the theme preference and keeps the <html class="dark"> flag in sync. */
export function useTheme(): { resolved: 'light' | 'dark' } {
  const pref = useApp((s) => s.settings.theme);
  const [sys, setSys] = useState(systemDark);
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const fn = () => setSys(mq.matches);
    mq.addEventListener?.('change', fn);
    return () => mq.removeEventListener?.('change', fn);
  }, []);
  const resolved = pref === 'system' ? (sys ? 'dark' : 'light') : pref;
  // Layout effect: runs before charts read the CSS tokens in their passive effects.
  useLayoutEffect(() => {
    document.documentElement.classList.toggle('dark', resolved === 'dark');
  }, [resolved]);
  return { resolved };
}
