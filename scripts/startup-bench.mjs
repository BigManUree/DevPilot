/**
 * 桌面端冷启动实测。
 *
 * 度量口径（全部相对「主进程创建」时刻，由应用内 startup-trace 记录）：
 *   firstPaintMs            渲染层首帧（用户看到界面的时刻）
 *   apiReadyMs              后端 /api/v1/health 首次 200
 *   windowShownMs           窗口出现（MainWindowHandle 非零）
 *   backendReadyMs          后端 listen 完成（应用内 trace）
 *
 * 用法：
 *   node scripts/startup-bench.mjs                         # 打包产物（自动找 release/ 或 pack-opt2/ 的 DevPilot.exe）
 *   node scripts/startup-bench.mjs --dir apps/desktop      # 开发态（electron + 应用目录）
 *   node scripts/startup-bench.mjs --exe <path> --runs 5
 *   node scripts/startup-bench.mjs --keep                  # 结束后不杀进程
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const ROOT = path.resolve(import.meta.dirname, '..');
const APP_DIR = argOf('--dir', '');
/** 打包产物默认路径：按顺序取第一个存在的（旧基线 pack-out 已清理，现在指向 release / pack-opt2） */
const EXE_CANDIDATES = [
  path.join(ROOT, 'apps/desktop/release/win-unpacked/DevPilot.exe'),
  path.join(ROOT, 'apps/desktop/pack-opt2/win-unpacked/DevPilot.exe'),
];
const EXE = argOf('--exe', EXE_CANDIDATES.find((p) => fs.existsSync(p)) ?? EXE_CANDIDATES[1]);
const ELECTRON = path.join(ROOT, 'apps/desktop/node_modules/electron/dist/electron.exe');
const RUNS = Number(argOf('--runs', '3'));
const KEEP = args.includes('--keep');
const PORT = Number(process.env.DEVIPILOT_BACKEND_PORT ?? 37100);
const API = `http://127.0.0.1:${PORT}/api/v1/health`;
const APP_DATA = path.join(process.env.APPDATA ?? os.homedir(), 'devpilot');
const TRACE = path.join(APP_DATA, 'startup-trace.jsonl');
const DATA_DB = path.join(APP_DATA, 'data', 'devpilot.db');

function ps(cmd) {
  return new Promise((resolve) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => { out += String(d); });
    p.on('close', () => resolve(out.trim()));
    p.on('error', () => resolve(''));
  });
}

async function portBusy() {
  try {
    const r = await fetch(API, { signal: AbortSignal.timeout(400) });
    return r.ok;
  } catch { return false; }
}

/** 结束某个进程树 + 清掉占用端口的后端（测冷启动必须真的冷） */
async function killTree(pid) {
  if (pid) await ps(`taskkill /PID ${pid} /T /F 2>$null`);
  await ps(`try { Stop-Process -Id (Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue).OwningProcess -Force } catch {}`);
  for (let i = 0; i < 60; i++) {
    if (!(await portBusy())) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** 进程树内存占用（MB）：只统计本应用（exe 路径或应用目录匹配）的进程 */
async function rssMb() {
  const needle = APP_DIR ? APP_DIR.replace(/\//g, '\\') : EXE.replace(/\//g, '\\');
  const out = await ps(
    `$n = '${needle}'; ` +
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like \"*$n*\" } | ` +
    `Measure-Object WorkingSetSize -Sum | Select-Object -ExpandProperty Sum`,
  );
  return Math.round(Number(out || 0) / 1048576);
}

/** 取本次运行（以 process.start 为界，且只保留本次启动之后写入的 mark） */
function readTrace(sinceWall) {
  try {
    const lines = fs.readFileSync(TRACE, 'utf-8').trim().split('\n');
    const marks = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const idx = marks.map((m) => m.mark).lastIndexOf('process.start');
    const run = idx >= 0 ? marks.slice(idx) : [];
    // 旧构建/未启用 trace 时文件里可能残留上一次运行的记录，用墙钟过滤掉
    return run.filter((m) => !sinceWall || (typeof m.wall === 'number' && m.wall >= sinceWall - 2000));
  } catch { return []; }
}

const pick = (marks, name) => marks.find((m) => m.mark === name)?.sinceProcessStartMs ?? null;

/** 宿主 CLI 常带 ELECTRON_RUN_AS_NODE / NODE_OPTIONS，会让 Electron 以纯 node 模式跑主进程而秒退 */
function cleanEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  return env;
}

async function oneRun(idx) {
  await killTree(null);
  const cmd = APP_DIR ? ELECTRON : EXE;
  const argv = APP_DIR ? [path.resolve(ROOT, APP_DIR)] : [];
  const t0 = Date.now();
  const proc = spawn(cmd, argv, { stdio: 'ignore', windowsHide: false, env: cleanEnv() });
  const pid = proc.pid;

  let apiAt = null;
  let winAt = null;
  const deadline = t0 + 45000;
  const pollApi = (async () => {
    while (Date.now() < deadline && apiAt === null) {
      try {
        const r = await fetch(API, { signal: AbortSignal.timeout(400) });
        if (r.ok) apiAt = Date.now() - t0;
      } catch { /* 未就绪 */ }
      if (apiAt === null) await new Promise((r) => setTimeout(r, 50));
    }
  })();
  const pollWin = (async () => {
    while (Date.now() < deadline && winAt === null) {
      const out = await ps(`$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p -and $p.MainWindowHandle -ne 0) { 'Y' }`);
      if (out.includes('Y')) winAt = Date.now() - t0;
      if (winAt === null) await new Promise((r) => setTimeout(r, 60));
    }
  })();
  await Promise.all([pollApi, pollWin]);
  await new Promise((r) => setTimeout(r, 4000)); // 等首屏数据加载完成 + trace 落盘
  const marks = readTrace(t0);
  const mem = await rssMb();
  if (!KEEP) await killTree(pid);

  const row = {
    run: idx + 1,
    firstPaintMs: pick(marks, 'renderer.firstPaint'),
    windowShownMs: winAt,
    backendReadyMs: pick(marks, 'backend.ready'),
    apiReadyMs: apiAt,
    didFinishLoadMs: pick(marks, 'window.didFinishLoad'),
    dashboardReadyMs: pick(marks, 'renderer.dashboardReady'),
    rssMb: mem,
  };
  console.log(JSON.stringify(row));
  return row;
}

async function main() {
  const cmd = APP_DIR ? ELECTRON : EXE;
  if (!fs.existsSync(cmd)) {
    console.error(`可执行文件不存在：${cmd}`);
    process.exit(1);
  }
  if (fs.existsSync(DATA_DB)) {
    console.log(`data db: ${DATA_DB} (${(fs.statSync(DATA_DB).size / 1048576).toFixed(1)} MB)`);
  }
  console.log(`target: ${cmd}${APP_DIR ? ' ' + APP_DIR : ''}`);
  const rows = [];
  for (let i = 0; i < RUNS; i++) rows.push(await oneRun(i));

  const med = (k) => {
    const v = rows.map((r) => r[k]).filter((x) => typeof x === 'number' && x > 0).sort((a, b) => a - b);
    return v.length ? Math.round(v[Math.floor(v.length / 2)]) : null;
  };
  const summary = {
    runs: rows.length,
    medianFirstPaintMs: med('firstPaintMs'),
    medianWindowShownMs: med('windowShownMs'),
    medianBackendReadyMs: med('backendReadyMs'),
    medianApiReadyMs: med('apiReadyMs'),
    medianDashboardReadyMs: med('dashboardReadyMs'),
    medianRssMb: med('rssMb'),
  };
  console.log('\n=== 中位数 ===');
  console.log(JSON.stringify(summary, null, 2));
  const out = path.join(ROOT, 'docs', `startup-bench-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify({ target: cmd, dir: APP_DIR || null, at: new Date().toISOString(), rows, summary }, null, 2));
  console.log(`report: ${out}`);
}

await main();
