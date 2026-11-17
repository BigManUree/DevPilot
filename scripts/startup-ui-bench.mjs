/**
 * 桌面端「界面可用」实测（DOM 口径，可跨版本比较）。
 *
 * 为什么不用 trace：应用内埋点只存在于新版本里，和旧构建比不了。
 * 这里用 Electron 自带的远程调试口（CDP）轮询 DOM，等「工作台真实数据渲染出来」为止：
 * 判定条件是页面正文出现「最近访问」区块 + 至少一个真实项目名（默认取环境变量 UI_EXPECT）。
 *
 * 用法：
 *   node scripts/startup-ui-bench.mjs --exe <DevPilot.exe> --runs 3
 *   node scripts/startup-ui-bench.mjs --dir apps/desktop --expect wb2api-local
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const WebSocket = require(path.resolve(import.meta.dirname, '../node_modules/.pnpm/node_modules/ws'));

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const ROOT = path.resolve(import.meta.dirname, '..');
const EXE_CANDIDATES = [
  path.join(ROOT, 'apps/desktop/release/win-unpacked/DevPilot.exe'),
  path.join(ROOT, 'apps/desktop/pack-opt2/win-unpacked/DevPilot.exe'),
];
const EXE = argOf('--exe', EXE_CANDIDATES.find((p) => fs.existsSync(p)) ?? EXE_CANDIDATES[1]);
const APP_DIR = argOf('--dir', '');
const EXPECT = argOf('--expect', 'wb2api-local');
const RUNS = Number(argOf('--runs', '3'));
const PORT = 9334;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ps(cmd) {
  return new Promise((resolve) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => { out += String(d); });
    p.on('close', () => resolve(out.trim()));
    p.on('error', () => resolve(''));
  });
}

function cleanEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  return env;
}

const READY_EXPR = `(() => {
  // 用 textContent 而非 innerText：窗口未聚焦时 innerText 会返回空串
  const t = document.body ? document.body.textContent : '';
  // 判定「工作台骨架已换成真实数据」：概览卡存在 + 至少一个真实项目名出现
  return (t.includes('项目总数') && t.includes(${JSON.stringify(EXPECT)})) ? 'READY' : 'WAIT';
})()`;

async function runOnce(idx) {
  await ps(`Get-Process -Name DevPilot -ErrorAction SilentlyContinue | Stop-Process -Force; try { Stop-Process -Id (Get-NetTCPConnection -LocalPort 37100 -State Listen -ErrorAction SilentlyContinue).OwningProcess -Force } catch {}`);
  await sleep(600);

  const cmd = APP_DIR ? path.join(ROOT, 'apps/desktop/node_modules/electron/dist/electron.exe') : EXE;
  const argv = APP_DIR ? [path.resolve(ROOT, APP_DIR), `--remote-debugging-port=${PORT}`] : [`--remote-debugging-port=${PORT}`];
  const t0 = Date.now();
  const proc = spawn(cmd, argv, { stdio: 'ignore', env: cleanEnv(), windowsHide: false });

  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    await sleep(100);
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
      target = list.find((t) => t.type === 'page' && /index\.html|localhost/.test(t.url)) ?? null;
    } catch { /* 调试口未就绪 */ }
  }
  if (!target) { proc.kill(); return { run: idx + 1, uiReadyMs: null, note: 'no cdp target' }; }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(String(raw));
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    } catch { /* 忽略非 JSON */ }
  });
  const evaluate = (expr) => new Promise((resolve) => {
    const myId = ++id;
    pending.set(myId, resolve);
    ws.send(JSON.stringify({ id: myId, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
  });

  let uiReady = null;
  while (Date.now() - t0 < 30000) {
    const r = await evaluate(READY_EXPR);
    if (r?.result?.result?.value === 'READY') { uiReady = Date.now() - t0; break; }
    await sleep(50);
  }
  ws.close();
  proc.kill();
  await ps(`taskkill /PID ${proc.pid} /T /F 2>$null`);
  await ps(`try { Stop-Process -Id (Get-NetTCPConnection -LocalPort 37100 -State Listen -ErrorAction SilentlyContinue).OwningProcess -Force } catch {}`);
  const row = { run: idx + 1, uiReadyMs: uiReady };
  console.log(JSON.stringify(row));
  return row;
}

const rows = [];
for (let i = 0; i < RUNS; i++) rows.push(await runOnce(i));
const vals = rows.map((r) => r.uiReadyMs).filter((v) => typeof v === 'number').sort((a, b) => a - b);
console.log(JSON.stringify({ target: APP_DIR || EXE, expect: EXPECT, runs: rows.length, medianUiReadyMs: vals[Math.floor(vals.length / 2)] ?? null }, null, 2));
fs.writeFileSync(path.join(ROOT, 'docs', `startup-ui-bench-${Date.now()}.json`), JSON.stringify({ rows }, null, 2));
