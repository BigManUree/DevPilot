import { contextBridge, ipcRenderer } from 'electron';

/**
 * Preload：只暴露最小化、类型化 API（系统总体架构 2.3 节）。
 */
contextBridge.exposeInMainWorld('devpilot', {
  version: '0.1.0',
  getBackendUrl: (): Promise<string> => ipcRenderer.invoke('devpilot:getBackendUrl'),
  /** 打开系统目录选择器，取消返回 null */
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('devpilot:pickDirectory'),
  /** 订阅原生菜单栏动作（文件/编辑/视图/导航/帮助），返回取消订阅函数 */
  onMenu: (cb: (payload: unknown) => void): (() => void) => {
    const handler = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on('devpilot:menu', handler);
    return () => ipcRenderer.removeListener('devpilot:menu', handler);
  },
  /** 把渲染层主题偏好同步给主进程，用于更新原生菜单外观 radio 选中态 */
  setThemePreference: (mode: 'system' | 'light' | 'dark'): Promise<void> =>
    ipcRenderer.invoke('devpilot:menuTheme', mode),
});
