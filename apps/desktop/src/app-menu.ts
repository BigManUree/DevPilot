import { app, BrowserWindow, Menu, dialog, shell, type MenuItemConstructorOptions } from 'electron';
import path from 'node:path';

export type MenuAction =
  | { action: 'navigate'; page: string }
  | { action: 'theme'; mode: 'system' | 'light' | 'dark' }
  | { action: 'toggle-sider' }
  | { action: 'import-project' }
  | { action: 'new-terminal' }
  | { action: 'run-project' };

const PAGES: Array<[string, string]> = [
  ['1', '工作台'], ['2', '项目'], ['4', '运行中心'], ['5', '终端'], ['6', '日志与诊断'],
  ['10', 'Git'], ['11', '代码工作区'], ['3', '任务'], ['7', '审批'], ['17', 'Agent'],
  ['18', '记忆'], ['20', '工作流'], ['8', '环境与依赖'], ['12', '数据库与服务'],
  ['13', '外部工具'], ['14', '配置中心'], ['15', '备份迁移'], ['16', '通知'], ['19', '插件'], ['9', '设置'],
];

/** Windows 桌面标准菜单栏：动作统一经 IPC 交给渲染进程执行，主进程不直接操作业务 */
export function buildAppMenu(getWin: () => BrowserWindow | null): Menu {
  const send = (payload: MenuAction) => {
    const win = getWin();
    if (win && !win.isDestroyed()) win.webContents.send('devpilot:menu', payload);
  };
  const nav = (page: string) => () => send({ action: 'navigate', page });

  const template: MenuItemConstructorOptions[] = [
    {
      label: '文件(&F)',
      submenu: [
        { label: '导入项目…', accelerator: 'Ctrl+O', click: () => send({ action: 'import-project' }) },
        { label: '打开运行中心', accelerator: 'Ctrl+Shift+R', click: nav('4') },
        { type: 'separator' },
        { label: '新建终端', accelerator: 'Ctrl+T', click: () => send({ action: 'new-terminal' }) },
        { type: 'separator' },
        { label: '关闭窗口', role: 'close' },
        { label: '退出 DevPilot', accelerator: 'Alt+F4', role: 'quit' },
      ],
    },
    {
      label: '编辑(&E)',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' },
      ],
    },
    {
      label: '视图(&V)',
      submenu: [
        { label: '重新加载界面', accelerator: 'F5', role: 'reload' },
        { label: '强制重新加载', accelerator: 'Ctrl+F5', role: 'forceReload' },
        { label: '开发者工具', accelerator: 'F12', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '实际大小', accelerator: 'Ctrl+0', role: 'resetZoom' },
        { label: '放大', accelerator: 'Ctrl+Plus', role: 'zoomIn' },
        { label: '缩小', accelerator: 'Ctrl+-', role: 'zoomOut' },
        { label: '全屏', accelerator: 'F11', role: 'togglefullscreen' },
        { type: 'separator' },
        { label: '折叠 / 展开侧栏', accelerator: 'Ctrl+B', click: () => send({ action: 'toggle-sider' }) },
        {
          label: '外观',
          submenu: [
            { label: '跟随系统', type: 'radio', click: () => send({ action: 'theme', mode: 'system' }) },
            { label: '浅色', type: 'radio', click: () => send({ action: 'theme', mode: 'light' }) },
            { label: '深色', type: 'radio', click: () => send({ action: 'theme', mode: 'dark' }) },
          ],
        },
      ],
    },
    {
      label: '导航(&G)',
      submenu: [
        ...PAGES.slice(0, 5).map(([key, label]) => ({ label, click: nav(key) })),
        { type: 'separator' as const },
        ...PAGES.slice(5, 12).map(([key, label]) => ({ label, click: nav(key) })),
        { type: 'separator' as const },
        ...PAGES.slice(12).map(([key, label]) => ({ label, click: nav(key) })),
      ],
    },
    {
      label: '帮助(&H)',
      submenu: [
        {
          label: '打开应用目录',
          click: () => { void shell.openPath(app.getAppPath()); },
        },
        {
          label: '打开数据目录',
          click: () => { void shell.openPath(app.getPath('userData')); },
        },
        { type: 'separator' },
        {
          label: '关于 DevPilot',
          click: () => {
            const win = getWin();
            const detail = [
              `版本 ${app.getVersion()}`,
              `Electron ${process.versions.electron}`,
              `Chromium ${process.versions.chrome}`,
              `Node ${process.versions.node}`,
              '',
              `数据目录 ${app.getPath('userData')}`,
            ].join('\n');
            const opts = { type: 'info' as const, title: '关于 DevPilot', message: 'DevPilot', detail, buttons: ['确定'] };
            if (win) void dialog.showMessageBox(win, opts); else void dialog.showMessageBox(opts);
          },
        },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

export function installAppMenu(getWin: () => BrowserWindow | null): void {
  Menu.setApplicationMenu(buildAppMenu(getWin));
}

/** dev 下未打包时用于窗口标题栏的图标路径（打包态由 exe 内嵌图标承担） */
export function devIconPath(): string | undefined {
  return app.isPackaged ? undefined : path.join(__dirname, '../build/icon.png');
}
