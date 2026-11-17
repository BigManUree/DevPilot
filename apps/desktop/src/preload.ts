import { contextBridge, ipcRenderer } from 'electron';

/**
 * Preload：只暴露最小化、类型化 API（系统总体架构 2.3 节）。
 */
contextBridge.exposeInMainWorld('devpilot', {
  version: '0.1.0',
  getBackendUrl: (): Promise<string> => ipcRenderer.invoke('devpilot:getBackendUrl'),
  /** 后端就绪：{ ready, url, error? }。渲染层用它决定「发数据请求」还是「先显示骨架」 */
  backendReady: (): Promise<{ ready: boolean; url: string; error?: string }> =>
    ipcRenderer.invoke('devpilot:backendReady'),
  /** 后端从「未就绪」变「就绪」时推送一次（窗口可能早于后端打开） */
  onBackendReady: (cb: (url: string) => void): (() => void) => {
    const handler = (_e: unknown, url: string) => cb(url);
    ipcRenderer.on('devpilot:backend-ready', handler);
    return () => ipcRenderer.removeListener('devpilot:backend-ready', handler);
  },
  /** 启动计时上报（首帧等），写入主进程 startup-trace */
  startupMark: (mark: string): Promise<void> => ipcRenderer.invoke('devpilot:startupMark', mark),
  /** 本机 API token（后端写入 data 目录，防 CSRF 用；打包态渲染层是 file://，必须携带） */
  getAuthToken: (): Promise<string | null> => ipcRenderer.invoke('devpilot:getAuthToken'),
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
