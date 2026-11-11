import { app, BrowserWindow, shell, ipcMain } from 'electron';
import path from 'node:path';
import { BackendManager } from './backend-manager';

/**
 * Electron 主进程：窗口生命周期、后端拉起与退出清理。
 * Renderer 不获得任意 Node 能力（contextIsolation 开启，nodeIntegration 关闭）。
 */
const backend = new BackendManager();

function createWindow(backendUrl: string) {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else if (app.isPackaged) {
    void win.loadFile(path.join(process.resourcesPath, 'renderer', 'dist', 'index.html'));
  } else {
    void win.loadFile(path.join(__dirname, '../../renderer/dist/index.html'));
  }

  // 外链走系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(async () => {
  ipcMain.handle('devpilot:getBackendUrl', () => backend.url);
  const backendUrl = await backend.ensure();
  createWindow(backendUrl);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(backendUrl);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => backend.shutdown());
