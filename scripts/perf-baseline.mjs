/**
 * 性能基线实测（测试方案 §4，架构债 #6）。
 * 运行前提：后端已启动（scripts/backend-daemon.cmd）。
 * 用法：node scripts/perf-baseline.mjs
 */
const API = 'http://127.0.0.1:37100/api/v1';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

function pct(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
async function timeFetch(url, opts) {
  const t0 = performance.now();
  await fetch(url, opts);
  return performance.now() - t0;
}

async function main() {
  const report = { date: new Date().toISOString(), machine: 'Windows (target hardware: local dev machine)' };

  // 1) API 延迟：health / projects / notifications 各 100 次
  const lat = {};
  for (const [name, path] of [['health', '/health'], ['projects', '/projects'], ['notifications', '/notifications']]) {
    const arr = [];
    for (let i = 0; i < 100; i++) arr.push(await timeFetch(API + path));
    lat[name] = { avg: Math.round(arr.reduce((a, b) => a + b) / arr.length), p50: Math.round(pct(arr, 50)), p95: Math.round(pct(arr, 95)), p99: Math.round(pct(arr, 99)) };
  }
  report.apiLatencyMs = lat;

  // 2) 项目导入耗时（fixture 混合项目，幂等导入跳过 vs 首次）
  const t0 = performance.now();
  const imp = await fetch(`${API}/projects/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'folder', rootPath: 'C:/Users/administer/WorkBuddy/DevPilot/tests/fixtures/demo-project' }) }).then((r) => r.json());
  report.importProjectMs = { elapsed: Math.round(performance.now() - t0), services: imp.analysis?.services?.length ?? 0 };

  // 3) 环境检测（15 探针全跑）
  const t1 = performance.now();
  const env = await fetch(`${API}/environments`).then((r) => r.json());
  report.envDetectMs = { elapsed: Math.round(performance.now() - t1), tools: env.length };

  // 4) 冷启动：杀当前后端 → 计时 spawn node dist/main.js 到 health 200
  const killPs = spawn('powershell.exe', ['-NoProfile', '-Command', "try { Stop-Process -Id (Get-NetTCPConnection -LocalPort 37100 -State Listen)[0].OwningProcess -Force -Confirm:$false } catch {}"], { windowsHide: true });
  await new Promise((r) => killPs.on('close', r));
  await new Promise((r) => setTimeout(r, 1500));
  const child = spawn('node', ['dist/main.js'], { cwd: 'C:/Users/administer/WorkBuddy/DevPilot/apps/backend', stdio: 'ignore', windowsHide: true });
  const bootStart = performance.now();
  let bootMs = null;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const r = await fetch(`${API}/health`, { signal: AbortSignal.timeout(500) });
      if (r.ok) { bootMs = Math.round(performance.now() - bootStart); break; }
    } catch { /* 未就绪 */ }
  }
  report.coldStartMs = { elapsed: bootMs, target: '≤5000（测试方案建议值）', note: '从 spawn node 到首个 health 200，含 Nest 路由映射与 V5 迁移检查' };

  // 5) 恢复 daemon 常驻（测完把后端交回守护进程）
  const rd = spawn('cmd.exe', ['/c', 'C:\\Users\\administer\\WorkBuddy\\DevPilot\\scripts\\backend-daemon.cmd'], { stdio: 'ignore', windowsHide: true, detached: true });
  rd.unref();
  await new Promise((r) => setTimeout(r, 8000));
  try { const h = await fetch(`${API}/health`); report.daemonRestored = h.ok; } catch { report.daemonRestored = false; }

  fs.writeFileSync('C:/Users/administer/WorkBuddy/DevPilot/docs/性能基线报告.json', JSON.stringify(report, null, 2), 'utf-8');
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
