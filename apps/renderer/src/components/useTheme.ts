import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import type { ThemeMode } from '../theme';

const KEY = 'devpilot.theme';
const mql = () => window.matchMedia('(prefers-color-scheme: dark)');

function readMode(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  } catch { return 'system'; }
}

/** 集中管理主题偏好、系统监听、持久化与 DOM 主题标记。 */
export function useThemeMode() {
  const [mode, setModeState] = useState<ThemeMode>(readMode);
  const [systemDark, setSystemDark] = useState(() => { try { return mql().matches; } catch { return false; } });
  const resolved: 'light' | 'dark' = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themePreference = mode;
    document.documentElement.style.colorScheme = resolved;
    (window as unknown as { __devpilotTheme?: string }).__devpilotTheme = resolved;
  }, [mode, resolved]);

  useEffect(() => {
    const media = mql();
    const sync = () => setSystemDark(media.matches);
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener('change', onChange);
    // Windows 主题切换偶发不派发 change 事件，轮询保证“跟随系统”始终收敛。
    const guard = setInterval(sync, 2000);
    sync();
    return () => { media.removeEventListener('change', onChange); clearInterval(guard); };
  }, []);

  useEffect(() => {
    const bridge = (window as unknown as {
      devpilot?: { setThemePreference?: (mode: ThemeMode) => void | Promise<void> };
    }).devpilot;
    void bridge?.setThemePreference?.(mode);
  }, [mode]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    try { localStorage.setItem(KEY, next); } catch { /* 存储不可用时保留当前会话设置 */ }
  }, []);

  return { mode, resolved, setMode };
}
