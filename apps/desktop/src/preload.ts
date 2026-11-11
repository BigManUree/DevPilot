import { contextBridge, ipcRenderer } from 'electron';

/**
 * Preload：只暴露最小化、类型化 API（系统总体架构 2.3 节）。
 */
contextBridge.exposeInMainWorld('devpilot', {
  version: '0.1.0',
  getBackendUrl: (): Promise<string> => ipcRenderer.invoke('devpilot:getBackendUrl'),
});
