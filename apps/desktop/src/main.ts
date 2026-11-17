import { app, BrowserWindow, shell, ipcMain, dialog, Tray, Menu, nativeImage, Notification } from 'electron';
import path from 'node:path';
import { BackendManager } from './backend-manager';
import { installAppMenu } from './app-menu';
import { markStartup, readStartupTrace } from './startup-trace';

/**
 * Electron 主进程：窗口生命周期、后端拉起与退出清理。
 * Renderer 不获得任意 Node 能力（contextIsolation 开启，nodeIntegration 关闭）。
 *
 * 启动顺序（性能约束：冷启动 ≤5s，见 docs/启动性能优化报告.md）：
 *   1. app ready 后立刻建窗加载渲染层——窗口与「首屏骨架」不等后端；
 *   2. 后端并行拉起，就绪后通过 IPC 通知渲染层放行数据请求；
 *   3. 托盘、更新检查、审批轮询等旁路工作全部排到后端就绪之后，且不阻塞窗口。
 * 旧实现是「先 await 后端就绪再建窗」，用户看到的是持续数秒的白屏。
 */
const backend = new BackendManager();

/** 后端就绪 Promise：渲染层的数据请求 gate 与主进程的旁路任务都等它 */
let backendReady: Promise<string>;
let backendReadyState: { ready: boolean; url: string; error?: string } = { ready: false, url: backend.url };

markStartup('process.start', { electron: process.versions.electron, packaged: app.isPackaged });

// 后端进程在这里就拉起：与 Chromium 主进程初始化并行（app.ready 通常还要 300~800ms）。
// 旧实现把 spawn 放在 app.ready 之后，Electron 的初始化时间完全浪费掉了。
backendReady = backend.ensure().then((url) => {
  markStartup('backend.ready');
  backendReadyState = { ready: true, url };
  notifyBackendReady(url);
  return url;
});

let tray: Tray | undefined;
let lastPendingApprovals = 0;

function notifyBackendReady(url: string): void {
  backendReadyState = { ready: true, url };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('devpilot:backend-ready', url);
  }
}

/** 系统托盘：常驻入口 + 审批轮询提醒（新待审批 → Windows 气球 / macOS 系统通知） */
function ensureTray(backendUrl: string): void {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(__dirname, '../build/icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) return; // 无图标资源（如异常构建）则静默跳过托盘
  tray = new Tray(icon);
  tray.setToolTip('DevPilot');
  const focusWindow = () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  };
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 DevPilot', click: focusWindow },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
  tray.on('click', focusWindow);
  // 审批轮询：只在新增时提醒一次，不重复轰炸
  setInterval(() => {
    void fetch(`${backendUrl}/api/v1/approvals`)
      .then((r) => r.json())
      .then((rows: unknown) => {
        const list = Array.isArray(rows) ? rows as Array<{ approval_status?: string }> : [];
        const count = list.filter((x) => x?.approval_status === 'pending').length;
        tray?.setToolTip(count > 0 ? `DevPilot — ${count} 条操作待审批` : 'DevPilot');
        if (count > lastPendingApprovals && count > 0) {
          const title = 'DevPilot：Agent 请求授权';
          const content = `有 ${count} 条操作等待你的审批，打开应用可在弹窗中一键批准 / 拒绝`;
          if (process.platform === 'win32') {
            tray?.displayBalloon({ iconType: 'info', title, content });
          } else if (Notification.isSupported()) {
            new Notification({ title, body: content }).show();
          }
        }
        lastPendingApprovals = count;
      })
      .catch(() => { /* 后端瞬时不可达静默 */ });
  }, 6000);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    // 首帧前用底色兜底，避免默认白底闪一下再被主题色覆盖
    backgroundColor: '#f5f6f8',
    // 窗口/任务栏图标：打包态用 exe 内嵌图标（Windows 默认取 exe），开发态指向 build/icon.png
    icon: app.isPackaged ? undefined : path.join(__dirname, '../build/icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
      // 首屏不需要后台节流：窗口在后台被节流会拖慢首帧与启动后的数据填充
      backgroundThrottling: false,
    },
  });

  win.once('ready-to-show', () => markStartup('window.readyToShow'));
  win.webContents.once('did-finish-load', () => markStartup('window.didFinishLoad'));

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else if (app.isPackaged) {
    void win.loadFile(path.join(process.resourcesPath, 'renderer', 'dist', 'index.html'));
  } else {
    void win.loadFile(path.join(__dirname, '../../renderer/dist/index.html'));
  }
  markStartup('window.created');

  // 外链走系统浏览器：仅允许 http/https（防 file://、自定义协议被 renderer 触发）
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  return win;
}

/** 数据目录：与后端一致（DEVIPILOT_DATA_DIR 优先，否则 %APPDATA%/devpilot/data） */
function dataDir(): string {
  return process.env.DEVIPILOT_DATA_DIR ?? path.join(process.env.APPDATA ?? app.getPath('userData'), 'devpilot', 'data');
}

/** 读本机 API token；后端可能刚 listen 还没写盘，短重试即可（旧实现固定轮询 3s） */
async function readAuthToken(): Promise<string | null> {
  const fs = await import('node:fs');
  const file = path.join(dataDir(), '.auth-token');
  for (let i = 0; i < 30; i++) {
    try {
      const t = fs.readFileSync(file, 'utf-8').trim();
      if (t) return t;
    } catch { /* 尚未写盘 */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

app.whenReady().then(() => {
  markStartup('app.ready');

  // ---- IPC 先注册（渲染层马上就会调用，不能等到后端就绪）----
  ipcMain.handle('devpilot:getBackendUrl', () => backend.url);
  // 后端就绪状态查询：渲染层据此决定「可以发数据请求」还是「显示骨架」
  ipcMain.handle('devpilot:backendReady', async () => {
    if (backendReadyState.ready) return backendReadyState;
    try {
      await backendReady;
      return backendReadyState;
    } catch (err) {
      return { ready: false, url: backend.url, error: String(err) };
    }
  });
  ipcMain.handle('devpilot:getAuthToken', async () => {
    await backendReady.catch(() => undefined); // token 由后端进程写入，先等它就绪
    return readAuthToken();
  });
  // 启动计时上报（渲染层首帧）
  ipcMain.handle('devpilot:startupMark', (_e, mark: unknown) => {
    if (typeof mark === 'string' && mark) markStartup(`renderer.${mark}`);
  });
  ipcMain.handle('devpilot:startupTrace', () => readStartupTrace());
  // 系统目录选择器：返回所选目录绝对路径，取消返回 null
  ipcMain.handle('devpilot:pickDirectory', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const r = await dialog.showOpenDialog(win as BrowserWindow, {
      title: '选择目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });
  // 原生菜单栏：动作经 IPC 交给渲染进程（业务逻辑仍在前端）
  installAppMenu(() => BrowserWindow.getAllWindows()[0] ?? null);
  // 渲染层主题偏好变化时，同步原生菜单外观 radio 选中态
  ipcMain.handle('devpilot:menuTheme', (_event, mode: unknown) => {
    const next = mode === 'light' || mode === 'dark' ? mode : 'system';
    installAppMenu(() => BrowserWindow.getAllWindows()[0] ?? null, next);
  });

  // ---- 窗口先行：不等后端，立即加载渲染层（首屏骨架由前端渲染）----
  createWindow();

  // ---- 后端旁路任务：托盘 / 更新检查，等就绪后执行且不阻塞首屏 ----
  backendReady
    .then((url) => {
      ensureTray(url);
      void fetch(`${url}/api/v1/system/update-check`)
        .then((r) => r.json())
        .then((u: { updateAvailable?: boolean; latestVersion?: string; notes?: string }) => {
          if (u.updateAvailable) {
            dialog.showMessageBox({
              type: 'info',
              message: `DevPilot 有新版本：${u.latestVersion}`,
              detail: u.notes ?? '可在发布页下载新版本',
              buttons: ['知道了'],
            });
          }
        })
        .catch(() => {});
    })
    .catch((err) => {
      backendReadyState = { ready: false, url: backend.url, error: String(err) };
      markStartup('backend.failed', { error: String(err) });
      // 后端拉起失败：窗口已在，用可见错误替代无窗挂死
      const win = BrowserWindow.getAllWindows()[0];
      const opts = {
        type: 'error' as const,
        message: 'DevPilot 后端启动失败',
        detail: String(err),
        buttons: ['退出'],
      };
      const box = win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts);
      void box.then(() => app.quit());
    });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  backend.shutdown();
  if (tray) { tray.destroy(); tray = undefined; }
});
