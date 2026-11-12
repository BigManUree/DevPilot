/* UI 自审截图：Electron 无头加载 preview，按 hash 路由逐页截图到 apps/renderer/shots/ */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const BASE = process.env.UI_BASE || 'http://127.0.0.1:4173';
const OUT = path.join(__dirname, '..', 'apps', 'renderer', 'shots');
const PAGES = (process.env.UI_PAGES || '1,2,4,6,9').split(',').map((s) => s.trim());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { offscreen: false } });
  await win.loadURL(`${BASE}/#/1`);
  await win.webContents.executeJavaScript(`localStorage.setItem('devpilot.onboarded','1')`);
  for (const key of PAGES) {
    await win.loadURL(`${BASE}/#/${key}`);
    await sleep(3200);
    const img = await win.webContents.capturePage();
    const file = path.join(OUT, `page-${key}.png`);
    fs.writeFileSync(file, img.toPNG());
    console.log('shot', key, img.getSize().width + 'x' + img.getSize().height, (img.toPNG().length / 1024).toFixed(0) + 'KB');
  }
  // 窄窗验证 1100 宽
  win.setSize(1100, 800);
  await win.loadURL(`${BASE}/#/2`);
  await sleep(1500);
  const narrow = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'page-2-narrow.png'), narrow.toPNG());
  console.log('shot narrow 1100x800');
  win.destroy();
  app.quit();
}).catch((e) => { console.error('SHOT ERROR', e); app.exit(1); });
