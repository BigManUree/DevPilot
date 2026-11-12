import { useCallback, useEffect, useState } from 'react';
import type { ThemeMode } from '../theme';

const KEY = 'devpilot.theme';
const mql = () => window.matchMedia('(prefers-color-scheme: dark)');

function readMode(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  } catch { return 'system'; }
}

/** 主题：跟随系统 / 浅色 / 深色。写 localStorage 并同步 <html data-theme> 供 CSS 变量切换。 */
export function useThemeMode() {
  const [mode, setModeState] = useState<ThemeMode>(readMode);
  const [systemDark, setSystemDark] = useState(() => { try { return mql().matches; } catch { return false; } });

  useEffect(() => {
    const m = mql();
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    m.addEventListener('change', onChange);
    return () => m.removeEventListener('change', onChange);
  }, []);

  const resolved: 'light' | 'dark' = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;

  useEffect(() => {
    try { document.documentElement.dataset.theme = resolved; } catch { /* 忽略 */ }
  }, [resolved]);

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m);
    try { localStorage.setItem(KEY, m); } catch { /* 忽略 */ }
  }, []);

  return { mode, resolved, setMode };
}
