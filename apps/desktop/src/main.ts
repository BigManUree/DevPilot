import { app, BrowserWindow, shell, ipcMain } from 'electron';
import path from 'node:path';
import { BackendManager } from './backend-manager';
import { installAppMenu } from './app-menu';

/**
 * Electron 主进程：窗口生命周期、后端拉起与退出清理。
 * Renderer 不获得任意 Node 能力（contextIsolation 开启，nodeIntegration 关闭）。
 */
const backend = new BackendManager();

function createWindow(backendUrl: string) {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    // 窗口/任务栏图标：打包态用 exe 内嵌图标（Windows 默认取 exe），开发态指向 build/icon.png
    icon: app.isPackaged ? undefined : path.join(__dirname, '../build/icon.png'),
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
  // 原生菜单栏：动作经 IPC 交给渲染进程（业务逻辑仍在前端）
  installAppMenu(() => BrowserWindow.getAllWindows()[0] ?? null);
  try {
    const backendUrl = await backend.ensure();
    createWindow(backendUrl);
    // 自动更新检查（第一批：仅提示，不自动下载）——失败静默（无清单/离线均为正常态）
    void fetch(`${backendUrl}/api/v1/system/update-check`)
      .then((r) => r.json())
      .then((u: { updateAvailable?: boolean; latestVersion?: string; notes?: string }) => {
        if (u.updateAvailable) {
          const { dialog } = require('electron') as typeof import('electron');
          dialog.showMessageBox({
            type: 'info',
            message: `DevPilot 有新版本：${u.latestVersion}`,
            detail: u.notes ?? '可在发布页下载新版本',
            buttons: ['知道了'],
          });
        }
      })
      .catch(() => {});
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(backendUrl);
    });
  } catch (err) {
    // 后端拉起失败：弹窗可见化而不是静默未处理 rejection 挂死无窗进程
    const { dialog } = await import('electron');
    dialog.showErrorBox('DevPilot 后端启动失败', String(err));
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => backend.shutdown());
